import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserTabInfo } from '../../shared/browser';
import { tabMenuItems } from './tabMenu';

const tab = (id: string): BrowserTabInfo => ({ id, url: `https://example.test/${id}`, title: id, loading: false, active: false });

const labels = (tabId: string, ids: string[]) =>
  tabMenuItems(tabId, ids.map(tab)).map((item) => (item.command ? item.label : '---'));

test('tab menu closes the clicked tab and every other one', () => {
  const items = tabMenuItems('b', ['a', 'b', 'c'].map(tab));
  assert.deepEqual(
    items.map((item) => item.command),
    ['close', 'close-others', null, 'close-all'],
  );
  assert.ok(items.every((item) => item.command === null || item.enabled));
});

test('tab menu disables "close other tabs" on the only tab', () => {
  const items = tabMenuItems('a', [tab('a')]);
  const others = items.find((item) => item.command === 'close-others');
  assert.equal(others?.enabled, false);
  // Still there — a row that appears and disappears moves the one below it under the cursor.
  assert.ok(others);
});

test('tab menu says "other tab" when exactly one tab would close', () => {
  assert.deepEqual(labels('a', ['a', 'b']), ['Close tab', 'Close other tab', '---', 'Close all tabs']);
  assert.equal(tabMenuItems('a', ['a', 'b'].map(tab))[1].enabled, true);
});

test('tab menu survives a stale tab id', () => {
  // The menu is built from a state that can already have dropped the tab it was opened on.
  const items = tabMenuItems('gone', ['a', 'b'].map(tab));
  assert.equal(items.find((item) => item.command === 'close-others')?.enabled, true);
  assert.equal(items.find((item) => item.command === 'close-all')?.enabled, true);
});

test('tab menu greys out "close all tabs" on an empty strip', () => {
  const items = tabMenuItems('a', []);
  assert.equal(items.find((item) => item.command === 'close-all')?.enabled, false);
  assert.equal(items.find((item) => item.command === 'close-others')?.enabled, false);
});
