import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { RpcMethod, RpcRequests, ServiceEvent } from '../shared/protocol';

export type SupervisorStatus = 'starting' | 'ready' | 'restarting' | 'stopped' | 'failed';

export interface SupervisorOptions {
  /** Path to the bundled dist/service.js, executed with ELECTRON_RUN_AS_NODE. */
  entry: string;
  workspace: string;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Supervises the background service as a child process.
 *
 * The renderer never talks to the service directly: `main` owns this one pipe, which
 * keeps the agent runtime out of the UI process (a crash or a runaway tool cannot freeze
 * the window) and lets the service be restarted underneath a live UI.
 */
export class ServiceSupervisor extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private restarts = 0;
  private stopping = false;
  private _status: SupervisorStatus = 'stopped';
  private readyResolvers: Array<(ok: boolean) => void> = [];

  constructor(private readonly options: SupervisorOptions) {
    super();
  }

  get status(): SupervisorStatus {
    return this._status;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private setStatus(status: SupervisorStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
  }

  /** Spawns the service and waits for its first health event. */
  async start(): Promise<boolean> {
    this.stopping = false;
    this.setStatus('starting');
    const ready = new Promise<boolean>((resolve) => {
      this.readyResolvers.push(resolve);
    });

    const args = [this.options.entry, '--transport=stdio', `--workspace=${this.options.workspace}`];
    const child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BEECODE_LOG_STDOUT: '0',
      },
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.options.log('warn', chunk.trim());
    });

    child.on('error', (err) => {
      this.options.log('error', `service process error: ${err.message}`);
      this.failAllPending(new Error(`service process error: ${err.message}`));
      this.setStatus('failed');
      this.flushReady(false);
    });

    child.on('exit', (code, signal) => {
      this.child = undefined;
      this.failAllPending(new Error(`service exited (code ${code}, signal ${signal})`));
      if (this.stopping) {
        this.setStatus('stopped');
        return;
      }
      this.options.log('error', `service exited unexpectedly (code ${code})`);
      void this.restart();
    });

    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000));
    const ok = await Promise.race([ready, timeout]);
    if (!ok) this.options.log('error', 'service did not report ready within 20s');
    return ok;
  }

  private async restart(): Promise<void> {
    if (this.stopping) return;
    if (this.restarts >= 5) {
      this.setStatus('failed');
      this.options.log('error', 'service crashed repeatedly — giving up. Check ~/.beecode/logs/service.log');
      return;
    }
    this.restarts += 1;
    this.setStatus('restarting');
    const delay = Math.min(1000 * 2 ** this.restarts, 15_000);
    await new Promise((r) => setTimeout(r, delay));
    if (this.stopping) return;
    await this.start();
  }

  private flushReady(ok: boolean): void {
    const resolvers = this.readyResolvers;
    this.readyResolvers = [];
    for (const resolve of resolvers) resolve(ok);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.options.log('info', `service: ${line}`);
      return;
    }

    if (msg.method === 'event' && msg.params) {
      const event = msg.params as ServiceEvent;
      if (event.type === 'service.health') {
        this.restarts = 0;
        this.setStatus('ready');
        this.flushReady(true);
      }
      this.emit('event', event);
      return;
    }

    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const error = msg.error as { message?: string };
        pending.reject(new Error(error.message ?? 'service error'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    this.options.log('info', `service: ${line}`);
  }

  /** Typed JSON-RPC call into the service. */
  request<M extends RpcMethod>(method: M, params: RpcRequests[M]['params']): Promise<RpcRequests[M]['result']> {
    const child = this.child;
    if (!child || child.killed) {
      return Promise.reject(new Error(`service is not running (${this._status})`));
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`service request "${method}" timed out`));
      }, 120_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(payload, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.setStatus('stopped');
      return;
    }
    try {
      child.stdin.end();
      child.kill();
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.setStatus('stopped');
  }
}
