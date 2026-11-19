import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_STEP_LIMIT, nextStepLimit, stepLimitNote } from './AgentLoop';

test('nextStepLimit doubles the limit so a long task can finish in one go', () => {
  assert.equal(nextStepLimit(24), 48);
  assert.equal(nextStepLimit(1), 2);
  assert.equal(nextStepLimit(7), 14);
});

test('nextStepLimit stops at the cap so a runaway task cannot uncap itself', () => {
  assert.equal(nextStepLimit(300), MAX_STEP_LIMIT);
  assert.equal(nextStepLimit(MAX_STEP_LIMIT), MAX_STEP_LIMIT);
  assert.equal(nextStepLimit(10_000), 10_000);
});

test('nextStepLimit stays a positive integer for junk input', () => {
  assert.equal(nextStepLimit(0), 2);
  assert.equal(nextStepLimit(-5), 2);
  assert.equal(nextStepLimit(2.7), 4);
  assert.equal(nextStepLimit(Number.NaN), 2);
  assert.equal(nextStepLimit(Number.POSITIVE_INFINITY), 2);
});

test('stepLimitNote offers the bump button with the numbers it would write', () => {
  const note = stepLimitNote(24);
  assert.equal(note.role, 'system');
  assert.match(note.text, /Stopped after 24 steps without finishing/);
  assert.deepEqual(note.actions, [{ kind: 'raise-max-steps', current: 24, next: 48 }]);
});

test('stepLimitNote drops the button once the cap is reached', () => {
  const note = stepLimitNote(MAX_STEP_LIMIT);
  assert.equal(note.actions, undefined);
  assert.match(note.text, /raise agent\.maxSteps in settings/);
});
