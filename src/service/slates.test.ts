import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertSlateId,
  MAX_SLATE_BYTES,
  MAX_SLATE_VERSIONS,
  MAX_SLATES_PER_SESSION,
  SlateStore,
  slateIdFrom,
} from './slates';

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'beecode-slate-'));
}

test('create writes 001-<id>.md plus meta.json; update appends and moves current', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const created = await store.create({
      cwd,
      sessionId: 'session-1',
      title: 'Sales Q3',
      kind: 'markdown',
      content: '# Sales Q3\n\nfirst draft\n',
    });

    assert.equal(created.id, 'sales-q3');
    assert.equal(created.current, 1);
    assert.equal(created.versions.length, 1);
    assert.equal(created.versions[0].file, '001-sales-q3.md');

    const dir = join(cwd, '.beecode', 'slates', 'session-1', 'sales-q3');
    const firstBytes = await readFile(join(dir, '001-sales-q3.md'), 'utf8');
    assert.equal(firstBytes, '# Sales Q3\n\nfirst draft\n');
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as { current: number };
    assert.equal(meta.current, 1);

    const updated = await store.update({
      cwd,
      sessionId: 'session-1',
      id: 'sales-q3',
      content: '# Sales Q3\n\nsecond draft\n',
    });

    assert.equal(updated.current, 2);
    assert.deepEqual(
      updated.versions.map((version) => version.file),
      ['001-sales-q3.md', '002-sales-q3.md'],
    );
    // The earlier version is append-only: it stays byte-identical.
    assert.equal(await readFile(join(dir, '001-sales-q3.md'), 'utf8'), firstBytes);
    assert.equal(await readFile(join(dir, '002-sales-q3.md'), 'utf8'), '# Sales Q3\n\nsecond draft\n');
    assert.deepEqual(
      (await readdir(dir)).sort(),
      ['001-sales-q3.md', '002-sales-q3.md', 'meta.json'],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('read defaults to the current version and can pin an older one', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-1' };
    await store.create({ ...location, title: 'Report', kind: 'markdown', content: 'v1' });
    await store.update({ ...location, id: 'report', content: 'v2' });

    const current = await store.read({ ...location, id: 'report' });
    assert.equal(current.content, 'v2');
    assert.equal(current.version.n, 2);
    assert.equal(current.meta.kind, 'markdown');

    const pinned = await store.read({ ...location, id: 'report', version: 1 });
    assert.equal(pinned.content, 'v1');
    await assert.rejects(() => store.read({ ...location, id: 'report', version: 9 }), /no version 9/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the kind is fixed at creation and drives the version extension', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-1' };
    await store.create({ ...location, title: 'Rows', kind: 'csv', content: 'a,b\n1,2\n' });
    const meta = await store.update({ ...location, id: 'rows', content: 'a,b\n3,4\n' });
    assert.equal(meta.kind, 'csv');
    assert.equal(meta.versions[1].file, '002-rows.csv');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('slate ids cannot escape the session folder', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-1' };
    await store.create({ ...location, title: 'Safe', kind: 'markdown', content: 'x' });

    for (const id of ['../evil', '..', '/etc/passwd', 'a/b', 'a\\b', '', 'bad id!']) {
      assert.throws(() => assertSlateId(id));
      await assert.rejects(() => store.read({ ...location, id }), /slate id|refusing/);
      await assert.rejects(() => store.update({ ...location, id, content: 'x' }), /slate id|refusing/);
    }
    assert.equal(assertSlateId('sales-q3'), 'sales-q3');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('list reports every slate of a session, oldest first, ignoring stray folders', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-1' };
    await store.create({ ...location, title: 'First', kind: 'markdown', content: 'a' });
    await store.create({ ...location, title: 'Second', kind: 'html', content: '<p>b</p>' });
    await writeFile(join(store.sessionRoot(location), 'not-a-slate.txt'), 'junk', 'utf8');

    const slates = await store.list(location);
    assert.deepEqual(
      slates.map((slate) => slate.id),
      ['first', 'second'],
    );
    // Nothing to list without a workspace or before the first slate exists.
    assert.deepEqual(await store.list({ cwd, sessionId: 'other-session' }), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('remove deletes every version and leaves the other slates alone', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-1' };
    await store.create({ ...location, title: 'Keep', kind: 'markdown', content: 'a' });
    await store.create({ ...location, title: 'Drop', kind: 'markdown', content: 'b' });
    await store.update({ ...location, id: 'drop', content: 'c' });

    const left = await store.remove({ ...location, id: 'drop' });
    assert.deepEqual(
      left.map((slate) => slate.id),
      ['keep'],
    );
    // The whole folder goes: no version file can outlive the meta.json that named it.
    assert.deepEqual(await readdir(store.sessionRoot(location)), ['keep']);
    await assert.rejects(() => store.meta({ ...location, id: 'drop' }), /drop/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('two slates may share a title; the second gets a suffixed id', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-1' };
    const first = await store.create({ ...location, title: 'Sales Q3', kind: 'markdown', content: 'a' });
    const second = await store.create({ ...location, title: 'Sales Q3', kind: 'markdown', content: 'b' });
    assert.equal(first.id, 'sales-q3');
    assert.equal(second.id, 'sales-q3-2');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('sessions are isolated and a missing workspace is refused', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    await store.create({ cwd, sessionId: 'session-1', title: 'Mine', kind: 'markdown', content: 'a' });
    await assert.rejects(
      () => store.read({ cwd, sessionId: 'session-2', id: 'mine' }),
      /unknown slate/,
    );
    await assert.rejects(
      () => store.create({ cwd: '', sessionId: 'session-1', title: 'X', kind: 'markdown', content: 'a' }),
      /no workspace folder/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('oversized content and unknown kinds are refused', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-1' };
    await assert.rejects(
      () =>
        store.create({
          ...location,
          title: 'Huge',
          kind: 'markdown',
          content: 'x'.repeat(MAX_SLATE_BYTES + 1),
        }),
      /limit is 2\.0 MB per version/,
    );
    await assert.rejects(
      () => store.create({ ...location, title: 'Weird', kind: 'pdf', content: 'x' }),
      /unsupported slate kind/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the version cap refuses the 51st version and keeps all 50 on disk', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-many-versions' };
    await store.create({ ...location, title: 'Log', kind: 'markdown', content: 'v1' });
    for (let n = 2; n <= MAX_SLATE_VERSIONS; n += 1) {
      await store.update({ ...location, id: 'log', content: `v${n}` });
    }

    // The refusal is a refusal, not a prune: nothing the user pinned may disappear.
    await assert.rejects(
      () => store.update({ ...location, id: 'log', content: 'one too many' }),
      /already has 50 versions — the limit is 50/,
    );
    const meta = await store.meta({ ...location, id: 'log' });
    assert.equal(meta.versions.length, MAX_SLATE_VERSIONS);
    assert.equal(meta.current, MAX_SLATE_VERSIONS);
    const files = (await readdir(join(cwd, '.beecode', 'slates', 'session-many-versions', 'log'))).filter(
      (name) => name.endsWith('.md'),
    );
    assert.equal(files.length, MAX_SLATE_VERSIONS);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('dropping a version moves the pointer and never renumbers the survivors', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-drop' };
    await store.create({ ...location, title: 'Doc', kind: 'markdown', content: 'v1' });
    await store.update({ ...location, id: 'doc', content: 'v2' });
    await store.update({ ...location, id: 'doc', content: 'v3' });

    // v3 was current, so the pointer falls back to the newest survivor.
    const meta = await store.removeVersion({ ...location, id: 'doc', version: 3 });
    assert.equal(meta.current, 2);
    assert.deepEqual(
      meta.versions.map((version) => version.n),
      [1, 2],
    );
    assert.deepEqual(await readdir(join(cwd, '.beecode', 'slates', 'session-drop', 'doc')), [
      '001-doc.md',
      '002-doc.md',
      'meta.json',
    ]);

    // The next append takes max+1, which reuses 3: the file it names is gone, so no tab or
    // card can be pointing at content that still exists under that number.
    const next = await store.update({ ...location, id: 'doc', content: 'v3 again' });
    assert.deepEqual(
      next.versions.map((version) => version.n),
      [1, 2, 3],
    );
    // Dropping from the middle never renumbers what survives.
    const trimmed = await store.removeVersion({ ...location, id: 'doc', version: 2 });
    assert.deepEqual(
      trimmed.versions.map((version) => version.n),
      [1, 3],
    );
    const after = await store.update({ ...location, id: 'doc', content: 'v4' });
    assert.deepEqual(
      after.versions.map((version) => version.n),
      [1, 3, 4],
    );

    await assert.rejects(
      () => store.removeVersion({ ...location, id: 'doc', version: 9 }),
      /has no version 9/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('dropping a version is the way back under the version cap', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-unblock' };
    await store.create({ ...location, title: 'Log', kind: 'markdown', content: 'v1' });
    for (let n = 2; n <= MAX_SLATE_VERSIONS; n += 1) {
      await store.update({ ...location, id: 'log', content: `v${n}` });
    }
    await assert.rejects(() => store.update({ ...location, id: 'log', content: 'blocked' }));

    await store.removeVersion({ ...location, id: 'log', version: 1 });
    const next = await store.update({ ...location, id: 'log', content: 'unblocked' });
    assert.equal(next.versions.length, MAX_SLATE_VERSIONS);
    assert.equal(next.current, MAX_SLATE_VERSIONS + 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the last version of a slate cannot be dropped — that is the slate', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-last' };
    await store.create({ ...location, title: 'Only', kind: 'markdown', content: 'v1' });
    await assert.rejects(
      () => store.removeVersion({ ...location, id: 'only', version: 1 }),
      /has one version left — remove the slate instead/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the session cap counts slates and refuses the next create', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const location = { cwd, sessionId: 'session-many-slates' };
    for (let n = 1; n <= MAX_SLATES_PER_SESSION; n += 1) {
      await store.create({ ...location, title: `Doc ${n}`, kind: 'markdown', content: 'x' });
    }

    await assert.rejects(
      () => store.create({ ...location, title: 'One too many', kind: 'markdown', content: 'x' }),
      /already holds 100 slates — the limit is 100/,
    );
    assert.equal((await store.list(location)).length, MAX_SLATES_PER_SESSION);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('slateIdFrom slugifies a title and falls back to "slate"', () => {
  assert.equal(slateIdFrom('Sales Q3 — EMEA'), 'sales-q3-emea');
  assert.equal(slateIdFrom('  ...  '), 'slate');
  assert.equal(slateIdFrom('Ärger über Öl'), 'arger-uber-ol');
});

test('create stores a validated allowlist and marks the slate live', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  const meta = await store.create({
    cwd,
    sessionId: 'session-live',
    title: 'Live chart',
    kind: 'html',
    content: '<html><script>fetch("https://api.example.com/x")</script></html>',
    origins: ['https://api.example.com/', 'https://api.example.com', 'http://localhost:3000'],
  });
  assert.equal(meta.live, true);
  assert.deepEqual(meta.origins, ['https://api.example.com', 'http://localhost:3000']);
  const onDisk = JSON.parse(
    await readFile(join(cwd, '.beecode', 'slates', 'session-live', meta.id, 'meta.json'), 'utf8'),
  );
  assert.deepEqual(onDisk.origins, ['https://api.example.com', 'http://localhost:3000']);
  assert.equal(onDisk.live, true);
});

test('an html slate without origins is not live', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  const meta = await store.create({
    cwd,
    sessionId: 'session-inert',
    title: 'Static page',
    kind: 'html',
    content: '<html><body>hi</body></html>',
  });
  assert.equal(meta.live, undefined);
  assert.equal(meta.origins, undefined);
});

test('a markdown slate cannot ask to be live', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  await assert.rejects(
    store.create({
      cwd,
      sessionId: 'session-md',
      title: 'Notes',
      kind: 'markdown',
      content: '# notes',
      origins: ['https://api.example.com'],
    }),
    /cannot go live/,
  );
});

test('a wildcard origin is refused at creation, before anything is written', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  await assert.rejects(
    store.create({
      cwd,
      sessionId: 'session-star',
      title: 'Anything',
      kind: 'html',
      content: '<html></html>',
      origins: ['*'],
    }),
    /wildcard/,
  );
  assert.deepEqual(await store.list({ cwd, sessionId: 'session-star' }), []);
});

test('setLive is the user switch and persists both edges', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  const created = await store.create({
    cwd,
    sessionId: 'session-switch',
    title: 'Interactive',
    kind: 'html',
    content: '<html><script>/* none */</script></html>',
  });

  const on = await store.setLive({
    cwd,
    sessionId: 'session-switch',
    id: created.id,
    enabled: true,
    origins: ['https://api.example.com'],
  });
  assert.equal(on.live, true);
  assert.deepEqual(on.origins, ['https://api.example.com']);
  assert.notEqual(on.updatedAt, created.updatedAt);

  // Turning scripts off keeps the allowlist: the user withdrew execution, not the list.
  const off = await store.setLive({ cwd, sessionId: 'session-switch', id: created.id, enabled: false });
  assert.equal(off.live, false);
  assert.deepEqual(off.origins, ['https://api.example.com']);

  const reread = await store.list({ cwd, sessionId: 'session-switch' });
  assert.equal(reread[0].live, false);
  assert.deepEqual(reread[0].origins, ['https://api.example.com']);
});

test('an explicit empty allowlist clears the origins', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  const created = await store.create({
    cwd,
    sessionId: 'session-clear',
    title: 'Calls something',
    kind: 'html',
    content: '<html></html>',
    origins: ['https://api.example.com'],
  });
  const cleared = await store.setLive({
    cwd,
    sessionId: 'session-clear',
    id: created.id,
    enabled: true,
    origins: [],
  });
  assert.equal(cleared.live, true);
  assert.equal(cleared.origins, undefined);
});

test('setLive refuses a non-html slate and a wildcard', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  const notes = await store.create({
    cwd,
    sessionId: 'session-refuse',
    title: 'Notes',
    kind: 'markdown',
    content: '# notes',
  });
  await assert.rejects(
    store.setLive({ cwd, sessionId: 'session-refuse', id: notes.id, enabled: true }),
    /cannot go live/,
  );

  const page = await store.create({
    cwd,
    sessionId: 'session-refuse',
    title: 'Page',
    kind: 'html',
    content: '<html></html>',
  });
  await assert.rejects(
    store.setLive({
      cwd,
      sessionId: 'session-refuse',
      id: page.id,
      enabled: true,
      origins: ['https://*.example.com'],
    }),
    /wildcard/,
  );
});

test('a version records what it was built from, and keeps it across a re-read', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const created = await store.create({
      cwd,
      sessionId: 'session-recipe',
      title: 'Sales',
      kind: 'markdown',
      content: '# Sales\n',
    });

    const recorded = await store.recordRecipe({
      cwd,
      sessionId: 'session-recipe',
      id: created.id,
      recipe: [{ tool: 'fs_read', args: { path: 'data/sales.csv' } }],
    });
    assert.deepEqual(recorded.versions[0].recipe, [
      { tool: 'fs_read', args: { path: 'data/sales.csv' } },
    ]);

    // It is stored beside the version it belongs to, so a restart still knows the sources.
    const meta = JSON.parse(
      await readFile(join(cwd, '.beecode', 'slates', 'session-recipe', created.id, 'meta.json'), 'utf8'),
    ) as { versions: { recipe?: unknown }[] };
    assert.deepEqual(meta.versions[0].recipe, [
      { tool: 'fs_read', args: { path: 'data/sales.csv' } },
    ]);
    const reloaded = await store.meta({ cwd, sessionId: 'session-recipe', id: created.id });
    assert.deepEqual(reloaded.versions[0].recipe, [
      { tool: 'fs_read', args: { path: 'data/sales.csv' } },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a recipe cannot be attached to a version that is no longer current', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const created = await store.create({
      cwd,
      sessionId: 'session-stale',
      title: 'Sales',
      kind: 'markdown',
      content: 'one\n',
    });
    await store.update({ cwd, sessionId: 'session-stale', id: created.id, content: 'two\n' });

    // v1 is history now: recording sources against it later would claim a build that may
    // not have happened, and the file can never be rewritten to match.
    await assert.rejects(
      store.recordRecipe({
        cwd,
        sessionId: 'session-stale',
        id: created.id,
        version: 1,
        recipe: [{ tool: 'fs_read', args: { path: 'other.csv' } }],
      }),
      /moved on to version 2/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a recipe that replays a write, or records nothing, is refused', async () => {
  const cwd = await workspace();
  try {
    const store = new SlateStore();
    const created = await store.create({
      cwd,
      sessionId: 'session-recipe-refuse',
      title: 'Sales',
      kind: 'markdown',
      content: '# Sales\n',
    });
    const location = { cwd, sessionId: 'session-recipe-refuse', id: created.id };

    await assert.rejects(
      store.recordRecipe({ ...location, recipe: [{ tool: 'shell', args: { command: 'ls' } }] }),
      /which writes/,
    );
    await assert.rejects(store.recordRecipe({ ...location, recipe: [] }), /empty/);

    // Nothing half-written survives a refusal.
    const meta = await store.meta(location);
    assert.equal(meta.versions[0].recipe, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
