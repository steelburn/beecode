# AGENTS.md — beeCode

Guidance for AI agents and humans working in this repository. Derived from the ado-code
conventions this project inherits.

## What this is

beeCode is an agentic **desktop** application: an Electron host plus a background agent
service that can see and drive permitted applications on the user's desktop and delegate
to subagents. Structural ancestor: `../ado-code` (a VS Code extension). Do not copy VS Code
APIs into this repo — there is no `vscode` module here.

## Build & verify

| Tier | Command | When |
| --- | --- | --- |
| 1 (every edit) | `npm run typecheck` | seconds, strict TS, catches most mistakes |
| 2 (while iterating) | `npm test -- service` / `policy` / `controller` | runs only matching suites |
| 3 (before hand-off) | `npm run check` | typecheck + tests + build + Electron smoke |
| 5 (docs) | `npm run docs:screenshots` | regenerates the README screenshots in `docs/images/` from a real run |
| 4 (on request) | `npm run dist` | electron-builder installers |

`npm run smoke` launches the real app with `--smoke`, which boots the service, loads the
renderer and prints a JSON report (`serviceReady`, `tools`, `dom.bridge`, `dom.errors`,
`browser.dock`). The `browser` block is the end-to-end proof that the dock laid out and
the sandboxed view was attached, so check it whenever you touch `src/main/browser/**` or
the renderer dock.
`browser.download` drives a real download against a loopback server in a throwaway
workspace: the file must land in `<workspace>/Downloads`, a second save of the same name
must not overwrite the first, and a run with no workspace must be refused.
The Files-preview, main-area and knowledge checks need a Markdown and an HTML file in
the **workspace root**, whatever the user's folder happens to contain, so the run
seeds `beecode-smoke-preview.md` / `.html` there and deletes them at teardown. The
previewed Markdown is also the file the knowledge probe sends into its throwaway
shelf — take the seeding away and all three report `null` / `false` again.
If Electron starts as plain Node, `ELECTRON_RUN_AS_NODE` is leaking from the shell —
`scripts/smoke.mjs` already strips it; run that instead of `electron .` directly.

## Hard conventions

- **Node ≥ 22.12.** Electron 42's install chain (`@electron/get`, `undici`) requires it;
  `package.json#engines` and `.nvmrc` say 22.12, so a clean `npm install` on Node 20 fails.
- **Zero runtime dependencies.** Node builtins, Electron and `fetch` only. Dev deps:
  electron, esbuild, typescript, @types/node. Do not add a UI framework, an HTTP client,
  a validation library or a desktop-automation native module.
- **Tool failures are returned, never thrown.** A tool that cannot act returns
  `{ "error": "…" }` as its content (ado-code convention). `ToolRegistry.execute` is the
  only place that catches, and it converts thrown errors to that shape.
- **The permission layer is the boundary.** Any new capability that touches the OS must go
  through `DesktopController` (or a policy check) and must be audited. Never call the
  driver directly from a tool, and never let the model decide what is permitted. The
  internal browser is a capability like any other: it is gated by `evaluateBrowser` and
  audited under the `browser` action.
- **The service never imports the UI.** `src/service/**` must not import from
  `src/main/**`, `src/renderer/**` or `electron`. Renderer code must not import anything
  from `src/service/**`.
- **The renderer has no Node.** `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`; all capability lives behind `window.beeCode`
  (`src/shared/bridge.ts`). New renderer→service methods must be added to
  `RENDERER_METHODS` or they are rejected in the IPC layer.
- **No `innerHTML` with model output.** Renderer text goes through
  `escapeHtml`/`renderMarkdown` (`src/renderer/dom.ts`).
- **No secrets on disk.** API keys come from env vars named in the model preset
  (`apiKeyEnv`); `~/.beecode/config.json` never stores keys.
- Files in this repo are **LF**; `edit_file` multi-line `oldText` therefore uses `\n`.

## Where things live

| Concern | File |
| --- | --- |
| Wire types (RPC, events, policy, config) | `src/shared/protocol.ts` |
| Default config + starter policy | `src/shared/defaults.ts` |
| Preload contract | `src/shared/bridge.ts` |
| Agent loop / approval gate | `src/service/session/AgentLoop.ts` |
| Session queue + approval handshake | `src/service/session/SessionManager.ts` |
| Tool catalogue | `src/service/tools/*.ts`, wired in `tools/index.ts` |
| Permission decisions | `src/service/policy.ts` |
| Desktop driver (Windows) | `src/service/desktop/windowsDriver.ts` |
| Internal browser host (view, tabs, CDP input, AI cursor) | `src/main/browser/*.ts` |
| Browser policy + URL matching | `src/service/policy.ts` (`evaluateBrowser`) |
| Browser controller + tools | `src/service/browser/controller.ts`, `src/service/tools/browser.ts` |
| Browser dock (chrome + bounds reporting) | `src/renderer/browserDock.ts` |
| Main-area tabs (Chat / document / Browser) | `src/renderer/docTabs.ts` (model), `src/renderer/mainArea.ts` (DOM) |
| Rendered file preview + sanitiser | `src/renderer/preview.ts`, hosted by `src/renderer/explorer.ts` |
| Service wiring | `src/service/service.ts` |
| Plugin contract + host (discovery, permissions, tool wrapping) | `src/plugins/types.ts`, `src/plugins/host.ts` |
| Bundled starter plugins (PDF viewer, PDF generator, Excel export) | `src/plugins/builtin/*.ts` |
| Host methods plugins may call (PDF open/render) | `src/main/pluginHost.ts` |
| IPC allow-list | `src/main/ipc.ts` |

## Internal browser

The agent can drive its own browser, and the trust boundary runs *through* the feature
rather than around it:

- **Main owns the page.** Each tab is a `WebContentsView` (`sandbox: true`, no Node,
  `contextIsolation`) in a dedicated in-memory session where every permission request,
  popup and non-web scheme is denied (`src/main/browser/session.ts`). A page download is
  the one exception, and it is bounded: it lands in `<workspace>/Downloads`
  (`src/main/browser/downloads.ts`) and nowhere else — no workspace means no download. The
  view is painted on top of the window at the rectangle the renderer reports for its dock.
- **The service owns the decision.** `evaluateBrowser(url, action)` runs before the host
  call and before the audit entry, so a denial never reaches main
  (`src/service/browser/controller.ts`). Note the default is *permissive, not deny-by-default*:
  the sandbox is the boundary, so `allowAnyHost: true` ships on and every call is audited
  under `browser`. Tighten with `allowedHosts` (+ `allowAnyHost: false`), `deniedHosts`,
  `allowInput: false` for read-only browsing, or `requireApproval`.
- **Input is trusted, not synthesised in the page.** Clicks, typing and keys go through
  CDP (`Input.dispatchMouseEvent` / `insertText` / `dispatchKeyEvent`), so a page cannot
  observe or override the agent's input; the DOM driver is only a fallback.
- **The cursor is visible state.** The shadow-DOM pointer moves to the target *before*
  input fires (plus a target ring and click ripple), so the user can follow the agent.
  It lives in the page's isolated world and never touches page globals.
- **The dock is a panel, not an OS window.** Minimize collapses it to the title bar and
  the renderer reports a zero rectangle, which is the only signal the host needs to
  detach the view (`syncView` refuses zero-area bounds — do not "optimise" that into an
  early return, or the page keeps floating above the chat). Maximize measures the
  workspace column minus the siblings below the dock. Close goes through `close-all`,
  which tears the tabs down; plain `close` only hides them for later.

The service never imports the host: it sends `browser/exec` over the same stdio pipe in
the reverse direction (`HostCall`) and the main process answers it.

## Plugins

`src/plugins` is a third extension point beside MCP servers and skills: an in-process
CommonJS module that contributes tools. The starters live in `src/plugins/builtin/`
(`pdf_open`, `pdf_generate`, `excel_export`); user plugins load from
`~/.beecode/plugins/<id>/` (`plugin.json` plus the `main` it names, no build step).
Full contract and config: [docs/plugins.md](docs/plugins.md).

- **`types.ts` stays import-free.** External plugins load that contract as plain JS, so it
  may import types only — never Electron or the service.
- **Capability arrives through the manifest.** `api.fs.*` and `api.host.call()` re-check
  the declared permission on every call and throw in-band when it is missing;
  `normalizeManifest` drops unknown permissions, so a typo narrows access. Never widen a
  check inside `PluginHost` to make a starter work.
- **File access is not a bypass.** `api.fs` runs the same `PolicyEngine.evaluateFile` as
  `read_file`/`write_file`, and host calls are audited as action `plugin`. A host method
  that writes demands `files:write` too (`HOST_METHOD_PERMISSION` holds a list per method),
  and a plugin gates work of its own with `api.fs.assertWrite` before touching the disk.
- **An entry point stays inside its own plugin directory** — the check is path-segment
  aware, so a sibling sharing the name prefix (`md-stats-evil`) does not pass for a child.
- **A plugin may not take the loop down.** Bad manifests, a throwing `activate`, duplicate
  tool names and handler exceptions become an `error` on `PluginInfo` or a failed tool
  result — never an unhandled rejection at startup.
- **Names cannot collide.** Plugin tools live in group `plugins`; `mcp__` is reserved and a
  name already in the core catalogue is dropped with a warning, not shadowed.

## Recipes

**Add a tool.** Create the `ToolDefinition` in the right `src/service/tools/*.ts` file
(`name`, `description`, `mutating`, `group`, JSON-Schema `inputSchema`, `handler`). Add a
`preview()` when the approval card needs a good summary or should skip the prompt. Mutating
tools must set `mutating: true` so plan mode refuses them. Register it in
`buildToolRegistry`, and add it to `SUBAGENT_TOOL_ALLOWLIST` only if it is read-only.

**Add a desktop action.** Extend `DesktopAction`, the driver interface (`desktop/types.ts`),
both drivers (`windowsDriver.ts`, `mockDriver.ts`), the controller method (with
`windowAction`) and a tool. Policy, audit and prompt text follow automatically.

**Add a browser action.** Extend `BrowserAction`/`BrowserExecParams` (`src/shared/browser.ts`),
teach `evaluateBrowser` what it needs (`src/service/policy.ts`), implement it in
`BrowserHost.exec` (`src/main/browser/host.ts`) and expose it as a tool in
`src/service/tools/browser.ts`. An action that simulates input must dispatch through the
CDP helpers and move the cursor first — never `executeJavaScript` a synthetic `.click()`.

**Add a CLI subagent.** No code: add an entry to `subagents.cliAgents` in
`src/shared/defaults.ts` (`command` + `args`, prompt is appended last).

**Change the protocol.** Update `RpcRequests`/`ServiceEvent` in `protocol.ts`, the dispatch
in `service.ts`, the IPC allow-list in `src/shared/bridge.ts` if the renderer needs it, then
the renderer handler. Bump `PROTOCOL_VERSION` on breaking changes.

**Add a plugin tool.** Prefer a plugin over a core tool when the capability is optional
— a format, a converter, an integration. Put the `PluginDefinition` in
`src/plugins/builtin/<name>.ts`, list it in `builtin/index.ts`, take everything outside
the module from `api` (`fs`, `host.call`), declare each permission in the manifest and
return `failResult(...)` instead of throwing. Give the tool a distinct prefix.

## Testing notes

* `npm test` bundles each `*.test.ts` with esbuild and runs it with `node --test`
  (`scripts/test.mjs`). Tests use the **mock driver** and a temporary `BEECODE_HOME`, so
  they never touch the real desktop, real config or real audit log.
* `src/service/service.test.ts` is the end-to-end guard: real service, real HTTP transport,
  real JSON-RPC. Keep it green when touching wiring.
