import {beforeEach, describe, expect, it} from 'vitest';
import {applyOps, buildChain, type EditOp} from '../src/core/ai/apply';
import {buildCanvasIndex, buildNodeIndex} from '../src/core/ai/grounding';
import {validateEdit, validatePlan} from '../src/core/ai/validate';
import {topoOrder} from '../src/core/graph';
import type {Journey, NodeDef} from '../src/core/types';

const DEFS: Record<string, NodeDef> = {
  'demo.createUser': {
    type: 'demo.createUser',
    label: 'Create user',
    fields: [
      {key: 'email', label: 'Email', kind: 'text'},
      {key: 'plan', label: 'Plan', kind: 'select', options: [{value: 'free', label: 'free'}, {value: 'pro', label: 'pro'}]},
      {key: 'limit', label: 'Limit', kind: 'number'},
      {key: 'body', label: 'Body', kind: 'json'},
    ],
    defaults: {email: 'a@b.co'},
    request: {method: 'POST', path: '/users'},
    needs: [],
    gives: [{key: 'userId', from: 'body.id'}],
  },
  'demo.getUser': {
    type: 'demo.getUser',
    label: 'Get user',
    fields: [],
    request: {method: 'GET', path: '/users/{{vars.userId}}'},
    needs: ['userId'],
    gives: [],
  },
  'demo.deleteUser': {
    type: 'demo.deleteUser',
    label: 'Delete user',
    fields: [],
    request: {method: 'DELETE', path: '/users/{{vars.userId}}'},
    needs: ['userId'],
    gives: [],
    destructive: true,
  },
};
const lookup = (t: string) => DEFS[t];

let journey: Journey;
beforeEach(() => {
  journey = buildChain(
    [
      {type: 'demo.createUser', why: 'Makes a user to work with.', config: {}},
      {type: 'demo.getUser', why: 'Reads it back.', config: {}},
    ],
    lookup,
  );
});

describe('building a chain from a plan', () => {
  it('wires the steps in order and lays them out', () => {
    expect(journey.nodes).toHaveLength(2);
    expect(journey.edges).toHaveLength(1);
    expect(journey.edges[0]).toMatchObject({source: journey.nodes[0].id, target: journey.nodes[1].id});
    expect(journey.nodes[1].position.x).toBeGreaterThan(journey.nodes[0].position.x);
  });

  it('keeps the narration on the node so it survives later edits', () => {
    expect(journey.nodes[0].config.__why).toBe('Makes a user to work with.');
  });
});

describe('validating a plan against the registry', () => {
  it('keeps steps that name a loaded node', () => {
    const result = validatePlan({summary: 's', steps: [{type: 'demo.getUser', why: 'ok'}]}, lookup);
    expect(result.steps.map((s) => s.type)).toEqual(['demo.getUser']);
    expect(result.problems).toEqual([]);
  });

  it('drops an invented node type and says so', () => {
    // A hallucinated type would otherwise be a silent hole in the chain.
    const result = validatePlan(
      {summary: 's', steps: [{type: 'demo.getUser', why: 'ok'}, {type: 'demo.summonDragon', why: 'no'}]},
      lookup,
    );
    expect(result.steps).toHaveLength(1);
    expect(result.problems.join(' ')).toContain('demo.summonDragon');
  });

  it('coerces config back out of its string form', () => {
    const result = validatePlan(
      {
        summary: 's',
        steps: [{type: 'demo.createUser', why: 'ok', config: [
          {key: 'limit', value: '25'},
          {key: 'body', value: '{"a":1}'},
        ]}],
      },
      lookup,
    );
    expect(result.steps[0].config).toEqual({limit: 25, body: {a: 1}});
  });

  it('rejects an enum value the field does not offer', () => {
    const result = validatePlan(
      {summary: 's', steps: [{type: 'demo.createUser', why: 'ok', config: [{key: 'plan', value: 'platinum'}]}]},
      lookup,
    );
    expect(result.steps[0].config.plan).toBeUndefined();
    expect(result.problems.join(' ')).toContain('platinum');
  });

  it('accepts a templated value for an enum, since it resolves at run time', () => {
    const result = validatePlan(
      {summary: 's', steps: [{type: 'demo.createUser', why: 'ok', config: [{key: 'plan', value: '{{vars.plan}}'}]}]},
      lookup,
    );
    expect(result.steps[0].config.plan).toBe('{{vars.plan}}');
  });
});

describe('validating an edit against the canvas', () => {
  it('drops an op naming a step that is not there', () => {
    const result = validateEdit({summary: 's', ops: [{op: 'remove', ref: 'ghost', why: 'x'}]}, journey, lookup);
    expect(result.ops).toEqual([]);
    expect(result.problems.join(' ')).toContain('ghost');
  });

  it('falls back to the end when the anchor is not real', () => {
    const result = validateEdit(
      {summary: 's', ops: [{op: 'insert', after: 'nope', type: 'demo.getUser', why: 'x'}]},
      journey,
      lookup,
    );
    expect(result.ops[0]).toMatchObject({op: 'insert', after: 'end'});
    expect(result.problems.join(' ')).toContain('nope');
  });

  it('accepts a handle from an earlier insert as a later op target', () => {
    const result = validateEdit(
      {
        summary: 's',
        ops: [
          {op: 'insert', after: 'end', handle: 'h1', type: 'demo.createUser', why: 'add'},
          {op: 'configure', ref: 'h1', config: [{key: 'email', value: 'x@y.z'}], why: 'point it'},
        ],
      },
      journey,
      lookup,
    );
    expect(result.ops).toHaveLength(2);
    expect(result.problems).toEqual([]);
  });

  it('drops an unknown op kind', () => {
    const result = validateEdit({summary: 's', ops: [{op: 'reorder', ref: 'x', why: 'y'}]}, journey, lookup);
    expect(result.problems.join(' ')).toContain('reorder');
  });
});

describe('applying an edit in place', () => {
  const ids = () => journey.nodes.map((n) => n.id);

  it('keeps every untouched node identical', () => {
    // The entire reason edits exist rather than rebuilds.
    const [first, second] = ids();
    const result = applyOps(journey, [{op: 'configure', ref: second, config: {email: 'z@z.z'}, why: 'x'}], lookup);

    expect(result.journey.nodes.find((n) => n.id === first)).toEqual(journey.nodes[0]);
    expect(result.journey.nodes.find((n) => n.id === second)!.config.email).toBe('z@z.z');
    expect(result.touched).toEqual([second]);
  });

  it('splices an insert into the chain without breaking it', () => {
    const [first, second] = ids();
    const result = applyOps(
      journey,
      [{op: 'insert', after: first, type: 'demo.getUser', config: {}, why: 'check it'}],
      lookup,
    );
    const added = result.journey.nodes.find((n) => ![first, second].includes(n.id))!;

    expect(result.journey.edges.some((e) => e.source === first && e.target === added.id)).toBe(true);
    expect(result.journey.edges.some((e) => e.source === added.id && e.target === second)).toBe(true);
    expect(result.journey.edges.some((e) => e.source === first && e.target === second)).toBe(false);
    // The displaced step moves over rather than sitting underneath the new one.
    expect(result.journey.nodes.find((n) => n.id === second)!.position.x).toBeGreaterThan(added.position.x);
  });

  it('heals the chain when a middle step is removed', () => {
    const [first, second] = ids();
    const withThird = applyOps(journey, [{op: 'insert', after: second, type: 'demo.deleteUser', config: {}, why: 'x'}], lookup).journey;
    const third = withThird.nodes[withThird.nodes.length - 1].id;

    const result = applyOps(withThird, [{op: 'remove', ref: second, why: 'not needed'}], lookup);

    expect(result.journey.nodes.map((n) => n.id)).toEqual([first, third]);
    // Without the bridge, everything downstream silently stops running.
    expect(result.journey.edges.some((e) => e.source === first && e.target === third)).toBe(true);
  });

  it('replaces in place, keeping id, position and wiring', () => {
    const [first, second] = ids();
    const before = journey.nodes[1];
    const result = applyOps(journey, [{op: 'replace', ref: second, type: 'demo.deleteUser', config: {}, why: 'swap'}], lookup);
    const after = result.journey.nodes.find((n) => n.id === second)!;

    expect(after.type).toBe('demo.deleteUser');
    expect(after.position).toEqual(before.position);
    expect(result.journey.edges.some((e) => e.source === first && e.target === second)).toBe(true);
    expect(result.changes[0].text).toContain('Swapped');
  });

  it('lets a later op target a node inserted earlier in the same edit', () => {
    const [, second] = ids();
    const ops: EditOp[] = [
      {op: 'insert', after: second, handle: 'fresh', type: 'demo.createUser', config: {}, why: 'add'},
      {op: 'configure', ref: 'fresh', config: {email: 'chained@x.y'}, why: 'set it'},
    ];
    const result = applyOps(journey, ops, lookup);
    const added = result.journey.nodes[result.journey.nodes.length - 1];

    expect(added.config.email).toBe('chained@x.y');
  });

  it('reports an op that names a step which is not there', () => {
    const result = applyOps(journey, [{op: 'remove', ref: 'ghost', why: 'x'}], lookup);
    expect(result.journey.nodes).toHaveLength(2);
    expect(result.skipped.join(' ')).toContain('ghost');
  });
});

describe('grounding', () => {
  it('lists every registered node with what it needs and gives', () => {
    const index = buildNodeIndex(Object.values(DEFS));
    expect(index).toContain('demo.createUser');
    expect(index).toContain('gives=userId');
    expect(index).toContain('needs=userId');
    expect(index).toContain('DESTRUCTIVE');
  });

  it('gives the reviser a ref per step, plus how the last run went', () => {
    // The refs are the model's only handle on the canvas; the failure is what
    // makes "fix the step that failed" answerable without more typing.
    const ordered = topoOrder(journey.nodes, journey.edges);
    const index = buildCanvasIndex(ordered, lookup, {
      [journey.nodes[1].id]: {status: 'failed', error: 'userId is required', response: {status: 400, headers: {}, body: {}, durationMs: 3}},
    });

    expect(index).toContain(`ref=${journey.nodes[0].id}`);
    expect(index).toContain('http=400');
    expect(index).toContain('userId is required');
  });
});
