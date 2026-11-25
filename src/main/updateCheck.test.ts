import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpdateChecker } from './updateCheck';
import { UPDATE_CHECK_INTERVAL_MS, type UpdateStatus } from '../shared/update';

const payload = {
  tag_name: 'v0.1.4',
  name: 'beeCode 0.1.4',
  body: 'notes',
  html_url: 'https://github.com/steelburn/beecode/releases/tag/v0.1.4',
  published_at: '2026-11-26T10:00:00Z',
  draft: false,
  prerelease: false,
  assets: [{ name: 'beeCode Setup 0.1.4.exe', size: 1000, browser_download_url: 'https://example.test/s.exe' }],
};

/** A clock and a fetch a test can move independently. */
function harness(answer: () => Promise<unknown>) {
  let clock = 1_000_000;
  let calls = 0;
  const seen: UpdateStatus[] = [];
  const checker = new UpdateChecker({
    currentVersion: '0.1.3',
    fetchJson: () => {
      calls += 1;
      return answer();
    },
    onChange: (status) => seen.push(status),
    now: () => clock,
  });
  return {
    checker,
    seen,
    get calls() {
      return calls;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

test('a newer published release becomes an available status and is announced', async () => {
  const h = harness(async () => payload);
  const status = await h.checker.check();
  assert.equal(status.state, 'available');
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0].state, 'available');
  assert.equal(h.checker.status.state, 'available');
});

test('a repeat check inside the interval answers from the last read', async () => {
  const h = harness(async () => payload);
  await h.checker.check();
  h.advance(60_000);
  await h.checker.check();
  assert.equal(h.calls, 1, 'the second check must not reach GitHub');
  h.advance(UPDATE_CHECK_INTERVAL_MS);
  await h.checker.check();
  assert.equal(h.calls, 2, 'once the interval passed the answer is asked for again');
});

test('a forced check ignores the interval — "check now" never answers from cache', async () => {
  const h = harness(async () => payload);
  await h.checker.check();
  await h.checker.check(true);
  assert.equal(h.calls, 2);
});

test('two checks at once are one request', async () => {
  let release: (value: unknown) => void = () => {};
  const gate = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const h = harness(() => gate);
  const first = h.checker.check(true);
  const second = h.checker.check(true);
  release(payload);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(h.calls, 1);
  assert.deepEqual(a, b);
});

test('a failed check does not take a known update away', async () => {
  let fail = false;
  const h = harness(async () => {
    if (fail) throw new Error('getaddrinfo ENOTFOUND api.github.com');
    return payload;
  });
  await h.checker.check();
  fail = true;
  const again = await h.checker.check(true);
  assert.equal(again.state, 'available', 'an unreachable network is not evidence of an unpublished release');
  assert.equal(h.seen.at(-1)?.state, 'available');
});

test('a failure before any success is reported as an error, and is retried rather than cached', async () => {
  let fail = true;
  const h = harness(async () => {
    if (fail) throw new Error('offline');
    return payload;
  });
  const first = await h.checker.check();
  assert.equal(first.state, 'error');
  if (first.state === 'error') assert.match(first.message, /offline/);
  fail = false;
  // A failed check must not count as fresh: the next automatic check asks again.
  const second = await h.checker.check();
  assert.equal(second.state, 'available');
});

test('a timeout says so instead of quoting the fetch internals', async () => {
  const h = harness(async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  });
  const status = await h.checker.check();
  assert.equal(status.state, 'error');
  if (status.state === 'error') assert.equal(status.message, 'the request timed out');
});

test('the running version is what the status reports, so the UI can name it', async () => {
  const h = harness(async () => ({ ...payload, tag_name: 'v0.1.3' }));
  const status = await h.checker.check();
  assert.equal(status.state, 'current');
  if (status.state === 'current') assert.equal(status.version, '0.1.3');
});
