import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Logger } from './logger';
import { McpClient } from './mcp/client';
import { McpManager } from './mcp/manager';
import type { ToolContext } from '../shared/tools';

/** A real stdio MCP server: two tools, one read-only, one that fails in-band. */
const STDIO_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const NEWLINE = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + NEWLINE);
const tools = [
  { name: 'read_note', description: 'Read a note', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'write_note', description: 'Write a note', inputSchema: { type: 'object', properties: {} } },
];
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '9.9.9' }, capabilities: { tools: {} } } });
  }
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  if (message.method === 'tools/call') {
    if (message.params.name === 'read_note') {
      return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'note:' + (message.params.arguments.id || '') }] } });
    }
    if (message.params.name === 'write_note') {
      return send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'denied by fake' }] } });
    }
    return send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool' } });
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`;

function silentLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function toolContext(cwd: string): ToolContext {
  return {
    sessionId: 'session-1',
    cwd,
    mode: 'act',
    workspaceRoots: [cwd],
    signal: new AbortController().signal,
    depth: 0,
  };
}

test('stdio mcp server: handshake, tool catalogue and calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-mcp-'));
  const serverPath = join(dir, 'fake-server.cjs');
  await writeFile(serverPath, STDIO_SERVER);

  const manager = new McpManager({
    servers: () => ({
      fake: {
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [serverPath],
        timeoutMs: 15_000,
      },
    }),
    log: silentLogger(),
  });

  try {
    const statuses = await manager.start();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].state, 'connected', statuses[0].error);
    assert.equal(statuses[0].serverName, 'fake');
    assert.equal(statuses[0].version, '9.9.9');
    assert.equal(statuses[0].tools.length, 2);

    const definitions = manager.toolDefinitions();
    const read = definitions.find((definition) => definition.name === 'mcp__fake__read_note');
    const write = definitions.find((definition) => definition.name === 'mcp__fake__write_note');
    assert.ok(read, 'read_note is exposed');
    assert.ok(write, 'write_note is exposed');
    // Only an explicit readOnlyHint skips the approval gate.
    assert.equal(read.mutating, false);
    assert.equal(write.mutating, true);
    assert.equal(read.group, 'mcp');

    const ctx = toolContext(dir);
    const ok = await (read.handler as ToolContextHandler)({ id: '42' }, ctx);
    assert.equal(ok.content, 'note:42');
    assert.equal(ok.failed, undefined);

    const failed = await (write.handler as ToolContextHandler)({}, ctx);
    assert.equal(failed.failed, true);
    assert.match(failed.content, /denied by fake/);

    const unknown = definitions.find((definition) => definition.name === 'mcp__fake__missing');
    assert.equal(unknown, undefined);
    assert.match(manager.describe(), /mcp__fake__read_note/);

    const reloaded = await manager.reload();
    assert.equal(reloaded[0].state, 'connected');
    assert.equal(manager.toolCount(), 2);
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a disabled mcp server is listed but never started', async () => {
  const manager = new McpManager({
    servers: () => ({ off: { enabled: false, transport: 'stdio', timeoutMs: 1_000 } }),
    log: silentLogger(),
  });

  const statuses = await manager.start();
  assert.equal(statuses[0].state, 'disabled');
  assert.equal(manager.toolDefinitions().length, 0);
  assert.match(manager.describe(), /off \(disabled\)/);
  await manager.stop();
});

test('a broken mcp server is reported instead of failing the service', async () => {
  const manager = new McpManager({
    servers: () => ({
      broken: {
        enabled: true,
        transport: 'stdio',
        command: 'definitely-not-a-real-binary-beecode',
        timeoutMs: 5_000,
      },
    }),
    log: silentLogger(),
  });

  try {
    const statuses = await manager.start();
    assert.equal(statuses[0].state, 'error');
    assert.ok(statuses[0].error);
    assert.equal(manager.toolDefinitions().length, 0);
  } finally {
    await manager.stop();
  }
});

test('http mcp transport parses JSON and SSE responses', async () => {
  const seen: Array<{ method: string; sessionId?: string }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: number;
        method: string;
      };
      seen.push({ method: message.method, sessionId: request.headers['mcp-session-id'] as string });

      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === 'initialize') {
        // Answer with an SSE frame, the way streamable HTTP servers may.
        response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        response.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2024-11-05', serverInfo: { name: 'http-fake', version: '1.0.0' } },
          })}\n\n`,
        );
        return;
      }
      if (message.method === 'tools/list') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'ping', description: 'Ping', annotations: { readOnlyHint: true } }] },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const client = new McpClient(
    'remote',
    { enabled: true, transport: 'http', url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 10_000 },
    silentLogger(),
  );

  try {
    await client.connect();
    assert.equal(client.info.name, 'http-fake');

    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['ping']);
    assert.equal(tools[0].readOnly, true);

    const result = await client.callTool('ping', {});
    assert.equal(result.text, 'pong');

    // The session id handed out by initialize is echoed on later calls.
    assert.equal(seen.find((entry) => entry.method === 'tools/list')?.sessionId, 'sess-1');
    assert.ok(seen.some((entry) => entry.method === 'notifications/initialized'));
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type ToolContextHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<{ content: string; failed?: boolean }>;
