// ---- Turning a spreadsheet into test cases ----
//
// The inputs a QA team wants to run a journey against almost always already
// exist, in a spreadsheet: twenty rows of user, amount, country, expected
// outcome. Asking someone to retype that into a form is how a data-driven suite
// ends up with three cases in it.
//
// So: paste the CSV. Header row names the variables, every other row is a case.

export interface ParsedCase {
  name: string;
  vars: Record<string, unknown>;
}

export interface CsvResult {
  cases: ParsedCase[];
  columns: string[];
  warnings: string[];
}

/** Column names that mean "this is what to call the row", not a variable. */
const NAME_COLUMNS = ['name', 'case', 'scenario'];

/**
 * Split CSV text into rows of fields.
 *
 * Written out rather than pulled in because the only hard parts are quoted
 * fields containing commas or newlines and the doubled-quote escape, and a
 * dependency for that is not worth the supply chain.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = () => {
    endField();
    // A trailing newline should not produce a row of one empty field.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && !started) {
      quoted = true;
      started = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r') {
      // handled by the \n that follows
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
      started = true;
    }
  }

  if (field !== '' || row.length) endRow();
  return rows;
}

/**
 * Give a cell its type back, but only when it is unambiguous.
 *
 * `{{vars.amount}}` alone in a JSON body keeps whatever type the variable has,
 * so a column of amounts should arrive as numbers rather than strings. The
 * round-trip check is what protects the cases where that would be wrong: `007`,
 * `+2348012345678` and `1.50` are account numbers, phone numbers and prices that
 * must survive as typed, and each of them fails to round-trip.
 */
export function coerce(raw: string): unknown {
  const value = raw.trim();
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && String(asNumber) === value) return asNumber;
  return raw;
}

/** Header row names the variables; every row after it is one case. */
export function casesFromCsv(text: string): CsvResult {
  const rows = parseCsv(text);
  const warnings: string[] = [];

  if (rows.length < 2) {
    return {
      cases: [],
      columns: rows[0]?.map((h) => h.trim()) ?? [],
      warnings: rows.length ? ['Only a header row — add a row per case.'] : ['Nothing to read.'],
    };
  }

  const header = rows[0].map((h) => h.trim());
  const nameAt = header.findIndex((h) => NAME_COLUMNS.includes(h.toLowerCase()));
  const columns = header.filter((_, i) => i !== nameAt && header[i] !== '');

  const seen = new Set<string>();
  const cases: ParsedCase[] = [];

  rows.slice(1).forEach((row, index) => {
    if (row.every((cell) => cell.trim() === '')) return;

    const vars: Record<string, unknown> = {};
    header.forEach((column, i) => {
      if (i === nameAt || column === '') return;
      vars[column] = coerce(row[i] ?? '');
    });

    let name = (nameAt >= 0 ? row[nameAt] : '')?.trim() || `row ${index + 1}`;
    // Duplicate names make a report ambiguous about which row failed.
    if (seen.has(name)) {
      warnings.push(`More than one case called "${name}" — numbered to keep them apart.`);
      let n = 2;
      while (seen.has(`${name} (${n})`)) n++;
      name = `${name} (${n})`;
    }
    seen.add(name);

    if (row.length !== header.length) {
      warnings.push(`Row ${index + 1} has ${row.length} cells for ${header.length} columns.`);
    }

    cases.push({name, vars});
  });

  return {cases, columns, warnings};
}

/** The other direction, so a table on screen can be copied back to a sheet. */
export function casesToCsv(cases: ParsedCase[]): string {
  const columns = [...new Set(cases.flatMap((c) => Object.keys(c.vars)))];
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    ['name', ...columns].join(','),
    ...cases.map((c) => [cell(c.name), ...columns.map((col) => cell(c.vars[col]))].join(',')),
  ].join('\n');
}
