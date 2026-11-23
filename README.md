# beeCode

An agentic desktop application. beeCode watches and drives real applications on your
desktop — but only the ones you permit — and delegates work to subagents when a task is
better split up.

It is built on the architecture of [ado-code](../ado-code) (the Azure DevOps assistant for
VS Code): the same tool-calling loop, the same `{ "error": ... }` tool-result convention,
the same "ask / plan / act / autonomous" modes and the same adapter approach to external
agents. What is new is the host: instead of a VS Code extension it is an Electron desktop
app wrapped around a **background agent service** and a **permissioned desktop-control
layer**.

```mermaid
flowchart LR
  subgraph renderer["Electron renderer — sandboxed"]
    chat["chat · approvals · panels"]
    dock["browser dock<br/>(chrome only)"]
  end
  preload["preload<br/>typed RPC proxy"]
  main["main process<br/>window · tray · WebContentsView · desktop driver"]
  service["background service<br/>SessionManager → AgentLoop → tools"]
  llm["LLM API"]
  driver["Windows driver<br/>UI Automation + CDP"]

  chat --> preload
  dock --> preload
  preload <-->|"contextBridge IPC"| main
  main <-->|"JSON-RPC over stdio"| service
  service --> llm
  service -.->|"browser/exec — reverse RPC"| main
  main --> driver
```

![beeCode driving the internal browser, the AI cursor resting on the primary action](docs/images/app-window.png)

The arrow is not one-way. The internal browser’s page lives in the main process, so
when the agent drives it the service sends `browser/exec` *back* over the same stdio
pipe and main answers. Policy and audit stay in the service; the sandboxed
`WebContentsView` and the AI cursor stay on the host side.

## Quick start

Requires Node.js >= 22.12 (pinned in `.nvmrc`): Electron 42's install chain refuses older
runtimes.

```bash
npm install          # Electron is the only binary dependency
npm run build
npm start            # builds, then opens the app
```

Set a model key before the first prompt (keys are read from the environment and never
written to disk):

```bash
set ANTHROPIC_API_KEY=sk-...      # or OPENAI_API_KEY
```

Local models work too — add an `openai-compatible` preset pointing at Ollama or LM Studio
in the **Settings** dialog (see below) or in `~/.beecode/config.json`.

## Extending it

Three extension points sit beside the built-in tools:

- **Plugins** — bundled starters plus any folder you drop into `~/.beecode/plugins/`: a
  `plugin.json` manifest and a CommonJS module, no build step. A plugin adds tools and
  reaches the outside world only through the permissions its manifest declares. Three ship
  with the app — a PDF viewer (`pdf_open`), a Markdown/HTML → PDF generator
  (`pdf_generate`) and an Excel exporter (`excel_export`) — and every plugin can be
  enabled or disabled in the **Plugins** card of the **MCP & skills** section of Settings.
- **MCP servers** — point `mcpServers` in `~/.beecode/config.json` at any Model Context
  Protocol server (stdio or streamable HTTP); its tools appear as `mcp__<server>__<tool>`
  and go through the approval card unless the server marks them read-only. Servers can also
  be added, edited, enabled and removed in that same section.
- **Skills** — drop a `SKILL.md` playbook into `~/.beecode/skills/<name>/` (or
  `.beecode/skills/` in the workspace). The agent sees its name and description, and loads
  the instructions with the `skill` tool only when the task matches.

See [docs/plugins.md](docs/plugins.md) for the plugin contract, permissions and host
methods, and [docs/mcp-and-skills.md](docs/mcp-and-skills.md) for the MCP and skill config
shape.

## Settings

**Settings** — the gear in the topbar, or `Ctrl+,` — is where the endpoint, the model and
the working directory are chosen, no file editing required. It is one dialog with five
sections: **General**, **Tools**, **Permissions**, **MCP & skills** and **Scheduled runs**.

![The settings dialog, General section: provider presets, the API key and the working directory](docs/images/settings-dialog.png)

| Control | Effect |
| --- | --- |
| Provider · Model · Base URL · API key env var · Context window | one card per preset; **Base URL** is what points beeCode at a custom gateway (DeepSeek, OpenRouter, vLLM, Ollama, LM Studio) |
| **API key** (write-only) | paste the key to store it in `~/.beecode/secrets.json`; a blank field keeps the stored key, and the card shows whether one is set |
| `default` radio | the preset a new session starts with |
| Add model / Remove | extra presets; the service refuses a save that would leave none |
| Working directory + Browse… | where new sessions start and the boundary the file tools cannot leave |

Saving goes through `config.set`, so the service — not the renderer — decides what is
acceptable: ids are trimmed and de-duplicated, a trailing slash is stripped from the Base
URL, a dangling `defaultModelId` is repointed at the first preset, a blank working
directory falls back to the default, and a config with no usable preset is rejected. The
working directory is pushed into the policy engine as the filesystem root and created if it
does not exist. Existing sessions keep the directory they were created with.

### Where the key lives

`~/.beecode/config.json` is shareable user state, so a key is never written there. Three
ways to provide one, highest precedence first:

1. **Settings › API key** — write-only. The service moves it to `~/.beecode/secrets.json`
   (mode 0600) and `config.get` returns only a `hasKey` flag, never the value.
2. **`API_KEY=` in `.env.llm`** — read from the working directory or `~/.beecode/.env.llm`
   and published as `$BEECODE_LLM_API_KEY`.
3. **The env var named in "API key env var"** — e.g. `OPENAI_API_KEY`.

`apiKeyEnv` must be a variable *name*. A key pasted into that field is refused on save (and
dropped when an older config is loaded), because it would both land in `config.json` and
resolve to nothing. A missing key is reported before the request goes out —
`Missing API key for "<preset>"` — rather than surfacing as a bare 401 from the endpoint.
A loopback Base URL (Ollama, LM Studio) may still run keyless.

## What it can do

| Capability | Tools |
| --- | --- |
| See the desktop | `desktop_list_windows`, `desktop_ui_tree`, `desktop_screenshot` |
| Start and focus apps | `desktop_launch`, `desktop_focus`, `desktop_close` |
| Drive a UI | `desktop_invoke`, `desktop_set_value`, `desktop_type`, `desktop_hotkey` |
| Work with files | `fs_list`, `fs_read`, `fs_write`, `fs_search`, `fs_mkdir`, `fs_delete`, `fs_move` |
| Run allow-listed commands | `shell_run` |
| Browse the web (sandboxed, AI cursor) | `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, `browser_wait`, `browser_tabs`, `browser_screenshot`, `browser_close` |
| Delegate | `subagent_delegate`, `agents_list`, `subagent_list`, `subagent_cancel` |
| Remember | `todo_write` / `todo_read`, `memory_write` / `memory_read`, `ask_user` |

### Switching tools off

The **Tools** section lists every registered tool — grouped by subsystem, with its description
and a switch — so the whole catalogue stays visible without every tool being offered to the
model. A tool you switch off keeps its row (so you can see it is off and turn it back on) but
is filtered out of the schemas the model receives, and calling it by name returns
`tool "<name>" is switched off` instead of running. The switches are `config.tools.disabled`
in `~/.beecode/config.json`, they apply to subagents too, and they are independent of the
approval axis: `agent.autoApproveTools` and the policy decide whether a call needs a click,
never whether the tool exists.

Every one of those is gated. See [docs/desktop-permissions.md](docs/desktop-permissions.md)
for the policy, and [docs/windows-driver.md](docs/windows-driver.md) for how the driver
executes an action on Windows.

## The permission model (deny by default)

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent loop (service)
  participant P as Policy · policy.json
  participant U as Approval card (renderer)
  participant H as Host (main process)
  participant L as Audit log

  A->>P: desktop_click (notepad, "Save")
  alt app or action not permitted
    P-->>A: error — the action is not allowed
  else permitted but not auto-approved
    P-->>A: needs approval
    A->>U: approval card
    U-->>A: approved
    A->>H: perform the action
    H-->>A: result
  else auto-approved
    A->>H: perform the action
    H-->>A: result
  end
  A->>L: append (action, args, outcome)
```

The agent can only touch applications listed in the policy, and only the actions ticked
for each one. This is enforced in the service — **not** in the prompt — so a clever prompt
cannot widen it:

```jsonc
{
  "id": "notepad",
  "name": "Notepad",
  "exe": ["notepad.exe"],
  "actions": ["launch", "focus", "read", "invoke", "type", "key", "screenshot", "close"],
  "autoApprove": true          // skip the confirmation prompt (still audited)
}
```

* `cmd.exe`, `powershell.exe`, `regedit.exe`, … are on a permanent deny list.
* Actions on an app rule without the action fail with a policy error the model can read.
* Mutating actions raise an **approval card** in the UI unless the app/action is
  auto-approved or the session is `autonomous`.
* Every allowed, denied, approved and failed action is appended to
  `~/.beecode/audit.jsonl` and mirrored in the **Activity** panel.

Edit the policy in the app (Settings → Permissions) or at `~/.beecode/policy.json`.

## The internal browser

![The browser surface alone: the AI cursor ring, its target label and the page it drove](docs/images/ai-cursor.png)

```mermaid
sequenceDiagram
  autonumber
  participant M as Model
  participant T as browser_* tool
  participant C as BrowserController (service)
  participant P as BrowserPolicy
  participant H as BrowserHost (main)
  participant V as sandboxed WebContentsView
  participant Cur as AI cursor (isolated world)

  M->>T: browser_click (tabId, ref)
  T->>C: run the action
  C->>P: evaluateBrowser(tab.url, "click")
  P-->>C: allow
  C->>H: browser/exec (reverse JSON-RPC)
  H->>Cur: move the cursor to the target first
  H->>V: CDP Input.dispatchMouseEvent
  V-->>H: page reacted
  H-->>C: snapshot after the action
  C-->>M: condensed text + element list
```

The agent can browse the web in a window it drives itself, with a cursor you can watch
work. It is deliberately a *separate* surface from the desktop driver: nothing here
reaches your OS, your files or another app.

- The page is a sandboxed `WebContentsView` (`sandbox: true`, no Node,
  `contextIsolation`) in a dedicated, in-memory session. Every permission request,
  download, popup and non-web scheme is refused by the host before the page sees it.
- Input is dispatched through the DevTools protocol (`Input.dispatchMouseEvent` /
  `insertText` / `dispatchKeyEvent`), not scripted into the page, so a site cannot
  observe or fake what the agent clicked.
- The AI cursor is drawn in the page’s isolated world: it glides to the target, rings
  it and ripples on click, so you can follow along.
- Minimize, maximize and close live in the dock’s title bar. Minimizing collapses it to
  the tab strip and reports no rectangle, so the page view detaches instead of floating
  over the chat; maximizing fills the column above the composer; closing tears the tabs
  down rather than only hiding them. If the agent acts while the panel is minimized, it
  restores itself — a hidden page would hide the cursor you are meant to watch.
- Every call is audited under the `browser` action, and `browser_open` and friends are
  gated like any other capability.

It ships enabled and permissive because the sandbox — not a host list — is the boundary.
Tighten it in the policy document (`policy.json`):

```json
{
  "browser": {
    "enabled": true,          // false: every browser_* tool refuses
    "allowAnyHost": false,    // false: only allowedHosts are reachable
    "allowedHosts": ["github.com", "*.mozilla.org"],
    "deniedHosts": ["*.bank.example"],   // beats a wildcard
    "allowInput": false,      // read-only browsing
    "requireApproval": true   // ask before each navigation
  }
}
```

`file:`, `javascript:` and `data:` URLs are refused regardless of the lists, and
`about:blank` is always allowed so the agent can start from an empty tab. Host matching
is label-aware: `*.github.com` covers the apex and its subdomains, but not
`evil-github.com`.

Tab count, home page and session persistence live in `config.json` under `browser`
(`maxTabs`, `homeUrl`, `persistSession`, `showCursor`, `allowScripts`).

## The Files panel

The **Files** tab reads the workspace one folder at a time (the renderer never touches the
filesystem — `fs.list` / `fs.readFile` go through the service). Markdown and HTML open
**rendered**, everything else opens as source, and the Rendered / Source toggle in the
preview header flips a file that can do both; plain text has no toggle, because rendered
plain text is the same text.

A preview is arbitrary workspace content, so the HTML is sanitised instead of trusted
(`src/renderer/preview.ts`): scripting elements, inline handlers, `javascript:` /
`vbscript:` / non-image `data:` URLs, CSS `expression()` and `url(`, and the document
wrapper are dropped, while styles, tables, images and links survive. Markdown is rendered
by the same code the chat transcript uses.

## The side columns

The rail and the side panel are yours to size: drag the grip on the inner edge of either
one, double-click it to return to the shipped width, or use the arrow keys while it has
focus. Both collapse from their topbar chevron — `«` sends the rail away, `»` the panel,
and both flip direction once the column is gone.

A collapsed column leaves a handle on the window edge it vacated. That handle is the
point: the toggle in the topbar slides right along with the panel it just hid, so the
handle is the one control that stays where you are looking. Click it — or the topbar
chevron — to bring the column back; both remember their width across restarts.

![The side panel collapsed, with the edge handle that brings it back](docs/images/panel-collapsed.png)

## The workspace terminal

The **Terminal** drawer — the `>_` button in the topbar, or ``Ctrl+` `` — runs
commands confined to the workspace: one at a time, always started with its working
directory inside the workspace root.

![The terminal drawer with a command and its output in the scrollback](docs/images/terminal-drawer.png)

* The shell lives in the main process (`src/main/terminal.ts`); the renderer only draws the
  scrollback and sends a line, so it stays a sandboxed page with no `require`.
* Confinement is about *where a command starts*. `cd` is interpreted by the runner and
  cannot climb above the root (an absolute path outside it is refused, as is `..`), but the
  command itself runs with your account's rights — exactly like a normal shell.
* Output is pushed back over IPC (`beecode:terminal-update`), because a command keeps
  producing lines after the invoke has answered. The scrollback is capped at 4000 lines /
  400 KB.
* **Stop** kills the process tree (`taskkill /T /F` on Windows), **Clear** drops the
  scrollback and keeps the working directory, and `↑` / `↓` walk the last 50 commands.
* Nothing here is an agent tool: the terminal is IPC-only, not a renderer RPC method, so the
  agent can ask for a shell command but cannot reach this surface.

When the configured workspace root changes, the runner re-confines itself to the new root
and drops the old scrollback.

## Modes

| Mode | Behaviour |
| --- | --- |
| `ask` | read-only inspection; every mutation asks first |
| `plan` | no side effects at all — mutating tools are refused before approval |
| `act` | supervised execution; policy decides what needs a prompt |
| `autonomous` | no prompts, still fully bounded by the policy |

## Subagents

`subagent_delegate` hands a self-contained task to:

* **internal** — a nested beeCode session with a read-only toolset (files + windows +
  screenshots), useful for parallel research or verification.
* **CLI agents** — `codex`, `claude`, `gemini`, `aider`… spawned in the workspace when the
  binary is on `PATH`. Each is a config entry, not a class.

Runs are capped by `subagents.maxConcurrent`, streamed into the **Subagents** panel and
cancellable. Delegation depth is limited to 2 and a subagent cannot delegate further.

## Headless use

The same service runs without Electron, over loopback HTTP + SSE with a bearer token:

```bash
npm run service:http                     # prints { type, port, token } on stdout
curl -H "Authorization: Bearer <token>" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools.list","params":{}}' \
     http://127.0.0.1:4870/rpc
```

See [docs/service-protocol.md](docs/service-protocol.md).

## Project layout

```
src/
  main/      Electron main process: window, tray, IPC surface, service supervisor
  preload/   contextBridge API (the renderer's only capability)
  renderer/  the UI — plain TypeScript + CSS, no framework
  service/   the background agent service (never imported by the UI)
    llm/         provider-agnostic streaming client + system prompts
    session/     agent loop, session manager, approval handshake
    tools/       tool catalogue (desktop, files, shell, control, subagents)
    desktop/     driver interface, Windows PowerShell/UIA driver, mock driver, controller
    subagents/   runner + CLI adapters
    transports/  stdio JSON-RPC and loopback HTTP/SSE
  plugins/   plugin contract, host (discovery + permissions) and bundled starters
  shared/    protocol types, policy/config shapes, defaults, preload bridge contract
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | esbuild bundles main / preload / service / renderer into `dist/` |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | policy, desktop-controller and end-to-end service tests |
| `npm run smoke` | boots the real app in `--smoke` mode and asserts the UI reached the service |
| `npm run check` | typecheck + test + build + smoke |
| `npm run dist` | NSIS installer in `release/` via electron-builder |
| `npm run docs:screenshots` | boots the app, drives the internal browser, opens the settings dialog and the terminal drawer, and regenerates `docs/images/*.png` |
| `npm run verify:driver` | drives the real Windows driver against Calculator — UI Automation, coordinate clicks, resize |
| `npm run verify:llm` | round-trips the `.env.llm` endpoint through the agent loop |
| `npm run verify:installer` | boots the service out of the packaged `app.asar` and checks the shipped tools, driver and Settings panel |

## Status and limits

* The desktop driver is **Windows-only** (User32 + UI Automation through PowerShell). On
  other platforms the service falls back to the mock driver, so the app still runs and is
  testable; a native macOS/Linux driver can implement the same `DesktopDriver` interface.
* UI Automation is not available for every app (Electron/Chromium apps expose a reduced
  tree) — use `desktop_screenshot` with a vision model in that case.
* Sessions are in memory (bounded to 50); the durable record is the audit log, the
  workspace memory notes and `~/.beecode/config.json`.
