import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { findExecutable, hasExecutable, osInstallDirs, resetExecutableCache, searchDirs } from './executables';

/**
 * The resolver exists because a packaged app inherits a truncated PATH. These tests pin the
 * two behaviours that used to break: a tool in an explicit extra directory, and a bare name
 * on Windows (PATHEXT) where `spawn('python')` needs `python.exe`.
 */

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'beecode-exe-'));
  tempDirs.push(dir);
  return dir;
}

function stub(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
  return file;
}

afterEach(() => {
  process.env.PATH = originalPath;
  resetExecutableCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('finds an executable in an explicit extra directory', () => {
  const dir = tempDir();
  stub(dir, process.platform === 'win32' ? 'beecode-probe.exe' : 'beecode-probe');
  const found = findExecutable('beecode-probe', { extraDirs: [dir] });
  assert.ok(found, 'the probe in extraDirs is found');
  assert.equal(found?.toLowerCase(), join(dir, process.platform === 'win32' ? 'beecode-probe.exe' : 'beecode-probe').toLowerCase());
});

test('finds an executable through PATH', () => {
  const dir = tempDir();
  stub(dir, process.platform === 'win32' ? 'beecode-path.cmd' : 'beecode-path');
  process.env.PATH = [dir, originalPath ?? ''].join(delimiter);
  resetExecutableCache();
  assert.ok(hasExecutable('beecode-path'));
});

test('ignores directories and unknown names', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'beecode-dir-only'), { recursive: true });
  assert.equal(findExecutable('beecode-dir-only', { extraDirs: [dir] }), undefined);
  assert.equal(findExecutable('beecode-definitely-not-installed-anywhere'), undefined);
  assert.equal(findExecutable('   '), undefined);
});

test('resolves an absolute path when one is passed', () => {
  const dir = tempDir();
  const file = stub(dir, process.platform === 'win32' ? 'beecode-abs.exe' : 'beecode-abs');
  assert.ok(findExecutable(file));
});

test('searchDirs puts extras first and only returns existing OS roots', () => {
  const dir = tempDir();
  const dirs = searchDirs([dir]);
  assert.equal(dirs[0], dir);
  // Dedupe is case-insensitive on Windows, so a root already present from PATH keeps that
  // spelling; the comparison has to follow suit.
  const seen = new Set(dirs.map((dir) => (process.platform === 'win32' ? dir.toLowerCase() : dir)));
  for (const osDir of osInstallDirs()) {
    const key = process.platform === 'win32' ? osDir.toLowerCase() : osDir;
    assert.ok(seen.has(key), `${osDir} is searchable`);
  }
});
