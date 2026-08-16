import {describe, expect, it} from 'vitest';
import {runJourney} from '../src/core/engine';
import type {Assertion, Journey, JourneyNode, NodeDef} from '../src/core/types';

const DEF: NodeDef = {
  type: 'demo.get',
  label: 'Read the order',
  fields: [],
  request: {method: 'GET', path: '/order'},
  needs: [],
  gives: [],
  assertions: [{op: 'status', expected: 200}],
};

function node(over: Partial<JourneyNode> = {}): JourneyNode {
  return {id: 'n1', type: 'demo.get', config: {}, position: {x: 0, y: 0}, ...over};
}

function journeyOf(over: Partial<JourneyNode> = {}): Journey {
  return {name: 'Poll', nodes: [node(over)], edges: []};
}

/** Answers `pending` a few times, then `settled`. */
function settlesAfter(n: number) {
  let calls = 0;
  return {
    calls: () => calls,
    transport: {
      async send() {
        calls += 1;
        return {
          status: 200,
          headers: {},
          body: {status: calls > n ? 'settled' : 'pending'},
          durationMs: 1,
        };
      },
    },
  };
}

const SETTLED: Assertion[] = [{path: 'body.status', op: 'eq', expected: 'settled'}];

describe('waiting for a condition instead of sleeping', () => {
  it('sends once when the condition already holds', async () => {
    const api = settlesAfter(0);
    const result = await runJourney(journeyOf({until: SETTLED, pollEveryMs: 50}), {
      env: 'test',
      lookup: () => DEF,
      transport: api.transport,
    });

    expect(result.passed).toBe(true);
    expect(api.calls()).toBe(1);
    // Nothing to report when it did not have to wait.
    expect(result.states.n1.attempts).toBeUndefined();
  });

  it('keeps asking until it holds, and says how many tries it took', async () => {
    const api = settlesAfter(2);
    const result = await runJourney(journeyOf({until: SETTLED, pollEveryMs: 10, pollTimeoutMs: 2000}), {
      env: 'test',
      lookup: () => DEF,
      transport: api.transport,
    });

    expect(result.passed).toBe(true);
    expect(api.calls()).toBe(3);
    expect(result.states.n1.attempts).toBe(3);
    expect(result.states.n1.response?.body).toMatchObject({status: 'settled'});
  });

  it('gives up at the deadline and says what it was still waiting for', async () => {
    const api = settlesAfter(999);
    const result = await runJourney(journeyOf({until: SETTLED, pollEveryMs: 10, pollTimeoutMs: 60}), {
      env: 'test',
      lookup: () => DEF,
      transport: api.transport,
    });

    expect(result.passed).toBe(false);
    expect(result.states.n1.error).toContain('body.status');
    // The count is the useful part: "still pending after 5 tries" is a different
    // conversation from "failed once".
    expect(result.states.n1.error).toContain('attempts');
    expect(api.calls()).toBeGreaterThan(1);
  });

  it('does not retry a step that declared no condition', async () => {
    // Ordinary steps must keep failing fast; retrying everything would turn one
    // broken endpoint into a suite that takes an hour to tell you so.
    const api = settlesAfter(999);
    const result = await runJourney(journeyOf(), {env: 'test', lookup: () => DEF, transport: api.transport});

    expect(result.passed).toBe(true);
    expect(api.calls()).toBe(1);
  });

  it('retries a hard failure too, because "not ready yet" often arrives as a 404', async () => {
    let calls = 0;
    const transport = {
      async send() {
        calls += 1;
        return {status: calls > 2 ? 200 : 404, headers: {}, body: {status: 'settled'}, durationMs: 1};
      },
    };

    const result = await runJourney(journeyOf({until: SETTLED, pollEveryMs: 10, pollTimeoutMs: 2000}), {
      env: 'test',
      lookup: () => DEF,
      transport,
    });

    expect(result.passed).toBe(true);
    expect(calls).toBe(3);
  });

  it('stops polling when the run is stopped', async () => {
    const controller = new AbortController();
    let calls = 0;
    const transport = {
      async send() {
        calls += 1;
        if (calls === 2) controller.abort();
        return {status: 200, headers: {}, body: {status: 'pending'}, durationMs: 1};
      },
    };

    await runJourney(journeyOf({until: SETTLED, pollEveryMs: 10, pollTimeoutMs: 5000}), {
      env: 'test',
      lookup: () => DEF,
      transport,
      signal: controller.signal,
    });
    expect(calls).toBe(2);
  });

  it('checks the step’s own extra assertions as well as its type’s', async () => {
    const api = settlesAfter(0);
    const result = await runJourney(
      journeyOf({assertions: [{path: 'body.status', op: 'eq', expected: 'never'}]}),
      {env: 'test', lookup: () => DEF, transport: api.transport},
    );

    expect(result.passed).toBe(false);
    expect(result.states.n1.error).toContain('body.status');
  });

  it('does not wait past the deadline before the last attempt', async () => {
    // A 10s interval with a 1s budget should not sleep 10s to find that out.
    const started = Date.now();
    const api = settlesAfter(999);
    await runJourney(journeyOf({until: SETTLED, pollEveryMs: 10_000, pollTimeoutMs: 100}), {
      env: 'test',
      lookup: () => DEF,
      transport: api.transport,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(api.calls()).toBe(1);
  });
});
