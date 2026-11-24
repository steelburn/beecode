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
  /**
   * Absolute paths of files the user attached to this prompt. Displayed as a chip row
   * under the entry text so the attachment survives a session reload.
   */
  attachments?: string[];
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
  /**
   * Workspace root the session belongs to. Stable even when the session's working directory
   * is moved inside it, and what the session rail rolls the list up by.
   */
  workspace?: string;
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
  /** False when the user switched the tool off in Settings; it is never offered then. */
  enabled: boolean;
  /** Which subsystem owns the tool — used for grouping in the UI. */
  group:
    | 'desktop'
    | 'browser'
    | 'files'
    | 'shell'
    | 'agents'
    | 'control'
    | 'mcp'
    | 'skills'
    | 'scheduler'
    | 'plugins';
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
// v4: the bundled runtimes joined the default shell allow-list (see DEFAULT_SHELL_RUNTIMES).
export const POLICY_DOCUMENT_VERSION = 4;

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
    | 'file-delete'
    | 'file-move'
    | 'dir-create'
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
 * A shared reference folder attached to the workspace.
 *
 * Knowledge folders are deliberately NOT the workspace: the agent may read and search
 * them, but every write path is refused by the policy engine, and files only enter one
 * through an explicit user action (copy a workspace file in, or create a subfolder).
 * One workspace may reference several of them, and a folder may be shared by many
 * workspaces, which is the point: knowledge is not re-copied per project.
 */
export interface KnowledgeFolder {
  /** Absolute path of the folder root. */
  path: string;
  /** Display label; defaults to the folder name. */
  label: string;
  /** ISO timestamp of when the user added it. */
  addedAt: string;
}

/**
 * Where the user works. beeCode never defaults this to the installation
 * directory: until the user picks a folder, `root` is empty and the renderer
 * shows the workspace setup step.
 */
export interface WorkspaceConfig {
  /** Absolute path the file/shell tools are rooted at. Empty until configured. */
  root: string;
  /**
   * Read-only knowledge folders this workspace can consult. The agent may read them,
   * never write; only the user adds a folder, creates a subfolder or copies a file in.
   */
  knowledge?: KnowledgeFolder[];
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

/**
 * Per-tool switches. A name listed in `disabled` stays registered so Settings can list it
 * as off, but it is never advertised to the model and refuses to run if it is called
 * anyway — the same in-band refusal the policy engine uses.
 */
export interface ToolsConfig {
  disabled: string[];
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

/** Converted markup for a document the text preview cannot show. */
export interface FsRender {
  /** Only one shape so far: HTML converted from an Office document in the service. */
  kind: 'html';
  /** Untrusted markup — the renderer sanitises it before it reaches the DOM. */
  html: string;
  /** One line about what was left out (truncation, a missing part). */
  note?: string;
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
  /** Set when the service could convert the file (Office documents) instead of text. */
  render?: FsRender;
}

export interface WorkspaceState {
  root: string;
  recent: string[];
  /** Read-only knowledge folders attached to this workspace, in display order. */
  knowledge: KnowledgeFolder[];
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
  /** Tools the user switched off (Settings → Tools). */
  tools: ToolsConfig;
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

/**
 * Answer to `plugin.install`: what a dropped folder or archive added.
 *
 * The install copies files into the plugin root and the service reloads the host, so
 * `plugins` is the authoritative catalogue — the renderer never has to ask again.
 */
export interface PluginInstallResult {
  /** Plugin ids written under the plugin root. */
  installed: string[];
  /** Sources the service refused, each with the reason, so the card can name them. */
  skipped: { path: string; reason: string }[];
  /** True when the install switched `plugins.allowExternal` on to let them load. */
  allowExternal: boolean;
  plugins: PluginInfo[];
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

/**
 * A skill to install: the text of a `SKILL.md`, the base64 of a ZIP that carries one or
 * more skill folders, or an `https://` URL the service downloads and installs the same way.
 */
export interface SkillInstallInput {
  fileName?: string;
  /** Markdown body of a dropped `SKILL.md`. */
  text?: string;
  /** Base64 of a dropped `.zip` archive. */
  base64?: string;
  /**
   * `https://` URL of a `SKILL.md` or a skill `.zip`. The service downloads it and installs
   * it exactly like a dropped file; `http://` is accepted for a loopback host only.
   */
  url?: string;
}

export interface SkillInstallResult {
  skills: SkillInfo[];
  /** Folder names written under `<home>/skills`. */
  installed: string[];
}

/** Answer to `skill.remove`: what went away and what is left. */
export interface SkillRemoveResult {
  /** Absolute path that was deleted — the skill folder, or a flat `.md` file. */
  removed: string;
  /** The re-scanned list, so the caller never has to read the folders again. */
  skills: SkillInfo[];
}


/* ---------------------------------------------------------------- scheduler */

/** How a schedule repeats. `once` fires at `at` and then disables itself. */
export type ScheduleKind = 'once' | 'interval' | 'daily' | 'weekly';

/**
 * A user-defined agent run on a timer. The same shape backs the chat tool, the RPC
 * surface and the Scheduler panel, so a schedule edited in either place stays one object.
 */
export interface Schedule {
  id: string;
  name: string;
  /** Prompt enqueued as the first user message of the run's session. */
  prompt: string;
  kind: ScheduleKind;
  /** ISO timestamp — `once` only. */
  at?: string;
  /** Minutes between runs — `interval` only. */
  everyMinutes?: number;
  /** Local wall-clock time `HH:MM` — `daily` and `weekly`. */
  time?: string;
  /** Weekdays 0 = Sunday … 6 = Saturday — `weekly` only. */
  days?: number[];
  /** Mode the scheduled session starts in. */
  mode: AgentMode;
  /** Working directory override; unset means the configured workspace. */
  cwd?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  /** Forward-looking fire time; undefined once a `once` schedule has fired. */
  nextRunAt?: string;
  runCount: number;
  /** Short outcome of the last run ("started session …", "error: …", "missed"). */
  lastResult?: string;
}

/** Create/update payload: an `id` means update, no `id` means create. */
export interface ScheduleInput {
  id?: string;
  /** Required on create. */
  name?: string;
  /** Required on create. */
  prompt?: string;
  /**
   * Timing rule — `once:2025-04-01 09:00`, `every:30m`, `daily:09:00` or
   * `weekly:mon,thu@17:30`. Required on create; omit on update to keep the current rule.
   */
  when?: string;
  mode?: AgentMode;
  cwd?: string;
  enabled?: boolean;
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
  /**
   * Absolute paths the user attached. They are not copied anywhere: the agent is told
   * about them so it can read them with the file tools, and they are echoed on the user
   * transcript entry.
   */
  attachments?: string[];
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
  'plugin.install': { params: { paths: string[] }; result: PluginInstallResult };

  'app.hello': { params: { clientVersion: string }; result: HelloResult };
  'workspace.state': { params: Record<string, never>; result: WorkspaceState };
  'workspace.set': { params: { path: string }; result: WorkspaceState };
  'workspace.forget': { params: { path: string }; result: WorkspaceState };
  'knowledge.add': { params: { path: string; label?: string }; result: WorkspaceState };
  'knowledge.remove': { params: { path: string }; result: WorkspaceState };
  'knowledge.rename': { params: { path: string; label: string }; result: WorkspaceState };
  'knowledge.mkdir': { params: { path: string; name: string }; result: { path: string } };
  'knowledge.copy': {
    params: { from: string; to: string; overwrite?: boolean };
    result: { path: string };
  };
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
  'skill.install': { params: SkillInstallInput; result: SkillInstallResult };
  'skill.remove': { params: { name: string; cwd?: string }; result: SkillRemoveResult };

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
  'models.list': {
    params: { presetId?: string; provider?: string; baseUrl?: string; apiKeyEnv?: string; apiKey?: string };
    result: { models: string[]; warning?: string };
  };
  'config.get': { params: Record<string, never>; result: BeeCodeConfig };
  'config.set': { params: { config: BeeCodeConfig }; result: BeeCodeConfig };
  'audit.list': { params: { limit?: number }; result: AuditEntry[] };
  'agents.list': { params: Record<string, never>; result: AgentInfo[] };
  'subagent.list': { params: Record<string, never>; result: SubagentRunInfo[] };
  'subagent.cancel': { params: { runId: string }; result: { cancelled: boolean } };
  'tools.list': { params: Record<string, never>; result: ToolInfo[] };
  'scheduler.list': { params: Record<string, never>; result: { schedules: Schedule[] } };
  'scheduler.save': {
    params: ScheduleInput;
    result: { schedule: Schedule; schedules: Schedule[] };
  };
  'scheduler.remove': { params: { id: string }; result: { schedules: Schedule[] } };
  'scheduler.run': { params: { id: string }; result: { sessionId: string } };
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
  | { type: 'scheduler.changed'; payload: { schedules: Schedule[] } }
  | { type: 'desktop.activity'; payload: AuditEntry }
  | { type: 'service.health'; payload: ServiceHealth }
  /** The workspace (root, recents, knowledge folders) changed — repaint the panels. */
  | { type: 'workspace.state'; payload: WorkspaceState }
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
