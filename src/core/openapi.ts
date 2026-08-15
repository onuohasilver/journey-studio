// ---- OpenAPI document -> node definitions ----
//
// This is where nodes come from. Hand-authoring a catalog is how the idea dies:
// it is weeks of work per API and it goes stale the moment the backend ships.
// A spec already describes the paths, methods, parameters and bodies, so the
// importer transcribes that half and leaves the half a spec cannot express —
// what a step *gives* the steps after it — as an editable guess.
//
// The guesses are deliberately conservative and always visible in the inspector.
// A wrong guess the user can see and fix beats a silent one.

import {parse as parseYaml} from 'yaml';
import type {Field, ImportResult, Method, NodeDef, Produces, RequestSpec} from './types';

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

type Doc = Record<string, any>;

/** Resolve local `#/...` refs. Remote refs are reported, not fetched. */
function deref(node: any, doc: Doc, seen = new Set<string>()): any {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const ref: string = node.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return {};
    seen.add(ref);
    let target: any = doc;
    for (const seg of ref.slice(2).split('/')) {
      target = target?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return deref(target, doc, seen);
  }
  if (Array.isArray(node)) return node.map((n) => deref(n, doc, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(v, doc, seen);
  return out;
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spec';
}

/** `/pets/{petId}/toys` -> `pet`; used to name inferred outputs. */
function resourceFromPath(path: string): string {
  const seg = path.split('/').filter((s) => s && !s.startsWith('{')).pop() ?? 'item';
  const word = seg.replace(/[^a-zA-Z0-9]/g, '');
  return word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.replace(/s$/, '') || 'item';
}

function fieldKind(schema: any): Field['kind'] {
  switch (schema?.type) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
    case 'array':
      return 'json';
    default:
      return schema?.enum ? 'select' : 'text';
  }
}

/** A usable starting value: the spec's own example, else an empty-ish default. */
function exampleFor(schema: any): unknown {
  if (schema === undefined || schema === null) return '';
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = exampleFor(v);
      return out;
    }
    default:
      return '';
  }
}

/** The first 2xx response body schema, which is what we can infer outputs from. */
function successSchema(op: any): any {
  const responses = op?.responses ?? {};
  const code = Object.keys(responses).find((c) => /^2\d\d$/.test(c)) ?? 'default';
  const content = responses[code]?.content ?? {};
  const json = Object.keys(content).find((t) => t.includes('json'));
  return json ? content[json].schema : undefined;
}

/**
 * Guess what a step hands forward.
 *
 * Only the unambiguous case: a 2xx JSON body with a top-level id-ish field.
 * Named after the path's resource (`/pets` -> `petId`) so it reads like
 * something a person would have typed, and so a later `/pets/{petId}` lines up.
 */
function inferGives(op: any, path: string): Produces[] {
  const schema = successSchema(op);
  const props = schema?.type === 'object' ? schema.properties ?? {} : {};
  const resource = resourceFromPath(path);
  for (const name of ['id', 'uuid', `${resource}Id`, `${resource}_id`]) {
    if (props[name]) return [{key: `${resource}Id`, from: `body.${name}`}];
  }
  return [];
}

/** Context keys a node's own defaults reference, so pre-run checks still work. */
function inferNeeds(request: RequestSpec, defaults: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const scan = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g)) found.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  scan(request);
  scan(defaults);
  return [...found];
}

export function importOpenApi(text: string, filename?: string): ImportResult {
  const empty: ImportResult = {ok: false, slug: '', title: '', servers: [], nodes: [], warnings: []};

  let doc: Doc;
  try {
    doc = text.trim().startsWith('{') ? JSON.parse(text) : (parseYaml(text) as Doc);
  } catch (err) {
    return {...empty, error: `Could not parse the document: ${(err as Error).message}`};
  }
  if (!doc || typeof doc !== 'object') return {...empty, error: 'The document is empty.'};
  if (!doc.openapi && !doc.swagger) {
    return {...empty, error: 'No "openapi" or "swagger" version field — is this an API document?'};
  }
  if (doc.swagger) {
    return {...empty, error: 'Swagger 2.0 is not supported yet. Convert it to OpenAPI 3 first.'};
  }

  const title: string = doc.info?.title ?? filename ?? 'API';
  const slug = slugify(title);
  const servers: string[] = (doc.servers ?? []).map((s: any) => s.url).filter(Boolean);
  const warnings: string[] = [];
  const nodes: NodeDef[] = [];
  const usedTypes = new Set<string>();

  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const item = deref(rawItem, doc) as Doc;
    const shared = (item.parameters ?? []) as any[];

    for (const method of METHODS) {
      const op = item[method.toLowerCase()];
      if (!op) continue;

      const params = [...shared, ...((op.parameters ?? []) as any[])].map((p) => deref(p, doc));
      const fields: Field[] = [];
      const defaults: Record<string, unknown> = {};
      const query: Record<string, string> = {};
      const headers: Record<string, string> = {};

      // Path params default to `{{vars.<name>}}` — that single choice is what
      // makes an imported spec chain: if an earlier step produced `petId`, a
      // later `/pets/{petId}` picks it up with no wiring at all.
      let templatedPath = path;
      for (const p of params) {
        if (!p?.name) continue;
        const kind = fieldKind(p.schema);
        const help = p.description ? String(p.description).split('\n')[0] : undefined;
        const options = Array.isArray(p.schema?.enum)
          ? p.schema.enum.map((v: unknown) => ({value: String(v), label: String(v)}))
          : undefined;

        if (p.in === 'path') {
          fields.push({key: p.name, label: p.name, kind, help, options, required: true});
          defaults[p.name] = `{{vars.${p.name}}}`;
          templatedPath = templatedPath.replace(`{${p.name}}`, `{{fields.${p.name}}}`);
        } else if (p.in === 'query') {
          fields.push({key: p.name, label: p.name, kind, help, options, required: !!p.required});
          defaults[p.name] = p.required ? exampleFor(p.schema) : '';
          query[p.name] = `{{fields.${p.name}}}`;
        } else if (p.in === 'header') {
          fields.push({key: p.name, label: p.name, kind, help, options});
          defaults[p.name] = exampleFor(p.schema);
          headers[p.name] = `{{fields.${p.name}}}`;
        }
      }

      // Request body arrives as one editable JSON field rather than a field per
      // property: bodies nest, and a flattened form lies about the shape.
      let body: unknown;
      const bodyContent = deref(op.requestBody, doc)?.content ?? {};
      const jsonType = Object.keys(bodyContent).find((t) => t.includes('json'));
      if (jsonType) {
        const schema = bodyContent[jsonType].schema;
        fields.push({key: 'body', label: 'Request body', kind: 'json', required: !!op.requestBody?.required});
        defaults.body = bodyContent[jsonType].example ?? exampleFor(schema);
        body = '{{fields.body}}';
      } else if (Object.keys(bodyContent).length) {
        warnings.push(`${method} ${path}: body is ${Object.keys(bodyContent)[0]}, not JSON — send it by hand.`);
      }

      const base = op.operationId
        ? String(op.operationId)
        : `${method.toLowerCase()}${path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
      let type = `openapi.${slug}.${base}`;
      if (usedTypes.has(type)) {
        // Duplicate operationIds happen in real documents; a collision would
        // make one operation silently unreachable.
        let n = 2;
        while (usedTypes.has(`${type}-${n}`)) n++;
        warnings.push(`Duplicate operationId "${base}" — imported the second one as "${base}-${n}".`);
        type = `${type}-${n}`;
      }
      usedTypes.add(type);

      const request: RequestSpec = {
        method,
        path: templatedPath,
        ...(Object.keys(query).length ? {query} : {}),
        ...(Object.keys(headers).length ? {headers} : {}),
        ...(body !== undefined ? {body} : {}),
      };

      nodes.push({
        type,
        label: op.summary ? String(op.summary) : `${method} ${path}`,
        summary: op.description ? String(op.description).split('\n')[0] : undefined,
        group: op.tags?.[0] ? String(op.tags[0]) : 'default',
        fields,
        defaults,
        request,
        needs: inferNeeds(request, defaults),
        gives: inferGives(op, path),
        assertions: [{op: 'status', expected: Number(Object.keys(op.responses ?? {}).find((c) => /^2\d\d$/.test(c))) || 200}],
        destructive: method === 'DELETE',
      });
    }
  }

  if (!nodes.length) return {...empty, slug, title, error: 'The document declares no operations.'};

  return {ok: true, slug, title, version: doc.info?.version, servers, nodes, warnings, format: 'openapi'};
}
