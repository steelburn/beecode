import { basename } from 'node:path';
import type {
  DesktopDriver,
  ElementSelector,
  LaunchResult,
  ScreenshotResult,
  TextReadback,
  TypeResult,
  UiNode,
  UiTreeResult,
  WindowInfo,
} from './types';
import { clampSize, isPlausibleBounds, BOUNDS_LIMIT, MAX_TYPED_CHARS, TEXT_PREFIX_LIMIT } from './types';
import { assertSafeKeyChord, chunkSendKeys, parseJsonOutput, PowerShellError, runPowerShell } from './powershell';

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

/**
 * One window record as the PowerShell layer emits it. Everything downstream derives from
 * this shape, so the identity fields and the state flags are always read from the same
 * enumeration — never re-derived per call.
 */
interface RawWindow {
  handle: string;
  title?: string;
  processId?: number;
  exe?: string;
  className?: string;
  isForeground?: boolean;
  isVisible?: boolean;
  isMinimized?: boolean;
  /** Raw DWMWA_CLOAKED value: 0 visible on this desktop, 1 suspended app, 2 other desktop. */
  cloaked?: number;
  offscreen?: boolean;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
}

/** One record plus the raw shape used by the launch handoff probe. */
interface RawLaunch {
  spawner?: number;
  spawnerAlive?: boolean;
  /** The window belongs to a process the launcher activated (packaged/MSIX app). */
  activated?: boolean;
  /** Several new windows appeared at once: the launch target is ambiguous. */
  ambiguous?: string[];
  created?: RawWindow | null;
  existing?: RawWindow | null;
}


/**
 * Window inspection, enumeration and automation-root helpers shared by every observation
 * call.
 *
 * Two rules live here and nowhere else:
 *
 * 1. A window record is produced by **one** enumeration (`Get-WindowRecords`) that carries
 *    identity (`handle`, `processId`, `exe`, `className`, `title`) *and* state (visible,
 *    minimized, cloaked, offscreen). `desktop_list_windows` filtered or not, `focus`,
 *    `launch` and every handle lookup all read from it, so they cannot disagree.
 * 2. A hosted (UWP/packaged) window belongs to ApplicationFrameHost.exe: the visible frame
 *    is the top-level HWND while the app process sits behind it. Resolving that is fine;
 *    substituting a *different window* for the requested handle is not, so
 *    `Get-AutomationRoot` never falls back to "some window of this process".
 */
const PS_WINDOW_HELPERS = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class BeeObserve {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public class Info {
    public string Title = "";
    public string ClassName = "";
    public bool Visible;
    public bool Iconic;
    public bool ToolWindow;
    public bool Candidate;
    public bool Offscreen;
    public int Cloaked;
    public int X, Y, Width, Height;
  }

  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint = "PrintWindow")] static extern bool PrintWindowNative(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

  /** DWMWA_CLOAKED: 1 = suspended app, 2 = on another virtual desktop, 3/4 = inherited. */
  public static int Cloaked(IntPtr h) {
    int v = 0;
    try { if (DwmGetWindowAttribute(h, 14, out v, 4) != 0) return 0; } catch { return 0; }
    return v;
  }

  /**
   * Title via SendMessageTimeout(WM_GETTEXT) with SMTO_ABORTIFHUNG: plain GetWindowText
   * blocks for as long as a neighbouring hung application takes to answer, which would make
   * one frozen app look like a frozen observation layer.
   */
  static string SafeTitle(IntPtr h) {
    IntPtr res;
    try {
      var sb = new StringBuilder(512);
      SendMessageTimeoutW(h, 0x000D, (IntPtr)512, sb, 0x0002, 150, out res);
      if (sb.Length > 0) return sb.ToString();
      var w = new StringBuilder(512);
      GetWindowTextW(h, w, 512);
      return w.ToString();
    } catch { return ""; }
  }

  /** The window's own text (WM_GETTEXT) — the last read-back resort for classic Win32 controls. */
  public static string WindowText(IntPtr h) {
    IntPtr res;
    try {
      var sb = new StringBuilder(65536);
      SendMessageTimeoutW(h, 0x000D, (IntPtr)65536, sb, 0x0002, 250, out res);
      return sb.ToString();
    } catch { return ""; }
  }

  /** PW_RENDERFULLCONTENT: render the window's own composition surface, covered or not. */
  public static bool PrintWindow(IntPtr h, IntPtr hdc) {
    return PrintWindowNative(h, hdc, 2);
  }

  public static bool Restore(IntPtr h) {
    return ShowWindow(h, 9);
  }

  public static Info Describe(IntPtr h) {
    var info = new Info();
    info.Visible = IsWindowVisible(h);
    info.Iconic = IsIconic(h);
    int ex = GetWindowLong(h, -20);
    info.ToolWindow = (ex & 0x80) != 0;
    info.Cloaked = Cloaked(h);
    try {
      var cls = new StringBuilder(256);
      GetClassNameW(h, cls, 256);
      info.ClassName = cls.ToString();
    } catch { }
    RECT r;
    if (GetWindowRect(h, out r)) {
      info.X = r.Left; info.Y = r.Top;
      info.Width = r.Right - r.Left; info.Height = r.Bottom - r.Top;
    }
    int left = GetSystemMetrics(76);
    int top = GetSystemMetrics(77);
    int right = left + GetSystemMetrics(78);
    int bottom = top + GetSystemMetrics(79);
    info.Offscreen = info.Width <= 0 || info.Height <= 0 ||
      r.Right <= left || r.Bottom <= top || r.Left >= right || r.Top >= bottom;
    // A candidate is a window a user could point at. Hidden, non-cloaked frames (Win11
    // Notepad leaves one behind per document it merged) are deliberately NOT listed: they
    // have no pixels and no automation tree, so naming them would invite unobservable work.
    bool worthTitle = !info.ToolWindow && !info.Offscreen && (info.Visible || info.Cloaked != 0);
    info.Title = worthTitle ? SafeTitle(h) : "";
    info.Candidate = worthTitle && info.Title.Length > 0;
    return info;
  }
}
'@

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

function New-WindowRecord([IntPtr]$h, [int64]$fg, $st) {
  if ($st -eq $null) { $st = [BeeObserve]::Describe($h) }
  $procId = Resolve-AppPid $h
  return [pscustomobject]@{
    handle = [string]$h.ToInt64()
    title = [string]$st.Title
    processId = [int]$procId
    exe = (Exe-OfPid $procId)
    className = [string]$st.ClassName
    isForeground = ($h.ToInt64() -eq $fg)
    isVisible = [bool]$st.Visible
    isMinimized = [bool]$st.Iconic
    cloaked = [int]$st.Cloaked
    offscreen = [bool]$st.Offscreen
    bounds = @{ x = [int]$st.X; y = [int]$st.Y; width = [int]$st.Width; height = [int]$st.Height }
  }
}

# The single enumeration behind list_windows, focus, launch and every handle lookup.
function Get-WindowRecords {
  $fg = [BeeNative]::GetForegroundWindow().ToInt64()
  $items = New-Object System.Collections.ArrayList
  $collector = [BeeNative+BeeEnumProc]{
    param($h, $l)
    $st = [BeeObserve]::Describe($h)
    if ($st.Candidate) { [void]$items.Add((New-WindowRecord $h $fg $st)) }
    return $true
  }
  [void][BeeNative]::EnumWindows($collector, [IntPtr]::Zero)
  return $items
}

function Find-WindowRecord([IntPtr]$h) {
  $st = [BeeObserve]::Describe($h)
  return (New-WindowRecord $h ([BeeNative]::GetForegroundWindow().ToInt64()) $st)
}

function Get-AutomationRoot([IntPtr]$h, [int]$realPid) {
  $root = $null
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($h) } catch { }
  if ($root -ne $null) {
    $count = 0
    try { $count = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition).Count } catch { }
    if ($count -gt 0) { return $root }
  }
  # Hosted apps (UWP/packaged): the frame itself exposes nothing, so hop to the child window
  # that hosts the content island. Same window, one level down — never a different one.
  $child = [BeeNative]::ChildHandle($h)
  if ($child -ne [IntPtr]::Zero) {
    $alt = $null
    try { $alt = [System.Windows.Automation.AutomationElement]::FromHandle($child) } catch { }
    if ($alt -ne $null) {
      $n = 0
      try { $n = $alt.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition).Count } catch { }
      if ($n -gt 0) { return $alt }
    }
  }
  throw ('no UI Automation tree for window handle ' + $h.ToInt64() + ': the window is hidden, minimized or has not been laid out yet')
}

# A lazily realised WinUI/XAML tree can answer with the root only for a moment after a
# window appears. Wait for it, but surface the failure instead of pretending the window
# has no controls.
function Wait-AutomationRoot([IntPtr]$h, [int]$realPid, [int]$timeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ($true) {
    try { return (Get-AutomationRoot $h $realPid) } catch {
      if ((Get-Date) -ge $deadline) { throw }
    }
    Start-Sleep -Milliseconds 150
  }
}

# Root at index 0 followed by every descendant, so an index taken from desktop_ui_tree
# (whose node 0 is the window root) selects the same element when it is replayed.
function Get-TreeList($root) {
  $list = New-Object System.Collections.ArrayList
  if ($root -eq $null) { return $list }
  [void]$list.Add($root)
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $found) { [void]$list.Add($e) }
  return $list
}

# Text read-back: TextPattern first (rich editors such as Win11 Notepad's RichEditD2DPT do
# not advertise the IsTextPatternAvailable flag at all, they simply answer the pattern),
# then ValuePattern, then the window's own WM_GETTEXT.
function Normalize-Newlines($text) {
  if ($text -eq $null) { return $text }
  return $text.Replace([string][char]13 + [string][char]10, [string][char]10).Replace([string][char]13, [string][char]10)
}

function Read-Text([IntPtr]$h, $element, [int]$limit) {
  if ($element -ne $null) {
    try {
      $tp = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      $txt = $tp.DocumentRange.GetText($limit + 1)
      if ($txt -ne $null) {
        $cur = $element.Current
        $txt = Normalize-Newlines $txt
      $len = $txt.Length
        $trunc = $len -gt $limit
        if ($trunc) { $txt = $txt.Substring(0, $limit) }
        return @{
          handle = [string]$h.ToInt64()
          controlType = ([string]$cur.ControlType.ProgrammaticName).Replace('ControlType.', '')
          automationId = [string]$cur.AutomationId
          name = [string]$cur.Name
          text = $txt
          length = $len
          truncated = $trunc
          source = 'text-pattern'
        }
      }
    } catch { }
    try {
      $vp = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $val = [string]$vp.Current.Value
      if ($val -ne $null) {
        $cur = $element.Current
        $val = Normalize-Newlines $val
      $len = $val.Length
        $trunc = $len -gt $limit
        if ($trunc) { $val = $val.Substring(0, $limit) }
        return @{
          handle = [string]$h.ToInt64()
          controlType = ([string]$cur.ControlType.ProgrammaticName).Replace('ControlType.', '')
          automationId = [string]$cur.AutomationId
          name = [string]$cur.Name
          text = $val
          length = $len
          truncated = $trunc
          source = 'value'
        }
      }
    } catch { }
  }
  $windowText = [BeeObserve]::WindowText($h)
  if ($windowText.Length -gt 0) {
    $windowText = Normalize-Newlines $windowText
    $len = $windowText.Length
    $trunc = $len -gt $limit
    if ($trunc) { $windowText = $windowText.Substring(0, $limit) }
    return @{
      handle = [string]$h.ToInt64()
      controlType = 'Window'
      automationId = ''
      name = ''
      text = $windowText
      length = $len
      truncated = $trunc
      source = 'wm-gettext'
    }
  }
  return $null
}

function Find-TextElement($root) {
  if ($root -eq $null) { return $null }
  $all = Get-TreeList $root
  $plain = $null
  for ($i = 0; $i -lt $all.Count; $i++) {
    $e = $all.Item($i)
    $ok = $false
    try { [void]$e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); $ok = $true } catch { }
    if (-not $ok) { continue }
    $ctype = ''
    try { $ctype = ([string]$e.Current.ControlType.ProgrammaticName).Replace('ControlType.', '') } catch { }
    if ($ctype -eq 'Document' -or $ctype -eq 'Edit') { return $e }
    if ($plain -eq $null) { $plain = $e }
  }
  return $plain
}
`;

/**
 * Proves the target before a keyboard mutation and refuses when the proof fails.
 *
 * Sending keys is global: `SendKeys` types into whatever owns the keyboard. If the window
 * did not actually come to the foreground the keystrokes land in another application — a
 * data-safety problem, not a failed call — so this throws *before* anything is sent and
 * says so.
 */
function psForegroundGuard(handle: string, action: 'typed' | 'sent'): string {
  return `$h = [IntPtr][int64]${handle}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle ${handle} is no longer valid — nothing was ${action}' }
$st = [BeeObserve]::Describe($h)
if ($st.Cloaked -ne 0) { throw ('window ' + $h.ToInt64() + ' is cloaked (cloaked=' + $st.Cloaked + '): it is on another virtual desktop or belongs to a suspended app, so keyboard input cannot reach it — nothing was ${action}') }
if ($st.Iconic) { [void][BeeObserve]::Restore($h) }
$deadline = (Get-Date).AddMilliseconds(2000)
while ([BeeNative]::GetForegroundWindow().ToInt64() -ne $h.ToInt64()) {
  if ((Get-Date) -ge $deadline) {
    throw ('refusing to send keys: ' + $st.Title + ' [' + $h.ToInt64() + '] did not become the foreground window within 2000ms, so the keystrokes would have gone to another application — nothing was ${action}')
  }
  [void][BeeNative]::ForceForeground($h)
  Start-Sleep -Milliseconds 120
}`;
}

function clampCount(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Defence in depth for geometry that reached JS anyway: a rect that is not a rectangle is
 * dropped and the node marked offscreen, so no caller can click at x: -31994 believing it
 * is a real screen position.
 */
function sanitizeNodes(nodes: UiNode[]): UiNode[] {
  return nodes.map((node) => {
    const bounds = isPlausibleBounds(node.bounds) ? node.bounds : undefined;
    return { ...node, bounds, isOffscreen: Boolean(node.isOffscreen) || !bounds };
  });
}

/**
 * Turns "I sent keys, it returned ok" into "I sent keys, and here is what the target now
 * contains". Newlines land as CRLF in most editors, so `delta` may exceed the number of
 * characters typed; `appended` compares the normalised text instead.
 */
function mutationResult(
  input: string,
  before: TextReadback | undefined,
  after: TextReadback | undefined,
): TypeResult {
  const normalize = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const wanted = normalize(input);
  const observed = after ? normalize(after.text) : '';
  const comparable =
    after && after.truncated && wanted.length > observed.length ? wanted.slice(0, observed.length) : wanted;
  const delta = before && after ? after.length - before.length : undefined;
  const appended = observed.length > 0 && comparable.length > 0 && observed.endsWith(comparable);
  return {
    typed: input.length,
    readback: after,
    lengthBefore: before?.length,
    lengthAfter: after?.length,
    delta,
    appended,
    verified: Boolean(after) && (appended || (delta !== undefined && delta !== 0)),
  };
}


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
    const raw = await runPowerShell(
      `
${PS_WINDOW_HELPERS}
ConvertTo-Json -InputObject @(Get-WindowRecords) -Compress -Depth 5
`,
      { timeoutMs: 30_000 },
    );
    return this.toWindows(parseJsonOutput<RawWindow[]>(raw));
  }

  async foregroundWindow(): Promise<WindowInfo | undefined> {
    this.assertPlatform();
    const raw = await runPowerShell(`
${PS_WINDOW_HELPERS}
$fg = [BeeNative]::GetForegroundWindow()
if ($fg -eq [IntPtr]::Zero) { ConvertTo-Json -InputObject @() -Compress; exit 0 }
ConvertTo-Json -InputObject @((Find-WindowRecord $fg)) -Compress -Depth 5
`);
    return this.toWindows(parseJsonOutput<RawWindow[]>(raw))[0];
  }

  /**
   * Exact lookup by handle — the only way a handle becomes a window again.
   *
   * There is deliberately no title/foreground/pid fallback here: a dead handle has to fail
   * so the caller learns the window is gone. Falling back is how a request for one window
   * silently became a request for another (and how keystrokes reached a document nobody
   * meant to touch).
   */
  async resolveWindow(handle: string): Promise<WindowInfo | undefined> {
    this.assertPlatform();
    const h = this.handle(handle);
    const raw = await runPowerShell(
      `
${PS_WINDOW_HELPERS}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { ConvertTo-Json -InputObject @() -Compress; exit 0 }
ConvertTo-Json -InputObject @((Find-WindowRecord $h)) -Compress -Depth 5
`,
      { timeoutMs: 30_000 },
    );
    const window = this.toWindows(parseJsonOutput<RawWindow[]>(raw))[0];
    // The record must describe the handle that was asked for — anything else is a bug here,
    // not something to hand back to the caller.
    return window && window.handle === h ? window : undefined;
  }

  /**
   * Brings the window to the foreground and returns its identity *after* activation, with
   * `isForeground` verified. A caller that gets a window back owns the keyboard; a caller
   * that gets an error knows it does not.
   */
  async activate(handle: string): Promise<WindowInfo> {
    this.assertPlatform();
    const h = this.handle(handle);
    const raw = await runPowerShell(
      `
${PS_WINDOW_HELPERS}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle ${h} is no longer valid' }
$st = [BeeObserve]::Describe($h)
if ($st.Cloaked -ne 0) { throw ('window ' + $h.ToInt64() + ' is cloaked (cloaked=' + $st.Cloaked + '): it is on another virtual desktop or belongs to a suspended app and cannot be activated from here') }
if ($st.Iconic) { [void][BeeObserve]::Restore($h) }
$deadline = (Get-Date).AddMilliseconds(2500)
while ([BeeNative]::GetForegroundWindow().ToInt64() -ne $h.ToInt64()) {
  if ((Get-Date) -ge $deadline) {
    throw ('the window did not come to the foreground within 2500ms: ' + $st.Title + ' [' + $h.ToInt64() + ']')
  }
  [void][BeeNative]::ForceForeground($h)
  Start-Sleep -Milliseconds 120
}
ConvertTo-Json -InputObject @((Find-WindowRecord $h)) -Compress -Depth 5
`,
      { timeoutMs: 30_000 },
    );
    const window = this.toWindows(parseJsonOutput<RawWindow[]>(raw))[0];
    if (!window || window.handle !== h) {
      throw new PowerShellError(`window handle ${h} changed identity during desktop_focus`, '');
    }
    return window;
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

  /**
   * Deterministic automation-tree read.
   *
   * Three things the old walk got wrong and this one does not: it resolves the tree from
   * *the given handle* (never from a pid or the foreground window), it forces a lazily
   * realised WinUI/XAML tree to materialise before reading it, and it reports a timeout as
   * an error instead of handing back a one-node window that looks like an empty app.
   */
  async uiTree(handle: string, maxDepth: number, maxNodes: number): Promise<UiTreeResult> {
    this.assertPlatform();
    const h = this.handle(handle);
    const depth = clampCount(maxDepth, 1, 24, 4);
    const nodes = clampCount(maxNodes, 1, 4000, 200);
    const budgetMs = clampCount(depth * nodes * 25, 10_000, 60_000, 15_000);
    const raw = await runPowerShell(
      `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${PS_WINDOW_HELPERS}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle ${h} is no longer valid' }
$root = Wait-AutomationRoot $h (Resolve-AppPid $h) 2500
$script:deadline = (Get-Date).AddMilliseconds(${budgetMs})
$script:count = 0
$script:expanded = 0

# A pattern has to be *answered* to count. Providers such as Win11 Notepad's RichEdit leave
# the optional IsXxxPatternAvailable properties null, which is how a Document element with
# a working TextPattern still reported "patterns": [] and "value": null.
function Test-Pattern($node, $advertised, $pattern) {
  if ($advertised -eq $false) { return $false }
  try { [void]$node.GetCurrentPattern($pattern); return $true } catch { return $false }
}

function New-UiNodeJson($node, [int]$index, [int]$d) {
  $cur = $node.Current
  $ctype = ''
  try { $ctype = ([string]$cur.ControlType.ProgrammaticName).Replace('ControlType.', '') } catch { }
  $flags = @{ invoke = $null; toggle = $null; select = $null; expand = $null; range = $null }
  try { $flags.invoke = $cur.IsInvokePatternAvailable } catch { }
  try { $flags.toggle = $cur.IsTogglePatternAvailable } catch { }
  try { $flags.select = $cur.IsSelectionItemPatternAvailable } catch { }
  try { $flags.expand = $cur.IsExpandCollapsePatternAvailable } catch { }
  try { $flags.range = $cur.IsRangeValuePatternAvailable } catch { }
  $patterns = @()
  if (Test-Pattern $node $flags.invoke ([System.Windows.Automation.InvokePattern]::Pattern)) { $patterns += 'invoke' }
  if (Test-Pattern $node $flags.toggle ([System.Windows.Automation.TogglePattern]::Pattern)) { $patterns += 'toggle' }
  if (Test-Pattern $node $flags.select ([System.Windows.Automation.SelectionItemPattern]::Pattern)) { $patterns += 'select' }
  if (Test-Pattern $node $flags.expand ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) { $patterns += 'expand' }
  if (Test-Pattern $node $flags.range ([System.Windows.Automation.RangeValuePattern]::Pattern)) { $patterns += 'range' }

  $text = $null; $tlen = 0; $ttrunc = $false; $val = $null
  try {
    $tp = $node.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($patterns -notcontains 'text') { $patterns += 'text' }
    $probe = $tp.DocumentRange.GetText(${TEXT_PREFIX_LIMIT} + 1)
    if ($probe -ne $null) {
      $tlen = $probe.Length
      if ($tlen -gt ${TEXT_PREFIX_LIMIT}) { $ttrunc = $true; $text = $probe.Substring(0, ${TEXT_PREFIX_LIMIT}) } else { $text = $probe }
    }
  } catch { }
  try {
    $vp = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($patterns -notcontains 'value') { $patterns += 'value' }
    $val = [string]$vp.Current.Value
    if ($text -eq $null -and $val -ne $null) { $text = $val; $tlen = $val.Length }
  } catch { }

  # UIA answers BoundingRectangle with layout sentinels (-2147483648, negative extents) for
  # elements that were never laid out. Reporting those as geometry is what produced
  # x: -31994; here an implausible rect is no rect, and the node is marked offscreen.
  $b = $null
  $off = $true
  try {
    $off = [bool]$cur.IsOffscreen
    $rect = $cur.BoundingRectangle
    if ($rect.Width -gt 0 -and $rect.Height -gt 0 -and [Math]::Abs($rect.X) -le ${BOUNDS_LIMIT} -and [Math]::Abs($rect.Y) -le ${BOUNDS_LIMIT}) {
      $b = @{ x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
    }
  } catch { }
  if ($b -eq $null) { $off = $true }

  return [pscustomobject]@{
    index = $index
    depth = $d
    name = [string]$cur.Name
    controlType = $ctype
    automationId = [string]$cur.AutomationId
    className = [string]$cur.ClassName
    enabled = [bool]$cur.IsEnabled
    isOffscreen = $off
    patterns = @($patterns)
    value = $val
    text = $text
    textLength = $tlen
    textTruncated = $ttrunc
    bounds = $b
  }
}

# Force the tree to materialise. Only containers are expanded: expanding a combo box or a
# menu would open a popup, which is a side effect an observation must not have.
function Expand-Pass($node, [int]$d) {
  if ($node -eq $null -or $d -gt 6 -or $script:expanded -ge 60) { return }
  if ((Get-Date) -gt $script:deadline) { return }
  $children = $null
  try { $children = $node.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return }
  foreach ($child in $children) {
    try {
      $ctype = [string]$child.Current.ControlType.ProgrammaticName
      if ($ctype -eq 'ControlType.Pane' -or $ctype -eq 'ControlType.Group' -or $ctype -eq 'ControlType.TreeItem') {
        $p = $child.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
          $p.Expand()
          $script:expanded++
        }
      }
    } catch { }
    Expand-Pass $child ($d + 1)
  }
}

$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$out = New-Object System.Collections.ArrayList
function Walk($node, [int]$d) {
  if ($node -eq $null -or $d -gt ${depth} -or $script:count -ge ${nodes}) { return }
  if ((Get-Date) -gt $script:deadline) {
    throw ('desktop_ui_tree timed out after ${budgetMs}ms walking window ${h} (depth ' + $d + ', ' + $script:count + ' nodes read). The result was NOT truncated silently: lower maxDepth/maxNodes, or read a subtree via desktop_read_text.')
  }
  $index = $script:count
  $script:count++
  try { [void]$out.Add((New-UiNodeJson $node $index $d)) } catch { }
  $child = $null
  try { $child = $walker.GetFirstChild($node) } catch { }
  while ($child -ne $null) {
    Walk $child ($d + 1)
    if ($script:count -ge ${nodes}) { return }
    if ((Get-Date) -gt $script:deadline) { return }
    try { $child = $walker.GetNextSibling($child) } catch { break }
  }
}

Expand-Pass $root 0
Walk $root 0
if ($script:count -le 1) {
  # A window that is still laying out can answer with the root only. Re-read once after the
  # activation settles; if it is still empty that is the window's real tree, not a race.
  Start-Sleep -Milliseconds 350
  $root = Wait-AutomationRoot $h (Resolve-AppPid $h) 2500
  $out = New-Object System.Collections.ArrayList
  $script:count = 0
  Expand-Pass $root 0
  Walk $root 0
}
ConvertTo-Json -InputObject @{
  window = (Find-WindowRecord $h)
  nodes = @($out)
  truncated = ($script:count -ge ${nodes})
  expanded = $script:expanded
} -Compress -Depth 6
`,
      { timeoutMs: budgetMs + 20_000 },
    );
    const parsed = parseJsonOutput<{
      window?: RawWindow;
      nodes?: UiNode[];
      truncated?: boolean;
      expanded?: number;
    }>(raw);
    const window = this.toWindows(parsed.window)[0];
    if (!window) throw new PowerShellError(`window handle ${h} went away during desktop_ui_tree`, '');
    return {
      window,
      nodes: sanitizeNodes(parsed.nodes ?? []),
      truncated: Boolean(parsed.truncated),
      expanded: Number(parsed.expanded ?? 0),
    };
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
$all = Get-TreeList $root
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
$all = Get-TreeList $root
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

  /**
   * Reads the window's text back, so a mutation can be proven instead of assumed.
   *
   * With no selector it picks the text-bearing control (Document/Edit first, then any
   * element answering TextPattern). The result says which mechanism answered, because that
   * is part of the evidence.
   */
  async readText(handle: string, selector?: ElementSelector): Promise<TextReadback> {
    this.assertPlatform();
    const h = this.handle(handle);
    const pick = selector
      ? `$root = Wait-AutomationRoot $h (Resolve-AppPid $h) 2500
$all = Get-TreeList $root
${this.selectorScript(selector)}
if ($target -eq $null) { throw 'no element matched the selector, so there is nothing to read back' }`
      : `$target = Find-TextElement (Wait-AutomationRoot $h (Resolve-AppPid $h) 2500)`;
    const raw = await runPowerShell(
      `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${PS_WINDOW_HELPERS}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle ${h} is no longer valid' }
${pick}
$read = Read-Text $h $target ${TEXT_PREFIX_LIMIT}
if ($read -eq $null) { throw 'this window exposes no readable text (no TextPattern, no ValuePattern, no WM_GETTEXT): a mutation on it cannot be verified by reading it back' }
ConvertTo-Json -InputObject $read -Compress -Depth 4
`,
      { timeoutMs: 45_000 },
    );
    return parseJsonOutput<TextReadback>(raw);
  }

  /** Read-back for verification: undefined when the window simply has no text to offer. */
  private async tryReadText(handle: string): Promise<TextReadback | undefined> {
    try {
      return await this.readText(handle);
    } catch (err) {
      if (err instanceof PowerShellError && /no UI Automation tree|no readable text/.test(err.message)) {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Types text into the proven-foreground window and reads the result back.
   *
   * The handle is verified alive and foreground inside the same PowerShell call that sends
   * the keys, so a window that died or refused activation yields an error *and zero
   * keystrokes* — never `ok` for input that went somewhere else.
   */
  async typeText(handle: string, text: string): Promise<TypeResult> {
    this.assertPlatform();
    const h = this.handle(handle);
    if (text.length > MAX_TYPED_CHARS) {
      throw new PowerShellError(
        `refusing to type ${text.length} characters (limit ${MAX_TYPED_CHARS}) — use desktop_set_value for bulk text`,
        '',
      );
    }
    const before = await this.tryReadText(h);
    const chunks = chunkSendKeys(text);
    await runPowerShell(
      `
Add-Type -AssemblyName System.Windows.Forms
${PS_WINDOW_HELPERS}
${psForegroundGuard(h, 'typed')}
Start-Sleep -Milliseconds 60
$chunks = @(
${chunks.map((chunk) => '  ' + psLiteral(chunk)).join('\n')}
)
foreach ($chunk in $chunks) {
  [System.Windows.Forms.SendKeys]::SendWait($chunk)
  Start-Sleep -Milliseconds 35
}
`,
      { timeoutMs: 30_000 + text.length * 4 },
    );
    const after = await this.tryReadText(h);
    const result = mutationResult(text, before, after);
    // A short read-back means part of the text never reached the document. Report that as a
    // failure with the count, instead of the `ok` that made the original incident invisible.
    const wanted = text.replace(/\r\n/g, '\n').length;
    if (result.verified && result.delta !== undefined && result.delta < wanted) {
      throw new PowerShellError(
        `only ${result.delta} of ${wanted} characters reached window ${h}; the rest did not land. ` +
          `Read the tree back with desktop_ui_tree before typing again to avoid duplicating text.`,
        '',
      );
    }
    return result;
  }

  async sendKeys(handle: string, keys: string): Promise<TypeResult> {
    this.assertPlatform();
    assertSafeKeyChord(keys);
    const h = this.handle(handle);
    const before = await this.tryReadText(h);
    await runPowerShell(
      `
Add-Type -AssemblyName System.Windows.Forms
${PS_WINDOW_HELPERS}
${psForegroundGuard(h, 'sent')}
[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(keys)})
`,
      { timeoutMs: 30_000 },
    );
    const after = await this.tryReadText(h);
    // A hotkey may or may not change text; the read-back is evidence either way.
    return mutationResult('', before, after);
  }
  /**
   * Window-scoped capture, or an explicit whole-desktop capture when no handle is given.
   *
   * A handle-scoped capture uses `PrintWindow(PW_RENDERFULLCONTENT)`, which renders the
   * window's own composition surface: the pixels come from *that window* even when another
   * window covers it. The previous implementation did a screen-region BitBlt at the window
   * rect and reported the rect's size, so it happily returned "the window" while showing
   * whatever happened to be on top — the agent's own chat window, in the report.
   *
   * There is no fallback and no screen-region variant: the handle is required, so a capture
   * is always *that window*. A window that cannot be rendered (cloaked, minimized, hidden,
   * off-screen, no area) yields an error that names the reason.
   */
  async screenshot(handle: string): Promise<ScreenshotResult> {
    this.assertPlatform();
    const h = this.handle(handle);
    const raw = await runPowerShell(
      `
Add-Type -AssemblyName System.Drawing
${PS_WINDOW_HELPERS}
$h = [IntPtr][int64]${h}
if (-not [BeeNative]::IsWindow($h)) { throw 'window handle ${h} is no longer valid — nothing to capture' }
$st = [BeeObserve]::Describe($h)
$name = $st.Title + ' [' + $h.ToInt64() + ']'
if ($st.Cloaked -ne 0) { throw ('cannot capture ' + $name + ': the window is cloaked (cloaked=' + $st.Cloaked + ' — another virtual desktop or a suspended packaged app), so it has no pixels on this desktop') }
if ($st.Iconic) { throw ('cannot capture ' + $name + ': the window is minimized — desktop_focus it first') }
if (-not $st.Visible) { throw ('cannot capture ' + $name + ': the frame is hidden (WS_VISIBLE is not set), so the window renders no content') }
if ($st.Width -le 0 -or $st.Height -le 0) { throw ('cannot capture ' + $name + ': the window has no area (' + $st.Width + 'x' + $st.Height + ')') }
if ($st.Offscreen) { throw ('cannot capture ' + $name + ': the window is off-screen at ' + $st.X + ',' + $st.Y + ' ' + $st.Width + 'x' + $st.Height) }
$bmp = New-Object System.Drawing.Bitmap($st.Width, $st.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [BeeObserve]::PrintWindow($h, $hdc)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) {
  $bmp.Dispose()
  throw ('PrintWindow failed for ' + $name + ': the window composits nothing this driver can read (a DirectComposition surface that refuses PW_RENDERFULLCONTENT)')
}
$black = $true
for ($yy = 0; $yy -lt $st.Height -and $black; $yy += 12) {
  for ($xx = 0; $xx -lt $st.Width; $xx += 12) {
    if ($bmp.GetPixel($xx, $yy).ToArgb() -ne [System.Drawing.Color]::Black.ToArgb()) { $black = $false; break }
  }
}
if ($black) {
  $bmp.Dispose()
  throw ('the capture of ' + $name + ' is entirely black: the window rendered nothing, so this is not a picture of it')
}
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$w = $st.Width
$hh = $st.Height
$bmp.Dispose()
ConvertTo-Json -InputObject @{ png = [Convert]::ToBase64String($ms.ToArray()); width = $w; height = $hh } -Compress
`,
      { timeoutMs: 90_000 },
    );
    const shot = parseJsonOutput<{ png: string; width: number; height: number }>(raw);
    return { ...shot, source: 'window', handle: h };
  }
  /**
   * Starts an application and returns the **window** that owns the document, not the
   * launcher's pid.
   *
   * Processes lie: Win11 Notepad's `notepad.exe` exits (or lingers) while a different
   * process hosts the window, and when an instance is already running the document is
   * handed to it as a tab and no window is created at all. So the launch is followed by a
   * bounded re-enumeration: whatever *new* window of that executable appears is the answer;
   * if none appears while a live instance exists, the result says the document went there
   * (`tabAdded`) instead of claiming a window the caller can never address.
   */
  async launch(exePath: string, args: string[], cwd?: string): Promise<LaunchResult> {
    this.assertPlatform();
    const exeName = basename(exePath).toLowerCase();
    const argList = args.length ? args.map((a) => psLiteral(a)).join(' ') : '';
    const workDir = cwd ? `-WorkingDirectory ${psLiteral(cwd)}` : '';
    const raw = await runPowerShell(
      `
${PS_WINDOW_HELPERS}
$before = @{}
foreach ($w in @(Get-WindowRecords)) { $before[$w.handle] = $true }
$startedAt = Get-Date
$activated = $false
$ambiguous = $null
$p = Start-Process -FilePath ${psLiteral(exePath)} ${argList} ${workDir} -PassThru
$spawner = [int]$p.Id
$exeName = ${psLiteral(exeName)}
$deadline = (Get-Date).AddMilliseconds(8000)
$created = $null
$existing = $null
$spawnerAlive = $true
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $now = @(Get-WindowRecords)
  $fresh = @($now | Where-Object { -not $before.ContainsKey($_.handle) -and (([string]$_.exe).ToLower() -eq $exeName -or $_.processId -eq $spawner) })
  if ($fresh.Count -gt 0) {
    $visible = @($fresh | Where-Object { $_.isVisible })
    if ($visible.Count -gt 0) { $created = $visible[0] } else { $created = $fresh[0] }
    break
  }
  # A packaged (UWP/MSIX) app is started by a launcher that hands activation to a
  # different process: calc.exe activates CalculatorApp.exe, and the window belongs to that
  # process — so no window ever matches the launcher's pid or the requested exe name. A visible
  # window that did not exist before the launch and whose owning process *started* with this
  # launch is evidence of this launch. Ambiguity (several new processes) is left unresolved
  # instead of picking one.
  $unclaimed = @($now | Where-Object { -not $before.ContainsKey($_.handle) -and $_.isVisible -and [string]$_.exe -ne '' -and (([string]$_.exe).ToLower() -ne $exeName) })
  if ($unclaimed.Count -gt 0) {
    $young = @()
    foreach ($w in $unclaimed) {
      try {
        $proc = Get-Process -Id $w.processId -ErrorAction Stop
        if ($proc.StartTime -ge $startedAt.AddSeconds(-2)) { $young += $w }
      } catch { }
    }
    $youngPids = @($young | ForEach-Object { $_.processId } | Sort-Object -Unique)
    if ($young.Count -gt 0 -and $youngPids.Count -eq 1) {
      $fgYoung = @($young | Where-Object { $_.isForeground })
      $created = if ($fgYoung.Count -gt 0) { $fgYoung[0] } else { $young[0] }
      $activated = $true
      break
    }
    if ($youngPids.Count -gt 1) {
      $ambiguous = @($young | ForEach-Object { ([string]$_.exe) + ' (pid ' + $_.processId + ')' } | Sort-Object -Unique)
    }
  }
  $mine = @($now | Where-Object { ([string]$_.exe).ToLower() -eq $exeName })
  if ($mine.Count -gt 0) {
    $fg = @($mine | Where-Object { $_.isForeground })
    if ($fg.Count -gt 0) { $existing = $fg[0] } elseif ($existing -eq $null) { $existing = $mine[0] }
  }
  $spawnerAlive = $false
  try { $null = Get-Process -Id $spawner -ErrorAction Stop; $spawnerAlive = $true } catch { }
  # A launcher that hands its document to a running instance exits immediately; once that
  # happened and a live window is known, waiting for a window that will never appear is a
  # lie with a timeout attached.
  if (-not $spawnerAlive -and $existing -ne $null) { break }
}
ConvertTo-Json -InputObject @{
  spawner = $spawner
  spawnerAlive = $spawnerAlive
  activated = $activated
  ambiguous = $ambiguous
  created = $created
  existing = $existing
} -Compress -Depth 5
`,
      { timeoutMs: 60_000 },
    );
    const parsed = parseJsonOutput<RawLaunch>(raw);
    const created = this.toWindows(parsed.created ?? undefined)[0];
    const existing = this.toWindows(parsed.existing ?? undefined)[0];
    const spawner = parsed.spawner;

    if (created) {
      return {
        spawnerProcessId: spawner,
        window: created,
        windowCreated: true,
        tabAdded: false,
        detail: parsed.activated
          ? `${exeName} started (launcher pid ${spawner}); the app activated a separate process (a packaged/MSIX app), and the new window belongs to ${created.exe ?? 'another executable'} (pid ${created.processId}) — not to the launcher, so it was matched by launch time, not by exe name`
          : `${exeName} started (launcher pid ${spawner}); a new window appeared: ${created.title} [${created.handle}] owned by pid ${created.processId}`,
      };
    }
    if (existing) {
      const why = parsed.spawnerAlive
        ? `the launcher (pid ${spawner}) is still running but created no window`
        : `the launcher (pid ${spawner}) exited without creating a window`;
      return {
        spawnerProcessId: spawner,
        window: existing,
        windowCreated: false,
        tabAdded: true,
        detail: `${exeName}: ${why}, so the document went to the running instance — it is a tab in ${existing.title} [${existing.handle}] (pid ${existing.processId}). A tab is not separately addressable: address that window.`,
      };
    }
    if (parsed.ambiguous && parsed.ambiguous.length > 1) {
      throw new PowerShellError(
        `launched ${exeName} (launcher pid ${spawner}) but ${parsed.ambiguous.length} different new windows appeared at once (${parsed.ambiguous.join(', ')}) — refusing to guess which one the launch produced`,
        '',
      );
    }
    throw new PowerShellError(
      `launched ${exeName} (launcher pid ${spawner}) but no window of ${exeName} appeared within 8000ms and no running instance was found — the app may still be starting; check with desktop_list_windows`,
      '',
    );
  }
  /* ------------------------------------------------------------------ helpers */

  private handle(handle: string): string {
    if (!/^\d+$/.test(String(handle))) throw new PowerShellError(`invalid window handle: ${handle}`, '');
    return handle;
  }

  /**
   * Maps the raw enumeration into the one window shape everything else uses. Identity is
   * copied, never re-derived; implausible geometry is dropped rather than passed on.
   */
  private toWindows(raw: RawWindow[] | RawWindow | undefined | null): WindowInfo[] {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const windows: WindowInfo[] = [];
    for (const item of list) {
      if (!item || !item.handle) continue;
      const cloaked = Number(item.cloaked ?? 0);
      const box = {
        x: Number(item.bounds?.x ?? 0),
        y: Number(item.bounds?.y ?? 0),
        width: Number(item.bounds?.width ?? 0),
        height: Number(item.bounds?.height ?? 0),
      };
      const bounds = isPlausibleBounds(box) ? box : undefined;
      windows.push({
        handle: String(item.handle),
        title: String(item.title ?? ''),
        processId: Number(item.processId ?? 0),
        exe: item.exe ? String(item.exe) : undefined,
        className: String(item.className ?? ''),
        isForeground: Boolean(item.isForeground),
        isVisible: Boolean(item.isVisible),
        isMinimized: Boolean(item.isMinimized),
        isCloaked: cloaked !== 0,
        isOffscreen: Boolean(item.offscreen) || bounds === undefined,
        virtualDesktop: cloaked === 2 ? 'other' : cloaked !== 0 ? 'unknown' : 'current',
        bounds,
      });
    }
    return windows;
  }
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
