import { spawn } from 'node:child_process';

/**
 * Shared P/Invoke surface. One Add-Type per invocation keeps every script self-contained
 * (no resident helper process), and the callbacks are needed because UWP apps live inside
 * ApplicationFrameHost: their real process and their automation tree are behind a child
 * window, so plain Get-Process/FromHandle is not enough.
 */
const NATIVE_PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not ('BeeNative' -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BeeNative {
  public delegate bool BeeEnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(BeeEnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, BeeEnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static string Title(IntPtr hWnd) {
    var sb = new System.Text.StringBuilder(1024);
    GetWindowText(hWnd, sb, 1024);
    return sb.ToString();
  }

  public static void Close(IntPtr hWnd) { SendMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero); }

  /** Hosted (UWP) windows have no child of their own in the frame process. */
  public static uint ChildPid(IntPtr parent) {
    uint parentPid; GetWindowThreadProcessId(parent, out parentPid);
    uint found = 0;
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) {
      uint cp; GetWindowThreadProcessId(h, out cp);
      // The frame host owns several helper children; the real app is a *different* process.
      if (cp != 0 && cp != parentPid) { found = cp; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr ChildHandle(IntPtr parent) {
    uint parentPid; GetWindowThreadProcessId(parent, out parentPid);
    IntPtr visible = IntPtr.Zero;
    IntPtr any = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) {
      uint cp; GetWindowThreadProcessId(h, out cp);
      if (cp == 0 || cp == parentPid) return true;
      if (any == IntPtr.Zero) any = h;
      if (IsWindowVisible(h)) { visible = h; return false; }
      return true;
    }, IntPtr.Zero);
    return visible != IntPtr.Zero ? visible : any;
  }

  public static uint PidOf(IntPtr hWnd) {
    uint pid; GetWindowThreadProcessId(hWnd, out pid);
    return pid;
  }

  /**
   * Best-effort foreground switch past the Windows focus lock: plain SetForegroundWindow
   * is refused unless the caller already owns the foreground, so we unlock it with a
   * synthetic Alt press and, failing that, attach to the foreground thread's input queue.
   */
  public static bool ForceForeground(IntPtr hWnd) {
    if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
    ShowWindow(hWnd, 5);
    if (SetForegroundWindow(hWnd) && GetForegroundWindow() == hWnd) return true;

    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    if (SetForegroundWindow(hWnd) && GetForegroundWindow() == hWnd) return true;

    uint pid;
    IntPtr fg = GetForegroundWindow();
    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out pid);
    uint curThread = GetCurrentThreadId();
    if (fgThread != 0 && fgThread != curThread) {
      AttachThreadInput(curThread, fgThread, true);
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
      AttachThreadInput(curThread, fgThread, false);
    }
    return GetForegroundWindow() == hWnd;
  }
}
"@
}
`;

export interface PowerShellOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class PowerShellError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'PowerShellError';
  }
}

/**
 * Runs a PowerShell script through `-EncodedCommand` (base64/UTF-16LE), so no quoting or
 * escaping bug can leak user text into the command line. All desktop automation on Windows
 * is implemented this way: no native addons, no elevation, no extra install.
 */
export function runPowerShell(body: string, options: PowerShellOptions = {}): Promise<string> {
  const script = `${NATIVE_PRELUDE}\n${body}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const timeoutMs = options.timeoutMs ?? 20_000;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new PowerShellError(`PowerShell timed out after ${timeoutMs}ms`, stderr)));
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
      finish(() => reject(new PowerShellError('PowerShell aborted', stderr)));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => finish(() => reject(new PowerShellError(err.message, stderr))));
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(stdout.trim());
        else reject(new PowerShellError(`PowerShell exited with ${code}: ${stderr.trim() || 'no output'}`, stderr));
      });
    });
  });
}

/** Parse the JSON blob a script writes to its final output line. */
export function parseJsonOutput<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) throw new PowerShellError('PowerShell returned no output', '');
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Scripts may print warnings before the payload; fall back to the last JSON-looking line.
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = (lines[i] ?? '').trim();
      if (line.startsWith('{') || line.startsWith('[')) {
        try {
          return JSON.parse(line) as T;
        } catch {
          /* keep looking */
        }
      }
    }
    throw new PowerShellError(`Could not parse PowerShell JSON output: ${trimmed.slice(0, 300)}`, '');
  }
}

/** Escape text for `[System.Windows.Forms.SendKeys]::SendWait`. */
export function escapeSendKeys(text: string): string {
  return text
    .replace(/\r\n/g, '{ENTER}')
    .replace(/\n/g, '{ENTER}')
    .replace(/\t/g, '{TAB}')
    .replace(/([+^%~(){}\[\]])/g, '{$1}');
}

/**
 * Guard for hotkey expressions such as `^s`, `%{TAB}` or `{ENTER}`.
 *
 * SendKeys has no injection surface (the chord goes through a properly quoted PowerShell
 * literal); this only rejects control characters and absurd lengths.
 */
export function assertSafeKeyChord(keys: string): void {
  if (!keys.length || keys.length > 64 || !/^[\x20-\x7E]+$/.test(keys)) {
    throw new PowerShellError(`Unsupported key chord: ${JSON.stringify(keys)}`, '');
  }
}
