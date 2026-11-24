import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SLATE_LIVE_LIMITS,
  canSlateGoLive,
  isSlateOriginAllowed,
  normaliseSlateOrigin,
  normaliseSlateOrigins,
  parseSlateLiveUrl,
  slateLiveCsp,
  slateLiveUrl,
} from './slateSandbox';

test('an origin keeps scheme, host and port and drops a trailing slash', () => {
  assert.equal(normaliseSlateOrigin('https://api.example.com'), 'https://api.example.com');
  assert.equal(normaliseSlateOrigin('  https://api.example.com/  '), 'https://api.example.com');
  assert.equal(normaliseSlateOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normaliseSlateOrigin('HTTPS://API.Example.COM'), 'https://api.example.com');
});

test('a wildcard is refused by name, not silently tightened', () => {
  assert.throws(() => normaliseSlateOrigin('*'), /wildcard/);
  assert.throws(() => normaliseSlateOrigin('https://*.example.com'), /wildcard/);
});

test('only http(s) origins are accepted', () => {
  assert.throws(() => normaliseSlateOrigin('file:///c:/secrets'), /not http\(s\)/);
  assert.throws(() => normaliseSlateOrigin('ws://example.com'), /not http\(s\)/);
  assert.throws(() => normaliseSlateOrigin('javascript:alert(1)'), /not http\(s\)/);
});

test('a path, query or hash is more than an origin and is refused', () => {
  assert.throws(() => normaliseSlateOrigin('https://api.example.com/v1/data'), /more than an origin/);
  assert.throws(() => normaliseSlateOrigin('https://api.example.com/?key=1'), /more than an origin/);
});

test('credentials in the URL are refused rather than stored', () => {
  assert.throws(() => normaliseSlateOrigin('https://user:pass@api.example.com'), /credentials/);
});

test('a bare host or garbage is refused with a fix', () => {
  assert.throws(() => normaliseSlateOrigin('api.example.com'), /name an origin/);
  assert.throws(() => normaliseSlateOrigin(''), /cannot be empty/);
});

test('the allowlist deduplicates, keeps order and allows an empty list', () => {
  assert.deepEqual(normaliseSlateOrigins(undefined), []);
  assert.deepEqual(
    normaliseSlateOrigins(['https://b.example.com', 'https://a.example.com/', 'https://b.example.com']),
    ['https://b.example.com', 'https://a.example.com'],
  );
});

test('the allowlist is capped so the approval card stays readable', () => {
  const tooMany = Array.from({ length: SLATE_LIVE_LIMITS.origins + 1 }, (_, i) => `https://h${i}.example.com`);
  assert.throws(() => normaliseSlateOrigins(tooMany), /at most 8 origins/);
  assert.equal(normaliseSlateOrigins(tooMany.slice(0, SLATE_LIVE_LIMITS.origins)).length, 8);
});

test('only an html slate can go live', () => {
  assert.equal(canSlateGoLive('html'), true);
  assert.equal(canSlateGoLive('markdown'), false);
  assert.equal(canSlateGoLive('csv'), false);
});

test('the CSP names the allowlist and never a wildcard', () => {
  const csp = slateLiveCsp(['https://api.example.com', 'http://localhost:3000']);
  assert.match(csp, /connect-src https:\/\/api\.example\.com http:\/\/localhost:3000/);
  assert.match(csp, /default-src 'none'/);
  assert.equal(csp.includes('*'), false);
});

test('an empty allowlist closes the network completely', () => {
  assert.match(slateLiveCsp([]), /connect-src 'none'/);
});

test('a live URL round-trips through the parser', () => {
  const url = slateLiveUrl('sess-1', 'sales-q3', 3);
  assert.equal(url, 'slate://live/sess-1/sales-q3/v3');
  assert.deepEqual(parseSlateLiveUrl(url), { sessionId: 'sess-1', id: 'sales-q3', version: 3 });
});

test('the parser refuses anything that is not a live slate URL', () => {
  assert.equal(parseSlateLiveUrl('https://example.com'), undefined);
  assert.equal(parseSlateLiveUrl('slate://live/sess/v1'), undefined);
  assert.equal(parseSlateLiveUrl('slate://live/sess/id/v0'), undefined);
  assert.equal(parseSlateLiveUrl('slate://live/sess/id/id.html'), undefined);
  assert.equal(parseSlateLiveUrl('slate://other/sess/id/v1'), undefined);
  assert.equal(parseSlateLiveUrl('not a url'), undefined);
});

test('origin matching is exact on origin, not on prefix', () => {
  const origins = ['https://api.example.com'];
  assert.equal(isSlateOriginAllowed('https://api.example.com/v1/x', origins), true);
  assert.equal(isSlateOriginAllowed('https://api.example.com.evil.com/', origins), false);
  assert.equal(isSlateOriginAllowed('http://api.example.com/', origins), false);
  assert.equal(isSlateOriginAllowed('nonsense', origins), false);
  assert.equal(isSlateOriginAllowed('https://api.example.com/', []), false);
});
