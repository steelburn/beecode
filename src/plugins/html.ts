/**
 * A small Markdown → HTML converter, used by the PDF generator plugin.
 *
 * It covers what a report actually needs — headings, paragraphs, lists, tables, fenced
 * code, blockquotes, rules and inline emphasis — and nothing else. No dependencies, so
 * the plugin keeps working in a bare Electron install.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(raw: string): string {
  let text = escapeHtml(raw);
  // Code spans first: their content must not be touched by the emphasis rules.
  const spans: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code: string) => {
    spans.push(`<code>${code}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  text = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<span class="img">$1</span>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => spans[Number(index)] ?? '');
}

function tableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Converts Markdown to an HTML fragment. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let index = 0;

  const flushParagraph = (buffer: string[]): void => {
    if (!buffer.length) return;
    out.push(`<p>${inline(buffer.join(' ').trim())}</p>`);
    buffer.length = 0;
  };
  const paragraph: string[] = [];

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    // Fenced code
    const fence = /^\s*```(\w+)?\s*$/.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) body.push(lines[index++]);
      index += 1;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph(paragraph);
      out.push('<hr/>');
      index += 1;
      continue;
    }

    // Table: a header row followed by a separator row
    if (line.includes('|') && index + 1 < lines.length && SEPARATOR.test(lines[index + 1])) {
      flushParagraph(paragraph);
      const header = tableRow(line);
      index += 2;
      const body: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        body.push(tableRow(lines[index]));
        index += 1;
      }
      out.push(
        '<table><thead><tr>' +
          header.map((cell) => `<th>${inline(cell)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph);
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      out.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`);
      continue;
    }

    // Lists — a run of items at the same indentation, ordered or not
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph(paragraph);
      const ordered = /\d/.test(item[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items: string[] = [];
      while (index < lines.length) {
        const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (!next || /\d/.test(next[2]) !== ordered) break;
        items.push(`<li>${inline(next[3].trim())}</li>`);
        index += 1;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph(paragraph);
  return out.join('\n');
}

export interface HtmlDocumentOptions {
  title?: string;
  /** Extra CSS appended after the base sheet. */
  css?: string;
  /** Print in landscape. */
  landscape?: boolean;
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font: 11pt/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #1a1a1a; margin: 0; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 .5em; }
  h1 { font-size: 20pt; border-bottom: 1px solid #d5d5d5; padding-bottom: .2em; }
  h2 { font-size: 15pt; } h3 { font-size: 12.5pt; } h4 { font-size: 11pt; }
  p, ul, ol, blockquote, table, pre { margin: 0 0 .8em; }
  ul, ol { padding-left: 1.4em; }
  code { font-family: "Cascadia Mono", Consolas, monospace; font-size: .92em;
         background: #f2f2f2; padding: 0 .25em; border-radius: 3px; }
  pre { background: #f6f6f6; padding: .7em .9em; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #d0d0d0; margin-left: 0; padding: .1em 0 .1em .9em; color: #4a4a4a; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d5d5d5; padding: .35em .55em; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; }
  a { color: #0b5cad; text-decoration: none; }
  hr { border: none; border-top: 1px solid #d5d5d5; margin: 1.2em 0; }
  .img { font-style: italic; color: #6b6b6b; }
`;

/** Wraps an HTML fragment in a printable document. */
export function htmlDocument(bodyHtml: string, options: HtmlDocumentOptions = {}): string {
  const title = escapeHtml(options.title ?? 'Document');
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${title}</title>
<style>@page { size: ${options.landscape ? 'landscape' : 'portrait'}; margin: 18mm 16mm; }
${BASE_CSS}${options.css ?? ''}</style>
</head><body>${bodyHtml}</body></html>`;
}

/** Markdown straight to a printable document. */
export function markdownDocument(markdown: string, options: HtmlDocumentOptions = {}): string {
  return htmlDocument(markdownToHtml(markdown), options);
}
