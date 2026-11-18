import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairToolHistory } from './history';
import type { LlmMessage } from './types';

const user = (content: string): LlmMessage => ({ role: 'user', content });
const tool = (id: string): LlmMessage => ({ role: 'tool', content: `result ${id}`, toolCallId: id, toolName: 'desktop_screenshot' });
const assistantCalls = (...ids: string[]): LlmMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: ids.map((id) => ({ id, name: 'desktop_screenshot', args: {} })),
});
/** Invariant every strict OpenAI-compatible server enforces. */
function assertWellFormed(messages: LlmMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue;
    const expected = msg.toolCalls.map((c) => c.id).sort();
    const got: string[] = [];
    for (let j = i + 1; j < messages.length && messages[j]!.role === 'tool'; j += 1) got.push(messages[j]!.toolCallId ?? '');
    assert.deepEqual(got.slice().sort(), expected, `assistant tool_calls at ${i} not answered in place`);
  }
  for (const msg of messages) {
    if (msg.role === 'tool') assert.ok(msg.toolCallId, 'tool message without toolCallId');
  }
}

test('well-formed history is returned byte-for-byte', () => {
  const history = [user('go'), assistantCalls('a', 'b'), tool('a'), tool('b'), { role: 'assistant', content: 'done' } as LlmMessage];
  assert.deepEqual(repairToolHistory(history), history);
});

test('a history with no tool traffic is not copied', () => {
  const history = [user('hello'), { role: 'assistant', content: 'hi' } as LlmMessage];
  assert.equal(repairToolHistory(history), history);
});

test('an image message wedged before its tool result is moved after it', () => {
  const image: LlmMessage = { role: 'user', content: '(screenshot captured by desktop_screenshot)', images: [{ mime: 'image/png', data: 'AAA' }] };
  const repaired = repairToolHistory([user('screenshot please'), assistantCalls('call_1'), image, tool('call_1')]);

  assertWellFormed(repaired);
  assert.deepEqual(
    repaired.map((m) => m.role),
    ['user', 'assistant', 'tool', 'user'],
  );
  assert.equal(repaired[3], image, 'the image message survives untouched');
});

test('images wait for every reply of a multi-call turn', () => {
  const image: LlmMessage = { role: 'user', content: 'shot', images: [{ mime: 'image/png', data: 'AAA' }] };
  const repaired = repairToolHistory([assistantCalls('a', 'b'), image, tool('a'), tool('b')]);

  assertWellFormed(repaired);
  assert.deepEqual(
    repaired.map((m) => m.role),
    ['assistant', 'tool', 'tool', 'user'],
  );
});

test('unanswered tool calls are synthesized rather than left dangling', () => {
  const repaired = repairToolHistory([user('go'), assistantCalls('a', 'b'), tool('a')]);

  assertWellFormed(repaired);
  const filler = repaired[3]!;
  assert.equal(filler.role, 'tool');
  assert.equal(filler.toolCallId, 'b');
  assert.equal(filler.toolFailed, true);
  assert.match(filler.content, /no result recorded/);
});

test('orphan tool replies are dropped', () => {
  const repaired = repairToolHistory([tool('ghost'), user('hi'), { role: 'assistant', content: 'hello' } as LlmMessage]);

  assertWellFormed(repaired);
  assert.deepEqual(
    repaired.map((m) => m.role),
    ['user', 'assistant'],
  );
});

test('a later tool-calling turn is not borrowed from', () => {
  const repaired = repairToolHistory([assistantCalls('a'), tool('b'), assistantCalls('b'), tool('b')]);

  assertWellFormed(repaired);
  assert.equal(repaired[1]!.toolCallId, 'a', 'first turn gets a synthesized reply, not the next turn\'s');
  assert.equal(repaired[2]!.role, 'assistant');
});

test('repair is idempotent', () => {
  const once = repairToolHistory([assistantCalls('a', 'b'), { role: 'user', content: 'x' }, tool('a')]);
  assert.deepEqual(repairToolHistory(once), once);
});
