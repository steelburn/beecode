import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BrowserPanelCommand } from '../shared/browser';
import type { SlateLiveCommand, SlateLiveState } from '../shared/slateSandbox';
import {
  RENDERER_METHODS,
  type AppInfo,
  type InstalledApp,
  type FilePickerOptions,
  type SaveFileOptions,
  type SaveFileResult,
  type ServiceStatusPayload,
} from '../shared/bridge';
import type { BeeCodeConfig, PolicyDocument, RpcMethod, RpcRequests } from '../shared/protocol';
import { beeCodeHome } from '../shared/tools';
import type { ServiceSupervisor } from './serviceSupervisor';
import type { WorkspaceTerminal } from './terminal';
import { copyIntoWorkspace } from './workspaceFiles';

export interface IpcDeps {
  supervisor: ServiceSupervisor;
  /** The one workspace terminal the renderer drives; it owns the child process. */
  terminal: WorkspaceTerminal;
  getWindow: () => BrowserWindow | null;
  workspace: string;
  restartService: () => Promise<{ ok: boolean }>;
  /** Panel geometry and chrome commands for the internal browser view. */
  browserCommand: (command: BrowserPanelCommand) => void;
  /**
   * The live slate view: a sandboxed page shown on request. The renderer never holds a
   * handle to it, only the rectangle to fill and the state pushed back.
   */
  slateLive: (command: SlateLiveCommand) => Promise<SlateLiveState>;
  /** Called with the new config after a successful save, so the host can re-read the sandbox settings. */
  configChanged?: (config: BeeCodeConfig) => void;
}

const allowed = new Set<string>(RENDERER_METHODS);

/* ------------------------------------------------ installed applications */

/**
 * The Start Menu scan is deliberately incremental and never load-bearing: one shortcut on
 * a dead network path must not keep the picker empty, so every entry that has been read is
 * published immediately and the caller only ever waits a bounded time.
 */
let installedAppsCache: { at: number; apps: InstalledApp[] } | undefined;
let installedAppsScan: Promise<void> | undefined;
const INSTALLED_APPS_TTL_MS = 5 * 60_000;
const INSTALLED_APPS_WALK_BUDGET_MS = 2500;
const INSTALLED_APPS_WAIT_MS = 3000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every application with a Start Menu shortcut, as `{ name, exe, path }`.
 *
 * The picker exists so nobody has to spell `excel.exe` from memory: the shortcut name is
 * the name the user knows, and the shortcut target is the program file a policy rule has
 * to name. Windows-only (`shell.readShortcutLink`); elsewhere the list stays empty and the
 * editor falls back to browsing for the program file.
 */
function scanInstalledApps(): Promise<void> {
  if (installedAppsScan) return installedAppsScan;
  installedAppsScan = (async () => {
    if (process.platform !== 'win32') {
      installedAppsCache = { at: Date.now(), apps: [] };
      return;
    }
    const roots = [process.env.ProgramData, process.env.APPDATA]
      .filter((base): base is string => Boolean(base))
      .map((base) => join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    const shortcuts: string[] = [];
    await Promise.race([
      (async () => {
        for (const root of roots) await collectShortcuts(root, shortcuts, 0);
      })(),
      delay(INSTALLED_APPS_WALK_BUDGET_MS),
    ]);

    const found = new Map<string, InstalledApp>();
    const publish = (): void => {
      installedAppsCache = {
        at: Date.now(),
        apps: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
      };
    };
    for (const shortcut of shortcuts) {
      let target = '';
      try {
        target = shell.readShortcutLink(shortcut).target ?? '';
      } catch {
        // A broken or remote shortcut is simply not a program we can offer.
        continue;
      }
      if (!/\.exe$/i.test(target)) continue;
      const exe = basename(target).toLowerCase();
      // Nobody wants beeCode to click "setup" or "uninstall".
      if (/^(unins|uninstall|setup|update|updater)/i.test(exe)) continue;
      if (found.has(exe)) continue;
      found.set(exe, { name: basename(shortcut, '.lnk'), exe, path: target });
      publish();
    }
    publish();
  })().finally(() => {
    installedAppsScan = undefined;
  });
  return installedAppsScan;
}

/** Depth-limited walk: Start Menu trees are shallow, and a junction must not hang us. */
async function collectShortcuts(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 4) return;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Reparse points can target an offline share; a shortcut list does not need them.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await collectShortcuts(full, out, depth + 1);
      else if (/\.lnk$/i.test(entry.name)) out.push(full);
    }
  } catch {
    return;
  }
}

/** The cached catalogue, waiting at most `INSTALLED_APPS_WAIT_MS` for a cold scan. */
async function installedApps(): Promise<InstalledApp[]> {
  if (!installedAppsCache || Date.now() - installedAppsCache.at > INSTALLED_APPS_TTL_MS) {
    await Promise.race([scanInstalledApps(), delay(INSTALLED_APPS_WAIT_MS)]);
  }
  return installedAppsCache?.apps ?? [];
}

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

  // Fire-and-forget: the renderer reports where the browser surface sits and which tab the
  // user picked. State flows back on 'beecode:browser-state'.
  // A live slate runs a stranger's script, so only the app's top-level frame may drive it
  // — never a frame a page could embed. The answer arrives on 'beecode:slate-live-state'.
  ipcMain.on('beecode:slate-live', (event, command: SlateLiveCommand) => {
    if (event.senderFrame?.parent) return;
    if (!command || typeof command.kind !== 'string') return;
    void deps.slateLive(command).catch(() => undefined);
  });

  ipcMain.on('beecode:browser-command', (_event, command: BrowserPanelCommand) => {
    if (!command || typeof command.kind !== 'string') return;
    deps.browserCommand(command);
  });

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

  ipcMain.handle('beecode:config-set', async (_event, config: BeeCodeConfig) => {
    const result = await deps.supervisor.request('config.set', { config });
    deps.configChanged?.(config);
    return result;
  });

  ipcMain.handle('beecode:pick-directory', async (_event, options?: { title?: string; defaultPath?: string }) => {
    const win = deps.getWindow();
    const dialogOptions = {
      title: options?.title ?? 'Choose a working directory',
      defaultPath: options?.defaultPath || deps.workspace || undefined,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    return result.canceled ? undefined : result.filePaths[0];
  });

  /**
   * Save dialog + write, for the Download action on a document tab. The renderer sends the
   * text it already has on screen and the user picks the destination, so nothing lands
   * anywhere they did not choose.
   */
  ipcMain.handle(
    'beecode:save-file',
    async (_event, options: SaveFileOptions): Promise<SaveFileResult> => {
      if (!options || typeof options.content !== 'string' || !options.suggestedName) {
        throw new Error('saveFile needs a suggestedName and content');
      }
      const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const dialogOptions = {
        title: options.title ?? 'Save file',
        defaultPath: options.suggestedName,
      };
      const { canceled, filePath } = owner
        ? await dialog.showSaveDialog(owner, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (canceled || !filePath) return { saved: false };
      await writeFile(filePath, options.content, 'utf8');
      return { saved: true, path: filePath };
    },
  );

  ipcMain.handle('beecode:list-installed-apps', () => installedApps());

  ipcMain.handle('beecode:pick-executable', async (_event, options?: { title?: string }) => {
    const filters =
      process.platform === 'win32'
        ? [{ name: 'Programs', extensions: ['exe'] }]
        : process.platform === 'darwin'
          ? [{ name: 'Applications', extensions: ['app'] }]
          : [];
    const dialogOptions: Electron.OpenDialogOptions = {
      title: options?.title ?? 'Choose the program to allow',
      properties: ['openFile'],
      ...(filters.length ? { filters } : {}),
      ...(process.platform === 'win32' ? { defaultPath: process.env.ProgramFiles ?? '' } : {}),
    };
    const win = BrowserWindow.getFocusedWindow();
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('beecode:open-external', async (_event, url: string) => {
    // Only http(s) — never let the page hand us a file:// or custom-scheme URI.
    if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) links can be opened');
    await shell.openExternal(url);
  });
}

/** Forward service events to the renderer, dropping them when the window is gone. */
export function pipeServiceEvents(deps: Omit<IpcDeps, 'slateLive'>): void {
  deps.supervisor.on('event', (event) => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('beecode:event', event);
  });

  // Terminal: one command at a time, always started inside the workspace root. Output is
  // pushed back over `beecode:terminal-update` rather than returned here, because a command
  // keeps producing lines long after the invoke has answered.
  // Multi-select file picker for chat attachments: the renderer only ever sees paths.
  ipcMain.handle('beecode:pick-files', async (_event, options?: FilePickerOptions) => {
    const win = deps.getWindow();
    const dialogOptions = {
      title: options?.title ?? 'Attach files to the prompt',
      filters: options?.extensions?.length
        ? [{ name: 'Supported', extensions: options.extensions }]
        : undefined,
      defaultPath: options?.defaultPath || deps.workspace || undefined,
      properties: (options?.multiple === false
        ? ['openFile']
        : ['openFile', 'multiSelections']) as Array<'openFile' | 'multiSelections'>,
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    return result.canceled ? [] : result.filePaths;
  });

  // Drag-and-drop of files onto the window: copied here, where the file system is.
  ipcMain.handle('beecode:copy-to-workspace', (_event, payload: { paths?: unknown; targetDir?: unknown }) =>
    copyIntoWorkspace(
      Array.isArray(payload?.paths)
        ? payload.paths.filter((entry): entry is string => typeof entry === 'string')
        : [],
      deps.workspace,
      typeof payload?.targetDir === 'string' ? payload.targetDir : undefined,
    ),
  );

  ipcMain.handle('beecode:terminal-state', () => deps.terminal.state);
  ipcMain.handle('beecode:terminal-run', (_event, line: unknown) =>
    deps.terminal.run(typeof line === 'string' ? line : ''),
  );
  ipcMain.handle('beecode:terminal-cancel', () => deps.terminal.cancel());
  ipcMain.handle('beecode:terminal-clear', () => deps.terminal.clear());

  deps.supervisor.on('status', (status: string) => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('beecode:service-status', { supervisor: status });
    }
  });
}
