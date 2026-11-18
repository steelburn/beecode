import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultPolicy } from '../../shared/defaults';
import { AuditLog } from '../audit';
import { PolicyEngine } from '../policy';
import { DesktopController } from './controller';
import { MockDriver } from './mockDriver';
import { BOUNDS_LIMIT, type WindowInfo } from './types';

const HAIKU =
  'Silent threads awake,\nworking while the screen sleeps on —\nno one thanks the clock.';

const CAPTURABLE = {
  isVisible: true,
  isMinimized: false,
  isCloaked: false,
  isOffscreen: false,
  bounds: { x: 100, y: 100, width: 800, height: 600 },
} satisfies Partial<WindowInfo>;

/**
 * These tests pin the property the original failure broke: a window has ONE identity that
 * every call agrees on, mutations are provable by read-back, and anything that cannot be
 * observed is an error instead of a plausible-looking success.
 */
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-observe-'));
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const policy = new PolicyEngine(defaultPolicy(), [dir]);
  const controller = new DesktopController(policy, audit, { allowInput: true, driver: 'mock' });
  const mock = controller.driver as MockDriver;
  return {
    controller,
    mock,
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

/** The window a launch reported — asserted present, so the rest of a test can index it. */
async function launchNotepad(controller: DesktopController): Promise<{ handle: string; pid: number }> {
  const launched = await controller.launch('notepad');
  const window = launched.window;
  assert.ok(window, 'launch must name the window that owns the document');
  return { handle: window.handle, pid: window.processId };
}

test('one identity: launch -> listWindows -> focus -> uiTree -> screenshot agree', async () => {
  const { controller, cleanup } = await harness();
  try {
    const { handle, pid } = await launchNotepad(controller);

    const listed = await controller.listWindows();
    const same = listed.find((w) => w.handle === handle);
    assert.ok(same, 'the handle from launch must appear in listWindows');
    assert.equal(same.processId, pid);
    assert.equal(same.exe, 'notepad.exe');

    const focused = await controller.focus({ handle });
    assert.equal(focused.handle, handle, 'focus must not re-resolve to another window');

    const tree = await controller.read({ handle });
    assert.equal(tree.window.handle, handle, 'ui_tree must report the window it read');
    assert.equal(tree.window.processId, pid);
    assert.ok(tree.nodes.length > 1, 'a real tree has more than the root node');

    const shot = await controller.screenshot({ handle });
    assert.equal(shot.handle, handle);
    assert.equal(shot.source, 'window', 'captures are window-scoped, never a screen region');
    assert.equal(shot.window.handle, handle);
  } finally {
    await cleanup();
  }
});

test('an app name stays bound to the window it first resolved to', async () => {
  const { controller, mock, cleanup } = await harness();
  try {
    const { handle } = await launchNotepad(controller);

    // A rename must not make later `app` calls drift to whatever is titled "Notepad".
    mock.simulate(handle, { title: 'renamed by the test' });
    const again = await controller.focus({ app: 'notepad' });
    assert.equal(again.handle, handle);
  } finally {
    await cleanup();
  }
});

test('launch reports a live window, and a tab handoff is not a new window', async () => {
  const { controller, cleanup } = await harness();
  try {
    const running = await launchNotepad(controller);
    const second = await controller.launch('notepad');
    const window = second.window;
    assert.ok(window, 'a handoff launch still names the live window');

    assert.notEqual(
      second.spawnerProcessId,
      window.processId,
      'launch must report the window process, not the process it spawned',
    );
    assert.equal(second.windowCreated, false);
    assert.equal(second.tabAdded, true);
    assert.equal(window.handle, running.handle);
    assert.equal(window.processId, running.pid);
  } finally {
    await cleanup();
  }
});

test('typing is provable: the read-back grows by exactly the typed text', async () => {
  const { controller, cleanup } = await harness();
  try {
    const typed = await controller.typeText({ app: 'notepad' }, HAIKU);
    assert.equal(typed.result.typed, HAIKU.length, 'every character must be reported delivered');
    assert.equal(typed.result.verified, true, 'the mock exposes a document, so this is verifiable');
    assert.equal(typed.result.delta, HAIKU.length);
    assert.equal(
      typed.result.lengthAfter,
      typed.result.lengthBefore === undefined ? undefined : typed.result.lengthBefore + HAIKU.length,
      'length delta must equal the typed string',
    );
    const readback = typed.result.readback;
    assert.ok(readback, 'type must come back with a read-back');
    assert.equal(readback.text.replace(/\r\n/g, '\n'), HAIKU);

    const read = await controller.readText({ handle: typed.window.handle });
    assert.equal(read.text.text.replace(/\r\n/g, '\n'), HAIKU);
  } finally {
    await cleanup();
  }
});

test('typing to a closed handle fails and delivers zero keystrokes', async () => {
  const { controller, mock, cleanup } = await harness();
  try {
    const { handle } = await launchNotepad(controller);
    await mock.close(handle);

    const keystrokes = () => mock.calls.filter((c) => /type|key/i.test(c.op)).length;
    const before = keystrokes();

    await assert.rejects(
      () => controller.typeText({ handle }, HAIKU),
      /is gone|no window exists/i,
      'a dead handle must fail instead of falling back to whatever has focus',
    );
    await assert.rejects(
      () => controller.sendKeys({ handle }, '^{END}'),
      /is gone|no window exists/i,
    );
    assert.equal(keystrokes(), before, 'nothing may be typed when the target is gone');
  } finally {
    await cleanup();
  }
});

test('an impossible capture fails loudly with the reason, and returns no pixels', async () => {
  const { controller, mock, cleanup } = await harness();
  try {
    const { handle } = await launchNotepad(controller);
    const cases: Array<[Partial<WindowInfo>, RegExp]> = [
      [{ ...CAPTURABLE, isMinimized: true }, /minimi/i],
      [{ ...CAPTURABLE, isCloaked: true }, /cloak/i],
      [{ ...CAPTURABLE, isVisible: false }, /visible|hidden/i],
      [{ ...CAPTURABLE, isOffscreen: true }, /off-?screen|intersects a monitor/i],
      [{ ...CAPTURABLE, bounds: { x: 100, y: 100, width: 0, height: 0 } }, /area/i],
    ];
    for (const [patch, message] of cases) {
      mock.simulate(handle, patch);
      await assert.rejects(
        () => controller.screenshot({ handle }),
        message,
        `capture must name the reason for ${JSON.stringify(patch)}`,
      );
    }

    // Restore a capturable frame: the same call now succeeds, from the window itself.
    mock.simulate(handle, CAPTURABLE);
    const shot = await controller.screenshot({ handle });
    assert.equal(shot.source, 'window');
    assert.equal(shot.handle, handle);
  } finally {
    await cleanup();
  }
});

test('ui_tree is idempotent on an idle window and never returns impossible bounds', async () => {
  const { controller, cleanup } = await harness();
  try {
    const { handle } = await launchNotepad(controller);

    const first = await controller.read({ handle }, 8, 500);
    const second = await controller.read({ handle }, 8, 500);
    assert.equal(second.nodes.length, first.nodes.length);
    assert.deepEqual(
      second.nodes.map((n) => [n.depth, n.controlType, n.name, n.automationId]),
      first.nodes.map((n) => [n.depth, n.controlType, n.name, n.automationId]),
      'two reads of an idle window must return the same node set',
    );

    for (const node of first.nodes) {
      if (!node.bounds) continue;
      assert.ok(
        node.bounds.x > -BOUNDS_LIMIT && node.bounds.y > -BOUNDS_LIMIT,
        `bounds ${JSON.stringify(node.bounds)} for ${node.controlType} are not a real rectangle`,
      );
      assert.ok(node.bounds.width >= 0 && node.bounds.height >= 0);
    }
  } finally {
    await cleanup();
  }
});

test('filtered listWindows is a subset of the unfiltered enumeration', async () => {
  const { controller, cleanup } = await harness();
  try {
    const unfiltered = await controller.listWindows();
    const filtered = await controller.listWindows({ app: 'notepad' });
    assert.ok(filtered.length <= unfiltered.length);
    for (const w of filtered) {
      const twin = unfiltered.find((u) => u.handle === w.handle);
      assert.ok(twin, 'a filtered window must exist in the unfiltered list');
      assert.equal(twin.processId, w.processId);
      assert.equal(twin.title, w.title);
      assert.equal(twin.isMinimized, w.isMinimized);
      assert.equal(twin.isCloaked, w.isCloaked);
      assert.equal(twin.virtualDesktop, w.virtualDesktop);
    }
  } finally {
    await cleanup();
  }
});
