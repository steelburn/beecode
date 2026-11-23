import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installPlugins, pluginInstallRoot, type PluginInstallOutcome } from './install';

/** A valid manifest for `id`, plus whatever else a case needs. */
function manifest(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, name: id, version: '1.0.0', ...extra });
}

/**
 * A minimal stored (uncompressed) ZIP archive.
 *
 * The installer reads the central directory and inflates method 8 entries; these archives
 * use method 0, so the CRC a real writer would compute never matters.
 */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(0, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, nameBytes]));

    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** Creates a throwaway home, the plugin root an install writes to, and a scratch drop zone. */
async function sandbox(): Promise<{ home: string; root: string; drop: string; done: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'beecode-plugin-'));
  const root = join(home, 'plugins');
  const drop = join(home, 'drop');
  await mkdir(root, { recursive: true });
  await mkdir(drop, { recursive: true });
  return { home, root, drop, done: () => rm(home, { recursive: true, force: true }) };
}

test('installs a plugin folder under the plugin root', async () => {
  const box = await sandbox();
  try {
    const source = join(box.drop, 'hello');
    await mkdir(join(source, 'lib'), { recursive: true });
    await writeFile(
      join(source, 'plugin.json'),
      manifest('hello-plugin', { description: 'Says hello' }),
      'utf8',
    );
    await writeFile(join(source, 'index.js'), 'module.exports = {};', 'utf8');
    await writeFile(join(source, 'lib', 'helper.js'), 'module.exports = 1;', 'utf8');

    const result = await installPlugins([source], { dirs: [box.root], fallbackRoot: box.root });
    assert.deepEqual(result.installed, ['hello-plugin']);
    assert.deepEqual(result.skipped, []);

    const target = join(box.root, 'hello-plugin');
    assert.equal(
      JSON.parse(await readFile(join(target, 'plugin.json'), 'utf8')).description,
      'Says hello',
    );
    // Nested files keep their relative path, so `require('./lib/helper')` still resolves.
    assert.equal(await readFile(join(target, 'lib', 'helper.js'), 'utf8'), 'module.exports = 1;');
  } finally {
    await box.done();
  }
});

test('installs a zip, stripping the single top folder the archive was wrapped in', async () => {
  const box = await sandbox();
  try {
    const archive = join(box.drop, 'wrapped.zip');
    await writeFile(
      archive,
      zipOf({
        'hello-plugin/plugin.json': manifest('hello-plugin'),
        'hello-plugin/index.js': 'module.exports = {};',
      }),
    );

    const result = await installPlugins([archive], { dirs: [box.root], fallbackRoot: box.root });
    assert.deepEqual(result.installed, ['hello-plugin']);
    // The wrapper folder is gone, so the manifest sits at the root of the plugin.
    assert.ok(await stat(join(box.root, 'hello-plugin', 'plugin.json')));
    assert.ok(await stat(join(box.root, 'hello-plugin', 'index.js')));
  } finally {
    await box.done();
  }
});

test('replaces an earlier install of the same id instead of merging with it', async () => {
  const box = await sandbox();
  try {
    const first = join(box.drop, 'first');
    await mkdir(first, { recursive: true });
    await writeFile(join(first, 'plugin.json'), manifest('hello-plugin'), 'utf8');
    await writeFile(join(first, 'index.js'), 'v1', 'utf8');
    await writeFile(join(first, 'stale.js'), 'left behind', 'utf8');
    await installPlugins([first], { dirs: [box.root], fallbackRoot: box.root });

    const second = join(box.drop, 'second');
    await mkdir(second, { recursive: true });
    await writeFile(join(second, 'plugin.json'), manifest('hello-plugin'), 'utf8');
    await writeFile(join(second, 'index.js'), 'v2', 'utf8');
    await installPlugins([second], { dirs: [box.root], fallbackRoot: box.root });

    assert.equal(await readFile(join(box.root, 'hello-plugin', 'index.js'), 'utf8'), 'v2');
    await assert.rejects(stat(join(box.root, 'hello-plugin', 'stale.js')));
  } finally {
    await box.done();
  }
});

test('refuses a folder with no manifest and still installs the rest of the drop', async () => {
  const box = await sandbox();
  try {
    const broken = join(box.drop, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'index.js'), 'module.exports = {};', 'utf8');

    const good = join(box.drop, 'good');
    await mkdir(good, { recursive: true });
    await writeFile(join(good, 'plugin.json'), manifest('good-plugin'), 'utf8');
    await writeFile(join(good, 'index.js'), 'module.exports = {};', 'utf8');

    const result = await installPlugins([broken, good], {
      dirs: [box.root],
      fallbackRoot: box.root,
    });
    assert.deepEqual(result.installed, ['good-plugin']);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].path, broken);
    assert.match(result.skipped[0].reason, /no plugin\.json/);
  } finally {
    await box.done();
  }
});

test('refuses a manifest that is not JSON and one that names a missing entry point', async () => {
  const box = await sandbox();
  try {
    const badJson = join(box.drop, 'bad-json');
    await mkdir(badJson, { recursive: true });
    await writeFile(join(badJson, 'plugin.json'), '{ not json', 'utf8');
    await writeFile(join(badJson, 'index.js'), '', 'utf8');

    const badMain = join(box.drop, 'bad-main');
    await mkdir(badMain, { recursive: true });
    await writeFile(join(badMain, 'plugin.json'), manifest('bad-main', { main: 'dist/main.js' }), 'utf8');
    await writeFile(join(badMain, 'index.js'), '', 'utf8');

    const noEntry = join(box.drop, 'no-entry');
    await mkdir(noEntry, { recursive: true });
    await writeFile(join(noEntry, 'plugin.json'), manifest('no-entry'), 'utf8');

    const result = await installPlugins([badJson, badMain, noEntry], {
      dirs: [box.root],
      fallbackRoot: box.root,
    });
    assert.deepEqual(result.installed, []);
    const reasons = new Map(result.skipped.map((entry) => [entry.path, entry.reason]));
    assert.match(reasons.get(badJson) ?? '', /not valid JSON/);
    assert.match(reasons.get(badMain) ?? '', /names main "dist\/main\.js"/);
    assert.match(reasons.get(noEntry) ?? '', /no entry point/);
  } finally {
    await box.done();
  }
});

test('refuses a manifest whose id cannot be used as a folder name', async () => {
  const box = await sandbox();
  try {
    const source = join(box.drop, 'shouty');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'plugin.json'), manifest('Hello Plugin'), 'utf8');
    await writeFile(join(source, 'index.js'), '', 'utf8');

    const result = await installPlugins([source], { dirs: [box.root], fallbackRoot: box.root });
    assert.deepEqual(result.installed, []);
    assert.match(result.skipped[0].reason, /invalid plugin id/);
  } finally {
    await box.done();
  }
});

test('ignores a dropped file that is not a zip', async () => {
  const box = await sandbox();
  try {
    const notes = join(box.drop, 'notes.txt');
    await writeFile(notes, 'just a note', 'utf8');
    const result = await installPlugins([notes], { dirs: [box.root], fallbackRoot: box.root });
    assert.deepEqual(result.installed, []);
    assert.match(result.skipped[0].reason, /only a plugin folder or a plugin \.zip/);
  } finally {
    await box.done();
  }
});

test('leaves node_modules out of a folder install', async () => {
  const box = await sandbox();
  try {
    const source = join(box.drop, 'vendored');
    await mkdir(join(source, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(source, 'plugin.json'), manifest('vendored'), 'utf8');
    await writeFile(join(source, 'index.js'), '', 'utf8');
    await writeFile(join(source, 'node_modules', 'dep', 'index.js'), 'dep', 'utf8');

    const result = await installPlugins([source], { dirs: [box.root], fallbackRoot: box.root });
    assert.deepEqual(result.installed, ['vendored']);
    await assert.rejects(stat(join(box.root, 'vendored', 'node_modules')));
  } finally {
    await box.done();
  }
});

test('installs into the first configured root, and the fallback when none is set', () => {
  const first = pluginInstallRoot({ dirs: [join('C:', 'a'), join('C:', 'b')], fallbackRoot: join('C:', 'z') });
  assert.equal(first, join('C:', 'a'));
  const blankIgnored = pluginInstallRoot({ dirs: ['  '], fallbackRoot: join('C:', 'z') });
  assert.equal(blankIgnored, join('C:', 'z'));
});

test('needs at least one source', async () => {
  const box = await sandbox();
  try {
    const result: PluginInstallOutcome = await installPlugins([], {
      dirs: [box.root],
      fallbackRoot: box.root,
    });
    assert.deepEqual(result, { installed: [], skipped: [] });
  } finally {
    await box.done();
  }
});
