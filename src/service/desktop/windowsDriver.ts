import type { DesktopDriver, ElementSelector, ScreenshotResult, UiNode, WindowInfo } from './types';
import { clampSize } from './types';
import { assertSafeKeyChord, escapeSendKeys, parseJsonOutput, PowerShellError, runPowerShell } from './powershell';

/** PowerShell single-quoted string literal with doubling, so user text can never break out. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Screen-space pointer input, for controls that expose no InvokePattern.
 *
 * Uses `SendInput` rather than the superseded `mouse_event`, and each step is a separate call:
 * XAML hit-tests on the move, so a move followed immediately by down/up is discarded. The
 * coordinates are absolute in the virtual-desktop space, which is the same space
 * `GetWindowRect` and UI Automation report node bounds in.
 */
const MOUSE_PRELUDE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BeeMouse {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static bool Inside(IntPtr h, int x, int y) {
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    return x >= r.Left && y >= r.Top && x < r.Right && y < r.Bottom;
  }
  public static int[] Cursor() {
    POINT p;
    if (!GetCursorPos(out p)) return new int[] { -1, -1 };
    return new int[] { p.X, p.Y };
  }
  static bool Send(uint flags, int x, int y) {
    INPUT[] input = new INPUT[1];
    input[0].type = 0;
    // Absolute coordinates are mapped through the VIRTUAL desktop, matching both the 0xC001
    // flag (MOVE|ABSOLUTE|VIRTUALDESK) and the space GetWindowRect reports in. Normalising
    // with the primary-screen metrics instead would land the click on the wrong monitor
    // whenever the window sits left of or above the primary origin.
    int ox = GetSystemMetrics(76);
    int oy = GetSystemMetrics(77);
    int cx = GetSystemMetrics(78);
    int cy = GetSystemMetrics(79);
    input[0].mi.dx = (int)Math.Round((x - ox) * 65535.0 / Math.Max(1, cx - 1));
    input[0].mi.dy = (int)Math.Round((y - oy) * 65535.0 / Math.Max(1, cy - 1));
    input[0].mi.dwFlags = flags;
    return SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) == 1;
  }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public static bool Visible(IntPtr hWnd) {
    return IsWindowVisible(hWnd) && !IsIconic(hWnd);
  }
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  /** True when the pixel belongs to the target window itself or to one of its children. */
  public static bool Belongs(IntPtr hWnd, int x, int y) {
    POINT point;
    point.X = x; point.Y = y;
    IntPtr hit = WindowFromPoint(point);
    if (hit == IntPtr.Zero) { return false; }
    // Identity is the top-level ancestor, never the process id: a packaged (UWP) app runs
    // inside ApplicationFrameHost, so the frame belongs to the HOST process while the
    // control under the cursor belongs to the app. Comparing PIDs would therefore refuse
    // every UWP target forever, however visible and however permitted it is.
    return GetAncestor(hit, 2) == GetAncestor(hWnd, 2);
  }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  /** Raises the window to the top of the z-order without moving, resizing or activating it. */
  public static bool Raise(IntPtr hWnd) {
    return SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
  }
  public static bool Move(int x, int y) {
    return Send(0xC001, x, y);
  }
  public static bool Down() {
    return Send(0x0002, 0, 0);
  }
  public static bool Up() {
    return Send(0x0004, 0, 0);
  }
}
'@
`;

/** Outer-frame resize without activation, so the window keeps its z-order and focus. */
/**
 * Virtual-desktop membership of a window handle. Separate Add-Type because it needs COM
 * interop, and kept opt-in so drivers that never click do not pay for the compile.
 */
const DESK_PRELUDE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A")]
class VirtualDesktopManager { }
[ComImport, Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopManager {
  [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out int onCurrentDesktop);
  [PreserveSig] int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
  [PreserveSig] int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
}
public static class BeeDesk {
  public static bool OnCurrentDesktop(IntPtr hWnd) {
    try {
      var mgr = (IVirtualDesktopManager)new VirtualDesktopManager();
      int on;
      if (mgr.IsWindowOnCurrentVirtualDesktop(hWnd, out on) != 0) return true;
      return on != 0;
    } catch {
      // Unknown (pre-Win10, COM unavailable): do not block here. The hit-test that
      // follows is the authoritative guard, so an undetected desktop is still safe.
      return true;
    }
  }
}
'@
`;

const RESIZE_PRELUDE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BeeWindowBox {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static bool Resize(IntPtr h, int w, int hh) {
    return SetWindowPos(h, IntPtr.Zero, 0, 0, w, hh, 0x0002 | 0x0004 | 0x0010);
  }
  public static int[] Size(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return new int[] { 0, 0 };
    return new int[] { r.Right - r.Left, r.Bottom - r.Top };
  }
}
'@
`;

const isWindows = process.platform === 'win32';

interface RawWindow {
  handle: string;
  title: string;
  processId: number;
  exe?: string;
  isForeground?: boolean;
}

/**
 * Resolves the automation root for a window and the *real* app process behind it.
 *
 * A hosted (UWP) window belongs to ApplicationFrameHost.exe: the visible frame is the
 * top-level HWND, while the app process and the automation tree sit behind a child window.
 * Everything below handles that transparently so policy matching sees the real executable.
 */
const PS_WINDOW_HELPERS = `
function Resolve-AppPid([IntPtr]$h) {
  $procId = [BeeNative]::PidOf($h)
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'ApplicationFrameHost') {
    $childPid = [BeeNative]::ChildPid($h)
    if ($childPid -ne 0) { return [int]$childPid }
  }
  return [int]$procId
}

function Exe-OfPid([int]$procId) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p) { return ([string]$p.ProcessName) + '.exe' }
  return ''
}

function New-WindowRecord([IntPtr]$h, [int64]$fg) {
  $procId = Resolve-AppPid $h
  return [pscustomobject]@{
    handle = [string]$h.ToInt64()
    title = [BeeNative]::Title($h)
    processId = [int]$procId
    exe = (Exe-OfPid $procId)
    isForeground = ($h.ToInt64() -eq $fg)
  }
}

function Get-AutomationRoot([IntPtr]$h, [int]$realPid) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $count = 1
  try { $count = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition).Count } catch { }
  if ($count -gt 1) { return $root }

  # Hosted apps (UWP): the frame exposes nothing, so hop to the child window that hosts
  # the real app process, then to the process-scoped automation element of that process.
  $child = [BeeNative]::ChildHandle($h)
  if ($child -ne [IntPtr]::Zero) {
    try {
      $alt = [System.Windows.Automation.AutomationElement]::FromHandle($child)
      if ($alt -ne $null -and $alt.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition).Count -gt 1) {
        return $alt
      }
    } catch { }
  }
  if ($realPid -ne 0) {
    try {
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $realPid)
      $byPid = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if ($byPid -ne $null) { return $byPid }
    } catch { }
  }
  return $root
}
`;

/**
 * Windows desktop driver: window enumeration and activation through User32 P/Invoke,
 * in-app interaction through UI Automation, and input through SendKeys. Every operation
 * is a short-lived PowerShell process — no resident helpers, no native modules, and each
 * call is individually abortable and timeout-bounded.
 */
export class WindowsDriver implements DesktopDriver {
  readonly name = 'windows';

  private assertPlatform(): void {
    if (!isWindows) throw new PowerShellError('The Windows driver is only available on win32', '');
  }

  async listWindows(): Promise<WindowInfo[]> {
    this.assertPlatform();
    const raw = await runPowerShell(`
${PS_WINDOW_HELPERS}
$fg = [BeeNative]::GetForegroundWindow().ToInt64()
$items = New-Object System.Collections.ArrayList
$collector = [BeeNative+BeeEnumProc]{
  param($h, $l)
  if (-not [BeeNative]::IsWindowVisible($h)) { return $true }
  $title = [BeeNative]::Title($h)
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  [void]$items.Add((New-WindowRecord $h $fg))
  return $true
}
[void][BeeNative]::EnumWindows($collector, [IntPtr]::Zero)
ConvertTo-Json -InputObject @($items) -Compress -Depth 4
`);
    return this.toWindows(parseJsonOutput<RawWindow[] | RawWindow>(raw));
  }

  async foregroundWindow(): Promise<WindowInfo | undefined> {
    this.assertPlatform();
    const raw = await runPowerShell(`
${PS_WINDOW_HELPERS}
$fg = [BeeNative]::GetForegroundWindow()
if ($fg -eq [IntPtr]::Zero) { ConvertTo-Json -InputObject @() -Compress; exit }
ConvertTo-Json -InputObject @((New-WindowRecord $fg $fg.ToInt64())) -Compress
`);
    return this.toWindows(parseJsonOutput<RawWindow[]>(raw))[0];
  }

  async resolveWindow(handle: string): Promise<WindowInfo | undefined> {
    this.assertPlatform();
    const h = this.handle(handle);
    const raw = await runPowerShell(`
${PS_WINDOW_HELPERS}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { ConvertTo-Json -InputObject @() -Compress; exit }
ConvertTo-Json -InputObject @((New-WindowRecord $h ([BeeNative]::GetForegroundWindow().ToInt64()))) -Compress
`);
    return this.toWindows(parseJsonOutput<RawWindow[]>(raw))[0];
  }

  async activate(handle: string): Promise<void> {
    this.assertPlatform();
    const h = this.handle(handle);
    const raw = await runPowerShell(`
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle is no longer valid' }
$ok = [BeeNative]::ForceForeground($h)
Start-Sleep -Milliseconds 200
if (-not $ok) { $ok = ([BeeNative]::GetForegroundWindow().ToInt64() -eq $h.ToInt64()) }
ConvertTo-Json -InputObject @{ ok = $ok } -Compress
`);
    const res = parseJsonOutput<{ ok: boolean }>(raw);
    if (!res.ok) throw new PowerShellError('could not bring the window to the foreground (Windows focus lock)', '');
  }

  async close(handle: string): Promise<void> {
    this.assertPlatform();
    const h = this.handle(handle);
    await runPowerShell(`
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle is no longer valid' }
[BeeNative]::Close($h)
`);
  }

  async click(handle: string, x: number, y: number): Promise<{ x: number; y: number }> {
    this.assertPlatform();
    const h = this.handle(handle);
    const px = Math.round(x);
    const py = Math.round(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('click coordinates must be numbers');
    // Raw input rather than UIA: the whole point of this path is controls that expose no
    // InvokePattern. Whichever window is under the cursor receives the click, so before the
    // button goes down the point must be inside the target frame, the frame must be foreground,
    // the frame must be on the current virtual desktop, and WindowFromPoint must resolve the
    // pixel to the permitted window itself.
    const raw = await runPowerShell(`
${MOUSE_PRELUDE}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle is no longer valid' }
$x = ${px}
$y = ${py}
if (-not [BeeMouse]::Inside($h, $x, $y)) { throw "point $x,$y is outside the window frame" }
[void][BeeNative]::ForceForeground($h)
Start-Sleep -Milliseconds 200
if ([BeeMouse]::GetForegroundWindow().ToInt64() -ne $h.ToInt64()) { throw 'the window is not foreground, refusing to click another application' }
# Foreground alone is not enough: a minimized or covered frame still reports as foreground
# while the pixel underneath belongs to whatever is actually on top of it. WindowFromPoint
# is the same hit-test the click itself will go through, so if that ancestor is not the
# target the click is refused instead of being posted into an unrelated application.
if (-not [BeeMouse]::Visible($h)) {
  [void][BeeMouse]::ShowWindow($h, 9)
  Start-Sleep -Milliseconds 250
  [void][BeeNative]::ForceForeground($h)
  Start-Sleep -Milliseconds 200
}
${DESK_PRELUDE}
# On another virtual desktop the window is unreachable by synthetic input: SendInput goes
# to the desktop the user is looking at, so WindowFromPoint answers with whoever owns that
# pixel HERE and the hit-test below would blame an innocent application. Refuse instead —
# the error names the real problem instead of the pixel owner.
if (-not [BeeDesk]::OnCurrentDesktop($h)) {
  throw 'the window is on another virtual desktop, refusing to click: synthetic input only reaches the desktop the user is on. Switch to that desktop, or drive the control with an invoke action'
}
if (-not [BeeMouse]::Visible($h)) { throw "the window is minimized or hidden, refusing to click whatever is on screen instead" }
if (-not [BeeMouse]::Belongs($h, $x, $y)) {
  # Covered by another window: raise it and retry once before refusing. This is a
  # permitted application the caller explicitly asked to click, so bringing it to the top
  # is within the grant — clicking blindly into the window underneath is not.
  [void][BeeMouse]::Raise($h)
  Start-Sleep -Milliseconds 250
  [void][BeeNative]::ForceForeground($h)
  Start-Sleep -Milliseconds 200
  if (-not [BeeMouse]::Belongs($h, $x, $y)) { throw "the pixel $x,$y belongs to another application, refusing to click" }
}
if (-not [BeeMouse]::Move($x, $y)) { throw 'could not move the cursor' }
$cursor = [BeeMouse]::Cursor()
if ($cursor[0] -ne $x -or $cursor[1] -ne $y) { throw "cursor ended at $($cursor[0]),$($cursor[1]) instead of $x,$y" }
# Hover first: XAML apps hit-test on WM_MOUSEMOVE, so a down/up in the same tick as the
# move is swallowed. Pauses are what a human click has and a naive synthetic one lacks.
Start-Sleep -Milliseconds 150
[BeeMouse]::Down()
Start-Sleep -Milliseconds 80
[BeeMouse]::Up()
Start-Sleep -Milliseconds 150
ConvertTo-Json -InputObject @{ x = $x; y = $y } -Compress
`);
    return parseJsonOutput<{ x: number; y: number }>(raw);
  }

  async resize(handle: string, width: number, height: number): Promise<{ width: number; height: number }> {
    this.assertPlatform();
    const h = this.handle(handle);
    const size = clampSize(width, height);
    const raw = await runPowerShell(`
${RESIZE_PRELUDE}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle is no longer valid' }
if (-not [BeeWindowBox]::Resize($h, ${size.width}, ${size.height})) { throw 'SetWindowPos failed' }
Start-Sleep -Milliseconds 300
$size = [BeeWindowBox]::Size($h)
ConvertTo-Json -InputObject @{ width = $size[0]; height = $size[1] } -Compress
`);
    return parseJsonOutput<{ width: number; height: number }>(raw);
  }

  async uiTree(handle: string, maxDepth: number, maxNodes: number): Promise<UiNode[]> {
    this.assertPlatform();
    const h = this.handle(handle);
    const depth = Math.max(1, Math.floor(maxDepth));
    const nodes = Math.max(1, Math.floor(maxNodes));
    const raw = await runPowerShell(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${PS_WINDOW_HELPERS}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle is no longer valid' }
$root = Get-AutomationRoot $h (Resolve-AppPid $h)
if ($root -eq $null) { throw 'no automation element for this window' }
$out = New-Object System.Collections.ArrayList
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$script:count = 0
function Walk([System.Windows.Automation.AutomationElement]$node, [int]$depth) {
  if ($node -eq $null -or $depth -gt ${depth} -or $script:count -ge ${nodes}) { return }
  try {
    $cur = $node.Current
    $rect = $cur.BoundingRectangle
    $patterns = @()
    if ($cur.IsInvokePatternAvailable) { $patterns += 'invoke' }
    if ($cur.IsTogglePatternAvailable) { $patterns += 'toggle' }
    if ($cur.IsValuePatternAvailable) { $patterns += 'value' }
    if ($cur.IsSelectionItemPatternAvailable) { $patterns += 'select' }
    if ($cur.IsExpandCollapsePatternAvailable) { $patterns += 'expand' }
    $val = $null
    if ($cur.IsValuePatternAvailable) {
      try { $val = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
    }
    $ctype = ''
    try { $ctype = ([string]$cur.ControlType.ProgrammaticName).Replace('ControlType.', '') } catch { }
    [void]$out.Add([pscustomobject]@{
      index = $script:count
      name = [string]$cur.Name
      controlType = $ctype
      automationId = [string]$cur.AutomationId
      enabled = [bool]$cur.IsEnabled
      patterns = $patterns
      value = $val
      bounds = @{
        x = [int]$rect.X; y = [int]$rect.Y
        width = [int]$rect.Width; height = [int]$rect.Height
      }
    })
    $script:count = $script:count + 1
  } catch { }
  $child = $walker.GetFirstChild($node)
  while ($child -ne $null) {
    Walk $child ($depth + 1)
    if ($script:count -ge ${nodes}) { return }
    $child = $walker.GetNextSibling($child)
  }
}
Walk $root 0
ConvertTo-Json -InputObject @($out) -Compress -Depth 5
`, { timeoutMs: 45_000 });
    return parseJsonOutput<UiNode[]>(raw);
  }

  async invoke(handle: string, selector: ElementSelector): Promise<{ ok: boolean; detail: string }> {
    this.assertPlatform();
    const h = this.handle(handle);
    const raw = await runPowerShell(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${PS_WINDOW_HELPERS}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle is no longer valid' }
$root = Get-AutomationRoot $h (Resolve-AppPid $h)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
${this.selectorScript(selector)}
if ($target -eq $null) { ConvertTo-Json -InputObject @{ ok = $false; detail = 'no element matched the selector' } -Compress; exit }
$done = ''
foreach ($attempt in @('invoke','toggle','select','expand','legacy')) {
  try {
    switch ($attempt) {
      'invoke' { $p = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); $done = 'invoke' }
      'toggle' { $p = $target.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $p.Toggle(); $done = 'toggle' }
      'select' { $p = $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $p.Select(); $done = 'select' }
      'expand' { $p = $target.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); $p.Expand(); $done = 'expand' }
      'legacy' { $p = $target.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern); $p.DoDefaultAction(); $done = 'legacy-default-action' }
    }
    if ($done -ne '') { break }
  } catch { }
}
$detail = 'element exposes no invokable pattern'
if ($done -ne '') { $detail = 'invoked via ' + $done }
ConvertTo-Json -InputObject @{ ok = ($done -ne ''); detail = $detail } -Compress
`, { timeoutMs: 45_000 });
    return parseJsonOutput<{ ok: boolean; detail: string }>(raw);
  }

  async setValue(handle: string, selector: ElementSelector, value: string): Promise<{ ok: boolean; detail: string }> {
    this.assertPlatform();
    const h = this.handle(handle);
    const raw = await runPowerShell(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${PS_WINDOW_HELPERS}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle is no longer valid' }
$root = Get-AutomationRoot $h (Resolve-AppPid $h)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
${this.selectorScript(selector)}
if ($target -eq $null) { ConvertTo-Json -InputObject @{ ok = $false; detail = 'no element matched the selector' } -Compress; exit }
try {
  $p = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $p.SetValue(${psLiteral(value)})
  ConvertTo-Json -InputObject @{ ok = $true; detail = 'value set through ValuePattern' } -Compress
} catch {
  ConvertTo-Json -InputObject @{ ok = $false; detail = ('ValuePattern failed: ' + $_.Exception.Message) } -Compress
}
`, { timeoutMs: 45_000 });
    return parseJsonOutput<{ ok: boolean; detail: string }>(raw);
  }

  async typeText(handle: string, text: string): Promise<void> {
    await this.activate(handle);
    const escaped = escapeSendKeys(text);
    await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(escaped)})
`);
  }

  async sendKeys(handle: string, keys: string): Promise<void> {
    assertSafeKeyChord(keys);
    await this.activate(handle);
    await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(keys)})
`);
  }

  async screenshot(handle?: string): Promise<ScreenshotResult> {
    this.assertPlatform();
    const h = handle ? this.handle(handle) : '0';
    const raw = await runPowerShell(`
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$h = [IntPtr][int64]${h}
$x = 0; $y = 0; $w = 0; $hh = 0
if ($h -ne [IntPtr]::Zero -and [BeeNative]::IsWindow($h)) {
  $rect = New-Object BeeNative+RECT
  [void][BeeNative]::GetWindowRect($h, [ref]$rect)
  $x = $rect.Left; $y = $rect.Top
  $w = $rect.Right - $rect.Left; $hh = $rect.Bottom - $rect.Top
} else {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $vs.X; $y = $vs.Y; $w = $vs.Width; $hh = $vs.Height
}
if ($w -le 0 -or $hh -le 0) { throw 'window has no visible area to capture' }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
ConvertTo-Json -InputObject @{
  png = [Convert]::ToBase64String($ms.ToArray())
  width = $w
  height = $hh
} -Compress
`, { timeoutMs: 30_000 });
    return parseJsonOutput<ScreenshotResult>(raw);
  }

  async launch(exePath: string, args: string[], cwd?: string): Promise<{ processId?: number; detail: string }> {
    this.assertPlatform();
    const argList = args.length ? `-ArgumentList @(${args.map(psLiteral).join(', ')})` : '';
    const workDir = cwd ? `-WorkingDirectory ${psLiteral(cwd)}` : '';
    const raw = await runPowerShell(`
$p = Start-Process -FilePath ${psLiteral(exePath)} ${argList} ${workDir} -PassThru
Start-Sleep -Milliseconds 250
ConvertTo-Json -InputObject @{ processId = [int]$p.Id; detail = ('started ' + ${psLiteral(exePath)}) } -Compress
`);
    return parseJsonOutput<{ processId?: number; detail: string }>(raw);
  }

  /* ------------------------------------------------------------------ helpers */

  private handle(handle: string): string {
    if (!/^\d+$/.test(String(handle))) throw new PowerShellError(`invalid window handle: ${handle}`, '');
    return handle;
  }

  private toWindows(raw: RawWindow[] | RawWindow | undefined | null): WindowInfo[] {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list
      .filter((w) => w && w.handle)
      .map((w) => ({
        handle: String(w.handle),
        title: w.title ?? '',
        processId: Number(w.processId ?? 0),
        exe: w.exe || undefined,
        isForeground: Boolean(w.isForeground),
      }));
  }

  /** PowerShell snippet that sets `$target` from the flattened descendant list. */
  private selectorScript(selector: ElementSelector): string {
    const autoId = selector.automationId ? psLiteral(selector.automationId) : "''";
    const name = selector.name ? psLiteral(selector.name) : "''";
    const type = selector.controlType ? psLiteral(selector.controlType) : "''";
    const index = Number.isInteger(selector.index) ? Number(selector.index) : -1;
    return `$autoId = ${autoId}
$wantName = ${name}
$wantType = ${type}
$wantIndex = ${index}
$target = $null
if ($wantIndex -ge 0 -and $wantIndex -lt $all.Count) { $target = $all.Item($wantIndex) }
if ($target -eq $null -and ($autoId -ne '' -or $wantName -ne '' -or $wantType -ne '')) {
  for ($j = 0; $j -lt $all.Count; $j++) {
    $cur = $all.Item($j).Current
    if ($autoId -ne '' -and $cur.AutomationId -ne $autoId) { continue }
    if ($wantName -ne '' -and $cur.Name -ne $wantName) { continue }
    if ($wantType -ne '') {
      $ctypeSel = ([string]$cur.ControlType.ProgrammaticName).Replace('ControlType.', '')
      if ($ctypeSel -ne $wantType) { continue }
    }
    $target = $all.Item($j)
    break
  }
}`;
  }
}
