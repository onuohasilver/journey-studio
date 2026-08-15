import {describe, expect, it} from 'vitest';
import {runJourney} from '../src/core/engine';
import {buildJourneyReport, buildReport, findSlowSteps} from '../src/core/report';
import {compareRuns} from '../src/core/compare';
import type {Journey, JourneyNode, NodeDef, NodeState} from '../src/core/types';

const GET: NodeDef = {
  type: 'demo.get',
  label: 'Step',
  fields: [],
  request: {method: 'GET', path: '/thing'},
  needs: [],
  gives: [],
  assertions: [{op: 'status', expected: 200}],
};

const DELETE: NodeDef = {
  ...GET,
  type: 'demo.delete',
  label: 'Delete it',
  request: {method: 'DELETE', path: '/thing'},
};

function node(id: string, type: string, extra: Partial<JourneyNode> = {}): JourneyNode {
  return {id, type, config: {}, position: {x: 0, y: 0}, ...extra};
}

/** Records every URL called, and answers each one however the test says. */
function recorder(answer: (url: string, method: string) => {status: number; body?: unknown}) {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async send(request: {url: string; method: string}) {
        calls.push(`${request.method} ${request.url}`);
        const {status, body} = answer(request.url, request.method);
        return {status, headers: {}, body: body ?? {}, durationMs: 5};
      },
    },
  };
}

const lookup = (type: string) => (type === 'demo.delete' ? DELETE : GET);

describe('cleanup steps', () => {
  const journey: Journey = {
    name: 'Create and clean up',
    nodes: [
      node('s1', 'demo.get'),
      node('s2', 'demo.get'),
      node('s3', 'demo.delete', {teardown: true}),
    ],
    edges: [
      {id: 'e1', source: 's1', target: 's2'},
      {id: 'e2', source: 's2', target: 's3'},
    ],
  };

  it('runs after the journey when everything passed', async () => {
    const {calls, transport} = recorder(() => ({status: 200}));
    const result = await runJourney(journey, {env: 'test', lookup, transport});

    expect(calls).toEqual(['GET /thing', 'GET /thing', 'DELETE /thing']);
    expect(result.passed).toBe(true);
    expect(result.leaked).toEqual([]);
  });

  it('still runs when the journey failed halfway', async () => {
    // The whole point. The failed run is the one that created an account and
    // then fell over before the step that deletes it.
    const {calls, transport} = recorder((_url, method) => ({status: method === 'GET' ? 500 : 200}));
    const result = await runJourney(journey, {env: 'test', lookup, transport});

    expect(result.passed).toBe(false);
    expect(calls).toContain('DELETE /thing');
    expect(result.leaked).toEqual([]);
  });

  it('keeps cleaning up after a cleanup step fails', async () => {
    const two: Journey = {
      ...journey,
      nodes: [...journey.nodes, node('s4', 'demo.delete', {teardown: true, label: 'Delete the other'})],
    };
    const {calls, transport} = recorder((_u, method) => ({status: method === 'DELETE' ? 500 : 200}));
    const result = await runJourney(two, {env: 'test', lookup, transport});

    // Best effort: failing to delete the order must not abandon the account.
    expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(2);
    // Order follows the journey's own topological order, so the assertion does
    // not depend on it.
    expect([...result.leaked].sort()).toEqual(['Delete it', 'Delete the other']);
  });

  it('does not let a failed cleanup turn a passing journey red', async () => {
    // The API under test behaved. Test hygiene did not. Conflating those is how
    // a verdict stops being read.
    const {transport} = recorder((_u, method) => ({status: method === 'DELETE' ? 500 : 200}));
    const result = await runJourney(journey, {env: 'test', lookup, transport});
    const report = buildJourneyReport(journey, result.states, result.context, lookup);

    expect(result.passed).toBe(true);
    expect(report.status).toBe('passed');
    expect(report.leaked).toEqual(['Delete it']);
    expect(buildReport('test', [report], {startedAt: 'x', durationMs: 1}).totals.leaked).toBe(1);
  });

  it('runs cleanup even for a partial "run from here"', async () => {
    const {calls, transport} = recorder(() => ({status: 200}));
    await runJourney(journey, {env: 'test', lookup, transport, startAt: 's2'});
    expect(calls).toContain('DELETE /thing');
  });

  it('is skipped when the run was aborted', async () => {
    // Stop means stop. Firing deletes at an environment after someone hit the
    // stop button is the opposite of what they asked for.
    const controller = new AbortController();
    const {calls, transport} = recorder(() => {
      controller.abort();
      return {status: 200};
    });
    await runJourney(journey, {env: 'test', lookup, transport, signal: controller.signal});
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });
});

describe('timing budgets', () => {
  const slow: NodeDef = {...GET, label: 'Slow step'};
  const journey: Journey = {
    name: 'Budgeted',
    nodes: [node('s1', 'demo.get', {budgetMs: 100})],
    edges: [],
  };

  const runWith = (durationMs: number, strictBudget = false) =>
    runJourney(journey, {
      env: 'test',
      lookup: () => slow,
      strictBudget,
      transport: {async send() { return {status: 200, headers: {}, body: {}, durationMs}; }},
    });

  it('records a breach without failing the step', async () => {
    const result = await runWith(400);
    expect(result.passed).toBe(true);
    expect(result.states.s1.overBudget).toEqual({budgetMs: 100, actualMs: 400});
  });

  it('says nothing when the step was inside its budget', async () => {
    expect((await runWith(20)).states.s1.overBudget).toBeUndefined();
  });

  it('fails the step when asked to be strict', async () => {
    const result = await runWith(400, true);
    expect(result.passed).toBe(false);
    expect(result.states.s1.error).toContain('budget of 100ms');
  });

  it('judges the budget at p95 rather than on one slow sample', async () => {
    // One cold start is not an SLO breach. Failing on it produces exactly the
    // flakiness this tool exists to name.
    const attempt = (durations: number[]) =>
      buildReport('test', [
        {
          name: 'Budgeted',
          status: 'passed' as const,
          durationMs: 0,
          created: [],
          contractBreaks: 0,
          shapeBreaks: 0,
          leaked: [],
          steps: durations.map((durationMs) => ({
            id: 's1',
            label: 'Slow step',
            type: 'demo.get',
            status: 'passed' as const,
            durationMs,
            failedAssertions: [],
            contract: [],
            shapeChanges: [],
            budgetMs: 100,
          })),
        },
      ], {startedAt: 'x', durationMs: 1});

    // Nineteen fast runs and one slow one: p95 is still inside budget.
    const mostlyFast = attempt([...Array.from({length: 19}, () => 20), 900]);
    expect(findSlowSteps([mostlyFast])).toEqual([]);

    // Genuinely slow: p95 is over, and the row carries the evidence.
    const genuinelySlow = attempt(Array.from({length: 20}, () => 400));
    const [row] = findSlowSteps([genuinelySlow]);
    expect(row).toMatchObject({step: 'Slow step', budgetMs: 100, p50: 400, p95: 400, samples: 20});
  });

  it('ignores steps that declared no budget', async () => {
    const report = buildReport('test', [
      {
        name: 'j',
        status: 'passed',
        durationMs: 0,
        created: [],
        contractBreaks: 0,
        shapeBreaks: 0,
        leaked: [],
        steps: [{id: 's1', label: 'x', type: 't', status: 'passed', durationMs: 9000, failedAssertions: [], contract: [], shapeChanges: []}],
      },
    ], {startedAt: 'x', durationMs: 1});
    expect(findSlowSteps([report])).toEqual([]);
  });
});

describe('comparing two environments', () => {
  const journey: Journey = {
    name: 'Read a thing',
    nodes: [node('s1', 'demo.get')],
    edges: [],
  };

  const side = (env: string, state: Partial<NodeState>) => ({
    env,
    states: {s1: {status: 'passed' as const, ...state}} as Record<string, NodeState>,
  });

  const responded = (status: number, body: unknown, durationMs = 10) => ({
    response: {status, headers: {}, body, durationMs},
  });

  it('says nothing when both sides agree on the contract', () => {
    // Values differ between environments by definition — that is what makes them
    // different environments. Only the contract has to match.
    const result = compareRuns(
      journey,
      side('staging', responded(200, {id: 1, name: 'a'})),
      side('prod', responded(200, {id: 99, name: 'z'})),
      lookup,
    );
    expect(result.differences).toEqual([]);
    expect(result.same).toBe(1);
  });

  it('reports a status that differs', () => {
    const result = compareRuns(
      journey,
      side('staging', responded(200, {})),
      side('prod', responded(403, {})),
      lookup,
    );
    expect(result.differences[0]).toMatchObject({kind: 'status', severity: 'error'});
    expect(result.differences[0].message).toContain('403');
  });

  it('reports a field only one environment returns, in both directions', () => {
    const onlyStaging = compareRuns(
      journey,
      side('staging', responded(200, {id: 1, beta: true})),
      side('prod', responded(200, {id: 1})),
      lookup,
    );
    expect(onlyStaging.differences[0].message).toBe('beta comes back on staging but not on prod.');

    const onlyProd = compareRuns(
      journey,
      side('staging', responded(200, {id: 1})),
      side('prod', responded(200, {id: 1, legacy: 'x'})),
      lookup,
    );
    expect(onlyProd.differences[0].message).toBe('legacy comes back on prod but not on staging.');
  });

  it('reports a type that differs between environments', () => {
    const result = compareRuns(
      journey,
      side('staging', responded(200, {id: 1})),
      side('prod', responded(200, {id: '1'})),
      lookup,
    );
    expect(result.differences[0].message).toBe('id is number on staging and string on prod.');
  });

  it('only mentions timing when it is both relatively and absolutely worse', () => {
    // 3ms vs 8ms is 2.6× and means nothing.
    const noise = compareRuns(journey, side('a', responded(200, {}, 3)), side('b', responded(200, {}, 8)), lookup);
    expect(noise.differences).toEqual([]);

    const real = compareRuns(journey, side('a', responded(200, {}, 100)), side('b', responded(200, {}, 2000)), lookup);
    expect(real.differences[0]).toMatchObject({kind: 'timing', severity: 'warn'});
    expect(real.differences[0].message).toContain('20.0× slower');
  });

  it('leads with one side stopping early instead of listing every later step', () => {
    const two: Journey = {
      name: 'Two',
      nodes: [node('s1', 'demo.get'), node('s2', 'demo.get')],
      edges: [{id: 'e1', source: 's1', target: 's2'}],
    };
    const result = compareRuns(
      two,
      {env: 'staging', states: {s1: {status: 'passed', ...responded(200, {})}, s2: {status: 'passed', ...responded(200, {})}}},
      {env: 'prod', states: {s1: {status: 'failed', ...responded(500, {})}}},
      lookup,
    );

    const reached = result.differences.filter((d) => d.kind === 'reached');
    expect(reached).toHaveLength(1);
    expect(reached[0].message).toContain('prod stopped before it');
  });
});
