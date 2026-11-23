import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionSummary } from '../shared/protocol';
import { groupSessions, workspaceKey, workspaceLabel, workspaceOf } from './sessionGroups';

function session(id: string, workspace: string, updatedAt: string, cwd = workspace): SessionSummary {
  return {
    id,
    title: id,
    cwd,
    mode: 'act',
    model: 'test-model',
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    workspace,
  };
}

test('the workspace falls back to the working directory', () => {
  assert.equal(workspaceOf({ workspace: 'D:\\work\\a', cwd: 'D:\\work\\a\\sub' }), 'D:\\work\\a');
  assert.equal(workspaceOf({ cwd: 'D:\\work\\a' } as never), 'D:\\work\\a');
  assert.equal(workspaceOf({ cwd: '' } as never), '');
});

test('paths are compared the way Windows compares them', () => {
  assert.equal(workspaceKey('D:\\Work\\A\\'), workspaceKey('d:/work/a'));
  assert.equal(workspaceLabel('D:\\work\\beecode-desktop'), 'beecode-desktop');
  assert.equal(workspaceLabel('D:\\work\\beecode-desktop\\'), 'beecode-desktop');
  assert.equal(workspaceLabel(''), '');
});

test('the open workspace comes first, the rest by recency', () => {
  const groups = groupSessions(
    [
      session('a1', 'D:\\work\\alpha', '2026-01-01T10:00:00.000Z'),
      session('b1', 'D:\\work\\beta', '2026-02-01T10:00:00.000Z'),
      session('a2', 'D:\\work\\alpha', '2026-03-01T10:00:00.000Z'),
    ],
    'd:/work/alpha/',
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ['alpha', 'beta'],
  );
  assert.equal(groups[0].current, true);
  assert.equal(groups[0].detail, 'D:\\work\\alpha');
  assert.deepEqual(
    groups[0].sessions.map((entry) => entry.id),
    ['a1', 'a2'],
  );
});

test('workspaces that differ only in case are one group', () => {
  const groups = groupSessions([
    session('one', 'D:\\Work\\Proj', '2026-01-01T10:00:00.000Z'),
    session('two', 'd:\\work\\proj', '2026-01-02T10:00:00.000Z'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions.length, 2);
});

test('a session without a workspace keeps its own group', () => {
  const groups = groupSessions([session('loose', '', '2026-01-01T10:00:00.000Z')], 'D:\\work\\alpha');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'No workspace');
  assert.equal(groups[0].current, false);
});
