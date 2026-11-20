import type { BrowserState, BrowserTabInfo } from '../shared/browser';

/**
 * Pure helpers for the internal browser's tab strip.
 *
 * The strip is re-rendered from `BrowserState`, which the host emits on every navigation,
 * title change, loading toggle and cursor toggle. Deciding here — away from the DOM — what a
 * tab says, whether anything the strip draws actually changed, and where the active tab sits
 * keeps that logic testable: the renderer tests run without a DOM.
 */

/** Label shown inside a tab: the page title, falling back to the URL, marked while loading. */
export function tabLabel(tab: BrowserTabInfo): string {
  if (tab.loading) return `${tab.title || tab.url || 'loading\u2026'}\u2026`;
  return tab.title || tab.url || 'untitled';
}

/**
 * Identity of everything the strip draws. While it stays the same the strip is left alone, so
 * a cursor toggle cannot throw away the scroll position the user scrolled to.
 */
export function tabsSignature(state: BrowserState): string {
  const tabs = state.tabs.map((tab) =>
    [tab.id, tab.title, tab.url, tab.loading ? 1 : 0, tab.active ? 1 : 0].join('\u0001'),
  );
  return [state.activeTabId ?? '', ...tabs].join('\u0002');
}

/** 1-based position of the active tab, or 0 when there is none — the `2` in `2/5`. */
export function activeTabPosition(state: BrowserState): number {
  const index = state.tabs.findIndex((tab) => tab.active || tab.id === state.activeTabId);
  return index < 0 ? 0 : index + 1;
}
