import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Regression: a screenshot turn poisoned the session for strict OpenAI-compatible
 * endpoints. The image used to be pushed as a `user` message *before* its own tool
 * result, so every later request carried
 *
 *   assistant{tool_calls} · user{image} · tool
 *
 * and DeepSeek (behind litellm) answered the *next* request with
 * "An assistant message with 'tool_calls' must be followed by tool messages responding
 * to each 'tool_call_id'. (insufficient tool messages following tool_calls message)".
 *
 * These boot the real service against a fake endpoint that enforces exactly that rule,
 * so the ordering — and the no-vision fallback that came out of it — are verified
 * end-to-end instead of by reading the transcript.
 *
 * Everything shares ONE service instance: the service, its config and its preset cache are
 * module-level singletons, so a second boot in the same process would keep talking to the
 * first fake endpoint.
 */

type Wire = {
  role: string;
  content: unknown;
  tool_calls?: Array<{ id: string }>;
  tool_call_id?: string;
  reasoning_content?: string;
};

/** The invariant litellm enforces. Returns an error message or undefined. */
function validateStrict(messages: Wire[]): string | undefined {
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue;
    const seen = new Set<string>();
    let j = i + 1;
    for (; j < messages.length && messages[j]!.role === 'tool'; j += 1) seen.add(messages[j]!.tool_call_id ?? '');
    for (const call of msg.tool_calls) {
      if (!seen.has(call.id)) {
        return `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)`;
      }
    }
  }
  return undefined;
}

/** The reasoning-replay rule, exactly as the live gateway enforces it. */
function validateReasoning(messages: Wire[]): string | undefined {
  if (messages.at(-1)?.role !== 'tool') return undefined;
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls?.length && msg.reasoning_content === undefined) {
      return 'The `reasoning_content` in the thinking mode must be passed back to the API.';
    }
  }
  return undefined;
}

const hasImageBlock = (messages: Wire[]) =>
  messages.some((m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((part) => part?.type === 'image_url'));

const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ delta, finish_reason: finish }] });

interface Fake {
  port: number;
  sent: Wire[][];
  reasoningRejections: () => number;
  close: () => void;
}

/** Fake OpenAI-compatible endpoint: validates ordering, then lets `respond` write the reply. */
async function startFake(respond: (messages: Wire[], res: ServerResponse) => void): Promise<Fake> {
  const sent: Wire[][] = [];
  let reasoningRejections = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const messages = (JSON.parse(body || '{}') as { messages?: Wire[] }).messages ?? [];
      sent.push(messages);

      const problem = validateStrict(messages) ?? validateReasoning(messages);
      if (problem) {
        if (problem.includes('reasoning_content')) reasoningRejections += 1;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `litellm.BadRequestError: DeepSeekException - ${problem}`, type: 'invalid_request_error' } }));
        return;
      }
      // `respond` owns the response entirely: it decides the status as well as the body.
      respond(messages, res);
      if (!res.writableEnded) res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    sent,
    reasoningRejections: () => reasoningRejections,
    close: () => server.close(),
  };
}

function streamToolCalls(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const payloads = [
    // Two calls in one turn: the image belongs to the first, but it must not split the
    // block between the two replies.
    chunk({ tool_calls: [{ index: 0, id: 'call_shot', function: { name: 'desktop_screenshot', arguments: '{"app":"notepad"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call_tree', function: { name: 'desktop_ui_tree', arguments: '{"app":"notepad"}' } }] }),
    chunk({}, 'tool_calls'),
  ];
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamTreeCall(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const payloads = [
    chunk({ tool_calls: [{ index: 0, id: 'call_tree_only', function: { name: 'desktop_ui_tree', arguments: '{"app":"notepad"}' } }] }),
    chunk({}, 'tool_calls'),
  ];
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamText(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const payload of [chunk({ content: text }), chunk({}, 'stop')]) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

interface Harness {
  promptOnce: (text: string) => Promise<{ entries: Array<{ role: string; text: string }>; status: string }>;
  close: () => Promise<void>;
}

/** Boot the real service against `port` with a throw-away BEECODE_HOME and the mock desktop. */
async function bootService(port: number): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'beecode-toolhistory-'));
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
  // Never let a developer's real .env.llm (and its live endpoint) leak into the test.
  const previousEnvFile = process.env.BEECODE_LLM_ENV_FILE;
  process.env.BEECODE_LLM_ENV_FILE = join(home, 'absent.env.llm');

  const { BeeCodeService } = await import('./service');
  const { startHttpTransport } = await import('./transports/http');
  const service = await BeeCodeService.create({ transport: 'http', version: 'test', workspace });
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

  type Snapshot = { entries: Array<{ role: string; text: string }>; status: string };

  return {
    async promptOnce(text: string) {
      const session = (await rpc('session.create', { title: 'strict' })) as unknown as { id: string };
      await rpc('session.prompt', { sessionId: session.id, text });
      // `session.prompt` only queues the turn, so wait for the loop to go idle instead of
      // reading a half-written transcript.
      const read = async () => (await rpc('session.get', { sessionId: session.id })) as unknown as Snapshot;
      const deadline = Date.now() + 15_000;
      let snapshot = await read();
      while (Date.now() < deadline && !(snapshot.status === 'idle' && snapshot.entries.length > 1)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        snapshot = await read();
      }
      assert.equal(snapshot.status, 'idle', 'the turn did not finish within 15s');
      return snapshot;
    },
    async close() {
      await transport.close();
      await service.shutdown();
      if (previousEnvFile === undefined) delete process.env.BEECODE_LLM_ENV_FILE;
      else process.env.BEECODE_LLM_ENV_FILE = previousEnvFile;
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('the strict validator reproduces the original bug shape', () => {
  // Without this the end-to-end test could pass vacuously.
  assert.match(
    validateStrict([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
      { role: 'user', content: [{ type: 'image_url' }] },
      { role: 'tool', content: 'shot', tool_call_id: 'call_1' },
    ]) ?? '',
    /insufficient tool messages/,
  );
});

test('screenshot turns survive strict tool_calls validation', async (t) => {
  let rejectImages = false;
  let plainTool = false;
  const fake = await startFake((messages, res) => {
    if (plainTool) {
      if (messages.at(-1)?.role === 'tool') streamText(res, 'Tree read.');
      else streamTreeCall(res);
      return;
    }
    if (rejectImages && hasImageBlock(messages)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'You have uploaded an unsupported image. Please make sure you have uploaded valid images that follow the format requirements.',
            type: 'invalid_request_error',
          },
        }),
      );
      return;
    }
    if (messages.some((m) => m.role === 'tool')) streamText(res, rejectImages ? 'Read the tree instead.' : 'All done.');
    else streamToolCalls(res);
  });

  const service = await bootService(fake.port);
  try {
    await t.test('tool replies stay adjacent to their tool_calls message', async () => {
      const before = fake.sent.length;
      const snapshot = await service.promptOnce('Screenshot Notepad and read its UI tree.');

      const errors = snapshot.entries.filter((e) => /^Error:|insufficient tool messages|unsupported image/.test(e.text));
      assert.deepEqual(errors, [], 'the run reported an error');
      assert.equal(snapshot.entries.at(-1)?.text, 'All done.', 'the turn never reached the final answer');

      const followUp = fake.sent.at(-1)!;
      assert.ok(fake.sent.length > before, 'no follow-up request was made');
      const image = followUp.findIndex((m) => m.role === 'user' && hasImageBlock([m]));
      assert.ok(image >= 0, 'no image message was sent - the scenario did not reproduce');
      const callIndex = followUp.findIndex((m) => m.role === 'assistant' && m.tool_calls?.length);
      assert.ok(callIndex >= 0, 'no tool_calls message was sent');
      assert.deepEqual(
        followUp.slice(callIndex + 1, callIndex + 3).map((m) => m.role),
        ['tool', 'tool'],
        'tool replies must immediately follow the tool_calls message',
      );
      assert.ok(image > callIndex + 2, 'the image message must come after every tool reply');
    });

    await t.test('a model without vision keeps the turn alive', async () => {
      rejectImages = true;
      const snapshot = await service.promptOnce('Screenshot Notepad again.');

      const errors = snapshot.entries.filter((e) => /^Error:|unsupported image/.test(e.text));
      assert.deepEqual(errors, [], 'the image rejection killed the turn');
      assert.equal(snapshot.entries.at(-1)?.text, 'Read the tree instead.');

      const accepted = fake.sent.at(-1)!;
      assert.equal(hasImageBlock(accepted), false, 'the retry still carried an image');
      assert.ok(
        accepted.some((m) => typeof m.content === 'string' && m.content.includes('screenshot image(s) omitted')),
        'the model was not told the screenshot was dropped',
      );
    });

    await t.test('a thinking model gets a reasoning field replayed', async () => {
      // A tool result ends the request, which is where the live gateway insists on seeing
      // reasoning_content again. Without the back-fill this session 400s on every turn.
      plainTool = true;
      const before = fake.reasoningRejections();
      const snapshot = await service.promptOnce('Read the Notepad UI tree.');

      const errors = snapshot.entries.filter((e) => /^Error:|reasoning_content/.test(e.text));
      assert.deepEqual(errors, [], 'the reasoning rejection killed the turn');
      assert.equal(snapshot.entries.at(-1)?.text, 'Tree read.');
      assert.ok(fake.reasoningRejections() > before, 'no reasoning rejection was raised - the scenario did not reproduce');

      const accepted = fake.sent.at(-1)!;
      const call = accepted.find((m) => m.role === 'assistant' && m.tool_calls?.length);
      assert.equal(call?.reasoning_content, '', 'the retry did not replay an empty reasoning field');
    });
  } finally {
    await service.close();
    fake.close();
  }
});
