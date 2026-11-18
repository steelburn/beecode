import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildEnvPreset,
  ENV_FILE_OVERRIDE,
  ENV_PRESET_ID,
  ENV_PRESET_KEY_ENV,
  loadEnvPreset,
  parseEnvFile,
} from './envPreset';

test('parseEnvFile handles export prefixes, quotes and comments', () => {
  const vars = parseEnvFile(
    [
      '# a comment',
      '',
      'API_KEY=sk-plain',
      'export URL="https://api.example.dev/v1"',
      "MODEL='deepseek-flash'",
      'TRAILING=value # inline note',
      'not a pair',
      '=missing-key',
    ].join('\r\n'),
  );
  assert.equal(vars.API_KEY, 'sk-plain');
  assert.equal(vars.URL, 'https://api.example.dev/v1');
  assert.equal(vars.MODEL, 'deepseek-flash');
  assert.equal(vars.TRAILING, 'value');
  assert.deepEqual(Object.keys(vars).sort(), ['API_KEY', 'MODEL', 'TRAILING', 'URL']);
});

test('buildEnvPreset maps API_KEY, URL and MODEL onto an openai-compatible preset', () => {
  const { preset, warnings } = buildEnvPreset({
    API_KEY: 'sk-test',
    URL: 'https://api.example.dev/v1/',
    MODEL: 'deepseek-v4-flash',
  });
  assert.deepEqual(warnings, []);
  assert.ok(preset);
  assert.equal(preset.id, ENV_PRESET_ID);
  assert.equal(preset.provider, 'openai-compatible');
  assert.equal(preset.model, 'deepseek-v4-flash');
  // Trailing slash trimmed so the client can append `/chat/completions` verbatim.
  assert.equal(preset.baseUrl, 'https://api.example.dev/v1');
  // The key itself is never part of the preset — only the variable it can be read from.
  assert.equal(preset.apiKeyEnv, ENV_PRESET_KEY_ENV);
  assert.equal(JSON.stringify(preset).includes('sk-test'), false);
  assert.match(preset.label, /api\.example\.dev/);
});

test('buildEnvPreset refuses to guess a model it was not given', () => {
  const missingModel = buildEnvPreset({ API_KEY: 'k', URL: 'https://x.dev/v1' });
  assert.equal(missingModel.preset, undefined);
  assert.match(missingModel.warnings[0], /MODEL/);

  const missingUrl = buildEnvPreset({ API_KEY: 'k', MODEL: 'm' });
  assert.equal(missingUrl.preset, undefined);
  assert.match(missingUrl.warnings[0], /URL/);
});

test('buildEnvPreset warns but still loads when the key is absent', () => {
  const { preset, warnings } = buildEnvPreset({ URL: 'https://x.dev/v1', MODEL: 'm' });
  assert.ok(preset);
  assert.match(warnings.join(' '), /API_KEY/);
});

test('loadEnvPreset reads the file, publishes the key and reports its source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-env-'));
  const file = join(dir, '.env.llm');
  await writeFile(file, 'API_KEY=sk-from-file\nURL=https://api.example.dev/v1\nMODEL=m1\n', 'utf8');
  const previous = process.env[ENV_FILE_OVERRIDE];
  const previousKey = process.env[ENV_PRESET_KEY_ENV];
  process.env[ENV_FILE_OVERRIDE] = file;
  try {
    const result = loadEnvPreset(dir);
    assert.equal(result.source, file);
    assert.equal(result.preset?.model, 'm1');
    assert.equal(process.env[ENV_PRESET_KEY_ENV], 'sk-from-file');
  } finally {
    if (previous === undefined) delete process.env[ENV_FILE_OVERRIDE];
    else process.env[ENV_FILE_OVERRIDE] = previous;
    if (previousKey === undefined) delete process.env[ENV_PRESET_KEY_ENV];
    else process.env[ENV_PRESET_KEY_ENV] = previousKey;
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadEnvPreset stays silent when no file exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beecode-env-empty-'));
  const previous = process.env[ENV_FILE_OVERRIDE];
  process.env[ENV_FILE_OVERRIDE] = join(dir, 'absent.env');
  try {
    const result = loadEnvPreset(dir);
    assert.equal(result.preset, undefined);
    assert.deepEqual(result.warnings, []);
  } finally {
    if (previous === undefined) delete process.env[ENV_FILE_OVERRIDE];
    else process.env[ENV_FILE_OVERRIDE] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
