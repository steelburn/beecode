import { isAbsolute, resolve } from 'node:path';
import type { ToolDefinition } from '../../shared/tools';
import { bool, str } from '../args';
import { buildXlsx, columnName, type XlsxCell, type XlsxColumn } from '../xlsx';
import { failResult, okResult, PLUGIN_API_VERSION, type PluginApi, type PluginDefinition } from '../types';

const MAX_CELLS = 200_000;

/** Parses a delimited text block (CSV/TSV) into a matrix, honouring quoted fields. */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** Serialises a matrix as RFC 4180 CSV. */
export function toCsv(rows: XlsxCell[][], delimiter = ','): string {
  const escape = (value: XlsxCell): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return /["\n\r]|,|;|\t/.test(text) || text.includes(delimiter)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };
  return rows.map((row) => row.map(escape).join(delimiter)).join('\r\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalises the `rows` argument: either a matrix, or a list of records whose keys become
 * the header row.
 */
export function toMatrix(input: unknown): XlsxCell[][] {
  if (!Array.isArray(input) || !input.length) throw new Error('"rows" must be a non-empty array');
  if (input.every((row) => Array.isArray(row))) {
    return (input as unknown[][]).map((row) => row.map(toCell));
  }
  if (input.every(isRecord)) {
    const keys: string[] = [];
    for (const record of input as Record<string, unknown>[]) {
      for (const key of Object.keys(record)) if (!keys.includes(key)) keys.push(key);
    }
    const header: XlsxCell[] = keys;
    const body = (input as Record<string, unknown>[]).map((record) => keys.map((key) => toCell(record[key])));
    return [header, ...body];
  }
  throw new Error('"rows" must be an array of arrays (or of objects with the same shape)');
}

function toCell(value: unknown): XlsxCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  return JSON.stringify(value);
}

function columnOptions(args: Record<string, unknown>): XlsxColumn[] | undefined {
  const widths = args.widths ?? args.columns;
  if (!Array.isArray(widths)) return undefined;
  return widths.map((entry) => {
    if (typeof entry === 'number') return { width: entry };
    if (isRecord(entry) && typeof entry.width === 'number') return { width: entry.width };
    return {};
  });
}

/**
 * Table → spreadsheet. An `.xlsx` is written with the bundled writer (a zip of OOXML
 * parts, no dependencies); a `.csv` path falls back to delimited text.
 */
function exportTableTool(api: PluginApi): ToolDefinition {
  return {
    name: 'excel_export',
    description:
      'Write tabular data to an Excel (.xlsx) or CSV file. Accepts rows as arrays of arrays or ' +
      'as objects (keys become the header row), or a CSV/TSV string in "csv".',
    mutating: true,
    group: 'plugins',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output file; ".xlsx" is appended when no extension is given.' },
        sheet: { type: 'string', description: 'Sheet name. Default "Sheet1".' },
        rows: {
          type: 'array',
          description: 'Rows as arrays of cells, or as objects whose keys are the column headers.',
          items: {},
        },
        csv: { type: 'string', description: 'Delimited text to convert instead of "rows".' },
        delimiter: { type: 'string', description: 'Delimiter for the "csv" input. Default "," or tab for .tsv.' },
        header: { type: 'boolean', description: 'Render the first row bold/frozen. Default true for multi-row sheets.' },
        widths: {
          type: 'array',
          description: 'Column widths in characters, indexed from column A.',
          items: { type: 'number' },
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    summarize: (args) => `Write spreadsheet ${String(args.path ?? '')}`,
    handler: async (args, ctx) => {
      const rawPath = str(args, 'path');
      if (!rawPath) return failResult('excel_export needs a "path" argument.');

      let matrix: XlsxCell[][];
      try {
        const csv = typeof args.csv === 'string' ? args.csv : undefined;
        if (csv) {
          const delimiter = str(args, 'delimiter') ?? (/\.tsv$/i.test(rawPath) ? '\t' : ',');
          matrix = parseDelimited(csv, delimiter).map((row) => row.map(toCell));
        } else {
          matrix = toMatrix(args.rows);
        }
      } catch (error) {
        return failResult(`Could not read the table: ${(error as Error).message}`);
      }

      const columns = matrix.reduce((max, row) => Math.max(max, row.length), 0);
      if (!columns) return failResult('The table has no columns.');
      if (matrix.length * columns > MAX_CELLS) {
        return failResult(`The table is too large: ${matrix.length} rows × ${columns} columns (limit ${MAX_CELLS} cells).`);
      }

      const base = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
      const isCsv = /\.csv$/i.test(base);
      const path = isCsv || /\.(xlsx|xlsm)$/i.test(base) ? base : `${base}.xlsx`;
      const header = bool(args, 'header', matrix.length > 1);

      try {
        if (isCsv) {
          const text = toCsv(matrix, str(args, 'delimiter') ?? ',');
          await api.fs.writeText(ctx, path, text);
          return okResult(`Wrote ${path} (${matrix.length} rows × ${columns} columns, CSV).`, {
            path,
            rows: matrix.length,
            columns,
            format: 'csv',
            plugin: api.manifest.id,
          });
        }

        const bytes = buildXlsx([
          {
            name: str(args, 'sheet') ?? 'Sheet1',
            rows: matrix,
            columns: columnOptions(args),
            headerRow: header,
          },
        ]);
        await api.fs.writeBuffer(ctx, path, bytes);
        const range = `${columnName(columns - 1)}${matrix.length}`;
        return okResult(
          `Wrote ${path} (${matrix.length} rows × ${columns} columns, range A1:${range}, ${Math.max(1, Math.round(bytes.length / 1024))} KB).`,
          { path, rows: matrix.length, columns, bytes: bytes.length, format: 'xlsx', plugin: api.manifest.id },
        );
      } catch (error) {
        return failResult(`Could not write ${path}: ${(error as Error).message}`);
      }
    },
  };
}

export const tableExportPlugin: PluginDefinition = {
  source: 'builtin',
  manifest: {
    id: 'table-export',
    name: 'Excel export',
    version: '1.0.0',
    description: 'Exports tables to .xlsx (bundled OOXML writer) or .csv, with headers, widths and frozen panes.',
    author: 'beeCode',
    api: PLUGIN_API_VERSION,
    permissions: ['files:write'],
  },
  activate(api) {
    api.log.info('registered excel_export');
    api.registerTool(exportTableTool(api));
  },
};
