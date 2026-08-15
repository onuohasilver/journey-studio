// ---- Assertions ----
//
// A journey that "ran" is not the same as a journey that worked: plenty of APIs
// answer 200 with a body that says the thing failed. Assertions are how a step
// states what it actually expected, and they are what makes a saved journey a
// regression test rather than a recording.

import {readResponse} from './template';
import type {Assertion, AssertionResult, HttpResponse} from './types';

function compare(op: Assertion['op'], actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'status':
      return Number(actual) === Number(expected);
    case 'eq':
      // Loose on purpose: `"200"` from a header and `200` from a body should
      // both satisfy `eq: 200`. Deep values fall back to structural equality.
      if (typeof actual === 'object' || typeof expected === 'object') {
        return JSON.stringify(actual) === JSON.stringify(expected);
      }
      return String(actual) === String(expected);
    case 'neq':
      return !compare('eq', actual, expected);
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'absent':
      return actual === undefined || actual === null;
    case 'contains':
      if (Array.isArray(actual)) return actual.some((v) => compare('eq', v, expected));
      return String(actual ?? '').includes(String(expected));
    case 'matches':
      try {
        return new RegExp(String(expected)).test(String(actual ?? ''));
      } catch {
        return false;   // an unparseable pattern is a failed assertion, not a crash
      }
    case 'gt':
      return Number(actual) > Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    default:
      return false;
  }
}

export function runAssertions(res: HttpResponse, assertions: Assertion[] = []): AssertionResult[] {
  return assertions.map((assertion) => {
    const actual = assertion.op === 'status' ? res.status : readResponse(res, assertion.path ?? '');
    return {assertion, actual, pass: compare(assertion.op, actual, assertion.expected)};
  });
}

/** One line for the log. Says what was expected *and* what arrived. */
export function describeFailure(result: AssertionResult): string {
  const {assertion: a, actual} = result;
  const subject = a.label ?? (a.op === 'status' ? 'status' : a.path ?? 'response');
  const got = actual === undefined ? 'nothing' : JSON.stringify(actual);
  switch (a.op) {
    case 'exists':
      return `${subject} was missing`;
    case 'absent':
      return `${subject} should have been absent, got ${got}`;
    default:
      return `${subject} expected ${a.op} ${JSON.stringify(a.expected)}, got ${got}`;
  }
}
