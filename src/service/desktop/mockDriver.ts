import type { DesktopDriver, ElementSelector, ScreenshotResult, UiNode, WindowInfo } from './types';
import { clampSize, containsPoint } from './types';

interface MockWindow extends WindowInfo {
  nodes: UiNode[];
  text: string;
  /** Screen-space frame, so click containment can be exercised like on a real desktop. */
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Deterministic in-memory desktop used by tests, CI and `desktop.driver: "mock"`.
 * It implements the same contract as the Windows driver, so the permission layer,
 * tool layer and agent loop can be exercised end-to-end without a real screen.
 */
export class MockDriver implements DesktopDriver {
  readonly name = 'mock';
  private windows: MockWindow[] = [];
  private nextHandle = 1000;
  /** Append-only trace of driver calls — asserted by tests. */
  readonly calls: Array<{ op: string; detail: unknown }> = [];

  constructor() {
    this.seed();
  }

  private seed(): void {
    this.windows = [
      {
        handle: String(this.nextHandle++),
        title: 'MockPad — Untitled',
        processId: 4242,
        exe: 'notepad.exe',
        isForeground: true,
        text: '',
        bounds: { x: 100, y: 100, width: 800, height: 600 },
        nodes: [
          {
            index: 0,
            name: 'MockPad',
            controlType: 'Window',
            automationId: 'MainWindow',
            enabled: true,
            patterns: [],
          },
          {
            index: 1,
            name: 'Text editor',
            controlType: 'Document',
            automationId: 'Editor',
            enabled: true,
            patterns: ['value'],
            value: '',
          },
          {
            index: 2,
            name: 'Save',
            controlType: 'Button',
            automationId: 'SaveButton',
            enabled: true,
            patterns: ['invoke'],
          },
          {
            index: 3,
            name: 'Close',
            controlType: 'Button',
            automationId: 'CloseButton',
            enabled: true,
            patterns: ['invoke'],
          },
        ],
      },
    ];
  }

  async listWindows(): Promise<WindowInfo[]> {
    this.calls.push({ op: 'listWindows', detail: this.windows.length });
    return this.windows.map(({ nodes, text, ...w }) => ({ ...w }));
  }

  async foregroundWindow(): Promise<WindowInfo | undefined> {
    const fg = this.windows.find((w) => w.isForeground) ?? this.windows[0];
    if (!fg) return undefined;
    const { nodes, text, ...rest } = fg;
    return { ...rest };
  }

  async resolveWindow(handle: string): Promise<WindowInfo | undefined> {
    const w = this.find(handle);
    if (!w) return undefined;
    const { nodes, text, ...rest } = w;
    return { ...rest };
  }

  async activate(handle: string): Promise<void> {
    const w = this.require(handle);
    for (const other of this.windows) other.isForeground = other.handle === w.handle;
    this.calls.push({ op: 'activate', detail: w.title });
  }

  async close(handle: string): Promise<void> {
    const w = this.require(handle);
    this.windows = this.windows.filter((x) => x.handle !== w.handle);
    this.calls.push({ op: 'close', detail: w.title });
  }

  async uiTree(handle: string): Promise<UiNode[]> {
    const w = this.require(handle);
    this.calls.push({ op: 'uiTree', detail: w.title });
    return w.nodes.map((n) => ({ ...n }));
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
    node.value = value;
    return { ok: true, detail: 'value set (mock)' };
  }

  async typeText(handle: string, text: string): Promise<void> {
    const w = this.require(handle);
    w.text += text;
    const editor = w.nodes.find((n) => n.automationId === 'Editor');
    if (editor) editor.value = w.text;
    this.calls.push({ op: 'typeText', detail: text });
  }

  async sendKeys(handle: string, keys: string): Promise<void> {
    const w = this.require(handle);
    this.calls.push({ op: 'sendKeys', detail: keys });
    if (/^[~%^]*(n|\{ENTER\})$/i.test(keys)) w.text += '\n';
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

  async screenshot(handle?: string): Promise<ScreenshotResult> {
    this.calls.push({ op: 'screenshot', detail: handle ?? 'screen' });
    // 1x1 transparent PNG — enough for the pipeline, no dependency on a real display.
    return {
      png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      width: 1,
      height: 1,
    };
  }

  async launch(exePath: string, args: string[]): Promise<{ processId?: number; detail: string }> {
    const exe = exePath.split(/[\\/]/).pop() ?? exePath;
    if (!this.windows.some((w) => w.exe?.toLowerCase() === exe.toLowerCase())) {
      this.windows.push({
        handle: String(this.nextHandle++),
        title: `${exe} — mock window`,
        processId: 5000 + this.windows.length,
        exe,
        isForeground: false,
        text: '',
        bounds: { x: 120, y: 120, width: 900, height: 700 },
        nodes: [
          { index: 0, name: exe, controlType: 'Window', automationId: 'MainWindow', enabled: true, patterns: [] },
          { index: 1, name: 'Text editor', controlType: 'Document', automationId: 'Editor', enabled: true, patterns: ['value'] },
        ],
      });
    }
    this.calls.push({ op: 'launch', detail: { exePath, args } });
    return { processId: 5000 + this.windows.length, detail: `launched ${exe} (mock)` };
  }

  private find(handle: string): MockWindow | undefined {
    return this.windows.find((w) => w.handle === handle);
  }

  private require(handle: string): MockWindow {
    const w = this.find(handle);
    if (!w) throw new Error(`mock window ${handle} not found`);
    return w;
  }

  private findNode(w: MockWindow, selector: ElementSelector): UiNode | undefined {
    if (Number.isInteger(selector.index)) return w.nodes[Number(selector.index)];
    return w.nodes.find(
      (n) =>
        (!selector.automationId || n.automationId === selector.automationId) &&
        (!selector.name || n.name === selector.name) &&
        (!selector.controlType || n.controlType === selector.controlType),
    );
  }
}
