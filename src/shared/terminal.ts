/**
 * Contract for the workspace terminal: a command runner the renderer drives directly,
 * confined to the configured workspace folder.
 *
 * The Electron main process owns the child process — the renderer never spawns anything
 * (it is sandboxed and has no `require`). Each command runs as a one-shot shell invocation
 * whose working directory is always inside the workspace root, and `cd` is handled here so
 * it cannot climb above it either. This is a convenience terminal, not a shell session:
 * no PTY, no interactive prompts, no full-screen programs.
 */

/** Where one piece of terminal text came from. */
export type TerminalStream = 'command' | 'stdout' | 'stderr' | 'system';

/**
 * One entry in the scrollback. `text` is raw and may end without a newline, so the
 * renderer concatenates the entries in order instead of treating each one as a line.
 */
export interface TerminalLine {
  /** Monotonic id: the renderer appends only what it has not drawn yet. */
  id: number;
  stream: TerminalStream;
  text: string;
}

/** Everything the Terminal panel draws. */
export interface TerminalState {
  /** Workspace root the terminal is confined to. */
  root: string;
  /** Current working directory; always `root` or a folder below it. */
  cwd: string;
  /** True while a command is running. */
  busy: boolean;
  /** Exit code of the last command that finished, if it ran one. */
  exitCode?: number;
  /** Command lines the user has run, newest last. */
  history: string[];
  /** Scrollback, oldest first. */
  lines: TerminalLine[];
}

/** The renderer-facing terminal API exposed on `window.beeCode.terminal`. */
export interface TerminalApi {
  /** Current scrollback and working directory. */
  state(): Promise<TerminalState>;
  /** Run one command line; output arrives through `onState`. */
  run(command: string): Promise<TerminalState>;
  /** Kill the running command, if any. */
  cancel(): Promise<TerminalState>;
  /** Drop the scrollback, keeping the working directory. */
  clear(): Promise<TerminalState>;
  /** Subscribe to state changes; returns the unsubscribe function. */
  onState(listener: (state: TerminalState) => void): () => void;
}
