export interface WindowInfo {
  /** Platform handle as a string (HWND on Windows); stable for the session. */
  handle: string;
  title: string;
  processId: number;
  /** Process image name, e.g. `notepad.exe`. */
  exe?: string;
  isForeground: boolean;
}

export interface UiNode {
  index: number;
  name: string;
  controlType: string;
  automationId: string;
  enabled: boolean;
  patterns: string[];
  value?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ElementSelector {
  automationId?: string;
  name?: string;
  controlType?: string;
  /** Positional index in the flattened tree, from a previous `uiTree` call. */
  index?: number;
}

export interface ScreenshotResult {
  /** base64 PNG (no data: prefix). */
  png: string;
  width: number;
  height: number;
}

/**
 * Everything the agent can do to the desktop goes through this interface, which makes
 * the permission layer testable (MockDriver) and the platform layer replaceable
 * (a macOS/RDP driver can implement the same surface later).
 */
export interface DesktopDriver {
  readonly name: string;
  listWindows(): Promise<WindowInfo[]>;
  foregroundWindow(): Promise<WindowInfo | undefined>;
  resolveWindow(handle: string): Promise<WindowInfo | undefined>;
  activate(handle: string): Promise<void>;
  close(handle: string): Promise<void>;
  uiTree(handle: string, maxDepth: number, maxNodes: number): Promise<UiNode[]>;
  invoke(handle: string, selector: ElementSelector): Promise<{ ok: boolean; detail: string }>;
  setValue(handle: string, selector: ElementSelector, value: string): Promise<{ ok: boolean; detail: string }>;
  typeText(handle: string, text: string): Promise<void>;
  sendKeys(handle: string, keys: string): Promise<void>;
  /**
   * Real mouse click at absolute screen coordinates (the same space as `UiNode.bounds`, so
   * a point taken from the automation tree can be replayed directly). Used where a control
   * exposes no InvokePattern — custom-drawn canvases, charts, menus.
   */
  click(handle: string, x: number, y: number): Promise<{ x: number; y: number }>;
  /** Resizes the window's outer frame; returns the size actually applied after clamping. */
  resize(handle: string, width: number, height: number): Promise<{ width: number; height: number }>;
  screenshot(handle?: string): Promise<ScreenshotResult>;
  launch(exePath: string, args: string[], cwd?: string): Promise<{ processId?: number; detail: string }>;
}

/**
 * Bounds shared by every driver so the containment and clamp rules the permission layer
 * relies on are identical in tests and on a real desktop.
 */
export const WINDOW_LIMITS = {
  minWidth: 200,
  minHeight: 120,
  maxWidth: 6000,
  maxHeight: 4000,
} as const;

/** Rounds and clamps a requested size to what a window manager can actually apply. */
export function clampSize(width: number, height: number): { width: number; height: number } {
  const fit = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)));
  return {
    width: fit(width, WINDOW_LIMITS.minWidth, WINDOW_LIMITS.maxWidth),
    height: fit(height, WINDOW_LIMITS.minHeight, WINDOW_LIMITS.maxHeight),
  };
}

/**
 * True when the point lies inside the window frame. Clicking is refused outside it: the
 * policy grants control of *this* app, and a stray pixel would otherwise land on whatever
 * happens to be underneath.
 */
export function containsPoint(
  box: { x: number; y: number; width: number; height: number },
  x: number,
  y: number,
): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= box.x &&
    y >= box.y &&
    x < box.x + box.width &&
    y < box.y + box.height
  );
}
