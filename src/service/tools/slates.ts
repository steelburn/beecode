import { resolve } from 'node:path';
import type { ToolDefinition, ToolResult } from '../../shared/tools';
import type { PolicyEngine } from '../policy';
import { SLATE_KINDS, type SlateMeta, type SlateStore } from '../slates';
import { errorResult, jsonResult, requireStr, str } from './registry';

interface SlateToolDeps {
  store: SlateStore;
  policy: PolicyEngine;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The payload is what the model sees; `meta.slate` is what the transcript card and the
 * SLATE_TAB read, so the document body never has to travel through the transcript.
 */
function slateResult(meta: SlateMeta, action: 'created' | 'updated'): ToolResult {
  const current = meta.versions.find((candidate) => candidate.n === meta.current) ?? meta.versions[meta.versions.length - 1];
  return jsonResult(
    {
      action,
      slate: {
        id: meta.id,
        title: meta.title,
        kind: meta.kind,
        version: meta.current,
        versions: meta.versions.length,
        file: current?.file,
      },
      note:
        action === 'created'
          ? 'The slate is shown in its own tab, not in the chat. Revise it with update_slate instead of creating another slate.'
          : 'The new version is now the one shown in its tab. Earlier versions stay on disk.',
    },
    {
      slate: {
        id: meta.id,
        title: meta.title,
        kind: meta.kind,
        version: meta.current,
        versions: meta.versions.length,
      },
    },
  );
}

export function slateTools(deps: SlateToolDeps): ToolDefinition[] {
  const { store } = deps;
  return [
    {
      name: 'create_slate',
      description:
        'Create a slate: a document (markdown, html or csv) the app renders in its own tab beside the chat, instead of pasting the whole document into the transcript. Use it for reports, tables, dashboards and any document the user will read or keep. Returns the slate id and version; revise it with update_slate rather than creating a second slate.',
      mutating: true,
      group: 'slate',
      preview: (args) => ({
        requiresApproval: true,
        summary: `Create slate "${str(args, 'title') ?? ''}"`,
        reason: 'writes a new slate into .beecode/slates — one card per slate, later edits are free',
      }),
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short human-readable title, e.g. "Sales Q3". It also becomes the slate id.',
          },
          kind: {
            type: 'string',
            enum: [...SLATE_KINDS],
            description:
              'Document format, fixed for the life of the slate. Markdown may use ```chart fences; csv must be comma-separated with a header row.',
          },
          content: {
            type: 'string',
            description: 'The complete document, as it should be rendered. The limit is 512 KB per version.',
          },
          origins: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Only for html slates: the origins the document may call (e.g. "https://api.example.com"). A wildcard is never allowed.',
          },
        },
        required: ['title', 'kind', 'content'],
      },
      handler: async (args, ctx) => {
        try {
          const origins = Array.isArray(args.origins)
            ? args.origins.filter((origin): origin is string => typeof origin === 'string')
            : undefined;
          const meta = await store.create({
            cwd: ctx.cwd,
            sessionId: ctx.sessionId,
            title: requireStr(args, 'title'),
            kind: requireStr(args, 'kind'),
            content: requireStr(args, 'content'),
            origins,
          });
          return slateResult(meta, 'created');
        } catch (err) {
          return errorResult(message(err));
        }
      },
    },
    {
      name: 'update_slate',
      description:
        'Replace the content of an existing slate with a new version. Takes the whole document, not a diff: earlier versions stay on disk and are never overwritten.',
      mutating: true,
      group: 'slate',
      preview: (args) => ({
        requiresApproval: false,
        summary: `Update slate "${str(args, 'id') ?? ''}" (new version)`,
        reason: 'appends a version to a slate that was already approved; earlier versions stay on disk',
      }),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Slate id returned by create_slate, e.g. "sales-q3".' },
          content: { type: 'string', description: 'The complete new document.' },
        },
        required: ['id', 'content'],
      },
      handler: async (args, ctx) => {
        try {
          const meta = await store.update({
            cwd: ctx.cwd,
            sessionId: ctx.sessionId,
            id: requireStr(args, 'id'),
            content: requireStr(args, 'content'),
          });
          return slateResult(meta, 'updated');
        } catch (err) {
          return errorResult(message(err));
        }
      },
    },
    {
      name: 'promote_slate',
      description:
        'Write a slate into the workspace tree as a real file, for when the document should outlive the conversation. The slate keeps its history; the promoted copy is an ordinary file the user can commit.',
      mutating: true,
      group: 'slate',
      preview: (args, ctx) => {
        const target = resolve(ctx.cwd, requireStr(args, 'path'));
        const decision = deps.policy.evaluateFile(target, true, ctx.workspaceRoots);
        return {
          requiresApproval: true,
          summary: `Promote slate "${str(args, 'id') ?? ''}" to ${target}`,
          reason: decision.allowed
            ? 'the copy lands in the workspace tree, outside the slate folder'
            : decision.reason,
        };
      },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Slate id returned by create_slate or update_slate.' },
          path: {
            type: 'string',
            description: 'Target file path relative to the workspace root. Parent folders are created.',
          },
          version: { type: 'number', description: 'Version to write; defaults to the current one.' },
        },
        required: ['id', 'path'],
      },
      handler: async (args, ctx) => {
        try {
          const relative = requireStr(args, 'path');
          const decision = deps.policy.evaluateFile(resolve(ctx.cwd, relative), true, ctx.workspaceRoots);
          if (!decision.allowed) {
            return errorResult(`policy denies writing ${relative}: ${decision.reason}`);
          }
          const promoted = await deps.store.promote({
            cwd: ctx.cwd,
            sessionId: ctx.sessionId,
            id: requireStr(args, 'id'),
            path: relative,
            version: typeof args.version === 'number' ? args.version : undefined,
          });
          return jsonResult({
            action: 'promoted',
            path: promoted.path,
            version: promoted.version,
            note: 'The slate still exists; the promoted file is a copy the user can commit or keep editing.',
          });
        } catch (err) {
          return errorResult(message(err));
        }
      },
    },
  ];
}
