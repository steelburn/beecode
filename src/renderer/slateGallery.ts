import type { SlateSummary } from '../shared/protocol';
import { clear, h } from './dom';

/**
 * The SLATE_TAB pane: every slate the agent wrote in this session, newest last, each with
 * its version list.
 *
 * The gallery never renders a document itself. A slate version is a file, so opening one
 * opens a document tab and the existing markdown / HTML / CSV viewers do the work — that
 * is why a slate needs no renderer of its own.
 */

export interface SlateGalleryHandlers {
  /** Open one version in a tab; without a version the current one is opened. */
  openSlate(id: string, version?: number): void;
  removeSlate(id: string): void;
}

export interface SlateGalleryView {
  slates: SlateSummary[];
  /** Set when the last `slate.list` failed, so the pane can say why it is empty. */
  error?: string;
}

export function renderSlateGallery(
  pane: HTMLElement,
  view: SlateGalleryView,
  handlers: SlateGalleryHandlers,
): void {
  clear(pane);
  const list = h('div', { class: 'slate-gallery-list' });
  for (const slate of view.slates) list.append(slateTile(slate, handlers));

  pane.append(
    h(
      'div',
      { class: 'slate-gallery' },
      h(
        'header',
        { class: 'slate-gallery-head' },
        h('h3', { text: 'Slates' }),
        h('p', {
          text: 'Documents the agent wrote for this session. Opening one shows that version in its own tab.',
        }),
      ),
      view.error
        ? h('p', { class: 'slate-gallery-error', text: `Could not list the slates: ${view.error}` })
        : undefined,
      view.slates.length
        ? list
        : h('p', {
            class: 'slate-gallery-empty',
            text: 'No slates yet. Ask the agent for a document and it lands here instead of in the chat.',
          }),
    ),
  );
}

function slateTile(slate: SlateSummary, handlers: SlateGalleryHandlers): HTMLElement {
  const versions = slate.versions.length;
  const current = slate.versions.find((version) => version.n === slate.current) ?? slate.versions[0];
  const open = h('button', {
    type: 'button',
    class: 'btn ghost small',
    text: `Open v${slate.current}`,
    title: 'Open the current version in its own tab',
  });
  open.addEventListener('click', () => handlers.openSlate(slate.id, slate.current));

  const actions = h('div', { class: 'slate-tile-actions' }, open);
  // A single version has nothing to pick, so the picker only exists once it can differ.
  if (versions > 1) {
    const picker = h('select', { class: 'slate-version', title: 'Open an older version' }) as HTMLSelectElement;
    picker.append(h('option', { value: '', text: `v${slate.current} (current)` }));
    for (const version of [...slate.versions].reverse()) {
      if (version.n === slate.current) continue;
      picker.append(
        h('option', {
          value: String(version.n),
          text: `v${version.n} · ${formatBytes(version.bytes)} pinned`,
        }),
      );
    }
    picker.addEventListener('change', () => {
      if (!picker.value) return;
      handlers.openSlate(slate.id, Number(picker.value));
      picker.value = '';
    });
    actions.append(picker);
  }

  const remove = h('button', {
    type: 'button',
    class: 'btn ghost small slate-remove',
    text: 'Remove',
    title: 'Delete this slate and every version of it',
  });
  remove.addEventListener('click', () => handlers.removeSlate(slate.id));
  actions.append(remove);

  return h(
    'article',
    { class: 'slate-tile', dataset: { slateId: slate.id } },
    h(
      'div',
      { class: 'slate-tile-head' },
      h('h4', { text: slate.title }),
      h('span', { class: 'slate-tile-kind', text: slate.kind }),
    ),
    h('p', {
      class: 'slate-tile-meta',
      text: `v${slate.current} of ${versions} · ${current ? formatBytes(current.bytes) : 'empty'} · updated ${formatWhen(slate.updatedAt)}`,
    }),
    actions,
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Slate times are shown as a local clock time: the gallery is about this session, today. */
function formatWhen(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
