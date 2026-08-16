// ---- Graph ordering and the readiness check ----
//
// The canvas is a DAG; the runner needs it as a list. Beyond ordering, the
// `needs`/`gives` declarations let us answer a much more useful question before
// anything is sent: *will this journey work?* A step whose `needs` nothing
// upstream produces will fail on the wire for a reason that looks like an API
// problem and isn't — so we say so up front instead.

import type {Journey, JourneyEdge, JourneyNode, NodeDef} from './types';

export type DefLookup = (type: string) => NodeDef | undefined;

/**
 * Kahn's algorithm. Nodes with no edges keep their canvas order, so a freshly
 * dropped chain runs top to bottom before anyone wires it up.
 */
export function topoOrder(nodes: JourneyNode[], edges: JourneyEdge[]): JourneyNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));

  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;  // dangling
    out.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }

  const ready = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const ordered: JourneyNode[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const next of out.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }

  // A cycle leaves nodes unvisited. Append them so nothing silently disappears
  // from the canvas; `findCycles` is what reports the problem.
  if (ordered.length < nodes.length) {
    const seen = new Set(ordered.map((n) => n.id));
    for (const n of nodes) if (!seen.has(n.id)) ordered.push(n);
  }
  return ordered;
}

/** Node ids that sit on a cycle, empty when the graph is a DAG. */
export function findCycles(nodes: JourneyNode[], edges: JourneyEdge[]): string[] {
  const ordered = topoOrder(nodes, edges);
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);

  // Re-run Kahn's counting only; whatever never reaches indegree 0 is cyclic.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (byId.has(e.source)) out.get(e.source)!.push(e.target);

  const settled = new Set<string>();
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    settled.add(id);
    for (const next of out.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  return ordered.filter((n) => !settled.has(n.id)).map((n) => n.id);
}

/** Everything downstream of a node, inclusive — the "run from here" set. */
export function downstreamOf(startId: string, edges: JourneyEdge[]): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e.target);
  }
  const seen = new Set([startId]);
  const stack = [startId];
  while (stack.length) {
    for (const next of out.get(stack.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

export interface Problem {
  nodeId: string;
  kind: 'missing-context' | 'unknown-type' | 'cycle' | 'case-overwritten';
  message: string;
}

/**
 * Check a journey before it runs.
 *
 * The interesting case is `missing-context`: node 4 needs `userId`, and nothing
 * before it in the order gives one. That is a broken journey, and finding it
 * here costs nothing while finding it on staging costs a real account.
 */
export function checkJourney(journey: Journey, lookup: DefLookup): Problem[] {
  const problems: Problem[] = [];

  for (const id of findCycles(journey.nodes, journey.edges)) {
    problems.push({nodeId: id, kind: 'cycle', message: 'This step is part of a loop, so the run order is undefined.'});
  }

  // Case variables are seeded before the first step, so they count as available
  // and a later step writing one of them is worth flagging.
  const caseKeys = new Set((journey.cases ?? []).flatMap((c) => Object.keys(c.vars)));
  const available = new Set<string>(caseKeys);

  for (const node of topoOrder(journey.nodes, journey.edges)) {
    const def = lookup(node.type);
    if (!def) {
      problems.push({
        nodeId: node.id,
        kind: 'unknown-type',
        message: `No node type "${node.type}" is loaded. Import the spec it came from, or delete the step.`,
      });
      continue;
    }
    for (const need of def.needs) {
      if (!available.has(need)) {
        problems.push({
          nodeId: node.id,
          kind: 'missing-context',
          message: `Needs "${need}", which no earlier step produces.`,
        });
      }
    }
    for (const give of [...def.gives, ...(node.gives ?? [])]) available.add(give.key);

    // Keys written from the node's own config — "Set values" gives whatever you
    // typed into it. These are the ones that can shadow a case, because they are
    // literals written *before* anything downstream reads them.
    //
    // `gives` is deliberately not included: those are extracted from a response,
    // so they land after the step that used the case value, and a `GET /pet/{id}`
    // writing `petId` back from its own body is ordinary chaining. Warning about
    // it would put a false finding in front of every imported journey.
    const written: string[] = [];
    if (def.givesFrom) {
      const declared = node.config?.[def.givesFrom];
      if (declared && typeof declared === 'object') {
        for (const key of Object.keys(declared)) {
          available.add(key);
          written.push(key);
        }
      }
    }

    // The quiet disaster of a data-driven run: you paste twelve rows of `petId`,
    // a step sets `petId` to a constant, and all twelve rows test the same
    // record. Every row goes green and the suite has covered one case. Nothing
    // else catches this — the run is working exactly as written.
    const clobbered = written.filter((key) => caseKeys.has(key));
    if (clobbered.length) {
      problems.push({
        nodeId: node.id,
        kind: 'case-overwritten',
        message:
          `Sets ${clobbered.map((k) => `"${k}"`).join(', ')}, which every case also supplies — this step wins, ` +
          `so the cases will all run against the same value.`,
      });
    }
  }
  return problems;
}
