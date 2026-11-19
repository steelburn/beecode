import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionSnapshot, SessionSummary } from '../../shared/protocol';
import { paths } from '../../shared/tools';
import type { LlmMessage } from '../llm/types';
import type { Logger } from '../logger';

/** Bump when the on-disk shape changes; older files are then ignored, not migrated. */
const SCHEMA_VERSION = 1;

/** A session as written to `<home>/sessions/<id>.json`. */
export interface PersistedSession extends SessionSnapshot {
  schemaVersion: number;
  /** Conversation carried over so a resumed session keeps its context. */
  messages?: LlmMessage[];
  /** Workspace root the session belongs to (used to filter the history). */
  workspace?: string;
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'session';
}

/**
 * Disk-backed session history.
 *
 * One JSON document per session under `~/.beecode/sessions`, written atomically
 * (temp file + rename) and debounced, so a long streaming turn does not hammer
 * the disk. A corrupt or half-written file is skipped rather than fatal: losing
 * one transcript must never stop the app from starting.
 */
export class SessionStore {
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, PersistedSession>();
  private writes = new Map<string, Promise<void>>();
  /**
   * Parsed index of the directory. The session rail asks for this on every snapshot
   * event, so re-reading every transcript each time would be both slow and pointless:
   * a write drops the cache and the next caller rebuilds it.
   */
  private index?: PersistedSession[];

  constructor(
    private log: Logger,
    private dir: string = paths().sessions,
  ) {}

  private file(id: string): string {
    return join(this.dir, `${safeId(id)}.json`);
  }

  /** Write immediately. Failures are logged, never thrown at the caller. */
  async save(record: PersistedSession): Promise<void> {
    const path = this.file(record.id);
    const body = JSON.stringify({ ...record, schemaVersion: SCHEMA_VERSION });
    const work = (async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, body, 'utf8');
        await rename(tmp, path);
        this.index = undefined;
      } catch (error) {
        this.log.warn(`session.persist: ${record.id}: ${(error as Error).message}`);
      }
    })();
    this.writes.set(record.id, work);
    await work;
  }

  /** Coalesce bursts (streaming tokens, tool calls) into one write. */
  saveSoon(record: PersistedSession, delayMs = 400): void {
    this.pending.set(record.id, record);
    const existing = this.timers.get(record.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(record.id);
      const latest = this.pending.get(record.id);
      if (!latest) return;
      this.pending.delete(record.id);
      void this.save(latest);
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(record.id, timer);
  }

  /** Flush everything queued (shutdown path). */
  async flush(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const queued = [...this.pending.values()];
    this.pending.clear();
    await Promise.all([...queued.map((record) => this.save(record)), ...this.writes.values()]);
  }

  async load(id: string): Promise<PersistedSession | undefined> {
    try {
      const raw = await readFile(this.file(id), 'utf8');
      const parsed = JSON.parse(raw) as PersistedSession;
      if (!parsed || typeof parsed.id !== 'string' || parsed.schemaVersion !== SCHEMA_VERSION) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** Newest first. Corrupt files are ignored; the result is cached until the next write. */
  async list(): Promise<PersistedSession[]> {
    if (this.index) return this.index;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: PersistedSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const record = await this.load(id);
      if (record) records.push(record);
    }
    records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    this.index = records;
    return records;
  }

  /** Summaries only — cheaper than `list()` for the sidebar. */
  async summaries(workspace?: string): Promise<SessionSummary[]> {
    const records = await this.list();
    const scoped = workspace
      ? records.filter((record) => !record.workspace || record.workspace === workspace)
      : records;
    return scoped.map(({ entries, messages, todos, ...rest }) => {
      void entries;
      void messages;
      void todos;
      return rest as unknown as SessionSummary;
    });
  }

  async delete(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.pending.delete(id);
    this.index = undefined;
    try {
      await rm(this.file(id), { force: true });
    } catch (error) {
      this.log.warn(`session.delete: ${id}: ${(error as Error).message}`);
    }
  }

  /** Keep the newest `keep` transcripts, never touching `protect`ed ids. */
  async prune(keep = 200, protect: Iterable<string> = []): Promise<void> {
    const keepIds = new Set(protect);
    const records = await this.list();
    const stale = records.filter((record) => !keepIds.has(record.id)).slice(keep);
    for (const record of stale) await this.delete(record.id);
  }
}
