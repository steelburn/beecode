import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { listModels } from './models';

interface Probe {
  server: Server;
  /** Base URL to hand to listModels, with the OpenAI-style /v1 suffix. */
  url: string;
}

/** Serve a canned response per path so the probe's request shape can be asserted too. */
async function probe(routes: Record<string, { status?: number; body: unknown }>): Promise<Probe> {
  const seen: IncomingMessage[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push(request);
    const route = routes[request.url ?? ''];
    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    response.writeHead(route.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  (server as Server & { seen?: IncomingMessage[] }).seen = seen;
  return { server, url: `http://127.0.0.1:${port}/v1` };
}

const close = (target: Probe): Promise<void> => new Promise((resolve) => target.server.close(() => resolve()));

test('models.list: reads an OpenAI-style model list, deduped and sorted', async () => {
  const target = await probe({ '/v1/models': { body: { data: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }, { id: 'gpt-4.1' }] } } });
  try {
    const result = await listModels({ provider: 'openai', baseUrl: target.url, apiKey: 'sk-draft' });
    assert.deepEqual(result.models, ['gpt-4.1', 'gpt-4.1-mini']);
    assert.equal(result.warning, undefined);
    const seen = (target.server as Server & { seen: IncomingMessage[] }).seen;
    assert.equal(seen[0]?.headers.authorization, 'Bearer sk-draft', 'the unsaved draft key is used');
  } finally {
    await close(target);
  }
});

test('models.list: falls back to the env var when no key was typed', async () => {
  const target = await probe({ '/v1/models': { body: { data: [{ id: 'm1' }] } } });
  process.env.BEECODE_TEST_API_KEY = 'sk-env';
  try {
    const result = await listModels({ provider: 'openai-compatible', baseUrl: target.url, apiKeyEnv: 'BEECODE_TEST_API_KEY' });
    assert.deepEqual(result.models, ['m1']);
    const seen = (target.server as Server & { seen: IncomingMessage[] }).seen;
    assert.equal(seen[0]?.headers.authorization, 'Bearer sk-env');
  } finally {
    delete process.env.BEECODE_TEST_API_KEY;
    await close(target);
  }
});

test('models.list: ollama falls back to the native tag list', async () => {
  const target = await probe({ '/api/tags': { body: { models: [{ name: 'llama3' }, { name: 'qwen3' }] } } });
  try {
    const result = await listModels({ provider: 'ollama', baseUrl: target.url });
    assert.deepEqual(result.models, ['llama3', 'qwen3']);
    assert.equal(result.warning, undefined);
  } finally {
    await close(target);
  }
});

test('models.list: an unreachable endpoint reports a warning instead of throwing', async () => {
  const target = await probe({});
  const url = target.url;
  await close(target);
  const result = await listModels({ provider: 'openai', baseUrl: url, apiKey: 'sk-draft' });
  assert.deepEqual(result.models, []);
  assert.match(result.warning ?? '', /no model list/);
});
