import type { SlateDiff } from '../shared/slateDiff';
import { clear, h } from './dom';

/**
 * Draws a `slate.diff` result: a header with the version pair and the added / removed
 * counts, then one block per hunk with the line numbers on both sides.
 *
 * Read-only by design — a diff is a view of two files that already exist, so there is
 * nothing to edit here.
 */

function sign(line: SlateDiff['hunks'][number]['lines'][number]): string {
  if (line.kind === 'add') return '+';
  if (line.kind === 'del') return '-';
  return ' ';
}

export function renderSlateDiff(container: HTMLElement, diff: SlateDiff): void {
  clear(container);
  if (diff.identical) {
    container.append(
      h('p', {
        class: 'slate-diff-empty',
        text: `v${diff.from} and v${diff.to} hold the same lines.`,
      }),
    );
    return;
  }

  container.append(
    h('p', {
      class: 'slate-diff-summary',
      text: `v${diff.from} → v${diff.to} · +${diff.added} −${diff.removed} in ${diff.hunks.length} hunk${diff.hunks.length === 1 ? '' : 's'}`,
    }),
  );

  for (const hunk of diff.hunks) {
    const body = h('div', { class: 'slate-diff-body' });
    for (const line of hunk.lines) {
      body.append(
        h(
          'div',
          { class: `slate-diff-line ${line.kind}` },
          h('span', { class: 'slate-diff-n', text: line.from === undefined ? '' : String(line.from) }),
          h('span', { class: 'slate-diff-n', text: line.to === undefined ? '' : String(line.to) }),
          h('span', { class: 'slate-diff-sign', text: sign(line) }),
          h('span', { class: 'slate-diff-text', text: line.text }),
        ),
      );
    }
    container.append(
      h(
        'section',
        { class: 'slate-diff-hunk' },
        h('p', {
          class: 'slate-diff-range',
          text: `@@ -${hunk.fromStart},${hunk.fromCount} +${hunk.toStart},${hunk.toCount} @@`,
        }),
        body,
      ),
    );
  }
}

export function renderSlateDiffError(container: HTMLElement, message: string): void {
  clear(container);
  container.append(h('p', { class: 'slate-diff-error', text: `Could not diff these versions: ${message}` }));
}
