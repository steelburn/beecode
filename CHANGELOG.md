# Changelog

All notable changes to beeCode will be documented in this file.

## [Unreleased]

- **A slate version can record what it was built from, and be refreshed (slates, recipes).**
  `SlateVersion.recipe` holds `{ tool, args, at }` per source — **references only**, never a
  payload, so a slate's own 2 MB/version cap stays honest and nothing is duplicated beside the
  file (`src/shared/slateRecipe.ts`). The recipe lives on the version, not the slate, because v3
  may be built from different data than v2; `create_slate` and `update_slate` accept one, and
  `SlateStore.recordRecipe` attaches it only to the version that was just written — a recipe can
  never be added to a version that has since become history. A recipe that replays a write
  (`shell`, `fs_write`, …) is refused outright: a recipe records sources, not actions. The new
  `refresh_slate` tool writes nothing and fetches nothing — it re-authorises every recorded step
  against the current policy (reads) and the slate's origin allowlist (network steps), then hands
  the list back so the agent rebuilds the document and appends a version with the same recipe;
  one denial refuses the whole refresh rather than rebuilding from half the sources. A malformed
  recipe never turns a successful write into a reported failure — the document is the artefact,
  provenance is the annotation, and the result says when it was not recorded.

- **A live slate now runs — in a sandbox of its own (slates, Tier B part 2).**
  `src/main/slate/host.ts` owns one `WebContentsView` on a per-slate *in-memory* partition
  (`slate-live:<id>`) with `sandbox: true`, `contextIsolation` and **no preload**, so the page
  has no bridge, no filesystem reach and no cookies that outlive the run. The document is served
  from memory over `slate://live/<session>/<id>/v<N>` — main fetches it through `slate.read`,
  never from disk — and the slate's allowlist is delivered as a `content-security-policy`
  **response header** rather than a meta tag the document could rewrite. Every permission
  request, download, popup, webview, redirect and navigation other than the exact hosted URL is
  denied, and the `slate://` handler 404s any other address instead of serving it. The gallery
  tile gained the consent checkbox, the origins box and Run/Stop, talking to the host over
  `beecode:slate-live`; the host answers on `beecode:slate-live-state` so the UI shows what
  attached rather than what was clicked. A slate without consent, or one that could not be read,
  is refused with a message instead of a blank rectangle, and the view is hidden the moment the
  gallery pane stops being the view on screen. Electron smoke: the run attaches a seeded live
  slate on the `slate` scheme under its own allowlist, detaches it, and refuses a slate that has
  no consent.

- **A slate can carry a consented origin allowlist (slates, Tier B part 1).** A live
  slate is a network-capable document, so the permission now exists before the host that uses
  it: `src/shared/slateSandbox.ts` validates an origin (http(s) only, no wildcard, no path, no
  credentials, at most 8 entries), normalises it to scheme + host + port and builds the page CSP
  from exactly that list, with `connect-src 'none'` when it is empty. The allowlist lives in
  `meta.json` next to the versions, is refused at creation for a `markdown` / `csv` slate (there
  is no script to run), and is printed on the create approval card — the only place an agent can
  ask for it. Changing it afterwards is the user's own switch, `slate.live`, which turns
  execution on or off without rewriting the list and writes an audit entry (`slate-live`) for
  both edges. Nothing renders a live slate yet: part 2 is the sandboxed `WebContentsView`.
  Tests: `src/shared/slateSandbox.test.ts`, `src/service/slates.test.ts` (allowlist storage,
  the `markdown` refusal, the wildcard refusal, both `setLive` edges, clearing the list).

- **A bundled Python runtime — with venv and pip — and one executable resolver for the whole
  app.** beeCode no longer reports "Python is not installed": `scripts/fetch-python.mjs`
  vendors a full CPython build into `resources/python` (42 MB, pip 25 + `venv` + `ensurepip`,
  `python3`/`py`/`pip`/`pip3` shims), electron-builder copies it to `<app>/resources/python`
  outside the asar, and `src/service/python.ts` puts it in front of `PATH` for every child
  process — the shell tool, subagent CLI runs and the workspace terminal — with `PYTHONUTF8=1`,
  `PYTHONNOUSERSITE=1` and a `Python available to your shell: …` line in the system prompt so
  the agent plans around the runtime instead of asserting it is missing. The payload is the full
  Windows layout, not the embeddable zip: embeddable has no `ensurepip`, so `python -m venv`
  failed outright and its `._pth` hid pip installs — a *venv in the workspace* is now the
  documented way to add packages, and the prompt says so. `python`, `python3`, `py`, `pip`
  and `pip3` are allowed by default in shell policy, and `evaluateShell` judges an
  absolute-path invocation by its file name, so `"…\resources\python\python.exe" -m venv
  .venv` matches while an absolute `curl.exe` still trips the block list. Lookup moved into
  `src/service/executables.ts`: `PATH` plus the conventional per-platform install roots
  (per-user `Programs`, npm/scoop/choco shims, Homebrew, `/usr/local/bin`, pyenv/asdf) and
  PATHEXT expansion for a bare command name. The shell tool, the CLI-agent probe
  (`probeCommand`) and `DesktopController.resolveExecutable` — previously Windows-only,
  `;`-split and blind to `.exe` suffixes — all delegate to it.
  Tests: `src/service/executables.test.ts`, `src/service/python.test.ts` (incl. building a
  venv and running its pip), `src/service/policy.test.ts`.

### Added

- **Slates, phase 3 — the pipeline.** A long fenced `html` / `svg` block in an assistant
  message is no longer pasted into the transcript: at 40+ lines it becomes a slate and the
  message keeps a card where the block was. `src/shared/slateFence.ts` decides (a fenced
  `html` sample inside another code block is ignored), the title comes from `<title>`, else
  the first `h1` / `h2`, and an `svg` fragment is wrapped in the minimal page that renders
  it. The model history keeps the full text, so a follow-up turn can still refer to what it
  wrote, and a refused slate — a cap, a bad title — leaves the block inline instead of
  losing it. While the block is still streaming the gallery shows a live tile fed by
  `slate.delta`; `applyLiveSlates` rewrites that tile's body and label in place, so the pane
  is never remounted under the reader. `slate.diff` compares two versions with an LCS line
  diff (hunks with line numbers on both sides) and the gallery's Diff button renders it
  below the list. Tests: `slateFence.test.ts`, `slatePromote.test.ts`, `slateDiff.test.ts`,
  `slateLive.test.ts`.
- **Slates — a document the agent writes into its own tab instead of the transcript.**
  `create_slate` and `update_slate` write append-only versions (`001-<id>.md`, `002-…`) plus a
  `meta.json` pointer under `<cwd>/.beecode/slates/<session>/`, and the transcript keeps one
  line per slate (`Sales Q3 · v2 of 3 · Open`) rather than the document body. The new
  `SLATE_TAB` gallery lists the session's slates with their version history, and the Slates
  panel keeps the same list beside the chat; opening a version is an ordinary document tab,
  so the existing markdown and sandboxed-HTML viewers render it. Creating a slate raises one
  approval card, later versions raise none, both stay refused in plan mode, and the slate
  folder itself is exempt from `filesystem.writable` — `promote_slate` is what writes into the
  real tree, and that one goes through `evaluateFile` like any other file write. Slate ids are
  path-guarded (no separators, no `..`, no absolute paths), so nothing the model names can
  escape its folder. Tests: `src/service/slates.test.ts`, `src/service/tools/slates.test.ts`,
  `src/renderer/slateRef.test.ts`, plus a slate probe in the Electron smoke check.
  The caps and the promote action from phase 2 landed on top: the store enforces its three
  hard limits (`SLATE_LIMITS` in `src/shared/protocol.ts` — 2 MiB per version, 50 versions
  per slate, 100 slates per session) as refusals rather than pruning, `slate.remove` with a
  `version` drops a single version as the escape hatch, and the gallery and the panel each
  gained a **Promote…** form that writes one version into the workspace tree through the
  same file policy a tool write passes.
  The document tab closed phase 2: a slate version opens in an ordinary tab, so markdown,,  HTML and CSV keep the app's real viewers, and the tab head gained the two actions a,  document needs — **Copy** (async clipboard, with an `execCommand` fallback) and,  **Download…** (a native save dialog, suggested name `<slug>-v<N>.<ext>` from,  `slateDoc.ts`) — while the Rendered/Source toggle reads **Preview / Code** for a,  slate. There is no `slateView.ts`: the version file keeps its extension, so,  `mountFileView` renders it and only the actions are slate-specific.,  `src/renderer/slateDoc.test.ts` covers the path decoding, and the Electron smoke,  check asserts a plain workspace document shows none of these actions.

- **Knowledge folders — shared, read-only shelves a workspace can read.** A workspace may
  now reference one or more knowledge folders beside its root (Files panel → **Knowledge
  (read-only)**: add, rename, detach). The agent reads them without approval and is refused
  every write, with a reason and a system-prompt note so it stops rather than retries; the
  check lives in `PolicyEngine` and runs before the workspace grant, so a shelf inside the
  workspace is still write-denied while one outside it does not open the rest of the drive.
  `knowledge.mkdir` creates subfolders and `knowledge.copy` copies a workspace file in
  (missing parents created, no silent clobber, audited as a write) — the only two writes,
  and both user-driven service RPCs rather than agent tools. The `app://beecode/file`
  viewer accepts the knowledge roots too, so pictures and PDFs preview out of a shelf.
  Workspace changes now also arrive as a `workspace.state` service event, so the panes
  (and a second window) repaint themselves, and the copy button shows up for the shelf
  that is already selected instead of only after clicking its radio.

### Fixed

- **An upgraded install kept denying the Python it ships.** The runtime prefixes were added to
  `defaultPolicy()`, but the effective policy is the stored `~/.beecode/policy.json`, and it is
  only migrated when `POLICY_DOCUMENT_VERSION` says it is stale — so every existing user kept the
  old eight-prefix shell list and still got "Python is installed, but I could not execute it".
  Version 4 adds a shell migration that unions exactly the runtimes this build grants
  (`python`, `python3`, `py`, `pip`, `pip3`, from the single `DEFAULT_SHELL_RUNTIMES` export) into
  the stored list and writes the document back, so the file stops claiming to be v3 instead of
  being re-migrated on every start. A union, not a re-seed: a prefix the user removed on purpose
  stays removed.
- **Quoted arguments in `shell_run`.** Node's argv quoting turned `dir "C:\Program Files"` into
  `dir \"C:\Program Files\"`, which `cmd /s /c` rejects with "filename, directory name, or volume
  label syntax is incorrect". The command line is now wrapped in exactly one pair of quotes and
  passed with `windowsVerbatimArguments`, which is the form `/s` documents.

## [0.1.1] - 2026-11-23

### Added

- **The Files panel previews documents, pictures, tables and logs.** `fs.read` could only
  hand back text, so a `.pdf`, a `.docx`, an `.xlsx`, a `.pptx` or a `.png` showed nothing
  but "Binary file — no text preview". The service now unpacks Word, Excel and PowerPoint
  (a ZIP of XML, read with the same reader a skill archive uses) and returns markup; the
  renderer gained one viewer per kind: a table for CSV/TSV, a colour-coded log with a level
  filter and a search, an `<img>` for pictures, Chromium's own PDF viewer in a frame, and
  the converted Office markup. The explorer peek and the document tab share that viewer, so
  a file looks the same in both. Pictures and PDFs are served over a new
  `app://beecode/file` route confined to the workspace root — the renderer still has no
  general file read.

- **The file tools can also delete, move and create directories.** The toolset was read/
  write only: `fs_write` created missing parent folders as a side effect, and nothing could
  remove a stale file, rename one or make an empty directory. `fs_mkdir`, `fs_delete` and
  `fs_move` close that gap. All three are checked by the filesystem policy like a write,
  confirmed outside `autonomous` mode and audited as `dir-create`, `file-delete` and
  `file-move`. `fs_delete` refuses the workspace root itself and needs an explicit
  `recursive: true` before it removes a directory; `fs_move` refuses an existing
  destination and creates the destination's missing parents. A move is checked twice — the
  source counts as a write, because after the move it is gone from its old path.

- **Every tool can be switched off, not just gated.** All 44 registered tools used to be
  offered to the model unconditionally: the policy and `agent.autoApproveTools` decided
  whether a call needed a click, never whether the tool existed. **Settings → Tools** now lists
  the whole catalogue grouped by subsystem, with a filter box, a switch per tool and an
  *N of M tools are on* count, and writes `config.tools.disabled`. A switched-off tool keeps
  its row — the panel has to show it as off — but it is filtered out of the schemas the model
  receives and `execute` refuses it in-band (`{ "error": "tool \"x\" is switched off" }`)
  without ever reaching the handler, so nothing gets at it through the router or a subagent
  either. `config.set` rebuilds the registry when the list changes, and an unknown name is kept
  rather than dropped: it may be a plugin or MCP tool that is merely not installed yet.
- **Both side columns size and hide on their own — and come back.** The rail and the side
  panel each have a drag grip on their inner edge — double-click restores the shipped
  width, arrow keys work while the grip has focus — and each collapses from a chevron in
  the topbar that names its target and points the way the column will go (`«` / `»`).
  A collapsed column leaves a handle on the window edge it vacated, so the way back is
  always on screen: the topbar toggle itself slides away with the column, which is what
  made a collapsed panel look permanent. The handle does not cover the topbar's other
  controls. Widths and collapsed flags are window preferences in localStorage, so they
  survive a restart, and the conversation column never drops below 360px however far a
  drag pushes.
- **Scheduled runs, from chat or from the settings dialog.** beeCode could only start a run when
  you typed something. **Settings → Scheduled runs** lists every schedule with its next and last
  run, and *Run now* · *Pause* · *Edit* · *Delete* are one click each; the new `schedule`
  tool does the same from chat (`list`, `add`, `update`, `remove`, `run`, `pause`,
  `resume`), so "every weekday at 8:15 summarise my inbox" is one sentence. Timing is
  written as a compact rule — `once:2025-04-01 09:00`, `every:30m`, `daily:09:00`,
  `weekly:mon,thu@17:30`, with `weekdays` accepted and intervals clamped to 5 minutes to 7
  days. `daily`/`weekly` resolve on the **local** wall clock, because that is what "09:00"
  means to a user, while `every` is anchored on the last run: a restart neither drifts nor
  replays a backlog, and a run missed by more than an hour while the app was closed is
  recorded as missed instead of firing late. Each fire starts a **fresh** session named
  after the schedule, so a background run never interleaves with the chat you are having
  and its transcript stays readable afterwards; `once` disables itself once it has fired.
  Schedules are persisted in `scheduler.json` next to the other stores and every write is
  re-broadcast as a `scheduler.changed` event (`scheduler.list` / `save` / `remove` /
  `run`), so the tab, the tool and the service timer never disagree
  (`src/shared/schedule.ts`, `src/service/scheduler/store.ts`,
  `src/service/scheduler/runner.ts`, `src/service/tools/scheduler.ts`,
  `src/renderer/panels.ts`).
- **Model is a dropdown fed by the endpoint.** Picking a model meant typing an id from
  memory into a free-text field. **Settings → Model** is now an input backed by the models
  the endpoint advertises (`{Base URL}/models`, Ollama's `/api/tags`, Azure's
  `?api-version`): it re-reads them when the **Base URL**, the provider or a key changes
  (debounced, so one probe per edit) and on demand, and still accepts an id the endpoint does
  not list. The list comes from a new `models.list` RPC, which resolves the key the same
  either/or way the chat path does — the key typed but not yet saved, then the one in
  `secrets.json`, then the env var — and reports an unreachable endpoint as a note instead of
  an error (`src/service/llm/models.ts`, `src/renderer/panels.ts`, `src/shared/protocol.ts`).
- **The API-key env var is optional, and now says so.** A key could always come from
  `secrets.json` instead, but the field read as required. It is now **API key env var
  (optional)** with a blank placeholder, and the key status line spells out the order: a
  stored key wins over the env var and over `API_KEY` in `.env.llm`
  (`src/renderer/panels.ts`, `src/service/service.ts`) — `hasKey` now resolves through that
  same either/or order, so a key exported as the provider's default env var counts too.
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
- **Workspace terminal.** A new **Terminal** drawer runs shell commands from the app,
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
- **A right-click menu on dock tabs.** With several browser tabs open, the only way back to one
  of them was to close the rest one by one. Right-clicking a tab now offers **Close tab** /
  **Close other tabs** / **Close all tabs**, with “Close other tabs” greyed out on the last tab
  and worded for a single remaining neighbour. It is a native menu, not a DOM dropdown: the page
  is a `WebContentsView` painted over the window, so anything drawn in the strip would be hidden
  behind the page it acts on (`src/main/browser/tabMenu.ts`, `src/main/browser/host.ts`).
- **Delete a skill from the Skills card.** Removing a playbook meant finding and deleting
  `~/.beecode/skills/<name>/` in a file manager and restarting. Every skill row now has a
  *Delete* button that arms on the first press and deletes on the second (four seconds, then
  it disarms), so a misclick costs nothing. `skill.remove` deletes the folder that holds the
  `SKILL.md` — the scripts and references beside it go too — or the `.md` alone for a skill
  that sits flat in a root, and only ever inside a scan root: a record pointing elsewhere, an
  unknown name or a path outside the roots is refused with an error instead of guessed at.
  The listing comes back re-scanned, so the row is gone as soon as the call returns.
- **Install a plugin in one step.** The Plugins card is a drop zone: drop a plugin folder or a
  `.zip` of one, or use *Choose folder…* / *Choose .zip…*. `plugin.install` copies it under the
  first configured plugin root by its manifest `id`, strips the single wrapper folder a `.zip`
  is usually packed in, switches `plugins.allowExternal` on when it was off (nothing would load
  otherwise), reloads the host and returns the fresh plugin list — no hand-copying and no
  second Reload. A refused item in a multi-file drop (no `plugin.json`, malformed manifest, an
  entry point the plugin does not ship, an id that cannot name a folder) is reported back by
  path with its reason while the rest still install, and re-installing an `id` replaces its
  folder so a stale file from the previous version cannot linger.
- **Attach files to a prompt.** The composer has an *Attach* button that opens a multi-select
  file dialog; the files become chips with a ✕ and travel with the prompt as `attachments`.
  The model gets their absolute paths in an explicit "read these files" instruction, while the
  transcript keeps the text the user typed plus the chips. A prompt made only of attachments
  still sends, and a failed send puts the chips back.
- **Drop files onto the window to copy them into the workspace.** A drop on the chat composer
  attaches the files; a drop anywhere else copies them into the workspace folder the Files
  panel is showing (clamped to the workspace root when they came from outside it), refreshes
  the tree and reports what landed. A name that already exists becomes `name (2).ext` instead
  of overwriting, a folder is copied recursively, and a path that cannot be copied is named
  without aborting the rest of the drop.
- **The browser can download — into the workspace, and only there.** `will-download` used to
  be cancelled outright, so a page the agent opened could hand nobody a file. Downloads now
  land in `<workspace>/Downloads` (`src/main/browser/downloads.ts`): the folder is created on
  demand, the page's filename is stripped of directory parts and Windows-reserved characters,
  a taken name becomes `name (1).ext` instead of overwriting, and a download with no workspace
  open is still refused. The dock shows a `↓ file` chip with the saved path as its tooltip, and
  `browser_state` carries the last download so the agent can point at what it fetched.
- **The session rail rolls up per workspace.** Sessions were one flat list even though each
  one belongs to the folder it was opened in, so last week's project crowded the work in
  front of you. The rail now groups them under a header per workspace — folder name, session
  count, and badges for sessions that are still running or have unread output — with the open
  workspace first and expanded and the others collapsed. A group is a button, its collapsed
  state is remembered, and a session opened before this change keeps a stable workspace even
  when its working directory is moved (`src/renderer/sessionGroups.ts`).

### Fixed

- **The internal browser hid tabs past the first few.** The tabs shrank instead of the strip
  scrolling — `.browser-tab` had no shrink floor, so with several tabs open every name
  collapsed to a sliver next to its ✕ — and the strip was rebuilt from `BrowserState` on
  every navigation, title change and cursor toggle, which threw away its scroll position and
  yanked it back to the first tab. Tabs now keep a readable width, the strip scrolls and
  remembers where the user scrolled it, the active tab is scrolled into view when the agent
  opens or switches one, the mouse wheel scrolls the strip sideways, and a `3/8` counter says
  how many tabs exist and which one is on screen — so a crowded strip never looks like it
  holds only the tabs that fit (`src/renderer/browserDock.ts`, `src/renderer/browserTabs.ts`,
  `src/renderer/styles.css`).

- **The main-area tab strip jumped back to the first tab on every document open.** The strip
  is rebuilt whenever the tab set changes, which discarded its scroll position — with many
  documents open, the tab the user just opened sat past the right edge. It keeps its scroll,
  brings the active tab into view and takes the mouse wheel
  (`src/renderer/mainArea.ts`).

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
- **Every panel started empty because boot was refused one RPC.** The same allow-list gap,
  one layer up: the boot load runs the twelve startup calls in a `Promise.all`, and
  `scheduler.list` was never added to `RENDERER_METHODS`, so the whole load rejected on
  `renderer may not call "scheduler.list"`. Nothing was assigned — no config, no skills, no
  plugins, no sessions — and Settings, Plugins, Skills and Subagents painted their headings
  with zero rows while the composer still worked, which reads as a rendering bug rather than
  a failed load. `scheduler.list`, `scheduler.save`, `scheduler.remove` and `scheduler.run`
  are allowed now, so the Scheduler panel works and the startup load completes; the smoke run
  proves it (7 badges, 4 skill delete controls, `scripts/smoke.mjs`).
  The renderer now marks `document.body.dataset.ready` once that load lands — the smoke probes
  wait for it instead of racing a fan-out that includes CLI agent detection — and the first tab
  click retries a load that failed, so a slow boot self-heals instead of leaving empty cards on
  screen. The Settings probe, empty for as long as it has existed, now reads 12 cards.
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
- **The prompt you just sent is echoed in the transcript.** `AgentLoop` appended the user
  message to the session but never emitted `session.entry` for it, so the transcript stayed
  empty until the first assistant chunk arrived — pressing Enter, picking an option on a
  question and clicking a quickstart example all looked like they did nothing. The user entry
  is now broadcast like every other entry, attachments included, so the message appears the
  moment it is sent.

### Changed

- **The right column keeps the session, not the app.** The side panel had grown to eight
  tabs — Permissions, Subagents, Activity, Files, MCP & skills, Settings, Scheduler and
  Terminal — which mixed two lifetimes in one 360px column. The strip now holds only the
  three that describe the session you are looking at; everything app-wide moved out:
  Settings, Tools, Permissions, MCP & skills and Scheduled runs are sections of one dialog behind
  the gear in the topbar (`Ctrl+,`), and the terminal became a drawer across the bottom of
  the chat column (``Ctrl+` ``), where a shell actually has the width. The three remaining
  tabs wrap instead of being squeezed into a single row, and `Esc` closes whichever of
  dialog or drawer is on top. The smoke run now gates the tab strip itself, so a surface creeping
  back into it fails the check.
  Each surface is captured into `docs/images/` by `npm run docs:screenshots`, which now
  also records the card and line counts it saw while each was open.
- **The chat composer gives its space back to the conversation.** *Attach* and *Send* are now
  icon buttons floating inside the input box — a paperclip on the left, an arrow (plus a stop
  square while a turn runs) on the right — instead of a labelled button row under it, and the
  hint line only takes room when it has something to say. Both keep an `aria-label` and a
  tooltip, so the icons stay labelable for assistive tech and on hover.
- **The application icon is the new beeCode mark.** `resources/icon.png` is a 512×512 PNG
  rendered from the final 2048px artwork (not the hand-made 256px export), so the window,
  the tray and the NSIS installer all take their icon from that one file.
  `scripts/make-icon.mjs`, which draws a placeholder, now refuses to overwrite an existing
  icon unless it is run with `--force`.
- **The version comes from `package.json`.** `service.health` and the MCP client handshake
  each carried a hardcoded `0.1.0`, so the packaged app would have gone on announcing 0.1.0
  after the bump. Both now resolve the nearest `package.json` through `src/service/version.ts`
  (it walks up from the bundle, so `dist/`, `dist-test/` and `app.asar` all land on the same
  file) and health reports the version the service was started with.

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
