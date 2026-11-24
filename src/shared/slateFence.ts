import type { SlateKind } from './protocol';
import { SLATE_AUTO_PROMOTE_MIN_LINES } from './protocol';

/**
 * Fenced-block detection for auto-promoting a long `html` / `svg` block out of the
 * transcript and into a slate.
 *
 * The transcript is the wrong place for a 60-line HTML page: it interrupts the
 * conversation, it is unreadable as text and it cannot be opened, diffed or promoted.
 * So a long enough block is lifted into a slate and the message keeps a one-line card.
 *
 * Everything here is pure string work — no fs, no Electron — so the service can use it
 * while streaming and the tests can exercise it directly.
 */

/** A fenced block this scanner understands: only the two kinds a slate can render. */
export interface FenceBlock {
  /** Lowercased info string of the opening fence (`html` or `svg`). */
  info: 'html' | 'svg';
  /** Lines between the fences, verbatim. */
  content: string;
  /** Number of content lines; a trailing newline does not add one. */
  lines: number;
  /** Offset of the opening fence line in the source text. */
  start: number;
  /** Offset just past the closing fence (or the end of the text while still open). */
  end: number;
  /** False while the block is still streaming in. */
  closed: boolean;
}

/** ``` ```html ``` / ``` ```svg ``` open a block; a bare ``` ``` ``` stays a code block. */
export function isSlateFenceInfo(info: string): boolean {
  return info === 'html' || info === 'svg';
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed.split('\n').length;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Every `html` / `svg` block in `text`, closed or still streaming.
 *
 * A closing fence must use the same character as the opening one and be at least as
 * long, which is what keeps a ``` inside an HTML sample from ending the block early.
 */
export function scanFences(text: string): FenceBlock[] {
  const lines = text.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const blocks: FenceBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/.exec(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }
    const marker = open[1];
    const info = open[2].toLowerCase();
    if (!isSlateFenceInfo(info)) {
      // Not a slate block, but skip its body so a ```html inside a ``` text sample is
      // not mistaken for a real block.
      const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j += 1;
      i = j + 1;
      continue;
    }

    const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j += 1;
    const closed = j < lines.length;
    const content = lines.slice(i + 1, closed ? j : lines.length).join('\n');

    blocks.push({
      info: info as 'html' | 'svg',
      content,
      lines: countLines(content),
      start: offsets[i],
      end: closed ? offsets[j] + lines[j].length : text.length,
      closed,
    });
    i = closed ? j + 1 : lines.length;
  }
  return blocks;
}

/** The closed blocks long enough to become slates, in document order. */
export function promotableFences(
  text: string,
  minLines: number = SLATE_AUTO_PROMOTE_MIN_LINES,
): FenceBlock[] {
  return scanFences(text).filter((block) => block.closed && block.lines >= minLines);
}

/**
 * The block still streaming at the end of `text`, once it is long enough to matter.
 * This is what turns into `slate.delta` events: the pane can already show the document
 * while the model is still writing it.
 */
export function openPromotableFence(
  text: string,
  minLines: number = SLATE_AUTO_PROMOTE_MIN_LINES,
): FenceBlock | undefined {
  const blocks = scanFences(text);
  const last = blocks[blocks.length - 1];
  if (!last || last.closed || last.lines < minLines) return undefined;
  return last;
}

/** `text` without the given blocks — what the transcript shows instead of the page. */
export function stripFences(text: string, blocks: FenceBlock[]): string {
  let out = text;
  for (const block of [...blocks].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, block.start) + out.slice(block.end);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A title for the slate: `<title>`, else the first `h1` / `h2`, else the fence kind. */
export function fenceTitle(block: FenceBlock): string {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block.content);
  const heading = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(block.content);
  const raw = stripTags(titleTag?.[1] ?? heading?.[1] ?? '');
  if (raw) return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
  return block.info === 'svg' ? 'SVG image' : 'HTML document';
}

/**
 * The document a fence becomes. HTML keeps its text; an SVG fragment is wrapped in the
 * minimal page that centres it, because the slate renderer is an HTML viewer.
 */
export function fenceToDocument(block: FenceBlock, title: string): { kind: SlateKind; content: string } {
  if (block.info === 'html') return { kind: 'html', content: `${block.content.trimEnd()}\n` };
  return {
    kind: 'html',
    content: [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      `<title>${escapeHtml(title)}</title>`,
      '</head>',
      '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d11">',
      block.content.trimEnd(),
      '</body>',
      '</html>',
      '',
    ].join('\n'),
  };
}
