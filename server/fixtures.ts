// ---- The files a suite uploads, on disk ----
//
// A `fixtures/` directory beside `journeys/`, committed. Test data belongs with
// the test: a journey that uploads `passport.png` is not reproducible on anybody
// else's machine unless `passport.png` came with it.
//
// Only the studio and the proxy read the bytes. A node names a fixture; the
// browser never carries the contents at run time, and neither does the journey
// file.

import {readdir, readFile, writeFile, mkdir, unlink, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import type {Request, Response, Router} from 'express';
import express from 'express';
import {contentTypeFor, edgeCaseFixtures, fixtureNameFor, pngSize, type Fixture} from '../src/core/fixtures';

const DIR = 'fixtures';

/** Big enough for a realistic document, small enough not to be a denial of service. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Extensions a test fixture may have.
 *
 * Not a security boundary on its own — the proxy only ever posts these to the
 * API under test, it never executes them — but a directory that can only hold
 * documents and images is one nobody has to think about.
 */
const ALLOWED = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'pdf', 'txt', 'csv', 'json', 'bin']);

function dirFor(root: string): string {
  return path.join(root, DIR);
}

/** Names arrive from a browser upload, so they are untrusted like any other. */
export function fixturePath(root: string, name: string): string | undefined {
  const file = fixtureNameFor(name);
  const full = path.resolve(dirFor(root), file);
  return full.startsWith(path.resolve(dirFor(root)) + path.sep) ? full : undefined;
}

/** Notes for the generated ones, so the gallery can say why they exist. */
const NOTES = new Map(edgeCaseFixtures().map((f) => [f.name, f.note]));

export async function listFixtures(root: string): Promise<Fixture[]> {
  const dir = dirFor(root);
  if (!existsSync(dir)) return [];

  const out: Fixture[] = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isFile()) continue;

      const fixture: Fixture = {name, bytes: info.size, contentType: contentTypeFor(name)};
      // Only PNGs are measured, and only from the header — reading a 20MB file
      // to list a directory would make the gallery crawl.
      if (name.toLowerCase().endsWith('.png') && info.size > 0 && info.size < MAX_BYTES) {
        const head = (await readFile(full)).subarray(0, 32);
        const size = pngSize(new Uint8Array(head));
        if (size) Object.assign(fixture, size);
      }
      if (NOTES.has(name)) fixture.note = NOTES.get(name);
      out.push(fixture);
    } catch {
      // One unreadable file should not hide the gallery.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readFixture(root: string, name: string): Promise<Buffer | undefined> {
  const file = fixturePath(root, name);
  if (!file || !existsSync(file)) return undefined;
  return readFile(file);
}

export async function saveFixture(root: string, name: string, bytes: Buffer): Promise<Fixture | undefined> {
  const file = fixturePath(root, name);
  if (!file) return undefined;
  await mkdir(dirFor(root), {recursive: true});
  await writeFile(file, bytes);
  return {name: path.basename(file), bytes: bytes.length, contentType: contentTypeFor(name)};
}

/** Write the edge cases, skipping any the user has already replaced. */
export async function seedEdgeCases(root: string): Promise<string[]> {
  await mkdir(dirFor(root), {recursive: true});
  const written: string[] = [];
  for (const fixture of edgeCaseFixtures()) {
    const file = fixturePath(root, fixture.name);
    if (!file || existsSync(file)) continue;
    await writeFile(file, Buffer.from(fixture.bytes));
    written.push(fixture.name);
  }
  return written;
}

export function createFixtureRouter(root = process.cwd()): Router {
  const router = express.Router();

  router.get('/fixtures', async (_req: Request, res: Response) => {
    res.json(await listFixtures(root));
  });

  // Serving the bytes back is what makes a gallery of thumbnails possible.
  router.get('/fixtures/:name/raw', async (req: Request, res: Response) => {
    const bytes = await readFixture(root, String(req.params.name));
    if (!bytes) {
      res.status(404).end();
      return;
    }
    res.setHeader('content-type', contentTypeFor(String(req.params.name)));
    // Fixtures change under the same name while somebody iterates on them.
    res.setHeader('cache-control', 'no-store');
    res.end(bytes);
  });

  router.put(
    '/fixtures/:name',
    express.raw({type: '*/*', limit: MAX_BYTES}),
    async (req: Request, res: Response) => {
      const name = fixtureNameFor(String(req.params.name));
      const extension = name.split('.').pop()?.toLowerCase() ?? '';
      if (!ALLOWED.has(extension)) {
        res.status(400).json({
          error: `A fixture needs one of these extensions: ${[...ALLOWED].join(', ')}. Got "${extension || 'none'}".`,
        });
        return;
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const saved = await saveFixture(root, name, bytes);
      if (!saved) {
        res.status(400).json({error: 'That name cannot be used as a file.'});
        return;
      }
      res.json(saved);
    },
  );

  router.post('/fixtures/seed', async (_req: Request, res: Response) => {
    res.json({written: await seedEdgeCases(root)});
  });

  router.delete('/fixtures/:name', async (req: Request, res: Response) => {
    const file = fixturePath(root, String(req.params.name));
    if (!file || !existsSync(file)) {
      res.status(404).json({error: 'No fixture by that name.'});
      return;
    }
    await unlink(file);
    res.status(204).end();
  });

  return router;
}
