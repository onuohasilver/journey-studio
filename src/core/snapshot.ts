// ---- Response snapshots ----
//
// Contract checking only works when the API published a schema. Most don't:
// every Postman collection arrives with none, and plenty of OpenAPI documents
// describe their responses as a bare `object`. For those, the best available
// description of the contract is what the API returned last time it was known
// good.
//
// So we record the *shape* — every path and its type — and compare later runs
// against it. Not the values: ids, timestamps and balances change every run, and
// a check that fires on those is one people turn off in a week. Shapes hold
// still, and a shape that moved is exactly the regression worth waking up for.
//
// This is `jest -u` semantics applied to an API rather than a component tree,
// and the reason it earns its keep is that it needs no spec, no assertions and
// no maintenance — you get drift detection on an API nobody documented.

const MAX_DEPTH = 6;
const MAX_PATHS = 200;
/** Enough array elements to learn the shape; the 500th teaches nothing new. */
const MAX_ELEMENTS = 20;

/** Path → type, e.g. `body.data.*.id` → `number`. */
export type Shape = Record<string, string>;

export type ShapeChangeKind = 'removed' | 'type-changed' | 'now-optional' | 'added';

export interface ShapeChange {
  path: string;
  kind: ShapeChangeKind;
  was?: string;
  now?: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Merge the shapes of an array's elements into one.
 *
 * A list where element 0 has `nickname` and element 1 does not describes an
 * optional field, not a missing one. Recording that as `string?` is what stops
 * the next run reporting a removal every time the list happens to come back in a
 * different order.
 */
function mergeElement(into: Shape, one: Shape, seen: Set<string>, first: boolean) {
  for (const [path, type] of Object.entries(one)) {
    const existing = into[path];
    if (existing === undefined) {
      // Present here but absent from an earlier element: optional either way.
      into[path] = first ? type : `${type}?`;
    } else if (existing !== type && existing !== `${type}?`) {
      const merged = [...new Set([existing.replace(/\?$/, ''), type])].sort().join('|');
      into[path] = existing.endsWith('?') ? `${merged}?` : merged;
    }
    seen.add(path);
  }
  for (const path of seen) {
    if (one[path] === undefined && into[path] && !into[path].endsWith('?')) into[path] = `${into[path]}?`;
  }
}

function walk(value: unknown, prefix: string, out: Shape, depth: number): void {
  if (Object.keys(out).length >= MAX_PATHS) return;

  if (Array.isArray(value)) {
    out[prefix] = 'array';
    if (depth >= MAX_DEPTH) return;
    const merged: Shape = {};
    const seen = new Set<string>();
    value.slice(0, MAX_ELEMENTS).forEach((element, i) => {
      const one: Shape = {};
      walk(element, `${prefix}.*`, one, depth + 1);
      mergeElement(merged, one, seen, i === 0);
    });
    Object.assign(out, merged);
    return;
  }

  if (value && typeof value === 'object') {
    if (prefix) out[prefix] = 'object';
    if (depth >= MAX_DEPTH) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, prefix ? `${prefix}.${key}` : key, out, depth + 1);
    }
    return;
  }

  out[prefix] = typeOf(value);
}

/** The structural fingerprint of a response body. */
export function shapeOf(body: unknown): Shape {
  const out: Shape = {};
  walk(body, '', out, 0);
  return out;
}

/**
 * What changed between the recorded shape and this run's.
 *
 * The severities encode who breaks. A field that disappeared or changed type
 * breaks every consumer reading it today, so it is an error. A field that
 * stopped always being present breaks the ones that assumed it, so it is a
 * warning. A new field breaks nobody, so it is information — reporting additions
 * as failures is how a snapshot suite becomes something people delete.
 */
export function diffShape(baseline: Shape, current: Shape): ShapeChange[] {
  const changes: ShapeChange[] = [];

  for (const [path, was] of Object.entries(baseline)) {
    const now = current[path];
    const optionalBefore = was.endsWith('?');

    if (now === undefined) {
      // An optional field being absent is what optional means.
      if (optionalBefore) continue;
      changes.push({
        path,
        kind: 'removed',
        was,
        severity: 'error',
        message: `${path} is no longer returned — it was ${was} when this was recorded.`,
      });
      continue;
    }

    const bare = (t: string) => t.replace(/\?$/, '');
    if (bare(was) !== bare(now)) {
      changes.push({
        path,
        kind: 'type-changed',
        was,
        now,
        severity: 'error',
        message: `${path} came back as ${bare(now)}, but was ${bare(was)} when this was recorded.`,
      });
      continue;
    }

    if (!optionalBefore && now.endsWith('?')) {
      changes.push({
        path,
        kind: 'now-optional',
        was,
        now,
        severity: 'warn',
        message: `${path} is missing from some items — it was always present when this was recorded.`,
      });
    }
  }

  for (const [path, now] of Object.entries(current)) {
    if (baseline[path] === undefined) {
      changes.push({
        path,
        kind: 'added',
        now,
        severity: 'info',
        message: `${path} is new since this was recorded (${bareType(now)}).`,
      });
    }
  }

  return changes;
}

function bareType(type: string): string {
  return type.replace(/\?$/, '');
}

/** One line for a report row. */
export function summariseShape(changes: ShapeChange[]): string {
  const breaks = changes.filter((c) => c.severity === 'error').length;
  const warns = changes.filter((c) => c.severity === 'warn').length;
  const added = changes.filter((c) => c.kind === 'added').length;

  const parts: string[] = [];
  if (breaks) parts.push(`${breaks} shape break${breaks === 1 ? '' : 's'}`);
  if (warns) parts.push(`${warns} now optional`);
  if (added) parts.push(`${added} new field${added === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'same shape as recorded';
}

// ---- the file on disk ----

export const SNAPSHOT_VERSION = 1;

export interface SnapshotFile {
  version: number;
  journey: string;
  recordedAt: string;
  /** The environment it was recorded against — shapes can legitimately differ. */
  env?: string;
  /** Node id → the shape its response had when recorded. */
  nodes: Record<string, Shape>;
}

export function packSnapshot(
  journey: string,
  nodes: Record<string, Shape>,
  meta: {env?: string; recordedAt?: string} = {},
): SnapshotFile {
  return {
    version: SNAPSHOT_VERSION,
    journey,
    recordedAt: meta.recordedAt ?? new Date().toISOString(),
    env: meta.env,
    nodes,
  };
}

export function readSnapshot(text: string): SnapshotFile | undefined {
  try {
    const raw = JSON.parse(text) as Partial<SnapshotFile>;
    if (!raw || typeof raw !== 'object' || !raw.nodes) return undefined;
    // A newer file is not readable; silently comparing against a format we do
    // not understand would report drift that is really a version difference.
    if (typeof raw.version === 'number' && raw.version > SNAPSHOT_VERSION) return undefined;
    return {
      version: raw.version ?? SNAPSHOT_VERSION,
      journey: raw.journey ?? '',
      recordedAt: raw.recordedAt ?? '',
      env: raw.env,
      nodes: raw.nodes,
    };
  } catch {
    return undefined;
  }
}

export function snapshotNameFor(journeyFile: string): string {
  return `${journeyFile.replace(/\.journey\.json$/, '')}.snap.json`;
}
