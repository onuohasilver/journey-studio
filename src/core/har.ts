// ---- Turning recorded browser traffic into a journey ----
//
// The other importers need a document. Plenty of the APIs worth testing have
// none — the internal one nobody wrote down, the third party whose spec is out
// of date, the flow that only exists as four calls the front end happens to
// make in order. For those, the recording *is* the specification.
//
// So: click the flow in the app, File → Export HAR from the network panel, drop
// it here. Chrome, Firefox, Safari and Charles all write the same format.
//
// The part that makes this more than a replay tool is the chaining. A HAR is a
// flat list of requests, and a flat list of requests is not a journey — it is a
// recording that breaks the moment an id changes. So the importer looks for
// values that a response produced and a later request used, and wires those as
// `gives` and `{{vars.x}}`. That turns a recording into something that still
// works next week, against a different account, on a different environment.

import {inferNeeds, slugify, uniqueType} from './infer';
import type {ImportResult, Method, NodeDef, Produces} from './types';

interface HarHeader {
  name: string;
  value: string;
}

interface HarEntry {
  startedDateTime?: string;
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    queryString?: HarHeader[];
    postData?: {mimeType?: string; text?: string};
  };
  response?: {
    status?: number;
    content?: {mimeType?: string; text?: string};
  };
}

/**
 * Headers that describe the recording session rather than the request.
 *
 * Credentials are dropped for the same reason the Postman importer drops them:
 * a recording routinely carries a live session cookie, and importing it would
 * bake one person's login into a file meant to be committed.
 *
 * With one exception, and it is the useful one: if the value was *produced by an
 * earlier step in the same recording*, it is replaced by a reference to that
 * step rather than dropped. `Bearer {{vars.token}}` stores no secret and makes
 * the journey self-contained — it logs in and uses what it got.
 */
const DROP_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'user-agent',
  'referer',
  'origin',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'upgrade-insecure-requests',
  'pragma',
  'cache-control',
]);

/** The subset of dropped headers worth keeping once templated. */
const SECRET_HEADERS = new Set(['authorization', 'cookie']);

/** Anything that is plainly the page rather than the API. */
const ASSET = /\.(?:js|mjs|css|png|jpe?g|gif|svg|woff2?|ttf|eot|ico|map|webp|avif|mp4|webm)(?:\?|$)/i;
const ANALYTICS =
  /(?:google-analytics|googletagmanager|doubleclick|segment\.(?:io|com)|mixpanel|amplitude|sentry\.io|hotjar|intercom|fullstory|datadoghq|newrelic|facebook\.com\/tr)/i;

function isApi(url: string, mimeType: string | undefined): boolean {
  if (ASSET.test(url)) return false;
  if (ANALYTICS.test(url)) return false;
  // A JSON response is the strongest signal; otherwise fall back to the path
  // looking like an API rather than a page.
  if (mimeType && /json/i.test(mimeType)) return true;
  return /\/(?:api|v\d+|graphql|rest)\//i.test(url) || !/\.[a-z]{2,4}(?:\?|$)/i.test(url);
}

function parseJson(text: string | undefined): unknown {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every leaf in a body, as path → value. Used for both ends of the linking. */
function leaves(value: unknown, prefix = '', out: Map<string, string> = new Map(), depth = 0): Map<string, string> {
  if (depth > 6 || out.size > 400) return out;
  if (value === null || value === undefined) return out;

  if (Array.isArray(value)) {
    // Only the first few elements: a 500-row list contributes nothing a handful
    // of rows does not, and would swamp the matching.
    value.slice(0, 5).forEach((item, i) => leaves(item, `${prefix}.${i}`, out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      leaves(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
    return out;
  }

  const text = String(value);
  if (looksLikeAnId(text)) out.set(prefix, text);
  return out;
}

/**
 * Whether a value is the kind of thing that gets passed between calls.
 *
 * Length alone is not enough. `"Bearer"` is six characters and came from the
 * response, so a length-only rule chains it — producing a journey whose auth
 * header reads `{{vars.tokentype}} {{vars.accesstoken}}`. Correct, and nonsense
 * to read.
 *
 * Identifiers carry entropy: a digit, a separator, or real length. Words do not.
 * That rejects "Bearer", "settled" and "active" while keeping "ord_77c1de",
 * "424242" and any token or UUID.
 */
function looksLikeAnId(text: string): boolean {
  if (text.length < 6 || text.length > 200) return false;
  return /\d/.test(text) || text.length >= 12 || /[_\-@:/]/.test(text);
}

/** A readable variable name for a value found at `body.data.orderId`. */
function nameFor(path: string, used: Set<string>): string {
  const last = path.split('.').filter((p) => !/^\d+$/.test(p)).pop() ?? 'value';
  const base = last.replace(/[^A-Za-z0-9]/g, '') || 'value';
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

export interface HarLink {
  /** Index of the entry whose response produced the value. */
  from: number;
  /** Where in that response, e.g. `body.data.id`. */
  at: string;
  /** The context key it becomes. */
  key: string;
  /** The literal value observed, so later requests can be rewritten. */
  value: string;
}

/**
 * Values that one response produced and a later request used.
 *
 * This is the whole difference between a replay and a test. Matching is on the
 * literal text: if the recording shows `/orders/ord_8fd2` right after a response
 * containing `"id": "ord_8fd2"`, that is a link, and no heuristic about naming
 * is needed to see it.
 */
export function inferLinks(entries: HarEntry[]): HarLink[] {
  const links: HarLink[] = [];
  const used = new Set<string>();
  const claimed = new Set<string>();

  entries.forEach((entry, i) => {
    const body = parseJson(entry.response?.content?.text);
    if (body === undefined) return;

    for (const [at, value] of leaves(body)) {
      if (claimed.has(value)) continue;

      // Used by any *later* request? Order matters: a value cannot come from a
      // response that had not arrived yet.
      const usedLater = entries.slice(i + 1).some((later) => {
        const url = later.request?.url ?? '';
        const payload = later.request?.postData?.text ?? '';
        // Headers count, and matter most: the token a login returns is the
        // single most important thing a recording can chain, and it travels in
        // Authorization rather than in the URL.
        const inHeader = (later.request?.headers ?? []).some((h) => h.value?.includes(value));
        return url.includes(value) || payload.includes(value) || inHeader;
      });
      if (!usedLater) continue;

      claimed.add(value);
      links.push({from: i, at: `body.${at}`, key: nameFor(at, used), value});
    }
  });

  return links;
}

/** Replace observed values with the template that produces them. */
function templated(text: string, links: HarLink[], before: number): string {
  let out = text;
  for (const link of links) {
    if (link.from >= before) continue;
    out = out.split(link.value).join(`{{vars.${link.key}}}`);
  }
  return out;
}

export interface HarOptions {
  /** Keep requests to assets and analytics. Off by default, and rightly so. */
  includeNoise?: boolean;
  /** Only keep entries whose URL contains this. */
  only?: string;
}

export function importHar(text: string, filename?: string, options: HarOptions = {}): ImportResult {
  const title = filename?.replace(/\.har$/i, '') ?? 'Recorded traffic';
  const slug = slugify(title) || 'recording';
  const warnings: string[] = [];

  let doc: {log?: {entries?: HarEntry[]}};
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {ok: false, slug, title, servers: [], nodes: [], warnings, error: `Not valid JSON: ${(err as Error).message}`};
  }

  const all = doc?.log?.entries;
  if (!Array.isArray(all)) {
    return {ok: false, slug, title, servers: [], nodes: [], warnings, error: 'This file has no log.entries — is it a HAR?'};
  }

  const kept = all.filter((entry) => {
    const url = entry.request?.url ?? '';
    if (!url) return false;
    if (options.only && !url.includes(options.only)) return false;
    if (options.includeNoise) return true;
    return isApi(url, entry.response?.content?.mimeType);
  });

  const dropped = all.length - kept.length;
  if (dropped > 0) {
    warnings.push(`Left out ${dropped} request${dropped === 1 ? '' : 's'} that looked like assets, analytics or page loads.`);
  }
  if (!kept.length) {
    return {
      ok: false,
      slug,
      title,
      servers: [],
      nodes: [],
      warnings,
      error: 'Nothing here looked like an API call. Filter the network panel to Fetch/XHR and export again.',
    };
  }

  const links = inferLinks(kept);
  const servers = [...new Set(kept.map((e) => {
    try {
      return new URL(e.request!.url!).origin;
    } catch {
      return '';
    }
  }).filter(Boolean))];

  const usedTypes = new Set<string>();
  const nodes: NodeDef[] = kept.map((entry, i) => {
    const request = entry.request!;
    const url = new URL(request.url!);
    const method = (request.method ?? 'GET').toUpperCase() as Method;

    // Paths and bodies get the templates; query values too.
    const path = templated(url.pathname, links, i);
    const query: Record<string, string> = {};
    for (const {name, value} of request.queryString ?? []) query[name] = templated(value, links, i);

    const headers: Record<string, string> = {};
    for (const {name, value} of request.headers ?? []) {
      const lower = name.toLowerCase();
      if (lower.startsWith(':')) continue;

      const withTemplates = templated(value, links, i);
      if (DROP_HEADERS.has(lower)) {
        // Kept only when the literal secret has been replaced by a reference to
        // the step that produced it. A hard-coded key still goes.
        if (withTemplates !== value && SECRET_HEADERS.has(lower)) headers[lower] = withTemplates;
        continue;
      }
      headers[lower] = withTemplates;
    }

    const sentJson = parseJson(request.postData?.text);
    const body =
      sentJson !== undefined
        ? JSON.parse(templated(JSON.stringify(sentJson), links, i))
        : request.postData?.text
          ? templated(request.postData.text, links, i)
          : undefined;

    // What this entry gives, from the links that start here.
    const gives: Produces[] = links.filter((l) => l.from === i).map((l) => ({key: l.key, from: l.at}));

    const status = entry.response?.status ?? 200;
    const spec = {
      method,
      path,
      ...(Object.keys(query).length ? {query} : {}),
      ...(Object.keys(headers).length ? {headers} : {}),
      ...(body === undefined ? {} : {body}),
    };

    return {
      type: uniqueType(`har.${slug}.${slugify(`${method} ${url.pathname}`)}`, usedTypes),
      label: `${method} ${url.pathname}`,
      summary: `Recorded ${entry.startedDateTime?.slice(11, 19) ?? ''} · answered ${status}`.trim(),
      group: url.hostname,
      fields: [],
      request: spec,
      needs: inferNeeds(spec),
      gives,
      // The status that was actually observed. A recording of a 500 is a
      // recording of a bug, so only success is asserted by default.
      assertions: status >= 200 && status < 300 ? [{op: 'status' as const, expected: status}] : [],
      ...(status >= 400 ? {notes: `This call answered ${status} when recorded, so no status check was added.`} : {}),
    };
  });

  if (links.length) {
    warnings.push(
      `Chained ${links.length} value${links.length === 1 ? '' : 's'} between steps: ${links
        .slice(0, 6)
        .map((l) => l.key)
        .join(', ')}${links.length > 6 ? '…' : ''}. Check they are the right ones before running.`,
    );
  } else {
    warnings.push('No values linked between requests — the steps will replay exactly as recorded.');
  }

  // Recorded credentials that could not be traced back to a step in the
  // recording. Those are dead values from someone's session, and the answer is
  // an auth scheme rather than an import.
  const orphanCredentials = kept.filter((entry, i) =>
    (entry.request?.headers ?? []).some(
      (h) => SECRET_HEADERS.has(h.name.toLowerCase()) && templated(h.value ?? '', links, i) === (h.value ?? ''),
    ),
  ).length;
  if (orphanCredentials) {
    warnings.push(
      `Dropped the credentials on ${orphanCredentials} request${orphanCredentials === 1 ? '' : 's'} — ` +
        `they came from your session, not from a step here. Configure an auth scheme instead.`,
    );
  }

  return {ok: true, slug, title, servers, nodes, warnings, format: 'har'};
}
