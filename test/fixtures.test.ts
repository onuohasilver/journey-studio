import {describe, expect, it} from 'vitest';
import {
  contentTypeFor,
  edgeCaseFixtures,
  fixtureNameFor,
  isFilePart,
  makePng,
  pngSize,
} from '../src/core/fixtures';

describe('naming a fixture', () => {
  it('cannot escape the fixtures directory', () => {
    // Names arrive from a browser upload, so they are untrusted like any other.
    expect(fixtureNameFor('../../.env')).toBe('.env'.replace(/^\./, ''));
    expect(fixtureNameFor('/etc/passwd')).toBe('passwd');
    expect(fixtureNameFor('a/b/c.png')).toBe('c.png');
  });

  it('keeps a readable name', () => {
    expect(fixtureNameFor('My Passport Scan.PNG')).toBe('my-passport-scan.png');
    expect(fixtureNameFor('receipt_2026-01.pdf')).toBe('receipt_2026-01.pdf');
  });

  it('always produces something usable', () => {
    expect(fixtureNameFor('')).toBe('file');
    expect(fixtureNameFor('...')).toBe('file');
  });

  it('knows the content type from the extension', () => {
    expect(contentTypeFor('a.png')).toBe('image/png');
    expect(contentTypeFor('a.PDF')).toBe('application/pdf');
    expect(contentTypeFor('a.unknown')).toBe('application/octet-stream');
  });
});

describe('generating a real image', () => {
  it('writes a PNG that reads back as one', () => {
    const png = makePng();
    expect(pngSize(png)).toEqual({width: 1, height: 1});
  });

  it('pads to a size while staying a valid PNG', () => {
    // The point of the size fixture: an API that rejects a fake 20MB file for
    // being corrupt has told you nothing about its size limit.
    const big = makePng(50_000);
    expect(big.length).toBeGreaterThan(49_000);
    expect(big.length).toBeLessThan(51_000);
    expect(pngSize(big)).toEqual({width: 1, height: 1});
  });

  it('ends where a PNG should', () => {
    const png = makePng(20_000);
    const tail = new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4));
    expect(tail).toBe('IEND');
  });

  it('refuses to measure something that is not a PNG', () => {
    expect(pngSize(new TextEncoder().encode('not a png at all, really'))).toBeUndefined();
    expect(pngSize(new Uint8Array(4))).toBeUndefined();
  });
});

describe('the awkward uploads', () => {
  const cases = edgeCaseFixtures(2 * 1024 * 1024);

  it('covers the ones people forget', () => {
    expect(cases.map((c) => c.name)).toEqual([
      'valid-1x1.png',
      'empty.png',
      'not-an-image.png',
      'truncated.png',
      'large.png',
    ]);
  });

  it('makes an empty file that is genuinely empty', () => {
    expect(cases.find((c) => c.name === 'empty.png')!.bytes).toHaveLength(0);
  });

  it('makes a file whose extension lies about its contents', () => {
    const liar = cases.find((c) => c.name === 'not-an-image.png')!;
    expect(pngSize(liar.bytes)).toBeUndefined();
    expect(new TextDecoder().decode(liar.bytes)).toContain('pretending');
  });

  it('makes a truncated image with a valid header', () => {
    const cut = cases.find((c) => c.name === 'truncated.png')!;
    // Header is intact — the decoder gets far enough to start, then runs out.
    expect(pngSize(cut.bytes)).toEqual({width: 1, height: 1});
    expect(cut.bytes.length).toBeLessThan(60);
  });

  it('makes a large file that is a real image', () => {
    const big = cases.find((c) => c.name === 'large.png')!;
    expect(big.bytes.length).toBeGreaterThan(1_900_000);
    expect(pngSize(big.bytes)).toEqual({width: 1, height: 1});
  });

  it('says why each one exists', () => {
    expect(cases.every((c) => c.note.length > 20)).toBe(true);
  });
});

describe('multipart parts', () => {
  it('tells a file part from a value part', () => {
    expect(isFilePart({name: 'document', file: 'passport.png'})).toBe(true);
    expect(isFilePart({name: 'type', value: 'passport'})).toBe(false);
  });
});
