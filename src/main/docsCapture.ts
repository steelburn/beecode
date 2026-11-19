/**
 * Screenshot capture for the README (`npm run docs:screenshots`).
 *
 * The images committed under `docs/images/` are produced from a real Electron run, not
 * mockups: the app boots normally, a local fixture page is served over 127.0.0.1 and opened
 * in the internal browser, the AI cursor is parked on a control with the normal `hover`
 * action, and the window is captured with `capturePage`.
 *
 * Two captures are written:
 *   - `app-window.png`  the whole window, composited from the renderer capture plus the
 *                       browser-view capture placed at the dock's rectangle (a child
 *                       `WebContentsView` is a separate surface and is NOT part of the
 *                       renderer's `capturePage`);
 *   - `ai-cursor.png`   the browser surface alone, so the cursor ring and label are legible.
 *
 * `capture-report.json` records the dimensions and pixel statistics of every image, which is
 * how CI — and a blind agent — can tell a real capture from a blank one.
 */
import { BrowserWindow, nativeImage } from 'electron';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserHost } from './browser/host';

/** A page that looks like something a user would ask the agent to work on. */
const FIXTURE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Northwind Support — Tickets</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; color: #1f2430; background: #fff; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 22px; border-bottom: 1px solid #e5e8ef; }
  header .mark { width: 26px; height: 26px; border-radius: 7px; background: #2f6bff; color: #fff;
    font-weight: 600; display: grid; place-items: center; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  nav { margin-left: auto; display: flex; gap: 18px; color: #5b6577; font-size: 13px; }
  nav b { color: #2f6bff; font-weight: 600; }
  main { display: grid; grid-template-columns: 190px 1fr; min-height: calc(100vh - 55px); }
  aside { border-right: 1px solid #e5e8ef; padding: 16px 12px; background: #fafbfd; }
  aside a { display: block; padding: 7px 10px; border-radius: 6px; color: #4a5468; text-decoration: none; font-size: 13px; }
  aside a.on { background: #eaf0ff; color: #2049bf; font-weight: 600; }
  section { padding: 20px 24px; }
  .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .bar h2 { font-size: 17px; margin: 0; font-weight: 600; }
  .bar .spacer { flex: 1; }
  .pill { font-size: 11px; padding: 3px 9px; border-radius: 999px; background: #eef1f7; color: #556077; }
  button { font: inherit; border-radius: 7px; border: 1px solid #d3daea; background: #fff; color: #33405a;
    padding: 7px 13px; cursor: pointer; }
  button.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; font-weight: 600;
    box-shadow: 0 1px 2px rgba(47, 107, 255, .35); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 600; color: #6b7488; font-size: 12px;
    text-transform: uppercase; letter-spacing: .03em; padding: 8px 10px; border-bottom: 1px solid #e5e8ef; }
  td { padding: 11px 10px; border-bottom: 1px solid #f0f2f7; }
  td.id { color: #8b93a5; font-variant-numeric: tabular-nums; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; }
  .tag.open { background: #e7f0ff; color: #1d4ed8; }
  .tag.rev { background: #fff3dc; color: #96631a; }
  .tag.done { background: #e6f7ec; color: #1c7a42; }
  .meta { color: #8b93a5; font-size: 12px; }
</style>
</head>
<body>
<header>
  <div class="mark">N</div>
  <h1>Northwind Support</h1>
  <nav><span>Dashboard</span><b>Tickets</b><span>Customers</span><span>Reports</span></nav>
</header>
<main>
  <aside>
    <a class="on" href="#">Open tickets</a>
    <a href="#">Assigned to me</a>
    <a href="#">Waiting on customer</a>
    <a href="#">Closed this week</a>
  </aside>
  <section>
    <div class="bar">
      <h2>Open tickets</h2>
      <span class="pill">12 open</span>
      <span class="spacer"></span>
      <button>Filter</button>
      <button class="primary" id="cta">Create ticket</button>
    </div>
    <table>
      <thead>
        <tr><th>Ticket</th><th>Subject</th><th>Priority</th><th>Status</th><th>Updated</th></tr>
      </thead>
      <tbody>
        <tr><td class="id">#4812</td><td>Invoice PDF renders a blank second page</td><td>High</td>
          <td><span class="tag open">Open</span></td><td class="meta">2 min ago</td></tr>
        <tr><td class="id">#4811</td><td>SSO login loop for the Contoso tenant</td><td>Urgent</td>
          <td><span class="tag rev">In review</span></td><td class="meta">18 min ago</td></tr>
        <tr><td class="id">#4809</td><td>Bulk import times out above 5k rows</td><td>Normal</td>
          <td><span class="tag open">Open</span></td><td class="meta">1 h ago</td></tr>
        <tr><td class="id">#4804</td><td>Weekly digest email missing totals</td><td>Normal</td>
          <td><span class="tag done">Done</span></td><td class="meta">3 h ago</td></tr>
        <tr><td class="id">#4801</td><td>API key rotation instructions unclear</td><td>Low</td>
          <td><span class="tag open">Open</span></td><td class="meta">yesterday</td></tr>
      </tbody>
    </table>
  </section>
</main>
</body>
</html>`;

export interface CaptureOptions {
  window: BrowserWindow;
  browser: BrowserHost;
  /** Directory the PNGs are written to (usually `docs/images`). */
  outDir: string;
  /** Extra settle time after the window loads, ms. */
  settleMs?: number;
}

export interface ImageStats {
  file: string;
  width: number;
  height: number;
  bytes: number;
  /** Fraction of sampled pixels that are near-black — a blank capture scores ~1. */
  darkShare: number;
  /** Distinct RGB values among sampled pixels. */
  distinctColors: number;
  blank: boolean;
}

export interface CaptureReport {
  ok: boolean;
  images: ImageStats[];
  hovered: boolean;
  /** True when moving the cursor changes the captured pixels. */
  cursorPaints?: boolean;
  /** Fraction of sampled points inside the dock rectangle that match the surface pixels. */
  regionMatch?: number;
  /** Points (`fx,fy` inside the rectangle) that did not match, for diagnosis. */
  regionMismatch?: string[];
  errors: string[];
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function startFixtureServer(): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(FIXTURE_PAGE);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('the fixture server did not report a port'));
        return;
      }
      resolve({ url: `http://127.0.0.1:${address.port}/`, server });
    });
  });
}

function measure(file: string, png: Buffer): ImageStats {
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const pixels = Math.max(1, Math.floor(bitmap.length / 4));
  let dark = 0;
  let sampled = 0;
  const colors = new Set<number>();
  // Sample on a stride so a 2560x1600 capture stays fast but keeps its distribution.
  const stride = Math.max(1, Math.floor(pixels / 40000));
  for (let i = 0; i < pixels; i += stride) {
    const offset = i * 4;
    const b = bitmap[offset];
    const g = bitmap[offset + 1];
    const r = bitmap[offset + 2];
    if (r + g + b < 24) dark += 1;
    colors.add((r << 16) | (g << 8) | b);
    sampled += 1;
  }
  const darkShare = sampled ? dark / sampled : 1;
  return {
    file,
    width,
    height,
    bytes: png.length,
    darkShare: Math.round(darkShare * 1000) / 1000,
    distinctColors: colors.size,
    blank: darkShare > 0.9 || colors.size < 8,
  };
}

/**
 * Compare a grid of points inside the dock rectangle of the composited window against the
 * browser-surface image itself. 1 means the surface is exactly where the dock asked for it.
 */
function sampleRegion(windowPng: Buffer, overlayPng: Buffer, rect: Rect, scale: number, out: string[] = []): number {
  const win = nativeImage.createFromBuffer(windowPng);
  const over = nativeImage.createFromBuffer(overlayPng);
  const winSize = win.getSize();
  const overSize = over.getSize();
  if (!winSize.width || !winSize.height || !overSize.width || !overSize.height) return 0;
  const winBits = win.toBitmap();
  const overBits = over.toBitmap();
  const x0 = Math.round(rect.x * scale);
  const y0 = Math.round(rect.y * scale);
  // Same integers the compositor used, otherwise a half-pixel shift shows up as
  // antialiasing noise on every text row.
  const dw = Math.round(rect.width * scale);
  const dh = Math.round(rect.height * scale);
  let same = 0;
  let total = 0;
  for (let i = 1; i < 10; i += 1) {
    for (let j = 1; j < 6; j += 1) {
      const fx = i / 10;
      const fy = j / 6;
      const wx = Math.round(x0 + fx * dw);
      const wy = Math.round(y0 + fy * dh);
      const ox = Math.round(fx * overSize.width);
      const oy = Math.round(fy * overSize.height);
      total += 1;
      if (wx < 0 || wy < 0 || wx >= winSize.width || wy >= winSize.height) continue;
      const wi = (wy * winSize.width + wx) * 4;
      const oi = (oy * overSize.width + ox) * 4;
      const diff =
        Math.abs(winBits[wi] - overBits[oi]) +
        Math.abs(winBits[wi + 1] - overBits[oi + 1]) +
        Math.abs(winBits[wi + 2] - overBits[oi + 2]);
      if (diff <= 12) same += 1;
      else out.push(`${fx.toFixed(2)},${fy.toFixed(2)}`);
    }
  }
  return total ? Math.round((same / total) * 1000) / 1000 : 0;
}

/** Poll the renderer until the dock has reported a real rectangle. */async function surfaceRect(window: BrowserWindow, timeoutMs = 8000): Promise<Rect | null> {
  const script = `(() => {
    const el = document.querySelector('.browser-surface');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.width < 40 || r.height < 40) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 };
  })()`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rect = (await window.webContents.executeJavaScript(script, true)) as Rect | null;
    if (rect) return rect;
    await delay(120);
  }
  return null;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
}

export async function runDocsCapture(opts: CaptureOptions): Promise<CaptureReport> {
  const errors: string[] = [];
  const images: ImageStats[] = [];
  const report: CaptureReport = { ok: false, images, hovered: false, errors };

  await mkdir(opts.outDir, { recursive: true });
  if (opts.window.isMinimized()) opts.window.restore();
  opts.window.show();
  opts.window.focus();
  await delay(opts.settleMs ?? 1800);

  const { url, server } = await startFixtureServer();
  try {
    // Seed a transcript so the hero shot shows real content instead of the empty state.
    await opts.window.webContents
      .executeJavaScript(`window.__renderDocsSample && window.__renderDocsSample()`, true)
      .catch((error: unknown) => {
        errors.push(`sample transcript: ${String(error)}`);
        return undefined;
      });

    // The hook is silently no-op when the renderer bundle is stale: prove it rendered.
    const seeded = (await opts.window.webContents
      .executeJavaScript(`document.getElementById('transcript') ? document.getElementById('transcript').children.length : 0`, true)
      .catch(() => 0)) as number;
    if (seeded < 3) errors.push(`the demo transcript rendered ${seeded} entries, expected 3`);

    const opened = await opts.browser.exec({ action: 'open', url });
    if (!opened.ok) errors.push(`browser open: ${opened.error ?? 'unknown error'}`);
    await delay(600);

    const rect = await surfaceRect(opts.window);
    if (!rect) errors.push('the browser dock never reported a rectangle (is it open?)');

    // Park the AI cursor on the primary action — the same `hover` action the agent uses.
    const hover = await opts.browser.exec({ action: 'hover', selector: '#cta', label: 'click Create ticket' }).catch((error: unknown) => ({
      ok: false,
      action: 'hover' as const,
      error: String(error),
    }));
    if (!hover.ok) errors.push(`cursor hover: ${'error' in hover ? hover.error : 'failed'}`);
    report.hovered = hover.ok === true;
    await delay(700); // let the cursor animation settle on target

    // The browser surface on its own: the cursor ring and label are the point of this one.
    const shot = await opts.browser.exec({ action: 'screenshot' });
    const shotData = shot.screenshot;
    if (shot.ok && shotData?.dataBase64) {
      const png = Buffer.from(shotData.dataBase64, 'base64');
      await writeFile(join(opts.outDir, 'ai-cursor.png'), png);
      images.push(measure('ai-cursor.png', png));
    } else {
      errors.push(`browser screenshot: ${shot.error ?? 'no image returned'}`);
    }

    // Two surfaces that differ only in where the cursor sits must not be byte-identical —
    // that is the only way to prove the AI cursor really painted into the page.
    if (shotData?.dataBase64) {
      const moved = await opts.browser.exec({ action: 'hover', selector: 'thead th:first-child', label: 'read column' });
      await delay(500);
      const again = await opts.browser.exec({ action: 'screenshot' });
      if (moved.ok && again.screenshot?.dataBase64) {
        report.cursorPaints =
          Buffer.from(shotData.dataBase64, 'base64').equals(Buffer.from(again.screenshot.dataBase64, 'base64')) === false;
        if (!report.cursorPaints) errors.push('the AI cursor did not show up in the page capture');
        // Put it back on the primary action for the composite below.
        await opts.browser.exec({ action: 'hover', selector: '#cta', label: 'click Create ticket' });
        await delay(400);
      }
    }

    // The whole window: renderer capture plus the browser surface painted at its rectangle.
    const base = await opts.window.webContents.capturePage();
    const basePng = base.toPNG();
    let composed = basePng;
    let composite: { url: string; scale: number } | null = null;
    if (rect && shot.ok && shotData?.dataBase64) {
      const overlayUrl = `data:image/png;base64,${shotData.dataBase64}`;
      composite = (await opts.window.webContents.executeJavaScript(
        `(async () => {
          const load = (src) => new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('image load failed'));
            img.src = src;
          });
          const [base, overlay] = await Promise.all([load(${JSON.stringify(base.toDataURL())}), load(${JSON.stringify(overlayUrl)})]);
          const canvas = document.createElement('canvas');
          canvas.width = base.naturalWidth;
          canvas.height = base.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.drawImage(base, 0, 0);
          const scale = base.naturalWidth / Math.max(1, window.innerWidth);
          const rect = ${JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })};
          const dx = Math.round(rect.x * scale);
          const dy = Math.round(rect.y * scale);
          ctx.drawImage(overlay, dx, dy, Math.round(rect.width * scale), Math.round(rect.height * scale));
          return { url: canvas.toDataURL('image/png'), scale };
        })()`,
        true,
      )) as { url: string; scale: number } | null;
      const comma = composite ? composite.url.indexOf(',') : -1;
      if (composite && comma > 0) composed = Buffer.from(composite.url.slice(comma + 1), 'base64');
      else errors.push('window composite returned no image');
    }
    await writeFile(join(opts.outDir, 'app-window.png'), composed);
    images.push(measure('app-window.png', composed));

    // Prove the surface was painted inside the dock rectangle and not somewhere else.
    if (rect && shotData?.dataBase64 && composite) {
      report.regionMatch = sampleRegion(
        composed,
        Buffer.from(shotData.dataBase64, 'base64'),
        rect,
        composite.scale,
        (report.regionMismatch = []),
      );
      if (report.regionMatch < 0.98) {
        errors.push(`the browser surface did not land in the dock (region match ${report.regionMatch})`);
      }
    }

    await opts.browser.exec({ action: 'close' }).catch(() => undefined);
  } finally {
    server.close();
  }

  report.ok =
    images.length >= 2 &&
    images.every((image) => !image.blank) &&
    errors.length === 0 &&
    (report.regionMatch ?? 0) >= 0.98;
  await writeFile(join(opts.outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
