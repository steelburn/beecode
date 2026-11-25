import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_MODES, MODE_LABELS, describeMode } from './modes';

test('every mode has a plain-language label and a hint', () => {
  for (const mode of AGENT_MODES) {
    const entry = MODE_LABELS[mode];
    assert.ok(entry, `missing label for ${mode}`);
    assert.ok(entry.label.length > 0);
    assert.ok(entry.hint.length > 0);
    // The raw id must not leak into what the user reads.
    assert.notEqual(entry.label.toLowerCase(), mode);
  }
});

test('the four labels are distinct so the selector is unambiguous', () => {
  const labels = AGENT_MODES.map((mode) => MODE_LABELS[mode].label);
  assert.equal(new Set(labels).size, labels.length);
});

test('describeMode pairs the label with the hint', () => {
  assert.equal(describeMode('ask'), `${MODE_LABELS.ask.label} — ${MODE_LABELS.ask.hint}`);
});
