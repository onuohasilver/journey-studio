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
