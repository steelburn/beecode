import type { McpServerConfig, McpServerStatus, McpToolInfo } from '../../shared/protocol';
import type { ToolContext, ToolDefinition } from '../../shared/tools';
import type { Logger } from '../logger';
import { errorResult } from '../tools/registry';
import { McpClient, type McpToolDescriptor } from './client';

/** Chat APIs cap tool names (OpenAI-compatible: 64 chars, `[a-zA-Z0-9_-]`). */
const MAX_TOOL_NAME = 64;

export interface McpManagerOptions {
  /** Read lazily so a config change needs no restart. */
  servers: () => Record<string, McpServerConfig>;
  log: Logger;
}

interface BoundTool {
  server: string;
  tool: string;
  definition: ToolDefinition;
}

/**
 * Owns the MCP server connections and projects their tools into the agent's tool
 * registry as `mcp__<server>__<tool>`.
 *
 * A server that fails to start is reported as `error` and skipped — one broken
 * MCP server never blocks the service.
 */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private statuses = new Map<string, McpServerStatus>();
  private tools = new Map<string, BoundTool>();

  constructor(private readonly options: McpManagerOptions) {}

  async start(): Promise<McpServerStatus[]> {
    const servers = this.options.servers() ?? {};
    for (const [name, config] of Object.entries(servers)) {
      await this.connect(name, config);
    }
    return this.list();
  }

  /** Drops every connection and starts over from the current config. */
  async reload(): Promise<McpServerStatus[]> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.tools.clear();
    this.statuses.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }

  list(): McpServerStatus[] {
    return [...this.statuses.values()].map((status) => ({ ...status, tools: [...status.tools] }));
  }

  /** Registered tool definitions, ready for `ToolRegistry.register(...)`. */
  toolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((bound) => bound.definition);
  }

  toolCount(): number {
    return this.tools.size;
  }

  /** The `mcp__…` name for a server tool, or undefined when it is not exposed. */
  registeredName(server: string, tool: string): string | undefined {
    const match = [...this.tools.values()].find((bound) => bound.server === server && bound.tool === tool);
    return match?.definition.name;
  }

  /** System-prompt section; empty string when no server is configured. */
  describe(): string {
    const statuses = this.list();
    if (!statuses.length) return '';

    const lines = [
      '## MCP servers',
      'Tools from external MCP servers are prefixed `mcp__<server>__<tool>`. Any tool not',
      'marked read-only asks for approval, exactly like the built-in mutating tools.',
      '',
    ];
    for (const status of statuses) {
      if (status.state === 'disabled') {
        lines.push(`- ${status.name} (disabled)`);
        continue;
      }
      if (status.state === 'error') {
        lines.push(`- ${status.name} (unavailable: ${status.error ?? 'unknown error'})`);
        continue;
      }
      const names = status.tools.map((tool) => tool.tool);
      lines.push(`- ${status.name} (${status.serverName ?? status.name}): ${names.join(', ') || 'no tools'}`);
    }
    return lines.join('\n');
  }

  private async connect(name: string, config: McpServerConfig): Promise<void> {
    const status: McpServerStatus = {
      name,
      enabled: config.enabled !== false,
      transport: config.transport === 'http' ? 'http' : 'stdio',
      state: 'disabled',
      tools: [],
    };
    this.statuses.set(name, status);
    if (!status.enabled) return;

    status.state = 'starting';
    const client = new McpClient(name, config, this.options.log);
    try {
      await client.connect();
      const descriptors = await client.listTools();
      this.clients.set(name, client);
      status.state = 'connected';
      status.serverName = client.info.name;
      status.version = client.info.version;
      status.tools = descriptors.map((descriptor) => this.bind(name, client, descriptor));
      this.options.log.info('mcp server connected', {
        server: name,
        version: client.info.version,
        tools: status.tools.length,
      });
    } catch (err) {
      status.state = 'error';
      status.error = err instanceof Error ? err.message : String(err);
      this.options.log.warn('mcp server unavailable', { server: name, error: status.error });
      await client.close().catch(() => undefined);
    }
  }

  private bind(server: string, client: McpClient, descriptor: McpToolDescriptor): McpToolInfo {
    const registered = this.uniqueName(server, descriptor.name);
    const definition: ToolDefinition = {
      name: registered,
      description: `[mcp:${server}] ${descriptor.description}`,
      mutating: !descriptor.readOnly,
      group: 'mcp',
      inputSchema: descriptor.inputSchema,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        try {
          const result = await client.callTool(descriptor.name, args ?? {}, ctx.signal);
          if (result.isError) {
            return errorResult(result.text || `${server}.${descriptor.name} failed`, { server, tool: descriptor.name });
          }
          return {
            content: result.text || '(no content)',
            meta: { server, tool: descriptor.name },
          };
        } catch (err) {
          // A dead server is reported in-band so the model can adapt instead of looping.
          return errorResult(
            `mcp ${server}: ${err instanceof Error ? err.message : String(err)}`,
            { server, tool: descriptor.name },
          );
        }
      },
      summarize: () => `${server}: ${descriptor.name}`,
    };

    this.tools.set(registered, { server, tool: descriptor.name, definition });
    return {
      server,
      name: descriptor.name,
      tool: registered,
      description: descriptor.description,
      mutating: definition.mutating,
    };
  }

  /**
   * Two servers (or a server with oddly-named tools) can sanitize to the same
   * registered name; the registry rejects duplicates, so make each one unique.
   */
  private uniqueName(server: string, tool: string): string {
    const base = toolName(server, tool);
    if (!this.tools.has(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
      const tail = `_${suffix}`;
      const candidate = `${base.slice(0, MAX_TOOL_NAME - tail.length)}${tail}`;
      if (!this.tools.has(candidate)) return candidate;
    }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function toolName(server: string, tool: string): string {
  const raw = `mcp__${sanitize(server)}__${sanitize(tool)}`;
  if (raw.length <= MAX_TOOL_NAME) return raw;
  const suffix = `_${hash(raw).toString(36)}`;
  return `${raw.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
}

/** djb2 — only used to keep an over-long tool name unique. */
function hash(value: string): number {
  let result = 5381;
  for (let index = 0; index < value.length; index += 1) {
    result = ((result << 5) + result + value.charCodeAt(index)) | 0;
  }
  return Math.abs(result);
}
