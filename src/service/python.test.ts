import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { resetExecutableCache } from './executables';
import {
  bundledPython,
  childEnvironment,
  pythonRuntime,
  pythonSummary,
  pythonVersion,
  resetPythonRuntime,
  toolPathDirs,
} from './python';

/**
 * A vendored runtime is optional (CI does not download it), so every test builds its own
 * fake "bundled" home through BEECODE_PYTHON_HOME and resets the memo afterwards.
 */

const tempDirs: string[] = [];
const originalEnv = { home: process.env.BEECODE_PYTHON_HOME, path: process.env.PATH };

function fakeBundledHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'beecode-py-'));
  tempDirs.push(dir);
  const home = process.platform === 'win32' ? dir : join(dir, 'bin');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, process.platform === 'win32' ? 'python.exe' : 'python3'), '', 'utf8');
  return dir;
}

afterEach(() => {
  if (originalEnv.home === undefined) delete process.env.BEECODE_PYTHON_HOME;
  else process.env.BEECODE_PYTHON_HOME = originalEnv.home;
  process.env.PATH = originalEnv.path;
  resetPythonRuntime();
  resetExecutableCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a bundled runtime is preferred over the machine interpreter', () => {
  const home = fakeBundledHome();
  process.env.BEECODE_PYTHON_HOME = home;
  resetPythonRuntime();

  const runtime = bundledPython();
  assert.ok(runtime, 'the override directory is treated as a bundled runtime');
  assert.equal(runtime?.bundled, true);
  assert.equal(pythonRuntime()?.home, runtime?.home);
  assert.equal(toolPathDirs()[0], runtime?.home);
});

test('childEnvironment leads PATH with the bundled runtime and keeps the inherited entries', () => {
  const home = fakeBundledHome();
  process.env.BEECODE_PYTHON_HOME = home;
  resetPythonRuntime();

  const env = childEnvironment({ PATH: ['C:\\inherited', '/usr/inherited'].join(delimiter) });
  const dirs = (env.PATH ?? '').split(delimiter);
  assert.equal(dirs[0], toolPathDirs()[0]);
  assert.ok(dirs.includes('C:\\inherited'));
  assert.ok(dirs.includes('/usr/inherited'));
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  // A stale PYTHONHOME/PYTHONPATH would point the packed interpreter at another tree.
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  // ...and the machine's per-user site-packages would shadow the bundled pip.
  assert.equal(env.PYTHONNOUSERSITE, '1');
  // No duplicates: every entry appears once.
  assert.equal(new Set(dirs).size, dirs.length);
});

test('pythonSummary reports the runtime the shell tool will get', () => {
  const home = fakeBundledHome();
  process.env.BEECODE_PYTHON_HOME = home;
  resetPythonRuntime();
  const summary = pythonSummary();
  assert.match(summary, /bundled with beeCode/);
  // The prompt tells the model what to do with it, so pip and venv must be advertised.
  assert.match(summary, /pip/);
  assert.match(summary, /venv/);
});

test('the vendored interpreter answers "-V" through childEnvironment', (t) => {
  delete process.env.BEECODE_PYTHON_HOME;
  resetPythonRuntime();
  const runtime = bundledPython();
  if (!runtime) {
    t.skip('no vendored runtime in this checkout (npm run python:fetch)');
    return;
  }
  assert.ok(pythonVersion(), 'the interpreter reports a version');
  const run = spawnSync('python', ['-c', 'import json;print(json.dumps({"ok": True}))'], {
    env: childEnvironment(),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { ok: true });
});

test('the vendored runtime builds a venv whose pip works', (t) => {
  delete process.env.BEECODE_PYTHON_HOME;
  resetPythonRuntime();
  const runtime = bundledPython();
  if (!runtime) {
    t.skip('no vendored runtime in this checkout (npm run python:fetch)');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'beecode-venv-'));
  tempDirs.push(dir);
  const venv = join(dir, '.venv');
  // `venv` bootstraps pip from the ensurepip wheel inside the payload, so this needs no network:
  // an embeddable distribution fails this call outright ("ensurepip is not available").
  const made = spawnSync('python', ['-m', 'venv', venv], {
    env: childEnvironment(),
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  assert.equal(made.status, 0, made.stderr);

  const pythonPath = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  const report = spawnSync(pythonPath, ['-m', 'pip', '--version'], {
    env: { ...process.env, PYTHONNOUSERSITE: '1' },
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /^pip \d+\.\d+/);
  // The venv must see its own site-packages, not the base interpreter's.
  assert.match(report.stdout, /\.venv/i);
});

test('the vendored payload ships venv, ensurepip and pip, with shims that quote only the interpreter', (t) => {
  delete process.env.BEECODE_PYTHON_HOME;
  resetPythonRuntime();
  const runtime = bundledPython();
  if (!runtime) {
    t.skip('no vendored runtime in this checkout (npm run python:fetch)');
    return;
  }

  // The payload itself is gitignored, so these assertions are the committed proof that the
  // script vendors a *full* distribution: an embeddable zip has neither Lib\venv nor
  // Lib\ensurepip, so `python -m venv` would fail here instead of at a user's machine.
  for (const rel of ['Lib/venv/__init__.py', 'Lib/ensurepip/_bundled', 'Lib/site-packages/pip']) {
    assert.ok(existsSync(join(runtime.home, rel)), `${rel} is part of the payload`);
  }
  assert.ok(existsSync(join(runtime.home, 'LICENSE.txt')), 'the licence travels with the runtime');

  if (process.platform !== 'win32') return;
  const shims: Array<[string, string]> = [
    ['python3.cmd', ''],
    ['py.cmd', ''],
    ['pip.cmd', '-m pip '],
    ['pip3.cmd', '-m pip '],
  ];
  for (const [name, args] of shims) {
    const written: string = readFileSync(join(runtime.home, name), 'utf8');
    // Only the interpreter path may be quoted: `"%~dp0python.exe -m pip" %*` made cmd look for a
    // file named after the whole command line, so every shim died with "not recognized".
    assert.equal(written, `@echo off\r\n"%~dp0python.exe" ${args}%*\r\n`, `${name} shim`);
  }
});
