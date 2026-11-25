#!/usr/bin/env node
/**
 * A minimal reference host for an exported slate mini-app.
 *
 * This is the server half of the contract documented in `docs/slates.md` under
 * "Export — a slate as a mini-app", and it exists to prove the contract is implementable
 * outside beeCode without re-implementing any of it:
 *
 *   - the document is served from the bundle with the slate CSP as a *response header*,
 *     computed by the app's own `slateLiveCsp()`;
 *   - `POST /submit` is validated by the app's own `validateSlateSubmission()` — the same
 *     function, not a copy, loaded from `dist/host/*.mjs` (`npm run build` emits it);
 *   - the sink is append-only and unique on `(slateId, submissionId)`, so a retry replays
 *     rather than duplicating.
 *
 * Deliberate limitations, all of them lessons from the live tier:
 *
 *   - it binds 127.0.0.1 and has no `--host` flag: a mini-app server on a LAN interface is
 *     a different security proposition and does not belong in a prototype;
 *   - it requires `content-type: application/json`, which a cross-site html form cannot
 *     send (forms post urlencoded/plain) — that alone removes the classic CSRF shape;
 *   - it rejects a foreign `Origin`;
 *   - submissions are readable only with `--token`, because they are the owner's data.
 *
 * Usage (run `npm run build` first):
 *
 *   node scripts/slate-host/mini-app-host.mjs [appDir] [options]
 *
 *   --port=<n>       listen port, 0 picks a free one (default 7077)
 *   --sink=sqlite    sqlite (default, via the node:sqlite builtin) or jsonl; a Node build
 *                    without node:sqlite is told so and falls back to the jsonl sink
 *   --data=<file>    sink file, relative to appDir (default submissions.db / .jsonl)
 *   --max=<n>        submissions per slate before the host refuses (default: the app's cap)
 *   --token=<value>  enables GET /submissions with `authorization: Bearer <value>`
 */
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(here, '../../dist/host');

function die(message) {
  console.error(`mini-app-host: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name, fallback) {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? 'true' : hit.slice(eq + 1);
}

if (flag('help', 'false') === 'true') {
  console.log('usage: node scripts/slate-host/mini-app-host.mjs [appDir] [--port=N] [--sink=sqlite|jsonl] [--data=file] [--max=N] [--token=value]');
  process.exit(0);
}

async function loadHostLib(name) {
  try {
    return await import(pathToFileURL(join(libDir, name)).href);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      die(`missing ${join(libDir, name)} — run "npm run build" first (the host reuses the app's own validator)`);
    }
    throw error;
  }
}

const { normaliseSlateSubmit, validateSlateSubmission, SLATE_SUBMIT_LIMITS } = await loadHostLib('slateSubmit.mjs');
const { slateLiveCsp } = await loadHostLib('slateSandbox.mjs');

const BODY_LIMIT = Number(SLATE_SUBMIT_LIMITS?.bytes) || 64 * 1024;
const ID_LIMIT = Number(SLATE_SUBMIT_LIMITS?.idLength) || 64;
const APP_CEILING = Number(SLATE_SUBMIT_LIMITS?.submissions) || 200;

// ---------------------------------------------------------------- the bundle

const appDir = resolve(args.find((a) => !a.startsWith('--')) ?? join(here, 'example'));

let manifest;
try {
  manifest = JSON.parse(await readFile(join(appDir, 'slate.json'), 'utf8'));
} catch (error) {
  die(`cannot read ${join(appDir, 'slate.json')} — a mini-app is index.html + slate.json (${error.message})`);
}

const slateId = String(manifest?.slate?.id ?? '');
const slateVersion = Number(manifest?.slate?.version ?? 0);
if (!slateId || !Number.isInteger(slateVersion) || slateVersion < 1) {
  die('slate.json needs { "slate": { "id": "...", "version": 1 } }');
}
const origins = Array.isArray(manifest.origins) ? manifest.origins.filter((entry) => typeof entry === 'string') : [];

let schema;
try {
  schema = normaliseSlateSubmit(manifest.submit);
} catch (error) {
  die(`submit schema rejected: ${error.message}`);
}

// ---------------------------------------------------------------- the sink

/**
 * Both sinks answer the same four questions and nothing else. The interface is the point:
 * swapping SQLite for JSONL must not touch a line of request handling.
 */
/**
 * The API shape of one submission — the only shape a handler ever sees. Each sink has its
 * own storage shape (a row with snake_case columns, a jsonl line with camelCase keys), so
 * both map to this and the route stays sink-agnostic.
 */
function rowToSubmission(row) {
  return {
    n: Number(row.n),
    id: String(row.submission_id),
    at: String(row.received_at),
    version: Number(row.slate_version),
    fields: JSON.parse(String(row.fields)),
  };
}

/**
 * A jsonl line is stored as `{ slateId, version, submissionId, at, fields, n }` — `slateId`
 * is how a shared file is filtered per slate, and `submissionId` is the stored field name.
 * Neither belongs in the response: map to the same shape as `rowToSubmission`.
 */
function lineToSubmission(entry) {
  return {
    n: Number(entry.n),
    id: String(entry.submissionId),
    at: String(entry.at),
    version: Number(entry.version),
    fields: entry.fields,
  };
}

async function openSqlite(file) {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return undefined;
  }
  await mkdir(dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      seq           INTEGER PRIMARY KEY AUTOINCREMENT,
      slate_id      TEXT    NOT NULL,
      slate_version INTEGER NOT NULL,
      n             INTEGER NOT NULL,
      submission_id TEXT    NOT NULL,
      received_at   TEXT    NOT NULL,
      fields        TEXT    NOT NULL,
      UNIQUE (slate_id, submission_id)
    );
  `);
  return {
    kind: `sqlite → ${file}`,
    async find(submissionId) {
      const row = db
        .prepare('SELECT * FROM submissions WHERE slate_id = ? AND submission_id = ?')
        .get(slateId, submissionId);
      return row ? rowToSubmission(row) : undefined;
    },
    async count() {
      const row = db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE slate_id = ?').get(slateId);
      return Number(row?.c ?? 0);
    },
    async append(entry) {
      const row = db.prepare('SELECT COALESCE(MAX(n), 0) AS m FROM submissions WHERE slate_id = ?').get(slateId);
      const n = Number(row?.m ?? 0) + 1;
      db.prepare(
        'INSERT INTO submissions (slate_id, slate_version, n, submission_id, received_at, fields) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(slateId, entry.version, n, entry.submissionId, entry.at, JSON.stringify(entry.fields));
      return n;
    },
    async list(since) {
      return db
        .prepare('SELECT * FROM submissions WHERE slate_id = ? AND n > ? ORDER BY n')
        .all(slateId, since)
        .map(rowToSubmission);
    },
    close() {
      db.close();
    },
  };
}

async function openJsonl(file) {
  await mkdir(dirname(file), { recursive: true });
  const rows = [];
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      die(`${file} is not a jsonl sink — unparsable line; delete it or pick another --data`);
    }
    if (parsed && parsed.slateId === slateId) rows.push(parsed);
  }
  return {
    kind: `jsonl → ${file} (${rows.length} existing)`,
    async find(submissionId) {
      const hit = rows.find((entry) => entry.submissionId === submissionId);
      return hit ? lineToSubmission(hit) : undefined;
    },
    async count() {
      return rows.length;
    },
    async append(entry) {
      // Same rule as the sqlite sink: one past the highest n this slate already holds.
      const n = rows.reduce((max, row) => Math.max(max, Number(row.n) || 0), 0) + 1;
      const stored = { ...entry, n };
      await appendFile(file, `${JSON.stringify(stored)}\n`, 'utf8');
      rows.push(stored);
      return n;
    },
    async list(since) {
      return rows
        .filter((entry) => Number(entry.n) > since)
        .sort((a, b) => Number(a.n) - Number(b.n))
        .map(lineToSubmission);
    },
    close() {},
  };
}

const sinkKind = flag('sink', 'sqlite');
const ceiling = Number(flag('max', '0')) || APP_CEILING;
const readToken = flag('token', '');
const port = Number(flag('port', '7077'));

let sink;
if (sinkKind === 'sqlite') {
  sink = await openSqlite(resolve(appDir, flag('data', 'submissions.db')));
  if (!sink) {
    console.warn('mini-app-host: node:sqlite unavailable in this Node build — falling back to jsonl');
    sink = await openJsonl(resolve(appDir, flag('data', 'submissions.jsonl')));
  }
} else if (sinkKind === 'jsonl') {
  sink = await openJsonl(resolve(appDir, flag('data', 'submissions.jsonl')));
} else {
  die(`unknown --sink=${sinkKind} (use sqlite or jsonl)`);
}

// ---------------------------------------------------------------- http

const pageCsp = slateLiveCsp(origins, { submit: Boolean(schema) });

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', ...headers });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error(`payload is over ${BODY_LIMIT} bytes`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('body is not JSON');
    error.status = 400;
    throw error;
  }
}

const server = createServer(async (req, res) => {
  const selfOrigin = `http://127.0.0.1:${server.address()?.port ?? port}`;
  try {
    const url = new URL(req.url ?? '/', selfOrigin);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      let html;
      try {
        html = await readFile(join(appDir, 'index.html'), 'utf8');
      } catch {
        return sendJson(res, 500, { ok: false, errors: [{ message: 'index.html is missing from the bundle' }] });
      }
      return send(res, 200, html, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': pageCsp,
      });
    }

    if (req.method === 'GET' && path === '/slate.json') {
      return sendJson(res, 200, manifest);
    }

    if (path === '/submit') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, errors: [{ message: 'use POST' }] }, { allow: 'POST' });
      if (!schema) {
        return sendJson(res, 404, { ok: false, errors: [{ message: 'this mini-app declares no form' }] });
      }
      // A cross-site html form cannot produce this content type: refuse anything else.
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        return sendJson(res, 415, { ok: false, errors: [{ message: 'expected content-type: application/json' }] });
      }
      const origin = req.headers.origin;
      if (origin && origin !== selfOrigin && origin !== `http://localhost:${server.address()?.port ?? port}`) {
        return sendJson(res, 403, { ok: false, errors: [{ message: 'foreign origin' }] });
      }

      const body = await readJsonBody(req);
      const submissionId = typeof body?.submissionId === 'string' ? body.submissionId : '';
      if (!submissionId || submissionId.length > ID_LIMIT) {
        return sendJson(res, 400, {
          ok: false,
          errors: [{ field: 'submissionId', message: `required, at most ${ID_LIMIT} characters` }],
        });
      }

      const replay = await sink.find(submissionId);
      if (replay) return sendJson(res, 200, { ok: true, n: replay.n, replayed: true });

      // The validator takes the *message* and reads its `fields` member, exactly as the
      // service hands it the posted body — `submissionId` is the sink's business, not its.
      const verdict = validateSlateSubmission(schema, body);
      if (!verdict.ok) return sendJson(res, 400, { ok: false, errors: verdict.errors });

      if ((await sink.count()) >= ceiling) {
        return sendJson(res, 429, {
          ok: false,
          errors: [{ message: `this slate already holds ${ceiling} submissions — raise --max or start a new app` }],
        });
      }

      const n = await sink.append({
        slateId,
        version: slateVersion,
        submissionId,
        at: new Date().toISOString(),
        fields: verdict.fields,
      });
      console.log(`[host] accepted #${n} ${submissionId} (${Object.keys(verdict.fields).length} fields)`);
      return sendJson(res, 200, { ok: true, n });
    }

    if (path === '/submissions') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, errors: [{ message: 'use GET' }] }, { allow: 'GET' });
      if (!readToken) {
        return sendJson(res, 404, { ok: false, errors: [{ message: 'not found' }] });
      }
      if (req.headers.authorization !== `Bearer ${readToken}`) {
        return sendJson(res, 401, { ok: false, errors: [{ message: 'unauthorized' }] });
      }
      const since = Number(url.searchParams.get('since') ?? '0') || 0;
      return sendJson(res, 200, { ok: true, submissions: await sink.list(since) });
    }

    return sendJson(res, 404, { ok: false, errors: [{ message: 'not found' }] });
  } catch (error) {
    const status = error?.status ?? 500;
    if (status === 500) console.error('[host]', error);
    return sendJson(res, status, { ok: false, errors: [{ message: error?.message ?? 'internal error' }] });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') die(`port ${port} is already in use — pass --port=<n>`);
  die(error.message);
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address()?.port;
  console.log(`[host] slate     ${slateId} v${slateVersion}`);
  console.log(`[host] bundle    ${appDir}`);
  console.log(`[host] sink      ${sink.kind}`);
  console.log(`[host] submit    ${schema ? `POST http://127.0.0.1:${actual}/submit (${schema.fields.length} fields, ${ceiling} max)` : 'none declared'}`);
  console.log(`[host] read back ${readToken ? 'GET /submissions?since=0 with your token' : 'disabled (pass --token=<value>)'}`);
  console.log(`[host] csp       ${pageCsp}`);
  if (origins.length) console.log(`[host] declared  ${origins.join(' ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    sink.close();
    server.close(() => process.exit(0));
  });
}
