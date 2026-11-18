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
 * Tiny, safe Markdown subset for assistant messages: fenced code, inline code, bold,
 * italics, headings, bullet lists and paragraphs. Everything is escaped first, so model
 * output can never inject markup.
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  const parts = text.split(/```/);
  let html = '';
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      // fenced block: first line may be a language
      const nl = part.indexOf('\n');
      const body = nl >= 0 ? part.slice(nl + 1) : part;
      html += `<pre><code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`;
      return;
    }
    html += renderInlineBlock(part);
  });
  return html;
}

function renderInlineBlock(block: string): string {
  const lines = block.split(/\r?\n/);
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1] ?? '');
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(4, (heading[1] ?? '#').length);
      out.push(`<p><strong>${inline(heading[2] ?? '')}</strong></p>`);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out.join('');
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<!_)__([^_]+)__(?!_)/g, '<strong>$1</strong>');
}

/** Pretty-print JSON tool payloads with clipping, so tool cards stay readable. */
export function formatJsonForDisplay(value: string, maxChars = 4000): string {
  try {
    const parsed = JSON.parse(value);
    const pretty = JSON.stringify(parsed, null, 2);
    return pretty.length > maxChars ? `${pretty.slice(0, maxChars)}\n…[truncated]` : pretty;
  } catch {
    return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  }
}
