/**
 * Plugin system: manifest validation, permission gating and the starter plugins.
 *
 * The host is exercised with the real builtin plugins and hand-made ones — a plugin that
 * asks for a permission it did not declare must fail in-band, never crash the loop.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import type { PluginsConfig } from '../shared/protocol';
import type { ToolContext, ToolDefinition } from '../shared/tools';
import type { AuditLog } from '../service/audit';
import type { Logger } from '../service/logger';
import type { PolicyEngine } from '../service/policy';
import { BUILTIN_PLUGINS } from './builtin';
import { markdownToHtml, markdownDocument } from './html';
import { PluginHost, loadExternalPlugin, normalizeManifest } from './host';
import {
  failResult,
  HOST_METHOD_PERMISSION,
  okResult,
  PLUGIN_API_VERSION,
  type PluginDefinition,
} from './types';
import { buildXlsx, columnName, crc32, sheetName } from './xlsx';
import { parseDelimited, toCsv, toMatrix } from './builtin/tableExport';

const config = (patch: Partial<PluginsConfig> = {}): PluginsConfig => ({
  enabled: true,
  allowExternal: false,
  dirs: [],
  disabled: [],
  ...patch,
});

const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

const allowPolicy = {
  evaluateFile: () => ({ allowed: true, reason: undefined }),
} as unknown as PolicyEngine;

const denyPolicy = {
  evaluateFile: () => ({ allowed: false, reason: 'outside the workspace' }),
} as unknown as PolicyEngine;

function hostWith(
  options: {
    plugins?: PluginsConfig;
    builtins?: PluginDefinition[];
    policy?: PolicyEngine;
    reserved?: string[];
  } = {},
): PluginHost {
  return new PluginHost({
    plugins: () => options.plugins ?? config(),
    builtins: options.builtins ?? BUILTIN_PLUGINS,
    log: silentLog,
    policy: () => options.policy ?? allowPolicy,
    audit: () => ({ record() {} }) as unknown as AuditLog,
    hostCall: () => undefined,
    reservedNames: () => options.reserved ?? [],
  });
}

function context(cwd: string): ToolContext {
  return {
    sessionId: 's1',
    cwd,
    mode: 'act',
    workspaceRoots: [cwd],
    signal: new AbortController().signal,
  } as ToolContext;
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-plugins-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ manifest */

test('normalizeManifest rejects ids that would break config or audit keys', () => {
  assert.throws(() => normalizeManifest({ id: 'Bad Id' }, 'test'), /invalid plugin id/);
  assert.throws(() => normalizeManifest({ id: 'a' }, 'test'), /invalid plugin id/);
  assert.throws(() => normalizeManifest({}, 'test'), /invalid plugin id/);
});

test('normalizeManifest drops unknown permissions and defaults the api version', () => {
  const manifest = normalizeManifest(
    { id: 'demo-plugin', name: 'Demo', permissions: ['files:read', 'wat', 'pdf:view'] as never },
    'test',
  );
  assert.equal(manifest.id, 'demo-plugin');
  assert.equal(manifest.name, 'Demo');
  assert.equal(manifest.version, '0.0.0');
  assert.equal(manifest.api, PLUGIN_API_VERSION);
  assert.deepEqual(manifest.permissions, ['files:read', 'pdf:view']);
});

/* ---------------------------------------------------------------------- host */

test('the bundled starters register their tools under the plugins group', async () => {
  const host = hostWith();
  await host.start();
  try {
    const info = host.info();
    assert.deepEqual(info.map((plugin) => plugin.id).sort(), ['pdf-generator', 'pdf-viewer', 'table-export']);
    assert.ok(info.every((plugin) => plugin.enabled && !plugin.error && plugin.source === 'builtin'));

    const tools = host.toolDefinitions();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['excel_export', 'pdf_generate', 'pdf_open']);
    assert.ok(tools.every((tool) => tool.group === 'plugins'));
    // Nothing that only reads may be blocked behind an approval.
    assert.equal(tools.find((tool) => tool.name === 'pdf_open')?.mutating, false);
    assert.equal(tools.find((tool) => tool.name === 'excel_export')?.mutating, true);
  } finally {
    await host.stop();
  }
});

test('a tool name already in the core catalogue is dropped, not thrown', async () => {
  const host = hostWith({ reserved: ['pdf_open'] });
  await host.start();
  try {
    const names = host.toolDefinitions().map((tool) => tool.name);
    assert.ok(!names.includes('pdf_open'));
    assert.ok(names.includes('excel_export'));
  } finally {
    await host.stop();
  }
});

test('disabled plugins stay listed but contribute no tools, and can be toggled', async () => {
  const host = hostWith({ plugins: config({ disabled: ['table-export'] }) });
  await host.start();
  try {
    const disabled = host.info().find((plugin) => plugin.id === 'table-export');
    assert.equal(disabled?.enabled, false);
    assert.equal(disabled?.tools.length, 0);
    assert.ok(!host.toolDefinitions().some((tool) => tool.name === 'excel_export'));

    await host.setEnabled('table-export', true);
    assert.ok(host.toolDefinitions().some((tool) => tool.name === 'excel_export'));

    await host.setEnabled('table-export', false);
    assert.ok(!host.toolDefinitions().some((tool) => tool.name === 'excel_export'));
  } finally {
    await host.stop();
  }
});

test('plugins.enabled = false registers nothing at all', async () => {
  const host = hostWith({ plugins: config({ enabled: false }) });
  await host.start();
  try {
    assert.deepEqual(host.info(), []);
    assert.deepEqual(host.toolDefinitions(), []);
  } finally {
    await host.stop();
  }
});

test('a tool that throws becomes an in-band failure tagged with the plugin id', async () => {
  const broken: PluginDefinition = {
    source: 'builtin',
    manifest: { id: 'broken-plugin', name: 'Broken', version: '1.0.0', description: '' },
    activate(api) {
      api.registerTool({
        name: 'broken_tool',
        description: 'throws',
        mutating: false,
        group: 'plugins',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          throw new Error('boom');
        },
      });
    },
  };
  const host = hostWith({ builtins: [broken] });
  await host.start();
  try {
    const tool = host.toolDefinitions().find((entry) => entry.name === 'broken_tool');
    assert.ok(tool);
    const result = await tool.handler({}, context(tmpdir()));
    assert.equal(result.failed, true);
    assert.match(result.content, /boom/);
    assert.equal(result.meta?.plugin, 'broken-plugin');
  } finally {
    await host.stop();
  }
});

test('an undeclared permission refuses the call instead of reaching the filesystem', async () => {
  const sneaky: PluginDefinition = {
    source: 'builtin',
    manifest: {
      id: 'sneaky-plugin',
      name: 'Sneaky',
      version: '1.0.0',
      description: '',
      permissions: ['files:read'],
    },
    activate(api) {
      api.registerTool({
        name: 'sneaky_write',
        description: 'writes without declaring files:write',
        mutating: true,
        group: 'plugins',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        handler: async (args, ctx) => {
          const written = await api.fs.writeText(ctx, String(args.path), 'x');
          return okResult(written);
        },
      });
    },
  };
  const host = hostWith({ builtins: [sneaky] });
  await host.start();
  try {
    const tool = host.toolDefinitions().find((entry) => entry.name === 'sneaky_write');
    assert.ok(tool);
    await withTempDir(async (dir) => {
      const result = await tool.handler({ path: join(dir, 'out.txt') }, context(dir));
      assert.equal(result.failed, true);
      assert.match(result.content, /files:write/);
      assert.equal(existsSync(join(dir, 'out.txt')), false);
    });
  } finally {
    await host.stop();
  }
});

test('the file policy gates plugin writes exactly like the file tools', async () => {
  const host = hostWith({ policy: denyPolicy });
  await host.start();
  try {
    const tool = host.toolDefinitions().find((entry) => entry.name === 'excel_export');
    assert.ok(tool);
    await withTempDir(async (dir) => {
      const result = await tool.handler({ path: join(dir, 'blocked.xlsx'), rows: [['a']] }, context(dir));
      assert.equal(result.failed, true);
      assert.match(result.content, /outside the workspace/);
      assert.equal(existsSync(join(dir, 'blocked.xlsx')), false);
    });
  } finally {
    await host.stop();
  }
});

test('excel_export writes a real xlsx package', async () => {
  const host = hostWith();
  await host.start();
  try {
    const tool = host.toolDefinitions().find((entry) => entry.name === 'excel_export');
    assert.ok(tool);
    await withTempDir(async (dir) => {
      const path = join(dir, 'report');
      const result = await tool.handler(
        {
          path,
          sheet: 'Q3',
          rows: [
            ['Region', 'Revenue', 'Open'],
            ['EMEA', 1250.5, true],
            ['APAC', 980, false],
          ],
        },
        context(dir),
      );
      assert.equal(result.failed, undefined, result.content);
      const file = `${path}.xlsx`;
      assert.equal(existsSync(file), true);
      const bytes = await readFile(file);
      assert.equal(bytes.subarray(0, 4).toString('binary'), 'PK\x03\x04');
      // Zip entries are stored with their names in plain text in the central directory.
      const raw = bytes.toString('binary');
      assert.ok(raw.includes('xl/worksheets/sheet1.xml'));
      assert.ok(raw.includes('[Content_Types].xml'));
    });
  } finally {
    await host.stop();
  }
});

test('pdf tools report the missing desktop host instead of hanging', async () => {
  const host = hostWith();
  await host.start();
  try {
    const tool = host.toolDefinitions().find((entry) => entry.name === 'pdf_generate');
    assert.ok(tool);
    await withTempDir(async (dir) => {
      const result = await tool.handler({ path: join(dir, 'r.pdf'), markdown: '# Hi' }, context(dir));
      assert.equal(result.failed, true);
      assert.match(result.content, /desktop host/);
    });
  } finally {
    await host.stop();
  }
});

/* --------------------------------------------------------------------- xlsx */

test('column names and sheet names follow Excel rules', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(701), 'ZZ');
  assert.equal(columnName(702), 'AAA');
  assert.equal(sheetName('Revenue [Q3]:*?/'), 'Revenue  Q3');
  assert.equal(sheetName('   '), 'Sheet1');
  assert.equal(sheetName('x'.repeat(40)).length, 31);
});

/** Read the entries out of a zip produced by `buildXlsx` (stored or deflated). */
function unzip(bytes: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const data = bytes.subarray(start, start + size);
    entries.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    offset = start + size;
  }
  return entries;
}

test('crc32 matches the reference vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('buildXlsx is deterministic and refuses an empty workbook', () => {
  const sheet = { name: 'S', rows: [['a', 1], ['b', 2]] };
  const first = buildXlsx([sheet]);
  const second = buildXlsx([sheet]);
  assert.deepEqual(first, second);
  assert.throws(() => buildXlsx([]), /at least one sheet/);
  // End of central directory record, the marker every zip reader looks for.
  assert.equal(first.subarray(first.length - 22, first.length - 18).toString('binary'), 'PK\x05\x06');
});

test('buildXlsx escapes markup and de-duplicates sheet names', () => {
  const bytes = buildXlsx([
    { name: 'A', rows: [['<b>&"']] },
    { name: 'A', rows: [['x']] },
  ]);
  // Cell text lives inside a deflated part, so it has to be inflated before it can be
  // asserted on — searching the raw zip bytes only works for stored entries.
  const parts = unzip(bytes);
  const first = parts.get('xl/worksheets/sheet1.xml') ?? '';
  assert.ok(first.includes('<worksheet'), 'the first sheet part must exist');
  assert.ok(first.includes('&lt;b&gt;&amp;&quot;'), 'cell text must be XML-escaped');
  const workbook = parts.get('xl/workbook.xml') ?? '';
  assert.match(workbook, /sheet name="A_[0-9]+"/, 'the second sheet must be renamed');
});

/* ------------------------------------------------------------ table helpers */

test('parseDelimited handles quotes, embedded separators and CRLF', () => {
  const rows = parseDelimited('a,b\r\n"x,1","he said ""hi"""\r\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,1', 'he said "hi"'],
  ]);
});

test('toCsv quotes only what needs quoting, and round-trips through the parser', () => {
  const rows = [
    ['plain', 'with,comma'],
    ['quote"inside', 3],
  ];
  const csv = toCsv(rows);
  assert.match(csv, /^plain,"with,comma"/);
  assert.deepEqual(parseDelimited(csv), [
    ['plain', 'with,comma'],
    ['quote"inside', '3'],
  ]);
});

test('toMatrix accepts records and rejects ragged input', () => {
  assert.deepEqual(toMatrix([{ a: 1, b: 'x' }, { b: 'y', c: true }]), [
    ['a', 'b', 'c'],
    [1, 'x', null],
    [null, 'y', true],
  ]);
  assert.throws(() => toMatrix([]), /non-empty/);
  assert.throws(() => toMatrix([['a'], 5]), /array of arrays/);
});

/* ---------------------------------------------------------------- markdown */

test('markdownToHtml renders the constructs a report needs', () => {
  const html = markdownToHtml(
    ['# Title', '', 'Some **bold** and `code`.', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '- one', '- two', '', '```ts', 'const x = 1;', '```'].join('\n'),
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>2<\/td>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<pre><code>const x = 1;<\/code><\/pre>/);
});

test('markdownToHtml escapes HTML and protects code spans from emphasis', () => {
  const html = markdownToHtml('a <script>alert(1)</script> and `a*b*c`');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<code>a\*b\*c<\/code>/);
});

test('markdownDocument wraps the fragment in a printable page', () => {
  const doc = markdownDocument('# Hi', { title: 'Report', landscape: true });
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /<title>Report<\/title>/);
  assert.match(doc, /size: landscape/);
});

/* ------------------------------------------------------------- user plugins */

test('a user plugin directory is discovered, validated and activated', async () => {
  await withTempDir(async (dir) => {
    const pluginDir = join(dir, 'hello-plugin');
    await readdir(dir);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ id: 'hello-plugin', name: 'Hello', version: '1.2.3', permissions: ['files:read'] }),
      'utf8',
    );
    await writeFile(
      join(pluginDir, 'plugin.js'),
      `exports.activate = (api) => {
         api.registerTool({
           name: 'hello_tool',
           description: 'says hello',
           mutating: false,
           group: 'plugins',
           inputSchema: { type: 'object', properties: {} },
           handler: async () => ({ content: 'hello from ' + api.manifest.id }),
         });
       };`,
      'utf8',
    );

    const host = hostWith({ plugins: config({ allowExternal: true, dirs: [dir] }) });
    await host.start();
    try {
      const info = host.info().find((plugin) => plugin.id === 'hello-plugin');
      assert.ok(info, 'external plugin should be listed');
      assert.equal(info.source, 'user');
      assert.equal(info.version, '1.2.3');
      assert.deepEqual(info.permissions, ['files:read']);
      const tool = host.toolDefinitions().find((entry) => entry.name === 'hello_tool');
      assert.ok(tool);
      const result = await tool.handler({}, context(dir));
      assert.equal(result.content, 'hello from hello-plugin');
    } finally {
      await host.stop();
    }
  });
});

test('a user plugin without an entry point is skipped, not fatal', async () => {
  await withTempDir(async (dir) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const pluginDir = join(dir, 'empty-plugin');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'empty-plugin' }), 'utf8');

    const host = hostWith({ plugins: config({ allowExternal: true, dirs: [dir] }) });
    await host.start();
    try {
      assert.equal(host.info().find((plugin) => plugin.id === 'empty-plugin'), undefined);
      assert.equal(host.info().length, BUILTIN_PLUGINS.length);
    } finally {
      await host.stop();
    }
  });
});

test('helper results carry the failure flag the loop understands', () => {
  assert.equal(okResult('x').failed, undefined);
  assert.equal(failResult('x').failed, true);
});

test('a tool definition is the only shape plugins may register', () => {
  const shape: Partial<ToolDefinition> = { name: 'x', mutating: false };
  assert.equal(shape.mutating, false);
});

test('the shipped sample plugin loads and its tool runs through the fs gate', async () => {
  const sample = join(process.cwd(), 'resources', 'sample-plugin');
  assert.ok(existsSync(join(sample, 'plugin.json')), 'the sample plugin must ship with the repo');

  await withTempDir(async (dir) => {
    const { cp, writeFile } = await import('node:fs/promises');
    await cp(sample, join(dir, 'md-stats'), { recursive: true });
    await writeFile(join(dir, 'doc.md'), '# Title\n\nSome words here.\n\n## Part\n\nMore.\n', 'utf8');

    const host = hostWith({ plugins: config({ allowExternal: true, dirs: [dir] }) });
    await host.start();
    try {
      const info = host.info().find((plugin) => plugin.id === 'md-stats');
      assert.ok(info, 'the sample plugin should be listed');
      assert.equal(info.error, undefined);
      assert.equal(info.source, 'user');
      assert.deepEqual(info.permissions, ['files:read']);

      const tool = host.toolDefinitions().find((entry) => entry.name === 'md_stats');
      assert.ok(tool, 'md_stats should be registered');
      assert.equal(tool.group, 'plugins');
      assert.equal(tool.mutating, false);

      const result = await tool.handler({ path: 'doc.md' }, context(dir));
      assert.equal(result.failed, undefined);
      assert.match(result.content, /8 lines · 8 words · 2 headings/);
      assert.match(result.content, /Title/);
      assert.match(result.content, /Part/);

      const missing = await tool.handler({ path: 'nope.md' }, context(dir));
      assert.equal(missing.failed, true, 'a missing file is an in-band failure');
    } finally {
      await host.stop();
    }
  });
});

test('pdf/render needs files:write as well as pdf:render', () => {
  // The write happens in the main process, outside api.fs — so the host method itself has to
  // demand the permission, or it becomes a way around the file policy.
  assert.deepEqual(HOST_METHOD_PERMISSION['pdf/render'], ['pdf:render', 'files:write']);
  assert.deepEqual(HOST_METHOD_PERMISSION['pdf/open'], ['pdf:view']);
});

test('pdf_generate applies the file policy before it creates or writes anything', async () => {
  const host = hostWith({ policy: denyPolicy });
  await host.start();
  try {
    const tool = host.toolDefinitions().find((entry) => entry.name === 'pdf_generate');
    assert.ok(tool);
    await withTempDir(async (dir) => {
      // The output sits in a directory the tool would have to create first: the denial has to
      // land before that mkdir, so a refused path leaves nothing behind on disk.
      const result = await tool.handler(
        { path: join(dir, 'reports', 'blocked.pdf'), markdown: '# Report' },
        context(dir),
      );
      assert.equal(result.failed, true);
      assert.match(result.content, /outside the workspace/);
      assert.equal(existsSync(join(dir, 'reports')), false);
    });
  } finally {
    await host.stop();
  }
});

test('an entry point outside the plugin directory is refused', async () => {
  await withTempDir(async (dir) => {
    // A sibling that merely shares the name prefix is the interesting case: a bare
    // startsWith() test would accept "md-stats-evil" for the plugin "md-stats".
    const root = join(dir, 'plugins');
    const pluginDir = join(root, 'md-stats');
    const siblingDir = join(root, 'md-stats-evil');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(siblingDir, 'evil.js'), 'exports.activate = () => {};\n', 'utf8');
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'md-stats',
        name: 'md-stats',
        version: '1.0.0',
        main: '../md-stats-evil/evil.js',
      }),
      'utf8',
    );
    await assert.rejects(() => loadExternalPlugin(pluginDir), /escapes the plugin directory/);
  });
});
