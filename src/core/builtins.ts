// ---- Nodes that ship with the tool ----
//
// Deliberately few. Everything API-specific comes from an imported document;
// these are the pieces no document can describe — a raw request for the endpoint
// nobody wrote down, and the control steps that make a chain a journey rather
// than a list.

import type {Method, NodeDef} from './types';

export const HTTP_REQUEST: NodeDef = {
  type: 'http.request',
  label: 'HTTP request',
  summary: 'Call any path on the selected environment.',
  group: 'Building blocks',
  fields: [
    {
      key: 'method',
      label: 'Method',
      kind: 'select',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((v) => ({value: v, label: v})),
    },
    {key: 'path', label: 'Path', kind: 'text', placeholder: '/users/{{vars.userId}}', required: true},
    {key: 'headers', label: 'Headers', kind: 'json'},
    {key: 'body', label: 'Body', kind: 'json'},
    {key: 'auth', label: 'Auth scheme', kind: 'text', help: 'Name of a scheme from your config. Left blank, the request is unauthenticated.'},
  ],
  defaults: {method: 'GET', path: '/', headers: {}, body: undefined, auth: ''},
  request: {
    method: 'GET',   // overridden per node from config below
    path: '{{fields.path}}',
    headers: {},
  },
  needs: [],
  gives: [],
  assertions: [],
};

export const SET_VALUES: NodeDef = {
  type: 'control.set',
  label: 'Set values',
  summary: 'Write values into the run context for later steps to use.',
  group: 'Building blocks',
  control: 'set',
  givesFrom: 'values',
  fields: [{key: 'values', label: 'Values', kind: 'json', help: 'Each key becomes a context value. Values may use {{templates}}.'}],
  defaults: {values: {}},
  needs: [],
  gives: [],
};

export const ASSERT: NodeDef = {
  type: 'control.assert',
  label: 'Assert',
  summary: "Check a value on an earlier step's response.",
  group: 'Building blocks',
  control: 'assert',
  fields: [
    {key: 'nodeRef', label: 'Step id', kind: 'text', required: true, help: 'The id of the step whose response to check.'},
    {key: 'assertions', label: 'Assertions', kind: 'json'},
  ],
  defaults: {nodeRef: '', assertions: [{path: 'status', op: 'eq', expected: 200}]},
  needs: [],
  gives: [],
};

export const DELAY: NodeDef = {
  type: 'control.delay',
  label: 'Wait',
  summary: 'Pause before the next step — for eventually-consistent APIs.',
  group: 'Building blocks',
  control: 'delay',
  fields: [{key: 'ms', label: 'Milliseconds', kind: 'number'}],
  defaults: {ms: 1000},
  needs: [],
  gives: [],
};

export const BUILTINS: NodeDef[] = [HTTP_REQUEST, SET_VALUES, ASSERT, DELAY];

/**
 * The raw HTTP node is the one definition whose request is not fixed: its
 * method, headers and body come from what the user typed. Resolving that here
 * keeps the engine free of node-type special cases.
 */
export function materialise(def: NodeDef, config: Record<string, unknown>): NodeDef {
  if (def.type !== 'http.request' || !def.request) return def;
  const merged = {...def.defaults, ...config};
  const hasBody = merged.body !== undefined && merged.body !== '' && merged.body !== null;
  return {
    ...def,
    request: {
      method: String(merged.method ?? 'GET').toUpperCase() as Method,
      path: '{{fields.path}}',
      headers: (merged.headers as Record<string, string>) ?? {},
      ...(hasBody ? {body: '{{fields.body}}'} : {}),
      ...(merged.auth ? {auth: String(merged.auth)} : {}),
    },
  };
}
