import {describe, expect, it} from 'vitest';
import {casesFromCsv, casesToCsv, coerce, parseCsv} from '../src/core/csv';
import {runJourneyCases, shapesFrom} from '../src/core/engine';
import type {Journey, NodeDef} from '../src/core/types';

describe('reading a spreadsheet', () => {
  it('turns a header row and rows into cases', () => {
    const {cases, columns} = casesFromCsv('country,amount\nNG,1000\nGH,250\n');
    expect(columns).toEqual(['country', 'amount']);
    expect(cases).toEqual([
      {name: 'row 1', vars: {country: 'NG', amount: 1000}},
      {name: 'row 2', vars: {country: 'GH', amount: 250}},
    ]);
  });

  it('uses a name column for the case name rather than as a variable', () => {
    const {cases} = casesFromCsv('name,country\nnigeria,NG\n');
    expect(cases[0]).toEqual({name: 'nigeria', vars: {country: 'NG'}});
  });

  it('handles quoted fields with commas, quotes and newlines in them', () => {
    const rows = parseCsv('a,b\n"one, two","he said ""hi"""\n"multi\nline",x\n');
    expect(rows[1]).toEqual(['one, two', 'he said "hi"']);
    expect(rows[2]).toEqual(['multi\nline', 'x']);
  });

  it('gives numbers and booleans their type back', () => {
    // `{{vars.amount}}` alone in a JSON body keeps the variable's type, so a
    // column of amounts has to arrive as numbers.
    expect(coerce('1000')).toBe(1000);
    expect(coerce('1.5')).toBe(1.5);
    expect(coerce('true')).toBe(true);
    expect(coerce('null')).toBeNull();
  });

  it('leaves anything that would not survive the round trip as a string', () => {
    // Account numbers, phone numbers and prices are all destroyed by being
    // helpful here.
    expect(coerce('007')).toBe('007');
    expect(coerce('+2348012345678')).toBe('+2348012345678');
    expect(coerce('1.50')).toBe('1.50');
    expect(coerce('1e3')).toBe('1e3');
  });

  it('keeps duplicate case names apart and says so', () => {
    const {cases, warnings} = casesFromCsv('name,x\ndup,1\ndup,2\n');
    expect(cases.map((c) => c.name)).toEqual(['dup', 'dup (2)']);
    expect(warnings[0]).toContain('dup');
  });

  it('skips blank rows and reports a ragged one', () => {
    const {cases, warnings} = casesFromCsv('a,b\n1,2\n\n3\n');
    expect(cases).toHaveLength(2);
    expect(warnings.some((w) => w.includes('cells for'))).toBe(true);
  });

  it('says what is wrong when there is nothing to run', () => {
    expect(casesFromCsv('a,b\n').warnings[0]).toContain('add a row per case');
    expect(casesFromCsv('').warnings[0]).toContain('Nothing to read');
  });

  it('round-trips back to CSV for pasting into a sheet', () => {
    const {cases} = casesFromCsv(casesToCsv([{name: 'a, b', vars: {x: 'say "hi"'}}]));
    expect(cases[0]).toEqual({name: 'a, b', vars: {x: 'say "hi"'}});
  });
});

// A journey of one step that echoes back whichever variable it was seeded with.
const DEF: NodeDef = {
  type: 'demo.echo',
  label: 'Echo',
  fields: [],
  request: {method: 'GET', path: '/echo/{{vars.country}}'},
  needs: [],
  gives: [],
  assertions: [{op: 'status', expected: 200}],
};

const JOURNEY: Journey = {
  name: 'Echo',
  nodes: [{id: 'n1', type: 'demo.echo', config: {}, position: {x: 0, y: 0}}],
  edges: [],
};

function transportThat(handle: (url: string) => {status: number; body: unknown}) {
  const seen: string[] = [];
  return {
    seen,
    transport: {
      async send(request: {url: string}) {
        seen.push(request.url);
        const {status, body} = handle(request.url);
        return {status, headers: {}, body, durationMs: 1};
      },
    },
  };
}

describe('running a journey once per case', () => {
  it('seeds each case and runs the journey for every row', async () => {
    const {seen, transport} = transportThat(() => ({status: 200, body: {ok: true}}));

    const runs = await runJourneyCases(
      {...JOURNEY, cases: [
        {name: 'nigeria', vars: {country: 'NG'}},
        {name: 'ghana', vars: {country: 'GH'}},
      ]},
      {env: 'test', lookup: () => DEF, transport},
    );

    expect(seen).toEqual(['/echo/NG', '/echo/GH']);
    expect(runs.map((r) => r.case?.name)).toEqual(['nigeria', 'ghana']);
    expect(runs.every((r) => r.result.passed)).toBe(true);
  });

  it('runs once, plainly, when the journey has no cases', async () => {
    const {transport} = transportThat(() => ({status: 200, body: {}}));
    const runs = await runJourneyCases(JOURNEY, {env: 'test', lookup: () => DEF, transport});
    expect(runs).toHaveLength(1);
    expect(runs[0].case).toBeUndefined();
  });

  it('keeps going after a case fails', async () => {
    // The point of the whole feature: a suite that stops at the first bad row
    // makes you re-run it once per broken row to learn there were four.
    const {transport} = transportThat((url) => ({status: url.endsWith('/GH') ? 500 : 200, body: {}}));

    const runs = await runJourneyCases(
      {...JOURNEY, cases: [
        {name: 'nigeria', vars: {country: 'NG'}},
        {name: 'ghana', vars: {country: 'GH'}},
        {name: 'kenya', vars: {country: 'KE'}},
      ]},
      {env: 'test', lookup: () => DEF, transport},
    );

    expect(runs.map((r) => r.result.passed)).toEqual([true, false, true]);
  });

  it('does not let one case see what another one produced', async () => {
    const {transport} = transportThat(() => ({status: 200, body: {id: 'from-response'}}));
    const gives: NodeDef = {...DEF, gives: [{key: 'leaked', from: 'body.id'}]};

    const runs = await runJourneyCases(
      {...JOURNEY, cases: [{name: 'a', vars: {country: 'NG'}}, {name: 'b', vars: {country: 'GH'}}]},
      {env: 'test', lookup: () => gives, transport},
    );

    // Each case starts from its own seed, so `country` is never carried over.
    expect(runs[1].result.context.vars.country).toBe('GH');
    expect(Object.keys(runs[0].result.context.vars).sort()).toEqual(['country', 'leaked']);
  });

  it('stops between cases when aborted', async () => {
    const controller = new AbortController();
    const {transport} = transportThat(() => {
      controller.abort();
      return {status: 200, body: {}};
    });

    const runs = await runJourneyCases(
      {...JOURNEY, cases: [{name: 'a', vars: {}}, {name: 'b', vars: {}}, {name: 'c', vars: {}}]},
      {env: 'test', lookup: () => DEF, transport, signal: controller.signal},
    );
    expect(runs).toHaveLength(1);
  });
});

describe('comparing a run against a recorded shape', () => {
  const run = (body: unknown, baseline?: Record<string, Record<string, string>>, strict = false) =>
    runJourneyCases(JOURNEY, {
      env: 'test',
      lookup: () => DEF,
      transport: transportThat(() => ({status: 200, body})).transport,
      baseline,
      strictSnapshot: strict,
    });

  it('records a shape for every success, whether or not a baseline exists', async () => {
    const [{result}] = await run({id: 1});
    expect(shapesFrom(result.states)).toEqual({n1: {id: 'number'}});
  });

  it('reports drift but does not fail the step by default', async () => {
    const [{result}] = await run({id: 'now a string'}, {n1: {id: 'number'}});
    expect(result.passed).toBe(true);
    expect(result.states.n1.shapeChanges?.[0]).toMatchObject({path: 'id', kind: 'type-changed'});
  });

  it('fails the step when asked to be strict', async () => {
    const [{result}] = await run({id: 'now a string'}, {n1: {id: 'number'}}, true);
    expect(result.passed).toBe(false);
    expect(result.states.n1.error).toContain('was number');
  });

  it('does not fail on a new field even when strict', async () => {
    const [{result}] = await run({id: 1, extra: true}, {n1: {id: 'number'}}, true);
    expect(result.passed).toBe(true);
  });

  it('records no shape for a response that failed', async () => {
    // The shape of a 500 is not the contract, and recording it would bake an
    // error body in as the baseline.
    const [{result}] = await runJourneyCases(JOURNEY, {
      env: 'test',
      lookup: () => DEF,
      transport: transportThat(() => ({status: 500, body: {message: 'boom'}})).transport,
    });
    expect(result.states.n1.shape).toBeUndefined();
    expect(shapesFrom(result.states)).toEqual({});
  });
});

describe('warning before a data-driven run quietly tests one thing', () => {
  const setDef: NodeDef = {
    type: 'control.set',
    label: 'Use a known pet',
    fields: [],
    control: 'set',
    needs: [],
    gives: [],
    givesFrom: 'values',
  };
  const getDef: NodeDef = {...DEF, request: {method: 'GET', path: '/pet/{{vars.petId}}'}};

  const journey = (cases?: {name: string; vars: Record<string, unknown>}[]): Journey => ({
    name: 'Pets',
    cases,
    nodes: [
      {id: 'n1', type: 'control.set', config: {values: {petId: 1}}, position: {x: 0, y: 0}},
      {id: 'n2', type: 'demo.echo', config: {}, position: {x: 1, y: 0}},
    ],
    edges: [{id: 'e1', source: 'n1', target: 'n2'}],
  });

  const lookup = (type: string) => (type === 'control.set' ? setDef : getDef);

  it('names the step that overwrites what every case supplies', async () => {
    // Paste twelve rows of petId, and a `set petId` step means all twelve test
    // the same record. Every row goes green having covered one case.
    const {checkJourney} = await import('../src/core/graph');
    const problems = checkJourney(journey([{name: 'a', vars: {petId: 7}}]), lookup);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({nodeId: 'n1', kind: 'case-overwritten'});
    expect(problems[0].message).toContain('"petId"');
  });

  it('does not flag a step that writes the key back from its own response', async () => {
    // `GET /pet/{petId}` giving `petId` from `body.id` is ordinary chaining: it
    // lands after the step that used the case value. Flagging it would put a
    // false finding in front of every imported journey.
    const {checkJourney} = await import('../src/core/graph');
    const gives: NodeDef = {...getDef, gives: [{key: 'petId', from: 'body.id'}]};
    const one: Journey = {
      name: 'j',
      cases: [{name: 'a', vars: {petId: 7}}],
      nodes: [{id: 'n1', type: 'demo.echo', config: {}, position: {x: 0, y: 0}}],
      edges: [],
    };
    expect(checkJourney(one, () => gives)).toEqual([]);
  });

  it('says nothing when the journey has no cases', async () => {
    const {checkJourney} = await import('../src/core/graph');
    expect(checkJourney(journey(), lookup)).toEqual([]);
  });

  it('treats case variables as satisfying a step that needs them', async () => {
    // Without this, parameterising a journey would light up every step that
    // reads a case variable as missing context.
    const {checkJourney} = await import('../src/core/graph');
    const needs: NodeDef = {...DEF, needs: ['country']};
    const one: Journey = {
      name: 'j',
      cases: [{name: 'a', vars: {country: 'NG'}}],
      nodes: [{id: 'n1', type: 'demo.echo', config: {}, position: {x: 0, y: 0}}],
      edges: [],
    };
    expect(checkJourney(one, () => needs)).toEqual([]);
    expect(checkJourney({...one, cases: undefined}, () => needs)[0]).toMatchObject({kind: 'missing-context'});
  });
});
