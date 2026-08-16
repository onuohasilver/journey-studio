// ---- Talking to the AI endpoints ----
// Thin on purpose: the interesting work is the grounding on the way out and the
// validation on the way back, both of which live next door.

import type {RawEdit, RawPlan} from './validate';

export interface AiStatus {
  configured: boolean;
  model: string;
  hint?: string;
}

export interface Explanation {
  headline: string;
  summary: string;
  steps: {ref: string; what: string}[];
  watchOuts?: string[];
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as T | {error: string};
  if (payload && typeof payload === 'object' && 'error' in payload) {
    throw new Error((payload as {error: string}).error);
  }
  return payload as T;
}

export async function aiStatus(): Promise<AiStatus> {
  try {
    const res = await fetch('/api/ai/status');
    if (!res.ok) return {configured: false, model: '', hint: 'The API is not reachable.'};
    return (await res.json()) as AiStatus;
  } catch {
    return {configured: false, model: '', hint: 'The API is not reachable.'};
  }
}

export interface PlanRequest {
  goal: string;
  env: string;
  nodeIndex: string;
  environments: string;
}

export const requestPlan = (body: PlanRequest) => post<RawPlan>('/api/ai/plan', body);

export interface ReviseRequest extends PlanRequest {
  instruction: string;
  canvas: string;
  history: string;
}

export const requestRevision = (body: Omit<ReviseRequest, 'goal'>) => post<RawEdit>('/api/ai/revise', body);

export const requestExplanation = (body: {canvas: string; nodeIndex: string; environments: string}) =>
  post<Explanation>('/api/ai/explain', body);

export interface SuggestedAssertion {
  path: string;
  op: string;
  expected?: unknown;
  /** One line on the regression it catches — the part worth reading. */
  why: string;
}

export interface AssertionSuggestions {
  assertions: SuggestedAssertion[];
  /** Fields deliberately left alone, and why. */
  skipped?: string[];
}

/**
 * Ask for checks based on what a step actually returned.
 *
 * Note what crosses the wire: the response body goes to the model. Bodies
 * routinely hold tokens and personal data, so this is a deliberate action with a
 * warning next to it rather than something that happens on every run.
 */
export interface CoverageSuggestion {
  journey: string;
  why: string;
  types: string[];
  risk?: 'high' | 'medium' | 'low';
}

export interface CoverageAdvice {
  headline?: string;
  suggestions: CoverageSuggestion[];
}

/** Rank the gaps. The counting is done in `coverageOf`, never here. */
export const requestCoverageAdvice = (body: {
  gaps: string;
  covered: string;
  nodeIndex: string;
  environments: string;
}) => post<CoverageAdvice>('/api/ai/coverage', body);

export interface Reproduction {
  summary: string;
  steps: {type: string; label?: string; why: string; config?: {key: string; value: string}[]}[];
  /** What it decided because the report did not say. */
  assumptions: string[];
  /** What it would need from the reporter to make this exact. */
  missing?: string[];
  expected?: string;
}

export const requestReproduction = (body: {report: string; nodeIndex: string; environments: string}) =>
  post<Reproduction>('/api/ai/reproduce', body);

export const requestAssertions = (body: {
  step: string;
  response: unknown;
  schema?: unknown;
  nodeIndex: string;
  environments: string;
}) => post<AssertionSuggestions>('/api/ai/assert', body);
