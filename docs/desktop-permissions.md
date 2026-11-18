# Desktop permissions

beeCode can drive a real desktop, so the permission model is the product feature — not a
setting buried in a menu. **Deny by default** is the only mode.

## Where the policy lives

`~/.beecode/policy.json`, editable in the app's **Permissions** panel (changes are written
straight through to the running service — the same `PolicyEngine` instance enforces them
immediately). `~/.beecode/policy.json` is created from `defaultPolicy()` on first run.

## Shape

```jsonc
{
  "version": 1,
  "defaultDecision": "deny",
  "allowedApps": [
    {
      "id": "notepad",                       // how tools address the app
      "name": "Notepad",                     // shown in the UI and the system prompt
      "exe": ["notepad.exe"],                // process image names, case-insensitive
      "windowTitlePattern": "Notepad",       // optional extra guard (regex)
      "actions": ["launch", "focus", "read", "invoke", "type", "key", "screenshot", "close"],
      "allowedPaths": ["C:\\Windows"],       // optional: only launch from these roots
      "autoApprove": true                    // skip the approval prompt (still audited)
    }
  ],
  "deniedExe": ["cmd.exe", "powershell.exe", "regedit.exe"],
  "shell": {
    "enabled": true,
    "allowedCommands": ["git status", "dir", "node --version"],
    "blocked": ["rm -rf", "format ", "shutdown"]
  },
  "filesystem": { "workspaceOnly": true, "allowedRoots": [], "writable": true }
}
```

## Actions

| Action | Tool | What it does |
| --- | --- | --- |
| `launch` | `desktop_launch` | start the executable (absolute path, must match the rule) |
| `focus` | `desktop_focus` | restore and foreground the window |
| `read` | `desktop_ui_tree` | walk the UI Automation tree |
| `invoke` | `desktop_invoke`, `desktop_set_value` | click / set value on a control |
| `type` | `desktop_type` | send text to the focused control |
| `key` | `desktop_hotkey` | send a SendKeys chord (`^s`, `%{F4}`) |
| `screenshot` | `desktop_screenshot` | capture the window (or the screen) as PNG |
| `close` | `desktop_close` | post `WM_CLOSE` |

Anything not listed for that app is denied, e.g. the default `explorer.exe` rule is
read-only: it can be focused and screenshotted but never typed into or clicked.

## Evaluation order

`PolicyEngine.evaluateDesktop(action, { appId, exe, title })`:

1. no allowed apps → **deny**
2. `exe` on `deniedExe` → **deny** (this beats any app rule)
3. no matching rule (by id, then exe, then window-title pattern) → **deny**
4. `exe` does not belong to the matched rule → **deny**
5. window title does not match `windowTitlePattern` → **deny**
6. action missing from `actions` → **deny**
7. otherwise **allow**, with `requiresApproval = rule.autoApprove !== true`

The denial text is returned to the model verbatim, e.g.
`action "type" is not permitted for "explorer" (allowed: launch, focus, read, screenshot)`.
The system prompt tells the model not to route around a denial and to use `ask_user`.

## Double checks

The policy is consulted twice on purpose:

* **Before** the action — the tool's `preview()` runs the same rules to decide whether to
  show an approval card and to write its summary.
* **At execution** — `DesktopController` re-evaluates against the *live* process image and
  window title, which `preview()` cannot know. A model that guesses an `app` id still
  cannot reach a process whose image does not match.

## Launch resolution

`desktop_launch` resolves the executable from `allowedPaths` (if set), `PATH`,
`%SystemRoot%`, `System32`, both `Program Files` roots and `WindowsApps`, then requires:

* an absolute path,
* a basename matching the app rule's `exe` list,
* the path to be inside `allowedPaths` when that is configured,
* the basename not being on `deniedExe`.

`Start-Process` is invoked with a quoted argument list — no shell interpolation.

## Hosted (UWP) app identity

Packaged apps (Calculator, Settings, Photos) do not own their window: the visible frame
belongs to `ApplicationFrameHost.exe` while the real app runs in a child process. Trusting
the frame's owner would make one rule for a packaged app apply to every other packaged app
— Settings included — so identity is resolved through the frame:

1. `GetWindowThreadProcessId` on the top-level frame gives the frame host.
2. When that process is `ApplicationFrameHost.exe`, the driver enumerates the frame's
   child windows and takes the first whose process differs from the host: the hosted app.
3. The reported executable and the UI Automation root come from that child, falling back
   to the frame only when no child resolves.

`deniedExe` and per-application rules therefore match `CalculatorApp.exe`, not
`ApplicationFrameHost.exe`, and `evaluateDesktop` rejects any process whose image does not
match the rule it was found through. If identity cannot be resolved the window keeps the
frame host's image name, which no application rule matches, so the action is denied rather
than silently widened.

## Synthetic input

Clicks are posted with `SendInput` as three separate events — move, button down, button up —
with a short pause between them. XAML apps (Calculator, Settings, Store apps) discard a
click that arrives in the same input tick as the pointer move, so the driver never
coalesces the three.

Delivery is not the same as effect. A locked session, an RDP session without input
redirection, or a session attached to another window station accepts the events and drops
them silently — no error comes back. A click therefore counts as *delivered* only when the
cursor actually arrives at the requested pixel and the target was already foreground, and
those checks prove the input was posted, not that the app reacted. The agent is told to
confirm the effect (re-read the UI Automation tree, or take a screenshot) rather than
assume success.

That is why `desktop_invoke` and `desktop_set_value` are preferred over coordinate clicks
wherever the target exposes a UI Automation pattern: they act on the control rather than on
screen pixels, so they keep working when synthetic pointer input is being discarded.
Coordinate clicks remain for the gaps — custom-drawn surfaces, canvas apps, anything with
no UIA pattern to invoke.

## Click guard

A coordinate click is only posted when the pixel provably belongs to the permitted window.
Four checks run first, and every one of them fails closed:

1. **Inside the frame.** The point must lie within the target `GetWindowRect`; a point
   outside it is a driver bug rather than a user request.
2. **Foreground.** After `ForceForeground`, `GetForegroundWindow` must be the target. If a
   background process cannot take the foreground (Windows focus lock), the click is refused
   instead of being posted into whatever application is active.
3. **Same top-level window.** `WindowFromPoint` answers with the window that owns the pixel,
   and its top-level ancestor (`GetAncestor(…, GA_ROOT)`) must be the target’s. Identity is
   the window tree, never the process id: a packaged app’s frame belongs to
   `ApplicationFrameHost.exe` while the control under the cursor belongs to the app itself,
   so a PID comparison would refuse every UWP target forever. If the pixel belongs to a
   window above the target, the driver raises the target once (`SWP_NOACTIVATE`, no move or
   resize) and retries; if it still belongs elsewhere, the click is refused.
4. **Current virtual desktop.** `IVirtualDesktopManager::IsWindowOnCurrentVirtualDesktop`
   must be true. `SendInput` goes to the desktop the user is looking at, so a window on
   another virtual desktop would have its click delivered to whatever occupies that pixel
   here — the driver never switches desktops on the user’s behalf.

A refusal surfaces as an ordinary `{ "error": … }` tool result whose message names the real
reason, so the agent learns that the window is outside its frame, behind another window,
minimised, hidden or on another desktop — instead of believing a click landed.

Scripts reach PowerShell as a temporary `.ps1` file (`-File`, UTF-8 with a BOM) rather than
through `-EncodedCommand`: the P/Invoke preludes plus the body exceed the 32767-character
`CreateProcess` command line once base64 inflates the UTF-16 text, and such a spawn fails
with `ENAMETOOLONG`.
## Window resize

`desktop_resize` moves and resizes an existing top-level window with `SetWindowPos`. It
never launches anything, so the window must be present in the enumerated list first, and
the request is clamped to 200x120 at the small end and 6000x4000 at the large end.
The result reports the size that was asked for *and* the frame that was applied: DPI
scaling and per-app minimum sizes mean the two differ, so callers read the returned frame
instead of assuming the request took effect verbatim. Resizing requires the `resize`
action to be allowed for that app, exactly like `click` and `invoke`.

## Shell

`shell_run` requires an allow-listed prefix **and** is checked against blocked substrings
(`git status && rm -rf /` fails on the blocked substring) and is always confirmed outside
`autonomous` mode. The working directory must itself pass the filesystem policy.

## Filesystem

`workspaceOnly: true` confines read/write to the session workspace
(`agent.workingDir`) plus `allowedRoots`. `writable: false` blocks all writes. Paths are
resolved before comparison, so `..` escapes are rejected.

## Audit trail

Every decision — allowed, denied, approved, denied-by-user, failed — is appended to
`~/.beecode/audit.jsonl`:

```json
{"id":"m1x2-8f3a","at":"2025-11-18T08:31:02.114Z","tool":"desktop_type",
 "action":"type","app":"notepad","target":"Untitled - Notepad [132456]",
 "outcome":"allowed","detail":"type permitted for \"notepad\"","sessionId":"s_..."}
```

It rotates at 2 MB to `audit.jsonl.1` and is surfaced live in the **Activity** panel.

## Secret storage

LLM API keys live in `~/.beecode/secrets.json` -- a plain JSON object keyed by model-preset
id, created with mode `0600` and never placed in `config.json`:

```json
{ "env-llm": "sk-..." }
```

`config.json` is shareable user state, so a preset only ever *names* the environment variable
that holds its key (`apiKeyEnv`); the value is resolved from `secrets.json`, then that
variable, then `.env.llm`. `config.get` reports `hasKey` and never the secret itself.

The mode is passed to the `open` that *creates* the file, not applied by a `chmod`
afterwards, so a new secrets file is never briefly world-readable. A umask cannot weaken it:
the mask only clears group/other bits, and `0600` has none. Files written before this change
keep whatever mode they had until the next save, which tightens them.

Plaintext is a deliberate trade-off -- no OS keychain or DPAPI wrapper. On POSIX `0600` is
real. On Windows `chmod` only toggles the read-only attribute, and `fs.stat` reports a
synthetic `666` for any writable file, so the control that actually applies is the inherited
profile ACL on the home directory. On a default install that grants the owning user,
`Administrators` and `SYSTEM` -- and no `Users`/`Everyone` entry -- which can be checked with
`(Get-Acl "$env:USERPROFILE\.beecode\secrets.json").AccessToString`. A plaintext key is
only as safe as the account and the machine.

The store is pruned when a preset is removed, but nothing expires a key: **if a key is ever
pasted into the wrong field or shared, rotating it is the only revocation.**

## Recommendations

* Keep `deniedExe` broad. Browsers and terminals are the highest-risk apps: anything they
  can reach is effectively reachable by the agent (they can download and run code).
* Prefer `read` + `screenshot` rules for apps you only want the agent to observe.
* Leave `autoApprove` **off** for anything that can spend money, send messages or change
  data. It is a convenience for scratchpads, not for line-of-business apps.
* Review the audit log after any `autonomous` session.
