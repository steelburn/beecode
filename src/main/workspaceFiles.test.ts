import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyIntoWorkspace } from './workspaceFiles';

/** Real files on disk: the point of the module is what lands where, so nothing is mocked. */

const root = mkdtempSync(join(tmpdir(), 'beecode-drop-'));
const outside = mkdtempSync(join(tmpdir(), 'beecode-drop-src-'));
mkdirSync(join(root, 'docs'));

test.after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  rmSync(outside, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('copies a dropped file into the workspace and reports the relative path', async () => {
  const source = join(outside, 'report.txt');
  writeFileSync(source, 'hello');

  const result = await copyIntoWorkspace([source], root);

  assert.deepEqual(result.copied, [{ from: source, to: 'report.txt' }]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.errors, []);
});

test('copies into a subfolder and never clobbers an existing name', async () => {
  const source = join(outside, 'report.txt');
  const first = await copyIntoWorkspace([source], root, 'docs');
  const second = await copyIntoWorkspace([source], root, 'docs');

  assert.equal(first.copied[0]?.to, join('docs', 'report.txt'));
  assert.equal(second.copied[0]?.to, join('docs', 'report (2).txt'));
});

test('copies a dropped folder recursively', async () => {
  const folder = join(outside, 'bundle');
  mkdirSync(join(folder, 'inner'), { recursive: true });
  writeFileSync(join(folder, 'inner', 'a.md'), '# a');

  const result = await copyIntoWorkspace([folder], root);

  assert.equal(result.copied[0]?.to, 'bundle');
  assert.ok(existsSync(join(root, 'bundle', 'inner', 'a.md')));
});

test('skips a path that already lives in the target folder', async () => {
  const inside = join(root, 'docs', 'stay.txt');
  writeFileSync(inside, 'x');

  const result = await copyIntoWorkspace([inside], root, 'docs');

  assert.deepEqual(result.copied, []);
  assert.deepEqual(result.skipped, [inside]);
});

test('clamps a target outside the workspace back to its root', async () => {
  const source = join(outside, 'escape.txt');
  writeFileSync(source, 'x');

  const result = await copyIntoWorkspace([source], root, join('..', '..'));

  assert.equal(result.copied[0]?.to, 'escape.txt');
});

test('reports a missing path without losing the rest of the drop', async () => {
  const present = join(outside, 'kept.txt');
  writeFileSync(present, 'x');

  const result = await copyIntoWorkspace([join(outside, 'gone.txt'), present], root);

  assert.equal(result.copied.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.error ?? '', /no such file or folder/);
});

test('fails the drop when no workspace folder is set', async () => {
  const result = await copyIntoWorkspace([join(outside, 'report.txt')], '   ');

  assert.deepEqual(result.copied, []);
  assert.equal(result.errors.length, 1);
});
