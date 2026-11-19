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

/**
 * A button the transcript offers next to an entry. The service states which action
 * applies and with which numbers; the renderer owns the wording.
 */
export type TranscriptAction = {
  kind: 'raise-max-steps';
  current: number;
  next: number;
};

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
  /** Buttons the transcript offers next to this entry. */
  actions?: TranscriptAction[];
  /** Set when this assistant turn was interleaved with reasoning text. */
  reasoning?: string;
}

/**
 * The session's stated objective. Mirrors the goal ADO Code keeps: one short
 * outcome line that survives turn-to-turn until the user or the agent changes it.
 */
export interface SessionGoal {
  text: string;
  createdAt: string;
  updatedAt: string;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One step of the session's working plan. */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  /** Present-participle label shown while the item is in progress. */
  activeForm?: string;
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
  /** Stated objective, when the goal/to-do feature is on. */
  goal?: SessionGoal;
}

export interface SessionSnapshot extends SessionSummary {
  entries: TranscriptEntry[];
  pendingApproval?: ApprovalRequest;
  /** Token accounting for the header meter, when the provider reports usage. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Current working plan (goal/to-do feature); absent when the feature is off. */
  todos?: TodoItem[];
  /** True when this snapshot was rehydrated from disk rather than kept in memory. */
  restored?: boolean;
}

/* ------------------------------------------------------------------- tools */

export interface ToolInfo {
  name: string;
  description: string;
  /** Mutating tools are gated by the approval policy. */
  mutating: boolean;
  /** Which subsystem owns the tool — used for grouping in the UI. */
  group: 'desktop' | 'browser' | 'files' | 'shell' | 'agents' | 'control' | 'mcp' | 'skills' | 'plugins';
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
  /** CLI command probed for `kind: 'cli'` agents. */
  command?: string;
  /** Flags the CLI runs with (a preset's flags are what make its run one-shot). */
  args?: string[];
  /** Version reported by the CLI when it answers `--version`. */
  version?: string;
  /** True when the binary was found on PATH during the last detection pass. */
  onPath?: boolean;
  /** True for agents the user added by hand instead of a built-in preset. */
  custom?: boolean;
  /** Config flag; an unavailable agent is still listed so it can be fixed. */
  enabled?: boolean;
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
export const POLICY_DOCUMENT_VERSION = 3;

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

/**
 * Rules for the internal (sandboxed) browser.
 *
 * Deny beats allow; `allowedHosts` only applies when `allowAnyHost` is false, and
 * `about:blank` is always reachable so the agent can open an empty tab to start from.
 */
export interface BrowserPolicy {
  /** Master switch — when false every `browser_*` tool refuses to run. */
  enabled: boolean;
  /** When true any http(s) host is reachable (still audited). */
  allowAnyHost: boolean;
  /** Host suffixes the agent may visit, e.g. `['github.com', '*.microsoft.com']`. */
  allowedHosts: string[];
  /** Host suffixes that are never reachable, even under a wildcard allow. */
  deniedHosts: string[];
  /** Permit typing into pages and clicking elements (i.e. submitting forms). */
  allowInput: boolean;
  /** Ask the user before every interacting action, not just the first page load. */
  requireApproval: boolean;
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
  browser: BrowserPolicy;
  updatedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  sessionId?: string;
  tool?: string;
  action:
    | DesktopAction
    | 'shell'
    | 'file-read'
    | 'file-write'
    | 'launch'
    | 'subagent'
    | 'browser'
    | 'plugin';
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

export interface BrowserConfig {
  /** Opt out of the internal browser entirely (`browser_*` tools then report it disabled). */
  enabled: boolean;
  /** Hard cap on open tabs; opening one more closes the least recently used tab. */
  maxTabs: number;
  /** Page opened by `browser_open` when no url is given. */
  homeUrl: string;
  /** Keep cookies and storage between runs. Off by default: an ephemeral session. */
  persistSession: boolean;
  /** Draw the AI cursor overlay while the agent drives a page. */
  showCursor: boolean;
  /** Let pages run scripts. Off turns the browser into a text-only viewer. */
  allowScripts: boolean;
}

/** One external coding-agent CLI as persisted in config.json. */
export interface CliAgentEntry {
  id: string;
  label: string;
  command: string;
  args: string[];
  enabled: boolean;
  /** Added by the user rather than seeded from a built-in preset. */
  custom?: boolean;
}

export interface SubagentConfig {
  enabled: boolean;
  /** Cap on concurrent subagent runs. */
  maxConcurrent: number;
  /** External CLI agents; each is probed for availability at startup. */
  cliAgents: CliAgentEntry[];
}

/**
 * Where the user works. beeCode never defaults this to the installation
 * directory: until the user picks a folder, `root` is empty and the renderer
 * shows the workspace setup step.
 */
export interface WorkspaceConfig {
  /** Absolute path the file/shell tools are rooted at. Empty until configured. */
  root: string;
  /** Most-recently used roots, newest first (capped at 8). */
  recent: string[];
  /** Reopen the newest session of `root` on start when true. */
  restoreSession?: boolean;
}

/** Optional product surfaces the user can switch off. */
export interface FeaturesConfig {
  /** Goal + to-do planning tools and the panel above the composer. */
  goalTodo: boolean;
}

/** One entry of a directory listing in the workspace explorer. */
export interface FsEntry {
  name: string;
  /** Absolute path, so the renderer never has to join paths itself. */
  path: string;
  dir: boolean;
  /** Byte size for files. Directories and unreadable entries leave it out. */
  size?: number;
  /** True for a symlink — shown as such, never followed by the explorer. */
  link?: boolean;
}

/** A directory as the workspace explorer sees it. */
export interface FsListing {
  path: string;
  /** Parent directory, absent when the listed directory is a workspace root. */
  parent?: string;
  entries: FsEntry[];
  /** True when the directory held more entries than the service returns. */
  truncated: boolean;
}

/** A file preview: text when it is text, a binary flag when it is not. */
export interface FsFile {
  path: string;
  name: string;
  size: number;
  /** True when the file was clipped to the preview budget. */
  truncated: boolean;
  /** True when the content is not text; `text` is then empty. */
  binary: boolean;
  text: string;
}

export interface WorkspaceState {
  root: string;
  recent: string[];
  /** False while the user has not picked a workspace yet (first-run setup). */
  configured: boolean;
}

export interface BeeCodeConfig {
  version: number;
  models: ModelPreset[];
  defaultModelId: string;
  service: ServiceConfig;
  agent: AgentConfig;
  desktop: DesktopConfig;
  browser: BrowserConfig;
  subagents: SubagentConfig;
  /** External MCP servers whose tools are exposed to the agent. */
  mcpServers: Record<string, McpServerConfig>;
  skills: SkillsConfig;
  plugins: PluginsConfig;
  workspace: WorkspaceConfig;
  features: FeaturesConfig;
}

/* ------------------------------------------------------------ mcp & skills */

/** One external MCP server. Disabled servers are listed but never started. */
export interface McpServerConfig {
  enabled: boolean;
  /** `stdio` spawns `command`; `http` speaks streamable HTTP to `url`. */
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  /** Extra environment variables for the stdio child, merged over process.env. */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs: number;
}

/** A tool exposed by an MCP server, as registered in beeCode's tool registry. */
export interface McpToolInfo {
  server: string;
  /** Tool name as the server publishes it. */
  name: string;
  /** Registered tool name (`mcp__<server>__<tool>`). */
  tool: string;
  description: string;
  mutating: boolean;
}

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  state: 'starting' | 'connected' | 'error' | 'disabled';
  /** Server identity reported during `initialize`. */
  serverName?: string;
  version?: string;
  tools: McpToolInfo[];
  error?: string;
}

/** A SKILL.md playbook found on disk. */
export interface SkillInfo {
  name: string;
  description: string;
  /** `user` = ~/.beecode/skills, `project` = the workspace or a configured dir. */
  source: 'user' | 'project';
  path: string;
}

/** What a plugin may reach outside its own state; declared in its manifest. */
export type PluginPermission = 'files:read' | 'files:write' | 'pdf:view' | 'pdf:render';

export interface PluginsConfig {
  /** Master switch: off registers no plugin tools at all. */
  enabled: boolean;
  /** Load plugins from `dirs`. Off keeps only the bundled starters. */
  allowExternal: boolean;
  /** Plugin roots; relative paths resolve against the working directory. Empty = ~/.beecode/plugins. */
  dirs: string[];
  /** Plugin ids that are loaded but left inactive. */
  disabled: string[];
}

export interface PluginToolInfo {
  name: string;
  description: string;
  mutating: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** `builtin` ships with the build; `user` comes from a plugin directory. */
  source: 'builtin' | 'user';
  /** Directory a user plugin was loaded from. */
  path?: string;
  enabled: boolean;
  permissions: PluginPermission[];
  tools: PluginToolInfo[];
  /** Set when discovery or activation failed. */
  error?: string;
}

export interface SkillsConfig {
  enabled: boolean;
  /** Extra skill roots; relative paths resolve against the working directory. */
  dirs: string[];
  /** Cap on a single skill file, in bytes. */
  maxBytes: number;
}

export interface McpListResult {
  servers: McpServerStatus[];
}

export interface SkillListResult {
  skills: SkillInfo[];
}

export interface SkillReadResult {
  skill: SkillInfo;
  content: string;
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
  'plugin.list': { params: Record<string, never>; result: { plugins: PluginInfo[] } };
  'plugin.reload': { params: Record<string, never>; result: { plugins: PluginInfo[] } };
  'plugin.setEnabled': { params: { id: string; enabled: boolean }; result: { plugins: PluginInfo[] } };
  'app.hello': { params: { clientVersion: string }; result: HelloResult };
  'workspace.state': { params: Record<string, never>; result: WorkspaceState };
  'workspace.set': { params: { path: string }; result: WorkspaceState };
  'workspace.forget': { params: { path: string }; result: WorkspaceState };
  'fs.list': { params: { path?: string }; result: FsListing };
  'fs.read': { params: { path: string }; result: FsFile };
  'goal.set': { params: { sessionId: string; text: string }; result: SessionSnapshot };
  'goal.clear': { params: { sessionId: string }; result: SessionSnapshot };
  'todo.list': { params: { sessionId: string }; result: { todos: TodoItem[] } };
  'agents.detect': { params: { probe?: boolean }; result: { agents: AgentInfo[] } };
  'agents.save': { params: { agents: CliAgentEntry[] }; result: { agents: AgentInfo[] } };
  'service.health': { params: Record<string, never>; result: ServiceHealth };
  'service.shutdown': { params: Record<string, never>; result: { stopping: true } };
  'mcp.list': { params: Record<string, never>; result: McpListResult };
  'mcp.reload': { params: Record<string, never>; result: McpListResult };
  'skill.list': { params: { cwd?: string }; result: SkillListResult };
  'skill.reload': { params: { cwd?: string }; result: SkillListResult };
  'skill.read': { params: { name: string; cwd?: string }; result: SkillReadResult };
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
  'session.setCwd': { params: { sessionId: string; cwd: string }; result: SessionSummary };
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
      payload: { sessionId: string; callId: string; name: string; result: string; failed: boolean; meta?: Record<string, unknown> };
    }
  | { type: 'approval.request'; payload: ApprovalRequest }
  | { type: 'approval.resolved'; payload: { sessionId: string; approvalId: string; decision: string } }
  | { type: 'subagent.update'; payload: SubagentRunInfo }
  | { type: 'session.goal'; payload: { sessionId: string; goal?: SessionGoal } }
  | { type: 'session.todos'; payload: { sessionId: string; todos: TodoItem[] } }
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
