import {describe, expect, it} from 'vitest';
import {buildJourneyReport, buildReport, findFlakes, summariseText, type QaReport} from '../src/core/report';
import {formatReport, sendToSlack} from '../src/core/slack';
import {packJourney, readSaved, fileNameFor} from '../src/core/persist';
import type {Journey, NodeDef, NodeState, RunContext} from '../src/core/types';

const DEFS: Record<string, NodeDef> = {
  'demo.create': {
    type: 'demo.create',
    label: 'Create user',
    fields: [],
    request: {method: 'POST', path: '/users'},
    needs: [],
    gives: [{key: 'userId', from: 'body.id'}],
  },
  'demo.read': {
    type: 'demo.read',
    label: 'Read user',
    fields: [],
    request: {method: 'GET', path: '/users/{{vars.userId}}'},
    needs: ['userId'],
    gives: [],
  },
};
const lookup = (t: string) => DEFS[t];

const journey: Journey = {
  name: 'Signup',
  nodes: [
    {id: 'n1', type: 'demo.create', config: {}, position: {x: 0, y: 0}},
    {id: 'n2', type: 'demo.read', config: {}, position: {x: 250, y: 0}},
  ],
  edges: [{id: 'e1', source: 'n1', target: 'n2'}],
};

const context: RunContext = {
  env: 'staging',
  vars: {userId: 'u_1'},
  responses: {},
  secretNames: [],
  runId: 'r1',
};

const passing: Record<string, NodeState> = {
  n1: {status: 'passed', durationMs: 120, response: {status: 201, headers: {}, body: {id: 'u_1'}, durationMs: 120}},
  n2: {status: 'passed', durationMs: 80, response: {status: 200, headers: {}, body: {id: 'u_1'}, durationMs: 80}},
};

const failing: Record<string, NodeState> = {
  n1: passing.n1,
  n2: {
    status: 'failed',
    durationMs: 60,
    error: 'status expected status 200, got 404',
    sent: {method: 'GET', url: '/users/u_1', headers: {}},
    response: {status: 404, headers: {}, body: {message: 'not found', email: 'leak@example.com'}, durationMs: 60},
    assertions: [{assertion: {op: 'status', expected: 200}, pass: false, actual: 404}],
  },
};

describe('building a journey report', () => {
  it('records each step in run order with its timing', () => {
    const report = buildJourneyReport(journey, passing, context, lookup);
    expect(report.status).toBe('passed');
    expect(report.steps.map((s) => s.label)).toEqual(['Create user', 'Read user']);
    expect(report.durationMs).toBe(200);
  });

  it('lists what the run created, which is what a shared environment needs to know', () => {
    const report = buildJourneyReport(journey, passing, context, lookup);
    expect(report.created).toEqual([{key: 'userId', value: 'u_1'}]);
  });

  it('keeps the request that failed so the failure is reproducible', () => {
    const report = buildJourneyReport(journey, failing, context, lookup);
    expect(report.status).toBe('failed');
    expect(report.steps[1].request).toEqual({method: 'GET', url: '/users/u_1'});
    expect(report.steps[1].failedAssertions).toEqual(['status']);
  });

  it('leaves response bodies out unless asked', () => {
    // Bodies routinely hold PII and tokens; a report gets pasted into channels.
    const quiet = buildJourneyReport(journey, failing, context, lookup);
    expect(JSON.stringify(quiet)).not.toContain('leak@example.com');

    const loud = buildJourneyReport(journey, failing, context, lookup, {includeBodies: true});
    expect(loud.steps[1].responseBody).toMatchObject({message: 'not found'});
  });

  it('counts contract breaks separately from failures', () => {
    // A step can pass every assertion and still have stopped matching its spec.
    const drifted: Record<string, NodeState> = {
      ...passing,
      n2: {
        ...passing.n2,
        contract: [
          {kind: 'missing-required', path: 'name', severity: 'error', message: 'name is required by the spec but was not returned'},
          {kind: 'undocumented-field', path: 'nickname', severity: 'warn', message: 'undocumented'},
        ],
      },
    };
    const report = buildJourneyReport(journey, drifted, context, lookup);
    expect(report.status).toBe('passed');
    expect(report.contractBreaks).toBe(1);
  });
});

describe('the suite report', () => {
  const build = (states: Record<string, NodeState>[]) =>
    buildReport(
      'staging',
      states.map((s, i) => buildJourneyReport({...journey, name: `Journey ${i + 1}`}, s, context, lookup)),
      {startedAt: '2026-01-01T00:00:00.000Z', durationMs: 4200, baseUrl: 'https://api.test'},
    );

  it('totals up and fails if any journey failed', () => {
    const report = build([passing, failing]);
    expect(report.status).toBe('failed');
    expect(report.totals).toMatchObject({journeys: 2, passed: 1, failed: 1, steps: 4});
  });

  it('passes when everything passed', () => {
    expect(build([passing, passing]).status).toBe('passed');
  });

  it('summarises for a terminal', () => {
    const text = summariseText(build([passing, failing]));
    expect(text).toContain('FAIL · 1/2 journeys');
    expect(text).toContain('status expected status 200, got 404');
    expect(text).toContain('sent: GET /users/u_1');
    expect(text).toContain('created: userId=u_1');
  });
});

describe('flake detection', () => {
  const attempt = (states: Record<string, NodeState>): QaReport =>
    buildReport('staging', [buildJourneyReport(journey, states, context, lookup)], {
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 100,
    });

  it('names a step that could not make up its mind', () => {
    // A step that fails one run in five teaches the team to ignore red, which is
    // worse than one that always fails.
    const flakes = findFlakes([attempt(passing), attempt(failing), attempt(passing)]);
    expect(flakes).toEqual([{journey: 'Signup', step: 'Read user', passed: 2, of: 3}]);
  });

  it('says nothing about a step that always passes or always fails', () => {
    expect(findFlakes([attempt(passing), attempt(passing)])).toEqual([]);
    expect(findFlakes([attempt(failing), attempt(failing)])).toEqual([]);
  });

  it('needs more than one attempt to have an opinion', () => {
    expect(findFlakes([attempt(passing)])).toEqual([]);
  });
});

describe('formatting for Slack', () => {
  const report = buildReport('staging', [buildJourneyReport(journey, failing, context, lookup)], {
    startedAt: '2026-01-01T09:00:00.000Z',
    durationMs: 3200,
    baseUrl: 'https://api.test',
  });

  it('leads with the verdict, in the notification text too', () => {
    const message = formatReport(report);
    expect(message.text).toContain('1 of 1 failing');
    expect(message.blocks[0]).toMatchObject({type: 'header'});
  });

  it('carries the failing step and how to reproduce it', () => {
    const text = JSON.stringify(formatReport(report));
    expect(text).toContain('Read user');
    expect(text).toContain('GET /users/u_1');
  });

  it('never posts a response body to a channel', () => {
    const withBodies = buildReport(
      'staging',
      [buildJourneyReport(journey, failing, context, lookup, {includeBodies: true})],
      {startedAt: '2026-01-01T09:00:00.000Z', durationMs: 10},
    );
    expect(JSON.stringify(formatReport(withBodies))).not.toContain('leak@example.com');
  });

  it('reports contract drift even when nothing failed', () => {
    const drifted = buildReport(
      'staging',
      [
        {
          ...buildJourneyReport(journey, passing, context, lookup),
          contractBreaks: 3,
        },
      ],
      {startedAt: '2026-01-01T09:00:00.000Z', durationMs: 10},
    );
    const text = JSON.stringify(formatReport(drifted));
    expect(text).toContain('3 responses no longer match the spec');
  });

  it('stays inside Slack’s block budget for a big suite', () => {
    const many = buildReport(
      'staging',
      Array.from({length: 60}, (_, i) =>
        buildJourneyReport({...journey, name: `J${i}`}, failing, context, lookup),
      ),
      {startedAt: '2026-01-01T09:00:00.000Z', durationMs: 10},
    );
    const message = formatReport(many);
    expect(message.blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(message)).toContain('more failing journeys');
  });

  it('escapes the characters Slack treats as markup', () => {
    const risky = buildReport(
      'staging',
      [buildJourneyReport({...journey, name: '<script> & "quotes"'}, failing, context, lookup)],
      {startedAt: '2026-01-01T09:00:00.000Z', durationMs: 10},
    );
    expect(JSON.stringify(formatReport(risky))).toContain('&lt;script&gt; &amp;');
  });
});

describe('sending to Slack', () => {
  it('refuses a URL that is not a Slack webhook', async () => {
    // The webhook URL is the credential; posting a report somewhere else would
    // hand it to whoever owns that host.
    const result = await sendToSlack('https://example.com/hook', {text: 'x', blocks: []});
    expect(result).toEqual({ok: false, error: 'That does not look like a Slack incoming webhook URL.'});
  });
});

describe('saving and loading a journey', () => {
  it('carries the definitions it uses, so it runs with no document loaded', () => {
    // Otherwise a saved journey opens in CI as a canvas full of unknown types.
    const saved = packJourney(journey, lookup, {env: 'staging'});
    expect(saved.defs.map((d) => d.type).sort()).toEqual(['demo.create', 'demo.read']);

    const loaded = readSaved(JSON.stringify(saved), () => undefined);
    expect(loaded.ok).toBe(true);
    expect(loaded.missingTypes).toEqual([]);
    expect(loaded.saved!.journey.nodes).toHaveLength(2);
  });

  it('names the types it could not resolve at all', () => {
    const saved = packJourney(journey, () => undefined);
    const loaded = readSaved(JSON.stringify(saved), () => undefined);
    expect(loaded.missingTypes.sort()).toEqual(['demo.create', 'demo.read']);
  });

  it('refuses a file from a newer version rather than mangling it', () => {
    const saved = {...packJourney(journey, lookup), version: 99};
    expect(readSaved(JSON.stringify(saved), lookup).error).toContain('newer version');
  });

  it('explains a file that is not a journey', () => {
    expect(readSaved('{"hello":true}', lookup).error).toContain('does not contain a journey');
    expect(readSaved('nope', lookup).error).toContain('Not valid JSON');
  });

  it('makes a file name that is safe and readable', () => {
    expect(fileNameFor('Sign up & pay!')).toBe('sign-up-pay.journey.json');
    expect(fileNameFor('')).toBe('journey.journey.json');
  });
});
