import type { SlateDelta, SlateSummary } from '../shared/protocol';
import type { SlateDiff } from '../shared/slateDiff';
import { renderSlateDiff, renderSlateDiffError } from './slateDiffView';
import { liveSlateLabel } from './slateLive';
import { clear, h } from './dom';
import { defaultSlatePath } from './slateTarget';
import { parseSlateOrigins } from './slateDocLive';
import type { SlateLiveBounds, SlateLiveState } from '../shared/slateSandbox';

/**
 * The SLATE_TAB pane: every slate the agent wrote in this session, newest last, each with
 * its version list.
 *
 * The gallery never renders a document itself. A slate version is a file, so opening one
 * opens a document tab and the existing markdown / HTML / CSV viewers do the work — that
 * is why a slate needs no renderer of its own.
 */

/** The bounds observer of the live page, re-created on every render. */
let paneObserver: ResizeObserver | null = null;

export interface SlateGalleryHandlers {
  /** Compare two versions; the gallery renders the result in its own panel. */
  diffSlate(id: string, from: number, to: number): Promise<SlateDiff>;
  /** Open one version in a tab; without a version the current one is opened. */
  openSlate(id: string, version?: number): void;
  removeSlate(id: string): void;
  /** Write one version into the workspace tree as a real file (`slate.promote`). */
  promoteSlate(id: string, version: number, path: string): void;
  /** Grant or withdraw execution for a slate, and set the origins it may call. */
  setSlateLive(id: string, enabled: boolean, origins: string[]): Promise<void>;
  /** Run one version in the sandboxed view that covers this pane. */
  runSlateLive(id: string, version: number, bounds: SlateLiveBounds): void;
  /** Keep the sandboxed view aligned with the pane it covers. */
  boundsSlateLive(bounds: SlateLiveBounds): void;
  stopSlateLive(): void;
}

export interface SlateGalleryView {
  /** What the sandboxed page is doing, when one is on screen. */
  liveView?: SlateLiveState;
  /** Blocks still streaming in, shown above the finished slates. */
  live?: SlateDelta[];
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
  const live = h('div', { class: 'slate-live' });
  const diffPanel = h('div', { class: 'slate-diff-panel hidden' });
  // Flex order puts these above / below the list without depending on where the
  // gallery appends its own markup.
  pane.append(live, diffPanel);
  const list = h('div', { class: 'slate-gallery-list' });
  /**
   * The tile only knows "diff these two versions"; the panel belongs to the gallery, so
   * a diff cannot be orphaned when a tile is re-rendered underneath it.
   */
  const tileHandlers: SlateGalleryHandlers = {
    ...handlers,
    diffSlate: async (id, from, to) => {
      diffPanel.classList.remove('hidden');
      try {
        const result = await handlers.diffSlate(id, from, to);
        renderSlateDiff(diffPanel, result);
        return result;
      } catch (err) {
        renderSlateDiffError(diffPanel, err instanceof Error ? err.message : String(err));
        return { from, to, hunks: [], added: 0, removed: 0, identical: true };
      }
    },
  };
  // The live page is painted over the whole pane, so the rectangle it fills is the pane's.
  const paneBounds = (): SlateLiveBounds => {
    const rect = pane.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  for (const slate of view.slates) {
    const tile = slateTile(slate, tileHandlers);
    if (slate.kind === 'html') tile.append(liveControls(slate, tileHandlers, view.liveView, paneBounds));
    list.append(tile);
  }
  paneObserver?.disconnect();
  paneObserver = null;
  if (view.liveView?.visible) {
    paneObserver = new ResizeObserver(() => handlers.boundsSlateLive(paneBounds()));
    paneObserver.observe(pane);
  }
  renderLiveTiles(live, view.live ?? []);

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

  /**
   * Diff compares two versions in place: the panel it lands in is the gallery-wide one,
   * so only the pickers live on the tile.
   */
  const diff = h('button', {
    type: 'button',
    class: 'btn ghost small',
    text: 'Diff',
    title: 'Compare two versions of this slate',
  });
  const diffFrom = h('select', { class: 'slate-diff-version hidden', title: 'Older version' }) as HTMLSelectElement;
  const diffTo = h('select', { class: 'slate-diff-version hidden', title: 'Newer version' }) as HTMLSelectElement;
  for (const version of slate.versions) {
    const label = version.n === slate.current ? `v${version.n} (current)` : `v${version.n}`;
    diffFrom.append(h('option', { value: String(version.n), text: label }));
    diffTo.append(h('option', { value: String(version.n), text: label }));
  }
  diffFrom.value = String(slate.current > 1 ? slate.current - 1 : slate.current);
  diffTo.value = String(slate.current);
  const showDiff = h('button', { type: 'button', class: 'btn small hidden', text: 'Show diff' });
  const toggleDiff = (show: boolean): void => {
    for (const node of [diffFrom, diffTo, showDiff]) node.classList.toggle('hidden', !show);
  };
  diff.addEventListener('click', () => toggleDiff(diffFrom.classList.contains('hidden')));
  showDiff.addEventListener('click', () => {
    void handlers.diffSlate(slate.id, Number(diffFrom.value), Number(diffTo.value));
  });

  const remove = h('button', {
    type: 'button',
    class: 'btn ghost small slate-remove',
    text: 'Remove',
    title: 'Delete this slate and every version of it',
  });
  remove.addEventListener('click', () => handlers.removeSlate(slate.id));
  actions.append(diff, diffFrom, diffTo, showDiff);
  actions.append(remove);

  /**
   * Promote is the only action that writes outside the slate folder, so it asks for the
   * path in place — the gallery never picks a target on the user's behalf.
   */
  const promote = h('button', {
    type: 'button',
    class: 'btn ghost small',
    text: 'Promote…',
    title: 'Write one version into the workspace tree as a real file',
  });
  const promoteForm = h('div', { class: 'slate-promote hidden' });
  const which = h('select', {
    class: 'slate-promote-version',
    title: 'Which version to write',
  }) as HTMLSelectElement;
  for (const version of [...slate.versions].reverse()) {
    which.append(
      h('option', {
        value: String(version.n),
        text: version.n === slate.current ? `v${version.n} (current)` : `v${version.n}`,
      }),
    );
  }
  which.value = String(slate.current);
  const target = h('input', { type: 'text', placeholder: 'docs/plan.md' }) as HTMLInputElement;
  target.value = defaultSlatePath(slate);
  target.setAttribute('aria-label', `File to write ${slate.title} to`);
  const write = h('button', { type: 'button', class: 'btn small', text: 'Write file' });
  write.addEventListener('click', () => {
    const path = target.value.trim();
    if (path) handlers.promoteSlate(slate.id, Number(which.value), path);
  });
  promote.addEventListener('click', () => promoteForm.classList.toggle('hidden'));
  promoteForm.append(which, target, write);
  actions.append(promote);

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
    promoteForm,
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

/** One tile per streaming block, keyed by the entry it belongs to. */
function renderLiveTiles(container: HTMLElement, deltas: SlateDelta[]): void {
  clear(container);
  container.hidden = deltas.length === 0;
  for (const delta of deltas) container.append(liveTile(delta));
}

function previewOf(text: string): string {
  const lines = text.split('\n');
  return lines.length <= 20 ? text : `${lines.slice(0, 20).join('\n')}\n…`;
}

function liveTile(delta: SlateDelta): HTMLElement {
  return h(
    'article',
    { class: 'slate-live-tile', dataset: { entryId: delta.entryId } },
    h(
      'div',
      { class: 'slate-tile-head' },
      h('h4', { text: delta.title }),
      h('span', { class: 'slate-tile-kind', text: delta.done ? 'finishing' : 'streaming' }),
    ),
    h('p', { class: 'slate-tile-meta', text: liveSlateLabel(delta) }),
    h('pre', { class: 'slate-live-body', text: previewOf(delta.text) }),
  );
}

/**
 * Applies a `slate.delta` to a gallery that is already on screen: the body and the label
 * of the matching tile are rewritten in place, so the pane is never remounted and the
 * scroll position survives. Tiles of finished entries are dropped by the caller.
 */
export function applyLiveSlates(pane: HTMLElement, deltas: SlateDelta[]): void {
  const container = pane.querySelector<HTMLElement>('.slate-live');
  if (!container) return;
  const seen = new Set<string>();
  for (const delta of deltas) {
    seen.add(delta.entryId);
    const selector = `[data-entry-id="${delta.entryId}"]`;
    const tile = container.querySelector<HTMLElement>(selector);
    if (!tile) {
      container.append(liveTile(delta));
      continue;
    }
    const body = tile.querySelector<HTMLElement>('.slate-live-body');
    if (body) body.textContent = previewOf(delta.text);
    const meta = tile.querySelector<HTMLElement>('.slate-tile-meta');
    if (meta) meta.textContent = liveSlateLabel(delta);
    const kind = tile.querySelector<HTMLElement>('.slate-tile-kind');
    if (kind) kind.textContent = delta.done ? 'finishing' : 'streaming';
  }
  for (const tile of Array.from(container.querySelectorAll<HTMLElement>('[data-entry-id]'))) {
    if (!seen.has(tile.dataset.entryId ?? '')) tile.remove();
  }
  container.hidden = deltas.length === 0;
}


/**
 * Consent and the Run/Stop switch for one HTML slate.
 *
 * Both halves sit on the tile because both answer the same question — "may this document
 * run, and what may it reach" — and the agent can answer neither: it may only *propose*
 * origins when it creates the slate, and the approval card prints them there.
 */
function liveControls(
  slate: SlateSummary,
  handlers: SlateGalleryHandlers,
  liveView: SlateLiveState | undefined,
  bounds: () => SlateLiveBounds,
): HTMLElement {
  const running = liveView?.visible === true && liveView.slateId === slate.id;
  const allowed = slate.live === true;

  const origins = document.createElement('textarea');
  origins.className = 'slate-live-origins';
  origins.rows = 2;
  origins.spellcheck = false;
  origins.value = (slate.origins ?? []).join('\n');
  origins.placeholder = 'https://api.example.com';
  origins.disabled = !allowed;
  origins.setAttribute('aria-label', 'Origins ' + slate.title + ' may call');

  const consent = document.createElement('input');
  consent.type = 'checkbox';
  consent.checked = allowed;

  const save = (): void => {
    void handlers
      .setSlateLive(slate.id, consent.checked, parseSlateOrigins(origins.value))
      .catch(() => undefined);
  };
  consent.addEventListener('change', () => {
    origins.disabled = !consent.checked;
    save();
  });
  origins.addEventListener('change', save);

  const run = h('button', {
    type: 'button',
    class: 'btn small',
    text: running ? 'Stop' : 'Run v' + slate.current,
  });
  run.addEventListener('click', () => {
    if (running) handlers.stopSlateLive();
    else handlers.runSlateLive(slate.id, slate.current, bounds());
  });

  const error =
    liveView?.error && liveView.slateId === slate.id
      ? h('span', { class: 'slate-live-error', text: liveView.error })
      : undefined;

  return h(
    'div',
    { class: 'slate-live-controls' },
    h('label', { class: 'slate-live-consent' }, consent, h('span', { text: 'Allow scripts (live)' })),
    origins,
    h('div', { class: 'slate-live-actions' }, run, error),
  );
}
