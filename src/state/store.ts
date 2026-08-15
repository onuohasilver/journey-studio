// ---- Application state ----
//
// One store holds the journey, the last run's per-node state, and the AI
// conversation. Runs are driven from here so that the canvas, the logs and the
// inspector can never disagree about what happened.

import {create} from 'zustand';
import {runJourney, type Transport} from '../core/engine';
import {materialise} from '../core/builtins';
import {topoOrder} from '../core/graph';
import {allDefs, lookup as registryLookup, registerPack, removePack, allPacks, type Pack} from '../core/registry';
import {importDocument} from '../core/import';
import {applyOps, buildChain, type AppliedChange} from '../core/ai/apply';
import {buildCanvasIndex, buildJourneyDigest, buildNodeIndex} from '../core/ai/grounding';
import {validateEdit, validatePlan} from '../core/ai/validate';
import {requestExplanation, requestPlan, requestRevision, type Explanation} from '../core/ai/client';
import {createHistory} from './history';
import type {HttpResponse, ImportResult, Journey, JourneyNode, NodeDef, NodeState, ResolvedRequest} from '../core/types';

/** Public config, fetched once at boot. Values never leave the server. */
export interface ClientConfig {
  environments: {name: string; baseUrl: string}[];
  authSchemes: string[];
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

export type Rail = 'inspector' | 'ai' | 'explain' | 'packs';

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

  plan(goal: string, thenRun: boolean): Promise<void>;
  revise(instruction: string, thenRun: boolean): Promise<void>;
  explain(): Promise<void>;
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

  async init() {
    try {
      const config = (await (await fetch('/api/config')).json()) as ClientConfig;
      set({config, env: get().env || config.environments[0]?.name || ''});
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

    set({running: true, states: startAt ? states : {}, logs: []});

    const result = await runJourney(journey, {
      env,
      lookup: lookupFor(journey),
      transport,
      startAt,
      priorResponses,
      signal: abort.signal,
      hooks: {
        onNodeStart: (id) => set({states: {...get().states, [id]: {status: 'running'}}}),
        onNodeEnd: (id, state) => set({states: {...get().states, [id]: state}}),
        onLog: (line) => set({logs: [...get().logs, line]}),
      },
    });

    set({
      running: false,
      states: {...get().states, ...result.states},
      logs: [...get().logs, result.passed ? '— run complete' : '— run stopped at the first failure'],
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
