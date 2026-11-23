import type { Stats } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ToolDefinition } from '../../shared/tools';
import type { AuditLog } from '../audit';
import type { PolicyEngine } from '../policy';
import { errorResult, jsonResult, num, requireStr, str } from './registry';

interface FileToolDeps {
  policy: PolicyEngine;
  audit: AuditLog;
}

const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_HITS = 200;

function allowPath(
  policy: PolicyEngine,
  target: string,
  write: boolean,
  ctx: { sessionId: string; workspaceRoots: string[] },
  audit: AuditLog,
) {
  const abs = resolve(target);
  // The session working directory always counts as a root for its own tools.
  const decision = policy.evaluateFile(abs, write, ctx.workspaceRoots);
  if (!decision.allowed) {
    audit.record({
      sessionId: ctx.sessionId,
      action: write ? 'file-write' : 'file-read',
      target: abs,
      outcome: 'denied',
      detail: decision.reason,
    });
    return { ok: false as const, abs, decision };
  }
  return { ok: true as const, abs, decision };
}

/** Comparison key for a path that is used as a workspace root (case-insensitive on Windows). */
function rootKey(abs: string): string {
  const trimmed = resolve(abs).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** True when the path *is* the session cwd or one of the workspace roots. */
function isWorkspaceRoot(abs: string, ctx: { cwd: string; workspaceRoots: string[] }): boolean {
  const key = rootKey(abs);
  return [ctx.cwd, ...ctx.workspaceRoots].filter(Boolean).some((root) => rootKey(root) === key);
}

async function statOrNull(target: string): Promise<Stats | undefined> {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}

export function fileTools(deps: FileToolDeps): ToolDefinition[] {
  const { policy, audit } = deps;

  return [
    {
      name: 'fs_list',
      description: 'List files and directories under a path (defaults to the workspace root).',
      mutating: false,
      group: 'files',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list (absolute or workspace-relative).' },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const checked = allowPath(policy, resolve(ctx.cwd, str(args, 'path') ?? '.'), false, ctx, audit);
        if (!checked.ok) return errorResult(checked.decision.reason, { denied: true });
        const names = await readdir(checked.abs, { withFileTypes: true });
        const entries = await Promise.all(
          names.slice(0, 500).map(async (d) => {
            const full = join(checked.abs, d.name);
            let size: number | undefined;
            try {
              if (d.isFile()) size = (await stat(full)).size;
            } catch {
              /* ignore */
            }
            return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size };
          }),
        );
        return jsonResult({ path: checked.abs, entries });
      },
    },
    {
      name: 'fs_read',
      description: 'Read a UTF-8 text file from the workspace.',
      mutating: false,
      group: 'files',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to read.' },
          maxBytes: { type: 'number', description: 'Truncate after this many bytes (default 262144).' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const abs = resolve(ctx.cwd, requireStr(args, 'path'));
        const checked = allowPath(policy, abs, false, ctx, audit);
        if (!checked.ok) return errorResult(checked.decision.reason, { denied: true });
        const limit = Math.min(num(args, 'maxBytes', MAX_READ_BYTES), MAX_READ_BYTES);
        const buf = await readFile(checked.abs);
        const truncated = buf.length > limit;
        const text = buf.subarray(0, limit).toString('utf8');
        audit.record({ sessionId: ctx.sessionId, action: 'file-read', target: checked.abs, outcome: 'allowed' });
        return jsonResult({ path: checked.abs, bytes: buf.length, truncated, text });
      },
    },
    {
      name: 'fs_write',
      description: 'Create or overwrite a UTF-8 text file inside the workspace.',
      mutating: true,
      group: 'files',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to write.' },
          content: { type: 'string', description: 'Full new content.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      preview: (args) => ({
        requiresApproval: true,
        summary: `Write ${String(args.path ?? '')} (${String(args.content ?? '').length} chars)`,
        reason: 'file writes modify the workspace',
      }),
      async handler(args, ctx) {
        const abs = resolve(ctx.cwd, requireStr(args, 'path'));
        const checked = allowPath(policy, abs, true, ctx, audit);
        if (!checked.ok) return errorResult(checked.decision.reason, { denied: true });
        const content = requireStr(args, 'content');
        await mkdir(dirname(checked.abs), { recursive: true });
        await writeFile(checked.abs, content, 'utf8');
        audit.record({
          sessionId: ctx.sessionId,
          action: 'file-write',
          target: checked.abs,
          outcome: 'allowed',
          detail: `${content.length} chars`,
        });
        return jsonResult({ ok: true, path: checked.abs, bytes: Buffer.byteLength(content) });
      },
    },
    {
      name: 'fs_search',
      description: 'Regex search across text files in the workspace (returns path:line hits).',
      mutating: false,
      group: 'files',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression.' },
          path: { type: 'string', description: 'Root directory (defaults to the workspace).' },
          maxResults: { type: 'number', description: 'Stop after this many hits (default 100).' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const abs = resolve(ctx.cwd, str(args, 'path') ?? '.');
        const checked = allowPath(policy, abs, false, ctx, audit);
        if (!checked.ok) return errorResult(checked.decision.reason, { denied: true });
        let regex: RegExp;
        try {
          regex = new RegExp(requireStr(args, 'pattern'), 'i');
        } catch (err) {
          return errorResult(`invalid pattern: ${(err as Error).message}`);
        }
        const limit = Math.min(num(args, 'maxResults', 100), MAX_SEARCH_HITS);
        const hits: Array<{ path: string; line: number; text: string }> = [];
        const skip = new Set(['node_modules', '.git', 'dist', 'out', 'release', '.beecode']);

        const walk = async (dir: string, depth: number): Promise<void> => {
          if (hits.length >= limit || depth > 8) return;
          let entries;
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (hits.length >= limit) return;
            if (skip.has(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              await walk(full, depth + 1);
              continue;
            }
            if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|yml|yaml|ps1|cs|py)$/i.test(entry.name)) continue;
            try {
              const raw = await readFile(full, 'utf8');
              const lines = raw.split(/\r?\n/);
              for (let i = 0; i < lines.length; i += 1) {
                if (regex.test(lines[i] ?? '')) {
                  hits.push({ path: full, line: i + 1, text: (lines[i] ?? '').trim().slice(0, 300) });
                  if (hits.length >= limit) return;
                }
              }
            } catch {
              /* unreadable file — skip */
            }
          }
        };
        await walk(checked.abs, 0);
        return jsonResult({ pattern: String(args.pattern), hits, truncated: hits.length >= limit });
      },
    },
    {
      name: 'fs_mkdir',
      description: 'Create a directory inside the workspace (parent directories included).',
      mutating: true,
      group: 'files',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to create.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      preview: (args) => ({
        requiresApproval: true,
        summary: 'Create directory ' + String(args.path ?? ''),
        reason: 'creating directories modifies the workspace',
      }),
      async handler(args, ctx) {
        const abs = resolve(ctx.cwd, requireStr(args, 'path'));
        const checked = allowPath(policy, abs, true, ctx, audit);
        if (!checked.ok) return errorResult(checked.decision.reason, { denied: true });
        const created = await mkdir(checked.abs, { recursive: true });
        // mkdir returns the first directory it actually created, or undefined when it existed.
        audit.record({
          sessionId: ctx.sessionId,
          tool: 'fs_mkdir',
          action: 'dir-create',
          target: checked.abs,
          outcome: 'allowed',
          detail: created ? 'created' : 'already existed',
        });
        return jsonResult({ ok: true, path: checked.abs, created: Boolean(created) });
      },
    },
    {
      name: 'fs_delete',
      description:
        'Delete a file, or a directory when recursive is true, inside the workspace. This cannot be undone.',
      mutating: true,
      group: 'files',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory to delete.' },
          recursive: {
            type: 'boolean',
            description: 'Required to delete a directory and everything below it.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      preview: (args) => ({
        requiresApproval: true,
        summary:
          'Delete ' +
          String(args.path ?? '') +
          (args.recursive === true ? ' and everything below it' : ''),
        reason: 'deletes cannot be undone from the chat',
      }),
      async handler(args, ctx) {
        const abs = resolve(ctx.cwd, requireStr(args, 'path'));
        const checked = allowPath(policy, abs, true, ctx, audit);
        if (!checked.ok) return errorResult(checked.decision.reason, { denied: true });
        if (isWorkspaceRoot(checked.abs, ctx)) {
          audit.record({
            sessionId: ctx.sessionId,
            tool: 'fs_delete',
            action: 'file-delete',
            target: checked.abs,
            outcome: 'denied',
            detail: 'workspace root',
          });
          return errorResult('refusing to delete the workspace root ' + checked.abs, { denied: true });
        }
        const info = await statOrNull(checked.abs);
        if (!info) return errorResult('"' + abs + '" does not exist');
        const recursive = args.recursive === true;
        if (info.isDirectory() && !recursive) {
          return errorResult(
            '"' + abs + '" is a directory; pass recursive: true to delete it and its contents',
          );
        }
        await rm(checked.abs, { recursive, force: false });
        audit.record({
          sessionId: ctx.sessionId,
          tool: 'fs_delete',
          action: 'file-delete',
          target: checked.abs,
          outcome: 'allowed',
          detail: info.isDirectory() ? 'directory (recursive)' : 'file',
        });
        return jsonResult({
          ok: true,
          path: checked.abs,
          kind: info.isDirectory() ? 'directory' : 'file',
        });
      },
    },
    {
      name: 'fs_move',
      description:
        'Move or rename a file or directory inside the workspace. Missing parent directories of the destination are created.',
      mutating: true,
      group: 'files',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Existing path to move.' },
          to: { type: 'string', description: 'Destination path.' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      preview: (args) => ({
        requiresApproval: true,
        summary: 'Move ' + String(args.from ?? '') + ' -> ' + String(args.to ?? ''),
        reason: 'moves change the workspace layout',
      }),
      async handler(args, ctx) {
        const fromAbs = resolve(ctx.cwd, requireStr(args, 'from'));
        const toAbs = resolve(ctx.cwd, requireStr(args, 'to'));
        // The source is a write too: after the move it is gone from its old path.
        const fromChecked = allowPath(policy, fromAbs, true, ctx, audit);
        if (!fromChecked.ok) return errorResult(fromChecked.decision.reason, { denied: true });
        const toChecked = allowPath(policy, toAbs, true, ctx, audit);
        if (!toChecked.ok) return errorResult(toChecked.decision.reason, { denied: true });
        if (isWorkspaceRoot(fromChecked.abs, ctx) || isWorkspaceRoot(toChecked.abs, ctx)) {
          audit.record({
            sessionId: ctx.sessionId,
            tool: 'fs_move',
            action: 'file-move',
            target: fromChecked.abs,
            outcome: 'denied',
            detail: 'workspace root',
          });
          return errorResult('refusing to move the workspace root', { denied: true });
        }
        if (fromChecked.abs === toChecked.abs) {
          return errorResult('source and destination are the same path');
        }
        const info = await statOrNull(fromChecked.abs);
        if (!info) return errorResult('"' + fromAbs + '" does not exist');
        if (await statOrNull(toChecked.abs)) {
          return errorResult('"' + toAbs + '" already exists');
        }
        await mkdir(dirname(toChecked.abs), { recursive: true });
        try {
          await rename(fromChecked.abs, toChecked.abs);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EXDEV') {
            return errorResult(
              'cannot move "' +
                fromAbs +
                '" to "' +
                toAbs +
                '" across drives; write the file at the destination and delete the original instead',
              { code },
            );
          }
          throw err;
        }
        audit.record({
          sessionId: ctx.sessionId,
          tool: 'fs_move',
          action: 'file-move',
          target: fromChecked.abs,
          outcome: 'allowed',
          detail: toChecked.abs,
        });
        return jsonResult({
          ok: true,
          from: fromChecked.abs,
          to: toChecked.abs,
          kind: info.isDirectory() ? 'directory' : 'file',
        });
      },
    },
  ];
}
