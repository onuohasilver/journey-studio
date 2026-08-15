#!/usr/bin/env node
// ---- journey — run saved journeys from a terminal or a CI job ----
//
// Everything the UI can do to a journey, this can do without a browser. That is
// the whole point: a journey nobody runs on a schedule is a demo, and a QA suite
// that only exists in someone's tab is not a suite.
//
//   journey run                          every saved journey, default environment
//   journey run signup --env staging     one journey, somewhere specific
//   journey run --data users.csv         run it once per row of a spreadsheet
//   journey run --repeat 5               find the flaky steps
//   journey run --report qa.json         write the evidence
//   journey run --slack                  post the result
//   journey run -u                       record what the responses look like now
//   journey run --strict                 fail on drift, not just on assertions
//   journey compare --env staging --with prod   the same journey, both sides
//
// Exit code is 1 on any failure, so CI stops without anyone wiring up a parser.

import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runJourney, runJourneyCases, shapesFrom, type Transport} from '../src/core/engine';
import {register, lookup, resetRegistry} from '../src/core/registry';
import {BUILTINS} from '../src/core/builtins';
import {casesFromCsv} from '../src/core/csv';
import {checkJourney} from '../src/core/graph';
import {
  buildJourneyReport,
  buildReport,
  findFlakes,
  findSlowSteps,
  summariseText,
  type JourneyReport,
  type QaReport,
} from '../src/core/report';
import {compareRuns, summariseComparison} from '../src/core/compare';
import {formatReport, sendToSlack} from '../src/core/slack';
import {loadConfig} from '../server/config';
import {sendRequest} from '../server/proxy';
import {listJourneys, loadJourney, loadSnapshot, saveSnapshot} from '../server/journeys';
import type {Journey, NodeState, ResolvedRequest} from '../src/core/types';

interface Options {
  names: string[];
  env?: string;
  repeat: number;
  report?: string;
  data?: string;
  slack: boolean;
  strictContract: boolean;
  strictSnapshot: boolean;
  strictBudget: boolean;
  updateSnapshots: boolean;
  with?: string;
  includeBodies: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    names: [],
    repeat: 1,
    slack: false,
    strictContract: false,
    strictSnapshot: false,
    strictBudget: false,
    updateSnapshots: false,
    includeBodies: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--env': options.env = argv[++i]; break;
      case '--repeat': options.repeat = Math.max(1, Number(argv[++i]) || 1); break;
      case '--report': options.report = argv[++i]; break;
      case '--data': options.data = argv[++i]; break;
      case '--slack': options.slack = true; break;
      case '--strict-contract': options.strictContract = true; break;
      case '--strict-snapshot': options.strictSnapshot = true; break;
      case '--strict-budget': options.strictBudget = true; break;
      case '--with': options.with = argv[++i]; break;
      // One flag for "any drift is a failure", because that is the thing people
      // actually want and nobody remembers three flags for it.
      case '--strict':
        options.strictContract = true;
        options.strictSnapshot = true;
        options.strictBudget = true;
        break;
      case '-u':
      case '--update-snapshots': options.updateSnapshots = true; break;
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
  --data <file.csv>     run each journey once per row, header names the variables
  --repeat <n>          run the suite n times and report flaky steps
  --report <file>       write the full report as JSON
  --slack               post the result to the configured webhook
  -u, --update-snapshots  record the response shapes as the new baseline
  --strict              fail on drift — contract or shape — not just assertions
  --strict-contract     fail only on a response that stopped matching the spec
  --strict-snapshot     fail only on a response whose shape moved
  --strict-budget       fail only on a step slower than its declared budget
  --include-bodies      keep response bodies for failures in the JSON report
  --quiet               only print the verdict

journey compare [names…] --env <a> --with <b>

  Runs each journey against both environments and prints only where they
  disagree: statuses, response shapes, and steps one side is much slower at.
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

  // A CSV on the command line overrides whatever the file carries, so the same
  // saved journey can be pointed at a different dataset per environment.
  const override = options.data
    ? casesFromCsv(await readFile(path.resolve(root, options.data), 'utf8'))
    : undefined;
  if (override && !options.quiet) {
    for (const warning of override.warnings) process.stdout.write(`  ! ${warning}\n`);
  }
  if (override && !override.cases.length) {
    throw new Error(`No cases in ${options.data}. The first row names the variables; add a row per case.`);
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

    const recorded = await loadSnapshot(root, summary.file);
    const journey = override ? {...saved.journey, cases: override.cases} : saved.journey;

    if (!options.quiet && journey.cases?.length) {
      process.stdout.write(`\n${journey.name} — ${journey.cases.length} cases\n`);
    }

    // A journey whose steps overwrite what the cases supply runs every row
    // against the same value and reports all of them green. That is worth
    // shouting about even in --quiet, because the alternative is a suite that
    // looks like coverage and is not.
    for (const problem of checkJourney(journey, lookup)) {
      if (problem.kind !== 'case-overwritten') continue;
      const step = journey.nodes.find((n) => n.id === problem.nodeId);
      process.stderr.write(`  ! "${step?.label ?? problem.nodeId}" ${problem.message}\n`);
    }

    const runs = await runJourneyCases(journey, {
      env,
      lookup,
      transport,
      baseline: recorded?.nodes,
      strictContract: options.strictContract,
      // Recording and comparing at once would make every run agree with itself.
      strictSnapshot: options.strictSnapshot && !options.updateSnapshots,
      strictBudget: options.strictBudget,
      hooks: options.quiet ? undefined : {onLog: (line) => process.stdout.write(`  ${line}\n`)},
    });

    for (const run of runs) {
      reports.push(
        buildJourneyReport(journey, run.result.states, run.result.context, lookup, {
          includeBodies: options.includeBodies,
          caseName: run.case?.name,
        }),
      );
    }

    if (options.updateSnapshots) {
      // The first run is the one recorded: with cases, later rows can legitimately
      // return a different shape, and a baseline that is the last row's shape
      // would report drift on every row before it.
      const shapes = shapesFrom(runs[0]?.result.states ?? {});
      if (Object.keys(shapes).length) {
        const file = await saveSnapshot(root, summary.file, shapes, {journey: journey.name, env});
        if (!options.quiet) process.stdout.write(`  recorded ${Object.keys(shapes).length} shapes to ${file}\n`);
      }
    }
  }

  return buildReport(env, reports, {
    startedAt,
    durationMs: Date.now() - started,
    baseUrl: environment.baseUrl,
  });
}

/** Run every wanted journey in one environment, keeping the raw states. */
async function runIn(env: string, options: Options, root: string) {
  const config = loadConfig(root);
  if (!config.environments.some((e) => e.name === env)) {
    throw new Error(`No environment called "${env}". Known: ${config.environments.map((e) => e.name).join(', ')}`);
  }
  const transport: Transport = {
    send: (request: ResolvedRequest, forEnv: string) => sendRequest(request, forEnv, config),
  };

  const available = await listJourneys(root);
  const wanted = options.names.length
    ? available.filter((j) => options.names.some((n) => j.name === n || j.file === n || j.file === `${n}.journey.json`))
    : available;

  const out: {journey: Journey; states: Record<string, NodeState>; lookup: typeof lookup}[] = [];
  for (const summary of wanted) {
    const saved = await loadJourney(root, summary.file);
    if (!saved) continue;
    resetRegistry();
    register(BUILTINS);
    register(saved.defs);
    const result = await runJourney(saved.journey, {env, lookup, transport});
    out.push({journey: saved.journey, states: result.states, lookup});
  }
  return out;
}

/**
 * Run the same journeys against two environments and print the disagreements.
 *
 * "It works on staging" is the oldest bug report there is, and it is hard to act
 * on because nobody has the two runs side by side.
 */
async function compare(options: Options, root: string): Promise<number> {
  const a = options.env;
  const b = options.with;
  if (!a || !b) {
    process.stderr.write('compare needs both --env <a> and --with <b>.\n');
    return 2;
  }

  // Sequential rather than parallel: the two runs create data, and interleaving
  // them across environments makes any ordering bug impossible to reason about.
  const left = await runIn(a, options, root);
  const right = await runIn(b, options, root);

  let differing = 0;
  for (const [i, side] of left.entries()) {
    const other = right[i];
    if (!other) continue;
    const comparison = compareRuns(
      side.journey,
      {env: a, states: side.states},
      {env: b, states: other.states},
      side.lookup,
    );
    if (comparison.differences.some((d) => d.severity === 'error')) differing += 1;
    process.stdout.write(`\n${summariseComparison(comparison)}\n`);
  }

  return differing ? 1 : 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command !== 'run' && command !== 'compare') {
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  const options = parseArgs(rest);
  const root = process.cwd();

  if (command === 'compare') return compare(options, root);

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
  // Budgets are judged across every run and every case, not on one sample.
  const slow = findSlowSteps(attempts);
  if (slow.length) report.slow = slow;

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
  // A blown budget is only a failure when asked for — otherwise one slow
  // afternoon turns the build red and the budget gets deleted.
  const budgetFails = options.strictBudget && report.slow?.length;
  return report.status === 'passed' && !report.flaky?.length && !budgetFails ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
