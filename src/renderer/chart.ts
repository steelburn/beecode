/**
 * Dependency-free SVG charts for assistant messages.
 *
 * The model emits a fenced ```chart block whose body is a small JSON spec; `renderChart`
 * turns that into a markup-safe `<figure>`. Nothing here touches the DOM, so the module is
 * unit tested straight from node (see chart.test.ts) and can be reused for exports.
 *
 * Spec (all keys optional except the data):
 *
 *   { "type": "bar" | "line" | "pie", "title": "…", "unit": "ms",
 *     "labels": ["a", "b"], "values": [1, 2],
 *     "series": [{ "name": "series 1", "values": [1, 2] }] }
 *
 * `values` is shorthand for a single unnamed series; `series` may also be a plain array of
 * number arrays. Numbers may arrive as numeric strings (LLMs do that a lot).
 */

export type ChartType = 'bar' | 'line' | 'pie';

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  labels: string[];
  series: ChartSeries[];
  unit?: string;
}

const PALETTE = ['#4c9aff', '#57d9a3', '#ffab00', '#ff7452', '#8777d9', '#00b8d9', '#f5cd47', '#e774bb'];
const AXIS = '#3b4657';
const GRID = '#242c38';
const TEXT = '#93a1b4';
const MAX_LABELS = 48;
const MAX_SERIES = 8;
const WIDTH = 720;
const HEIGHT = 320;
const PAD = { top: 18, right: 18, bottom: 46, left: 56 };

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(n) && Math.abs(n) < 1e12 ? n : undefined;
}

function toNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.map(toNumber);
  if (numbers.some((n) => n === undefined)) return undefined;
  return numbers as number[];
}

function label(value: unknown, index: number): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).label === 'string') {
    return (value as Record<string, string>).label;
  }
  return `#${index + 1}`;
}

export type ParsedChart = { ok: true; spec: ChartSpec } | { ok: false; error: string };

/** Validate and normalize a chart spec out of the raw fence body. */
export function parseChartSpec(source: string): ParsedChart {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: `the chart block is not valid JSON (${(err as Error).message})` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'the chart block must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const requested = typeof obj.type === 'string' ? obj.type.toLowerCase().trim() : 'bar';
  const type: ChartType =
    requested === 'line' || requested === 'area' ? 'line' : requested === 'pie' || requested === 'donut' ? 'pie' : 'bar';

  const series: ChartSeries[] = [];
  const rawSeries = obj.series;
  if (Array.isArray(rawSeries)) {
    rawSeries.slice(0, MAX_SERIES).forEach((entry, index) => {
      const values = toNumbers(entry);
      if (values) {
        series.push({ name: `series ${index + 1}`, values });
        return;
      }
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const named = toNumbers(record.values ?? record.data);
        if (named) {
          series.push({ name: label(record.name, index), values: named });
        }
      }
    });
  }
  if (!series.length) {
    const shorthand = toNumbers(obj.values ?? obj.data);
    if (shorthand) series.push({ name: typeof obj.title === 'string' ? obj.title : 'value', values: shorthand });
  }
  if (!series.length) {
    return { ok: false, error: 'no numeric data: pass "values": [...] or "series": [{ "values": [...] }]' };
  }

  const rawLabels = obj.labels ?? obj.x;
  const declared = Array.isArray(rawLabels) ? rawLabels.length : 0;
  const count = Math.max(...series.map((s) => s.values.length), declared);
  const labels: string[] = [];
  for (let i = 0; i < Math.min(count, MAX_LABELS); i += 1) {
    labels.push(Array.isArray(rawLabels) ? label(rawLabels[i], i) : `#${i + 1}`);
  }
  for (const s of series) {
    if (s.values.length !== labels.length) s.values = s.values.slice(0, labels.length);
    while (s.values.length < labels.length) s.values.push(0);
  }

  return {
    ok: true,
    spec: {
      type,
      title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : undefined,
      labels,
      series,
      unit: typeof obj.unit === 'string' && obj.unit.trim() ? obj.unit.trim() : undefined,
    },
  };
}

function formatNumber(value: number, unit?: string): string {
  const rounded = Math.abs(value) >= 1000 ? Math.round(value).toLocaleString('en-US') : String(Math.round(value * 100) / 100);
  return unit ? `${rounded}${unit.startsWith('%') ? unit : ` ${unit}`}` : rounded;
}

function ticksFor(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const span = max - min;
  const rough = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? rough;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= end + step / 1000; value += step) ticks.push(Math.round(value * 1000) / 1000);
  return ticks;
}

function truncate(text: string, max = 12): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function legend(spec: ChartSpec, x: number, y: number): string {
  const items = spec.series.map((s, index) => ({ name: s.name, color: PALETTE[index % PALETTE.length] }));
  return `<g class="chart-legend">${items
    .map((item, index) => {
      const left = x + (index % 4) * 132;
      const top = y + Math.floor(index / 4) * 16;
      return `<rect x="${left}" y="${top - 7}" width="8" height="8" rx="2" fill="${item.color}"/><text x="${left + 13}" y="${top}" fill="${TEXT}" font-size="11">${esc(truncate(item.name, 18))}</text>`;
    })
    .join('')}</g>`;
}

function cartesianChart(spec: ChartSpec): string {
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom - (spec.series.length > 1 ? 22 : 0);
  const all = spec.series.flatMap((s) => s.values);
  const rawMax = Math.max(...all, 0);
  const rawMin = Math.min(...all, 0);
  const ticks = ticksFor(rawMin, rawMax);
  const top = ticks[ticks.length - 1];
  const bottom = ticks[0];
  const span = top - bottom || 1;
  const y = (value: number): number => PAD.top + plotH - ((value - bottom) / span) * plotH;
  const band = plotW / spec.labels.length;

  const grid = ticks
    .map(
      (tick) =>
        `<g><line x1="${PAD.left}" y1="${y(tick)}" x2="${PAD.left + plotW}" y2="${y(tick)}" stroke="${tick === 0 ? AXIS : GRID}" stroke-width="1"/><text x="${PAD.left - 8}" y="${y(tick) + 4}" fill="${TEXT}" font-size="10" text-anchor="end">${esc(formatNumber(tick, spec.unit))}</text></g>`,
    )
    .join('');

  const rotate = spec.labels.length > 8;
  const xLabels = spec.labels
    .map((text, index) => {
      const cx = PAD.left + band * (index + 0.5);
      const anchor = rotate ? 'end' : 'middle';
      const transform = rotate ? ` transform="rotate(-32 ${cx} ${PAD.top + plotH + 14})"` : '';
      return `<text x="${cx}" y="${PAD.top + plotH + 14}" fill="${TEXT}" font-size="10" text-anchor="${anchor}"${transform}>${esc(truncate(text, rotate ? 16 : 12))}</text>`;
    })
    .join('');

  let marks = '';
  if (spec.type === 'bar') {
    const groupW = band * 0.72;
    const barW = groupW / spec.series.length;
    marks = spec.series
      .map((s, seriesIndex) => {
        const color = PALETTE[seriesIndex % PALETTE.length];
        return s.values
          .map((value, index) => {
            const left = PAD.left + band * index + (band - groupW) / 2 + barW * seriesIndex;
            const zero = y(0);
            const valueY = y(value);
            const height = Math.max(Math.abs(zero - valueY), 1);
            const topY = value < 0 ? zero : zero - height;
            return `<rect class="chart-bar" x="${left.toFixed(1)}" y="${topY.toFixed(1)}" width="${Math.max(barW - 2, 1).toFixed(1)}" height="${height.toFixed(1)}" rx="2" fill="${color}"><title>${esc(`${spec.labels[index]}: ${formatNumber(value, spec.unit)}`)}</title></rect>`;
          })
          .join('');
      })
      .join('');
  } else {
    marks = spec.series
      .map((s, seriesIndex) => {
        const color = PALETTE[seriesIndex % PALETTE.length];
        const points = s.values.map((value, index) => `${(PAD.left + band * (index + 0.5)).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
        const dots = s.values
          .map(
            (value, index) =>
              `<circle cx="${(PAD.left + band * (index + 0.5)).toFixed(1)}" cy="${y(value).toFixed(1)}" r="2.6" fill="${color}"><title>${esc(`${spec.labels[index]}: ${formatNumber(value, spec.unit)}`)}</title></circle>`,
          )
          .join('');
        const area =
          seriesIndex === 0 && spec.series.length === 1
            ? `<polygon points="${PAD.left},${y(0)} ${points} ${(PAD.left + plotW).toFixed(1)},${y(0)}" fill="${color}" opacity="0.12"/>`
            : '';
        return `${area}<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>${dots}`;
      })
      .join('');
  }

  const legendY = PAD.top + plotH + 34;
  return `<svg class="chart-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${marks}${xLabels}${spec.series.length ? legend(spec, PAD.left, legendY) : ''}</svg>`;
}

function pieChart(spec: ChartSpec): string {
  const values = spec.series[0].values;
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0);
  const cx = 180;
  const cy = HEIGHT / 2;
  const radius = 118;
  let angle = -Math.PI / 2;
  let slices = '';
  let legendItems = '';
  values.forEach((value, index) => {
    const share = total > 0 ? Math.max(value, 0) / total : 0;
    const sweep = share * Math.PI * 2;
    const color = PALETTE[index % PALETTE.length];
    if (sweep > 0) {
      const end = angle + sweep;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(end);
      const y2 = cy + radius * Math.sin(end);
      const large = sweep > Math.PI ? 1 : 0;
      if (share > 0.999) {
        slices += `<circle class="chart-slice" cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"><title>${esc(`${spec.labels[index]}: ${formatNumber(value, spec.unit)}`)}</title></circle>`;
      } else {
        slices += `<path class="chart-slice" d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}"><title>${esc(`${spec.labels[index]}: ${formatNumber(value, spec.unit)}`)}</title></path>`;
      }
    }
    angle += sweep;
    const rowY = cy - radius + 12 + index * 20;
    legendItems += `<rect x="360" y="${rowY - 8}" width="9" height="9" rx="2" fill="${color}"/><text x="${376}" y="${rowY}" fill="${TEXT}" font-size="11">${esc(truncate(spec.labels[index], 24))} · ${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%</text>`;
  });
  return `<svg class="chart-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" preserveAspectRatio="xMidYMid meet">${slices}${legendItems}</svg>`;
}

/** SVG markup for a normalized spec. */
export function chartSvg(spec: ChartSpec): string {
  return spec.type === 'pie' ? pieChart(spec) : cartesianChart(spec);
}

/**
 * Full message-block markup for a ```chart fence: a figure with the chart, or an error card
 * with the original text when the spec does not parse (never a blank message).
 */
export function renderChart(source: string): string {
  const parsed = parseChartSpec(source);
  if (!parsed.ok) {
    return `<div class="chart-block chart-error"><div class="chart-error-title">Chart not rendered</div><div class="chart-error-reason">${esc(parsed.error)}</div><pre><code>${esc(source.trim())}</code></pre></div>`;
  }
  const { spec } = parsed;
  const caption = spec.title ? `<figcaption>${esc(spec.title)}</figcaption>` : '';
  return `<figure class="chart-block">${caption}${chartSvg(spec)}</figure>`;
}
