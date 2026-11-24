import type { SlateRef } from '../shared/protocol';
import { fenceTitle, fenceToDocument, promotableFences, stripFences, type FenceBlock } from '../shared/slateFence';
import type { SlateLocation, SlateStore } from './slates';

/**
 * Auto-promote: the long `html` / `svg` blocks in one assistant message become slates.
 *
 * This is the one place the transcript gives something up. The message keeps its prose and
 * a card per block; the block itself moves to a version file where it can be rendered,
 * diffed and promoted. The model's own history is untouched — the caller keeps the text it
 * sent to the model, only the display is trimmed.
 *
 * A store refusal is not an error the turn should die of: the block stays inline, which is
 * ugly but never loses the document.
 */
export async function promoteFences(
  store: Pick<SlateStore, 'create'>,
  location: SlateLocation,
  text: string,
  onRefused?: (title: string, reason: string) => void,
): Promise<{ refs: SlateRef[]; text: string }> {
  const blocks: FenceBlock[] = promotableFences(text);
  if (blocks.length === 0) return { refs: [], text };

  const refs: SlateRef[] = [];
  const promoted: FenceBlock[] = [];
  for (const block of blocks) {
    const title = fenceTitle(block);
    const document = fenceToDocument(block, title);
    try {
      const meta = await store.create({ ...location, title, kind: document.kind, content: document.content });
      refs.push({
        id: meta.id,
        title: meta.title,
        kind: meta.kind,
        version: meta.current,
        versions: meta.versions.length,
      });
      promoted.push(block);
    } catch (err) {
      onRefused?.(title, err instanceof Error ? err.message : String(err));
    }
  }

  return { refs, text: promoted.length ? stripFences(text, promoted) : text };
}
