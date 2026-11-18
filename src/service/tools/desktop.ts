import type { DesktopAction, PolicyDocument } from '../../shared/protocol';
import type { ToolContext, ToolDefinition, ToolPreview } from '../../shared/tools';
import { DesktopController, DesktopDeniedError } from '../desktop/controller';
import type { ElementSelector } from '../desktop/types';
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
        'Launch a permissible application by its app id. Fails if the app is not allowed to launch or the executable cannot be found.',
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
          return jsonResult({ launched: app, pid: res.processId, exe: res.exe, detail: res.detail });
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
          return jsonResult({ focused: w.title, handle: w.handle, exe: w.exe });
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
        'Read the UI Automation tree of a window: name, controlType, automationId, supported patterns, value and bounds for each node. Use this before invoking anything.',
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
          const { window, nodes } = await controller.read(
            target(args),
            num(args, 'maxDepth', 6),
            num(args, 'maxNodes', 200),
          );
          return jsonResult({ window: { title: window.title, handle: window.handle, exe: window.exe }, nodes });
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
      description: 'Type text into the focused control of a window (activates the window first).',
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
          const w = await controller.typeText(target(args), requireStr(args, 'text'));
          return jsonResult({ ok: true, window: w.title });
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
          const w = await controller.sendKeys(target(args), requireStr(args, 'keys'));
          return jsonResult({ ok: true, window: w.title });
        } catch (err) {
          return denyPayload(err);
        }
      },
    },
    {
      name: 'desktop_screenshot',
      description:
        'Capture a PNG screenshot of a window (or the whole screen when no target is given) and attach it to the conversation.',
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
              width: shot.width,
              height: shot.height,
              window: shot.window?.title ?? 'screen',
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
