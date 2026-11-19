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

const rendered = report.dom?.markdown ?? {};
const markdownOk =
  rendered.headings >= 1 && rendered.listItems >= 3 && rendered.tableRows >= 1 && rendered.charts === 1;

// The MCP & skills panel must render from the service, not just exist as a tab.
const integrations = report.dom?.integrations ?? {};
const integrationsOk =
  integrations.tab === true &&
  (integrations.headings ?? []).includes('MCP servers') &&
  (integrations.headings ?? []).includes('Plugins') &&
  (integrations.headings ?? []).includes('Skills');

// Every bundled plugin must reach the Plugins card as a row with its source badge, so a
// starter that fails to load fails the smoke run instead of only the service log.
const builtinBadges = (integrations.badges ?? []).filter((badge) => badge === 'builtin').length;
const pluginsOk = builtinBadges >= 3;

// The prompt must survive a maximised dock: the composer keeps its full height inside the
// window and the dock never covers it (the dock is what the page view is painted into).
const composerOf = (phase) => report.browser?.controls?.[phase]?.composer ?? {};
const composerVisibleOk = (composer) =>
  composer.present === true &&
  (composer.height ?? 0) > 0 &&
  composer.visible === true &&
  composer.overlapsDock === false;
const composerOk =
  composerVisibleOk(composerOf('before')) &&
  composerVisibleOk(composerOf('maximized')) &&
  composerVisibleOk(composerOf('unmaximized'));

// Driving the browser must not force the dock on screen: after an explicit open and a
// collapse, the dock stays hidden and navigation still works. The actions that need a surface
// fail fast with an explanation (a detached view has none) instead of hanging the agent loop.
const silent = report.browser?.silent ?? {};
const silentOk =
  silent.reopened === true &&
  silent.collapsed === true &&
  silent.navigated === true &&
  silent.guarded === true;

const ok =
  report.serviceReady === true &&
  report.dom?.bridge === true &&
  report.dom?.errors?.length === 0 &&
  markdownOk &&
  integrationsOk &&
  pluginsOk &&
  composerOk &&
  silentOk;
if (!markdownOk) console.error(`[smoke] markdown/chart render check failed: ${JSON.stringify(rendered)}`);
if (!integrationsOk) console.error(`[smoke] integrations panel check failed: ${JSON.stringify(integrations)}`);
if (!pluginsOk) console.error(`[smoke] plugins card check failed: ${JSON.stringify(integrations)}`);
if (!silentOk) console.error(`[smoke] silent browser drive check failed: ${JSON.stringify(silent)}`);
if (!composerOk) {
  console.error(
    `[smoke] composer visibility check failed: ${JSON.stringify({
      before: composerOf('before'),
      maximized: composerOf('maximized'),
      unmaximized: composerOf('unmaximized'),
    })}`,
  );
}
if (!ok) {
  console.error('[smoke] FAILED: see the report above');
  process.exit(1);
}

process.exit(result.status ?? 0);
