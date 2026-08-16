// ---- Paste a curl command, get a step ----
//
// Every API's docs, every browser's "Copy as cURL", and every colleague's Slack
// message about a bug all speak the same format. Retyping one into a form is
// busywork, and the mistakes it produces are the annoying kind: a header
// misspelt, a quote lost.
//
// The parser is a small shell-ish tokeniser rather than a regex, because the
// interesting inputs all involve quoting — a JSON body inside single quotes with
// double quotes inside it is the *normal* case, not an edge one.

import {inferNeeds, slugify, uniqueType} from './infer';
import type {ImportResult, Method, NodeDef, RequestSpec} from './types';

/**
 * Split a command the way a shell would, minus the parts that would be a
 * security problem to honour: no expansion, no substitution, no execution.
 */
export function tokenise(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        // Only double quotes process escapes, as in a real shell.
        current += input[++i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && (input[i + 1] === '\n' || input[i + 1] === '\r')) {
      // Line continuation: the form every docs page uses.
      i += input[i + 1] === '\r' && input[i + 2] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

export interface ParsedCurl {
  method: Method;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Credentials found and deliberately not kept. */
  droppedCredentials: string[];
  warnings: string[];
}

/** Header names whose values are credentials, and never travel into a file. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'api-key', 'x-auth-token']);

export function parseCurl(command: string): ParsedCurl | undefined {
  const tokens = tokenise(command.trim());
  if (!tokens.length) return undefined;

  // Tolerate a leading `$ ` prompt, which is how commands get pasted.
  let i = tokens[0] === '$' ? 1 : 0;
  if (tokens[i]?.toLowerCase() !== 'curl') return undefined;
  i += 1;

  const headers: Record<string, string> = {};
  const droppedCredentials: string[] = [];
  const warnings: string[] = [];
  const dataParts: string[] = [];
  let method: Method | undefined;
  let url = '';
  let form = false;

  const value = () => tokens[++i] ?? '';

  for (; i < tokens.length; i++) {
    const token = tokens[i];

    switch (true) {
      case token === '-X' || token === '--request':
        method = value().toUpperCase() as Method;
        break;

      case token === '-H' || token === '--header': {
        const raw = value();
        const at = raw.indexOf(':');
        if (at <= 0) break;
        const name = raw.slice(0, at).trim().toLowerCase();
        const headerValue = raw.slice(at + 1).trim();
        if (CREDENTIAL_HEADERS.has(name)) {
          droppedCredentials.push(name);
          break;
        }
        headers[name] = headerValue;
        break;
      }

      case token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary' ||
        token === '--data-ascii':
        dataParts.push(value());
        break;

      case token === '--data-urlencode':
        dataParts.push(value());
        form = true;
        break;

      case token === '-F' || token === '--form':
        dataParts.push(value());
        form = true;
        warnings.push('Multipart form data was turned into a plain body — check it before running.');
        break;

      case token === '--url':
        url = value();
        break;

      case token === '-u' || token === '--user':
        value();
        droppedCredentials.push('basic auth');
        break;

      case token === '-b' || token === '--cookie':
        value();
        droppedCredentials.push('cookie');
        break;

      // Flags that describe how curl behaves rather than the request.
      case token === '-L' || token === '--location' || token === '--compressed' || token === '-s' ||
        token === '--silent' || token === '-k' || token === '--insecure' || token === '-i' ||
        token === '--include' || token === '-v' || token === '--verbose' || token === '-g':
        break;

      case token === '-o' || token === '--output' || token === '-A' || token === '--user-agent' ||
        token === '-e' || token === '--referer' || token === '--connect-timeout' || token === '-m' ||
        token === '--max-time':
        value();
        break;

      default:
        if (token.startsWith('-')) {
          warnings.push(`Ignored ${token}, which does not describe the request.`);
          break;
        }
        if (!url) url = token;
    }
  }

  if (!url) return undefined;

  const data = dataParts.join('&');
  if (data && !method) method = 'POST';   // curl's own rule
  if (!method) method = 'GET';

  let body: unknown;
  if (data) {
    if (form) {
      body = data;
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else {
      try {
        body = JSON.parse(data);
        headers['content-type'] ??= 'application/json';
      } catch {
        body = data;
      }
    }
  }

  return {method, url, headers, body, droppedCredentials, warnings};
}

export function importCurl(text: string, filename?: string): ImportResult {
  // A file may hold several commands, one per block.
  const commands = text
    .split(/\n\s*(?=\$?\s*curl\s)/)
    .map((c) => c.trim())
    .filter(Boolean);

  const title = filename?.replace(/\.(txt|sh|curl)$/i, '') ?? 'Pasted requests';
  const slug = slugify(title) || 'curl';
  const warnings: string[] = [];
  const used = new Set<string>();
  const servers = new Set<string>();
  const nodes: NodeDef[] = [];

  for (const command of commands) {
    const parsed = parseCurl(command);
    if (!parsed) {
      warnings.push(`Could not read one command — it needs to start with "curl" and include a URL.`);
      continue;
    }

    let path = parsed.url;
    try {
      const parsedUrl = new URL(parsed.url);
      servers.add(parsedUrl.origin);
      // The URL constructor percent-encodes braces, which would turn a pasted
      // `{{vars.orderId}}` into `%7B%7Bvars.orderId%7D%7D` and quietly break
      // every template someone had already written into the command.
      path = `${parsedUrl.pathname}${parsedUrl.search}`.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
    } catch {
      // A relative URL is fine: it is already a path against an environment.
    }

    const request: RequestSpec = {
      method: parsed.method,
      path,
      ...(Object.keys(parsed.headers).length ? {headers: parsed.headers} : {}),
      ...(parsed.body === undefined ? {} : {body: parsed.body}),
    };

    nodes.push({
      type: uniqueType(`curl.${slug}.${slugify(`${parsed.method} ${path}`)}`, used),
      label: `${parsed.method} ${path.split('?')[0]}`,
      group: 'Pasted',
      fields: [],
      request,
      needs: inferNeeds(request),
      gives: [],
      assertions: [],
    });

    warnings.push(...parsed.warnings);
    if (parsed.droppedCredentials.length) {
      warnings.push(
        `Dropped ${[...new Set(parsed.droppedCredentials)].join(', ')} from ${parsed.method} ${path.split('?')[0]} — ` +
          `configure an auth scheme instead of committing a credential.`,
      );
    }
  }

  if (!nodes.length) {
    return {
      ok: false,
      slug,
      title,
      servers: [],
      nodes: [],
      warnings,
      error: 'No curl command found. Paste one starting with "curl", including its URL.',
    };
  }

  return {ok: true, slug, title, servers: [...servers], nodes, warnings, format: 'curl'};
}
