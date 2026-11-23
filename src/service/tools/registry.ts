import type { LlmToolSchema } from '../llm/types';
import type { ToolContext, ToolDefinition, ToolResult } from '../../shared/tools';
import type { ToolInfo } from '../../shared/protocol';

/**
 * Tool groups that cannot work without a filesystem root. Without a workspace they are
 * refused in-band: resolving a relative path against the process directory would make
 * the installation folder the agent's workspace, which the product never does.
 */
const WORKSPACE_GROUPS = new Set(['files', 'shell']);

/** Ordered tool catalogue with a name index. */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  /**
   * Names the user switched off in Settings → Tools. They stay in the catalogue so the
   * settings list can offer them back, but they are neither advertised to the model nor
   * callable: `schemas()` drops them and `execute()` refuses in-band.
   */
  private disabled = new Set<string>();

  /**
   * Applies the per-tool switches without deleting entries, so `info()` can still report
   * the whole catalogue with an `enabled` flag.
   */
  setDisabled(names: Iterable<string>): this {
    this.disabled = new Set(names);
    return this;
  }

  isEnabled(name: string): boolean {
    return !this.disabled.has(name);
  }

  /** The names the model may actually call — switched-off tools are filtered out. */
  enabledNames(): string[] {
    return this.names().filter((name) => !this.disabled.has(name));
  }

  register(...defs: ToolDefinition[]): this {
    for (const def of defs) {
      if (this.tools.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`);
      this.tools.set(def.name, def);
    }
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  schemas(): LlmToolSchema[] {
    return this.all()
      .filter((t) => !this.disabled.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }));
  }

  info(): ToolInfo[] {
    return this.all().map((t) => ({
      name: t.name,
      description: t.description,
      mutating: t.mutating,
      group: t.group,
      inputSchema: t.inputSchema,
      enabled: !this.disabled.has(t.name),
    }));
  }

  /**
   * A restricted copy — used for read-only subagents and plan mode. The per-tool switches
   * travel with it, so a switched-off tool cannot come back through a subagent.
   */
  subset(predicate: (tool: ToolDefinition) => boolean): ToolRegistry {
    const copy = new ToolRegistry();
    for (const tool of this.all()) if (predicate(tool)) copy.register(tool);
    return copy.setDisabled(this.disabled);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: JSON.stringify({
          error: `unknown tool "${name}"`,
          available: this.enabledNames(),
        }),
        failed: true,
      };
    }
    if (this.disabled.has(name)) {
      return {
        content: JSON.stringify({
          error: `tool "${name}" is switched off in beeCode — ask the user to enable it in Settings → Tools`,
          tool: name,
          disabled: true,
        }),
        failed: true,
      };
    }
    if (!ctx.cwd && WORKSPACE_GROUPS.has(tool.group)) {
      return {
        content: JSON.stringify({
          error:
            'no workspace folder is selected — ask the user to choose one in beeCode before using file or shell tools',
          tool: name,
          needsWorkspace: true,
        }),
        failed: true,
      };
    }
    try {
      return await tool.handler(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: JSON.stringify({ error: message, tool: name }), failed: true };
    }
  }
}

/** Standard success payload: always JSON so the model sees a stable shape. */
export function jsonResult(payload: unknown, meta?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify(payload, null, 0), meta };
}

/** Standard failure payload — never thrown, always returned in-band (ado-code convention). */
export function errorResult(message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error: message, ...extra }), failed: true };
}

export function str(args: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  const value = args[key];
  if (typeof value === 'string' && value.length) return value;
  return fallback;
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function requireStr(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (!value) throw new Error(`missing required argument "${key}"`);
  return value;
}
