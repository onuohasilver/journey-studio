// ---- Checking a response against the contract the API published ----
//
// This is the one check nobody has to write. The imported document already
// declares what each response looks like, so every run can compare what came
// back against what was promised — and the interesting failures are the ones
// no hand-written assertion would have anticipated:
//
//   a required field quietly disappeared
//   a string became a number
//   an enum grew a value the client will not understand
//   a nullable-by-accident field arrived null
//
// Assertions test what you thought to check. This tests what the API said.
//
// Deliberately a *subset* of JSON Schema — the parts OpenAPI documents actually
// use. Anything unrecognised is skipped rather than guessed at, because a false
// finding in a QA report is worse than a missing one: people stop reading.

export type FindingKind =
  | 'missing-required'
  | 'type-mismatch'
  | 'enum-mismatch'
  | 'unexpected-null'
  | 'undocumented-field';

export interface ContractFinding {
  kind: FindingKind;
  /** Dotted path into the body, e.g. `data.items.0.id`. */
  path: string;
  expected?: string;
  actual?: string;
  /** `error` breaks a documented promise; `warn` is drift worth knowing about. */
  severity: 'error' | 'warn';
  message: string;
}

export interface ContractOptions {
  /**
   * Report fields the schema does not mention. Off by default: most APIs add
   * fields freely and additive change is not a regression, so on by default this
   * would bury the real findings.
   */
  reportUndocumented?: boolean;
  /** Stop after this many, so one wrong array doesn't produce 4,000 lines. */
  limit?: number;
}

type Schema = Record<string, any>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Does a value satisfy a declared JSON-Schema type? */
function typeMatches(declared: string, value: unknown): boolean {
  const actual = typeOf(value);
  switch (declared) {
    case 'integer':
      return actual === 'number' && Number.isInteger(value);
    case 'number':
      return actual === 'number';
    case 'string':
      return actual === 'string';
    case 'boolean':
      return actual === 'boolean';
    case 'array':
      return actual === 'array';
    case 'object':
      return actual === 'object';
    case 'null':
      return actual === 'null';
    default:
      return true;   // unknown type keyword — not ours to judge
  }
}

function join(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

/**
 * Compare a response body against a schema.
 *
 * Composition keywords (`oneOf`, `anyOf`, `allOf`) are handled loosely: a value
 * that satisfies *any* branch passes, and if none do we report the mismatch once
 * at that level rather than inventing findings for every branch.
 */
export function checkContract(
  schema: unknown,
  body: unknown,
  options: ContractOptions = {},
): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const limit = options.limit ?? 50;

  const walk = (s: Schema | undefined, value: unknown, path: string): void => {
    if (findings.length >= limit || !s || typeof s !== 'object') return;

    // `nullable: true` (OpenAPI 3.0) and `type: [x, 'null']` (3.1) both allow null.
    const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    const nullable = Boolean(s.nullable) || types.includes('null');

    if (value === null) {
      if (types.length && !nullable) {
        findings.push({
          kind: 'unexpected-null',
          path: path || '(body)',
          expected: types.join(' | '),
          actual: 'null',
          severity: 'error',
          message: `${path || 'the body'} was null, but the spec declares it as ${types.join(' | ')}`,
        });
      }
      return;
    }

    const branches: Schema[] = s.oneOf ?? s.anyOf ?? [];
    if (branches.length) {
      const anyMatch = branches.some((branch) => checkContract(branch, value, {limit: 1}).length === 0);
      if (!anyMatch) {
        findings.push({
          kind: 'type-mismatch',
          path: path || '(body)',
          expected: 'one of the documented shapes',
          actual: typeOf(value),
          severity: 'error',
          message: `${path || 'the body'} matched none of the shapes the spec allows`,
        });
      }
      return;
    }
    if (Array.isArray(s.allOf)) {
      for (const branch of s.allOf) walk(branch, value, path);
      return;
    }

    if (types.length) {
      const concrete = types.filter((t) => t !== 'null');
      if (concrete.length && !concrete.some((t) => typeMatches(t, value))) {
        findings.push({
          kind: 'type-mismatch',
          path: path || '(body)',
          expected: concrete.join(' | '),
          actual: typeOf(value),
          severity: 'error',
          message: `${path || 'the body'} is ${typeOf(value)}, but the spec declares ${concrete.join(' | ')}`,
        });
        return;   // no point walking into a value of the wrong shape
      }
    }

    if (Array.isArray(s.enum) && s.enum.length && !s.enum.includes(value as never)) {
      findings.push({
        kind: 'enum-mismatch',
        path: path || '(body)',
        expected: s.enum.map(String).join(' | '),
        actual: JSON.stringify(value),
        severity: 'error',
        message: `${path || 'the body'} is ${JSON.stringify(value)}, which the spec does not list`,
      });
    }

    if (typeOf(value) === 'object') {
      const object = value as Record<string, unknown>;
      const properties: Record<string, Schema> = s.properties ?? {};

      for (const key of s.required ?? []) {
        if (!(key in object)) {
          findings.push({
            kind: 'missing-required',
            path: join(path, key),
            expected: 'present',
            actual: 'missing',
            severity: 'error',
            message: `${join(path, key)} is required by the spec but was not returned`,
          });
        }
      }

      for (const [key, child] of Object.entries(properties)) {
        if (key in object) walk(child, object[key], join(path, key));
      }

      if (options.reportUndocumented && Object.keys(properties).length && s.additionalProperties !== true) {
        for (const key of Object.keys(object)) {
          if (key in properties) continue;
          findings.push({
            kind: 'undocumented-field',
            path: join(path, key),
            severity: 'warn',
            message: `${join(path, key)} was returned but the spec does not document it`,
          });
        }
      }
    }

    if (typeOf(value) === 'array' && s.items) {
      // Checking every element of a 500-item list produces a wall of identical
      // findings; the first few carry the same information.
      const list = value as unknown[];
      for (let i = 0; i < Math.min(list.length, 5); i++) walk(s.items, list[i], join(path, i));
    }
  };

  walk(schema as Schema, body, '');
  return findings.slice(0, limit);
}

/** One line for a report or a log. */
export function summariseContract(findings: ContractFinding[]): string {
  if (!findings.length) return 'matches the spec';
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.length - errors;
  const parts = [];
  if (errors) parts.push(`${errors} contract break${errors === 1 ? '' : 's'}`);
  if (warns) parts.push(`${warns} undocumented field${warns === 1 ? '' : 's'}`);
  return parts.join(', ');
}
