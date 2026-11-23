import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let cached: string | undefined;

/**
 * The application version, read from the nearest `package.json` that names this app.
 *
 * The service bundle runs from `dist/` in a checkout and from inside `app.asar` when packaged,
 * while the test runner bundles the sources into `dist-test/`, so the lookup walks up instead
 * of assuming one layout. `package.json` stays the only place the version is written down.
 */
export function serviceVersion(): string {
  if (cached !== undefined) return cached;
  let dir = __dirname;
  for (let i = 0; i < 5; i += 1) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'beecode' && typeof pkg.version === 'string') {
          cached = pkg.version;
          return cached;
        }
      } catch {
        /* unreadable or not JSON - keep walking up */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = process.env.npm_package_version ?? '0.0.0';
  return cached;
}
