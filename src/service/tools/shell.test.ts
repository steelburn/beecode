import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { defaultPolicy } from '../../shared/defaults';
import type { ToolContext, ToolDefinition } from '../../shared/tools';
import { AuditLog } from '../audit';
import { PolicyEngine } from '../policy';
import { shellTools } from './shell';

interface Harness {
  root: string;
  workspace: string;
  ctx: ToolContext;
  tools: Map<string, ToolDefinition>;
}

/** Workspace-scoped engine plus an audit log in a throwaway directory (cleaned up as a hook). */
async function harness(t: TestContext): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'bee-shell-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const audit = new AuditLog(join(root, 'audit.jsonl'));
  const policy = new PolicyEngine(defaultPolicy(), [workspace]);
  const tools = new Map(shellTools({ policy, audit }).map((tool) => [tool.name, tool]));
  const ctx: ToolContext = {
    sessionId: 'test',
    cwd: workspace,
    mode: 'act',
    workspaceRoots: [workspace],
    signal: new AbortController().signal,
    depth: 0,
  };
  t.after(async () => {
    // The audit log is flushed before the directory goes away, otherwise a pending append
    // recreates the tree and the cleanup fails.
    await audit.flush();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, ctx, tools };
}

interface ShellPayload {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function shellRun(h: Harness, command: string): Promise<ShellPayload> {
  const result = await h.tools.get('shell_run')!.handler({ command }, h.ctx);
  return JSON.parse(result.content) as ShellPayload;
}

test('shell_run keeps a quoted absolute path intact on Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('cmd.exe argument quoting only applies on Windows');
    return;
  }
  const h = await harness(t);
  const spaced = join(h.workspace, 'a dir with spaces');
  await mkdir(spaced, { recursive: true });
  await writeFile(join(spaced, 'marker.txt'), 'ok', 'utf8');

  // Node's default argv quoting used to turn this into `dir \"C:\...\"`, which cmd rejects with
  // "filename, directory name, or volume label syntax is incorrect".
  const payload = await shellRun(h, `dir "${spaced}"`);
  assert.equal(payload.stderr.trim(), '');
  assert.equal(payload.exitCode, 0);
  assert.match(payload.stdout, /marker\.txt/);
});

test('shell_run refuses a command outside the allow-list', async (t) => {
  const h = await harness(t);
  const result = await h.tools.get('shell_run')!.handler({ command: 'whoami' }, h.ctx);
  assert.equal(result.failed, true);
  assert.match(result.content, /allowed prefix/);
});
