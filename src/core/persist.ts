// ---- Saving a journey so it survives, travels, and runs in CI ----
//
// The obvious format — nodes and edges — is not enough. A journey's steps are
// typed against definitions that came from an imported document, so a file
// holding only ids would open as a canvas full of "unknown node type" unless
// whoever opened it happened to import the same spec first. In CI, nobody does.
//
// So a saved journey carries the definitions it uses. Two consequences, both
// wanted:
//
//   it runs anywhere, with no document and no import step
//   it pins the contract as it was the day you saved it, which is exactly what
//   a regression test should do — if the spec later changes, that is the news

import type {Journey, JourneyCase, NodeDef} from './types';

export const FILE_VERSION = 1;

export interface SavedJourney {
  version: number;
  name: string;
  description?: string;
  savedAt: string;
  /** The environment it was last run against, as a hint — not a lock. */
  env?: string;
  journey: Journey;
  /** Definitions for every node type the journey uses. */
  defs: NodeDef[];
  /** Where those definitions came from, for the "re-import to update" path. */
  sources?: {slug: string; title: string; format?: string}[];
}

export interface LoadResult {
  ok: boolean;
  saved?: SavedJourney;
  error?: string;
  /** Types the file did not carry and that are not registered either. */
  missingTypes: string[];
}

/** Everything the journey needs, and nothing it doesn't. */
export function packJourney(
  journey: Journey,
  lookup: (type: string) => NodeDef | undefined,
  meta: {description?: string; env?: string; sources?: SavedJourney['sources']} = {},
): SavedJourney {
  const used = [...new Set(journey.nodes.map((n) => n.type))];
  const defs = used.map(lookup).filter((d): d is NodeDef => Boolean(d));

  return {
    version: FILE_VERSION,
    name: journey.name,
    description: meta.description ?? journey.description,
    savedAt: new Date().toISOString(),
    env: meta.env,
    journey,
    defs,
    ...(meta.sources?.length ? {sources: meta.sources} : {}),
  };
}

function isJourney(value: unknown): value is Journey {
  const j = value as Journey;
  return Boolean(j) && typeof j === 'object' && Array.isArray(j.nodes) && Array.isArray(j.edges);
}

/**
 * Cases arrive from a pasted spreadsheet, so the file may hold anything. A case
 * without a usable `vars` object would seed nothing and quietly run the journey
 * against the defaults — a green row that tested the wrong thing.
 */
function readCases(raw: unknown): JourneyCase[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cases = raw
    .filter((c): c is JourneyCase => Boolean(c) && typeof c === 'object' && typeof (c as JourneyCase).vars === 'object')
    .map((c, i) => ({name: String(c.name ?? `case ${i + 1}`), vars: {...c.vars}}));
  return cases.length ? cases : undefined;
}

/**
 * Read a saved journey.
 *
 * Definitions in the file are the authority: a journey saved against yesterday's
 * spec should keep running the way it did, and the difference from today's spec
 * is a finding, not something to paper over by silently preferring whatever
 * happens to be registered now.
 */
export function readSaved(text: string, registered: (type: string) => NodeDef | undefined): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {ok: false, error: `Not valid JSON: ${(err as Error).message}`, missingTypes: []};
  }

  const saved = raw as Partial<SavedJourney>;
  if (!saved || typeof saved !== 'object' || !isJourney(saved.journey)) {
    return {ok: false, error: 'This file does not contain a journey.', missingTypes: []};
  }
  if (typeof saved.version === 'number' && saved.version > FILE_VERSION) {
    return {
      ok: false,
      error: `Saved by a newer version of Journey Studio (file v${saved.version}, this build reads v${FILE_VERSION}).`,
      missingTypes: [],
    };
  }

  const carried = new Map((saved.defs ?? []).map((d) => [d.type, d]));
  const missingTypes = [...new Set(saved.journey.nodes.map((n) => n.type))].filter(
    (type) => !carried.has(type) && !registered(type),
  );

  return {
    ok: true,
    saved: {
      version: saved.version ?? FILE_VERSION,
      name: saved.name ?? saved.journey.name ?? 'Untitled journey',
      description: saved.description,
      savedAt: saved.savedAt ?? new Date().toISOString(),
      env: saved.env,
      journey: {
        ...saved.journey,
        name: saved.name ?? saved.journey.name,
        cases: readCases(saved.journey.cases),
        ...(Array.isArray(saved.journey.tags) && saved.journey.tags.length
          ? {tags: saved.journey.tags.map(String)}
          : {}),
        ...(Array.isArray(saved.journey.uses) && saved.journey.uses.length
          ? {uses: saved.journey.uses.map(String)}
          : {}),
      },
      defs: saved.defs ?? [],
      sources: saved.sources,
    },
    missingTypes,
  };
}

/** A file name that is safe on every platform and readable in a repo. */
export function fileNameFor(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'journey';
  return `${slug}.journey.json`;
}
