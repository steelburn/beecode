import type { BrowserPanelApi, BrowserState } from '../shared/browser';
import { clear, h } from './dom';

/**
 * The renderer half of the internal browser.
 *
 * The page itself is *not* rendered here. It lives in a `WebContentsView` owned by the
 * main process and painted on top of this window, inside its own sandboxed session. So
 * this module only does three things:
 *
 *   - reserve a rectangle for the page and report it on every layout change
 *     (`browser.setBounds`), so main can position the view on top of exactly that box;
 *   - draw the chrome *around* that rectangle — tab strip, address display, AI-cursor
 *     switch, close — with plain DOM in the renderer's own process;
 *   - forward what the user clicks as panel commands (`activate-tab`, `close-tab`,
 *     `toggle-cursor`, `focus`), which main applies to the host.
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
    class: 'btn ghost small',
    text: '\u2715',
    title: 'Close the internal browser',
  });
  const splitter = h('div', { class: 'browser-splitter', title: 'Drag to resize the internal browser' });
  const surface = h('div', { class: 'browser-surface' });
  const bar = h(
    'div',
    { class: 'browser-bar' },
    tabsEl,
    h('div', { class: 'browser-actions' }, urlEl, cursorBtn, closeBtn),
  );

  clear(host);
  host.append(splitter, bar, surface);

  let current: BrowserState | null = null;
  let shown = false;
  let frame = 0;

  /** Report the reserved rectangle to main; only meaningful while the dock is on screen. */
  const sendBounds = (): void => {
    frame = 0;
    if (!shown) return;
    const rect = surface.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    api.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  };

  const scheduleBounds = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(sendBounds);
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
      // The view can only be positioned once the dock has a layout box, hence the frame.
      if (visible) scheduleBounds();
    }
    if (!visible) return;
    renderTabs(next);
    const active = next.tabs.find((tab) => tab.id === next.activeTabId && tab.active) ?? next.tabs.find((tab) => tab.active);
    urlEl.value = active?.url ?? '';
    urlEl.title = active?.title ? `${active.title} — ${active.url}` : active?.url ?? '';
    const cursorOn = Boolean(next.cursor?.enabled);
    cursorBtn.classList.toggle('active', cursorOn);
    cursorBtn.setAttribute('aria-pressed', String(cursorOn));
  };

  cursorBtn.addEventListener('click', () => {
    api.command({ kind: 'toggle-cursor', enabled: !current?.cursor?.enabled });
  });
  closeBtn.addEventListener('click', () => api.command({ kind: 'close' }));

  const observer = new ResizeObserver(() => scheduleBounds());
  observer.observe(surface);
  const onWindowResize = (): void => scheduleBounds();
  window.addEventListener('resize', onWindowResize);

  // Dragging the splitter changes the dock's own height; the ResizeObserver above then
  // reports the new rectangle, so the page view follows the drag without extra plumbing.
  let dragFrom = 0;
  let dragHeight = 0;
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragHeight) return;
    const available = host.parentElement?.getBoundingClientRect().height ?? 0;
    const next = dragHeight + (dragFrom - event.clientY);
    const max = available > 0 ? Math.max(MIN_HEIGHT, available - CHROME_RESERVE) : next;
    host.style.height = `${Math.round(Math.min(Math.max(next, MIN_HEIGHT), max))}px`;
  };
  const onPointerUp = (): void => {
    dragHeight = 0;
    document.body.classList.remove('dragging-browser-dock');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };
  splitter.addEventListener('pointerdown', (event) => {
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
      onPointerUp();
    },
  };
}
