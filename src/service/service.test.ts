import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { FsFile, FsListing, McpListResult, PluginInstallResult, SkillInstallResult, SkillListResult, SkillReadResult } from '../shared/protocol';

/** A real stdio MCP server with one read-only and one mutating tool. */
const FAKE_MCP_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const NEWLINE = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + NEWLINE);
const tools = [
  { name: 'read_note', description: 'Read a note', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'write_note', description: 'Write a note', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } } },
];
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } });
  } else if (message.method === 'tools/list') {
    reply({ tools });
  } else if (message.method === 'tools/call') {
    reply({ content: [{ type: 'text', text: 'ok' }] });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`;

/**
 * A minimal stored (uncompressed) ZIP archive.
 *
 * The installer reads the central directory and inflates method 8 entries; tests build
 * archives with method 0 so the CRC a real writer would compute never matters.
 */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * End-to-end service test: boots the real background service against a throw-away
 * BEECODE_HOME with the mock desktop driver, exposes it over the loopback HTTP
 * transport and drives it with JSON-RPC — exactly what an external client would do.
 */
test('background service answers JSON-RPC over loopback HTTP', async () => {
  const home = await mkdtemp(join(tmpdir(), 'beecode-home-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace, { recursive: true });

  // An MCP server and a workspace skill, so the boot path exercises both surfaces.
  const mcpServerPath = join(home, 'fake-mcp.cjs');
  await writeFile(mcpServerPath, FAKE_MCP_SERVER, 'utf8');
  const skillDir = join(workspace, '.beecode', 'skills', 'release');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    ['---', 'name: release', 'description: Cut a release', '---', '', '# Release', '', 'Tag, build, publish.', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      defaultModelId: 'claude-sonnet',
      desktop: { enabled: true, driver: 'mock', allowInput: true },
      agent: { defaultMode: 'ask', maxSteps: 4, autoApproveTools: [], workingDir: workspace },
      subagents: { enabled: true, maxConcurrent: 2, cliAgents: [] },
      mcpServers: {
        fake: { enabled: true, transport: 'stdio', command: process.execPath, args: [mcpServerPath] },
      },
    }),
    'utf8',
  );

  const previousHome = process.env.BEECODE_HOME;
  process.env.BEECODE_HOME = home;

  const { BeeCodeService } = await import('./service');
  const { startHttpTransport } = await import('./transports/http');

  const service = await BeeCodeService.create({ transport: 'http', version: 'test', workspace });
  const transport = await startHttpTransport(service, { port: 0, token: 'test-token' });

  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(`http://127.0.0.1:${transport.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()) as { result?: unknown; error?: { message: string } };
  };

  try {
    const health = await rpc('service.health');
    const healthResult = health.result as { ok: boolean; tools: number; desktopDriver: string };
    assert.equal(healthResult.ok, true);
    assert.equal(healthResult.desktopDriver, 'mock');
    assert.ok(healthResult.tools >= 15, `expected the tool catalogue, got ${healthResult.tools}`);

    const tools = (await rpc('tools.list')).result as Array<{ name: string; group: string }>;
    const names = tools.map((t) => t.name);
    for (const expected of ['desktop_launch', 'desktop_ui_tree', 'desktop_type', 'subagent_delegate', 'shell_run']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    // Builtin plugins activate even when config.json has no `plugins` block, so their tools
    // must reach the catalogue the model sees — not only PluginHost.toolDefinitions().
    const pluginTools = tools.filter((tool) => tool.group === 'plugins').map((tool) => tool.name);
    for (const expected of ['pdf_generate', 'pdf_open', 'excel_export']) {
      assert.ok(pluginTools.includes(expected), `missing plugin tool ${expected}`);
    }

    const policy = (await rpc('policy.get')).result as { allowedApps: Array<{ id: string }> };
    assert.ok(policy.allowedApps.some((a) => a.id === 'notepad'));

    // MCP: the configured server is connected, its tools are exposed as
    // mcp__<server>__<tool>, and only the ones without readOnlyHint need approval.
    const mcp = (await rpc('mcp.list')).result as McpListResult;
    assert.equal(mcp.servers.length, 1);
    assert.equal(mcp.servers[0].state, 'connected');
    const mcpTools = new Map(mcp.servers[0].tools.map((tool) => [tool.tool, tool.mutating]));
    assert.deepEqual([...mcpTools.keys()].sort(), ['mcp__fake__read_note', 'mcp__fake__write_note']);
    assert.equal(mcpTools.get('mcp__fake__read_note'), false);
    assert.equal(mcpTools.get('mcp__fake__write_note'), true);

    // Skills: the workspace playbook is listed and its body is loaded on demand.
    const listed = (await rpc('skill.list', { cwd: workspace })).result as SkillListResult;
    assert.deepEqual(
      listed.skills.map((skill) => skill.name),
      ['release'],
    );
    assert.equal(listed.skills[0].source, 'project');
    const detail = (await rpc('skill.read', { name: 'release', cwd: workspace })).result as SkillReadResult;
    assert.match(detail.content, /^# Release/);
    assert.match(detail.content, /Tag, build, publish\./);

    // Skills drag-and-drop: a dropped SKILL.md installs as a user skill, and a ZIP installs
    // every folder inside it that carries a SKILL.md — scripts included.
    const fromFile = (
      await rpc('skill.install', {
        fileName: 'deploy.md',
        text: '---\nname: deploy\ndescription: Ship it\n---\n\n# Deploy\n\nTag, build, publish.\n',
      })
    ).result as SkillInstallResult;
    assert.deepEqual(fromFile.installed, ['deploy']);
    assert.ok(
      fromFile.skills.some((skill) => skill.name === 'deploy' && skill.source === 'user'),
      'the installed skill is listed without a reload',
    );

    const archive = zipOf({
      'pack/SKILL.md': '---\nname: pack\ndescription: Bundle it\n---\n\n# Pack\n',
      'pack/scripts/run.sh': '#!/bin/sh\necho pack\n',
      'README.md': 'not a skill',
    });
    const fromZip = (
      await rpc('skill.install', { fileName: 'pack.zip', base64: archive.toString('base64') })
    ).result as SkillInstallResult;
    assert.deepEqual(fromZip.installed, ['pack']);
    assert.equal(
      await readFile(join(home, 'skills', 'pack', 'scripts', 'run.sh'), 'utf8'),
      '#!/bin/sh\necho pack\n',
      'the files next to the SKILL.md are installed with it',
    );

    const notAZip = await rpc('skill.install', { fileName: 'broken.zip', base64: 'bm90IGEgemlw' });
    assert.ok(notAZip.error, 'a corrupt archive is refused instead of half installed');

    // Installing from a URL: the service downloads the artifact itself, so a link behaves
    // exactly like a dropped file — and a URL it refuses to fetch fails up front.
    const served = createServer((request, response) => {
      if (request.url === '/remote/SKILL.md') {
        response.setHeader('content-type', 'text/markdown');
        response.end('---\nname: from-url\ndescription: Installed from a URL.\n---\nFetch it.');
        return;
      }
      if (request.url === '/remote/pack.zip') {
        response.setHeader('content-type', 'application/zip');
        response.end(zipOf({ 'pack/SKILL.md': '---\nname: url-pack\ndescription: Zip from a URL.\n---\nUnpack me.' }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve) => served.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (served.address() as AddressInfo).port;
    try {
      const fromUrl = (await rpc('skill.install', { url: origin + '/remote/SKILL.md' })).result as SkillInstallResult;
      assert.deepEqual(fromUrl.installed, ['from-url']);
      assert.match(
        await readFile(join(home, 'skills', 'from-url', 'SKILL.md'), 'utf8'),
        /Fetch it/,
      );
      const zipFromUrl = (await rpc('skill.install', { url: origin + '/remote/pack.zip' })).result as SkillInstallResult;
      assert.deepEqual(zipFromUrl.installed, ['url-pack']);

      const plainHttp = await rpc('skill.install', { url: 'http://example.com/SKILL.md' });
      assert.match(plainHttp.error?.message ?? '', /only https/);
      const missing = await rpc('skill.install', { url: origin + '/remote/nope.md' });
      assert.match(missing.error?.message ?? '', /HTTP 404/);
    } finally {
      await new Promise<void>((resolve) => served.close(() => resolve()));
    }

    // Workspace explorer: the renderer gets the tree from the service, so the listing has to
    // describe folders and files and every path has to stay inside the roots.
    await writeFile(join(workspace, 'notes.txt'), 'hello explorer', 'utf8');
    await mkdir(join(workspace, 'nested'), { recursive: true });
    const listing = (await rpc('fs.list', { path: '.' })).result as FsListing;
    const entries = new Map(listing.entries.map((entry) => [entry.name, entry]));
    assert.equal(entries.get('notes.txt')?.dir, false);
    assert.equal(entries.get('notes.txt')?.size, 14);
    assert.equal(entries.get('nested')?.dir, true);
    assert.equal(listing.parent, undefined, 'the root has no parent to walk up to');

    const preview = (await rpc('fs.read', { path: 'notes.txt' })).result as FsFile;
    assert.equal(preview.name, 'notes.txt');
    assert.equal(preview.truncated, false);
    assert.match(preview.text ?? '', /hello explorer/);

    const escaped = await rpc('fs.list', { path: '../..' });
    assert.match(escaped.error?.message ?? '', /outside the workspace/);
    const escapedRead = await rpc('fs.read', { path: '../../etc/passwd' });
    assert.match(escapedRead.error?.message ?? '', /outside the workspace/);

    // Config editing: the integrations panel writes mcpServers through config.set, so a
    // saved edit has to reconnect right there and the tool catalogue has to follow.
    const config = (await rpc('config.get')).result as Record<string, unknown> & {
      mcpServers: Record<string, unknown>;
    };
    const saved = await rpc('config.set', {
      config: {
        ...config,
        mcpServers: {
          ...config.mcpServers,
          second: { enabled: true, transport: 'stdio', command: process.execPath, args: [mcpServerPath] },
          broken: { enabled: true, transport: 'stdio', command: join(home, 'missing-binary'), args: [] },
        },
      },
    });
    assert.equal(saved.error, undefined, saved.error?.message);
    const afterAdd = (await rpc('mcp.list')).result as McpListResult;
    assert.deepEqual(
      afterAdd.servers.map((server) => server.name).sort(),
      ['broken', 'fake', 'second'],
    );
    assert.equal(afterAdd.servers.find((server) => server.name === 'second')?.state, 'connected');
    // A server that cannot be spawned is reported in its status — never fatal to the save.
    assert.equal(afterAdd.servers.find((server) => server.name === 'broken')?.state, 'error');
    const afterAddTools = ((await rpc('tools.list')).result as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    assert.ok(afterAddTools.includes('mcp__second__read_note'), 'registry rebuilt with the new server');
    // A rebuild (config change, MCP or plugin reload) must not lose the plugin tools: the
    // core names are reserved for the host, so a plugin tool never reserves its own name.
    assert.ok(afterAddTools.includes('pdf_generate'), 'plugin tools survive a registry rebuild');
    assert.ok(!afterAddTools.includes('mcp__broken__read_note'));

    // Removing it again drops the connection *and* the tools it contributed.
    await rpc('config.set', { config: { ...config, mcpServers: config.mcpServers } });
    const afterRemove = (await rpc('mcp.list')).result as McpListResult;
    assert.deepEqual(
      afterRemove.servers.map((server) => server.name),
      ['fake'],
    );
    const afterRemoveTools = ((await rpc('tools.list')).result as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    assert.ok(!afterRemoveTools.includes('mcp__second__read_note'), 'removed server tools dropped');
    assert.ok(afterRemoveTools.includes('mcp__fake__read_note'), 'untouched server kept its tools');

    const created = (await rpc('session.create', { title: 'e2e' })).result as { id: string; mode: string };
    assert.ok(created.id.startsWith('s_'));
    assert.equal(created.mode, 'ask');

    // Per-session working directory: a session can be moved to another folder, a bogus one is rejected.
    const otherDir = join(home, 'other-project');
    await mkdir(otherDir, { recursive: true });
    const moved = (await rpc('session.setCwd', { sessionId: created.id, cwd: otherDir })).result as { cwd: string };
    assert.equal(moved.cwd, otherDir);
    const movedSnapshot = (await rpc('session.get', { sessionId: created.id })).result as { cwd: string };
    assert.equal(movedSnapshot.cwd, otherDir);
    const bogus = await rpc('session.setCwd', { sessionId: created.id, cwd: join(home, 'does-not-exist') });
    assert.ok(bogus.error, 'a missing working directory must be rejected');

    const sessions = (await rpc('session.list')).result as Array<{ id: string }>;
    assert.ok(sessions.some((s) => s.id === created.id));

    const agents = (await rpc('agents.list')).result as Array<{ id: string; available: boolean }>;
    const internal = agents.find((a) => a.id === 'internal');
    assert.equal(internal?.available, true, 'internal subagent runner must be wired');

    // `pi` is a preset, so Settings can offer it instead of the user typing the command.
    const catalogue = (await rpc('agents.detect', { probe: false })).result as {
      agents: Array<{ id: string; enabled: boolean }>;
    };
    assert.ok(catalogue.agents.some((agent) => agent.id === 'pi'), 'pi must be a listed preset');

    // A custom command that is switched off stays in the config as `enabled: false`;
    // the UI used to drop it, which deleted the command on the next unrelated save.
    const savedAgents = (await rpc('agents.save', {
      agents: [
        { id: 'mine', label: 'mine', command: 'my-agent', args: [], enabled: false, custom: true },
      ],
    })).result as { agents: Array<{ id: string; enabled: boolean }> };
    const mine = savedAgents.agents.find((agent) => agent.id === 'mine');
    assert.equal(mine?.enabled, false, 'a disabled custom command must survive a save');

// Plugin install: one step from a folder on disk to a loaded plugin. The service copies
    // it under the plugin root, switches external plugins on when they were off and lists
    // the result, so nobody has to hand-place files and reload the host.
    const pluginSource = join(home, 'drop-hello');
    await mkdir(pluginSource, { recursive: true });
    await writeFile(
      join(pluginSource, 'plugin.json'),
      JSON.stringify({ id: 'hello-plugin', name: 'Hello', version: '1.2.3', description: 'Says hello' }),
      'utf8',
    );
    await writeFile(join(pluginSource, 'index.js'), 'exports.activate = () => {};', 'utf8');
    const pluginInstalled = (await rpc('plugin.install', { paths: [pluginSource] })).result as PluginInstallResult;
    assert.deepEqual(pluginInstalled.installed, ['hello-plugin']);
    assert.deepEqual(pluginInstalled.skipped, []);
    assert.equal(
      pluginInstalled.allowExternal,
      true,
      'installing an external plugin turns plugins.allowExternal on',
    );
    const listedPlugin = pluginInstalled.plugins.find((plugin) => plugin.id === 'hello-plugin');
    assert.ok(listedPlugin, 'the installed plugin is listed straight away');
    assert.equal(listedPlugin.source, 'user');
    assert.match(
      await readFile(join(home, 'plugins', 'hello-plugin', 'plugin.json'), 'utf8'),
      /hello-plugin/,
      'the plugin lands under the default plugin root',
    );

    // A folder without a manifest is refused by path, and the refusal does not abort the
    // rest of the same drop.
    const bareDrop = join(home, 'drop-bare');
    await mkdir(bareDrop, { recursive: true });
    const refusedDrop = (await rpc('plugin.install', { paths: [bareDrop, pluginSource] }))
      .result as PluginInstallResult;
    assert.deepEqual(refusedDrop.installed, ['hello-plugin']);
    assert.equal(refusedDrop.skipped.length, 1);
    assert.match(refusedDrop.skipped[0].reason, /no plugin\.json/);
    const noSources = await rpc('plugin.install', { paths: [] });
    assert.ok(noSources.error, 'plugin.install without a source must fail');

    // Skill deletion: the whole skill folder goes, sidecar files included, and a name that
    // is no longer on disk is refused instead of being reported as deleted.
    const doomed = join(workspace, '.beecode', 'skills', 'scratch');
    await mkdir(doomed, { recursive: true });
    await writeFile(
      join(doomed, 'SKILL.md'),
      ['---', 'name: scratch', 'description: Temporary playbook', '---', '', '# Scratch', ''].join('\n'),
      'utf8',
    );
    await writeFile(join(doomed, 'notes.txt'), 'sidecar', 'utf8');
    await rpc('skill.reload', { cwd: workspace });
    const deleted = (await rpc('skill.remove', { name: 'scratch', cwd: workspace })).result as SkillListResult & {
      removed: string;
    };
    assert.equal(deleted.removed, doomed);
    assert.ok(!deleted.skills.some((skill) => skill.name === 'scratch'), 'the deleted skill left the listing');
    await assert.rejects(readFile(join(doomed, 'notes.txt'), 'utf8'), 'the sidecar file goes with the skill');
    const deleteAgain = await rpc('skill.remove', { name: 'scratch', cwd: workspace });
    assert.ok(deleteAgain.error, 'removing a skill that is already gone must fail');

    const unknown = await rpc('session.explode');
    assert.match(unknown.error?.message ?? '', /unknown method/);

    const unauthorized = await fetch(`http://127.0.0.1:${transport.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'service.health', params: {} }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await transport.close();
    await service.shutdown();
    if (previousHome === undefined) delete process.env.BEECODE_HOME;
    else process.env.BEECODE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
