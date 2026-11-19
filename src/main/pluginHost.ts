import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import type { PdfOpenParams, PdfOpenResult, PdfRenderParams, PdfRenderResult } from '../shared/browser';

/**
 * Host side of the plugin API: the few things a plugin cannot do from the service process.
 *
 * Both methods are deliberately dumb — validate, act, report — because every policy and
 * permission decision was already made on the service side (PluginHost). A plugin never
 * reaches the renderer, the desktop driver or the filesystem through this door.
 */

/** One viewer per file: re-opening focuses the window instead of stacking duplicates. */
const viewers = new Map<string, BrowserWindow>();

function requireFile(path: string): string {
  if (!isAbsolute(path)) throw new Error(`expected an absolute path, got "${path}"`);
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  return path;
}

async function openPdf(params: PdfOpenParams): Promise<PdfOpenResult> {
  try {
    const path = requireFile(params.path);
    const title = params.title?.trim() || basename(path);
    const page = params.page && params.page > 0 ? Math.floor(params.page) : 0;
    const url = `${pathToFileURL(path).href}${page ? `#page=${page}` : ''}`;

    const existing = viewers.get(path);
    if (existing && !existing.isDestroyed()) {
      await existing.loadURL(url);
      existing.setTitle(title);
      existing.show();
      existing.focus();
      return { ok: true, path, title };
    }

    const win = new BrowserWindow({
      width: 1024,
      height: 820,
      title,
      backgroundColor: '#2b2b2b',
      autoHideMenuBar: true,
      webPreferences: {
        // The Chromium PDF viewer is a "plugin": without this the window cannot render a PDF.
        plugins: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    viewers.set(path, win);
    win.on('closed', () => {
      if (viewers.get(path) === win) viewers.delete(path);
    });
    await win.loadURL(url);
    return { ok: true, path, title };
  } catch (error) {
    return { ok: false, path: params.path, error: (error as Error).message };
  }
}

async function renderPdf(params: PdfRenderParams): Promise<PdfRenderResult> {
  const outPath = params.path;
  let htmlFile: string | undefined;
  let win: BrowserWindow | undefined;
  try {
    if (!isAbsolute(outPath)) throw new Error(`expected an absolute output path, got "${outPath}"`);
    if (typeof params.html !== 'string' || !params.html.trim()) throw new Error('nothing to render');

    // A temp file instead of a data: URL — reports can be many megabytes and data URLs are
    // length-limited. Scripts stay off: the HTML is content, not an application.
    htmlFile = `${app.getPath('temp')}/beecode-print-${randomUUID()}.html`;
    await writeFile(htmlFile, params.html, 'utf8');

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        webviewTag: false,
      },
    });
    await win.loadFile(htmlFile);
    // Give fonts and images a beat to land before the page is measured for pagination.
    await new Promise((resolve) => setTimeout(resolve, 40));

    const margins = params.marginsMm ?? {};
    const pdf = await win.webContents.printToPDF({
      printBackground: params.background !== false,
      landscape: params.landscape === true,
      pageSize: params.pageSize ?? 'A4',
      margins: {
        top: (margins.top ?? 0) / 25.4,
        right: (margins.right ?? 0) / 25.4,
        bottom: (margins.bottom ?? 0) / 25.4,
        left: (margins.left ?? 0) / 25.4,
      },
    });

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, pdf);
    return { ok: true, path: outPath, bytes: pdf.length };
  } catch (error) {
    return { ok: false, path: outPath, error: (error as Error).message };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (htmlFile) await unlink(htmlFile).catch(() => undefined);
  }
}

/** Dispatches the host methods plugins are allowed to call. */
export class PluginHostBridge {
  async exec(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'pdf/open':
        return openPdf(params as PdfOpenParams);
      case 'pdf/render':
        return renderPdf(params as PdfRenderParams);
      default:
        throw new Error(`unknown host method: ${method}`);
    }
  }

  /** Closes every viewer window (used on shutdown). */
  closeViewers(): void {
    for (const win of viewers.values()) if (!win.isDestroyed()) win.close();
    viewers.clear();
  }
}

export function createPluginHostBridge(): PluginHostBridge {
  return new PluginHostBridge();
}
