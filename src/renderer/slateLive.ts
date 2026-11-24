import type { SlateDelta } from '../shared/protocol';

/**
 * The live slate tiles: a fenced block that is still streaming has already become a
 * document, and the gallery follows it as it grows.
 *
 * Kept pure so the merge rules are testable without a DOM: the delta for an entry
 * replaces the previous one (the service sends the whole block so far, not a fragment),
 * and `done` marks it finished without removing it — `slate.update` retires the tile when
 * the real slate exists.
 */

export type LiveSlates = Record<string, SlateDelta>;

/** Applies one `slate.delta`; returns a new map so callers can compare identity. */
export function applySlateDelta(live: LiveSlates, delta: SlateDelta): LiveSlates {
  return { ...live, [delta.entryId]: delta };
}

/** Live tiles in the order their entry first appeared. */
export function liveSlateList(live: LiveSlates): SlateDelta[] {
  return Object.values(live);
}

/** Drops the tiles of every entry that now has a real slate. */
export function clearLiveSlates(live: LiveSlates, entryIds: string[]): LiveSlates {
  const gone = new Set(entryIds);
  const next: LiveSlates = {};
  for (const [entryId, delta] of Object.entries(live)) {
    if (!gone.has(entryId)) next[entryId] = delta;
  }
  return next;
}

/** `HTML · 52 lines` — the one-line state of a live tile. */
export function liveSlateLabel(delta: SlateDelta): string {
  const unit = delta.lines === 1 ? 'line' : 'lines';
  return delta.done ? `HTML · ${delta.lines} ${unit} · writing version` : `HTML · ${delta.lines} ${unit} · streaming`;
}
