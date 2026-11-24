import { homedir } from 'node:os';
import { join } from 'node:path';

/** Options shared by every tool implementation. */
export interface ToolContext {
  sessionId: string;
  cwd: string;
  mode: import('./protocol').AgentMode;
  /** Absolute directory that file tools may not escape when the policy is workspace-only. */
  workspaceRoots: string[];
  signal: AbortSignal;
  /** Set for nested (subagent) sessions — restricts the toolset. */
  parentSessionId?: string;
  /** Nesting depth, used to stop recursive delegation. */
  depth: number;
}

export interface ToolResult {
  /** Text handed back to the model. Tool failures are reported in-band, never thrown. */
  content: string;
  failed?: boolean;
  /** Structured extras for the UI (not sent to the model). */
  meta?: Record<string, unknown>;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolPreview {
  /** True when the run must be confirmed by the user before executing. */
  requiresApproval: boolean;
  /** One-line description for the approval card. */
  summary: string;
  /** Why the gate fired (policy, mode, blast radius). */
  reason: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  mutating: boolean;
  group:
    | 'desktop'
    | 'browser'
    | 'files'
    | 'shell'
    | 'agents'
    | 'control'
    | 'mcp'
    | 'skills'
    | 'slate'
    | 'scheduler'
    | 'plugins';
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  /**
   * Optional dry-run used by the approval gate: it decides whether the user must
   * confirm and produces the card text — without performing any side effect.
   */
  preview?: (args: Record<string, unknown>, ctx: ToolContext) => ToolPreview | Promise<ToolPreview>;
  /** Optional human summary used on the approval card. */
  summarize?: (args: Record<string, unknown>) => string;
}

/** Root for all beeCode state (config, policy, audit, sessions, logs). */
export function beeCodeHome(): string {
  return process.env.BEECODE_HOME ?? join(homedir(), '.beecode');
}

export function paths() {
  const home = beeCodeHome();
  return {
    home,
    config: join(home, 'config.json'),
    secrets: join(home, 'secrets.json'),

    policy: join(home, 'policy.json'),
    audit: join(home, 'audit.jsonl'),
    sessions: join(home, 'sessions'),
    logs: join(home, 'logs'),
    plugins: join(home, 'plugins'),
  };
}
