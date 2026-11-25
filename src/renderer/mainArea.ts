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
import { slateDocFromPath, slateExportName, type SlateDocRef } from './slateDoc';
import {
  parseSlateOrigins,
  slateDocHoldsLive,
  slateDocLiveTarget,
  slateLiveBoundsOf,
  type SlateDocLiveTarget,
} from './slateDocLive';
import { renderSlateGallery, type SlateGalleryView } from './slateGallery';
import type { SlateLiveBounds, SlateLiveState } from '../shared/slateSandbox';
import type { SlateDiff } from '../shared/slateDiff';

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
  /** Compare two versions of a slate; the gallery renders the result. */
diffSlate(id: string, from: number, to: number): Promise<SlateDiff>;
  /**
   * Grant or withdraw execution for a slate, and set the origins it may call. A document tab
   * names the session it belongs to; the Slates tab means the session on screen.
   */
  setSlateLive(id: string, enabled: boolean, origins: string[], sessionId?: string): Promise<void>;
  /**
   * Run one version in the sandboxed view — over the gallery pane, or over a slate tab's
   * document body — and keep it on the rectangle handed back by `boundsSlateLive`.
   */
  runSlateLive(id: string, version: number, bounds: SlateLiveBounds, sessionId?: string): void;
  boundsSlateLive(bounds: SlateLiveBounds): void;
  stopSlateLive(): void;
  /** Write one slate version into the workspace tree as a real file. */
  promoteSlate(id: string, version: number, path: string): void;
  /** Put a document tab's text on the clipboard. */
  copyDoc(path: string): void;
  /** Save a document tab's text to a path the user picks. */
  downloadDoc(path: string): void;
}

/** Everything below the strip needs besides the tab state itself. */
export interface MainAreaView extends SlateGalleryView {
  browserVisible: boolean;
  /** The session on screen: a slate tab may only run a slate of the session it was opened in. */
  sessionId?: string;
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

/**
 * Where the live page must go after this render — the document body it covers, or nothing.
 *
 * A native page does not reflow with the DOM, so every relayout has to hand the host the
 * rectangle again. Module scope because the pane exists once: the observers are registered
 * with `mountMainArea`, the rectangle comes from whichever tab is painted now.
 */
let liveStageSync: (() => void) | undefined;

export function mountMainArea(host: MainAreaHost, handlers: MainAreaHandlers): MainArea {
  // Window resizes and dock drags both land here: a live page that was left where it started
  // ends up floating over the chat as soon as the pane moves under it.
  const paneResize = new ResizeObserver(() => liveStageSync?.());
  paneResize.observe(host.pane);
  window.addEventListener('resize', () => liveStageSync?.());
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
      if (doc) renderDoc(host.pane, doc, state, view, handlers);
      else if (slateActive) {
        // The gallery keeps its own pane observer; nothing here owns a stage rectangle.
        liveStageSync = undefined;
        renderSlateGallery(host.pane, view, handlers);
      } else {
        liveStageSync = undefined;
        clear(host.pane);
      }
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
  state: DocTabsState,
  view: MainAreaView,
  handlers: MainAreaHandlers,
): void {
  const slate = slateDocFromPath(tab.path);
  // A slate's page is built by its own script, which the inert preview strips — so a slate
  // version shown as Preview is also the one document that gets the live host, right above
  // the body that page will cover. Every other tab stays exactly as inert as before.
  const target = slateDocLiveTarget(tab.path, tab.view, {
    sessionId: view.sessionId,
    slates: view.slates,
  });
  clear(pane);
  const body = h('div', { class: `doc-body ${docThemeClass(state.theme)}` }, ...docPaneBody(tab));
  const head = h(
    'div',
    { class: 'doc-head' },
    h(
      'div',
      { class: 'doc-title' },
      h('span', { class: 'doc-name', text: tab.name }),
      h('span', { class: 'doc-path', text: tab.path, title: tab.path }),
    ),
    h('span', { class: 'doc-size', text: formatBytes(tab.size) }),
    slateDocActions(tab, slate, handlers),
    canSwitchView(tab.kind) && !tab.binary ? viewToggle(tab, handlers, slate) : null,
    h('button', {
      type: 'button',
      class: 'btn ghost small',
      title: 'Close this tab',
      text: '✕',
      on: { click: () => handlers.close(tab.path) },
    }),
  );
  pane.append(head, ...(target ? [docLiveBar(target, view.liveView, handlers, body)] : []), body);
  // Keep the native page on the body from now on: this render, and every relayout after it.
  liveStageSync = target
    ? () => handlers.boundsSlateLive(slateLiveBoundsOf(body.getBoundingClientRect()))
    : undefined;
  if (slateDocHoldsLive(view.liveView, target)) liveStageSync?.();
}

/**
 * The Run switch above a slate's body.
 *
 * The same grant the tile in the Slates tab asks for, asked where the page will appear. Both
 * halves belong together — "may this document run" and "what may it reach" — and the user's
 * answer decides both. The inert preview stays underneath while it runs, so a host that
 * refuses (the reason lands in `liveView.error`) cannot leave the tab blank again, which is
 * the failure this bar exists to fix.
 */
function docLiveBar(
  target: SlateDocLiveTarget,
  liveView: SlateLiveState | undefined,
  handlers: MainAreaHandlers,
  stage: HTMLElement,
): HTMLElement {
  const running = slateDocHoldsLive(liveView, target);

  const consent = document.createElement('input');
  consent.type = 'checkbox';
  consent.className = 'doc-live-consent';
  consent.checked = target.allowed;

  const origins = document.createElement('textarea');
  origins.className = 'slate-live-origins doc-live-origins';
  origins.rows = 2;
  origins.spellcheck = false;
  origins.placeholder = 'origins it may fetch from, one per line — empty for a page that talks to itself';
  origins.value = target.origins.join('\n');
  origins.disabled = !consent.checked;

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'doc-live-run';
  run.textContent = running ? 'Stop live' : 'Run live';
  run.disabled = !consent.checked;
  run.addEventListener('click', () => {
    if (running) {
      handlers.stopSlateLive();
      return;
    }
    handlers.runSlateLive(
      target.id,
      target.version,
      slateLiveBoundsOf(stage.getBoundingClientRect()),
      target.sessionId,
    );
  });

  consent.addEventListener('change', () => {
    origins.disabled = !consent.checked;
    run.disabled = !consent.checked;
    // Withdrawing consent while the page is up has to take the page down with it.
    if (!consent.checked && running) handlers.stopSlateLive();
    void handlers
      .setSlateLive(target.id, consent.checked, parseSlateOrigins(origins.value), target.sessionId)
      .catch(() => undefined);
  });
  origins.addEventListener('change', () => {
    if (!consent.checked) return;
    void handlers
      .setSlateLive(target.id, true, parseSlateOrigins(origins.value), target.sessionId)
      .catch(() => undefined);
  });

  return h(
    'div',
    { class: `doc-live-bar${running ? ' running' : ''}` },
    h(
      'label',
      { class: 'doc-live-consent-label' },
      consent,
      h('span', { text: 'Allow scripts (live)' }),
    ),
    h('p', {
      class: 'doc-live-note',
      text: running
        ? "Live: this page runs the slate's own scripts inside a sandbox — it reaches only the origins above."
        : liveView?.error && !running
          ? `The live page did not attach: ${liveView.error}. The inert preview below is what it can show without scripts.`
          : "This page builds its content with JavaScript, which the inert preview strips. Run it live to see it.",
    }),
    origins,
    h('div', { class: 'doc-live-actions' }, run),
  );
}

/**
 * Copy and Download, for a slate version: the two ways to get the document out of the app.
 * Shown on slate tabs only — the store's own version number is what makes a download name
 * meaningful, and a plain document already has the file it came from.
 */
function slateDocActions(
  tab: DocTab,
  slate: SlateDocRef | undefined,
  handlers: MainAreaHandlers,
): HTMLElement | null {
  if (!slate || tab.binary || tab.text == null) return null;
  const action = (label: string, title: string, onClick: () => void): HTMLElement =>
    h('button', { type: 'button', class: 'doc-action', title, text: label, on: { click: onClick } });
  return h(
    'div',
    { class: 'doc-actions' },
    action('Copy', `Copy ${tab.name} to the clipboard`, () => handlers.copyDoc(tab.path)),
    action('Download…', `Save ${slateExportName(slate)} to a folder you pick`, () =>
      handlers.downloadDoc(tab.path),
    ),
  );
}


/** Rendered / source, for the kinds where both answers exist. */
function viewToggle(tab: DocTab, handlers: MainAreaHandlers, slate?: SlateDocRef): HTMLElement {
  // A slate is a document the agent wrote, so its two views are the code and the page.
  const labels = slate
    ? { rendered: 'Preview', source: 'Code' }
    : { rendered: 'Rendered', source: 'Source' };
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
    button('rendered', labels.rendered),
    button('source', labels.source),
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
