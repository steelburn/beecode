/**
 * A recipe records what a slate version was **built from** — references only, never a
 * payload. Storing the fetched bytes beside the version would double the slate's own
 * storage and collide with its caps, so a refresh re-reads the sources instead: the
 * document is regenerated, not replayed byte for byte.
 *
 * It lives on the version, not the slate, because v3 may be built from different data
 * than v2. A version is immutable, so replay always writes a **new** version.
 *
 * A recorded step is untrusted input at replay time. Nothing here executes anything: this
 * module only validates the shape and classifies the step, so the layer that replays a
 * recipe can re-authorise it through the policy engine first.
 */

/** One recorded read that a version was built from. */
export interface SlateRecipeStep {
  /** Tool that re-runs the step, e.g. `fs_read`. */
  tool: string;
  /** Arguments as recorded. Re-authorised at replay, never trusted as-is. */
  args: Record<string, string>;
  /** ISO time the step was recorded, when the caller provided one. */
  at?: string;
}

/**
 * Steps one recipe may hold. A recipe is a reading list, not a traversal: past a dozen
 * sources the document is a query result, and the agent should write a script for it.
 */
export const SLATE_RECIPE_MAX_STEPS = 12;

/** Keys one step's args may hold, and the longest single value. */
export const SLATE_RECIPE_MAX_ARGS = 20;
const MAX_ARG_LENGTH = 1024;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const ARG_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

/** What replaying a step means — and therefore how it is authorised. */
export type SlateRecipeStepKind = 'read' | 'network' | 'write' | 'other';

const READ_TOOLS = new Set(['fs_read', 'fs_list', 'knowledge_read', 'slate_read']);
const NETWORK_TOOLS = new Set([
  'fetch',
  'http_request',
  'web_fetch',
  'web_search',
  'browser_fetch',
]);
/**
 * Tools that change something. A recipe that replays a write is not a record of sources —
 * and replaying it would edit the workspace on the strength of an old approval.
 */
const WRITE_TOOLS = new Set([
  'shell',
  'fs_write',
  'fs_edit',
  'fs_remove',
  'create_slate',
  'update_slate',
  'promote_slate',
  'refresh_slate',
  'apply_patch',
]);

export function recipeStepKind(tool: string): SlateRecipeStepKind {
  const name = tool.trim();
  if (READ_TOOLS.has(name)) return 'read';
  if (NETWORK_TOOLS.has(name)) return 'network';
  if (WRITE_TOOLS.has(name)) return 'write';
  return 'other';
}

/** The address a network step reads, when it names one. Used for the origin check. */
export function recipeStepUrl(step: SlateRecipeStep): string | undefined {
  for (const key of ['url', 'uri', 'href']) {
    const value = step.args[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The path a read step reads, when it names one. Used for the policy check. */
export function recipeStepPath(step: SlateRecipeStep): string | undefined {
  for (const key of ['path', 'file', 'cwd']) {
    const value = step.args[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const scalar = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
};

/**
 * Validates a proposed recipe and returns the normalised steps.
 *
 * Refusals name the entry, because the caller is a model that can fix the argument:
 * `recipe step 2 replays "shell", which writes — record the read instead`. Nothing is
 * ever dropped silently: a step the caller meant to record is either kept or the whole
 * recipe is refused, so a version never claims sources it was not built from.
 */
export function normaliseSlateRecipe(input: unknown): SlateRecipeStep[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new Error('recipe must be an array of { tool, args } steps, or omitted');
  }
  if (input.length > SLATE_RECIPE_MAX_STEPS) {
    throw new Error(
      `recipe has ${input.length} steps — the limit is ${SLATE_RECIPE_MAX_STEPS}; a recipe is a reading list, not a traversal`,
    );
  }

  const steps: SlateRecipeStep[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of input.entries()) {
    const where = `recipe step ${index + 1}`;
    if (!isPlainObject(raw)) throw new Error(`${where} must be an object with a "tool" name`);
    const tool = raw.tool;
    if (typeof tool !== 'string' || !TOOL_NAME.test(tool.trim())) {
      throw new Error(`${where} needs a tool name like "fs_read"`);
    }
    const name = tool.trim();
    const kind = recipeStepKind(name);
    if (kind === 'write') {
      throw new Error(
        `${where} replays "${name}", which writes — a recipe records the sources a version was built from, not the actions; record the read that fed the document instead`,
      );
    }

    const args: Record<string, string> = {};
    if (raw.args !== undefined && raw.args !== null) {
      if (!isPlainObject(raw.args)) throw new Error(`${where} args must be a flat object`);
      const keys = Object.keys(raw.args);
      if (keys.length > SLATE_RECIPE_MAX_ARGS) {
        throw new Error(
          `${where} has ${keys.length} args — the limit is ${SLATE_RECIPE_MAX_ARGS}`,
        );
      }
      for (const key of keys) {
        if (!ARG_NAME.test(key)) throw new Error(`${where} has an invalid arg name "${key}"`);
        const value = scalar(raw.args[key]);
        if (value === undefined) {
          throw new Error(
            `${where} arg "${key}" must be a string, number or boolean — a recipe stores references, not payloads`,
          );
        }
        if (value.length > MAX_ARG_LENGTH) {
          throw new Error(`${where} arg "${key}" is longer than ${MAX_ARG_LENGTH} characters`);
        }
        args[key] = value;
      }
    }

    if (kind === 'network' && !recipeStepUrl({ tool: name, args })) {
      throw new Error(`${where} replays "${name}" but names no url`);
    }

    const at = scalar(raw.at)?.trim();
    const step: SlateRecipeStep = { tool: name, args };
    if (at) step.at = at;

    // Two identical reads are one source; keeping both would inflate the list without
    // recording anything the version was actually built from twice.
    const key = `${name}\u0000${JSON.stringify(args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(step);
  }

  return steps;
}
