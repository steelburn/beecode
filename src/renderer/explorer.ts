import type { FsFile, FsListing } from '../shared/protocol';
import { clear, h, renderMarkdown } from './dom';
import {
  canSwitchView,
  defaultView,
  fileKind,
  htmlPreviewMarkup,
  type FileView,
} from './preview';

/**
 * The workspace explorer: a read-only view of the folders under the workspace root.
 *
 * The service returns one directory at a time (and one file preview at a time), so a huge
 * repository never lands in the UI in one go. Nothing here resolves or joins paths — the
 * service hands back absolute paths and the renderer only echoes them back.
 */

export interface ExplorerState {
  /** Directory currently listed; undefined until the first listing arrives. */
  path?: string;
  listing?: FsListing;
  /** Previewed file, if the user opened one. */
  file?: FsFile;
  /** Rendered or raw text; left out means the file kind's default view. */
  view?: FileView;
  /** Last failure, shown in place of the listing. */
  error?: string;
}

export interface ExplorerCallbacks {
  /** List a directory; without a path the service lists the workspace root. */
  open: (path?: string) => void;
  /** Preview a file. */
  preview: (path: string) => void;
  /** Close the preview and keep the listing. */
  close: () => void;
  /** Switch the preview between the rendered view and the raw source. */
  setView: (view: FileView) => void;
}

export function renderExplorer(host: HTMLElement, state: ExplorerState, cb: ExplorerCallbacks): void {
  clear(host);
  const card = h('div', { class: 'card explorer' });
  card.append(
    h(
      'div',
      { class: 'explorer-head' },
      h('div', { class: 'card-title', text: 'Workspace files' }),
      h('button', {
        class: 'btn ghost small',
        type: 'button',
        text: '⟳',
        title: 'Reload this folder',
        on: { click: () => cb.open(state.path) },
      }),
    ),
  );

  if (state.error) {
    card.append(h('div', { class: 'explorer-empty', text: state.error }));
    host.append(card);
    return;
  }

  const listing = state.listing;
  if (!listing) {
    card.append(h('div', { class: 'explorer-empty', text: 'Reading the workspace…' }));
    host.append(card);
    return;
  }

  const crumbs = h('div', { class: 'explorer-crumbs' });
  if (listing.parent) {
    crumbs.append(
      h('button', {
        class: 'btn ghost small',
        type: 'button',
        text: '↑ up',
        title: listing.parent,
        on: { click: () => cb.open(listing.parent) },
      }),
    );
  }
  crumbs.append(h('span', { class: 'explorer-path', text: listing.path, title: listing.path }));
  card.append(crumbs);

  if (!listing.entries.length) {
    card.append(h('div', { class: 'explorer-empty', text: 'This folder is empty.' }));
  } else {
    const list = h('div', { class: 'explorer-list' });
    for (const entry of listing.entries) {
      list.append(
        h(
          'button',
          {
            class: `explorer-row${entry.dir ? ' dir' : ''}${entry.path === state.file?.path ? ' active' : ''}`,
            type: 'button',
            title: entry.path,
            on: { click: () => (entry.dir ? cb.open(entry.path) : cb.preview(entry.path)) },
          },
          h('span', { class: 'explorer-icon', text: entry.dir ? '▸' : '·' }),
          h('span', { class: 'explorer-name', text: entry.name }),
          entry.link ? h('span', { class: 'explorer-tag', text: 'link' }) : null,
          entry.size === undefined ? null : h('span', { class: 'explorer-size', text: formatBytes(entry.size) }),
        ),
      );
    }
    if (listing.truncated) {
      list.append(h('div', { class: 'explorer-empty', text: 'This folder holds more entries than are shown.' }));
    }
    card.append(list);
  }

  if (state.file) card.append(renderPreview(state.file, state, cb));
  host.append(card);
}

/*
 * A rendered HTML file is mounted in its own shadow root: the file's own stylesheets stay
 * inside the preview instead of restyling the whole app, and the app's rules cannot
 * reshape the file. `.explorer-rendered.html` adds layout containment on top, so a page
 * written with `position: fixed` cannot paint over the app chrome either.
 */
function renderHtmlPreview(text: string): HTMLElement {
  const host = h('div', { class: 'explorer-rendered html' });
  host.attachShadow({ mode: 'open' }).innerHTML = htmlPreviewMarkup(text);
  return host;
}

/*
 * Markdown and HTML open rendered and can be flipped to the raw source; every other file
 * only ever has a source view, so no switch is offered. HTML is sanitized and then
 * mounted isolated — see `renderHtmlPreview`; markdown is escaped, so it stays inline.
 */
function renderPreview(file: FsFile, state: ExplorerState, cb: ExplorerCallbacks): HTMLElement {
  const kind = fileKind(file.name);
  const view = file.binary ? 'source' : (state.view ?? defaultView(kind));
  const body = h('div', { class: 'explorer-preview-body' });
  if (file.binary) {
    body.append(h('div', { class: 'explorer-empty', text: 'Binary file — no text preview.' }));
  } else {
    body.append(
      view === 'source' || kind === 'text'
        ? h('pre', { class: 'explorer-code', text: file.text })
        : kind === 'html'
          ? renderHtmlPreview(file.text)
          : h('div', { class: 'explorer-rendered', html: renderMarkdown(file.text) }),
    );
  }
  return h(
    'div',
    { class: 'explorer-preview' },
    h(
      'div',
      { class: 'explorer-head' },
      h('div', { class: 'card-title', text: file.name, title: file.path }),
      h('span', { class: 'explorer-size', text: formatBytes(file.size) }),
      canSwitchView(kind) && !file.binary
        ? h(
            'div',
            { class: 'explorer-viewtoggle', role: 'group', title: 'View mode' },
            ...(['rendered', 'source'] as FileView[]).map((mode) =>
              h('button', {
                class: `btn ghost small${mode === view ? ' active' : ''}`,
                type: 'button',
                text: mode === 'rendered' ? 'Rendered' : 'Source',
                title: mode === 'rendered' ? 'Show the rendered file' : 'Show the raw text',
                on: { click: () => cb.setView(mode) },
              }),
            ),
          )
        : null,
      h('button', {
        class: 'btn ghost small',
        type: 'button',
        text: '✕',
        title: 'Close the preview',
        on: { click: () => cb.close() },
      }),
    ),
    file.truncated
      ? h('div', { class: 'explorer-empty', text: 'Preview clipped — open the file in an editor to see the rest.' })
      : null,
    body,
  );
}

/** Sizes are read at a glance, so a compact power-of-two form beats the exact byte count. */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
