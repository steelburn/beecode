import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { defaultPolicy } from '../shared/defaults';
import type { AppRule, DesktopAction, PolicyDocument } from '../shared/protocol';
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
  return { ...parsed, version: POLICY_DOCUMENT_VERSION, allowedApps };
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
      if (parsed && Array.isArray(parsed.allowedApps)) this.policy = migratePolicy(parsed);
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
    const blocked = cfg.blocked.find((b) => normalized.includes(b.toLowerCase()));
    if (blocked) return DENY(`command contains blocked pattern "${blocked}"`);
    if (cfg.allowedCommands.length && !cfg.allowedCommands.some((p) => normalized.startsWith(p.toLowerCase()))) {
      return DENY(`command does not start with an allowed prefix (${cfg.allowedCommands.join(', ')})`);
    }
    return { allowed: true, reason: 'command matches shell policy', requiresApproval: true };
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

  /** Apps the agent may know about, for the system prompt. */
  describeAllowedApps(): string {
    return this.policy.allowedApps
      .map((a) => `- ${a.id} (${a.name}) actions: ${a.actions.join(', ')}${a.autoApprove ? ' [auto-approved]' : ''}`)
      .join('\n');
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}
