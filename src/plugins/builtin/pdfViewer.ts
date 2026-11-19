import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { ToolDefinition } from '../../shared/tools';
import { num, str } from '../args';
import { failResult, okResult, PLUGIN_API_VERSION, type PluginApi, type PluginDefinition } from '../types';

/**
 * PDF viewer — hands a PDF to the internal viewer window instead of asking the agent to
 * read bytes it cannot use. Viewing is read-only, so the tool never prompts for approval.
 */
function pdfOpenTool(api: PluginApi): ToolDefinition {
  return {
    name: 'pdf_open',
    description:
      'Open a PDF file in the internal viewer window so the user can read it. Use this after ' +
      'generating or locating a PDF; the file is not read into the conversation.',
    mutating: false,
    group: 'plugins',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PDF path, absolute or relative to the session cwd.' },
        page: { type: 'number', description: 'Page to jump to (1-based).' },
        title: { type: 'string', description: 'Window title; defaults to the file name.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    summarize: (args) => `Open ${String(args.path ?? '')} in the PDF viewer`,
    handler: async (args, ctx) => {
      const raw = str(args, 'path');
      if (!raw) return failResult('pdf_open needs a "path" argument.');
      const path = api.fs.resolve(ctx, raw);
      if (!existsSync(path) || !statSync(path).isFile()) return failResult(`No such file: ${path}`);
      if (!/\.pdf$/i.test(path)) return failResult(`Not a PDF file: ${path}`);
      const page = num(args, 'page');
      try {
        const result = await api.host.call('pdf/open', {
          path,
          page: page && page > 0 ? Math.floor(page) : undefined,
          title: str(args, 'title'),
        });
        if (!result.ok) return failResult(result.error ?? `The viewer could not open ${path}.`);
        const size = statSync(path).size;
        return okResult(
          `Opened ${basename(path)} (${formatBytes(size)}) in the PDF viewer${page ? ` at page ${page}` : ''}.`,
          { path, bytes: size, plugin: api.manifest.id },
        );
      } catch (error) {
        return failResult(
          `The PDF viewer is unavailable: ${(error as Error).message}. ` +
            'It lives in the desktop host — run beeCode as the desktop app, not the headless service.',
        );
      }
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const pdfViewerPlugin: PluginDefinition = {
  source: 'builtin',
  manifest: {
    id: 'pdf-viewer',
    name: 'PDF viewer',
    version: '1.0.0',
    description: 'Opens PDF files in the built-in viewer window (Chromium PDF viewer, no extra dependencies).',
    author: 'beeCode',
    api: PLUGIN_API_VERSION,
    permissions: ['files:read', 'pdf:view'],
  },
  activate(api) {
    api.log.info('registered pdf_open');
    api.registerTool(pdfOpenTool(api));
  },
};
