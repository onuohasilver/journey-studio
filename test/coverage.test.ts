import {describe, expect, it} from 'vitest';
import {coverageOf, gapsForRanking, summariseCoverage} from '../src/core/coverage';
import {BUILTINS} from '../src/core/builtins';
import type {NodeDef} from '../src/core/types';

const op = (type: string, over: Partial<NodeDef> = {}): NodeDef => ({
  type,
  label: type,
  group: 'pet',
  fields: [],
  request: {method: 'GET', path: `/${type}`},
  needs: [],
  gives: [],
  ...over,
});

const defs = [
  op('api.getPet'),
  op('api.addPet', {request: {method: 'POST', path: '/pet'}, destructive: true}),
  op('api.deletePet', {request: {method: 'DELETE', path: '/pet/{id}'}, destructive: true}),
  op('api.listOrders', {group: 'store'}),
  ...BUILTINS,
];

describe('what the suite covers', () => {
  it('counts operations the journeys touch', () => {
    const coverage = coverageOf(defs, [{name: 'Read a pet', types: ['api.getPet']}]);
    expect(coverage.covered.map((r) => r.type)).toEqual(['api.getPet']);
    expect(coverage.uncovered.map((r) => r.type)).toEqual(['api.addPet', 'api.deletePet', 'api.listOrders']);
    expect(coverage.percent).toBe(25);
  });

  it('counts the API, not the tool', () => {
    // Wait, Set values and Assert are not operations anybody needs to cover, and
    // counting them would flatter every number here.
    const coverage = coverageOf(defs, [{name: 'j', types: ['control.delay', 'control.set']}]);
    expect(coverage.covered).toEqual([]);
    expect(coverage.covered.length + coverage.uncovered.length).toBe(4);
  });

  it('does not let the raw HTTP node claim coverage', () => {
    // It can call anything, so counting it as covering something would be a lie
    // in either direction.
    const coverage = coverageOf(defs, [{name: 'j', types: ['http.request']}]);
    expect(coverage.percent).toBe(0);
  });

  it('says which journeys use an operation', () => {
    const coverage = coverageOf(defs, [
      {name: 'Read a pet', types: ['api.getPet']},
      {name: 'Smoke', types: ['api.getPet', 'api.addPet']},
    ]);
    expect(coverage.covered.find((r) => r.type === 'api.getPet')!.usedBy).toEqual(['Read a pet', 'Smoke']);
  });

  it('counts a journey using an operation twice, once', () => {
    const coverage = coverageOf(defs, [{name: 'j', types: ['api.getPet', 'api.getPet']}]);
    expect(coverage.covered[0].usedBy).toEqual(['j']);
  });

  it('reports the worst group first, because that is the one to look at', () => {
    const coverage = coverageOf(defs, [{name: 'j', types: ['api.getPet']}]);
    expect(coverage.byGroup[0]).toMatchObject({group: 'store', total: 1, covered: 0});
  });

  it('flags a step type no loaded document declares', () => {
    // Usually a document that was not imported this session. Worth saying,
    // because otherwise its coverage silently reads as zero.
    const coverage = coverageOf(defs, [{name: 'j', types: ['other.thing']}]);
    expect(coverage.unknown).toEqual(['other.thing']);
  });

  it('has nothing to say before anything is imported', () => {
    const coverage = coverageOf(BUILTINS, []);
    expect(coverage.percent).toBe(0);
    expect(summariseCoverage(coverage)).toContain('import a document');
  });

  it('summarises for a panel', () => {
    const coverage = coverageOf(defs, [{name: 'j', types: ['api.getPet']}]);
    expect(summariseCoverage(coverage)).toBe('1 of 4 operations covered (25%)');
  });
});

describe('the gaps handed to the model', () => {
  it('puts destructive operations first, so a cap never cuts them', () => {
    const coverage = coverageOf(defs, []);
    const lines = gapsForRanking(coverage).split('\n');
    expect(lines[0]).toContain('api.addPet');
    expect(lines[1]).toContain('api.deletePet');
    expect(lines.slice(0, 2).every((l) => l.includes('destructive'))).toBe(true);
  });

  it('caps the list, because a 500-operation document would be the whole prompt', () => {
    const many = Array.from({length: 400}, (_, i) => op(`api.thing${i}`));
    expect(gapsForRanking(coverageOf(many, []), 120).split('\n')).toHaveLength(120);
  });

  it('carries what the model needs to rank and nothing else', () => {
    const line = gapsForRanking(coverageOf([op('api.getPet')], [])).split('\n')[0];
    expect(line).toContain('api.getPet');
    expect(line).toContain('GET /api.getPet');
    expect(line).toContain('pet');
  });
});
