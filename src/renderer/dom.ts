import { renderChart } from './chart';

type Props = Record<string, unknown> & {
  class?: string;
  text?: string;
  html?: string;
  on?: Record<string, (event: Event) => void>;
  dataset?: Record<string, string>;
};

/** Minimal element factory — no framework, no virtual DOM, no innerHTML for user text. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'html') el.innerHTML = String(value); // only ever called with markdown output
      else if (key === 'dataset') Object.assign(el.dataset, value as Record<string, string>);
      else if (key === 'on') {
        for (const [event, handler] of Object.entries(value as Record<string, (e: Event) => void>)) {
          el.addEventListener(event, handler);
        }
      } else if (key in el) {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safe Markdown for assistant messages: headings, nested ordered/unordered lists, GFM
 * tables, blockquotes, rules, fenced code with a language label and inline formatting
 * (code, links, bold, italic, strikethrough). Raw HTML is escaped first, so model output
 * can never inject markup; a \`\`\`chart fence is handed to chart.ts instead of a <pre>.
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = /^\s*(\x60\x60\x60+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const marker = fence[1] ?? '\x60\x60\x60';
      const lang = (fence[2] ?? '').toLowerCase();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // the closing fence (absent while a message is still streaming)
      const source = body.join('\n');
      if (lang === 'chart' || lang === 'chartjs' || lang === 'graph' || lang === 'plot') {
        out.push(renderChart(source));
      } else {
        const label = lang ? ' data-lang="' + escapeHtml(lang) + '"' : '';
        out.push('<pre class="md-pre"' + label + '><code>' + escapeHtml(source) + '</code></pre>');
      }
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      out.push('<h' + level + ' class="md-heading">' + inline(heading[2] ?? '') + '</h' + level + '>');
      i += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr class="md-hr"/>');
      i += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      out.push('<blockquote class="md-quote">' + inline(quoted.join('\n')) + '</blockquote>');
      continue;
    }

    if (isTableStart(lines, i)) {
      const rendered = renderTable(lines, i);
      out.push(rendered.html);
      i = rendered.next;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const rendered = renderList(lines, i);
      out.push(rendered.html);
      i = rendered.next;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (!current.trim() || startsBlock(lines, i)) break;
      paragraph.push(inline(current.trim()));
      i += 1;
    }
    if (paragraph.length) out.push('<p class="md-p">' + paragraph.join('<br/>') + '</p>');
  }

  return out.join('');
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

/** True when the line opens a new block, so a running paragraph has to stop. */
function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (/^\s*(\x60\x60\x60+|~~~+)/.test(line)) return true;
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  return isTableStart(lines, index);
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? '';
  const separator = lines[index + 1] ?? '';
  if (!header.includes('|') || !separator.includes('|')) return false;
  return /^[\s|:-]+$/.test(separator) && separator.includes('-');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(lines: string[], start: number): { html: string; next: number } {
  const header = splitRow(lines[start] ?? '');
  const alignments = splitRow(lines[start + 1] ?? '').map((cell) => {
    if (/^:.*:$/.test(cell)) return 'center';
    if (/:$/.test(cell)) return 'right';
    return 'left';
  });
  const head =
    '<thead><tr>' +
    header
      .map((cell, index) => '<th style="text-align:' + (alignments[index] ?? 'left') + '">' + inline(cell) + '</th>')
      .join('') +
    '</tr></thead>';
  const rows: string[] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || !line.includes('|')) break;
    const cells = splitRow(line);
    rows.push(
      '<tr>' +
        cells
          .map((cell, index) => '<td style="text-align:' + (alignments[index] ?? 'left') + '">' + inline(cell) + '</td>')
          .join('') +
        '</tr>',
    );
    i += 1;
  }
  return { html: '<table class="md-table">' + head + '<tbody>' + rows.join('') + '</tbody></table>', next: i };
}

interface ListItem {
  level: number;
  ordered: boolean;
  text: string;
}

function renderList(lines: string[], start: number): { html: string; next: number } {
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!match) {
      // A blank line ends the list; an indented line continues the previous item.
      const previous = items[items.length - 1];
      if (previous && line.trim() && /^\s{2,}\S/.test(line)) {
        previous.text += ' ' + line.trim();
        i += 1;
        continue;
      }
      break;
    }
    const indent = (match[1] ?? '').replace(/\t/g, '  ').length;
    items.push({
      level: Math.min(Math.floor(indent / 2), 5),
      ordered: /^\d/.test(match[2] ?? ''),
      text: match[3] ?? '',
    });
    i += 1;
  }
  return { html: buildList(items), next: i };
}

function buildList(items: ListItem[]): string {
  const tag = (ordered: boolean): string => (ordered ? 'ol' : 'ul');
  let html = '';
  const stack: Array<{ level: number; ordered: boolean }> = [];
  for (const item of items) {
    const top = stack[stack.length - 1];
    if (!top) {
      stack.push({ level: item.level, ordered: item.ordered });
      html += '<' + tag(item.ordered) + ' class="md-list">';
    } else if (item.level > top.level) {
      stack.push({ level: item.level, ordered: item.ordered });
      html += '<' + tag(item.ordered) + ' class="md-list">';
    } else {
      while (stack.length > 1 && item.level < (stack[stack.length - 1] as { level: number }).level) {
        const closed = stack.pop() as { level: number; ordered: boolean };
        html += '</li></' + tag(closed.ordered) + '>';
      }
      const current = stack[stack.length - 1] as { level: number; ordered: boolean };
      if (current.ordered !== item.ordered) {
        stack.pop();
        html += '</li></' + tag(current.ordered) + '>';
        stack.push({ level: item.level, ordered: item.ordered });
        html += '<' + tag(item.ordered) + ' class="md-list">';
      } else {
        html += '</li>';
      }
    }
    html += '<li>' + inline(item.text);
  }
  while (stack.length) {
    const closed = stack.pop() as { level: number; ordered: boolean };
    html += '</li></' + tag(closed.ordered) + '>';
  }
  return html;
}

/**
 * Inline formatting. The text is escaped before any pattern runs, so the only markup in the
 * result is the one produced here; code spans are parked behind placeholders so their
 * content is never formatted twice.
 */
function inline(text: string): string {
  const codeSpans: string[] = [];
  let work = escapeHtml(text).replace(/\x60([^\x60]+)\x60/g, (_match, code: string) => {
    codeSpans.push(code);
    return '\u0000' + (codeSpans.length - 1) + '\u0000';
  });
  work = work
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match: string, labelText: string, href: string) => {
      if (!/^(https?:|mailto:)/i.test(href)) return match;
      return '<a href="' + href + '" target="_blank" rel="noreferrer noopener">' + labelText + '</a>';
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?![\w])/g, '$1<em>$2</em>');
  return work.replace(/\u0000(\d+)\u0000/g, (_match, codeIndex: string) => {
    return '<code>' + (codeSpans[Number(codeIndex)] ?? '') + '</code>';
  });
}

/** Pretty-print a JSON tool payload, clipped so a tool card stays readable. */
export function formatJsonForDisplay(value: string, maxChars = 4000): string {
  try {
    const pretty = JSON.stringify(JSON.parse(value), null, 2);
    return pretty.length > maxChars ? `${pretty.slice(0, maxChars)}\n…[truncated]` : pretty;
  } catch {
    return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  }
}
