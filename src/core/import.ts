// ---- One door for every document format ----
//
// The user drops a file; they should not have to tell us what it is. Sniffing
// the shape and dispatching keeps format knowledge out of the UI entirely — and
// means a third importer later is one case here and nothing else.

import {importOpenApi} from './openapi';
import {importPostman} from './postman';
import type {ImportResult} from './types';

export type Format = 'openapi' | 'postman' | 'unknown';

/** Identify a document by its own contents, not by its file extension. */
export function detectFormat(text: string): Format {
  const head = text.slice(0, 4000);

  // Postman is always JSON and always carries a collection schema url or the
  // info/item pair.
  if (/"schema"\s*:\s*"[^"]*schema\.getpostman\.com/.test(head)) return 'postman';
  if (/"_postman_id"/.test(head)) return 'postman';

  if (/^\s*["']?openapi["']?\s*:/m.test(head)) return 'openapi';
  if (/^\s*["']?swagger["']?\s*:/m.test(head)) return 'openapi';   // reported by that importer

  if (text.trim().startsWith('{')) {
    try {
      const doc = JSON.parse(text);
      if (doc?.openapi || doc?.swagger) return 'openapi';
      if (doc?.info && Array.isArray(doc?.item)) return 'postman';
      if (Array.isArray(doc?.requests) || doc?.order) return 'postman';  // v1, reported there
    } catch {
      /* fall through to unknown */
    }
  }
  return 'unknown';
}

/**
 * Import a document of any supported format.
 *
 * `format` may be forced when the sniff is wrong; otherwise it is detected.
 */
export function importDocument(text: string, filename?: string, format?: Format): ImportResult {
  const chosen = format && format !== 'unknown' ? format : detectFormat(text);

  switch (chosen) {
    case 'openapi':
      return importOpenApi(text, filename);
    case 'postman':
      return importPostman(text, filename);
    default:
      return {
        ok: false,
        slug: '',
        title: filename ?? '',
        servers: [],
        nodes: [],
        warnings: [],
        error:
          'Not recognised as an OpenAPI document or a Postman collection. ' +
          'OpenAPI needs an "openapi: 3.x" field; Postman needs "info" and "item".',
      };
  }
}

export {importOpenApi} from './openapi';
export {importPostman} from './postman';
