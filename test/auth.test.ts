import {afterEach, describe, expect, it, vi} from 'vitest';
import {clearTokens, getToken} from '../server/auth';
import {sendRequest} from '../server/proxy';
import type {ServerConfig} from '../server/config';

const scheme = {
  type: 'oauth2' as const,
  tokenUrl: 'https://issuer.test/token',
  clientId: 'id',
  clientSecret: 'shh',
  scope: 'payments:write',
};

/** Answers token requests, and counts them. */
function issuer(over: Record<string, unknown> = {}) {
  let calls = 0;
  const fetchMock = vi.fn(async (_url: string, _init: {body: URLSearchParams; headers: Record<string, string>}) => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({access_token: `tok_${calls}`, token_type: 'Bearer', expires_in: 3600, ...over});
      },
    };
  });
  return {fetchMock, calls: () => calls};
}

afterEach(() => {
  clearTokens();
  vi.unstubAllGlobals();
});

describe('fetching a token', () => {
  it('asks the issuer once and reuses the answer', async () => {
    const {fetchMock, calls} = issuer();
    vi.stubGlobal('fetch', fetchMock);

    expect((await getToken('api', scheme)).accessToken).toBe('tok_1');
    expect((await getToken('api', scheme)).accessToken).toBe('tok_1');
    expect(calls()).toBe(1);
  });

  it('sends the grant, scope and client the way a token endpoint expects', async () => {
    const {fetchMock} = issuer();
    vi.stubGlobal('fetch', fetchMock);
    await getToken('api', scheme);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://issuer.test/token');
    expect(init.body.get('grant_type')).toBe('client_credentials');
    expect(init.body.get('scope')).toBe('payments:write');
    expect(init.body.get('client_id')).toBe('id');
    expect(init.body.get('client_secret')).toBe('shh');
  });

  it('puts the client in a Basic header when the issuer insists', async () => {
    const {fetchMock} = issuer();
    vi.stubGlobal('fetch', fetchMock);
    await getToken('api', {...scheme, clientAuth: 'basic'});

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('id:shh').toString('base64')}`);
    expect(init.body.get('client_secret')).toBeNull();
  });

  it('carries the credentials for a password grant', async () => {
    const {fetchMock} = issuer();
    vi.stubGlobal('fetch', fetchMock);
    await getToken('api', {...scheme, grant: 'password', username: 'qa', password: 'pw'});

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body.get('grant_type')).toBe('password');
    expect(init.body.get('username')).toBe('qa');
  });

  it('shares one request between callers that arrive together', async () => {
    // Twelve cases starting at once must not send twelve requests to a token
    // endpoint — plenty of providers rate-limit that hard, and a suite that
    // fails on its own auth is worse than no suite.
    const {fetchMock, calls} = issuer();
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await Promise.all(Array.from({length: 12}, () => getToken('api', scheme)));
    expect(calls()).toBe(1);
    expect(new Set(tokens.map((t) => t.accessToken)).size).toBe(1);
  });

  it('treats a token as expired before the issuer does', async () => {
    // A token that expires *during* a request is indistinguishable from a broken
    // integration, so its life is cut short by a safety margin.
    const {fetchMock} = issuer({expires_in: 20});
    vi.stubGlobal('fetch', fetchMock);

    const token = await getToken('api', scheme);
    expect(token.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  it('assumes a short life when the issuer does not say', async () => {
    const {fetchMock} = issuer({expires_in: undefined});
    vi.stubGlobal('fetch', fetchMock);
    const token = await getToken('api', scheme);
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });

  it('does not share a token between different issuers or scopes', async () => {
    const {fetchMock, calls} = issuer();
    vi.stubGlobal('fetch', fetchMock);

    await getToken('api', scheme);
    await getToken('api', {...scheme, scope: 'payments:read'});
    await getToken('api', {...scheme, tokenUrl: 'https://other.test/token'});
    expect(calls()).toBe(3);
  });

  it('surfaces the issuer’s own error, which is the part that says what to fix', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 400,
      async text() { return '{"error":"invalid_scope"}'; },
    }));
    await expect(getToken('api', scheme)).rejects.toThrow(/invalid_scope/);
  });

  it('refuses a response with no access token rather than sending "undefined"', async () => {
    vi.stubGlobal('fetch', async () => ({ok: true, status: 200, async text() { return '{"nope":1}'; }}));
    await expect(getToken('api', scheme)).rejects.toThrow(/no access_token/);
  });

  it('does not cache a failure', async () => {
    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      if (attempt === 1) return {ok: false, status: 500, async text() { return 'boom'; }};
      return {ok: true, status: 200, async text() { return '{"access_token":"good","expires_in":3600}'; }};
    });

    await expect(getToken('api', scheme)).rejects.toThrow();
    expect((await getToken('api', scheme)).accessToken).toBe('good');
  });
});

describe('using a token on a request', () => {
  const config: ServerConfig = {
    environments: [{name: 'test', baseUrl: 'https://api.test'}],
    auth: {api: scheme},
    secrets: {},
  };

  it('puts it on the request as a bearer token', async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (url: string, init: {headers: Record<string, string>}) => {
      if (String(url).includes('issuer')) {
        return {ok: true, status: 200, async text() { return '{"access_token":"tok","expires_in":3600}'; }};
      }
      seen.push(init.headers);
      return {ok: true, status: 200, headers: new Map(), async text() { return '{}'; }};
    });

    await sendRequest({method: 'GET', url: '/thing', headers: {}, auth: 'api'}, 'test', config);
    expect(seen[0].authorization).toBe('Bearer tok');
  });

  it('refreshes once and retries when the API rejects a cached token', async () => {
    // Tokens get revoked early. One retry recovers; a loop would turn a bad
    // credential into a denial-of-service against your own auth server.
    let issued = 0;
    let apiCalls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('issuer')) {
        issued += 1;
        return {ok: true, status: 200, async text() { return `{"access_token":"tok_${issued}","expires_in":3600}`; }};
      }
      apiCalls += 1;
      const status = apiCalls === 1 ? 401 : 200;
      return {ok: status === 200, status, headers: new Map(), async text() { return '{}'; }};
    });

    const result = await sendRequest({method: 'GET', url: '/thing', headers: {}, auth: 'api'}, 'test', config);
    expect(result.status).toBe(200);
    expect(issued).toBe(2);
    expect(apiCalls).toBe(2);
  });

  it('gives up after one retry rather than hammering the issuer', async () => {
    let apiCalls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('issuer')) {
        return {ok: true, status: 200, async text() { return '{"access_token":"tok","expires_in":3600}'; }};
      }
      apiCalls += 1;
      return {ok: false, status: 401, headers: new Map(), async text() { return '{}'; }};
    });

    const result = await sendRequest({method: 'GET', url: '/thing', headers: {}, auth: 'api'}, 'test', config);
    // The 401 is returned to the journey to assert on, not swallowed.
    expect(result.status).toBe(401);
    expect(apiCalls).toBe(2);
  });

  it('does not retry a 401 for a static scheme, which cannot be refreshed', async () => {
    let apiCalls = 0;
    vi.stubGlobal('fetch', async () => {
      apiCalls += 1;
      return {ok: false, status: 401, headers: new Map(), async text() { return '{}'; }};
    });

    const staticConfig: ServerConfig = {...config, auth: {api: {type: 'bearer', token: 'fixed'}}};
    await sendRequest({method: 'GET', url: '/thing', headers: {}, auth: 'api'}, 'test', staticConfig);
    expect(apiCalls).toBe(1);
  });
});
