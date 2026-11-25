import type { SlateSummary } from '../shared/protocol';
import type { SlateLiveBounds, SlateLiveState } from '../shared/slateSandbox';
import type { FileView } from './preview';
import { slateDocFromPath } from './slateDoc';

/**
 * Running a slate from its own document tab.
 *
 * A slate version opens as an ordinary document, and the tab's Preview is the app's *inert*
 * renderer: `sanitizeHtml` strips the scripts, so a page whose markup is a mount point
 * (`<div id="app"></div>`) previews as an empty box. The live host is the only place a
 * slate's own scripts may run, so a slate tab offers the same Run switch its tile in the
 * Slates tab has — next to the body the sandboxed page will cover.
 *
 * Everything here is pure, so the rules for *when* the tab may offer that are testable in
 * node: an html version (nothing else is executable), the Preview view (the Code view has no
 * page to cover), a slate of the session on screen (the store is addressed by session), and a
 * summary that says how far the user has already agreed.
 */

export interface SlateDocLiveTarget {
  /** The session the slate belongs to: a tab outlives the session it was opened in. */
  sessionId: string;
  id: string;
  /** The version this tab shows — the live page is per version, so a v2 run is not this tab's. */
  version: number;
  /** What the user already granted: the scripts may run at all. */
  allowed: boolean;
  /** Origins the user allowed it to fetch from; empty means it may reach nothing. */
  origins: readonly string[];
}

/**
 * The live target this tab could run, or undefined when it can run nothing.
 *
 * Undefined is also the answer when the slate has no summary: consent and origins live in the
 * summary, and the host refuses a slate nobody has agreed to, so a tab from another session
 * keeps the inert preview instead of a Run button that could only fail.
 */
export function slateDocLiveTarget(
  path: string,
  view: FileView,
  options: { sessionId: string | undefined; slates: readonly SlateSummary[] },
): SlateDocLiveTarget | undefined {
  if (view !== 'rendered') return undefined;
  const doc = slateDocFromPath(path);
  if (!doc || doc.ext !== 'html') return undefined;
  if (!options.sessionId || doc.session !== options.sessionId) return undefined;
  const summary = options.slates.find((slate) => slate.id === doc.id);
  if (!summary) return undefined;
  return {
    sessionId: doc.session,
    id: doc.id,
    version: doc.version,
    allowed: summary.live === true,
    origins: summary.origins ?? [],
  };
}

/**
 * Whether the live page on screen is *this* tab's.
 *
 * All three parts are compared: the host runs one page at a time, and a session, slate or
 * version mismatch means the rectangle it is covering belongs to someone else.
 */
export function slateDocHoldsLive(
  live: SlateLiveState | undefined,
  target: SlateDocLiveTarget | undefined,
): boolean {
  if (!live || live.visible !== true || !target) return false;
  return (
    live.sessionId === target.sessionId &&
    live.slateId === target.id &&
    live.version === target.version
  );
}

/** The rectangle the host must cover: a DOM rect in the window pixels the native view uses. */
export function slateLiveBoundsOf(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): SlateLiveBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** One origin per line or comma-separated — whoever types it should not have to care. */
export function parseSlateOrigins(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
