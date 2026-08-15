import {describe, expect, it} from 'vitest';
import {readPath, readResponse, referencesIn, resolve, resolveString} from '../src/core/template';
import type {HttpResponse, RunContext} from '../src/core/types';

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  env: 'test',
  vars: {},
  responses: {},
  secretNames: [],
  runId: 'run_1',
  ...over,
});

const res = (over: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 200,
  headers: {location: '/users/42'},
  body: {data: {id: 'u_1', items: [{sku: 'a'}, {sku: 'b'}]}},
  durationMs: 12,
  ...over,
});

describe('readPath', () => {
  it('walks objects and array indexes', () => {
    expect(readPath({a: {b: [{c: 7}]}}, 'a.b.0.c')).toBe(7);
  });

  it('returns undefined for a miss instead of throwing', () => {
    // A missing value is normal — the assertion layer decides if it matters.
    expect(readPath({a: 1}, 'a.b.c')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });
});

describe('readResponse', () => {
  it('understands status, headers and body shorthands', () => {
    expect(readResponse(res(), 'status')).toBe(200);
    expect(readResponse(res(), 'headers.location')).toBe('/users/42');
    expect(readResponse(res(), 'body.data.id')).toBe('u_1');
  });

  it('treats a bare path as a body path', () => {
    expect(readResponse(res(), 'data.items.1.sku')).toBe('b');
  });

  it('matches header names case-insensitively', () => {
    expect(readResponse(res(), 'headers.LOCATION')).toBe('/users/42');
  });
});

describe('resolveString', () => {
  it('keeps the type when the whole string is one reference', () => {
    // A number must stay a number or JSON bodies get quoted integers.
    const c = ctx({vars: {count: 3, flag: false, obj: {a: 1}}});
    expect(resolveString('{{vars.count}}', c)).toBe(3);
    expect(resolveString('{{vars.flag}}', c)).toBe(false);
    expect(resolveString('{{vars.obj}}', c)).toEqual({a: 1});
  });

  it('stringifies when interpolated into surrounding text', () => {
    expect(resolveString('/users/{{vars.id}}/pets', ctx({vars: {id: 9}}))).toBe('/users/9/pets');
  });

  it('resolves several references in one string', () => {
    const c = ctx({vars: {a: 'x', b: 'y'}});
    expect(resolveString('{{vars.a}}-{{vars.b}}', c)).toBe('x-y');
  });

  it('reads straight out of an earlier response', () => {
    const c = ctx({responses: {n1: res()}});
    expect(resolveString('{{nodes.n1.body.data.id}}', c)).toBe('u_1');
    expect(resolveString('{{nodes.n1.status}}', c)).toBe(200);
  });

  it('accepts a bare name as a var', () => {
    expect(resolveString('{{userId}}', ctx({vars: {userId: 'u_9'}}))).toBe('u_9');
  });

  it('leaves an unknown reference untouched rather than emitting "undefined"', () => {
    // Silently blanking a reference produces a request that fails confusingly.
    expect(resolveString('/x/{{vars.nope}}', ctx())).toBe('/x/{{vars.nope}}');
  });

  it('leaves secrets for the proxy to substitute', () => {
    // The browser must never see a secret, so this side deliberately can't.
    expect(resolveString('{{secrets.apiKey}}', ctx())).toBe('{{secrets.apiKey}}');
  });

  it('generates values on demand', () => {
    expect(String(resolveString('{{$uuid}}', ctx()))).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(resolveString('{{$timestamp}}', ctx()))).toBeGreaterThan(0);
  });
});

describe('resolve', () => {
  it('walks a whole structure, keys included', () => {
    const c = ctx({vars: {id: 'u_1', header: 'x-tenant'}});
    expect(
      resolve({path: '/u/{{vars.id}}', headers: {'{{vars.header}}': 'acme'}, n: 1}, c),
    ).toEqual({path: '/u/u_1', headers: {'x-tenant': 'acme'}, n: 1});
  });
});

describe('referencesIn', () => {
  it('finds every reference so a journey can be checked before it runs', () => {
    const refs = referencesIn({a: '{{vars.x}}', b: ['{{nodes.n1.status}}']});
    expect([...refs].sort()).toEqual(['nodes.n1.status', 'vars.x']);
  });
});
