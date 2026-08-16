// ---- The webhook inbox, and the mocks that stand in for it ----
//
// Anything sent to `/api/hooks/<path>` is recorded and answered 200. That is the
// whole receiving side: providers are not fussy, and a callback endpoint that
// argues with its caller is a callback endpoint that gets retried forever.
//
// The URL has to be reachable from wherever the provider runs, which for local
// work means a tunnel. The inbox reports the base URL it believes it is on so
// the UI can show something copy-pasteable rather than making people assemble it.

import {readdir, readFile, writeFile, mkdir, unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import type {Request, Response, Router} from 'express';
import express from 'express';
import {MOCK_HEADER} from '../src/core/engine';
import {HookInbox, mockFileNameFor, type HookMatch, type HookMock} from '../src/core/inbox';

const MOCK_DIR = 'mocks';

/** One inbox per process, shared by the HTTP routes and the CLI runner. */
export const inbox = new HookInbox();

function dirFor(root: string): string {
  return path.join(root, MOCK_DIR);
}

/** Mock names arrive over HTTP, so they are untrusted like any other file name. */
function safeMockPath(root: string, name: string): string | undefined {
  const file = mockFileNameFor(name.replace(/\.hook\.json$/, ''));
  const full = path.resolve(dirFor(root), file);
  return full.startsWith(path.resolve(dirFor(root)) + path.sep) ? full : undefined;
}

export async function listMocks(root: string): Promise<HookMock[]> {
  const dir = dirFor(root);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.hook.json'));

  const out: HookMock[] = [];
  for (const file of files) {
    try {
      out.push(JSON.parse(await readFile(path.join(dir, file), 'utf8')) as HookMock);
    } catch {
      // One unreadable mock should not hide the rest.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Mocks by name, in the shape the engine wants. */
export async function loadMocks(root: string): Promise<Record<string, HookMock>> {
  return Object.fromEntries((await listMocks(root)).map((mock) => [mock.name, mock]));
}

export async function saveMock(root: string, mock: HookMock): Promise<string | undefined> {
  const file = safeMockPath(root, mock.name);
  if (!file) return undefined;
  await mkdir(dirFor(root), {recursive: true});
  await writeFile(file, `${JSON.stringify(mock, null, 2)}\n`, 'utf8');
  return path.basename(file);
}

/**
 * The base URL a provider should call.
 *
 * Behind a tunnel the request's own Host header is the only thing that knows the
 * public name, so it is preferred over anything configured — a copied URL that
 * points at localhost is worse than no URL at all.
 */
function publicBase(req: Request): string {
  const configured = process.env.PUBLIC_URL;
  if (configured) return configured.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0];
  return `${proto}://${req.headers.host}`;
}

export function createInboxRouter(root = process.cwd()): Router {
  const router = express.Router();

  // Deliveries first, and deliberately before any JSON body parser with a
  // narrow content type: providers send JSON, form encoding, and occasionally
  // something they made up. Anything parseable becomes an object; the rest is
  // kept as text rather than dropped.
  router.all(
    /^\/hooks(?:\/(.*))?$/,
    express.text({type: '*/*', limit: '2mb'}),
    (req: Request, res: Response) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* not JSON; the text is the payload */
      }

      const hook = inbox.receive({
        method: req.method,
        path: String((req.params as Record<string, string>)[0] ?? '').replace(/^\/+|\/+$/g, ''),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
        ),
        query: Object.fromEntries(
          Object.entries(req.query).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v ?? '')]),
        ),
        body,
      });

      // Answer 200 quickly and unconditionally. A provider whose callback gets a
      // 4xx will retry it for hours, which is a mess nobody asked this tool for.
      res.status(200).json({received: hook.id});
    },
  );

  router.use(express.json({limit: '2mb'}));

  router.get('/inbox', (req: Request, res: Response) => {
    res.json({
      hooks: inbox.list(),
      // What to paste into the provider's dashboard.
      url: `${publicBase(req)}/api/hooks/`,
    });
  });

  router.post('/inbox/claim', (req: Request, res: Response) => {
    const {match, since, by} = req.body as {match: HookMatch; since: string; by: string};
    const hook = inbox.claim(match ?? {}, {since: since ?? '', by: by ?? 'unknown'});
    if (!hook) {
      res.status(404).json({unmatched: inbox.describeUnmatched(since ?? '')});
      return;
    }
    res.json(hook);
  });

  router.delete('/inbox', (_req: Request, res: Response) => {
    inbox.clear();
    res.status(204).end();
  });

  router.get('/mocks', async (_req: Request, res: Response) => {
    res.json(await listMocks(root));
  });

  router.put('/mocks/:name', async (req: Request, res: Response) => {
    const mock = {...(req.body as HookMock), name: String(req.params.name)};
    if (!mock.path && mock.path !== '') {
      res.status(400).json({error: 'A mock needs the inbox path it stands in for.'});
      return;
    }
    const file = await saveMock(root, mock);
    if (!file) {
      res.status(400).json({error: 'That name cannot be used as a file.'});
      return;
    }
    res.json({ok: true, file});
  });

  router.delete('/mocks/:name', async (req: Request, res: Response) => {
    const file = safeMockPath(root, String(req.params.name));
    if (!file || !existsSync(file)) {
      res.status(404).json({error: 'No mock by that name.'});
      return;
    }
    await unlink(file);
    res.status(204).end();
  });

  /**
   * Deliver a saved mock into this inbox now.
   *
   * Straight into the store rather than back out over HTTP: a loopback request
   * would need the public URL to resolve from inside the process, which is
   * exactly the thing that does not work behind a tunnel.
   */
  router.post('/mocks/:name/fire', async (req: Request, res: Response) => {
    const mocks = await loadMocks(root);
    const mock = mocks[String(req.params.name)];
    if (!mock) {
      res.status(404).json({error: 'No mock by that name.'});
      return;
    }
    // The caller may pass values to substitute, so a mock can carry the
    // reference the run generated instead of a hard-coded one.
    const overrides = (req.body as {body?: unknown})?.body;
    const hook = inbox.receive({
      method: mock.method ?? 'POST',
      path: mock.path,
      headers: {...(mock.headers ?? {}), [MOCK_HEADER]: mock.name},
      query: {},
      body: overrides ?? mock.body,
    });
    res.json({ok: true, hook});
  });

  return router;
}
