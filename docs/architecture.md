# beeCode architecture

## Process model

Three processes, one direction of trust:

```
renderer (sandboxed)  →  main (Node, full API)  →  service (child process, no window)
```

### 1. Renderer — the UI

* Loaded from the custom `app://beecode/` scheme so it has a real origin and the strict
  CSP in `index.html` (`default-src 'self'`, no `connect-src`) actually applies.
* `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. No filesystem, no
  network, no IPC primitives.
* Plain TypeScript + CSS. DOM built with `h()`; model output is escaped before it becomes
  markup (`renderMarkdown` in `src/renderer/dom.ts`: headings, nested lists, GFM tables,
  blockquotes, labelled code fences, safe links).
* Charts are dependency-free: a ```chart fence carrying a small JSON spec (bar/line/pie,
  labels, one or more series) is drawn as inline SVG by `src/renderer/chart.ts`. The spec
  parser and the SVG builder are DOM-free, so `chart.test.ts` runs them in plain node.
* Its entire capability surface is `window.beeCode` (`src/shared/bridge.ts`): a typed RPC
  proxy, four config/policy helpers, a directory picker, an `https`-only link opener and
  event subscriptions, and two panel APIs (the browser view and the workspace terminal).

### 2. Main — the host

* `src/main/main.ts` owns the window, the tray (close-to-tray; the agent keeps running),
  the `Ctrl+Alt+B` global toggle and the `--smoke` self-check.
* `src/main/ipc.ts` is an explicit channel allow-list. Every renderer RPC is checked
  against `RENDERER_METHODS` before it can reach the service.
* `src/main/serviceSupervisor.ts` spawns `dist/service.js` with
  `ELECTRON_RUN_AS_NODE=1`, speaks newline-delimited JSON-RPC over its stdio, forwards
  every service event to the window and restarts the child with exponential backoff (max
  5 attempts) if it dies. A crash in the agent cannot freeze the UI.

### 3. Service — the agent runtime

`src/service/service.ts` wires the long-lived objects and exposes them as methods:

```
config ⇄ disk (~/.beecode/config.json)      policy ⇄ disk (~/.beecode/policy.json)
AuditLog (append-only JSONL)                 MemoryStore (per-workspace notes)
DesktopController → PolicyEngine → driver    SubagentRunner → internal / CLI agents
SessionManager → AgentLoop → LLM client
```

Two transports consume the same `handle(method, params)`:

* **stdio** (`transports/stdio.ts`) — used by Electron; events are `method: "event"`
  notifications on stdout. Logs never go to stdout on this transport.
* **HTTP + SSE** (`transports/http.ts`) — `POST /rpc`, `GET /events`, `GET /health`;
  bound to `127.0.0.1`, bearer token, cross-origin requests refused.

## The agentic loop

`AgentLoop.run(session, text)`:

1. Build the system prompt (mode rules, permissible apps, workspace, subagent list,
   workspace memory) and stream a completion through `streamChat`.
2. Normalise provider chunks → text deltas (streamed to the UI), reasoning, tool calls.
3. No tool calls → finish the turn.
4. For each tool call: **permission gate** → execute → append result.
5. Repeat until no tool calls or `agent.maxSteps` (default 24).

The gate, in `executeTool`, is the security-critical part:

| Check | Result |
| --- | --- |
| unknown tool | `{ error, available }` — the model gets the catalogue back |
| `mode === 'plan'` and tool mutating | refused before any approval prompt |
| `preview()` says approval needed and not auto-approved | `approval.request` → wait for the user |
| user denies | `{ error, denied: true }` |
| otherwise | execute; thrown errors become `{ error }` |

Auto-approval comes from three places only: `mode === 'autonomous'`, "allow for session"
(per tool, per session), or `agent.autoApproveTools` in config. Policy `autoApprove` is a
fourth, narrower one expressed by the tool's own `preview()`.

A tool may return `meta.images` (screenshots) — the loop turns those into an image message
so vision models can read the screen, and `meta.awaitingUser` to end the turn (`ask_user`).

### Transcripts strict endpoints accept

Strict OpenAI-compatible gateways (DeepSeek behind litellm, Azure OpenAI) validate the whole
history and reject the *entire* request for one defect in it. These rules are enforced here:

| Rule | What breaks | Repair |
| --- | --- | --- |
| every assistant `tool_calls` message is followed by exactly one `tool` message per call id | an image pushed before its own tool result splits the group ("An assistant message with 'tool_calls' must be followed by tool messages") | images are collected per turn and appended **after** every reply; `repairToolHistory` fixes a history already in that shape |
| a turn cannot end with an unresolved tool call | cancelling or a throwing tool left a call unanswered | an error result is appended for every call, on abort too |
| a history that ends on a tool result must replay `reasoning_content` | DeepSeek's thinking mode 400s ("The reasoning_content in the thinking mode must be passed back"); an absent or `null` field is rejected, an **empty string** is accepted | `streamChat` retries with `reasoning: ''` on tool-call messages that carry none |

These last two are repairs, not assumptions — a gateway that needs neither never sees them.
A text-only model rejecting a screenshot is repaired the same way: the image is dropped and
the model is told, so a session started on a non-vision model does not die at the first
`desktop_screenshot`. Each repair is applied at most once per request, and the repairs
compose (image rejection followed by a reasoning rejection retries twice).

## Desktop control

```
tool  →  DesktopController  →  PolicyEngine  →  AuditLog
                    ↓
                 DesktopDriver  (Windows | mock)
```

* `DesktopController` resolves the target window (`{ app }` → running window by exe,
  preferring the foreground one; or an exact `handle`), asks the policy about *this action
  on this process image*, audits the outcome and only then calls the driver.
* `WindowsDriver` implements everything with short-lived PowerShell processes: User32
  P/Invoke for windows, UI Automation for controls, `SendKeys` for input, `System.Drawing`
  for screenshots. Scripts are written to a temp `.ps1` and handed over with `-File`: the
  base64 of `-EncodedCommand` overflows the 32767-character command line once the P/Invoke
  preludes are added, and the file carries a UTF-8 BOM so PowerShell 5.1 decodes non-ASCII
  titles correctly. String literals are doubled-quoted. The driver has its own page:
  [windows-driver.md](windows-driver.md).
* `MockDriver` implements the same interface in memory with a seeded window, so the whole
  pipeline — policy, controller, tools, tests — runs on any machine and in CI.

## Subagents

`SubagentRunner` tracks runs, caps concurrency (`subagents.maxConcurrent`), streams output
and audits each spawn.

* `internal` → `SessionManager.runNested` creates a child session (`depth + 1`, read-only
  tool subset from `SUBAGENT_TOOL_ALLOWLIST`) and returns its final assistant message.
  The child session stays visible in the UI.
* CLI agents → `CliAgentAdapter` spawns `command + configured args + prompt` in the
  workspace, caps output, honours abort, 15-minute default timeout.

Depth > 2 is refused, and a subagent's toolset contains no delegating tools.

## Files preview and the workspace terminal

Two renderer surfaces reach outside the sandbox in a narrow, explicit way.

**The Files panel** (`src/renderer/explorer.ts`) reads the workspace through the service
(`fs.list`, `fs.readFile`) one folder and one file at a time. Markdown and HTML open
rendered; the preview header carries a Rendered / Source toggle for the files that can do
both. The HTML path is sanitised in the renderer (`src/renderer/preview.ts`) rather than
trusted: scripting elements, inline handlers, `javascript:` / `vbscript:` / non-image
`data:` URLs, CSS `expression()` and `url()` and the document wrapper are stripped, while
styles, tables, images and links survive. `preview.test.ts` covers the classification and
the sanitiser.

**File viewers** (`src/renderer/fileView.ts`) decide how one file is shown, so the preview
peek and the document tab can never drift apart. Markdown and HTML open rendered and keep
the Rendered / Source toggle; a `.csv` / `.tsv` is parsed into a table with a sticky header
and right-aligned numbers (`src/renderer/csv.ts`); a `.log` is shown line by line with a
level accent, a level filter carrying per-level counts and a search that highlights its
matches (`src/renderer/logView.ts`); a picture is loaded as an `<img>` and a `.pdf` is
handed to Chromium's own viewer in an `<iframe>`. Word, Excel and PowerPoint files are ZIP
archives of XML: the service converts them to markup (`src/service/preview/office.ts`, over
the same `readZip` a skill archive uses) and the renderer sanitises the result before it
reaches the DOM, so layout, fonts and embedded objects are dropped while headings, tables,
sheets and slides survive.

Pictures and PDFs need the file itself rather than its text, so the renderer points at
`app://beecode/file?path=…` — a route the main process serves (`serveWorkspaceFile`, on by
`plugins: true` for the PDF viewer). It is confined to the workspace root and to the
extensions a viewer asks for, so the renderer still has no general file read.

**The terminal** (`src/main/terminal.ts` + `src/renderer/terminal.ts`) is a command runner
that lives in the main process and is exposed as IPC channels (`beecode:terminal-*`), not as
a renderer RPC method — the agent cannot reach it and nothing is added to
`RENDERER_METHODS`. Each command is a one-shot shell invocation (`cmd.exe /d /s /c` on
Windows, `/bin/sh -c` elsewhere) with a working directory pinned inside the workspace root;
`cd` is interpreted by the runner and cannot climb above that root. Confinement is about
where a command *starts*: the child still runs with the user's own rights, like any
terminal. Output is pushed back over `beecode:terminal-update` and capped at 4000 lines /
400 KB; Stop kills the process tree and Clear empties the scrollback. When the configured
workspace root changes, the runner re-confines (`setRoot`) and drops the old scrollback.

### Main-area tabs

The main area is one column with two occupants that exclude each other, plus a header.

```
tab strip   Chat · <doc> · <doc> · Browser          [☀ Light]
────────────────────────────────────────────────────────────
view-chat     transcript
view-doc      document pane   (name · path · size · Rendered/Source · ×)
view-browser  (document pane hidden; the dock grows to fill the column)
────────────────────────────────────────────────────────────
browser dock  chrome + WebContentsView bounds
composer      always visible
```

* `docTabs.ts` is a pure model — open / close / activate / view / theme — with no DOM, so
  the transition rules are unit-tested directly. Opening a file that is already open
  activates its tab instead of duplicating it and keeps the remembered Rendered/Source view.
* `mainArea.ts` owns the strip and the document pane. Rendered **Markdown** goes through
  the transcript renderer; rendered **HTML** goes through the same sanitiser as the Files
  peek and is mounted in a **shadow root**, which is what keeps a report's `body {}` rule
  from restyling the app.
* The **Light/Dark** toggle sets custom properties on the document pane. Custom properties
  inherit through a shadow boundary, so the preview inside the shadow root follows without
  any script injected into the file, and the app chrome (which does not read those
  properties) stays dark. The choice lives in `localStorage`.
* The **Browser** tab is not a second view: it asks the existing dock for
  `setMode('maximized')` and restores the previous mode when the tab is left. Because the
  `WebContentsView` is placed inside the dock's reported rectangle, the page cannot cover
  the composer — and hiding the dock hides the page.

## MCP servers and skills

Tools come from three places: the built-in catalogue (`desktop_*`, `fs_*`, `shell_*`,
`todo_*`, `memory_*`, `agent_delegate`), external **MCP servers**, and the `skill` tool
that loads markdown playbooks from disk.

`McpManager` connects every enabled server during `init()` — before the registries are
built, because a registry cannot grow tools afterwards — and projects each published tool
into the catalogue as `mcp__<server>__<tool>`. An MCP tool is mutating unless the server
sets `annotations.readOnlyHint: true`, so it lands behind the same approval gate as the
built-in mutating tools. MCP names are deliberately absent from
`SUBAGENT_TOOL_ALLOWLIST`: a nested internal session never reaches a third-party server.
`mcp.reload` reconnects and rebuilds both registries.

`SkillStore` scans `~/.beecode/skills`, `<cwd>/.beecode/skills` and any configured
`skills.dirs` once per working directory, and renders only names and descriptions into the
system prompt. The body arrives through the read-only `skill` tool when the model asks for
it, which keeps every installed playbook out of the context window until it is needed.

Details and configuration: [mcp-and-skills.md](./mcp-and-skills.md).

## Storage

| Path | Contents |
| --- | --- |
| `~/.beecode/config.json` | models, modes, desktop/subagent settings (no keys) — written by `config.set` |
| `~/.beecode/policy.json` | the permission policy |
| `~/.beecode/audit.jsonl` | append-only audit trail (rotates at 2 MB to `.1`) |
| `~/.beecode/memory/<sha1(cwd)>.json` | workspace notes written by the agent |
| `~/.beecode/logs/service.log` | service log (JSONL) |

Set `BEECODE_HOME` to relocate all of it (the tests do this).

`config.set` is the only write path for model or workspace changes, and it runs
`normalizeConfig` first: the sandboxed renderer's payload is untrusted, and an empty model
list, a duplicate preset id or a dangling `defaultModelId` would otherwise leave the agent
loop with no usable model. The normalised config becomes the live one immediately — model
selection for the next session, `agent.workingDir` as the filesystem policy root — so no
service restart is needed.

## Failure behaviour

* Service crash → supervisor restarts it; the UI shows `restarting` and reconnects.
* Tool failure → in-band `{ error }`; the model decides what to do next.
* Policy denial → structured error with the reason; the model is instructed not to work
  around it and to use `ask_user` instead.
* LLM transport error → 3 attempts with backoff on 429/5xx; then a transcript error entry
  and `status: error` (never a silent hang).
* Window close → window hides to tray; the service keeps running.
