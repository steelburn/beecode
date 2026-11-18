import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultConfig, normalizeConfig } from '../shared/defaults';
import { SecretsStore } from './secrets';
import { resolveApiKey, setSecretResolver } from './llm/types';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'beecode-secrets-'));

test('secrets store: creates the file 0600 and tightens an existing one', {
  skip: process.platform === 'win32' ? 'Windows reports a synthetic 0666; the profile ACL is the control there' : false,
}, () => {
  const home = tmp();
  const file = join(home, 'secrets.json');
  try {
    new SecretsStore(file).set('p1', 'sk-created');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'a new secrets file is created 0600');

    chmodSync(file, 0o644);
    new SecretsStore(file).set('p1', 'sk-updated');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'an existing loose file is tightened on save');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('secrets store: set, get, persist and prune', () => {
  const home = tmp();
  try {
    const file = join(home, 'secrets.json');
    const store = new SecretsStore(file);
    assert.equal(store.has('env-llm'), false);

    store.set('env-llm', 'sk-test-123');
    assert.equal(store.get('env-llm'), 'sk-test-123');
    assert.equal(store.has('env-llm'), true);

    // A fresh instance reads it back from disk.
    assert.equal(new SecretsStore(file).get('env-llm'), 'sk-test-123');

    // An empty value deletes rather than storing a blank.
    store.set('env-llm', '   ');
    assert.equal(store.has('env-llm'), false);
    assert.equal(new SecretsStore(file).has('env-llm'), false);

    store.set('a', '1');
    store.set('b', '2');
    store.prune(['a']);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    assert.deepEqual(Object.keys(onDisk), ['a']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('secrets store: a corrupt file is treated as empty, not fatal', () => {
  const home = tmp();
  try {
    const file = join(home, 'secrets.json');
    writeFileSync(file, '{not json', 'utf8');
    const store = new SecretsStore(file);
    assert.equal(store.has('env-llm'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('normalizeConfig: a key pasted into apiKeyEnv is refused', () => {
  const config = defaultConfig();
  config.models[0] = { ...config.models[0], apiKeyEnv: 'sk-live-abc123' };

  // Loading an existing config must not throw — it drops the literal instead.
  const loaded = normalizeConfig(structuredClone(config));
  assert.equal(loaded.models[0].apiKeyEnv, undefined);

  // Saving from the UI must fail loudly, so the user is told where the key belongs.
  assert.throws(
    () => normalizeConfig(structuredClone(config), { strict: true }),
    /apiKeyEnv must be an environment variable name/,
  );

  // A real variable name survives.
  const named = structuredClone(config) as ReturnType<typeof defaultConfig>;
  named.models[0] = { ...named.models[0], apiKeyEnv: 'BEECODE_LLM_API_KEY' };
  assert.equal(normalizeConfig(named, { strict: true }).models[0].apiKeyEnv, 'BEECODE_LLM_API_KEY');
});

test('resolveApiKey: stored key wins over the environment', () => {
  const preset = {
    id: 'env-llm',
    label: 'Custom endpoint',
    provider: 'openai-compatible' as const,
    model: 'deepseek-flash',
    baseUrl: 'https://api.example.dev/v1',
    apiKeyEnv: 'BEECODE_LLM_API_KEY',
  };
  try {
    setSecretResolver((p) => (p.id === 'env-llm' ? 'sk-stored' : undefined));
    process.env.BEECODE_LLM_API_KEY = 'sk-from-env';
    assert.equal(resolveApiKey(preset), 'sk-stored');

    setSecretResolver(undefined);
    assert.equal(resolveApiKey(preset), 'sk-from-env');

    // Remote endpoint + no key must fail here, with an actionable message, not as a server 401.
    delete process.env.BEECODE_LLM_API_KEY;
    assert.throws(() => resolveApiKey(preset), /Missing API key for "Custom endpoint"/);

    // A loopback endpoint may legitimately run keyless.
    assert.equal(resolveApiKey({ ...preset, baseUrl: 'http://127.0.0.1:11434/v1' }), undefined);
    assert.equal(resolveApiKey({ ...preset, baseUrl: undefined }), undefined);
  } finally {
    setSecretResolver(undefined);
    delete process.env.BEECODE_LLM_API_KEY;
  }
});
