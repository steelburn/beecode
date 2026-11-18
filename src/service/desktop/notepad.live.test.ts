import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WindowsDriver } from './windowsDriver';

/**
 * Regression test for the task that started this work: "Open Notepad and write a haiku about
 * background services." It launches its OWN Notepad document (a new tab, never the user's
 * unsaved buffer), types the haiku, and proves with read-back that the text landed.
 *
 * Off by default — it drives the real desktop. Run it with:
 *
 *   BEECODE_LIVE_DESKTOP=1 node scripts/test.mjs notepad.live
 *
 * The window is left open on purpose: closing a modified document raises a save prompt, and a
 * test must never answer it.
 */
const live = process.platform === 'win32' && process.env.BEECODE_LIVE_DESKTOP === '1';

const HAIKU =
  'Silent threads awake,\nworking while the screen sleeps on —\nno one thanks the clock.';

test(
  'live: launch Notepad, type the haiku, read it back, capture that window',
  { skip: live ? false : 'set BEECODE_LIVE_DESKTOP=1 to drive the real desktop' },
  async () => {
    const driver = new WindowsDriver();

    const launched = await driver.launch('notepad.exe', []);
    const window = launched.window;
    assert.ok(window, 'launch must name the window that received the document');
    assert.ok(window.processId > 0, 'the reported pid is the window owner, not the spawner');

    // The handle launch returned must be findable by a plain enumeration — one identity.
    const listed = (await driver.listWindows()).find((w) => w.handle === window.handle);
    assert.ok(listed, 'the launched handle must appear in listWindows');

    const activated = await driver.activate(window.handle);
    assert.equal(activated.handle, window.handle);

    const typed = await driver.typeText(window.handle, HAIKU);
    assert.ok(typed.typed > 0, 'characters were delivered');
    assert.ok((typed.delta ?? 0) >= HAIKU.length, `document grew by ${typed.delta} for ${HAIKU.length} chars`);

    const readback = typed.readback ?? (await driver.readText(window.handle));
    const text = readback.text.replace(/\r\n/g, '\n');
    assert.ok(
      text.endsWith(HAIKU),
      `read-back must end with the typed haiku, got:\n${JSON.stringify(text.slice(-200))}`,
    );

    const tree = await driver.uiTree(window.handle, 8, 600);
    assert.equal(tree.window.handle, window.handle);
    assert.ok(tree.nodes.length > 1, 'Notepad must yield more than the root frame');
    assert.ok(
      tree.nodes.some((n) => /document|edit/i.test(n.controlType)),
      'the tree must contain the editor',
    );

    const shot = await driver.screenshot(window.handle);
    assert.equal(shot.source, 'window');
    assert.equal(shot.handle, window.handle);
    assert.ok(shot.width > 0 && shot.height > 0);
  },
);
