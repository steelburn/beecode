/**
 * Internal browser: policy + controller contract.
 *
 * These are the parts that decide *whether* the agent may touch a page. The page itself
 * lives in the Electron main process (`src/main/browser/*`), which unit tests cannot
 * instantiate, so the host is faked here: what is asserted is that a denial never reaches
 * the host, that an unhosted service refuses instead of hanging, and that the browser
 * section of an older policy document is migrated rather than silently ignored.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BrowserExecParams, HostCall } from '../../shared/browser';
import { defaultConfig, defaultPolicy } from '../../shared/defaults';
import { POLICY_DOCUMENT_VERSION } from '../../shared/protocol';
import type { BrowserConfig, PolicyDocument } from '../../shared/protocol';
import { AuditLog } from '../audit';
import { migratePolicy, PolicyEngine } from '../policy';
import { BrowserController } from './controller';

function engine(patch: (doc: PolicyDocument) => void = () => {}): PolicyEngine {
  const doc = defaultPolicy();
  patch(doc);
  return new PolicyEngine(doc, ['C:\\work\\demo']);
}

function browserOn(patch: (browser: PolicyDocument['browser']) => void = () => {}): PolicyEngine {
  return engine((doc) => {
    doc.browser.enabled = true;
    patch(doc.browser);
  });
}

test('browser policy: a disabled browser denies every action', () => {
  const denied = engine((doc) => {
    doc.browser.enabled = false;
  }).evaluateBrowser('https://example.com', 'navigate');
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /disabled by policy/);
});

test('browser policy: input actions need allowInput, navigation does not', () => {
  const policy = browserOn((browser) => {
    browser.allowInput = false;
    browser.allowAnyHost = true;
  });
  assert.equal(policy.evaluateBrowser('https://example.com', 'navigate').allowed, true);
  for (const action of ['click', 'type', 'key'] as const) {
    const decision = policy.evaluateBrowser('https://example.com', action);
    assert.equal(decision.allowed, false, action);
    assert.match(decision.reason, /allowInput/);
  }
  // Reading a page is not input.
  assert.equal(policy.evaluateBrowser('https://example.com', 'snapshot').allowed, true);
});

test('browser policy: hosts outside the allow-list are refused', () => {
  const policy = browserOn((browser) => {
    browser.allowAnyHost = false;
    browser.allowedHosts = ['example.com', '*.wikipedia.org'];
  });
  assert.equal(policy.evaluateBrowser('https://example.com/docs', 'navigate').allowed, true);
  assert.equal(policy.evaluateBrowser('https://en.wikipedia.org/wiki/X', 'navigate').allowed, true);
  assert.equal(policy.evaluateBrowser('https://other.test', 'navigate').allowed, false);
});

test('browser policy: a wildcard never matches a look-alike domain', () => {
  const policy = browserOn((browser) => {
    browser.allowAnyHost = false;
    browser.allowedHosts = ['*.github.com'];
  });
  assert.equal(policy.evaluateBrowser('https://gist.github.com/x', 'navigate').allowed, true);
  // A wildcard covers the apex itself ...
  assert.equal(policy.evaluateBrowser('https://github.com/', 'navigate').allowed, true);
  // ... but a look-alike domain is a different registrable name: `evil-github.com` ends
  // with "-github.com", never with ".github.com".
  assert.equal(policy.evaluateBrowser('https://evil-github.com/', 'navigate').allowed, false);
});

test('browser policy: blocked hosts win over the allow-list and non-http schemes are refused', () => {
  const policy = browserOn((browser) => {
    browser.allowAnyHost = true;
    browser.deniedHosts = ['*.bank.example'];
  });
  const blocked = policy.evaluateBrowser('https://my.bank.example/login', 'navigate');
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /denied host/);

  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi']) {
    const decision = policy.evaluateBrowser(url, 'navigate');
    assert.equal(decision.allowed, false, url);
  }
});

test('browser policy: an empty tab is always permitted and approval follows the config', () => {
  const policy = browserOn((browser) => {
    browser.allowAnyHost = true;
    browser.requireApproval = true;
  });
  assert.equal(policy.evaluateBrowser('about:blank', 'navigate').allowed, true);
  const decision = policy.evaluateBrowser('https://example.com', 'navigate');
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test('migratePolicy fills the browser section of an older document', () => {
  const stale = defaultPolicy();
  const legacy = { ...stale, version: POLICY_DOCUMENT_VERSION - 1 } as Partial<PolicyDocument>;
  delete legacy.browser;

  const migrated = migratePolicy(legacy as PolicyDocument);
  assert.equal(migrated.version, POLICY_DOCUMENT_VERSION);
  assert.ok(migrated.browser);
  assert.equal(migrated.browser.enabled, defaultPolicy().browser.enabled);
  assert.equal(migrated.browser.requireApproval, defaultPolicy().browser.requireApproval);
});

test('controller: without a host every action is refused instead of hanging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-browser-'));
  try {
    const controller = new BrowserController({
      policy: browserOn((browser) => {
        browser.allowAnyHost = true;
      }),
      audit: new AuditLog(join(dir, 'audit.jsonl')),
      config: () => ({ ...defaultConfig().browser, enabled: true }) as BrowserConfig,
      host: () => undefined,
    });
    assert.equal(controller.available().available, false);
    const result = await controller.exec('s1', 'browser_open', { action: 'open', url: 'https://example.com' });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /only available in the desktop app/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('controller: a policy denial never reaches the host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-browser-'));
  try {
    let calls = 0;
    const host: HostCall = async () => {
      calls += 1;
      return { ok: true, action: 'navigate' };
    };
    const controller = new BrowserController({
      policy: browserOn((browser) => {
        browser.allowAnyHost = false;
        browser.allowedHosts = ['example.com'];
      }),
      audit: new AuditLog(join(dir, 'audit.jsonl')),
      config: () => ({ ...defaultConfig().browser, enabled: true }) as BrowserConfig,
      host: () => host,
    });

    const denied = await controller.exec('s1', 'browser_open', { action: 'open', url: 'https://other.test' });
    assert.equal(denied.ok, false);
    assert.equal(calls, 0);
    assert.match(String(denied.error), /denied by policy/);

    const allowed = await controller.exec('s1', 'browser_open', { action: 'open', url: 'https://example.com' });
    assert.equal(allowed.ok, true);
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('controller: an interaction is judged against the page the tab is on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-browser-'));
  try {
    const seen: string[] = [];
    const host: HostCall = async (_method, params) => {
      const exec = params as BrowserExecParams;
      seen.push(exec.action);
      return exec.action === 'tabs'
        ? {
            ok: true,
            action: 'tabs',
            state: {
              visible: true,
              middleClickClosesTabs: true,
              tabs: [{ id: 'tab-1', url: 'https://blocked.test/', title: 'Blocked', loading: false, active: true }],
              activeTabId: 'tab-1',
              cursor: { enabled: true },
            },
          }
        : { ok: true, action: exec.action };
    };
    const controller = new BrowserController({
      policy: browserOn((browser) => {
        browser.allowAnyHost = false;
        browser.allowedHosts = ['example.com'];
      }),
      audit: new AuditLog(join(dir, 'audit.jsonl')),
      config: () => ({ ...defaultConfig().browser, enabled: true }) as BrowserConfig,
      host: () => host,
    });

    // The click's policy target is resolved from the tab's current URL (probed once via a
    // `tabs` request), so an already-open disallowed page cannot be clicked.
    const click = await controller.exec('s1', 'browser_click', { action: 'click', ref: 'e1' });
    assert.equal(click.ok, false);
    assert.match(String(click.error), /denied by policy/);
    assert.deepEqual(seen, ['tabs']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
