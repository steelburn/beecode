// beeCode build: four esbuild bundles (main, preload, service, renderer) + static assets.
// No runtime dependencies — everything the app executes is either bundled or a Node builtin.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'node20',
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': watch ? '"development"' : '"production"',
  },
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  { ...common, entryPoints: [resolve(root, 'src/main/main.ts')], outfile: resolve(out, 'main.js'), platform: 'node', format: 'cjs' },
  { ...common, entryPoints: [resolve(root, 'src/preload/preload.ts')], outfile: resolve(out, 'preload.js'), platform: 'node', format: 'cjs' },
  { ...common, entryPoints: [resolve(root, 'src/service/index.ts')], outfile: resolve(out, 'service.js'), platform: 'node', format: 'cjs' },
  {
    ...common,
    entryPoints: [resolve(root, 'src/renderer/main.ts')],
    outfile: resolve(out, 'renderer', 'renderer.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome124',
    external: [],
    define: {},
  },
];

async function copyAssets() {
  await mkdir(out, { recursive: true });
  await cp(resolve(root, 'src/renderer'), resolve(out, 'renderer'), {
    recursive: true,
    filter: (src) => !src.endsWith('.ts'),
  });
}

await rm(out, { recursive: true, force: true });

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  await copyAssets();
  console.log('[build] watching — edit, then relaunch Electron');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  await copyAssets();
  console.log('[build] dist/ ready');
}
