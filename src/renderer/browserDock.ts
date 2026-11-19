import type { BrowserPanelApi, BrowserState } from '../shared/browser';
import { clear, h } from './dom';

/**
 * The renderer half of the internal browser.
 *
 * The page itself is *not* rendered here. It lives in a `WebContentsView` owned by the
 * main process and painted on top of this window, inside its own sandboxed session. So
 * this module only does a few things:
 *
 *   - reserve a rectangle for the page and report it on every layout change
 *     (`browser.setBounds`), so main can position the view on top of exactly that box;
 *   - draw the chrome *around* that rectangle — tab strip, address display, AI-cursor
 *     switch, close — with plain DOM in the renderer's own process;
 *   - forward what the user clicks as panel commands (`activate-tab`, `close-tab`,
 *     `toggle-cursor`, `focus`, `close-all`), which main applies to the host.
 *
 * Because the chrome is a sibling of the reserved rectangle and never inside it, no page
 * script can style, cover or measure the chat UI.
 */
export interface BrowserDock {
  /** Apply a host state push. Cheap and idempotent — main pushes on every tab or load change. */
  render(state: BrowserState): void;
  destroy(): void;
}

const MIN_HEIGHT = 180;
const CHROME_RESERVE = 220;
/** Backstop for a report the compositor never asked for (occluded or restoring window). */
const BOUNDS_BACKSTOP_MS = 120;

/** Collapsed to the title bar, filling the workspace column, or the size the user dragged. */
type DockMode = 'normal' | 'minimized' | 'maximized';

export function mountBrowserDock(host: HTMLElement, api: BrowserPanelApi): BrowserDock {
  const tabsEl = h('div', { class: 'browser-tabs', role: 'tablist' });
  tabsEl.setAttribute('aria-label', 'Browser tabs');
  const urlEl = h('input', {
    class: 'browser-url',
    type: 'text',
    readOnly: true,
    spellcheck: false,
    placeholder: 'about:blank',
    title: 'The page the agent has open — it navigates with its browser tools',
  });
  const cursorBtn = h('button', {
    type: 'button',
    class: 'btn ghost small',
    text: 'cursor',
    title: 'Show or hide the AI cursor over the page',
  });
  const closeBtn = h('button', {
    type: 'button',
    class: 'btn ghost small browser-window-btn',
    text: '\u2715',
    title: 'Close the internal browser',
  });
  closeBtn.setAttribute('aria-label', 'Close the internal browser');
  const minBtn = h('button', {
    type: 'button',
    class: 'btn ghost small browser-window-btn',
    text: '\u2212',
    title: 'Minimize the internal browser',
  });
  minBtn.setAttribute('aria-label', 'Minimize the internal browser');
  const maxBtn = h('button', {
    type: 'button',
    class: 'btn ghost small browser-window-btn',
    text: '\u2922',
    title: 'Maximize the internal browser',
  });
  maxBtn.setAttribute('aria-label', 'Maximize the internal browser');
  const splitter = h('div', { class: 'browser-splitter', title: 'Drag to resize the internal browser' });
  const surface = h('div', { class: 'browser-surface' });
  const bar = h(
    'div',
    { class: 'browser-bar' },
    tabsEl,
    h('div', { class: 'browser-actions' }, urlEl, cursorBtn, minBtn, maxBtn, closeBtn),
  );

  clear(host);
  host.append(splitter, bar, surface);

  let current: BrowserState | null = null;
  let shown = false;
  let pending = false;
  let mode: DockMode = 'normal';
  /** Height to restore when leaving minimize/maximize (0 = whatever the CSS says). */
  let normalHeight = 0;
  let lastActionAt: string | undefined;

  /** Report the reserved rectangle to main; only meaningful while the dock is on screen. */
  const sendBounds = (): void => {
    if (!shown) return;
    const rect = surface.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      // Minimized: the surface has no area, so tell main to detach the view. Returning
      // without reporting would leave the page painted on top of the chat.
      api.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    api.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  };

  /**
   * Report the rectangle once per frame, with a timer as backstop. Chromium does not always
   * deliver the animation frame — while the window is occluded, or right after it comes back
   * from minimized — and a dropped report leaves the page view at its previous rectangle,
   * painted straight over the dock's own minimize/maximize/close buttons. The timer is not
   * starved the same way, so the rectangle always lands.
   */
  const scheduleBounds = (): void => {
    if (pending) return;
    pending = true;
    const flush = (): void => {
      if (!pending) return;
      pending = false;
      sendBounds();
    };
    requestAnimationFrame(flush);
    setTimeout(flush, BOUNDS_BACKSTOP_MS);
  };

  const renderTabs = (next: BrowserState): void => {
    clear(tabsEl);
    for (const tab of next.tabs) {
      const active = tab.active || tab.id === next.activeTabId;
      const name = tab.loading
        ? `${tab.title || tab.url || 'loading\u2026'}\u2026`
        : tab.title || tab.url || 'untitled';
      const closeTab = h('button', { type: 'button', class: 'browser-tab-close', text: '\u2715', title: 'Close tab' });
      closeTab.addEventListener('click', (event) => {
        event.stopPropagation();
        api.command({ kind: 'close-tab', tabId: tab.id });
      });
      const el = h(
        'div',
        { class: `browser-tab${active ? ' active' : ''}`, role: 'tab', title: tab.url || name },
        h('span', { class: 'browser-tab-name', text: name }),
        closeTab,
      );
      el.addEventListener('click', () => {
        if (!active) api.command({ kind: 'activate-tab', tabId: tab.id });
        else api.command({ kind: 'focus' });
      });
      tabsEl.append(el);
    }
  };

  const render = (next: BrowserState): void => {
    current = next;
    const visible = next.visible && next.tabs.length > 0;
    if (visible !== shown) {
      shown = visible;
      host.classList.toggle('hidden', !visible);
      // A panel that comes back starts at its normal size — and it must not stay collapsed
      // while hidden, or the surface would have no box to measure when it returns.
      if (mode !== 'normal') applyMode('normal');
      // The view can only be positioned once the dock has a layout box, hence the frame.
      if (visible) scheduleBounds();
    }
    // Only an explicit `open` is worth surfacing — that is the agent asking for a page to be
    // looked at. Every other action drives the page silently, so a minimized dock stays exactly
    // as the user left it (and a collapsed one stays collapsed: the host flips `visible` for
    // nothing but `open`).
    const actionAt = next.lastAction?.at;
    if (mode === 'minimized' && actionAt && actionAt !== lastActionAt && next.lastAction?.action === 'open') {
      applyMode('normal');
    }
    lastActionAt = actionAt;

    if (!visible) {
      // The panel is gone: drop the stale tab strip, so a re-opened dock cannot show tabs
      // the host no longer has.
      clear(tabsEl);
      urlEl.value = '';
      return;
    }
    renderTabs(next);
    const active = next.tabs.find((tab) => tab.id === next.activeTabId && tab.active) ?? next.tabs.find((tab) => tab.active);
    urlEl.value = active?.url ?? '';
    urlEl.title = active?.title ? `${active.title} — ${active.url}` : active?.url ?? '';
    const cursorOn = Boolean(next.cursor?.enabled);
    cursorBtn.classList.toggle('active', cursorOn);
    cursorBtn.setAttribute('aria-pressed', String(cursorOn));
  };

  /**
   * How tall "maximized" is: the workspace column minus the siblings the dock must not cover
   * (the approval slot and the composer). The transcript above it is `flex: 1`, so it gives
   * up exactly that space.
   */
  const maximizedHeight = (): number => {
    const parent = host.parentElement;
    if (!parent) return window.innerHeight - CHROME_RESERVE;
    const siblings = Array.from(parent.children);
    const below = siblings.slice(siblings.indexOf(host) + 1);
    const gap = Number.parseFloat(getComputedStyle(parent).rowGap) || 0;
    const used =
      below.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0) + gap * below.length;
    return parent.clientHeight - used;
  };

  /**
   * Minimized = the title bar only (the surface collapses, so main detaches the page view);
   * maximized = fill the column; normal = whatever the splitter last left behind.
   */
  const applyMode = (next: DockMode): void => {
    if (mode === 'normal' && next !== 'normal') {
      const height = Math.round(host.getBoundingClientRect().height);
      if (height > 0) normalHeight = height;
    }
    mode = next;
    host.classList.toggle('minimized', mode === 'minimized');
    host.classList.toggle('maximized', mode === 'maximized');
    if (mode === 'minimized') host.style.height = '';
    // Never claim more than the column can spare: a floor of MIN_HEIGHT pushed the
    // composer out of view on a short window instead of shrinking the dock.
    else if (mode === 'maximized') host.style.height = `${Math.max(0, maximizedHeight())}px`;
    else host.style.height = normalHeight > 0 ? `${normalHeight}px` : '';

    const minimized = mode === 'minimized';
    minBtn.classList.toggle('active', minimized);
    minBtn.title = minimized ? 'Restore the internal browser' : 'Minimize the internal browser';
    minBtn.setAttribute('aria-label', minBtn.title);

    const maximized = mode === 'maximized';
    maxBtn.textContent = maximized ? '\u2921' : '\u2922';
    maxBtn.classList.toggle('active', maximized);
    maxBtn.title = maximized ? 'Restore the internal browser' : 'Maximize the internal browser';
    maxBtn.setAttribute('aria-label', maxBtn.title);

    scheduleBounds();
  };

  cursorBtn.addEventListener('click', () => {
    api.command({ kind: 'toggle-cursor', enabled: !current?.cursor?.enabled });
  });
  minBtn.addEventListener('click', () => applyMode(mode === 'minimized' ? 'normal' : 'minimized'));
  maxBtn.addEventListener('click', () => applyMode(mode === 'maximized' ? 'normal' : 'maximized'));
  closeBtn.addEventListener('click', () => {
    applyMode('normal');
    api.command({ kind: 'close-all' });
  });

  const observer = new ResizeObserver(() => scheduleBounds());
  observer.observe(surface);
  const onWindowResize = (): void => {
    // A maximized dock has to grow with the column it fills.
    if (mode === 'maximized') host.style.height = `${Math.max(MIN_HEIGHT, maximizedHeight())}px`;
    scheduleBounds();
  };
  window.addEventListener('resize', onWindowResize);
  const onWindowFocus = (): void => scheduleBounds();
  const onVisibilityChange = (): void => {
    if (!document.hidden) scheduleBounds();
  };
  window.addEventListener('focus', onWindowFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Dragging the splitter changes the dock's own height; the ResizeObserver above then
  // reports the new rectangle, so the page view follows the drag without extra plumbing.
  let dragFrom = 0;
  let dragHeight = 0;
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragHeight) return;
    const available = host.parentElement?.getBoundingClientRect().height ?? 0;
    const next = dragHeight + (dragFrom - event.clientY);
    const max = available > 0 ? Math.max(MIN_HEIGHT, available - CHROME_RESERVE) : next;
    const height = Math.round(Math.min(Math.max(next, MIN_HEIGHT), max));
    host.style.height = `${height}px`;
    // Remember it, so minimize/restore comes back to the size the user chose.
    normalHeight = height;
  };
  const onPointerUp = (): void => {
    dragHeight = 0;
    document.body.classList.remove('dragging-browser-dock');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };
  splitter.addEventListener('pointerdown', (event) => {
    // Dragging the splitter is a resize, so it leaves maximize first.
    if (mode === 'maximized') applyMode('normal');
    dragFrom = event.clientY;
    dragHeight = host.getBoundingClientRect().height;
    document.body.classList.add('dragging-browser-dock');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });

  return {
    render,
    destroy(): void {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      onPointerUp();
    },
  };
}
