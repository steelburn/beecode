import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  defaultConfig,
  defaultPolicy,
  normalizeConfig,
  normalizeFeatures,
  normalizeMcpServers,
  normalizeWorkspace,
} from '../shared/defaults';
import { installSecrets } from './secrets';
import type {
  BeeCodeConfig,
  Schedule,
  ScheduleInput,
  SkillInfo,
  PolicyDocument,
  RpcMethod,
  ServiceEvent,
  ServiceHealth,
  AuditEntry,
  WorkspaceState,
  FsEntry,
  FsFile,
  FsListing,
} from '../shared/protocol';
import type { HostCall } from '../shared/browser';
import { paths } from '../shared/tools';
import { BUILTIN_PLUGINS } from '../plugins/builtin';
import { PluginHost } from '../plugins/host';
import { AuditLog } from './audit';
import { SchedulerRunner } from './scheduler/runner';
import { ScheduleStore } from './scheduler/store';
import { BrowserController } from './browser/controller';
import { DesktopController } from './desktop/controller';
import { McpManager } from './mcp/manager';
import { SkillStore } from './skills/store';
import { installSkills } from './skills/install';
import { createLogger, readJsonFile, writeJsonFile, type Logger } from './logger';
import { loadEnvPreset } from './llm/envPreset';
import { listModels } from './llm/models';
import { resolveApiKey } from './llm/types';
import { PolicyEngine } from './policy';
import { AgentLoop } from './session/AgentLoop';
import { SessionManager } from './session/SessionManager';
import { SessionStore } from './session/persistence';
import { GoalStore, MemoryStore, TodoStore } from './stores';
import { AGENT_PRESETS, normalizeCliAgents } from './subagents/adapters';
import { SubagentRunner } from './subagents/runner';
import { buildToolRegistry, type ToolDeps } from './tools/index';
import type { ToolRegistry } from './tools/registry';

export interface ServiceOptions {
  transport: 'stdio' | 'http';
  version: string;
  /** Overrides config.agent.workingDir (used by the Electron main process). */
  workspace?: string;
}

const SERVICE_VERSION = '0.1.0';

/**
 * The background agent service.
 *
 * It owns every long-lived object — config, policy, audit trail, desktop controller,
 * subagents, sessions and the agent loop — and exposes them as a JSON-RPC surface.
 * Transports (stdio for the desktop app, HTTP/SSE for headless use) are thin adapters
 * on top, so the same runtime can live behind the Electron window or in a terminal.
 */
/**
 * Explorer limits: enough entries for a real folder and enough bytes for a source file,
 * small enough that one RPC reply stays cheap to serialise.
 */
const FS_LIST_LIMIT = 500;
const FS_PREVIEW_BYTES = 256 * 1024;

export class BeeCodeService {
  private config: BeeCodeConfig = defaultConfig();
  private log!: Logger;
  private audit!: AuditLog;
  private policy!: PolicyEngine;
  private desktop!: DesktopController;
  private browser!: BrowserController;
  /** Bound by the transport: the desktop app can host a browser, HTTP cannot. */
  private hostCall?: HostCall;
  private subagents!: SubagentRunner;
  private sessions!: SessionManager;
  private todos = new TodoStore();
  private goals = new GoalStore();
  private memory = new MemoryStore();
  /** Disk-backed transcript history: one JSON document per session. */
  private sessionStore!: SessionStore;
  private registry!: ToolRegistry;
  private skills!: SkillStore;
  private mcp!: McpManager;
  private plugins!: PluginHost;
  /** Schedules on disk — the same list the `schedule` tool and the Scheduler panel edit. */
  private scheduler!: ScheduleStore;
  /** The timer that turns a due schedule into a session. */
  private scheduleRunner!: SchedulerRunner;
  private deps!: ToolDeps;
  private subagentRegistry!: ToolRegistry;
  private listeners = new Set<(event: ServiceEvent) => void>();
  private startedAt = new Date().toISOString();
  private stopping = false;

  private readonly secrets = installSecrets();

  private constructor(private readonly options: ServiceOptions) {}

  static async create(options: ServiceOptions): Promise<BeeCodeService> {
    const service = new BeeCodeService(options);
    await service.init();
    return service;
  }

  private async init(): Promise<void> {
    const p = paths();
    await mkdir(p.home, { recursive: true });

    this.log = createLogger(`${p.logs}/service.log`, (level, message) => {
      if (level === 'debug') return;
      this.emit({ type: 'log', payload: { level, message, at: new Date().toISOString() } });
    });

    this.sessionStore = new SessionStore(this.log);
    this.scheduler = new ScheduleStore();
    // The store is the list and the runner is stateless: every fire opens a fresh
    // session, so a background run never interleaves with what the user is doing.
    this.scheduleRunner = new SchedulerRunner({
      store: this.scheduler,
      log: this.log,
      start: (schedule) => this.startScheduledSession(schedule),
      notify: (schedules) => this.emit({ type: 'scheduler.changed', payload: { schedules } }),
    });
    // The two stores are the single source of truth for the goal and the plan. A write from
    // a tool, an RPC or a restore lands here, and the renderer panel and the persisted
    // transcript both follow from the same notification — no polling, no second copy.
    this.todos.onWrite((sessionId, todos) => {
      // With `features.goalTodo` off there is no plan panel and no goal/todo tool, so a
      // write is ignored outright instead of being emitted and persisted for a surface
      // that is not there — re-enabling the feature must not resurrect a stale plan.
      if (!this.deps.goalTodoEnabled) return;
      this.emit({ type: 'session.todos', payload: { sessionId, todos } });
      this.sessions?.persistNow(sessionId);
    });
    this.goals.onWrite((sessionId, goal) => {
      if (!this.deps.goalTodoEnabled) return;
      this.emit({ type: 'session.goal', payload: { sessionId, goal } });
      this.sessions?.persistNow(sessionId);
    });

    const loaded = await readJsonFile<Partial<BeeCodeConfig>>(p.config, {});
    this.config = this.mergeConfig(loaded);
    this.applyEnvPreset();
    // The host may pass an explicit directory (BEECODE_WORKSPACE, a test run). It becomes
    // the workspace root, so the picker and the tools always agree on one directory.
    if (this.options.workspace) {
      this.config.workspace = { ...this.config.workspace, root: this.options.workspace };
      this.config.agent.workingDir = this.options.workspace;
    }
    await writeJsonFile(p.config, this.config);

    this.audit = new AuditLog(p.audit);
    await this.loadPolicyState();
    this.policy.setWorkspaceRoots(this.workspaceRoots());

    // Browser activity is reported on the same host-activity stream as the desktop driver so
    // the UI has a single "what did the agent do to the machine" feed.
    this.browser = new BrowserController({
      policy: this.policy,
      audit: this.audit,
      config: () => this.config.browser,
      host: () => this.hostCall,
      onActivity: (entry) => this.emit({ type: 'desktop.activity', payload: entry }),
    });

    this.desktop = new DesktopController(this.policy, this.audit, {
      allowInput: this.config.desktop.allowInput,
      driver: this.config.desktop.enabled ? this.config.desktop.driver : 'mock',
      onAudit: (entry) => this.emit({ type: 'desktop.activity', payload: entry }),
    });

    this.subagents = new SubagentRunner({
      config: () => this.config.subagents,
      audit: this.audit,
      log: this.log,
      onUpdate: (run) => this.emit({ type: 'subagent.update', payload: run }),
    });

    // Skills come from disk, MCP tools from external servers: both must be ready before
    // the registries are built, because a registry cannot grow tools after the fact.
    this.skills = new SkillStore();
    this.mcp = new McpManager({ servers: () => this.config.mcpServers ?? {}, log: this.log });
    await this.mcp.start();
    await this.scanSkills(this.config.agent.workingDir);

    // Plugins contribute tools exactly like MCP servers do, so they are activated here —
    // before the registries are built — and reloaded whenever the plugin config changes.
    this.plugins = new PluginHost({
      plugins: () => this.config.plugins ?? { enabled: true, allowExternal: true, dirs: [], disabled: [] },
      builtins: BUILTIN_PLUGINS,
      log: this.log,
      policy: () => this.policy,
      audit: () => this.audit,
      hostCall: () => this.hostCall,
      reservedNames: () => this.registry?.names() ?? [],
    });
    await this.plugins.start();

    this.deps = {
      controller: this.desktop,
      browser: this.browser,
      policy: this.policy,
      audit: this.audit,
      subagents: this.subagents,
      goals: this.goals,
      todos: this.todos,
      memory: this.memory,
      goalTodoEnabled: this.config.features.goalTodo,
      skills: this.skills,
      scanSkills: (cwd) => this.scanSkills(cwd),
      mcp: this.mcp,
      // Same contract as MCP: the thunk is re-read on every rebuildRegistries(), which
      // service.ts already runs after `plugins.reload()`.
      plugins: { toolDefinitions: (reserved) => this.plugins.toolDefinitions(reserved) },
      scheduler: {
        store: this.scheduler,
        runner: this.scheduleRunner,
        notify: (schedules) => this.emit({ type: 'scheduler.changed', payload: { schedules } }),
      },
    };
    this.rebuildRegistries();

    const loop = new AgentLoop({
      tools: (session) => (session.depth > 0 ? this.subagentRegistry : this.registry),
      config: () => this.config,
      emit: (event) => this.emit(event),
      log: this.log,
      memory: this.memory,
      describePolicy: () => this.policy.describeAllowedApps(),
      listAgents: () => this.subagents.availableAgents(),
      listSkills: (cwd) => this.skillSection(cwd),
      describeMcp: () => this.mcp.describe(),
      requestApproval: (session, request) => this.sessions.requestApproval(session, request),
    });

    this.sessions = new SessionManager({
      loop,
      config: () => this.config,
      emit: (event) => this.emit(event),
      log: this.log,
      defaultCwd: () => this.config.agent.workingDir,
      goals: this.goals,
      todos: this.todos,
      store: this.sessionStore,
    });

    // Timers start last: a due schedule opens a session of its own.
    this.scheduleRunner.start();

    // Rehydrate the newest transcripts so history and plans survive a restart. A missing,
    // empty or corrupt store restores nothing and never fails the startup.
    const restored = await this.sessions.restore();
    if (restored) this.log.info('sessions restored', { restored });

    this.subagents.setInternalRunner((task, ctx) =>
      this.sessions.runNested(task, {
        parentSessionId: ctx.parentSessionId,
        cwd: ctx.cwd,
        depth: ctx.depth,
      }),
    );

    this.log.info('service started', {
      transport: this.options.transport,
      driver: this.desktop.driverName,
      tools: this.registry.names().length,
      workspace: this.config.agent.workingDir,
    });
  }

  /**
   * Bind the transport's channel to the desktop host (stdio). Without it the `browser_*`
   * tools report the internal browser as unavailable instead of failing obscurely.
   */
  bindHostCall(call: HostCall): void {
    this.hostCall = call;
  }

  /**
   * Folds a `.env.llm` endpoint into the config as a first-class preset. The file is an
   * explicit opt-in, so a valid one takes over as the default model — otherwise the user
   * would have to click through the picker before their key had any effect.
   */
  /**
   * True when a key resolves for this preset: one stored in secrets.json, or one exported in the
   * preset's env var (or the provider default when that field is blank). Settings shows the
   * stored/env alternative on this flag, so it has to agree with `resolveApiKey`.
   */
  private hasApiKey(preset: BeeCodeConfig['models'][number]): boolean {
    try {
      return Boolean(resolveApiKey(preset));
    } catch {
      return false;
    }
  }

  private applyEnvPreset(): void {
    const env = loadEnvPreset();
    for (const warning of env.warnings) this.log.warn(`env.llm: ${warning}`);
    if (!env.preset) return;
    this.config = {
      ...this.config,
      models: [env.preset, ...this.config.models.filter((m) => m.id !== env.preset!.id)],
      defaultModelId: env.preset.id,
    };
    this.log.info(`env.llm loaded from ${env.source}: ${env.preset.model} @ ${env.preset.baseUrl}`);
  }

  private mergeConfig(loaded: Partial<BeeCodeConfig>): BeeCodeConfig {
    const base = defaultConfig();
    const workspace = normalizeWorkspace(loaded.workspace, base.workspace);
    return {
      ...base,
      ...loaded,
      workspace,
      features: normalizeFeatures(loaded.features, base.features),
      models: loaded.models?.length ? loaded.models : base.models,
      service: { ...base.service, ...(loaded.service ?? {}) },
      agent: {
        ...base.agent,
        ...(loaded.agent ?? {}),
        // Explicit agent.workingDir wins, then the workspace root, then nothing at all.
        // Never process.cwd(): that is the installation directory in a packaged app.
        workingDir: (loaded.agent?.workingDir ?? '').trim() || workspace.root || base.agent.workingDir,
      },
      desktop: { ...base.desktop, ...(loaded.desktop ?? {}) },
      browser: { ...base.browser, ...(loaded.browser ?? {}) },
      subagents: {
        ...base.subagents,
        ...(loaded.subagents ?? {}),
        cliAgents: normalizeCliAgents(loaded.subagents?.cliAgents ?? base.subagents.cliAgents),
      },
      mcpServers: normalizeMcpServers({ ...base.mcpServers, ...(loaded.mcpServers ?? {}) }),
      skills: { ...base.skills, ...(loaded.skills ?? {}) },
    };
  }

  private async loadPolicyState(): Promise<void> {
    const p = paths();
    // Start from the shipped defaults (deny-by-default, browser section included) and let
    // `PolicyEngine.load` widen them from the user's file — never the other way round.
    this.policy = new PolicyEngine(defaultPolicy(), [this.config.agent.workingDir]);
    await this.policy.load(p.policy);
  }

  /* ---------------------------------------------------------------- events */

  onEvent(listener: (event: ServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken transport must not break the service */
      }
    }
  }

  /* ----------------------------------------------------------------- health */

  health(): ServiceHealth {
    return {
      ok: !this.stopping,
      version: SERVICE_VERSION,
      pid: process.pid,
      platform: process.platform,
      startedAt: this.startedAt,
      transport: this.options.transport,
      desktopDriver: this.desktop.driverName,
      tools: this.registry.names().length,
      sessions: this.sessions.count(),
    };
  }

  /* -------------------------------------------------------------- RPC entry */

  async handle(method: string, params: unknown): Promise<unknown> {
    const args = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'app.hello':
        return { protocol: 1, health: this.health() };

      case 'service.health':
        return this.health();

      case 'plugin.list':
        return { plugins: this.plugins.info() };

      case 'plugin.reload':
        await this.plugins.reload();
        this.rebuildRegistries();
        return { plugins: this.plugins.info() };

      case 'plugin.setEnabled': {
        const id = typeof args.id === 'string' ? args.id : '';
        if (!id) throw new Error('plugins.setEnabled needs an id');
        const enabled = args.enabled === true;
        await this.plugins.setEnabled(id, enabled);
        const disabled = new Set(this.config.plugins.disabled);
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        this.config.plugins.disabled = [...disabled];
        await writeJsonFile(paths().config, this.config);
        this.rebuildRegistries();
        return { plugins: this.plugins.info() };
      }

      case 'service.shutdown':
        this.stopping = true;
        setImmediate(() => void this.shutdown());
        return { stopping: true };

      case 'session.list':
        // Live sessions plus the persisted transcripts of a previous run, so the rail can
        // offer a conversation to reopen. Cheap after the first call: the store caches its index.
        return this.sessions.history();

      case 'session.create':
        return this.sessions.snapshot(
          this.sessions.create({
            title: typeof args.title === 'string' ? args.title : undefined,
            cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
            mode: args.mode as never,
            model: typeof args.model === 'string' ? args.model : undefined,
            parentSessionId: typeof args.parentSessionId === 'string' ? args.parentSessionId : undefined,
          }).id,
        );

      case 'session.get':
        // A history entry that is not in memory is loaded from disk on demand.
        return this.sessions.open(this.requireString(args, 'sessionId'));

      case 'session.delete':
        this.sessions.delete(this.requireString(args, 'sessionId'));
        return { deleted: true };

      case 'workspace.state':
        return this.workspaceState();

      case 'fs.list':
        return this.listDirectory(typeof args.path === 'string' ? args.path : undefined);

      case 'fs.read':
        return this.readPreview(this.requireString(args, 'path'));

      case 'workspace.set': {
        const dir = resolve(this.requireString(args, 'path').trim());
        const info = await stat(dir).catch(() => undefined);
        if (!info?.isDirectory()) throw new Error(`not an existing folder: ${dir}`);
        return this.setWorkspace(dir);
      }

      case 'workspace.forget':
        return this.forgetWorkspace(resolve(this.requireString(args, 'path').trim()));

      case 'goal.set': {
        const sessionId = this.requireString(args, 'sessionId');
        this.sessions.get(sessionId);
        // The store notifies -> the service emits `session.goal` and persists the transcript.
        this.goals.set(sessionId, typeof args.text === 'string' ? args.text : '');
        return this.sessions.snapshot(sessionId);
      }

      case 'goal.clear': {
        const sessionId = this.requireString(args, 'sessionId');
        this.sessions.get(sessionId);
        const had = Boolean(this.goals.read(sessionId));
        this.goals.clear(sessionId);
        if (!had) {
          // No goal to remove: still persist and tell the UI, so both sides agree.
          this.sessions.persistNow(sessionId);
          this.emit({ type: 'session.goal', payload: { sessionId, goal: undefined } });
        }
        return this.sessions.snapshot(sessionId);
      }

      case 'todo.list':
        return { todos: this.todos.read(this.requireString(args, 'sessionId')) };

      case 'agents.detect':
        // An explicit detect is the user asking to look again, so it bypasses the cache.
        return { agents: this.subagents.detect(args.probe !== false, args.probe !== false) };

      case 'agents.save': {
        // The UI cannot know a preset's flags (they are what makes `claude -p` a one-shot
        // run instead of an interactive session), so an entry without args inherits them.
        const entries = normalizeCliAgents(args.agents).map((entry) => {
          const preset = AGENT_PRESETS.find((candidate) => candidate.id === entry.id);
          if (entry.args.length) return entry;
          const known = this.config.subagents.cliAgents.find((candidate) => candidate.id === entry.id);
          if (!preset) {
            return known?.args.length ? { ...entry, args: [...known.args] } : entry;
          }
          return { ...entry, args: [...preset.args], label: entry.label === entry.id ? preset.label : entry.label };
        });
        this.config.subagents = { ...this.config.subagents, cliAgents: entries };
        await this.persistConfig();
        this.subagents.reload();
        this.log.info('subagent CLIs saved', { agents: entries.length });
        // Reuses the probe cache: saving must not re-spawn every CLI on PATH.
        return { agents: this.subagents.detect(true) };
      }

      case 'session.prompt':
        return this.sessions.prompt(this.requireString(args, 'sessionId'), this.requireString(args, 'text'));

      case 'session.abort':
        return { aborted: this.sessions.abort(this.requireString(args, 'sessionId')) };

      case 'scheduler.list':
        return { schedules: await this.scheduler.list() };

      case 'scheduler.save': {
        const schedule = await this.scheduler.save(args as unknown as ScheduleInput);
        const schedules = await this.scheduler.list();
        this.emit({ type: 'scheduler.changed', payload: { schedules } });
        return { schedule, schedules };
      }

      case 'scheduler.remove': {
        await this.scheduler.remove(this.requireString(args, 'id'));
        const schedules = await this.scheduler.list();
        this.emit({ type: 'scheduler.changed', payload: { schedules } });
        return { schedules };
      }

      case 'scheduler.run':
        return { sessionId: await this.scheduleRunner.runNow(this.requireString(args, 'id')) };

      case 'mcp.list':
        return { servers: this.mcp.list() };

      case 'mcp.reload': {
        const servers = await this.mcp.reload();
        this.rebuildRegistries();
        this.log.info('mcp servers reloaded', {
          servers: servers.filter((server) => server.state === 'connected').length,
          tools: this.mcp.toolCount(),
        });
        return { servers };
      }

      case 'skill.list':
        return { skills: await this.scanSkills(this.skillsCwd(args)) };

      case 'skill.reload':
        return { skills: await this.skills.load(this.skillScanOptions(this.skillsCwd(args))) };

      case 'skill.install': {
        const cwd = this.skillsCwd(args);
        const result = await installSkills({
          fileName: typeof args.fileName === 'string' ? args.fileName : undefined,
          url: typeof args.url === 'string' ? args.url.trim() || undefined : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
          base64: typeof args.base64 === 'string' ? args.base64 : undefined,
        });
        // Re-read the roots so the returned list already contains the new skills.
        return { skills: await this.skills.load(this.skillScanOptions(cwd)), installed: result.installed };
      }

      case 'skill.read': {
        const cwd = this.skillsCwd(args);
        await this.scanSkills(cwd);
        const name = this.requireString(args, 'name');
        const record = this.skills.get(name);
        if (!record) throw new Error(`unknown skill "${name}"`);
        return { skill: record.info, content: record.body };
      }

      case 'session.setMode':
        return this.sessions.setMode(this.requireString(args, 'sessionId'), args.mode as never);

      case 'session.setModel':
        return this.sessions.setModel(this.requireString(args, 'sessionId'), this.requireString(args, 'model'));

      case 'session.setCwd':
        return this.sessions.setCwd(this.requireString(args, 'sessionId'), this.requireString(args, 'cwd'));

      case 'approval.respond':
        return {
          ok: this.sessions.resolveApproval(
            this.requireString(args, 'approvalId'),
            (args.decision as 'allow' | 'allow-session' | 'deny') ?? 'deny',
          ),
        };

      case 'policy.get':
        return this.policy.get();

      case 'policy.set': {
        const next = args.policy as PolicyDocument;
        if (!next || !Array.isArray(next.allowedApps)) throw new Error('policy.allowedApps must be an array');
        this.policy.set(next);
        await this.policy.save(paths().policy);
        this.log.info('policy updated', { apps: next.allowedApps.length });
        return this.policy.get();
      }

      // Settings probes the endpoint for its model list; the key may still be a draft that
      // has not been saved yet, so it travels with the request instead of being read from disk.
      case 'models.list':
        return listModels({
          presetId: typeof args.presetId === 'string' ? args.presetId : undefined,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          baseUrl: typeof args.baseUrl === 'string' ? args.baseUrl : undefined,
          apiKeyEnv: typeof args.apiKeyEnv === 'string' ? args.apiKeyEnv : undefined,
          apiKey: typeof args.apiKey === 'string' ? args.apiKey : undefined,
        });

      case 'config.get':
        // Keys are write-only: the renderer learns whether one exists, never its value.
        return {
          ...this.config,
          models: this.config.models.map((preset) => ({
            ...preset,
            apiKey: undefined,
            hasKey:
              this.hasApiKey(preset),
          })),
        };

      case 'config.set': {
        const next = args.config as BeeCodeConfig;
        if (!next || !Array.isArray(next.models)) throw new Error('config.models must be an array');
        // Keys are write-only: pull them out before the config is normalized or persisted.
        for (const preset of next.models) {
          const typed = typeof preset.apiKey === 'string' ? preset.apiKey.trim() : '';
          if (typed) this.secrets.set(preset.id, typed);
        }
        const sanitized = {
          ...next,
          models: next.models.map((preset) => {
            const { apiKey: _key, ...rest } = preset;
            return rest;
          }),
        };
        const previousMcp = JSON.stringify(this.config.mcpServers ?? {});
        const previousPlugins = JSON.stringify(this.config.plugins ?? {});
        const previousGoalTodo = this.config.features.goalTodo;
        // The workspace is changed through `workspace.set` (it validates the folder) and
        // has its own RPC; a config save must never silently drop the root.
        sanitized.workspace = { ...this.config.workspace, ...(sanitized.workspace ?? {}) };
        sanitized.features = { ...this.config.features, ...(sanitized.features ?? {}) };
        this.config = this.mergeConfig(normalizeConfig(sanitized, { strict: true }));
        // Drop secrets for presets the normalizer rejected or the user removed.
        this.secrets.prune(this.config.models.map((preset) => preset.id));
        if (this.config.agent.workingDir) await mkdir(this.config.agent.workingDir, { recursive: true });
        this.policy.setWorkspaceRoots(this.workspaceRoots());
        await writeJsonFile(paths().config, this.config);
        // An edited server list has to take effect now: the registry cannot grow tools
        // after it is built, so reconnect and rebuild before answering. A server that
        // fails to start is reported in its status — it never fails the save.
        if (JSON.stringify(this.config.mcpServers ?? {}) !== previousMcp) {
          await this.mcp.reload();
          this.rebuildRegistries();
        }
        if (JSON.stringify(this.config.plugins ?? {}) !== previousPlugins) {
          await this.plugins.reload();
          this.rebuildRegistries();
        }
        // Turning the goal/to-do surface off removes its tools from the schema: the
        // registry is rebuilt so the model cannot plan into a UI that is not there.
        if (previousGoalTodo !== this.config.features.goalTodo) {
          this.deps.goalTodoEnabled = this.config.features.goalTodo;
          this.rebuildRegistries();
        }
        this.emit({ type: 'service.health', payload: this.health() });
        return this.config;
      }

      case 'audit.list':
        return this.audit.recent(typeof args.limit === 'number' ? args.limit : 200);

      case 'agents.list':
        return this.subagents.availableAgents();

      case 'subagent.list':
        return this.subagents.list();

      case 'subagent.cancel':
        return { cancelled: this.subagents.cancel(this.requireString(args, 'runId')) };

      case 'tools.list':
        return this.registry.info();

      default:
        throw new Error(`unknown method "${method}"`);
    }
  }

  /** Delegation entry point for the HTTP/stdio surface (used by tests and the CLI). */
  async delegate(params: { parentSessionId: string; agent: string; task: string; cwd?: string }) {
    return this.subagents.delegate({
      parentSessionId: params.parentSessionId,
      agent: params.agent,
      task: params.task,
      cwd: params.cwd ?? this.config.agent.workingDir,
      depth: 0,
    });
  }

  latestAudit(): Promise<AuditEntry[]> {
    return this.audit.recent(50);
  }

  /**
   * A due schedule gets its own session: the user's chat is never touched, and the
   * transcript of the background run stays in the rail afterwards, named after the
   * schedule so it is obvious where it came from.
   */
  private startScheduledSession(schedule: Schedule): Promise<string> {
    const session = this.sessions.create({
      title: schedule.name,
      cwd: schedule.cwd ?? this.config.agent.workingDir,
      mode: schedule.mode,
    });
    this.sessions.prompt(session.id, schedule.prompt);
    return Promise.resolve(session.id);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const session of this.sessions.list()) {
      this.sessions.abort(session.id);
    }
    // Flush the debounced transcript writes: a closed window must not lose the last turn.
    await this.sessions.flush();
    this.scheduleRunner?.stop();
    await this.mcp.stop();
    await this.audit.flush();
    this.log.info('service stopping');
  }

  /** Rebuilds the main and subagent catalogues (needed after an MCP or plugin reload). */
  private rebuildRegistries(): void {
    this.registry = buildToolRegistry(this.deps, { allowDelegation: true });
    this.subagentRegistry = buildToolRegistry(this.deps, { allowDelegation: false, readOnly: true });
  }

  /* -------------------------------------------------------------- explorer */

  /** True when `target` is one of the configured roots or lives below one of them. */
  private isInsideRoots(target: string): boolean {
    return this.workspaceRoots()
      .map((root) => resolve(root))
      .some((root) => target === root || target.startsWith(`${root}${sep}`) || target.startsWith(`${root}/`));
  }

  /**
   * Resolve a renderer-supplied path. The explorer is a read-only view of the workspace,
   * so it may walk the workspace root and the agent's working directory and nothing else.
   */
  private resolveExplorerPath(input?: string): string {
    const base = this.config.workspace.root || this.config.agent.workingDir;
    if (!base) throw new Error('no workspace is configured');
    const target = input?.trim() ? resolve(base, input) : resolve(base);
    if (!this.isInsideRoots(target)) throw new Error(`path is outside the workspace: ${target}`);
    return target;
  }

  private async listDirectory(input?: string): Promise<FsListing> {
    const dir = this.resolveExplorerPath(input);
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const dirent of dirents.slice(0, FS_LIST_LIMIT)) {
      const path = join(dir, dirent.name);
      const isDir = dirent.isDirectory();
      let size: number | undefined;
      if (!isDir) size = (await stat(path).catch(() => undefined))?.size;
      entries.push({ name: dirent.name, path, dir: isDir, size, link: dirent.isSymbolicLink() });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const up = dirname(dir);
    return {
      path: dir,
      parent: up !== dir && this.isInsideRoots(up) ? up : undefined,
      entries,
      truncated: dirents.length > FS_LIST_LIMIT,
    };
  }

  private async readPreview(input: string): Promise<FsFile> {
    const path = this.resolveExplorerPath(input);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`not a file: ${path}`);
    const length = Math.min(info.size, FS_PREVIEW_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(path, 'r');
    try {
      if (length) await handle.read(buffer, 0, length, 0);
    } finally {
      await handle.close();
    }
    // A NUL byte in the first block is the cheap, reliable "this is not text" signal.
    const binary = buffer.includes(0);
    return {
      path,
      name: basename(path),
      size: info.size,
      truncated: info.size > FS_PREVIEW_BYTES,
      binary,
      text: binary ? '' : buffer.toString('utf8'),
    };
  }

  /* ------------------------------------------------------------- workspace */

  /** Policy roots: the session working directory and the chosen workspace, deduped. */
  private workspaceRoots(): string[] {
    const roots = [this.config.agent.workingDir, this.config.workspace.root]
      .map((dir) => dir.trim())
      .filter(Boolean);
    return [...new Set(roots)];
  }

  /**
   * The workspace as the renderer sees it. `configured` is false until a folder exists on
   * disk, which is what shows the setup step — the app never assumes the install directory.
   */
  private async workspaceState(): Promise<WorkspaceState> {
    const { root, recent } = this.config.workspace;
    let configured = false;
    if (root) {
      const info = await stat(root).catch(() => undefined);
      configured = Boolean(info?.isDirectory());
    }
    return { root, recent: [...recent], configured };
  }

  private async setWorkspace(dir: string): Promise<WorkspaceState> {
    const previous = this.config.workspace;
    const recent = [previous.root, ...previous.recent]
      .filter((candidate): candidate is string => Boolean(candidate) && candidate !== dir)
      .filter((candidate, index, all) => all.indexOf(candidate) === index)
      .slice(0, 8);
    this.config.workspace = { ...previous, root: dir, recent };
    // An explicit agent.workingDir is the user's choice and stays; an empty one (or one
    // that was following the previous root) moves with the workspace.
    if (!this.config.agent.workingDir || this.config.agent.workingDir === previous.root) {
      this.config.agent.workingDir = dir;
    }
    await this.persistConfig();
    this.policy.setWorkspaceRoots(this.workspaceRoots());
    await this.scanSkills(dir);
    this.emit({ type: 'service.health', payload: this.health() });
    this.log.info('workspace set', { root: dir });
    return this.workspaceState();
  }

  private async forgetWorkspace(dir: string): Promise<WorkspaceState> {
    const previous = this.config.workspace;
    const active = previous.root === dir;
    this.config.workspace = {
      ...previous,
      root: active ? '' : previous.root,
      recent: previous.recent.filter((candidate) => candidate !== dir),
    };
    if (active) {
      // The tools lose their root with it. An explicit working directory stays, but it is
      // never replaced by the installation directory: the renderer shows the setup step.
      if (this.config.agent.workingDir === dir) this.config.agent.workingDir = '';
      this.policy.setWorkspaceRoots(this.workspaceRoots());
    }
    await this.persistConfig();
    this.emit({ type: 'service.health', payload: this.health() });
    return this.workspaceState();
  }

  private async persistConfig(): Promise<void> {
    const p = paths();
    await mkdir(p.home, { recursive: true });
    await writeJsonFile(p.config, this.config);
  }

  private skillsCwd(args: Record<string, unknown>): string {
    const cwd = typeof args.cwd === 'string' ? args.cwd.trim() : '';
    return cwd || this.config.agent.workingDir;
  }

  private skillScanOptions(cwd: string) {
    return {
      cwd,
      extraDirs: this.config.skills?.dirs,
      maxBytes: this.config.skills?.maxBytes,
    };
  }

  private async scanSkills(cwd: string): Promise<SkillInfo[]> {
    if (this.config.skills?.enabled === false) return [];
    return this.skills.ensure(this.skillScanOptions(cwd));
  }

  /** The skills block of the system prompt ('' when skills are off or absent). */
  private async skillSection(cwd: string): Promise<string> {
    await this.scanSkills(cwd);
    return this.skills.describe();
  }

  private requireString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || !value.length) throw new Error(`missing required parameter "${key}"`);
    return value;
  }
}

export type { RpcMethod };
