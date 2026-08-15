// ---- What the model is allowed to know ----
//
// Two compact indexes, both built from live state rather than anything
// hand-maintained: the nodes actually registered, and the journey actually on
// the canvas. That is what lets the AI work against whatever document you
// imported instead of a catalog someone had to write first.

import type {Journey, NodeDef, NodeState} from '../types';

const MAX_SUMMARY = 90;
const MAX_NOTE = 200;
const MAX_OPTIONS = 6;

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function fieldSignature(def: NodeDef): string {
  return def.fields
    .map((f) => {
      if (f.kind !== 'select' || !f.options?.length) return `${f.key}:${f.kind}`;
      const values = f.options.map((o) => o.value);
      const shown = values.slice(0, MAX_OPTIONS).join('|');
      const rest = values.length - MAX_OPTIONS;
      return `${f.key}:enum[${shown}${rest > 0 ? `|+${rest}` : ''}]`;
    })
    .join(' ');
}

/** One line per registered node. The model may only name types from this list. */
export function buildNodeIndex(defs: NodeDef[]): string {
  return defs
    .map((def) => {
      const parts = [def.type, def.label];
      parts.push(def.request ? `${def.request.method} ${def.request.path}` : `control:${def.control ?? '-'}`);
      if (def.destructive) parts.push('DESTRUCTIVE');
      if (def.needs.length) parts.push(`needs=${def.needs.join(',')}`);
      if (def.gives.length) parts.push(`gives=${def.gives.map((g) => g.key).join(',')}`);
      if (def.fields.length) parts.push(`fields=${fieldSignature(def)}`);
      if (def.summary) parts.push(clip(def.summary, MAX_SUMMARY));
      if (def.notes) parts.push(`NOTE: ${clip(def.notes, MAX_NOTE)}`);
      return parts.join(' | ');
    })
    .join('\n');
}

/**
 * The canvas as it stands, one line per step, in run order.
 *
 * Two things make an edit possible rather than a rebuild: the ref is the live
 * node id, so an op can name the exact box on screen; and the last run's outcome
 * travels with it, so "fix the step that failed" needs no further explanation —
 * the status and the error are already on the line.
 */
export function buildCanvasIndex(
  ordered: Journey['nodes'],
  lookup: (type: string) => NodeDef | undefined,
  states: Record<string, NodeState> = {},
): string {
  return ordered
    .map((node, i) => {
      const def = lookup(node.type);
      const parts = [`${i + 1}.`, `ref=${node.id}`, node.type, `"${node.label ?? def?.label ?? node.type}"`];

      const defaults = def?.defaults ?? {};
      const changed = Object.entries(node.config ?? {}).filter(
        ([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k]),
      );
      if (changed.length) {
        parts.push(`set={${changed.map(([k, v]) => `${k}=${clip(JSON.stringify(v), 60)}`).join(' ')}}`);
      }

      const state = states[node.id];
      if (state) {
        if (state.status !== 'idle') parts.push(`status=${state.status}`);
        if (state.response) parts.push(`http=${state.response.status}`);
        if (state.error) parts.push(`error=${clip(state.error, 160)}`);
      }
      return parts.join(' | ');
    })
    .join('\n');
}

/** Journey text for the explainer, which needs shape rather than run state. */
export function buildJourneyDigest(
  ordered: Journey['nodes'],
  lookup: (type: string) => NodeDef | undefined,
): string {
  return ordered
    .map((node, i) => {
      const def = lookup(node.type);
      const call = def?.request ? `${def.request.method} ${def.request.path}` : `control:${def?.control ?? '-'}`;
      const gives = def?.gives.length ? ` gives=${def.gives.map((g) => g.key).join(',')}` : '';
      const needs = def?.needs.length ? ` needs=${def.needs.join(',')}` : '';
      const note = def?.notes ? ` NOTE: ${clip(def.notes, MAX_NOTE)}` : '';
      return `${i + 1}. ref=${node.id} | ${node.label ?? def?.label ?? node.type} | ${call}${needs}${gives}${note}`;
    })
    .join('\n');
}
