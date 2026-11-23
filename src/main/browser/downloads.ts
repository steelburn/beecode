/**
 * Where a page's downloads land.
 *
 * The browser is sandboxed down to "the network and nothing else", so a download is the one
 * path by which a page writes to the real machine. It stays inside that model by staying
 * inside the workspace: everything lands in `<workspace>/Downloads`, nothing is written
 * anywhere else, and a page cannot choose the directory — only a file *name* it proposed,
 * which is sanitised and de-duplicated here.
 *
 * Kept free of `electron` imports so the naming rules can be tested directly.
 */
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Sub-directory of the workspace that receives everything the internal browser downloads. */
export const DOWNLOAD_DIR_NAME = 'Downloads';

/** Longest name we keep, so the resolved path stays clear of Windows' 260-char ceiling. */
const MAX_NAME_LENGTH = 120;

/** Fallback when a page offers no usable name at all. */
const FALLBACK_NAME = 'download';

/**
 * A page-chosen filename, reduced to something that cannot escape the downloads folder:
 * no directory parts, no Windows-reserved characters, no trailing dots or spaces.
 */
export function safeDownloadName(raw: string, fallback = FALLBACK_NAME): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!cleaned) return fallback;
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  // Keep the extension chain (".tar.gz"), so a shortened name still opens with the right app.
  const tail = /(?:\.[A-Za-z0-9]{1,10}){1,2}$/.exec(cleaned)?.[0] ?? '';
  const suffix = tail.length <= 24 ? tail : '';
  return `${cleaned.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
}

/** Absolute folder that receives this workspace's downloads. */
export function downloadsDir(workspace: string): string {
  return join(workspace, DOWNLOAD_DIR_NAME);
}

/**
 * `dir/name.ext`, or `dir/name (1).ext` when that is taken — the way a browser resolves a
 * second download of the same file. `taken` is injectable so the rule can be tested without
 * touching the disk.
 */
export function uniqueDownloadPath(
  dir: string,
  filename: string,
  taken: (path: string) => boolean = (path) => existsSync(path),
): string {
  const first = join(dir, filename);
  if (!taken(first)) return first;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let index = 1; index <= 999; index += 1) {
    const candidate = join(dir, `${stem} (${index})${ext}`);
    if (!taken(candidate)) return candidate;
  }
  return join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * Reserve the path a download will be written to: create `<workspace>/Downloads` if needed
 * and pick a free name inside it. Returns undefined when there is no workspace — a download
 * is a file write on the user's machine, and without a workspace there is no folder the user
 * agreed beeCode may write to.
 */
export function reserveDownloadPath(workspace: string | undefined, filename: string): string | undefined {
  const root = (workspace ?? '').trim();
  if (!root) return undefined;
  const dir = downloadsDir(root);
  mkdirSync(dir, { recursive: true });
  return uniqueDownloadPath(dir, safeDownloadName(filename));
}
