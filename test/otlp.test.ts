import {afterEach, describe, expect, it, vi} from 'vitest';
import {sendOtlp, toOtlpMetrics} from '../src/core/otlp';
import {buildReport, type JourneyReport, type StepReport} from '../src/core/report';

const step = (over: Partial<StepReport> = {}): StepReport => ({
  id: 's1',
  label: 'Read the order',
  type: 'demo.get',
  status: 'passed',
  durationMs: 120,
  httpStatus: 200,
  failedAssertions: [],
  contract: [],
  shapeChanges: [],
  ...over,
});

const journey = (over: Partial<JourneyReport> = {}): JourneyReport => ({
  name: 'Orders',
  status: 'passed',
  durationMs: 120,
  steps: [step()],
  created: [],
  contractBreaks: 0,
  shapeBreaks: 0,
  leaked: [],
  mocked: 0,
  ...over,
});

const reportOf = (j: JourneyReport[]) =>
  buildReport('staging', j, {startedAt: '2026-08-16T09:00:00.000Z', durationMs: 200});

/** Pull a metric out of the payload by name. */
const metric = (payload: ReturnType<typeof toOtlpMetrics>, name: string) =>
  payload.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name)!;

const attrsOf = (point: {attributes: {key: string; value: Record<string, unknown>}[]}) =>
  Object.fromEntries(point.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

afterEach(() => vi.unstubAllGlobals());

describe('the run as metrics', () => {
  it('emits a duration and an up/down for every step', () => {
    const payload = toOtlpMetrics(reportOf([journey()]));
    expect(metric(payload, 'journey.step.duration').gauge!.dataPoints[0].asDouble).toBe(120);
    expect(metric(payload, 'journey.step.up').gauge!.dataPoints[0].asInt).toBe('1');
    expect(metric(payload, 'journey.up').gauge!.dataPoints[0].asInt).toBe('1');
  });

  it('tags each point with what a dashboard slices by', () => {
    const payload = toOtlpMetrics(reportOf([journey({case: 'nigeria'})]));
    expect(attrsOf(metric(payload, 'journey.step.duration').gauge!.dataPoints[0])).toMatchObject({
      env: 'staging',
      journey: 'Orders',
      case: 'nigeria',
      step: 'Read the order',
      status: 'passed',
      http_status: '200',
    });
  });

  it('marks a mocked step, so an integration SLO can exclude it', () => {
    // A dashboard that counts a mocked run towards "the payment webhook works"
    // is worse than no dashboard.
    const payload = toOtlpMetrics(reportOf([journey({steps: [step({mocked: true})]})]));
    expect(attrsOf(metric(payload, 'journey.step.up').gauge!.dataPoints[0]).mocked).toBe(true);
  });

  it('reports a failure as zero rather than leaving the series out', () => {
    // A gap in a series looks like a collector problem; a zero looks like an
    // outage, which is what it is.
    const payload = toOtlpMetrics(reportOf([journey({status: 'failed', steps: [step({status: 'failed'})]})]));
    expect(metric(payload, 'journey.step.up').gauge!.dataPoints[0].asInt).toBe('0');
    expect(metric(payload, 'journey.up').gauge!.dataPoints[0].asInt).toBe('0');
  });

  it('counts both kinds of drift as one number', () => {
    const drifted = journey({contractBreaks: 2, shapeBreaks: 1});
    expect(metric(toOtlpMetrics(reportOf([drifted])), 'journey.drift').sum!.dataPoints[0].asInt).toBe('3');
  });

  it('only emits a budget metric when something breached one', () => {
    expect(toOtlpMetrics(reportOf([journey()])).resourceMetrics[0].scopeMetrics[0].metrics
      .map((m) => m.name)).not.toContain('journey.budget.breached');

    const breached = journey({steps: [step({overBudget: {budgetMs: 100, actualMs: 400}})]});
    const point = metric(toOtlpMetrics(reportOf([breached])), 'journey.budget.breached').sum!.dataPoints[0];
    expect(attrsOf(point).budget_ms).toBe('100');
  });

  it('reports deltas rather than running totals', () => {
    // Two runners exporting independently have to add up; a cumulative total
    // from each would double-count.
    const s = metric(toOtlpMetrics(reportOf([journey()])), 'journey.drift').sum!;
    expect(s.aggregationTemporality).toBe(1);
    expect(s.isMonotonic).toBe(true);
  });

  it('identifies itself so it is findable among everything else', () => {
    const resource = toOtlpMetrics(reportOf([journey()]), {endpoint: '', serviceName: 'example-api-journeys'})
      .resourceMetrics[0].resource;
    expect(attrsOf(resource as never)).toMatchObject({
      'service.name': 'example-api-journeys',
      'deployment.environment': 'staging',
    });
  });

  it('timestamps in nanoseconds, which is what OTLP expects', () => {
    const point = metric(toOtlpMetrics(reportOf([journey()])), 'journey.step.duration').gauge!.dataPoints[0];
    expect(point.timeUnixNano).toBe(String(Date.parse('2026-08-16T09:00:00.000Z') * 1_000_000));
  });
});

describe('sending them', () => {
  it('posts to the collector’s metrics path', async () => {
    const calls: [string, {headers: Record<string, string>}][] = [];
    vi.stubGlobal('fetch', async (url: string, init: {headers: Record<string, string>}) => {
      calls.push([url, init]);
      return {ok: true, status: 200, async text() { return ''; }};
    });

    const result = await sendOtlp(reportOf([journey()]), {
      endpoint: 'http://collector:4318/',
      headers: {'x-api-key': 'k'},
    });

    expect(result.ok).toBe(true);
    expect(calls[0][0]).toBe('http://collector:4318/v1/metrics');
    expect(calls[0][1].headers['x-api-key']).toBe('k');
  });

  it('reports a collector that is down without throwing', async () => {
    // A telemetry sidecar restarting must not fail a build, or people stop
    // trusting the tool for reasons that have nothing to do with the API.
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await sendOtlp(reportOf([journey()]), {endpoint: 'http://nope:4318'});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('says so when nothing is configured', async () => {
    expect((await sendOtlp(reportOf([journey()]), {endpoint: ''})).error).toContain('No OTLP endpoint');
  });
});
