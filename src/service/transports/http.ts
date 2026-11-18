import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { JsonRpcFailure, JsonRpcMessage, JsonRpcRequest, JsonRpcSuccess } from '../../shared/protocol';
import { RPC_ERRORS } from '../../shared/protocol';
import type { BeeCodeService } from '../service';

export interface HttpTransportOptions {
  port: number;
  /** Bearer token required on every /rpc call; generated when omitted. */
  token?: string;
  /** Emitted once the listener is up, so a supervisor can discover port + token. */
  onReady?: (info: { port: number; token: string }) => void;
}

export interface HttpTransportHandle {
  port: number;
  token: string;
  close: () => Promise<void>;
}

/**
 * Loopback HTTP transport: `POST /rpc` for requests, `GET /events` for an SSE event
 * stream, `GET /health` for liveness. Bound to 127.0.0.1 with a per-process bearer token,
 * so a headless beeCode service can be driven by scripts, a CLI or another app without
 * exposing anything to the network.
 */
export async function startHttpTransport(
  service: BeeCodeService,
  options: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const token = options.token ?? randomBytes(24).toString('hex');
  const sseClients = new Set<ServerResponse>();

  const unsubscribe = service.onEvent((event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${options.port}`);
    const origin = req.headers.origin;
    if (origin) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'cross-origin requests are not allowed' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, service.health());
      return;
    }

    if (!authorized(req)) {
      json(res, 401, { error: 'missing or invalid bearer token' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'hello', payload: service.health() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/rpc') {
      const body = await readBody(req);
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(body) as JsonRpcMessage;
      } catch {
        json(res, 400, { jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.parse, message: 'invalid JSON' } });
        return;
      }
      const request = msg as JsonRpcRequest;
      if (typeof request.method !== 'string') {
        json(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: RPC_ERRORS.invalidRequest, message: 'missing method' },
        });
        return;
      }
      try {
        const result = await service.handle(request.method, request.params);
        json(res, 200, { jsonrpc: '2.0', id: request.id ?? null, result } satisfies JsonRpcSuccess);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 200, {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: RPC_ERRORS.internal, message },
        } satisfies JsonRpcFailure);
      }
      return;
    }

    json(res, 404, { error: 'not found' });
  }

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const value = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(value);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  options.onReady?.({ port, token });

  return {
    port,
    token,
    close: async () => {
      unsubscribe();
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 8 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
