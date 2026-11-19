import { deflateRawSync } from 'node:zlib';

/**
 * A minimal, dependency-free `.xlsx` writer.
 *
 * An xlsx file is an OPC zip of a handful of XML parts. Spreadsheets are only ever
 * written here (never read), so there is no shared-string table: every string cell is an
 * inline string, which keeps the package to five parts and makes the writer stateless.
 */

export type XlsxCell = string | number | boolean | null | undefined;

export interface XlsxColumn {
  /** Width in characters (Excel's unit). */
  width?: number;
}

export interface XlsxSheet {
  name: string;
  /** Row-major cell values. `null`/`undefined` leave the cell empty. */
  rows: XlsxCell[][];
  /** Per-column widths, indexed from A. */
  columns?: XlsxColumn[];
  /** Emit row 0 in bold (the default when the sheet has more than one row). */
  headerRow?: boolean;
}

/* --------------------------------------------------------------------- xml */

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** Column index → letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let name = '';
  let rest = index;
  while (rest >= 0) {
    name = String.fromCharCode(65 + (rest % 26)) + name;
    rest = Math.floor(rest / 26) - 1;
  }
  return name;
}

/** Excel forbids `[]:*?/\` in sheet names and caps them at 31 chars. */
export function sheetName(raw: string, fallback = 'Sheet1'): string {
  const cleaned = (raw || fallback)
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31);
  return cleaned || fallback;
}

function cellXml(ref: string, value: XlsxCell, bold: boolean): string {
  const style = bold ? ' s="1"' : '';
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"${style}><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet, index: number): string {
  const header = sheet.headerRow ?? sheet.rows.length > 1;
  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  const cols = width
    ? `<cols>${Array.from({ length: width }, (_, i) => {
        const explicit = sheet.columns?.[i]?.width;
        const auto = Math.min(
          60,
          Math.max(9, ...sheet.rows.map((row) => String(row[i] ?? '').length + 2)),
        );
        return `<col min="${i + 1}" max="${i + 1}" width="${explicit ?? auto}" customWidth="1"/>`;
      }).join('')}</cols>`
    : '';
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row.map((value, c) => cellXml(`${columnName(c)}${r + 1}`, value, header && r === 0));
      return `<row r="${r + 1}">${cells.join('')}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (index === 0 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '') +
    cols +
    `<sheetData>${rows}</sheetData>` +
    '</worksheet>'
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '%SHEETS%' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '</styleSheet>';

/* --------------------------------------------------------------------- zip */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Fixed DOS timestamp (1980-01-01) — exports of the same data are byte-identical, which
 * makes them diffable and testable.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Writes a deflate-compressed zip. No zip64, no encryption, no directories. */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

/* ------------------------------------------------------------------- build */

/** Builds the bytes of an `.xlsx` workbook. */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  if (!sheets.length) throw new Error('a workbook needs at least one sheet');
  const used = new Set<string>();
  const named = sheets.map((sheet, index) => {
    let name = sheetName(sheet.name, `Sheet${index + 1}`);
    let suffix = 2;
    while (used.has(name.toLowerCase())) name = sheetName(`${name.slice(0, 28)}_${suffix++}`);
    used.add(name.toLowerCase());
    return { ...sheet, name };
  });

  const entries: ZipEntry[] = [];
  const overrides = named
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');

  entries.push({ name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES.replace('%SHEETS%', overrides), 'utf8') });
  entries.push({ name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') });
  entries.push({ name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') });
  entries.push({
    name: 'xl/workbook.xml',
    data: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        named
          .map((sheet, i) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('') +
        '</sheets></workbook>',
      'utf8',
    ),
  });
  entries.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        named
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
      'utf8',
    ),
  });
  named.forEach((sheet, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(sheet, i), 'utf8') });
  });

  return zip(entries);
}
