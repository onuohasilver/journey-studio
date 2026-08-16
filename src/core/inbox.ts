// ---- Waiting for a webhook ----
//
// Plenty of the flows worth testing do not finish when the response arrives.
// You POST a payment, get a 202, and the thing you actually care about turns up
// minutes later as a callback to your server. A tool that can only make outbound
// requests cannot test that at all — it can only sleep and poll and hope.
//
// So the studio runs an inbox. Anything sent to `/api/hooks/<path>` is recorded,
// and a step can block until one arrives that belongs to it.
//
// The design rests on one decision: **a received webhook is just an
// HttpResponse.** Stored that way, every mechanism already in the tool works on
// it unchanged — `{{nodes.n5.body.status}}`, `gives`, assertions, contract
// checking, snapshots. None of them needed a line of webhook-specific code.

import type {HttpResponse} from './types';

export interface ReceivedHook {
  id: string;
  /** ISO timestamp, used to ignore anything older than the run. */
  at: string;
  method: string;
  /** The part after `/api/hooks/`, e.g. `payments`. */
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  /** Node id that took it, so two steps cannot claim the same delivery. */
  claimedBy?: string;
}

export interface HookMatch {
  /** Inbox path to listen on. Blank listens on every path. */
  path?: string;
  /**
   * Where the payload carries the value tying it to this run, e.g.
   * `body.reference`. Without one, any delivery on the path will do — fine for a
   * single run, wrong the moment two run at once.
   */
  correlateOn?: string;
  /** What that field must equal. Resolved from the context before matching. */
  equals?: unknown;
}

/** Read a dotted path out of a received hook. */
export function readHook(hook: ReceivedHook, path: string): unknown {
  const parts = path.split('.');
  let current: unknown =
    parts[0] === 'body' ? hook.body
    : parts[0] === 'headers' ? hook.headers
    : parts[0] === 'query' ? hook.query
    : parts[0] === 'path' ? hook.path
    : undefined;

  for (const part of parts.slice(1)) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Whether a delivery belongs to this step.
 *
 * Comparison is stringified on purpose: a reference that left as the number
 * 1234 routinely comes back as the string "1234", and a correlation check that
 * fails on that teaches people the feature does not work.
 */
export function hookMatches(hook: ReceivedHook, match: HookMatch): boolean {
  if (match.path && hook.path !== match.path) return false;
  if (!match.correlateOn) return true;
  const actual = readHook(hook, match.correlateOn);
  if (actual === undefined) return false;
  return String(actual) === String(match.equals);
}

/** A delivery, in the shape every other part of the tool already understands. */
export function asResponse(hook: ReceivedHook): HttpResponse {
  return {
    status: 200,
    headers: hook.headers,
    body: hook.body,
    durationMs: 0,
  };
}

/**
 * What the engine asks in order to wait. Implemented in-process by the server
 * and over HTTP by the browser, exactly like `Transport`.
 */
export interface InboxSource {
  claim(match: HookMatch, opts: {since: string; by: string}): Promise<ReceivedHook | undefined>;
  /**
   * One line per delivery that arrived but did not match, for the timeout
   * message. The difference between "the provider never called" and "it called
   * with a reference you are not matching on" is most of the debugging.
   */
  describeUnmatched?(since: string): Promise<string[]>;
}

const MAX_HELD = 200;

/**
 * The deliveries received so far.
 *
 * Held rather than streamed, because the race is real and goes the unhelpful
 * way: a fast provider calls the webhook before the journey has reached the step
 * that waits for it. Watching only for new arrivals would fail on exactly the
 * integrations that work best. So a claim scans everything received since the
 * run began, not just what turns up after the asking starts.
 */
export class HookInbox {
  private hooks: ReceivedHook[] = [];
  private seq = 0;

  receive(hook: Omit<ReceivedHook, 'id' | 'at'> & {at?: string}): ReceivedHook {
    const received: ReceivedHook = {
      ...hook,
      id: `hook_${++this.seq}`,
      at: hook.at ?? new Date().toISOString(),
    };
    this.hooks.push(received);
    // An inbox left running for a week should not become the reason the process
    // falls over.
    if (this.hooks.length > MAX_HELD) this.hooks = this.hooks.slice(-MAX_HELD);
    return received;
  }

  list(): ReceivedHook[] {
    return [...this.hooks].reverse();
  }

  /** Take the oldest unclaimed delivery that matches, if there is one. */
  claim(match: HookMatch, opts: {since: string; by: string}): ReceivedHook | undefined {
    const found = this.hooks.find(
      (hook) => !hook.claimedBy && hook.at >= opts.since && hookMatches(hook, match),
    );
    if (found) found.claimedBy = opts.by;
    return found;
  }

  /** Short descriptions of what arrived, for a timeout message. */
  describeUnmatched(since: string): string[] {
    return this.hooks
      .filter((hook) => hook.at >= since && !hook.claimedBy)
      .map((hook) => `${hook.method} /${hook.path} ${JSON.stringify(hook.body).slice(0, 80)}`);
  }

  clear(): void {
    this.hooks = [];
  }

  get size(): number {
    return this.hooks.length;
  }
}

// ---- mocks ----

/**
 * A saved payload that can be delivered on demand.
 *
 * Two jobs. While building a journey, it saves you triggering a real payment to
 * see what the callback looks like. In CI it is the only way the journey can run
 * at all — no third party is going to call a build agent.
 *
 * Note what a mock is *not*: a fallback. A journey that quietly satisfies its
 * webhook from a canned payload whenever the real one fails to arrive is a test
 * that passes while the integration is broken, which is worse than no test. So
 * mock delivery is asked for explicitly, and every step it fulfils is marked as
 * mocked in the report.
 */
export interface HookMock {
  name: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  /** May contain {{templates}}, so a mock can echo back the run's own ids. */
  body: unknown;
  /** Delivered after this long, so a mocked run keeps realistic timing. */
  delayMs?: number;
}

export function mockFileNameFor(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'hook';
  return `${slug}.hook.json`;
}

/** Turn a delivery you actually received into a mock you can replay. */
export function mockFromHook(hook: ReceivedHook, name: string): HookMock {
  return {
    name,
    path: hook.path,
    method: hook.method,
    // Signature and delivery headers describe the original request, not the
    // payload, and replaying them would be misleading at best.
    body: hook.body,
  };
}
