import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffSlateText, splitLines } from './slateDiff';

test('identical versions produce no hunks', () => {
  const diff = diffSlateText(1, 2, 'a\nb\n', 'a\nb\n');
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.hunks, []);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
});

test('an added line is one add, numbered on the newer side only', () => {
  const diff = diffSlateText(1, 2, 'a\nb\n', 'a\nb\nc\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
  const lines = diff.hunks[0].lines;
  const added = lines.find((line) => line.kind === 'add');
  assert.equal(added?.text, 'c');
  assert.equal(added?.to, 3);
  assert.equal(added?.from, undefined);
});

test('a changed line is a removal and an addition side by side', () => {
  const diff = diffSlateText(1, 2, 'a\nold\nc\n', 'a\nnew\nc\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  const kinds = diff.hunks[0].lines.map((line) => line.kind);
  assert.deepEqual(kinds, ['context', 'del', 'add', 'context']);
});

test('hunk ranges count the lines on each side', () => {
  const diff = diffSlateText(1, 2, 'a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n');
  const hunk = diff.hunks[0];
  assert.equal(hunk.fromStart, 1);
  assert.equal(hunk.fromCount, 5);
  assert.equal(hunk.toStart, 1);
  assert.equal(hunk.toCount, 5);
});

test('distant changes split into separate hunks, close ones stay together', () => {
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const far = [...base];
  far[0] = 'changed at the top';
  far[39] = 'changed at the bottom';
  assert.equal(diffSlateText(1, 2, base.join('\n'), far.join('\n')).hunks.length, 2);

  const near = [...base];
  near[10] = 'first change';
  near[12] = 'second change';
  assert.equal(diffSlateText(1, 2, base.join('\n'), near.join('\n')).hunks.length, 1);
});

test('an empty older version reads as one big addition', () => {
  const diff = diffSlateText(1, 2, '', 'a\nb\n');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
  assert.equal(diff.identical, false);
});

test('splitLines ignores one trailing newline only', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\n'), ['a']);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
});
