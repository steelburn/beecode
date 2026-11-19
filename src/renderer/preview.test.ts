import assert from 'node:assert/strict';
import test from 'node:test';
import { canSwitchView, defaultView, fileKind, htmlPreviewMarkup, sanitizeHtml } from './preview';

test('fileKind classifies markdown, html and everything else', () => {
  assert.equal(fileKind('README.md'), 'markdown');
  assert.equal(fileKind('notes.Markdown'), 'markdown');
  assert.equal(fileKind('index.html'), 'html');
  assert.equal(fileKind('page.HTM'), 'html');
  assert.equal(fileKind('app.ts'), 'text');
  assert.equal(fileKind('LICENSE'), 'text');
  assert.equal(fileKind('archive.md.bak'), 'text');
});

test('markdown and html default to the rendered view, plain text has no switch', () => {
  assert.equal(defaultView('markdown'), 'rendered');
  assert.equal(defaultView('html'), 'rendered');
  assert.equal(defaultView('text'), 'source');
  assert.equal(canSwitchView('text'), false);
  assert.equal(canSwitchView('markdown'), true);
});

test('sanitizeHtml drops scripting blocks together with their content', () => {
  const html = sanitizeHtml('<p>ok</p><script>alert(1)</script><iframe src="x"></iframe><p>after</p>');
  assert.ok(!html.includes('alert'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<iframe'));
  assert.match(html, /<p>ok<\/p>/);
  assert.match(html, /<p>after<\/p>/);
});

test('sanitizeHtml drops an unclosed script block rather than leaking the rest', () => {
  const html = sanitizeHtml('<p>ok</p><script>const a = "<b>";');
  assert.ok(!html.includes('const a'));
  assert.match(html, /<p>ok<\/p>/);
});

test('sanitizeHtml strips inline handlers and scripting urls', () => {
  const html = sanitizeHtml('<img src="a.png" onerror="alert(1)"><a href="javascript:alert(1)">x</a>');
  assert.ok(!html.includes('onerror'));
  assert.ok(!html.includes('javascript:'));
  assert.match(html, /<img src="a.png">/);
  assert.match(html, /<a>x<\/a>/);
});

test('sanitizeHtml keeps ordinary markup, styles and safe attribute values', () => {
  const html = sanitizeHtml(
    '<h1 class="title" id="t">Hi</h1><style>p { color: red }</style><a href="https://example.com">link</a><td colspan="2">c</td>',
  );
  assert.match(html, /<h1 class="title" id="t">Hi<\/h1>/);
  assert.match(html, /<style>p \{ color: red \}<\/style>/);
  assert.match(html, /<a href="https:\/\/example.com">link<\/a>/);
  assert.match(html, /<td colspan="2">c<\/td>/);
});

test('sanitizeHtml removes the document wrapper, meta refresh and base href', () => {
  const html = sanitizeHtml('<html><head><meta http-equiv="refresh" content="0;url=x"><base href="/"></head><body><p>body</p></body></html>');
  assert.match(html, /<p>body<\/p>/);
  assert.ok(!html.includes('refresh'));
  assert.ok(!html.includes('<base'));
  assert.ok(!html.includes('<body'));
});

test('sanitizeHtml keeps a lone angle bracket as text', () => {
  assert.match(sanitizeHtml('a < b'), /a &lt; b/);
});

test('htmlPreviewMarkup keeps the file markup and its styles inside the preview', () => {
  const markup = htmlPreviewMarkup(
    '<style>body{visibility:hidden}</style><h1>t</h1><script>alert(1)</script>',
  );
  assert.match(markup, /^<style>:host\{display:block/);
  assert.ok(markup.includes('<style>body{visibility:hidden}</style>'));
  assert.ok(markup.includes('<div class="html-preview">'));
  assert.ok(!markup.includes('<script'));
});
