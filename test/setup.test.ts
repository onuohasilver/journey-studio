import {describe, expect, it} from 'vitest';
import {createSetupCache, harvest, orderBySetup} from '../src/core/setup';

const j = (name: string, uses?: string[]) => ({name, file: `${name.toLowerCase()}.journey.json`, uses});

describe('ordering a suite so setups run first', () => {
  it('puts a setup before what needs it', () => {
    const {ordered, problems} = orderBySetup([j('Checkout', ['Login']), j('Login')]);
    expect(ordered.map((x) => x.name)).toEqual(['Login', 'Checkout']);
    expect(problems).toEqual([]);
  });

  it('resolves a setup by name, file, or file without the suffix', () => {
    expect(orderBySetup([j('Checkout', ['login']), j('Login')]).problems).toEqual([]);
    expect(orderBySetup([j('Checkout', ['login.journey.json']), j('Login')]).problems).toEqual([]);
  });

  it('handles a chain of setups', () => {
    const {ordered} = orderBySetup([j('C', ['B']), j('B', ['A']), j('A')]);
    expect(ordered.map((x) => x.name)).toEqual(['A', 'B', 'C']);
  });

  it('runs a shared setup once, before both of its dependents', () => {
    const {ordered} = orderBySetup([j('One', ['Login']), j('Two', ['Login']), j('Login')]);
    expect(ordered[0].name).toBe('Login');
    expect(ordered.filter((x) => x.name === 'Login')).toHaveLength(1);
  });

  it('reports a loop rather than silently picking an order', () => {
    // Two journeys each claiming to set the other up is a mistake in the suite,
    // and choosing one quietly would hide it.
    const {problems} = orderBySetup([j('A', ['B']), j('B', ['A'])]);
    expect(problems.join(' ')).toContain('is a loop of setups');
  });

  it('names a setup that does not exist', () => {
    expect(orderBySetup([j('A', ['Nope'])]).problems[0]).toContain('"Nope", which is not a saved journey');
  });

  it('catches a journey listing itself', () => {
    expect(orderBySetup([j('A', ['A'])]).problems[0]).toContain('itself as its own setup');
  });

  it('leaves journeys with no setups alone', () => {
    const {ordered, problems} = orderBySetup([j('A'), j('B')]);
    expect(ordered.map((x) => x.name)).toEqual(['A', 'B']);
    expect(problems).toEqual([]);
  });
});

describe('running a setup once', () => {
  it('runs it once and reuses the answer', async () => {
    const cache = createSetupCache();
    let runs = 0;
    const login = async () => {
      runs += 1;
      return {vars: {token: 'tok'}, ok: true};
    };

    expect((await cache.get('Login', 'staging', login)).vars).toEqual({token: 'tok'});
    expect((await cache.get('Login', 'staging', login)).vars).toEqual({token: 'tok'});
    expect(runs).toBe(1);
  });

  it('does not reuse a setup across environments', async () => {
    // A token minted against staging is not valid against production, and a
    // cache that ignored that would produce failures nobody could explain.
    const cache = createSetupCache();
    let runs = 0;
    const login = async () => ({vars: {token: `tok_${++runs}`}, ok: true});

    expect((await cache.get('Login', 'staging', login)).vars).toEqual({token: 'tok_1'});
    expect((await cache.get('Login', 'prod', login)).vars).toEqual({token: 'tok_2'});
  });

  it('shares one run between callers that arrive together', async () => {
    const cache = createSetupCache();
    let runs = 0;
    const login = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 5));
      return {vars: {token: 'tok'}, ok: true};
    };

    await Promise.all(Array.from({length: 8}, () => cache.get('Login', 'staging', login)));
    expect(runs).toBe(1);
  });

  it('remembers a failure instead of retrying it for every journey', async () => {
    // If the login is broken, the second journey should be told immediately.
    const cache = createSetupCache();
    let runs = 0;
    const broken = async (): Promise<never> => {
      runs += 1;
      throw new Error('401 from the auth service');
    };

    const first = await cache.get('Login', 'staging', broken);
    const second = await cache.get('Login', 'staging', broken);
    expect(first.ok).toBe(false);
    expect(first.error).toContain('401');
    expect(second.ok).toBe(false);
    expect(runs).toBe(1);
  });
});

describe('what a setup hands on', () => {
  it('passes only the keys it declared it produces', () => {
    // Everything else in a run context is incidental; copying it wholesale makes
    // one journey's internals another journey's dependency by accident.
    const context = {token: 'tok', userId: 'u1', scratch: 'internal'};
    expect(harvest(context, ['token', 'userId'])).toEqual({token: 'tok', userId: 'u1'});
  });

  it('leaves out a key the setup never produced', () => {
    expect(harvest({token: 'tok'}, ['token', 'missing'])).toEqual({token: 'tok'});
  });
});
