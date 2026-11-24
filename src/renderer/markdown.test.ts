import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from './dom';

test('renderMarkdown escapes raw html so model output cannot inject markup', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.match(html, /&lt;img/);
  assert.ok(!html.includes('<img'));
});

test('renderMarkdown renders headings, rules and emphasis', () => {
  const html = renderMarkdown('# Title\n\n---\n\nSome **bold**, *italic* and ~~gone~~ text.');
  assert.match(html, /<h1 class="md-heading">Title<\/h1>/);
  assert.match(html, /<hr class="md-hr"\/>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>gone<\/del>/);
});

test('renderMarkdown nests ordered and unordered lists', () => {
  const html = renderMarkdown('- one\n  - nested\n- two\n\n1. first\n2. second');
  assert.match(html, /<ul class="md-list"><li>one<ul class="md-list"><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol class="md-list"><li>first<\/li><li>second<\/li><\/ol>/);
});

test('renderMarkdown renders a GFM table with alignment', () => {
  const html = renderMarkdown('| Tool | Calls |\n| --- | ---: |\n| shell | 3 |');
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th style="text-align:right">Calls<\/th>/);
  assert.match(html, /<td style="text-align:left">shell<\/td>/);
});

test('renderMarkdown labels code fences and leaves their content unformatted', () => {
  const html = renderMarkdown('```ts\nconst a = **not bold**;\n```');
  assert.match(html, /<pre class="md-pre" data-lang="ts"><code>/);
  assert.match(html, /\*\*not bold\*\*/);
  assert.ok(!html.includes('<strong>'));
});

test('renderMarkdown keeps inline code literal and only links safe schemes', () => {
  const html = renderMarkdown('Use `**x**` and [docs](https://example.com/a?b=1&c=2) or [bad](javascript:alert(1)).');
  assert.match(html, /<code>\*\*x\*\*<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noreferrer noopener">docs<\/a>/);
  assert.ok(!html.includes('href="javascript:'));
});

test('renderMarkdown turns a chart fence into a chart figure', () => {
  const html = renderMarkdown('```chart\n{"labels":["a","b"],"values":[1,2]}\n```');
  assert.match(html, /<figure class="chart-block">/);
  assert.ok(!html.includes('<pre'), 'the chart spec must not also be shown as code');
});

test('renderMarkdown keeps a soft line break so user messages show their newlines', () => {
  const html = renderMarkdown('first line\nsecond line');
  assert.match(html, /<p class="md-p">first line<br\/>second line<\/p>/);
});

test('renderMarkdown renders a blockquote and a still-streaming code fence', () => {
  const quote = renderMarkdown('> quoted **line**');
  assert.match(quote, /<blockquote class="md-quote">quoted <strong>line<\/strong><\/blockquote>/);
  const streaming = renderMarkdown('```js\nconst x = 1;');
  assert.match(streaming, /<pre class="md-pre" data-lang="js"><code>const x = 1;<\/code><\/pre>/);
});
