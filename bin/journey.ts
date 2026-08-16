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
//   journey run --tag smoke              only journeys carrying that tag
//   journey run --var env=eu             seed a value into every run
//   journey run --mock-webhooks          deliver saved payloads instead of waiting
//   journey fixtures --seed              write the awkward upload fixtures
//   journey sweep                        delete what earlier failed runs left behind
//   journey compare --env staging --with prod   the same journey, both sides
//
// Exit code is 1 on any failure, so CI stops without anyone wiring up a parser.

import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import express from 'express';
import {runJourney, runJourneyCases, shapesFrom, type Transport} from '../src/core/engine';
import {register, lookup, resetRegistry} from '../src/core/registry';
import {BUILTINS, withMaterialised} from '../src/core/builtins';
import {casesFromCsv, coerce} from '../src/core/csv';
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
import {selectJourneys} from '../src/core/select';
import {buffered, inPool} from '../src/core/pool';
import {orderBySetup, type SetupResult} from '../src/core/setup';
import {describeTrend, markSwept, orphansIn, trendsFrom, type StepTrend} from '../src/core/history';
import {githubWorkflow, toJunitXml} from '../src/core/junit';
import {sendOtlp} from '../src/core/otlp';
import {fileIssues, planFilings} from '../src/core/issues';
import {formatReport, sendToSlack} from '../src/core/slack';
import {loadConfig} from '../server/config';
import {sendRequest} from '../server/proxy';
import {listJourneys, loadJourney, loadSnapshot, saveSnapshot, loadHistory, recordHistory, saveHistory, type JourneySummary} from '../server/journeys';
import {createInboxRouter, inbox, loadMocks} from '../server/inbox';
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
  noHistory: boolean;
  junit?: string;
  otlp: boolean;
  parallel: number;
  fileIssues: boolean;
  tags: string[];
  vars: Record<string, unknown>;
  updateSnapshots: boolean;
  mockWebhooks: boolean;
  inboxPort: number;
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
    noHistory: false,
    otlp: false,
    parallel: 1,
    fileIssues: false,
    tags: [],
    vars: {},
    updateSnapshots: false,
    mockWebhooks: false,
    inboxPort: Number(process.env.INBOX_PORT) || 5179,
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
      case '--mock-webhooks': options.mockWebhooks = true; break;
      case '--no-history': options.noHistory = true; break;
      case '--otlp': options.otlp = true; break;
      case '--parallel': options.parallel = Math.max(1, Number(argv[++i]) || 1); break;
      case '--file-issues': options.fileIssues = true; break;
      case '--junit': options.junit = argv[++i] ?? 'junit.xml'; break;
      case '--tag': options.tags.push(...String(argv[++i] ?? '').split(',').map((t) => t.trim()).filter(Boolean)); break;
      case '--var': {
        const raw = String(argv[++i] ?? '');
        const at = raw.indexOf('=');
        if (at <= 0) throw new Error(`--var needs key=value, got "${raw}"`);
        options.vars[raw.slice(0, at)] = coerce(raw.slice(at + 1));
        break;
      }
      case '--inbox-port': options.inboxPort = Number(argv[++i]) || 5179; break;
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
  --junit <file>        write JUnit XML, which every CI renders natively
  --parallel <n>        run n journeys at once; setups and serial ones stay alone
  --otlp                export metrics to the configured OTLP collector
  --file-issues         open, update and close tracker issues for failing steps
  --tag <name>          only journeys carrying this tag (repeatable, or a,b)
  --var <key=value>     seed a value into every run (repeatable)
  --slack               post the result to the configured webhook
  -u, --update-snapshots  record the response shapes as the new baseline
  --strict              fail on drift — contract or shape — not just assertions
  --strict-contract     fail only on a response that stopped matching the spec
  --strict-snapshot     fail only on a response whose shape moved
  --strict-budget       fail only on a step slower than its declared budget
  --mock-webhooks       deliver saved mocks instead of waiting for real callbacks
  --no-history          do not append this run to history/
  --inbox-port <n>      port the webhook inbox listens on (default 5179)
  --include-bodies      keep response bodies for failures in the JSON report
  --quiet               only print the verdict

journey init --ci

  Write .github/workflows/journeys.yml — the suite on every push and nightly.

journey fixtures [--seed]

  Lists the files a step can upload. --seed writes the awkward ones: an empty
  file, one whose extension lies, a truncated image, and a large valid one.

journey sweep [names…] --env <name>

  Deletes what earlier failed runs created and never cleaned up, by running each
  journey's clean-up steps against the values history recorded.

journey compare [names…] --env <a> --with <b>

  Runs each journey against both environments and prints only where they
  disagree: statuses, response shapes, and steps one side is much slower at.
`;

/** Which journeys this invocation runs, with the CLI's own error phrasing. */
function select(available: JourneySummary[], options: Options, root: string): JourneySummary[] {
  const {wanted, error} = selectJourneys(available, {names: options.names, tags: options.tags});
  if (error) {
    throw new Error(
      error === 'No saved journeys yet. Save one from the studio first.'
        ? `No saved journeys in ${path.join(root, 'journeys')}. Save one from the studio first.`
        : error,
    );
  }
  return wanted;
}

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
    send: (request: ResolvedRequest, forEnv: string) => sendRequest(request, forEnv, config, root),
  };

  const available = await listJourneys(root);
  const chosen = select(available, options, root);

  // Setups are pulled in even when the filter did not name them: `--tag smoke`
  // means "run the smoke tests", not "run them without logging in first".
  const needed = new Set(chosen.map((j) => j.file));
  const addSetups = (journey: JourneySummary) => {
    for (const use of journey.uses) {
      const found = available.find(
        (j) => j.name === use || j.file === use || j.file === `${use}.journey.json`,
      );
      if (found && !needed.has(found.file)) {
        needed.add(found.file);
        addSetups(found);
      }
    }
  };
  chosen.forEach(addSetups);

  const {ordered: wanted, problems} = orderBySetup(available.filter((j) => needed.has(j.file)));
  for (const problem of problems) process.stderr.write(`  ! ${problem}\n`);

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
  /** What each setup journey produced, by the name others refer to it as. */
  const setups = new Map<string, SetupResult>();
  const skipped: {name: string; reason: string}[] = [];

  /**
   * One journey, start to finish.
   *
   * Extracted so it can run alone or in a pool, and given its *own* definitions
   * rather than mutating the shared registry. The registry is a singleton, so
   * two journeys running at once would each reset it under the other and end up
   * resolving the wrong node types — a bug that could not happen while
   * everything was sequential and would have been very hard to see once it was.
   */
  const runJourneyFile = async (
    summary: JourneySummary,
    log: (line: string) => void,
  ): Promise<{reports: JourneyReport[]; setup?: SetupResult; skipped?: {name: string; reason: string}}> => {
    const saved = await loadJourney(root, summary.file);
    if (!saved) return {reports: []};

    // What its setups produced. Every setup has already finished: they run in
    // dependency order, and never in parallel with what depends on them.
    const inherited: Record<string, unknown> = {};
    for (const use of saved.journey.uses ?? []) {
      const result = setups.get(use);
      if (!result) continue;
      if (!result.ok) {
        // Skipped, not failed. Twenty red rows for one broken login buries the
        // news, and this journey never touched the API under test.
        const reason = `${use} (${result.error ?? 'setup failed'})`;
        log(`· ${summary.name} — skipped, needs ${reason}`);
        return {reports: [], skipped: {name: summary.name, reason}};
      }
      Object.assign(inherited, result.vars);
    }

    // Definitions travel inside the file, so CI needs no spec and no import.
    const defs = new Map([...BUILTINS, ...saved.defs].map((d) => [d.type, d]));
    const lookupHere = withMaterialised((type: string) => defs.get(type));

    const recorded = await loadSnapshot(root, summary.file, env);
    const journey = override ? {...saved.journey, cases: override.cases} : saved.journey;

    if (journey.cases?.length) log(`${journey.name} — ${journey.cases.length} cases`);

    // A journey whose steps overwrite what the cases supply runs every row
    // against the same value and reports all of them green. That is worth
    // shouting about even in --quiet, because the alternative is a suite that
    // looks like coverage and is not.
    for (const problem of checkJourney(journey, (t) => lookupHere(t))) {
      if (problem.kind !== 'case-overwritten') continue;
      const step = journey.nodes.find((n) => n.id === problem.nodeId);
      process.stderr.write(`  ! "${step?.label ?? problem.nodeId}" ${problem.message}\n`);
    }

    const runs = await runJourneyCases(journey, {
      env,
      lookup: lookupHere,
      transport,
      baseline: recorded?.nodes,
      // Under the case's own values: a row that names `country` should win over
      // a blanket --var, or the flag would silently flatten a data-driven run.
      // Setup output sits under both — it is a default, not an instruction.
      ...(Object.keys(inherited).length || Object.keys(options.vars).length
        ? {seed: {...inherited, ...options.vars}}
        : {}),
      inbox: {
        async claim(match, claimOpts) { return inbox.claim(match, claimOpts); },
        async describeUnmatched(since) { return inbox.describeUnmatched(since); },
      },
      ...(options.mockWebhooks ? {mocks: await loadMocks(root)} : {}),
      strictContract: options.strictContract,
      // Recording and comparing at once would make every run agree with itself.
      strictSnapshot: options.strictSnapshot && !options.updateSnapshots,
      strictBudget: options.strictBudget,
      hooks: options.quiet ? undefined : {onLog: log},
    });

    const mine = runs.map((run) =>
      buildJourneyReport(journey, run.result.states, run.result.context, lookupHere, {
        includeBodies: options.includeBodies,
        caseName: run.case?.name,
      }),
    );

    // If anything uses this journey as a setup, publish what it produced.
    const dependedOn = available.some((j) =>
      j.uses.some((u) => u === summary.name || u === summary.file || `${u}.journey.json` === summary.file),
    );
    let setup: SetupResult | undefined;
    if (dependedOn) {
      const gave = runs[runs.length - 1]?.result.context.vars ?? {};
      const passed = runs.every((r) => r.result.passed);
      setup = {vars: passed ? gave : {}, ok: passed, ...(passed ? {} : {error: 'its own steps failed'})};
      if (passed) {
        const keys = Object.keys(gave);
        log(`↳ ${summary.name} set up ${keys.length ? keys.join(', ') : 'nothing'} for the rest`);
      }
    }

    if (!options.noHistory) {
      const forThis = buildReport(env, mine, {
        startedAt,
        durationMs: Date.now() - started,
        baseUrl: environment.baseUrl,
      });
      await recordHistory(root, summary.file, forThis);

      // The most useful line after a failure is when it started, and history is
      // the only thing that knows.
      for (const trend of trendsFrom(await loadHistory(root, summary.file)).filter(
        (t) => t.failingSince && t.runs > 1,
      )) {
        log(`⌛ ${describeTrend(trend)}`);
      }
    }

    if (options.updateSnapshots) {
      // The first run is the one recorded: with cases, later rows can legitimately
      // return a different shape, and a baseline that is the last row's shape
      // would report drift on every row before it.
      const shapes = shapesFrom(runs[0]?.result.states ?? {});
      if (Object.keys(shapes).length) {
        const file = await saveSnapshot(root, summary.file, shapes, {journey: journey.name, env});
        log(`recorded ${Object.keys(shapes).length} shapes to ${file}`);
      }
    }

    return {reports: mine, setup};
  };

  const publish = (summary: JourneySummary, setup: SetupResult | undefined) => {
    if (!setup) return;
    for (const alias of [summary.name, summary.file, summary.file.replace(/\.journey\.json$/, '')]) {
      setups.set(alias, setup);
    }
  };

  const straight = (line: string) => process.stdout.write(`  ${line}\n`);

  // A journey that others depend on, or that says it owns shared state, runs on
  // its own. Everything else can overlap — but only when asked: journeys that
  // share data collide, and the tool cannot know which do.
  const mustBeAlone = (j: JourneySummary) =>
    j.serial || available.some((other) => other.uses.some((u) => u === j.name || u === j.file || `${u}.journey.json` === j.file));

  const alone = wanted.filter(mustBeAlone);
  const together = options.parallel > 1 ? wanted.filter((j) => !mustBeAlone(j)) : [];
  const sequential = options.parallel > 1 ? alone : wanted;

  for (const summary of sequential) {
    const {reports: mine, setup, skipped: missed} = await runJourneyFile(summary, straight);
    reports.push(...mine);
    publish(summary, setup);
    if (missed) skipped.push(missed);
  }

  if (together.length) {
    if (!options.quiet) {
      process.stdout.write(`\nrunning ${together.length} journeys ${options.parallel} at a time\n`);
    }
    const results = await inPool(together, options.parallel, async (summary) => {
      const sink = buffered(summary.name);
      const outcome = await runJourneyFile(summary, sink.log);
      // Flushed in one piece: interleaved progress from eight journeys is
      // unreadable, and an unattended run is read afterwards anyway.
      if (!options.quiet) process.stdout.write(sink.flush());
      return outcome;
    });

    results.forEach((result, i) => {
      if (!result.ok) {
        process.stderr.write(`  ! ${together[i].name} could not run: ${result.error?.message}\n`);
        skipped.push({name: together[i].name, reason: result.error?.message ?? 'failed to start'});
        return;
      }
      reports.push(...result.value!.reports);
      if (result.value!.skipped) skipped.push(result.value!.skipped);
    });
  }

  const report = buildReport(env, reports, {
    startedAt,
    durationMs: Date.now() - started,
    baseUrl: environment.baseUrl,
  });
  if (skipped.length) report.skipped = skipped;
  return report;
}

/** Run every wanted journey in one environment, keeping the raw states. */
async function runIn(env: string, options: Options, root: string) {
  const config = loadConfig(root);
  if (!config.environments.some((e) => e.name === env)) {
    throw new Error(`No environment called "${env}". Known: ${config.environments.map((e) => e.name).join(', ')}`);
  }
  const transport: Transport = {
    send: (request: ResolvedRequest, forEnv: string) => sendRequest(request, forEnv, config, root),
  };

  const wanted = select(await listJourneys(root), options, root);

  const out: {journey: Journey; states: Record<string, NodeState>; lookup: typeof lookup}[] = [];
  for (const summary of wanted) {
    const saved = await loadJourney(root, summary.file);
    if (!saved) continue;
    resetRegistry();
    register(BUILTINS);
    register(saved.defs);
    const materialised = withMaterialised(lookup);
    const result = await runJourney(saved.journey, {env, lookup: materialised, transport});
    out.push({journey: saved.journey, states: result.states, lookup: materialised});
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

/**
 * Whether any journey about to run waits for a webhook.
 *
 * Checked so the CLI only opens a port when it has to — a test runner that
 * silently starts listening on every invocation is a surprise nobody wants in
 * CI, and the node type is enough to know without resolving definitions.
 */
async function awaitsWebhook(options: Options, root: string): Promise<boolean> {
  for (const summary of await listJourneys(root)) {
    if (options.names.length && !options.names.some((n) => summary.name === n || summary.file === n || summary.file === `${n}.journey.json`)) {
      continue;
    }
    const saved = await loadJourney(root, summary.file);
    if (saved?.journey.nodes.some((node) => node.type === 'control.webhook')) return true;
  }
  return false;
}

/**
 * Delete what earlier runs created and never cleaned up.
 *
 * No new mechanism: a journey already knows how to remove what it makes — that
 * is what its clean-up steps are — and history already remembers what each run
 * left. Sweeping is running the one against the other.
 */
async function sweep(options: Options, root: string): Promise<number> {
  const config = loadConfig(root);
  const env = options.env ?? config.environments[0]?.name ?? '';
  if (!config.environments.some((e) => e.name === env)) {
    throw new Error(`No environment called "${env}". Known: ${config.environments.map((e) => e.name).join(', ')}`);
  }
  const transport: Transport = {
    send: (request: ResolvedRequest, forEnv: string) => sendRequest(request, forEnv, config, root),
  };

  const wanted = select(await listJourneys(root), options, root);
  let cleaned = 0;
  let stuck = 0;

  for (const summary of wanted) {
    const history = await loadHistory(root, summary.file);
    // Only this environment's leftovers: an id created on staging means nothing
    // in production, and deleting by it there would be a very bad surprise.
    const orphans = orphansIn(history).filter((entry) => entry.env === env);
    if (!orphans.length) continue;

    const saved = await loadJourney(root, summary.file);
    if (!saved) continue;

    const teardown = saved.journey.nodes.filter((n) => n.teardown);
    if (!teardown.length) {
      process.stdout.write(
        `  ! ${summary.name} left ${orphans.length} run${orphans.length === 1 ? '' : 's'} behind but has no ` +
          `clean-up steps — nothing to sweep with.\n`,
      );
      stuck += orphans.length;
      continue;
    }

    resetRegistry();
    register(BUILTINS);
    register(saved.defs);

    // Only the clean-up steps, seeded with what that run produced.
    const onlyTeardown = {...saved.journey, nodes: teardown, edges: [], cases: undefined};
    const swept: typeof orphans = [];

    for (const orphan of orphans) {
      const seed = Object.fromEntries((orphan.created ?? []).map((c) => [c.key, c.value]));
      const label = `${summary.name}${orphan.case ? ` › ${orphan.case}` : ''} · ${orphan.at.slice(0, 16).replace('T', ' ')}`;
      const result = await runJourney(onlyTeardown, {
        env,
        lookup: withMaterialised(lookup),
        transport,
        seed,
      });

      // `leaked` is the honest signal here: the clean-up steps ran as teardown,
      // so a failure lands there rather than in `passed`.
      if (result.leaked.length) {
        process.stdout.write(`  ✗ ${label} — still there: ${result.leaked.join(', ')}\n`);
        stuck += 1;
        continue;
      }
      process.stdout.write(
        `  ✓ ${label} — removed ${(orphan.created ?? []).map((c) => `${c.key}=${c.value}`).join(', ')}\n`,
      );
      swept.push(orphan);
      cleaned += 1;
    }

    if (swept.length && history) {
      await saveHistory(root, summary.file, markSwept(history, swept, new Date().toISOString()));
    }
  }

  if (!cleaned && !stuck) {
    process.stdout.write(`Nothing left behind on ${env}.\n`);
    return 0;
  }
  process.stdout.write(`\nSwept ${cleaned} run${cleaned === 1 ? '' : 's'} on ${env}${stuck ? `, ${stuck} still stuck` : ''}.\n`);
  return stuck ? 1 : 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === 'init') {
    const {mkdir} = await import('node:fs/promises');
    const root = process.cwd();
    const dir = path.join(root, '.github', 'workflows');
    const file = path.join(dir, 'journeys.yml');
    if (existsSync(file)) {
      process.stderr.write(`${path.relative(root, file)} already exists — delete it first if you want it rewritten.\n`);
      return 2;
    }
    await mkdir(dir, {recursive: true});
    await writeFile(file, githubWorkflow({env: parseArgs(rest).env}), 'utf8');
    process.stdout.write(
      `wrote ${path.relative(root, file)}\n` +
        `Add your secrets under Settings → Secrets and variables → Actions, then push.\n`,
    );
    return 0;
  }

  if (command !== 'run' && command !== 'compare' && command !== 'sweep' && command !== 'fixtures') {
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  const options = parseArgs(rest);
  const root = process.cwd();

  if (command === 'compare') return compare(options, root);
  if (command === 'sweep') return sweep(options, root);

  if (command === 'fixtures') {
    const {seedEdgeCases, listFixtures} = await import('../server/fixtures');
    if (rest.includes('--seed')) {
      const written = await seedEdgeCases(root);
      process.stdout.write(written.length ? `wrote ${written.join(', ')}\n` : 'already there\n');
    }
    for (const f of await listFixtures(root)) {
      process.stdout.write(`  ${f.name.padEnd(24)} ${String(f.bytes).padStart(9)} bytes  ${f.contentType}\n`);
    }
    return 0;
  }

  // A journey that waits for a callback needs somewhere for it to land. Opened
  // only when one actually waits, and only when the run is not using mocks.
  let listening: {close(cb: () => void): void} | undefined;
  if (!options.mockWebhooks && (await awaitsWebhook(options, root))) {
    const app = express();
    app.use('/api', createInboxRouter(root));
    listening = await new Promise((resolve) => {
      const server = app.listen(options.inboxPort, () => resolve(server));
    });
    if (!options.quiet) {
      process.stdout.write(
        `webhook inbox on http://localhost:${options.inboxPort}/api/hooks/ ` +
          `(use --mock-webhooks to replay saved payloads instead)\n`,
      );
    }
  }

  try {
    return await runAll(options, root);
  } finally {
    if (listening) await new Promise<void>((resolve) => listening!.close(() => resolve()));
  }
}

async function runAll(options: Options, root: string): Promise<number> {

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

  if (options.junit) {
    await writeFile(path.resolve(root, options.junit), toJunitXml(report), 'utf8');
    process.stdout.write(`junit written to ${options.junit}\n`);
  }

  if (options.otlp) {
    const telemetry = loadConfig(root).telemetry;
    if (!telemetry?.endpoint) {
      process.stderr.write('\n--otlp given but no collector configured (telemetry.endpoint or OTEL_EXPORTER_OTLP_ENDPOINT).\n');
      return 2;
    }
    const sent = await sendOtlp(report, {endpoint: telemetry.endpoint, headers: telemetry.headers, serviceName: telemetry.serviceName});
    // Never fatal: a collector being down is not a reason to fail a build.
    process.stdout.write(sent.ok ? 'metrics exported\n' : `could not export metrics: ${sent.error}\n`);
  }

  if (options.fileIssues) {
    const issues = loadConfig(root).issues;
    if (!issues?.repo || !issues.token) {
      process.stderr.write('\n--file-issues given but no tracker configured (issues.repo and issues.token).\n');
      return 2;
    }
    // Trends give the plan its memory: a step failing for the fifth night is one
    // issue with a new comment, not a fifth issue.
    const trends = new Map<string, StepTrend>();
    for (const summary of await listJourneys(root)) {
      for (const trend of trendsFrom(await loadHistory(root, summary.file))) trends.set(trend.id, trend);
    }

    const results = await fileIssues(planFilings(report, trends), issues);
    for (const result of results) {
      if (result.outcome === 'nothing-to-do') continue;
      process.stdout.write(`  ${result.outcome} ${result.url ?? ''}${result.error ? ` — ${result.error}` : ''}\n`);
    }
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
