import {describe, expect, it} from 'vitest';
import {
  MAX_ENTRIES,
  appendHistory,
  describeTrend,
  entriesFrom,
  readHistory,
  trendsFrom,
  type HistoryEntry,
} from '../src/core/history';
import {buildReport, type JourneyReport, type StepReport} from '../src/core/report';

function step(over: Partial<StepReport> = {}): StepReport {
  return {
    id: 's1',
    label: 'Read the order',
    type: 'demo.get',
    status: 'passed',
    durationMs: 12,
    failedAssertions: [],
    contract: [],
    shapeChanges: [],
    ...over,
  };
}

function journey(over: Partial<JourneyReport> = {}): JourneyReport {
  return {
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
  };
}

const report = (at: string, over: Partial<JourneyReport> = {}) =>
  buildReport('staging', [journey(over)], {startedAt: at, durationMs: 12});

describe('what a run leaves behind', () => {
  it('keeps the shape of the answer, not the whole report', () => {
    const [entry] = entriesFrom(report('2026-01-01T00:00:00Z'));
    expect(entry).toMatchObject({at: '2026-01-01T00:00:00Z', env: 'staging', status: 'passed'});
    expect(entry.steps[0]).toMatchObject({id: 's1', label: 'Read the order', status: 'passed', drift: 0});
    // No bodies, no requests, no findings — a full report per run would be
    // megabytes a week and nobody would commit it.
    expect(JSON.stringify(entry).length).toBeLessThan(300);
  });

  it('counts drift rather than listing it', () => {
    const drifted = report('2026-01-01T00:00:00Z', {
      steps: [
        step({
          contract: [{kind: 'missing-required', path: 'id', severity: 'error', message: 'gone'}],
          shapeChanges: [{path: 'name', kind: 'removed', severity: 'error', message: 'gone too'}],
        }),
      ],
    });
    expect(entriesFrom(drifted)[0].steps[0].drift).toBe(2);
  });

  it('trims a long failure to something a file can hold', () => {
    const long = report('2026-01-01T00:00:00Z', {steps: [step({status: 'failed', error: 'x'.repeat(500)})]});
    expect(entriesFrom(long)[0].steps[0].error!.length).toBeLessThan(200);
  });

  it('writes one row per case for a data-driven run', () => {
    const cased = buildReport(
      'staging',
      [journey({case: 'nigeria'}), journey({case: 'ghana', status: 'failed'})],
      {startedAt: '2026-01-01T00:00:00Z', durationMs: 20},
    );
    expect(entriesFrom(cased).map((e) => [e.case, e.status])).toEqual([
      ['nigeria', 'passed'],
      ['ghana', 'failed'],
    ]);
  });

  it('records that a run was mocked, so a green row is not misread later', () => {
    const mocked = report('2026-01-01T00:00:00Z', {mocked: 2});
    expect(entriesFrom(mocked)[0].mocked).toBe(2);
  });

  it('keeps the file from growing forever', () => {
    let file = appendHistory(undefined, 'Orders', []);
    for (let i = 0; i < MAX_ENTRIES + 40; i++) {
      file = appendHistory(file, 'Orders', entriesFrom(report(`2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`)));
    }
    expect(file.entries.length).toBe(MAX_ENTRIES);
  });

  it('refuses a file from a newer version rather than misreading it', () => {
    expect(readHistory('{"version":99,"entries":[]}')).toBeUndefined();
    expect(readHistory('nope')).toBeUndefined();
  });
});

describe('reading the timeline', () => {
  const entry = (at: string, status: 'passed' | 'failed', durationMs = 10): HistoryEntry => ({
    at,
    env: 'staging',
    status,
    durationMs,
    steps: [{id: 's1', label: 'Read the order', status, durationMs, drift: 0}],
  });

  const file = (entries: HistoryEntry[]) => ({version: 1, journey: 'Orders', entries});

  it('answers "when did this start failing?"', () => {
    // The whole reason to keep history at all.
    const [trend] = trendsFrom(
      file([
        entry('2026-01-01T00:00:00Z', 'passed'),
        entry('2026-01-02T00:00:00Z', 'passed'),
        entry('2026-01-03T00:00:00Z', 'failed'),
        entry('2026-01-04T00:00:00Z', 'failed'),
      ]),
    );

    expect(trend.failingSince).toBe('2026-01-03T00:00:00Z');
    expect(trend.lastChangedAt).toBe('2026-01-03T00:00:00Z');
    expect(describeTrend(trend)).toContain('failing since 2026-01-03');
  });

  it('reports the current run of failures, not the first one that ever happened', () => {
    // A step that broke in January, was fixed, and broke again yesterday is
    // failing since yesterday. Saying "since January" would send someone to the
    // wrong commit.
    const [trend] = trendsFrom(
      file([
        entry('2026-01-01T00:00:00Z', 'failed'),
        entry('2026-01-02T00:00:00Z', 'passed'),
        entry('2026-01-03T00:00:00Z', 'failed'),
      ]),
    );
    expect(trend.failingSince).toBe('2026-01-03T00:00:00Z');
  });

  it('says nothing about failing when the step is green now', () => {
    const [trend] = trendsFrom(file([entry('2026-01-01T00:00:00Z', 'failed'), entry('2026-01-02T00:00:00Z', 'passed')]));
    expect(trend.failingSince).toBeUndefined();
    expect(describeTrend(trend)).toContain('1 of 2 runs failed');
  });

  it('follows a step through a rename, because history is keyed on the id', () => {
    const renamed = file([
      entry('2026-01-01T00:00:00Z', 'passed'),
      {
        at: '2026-01-02T00:00:00Z',
        env: 'staging',
        status: 'passed',
        durationMs: 10,
        steps: [{id: 's1', label: 'Read the order back', status: 'passed', durationMs: 10, drift: 0}],
      },
    ]);
    const trends = trendsFrom(renamed);
    expect(trends).toHaveLength(1);
    expect(trends[0].label).toBe('Read the order back');
    expect(trends[0].runs).toBe(2);
  });

  it('leaves a gap where a step did not run at all', () => {
    const gappy = file([
      entry('2026-01-01T00:00:00Z', 'passed'),
      {at: '2026-01-02T00:00:00Z', env: 'staging', status: 'passed', durationMs: 0, steps: []},
      entry('2026-01-03T00:00:00Z', 'passed'),
    ]);
    const [trend] = trendsFrom(gappy);
    expect(trend.results).toEqual(['passed', null, 'passed']);
    expect(trend.runs).toBe(2);
  });

  it('has nothing to say about a journey that has never run', () => {
    expect(trendsFrom(undefined)).toEqual([]);
    expect(trendsFrom(file([]))).toEqual([]);
  });
});
