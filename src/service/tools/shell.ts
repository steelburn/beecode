import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { ToolDefinition } from '../../shared/tools';
import type { AuditLog } from '../audit';
import type { PolicyEngine } from '../policy';
import { errorResult, jsonResult, num, requireStr, str } from './registry';

interface ShellToolDeps {
  policy: PolicyEngine;
  audit: AuditLog;
}

const MAX_OUTPUT = 32 * 1024;

export function shellTools(deps: ShellToolDeps): ToolDefinition[] {
  const { policy, audit } = deps;

  return [
    {
      name: 'shell_run',
      description:
        'Run a shell command in the workspace. Only commands matching the policy allow-list may run, and every run is audited.',
      mutating: true,
      group: 'shell',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to execute.' },
          cwd: { type: 'string', description: 'Working directory (defaults to the session workspace).' },
          timeoutMs: { type: 'number', description: 'Kill after this many ms (default 60000).' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      preview: (args, ctx) => {
        const command = String(args.command ?? '');
        const decision = policy.evaluateShell(command);
        if (ctx.mode === 'autonomous') {
          return { requiresApproval: false, summary: `$ ${command}`, reason: 'autonomous mode' };
        }
        return {
          requiresApproval: true,
          summary: `$ ${command}`,
          reason: decision.allowed ? 'shell commands are always confirmed' : `policy: ${decision.reason}`,
        };
      },
      async handler(args, ctx) {
        const command = requireStr(args, 'command');
        const decision = policy.evaluateShell(command);
        if (!decision.allowed) {
          audit.record({
            sessionId: ctx.sessionId,
            tool: 'shell_run',
            action: 'shell',
            target: command,
            outcome: 'denied',
            detail: decision.reason,
          });
          return errorResult(decision.reason, { denied: true });
        }

        const cwd = resolve(ctx.cwd, str(args, 'cwd') ?? '.');
        const cwdCheck = policy.evaluateFile(cwd, false, ctx.workspaceRoots);
        if (!cwdCheck.allowed) return errorResult(cwdCheck.reason, { denied: true });

        const timeoutMs = Math.min(num(args, 'timeoutMs', 60_000), 300_000);
        const isWin = process.platform === 'win32';
        const file = isWin ? 'cmd.exe' : '/bin/sh';
        const argv = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

        const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
          (resolvePromise) => {
            const child = spawn(file, argv, { cwd, windowsHide: true, env: process.env });
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeoutMs);

            child.stdout.on('data', (d: Buffer) => {
              if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
            });
            child.stderr.on('data', (d: Buffer) => {
              if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
            });
            const onAbort = () => child.kill();
            ctx.signal.addEventListener('abort', onAbort, { once: true });
            child.on('error', (err) => {
              clearTimeout(timer);
              resolvePromise({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
            });
            child.on('close', (code) => {
              clearTimeout(timer);
              ctx.signal.removeEventListener('abort', onAbort);
              resolvePromise({ code, stdout, stderr, timedOut });
            });
          },
        );

        audit.record({
          sessionId: ctx.sessionId,
          tool: 'shell_run',
          action: 'shell',
          target: command,
          outcome: result.code === 0 ? 'allowed' : 'failed',
          detail: `exit ${result.code}${result.timedOut ? ' (timeout)' : ''}`,
        });

        return jsonResult({
          command,
          cwd,
          exitCode: result.code,
          timedOut: result.timedOut,
          stdout: result.stdout.slice(0, MAX_OUTPUT),
          stderr: result.stderr.slice(0, MAX_OUTPUT),
        });
      },
    },
  ];
}
