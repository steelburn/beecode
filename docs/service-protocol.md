# Service protocol

The background agent service speaks **JSON-RPC 2.0**. Two transports carry the same
methods and payloads.

* **stdio** — newline-delimited JSON on stdin/stdout, one message per line. Used by the
  Electron main process. Service events arrive as notifications:
  `{"jsonrpc":"2.0","method":"event","params":{ "type": "...", "payload": {...} }}`.
  Logs go to stderr and `~/.beecode/logs/service.log`, never to stdout.
* **HTTP + SSE** — `POST /rpc` (one request per body), `GET /events` (SSE stream),
  `GET /health` (unauthenticated liveness). Bound to `127.0.0.1`; every `/rpc` and
  `/events` call needs `Authorization: Bearer <token>`; requests carrying an `Origin`
  header are refused (no browser cross-origin use).

## Starting it headless

```bash
npm run build
npm run service:http -- --port=4870 --workspace=C:\work\demo
# stdout: {"type":"beecode-service-ready","port":4870,"token":"…"}
```

`BEECODE_SERVICE_TOKEN` pins the token; otherwise one is generated per process.
`BEECODE_HOME` relocates config/policy/audit (`~/.beecode` by default).

## Calling it

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"session.create","params":{"title":"demo","mode":"act"}}' \
  http://127.0.0.1:4870/rpc
# → {"jsonrpc":"2.0","id":1,"result":{"id":"s_m3x…","mode":"act", …}}

curl -s -N -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4870/events
# → data: {"type":"assistant.delta","payload":{"sessionId":"s_m3x…","entryId":"e…","text":"Sure"}}
```

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `app.hello` | `{ clientVersion }` | `{ protocol, health }` |
| `service.health` | `{}` | `ServiceHealth` |
| `service.shutdown` | `{}` | `{ stopping: true }` |
| `session.list` | `{}` | `SessionSummary[]` |
| `session.create` | `{ title?, cwd?, mode?, model?, parentSessionId? }` | `SessionSnapshot` |
| `session.get` | `{ sessionId }` | `SessionSnapshot` |
| `session.delete` | `{ sessionId }` | `{ deleted: true }` |
| `session.prompt` | `{ sessionId, text }` | `{ accepted: boolean }` |
| `session.abort` | `{ sessionId }` | `{ aborted: boolean }` |
| `session.setMode` | `{ sessionId, mode }` | `SessionSummary` |
| `session.setModel` | `{ sessionId, model }` | `SessionSummary` |
| `session.setCwd` | `{ sessionId, cwd }` | `SessionSummary` |
| `approval.respond` | `{ approvalId, decision }` | `{ ok: boolean }` |
| `policy.get` / `policy.set` | `{}` / `{ policy }` | `PolicyDocument` |
| `config.get` / `config.set` | `{}` / `{ config }` | `BeeCodeConfig` |
| `workspace.state` | `{}` | `WorkspaceState` |
| `workspace.set` | `{ path }` | `WorkspaceState` |
| `workspace.forget` | `{ path }` | `WorkspaceState` |
| `knowledge.add` | `{ path, label? }` | `WorkspaceState` |
| `knowledge.remove` | `{ path }` | `WorkspaceState` |
| `knowledge.rename` | `{ path, label }` | `WorkspaceState` |
| `knowledge.mkdir` | `{ path, name }` | `{ path }` |
| `knowledge.copy` | `{ from, to, overwrite? }` | `{ path }` |
| `audit.list` | `{ limit? }` | `AuditEntry[]` |
| `agents.list` | `{}` | `AgentInfo[]` |
| `subagent.list` | `{}` | `SubagentRunInfo[]` |
| `subagent.cancel` | `{ runId }` | `{ cancelled: boolean }` |
| `tools.list` | `{}` | `ToolInfo[]` — every registered tool with `enabled: false` for a name in `config.tools.disabled` |
| `mcp.list` | `{}` | `{ servers: McpServerStatus[] }` |
| `mcp.reload` | `{}` | `{ servers: McpServerStatus[] }` |
| `skill.list` / `skill.reload` | `{ cwd? }` | `{ skills: SkillInfo[] }` |
| `skill.read` | `{ name, cwd? }` | `{ skill: SkillInfo, content }` |
| `skill.remove` | `{ name, cwd? }` | `{ removed: string, skills: SkillInfo[] }` — deletes the skill folder and rescans |

MCP servers and skills attach to that catalogue rather than replacing anything:
`tools.list` includes the `mcp__<server>__<tool>` entries once a server is connected, and
the `skill` tool is always registered. See [mcp-and-skills.md](./mcp-and-skills.md).

A tool is not offered to the model unless the user left it on. `config.tools.disabled` names
the switched-off ones — the same list **Settings → Tools** writes:

```json
{ "tools": { "disabled": ["shell_run", "desktop_click"] } }
```

A switched-off tool stays in `tools.list` (the panel has to be able to show it as off), but it
is filtered out of the schemas sent to the LLM, and an `execute` for it never reaches the
handler — the result is `{ "error": "tool \"shell_run\" is switched off …", "disabled": true }`.
Read-only subagents inherit the switches, and the unknown-tool error lists only the enabled
names. This is the availability axis, not the approval axis: `agent.autoApproveTools` and the
policy decide whether a call needs a click, never whether the tool exists. A name that matches
no registered tool is kept rather than dropped — it may be a plugin or MCP tool that is merely
not installed right now.

`decision` is `allow`, `allow-session` (auto-approve this tool for the rest of the
session) or `deny`. Errors use standard JSON-RPC codes: `-32700` parse, `-32600` invalid
request, `-32601` unknown method, `-32603` internal, `-32001` unauthorized.

The working directory is **per session**. `session.create` accepts a `cwd`, and
`session.setCwd` moves an existing session to another folder (the folder must exist —
anything else is a JSON-RPC error, so a typo cannot silently strand a session). From the next
tool call on, that session's file and shell tools resolve relative paths against the new
directory, and the directory counts as an allowed root for those calls only: the policy's
`filesystem.workspaceOnly` / `allowedRoots` rules still apply, so a session pointed at a
folder outside the configured workspace still cannot write anywhere else. The UI exposes it as
the clickable folder chip under the session title.

`session.prompt` is asynchronous: it returns `accepted: true` and the turn's progress
arrives on the event stream. Prompts to the same session are queued.

### Knowledge folders

A workspace may reference one or more **knowledge folders** — shared shelves the agent may
read but never write. They are attached with `knowledge.add` (and from the Files panel) and
show up in `WorkspaceState.knowledge`; nothing else about the workspace changes, so a folder
outside the workspace root becomes browsable and readable without widening the workspace
grant.

The policy engine tests the knowledge roots first: an `fs.read`-class action inside one is
allowed without approval, and every write is **denied** with a reason — even when the folder
sits inside the workspace, the narrower grant wins. The only writes are the two the user
drives:

- `knowledge.mkdir` — `{ path, name }` creates one subfolder (a single path segment, no
  separators) inside a knowledge folder and returns its path.
- `knowledge.copy` — `{ from, to, overwrite? }` copies a workspace file into a knowledge
  folder, creating missing parents. A source that is already inside a knowledge folder is
  refused, and so is clobbering an existing file unless `overwrite: true`. The copy is
  audited as a `file-write`.

Neither is reachable as an agent tool: they are service RPCs, so the agent cannot route a
write around the denial. The agent is told the roots exist in its system prompt
(`KNOWLEDGE FOLDERS (read-only)`), so a denial is not mistaken for a permission bug and
retried from another angle.

Every one of these calls returns the new `WorkspaceState`, and the service also pushes it as
a `workspace.state` event, so a panel — or a second window — repaints without asking.

## Events (`GET /events`, or `method: "event"` on stdio)

| Event | Payload |
| --- | --- |
| `service.health` | `ServiceHealth` (also the ready signal) |
| `workspace.state` | `WorkspaceState` — the root, recents or knowledge folders changed |
| `session.snapshot` | `SessionSnapshot` |
| `session.entry` | `{ sessionId, entry: TranscriptEntry }` |
| `session.status` | `{ sessionId, status }` |
| `assistant.delta` | `{ sessionId, entryId, text }` |
| `tool.call` | `{ sessionId, call: { id, name, args } }` |
| `tool.result` | `{ sessionId, callId, name, result, failed }` |
| `approval.request` | `ApprovalRequest` |
| `approval.resolved` | `{ sessionId, approvalId, decision }` |
| `subagent.update` | `SubagentRunInfo` |
| `desktop.activity` | `AuditEntry` |
| `log` | `{ level, message, at }` |
| `error` | `{ sessionId?, message }` |

## Driving a permissioned action from a script

```bash
# 1. ask the agent to do something that needs approval
curl -s … -d '{"jsonrpc":"2.0","id":2,"method":"session.prompt",
  "params":{"sessionId":"s_m3x…","text":"Type hello into Notepad"}}'

# 2. the event stream emits approval.request — answer it
curl -s … -d '{"jsonrpc":"2.0","id":3,"method":"approval.respond",
  "params":{"approvalId":"a_p81…","decision":"allow"}}'
```

A request that never gets an answer keeps the session in `awaiting-approval`; aborting the
session resolves it as a denial.

## Notes

* The service holds sessions in memory (bounded to 50, idle ones evicted first). Durable
  state is the audit log, the policy/config files and workspace memory notes.
* Model keys are read from the environment of the **service** process (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY` or the preset's `apiKeyEnv`).
* `PROTOCOL_VERSION` in `src/shared/protocol.ts` is bumped on breaking changes.
