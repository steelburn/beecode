import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * End-to-end service test: boots the real background service against a throw-away
 * BEECODE_HOME with the mock desktop driver, exposes it over the loopback HTTP
 * transport and drives it with JSON-RPC — exactly what an external client would do.
 */
test('background service answers JSON-RPC over loopback HTTP', async () => {
  const home = await mkdtemp(join(tmpdir(), 'beecode-home-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      defaultModelId: 'claude-sonnet',
      desktop: { enabled: true, driver: 'mock', allowInput: true },
      agent: { defaultMode: 'ask', maxSteps: 4, autoApproveTools: [], workingDir: workspace },
      subagents: { enabled: true, maxConcurrent: 2, cliAgents: [] },
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

    const policy = (await rpc('policy.get')).result as { allowedApps: Array<{ id: string }> };
    assert.ok(policy.allowedApps.some((a) => a.id === 'notepad'));

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
