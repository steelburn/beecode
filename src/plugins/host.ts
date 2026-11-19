import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { HostCall } from '../shared/browser';
import type { PluginInfo, PluginPermission, PluginsConfig, PluginToolInfo } from '../shared/protocol';
import { paths } from '../shared/tools';
import type { ToolContext, ToolDefinition, ToolResult } from '../shared/tools';
import type { AuditLog } from '../service/audit';
import type { Logger } from '../service/logger';
import type { PolicyEngine } from '../service/policy';
import {
  HOST_METHOD_PERMISSION,
  PLUGIN_API_VERSION,
  PLUGIN_PERMISSIONS,
  type PluginApi,
  type PluginDefinition,
  type PluginHostMethod,
  type PluginManifest,
  type PluginModule,
} from './types';

/** Chat APIs cap tool names (OpenAI-compatible). */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** Tool names a plugin may not claim — the agent's own catalogue. */
const RESERVED_PREFIXES = ['mcp__'];

export interface PluginHostOptions {
  /** Read lazily so a config change is picked up by the next `start()`/`reload()`. */
  plugins: () => PluginsConfig;
  /** Builtin plugins bundled with this build. */
  builtins: PluginDefinition[];
  log: Logger;
  policy: () => PolicyEngine;
  audit: () => AuditLog;
  /** Bound by the transport; absent when the service runs headless. */
  hostCall: () => HostCall | undefined;
  /** Names the core registry already uses. */
  reservedNames: () => string[];
}

interface LoadedPlugin {
  def: PluginDefinition;
  manifest: PluginManifest;
  tools: ToolDefinition[];
  enabled: boolean;
  error?: string;
}

/**
 * Loads plugins and turns their registrations into agent tools.
 *
 * A tool is only as privileged as the manifest says: file access goes through the same
 * policy as the built-in file tools, and host methods are matched against the declared
 * permissions before the call is forwarded. Everything a plugin contributes is wrapped so
 * a thrown error or a policy refusal becomes an in-band tool failure instead of taking the
 * agent loop down with it.
 */
export class PluginHost {
  private loaded = new Map<string, LoadedPlugin>();
  private running = false;

  constructor(private readonly options: PluginHostOptions) {}

  /** Discovers, validates and activates every enabled plugin. */
  async start(): Promise<void> {
    if (this.running) await this.stop();
    this.loaded.clear();
    this.running = true;

    const config = this.options.plugins();
    if (!config.enabled) {
      this.options.log.info('plugins disabled in config.json — no plugin tools registered');
      return;
    }

    for (const def of this.options.builtins) {
      this.add(def, { ...def.manifest, permissions: normalizePermissions(def.manifest.permissions) });
    }
    if (config.allowExternal) await this.discover(config.dirs);

    for (const plugin of this.loaded.values()) {
      if (plugin.enabled) await this.activate(plugin);
    }
    this.options.log.info(
      `plugins: ${this.activeCount()} active, ${this.loaded.size - this.activeCount()} inactive`,
    );
  }

  async stop(): Promise<void> {
    for (const plugin of this.loaded.values()) {
      try {
        await plugin.def.deactivate?.();
      } catch (error) {
        this.options.log.warn(`plugin ${plugin.manifest.id}: deactivate failed: ${(error as Error).message}`);
      }
    }
    this.loaded.clear();
    this.running = false;
  }

  /** Re-reads external plugins and re-activates everything. */
  async reload(): Promise<PluginInfo[]> {
    await this.start();
    return this.info();
  }

  /** `toolDefinitions` for the agent registry — the caller supplies the reserved names. */
  toolDefinitions(reserved: Iterable<string> = this.options.reservedNames()): ToolDefinition[] {
    const taken = new Set(reserved);
    const out: ToolDefinition[] = [];
    for (const plugin of this.loaded.values()) {
      if (!plugin.enabled) continue;
      for (const tool of plugin.tools) {
        if (taken.has(tool.name)) {
          this.options.log.warn(`plugin ${plugin.manifest.id}: tool "${tool.name}" collides — skipped`);
          continue;
        }
        taken.add(tool.name);
        out.push(tool);
      }
    }
    return out;
  }

  info(): PluginInfo[] {
    return [...this.loaded.values()].map((plugin) => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      author: plugin.manifest.author,
      source: plugin.def.source,
      path: plugin.def.path,
      enabled: plugin.enabled,
      permissions: plugin.manifest.permissions ?? [],
      tools: plugin.tools.map<PluginToolInfo>((tool) => ({
        name: tool.name,
        description: tool.description,
        mutating: tool.mutating,
      })),
      error: plugin.error,
    }));
  }

  /** Enables or disables one plugin. The config write is the caller's job. */
  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo[]> {
    const plugin = this.loaded.get(id);
    if (!plugin) throw new Error(`unknown plugin: ${id}`);
    if (enabled === plugin.enabled) return this.info();
    if (enabled) {
      plugin.enabled = true;
      await this.activate(plugin);
    } else {
      plugin.enabled = false;
      plugin.tools = [];
      plugin.error = undefined;
      try {
        await plugin.def.deactivate?.();
      } catch (error) {
        this.options.log.warn(`plugin ${id}: deactivate failed: ${(error as Error).message}`);
      }
    }
    return this.info();
  }

  private activeCount(): number {
    return [...this.loaded.values()].filter((plugin) => plugin.enabled).length;
  }

  private add(def: PluginDefinition, manifest: PluginManifest): void {
    if (this.loaded.has(manifest.id)) {
      this.options.log.warn(`plugin "${manifest.id}" is already loaded — ignoring the duplicate`);
      return;
    }
    const config = this.options.plugins();
    this.loaded.set(manifest.id, {
      def,
      manifest,
      tools: [],
      enabled: !config.disabled.includes(manifest.id),
    });
  }

  /**
   * External plugins: `<dir>/<id>/plugin.json` plus a CommonJS entry point. They run
   * in-process, which is exactly why `allowExternal` is a separate switch and every call
   * they make is permission-checked.
   */
  private async discover(dirs: string[]): Promise<void> {
    const roots = dirs.length ? dirs : [paths().plugins];
    for (const root of roots) {
      const dir = resolve(root);
      if (!existsSync(dir)) continue;
      let entries: string[];
      try {
        entries = (await readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch (error) {
        this.options.log.warn(`plugins: cannot read ${dir}: ${(error as Error).message}`);
        continue;
      }
      for (const name of entries.sort()) {
        const pluginDir = join(dir, name);
        try {
          const def = await loadExternalPlugin(pluginDir);
          this.add(def, { ...def.manifest, permissions: normalizePermissions(def.manifest.permissions) });
        } catch (error) {
          this.options.log.warn(`plugins: ${pluginDir} skipped: ${(error as Error).message}`);
        }
      }
    }
  }

  private async activate(plugin: LoadedPlugin): Promise<void> {
    plugin.tools = [];
    plugin.error = undefined;
    if (plugin.def.manifest.api && plugin.def.manifest.api !== PLUGIN_API_VERSION) {
      plugin.error = `built against plugin api ${plugin.def.manifest.api}, this build speaks ${PLUGIN_API_VERSION}`;
      this.options.log.warn(`plugin ${plugin.manifest.id}: ${plugin.error}`);
      return;
    }
    try {
      await plugin.def.activate(this.createApi(plugin));
    } catch (error) {
      plugin.tools = [];
      plugin.error = (error as Error).message;
      this.options.log.error(`plugin ${plugin.manifest.id} failed to activate: ${plugin.error}`);
    }
  }

  private createApi(plugin: LoadedPlugin): PluginApi {
    const id = plugin.manifest.id;
    const declared = new Set(plugin.manifest.permissions ?? []);
    const require = (permission: PluginPermission, what: string): void => {
      if (!declared.has(permission)) {
        throw new Error(`plugin "${id}" did not declare "${permission}" in its manifest — cannot ${what}`);
      }
    };

    return {
      manifest: plugin.manifest,
      log: {
        info: (message) => this.options.log.info(`[${id}] ${message}`),
        warn: (message) => this.options.log.warn(`[${id}] ${message}`),
        error: (message) => this.options.log.error(`[${id}] ${message}`),
      },
      registerTool: (tool) => {
        if (!TOOL_NAME.test(tool.name)) {
          throw new Error(`tool name "${tool.name}" must match ${TOOL_NAME}`);
        }
        if (RESERVED_PREFIXES.some((prefix) => tool.name.startsWith(prefix))) {
          throw new Error(`tool name "${tool.name}" uses a reserved prefix`);
        }
        if (plugin.tools.some((existing) => existing.name === tool.name)) {
          throw new Error(`plugin "${id}" registered "${tool.name}" twice`);
        }
        plugin.tools.push(this.wrap(plugin, tool));
      },
      fs: {
        resolve: (ctx, path) => (isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path)),
        readText: async (ctx, path) => {
          require('files:read', 'read files');
          return readFile(this.guard(plugin, ctx, path, false), 'utf8');
        },
        readBuffer: async (ctx, path) => {
          require('files:read', 'read files');
          return readFile(this.guard(plugin, ctx, path, false));
        },
        writeText: async (ctx, path, text) => {
          require('files:write', 'write files');
          const abs = this.guard(plugin, ctx, path, true);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, text, 'utf8');
          return abs;
        },
        writeBuffer: async (ctx, path, data) => {
          require('files:write', 'write files');
          const abs = this.guard(plugin, ctx, path, true);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, data);
          return abs;
        },
      },
      host: {
        call: (async <M extends PluginHostMethod>(method: M, params: unknown): Promise<unknown> => {
          const permission = HOST_METHOD_PERMISSION[method];
          if (!permission) throw new Error(`plugin "${id}" may not call host method "${String(method)}"`);
          require(permission, `call ${String(method)}`);
          const call = this.options.hostCall();
          if (!call) {
            throw new Error('the desktop host is not attached — host methods need the Electron app');
          }
          this.options.audit().record({
            action: 'plugin',
            tool: method,
            target: id,
            outcome: 'allowed',
            detail: JSON.stringify(params).slice(0, 500),
          });
          return call(method, params as never);
        }) as PluginApi['host']['call'],
      },
    };
  }

  /** Applies the file policy and audits the decision, exactly like the file tools. */
  private guard(plugin: LoadedPlugin, ctx: ToolContext, target: string, write: boolean): string {
    const abs = isAbsolute(target) ? resolve(target) : resolve(ctx.cwd, target);
    const decision = this.options.policy().evaluateFile(abs, write, ctx.workspaceRoots);
    if (!decision.allowed) {
      this.options.audit().record({
        sessionId: ctx.sessionId,
        action: write ? 'file-write' : 'file-read',
        target: abs,
        outcome: 'denied',
        detail: decision.reason ?? `plugin ${plugin.manifest.id}`,
      });
      throw new Error(decision.reason ?? `access to ${abs} is not permitted by policy`);
    }
    return abs;
  }

  /** Forces the plugin group and turns a throw into an in-band tool failure. */
  private wrap(plugin: LoadedPlugin, tool: ToolDefinition): ToolDefinition {
    const id = plugin.manifest.id;
    return {
      ...tool,
      group: 'plugins',
      handler: async (args, ctx): Promise<ToolResult> => {
        try {
          const result = await tool.handler(args, ctx);
          return { ...result, meta: { plugin: id, ...result.meta } };
        } catch (error) {
          return {
            content: `Plugin "${id}" failed in ${tool.name}: ${(error as Error).message}`,
            failed: true,
            meta: { plugin: id },
          };
        }
      },
    };
  }
}

/* ---------------------------------------------------------------- external */

/** Reads `<dir>/plugin.json` and requires the entry point it names. */
export async function loadExternalPlugin(dir: string): Promise<PluginDefinition> {
  const manifestPath = join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) throw new Error('no plugin.json');
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<PluginManifest> & { main?: string };
  const manifest = normalizeManifest(raw, dir);

  const candidates = [raw.main, 'plugin.js', 'index.js', 'plugin.cjs'].filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
  const entry = candidates.map((name) => resolve(dir, name)).find((file) => existsSync(file));
  if (!entry) throw new Error('no entry point (plugin.js / index.js)');
  if (!entry.startsWith(resolve(dir))) throw new Error('entry point escapes the plugin directory');

  const requireFrom = createRequire(join(dir, 'noop.cjs'));
  const loaded = requireFrom(entry) as PluginModule | { default: PluginModule };
  const mod = (loaded && typeof (loaded as PluginModule).activate === 'function'
    ? loaded
    : (loaded as { default?: PluginModule }).default) as PluginModule | undefined;
  if (!mod || typeof mod.activate !== 'function') throw new Error('entry point does not export activate()');

  return {
    manifest,
    source: 'user',
    path: dir,
    activate: (api) => mod.activate(api),
    deactivate: mod.deactivate ? () => mod.deactivate?.() : undefined,
  };
}

/** Validates a manifest read from disk or from a builtin definition. */
export function normalizeManifest(raw: Partial<PluginManifest>, where: string): PluginManifest {
  const id = String(raw.id ?? '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) {
    throw new Error(`invalid plugin id "${raw.id ?? ''}" — use kebab-case, 2-40 chars (${where})`);
  }
  const name = String(raw.name ?? id).trim() || id;
  const version = String(raw.version ?? '0.0.0').trim();
  return {
    id,
    name,
    version,
    description: String(raw.description ?? '').trim(),
    author: raw.author ? String(raw.author) : undefined,
    api: typeof raw.api === 'number' ? raw.api : PLUGIN_API_VERSION,
    permissions: normalizePermissions(raw.permissions),
  };
}

function normalizePermissions(input: unknown): PluginPermission[] {
  if (!Array.isArray(input)) return [];
  const out: PluginPermission[] = [];
  for (const value of input) {
    if (typeof value !== 'string') continue;
    const permission = value.trim() as PluginPermission;
    if (PLUGIN_PERMISSIONS.includes(permission) && !out.includes(permission)) out.push(permission);
  }
  return out;
}
