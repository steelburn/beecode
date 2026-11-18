import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
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

function allowPath(policy: PolicyEngine, target: string, write: boolean, ctx: { sessionId: string }, audit: AuditLog) {
  const abs = resolve(ctx ? target : target);
  const decision = policy.evaluateFile(abs, write);
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
          maxBytes: { type: 'number', description: 'Truncate after this many bytes (default 256000).' },
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
  ];
}
