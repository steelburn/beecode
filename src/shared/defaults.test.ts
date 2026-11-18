import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig, normalizeConfig } from './defaults';
import type { BeeCodeConfig } from './protocol';

function configWith(models: unknown[], overrides: Partial<BeeCodeConfig> = {}): BeeCodeConfig {
  const base = defaultConfig();
  return {
    ...base,
    models: models as BeeCodeConfig['models'],
    defaultModelId: 'first',
    ...overrides,
  };
}

test('normalizeConfig keeps valid presets and derives a stable id', () => {
  const result = normalizeConfig(
    configWith([
      { id: '  My Model! ', label: ' My Model ', provider: 'openai-compatible', model: ' deepseek-v4-flash ' },
    ]),
  );
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, 'my-model');
  assert.equal(result.models[0].label, 'My Model');
  assert.equal(result.models[0].model, 'deepseek-v4-flash');
});

test('normalizeConfig drops presets with no model and de-duplicates ids', () => {
  const result = normalizeConfig(
    configWith([
      { id: 'a', label: 'A', provider: 'openai', model: 'gpt-4o' },
      { id: 'a', label: 'A again', provider: 'openai', model: 'gpt-4o-mini' },
      { id: 'b', label: 'B', provider: 'openai', model: '   ' },
    ]),
  );
  assert.deepEqual(
    result.models.map((model) => model.model),
    ['gpt-4o'],
  );
});

test('normalizeConfig repoints a dangling defaultModelId at the first model', () => {
  const result = normalizeConfig(
    configWith([{ id: 'kept', label: 'Kept', provider: 'openai', model: 'gpt-4o' }], {
      defaultModelId: 'gone',
    }),
  );
  assert.equal(result.defaultModelId, 'kept');
});

test('normalizeConfig strips a trailing slash from a custom base URL', () => {
  const result = normalizeConfig(
    configWith([
      {
        id: 'custom',
        label: 'Custom',
        provider: 'openai-compatible',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://gateway.example.com/v1//',
      },
    ]),
  );
  assert.equal(result.models[0].baseUrl, 'https://gateway.example.com/v1');
});

test('normalizeConfig refuses a config with no usable preset', () => {
  assert.throws(
    () => normalizeConfig(configWith([{ id: 'b', label: 'B', provider: 'openai', model: '' }])),
    /at least one model preset is required/,
  );
});

test('normalizeConfig falls back to the default working directory when blank', () => {
  const base = defaultConfig();
  const result = normalizeConfig({
    ...configWith([{ id: 'a', label: 'A', provider: 'openai', model: 'gpt-4o' }]),
    agent: { ...base.agent, workingDir: '   ' },
  });
  assert.equal(result.agent.workingDir, base.agent.workingDir);
});
