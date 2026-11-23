import assert from 'node:assert/strict';
import test from 'node:test';
import { delimiterName, isNumericCell, parseCsv, sniffDelimiter } from './csv';

test('a comma file splits into a header and rows', () => {
  const table = parseCsv('name,qty\napple,3\npear,12\n');
  assert.equal(table.delimiter, ',');
  assert.deepEqual(table.header, ['name', 'qty']);
  assert.deepEqual(table.rows, [
    ['apple', '3'],
    ['pear', '12'],
  ]);
  assert.equal(table.columns, 2);
  assert.equal(table.truncated, false);
});

test('quoted fields keep their delimiter, their quotes and their newlines', () => {
  const table = parseCsv('a,b\n"x, y","he said ""hi"""\n"two\nlines",z\n');
  assert.deepEqual(table.rows[0], ['x, y', 'he said "hi"']);
  assert.deepEqual(table.rows[1], ['two\nlines', 'z']);
});

test('a semicolon export is not mistaken for a comma one', () => {
  const text = 'name;city\nSmith, John;Utrecht\nDoe, Jane;Delft\n';
  assert.equal(sniffDelimiter(text), ';');
  const table = parseCsv(text);
  assert.deepEqual(table.header, ['name', 'city']);
  assert.deepEqual(table.rows[1], ['Doe, Jane', 'Delft']);
});

test('tabs and pipes are recognised too', () => {
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(sniffDelimiter('a|b|c\n1|2|3\n'), '|');
  assert.equal(delimiterName('\t'), 'tab');
  assert.equal(delimiterName(';'), 'semicolon');
  assert.equal(delimiterName('|'), 'pipe');
  assert.equal(delimiterName(','), 'comma');
});

test('short rows are padded so cells stay under their header', () => {
  const table = parseCsv('a,b,c\n1\n2,3\n');
  assert.equal(table.columns, 3);
  assert.deepEqual(table.rows[0], ['1', '', '']);
  assert.deepEqual(table.rows[1], ['2', '3', '']);
});

test('the row cap stops parsing and says so', () => {
  const lines = ['a,b', ...Array.from({ length: 50 }, (_, index) => `${index},x`)].join('\n');
  const table = parseCsv(lines, 5);
  assert.equal(table.rows.length, 5);
  assert.equal(table.truncated, true);
});

test('a byte order mark and CRLF endings are handled', () => {
  const table = parseCsv('\uFEFFa,b\r\n1,2\r\n');
  assert.deepEqual(table.header, ['a', 'b']);
  assert.deepEqual(table.rows, [['1', '2']]);
});

test('only bare numbers are right-aligned', () => {
  assert.equal(isNumericCell('42'), true);
  assert.equal(isNumericCell('-3.5'), true);
  assert.equal(isNumericCell(' 1,200 '), true);
  assert.equal(isNumericCell('12 apples'), false);
  assert.equal(isNumericCell(''), false);
  assert.equal(isNumericCell('n/a'), false);
});
