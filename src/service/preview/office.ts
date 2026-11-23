/**
 * Office documents to HTML, without a dependency.
 *
 * A .docx / .xlsx / .pptx file is a ZIP of XML parts, so `readZip` (the skill-archive
 * reader) plus a small amount of tolerant XML scanning is enough to show what is in the
 * document. This is a *preview*: it keeps text, headings, tables and slide structure and
 * drops layout, fonts, colours, images and embedded objects.
 *
 * Everything here is a pure function over already-decompressed entries, so it runs in
 * node tests without a file system. The output is untrusted markup — the renderer puts it
 * through `sanitizeHtml` before it reaches the DOM.
 */
import type { ZipEntry } from '../skills/zip';

/** Which Office container a file name asks for. */
export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

/** A converted document plus whatever had to be left out. */
export interface OfficeDocument {
  /** Markup for the preview; empty when the archive held nothing renderable. */
  html: string;
  /** One line about truncation or a missing part, shown above the view. */
  note?: string;
}

const OFFICE_EXTENSIONS: Record<string, OfficeFormat> = {
  '.docx': 'docx',
  '.docm': 'docx',
  '.dotx': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.xltx': 'xlsx',
  '.pptx': 'pptx',
  '.pptm': 'pptx',
};

/** Most paragraphs per document, so a 2000-page manual cannot stall the renderer. */
const MAX_BLOCKS = 4000;
/** Most sheets rendered per workbook. */
const MAX_SHEETS = 12;
/** Most rows rendered per sheet. */
const MAX_ROWS = 500;
/** Most slides rendered per deck. */
const MAX_SLIDES = 100;

/** The Office format a file name asks for, from its extension. */
export function officeFormat(name: string): OfficeFormat | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return OFFICE_EXTENSIONS[name.slice(dot).toLowerCase()];
}

/** Convert the parts of an Office archive to preview markup. */
export function convertOffice(entries: ZipEntry[], format: OfficeFormat): OfficeDocument {
  const files = new Map(entries.map((entry) => [entry.name, entry.data.toString('utf8')]));
  if (format === 'docx') return docxDocument(files);
  if (format === 'xlsx') return xlsxDocument(files);
  return pptxDocument(files);
}

/* ------------------------------------------------------------------ xml text */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/** Decode the XML entities Office writes, including numeric character references. */
export function decodeXml(text: string): string {
  return text.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '\ufffd';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '\ufffd';
  }
}

/** Escape text for a markup position. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Value of one attribute in a single tag's text, decoded. */
function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]) : undefined;
}

/** Concatenated text of every text node in `xml` (Word runs, spreadsheet strings, slide runs). */
function collectText(xml: string): string {
  let text = '';
  // The runs arrive with a namespace prefix (`<w:t>`, `<a:t>`) or without one (`<t>`), so
  // the prefix is optional here rather than repeated per document format.
  for (const match of xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) {
    text += decodeXml(match[1]);
  }
  return text;
}

/* ---------------------------------------------------------------------- docx */

/** Heading level a Word paragraph style asks for, if any. */
function headingLevel(style: string): number | undefined {
  const name = style.trim().toLowerCase().replace(/\s+/g, '');
  if (!name) return undefined;
  if (name === 'title') return 1;
  if (name === 'subtitle') return 2;
  const match = /^heading([1-6])$/.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** Inline markup for the runs of one paragraph, cell or heading. */
function docxRuns(xml: string): string {
  let html = '';
  for (const match of xml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    const body = match[1];
    let text = '';
    for (const part of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g)) {
      if (part[0].startsWith('<w:tab')) text += '\t';
      else if (part[0].startsWith('<w:br') || part[0].startsWith('<w:cr')) text += '\n';
      else text += decodeXml(part[1] ?? '');
    }
    if (!text) continue;
    const bold = /<w:b(?:\s[^>]*)?\/>/.test(body);
    const italic = /<w:i(?:\s[^>]*)?\/>/.test(body);
    let piece = esc(text).replace(/\n/g, '<br />');
    if (bold) piece = `<strong>${piece}</strong>`;
    if (italic) piece = `<em>${piece}</em>`;
    html += piece;
  }
  return html;
}

/** One Word paragraph. */
function docxParagraph(block: string): string {
  const inner = docxRuns(block).trim();
  if (!inner) return '';
  const style = attr(/<w:pStyle\b[^>]*>/.exec(block)?.[0] ?? '', 'w:val') ?? '';
  const level = headingLevel(style);
  if (level) return `<h${Math.min(level + 2, 6)}>${inner}</h${Math.min(level + 2, 6)}>`;
  const bullet = /<w:numPr>/.test(block);
  return bullet ? `<p class="doc-item">\u2022 ${inner}</p>` : `<p>${inner}</p>`;
}

/** One Word table: rows of cells, each cell's paragraphs joined by line breaks. */
function docxTable(block: string): string {
  const rows: string[] = [];
  for (const row of block.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)) {
      const parts: string[] = [];
      for (const para of cell[1].matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
        const text = docxRuns(para[1]).trim();
        if (text) parts.push(text);
      }
      cells.push(`<td>${parts.join('<br />')}</td>`);
    }
    if (cells.length) rows.push(`<tr>${cells.join('')}</tr>`);
  }
  return rows.length ? `<table class="doc-table"><tbody>${rows.join('')}</tbody></table>` : '';
}

function docxDocument(files: Map<string, string>): OfficeDocument {
  const xml = files.get('word/document.xml');
  if (!xml) return { html: '', note: 'This archive has no word/document.xml — it is not a Word document.' };
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const blocks: string[] = [];
  let dropped = 0;
  for (const match of body.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    if (blocks.length >= MAX_BLOCKS) {
      dropped += 1;
      continue;
    }
    const html = match[0].startsWith('<w:tbl') ? docxTable(match[0]) : docxParagraph(match[0]);
    if (html) blocks.push(html);
  }
  const html = blocks.join('\n');
  const notes: string[] = [];
  if (!html) notes.push('The document has no text to show (it may hold only images).');
  if (dropped) notes.push(`Only the first ${MAX_BLOCKS} paragraphs are shown.`);
  return { html, note: notes.length ? notes.join(' ') : undefined };
}

/* ---------------------------------------------------------------------- xlsx */

function sharedStrings(files: Map<string, string>): string[] {
  const xml = files.get('xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) => collectText(match[1]));
}

/** 0-based column index of a cell reference like `B7`. */
export function columnIndex(ref: string): number {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0];
  if (!letters) return 0;
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function cellValue(cell: string, type: string | undefined, strings: string[]): string {
  if (type === 'inlineStr') return collectText(/<is>([\s\S]*?)<\/is>/.exec(cell)?.[1] ?? '');
  const raw = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
  if (raw === undefined) return '';
  if (type === 's') {
    const index = Number(decodeXml(raw));
    return Number.isFinite(index) ? (strings[index] ?? '') : '';
  }
  if (type === 'b') return decodeXml(raw) === '1' ? 'TRUE' : 'FALSE';
  return decodeXml(raw);
}

function sheetHtml(xml: string, strings: string[]): { html: string; rows: number; dropped: number } {
  const rows: string[] = [];
  let total = 0;
  for (const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    total += 1;
    if (rows.length >= MAX_ROWS) continue;
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<c(?:\s[^>]*)?\/>|<c(?:\s[^>]*)?>[\s\S]*?<\/c>/g)) {
      const tag = /^<c(?:\s[^>]*)?>/.exec(cell[0])?.[0] ?? cell[0];
      const ref = attr(tag, 'r');
      const index = ref ? columnIndex(ref) : cells.length;
      const value = cellValue(cell[0], attr(tag, 't'), strings);
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    if (!cells.length) continue;
    rows.push(`<tr>${cells.map((value) => `<td>${esc(value)}</td>`).join('')}</tr>`);
  }
  return {
    html: rows.length ? `<table class="doc-table doc-sheet-table"><tbody>${rows.join('')}</tbody></table>` : '',
    rows: rows.length,
    dropped: Math.max(0, total - rows.length),
  };
}

/** Sheet name + part path, in workbook order, from the workbook and its relationships. */
function sheetList(files: Map<string, string>): { name: string; path: string }[] {
  const workbook = files.get('xl/workbook.xml') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship(?:\s[^>]*)?\/?>/g)) {
    const id = attr(match[0], 'Id');
    const target = attr(match[0], 'Target');
    if (id && target) targets.set(id, target);
  }
  const sheets: { name: string; path: string }[] = [];
  for (const match of workbook.matchAll(/<sheet(?:\s[^>]*)?\/?>/g)) {
    const id = attr(match[0], 'r:id');
    const target = id ? targets.get(id) : undefined;
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    if (!files.has(path)) continue;
    sheets.push({ name: attr(match[0], 'name') ?? `Sheet ${sheets.length + 1}`, path });
  }
  if (sheets.length) return sheets;
  return [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((path, index) => ({ name: `Sheet ${index + 1}`, path }));
}

function xlsxDocument(files: Map<string, string>): OfficeDocument {
  const strings = sharedStrings(files);
  const sheets = sheetList(files);
  if (!sheets.length) return { html: '', note: 'No worksheets found in the archive.' };
  const parts: string[] = [];
  const notes: string[] = [];
  let droppedRows = 0;
  sheets.forEach((sheet, index) => {
    if (index >= MAX_SHEETS) return;
    const table = sheetHtml(files.get(sheet.path) ?? '', strings);
    droppedRows += table.dropped;
    parts.push(
      `<section class="doc-sheet"><h3>${esc(sheet.name)}</h3>${
        table.html || '<p class="doc-empty">(empty sheet)</p>'
      }</section>`,
    );
  });
  if (sheets.length > MAX_SHEETS) notes.push(`Only the first ${MAX_SHEETS} of ${sheets.length} sheets are shown.`);
  if (droppedRows) notes.push(`Long sheets are cut off after ${MAX_ROWS} rows.`);
  return { html: parts.join('\n'), note: notes.length ? notes.join(' ') : undefined };
}

/* ---------------------------------------------------------------------- pptx */

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function pptxDocument(files: Map<string, string>): OfficeDocument {
  const slides = [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!slides.length) return { html: '', note: 'No slides found in the archive.' };
  const parts: string[] = [];
  slides.slice(0, MAX_SLIDES).forEach((name, index) => {
    const xml = files.get(name) ?? '';
    const blocks: string[] = [];
    for (const shape of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
      const placeholder = /<p:ph(?:\s[^>]*)?\/?>/.exec(shape[0])?.[0] ?? '';
      const type = attr(placeholder, 'type') ?? 'body';
      const paragraphs = [...shape[0].matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g)]
        .map((para) => collectText(para[0]).trim())
        .filter((text) => text.length > 0);
      if (!paragraphs.length) continue;
      if (type === 'title' || type === 'ctrTitle') {
        blocks.push(`<h3>${esc(paragraphs.join(' '))}</h3>`);
      } else if (type === 'subTitle') {
        blocks.push(`<p class="doc-subtitle">${esc(paragraphs.join(' '))}</p>`);
      } else {
        blocks.push(`<ul>${paragraphs.map((text) => `<li>${esc(text)}</li>`).join('')}</ul>`);
      }
    }
    parts.push(
      `<section class="doc-slide"><p class="doc-slide-no">Slide ${index + 1}</p>${
        blocks.join('\n') || '<p class="doc-empty">(no text on this slide)</p>'
      }</section>`,
    );
  });
  const notes: string[] = [];
  if (slides.length > MAX_SLIDES) notes.push(`Only the first ${MAX_SLIDES} of ${slides.length} slides are shown.`);
  return { html: parts.join('\n'), note: notes.length ? notes.join(' ') : undefined };
}
