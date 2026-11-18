import type { LlmToolSchema } from '../llm/types';
import type { ToolContext, ToolDefinition, ToolResult } from '../../shared/tools';
import type { ToolInfo } from '../../shared/protocol';

/** Ordered tool catalogue with a name index. */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

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
    return this.all().map((t) => ({
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
    }));
  }

  /** A restricted copy — used for read-only subagents and plan mode. */
  subset(predicate: (tool: ToolDefinition) => boolean): ToolRegistry {
    const copy = new ToolRegistry();
    for (const tool of this.all()) if (predicate(tool)) copy.register(tool);
    return copy;
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: JSON.stringify({ error: `unknown tool "${name}"`, available: this.names() }), failed: true };
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
