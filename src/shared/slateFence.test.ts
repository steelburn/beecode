import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fenceTitle,
  fenceToDocument,
  openPromotableFence,
  promotableFences,
  scanFences,
  stripFences,
} from './slateFence';

const LONG = ['<div>', ...Array.from({ length: 40 }, (_, i) => `<p>line ${i}</p>`), '</div>'].join('\n');
const SHORT = ['<div>', '<p>hi</p>', '</div>'].join('\n');

function fenced(body: string, info = 'html', closing = true): string {
  return ['Before the page.', '', `\`\`\`${info}`, body, closing ? '```' : '', 'After it.'].join('\n');
}

test('a 40-line html block is promoted, a 5-line one is not', () => {
  assert.equal(promotableFences(fenced(LONG)).length, 1);
  assert.equal(promotableFences(fenced(SHORT)).length, 0);
});

test('the line count ignores the trailing newline and the fences', () => {
  const [block] = scanFences(fenced(LONG));
  assert.equal(block.lines, 42);
  assert.equal(block.info, 'html');
});

test('other fence kinds are left alone', () => {
  assert.equal(promotableFences(fenced(LONG, 'ts')).length, 0);
  assert.equal(promotableFences(fenced(LONG, '')).length, 0);
});

test('a fenced html sample inside a code block is not a real block', () => {
  const text = ['````md', '```html', LONG, '```', '````'].join('\n');
  assert.deepEqual(promotableFences(text), []);
});

test('an unclosed block counts as streaming, not promotable', () => {
  const text = ['Intro.', '', '```html', LONG].join('\n');
  assert.deepEqual(promotableFences(text), []);
  const open = openPromotableFence(text);
  assert.ok(open);
  assert.equal(open?.closed, false);
  assert.equal(open?.lines, 42);
});

test('a short open block is not worth a delta', () => {
  assert.equal(openPromotableFence(['```html', SHORT].join('\n')), undefined);
});

test('openPromotableFence ignores a block that already closed', () => {
  assert.equal(openPromotableFence(fenced(LONG)), undefined);
});

test('stripping leaves the prose and collapses the leftover blank lines', () => {
  const text = fenced(LONG);
  const stripped = stripFences(text, promotableFences(text));
  assert.equal(stripped, 'Before the page.\n\nAfter it.');
});

test('stripping two blocks keeps the text between them', () => {
  const text = [`\`\`\`html`, LONG, '```', 'Middle.', '```html', LONG, '```'].join('\n');
  const stripped = stripFences(text, promotableFences(text));
  assert.equal(stripped, 'Middle.');
});

test('the title comes from <title>, then the first heading, then the fence kind', () => {
  assert.equal(fenceTitle(scanFences(fenced(`<title>Sales Q3</title>\n${LONG}`))[0]), 'Sales Q3');
  assert.equal(fenceTitle(scanFences(fenced(`<h1>Revenue</h1>\n${LONG}`))[0]), 'Revenue');
  assert.equal(fenceTitle(scanFences(fenced(LONG))[0]), 'HTML document');
  assert.equal(fenceTitle(scanFences(fenced(LONG, 'svg'))[0]), 'SVG image');
});

test('an html fence becomes the document verbatim', () => {
  const [block] = scanFences(fenced(LONG));
  const document = fenceToDocument(block, 'Anything');
  assert.equal(document.kind, 'html');
  assert.ok(document.content.startsWith('<div>'));
});

test('an svg fragment is wrapped in a page that centres it', () => {
  const [block] = scanFences(fenced('<svg width="10" height="10"></svg>', 'svg'));
  const document = fenceToDocument(block, 'Logo <beta>');
  assert.equal(document.kind, 'html');
  assert.ok(document.content.startsWith('<!doctype html>'));
  assert.ok(document.content.includes('<title>Logo &lt;beta&gt;</title>'));
  assert.ok(document.content.includes('<svg width="10" height="10"></svg>'));
});
