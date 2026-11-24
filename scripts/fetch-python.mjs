// Vendors the Python runtime beeCode ships with.
//
// The app must not depend on the machine's Python: a bare Windows install has none, and a
// packaged GUI process often inherits a PATH that hides a per-user install. So a full CPython
// build is downloaded once, unpacked into resources/python, and copied outside the asar by
// electron-builder (see extraResources). Runs from `prepackage` and `predist`; skip it and the
// app falls back to an OS interpreter (src/service/python.ts).
//
// It used to vendor python.org's "embeddable" zip, which cannot support `pip` or `venv`: the
// embeddable distribution ships no `ensurepip`, so `python -m venv .venv` dies with
// "ensurepip is not available", and its `python3xx._pth` disables `import site`, so anything
// pip installed stayed invisible. The NuGet `python` package is the same interpreter in a full
// Windows layout — Lib\venv, Lib\ensurepip (with its bundled wheel, so venv works offline),
// Lib\site-packages\pip and the VC runtimes next to python.exe — and it is relocatable, which
// is what allows it to live under resources/ at all.
//
// Usage: node scripts/fetch-python.mjs [--force] [--version 3.12.10]

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(root, 'resources', 'python');
const cacheDir = join(root, 'resources', '.cache');

// Tried in order: nuget.org keeps every published patch release, but pinning a single version
// would rot as downloads move on. BEECODE_PYTHON_VERSION overrides the list.
const CANDIDATE_VERSIONS = ['3.12.10', '3.12.9', '3.12.8'];
const args = process.argv.slice(2);
const force = args.includes('--force');
const versionArgIndex = args.indexOf('--version');
const pinnedVersion =
  versionArgIndex >= 0 ? args[versionArgIndex + 1] : process.env.BEECODE_PYTHON_VERSION;

/** Files committed to the repository; vendoring must never delete them. */
const TRACKED_FILES = new Set(['README.md']);

function log(message) {
  console.log(`[python] ${message}`);
}

const packageUrl = (version) =>
  `https://api.nuget.org/v3-flatcontainer/python/${version}/python.${version}.nupkg`;
const archivePath = (version) => join(cacheDir, `python-${version}-win-amd64.nupkg`);

/**
 * Drop what a previous run vendored, keeping the committed files.
 *
 * `rmSync(targetDir, { recursive: true })` would take resources/python/README.md with it —
 * a tracked file — so the tree would show up as deleted in `git status`. Vendoring is
 * additive: every entry except the committed ones goes, the folder itself stays.
 */
function clearVendored(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (TRACKED_FILES.has(entry)) continue;
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

function dirFiles(dir) {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(full) : statSync(full).size;
  }
  return total;
}

async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

async function pickVersion() {
  if (pinnedVersion) return pinnedVersion;
  for (const version of CANDIDATE_VERSIONS) {
    if (await head(packageUrl(version))) return version;
  }
  return undefined;
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return bytes.length;
}

/** Unpack with whatever the platform has: bsdtar ships with Windows 10+ and macOS. */
function extract(archive, dest) {
  mkdirSync(dest, { recursive: true });
  const tar = spawnSync('tar', ['-xf', archive, '-C', dest], { encoding: 'utf8', windowsHide: true });
  if (tar.status === 0) return true;
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`],
    { encoding: 'utf8', windowsHide: true },
  );
  if (ps.status === 0) return true;
  throw new Error(`could not unpack ${archive}: ${tar.stderr || ps.stderr}`);
}

/** The nupkg wraps the interpreter in tools/; return that folder (or the root itself). */
function payloadRoot(dir) {
  const tools = join(dir, 'tools');
  return existsSync(join(tools, 'python.exe')) ? tools : dir;
}

/**
 * A payload is only reusable if it can do the two things the app promises: `pip` and `venv`.
 * An older embeddable payload fails this check, so switching distributions re-vendors itself.
 */
function isVendored(dir) {
  return (
    existsSync(join(dir, 'python.exe')) &&
    existsSync(join(dir, 'Lib', 'venv')) &&
    existsSync(join(dir, 'Lib', 'ensurepip', '_bundled'))
  );
}

/**
 * `python3`, `py`, `pip` and `pip3` are what scripts and muscle memory reach for; the payload
 * only ships python.exe/pythonw.exe and keeps pip as a module. These shims bridge the names in
 * the same folder, so the whole runtime is one `PATH` entry.
 */
function writeShims(dir) {
  // The interpreter path is quoted on its own so arguments stay arguments: a shim that quoted
  // `"%~dp0python.exe -m pip"` made cmd look for a file named after the whole command line.
  const shim = (file, args) =>
    writeFileSync(join(dir, file), `@echo off\r\n"%~dp0python.exe" ${args}%*\r\n`);
  shim('python3.cmd', '');
  shim('py.cmd', '');
  shim('pip.cmd', '-m pip ');
  shim('pip3.cmd', '-m pip ');
}

/**
 * Provenance for the payload: what is in here, where it came from and under which licence.
 * Untracked (only README.md is committed), so it is regenerated with every vendoring run.
 */
function writeProvenance(dir, version) {
  writeFileSync(
    join(dir, 'BUNDLED.txt'),
    [
      'beeCode bundled Python',
      `version: ${version}`,
      `source:  ${packageUrl(version)}`,
      'licence: Python Software Foundation License (see LICENSE.txt in this folder)',
      `fetched: ${new Date().toISOString()}`,
      '',
    ].join('\r\n'),
  );
}

function runPython(dir, extraArgs) {
  return spawnSync(join(dir, 'python.exe'), extraArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    // Without this the machine's per-user site-packages answers first: verification reported the
    // user's `pip 24.0` while the payload shipped `pip 25.x` — the same shadowing the app avoids
    // by exporting PYTHONNOUSERSITE (src/service/python.ts).
    env: { ...process.env, PYTHONNOUSERSITE: '1' },
  });
}

/**
 * A vendored runtime is only worth shipping if it actually starts and can build a venv, so
 * verification is the same three probes a user would run: the version, the imports venv needs
 * and pip itself. Failing here beats shipping an installer whose Python is half a runtime.
 */
function verify(dir) {
  const version = runPython(dir, ['--version']);
  if (version.status !== 0) {
    throw new Error(`python.exe does not run: ${(version.stderr || version.stdout || '').trim()}`);
  }
  const modules = runPython(dir, ['-c', 'import ensurepip, venv, sqlite3, ssl; print("ok")']);
  if (modules.status !== 0) {
    throw new Error(`runtime cannot create venvs: ${(modules.stderr || '').trim()}`);
  }
  const pip = runPython(dir, ['-m', 'pip', '--version']);
  if (pip.status !== 0) {
    throw new Error(`runtime has no working pip: ${(pip.stderr || '').trim()}`);
  }
  return {
    version: version.stdout.trim().replace(/^Python\s+/i, ''),
    pip: pip.stdout.trim().split(/\s+/)[1] ?? 'unknown',
  };
}

/** Keep the cache at one archive: stale downloads only cost disk. */
function pruneCache(keep) {
  if (!existsSync(cacheDir)) return;
  for (const entry of readdirSync(cacheDir)) {
    if (!/^python-.*\.(nupkg|zip)$/i.test(entry)) continue;
    if (join(cacheDir, entry) === keep) continue;
    rmSync(join(cacheDir, entry), { recursive: true, force: true });
  }
}

async function main() {
  const version = await pickVersion();
  if (!version) throw new Error('no candidate CPython release found on nuget.org');

  if (!force && isVendored(targetDir)) {
    const info = verify(targetDir);
    log(`already vendored ${info.version} with pip ${info.pip} at ${targetDir}`);
    log('use --force to refresh');
    return;
  }

  const archive = archivePath(version);
  if (!existsSync(archive)) {
    log(`downloading CPython ${version} (full distribution with pip + venv)`);
    const bytes = await download(packageUrl(version), archive);
    log(`downloaded ${(bytes / 1048576).toFixed(1)} MB`);
  }

  const staging = join(cacheDir, `staging-${version}`);
  try {
    rmSync(staging, { recursive: true, force: true });
    extract(archive, staging);
    const source = payloadRoot(staging);
    if (!existsSync(join(source, 'python.exe'))) {
      throw new Error(`archive has no python.exe (looked in ${source})`);
    }

    clearVendored(targetDir);
    mkdirSync(targetDir, { recursive: true });
    cpSync(source, targetDir, { recursive: true });
    writeShims(targetDir);

    const info = verify(targetDir);
    writeProvenance(targetDir, info.version);
    pruneCache(archive);
    const mb = dirBytes(targetDir) / 1048576;
    log(
      `ready: Python ${info.version} with pip ${info.pip} — ${dirFiles(targetDir)} entries, ${mb.toFixed(1)} MB at ${targetDir}`,
    );
    log('venv support: python -m venv <dir> (offline; pip is bootstrapped from the bundled wheel)');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  log(`failed: ${error.message}`);
  process.exitCode = 1;
});
