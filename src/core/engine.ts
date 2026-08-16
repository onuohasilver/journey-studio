// ---- The runner ----
//
// Walks the journey in topological order and threads one context through it.
// The engine never talks to the network itself: it hands a resolved request to
// a `Transport`, which in the app is the proxy (so credentials stay server-side)
// and in tests is a stub. That split is what makes the whole thing testable
// without a server and safe without a secret in the browser.

import {runAssertions, describeFailure} from './assert';
import {checkContract, summariseContract, type ContractOptions} from './contract';
import {diffShape, shapeOf, summariseShape, type Shape} from './snapshot';
import {
  asResponse,
  readHook,
  type HookMatch,
  type HookMock,
  type InboxSource,
  type ReceivedHook,
} from './inbox';
import {downstreamOf, topoOrder} from './graph';
import {readResponse, resolve} from './template';
import type {
  Assertion,
  HttpResponse,
  Journey,
  JourneyCase,
  JourneyNode,
  NodeDef,
  NodeState,
  Produces,
  ResolvedRequest,
  RunContext,
  RunStatus,
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
  /** How picky the contract check is. */
  contract?: ContractOptions;
  /** Treat a contract break as a step failure. Off by default. */
  strictContract?: boolean;
  /** Recorded response shapes by node id, to compare this run against. */
  baseline?: Record<string, Shape>;
  /** Treat a shape break as a step failure. Off by default. */
  strictSnapshot?: boolean;
  /** Treat a blown timing budget as a step failure. Off by default. */
  strictBudget?: boolean;
  /** Context values to start with — one row of a data-driven run. */
  seed?: Record<string, unknown>;
  /** Where "wait for a webhook" steps look for their delivery. */
  inbox?: InboxSource;
  /**
   * Saved payloads to deliver instead of waiting for the real integration.
   *
   * Present only when the run explicitly asked for it. Never a fallback for a
   * webhook that failed to arrive — that would be a test that passes while the
   * integration is broken.
   */
  mocks?: Record<string, HookMock>;
}

export interface RunResult {
  context: RunContext;
  states: Record<string, NodeState>;
  passed: boolean;
  /** Cleanup steps that failed — i.e. data this run could not take back. */
  leaked: string[];
}

function newContext(
  env: string,
  priorResponses: Record<string, HttpResponse> = {},
  seed: Record<string, unknown> = {},
): RunContext {
  return {
    env,
    // A case's values are seeded exactly as if an earlier step had produced
    // them, which is why data-driven runs need no support anywhere else: an
    // imported `/pets/{petId}` node already reads `{{vars.petId}}`.
    vars: {...seed},
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

  // Config is resolved against the context *first*, because a field's value is
  // itself commonly a template: an imported path parameter defaults to
  // `{{vars.petId}}`, and that is the entire mechanism by which an imported
  // document chains. Resolving only the request would put the literal
  // `{{vars.petId}}` in the URL.
  const cfg = resolve(settings(def, node), ctx) as Record<string, unknown>;

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

/** How often the inbox is asked. Small enough to feel instant, large enough not to spin. */
const POLL_MS = 250;

/** Stamped by the studio on a delivery someone fired by hand. */
export const MOCK_HEADER = 'x-journey-studio-mock';

interface AwaitOutcome {
  ok: boolean;
  hook?: ReceivedHook;
  mocked?: boolean;
  error?: string;
  captured: Record<string, unknown>;
}

/**
 * Block until a webhook belonging to this step arrives.
 *
 * The correlation config is what makes this usable for more than a demo: with a
 * dozen cases in flight, "the next delivery on /payments" is the wrong one most
 * of the time. Matching on a value the run itself produced is the only way each
 * row claims its own callback.
 */
async function awaitHook(
  def: NodeDef,
  node: JourneyNode,
  ctx: RunContext,
  opts: RunOptions,
  since: string,
): Promise<AwaitOutcome> {
  const cfg = resolve(settings(def, node), ctx) as Record<string, unknown>;
  const match: HookMatch = {
    path: cfg.path ? String(cfg.path) : undefined,
    correlateOn: cfg.correlateOn ? String(cfg.correlateOn) : undefined,
    equals: cfg.equals,
  };
  const capture = (cfg.capture ?? {}) as Record<string, string>;
  const timeoutMs = Number(cfg.timeoutMs ?? 30_000);

  const take = (hook: ReceivedHook, mocked: boolean): AwaitOutcome => {
    const captured: Record<string, unknown> = {};
    for (const [key, from] of Object.entries(capture)) {
      const value = readHook(hook, from);
      if (value !== undefined) captured[key] = value;
    }
    // A delivery fired by hand from the studio is stamped on the way in. The
    // step really did wait for it, but the payload was still canned, and a green
    // run must never read as proof the integration works when it does not.
    const byHand = Boolean(hook.headers?.[MOCK_HEADER]);
    return {ok: true, hook, mocked: mocked || byHand, captured};
  };

  // Mocked delivery is a separate path rather than a fallback, so a mocked run
  // can never be mistaken for one where the integration actually fired.
  if (opts.mocks) {
    const wanted = cfg.mock ? String(cfg.mock) : undefined;
    const mock =
      (wanted && opts.mocks[wanted]) ??
      Object.values(opts.mocks).find((m) => !match.path || m.path === match.path);
    if (!mock) {
      return {
        ok: false,
        captured: {},
        error: wanted
          ? `No saved webhook called "${wanted}". Record one from the inbox first.`
          : `No saved webhook for path "${match.path ?? '(any)'}".`,
      };
    }
    if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
    // The body is resolved against the context, so a mock can echo back the
    // reference this run generated rather than a hard-coded one.
    return take(
      {
        id: `mock_${mock.name}`,
        at: new Date().toISOString(),
        method: mock.method ?? 'POST',
        path: mock.path,
        headers: mock.headers ?? {},
        query: {},
        body: resolve(mock.body, ctx),
      },
      true,
    );
  }

  if (!opts.inbox) {
    return {ok: false, captured: {}, error: 'No webhook inbox is available for this run.'};
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hook = await opts.inbox.claim(match, {since, by: node.id});
    if (hook) return take(hook, false);
    if (opts.signal?.aborted) return {ok: false, captured: {}, error: 'stopped while waiting'};
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
  }

  // What arrived but did not match is the single most useful thing to say here —
  // it is the difference between "the provider never called" and "it called with
  // a reference you are not matching on".
  const near = (await opts.inbox.describeUnmatched?.(since)) ?? [];
  const waited = `${(timeoutMs / 1000).toFixed(0)}s`;
  const wanted = match.correlateOn
    ? ` where ${match.correlateOn} = ${JSON.stringify(match.equals)}`
    : '';
  return {
    ok: false,
    captured: {},
    error:
      `Waited ${waited} for a webhook on "${match.path ?? '(any path)'}"${wanted} and none arrived.` +
      (near.length ? ` ${near.length} other deliver${near.length === 1 ? 'y' : 'ies'} did: ${near.slice(0, 3).join('; ')}` : ''),
  };
}

export async function runJourney(journey: Journey, opts: RunOptions): Promise<RunResult> {
  const {env, lookup, transport, hooks, signal} = opts;
  const ctx = newContext(env, opts.priorResponses, opts.seed);
  const states: Record<string, NodeState> = {};

  // Reusing an earlier run's responses is what makes "run from here" cheap —
  // upstream steps that already created an account are not run again.
  for (const [id, res] of Object.entries(opts.priorResponses ?? {})) {
    states[id] = {status: 'skipped', response: res};
  }

  // Deliveries older than the run belong to a previous one. Stamped before the
  // first step so a webhook that arrives while step one is still in flight — the
  // common case with a fast provider — is still claimable when step three asks.
  const since = new Date().toISOString();

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

  /**
   * Run one node and record its state.
   *
   * Extracted so the main pass and the teardown pass execute steps identically —
   * a cleanup step that behaved subtly differently from a normal one is a bug
   * waiting to happen in the code nobody watches.
   */
  const runOne = async (node: JourneyNode): Promise<RunStatus> => {
    const def = lookup(node.type);
    const label = node.label ?? def?.label ?? node.type;

    if (!def) {
      states[node.id] = {status: 'failed', error: `Unknown node type "${node.type}".`};
      hooks?.onLog?.(`✗ ${label} — unknown node type`);
      return 'failed';
    }

    if (hooks?.beforeNode && (await hooks.beforeNode(node, ctx)) === false) {
      states[node.id] = {status: 'skipped'};
      return 'skipped';
    }

    hooks?.onNodeStart?.(node.id);
    states[node.id] = {status: 'running'};
    const started = Date.now();

    try {
      if (def.control === 'await') {
        const outcome = await awaitHook(def, node, ctx, opts, since);
        const state: NodeState = {
          ...(outcome.ok ? {status: 'passed' as RunStatus} : {status: 'failed' as RunStatus, error: outcome.error}),
          durationMs: Date.now() - started,
          ...(outcome.hook ? {response: asResponse(outcome.hook)} : {}),
          ...(outcome.mocked ? {mocked: true} : {}),
          ...(node.teardown ? {teardown: true} : {}),
        };

        if (outcome.ok && outcome.hook) {
          // Stored as a response, which is what makes every downstream mechanism
          // work on a webhook without knowing it is one.
          ctx.responses[node.id] = asResponse(outcome.hook);
          for (const [key, value] of Object.entries(outcome.captured)) ctx.vars[key] = value;
          extract(def.gives, ctx.responses[node.id], ctx, hooks?.onLog);
        }

        states[node.id] = state;
        hooks?.onLog?.(
          outcome.ok
            ? `✓ ${label} · webhook${outcome.mocked ? ' (mocked)' : ''} · ${state.durationMs}ms`
            : `✗ ${label} — ${outcome.error}`,
        );
        hooks?.onNodeEnd?.(node.id, state);
        if (outcome.ok) hooks?.onContext?.(ctx);
        return state.status;
      }

      if (def.control) {
        const result = await runControl(def, node, ctx);
        const state: NodeState = {
          ...(result.ok
            ? {status: 'passed' as RunStatus}
            : {status: 'failed' as RunStatus, error: result.error}),
          durationMs: Date.now() - started,
          ...(node.teardown ? {teardown: true} : {}),
        };
        states[node.id] = state;
        hooks?.onLog?.(result.ok ? `✓ ${label}` : `✗ ${label} — ${result.error}`);
        hooks?.onNodeEnd?.(node.id, state);
        if (result.ok) hooks?.onContext?.(ctx);
        return state.status;
      }

      const request = buildRequest(def, node, ctx)!;

      // Checks that must hold, and checks worth waiting for. The second list is
      // what replaces a fixed sleep: re-ask until the order says settled, rather
      // than sleeping five seconds and hoping.
      const must = [...(def.assertions ?? []), ...(node.assertions ?? [])];
      const until = node.until ?? [];
      const deadline = until.length ? Date.now() + (node.pollTimeoutMs ?? 30_000) : 0;
      const everyMs = Math.max(50, node.pollEveryMs ?? 1_000);

      let res: HttpResponse;
      let assertions: ReturnType<typeof runAssertions>;
      let failed: ReturnType<typeof runAssertions>;
      let attempts = 0;

      for (;;) {
        attempts += 1;
        res = await transport.send(request, env);
        assertions = [...runAssertions(res, must), ...runAssertions(res, until)];
        failed = assertions.filter((a) => !a.pass);

        if (!failed.length || !until.length) break;
        if (Date.now() + everyMs > deadline || opts.signal?.aborted) break;
        await new Promise((r) => setTimeout(r, everyMs));
      }

      ctx.responses[node.id] = res;

      // The response is checked against the schema the source document declared.
      //
      // Only for a success status: the schema we captured is the 2xx one, and an
      // error body was never meant to match it. Checking a 500 against it
      // produces a finding that is technically true and completely useless —
      // and one false finding is all it takes for people to stop reading the
      // report.
      const success = res.status >= 200 && res.status < 300;
      const contract = def.responseSchema && success
        ? checkContract(def.responseSchema, res.body, opts.contract)
        : [];
      const contractBreaks = contract.filter((f) => f.severity === 'error');

      // The shape is recorded for every success whether or not a baseline
      // exists, so recording one after the fact never needs another run — and
      // for the many APIs that published no schema at all, this is the only
      // description of the contract there is.
      const shape = success ? shapeOf(res.body) : undefined;
      const recorded = opts.baseline?.[node.id];
      const shapeChanges = shape && recorded ? diffShape(recorded, shape) : [];
      const shapeBreaks = shapeChanges.filter((c) => c.severity === 'error');

      // A step can declare how long it is allowed to take. The response's own
      // duration is used rather than the wall clock around it, so assertion and
      // contract work is not billed to the API being measured.
      const overBudget =
        node.budgetMs && res.durationMs > node.budgetMs
          ? {budgetMs: node.budgetMs, actualMs: res.durationMs}
          : undefined;

      const drifted =
        (opts.strictContract && contractBreaks.length) ||
        (opts.strictSnapshot && shapeBreaks.length) ||
        (opts.strictBudget && overBudget);
      const driftError = [
        ...(opts.strictContract ? contractBreaks.map((f) => f.message) : []),
        ...(opts.strictSnapshot ? shapeBreaks.map((f) => f.message) : []),
        ...(opts.strictBudget && overBudget
          ? [`took ${overBudget.actualMs}ms against a budget of ${overBudget.budgetMs}ms`]
          : []),
      ];

      const state: NodeState = {
        status: failed.length || drifted ? 'failed' : 'passed',
        response: res,
        assertions,
        sent: request,
        durationMs: Date.now() - started,
        ...(contract.length ? {contract} : {}),
        ...(shape ? {shape} : {}),
        ...(shapeChanges.length ? {shapeChanges} : {}),
        ...(overBudget ? {overBudget} : {}),
        ...(node.teardown ? {teardown: true} : {}),
        ...(attempts > 1 ? {attempts} : {}),
        ...(failed.length
          ? {
              error:
                attempts > 1
                  ? `${failed.map(describeFailure).join('; ')} — still true after ${attempts} attempts over ${(
                      (node.pollTimeoutMs ?? 30_000) / 1000
                    ).toFixed(0)}s`
                  : failed.map(describeFailure).join('; '),
            }
          : drifted
            ? {error: driftError.join('; ')}
            : {}),
      };
      states[node.id] = state;

      if (state.status === 'failed') {
        hooks?.onLog?.(`✗ ${label} — ${state.error}`);
        hooks?.onNodeEnd?.(node.id, state);
        return 'failed';
      }

      extract(def.gives, res, ctx, hooks?.onLog);
      // A passing step that drifted still says so — that is usually the most
      // interesting line in the whole run.
      const drift = [
        contractBreaks.length ? summariseContract(contract) : '',
        shapeBreaks.length ? summariseShape(shapeChanges) : '',
        overBudget ? `${overBudget.actualMs}ms over a ${overBudget.budgetMs}ms budget` : '',
      ].filter(Boolean);
      hooks?.onLog?.(
        `✓ ${label} · ${res.status} · ${res.durationMs}ms` +
          `${attempts > 1 ? ` · settled after ${attempts} tries` : ''}` +
          `${drift.length ? ` · ⚠ ${drift.join(', ')}` : ''}`,
      );
      hooks?.onNodeEnd?.(node.id, state);
      hooks?.onContext?.(ctx);
      return 'passed';
    } catch (err) {
      const state: NodeState = {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
        ...(node.teardown ? {teardown: true} : {}),
      };
      states[node.id] = state;
      hooks?.onLog?.(`✗ ${label} — ${state.error}`);
      hooks?.onNodeEnd?.(node.id, state);
      return 'failed';
    }
  };

  let passed = true;

  for (const node of ordered) {
    if (signal?.aborted) break;
    if (node.teardown) continue;
    if (wanted && !wanted.has(node.id)) continue;
    if ((await runOne(node)) === 'failed') {
      passed = false;
      break;
    }
  }

  // Teardown runs whether the journey passed or failed, and is not filtered by
  // `startAt` — the half-finished run is the one that left records behind, and
  // "clean up only when nothing went wrong" cleans up exactly when there was
  // nothing to clean.
  //
  // A failing cleanup step does not stop the others: if deleting the order
  // fails, the account it belongs to should still be attempted. Best effort is
  // the whole contract here.
  const teardown = ordered.filter((node) => node.teardown);
  const leaked: string[] = [];

  if (teardown.length && !signal?.aborted) {
    hooks?.onLog?.('— cleaning up');
    for (const node of teardown) {
      if (signal?.aborted) break;
      if ((await runOne(node)) === 'failed') {
        leaked.push(node.label ?? lookup(node.type)?.label ?? node.type);
      }
    }
  }

  return {context: ctx, states, passed, leaked};
}

export interface CaseRun {
  /** Absent when the journey has no cases and ran once, plainly. */
  case?: JourneyCase;
  result: RunResult;
}

/**
 * Run a journey once per case.
 *
 * The one decision worth stating: a failing case does **not** stop the others.
 * Inside a journey, stopping at the first failure is right — step four cannot
 * work without the id step three never created. Across cases it is exactly
 * wrong: the cases are independent, and a suite that reports "row 3 failed" and
 * goes home makes you re-run it once per broken row to learn there were four.
 */
export async function runJourneyCases(journey: Journey, opts: RunOptions): Promise<CaseRun[]> {
  const cases = journey.cases ?? [];
  if (!cases.length) return [{result: await runJourney(journey, opts)}];

  const runs: CaseRun[] = [];
  for (const one of cases) {
    if (opts.signal?.aborted) break;
    opts.hooks?.onLog?.(`▸ ${one.name}`);
    runs.push({
      case: one,
      result: await runJourney(journey, {...opts, seed: {...opts.seed, ...one.vars}}),
    });
  }
  return runs;
}

/** The shapes a run observed, ready to be written as the new baseline. */
export function shapesFrom(states: Record<string, NodeState>): Record<string, Shape> {
  const out: Record<string, Shape> = {};
  for (const [id, state] of Object.entries(states)) {
    if (state.shape) out[id] = state.shape;
  }
  return out;
}
