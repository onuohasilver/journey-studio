// ---- {{template}} resolution and response reading ----
//
// Values move between steps as text: a path segment, a header, a field in a JSON
// body. This is the one place that turns `{{vars.userId}}` into a real value, so
// every rule about what a journey can reference lives here and nowhere else.
//
// Supported references:
//   {{vars.userId}}            a value an earlier node produced
//   {{nodes.n1.body.data.id}}  straight into an earlier node's response
//   {{env}}                    the environment name
//   {{secrets.apiKey}}         left untouched here — the proxy substitutes it
//   {{$uuid}} {{$now}} {{$timestamp}} {{$randomInt}}   generated per resolution

import type {HttpResponse, RunContext} from './types';

/** `{{ anything }}` — non-greedy so two references on one line both resolve. */
const REF = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Read a dotted path out of a value. Array indexes are numeric segments:
 * `body.items.0.id`. Returns undefined for any miss rather than throwing —
 * a missing value is normal (the assertion layer decides whether it matters).
 */
export function readPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let cur: unknown = source;
  for (const raw of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const seg = raw.trim();
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) ? cur[i] : undefined;
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Read out of a response with the shorthand paths a user actually types. */
export function readResponse(res: HttpResponse, path: string): unknown {
  if (path === 'status') return res.status;
  if (path === 'durationMs') return res.durationMs;
  if (path.startsWith('headers.')) {
    // Header names are case-insensitive; the map is normalised to lower case.
    return res.headers[path.slice('headers.'.length).toLowerCase()];
  }
  if (path === 'body') return res.body;
  if (path.startsWith('body.')) return readPath(res.body, path.slice('body.'.length));
  // Bare paths are the common case and mean "into the body".
  return readPath(res.body, path);
}

function generated(name: string): string | undefined {
  switch (name) {
    case '$uuid':
      return crypto.randomUUID();
    case '$now':
      return new Date().toISOString();
    case '$timestamp':
      return String(Date.now());
    case '$randomInt':
      return String(Math.floor(Math.random() * 1_000_000));
    default:
      return undefined;
  }
}

/** Resolve one reference. `undefined` means "leave the placeholder alone". */
function lookup(ref: string, ctx: RunContext): unknown {
  const gen = generated(ref);
  if (gen !== undefined) return gen;

  if (ref === 'env') return ctx.env;
  if (ref === 'runId') return ctx.runId;

  if (ref.startsWith('vars.')) return readPath(ctx.vars, ref.slice('vars.'.length));

  if (ref.startsWith('nodes.')) {
    const rest = ref.slice('nodes.'.length);
    const dot = rest.indexOf('.');
    if (dot < 0) return undefined;
    const res = ctx.responses[rest.slice(0, dot)];
    return res ? readResponse(res, rest.slice(dot + 1)) : undefined;
  }

  // Secrets are resolved by the proxy, which is the only side that holds them.
  // Returning undefined here leaves `{{secrets.x}}` intact for it to handle.
  if (ref.startsWith('secrets.')) return undefined;

  // A bare name is a var — `{{userId}}` reads better than `{{vars.userId}}`.
  return readPath(ctx.vars, ref);
}

/**
 * Resolve every reference in a string.
 *
 * A lone reference (`"{{vars.count}}"`) returns the *typed* value, so a number
 * stays a number in a JSON body. Anything interpolated into surrounding text is
 * stringified, because that is the only sensible thing to put in a URL.
 */
export function resolveString(input: string, ctx: RunContext): unknown {
  const whole = input.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (whole) {
    const value = lookup(whole[1], ctx);
    return value === undefined ? input : value;
  }
  return input.replace(REF, (match, ref: string) => {
    const value = lookup(ref.trim(), ctx);
    if (value === undefined) return match;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/** Resolve templates anywhere in a structure, preserving its shape. */
export function resolve<T>(input: T, ctx: RunContext): T {
  if (typeof input === 'string') return resolveString(input, ctx) as T;
  if (Array.isArray(input)) return input.map((v) => resolve(v, ctx)) as T;
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      // Keys are templated too, so a header name can come from context.
      out[String(resolveString(k, ctx))] = resolve(v, ctx);
    }
    return out as T;
  }
  return input;
}

/** Every reference a value mentions, for dependency checking before a run. */
export function referencesIn(input: unknown, found = new Set<string>()): Set<string> {
  if (typeof input === 'string') {
    for (const m of input.matchAll(REF)) found.add(m[1].trim());
  } else if (Array.isArray(input)) {
    input.forEach((v) => referencesIn(v, found));
  } else if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      referencesIn(k, found);
      referencesIn(v, found);
    }
  }
  return found;
}
