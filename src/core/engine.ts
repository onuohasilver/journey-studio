// ---- The runner ----
//
// Walks the journey in topological order and threads one context through it.
// The engine never talks to the network itself: it hands a resolved request to
// a `Transport`, which in the app is the proxy (so credentials stay server-side)
// and in tests is a stub. That split is what makes the whole thing testable
// without a server and safe without a secret in the browser.

import {runAssertions, describeFailure} from './assert';
import {downstreamOf, topoOrder} from './graph';
import {readResponse, resolve} from './template';
import type {
  Assertion,
  HttpResponse,
  Journey,
  JourneyNode,
  NodeDef,
  NodeState,
  Produces,
  ResolvedRequest,
  RunContext,
} from './types';

export interface Transport {
  send(request: ResolvedRequest, env: string): Promise<HttpResponse>;
}

export interface RunHooks {
  onNodeStart?(nodeId: string): void;
  onNodeEnd?(nodeId: string, state: NodeState): void;
  onContext?(ctx: RunContext): void;
  onLog?(line: string): void;
  /** Return false to stop before this node runs. */
  beforeNode?(node: JourneyNode, ctx: RunContext): boolean | Promise<boolean>;
}

export interface RunOptions {
  env: string;
  lookup(type: string): NodeDef | undefined;
  transport: Transport;
  hooks?: RunHooks;
  /** Run only this node and everything downstream of it. */
  startAt?: string;
  /** Responses to reuse for nodes that are skipped by `startAt`. */
  priorResponses?: Record<string, HttpResponse>;
  /** Abort between steps. */
  signal?: AbortSignal;
}

export interface RunResult {
  context: RunContext;
  states: Record<string, NodeState>;
  passed: boolean;
}

function newContext(env: string, priorResponses: Record<string, HttpResponse> = {}): RunContext {
  return {
    env,
    vars: {},
    responses: {...priorResponses},
    secretNames: [],
    runId: `run_${Date.now().toString(36)}`,
  };
}

/** Merge a node's config over its definition's defaults. */
function settings(def: NodeDef, node: JourneyNode): Record<string, unknown> {
  return {...(def.defaults ?? {}), ...node.config};
}

/**
 * Build the request for one node.
 *
 * Node config is folded in before templates are resolved, so a field the user
 * typed can itself contain `{{vars.x}}` — which is how a generated OpenAPI node
 * with a `petId` field participates in chaining without any special casing.
 */
export function buildRequest(
  def: NodeDef,
  node: JourneyNode,
  ctx: RunContext,
): ResolvedRequest | undefined {
  if (!def.request) return undefined;
  const cfg = settings(def, node);

  // Config values are visible to templates as `{{fields.x}}` and, for
  // convenience, by bare name when they do not collide with a context var.
  const scope: RunContext = {...ctx, vars: {...ctx.vars, ...cfg, fields: cfg}};

  const spec = def.request;
  const path = String(resolve(spec.path, scope));
  const query = spec.query ? (resolve(spec.query, scope) as Record<string, string>) : undefined;
  const search = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';

  return {
    method: spec.method,
    url: search ? `${path}?${search}` : path,
    headers: (resolve(spec.headers ?? {}, scope) as Record<string, string>) ?? {},
    body: spec.body === undefined ? undefined : resolve(spec.body, scope),
    auth: spec.auth,
  };
}

/** Write a node's declared outputs into the context. */
function extract(gives: Produces[], res: HttpResponse, ctx: RunContext, log?: (s: string) => void) {
  for (const give of gives) {
    const value = readResponse(res, give.from);
    if (value === undefined) {
      log?.(`  ! ${give.key} not found at ${give.from} — later steps that need it will fail`);
      continue;
    }
    if (give.scope === 'secrets') {
      // Only the name travels; the value is handed to the proxy's store.
      if (!ctx.secretNames.includes(give.key)) ctx.secretNames.push(give.key);
    }
    ctx.vars[give.key] = value;
  }
}

async function runControl(
  def: NodeDef,
  node: JourneyNode,
  ctx: RunContext,
): Promise<{ok: true} | {ok: false; error: string}> {
  const cfg = settings(def, node);
  switch (def.control) {
    case 'set': {
      const values = (cfg.values ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(resolve(values, ctx))) ctx.vars[k] = v;
      return {ok: true};
    }
    case 'delay': {
      const ms = Number(cfg.ms ?? 1000);
      await new Promise((r) => setTimeout(r, ms));
      return {ok: true};
    }
    case 'assert': {
      const ref = String(cfg.nodeRef ?? '');
      const res = ctx.responses[ref];
      if (!res) return {ok: false, error: `No response from "${ref}" to assert against.`};
      const results = runAssertions(res, (cfg.assertions ?? []) as Assertion[]);
      const failed = results.filter((r) => !r.pass);
      return failed.length
        ? {ok: false, error: failed.map(describeFailure).join('; ')}
        : {ok: true};
    }
    default:
      return {ok: true};
  }
}

export async function runJourney(journey: Journey, opts: RunOptions): Promise<RunResult> {
  const {env, lookup, transport, hooks, signal} = opts;
  const ctx = newContext(env, opts.priorResponses);
  const states: Record<string, NodeState> = {};

  // Reusing an earlier run's responses is what makes "run from here" cheap —
  // upstream steps that already created an account are not run again.
  for (const [id, res] of Object.entries(opts.priorResponses ?? {})) {
    states[id] = {status: 'skipped', response: res};
  }

  const ordered = topoOrder(journey.nodes, journey.edges);
  const wanted = opts.startAt ? downstreamOf(opts.startAt, journey.edges) : null;

  // Replay what the skipped nodes gave, or the ones we do run start blind.
  if (wanted) {
    for (const node of ordered) {
      if (wanted.has(node.id)) continue;
      const def = lookup(node.type);
      const res = ctx.responses[node.id];
      if (def && res) extract(def.gives, res, ctx);
    }
  }

  let passed = true;

  for (const node of ordered) {
    if (signal?.aborted) break;
    if (wanted && !wanted.has(node.id)) continue;

    const def = lookup(node.type);
    const label = node.label ?? def?.label ?? node.type;

    if (!def) {
      states[node.id] = {status: 'failed', error: `Unknown node type "${node.type}".`};
      hooks?.onLog?.(`✗ ${label} — unknown node type`);
      passed = false;
      break;
    }

    if (hooks?.beforeNode && (await hooks.beforeNode(node, ctx)) === false) {
      states[node.id] = {status: 'skipped'};
      continue;
    }

    hooks?.onNodeStart?.(node.id);
    states[node.id] = {status: 'running'};
    const started = Date.now();

    try {
      if (def.control) {
        const result = await runControl(def, node, ctx);
        const state: NodeState = result.ok
          ? {status: 'passed', durationMs: Date.now() - started}
          : {status: 'failed', error: result.error, durationMs: Date.now() - started};
        states[node.id] = state;
        hooks?.onLog?.(result.ok ? `✓ ${label}` : `✗ ${label} — ${result.error}`);
        hooks?.onNodeEnd?.(node.id, state);
        if (!result.ok) { passed = false; break; }
        hooks?.onContext?.(ctx);
        continue;
      }

      const request = buildRequest(def, node, ctx)!;
      const res = await transport.send(request, env);
      ctx.responses[node.id] = res;

      const assertions = runAssertions(res, def.assertions);
      const failed = assertions.filter((a) => !a.pass);
      const state: NodeState = {
        status: failed.length ? 'failed' : 'passed',
        response: res,
        assertions,
        sent: request,
        durationMs: Date.now() - started,
        ...(failed.length ? {error: failed.map(describeFailure).join('; ')} : {}),
      };
      states[node.id] = state;

      if (failed.length) {
        hooks?.onLog?.(`✗ ${label} — ${state.error}`);
        hooks?.onNodeEnd?.(node.id, state);
        passed = false;
        break;
      }

      extract(def.gives, res, ctx, hooks?.onLog);
      hooks?.onLog?.(`✓ ${label} · ${res.status} · ${res.durationMs}ms`);
      hooks?.onNodeEnd?.(node.id, state);
      hooks?.onContext?.(ctx);
    } catch (err) {
      const state: NodeState = {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
      states[node.id] = state;
      hooks?.onLog?.(`✗ ${label} — ${state.error}`);
      hooks?.onNodeEnd?.(node.id, state);
      passed = false;
      break;
    }
  }

  return {context: ctx, states, passed};
}
