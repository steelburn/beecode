/**
 * Column sizing and hiding for the two side columns of the app shell.
 *
 * The shell is one CSS grid — `rail | workspace | panel` — and both side columns belong to
 * the user: each has a drag grip on its inner edge, a toggle that collapses it away and a
 * width that outlives the window. A width is a display preference of this window, not a
 * service setting, so it lives in localStorage next to the plan panel's collapsed flag.
 *
 * The grid is driven by two custom properties (`--rail-w`, `--panel-w`), so a drag only
 * rewrites a variable instead of rebuilding the layout.
 */

export interface ColumnLimits {
  min: number;
  max: number;
}

export const RAIL_LIMITS: ColumnLimits = { min: 168, max: 460 };
export const PANEL_LIMITS: ColumnLimits = { min: 240, max: 760 };
export const DEFAULT_RAIL_WIDTH = 240;
export const DEFAULT_PANEL_WIDTH = 360;

/** The conversation column keeps at least this much room, whatever the sides are asking for. */
const CENTER_FLOOR = 360;
/** Arrow-key step on a focused grip. */
const KEY_STEP = 16;

const KEY = {
  railWidth: 'beecode.rail.width',
  panelWidth: 'beecode.panel.width',
  railHidden: 'beecode.rail.hidden',
  panelHidden: 'beecode.panel.hidden',
};

export interface ColumnState {
  rail: number;
  panel: number;
  railHidden: boolean;
  panelHidden: boolean;
}

export interface ColumnElements {
  app: HTMLElement;
  railResizer: HTMLElement;
  panelResizer: HTMLElement;
  toggleRail: HTMLButtonElement;
  togglePanel: HTMLButtonElement;
}

/**
 * Clamp a wanted width to the column's own limits *and* to the room the window can spare
 * once the opposite column and the conversation floor are subtracted.
 */
export function clampWidth(
  next: number,
  limits: ColumnLimits,
  otherWidth: number,
  viewport: number,
): number {
  const spare = viewport - otherWidth - CENTER_FLOOR;
  const upper = Math.max(limits.min, Math.min(limits.max, spare));
  const value = Number.isFinite(next) ? next : limits.min;
  return Math.round(Math.min(Math.max(value, limits.min), upper));
}

function readWidth(key: string, fallback: number): number {
  try {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  } catch {
    return fallback;
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a window with storage disabled simply forgets its layout */
  }
}

export function initColumns(els: ColumnElements): ColumnState {
  const state: ColumnState = {
    rail: readWidth(KEY.railWidth, DEFAULT_RAIL_WIDTH),
    panel: readWidth(KEY.panelWidth, DEFAULT_PANEL_WIDTH),
    railHidden: readFlag(KEY.railHidden),
    panelHidden: readFlag(KEY.panelHidden),
  };

  /** A collapsed column takes no room, so the other side may use the whole window. */
  const railRoom = (): number => (state.railHidden ? 0 : state.rail);
  const panelRoom = (): number => (state.panelHidden ? 0 : state.panel);

  function clampAll(): void {
    state.rail = clampWidth(state.rail, RAIL_LIMITS, panelRoom(), window.innerWidth);
    state.panel = clampWidth(state.panel, PANEL_LIMITS, railRoom(), window.innerWidth);
  }

  function apply(): void {
    els.app.style.setProperty('--rail-w', `${state.rail}px`);
    els.app.style.setProperty('--panel-w', `${state.panel}px`);
    els.app.classList.toggle('rail-hidden', state.railHidden);
    els.app.classList.toggle('panel-hidden', state.panelHidden);
    // A grip on a collapsed column would sit on the window edge and drag nothing.
    els.railResizer.hidden = state.railHidden;
    els.panelResizer.hidden = state.panelHidden;
    els.toggleRail.setAttribute('aria-pressed', String(!state.railHidden));
    els.togglePanel.setAttribute('aria-pressed', String(!state.panelHidden));
  }

  function remember(): void {
    write(KEY.railWidth, String(state.rail));
    write(KEY.panelWidth, String(state.panel));
    write(KEY.railHidden, state.railHidden ? '1' : '0');
    write(KEY.panelHidden, state.panelHidden ? '1' : '0');
  }

  function setWidth(side: 'rail' | 'panel', next: number): void {
    const limits = side === 'rail' ? RAIL_LIMITS : PANEL_LIMITS;
    const other = side === 'rail' ? panelRoom() : railRoom();
    const width = clampWidth(next, limits, other, window.innerWidth);
    if (side === 'rail') state.rail = width;
    else state.panel = width;
    apply();
  }

  function width(side: 'rail' | 'panel'): number {
    return side === 'rail' ? state.rail : state.panel;
  }

  function grip(side: 'rail' | 'panel'): void {
    const handle = side === 'rail' ? els.railResizer : els.panelResizer;

    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width(side);
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* a synthetic pointer (tests, smoke) has nothing to capture */
      }
      handle.classList.add('dragging');
      els.app.classList.add('resizing');
      document.body.classList.add('col-resizing');

      // The panel grows to the left of its grip, the rail to the right of its own, so the
      // drag delta is inverted for the panel.
      const onMove = (move: PointerEvent): void => {
        const delta = side === 'rail' ? move.clientX - startX : startX - move.clientX;
        setWidth(side, startWidth + delta);
      };
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        handle.classList.remove('dragging');
        els.app.classList.remove('resizing');
        document.body.classList.remove('col-resizing');
        try {
          handle.releasePointerCapture(event.pointerId);
        } catch {
          /* capture already gone with the pointer */
        }
        remember();
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    // Double-click restores the shipped width — the usual way out of a bad drag.
    handle.addEventListener('dblclick', () => {
      setWidth(side, side === 'rail' ? DEFAULT_RAIL_WIDTH : DEFAULT_PANEL_WIDTH);
      remember();
    });

    handle.addEventListener('keydown', (event: KeyboardEvent) => {
      const grow = side === 'rail' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = side === 'rail' ? 'ArrowLeft' : 'ArrowRight';
      if (event.key !== grow && event.key !== shrink) return;
      event.preventDefault();
      setWidth(side, width(side) + (event.key === grow ? KEY_STEP : -KEY_STEP));
      remember();
    });
  }

  els.toggleRail.addEventListener('click', () => {
    state.railHidden = !state.railHidden;
    apply();
    remember();
  });

  els.togglePanel.addEventListener('click', () => {
    state.panelHidden = !state.panelHidden;
    apply();
    remember();
  });

  // A narrower window must not squeeze the conversation out of existence; the stored width
  // is kept, so growing the window again gives the column its room back.
  window.addEventListener('resize', () => {
    clampAll();
    apply();
  });

  clampAll();
  apply();
  grip('rail');
  grip('panel');

  return state;
}
