import type { FsFile } from '../shared/protocol';
import { canSwitchView, defaultView, fileKind, type FileKind, type FileView } from './preview';

/**
 * The main-area tab model: which documents are open, which one is on top, and how the
 * rendered views are themed.
 *
 * Pure data and pure transitions, so the rules hold in node without a DOM — re-opening a
 * file replaces its tab, closing the active tab falls back to a neighbour, a binary file
 * has no rendered view — and can be unit tested there. The DOM half is `mainArea.ts`.
 */

/** Chat is not a document, but it is the tab the user always comes back to. */
export const CHAT_TAB = 'chat';
/** The embedded browser is a singleton: the main process owns exactly one page view. */
export const BROWSER_TAB = 'browser';

/** How rendered documents paint. Source text and the app chrome do not follow it. */
export type DocTheme = 'dark' | 'light';

/** One open document, holding the text the service already read for the preview. */
export interface DocTab {
  /** Absolute path; also the identity of the tab. */
  path: string;
  name: string;
  kind: FileKind;
  text: string;
  size: number;
  /** True when the service clipped the text to the preview budget. */
  truncated: boolean;
  /** True when the content is not text, so there is nothing to render. */
  binary: boolean;
  view: FileView;
}

export interface DocTabsState {
  tabs: DocTab[];
  /** `CHAT_TAB`, `BROWSER_TAB`, or the id of an open document (`docId`). */
  active: string;
  theme: DocTheme;
}

/** The id of a document tab. A path is unique inside one workspace, so it can be the id. */
export function docId(path: string): string {
  return `doc:${path}`;
}

/** True when `id` names a document tab rather than the chat or the browser. */
export function isDocId(id: string): boolean {
  return id.startsWith('doc:');
}

export function emptyDocTabs(theme: DocTheme = 'dark'): DocTabsState {
  return { tabs: [], active: CHAT_TAB, theme };
}

/**
 * Open a file as a tab and bring it to the front.
 *
 * Idempotent: re-opening the same path keeps its position and the view the user picked, so
 * clicking a file twice never stacks duplicates or cancels a deliberate source/rendered
 * choice.
 */
export function openDoc(state: DocTabsState, file: FsFile): DocTabsState {
  const kind = fileKind(file.name);
  const previous = state.tabs.find((tab) => tab.path === file.path);
  const tab: DocTab = {
    path: file.path,
    name: file.name,
    kind,
    text: file.text,
    size: file.size,
    truncated: file.truncated,
    binary: file.binary,
    view: file.binary || !canSwitchView(kind) ? defaultView(kind) : (previous?.view ?? defaultView(kind)),
  };
  const tabs = previous
    ? state.tabs.map((entry) => (entry.path === tab.path ? tab : entry))
    : [...state.tabs, tab];
  return { ...state, tabs, active: docId(tab.path) };
}

/**
 * Close one document tab. The chat stays reachable: closing the active tab activates the
 * tab that slid into its place (otherwise the one before it, otherwise chat).
 */
export function closeDoc(state: DocTabsState, path: string): DocTabsState {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.path !== path);
  if (state.active !== docId(path)) return { ...state, tabs };
  const neighbour = tabs[index] ?? tabs[index - 1];
  return { ...state, tabs, active: neighbour ? docId(neighbour.path) : CHAT_TAB };
}

/** Switch one document between rendered and source. Kinds without the choice keep theirs. */
export function setDocView(state: DocTabsState, path: string, view: FileView): DocTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.path === path && canSwitchView(tab.kind) && !tab.binary ? { ...tab, view } : tab,
    ),
  };
}

/**
 * Activate a tab. A stale document id (its tab was closed) falls back to chat instead of
 * leaving the main area on a document that is no longer there.
 */
export function activateTab(state: DocTabsState, id: string): DocTabsState {
  if (id === CHAT_TAB || id === BROWSER_TAB) return { ...state, active: id };
  const known = state.tabs.some((tab) => docId(tab.path) === id);
  return { ...state, active: known ? id : CHAT_TAB };
}

/** Flip rendered documents between dark and light. */
export function toggleTheme(state: DocTabsState): DocTabsState {
  return { ...state, theme: state.theme === 'light' ? 'dark' : 'light' };
}

/** The class that carries the theme tokens a rendered document inherits. */
export function docThemeClass(theme: DocTheme): string {
  return theme === 'light' ? 'doc-light' : 'doc-dark';
}

/** The document behind the active tab, if the active tab is one. */
export function activeDoc(state: DocTabsState): DocTab | undefined {
  return state.tabs.find((tab) => docId(tab.path) === state.active);
}
