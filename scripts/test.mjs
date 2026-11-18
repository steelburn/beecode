// Test runner: bundles each *.test.ts with esbuild (so the source stays extensionless
// ESM/TS) into CJS and runs the bundle with node:test. No test dependencies.
import * as esbuild from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist-test');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

async function findTests(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-test') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findTests(full)));
    else if (/\.test\.ts$/.test(entry.name)) found.push(full);
  }
  return found;
}

const all = await findTests(resolve(root, 'src'));
const selected = only.length ? all.filter((f) => only.some((o) => f.includes(o))) : all;

if (!selected.length) {
  console.error(`[test] no test files matched ${only.join(', ') || 'src/'}`);
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });

const outputs = [];
try {
  for (const file of selected) {
    const outfile = join(outDir, relative(resolve(root, 'src'), file).replace(/\\/g, '/').replace(/\.ts$/, '.cjs'));
    await esbuild.build({
      entryPoints: [file],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      sourcemap: 'inline',
      logLevel: 'warning',
    });
    outputs.push(outfile);
    console.log(`[test] bundled ${relative(root, file)}`);
  }
} catch (err) {
  console.error('[test] bundling failed:', err);
  process.exit(1);
}

console.log(`[test] running ${outputs.length} test file(s)`);
const child = spawn(process.execPath, ['--test', ...outputs], { stdio: 'inherit', cwd: root });
child.on('error', (err) => {
  console.error('[test] failed to start node --test:', err);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  console.log(`[test] node --test exited with ${code ?? signal}`);
  process.exit(code ?? 1);
});
