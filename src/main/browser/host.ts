/**
 * The internal browser host — the only thing in beeCode that owns a web page.
 *
 * One `WebContentsView` per tab, all of them bound to the sandboxed session from
 * `session.ts`, and exactly one of them attached to the window at a time. The renderer
 * reserves a rectangle for it (`browser.setBounds`) and paints the chrome around it; the
 * page itself is a separate, sandboxed view on top, so no amount of page script can reach
 * the chat UI or the preload bridge.
 *
 * Two ways to touch the page, in this order:
 *
 *   1. Trusted input over the Chrome DevTools protocol (`Input.dispatchMouseEvent`,
 *      `Input.insertText`, `Input.dispatchKeyEvent`). Real pointer and key events, which is
 *      what frameworks with synthetic event systems actually react to.
 *   2. DOM manipulation inside the page's isolated world (`agentScript.ts`), used for
 *      reading and as a fallback when CDP is unavailable.
 *
 * The AI cursor is drawn into the page from the isolated world: it moves to the element
 * *before* the input is dispatched, so the user sees what the agent is about to do instead
 * of watching the page change under them.
 */
import { BrowserWindow, WebContentsView } from 'electron';
import type {
  BrowserBounds,
  BrowserExecParams,
  BrowserExecResult,
  BrowserPanelCommand,
  BrowserSnapshot,
  BrowserState,
} from '../../shared/browser';
import type { BrowserConfig } from '../../shared/protocol';
import { agentBootstrapSource, AGENT_WORLD_ID } from './agentScript';
import { browserSession, isAllowedNavigation } from './session';

export interface BrowserHostOptions {
  getWindow: () => BrowserWindow | null;
  /** Live browser config (tab cap, home page, cursor, scripts, persistence). */
  config: () => BrowserConfig;
  /**
   * Workspace the cookie partition belongs to. Read per tab so a workspace switch inside
   * the running app re-scopes persistence without restarting it.
   */
  workspaceRoot?: () => string | undefined;
  onState: (state: BrowserState) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface Tab {
  id: string;
  view: WebContentsView;
  url: string;
  title: string;
  loading: boolean;
  lastUsed: number;
}

interface Point {
  x: number;
  y: number;
}

interface Located {
  point: Point;
  rect?: { x: number; y: number; width: number; height: number };
  role?: string;
  name?: string;
  editable?: boolean;
}

/** How long the cursor rests on a target before the input fires, so the move is visible. */
const CURSOR_LEAD_MS = 260;
/** Resolves after `ms`; the browser is a UI, so a few waits are part of the contract. */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Minimal structural type for `webContents.debugger`, which is only used for `sendCommand`. */
interface CdpClient {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

const KEY_CODES: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
};

/** Actions whose result carries a fresh snapshot, so the agent sees the effect immediately. */
const SNAPSHOT_ACTIONS = new Set(['open', 'navigate', 'click', 'type', 'key', 'back', 'forward', 'reload']);

export class BrowserHost {
  private readonly tabs = new Map<string, Tab>();
  private readonly attached = new Set<string>();
  private activeId?: string;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private cursorOverride?: boolean;
  private sequence = 0;
  private lastAction?: BrowserState['lastAction'];
  private disposed = false;

  constructor(private readonly opts: BrowserHostOptions) {}

  /* ------------------------------------------------------------------- state */

  state(): BrowserState {
    const tabs = [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      active: tab.id === this.activeId,
    }));
    return {
      visible: this.visible,
      tabs,
      activeTabId: this.activeId,
      cursor: { enabled: this.cursorOn(), label: this.lastAction?.label },
      lastAction: this.lastAction,
    };
  }

  private emit(): void {
    this.opts.onState(this.state());
  }

  private cursorOn(): boolean {
    return this.cursorOverride ?? this.opts.config().showCursor;
  }

  /* ------------------------------------------------------------------ chrome */

  setBounds(bounds: BrowserBounds): void {
    const next = {
      x: Math.round(Number(bounds?.x) || 0),
      y: Math.round(Number(bounds?.y) || 0),
      width: Math.round(Number(bounds?.width) || 0),
      height: Math.round(Number(bounds?.height) || 0),
    };
    this.bounds = next;
    // Always resync, even when the numbers repeat. A report that arrives while the window is
    // occluded — or while it is coming back from minimized or a resize — can be applied to
    // `bounds` without the attached view following it, and a skipped resync on the next
    // identical report would then leave the page painted over the dock chrome for good.
    this.syncView();
  }

  command(command: BrowserPanelCommand): void {
    switch (command.kind) {
      case 'set-bounds':
        this.setBounds(command.bounds);
        return;
      case 'focus': {
        const tab = this.activeTab();
        tab?.view.webContents.focus();
        return;
      }
      case 'close':
        this.hide();
        return;
      case 'close-all':
        this.closeAll();
        return;
      case 'activate-tab':
        this.activate(command.tabId);
        this.emit();
        return;
      case 'close-tab':
        this.closeTab(command.tabId);
        this.emit();
        return;
      case 'toggle-cursor':
        this.cursorOverride = command.enabled;
        for (const tab of this.tabs.values()) void this.paintCursor(tab).catch(() => undefined);
        this.emit();
        return;
      default:
        return;
    }
  }

  /** Stop painting the view (the renderer collapsed the dock) without losing the tabs. */
  hide(): void {
    this.visible = false;
    this.syncView();
    this.emit();
  }

  /* -------------------------------------------------------------------- exec */

  async exec(params: BrowserExecParams): Promise<BrowserExecResult> {
    const action = params.action;
    try {
      if (this.disposed) return { ok: false, action, error: 'the internal browser is closed' };
      if (!this.opts.config().enabled) {
        return { ok: false, action, error: 'the internal browser is disabled (config.browser.enabled = false)' };
      }
      const result = await this.dispatch(params);
      this.emit();
      return result;
    } catch (error) {
      this.emit();
      return { ok: false, action, tabId: this.activeId, error: messageOf(error) };
    }
  }

  private async dispatch(params: BrowserExecParams): Promise<BrowserExecResult> {
    const action = params.action;
    if (action !== 'close' && action !== 'tabs') this.visible = true;

    switch (action) {
      case 'open': {
        const url = this.normalizeUrl(params.url);
        const tab = this.createTab(url);
        this.activate(tab.id);
        await this.load(tab, url);
        return await this.result(params, tab, `opened ${tab.url || 'a new tab'}`);
      }
      case 'navigate': {
        const tab = this.requireActive(params.tabId);
        const url = this.normalizeUrl(params.url ?? this.opts.config().homeUrl);
        await this.load(tab, url);
        return await this.result(params, tab, `navigated to ${tab.url}`);
      }
      case 'snapshot': {
        const tab = this.requireActive(params.tabId);
        const snapshot = await this.snapshot(tab);
        return {
          ok: true,
          action,
          tabId: tab.id,
          state: this.state(),
          snapshot,
          message: `${snapshot.elements.length} interactive element(s), ${snapshot.text.length} characters of text`,
        };
      }
      case 'click':
        return this.click(params);
      case 'type':
        return this.type(params);
      case 'key':
        return this.pressKey(params);
      case 'scroll':
        return this.scroll(params);
      case 'hover':
        return this.hover(params);
      case 'wait':
        return this.waitFor(params);
      case 'back':
      case 'forward': {
        const tab = this.requireActive(params.tabId);
        const history = tab.view.webContents.navigationHistory;
        const can = action === 'back' ? history.canGoBack() : history.canGoForward();
        if (!can) return { ok: false, action, tabId: tab.id, error: `cannot go ${action}: no history` };
        if (action === 'back') history.goBack();
        else history.goForward();
        await this.settle(tab);
        return await this.result(params, tab, `${action === 'back' ? 'went back' : 'went forward'} to ${tab.url}`);
      }
      case 'reload': {
        const tab = this.requireActive(params.tabId);
        tab.view.webContents.reload();
        await this.settle(tab);
        return await this.result(params, tab, `reloaded ${tab.url}`);
      }
      case 'screenshot': {
        const tab = this.requireActive(params.tabId);
        const image = await tab.view.webContents.capturePage();
        const dataBase64 = image.toPNG().toString('base64');
        return {
          ok: true,
          action,
          tabId: tab.id,
          state: this.state(),
          screenshot: { mimeType: 'image/png', dataBase64 },
          message: `captured ${image.getSize().width}x${image.getSize().height} px`,
        };
      }
      case 'tabs':
        return { ok: true, action, tabId: this.activeId, state: this.state(), message: `${this.tabs.size} tab(s)` };
      case 'close': {
        const tabId = params.tabId ?? this.activeId;
        if (!tabId) return { ok: true, action, message: 'no tabs open' };
        this.closeTab(tabId);
        return { ok: true, action, tabId: this.activeId, state: this.state(), message: `closed ${tabId}` };
      }
      default:
        return { ok: false, action, error: `unsupported browser action "${action}"` };
    }
  }

  /* ------------------------------------------------------------- interaction */

  private async click(params: BrowserExecParams): Promise<BrowserExecResult> {
    const tab = this.requireActive(params.tabId);
    const located = await this.locate(tab, params);
    await this.moveCursor(tab, located, params.label ?? `click ${located.name ?? located.role ?? 'element'}`, 'click');
    await delay(this.cursorOn() ? CURSOR_LEAD_MS : 0);

    const target = { ref: params.ref, selector: params.selector };
    const trusted = await this.dispatchClick(tab, located.point);
    if (!trusted) {
      if (!params.ref && !params.selector) {
        return {
          ok: false,
          action: 'click',
          tabId: tab.id,
          error: 'coordinate clicks need the DevTools protocol, which is unavailable',
        };
      }
      const fallback = await this.run<{ ok: boolean; error?: string }>(
        tab,
        `return B.domClick(${JSON.stringify(target)});`,
      );
      if (!fallback?.ok) {
        return { ok: false, action: 'click', tabId: tab.id, error: fallback?.error ?? 'click failed' };
      }
    }
    await delay(180);
    return await this.result(params, tab, `clicked ${located.name ?? located.role ?? 'element'}`);
  }

  private async type(params: BrowserExecParams): Promise<BrowserExecResult> {
    const tab = this.requireActive(params.tabId);
    const text = params.text ?? '';
    const located = await this.locate(tab, params);
    await this.moveCursor(tab, located, params.label ?? `type into ${located.name ?? 'field'}`, 'type');

    // Focus first: insertText only reaches the focused element, and a page may have its own
    // idea of what "focused" means until it sees a click.
    await this.dispatchClick(tab, located.point);
    await delay(this.cursorOn() ? CURSOR_LEAD_MS : 0);

    const client = await this.cdp(tab);
    if (client) {
      await client.sendCommand('Input.insertText', { text });
    } else {
      const fallback = await this.run<{ ok: boolean; error?: string }>(
        tab,
        `return B.domType(${JSON.stringify({ ref: params.ref, selector: params.selector })}, ${JSON.stringify(text)});`,
      );
      if (!fallback?.ok) {
        return { ok: false, action: 'type', tabId: tab.id, error: fallback?.error ?? 'typing failed' };
      }
    }
    await delay(120);
    return await this.result(params, tab, `typed ${text.length} character(s) into ${located.name ?? 'the focused field'}`);
  }

  private async pressKey(params: BrowserExecParams): Promise<BrowserExecResult> {
    const tab = this.requireActive(params.tabId);
    const key = params.key ?? 'Enter';
    const client = await this.cdp(tab);
    let ok = false;
    if (client && KEY_CODES[key]) {
      const info = KEY_CODES[key];
      await client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.vk,
        nativeVirtualKeyCode: info.vk,
        ...(info.text ? { text: info.text, unmodifiedText: info.text } : {}),
      });
      await client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.vk,
        nativeVirtualKeyCode: info.vk,
      });
      ok = true;
    } else {
      const fallback = await this.run<{ ok: boolean; error?: string }>(tab, `return B.domKey(${JSON.stringify(key)});`);
      ok = fallback?.ok === true;
      if (!ok) return { ok: false, action: 'key', tabId: tab.id, error: fallback?.error ?? `key "${key}" is not supported` };
    }
    await delay(200);
    return await this.result(params, tab, `pressed ${key}`);
  }

  private async scroll(params: BrowserExecParams): Promise<BrowserExecResult> {
    const tab = this.requireActive(params.tabId);
    const deltaY = Number.isFinite(params.deltaY) ? Number(params.deltaY) : 600;
    const client = await this.cdp(tab);
    if (client) {
      const viewport = this.bounds;
      await client.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.max(1, Math.round(viewport.width / 2)),
        y: Math.max(1, Math.round(viewport.height / 2)),
        deltaX: 0,
        deltaY,
      });
    } else {
      await this.run(tab, `return B.domScroll(${JSON.stringify(deltaY)});`);
    }
    await delay(180);
    return await this.result(params, tab, `scrolled ${deltaY > 0 ? 'down' : 'up'} ${Math.abs(deltaY)} px`);
  }

  private async hover(params: BrowserExecParams): Promise<BrowserExecResult> {
    const tab = this.requireActive(params.tabId);
    const located = await this.locate(tab, params);
    await this.moveCursor(tab, located, params.label ?? `hover ${located.name ?? 'element'}`, 'move');
    const client = await this.cdp(tab);
    if (client) {
      await client.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: located.point.x,
        y: located.point.y,
        button: 'none',
      });
    }
    return await this.result(params, tab, `moved to ${located.name ?? located.role ?? 'element'}`, false);
  }

  /**
   * Poll the page until a condition holds. Polling lives here rather than in the page so a
   * pending `wait` can never outlive the tool call or keep a document busy.
   */
  private async waitFor(params: BrowserExecParams): Promise<BrowserExecResult> {
    const tab = this.requireActive(params.tabId);
    const condition = params.condition ?? 'ready';
    const needle = (params.value ?? params.text ?? '').toLowerCase();
    const timeout = Math.min(Math.max(params.timeoutMs ?? 8000, 250), 60_000);
    const started = Date.now();

    while (Date.now() - started < timeout) {
      if (tab.view.webContents.isDestroyed()) break;
      if (condition === 'text') {
        const probe = await this.snapshot(tab).catch(() => undefined);
        if (probe && needle && probe.text.toLowerCase().includes(needle)) {
          return await this.result(params, tab, `text "${needle}" appeared after ${Date.now() - started}ms`, false);
        }
      } else {
        const ready = await this.run<{ ready: boolean }>(
          tab,
          `return { ready: document.readyState === 'complete' };`,
        ).catch(() => undefined);
        if (ready?.ready === true && !tab.loading) {
          return await this.result(params, tab, `page ready after ${Date.now() - started}ms`, false);
        }
      }
      await delay(250);
    }
    return {
      ok: false,
      action: 'wait',
      tabId: tab.id,
      error:
        condition === 'text'
          ? `text "${needle}" did not appear within ${timeout}ms`
          : `page was not ready within ${timeout}ms`,
    };
  }

  /* ------------------------------------------------------------------ helpers */

  private async result(
    params: BrowserExecParams,
    tab: Tab | undefined,
    message: string,
    withSnapshot = true,
  ): Promise<BrowserExecResult> {
    this.lastAction = { action: params.action, label: params.label, at: new Date().toISOString() };
    const result: BrowserExecResult = {
      ok: true,
      action: params.action,
      tabId: tab?.id ?? this.activeId,
      state: this.state(),
      message,
    };
    // Reading the page back right after an action saves the agent a round trip and shows it
    // the effect of what it just did. Never fatal: a page mid-navigation has no DOM yet.
    if (withSnapshot && params.includeSnapshot !== false && tab && SNAPSHOT_ACTIONS.has(params.action)) {
      const snapshot = await this.snapshot(tab).catch(() => undefined);
      if (snapshot) result.snapshot = snapshot;
    }
    return result;
  }

  private normalizeUrl(input: string | undefined): string {
    const raw = (input ?? '').trim();
    if (!raw) return this.opts.config().homeUrl;
    if (raw === 'about:blank') return raw;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    if (!isAllowedNavigation(withScheme)) {
      throw new Error(`"${raw}" is not an http(s) URL; the internal browser does not open other schemes`);
    }
    return withScheme;
  }

  private activeTab(): Tab | undefined {
    return this.activeId ? this.tabs.get(this.activeId) : undefined;
  }

  private requireActive(tabId?: string): Tab {
    if (tabId) {
      const tab = this.tabs.get(tabId);
      if (!tab) throw new Error(`unknown tab "${tabId}"`);
      return tab;
    }
    const tab = this.activeTab();
    if (!tab) throw new Error('no browser tab is open — call browser_open first');
    tab.lastUsed = Date.now();
    return tab;
  }

  private createTab(url: string): Tab {
    const config = this.opts.config();
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession({
            persistSession: config.persistSession,
            workspace: this.opts.workspaceRoot?.(),
          }),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        devTools: false,
        spellcheck: false,
        backgroundThrottling: false,
        javascript: config.allowScripts,
      },
    });
    view.setBackgroundColor('#111318');

    const tab: Tab = {
      id: `tab-${++this.sequence}`,
      view,
      url,
      title: '',
      loading: false,
      lastUsed: Date.now(),
    };
    const contents = view.webContents;

    // A page never gets to open windows, never navigates itself to a non-web scheme, and
    // never replaces the tab the agent is driving with a custom protocol handler.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, target) => {
      if (!isAllowedNavigation(target)) {
        event.preventDefault();
        this.opts.log?.('warn', `[browser] blocked navigation to ${target}`);
      }
    });
    contents.on('will-redirect', (event, target) => {
      if (!isAllowedNavigation(target)) event.preventDefault();
    });

    contents.on('page-title-updated', (_event, title) => {
      tab.title = title;
      this.emit();
    });
    contents.on('did-start-loading', () => {
      tab.loading = true;
      this.emit();
    });
    contents.on('did-stop-loading', () => {
      tab.loading = false;
      this.emit();
    });
    contents.on('did-navigate', (_event, target) => {
      tab.url = target;
      this.emit();
    });
    contents.on('did-navigate-in-page', (_event, target) => {
      tab.url = target;
      this.emit();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.opts.log?.('warn', `[browser] renderer gone (${details.reason}) in ${tab.id}`);
    });
    // Re-install the cursor overlay after every navigation: the document it lived in is gone.
    contents.on('dom-ready', () => {
      void this.paintCursor(tab).catch(() => undefined);
    });

    this.tabs.set(tab.id, tab);
    this.enforceTabCap();
    return tab;
  }

  /** Close the least recently used inactive tab when the cap is exceeded. */
  private enforceTabCap(): void {
    const cap = Math.max(1, this.opts.config().maxTabs || 4);
    while (this.tabs.size > cap) {
      const victim = [...this.tabs.values()]
        .filter((tab) => tab.id !== this.activeId)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) break;
      this.closeTab(victim.id);
    }
  }

  private activate(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.activeId = tabId;
    tab.lastUsed = Date.now();
    this.syncView();
    tab.view.webContents.focus();
  }

  /**
   * Close every tab — the renderer's window-control `✕`. Hiding alone would leave the
   * sandboxed views alive with nothing on screen to reach them.
   */
  private closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.closeTab(id);
    this.hide();
    this.emit();
  }

  /**
   * The workspace changed: drop every tab. A tab keeps the partition it was born with, so
   * leaving one open would carry the previous workspace's cookies into the new one.
   */
  resetWorkspace(): void {
    this.closeAll();
  }

  private closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    this.attached.delete(tabId);
    const win = this.opts.getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(tab.view);
      } catch {
        /* view was never attached */
      }
    }
    try {
      tab.view.webContents.close();
    } catch {
      /* already gone */
    }
    if (this.activeId === tabId) {
      const next = [...this.tabs.values()].sort((a, b) => b.lastUsed - a.lastUsed)[0];
      this.activeId = next?.id;
      if (next) this.activate(next.id);
    }
    if (this.tabs.size === 0) {
      this.visible = false;
      this.syncView();
    }
  }

  /** Attach exactly one view (the active, visible tab) to the window at the renderer's rect. */
  private syncView(): void {
    const win = this.opts.getWindow();
    if (!win || win.isDestroyed()) return;
    for (const tab of this.tabs.values()) {
      const isActive = tab.id === this.activeId;
      const show = this.visible && isActive && this.bounds.width > 1 && this.bounds.height > 1;
      const alreadyAttached = this.attached.has(tab.id);
      if (show && !alreadyAttached) {
        win.contentView.addChildView(tab.view);
        this.attached.add(tab.id);
      } else if (!show && alreadyAttached) {
        win.contentView.removeChildView(tab.view);
        this.attached.delete(tab.id);
      }
      if (show) {
        tab.view.setBounds({
          x: Math.max(0, this.bounds.x),
          y: Math.max(0, this.bounds.y),
          width: Math.max(1, this.bounds.width),
          height: Math.max(1, this.bounds.height),
        });
      }
    }
  }

  private async load(tab: Tab, url: string): Promise<void> {
    tab.url = url;
    tab.loading = true;
    this.emit();
    try {
      await tab.view.webContents.loadURL(url);
    } catch (error) {
      const message = messageOf(error);
      // A redirect aborts the original load; that is navigation, not failure.
      if (!/ERR_ABORTED/i.test(message)) throw new Error(`${url}: ${message}`);
    } finally {
      tab.loading = false;
      this.emit();
    }
  }

  /** Give a navigation started by a click/reload a moment to commit before reading the DOM. */
  private async settle(tab: Tab, timeoutMs = 3000): Promise<void> {
    const started = Date.now();
    while (tab.loading && Date.now() - started < timeoutMs) await delay(100);
  }

  /* ------------------------------------------------------------------ the page */

  /**
   * Evaluate `body` inside the page's isolated world. The bridge install is prepended, so a
   * single round trip both guarantees the API exists and runs the action.
   */
  private async run<T>(tab: Tab, body: string): Promise<T> {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) throw new Error('the tab was closed');
    const code = `${agentBootstrapSource()}\n;(function(){var B=globalThis.__beeCodeBrowser;${body}})();`;
    return (await contents.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code }], false)) as T;
  }

  private async snapshot(tab: Tab): Promise<BrowserSnapshot> {
    const raw = await this.run<{
      url?: string;
      title?: string;
      text?: string;
      truncated?: boolean;
      viewport?: { width: number; height: number; scrollX: number; scrollY: number };
      elements?: BrowserSnapshot['elements'];
    }>(tab, 'return B.snapshot();');

    // The page is untrusted input: clamp what comes back instead of trusting its shape.
    if (raw?.url) tab.url = raw.url;
    if (raw?.title) tab.title = raw.title;

    return {
      tabId: tab.id,
      url: raw?.url ?? tab.url,
      title: raw?.title ?? tab.title,
      loading: tab.loading,
      text: typeof raw?.text === 'string' ? raw.text : '',
      elements: Array.isArray(raw?.elements) ? raw.elements : [],
      viewport: raw?.viewport ?? { width: 0, height: 0, scrollX: 0, scrollY: 0 },
      truncated: raw?.truncated === true,
    };
  }

  private async locate(tab: Tab, params: BrowserExecParams): Promise<Located> {
    const target = { ref: params.ref, selector: params.selector, x: params.x, y: params.y };
    const raw = await this.run<Located & { ok: boolean; error?: string }>(
      tab,
      `return B.resolve(${JSON.stringify(target)});`,
    );
    if (!raw?.ok) throw new Error(raw?.error ?? 'could not resolve the target element');
    return raw;
  }

  private async moveCursor(tab: Tab, located: Located, label: string, kind: 'click' | 'type' | 'move'): Promise<void> {
    if (!this.cursorOn()) return;
    const spot = { x: located.point.x, y: located.point.y, label, kind };
    const mark = located.rect ?? null;
    // Cursor moves are cosmetic: a page that blocks the injection must not fail the action.
    await this.run(tab, `B.cursor.marker(${JSON.stringify(mark)});return B.cursor.move(${JSON.stringify(spot)});`).catch(
      () => undefined,
    );
  }

  private async paintCursor(tab: Tab): Promise<void> {
    if (!this.cursorOn()) {
      await this.run(tab, 'return B.cursor.hide();').catch(() => undefined);
      return;
    }
    await this.run(tab, 'return B.cursor.move({x:-200,y:-200,label:""});').catch(() => undefined);
  }

  /* --------------------------------------------------------------- trusted input */

  private async cdp(tab: Tab): Promise<CdpClient | undefined> {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return undefined;
    try {
      const debuggerClient = contents.debugger;
      if (!debuggerClient.isAttached()) debuggerClient.attach('1.3');
      return debuggerClient as unknown as CdpClient;
    } catch (error) {
      this.opts.log?.('warn', `[browser] DevTools protocol unavailable, falling back to DOM: ${messageOf(error)}`);
      return undefined;
    }
  }

  private async dispatchClick(tab: Tab, point: Point): Promise<boolean> {
    const client = await this.cdp(tab);
    if (!client) return false;
    const base = { x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 };
    await client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y, button: 'none' });
    await client.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    return true;
  }

  /* -------------------------------------------------------------------- lifecycle */

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.tabs.keys()]) this.closeTab(id);
    this.emit();
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

export { SNAPSHOT_ACTIONS };
