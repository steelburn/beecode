import type { DesktopAction, PolicyDocument } from '../../shared/protocol';
import type { ToolContext, ToolDefinition, ToolPreview } from '../../shared/tools';
import { DesktopController, DesktopDeniedError } from '../desktop/controller';
import type { ElementSelector, WindowInfo } from '../desktop/types';
import type { PolicyEngine } from '../policy';
import { errorResult, jsonResult, num, requireStr, str } from './registry';

interface DesktopToolDeps {
  controller: DesktopController;
  policy: PolicyEngine;
}

/** Shared target schema fragment: address a window by app id (preferred) or handle. */
const TARGET_PROPS = {
  app: { type: 'string', description: 'Permissible app id, e.g. "notepad". Resolves to its window.' },
  handle: { type: 'string', description: 'Exact window handle from desktop_list_windows.' },
};

const SELECTOR_PROPS = {
  automationId: { type: 'string', description: 'UI Automation automationId — most stable selector.' },
  name: { type: 'string', description: 'Accessible name / label of the control.' },
  controlType: { type: 'string', description: 'Control type, e.g. Button, Edit, MenuItem, Tab.' },
  index: { type: 'number', description: 'Node index from the last desktop_ui_tree result.' },
};

/**
 * Builds the dry-run approval preview for a desktop action: it consults the policy only
 * (no driver call) so the agent loop can decide whether to prompt before touching the screen.
 */
function desktopPreview(
  policy: PolicyEngine,
  action: DesktopAction,
  args: Record<string, unknown>,
  ctx: ToolContext,
  text: (rule: ReturnType<PolicyEngine['findApp']>) => string,
): ToolPreview {
  const appId = str(args, 'app');
  const rule = appId ? policy.findApp(appId) : undefined;
  const summary = text(rule);
  if (ctx.mode === 'autonomous' && !ctx.parentSessionId) {
    return { requiresApproval: false, summary, reason: 'autonomous mode' };
  }
  if (rule?.autoApprove) {
    return { requiresApproval: false, summary, reason: `"${rule.id}" is auto-approved by policy` };
  }
  return {
    requiresApproval: true,
    summary,
    reason: rule
      ? `policy requires confirmation for "${rule.id}" (${action})`
      : 'target is not in the permissible-application list',
  };
}

function denyPayload(err: unknown) {
  if (err instanceof DesktopDeniedError) {
    return errorResult(err.message, { denied: true, reason: err.decision.reason });
  }
  return errorResult(err instanceof Error ? err.message : String(err));
}

export function desktopTools(deps: DesktopToolDeps): ToolDefinition[] {
  const { controller, policy } = deps;

  const selector = (args: Record<string, unknown>): ElementSelector => ({
    automationId: str(args, 'automationId'),
    name: str(args, 'name'),
    controlType: str(args, 'controlType'),
    index: typeof args.index === 'number' ? Number(args.index) : undefined,
  });

  const target = (args: Record<string, unknown>) => ({ app: str(args, 'app'), handle: str(args, 'handle') });

  /**
   * The one window identity every desktop result carries. A handle returned here is
   * addressable by every other desktop tool for as long as that window lives.
   */
  const identify = (w: WindowInfo) => ({
    handle: w.handle,
    processId: w.processId,
    title: w.title,
    exe: w.exe,
    className: w.className,
  });

  /** Identity plus the state flags that decide whether the window can be observed at all. */
  const describe = (w: WindowInfo) => ({
    ...identify(w),
    isForeground: w.isForeground,
    isVisible: w.isVisible,
    isMinimized: w.isMinimized,
    isCloaked: w.isCloaked,
    isOffscreen: w.isOffscreen,
    virtualDesktop: w.virtualDesktop,
    bounds: w.bounds,
  });

  return [
    {
      name: 'desktop_list_apps',
      description:
        'List the applications the permission policy allows beeCode to interact with, including which actions (launch, focus, read, invoke, type, key, screenshot, close) are permitted for each.',
      mutating: false,
      group: 'desktop',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        return jsonResult({
          driver: controller.driverName,
          apps: controller.listApps(),
          denied: (policy.get() as PolicyDocument).deniedExe,
        });
      },
    },
    {
      name: 'desktop_list_windows',
      description:
        'List the top-level windows currently on the desktop with their handle, title, process id and executable, and whether the policy permits interacting with each one.',
      mutating: false,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Optional app id to filter by.' },
          permittedOnly: { type: 'boolean', description: 'Only return windows beeCode may touch.' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const windows = await controller.listWindows({
          app: str(args, 'app'),
          permittedOnly: args.permittedOnly === true,
        });
        return jsonResult({ count: windows.length, windows });
      },
    },
    {
      name: 'desktop_launch',
      description:
        'Launch a permissible application by its app id and return the identity of the window it produced (handle, pid, title, exe, className). With a single-instance app the document is handed to the already running window: `windowCreated` is then false and `tabAdded` true. Address that handle in later calls; do not use `spawnerProcessId`.',
      mutating: true,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Permissible app id, e.g. "notepad".' },
          args: { type: 'array', items: { type: 'string' }, description: 'Optional command-line arguments.' },
        },
        required: ['app'],
        additionalProperties: false,
      },
      preview: (args, ctx) =>
        desktopPreview(policy, 'launch', args, ctx, (rule) => `Launch ${rule?.name ?? str(args, 'app')}`),
      async handler(args) {
        const app = requireStr(args, 'app');
        const argv = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
        try {
          const res = await controller.launch(app, argv);
          return jsonResult({
            launched: app,
            exe: res.exe,
            // `processId` is the process the shell started. For a single-instance app
            // (Win11 tabbed Notepad) it exits within seconds — the window identity below
            // is what every later call must address.
            spawnerProcessId: res.spawnerProcessId,
            windowCreated: res.windowCreated,
            tabAdded: res.tabAdded,
            window: res.window ? describe(res.window) : null,
            detail: res.detail,
          });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_focus',
      description: "Bring a permissible app's window to the foreground so subsequent keyboard input lands in it.",
      mutating: true,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: TARGET_PROPS,
        additionalProperties: false,
      },
      preview: (args, ctx) =>
        desktopPreview(policy, 'focus', args, ctx, (rule) => `Focus ${rule?.name ?? str(args, 'app') ?? str(args, 'handle')}`),
      async handler(args) {
        try {
          const w = await controller.focus(target(args));
          return jsonResult({ ...describe(w), focused: w.title });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_close',
      description: 'Close a permissible window (sends WM_CLOSE — the app may still prompt to save).',
      mutating: true,
      group: 'desktop',
      inputSchema: { type: 'object', properties: TARGET_PROPS, additionalProperties: false },
      preview: (args, ctx) =>
        desktopPreview(policy, 'close', args, ctx, (rule) => `Close ${rule?.name ?? str(args, 'app') ?? str(args, 'handle')}`),
      async handler(args) {
        try {
          const w = await controller.close(target(args));
          return jsonResult({ closed: w.title, handle: w.handle });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_ui_tree',
      description:
        'Read the UI Automation tree of a window: name, controlType, automationId, supported patterns, value, text and bounds for each node. Text-bearing controls (Document, Edit) also return `text`/`textLength`, which is how you verify that typed input landed. Check `truncated` before concluding a control is missing — pass a larger maxNodes instead.',
      mutating: false,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          maxDepth: { type: 'number', description: 'Tree depth to walk (default 6).' },
          maxNodes: { type: 'number', description: 'Maximum nodes to return (default 200).' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        try {
          const tree = await controller.read(
            target(args),
            num(args, 'maxDepth', 6),
            num(args, 'maxNodes', 200),
          );
          return jsonResult({
            window: describe(tree.window),
            nodeCount: tree.nodes.length,
            // A tree cut short by the node budget says so; a walk that timed out is an
            // error, never a smaller tree.
            truncated: tree.truncated,
            expanded: tree.expanded,
            nodes: tree.nodes,
          });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_invoke',
      description:
        'Click/activate a UI element by automationId, name+controlType or index. Tries invoke, toggle, select, expand and legacy-default-action patterns in that order.',
      mutating: true,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: { ...TARGET_PROPS, ...SELECTOR_PROPS },
        additionalProperties: false,
      },
      preview: (args, ctx) =>
        desktopPreview(
          policy,
          'invoke',
          args,
          ctx,
          (rule) => `Click "${str(args, 'automationId') ?? str(args, 'name') ?? `#${args.index}`}" in ${rule?.name ?? str(args, 'app')}`,
        ),
      async handler(args) {
        const sel = selector(args);
        if (!sel.automationId && !sel.name && sel.index === undefined) {
          return errorResult('provide automationId, name or index to identify the element');
        }
        try {
          const res = await controller.invoke(target(args), sel);
          return jsonResult({ ok: true, detail: res.detail, window: res.window.title });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_click',
      description:
        'Click at absolute screen coordinates inside a window. Node `bounds` from desktop_read are screen coordinates, so a point taken from the tree can be passed directly. Use this when a control exposes no InvokePattern; coordinates outside the target window are refused.',
      mutating: true,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          x: { type: 'number', description: 'Absolute screen x.' },
          y: { type: 'number', description: 'Absolute screen y.' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      preview: (args, ctx) =>
        desktopPreview(
          policy,
          'click',
          args,
          ctx,
          (rule) =>
            `Click at ${num(args, 'x', 0)},${num(args, 'y', 0)} in ${rule?.name ?? str(args, 'app')}`,
        ),
      async handler(args) {
        try {
          const res = await controller.click(target(args), num(args, 'x', NaN), num(args, 'y', NaN));
          return jsonResult({ ok: true, window: res.window.title, point: res.point });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_resize',
      description:
        'Resize a window frame without activating it. The size is clamped to 200x120 … 6000x4000 and the result reports what the window manager actually applied.',
      mutating: true,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          width: { type: 'number', description: 'Target width in pixels.' },
          height: { type: 'number', description: 'Target height in pixels.' },
        },
        required: ['width', 'height'],
        additionalProperties: false,
      },
      preview: (args, ctx) =>
        desktopPreview(
          policy,
          'resize',
          args,
          ctx,
          (rule) =>
            `Resize ${rule?.name ?? str(args, 'app')} to ${num(args, 'width', 0)}x${num(args, 'height', 0)}`,
        ),
      async handler(args) {
        try {
          const res = await controller.resize(target(args), num(args, 'width', NaN), num(args, 'height', NaN));
          return jsonResult({ ok: true, window: res.window.title, size: res.size });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_set_value',
      description: 'Set the value of an editable control (ValuePattern.SetValue) such as a text field or combo box.',
      mutating: true,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: { ...TARGET_PROPS, ...SELECTOR_PROPS, value: { type: 'string', description: 'New value.' } },
        required: ['value'],
        additionalProperties: false,
      },
      preview: (args, ctx) =>
        desktopPreview(
          policy,
          'invoke',
          args,
          ctx,
          (rule) => `Set "${str(args, 'automationId') ?? str(args, 'name')}" in ${rule?.name ?? str(args, 'app')}`,
        ),
      async handler(args) {
        try {
          const res = await controller.setValue(target(args), selector(args), requireStr(args, 'value'));
          return jsonResult({ ok: true, detail: res.detail });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_type',
      description: 'Type text into the focused control of a window (activates the window first, verifies it really is foreground, then reads the document back). The result carries `readBack` and `delta`: compare them with what you typed — that is the proof the text landed in this window.',
      mutating: true,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: { ...TARGET_PROPS, text: { type: 'string', description: 'Text to type.' } },
        required: ['text'],
        additionalProperties: false,
      },
      preview: (args, ctx) =>
        desktopPreview(policy, 'type', args, ctx, (rule) => {
          const text = String(args.text ?? '');
          return `Type ${text.length > 60 ? `${text.slice(0, 60)}…` : JSON.stringify(text)} into ${rule?.name ?? str(args, 'app')}`;
        }),
      async handler(args) {
        try {
          const { window, result } = await controller.typeText(target(args), requireStr(args, 'text'));
          return jsonResult({
            ok: true,
            window: describe(window),
            typed: result.typed,
            // Text read back from the target after the keystrokes — this, not `ok`, is
            // the evidence that the text landed where you meant it to.
            readBack: result.readback
              ? {
                  text: result.readback.text,
                  length: result.readback.length,
                  truncated: result.readback.truncated,
                  source: result.readback.source,
                }
              : null,
            lengthBefore: result.lengthBefore,
            lengthAfter: result.lengthAfter,
            delta: result.delta,
          });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_hotkey',
      description:
        'Send a key chord to a window. Use SendKeys syntax: "^s" = Ctrl+S, "%{F4}" = Alt+F4, "{ENTER}", "{TAB}", "^+{ESC}".',
      mutating: true,
      group: 'desktop',
      inputSchema: {
        type: 'object',
        properties: { ...TARGET_PROPS, keys: { type: 'string', description: 'SendKeys chord, e.g. "^s".' } },
        required: ['keys'],
        additionalProperties: false,
      },
      preview: (args, ctx) =>
        desktopPreview(policy, 'key', args, ctx, (rule) => `Send ${JSON.stringify(args.keys)} to ${rule?.name ?? str(args, 'app')}`),
      async handler(args) {
        try {
          const { window, result } = await controller.sendKeys(target(args), requireStr(args, 'keys'));
          return jsonResult({
            ok: true,
            window: describe(window),
            typed: result.typed,
            readBack: result.readback
              ? {
                  text: result.readback.text,
                  length: result.readback.length,
                  truncated: result.readback.truncated,
                  source: result.readback.source,
                }
              : null,
            lengthBefore: result.lengthBefore,
            lengthAfter: result.lengthAfter,
            delta: result.delta,
          });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_screenshot',
      description:
        'Capture a PNG of the window itself (PrintWindow with full content) and attach it to the conversation. The pixels are that window even when it is partly covered. If the window cannot be captured — cloaked, minimised, hidden, no area — the call fails with the reason instead of returning a different image.',
      mutating: false,
      group: 'desktop',
      inputSchema: { type: 'object', properties: TARGET_PROPS, additionalProperties: false },
      preview: (args, ctx) =>
        desktopPreview(policy, 'screenshot', args, ctx, (rule) => `Capture screen of ${rule?.name ?? str(args, 'app') ?? 'the desktop'}`),
      async handler(args) {
        try {
          const shot = await controller.screenshot(target(args));
          return {
            content: JSON.stringify({
              captured: true,
              source: shot.source,
              handle: shot.handle,
              width: shot.width,
              height: shot.height,
              window: describe(shot.window),
            }),
            meta: { images: [{ mime: 'image/png', data: shot.png }] },
          };
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
  ];
}
