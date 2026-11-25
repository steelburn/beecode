import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultPolicy } from '../../shared/defaults';
import type { ToolContext, ToolDefinition, ToolResult } from '../../shared/tools';
import { PolicyEngine } from '../policy';
import { SlateStore } from '../slates';
import { slateTools } from './slates';

/**
 * The tool layer is what the model calls, so these tests are about the contract the
 * transcript card and the SLATE_TAB depend on: `meta.slate` exists, the document body stays
 * out of the payload, and a write is never gated behind `filesystem.writable`.
 */

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'beecode-slate-tool-'));
}

function harness(cwd: string, writable = true) {
  const policy = defaultPolicy();
  policy.filesystem.writable = writable;
  const tools = slateTools({
    store: new SlateStore(),
    policy: new PolicyEngine(policy, [cwd]),
  });
  const ctx: ToolContext = {
    sessionId: 'session-1',
    cwd,
    mode: 'act',
    workspaceRoots: [cwd],
    signal: new AbortController().signal,
    depth: 0,
  };
  const tool = (name: string): ToolDefinition => {
    const found = tools.find((candidate) => candidate.name === name);
    assert.ok(found, `${name} is registered`);
    return found;
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    tool(name).handler(args, ctx);
  return { call, tool, tools };
}

test('create_slate reports the slate in meta so the transcript can draw a card', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    const result = await call('create_slate', {
      title: 'Sales Q3',
      kind: 'markdown',
      content: '# Sales Q3\n\nNumbers.\n',
    });

    assert.equal(result.failed, undefined);
    assert.deepEqual(result.meta?.slate, {
      id: 'sales-q3',
      title: 'Sales Q3',
      kind: 'markdown',
      version: 1,
      versions: 1,
    });
    // The body never travels with the result: the tab reads the version file instead.
    assert.equal(result.content.includes('Numbers.'), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('update_slate appends a version and leaves the earlier file byte-identical', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    await call('create_slate', { title: 'Sales Q3', kind: 'markdown', content: 'one\n' });
    const result = await call('update_slate', { id: 'sales-q3', content: 'two\n' });

    assert.deepEqual(result.meta?.slate, {
      id: 'sales-q3',
      title: 'Sales Q3',
      kind: 'markdown',
      version: 2,
      versions: 2,
    });
    const dir = join(cwd, '.beecode', 'slates', 'session-1', 'sales-q3');
    assert.deepEqual((await readdir(dir)).sort(), ['001-sales-q3.md', '002-sales-q3.md', 'meta.json']);
    assert.equal(await readFile(join(dir, '001-sales-q3.md'), 'utf8'), 'one\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a slate write stays reachable when the policy denies file writes', async () => {
  // The store is the one write path the policy does not own: a slate is written under the
  // workspace by the store, not through a filesystem tool, so `writable: false` cannot
  // stop it. The engine is asserted to deny a plain write in the same workspace, so this
  // stays a statement about the exemption rather than about a permissive policy.
  const cwd = await workspace();
  try {
    const policy = defaultPolicy();
    policy.filesystem.writable = false;
    const engine = new PolicyEngine(policy, [cwd]);
    assert.equal(engine.evaluateFile(join(cwd, 'notes.md'), true).allowed, false);

    const { call } = harness(cwd);
    const result = await call('create_slate', {
      title: 'Read-only project notes',
      kind: 'markdown',
      content: '# notes\n',
    });
    assert.equal(result.failed, undefined, 'a read-only workspace still gets a slate');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an id that tries to escape the session folder is refused, not normalised', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    for (const id of ['../escape', '..\\escape', '/abs/escape']) {
      const result = await call('update_slate', { id, content: 'x\n' });
      assert.equal(result.failed, true, `${id} is refused`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('updating a slate that does not exist fails in-band with its id', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    const result = await call('update_slate', { id: 'never-written', content: 'x\n' });
    assert.equal(result.failed, true);
    assert.match(result.content, /never-written/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('one approval card per slate: create asks, update does not, both stay mutating', async () => {
  const cwd = await workspace();
  try {
    const { tool } = harness(cwd);
    const ctx: ToolContext = {
      sessionId: 'session-1',
      cwd,
      mode: 'ask',
      workspaceRoots: [cwd],
      signal: new AbortController().signal,
      depth: 0,
    };
    const create = tool('create_slate');
    const update = tool('update_slate');

    // Plan mode still refuses both: the approval rule never widens what may mutate.
    assert.equal(create.mutating, true);
    assert.equal(update.mutating, true);

    const createPreview = await create.preview?.(
      { title: 'Sales Q3', kind: 'markdown', content: 'x\n' },
      ctx,
    );
    const updatePreview = await update.preview?.({ id: 'sales-q3', content: 'y\n' }, ctx);
    assert.equal(createPreview?.requiresApproval, true);
    assert.equal(updatePreview?.requiresApproval, false);
    assert.match(createPreview?.summary ?? '', /Sales Q3/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('promote_slate writes the current version into the workspace and keeps the slate', async () => {
  const cwd = await workspace();
  try {
    const { call, tool } = harness(cwd);
    await call('create_slate', { title: 'Sales Q3', kind: 'markdown', content: 'one\n' });
    await call('update_slate', { id: 'sales-q3', content: 'two\n' });

    const result = await call('promote_slate', { id: 'sales-q3', path: 'docs/sales-q3.md' });
    assert.equal(result.failed, undefined, result.content);
    assert.equal(await readFile(join(cwd, 'docs', 'sales-q3.md'), 'utf8'), 'two\n');

    // Pinning an earlier version promotes that one instead.
    await call('promote_slate', { id: 'sales-q3', path: 'docs/sales-q3-v1.md', version: 1 });
    assert.equal(await readFile(join(cwd, 'docs', 'sales-q3-v1.md'), 'utf8'), 'one\n');

    // The slate folder is untouched: promotion copies, it does not move.
    await access(join(cwd, '.beecode', 'slates', 'session-1', 'sales-q3', 'meta.json'));

    const ctx: ToolContext = {
      sessionId: 'session-1',
      cwd,
      mode: 'ask',
      workspaceRoots: [cwd],
      signal: new AbortController().signal,
      depth: 0,
    };
    const preview = await tool('promote_slate').preview?.(
      { id: 'sales-q3', path: 'docs/sales-q3.md' },
      ctx,
    );
    assert.equal(preview?.requiresApproval, true, 'the copy lands outside the slate folder');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('promote_slate refuses a target outside the workspace and obeys a read-only policy', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    await call('create_slate', { title: 'Sales Q3', kind: 'markdown', content: 'one\n' });

    const outside = await call('promote_slate', { id: 'sales-q3', path: '../escape.md' });
    assert.equal(outside.failed, true);
    assert.match(outside.content, /outside the workspace/);

    const readOnly = harness(cwd, false);
    const denied = await readOnly.call('promote_slate', { id: 'sales-q3', path: 'docs/x.md' });
    assert.equal(denied.failed, true, 'policy owns the real tree, unlike the slate folder');
    assert.match(denied.content, /policy denies/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('create_slate records the recipe and refresh_slate hands it back re-authorised', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    const created = await call('create_slate', {
      title: 'Sales Q3',
      kind: 'markdown',
      content: '# Sales Q3\n',
      recipe: [{ tool: 'fs_read', args: { path: 'data/sales.csv' } }],
    });
    assert.equal(created.failed, undefined);

    const dir = join(cwd, '.beecode', 'slates', 'session-1', 'sales-q3');
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as {
      versions: { recipe?: unknown }[];
    };
    assert.deepEqual(meta.versions[0].recipe, [
      { tool: 'fs_read', args: { path: 'data/sales.csv' } },
    ]);

    const refreshed = await call('refresh_slate', { id: 'sales-q3' });
    assert.equal(refreshed.failed, undefined);
    const payload = JSON.parse(refreshed.content) as {
      action: string;
      version: number;
      steps: { tool: string; kind: string; target?: string; allowed: boolean }[];
      recipe: unknown[];
    };
    assert.equal(payload.action, 'refresh');
    assert.equal(payload.version, 1);
    assert.deepEqual(payload.steps, [
      { tool: 'fs_read', kind: 'read', target: 'data/sales.csv', allowed: true },
    ]);
    // The recipe comes back with the plan so the rebuilt version names the same sources.
    assert.deepEqual(payload.recipe, [{ tool: 'fs_read', args: { path: 'data/sales.csv' } }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('refresh_slate refuses a source the policy now denies', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    await call('create_slate', {
      title: 'Sales Q3',
      kind: 'markdown',
      content: '# Sales Q3\n',
      recipe: [{ tool: 'fs_read', args: { path: '../../outside.csv' } }],
    });

    // A recorded step is untrusted at replay time: the path was allowed when the recipe was
    // written, and the answer has to come from the policy again, not from the record.
    const refreshed = await call('refresh_slate', { id: 'sales-q3' });
    assert.match(String(refreshed.content), /which the policy now denies/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('refresh_slate refuses a network source outside the slate allowlist', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    await call('create_slate', {
      title: 'Dashboard',
      kind: 'html',
      content: '<html><body>hi</body></html>\n',
      origins: ['https://api.example.com'],
      recipe: [{ tool: 'fetch', args: { url: 'https://tracker.evil.com/collect' } }],
    });

    const refreshed = await call('refresh_slate', { id: 'dashboard' });
    assert.match(String(refreshed.content), /not on this slate's allowlist/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('refresh_slate says so when a version records no recipe', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    await call('create_slate', { title: 'Sales Q3', kind: 'markdown', content: '# Sales Q3\n' });

    const refreshed = await call('refresh_slate', { id: 'sales-q3' });
    assert.match(String(refreshed.content), /records no recipe/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('create_slate can declare a form, and slate_submissions reads the sink', async () => {
  const cwd = await workspace();
  try {
    const { call, tool } = harness(cwd);
    const submit = { fields: [{ name: 'hours', type: 'number', required: true }] };
    const created = await call('create_slate', {
      title: 'Hours',
      kind: 'html',
      content: '<form id="f"></form>',
      submit,
    });
    assert.equal(created.failed, undefined);
    assert.equal((created.meta?.slate as { id?: string } | undefined)?.id, 'hours');

    const readTool = tool('slate_submissions');
    assert.equal(readTool?.mutating, false);

    const empty = await call('slate_submissions', { id: 'hours' });
    assert.deepEqual(JSON.parse(String(empty.content)).submissions, []);

    const store = new SlateStore();
    await store.submit({
      cwd,
      sessionId: 'session-1',
      id: 'hours',
      version: 1,
      submissionId: 'k1',
      payload: { fields: { hours: 6 } },
    });

    const posted = await call('slate_submissions', { id: 'hours' });
    const payload = JSON.parse(String(posted.content));
    assert.equal(payload.submissions.length, 1);
    assert.deepEqual(payload.submissions[0].fields, { hours: 6 });
    assert.equal(payload.submissions[0].version, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a markdown slate refuses to declare a form', async () => {
  const cwd = await workspace();
  try {
    const { call } = harness(cwd);
    const result = await call('create_slate', {
      title: 'Notes',
      kind: 'markdown',
      content: '# notes',
      submit: { fields: [{ name: 'hours' }] },
    });
    assert.equal(result.failed, true);
    assert.match(String(result.content), /cannot take a form/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
