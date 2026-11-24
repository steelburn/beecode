import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SHELL_RUNTIMES, defaultPolicy } from '../shared/defaults';
import { POLICY_DOCUMENT_VERSION } from '../shared/protocol';
import type { DesktopAction } from '../shared/protocol';
import { migratePolicy, PolicyEngine } from './policy';

async function engine(): Promise<PolicyEngine> {
  const policy = new PolicyEngine(defaultPolicy(), ['C:\\work\\demo']);
  return policy;
}

test('migratePolicy widens a curated rule with the actions added since it was written', () => {
  const stale = defaultPolicy();
  const calc = stale.allowedApps.find((r) => r.id === 'calculator');
  assert.ok(calc);
  // A policy written by the build that predates desktop_click / desktop_resize.
  const older = {
    ...stale,
    version: POLICY_DOCUMENT_VERSION - 1,
    allowedApps: stale.allowedApps.map((r) =>
      r.id === 'calculator'
        ? { ...r, actions: r.actions.filter((a) => a !== 'click' && a !== 'resize') }
        : r,
    ),
  };
  const migrated = migratePolicy(older);
  const after = migrated.allowedApps.find((r) => r.id === 'calculator');
  assert.ok(after);
  assert.ok(after.actions.includes('click'));
  assert.ok(after.actions.includes('resize'));
  assert.equal(migrated.version, POLICY_DOCUMENT_VERSION);
});

test('migratePolicy never widens a repointed or hand-written rule', () => {
  const stale = defaultPolicy();
  const calc = stale.allowedApps.find((r) => r.id === 'calculator');
  assert.ok(calc);
  const older = {
    ...stale,
    version: POLICY_DOCUMENT_VERSION - 1,
    allowedApps: [
      // Same id, different executable: the curated grant no longer describes this app.
      { ...calc, exe: ['something-else.exe'], actions: ['read'] as DesktopAction[] },
      { id: 'mine', name: 'Mine', exe: ['mine.exe'], actions: ['read'] as DesktopAction[] },
    ],
  };
  const migrated = migratePolicy(older);
  const repointed = migrated.allowedApps.find((r) => r.id === 'calculator');
  assert.deepEqual(repointed?.actions, ['read']);
  assert.deepEqual(migrated.allowedApps.find((r) => r.id === 'mine')?.actions, ['read']);
});

test('migratePolicy is a no-op for a current document', () => {
  const current = defaultPolicy();
  assert.equal(migratePolicy(current), current);
});

test('denies an application that is not on the permissible list', async () => {
  const policy = await engine();
  const decision = policy.evaluateDesktop('focus', { appId: 'excel' });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not in the permissible-application list/);
});

test('allows a permitted action and flags approval when the app is not auto-approved', async () => {
  const policy = await engine();
  const allowed = policy.evaluateDesktop('focus', { appId: 'paint' });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.requiresApproval, true);

  const autoApproved = policy.evaluateDesktop('focus', { appId: 'notepad' });
  assert.equal(autoApproved.allowed, true);
  assert.equal(autoApproved.requiresApproval, false);
});

test('denies an action the app rule does not include', async () => {
  const policy = await engine();
  // explorer is read-only in the default policy
  const decision = policy.evaluateDesktop('type', { appId: 'explorer' });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not permitted for "explorer"/);
});

test('denied executables win over an app rule', async () => {
  const policy = await engine();
  const p = policy.get();
  p.allowedApps.push({ id: 'shell', name: 'Shell', exe: ['cmd.exe'], actions: ['launch'] });
  const decision = policy.evaluateDesktop('launch', { appId: 'shell', exe: 'cmd.exe' });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /denied-executable/);
});

test('process image must match the app rule', async () => {
  const policy = await engine();
  const decision = policy.evaluateDesktop('read', { appId: 'notepad', exe: 'evil.exe' });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /does not match app rule/);
});

test('launch requires an absolute path that matches the rule', async () => {
  const policy = await engine();
  const rule = policy.findApp('notepad')!;
  assert.equal(policy.evaluateLaunch(rule, 'notepad.exe').allowed, false);
  assert.equal(policy.evaluateLaunch(rule, 'C:\\Windows\\notepad.exe').allowed, true);
  assert.equal(policy.evaluateLaunch(rule, 'C:\\Windows\\System32\\cmd.exe').allowed, false);
});

test('shell policy refuses blocked patterns and non-allow-listed prefixes', async () => {
  const policy = await engine();
  assert.equal(policy.evaluateShell('git status').allowed, true);
  assert.equal(policy.evaluateShell('format c:').allowed, false);
  assert.equal(policy.evaluateShell('npm install electron').allowed, false);
  assert.equal(policy.evaluateShell('git status && rm -rf /').allowed, false);
});

test('the bundled Python is allowed by default, also when named by absolute path', async () => {
  const policy = await engine();
  assert.equal(policy.evaluateShell('python --version').allowed, true);
  assert.equal(policy.evaluateShell('python -c "print(1)"').allowed, true);
  // venv + pip are the point of the bundled runtime.
  assert.equal(policy.evaluateShell('python -m venv .venv').allowed, true);
  assert.equal(policy.evaluateShell('python -m pip install requests').allowed, true);
  assert.equal(policy.evaluateShell('py -3 script.py').allowed, true);
  assert.equal(policy.evaluateShell('pip install requests').allowed, true);
  assert.equal(
    policy.evaluateShell('"C:\\Program Files\\beeCode\\resources\\python\\python.exe" -V').allowed,
    true,
  );
  // ...but a full path must not launder a blocked binary.
  assert.equal(
    policy.evaluateShell('"C:\\Windows\\System32\\curl.exe" -s https://example.com').allowed,
    false,
  );
});

test('filesystem policy keeps tools inside the workspace', async () => {
  const policy = await engine();
  assert.equal(policy.evaluateFile('C:\\work\\demo\\notes.txt', false).allowed, true);
  assert.equal(policy.evaluateFile('C:\\work\\demo\\..\\secrets.txt', false).allowed, false);
  assert.equal(policy.evaluateFile('C:\\Windows\\win.ini', false).allowed, false);
});

test('a session working directory is allowed as an extra file root for that call only', async () => {
  const policy = await engine();
  assert.equal(policy.evaluateFile('C:\\other\\proj\\notes.txt', false).allowed, false);
  assert.equal(policy.evaluateFile('C:\\other\\proj\\notes.txt', false, ['C:\\other\\proj']).allowed, true);
  assert.equal(policy.evaluateFile('C:\\other\\proj\\..\\..\\Windows\\win.ini', false, ['C:\\other\\proj']).allowed, false);
  // the extra root does not leak into the next call
  assert.equal(policy.evaluateFile('C:\\other\\proj\\notes.txt', false).allowed, false);
});

test('policy round-trips through disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-policy-'));
  try {
    const file = join(dir, 'policy.json');
    const policy = await engine();
    policy.set({ ...defaultPolicy(), allowedApps: [] });
    await policy.save(file);

    const reloaded = new PolicyEngine(defaultPolicy(), ['C:\\work\\demo']);
    await reloaded.load(file);
    assert.equal(reloaded.get().allowedApps.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('a policy.json written before version 4 gains the bundled runtimes on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bee-policy-migrate-'));
  const file = join(dir, 'policy.json');
  try {
    const stale = defaultPolicy();
    // Exactly what the pre-v4 build wrote: no python/py/pip prefixes, and this user had removed
    // `dir` from the list on purpose.
    const older = {
      ...stale,
      version: POLICY_DOCUMENT_VERSION - 1,
      shell: {
        ...stale.shell,
        allowedCommands: stale.shell.allowedCommands.filter(
          (command) => !DEFAULT_SHELL_RUNTIMES.includes(command) && command !== 'dir',
        ),
      },
    };
    await writeFile(file, JSON.stringify(older, null, 2), 'utf8');

    const policy = new PolicyEngine(defaultPolicy(), ['C:\\work\\demo']);
    await policy.load(file);

    // The interpreter beeCode ships is usable straight after an upgrade.
    assert.equal(policy.evaluateShell('python --version').allowed, true);
    assert.equal(policy.evaluateShell('python -m venv .venv').allowed, true);
    assert.equal(policy.evaluateShell('pip install requests').allowed, true);
    // Not a blanket re-seed: a prefix the user removed stays removed.
    assert.equal(policy.evaluateShell('dir').allowed, false);

    // The migration is written back, so the file stops claiming to be the old version and is not
    // re-migrated on every start.
    const rewritten = JSON.parse(await readFile(file, 'utf8')) as { version: number };
    assert.equal(rewritten.version, POLICY_DOCUMENT_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
