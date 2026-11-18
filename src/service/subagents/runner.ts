import type { AgentInfo, SubagentConfig, SubagentRunInfo } from '../../shared/protocol';
import type { AuditLog } from '../audit';
import type { Logger } from '../logger';
import { CliAgentAdapter } from './adapters';

export interface SubagentRequest {
  parentSessionId: string;
  agent: string;
  task: string;
  cwd: string;
  depth: number;
  signal?: AbortSignal;
}

export interface SubagentResult {
  runId: string;
  agent: string;
  status: SubagentRunInfo['status'];
  output: string;
  error?: string;
}

/** Injected by the service so the runner never imports the agent loop (no cycle). */
export type InternalRunner = (
  task: string,
  ctx: { parentSessionId: string; cwd: string; depth: number; signal?: AbortSignal },
) => Promise<{ output: string; sessionId: string }>;

export interface SubagentRunnerDeps {
  config: () => SubagentConfig;
  audit: AuditLog;
  log: Logger;
  onUpdate: (run: SubagentRunInfo) => void;
}

const MAX_OUTPUT_CHARS = 20_000;
const INTERNAL_AGENT_ID = 'internal';

/**
 * Subagent delegation.
 *
 * Two kinds of agent behind one tool:
 *  - `internal`: a nested beeCode session with a read-only toolset that runs the same
 *    agent loop (used for parallel research / verification work inside the app).
 *  - `cli`: an external coding-agent CLI spawned in the workspace (codex, claude, …).
 *
 * Concurrency is capped; every run is tracked, streamed to the UI and audited.
 */
export class SubagentRunner {
  private runs = new Map<string, SubagentRunInfo>();
  private adapters = new Map<string, CliAgentAdapter>();
  private children = new Map<string, AbortController>();
  private active = 0;
  private waiters: Array<() => void> = [];
  private runInternal?: InternalRunner;
  private probeCache?: { at: number; agents: AgentInfo[] };

  constructor(private readonly deps: SubagentRunnerDeps) {
    this.syncAdapters();
  }

  setInternalRunner(runner: InternalRunner): void {
    this.runInternal = runner;
  }

  private syncAdapters(): void {
    for (const agent of this.deps.config().cliAgents) {
      this.adapters.set(agent.id, new CliAgentAdapter(agent));
    }
  }

  availableAgents(): AgentInfo[] {
    const now = Date.now();
    if (this.probeCache && now - this.probeCache.at < 30_000) return this.probeCache.agents;

    const agents: AgentInfo[] = [
      {
        id: INTERNAL_AGENT_ID,
        label: 'beeCode internal (read-only Nested session)',
        kind: 'internal',
        available: this.deps.config().enabled && Boolean(this.runInternal),
        detail: this.runInternal ? 'runs inside the service' : 'internal runner not wired',
      },
    ];
    for (const adapter of this.adapters.values()) {
      const probe = adapter.probe();
      agents.push({
        id: adapter.id,
        label: adapter.label,
        kind: 'cli',
        available: probe.available,
        detail: probe.detail,
      });
    }
    this.probeCache = { at: now, agents };
    return agents;
  }

  list(): SubagentRunInfo[] {
    return [...this.runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  cancel(runId: string): boolean {
    const controller = this.children.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async delegate(req: SubagentRequest): Promise<SubagentResult> {
    if (!this.deps.config().enabled) {
      return { runId: '', agent: req.agent, status: 'failed', output: '', error: 'subagents are disabled in config' };
    }
    if (req.depth > 2) {
      return {
        runId: '',
        agent: req.agent,
        status: 'failed',
        output: '',
        error: 'delegation depth exceeded (a subagent may not delegate further)',
      };
    }

    const runId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const run: SubagentRunInfo = {
      id: runId,
      parentSessionId: req.parentSessionId,
      agent: req.agent,
      task: req.task.slice(0, 2000),
      status: 'queued',
      startedAt: new Date().toISOString(),
      output: '',
    };
    this.runs.set(runId, run);
    this.publish(run);

    await this.acquire();
    const controller = new AbortController();
    this.children.set(runId, controller);
    const onParentAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onParentAbort, { once: true });

    run.status = 'running';
    this.publish(run);

    this.deps.audit.record({
      sessionId: req.parentSessionId,
      action: 'subagent',
      outcome: 'allowed',
      target: `${req.agent}: ${req.task.slice(0, 120)}`,
      detail: `run ${runId}`,
    });

    try {
      const result = await this.execute(run, req, controller.signal);
      run.status = result.status;
      run.output = result.output;
      run.error = result.error;
      run.endedAt = new Date().toISOString();
      this.publish(run);
      return { runId, agent: req.agent, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.status = 'failed';
      run.error = message;
      run.endedAt = new Date().toISOString();
      this.publish(run);
      this.deps.log.warn('subagent failed', { runId, message });
      return { runId, agent: req.agent, status: 'failed', output: run.output, error: message };
    } finally {
      this.children.delete(runId);
      req.signal?.removeEventListener('abort', onParentAbort);
      this.release();
    }
  }

  /** Fan-out helper: the same agent runs several independent tasks in parallel. */
  async delegateMany(
    agent: string,
    tasks: string[],
    base: Omit<SubagentRequest, 'agent' | 'task'>,
  ): Promise<SubagentResult[]> {
    return Promise.all(tasks.map((task) => this.delegate({ ...base, agent, task })));
  }

  private async execute(
    run: SubagentRunInfo,
    req: SubagentRequest,
    signal: AbortSignal,
  ): Promise<Omit<SubagentResult, 'runId' | 'agent'>> {
    if (req.agent === INTERNAL_AGENT_ID) {
      if (!this.runInternal) {
        return { status: 'failed', output: '', error: 'internal subagent runner is unavailable' };
      }
      const res = await this.runInternal(req.task, {
        parentSessionId: req.parentSessionId,
        cwd: req.cwd,
        depth: req.depth + 1,
        signal,
      });
      run.output = res.output.slice(0, MAX_OUTPUT_CHARS);
      return { status: 'succeeded', output: res.output };
    }

    const adapter = this.adapters.get(req.agent);
    if (!adapter) {
      const known = [...this.adapters.keys(), INTERNAL_AGENT_ID].join(', ');
      return { status: 'failed', output: '', error: `unknown subagent "${req.agent}" (known: ${known})` };
    }

    let lastEmit = 0;
    const res = await adapter.run(req.task, {
      cwd: req.cwd,
      signal,
      onOutput: (chunk) => {
        run.output = `${run.output}${chunk}`.slice(-MAX_OUTPUT_CHARS);
        const now = Date.now();
        if (now - lastEmit > 150) {
          lastEmit = now;
          this.publish(run);
        }
      },
    });

    run.exitCode = res.exitCode;
    if (signal.aborted) return { status: 'cancelled', output: run.output, error: 'cancelled' };
    if (res.error) return { status: 'failed', output: run.output, error: res.error };
    return { status: 'succeeded', output: run.output };
  }

  private publish(run: SubagentRunInfo): void {
    try {
      this.deps.onUpdate({ ...run });
    } catch {
      /* UI sink failures must not break delegation */
    }
  }

  private acquire(): Promise<void> {
    const max = Math.max(1, this.deps.config().maxConcurrent);
    if (this.active < max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    next?.();
  }
}
