import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slateDocFromPath, slateExportName } from './slateDoc';

/**
 * A slate version reaches the renderer as a plain document path, so these helpers decide
 * from that path alone whether a tab gets the slate controls. A path the store would not
 * have written must fall through to an ordinary document tab, not to a half-slate one.
 */

const at = ['work', 'demo', '.beecode', 'slates', 'session-1', 'sales-q3'];

test('a store version path decodes into the slate it belongs to', () => {
  assert.deepEqual(slateDocFromPath(`/${at.join('/')}/002-sales-q3.md`), {
    session: 'session-1',
    id: 'sales-q3',
    version: 2,
    ext: 'md',
  });
});

test('a windows path decodes the same way', () => {
  assert.deepEqual(
    slateDocFromPath('C:\\work\\demo\\.beecode\\slates\\s1\\bars\\001-bars.html'),
    { session: 's1', id: 'bars', version: 1, ext: 'html' },
  );
});

test('an ordinary workspace file is not a slate', () => {
  assert.equal(slateDocFromPath('/work/demo/notes/002-sales-q3.md'), undefined);
  assert.equal(slateDocFromPath('/work/demo/.beecode/slates/session-1/sales-q3.md'), undefined);
  assert.equal(slateDocFromPath(''), undefined);
});

test('a folder and file name that disagree are not a version', () => {
  // The store always writes `NNN-<id>.<ext>`, so a file dropped in by hand is just a file.
  assert.equal(slateDocFromPath(`/${at.join('/')}/002-other.md`), undefined);
});

test('a prefix shorter than three digits is not a version', () => {
  assert.equal(slateDocFromPath(`/${at.join('/')}/2-sales-q3.md`), undefined);
  assert.equal(slateDocFromPath(`/${at.join('/')}/sales-q3.md`), undefined);
});

test('four-digit versions decode too, and the extension is normalised', () => {
  assert.deepEqual(slateDocFromPath(`/${at.join('/')}/0100-sales-q3.CSV`), {
    session: 'session-1',
    id: 'sales-q3',
    version: 100,
    ext: 'csv',
  });
});

test('the export name carries the version the store file name buries', () => {
  assert.equal(
    slateExportName({ session: 'session-1', id: 'sales-q3', version: 12, ext: 'csv' }),
    'sales-q3-v12.csv',
  );
});
