import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFSCREEN_SIZE, SURFACE_ACTIONS, surfaceTarget } from './surface';

const facts = (over: Partial<Parameters<typeof surfaceTarget>[0]> = {}) => ({
  attachedToWindow: true,
  bounds: { width: 800, height: 500 },
  windowPainting: true,
  ...over,
});

test('a visible, sized, attached page is driven where it is', () => {
  assert.equal(surfaceTarget(facts()), 'live');
});

test('a collapsed dock parks the page', () => {
  assert.equal(surfaceTarget(facts({ bounds: { width: 0, height: 0 } })), 'offscreen');
  assert.equal(surfaceTarget(facts({ bounds: { width: 0, height: 500 } })), 'offscreen');
});

test('a background tab parks the page even though the window paints', () => {
  assert.equal(surfaceTarget(facts({ attachedToWindow: false })), 'offscreen');
});

test('a minimized app or minimized window parks the page', () => {
  assert.equal(surfaceTarget(facts({ windowPainting: false })), 'offscreen');
});

test('mouse, key and capture actions are the surface-bound ones', () => {
  for (const action of ['click', 'type', 'key', 'scroll', 'hover', 'screenshot'] as const) {
    assert.ok(SURFACE_ACTIONS.has(action), `${action} needs a surface`);
  }
  for (const action of ['open', 'navigate', 'snapshot', 'tabs', 'close', 'back', 'reload'] as const) {
    assert.equal(SURFACE_ACTIONS.has(action), false, `${action} runs without one`);
  }
});

test('the offscreen viewport is big enough for a real page', () => {
  assert.ok(OFFSCREEN_SIZE.width >= 1024);
  assert.ok(OFFSCREEN_SIZE.height >= 700);
});
