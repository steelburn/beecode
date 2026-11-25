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
import {
  SLATE_SUBMIT_FIELD_TYPES,
  normaliseSlateSubmit,
  slateSubmitLabel,
} from '../../shared/slateSubmit';

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
  const submit = declaredSubmit(args);
  const parts: string[] = [];
  if (origins.length || submit) parts.push('live');
  if (origins.length) parts.push(`may call ${origins.join(', ')}`);
  if (submit) parts.push(slateSubmitLabel(submit));
  return parts.length ? `, ${parts.join(', ')}` : '';
}

function submitLabel(args: Record<string, unknown>): string {
  const submit = declaredSubmit(args);
  if (!submit) return '';
  return `, takes ${submit.fields.length} form field${submit.fields.length === 1 ? '' : 's'}`;
}

/** The declared form, or undefined — a schema that does not parse is not announced. */
function declaredSubmit(args: Record<string, unknown>) {
  try {
    return normaliseSlateSubmit(args.submit);
  } catch {
    return undefined;
  }
}

/**
 * The form a slate takes, described the same way on create and on update. It is the
 * contract the page posts against and the sink validates with, so it is spelled out
 * here rather than left to the document.
 */
const SUBMIT_SCHEMA = {
  type: 'object',
  description:
    'Only for html slates: the form this slate takes. The page posts it back to the same slate:// origin it was served from, and the app appends it to the slate sink, which you read with slate_submissions. Declaring it is what puts "may send form results" on the approval card.' +
    ' From the page: fetch(location.pathname + "/submit", { method: "POST", body: JSON.stringify({ submissionId: crypto.randomUUID(), fields }) }) and read the { ok, errors } answer. A native form action is blocked by CSP, so preventDefault and post from the submit handler.',
  properties: {
    note: {
      type: 'string',
      description: 'One line for the approval card, e.g. "Sends the weekly hours to the agent".',
    },
    fields: {
      type: 'array',
      description: 'At most 24 fields. `select` needs `options`; everything else is free text.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'The key the page posts back: lowercase letters, digits and _, starting with a letter.',
          },
          label: { type: 'string', description: 'Shown next to the input.' },
          type: {
            type: 'string',
            enum: [...SLATE_SUBMIT_FIELD_TYPES],
            description: 'Defaults to text.',
          },
          required: { type: 'boolean', description: 'Reject the submission when it is empty.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'select only: the accepted values.',
          },
          maxLength: { type: 'number', description: 'text and textarea only.' },
        },
        required: ['name'],
      },
    },
  },
  required: ['fields'],
};

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
          submit: SUBMIT_SCHEMA,
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
            submit: args.submit,
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
        summary: `Update slate "${str(args, 'id') ?? ''}" (new version)${submitLabel(args)}`,
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
          submit: {
            ...SUBMIT_SCHEMA,
            description:
              'The form the new version takes. Omit it to carry the previous form forward (revise the body, keep the inputs); pass null to withdraw it; send a schema to replace it.',
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
            submit: args.submit,
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
    {
      name: 'slate_submissions',
      description:
        'Read what was submitted through a slate form. A live html slate that declared a submit schema posts its form back to the app, and the entries land in an append-only sink in the slate folder — nothing else about the slate changes. Returns them oldest first; pass since to read only the new ones.',
      mutating: false,
      group: 'slate',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Slate id returned by create_slate.' },
          since: {
            type: 'number',
            description: 'Return only submissions after this n (1-based); omit for all of them.',
          },
        },
        required: ['id'],
      },
      handler: async (args, ctx) => {
        try {
          const submissions = await store.submissions({
            cwd: ctx.cwd,
            sessionId: ctx.sessionId,
            id: requireStr(args, 'id'),
            since: typeof args.since === 'number' ? args.since : undefined,
          });
          if (!submissions.length) {
            return jsonResult({
              submissions,
              note:
                'Nothing submitted yet. A form only posts while the slate is live and on screen, and only when it declared a submit schema.',
            });
          }
          return jsonResult({
            submissions,
            note:
              'Oldest first. Act on them, then answer in chat or update_slate with the outcome; the sink is append-only.',
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
