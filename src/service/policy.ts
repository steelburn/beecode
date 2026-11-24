import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { BROWSER_ACTIONS, type BrowserAction } from '../shared/browser';
import { DEFAULT_SHELL_RUNTIMES, defaultPolicy } from '../shared/defaults';
import type { AppRule, BrowserPolicy, DesktopAction, PolicyDocument } from '../shared/protocol';
import { POLICY_DOCUMENT_VERSION } from '../shared/protocol';
import { writeJsonFile } from './logger';

export interface PolicyDecision {
  allowed: boolean;
  /** Machine-readable reason, surfaced on the approval card and in the audit log. */
  reason: string;
  rule?: AppRule;
  /** True when the tool gate should ask the user instead of executing right away. */
  requiresApproval: boolean;
}

const ALLOW = (rule: AppRule, reason: string, requiresApproval: boolean): PolicyDecision => ({
  allowed: true,
  reason,
  rule,
  requiresApproval,
});
const DENY = (reason: string): PolicyDecision => ({ allowed: false, reason, requiresApproval: false });

/**
 * Widens a stored policy to the actions the current build grants by default.
 *
 * This is what `POLICY_DOCUMENT_VERSION` is for: a user who allowed Calculator before
 * `desktop_click` and `desktop_resize` existed would otherwise sit on a policy that silently
 * denies them. Only rules that still describe a curated app (same id *and* a shared exe) are
 * widened, and only by actions the curated rule itself grants — a hand-edited or repointed
 * rule is left exactly as the user wrote it.
 */
/**
 * Adds the runtimes the current build grants to a stored shell allow-list.
 *
 * A union of the *version-4 additions* only: re-seeding the whole default list would undo a
 * prefix the user removed on purpose, while adding nothing keeps denying the interpreter
 * beeCode installs into its own resources folder.
 */
function withDefaultRuntimes(commands: string[]): string[] {
  const present = new Set(commands.map((command) => command.trim().toLowerCase()));
  const added = DEFAULT_SHELL_RUNTIMES.filter((name) => !present.has(name));
  return added.length ? [...commands, ...added] : commands;
}

export function migratePolicy(parsed: PolicyDocument): PolicyDocument {
  const from = parsed.version ?? 1;
  if (from >= POLICY_DOCUMENT_VERSION) return parsed;
  const curated = new Map(defaultPolicy().allowedApps.map((rule) => [rule.id, rule]));
  const allowedApps = parsed.allowedApps.map((rule) => {
    const base = curated.get(rule.id);
    if (!base) return rule;
    const exe = (rule.exe ?? []).map((name) => name.toLowerCase());
    if (!base.exe.some((name) => exe.includes(name.toLowerCase()))) return rule;
    const missing = base.actions.filter((action) => !rule.actions.includes(action));
    if (!missing.length) return rule;
    return { ...rule, actions: [...rule.actions, ...missing] };
  });
  // A policy written before the internal browser existed has no `browser` block: fill
  // it from the defaults rather than leaving every `browser_*` call to crash on undefined.
  const browser = { ...defaultPolicy().browser, ...(parsed.browser ?? {}) };
  const shell = parsed.shell
    ? { ...parsed.shell, allowedCommands: withDefaultRuntimes(parsed.shell.allowedCommands ?? []) }
    : parsed.shell;
  return { ...parsed, version: POLICY_DOCUMENT_VERSION, allowedApps, browser, shell };
}

/**
 * Central permission gate for everything that reaches outside the agent process.
 *
 * The model never decides what it may touch: every desktop/shell/file call is
 * re-evaluated here against the policy document, and the denial reason is returned
 * to the model as a normal tool result so it can adapt instead of retrying blindly.
 */
export class PolicyEngine {
  private policy: PolicyDocument;
  private workspaceRoots: string[];

  constructor(policy: PolicyDocument, workspaceRoots: string[]) {
    this.policy = policy;
    this.workspaceRoots = workspaceRoots.map((p) => resolve(p));
  }

  async load(file: string): Promise<void> {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as PolicyDocument;
      if (parsed && Array.isArray(parsed.allowedApps)) {
        this.policy = migratePolicy(parsed);
        if (this.policy.version !== parsed.version) {
          try {
            // Persist the migration so `policy.json` shows what the running build grants instead
            // of being re-migrated on every start. A failed write is not fatal — the in-memory
            // policy is already migrated.
            await this.save(file);
          } catch {
            /* keep the migrated policy in memory */
          }
        }
      }
    } catch {
      this.policy = defaultPolicy();
      await this.save(file);
    }
  }

  async save(file: string): Promise<void> {
    this.policy = { ...this.policy, updatedAt: new Date().toISOString() };
    await writeJsonFile(file, this.policy);
  }

  get(): PolicyDocument {
    return this.policy;
  }

  set(policy: PolicyDocument): PolicyDocument {
    this.policy = { ...policy, defaultDecision: 'deny', updatedAt: new Date().toISOString() };
    return this.policy;
  }

  setWorkspaceRoots(roots: string[]): void {
    this.workspaceRoots = roots.map((p) => resolve(p));
  }

  findApp(appId: string): AppRule | undefined {
    return this.policy.allowedApps.find((a) => a.id.toLowerCase() === appId.toLowerCase());
  }

  findAppByExe(exeName: string): AppRule | undefined {
    const exe = basename(exeName).toLowerCase();
    return this.policy.allowedApps.find((a) => a.exe.some((e) => e.toLowerCase() === exe));
  }

  isDeniedExe(exeName: string): boolean {
    const exe = basename(exeName).toLowerCase();
    return this.policy.deniedExe.some((d) => d.toLowerCase() === exe);
  }

  /**
   * Evaluate a desktop action against a target app. `exe` is the resolved process
   * image name when known (window-based actions), `appId` the rule id used by the
   * model when launching by catalog name.
   */
  evaluateDesktop(action: DesktopAction, target: { appId?: string; exe?: string; title?: string }): PolicyDecision {
    if (!this.policy.allowedApps.length) return DENY('policy contains no allowed applications');

    let rule: AppRule | undefined;
    if (target.appId) rule = this.findApp(target.appId);
    if (!rule && target.exe) rule = this.findAppByExe(target.exe);
    if (!rule && target.title) {
      rule = this.policy.allowedApps.find(
        (a) => a.windowTitlePattern && new RegExp(a.windowTitlePattern, 'i').test(target.title ?? ''),
      );
    }

    if (target.exe && this.isDeniedExe(target.exe)) {
      return DENY(`${basename(target.exe)} is on the denied-executable list`);
    }
    if (!rule) {
      const what = target.appId ?? target.exe ?? target.title ?? 'unknown target';
      return DENY(`"${what}" is not in the permissible-application list`);
    }
    if (target.exe && !rule.exe.some((e) => e.toLowerCase() === basename(target.exe!).toLowerCase())) {
      return DENY(`process image ${target.exe} does not match app rule "${rule.id}"`);
    }
    if (target.title && rule.windowTitlePattern && !new RegExp(rule.windowTitlePattern, 'i').test(target.title)) {
      return DENY(`window title "${target.title}" does not match app rule "${rule.id}" pattern`);
    }
    if (!rule.actions.includes(action)) {
      return DENY(`action "${action}" is not permitted for "${rule.id}" (allowed: ${rule.actions.join(', ')})`);
    }
    return ALLOW(rule, `${action} permitted for "${rule.id}"`, rule.autoApprove !== true);
  }

  /** Guard for launching: the resolved executable must be absolute and match the rule. */
  evaluateLaunch(rule: AppRule, exePath: string): PolicyDecision {
    if (!isAbsolute(exePath)) return DENY(`launch path must be absolute: ${exePath}`);
    if (this.isDeniedExe(exePath)) return DENY(`${basename(exePath)} is on the denied-executable list`);
    if (!rule.exe.some((e) => e.toLowerCase() === basename(exePath).toLowerCase())) {
      return DENY(`${basename(exePath)} is not an executable of app rule "${rule.id}"`);
    }
    if (rule.allowedPaths?.length) {
      const ok = rule.allowedPaths.some((dir) => isInside(resolve(dir), resolve(exePath)));
      if (!ok) return DENY(`${exePath} is outside the allowed paths for "${rule.id}"`);
    }
    return ALLOW(rule, `launch permitted for "${rule.id}"`, rule.autoApprove !== true);
  }

  evaluateShell(command: string): PolicyDecision {
    const cfg = this.policy.shell;
    if (!cfg.enabled) return DENY('shell access is disabled by policy');
    const normalized = command.trim().toLowerCase();
    if (!normalized) return DENY('empty command');
    const forms = this.shellForms(normalized);
    const blocked = cfg.blocked.find((b) => forms.some((form) => form.includes(b.toLowerCase())));
    if (blocked) return DENY(`command contains blocked pattern "${blocked}"`);
    if (
      cfg.allowedCommands.length &&
      !cfg.allowedCommands.some((p) => forms.some((form) => form.startsWith(p.toLowerCase())))
    ) {
      return DENY(`command does not start with an allowed prefix (${cfg.allowedCommands.join(', ')})`);
    }
    return { allowed: true, reason: 'command matches shell policy', requiresApproval: true };
  }

  /**
   * The command as typed, plus a variant with a leading absolute executable path reduced to its
   * bare name — `"C:\Program Files\beeCode\resources\python\python.exe" -m venv .venv` becomes
   * `python -m venv .venv`.
   *
   * Both the allow prefixes and the block patterns are written against names (`python`, `curl`),
   * so without this an allowed interpreter invoked by its full path was rejected for starting
   * with `c:` while an absolute `curl.exe` slipped past the block list.
   */
  private shellForms(command: string): string[] {
    const leading = /^(?:"([^"]+)"|(\S+))(?:\s+([\s\S]*))?$/.exec(command);
    const target = leading?.[1] ?? leading?.[2] ?? '';
    if (!/[\\/]/.test(target)) return [command];
    const name = (target.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
    if (!name) return [command];
    const rest = (leading?.[3] ?? '').trim();
    return [command, rest ? `${name} ${rest}` : name];
  }

  /**
   * `extraRoots` are roots the caller vouches for per call — the session working
   * directory, so a session pointed at a folder the user picked stays inside its own
   * workspace without widening the policy for every other session.
   */
  evaluateFile(targetPath: string, write: boolean, extraRoots: string[] = []): PolicyDecision {
    const cfg = this.policy.filesystem;
    const abs = resolve(targetPath);
    const sessionRoots = extraRoots.map((r) => resolve(r));
    if (write && !cfg.writable) return DENY('file writes are disabled by policy');

    if (cfg.workspaceOnly) {
      const roots = [...this.workspaceRoots, ...sessionRoots, ...cfg.allowedRoots.map((r) => resolve(r))];
      if (!roots.some((root) => isInside(root, abs))) {
        return DENY(`${abs} is outside the workspace (workspace-only file policy)`);
      }
      return { allowed: true, reason: 'path is inside the workspace', requiresApproval: write };
    }
    const roots = [...sessionRoots, ...cfg.allowedRoots.map((r) => resolve(r))];
    if (roots.length && !roots.some((root) => isInside(root, abs))) {
      return DENY(`${abs} is outside the configured allowed roots`);
    }
    return { allowed: true, reason: 'path is allowed by policy', requiresApproval: write };
  }

  /**
   * The browser section as the rest of the service sees it — needed by tool previews, which
   * must decide whether to raise an approval card before a page (and its URL) exists.
   */
  browserPolicy(): BrowserPolicy {
    return this.policy.browser ?? defaultPolicy().browser;
  }

  /**
   * Evaluate a navigation or an interaction in the internal (sandboxed) browser.
   *
   * The sandbox is why this is a policy check and not a hard approval gate: the view has no
   * Node, no shell, no downloads and an in-memory session, so the blast radius of a click is
   * the request itself. Deny rules still win, `allowedHosts` narrows reach when `allowAnyHost`
   * is off, and `allowInput: false` degrades the browser to a read-only viewer.
   */
  evaluateBrowser(url: string, action: BrowserAction = 'navigate'): PolicyDecision {
    const cfg = this.policy.browser ?? defaultPolicy().browser;
    if (!cfg.enabled) return DENY('the internal browser is disabled by policy');
    if (!BROWSER_ACTIONS.includes(action)) return DENY(`unknown browser action "${action}"`);

    const interactive = action === 'click' || action === 'type' || action === 'key';
    if (interactive && !cfg.allowInput) {
      return DENY(`browser_${action} is disabled by policy (browser.allowInput is false)`);
    }

    const target = (url ?? '').trim();
    // A fresh tab has no host: nothing to reach, nothing to deny.
    if (target === '' || target === 'about:blank') {
      return { allowed: true, reason: 'empty tab is always permitted', requiresApproval: false };
    }

    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return DENY(`"${target}" is not an absolute URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DENY(`scheme "${parsed.protocol}" is not permitted in the internal browser`);
    }

    const host = parsed.hostname.toLowerCase();
    const denied = cfg.deniedHosts.find((pattern) => hostMatches(pattern, host));
    if (denied) return DENY(`${host} matches denied host "${denied}"`);
    if (!cfg.allowAnyHost && !cfg.allowedHosts.some((pattern) => hostMatches(pattern, host))) {
      return DENY(`${host} is not in the browser allow-list`);
    }

    return {
      allowed: true,
      reason: `${action} permitted on ${host}`,
      requiresApproval: cfg.requireApproval,
    };
  }

  /** Apps the agent may know about, for the system prompt. */
  describeAllowedApps(): string {
    return this.policy.allowedApps
      .map((a) => `- ${a.id} (${a.name}) actions: ${a.actions.join(', ')}${a.autoApprove ? ' [auto-approved]' : ''}`)
      .join('\n');
  }
}

/**
 * Host matching for the browser policy: exact, or `*.example.com` for a domain and its
 * subdomains. Matching is suffix-aware but label-aware — `evil-github.com` never matches
 * `github.com`, and a bare pattern does not silently cover subdomains.
 */
export function hostMatches(pattern: string, host: string): boolean {
  const p = (pattern ?? '').trim().toLowerCase().replace(/^\.+/, '');
  const h = (host ?? '').trim().toLowerCase();
  if (!p || !h) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === p;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}
