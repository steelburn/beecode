import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlateDelta } from '../shared/protocol';
import { applySlateDelta, clearLiveSlates, liveSlateLabel, liveSlateList } from './slateLive';

function delta(entryId: string, overrides: Partial<SlateDelta> = {}): SlateDelta {
  return {
    sessionId: 's1',
    entryId,
    title: 'Sales Q3',
    kind: 'html',
    text: '<p>one</p>',
    lines: 42,
    done: false,
    ...overrides,
  };
}

test('a delta replaces the previous one for the same entry', () => {
  const first = applySlateDelta({}, delta('e1'));
  const second = applySlateDelta(first, delta('e1', { text: '<p>two</p>', lines: 60 }));
  assert.equal(Object.keys(second).length, 1);
  assert.equal(second.e1.text, '<p>two</p>');
  assert.equal(second.e1.lines, 60);
});

test('deltas for different entries are kept apart, in arrival order', () => {
  const live = applySlateDelta(applySlateDelta({}, delta('e1')), delta('e2', { title: 'Chart' }));
  assert.deepEqual(
    liveSlateList(live).map((entry) => entry.title),
    ['Sales Q3', 'Chart'],
  );
});

test('clearing one entry leaves the others streaming', () => {
  const live = applySlateDelta(applySlateDelta({}, delta('e1')), delta('e2'));
  const next = clearLiveSlates(live, ['e1']);
  assert.deepEqual(Object.keys(next), ['e2']);
});

test('clearing an entry that is not live changes nothing', () => {
  const live = applySlateDelta({}, delta('e1'));
  assert.deepEqual(clearLiveSlates(live, ['nope']), live);
});

test('the label says streaming, then writing the version', () => {
  assert.equal(liveSlateLabel(delta('e1')), 'HTML · 42 lines · streaming');
  assert.equal(liveSlateLabel(delta('e1', { done: true })), 'HTML · 42 lines · writing version');
  assert.equal(liveSlateLabel(delta('e1', { lines: 1 })), 'HTML · 1 line · streaming');
});
