import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolContext, ToolDefinition } from '../../shared/tools';
import { ToolRegistry } from './registry';

/** Minimal tool double: the switches are name-based, so the handler only counts calls. */
function tool(name: string, call: () => void = () => {}): ToolDefinition {
  return {
    name,
    description: `${name} does something`,
    mutating: false,
    group: 'control',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      call();
      return { content: JSON.stringify({ ok: name }) };
    },
  };
}

const ctx: ToolContext = {
  sessionId: 's_test',
  cwd: '/work',
  mode: 'act',
  workspaceRoots: ['/work'],
  signal: new AbortController().signal,
  depth: 0,
};

test('a switched-off tool leaves the schema but stays in the catalogue', () => {
  const registry = new ToolRegistry()
    .register(tool('memory_search'), tool('fs_read'))
    .setDisabled(['fs_read']);

  assert.deepEqual(
    registry.schemas().map((schema) => schema.name),
    ['memory_search'],
  );
  assert.deepEqual(registry.enabledNames(), ['memory_search']);
  // The catalogue keeps the name: Settings → Tools lists it so it can be switched back on.
  assert.deepEqual(registry.names(), ['memory_search', 'fs_read']);
  assert.deepEqual(
    registry.info().map((info) => [info.name, info.enabled]),
    [
      ['memory_search', true],
      ['fs_read', false],
    ],
  );
});

test('calling a switched-off tool is refused in-band and never reaches the handler', async () => {
  let calls = 0;
  const registry = new ToolRegistry()
    .register(tool('fs_write', () => (calls += 1)))
    .setDisabled(['fs_write']);

  const result = await registry.execute('fs_write', {}, ctx);

  assert.equal(result.failed, true);
  assert.equal(calls, 0);
  const payload = JSON.parse(result.content) as { error: string; disabled: boolean };
  assert.match(payload.error, /switched off/);
  assert.equal(payload.disabled, true);
});

test('the unknown-tool error only advertises enabled tools', async () => {
  const registry = new ToolRegistry()
    .register(tool('fs_read'), tool('shell_run'))
    .setDisabled(['shell_run']);

  const result = await registry.execute('nope', {}, ctx);
  const payload = JSON.parse(result.content) as { available: string[] };

  assert.deepEqual(payload.available, ['fs_read']);
});

test('a subset (read-only subagents) inherits the switches', async () => {
  let calls = 0;
  const full = new ToolRegistry()
    .register(tool('fs_read'), tool('shell_run', () => (calls += 1)))
    .setDisabled(['shell_run']);
  const subset = full.subset((def) => def.name === 'fs_read' || def.name === 'shell_run');

  assert.deepEqual(
    subset.schemas().map((schema) => schema.name),
    ['fs_read'],
  );
  const result = await subset.execute('shell_run', {}, ctx);
  assert.equal(result.failed, true);
  assert.equal(calls, 0);
});

test('re-enabling a tool restores it without re-registering', async () => {
  const registry = new ToolRegistry().register(tool('fs_read')).setDisabled(['fs_read']);
  assert.deepEqual(registry.schemas(), []);

  registry.setDisabled([]);

  assert.deepEqual(
    registry.schemas().map((schema) => schema.name),
    ['fs_read'],
  );
  const result = await registry.execute('fs_read', {}, ctx);
  assert.equal(result.failed, undefined);
});
