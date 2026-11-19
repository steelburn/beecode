# Changelog

All notable changes to beeCode will be documented in this file.

## [0.1.0]

### Added
- **Internal browser.** The agent can browse the web in a window it drives itself, with a
  visible AI cursor it moves to each target before acting. Each tab is a sandboxed
  `WebContentsView` in a dedicated in-memory session — permission requests, downloads,
  popups and non-web schemes are refused at the host — while policy and audit stay in the
  service and input is dispatched over CDP rather than scripted into the page
  (`src/main/browser/*`, `src/service/browser/controller.ts`,
  `src/service/tools/browser.ts`, `src/renderer/browserDock.ts`). Ten `browser_*` tools:
  open, snapshot, click, type, key, scroll, wait, tabs, screenshot, close. The dock
  reserves the rectangle and reports it on layout changes, so the attached view follows
  the window.
- **MCP servers.** `mcpServers` in `config.json` connects external Model Context Protocol
  servers over stdio or streamable HTTP (`initialize` → `tools/list` → `tools/call`) and
  projects their tools into the catalogue as `mcp__<server>__<tool>`
  (`src/service/mcp/client.ts`, `src/service/mcp/manager.ts`). A tool is mutating — and so
  gated by the approval card — unless the server marks it `readOnlyHint`. A server that
  fails to start is reported as `error` and skipped; `mcp.reload` reconnects and rebuilds
  the registries. MCP tools stay out of the internal-subagent allowlist.
- **Skills.** `SKILL.md` playbooks in `~/.beecode/skills` or `<cwd>/.beecode/skills`
  (plus `skills.dirs`) are discovered by `SkillStore`, listed in the system prompt by name
  and description, and loaded on demand through the read-only `skill` tool
  (`src/service/skills/store.ts`, `src/service/tools/skills.ts`). Front matter is a small
  `key: value` subset; the name is slugified and doubles as the tool argument.
- **New RPC methods** `mcp.list`, `mcp.reload`, `skill.list`, `skill.reload` and
  `skill.read`, plus `mcpServers`/`skills` normalisation in `src/shared/defaults.ts`.
  The five are on the renderer allow-list (`RENDERER_METHODS`), and an **MCP & skills**
  sidebar panel lists every server with its state and contributed tools and every
  discovered skill with its source, with a **Reconnect** button behind `mcp.reload` +
  `skill.reload` (`renderIntegrations` in `src/renderer/panels.ts`). `npm run smoke`
  asserts that panel renders in a real Electron window.
- **Editing MCP servers from that panel.** Each server card is a live editor — name,
  transport, command or URL, arguments, `KEY=VALUE` env, plus *Save*, *Enable*/*Disable* and
  *Remove* — and *Add disabled* creates an entry that is not spawned until it is enabled
  (`renderIntegrations` in `src/renderer/panels.ts`). Changes go through `config.set`, which
  now reconnects and rebuilds the tool registries itself when the server map changed, so an
  edit takes effect in the same call and the panel reads the result back with `mcp.list`
  instead of reconnecting twice. Entries pass the same normalizer as startup, a server that
  fails to start is reported as `error` rather than failing the save, and the e2e service
  test adds, connects and removes a server over the RPC surface.
  See [docs/mcp-and-skills.md](docs/mcp-and-skills.md).
- **A working directory per session, picked from the header.** Sessions no longer share one
  fixed root. `session.setCwd` (`RpcRequests` in `src/shared/protocol.ts`, implemented on
  `SessionManager` and dispatched by the service) moves the session's `cwd` *and* its policy
  workspace root, rejects a path that is not an existing directory with an ordinary JSON-RPC
  error, and emits a session snapshot so the header and the session list agree at once. The cwd in
  the header is now a clickable folder chip (`#session-cwd`): it opens the native directory picker
  — `pickDirectory` gained `title`/`defaultPath` and the dialog runs with `createDirectory`, so a
  folder can be made without leaving the picker — and the directory a session was pointed at
  becomes the default for the next new session.
- **Markdown rendering proper.** `renderMarkdown` in `src/renderer/dom.ts` is a block parser now
  instead of a line-by-line subset: ATX headings, arbitrarily nested ordered and unordered lists,
  GFM tables with per-column alignment, blockquotes, horizontal rules, fenced code carrying a
  `data-lang` label, and inline code, links (`https` and `mailto` only), bold, italic and
  strikethrough. All input is escaped before any formatting is applied and code spans are parked
  behind placeholders, so a message cannot inject markup and a span is never formatted twice.
  Fence handling is chunk-safe, so a code block that is still streaming does not corrupt the text
  around it.
- **Charts from a fenced block.** A `` ```chart `` fence carrying a JSON spec — `bar`, `line`
  or `pie`, an optional `title` and `unit`, and `labels` with either a `values` shorthand or named
  `series` — renders to inline SVG through the new `src/renderer/chart.ts`: axes, grid, ticks, a
  legend and a `<title>` tooltip on every datum. The builder returns a string and touches no DOM,
  so it is unit-testable, and a malformed spec degrades to a readable error card instead of a
  blank message.
- The system prompt (`src/service/llm/prompts.ts`) documents both capabilities, so the model
  knows which Markdown constructs and which chart spec it may emit.

### Fixed
- **The desktop-observation layer can prove what it did, so "ok" means the window changed.**
  Every window now has one identity — `handle`, `processId`, `title`, `exe`, `className` plus
  `isForeground`, `isVisible`, `isMinimized`, `isCloaked`, `isOffscreen` and `virtualDesktop` —
  and every result carries it, so the handle `desktop_launch`/`desktop_focus` return is the
  handle `desktop_ui_tree`, `desktop_screenshot`, `desktop_type`, `desktop_hotkey`,
  `desktop_invoke` and `desktop_list_windows` address. An app-name target binds to the handle it
  resolved to and keeps addressing that handle; it is no longer re-resolved by title on every
  call, and a dead binding fails loudly instead of being replaced by a different window.
- **`desktop_launch` reports the window, not the spawner.** It re-enumerates for a bounded time
  and says whether a window was created or the document went to a running instance (Win11
  Notepad's single-instance tab handoff). Packaged apps, whose window belongs to a process the
  launcher activated (`calc.exe` → `CalculatorApp.exe`), are matched by a new window whose owning
  process started with the launch — accepted only when exactly one process qualifies, otherwise
  the launch fails and names the candidates rather than guessing.
- **`desktop_screenshot` captures the window itself.** `PrintWindow(PW_RENDERFULLCONTENT)`
  replaces the screen-region `BitBlt` that returned whatever happened to be on top at the
  window's coordinates (during the reported failure: the beeCode chat window, at the target's
  width and height). A cloaked, minimised, hidden, zero-area or off-desktop window is an error
  naming the cause, and the `handle` argument is now required — the whole-screen path is gone,
  so a capture can no longer be silently substituted.
- **Text is read back, so a mutation is verifiable.** The driver reads a document's text with
  `TextPattern.DocumentRange.GetText` (`ValuePattern` when that is what the element answers) and
  normalises CR/CRLF to LF; `desktop_type` and `desktop_hotkey` return `lengthBefore`,
  `lengthAfter`, `delta` and the element's text, so a caller can diff what it typed against what
  the window holds. Typing also stopped corrupting its own input: send-keys text is escaped
  before newline mapping (a `\n` no longer types the literal `{ENTER}`), it is sent in chunks
  with a settle, and a short delivery is an error instead of an `ok`.
- **`desktop_ui_tree` is deterministic.** Subtrees are force-expanded, a UIA timeout is reported
  as an error instead of a silently root-only tree, implausible bounds (negative sentinels read
  before layout) are rejected, `isOffscreen` is included, and the walk is re-read once after
  activation settles. Two calls on an idle window return the same node set, and Notepad yields
  its editor and status bar.
- **Mutations prove their target before sending anything.** `desktop_type`, `desktop_hotkey` and
  `desktop_invoke` check that the handle is still a live window matching the request and, for
  keyboard input, that it is foreground — before any keystroke. A closed handle fails with zero
  keystrokes delivered and no fallback to whatever currently has focus.
- `desktop_list_windows` builds its filtered and unfiltered results from a single enumeration, so
  the filtered set is always a subset of the unfiltered one at the same instant.

### Changed
- **Policy scoping follows the session, not the process.** `PolicyEngine.evaluateFile` takes
  `extraRoots` per call rather than consulting a single global root, and the file and shell tools
  pass the session's own `workspaceRoots`. A session pointed outside the configured workspace
  stays confined to that folder, and the broader grant never leaks into another session.
- `scripts/smoke.mjs` now sends a sample assistant message through the real sandboxed renderer and
  asserts that headings, list items, table rows and the chart element all came out, so the
  Markdown and chart path is covered by the Electron smoke and not just by unit tests.
- `docs/service-protocol.md` documents the `session.setCwd` request, its response and its error
  cases; `docs/architecture.md` describes the Markdown/chart pipeline and the DOM-free chart
  builder.
- **Caller-visible changes in the desktop tools.** `desktop_screenshot` now returns an error
  instead of a screen grab when the window cannot be captured; `desktop_launch` returns
  `spawnerProcessId` (labelled as the launcher) separately from `window`, plus
  `windowCreated`/`tabAdded`; `desktop_type` and `desktop_hotkey` return a read-back;
  `desktop_ui_tree` reports `nodeCount`, `truncated` and whether the walk expanded anything.

### Verified
- `tsc --noEmit` clean; the new `markdown.test.ts` and `chart.test.ts` suites pass; the policy
  suite covers the extra-root grant and an out-of-root escape; the service end-to-end suite
  accepts a valid `setCwd` and rejects a missing folder; build plus Electron smoke are green.

Run live as well: `npm run verify:driver` against Calculator (enumeration, packaged-app
launch, identity round-trip, 90-node UIA tree, invoke, click, window capture) and the gated
Notepad regression (`BEECODE_LIVE_DESKTOP=1`) — launch, type the three-line haiku, read it back,
assert it matches, and capture that window — both pass. 87 desktop/skill/MCP/service tests pass
with no failures.

### Documentation
- **The Windows driver has its own page.** `docs/windows-driver.md` documents the process
  model (one short-lived `powershell.exe` per action, no resident helper), why scripts are
  delivered as a temp `.ps1` with `-File` instead of `-EncodedCommand`, the three injection
  surfaces and how each is closed, how packaged (UWP) apps keep their own identity, the
  ordered guard in front of `desktop_click`, and the limits the driver does not overcome
  (UIPI, DPI virtualisation, no automated coverage of the real driver). `architecture.md`
  linked the driver page and had its `-EncodedCommand` claim corrected, and
  `desktop-permissions.md` + `README.md` now point at it.

- **README diagrams and screenshots.** The architecture, permission and internal-browser flows
  are mermaid diagrams instead of ASCII art, and `docs/images/` holds two screenshots taken from
  a real run (`npm run docs:screenshots` → `scripts/capture.mjs` → the capture mode in
  `src/main/docsCapture.ts`). The capture refuses to write a blank image: it records pixel
  statistics per file, proves the AI cursor changes the page pixels, and checks that the browser
  surface really landed inside the dock rectangle (`regionMatch`), all in
  `docs/images/capture-report.json`.
