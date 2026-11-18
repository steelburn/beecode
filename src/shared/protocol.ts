/**
 * Wire protocol shared by the renderer, the Electron main process and the background
 * agent service. The service speaks JSON-RPC 2.0; the payload shapes below are the
 * same objects regardless of transport (stdio for Electron, HTTP/SSE for headless use).
 */

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ primitives */

export type AgentMode = 'ask' | 'plan' | 'act' | 'autonomous';

export type SessionStatus =
  | 'idle'
  | 'thinking'
  | 'awaiting-approval'
  | 'running-tool'
  | 'aborted'
  | 'error';

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** Human-readable one-liner shown in the approval card. */
  summary: string;
  /** Why the gate fired: policy, mode, or an explicit tool declaration. */
  reason: string;
  /** Actions the UI may offer. `allow-session` persists auto-approval for the rest of the session. */
  options: Array<'allow' | 'allow-session' | 'deny'>;
  requestedAt: string;
}

export interface TranscriptEntry {
  id: string;
  role: Role;
  text: string;
  at: string;
  /** Present on assistant entries that requested tool calls. */
  toolCalls?: ToolCallRecord[];
  /** Set on `role: 'tool'` entries. */
  toolCallId?: string;
  toolName?: string;
  /** JSON-stringified tool result, already truncated for display. */
  toolResult?: string;
  /** Marks a tool entry that failed, so the UI can style it. */
  failed?: boolean;
  /** Set when this assistant turn was interleaved with reasoning text. */
  reasoning?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  mode: AgentMode;
  model: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  parentSessionId?: string;
}

export interface SessionSnapshot extends SessionSummary {
  entries: TranscriptEntry[];
  pendingApproval?: ApprovalRequest;
  /** Token accounting for the header meter, when the provider reports usage. */
  usage?: { inputTokens: number; outputTokens: number };
}

/* ------------------------------------------------------------------- tools */

export interface ToolInfo {
  name: string;
  description: string;
  /** Mutating tools are gated by the approval policy. */
  mutating: boolean;
  /** Which subsystem owns the tool — used for grouping in the UI. */
  group: 'desktop' | 'files' | 'shell' | 'agents' | 'control';
  /** JSON Schema (draft-07 subset) for the tool arguments. */
  inputSchema: Record<string, unknown>;
}

/* ------------------------------------------------------------------ subagents */

export type SubagentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SubagentRunInfo {
  id: string;
  parentSessionId: string;
  /** `internal` runs a nested beeCode session; anything else is an external CLI agent. */
  agent: string;
  task: string;
  status: SubagentStatus;
  startedAt: string;
  endedAt?: string;
  /** Tail of the subagent's output stream for the monitor panel. */
  output: string;
  exitCode?: number | null;
  error?: string;
}

export interface AgentInfo {
  id: string;
  label: string;
  kind: 'internal' | 'cli';
  available: boolean;
  /** Why an agent is unavailable — e.g. missing CLI binary. */
  detail?: string;
}

/* ------------------------------------------------------------------- policy */

export type DesktopAction =
  | 'launch'
  | 'focus'
  | 'close'
  | 'read'
  | 'invoke'
  | 'click'
  | 'type'
  | 'key'
  | 'screenshot'
  | 'resize';

export const DESKTOP_ACTIONS: DesktopAction[] = [
  'launch',
  'focus',
  'close',
  'read',
  'invoke',
  'click',
  'type',
  'key',
  'screenshot',
  'resize',
];

/**
 * Bumped whenever the action set changes, so a policy file written by an older beeCode can be
 * migrated instead of silently denying the new actions for apps the user already allowed.
 */
export const POLICY_DOCUMENT_VERSION = 2;

export interface AppRule {
  /** Stable id used by tools (`desktop_*` take an `app` id). */
  id: string;
  /** Display name, e.g. "Notepad". */
  name: string;
  /** Executable file names, matched case-insensitively, e.g. ["notepad.exe"]. */
  exe: string[];
  /** Optional window-title regex; when set the rule only applies to matching windows. */
  windowTitlePattern?: string;
  /** Actions permitted for this app. Anything missing is denied. */
  actions: DesktopAction[];
  /** Extra guard: launching is only allowed from these absolute paths when set. */
  allowedPaths?: string[];
  /** When true these actions skip the interactive approval prompt (still audited). */
  autoApprove?: boolean;
}

export interface PolicyDocument {
  version: number;
  /** Anything not explicitly allowed is denied. Kept for forward compatibility. */
  defaultDecision: 'deny';
  allowedApps: AppRule[];
  /** Executables that are never allowed, even if an app rule matches. */
  deniedExe: string[];
  shell: {
    enabled: boolean;
    /** Command prefixes that may run without extra scrutiny (still approval-gated by mode). */
    allowedCommands: string[];
    /** Substrings that are always refused. */
    blocked: string[];
  };
  filesystem: {
    /** Deny reads/writes outside `allowedRoots`. */
    workspaceOnly: boolean;
    allowedRoots: string[];
    writable: boolean;
  };
  updatedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  sessionId?: string;
  tool?: string;
  action: DesktopAction | 'shell' | 'file-read' | 'file-write' | 'launch' | 'subagent';
  app?: string;
  target?: string;
  outcome: 'allowed' | 'denied' | 'approved' | 'denied-by-user' | 'cancelled' | 'failed';
  detail?: string;
}

/* ------------------------------------------------------------------- config */

export type ProviderId = 'openai' | 'anthropic' | 'azure-openai' | 'ollama' | 'openai-compatible';

export interface ModelPreset {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  /** Name of the env var holding the key — never store raw keys in config. */
  apiKeyEnv?: string;
  /**
   * Write-only. A key typed into Settings: the service moves it to secrets.json and
   * strips it before the config is persisted or returned, so it never round-trips.
   */
  apiKey?: string;
  /** Read-only, computed by the service: a key is stored or resolvable for this preset. */
  hasKey?: boolean;

  contextWindow?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
}

export interface ServiceConfig {
  /** Loopback port for the headless HTTP transport (0 = ephemeral). */
  httpPort: number;
  /** When true the Electron main process starts the service automatically. */
  autoStart: boolean;
}

export interface AgentConfig {
  defaultMode: AgentMode;
  maxSteps: number;
  /** Tool names auto-approved in `act` mode; empty means every mutating call asks. */
  autoApproveTools: string[];
  /** Working directory for file/shell tools. */
  workingDir: string;
}

export interface DesktopConfig {
  enabled: boolean;
  /** `windows` uses PowerShell + UI Automation; `mock` is for tests and CI. */
  driver: 'windows' | 'mock';
  /** Hard stop for every desktop tool when false. */
  allowInput: boolean;
}

export interface SubagentConfig {
  enabled: boolean;
  /** Cap on concurrent subagent runs. */
  maxConcurrent: number;
  /** External CLI agents; each is probed for availability at startup. */
  cliAgents: Array<{ id: string; label: string; command: string; args: string[]; enabled: boolean }>;
}

export interface BeeCodeConfig {
  version: number;
  models: ModelPreset[];
  defaultModelId: string;
  service: ServiceConfig;
  agent: AgentConfig;
  desktop: DesktopConfig;
  subagents: SubagentConfig;
}

/* ---------------------------------------------------------------- RPC types */

export interface ServiceHealth {
  ok: boolean;
  version: string;
  pid: number;
  platform: NodeJS.Platform;
  startedAt: string;
  transport: 'stdio' | 'http';
  desktopDriver: string;
  tools: number;
  sessions: number;
}

export interface HelloResult {
  protocol: number;
  health: ServiceHealth;
}

export interface PromptArgs {
  sessionId: string;
  text: string;
}

export interface ApprovalResponse {
  approvalId: string;
  decision: 'allow' | 'allow-session' | 'deny';
  reason?: string;
}

export interface DelegateArgs {
  parentSessionId: string;
  agent: string;
  task: string;
  cwd?: string;
}

/** Client → service request table. Keys are the JSON-RPC method names. */
export interface RpcRequests {
  'app.hello': { params: { clientVersion: string }; result: HelloResult };
  'service.health': { params: Record<string, never>; result: ServiceHealth };
  'service.shutdown': { params: Record<string, never>; result: { stopping: true } };
  'session.list': { params: Record<string, never>; result: SessionSummary[] };
  'session.create': {
    params: { title?: string; cwd?: string; mode?: AgentMode; model?: string; parentSessionId?: string };
    result: SessionSnapshot;
  };
  'session.get': { params: { sessionId: string }; result: SessionSnapshot };
  'session.delete': { params: { sessionId: string }; result: { deleted: true } };
  'session.prompt': { params: PromptArgs; result: { accepted: boolean } };
  'session.abort': { params: { sessionId: string }; result: { aborted: boolean } };
  'session.setMode': { params: { sessionId: string; mode: AgentMode }; result: SessionSummary };
  'session.setModel': { params: { sessionId: string; model: string }; result: SessionSummary };
  'approval.respond': { params: ApprovalResponse; result: { ok: true } };
  'policy.get': { params: Record<string, never>; result: PolicyDocument };
  'policy.set': { params: { policy: PolicyDocument }; result: PolicyDocument };
  'config.get': { params: Record<string, never>; result: BeeCodeConfig };
  'config.set': { params: { config: BeeCodeConfig }; result: BeeCodeConfig };
  'audit.list': { params: { limit?: number }; result: AuditEntry[] };
  'agents.list': { params: Record<string, never>; result: AgentInfo[] };
  'subagent.list': { params: Record<string, never>; result: SubagentRunInfo[] };
  'subagent.cancel': { params: { runId: string }; result: { cancelled: boolean } };
  'tools.list': { params: Record<string, never>; result: ToolInfo[] };
}

export type RpcMethod = keyof RpcRequests;

/* ------------------------------------------------------------- event types */

export type ServiceEvent =
  | { type: 'session.snapshot'; payload: SessionSnapshot }
  | { type: 'session.status'; payload: { sessionId: string; status: SessionStatus } }
  | { type: 'session.entry'; payload: { sessionId: string; entry: TranscriptEntry } }
  | { type: 'assistant.delta'; payload: { sessionId: string; entryId: string; text: string } }
  | { type: 'tool.call'; payload: { sessionId: string; call: ToolCallRecord } }
  | {
      type: 'tool.result';
      payload: { sessionId: string; callId: string; name: string; result: string; failed: boolean };
    }
  | { type: 'approval.request'; payload: ApprovalRequest }
  | { type: 'approval.resolved'; payload: { sessionId: string; approvalId: string; decision: string } }
  | { type: 'subagent.update'; payload: SubagentRunInfo }
  | { type: 'desktop.activity'; payload: AuditEntry }
  | { type: 'service.health'; payload: ServiceHealth }
  | { type: 'log'; payload: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; at: string } }
  | { type: 'error'; payload: { sessionId?: string; message: string } };

export type ServiceEventType = ServiceEvent['type'];

/** JSON-RPC envelope helpers — shared so both transports stay byte-compatible. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
} as const;

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return typeof (msg as JsonRpcRequest).method === 'string' && (msg as JsonRpcRequest).id !== undefined;
}
