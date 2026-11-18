import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEntry } from '../shared/protocol';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Append-only JSONL audit trail. Every desktop action, shell command, file write,
 * policy denial and subagent spawn lands here — this is the "what did the agent do"
 * record that survives a crash and is independent of the chat transcript.
 */
export class AuditLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  record(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const full: AuditEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...entry,
    };
    this.queue = this.queue
      .then(() => this.append(full))
      .catch(() => undefined);
    return full;
  }

  private async append(entry: AuditEntry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await this.rotateIfNeeded();
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.file);
      if (info.size > MAX_BYTES) {
        await rename(this.file, `${this.file}.1`);
      }
    } catch {
      /* file does not exist yet */
    }
  }

  /** Most recent entries, newest last. */
  async recent(limit = 200): Promise<AuditEntry[]> {
    await this.queue;
    const lines = await this.readLines();
    const out: AuditEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  private async readLines(): Promise<string[]> {
    const files = [`${this.file}.1`, this.file];
    const lines: string[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(file, 'utf8');
        lines.push(...raw.split(/\r?\n/).filter(Boolean));
      } catch {
        /* missing file is fine */
      }
    }
    return lines;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
