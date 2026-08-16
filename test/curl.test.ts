import {describe, expect, it} from 'vitest';
import {importCurl, parseCurl, tokenise} from '../src/core/curl';
import {detectFormat, importDocument} from '../src/core/import';

describe('splitting a command the way a shell would', () => {
  it('keeps a quoted JSON body in one piece', () => {
    // The normal case, not an edge one: JSON in single quotes with double
    // quotes inside it.
    const tokens = tokenise(`curl -X POST https://api.test/x -d '{"a":"b c"}'`);
    expect(tokens).toEqual(['curl', '-X', 'POST', 'https://api.test/x', '-d', '{"a":"b c"}']);
  });

  it('handles escapes inside double quotes, and not inside single ones', () => {
    expect(tokenise(`curl -d "say \\"hi\\""`)).toEqual(['curl', '-d', 'say "hi"']);
    expect(tokenise(`curl -d 'it\\'s'`)[2]).toContain('it');
  });

  it('joins the line continuations every docs page uses', () => {
    const tokens = tokenise('curl https://api.test/x \\\n  -H "Accept: application/json"');
    expect(tokens).toEqual(['curl', 'https://api.test/x', '-H', 'Accept: application/json']);
  });

  it('keeps an empty quoted argument', () => {
    expect(tokenise(`curl -d ''`)).toEqual(['curl', '-d', '']);
  });
});

describe('reading a curl command', () => {
  it('takes the method, url, headers and body', () => {
    const parsed = parseCurl(
      `curl -X PATCH 'https://api.test/v1/orders/42' -H 'Content-Type: application/json' -d '{"status":"settled"}'`,
    )!;
    expect(parsed.method).toBe('PATCH');
    expect(parsed.url).toBe('https://api.test/v1/orders/42');
    expect(parsed.headers['content-type']).toBe('application/json');
    expect(parsed.body).toEqual({status: 'settled'});
  });

  it("infers POST from a body, the way curl itself does", () => {
    expect(parseCurl(`curl https://api.test/x -d '{"a":1}'`)!.method).toBe('POST');
    expect(parseCurl(`curl https://api.test/x`)!.method).toBe('GET');
  });

  it('leaves a non-JSON body as text rather than mangling it', () => {
    const parsed = parseCurl(`curl https://api.test/x -d 'a=1&b=2'`)!;
    expect(parsed.body).toBe('a=1&b=2');
  });

  it('drops credentials instead of committing them', () => {
    const parsed = parseCurl(
      `curl https://api.test/x -H 'Authorization: Bearer sk_live_abc' -H 'X-API-Key: secret' -u me:pw`,
    )!;
    expect(JSON.stringify(parsed.headers)).not.toContain('sk_live_abc');
    expect(JSON.stringify(parsed.headers)).not.toContain('secret');
    expect(parsed.droppedCredentials).toContain('authorization');
    expect(parsed.droppedCredentials).toContain('basic auth');
  });

  it('ignores the flags that describe curl rather than the request', () => {
    const parsed = parseCurl(`curl -sSL --compressed -k https://api.test/x -o /tmp/out`)!;
    expect(parsed.url).toBe('https://api.test/x');
    expect(parsed.method).toBe('GET');
  });

  it('tolerates a pasted shell prompt', () => {
    expect(parseCurl(`$ curl https://api.test/x`)!.url).toBe('https://api.test/x');
  });

  it('returns nothing for something that is not curl', () => {
    expect(parseCurl('wget https://api.test/x')).toBeUndefined();
    expect(parseCurl('curl')).toBeUndefined();
  });
});

describe('the node a command becomes', () => {
  it('splits the origin off as an environment and keeps the path', () => {
    const result = importCurl(`curl 'https://api.test/v1/orders?limit=10'`, 'paste.txt');
    expect(result.ok).toBe(true);
    expect(result.servers).toEqual(['https://api.test']);
    expect(result.nodes[0].request!.path).toBe('/v1/orders?limit=10');
    expect(result.nodes[0].label).toBe('GET /v1/orders');
  });

  it('reads several commands in one paste', () => {
    const result = importCurl(
      `curl https://api.test/a\ncurl -X POST https://api.test/b -d '{"x":1}'`,
      'paste.txt',
    );
    expect(result.nodes.map((n) => n.label)).toEqual(['GET /a', 'POST /b']);
  });

  it('derives what the step needs from templates left in the command', () => {
    const result = importCurl(`curl 'https://api.test/v1/orders/{{vars.orderId}}'`, 'paste.txt');
    expect(result.nodes[0].needs).toEqual(['orderId']);
  });

  it('is detected without being told', () => {
    expect(detectFormat(`curl https://api.test/x`)).toBe('curl');
    expect(importDocument(`curl https://api.test/x`).format).toBe('curl');
  });

  it('says what is wrong when there is no command', () => {
    const result = importCurl('just some text', 'paste.txt');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('starting with "curl"');
  });
});
