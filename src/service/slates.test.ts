import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertSlateId, MAX_SLATE_BYTES, SlateStore, slateIdFrom } from './slates';

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
      /limit is 512 KB/,
    );
    await assert.rejects(
      () => store.create({ ...location, title: 'Weird', kind: 'pdf', content: 'x' }),
      /unsupported slate kind/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('slateIdFrom slugifies a title and falls back to "slate"', () => {
  assert.equal(slateIdFrom('Sales Q3 — EMEA'), 'sales-q3-emea');
  assert.equal(slateIdFrom('  ...  '), 'slate');
  assert.equal(slateIdFrom('Ärger über Öl'), 'arger-uber-ol');
});
