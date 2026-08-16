// ---- Running several things at once, in a fixed order ----
//
// Two properties matter more than the concurrency itself.
//
// Results come back in the order the items went in, never the order they
// happened to finish. A report whose rows shuffle between runs is a report you
// cannot diff, and a suite you cannot diff is one where nobody notices a new
// failure among the reordering.
//
// And a worker that throws does not take the pool down with it. One journey
// failing to load is not a reason for the other nineteen to be abandoned.

export interface PoolResult<R> {
  ok: boolean;
  value?: R;
  error?: Error;
}

export async function inPool<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<PoolResult<R>[]> {
  const results: PoolResult<R>[] = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = {ok: true, value: await run(items[index], index)};
      } catch (err) {
        results[index] = {ok: false, error: err instanceof Error ? err : new Error(String(err))};
      }
    }
  };

  await Promise.all(Array.from({length: width}, worker));
  return results;
}

/**
 * Collects a journey's output so it can be printed in one piece.
 *
 * Interleaved progress from eight journeys is unreadable — every line has to
 * carry its own context, and the eye has to reassemble what happened. Buffering
 * and flushing per journey trades liveness for a log somebody can actually read,
 * which for an unattended run is the right way round.
 */
export function buffered(prefix: string): {log(line: string): void; flush(): string} {
  const lines: string[] = [];
  return {
    log: (line) => lines.push(line),
    flush: () => (lines.length ? `${prefix}\n${lines.map((l) => `  ${l}`).join('\n')}\n` : ''),
  };
}
