// ---- Postman collection (v2.x) -> node definitions ----
//
// Most teams already have a collection, so this is the shortest path from
// "interesting tool" to "runs against my API". Two things make the mapping
// unusually clean:
//
//   1. Postman's {{variable}} syntax is the same as ours, so a URL like
//      {{baseUrl}}/users/{{userId}} needs no rewriting at all.
//   2. Collections already express chaining — in test scripts, as
//      `pm.environment.set("userId", jsonData.id)`. That is exactly a `gives`,
//      so we transcribe it instead of asking the user to redeclare it.
//
// Script parsing is deliberately pattern-matched, not evaluated: a collection is
// untrusted input, and running its JavaScript to find out what it sets would be
// a remote-code-execution hole. Anything the patterns don't recognise is
// reported as a warning rather than guessed at.

import {inferNeeds, slugify, uniqueType} from './infer';
import type {Field, ImportResult, Method, NodeDef, Produces, RequestSpec} from './types';

type Any = Record<string, any>;

const METHODS = new Set<Method>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Variables commonly used for the host, which become the environment baseUrl. */
const BASE_URL_KEYS = new Set(['baseurl', 'base_url', 'url', 'host', 'apiurl', 'api_url', 'endpoint']);

// ---- test scripts ---------------------------------------------------------

/** `const jsonData = pm.response.json()` — plus the names people use anyway. */
function jsonAliases(script: string): Set<string> {
  const aliases = new Set(['jsonData', 'json', 'responseJson', 'body', 'data', 'res', 'response']);
  for (const m of script.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*pm\.response\.json\(\)/g)) {
    aliases.add(m[1]);
  }
  return aliases;
}

/** Turn a JS expression into a response path, or undefined if we can't tell. */
function expressionToPath(expr: string, aliases: Set<string>): string | undefined {
  const clean = expr.trim().replace(/;$/, '');

  // pm.response.json().a.b   /   pm.response.json()
  const direct = clean.match(/^pm\.response\.json\(\)\s*(?:\.(.+))?$/);
  if (direct) return direct[1] ? `body.${direct[1]}` : 'body';

  // pm.response.headers.get("location")
  const header = clean.match(/^pm\.response\.headers\.get\(\s*["'`]([^"'`]+)["'`]\s*\)$/);
  if (header) return `headers.${header[1].toLowerCase()}`;

  // pm.response.code
  if (/^pm\.response\.code$/.test(clean)) return 'status';

  // jsonData.a.b  (or any alias assigned from pm.response.json())
  const alias = clean.match(/^(\w+)\s*(?:\.(.+))?$/);
  if (alias && aliases.has(alias[1])) return alias[2] ? `body.${alias[2]}` : 'body';

  return undefined;
}

/**
 * Read the argument list of a call, given the index of its opening paren.
 *
 * A regex cannot do this: the arguments themselves contain parens
 * (`pm.response.json().data.id`), and a non-greedy match stops at the first
 * one, silently truncating the expression it was meant to capture.
 */
function readCallArgs(text: string, open: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return undefined;   // unbalanced — treat as unreadable rather than guessing
}

/** Split an argument list on its first top-level comma. */
function splitFirstArg(args: string): [string, string] | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === quote && args[i - 1] !== '\\') quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return [args.slice(0, i), args.slice(i + 1)];
  }
  return undefined;
}

interface ScriptFindings {
  gives: Produces[];
  status?: number;
  warnings: string[];
}

/**
 * Read the two patterns that carry real meaning: the expected status, and the
 * variables the request hands to later requests.
 */
export function readTestScript(script: string, requestName: string): ScriptFindings {
  const out: ScriptFindings = {gives: [], warnings: []};
  if (!script.trim()) return out;

  const status =
    script.match(/to\.have\.status\(\s*(\d{3})\s*\)/) ??
    script.match(/pm\.response\.code\s*(?:===?|to\.eql\(|to\.be\.)\s*(\d{3})/);
  if (status) out.status = Number(status[1]);

  const aliases = jsonAliases(script);
  // Strip line comments so a trailing `// note` can't be read as an expression.
  const source = script.replace(/\/\/[^\n]*/g, '');
  const setter = /pm\.(?:environment|collectionVariables|globals|variables)\.set\s*(?=\()/g;

  for (const m of source.matchAll(setter)) {
    const args = readCallArgs(source, m.index + m[0].length);
    if (args === undefined) continue;
    const split = splitFirstArg(args);
    if (!split) continue;

    const keyMatch = split[0].trim().match(/^["'`]([\w.$-]+)["'`]$/);
    if (!keyMatch) continue;                       // a computed key — not ours to guess
    const key = keyMatch[1];
    const expr = split[1].trim();

    const from = expressionToPath(expr, aliases);
    if (from) {
      out.gives.push({key, from});
    } else {
      out.warnings.push(
        `${requestName}: sets "${key}" from an expression this importer can't read (${expr.slice(0, 48)}). Set its source by hand.`,
      );
    }
  }
  return out;
}

// ---- url ------------------------------------------------------------------

interface ParsedUrl {
  path: string;
  query: Record<string, string>;
  fields: Field[];
  defaults: Record<string, unknown>;
  host?: string;
}

/**
 * Build a relative path plus query from Postman's URL shape.
 *
 * The host is dropped on purpose: environments own the base URL here, so a
 * collection pinned to production can be pointed at staging by switching the
 * environment rather than by editing every request.
 */
function parseUrl(url: any): ParsedUrl {
  const fields: Field[] = [];
  const defaults: Record<string, unknown> = {};
  const query: Record<string, string> = {};

  if (typeof url === 'string') {
    const [raw, search] = url.split('?');
    // Strip scheme+host, but keep a leading {{var}} out of the path.
    const stripped = raw.replace(/^\w+:\/\/[^/]+/, '').replace(/^\{\{[^}]+\}\}/, '');
    if (search) {
      for (const pair of search.split('&')) {
        const [k, v = ''] = pair.split('=');
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v);
      }
    }
    return {path: stripped || '/', query, fields, defaults};
  }

  const segments: string[] = Array.isArray(url?.path)
    ? url.path.map((s: any) => (typeof s === 'string' ? s : String(s?.value ?? '')))
    : [];

  const path =
    '/' +
    segments
      .map((seg) => {
        // `:petId` is Postman's path variable; make it a field that defaults to
        // the matching context value so it chains like an OpenAPI path param.
        if (seg.startsWith(':')) {
          const name = seg.slice(1);
          if (!fields.some((f) => f.key === name)) {
            fields.push({key: name, label: name, kind: 'text', required: true});
            defaults[name] = `{{vars.${name}}}`;
          }
          return `{{fields.${name}}}`;
        }
        return seg;   // `{{var}}` segments already use our syntax
      })
      .filter(Boolean)
      .join('/');

  for (const q of url?.query ?? []) {
    if (!q?.key || q.disabled) continue;
    query[q.key] = String(q.value ?? '');
  }

  // Path variables can also be declared out of line.
  for (const v of url?.variable ?? []) {
    if (!v?.key) continue;
    if (!fields.some((f) => f.key === v.key)) {
      fields.push({key: v.key, label: v.key, kind: 'text', required: true});
      defaults[v.key] = v.value ? String(v.value) : `{{vars.${v.key}}}`;
    }
  }

  const hostParts: string[] = Array.isArray(url?.host) ? url.host : [];
  return {path: path || '/', query, fields, defaults, host: hostParts.join('.') || undefined};
}

// ---- body -----------------------------------------------------------------

function parseBody(body: any, name: string, warnings: string[]): unknown {
  if (!body || !body.mode) return undefined;

  switch (body.mode) {
    case 'raw': {
      const raw = String(body.raw ?? '');
      if (!raw.trim()) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        // Bodies full of {{variables}} often aren't valid JSON until they are
        // resolved, so keep the text and let templating deal with it.
        return raw;
      }
    }
    case 'urlencoded':
    case 'formdata': {
      const out: Record<string, unknown> = {};
      for (const f of body[body.mode] ?? []) {
        if (!f?.key || f.disabled) continue;
        if (f.type === 'file') {
          warnings.push(`${name}: file upload fields aren't imported — attach the file by hand.`);
          continue;
        }
        out[f.key] = f.value ?? '';
      }
      warnings.push(`${name}: body was ${body.mode}; imported as JSON. Adjust the content type if the API needs the original encoding.`);
      return out;
    }
    default:
      warnings.push(`${name}: body mode "${body.mode}" isn't supported.`);
      return undefined;
  }
}

// ---- walk -----------------------------------------------------------------

interface WalkState {
  nodes: NodeDef[];
  warnings: string[];
  used: Set<string>;
  slug: string;
  hosts: Set<string>;
  authNoted: boolean;
}

function itemToNode(item: Any, group: string, state: WalkState): void {
  const req = item.request;
  if (!req) return;

  const name: string = item.name || 'Request';
  const method = String(req.method ?? 'GET').toUpperCase() as Method;
  if (!METHODS.has(method)) {
    state.warnings.push(`${name}: unsupported method "${req.method}".`);
    return;
  }

  const url = parseUrl(req.url);
  if (url.host && !url.host.includes('{{')) state.hosts.add(url.host);

  const fields: Field[] = [...url.fields];
  const defaults: Record<string, unknown> = {...url.defaults};

  const headers: Record<string, string> = {};
  for (const h of req.header ?? []) {
    if (!h?.key || h.disabled) continue;
    headers[h.key] = String(h.value ?? '');
  }

  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(url.query)) {
    fields.push({key: k, label: k, kind: 'text'});
    defaults[k] = v;
    query[k] = `{{fields.${k}}}`;
  }

  const body = parseBody(req.body, name, state.warnings);
  let bodyRef: unknown;
  if (body !== undefined) {
    fields.push({key: 'body', label: 'Request body', kind: 'json'});
    defaults.body = body;
    bodyRef = '{{fields.body}}';
  }

  // The credential itself is never imported — a collection often has a live
  // token pasted into it, and copying that into a saved node would put it in
  // version control. The scheme is referenced by name and configured server-side.
  let auth: string | undefined;
  const authType = req.auth?.type;
  if (authType && authType !== 'noauth') {
    auth = String(authType);
    if (!state.authNoted) {
      state.warnings.push(
        `Requests use "${authType}" auth. The credential was not imported — add it to your config under auth.${authType}.`,
      );
      state.authNoted = true;
    }
  }

  const script = (item.event ?? [])
    .filter((e: Any) => e?.listen === 'test')
    .map((e: Any) => (Array.isArray(e.script?.exec) ? e.script.exec.join('\n') : String(e.script?.exec ?? '')))
    .join('\n');
  const findings = readTestScript(script, name);
  state.warnings.push(...findings.warnings);

  const request: RequestSpec = {
    method,
    path: url.path,
    ...(Object.keys(query).length ? {query} : {}),
    ...(Object.keys(headers).length ? {headers} : {}),
    ...(bodyRef !== undefined ? {body: bodyRef} : {}),
    ...(auth ? {auth} : {}),
  };

  state.nodes.push({
    type: uniqueType(`postman.${state.slug}.${slugify(name) || 'request'}`, state.used),
    label: name,
    summary: req.description ? String(req.description).split('\n')[0] : undefined,
    group: group || 'default',
    fields,
    defaults,
    request,
    needs: inferNeeds(request, defaults),
    gives: findings.gives,
    assertions: [{op: 'status', expected: findings.status ?? 200}],
    destructive: method === 'DELETE',
  });
}

function walk(items: any[], group: string, state: WalkState): void {
  for (const item of items ?? []) {
    if (Array.isArray(item?.item)) {
      // A folder. Its name becomes the palette group, nested folders joined.
      walk(item.item, group ? `${group} / ${item.name}` : String(item.name ?? ''), state);
    } else {
      itemToNode(item, group, state);
    }
  }
}

export function importPostman(text: string, filename?: string): ImportResult {
  const empty: ImportResult = {ok: false, slug: '', title: '', servers: [], nodes: [], warnings: []};

  let doc: Any;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {...empty, error: `Could not parse the collection: ${(err as Error).message}`};
  }

  const schema = String(doc?.info?.schema ?? '');
  if (!doc?.info || !Array.isArray(doc.item)) {
    if (Array.isArray(doc?.requests) || doc?.order) {
      return {...empty, error: 'This is a Postman v1 collection. Re-export it as v2.1.'};
    }
    return {...empty, error: 'No "info" and "item" — is this a Postman collection?'};
  }
  if (schema && !/collection\/v2/.test(schema)) {
    return {...empty, error: `Unsupported collection schema (${schema}). Export as v2.1.`};
  }

  const title = String(doc.info.name ?? filename ?? 'Collection');
  const state: WalkState = {
    nodes: [],
    warnings: [],
    used: new Set(),
    slug: slugify(title) || 'collection',
    hosts: new Set(),
    authNoted: false,
  };

  walk(doc.item, '', state);

  if (!state.nodes.length) return {...empty, slug: state.slug, title, error: 'The collection has no requests.'};

  // Collection variables that look like a host become environment suggestions;
  // the rest are seed values a run can start from.
  const servers: string[] = [];
  for (const v of doc.variable ?? []) {
    if (!v?.key) continue;
    if (BASE_URL_KEYS.has(String(v.key).toLowerCase()) && v.value) servers.push(String(v.value));
  }
  for (const host of state.hosts) if (!servers.length) servers.push(`https://${host}`);

  return {
    ok: true,
    slug: state.slug,
    title,
    version: doc.info.version ? String(doc.info.version) : undefined,
    servers,
    nodes: state.nodes,
    warnings: state.warnings,
    format: 'postman',
  };
}
