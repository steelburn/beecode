import assert from 'node:assert/strict';
import test from 'node:test';
import type { FsFile } from '../shared/protocol';
import {
  BROWSER_TAB,
  CHAT_TAB,
  activateTab,
  activeDoc,
  closeDoc,
  docId,
  docThemeClass,
  emptyDocTabs,
  isDocId,
  openDoc,
  setDocView,
  toggleTheme,
} from './docTabs';

function file(path: string, overrides: Partial<FsFile> = {}): FsFile {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    size: 100,
    truncated: false,
    binary: false,
    text: '# hello',
    ...overrides,
  };
}

test('openDoc adds a tab, activates it and picks the kind\'s default view', () => {
  const state = openDoc(emptyDocTabs(), file('/ws/readme.md'));
  assert.equal(state.tabs.length, 1);
  assert.equal(state.active, docId('/ws/readme.md'));
  assert.equal(state.tabs[0]?.kind, 'markdown');
  assert.equal(state.tabs[0]?.view, 'rendered');
  assert.equal(openDoc(emptyDocTabs(), file('/ws/notes.txt')).tabs[0]?.view, 'source');
});

test('re-opening a file keeps its position and the view the user picked', () => {
  let state = openDoc(emptyDocTabs(), file('/ws/a.md'));
  state = openDoc(state, file('/ws/b.html'));
  state = setDocView(state, '/ws/a.md', 'source');
  state = openDoc(state, file('/ws/a.md', { text: '# changed' }));
  assert.deepEqual(
    state.tabs.map((tab) => tab.path),
    ['/ws/a.md', '/ws/b.html'],
  );
  assert.equal(state.tabs[0]?.view, 'source');
  assert.equal(state.tabs[0]?.text, '# changed');
  assert.equal(state.active, docId('/ws/a.md'));
});

test('closing the active tab activates the tab that took its place', () => {
  let state = openDoc(emptyDocTabs(), file('/ws/a.md'));
  state = openDoc(state, file('/ws/b.md'));
  state = openDoc(state, file('/ws/c.md'));
  state = activateTab(state, docId('/ws/b.md'));
  const closed = closeDoc(state, '/ws/b.md');
  assert.deepEqual(
    closed.tabs.map((tab) => tab.path),
    ['/ws/a.md', '/ws/c.md'],
  );
  assert.equal(closed.active, docId('/ws/c.md'));
});

test('closing the last tab falls back to chat, a background close keeps the active tab', () => {
  let state = openDoc(emptyDocTabs(), file('/ws/a.md'));
  state = openDoc(state, file('/ws/b.md'));
  const stillOnB = closeDoc(state, '/ws/a.md');
  assert.equal(stillOnB.active, docId('/ws/b.md'));
  assert.equal(stillOnB.tabs.length, 1);

  const empty = closeDoc(stillOnB, '/ws/b.md');
  assert.equal(empty.tabs.length, 0);
  assert.equal(empty.active, CHAT_TAB);

  // Closing something that is not open is a no-op, not a state change.
  assert.equal(closeDoc(empty, '/ws/never.md'), empty);
});

test('the browser tab behaves like a tab and survives doc churn', () => {
  let state = activateTab(openDoc(emptyDocTabs(), file('/ws/a.md')), BROWSER_TAB);
  assert.equal(state.active, BROWSER_TAB);
  assert.equal(closeDoc(state, '/ws/a.md').active, BROWSER_TAB);
  assert.equal(activateTab(state, 'doc:/ws/gone.md').active, CHAT_TAB);
});

test('setDocView only applies to kinds that offer both views', () => {
  let state = openDoc(emptyDocTabs(), file('/ws/notes.txt'));
  state = setDocView(state, '/ws/notes.txt', 'rendered');
  assert.equal(state.tabs[0]?.view, 'source');

  state = openDoc(state, file('/ws/binary.png', { binary: true, text: '' }));
  assert.equal(state.tabs[1]?.view, 'source');
  assert.equal(activeDoc(state)?.path, '/ws/binary.png');
});

test('the theme flips and is carried by the class the rendered pane uses', () => {
  const light = toggleTheme(emptyDocTabs());
  assert.equal(light.theme, 'light');
  assert.equal(toggleTheme(light).theme, 'dark');
  assert.equal(docThemeClass('light'), 'doc-light');
  assert.equal(docThemeClass('dark'), 'doc-dark');
  assert.equal(emptyDocTabs('light').theme, 'light');
});

test('tab ids distinguish documents from the two fixed views', () => {
  assert.equal(isDocId(docId('/ws/a.md')), true);
  assert.equal(isDocId(CHAT_TAB), false);
  assert.equal(isDocId(BROWSER_TAB), false);
  assert.equal(activeDoc(emptyDocTabs()), undefined);
});
