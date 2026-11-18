/**
 * Live end-to-end check of the model endpoint, through the real background service and the
 * real agent loop (no mocks, no stubs).
 *
 *   npm run build && node scripts/verify-llm.mjs
 *
 * The service reads .env.llm (API_KEY / URL / MODEL — see .env.llm.example) and republishes
 * the key to BEECODE_LLM_API_KEY, so nothing secret reaches argv or the report file.
 *
 * Exits 0 when the model answers and the token meter moves; 1 otherwise.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const root = process.cwd();
const serviceJs = join(root, 'dist', 'service.js');
const reportDir = join(root, 'dist-test');
const startedAt = Date.now();

const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function finish(code, extra) {
  const report = { at: new Date().toISOString(), durationMs: Date.now() - startedAt, steps, ...extra };
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'verify-llm-report.json'), JSON.stringify(report, null, 2));
  process.exit(code);
}

if (!existsSync(serviceJs)) {
  console.error(`dist/service.js not found — run "npm run build" first (${serviceJs})`);
  process.exit(1);
}

const port = 4900 + Math.floor(Math.random() * 90);
const child = spawn(process.execPath, [serviceJs, `--transport=http`, `--port=${port}`], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, BEECODE_HTTP_PORT: String(port) },
});

let token = '';
let stdoutBuf = '';
const stderrTail = [];
child.stderr.on('data', (chunk) => {
  const text = String(chunk);
  stderrTail.push(text);
  if (stderrTail.length > 40) stderrTail.shift();
});

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('service did not report ready within 20s')), 20_000);
  createInterface({ input: child.stdout }).on('line', (line) => {
    stdoutBuf += `${line}\n`;
    if (!line.trimStart().startsWith('{')) return;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'beecode-service-ready') {
        clearTimeout(timer);
        token = msg.token;
        resolve(msg);
      }
    } catch {
      /* not the ready line */
    }
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`service exited early (code ${code})\n${stderrTail.join('')}`));
  });
});

let seq = 0;
async function rpc(method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const info = await ready;
  step('service ready', info.port === port, `port ${info.port}`);

  // 1. The .env.llm preset must be the default, without the raw key ever being in config.
  const config = await rpc('config.get');
  const preset = config.models.find((m) => m.id === config.defaultModelId);
  step('model preset', Boolean(preset), `${config.defaultModelId} → ${preset?.model ?? '?'}`);
  step(
    'preset comes from .env.llm',
    preset?.provider === 'openai-compatible',
    `provider ${preset?.provider}, key via $${preset?.apiKeyEnv}`,
  );
  step(
    'key not stored in config',
    !JSON.stringify(config).toLowerCase().includes('sk-'),
    'no sk- literal in config.get payload',
  );

  // 2. One real round trip through the agent loop.
  // ask mode: read-only, no approval cards — this check is about the endpoint, not tools.
  const session = await rpc('session.create', { title: 'verify-llm', mode: 'ask' });
  step('session created', Boolean(session?.id), session?.id?.slice(0, 8));

  const marker = `BEE-OK-${Date.now().toString(36)}`;
  await rpc('session.prompt', {
    sessionId: session.id,
    text: `Reply with exactly this token and nothing else: ${marker}`,
  });

  let snapshot = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    snapshot = await rpc('session.get', { sessionId: session.id });
    if (snapshot.status === 'idle' || snapshot.status === 'error') break;
    await sleep(500);
  }

  const assistant = (snapshot?.entries ?? []).filter((e) => e.role === 'assistant').pop();
  const reply = assistant?.text?.trim() ?? '';
  step('assistant replied', reply.length > 0, `${reply.length} chars`);
  step('reply matches prompt echo', reply.includes(marker), reply.slice(0, 120) || '(empty)');
  step(
    'token meter moved',
    Boolean(snapshot?.usage && (snapshot.usage.inputTokens > 0 || snapshot.usage.outputTokens > 0)),
    snapshot?.usage ? `in ${snapshot.usage.inputTokens} / out ${snapshot.usage.outputTokens}` : 'no usage reported',
  );

  const failed = steps.filter((s) => !s.ok);
  console.log(
    `\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${steps.length - failed.length}/${steps.length} checks; report in dist-test/verify-llm-report.json`,
  );
  finish(failed.length === 0 ? 0 : 1, { reply });
} catch (err) {
  step('live round trip', false, err instanceof Error ? err.message : String(err));
  finish(1, { stderr: stderrTail.join('').slice(-4000) });
} finally {
  child.kill();
}
