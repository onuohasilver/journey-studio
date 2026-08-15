// ---- Re-checking the model against reality ----
//
// Everything that comes back from the model is checked against the live
// registry before it is allowed near the canvas. A node type that does not
// exist, a setting a node does not have, a ref for a step that isn't there —
// each is dropped and *reported*, never silently applied.
//
// The reporting matters as much as the dropping. A step quietly missing from a
// chain looks like the tool is broken; a line saying "dropped — no node type
// X" tells you the model guessed and what to do about it.

import type {Field, Journey, NodeDef} from '../types';
import type {EditOp} from './apply';

export interface RawConfigPair {
  key: string;
  value: string;
}

export interface RawStep {
  type: string;
  label?: string;
  why: string;
  config?: RawConfigPair[];
}

export interface RawPlan {
  summary: string;
  steps: RawStep[];
  caveats?: string[];
  unsupported?: string[];
}

export interface PlannedStep {
  type: string;
  label?: string;
  why: string;
  config: Record<string, unknown>;
}

export interface ValidatedPlan {
  summary: string;
  steps: PlannedStep[];
  caveats: string[];
  unsupported: string[];
  problems: string[];
}

export interface RawOp {
  op: string;
  ref?: string;
  after?: string;
  handle?: string;
  type?: string;
  label?: string;
  config?: RawConfigPair[];
  why: string;
}

export interface RawEdit {
  summary: string;
  ops: RawOp[];
  caveats?: string[];
  unsupported?: string[];
}

export interface ValidatedEdit {
  summary: string;
  ops: EditOp[];
  caveats: string[];
  unsupported: string[];
  problems: string[];
}

export type Lookup = (type: string) => NodeDef | undefined;

/**
 * Config arrives as strings because JSON-schema structured outputs cannot
 * express a free-form object. Coerce back using the field's declared kind.
 */
function coerceValue(field: Field | undefined, raw: string): {value: unknown} | {problem: string} {
  if (!field) return {value: raw};
  switch (field.kind) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? {value: n} : {problem: `${field.key}: "${raw}" is not a number`};
    }
    case 'boolean':
      return {value: raw === 'true' || raw === '1' || raw === 'yes'};
    case 'json':
      try {
        return {value: JSON.parse(raw)};
      } catch {
        // A body full of {{templates}} is legitimately not valid JSON yet.
        return raw.includes('{{') ? {value: raw} : {problem: `${field.key}: not valid JSON`};
      }
    case 'select': {
      const allowed = field.options?.map((o) => o.value) ?? [];
      if (raw.includes('{{') || !allowed.length || allowed.includes(raw)) return {value: raw};
      return {problem: `${field.key}: "${raw}" is not one of ${allowed.slice(0, 8).join(', ')}`};
    }
    default:
      return {value: raw};
  }
}

function coerceConfig(
  def: NodeDef,
  pairs: RawConfigPair[] | undefined,
  at: string,
  problems: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs ?? []) {
    const field = def.fields.find((f) => f.key === pair.key);
    if (!field) {
      problems.push(`${at} (${def.type}): ignored unknown setting "${pair.key}"`);
      continue;
    }
    const result = coerceValue(field, pair.value);
    if ('problem' in result) {
      problems.push(`${at} (${def.type}): ${result.problem}`);
      continue;
    }
    out[pair.key] = result.value;
  }
  return out;
}

export function validatePlan(plan: RawPlan, lookup: Lookup): ValidatedPlan {
  const problems: string[] = [];
  const steps: PlannedStep[] = [];

  (plan.steps ?? []).forEach((step, i) => {
    const at = `step ${i + 1}`;
    const def = lookup(step.type);
    if (!def) {
      problems.push(`${at}: dropped — no node type "${step.type}" is loaded`);
      return;
    }
    steps.push({
      type: def.type,
      label: step.label,
      why: step.why ?? '',
      config: coerceConfig(def, step.config, at, problems),
    });
  });

  return {
    summary: plan.summary ?? '',
    steps,
    caveats: plan.caveats ?? [],
    unsupported: plan.unsupported ?? [],
    problems,
  };
}

/**
 * Check an edit against the catalog *and* the canvas it claims to be editing.
 * An op naming a step that isn't there is the failure that matters here:
 * applied blindly it would do nothing, or edit the wrong box.
 */
export function validateEdit(edit: RawEdit, journey: Journey, lookup: Lookup): ValidatedEdit {
  const problems: string[] = [];
  const ops: EditOp[] = [];

  // What each ref is a node of — live ids, plus handles introduced by inserts
  // earlier in this same edit, so a revision can add a step and configure it.
  const typeByRef = new Map(journey.nodes.map((n) => [n.id, n.type]));

  const KINDS = new Set(['insert', 'remove', 'replace', 'configure']);

  (edit.ops ?? []).forEach((raw, i) => {
    const at = `change ${i + 1}`;
    const kind = raw.op?.toLowerCase();
    const why = raw.why ?? '';

    // Check the operation before the ref: an op we cannot perform should say so,
    // rather than being reported as a bad reference to a step.
    if (!kind || !KINDS.has(kind)) {
      problems.push(`${at}: dropped — "${raw.op}" is not a change this editor can make`);
      return;
    }

    if (kind === 'insert') {
      const def = raw.type ? lookup(raw.type) : undefined;
      if (!def) {
        problems.push(`${at}: dropped — no node type "${raw.type ?? '(none given)'}" is loaded`);
        return;
      }
      let after = raw.after ?? 'end';
      if (after !== 'start' && after !== 'end' && !typeByRef.has(after)) {
        problems.push(`${at}: "${after}" is not a step on the canvas — added at the end instead`);
        after = 'end';
      }
      if (raw.handle) typeByRef.set(raw.handle, def.type);
      ops.push({
        op: 'insert',
        after,
        ...(raw.handle ? {handle: raw.handle} : {}),
        type: def.type,
        ...(raw.label ? {label: raw.label} : {}),
        config: coerceConfig(def, raw.config, at, problems),
        why,
      });
      return;
    }

    const ref = raw.ref ?? '';
    const currentType = typeByRef.get(ref);
    if (!currentType) {
      problems.push(`${at}: dropped — "${ref || '(no step given)'}" is not a step on the canvas`);
      return;
    }

    if (kind === 'remove') {
      typeByRef.delete(ref);
      ops.push({op: 'remove', ref, why});
      return;
    }

    if (kind === 'replace') {
      const def = raw.type ? lookup(raw.type) : undefined;
      if (!def) {
        problems.push(`${at}: dropped — no node type "${raw.type ?? '(none given)'}" is loaded`);
        return;
      }
      typeByRef.set(ref, def.type);
      ops.push({
        op: 'replace',
        ref,
        type: def.type,
        ...(raw.label ? {label: raw.label} : {}),
        config: coerceConfig(def, raw.config, at, problems),
        why,
      });
      return;
    }

    const def = lookup(currentType);
    if (!def) {
      problems.push(`${at}: dropped — "${ref}" is a node type that is no longer loaded`);
      return;
    }
    const config = coerceConfig(def, raw.config, at, problems);
    if (!Object.keys(config).length && !raw.label) {
      // Nothing survived the field check, so this would be a no-op that still
      // reset the step's result. Dropping it is the honest outcome.
      problems.push(`${at}: dropped — no valid settings to change on "${ref}"`);
      return;
    }
    ops.push({op: 'configure', ref, ...(raw.label ? {label: raw.label} : {}), config, why});
  });

  return {
    summary: edit.summary ?? '',
    ops,
    caveats: edit.caveats ?? [],
    unsupported: edit.unsupported ?? [],
    problems,
  };
}
