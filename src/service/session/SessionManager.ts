import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  AgentMode,
  ApprovalRequest,
  BeeCodeConfig,
  ServiceEvent,
  SessionSnapshot,
  SessionSummary,
} from '../../shared/protocol';
import type { Logger } from '../logger';
import type { GoalStore, TodoStore } from '../stores';
import { AgentLoop, snapshotSession, summarizeSession } from './AgentLoop';
import type { SessionState } from './AgentLoop';
import type { PersistedSession, SessionStore } from './persistence';

export interface SessionManagerDeps {
  loop: AgentLoop;
  config: () => BeeCodeConfig;
  emit: (event: ServiceEvent) => void;
  log: Logger;
  defaultCwd: () => string;
  /** Goal + to-do stores: snapshots and the panel read from them. */
  goals: GoalStore;
  todos: TodoStore;
  /** Disk-backed history. Omitted in tests, which keep sessions in memory only. */
  store?: SessionStore;
}

interface PendingApproval {
  sessionId: string;
  resolve: (decision: 'allow' | 'allow-session' | 'deny') => void;
}

const MAX_SESSIONS = 50;

/**
 * Owns session state, the prompt queue and the approval handshake.
 *
 * Live sessions are kept in memory (bounded), while every completed turn is mirrored
 * to `~/.beecode/sessions/<id>.json` so the history survives a restart. Restored
 * sessions come back read-only-until-used: they hold the transcript and the LLM
 * conversation, so continuing one resumes with full context.
 */
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private approvals = new Map<string, PendingApproval>();
  private queue = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionManagerDeps) {}

  /** Snapshot enriched with the goal/to-do state owned by the stores. */
  private snap(session: SessionState): SessionSnapshot {
    return {
      ...snapshotSession(session),
      goal: this.deps.goals.read(session.id),
      todos: this.deps.todos.read(session.id),
    };
  }

  /**
   * Mirror a session to disk. Debounced: a streaming turn would otherwise write on
   * nearly every token. Subagent (nested) sessions are deliberately not persisted —
   * only the parent turn that spawned them is interesting history.
   */
  private persist(session: SessionState, immediate = false): void {
    const store = this.deps.store;
    if (!store || session.depth > 0) return;
    const record: PersistedSession = {
      ...this.snap(session),
      schemaVersion: 1,
      messages: session.messages,
      workspace: session.cwd,
    };
    if (immediate) void store.save(record);
    else store.saveSoon(record);
  }

  /** Rebuild in-memory state from a persisted record. */
  private stateFrom(record: PersistedSession): SessionState {
    return {
      id: record.id,
      title: record.title,
      cwd: record.cwd || this.deps.defaultCwd(),
      mode: record.mode,
      model: record.model,
      status: 'idle',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      entries: Array.isArray(record.entries) ? record.entries : [],
      messages: Array.isArray(record.messages) ? record.messages : [],
      usage: record.usage ?? { inputTokens: 0, outputTokens: 0 },
      parentSessionId: record.parentSessionId,
      depth: 0,
      autoApprovedTools: new Set(),
      busy: false,
      restored: true,
    };
  }

  /**
   * Rehydrate the newest transcripts from disk on startup. Their goal and to-do
   * state is restored into the stores so reopening a session shows the same plan.
   */
  async restore(limit = 30): Promise<number> {
    const store = this.deps.store;
    if (!store) return 0;
    const records = await store.list();
    let restored = 0;
    for (const record of records.slice(0, limit)) {
      if (this.sessions.has(record.id) || record.parentSessionId) continue;
      this.sessions.set(record.id, this.stateFrom(record));
      this.deps.goals.restore(record.id, record.goal);
      this.deps.todos.restore(record.id, record.todos);
      restored += 1;
    }
    return restored;
  }

  /** Flush queued writes (shutdown path). */
  async flush(): Promise<void> {
    await this.deps.store?.flush();
  }

  /**
   * Open one transcript, loading it from disk when it is not in memory — a history entry
   * the user clicked after the startup restore window. Unknown ids still throw.
   */
  async open(id: string): Promise<SessionSnapshot> {
    if (!this.sessions.has(id)) {
      const record = await this.deps.store?.load(id);
      if (record && !record.parentSessionId) {
        this.sessions.set(record.id, this.stateFrom(record));
        this.deps.goals.restore(record.id, record.goal);
        this.deps.todos.restore(record.id, record.todos);
      }
    }
    return this.snapshot(id);
  }

  /** Write one session now: the goal/to-do stores changed it under the session. */
  persistNow(id: string): void {
    const session = this.sessions.get(id);
    if (session) this.persist(session, true);
  }

  /* ------------------------------------------------------------------ CRUD */

  create(opts: { title?: string; cwd?: string; mode?: AgentMode; model?: string; parentSessionId?: string; depth?: number } = {}): SessionState {
    const config = this.deps.config();
    const now = new Date().toISOString();
    const session: SessionState = {
      id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      title: opts.title?.trim() || 'New session',
      cwd: opts.cwd || this.deps.defaultCwd(),
      mode: opts.mode ?? config.agent.defaultMode,
      model: opts.model ?? config.defaultModelId,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      entries: [],
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      parentSessionId: opts.parentSessionId,
      depth: opts.depth ?? 0,
      autoApprovedTools: new Set(),
      busy: false,
    };
    this.sessions.set(session.id, session);
    this.evictOldSessions();
    this.deps.emit({ type: 'session.snapshot', payload: this.snap(session) });
    this.persist(session, true);
    return session;
  }

  get(id: string): SessionState {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown session "${id}"`);
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => ({ ...summarizeSession(session), goal: this.deps.goals.read(session.id) }));
  }

  /**
   * Live sessions plus everything found on disk, newest first. Persisted entries
   * missing from memory are the sessions of a previous run.
   */
  async history(workspace?: string): Promise<SessionSummary[]> {
    const live = this.list();
    const store = this.deps.store;
    if (!store) return live;
    const seen = new Set(live.map((session) => session.id));
    const persisted = (await store.summaries(workspace)).filter((session) => !seen.has(session.id));
    return [...live, ...persisted];
  }

  delete(id: string): void {
    const session = this.sessions.get(id);
    if (session?.abort) session.abort.abort();
    this.sessions.delete(id);
    this.queue.delete(id);
    this.deps.goals.clear(id);
    this.deps.todos.clear(id);
    void this.deps.store?.delete(id);
  }

  snapshot(id: string): SessionSnapshot {
    return this.snap(this.get(id));
  }

  setMode(id: string, mode: AgentMode): SessionSummary {
    const session = this.get(id);
    session.mode = mode;
    session.updatedAt = new Date().toISOString();
    this.deps.emit({ type: 'session.status', payload: { sessionId: id, status: session.status } });
    this.persist(session);
    return summarizeSession(session);
  }

  /** Move a session to another working directory; the folder must exist. */
  async setCwd(id: string, cwd: string): Promise<SessionSummary> {
    const session = this.get(id);
    const abs = resolve(cwd.trim());
    const info = await stat(abs).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`working directory is not an existing folder: ${abs}`);
    if (session.cwd === abs) return summarizeSession(session);
    session.cwd = abs;
    session.updatedAt = new Date().toISOString();
    this.deps.emit({ type: 'session.snapshot', payload: this.snap(session) });
    this.persist(session, true);
    return summarizeSession(session);
  }

  setModel(id: string, model: string): SessionSummary {
    const session = this.get(id);
    session.model = model;
    session.updatedAt = new Date().toISOString();
    this.persist(session);
    return summarizeSession(session);
  }

  count(): number {
    return this.sessions.size;
  }

  /* ---------------------------------------------------------------- prompts */

  /** Queue a prompt; a session runs one turn at a time. */
  prompt(id: string, text: string): { accepted: boolean } {
    const session = this.get(id);
    if (!text.trim()) throw new Error('prompt is empty');
    if (session.entries.length === 0) {
      session.title = text.trim().slice(0, 60).replace(/\s+/g, ' ');
    }
    const previous = this.queue.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.deps.loop.run(session, text))
      .catch((err) => {
        this.deps.log.error('session run failed', { sessionId: id, message: (err as Error).message });
      })
      .finally(() => {
        if (this.queue.get(id) === next) this.queue.delete(id);
        this.persist(session);
        this.deps.emit({ type: 'session.snapshot', payload: this.snap(session) });
      });
    this.queue.set(id, next);
    return { accepted: true };
  }

  abort(id: string): boolean {
    const session = this.get(id);
    if (!session.abort) return false;
    session.abort.abort();
    // Release any approval wait so the loop can unwind.
    for (const [approvalId, pending] of this.approvals) {
      if (pending.sessionId === id) {
        pending.resolve('deny');
        this.approvals.delete(approvalId);
      }
    }
    session.pendingApproval = undefined;
    return true;
  }

  async waitForIdle(id: string): Promise<void> {
    await (this.queue.get(id) ?? Promise.resolve());
  }

  /* --------------------------------------------------------------- approvals */

  /** Called by the agent loop; resolves when the user answers in the UI. */
  requestApproval(
    session: SessionState,
    request: Omit<ApprovalRequest, 'id' | 'sessionId' | 'requestedAt'>,
  ): Promise<'allow' | 'allow-session' | 'deny'> {
    const approvalId = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const full: ApprovalRequest = {
      ...request,
      id: approvalId,
      sessionId: session.id,
      requestedAt: new Date().toISOString(),
      options: ['allow', 'allow-session', 'deny'],
    };
    session.pendingApproval = full;
    session.updatedAt = full.requestedAt;
    this.deps.emit({ type: 'approval.request', payload: full });

    return new Promise((resolve) => {
      this.approvals.set(approvalId, {
        sessionId: session.id,
        resolve: (decision) => {
          session.pendingApproval = undefined;
          this.deps.emit({
            type: 'approval.resolved',
            payload: { sessionId: session.id, approvalId, decision },
          });
          resolve(decision);
        },
      });
    });
  }

  resolveApproval(approvalId: string, decision: 'allow' | 'allow-session' | 'deny'): boolean {
    const pending = this.approvals.get(approvalId);
    if (!pending) return false;
    this.approvals.delete(approvalId);
    pending.resolve(decision);
    return true;
  }

  /* -------------------------------------------------------------- subagents */

  /**
   * Runs a nested session for an internal subagent and returns its final answer.
   * The child session is kept (read-only tools, depth+1) so the UI can inspect it.
   */
  async runNested(task: string, opts: { parentSessionId: string; cwd: string; depth: number }): Promise<{ output: string; sessionId: string }> {
    const parent = this.sessions.get(opts.parentSessionId);
    const child = this.create({
      title: `↳ ${task.slice(0, 48)}`,
      cwd: opts.cwd,
      mode: parent?.mode === 'autonomous' ? 'autonomous' : parent?.mode ?? 'act',
      model: parent?.model,
      parentSessionId: opts.parentSessionId,
      depth: opts.depth,
    });
    await this.deps.loop.run(child, task);
    const finalText = [...child.entries]
      .reverse()
      .find((e) => e.role === 'assistant' && e.text.trim().length > 0);
    const errors = child.entries.filter((e) => e.role === 'system').map((e) => e.text);
    return {
      sessionId: child.id,
      output: finalText?.text ?? errors[errors.length - 1] ?? '(subagent produced no output)',
    };
  }

  private evictOldSessions(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const idle = [...this.sessions.values()]
      .filter((s) => !s.busy && s.depth === 0)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    while (this.sessions.size > MAX_SESSIONS && idle.length) {
      const victim = idle.shift();
      if (victim) this.sessions.delete(victim.id);
    }
  }
}
