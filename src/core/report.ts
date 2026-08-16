// ---- The QA report ----
//
// A green tick is not a QA result. What a person needs the morning after a
// nightly run is evidence: which journey, which step, what was sent, what came
// back, how long it took, what data it created on a shared environment, and
// where the API stopped matching its own spec.
//
// Everything here is a pure function of a finished run, so the same report backs
// the UI panel, the CLI's exit code, the JSON artifact, and the Slack post.

import {summariseContract, type ContractFinding} from './contract';
import {summariseShape, type ShapeChange} from './snapshot';
import {topoOrder} from './graph';
import type {Journey, NodeDef, NodeState, RunContext, RunStatus} from './types';

export interface StepReport {
  id: string;
  label: string;
  type: string;
  status: RunStatus;
  httpStatus?: number;
  durationMs?: number;
  error?: string;
  failedAssertions: string[];
  contract: ContractFinding[];
  /** How the response shape moved since it was recorded. */
  shapeChanges: ShapeChange[];
  /** The step's declared time budget, if it has one. */
  budgetMs?: number;
  /** Set when this run exceeded that budget. */
  overBudget?: {budgetMs: number; actualMs: number};
  /** How many times the request was sent. Above one means the step polled. */
  attempts?: number;
  /** True for a cleanup step, which runs after the journey either way. */
  teardown?: boolean;
  /** What happened when this step fired a burst of identical requests. */
  concurrent?: import('./types').ConcurrentSummary;
  /** The webhook this step waited for came from a saved mock, not the real thing. */
  mocked?: boolean;
  /** Only for a failed step: what was sent, so the failure is reproducible. */
  request?: {method: string; url: string};
  /** Only when explicitly asked for — bodies routinely hold PII and tokens. */
  responseBody?: unknown;
}

export interface JourneyReport {
  name: string;
  /** Which row of a data-driven run this was. Absent for a plain journey. */
  case?: string;
  status: 'passed' | 'failed';
  durationMs: number;
  steps: StepReport[];
  /** Values the run captured — i.e. records it created on a shared environment. */
  created: {key: string; value: string}[];
  contractBreaks: number;
  shapeBreaks: number;
  /** Cleanup steps that failed — data this run could not take back. */
  leaked: string[];
  /** Steps whose webhook was mocked rather than delivered by the integration. */
  mocked: number;
}

export interface QaReport {
  startedAt: string;
  durationMs: number;
  env: string;
  baseUrl?: string;
  status: 'passed' | 'failed';
  totals: {
    journeys: number;
    passed: number;
    failed: number;
    steps: number;
    contractBreaks: number;
    shapeBreaks: number;
    leaked: number;
    mocked: number;
  };
  journeys: JourneyReport[];
  /** Steps whose outcome varied across repeats. Populated by `findFlakes`. */
  flaky?: FlakyStep[];
  /** Steps whose p95 blew their budget. Populated by `findSlowSteps`. */
  slow?: StepTiming[];
  /**
   * Journeys that never ran because a setup they depend on failed.
   *
   * Distinct from failed on purpose: they did not touch the API under test, and
   * calling them failures would put twenty red rows around one broken login.
   */
  skipped?: {name: string; reason: string}[];
}

export interface FlakyStep {
  journey: string;
  step: string;
  passed: number;
  of: number;
}

export interface StepTiming {
  journey: string;
  step: string;
  samples: number;
  p50: number;
  p95: number;
  max: number;
  budgetMs: number;
}

export interface ReportOptions {
  /** Include response bodies for failed steps. Off by default. */
  includeBodies?: boolean;
  /** Which row of a data-driven run produced this. */
  caseName?: string;
}

const MAX_VALUE = 80;

function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text && text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : String(text);
}

export function buildJourneyReport(
  journey: Journey,
  states: Record<string, NodeState>,
  context: RunContext | undefined,
  lookup: (type: string) => NodeDef | undefined,
  options: ReportOptions = {},
): JourneyReport {
  const ordered = topoOrder(journey.nodes, journey.edges);
  let durationMs = 0;
  let contractBreaks = 0;
  let shapeBreaks = 0;

  const steps: StepReport[] = ordered.map((node) => {
    const state = states[node.id] ?? {status: 'idle' as RunStatus};
    const def = lookup(node.type);
    const contract = state.contract ?? [];
    const shapeChanges = state.shapeChanges ?? [];
    contractBreaks += contract.filter((f) => f.severity === 'error').length;
    shapeBreaks += shapeChanges.filter((c) => c.severity === 'error').length;
    durationMs += state.durationMs ?? 0;

    return {
      id: node.id,
      label: node.label ?? def?.label ?? node.type,
      type: node.type,
      status: state.status,
      httpStatus: state.response?.status,
      durationMs: state.durationMs,
      error: state.error,
      failedAssertions: (state.assertions ?? [])
        .filter((a) => !a.pass)
        .map((a) => a.assertion.label ?? a.assertion.path ?? a.assertion.op),
      contract,
      shapeChanges,
      ...(node.budgetMs ? {budgetMs: node.budgetMs} : {}),
      ...(state.overBudget ? {overBudget: state.overBudget} : {}),
      ...(state.attempts && state.attempts > 1 ? {attempts: state.attempts} : {}),
      ...(state.teardown ? {teardown: true} : {}),
      ...(state.mocked ? {mocked: true} : {}),
      ...(state.response?.concurrent ? {concurrent: state.response.concurrent} : {}),
      ...(state.status === 'failed' && state.sent
        ? {request: {method: state.sent.method, url: state.sent.url}}
        : {}),
      ...(state.status === 'failed' && options.includeBodies && state.response
        ? {responseBody: state.response.body}
        : {}),
    };
  });

  // What the run left behind on a shared environment. The single most useful
  // line in a nightly report that ran against staging.
  //
  // Keyed rather than listed: two steps commonly write the same key — a create
  // gives `petId` and the read-back gives it again — and one record should be
  // reported once, at the value it ended up with.
  const createdByKey = new Map<string, string>();
  for (const node of ordered) {
    const def = lookup(node.type);
    if (!def || states[node.id]?.status !== 'passed') continue;
    for (const give of [...def.gives, ...(node.gives ?? [])]) {
      if (context?.vars[give.key] === undefined) continue;
      createdByKey.set(give.key, short(context.vars[give.key]));
    }
  }
  const created = [...createdByKey].map(([key, value]) => ({key, value}));

  return {
    name: journey.name,
    ...(options.caseName ? {case: options.caseName} : {}),
    // A cleanup step that failed is a hygiene problem, not a product one: the
    // API under test may have behaved perfectly. It gets its own line rather
    // than turning the journey red, on the same principle as drift — a verdict
    // people learn to distrust is worse than one they read.
    status: steps.some((s) => s.status === 'failed' && !s.teardown) ? 'failed' : 'passed',
    durationMs,
    steps,
    created,
    contractBreaks,
    shapeBreaks,
    leaked: steps.filter((s) => s.teardown && s.status === 'failed').map((s) => s.label),
    mocked: steps.filter((s) => s.mocked).length,
  };
}

/** `Signup` on its own, or `Signup › uk-user` when a case produced it. */
export function journeyTitle(journey: JourneyReport): string {
  return journey.case ? `${journey.name} › ${journey.case}` : journey.name;
}

export function buildReport(
  env: string,
  journeys: JourneyReport[],
  meta: {startedAt: string; durationMs: number; baseUrl?: string} ,
): QaReport {
  const failed = journeys.filter((j) => j.status === 'failed').length;
  return {
    startedAt: meta.startedAt,
    durationMs: meta.durationMs,
    env,
    baseUrl: meta.baseUrl,
    status: failed ? 'failed' : 'passed',
    totals: {
      journeys: journeys.length,
      passed: journeys.length - failed,
      failed,
      steps: journeys.reduce((n, j) => n + j.steps.length, 0),
      contractBreaks: journeys.reduce((n, j) => n + j.contractBreaks, 0),
      shapeBreaks: journeys.reduce((n, j) => n + j.shapeBreaks, 0),
      leaked: journeys.reduce((n, j) => n + j.leaked.length, 0),
      mocked: journeys.reduce((n, j) => n + j.mocked, 0),
    },
    journeys,
  };
}

/** One phrase covering both kinds of drift, for a headline that has room for one. */
export function summariseDrift(totals: QaReport['totals']): string {
  const parts: string[] = [];
  if (totals.contractBreaks) {
    parts.push(
      totals.contractBreaks === 1
        ? '1 response no longer matches the spec'
        : `${totals.contractBreaks} responses no longer match the spec`,
    );
  }
  if (totals.shapeBreaks) {
    parts.push(`${totals.shapeBreaks} changed shape since it was recorded`);
  }
  return parts.join('; ');
}

/**
 * Budgets judged across every run there was, rather than one sample.
 *
 * A single slow response is not an SLO breach — it is a cold start, a noisy
 * neighbour, or a laptop that went to sleep. Failing on it produces exactly the
 * flakiness this tool exists to name, so the verdict is taken at p95: with one
 * run that is the run, and with twelve cases or five repeats it is the number
 * anybody would actually defend in a review.
 */
export function findSlowSteps(attempts: QaReport[]): StepTiming[] {
  const samples = new Map<string, {journey: string; step: string; budgetMs: number; times: number[]}>();

  for (const attempt of attempts) {
    for (const journey of attempt.journeys) {
      for (const step of journey.steps) {
        if (!step.budgetMs || step.durationMs === undefined) continue;
        // Keyed on the journey, not the case: twelve rows of one journey are
        // twelve samples of the same step, which is the point.
        const key = `${journey.name}\u0000${step.id}`;
        const row = samples.get(key) ?? {journey: journey.name, step: step.label, budgetMs: step.budgetMs, times: []};
        row.times.push(step.durationMs);
        samples.set(key, row);
      }
    }
  }

  return [...samples.values()]
    .map((row) => {
      const sorted = [...row.times].sort((a, b) => a - b);
      return {
        journey: row.journey,
        step: row.step,
        samples: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1],
        budgetMs: row.budgetMs,
      };
    })
    .filter((row) => row.p95 > row.budgetMs)
    .sort((a, b) => b.p95 / b.budgetMs - a.p95 / a.budgetMs);
}

/** Nearest-rank, so the answer is always a number that actually occurred. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/**
 * Compare repeats of the same suite and name the steps that could not make up
 * their mind.
 *
 * A test that fails one run in five is worse than one that always fails: the
 * always-failing one gets fixed, and the flaky one teaches the team to ignore
 * red. Naming them is the first step to killing them.
 */
export function findFlakes(attempts: QaReport[]): FlakyStep[] {
  if (attempts.length < 2) return [];

  const tally = new Map<string, {journey: string; step: string; passed: number; of: number}>();
  for (const attempt of attempts) {
    for (const journey of attempt.journeys) {
      for (const step of journey.steps) {
        // Keyed by case as well as journey: in a data-driven suite the same step
        // legitimately passes for one row and fails for another, and calling that
        // flaky would bury the step that is genuinely unreliable.
        const key = `${journeyTitle(journey)}\u0000${step.id}`;
        const row = tally.get(key) ?? {journey: journeyTitle(journey), step: step.label, passed: 0, of: 0};
        row.of += 1;
        if (step.status === 'passed') row.passed += 1;
        tally.set(key, row);
      }
    }
  }

  return [...tally.values()].filter((row) => row.passed > 0 && row.passed < row.of);
}

/** Plain-text summary — what the CLI prints and what a human skims first. */
export function summariseText(report: QaReport): string {
  const lines: string[] = [];
  const {totals} = report;

  lines.push(
    `${report.status === 'passed' ? 'PASS' : 'FAIL'} · ${totals.passed}/${totals.journeys} journeys · ` +
      `${totals.steps} steps · ${(report.durationMs / 1000).toFixed(1)}s · env ${report.env}`,
  );
  const drifted = summariseDrift(totals);
  if (drifted) lines.push(drifted);
  // Said plainly and near the verdict: a green run where the callbacks were
  // canned has not tested the integration, and the report must never let that
  // read as though it had.
  if (totals.mocked) {
    lines.push(`${totals.mocked} webhook${totals.mocked === 1 ? '' : 's'} delivered from mocks, not the real integration`);
  }

  for (const journey of report.journeys) {
    lines.push('');
    lines.push(`${journey.status === 'passed' ? '✓' : '✗'} ${journeyTitle(journey)}`);
    for (const step of journey.steps) {
      const mark = step.status === 'passed' ? '  ✓' : step.status === 'failed' ? '  ✗' : '  ·';
      const timing = step.durationMs === undefined ? '' : ` (${step.durationMs}ms)`;
      const burst = step.concurrent
        ? `${step.concurrent.sent} at once → ${step.concurrent.succeeded} ok, ${step.concurrent.distinct} distinct`
        : '';
      const drift = [
        burst,
        step.contract.length ? summariseContract(step.contract) : '',
        step.shapeChanges.some((c) => c.severity !== 'info') ? summariseShape(step.shapeChanges) : '',
        step.overBudget ? `${step.overBudget.actualMs}ms over a ${step.overBudget.budgetMs}ms budget` : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `${mark} ${step.teardown ? '⌫ ' : ''}${step.label}${step.mocked ? ' (mocked)' : ''}` +
          `${step.httpStatus ? ` · ${step.httpStatus}` : ''}` +
          `${timing}${drift ? ` — ${drift}` : ''}`,
      );
      if (step.error) lines.push(`      ${step.error}`);
      if (step.request) lines.push(`      sent: ${step.request.method} ${step.request.url}`);
    }
    if (journey.created.length) {
      lines.push(`  created: ${journey.created.map((c) => `${c.key}=${c.value}`).join(', ')}`);
    }
    if (journey.leaked.length) {
      lines.push(`  LEFT BEHIND: ${journey.leaked.join(', ')} could not clean up`);
    }
  }

  if (report.skipped?.length) {
    lines.push('');
    lines.push('Not run:');
    for (const skip of report.skipped) {
      lines.push(`  · ${skip.name} — needs ${skip.reason}`);
    }
  }

  if (report.slow?.length) {
    lines.push('');
    lines.push('Over budget:');
    for (const slow of report.slow) {
      lines.push(
        `  ⏱ ${slow.journey} · ${slow.step} — p95 ${slow.p95}ms against ${slow.budgetMs}ms ` +
          `(p50 ${slow.p50}ms, max ${slow.max}ms, ${slow.samples} run${slow.samples === 1 ? '' : 's'})`,
      );
    }
  }

  if (report.flaky?.length) {
    lines.push('');
    lines.push('Flaky:');
    for (const flake of report.flaky) {
      lines.push(`  ~ ${flake.journey} · ${flake.step} — passed ${flake.passed} of ${flake.of}`);
    }
  }

  return lines.join('\n');
}
