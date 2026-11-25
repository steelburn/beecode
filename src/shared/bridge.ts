import type { BrowserPanelApi } from './browser';
import type { SlateLiveBounds, SlateLiveState } from './slateSandbox';
import type { TerminalApi } from './terminal';
import type {
  BeeCodeConfig,
  PolicyDocument,
  RpcMethod,
  RpcRequests,
  ServiceEvent,
  ServiceHealth,
} from './protocol';

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: NodeJS.Platform;
  workspace: string;
  home: string;
  servicePid?: number;
}

/** Options for the native folder picker behind `pickDirectory`. */
export interface DirectoryPickerOptions {
  title?: string;
  /** Folder the dialog opens in; defaults to the app workspace. */
  defaultPath?: string;
}

/**
 * One application found on this computer, for the picker in the permission editor. The
 * name is what the user recognises (the Start Menu entry); the executable is the only
 * thing the policy can actually match on.
 */
export interface InstalledApp {
  /** Name shown in the list, e.g. "Microsoft Excel". */
  name: string;
  /** Program file name the policy matches, e.g. `excel.exe` (lower-cased). */
  exe: string;
  /** Full path of the program file, kept apart from the name only as a tooltip. */
  path?: string;
}

/** Options for the native save dialog behind `saveFile`. */
export interface SaveFileOptions {
  /** File name the dialog opens with — the tab already knows a sensible one. */
  suggestedName: string;
  /** UTF-8 text written to the chosen path. */
  content: string;
  /** Dialog title; defaults to `Save file`. */
  title?: string;
}

/** What `saveFile` did. A cancelled dialog is not an error. */
export interface SaveFileResult {
  saved: boolean;
  /** The path that was written, when `saved` is true. */
  path?: string;
}

/** Options for the native file picker behind `pickFiles`. */
export interface FilePickerOptions {
  title?: string;
  /** Folder the dialog opens in; defaults to the app workspace. */
  defaultPath?: string;
  /** Allow more than one file; defaults to true. */
  multiple?: boolean;
  /** Extension filter without dots, e.g. `['zip']`; omitted means every file. */
  extensions?: string[];
}

/** One file (or folder) copied into the workspace by a drag-and-drop. */
export interface CopiedFile {
  /** Absolute source path. */
  from: string;
  /** Destination path relative to the workspace root. */
  to: string;
}

/** Best-effort result of copying dropped paths into the workspace. */
export interface CopyIntoWorkspaceResult {
  copied: CopiedFile[];
  /** Paths deliberately left alone, e.g. a file that already lives in the target. */
  skipped: string[];
  /** Per-path failures: one bad path never aborts the rest of the drop. */
  errors: Array<{ path: string; error: string }>;
}

export interface ServiceStatusPayload {
  supervisor: 'starting' | 'ready' | 'restarting' | 'stopped' | 'failed';
  health?: ServiceHealth;
  error?: string;
}

/** Methods the renderer is allowed to call. Everything else stays main-process only. */
export const RENDERER_METHODS: RpcMethod[] = [
  'app.hello',
  'service.health',
  'service.shutdown',
  'session.list',
  'session.create',
  'session.get',
  'session.delete',
  'session.prompt',
  'session.abort',
  'session.setMode',
  'session.setModel',
  'session.setCwd',
  'workspace.state',
  'workspace.set',
  'workspace.forget',
  'knowledge.add',
  'knowledge.remove',
  'knowledge.rename',
  'knowledge.mkdir',
  'knowledge.copy',
  'fs.list',
  'fs.read',
  'goal.set',
  'goal.clear',
  'todo.list',
  'agents.detect',
  'agents.save',
  'approval.respond',
  'policy.get',
  'policy.set',
  'config.get',
  'config.set',
  'models.list',
  'audit.list',
  'agents.list',
  'subagent.list',
  'subagent.cancel',
  'tools.list',
  'mcp.list',
  'mcp.reload',
  'skill.list',
  'skill.reload',
  'skill.install',
  'skill.remove',
  'skill.read',
  'slate.list',
  'slate.read',
  'slate.remove',
  'slate.promote',
  'slate.diff',
  'slate.live',
  'plugin.list',
  'plugin.reload',
  'plugin.setEnabled',
  'plugin.install',
  'scheduler.list',
  'scheduler.remove',
  'scheduler.run',
  'scheduler.save',
];

/**
 * The renderer's whole world: a typed RPC proxy plus event subscriptions.
 * `contextIsolation` is on and there is no Node integration in the window, so this
 * contextBridge surface is the only capability the UI has.
 */
/**
 * The live slate surface. Every call is fire-and-forget: the host is the only thing that
 * knows whether the page actually attached, so the answer arrives through `onState`.
 */
export interface SlateLiveApi {
  show(request: {
    sessionId: string;
    id: string;
    version?: number;
    cwd?: string;
    bounds: SlateLiveBounds;
  }): void;
  setBounds(bounds: SlateLiveBounds): void;
  hide(): void;
  onState(listener: (state: SlateLiveState) => void): () => void;
}

export interface BeeCodeBridge {
  appInfo(): Promise<AppInfo>;
  serviceStatus(): Promise<ServiceStatusPayload>;
  restartService(): Promise<{ ok: boolean }>;
  invoke<M extends RpcMethod>(method: M, params: RpcRequests[M]['params']): Promise<RpcRequests[M]['result']>;
  getPolicy(): Promise<PolicyDocument>;
  savePolicy(policy: PolicyDocument): Promise<PolicyDocument>;
  getConfig(): Promise<BeeCodeConfig>;
  saveConfig(config: BeeCodeConfig): Promise<BeeCodeConfig>;
  pickDirectory(options?: DirectoryPickerOptions): Promise<string | undefined>;
  /**
   * Applications with a Start Menu entry, so nobody has to type an `.exe` name from
   * memory. Empty when the platform has no such catalogue.
   */
  listInstalledApps(): Promise<InstalledApp[]>;
  /** Native "choose a program" dialog; resolves to the picked path, or undefined if cancelled. */
  pickExecutable(options?: { title?: string }): Promise<string | undefined>;

  /**
   * Write text to a path the user picks in the native save dialog — the Download action
   * on a document tab. Cancelling resolves `{ saved: false }`.
   */
  saveFile(options: SaveFileOptions): Promise<SaveFileResult>;
  openExternal(url: string): Promise<void>;
  onEvent(listener: (event: ServiceEvent) => void): () => void;
  onServiceStatus(listener: (status: ServiceStatusPayload) => void): () => void;
  /**
   * The internal browser panel. The page itself is a sandboxed view owned by the main
   * process, so the renderer only reserves space for it and mirrors its state.
   */
  browser: BrowserPanelApi;

  /**
   * A live slate: a sandboxed page the main process serves from memory under the slate's
   * own allowlist. One at a time; the renderer reports the rectangle to fill.
   */
  slateLive: SlateLiveApi;

  /**
   * The workspace terminal. Unlike the browser view it lives entirely in the main process
   * and streams its scrollback back over IPC; the renderer only renders it.
   */
  terminal: TerminalApi;

  /**
   * Native multi-select file picker for chat attachments. Returns absolute paths;
   * the renderer never learns anything else about the file system from this call.
   */
  pickFiles(options?: FilePickerOptions): Promise<string[]>;

  /**
   * Copy paths dropped onto the UI into the workspace (or one of its folders). The
   * copy happens in the main process: the renderer has no file-system access.
   */
  copyIntoWorkspace(paths: string[], targetDir?: string): Promise<CopyIntoWorkspaceResult>;

  /**
   * Absolute paths of the dropped files. `File.path` is gone from the renderer, so the
   * preload resolves the paths with `webUtils.getPathForFile`.
   */
  pathsForFiles(files: File[]): string[];
}
