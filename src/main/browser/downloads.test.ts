import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DOWNLOAD_DIR_NAME,
  downloadsDir,
  reserveDownloadPath,
  safeDownloadName,
  uniqueDownloadPath,
} from './downloads';

test('a page-chosen name cannot leave the downloads folder', () => {
  assert.equal(safeDownloadName('../../etc/passwd'), 'passwd');
  assert.equal(safeDownloadName('C:\\Windows\\system32\\evil.exe'), 'evil.exe');
  assert.equal(safeDownloadName('report:2024?.pdf'), 'report_2024_.pdf');
  assert.equal(safeDownloadName('   ...   '), 'download');
  assert.equal(safeDownloadName(''), 'download');
});

test('a long name keeps its extension', () => {
  const name = safeDownloadName(`${'a'.repeat(300)}.tar.gz`);
  assert.ok(name.length <= 120);
  assert.ok(name.endsWith('.tar.gz'));
});

test('downloads go to <workspace>/Downloads', () => {
  assert.equal(downloadsDir('D:\\work\\proj'), join('D:\\work\\proj', DOWNLOAD_DIR_NAME));
  assert.equal(downloadsDir('D:\\work\\proj').endsWith(DOWNLOAD_DIR_NAME), true);
});

test('a taken name gets the browser-style counter suffix', () => {
  const dir = join('D:', 'work', 'Downloads');
  const existing = new Set([join(dir, 'file.txt'), join(dir, 'file (1).txt')]);
  assert.equal(uniqueDownloadPath(dir, 'file.txt', (p) => existing.has(p)), join(dir, 'file (2).txt'));
  assert.equal(uniqueDownloadPath(dir, 'fresh.txt', () => false), join(dir, 'fresh.txt'));
  assert.equal(uniqueDownloadPath(dir, 'archive.tar.gz', (p) => existing.has(p)), join(dir, 'archive.tar.gz'));
});

test('no workspace means no download', () => {
  assert.equal(reserveDownloadPath(undefined, 'a.txt'), undefined);
  assert.equal(reserveDownloadPath('   ', 'a.txt'), undefined);
});

test('reserving creates the folder and never overwrites', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'beecode-dl-'));
  try {
    const first = reserveDownloadPath(workspace, 'page.html');
    assert.ok(first);
    writeFileSync(first!, '<html></html>');
    const second = reserveDownloadPath(workspace, 'page.html');
    assert.equal(second, join(workspace, DOWNLOAD_DIR_NAME, 'page (1).html'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
