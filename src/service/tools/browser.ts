/**
 * `browser_*` tools — the agent's hands on its own sandboxed browser.
 *
 * These exist so the agent can look something up without touching the user's real browser
 * or desktop: no focus stealing, no mouse war on whatever the user is doing, no cookies
 * from their profile, and a visible AI cursor so the interaction is legible. Every handler
 * is a thin shell around `BrowserController.exec`, which owns policy and audit.
 *
 * The description strings are part of the prompt surface: they tell the model when to reach
 * for this tier instead of `desktop_*`, and that a ref from `browser_snapshot` is the
 * handle it should click with.
 */
import type { BrowserExecParams } from '../../shared/browser';
import type { ToolContext, ToolDefinition, ToolResult } from '../../shared/tools';
import { BrowserController, formatSnapshot } from '../browser/controller';
import type { PolicyEngine } from '../policy';
import { errorResult, num, requireStr, str } from './registry';

export interface BrowserToolDeps {
  controller: BrowserController;
  policy: PolicyEngine;
}

function unavailable(controller: BrowserController): ToolResult | undefined {
  const status = controller.available();
  if (status.available) return undefined;
  return errorResult(`${status.reason}. Use desktop_* tools, or ask the user to enable browser.enabled in config.`, {
    unavailable: true,
  });
}

/** Turn a host result into the text the model reads. */
function render(result: Awaited<ReturnType<BrowserController['exec']>>): ToolResult {
  if (!result.ok) return errorResult(result.error ?? 'the browser action failed', { action: result.action });
  const lines: string[] = [`${result.action}: ${result.message ?? 'ok'}`];
  if (result.tabId) lines.push(`tab: ${result.tabId}`);
  // Nobody is watching a hidden dock, so say so: it explains why the user is not reacting and
  // why a screenshot is the only way to see the page. Every action still works — the main
  // process parks the page offscreen while it drives it.
  if (result.state && !result.state.visible) {
    lines.push(
      'dock: hidden — driving offscreen (every action works, but the user does not see the page; take a screenshot to look at it)',
    );
  }
  if (result.snapshot) {
    lines.push('', formatSnapshot(result.snapshot));
  }
  if (result.screenshot) {
    const kilobytes = Math.round((result.screenshot.dataBase64.length * 3) / 4 / 1024);
    const where = result.state?.visible === false ? 'the dock is hidden' : 'shown in the browser panel';
    lines.push('', `screenshot: ${result.screenshot.mimeType}, ~${kilobytes} KB (${where})`);
  }
  const meta: Record<string, unknown> = { action: result.action, tabId: result.tabId, state: result.state };
  if (result.screenshot) {
    meta.screenshot = `data:${result.screenshot.mimeType};base64,${result.screenshot.dataBase64}`;
  }
  return { content: lines.join('\n'), meta };
}

export function browserTools(deps: BrowserToolDeps): ToolDefinition[] {
  const { controller, policy } = deps;

  /**
   * Approval gate for an action: navigation asks the policy about the destination, an
   * interaction asks about the current page. `browser.requireApproval` turns the browser
   * into a per-action consent flow without changing anything else.
   */
  const gate =
    (action: string, summary: (args: Record<string, unknown>) => string) =>
    (args: Record<string, unknown>): { requiresApproval: boolean; summary: string; reason: string } => {
      const url = action === 'open' || action === 'navigate' ? requireStrSafe(args, 'url') : '';
      const decision = policy.evaluateBrowser(url, action as BrowserExecParams['action']);
      return {
        requiresApproval: decision.allowed && decision.requiresApproval,
        summary: summary(args),
        reason: decision.allowed ? decision.reason : `denied by policy: ${decision.reason}`,
      };
    };

  const run = async (
    ctx: ToolContext,
    tool: string,
    params: BrowserExecParams,
  ): Promise<ToolResult> => render(await controller.exec(ctx.sessionId, tool, params));

  return [
    {
      name: 'browser_open',
      description:
        'Open the internal (sandboxed) browser on a URL and return a snapshot of the page. ' +
        'Use this for web research instead of desktop_* — it cannot touch the OS, and the AI cursor is visible to the user. ' +
        'Omit the url to open the configured home page.',
      mutating: true,
      group: 'browser',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL, or a bare host like example.com.' },
          label: { type: 'string', description: 'Short label shown next to the AI cursor, e.g. "open docs".' },
        },
        additionalProperties: false,
      },
      preview: gate('open', (args) => `Open ${requireStrSafe(args, 'url') || 'the home page'} in the internal browser`),
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        return run(ctx, 'browser_open', { action: 'open', url: str(args, 'url'), label: str(args, 'label') });
      },
    },
    {
      name: 'browser_snapshot',
      description:
        'Read the current page: title, URL, interactive elements with stable refs (e1, e2 …), and visible text. ' +
        'Call it before clicking, and again after any action that changes the page.',
      mutating: false,
      group: 'browser',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab to read (defaults to the active tab).' },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        return run(ctx, 'browser_snapshot', { action: 'snapshot', tabId: str(args, 'tabId') });
      },
    },
    {
      name: 'browser_click',
      description:
        'Click an element in the internal browser. Pass the ref from the last browser_snapshot (preferred) ' +
        'or a CSS selector. The AI cursor moves to the element before the click fires.',
      mutating: true,
      group: 'browser',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from the last snapshot, e.g. "e12".' },
          selector: { type: 'string', description: 'CSS selector, used when no ref is available.' },
          label: { type: 'string', description: 'Text for the AI cursor chip.' },
        },
        additionalProperties: false,
      },
      preview: gate('click', (args) => `Click ${requireStrSafe(args, 'ref') || requireStrSafe(args, 'selector') || 'an element'}`),
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        const ref = str(args, 'ref');
        const selector = str(args, 'selector');
        if (!ref && !selector) return errorResult('pass either a ref (from browser_snapshot) or a selector');
        return run(ctx, 'browser_click', { action: 'click', ref, selector, label: str(args, 'label') });
      },
    },
    {
      name: 'browser_type',
      description:
        'Type text into a field in the internal browser. Focuses the field first, then inserts the text as real input. ' +
        'Pass submit: true to press Enter afterwards.',
      mutating: true,
      group: 'browser',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type.' },
          ref: { type: 'string', description: 'Field ref from the last snapshot.' },
          selector: { type: 'string', description: 'CSS selector for the field.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          label: { type: 'string', description: 'Text for the AI cursor chip.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      preview: gate('type', (args) => `Type ${String(args.text ?? '').length} character(s)`),
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        const ref = str(args, 'ref');
        const selector = str(args, 'selector');
        if (!ref && !selector) return errorResult('pass either a ref (from browser_snapshot) or a selector');
        const typed = await run(ctx, 'browser_type', {
          action: 'type',
          ref,
          selector,
          text: requireStr(args, 'text'),
          label: str(args, 'label'),
        });
        if (typed.failed || args.submit !== true) return typed;
        return run(ctx, 'browser_key', { action: 'key', key: 'Enter', label: 'submit' });
      },
    },
    {
      name: 'browser_key',
      description: 'Press a key in the internal browser: Enter, Tab, Escape, Backspace, Delete, arrows, PageUp/PageDown, Home/End.',
      mutating: true,
      group: 'browser',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name, e.g. "Enter".' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      preview: gate('key', (args) => `Press ${requireStrSafe(args, 'key')}`),
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        return run(ctx, 'browser_key', { action: 'key', key: requireStr(args, 'key') });
      },
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the page (positive deltaY scrolls down). Returns the refreshed snapshot.',
      mutating: true,
      group: 'browser',
      inputSchema: {
        type: 'object',
        properties: {
          deltaY: { type: 'number', description: 'Pixels to scroll; negative scrolls up (default 600).' },
          tabId: { type: 'string', description: 'Tab to scroll (defaults to the active tab).' },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        return run(ctx, 'browser_scroll', {
          action: 'scroll',
          deltaY: num(args, 'deltaY', 600),
          tabId: str(args, 'tabId'),
        });
      },
    },
    {
      name: 'browser_wait',
      description:
        'Wait for the page to finish loading, or for a piece of text to appear (for pages that render asynchronously).',
      mutating: false,
      group: 'browser',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['ready', 'text'],
            description: '"ready" waits for the load event, "text" waits for text to appear (default ready).',
          },
          text: { type: 'string', description: 'Text to wait for when mode is "text".' },
          timeoutMs: { type: 'number', description: 'Give up after this long (default 8000).' },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        const mode = str(args, 'mode') === 'text' ? 'text' : 'ready';
        const text = str(args, 'text');
        if (mode === 'text' && !text) return errorResult('mode "text" needs a text value');
        return run(ctx, 'browser_wait', {
          action: 'wait',
          condition: mode,
          text,
          value: text,
          timeoutMs: num(args, 'timeoutMs', 8000),
        });
      },
    },
    {
      name: 'browser_tabs',
      description: 'List the internal browser tabs and which one is active.',
      mutating: false,
      group: 'browser',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        const result = await controller.exec(ctx.sessionId, 'browser_tabs', { action: 'tabs' });
        if (!result.ok) return errorResult(result.error ?? 'could not list tabs');
        const tabs = (result.state?.tabs ?? []).map(
          (tab) => `${tab.active ? '*' : ' '} ${tab.id} ${tab.loading ? '(loading)' : ''} ${tab.title || '(untitled)'} — ${tab.url}`,
        );
        return { content: tabs.length ? tabs.join('\n') : 'no tabs open', meta: { state: result.state } };
      },
    },
    {
      name: 'browser_screenshot',
      description: 'Capture the visible page as a PNG (for canvas or image-heavy pages the text snapshot cannot describe).',
      mutating: false,
      group: 'browser',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab to capture (defaults to the active tab).' },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        return run(ctx, 'browser_screenshot', { action: 'screenshot', tabId: str(args, 'tabId') });
      },
    },
    {
      name: 'browser_close',
      description: 'Close a tab (or the active tab) in the internal browser. The last closed tab hides the panel.',
      mutating: true,
      group: 'browser',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab to close (defaults to the active tab).' },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const blocked = unavailable(controller);
        if (blocked) return blocked;
        return run(ctx, 'browser_close', { action: 'close', tabId: str(args, 'tabId') });
      },
    },
  ];
}

/** Preview-time argument read: a missing url is a policy question about the home page. */
function requireStrSafe(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}
