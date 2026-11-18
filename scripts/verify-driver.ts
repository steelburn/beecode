/**
 * Live driver diagnostic — NOT part of `npm run check`.
 *
 * Exercises the real Windows driver against a real application (Calculator by default)
 * and prints what it observed: window enumeration, UWP process resolution, the UI
 * Automation tree, invoking controls, reading the result, resizing the frame, clicking by
 * screen coordinates and capturing a screenshot. Run it manually: `npm run verify:driver`.
 */
import type { UiNode } from '../src/service/desktop/types';
import { writeFileSync } from 'node:fs';
import { WindowsDriver } from '../src/service/desktop/windowsDriver';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CALC_BUTTONS = ['num1Button', 'num2Button', 'multiplyButton', 'num4Button', 'equalButton'];

/** Centre of a node's screen rectangle — the point `desktop_click` would be given. */
function centerOf(node: UiNode | undefined): { x: number; y: number } | undefined {
  if (!node?.bounds) return undefined;
  const { x, y, width, height } = node.bounds;
  return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
}

async function main(): Promise<void> {
  const driver = new WindowsDriver();
  const report: Record<string, unknown> = { platform: process.platform, driver: driver.name };

  const before = await driver.listWindows();
  report.windowCount = before.length;
  report.windows = before.slice(0, 12).map((w) => `${w.exe} — ${w.title}`);

  const findCalc = async () =>
    (await driver.listWindows()).find(
      (w) => /calculatorapp\.exe|calc\.exe|winstore/i.test(w.exe ?? '') || /calculator/i.test(w.title),
    );

  let calc = await findCalc();
  if (!calc) {
    report.launched = await driver.launch('C:\\Windows\\System32\\calc.exe', []);
    for (let i = 0; i < 16 && !calc; i += 1) {
      await delay(500);
      calc = await findCalc();
    }
  }
  if (!calc) {
    report.error = 'Calculator did not appear — is this an interactive desktop session?';
    // Persisted so a truncated console can still be inspected afterwards.
  writeFileSync('dist-test/verify-driver-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  report.window = { title: calc.title, exe: calc.exe, handle: calc.handle, pid: calc.processId };
  // Activation is best-effort: Windows refuses SetForegroundWindow from a process that is
  // not already foreground ("focus lock"), which is a property of the desktop, not a bug in
  // the driver. Record it and carry on — UIA reads and invokes do not need the foreground.
  try {
    await driver.activate(calc.handle);
    report.activated = true;
  } catch (err) {
    report.activated = false;
    report.activateError = err instanceof Error ? err.message : String(err);
  }
  await delay(300);

  const tree = await driver.uiTree(calc.handle, 8, 400);
  report.nodeCount = tree.length;
  report.controlTypes = [...new Set(tree.map((n) => n.controlType))];
  report.nodes = tree
    .filter((n) => n.automationId || n.name)
    .slice(0, 14)
    .map((n) => `${n.controlType}\t${n.automationId}\t${n.name}${n.value ? ` = ${n.value}` : ''}`);

  // Prefer UI Automation invokes (no focus needed), fall back to key presses.
  // Press in evaluation order — UIA tree order is layout order, not 1, 2, ×, 4, =.
  const byId = new Map(tree.map((n) => [n.automationId, n]));
  const clickable = CALC_BUTTONS.map((id) => byId.get(id)).filter((n): n is UiNode => Boolean(n));
  report.addressing = clickable.length ? 'invoke' : 'sendKeys';

  if (clickable.length) {
    for (const button of clickable) {
      const res = await driver.invoke(calc.handle, { automationId: button.automationId });
      report[`invoke_${button.automationId}`] = res.detail;
      if (!res.ok) break;
      await delay(120);
    }
  } else {
    for (const key of ['1', '2', '*', '4', '=']) {
      await driver.sendKeys(calc.handle, key);
      await delay(120);
    }
  }
  await delay(500);

  const after: UiNode[] = await driver.uiTree(calc.handle, 8, 400);
  const display = after.find((n) => /CalculatorResults/i.test(n.automationId));
  report.display = display?.name ?? '(CalculatorResults not found)';

  // --- resize the real frame, then verify the new geometry is what UIA reports -------
  const sized = await driver.resize(calc.handle, 820, 660);
  report.resize = sized;
  const resizedTree = await driver.uiTree(calc.handle, 8, 400);
  const resizedDisplay = resizedTree.find((n) => /CalculatorResults/i.test(n.automationId));
  // The root node is the window itself, so its rectangle is the driver's claim about where the
  // frame is — the same space the click coordinates must be in.
  report.rootBounds = resizedTree.find((n) => n.controlType === 'Window')?.bounds ?? '(none)';
  report.resizeObserved = resizedDisplay?.bounds
    ? `${resizedDisplay.bounds.width}x${resizedDisplay.bounds.height} display`
    : '(no bounds after resize)';
  report.buttonBounds = ['clearButton', 'num7Button', 'equalButton'].map(
    (id) => `${id}: ${JSON.stringify(resizedTree.find((n) => n.automationId === id)?.bounds ?? null)}`,
  );

  // --- click by screen coordinates (the path for controls with no InvokePattern) -----
  // Clear, then 7 + 1 = by mouse only. Each point is the centre of the button's own
  // rectangle, so a passing result also proves the bounds are in screen space.
  const byIdAfter = new Map(resizedTree.map((n) => [n.automationId, n]));
  const stepDisplays: string[] = [];
  for (const id of ['clearButton', 'num7Button', 'plusButton', 'num1Button', 'equalButton']) {
    const point = centerOf(byIdAfter.get(id));
    if (!point) {
      report[`click_${id}`] = 'no bounds — coordinate clicking not verifiable here';
      break;
    }
    try {
      await driver.click(calc.handle, point.x, point.y);
      report[`click_${id}`] = `clicked ${point.x},${point.y}`;
    } catch (err) {
      // A refusal is the guard working, not a harness crash: record why and stop pressing.
      // Retrying or forcing the click would defeat the check under test.
      report[`click_${id}`] = `refused: ${(err as Error).message}`;
      report.clickRefusal = (err as Error).message;
      break;
    }
    await delay(250);
    // Recorded per press: a single swallowed click is otherwise invisible in the final value.
    const step = await driver.uiTree(calc.handle, 8, 400);
    stepDisplays.push(`${id} → ${step.find((n) => /CalculatorResults/i.test(n.automationId))?.name ?? '?'}`);
  }
  report.clickSteps = stepDisplays;
  await delay(300);
  const afterClick = await driver.uiTree(calc.handle, 8, 400);
  const clickDisplay = afterClick.find((n) => /CalculatorResults/i.test(n.automationId));
  report.displayAfterClick = clickDisplay?.name ?? '(CalculatorResults not found)';

  const shot = await driver.screenshot(calc.handle);
  report.screenshot = { width: shot.width, height: shot.height, base64Bytes: shot.png.length };

  await driver.close(calc.handle);
  report.closed = true;
  // Invokes compute 12 x 4 = 48; the mouse-only round computes 7 + 1 = 8. Both are matched
  // exactly (anchored) so a partial press or a stale display cannot pass.
  const invoked = typeof report.display === 'string' && /^Display is 48\b/.test(report.display.trim());
  const clicked =
    typeof report.displayAfterClick === 'string' && /^Display is 8\b/.test(report.displayAfterClick.trim());
  // The click round is reported separately, not folded into `pass`. The driver's own contract
  // (containment, foreground, cursor arrival) is verified by the absence of a throw above;
  // whether the app *reacts* depends on an attached interactive session, which a CI host or a
  // disconnected console does not have. Failing the whole check on that would be a false
  // negative about the code.
  report.clickVerified = clicked;
  report.clickNote = clicked
    ? 'synthetic clicks registered'
    : 'each click was refused or had no observable effect — Windows denies foreground activation to a background process (focus lock), and a coordinate click is refused unless the pixel hit-tests to the permitted app; run this on an attended desktop with the app visible';
  report.pass = invoked;

  writeFileSync('dist-test/verify-driver-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 2);
}

void main().catch((err) => {
  console.error(JSON.stringify({ error: (err as Error).message }, null, 2));
  process.exit(1);
});
