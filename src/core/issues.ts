// ---- Filing what broke, once ----
//
// A nightly suite that opens an issue per failure is a bot that files thirty
// issues a night and gets muted in a week. Deduplication is not a refinement
// here; it is the entire feature. Without it this is worse than nothing, because
// it also trains people to ignore the tracker.
//
// So the unit is not "a failed run" but "a step that is failing" — one issue per
// step, updated while it stays broken, closed when it goes green. History
// already knows when a failure started, which is what makes the distinction
// possible at all: a step failing for the fifth night running is the *same*
// problem, not the fifth one.

import {journeyTitle, type QaReport, type StepReport} from './report';
import {describeTrend, type StepTrend} from './history';

export interface IssueConfig {
  provider: 'github';
  /** `owner/name`. */
  repo: string;
  token: string;
  labels?: string[];
  /** Where the issues go, if not the same repo the suite lives in. */
  apiBase?: string;
}

/**
 * The marker that makes an issue findable again.
 *
 * Hidden in the body rather than encoded in the title, because titles get edited
 * by people and a dedup key that a human can break by tidying the wording is not
 * a dedup key.
 */
export function markerFor(journey: string, stepId: string): string {
  return `<!-- journey-studio:${journey}#${stepId} -->`;
}

export interface Filing {
  marker: string;
  title: string;
  body: string;
  /** What to do with the tracker: open it, add a note, or close it. */
  action: 'open' | 'update' | 'close';
}

function bodyFor(
  journey: string,
  step: StepReport,
  report: QaReport,
  trend: StepTrend | undefined,
): string {
  const lines = [
    markerFor(journey, step.id),
    '',
    `**${step.label}** in *${journey}* is failing on \`${report.env}\`.`,
    '',
    `> ${step.error ?? 'no message'}`,
    '',
  ];

  if (step.request) lines.push(`Request: \`${step.request.method} ${step.request.url}\``, '');
  if (trend?.failingSince) {
    lines.push(`Failing since **${trend.failingSince.slice(0, 16).replace('T', ' ')}**.`, '');
  }
  if (trend) lines.push(`History: ${describeTrend(trend)}.`, '');
  if (step.contract.length || step.shapeChanges.length) {
    lines.push('Drift:', ...[...step.contract, ...step.shapeChanges].slice(0, 5).map((f) => `- ${f.message}`), '');
  }
  if (step.mocked) {
    lines.push('> This step\'s webhook was delivered from a mock, so the real integration was not exercised.', '');
  }

  lines.push('---', '', 'Filed by Journey Studio. It will be updated while this keeps failing and closed when it passes.');
  return lines.join('\n');
}

/**
 * What should happen in the tracker, given this run.
 *
 * Pure, so the decision can be tested without a token and reviewed without
 * anybody's issue tracker filling up.
 */
export function planFilings(report: QaReport, trends: Map<string, StepTrend> = new Map()): Filing[] {
  const filings: Filing[] = [];
  const seen = new Set<string>();

  for (const journey of report.journeys) {
    for (const step of journey.steps) {
      const marker = markerFor(journey.name, step.id);
      // A data-driven journey fails the same step for many rows. That is one
      // problem, not twelve, so the first row to report it wins.
      if (seen.has(marker)) continue;

      const trend = trends.get(step.id);

      if (step.status === 'failed') {
        seen.add(marker);
        filings.push({
          marker,
          title: `${step.label} is failing in ${journeyTitle(journey)}`,
          body: bodyFor(journey.name, step, report, trend),
          // A failure that has been going for more than one run is an update to
          // a conversation, not a new one.
          action: trend?.failingSince && trend.runs > 1 ? 'update' : 'open',
        });
        continue;
      }

      if (step.status === 'passed') {
        seen.add(marker);
        filings.push({
          marker,
          title: `${step.label} is failing in ${journeyTitle(journey)}`,
          body: `${marker}\n\nPassing again on \`${report.env}\` as of ${report.startedAt.slice(0, 16).replace('T', ' ')}.`,
          action: 'close',
        });
      }
    }
  }

  return filings;
}

export interface FilingResult {
  marker: string;
  action: Filing['action'];
  /** What actually happened, which may differ — a close with nothing open is a no-op. */
  outcome: 'opened' | 'commented' | 'closed' | 'nothing-to-do' | 'failed';
  url?: string;
  error?: string;
}

interface GithubIssue {
  number: number;
  html_url: string;
  body?: string;
  state: string;
}

/**
 * Apply the plan to GitHub.
 *
 * Every call is guarded by a search for the marker first, so running this twice
 * over the same report changes nothing the second time.
 */
export async function fileIssues(
  filings: Filing[],
  config: IssueConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<FilingResult[]> {
  const api = (config.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${config.token}`,
    'content-type': 'application/json',
  };

  const results: FilingResult[] = [];

  for (const filing of filings) {
    try {
      // The marker is searched for rather than remembered locally: the tracker
      // is the source of truth, and a runner with no state must reach the same
      // conclusion as one that ran yesterday.
      const query = encodeURIComponent(`repo:${config.repo} in:body "${filing.marker}"`);
      const found = await fetchImpl(`${api}/search/issues?q=${query}`, {headers});
      const existing: GithubIssue | undefined = found.ok
        ? ((await found.json()) as {items?: GithubIssue[]}).items?.[0]
        : undefined;

      if (filing.action === 'close') {
        if (!existing || existing.state === 'closed') {
          results.push({marker: filing.marker, action: filing.action, outcome: 'nothing-to-do'});
          continue;
        }
        await fetchImpl(`${api}/repos/${config.repo}/issues/${existing.number}/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({body: filing.body}),
        });
        const closed = await fetchImpl(`${api}/repos/${config.repo}/issues/${existing.number}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({state: 'closed', state_reason: 'completed'}),
        });
        results.push({
          marker: filing.marker,
          action: filing.action,
          outcome: closed.ok ? 'closed' : 'failed',
          url: existing.html_url,
        });
        continue;
      }

      if (existing && existing.state === 'open') {
        // Already open: a comment, not another issue.
        const commented = await fetchImpl(`${api}/repos/${config.repo}/issues/${existing.number}/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({body: `Still failing.\n\n${filing.body}`}),
        });
        results.push({
          marker: filing.marker,
          action: filing.action,
          outcome: commented.ok ? 'commented' : 'failed',
          url: existing.html_url,
        });
        continue;
      }

      const created = await fetchImpl(`${api}/repos/${config.repo}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: filing.title,
          body: filing.body,
          ...(config.labels?.length ? {labels: config.labels} : {}),
        }),
      });
      const issue = created.ok ? ((await created.json()) as GithubIssue) : undefined;
      results.push({
        marker: filing.marker,
        action: filing.action,
        outcome: issue ? 'opened' : 'failed',
        url: issue?.html_url,
      });
    } catch (err) {
      results.push({
        marker: filing.marker,
        action: filing.action,
        outcome: 'failed',
        error: err instanceof Error ? err.message : 'the tracker could not be reached',
      });
    }
  }

  return results;
}
