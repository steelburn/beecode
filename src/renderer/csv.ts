/**
 * CSV/TSV parsing for the table view.
 *
 * RFC 4180 quoting, a delimiter sniffed from the first lines (a European export uses
 * semicolons, a tab-separated dump uses tabs), and a row cap so a hundred-megabyte export
 * cannot freeze the pane. Pure string work, so the parser is unit tested in node.
 */

/** Most data rows the table view renders; the rest is announced, not parsed into the DOM. */
export const MAX_CSV_ROWS = 2000;

/** Lines the delimiter sniff looks at. */
const SNIFF_LINES = 20;

export interface CsvTable {
  /** The delimiter that split the file. */
  delimiter: string;
  /** First record, rendered as the table header. */
  header: string[];
  /** Data records, padded to `columns`. */
  rows: string[][];
  /** Widest record, so short rows still line up with the header. */
  columns: number;
  /** True when records were dropped at the row cap. */
  truncated: boolean;
}

/** Human name of a delimiter, for the toolbar. */
export function delimiterName(delimiter: string): string {
  if (delimiter === '\t') return 'tab';
  if (delimiter === ';') return 'semicolon';
  if (delimiter === '|') return 'pipe';
  return 'comma';
}

const DELIMITERS = [',', ';', '\t', '|'];

/** Count a delimiter on one line, ignoring anything inside quotes. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) count += 1;
  }
  return count;
}

/**
 * The delimiter that splits the first lines most consistently.
 *
 * Consistency beats volume: prose full of commas must not make a semicolon-separated file
 * look comma-separated, so a delimiter that appears the same number of times on every line
 * scores double.
 */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/, SNIFF_LINES).filter((line) => line.trim().length > 0);
  let best = ',';
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total === 0) continue;
    const first = counts.find((count) => count > 0) ?? 0;
    const consistent = counts.every((count) => count === 0 || count === first);
    const score = total * (consistent ? 2 : 1);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/** Split one delimited file into header + rows. */
export function parseCsv(input: string, maxRows = MAX_CSV_ROWS): CsvTable {
  const text = input.replace(/^\uFEFF/, '');
  const delimiter = sniffDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;

  const finishRecord = (): boolean => {
    record.push(field);
    field = '';
    if (records.length > maxRows) {
      truncated = true;
      record = [];
      return false;
    }
    records.push(record);
    record = [];
    return true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = '';
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      if (!finishRecord()) break;
      continue;
    }
    field += char;
  }
  if (!truncated && (field.length > 0 || record.length > 0)) finishRecord();

  const header = records[0] ?? [];
  const rows = records.slice(1);
  const columns = records.reduce((max, cells) => Math.max(max, cells.length), 0);
  return {
    delimiter,
    header: padRow(header, columns),
    rows: rows.map((cells) => padRow(cells, columns)),
    columns,
    truncated,
  };
}

function padRow(cells: string[], columns: number): string[] {
  if (cells.length >= columns) return cells;
  return [...cells, ...Array.from({ length: columns - cells.length }, () => '')];
}

/** True for a cell the table can right-align: a bare number, optional sign and decimals. */
export function isNumericCell(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[-+]?[\d.,]*\d(?:[eE][-+]?\d+)?$/.test(trimmed) && /\d/.test(trimmed);
}
