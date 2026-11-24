import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SLATE_RECIPE_MAX_STEPS,
  normaliseSlateRecipe,
  recipeStepKind,
  recipeStepPath,
  recipeStepUrl,
} from './slateRecipe';

test('a recipe keeps order, stringifies scalars and drops an exact duplicate', () => {
  const steps = normaliseSlateRecipe([
    { tool: 'fs_read', args: { path: 'data/sales.csv', limit: 200 } },
    { tool: 'fs_read', args: { path: 'data/regions.csv' }, at: '2026-01-01T00:00:00.000Z' },
    { tool: 'fs_read', args: { path: 'data/sales.csv', limit: 200 } },
  ]);

  assert.deepEqual(steps, [
    { tool: 'fs_read', args: { path: 'data/sales.csv', limit: '200' } },
    { tool: 'fs_read', args: { path: 'data/regions.csv' }, at: '2026-01-01T00:00:00.000Z' },
  ]);
});

test('an absent recipe is empty, not an error', () => {
  assert.deepEqual(normaliseSlateRecipe(undefined), []);
  assert.deepEqual(normaliseSlateRecipe(null), []);
  assert.deepEqual(normaliseSlateRecipe([]), []);
});

test('a recipe that replays a write is refused, naming the entry', () => {
  assert.throws(
    () =>
      normaliseSlateRecipe([
        { tool: 'fs_read', args: { path: 'a.csv' } },
        { tool: 'shell', args: { command: 'rm -rf build' } },
      ]),
    /recipe step 2 replays "shell", which writes/,
  );
});

test('a non-array, a nameless step and too many steps are refused', () => {
  assert.throws(() => normaliseSlateRecipe({ tool: 'fs_read' }), /must be an array/);
  assert.throws(() => normaliseSlateRecipe([{}]), /needs a tool name/);

  const many = Array.from({ length: SLATE_RECIPE_MAX_STEPS + 1 }, (_, index) => ({
    tool: 'fs_read',
    args: { path: `f${index}.csv` },
  }));
  assert.throws(() => normaliseSlateRecipe(many), /the limit is 12/);
});

test('a payload smuggled in as an arg value is refused', () => {
  // The whole point of references-only: a recipe names where the data lives, so a nested
  // value is refused rather than serialised and stored beside the version.
  assert.throws(
    () => normaliseSlateRecipe([{ tool: 'fs_read', args: { content: { body: 'x' } } }]),
    /references, not payloads/,
  );
  assert.throws(() => normaliseSlateRecipe([{ tool: 'fs_read', args: ['a'] }]), /flat object/);
});

test('a network step has to name a url', () => {
  assert.throws(() => normaliseSlateRecipe([{ tool: 'fetch', args: {} }]), /names no url/);
  assert.equal(
    normaliseSlateRecipe([{ tool: 'fetch', args: { url: 'https://api.example.com/x' } }]).length,
    1,
  );
});

test('steps classify as read, network, write or other, and expose their address', () => {
  assert.equal(recipeStepKind('fs_read'), 'read');
  assert.equal(recipeStepKind('fetch'), 'network');
  assert.equal(recipeStepKind('fs_write'), 'write');
  assert.equal(recipeStepKind('kb_search'), 'other');

  assert.equal(recipeStepPath({ tool: 'fs_read', args: { path: 'a.csv' } }), 'a.csv');
  assert.equal(recipeStepPath({ tool: 'fs_read', args: {} }), undefined);
  assert.equal(
    recipeStepUrl({ tool: 'fetch', args: { url: 'https://x.test/a' } }),
    'https://x.test/a',
  );
  assert.equal(recipeStepUrl({ tool: 'fetch', args: {} }), undefined);
});
