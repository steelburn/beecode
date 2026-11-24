import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * One lookup path for every executable beeCode starts.
 *
 * A packaged GUI app inherits whatever `PATH` the desktop session handed it: per-user
 * installs (`%LOCALAPPDATA%\Programs\Python\Python312`), npm global shims, scoop/choco
 * shims and `Program Files` subdirectories are routinely missing from it. Looking a
 * command up only on `PATH` therefore reports "not installed" for tools that are very
 * much installed. Everything that resolves a command — the shell tool, the subagent
 * adapters, the desktop driver — goes through this module so a tool is found the same
 * way everywhere.
 */

/** Extensions a bare command name is tried with on Windows, PATHEXT first. */
const WIN_EXE_EXT_DEFAULT = ['.exe', '.cmd', '.bat', '.com'];

/** Directories that hold a Python interpreter, so `findExecutable('python')` sees installs off PATH. */
let cachedSearchDirs: string[] | undefined;
let cachedPathKey: string | undefined;

/** Drop the memoized directory lists. Tests and long-lived processes call this. */
export function resetExecutableCache(): void {
  cachedSearchDirs = undefined;
  cachedPathKey = undefined;
}

function unique(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dirs) {
    const dir = raw.trim();
    if (!dir) continue;
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function exists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** `PATH` entries in order, without blanks or duplicates. */
export function pathDirs(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  return unique(raw.split(delimiter));
}

/**
 * Where installers put executables, per platform.
 *
 * Only the conventional locations are listed — this is a fallback for a `PATH` that a
 * desktop session truncated, not a filesystem-wide scan.
 */
export function osInstallDirs(): string[] {
  const env = process.env;
  const home = homedir();
  const dirs: string[] = [];

  if (process.platform === 'win32') {
    const sysRoot = env.SystemRoot ?? 'C:\\Windows';
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const programData = env.ProgramData ?? 'C:\\ProgramData';

    dirs.push(
      sysRoot,
      join(sysRoot, 'System32'),
      join(sysRoot, 'System32', 'Wbem'),
      join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      programFiles,
      programFilesX86,
      join(programFiles, 'nodejs'),
      join(programFiles, 'Git', 'cmd'),
      join(programFiles, 'Git', 'usr', 'bin'),
      join(localAppData, 'Microsoft', 'WindowsApps'),
      join(localAppData, 'Programs'),
      join(appData, 'npm'),
      join(home, 'scoop', 'shims'),
      join(programData, 'chocolatey', 'bin'),
      join(home, '.local', 'bin'),
      join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps'),
    );

    // Installers name their versioned folders themselves (`Python312`, `Python311`, …), so
    // the folders are discovered rather than guessed.
    for (const root of [join(localAppData, 'Programs'), programFiles, programFilesX86, home]) {
      for (const entry of safeReaddir(root)) {
        if (/^python\d*/i.test(entry)) {
          dirs.push(join(root, entry), join(root, entry, 'Scripts'));
        }
      }
    }
    for (const entry of safeReaddir(join(localAppData, 'Programs'))) {
      dirs.push(join(localAppData, 'Programs', entry), join(localAppData, 'Programs', entry, 'bin'));
    }
    for (const entry of safeReaddir(join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps'))) {
      dirs.push(join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps', entry));
    }
    for (const anaconda of ['anaconda3', 'miniconda3', 'miniforge3']) {
      dirs.push(join(home, anaconda), join(home, anaconda, 'Scripts'), join(home, anaconda, 'Library', 'bin'));
    }
  } else {
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/snap/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/opt/local/bin',
      '/usr/local/sbin',
      join(home, '.local', 'bin'),
      join(home, '.npm-global', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, 'Library', 'Python'),
    );
    // pyenv/asdf keep one directory per installed interpreter.
    for (const root of [join(home, '.pyenv', 'versions'), join(home, '.asdf', 'installs', 'python')]) {
      for (const entry of safeReaddir(root)) dirs.push(join(root, entry, 'bin'));
    }
  }

  return unique(dirs.filter(exists));
}

/** Every directory a lookup considers: explicit extras, `PATH`, then the install roots. */
export function searchDirs(extra: readonly string[] = []): string[] {
  const rawPath = process.env.PATH ?? process.env.Path ?? '';
  if (!cachedSearchDirs || cachedPathKey !== rawPath) {
    const all = unique([...pathDirs(), ...osInstallDirs()]);
    // The memo is rebuilt whenever PATH changes; extras are cheap and stay per call.
    cachedSearchDirs = all;
    cachedPathKey = rawPath;
    return unique([...extra, ...all]);
  }
  return unique([...extra, ...cachedSearchDirs]);
}

function windowsExtensions(): string[] {
  const fromEnv = (process.env.PATHEXT ?? '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return unique([...fromEnv, ...WIN_EXE_EXT_DEFAULT]);
}

/** The names a bare command is tried under, in order. */
function candidateNames(name: string): string[] {
  if (process.platform !== 'win32') return [name];
  const lower = name.toLowerCase();
  const names = [name];
  if (windowsExtensions().some((ext) => lower.endsWith(ext))) return names;
  for (const ext of windowsExtensions()) names.push(name + ext);
  return names;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface FindExecutableOptions {
  /** Directories to search before `PATH` (a bundled runtime, a project `node_modules/.bin`). */
  extraDirs?: readonly string[];
}

/**
 * Locate `name` and return its absolute path, or `undefined` when it is nowhere.
 *
 * `name` may be a bare command (`python`), a relative or an absolute path; on Windows the
 * PATHEXT suffixes are appended to a bare name, which is what `where` does and what
 * `spawn('python')` needs to succeed.
 */
export function findExecutable(name: string, options: FindExecutableOptions = {}): string | undefined {
  const command = name.trim();
  if (!command) return undefined;
  const names = candidateNames(command);

  const explicit = command.includes('/') || command.includes('\\') || isAbsolute(command);
  if (explicit) {
    const base = isAbsolute(command) ? command : resolve(command);
    for (const candidate of candidateNames(base)) {
      if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
  }

  for (const dir of searchDirs(options.extraDirs)) {
    for (const candidate of names) {
      const file = join(dir, candidate);
      if (isExecutableFile(file)) return file;
    }
  }
  return undefined;
}

/** True when `name` resolves to something this machine can start. */
export function hasExecutable(name: string, options: FindExecutableOptions = {}): boolean {
  return findExecutable(name, options) !== undefined;
}
