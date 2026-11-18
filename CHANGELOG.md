# Changelog

All notable changes to beeCode will be documented in this file.

## [0.1.0]

### Added
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

### Changed
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

### Verified
- `tsc --noEmit` clean; the new `markdown.test.ts` and `chart.test.ts` suites pass; the policy
  suite covers the extra-root grant and an out-of-root escape; the service end-to-end suite
  accepts a valid `setCwd` and rejects a missing folder; build plus Electron smoke are green.
