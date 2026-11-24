import type { FsFile, FsListing, KnowledgeFolder } from '../shared/protocol';
import { clear, h } from './dom';
import { canShowFile, mountFileView } from './fileView';
import {
  canSwitchView,
  defaultView,
  fileKind,
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
  /** Read-only knowledge folders the workspace can consult (shared with other workspaces). */
  knowledge?: KnowledgeFolder[];
  /** Knowledge folder that a copy from the workspace lands in. */
  copyTarget?: string;
  /** Text typed into the "new subfolder" field, kept across re-renders. */
  newFolder?: string;
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
  /** Open the previewed file as a tab in the main area. */
  openDoc: (path: string) => void;
  /** Attach a folder as shared read-only knowledge. */
  addKnowledge: () => void;
  /** Detach a knowledge folder; nothing on disk is deleted. */
  removeKnowledge: (path: string) => void;
  /** Pick which knowledge folder copies land in. */
  selectKnowledge: (path: string) => void;
  /** Remember what was typed into the new-subfolder field. */
  editKnowledgeName: (name: string) => void;
  /** Create a subfolder inside a knowledge folder. */
  createKnowledgeFolder: (path: string) => void;
  /** Copy a workspace file into the selected knowledge folder. */
  copyToKnowledge: (path: string) => void;
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
  card.append(renderKnowledge(state, cb));
  host.append(card);
}

/*
 * One file at a time. Every view — picture, PDF, table, log, Markdown, source — comes from
 * `mountFileView`, the same entry point the document tab uses, so the peek and the tab
 * always agree. Markdown and HTML open rendered and can be flipped to the raw source; only
 * those two offer the switch.
 */
function renderPreview(file: FsFile, state: ExplorerState, cb: ExplorerCallbacks): HTMLElement {
  const kind = fileKind(file.name);
  const view = file.binary ? 'source' : (state.view ?? defaultView(kind));
  const body = h('div', { class: 'explorer-preview-body' });
  // The panel peeks at one file: a picture, a PDF, a table or a log gets its own view,
  // text is rendered or shown as source, and a binary file with no viewer is only named.
  if (canShowFile(file)) {
    body.append(mountFileView(file, { view }));
  } else {
    body.append(h('div', { class: 'explorer-empty', text: 'Binary file — no text preview.' }));
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
      // The panel is 240px wide: it peeks at a file, the main area is where one is read.
      !canShowFile(file)
        ? null
        : h('button', {
            class: 'btn ghost small',
            type: 'button',
            text: '⤢',
            title: 'Open in the main area as a tab',
            on: { click: () => cb.openDoc(file.path) },
          }),
      (state.copyTarget ?? state.knowledge?.[0]?.path) && !isInsideKnowledge(file.path, state)
        ? h('button', {
            class: 'btn ghost small',
            type: 'button',
            text: 'K+',
            title: 'Copy into the selected knowledge folder (read-only there)',
            on: { click: () => cb.copyToKnowledge(file.path) },
          })
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

/**
 * Shared knowledge folders: attached once, consulted from every workspace, and read-only for
 * the agent. Only the user writes here — attaching a folder, creating a subfolder or copying a
 * workspace file in — so those verbs live in this panel and nowhere in the tool catalogue.
 */
function renderKnowledge(state: ExplorerState, cb: ExplorerCallbacks): HTMLElement {
  const folders = state.knowledge ?? [];
  const target = state.copyTarget ?? folders[0]?.path;
  const section = h('div', { class: 'explorer-knowledge' });
  section.append(
    h(
      'div',
      { class: 'explorer-crumbs' },
      h('span', { class: 'card-title', text: 'Knowledge (read-only)' }),
      h('button', {
        class: 'btn ghost small',
        type: 'button',
        text: 'add folder',
        title: 'Attach a shared read-only folder',
        on: { click: () => cb.addKnowledge() },
      }),
    ),
  );

  if (folders.length === 0) {
    section.append(
      h('div', {
        class: 'explorer-empty',
        text: 'No knowledge folder attached. The agent can only read these, never write them.',
      }),
    );
    return section;
  }

  for (const folder of folders) {
    const active = target === folder.path;
    section.append(
      h(
        'div',
        { class: `explorer-knowledge-row${active ? ' active' : ''}` },
        h('button', {
          class: 'btn ghost small',
          type: 'button',
          text: active ? '[*]' : '[ ]',
          title: active ? 'Copies land here' : 'Send copies here',
          on: { click: () => cb.selectKnowledge(folder.path) },
        }),
        h(
          'button',
          {
            class: 'explorer-row',
            type: 'button',
            title: folder.path,
            on: { click: () => cb.open(folder.path) },
          },
          h('span', { class: 'explorer-name', text: folder.label }),
        ),
        h('button', {
          class: 'btn ghost small',
          type: 'button',
          text: 'detach',
          title: 'Stop reading this folder; nothing on disk is deleted',
          on: { click: () => cb.removeKnowledge(folder.path) },
        }),
      ),
    );
  }

  if (target) {
    section.append(
      h(
        'div',
        { class: 'explorer-knowledge-row' },
        h('input', {
          class: 'explorer-newfolder',
          type: 'text',
          placeholder: 'new subfolder',
          value: state.newFolder ?? '',
          on: {
            input: (event) => cb.editKnowledgeName((event.target as HTMLInputElement).value),
          },
        }),
        h('button', {
          class: 'btn ghost small',
          type: 'button',
          text: 'create',
          title: 'Create this subfolder inside the selected knowledge folder',
          on: { click: () => cb.createKnowledgeFolder(target) },
        }),
      ),
    );
  }

  return section;
}

/** True when `path` already lives in one of the knowledge folders (nothing to copy). */
function isInsideKnowledge(path: string, state: ExplorerState): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return (state.knowledge ?? []).some((folder) => {
    const root = folder.path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

/** Sizes are read at a glance, so a compact power-of-two form beats the exact byte count. */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
