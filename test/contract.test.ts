import {describe, expect, it} from 'vitest';
import {checkContract, summariseContract} from '../src/core/contract';

const PET = {
  type: 'object',
  required: ['id', 'name', 'status'],
  properties: {
    id: {type: 'integer'},
    name: {type: 'string'},
    status: {type: 'string', enum: ['available', 'pending', 'sold']},
    tags: {type: 'array', items: {type: 'object', properties: {id: {type: 'integer'}}}},
    note: {type: 'string', nullable: true},
  },
};

const ok = {id: 1, name: 'Rex', status: 'available', tags: [{id: 2}], note: null};

describe('checking a response against the spec', () => {
  it('passes a response that matches', () => {
    expect(checkContract(PET, ok)).toEqual([]);
  });

  it('catches a required field that stopped being returned', () => {
    // The regression no hand-written assertion anticipates: the backend drops a
    // field and every consumer breaks a week later.
    const {id, ...missingName} = ok;
    const findings = checkContract(PET, missingName);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({kind: 'missing-required', path: 'id', severity: 'error'});
    expect(findings[0].message).toContain('required by the spec');
  });

  it('catches a type that changed under it', () => {
    const findings = checkContract(PET, {...ok, id: '1'});
    expect(findings[0]).toMatchObject({kind: 'type-mismatch', path: 'id', expected: 'integer', actual: 'string'});
  });

  it('holds integers to being whole numbers', () => {
    expect(checkContract(PET, {...ok, id: 1.5})[0]).toMatchObject({kind: 'type-mismatch', path: 'id'});
  });

  it('catches an enum value the client will not understand', () => {
    const findings = checkContract(PET, {...ok, status: 'rehomed'});
    expect(findings[0]).toMatchObject({kind: 'enum-mismatch', path: 'status'});
    expect(findings[0].message).toContain('rehomed');
  });

  it('allows null only where the spec says so', () => {
    expect(checkContract(PET, {...ok, note: null})).toEqual([]);
    expect(checkContract(PET, {...ok, name: null})[0]).toMatchObject({
      kind: 'unexpected-null',
      path: 'name',
    });
  });

  it('accepts OpenAPI 3.1 style nullable types', () => {
    const schema = {type: 'object', properties: {when: {type: ['string', 'null']}}};
    expect(checkContract(schema, {when: null})).toEqual([]);
  });

  it('walks into arrays', () => {
    const findings = checkContract(PET, {...ok, tags: [{id: 1}, {id: 'two'}]});
    expect(findings[0]).toMatchObject({kind: 'type-mismatch', path: 'tags.1.id'});
  });

  it('does not flood the report from one bad list', () => {
    // A 500-item list of the same mistake carries no more information than five.
    const many = Array.from({length: 500}, () => ({id: 'nope'}));
    expect(checkContract(PET, {...ok, tags: many}).length).toBeLessThanOrEqual(5);
  });

  it('stays quiet about extra fields unless asked', () => {
    // Additive change is not a regression; reporting it by default would bury
    // the findings that matter.
    const extra = {...ok, nickname: 'Rexy'};
    expect(checkContract(PET, extra)).toEqual([]);
    expect(checkContract(PET, extra, {reportUndocumented: true})[0]).toMatchObject({
      kind: 'undocumented-field',
      path: 'nickname',
      severity: 'warn',
    });
  });

  it('accepts a value matching any branch of a oneOf', () => {
    const schema = {oneOf: [{type: 'string'}, {type: 'integer'}]};
    expect(checkContract(schema, 'x')).toEqual([]);
    expect(checkContract(schema, 4)).toEqual([]);
    expect(checkContract(schema, true)[0]).toMatchObject({kind: 'type-mismatch'});
  });

  it('applies every branch of an allOf', () => {
    const schema = {
      allOf: [
        {type: 'object', required: ['a'], properties: {a: {type: 'string'}}},
        {type: 'object', required: ['b'], properties: {b: {type: 'integer'}}},
      ],
    };
    expect(checkContract(schema, {a: 'x', b: 1})).toEqual([]);
    expect(checkContract(schema, {a: 'x'})[0]).toMatchObject({kind: 'missing-required', path: 'b'});
  });

  it('skips what it does not understand rather than guessing', () => {
    // A false finding in a QA report is worse than a missing one — people stop
    // reading the report.
    expect(checkContract({type: 'string', pattern: '^x'}, 'nope')).toEqual([]);
    expect(checkContract(undefined, {anything: true})).toEqual([]);
    expect(checkContract({}, {anything: true})).toEqual([]);
  });

  it('summarises for a one-line report row', () => {
    expect(summariseContract([])).toBe('matches the spec');
    expect(summariseContract(checkContract(PET, {...ok, id: '1'}))).toBe('1 contract break');
    expect(
      summariseContract(checkContract(PET, {...ok, nickname: 'x'}, {reportUndocumented: true})),
    ).toBe('1 undocumented field');
  });
});

describe('when the contract check runs at all', () => {
  it('skips a response the captured schema was never meant to describe', async () => {
    // We capture the 2xx schema. Checking a 500's error body against it produces
    // a finding that is technically true and completely useless — and one false
    // finding is all it takes for people to stop reading the report.
    const {runJourney} = await import('../src/core/engine');
    const def = {
      type: 'demo.get',
      label: 'Get',
      fields: [],
      request: {method: 'GET' as const, path: '/thing'},
      needs: [],
      gives: [],
      assertions: [],
      responseSchema: {type: 'object', required: ['id'], properties: {id: {type: 'string'}}},
    };
    const journey = {
      name: 'j',
      nodes: [{id: 'n1', type: 'demo.get', config: {}, position: {x: 0, y: 0}}],
      edges: [],
    };
    const run = (status: number, body: unknown) =>
      runJourney(journey, {
        env: 'test',
        lookup: () => def,
        transport: {async send() { return {status, headers: {}, body, durationMs: 1}; }},
      });

    const errored = await run(500, {code: 500, message: 'boom'});
    expect(errored.states.n1.contract).toBeUndefined();

    const drifted = await run(200, {nope: true});
    expect(drifted.states.n1.contract).toHaveLength(1);
    expect(drifted.states.n1.contract![0]).toMatchObject({kind: 'missing-required', path: 'id'});
  });
});
