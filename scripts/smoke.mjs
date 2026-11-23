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

// The right column keeps the three session surfaces. Settings, Permissions, MCP & skills
// and the scheduler live in the settings dialog and the terminal in the drawer, so a
// regression that puts them back into the strip is caught here.
const panelTabs = report.dom?.panelTabs ?? {};
const panelTabsOk =
  panelTabs.count === 3 &&
  JSON.stringify(panelTabs.panels) ===
    JSON.stringify(['subagents', 'activity', 'explorer']) &&
  panelTabs.dialog === true &&
  panelTabs.drawer === true;

// The per-tool switches are a settings section too: every registered tool is listed with
// a checkbox, so a broken catalogue or a renderer that drops rows fails here.
const tools = report.dom?.tools ?? {};
const toolsOk =
  tools.dialog === true &&
  tools.navLabel === 'Tools' &&
  (tools.rows ?? 0) > 20 &&
  tools.rows === tools.checkboxes &&
  tools.described === true &&
  tools.on > 0 &&
  tools.on <= tools.rows;

// Permissions is a settings section now: the policy cards come from the service, the
// side panel keeps only the session surfaces.
const permissions = report.dom?.permissions ?? {};
const permissionsOk =
  permissions.dialog === true &&
  (permissions.headings ?? []).includes('Permissible applications') &&
  (permissions.headings ?? []).includes('Shell');

// The MCP & skills section of the settings dialog must render from the service.
const integrations = report.dom?.integrations ?? {};
const integrationsOk =
  integrations.dialog === true &&
  (integrations.headings ?? []).includes('MCP servers') &&
  (integrations.headings ?? []).includes('Plugins') &&
  (integrations.headings ?? []).includes('Skills');

// Every bundled plugin must reach the Plugins card as a row with its source badge, so a
// starter that fails to load fails the smoke run instead of only the service log.
const builtinBadges = (integrations.badges ?? []).filter((badge) => badge === 'builtin').length;
const pluginsOk =
  builtinBadges >= 3 &&
  // Installing a plugin is one step from the card: the drop zone is there, with both pickers,
  // so a regression that drops it fails here instead of only in the UI.
  integrations.pluginDrop === true &&
  integrations.pluginDropButtons === 2 &&
  // Deleting a skill is a per-row control, and the skills of the smoke home do load, so a
  // missing remove button means the card lost it — or boot stopped loading skills again.
  integrations.skillRemoves >= 1;

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

// Attach and Send are icons inside the input box, not labelled buttons on an extra row.
const composerUi = report.dom?.composerUi ?? {};
const composerUiOk =
  composerUi.iconOnly === true &&
  composerUi.insideBox === true &&
  composerUi.labelled === true &&
  Array.isArray(composerUi.ids) &&
  composerUi.ids.includes('attach') &&
  composerUi.ids.includes('send');

// Driving the browser must not force the dock on screen: after an explicit open and a
// collapse, the dock stays hidden and navigation still works. The actions that need a surface
// fail fast with an explanation (a detached view has none) instead of hanging the agent loop.
const silent = report.browser?.silent ?? {};
const silentOk =
  silent.reopened === true &&
  silent.collapsed === true &&
  silent.navigated === true &&
  silent.guarded === true;

// Files panel view modes (Markdown/HTML rendered vs source) and the workspace terminal
// must work through the real UI, not just exist as code.
const preview = report.dom?.preview ?? {};
// A rendered HTML file must live in its own shadow root: its markup and its stylesheet
// belong inside that root, never in the app document. Only gated when the workspace has an
// HTML file at all, since the list is whatever the working directory contains.
const htmlPreviewOk =
  !preview.html ||
  (preview.htmlRendered === true &&
    preview.htmlScriptStripped === true &&
    preview.htmlStylesIsolated === true);
const previewOk =
  preview.tab === true &&
  preview.listing === true &&
  preview.markdownRendered === true &&
  preview.toggle === true &&
  preview.markdownSource === true &&
  htmlPreviewOk;

// Main-area tabs: a rendered document opens in the column as a tab, the theme toggle
// restates only the document surface, and the browser tab fills the column with the composer
// still clear underneath.
const mainArea = report.dom?.mainArea ?? {};
const mainAreaOk =
  mainArea.strip === true &&
  mainArea.pane === true &&
  mainArea.rendered === true &&
  mainArea.isolated === true &&
  mainArea.transcriptHidden === true &&
  mainArea.composerVisible === true &&
  mainArea.light === true &&
  mainArea.themeFlipped === true &&
  mainArea.chromeDark === true &&
  mainArea.backToChat === true &&
  mainArea.closed === true;

const browserTab = report.browser?.controls?.tabActivated ?? {};
const browserTabOk =
  browserTab.offered === true &&
  browserTab.active === true &&
  browserTab.transcriptHidden === true &&
  report.browser?.controls?.tabClosed?.active === true;

const terminal = report.dom?.terminal ?? {};
const terminalOk =
  terminal.drawer === true &&
  terminal.mounted === true &&
  terminal.ranCommand === true &&
  terminal.insideWorkspace === true;

// With more tabs open than the bar can show, every tab keeps a readable width and the
// active one is scrolled into view rather than clipped off the right edge.
const tabStrip = report.browser?.tabStrip ?? {};
const tabsFitOk =
  typeof tabStrip.count === 'number' &&
  tabStrip.count === tabStrip.expected &&
  (tabStrip.expected < 2 ||
    (tabStrip.minWidth >= 80 && (tabStrip.overflow !== true || tabStrip.activeVisible === true)));

// The dock tab's right-click menu is built in main (a native menu cannot be drawn in the DOM
// over the page view), so the renderer only forwards the event. Check that the round trip
// produced the close rows a multi-tab strip must offer.
const tabMenu = report.browser?.tabMenu ?? {};
const tabMenuOk =
  tabMenu.contextClicked === true &&
  tabMenu.opened === true &&
  tabMenu.closeOthersOk === true &&
  (tabMenu.items ?? []).includes('Close tab') &&
  (tabMenu.items ?? []).includes('Close other tabs') &&
  (tabMenu.items ?? []).includes('Close all tabs');

// Both side columns: each one hides from its toggle and comes back, and the rail grip
// drags a new width that is remembered — the two ways the shell hands the columns over.
const columns = report.dom?.columns ?? {};
const columnsOk =
  columns.rail > 0 &&
  columns.panel > 0 &&
  columns.railHidden === true &&
  columns.railShown === true &&
  columns.panelHidden === true &&
  columns.panelShown === true &&
  columns.railDragged === true &&
  columns.railStored === true &&
  columns.railReset === true &&
  columns.handlesIdle === true &&
  columns.railHandleShown === true &&
  columns.railHandleHidden === true &&
  columns.panelHandleShown === true &&
  columns.panelHandleHidden === true &&
  columns.railToggleLabel === 'Show the navigation column' &&
  columns.panelToggleLabel === 'Show the side panel' &&
  columns.collapsedReach?.togglePanel === true &&
  columns.collapsedReach?.settings === true &&
  columns.collapsedReach?.terminal === true;

const ok =
  report.serviceReady === true &&
  report.dom?.bridge === true &&
  report.dom?.errors?.length === 0 &&
  markdownOk &&
  columnsOk &&
  panelTabsOk &&
  toolsOk &&
  permissionsOk &&
  integrationsOk &&
  pluginsOk &&
  composerOk &&
  composerUiOk &&
  silentOk &&
  previewOk &&
  mainAreaOk &&
  browserTabOk &&
  tabsFitOk &&
  tabMenuOk &&
  terminalOk;
if (!columnsOk) console.error(`[smoke] side column check failed: ${JSON.stringify(columns)}`);
if (!panelTabsOk)
  console.error(`[smoke] panel tab strip check failed: ${JSON.stringify(panelTabs)}`);
if (!markdownOk) console.error(`[smoke] markdown/chart render check failed: ${JSON.stringify(rendered)}`);
if (!toolsOk) console.error(`[smoke] tools section check failed: ${JSON.stringify(tools)}`);
if (!permissionsOk)
  console.error(`[smoke] permissions section check failed: ${JSON.stringify(permissions)}`);
if (!integrationsOk)
  console.error(`[smoke] integrations section check failed: ${JSON.stringify(integrations)}`);
if (!pluginsOk) console.error(`[smoke] plugins card check failed: ${JSON.stringify(integrations)}`);
if (!silentOk) console.error(`[smoke] silent browser drive check failed: ${JSON.stringify(silent)}`);
if (!previewOk) console.error(`[smoke] files preview check failed: ${JSON.stringify(preview)}`);
if (!mainAreaOk) console.error(`[smoke] main-area tab check failed: ${JSON.stringify(mainArea)}`);
if (!browserTabOk)
  console.error(`[smoke] browser tab check failed: ${JSON.stringify(report.browser?.controls)}`);
if (!tabMenuOk) {
  console.error(`[smoke] browser tab menu check failed: ${JSON.stringify(tabMenu)}`);
}
if (!tabsFitOk)
  console.error(`[smoke] browser tab strip check failed: ${JSON.stringify(tabStrip)}`);
if (!terminalOk) console.error(`[smoke] terminal drawer check failed: ${JSON.stringify(terminal)}`);
if (!composerUiOk)
  console.error(`[smoke] composer icon check failed: ${JSON.stringify(composerUi)}`);
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
