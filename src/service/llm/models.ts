import type { ModelPreset, ProviderId } from '../../shared/protocol';
import { normalizeBaseUrl, resolveApiKey } from './types';

export interface ModelListInput {
  /** Preset being edited, so a key already stored in secrets.json is used. */
  presetId?: string;
  provider?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Key typed into Settings but not saved yet — wins over the stored one. */
  apiKey?: string;
}

export interface ModelListResult {
  models: string[];
  /** Set when no endpoint answered; `models` is then empty and the picker keeps its value. */
  warning?: string;
}

const PROBE_TIMEOUT_MS = 8000;

/**
 * Read the model ids an endpoint advertises, for the Settings model dropdown.
 *
 * Deliberately never throws: Settings calls this while the user is still typing a base URL or a
 * key, so an unreachable endpoint or a rejected key has to come back as a `warning` instead of
 * an error the panel would have to catch. Key resolution follows the normal either/or order
 * (draft key → stored key → env var → keyless), which is what lets a local endpoint be probed
 * without any credentials at all.
 */
export async function listModels(input: ModelListInput): Promise<ModelListResult> {
  const preset: ModelPreset = {
    id: input.presetId || 'probe',
    label: 'probe',
    provider: toProvider(input.provider),
    model: '',
    baseUrl: input.baseUrl?.trim() || undefined,
    apiKeyEnv: input.apiKeyEnv?.trim() || undefined,
  };
  const key = input.apiKey?.trim() || probeKey(preset);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key) {
    if (preset.provider === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    } else if (preset.provider === 'azure-openai') {
      headers['api-key'] = key;
    } else {
      headers.authorization = `Bearer ${key}`;
    }
  }

  const failures: string[] = [];
  for (const url of candidates(preset)) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!response.ok) {
        failures.push(`${url} returned HTTP ${response.status}`);
        continue;
      }
      const models = modelIds(await response.json());
      if (models.length) return { models };
      failures.push(`${url} listed no models`);
    } catch (error) {
      failures.push(`${url}: ${(error as Error).message}`);
    }
  }
  return {
    models: [],
    warning: failures.length ? `no model list — ${failures.join('; ')}` : 'no endpoint to probe',
  };
}

/** Narrow an untrusted RPC string to a known provider id. */
function toProvider(value: string | undefined): ProviderId {
  switch (value) {
    case 'openai':
    case 'anthropic':
    case 'azure-openai':
    case 'ollama':
      return value;
    default:
      return 'openai-compatible';
  }
}

/** Key lookup that treats "no key configured" as an empty key instead of an error. */
function probeKey(preset: ModelPreset): string | undefined {
  try {
    return resolveApiKey(preset);
  } catch {
    return undefined;
  }
}

function candidates(preset: ModelPreset): string[] {
  const base = normalizeBaseUrl(preset);
  switch (preset.provider) {
    case 'anthropic':
      return [`${base}/models`];
    case 'azure-openai':
      // Azure lists deployments rather than models and requires an api-version.
      return [`${base}/models?api-version=2024-02-01`];
    case 'ollama':
      // Native tag list first (works on every Ollama build), then the OpenAI-compatible one.
      return [`${base.replace(/\/v1$/, '')}/api/tags`, `${base}/models`];
    default:
      return [`${base}/models`];
  }
}

/**
 * Pull ids out of the response shapes seen in the wild: `{ data: [{ id }] }` (OpenAI,
 * Anthropic, most gateways), `{ models: [{ name }] }` (Ollama) or a bare array.
 */
function modelIds(payload: unknown): string[] {
  const container = isRecord(payload) ? payload : {};
  const rows = Array.isArray(payload)
    ? payload
    : arrayOf(container.data) ?? arrayOf(container.models) ?? [];
  const ids: string[] = [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row : readId(row);
    if (id) ids.push(id);
  }
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function readId(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  for (const field of ['id', 'name', 'model', 'model_name']) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function arrayOf(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
