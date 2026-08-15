// ---- Running the same journey against two environments ----
//
// "It works on staging" is the oldest bug report there is, and the reason it is
// hard to act on is that nobody has the two runs side by side. This runs the
// journey in both and reports only where they disagree.
//
// The comparison deliberately ignores values. Ids, timestamps and balances
// differ between environments by definition — that is what makes them different
// environments. What should not differ is the *contract*: the statuses, the
// shapes, and, loosely, how long things take.

import {diffShape, shapeOf, type Shape} from './snapshot';
import {topoOrder} from './graph';
import type {Journey, NodeDef, NodeState} from './types';

/** How much slower one side has to be before it is worth a line. */
const SLOWER_BY = 2;
/** …and by how many milliseconds, so a 3ms/8ms endpoint stays quiet. */
const SLOWER_THAN_MS = 250;

export interface StepDifference {
  step: string;
  kind: 'status' | 'shape' | 'timing' | 'reached';
  severity: 'error' | 'warn' | 'info';
  message: string;
}

export interface Comparison {
  journey: string;
  a: string;
  b: string;
  differences: StepDifference[];
  /** Steps that ran in both and agreed on everything. */
  same: number;
}

export interface Side {
  env: string;
  states: Record<string, NodeState>;
}

function shapeFor(state: NodeState | undefined): Shape | undefined {
  if (!state) return undefined;
  if (state.shape) return state.shape;
  const status = state.response?.status;
  return status && status >= 200 && status < 300 ? shapeOf(state.response!.body) : undefined;
}

export function compareRuns(journey: Journey, a: Side, b: Side, lookup: (t: string) => NodeDef | undefined): Comparison {
  const differences: StepDifference[] = [];
  let same = 0;

  for (const node of topoOrder(journey.nodes, journey.edges)) {
    const label = node.label ?? lookup(node.type)?.label ?? node.type;
    const left = a.states[node.id];
    const right = b.states[node.id];

    // One side stopping earlier than the other is the headline, not a detail:
    // every later comparison is missing on that side and would otherwise be
    // reported as a pile of differences that all have one cause.
    const ranLeft = left && left.status !== 'idle';
    const ranRight = right && right.status !== 'idle';
    if (!ranLeft || !ranRight) {
      if (ranLeft || ranRight) {
        differences.push({
          step: label,
          kind: 'reached',
          severity: 'error',
          message: `Only ${ranLeft ? a.env : b.env} got this far — ${
            ranLeft ? b.env : a.env
          } stopped before it.`,
        });
      }
      continue;
    }

    let differs = false;

    const leftStatus = left.response?.status;
    const rightStatus = right.response?.status;
    if (leftStatus !== rightStatus) {
      differs = true;
      differences.push({
        step: label,
        kind: 'status',
        severity: 'error',
        message: `${a.env} returned ${leftStatus ?? 'no response'}, ${b.env} returned ${rightStatus ?? 'no response'}.`,
      });
    }

    const leftShape = shapeFor(left);
    const rightShape = shapeFor(right);
    if (leftShape && rightShape) {
      // Read as "what b would look like against a's contract", so `removed`
      // means b is missing something a returns.
      for (const change of diffShape(leftShape, rightShape)) {
        if (change.severity === 'info') continue;
        differs = true;
        differences.push({
          step: label,
          kind: 'shape',
          severity: change.severity,
          message:
            change.kind === 'removed'
              ? `${change.path} comes back on ${a.env} but not on ${b.env}.`
              : change.kind === 'type-changed'
                ? `${change.path} is ${change.was} on ${a.env} and ${change.now} on ${b.env}.`
                : `${change.path} is inconsistent between ${a.env} and ${b.env}.`,
        });
      }
      // Additions are a real finding here even though they are noise against a
      // recorded baseline: a field only one environment returns usually means
      // the two are running different builds.
      for (const change of diffShape(rightShape, leftShape)) {
        if (change.kind !== 'removed') continue;
        differs = true;
        differences.push({
          step: label,
          kind: 'shape',
          severity: 'warn',
          message: `${change.path} comes back on ${b.env} but not on ${a.env}.`,
        });
      }
    }

    const leftMs = left.response?.durationMs;
    const rightMs = right.response?.durationMs;
    if (leftMs !== undefined && rightMs !== undefined) {
      const slow = Math.max(leftMs, rightMs);
      const fast = Math.min(leftMs, rightMs);
      if (slow - fast >= SLOWER_THAN_MS && slow >= fast * SLOWER_BY) {
        differs = true;
        differences.push({
          step: label,
          kind: 'timing',
          severity: 'warn',
          message: `${leftMs > rightMs ? a.env : b.env} is ${(slow / Math.max(fast, 1)).toFixed(1)}× slower here (${leftMs}ms vs ${rightMs}ms).`,
        });
      }
    }

    if (!differs) same += 1;
  }

  return {journey: journey.name, a: a.env, b: b.env, differences, same};
}

export function summariseComparison(comparison: Comparison): string {
  const {differences, same} = comparison;
  const lines: string[] = [];
  const breaks = differences.filter((d) => d.severity === 'error').length;

  lines.push(
    `${breaks ? '✗' : differences.length ? '~' : '✓'} ${comparison.journey} · ${comparison.a} vs ${comparison.b} — ` +
      `${differences.length ? `${differences.length} difference${differences.length === 1 ? '' : 's'}` : 'identical'}` +
      `${same ? `, ${same} step${same === 1 ? '' : 's'} agreed` : ''}`,
  );

  let current = '';
  for (const difference of differences) {
    if (difference.step !== current) {
      lines.push(`  ${difference.step}`);
      current = difference.step;
    }
    lines.push(`    ${difference.severity === 'error' ? '✗' : '~'} ${difference.message}`);
  }

  return lines.join('\n');
}
