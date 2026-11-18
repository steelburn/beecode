// Launch the app in --smoke mode and assert it actually boots.
//
// Several quirks are handled here, all of them things an IDE/agent shell injects:
//   - ELECTRON_RUN_AS_NODE turns Electron into plain Node.
//   - VS Code's node compile cache makes Chromium child processes abort inside V8 with
//     EXCEPTION_BREAKPOINT before the app starts (cache written by a different V8 build).
//   - ELECTRON_NO_ATTACH_CONSOLE swallows the child's stdout, i.e. the report.
//   - the app takes a single-instance lock, so a beeCode instance the user already has
//     open would make this child quit before it checks anything — hence a private
//     --user-data-dir.
// The Electron binary is also invoked directly instead of through a shell shim.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
);

if (!existsSync(exe)) {
  console.error(`[smoke] electron binary not found at ${exe} — run "npm install" first`);
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

const userDataDir = join(root, 'dist-test', 'smoke-user-data');
const reportPath = join(root, 'dist-test', 'smoke-report.json');
rmSync(reportPath, { force: true });

const result = spawnSync(exe, ['.', '--smoke', `--user-data-dir=${userDataDir}`], {
  encoding: 'utf8',
  env,
  cwd: root,
});
if (result.stderr) process.stderr.write(result.stderr);

// The child also writes its report to disk: a consoleless parent gets nothing from stdio,
// and that report is the whole point of the run.
if (!existsSync(reportPath)) {
  console.error(`[smoke] no report written (child exit ${result.status ?? 'null'})`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const ok = report.serviceReady === true && report.dom?.bridge === true && (report.dom?.errors ?? []).length === 0;
if (!ok) {
  console.error('[smoke] FAILED: see the report above');
  process.exit(1);
}

process.exit(result.status ?? 0);
