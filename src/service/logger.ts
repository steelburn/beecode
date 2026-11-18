import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

/**
 * Appends JSONL log lines to a file and mirrors them to a sink (the RPC event stream),
 * so the UI can show service logs without screen-scraping stdout. Never throws: logging
 * must not be able to take the service down.
 */
export function createLogger(
  file: string | undefined,
  sink?: (level: LogLevel, message: string) => void,
  minLevel: LogLevel = (process.env.BEECODE_LOG_LEVEL as LogLevel) ?? 'info',
): Logger {
  const threshold = LEVEL_WEIGHT[minLevel] ?? LEVEL_WEIGHT.info;

  function emit(level: LogLevel, message: string, extra?: unknown) {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${extra === undefined ? '' : ` ${safeJson(extra)}`}\n`;
    // stdout is the stdio RPC channel when transport=stdio — never write logs there.
    if (level === 'error') process.stderr.write(line);
    else if (process.env.BEECODE_LOG_STDOUT === '1') process.stdout.write(line);
    if (file) {
      void mkdir(dirname(file), { recursive: true })
        .then(() => appendFile(file, line, 'utf8'))
        .catch(() => undefined);
    }
    try {
      sink?.(level, message);
    } catch {
      /* sink failures are non-fatal */
    }
  }

  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Read a JSON file, returning `fallback` when it is missing or corrupt. */
export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
