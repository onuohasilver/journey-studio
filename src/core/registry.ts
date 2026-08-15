// ---- The node registry ----
//
// Every consumer — palette, inspector, canvas, runner — reads node definitions
// through this one map. That indirection is the whole extensibility story: a
// definition can arrive from anywhere (built in, imported from a document, a
// plugin later) and behaves exactly like any other, because nothing downstream
// knows or cares where it came from.

import type {ImportResult, NodeDef} from './types';

const defs = new Map<string, NodeDef>();
const listeners = new Set<() => void>();

// Snapshots are rebuilt on change, not on read. `useSyncExternalStore` compares
// snapshots by identity, so returning a fresh array from a getter spins React
// into an infinite render loop.
let defsSnapshot: NodeDef[] = [];
let packsSnapshot: Pack[] = [];

/** A registered document, so it can be listed and removed as a unit. */
export interface Pack {
  slug: string;
  title: string;
  format?: ImportResult['format'];
  servers: string[];
  types: string[];
  warnings: string[];
}

const packs = new Map<string, Pack>();

function announce(): void {
  defsSnapshot = [...defs.values()];
  packsSnapshot = [...packs.values()];
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function lookup(type: string): NodeDef | undefined {
  return defs.get(type);
}

export function allDefs(): NodeDef[] {
  return defsSnapshot;
}

export function allPacks(): Pack[] {
  return packsSnapshot;
}

export function register(list: NodeDef[]): void {
  for (const def of list) defs.set(def.type, def);
  announce();
}

/**
 * Register everything an import produced, replacing that pack if it is already
 * loaded. Re-importing a spec should update its nodes, not stack duplicates.
 */
export function registerPack(result: ImportResult): Pack | undefined {
  if (!result.ok) return undefined;
  removePack(result.slug, false);

  register(result.nodes);
  const pack: Pack = {
    slug: result.slug,
    title: result.title,
    format: result.format,
    servers: result.servers,
    types: result.nodes.map((n) => n.type),
    warnings: result.warnings,
  };
  packs.set(result.slug, pack);
  announce();
  return pack;
}

export function removePack(slug: string, notify = true): string[] {
  const pack = packs.get(slug);
  if (!pack) return [];
  for (const type of pack.types) defs.delete(type);
  packs.delete(slug);
  if (notify) announce();
  return pack.types;
}

/** Test seam. */
export function resetRegistry(): void {
  defs.clear();
  packs.clear();
  announce();
}
