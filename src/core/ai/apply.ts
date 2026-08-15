// ---- Building a journey, and editing one in place ----
//
// A planner that can only replace the canvas is a planner you stop using after
// the second prompt: changing your mind costs you every id, every position you
// dragged, and every response already fetched. So a revision arrives as ops
// against live node ids, and everything the edit does not name is left exactly
// as it was.

import type {Journey, JourneyEdge, JourneyNode, NodeDef} from '../types';
import type {PlannedStep} from './validate';

export type EditOp =
  | {op: 'insert'; after: string; handle?: string; type: string; label?: string; config: Record<string, unknown>; why: string}
  | {op: 'remove'; ref: string; why: string}
  | {op: 'replace'; ref: string; type: string; label?: string; config: Record<string, unknown>; why: string}
  | {op: 'configure'; ref: string; label?: string; config: Record<string, unknown>; why: string};

export interface AppliedChange {
  kind: EditOp['op'];
  /** The node the change landed on — clicking the line selects it. */
  nodeId?: string;
  text: string;
  why: string;
}

export interface EditResult {
  journey: Journey;
  changes: AppliedChange[];
  /** Ops that no longer made sense against the live canvas. Reported, not swallowed. */
  skipped: string[];
  /** Ids added or rewritten, so the caller can select and highlight them. */
  touched: string[];
}

/** Layout grid. Rows alternate so a long chain stays readable. */
const COLUMN = 260;
const ROW_A = 120;
const ROW_B = 300;

let seq = 0;
function newId(): string {
  seq += 1;
  return `n${seq}_${Math.random().toString(36).slice(2, 6)}`;
}

function edge(source: string, target: string): JourneyEdge {
  return {id: `e_${Math.random().toString(36).slice(2, 8)}`, source, target};
}

/** Lay a planned chain out left to right, zig-zagging between two rows. */
export function buildChain(steps: PlannedStep[], lookup: (t: string) => NodeDef | undefined): Journey {
  const nodes: JourneyNode[] = steps.map((step, i) => {
    const def = lookup(step.type);
    return {
      id: newId(),
      type: step.type,
      label: step.label ?? def?.label,
      config: {...(def?.defaults ?? {}), ...step.config, ...(step.why ? {__why: step.why} : {})},
      position: {x: 40 + i * COLUMN, y: i % 2 === 0 ? ROW_A : ROW_B},
    };
  });
  const edges = nodes.slice(1).map((node, i) => edge(nodes[i].id, node.id));
  return {name: 'Untitled journey', nodes, edges};
}

/**
 * Apply a validated edit. Pure: takes a journey, returns a new one, so the store
 * stays a one-liner and this is testable without a canvas.
 */
export function applyOps(
  journey: Journey,
  ops: EditOp[],
  lookup: (t: string) => NodeDef | undefined,
): EditResult {
  let nodes: JourneyNode[] = journey.nodes.map((n) => ({...n, position: {...n.position}, config: {...n.config}}));
  let edges: JourneyEdge[] = journey.edges.map((e) => ({...e}));
  const changes: AppliedChange[] = [];
  const skipped: string[] = [];
  const touched: string[] = [];

  // A handle the model invented for a node it is inserting -> the real id that
  // node ends up with, so a later op in the same edit can target it.
  const alias = new Map<string, string>();
  const resolveRef = (ref: string) => alias.get(ref) ?? ref;
  const labelOf = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    return node?.label ?? lookup(node?.type ?? '')?.label ?? id;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        const def = lookup(op.type);
        if (!def) {
          skipped.push(`insert ${op.type}: that node type is not loaded`);
          break;
        }
        const id = newId();
        if (op.handle) alias.set(op.handle, id);

        const anchorRef = resolveRef(op.after);
        const anchor = nodes.find((n) => n.id === anchorRef);
        const tail = nodes.length ? nodes[nodes.length - 1] : undefined;
        const attachTo = anchor ?? (anchorRef === 'start' ? undefined : tail);

        let position = {x: 40, y: ROW_A};
        let where = 'as the first step';

        if (attachTo) {
          position = {x: attachTo.position.x + COLUMN, y: attachTo.position.y === ROW_A ? ROW_B : ROW_A};
          // Everything to the right shifts a column over, so the new step lands
          // in a gap rather than on top of the one that used to follow.
          nodes = nodes.map((n) =>
            n.position.x >= position.x ? {...n, position: {...n.position, x: n.position.x + COLUMN}} : n,
          );
          // Steal the anchor's outgoing edges, then wire anchor -> new:
          // A->B becomes A->new->B, and a tail insert just extends the chain.
          edges = edges.map((e) => (e.source === attachTo.id ? {...e, source: id} : e));
          edges.push(edge(attachTo.id, id));
          where = `after "${labelOf(attachTo.id)}"`;
        } else if (nodes.length) {
          const incoming = new Set(edges.map((e) => e.target));
          const roots = nodes.filter((n) => !incoming.has(n.id));
          position = {x: Math.min(...nodes.map((n) => n.position.x)) - COLUMN, y: roots[0]?.position.y ?? ROW_A};
          for (const root of roots) edges.push(edge(id, root.id));
        }

        nodes = [
          ...nodes,
          {
            id,
            type: op.type,
            label: op.label ?? def.label,
            config: {...(def.defaults ?? {}), ...op.config, ...(op.why ? {__why: op.why} : {})},
            position,
          },
        ];
        touched.push(id);
        changes.push({kind: 'insert', nodeId: id, text: `Added "${op.label ?? def.label}" ${where}`, why: op.why});
        break;
      }

      case 'remove': {
        const id = resolveRef(op.ref);
        const node = nodes.find((n) => n.id === id);
        if (!node) {
          skipped.push(`remove ${op.ref}: that step is no longer on the canvas`);
          break;
        }
        const label = labelOf(id);

        // Heal the chain: everything that fed this step now feeds what it fed.
        // Without this, deleting a middle step severs the journey in two and the
        // second half silently stops running.
        const before = edges.filter((e) => e.target === id).map((e) => e.source);
        const after = edges.filter((e) => e.source === id).map((e) => e.target);
        edges = edges.filter((e) => e.source !== id && e.target !== id);
        for (const source of before) {
          for (const target of after) {
            if (source === target) continue;
            if (edges.some((e) => e.source === source && e.target === target)) continue;
            edges.push(edge(source, target));
          }
        }
        nodes = nodes.filter((n) => n.id !== id);
        changes.push({kind: 'remove', text: `Removed "${label}"`, why: op.why});
        break;
      }

      case 'replace': {
        const id = resolveRef(op.ref);
        const index = nodes.findIndex((n) => n.id === id);
        const def = lookup(op.type);
        if (index < 0) {
          skipped.push(`replace ${op.ref}: that step is no longer on the canvas`);
          break;
        }
        if (!def) {
          skipped.push(`replace ${op.ref}: no node type "${op.type}" is loaded`);
          break;
        }
        const was = labelOf(id);
        const label = op.label ?? def.label;
        // Same id, same position, same edges — only the call changes. That is
        // what makes "use X instead" a one-step edit.
        nodes = nodes.map((n, i) =>
          i === index
            ? {
                ...n,
                type: op.type,
                label,
                config: {...(def.defaults ?? {}), ...op.config, ...(op.why ? {__why: op.why} : {})},
              }
            : n,
        );
        touched.push(id);
        changes.push({kind: 'replace', nodeId: id, text: `Swapped "${was}" for "${label}"`, why: op.why});
        break;
      }

      case 'configure': {
        const id = resolveRef(op.ref);
        const index = nodes.findIndex((n) => n.id === id);
        if (index < 0) {
          skipped.push(`configure ${op.ref}: that step is no longer on the canvas`);
          break;
        }
        const keys = Object.keys(op.config);
        nodes = nodes.map((n, i) =>
          i === index ? {...n, label: op.label ?? n.label, config: {...n.config, ...op.config}} : n,
        );
        touched.push(id);
        changes.push({
          kind: 'configure',
          nodeId: id,
          text: `Updated "${labelOf(id)}"${keys.length ? ` · ${keys.join(', ')}` : ''}`,
          why: op.why,
        });
        break;
      }
    }
  }

  return {journey: {...journey, nodes, edges}, changes, skipped, touched};
}
