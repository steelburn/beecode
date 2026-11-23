import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import type { PluginManifest } from '../../plugins/types';
import { normalizeManifest } from '../../plugins/host';
import { readZip } from '../skills/zip';

/** Manifest every plugin folder carries; the loader reads the same file. */
const MANIFEST = 'plugin.json';
/** Entry points the loader accepts, in its own order. */
const ENTRY_POINTS = ['plugin.js', 'index.js', 'plugin.cjs'];
/** Cap on an archive, in bytes. */
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
/** Cap on one extracted file, in bytes. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Cap on the file count of one plugin, so a runaway archive cannot fill the root. */
const MAX_FILES = 500;
/** Folders that are never part of a plugin and would only bloat the copy. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

export interface PluginInstallOptions {
  /** Plugin roots from config; the first one is where an install lands. */
  dirs: string[];
  /** Used when no root is configured — normally `~/.beecode/plugins`. */
  fallbackRoot: string;
}

export interface PluginInstallOutcome {
  /** Plugin ids written under the plugin root. */
  installed: string[];
  /** Sources that were refused, each with the reason, so the caller can name them. */
  skipped: { path: string; reason: string }[];
}

/** One file of a plugin, path relative to the plugin folder (`plugin.json`, `lib/x.js`). */
interface PluginFile {
  path: string;
  data: Buffer;
}

/**
 * Installs plugins from folders and `.zip` archives into the plugin root.
 *
 * One step instead of "create a folder by hand, write a manifest and a module, edit
 * `plugins.allowExternal`, reload": the source is validated, named after its manifest and
 * copied to the root the host scans, where the caller's reload picks it up. A source
 * without a readable `plugin.json` or without an entry point is refused before anything is
 * written, and a batch never stops at the first bad path — every rejection comes back with
 * its reason.
 */
export async function installPlugins(
  paths: string[],
  options: PluginInstallOptions,
): Promise<PluginInstallOutcome> {
  const root = resolveRoot(options);
  const installed: string[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const entry of paths) {
    const source = typeof entry === 'string' ? entry.trim() : '';
    if (!source) continue;
    try {
      const files = await readSource(source);
      const manifest = readManifest(files, source);
      const id = manifest.id;
      await writePlugin(root, id, files);
      if (!installed.includes(id)) installed.push(id);
    } catch (error) {
      skipped.push({
        path: source,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { installed, skipped };
}

/** The root an install writes to: the first configured plugin dir, else the default. */
export function pluginInstallRoot(options: PluginInstallOptions): string {
  return resolveRoot(options);
}

function resolveRoot(options: PluginInstallOptions): string {
  const configured = (options.dirs ?? []).find((dir): dir is string => !!dir && !!dir.trim());
  return resolve(configured ?? options.fallbackRoot);
}

/** Reads a folder or an archive into the file list an install writes. */
async function readSource(source: string): Promise<PluginFile[]> {
  const info = await stat(source);
  if (info.isDirectory()) return readFolder(source);

  if (!info.isFile() || extname(source).toLowerCase() !== '.zip') {
    throw new Error('only a plugin folder or a plugin .zip can be installed');
  }
  if (info.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  }
  return fromZip(readZip(await readFile(source)));
}

async function readFolder(dir: string, prefix = '', out: PluginFile[] = []): Promise<PluginFile[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await readFolder(join(dir, entry.name), path, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const data = await readFile(join(dir, entry.name));
    if (data.length > MAX_FILE_BYTES) throw new Error(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
    out.push({ path, data });
    if (out.length > MAX_FILES) throw new Error(`a plugin may carry at most ${MAX_FILES} files`);
  }
  return out;
}

/**
 * Flattens an archive. Plugin zips are usually packed as `<plugin-name>/plugin.json`, so a
 * single shared top folder is stripped; anything deeper keeps its path relative to the
 * manifest, which is what the loader expects.
 */
function fromZip(entries: { name: string; data: Buffer }[]): PluginFile[] {
  const files = entries.filter(
    (entry) => !entry.name.endsWith('/') && !entry.name.startsWith('__MACOSX/'),
  );
  if (!files.length) throw new Error('the archive is empty');
  if (files.some((entry) => !safeRelative(entry.name))) {
    throw new Error('the archive contains a path outside the plugin folder');
  }
  if (files.some((entry) => entry.data.length > MAX_FILE_BYTES)) {
    throw new Error(`a file in the archive is larger than ${MAX_FILE_BYTES} bytes`);
  }
  if (files.length > MAX_FILES) throw new Error(`a plugin may carry at most ${MAX_FILES} files`);

  const top = sharedTopFolder(files.map((entry) => entry.name));
  return files.map((entry) => ({
    path: top ? entry.name.slice(top.length + 1) : entry.name,
    data: entry.data,
  }));
}

/** The single first path segment every entry shares, or `''` when there is none. */
function sharedTopFolder(names: string[]): string {
  const first = names[0]?.split('/')[0] ?? '';
  if (!first || !names.every((name) => name.startsWith(`${first}/`))) return '';
  return first;
}

/** False for `..`, absolute paths and drive letters — nothing an install may write. */
function safeRelative(path: string): boolean {
  if (!path || isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split('/').some((segment) => segment === '..');
}

/**
 * Validates the manifest exactly like the loader does (`normalizeManifest`), and refuses a
 * plugin whose entry point is missing: writing a plugin that cannot activate would only
 * turn into a red row in the panel after the reload.
 */
function readManifest(files: PluginFile[], source: string): PluginManifest {
  const manifest = files.find((file) => file.path.toLowerCase() === MANIFEST);
  if (!manifest) throw new Error(`no ${MANIFEST} at the root of ${basename(source)}`);

  let raw: Partial<PluginManifest> & { main?: unknown };
  try {
    raw = JSON.parse(manifest.data.toString('utf8')) as Partial<PluginManifest> & { main?: unknown };
  } catch {
    throw new Error(`${MANIFEST} is not valid JSON`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${MANIFEST} must be a JSON object`);
  }

  // `main` may name any file the plugin ships; otherwise one of the defaults has to be
  // there, because the loader resolves the entry point the same way.
  const named = typeof raw.main === 'string' ? raw.main.trim() : '';
  if (named) {
    const wanted = named.replace(/^\.\//, '');
    if (!files.some((file) => file.path === wanted)) {
      throw new Error(`${MANIFEST} names main "${named}", which the plugin does not ship`);
    }
  } else if (!ENTRY_POINTS.some((name) => files.some((file) => file.path === name))) {
    throw new Error(`no entry point (${ENTRY_POINTS.join(' / ')}) in the plugin`);
  }

  return normalizeManifest(raw, source);
}

/** Writes the plugin folder, replacing an earlier install of the same id. */
async function writePlugin(root: string, id: string, files: PluginFile[]): Promise<void> {
  const dir = resolve(root, id);
  // The id becomes a folder name, so it must be one plain segment: no separators, no dot-dot.
  if (!safeRelative(id) || id.includes('/')) throw new Error(`"${id}" is not a usable plugin id`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const target = resolve(dir, ...file.path.split('/'));
    if (!safeRelative(file.path) || !target.startsWith(dir)) {
      throw new Error(`${file.path} would land outside the plugin folder`);
    }
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, file.data);
  }
}
