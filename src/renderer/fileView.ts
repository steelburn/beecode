/**
 * The document pane's viewers.
 *
 * One entry point — `mountFileView` — decides how a file is shown, so the explorer's
 * preview and the full tab in the main area can never drift apart:
 *
 * | file                          | view                                                   |
 * | ----------------------------- | ------------------------------------------------------ |
 * | .md / .markdown …             | rendered Markdown (source on request)                  |
 * | .html                         | sanitised HTML (source on request)                     |
 * | .csv / .tsv / .tab            | table with a sticky header, numeric cells right-aligned |
 * | .log                          | colour-coded lines with a level filter and a search     |
 * | .png .jpg .gif .webp …        | the picture, at its own size, with its dimensions       |
 * | .pdf                          | Chromium's own PDF viewer in a frame                    |
 * | .docx / .xlsx / .pptx         | the markup the service converted the archive to         |
 *
 * Anything else falls back to the plain text preview. Files the renderer cannot read
 * itself (pictures, PDFs) are loaded over the `app://…/file` route, which the main process
 * confines to the workspace root.
 */
import { delimiterName, isNumericCell, MAX_CSV_ROWS, parseCsv } from './csv';
import { clear, h, renderMarkdown } from './dom';
import {
  countLogLevels,
  filterLogLines,
  highlightRanges,
  LOG_LEVELS,
  splitLogLines,
  splitLogPrefix,
  type LogEntry,
  type LogLevel,
} from './logView';
import { htmlPreviewMarkup, sanitizeHtml, type FileView } from './preview';
import type { FsFile } from '../shared/protocol';

/** What a file name asks to be shown as. */
export type ViewerKind =
  | 'markdown'
  | 'html'
  | 'text'
  | 'csv'
  | 'log'
  | 'image'
  | 'pdf'
  | 'word'
  | 'excel'
  | 'powerpoint';

const EXTENSION_KINDS: Record<string, ViewerKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.mdown': 'markdown',
  '.mkd': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.shtml': 'html',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.tab': 'csv',
  '.log': 'log',
  '.out': 'log',
  '.err': 'log',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.avif': 'image',
  '.svg': 'image',
  '.ico': 'image',
  '.pdf': 'pdf',
  '.docx': 'word',
  '.docm': 'word',
  '.dotx': 'word',
  '.xlsx': 'excel',
  '.xlsm': 'excel',
  '.xltx': 'excel',
  '.pptx': 'powerpoint',
  '.pptm': 'powerpoint',
};

/** Most log lines put in the DOM at once; the filter narrows the rest. */
const MAX_LOG_ROWS = 5000;

/** The viewer a file name asks for. */
export function viewerKind(name: string): ViewerKind {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'text';
  return EXTENSION_KINDS[name.slice(dot).toLowerCase()] ?? 'text';
}

/** Kinds that have both a rendered and a raw view, so the Rendered / Source toggle applies. */
export function hasSourceView(kind: ViewerKind): boolean {
  return kind === 'markdown' || kind === 'html' || kind === 'text';
}

/**
 * True when there is a view for this file at all: one of its own (a picture, a PDF, a
 * table, a log, a converted Office document) or the text preview. A binary file with
 * neither is only named, so the pane can say so instead of showing an empty box.
 */
export function canShowFile(file: FsFile): boolean {
  if (file.render?.kind === 'html') return true;
  const kind = viewerKind(file.name);
  if (kind === 'image' || kind === 'pdf') return true;
  return !file.binary;
}

/** A display name for a document kind, used in notes. */
export function kindLabel(kind: ViewerKind): string {
  if (kind === 'word') return 'Word document';
  if (kind === 'excel') return 'Excel workbook';
  if (kind === 'powerpoint') return 'PowerPoint deck';
  if (kind === 'pdf') return 'PDF document';
  if (kind === 'image') return 'Picture';
  if (kind === 'csv') return 'Delimited file';
  if (kind === 'log') return 'Log file';
  return 'Text file';
}

/**
 * Same-origin URL for one workspace file, served by the main process.
 *
 * The origin is the renderer's own, so the strict `default-src 'self'` CSP still holds;
 * the main process refuses anything outside the workspace root or of a type no viewer
 * asks for.
 */
export function fileAssetUrl(path: string): string {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return `${origin}/file?path=${encodeURIComponent(path)}`;
}

export interface FileViewOptions {
  /** The pane's rendered/source switch; only Markdown, HTML and text have a source view. */
  view?: FileView;
}

/** Build the view for one file. */
export function mountFileView(file: FsFile, options: FileViewOptions = {}): HTMLElement {
  const kind = viewerKind(file.name);
  // A stale "Source" from the previous file must not hide a table, a log or a picture.
  const source = options.view === 'source' && hasSourceView(kind);
  // The service converts Office archives, so its markup wins over the extension mapping.
  if (file.render?.kind === 'html') return convertedView(file);
  if (source) return codeView(file.text);
  switch (kind) {
    case 'markdown':
      return h('div', {
        class: 'fileview doc-markdown doc-rendered explorer-rendered',
        html: renderMarkdown(file.text),
      });
    case 'html':
      return htmlView(file.text);
    case 'csv':
      return csvView(file);
    case 'log':
      return logView(file);
    case 'image':
      return imageView(file);
    case 'pdf':
      return pdfView(file);
    case 'word':
    case 'excel':
    case 'powerpoint':
      return notice(`${kindLabel(kind)} — this build could not convert the document for preview.`);
    default:
      return codeView(file.text);
  }
}

/* ------------------------------------------------------------------- views */

function codeView(text: string): HTMLElement {
  return h('pre', { class: 'explorer-code fileview-code', text });
}

function htmlView(text: string): HTMLElement {
  // A rendered HTML file is mounted in its own shadow root: the file's own stylesheets stay
  // inside the preview instead of restyling the whole app, and the app's rules cannot
  // reshape the file. `.explorer-rendered.html` adds layout containment on top.
  const host = h('div', { class: 'fileview doc-html doc-rendered explorer-rendered html' });
  host.attachShadow({ mode: 'open' }).innerHTML = htmlPreviewMarkup(text);
  return host;
}

/** A converted Office document: the service's markup, sanitised again in the renderer. */
function convertedView(file: FsFile): HTMLElement {
  const wrap = h('div', { class: 'fileview doc-document' });
  if (file.render?.note) wrap.append(note(file.render.note));
  const body = h('div', { class: 'doc-document-body' });
  // The markup is built in the service, but it is still untrusted: sanitise it here, then
  // style it with the app's own `.doc-document-body` rules (a shadow root would hide them).
  body.innerHTML = sanitizeHtml(file.render?.html ?? '');
  wrap.append(body);
  return wrap;
}

function imageView(file: FsFile): HTMLElement {
  const wrap = h('div', { class: 'fileview doc-image' });
  const meta = h('span', { class: 'doc-image-meta', text: formatBytes(file.size) });
  const picture = h('img', {
    class: 'doc-image-img',
    src: fileAssetUrl(file.path),
    alt: file.name,
    loading: 'lazy',
  });
  picture.addEventListener('load', () => {
    meta.textContent = `${picture.naturalWidth} × ${picture.naturalHeight} · ${formatBytes(file.size)}`;
  });
  picture.addEventListener('error', () => {
    clear(wrap);
    wrap.append(notice('The picture could not be loaded.'));
  });
  wrap.append(
    picture,
    h(
      'div',
      { class: 'doc-image-bar' },
      h('span', { class: 'doc-image-name', text: file.name }),
      meta,
    ),
  );
  return wrap;
}

function pdfView(file: FsFile): HTMLElement {
  const wrap = h('div', { class: 'fileview doc-pdf' });
  wrap.append(
    h('div', { class: 'doc-pdf-bar' }, h('span', { class: 'doc-pdf-name', text: file.name }), h('span', { class: 'doc-image-meta', text: formatBytes(file.size) })),
    h('iframe', {
      class: 'doc-pdf-frame',
      src: fileAssetUrl(file.path),
      title: file.name,
    }),
  );
  return wrap;
}

/** CSV and TSV as a scrollable table with a sticky header. */
function csvView(file: FsFile): HTMLElement {
  const table = parseCsv(file.text);
  const bar = h(
    'div',
    { class: 'table-bar' },
    h('span', {
      class: 'table-meta',
      text: `${table.rows.length} ${table.rows.length === 1 ? 'row' : 'rows'} × ${table.columns} ${
        table.columns === 1 ? 'column' : 'columns'
      } · ${delimiterName(table.delimiter)}-separated`,
    }),
    table.truncated ? h('span', { class: 'fileview-note', text: `Only the first ${MAX_CSV_ROWS} rows are shown.` }) : null,
    file.truncated ? h('span', { class: 'fileview-note', text: 'The file is longer than the preview budget.' }) : null,
  );

  const head = h('tr');
  for (const cell of table.header) head.append(h('th', { text: cell || ' ', title: cell }));
  const body = h('tbody');
  table.rows.forEach((cells, index) => {
    const row = h('tr', index % 2 === 1 ? { class: 'odd' } : null);
    for (const cell of cells) {
      row.append(h('td', isNumericCell(cell) ? { class: 'num', text: cell, title: cell } : { text: cell, title: cell }));
    }
    body.append(row);
  });

  const scroll = h('div', { class: 'table-scroll' });
  scroll.append(h('table', { class: 'data-table' }, h('thead', null, head), body));
  return h('div', { class: 'fileview doc-table' }, bar, scroll);
}

/**
 * A log file: colour per level, a level filter with counts, and a search that narrows and
 * highlights. The whole view is rebuilt on each change — the text is capped at the preview
 * budget, so filtering is cheap and needs no index.
 */
function logView(file: FsFile): HTMLElement {
  const lines = splitLogLines(file.text);
  const counts = countLogLevels(lines);
  const active = new Set<LogLevel>(LOG_LEVELS);
  let query = '';
  let wrapped = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const chips = h('div', { class: 'log-chips' });
  const status = h('span', { class: 'log-status' });
  const body = h('div', { class: 'log-body' });

  const render = (): void => {
    const result = filterLogLines(lines, { levels: [...active], query });
    clear(body);
    for (const entry of result.entries.slice(0, MAX_LOG_ROWS)) body.append(logRow(entry, query));
    if (result.entries.length > MAX_LOG_ROWS) {
      body.append(
        note(
          `Only the first ${MAX_LOG_ROWS} of ${result.entries.length} matching lines are shown — narrow the filter to see the rest.`,
        ),
      );
    }
    if (result.entries.length === 0) body.append(h('p', { class: 'explorer-empty', text: 'No line matches the filter.' }));
    const matched = query.trim();
    status.textContent = `${result.shown} of ${result.total} lines${
      matched ? ` · ${result.hits} ${result.hits === 1 ? 'match' : 'matches'}` : ''
    }`;
  };

  for (const level of LOG_LEVELS) {
    const chip = h('button', {
      class: `log-chip log-${level} on`,
      type: 'button',
      title: `Show or hide ${level} lines`,
      on: {
        click: () => {
          if (active.has(level)) {
            active.delete(level);
            chip.classList.remove('on');
          } else {
            active.add(level);
            chip.classList.add('on');
          }
          render();
        },
      },
    });
    chip.append(h('span', { class: 'log-chip-name', text: level }), h('span', { class: 'log-chip-count', text: String(counts[level]) }));
    chips.append(chip);
  }

  const search = h('input', {
    class: 'log-search',
    type: 'search',
    placeholder: 'Filter lines…',
    spellcheck: false,
    on: {
      input: (event) => {
        query = (event.target as HTMLInputElement).value;
        if (pending) clearTimeout(pending);
        pending = setTimeout(render, 120);
      },
    },
  });

  const wrapToggle = h('button', {
    class: 'btn ghost small',
    type: 'button',
    text: 'Wrap',
    title: 'Wrap long lines',
    on: {
      click: () => {
        wrapped = !wrapped;
        wrapToggle.classList.toggle('on', wrapped);
        body.classList.toggle('log-wrapped', wrapped);
      },
    },
  });

  render();
  return h('div', { class: 'fileview doc-log' }, h('div', { class: 'log-toolbar' }, chips, search, wrapToggle, status), body);
}

function logRow(entry: LogEntry, query: string): HTMLElement {
  const row = h('div', { class: `log-line log-${entry.level}`, dataset: { line: String(entry.number) } });
  row.append(h('span', { class: 'log-no', text: String(entry.number) }));
  const { prefix, rest } = splitLogPrefix(entry.text);
  if (prefix) row.append(h('span', { class: 'log-time', text: prefix }));
  row.append(highlighted(rest, query));
  return row;
}

/** The message part of a line, with every query match wrapped in a `<mark>`. */
function highlighted(text: string, query: string): HTMLElement {
  const span = h('span', { class: 'log-text' });
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) {
    span.append(document.createTextNode(text));
    return span;
  }
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) span.append(document.createTextNode(text.slice(at, range.start)));
    span.append(h('mark', { class: 'log-hit', text: text.slice(range.start, range.end) }));
    at = range.end;
  }
  if (at < text.length) span.append(document.createTextNode(text.slice(at)));
  return span;
}

/* ----------------------------------------------------------------- helpers */

function note(text: string): HTMLElement {
  return h('p', { class: 'fileview-note', text });
}

function notice(text: string): HTMLElement {
  return h('p', { class: 'explorer-empty', text });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
