# Changelog

All notable changes to beeCode will be documented in this file.

## [Unreleased]

### Added

- **Rendered Markdown and HTML in the Files preview.** The preview was plain text, so a
  `README.md` or a generated HTML report read as markup. The Files panel now has a
  **Rendered / Source** switch: Markdown goes through the transcript renderer (headings,
  lists, tables), HTML through a sanitiser that drops scripting blocks, `on*` handlers,
  `javascript:` URLs and `expression()` styles while keeping inline CSS, tables, images and
  links — so a report looks like a report without the app trusting it. The rendered file is
  mounted in its own shadow root with layout containment, so a stylesheet inside it cannot
  restyle the app chrome and a `position: fixed` page cannot paint over it. Plain text keeps
  its source view and gets no switch (`src/renderer/preview.ts`, `src/renderer/explorer.ts`).
- **Documents and the browser open as main-area tabs.** A rendered file was pinned to the
  narrow Files panel, so a Markdown document or a generated HTML report could only be read
  in a column a few hundred pixels wide. Every file now has **Open in the main area as a
  tab** (`⤢` on the preview header): the main area gains a tab strip — **Chat**, one tab per
  open document, **Browser** — and the chat transcript yields to a document pane showing the
  file name, path, size, a **Rendered / Source** toggle and a close button, while the
  composer stays at the bottom. Re-opening a file reuses its tab and remembers the view the
  user picked; a rendered HTML document is still mounted in its own shadow root, so the
  file's stylesheet cannot restyle the app. A **Light / Dark** switch recolours rendered
  content only (CSS custom properties, which cross the shadow boundary): it is remembered
  across restarts and leaves the app chrome dark. The browser dock doubles as the
  **Browser** tab — selecting it maximises the dock over the main area, deselecting restores
  the previous dock mode, and because the page is bounded by the dock rectangle it never
  covers the composer (`src/renderer/docTabs.ts`, `src/renderer/mainArea.ts`,
  `src/renderer/browserDock.ts`, `src/renderer/explorer.ts`, `src/renderer/styles.css`).
- **Workspace terminal.** A new **Terminal** panel tab runs shell commands from the app,
  confined to the workspace: the working directory can never leave the root (`cd ..` at the
  root is refused, so is an absolute path outside it, and switching workspace re-confines
  the session), output is capped at 4000 lines / 400 KB, and **Stop** kills the process
  tree. The main process owns the shell and streams scrollback to the renderer over IPC;
  the terminal is not an RPC method, so no agent can reach it
  (`src/main/terminal.ts`, `src/shared/terminal.ts`, `src/renderer/terminal.ts`).
- **Install a skill by dropping it on the Skills card.** Adding a skill meant creating
  `~/.beecode/skills/<name>/SKILL.md` by hand and restarting. The Skills card is now a drop
  target: drop a `SKILL.md` (written to `~/.beecode/skills/<name>/SKILL.md`) or a `.zip` —
  every folder in the archive that carries a `SKILL.md` is installed with the scripts and
  references beside it — or pick a file with **Choose file…**. The service does the writing
  and answers with the re-scanned list, so the card updates without a restart. Unpacking is
  dependency-free (the ZIP central directory plus `node:zlib`), and entries that would escape
  the skills folder, archives over 5 MB and corrupt files are refused with a message instead
  of a half-installed skill (`src/service/skills/zip.ts`, `src/service/skills/install.ts`,
  `src/renderer/panels.ts`).
- **Install a skill from a URL.** The Skills card now takes an `https://` link as well as
  a dropped file: **Install from URL** next to the drop zone downloads a `SKILL.md` or a
  skill `.zip` and installs it through the same path, so the layout under
  `~/.beecode/skills` is identical either way. The service fetches it (20 s timeout, 5 MB
  cap, redirects followed by hand so every hop is re-checked and a downgrade is refused,
  `http://` only for a loopback host so a skill in a local checkout can be tried), rejects
  a payload that is neither a ZIP nor text, and reports the HTTP status it got
  (`src/service/skills/download.ts`, `src/service/skills/install.ts`).
- **One-click step-limit bump.** Running out of steps was a dead end: the note told you to
  raise `agent.maxSteps` "in settings" and stopped there. It now carries the fix — a **Raise
  step limit to N** button (24 → 48, capped at 400) that saves the higher limit through the
  same `config.set` path the Settings panel uses, then confirms the new value in place. A
  transcript entry can now declare its own actions (`TranscriptAction`), so the service
  states which action applies and with which numbers while the renderer owns the wording —
  an old entry can never resurrect a button for a limit that already moved
  (`src/service/session/AgentLoop.ts`, `src/renderer/main.ts`, `src/shared/protocol.ts`).
- **`pi` agent.** The CLI-agent catalogue now includes `pi` (`pi -p <prompt>`), so
  Settings → external agents offers it as soon as it is on PATH.

- **Settings can configure the whole app.** The panel only ever exposed models and
  the workspace folder, so advice such as "raise `agent.maxSteps` in Settings" pointed at a
  field no screen rendered — the agent stopped after 24 steps with nowhere to change it.
  Five cards now cover the rest of `config.json`: **Agent** (default mode, **max steps**,
  working directory), **Service** (auto-start, HTTP port), **Desktop control** (enabled,
  driver), **Internal browser** (enabled, cookie/session persistence, page scripts, cursor,
  max tabs, home page) and **Subagents** (enabled, max concurrent runs). Values are edited
  in a draft and only written on **Save**, like the existing cards
  (`src/renderer/panels.ts`).
- **Concurrent sessions.** Every session already had its own run queue in the service, but
  the renderer dropped events for anything that was not the visible session — a second
  session's answer simply never appeared. Events from every session are now recorded: the
  session list shows a `running` badge (and a count of new results) per session, and
  switching to it shows the finished transcript. Tool results, status flips and drafts stay
  per session, so two runs can be in flight without either losing output
  (`src/renderer/main.ts`, `src/renderer/styles.css`).
- **Workspace explorer.** A new **Files** panel tab browses the workspace from the app: a
  breadcrumb and parent row, folders first with sizes, and a text preview for files — no
  more leaving beeCode to look at the tree. The listing comes from two new RPCs,
  `fs.list` and `fs.read`, which are confined to the workspace and agent working
  directory, cap a listing at 500 entries and a preview at 256 KB, and report binary files
  instead of dumping them (`src/service/service.ts`, `src/renderer/explorer.ts`).
- **Workspace switcher and history.** A `⌂` button in the topbar opens the recent
  workspaces (most recent first, current one marked) and switches to one with a click, or
  opens another folder through the picker. The list is the service's own MRU
  (`workspace.state.recent`), so it reflects every folder the app has been pointed at
  (`src/renderer/main.ts`).
- **Per-workspace browser session.** The internal browser used one global cookie jar, so a
  tab opened in project A kept its login for project B. The persistent partition name is now
  derived from the workspace root (`persist:beecode-browser-<hash>`), and switching
  workspaces closes the open tabs instead of carrying them across
  (`src/main/browser/session.ts`, `src/main/browser/host.ts`).
- **The goal panel can be minimised.** A toggle on the goal line folds the plan down to a
  one-line summary (`n/m steps`) and the choice is remembered per window, so a long plan no
  longer pushes the transcript off-screen (`src/renderer/plan.ts`).

### Fixed

- **Driving the browser no longer forces the browser dock on screen.** Every agent action
  used to set the dock visible, so a navigate, a keystroke or a DOM snapshot yanked the
  user's layout back to the page mid-task, and an agent-driven tab switch took keyboard focus
  away from the composer. Only `browser_open` reveals the dock now; navigate, type, key,
  back/forward, reload and DOM snapshots keep working on a hidden page, while click, hover,
  scroll and screenshots fail fast with an explanation instead of hanging, because a detached
  view is not painted and silently drops synthetic input (`src/main/browser/host.ts`,
  `src/renderer/browserDock.ts`, `src/service/tools/browser.ts`).

- **The Workspace Files view and the skill drop-zone were refused by the main process.**
  Both are renderer features that call RPCs the renderer allow-list never learned about, so
  the panel died on `renderer may not call "fs.list"` (and the drag-and-drop skill install
  would have failed the same way on `skill.install`). `fs.list`, `fs.read` and
  `skill.install` are now in `RENDERER_METHODS`, and a static test walks the renderer for
  every `api.invoke` and fails when a method is missing from that list
  (`src/shared/bridge.ts`, `src/renderer/allowlist.test.ts`).
- **The Subagents tab listed agents it could not delegate to.** The "Available agents"
  card rendered the whole catalogue — every built-in preset, whether or not the CLI was on
  PATH and whether or not it was ticked in Settings — so the panel advertised nine agents
  that would fail the moment one was used. It now lists only agents that are both
  installed and enabled (`usableAgents`, `src/renderer/panels.ts`), with an empty state
  pointing at Settings → External agents (CLI) instead of a blank card. Ticking an agent
  also no longer drops the internal beeCode runner from that card: `agents.detect`/
  `agents.save` return the CLI catalogue only, so the renderer merges the internal entry
  back in (`withInternalAgent`, `src/renderer/main.ts`).

- **Ticking an external agent silently rewrote its label and args.** The seeded CLI agents
  disagreed with the `AGENT_PRESETS` catalogue (`claude` labelled `Claude CLI` vs
  `Claude Code`, `codex` seeded with `['exec', '--full-auto']` vs `['exec']`), and saving
  the External agents card rebuilds an entry from the catalogue — so the first tick renamed
  the row and left codex subagents spawning without `--full-auto`. `defaultConfig()` now
  seeds exactly what the catalogue says, and a test pins the two together
  (`src/shared/defaults.ts`, `src/service/subagents/presets.test.ts`).

- **A new session forgot the mode you were using.** "New session" and an app restart always
  came back as the configured `agent.defaultMode` — usually `ask` — so a long `autonomous`
  stretch started over in the wrong mode every time; the mode only ever travelled on an
  explicit `session.setMode`. The renderer now remembers the last mode (validated against
  `ask|plan|act|autonomous`) and sends it with `session.create`, and every rendered session
  teaches it again, so reopening an old session counts too (`src/renderer/main.ts`).
- **The prompt could be pushed out of view by the internal browser.** Maximising the dock
  forced its minimum height, and dock and transcript are flex siblings, so the composer ended
  up behind the native `WebContentsView` overlay with no way to scroll to it. The dock now
  yields to the column (`flex: 0 1 auto`, `max-height: calc(100% - 176px)`, smaller minimum)
  and the column clips instead of spilling, so the prompt line always keeps its space
  (`src/renderer/styles.css`, `src/renderer/browserDock.ts`). The Electron smoke now measures
  the composer against the dock in every dock state — present, inside the window and never
  overlapping it — so this cannot come back quietly (`src/main/main.ts`, `scripts/smoke.mjs`).
- **The external-agent enable toggle did nothing.** The Settings card was filled from
  `agents.list` — the registered agent *types*, which carry no CLI entries — so there was
  nothing to tick before **Detect agents** was pressed, and a tick made after a detect looked
  like it had reverted. The card now comes from the cached `agents.detect` catalogue (no spawn
  on load) and is refreshed when the Settings tab is opened again (`src/renderer/main.ts`).
- **The Workspace Files view went stale.** A failed `fs.list` kept the previous listing in
  state, so the panel painted a directory that was no longer there and the error could never
  be left; a successful listing invalidated nothing either, so re-opening the tab showed the
  old tree. A failure now resets the state to the error itself, and the tab re-reads its
  directory — the remembered one, not always the root — when it is opened
  (`src/renderer/main.ts`).
- **A truncated installer shipped as a working build.** The 0.1.0 installer had been cut
  off mid-write (67 MB instead of 111 MB), so running it died with "NSIS Error" and
  installed nothing, while every existing check still passed because each one only looked
  at `release/win-unpacked`. `npm run verify:installer` now runs the NSIS installer
  silently, compares the installed `app.asar` against `release/win-unpacked`, and boots the
  INSTALLED `beeCode.exe` in `--smoke` mode (scratch `--user-data-dir`, GUI-hostile
  environment variables such as `ELECTRON_RUN_AS_NODE` stripped, which turns Electron into
  plain Node and makes the exe exit instantly). An installer that cannot execute now fails
  the check instead of shipping (`scripts/verify-installer.mjs`).
- **Plugin tools were never offered to the model.** The plugin host built its tool
  catalogue but nothing handed it to the agent, so `pdf_generate`, `pdf_open` and
  `excel_export` were loaded and green in their own tests yet absent from the tool list —
  a "research this and generate a PDF" request finished with no PDF and no error.
  `buildToolRegistry` now takes the plugin definitions the same way it takes MCP servers,
  and every registry rebuild asks the host for its current set (core tool names only are
  treated as reserved, so the rebuild is idempotent). Covered by a service-level test that
  asserts `pdf_generate` is in `tools.list` and survives a rebuild
  (`src/service/tools/index.ts`, `src/service/service.ts`).
- **`pdf_generate` with `open: true` never showed the PDF.** `pdf/open` requires
  `pdf:view`, which the PDF generator manifest did not declare, so the host refused the
  call and the rejection was swallowed — the file was written, the viewer never opened.
  The permission is declared now, and a viewer that still refuses is reported in the tool
  result instead of disappearing. A new invariant test scans every bundled plugin and fails
  when a tool reaches for a host method or file API its manifest does not declare
  (`src/plugins/builtin/pdfGenerator.ts`).
- **Saving external agents.** The Settings card no longer rebuilds the whole panel on
  every checkbox click (the command box lost its caret and the list jumped), saves are
  serialised and reconciled against the latest click instead of an echoed snapshot — a
  rapid second click can no longer revert the first — an unticked custom command is
  kept in `config.json` as `enabled: false` instead of being deleted, and a save reuses
  cached PATH probes rather than re-spawning every configured CLI; only an explicit
  **Detect agents** forces a fresh probe (`src/service/subagents/runner.ts`,
  `src/renderer/panels.ts`).

- **The smoke check raced the first paint.** It clicked the Settings and Plugins tabs
  after a fixed 600 ms and read the panel, so a slower boot reported an empty settings panel
  (0 cards) and no plugin badges even though both rendered a moment later — the check was
  flaky, not the UI. The probe now polls for the cards and badges it asserts on, and reads
  the working directory from its labelled field instead of "the last input on the page"
  (`src/main/main.ts`).

## [0.1.0] - 2026-11-19

### Added
- **Plugins.** A third extension point beside MCP servers and skills: an in-process
  CommonJS module that contributes tools, loaded from `~/.beecode/plugins/<id>/` with no
  build step. Every capability is declared in the manifest — `files:read`, `files:write`,
  `pdf:view`, `pdf:render` — and re-checked on each call, file access runs through the same
  policy engine as the built-in file tools, and host calls are audited as action `plugin`.
  `pdf_generate` runs that policy before it writes (`pdf/render` needs `files:write` on top
  of `pdf:render`), and an entry point outside the plugin's own directory is refused.
  Bad manifests, a throwing `activate` or a failing handler degrade to an error on the
  plugin or a failed tool result, never a crashed service. Managed from the new
  **Plugins** card in the **MCP & skills** panel (or `plugin.list` / `plugin.setEnabled` /
  `plugin.reload`). Three starters ship with it:
  - **PDF viewer** (`pdf_open`) — shows a PDF in an internal viewer window, reused per
    file, optionally at a page.
  - **PDF generator** (`pdf_generate`) — Markdown or HTML to PDF through Chromium
    `printToPDF`, with paper size, landscape, background printing and margins.
  - **Excel export** (`excel_export`) — rows (arrays or objects) or a CSV/TSV string to a
    real `.xlsx`: OOXML written by hand, frozen bold header, column widths, zero
    dependencies; a `.csv` target falls back to delimited text.
- **Internal browser.** The agent can browse the web in a window it drives itself, with a
  visible AI cursor it moves to each target before acting. Each tab is a sandboxed
  `WebContentsView` in a dedicated in-memory session — permission requests, downloads,
  popups and non-web schemes are refused at the host — while policy and audit stay in the
  service and input is dispatched over CDP rather than scripted into the page
  (`src/main/browser/*`, `src/service/browser/controller.ts`,
  `src/service/tools/browser.ts`, `src/renderer/browserDock.ts`). Ten `browser_*` tools:
  open, snapshot, click, type, key, scroll, wait, tabs, screenshot, close. The dock
  reserves the rectangle and reports it on layout changes, so the attached view follows
  the window, and its title bar carries minimize / maximize / close — collapsing reports
  a zero rectangle, which is how the view knows to detach.
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
- **`ask_user` actually asks.** The question a tool returns lived in its result metadata, and
  the metadata was dropped at the protocol boundary: the turn ended correctly and the composer
  re-enabled, but nothing was ever shown — a silent dead end. `tool.result` now carries an
  optional `meta` that `AgentLoop` forwards, and the renderer shows the question as a card
  above the composer whose options are buttons (one click sends the reply) while a typed
  answer still works and a hint line says the turn is blocked on the user.
  `src/service/askUser.test.ts` asserts the question and its options reach the event stream.
- `todo_write` no longer stores an unrecognised status verbatim: an invalid value falls back to
  `pending` instead of entering the session state as-is and rendering as an unknown class.
- `fs_read`'s `maxBytes` schema default is now the value the handler enforces (262144), so the
  model is told the real truncation limit.

### Changed
- **Electron 42.11.16, and Node >= 22.12 with it.** Dependabot bumped Electron from
  40.10.2 to 42.11.16; its install chain (`@electron/get` 5, `@electron-internal/extract-zip`,
  `undici`) requires Node >= 22.12, so `engines` now declares `>=22.12` and a `.nvmrc` pins
  22.12.0. A clean `npm install` on Node 20 fails.
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
