import {describe, expect, it} from 'vitest';
import {runJourney} from '../src/core/engine';
import {buildJourneyReport} from '../src/core/report';
import type {Journey, JourneyNode, NodeDef} from '../src/core/types';

const DEF: NodeDef = {
  type: 'demo.post',
  label: 'Charge the card',
  fields: [],
  request: {method: 'POST', path: '/charge'},
  needs: [],
  gives: [],
  assertions: [],
};

const journeyOf = (over: Partial<JourneyNode> = {}): Journey => ({
  name: 'Race',
  nodes: [{id: 'n1', type: 'demo.post', config: {}, position: {x: 0, y: 0}, ...over}],
  edges: [],
});

/** An endpoint with a working idempotency guard: only the first charge lands. */
function guarded() {
  let charged = false;
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    maxInFlight: () => maxInFlight,
    transport: {
      async send() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        const first = !charged;
        charged = true;
        inFlight -= 1;
        return first
          ? {status: 201, headers: {}, body: {id: 'chg_1'}, durationMs: 5}
          : {status: 409, headers: {}, body: {error: 'already charged'}, durationMs: 5};
      },
    },
  };
}

/** The same endpoint without the guard: every request charges the card again. */
function unguarded() {
  let n = 0;
  return {
    transport: {
      async send() {
        // Captured before the await: reading `n` afterwards would give every
        // request the final value, and the fixture would claim the endpoint
        // deduplicated when it did no such thing.
        const mine = ++n;
        await new Promise((r) => setTimeout(r, 5));
        return {status: 201, headers: {}, body: {id: `chg_${mine}`}, durationMs: 5};
      },
    },
  };
}

describe('firing a burst of identical requests', () => {
  it('sends them at the same time, not one after another', async () => {
    // If they serialise, there is no race and the test proves nothing.
    const api = guarded();
    await runJourney(journeyOf({concurrency: 5}), {env: 'test', lookup: () => DEF, transport: api.transport});
    expect(api.maxInFlight()).toBe(5);
  });

  it('catches a missing idempotency guard', async () => {
    // The bug this exists for: five simultaneous charges, five different ids,
    // five rows in the ledger. Invisible to a runner that sends one at a time.
    const result = await runJourney(journeyOf({concurrency: 5}), {
      env: 'test',
      lookup: () => DEF,
      transport: unguarded().transport,
    });

    const burst = result.states.n1.response?.concurrent;
    expect(burst).toMatchObject({sent: 5, succeeded: 5, failed: 0, distinct: 5});
  });

  it('shows a working guard as one success and one body', async () => {
    const result = await runJourney(journeyOf({concurrency: 5}), {
      env: 'test',
      lookup: () => DEF,
      transport: guarded().transport,
    });

    const burst = result.states.n1.response?.concurrent;
    expect(burst).toMatchObject({sent: 5, succeeded: 1, failed: 4});
    expect(burst!.statuses.filter((s) => s === 201)).toHaveLength(1);
  });

  it('asserts on the burst without any new assertion machinery', async () => {
    // `concurrent.succeeded` rides on the response, so the existing ops work.
    const result = await runJourney(
      journeyOf({concurrency: 5, assertions: [{path: 'concurrent.succeeded', op: 'eq', expected: 1}]}),
      {env: 'test', lookup: () => DEF, transport: unguarded().transport},
    );

    expect(result.passed).toBe(false);
    expect(result.states.n1.error).toContain('concurrent.succeeded');
  });

  it('passes that same assertion against an endpoint that guards properly', async () => {
    const result = await runJourney(
      journeyOf({concurrency: 5, assertions: [{path: 'concurrent.succeeded', op: 'eq', expected: 1}]}),
      {env: 'test', lookup: () => DEF, transport: guarded().transport},
    );
    expect(result.passed).toBe(true);
  });

  it('hands the first success downstream, so chaining is unaffected', async () => {
    const gives: NodeDef = {...DEF, gives: [{key: 'chargeId', from: 'body.id'}]};
    const result = await runJourney(journeyOf({concurrency: 5}), {
      env: 'test',
      lookup: () => gives,
      transport: guarded().transport,
    });

    // Not the 409 that happened to settle first.
    expect(result.states.n1.response?.status).toBe(201);
    expect(result.context.vars.chargeId).toBe('chg_1');
  });

  it('counts a transport failure as a result rather than losing it', async () => {
    // A burst that half-crashed must not read as a burst that half-succeeded.
    let n = 0;
    const transport = {
      async send() {
        n += 1;
        if (n % 2 === 0) throw new Error('socket hang up');
        return {status: 201, headers: {}, body: {id: n}, durationMs: 1};
      },
    };

    const result = await runJourney(journeyOf({concurrency: 4}), {env: 'test', lookup: () => DEF, transport});
    const burst = result.states.n1.response?.concurrent;
    expect(burst).toMatchObject({sent: 4, succeeded: 2, failed: 2});
    expect(burst!.statuses.filter((s) => s === 0)).toHaveLength(2);
  });

  it('behaves exactly as before when concurrency is one or unset', async () => {
    const result = await runJourney(journeyOf(), {env: 'test', lookup: () => DEF, transport: guarded().transport});
    expect(result.states.n1.response?.concurrent).toBeUndefined();
    expect(result.states.n1.response?.status).toBe(201);
  });

  it('carries the burst into the report', async () => {
    const journey = journeyOf({concurrency: 3});
    const result = await runJourney(journey, {env: 'test', lookup: () => DEF, transport: unguarded().transport});
    const report = buildJourneyReport(journey, result.states, result.context, () => DEF);

    expect(report.steps[0].concurrent).toMatchObject({sent: 3, distinct: 3});
  });
});

describe('the raw HTTP node behaves the same everywhere', () => {
  it('gives each raw step its own method and body', async () => {
    // The studio used to look this up by type, so a journey with two raw HTTP
    // steps sent the first one's request twice; the CLI did not materialise at
    // all, so a saved journey ran as GET in CI and POST in the browser.
    const {withMaterialised} = await import('../src/core/builtins');
    const {BUILTINS, HTTP_REQUEST} = await import('../src/core/builtins');
    const registry = (type: string) => (type === 'http.request' ? HTTP_REQUEST : BUILTINS[0]);
    const lookup = withMaterialised(registry);

    const sent: {method: string; url: string}[] = [];
    const transport = {
      async send(request: {method: string; url: string}) {
        sent.push({method: request.method, url: request.url});
        return {status: 200, headers: {}, body: {}, durationMs: 1};
      },
    };

    const two: Journey = {
      name: 'Two raw steps',
      nodes: [
        {id: 'a', type: 'http.request', config: {method: 'POST', path: '/charge'}, position: {x: 0, y: 0}},
        {id: 'b', type: 'http.request', config: {method: 'DELETE', path: '/charge/1'}, position: {x: 1, y: 0}},
      ],
      edges: [{id: 'e', source: 'a', target: 'b'}],
    };

    await runJourney(two, {env: 'test', lookup, transport});
    expect(sent).toEqual([
      {method: 'POST', url: '/charge'},
      {method: 'DELETE', url: '/charge/1'},
    ]);
  });
});
