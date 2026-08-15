// ---- Shared inference used by every importer ----

import type {RequestSpec} from './types';

/**
 * The context keys a node's own request and defaults reference.
 *
 * Importers can't read a `needs` list off a document, but they don't have to:
 * if a node's path is `/pets/{{vars.petId}}`, it needs `petId` by construction.
 * Deriving it means the pre-run check works for imported nodes too, instead of
 * only for hand-written ones.
 */
export function inferNeeds(request: RequestSpec, defaults: Record<string, unknown> = {}): string[] {
  const found = new Set<string>();
  const scan = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g)) found.add(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(scan);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(scan);
    }
  };
  scan(request);
  scan(defaults);
  return [...found];
}

/** `my-cool request!` -> `my-cool-request`, for building node type names. */
export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Give a type name a unique suffix rather than letting a collision shadow it. */
export function uniqueType(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  used.add(`${base}-${n}`);
  return `${base}-${n}`;
}
