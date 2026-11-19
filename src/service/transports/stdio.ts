import { createInterface } from 'node:readline';
import type { JsonRpcFailure, JsonRpcMessage, JsonRpcRequest, JsonRpcSuccess } from '../../shared/protocol';
import { RPC_ERRORS } from '../../shared/protocol';
import type { BeeCodeService } from '../service';
import type { HostCall } from '../../shared/browser';

/** How long the service waits for the host to answer a `browser/exec` request. */
const HOST_CALL_TIMEOUT_MS = 60_000;

/**
 * stdio transport: newline-delimited JSON-RPC on stdin/stdout, events pushed as
 * `method: "event"` notifications. This is what the Electron main process speaks, and
 * it is what makes the service usable from any other language via a pipe.
 *
 * The pipe is bidirectional in practice, not just in name: the `browser_*` tools live here
 * but the browser view lives in the main process, so this transport also *sends* requests
 * (`browser/exec`) and matches the answers to the promises waiting for them. Any other
 * host capability would ride the same channel — see `HostRequests` in `shared/browser.ts`.
 */
export function startStdioTransport(service: BeeCodeService): () => void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pendingHostCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let hostSequence = 0;

  // The channel is untyped JSON on the wire, so the generic `HostCall` shape is asserted at
  // this boundary and checked inside the main process (see `BrowserHost.exec`).
  const hostCall = ((method: string, params: unknown) => {
    const id = ++hostSequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingHostCalls.delete(id)) reject(new Error(`the desktop host did not answer "${method}" in time`));
      }, HOST_CALL_TIMEOUT_MS);
      // The timer is per call: a slow page load must not linger after it settles either way.
      pendingHostCalls.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      write({ jsonrpc: '2.0', id, method, params } as JsonRpcMessage);
    });
  }) as HostCall;
  service.bindHostCall(hostCall);

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
    // A message with an id and no method is the host answering one of *our* requests.
    const asReply = msg as { id?: unknown; result?: unknown; error?: { message?: string } };
    if (typeof (msg as JsonRpcRequest).method !== 'string' && typeof asReply.id === 'number') {
      const waiter = pendingHostCalls.get(asReply.id);
      if (waiter) {
        pendingHostCalls.delete(asReply.id);
        if (asReply.error) waiter.reject(new Error(asReply.error.message ?? 'the host call failed'));
        else waiter.resolve(asReply.result);
      }
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
