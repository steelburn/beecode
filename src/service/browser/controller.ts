/**
 * The service-side half of the internal browser.
 *
 * Same shape as `DesktopController`: resolve the target, ask the policy, audit the
 * outcome, then let the host do the work. The difference is where the work happens — this
 * controller has no idea what a web page is. It sends `browser/exec` host requests to the
 * Electron main process (see `shared/browser.ts`) and formats what comes back for the
 * model. That keeps the service runnable headless: over HTTP there is no host, and every
 * `browser_*` tool answers with a clear "not available here" instead of pretending.
 */
import type {
  BrowserExecParams,
  BrowserExecResult,
  BrowserSnapshot,
  BrowserState,
  HostCall,
} from '../../shared/browser';
import type { AuditEntry, BrowserConfig } from '../../shared/protocol';
import type { AuditLog } from '../audit';
import type { PolicyEngine } from '../policy';

const MAX_SNAPSHOT_ELEMENTS = 60;
const MAX_SNAPSHOT_TEXT = 3500;

export interface BrowserControllerOptions {
  policy: PolicyEngine;
  audit: AuditLog;
  config: () => BrowserConfig;
  /** Bound by the transport: stdio has a host, HTTP does not. */
  host: () => HostCall | undefined;
  onActivity?: (entry: AuditEntry) => void;
}

export interface BrowserAvailability {
  available: boolean;
  reason: string;
}

export class BrowserController {
  private state?: BrowserState;

  constructor(private readonly opts: BrowserControllerOptions) {}

  available(): BrowserAvailability {
    if (!this.opts.config().enabled) {
      return { available: false, reason: 'the internal browser is disabled in config (browser.enabled)' };
    }
    if (!this.opts.host()) {
      return { available: false, reason: 'the internal browser is only available in the desktop app' };
    }
    return { available: true, reason: 'sandboxed, in-app browser' };
  }

  /** Last known panel/tab state, refreshed by every action. */
  currentState(): BrowserState | undefined {
    return this.state;
  }

  /**
   * Run one browser action: policy first, audit always, host last.
   *
   * `params.url` decides the policy target for navigation; every other action is checked
   * against the URL of the tab it will touch, which is why the state is kept here.
   */
  async exec(sessionId: string, tool: string, params: BrowserExecParams): Promise<BrowserExecResult> {
    const host = this.opts.host();
    if (!host) {
      return { ok: false, action: params.action, error: this.available().reason };
    }

    const target = await this.policyTarget(params, host);
    const decision = this.opts.policy.evaluateBrowser(target, params.action);
    if (!decision.allowed) {
      this.record(sessionId, tool, params, target, 'denied', decision.reason);
      return { ok: false, action: params.action, error: `denied by policy: ${decision.reason}` };
    }

    let result: BrowserExecResult;
    try {
      result = await host('browser/exec', params);
    } catch (error) {
      const message = messageOf(error);
      this.record(sessionId, tool, params, target, 'failed', message);
      return { ok: false, action: params.action, error: message };
    }

    if (result.state) this.state = result.state;
    this.record(
      sessionId,
      tool,
      params,
      target,
      result.ok ? 'allowed' : 'failed',
      result.error ?? result.message ?? '',
    );
    return result;
  }

  /**
   * The URL an action is judged against. Navigation policies check the destination; an
   * interaction checks the page it happens on, fetched once if this controller has not seen
   * a state yet (a freshly restarted service has no memory of the open tabs).
   */
  private async policyTarget(params: BrowserExecParams, host: HostCall): Promise<string> {
    if (params.action === 'open' || params.action === 'navigate') {
      return params.url?.trim() ? params.url.trim() : this.opts.config().homeUrl;
    }
    if (!this.state) {
      try {
        const probe = await host('browser/exec', { action: 'tabs' });
        if (probe.state) this.state = probe.state;
      } catch {
        /* a missing host state only means "unknown tab"; the sandbox still holds */
      }
    }
    const active = this.state?.tabs.find((tab) => tab.active) ?? this.state?.tabs[0];
    return active?.url ?? 'about:blank';
  }

  private record(
    sessionId: string,
    tool: string,
    params: BrowserExecParams,
    url: string,
    outcome: AuditEntry['outcome'],
    detail: string,
  ): void {
    const entry: AuditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      sessionId,
      tool,
      action: 'browser',
      target: url,
      outcome,
      detail: `${params.action}${params.ref ? ` ${params.ref}` : ''}${params.url ? ` ${params.url}` : ''} — ${detail}`.slice(
        0,
        400,
      ),
    };
    void this.opts.audit.record(entry);
    this.opts.onActivity?.(entry);
  }
}

/**
 * Render a snapshot the way a model reads best: a URL and title, the interactive elements
 * with stable refs, then the visible text. Elements come first because they are what the
 * next action needs; the text is context.
 */
export function formatSnapshot(snapshot: BrowserSnapshot): string {
  const lines: string[] = [];
  lines.push(`page: ${snapshot.title || '(untitled)'} — ${snapshot.url}`);
  lines.push(
    `viewport ${snapshot.viewport.width}x${snapshot.viewport.height} @ scroll ${snapshot.viewport.scrollX},${snapshot.viewport.scrollY}${
      snapshot.loading ? ' (still loading)' : ''
    }`,
  );

  const elements = snapshot.elements.slice(0, MAX_SNAPSHOT_ELEMENTS);
  lines.push('', `interactive elements (${snapshot.elements.length}):`);
  if (!elements.length) {
    lines.push('  (none found — the page may be canvas-based; try browser_scroll or browser_screenshot)');
  }
  for (const element of elements) {
    const flags = [element.disabled ? 'disabled' : '', element.editable ? 'editable' : ''].filter(Boolean).join(',');
    const value = element.value ? ` value="${element.value}"` : '';
    lines.push(
      `  ${element.ref} ${element.role} "${element.name}"${value}${flags ? ` [${flags}]` : ''} @${element.rect.x},${element.rect.y} ${element.rect.width}x${element.rect.height}`,
    );
  }
  if (snapshot.elements.length > elements.length) {
    lines.push(`  … ${snapshot.elements.length - elements.length} more element(s) not shown`);
  }

  const text = snapshot.text.slice(0, MAX_SNAPSHOT_TEXT);
  lines.push('', 'visible text:', text || '(empty)');
  if (snapshot.truncated || snapshot.text.length > text.length) {
    lines.push('', '(text truncated — scroll or narrow the page to read further)');
  }
  return lines.join('\n');
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}
