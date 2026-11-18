import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelPreset } from '../../shared/protocol';

/**
 * A `.env.llm` file lets the user point beeCode at any OpenAI-compatible endpoint without
 * editing `config.json`:
 *
 * ```
 * API_KEY=sk-...
 * URL=https://api.example.dev/v1
 * MODEL=my-model
 * ```
 *
 * The key is never copied into config (that file is plain user state and is written back to
 * disk); it is published to the process environment under a dedicated variable name and the
 * preset only references that name through `apiKeyEnv`. config.json therefore stays
 * shareable and the renderer never receives the secret.
 */

export const ENV_PRESET_ID = 'env-llm';
/** Environment variable the parsed key is published under. */
export const ENV_PRESET_KEY_ENV = 'BEECODE_LLM_API_KEY';
export const ENV_FILE_NAME = '.env.llm';
/** Overrides the search path entirely (tests, and users who keep the file elsewhere). */
export const ENV_FILE_OVERRIDE = 'BEECODE_LLM_ENV_FILE';

export interface EnvPresetResult {
  preset?: ModelPreset;
  /** Absolute path of the file the preset came from. */
  source?: string;
  warnings: string[];
}

/** Strips a matching pair of surrounding quotes and a trailing ` # comment`. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1);
    }
  }
  const comment = trimmed.search(/\s#/);
  return comment >= 0 ? trimmed.slice(0, comment).trim() : trimmed;
}

/**
 * Minimal dotenv parser: `KEY=value`, optional `export` prefix, `#` comments, quoted values.
 * Deliberately not a general dotenv implementation — it only needs to survive the handful of
 * lines this file contains, and must never throw on a malformed one.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquote(body.slice(eq + 1));
  }
  return out;
}

export function envFileCandidates(cwd = process.cwd()): string[] {
  const override = process.env[ENV_FILE_OVERRIDE];
  if (override) return [resolve(override)];
  return [resolve(cwd, ENV_FILE_NAME), join(homedir(), '.beecode', ENV_FILE_NAME)];
}

function firstOf(vars: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = vars[key];
    if (value) return value;
  }
  return undefined;
}

/** Builds the preset from already-parsed variables. Pure, so tests need no filesystem. */
export function buildEnvPreset(vars: Record<string, string>): EnvPresetResult {
  const warnings: string[] = [];
  const baseUrl = firstOf(vars, ['URL', 'BASE_URL', 'OPENAI_BASE_URL', 'ENDPOINT']);
  const apiKey = firstOf(vars, ['API_KEY', 'KEY', 'TOKEN', 'OPENAI_API_KEY']);
  const model = firstOf(vars, ['MODEL', 'MODEL_ID']) ?? vars.MODELS?.split(',')[0]?.trim();

  if (!baseUrl) return { warnings: ['no URL= in .env.llm'] };
  if (!model) return { warnings: [`no MODEL= in .env.llm for ${baseUrl}`] };

  let host = baseUrl;
  try {
    host = new URL(baseUrl).host || baseUrl;
  } catch {
    warnings.push(`URL ${baseUrl} is not a valid absolute URL`);
  }
  if (!apiKey) warnings.push('no API_KEY= in .env.llm — the endpoint will be called unauthenticated');

  return {
    warnings,
    preset: {
      id: ENV_PRESET_ID,
      label: `Custom endpoint (${host})`,
      provider: 'openai-compatible',
      model,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKeyEnv: ENV_PRESET_KEY_ENV,
      // Conservative ceilings: an unknown endpoint may reject a large max_tokens, and the
      // capability flags decide whether screenshots are attached to requests at all.
      contextWindow: Number(vars.CONTEXT_WINDOW) > 0 ? Number(vars.CONTEXT_WINDOW) : 128_000,
      supportsVision: vars.SUPPORTS_VISION === '1' || vars.SUPPORTS_VISION === 'true',
      supportsTools: vars.SUPPORTS_TOOLS !== '0' && vars.SUPPORTS_TOOLS !== 'false',
    },
  };
}

/**
 * Reads the first candidate file that exists and publishes its key into the environment.
 * Returns `{ warnings: [] }` and no preset when there is no file at all — the caller then
 * keeps its built-in presets.
 */
export function loadEnvPreset(cwd = process.cwd()): EnvPresetResult {
  for (const file of envFileCandidates(cwd)) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      return { warnings: [`could not read ${file}: ${(err as Error).message}`] };
    }
    const vars = parseEnvFile(text);
    const result = buildEnvPreset(vars);
    if (!result.preset) return { ...result, source: file };
    const apiKey = firstOf(vars, ['API_KEY', 'KEY', 'TOKEN', 'OPENAI_API_KEY']);
    if (apiKey) process.env[ENV_PRESET_KEY_ENV] = apiKey;
    return { ...result, source: file };
  }
  return { warnings: [] };
}
