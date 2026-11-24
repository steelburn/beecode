// Verifies the SHIPPED artifact, not dist/: extracts release/win-unpacked/resources/app.asar
// into a temp dir, starts the service from inside that extraction, and checks that
//   - the new desktop_click / desktop_resize tools are in the packaged tool list,
//   - the packaged config carries the .env.llm preset without leaking the key,
//   - the Windows driver actually runs from the packaged bundle (read-only window listing),
//   - the Settings panel (endpoint, model, working directory) is inside the archive,
//   - the packaged bundles are byte-identical to dist/ (no stale build),
//   - the LLM answers through the packaged service,
//   - the NSIS installer actually installs, and the INSTALLED exe boots its window
//     (a build cut short mid-write leaves an installer that dies with "NSIS Error").
// Run `npm run dist` first; this checks what electron-builder produced.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ASAR = 'release/win-unpacked/resources/app.asar';

if (!existsSync(ASAR)) {
  console.error(`${ASAR} not found — run "npm run dist" first.`);
  process.exit(1);
}

// @electron/asar ships with electron-builder, so no extra dependency is needed.
const asar = (await import('@electron/asar')).default ?? (await import('@electron/asar'));
const workDir = mkdtempSync(join(tmpdir(), 'beecode-installer-'));
asar.extractAll(ASAR, workDir);
console.log(`extracted ${ASAR} -> ${workDir}`);

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- Static payload checks: these prove the SHIPPED UI, not just the backend. ---
// The RPC checks below exercise the service; these prove the Settings panel made it
// into the archive, so a broken packaging step cannot pass on the service alone.
const packedRendererPath = join(workDir, 'dist/renderer/renderer.js');
const packedIndexPath = join(workDir, 'dist/renderer/index.html');
const packedRenderer = existsSync(packedRendererPath) ? readFileSync(packedRendererPath, 'utf8') : '';
const packedIndex = existsSync(packedIndexPath) ? readFileSync(packedIndexPath, 'utf8') : '';
check('packaged renderer bundle present', packedRenderer.length > 0, `${packedRenderer.length} bytes`);
check('Settings panel rendered in packaged renderer', packedRenderer.includes('renderSettings'));
check(
  'model preset editor + working directory shipped',
  ['Base URL', '+ Add model', 'Working directory', 'Browse'].every((s) => packedRenderer.includes(s)),
);
check('Settings dialog in packaged index.html', /id="settings-modal"/.test(packedIndex));
check('Terminal drawer in packaged index.html', /id="drawer-body"/.test(packedIndex));

// Byte-identity with dist/ rules out shipping a stale build.
try {
  const localRenderer = readFileSync('dist/renderer/renderer.js');
  const packedRendererBuf = readFileSync(packedRendererPath);
  check('packaged renderer byte-identical to dist/', localRenderer.equals(packedRendererBuf));
} catch (err) {
  check('packaged renderer byte-identical to dist/', false, String(err));
}
try {
  const localService = readFileSync('dist/service.js');
  const packedService = readFileSync(join(workDir, 'dist/service.js'));
  check('packaged service byte-identical to dist/', localService.equals(packedService));
} catch (err) {
  check('packaged service byte-identical to dist/', false, String(err));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

const requestedPort = await freePort();
const child = spawn(process.execPath, [join(workDir, 'dist/service.js'), '--transport=http', `--port=${requestedPort}`], {
  env: { ...process.env, BEECODE_SERVICE_TOKEN: '', ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stderr = [];
child.stderr.on('data', (d) => stderr.push(String(d)));

const { token, port } = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('service did not become ready in 30s')), 30_000);
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += String(d);
    for (const line of buf.split('\n')) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'beecode-service-ready') {
          clearTimeout(timer);
          resolve({ token: msg.token, port: msg.port });
        }
      } catch {
        /* partial line or log noise */
      }
    }
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`service exited early (code ${code})\n${stderr.join('')}`));
  });
});

let seq = 0;
async function rpc(method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    // connection: close — while an agent run has a tool child alive the service resets a
    // reused keep-alive socket, which surfaces as ECONNRESET on the very next call. That is
    // a harness-only artifact (the app does not use this HTTP transport), so do not pool here.
    headers: { 'content-type': 'application/json', connection: 'close', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

try {
  const health = await rpc('service.health');
  check('packaged service starts and answers', health.ok === true, JSON.stringify(health).slice(0, 110));

  const tools = await rpc('tools.list');
  const names = tools.map((t) => t.name);
  const byName = new Map(tools.map((t) => [t.name, t]));
  check('tools.list from the packaged bundle', names.length >= 27, `${names.length} tools`);
  check('desktop_click shipped', names.includes('desktop_click'));
  check('desktop_resize shipped', names.includes('desktop_resize'));
  const clickSchema = JSON.stringify(byName.get('desktop_click')?.inputSchema ?? {});
  const resizeSchema = JSON.stringify(byName.get('desktop_resize')?.inputSchema ?? {});
  check('desktop_click takes x/y', /"x"/.test(clickSchema) && /"y"/.test(clickSchema));
  check('desktop_resize takes width/height', /"width"/.test(resizeSchema) && /"height"/.test(resizeSchema));

  const configJson = JSON.stringify(await rpc('config.get'));
  check('env-llm preset present in the packaged config', configJson.includes('env-llm'));
  check('no literal API key in the packaged config payload', !/sk-[A-Za-z0-9]/.test(configJson));

  // Drive the real Windows driver from inside the packaged bundle. A read-only listing
  // proves the PowerShell -File transport and the driver preludes survive packaging;
  // the session is created in ask mode and the prompt forbids any mutation.
  const session = await rpc('session.create', { title: 'packed verify', mode: 'ask' });
  await rpc('session.prompt', {
    sessionId: session.id,
    text:
      'Use the read-only desktop window listing tool to enumerate the open windows on this desktop. ' +
      'Do NOT open, close, move, resize, click, type or focus anything. Then reply with the number of windows.',
  });

  const deadline = Date.now() + 150_000;
  let snapshot = await rpc('session.get', { sessionId: session.id });
  while (Date.now() < deadline && snapshot.status !== 'idle') {
    for (const req of snapshot.pendingApprovals ?? []) {
      await rpc('approval.respond', { sessionId: session.id, approvalId: req.id, decision: 'deny' });
    }
    await new Promise((r) => setTimeout(r, 2000));
    snapshot = await rpc('session.get', { sessionId: session.id });
  }

  const entries = snapshot.entries ?? [];
  const listed = entries.filter((e) => e.role === 'tool').find((e) => /window/i.test(e.text ?? ''));
  const windowCount = /"count"\s*:\s*(\d+)/.exec(listed?.text ?? '')?.[1] ?? 'n/a';
  check('driver ran inside the packaged bundle', Boolean(listed), `count=${windowCount}`);
  check('driver returned real windows', Number(windowCount) > 0, `count=${windowCount}`);
  const assistant = entries.filter((e) => e.role === 'assistant').pop();
  check('LLM answered through the packaged service', Boolean((assistant?.text ?? '').trim()), (assistant?.text ?? '').trim().slice(0, 120));

  await rpc('service.shutdown').catch(() => {});
} catch (err) {
  check('packaged verification ran without throwing', false, String(err));
} finally {
  child.kill();
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.warn(`could not remove ${workDir} (still locked) — delete it manually`);
  }
}

/** Run a command to completion, collecting output; kills it on timeout. */
function run(cmd, args, timeoutMs = 120000, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (d) => stdout.push(String(d)));
    child.stderr?.on('data', (d) => stderr.push(String(d)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: [...stderr, String(e)] });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// --- Installed-artifact stage -----------------------------------------------------
// "It installed but the app does not execute" is the failure this script exists to
// catch, and only running the installer proves it: an interrupted build writes a
// truncated NSIS payload whose bootstrap dies with "NSIS Error" and installs nothing,
// while every check on release/win-unpacked still passes. So install for real and boot
// the installed exe with --smoke (scratch user-data, GUI quirks stripped from env).
if (process.platform === 'win32') {
  const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  // Name the artifact for the version being packaged: release/ can hold older builds, and
  // picking whichever .exe came first verified a stale installer against fresh code.
  const expectedSetup = `beeCode Setup ${pkgVersion}.exe`;
  const releaseFiles = readdirSync('release');
  const setup = releaseFiles.includes(expectedSetup) ? expectedSetup : undefined;
  const otherSetups = releaseFiles.filter((f) => /^beeCode Setup .*\.exe$/.test(f));
  check(
    'installer artifact present for the packaged version',
    Boolean(setup),
    setup ?? `release/${expectedSetup} missing (found: ${otherSetups.join(', ') || 'none'})`,
  );
  if (setup) {
    const setupPath = join('release', setup);
    const sizeMb = (statSync(setupPath).size / 1024 / 1024).toFixed(1);
    // The updater serves whatever latest.yml names, so a manifest that disagrees with the
    // file on disk is a broken release even when the installer itself boots.
    const manifest = readFileSync('release/latest.yml', 'utf8');
    const manifestVersion = /^version:\s*(\S+)/m.exec(manifest)?.[1];
    const manifestSize = Number(/\n\s+size:\s*(\d+)/.exec(manifest)?.[1] ?? 0);
    const fileSize = statSync(setupPath).size;
    check(
      'latest.yml names this version and its size matches the file',
      manifestVersion === pkgVersion && manifestSize === fileSize,
      `manifest ${manifestVersion} / ${manifestSize} bytes, file ${pkgVersion} / ${fileSize} bytes`,
    );
    const installed = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'beeCode');
    const install = await run(setupPath, ['/S'], 420000);
    const installedExe = join(installed, 'beeCode.exe');
    check(
      'installer runs and installs the app',
      install.code === 0 && existsSync(installedExe),
      `exit=${install.code}, installer ${sizeMb} MB` + (install.code === 0 ? '' : ' (is beeCode still running?)'),
    );
    const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
    const installedAsar = join(installed, 'resources', 'app.asar');
    // NSIS can exit before the last files land, so poll briefly instead of racing the deploy.
    let payloadMatches = false;
    for (let i = 0; i < 30 && !payloadMatches; i += 1) {
      payloadMatches = existsSync(installedAsar) && sha(installedAsar) === sha(ASAR);
      if (!payloadMatches) await new Promise((r) => setTimeout(r, 1000));
    }
    check('installed payload matches release/win-unpacked', payloadMatches);
    if (existsSync(installedExe)) {
      const userData = mkdtempSync(join(tmpdir(), 'beecode-installed-'));
      const env = { ...process.env };
      for (const key of [
        'ELECTRON_RUN_AS_NODE',
        'VSCODE_NODE_COMPILE_CACHE_ROOT',
        'VSCODE_NODE_COMPILE_CACHE_KIND',
        'ELECTRON_NO_ATTACH_CONSOLE',
      ]) {
        delete env[key];
      }
      // --smoke writes its report relative to the cwd, so run it inside the scratch dir.
      const boot = await run(
        installedExe,
        ['--smoke', `--user-data-dir=${userData}`],
        240000,
        { cwd: userData, env },
      );
      let report = null;
      try {
        report = JSON.parse(readFileSync(join(userData, 'dist-test', 'smoke-report.json'), 'utf8'));
      } catch {
        report = null;
      }
      check(
        'installed app executes and loads its window',
        Boolean(report?.serviceReady && report?.windowLoaded),
        report ? `serviceReady=${report.serviceReady} loaded=${report.windowLoaded}` : `no smoke report (exit=${boot.code})`,
      );
      if (!report && boot.stderr.length) console.log('stderr:', boot.stderr.join('').slice(-600));
      rmSync(userData, { recursive: true, force: true });
    }
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join('; '));
  if (stderr.length) console.log('stderr:', stderr.join('').slice(-800));
}
process.exit(failed.length ? 1 : 0);
