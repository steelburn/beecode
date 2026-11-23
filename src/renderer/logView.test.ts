import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyLogLine,
  countLogLevels,
  filterLogLines,
  highlightRanges,
  LOG_LEVELS,
  splitLogLines,
  splitLogPrefix,
} from './logView';

test('level words and bracketed levels are recognised', () => {
  assert.equal(classifyLogLine('2024-05-01 10:00:00 ERROR boom'), 'error');
  assert.equal(classifyLogLine('[WARN] disk almost full'), 'warn');
  assert.equal(classifyLogLine('info: service started'), 'info');
  assert.equal(classifyLogLine('Debug: reading config'), 'debug');
  assert.equal(classifyLogLine('trace 1 -> 2'), 'trace');
  assert.equal(classifyLogLine('just a line'), 'other');
});

test('the most severe level on a line wins', () => {
  assert.equal(classifyLogLine('info: handled the error and continued'), 'error');
  assert.equal(classifyLogLine('warning: deprecation failed'), 'error');
  assert.equal(classifyLogLine('debug: warning path'), 'warn');
});

test('lines are split without the trailing empty line', () => {
  assert.deepEqual(splitLogLines('a\r\nb\n\n'), ['a', 'b']);
  assert.deepEqual(splitLogLines(''), []);
});

test('a leading timestamp is split off the message', () => {
  assert.deepEqual(splitLogPrefix('2024-05-01T10:00:00.123Z ready'), {
    prefix: '2024-05-01T10:00:00.123Z',
    rest: ' ready',
  });
  assert.deepEqual(splitLogPrefix('[2024-05-01 10:00:00] ready'), {
    prefix: '[2024-05-01 10:00:00]',
    rest: ' ready',
  });
  assert.deepEqual(splitLogPrefix('no timestamp here'), { prefix: '', rest: 'no timestamp here' });
});

test('lines are counted per level', () => {
  const counts = countLogLevels(['error a', 'warn b', 'plain', 'error c']);
  assert.equal(counts.error, 2);
  assert.equal(counts.warn, 1);
  assert.equal(counts.other, 1);
  assert.equal(counts.info, 0);
  assert.equal(LOG_LEVELS.length, 6);
});

test('the level filter keeps only the chosen levels and numbers lines by file position', () => {
  const lines = ['plain', 'error a', 'info b', 'error c'];
  const result = filterLogLines(lines, { levels: ['error'] });
  assert.equal(result.total, 4);
  assert.equal(result.shown, 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.number),
    [2, 4],
  );
  assert.equal(result.entries[0].level, 'error');
});

test('search narrows the lines and counts every match', () => {
  const lines = ['error disk full', 'info disk ok', 'error disk full again'];
  const result = filterLogLines(lines, { query: 'DISK' });
  assert.equal(result.shown, 3);
  assert.equal(result.hits, 3);
  const narrow = filterLogLines(lines, { levels: ['error'], query: 'again' });
  assert.equal(narrow.shown, 1);
  assert.equal(narrow.hits, 1);
});

test('search matches are case-insensitive and non-overlapping', () => {
  assert.deepEqual(highlightRanges('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  assert.deepEqual(highlightRanges('Timeout TIMEOUT', 'timeout'), [
    { start: 0, end: 7 },
    { start: 8, end: 15 },
  ]);
  assert.deepEqual(highlightRanges('anything', '   '), []);
});
