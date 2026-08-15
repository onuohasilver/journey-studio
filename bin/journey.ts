#!/usr/bin/env node
// ---- journey — run saved journeys from a terminal or a CI job ----
//
// Everything the UI can do to a journey, this can do without a browser. That is
// the whole point: a journey nobody runs on a schedule is a demo, and a QA suite
// that only exists in someone's tab is not a suite.
//
//   journey run                          every saved journey, default environment
//   journey run signup --env staging     one journey, somewhere specific
//   journey run --repeat 5               find the flaky steps
//   journey run --report qa.json         write the evidence
//   journey run --slack                  post the result
//   journey run --strict-contract        fail when a response stops matching the spec
//
// Exit code is 1 on any failure, so CI stops without anyone wiring up a parser.

import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runJourney, type Transport} from '../src/core/engine';
import {register, lookup, resetRegistry} from '../src/core/registry';
import {BUILTINS} from '../src/core/builtins';
import {buildJourneyReport, buildReport, findFlakes, summariseText, type JourneyReport, type QaReport} from '../src/core/report';
import {formatReport, sendToSlack} from '../src/core/slack';
import {loadConfig} from '../server/config';
import {sendRequest} from '../server/proxy';
import {listJourneys, loadJourney} from '../server/journeys';
import type {ResolvedRequest} from '../src/core/types';

interface Options {
  names: string[];
  env?: string;
  repeat: number;
  report?: string;
  slack: boolean;
  strictContract: boolean;
  includeBodies: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    names: [],
    repeat: 1,
    slack: false,
    strictContract: false,
    includeBodies: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--env': options.env = argv[++i]; break;
      case '--repeat': options.repeat = Math.max(1, Number(argv[++i]) || 1); break;
      case '--report': options.report = argv[++i]; break;
      case '--slack': options.slack = true; break;
      case '--strict-contract': options.strictContract = true; break;
      case '--include-bodies': options.includeBodies = true; break;
      case '--quiet': options.quiet = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
        options.names.push(arg);
    }
  }
  return options;
}

const USAGE = `journey run [names…] [options]

  --env <name>          environment from journey.config.json
  --repeat <n>          run the suite n times and report flaky steps
  --report <file>       write the full report as JSON
  --slack               post the result to the configured webhook
  --strict-contract     fail a step whose response stops matching the spec
  --include-bodies      keep response bodies for failures in the JSON report
  --quiet               only print the verdict
`;

async function runOnce(options: Options, root: string): Promise<QaReport> {
  const config = loadConfig(root);
  const env = options.env ?? config.environments[0]?.name ?? '';
  const environment = config.environments.find((e) => e.name === env);
  if (!environment) {
    throw new Error(`No environment called "${env}". Known: ${config.environments.map((e) => e.name).join(', ')}`);
  }

  // The CLI is the proxy: it holds the credentials and makes the calls, exactly
  // as the dev server does for the browser.
  const transport: Transport = {
    send: (request: ResolvedRequest, forEnv: string) => sendRequest(request, forEnv, config),
  };

  const available = await listJourneys(root);
  const wanted = options.names.length
    ? available.filter((j) => options.names.some((n) => j.name === n || j.file === n || j.file === `${n}.journey.json`))
    : available;

  if (!wanted.length) {
    throw new Error(
      options.names.length
        ? `No saved journey matched: ${options.names.join(', ')}`
        : `No saved journeys in ${path.join(root, 'journeys')}. Save one from the studio first.`,
    );
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const reports: JourneyReport[] = [];

  for (const summary of wanted) {
    const saved = await loadJourney(root, summary.file);
    if (!saved) continue;

    // Definitions travel inside the file, so CI needs no spec and no import.
    resetRegistry();
    register(BUILTINS);
    register(saved.defs);

    const result = await runJourney(saved.journey, {
      env,
      lookup,
      transport,
      strictContract: options.strictContract,
      hooks: options.quiet ? undefined : {onLog: (line) => process.stdout.write(`  ${line}\n`)},
    });

    reports.push(
      buildJourneyReport(saved.journey, result.states, result.context, lookup, {
        includeBodies: options.includeBodies,
      }),
    );
  }

  return buildReport(env, reports, {
    startedAt,
    durationMs: Date.now() - started,
    baseUrl: environment.baseUrl,
  });
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command !== 'run') {
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  const options = parseArgs(rest);
  const root = process.cwd();

  const attempts: QaReport[] = [];
  for (let i = 0; i < options.repeat; i++) {
    if (options.repeat > 1 && !options.quiet) process.stdout.write(`\nattempt ${i + 1} of ${options.repeat}\n`);
    attempts.push(await runOnce(options, root));
  }

  // With repeats, the last attempt carries the detail and the flake list is the
  // interesting part — a step that passed 4 times and failed once is the bug
  // that wastes a whole morning.
  const report = attempts[attempts.length - 1];
  if (attempts.length > 1) report.flaky = findFlakes(attempts);

  process.stdout.write(`\n${summariseText(report)}\n`);

  if (options.report) {
    await writeFile(path.resolve(root, options.report), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nreport written to ${options.report}\n`);
  }

  if (options.slack) {
    const config = loadConfig(root);
    const webhook = config.slack?.webhookUrl;
    if (!webhook) {
      process.stderr.write('\n--slack given but no webhook configured (slack.webhookUrl or SLACK_WEBHOOK_URL).\n');
      return 2;
    }
    const sent = await sendToSlack(webhook, formatReport(report, {title: config.slack?.title}));
    process.stdout.write(sent.ok ? 'posted to Slack\n' : `could not post to Slack: ${sent.error}\n`);
    if (!sent.ok) return 2;
  }

  // Flaky steps are a failure even when the last attempt happened to be green.
  return report.status === 'passed' && !report.flaky?.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
