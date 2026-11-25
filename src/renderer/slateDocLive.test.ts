import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlateSummary } from '../shared/protocol';
import {
  parseSlateOrigins,
  slateDocHoldsLive,
  slateDocLiveTarget,
  slateLiveBoundsOf,
} from './slateDocLive';

/**
 * The document tab may only offer the live page where running it is possible and permitted:
 * an html slate version, in Preview, of the session whose slates the renderer holds. These
 * tests pin that down, because the alternative is a Run button whose only outcome is a
 * refusal from the host.
 */

const session = 'session-1';
const path = `/work/demo/.beecode/slates/${session}/slides/003-slides.html`;

function summary(overrides: Partial<SlateSummary> = {}): SlateSummary {
  return {
    id: 'slides',
    title: 'Slides',
    kind: 'html',
    current: 3,
    versions: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('an html slate shown as Preview is a live target', () => {
  assert.deepEqual(
    slateDocLiveTarget(path, 'rendered', {
      sessionId: session,
      slates: [summary({ live: true, origins: ['https://api.example.com'] })],
    }),
    {
      sessionId: session,
      id: 'slides',
      version: 3,
      allowed: true,
      origins: ['https://api.example.com'],
    },
  );
});

test('a slate nobody agreed to is still a target — the tab has to be able to ask', () => {
  const target = slateDocLiveTarget(path, 'rendered', { sessionId: session, slates: [summary()] });
  assert.equal(target?.allowed, false);
  assert.deepEqual(target?.origins, []);
});

test('the code view has no page to cover, so it runs nothing', () => {
  assert.equal(
    slateDocLiveTarget(path, 'source', { sessionId: session, slates: [summary({ live: true })] }),
    undefined,
  );
});

test('only markup can run: a markdown or csv version is not a live target', () => {
  const markdown = `/work/demo/.beecode/slates/${session}/slides/003-slides.md`;
  assert.equal(
    slateDocLiveTarget(markdown, 'rendered', { sessionId: session, slates: [summary({ live: true })] }),
    undefined,
  );
});

test('a tab whose session is not the one on screen runs nothing', () => {
  assert.equal(
    slateDocLiveTarget(path, 'rendered', { sessionId: 'session-2', slates: [summary({ live: true })] }),
    undefined,
  );
  assert.equal(
    slateDocLiveTarget(path, 'rendered', { sessionId: undefined, slates: [summary({ live: true })] }),
    undefined,
  );
});

test('without a summary the consent is unknown, so there is nothing to offer', () => {
  assert.equal(slateDocLiveTarget(path, 'rendered', { sessionId: session, slates: [] }), undefined);
});

test('an ordinary file in the workspace is not a live target', () => {
  assert.equal(
    slateDocLiveTarget('/work/demo/slides.html', 'rendered', {
      sessionId: session,
      slates: [summary({ live: true })],
    }),
    undefined,
  );
});

test('the live page belongs to a tab only for the same session, slate and version', () => {
  const target = slateDocLiveTarget(path, 'rendered', { sessionId: session, slates: [summary()] });
  const live = { visible: true, sessionId: session, slateId: 'slides', version: 3 };
  assert.equal(slateDocHoldsLive(live, target), true);
  // A new version is a different page: the tab of v2 must not move or keep the v3 page.
  assert.equal(slateDocHoldsLive({ ...live, version: 4 }, target), false);
  assert.equal(slateDocHoldsLive({ ...live, slateId: 'other' }, target), false);
  assert.equal(slateDocHoldsLive({ ...live, sessionId: 'session-2' }, target), false);
  assert.equal(slateDocHoldsLive({ ...live, visible: false }, target), false);
  assert.equal(slateDocHoldsLive(undefined, target), false);
  assert.equal(slateDocHoldsLive(live, undefined), false);
});

test('a DOM rect becomes the window rectangle the native view is placed on', () => {
  assert.deepEqual(slateLiveBoundsOf({ left: 10.4, top: 20.6, width: 300.5, height: 199.2 }), {
    x: 10,
    y: 21,
    width: 301,
    height: 199,
  });
});

test('origins are typed one per line or comma-separated', () => {
  assert.deepEqual(
    parseSlateOrigins(' https://a.example.com\nhttps://b.example.com, https://c.example.com '),
    ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'],
  );
  assert.deepEqual(parseSlateOrigins('   '), []);
});
