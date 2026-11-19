'use strict';

/**
 * Sample beeCode plugin — Markdown statistics.
 *
 * Copy this folder to `~/.beecode/plugins/md-stats` (keep the folder name equal to the
 * manifest id), then reload the plugin list. No build step: the host `require()`s this
 * file directly, so plain CommonJS is all it may use.
 *
 * It demonstrates the whole contract in one tool: a manifest-declared permission
 * (`files:read`), a JSON-schema input, the session context handed to every handler, and
 * errors returned in-band so a bad path costs one tool call instead of the session.
 */

const HEADING = /^(#{1,6})\s+(.*)$/;

function countWords(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length;
}

function summarise(text, top) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  for (const line of lines) {
    const match = HEADING.exec(line.trim());
    if (match) headings.push(`${'  '.repeat(match[1].length - 1)}${match[2].trim()}`);
  }
  const report = [
    `${lines.length} lines · ${countWords(text)} words · ${headings.length} headings`,
    ...headings.slice(0, top).map((heading) => `  ${heading.trim()}`),
  ];
  if (headings.length > top) report.push(`  … ${headings.length - top} more`);
  return { report: report.join('\n'), lines: lines.length, headings: headings.length };
}

module.exports = {
  activate(api) {
    api.registerTool({
      name: 'md_stats',
      description:
        'Summarise a Markdown file: line count, word count, headings (as an indented outline) and the file size on disk.',
      // Reading only, so the tool never needs an approval prompt.
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Markdown file to inspect, relative to the session working directory.',
          },
          top: {
            type: 'number',
            description: 'How many headings to list. Default 10, capped at 100.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        if (!path) return { content: 'md_stats needs a "path".', failed: true };
        const requested = Number(args.top);
        const top = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.trunc(requested))) : 10;

        // Throws when `files:read` was not declared; the host reports that in-band.
        const text = await api.fs.readText(ctx, path);
        const { report, lines, headings } = summarise(text, top);
        return {
          content: `${api.fs.resolve(ctx, path)}\n${report}`,
          meta: { lines, headings, bytes: Buffer.byteLength(text, 'utf8') },
        };
      },
    });

    api.log.info('md_stats registered');
  },
};
