import { BeeCodeService } from './service';
import { startHttpTransport } from './transports/http';
import { startStdioTransport } from './transports/stdio';

interface Args {
  transport: 'stdio' | 'http';
  port: number;
  workspace?: string;
}

function parseArgs(argv: string[]): Args {
  let transport: 'stdio' | 'http' = 'stdio';
  let port = Number(process.env.BEECODE_HTTP_PORT ?? 4870);
  let workspace: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--transport=')) {
      const value = arg.slice('--transport='.length);
      transport = value === 'http' ? 'http' : 'stdio';
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length)) || port;
    } else if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length);
    }
  }
  return { transport, port, workspace };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const service = await BeeCodeService.create({
    transport: args.transport,
    version: process.env.npm_package_version ?? '0.1.0',
    workspace: args.workspace,
  });

  if (args.transport === 'http') {
    const handle = await startHttpTransport(service, {
      port: args.port,
      token: process.env.BEECODE_SERVICE_TOKEN,
      onReady: ({ port, token }) => {
        // Machine-readable banner: a supervisor reads exactly one line to discover the port.
        process.stdout.write(`${JSON.stringify({ type: 'beecode-service-ready', port, token })}\n`);
      },
    });
    // eslint-disable-next-line no-console
    console.error(`[beecode] service listening on http://127.0.0.1:${handle.port} (token in banner)`);

    const stop = async () => {
      await handle.close();
      await service.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  const stopStdio = startStdioTransport(service);
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'service.health', payload: service.health() } })}\n`,
  );

  const stop = async () => {
    stopStdio();
    await service.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdin.on('end', () => void stop());
}

void main().catch((err) => {
  process.stderr.write(`[beecode] service failed to start: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
