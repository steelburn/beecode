# Plugins

A plugin adds tools to the agent and nothing else. It cannot touch the desktop, the
filesystem or Chromium on its own: every call it makes goes through a permission the
manifest declares, so installing a plugin is a decision the user can actually read.

Three extension points sit beside the built-in tool catalogue:

| | What it adds | Written as | Trust boundary |
| --- | --- | --- | --- |
| **MCP servers** | third-party tools over JSON-RPC | any language, separate process | process + host config |
| **Skills** | instruction playbooks the model loads on demand | `SKILL.md` | prompt only, no code |
| **Plugins** | native tools with file/host access | CommonJS module, no build step | in-process, permission-gated |

A plugin is the right choice when a tool needs to *do* something — read a file, print a
PDF, write a workbook — and the work is small enough not to deserve its own process.

## Starter plugins

Three plugins are bundled with the build (`src/plugins/builtin`) and active by default:

| Plugin | Tool | What it does | Permissions |
| --- | --- | --- | --- |
| `pdf-viewer` | `pdf_open` | Opens a PDF in the internal viewer window (reused per file), optionally at a page. Read-only, never prompts for approval. | `files:read`, `pdf:view` |
| `pdf-generator` | `pdf_generate` | Renders Markdown or an HTML document to a PDF through Chromium `printToPDF`. A3/A4/A5/Letter/Legal/Tabloid, landscape, background printing, margins. | `files:read`, `files:write`, `pdf:render` |
| `table-export` | `excel_export` | Writes rows (arrays or objects) or a CSV/TSV string to a real `.xlsx` — OOXML, frozen bold header, column widths, no dependency. A `.csv` path falls back to delimited text. | `files:write` |

They exist to be read as much as used: each one is ~150 lines and shows the whole
contract (manifest, `activate`, schema, permission use, in-band errors).

## Configuration

`plugins` lives in `~/.beecode/config.json`:

```json
{
  "plugins": {
    "enabled": true,
    "allowExternal": true,
    "dirs": [],
    "disabled": ["pdf-generator"]
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. Off registers no plugin tools at all. |
| `allowExternal` | `true` | Load user plugins from `dirs`. Off keeps only the bundled starters. |
| `dirs` | `[]` | Plugin roots; relative paths resolve against the working directory. Empty means `~/.beecode/plugins` (`BEECODE_HOME` is honoured). |
| `disabled` | `[]` | Plugin ids that are loaded but left inactive. |

The same switches are exposed in the UI: the **Plugins** card in the **MCP & skills** panel lists every plugin
with its source (`builtin` / `user`), permissions, contributed tools and load error, and
toggles it on or off. Toggling writes `disabled` to `config.json`, so the panel and the
file never disagree.

## Writing a plugin

A user plugin is a folder — no build step, no `npm install`:

```
~/.beecode/plugins/md-stats/
├─ plugin.json
└─ plugin.js
```

`plugin.json` is the manifest; `main` names the entry point (default `plugin.js`):

```json
{
  "id": "md-stats",
  "name": "Markdown stats",
  "version": "1.0.0",
  "description": "Counts lines, words and headings in a Markdown file.",
  "author": "you",
  "api": 1,
  "main": "plugin.js",
  "permissions": ["files:read"]
}
```

`plugin.js` is CommonJS and exports `activate(api)`:

```js
module.exports = {
  activate(api) {
    api.registerTool({
      name: 'md_stats',
      description: 'Summarise a Markdown file: lines, words, headings.',
      mutating: false,                    // mutating tools go through the approval gate
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File to inspect.' } },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const text = await api.fs.readText(ctx, String(args.path));
        const lines = text.split(/\r?\n/);
        return { content: `${lines.length} lines` };
      },
    });
  },
};
```

A ready-to-copy version is in `resources/sample-plugin/`:

```powershell
Copy-Item -Recurse resources\sample-plugin "$env:USERPROFILE\.beecode\plugins\md-stats"
```

then hit **Reload** in the Plugins card (or call the `plugin.reload` RPC).

### The `api` object

| Member | Purpose |
| --- | --- |
| `api.manifest` | The normalized, read-only manifest. |
| `api.registerTool(tool)` | Adds a tool. Duplicate names inside one plugin throw; a name already in the core catalogue is dropped with a warning instead of shadowing it. |
| `api.fs.resolve(ctx, path)` | Absolute path, resolved against the session cwd. |
| `api.fs.assertWrite(ctx, path)` | Runs the write policy **without** writing: call it before you create a directory or hand a path to a host method, so a denied path touches nothing. |
| `api.fs.readText` / `readBuffer` | Read a file — needs `files:read`. |
| `api.fs.writeText` / `writeBuffer` | Write a file — needs `files:write`. |
| `api.host.call(method, params)` | Call an Electron host method — each method needs its own permission. |
| `api.log.info` / `warn` / `error` | Messages prefixed with the plugin id. |

`ctx` is the tool context handed to every handler (`cwd`, `mode`, `workspaceRoots`,
`signal`, session ids). Pass it to `api.fs` and `api.host` — never build your own.

### Tool names

`^[a-zA-Z0-9_-]{1,64}$`, and the `mcp__` prefix is reserved. Prefer a distinct prefix
(`md_`, `acme_`) so a plugin never collides with a core tool or a future starter.

### Permissions

| Permission | Gates |
| --- | --- |
| `files:read` | `api.fs.readText` / `readBuffer` |
| `files:write` | `api.fs.writeText` / `writeBuffer` / `assertWrite`, and `api.host.call('pdf/render', …)` |
| `pdf:view` | `api.host.call('pdf/open', …)` |
| `pdf:render` | `api.host.call('pdf/render', …)` — the write also needs `files:write` |

Anything not in this list is dropped at load time, so a typo in `permissions` narrows
access rather than widening it. Calling a gated function without the permission throws —
which the host turns into a failed tool result for the model, not a crash.

File access is not a bypass of the desktop policy: `api.fs` runs the same
`PolicyEngine.evaluateFile` check as the built-in `read_file` / `write_file` tools, so a
workspace-only policy applies to plugins too. Host calls are audited with action
`plugin`; every plugin tool call is audited under its own name.

A host method that writes is not a way around that: `pdf/render` demands `files:write`
on top of `pdf:render`, and `pdf_generate` calls `api.fs.assertWrite` before it creates
the target directory, so a denied path is refused before anything reaches the disk.

### Host methods

| Method | Params | Result |
| --- | --- | --- |
| `pdf/open` | `{ path, page?, title? }` | `{ ok, path, title?, error? }` — shows the PDF in the viewer window. |
| `pdf/render` | `{ path, html, pageSize?, landscape?, background?, marginsMm? }` | `{ ok, path, bytes?, error? }` — writes the PDF; `path` must be absolute. |

## Lifecycle and failure handling

Loading happens once, at service start, before the tool registry is built:

1. **Discover** — bundled definitions first, then each `<dir>/<id>/` that has a
   `plugin.json`.
2. **Validate** — id (lowercased, `^[a-z0-9][a-z0-9-]{1,39}$`, 2-40 kebab-case
   chars), version (`0.0.0` when absent), entry point. The entry point must resolve
   **inside** the plugin directory; the check compares path segments, so a sibling such
   as `md-stats-evil` cannot stand in for `md-stats`. A bad manifest shows up as a
   plugin with an `error` and no tools; it never blocks startup.
3. **Activate** — `activate(api)` runs only for enabled plugins. A throwing `activate`
   is caught and recorded the same way.
4. **Reload** — `plugin.reload` (config change, UI button) deactivates everything —
   `deactivate()` is called if the plugin exported one — and repeats the sequence.

At call time a handler that throws yields
`Plugin "<id>" failed in <tool>: <message>` with `failed: true`. The agent loop keeps
running, so a broken plugin costs one tool call, not the session.

## RPC surface

| Method | Params | Result |
| --- | --- | --- |
| `plugin.list` | — | `{ plugins: PluginInfo[] }` |
| `plugin.setEnabled` | `{ id, enabled }` | `{ plugins: PluginInfo[] }` |
| `plugin.reload` | — | `{ plugins: PluginInfo[] }` |

`PluginInfo` carries `id`, `name`, `version`, `description`, `author`, `source`
(`builtin` / `user`), `path`, `enabled`, `permissions`, `tools` and `error`.
