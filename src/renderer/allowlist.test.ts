import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RENDERER_METHODS } from '../shared/bridge';

/**
 * The main process refuses any RPC the renderer is not explicitly allowed to call
 * (`renderer may not call "<method>"`). The guard is only as good as the allow-list it
 * reads, and a newly shipped renderer feature that forgets its entry fails at *runtime*
 * with an error inside a panel — that is how the Workspace Files view and the skill
 * drop-zone both died on their first click. This test compares the two sides statically:
 * every method the renderer invokes must be in RENDERER_METHODS.
 */
function rendererInvokes(): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/\.invoke\(\s*'([a-zA-Z.]+)'/g)) found.add(match[1]);
      }
    }
  };
  walk('src/renderer');
  return [...found].sort();
}

test('every method the renderer invokes is in RENDERER_METHODS', () => {
  const allowed = new Set<string>(RENDERER_METHODS);
  const blocked = rendererInvokes().filter((method) => !allowed.has(method));
  assert.deepEqual(
    blocked,
    [],
    `renderer invokes methods the main process rejects: ${blocked.join(', ')} — add them to RENDERER_METHODS in src/shared/bridge.ts`,
  );
});

test('RENDERER_METHODS has no duplicates', () => {
  assert.equal(new Set(RENDERER_METHODS).size, RENDERER_METHODS.length);
});
