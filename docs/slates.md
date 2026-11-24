# Slates

> **Status: phase 1 implemented; the caps and the promote action of phase 2 are in.**
> The store (/src/service/slates.ts), the `create_slate` / `update_slate` / `promote_slate`
> tools, the transcript card, the SLATE_TAB gallery and the Slates panel are in the tree, and
> so are the three caps (*Size and retention caps*) and the promote form in both panes. What
> is still proposal-only is called out per section below. The file references name where the
> change landed.

A **slate** is a self-contained document the agent generates inside a conversation and
beeCode renders **in the app** — in its own tab, next to the chat, instead of as a wall of
fenced Markdown in the transcript. The transcript keeps a small card that points at the
current version; the document itself lives in a tab you can re-read, version and keep.

The feature is deliberately narrow: a slate is *one document with a rendered view*, not a
notebook, not a bundler, not a live-coding surface. Everything about it is a workspace
file, so it can be read, diffed and deleted with the tools that already exist.

```mermaid
flowchart LR
  llm["model"] -->|create_slate / update_slate| store["<cwd>/.beecode/slates/&lt;session&gt;/&lt;slug&gt;/"]
  store -->|slate.update event| renderer["renderer"]
  renderer --> tab["slate tab (rendered)"]
  renderer --> card["transcript card"]
  store -->|fs.read| explorer["workspace explorer"]
```

## Lexicon

One noun, used at every level — that is why this name was chosen.

| Level | Name |
| --- | --- |
| Collection, tab, RPC namespace, folder | **Slates** — `SLATE_TAB`, `slate.*`, `.beecode/slates/` |
| One generated document | **slate** — a count noun: "open the slate", "3 slates", "delete this slate" |
| Types | `Slate`, `SlateSummary` |
| Tools | `create_slate`, `update_slate` |
| Event | `slate.update` |
| Tool group | `'slate'` |
| Module names | `src/service/slates/store.ts`, `src/service/tools/slates.ts`, `src/renderer/slateGallery.ts` |

Naming constraints this satisfies, taken from what the repo already does: RPC keys are
`noun.verb` with a single lowercase namespace (`plugin.list`, `skill.read`,
`knowledge.remove`), tool names are `verb_noun`, and the module for the viewer is
`slateGallery.ts` rather than `slate.ts` so it does not read as the feature noun itself:
individual slate documents reuse `mountFileView`, only the gallery is new code.

**Residual naming risk:** Slate.js is a well-known rich-text editor framework. Never add
`slate.editor` / `slate.rich`, and open every tool description with the plain gloss:

> Slate — a self-contained document generated in this session and rendered in-app
> (`markdown`, `html`). Not a rich-text editor.

## Non-goals

| Not in scope | Why |
| --- | --- |
| A dev server, bundler or npm dependencies per slate | Slates are single files with no build step |
| React/JSX slates | Needs a bundler; unless it ships as a self-contained bundle, it stays out (see Tier C) |
| A second storage layer | Everything reads back through `fs.read` |
| Artifacts outside the workspace | App-data storage makes them invisible to the user and to `git` |
| Multi-file slates | One slate, one file, one purpose |

## Storage and versioning

```
<cwd>/.beecode/slates/<sessionId>/<slug>/
  meta.json        { id, title, kind, current: 3, versions: [...], createdAt, updatedAt,
                     recipe? }
  001-<slug>.md
  002-<slug>.md
  003-<slug>.md
```

`recipe` is optional: it records the tool calls that produced a version, which is what
makes a snapshot refreshable while the document itself never holds a connection
(see *Data sources*).

* Every write appends an **immutable** file; `meta.current` is the pointer. `update_slate`
  never overwrites, so "make the bars green" costs one small file, not a second copy of a
  400-line document in the transcript.
* `slug()` and the `rm`-on-remove behaviour follow `src/service/skills/store.ts`, whose
  project root is likewise `<cwd>/.beecode/skills`.
* The path guard rejects `..` and absolute paths before any write — a slate id from the
  model is untrusted input.
* **Dropped from v1 — `.git/info/exclude` seeding.** An earlier draft appended `.beecode/`
  to the workspace's `.git/info/exclude` so generated files never reached `git status`.
  Dropped deliberately: writing inside `.git/` mutates version-control internals the user
  never approved, it surprises in worktrees and submodules, and it stops being necessary once
  *promote* exists. v1 leaves `git status` alone and documents `.beecode/slates/` as
  ignorable; if this returns it is an explicit settings action, never a side effect of
  `create_slate`.
* `.beecode/` is already skipped by recursive `fs.search`, so slates never pollute search
  results — no change needed there.
* **Promote to project** writes the current version into the real tree, for when the user
  actually wants to keep the document. The slate folder stays the source of truth until
  then.

### Identity — id, slug, and an immutable kind

* **`id` is the slug.** The folder name *is* the identifier
  (`<cwd>/.beecode/slates/<sessionId>/<slug>/`), derived from the title with the same
  `slug()` shape the skills store already uses (`src/service/skills/store.ts:224`). A
  collision inside the session appends `-2`, `-3`. No second, opaque id exists that could
  drift away from the folder.
* **The id is immutable.** Renaming a slate changes `meta.title` only; the folder does not
  move, because every `DocTab` and every tool result already refers to the path.
* **`update_slate` accepts a strict id shape** — `^[a-z0-9][a-z0-9-]*$` — no dots, no
  extension, no separators, no absolute path, and the resolved folder must stay under
  `<cwd>/.beecode/slates/<sessionId>/` (*Policy interaction* holds the guard).
* **`kind` is fixed at creation.** The version file's extension is derived from it
  (`NNN-<slug>.md|.html|.csv`) and `viewerKind()` dispatches per file, so a folder holding
  mixed extensions would render differently version to version and break pinning.
  `update_slate` therefore takes no `kind` argument; changing kind means a new slate.
* **v1 kinds are `markdown`, `html`, `csv`.** Markdown carries `chart` code fences
  (`src/renderer/chart.ts`); CSV renders in `csv.ts`. `svg` and `log` are phase 2 at the
  earliest. Mermaid is out — there is no renderer for it in `src/`.

### Size and retention caps

Refusals, never silent truncation: an over-limit write returns `{ error: ... }` like any
other tool failure, because a silently truncated document is worse than a rejected edit.
The numbers are one constant — `SLATE_LIMITS` in `src/shared/protocol.ts` — enforced in
`src/service/slates.ts` (`assertSize`, `update`, `create`), so the renderer can never show
a limit the store does not refuse on. `slate.remove { version }` drops one version file and
is the escape hatch the table names; the panel and the gallery still remove whole slates,
because deleting one version of a document someone is reading belongs beside the version
picker rather than behind a click that looks like the other one.

| Limit | Value | On breach |
| --- | --- | --- |
| One version | 2 MiB | `create_slate` / `update_slate` refuse |
| Versions per slate | 50 | refuse; `slate.remove { version }` drops one and unblocks |
| Slates per session | 100 | `create_slate` refuses |

The per-version cap follows the existing skills precedent, which skips oversized files
against `maxBytes` (`src/service/skills/store.ts:19`, `:149`). `slate.list` reports each
slate's byte size and version count, so the gallery can show pressure before a refusal.
Nothing is pruned automatically: a version a user pinned or promoted must not vanish
because a later edit crossed a threshold.

### Policy interaction — one exemption, one hard guard

This was blocking: the store writes with node `fs` directly, while `filesystem.writable`,
knowledge-folder protection and the workspace roots all live in `policy.evaluateFile`
(`src/service/policy.ts:249`). That function describes **user documents**. A slate is not
one. The decision:

| Rule | Rationale |
| --- | --- |
| Store reads and writes **skip** `evaluateFile` | The store only ever touches `<resolve(cwd)>/.beecode/slates/`, a directory it created itself. `filesystem.writable === false` means "do not modify my files"; it must not be read as "an agent may not draft a document on its own scratch pad" |
| The confinement guard **is** the control | `resolve()` the target and require it to stay inside the session's slate root; reject `..`, absolute ids and any id containing a separator; `realpath()` the root once per call so a symlinked slate folder cannot redirect writes outside the workspace. Immutable `NNN-<slug>` naming plus `meta.json` as the only mutable file makes collision with user data structurally impossible |
| `promote_slate` is **not** exempt | It writes into the real workspace tree, so it calls `evaluateFile(target, true, ctx.workspaceRoots)` and surfaces the result, including knowledge-folder denial and `requiresApproval` |
| `slate` **is** in `WORKSPACE_GROUPS` (`src/service/tools/registry.ts:10`) | Unrelated to writes: that set is the *no-cwd refusal* (`registry.ts:112`). A slate cannot exist without a working directory to put it in |
| No `slates.enabled` policy flag in v1 | A flag added before the feature exists is speculative config. The gallery tab, the tools and the delete action are the user's control surface |

Consequence to state in review: with file writes disabled, `create_slate` still works and
`promote_slate` fails with the policy reason. The asymmetry is intended and is covered by a
test (see *Testing*).

## Security model — the decision that matters

Agent-authored HTML must **never** be mounted into the renderer. The renderer is the
privileged, sandboxed-but-trusted UI process; injecting model output into it is an XSS
straight into the app. Rendering is therefore split into three tiers.

| Tier | Content | Host | Status |
| --- | --- | --- | --- |
| **A** | `markdown`, `html` | Existing renderer viewers — `src/renderer/preview.ts` (`sanitizeHtml`, `htmlPreviewMarkup`) and the Markdown renderer | v1 |
| **B** | HTML that genuinely needs scripts, self-contained JS | A dedicated `WebContentsView` with `sandbox: true`, `contextIsolation: true`, **no preload**, its own `persist:slates` session, and a strict CSP (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`) | phase 2 |
| **C** | React / anything with a build step | — | out of scope |

Tier B reuses the browser-dock / `pluginHost` host pattern rather than inventing a second
one. "Rendered in-app" never means "with app privileges": the language in the UI (and in
the README) is *documents that render in-app, not in a browser tab or a download*.

`preview.ts` states the same principle for the existing preview: `sanitizeHtml` is defence
in depth, not the only guard, because the renderer document runs under a CSP without
`unsafe-inline` scripts. A slate adds no new privilege — it reuses those viewers.

## Protocol

Types and four keys in `src/shared/protocol.ts`, beside the existing `skill.*` /
`knowledge.*` entries (which is where the `{ params, result }` shape comes from):

```ts
// RpcRequests
'slate.list':    { params: { sessionId?: string }; result: { slates: SlateSummary[] } };
'slate.read':    { params: { id: string; version?: number }; result: Slate };
'slate.remove':  { params: { id: string }; result: { slates: SlateSummary[] } };
'slate.promote': { params: { id: string; path: string }; result: { path: string } };

// ServiceEvent
| { type: 'slate.update'; payload: SlateSummary }
```

`slate.update` is the **only** thing that repaints the UI. The renderer does not adopt
state from a mutation it did not make — the same lesson the `workspace.state` event
encodes, which is why the smoke probe must assert the tab renders after a *tool*-driven
create and not only after a renderer-initiated one.

Adding keys is additive; `PROTOCOL_VERSION` only moves on a breaking change.

The method list in `src/shared/bridge.ts` is enumerated by hand, so each new key must be
added there too or the preload proxy will refuse it.

## Tools

New group `'slate'`, registered in `buildToolRegistry()` in `src/service/tools/index.ts`
next to `skillTools(...)`:

```ts
create_slate { title: string; kind: 'markdown' | 'html' | 'csv'; content: string }
update_slate { id: string; content: string; note?: string }   // appends a version; kind is fixed
```

Both are `mutating: true`. `create_slate` returns the new id and version so the model can
follow up with `update_slate` instead of re-emitting the whole document through
`write_file`.

`'slate'` also joins `WORKSPACE_GROUPS` in `src/service/tools/registry.ts`. That set is
what *refuses* a tool when no workspace root is configured (resolving a relative path
against the process directory would silently make the install folder the agent's
workspace) — a store rooted at `<cwd>/.beecode/slates` depends on that guarantee.

`SUBAGENT_TOOL_ALLOWLIST` in `src/service/tools/index.ts` is an explicit **read-only**
list; `create_slate` / `update_slate` must not be added to it. Subagents get slates only
if a later decision explicitly opts them in.

### Approval behaviour — one card per slate, none for edits

Approval is decided by the tool's own `preview` / `mutating` flag, **not** by the policy
engine: `AgentLoop` sets `requiresApproval: tool.mutating` by default
(`src/service/session/AgentLoop.ts:335`) and raises the card at `:346`; plan mode refuses any
`mutating` tool before a prompt is shown (`:311`); `autoApproveTools` and autonomous mode
bypass the card.

| Tool | `mutating` | `preview().requiresApproval` | Result |
| --- | --- | --- | --- |
| `create_slate` | `true` | `true`, summary `Create slate "Sales Q3" (markdown)` | one card; *allow for session* silences later creates |
| `update_slate` | `true` | **`false`**, reason `appends v(N+1) to an app-owned slate; no user file is touched` | no card — otherwise every "make the bars green" prompts, which makes the feature unusable in chat |
| `promote_slate` | `true` | inherits the policy decision | card, because it writes a real file |

`mutating: true` stays on both write tools even though `update_slate` is pre-approved: plan
mode's read-only guarantee is expressed through `mutating`, so dropping it would let a
plan-mode session generate slates. Approval and mutability are separate axes and this doc
must not conflate them.

### Settings → Tools registration — three places, one free switch

`'slate'` joins a **closed union**, so it costs three registrations — and one of them
fails silently if forgotten:

| Place | Why |
| --- | --- |
| `ToolDefinition.group` union, `src/shared/tools.ts:37` | compile-time: the tool group does not typecheck without it |
| `TOOL_GROUP_ORDER`, `src/renderer/panels.ts:70` | the catalogue iterates this array, so a group missing here **never renders** — even when its tools exist and a label is defined |
| `TOOL_GROUP_LABELS: Record<ToolInfo['group'], string>`, `src/renderer/panels.ts:84` | exhaustive record: typecheck fails until a label is supplied |

**Per-tool switching needs no slate code.** `config.tools.disabled` is a list of tool
*names* (`src/service/service.ts:226`, applied through `registry.setDisabled` at `:843`),
and the Settings copy already states the contract — a switched-off tool is not offered to
the model and refuses to run if it is called anyway. Both slate tools therefore appear as
individual switches for free; no user has to opt in or out of the feature as a whole.

**No group-level kill switch in v1.** A slate is an additive tool call, not a surface that
keeps running — unlike the browser dock, it needs no "enabled" flag.

### Subagent visibility and session scoping

**Subagents get no slate access in v1** — neither write nor read. `SUBAGENT_TOOL_ALLOWLIST`
(`src/service/tools/index.ts:52`) is a deliberate read-only list and the slate tools stay
out of it. If a subagent needs document content, the parent inlines it in the prompt, which
is what already happens with any other file.

That follows from storage being session-scoped: the gallery lists the caller's
`<sessionId>`, and a subagent run has its own session, so a subagent-authored slate would
land in a folder no UI ever browses — an invisible orphan on disk.

Should subagent slates be enabled later, the rule is: the subagent writes into the
**parent's** session folder, passed explicitly, never its own; and `slate.list` still
returns only the caller's session. Cross-session listing is not v1 and should not be added
as a convenience — that is what would turn the gallery into a global file browser.

## Data sources

A slate is **author-time connected and render-time inert**. That is a contract, not an
omission: the agent fetches the data with its own tools and writes the result in as a
version; the document never reaches for a source itself.

### Render time — no connection, by construction

| Surface | Constraint |
| --- | --- |
| `markdown` / `html` (Tier A) | `src/renderer/index.html:7` sets `connect-src 'none'` with `script-src 'self'`, and `sanitizeHtml` strips scripts — there is neither code to call an API nor an origin allowed to |
| `svg` / image | loaded as an `<img>` through `fileAssetUrl`, workspace-confined and inert |
| sandboxed `WebContentsView` (Tier B, phase 2) | the only surface where live JS could run; whether it reaches the network is its CSP, i.e. a per-slate decision rather than a default |

So "a slate that queries the database when you open it" is Tier B **plus** a consent and
audit model. It is not v1, and nothing in Tier A can be talked into it.

### Authoring time — what the agent can actually reach

| Source | Route | Status |
| --- | --- | --- |
| CSV / TSV / JSON / logs / Markdown | `fs_read` → `create_slate`; `.csv`/`.tsv` render through the existing `csv` viewer, aggregates via a `chart` code fence | ✅ works, no new code |
| **Spreadsheets (.xlsx)** | ⚠️ gap — `fs_read` is UTF-8 text only (`src/service/tools/files.ts:97`), so a workbook comes back as mojibake. `src/service/preview/office.ts` *can* parse one, but it is wired only into the attachment preview (`service.ts` `readOfficePreview`), not exposed as a tool | needs `shell_run`, an MCP server, or a small plugin |
| Databases | no native driver in `src/`. Via **MCP** — `protocol.ts:513`, external servers whose tools are exposed to the agent — so a Postgres/SQLite/MSSQL server hands the agent query tools; or `shell_run` with `psql`/`sqlcmd`/`sqlite3` where the shell policy allows it | ✅ works, configuration-dependent |
| Apps over HTTP | there is **no generic `http_fetch`** tool. Routes: `shell_run` (curl / `Invoke-WebRequest`), an MCP server for that app, or the `browser_*` tools when only a UI exists | ✅ works, indirect |
| Desktop apps | `desktop_*` (UI Automation) reads a native app's UI tree and values | ✅ works |
| Plugins as connectors | ❌ `PLUGIN_PERMISSIONS` (`src/plugins/types.ts:21`) is `files:read`, `files:write`, `pdf:view`, `pdf:render` — no network or database permission exists, and user plugins load in-process (`src/plugins/host.ts:373` — `createRequire` + `require`; no `vm`, no worker, no `utilityProcess`), so that list bounds the API surface rather than a sandbox | do not build a datasource layer here |

### Snapshots, not dashboards

Slates are **versioned snapshots**. `update_slate` appending v4 *is* the refresh — good for
auditability and diffing, and it means a dashboard is stale the moment it is created. The
ways to live with that, cheapest first:

| Pattern | Cost | Phase |
| --- | --- | --- |
| Someone asks again ("update the sales slate") → v4 | free, human in the loop by default | 1 |
| `meta.json` stores the **recipe** and `refresh_slate` replays it | small, still explicit | 1.5 — recommended |
| `schedule` (`src/service/tools/scheduler.ts:63`) starts a fresh session with a prompt on a timer → one new version per run | prompt-shaped authoring; no dependency on the slate layer | 2 |
| The document subscribes to the source itself | Tier B + `connect-src` allowlist + per-slate consent + audit trail | 3 |

The **recipe field is the important one**: it turns "data source support" from a renderer
capability into a stored, replayable provenance record, so a snapshot can be refreshed
without the document ever holding credentials or a connection.

### Getting data back out

Both directions already exist as builtin plugins and need no slate work:
`pdf_generate` (`src/plugins/builtin/pdfGenerator.ts:28`) accepts `markdown` **or** `html`
content, and `excel_export` (`tableExport.ts:112`) accepts a `csv` string or a `.csv`/`.tsv`
path and writes a real `.xlsx` (bundled OOXML writer, no dependencies). A slug with a
*Download as PDF / XLSX* action therefore needs only the plugin call already registered.

### If a live slate is ever built (Tier B)

1. **Exfiltration** — agent-authored JS with a network path can POST workspace content
   anywhere. Mitigation: a per-slate origin allowlist stored in `meta.json` and shown at
   approval time; never `connect-src *`.
2. **Credentials** — a slate that talks to a database needs a token, and it must never be
   baked into a version file. Route it through the service, never through the document.
3. **MCP trust boundary** — an MCP server's tools become agent-invocable in general, so
   adding one to reach a database widens what the agent can do everywhere, not just in slates.

## Renderer

| Piece | Change |
| --- | --- |
| `docTabs.ts` | `SLATE_TAB` singleton constant beside `BROWSER_TAB`, plus one branch in `activateTab`/`activeDoc` handling. Individual slate docs need no new type: `DocTab` is path-keyed (`docId(path)`), so a slate is just another path |
| `mainArea.ts` | gallery pane for `SLATE_TAB` (`renderStrip` already special-cases the two singletons) and the `slate.update` subscription |
| `panels.ts` | Slates section with a version picker |
| `slateGallery.ts` | new — the gallery pane: list, version picker, promote/download. Individual slate docs need no renderer: a version file keeps its real extension (`002-<slug>.csv`), so `mountFileView` + `viewerKind()` open it |
| `fileView.ts` | **no change** — `viewerKind()` (`:89`) maps the version file by extension, so `markdown`/`html`/`csv`/`log`/`image` slates all resolve, and the Code ⇄ Preview toggle is the existing `view: 'source'` option gated by `hasSourceView()` (`:96`). See *Resolved during review* |
| transcript | one compact card per slate — `Slate · sales-summary.md · v3 · Open` — so the chat stays readable |

### Version and tab coherence

The tab is path-keyed, so a v4 write does not retarget an open v3 tab by itself — the gallery
would show `v4` while the pane still renders v3. The rule:

* A slate tab carries `slateId` **and** `path`. `docId(path)` stays the identity, so no new
  `DocTab` shape is needed — only one extra field.
* Default mode is **follow**: on `slate.update`, a tab for that `slateId` that is not pinned
  has its `path` rewritten to the new version path and the pane re-mounts; the strip label
  becomes `v4`.
* Choosing a version in the gallery sets `pinnedVersion` and stops following; the label
  becomes `v2 (pinned)` and a *Follow current* action restores follow mode.
* Ordering: version file fully written → `meta.json` committed via temp-file + rename →
  **then** emit `slate.update`. A tab therefore never renders a partially written version,
  and there is no in-place content mutation to tear.
* `slate.remove` closes the slate's tabs (any version) and its gallery tile, then emits
  `slate.update`. A tab pointing at a removed version is closed rather than shown empty.

## Change list

| # | File | Change | Phase |
| --- | --- | --- | --- |
| 1 | `src/shared/protocol.ts` | `Slate` / `SlateSummary`; 4 `slate.*` keys in `RpcRequests`; `slate.update` in the `ServiceEvent` union | 1 |
| 2 | `src/shared/bridge.ts` | add the 4 method names to the proxy allowlist | 1 |
| 3 | `src/service/slates/store.ts` | **new** — meta read/write, append version, `slug()`, **caps** (*Size and retention caps*), **confinement guard** (`resolve()` the target, `realpath()` the root, reject `..`, absolute and separator-bearing ids), remove. **No** `.git/info/exclude` seeding (see *Policy interaction*) | 1 |
| 4 | `src/service/tools/slates.ts` | **new** — `create_slate`, `update_slate`, group `'slate'`, `mutating: true`, plus an explicit `preview()` implementing the approval matrix (see *Approval behaviour*) | 1 |
| 5 | `src/service/tools/index.ts` | register the group beside `skills` / `browser`; `SUBAGENT_TOOL_ALLOWLIST` stays read-only and untouched | 1 |
| 6 | `src/shared/tools.ts`, `src/service/tools/registry.ts` | add `'slate'` to the closed `ToolDefinition.group` union (`:37`) **and** to `WORKSPACE_GROUPS` (the no-cwd refusal) | 1 |
| 7 | `src/service/service.ts` | the 4 `slate.*` handlers; emit `slate.update` only **after** the version file and `meta.json` are committed | 1 |
| 8 | broadcast path | **verify, no code change expected**: `service.emit` → `transports/stdio.ts` / `http.ts` → `main/serviceSupervisor.ts` → `main/ipc.ts:112` (`pipeServiceEvents`) → `shared/bridge.ts:138` (`onEvent`) → renderer `handleEvent`. If `pipeServiceEvents` switches on `type`, `slate.update` must be added there; if it forwards generically, nothing to do — confirm before writing the renderer | 1 |
| 9 | `src/renderer/docTabs.ts` | `SLATE_TAB` singleton beside `BROWSER_TAB`, one branch in `activateTab`/`activeDoc`; a slate tab carries `slateId` + `pinnedVersion` beside `path` | 1 |
| 10 | `src/renderer/mainArea.ts` | gallery pane for `SLATE_TAB`, a **gallery branch in `docPaneBody()`** (`mainArea.ts:215`, which currently assumes a file-backed tab), the tab button label (`:142`), the `slate.update` subscription and the follow/pin retarget (see *Version and tab coherence*) | 1 |
| 11 | `src/renderer/mainArea.ts` | **signature**: `render(state, view)` takes `{ browserVisible }` (`:46`) — add `slateVisible`, and update `renderStrip` plus the "show one of three" pane toggle (`:53`–`:54`, `:72`) | 1 |
| 12 | `src/renderer/main.ts` | pass the new flag at the `mainArea.render()` call site and handle `slate.update` inside `handleEvent` | 1 |
| 13 | `src/renderer/slateView.ts` | **new** — Tier A only: delegate to `viewerKind()` / `mountFileView`; not named `slate.ts` (collides with the feature noun) | 1 |
| 14 | `src/renderer/panels.ts` | Slates section with a version picker, **plus** a `'slate'` entry in `TOOL_GROUP_ORDER` (`:70`) and `TOOL_GROUP_LABELS` (`:84`) — see *Settings → Tools registration* | 1 |
| 15 | `scripts/smoke.mjs` | end-to-end probe: create → event → list → open, in the shape of the knowledge-folder probe | 1 |
| 16 | tests | `slates/store.test.ts` (versioning, confinement guard, cap refusals), `policy.test.ts` (the exemption and promote rules — see *Testing*), `docTabs.test.ts` (`SLATE_TAB`), `slateView.test.ts` (kind dispatch + approval matrix) | 1 |
| 17 | `src/renderer/slateView.ts` + a host in `src/main/` | Tier B: sandboxed `WebContentsView`, `sandbox: true`, no preload, strict CSP; reuse the `pluginHost` / browser-dock pattern | 2 |
| 18 | `src/renderer/slateView.ts`, `promote_slate` | Code ⇄ Preview toggle, copy, download; `promote_slate` writes through `evaluateFile` and raises an approval card | 2 |
| 19 | pipeline | auto-promote long fenced `html`/`svg` blocks into slates; streamed `slate.delta`; version diff | 3 |

Phase 1 is roughly 450–600 LOC of new code plus wiring, against a repo with no
`slate`/`artifacts` identifiers anywhere today.

## Testing

Follows the repo's tiered convention (`AGENTS.md`): `npm run typecheck` every edit,
`npm test -- slates` while iterating, `npm run check` before hand-off.

* Store unit tests: version append, `current` pointer, path-guard rejections, remove.
* `docTabs.test.ts`: the new singleton cannot be shadowed by a doc path.
* Service test: `create_slate` → `slate.update` event → `slate.list` agrees.
* Smoke: end-to-end in a *populated* workspace. An empty `workspace.root` makes panel
  probes fail for reasons unrelated to this feature.

**Policy tests — added in review** (`src/service/policy.test.ts`, beside the existing file-rule
cases):

* Store writes stay reachable with `filesystem.writable: false`. The exemption is a
  behavioural promise, so it needs a test or it will silently regress into a denial.
* The confinement guard rejects `../x`, `/abs/x`, an id containing a path separator, and a
  slate root that is a symlink pointing outside the workspace.
* `promote_slate` into a knowledge folder is denied with the knowledge reason;
  `promote_slate` inside the workspace returns `requiresApproval: true`.
* Approval matrix: `create_slate.preview().requiresApproval === true`,
  `update_slate.preview().requiresApproval === false`, and both tools keep
  `mutating === true` so plan mode still refuses them.

## Acceptance criteria

Definition of done per phase. Every line is checkable by hand or by the named script.

### Phase 1

* `create_slate` with `kind: 'markdown'` writes `001-<slug>.md` + `meta.json`;
  `update_slate` appends `002-…` and moves `meta.current` to `2`; the v1 file is
  byte-identical afterwards.
* The transcript keeps a one-line card (`Sales Q3 · v2 · Open`), not the document body.
* `SLATE_TAB` lists every slate in the session; opening one renders its current version
  through `viewerKind()` — `.md` via the markdown renderer, `.html` via the sanitized
  `htmlPreviewMarkup` path — with no new renderer code for either.
* A tile pinned at v1 renders v1 and labels the tab `v1 (pinned)`; *Follow current* jumps to
  `v2`.
* With a tab open at v2, a fresh `update_slate` retargets it to v3 with no stale pane, and
  the version file is never observed half-written (write → `meta.json` commit → emit).
* `slate.remove` closes its tabs and its gallery tile.
* **Approval:** exactly one card on `create_slate` in ask mode, none on `update_slate`, none
  in autonomous mode, none in plan mode (where both tools are refused instead).
* **Policy:** with `filesystem.writable: false`, both write tools succeed and `promote_slate`
  is refused with the policy reason; a `../` or absolute slate id is refused by the guard.
* **Plan mode:** a plan-mode session produces no slate files at all.
* `npm run check` green; the `scripts/smoke.mjs` probe passes end-to-end.

### Phase 2

* An html slate containing `<script>fetch('https://example.com')</script>` renders in the
  sandboxed host with the request blocked by CSP (no `connect-src`), no preload and no
  `require`.
* The same slate in the privileged renderer stays inert — the sanitizer strips the script,
  asserted by a unit test rather than by inspection.
* `promote_slate` writes into the workspace only through `evaluateFile` and raises an
  approval card; with writes disabled it fails.

### Phase 3

* A 40-line `html` fenced block in an assistant message becomes a slate and leaves a card
  behind; a 5-line one does not.
* `slate.delta` updates the pane without a full remount, and the diff between two versions
  is readable.

## Corrections recorded during review

Kept here so the next reader does not re-inherit them:

* **Mermaid is not supported anywhere in the codebase** — no renderer, no dependency.
  Earlier drafts listed it as a v1 kind; it is out (or phase 2, vendored into a sandbox).
* `SUBAGENT_TOOL_ALLOWLIST` **does** exist (`src/service/tools/index.ts`) — an earlier
  review claimed it did not.
* `WORKSPACE_GROUPS` is **not** the approval-prompt gate; it is the no-workspace refusal.
  A slate store *must* be in it. Approval/safety is carried by `mutating`.
* The tab layer is **not** untouched: the per-document case is free because `DocTab` is
  path-keyed, but the gallery needs a singleton constant and an `activateTab` branch.
* **Approval is not raised by `evaluateFile`.** It comes from the tool's own
  `preview().requiresApproval`, defaulting to `tool.mutating`
  (`AgentLoop.ts:335`, card at `:346`). An earlier draft treated the policy return value
  as the prompt gate; that conflated two axes (see *Approval behaviour*).
* **`.git/info/exclude` seeding is dropped**, not deferred: writing inside `.git/` is an
  unapproved mutation of VCS internals (see *Storage and versioning*).

## Open decisions

1. **Streaming in v1?** Default: no — show the slate when the tool call completes. Partial
   tool-JSON plumbing buys little for documents this size.
2. **Does a slate get a `recipe`?** Recommended yes (§ *Data sources*): it is what makes a
   snapshot replayable and is the honest answer to "can it stay current". Costs a little
   phase-1 scope.

**Resolved during review** (recorded so they are not reopened):

* *CSV / chart in v1* — yes for CSV, and Markdown with `chart` fences, because
  `viewerKind()` (`fileView.ts:89`) maps the version file by its real extension.
* *Own dispatch vs `viewerKind()`* — reuse `viewerKind()`, so no slate-specific renderer
  exists and Code ⇄ Preview is the existing `view: 'source'` option.
* *id vs slug* — the slug **is** the id; immutable folder, free-form title (*Identity*).
* *kind immutability* — fixed at creation, extension derived from it (*Identity*).
* *Size and retention* — three hard refusals, no automatic pruning
  (*Size and retention caps*). Implemented as `SLATE_LIMITS` (`src/shared/protocol.ts`), with
  `slate.remove { version }` as the single escape hatch.
* *The transcript card* — mechanism (a): the tool result carries `meta.slate`, and the card
  is built from it (`src/renderer/slateRef.ts`), falling back to the plain tool row when the
  payload is malformed.
* *`slate.promote` phase* — phase 1. The **Promote…** form in the panel and the gallery
  needs the RPC, and the RPC answers to `policy.evaluateFile` exactly as the tool does, so
  the UI cannot save a file a read-only workspace refuses.
* *Subagents* — no slate read or write access in v1 (*Subagent visibility*).
* *Settings → Tools* — per-tool switches are free; no group-level flag
  (*Settings → Tools registration*).
* Mermaid stays out of v1: there is no renderer and no dependency for it anywhere in
  `src/`.
