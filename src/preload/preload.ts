import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { BrowserState } from '../shared/browser';
import type {
  BeeCodeBridge,
  CopyIntoWorkspaceResult,
  FilePickerOptions,
  ServiceStatusPayload,
} from '../shared/bridge';
import type { TerminalState } from '../shared/terminal';
import type { RpcMethod, RpcRequests, ServiceEvent } from '../shared/protocol';

/**
 * Preload bridge. Runs sandboxed with contextIsolation: the page gets exactly the
 * functions below and nothing else — no `require`, no `process`, no direct IPC.
 */
const bridge: BeeCodeBridge = {
  appInfo: () => ipcRenderer.invoke('beecode:app-info'),

  serviceStatus: () => ipcRenderer.invoke('beecode:service-status'),

  restartService: () => ipcRenderer.invoke('beecode:restart-service'),

  invoke: <M extends RpcMethod>(method: M, params: RpcRequests[M]['params']) =>
    ipcRenderer.invoke('beecode:invoke', { method, params }),

  getPolicy: () => ipcRenderer.invoke('beecode:policy-get'),

  savePolicy: (policy) => ipcRenderer.invoke('beecode:policy-set', policy),

  getConfig: () => ipcRenderer.invoke('beecode:config-get'),

  saveConfig: (config) => ipcRenderer.invoke('beecode:config-set', config),

  pickDirectory: (options) => ipcRenderer.invoke('beecode:pick-directory', options),

  pickFiles: (options?: FilePickerOptions) => ipcRenderer.invoke('beecode:pick-files', options),

  copyIntoWorkspace: (paths: string[], targetDir?: string): Promise<CopyIntoWorkspaceResult> =>
    ipcRenderer.invoke('beecode:copy-to-workspace', { paths, targetDir }),

  // Runs in the isolated preload world, so the File objects handed over by the page
  // still resolve to real paths; the renderer itself has no such API.
  pathsForFiles: (files: File[]) =>
    files
      .map((file) => {
        try {
          return webUtils.getPathForFile(file);
        } catch {
          return "";
        }
      })
      .filter((path) => path.length > 0),

  openExternal: (url: string) => ipcRenderer.invoke('beecode:open-external', url),

  onEvent: (listener: (event: ServiceEvent) => void) => {
    const handler = (_e: unknown, event: ServiceEvent) => listener(event);
    ipcRenderer.on('beecode:event', handler);
    return () => ipcRenderer.removeListener('beecode:event', handler);
  },

  onServiceStatus: (listener: (status: ServiceStatusPayload) => void) => {
    const handler = (_e: unknown, status: ServiceStatusPayload) => listener(status);
    ipcRenderer.on('beecode:service-status', handler);
    return () => ipcRenderer.removeListener('beecode:service-status', handler);
  },

  // The browser view is not in this document: it is a WebContentsView the main process
  // positions over the rectangle the renderer reports. Commands and geometry go one way,
  // state comes back the other.
  browser: {
    setBounds: (bounds) => ipcRenderer.send('beecode:browser-command', { kind: 'set-bounds', bounds }),

    command: (command) => ipcRenderer.send('beecode:browser-command', command),

    onState: (listener: (state: BrowserState) => void) => {
      const handler = (_e: unknown, state: BrowserState) => listener(state);
      ipcRenderer.on('beecode:browser-state', handler);
      return () => ipcRenderer.removeListener('beecode:browser-state', handler);
    },
  },

  // The terminal is a main-process command runner: fire a command, then follow the state
  // it pushes back. Nothing is spawned from here — the renderer is sandboxed.
  terminal: {
    state: () => ipcRenderer.invoke('beecode:terminal-state'),

    run: (command: string) => ipcRenderer.invoke('beecode:terminal-run', command),

    cancel: () => ipcRenderer.invoke('beecode:terminal-cancel'),

    clear: () => ipcRenderer.invoke('beecode:terminal-clear'),

    onState: (listener: (state: TerminalState) => void) => {
      const handler = (_e: unknown, state: TerminalState) => listener(state);
      ipcRenderer.on('beecode:terminal-update', handler);
      return () => ipcRenderer.removeListener('beecode:terminal-update', handler);
    },
  },
};

contextBridge.exposeInMainWorld('beeCode', bridge);
