import { spawn, spawnSync } from 'node:child_process';

export interface CliAgentConfig {
  id: string;
  label: string;
  command: string;
  args: string[];
  enabled: boolean;
  /** Added by the user instead of seeded from {@link AGENT_PRESETS}. */
  custom?: boolean;
}

/** Result of looking a command up on PATH. */
export interface CommandProbe {
  onPath: boolean;
  /** First line of `<command> --version`, when the CLI answers. */
  version?: string;
  detail?: string;
}

/**
 * Built-in catalogue of external coding agents beeCode knows how to drive.
 *
 * Detection walks this list on PATH: a binary that is found but not configured is
 * offered to the user in Settings instead of being silently ignored.
 */
export const AGENT_PRESETS: ReadonlyArray<Omit<CliAgentConfig, 'enabled'>> = [
  { id: 'claude', label: 'Claude Code', command: 'claude', args: ['-p'] },
  { id: 'codex', label: 'Codex CLI', command: 'codex', args: ['exec'] },
  { id: 'opencode', label: 'opencode', command: 'opencode', args: ['run'] },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['-p'] },
  { id: 'aider', label: 'Aider', command: 'aider', args: ['--message'] },
  { id: 'hermes', label: 'Hermes', command: 'hermes', args: [] },
  { id: 'cursor-agent', label: 'Cursor Agent', command: 'cursor-agent', args: ['-p'] },
  { id: 'dsh', label: 'dsh', command: 'dsh', args: [] },
  // `pi` runs one-shot with `-p <prompt>`; without the flag it opens its own TUI and
  // the delegation would block until the timeout fires.
  { id: 'pi', label: 'pi', command: 'pi', args: ['-p'] },
];

/** Ids the runner reserves for itself — a CLI may not take them over. */
const RESERVED_IDS = new Set(['internal']);

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Sanitize `subagents.cliAgents` coming from config.json or `agents.save`.
 *
 * An entry without a command is dropped (it could never run), ids are slugged and
 * deduped, and the reserved ids are refused — the same "narrow, never widen" rule the
 * plugin manifest follows. Unknown fields are discarded rather than copied through.
 */
export function normalizeCliAgents(input: unknown): CliAgentConfig[] {
  const agents: CliAgentConfig[] = [];
  const seen = new Set<string>();
  const commands = new Set<string>();
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (!command) continue;
    // Only the SAME command twice is a duplicate. Two different commands can share a
    // basename (`C:\tools\run.cmd` and `D:\ci\run.cmd`), so a taken id is suffixed
    // instead of silently dropping the second entry the user added.
    const commandKey = command.toLowerCase();
    if (commands.has(commandKey)) continue;
    const base = slug(typeof entry.id === 'string' && entry.id.trim() ? entry.id : command.split(/[\\/]/).pop() ?? command);
    if (!base || RESERVED_IDS.has(base)) continue;
    let id = base;
    for (let n = 2; seen.has(id); n += 1) id = `${base}-${n}`;
    seen.add(id);
    commands.add(commandKey);
    const args = Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
      : [];
    agents.push({
      id,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 60) : id,
      command: command.slice(0, 500),
      args: args.slice(0, 20),
      enabled: entry.enabled !== false,
      ...(entry.custom === true ? { custom: true } : {}),
    });
  }
  return agents;
}

const PROBE_TIMEOUT_MS = 4000;

/** Look a command up on PATH and read its version. Never throws. */
export function probeCommand(command: string): CommandProbe {
  if (!command.trim()) return { onPath: false, detail: 'no command configured' };
  const isWin = process.platform === 'win32';
  try {
    const found = spawnSync(isWin ? 'where.exe' : 'which', [command], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
    if (found.status !== 0) return { onPath: false, detail: `${command} not found on PATH` };
    const location = String(found.stdout ?? '').split(/\r?\n/).find((line) => line.trim());
    const versionRun = spawnSync(command, ['--version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      shell: isWin, // .cmd shims (codex.cmd, claude.cmd)
    });
    const version = String(versionRun.stdout ?? versionRun.stderr ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return {
      onPath: true,
      version: version ? version.slice(0, 120) : undefined,
      detail: location?.trim(),
    };
  } catch (err) {
    return { onPath: false, detail: (err as Error).message };
  }
}

export interface CliRunResult {
  exitCode: number | null;
  output: string;
  error?: string;
  timedOut: boolean;
}

/**
 * Thin adapter over an external coding-agent CLI (codex / claude / gemini / aider …).
 *
 * beeCode only needs one contract: `<command> <configured args…> <prompt>` writing
 * progress to stdout. That keeps new agents a config entry instead of a class, which is
 * also how ado-code's adapter registry stays small.
 */
export class CliAgentAdapter {
  constructor(readonly config: CliAgentConfig) {}

  get id(): string {
    return this.config.id;
  }

  get label(): string {
    return this.config.label;
  }

  /**
   * `where` / `which` probe plus a `--version` read — availability and version are
   * reported to the UI so the user can see which detection result they are trusting.
   */
  probe(): { available: boolean; detail?: string; version?: string; onPath: boolean } {
    if (!this.config.enabled) {
      return { available: false, onPath: false, detail: 'disabled in config' };
    }
    const probe = probeCommand(this.config.command);
    return {
      available: probe.onPath,
      onPath: probe.onPath,
      version: probe.version,
      detail: probe.onPath
        ? probe.version ?? probe.detail
        : `${this.config.command} not found on PATH`,
    };
  }

  buildArgv(prompt: string): string[] {
    return [...this.config.args, prompt];
  }

  async run(
    prompt: string,
    options: {
      cwd: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      onOutput?: (chunk: string) => void;
    },
  ): Promise<CliRunResult> {
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    const argv = this.buildArgv(prompt);

    return new Promise<CliRunResult>((resolve) => {
      let output = '';
      let settled = false;
      let timedOut = false;

      const child = spawn(this.config.command, argv, {
        cwd: options.cwd,
        windowsHide: true,
        shell: process.platform === 'win32', // .cmd shims (codex.cmd, claude.cmd)
        env: { ...process.env, BEECODE_SUBAGENT: '1' },
      });

      const finish = (result: CliRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      const onAbort = () => child.kill();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const capture = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        output += text;
        options.onOutput?.(text);
      };

      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.on('error', (err) => finish({ exitCode: -1, output, error: err.message, timedOut }));
      child.on('close', (code) =>
        finish({
          exitCode: code,
          output,
          error:
            code === 0
              ? undefined
              : timedOut
                ? `timed out after ${timeoutMs}ms`
                : `exited with code ${code}`,
          timedOut,
        }),
      );
    });
  }
}
