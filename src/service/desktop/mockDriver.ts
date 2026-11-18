import type {
  DesktopDriver,
  ElementSelector,
  LaunchResult,
  ScreenshotResult,
  TextReadback,
  TypeResult,
  UiNode,
  UiTreeResult,
  WindowBounds,
  WindowInfo,
} from './types';
import { TEXT_PREFIX_LIMIT, clampSize, containsPoint } from './types';

interface MockWindow extends WindowInfo {
  nodes: UiNode[];
  /** Simulated document buffer, so `readText` can prove that a mutation landed. */
  text: string;
  /** Caret offset inside `text`. */
  caret: number;
  /** Screen-space frame, so click containment can be exercised like on a real desktop. */
  bounds: WindowBounds;
}

/** 1x1 transparent PNG — enough for the pipeline, no dependency on a real display. */
const BLANK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

type KeyToken = { plain?: string; name?: string; mods: string };

/**
 * Splits a SendKeys string into printable characters and named keys (`{ENTER}`, `^{END}` …).
 * A caret/plus/percent prefix is kept with the token it modifies.
 */
function tokenizeKeys(keys: string): KeyToken[] {
  const out: KeyToken[] = [];
  let i = 0;
  while (i < keys.length) {
    const ch = keys[i] ?? '';
    if ('^+%'.includes(ch) && keys[i + 1] === '{') {
      const close = keys.indexOf('}', i + 2);
      if (close < 0) break;
      out.push({ name: keys.slice(i + 2, close), mods: ch });
      i = close + 1;
      continue;
    }
    if (ch === '^' && i + 1 < keys.length) {
      out.push({ name: keys[i + 1] ?? '', mods: '^' });
      i += 2;
      continue;
    }
    if (ch === '{') {
      const close = keys.indexOf('}', i + 1);
      if (close < 0) break;
      out.push({ name: keys.slice(i + 1, close), mods: '' });
      i = close + 1;
      continue;
    }
    if (ch === '~') {
      out.push({ name: 'ENTER', mods: '' });
      i += 1;
      continue;
    }
    out.push({ plain: ch, mods: '' });
    i += 1;
  }
  return out;
}

/**
 * Deterministic in-memory desktop used by tests, CI and `desktop.driver: "mock"`.
 * It implements the same contract as the Windows driver, so the permission layer,
 * tool layer and agent loop can be exercised end-to-end without a real screen.
 *
 * The mock deliberately reproduces the awkward cases the real layer has to survive:
 * a window identity that is stable for the window's lifetime, a launch that hands the
 * document to an already running instance (no new window, spawner pid ≠ owner pid),
 * and an observable document buffer so a mutation can be proven instead of assumed.
 */
export class MockDriver implements DesktopDriver {
  readonly name = 'mock';
  private windows: MockWindow[] = [];
  private nextHandle = 1000;
  private nextSpawnerPid = 9000;
  /** Executables that hand a second launch to the running instance (Win11 tabbed Notepad). */
  private readonly handoffExe: Set<string>;
  /** Append-only trace of driver calls — asserted by tests. */
  readonly calls: Array<{ op: string; detail: unknown }> = [];

  constructor(options: { handoffExe?: string[] } = {}) {
    this.handoffExe = new Set((options.handoffExe ?? ['notepad.exe']).map((e) => e.toLowerCase()));
    this.seed();
  }

  /**
   * Test hook: change a window's observed state without going through the OS, so a test can
   * prove the driver refuses an impossible request (a cloaked capture, a minimised window, a
   * dead handle) instead of quietly substituting something else. Unknown handle -> false.
   */
  simulate(
    handle: string,
    patch: Partial<
      Pick<
        WindowInfo,
        | 'title'
        | 'isForeground'
        | 'isVisible'
        | 'isMinimized'
        | 'isCloaked'
        | 'isOffscreen'
        | 'virtualDesktop'
        | 'bounds'
      >
    >,
  ): boolean {
    const w = this.find(handle);
    if (!w) return false;
    Object.assign(w, patch);
    return true;
  }

  private seed(): void {
    const bounds: WindowBounds = { x: 100, y: 100, width: 800, height: 600 };
    this.windows = [
      {
        handle: String(this.nextHandle++),
        title: 'MockPad — Untitled',
        processId: 4242,
        exe: 'notepad.exe',
        className: 'MockPadWindow',
        isForeground: true,
        isVisible: true,
        isMinimized: false,
        isCloaked: false,
        isOffscreen: false,
        virtualDesktop: 'current',
        bounds,
        text: '',
        caret: 0,
        nodes: this.defaultNodes(bounds),
      },
    ];
  }

  /** A window body with one editable document and two buttons. */
  private defaultNodes(bounds: WindowBounds): UiNode[] {
    return [
      {
        index: 0,
        depth: 0,
        name: 'MockPad',
        controlType: 'Window',
        automationId: 'MainWindow',
        className: 'MockPadWindow',
        enabled: true,
        isOffscreen: false,
        patterns: [],
        bounds: { ...bounds },
      },
      {
        index: 1,
        depth: 1,
        name: 'Text editor',
        controlType: 'Document',
        automationId: 'Editor',
        className: 'MockPadEdit',
        enabled: true,
        isOffscreen: false,
        patterns: ['value', 'text'],
        value: '',
        text: '',
        textLength: 0,
        textTruncated: false,
      },
      {
        index: 2,
        depth: 1,
        name: 'Save',
        controlType: 'Button',
        automationId: 'SaveButton',
        className: 'Button',
        enabled: true,
        isOffscreen: false,
        patterns: ['invoke'],
      },
      {
        index: 3,
        depth: 1,
        name: 'Close',
        controlType: 'Button',
        automationId: 'CloseButton',
        className: 'Button',
        enabled: true,
        isOffscreen: false,
        patterns: ['invoke'],
      },
    ];
  }

  async listWindows(): Promise<WindowInfo[]> {
    this.calls.push({ op: 'listWindows', detail: this.windows.length });
    return this.windows.map((w) => this.snapshot(w));
  }

  async foregroundWindow(): Promise<WindowInfo | undefined> {
    const w = this.windows.find((x) => x.isForeground);
    return w ? this.snapshot(w) : undefined;
  }

  async resolveWindow(handle: string): Promise<WindowInfo | undefined> {
    const w = this.find(handle);
    return w ? this.snapshot(w) : undefined;
  }

  async activate(handle: string): Promise<WindowInfo> {
    const w = this.require(handle);
    for (const other of this.windows) other.isForeground = other.handle === w.handle;
    w.isMinimized = false;
    this.calls.push({ op: 'activate', detail: w.title });
    return this.snapshot(w);
  }

  async close(handle: string): Promise<void> {
    const w = this.require(handle);
    this.windows = this.windows.filter((x) => x.handle !== w.handle);
    this.calls.push({ op: 'close', detail: w.title });
  }

  async uiTree(handle: string, maxDepth = 6, maxNodes = 200): Promise<UiTreeResult> {
    const w = this.require(handle);
    this.calls.push({ op: 'uiTree', detail: { handle, maxDepth, maxNodes } });
    const inDepth = w.nodes.filter((n) => n.depth <= maxDepth);
    const nodes = inDepth.slice(0, Math.max(1, maxNodes)).map((n) => ({ ...n }));
    return {
      window: this.snapshot(w),
      nodes,
      // Reported, never silently swallowed: the caller can ask for less depth or a subtree.
      truncated: inDepth.length > nodes.length,
      expanded: 0,
    };
  }

  async invoke(handle: string, selector: ElementSelector): Promise<{ ok: boolean; detail: string }> {
    const w = this.require(handle);
    const node = this.findNode(w, selector);
    this.calls.push({ op: 'invoke', detail: selector });
    if (!node) return { ok: false, detail: 'no element matched the selector (mock)' };
    if (node.automationId === 'CloseButton') {
      this.windows = this.windows.filter((x) => x.handle !== w.handle);
      return { ok: true, detail: 'window closed via mock CloseButton' };
    }
    return { ok: true, detail: `invoked ${node.automationId || node.name} (mock)` };
  }

  async setValue(handle: string, selector: ElementSelector, value: string): Promise<{ ok: boolean; detail: string }> {
    const w = this.require(handle);
    const node = this.findNode(w, selector);
    this.calls.push({ op: 'setValue', detail: { selector, value } });
    if (!node) return { ok: false, detail: 'no element matched the selector (mock)' };
    if (!node.patterns.includes('value')) {
      return { ok: false, detail: `${node.controlType} does not expose ValuePattern (mock)` };
    }
    if (node.automationId === 'Editor') {
      w.text = value;
      w.caret = value.length;
      this.syncDocument(w);
    } else {
      node.value = value;
      node.text = value;
      node.textLength = value.length;
      node.textTruncated = value.length > TEXT_PREFIX_LIMIT;
    }
    return { ok: true, detail: `set value of ${node.automationId || node.name} (mock)` };
  }

  async readText(handle: string, selector?: ElementSelector): Promise<TextReadback> {
    const w = this.require(handle);
    this.calls.push({ op: 'readText', detail: { handle, selector } });
    const node = selector ? this.findNode(w, selector) : this.documentNode(w);
    if (!node) {
      throw new Error(
        `no text-bearing element in "${w.title}" (handle ${handle}): the element exposes neither TextPattern nor ValuePattern`,
      );
    }
    return this.readbackOfNode(w, node);
  }

  async typeText(handle: string, text: string): Promise<TypeResult> {
    const w = this.require(handle);
    const before = this.readbackOf(w);
    this.insert(w, text);
    this.calls.push({ op: 'typeText', detail: { handle, length: text.length } });
    return this.typeResult(w, before, text, text.length);
  }

  async sendKeys(handle: string, keys: string): Promise<TypeResult> {
    const w = this.require(handle);
    const before = this.readbackOf(w);
    let inserted = '';
    for (const token of tokenizeKeys(keys)) inserted += this.applyKey(w, token);
    this.calls.push({ op: 'sendKeys', detail: { handle, keys } });
    return this.typeResult(w, before, inserted, inserted.length);
  }

  async click(handle: string, x: number, y: number): Promise<{ x: number; y: number }> {
    const w = this.require(handle);
    this.calls.push({ op: 'click', detail: { handle, x, y } });
    if (!containsPoint(w.bounds, x, y)) {
      throw new Error(`point ${x},${y} is outside ${w.title} (${JSON.stringify(w.bounds)})`);
    }
    return { x, y };
  }

  async resize(handle: string, width: number, height: number): Promise<{ width: number; height: number }> {
    const w = this.require(handle);
    const size = clampSize(width, height);
    w.bounds = { ...w.bounds, ...size };
    this.calls.push({ op: 'resize', detail: { handle, ...size } });
    return size;
  }

  async screenshot(handle: string): Promise<ScreenshotResult> {
    const w = this.require(handle);
    this.calls.push({ op: 'screenshot', detail: { handle } });
    const reason = this.captureBlocker(w);
    if (reason) {
      // Loud, never a screen grab in place of the window's pixels.
      throw new Error(`cannot capture window ${handle} ("${w.title}"): ${reason}`);
    }
    return {
      png: BLANK_PNG,
      width: Math.min(w.bounds.width, 4096),
      height: Math.min(w.bounds.height, 4096),
      source: 'window',
      handle,
    };
  }

  async launch(exePath: string, args: string[], cwd?: string): Promise<LaunchResult> {
    void cwd;
    const exe = exePath.split(/[\\/]/).pop() ?? exePath;
    const spawnerPid = this.nextSpawnerPid++;
    this.calls.push({ op: 'launch', detail: { exe, args } });
    const running = this.windows.find((w) => w.exe?.toLowerCase() === exe.toLowerCase());

    if (running && this.handoffExe.has(exe.toLowerCase())) {
      // Win11 Notepad: the launcher exits and the document lands in a tab of the live window.
      return {
        spawnerProcessId: spawnerPid,
        window: this.snapshot(running),
        windowCreated: false,
        tabAdded: true,
        detail: `${exe} handed the document to the running instance — no new window; use handle ${running.handle} (pid ${running.processId})`,
      };
    }
    if (running) {
      return {
        spawnerProcessId: spawnerPid,
        window: this.snapshot(running),
        windowCreated: false,
        tabAdded: false,
        detail: `${exe} was already running; no new window was created — use handle ${running.handle} (pid ${running.processId})`,
      };
    }

    const bounds: WindowBounds = { x: 120, y: 120, width: 800, height: 600 };
    const created: MockWindow = {
      handle: String(this.nextHandle++),
      title: `${exe} — mock window`,
      processId: spawnerPid,
      exe,
      className: 'MockWindow',
      isForeground: true,
      isVisible: true,
      isMinimized: false,
      isCloaked: false,
      isOffscreen: false,
      virtualDesktop: 'current',
      bounds,
      text: '',
      caret: 0,
      nodes: this.defaultNodes(bounds),
    };
    for (const other of this.windows) other.isForeground = false;
    this.windows.push(created);
    return {
      spawnerProcessId: spawnerPid,
      window: this.snapshot(created),
      windowCreated: true,
      tabAdded: false,
      detail: `launched ${exe} (pid ${spawnerPid}, handle ${created.handle})`,
    };
  }

  /* ------------------------------------------------------------------ internals */

  private snapshot(w: MockWindow): WindowInfo {
    const { nodes, text, caret, ...info } = w;
    void nodes;
    void text;
    void caret;
    return { ...info, bounds: { ...w.bounds } };
  }

  private find(handle: string): MockWindow | undefined {
    return this.windows.find((w) => w.handle === handle);
  }

  private require(handle: string): MockWindow {
    const w = this.find(handle);
    if (!w) throw new Error(`window ${handle} no longer exists (mock)`);
    return w;
  }

  /** Why a window's own pixels cannot be captured, or `undefined` when they can. */
  private captureBlocker(w: MockWindow): string | undefined {
    if (!w.isVisible) return 'it is not visible (WS_VISIBLE unset)';
    if (w.isMinimized) return 'it is minimized';
    if (w.isCloaked) return 'it is cloaked (another virtual desktop or a suspended packaged app)';
    if (w.isOffscreen) return 'no part of its frame intersects a monitor';
    if (w.bounds.width <= 0 || w.bounds.height <= 0) return 'its frame has no area';
    return undefined;
  }

  private documentNode(w: MockWindow): UiNode | undefined {
    return w.nodes.find((n) => n.automationId === 'Editor') ?? w.nodes.find((n) => /Document|Edit/.test(n.controlType));
  }

  private readbackOf(w: MockWindow): TextReadback | undefined {
    const node = this.documentNode(w);
    return node ? this.readbackOfNode(w, node) : undefined;
  }

  private readbackOfNode(w: MockWindow, node: UiNode): TextReadback {
    const full = node.automationId === 'Editor' ? w.text : node.value ?? node.text ?? '';
    return {
      handle: w.handle,
      controlType: node.controlType,
      automationId: node.automationId || undefined,
      name: node.name,
      text: full.slice(0, TEXT_PREFIX_LIMIT),
      length: full.length,
      truncated: full.length > TEXT_PREFIX_LIMIT,
      source: node.patterns.includes('text') ? 'text-pattern' : 'value',
    };
  }

  private syncDocument(w: MockWindow): void {
    for (const n of w.nodes) {
      if (n.automationId !== 'Editor') continue;
      n.value = w.text.slice(0, TEXT_PREFIX_LIMIT);
      n.text = n.value;
      n.textLength = w.text.length;
      n.textTruncated = w.text.length > TEXT_PREFIX_LIMIT;
    }
  }

  private insert(w: MockWindow, text: string): void {
    if (!text) return;
    w.text = `${w.text.slice(0, w.caret)}${text}${w.text.slice(w.caret)}`;
    w.caret += text.length;
    this.syncDocument(w);
  }

  private applyKey(w: MockWindow, token: KeyToken): string {
    if (token.plain !== undefined) {
      this.insert(w, token.plain);
      return token.plain;
    }
    const name = (token.name ?? '').toUpperCase();
    // A modifier on a navigation key means "move the caret", never "insert text".
    const modified = token.mods.includes('^');
    switch (name) {
      case 'ENTER':
      case 'RETURN':
        this.insert(w, '\n');
        return '\n';
      case 'TAB':
        this.insert(w, '\t');
        return '\t';
      case 'SPACE':
        this.insert(w, ' ');
        return ' ';
      case 'END':
        w.caret = w.text.length;
        return '';
      case 'HOME':
        w.caret = 0;
        return '';
      case 'BACKSPACE':
      case 'BS':
        if (w.caret > 0) {
          w.text = `${w.text.slice(0, w.caret - 1)}${w.text.slice(w.caret)}`;
          w.caret -= 1;
          this.syncDocument(w);
        }
        return '';
      case 'DELETE':
      case 'DEL':
        w.text = `${w.text.slice(0, w.caret)}${w.text.slice(w.caret + 1)}`;
        this.syncDocument(w);
        return '';
      default:
        // Ctrl+A and friends change selection, not text: nothing is inserted.
        if (modified) w.caret = w.text.length;
        return '';
    }
  }

  private typeResult(
    w: MockWindow,
    before: TextReadback | undefined,
    inserted: string,
    typed: number,
  ): TypeResult {
    const readback = this.readbackOf(w);
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    return {
      typed,
      readback,
      delta: before && readback ? readback.length - before.length : undefined,
      lengthBefore: before?.length,
      lengthAfter: readback?.length,
      appended: readback ? norm(w.text).endsWith(norm(inserted)) && inserted.length > 0 : false,
      verified: readback !== undefined,
    };
  }

  private findNode(w: MockWindow, selector: ElementSelector): UiNode | undefined {
    if (selector.index !== undefined) {
      const byIndex = w.nodes.find((n) => n.index === selector.index);
      if (byIndex) return byIndex;
    }
    return w.nodes.find(
      (n) =>
        (!selector.automationId || n.automationId === selector.automationId) &&
        (!selector.name || n.name === selector.name) &&
        (!selector.controlType || n.controlType === selector.controlType),
    );
  }
}
