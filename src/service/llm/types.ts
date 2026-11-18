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

export function resolveApiKey(preset: ModelPreset): string | undefined {
  const envName = preset.apiKeyEnv ?? defaultKeyEnv(preset.provider);
  const value = envName ? process.env[envName] : undefined;
  if (value) return value;
  // Local providers legitimately run without a key.
  if (preset.provider === 'ollama' || preset.provider === 'openai-compatible') return undefined;
  throw new LlmError(
    `Missing API key: set ${envName} (provider "${preset.provider}", model "${preset.model}")`,
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
