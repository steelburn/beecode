import { mkdir } from 'node:fs/promises';
import { defaultConfig, defaultPolicy, normalizeConfig, normalizeMcpServers } from '../shared/defaults';
import { installSecrets } from './secrets';
import type {
  BeeCodeConfig,
  SkillInfo,
  PolicyDocument,
  RpcMethod,
  ServiceEvent,
  ServiceHealth,
  AuditEntry,
} from '../shared/protocol';
import type { HostCall } from '../shared/browser';
import { paths } from '../shared/tools';
import { BUILTIN_PLUGINS } from '../plugins/builtin';
import { PluginHost } from '../plugins/host';
import { AuditLog } from './audit';
import { BrowserController } from './browser/controller';
import { DesktopController } from './desktop/controller';
import { McpManager } from './mcp/manager';
import { SkillStore } from './skills/store';
import { createLogger, readJsonFile, writeJsonFile, type Logger } from './logger';
import { loadEnvPreset } from './llm/envPreset';
import { PolicyEngine } from './policy';
import { AgentLoop } from './session/AgentLoop';
import { SessionManager } from './session/SessionManager';
import { MemoryStore, TodoStore } from './stores';
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
  private memory = new MemoryStore();
  private registry!: ToolRegistry;
  private skills!: SkillStore;
  private mcp!: McpManager;
  private plugins!: PluginHost;
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

    const loaded = await readJsonFile<Partial<BeeCodeConfig>>(p.config, {});
    this.config = this.mergeConfig(loaded);
    this.applyEnvPreset();
    if (this.options.workspace) this.config.agent.workingDir = this.options.workspace;
    await writeJsonFile(p.config, this.config);

    this.audit = new AuditLog(p.audit);
    await this.loadPolicyState();
    this.policy.setWorkspaceRoots([this.config.agent.workingDir]);

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
      todos: this.todos,
      memory: this.memory,
      skills: this.skills,
      scanSkills: (cwd) => this.scanSkills(cwd),
      mcp: this.mcp,
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
    });

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
    return {
      ...base,
      ...loaded,
      models: loaded.models?.length ? loaded.models : base.models,
      service: { ...base.service, ...(loaded.service ?? {}) },
      agent: { ...base.agent, ...(loaded.agent ?? {}) },
      desktop: { ...base.desktop, ...(loaded.desktop ?? {}) },
      browser: { ...base.browser, ...(loaded.browser ?? {}) },
      subagents: { ...base.subagents, ...(loaded.subagents ?? {}) },
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
        return this.sessions.list();

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
        return this.sessions.snapshot(this.requireString(args, 'sessionId'));

      case 'session.delete':
        this.sessions.delete(this.requireString(args, 'sessionId'));
        return { deleted: true };

      case 'session.prompt':
        return this.sessions.prompt(this.requireString(args, 'sessionId'), this.requireString(args, 'text'));

      case 'session.abort':
        return { aborted: this.sessions.abort(this.requireString(args, 'sessionId')) };

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

      case 'config.get':
        // Keys are write-only: the renderer learns whether one exists, never its value.
        return {
          ...this.config,
          models: this.config.models.map((preset) => ({
            ...preset,
            apiKey: undefined,
            hasKey:
              this.secrets.has(preset.id) || Boolean(preset.apiKeyEnv && process.env[preset.apiKeyEnv]),
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
        this.config = this.mergeConfig(normalizeConfig(sanitized, { strict: true }));
        // Drop secrets for presets the normalizer rejected or the user removed.
        this.secrets.prune(this.config.models.map((preset) => preset.id));
        await mkdir(this.config.agent.workingDir, { recursive: true });
        this.policy.setWorkspaceRoots([this.config.agent.workingDir]);
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

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const session of this.sessions.list()) {
      this.sessions.abort(session.id);
    }
    await this.mcp.stop();
    await this.audit.flush();
    this.log.info('service stopping');
  }

  /** Rebuilds the main and subagent catalogues (needed after an MCP reload). */
  private rebuildRegistries(): void {
    this.registry = buildToolRegistry(this.deps, { allowDelegation: true });
    this.subagentRegistry = buildToolRegistry(this.deps, { allowDelegation: false, readOnly: true });
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
