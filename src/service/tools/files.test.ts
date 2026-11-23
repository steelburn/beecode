import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { defaultPolicy } from '../../shared/defaults';
import type { ToolContext, ToolDefinition, ToolResult } from '../../shared/tools';
import { AuditLog } from '../audit';
import { PolicyEngine } from '../policy';
import { fileTools } from './files';

interface Harness {
  root: string;
  workspace: string;
  ctx: ToolContext;
  tools: Map<string, ToolDefinition>;
}

/**
 * Workspace-scoped engine plus an audit log in a throwaway directory. The cleanup is
 * registered as a test hook so a failing assertion is never masked by it — and the audit
 * log is flushed first, because a pending append would recreate the file mid-delete.
 */
async function harness(t: TestContext): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'beecode-fs-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const policy = new PolicyEngine(defaultPolicy(), [workspace]);
  const audit = new AuditLog(join(root, 'audit', 'audit.jsonl'));
  t.after(async () => {
    await audit.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const ctx: ToolContext = {
    sessionId: 's1',
    cwd: workspace,
    mode: 'act',
    workspaceRoots: [workspace],
    signal: new AbortController().signal,
    depth: 0,
  };
  return {
    root,
    workspace,
    ctx,
    tools: new Map(fileTools({ policy, audit }).map((tool) => [tool.name, tool])),
  };
}

async function call(
  h: Harness,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: ToolResult; data: Record<string, unknown> }> {
  const tool = h.tools.get(name);
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, h.ctx);
  return { result, data: JSON.parse(result.content) as Record<string, unknown> };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('the three filesystem tools are workspace-scoped and mutating', async (t) => {
  const h = await harness(t);
  for (const name of ['fs_mkdir', 'fs_delete', 'fs_move']) {
    const tool = h.tools.get(name);
    assert.ok(tool, `${name} is registered`);
    assert.equal(tool.mutating, true);
    assert.equal(tool.group, 'files');
    assert.equal((await tool.preview?.({}, h.ctx))?.requiresApproval, true);
  }
});

test('fs_mkdir creates parent directories and reports whether it did anything', async (t) => {
  const h = await harness(t);
  const first = await call(h, 'fs_mkdir', { path: 'assets/images/icons' });
  assert.equal(first.result.failed, undefined);
  assert.equal(first.data.created, true);
  assert.equal(first.data.path, join(h.workspace, 'assets', 'images', 'icons'));
  assert.equal(await pathExists(join(h.workspace, 'assets', 'images', 'icons')), true);

  const again = await call(h, 'fs_mkdir', { path: 'assets/images/icons' });
  assert.equal(again.data.created, false);
});

test('fs_mkdir refuses a path outside the workspace', async (t) => {
  const h = await harness(t);
  const { result } = await call(h, 'fs_mkdir', { path: '../escape' });
  assert.equal(result.failed, true);
  assert.match(result.content, /outside the workspace/);
  assert.equal(await pathExists(join(h.root, 'escape')), false);
});

test('fs_delete removes a file', async (t) => {
  const h = await harness(t);
  const file = join(h.workspace, 'notes.txt');
  await writeFile(file, 'hello');
  const { result, data } = await call(h, 'fs_delete', { path: 'notes.txt' });
  assert.equal(result.failed, undefined);
  assert.equal(data.kind, 'file');
  assert.equal(await pathExists(file), false);
});

test('fs_delete needs recursive: true for a directory', async (t) => {
  const h = await harness(t);
  await call(h, 'fs_mkdir', { path: 'nested' });
  await writeFile(join(h.workspace, 'nested', 'b.txt'), 'b');

  const refused = await call(h, 'fs_delete', { path: 'nested' });
  assert.equal(refused.result.failed, true);
  assert.match(refused.result.content, /pass recursive: true/);

  const deleted = await call(h, 'fs_delete', { path: 'nested', recursive: true });
  assert.equal(deleted.result.failed, undefined);
  assert.equal(deleted.data.kind, 'directory');
  assert.equal(await pathExists(join(h.workspace, 'nested')), false);
});

test('fs_delete refuses the workspace root', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.workspace, 'a.txt'), 'a');
  const { result } = await call(h, 'fs_delete', { path: '.', recursive: true });
  assert.equal(result.failed, true);
  assert.match(result.content, /workspace root/);
  assert.equal(await pathExists(join(h.workspace, 'a.txt')), true);
});

test('fs_move renames a file and creates missing destination parents', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.workspace, 'draft.md'), '# draft');

  const { result, data } = await call(h, 'fs_move', {
    from: 'draft.md',
    to: 'docs/notes/final.md',
  });
  assert.equal(result.failed, undefined);
  assert.equal(data.to, join(h.workspace, 'docs', 'notes', 'final.md'));
  assert.equal(await pathExists(join(h.workspace, 'draft.md')), false);
  assert.equal(await readFile(join(h.workspace, 'docs', 'notes', 'final.md'), 'utf8'), '# draft');
});

test('fs_move refuses an existing destination and a missing source', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.workspace, 'one.txt'), '1');
  await writeFile(join(h.workspace, 'two.txt'), '2');

  const taken = await call(h, 'fs_move', { from: 'one.txt', to: 'two.txt' });
  assert.equal(taken.result.failed, true);
  assert.match(taken.result.content, /already exists/);

  const missing = await call(h, 'fs_move', { from: 'ghost.txt', to: 'elsewhere.txt' });
  assert.equal(missing.result.failed, true);
  assert.match(missing.result.content, /does not exist/);
});

test('fs_move refuses a destination outside the workspace', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.workspace, 'keep.txt'), 'k');
  const { result, data } = await call(h, 'fs_move', {
    from: 'keep.txt',
    to: '../outside.txt',
  });
  assert.equal(result.failed, true);
  assert.equal(data.denied, true);
  assert.match(result.content, /outside the workspace/);
  assert.equal(await pathExists(join(h.workspace, 'keep.txt')), true);
});
