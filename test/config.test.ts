import {describe, expect, it} from 'vitest';
import {expandConfig} from '../server/config';

const resolvers = {
  env: (name: string) => ({API_TOKEN: 'tok_live', EMPTY: ''} as Record<string, string>)[name],
  file: (p: string) => (p === 'secret.txt' ? 'from-a-file' : undefined),
  op: (ref: string) => (ref === 'Vault/Item/field' ? 'from-1password' : undefined),
};

describe('resolving config references', () => {
  it('substitutes from the environment', () => {
    expect(expandConfig('${env:API_TOKEN}', resolvers)).toBe('tok_live');
  });

  it('reads a file, so a secret need not be in the config at all', () => {
    expect(expandConfig('${file:secret.txt}', resolvers)).toBe('from-a-file');
  });

  it('reads from 1Password with its own reference syntax', () => {
    expect(expandConfig('${op://Vault/Item/field}', resolvers)).toBe('from-1password');
  });

  it('substitutes inside a larger string and several times over', () => {
    expect(expandConfig('Bearer ${env:API_TOKEN} / ${file:secret.txt}', resolvers)).toBe(
      'Bearer tok_live / from-a-file',
    );
  });

  it('walks nested objects and arrays', () => {
    const config = {auth: {api: {token: '${env:API_TOKEN}'}}, hosts: ['${file:secret.txt}']};
    expect(expandConfig(config, resolvers)).toEqual({
      auth: {api: {token: 'tok_live'}},
      hosts: ['from-a-file'],
    });
  });

  it('leaves an unresolved reference in place rather than blanking it', () => {
    // The whole point. A request that fails carrying a literal ${env:NOPE} says
    // what is wrong; one that fails carrying an empty header looks like the API
    // rejecting you, and that is an afternoon gone.
    const missing: string[] = [];
    expect(expandConfig('${env:NOPE}', resolvers, missing)).toBe('${env:NOPE}');
    expect(missing).toEqual(['${env:NOPE}']);
  });

  it('treats an empty value as missing, because an empty credential is not one', () => {
    const missing: string[] = [];
    expect(expandConfig('${env:EMPTY}', resolvers, missing)).toBe('${env:EMPTY}');
    expect(missing).toHaveLength(1);
  });

  it('leaves a scheme it does not know completely alone', () => {
    // A `${vault:...}` nobody wired up should look untouched, not empty.
    const missing: string[] = [];
    expect(expandConfig('${vault:a/b}', resolvers, missing)).toBe('${vault:a/b}');
    expect(missing).toEqual([]);
  });

  it('does not touch ordinary text or {{run templates}}', () => {
    expect(expandConfig('/pets/{{vars.petId}}', resolvers)).toBe('/pets/{{vars.petId}}');
    expect(expandConfig('plain', resolvers)).toBe('plain');
  });

  it('leaves numbers and booleans as they are', () => {
    expect(expandConfig({port: 5180, on: true}, resolvers)).toEqual({port: 5180, on: true});
  });
});
