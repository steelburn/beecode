import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RELEASES_PAGE_URL,
  compareVersions,
  evaluateRelease,
  formatUpdateSize,
  isNewerVersion,
  parseVersion,
  readLatestRelease,
  updateBadgeLabel,
  updateDownloadUrl,
  updateNotice,
} from './update';

const release = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v0.1.4',
  name: 'beeCode 0.1.4',
  body: 'Install notes.',
  html_url: 'https://github.com/steelburn/beecode/releases/tag/v0.1.4',
  published_at: '2026-11-26T10:00:00Z',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'beeCode Setup 0.1.4.exe', size: 126_900_581, browser_download_url: 'https://example.test/setup.exe' },
    { name: 'beeCode Setup 0.1.4.exe.blockmap', size: 1024, browser_download_url: 'https://example.test/setup.exe.blockmap' },
  ],
  ...overrides,
});

test('a version tag is read with or without the v and is normalised', () => {
  assert.deepEqual(parseVersion('v0.1.3'), { parts: [0, 1, 3], prerelease: '' });
  assert.deepEqual(parseVersion(' 0.1.3 '), { parts: [0, 1, 3], prerelease: '' });
  assert.deepEqual(parseVersion('1.10.0-rc.2'), { parts: [1, 10, 0], prerelease: 'rc.2' });
  assert.deepEqual(parseVersion('1.2.3+build.7'), { parts: [1, 2, 3], prerelease: '' });
});

test('a tag that is not a version is not silently treated as one', () => {
  // The important half: 'latest' or '' must not compare as newer than anything.
  for (const text of ['latest', '', 'v0.1', '0.1.3.4', 'release-2026', 'x.y.z']) {
    assert.equal(parseVersion(text), null, text);
  }
});

test('versions compare numerically, not as text', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v0.1.3', '0.1.3'), 0);
  assert.equal(compareVersions('0.1.2', '0.1.3'), -1);
});

test('a prerelease sorts below its release and an unreadable version is never newer', () => {
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0'), -1);
  assert.equal(compareVersions('0.2.0', '0.2.0-rc.1'), 1);
  assert.equal(compareVersions('nonsense', '0.1.3'), 0);
  assert.equal(isNewerVersion('nonsense', '0.1.3'), false);
});

test('the same or an older version is not an update', () => {
  assert.equal(isNewerVersion('0.1.3', '0.1.3'), false);
  assert.equal(isNewerVersion('0.1.2', '0.1.3'), false);
  assert.equal(isNewerVersion('0.1.4', '0.1.3'), true);
});

test('a release is read into the shape the UI renders, installer picked over side files', () => {
  const read = readLatestRelease(release());
  assert.ok(read);
  assert.equal(read.version, '0.1.4');
  assert.equal(read.tag, 'v0.1.4');
  assert.equal(read.name, 'beeCode 0.1.4');
  // `.blockmap` is not an installer even though it ends in neither `.exe` nor anything else.
  assert.equal(read.asset?.name, 'beeCode Setup 0.1.4.exe');
  assert.equal(read.asset?.size, 126_900_581);
});

test('drafts, prereleases and unreadable payloads are refused', () => {
  assert.equal(readLatestRelease(release({ draft: true })), null);
  assert.equal(readLatestRelease(release({ prerelease: true })), null);
  assert.equal(readLatestRelease(release({ tag_name: 'nightly' })), null);
  assert.equal(readLatestRelease(null), null);
  assert.equal(readLatestRelease('{}'), null);
  assert.equal(readLatestRelease([]), null);
});

test('a release without an installer falls back to the release page', () => {
  const read = readLatestRelease(release({ assets: [] }));
  assert.ok(read);
  assert.equal(read.asset, null);
  assert.equal(updateDownloadUrl({ state: 'available', checkedAt: 1, version: '0.1.3', release: read }), read.url);
  const noUrl = readLatestRelease(release({ assets: [], html_url: 'javascript:alert(1)' }));
  assert.equal(noUrl?.url, RELEASES_PAGE_URL);
});

test('a newer release is reported as available, the same one as current', () => {
  const available = evaluateRelease(release(), '0.1.3', 1000);
  assert.equal(available.state, 'available');
  assert.equal(available.checkedAt, 1000);
  if (available.state === 'available') assert.equal(available.release.version, '0.1.4');

  const current = evaluateRelease(release(), '0.1.4', 1000);
  assert.equal(current.state, 'current');
  if (current.state === 'current') assert.equal(current.latest, '0.1.4');

  // A dev tree ahead of the published release is not behind it.
  assert.equal(evaluateRelease(release(), '0.1.5', 1000).state, 'current');
});

test('an unreadable payload becomes an error status, never a fake update', () => {
  const status = evaluateRelease({ message: 'Not Found' }, '0.1.3', 1000);
  assert.equal(status.state, 'error');
  if (status.state === 'error') assert.match(status.message, /could not be read/);
});

test('the notice names the version and the installer size, and stays silent otherwise', () => {
  const available = evaluateRelease(release(), '0.1.3', 1000);
  assert.equal(updateNotice(available), 'beeCode 0.1.4 is available — download the 121.0 MB installer');
  assert.equal(updateBadgeLabel(available), '↑ 0.1.4');
  assert.equal(updateNotice({ state: 'idle' }), undefined);
  assert.equal(updateBadgeLabel({ state: 'current', checkedAt: 1, version: '0.1.3', latest: '0.1.3' }), undefined);
  assert.match(updateNotice({ state: 'error', checkedAt: 1, version: '0.1.3', message: 'offline' }) ?? '', /offline/);
});

test('a size is shown in the unit a person reads', () => {
  assert.equal(formatUpdateSize(126_900_581), '121.0 MB');
  assert.equal(formatUpdateSize(2048), '2 KB');
  assert.equal(formatUpdateSize(0), '');
});
