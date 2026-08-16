// ---- What happened last time, and the time before ----
//
// Drift detection works against a baseline, but every run is otherwise an
// island. The question people actually ask when something breaks is "when did
// this start?" — and a tool that can only describe the current run cannot answer
// it.
//
// So each run leaves a small row behind. Small on purpose: a full report per run
// would be megabytes a week and nobody would commit it. What is kept is the
// shape of the answer — per step, did it pass, how long did it take, did it
// drift — which is exactly what a timeline needs and nothing else.

import type {QaReport} from './report';

export const HISTORY_VERSION = 1;

export interface HistoryStep {
  id: string;
  label: string;
  status: 'passed' | 'failed' | 'skipped' | 'other';
  durationMs?: number;
  httpStatus?: number;
  /** Contract findings and shape changes, counted rather than listed. */
  drift: number;
  /** The failure, trimmed. Enough to recognise, not enough to bloat the file. */
  error?: string;
}

export interface HistoryEntry {
  at: string;
  env: string;
  status: 'passed' | 'failed';
  durationMs: number;
  /** Which case, when the run was data-driven. */
  case?: string;
  steps: HistoryStep[];
  /** Set when the callbacks were mocked, so a green row is not misread later. */
  mocked?: number;
  /**
   * What the run created on the environment, and whether it cleaned up.
   *
   * Kept because a run that failed halfway is the one that leaves records
   * behind, and nothing else remembers what they were. This is what `sweep`
   * uses to go back and delete them.
   */
  created?: {key: string; value: string}[];
  /** Clean-up steps that failed. Empty or absent means nothing was left. */
  leaked?: string[];
  /** Set once a sweep has dealt with this entry, so it is not retried forever. */
  sweptAt?: string;
}

export interface HistoryFile {
  version: number;
  journey: string;
  entries: HistoryEntry[];
}

const MAX_ERROR = 160;
/** Enough to see a pattern; a year of nightlies is not a pattern, it is a chart. */
export const MAX_ENTRIES = 100;

function trim(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
}

/** The rows one report contributes — one per journey, or one per case. */
export function entriesFrom(report: QaReport): HistoryEntry[] {
  return report.journeys.map((journey) => ({
    at: report.startedAt,
    env: report.env,
    status: journey.status,
    durationMs: journey.durationMs,
    ...(journey.case ? {case: journey.case} : {}),
    ...(journey.mocked ? {mocked: journey.mocked} : {}),
    // Only worth recording when there is something to go back for: a run that
    // cleaned up after itself leaves no work for a sweep.
    ...(journey.created.length && (journey.leaked.length || journey.status === 'failed')
      ? {created: journey.created}
      : {}),
    ...(journey.leaked.length ? {leaked: journey.leaked} : {}),
    steps: journey.steps.map((step) => ({
      id: step.id,
      label: step.label,
      status:
        step.status === 'passed' || step.status === 'failed' || step.status === 'skipped'
          ? step.status
          : ('other' as const),
      durationMs: step.durationMs,
      httpStatus: step.httpStatus,
      drift:
        step.contract.filter((f) => f.severity === 'error').length +
        step.shapeChanges.filter((c) => c.severity === 'error').length,
      error: trim(step.error),
    })),
  }));
}

/** Newest last, capped. */
export function appendHistory(existing: HistoryFile | undefined, journey: string, entries: HistoryEntry[]): HistoryFile {
  const all = [...(existing?.entries ?? []), ...entries];
  return {
    version: HISTORY_VERSION,
    journey: existing?.journey ?? journey,
    entries: all.slice(-MAX_ENTRIES),
  };
}

export function readHistory(text: string): HistoryFile | undefined {
  try {
    const raw = JSON.parse(text) as Partial<HistoryFile>;
    if (!raw || !Array.isArray(raw.entries)) return undefined;
    if (typeof raw.version === 'number' && raw.version > HISTORY_VERSION) return undefined;
    return {version: raw.version ?? HISTORY_VERSION, journey: raw.journey ?? '', entries: raw.entries};
  } catch {
    return undefined;
  }
}

export function historyNameFor(journeyFile: string): string {
  return `${journeyFile.replace(/\.journey\.json$/, '')}.history.json`;
}

// ---- reading the timeline ----

export interface StepTrend {
  id: string;
  label: string;
  /** Oldest first. `null` where the step did not run in that entry at all. */
  results: (('passed' | 'failed' | 'skipped' | 'other') | null)[];
  /** Same order, for a sparkline. */
  durations: (number | null)[];
  runs: number;
  failures: number;
  /**
   * When the run of consecutive failures began.
   *
   * The answer to "when did this start?" — and the reason to keep history at
   * all. Absent when the step is currently passing.
   */
  failingSince?: string;
  /** The most recent change from passing to failing, or the reverse. */
  lastChangedAt?: string;
}

/**
 * Per-step trends across the entries kept.
 *
 * Entries are grouped by step id rather than label, so renaming a step does not
 * silently start a new history for it.
 */
export function trendsFrom(file: HistoryFile | undefined, limit = 20): StepTrend[] {
  const entries = (file?.entries ?? []).slice(-limit);
  if (!entries.length) return [];

  const order: string[] = [];
  const labels = new Map<string, string>();
  for (const entry of entries) {
    for (const step of entry.steps) {
      if (!labels.has(step.id)) order.push(step.id);
      labels.set(step.id, step.label);
    }
  }

  return order.map((id) => {
    const results: StepTrend['results'] = [];
    const durations: (number | null)[] = [];
    let failingSince: string | undefined;
    let lastChangedAt: string | undefined;
    let previous: string | null = null;

    for (const entry of entries) {
      const step = entry.steps.find((s) => s.id === id);
      const status = step?.status ?? null;
      results.push(status);
      durations.push(step?.durationMs ?? null);

      if (status && previous && status !== previous) lastChangedAt = entry.at;
      // Reset on every pass, so what survives is the *current* run of failures
      // rather than the first one that ever happened.
      if (status === 'failed') failingSince ??= entry.at;
      else if (status === 'passed') failingSince = undefined;
      if (status) previous = status;
    }

    const runs = results.filter((r) => r !== null).length;
    return {
      id,
      label: labels.get(id) ?? id,
      results,
      durations,
      runs,
      failures: results.filter((r) => r === 'failed').length,
      ...(failingSince ? {failingSince} : {}),
      ...(lastChangedAt ? {lastChangedAt} : {}),
    };
  });
}

/**
 * Runs that left records behind and have not been swept.
 *
 * A failed run whose teardown never ran is the common case; a run whose teardown
 * ran and failed is the loud one. Both leave rows on a shared environment that
 * nothing else will ever remove.
 */
export function orphansIn(file: HistoryFile | undefined): HistoryEntry[] {
  return (file?.entries ?? []).filter(
    (entry) => !entry.sweptAt && entry.created?.length && (entry.leaked?.length || entry.status === 'failed'),
  );
}

/** Mark entries as dealt with, matched on their timestamp and case. */
export function markSwept(file: HistoryFile, entries: HistoryEntry[], at: string): HistoryFile {
  const done = new Set(entries.map((e) => `${e.at} ${e.case ?? ''}`));
  return {
    ...file,
    entries: file.entries.map((entry) =>
      done.has(`${entry.at} ${entry.case ?? ''}`) ? {...entry, sweptAt: at} : entry,
    ),
  };
}

/** A one-line account of a step's history, for a report or a Slack message. */
export function describeTrend(trend: StepTrend): string {
  if (!trend.runs) return `${trend.label} — no history`;
  if (trend.failingSince) {
    return `${trend.label} — failing since ${trend.failingSince.slice(0, 16).replace('T', ' ')}`;
  }
  if (!trend.failures) return `${trend.label} — green for ${trend.runs} runs`;
  return `${trend.label} — ${trend.failures} of ${trend.runs} runs failed`;
}
