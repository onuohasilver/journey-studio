// ---- Core domain types ----
//
// The whole tool rests on one idea: a request is rarely interesting on its own.
// Step three needs the token step one minted and the id step two created, so
// chaining is the primitive here rather than an afterthought.
//
// Two declarations make that work, and they are the only thing a node author has
// to get right:
//
//   needs — context keys that must exist before this node can run
//   gives — context keys this node writes once it has a response
//
// Everything else (topological order, what to warn about, whether a journey can
// run at all) is derived from those two lists.

/** Where a value lives once a node has produced it. */
export type Scope = 'vars' | 'secrets';

export type FieldKind = 'text' | 'number' | 'boolean' | 'select' | 'json' | 'secret';

/** One editable parameter on a node, rendered in the inspector. */
export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  /** Shown under the input. Say what breaks if it is wrong, not what it is. */
  help?: string;
  placeholder?: string;
  options?: {value: string; label: string}[];
  required?: boolean;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * The request a node makes. Every string here may contain {{templates}},
 * resolved against the run context immediately before the call.
 */
export interface RequestSpec {
  method: Method;
  /** Joined onto the environment's baseUrl, e.g. `/users/{{vars.userId}}`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Name of an auth scheme declared in the config. Applied server-side. */
  auth?: string;
}

/** A value the node writes into the context after a successful response. */
export interface Produces {
  /** Context key, e.g. `userId`. Written to `vars` unless scope says otherwise. */
  key: string;
  /** Path into the response, e.g. `body.data.id`, `headers.location`, `status`. */
  from: string;
  scope?: Scope;
}

export type AssertOp =
  | 'status'      // http status equals expected
  | 'eq'
  | 'neq'
  | 'exists'
  | 'absent'
  | 'contains'
  | 'matches'     // regex
  | 'gt'
  | 'lt';

export interface Assertion {
  /** Path into the response. Ignored (and may be omitted) for `status`. */
  path?: string;
  op: AssertOp;
  expected?: unknown;
  /** Shown in the log instead of the raw path when present. */
  label?: string;
}

export interface AssertionResult {
  assertion: Assertion;
  pass: boolean;
  actual: unknown;
}

/** Non-HTTP node behaviours. */
export type ControlKind =
  | 'set'        // write literal/templated values into the context
  | 'assert'     // assert against an earlier node's response
  | 'delay'      // wait
  | 'script';    // reserved

/**
 * A node definition. Definitions are registered at runtime — hand-written,
 * generated from an OpenAPI document, or contributed by a plugin — so nothing
 * about the app is specific to one API.
 */
export interface NodeDef {
  /** Unique, namespaced: `http.request`, `openapi.petstore.addPet`. */
  type: string;
  label: string;
  /** One line, plain English, for someone who has not read the API docs. */
  summary?: string;
  /** Palette grouping. Free-form so a generated pack can use the spec's tags. */
  group?: string;
  fields: Field[];
  defaults?: Record<string, unknown>;
  request?: RequestSpec;
  control?: ControlKind;
  needs: string[];
  gives: Produces[];
  /**
   * Config key whose object keys are *also* things this node gives.
   *
   * Some nodes only know what they produce once configured — "Set values" gives
   * whatever you typed into it. Without this the pre-run check would warn that a
   * perfectly good journey is missing context, which is worse than not checking.
   */
  givesFrom?: string;
  assertions?: Assertion[];
  /**
   * The success-response schema the source document declared, kept so every run
   * can check what came back against what was promised. This is the check
   * nobody has to write, and it only exists because the document was imported.
   */
  responseSchema?: unknown;
  /** The gotcha. The most valuable line a definition can carry. */
  notes?: string;
  /** Marks a node that creates or destroys real data. */
  destructive?: boolean;
}

// ---- runtime ----

export type RunStatus = 'idle' | 'queued' | 'running' | 'passed' | 'failed' | 'skipped';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

/**
 * Everything a run carries between nodes.
 *
 * `vars` is deliberately an open bag rather than a closed union of known keys:
 * the keys come from whatever nodes are loaded, and a tool that only works with
 * a hard-coded list of ids is a tool for exactly one API.
 */
export interface RunContext {
  env: string;
  vars: Record<string, unknown>;
  /** Raw responses by node id, for `{{nodes.<id>.body.x}}` lookups. */
  responses: Record<string, HttpResponse>;
  /** Names only. Values are held server-side and never sent to the browser. */
  secretNames: string[];
  runId: string;
}

export interface NodeState {
  status: RunStatus;
  response?: HttpResponse;
  assertions?: AssertionResult[];
  error?: string;
  durationMs?: number;
  /** Resolved request, kept so a failed step can be inspected as it was sent. */
  sent?: ResolvedRequest;
  /** Where the response departed from the schema the document declared. */
  contract?: import('./contract').ContractFinding[];
  /** The structural fingerprint of this response, for recording as a baseline. */
  shape?: import('./snapshot').Shape;
  /** Where the shape moved since it was recorded. */
  shapeChanges?: import('./snapshot').ShapeChange[];
  /** Set when the step took longer than the budget it declared. */
  overBudget?: {budgetMs: number; actualMs: number};
  /** Marks a state produced by a cleanup step rather than the journey proper. */
  teardown?: boolean;
}

export interface ResolvedRequest {
  method: Method;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  auth?: string;
}

/** A node placed on the canvas. */
export interface JourneyNode {
  id: string;
  type: string;
  label?: string;
  config: Record<string, unknown>;
  position: {x: number; y: number};
  /**
   * Runs after the journey finishes, whether it passed or failed.
   *
   * The failed run is precisely the one that leaves records behind — it created
   * the account and then fell over before the step that deletes it — so cleanup
   * that only happens on success cleans up exactly when there was nothing to
   * clean.
   */
  teardown?: boolean;
  /**
   * How long this step is allowed to take. A breach is reported, not failed,
   * unless the run is strict — one cold start should not turn a suite red.
   */
  budgetMs?: number;
}

export interface JourneyEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * One row of inputs to run the whole journey against.
 *
 * The same three steps against twelve rows of a spreadsheet is twelve tests for
 * the price of one, and it is where the interesting failures live: the journey
 * that works for a domestic transfer and falls over on the one to Nigeria.
 */
export interface JourneyCase {
  name: string;
  /** Seeded into the run context before the first step, as if a step gave them. */
  vars: Record<string, unknown>;
}

export interface Journey {
  name: string;
  description?: string;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  /** Run once per case when present, otherwise once with no seed. */
  cases?: JourneyCase[];
}

// ---- importing ----

/**
 * The result of turning some external document into nodes. Every importer
 * returns this shape, so the UI never has to care which format was dropped on
 * it — and adding a third format later changes nothing downstream.
 */
export interface ImportResult {
  ok: boolean;
  /** Namespace for the node types this import produced. */
  slug: string;
  title: string;
  version?: string;
  /** Base URLs the document mentions, offered as environment suggestions. */
  servers: string[];
  nodes: NodeDef[];
  /** Things that were dropped or guessed. Shown, never swallowed. */
  warnings: string[];
  error?: string;
  /** Which importer produced this. */
  format?: 'openapi' | 'postman';
}

// ---- configuration ----

export interface EnvironmentConfig {
  name: string;
  baseUrl: string;
  /** Extra headers sent with every request in this environment. */
  headers?: Record<string, string>;
}

export type AuthScheme =
  | {type: 'bearer'; token: string}
  | {type: 'header'; name: string; value: string}
  | {type: 'query'; name: string; value: string}
  | {type: 'basic'; username: string; password: string};

export interface StudioConfig {
  environments: EnvironmentConfig[];
  /** Named auth schemes a node's `request.auth` can reference. */
  auth: Record<string, AuthScheme>;
}
