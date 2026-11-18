import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../shared/tools';
import { readJsonFile, writeJsonFile } from './logger';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** Per-session to-do list, mirroring the planner the agent keeps while it works. */
export class TodoStore {
  private bySession = new Map<string, TodoItem[]>();

  read(sessionId: string): TodoItem[] {
    return this.bySession.get(sessionId) ?? [];
  }

  write(
    sessionId: string,
    items: Array<{ content: string; status?: TodoStatus }>,
  ): TodoItem[] {
    const next = items
      .filter((i) => i && typeof i.content === 'string' && i.content.trim())
      .map((i, idx) => ({
        id: `t${idx + 1}`,
        content: String(i.content).slice(0, 500),
        status: (i.status ?? 'pending') as TodoStatus,
      }));
    this.bySession.set(sessionId, next);
    return next;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/** Durable per-workspace notes the agent can write and read back across sessions. */
export class MemoryStore {
  private cache = new Map<string, Record<string, string>>();

  private fileFor(workspace: string): string {
    const slug = createHash('sha1').update(workspace.toLowerCase()).digest('hex').slice(0, 12);
    return join(paths().home, 'memory', `${slug}.json`);
  }

  async read(workspace: string): Promise<Record<string, string>> {
    const cached = this.cache.get(workspace);
    if (cached) return cached;
    const loaded = await readJsonFile<Record<string, string>>(this.fileFor(workspace), {});
    this.cache.set(workspace, loaded);
    return loaded;
  }

  async get(workspace: string, key: string): Promise<string | undefined> {
    return (await this.read(workspace))[key];
  }

  async set(workspace: string, key: string, value: string): Promise<void> {
    const current = { ...(await this.read(workspace)) };
    current[key] = value.slice(0, 4000);
    this.cache.set(workspace, current);
    await writeJsonFile(this.fileFor(workspace), current);
  }

  /** Compact rendering for the system prompt. */
  async describe(workspace: string, maxChars = 2000): Promise<string> {
    const entries = Object.entries(await this.read(workspace));
    if (!entries.length) return '';
    const text = entries.map(([k, v]) => `- ${k}: ${v}`).join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  async loadFile(file: string): Promise<void> {
    void file;
    await readFile(join(paths().home, 'memory', '.keep'), 'utf8').catch(() => undefined);
  }
}
