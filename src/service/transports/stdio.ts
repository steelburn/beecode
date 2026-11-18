import { createInterface } from 'node:readline';
import type { JsonRpcFailure, JsonRpcMessage, JsonRpcRequest, JsonRpcSuccess } from '../../shared/protocol';
import { RPC_ERRORS } from '../../shared/protocol';
import type { BeeCodeService } from '../service';

/**
 * stdio transport: newline-delimited JSON-RPC on stdin/stdout, events pushed as
 * `method: "event"` notifications. This is what the Electron main process speaks, and
 * it is what makes the service usable from any other language via a pipe.
 */
export function startStdioTransport(service: BeeCodeService): () => void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  const unsubscribe = service.onEvent((event) => {
    write({ jsonrpc: '2.0', method: 'event', params: event });
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.parse, message: 'invalid JSON' } });
      return;
    }
    void dispatch(service, msg, write);
  });

  return () => {
    unsubscribe();
    rl.close();
  };
}

function write(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function dispatch(
  service: BeeCodeService,
  msg: JsonRpcMessage,
  send: (message: JsonRpcMessage) => void,
): Promise<void> {
  const request = msg as JsonRpcRequest;
  if (typeof request.method !== 'string') {
    send({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.invalidRequest, message: 'missing method' } });
    return;
  }
  // Notifications (no id) are fire-and-forget.
  const hasId = request.id !== undefined && request.id !== null;

  try {
    const result = await service.handle(request.method, request.params);
    if (hasId) send({ jsonrpc: '2.0', id: request.id, result } satisfies JsonRpcSuccess);
  } catch (err) {
    if (!hasId) return;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.startsWith('unknown method') ? RPC_ERRORS.methodNotFound : RPC_ERRORS.internal;
    send({ jsonrpc: '2.0', id: request.id, error: { code, message } } satisfies JsonRpcFailure);
  }
}
