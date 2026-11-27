import type { BrowserAction } from '../../shared/browser';

/**
 * Where a surface-bound browser action gets the compositor surface it needs.
 *
 * Measured on Windows: a *hidden* BrowserWindow has no display surface at all, so CDP mouse
 * input never answers and `capturePage` fails with "Current display surface not available".
 * A shown-but-invisible window paints normally, which is why the holder is the shape it is.
 *
 * The decision is pure so it can be tested without an Electron window: the host collects the
 * three facts and this says whether the page can be driven where it already is ('live') or has
 * to be parked on the hidden holder window first ('offscreen'). Everything that makes the app
 * window stop painting — collapsed dock, minimized dock, minimized app, the page simply not
 * being the active tab — lands on the same answer.
 */
export type SurfaceTarget = 'live' | 'offscreen';

export interface SurfaceFacts {
  /** The tab's view is currently a child of the app window. */
  attachedToWindow: boolean;
  /** The rectangle the renderer reserved; 0×0 while the dock is collapsed. */
  bounds: { width: number; height: number };
  /** The app window exists, is not minimized and is actually on screen. */
  windowPainting: boolean;
}

export function surfaceTarget(facts: SurfaceFacts): SurfaceTarget {
  if (!facts.windowPainting) return 'offscreen';
  if (!facts.attachedToWindow) return 'offscreen';
  if (facts.bounds.width < 2 || facts.bounds.height < 2) return 'offscreen';
  return 'live';
}

/**
 * Actions the debugger can only run against a painting surface: mouse input, key input (they
 * go through the same hit-testing) and `capturePage`. Everything else — navigating, reading a
 * snapshot, downloads — works on a page nobody is painting.
 */
export const SURFACE_ACTIONS: ReadonlySet<BrowserAction> = new Set<BrowserAction>([
  'click',
  'type',
  'key',
  'scroll',
  'hover',
  'screenshot',
]);

/** Viewport a parked page gets when the dock never had a size to lend it. */
export const OFFSCREEN_SIZE = { width: 1280, height: 900 } as const;

/**
 * Where the holder window lives: far away from any desktop, so even a window manager that
 * ignores opacity cannot put it in front of the user.
 */
export const OFFSCREEN_ORIGIN = -8000;
