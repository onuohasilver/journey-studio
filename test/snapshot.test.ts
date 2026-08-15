import {describe, expect, it} from 'vitest';
import {diffShape, readSnapshot, shapeOf, snapshotNameFor, summariseShape} from '../src/core/snapshot';

describe('recording the shape of a response', () => {
  it('records a path and type for every leaf', () => {
    expect(shapeOf({id: 1, name: 'Rex', ok: true, note: null})).toEqual({
      id: 'number',
      name: 'string',
      ok: 'boolean',
      note: 'null',
    });
  });

  it('names nested paths', () => {
    expect(shapeOf({data: {user: {id: 'u1'}}})).toMatchObject({
      data: 'object',
      'data.user': 'object',
      'data.user.id': 'string',
    });
  });

  it('collapses a list into one description of its elements', () => {
    // A hundred pets have one shape between them, not a hundred.
    const shape = shapeOf({pets: [{id: 1}, {id: 2}, {id: 3}]});
    expect(shape).toMatchObject({pets: 'array', 'pets.*': 'object', 'pets.*.id': 'number'});
    expect(Object.keys(shape)).toHaveLength(3);
  });

  it('marks a field that only some elements carry as optional', () => {
    // Otherwise a list coming back in a different order reads as a removal.
    expect(shapeOf({pets: [{id: 1, nickname: 'Rexy'}, {id: 2}]})['pets.*.nickname']).toBe('string?');
    expect(shapeOf({pets: [{id: 1}, {id: 2, nickname: 'x'}]})['pets.*.nickname']).toBe('string?');
  });

  it('unions types that disagree across elements', () => {
    expect(shapeOf({xs: [{v: 1}, {v: 'two'}]})['xs.*.v']).toBe('number|string');
  });

  it('stops before a huge or deeply nested body becomes the report', () => {
    const wide = {xs: Array.from({length: 500}, (_, i) => ({id: i}))};
    expect(Object.keys(shapeOf(wide))).toHaveLength(3);

    let deep: unknown = 'bottom';
    for (let i = 0; i < 30; i++) deep = {down: deep};
    expect(Object.keys(shapeOf(deep)).length).toBeLessThan(12);
  });
});

describe('comparing a response against what was recorded', () => {
  const baseline = shapeOf({id: 1, name: 'Rex', tags: [{id: 2}]});

  it('says nothing when nothing moved', () => {
    expect(diffShape(baseline, shapeOf({id: 9, name: 'Bo', tags: [{id: 4}]}))).toEqual([]);
  });

  it('catches a field that stopped being returned', () => {
    const [change] = diffShape(baseline, shapeOf({id: 1, tags: [{id: 2}]}));
    expect(change).toMatchObject({path: 'name', kind: 'removed', severity: 'error'});
    expect(change.message).toContain('no longer returned');
  });

  it('catches a type that changed under it', () => {
    const [change] = diffShape(baseline, shapeOf({id: '1', name: 'Rex', tags: [{id: 2}]}));
    expect(change).toMatchObject({path: 'id', kind: 'type-changed', was: 'number', now: 'string'});
  });

  it('treats a new field as information, not a failure', () => {
    // Additive change breaks nobody. Reporting it as red is how a snapshot suite
    // becomes something people delete.
    const changes = diffShape(baseline, shapeOf({id: 1, name: 'Rex', tags: [{id: 2}], nickname: 'Rexy'}));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({path: 'nickname', kind: 'added', severity: 'info'});
    expect(changes.filter((c) => c.severity === 'error')).toEqual([]);
  });

  it('warns when a field that was always there becomes intermittent', () => {
    const [change] = diffShape(baseline, shapeOf({id: 1, name: 'Rex', tags: [{id: 2}, {}]}));
    expect(change).toMatchObject({path: 'tags.*.id', kind: 'now-optional', severity: 'warn'});
  });

  it('does not report an optional field that is simply absent', () => {
    const optional = shapeOf({pets: [{id: 1, nickname: 'x'}, {id: 2}]});
    expect(diffShape(optional, shapeOf({pets: [{id: 1}, {id: 2}]}))).toEqual([]);
  });

  it('summarises for a report row', () => {
    expect(summariseShape([])).toBe('same shape as recorded');
    expect(summariseShape(diffShape(baseline, shapeOf({id: 1, tags: [{id: 2}]})))).toBe('1 shape break');
    expect(summariseShape(diffShape(baseline, shapeOf({id: 1, name: 'a', tags: [{id: 2}], extra: 1})))).toBe(
      '1 new field',
    );
  });
});

describe('the snapshot file', () => {
  it('refuses a file written by a newer version rather than reporting false drift', () => {
    const text = JSON.stringify({version: 99, journey: 'x', nodes: {n1: {id: 'string'}}});
    expect(readSnapshot(text)).toBeUndefined();
  });

  it('refuses anything that is not a snapshot', () => {
    expect(readSnapshot('not json')).toBeUndefined();
    expect(readSnapshot('{"version":1}')).toBeUndefined();
  });

  it('reads a file it wrote', () => {
    const text = JSON.stringify({version: 1, journey: 'Pets', recordedAt: 'then', nodes: {n1: {id: 'number'}}});
    expect(readSnapshot(text)).toMatchObject({journey: 'Pets', nodes: {n1: {id: 'number'}}});
  });

  it('sits beside the journey it belongs to', () => {
    expect(snapshotNameFor('pet-lookup.journey.json')).toBe('pet-lookup.snap.json');
  });
});
