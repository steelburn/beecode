# MCP servers and skills

Two extension points sit beside the built-in tool catalogue:

| | What it adds | Where it comes from |
| --- | --- | --- |
| **MCP servers** | third-party tools (filesystem, browser, database, issue trackers…) | `mcpServers` in `~/.beecode/config.json` |
| **Skills** | reusable instruction playbooks the model loads on demand | `SKILL.md` files on disk |

Both are optional: with no MCP server configured and no skill installed, the service
behaves exactly as before.

## MCP servers

beeCode is an MCP **client**. Each configured server is spawned (or dialled) at service
start, handshakes with `initialize`, and publishes its tools through `tools/list`. Those
tools are registered next to the built-in ones under a namespaced name:

```
mcp__<server>__<tool>          # e.g. mcp__filesystem__read_file
```

### Configuration

```json
{
  "mcpServers": {
    "filesystem": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\work"],
      "env": { "LOG_LEVEL": "warn" },
      "timeoutMs": 30000
    },
    "issue-tracker": {
      "enabled": true,
      "transport": "http",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": { "authorization": "Bearer …" },
      "timeoutMs": 30000
    }
  }
}
```

| Field | Effect |
| --- | --- |
| `enabled` | `false` keeps the entry in the file but never starts it |
| `transport` | `stdio` (default) spawns `command` + `args`; `http` speaks streamable HTTP to `url` |
| `env` | extra environment variables for the stdio child, merged over `process.env` |
| `headers` | extra HTTP headers; the client adds `content-type`, `accept` and `mcp-session-id` itself |
| `timeoutMs` | per-request budget, default 30000 |

`normalizeMcpServers` (in `src/shared/defaults.ts`) drops entries that could never work —
an `http` server without a `url`, a `stdio` server without a `command` — so a typo cannot
stop the service from starting.

### Permissions

An MCP tool is **mutating unless the server marks it `annotations.readOnlyHint: true`**, so
every other MCP call goes through the same approval card as `fs_write` or `desktop_click`.
To auto-approve a specific tool, list its registered name in `agent.autoApproveTools`:

```json
{ "agent": { "autoApproveTools": ["mcp__filesystem__read_file"] } }
```

MCP tools are **not** in the internal-subagent allowlist (`SUBAGENT_TOOL_ALLOWLIST`), so a
nested session never reaches a third-party server; only the top-level agent does. External
CLI agents are unaffected — they bring their own tool stack.

### Failure and reload

* A server that fails to start is reported as `error` (with the message) and skipped. One
  broken server never blocks the others or the service.
* The handshake and `tools/list` run once, at start. Call `mcp.reload` after editing the
  config; it tears every connection down, reconnects, and rebuilds both tool registries.
  Saving a changed `mcpServers` map through `config.set` — which is what the panel editor
  does — performs that same reconnect and registry rebuild before it answers, so a saved
  edit is live immediately and no caller has to remember a second call.
* A standard `notifications/tools/list_changed` notification is logged; it does not yet
  trigger an automatic reload.

## Skills

A skill is a directory with a `SKILL.md` file — a playbook the model loads only when the
task matches. Discovery roots, in override order (later wins):

```
~/.beecode/skills/<name>/SKILL.md        source: user
<cwd>/.beecode/skills/<name>/SKILL.md    source: project
<skills.dirs entries>                    source: project
```

A flat `<root>/<name>.md` works too. The file is front matter plus markdown:

```markdown
---
name: release-notes
description: Turn a changelog into release notes grouped by area.
---

# Release notes

1. Read `CHANGELOG.md` …
```

`name` and `description` are parsed from the front matter (a `key: value` subset — no YAML
parser is involved). Without front matter the first `# heading` becomes the name and the
first paragraph the description; the name is slugified either way (`Release Notes` →
`release-notes`) because it doubles as a tool argument.

### How the agent uses it

1. `SkillStore` scans the roots once per working directory and renders a `## Skills`
   section into the system prompt (name, source, description — never the body).
2. When a skill matches, the model calls the read-only `skill` tool with `name` (and
   optionally `input` for task context) and gets the markdown instructions back.
3. `skill` without a name lists what is installed.

Skills are capped at `skills.maxBytes` each (default 64 KiB) so one file cannot flood the
context window. `skills.enabled: false` turns the whole feature off — no scan, no prompt
section, and the tool reports that nothing is installed.

```json
{ "skills": { "enabled": true, "dirs": ["docs/playbooks"], "maxBytes": 65536 } }
```

## In the app

The service exposes both lists over RPC, so the renderer shows them in the **MCP & skills**
panel of the sidebar: every configured server with its connection state, its identity and the
tools it contributes (flagged *needs approval* or *read-only*), plus every discovered skill
with its source (`user` or `project`). **Reconnect** calls `mcp.reload` + `skill.reload` and
re-renders. Nothing in the panel is cached locally, so it always mirrors what the agent loop
can actually use.

Server definitions are editable there too. *Add disabled* appends an entry with
`enabled: false` — nothing is spawned until you press *Enable* — and *Save* writes the whole
server map back through `config.set`: name, transport, command or URL, space-separated
arguments and `KEY=VALUE` env lines. Renaming a server replaces its entry, so the old
connection goes with the old key; *Remove* deletes the entry and the tools it contributed.

Nothing is applied optimistically. The panel re-reads `mcp.list` after saving and renders
whatever state the service reached, so a server that fails to start shows `error` with its
message instead of vanishing — and a server that cannot start never fails the save.

Skills stay file-based: they are discovered from disk and listed here. Every row carries a
*Delete* button — press it twice (it arms for four seconds, so a single misclick does
nothing) and `skill.remove` deletes the skill and re-scans. The folder that holds the
`SKILL.md` goes, so the scripts and references next to it go too; the `.md` file alone is
removed only for a skill that sits flat in a root. Nothing outside a scan root is ever
deleted: a record pointing elsewhere, or a name that is already gone, is refused instead of
guessed at.

`npm run smoke` asserts the panel renders in a real Electron window (headings present, no
renderer errors), alongside the markdown/chart check.

## RPC surface

| Method | Params | Result |
| --- | --- | --- |
| `mcp.list` | `{}` | `{ servers: McpServerStatus[] }` — state, identity, exposed tools |
| `mcp.reload` | `{}` | `{ servers: McpServerStatus[] }` — reconnect from the current config |
| `skill.list` | `{ cwd? }` | `{ skills: SkillInfo[] }` |
| `skill.reload` | `{ cwd? }` | `{ skills: SkillInfo[] }` — forgets the cache and rescans |
| `skill.read` | `{ name, cwd? }` | `{ skill: SkillInfo, content }` — the raw playbook |
| `skill.remove` | `{ name, cwd? }` | `{ removed: string, skills: SkillInfo[] }` — deletes the skill folder and rescans |

## Code map

| File | Role |
| --- | --- |
| `src/service/mcp/client.ts` | JSON-RPC client: stdio framing, streamable HTTP, SSE parsing |
| `src/service/mcp/manager.ts` | connection lifecycle, statuses, tool → `ToolDefinition` projection |
| `src/service/skills/store.ts` | root discovery, front-matter parsing, prompt rendering |
| `src/service/tools/skills.ts` | the `skill` tool |
| `src/shared/defaults.ts` | `normalizeMcpServers`, `normalizeSkills`, default config |
| `src/shared/protocol.ts` | config + RPC types |
| `src/shared/bridge.ts` | `RENDERER_METHODS` — the renderer may call the RPC methods above |
| `src/renderer/panels.ts` | `renderIntegrations` — the MCP & skills panel and its server editor |
| `src/renderer/main.ts` | passes the config into the panel and re-reads `mcp.list` after a save |
