import type { AgentInfo, SubagentConfig, SubagentRunInfo } from '../../shared/protocol';
import type { AuditLog } from '../audit';
import type { Logger } from '../logger';
import {
  AGENT_PRESETS,
  CliAgentAdapter,
  probeCommand,
  type CliAgentConfig,
  type CommandProbe,
} from './adapters';

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
  /**
   * PATH probes, keyed by command. A probe is a synchronous `where`/`--version` spawn
   * and `agents.save` re-runs `detect` on every checkbox click, so without a cache each
   * toggle stalled the service while it re-probed every configured CLI.
   */
  private probes = new Map<string, { at: number; probe: CommandProbe }>();
  private static readonly PROBE_TTL_MS = 120_000;

  constructor(private readonly deps: SubagentRunnerDeps) {
    this.syncAdapters();
  }

  setInternalRunner(runner: InternalRunner): void {
    this.runInternal = runner;
  }

  /** Rebuild the CLI adapters from config (startup here, `agents.save` through `reload`). */
  private syncAdapters(): void {
    this.adapters.clear();
    for (const agent of this.deps.config().cliAgents) {
      this.adapters.set(agent.id, new CliAgentAdapter(agent));
    }
    this.probeCache = undefined;
  }

  /** Pick up a configuration change without restarting the service. */
  reload(): void {
    this.syncAdapters();
  }

  /**
   * The whole CLI catalogue: the built-in presets merged with the user's own entries.
   *
   * A preset that is not configured is still listed (`enabled: false`) so Settings can
   * offer it the moment it turns up on PATH. Probing is best-effort — a missing CLI is
   * `available: false` with the reason, never a thrown error.
   */
  detect(probe = true, force = false): AgentInfo[] {
    const configured = new Map(this.deps.config().cliAgents.map((agent) => [agent.id, agent]));
    const agents: AgentInfo[] = [];
    for (const preset of AGENT_PRESETS) {
      agents.push(this.describe(preset, configured.get(preset.id), probe, force));
      configured.delete(preset.id);
    }
    // Configured entries that are not presets are the user's own commands.
    for (const entry of configured.values()) {
      agents.push(
        this.describe(
          { id: entry.id, label: entry.label, command: entry.command, args: entry.args },
          entry,
          probe,
          force,
        ),
      );
    }
    return agents;
  }

  private describe(
    base: Omit<CliAgentConfig, 'enabled'>,
    entry: CliAgentConfig | undefined,
    probe: boolean,
    force: boolean,
  ): AgentInfo {
    const command = entry?.command?.trim() || base.command;
    const enabled = entry?.enabled === true;
    const result = probe ? this.probeOf(command, force) : undefined;
    const onPath = result?.onPath === true;
    let detail: string;
    if (probe && !onPath) detail = `${command} not found on PATH`;
    else if (!enabled) detail = onPath ? 'found on PATH — enable it to delegate' : 'not configured';
    else detail = result?.version ?? 'enabled';
    return {
      id: base.id,
      label: entry?.label || base.label,
      kind: 'cli',
      available: enabled && onPath,
      detail,
      command,
      version: result?.version,
      onPath,
      args: entry?.args?.length ? entry.args : base.args,
      custom: entry?.custom === true || !AGENT_PRESETS.some((preset) => preset.id === base.id),
      enabled,
    };
  }

  /**
   * Cached PATH probe. `force` is what the explicit “Detect agents” action asks for;
   * everything else (saving the list, listing the tools) reuses a recent result.
   */
  private probeOf(command: string, force: boolean): CommandProbe {
    const now = Date.now();
    const cached = this.probes.get(command);
    if (!force && cached && now - cached.at < SubagentRunner.PROBE_TTL_MS) return cached.probe;
    const probe = probeCommand(command);
    this.probes.set(command, { at: now, probe });
    return probe;
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
      ...this.detect(true),
    ];
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
