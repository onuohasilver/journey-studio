// ---- Files a test uploads ----
//
// Plenty of the flows worth testing send a file: a KYC document, a receipt, a
// profile photo. Until now the tool could send JSON or text and nothing else —
// the Postman importer even says so out loud, warning that file fields "aren't
// imported, attach the file by hand", with no way to attach one by hand.
//
// Two rules shape the design.
//
// The bytes never travel through the journey file. A node references a fixture
// by name; the proxy reads it from disk on the way out — the same arrangement
// as secrets, and for the same reason. A journey stays small, reviewable, and
// diffable, which it would not be with a base64 passport scan inside it.
//
// And the fixtures worth having are mostly not the happy path. A valid photo
// tests the case that already works. The uploads that break things are the empty
// file, the one whose extension lies about its contents, and the one that is
// twenty megabytes — so those are generated rather than left to be found.

export interface Fixture {
  /** File name inside `fixtures/`, and how a node refers to it. */
  name: string;
  bytes: number;
  contentType: string;
  /** Set for images the studio could measure, for the gallery. */
  width?: number;
  height?: number;
  /** Why this one exists, for the generated edge cases. */
  note?: string;
}

/** One part of a multipart body. */
export type FormPart =
  | {name: string; value: string}
  | {name: string; file: string; filename?: string; contentType?: string};

export function isFilePart(part: FormPart): part is {name: string; file: string; filename?: string; contentType?: string} {
  return 'file' in part;
}

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  bin: 'application/octet-stream',
};

export function contentTypeFor(name: string): string {
  return TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/**
 * A name that is safe as a file and readable in a repo.
 *
 * Names arrive from a browser upload, so they are untrusted: without this a
 * fixture called `../../.env` would write wherever the process can.
 */
export function fixtureNameFor(raw: string): string {
  const cleaned = raw
    .replace(/^.*[\\/]/, '')
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/-+/g, '-');
  return cleaned || 'file';
}

// ---- generated edge cases ----

/** CRC32, needed to write a well-formed PNG chunk. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(name, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(new Uint8Array([...name, ...data])));
  return out;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A 1×1 opaque pixel, already deflated. */
const PIXEL = new Uint8Array([0x08, 0xd7, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]);

/**
 * A real PNG, padded to roughly the size asked for.
 *
 * Padding goes in a `tEXt` chunk with a correct CRC, so the result is a *valid*
 * image at any size. That matters for a limit test: an API that rejects a fake
 * 20MB file for being corrupt has not told you anything about its size limit.
 */
export function makePng(targetBytes = 0): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1); // width
  view.setUint32(4, 1); // height
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const ihdr = chunk('IHDR', header);
  const idat = chunk('IDAT', PIXEL);
  const iend = chunk('IEND', new Uint8Array(0));

  const base = SIGNATURE.length + ihdr.length + idat.length + iend.length;
  const parts: Uint8Array[] = [SIGNATURE, ihdr];

  if (targetBytes > base + 24) {
    // "Comment\0" plus filler; 12 bytes of chunk overhead on top.
    const label = new TextEncoder().encode('Comment\0');
    const filler = new Uint8Array(targetBytes - base - 12 - label.length).fill(0x20);
    parts.push(chunk('tEXt', new Uint8Array([...label, ...filler])));
  }
  parts.push(idat, iend);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface GeneratedFixture {
  name: string;
  bytes: Uint8Array;
  note: string;
}

/**
 * The uploads people forget to test.
 *
 * Generated rather than committed as binaries: a repo full of blobs is one
 * nobody reviews, and these are all a few lines to describe exactly.
 */
export function edgeCaseFixtures(largeBytes = 6 * 1024 * 1024): GeneratedFixture[] {
  return [
    {
      name: 'valid-1x1.png',
      bytes: makePng(),
      note: 'A real 1×1 PNG. The happy path, and the control for the others.',
    },
    {
      name: 'empty.png',
      bytes: new Uint8Array(0),
      note: 'Zero bytes with an image name. Plenty of upload handlers crash rather than reject.',
    },
    {
      name: 'not-an-image.png',
      bytes: new TextEncoder().encode('This is text pretending to be a PNG.\n'),
      note: 'The extension lies about the contents — does the API sniff, or trust the name?',
    },
    {
      name: 'truncated.png',
      bytes: makePng().slice(0, 30),
      note: 'A valid PNG header and nothing after it. Catches decoders that read past the end.',
    },
    {
      name: 'large.png',
      bytes: makePng(largeBytes),
      note: `A genuinely valid PNG of about ${Math.round(largeBytes / 1024 / 1024)}MB, for testing the size limit rather than the parser.`,
    },
  ];
}

/** Dimensions of a PNG, when the header is where it should be. */
export function pngSize(bytes: Uint8Array): {width: number; height: number} | undefined {
  if (bytes.length < 24) return undefined;
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return {width: view.getUint32(16), height: view.getUint32(20)};
}
