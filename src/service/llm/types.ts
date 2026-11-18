import type { ModelPreset } from '../../shared/protocol';

export interface LlmImage {
  mime: string;
  /** base64 payload without the data: prefix. */
  data: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant tool requests. */
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** Set on role: 'tool'. */
  toolCallId?: string;
  toolName?: string;
  toolFailed?: boolean;
  images?: LlmImage[];
}

export interface LlmToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  preset: ModelPreset;
  messages: LlmMessage[];
  tools: LlmToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type LlmChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; call: { id: string; name: string; args: Record<string, unknown> } }
  | { type: 'usage'; inputTokens: number; outputTokens: number };

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

let secretResolver: ((preset: ModelPreset) => string | undefined) | undefined;

/**
 * Installed by the service so a key stored in secrets.json is found without ever putting
 * that key into the config object (and therefore into config.json).
 */
export function setSecretResolver(fn: ((preset: ModelPreset) => string | undefined) | undefined): void {
  secretResolver = fn;
}

/** True for a loopback endpoint, where running without a key is legitimate (Ollama, LM Studio). */
function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local');
  } catch {
    return false;
  }
}

export function resolveApiKey(preset: ModelPreset): string | undefined {
  const stored = secretResolver?.(preset);
  if (stored) return stored;
  const envName = preset.apiKeyEnv ?? defaultKeyEnv(preset.provider);
  const value = envName ? process.env[envName] : undefined;
  if (value) return value;
  // A local endpoint may run keyless; a remote one never does. Calling it unauthenticated
  // used to surface as a bare 401 from the server instead of an actionable error here.
  if (preset.provider === 'ollama' || (preset.provider === 'openai-compatible' && isLocalEndpoint(preset.baseUrl))) {
    return undefined;
  }
  throw new LlmError(
    `Missing API key for "${preset.label}" (${preset.provider}, model "${preset.model}"): ` +
      (envName ? `paste it in Settings › Models, set ${envName}, or add API_KEY to .env.llm` : 'paste it in Settings › Models'),
  );
}

function defaultKeyEnv(provider: ModelPreset['provider']): string | undefined {
  switch (provider) {
    case 'openai':
    case 'azure-openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    default:
      return undefined;
  }
}

/** Normalise a base URL: strip trailing slash, add the version segment when missing. */
export function normalizeBaseUrl(preset: ModelPreset): string {
  const raw =
    preset.baseUrl ??
    (preset.provider === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : preset.provider === 'openai' || preset.provider === 'azure-openai'
        ? 'https://api.openai.com/v1'
        : 'http://127.0.0.1:11434/v1');
  return raw.replace(/\/+$/, '');
}
