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
import { WorkspaceTerminal } from './terminal';
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

/**
 * The workspace terminal: the one place that spawns a shell. It is created with the app so
 * the renderer can read its state immediately, and it re-confines itself whenever the
 * configured workspace root changes.
 */
const terminal = new WorkspaceTerminal({
  root: workspace,
  onChange: (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('beecode:terminal-update', state);
    }
  },
});

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
    terminal,
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
    terminal,
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
      // The terminal is confined to the same root the browser partitions by.
      terminal.setRoot(next);
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
        // The chat controls are meant to be icons floating inside the input box: a text
        // label or a stray empty hint row quietly gives the space back to the layout.
        composerUi: (() => {
          const tools = Array.from(document.querySelectorAll('.composer-tools .tool-btn'));
          const hint = document.getElementById('composer-hint');
          return {
            ids: tools.map((b) => b.id),
            insideBox: tools.length > 0 && tools.every((b) => Boolean(b.closest('.composer-box'))),
            iconOnly:
              tools.length > 0 &&
              tools.every((b) => Boolean(b.querySelector('svg')) && (b.textContent || '').trim() === ''),
            labelled: tools.every((b) => Boolean(b.getAttribute('aria-label'))),
            hintRow: hint ? window.getComputedStyle(hint).display : 'missing',
          };
        })(),
        // The side panel keeps the session surfaces only: configuration lives in the
        // settings dialog and the terminal in the drawer, so report the strip as it is.
        panelTabs: await (async () => {
          const tabs = Array.from(document.querySelectorAll('.panel-tabs .tab'));
          return {
            count: tabs.length,
            panels: tabs.map((tab) => tab.getAttribute('data-panel')),
            dialog: !!document.getElementById('settings-modal'),
            drawer: !!document.getElementById('drawer-body'),
          };
        })(),
        settings: await (async () => {
          const opener = document.getElementById('open-settings');
          if (!opener) return { opener: false };
          // Panels are painted from the bulk load; it can outlast these waits, so wait for
          // the renderer to say it landed before judging what a card contains.
          await waitFor(() => document.body.dataset.ready === 'true', 60000);
          opener.click();
          const dialogOpen = await waitFor(
            () => !document.getElementById('settings-modal')?.classList.contains('hidden'),
          );
          await waitFor(() => document.querySelectorAll('#settings-body .card').length > 0);
          const body = document.getElementById('settings-body');
          const inputs = Array.from(body.querySelectorAll('.settings-input'));
          const labels = Array.from(body.querySelectorAll('.settings-field > span')).map((n) => n.textContent);
          const out = {
            opener: true,
            dialog: dialogOpen,
            cards: body.querySelectorAll('.card').length,
            fields: labels,
            defaultRadios: body.querySelectorAll('input[type="radio"]').length,
            workingDir: (() => {
              const field = Array.from(body.querySelectorAll('.settings-field')).find((n) =>
                (n.querySelector('span')?.textContent ?? '').toLowerCase().includes('working directory'));
              return field?.querySelector('.settings-input')?.value ?? '';
            })(),
            hasSave: Array.from(body.querySelectorAll('button')).some((b) => b.textContent === 'Save'), loadHint: (document.getElementById('composer-hint')?.textContent || '').slice(0, 200),
          };
          // Fold the dialog away again so the probes after it see the side panel as the
          // user would; the next probe opens it on its own section.
          document.getElementById('close-settings')?.click();
          return out;
        })(),
        integrations: await (async () => {
          const nav = document.querySelector('#settings-nav .modal-nav-item[data-settings="integrations"]');
          if (!nav) return { dialog: false };
          nav.click();
          await waitFor(() => document.querySelectorAll('#settings-body .badge').length > 0);
          const body = document.getElementById('settings-body');
          const out = {
            dialog: true,
            headings: Array.from(body.querySelectorAll('h4')).map((n) => n.textContent.trim()),
            badges: Array.from(body.querySelectorAll('.badge')).map((n) => n.textContent.trim()),
            pluginDrop: !!body.querySelector('.plugin-drop'),
            pluginDropButtons: body.querySelectorAll('.plugin-drop button').length,
            skillRemoves: body.querySelectorAll('.skill-remove').length,
          };
          document.getElementById('close-settings')?.click();
          return out;
        })(),
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
        // Files preview: Markdown and HTML open rendered, flip to source on request, and
        // HTML arrives with its scripting stripped.
        preview: await (async () => {
          const tab = document.querySelector('.tab[data-panel="explorer"]');
          if (!tab) return { tab: false };
          tab.click();
          const listed = await waitFor(() => document.querySelectorAll('.explorer-row').length > 0, 20000);
          if (!listed) return { tab: true, listing: false };
          const names = Array.from(document.querySelectorAll('.explorer-name')).map((n) => n.textContent || '');
          const pick = (name) => {
            const row = Array.from(document.querySelectorAll('.explorer-row')).find(
              (r) => (r.querySelector('.explorer-name')?.textContent || '') === name,
            );
            if (row) row.click();
            return Boolean(row);
          };
          const out = {
            tab: true,
            listing: true,
            markdown: names.find((n) => /\.(md|markdown)$/i.test(n)) || null,
            html: names.find((n) => /\.html?$/i.test(n)) || null,
          };
          if (out.markdown && pick(out.markdown)) {
            out.markdownRendered = await waitFor(() => Boolean(document.querySelector('.explorer-rendered')), 20000);
            out.toggle = Boolean(document.querySelector('.explorer-viewtoggle'));
            const source = Array.from(document.querySelectorAll('.explorer-viewtoggle .btn')).find(
              (b) => (b.textContent || '').trim() === 'Source',
            );
            if (source) source.click();
            out.markdownSource = await waitFor(() => Boolean(document.querySelector('.explorer-code')), 20000);
          }
          if (!out.html) {
            // No HTML at the workspace root: index.html lives in src/renderer, so walk
            // one folder down at a time and wait for each listing to arrive.
            const steps = [
              { folder: 'src', expect: 'renderer' },
              { folder: 'renderer', expect: '.html' },
            ];
            for (const step of steps) {
              if (!pick(step.folder)) break;
              const arrived = await waitFor(
                () =>
                  Array.from(document.querySelectorAll('.explorer-name')).some((n) => {
                    const text = n.textContent || '';
                    return step.expect === '.html' ? /\.html?$/i.test(text) : text === step.expect;
                  }),
                20000,
              );
              if (!arrived) break;
            }
            out.html =
              Array.from(document.querySelectorAll('.explorer-name'))
                .map((n) => n.textContent || '')
                .find((n) => /\.html?$/i.test(n)) || null;
          }
          if (out.html && pick(out.html)) {
            // The rendered file lives in a shadow root, so the assertions look inside it;
            // the file stylesheet staying out of this document is the isolation check.
            const htmlHost = () => document.querySelector(".explorer-rendered.html");
            const htmlShadow = () => { const host = htmlHost(); return host ? host.shadowRoot : null; };
            out.htmlRendered = await waitFor(() => { const root = htmlShadow(); return Boolean(root && root.querySelector('.html-preview')); }, 20000);
            out.htmlScriptStripped = Boolean(htmlShadow()) && !htmlShadow().querySelector("script");
            out.htmlStylesIsolated = !document.querySelector('.explorer-rendered.html style');
          }
          return out;
        })().catch((err) => ({ error: String(err) })),
        // Main-area tabs: the explorer's rendered preview can be sent to the column as a tab.
        // The chat is not shown at the same time, the composer keeps its place, and the theme
        // toggle restates the document surface without restyling the app around it. Every
        // selector is written without backticks: this script is itself a template literal.
        mainArea: await (async () => {
          const out = { tab: false };
          const opener = document.querySelector('.explorer-preview .btn[title^="Open in the main area"]');
          if (!opener) return { tab: false, opener: false };
          opener.click();
          const bodyOf = () => document.querySelector('#doc-pane .doc-body');
          out.strip = await waitFor(() => Boolean(document.querySelector('.view-tabs:not([hidden])')), 20000);
          out.pane = await waitFor(() => Boolean(bodyOf()), 20000);
          out.docTab = document.querySelector('#doc-pane .doc-name')?.textContent ?? null;
          out.tabs = document.querySelectorAll('.view-tab').length;
          const host = document.querySelector('#doc-pane .doc-rendered.html');
          out.isolated = Boolean(host && host.shadowRoot) && !document.querySelector('#doc-pane .doc-rendered.html style');
          out.rendered = Boolean(host && host.shadowRoot && host.shadowRoot.querySelector('.html-preview'));
          out.transcriptHidden =
            (document.querySelector('.transcript')?.getBoundingClientRect().height ?? 0) === 0;
          const composerBox = () => document.querySelector('.composer').getBoundingClientRect();
          out.composerVisible = composerBox().height > 0 && composerBox().bottom <= window.innerHeight + 1;
          out.before = getComputedStyle(bodyOf()).backgroundColor;
          document.querySelector('.view-theme')?.click();
          out.light = await waitFor(() => (bodyOf()?.className ?? '').includes('doc-light'), 20000);
          out.after = getComputedStyle(bodyOf()).backgroundColor;
          out.themeFlipped = out.before !== out.after && out.after === 'rgb(255, 255, 255)';
          out.chromeDark = getComputedStyle(document.body).backgroundColor !== out.after;
          document.querySelector('.view-theme')?.click();
          await waitFor(() => (bodyOf()?.className ?? '').includes('doc-dark'), 20000);
          document.querySelector('.view-tab[data-tab="chat"] .view-tab-label')?.click();
          out.backToChat = await waitFor(
            () => (document.querySelector('.transcript')?.getBoundingClientRect().height ?? 0) > 0,
            20000,
          );
          document.querySelector('.view-tabs .view-tab-close')?.click();
          out.closed = await waitFor(() => !document.querySelector('.view-tabs:not([hidden])'), 20000);
          return out;
        })().catch((err) => ({ error: String(err) })),
        // Workspace terminal: the renderer mounts the panel, the main process runs the
        // command and streams the output back — this drives that whole chain.
        terminal: await (async () => {
          const toggle = document.getElementById('toggle-terminal');
          if (!toggle) return { drawer: false };
          toggle.click();
          const mounted = await waitFor(() => Boolean(document.querySelector('.term-input')));
          if (!mounted) return { drawer: true, mounted: false };
          const body = document.getElementById('drawer-body');
          const input = body.querySelector('.term-input');
          const info = await window.beeCode.appInfo();
          const cfg = await window.beeCode.invoke('config.get', {});
          const expected = (cfg && cfg.workspace && cfg.workspace.root) || info.workspace;
          input.value = 'echo beecode-terminal';
          body.querySelector('.term-form .btn.primary').click();
          const ran = await waitFor(
            () => Array.from(body.querySelectorAll('.term-line')).some((n) =>
              (n.textContent || '').includes('beecode-terminal')),
            20000,
          );
          const out = {
            drawer: true,
            mounted: true,
            ranCommand: ran,
            lines: body.querySelectorAll('.term-line').length,
            where: body.querySelector('.term-where')?.textContent || '',
            insideWorkspace: (body.querySelector('.term-where')?.textContent || '') === expected,
            status: body.querySelector('.term-status')?.textContent || '',
          };
          // Fold the drawer away again so the probes after it see an uncluttered window.
          toggle.click();
          return out;
        })().catch((err) => ({ error: String(err) })),
        // Side columns: both are draggable and both collapse away. Hide each one, bring it
        // back, then drag the rail grip and check the width it lands on and remembers.
        columns: await (async () => {
          const out = { rail: 0, panel: 0 };
          const widthOf = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? -1);
          const toggleRail = document.getElementById('toggle-rail');
          const togglePanel = document.getElementById('toggle-panel');
          const grip = document.getElementById('resizer-rail');
          if (!toggleRail || !togglePanel || !grip) return { missing: true };
          out.rail = widthOf('#rail');
          out.panel = widthOf('#panel');
          // Coming back is what a collapsed column has to make easy. The toggle itself
          // travels with the column, so what the user can still reach is the edge
          // handle: this is the gate for "collapsed the panel and could not get it back".
          const revealRail = document.getElementById('reveal-rail');
          const revealPanel = document.getElementById('reveal-panel');
          if (!revealRail || !revealPanel) return { ...out, error: 'reveal handles missing' };
          const shown = (el) => !el.hidden && window.getComputedStyle(el).display !== 'none';
          out.handlesIdle = revealRail.hidden && revealPanel.hidden;
          toggleRail.click();
          out.railHidden = await waitFor(() => widthOf('#rail') === 0, 20000);
          out.railHandleShown = shown(revealRail);
          out.railToggleLabel = toggleRail.getAttribute('aria-label');
          revealRail.click();
          out.railShown = await waitFor(() => widthOf('#rail') === out.rail, 20000);
          out.railHandleHidden = await waitFor(() => revealRail.hidden, 20000);
          togglePanel.click();
          out.panelHidden = await waitFor(() => widthOf('#panel') === 0, 20000);
          out.panelHandleShown = shown(revealPanel);
          out.panelToggleLabel = togglePanel.getAttribute('aria-label');
          // The handle is pinned to the window edge, which is where the topbar's last
          // controls live. Restoring the panel must not cost the user the gear or the
          // terminal button, so hit-test the centre of each one while the panel is away.
          const reachable = (id) => {
            const el = document.getElementById(id);
            if (!el) return 'missing';
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!top && (top === el || el.contains(top) || top.contains(el));
          };
          out.collapsedReach = {
            togglePanel: reachable('toggle-panel'),
            settings: reachable('open-settings'),
            terminal: reachable('toggle-terminal'),
          };
          revealPanel.click();
          out.panelShown = await waitFor(() => widthOf('#panel') === out.panel, 20000);
          out.panelHandleHidden = await waitFor(() => revealPanel.hidden, 20000);
          // A synthetic drag: press the grip, move 60px right, release.
          const before = widthOf('#rail');
          const x = Math.round(grip.getBoundingClientRect().left) + 4;
          const fire = (type, clientX) => grip.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, clientX, clientY: 12, button: 0,
            buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
          }));
          fire('pointerdown', x);
          fire('pointermove', x + 60);
          fire('pointerup', x + 60);
          out.railDrag = widthOf('#rail');
          out.railDragged = out.railDrag > before;
          out.railStored = Number(localStorage.getItem('beecode.rail.width')) === out.railDrag;
          // A double-click puts the shipped width back.
          grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          out.railReset = await waitFor(() => widthOf('#rail') === 240, 20000);
          return out;
        })().catch((err) => ({ error: String(err) })),
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

      // Tab strip: the agent can have more tabs open than the bar can show. Open a few more
      // and assert the strip stays usable — every tab keeps a readable width and the active
      // one is scrolled into view instead of being clipped off the right edge.
      // `about:blank` is the only scheme the internal browser accepts offline; opening it
      // again still creates a tab, which is all this phase needs.
      for (let i = 0; i < 3; i += 1) {
        await browserHost.exec({ action: 'open', url: 'about:blank' });
      }
      await new Promise((r) => setTimeout(r, 900));
      const expected = browserHost.state().tabs.length;
      const strip = (await win.webContents.executeJavaScript(
        `(() => {
          const el = document.querySelector('.browser-tabs');
          const tabs = Array.from(document.querySelectorAll('.browser-tab'));
          if (!el || !tabs.length) return { strip: false, count: tabs.length };
          const box = el.getBoundingClientRect();
          const active = document.querySelector('.browser-tab.active');
          const act = active ? active.getBoundingClientRect() : null;
          return {
            strip: true,
            count: tabs.length,
            widths: tabs.map((t) => Math.round(t.getBoundingClientRect().width)),
            overflow: el.scrollWidth > el.clientWidth + 1,
            scrolled: el.scrollLeft > 0,
            activeVisible: Boolean(act) && act.left >= box.left - 1 && act.right <= box.right + 1,
            counter: el.parentElement?.querySelector('.browser-tab-counter')?.textContent ?? '',
          };
        })()`,
      )) as {
        strip?: boolean;
        count?: number;
        widths?: number[];
        overflow?: boolean;
        scrolled?: boolean;
        activeVisible?: boolean;
        counter?: string;
      };
      browser.tabStrip = {
        expected,
        count: strip.count ?? 0,
        minWidth: strip.widths?.length ? Math.min(...strip.widths) : 0,
        overflow: strip.overflow === true,
        scrolled: strip.scrolled === true,
        activeVisible: strip.activeVisible === true,
        counter: strip.counter ?? '',
      };

      // Tab menu: right-clicking a tab must reach the host and build the close rows. The menu is
      // captured instead of popped — a real popup would grab input for the rest of the run.
      // Electron's `popup` sits on `Menu.prototype` (checked: instances carry no own property),
      // so the host's build-then-popup call routes through this stub.
      const realPopup = Menu.prototype.popup;
      let closeOthersOk = false;
      const captured: Array<{ label: string; enabled: boolean; click: () => void }> = [];
      (Menu.prototype as unknown as { popup: (this: Electron.Menu) => void }).popup = function (
        this: Electron.Menu,
      ): void {
        for (const item of this.items) {
          if (item.type !== 'separator') {
            captured.push({ label: item.label, enabled: item.enabled, click: () => (item.click as unknown as () => void)() });
          }
        }
      };
      let contextClicked = false;
      try {
        contextClicked = (await win.webContents.executeJavaScript(
          `(() => {
            const tabs = document.querySelectorAll('.browser-tab');
            const tab = tabs[tabs.length - 1];
            if (!tab) return false;
            tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
            return true;
          })()`,
        )) as boolean;
        await new Promise((r) => setTimeout(r, 400));
        // The rows must also *work*, not just exist: pick "Close other tabs" on the last tab and
        // the strip has to come back holding exactly that tab. Three tabs are reopened afterwards
        // so the window-control phase below still finds the strip it expects.
        const targetTab = browserHost.state().tabs.at(-1)?.id ?? '';
        captured.find((item) => item.label.startsWith('Close other'))?.click();
        await new Promise((r) => setTimeout(r, 300));
        const survivor = browserHost.state().tabs;
        closeOthersOk = survivor.length === 1 && survivor[0].id === targetTab;
        for (let i = 0; i < 3; i += 1) {
          await browserHost.exec({ action: 'open', url: 'about:blank' });
        }
        await new Promise((r) => setTimeout(r, 400));
      } finally {
        Menu.prototype.popup = realPopup;
      }
      browser.tabMenu = {
        contextClicked,
        opened: captured.length > 0,
        closeOthersOk,
        items: captured.map((item) => `${item.label}${item.enabled ? '' : ' (off)'}`),
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
          // The main-area Browser tab is the same page view: activating it fills the column
          // with the page while the composer keeps its place below, and leaving it restores.
          const tabOf = (id) => document.querySelector('.view-tab[data-tab="' + id + '"]');
          tabOf('browser')?.querySelector('.view-tab-label')?.click();
          await wait(350);
          const tabActivated = state({
            offered: Boolean(tabOf('browser')),
            active: Boolean(tabOf('browser')?.classList.contains('active')),
            transcriptHidden:
              (document.querySelector('.transcript')?.getBoundingClientRect().height ?? 0) === 0,
          });
          tabOf('chat')?.querySelector('.view-tab-label')?.click();
          await wait(350);
          const tabClosed = state({ active: Boolean(tabOf('chat')?.classList.contains('active')) });
          pick('Restore')?.click();
          await wait(350);
          const unmaximized = state();
          pick('Close')?.click();
          await wait(500);
          const closed = state();
          return { before, minimized, restored, maximized, tabActivated, tabClosed, unmaximized, closed };
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
  terminal.dispose();
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
    terminal.dispose();
    await supervisor?.stop();
    tray?.destroy();
    app.exit(0);
  })();
});

app.on('window-all-closed', () => {
  // Tray-resident app: the window closing must not end the process on any platform.
});
