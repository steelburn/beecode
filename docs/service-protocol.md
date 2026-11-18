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
| `audit.list` | `{ limit? }` | `AuditEntry[]` |
| `agents.list` | `{}` | `AgentInfo[]` |
| `subagent.list` | `{}` | `SubagentRunInfo[]` |
| `subagent.cancel` | `{ runId }` | `{ cancelled: boolean }` |
| `tools.list` | `{}` | `ToolInfo[]` |
| `mcp.list` | `{}` | `{ servers: McpServerStatus[] }` |
| `mcp.reload` | `{}` | `{ servers: McpServerStatus[] }` |
| `skill.list` / `skill.reload` | `{ cwd? }` | `{ skills: SkillInfo[] }` |
| `skill.read` | `{ name, cwd? }` | `{ skill: SkillInfo, content }` |

MCP servers and skills attach to that catalogue rather than replacing anything:
`tools.list` includes the `mcp__<server>__<tool>` entries once a server is connected, and
the `skill` tool is always registered. See [mcp-and-skills.md](./mcp-and-skills.md).

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

## Events (`GET /events`, or `method: "event"` on stdio)

| Event | Payload |
| --- | --- |
| `service.health` | `ServiceHealth` (also the ready signal) |
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
