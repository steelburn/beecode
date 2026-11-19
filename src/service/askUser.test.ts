import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServiceEvent } from '../shared/protocol';

/**
 * Regression: `ask_user` ended the turn but the question never reached the UI — the
 * renderer only got `{ callId, name, result, failed }`, so `meta.awaitingUser` (and with it
 * the question and its suggested answers) was dropped on the way. The turn must still end
 * and the question must travel to the renderer as structured meta.
 */

type Wire = { role: string; content: unknown };

const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ delta, finish_reason: finish }] });

/** Streams one `ask_user` tool call — the agent loop ends the turn on it. */
function streamAskUser(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const args = JSON.stringify({ question: 'Which app should I drive?', options: ['Notepad', 'Calculator'] });
  const payloads = [
    chunk({ tool_calls: [{ index: 0, id: 'call_ask', function: { name: 'ask_user', arguments: args } }] }),
    chunk({}, 'tool_calls'),
  ];
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

test('ask_user carries its question to the UI and ends the turn', async () => {
  const sent: Wire[][] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (part) => {
      body += part;
    });
    req.on('end', () => {
      sent.push((JSON.parse(body) as { messages?: Wire[] }).messages ?? []);
      streamAskUser(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const home = await mkdtemp(join(tmpdir(), 'beecode-askuser-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      models: [
        {
          id: 'strict',
          label: 'Strict',
          provider: 'openai-compatible',
          model: 'strict-model',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'BEE_TEST_KEY',
        },
      ],
      defaultModelId: 'strict',
      desktop: { enabled: true, driver: 'mock', allowInput: true },
      agent: { defaultMode: 'ask', maxSteps: 4, autoApproveTools: [], workingDir: workspace },
      subagents: { enabled: true, maxConcurrent: 2, cliAgents: [] },
    }),
    'utf8',
  );

  process.env.BEECODE_HOME = home;
  process.env.BEE_TEST_KEY = 'test-key';
  process.env.BEECODE_LLM_ENV_FILE = join(home, 'absent.env.llm');

  const { BeeCodeService } = await import('./service');
  const { startHttpTransport } = await import('./transports/http');
  const service = await BeeCodeService.create({ transport: 'http', version: 'test', workspace });
  const events: ServiceEvent[] = [];
  service.onEvent((event) => events.push(event));
  const transport = await startHttpTransport(service, { port: 0, token: 'test-token' });

  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(`http://127.0.0.1:${transport.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const payload = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
    return payload.result as never;
  };

  try {
    const session = (await rpc('session.create', { title: 'ask' })) as unknown as { id: string };
    await rpc('session.prompt', { sessionId: session.id, text: 'Open the app and type the number.' });

    const deadline = Date.now() + 15_000;
    let snapshot = (await rpc('session.get', { sessionId: session.id })) as unknown as { status: string };
    while (snapshot.status !== 'idle' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      snapshot = (await rpc('session.get', { sessionId: session.id })) as unknown as { status: string };
    }
    assert.equal(snapshot.status, 'idle', 'ask_user did not end the turn');

    const ask = events.find(
      (event) =>
        event.type === 'tool.result' &&
        (event.payload as { name?: string }).name === 'ask_user',
    ) as { payload: { failed: boolean; meta?: Record<string, unknown> } } | undefined;
    assert.ok(ask, 'no tool.result event for ask_user');
    assert.equal(ask.payload.failed, false, 'ask_user reported an error');
    assert.equal(ask.payload.meta?.awaitingUser, true, 'meta.awaitingUser did not reach the renderer');
    assert.equal(ask.payload.meta?.question, 'Which app should I drive?', 'the question text was dropped');
    assert.deepEqual(ask.payload.meta?.options, ['Notepad', 'Calculator'], 'the suggested answers were dropped');

    // The question is in the conversation the model resumes from.
    assert.equal(sent.length, 1, 'the loop asked the model again after ask_user');
  } finally {
    await transport.close();
    await service.shutdown();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
