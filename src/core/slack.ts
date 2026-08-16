// ---- Posting a QA report to Slack ----
//
// The report has to survive being skimmed on a phone at 9am, so the message
// leads with the verdict and the failures, and leaves the passing detail out.
//
// Two rules shape what goes in the message:
//
//   No response bodies. They routinely hold tokens, emails and card fragments,
//   and a channel is the last place those should end up. Failures carry the
//   status, the assertion, and the request line — enough to reproduce.
//
//   Blocks are budgeted. Slack rejects a message over 50 blocks and truncates
//   text over 3000 characters, so a 40-journey suite has to summarise rather
//   than be cut off mid-sentence by the API.

import {journeyTitle, summariseDrift, type QaReport} from './report';

const MAX_BLOCKS = 45;
const MAX_TEXT = 2900;
const MAX_FAILURES_SHOWN = 8;

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function section(text: string): SlackBlock {
  return {type: 'section', text: {type: 'mrkdwn', text: clip(text)}};
}

/** Slack's mrkdwn is not Markdown; these four characters are the ones that bite. */
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatReport(report: QaReport, meta: {title?: string; link?: string} = {}): SlackMessage {
  const {totals} = report;
  const ok = report.status === 'passed';
  // A data-driven suite runs one journey many times, so "12 journeys" would be
  // wrong where "12 runs" is what happened.
  const unit = report.journeys.some((j) => j.case) ? 'runs' : 'journeys';
  const headline = `${ok ? '✅' : '🔴'} ${meta.title ?? 'API journeys'} — ${
    ok ? 'all passing' : `${totals.failed} of ${totals.journeys} failing`
  }`;

  const blocks: SlackBlock[] = [
    {type: 'header', text: {type: 'plain_text', text: clip(headline, 150), emoji: true}},
    {
      type: 'section',
      fields: [
        {type: 'mrkdwn', text: `*Environment*\n${escape(report.env)}`},
        {
          type: 'mrkdwn',
          text: `*${unit === 'runs' ? 'Runs' : 'Journeys'}*\n${totals.passed} passed · ${totals.failed} failed`,
        },
        {type: 'mrkdwn', text: `*Steps*\n${totals.steps}`},
        {type: 'mrkdwn', text: `*Took*\n${(report.durationMs / 1000).toFixed(1)}s`},
      ],
    },
  ];

  // Drift gets its own line even when everything passed — a response that
  // stopped matching its spec, or changed shape since it was recorded, is news
  // whether or not a test caught it.
  const drifted = summariseDrift(totals);
  if (drifted) {
    blocks.push(
      section(
        `:warning: *${escape(drifted)}.* Assertions still pass, so nothing failed — but a consumer may ` +
          `already be broken.`,
      ),
    );
  }

  // Never let a channel read a green run as proof the integration works when the
  // callbacks were canned.
  if (totals.mocked) {
    blocks.push(
      section(
        `:test_tube: *${totals.mocked} webhook${totals.mocked === 1 ? '' : 's'} delivered from mocks*, ` +
          `not the real integration.`,
      ),
    );
  }

  const failures = report.journeys.filter((j) => j.status === 'failed');
  if (failures.length) {
    blocks.push({type: 'divider'});
    for (const journey of failures.slice(0, MAX_FAILURES_SHOWN)) {
      const failed = journey.steps.filter((s) => s.status === 'failed');
      const detail = failed
        .map((step) => {
          const where = step.request ? `\n   \`${escape(step.request.method)} ${escape(step.request.url)}\`` : '';
          return `• *${escape(step.label)}*${step.httpStatus ? ` — ${step.httpStatus}` : ''}\n   ${escape(
            step.error ?? 'failed',
          )}${where}`;
        })
        .join('\n');
      blocks.push(section(`*${escape(journeyTitle(journey))}*\n${detail || '• failed'}`));
    }
    if (failures.length > MAX_FAILURES_SHOWN) {
      blocks.push(section(`…and ${failures.length - MAX_FAILURES_SHOWN} more failing journeys.`));
    }
  }

  // What the run left behind on a shared environment, which is the thing people
  // forget to ask about until the data is already there.
  const created = report.journeys.flatMap((j) => j.created);
  if (created.length) {
    blocks.push(
      section(
        `*Created on ${escape(report.env)}:* ${created
          .slice(0, 12)
          .map((c) => `${escape(c.key)}=\`${escape(c.value)}\``)
          .join(', ')}${created.length > 12 ? `, +${created.length - 12} more` : ''}`,
      ),
    );
  }

  // Data left on a shared environment is the line an on-call person needs even
  // when everything else was green.
  if (totals.leaked) {
    const names = report.journeys.flatMap((j) => j.leaked);
    blocks.push(
      section(
        `:broom: *${totals.leaked} cleanup step${totals.leaked === 1 ? '' : 's'} failed* — ` +
          `data was left on ${escape(report.env)}: ${names.slice(0, 6).map(escape).join(', ')}` +
          `${names.length > 6 ? `, +${names.length - 6} more` : ''}`,
      ),
    );
  }

  if (report.slow?.length) {
    blocks.push(
      section(
        `:stopwatch: *Over budget:* ${report.slow
          .slice(0, 6)
          .map((s) => `${escape(s.step)} p95 ${s.p95}ms / ${s.budgetMs}ms`)
          .join(', ')}`,
      ),
    );
  }

  if (report.skipped?.length) {
    blocks.push(
      section(
        `:no_entry_sign: *${report.skipped.length} journey${report.skipped.length === 1 ? '' : 's'} did not run* — ` +
          `${report.skipped.slice(0, 5).map((s) => escape(s.name)).join(', ')} ` +
          `${report.skipped.length > 5 ? `and ${report.skipped.length - 5} more ` : ''}` +
          `need a setup that failed.`,
      ),
    );
  }

  if (report.flaky?.length) {
    blocks.push(
      section(
        `:repeat: *Flaky:* ${report.flaky
          .slice(0, 8)
          .map((f) => `${escape(f.step)} (${f.passed}/${f.of})`)
          .join(', ')}`,
      ),
    );
  }

  const context: string[] = [new Date(report.startedAt).toUTCString()];
  if (report.baseUrl) context.push(escape(report.baseUrl));
  if (meta.link) context.push(`<${meta.link}|open the report>`);
  blocks.push({type: 'context', elements: [{type: 'mrkdwn', text: clip(context.join('  ·  '), 300)}]});

  return {
    // Fallback text is what shows in the notification and on devices that do
    // not render blocks — it has to carry the verdict on its own.
    text: clip(headline, 300),
    blocks: blocks.slice(0, MAX_BLOCKS),
  };
}

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Post to a Slack incoming webhook.
 *
 * A webhook URL *is* the credential — it carries its secret in the path — so it
 * is treated like any other secret: read on the server, never sent to the
 * browser, never written into a report.
 */
export async function sendToSlack(webhookUrl: string, message: SlackMessage): Promise<SendResult> {
  if (!/^https:\/\/hooks\.slack\.com\//.test(webhookUrl)) {
    return {ok: false, error: 'That does not look like a Slack incoming webhook URL.'};
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(message),
    });
    const body = await res.text();
    if (!res.ok) return {ok: false, status: res.status, error: body || `Slack returned ${res.status}`};
    return {ok: true, status: res.status};
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : 'could not reach Slack'};
  }
}
