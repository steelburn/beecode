/**
 * The observation contract of the desktop layer.
 *
 * One rule shapes everything below: **a window has exactly one identity — its platform
 * handle** — and every result that names a window carries the same five fields for it
 * (`handle`, `processId`, `title`, `exe`, `className`) plus the state flags needed to judge
 * whether it can be observed or mutated at all. A handle taken from `launch` or `focus` is
 * addressable by every other call while the window lives; nothing re-resolves "the app's
 * window" by title behind the caller's back.
 */

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which virtual desktop a window sits on, as far as the shell can tell. */
export type VirtualDesktop = 'current' | 'other' | 'unknown';

export interface WindowInfo {
  /** Platform handle as a string (HWND on Windows) — the stable identity for the window's lifetime. */
  handle: string;
  title: string;
  /**
   * Process that owns the window's content. For a hosted (UWP/packaged) window this is the
   * app process behind ApplicationFrameHost, not the frame host.
   */
  processId: number;
  /** Process image name, e.g. `notepad.exe`. */
  exe?: string;
  /** Window class name, e.g. `Notepad`, `Chrome_WidgetWin_1`. */
  className: string;
  isForeground: boolean;
  /** `WS_VISIBLE` is set on the window. A window can exist, be addressable, and still be hidden. */
  isVisible: boolean;
  isMinimized: boolean;
  /** DWM cloaked: another virtual desktop, or a suspended packaged app. */
  isCloaked: boolean;
  /** No part of the frame intersects a monitor, or the frame has no area. */
  isOffscreen: boolean;
  virtualDesktop: VirtualDesktop;
  /** Window rect in screen coordinates — omitted when the shell reports a nonsensical one. */
  bounds?: WindowBounds;
}

export interface ElementSelector {
  automationId?: string;
  name?: string;
  controlType?: string;
  /** Positional index in the flattened tree, from a previous `uiTree` call. */
  index?: number;
}

export interface UiNode {
  index: number;
  /** Depth below the window root (the root itself is 0). */
  depth: number;
  name: string;
  controlType: string;
  automationId: string;
  className: string;
  enabled: boolean;
  isOffscreen: boolean;
  /** Automation patterns the element actually *answers*, not the advertised availability flags. */
  patterns: string[];
  value?: string;
  /** Text read back from TextPattern/ValuePattern — a prefix of at most `TEXT_PREFIX_LIMIT` chars. */
  text?: string;
  /** Full length of the element's text, even when `text` was shortened. */
  textLength?: number;
  textTruncated?: boolean;
  bounds?: WindowBounds;
}

export interface UiTreeResult {
  window: WindowInfo;
  nodes: UiNode[];
  /** True when `maxNodes` cut the walk short — reported, never silently swallowed. */
  truncated: boolean;
  /** Number of collapse patterns expanded to realize a lazy (WinUI/XAML) tree. */
  expanded: number;
}

export type TextSource = 'text-pattern' | 'value' | 'wm-gettext';

export interface TextReadback {
  /** Window the text was read from. */
  handle: string;
  controlType: string;
  automationId?: string;
  name?: string;
  /** The text itself (bounded by `TEXT_PREFIX_LIMIT`). */
  text: string;
  /** Full length in characters, also when `text` is truncated. */
  length: number;
  truncated: boolean;
  source: TextSource;
}

/** Result of a keyboard mutation: what was delivered, proven by reading the text back. */
export interface TypeResult {
  /** Characters the OS accepted. */
  typed: number;
  /** Text read back after the mutation, when the target exposes it. */
  readback?: TextReadback;
  /** `readback.length - lengthBefore`, when a before/after pair was captured. */
  delta?: number;
  /** Length before the mutation, when a before/after pair was captured. */
  lengthBefore?: number;
  /** Length after the mutation, when a before/after pair was captured. */
  lengthAfter?: number;
  /** True when the read-back ends with the typed text (newline style normalised). */
  appended: boolean;
  /** False when the target exposes no text at all — the caller must then verify otherwise. */
  verified: boolean;
}

export interface ScreenshotResult {
  /** base64 PNG (no data: prefix). */
  png: string;
  width: number;
  height: number;
  /** `window` = the window's own pixels; `screen` = the whole desktop. Never a silent substitution. */
  source: 'window';
  /** Window the capture came from, when `source` is `window`. */
  handle?: string;
}

export interface LaunchResult {
  /** PID started by the shell. Not the window owner when the app hands its document off. */
  spawnerProcessId?: number;
  /** The window that actually owns the launched document — the identity to use from here on. */
  window?: WindowInfo;
  /** True when a new top-level window appeared for the launch. */
  windowCreated: boolean;
  /**
   * True when the launcher exited without creating a window and the document landed in an
   * already running instance (Win11 tabbed Notepad and friends).
   */
  tabAdded: boolean;
  detail: string;
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
  /** Exact lookup by handle. Returns undefined when the handle is gone — never another window. */
  resolveWindow(handle: string): Promise<WindowInfo | undefined>;
  /** Brings the window to the foreground and returns it *after* activation, foreground verified. */
  activate(handle: string): Promise<WindowInfo>;
  close(handle: string): Promise<void>;
  uiTree(handle: string, maxDepth: number, maxNodes: number): Promise<UiTreeResult>;
  invoke(handle: string, selector: ElementSelector): Promise<{ ok: boolean; detail: string }>;
  setValue(handle: string, selector: ElementSelector, value: string): Promise<{ ok: boolean; detail: string }>;
  readText(handle: string, selector?: ElementSelector): Promise<TextReadback>;
  typeText(handle: string, text: string): Promise<TypeResult>;
  sendKeys(handle: string, keys: string): Promise<TypeResult>;
  /**
   * Real mouse click at absolute screen coordinates (the same space as `UiNode.bounds`, so
   * a point taken from the automation tree can be replayed directly). Used where a control
   * exposes no InvokePattern — custom-drawn canvases, charts, menus.
   */
  click(handle: string, x: number, y: number): Promise<{ x: number; y: number }>;
  /** Resizes the window's outer frame; returns the size actually applied after clamping. */
  resize(handle: string, width: number, height: number): Promise<{ width: number; height: number }>;
  /** Window-scoped capture. Omit the handle only to ask for the whole desktop. */
  screenshot(handle: string): Promise<ScreenshotResult>;
  launch(exePath: string, args: string[], cwd?: string): Promise<LaunchResult>;
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

/** Longest text prefix handed back per node/read-back call; `length` still reports the whole. */
export const TEXT_PREFIX_LIMIT = 512;

/**
 * UIA answers `BoundingRectangle` with sentinel values (-2147483648 / 2147483647 and
 * negative widths) for elements that were never laid out. Anything outside this window is
 * not a rectangle, and reporting it as one is what produced `x: -31994`.
 */
export const BOUNDS_LIMIT = 32_000;

/** Upper bound for one `typeText` call; bulk text belongs in a value write, not keystrokes. */
export const MAX_TYPED_CHARS = 4_000;

/** True when a rect can be a real screen rectangle; false for layout sentinels. */
export function isPlausibleBounds(box: WindowBounds | undefined): box is WindowBounds {
  if (!box) return false;
  const { x, y, width, height } = box;
  if (![x, y, width, height].every((v) => Number.isFinite(v))) return false;
  if (Math.abs(x) > BOUNDS_LIMIT || Math.abs(y) > BOUNDS_LIMIT) return false;
  if (Math.abs(width) > BOUNDS_LIMIT || Math.abs(height) > BOUNDS_LIMIT) return false;
  return width >= 0 && height >= 0;
}

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
