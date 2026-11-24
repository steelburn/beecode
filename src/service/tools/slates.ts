import { resolve } from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '../../shared/tools';
import type { PolicyEngine } from '../policy';
import { SLATE_KINDS, type SlateMeta, type SlateStore } from '../slates';
import { isSlateOriginAllowed } from '../../shared/slateSandbox';
import {
  normaliseSlateRecipe,
  recipeStepKind,
  recipeStepPath,
  recipeStepUrl,
  type SlateRecipeStep,
} from '../../shared/slateRecipe';
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

/**
 * The origins a create asks to call, spelled out on the approval card. A live slate is a
 * network-capable document, so the one place that permission can be granted is the card the
 * user actually reads — it is not something to discover later in the gallery.
 */
function liveLabel(args: Record<string, unknown>): string {
  const origins = Array.isArray(args.origins) ? args.origins.map((o) => String(o)) : [];
  return origins.length ? `, live, may call ${origins.join(', ')}` : '';
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
        summary: `Create slate "${str(args, 'title') ?? ''}"${liveLabel(args)}`,
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
            description: 'The complete document, as it should be rendered. The limit is 2 MB per version.',
          },
          origins: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Only for html slates: the origins the document may call (e.g. "https://api.example.com"). A wildcard is never allowed.',
          },
          recipe: {
            type: 'array',
            description:
              'What the document was built from, as references only: [{ tool: "fs_read", args: { path: "data/sales.csv" } }]. Never the data itself — refresh_slate replays the references, it does not store a copy.',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                args: { type: 'object' },
                at: { type: 'string' },
              },
              required: ['tool'],
            },
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
          const attached = await attachRecipe(store, ctx, meta.id, normaliseSlateRecipe(args.recipe));
          if (attached.error) {
            return errorResult(
              `slate "${meta.id}" was created, but its recipe was not recorded: ${attached.error}`,
            );
          }
          return slateResult(attached.meta ?? meta, 'created');
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
          recipe: {
            type: 'array',
            description:
              'What the new version was built from, as references only. Carry the recipe forward when refreshing a slate, so every version names the same sources.',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                args: { type: 'object' },
                at: { type: 'string' },
              },
              required: ['tool'],
            },
          },
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
          const attached = await attachRecipe(store, ctx, meta.id, normaliseSlateRecipe(args.recipe));
          if (attached.error) {
            return errorResult(
              `slate "${meta.id}" v${meta.current} was written, but its recipe was not recorded: ${attached.error}`,
            );
          }
          return slateResult(attached.meta ?? meta, 'updated');
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
    {
      name: 'refresh_slate',
      description:
        'Re-authorise the recipe of a slate version and hand it back for replay. Writes nothing and fetches nothing: it returns the recorded steps, each re-checked against the current policy and the slate allowlist, so you can re-read the sources and then call update_slate with the same recipe. Replay writes a new version; it never edits the old one.',
      mutating: false,
      group: 'slate',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Slate id returned by create_slate or update_slate, e.g. "sales-q3".',
          },
          version: {
            type: 'number',
            description: 'Version whose recipe to replay. Defaults to the current version.',
          },
        },
        required: ['id'],
      },
      handler: async (args, ctx) => {
        try {
          const id = requireStr(args, 'id');
          const meta = await store.meta({ cwd: ctx.cwd, sessionId: ctx.sessionId, id });
          const n = typeof args.version === 'number' ? args.version : meta.current;
          const version = meta.versions.find((candidate) => candidate.n === n);
          if (!version) throw new Error(`slate "${meta.id}" has no version ${n}`);
          const recipe = version.recipe ?? [];
          if (!recipe.length) {
            throw new Error(
              `slate "${meta.id}" v${n} records no recipe, so there is nothing to replay — read the sources and call update_slate with a recipe to make it refreshable`,
            );
          }

          // Every step is untrusted here: it was recorded in an earlier session and both
          // the policy and the allowlist may have tightened since. One denial refuses the
          // whole refresh, because replaying a subset would rebuild the document from
          // half of its sources and say nothing about the rest.
          const steps = recipe.map((step, index) => {
            const where = `recipe step ${index + 1} ("${step.tool}")`;
            const kind = recipeStepKind(step.tool);
            if (kind === 'write') {
              throw new Error(
                `${where} replays a write; a recipe records the sources a version was built from`,
              );
            }
            if (kind === 'read') {
              const relative = recipeStepPath(step);
              if (!relative) return { tool: step.tool, kind, allowed: true };
              const target = resolve(ctx.cwd, relative);
              const decision = deps.policy.evaluateFile(target, false, ctx.workspaceRoots ?? []);
              if (!decision.allowed) {
                throw new Error(
                  `${where} reads ${relative}, which the policy now denies: ${decision.reason}`,
                );
              }
              return { tool: step.tool, kind, target: relative, allowed: true };
            }
            if (kind === 'network') {
              const url = recipeStepUrl(step);
              if (!url) throw new Error(`${where} names no url`);
              const origin = originOf(url);
              if (!origin) throw new Error(`${where} has an unreadable url: ${url}`);
              if (meta.origins?.length && !isSlateOriginAllowed(origin, meta.origins)) {
                throw new Error(
                  `${where} reads ${origin}, which is not on this slate's allowlist (${meta.origins.join(', ')}) — grant it from the gallery first`,
                );
              }
              return { tool: step.tool, kind, target: origin, allowed: true };
            }
            return { tool: step.tool, kind, allowed: true };
          });

          return jsonResult({
            action: 'refresh',
            id: meta.id,
            version: n,
            steps,
            recipe,
            note:
              'Replay these steps yourself, then call update_slate with the same recipe and the rebuilt document. Replay appends v' +
              (meta.versions.length + 1) +
              '; it does not edit the version it came from.',
          });
        } catch (err) {
          return errorResult(message(err));
        }
      },
    },
  ];
}

/**
 * Records a proposed recipe on the version that was just written.
 *
 * A refused recipe never turns a successful write into a reported failure: the document is
 * the artefact and it is already on disk, so the caller gets the slate back either way and
 * only the provenance is missing — which the result says out loud.
 */
async function attachRecipe(
  store: SlateStore,
  ctx: Pick<ToolContext, 'cwd' | 'sessionId'>,
  id: string,
  recipe: SlateRecipeStep[],
): Promise<{ meta?: SlateMeta; error?: string }> {
  if (!recipe.length) return {};
  try {
    return { meta: await store.recordRecipe({ cwd: ctx.cwd, sessionId: ctx.sessionId, id, recipe }) };
  } catch (err) {
    return { error: message(err) };
  }
}

/** Origin of an http(s) url, or undefined when it is neither readable nor http(s). */
function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}
