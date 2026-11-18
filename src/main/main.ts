import { app, BrowserWindow, globalShortcut, Menu, nativeImage, net, protocol, shell, Tray } from 'electron';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beeCodeHome } from '../shared/tools';
import { pipeServiceEvents, registerIpc } from './ipc';
import { ServiceSupervisor } from './serviceSupervisor';

const isDev = process.env.NODE_ENV === 'development';
const workspace = process.env.BEECODE_WORKSPACE ?? process.cwd();
const distDir = __dirname;
const rendererDir = join(distDir, 'renderer');

// A privileged custom scheme gives the renderer a real, secure origin so the strict
// CSP ('self') in index.html actually applies — something file:// can never provide.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let supervisor: ServiceSupervisor;

app.setName('beeCode');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(bootstrap);
}

async function bootstrap(): Promise<void> {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = resolve(rendererDir, rel);
    const inside = !relative(rendererDir, file).startsWith('..') && !isAbsolute(relative(rendererDir, file));
    if (!inside) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  supervisor = new ServiceSupervisor({
    entry: join(distDir, 'service.js'),
    workspace,
    log: (level, message) => {
      if (level === 'error') console.error('[service]', message);
      else if (level === 'warn') console.warn('[service]', message);
      else if (isDev) console.log('[service]', message);
    },
  });

  registerIpc({
    supervisor,
    getWindow: () => mainWindow,
    workspace,
    restartService: async () => {
      await supervisor.stop();
      const ok = await supervisor.start();
      return { ok };
    },
  });
  pipeServiceEvents({
    supervisor,
    getWindow: () => mainWindow,
    workspace,
    restartService: async () => ({ ok: false }),
  });

  createWindow();
  createTray();

  // The background service starts independently of the window — closing the UI keeps
  // the agent runtime alive so long-running tasks and subagents are not interrupted.
  const ok = await supervisor.start();
  if (!ok) console.error('[main] agent service failed to start — see ~/.beecode/logs/service.log');

  if (process.argv.includes('--smoke')) {
    await runSmokeCheck(ok);
    return;
  }

  globalShortcut.register('CommandOrControl+Alt+B', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else showWindow();
  });

  app.on('activate', () => showWindow());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: '#0d1016',
    title: 'beeCode',
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: join(distDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: isDev,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('console-message', (event) => {
    if (isDev || event.level === 'error') console.log('[renderer]', event.message);
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  // Closing the window hides it to the tray; the service keeps running in the background.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  void mainWindow.loadURL('app://beecode/index.html');
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('beeCode — agentic desktop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open beeCode', click: () => showWindow() },
      { label: 'Hide window', click: () => mainWindow?.hide() },
      { type: 'separator' },
      {
        label: 'Restart agent service',
        click: () => {
          void supervisor.stop().then(() => supervisor.start());
        },
      },
      {
        label: 'Open permissions folder',
        click: () => void shell.openPath(beeCodeHome()),
      },
      { type: 'separator' },
      {
        label: 'Quit beeCode',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => (mainWindow?.isVisible() ? mainWindow.hide() : showWindow()));
}

function iconPath(): string {
  return join(distDir, 'resources', 'icon.png');
}

/**
 * Headless-ish end-to-end check (`electron . --smoke`): boots the service, loads the
 * renderer and asserts the UI actually reached the service, then exits. Used to verify a
 * packaged build without a human clicking around.
 */
async function runSmokeCheck(serviceReady: boolean): Promise<void> {
  const win = mainWindow;
  const loaded = await new Promise<boolean>((resolve) => {
    if (!win) return resolve(false);
    if (!win.webContents.isLoading()) return resolve(true);
    win.webContents.once('did-finish-load', () => resolve(true));
    setTimeout(() => resolve(false), 10_000);
  });

  // Give the renderer a beat to run its boot sequence (service status poll + first render).
  await new Promise((r) => setTimeout(r, 2500));

  let dom: Record<string, unknown> = { error: 'window unavailable' };
  try {
    dom = (await win?.webContents.executeJavaScript(
      `(async () => ({
        bridge: typeof window.beeCode === 'object',
        sessions: document.querySelectorAll('.session-item').length,
        status: document.getElementById('service-text')?.textContent ?? '',
        title: document.getElementById('session-title')?.textContent ?? '',
        composer: Boolean(document.getElementById('input')),
        errors: window.__rendererErrors ?? [],
        health: await window.beeCode.serviceStatus().catch((e) => String(e)),
      }))()`,
    )) as Record<string, unknown>;
  } catch (err) {
    dom = { error: (err as Error).message };
  }

  const health = supervisor.status === 'ready' ? await supervisor.request('service.health', {}) : undefined;
  const result = {
    smoke: true,
    serviceReady,
    supervisor: supervisor.status,
    tools: health?.tools,
    driver: health?.desktopDriver,
    windowLoaded: loaded,
    dom,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  quitting = true;
  await supervisor.stop();
  app.exit(serviceReady && loaded && dom.bridge === true ? 0 : 1);
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void (async () => {
    globalShortcut.unregisterAll();
    await supervisor?.stop();
    tray?.destroy();
    app.exit(0);
  })();
});

app.on('window-all-closed', () => {
  // Tray-resident app: the window closing must not end the process on any platform.
});
