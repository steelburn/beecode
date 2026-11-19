import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionGoal, TodoItem, TodoStatus } from '../shared/protocol';
import { paths } from '../shared/tools';
import { readJsonFile, writeJsonFile } from './logger';

export type { SessionGoal, TodoItem, TodoStatus } from '../shared/protocol';

const TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

function normalizeTodo(item: { content: string; status?: TodoStatus; activeForm?: string }, idx: number): TodoItem {
  const status = TODO_STATUSES.has(item.status ?? '') ? (item.status as TodoStatus) : 'pending';
  const activeForm = typeof item.activeForm === 'string' && item.activeForm.trim()
    ? item.activeForm.trim().slice(0, 120)
    : undefined;
  return {
    id: `t${idx + 1}`,
    content: String(item.content).slice(0, 500),
    status,
    ...(activeForm ? { activeForm } : {}),
  };
}

export type TodoListener = (sessionId: string, todos: TodoItem[]) => void;

/**
 * Per-session to-do list, mirroring the planner the agent keeps while it works.
 *
 * Adds one item at a time, merges, or replaces the whole list — the same
 * semantics as the ADO Code to-do view. Every write notifies listeners so the
 * session snapshot, the renderer panel and the persisted session file all stay in
 * step without the caller having to remember to refresh them.
 */
export class TodoStore {
  private bySession = new Map<string, TodoItem[]>();
  private listeners = new Set<TodoListener>();

  onWrite(listener: TodoListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  read(sessionId: string): TodoItem[] {
    return this.bySession.get(sessionId) ?? [];
  }

  write(
    sessionId: string,
    items: Array<{ content: string; status?: TodoStatus; activeForm?: string }>,
  ): TodoItem[] {
    const next = items
      .filter((i) => i && typeof i.content === 'string' && i.content.trim())
      .map((item, idx) => normalizeTodo(item, idx));
    this.commit(sessionId, next);
    return next;
  }

  /** Replace the list with already-normalized items (restore / RPC). */
  replace(sessionId: string, items: TodoItem[]): TodoItem[] {
    const next = (Array.isArray(items) ? items : [])
      .filter((i) => i && typeof i.content === 'string' && i.content.trim())
      .map((item, idx) => normalizeTodo(item, idx));
    this.commit(sessionId, next);
    return next;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.notify(sessionId, []);
  }

  /** Rehydrate without notifying (used while loading a persisted session). */
  restore(sessionId: string, items: TodoItem[] | undefined): void {
    if (!Array.isArray(items) || !items.length) return;
    this.bySession.set(sessionId, items.map((item, idx) => normalizeTodo(item, idx)));
  }

  private commit(sessionId: string, todos: TodoItem[]): void {
    this.bySession.set(sessionId, todos);
    this.notify(sessionId, todos);
  }

  private notify(sessionId: string, todos: TodoItem[]): void {
    for (const listener of this.listeners) listener(sessionId, todos);
  }
}

export type GoalListener = (sessionId: string, goal?: SessionGoal) => void;

/** The session's stated objective — the head of the goal/to-do feature. */
export class GoalStore {
  private bySession = new Map<string, SessionGoal>();
  private listeners = new Set<GoalListener>();

  onWrite(listener: GoalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  read(sessionId: string): SessionGoal | undefined {
    return this.bySession.get(sessionId);
  }

  set(sessionId: string, text: string): SessionGoal | undefined {
    const trimmed = String(text ?? '').trim().slice(0, 500);
    if (!trimmed) {
      this.clear(sessionId);
      return undefined;
    }
    const previous = this.bySession.get(sessionId);
    const now = new Date().toISOString();
    const goal: SessionGoal = {
      text: trimmed,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.commit(sessionId, goal);
    return goal;
  }

  clear(sessionId: string): void {
    if (!this.bySession.delete(sessionId)) return;
    for (const listener of this.listeners) listener(sessionId, undefined);
  }

  restore(sessionId: string, goal: SessionGoal | undefined): void {
    if (!goal || typeof goal.text !== 'string' || !goal.text.trim()) return;
    this.bySession.set(sessionId, {
      text: goal.text.trim().slice(0, 500),
      createdAt: goal.createdAt ?? new Date().toISOString(),
      updatedAt: goal.updatedAt ?? new Date().toISOString(),
    });
  }

  private commit(sessionId: string, goal: SessionGoal): void {
    this.bySession.set(sessionId, goal);
    for (const listener of this.listeners) listener(sessionId, goal);
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
