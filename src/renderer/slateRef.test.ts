import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slateCardVersionLabel, slateRefOf } from './slateRef';

/**
 * `slateRefOf` runs on tool-result metadata the model produced, so it has to be total: a
 * malformed `meta.slate` must degrade to the plain tool card, never throw and never put a
 * half-filled card in the transcript.
 */

test('a well-formed meta.slate becomes the transcript card ref', () => {
  const ref = slateRefOf({
    slate: { id: 'sales-q3', title: 'Sales Q3', kind: 'markdown', version: 2, versions: 3 },
  });
  assert.deepEqual(ref, {
    id: 'sales-q3',
    title: 'Sales Q3',
    kind: 'markdown',
    version: 2,
    versions: 3,
  });
});

test('tool results without a slate carry no ref', () => {
  assert.equal(slateRefOf(undefined), undefined);
  assert.equal(slateRefOf({}), undefined);
  assert.equal(slateRefOf({ slate: null }), undefined);
  assert.equal(slateRefOf({ slate: 'sales-q3' }), undefined);
});

test('a slate without an id or title is not card-worthy', () => {
  assert.equal(slateRefOf({ slate: { title: 'Sales Q3', kind: 'markdown' } }), undefined);
  assert.equal(slateRefOf({ slate: { id: 'sales-q3', kind: 'markdown' } }), undefined);
  assert.equal(slateRefOf({ slate: { id: '', title: 'Sales Q3', kind: 'markdown' } }), undefined);
});

test('an unknown kind falls back to the plain tool card', () => {
  assert.equal(slateRefOf({ slate: { id: 'x', title: 'X', kind: 'pdf' } }), undefined);
  assert.equal(slateRefOf({ slate: { id: 'x', title: 'X', kind: 7 } }), undefined);
});

test('version numbers are repaired instead of trusted', () => {
  const ref = slateRefOf({ slate: { id: 'x', title: 'X', kind: 'csv', version: 0, versions: 0 } });
  assert.equal(ref?.version, 1);
  assert.equal(ref?.versions, 1);

  // A version above the reported count is what the model can get wrong; the card shows the
  // version it was told, but the count never claims fewer versions than that.
  const ahead = slateRefOf({ slate: { id: 'x', title: 'X', kind: 'csv', version: 4, versions: 2 } });
  assert.equal(ahead?.version, 4);
  assert.equal(ahead?.versions, 4);

  const missing = slateRefOf({ slate: { id: 'x', title: 'X', kind: 'csv', version: '2' } });
  assert.equal(missing?.version, 1);
});

test('the card label names the version, and the total only when there are several', () => {
  assert.equal(
    slateCardVersionLabel({ id: 'x', title: 'X', kind: 'markdown', version: 1, versions: 1 }),
    'v1',
  );
  assert.equal(
    slateCardVersionLabel({ id: 'x', title: 'X', kind: 'markdown', version: 2, versions: 3 }),
    'v2 of 3',
  );
});
