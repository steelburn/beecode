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
  markup (`renderMarkdown` in `src/renderer/dom.ts`).
* Its entire capability surface is `window.beeCode` (`src/shared/bridge.ts`): a typed RPC
  proxy, four config/policy helpers, a directory picker, an `https`-only link opener and
  two event subscriptions.

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
  for screenshots. Scripts are passed via `-EncodedCommand` (base64/UTF-16LE), so no user
  text is ever interpolated into a command line; string literals are doubled-quoted.
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
