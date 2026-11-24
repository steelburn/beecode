import { clear, h } from './dom';
import { canShowFile, mountFileView } from './fileView';
import {
  BROWSER_TAB,
  CHAT_TAB,
  SLATE_TAB,
  activeDoc,
  docId,
  docThemeClass,
  type DocTab,
  type DocTabsState,
  type DocTheme,
} from './docTabs';
import { canSwitchView, type FileView } from './preview';
import { renderSlateGallery, type SlateGalleryView } from './slateGallery';

/**
 * The main-area tab strip and the document pane below it.
 *
 * The main column shows exactly one view: the chat transcript, one open document, or the
 * embedded browser. The strip is the only switch, and everything below the pane — approval
 * and goal slots, the composer — keeps its place, so the page view can only ever paint
 * inside the rectangle it reserves.
 *
 * A rendered HTML document is mounted in its own shadow root, exactly like the explorer
 * preview: the file's stylesheets stay inside the tab instead of restyling the whole app,
 * and `.explorer-rendered.html`'s containment keeps a `position: fixed` page off the app
 * chrome. The theme arrives as inherited custom properties, which do cross the shadow
 * boundary — that is why the preview CSS reads `var(--doc-*, fallback)` throughout.
 */

export interface MainAreaHandlers {
  activate(id: string): void;
  close(path: string): void;
  setView(path: string, view: FileView): void;
  toggleTheme(): void;
  /** Open one version of a slate as a document tab; without a version, the current one. */
  openSlate(id: string, version?: number): void;
  removeSlate(id: string): void;
  /** Write one slate version into the workspace tree as a real file. */
  promoteSlate(id: string, version: number, path: string): void;
}

/** Everything below the strip needs besides the tab state itself. */
export interface MainAreaView extends SlateGalleryView {
  browserVisible: boolean;
}

export interface MainAreaHost {
  /** Receives `view-chat` / `view-doc` / `view-browser`: CSS shows one of the three. */
  workspace: HTMLElement;
  strip: HTMLElement;
  pane: HTMLElement;
}

export interface MainArea {
  /** Repaint the strip and the document pane. Cheap and idempotent. */
  render(state: DocTabsState, view: MainAreaView): void;
}

export function mountMainArea(host: MainAreaHost, handlers: MainAreaHandlers): MainArea {
  return {
    render(state, view) {
      const doc = activeDoc(state);
      const slateActive = state.active === SLATE_TAB;
      const browserActive = state.active === BROWSER_TAB && view.browserVisible;
      renderStrip(host.strip, state, view, handlers);
      host.workspace.classList.toggle('view-doc', Boolean(doc) || slateActive);
      host.workspace.classList.toggle('view-browser', browserActive);
      host.workspace.classList.toggle('view-chat', !doc && !slateActive && !browserActive);
      host.pane.hidden = !doc && !slateActive;
      if (doc) renderDoc(host.pane, doc, state.theme, handlers);
      else if (slateActive) renderSlateGallery(host.pane, view, handlers);
      else clear(host.pane);
    },
  };
}

/**
 * The strip only exists once there is something to switch between: with chat alone the
 * column looks exactly as it did before tabs existed.
 */
function renderStrip(
  strip: HTMLElement,
  state: DocTabsState,
  view: MainAreaView,
  handlers: MainAreaHandlers,
): void {
  // The strip is rebuilt whenever the tab set changes: keep where the user scrolled it, or
  // every tab open throws the view back to the first tab.
  const keptScroll = strip.querySelector('.view-tablist')?.scrollLeft ?? 0;
  clear(strip);
  strip.hidden = state.tabs.length === 0 && !view.browserVisible && view.slates.length === 0;
  if (strip.hidden) return;

  const tabs = [
    tabButton(CHAT_TAB, 'Chat', 'The chat transcript', state.active === CHAT_TAB, () =>
      handlers.activate(CHAT_TAB),
    ),
    ...(view.slates.length
      ? [
          tabButton(
            SLATE_TAB,
            'Slates',
            'The slates this session produced',
            state.active === SLATE_TAB,
            () => handlers.activate(SLATE_TAB),
          ),
        ]
      : []),
    ...state.tabs.map((tab) =>
      docTabButton(tab, state.active === docId(tab.path), handlers),
    ),
  ];
  if (view.browserVisible) {
    tabs.push(
      tabButton(BROWSER_TAB, 'Browser', 'The embedded browser page', state.active === BROWSER_TAB, () =>
        handlers.activate(BROWSER_TAB),
      ),
    );
  }

  const list = h('div', { class: 'view-tablist', role: 'tablist' }, ...tabs);
  strip.append(
    list,
    h(
      'div',
      { class: 'view-tabs-actions' },
      h('button', {
        type: 'button',
        class: 'view-theme',
        title: `Rendered documents: switch to ${state.theme === 'light' ? 'dark' : 'light'} mode`,
        text: state.theme === 'light' ? '☾ Dark' : '☀ Light',
        on: { click: () => handlers.toggleTheme() },
      }),
    ),
  );
  // Only now that the strip is in the document: restore the scroll the user chose and make
  // sure the active tab is on screen — a tab opened past the right edge was simply invisible.
  list.scrollLeft = keptScroll;
  list.querySelector<HTMLElement>('.view-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  list.addEventListener(
    'wheel',
    (event) => {
      if (!event.deltaY || list.scrollWidth <= list.clientWidth) return;
      list.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false },
  );
}

function tabButton(
  id: string,
  label: string,
  title: string,
  active: boolean,
  onClick: () => void,
): HTMLElement {
  return h(
    'div',
    { class: `view-tab${active ? ' active' : ''}`, role: 'tab', title, dataset: { tab: id } },
    h('button', { type: 'button', class: 'view-tab-label', text: label, on: { click: onClick } }),
  );
}

function docTabButton(tab: DocTab, active: boolean, handlers: MainAreaHandlers): HTMLElement {
  return h(
    'div',
    {
      class: `view-tab${active ? ' active' : ''}`,
      role: 'tab',
      title: tab.path,
      dataset: { tab: docId(tab.path) },
    },
    h('button', {
      type: 'button',
      class: 'view-tab-label',
      text: tab.name,
      on: { click: () => handlers.activate(docId(tab.path)) },
    }),
    h('button', {
      type: 'button',
      class: 'view-tab-close',
      title: `Close ${tab.name}`,
      text: '✕',
      on: { click: () => handlers.close(tab.path) },
    }),
  );
}

function renderDoc(
  pane: HTMLElement,
  tab: DocTab,
  theme: DocTheme,
  handlers: MainAreaHandlers,
): void {
  clear(pane);
  pane.append(
    h(
      'div',
      { class: 'doc-head' },
      h(
        'div',
        { class: 'doc-title' },
        h('span', { class: 'doc-name', text: tab.name }),
        h('span', { class: 'doc-path', text: tab.path, title: tab.path }),
      ),
      h('span', { class: 'doc-size', text: formatBytes(tab.size) }),
      canSwitchView(tab.kind) && !tab.binary ? viewToggle(tab, handlers) : null,
      h('button', {
        type: 'button',
        class: 'btn ghost small',
        title: 'Close this tab',
        text: '✕',
        on: { click: () => handlers.close(tab.path) },
      }),
    ),
    h('div', { class: `doc-body ${docThemeClass(theme)}` }, ...docPaneBody(tab)),
  );
}

/** Rendered / source, for the kinds where both answers exist. */
function viewToggle(tab: DocTab, handlers: MainAreaHandlers): HTMLElement {
  const button = (view: FileView, label: string): HTMLElement =>
    h('button', {
      type: 'button',
      class: `doc-view${tab.view === view ? ' active' : ''}`,
      text: label,
      on: { click: () => handlers.setView(tab.path, view) },
    });
  return h(
    'div',
    { class: 'doc-viewtoggle', role: 'group', title: 'View mode' },
    button('rendered', 'Rendered'),
    button('source', 'Source'),
  );
}

function docPaneBody(tab: DocTab): Node[] {
  const body: Node[] = [];
  // One entry point for every kind of file, shared with the explorer's peek panel.
  if (canShowFile(tab)) {
    body.push(mountFileView(tab, { view: tab.view }));
  } else {
    body.push(
      h('p', { class: 'doc-empty', text: 'This file is not text, so there is nothing to render.' }),
    );
  }
  if (tab.truncated) {
    body.push(
      h('p', {
        class: 'doc-truncated',
        text: 'Preview clipped: this file is longer than the preview budget.',
      }),
    );
  }
  return body;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
