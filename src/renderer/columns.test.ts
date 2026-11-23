import assert from 'node:assert/strict';
import test from 'node:test';
import { clampWidth, PANEL_LIMITS, RAIL_LIMITS } from './columns';

test('clampWidth accepts a width the column limits allow', () => {
  assert.equal(clampWidth(300, RAIL_LIMITS, 360, 1280), 300);
  assert.equal(clampWidth(420, PANEL_LIMITS, 240, 1440), 420);
});

test('clampWidth pins a width to the column limits', () => {
  assert.equal(clampWidth(100, RAIL_LIMITS, 0, 1280), RAIL_LIMITS.min);
  assert.equal(clampWidth(900, RAIL_LIMITS, 0, 1280), RAIL_LIMITS.max);
  assert.equal(clampWidth(120, PANEL_LIMITS, 0, 1920), PANEL_LIMITS.min);
});

test('clampWidth leaves the conversation column its floor', () => {
  // 1000px window, 240px rail: the panel may grow to 1000 - 240 - 360 = 400px, not further.
  assert.equal(clampWidth(700, PANEL_LIMITS, 240, 1000), 400);
  // The rail is squeezed by the same rule from the other side.
  assert.equal(clampWidth(460, RAIL_LIMITS, 500, 1100), 240);
});

test('clampWidth never returns less than the minimum, even in a tiny window', () => {
  assert.equal(clampWidth(300, RAIL_LIMITS, 600, 700), RAIL_LIMITS.min);
  assert.equal(clampWidth(500, PANEL_LIMITS, 240, 500), PANEL_LIMITS.min);
});

test('clampWidth rounds a fractional drag to whole pixels', () => {
  assert.equal(clampWidth(300.6, RAIL_LIMITS, 0, 1280), 301);
  assert.equal(clampWidth(300.2, RAIL_LIMITS, 0, 1280), 300);
});

test('clampWidth falls back to the minimum for a non-numeric width', () => {
  assert.equal(clampWidth(Number.NaN, RAIL_LIMITS, 0, 1280), RAIL_LIMITS.min);
});
