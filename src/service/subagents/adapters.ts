import { spawn, spawnSync } from 'node:child_process';

export interface CliAgentConfig {
  id: string;
  label: string;
  command: string;
  args: string[];
  enabled: boolean;
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

  /** `where` / `which` probe — availability is reported to the UI and the model. */
  probe(): { available: boolean; detail?: string } {
    if (!this.config.enabled) return { available: false, detail: 'disabled in config' };
    try {
      const isWin = process.platform === 'win32';
      const res = spawnSync(isWin ? 'where.exe' : 'which', [this.config.command], {
        windowsHide: true,
        encoding: 'utf8',
      });
      if (res.status === 0) return { available: true };
      return { available: false, detail: `${this.config.command} not found on PATH` };
    } catch (err) {
      return { available: false, detail: (err as Error).message };
    }
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
