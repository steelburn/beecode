import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceTerminal, isInsideWorkspace } from './terminal';

/**
 * These run real shell commands (`echo`, `node -e`), because the point of the module is
 * where they run and what they report — a mock would test nothing worth testing.
 */

const root = mkdtempSync(join(tmpdir(), 'beecode-terminal-'));
mkdirSync(join(root, 'sub'));

test.after(async () => {
  // A cancelled child can hold its working directory for a moment on Windows, which makes
  // the recursive remove fail with EPERM; retry briefly instead of failing the suite.
  await new Promise((done) => setTimeout(done, 300));
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** Resolve once no command is running, so assertions see the final state. */
async function waitIdle(term: WorkspaceTerminal, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (term.state.busy) {
    if (Date.now() - started > timeoutMs) throw new Error('terminal did not go idle');
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** All text the terminal holds, in order. */
function output(term: WorkspaceTerminal): string {
  return term.state.lines.map((line) => line.text).join('');
}

test('isInsideWorkspace accepts the root and folders below it only', () => {
  assert.equal(isInsideWorkspace(root, root), true);
  assert.equal(isInsideWorkspace(root, join(root, 'sub')), true);
  assert.equal(isInsideWorkspace(root, join(root, '..')), false);
  assert.equal(isInsideWorkspace(root, join(root, '..', 'elsewhere')), false);
});

test('a command runs in the workspace root and reports its output and exit code', async () => {
  const term = new WorkspaceTerminal({ root });
  term.run('echo hello');
  await waitIdle(term);
  const state = term.state;
  assert.equal(state.cwd, root);
  assert.equal(state.root, root);
  assert.equal(state.exitCode, 0);
  assert.match(output(term), /hello/);
  assert.deepEqual(state.history, ['echo hello']);
});

test('a failing command still reports its exit code instead of throwing', async () => {
  const term = new WorkspaceTerminal({ root });
  term.run('node -e "process.exit(3)"');
  await waitIdle(term);
  assert.equal(term.state.exitCode, 3);
});

test('cd moves into a subfolder and cannot climb above the workspace', async () => {
  const term = new WorkspaceTerminal({ root });
  term.run('cd sub');
  assert.equal(term.state.cwd, join(root, 'sub'));
  term.run('cd ..');
  assert.equal(term.state.cwd, root);
  term.run('cd ..');
  assert.equal(term.state.cwd, root);
  assert.match(output(term), /outside the workspace/);
});

test('cd to an absolute path outside the workspace is refused', async () => {
  const term = new WorkspaceTerminal({ root });
  term.run(`cd "${tmpdir()}"`);
  assert.equal(term.state.cwd, root);
  assert.match(output(term), /outside the workspace/);
});

test('clear drops the scrollback but keeps the working directory', async () => {
  const term = new WorkspaceTerminal({ root });
  term.run('cd sub');
  term.run('echo hello');
  await waitIdle(term);
  term.clear();
  assert.equal(term.state.lines.length, 0);
  assert.equal(term.state.cwd, join(root, 'sub'));
});

test('a second command is refused while one is running', async () => {
  const term = new WorkspaceTerminal({ root });
  term.run('node -e "setTimeout(() => {}, 5000)"');
  assert.throws(() => term.run('echo again'), /still running/);
  term.cancel();
  await waitIdle(term);
});

test('setRoot re-confines the terminal and drops the old scrollback', () => {
  const term = new WorkspaceTerminal({ root });
  term.run('echo hello');
  term.setRoot(join(root, 'sub'));
  assert.equal(term.state.root, join(root, 'sub'));
  assert.equal(term.state.cwd, join(root, 'sub'));
  assert.match(output(term), /confined to/);
  assert.ok(!output(term).includes('hello'));
});
