// ---- Application state ----
//
// One store holds the journey, the last run's per-node state, and the AI
// conversation. Runs are driven from here so that the canvas, the logs and the
// inspector can never disagree about what happened.

import {create} from 'zustand';
import {runJourneyCases, shapesFrom, type Transport} from '../core/engine';
import {materialise} from '../core/builtins';
import {topoOrder} from '../core/graph';
import {resolve} from '../core/template';
import {allDefs, lookup as registryLookup, register, registerPack, removePack, allPacks, type Pack} from '../core/registry';
import {importDocument} from '../core/import';
import {applyOps, buildChain, type AppliedChange} from '../core/ai/apply';
import {buildCanvasIndex, buildJourneyDigest, buildNodeIndex} from '../core/ai/grounding';
import {validateEdit, validatePlan} from '../core/ai/validate';
import {requestAssertions, requestExplanation, requestPlan, requestRevision, type AssertionSuggestions, type Explanation} from '../core/ai/client';
import {createHistory} from './history';
import {buildJourneyReport, buildReport, type QaReport} from '../core/report';
import type {Shape} from '../core/snapshot';
import type {HookMatch, HookMock, InboxSource, ReceivedHook} from '../core/inbox';
import {fileNameFor, packJourney, readSaved, type SavedJourney} from '../core/persist';
import type {
  Assertion,
  HttpResponse,
  ImportResult,
  Journey,
  JourneyCase,
  JourneyNode,
  NodeDef,
  NodeState,
  ResolvedRequest,
  RunContext,
} from '../core/types';

/** Public config, fetched once at boot. Values never leave the server. */
export interface ClientConfig {
  environments: {name: string; baseUrl: string}[];
  authSchemes: {name: string; type: string}[];
  secretNames: string[];
}

export interface AiTurn {
  id: string;
  kind: 'build' | 'revise';
  instruction: string;
  summary: string;
  changes: AppliedChange[];
  caveats: string[];
  unsupported: string[];
  problems: string[];
}

export type Rail = 'inspector' | 'ai' | 'explain' | 'packs' | 'report' | 'saved' | 'data' | 'inbox';

export interface SavedSummary {
  name: string;
  file: string;
  description?: string;
  savedAt: string;
  steps: number;
  cases: number;
  snapshot: boolean;
}

interface StudioState {
  journey: Journey;
  states: Record<string, NodeState>;
  logs: string[];
  env: string;
  config: ClientConfig;
  packs: Pack[];
  running: boolean;
  selectedId: string | null;
  rail: Rail;

  aiTurns: AiTurn[];
  explanation: Explanation | null;
  explaining: boolean;

  /** The report for the last run — the thing QA actually takes away. */
  report: QaReport | null;
  saved: SavedSummary[];
  slackConfigured: boolean;

  /** Recorded response shapes this journey is being compared against. */
  baseline: Record<string, Shape> | null;
  recordedAt: string | null;
  /** The live run's context, so a mock fired mid-run can carry its values. */
  context: RunContext | null;

  /** Deliveries the inbox has seen, and the URL a provider should call. */
  hooks: ReceivedHook[];
  inboxUrl: string;
  mocks: HookMock[];
  /** Deliver saved payloads instead of waiting for the real integration. */
  useMocks: boolean;

  /** Where an opened journey's definitions came from, kept so re-saving it does
   *  not throw the provenance away in a session that imported nothing. */
  sources: SavedJourney['sources'];

  /** Labels for the next undo/redo, so the buttons can say what they'll do. */
  undoLabel?: string;
  redoLabel?: string;

  init(): Promise<void>;
  setEnv(env: string): void;
  setRail(rail: Rail): void;
  select(id: string | null): void;

  undo(): void;
  redo(): void;

  addNode(type: string, position?: {x: number; y: number}): void;
  updateConfig(id: string, patch: Record<string, unknown>): void;
  renameNode(id: string, label: string): void;
  deleteNode(id: string): void;
  setJourney(journey: Journey): void;
  connect(source: string, target: string): void;
  moveNode(id: string, position: {x: number; y: number}): void;

  run(startAt?: string): Promise<void>;
  stop(): void;

  importText(text: string, filename?: string): ImportResult;
  removeImported(slug: string): void;

  setCases(cases: JourneyCase[] | undefined): void;
  setTeardown(id: string, teardown: boolean): void;
  setBudget(id: string, budgetMs: number | undefined): void;
  setAssertions(id: string, assertions: Assertion[] | undefined): void;
  setUntil(id: string, until: Assertion[] | undefined): void;
  setPoll(id: string, patch: {pollEveryMs?: number; pollTimeoutMs?: number}): void;
  recordSnapshot(): Promise<{ok: boolean; error?: string; nodes?: number}>;

  refreshInbox(): Promise<void>;
  clearInbox(): Promise<void>;
  setUseMocks(useMocks: boolean): void;
  saveMockFrom(hook: ReceivedHook, name: string): Promise<void>;
  fireMock(name: string): Promise<void>;
  deleteMock(name: string): Promise<void>;

  refreshSaved(): Promise<void>;
  saveJourney(name: string, description?: string): Promise<void>;
  openJourney(file: string): Promise<string[]>;
  deleteSaved(file: string): Promise<void>;
  sendReportToSlack(): Promise<{ok: boolean; error?: string}>;

  plan(goal: string, thenRun: boolean): Promise<void>;
  revise(instruction: string, thenRun: boolean): Promise<void>;
  explain(): Promise<void>;
  suggestAssertions(id: string): Promise<AssertionSuggestions & {error?: string}>;
  resetConversation(): void;
}

const EMPTY: Journey = {name: 'Untitled journey', nodes: [], edges: []};

/** The engine talks to the proxy, never to the API directly. */
const transport: Transport = {
  async send(request: ResolvedRequest, env: string): Promise<HttpResponse> {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({request, env}),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error ?? `proxy returned ${res.status}`);
    return payload as HttpResponse;
  },
};

/**
 * The browser asks the server to claim a delivery, rather than fetching the list
 * and picking one itself: claiming has to be atomic, or two waiting steps race
 * for the same webhook.
 */
const inboxSource: InboxSource = {
  async claim(match: HookMatch, opts: {since: string; by: string}) {
    const res = await fetch('/api/inbox/claim', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({match, ...opts}),
    });
    return res.ok ? ((await res.json()) as ReceivedHook) : undefined;
  },
  async describeUnmatched(since: string) {
    const res = await fetch('/api/inbox/claim', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({match: {path: '\u0000never'}, since, by: 'describe'}),
    });
    if (res.ok) return [];
    return ((await res.json()) as {unmatched?: string[]}).unmatched ?? [];
  },
};

/** Node defs with the raw-HTTP node's request built from what the user typed. */
function lookupFor(journey: Journey) {
  return (type: string): NodeDef | undefined => {
    const def = registryLookup(type);
    if (!def) return undefined;
    if (def.type !== 'http.request') return def;
    const node = journey.nodes.find((n) => n.type === type);
    return node ? materialise(def, node.config) : def;
  };
}

let abort: AbortController | undefined;

const history = createHistory<Journey>();

export const useStudio = create<StudioState>((set, get) => {
  /** History labels, renamed so they don't collide with the undo/redo actions. */
  const labels = () => {
    const {undo, redo} = history.peek();
    return {undoLabel: undo, redoLabel: redo};
  };

  /**
   * The one door every journey change goes through.
   *
   * Recording the snapshot here rather than in each action is what keeps undo
   * honest: a mutation added later is undoable by construction, instead of being
   * undoable only if someone remembered to wire it up.
   */
  const mutate = (label: string, next: (journey: Journey) => Journey, coalesceKey?: string) => {
    const before = get().journey;
    const after = next(before);
    if (after === before) return;
    history.push(before, label, coalesceKey);
    set({journey: after, ...labels()});
  };

  const restore = (moved: {state: Journey; label: string} | undefined, verb: string) => {
    if (!moved) return;
    const {selectedId, logs} = get();
    // Run results are keyed by node id and deliberately left alone: undo should
    // put the canvas back, not throw away responses you already paid for. A node
    // that comes back brings its old result with it.
    set({
      journey: moved.state,
      selectedId: moved.state.nodes.some((n) => n.id === selectedId) ? selectedId : null,
      logs: [...logs, `↶ ${verb} ${moved.label}`],
      ...labels(),
    });
  };

  return {
  journey: EMPTY,
  states: {},
  logs: [],
  env: '',
  config: {environments: [], authSchemes: [], secretNames: []},
  packs: [],
  running: false,
  selectedId: null,
  rail: 'inspector',
  aiTurns: [],
  explanation: null,
  explaining: false,
  report: null,
  saved: [],
  slackConfigured: false,
  baseline: null,
  recordedAt: null,
  sources: undefined,
  context: null,
  hooks: [],
  inboxUrl: '',
  mocks: [],
  useMocks: false,

  async init() {
    try {
      const config = (await (await fetch('/api/config')).json()) as ClientConfig & {slackConfigured?: boolean};
      set({
        config,
        env: get().env || config.environments[0]?.name || '',
        slackConfigured: Boolean(config.slackConfigured),
      });
      await get().refreshSaved();
      await get().refreshInbox();
    } catch {
      set({logs: [...get().logs, '! Could not reach the API. Is the dev server running?']});
    }
    set({packs: allPacks()});
  },

  setEnv: (env) => set({env}),
  setRail: (rail) => set({rail}),
  select: (selectedId) => set({selectedId, rail: selectedId ? 'inspector' : get().rail}),

  undo: () => restore(history.undo(get().journey), 'undid'),
  redo: () => restore(history.redo(get().journey), 'redid'),

  addNode(type, position) {
    const def = registryLookup(type);
    if (!def) return;
    const id = `n${get().journey.nodes.length + 1}_${Math.random().toString(36).slice(2, 6)}`;
    mutate(`add ${def.label}`, (journey) => ({
      ...journey,
      nodes: [
        ...journey.nodes,
        {
          id,
          type,
          label: def.label,
          config: {...(def.defaults ?? {})},
          position: position ?? {x: 60 + journey.nodes.length * 40, y: 120 + journey.nodes.length * 30},
        } satisfies JourneyNode,
      ],
    }));
    set({selectedId: id, rail: 'inspector'});
  },

  updateConfig(id, patch) {
    // Coalesced per field, so typing a path is one undo step rather than one
    // per character.
    const key = `${id}:${Object.keys(patch).join(',')}`;
    mutate(
      'edit settings',
      (journey) => ({
        ...journey,
        nodes: journey.nodes.map((n) => (n.id === id ? {...n, config: {...n.config, ...patch}} : n)),
      }),
      key,
    );
  },

  renameNode(id, label) {
    mutate(
      'rename step',
      (journey) => ({...journey, nodes: journey.nodes.map((n) => (n.id === id ? {...n, label} : n))}),
      `${id}:label`,
    );
  },

  deleteNode(id) {
    const label = get().journey.nodes.find((n) => n.id === id)?.label ?? 'step';
    mutate(`delete ${label}`, (journey) => ({
      ...journey,
      nodes: journey.nodes.filter((n) => n.id !== id),
      edges: journey.edges.filter((e) => e.source !== id && e.target !== id),
    }));
    if (get().selectedId === id) set({selectedId: null});
  },

  setJourney: (journey) => mutate('replace journey', () => journey),

  connect(source, target) {
    mutate('connect steps', (journey) =>
      journey.edges.some((e) => e.source === source && e.target === target)
        ? journey
        : {
            ...journey,
            edges: [...journey.edges, {id: `e_${Math.random().toString(36).slice(2, 8)}`, source, target}],
          },
    );
  },

  moveNode(id, position) {
    mutate('move step', (journey) => ({
      ...journey,
      nodes: journey.nodes.map((n) => (n.id === id ? {...n, position} : n)),
    }));
  },

  async run(startAt) {
    if (get().running) return;
    const {journey, env, states} = get();
    if (!journey.nodes.length) return;

    abort = new AbortController();
    // Keep prior responses so "run from here" can reuse everything upstream —
    // re-running a step that created real data is exactly what to avoid.
    const priorResponses: Record<string, HttpResponse> = {};
    if (startAt) {
      for (const [id, state] of Object.entries(states)) {
        if (state.response) priorResponses[id] = state.response;
      }
    }

    const startedAt = Date.now();
    set({running: true, states: startAt ? states : {}, logs: []});

    const runs = await runJourneyCases(journey, {
      env,
      lookup: lookupFor(journey),
      transport,
      startAt,
      priorResponses,
      baseline: get().baseline ?? undefined,
      inbox: inboxSource,
      // Only when explicitly switched on. A journey that quietly satisfies its
      // webhook from a canned payload is a test that passes while the
      // integration is broken.
      ...(get().useMocks
        ? {mocks: Object.fromEntries(get().mocks.map((m) => [m.name, m]))}
        : {}),
      signal: abort.signal,
      hooks: {
        onNodeStart: (id) => set({states: {...get().states, [id]: {status: 'running'}}}),
        onNodeEnd: (id, state) => set({states: {...get().states, [id]: state}}),
        // Kept so "Fire now" can resolve a mock against the run that is waiting
        // for it — a payload carrying a literal {{vars.paymentRef}} would never
        // correlate, which makes the button look broken.
        onContext: (context) => set({context}),
        onLog: (line) => set({logs: [...get().logs, line]}),
      },
    });

    // The canvas can only show one run. With cases it shows the first that
    // failed, because that is the one anybody opens the inspector for; with none
    // it shows the only run there was.
    const shown = runs.find((r) => !r.result.passed) ?? runs[runs.length - 1];
    const finalStates = {...get().states, ...(shown?.result.states ?? {})};

    const journeyReports = runs.map((run) =>
      buildJourneyReport(journey, run.result.states, run.result.context, lookupFor(journey), {
        caseName: run.case?.name,
      }),
    );

    const failedCases = runs.filter((r) => !r.result.passed).length;
    const tail = runs.length > 1
      ? `— ${runs.length} cases · ${runs.length - failedCases} passed${
          failedCases ? `, showing "${shown?.case?.name}"` : ''
        }`
      : shown?.result.passed
        ? '— run complete'
        : '— run stopped at the first failure';

    set({
      running: false,
      states: finalStates,
      // Every run produces a report, not just a colour on the canvas — it is
      // what gets exported, posted, and read the next morning.
      report: buildReport(env, journeyReports, {
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        baseUrl: get().config.environments.find((e) => e.name === env)?.baseUrl,
      }),
      logs: [...get().logs, tail],
    });
  },

  stop() {
    abort?.abort();
    set({running: false, logs: [...get().logs, '— stopped']});
  },

  importText(text, filename) {
    const result = importDocument(text, filename);
    if (result.ok) {
      registerPack(result);
      set({
        packs: allPacks(),
        logs: [
          ...get().logs,
          `+ imported ${result.title} · ${result.nodes.length} nodes${result.warnings.length ? ` · ${result.warnings.length} warning(s)` : ''}`,
        ],
      });
    }
    return result;
  },

  removeImported(slug) {
    const gone = new Set(removePack(slug));
    const {journey} = get();
    // Nodes whose type just disappeared would be unrunnable, so drop them too.
    // Deliberately not undoable: undo restores the journey, not the registry, so
    // the steps would come back as unknown types. Re-import the document instead.
    const nodes = journey.nodes.filter((n) => !gone.has(n.type));
    const keep = new Set(nodes.map((n) => n.id));
    set({
      packs: allPacks(),
      journey: {...journey, nodes, edges: journey.edges.filter((e) => keep.has(e.source) && keep.has(e.target))},
    });
  },

  // ---- data-driven runs and snapshots ----

  setCases(cases) {
    // Undoable like any other edit: pasting the wrong spreadsheet over a curated
    // set of cases should cost one Cmd+Z, not a re-import.
    mutate('change cases', (journey) => ({...journey, cases: cases?.length ? cases : undefined}));
  },

  setTeardown(id, teardown) {
    mutate(teardown ? 'mark as clean-up' : 'unmark clean-up', (journey) => ({
      ...journey,
      nodes: journey.nodes.map((n) => (n.id === id ? {...n, teardown: teardown || undefined} : n)),
    }));
  },

  setBudget(id, budgetMs) {
    mutate(
      'change time budget',
      (journey) => ({
        ...journey,
        nodes: journey.nodes.map((n) =>
          n.id === id ? {...n, budgetMs: budgetMs && budgetMs > 0 ? budgetMs : undefined} : n,
        ),
      }),
      // Typing "1500" is four keystrokes, not four undo steps.
      `budget:${id}`,
    );
  },

  setAssertions(id, assertions) {
    mutate(
      'change checks',
      (journey) => ({
        ...journey,
        nodes: journey.nodes.map((n) => (n.id === id ? {...n, assertions: assertions?.length ? assertions : undefined} : n)),
      }),
      // Typing a path is many keystrokes, not many undo steps.
      `assertions:${id}`,
    );
  },

  setUntil(id, until) {
    mutate(
      'change wait condition',
      (journey) => ({
        ...journey,
        nodes: journey.nodes.map((n) => (n.id === id ? {...n, until: until?.length ? until : undefined} : n)),
      }),
      `until:${id}`,
    );
  },

  setPoll(id, patch) {
    mutate(
      'change polling',
      (journey) => ({
        ...journey,
        nodes: journey.nodes.map((n) => (n.id === id ? {...n, ...patch} : n)),
      }),
      `poll:${id}`,
    );
  },

  async recordSnapshot() {
    const {journey, states, env} = get();
    const nodes = shapesFrom(states);
    if (!Object.keys(nodes).length) {
      return {ok: false, error: 'Run the journey first — there are no responses to record.'};
    }

    const res = await fetch(`/api/journeys/${encodeURIComponent(fileNameFor(journey.name))}/snapshot`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({nodes, env, journey: journey.name}),
    });
    const payload = (await res.json()) as {ok?: boolean; error?: string; nodes?: number};
    if (!payload.ok) return {ok: false, error: payload.error ?? 'could not record'};

    set({
      baseline: nodes,
      recordedAt: new Date().toISOString(),
      logs: [...get().logs, `recorded ${payload.nodes} response shapes`],
    });
    await get().refreshSaved();
    return {ok: true, nodes: payload.nodes};
  },

  // ---- the webhook inbox ----

  async refreshInbox() {
    try {
      const [inbox, mocks] = await Promise.all([
        (await fetch('/api/inbox')).json() as Promise<{hooks: ReceivedHook[]; url: string}>,
        (await fetch('/api/mocks')).json() as Promise<HookMock[]>,
      ]);
      set({hooks: inbox.hooks, inboxUrl: inbox.url, mocks});
    } catch {
      /* the inbox is a panel; failing to load it should not break the app */
    }
  },

  async clearInbox() {
    await fetch('/api/inbox', {method: 'DELETE'});
    await get().refreshInbox();
  },

  setUseMocks: (useMocks) => set({useMocks}),

  async saveMockFrom(hook, name) {
    const {mockFromHook} = await import('../core/inbox');
    const mock = mockFromHook(hook, name);
    await fetch(`/api/mocks/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(mock),
    });
    set({logs: [...get().logs, `saved webhook "${name}" as a mock`]});
    await get().refreshInbox();
  },

  async fireMock(name) {
    const {context, mocks} = get();
    const mock = mocks.find((m) => m.name === name);
    // Resolved against the waiting run, so a mock body that references
    // {{vars.paymentRef}} arrives carrying the reference this run generated.
    const body = mock && context ? resolve(mock.body, context) : undefined;

    await fetch(`/api/mocks/${encodeURIComponent(name)}/fire`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body === undefined ? {} : {body}),
    });
    set({logs: [...get().logs, `fired mock "${name}" into the inbox`]});
    await get().refreshInbox();
  },

  async deleteMock(name) {
    await fetch(`/api/mocks/${encodeURIComponent(name)}`, {method: 'DELETE'});
    await get().refreshInbox();
  },

  // ---- saved journeys ----

  async refreshSaved() {
    try {
      set({saved: (await (await fetch('/api/journeys')).json()) as SavedSummary[]});
    } catch {
      /* the list is a convenience; failing to load it should not break the app */
    }
  },

  async saveJourney(name, description) {
    const {journey, env, packs} = get();
    // The definitions travel with the file, so the journey runs in CI with no
    // document to import and its contract is pinned as of today.
    const saved = packJourney({...journey, name}, registryLookup, {
      description,
      env,
      // Packs from this session take precedence, but a journey that was opened
      // rather than imported has no packs — and dropping its provenance would
      // quietly break the "re-import to update" path on every open-and-save.
      sources: packs.length
        ? packs.map((p) => ({slug: p.slug, title: p.title, format: p.format}))
        : get().sources,
    });

    const res = await fetch(`/api/journeys/${encodeURIComponent(fileNameFor(name))}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(saved),
    });
    if (!res.ok) throw new Error(((await res.json()) as {error?: string}).error ?? 'could not save');

    set({journey: {...journey, name, description}, logs: [...get().logs, `saved "${name}"`]});
    await get().refreshSaved();
  },

  async openJourney(file) {
    const res = await fetch(`/api/journeys/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error('could not open that journey');

    const result = readSaved(JSON.stringify(await res.json()), registryLookup);
    if (!result.ok || !result.saved) throw new Error(result.error ?? 'could not read that journey');

    // Definitions from the file are registered so the steps are runnable even
    // when the document they came from was never imported in this session.
    if (result.saved.defs.length) register(result.saved.defs);

    // A recorded baseline comes along with the journey, so the next run compares
    // against it without anyone opting in — the same way `jest` does.
    let baseline: Record<string, Shape> | null = null;
    let recordedAt: string | null = null;
    try {
      const snap = await fetch(`/api/journeys/${encodeURIComponent(file)}/snapshot`);
      if (snap.ok) {
        const loaded = (await snap.json()) as {nodes: Record<string, Shape>; recordedAt?: string};
        baseline = loaded.nodes;
        recordedAt = loaded.recordedAt ?? null;
      }
    } catch {
      /* no baseline is the normal case, not an error */
    }

    set({
      journey: result.saved.journey,
      states: {},
      report: null,
      selectedId: null,
      rail: 'inspector',
      baseline,
      recordedAt,
      sources: result.saved.sources,
      logs: [
        `opened "${result.saved.name}"`,
        ...(result.saved.journey.cases?.length ? [`${result.saved.journey.cases.length} cases`] : []),
        ...(baseline ? [`comparing against ${Object.keys(baseline).length} recorded shapes`] : []),
      ],
    });
    history.clear();
    set(labels());
    return result.missingTypes;
  },

  async deleteSaved(file) {
    await fetch(`/api/journeys/${encodeURIComponent(file)}`, {method: 'DELETE'});
    await get().refreshSaved();
  },

  async sendReportToSlack() {
    const {report} = get();
    if (!report) return {ok: false, error: 'Run the journey first — there is nothing to report.'};
    const res = await fetch('/api/report/slack', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({report}),
    });
    const payload = (await res.json()) as {ok?: boolean; error?: string};
    if (payload.ok) set({logs: [...get().logs, 'posted the report to Slack']});
    return {ok: Boolean(payload.ok), error: payload.error};
  },

  // ---- AI ----

  async plan(goal, thenRun) {
    const {env, config} = get();
    const raw = await requestPlan({
      goal,
      env,
      nodeIndex: buildNodeIndex(allDefs()),
      environments: config.environments.map((e) => `${e.name} | ${e.baseUrl}`).join('\n'),
    });
    const validated = validatePlan(raw, registryLookup);
    if (!validated.steps.length) throw new Error('The plan came back with no usable steps. Try describing it differently.');

    // A rebuild is a single undoable step: one Cmd+Z puts back whatever was
    // there before you asked.
    history.push(get().journey, 'build with AI');
    set({
      journey: {...buildChain(validated.steps, registryLookup), name: get().journey.name},
      states: {},
      selectedId: null,
      ...labels(),
      aiTurns: [
        {
          id: Math.random().toString(36).slice(2, 8),
          kind: 'build',
          instruction: goal,
          summary: validated.summary,
          changes: [],
          caveats: validated.caveats,
          unsupported: validated.unsupported,
          problems: validated.problems,
        },
      ],
      logs: [`AI · ${validated.summary}`, ...validated.problems.map((p) => `⚠ ${p}`)],
    });
    if (thenRun) await get().run();
  },

  async revise(instruction, thenRun) {
    const {journey, env, config, states, aiTurns} = get();
    const ordered = topoOrder(journey.nodes, journey.edges);
    const raw = await requestRevision({
      instruction,
      env,
      nodeIndex: buildNodeIndex(allDefs()),
      environments: config.environments.map((e) => `${e.name} | ${e.baseUrl}`).join('\n'),
      canvas: buildCanvasIndex(ordered, registryLookup, states),
      history: aiTurns.map((t) => `${t.instruction}\n→ ${t.summary}`).join('\n\n'),
    });
    const validated = validateEdit(raw, journey, registryLookup);
    const result = applyOps(journey, validated.ops, registryLookup);

    // One AI turn is one undo step, however many nodes it touched — this is the
    // case undo exists for.
    history.push(journey, validated.summary || 'AI edit');
    set({
      journey: result.journey,
      ...labels(),
      // States are deliberately kept: an edit must not throw away results for
      // steps it never touched.
      selectedId: result.touched.length === 1 ? result.touched[0] : null,
      aiTurns: [
        ...aiTurns,
        {
          id: Math.random().toString(36).slice(2, 8),
          kind: 'revise',
          instruction,
          summary: validated.summary,
          changes: result.changes,
          caveats: validated.caveats,
          unsupported: validated.unsupported,
          problems: [...validated.problems, ...result.skipped],
        },
      ],
      logs: [
        ...get().logs,
        `AI edit · ${validated.summary}`,
        ...result.changes.map((c) => `· ${c.text}`),
        ...result.skipped.map((s) => `⚠ ${s}`),
      ],
    });
    if (thenRun) await get().run();
  },

  async explain() {
    const {journey, config} = get();
    if (!journey.nodes.length) return;
    set({explaining: true, rail: 'explain'});
    try {
      const ordered = topoOrder(journey.nodes, journey.edges);
      const explanation = await requestExplanation({
        canvas: buildJourneyDigest(ordered, registryLookup),
        nodeIndex: buildNodeIndex(allDefs()),
        environments: config.environments.map((e) => `${e.name} | ${e.baseUrl}`).join('\n'),
      });
      set({explanation});
    } finally {
      set({explaining: false});
    }
  },

  async suggestAssertions(id) {
    const {journey, states, config} = get();
    const node = journey.nodes.find((n) => n.id === id);
    const response = states[id]?.response;
    if (!node || !response) {
      return {assertions: [], error: 'Run this step first — there is no response to suggest checks from.'};
    }

    const def = registryLookup(node.type);
    return requestAssertions({
      step: `${node.label ?? def?.label ?? node.type} — ${def?.request?.method ?? ''} ${def?.request?.path ?? ''}`,
      response: {status: response.status, body: response.body},
      schema: def?.responseSchema,
      nodeIndex: buildNodeIndex(allDefs()),
      environments: config.environments.map((e) => `${e.name} | ${e.baseUrl}`).join('\n'),
    });
  },

    resetConversation: () => set({aiTurns: []}),
  };
});

/** Test seam — history lives outside the store, so it needs clearing too. */
export function resetStudio(): void {
  history.clear();
  useStudio.setState({
    journey: EMPTY,
    states: {},
    logs: [],
    selectedId: null,
    aiTurns: [],
    undoLabel: undefined,
    redoLabel: undefined,
  });
}
