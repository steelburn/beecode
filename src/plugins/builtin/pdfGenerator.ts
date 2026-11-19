import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ToolDefinition } from '../../shared/tools';
import type { PdfPageSize } from '../../shared/browser';
import { bool, str } from '../args';
import { htmlDocument, markdownDocument } from '../html';
import { failResult, okResult, PLUGIN_API_VERSION, type PluginApi, type PluginDefinition } from '../types';

const PAGE_SIZES: PdfPageSize[] = ['A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid'];

function pageSize(value: string | undefined): PdfPageSize | undefined {
  if (!value) return undefined;
  const wanted = value.trim().toLowerCase();
  return PAGE_SIZES.find((size) => size.toLowerCase() === wanted);
}

function withExtension(path: string): string {
  return /\.pdf$/i.test(path) ? path : `${path}.pdf`;
}

/**
 * PDF generator — renders Markdown or HTML through the desktop host (Chromium
 * `printToPDF`), so pagination, fonts and table layout come out print-correct without
 * shipping a PDF library.
 */
function pdfGenerateTool(api: PluginApi): ToolDefinition {
  return {
    name: 'pdf_generate',
    description:
      'Render Markdown or HTML into a PDF file. Use it for reports, invoices and any other ' +
      'deliverable the user should receive as a document rather than chat text.',
    mutating: true,
    group: 'plugins',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output file path; ".pdf" is appended when missing.' },
        markdown: { type: 'string', description: 'Markdown source (headings, tables, lists, code).' },
        html: { type: 'string', description: 'Full HTML document; wins over "markdown" when both are set.' },
        title: { type: 'string', description: 'Document title (PDF metadata and heading).' },
        pageSize: { type: 'string', enum: PAGE_SIZES, description: 'Paper size. Default A4.' },
        landscape: { type: 'boolean', description: 'Landscape orientation.' },
        open: { type: 'boolean', description: 'Open the result in the PDF viewer afterwards.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    summarize: (args) => `Write PDF ${String(args.path ?? '')}`,
    handler: async (args, ctx) => {
      const rawPath = str(args, 'path');
      if (!rawPath) return failResult('pdf_generate needs a "path" argument.');
      const markdown = typeof args.markdown === 'string' ? args.markdown : '';
      const html = typeof args.html === 'string' ? args.html : '';
      if (!markdown.trim() && !html.trim()) {
        return failResult('pdf_generate needs either "markdown" or "html" content.');
      }

      const title = str(args, 'title');
      const options = { title, landscape: bool(args, 'landscape') };
      const document = html.trim() ? (html.includes('<html') ? html : htmlDocument(html, options)) : markdownDocument(markdown, options);

      const base = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
      const path = withExtension(base);
      await mkdir(dirname(path), { recursive: true });

      try {
        const result = await api.host.call('pdf/render', {
          path,
          html: document,
          pageSize: pageSize(str(args, 'pageSize')),
          landscape: options.landscape,
          background: true,
        });
        if (!result.ok) return failResult(result.error ?? `Could not write ${path}.`);
        if (bool(args, 'open')) {
          await api.host.call('pdf/open', { path, title }).catch(() => undefined);
        }
        const kb = Math.round((result.bytes ?? 0) / 1024);
        return okResult(`Wrote ${path} (${kb} KB, ${result.bytes ?? 0} bytes).`, {
          path,
          bytes: result.bytes,
          plugin: api.manifest.id,
        });
      } catch (error) {
        return failResult(
          `PDF rendering is unavailable: ${(error as Error).message}. ` +
            'It lives in the desktop host — run beeCode as the desktop app, not the headless service.',
        );
      }
    },
  };
}

export const pdfGeneratorPlugin: PluginDefinition = {
  source: 'builtin',
  manifest: {
    id: 'pdf-generator',
    name: 'PDF generator',
    version: '1.0.0',
    description: 'Renders Markdown or HTML to PDF via the desktop host (Chromium printToPDF).',
    author: 'beeCode',
    api: PLUGIN_API_VERSION,
    permissions: ['files:write', 'pdf:render'],
  },
  activate(api) {
    api.log.info('registered pdf_generate');
    api.registerTool(pdfGenerateTool(api));
  },
};
