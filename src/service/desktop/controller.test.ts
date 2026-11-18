import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultPolicy } from '../../shared/defaults';
import { AuditLog } from '../audit';
import { PolicyEngine } from '../policy';
import { DesktopController, DesktopDeniedError } from './controller';
import { MockDriver } from './mockDriver';

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-desktop-'));
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const policy = new PolicyEngine(defaultPolicy(), [dir]);
  const controller = new DesktopController(policy, audit, { allowInput: true, driver: 'mock' });
  return {
    dir,
    audit,
    policy,
    controller,
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

test('listWindows marks permissible apps and their actions', async () => {
  const { controller, cleanup } = await harness();
  try {
    const windows = await controller.listWindows();
    assert.equal(windows.length, 1);
    assert.equal(windows[0]?.appId, 'notepad');
    assert.equal(windows[0]?.permitted, true);
    assert.ok(windows[0]?.actions.includes('type'));
  } finally {
    await cleanup();
  }
});

test('unknown app never reaches the driver', async () => {
  const { controller, cleanup } = await harness();
  try {
    await assert.rejects(() => controller.focus({ app: 'excel' }), DesktopDeniedError);
  } finally {
    await cleanup();
  }
});

test('typing into a permitted app works and is audited', async () => {
  const { controller, audit, cleanup } = await harness();
  try {
    const window = await controller.typeText({ app: 'notepad' }, 'hello beeCode');
    assert.equal(window.exe, 'notepad.exe');
    const tree = await controller.read({ app: 'notepad' });
    const editor = tree.nodes.find((n) => n.automationId === 'Editor');
    assert.equal(editor?.value, 'hello beeCode');

    const entries = await audit.recent(10);
    assert.ok(entries.some((e) => e.action === 'type' && e.outcome === 'allowed' && e.app === 'notepad'));
  } finally {
    await cleanup();
  }
});

test('an action missing from the app rule is refused', async () => {
  const { controller, policy, cleanup } = await harness();
  try {
    // Restrict the seeded notepad window to focus/read only, then try to type into it.
    const draft = policy.get();
    draft.allowedApps = draft.allowedApps.map((app) =>
      app.id === 'notepad' ? { ...app, actions: ['focus', 'read'], autoApprove: false } : app,
    );
    await assert.rejects(() => controller.typeText({ app: 'notepad' }, 'nope'), DesktopDeniedError);
    // ...while the permitted actions still work.
    const focused = await controller.focus({ app: 'notepad' });
    assert.equal(focused.exe, 'notepad.exe');
  } finally {
    await cleanup();
  }
});

test('allowInput=false blocks synthetic input entirely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-desktop-'));
  try {
    const policy = new PolicyEngine(defaultPolicy(), [dir]);
    const controller = new DesktopController(policy, new AuditLog(join(dir, 'audit.jsonl')), {
      allowInput: false,
      driver: 'mock',
    });
    await assert.rejects(() => controller.typeText({ app: 'notepad' }, 'x'), DesktopDeniedError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('launching resolves the executable and reports a pid', async () => {
  const { controller, cleanup } = await harness();
  try {
    const res = await controller.launch('notepad');
    assert.match(res.exe.toLowerCase(), /notepad\.exe$/);
    assert.equal(typeof res.processId, 'number');
  } finally {
    await cleanup();
  }
});

test('denied window actions are recorded as denials in the audit log', async () => {
  const { controller, audit, cleanup } = await harness();
  try {
    await assert.rejects(() => controller.focus({ app: 'msedge' }), DesktopDeniedError);
    const entries = await audit.recent(5);
    assert.ok(entries.some((e) => e.outcome === 'denied'));
  } finally {
    await cleanup();
  }
});

test('mock driver implements the screenshot contract', async () => {
  const { controller, cleanup } = await harness();
  try {
    const shot = await controller.screenshot({ app: 'notepad' });
    assert.ok(shot.png.length > 20);
    assert.equal(typeof shot.width, 'number');
  } finally {
    await cleanup();
  }
});

test('MockDriver is the driver used when the platform is not Windows or mock is configured', async () => {
  const { controller, cleanup } = await harness();
  try {
    assert.equal(controller.driver instanceof MockDriver, true);
    assert.equal(controller.driverName, 'mock');
  } finally {
    await cleanup();
  }
});

test('clicking inside a permitted window reaches the driver and is audited', async () => {
  const { controller, audit, cleanup } = await harness();
  try {
    const res = await controller.click({ app: 'notepad' }, 150, 140);
    assert.deepEqual(res.point, { x: 150, y: 140 });
    assert.equal(res.window.title.length > 0, true);
    const entries = await audit.recent(10);
    assert.ok(entries.some((e) => e.action === 'click' && e.outcome === 'allowed'));
  } finally {
    await cleanup();
  }
});

test('a click outside the window frame never reaches the desktop', async () => {
  const { controller, cleanup } = await harness();
  try {
    // The mock notepad sits at 100,100 with 800x600: 5,5 is another application's pixels.
    await assert.rejects(() => controller.click({ app: 'notepad' }, 5, 5), /outside/);
  } finally {
    await cleanup();
  }
});

test('resizing clamps to the supported range and reports the applied size', async () => {
  const { controller, audit, cleanup } = await harness();
  try {
    const sized = await controller.resize({ app: 'notepad' }, 1024, 768);
    assert.deepEqual(sized.size, { width: 1024, height: 768 });
    const tiny = await controller.resize({ app: 'notepad' }, 10, 10);
    assert.deepEqual(tiny.size, { width: 200, height: 120 });
    const entries = await audit.recent(10);
    assert.ok(entries.some((e) => e.action === 'resize' && e.outcome === 'allowed'));
  } finally {
    await cleanup();
  }
});
