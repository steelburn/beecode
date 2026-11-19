/**
 * File preview helpers for the workspace explorer: which view a file offers
 * (rendered or source) and the sanitizer behind the rendered HTML view.
 *
 * Everything here is a pure string transformation so it can be unit tested in node,
 * where no DOM exists. `sanitizeHtml` is defence in depth, not the only guard: the
 * renderer document runs under a CSP without `unsafe-inline` scripts, so an inline
 * handler that slipped through could still not execute.
 */

/** How one preview is shown: rendered (Markdown/HTML) or the raw text. */
export type FileView = 'rendered' | 'source';

/** What kind of preview a file name asks for. */
export type FileKind = 'markdown' | 'html' | 'text';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx', '.mdown', '.mkd'];
const HTML_EXTENSIONS = ['.html', '.htm', '.xhtml', '.shtml'];

/** Classify a file name by its extension. Names without a known one are plain text. */
export function fileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
  if (MARKDOWN_EXTENSIONS.includes(ext)) return 'markdown';
  if (HTML_EXTENSIONS.includes(ext)) return 'html';
  return 'text';
}

/** A rendered view is the point of a Markdown/HTML file; source is all plain text has. */
export function defaultView(kind: FileKind): FileView {
  return kind === 'text' ? 'source' : 'rendered';
}

/** True when the preview offers a rendered/source switch at all. */
export function canSwitchView(kind: FileKind): boolean {
  return kind !== 'text';
}

/** Elements removed together with their content: they either run code or navigate. */
const DROPPED_BLOCKS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'template',
  'portal',
]);

/** Elements whose tag is removed but whose text content is kept. */
const DROPPED_TAGS = new Set(['base', 'link', 'meta', 'title', 'head', 'html', 'body', 'xml', 'noscript']);

/** Attributes removed from every surviving tag. */
const DROPPED_ATTRIBUTES = new Set(['srcdoc', 'formaction', 'action', 'ping', 'manifest']);

/** Attributes whose value must not be a scripting URL. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'poster', 'data', 'xlink:href', 'srcset']);

const SCRIPTING_URL = /^(?:javascript|vbscript|livescript|data:text\/html)/i;

interface Tag {
  name: string;
  closing: boolean;
  /** Index just past the closing `>`. */
  end: number;
  /** The whole tag text, `<` to `>`. */
  raw: string;
}

/**
 * Read one tag starting at `start` (which must be `<`). Returns undefined when the text
 * is not a well-formed tag, in which case the caller keeps it as literal text.
 */
function readTag(text: string, start: number): Tag | undefined {
  let quote: string | undefined;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      const raw = text.slice(start, i + 1);
      const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(raw);
      if (!match) return undefined;
      return { name: match[2], closing: Boolean(match[1]), end: i + 1, raw };
    } else if (ch === '<') {
      return undefined;
    }
  }
  return undefined;
}

/** Index just past the `</name>` that closes a dropped block, or the end of the text. */
function skipBlock(text: string, from: number, name: string): number {
  const close = new RegExp(`<\\s*/\\s*${name}\\s*>`, 'i');
  const rest = text.slice(from);
  const found = close.exec(rest);
  return found ? from + found.index + found[0].length : text.length;
}

/** Strip control characters and space, so `java\tscript:` cannot dodge the scheme test. */
function normalizeUrl(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
}

function stripAttributes(tag: Tag): string {
  const attrs = tag.raw.slice(1 + tag.raw.indexOf(tag.name) + tag.name.length, tag.closing ? -2 : -1);
  const kept: string[] = [];
  const pattern = /([^\s"'=<>/]+)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(attrs))) {
    const name = match[1].toLowerCase();
    const value = match[4] ?? match[5] ?? match[6];
    if (name.startsWith('on')) continue;
    if (DROPPED_ATTRIBUTES.has(name)) continue;
    if (value !== undefined) {
      // `expression(...)` and `url(javascript:...)` are CSS-level escape hatches.
      if (name === 'style' && /expression|javascript:|\burl\s*\(/i.test(value)) continue;
      if (URL_ATTRIBUTES.has(name) && SCRIPTING_URL.test(normalizeUrl(value))) continue;
      if (/^data:/i.test(normalizeUrl(value)) && !/^data:image\//i.test(normalizeUrl(value))) continue;
      kept.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
    } else {
      kept.push(name);
    }
  }
  const open = tag.closing ? `</${tag.name}` : `<${tag.name}`;
  return kept.length ? `${open} ${kept.join(' ')}>` : `${open}>`;
}

/**
 * Sanitize an HTML document for the rendered preview: scripting blocks, event handlers
 * and scripting URLs are removed; everything else (styles, tables, images, links) stays so
 * a workspace page still looks like itself. Relative images and links do not resolve —
 * the renderer has no file origin — so only absolute or data: images appear.
 */
export function sanitizeHtml(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      /* Not a tag: keep the `<` as text so nothing is swallowed by mistake. */
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    const name = tag.name.toLowerCase();
    if (DROPPED_BLOCKS.has(name)) {
      i = tag.closing ? tag.end : skipBlock(html, tag.end, name);
      continue;
    }
    if (DROPPED_TAGS.has(name)) {
      i = tag.end;
      continue;
    }
    out += stripAttributes(tag);
    i = tag.end;
  }
  return out;
}

/**
 * Base typography for the isolated HTML preview. A rendered HTML file is mounted in its
 * own shadow root (see `htmlPreviewMarkup`), so the application's `.explorer-rendered`
 * rules cannot reach inside it and the essentials are restated here. Custom properties
 * inherit across the shadow boundary, so the preview still follows the app theme.
 */
const HTML_PREVIEW_CSS = [
  ':host{display:block;font:inherit;font-size:12px;line-height:1.55;color:var(--text);overflow-wrap:anywhere;}',
  ':host>.html-preview>:first-child{margin-top:0;}',
  'h1,h2,h3,h4,h5,h6{margin:14px 0 6px;line-height:1.3;font-weight:650;}',
  'h1{font-size:16px;}',
  'h2{font-size:14px;}',
  'h3{font-size:13px;}',
  'h4,h5,h6{font-size:12px;}',
  'p{margin:6px 0;}',
  'ul,ol{margin:6px 0;padding-left:20px;}',
  'li{margin:2px 0;}',
  'a{color:#7ad0ff;text-decoration:none;}',
  'a:hover{text-decoration:underline;}',
  'code{padding:1px 4px;border-radius:4px;background:rgba(255,255,255,0.08);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;}',
  'pre{margin:8px 0;padding:8px 10px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:rgba(0,0,0,0.25);}',
  'pre code{padding:0;background:none;}',
  'blockquote{margin:8px 0;padding:2px 0 2px 10px;border-left:2px solid var(--line);color:var(--text-dim);}',
  'hr{border:0;border-top:1px solid var(--line);margin:12px 0;}',
  'table{margin:8px 0;border-collapse:collapse;font-size:11.5px;}',
  'th,td{padding:4px 8px;border:1px solid var(--line);}',
  'img{max-width:100%;height:auto;}',
].join('');

/**
 * The rendered view of an HTML file: the sanitized markup (see `sanitizeHtml`) behind a
 * wrapper that carries the base styles. The caller mounts the result in a shadow root,
 * which is what stops a file stylesheet — `body { ... }`, `* { ... }`, `:root { ... }` —
 * from restyling the whole application, and keeps the application out of the file. Rules
 * that target `html`, `body` or `:root` no longer match at all, because the sanitizer
 * drops those elements; the preview therefore follows the app theme, not the page's.
 */
export function htmlPreviewMarkup(html: string): string {
  return `<style>${HTML_PREVIEW_CSS}</style><div class="html-preview">${sanitizeHtml(html)}</div>`;
}
