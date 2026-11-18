# The Windows driver

`WindowsDriver` is the layer that actually touches the user's desktop: it enumerates
windows, walks the UI Automation tree, moves the pointer, types, presses chords and takes
screenshots. This page is about **how that driver is built and why** — the process model,
the script delivery, the injection surface, the guards in front of a click and the limits it
does not pretend to overcome.

The *permission* side of the same feature (who may drive what, the approvals, the audit
trail) lives in [desktop-permissions.md](desktop-permissions.md). Read that page first if
the question is "should this be allowed"; read this one if the question is "how does it
work".

## Where it sits

```
desktop_* tool  →  DesktopController  →  DesktopDriver  →  WindowsDriver  →  runPowerShell
                   (policy + audit)      (Windows | mock)   (scripts)         (child process)
```

| File | Responsibility |
| --- | --- |
| `src/service/tools/desktop.ts` | The 13 tool definitions the model calls, arg parsing, result shaping |
| `src/service/desktop/controller.ts` | Target resolution, policy decision, audit, driver call |
| `src/service/desktop/windowsDriver.ts` | Every Windows-specific script (windows, UIA, pointer, keys, screenshots, launch) |
| `src/service/desktop/powershell.ts` | The shared P/Invoke prelude and `runPowerShell` |
| `src/service/desktop/mockDriver.ts` | Deterministic driver used off Windows and in tests |
| `src/service/desktop/types.ts` | `DesktopDriver`, `WindowInfo`, `UiNode`, `ElementSelector`, `clampSize` |

The controller picks the implementation once: `options.driver === 'mock' || process.platform
!== 'win32' ? new MockDriver() : new WindowsDriver()`. Nothing above the interface knows
which one is in use, which is what lets the service run on a developer machine that is not
Windows.

## One process per action

There is no resident helper process and no native addon. Each action spawns
`powershell.exe`, hands it a self-contained script, and reads the result back as JSON. The
P/Invoke surface is compiled inside that script with `Add-Type`, so every script carries
exactly the API surface it needs.

The trade-offs are deliberate:

* **Nothing to orphan.** If the service is killed mid-action, Windows reaps the child; there
  is no daemon holding a desktop handle that a restart has to clean up.
* **The script always matches the code.** No compiled helper can go stale against the
  TypeScript that generated it, and there is no separate binary to version, sign or ship.
* **A bad script cannot take the service down.** A crash is a non-zero exit and a stderr
  string, not a segfault in the service.
* **The cost is cold start.** Every action pays a PowerShell launch (and `Add-Type`
  compilation) — hundreds of milliseconds, growing with the prelude. That is acceptable
  because desktop actions are human-paced: an agent that clicks roughly as fast as a person
  is already fast. It would not be acceptable for a per-keystroke API, and the driver is not
  used as one.

## How a script reaches PowerShell

`runPowerShell(script, { timeoutMs, signal })` writes the script to a temp `.ps1` file named
with a `randomUUID`, spawns it, and deletes it in a `finally`:

```js
'powershell.exe',
['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
{ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
```

Every flag earns its place:

| Flag | Why |
| --- | --- |
| `-NoProfile` | A user profile (aliases, `$ErrorActionPreference`, `Set-StrictMode`) must not change driver behaviour |
| `-NonInteractive` | A script that prompts must fail instead of hanging until the timeout |
| `-STA` | UI Automation is COM and needs a single-threaded apartment; without it client calls fail |
| `-ExecutionPolicy Bypass` | The temp script is unsigned and lives in `%TEMP%` |
| `-File` | See below |

**Why a file and not `-EncodedCommand`.** Base64 of UTF-16 inflates a script by ~2.67×, and
Windows caps a process command line at 32767 characters. Once the P/Invoke preludes and the
body are added up, the encoded form exceeds that and `spawn` fails with `ENAMETOOLONG` —
after the *prelude grew*, not before, so this was a real break and not a hypothetical. The
temp file is written with a **UTF-8 BOM**, because Windows PowerShell 5.1 otherwise decodes
it as ANSI and mangles non-ASCII window titles and typed text.

The child runs on **Windows PowerShell 5.1**, not `pwsh`: `UIAutomationClient`,
`System.Windows.Forms` and `System.Drawing` are present there without any module install,
which is the whole point of not requiring a PowerShell 7 setup step.

Output contract:

* The script's last line is JSON; `parseJsonOutput` trims to it and parses.
* A script may `throw` — that becomes a non-zero exit and `PowerShellError(message, stderr)`,
  so the model sees the reason rather than an empty result. Where a failure is *expected to
  be handled* (`desktop_set_value` falling back is one) the script returns
  `{ ok: false, detail }` instead and the tool reports it normally.
* `timeoutMs` defaults to 20s and is raised per call for UIA-heavy work (45s for the
  UI-tree walk, invoke and set-value paths, and 30s for screenshots). The timeout kills the
  child and rejects with a message that says so; the abort signal likewise cancels a
  session.

## Injection: three separate surfaces

User text reaches PowerShell, so each way it can arrive is closed independently.

1. **The script body.** `psLiteral` wraps a value in single quotes and doubles any `'`
   inside it, so the classic `''; Remove-Item …` cannot terminate the literal. Handles are
   not quoted but validated as integers by `handle()` first.
2. **`SendKeys` text.** SendKeys gives `+ ^ % ~ ( ) { } [ ]` special meaning, so
   `escapeSendKeys` escapes them inside `{ }`.
3. **Key chords.** `assertSafeKeyChord` accepts only `^`, `%`, `+` modifiers followed by a
   whitelisted key name, refuses anything over 64 characters or outside printable ASCII, and
   refuses an empty chord. A chord is never passed through `escapeSendKeys` — it *is*
   syntax, and it is validated as such.

Coordinates are rounded and checked with `Number.isFinite` before they are interpolated.

## Identity: why a packaged app is not `ApplicationFrameHost`

Policy is decided per **process image**, so the driver has to report the real application,
not the window's owner. For Win32 apps those are the same thing. For a packaged (UWP) app
they are not: the visible top-level frame belongs to `ApplicationFrameHost.exe`, and the app
lives in a child process behind it. Trusting the frame's owner would collapse every packaged
app into one identity — granting Calculator would grant Settings.

`GetWindowThreadProcessId` on the frame gives the host; when the image is
`ApplicationFrameHost.exe` the driver enumerates the frame's child windows, takes the first
one owned by a different process, and uses **that** process for both the reported executable
and the automation root. The same rule applies in reverse to pointer input: the pixel under
the cursor is resolved to its top-level ancestor with `GetAncestor(GA_ROOT)`, never by
comparing PIDs — see the click guard below.

## The click guard

`desktop_click` is the one action that can hit anything on screen, so it is the one that
verifies the most. Each condition is a separate refusal with its own message, because the
model's next move depends on which one failed:

1. **The handle is still valid** (`IsWindow`) — a stale handle after the app closed must not
   resolve to a reused HWND.
2. **The point is inside the window frame** — an agent that computes a coordinate from a
   screenshot of a window that has since moved would otherwise click whatever now occupies
   that pixel.
3. **The window is brought to the foreground** — `AttachThreadInput` on the foreground
   thread, `BringWindowToTop`, `SetForegroundWindow`, detach — then a 200 ms settle, because
   `SetForegroundWindow` may be refused.
4. **Foreground is verified, not assumed.** If `GetForegroundWindow()` is not the target,
   the click is refused rather than delivered to another application.
5. **A minimized or hidden window is refused** rather than clicked through: a minimized
   frame can still report as foreground while the pixel belongs to whatever is on top.
6. **The virtual desktop is checked.** A window on another virtual desktop is not visible
   even though `IsWindowVisible` says it is, so the driver asks the shell
   (`IsWindowOnCurrentVirtualDesktop`) and refuses.
7. **The pixel owner is verified.** `WindowFromPoint` → `GetAncestor(GA_ROOT)` must be the
   target window; a covered window fails here instead of receiving a click meant for it.

Only then are the `SendInput` events posted. `SendInput` (not `PostMessage`) is used because
a posted click leaves the system's input state untouched and is ignored by applications that
check it; the real input queue also means the click is subject to the same rules as a human
click. Screenshot pixels and window rectangles are in screen space, which is the space
`SendInput` uses.

The same foreground guard sits in front of `desktop_type` and `desktop_hotkey`, which
activate the window first: typing into whatever happens to have focus is exactly the failure
this whole feature is supposed to avoid.

## Controls: UI Automation, not pixel hunting

`desktop_ui_tree` walks the window's automation tree and returns `UiNode`s:

| Field | Notes |
| --- | --- |
| `index` | Position in *this* snapshot — the handle for later element-targeted actions |
| `name`, `controlType`, `automationId` | Stable-ish attributes for selection |
| `enabled`, `patterns` | `patterns` lists the automation patterns the element supports |
| `value` | Current `ValuePattern`/text value where one exists |
| `bounds` | Screen rectangle, for coordinate clicks when no pattern fits |

The walk is bounded — `uiTree(handle, maxDepth, maxNodes)` clamps both to at least 1 and
stops as soon as `maxNodes` is reached — because a large app can produce tens of thousands
of nodes and a flat list of them is useless to a model with a context window.

Element-targeted actions take an `ElementSelector` (`index`, `name`, `automationId`,
`controlType`, in order of preference) and resolve it to a node by re-walking the tree in
the same script that then acts, so selection and action cannot drift apart. The resolution
is a snapshot: an `index` is only meaningful for the tree it came from, and a UI that
rebuilds itself invalidates it.

Preferring patterns over coordinates is why `desktop_invoke` and `desktop_set_value` exist
at all: `InvokePattern` and `ValuePattern` act on a control without needing it to be
visible, focused or unobstructed, and without a pointer position that could be wrong. Where
no pattern exists, the driver falls back to the element's `bounds`.

## Screenshots

`desktop_screenshot` renders the window frame (or the virtual screen when no handle is
given) with `System.Drawing.Bitmap` + `CopyFromScreen`, encodes PNG and returns it to the
model as an image. The tool layer clamps the dimensions with `clampSize` before the image is
attached, so a 4K window does not become a 4K payload. A frame with no visible area is refused rather
than captured as a zero-size bitmap.

Screenshots are also how the multi-modal path degrades: a model that rejects images gets
the screenshot dropped with an explanatory note instead of a failed session (see
[architecture.md](architecture.md)).

## Launching

`desktop_launch` starts a process with `Start-Process -PassThru`, keeps the PID, and returns
the resolved executable path alongside it — the path the policy matches against, so what is
reported is what was started rather than what was typed.

## Failure modes

Messages are part of the design: they tell the model whether to retry, re-list windows or
give up.

| Situation | What comes back |
| --- | --- |
| Handle no longer an open window | `window handle is no longer valid` |
| Coordinate outside the frame | `point x,y is outside the window frame` |
| Another app took the foreground | `the window is not foreground, refusing to click another application` |
| Window minimized/hidden | `the window is minimized or hidden, refusing to click whatever is on screen instead` |
| Window on another virtual desktop | refused with the virtual-desktop reason |
| Pixel belongs to a different window | refused — the frame is covered |
| Script threw | `PowerShellError` carrying the script's message and stderr |
| Script ran too long | `PowerShell timed out after <n>ms`, child killed |
| Bad key chord | `Unsupported key chord: "…"` |
| Driver used off Windows | `assertPlatform` throws instead of silently no-op-ing |

## Limits it does not paper over

* **Windows only.** Off Windows the controller quietly uses `MockDriver`; the real driver's
  methods assert the platform rather than degrade.
* **Integrity levels.** UIPI blocks input and automation into a higher-integrity process: a
  non-elevated service cannot drive an elevated application's window. UAC prompts and the
  secure desktop are out of reach by design.
* **No DPI-awareness declaration.** The driver never calls `SetProcessDpiAwareness`/
  `SetProcessDpiAwarenessContext`, so coordinates come from the DPI-virtualised view of the
  PowerShell process. Single-scale setups are the supported case; mixed-DPI multi-monitor
  arrangements are unverified, and `bounds`-based clicks are where a mismatch would surface
  first.
* **One interactive session.** A disconnected RDP session or a locked workstation has no
  usable desktop for the driver to act on.
* **No automated coverage of the real driver.** The test suite runs against `MockDriver` and
  the controller's policy logic; `npm run verify:driver` and `npm run smoke` are what touch a
  real desktop. Changing a script is therefore verified by typecheck plus that manual run,
  not by an assertion — a coverage gap to keep in mind before refactoring the scripts.

## Working on it

```
npm run typecheck        # catches script-shape mistakes only in the TS around them
npm run verify:driver    # drives a real desktop and reports what worked
npm run smoke            # Electron end-to-end, includes a desktop round trip
```

When changing a script, the safest increments are: (1) run the new PowerShell by hand, (2)
put it behind the existing `assertPlatform` + handle validation, (3) keep the JSON-out
contract so `parseJsonOutput` and the tool layer need no change, (4) make every new refusal
its own message.
