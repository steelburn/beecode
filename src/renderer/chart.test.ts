import assert from 'node:assert/strict';
import test from 'node:test';
import { chartSvg, parseChartSpec, renderChart } from './chart';

function mustParse(source: string) {
  const parsed = parseChartSpec(source);
  assert.equal(parsed.ok, true, `expected a valid spec: ${source}`);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.spec;
}

test('parseChartSpec accepts the values shorthand and defaults to a bar chart', () => {
  const spec = mustParse('{"title":"Build time","unit":"ms","labels":["a","b","c"],"values":[3,5,2]}');
  assert.equal(spec.type, 'bar');
  assert.equal(spec.title, 'Build time');
  assert.equal(spec.unit, 'ms');
  assert.deepEqual(spec.labels, ['a', 'b', 'c']);
  assert.equal(spec.series.length, 1);
  assert.deepEqual(spec.series[0]?.values, [3, 5, 2]);
});

test('parseChartSpec reads named series, numeric strings and alternative aliases', () => {
  const spec = mustParse(
    '{"type":"column","x":["one","two"],"series":[{"name":"load","values":["1.5",2]},[3,4]]}',
  );
  assert.equal(spec.type, 'bar');
  assert.deepEqual(spec.labels, ['one', 'two']);
  assert.deepEqual(spec.series.map((s) => s.name), ['load', 'series 2']);
  assert.deepEqual(spec.series[0]?.values, [1.5, 2]);
});

test('parseChartSpec maps pie/donut and pads short series to the label count', () => {
  const spec = mustParse('{"type":"donut","labels":["a","b"],"values":[1]}');
  assert.equal(spec.type, 'pie');
  assert.deepEqual(spec.series[0]?.values, [1, 0]);
});

test('parseChartSpec reports why a block could not be drawn', () => {
  assert.equal(parseChartSpec('{ not json').ok, false);
  assert.equal(parseChartSpec('[]').ok, false);
  const noData = parseChartSpec('{"labels":["a"]}');
  assert.equal(noData.ok, false);
  if (!noData.ok) assert.match(noData.error, /no numeric data/);
});

test('renderChart emits an svg figure with bars, legend and escaped labels', () => {
  const html = renderChart('{"labels":["<b>a</b>","b"],"values":[1,2],"title":"T < x"}');
  assert.match(html, /<figure class="chart-block">/);
  assert.match(html, /<figcaption>T &lt; x<\/figcaption>/);
  assert.match(html, /class="chart-svg"/);
  assert.match(html, /class="chart-bar"/);
  assert.match(html, /&lt;b&gt;a&lt;\/b&gt;/);
  assert.ok(!html.includes('<b>a</b>'), 'label markup must be escaped');
});

test('renderChart draws slices for a pie chart and degrades to an error card', () => {
  const pie = renderChart('{"type":"pie","labels":["x","y"],"values":[3,1]}');
  assert.match(pie, /class="chart-slice"/);
  const broken = renderChart('{"labels":["a"],"values":"nope"}');
  assert.match(broken, /chart-error/);
  assert.match(broken, /no numeric data/);
});

test('chartSvg keeps negative values inside the plot area', () => {
  const spec = mustParse('{"type":"line","labels":["a","b","c"],"values":[-4,0,6]}');
  const svg = chartSvg(spec);
  assert.match(svg, /<polyline/);
  assert.ok(!/cy="(-|NaN)/.test(svg), 'no negative or NaN coordinates');
});
