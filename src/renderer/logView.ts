/**
 * Log-file viewing: which level a line belongs to, how the level filter and the search
 * narrow the file, and where a query matches inside a line.
 *
 * The rules are pure so they are unit tested in node, where no DOM exists — the renderer
 * turns `LogView.lines` and the match ranges into elements. Colour comes from
 * `level`, never from the log's own escape sequences: a `.log` copied off a server is
 * full of ANSI codes too, and this view does not trust them.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'other';

/** Levels in the order the toolbar lists them, most severe first. */
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace', 'other'];

/**
 * Level detection, most severe first: a line that mentions both an error and an info
 * level is an error line. Bracketed levels (`[WARN]`, `(error)`) and level words
 * (`fatal:`) both count, which covers log4j, winston, Python logging and plain syslog.
 */
const LEVEL_PATTERNS: ReadonlyArray<{ level: LogLevel; pattern: RegExp }> = [
  {
    level: 'error',
    pattern: /(\b(error|err|fatal|critical|crit|panic|severe|exception|failed|failure|failing|unhandled)\b|\[(error|err|fatal|critical)\])/i,
  },
  { level: 'warn', pattern: /(\b(warn|warning|deprecated)\b|\[(warn|warning)\])/i },
  { level: 'info', pattern: /(\b(info|information|notice|success|started|listening|ready)\b|\[info\])/i },
  { level: 'debug', pattern: /(\b(debug|dbg|verbose|diagnostic)\b|\[debug\])/i },
  { level: 'trace', pattern: /(\b(trace|silly)\b|\[trace\])/i },
];

/** Leading timestamp of a line, if it has one. */
const TIMESTAMP =
  /^(\[\d{4}-\d{2}-\d{2}[^\]]*\]|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/;

/** The level a line belongs to. */
export function classifyLogLine(line: string): LogLevel {
  for (const entry of LEVEL_PATTERNS) if (entry.pattern.test(line)) return entry.level;
  return 'other';
}

/** Lines of a log, without the empty tail a trailing newline leaves behind. */
export function splitLogLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  return lines;
}

/** How many lines each level has. */
export function countLogLevels(lines: readonly string[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0, trace: 0, other: 0 };
  for (const line of lines) counts[classifyLogLine(line)] += 1;
  return counts;
}

/** Split a leading timestamp off a line so it can be shown muted. */
export function splitLogPrefix(line: string): { prefix: string; rest: string } {
  const match = TIMESTAMP.exec(line);
  return match ? { prefix: match[1], rest: line.slice(match[1].length) } : { prefix: '', rest: line };
}

/** Where a search query matches in a line, case-insensitively, non-overlapping. */
export function highlightRanges(text: string, query: string): Array<{ start: number; end: number }> {
  const needle = query.trim();
  if (!needle) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  const haystack = text.toLowerCase();
  const lower = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(lower, from);
    if (at < 0) break;
    ranges.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return ranges;
}

export interface LogFilter {
  /** Levels to keep; omitted means every level. */
  levels?: readonly LogLevel[];
  /** Case-insensitive substring to keep and highlight. */
  query?: string;
}

export interface LogEntry {
  /** 1-based line number in the file. */
  number: number;
  level: LogLevel;
  text: string;
  /** Number of query matches in this line. */
  hits: number;
}

export interface LogResult {
  entries: LogEntry[];
  /** Lines in the file. */
  total: number;
  /** Lines the filter keeps. */
  shown: number;
  /** Query matches among the kept lines. */
  hits: number;
}

/** Apply the level filter and the search to a log. */
export function filterLogLines(lines: readonly string[], filter: LogFilter = {}): LogResult {
  const allowed = filter.levels ? new Set(filter.levels) : undefined;
  const query = (filter.query ?? '').trim();
  const entries: LogEntry[] = [];
  let hits = 0;
  lines.forEach((text, index) => {
    const level = classifyLogLine(text);
    if (allowed && !allowed.has(level)) return;
    const matches = query ? highlightRanges(text, query).length : 0;
    if (query && matches === 0) return;
    hits += matches;
    entries.push({ number: index + 1, level, text, hits: matches });
  });
  return { entries, total: lines.length, shown: entries.length, hits };
}
