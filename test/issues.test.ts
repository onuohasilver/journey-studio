import {describe, expect, it} from 'vitest';
import {fileIssues, markerFor, planFilings} from '../src/core/issues';
import {buildReport, type JourneyReport, type StepReport} from '../src/core/report';
import type {StepTrend} from '../src/core/history';

const step = (over: Partial<StepReport> = {}): StepReport => ({
  id: 's1',
  label: 'Read the order',
  type: 'demo.get',
  status: 'passed',
  durationMs: 12,
  failedAssertions: [],
  contract: [],
  shapeChanges: [],
  ...over,
});

const journey = (over: Partial<JourneyReport> = {}): JourneyReport => ({
  name: 'Orders',
  status: 'passed',
  durationMs: 12,
  steps: [step()],
  created: [],
  contractBreaks: 0,
  shapeBreaks: 0,
  leaked: [],
  mocked: 0,
  ...over,
});

const reportOf = (j: JourneyReport[]) =>
  buildReport('staging', j, {startedAt: '2026-08-16T09:00:00.000Z', durationMs: 20});

const failing = () =>
  reportOf([
    journey({status: 'failed', steps: [step({status: 'failed', error: 'expected 200, got 500'})]}),
  ]);

const trend = (over: Partial<StepTrend> = {}): StepTrend => ({
  id: 's1',
  label: 'Read the order',
  results: ['failed'],
  durations: [12],
  runs: 1,
  failures: 1,
  ...over,
});

describe('deciding what to file', () => {
  it('opens one issue for a step that has just started failing', () => {
    const [filing] = planFilings(failing());
    expect(filing.action).toBe('open');
    expect(filing.title).toBe('Read the order is failing in Orders');
    expect(filing.body).toContain('expected 200, got 500');
  });

  it('updates rather than opens when the failure is not new', () => {
    // A step failing for the fifth night running is the same problem, not the
    // fifth one. This is the difference between a useful bot and a muted one.
    const trends = new Map([['s1', trend({runs: 5, failures: 5, failingSince: '2026-08-12T09:00:00Z'})]]);
    expect(planFilings(failing(), trends)[0].action).toBe('update');
  });

  it('files one issue for a data-driven journey, not one per row', () => {
    // Twelve rows failing the same step is one problem.
    const cased = reportOf([
      journey({case: 'a', status: 'failed', steps: [step({status: 'failed', error: 'boom'})]}),
      journey({case: 'b', status: 'failed', steps: [step({status: 'failed', error: 'boom'})]}),
      journey({case: 'c', status: 'failed', steps: [step({status: 'failed', error: 'boom'})]}),
    ]);
    expect(planFilings(cased)).toHaveLength(1);
  });

  it('closes the issue when the step passes again', () => {
    const [filing] = planFilings(reportOf([journey()]));
    expect(filing.action).toBe('close');
    expect(filing.body).toContain('Passing again');
  });

  it('carries the evidence someone needs to start on it', () => {
    const rich = reportOf([
      journey({
        status: 'failed',
        steps: [
          step({
            status: 'failed',
            error: 'expected 200, got 500',
            request: {method: 'GET', url: '/orders/42'},
            contract: [{kind: 'missing-required', path: 'id', severity: 'error', message: 'id is gone'}],
          }),
        ],
      }),
    ]);
    const trends = new Map([['s1', trend({failingSince: '2026-08-12T09:00:00Z', runs: 5, failures: 5})]]);
    const [filing] = planFilings(rich, trends);

    expect(filing.body).toContain('GET /orders/42');
    expect(filing.body).toContain('Failing since **2026-08-12 09:00**');
    expect(filing.body).toContain('id is gone');
  });

  it('says when the webhook was mocked, so nobody chases a phantom', () => {
    const mocked = reportOf([
      journey({status: 'failed', steps: [step({status: 'failed', mocked: true, error: 'boom'})]}),
    ]);
    expect(planFilings(mocked)[0].body).toContain('was not exercised');
  });

  it('hides the dedup key in the body, where nobody will tidy it away', () => {
    const [filing] = planFilings(failing());
    expect(filing.marker).toBe(markerFor('Orders', 's1'));
    expect(filing.body).toContain(filing.marker);
    expect(filing.title).not.toContain('journey-studio:');
  });
});

/** A GitHub stand-in that records what it was asked to do. */
function tracker(existing?: {number: number; state: string}) {
  const calls: {method: string; url: string; body?: unknown}[] = [];
  const fetchImpl = (async (url: string, init?: {method?: string; body?: string}) => {
    calls.push({method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body) : undefined});
    if (url.includes('/search/issues')) {
      return {
        ok: true,
        json: async () => ({items: existing ? [{...existing, html_url: 'https://gh/1'}] : []}),
      };
    }
    return {ok: true, json: async () => ({number: 7, html_url: 'https://gh/7', state: 'open'})};
  }) as unknown as typeof fetch;
  return {calls, fetchImpl};
}

const config = {provider: 'github' as const, repo: 'acme/api', token: 't', labels: ['qa']};

describe('applying the plan', () => {
  it('searches for the marker before opening anything', async () => {
    const {calls, fetchImpl} = tracker();
    const results = await fileIssues(planFilings(failing()), config, fetchImpl);

    expect(calls[0].url).toContain('/search/issues');
    expect(decodeURIComponent(calls[0].url)).toContain('journey-studio:Orders#s1');
    expect(results[0].outcome).toBe('opened');
    expect(calls[1].body).toMatchObject({labels: ['qa']});
  });

  it('comments instead of opening a second issue', async () => {
    // The behaviour that keeps a tracker usable.
    const {calls, fetchImpl} = tracker({number: 7, state: 'open'});
    const results = await fileIssues(planFilings(failing()), config, fetchImpl);

    expect(results[0].outcome).toBe('commented');
    expect(calls.some((c) => c.url.endsWith('/issues/7/comments'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/issues'))).toBe(false);
  });

  it('closes an open issue when the step recovers', async () => {
    const {calls, fetchImpl} = tracker({number: 7, state: 'open'});
    const results = await fileIssues(planFilings(reportOf([journey()])), config, fetchImpl);

    expect(results[0].outcome).toBe('closed');
    expect(calls.some((c) => c.method === 'PATCH' && (c.body as {state: string}).state === 'closed')).toBe(true);
  });

  it('does nothing when a passing step has no issue to close', async () => {
    // The common case by far — most steps pass most nights, and this must not
    // produce any traffic at all.
    const {calls, fetchImpl} = tracker();
    const results = await fileIssues(planFilings(reportOf([journey()])), config, fetchImpl);

    expect(results[0].outcome).toBe('nothing-to-do');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('reports a tracker that is unreachable rather than throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('403 rate limited');
    }) as unknown as typeof fetch;
    const results = await fileIssues(planFilings(failing()), config, fetchImpl);

    expect(results[0].outcome).toBe('failed');
    expect(results[0].error).toContain('403');
  });

  it('honours a self-hosted API base', async () => {
    const {calls, fetchImpl} = tracker();
    await fileIssues(planFilings(failing()), {...config, apiBase: 'https://ghe.acme.com/api/v3/'}, fetchImpl);
    expect(calls[0].url.startsWith('https://ghe.acme.com/api/v3/search/issues')).toBe(true);
  });
});
