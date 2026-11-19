import type { HostRequests } from '../shared/browser';
import type { PluginPermission } from '../shared/protocol';
import type { ToolContext, ToolDefinition, ToolResult } from '../shared/tools';

/**
 * The plugin contract.
 *
 * A plugin is a small object with a manifest and an `activate` function: it registers
 * tools on the agent and reaches the outside world only through `api.fs` / `api.host`,
 * which are gated by the permissions declared in the manifest. Builtin plugins are
 * bundled with the build (src/plugins/builtin); user plugins are plain CommonJS modules
 * in `~/.beecode/plugins/<id>/` and need no build step.
 *
 * Keep this file free of Electron and service imports — external plugins load it as-is.
 */

/** Bumped when the contract changes in a way that breaks existing plugins. */
export const PLUGIN_API_VERSION = 1;

/** Every permission a manifest may ask for. Anything else is dropped at load time. */
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'files:read',
  'files:write',
  'pdf:view',
  'pdf:render',
] as const;

/** Host methods a plugin may reach, each gated by the permission listed below. */
export interface PluginHostMethods {
  'pdf/open': HostRequests['pdf/open'];
  'pdf/render': HostRequests['pdf/render'];
}

export type PluginHostMethod = keyof PluginHostMethods;

/** The permission a plugin must declare before it may call a host method. */
export const HOST_METHOD_PERMISSION: Record<PluginHostMethod, PluginPermission> = {
  'pdf/open': 'pdf:view',
  'pdf/render': 'pdf:render',
};

export interface PluginManifest {
  /** kebab-case and stable: keys the toggle in config.json and the audit trail. */
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Contract version the plugin was written against (defaults to PLUGIN_API_VERSION). */
  api?: number;
  /** Everything outside the plugin's own state must be declared here. */
  permissions?: PluginPermission[];
}

/** Permission-gated file access — the same policy the built-in file tools obey. */
export interface PluginFsApi {
  /** Absolute path for `path`, resolved against the session cwd. */
  resolve(ctx: ToolContext, path: string): string;
  readText(ctx: ToolContext, path: string): Promise<string>;
  readBuffer(ctx: ToolContext, path: string): Promise<Buffer>;
  writeText(ctx: ToolContext, path: string, text: string): Promise<string>;
  writeBuffer(ctx: ToolContext, path: string, data: Buffer): Promise<string>;
}

/** Permission-gated access to the Electron host. */
export interface PluginHostApi {
  call<M extends PluginHostMethod>(
    method: M,
    params: PluginHostMethods[M]['params'],
  ): Promise<PluginHostMethods[M]['result']>;
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginApi {
  readonly manifest: Readonly<PluginManifest>;
  readonly log: PluginLogger;
  /** Adds a tool to the agent catalogue. Names are global — collisions are rejected. */
  registerTool(tool: ToolDefinition): void;
  readonly fs: PluginFsApi;
  readonly host: PluginHostApi;
}

/** A plugin as the host knows it: manifest plus the activation hooks. */
export interface PluginDefinition {
  manifest: PluginManifest;
  source: 'builtin' | 'user';
  /** Directory a user plugin was loaded from. */
  path?: string;
  activate(api: PluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Shape an external `plugin.js` must export. */
export interface PluginModule {
  activate(api: PluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/* ------------------------------------------------------------------ results */

/** Convenience helpers so plugins never build a ToolResult by hand. */
export function okResult(content: string, meta?: Record<string, unknown>): ToolResult {
  return meta ? { content, meta } : { content };
}

export function failResult(content: string, meta?: Record<string, unknown>): ToolResult {
  return meta ? { content, failed: true, meta } : { content, failed: true };
}
