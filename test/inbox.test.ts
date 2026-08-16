import {describe, expect, it} from 'vitest';
import {HookInbox, asResponse, hookMatches, mockFromHook, readHook, type ReceivedHook} from '../src/core/inbox';
import {runJourney} from '../src/core/engine';
import {AWAIT_WEBHOOK} from '../src/core/builtins';
import {checkJourney} from '../src/core/graph';
import type {Journey, NodeDef} from '../src/core/types';

const hook = (over: Partial<ReceivedHook> = {}): ReceivedHook => ({
  id: 'h1',
  at: '2026-01-01T00:00:00.000Z',
  method: 'POST',
  path: 'payments',
  headers: {'content-type': 'application/json'},
  query: {},
  body: {reference: 'pay_1', status: 'settled'},
  ...over,
});

describe('reading a delivery', () => {
  it('reaches into the body, headers, query and path', () => {
    const h = hook({query: {sig: 'abc'}});
    expect(readHook(h, 'body.status')).toBe('settled');
    expect(readHook(h, 'headers.content-type')).toBe('application/json');
    expect(readHook(h, 'query.sig')).toBe('abc');
    expect(readHook(h, 'path')).toBe('payments');
  });

  it('gives undefined rather than throwing on a path that is not there', () => {
    expect(readHook(hook(), 'body.nope.deeper')).toBeUndefined();
  });

  it('is an HttpResponse, which is what makes everything else work on it', () => {
    // The whole design rests on this: stored as a response, a webhook works with
    // templating, gives, assertions and contract checking with no special cases.
    expect(asResponse(hook())).toMatchObject({status: 200, body: {reference: 'pay_1'}});
  });
});

describe('deciding which delivery belongs to a step', () => {
  it('matches on the path', () => {
    expect(hookMatches(hook(), {path: 'payments'})).toBe(true);
    expect(hookMatches(hook(), {path: 'refunds'})).toBe(false);
  });

  it('takes anything on the path when no correlation is configured', () => {
    expect(hookMatches(hook(), {})).toBe(true);
  });

  it('matches on a correlation value', () => {
    expect(hookMatches(hook(), {correlateOn: 'body.reference', equals: 'pay_1'})).toBe(true);
    expect(hookMatches(hook(), {correlateOn: 'body.reference', equals: 'pay_2'})).toBe(false);
  });

  it('compares as text, because a number leaves and a string comes back', () => {
    const numeric = hook({body: {reference: 1234}});
    expect(hookMatches(numeric, {correlateOn: 'body.reference', equals: '1234'})).toBe(true);
  });

  it('does not match when the correlation field is absent', () => {
    expect(hookMatches(hook({body: {}}), {correlateOn: 'body.reference', equals: 'pay_1'})).toBe(false);
  });
});

describe('the inbox', () => {
  const since = '2026-01-01T00:00:00.000Z';

  it('hands a delivery to one claimant only', () => {
    // Two steps waiting on the same path must not both take the same callback.
    const box = new HookInbox();
    box.receive({method: 'POST', path: 'payments', headers: {}, query: {}, body: {}, at: since});

    expect(box.claim({path: 'payments'}, {since, by: 'n1'})).toBeDefined();
    expect(box.claim({path: 'payments'}, {since, by: 'n2'})).toBeUndefined();
  });

  it('still serves a delivery that arrived before the step started waiting', () => {
    // The race goes the unhelpful way in practice: a fast provider calls back
    // before the journey reaches the step that waits. Watching only for new
    // arrivals would fail on exactly the integrations that work best.
    const box = new HookInbox();
    box.receive({method: 'POST', path: 'payments', headers: {}, query: {}, body: {n: 1}, at: since});
    expect(box.claim({path: 'payments'}, {since, by: 'n1'})).toMatchObject({body: {n: 1}});
  });

  it('ignores deliveries older than the run', () => {
    // Otherwise a run happily claims last night's callback and goes green.
    const box = new HookInbox();
    box.receive({method: 'POST', path: 'payments', headers: {}, query: {}, body: {}, at: '2025-01-01T00:00:00.000Z'});
    expect(box.claim({path: 'payments'}, {since, by: 'n1'})).toBeUndefined();
  });

  it('gives each correlated claimant its own delivery', () => {
    const box = new HookInbox();
    box.receive({method: 'POST', path: 'p', headers: {}, query: {}, body: {ref: 'a'}, at: since});
    box.receive({method: 'POST', path: 'p', headers: {}, query: {}, body: {ref: 'b'}, at: since});

    const first = box.claim({correlateOn: 'body.ref', equals: 'b'}, {since, by: 'n1'});
    const second = box.claim({correlateOn: 'body.ref', equals: 'a'}, {since, by: 'n2'});
    expect(first).toMatchObject({body: {ref: 'b'}});
    expect(second).toMatchObject({body: {ref: 'a'}});
  });

  it('describes what arrived but did not match, for the timeout message', () => {
    const box = new HookInbox();
    box.receive({method: 'POST', path: 'p', headers: {}, query: {}, body: {ref: 'other'}, at: since});
    expect(box.describeUnmatched(since)[0]).toContain('POST /p');
    expect(box.describeUnmatched(since)[0]).toContain('other');
  });

  it('does not grow without bound', () => {
    const box = new HookInbox();
    for (let i = 0; i < 500; i++) {
      box.receive({method: 'POST', path: 'p', headers: {}, query: {}, body: {i}, at: since});
    }
    expect(box.size).toBeLessThanOrEqual(200);
  });

  it('drops the delivery headers when turning one into a mock', () => {
    // A signature header describes the original request, not the payload, and
    // replaying it would be misleading at best.
    const mock = mockFromHook(hook({headers: {'x-signature': 'abc'}}), 'settled');
    expect(mock).toMatchObject({name: 'settled', path: 'payments'});
    expect(mock.headers).toBeUndefined();
  });
});

// A journey of one step that waits for a callback.
const journey: Journey = {
  name: 'Wait for a callback',
  nodes: [
    {
      id: 'n1',
      type: 'control.webhook',
      config: {
        path: 'payments',
        correlateOn: 'body.reference',
        equals: '{{vars.paymentRef}}',
        capture: {settlementStatus: 'body.status'},
        timeoutMs: 300,
      },
      position: {x: 0, y: 0},
    },
  ],
  edges: [],
};

const lookup = (): NodeDef => AWAIT_WEBHOOK;
const transport = {async send() { return {status: 200, headers: {}, body: {}, durationMs: 1}; }};

describe('a step that waits for a webhook', () => {
  it('claims the delivery correlated to this run and captures from it', async () => {
    const box = new HookInbox();

    // Started first, then delivered. `runJourney` stamps the run's start time
    // synchronously before its first await, so this lands after it — which is
    // the point: a delivery from before the run began belongs to a previous one.
    const running = runJourney(journey, {
      env: 'test',
      lookup,
      transport,
      seed: {paymentRef: 'pay_9'},
      inbox: {async claim(m, o) { return box.claim(m, o); }},
    });
    box.receive({method: 'POST', path: 'payments', headers: {}, query: {}, body: {reference: 'other', status: 'failed'}});
    box.receive({method: 'POST', path: 'payments', headers: {}, query: {}, body: {reference: 'pay_9', status: 'settled'}});
    const result = await running;

    expect(result.passed).toBe(true);
    // Captured into the context, and available as a response like any other step.
    expect(result.context.vars.settlementStatus).toBe('settled');
    expect(result.context.responses.n1.body).toMatchObject({reference: 'pay_9'});
  });

  it('fails with what did arrive when nothing matches', async () => {
    const box = new HookInbox();
    const running = runJourney(journey, {
      env: 'test',
      lookup,
      transport,
      seed: {paymentRef: 'pay_9'},
      inbox: {
        async claim(m, o) { return box.claim(m, o); },
        async describeUnmatched(since) { return box.describeUnmatched(since); },
      },
    });
    box.receive({method: 'POST', path: 'payments', headers: {}, query: {}, body: {reference: 'someone-else'}});
    const result = await running;

    expect(result.passed).toBe(false);
    // "It called with a reference you are not matching on" is a different
    // problem from "it never called", and the message has to tell them apart.
    expect(result.states.n1.error).toContain('body.reference');
    expect(result.states.n1.error).toContain('someone-else');
  });

  it('fails honestly when a mock exists but the run did not ask for mocks', async () => {
    // The failure mode that matters most: a canned payload must never quietly
    // satisfy a webhook the integration failed to send.
    const box = new HookInbox();
    const result = await runJourney(journey, {
      env: 'test',
      lookup,
      transport,
      seed: {paymentRef: 'pay_9'},
      inbox: {async claim(m, o) { return box.claim(m, o); }},
    });

    expect(result.passed).toBe(false);
    expect(result.states.n1.mocked).toBeUndefined();
  });

  it('delivers from a mock when the run asks, and marks the step as mocked', async () => {
    const result = await runJourney(journey, {
      env: 'test',
      lookup,
      transport,
      seed: {paymentRef: 'pay_9'},
      mocks: {
        settled: {name: 'settled', path: 'payments', body: {reference: '{{vars.paymentRef}}', status: 'settled'}},
      },
    });

    expect(result.passed).toBe(true);
    expect(result.states.n1.mocked).toBe(true);
    // The mock echoed this run's own reference rather than a hard-coded one.
    expect(result.context.responses.n1.body).toMatchObject({reference: 'pay_9'});
    expect(result.context.vars.settlementStatus).toBe('settled');
  });

  it('marks a delivery that was fired by hand, even though the step really waited', async () => {
    // Firing a mock into the inbox during development is a real delivery as far
    // as the step is concerned — but the payload was still canned, and the
    // report must not let that read as a working integration.
    const box = new HookInbox();
    const running = runJourney(journey, {
      env: 'test',
      lookup,
      transport,
      seed: {paymentRef: 'pay_9'},
      inbox: {async claim(m, o) { return box.claim(m, o); }},
    });
    box.receive({
      method: 'POST',
      path: 'payments',
      headers: {'x-journey-studio-mock': 'settled'},
      query: {},
      body: {reference: 'pay_9', status: 'settled'},
    });
    const result = await running;

    expect(result.passed).toBe(true);
    expect(result.states.n1.mocked).toBe(true);
  });

  it('says so when the named mock does not exist', async () => {
    const named: Journey = {
      ...journey,
      nodes: [{...journey.nodes[0], config: {...journey.nodes[0].config, mock: 'nope'}}],
    };
    const result = await runJourney(named, {env: 'test', lookup, transport, mocks: {}});
    expect(result.states.n1.error).toContain('No saved webhook called "nope"');
  });

  it('counts captured keys as context the next step can need', async () => {
    // Without this the pre-run check would flag a perfectly good journey for
    // needing something the webhook step plainly provides.
    const consumer: NodeDef = {
      type: 'demo.uses-it',
      label: 'Uses the status',
      fields: [],
      request: {method: 'GET', path: '/x/{{vars.settlementStatus}}'},
      needs: ['settlementStatus'],
      gives: [],
    };
    const two: Journey = {
      ...journey,
      nodes: [journey.nodes[0], {id: 'n2', type: 'demo.uses-it', config: {}, position: {x: 1, y: 0}}],
      edges: [{id: 'e1', source: 'n1', target: 'n2'}],
    };
    const withTypes = (t: string) => (t === 'control.webhook' ? AWAIT_WEBHOOK : consumer);

    expect(checkJourney(two, withTypes)).toEqual([]);

    // …and still flags it when the webhook step captures nothing.
    const captureless: Journey = {
      ...two,
      nodes: [{...two.nodes[0], config: {...two.nodes[0].config, capture: {}}}, two.nodes[1]],
    };
    expect(checkJourney(captureless, withTypes)[0]).toMatchObject({nodeId: 'n2', kind: 'missing-context'});
  });
});
