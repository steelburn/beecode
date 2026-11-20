import type { BrowserTabInfo } from '../../shared/browser';

/**
 * The dock tab's right-click menu, as data.
 *
 * Electron's `Menu` is not importable from a test (it drags the whole runtime in), so the
 * *rules* — which rows exist and when they grey out — live here and `host.ts` only maps them
 * onto a template. The interesting rule is the count: "Close other tabs" is meaningless on the
 * last tab standing, so it follows the number of *other* tabs, not the clicked one's position.
 */

/** What clicking a menu row asks the host to do; `null` marks a separator. */
export type TabMenuCommand = 'close' | 'close-others' | 'close-all';

export interface TabMenuItem {
  command: TabMenuCommand | null;
  label: string;
  enabled: boolean;
}

export function tabMenuItems(tabId: string, tabs: readonly BrowserTabInfo[]): TabMenuItem[] {
  const others = tabs.filter((tab) => tab.id !== tabId).length;
  return [
    { command: 'close', label: 'Close tab', enabled: true },
    {
      command: 'close-others',
      // "Close other tab" on the one left sounds like a typo; say what it actually closes.
      label: others === 1 ? 'Close other tab' : 'Close other tabs',
      enabled: others > 0,
    },
    // A separator, so "Close all tabs" does not read as another per-tab action.
    { command: null, label: '', enabled: false },
    { command: 'close-all', label: 'Close all tabs', enabled: tabs.length > 0 },
  ];
}
