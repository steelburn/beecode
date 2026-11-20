import type { BrowserPanelApi } from './browser';
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
  'skill.read',
  'plugin.list',
  'plugin.reload',
  'plugin.setEnabled',
];

/**
 * The renderer's whole world: a typed RPC proxy plus event subscriptions.
 * `contextIsolation` is on and there is no Node integration in the window, so this
 * contextBridge surface is the only capability the UI has.
 */
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
  openExternal(url: string): Promise<void>;
  onEvent(listener: (event: ServiceEvent) => void): () => void;
  onServiceStatus(listener: (status: ServiceStatusPayload) => void): () => void;
  /**
   * The internal browser panel. The page itself is a sandboxed view owned by the main
   * process, so the renderer only reserves space for it and mirrors its state.
   */
  browser: BrowserPanelApi;

  /**
   * The workspace terminal. Unlike the browser view it lives entirely in the main process
   * and streams its scrollback back over IPC; the renderer only renders it.
   */
  terminal: TerminalApi;
}
