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
  'approval.respond',
  'policy.get',
  'policy.set',
  'config.get',
  'config.set',
  'audit.list',
  'agents.list',
  'subagent.list',
  'subagent.cancel',
  'tools.list',
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
  pickDirectory(): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;
  onEvent(listener: (event: ServiceEvent) => void): () => void;
  onServiceStatus(listener: (status: ServiceStatusPayload) => void): () => void;
}
