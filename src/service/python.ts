import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { findExecutable, osInstallDirs, pathDirs } from './executables';

/**
 * The Python runtime beeCode hands to whatever it starts.
 *
 * A desktop app cannot assume an interpreter exists: a bare Windows install has none, and
 * even where one is installed its directory is often missing from the `PATH` the GUI
 * session inherited. So a runtime ships with the app (`resources/python`, unpacked outside
 * the asar) and, failing that, an OS interpreter is looked up. `childEnvironment()` puts
 * whichever was found in front of `PATH` for every child process, which is what makes
 * `shell_run` answer `python -V` instead of `'python' is not recognized`.
 */

export interface PythonRuntime {
  /** Directory to put on `PATH` so `python` / `python3` resolve to this runtime. */
  home: string;
  /** The interpreter itself. */
  executable: string;
  /** True when the interpreter ships with beeCode rather than the host OS. */
  bundled: boolean;
}

let resolved: PythonRuntime | null | undefined;
let cachedVersion: string | undefined;

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

/**
 * Where a bundled runtime may live, most specific first.
 *
 * The service bundle runs from `dist/` in a checkout and from inside `app.asar` when
 * packaged, so the checkout layout is found by walking up — the same approach
 * `version.ts` uses for `package.json`.
 */
function bundleRoots(): string[] {
  const roots: string[] = [];
  const override = process.env.BEECODE_PYTHON_HOME?.trim();
  if (override) roots.push(override);

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath) roots.push(join(resourcesPath, 'python'));

  let dir = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    roots.push(join(dir, 'resources', 'python'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return unique(roots);
}

function interpreterIn(home: string): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [join(home, 'python.exe'), join(home, 'python3.exe')]
      : [join(home, 'bin', 'python3'), join(home, 'bin', 'python')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The runtime that ships with the app, if the build included one. */
export function bundledPython(): PythonRuntime | undefined {
  for (const root of bundleRoots()) {
    const executable = interpreterIn(root);
    if (executable) {
      return { home: dirname(executable), executable, bundled: true };
    }
  }
  return undefined;
}

/** Interpreter names to try on the machine's own install, best first. */
function systemInterpreter(): PythonRuntime | undefined {
  const names = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  const dirs = unique([...pathDirs(), ...osInstallDirs()]);

  for (const name of names) {
    const found = findExecutable(name, { extraDirs: dirs });
    if (found) return { home: dirname(found), executable: found, bundled: false };
  }
  return undefined;
}

/** The interpreter beeCode will use: the bundled one, else an OS install. */
export function pythonRuntime(): PythonRuntime | undefined {
  if (resolved !== undefined) return resolved ?? undefined;
  const runtime = bundledPython() ?? systemInterpreter() ?? null;
  resolved = runtime;
  return runtime ?? undefined;
}

/** Drop the memoized runtime (tests, and a fetch that lands mid-session). */
export function resetPythonRuntime(): void {
  resolved = undefined;
  cachedVersion = undefined;
}

/**
 * Directories that must lead `PATH` for beeCode's own runtimes to win.
 *
 * The bundled interpreter comes first so behaviour does not change with the machine; the
 * `Scripts` folder is included so a `pip install` into the bundled runtime works too.
 */
export function toolPathDirs(): string[] {
  const runtime = bundledPython();
  if (!runtime) return [];
  return unique([runtime.home, join(runtime.home, 'Scripts')]);
}

/**
 * The environment for every child process beeCode starts.
 *
 * Resolution order: the bundled runtime, the inherited `PATH`, then the conventional OS
 * install roots appended — so an executable that is installed but not on the truncated
 * desktop `PATH` is still found, while the machine's own tools keep priority over the
 * fallback directories.
 */
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const inherited = (base.PATH ?? base.Path ?? '').split(delimiter);
  const merged = unique([...toolPathDirs(), ...inherited, ...osInstallDirs()]);
  env.PATH = merged.join(delimiter);
  if (process.platform === 'win32') env.Path = env.PATH;

  const runtime = pythonRuntime();
  if (runtime?.bundled) {
    // The bundled distribution resolves its own home; an inherited PYTHONHOME/PYTHONPATH
    // (a venv, an IDE) would point it at an unrelated tree and break imports.
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
    // The per-user site-packages of the machine's own Python otherwise shadows the bundled
    // one: a stale `pip 24.0` from %APPDATA%\Python\Python312 wins over the shipped
    // `pip 25.x`, and `pip install` writes where this runtime only looks by accident.
    env.PYTHONNOUSERSITE ??= '1';
  }
  env.PYTHONUTF8 ??= '1';
  env.PYTHONIOENCODING ??= 'utf-8';
  return env;
}

/** `Python 3.12.8`, read once from the interpreter. */
export function pythonVersion(): string | undefined {
  if (cachedVersion) return cachedVersion;
  const runtime = pythonRuntime();
  if (!runtime) return undefined;
  try {
    const run = spawnSync(runtime.executable, ['--version'], {
      env: childEnvironment(),
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const text = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    const match = /Python\s+(\S+)/i.exec(text);
    cachedVersion = match?.[1] ?? (text ? text.split(/\r?\n/)[0] : undefined);
  } catch {
    cachedVersion = undefined;
  }
  return cachedVersion;
}

/**
 * One line for the system prompt.
 *
 * The agent asks `python` for everything from parsing a JSON file to checking a checksum,
 * so it should know whether the command exists before it plans around it.
 */
export function pythonSummary(): string {
  const runtime = pythonRuntime();
  const version = pythonVersion();
  if (!runtime) {
    return 'none — no bundled runtime and no interpreter found on this machine; do not plan around Python';
  }
  const label = version ? `Python ${version}` : 'Python';
  if (runtime.bundled) {
    return `${label} (bundled with beeCode at ${runtime.home}; python/python3/py and pip/pip3 work in the shell tool, and python -m venv works offline — put dependencies in a workspace venv)`;
  }
  return `${label} (system interpreter at ${runtime.executable})`;
}
