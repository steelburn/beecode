import type { LlmChunk, LlmMessage, LlmRequest, LlmToolSchema } from './types';
import { LlmError, normalizeBaseUrl, resolveApiKey } from './types';

/**
 * Streaming chat client for both wire formats beeCode supports:
 *  - OpenAI `/chat/completions` (also covers Azure OpenAI, Ollama, LM Studio, OpenRouter)
 *  - Anthropic `/messages`
 *
 * Deliberately dependency-free: `fetch` + a small SSE reader. Yields normalised
 * chunks so the agent loop never has to know which provider produced them.
 */
export async function* streamChat(req: LlmRequest): AsyncGenerator<LlmChunk> {
  if (req.preset.provider === 'anthropic') {
    yield* streamAnthropic(req);
  } else {
    yield* streamOpenAi(req);
  }
}

/* --------------------------------------------------------------------- OpenAI */

async function* streamOpenAi(req: LlmRequest): AsyncGenerator<LlmChunk> {
  const base = normalizeBaseUrl(req.preset);
  const key = resolveApiKey(req.preset);
  const body = {
    model: req.preset.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAiMessages(req.messages),
    tools: req.tools.length ? req.tools.map(toOpenAiTool) : undefined,
    tool_choice: req.tools.length ? 'auto' : undefined,
    temperature: req.temperature ?? 0.2,
    max_tokens: req.maxTokens,
  };

  const res = await post(`${base}/chat/completions`, body, req.signal, {
    'content-type': 'application/json',
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    // Azure OpenAI accepts api-key instead of a bearer token.
    ...(req.preset.provider === 'azure-openai' && key ? { 'api-key': key } : {}),
  });

  const pending: Array<{ id: string; name: string; args: string }> = [];

  for await (const data of sseLines(res, req.signal)) {
    if (data === '[DONE]') break;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed.error) throw new LlmError(String(parsed.error.message ?? parsed.error), 500);

    const choice = parsed.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) {
      const text = Array.isArray(delta.content)
        ? delta.content.map((c: any) => c?.text ?? '').join('')
        : String(delta.content);
      if (text) yield { type: 'text', text };
    }
    if (delta?.reasoning_content || delta?.reasoning) {
      yield { type: 'reasoning', text: String(delta.reasoning_content ?? delta.reasoning) };
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = Number(tc.index ?? 0);
        pending[index] ??= { id: tc.id ?? `call_${index}`, name: '', args: '' };
        const slot = pending[index]!;
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }
    if (parsed.usage) {
      yield {
        type: 'usage',
        inputTokens: Number(parsed.usage.prompt_tokens ?? 0),
        outputTokens: Number(parsed.usage.completion_tokens ?? 0),
      };
    }
    if (choice?.finish_reason) {
      for (const call of pending) {
        if (!call || !call.name) continue;
        yield { type: 'tool-call', call: { id: call.id, name: call.name, args: parseArgs(call.args) } };
      }
      pending.length = 0;
    }
  }
}

function toOpenAiMessages(messages: LlmMessage[]) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
      }
      return out;
    }
    if (m.images?.length) {
      const parts: unknown[] = [{ type: 'text', text: m.content }];
      for (const img of m.images) {
        parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
      }
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAiTool(tool: LlmToolSchema) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

/* ------------------------------------------------------------------ Anthropic */

async function* streamAnthropic(req: LlmRequest): AsyncGenerator<LlmChunk> {
  const base = normalizeBaseUrl(req.preset);
  const key = resolveApiKey(req.preset);
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const body = {
    model: req.preset.model,
    max_tokens: req.maxTokens ?? 8192,
    stream: true,
    system: system || undefined,
    messages: toAnthropicMessages(req.messages),
    tools: req.tools.length
      ? req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }))
      : undefined,
    temperature: req.temperature ?? 0.2,
  };

  const res = await post(`${base}/messages`, body, req.signal, {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(key ? { 'x-api-key': key } : {}),
  });

  let currentTool: { id: string; name: string; json: string } | undefined;

  for await (const data of sseLines(res, req.signal)) {
    if (data === '[DONE]') break;
    let evt: any;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    if (evt.type === 'error') throw new LlmError(String(evt.error?.message ?? 'anthropic error'), 500);

    if (evt.type === 'content_block_start') {
      const block = evt.content_block;
      if (block?.type === 'tool_use') currentTool = { id: block.id, name: block.name, json: '' };
      if (block?.type === 'text' && block.text) yield { type: 'text', text: block.text };
    } else if (evt.type === 'content_block_delta') {
      const d = evt.delta;
      if (d?.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
      if (d?.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking };
      if (d?.type === 'input_json_delta' && currentTool) currentTool.json += d.partial_json ?? '';
    } else if (evt.type === 'content_block_stop') {
      if (currentTool) {
        yield {
          type: 'tool-call',
          call: { id: currentTool.id, name: currentTool.name, args: parseArgs(currentTool.json) },
        };
        currentTool = undefined;
      }
    } else if (evt.type === 'message_delta' && evt.usage) {
      yield {
        type: 'usage',
        inputTokens: Number(evt.usage.input_tokens ?? 0),
        outputTokens: Number(evt.usage.output_tokens ?? 0),
      };
    }
  }
}

function toAnthropicMessages(messages: LlmMessage[]) {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];

  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
      if (blocks.length) pushMerged(out, 'assistant', blocks);
      continue;
    }
    if (m.role === 'tool') {
      pushMerged(out, 'user', [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content || '(empty)',
          is_error: m.toolFailed === true,
        },
      ]);
      continue;
    }
    // user
    const blocks: unknown[] = [{ type: 'text', text: m.content }];
    for (const img of m.images ?? []) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
    }
    pushMerged(out, 'user', blocks);
  }
  return out;
}

function pushMerged(
  out: Array<{ role: 'user' | 'assistant'; content: unknown[] }>,
  role: 'user' | 'assistant',
  blocks: unknown[],
): void {
  const last = out[out.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else out.push({ role, content: blocks });
}

/* -------------------------------------------------------------------- helpers */

async function post(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  headers: Record<string, string>,
): Promise<Response> {
  const payload = JSON.stringify(body);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: payload, signal });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      if (res.status === 429 || res.status >= 500) {
        lastError = new LlmError(`${res.status} from ${url}: ${text.slice(0, 400)}`, res.status);
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new LlmError(`${res.status} from ${url}: ${text.slice(0, 800)}`, res.status);
    } catch (err) {
      if (err instanceof LlmError && err.status && err.status < 500) throw err;
      if ((err as Error).name === 'AbortError') throw err;
      lastError = err as Error;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastError ?? new LlmError(`request to ${url} failed`);
}

async function* sseLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) throw new LlmError('response has no body to stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
        idx = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock?.();
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __raw: raw };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
