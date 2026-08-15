import {describe, expect, it} from 'vitest';
import {importPostman, readTestScript} from '../src/core/postman';
import {detectFormat, importDocument} from '../src/core/import';

const COLLECTION = JSON.stringify({
  info: {
    _postman_id: 'abc',
    name: 'Shop API',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [{key: 'baseUrl', value: 'https://api.shop.test'}],
  item: [
    {
      name: 'Users',
      item: [
        {
          name: 'Create user',
          request: {
            method: 'POST',
            header: [
              {key: 'Content-Type', value: 'application/json'},
              {key: 'X-Debug', value: '1', disabled: true},
            ],
            body: {mode: 'raw', raw: '{"email":"a@b.co","plan":"pro"}'},
            url: {raw: '{{baseUrl}}/users', host: ['{{baseUrl}}'], path: ['users']},
            auth: {type: 'bearer', bearer: [{key: 'token', value: 'super-secret-live-token'}]},
          },
          event: [
            {
              listen: 'test',
              script: {
                exec: [
                  'pm.test("created", function () { pm.response.to.have.status(201); });',
                  'const jsonData = pm.response.json();',
                  'pm.environment.set("userId", jsonData.id);',
                  'pm.collectionVariables.set("authToken", jsonData.token.access);',
                ],
              },
            },
          ],
        },
        {
          name: 'Get user',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/users/:userId?expand=orders',
              host: ['{{baseUrl}}'],
              path: ['users', ':userId'],
              query: [
                {key: 'expand', value: 'orders'},
                {key: 'debug', value: 'true', disabled: true},
              ],
            },
          },
        },
      ],
    },
    {
      name: 'Delete user',
      request: {method: 'DELETE', url: {path: ['users', ':userId'], host: ['{{baseUrl}}']}},
    },
  ],
});

const result = importPostman(COLLECTION, 'shop.json');
const node = (label: string) => result.nodes.find((n) => n.label === label)!;

describe('importing a Postman collection', () => {
  it('reads the collection and namespaces every request', () => {
    expect(result.ok).toBe(true);
    expect(result.title).toBe('Shop API');
    expect(result.format).toBe('postman');
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.every((n) => n.type.startsWith('postman.shop-api.'))).toBe(true);
  });

  it('uses folders as palette groups', () => {
    expect(node('Create user').group).toBe('Users');
    expect(node('Delete user').group).toBe('default');
  });

  it('drops the host so environments own the base URL', () => {
    // A collection pinned to production should be re-pointable by switching
    // environment, not by editing every request.
    expect(node('Create user').request!.path).toBe('/users');
    expect(result.servers).toEqual(['https://api.shop.test']);
  });

  it('turns :pathVariables into fields that chain by default', () => {
    const get = node('Get user');
    expect(get.request!.path).toBe('/users/{{fields.userId}}');
    expect(get.defaults!.userId).toBe('{{vars.userId}}');
    expect(get.needs).toEqual(['userId']);
  });

  it('transcribes pm.*.set() calls into what the step gives', () => {
    // The whole reason this importer is worth having: collections already
    // express chaining, so it carries over instead of being redeclared.
    expect(node('Create user').gives).toEqual([
      {key: 'userId', from: 'body.id'},
      {key: 'authToken', from: 'body.token.access'},
    ]);
  });

  it('takes the expected status from the test script', () => {
    expect(node('Create user').assertions).toEqual([{op: 'status', expected: 201}]);
    expect(node('Get user').assertions).toEqual([{op: 'status', expected: 200}]);
  });

  it('parses a raw JSON body into an editable object', () => {
    expect(node('Create user').defaults!.body).toEqual({email: 'a@b.co', plan: 'pro'});
    expect(node('Create user').request!.body).toBe('{{fields.body}}');
  });

  it('skips disabled headers and query params', () => {
    expect(node('Create user').request!.headers).toEqual({'Content-Type': 'application/json'});
    expect(Object.keys(node('Get user').request!.query!)).toEqual(['expand']);
  });

  it('references auth by name and never imports the credential', () => {
    // Collections routinely have a live token pasted in; copying it into a saved
    // node would put a secret in version control.
    const created = node('Create user');
    expect(created.request!.auth).toBe('bearer');
    expect(JSON.stringify(created)).not.toContain('super-secret-live-token');
    expect(result.warnings.join(' ')).toContain('credential was not imported');
  });

  it('marks deletes as destructive', () => {
    expect(node('Delete user').destructive).toBe(true);
  });
});

describe('reading test scripts', () => {
  it('handles pm.response.json() used inline', () => {
    const f = readTestScript('pm.environment.set("id", pm.response.json().data.id);', 'r');
    expect(f.gives).toEqual([{key: 'id', from: 'body.data.id'}]);
  });

  it('handles a header source', () => {
    const f = readTestScript('pm.environment.set("loc", pm.response.headers.get("Location"));', 'r');
    expect(f.gives).toEqual([{key: 'loc', from: 'headers.location'}]);
  });

  it('warns instead of guessing when the expression is not readable', () => {
    const f = readTestScript('pm.environment.set("x", computeSomething(1, 2));', 'Create');
    expect(f.gives).toEqual([]);
    expect(f.warnings[0]).toContain("can't read");
  });

  it('does not execute the script', () => {
    // A collection is untrusted input; evaluating its JS to learn what it sets
    // would be a straightforward RCE.
    const evil = 'pm.environment.set("x", jsonData.a); globalThis.__pwned = true;';
    readTestScript(evil, 'r');
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

describe('rejecting collections it cannot use', () => {
  it('names a v1 collection', () => {
    const r = importPostman(JSON.stringify({requests: [], order: []}));
    expect(r.error).toContain('v1 collection');
  });

  it('explains a parse failure', () => {
    expect(importPostman('{oops').error).toContain('Could not parse');
  });

  it('reports an empty collection', () => {
    const r = importPostman(JSON.stringify({info: {name: 'Empty', schema: 'collection/v2.1.0'}, item: []}));
    expect(r.error).toContain('no requests');
  });
});

describe('detecting the format', () => {
  it('recognises a Postman collection by its schema url', () => {
    expect(detectFormat(COLLECTION)).toBe('postman');
  });

  it('recognises OpenAPI in YAML and JSON', () => {
    expect(detectFormat('openapi: 3.0.0\ninfo: {title: X}')).toBe('openapi');
    expect(detectFormat('{"openapi":"3.0.0","info":{"title":"X"}}')).toBe('openapi');
  });

  it('says so when it recognises neither', () => {
    expect(detectFormat('hello world')).toBe('unknown');
    expect(importDocument('hello world').error).toContain('Not recognised');
  });

  it('routes a dropped file to the right importer without being told', () => {
    expect(importDocument(COLLECTION, 'shop.json').format).toBe('postman');
    expect(importDocument('openapi: 3.0.0\ninfo: {title: P}\npaths: {/a: {get: {responses: {}}}}').format)
      .toBe('openapi');
  });
});
