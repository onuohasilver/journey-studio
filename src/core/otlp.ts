// ---- Sending the run to wherever your metrics already live ----
//
// A budget breach in a CI log is an artefact somebody has to go and find. The
// same number on the dashboard beside production latency is a thing people
// already look at — and it answers the question the CI log cannot: is the API
// slower for our synthetic check, or slower for everyone?
//
// OTLP rather than a vendor SDK. It is the neutral protocol, Datadog, Grafana,
// Honeycomb, New Relic and the OpenTelemetry Collector all accept it, and the
// HTTP/JSON encoding is small enough to write out — which keeps a dependency,
// and a supply-chain surface, out of a tool whose whole pitch is that it lives
// in your repo.

import {journeyTitle, type QaReport} from './report';

export interface OtlpConfig {
  /** Base endpoint, e.g. http://localhost:4318. `/v1/metrics` is appended. */
  endpoint: string;
  /** Sent with the export — an API key usually lives here. */
  headers?: Record<string, string>;
  /** Identifies this suite among everything else reporting to the collector. */
  serviceName?: string;
}

type Attribute = {key: string; value: {stringValue: string} | {intValue: string} | {boolValue: boolean}};

function attributes(pairs: Record<string, string | number | boolean | undefined>): Attribute[] {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({
      key,
      value:
        typeof value === 'boolean'
          ? {boolValue: value}
          : typeof value === 'number'
            ? {intValue: String(Math.round(value))}
            : {stringValue: String(value)},
    }));
}

interface DataPoint {
  asDouble?: number;
  asInt?: string;
  timeUnixNano: string;
  attributes: Attribute[];
}

export interface OtlpMetric {
  name: string;
  unit: string;
  description: string;
  gauge?: {dataPoints: DataPoint[]};
  sum?: {dataPoints: DataPoint[]; aggregationTemporality: number; isMonotonic: boolean};
}

function gauge(name: string, unit: string, description: string, points: DataPoint[]): OtlpMetric {
  return {name, unit, description, gauge: {dataPoints: points}};
}

function sum(name: string, unit: string, description: string, points: DataPoint[]): OtlpMetric {
  return {
    name,
    unit,
    description,
    sum: {
      dataPoints: points,
      // Monotonic deltas: each export describes one run rather than a running
      // total, which is what makes two runners reporting independently add up.
      aggregationTemporality: 1,
      isMonotonic: true,
    },
  };
}

/**
 * The run as OTLP metrics.
 *
 * Step duration is a gauge rather than a histogram on purpose. A histogram of
 * one observation is a lie dressed as statistics, and the percentile that
 * matters here is already computed across runs by `findSlowSteps` — where it can
 * be taken over cases and repeats, which a per-export histogram cannot see.
 */
export function toOtlpMetrics(report: QaReport, config: OtlpConfig = {endpoint: ''}) {
  const at = String(Date.parse(report.startedAt) * 1_000_000);
  const common = {env: report.env};

  const stepDurations: DataPoint[] = [];
  const stepStatus: DataPoint[] = [];
  const budgetBreaches: DataPoint[] = [];

  for (const journey of report.journeys) {
    for (const step of journey.steps) {
      const tags = {
        ...common,
        journey: journey.name,
        ...(journey.case ? {case: journey.case} : {}),
        step: step.label,
        status: step.status,
        ...(step.httpStatus ? {http_status: step.httpStatus} : {}),
        // So a dashboard can exclude mocked runs from an integration SLO.
        ...(step.mocked ? {mocked: true} : {}),
      };

      if (step.durationMs !== undefined) {
        stepDurations.push({asDouble: step.durationMs, timeUnixNano: at, attributes: attributes(tags)});
      }
      stepStatus.push({
        asInt: step.status === 'passed' ? '1' : '0',
        timeUnixNano: at,
        attributes: attributes(tags),
      });
      if (step.overBudget) {
        budgetBreaches.push({
          asInt: '1',
          timeUnixNano: at,
          attributes: attributes({...tags, budget_ms: step.overBudget.budgetMs}),
        });
      }
    }
  }

  const journeyStatus: DataPoint[] = report.journeys.map((journey) => ({
    asInt: journey.status === 'passed' ? '1' : '0',
    timeUnixNano: at,
    attributes: attributes({...common, journey: journeyTitle(journey)}),
  }));

  const drift: DataPoint[] = [
    {
      asInt: String(report.totals.contractBreaks + report.totals.shapeBreaks),
      timeUnixNano: at,
      attributes: attributes(common),
    },
  ];

  const metrics = [
    gauge('journey.step.duration', 'ms', 'How long one step took', stepDurations),
    gauge('journey.step.up', '1', 'Whether a step passed', stepStatus),
    gauge('journey.up', '1', 'Whether a journey passed end to end', journeyStatus),
    sum('journey.drift', '1', 'Responses that stopped matching their spec or recorded shape', drift),
    ...(budgetBreaches.length
      ? [sum('journey.budget.breached', '1', 'Steps slower than their declared budget', budgetBreaches)]
      : []),
  ];

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: attributes({
            'service.name': config.serviceName ?? 'journey-studio',
            'deployment.environment': report.env,
          }),
        },
        scopeMetrics: [{scope: {name: 'journey-studio'}, metrics}],
      },
    ],
  };
}

export interface ExportResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Post the metrics.
 *
 * Failure is reported and never thrown: a collector being down is not a reason
 * to fail a build, and a QA tool that goes red because its telemetry sidecar
 * restarted is a QA tool people stop trusting.
 */
export async function sendOtlp(report: QaReport, config: OtlpConfig): Promise<ExportResult> {
  if (!config.endpoint) return {ok: false, error: 'No OTLP endpoint configured.'};

  const url = `${config.endpoint.replace(/\/$/, '')}/v1/metrics`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...(config.headers ?? {})},
      body: JSON.stringify(toOtlpMetrics(report, config)),
    });
    if (!res.ok) {
      return {ok: false, status: res.status, error: `${url} returned ${res.status}: ${(await res.text()).slice(0, 200)}`};
    }
    return {ok: true, status: res.status};
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : 'could not reach the collector'};
  }
}
