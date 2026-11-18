import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AuditEntry, DesktopAction } from '../../shared/protocol';
import type { AuditLog } from '../audit';
import type { PolicyDecision, PolicyEngine } from '../policy';
import { MockDriver } from './mockDriver';
import type {
  DesktopDriver,
  ElementSelector,
  LaunchResult,
  ScreenshotResult,
  TextReadback,
  TypeResult,
  UiTreeResult,
  WindowInfo,
} from './types';
import { WindowsDriver } from './windowsDriver';

export class DesktopDeniedError extends Error {
  constructor(
    message: string,
    readonly decision: PolicyDecision,
  ) {
    super(message);
    this.name = 'DesktopDeniedError';
  }
}

export class DesktopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopError';
  }
}

export interface WindowSummary extends WindowInfo {
  appId?: string;
  permitted: boolean;
  actions: DesktopAction[];
}

type Target = { app?: string; handle?: string };

export interface DesktopControllerOptions {
  allowInput: boolean;
  driver: 'windows' | 'mock';
  onAudit?: (entry: AuditEntry) => void;
}

/**
 * The only door between the agent and the operating system's UI.
 *
 * Every public method follows the same shape: resolve the target window, ask the
 * PolicyEngine whether this action on this executable is permitted, audit the outcome,
 * then — and only then — call the driver. A denial is thrown as `DesktopDeniedError`
 * and turned into a structured tool result by the tool layer.
 */
export class DesktopController {
  readonly driver: DesktopDriver;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly audit: AuditLog,
    private readonly options: DesktopControllerOptions,
  ) {
    this.driver =
      options.driver === 'mock' || process.platform !== 'win32' ? new MockDriver() : new WindowsDriver();
  }

  get driverName(): string {
    return this.driver.name;
  }

  /* ------------------------------------------------------------- discovery */

  async listWindows(filter?: { app?: string; permittedOnly?: boolean }): Promise<WindowSummary[]> {
    const windows = await this.driver.listWindows();
    const summaries: WindowSummary[] = windows.map((w) => {
      const rule = w.exe ? this.policy.findAppByExe(w.exe) : undefined;
      return {
        ...w,
        appId: rule?.id,
        permitted: Boolean(rule) && !this.policy.isDeniedExe(w.exe ?? ''),
        actions: rule?.actions ?? [],
      };
    });
    const scoped = filter?.app
      ? summaries.filter((w) => w.appId?.toLowerCase() === filter.app?.toLowerCase())
      : summaries;
    return filter?.permittedOnly ? scoped.filter((w) => w.permitted) : scoped;
  }

  /** Apps the policy allows, whether or not they are currently running. */
  listApps() {
    return this.policy.get().allowedApps.map((rule) => ({
      id: rule.id,
      name: rule.name,
      exe: rule.exe,
      actions: rule.actions,
      autoApprove: rule.autoApprove === true,
    }));
  }

  /**
   * app id → the window handle that app last resolved to. An `app` target that already
   * resolved to a live window keeps addressing *that* window, so `type`, `read` and
   * `screenshot` cannot drift onto a different instance of the same executable.
   */
  private readonly bound = new Map<string, string>();

  private bind(appId: string | undefined, window: WindowInfo | undefined): void {
    if (appId && window) this.bound.set(appId, window.handle);
  }

  private matchesRule(window: WindowInfo, rule: { exe: string[] }): boolean {
    return rule.exe.some((exe) => exe.toLowerCase() === (window.exe ?? '').toLowerCase());
  }

  /* ---------------------------------------------------------------- launch */

  async launch(appId: string, args: string[] = []): Promise<LaunchResult & { app: string; exe: string }> {
    const rule = this.policy.findApp(appId);
    if (!rule) {
      this.record('launch', 'denied', { app: appId, detail: 'app not in permissible list' });
      throw new DesktopDeniedError(`"${appId}" is not in the permissible-application list`, {
        allowed: false,
        reason: 'unknown app',
        requiresApproval: false,
      });
    }
    if (!rule.actions.includes('launch')) {
      this.record('launch', 'denied', { app: rule.id, detail: 'launch not permitted for this app' });
      throw new DesktopDeniedError(`launch is not permitted for "${rule.id}"`, {
        allowed: false,
        reason: 'action not allowed',
        requiresApproval: false,
      });
    }
    const exePath = this.resolveExecutable(rule.exe, rule.allowedPaths);
    if (!exePath) {
      this.record('launch', 'failed', { app: rule.id, detail: 'executable not found' });
      throw new DesktopError(`could not find any of ${rule.exe.join(', ')} to launch "${rule.id}"`);
    }
    const decision = this.policy.evaluateLaunch(rule, exePath);
    if (!decision.allowed) {
      this.record('launch', 'denied', { app: rule.id, target: exePath, detail: decision.reason });
      throw new DesktopDeniedError(decision.reason, decision);
    }
    const launched = await this.driver.launch(exePath, args);
    // Bind the app to the window the driver actually found *after* the spawn: with
    // single-instance apps (Win11 tabbed Notepad) that is the running window, not the
    // spawner process, and every later `app` call must keep addressing it.
    this.bind(rule.id, launched.window);
    this.record('launch', 'allowed', { app: rule.id, target: exePath, detail: launched.detail });
    return { ...launched, app: rule.id, exe: exePath };
  }

  /* ------------------------------------------------------- window actions */

  async focus(target: Target): Promise<WindowInfo> {
    // `activate` verifies the window is really foreground and returns it once the
    // activation settled: that is the identity every later call must address.
    return this.windowAction('focus', target, (w) => this.driver.activate(w.handle));
  }
  async close(target: Target): Promise<WindowInfo> {
    return this.windowAction('close', target, async (w) => {
      await this.driver.close(w.handle);
      return w;
    });
  }

  /**
   * Pointer click at absolute screen coordinates — the same space as `UiNode.bounds`, so a
   * point read from the automation tree can be replayed as-is. Used for controls that expose
   * no InvokePattern (custom canvases, charts, hover menus).
   */
  async click(
    target: Target,
    x: number,
    y: number,
  ): Promise<{ window: WindowInfo; point: { x: number; y: number } }> {
    return this.windowAction('click', target, async (w) => ({
      window: w,
      point: await this.driver.click(w.handle, x, y),
    }));
  }

  /** Resizes the window frame; the returned size is what the window manager actually applied. */
  async resize(
    target: Target,
    width: number,
    height: number,
  ): Promise<{ window: WindowInfo; size: { width: number; height: number } }> {
    return this.windowAction('resize', target, async (w) => ({
      window: w,
      size: await this.driver.resize(w.handle, width, height),
    }));
  }

  async read(target: Target, maxDepth = 6, maxNodes = 250): Promise<UiTreeResult> {
    return this.windowAction('read', target, (w) =>
      this.driver.uiTree(w.handle, maxDepth, maxNodes),
    );
  }
  async invoke(target: Target, selector: ElementSelector): Promise<{ window: WindowInfo; detail: string }> {
    this.requireInput(target);
    return this.windowAction('invoke', target, async (w) => {
      const live = await this.driver.activate(w.handle);
      const res = await this.driver.invoke(live.handle, selector);
      if (!res.ok) {
        // A pattern that did not fire is a failed call, not a success with a note.
        throw new DesktopError(`invoke failed on "${live.title}" [${live.handle}]: ${res.detail}`);
      }
      return { window: live, detail: res.detail };
    });
  }
  async setValue(
    target: Target,
    selector: ElementSelector,
    value: string,
  ): Promise<{ window: WindowInfo; detail: string }> {
    this.requireInput(target);
    return this.windowAction('invoke', target, async (w) => {
      const live = await this.driver.activate(w.handle);
      const res = await this.driver.setValue(live.handle, selector, value);
      if (!res.ok) {
        throw new DesktopError(`set_value failed on "${live.title}" [${live.handle}]: ${res.detail}`);
      }
      return { window: live, detail: res.detail };
    });
  }
  async typeText(target: Target, text: string): Promise<{ window: WindowInfo; result: TypeResult }> {
    this.requireInput(target);
    // The driver proves the target (alive, foreground) *before* it sends anything and
    // reads the document back afterwards, so the caller can see what actually landed.
    return this.windowAction('type', target, async (w) => ({
      window: w,
      result: await this.driver.typeText(w.handle, text),
    }));
  }
  async sendKeys(target: Target, keys: string): Promise<{ window: WindowInfo; result: TypeResult }> {
    this.requireInput(target);
    return this.windowAction('key', target, async (w) => ({
      window: w,
      result: await this.driver.sendKeys(w.handle, keys),
    }));
  }
  /** Reads text back out of the window — the only proof a mutation landed. */
  async readText(
    target: Target,
    selector?: ElementSelector,
  ): Promise<{ window: WindowInfo; text: TextReadback }> {
    return this.windowAction('read', target, async (w) => ({
      window: w,
      text: await this.driver.readText(w.handle, selector),
    }));
  }

  /**
   * Window-scoped capture. The driver either returns pixels of *this* window or throws
   * with the reason it cannot (cloaked, minimised, hidden, no area) — there is no
   * screen-region substitute left to fall back to.
   */
  async screenshot(target: Target): Promise<ScreenshotResult & { window: WindowInfo }> {
    return this.windowAction('screenshot', target, async (w) => ({
      window: w,
      ...(await this.driver.screenshot(w.handle)),
    }));
  }
  /* -------------------------------------------------------------- internals */

  private requireInput(target: Target): void {
    if (!this.options.allowInput) {
      throw new DesktopDeniedError('desktop input is disabled (desktop.allowInput=false)', {
        allowed: false,
        reason: 'input disabled',
        requiresApproval: false,
      });
    }
    void target;
  }

  private async windowAction<T>(
    action: DesktopAction,
    target: Target,
    run: (window: WindowInfo) => Promise<T>,
  ): Promise<T> {
    const window = await this.resolveWindow(target);
    const decision = this.policy.evaluateDesktop(action, {
      appId: target.app,
      exe: window.exe,
      title: window.title,
    });
    if (!decision.allowed) {
      this.record(action, 'denied', {
        app: decision.rule?.id ?? target.app,
        target: window.title,
        detail: decision.reason,
      });
      throw new DesktopDeniedError(decision.reason, decision);
    }
    try {
      const result = await run(window);
      this.record(action, 'allowed', {
        app: decision.rule?.id ?? target.app,
        target: `${window.title} [${window.handle}]`,
        detail: decision.reason,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.record(action, 'failed', { app: decision.rule?.id ?? target.app, target: window.title, detail: message });
      throw err instanceof DesktopDeniedError ? err : new DesktopError(message);
    }
  }

  /** Resolve `{handle}` or `{app}` to a live window, preferring the foreground one. */
  private async resolveWindow(target: Target): Promise<WindowInfo> {
    if (target.handle) {
      const found = await this.driver.resolveWindow(target.handle);
      if (!found) {
        throw new DesktopError(
          `window handle ${target.handle} is gone — no window exists with that handle any more. ` +
            'Call desktop_list_windows again; this call deliberately does not fall back to another ' +
            'window.',
        );
      }
      return found;
    }
    if (!target.app) throw new DesktopError('either `app` or `handle` is required');

    const rule = this.policy.findApp(target.app);
    if (!rule) {
      this.record('focus', 'denied', { app: target.app, detail: 'app not in permissible list' });
      throw new DesktopDeniedError(`"${target.app}" is not in the permissible-application list`, {
        allowed: false,
        reason: 'unknown app',
        requiresApproval: false,
      });
    }

    // Sticky resolution: an app that already resolved to a live window keeps that
    // window, so a later call cannot silently address a sibling instance.
    const boundHandle = this.bound.get(rule.id);
    if (boundHandle) {
      const bound = await this.driver.resolveWindow(boundHandle);
      if (bound && this.matchesRule(bound, rule)) return bound;
      this.bound.delete(rule.id);
    }

    const windows = await this.driver.listWindows();
    const matches = windows.filter((w) => this.matchesRule(w, rule));
    const titled = rule.windowTitlePattern
      ? matches.filter((w) => new RegExp(rule.windowTitlePattern!, 'i').test(w.title))
      : matches;
    if (!titled.length) {
      throw new DesktopError(
        `"${target.app}" is not running — launch it with desktop_launch first (windows seen: ${
          windows.length ? windows.map((w) => w.exe).join(', ') : 'none'
        })`,
      );
    }
    const foreground = titled.filter((w) => w.isForeground);
    if (foreground.length === 1) {
      this.bind(rule.id, foreground[0]);
      return foreground[0];
    }
    if (titled.length === 1) {
      this.bind(rule.id, titled[0]);
      return titled[0];
    }
    // Several windows, none of them foreground: refusing is the only safe answer —
    // guessing here is what let keystrokes land in a document nobody asked about.
    throw new DesktopError(
      `"${target.app}" has ${titled.length} candidate windows and none is in the foreground — ` +
        'pass an explicit handle from desktop_list_windows. Candidates:\n' +
        titled
          .map(
            (w) =>
              `  ${w.handle}  pid ${w.processId}  "${w.title}"${w.isMinimized ? ' (minimized)' : ''}${
                w.isCloaked ? ' (cloaked)' : ''
              }`,
          )
          .join('\n'),
    );
  }
  /** Locate an executable on PATH and the usual Windows install roots. */
  private resolveExecutable(names: string[], allowedPaths?: string[]): string | undefined {
    const dirs: string[] = [];
    if (allowedPaths?.length) dirs.push(...allowedPaths);
    dirs.push(...(process.env.PATH ?? '').split(';').filter(Boolean));
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
    dirs.push(
      sysRoot,
      join(sysRoot, 'System32'),
      programFiles,
      programFilesX86,
      join(localAppData, 'Microsoft', 'WindowsApps'),
    );

    for (const name of names) {
      if (/^[A-Za-z]:\\/.test(name) && existsSync(name)) return resolve(name);
      for (const dir of dirs) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return resolve(candidate);
      }
    }
    return undefined;
  }

  private record(
    action: AuditEntry['action'],
    outcome: AuditEntry['outcome'],
    extra: { app?: string; target?: string; detail?: string; sessionId?: string },
  ): void {
    const entry = this.audit.record({
      action,
      outcome,
      app: extra.app,
      target: extra.target,
      detail: extra.detail,
      sessionId: extra.sessionId,
    });
    this.options.onAudit?.(entry);
  }

  /** Human-readable policy summary injected into the system prompt. */
  describe(): string {
    const apps = this.listApps();
    if (!apps.length) return 'No desktop applications are permitted by policy.';
    return apps.map((a) => `- ${a.id} (${a.name}): ${a.actions.join(', ')}`).join('\n');
  }

  /** Basename helper used by the tool layer for display. */
  static exeName(path: string): string {
    return basename(path);
  }
}
