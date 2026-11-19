import { app, BrowserWindow, globalShortcut, Menu, nativeImage, net, protocol, shell, Tray } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserExecParams, BrowserState } from '../shared/browser';
import { defaultConfig } from '../shared/defaults';
import type { BrowserConfig } from '../shared/protocol';
import { beeCodeHome } from '../shared/tools';
import { BrowserHost } from './browser/host';
import { pipeServiceEvents, registerIpc } from './ipc';
import { createPluginHostBridge, type PluginHostBridge } from './pluginHost';
import { ServiceSupervisor } from './serviceSupervisor';

const isDev = process.env.NODE_ENV === 'development';
/**
 * The only workspace override is the environment. It is deliberately NOT `process.cwd()`:
 * in a packaged app that is the installation directory, and beeCode must never adopt it
 * silently. With no override the renderer shows the workspace setup step until the user
 * picks a folder (`workspace.set`).
 */
const workspace = process.env.BEECODE_WORKSPACE ?? '';
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
let browserHost: BrowserHost | null = null;
let pluginHostBridge: PluginHostBridge | null = null;
/** Mirrors config.browser so the host can read it synchronously when it opens a tab. */
let browserConfig: BrowserConfig = defaultConfig().browser;

/**
 * Workspace the browser's cookie partition belongs to. Kept next to the config mirror so
 * the host can read it synchronously; a change resets the tabs into a fresh partition.
 */
let browserWorkspace = workspace;

app.setName('beeCode');

if (!app.requestSingleInstanceLock()) {
  // Silent exit here is confusing when a packaged build is already running, so say so.
  console.error('[beecode] another instance is already running - exiting this one');
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

  // The host is created before the IPC handlers so the renderer can drive the panel as
  // soon as it mounts, and it answers the service's host requests (the agent's browser tools).
  browserHost = createBrowserHost();
  // Kept in a local too: the module-level binding is a mutable let, so it does not narrow
  // inside the callback below.
  const bridge = createPluginHostBridge();
  pluginHostBridge = bridge;
  supervisor.setHostHandler(async (method, params) => {
    if (!browserHost) throw new Error('the internal browser is not available');
    if (method === 'pdf/open' || method === 'pdf/render') return bridge.exec(method, params);
    if (method === 'browser/exec') return browserHost.exec(params as BrowserExecParams);
    throw new Error(`unsupported host request: ${method}`);
  });

  registerIpc({
    supervisor,
    getWindow: () => mainWindow,
    workspace,
    browserCommand: (command) => browserHost?.command(command),
    configChanged: () => {
      void refreshBrowserConfig();
    },
    restartService: async () => {
      await supervisor.stop();
      const ok = await supervisor.start();
      if (ok) await refreshBrowserConfig();
      return { ok };
    },
  });
  pipeServiceEvents({
    supervisor,
    getWindow: () => mainWindow,
    workspace,
    browserCommand: (command) => browserHost?.command(command),
    restartService: async () => ({ ok: false }),
  });

  createWindow();
  createTray();

  // The background service starts independently of the window — closing the UI keeps
  // the agent runtime alive so long-running tasks and subagents are not interrupted.
  const ok = await supervisor.start();
  if (ok) await refreshBrowserConfig();
  if (!ok) console.error('[main] agent service failed to start — see ~/.beecode/logs/service.log');

  if (process.argv.includes('--smoke')) {
    await runSmokeCheck(ok);
    return;
  }

  // `--capture-docs[=<dir>]` regenerates the README screenshots (src/main/docsCapture.ts).
  const captureArg = process.argv.find((arg) => arg.startsWith('--capture-docs'));
  if (captureArg) {
    const outDir = captureArg.includes('=')
      ? resolve(captureArg.slice(captureArg.indexOf('=') + 1))
      : resolve(process.cwd(), 'docs', 'images');
    const { runDocsCapture } = await import('./docsCapture');
    const report =
      mainWindow && browserHost
        ? await runDocsCapture({ window: mainWindow, browser: browserHost, outDir })
        : { ok: false, images: [], hovered: false, errors: ['no window or browser host'] };
    console.log(`[docs] ${JSON.stringify(report, null, 2)}`);
    app.exit(report.ok ? 0 : 1);
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

/** Push browser panel state (open tabs, active tab, cursor) to the renderer. */
function sendBrowserState(state: BrowserState): void {
  const win = mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send('beecode:browser-state', state);
}

/**
 * The internal browser is a main-process object: the service asks for actions over the
 * host channel and this is what answers them.
 */
function createBrowserHost(): BrowserHost {
  return new BrowserHost({
    getWindow: () => mainWindow,
    config: () => browserConfig,
    workspaceRoot: () => browserWorkspace,
    onState: sendBrowserState,
    log: (level, message) => console.log(`[${level}]`, message),
  });
}

async function refreshBrowserConfig(): Promise<void> {
  try {
    const config = await supervisor.request('config.get', {});
    if (config?.browser) browserConfig = { ...browserConfig, ...config.browser };
    if (config?.workspace) {
      const next = config.workspace.root?.trim() || workspace;
      if (next !== browserWorkspace) {
        browserWorkspace = next;
        browserHost?.resetWorkspace();
      }
    }
  } catch {
    /* the defaults keep the browser usable while the service is starting */
  }
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
      `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return false; };
        return {
        bridge: typeof window.beeCode === 'object',
        sessions: document.querySelectorAll('.session-item').length,
        status: document.getElementById('service-text')?.textContent ?? '',
        title: document.getElementById('session-title')?.textContent ?? '',
        composer: Boolean(document.getElementById('input')),
        settings: await (async () => {
          const tab = document.querySelector('.tab[data-panel="settings"]');
          if (!tab) return { tab: false };
          tab.click();
          await waitFor(() => document.querySelectorAll('#panel-body .card').length > 0);
          const body = document.getElementById('panel-body');
          const inputs = Array.from(body.querySelectorAll('.settings-input'));
          const labels = Array.from(body.querySelectorAll('.settings-field > span')).map((n) => n.textContent);
          return {
            tab: true,
            cards: body.querySelectorAll('.card').length,
            fields: labels,
            defaultRadios: body.querySelectorAll('input[type="radio"]').length,
            workingDir: (() => {
              const field = Array.from(body.querySelectorAll('.settings-field')).find((n) =>
                (n.querySelector('span')?.textContent ?? '').toLowerCase().includes('working directory'));
              return field?.querySelector('.settings-input')?.value ?? '';
            })(),
            hasSave: Array.from(body.querySelectorAll('button')).some((b) => b.textContent === 'Save'),
          };
        })(),
        integrations: await (async () => { const tab = document.querySelector('.tab[data-panel="integrations"]'); if (!tab) return { tab: false }; tab.click(); await waitFor(() => document.querySelectorAll('#panel-body .badge').length > 0); const body = document.getElementById('panel-body'); return { tab: true, headings: Array.from(body.querySelectorAll('h4')).map((n) => n.textContent.trim()), badges: Array.from(body.querySelectorAll('.badge')).map((n) => n.textContent.trim()) }; })(),
        configRoundTrip: await (async () => {
          const before = await window.beeCode.getConfig();
          const saved = await window.beeCode.saveConfig(before);
          const after = await window.beeCode.getConfig();
          return {
            models: saved.models.length,
            defaultModelId: saved.defaultModelId,
            stable: JSON.stringify([saved.models, saved.defaultModelId, saved.agent.workingDir]) ===
              JSON.stringify([after.models, after.defaultModelId, after.agent.workingDir]),
          };
        })().catch((e) => String(e)),
        errors: window.__rendererErrors ?? [],
        // Markdown + chart rendering, measured in the real sandboxed renderer.
        markdown: (() => {
          try {
            return window.__renderMessageSample ? window.__renderMessageSample() : { missing: true };
          } catch (err) {
            return { error: String(err) };
          }
        })(),
        cwdChip: (() => {
          const chip = document.getElementById('session-cwd');
          return { tag: chip?.tagName ?? '', title: chip?.getAttribute('title') ?? '' };
        })(),
        health: await window.beeCode.serviceStatus().catch((e) => String(e)),
      };
      })()`,
    )) as Record<string, unknown>;
  } catch (err) {
    dom = { error: (err as Error).message };
  }

  // Internal browser: the dock must reserve a rectangle before the host can paint a page
  // into it, so this drives the real chain — host exec -> state push -> dock layout ->
  // setBounds -> attached view — instead of checking the pieces separately.
  let browser: Record<string, unknown> = { skipped: true };
  try {
    if (browserHost && win) {
      const opened = await browserHost.exec({ action: 'open', url: 'about:blank' });
      await new Promise((r) => setTimeout(r, 1200));
      const state = browserHost.state();
      const dock = (await win.webContents.executeJavaScript(
        `(() => {
          const el = document.getElementById('browser-dock');
          if (!el) return { dock: false };
          const surface = el.querySelector('.browser-surface');
          const rect = surface ? surface.getBoundingClientRect() : null;
          return {
            dock: true,
            hidden: el.classList.contains('hidden'),
            tabs: el.querySelectorAll('.browser-tab').length,
            url: el.querySelector('.browser-url')?.value ?? '',
            cursorToggle: Boolean(el.querySelector('.browser-bar .btn.active')),
            surface: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
          };
        })()`,
      )) as Record<string, unknown>;
      browser = {
        opened: opened.ok,
        error: opened.error,
        visible: state.visible,
        tabs: state.tabs.length,
        cursor: state.cursor,
        dock,
      };

      // Window controls: minimize must collapse the dock (and report no area, so the page
      // view detaches), maximize must grow it into the column, close must remove the tabs.
      const controls = (await win.webContents.executeJavaScript(
        `(async () => {
          const el = document.getElementById('browser-dock');
          if (!el) return { dock: false };
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const pick = (label) => Array.from(el.querySelectorAll('.browser-window-btn'))
            .find((b) => (b.getAttribute('aria-label') || '').startsWith(label));
          const box = (sel) => {
            const node = sel ? el.querySelector(sel) : el;
            const r = node ? node.getBoundingClientRect() : null;
            return r ? Math.round(r.height) : -1;
          };
          const state = (extra) => ({
            height: box(null),
            surface: box('.browser-surface'),
            minimized: el.classList.contains('minimized'),
            maximized: el.classList.contains('maximized'),
            hidden: el.classList.contains('hidden'),
            tabs: el.querySelectorAll('.browser-tab').length,
            // The prompt must survive a maximised dock: it keeps its height and ends above
            // the dock, so the native page view can never cover it.
            composer: (() => {
              const form = document.querySelector('.composer');
              if (!form) return { present: false };
              const r = form.getBoundingClientRect();
              return {
                present: true,
                top: Math.round(r.top),
                bottom: Math.round(r.bottom),
                height: Math.round(r.height),
                viewport: Math.round(window.innerHeight),
                // The dock sits *above* the prompt, so overlap — not order — is the thing
                // to catch: a native page view over the composer is what hid it.
                visible:
                  Math.round(r.top) >= 0 && Math.round(r.bottom) <= Math.round(window.innerHeight) + 1,
                overlapsDock:
                  r.bottom > el.getBoundingClientRect().top + 1 &&
                  r.top < el.getBoundingClientRect().bottom - 1,
              };
            })(),
            ...extra,
          });

          const before = state({ buttons: el.querySelectorAll('.browser-window-btn').length });
          pick('Minimize')?.click();
          await wait(350);
          const minimized = state();
          pick('Restore')?.click();
          await wait(350);
          const restored = state();
          pick('Maximize')?.click();
          await wait(350);
          const maximized = state();
          pick('Restore')?.click();
          await wait(350);
          const unmaximized = state();
          pick('Close')?.click();
          await wait(500);
          const closed = state();
          return { before, minimized, restored, maximized, unmaximized, closed };
        })()`,
      )) as Record<string, unknown>;

      browser = { ...browser, controls, afterControls: { visible: browserHost.state().visible, tabs: browserHost.state().tabs.length } };

      // Silent drive: showing the dock must not be a side effect of driving it. Re-open a page,
      // collapse the dock the way the ✕ does, then keep driving — `visible` stays false, reading
      // and navigation still work, and the actions that need a surface fail fast instead of
      // hanging the agent loop.
      const silent = await (async () => {
        const reopened = await browserHost.exec({ action: 'open', url: 'about:blank' });
        browserHost.command({ kind: 'close' });
        await new Promise((resolve) => setTimeout(resolve, 400));
        const navigated = await browserHost.exec({ action: 'navigate', url: 'about:blank' });
        const scrolled = await browserHost.exec({ action: 'scroll', deltaY: 200 });
        const shot = await browserHost.exec({ action: 'screenshot' });
        const after = browserHost.state();
        return {
          reopened: reopened.ok,
          collapsed: after.visible === false,
          navigated: navigated.ok,
          guarded:
            !scrolled.ok && !shot.ok && /dock is hidden/.test(String(scrolled.error ?? shot.error ?? '')),
          tabs: after.tabs.length,
          error: navigated.error ?? scrolled.error ?? shot.error,
        };
      })();
      browser = { ...browser, silent };
    }
  } catch (err) {
    browser = { error: (err as Error).message };
  }

  const health = supervisor.status === 'ready' ? await supervisor.request('service.health', {}) : undefined;
  const result = {
    smoke: true,
    serviceReady,
    supervisor: supervisor.status,
    tools: health?.tools,
    driver: health?.desktopDriver,
    windowLoaded: loaded,
    browser,
    dom,
  };
  // A GUI-subsystem process on Windows may have no console attached, in which case
  // process.stdout.write goes nowhere. The report is therefore also written to disk so
  // `npm run smoke` can always show it.
  const reportPath = join(process.cwd(), 'dist-test', 'smoke-report.json');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  quitting = true;
  browserHost?.dispose();
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
    browserHost?.dispose();
    pluginHostBridge?.closeViewers();
    await supervisor?.stop();
    tray?.destroy();
    app.exit(0);
  })();
});

app.on('window-all-closed', () => {
  // Tray-resident app: the window closing must not end the process on any platform.
});
