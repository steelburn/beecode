import assert from 'node:assert/strict';
import test from 'node:test';
import { activeTabPosition, tabLabel, tabsSignature } from './browserTabs';
import type { BrowserState, BrowserTabInfo } from '../shared/browser';

const tab = (id: string, extra: Partial<BrowserTabInfo> = {}): BrowserTabInfo =>
  ({ id, url: `https://example.test/${id}`, title: `Page ${id}`, loading: false, ...extra }) as BrowserTabInfo;

const state = (tabs: BrowserTabInfo[], activeTabId: string) => ({ tabs, activeTabId }) as BrowserState;

test('tabLabel prefers the title, falls back to the url, then to untitled', () => {
  assert.equal(tabLabel(tab('a')), 'Page a');
  assert.equal(tabLabel(tab('a', { title: '' })), 'https://example.test/a');
  assert.equal(tabLabel(tab('a', { title: '', url: '' })), 'untitled');
  assert.equal(tabLabel(tab('a', { loading: true })), 'Page a\u2026');
  assert.equal(tabLabel(tab('a', { title: '', url: '', loading: true })), 'loading\u2026\u2026');
});

test('tabsSignature is stable while nothing the strip draws changes', () => {
  const base = state([tab('a'), tab('b', { active: true })], 'b');
  const cursorToggle = { ...base, cursor: { enabled: true } } as BrowserState;
  assert.equal(tabsSignature(base), tabsSignature(cursorToggle));
  assert.equal(tabsSignature(base), tabsSignature(state([tab('a'), tab('b', { active: true })], 'b')));
});

test('tabsSignature changes when a tab is added, activated, retitled or starts loading', () => {
  const base = state([tab('a'), tab('b')], 'a');
  assert.notEqual(tabsSignature(base), tabsSignature(state([tab('a'), tab('b'), tab('c')], 'a')));
  assert.notEqual(tabsSignature(base), tabsSignature(state([tab('a'), tab('b')], 'b')));
  assert.notEqual(
    tabsSignature(base),
    tabsSignature(state([tab('a'), tab('b', { title: 'Other' })], 'a')),
  );
  assert.notEqual(
    tabsSignature(base),
    tabsSignature(state([tab('a'), tab('b', { loading: true })], 'a')),
  );
});

test('activeTabPosition reports the 1-based active tab, 0 when nothing is active', () => {
  assert.equal(activeTabPosition(state([tab('a'), tab('b'), tab('c')], 'c')), 3);
  assert.equal(activeTabPosition(state([tab('a', { active: true })], 'missing')), 1);
  assert.equal(activeTabPosition(state([tab('a'), tab('b')], 'missing')), 0);
  assert.equal(activeTabPosition(state([], '')), 0);
});
