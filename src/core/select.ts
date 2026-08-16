// ---- Choosing what to run ----
//
// One journey is easy. Fifty is where a suite either gets used or gets skipped,
// and the difference is usually whether a pull request can run the six that
// matter instead of all fifty.

export interface Selectable {
  name: string;
  file: string;
  tags: string[];
}

export interface Selection<T> {
  wanted: T[];
  /** Why nothing matched, phrased so it can be printed as-is. */
  error?: string;
}

/**
 * Narrow a list of journeys by name and by tag.
 *
 * Both filters narrow rather than widen: `--tag smoke checkout` means "the
 * checkout journey, if it is a smoke test". The union reading — "smoke tests
 * plus checkout" — is what someone eventually wants, but it is not what anyone
 * expects from the same command, and a selector that surprises you is a selector
 * you stop trusting to be exhaustive.
 */
export function selectJourneys<T extends Selectable>(
  available: T[],
  filters: {names?: string[]; tags?: string[]},
): Selection<T> {
  const names = filters.names ?? [];
  const tags = filters.tags ?? [];

  let wanted = available;
  if (names.length) {
    wanted = wanted.filter((j) =>
      names.some((n) => j.name === n || j.file === n || j.file === `${n}.journey.json`),
    );
  }
  if (tags.length) {
    wanted = wanted.filter((j) => tags.some((tag) => j.tags.includes(tag)));
  }
  if (wanted.length) return {wanted};

  // The useful failure names what *is* available, because the mistake is nearly
  // always a typo or a tag nobody applied yet.
  if (tags.length) {
    const known = [...new Set(available.flatMap((j) => j.tags))];
    return {
      wanted: [],
      error:
        `No journey is tagged ${tags.join(' or ')}.` +
        (known.length ? ` Tags in use: ${known.join(', ')}.` : ' No journey carries any tag yet.'),
    };
  }
  if (names.length) {
    return {
      wanted: [],
      error:
        `No saved journey matched: ${names.join(', ')}.` +
        (available.length ? ` Available: ${available.map((j) => j.name).join(', ')}.` : ''),
    };
  }
  return {wanted: [], error: 'No saved journeys yet. Save one from the studio first.'};
}
