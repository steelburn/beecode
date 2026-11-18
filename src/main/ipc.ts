import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { RENDERER_METHODS, type AppInfo, type ServiceStatusPayload } from '../shared/bridge';
import type { BeeCodeConfig, PolicyDocument, RpcMethod, RpcRequests } from '../shared/protocol';
import { beeCodeHome } from '../shared/tools';
import type { ServiceSupervisor } from './serviceSupervisor';

export interface IpcDeps {
  supervisor: ServiceSupervisor;
  getWindow: () => BrowserWindow | null;
  workspace: string;
  restartService: () => Promise<{ ok: boolean }>;
}

const allowed = new Set<string>(RENDERER_METHODS);

/**
 * IPC surface between the sandboxed renderer and the main process.
 * Every channel is explicit and the RPC proxy is allow-listed, so the UI cannot reach
 * service methods that are not meant for it.
 */
export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('beecode:app-info', (): AppInfo => ({
    name: 'beeCode',
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    workspace: deps.workspace,
    home: beeCodeHome(),
    servicePid: deps.supervisor.pid,
  }));

  ipcMain.handle('beecode:service-status', async (): Promise<ServiceStatusPayload> => {
    const status: ServiceStatusPayload = { supervisor: deps.supervisor.status };
    if (deps.supervisor.status === 'ready') {
      try {
        status.health = await deps.supervisor.request('service.health', {});
      } catch (err) {
        status.error = err instanceof Error ? err.message : String(err);
      }
    }
    return status;
  });

  ipcMain.handle('beecode:restart-service', () => deps.restartService());

  ipcMain.handle(
    'beecode:invoke',
    async (_event, payload: { method: RpcMethod; params: RpcRequests[RpcMethod]['params'] }) => {
      if (!payload || typeof payload.method !== 'string' || !allowed.has(payload.method)) {
        throw new Error(`renderer may not call "${String(payload?.method)}"`);
      }
      return deps.supervisor.request(payload.method, payload.params as never);
    },
  );

  ipcMain.handle('beecode:policy-get', () => deps.supervisor.request('policy.get', {}));

  ipcMain.handle('beecode:policy-set', (_event, policy: PolicyDocument) =>
    deps.supervisor.request('policy.set', { policy }),
  );

  ipcMain.handle('beecode:config-get', () => deps.supervisor.request('config.get', {}));

  ipcMain.handle('beecode:config-set', (_event, config: BeeCodeConfig) =>
    deps.supervisor.request('config.set', { config }),
  );

  ipcMain.handle('beecode:pick-directory', async () => {
    const win = deps.getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('beecode:open-external', async (_event, url: string) => {
    // Only http(s) — never let the page hand us a file:// or custom-scheme URI.
    if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) links can be opened');
    await shell.openExternal(url);
  });
}

/** Forward service events to the renderer, dropping them when the window is gone. */
export function pipeServiceEvents(deps: IpcDeps): void {
  deps.supervisor.on('event', (event) => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('beecode:event', event);
  });

  deps.supervisor.on('status', (status: string) => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('beecode:service-status', { supervisor: status });
    }
  });
}
