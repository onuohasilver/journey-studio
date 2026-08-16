// ---- One door for every document format ----
//
// The user drops a file; they should not have to tell us what it is. Sniffing
// the shape and dispatching keeps format knowledge out of the UI entirely — and
// means a third importer later is one case here and nothing else.

import {importCurl} from './curl';
import {importHar} from './har';
import {importOpenApi} from './openapi';
import {importPostman} from './postman';
import type {ImportResult} from './types';

export type Format = 'openapi' | 'postman' | 'har' | 'curl' | 'unknown';

/** Identify a document by its own contents, not by its file extension. */
export function detectFormat(text: string): Format {
  const head = text.slice(0, 4000);

  // Checked first and cheaply: a pasted command is not JSON or YAML, so nothing
  // below could match it anyway.
  if (/^\s*\$?\s*curl\s/i.test(head)) return 'curl';

  // Postman is always JSON and always carries a collection schema url or the
  // info/item pair.
  if (/"schema"\s*:\s*"[^"]*schema\.getpostman\.com/.test(head)) return 'postman';
  if (/"_postman_id"/.test(head)) return 'postman';

  // A HAR is JSON with a log.version/log.entries pair. Checked before OpenAPI
  // because a recording of an API's own docs would otherwise match on content.
  if (/"log"\s*:\s*\{[^}]*"(?:version|creator|entries)"/.test(head)) return 'har';

  if (/^\s*["']?openapi["']?\s*:/m.test(head)) return 'openapi';
  if (/^\s*["']?swagger["']?\s*:/m.test(head)) return 'openapi';   // reported by that importer

  if (text.trim().startsWith('{')) {
    try {
      const doc = JSON.parse(text);
      if (doc?.log && Array.isArray(doc.log.entries)) return 'har';
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
    case 'har':
      return importHar(text, filename);
    case 'curl':
      return importCurl(text, filename);
    default:
      return {
        ok: false,
        slug: '',
        title: filename ?? '',
        servers: [],
        nodes: [],
        warnings: [],
        error:
          'Not recognised as an OpenAPI document, a Postman collection, a HAR recording, or a curl command. ' +
          'OpenAPI needs an "openapi: 3.x" field; Postman needs "info" and "item"; a HAR needs "log.entries".',
      };
  }
}

export {importCurl} from './curl';
export {importHar} from './har';
export {importOpenApi} from './openapi';
export {importPostman} from './postman';
