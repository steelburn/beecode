import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, sep } from 'node:path';
import type { TerminalLine, TerminalState } from '../shared/terminal';

/**
 * The workspace terminal: runs one shell command at a time with a working directory that
 * is always inside the workspace root.
 *
 * Confinement is about where commands *start*, not about what they may do — a command can
 * still reach any path its own process can, exactly like `npm run` in a normal terminal.
 * What is enforced here: the cwd is the workspace root or a folder below it, `cd` cannot
 * climb above the root, and a command cannot start while another one is running.
 *
 * No Electron imports on purpose: this module is plain node, so it can be unit tested.
 */

/** Scrollback caps — a chatty build must not grow the renderer without bound. */
const MAX_LINES = 4000;
const MAX_CHARS = 400 * 1024;
/** How many command lines the history keeps. */
const MAX_HISTORY = 50;

/** Windows builds of node have no POSIX shell, and `cmd /c` handles `&&`, pipes and `dir`. */
const WINDOWS = process.platform === 'win32';

export interface WorkspaceTerminalOptions {
  /** Absolute workspace root; the terminal starts here and may not leave it. */
  root: string;
  /** Called with a fresh snapshot after every change. */
  onChange?: (state: TerminalState) => void;
}

/** True when `target` is `root` itself or a folder below it. */
export function isInsideWorkspace(root: string, target: string): boolean {
  const base = resolve(root);
  const candidate = resolve(target);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return WINDOWS
    ? candidate.toLowerCase() === base.toLowerCase() || candidate.toLowerCase().startsWith(prefix.toLowerCase())
    : candidate === base || candidate.startsWith(prefix);
}

/** Strip the quotes a user typed around a path, so `cd "my folder"` works. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^['"]/.test(trimmed) && trimmed[0] === trimmed[trimmed.length - 1]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export class WorkspaceTerminal {
  private root: string;
  private cwd: string;
  private child?: ChildProcess;
  private busy = false;
  private exitCode?: number;
  private lines: TerminalLine[] = [];
  private chars = 0;
  private history: string[] = [];
  private seq = 0;
  private readonly onChange?: (state: TerminalState) => void;

  constructor(options: WorkspaceTerminalOptions) {
    this.root = options.root ? resolve(options.root) : '';
    this.cwd = this.root;
    this.onChange = options.onChange;
  }

  /** Point the terminal at a new workspace; the scrollback belongs to the old one. */
  setRoot(root: string): void {
    const next = root ? resolve(root) : '';
    if (!next || next === this.root) return;
    this.kill();
    this.root = next;
    this.cwd = next;
    this.lines = [];
    this.chars = 0;
    this.exitCode = undefined;
    this.seq = 0;
    this.push('system', next ? `Workspace terminal is now confined to ${next}\n` : 'No workspace folder is open.\n');
  }

  get state(): TerminalState {
    return {
      root: this.root,
      cwd: this.cwd,
      busy: this.busy,
      exitCode: this.exitCode,
      history: [...this.history],
      lines: [...this.lines],
    };
  }

  /**
   * Run one command line. Built-ins (`cd`, `clear`) are handled here because they change
   * terminal state rather than spawning anything; everything else goes to the shell.
   */
  run(command: string): TerminalState {
    const line = command.trim();
    if (!line) return this.state;
    if (!this.root) {
        this.push('system', 'No workspace folder is open, so there is nowhere to run a command.\n');
        this.emit();
        return this.state;
      }
      if (this.busy) throw new Error('a command is still running in the workspace terminal');
    this.history = [...this.history, line].slice(-MAX_HISTORY);
    this.push('command', `$ ${line}\n`);
    if (this.runBuiltin(line)) return this.state;
    this.exitCode = undefined;
    this.busy = true;
    const child = this.spawnCommand(line);
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.push('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => this.push('stderr', chunk));
    child.on('error', (error: Error) => {
      this.push('stderr', `${error.message}\n`);
      this.finish(undefined);
    });
    child.on('close', (code) => this.finish(code ?? undefined));
    this.emit();
    return this.state;
  }

  /** Kill the running command (and its children on Windows). */
  cancel(): TerminalState {
    if (!this.busy) return this.state;
    this.push('system', '^C cancelled\n');
    this.kill();
    return this.state;
  }

  /** Drop the scrollback; the working directory stays where the user left it. */
  clear(): TerminalState {
    this.lines = [];
    this.chars = 0;
    this.seq = 0;
    this.emit();
    return this.state;
  }

  /** Kill the running command, if any; called when the window goes away. */
  dispose(): void {
    this.kill();
  }

  private runBuiltin(line: string): boolean {
    if (/^(clear|cls)$/i.test(line)) {
      this.clear();
      return true;
    }
    const cd = /^cd(?:\s+([\s\S]*))?$/i.exec(line);
    if (!cd) return false;
    const target = unquote(cd[1] ?? '') || this.root;
    const next = resolve(this.cwd, target);
    if (!isInsideWorkspace(this.root, next)) {
      this.push('stderr', `cd: ${next} is outside the workspace (${this.root})\n`);
      this.emit();
      return true;
    }
    this.cwd = next;
    this.push('system', `${next}\n`);
    this.emit();
    return true;
  }

  private spawnCommand(line: string): ChildProcess {
    // `windowsVerbatimArguments` stops Node from re-quoting the line: joined verbatim the
    // argv becomes `cmd.exe /d /s /c "<line>"`, and `/s` strips exactly the one quote pair
    // added here. Letting Node quote it instead escapes an embedded "…" as \" which cmd
    // hands to the child literally, so `node -e "…"` ran without its argument and every
    // exit code came back 0.
    return WINDOWS
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
          cwd: this.cwd,
          windowsHide: true,
          shell: false,
          windowsVerbatimArguments: true,
        })
      : spawn('/bin/sh', ['-c', line], { cwd: this.cwd, shell: false });
  }

  private finish(code: number | undefined): void {
    if (!this.busy) return;
    this.busy = false;
    this.exitCode = code;
    this.child = undefined;
    const label = code === undefined ? 'stopped' : `exit ${code}`;
    this.push('system', `[${label}]\n`);
    this.emit();
  }

  private kill(): void {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.killed) return;
    if (WINDOWS && child.pid) {
      /* cmd.exe is only the wrapper: /T takes the console children down with it. */
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    child.kill('SIGTERM');
  }

  private push(stream: TerminalLine['stream'], text: string): void {
    if (!text) return;
    this.lines.push({ id: ++this.seq, stream, text });
    this.chars += text.length;
    while (this.lines.length > MAX_LINES || this.chars > MAX_CHARS) {
      const dropped = this.lines.shift();
      this.chars -= dropped ? dropped.text.length : 0;
      if (!this.lines.length) break;
    }
  }

  private emit(): void {
    this.onChange?.(this.state);
  }
}
