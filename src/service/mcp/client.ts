import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerConfig } from '../../shared/protocol';
import type { Logger } from '../logger';
import { serviceVersion } from '../version';

/** Protocol revision this client implements. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOOL_PAGES = 20;

export interface McpToolDescriptor {
  /** Tool name exactly as the server publishes it. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `annotations.readOnlyHint` — read-only tools skip the approval gate. */
  readOnly: boolean;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

interface McpToolPage {
  tools?: Array<{
    name?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }>;
  nextCursor?: string;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal MCP client: `initialize` → `tools/list` → `tools/call`.
 *
 * Two transports, both from the 2024-11-05 spec:
 *   stdio — newline-delimited JSON-RPC over the child's stdin/stdout
 *   http  — streamable HTTP (a POST that answers with JSON or an SSE stream)
 */
export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private sessionId?: string;
  private closed = false;
  private listChanged = false;

  /** Identity reported by the server during `initialize`. */
  info = { name: '', version: '', protocolVersion: '' };

  constructor(
    readonly server: string,
    private readonly config: McpServerConfig,
    private readonly log: Logger,
  ) {}

  /** True once the server announced `notifications/tools/list_changed`. */
  get toolsChanged(): boolean {
    return this.listChanged;
  }

  async connect(): Promise<void> {
    if (this.transport === 'stdio') this.startStdio();
    await this.initialize();
  }

  async initialize(): Promise<void> {
    const result = await this.request<{
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    }>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'beecode', version: serviceVersion() },
    });

    this.info = {
      name: result?.serverInfo?.name || this.server,
      version: result?.serverInfo?.version ?? '',
      protocolVersion: result?.protocolVersion ?? MCP_PROTOCOL_VERSION,
    };
    await this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.request<McpToolPage>('tools/list', cursor ? { cursor } : {});
      for (const raw of result?.tools ?? []) {
        const name = (raw.name ?? '').trim();
        if (!name) continue;
        tools.push({
          name,
          description: (raw.description ?? '').trim() || `MCP tool "${name}" from ${this.server}`,
          inputSchema: raw.inputSchema ?? { type: 'object', properties: {} },
          // Anything not explicitly marked read-only goes through the approval gate.
          readOnly: raw.annotations?.readOnlyHint === true,
        });
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    this.listChanged = false;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const result = await this.request<{
      content?: unknown[];
      structuredContent?: unknown;
      isError?: boolean;
    }>('tools/call', { name, arguments: args ?? {} }, signal);
    return { text: flattenContent(result), isError: result?.isError === true };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error('mcp client closed'));
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // Already gone.
    }
  }

  /* --------------------------------------------------------------- transport */

  private get transport(): 'stdio' | 'http' {
    return this.config.transport === 'http' ? 'http' : 'stdio';
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs && this.config.timeoutMs > 0 ? this.config.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  private startStdio(): void {
    const command = (this.config.command ?? '').trim();
    if (!command) throw new Error('stdio MCP server needs a "command"');

    const child = spawn(command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.on('error', (err) => this.failAll(new Error(`failed to start "${command}": ${err.message}`)));
    child.on('exit', (code, signal) => {
      if (this.closed) return;
      this.failAll(new Error(`server exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`));
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (text) this.log.warn(`mcp ${this.server} stderr: ${text}`);
      }
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const index = this.stdoutBuffer.indexOf('\n');
      if (index < 0) break;
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.log.warn(`mcp ${this.server} sent a non-JSON line`, { line: line.slice(0, 200) });
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if (!message || typeof message !== 'object') return;

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === 'notifications/tools/list_changed') {
      this.listChanged = true;
      return;
    }
    if (message.method) {
      this.log.info(`mcp ${this.server} notification: ${message.method}`);
    }
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('not connected');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    const id = this.nextId;
    this.nextId += 1;
    if (this.transport === 'http') return this.requestHttp<T>(id, method, params, signal);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`"${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (this.transport === 'stdio') {
      this.write({ jsonrpc: '2.0', method, params });
      return;
    }
    // HTTP: a notification is an id-less POST that answers 202 with no body.
    try {
      const response = await fetch(this.httpUrl(), {
        method: 'POST',
        headers: this.httpHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      });
      this.captureSession(response);
    } catch (err) {
      this.log.warn(`mcp ${this.server}: notification ${method} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async requestHttp<T>(id: number, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`"${method}" timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    timer.unref?.();
    const forwardAbort = () => controller.abort(new Error('aborted'));
    signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const response = await fetch(this.httpUrl(), {
        method: 'POST',
        headers: this.httpHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      this.captureSession(response);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());

      const body = await response.text();
      const messages = parseMessages(response.headers.get('content-type') ?? '', body);
      for (const message of messages) {
        if (message.id === undefined) this.dispatch(message);
      }
      const answer = messages.find((message) => Number(message.id) === id);
      if (!answer) throw new Error(`no response to "${method}"`);
      if (answer.error) throw new Error(`${answer.error.message} (code ${answer.error.code})`);
      return answer.result as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private httpUrl(): string {
    const url = (this.config.url ?? '').trim();
    if (!url) throw new Error('http MCP server needs a "url"');
    return url;
  }

  private httpHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.config.headers ?? {}),
    };
  }

  private captureSession(response: Response): void {
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

/** A `tools/call` result is a content block array; the model gets plain text. */
function flattenContent(result: { content?: unknown[]; structuredContent?: unknown } | undefined): string {
  const parts: string[] = [];
  for (const item of result?.content ?? []) {
    if (!item || typeof item !== 'object') {
      parts.push(String(item));
      continue;
    }
    const block = item as Record<string, unknown>;
    switch (block.type) {
      case 'text':
        parts.push(String(block.text ?? ''));
        break;
      case 'image':
        parts.push(`[image ${String(block.mimeType ?? 'image')} omitted]`);
        break;
      case 'audio':
        parts.push(`[audio ${String(block.mimeType ?? 'audio')} omitted]`);
        break;
      case 'resource': {
        const resource = (block.resource ?? {}) as Record<string, unknown>;
        parts.push(
          typeof resource.text === 'string'
            ? resource.text
            : `[resource ${String(resource.uri ?? 'unknown')}]`,
        );
        break;
      }
      case 'resource_link':
        parts.push(`[resource ${String(block.uri ?? 'unknown')}]`);
        break;
      default:
        parts.push(JSON.stringify(block));
    }
  }
  if (!parts.length && result?.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join('\n').trim();
}

/** Accepts plain JSON, an SSE stream, or newline-delimited JSON. */
function parseMessages(contentType: string, body: string): JsonRpcMessage[] {
  const text = body.trim();
  if (!text) return [];

  if (contentType.includes('text/event-stream')) {
    const data = text
      .split(/\r?\n\r?\n/)
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n'),
      )
      .filter((chunk) => chunk && chunk !== '[DONE]');
    const messages: JsonRpcMessage[] = [];
    for (const chunk of data) {
      try {
        messages.push(JSON.parse(chunk) as JsonRpcMessage);
      } catch {
        // Ignore malformed frames instead of dropping the whole response.
      }
    }
    return messages;
  }

  try {
    return [JSON.parse(text) as JsonRpcMessage];
  } catch {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as JsonRpcMessage];
        } catch {
          return [];
        }
      });
  }
}
