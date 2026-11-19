// Regenerate the README screenshots (docs/images/*.png) from a real Electron run.
//
// Same quirks as scripts/smoke.mjs: an IDE/agent shell injects env vars that break a
// plain `electron .` spawn, and the app takes a single-instance lock, so the child gets
// a private --user-data-dir. The capture itself lives in src/main/docsCapture.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'docs', 'images');
const reportPath = join(outDir, 'capture-report.json');

const exe = join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron',
);
if (!existsSync(exe)) {
  console.error(`[docs] electron binary not found at ${exe} — run "npm install" first`);
  process.exit(1);
}
if (!existsSync(join(root, 'dist', 'main.js'))) {
  console.error('[docs] dist/main.js is missing — run "npm run build" first');
  process.exit(1);
}

const env = { ...process.env };
for (const key of [
  'ELECTRON_RUN_AS_NODE',
  'VSCODE_NODE_COMPILE_CACHE_ROOT',
  'VSCODE_NODE_COMPILE_CACHE_KIND',
  'CHROME_CRASHPAD_PIPE_NAME',
  'ELECTRON_NO_ATTACH_CONSOLE',
]) {
  delete env[key];
}

rmSync(reportPath, { force: true });

const userDataDir = join(root, 'dist-test', 'docs-user-data');
const result = spawnSync(exe, ['.', `--capture-docs=${outDir}`, `--user-data-dir=${userDataDir}`], {
  encoding: 'utf8',
  env,
  cwd: root,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (!existsSync(reportPath)) {
  console.error(`[docs] no capture report written (child exit ${result.status ?? 'null'})`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const ok = report.ok === true && (report.images ?? []).every((image) => image.blank === false);
if (!ok) {
  console.error('[docs] FAILED: a capture is blank or an error was reported');
  process.exit(1);
}
process.exit(result.status ?? 0);
