import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paintUpdateBadge, updateSectionText } from './updateBadge';
import type { UpdateRelease, UpdateStatus } from '../shared/update';

const release: UpdateRelease = {
  version: '0.1.4',
  tag: 'v0.1.4',
  name: 'beeCode 0.1.4',
  notes: '',
  url: 'https://github.com/steelburn/beecode/releases/tag/v0.1.4',
  publishedAt: '2026-11-26T10:00:00Z',
  asset: { name: 'beeCode Setup 0.1.4.exe', size: 126_900_581, url: 'https://example.test/s.exe' },
};

const available: UpdateStatus = { state: 'available', checkedAt: 1, version: '0.1.3', release };
const current: UpdateStatus = { state: 'current', checkedAt: 1, version: '0.1.3', latest: '0.1.3' };

test('the badge appears only when there is something to install', () => {
  const badge = { hidden: false, textContent: '', title: '' };
  paintUpdateBadge(badge, available);
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '↑ 0.1.4');
  assert.match(badge.title, /0\.1\.4 is available/);

  paintUpdateBadge(badge, current);
  assert.equal(badge.hidden, true, 'an up-to-date app must not keep a badge in the rail');
  assert.equal(badge.textContent, '');

  paintUpdateBadge(badge, { state: 'error', checkedAt: 1, version: '0.1.3', message: 'offline' });
  assert.equal(badge.hidden, true, 'a check that failed must not nag from the chrome');

  paintUpdateBadge(badge, { state: 'idle' });
  assert.equal(badge.hidden, true);
});

test('the settings row names the running version and the published one', () => {
  assert.equal(updateSectionText(available, '0.1.3').note, 'beeCode 0.1.3 · 0.1.4 is available (121.0 MB)');
  assert.equal(updateSectionText(available, '0.1.3').download, 'Download 0.1.4');
  assert.equal(updateSectionText(current, '0.1.3').note, 'beeCode 0.1.3 · up to date (latest published: 0.1.3)');
  assert.equal(updateSectionText(current, '0.1.3').download, undefined);
  assert.equal(
    updateSectionText({ state: 'error', checkedAt: 1, version: '0.1.3', message: 'offline' }, '0.1.3').note,
    'beeCode 0.1.3 · Could not check for updates: offline',
  );
  assert.equal(updateSectionText({ state: 'idle' }, '0.1.3').note, 'beeCode 0.1.3 · updates have not been checked yet');
});
