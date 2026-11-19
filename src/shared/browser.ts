/**
 * Contract for the internal browser: the sandboxed, app-owned browser view the agent
 * drives directly instead of synthesising mouse and keyboard input on the real desktop.
 *
 * The service decides *what* to do (tools + policy + audit); the Electron main process
 * owns the view and *does* it. They talk over the same JSON-RPC pipe as everything else,
 * with the flow reversed: the service sends a `browser/exec` host request and the main
 * process answers. Nothing here imports Electron, so the service stays host-agnostic and
 * a headless transport can report the browser as unavailable.
 *
 * Why a host request and not a desktop action: this browser is sandboxed — a separate
 * in-memory session, no Node, no shell, no downloads, no popups — so driving it cannot
 * reach the operating system the way `desktop_*` can. It is the cheap, safe tier: use it
 * first, fall back to the desktop driver only for pages the user is logged into on their
 * own profile or for native apps.
 */

/** Everything the agent can ask the internal browser to do. */
export type BrowserAction =
  | 'open'
  | 'navigate'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'hover'
  | 'wait'
  | 'back'
  | 'forward'
  | 'reload'
  | 'screenshot'
  | 'tabs'
  | 'close';

export const BROWSER_ACTIONS: BrowserAction[] = [
  'open',
  'navigate',
  'snapshot',
  'click',
  'type',
  'key',
  'scroll',
  'hover',
  'wait',
  'back',
  'forward',
  'reload',
  'screenshot',
  'tabs',
  'close',
];

/** Actions that change the page or the user's session — audited as `browser-act`. */
export const BROWSER_MUTATING_ACTIONS: BrowserAction[] = [
  'open',
  'navigate',
  'click',
  'type',
  'key',
  'scroll',
  'back',
  'forward',
  'reload',
  'close',
];

export function isMutatingBrowserAction(action: BrowserAction): boolean {
  return BROWSER_MUTATING_ACTIONS.includes(action);
}

/* --------------------------------------------------------------- observations */

export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One interactive element from a snapshot. `ref` is only valid for the snapshot that
 * produced it — the agent passes it back to `browser_click` / `browser_type`, and the
 * main process re-resolves it against a fresh snapshot so a stale ref can never click the
 * wrong thing silently (it fails instead).
 */
export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  rect: BrowserRect;
  disabled?: boolean;
  editable?: boolean;
}

export interface BrowserSnapshot {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  /** Visible text, condensed — this is what the model reads instead of raw HTML. */
  text: string;
  elements: BrowserElement[];
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  /** Set when text or elements were cut to stay inside the token budget. */
  truncated?: boolean;
}

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  /** True for the tab the agent is currently driving. */
  active: boolean;
}

export interface BrowserState {
  visible: boolean;
  tabs: BrowserTabInfo[];
  activeTabId?: string;
  /** Where the AI cursor overlay is drawn on the current page. */
  cursor: { enabled: boolean; label?: string };
  /** Last action the agent ran, so the UI can say what is happening. */
  lastAction?: { action: BrowserAction; label?: string; at: string };
}

/* ------------------------------------------------------------------ host RPC */

export interface BrowserExecParams {
  action: BrowserAction;
  tabId?: string;
  /** Absolute http(s) URL for `open` / `navigate`. */
  url?: string;
  /** Snapshot ref (`e12`) — preferred over a raw selector. */
  ref?: string;
  /** CSS selector fallback when the agent wants to be explicit. */
  selector?: string;
  /** Viewport coordinates for a click at a point rather than at an element. */
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaY?: number;
  /** Cursor label, e.g. "click Sign in" — rendered next to the AI cursor. */
  label?: string;
  /** Poll until the condition holds instead of failing immediately. */
  condition?: 'ready' | 'text';
  value?: string;
  timeoutMs?: number;
  /** Set false to skip the automatic post-action snapshot (saves tokens on long pages). */
  includeSnapshot?: boolean;
}

export interface BrowserExecResult {
  ok: boolean;
  action: BrowserAction;
  tabId?: string;
  state?: BrowserState;
  snapshot?: BrowserSnapshot;
  screenshot?: { mimeType: string; dataBase64: string };
  /** Human-readable outcome, shown on the tool card. */
  message?: string;
  /** Set with `ok: false`; the service turns this into an `{ "error": ... }` result. */
  error?: string;
}

/* ------------------------------------------------------------- plugin host */

export interface PdfOpenParams {
  /** Absolute path to the PDF. */
  path: string;
  /** 1-based page to jump to. */
  page?: number;
  title?: string;
}

export interface PdfOpenResult {
  ok: boolean;
  path: string;
  title?: string;
  error?: string;
}

export type PdfPageSize = 'A3' | 'A4' | 'A5' | 'Letter' | 'Legal' | 'Tabloid';

export interface PdfRenderParams {
  /** Absolute output path; the host writes the PDF there. */
  path: string;
  /** Complete HTML document to print. */
  html: string;
  pageSize?: PdfPageSize;
  landscape?: boolean;
  /** Print background colours and images. Default true — reports shade table headers. */
  background?: boolean;
  marginsMm?: { top?: number; right?: number; bottom?: number; left?: number };
}

export interface PdfRenderResult {
  ok: boolean;
  path: string;
  bytes?: number;
  error?: string;
}

/** Service → main requests. Keys are JSON-RPC method names. */
export interface HostRequests {
  'browser/exec': { params: BrowserExecParams; result: BrowserExecResult };
  'pdf/open': { params: PdfOpenParams; result: PdfOpenResult };
  'pdf/render': { params: PdfRenderParams; result: PdfRenderResult };
}

export type HostMethod = keyof HostRequests;

/**
 * Injected into the service by its transport. The stdio transport implements it over the
 * JSON-RPC pipe (service→main direction); the HTTP transport has no host and rejects.
 */
export type HostCall = <M extends HostMethod>(
  method: M,
  params: HostRequests[M]['params'],
) => Promise<HostRequests[M]['result']>;

/* -------------------------------------------------------------- renderer API */

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Renderer commands for the panel chrome (the AI cursor itself lives inside the page). */
export type BrowserPanelCommand =
  | { kind: 'focus' }
  | { kind: 'close' }
  | { kind: 'close-all' }
  | { kind: 'activate-tab'; tabId: string }
  | { kind: 'close-tab'; tabId: string }
  | { kind: 'toggle-cursor'; enabled: boolean }
  | { kind: 'set-bounds'; bounds: BrowserBounds };

/** Renderer-facing surface exposed on the preload bridge. */
export interface BrowserPanelApi {
  setBounds(bounds: BrowserBounds): void;
  command(command: BrowserPanelCommand): void;
  onState(listener: (state: BrowserState) => void): () => void;
}
