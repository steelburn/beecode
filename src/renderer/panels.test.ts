import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInfo } from '../shared/protocol';
import { usableAgents } from './panels';

/**
 * The Subagents tab lists what the loop can delegate to *right now*: an agent has to be
 * installed (on PATH) and enabled in Settings. `available` is the service's verdict on
 * both, so the panel filters on it instead of re-deriving the rule from `detail` text —
 * that is how unticked-but-installed and ticked-but-missing agents both stayed listed.
 */
function agent(id: string, available: boolean, detail: string): AgentInfo {
  return { id, label: id, kind: 'cli', available, detail } as AgentInfo;
}

test('usableAgents keeps installed + enabled agents and drops everything else', () => {
  const agents = [
    agent('opencode', true, '1.19.0'),
    agent('claude', false, 'claude not found on PATH'),
    agent('codex', false, 'found on PATH — enable it to delegate'),
  ];
  assert.deepEqual(
    usableAgents(agents).map((entry) => entry.id),
    ['opencode'],
  );
});

test('usableAgents keeps the internal runner, which is available without a probe', () => {
  const agents = [
    { id: 'internal', label: 'beeCode internal', kind: 'internal', available: true } as AgentInfo,
    agent('opencode', false, 'found on PATH — enable it to delegate'),
  ];
  assert.deepEqual(
    usableAgents(agents).map((entry) => entry.id),
    ['internal'],
  );
  assert.deepEqual(usableAgents([]), []);
});
