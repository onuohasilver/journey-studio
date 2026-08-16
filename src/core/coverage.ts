// ---- What the suite does not test ----
//
// "Did it pass" is the easy question. The hard one is "what am I not testing",
// and it is normally unanswerable: nobody knows the denominator. Here the
// denominator is sitting right there — an imported document declares every
// operation the API has, and the saved journeys declare which ones they touch.
//
// The counting is done here, in code, and deliberately not by the model. A
// number that might be hallucinated is worse than no number, because people act
// on coverage figures. What the model is good for is the part that is genuinely
// judgement: which of the gaps matter, and what to write next.

import type {NodeDef} from './types';

export interface CoverageRow {
  type: string;
  label: string;
  group?: string;
  method?: string;
  path?: string;
  /** Creates or destroys real data — an untested one of these is worth more. */
  destructive?: boolean;
  /** Journeys that use it. Empty means nothing does. */
  usedBy: string[];
}

export interface GroupCoverage {
  group: string;
  total: number;
  covered: number;
}

export interface Coverage {
  covered: CoverageRow[];
  uncovered: CoverageRow[];
  byGroup: GroupCoverage[];
  /** 0–100, of operations rather than of steps. */
  percent: number;
  /** Node types a journey uses that no loaded document declares. */
  unknown: string[];
}

export interface JourneyUse {
  name: string;
  types: string[];
}

/**
 * Coverage is of the *API*, not of the tool.
 *
 * The built-in control steps — wait, set values, assert, the raw HTTP node —
 * are not operations anybody needs to cover, and counting them would flatter
 * every number here. The raw HTTP node especially: it can call anything, so
 * counting it as covering something would be a lie in either direction.
 */
function isOperation(def: NodeDef): boolean {
  return Boolean(def.request) && !def.type.startsWith('control.') && def.type !== 'http.request';
}

export function coverageOf(defs: NodeDef[], journeys: JourneyUse[]): Coverage {
  const operations = defs.filter(isOperation);
  const declared = new Set(operations.map((d) => d.type));

  const usedBy = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (const journey of journeys) {
    for (const type of new Set(journey.types)) {
      if (!declared.has(type)) {
        // A journey using a type no loaded document declares is usually a
        // document that has not been imported this session — worth saying,
        // because otherwise its coverage silently reads as zero.
        if (!type.startsWith('control.') && type !== 'http.request') unknown.add(type);
        continue;
      }
      usedBy.set(type, [...(usedBy.get(type) ?? []), journey.name]);
    }
  }

  const rows: CoverageRow[] = operations.map((def) => ({
    type: def.type,
    label: def.label,
    group: def.group,
    method: def.request?.method,
    path: def.request?.path,
    destructive: def.destructive,
    usedBy: usedBy.get(def.type) ?? [],
  }));

  const covered = rows.filter((r) => r.usedBy.length);
  const uncovered = rows.filter((r) => !r.usedBy.length);

  const groups = new Map<string, GroupCoverage>();
  for (const row of rows) {
    const key = row.group ?? 'ungrouped';
    const entry = groups.get(key) ?? {group: key, total: 0, covered: 0};
    entry.total += 1;
    if (row.usedBy.length) entry.covered += 1;
    groups.set(key, entry);
  }

  return {
    covered,
    uncovered,
    // Worst first: the group with the most left to do is the one to look at.
    byGroup: [...groups.values()].sort((a, b) => a.covered / a.total - b.covered / b.total),
    percent: rows.length ? Math.round((covered.length / rows.length) * 100) : 0,
    unknown: [...unknown],
  };
}

/**
 * The gaps, as a compact list for the model to rank.
 *
 * Capped, because a 500-operation document would otherwise be most of the
 * prompt, and the tail of an alphabetical list is not where the risk is.
 * Destructive operations go first so the cap never cuts them.
 */
export function gapsForRanking(coverage: Coverage, limit = 120): string {
  return [...coverage.uncovered]
    .sort((a, b) => Number(Boolean(b.destructive)) - Number(Boolean(a.destructive)))
    .slice(0, limit)
    .map((row) =>
      [row.type, row.label, `${row.method ?? ''} ${row.path ?? ''}`.trim(), row.group ?? '', row.destructive ? 'destructive' : '']
        .filter(Boolean)
        .join(' | '),
    )
    .join('\n');
}

/** One line for the panel and the CLI. */
export function summariseCoverage(coverage: Coverage): string {
  const total = coverage.covered.length + coverage.uncovered.length;
  if (!total) return 'No operations loaded — import a document first.';
  return `${coverage.covered.length} of ${total} operations covered (${coverage.percent}%)`;
}
