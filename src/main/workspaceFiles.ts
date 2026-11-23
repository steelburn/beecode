import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import type { CopyIntoWorkspaceResult } from '../shared/bridge';

/**
 * Copy paths dropped onto the window into the workspace.
 *
 * Everything happens in the main process — the renderer has no file-system access — and
 * the copy is best effort: one unreadable path must not lose the rest of the drop. The
 * destination always stays inside the workspace, and an existing file is never
 * overwritten: the name is suffixed ` (2)` instead, which is what a drop implies.
 */
export async function copyIntoWorkspace(
  paths: string[],
  workspace: string,
  targetDir?: string,
): Promise<CopyIntoWorkspaceResult> {
  const result: CopyIntoWorkspaceResult = { copied: [], skipped: [], errors: [] };
  if (!workspace.trim()) {
    for (const candidate of paths) {
      result.errors.push({ path: candidate, error: 'no workspace folder is set' });
    }
    return result;
  }

  const rootDir = path.resolve(workspace.trim());
  const target = resolveTarget(rootDir, targetDir);

  for (const candidate of paths) {
    const from = path.resolve(candidate);
    try {
      if (!existsSync(from)) {
        result.errors.push({ path: from, error: 'no such file or folder' });
        continue;
      }
      // Dropping a file back onto the folder it already lives in is a no-op, not a copy.
      if (isInside(from, target)) {
        result.skipped.push(from);
        continue;
      }
      const to = uniquePath(path.join(target, path.basename(from)));
      await cp(from, to, { recursive: true, force: false, errorOnExist: false });
      result.copied.push({ from, to: path.relative(rootDir, to) });
    } catch (error) {
      result.errors.push({ path: from, error: (error as Error).message });
    }
  }
  return result;
}

/**
 * The drop target, clamped to the workspace: the explorer may hand over a stale path and
 * the renderer is never trusted to name a destination, so anything outside falls back to
 * the workspace root.
 */
function resolveTarget(rootDir: string, targetDir?: string): string {
  if (!targetDir?.trim()) return rootDir;
  const candidate = path.resolve(rootDir, targetDir);
  return isInside(candidate, rootDir) ? candidate : rootDir;
}

/** Windows compares paths case-insensitively, POSIX does not. */
function normalize(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(candidate: string, parent: string): boolean {
  const child = normalize(candidate);
  const base = normalize(parent);
  if (child === base) return true;
  return child.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
}

/** `report.txt` → `report (2).txt` when the name is taken, then `report (3).txt`, … */
function uniquePath(candidate: string): string {
  if (!existsSync(candidate)) return candidate;
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const base = path.basename(candidate, ext);
  for (let n = 2; n < 1000; n += 1) {
    const next = path.join(dir, `${base} (${n})${ext}`);
    if (!existsSync(next)) return next;
  }
  // Nothing free: return the original, where `cp` fails loudly instead of clobbering.
  return candidate;
}
