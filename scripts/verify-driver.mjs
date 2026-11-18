// Bundles scripts/verify-driver.ts with esbuild and runs it with plain node,
// so the live desktop check needs no extra tooling.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist-test', 'verify-driver.cjs');

await esbuild.build({
  entryPoints: [join(root, 'scripts', 'verify-driver.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
});

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const res = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root, env });
process.exit(res.status === null ? 1 : res.status);
