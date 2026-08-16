// ---- The request proxy ----
//
// Every call a journey makes goes through here rather than out of the browser,
// for two reasons that both matter:
//
//   1. Credentials. The canvas holds `{{secrets.apiKey}}`; this side holds the
//      value and substitutes it on the way out. A secret is never in a bundle,
//      a devtools network tab, or a saved journey file.
//   2. CORS. The APIs worth testing rarely allow a browser origin, and asking
//      users to disable web security to try a tool is not a real answer.

import type {Request, Response, Router} from 'express';
import express from 'express';
import {loadConfig, publicConfig, type ServerConfig} from './config';
import {getToken} from './auth';
import type {AuthScheme, ResolvedRequest} from '../src/core/types';

/** Substitute `{{secrets.name}}` anywhere in a structure. */
function applySecrets<T>(value: T, secrets: Record<string, string>): T {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*secrets\.([A-Za-z0-9_-]+)\s*\}\}/g, (match, name: string) =>
      secrets[name] !== undefined ? secrets[name] : match,
    ) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => applySecrets(v, secrets)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = applySecrets(v, secrets);
    return out as T;
  }
  return value;
}

async function applyAuth(
  name: string | undefined,
  scheme: AuthScheme | undefined,
  headers: Record<string, string>,
  url: URL,
  forceRefresh = false,
): Promise<void> {
  if (!scheme) return;
  switch (scheme.type) {
    case 'bearer':
      headers.authorization = `Bearer ${scheme.token}`;
      break;
    case 'header':
      headers[scheme.name.toLowerCase()] = scheme.value;
      break;
    case 'query':
      url.searchParams.set(scheme.name, scheme.value);
      break;
    case 'basic':
      headers.authorization = `Basic ${Buffer.from(`${scheme.username}:${scheme.password}`).toString('base64')}`;
      break;
    case 'oauth2': {
      const token = await getToken(name ?? 'oauth2', scheme, forceRefresh);
      headers.authorization = `${token.tokenType || 'Bearer'} ${token.accessToken}`;
      break;
    }
  }
}

function joinUrl(baseUrl: string, path: string): URL {
  if (/^https?:\/\//i.test(path)) return new URL(path);
  return new URL(path.startsWith('/') ? path.slice(1) : path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
}

export async function sendRequest(
  request: ResolvedRequest,
  envName: string,
  config: ServerConfig,
): Promise<{status: number; headers: Record<string, string>; body: unknown; durationMs: number}> {
  const environment = config.environments.find((e) => e.name === envName) ?? config.environments[0];
  if (!environment) throw new Error('No environments are configured.');

  const resolved = applySecrets(request, config.secrets);
  const url = joinUrl(environment.baseUrl, resolved.url);

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    ...Object.fromEntries(
      Object.entries(applySecrets(environment.headers ?? {}, config.secrets)).map(([k, v]) => [k.toLowerCase(), String(v)]),
    ),
    ...Object.fromEntries(Object.entries(resolved.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
  };

  const scheme = resolved.auth ? config.auth[resolved.auth] : undefined;
  await applyAuth(resolved.auth, scheme, headers, url);

  let payload: string | undefined;
  if (resolved.body !== undefined && resolved.body !== null && resolved.method !== 'GET' && resolved.method !== 'HEAD') {
    if (typeof resolved.body === 'string') {
      payload = resolved.body;
      headers['content-type'] ??= 'text/plain';
    } else {
      payload = JSON.stringify(resolved.body);
      headers['content-type'] ??= 'application/json';
    }
  }

  const started = Date.now();
  let res = await fetch(url, {method: resolved.method, headers, body: payload});

  // A cached token that the API rejects means it was revoked or rotated early.
  // One forced refresh recovers from that; a loop would turn a bad credential
  // into a denial-of-service against your own auth server.
  if (res.status === 401 && scheme?.type === 'oauth2') {
    await applyAuth(resolved.auth, scheme, headers, url, true);
    res = await fetch(url, {method: resolved.method, headers, body: payload});
  }

  const text = await res.text();
  const durationMs = Date.now() - started;

  // Parse when it looks like JSON, but keep the text when it isn't — an HTML
  // error page is far more useful than "unexpected token < in JSON".
  let body: unknown = text;
  const contentType = res.headers.get('content-type') ?? '';
  if (text && (contentType.includes('json') || /^[[{]/.test(text.trim()))) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    status: res.status,
    headers: Object.fromEntries([...res.headers.entries()]),
    body,
    durationMs,
  };
}

export function createApiRouter(root = process.cwd()): Router {
  const router = express.Router();
  router.use(express.json({limit: '12mb'}));

  router.get('/config', (_req: Request, res: Response) => {
    res.json(publicConfig(loadConfig(root)));
  });

  router.post('/send', async (req: Request, res: Response) => {
    const {request, env} = req.body as {request?: ResolvedRequest; env?: string};
    if (!request?.url || !request.method) {
      res.status(400).json({error: 'A request with a method and url is required.'});
      return;
    }
    try {
      res.json(await sendRequest(request, env ?? '', loadConfig(root)));
    } catch (err) {
      // Network-level failures are the journey's problem to display, not a 500
      // from the tool — return them in the shape the engine already handles.
      res.status(502).json({error: err instanceof Error ? err.message : 'request failed'});
    }
  });

  return router;
}
