// Launch the app in --smoke mode and assert it actually boots.
//
// Two quirks are handled here: ELECTRON_RUN_AS_NODE must not leak into the child (some
// IDEs/terminals export it, which turns Electron into plain Node), and the Electron
// binary is invoked directly instead of through a shell shim.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
);

if (!existsSync(exe)) {
  console.error(`[smoke] electron binary not found at ${exe} — run "npm install" first`);
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(exe, ['.', '--smoke'], { stdio: 'inherit', env, cwd: root });
process.exit(result.status === null ? 1 : result.status);
