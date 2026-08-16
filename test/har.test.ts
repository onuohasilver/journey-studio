import {describe, expect, it} from 'vitest';
import {importHar, inferLinks} from '../src/core/har';
import {detectFormat, importDocument} from '../src/core/import';

function entry(over: Record<string, unknown> = {}) {
  return {
    startedDateTime: '2026-08-16T09:00:00.000Z',
    request: {method: 'GET', url: 'https://api.test/v1/thing', headers: [], queryString: []},
    response: {status: 200, content: {mimeType: 'application/json', text: '{}'}},
    ...over,
  };
}

const har = (entries: unknown[]) => JSON.stringify({log: {version: '1.2', creator: {name: 'Chrome'}, entries}});

/** The flow this feature exists for: log in, create, then act on what was created. */
const REAL_FLOW = har([
  entry({
    request: {method: 'POST', url: 'https://api.test/v1/sessions', headers: [], queryString: [], postData: {mimeType: 'application/json', text: '{"email":"qa@example.com"}'}},
    response: {status: 201, content: {mimeType: 'application/json', text: '{"token":"tok_9f3ac21be0","userId":"usr_5512aa"}'}},
  }),
  entry({
    request: {
      method: 'POST',
      url: 'https://api.test/v1/orders',
      headers: [{name: 'Authorization', value: 'Bearer tok_9f3ac21be0'}, {name: 'Content-Type', value: 'application/json'}],
      queryString: [],
      postData: {mimeType: 'application/json', text: '{"user":"usr_5512aa","amount":250}'},
    },
    response: {status: 201, content: {mimeType: 'application/json', text: '{"id":"ord_77c1de","status":"pending"}'}},
  }),
  entry({
    request: {method: 'GET', url: 'https://api.test/v1/orders/ord_77c1de', headers: [], queryString: []},
    response: {status: 200, content: {mimeType: 'application/json', text: '{"id":"ord_77c1de","status":"settled"}'}},
  }),
]);

describe('recognising a recording', () => {
  it('is detected by its own shape, not its extension', () => {
    expect(detectFormat(REAL_FLOW)).toBe('har');
    expect(importDocument(REAL_FLOW, 'session.har').format).toBe('har');
  });

  it('says what is wrong when the file is not a HAR', () => {
    const result = importHar('{"nope":1}', 'x.har');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('log.entries');
  });
});

describe('linking what one response produced to what a later request used', () => {
  it('finds the values that chain the flow together', () => {
    // The difference between a replay and a test. Matched on the literal text,
    // so no guessing about naming conventions is involved.
    const links = inferLinks(JSON.parse(REAL_FLOW).log.entries);
    expect(links.map((l) => [l.key, l.at])).toEqual([
      ['token', 'body.token'],
      ['userId', 'body.userId'],
      ['id', 'body.id'],
    ]);
  });

  it('never links backwards in time', () => {
    // A value cannot have come from a response that had not arrived yet.
    const backwards = [
      entry({request: {method: 'GET', url: 'https://api.test/v1/orders/ord_77c1de', headers: [], queryString: []}}),
      entry({response: {status: 200, content: {mimeType: 'application/json', text: '{"id":"ord_77c1de"}'}}}),
    ];
    expect(inferLinks(backwards)).toEqual([]);
  });

  it('ignores values too short to be anything but a coincidence', () => {
    // A status of "1" or a currency of "USD" appears everywhere; linking on it
    // would wire half the journey to the other half at random.
    const noisy = [
      entry({response: {status: 200, content: {mimeType: 'application/json', text: '{"page":"1","ok":"yes"}'}}}),
      entry({request: {method: 'GET', url: 'https://api.test/v1/list?page=1&ok=yes', headers: [], queryString: []}}),
    ];
    expect(inferLinks(noisy)).toEqual([]);
  });

  it('gives each link a readable name, keeping duplicates apart', () => {
    const twice = [
      entry({response: {status: 200, content: {mimeType: 'application/json', text: '{"id":"acc_10a2b3"}'}}}),
      entry({response: {status: 200, content: {mimeType: 'application/json', text: '{"id":"ord_40c5d6"}'}}}),
      entry({request: {method: 'GET', url: 'https://api.test/v1/x/acc_10a2b3/y/ord_40c5d6', headers: [], queryString: []}}),
    ];
    expect(inferLinks(twice).map((l) => l.key)).toEqual(['id', 'id2']);
  });

  it('does not chain a value that is just a word', () => {
    // "Bearer" is six characters and did come from the response — a length-only
    // rule chains it, and the auth header becomes {{vars.tokentype}} nonsense.
    const wordy = [
      entry({response: {status: 200, content: {mimeType: 'application/json', text: '{"token_type":"Bearer","status":"settled"}'}}}),
      entry({
        request: {
          method: 'GET',
          url: 'https://api.test/v1/x?status=settled',
          headers: [{name: 'Authorization', value: 'Bearer abc'}],
          queryString: [],
        },
      }),
    ];
    expect(inferLinks(wordy)).toEqual([]);
  });
});

describe('the journey a recording becomes', () => {
  const result = importHar(REAL_FLOW, 'checkout.har');

  it('makes one node per call, in the order they happened', () => {
    expect(result.ok).toBe(true);
    expect(result.nodes.map((n) => n.label)).toEqual([
      'POST /v1/sessions',
      'POST /v1/orders',
      'GET /v1/orders/ord_77c1de',
    ]);
  });

  it('rewrites later requests to use what earlier ones produced', () => {
    // The recorded id is gone from the URL; the journey now works for any order.
    expect(result.nodes[2].request!.path).toBe('/v1/orders/{{vars.id}}');
    expect(result.nodes[1].request!.body).toMatchObject({user: '{{vars.userId}}'});
    expect(result.nodes[2].needs).toEqual(['id']);
  });

  it('declares what each step gives', () => {
    expect(result.nodes[0].gives).toEqual([
      {key: 'token', from: 'body.token'},
      {key: 'userId', from: 'body.userId'},
    ]);
  });

  it('replaces a recorded token with a reference to the step that produced it', () => {
    // Strictly better than dropping the header: no secret is stored, and the
    // journey logs in and uses what it got instead of needing one configured.
    const headers = JSON.stringify(result.nodes.map((n) => n.request?.headers ?? {}));
    expect(headers).not.toContain('tok_9f3ac21be0');
    expect(result.nodes[1].request!.headers!.authorization).toBe('Bearer {{vars.token}}');
  });

  it('drops a credential it cannot trace back to a step here', () => {
    // A hard-coded key is a dead value from someone's session; the answer is an
    // auth scheme, not an import.
    const orphan = importHar(
      har([
        entry({
          request: {
            method: 'GET',
            url: 'https://api.test/v1/me',
            headers: [{name: 'Authorization', value: 'Bearer sk_live_hardcoded_key'}],
            queryString: [],
          },
        }),
      ]),
      'x.har',
    );
    expect(JSON.stringify(orphan.nodes[0].request)).not.toContain('sk_live');
    expect(orphan.warnings.join(' ')).toContain('Configure an auth scheme');
  });

  it('asserts the status that was actually observed', () => {
    expect(result.nodes[0].assertions).toEqual([{op: 'status', expected: 201}]);
  });

  it('does not assert a status that was an error when recorded', () => {
    // A recording of a 500 is a recording of a bug, not a contract.
    const broken = importHar(
      har([entry({response: {status: 500, content: {mimeType: 'application/json', text: '{"error":"boom"}'}}})]),
      'x.har',
    );
    expect(broken.nodes[0].assertions).toEqual([]);
    expect(broken.nodes[0].notes).toContain('500');
  });

  it('says which values it chained, because they need checking', () => {
    expect(result.warnings.join(' ')).toContain('Chained 3 values');
  });

  it('offers the hosts it saw as environments', () => {
    expect(result.servers).toEqual(['https://api.test']);
  });
});

describe('keeping the noise out', () => {
  const noisy = har([
    entry({request: {method: 'GET', url: 'https://cdn.test/app.js', headers: [], queryString: []}, response: {status: 200, content: {mimeType: 'application/javascript', text: ''}}}),
    entry({request: {method: 'GET', url: 'https://www.google-analytics.com/collect?v=1', headers: [], queryString: []}}),
    entry({request: {method: 'GET', url: 'https://api.test/v1/me', headers: [], queryString: []}}),
  ]);

  it('drops assets and analytics, and says how many', () => {
    const result = importHar(noisy, 'page.har');
    expect(result.nodes.map((n) => n.label)).toEqual(['GET /v1/me']);
    expect(result.warnings.join(' ')).toContain('Left out 2 requests');
  });

  it('keeps them when explicitly asked', () => {
    expect(importHar(noisy, 'page.har', {includeNoise: true}).nodes).toHaveLength(3);
  });

  it('can be narrowed to one host or prefix', () => {
    expect(importHar(noisy, 'page.har', {only: 'api.test'}).nodes).toHaveLength(1);
  });

  it('explains what to do when everything was filtered out', () => {
    const allNoise = har([entry({request: {method: 'GET', url: 'https://cdn.test/a.css', headers: [], queryString: []}, response: {status: 200, content: {mimeType: 'text/css', text: ''}}})]);
    const result = importHar(allNoise, 'page.har');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Fetch/XHR');
  });
});
