// Chart spec builder: from the fields you have and the question you ask, pick
// the chart type, the encodings and the scales, then write the configuration
// for Vega-Lite, Chart.js or ECharts.
//
// The choices follow published guidance:
//   - encoding ranking (position > length > angle/area > colour): Cleveland &
//     McGill 1984, "Graphical Perception", JASA 79(387);
//   - chart per question (trend -> line, comparison -> bar, distribution ->
//     histogram/box, relationship -> scatter, part-to-whole -> bar or pie
//     with few slices): S. Few, "Show Me the Numbers" (2nd ed.), ch. 5-7;
//   - bars and areas encode length, so their axis starts at zero (Few; Vega-Lite
//     `scale.zero` default); lines and points may zoom to the data;
//   - log scale when the data spans three decades or more (rule of thumb);
//   - histogram bins: Sturges k = ceil(log2 n) + 1 for n < 200, else Rice
//     k = ceil(2 n^(1/3));
//   - at most ~8 colour categories (Tableau 10 / ColorBrewer qualitative sets).
import { fmtNum, parseEng } from '../kit/eng.js';

const GOALS = { trend: 'Trend over time', compare: 'Compare categories', ranking: 'Ranking', distribution: 'Distribution',
  relationship: 'Relationship', part: 'Part of a whole', composition: 'Composition over time' };

function readField(r, i) {
  const name = String(r.name ?? '').trim() || `field${i + 1}`;
  const type = ['quantitative', 'temporal', 'nominal', 'ordinal'].includes(r.type) ? r.type : 'quantitative';
  let min = null, max = null;
  if (type === 'temporal') {
    const a = Date.parse(String(r.min ?? '')), b = Date.parse(String(r.max ?? ''));
    min = Number.isFinite(a) ? a : null; max = Number.isFinite(b) ? b : null;
  } else {
    min = parseEng(r.min); max = parseEng(r.max);
  }
  const distinct = parseEng(r.distinct);
  return { name, type, min, max, distinct: distinct > 0 ? Math.round(distinct) : null };
}

function timeFormat(ms) {
  // d3-time-format specifiers by the span of the axis.
  const d = ms / 86400000;
  if (!(d > 0)) return null;
  if (d <= 2) return '%H:%M';
  if (d <= 90) return '%b %d';
  if (d <= 3 * 365) return '%b %Y';
  return '%Y';
}

export function run({ fields, goal, rows: nRows, library, title, dataUrl, aggregate }) {
  const warnings = [];
  const why = [];
  const F = (fields || []).map(readField).filter((f) => f.name);
  if (!F.length) return { warnings: ['Add the fields of your data: a name and a type (quantitative, temporal, nominal or ordinal) each.'] };
  const dupes = F.map((f) => f.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dupes.length) warnings.push(`Field names repeat (${[...new Set(dupes)].join(', ')}): each must be unique.`);
  const Q = F.filter((f) => f.type === 'quantitative'), T = F.filter((f) => f.type === 'temporal'), N = F.filter((f) => f.type === 'nominal' || f.type === 'ordinal');
  const n = nRows > 0 ? Math.round(nRows) : null;
  const agg = aggregate === 'none' ? null : ['sum', 'mean', 'median', 'max', 'min'].includes(aggregate) ? aggregate : 'sum';

  // 1. The question
  let g = goal;
  if (!GOALS[g]) {
    if (T.length && Q.length) g = N.length ? 'trend' : 'trend';
    else if (Q.length >= 2) g = 'relationship';
    else if (N.length && Q.length) g = (N[0].distinct || 0) > 12 ? 'ranking' : 'compare';
    else if (Q.length === 1) g = 'distribution';
    else g = 'compare';
    why.push(['Question', GOALS[g], `chosen from the fields: ${[T.length && `${T.length} temporal`, Q.length && `${Q.length} quantitative`, N.length && `${N.length} categorical`].filter(Boolean).join(', ')}`]);
  } else why.push(['Question', GOALS[g], 'as given']);

  // 2. Chart and encodings: enc = {x, y, color, size, xOffset}; each {field, type, agg?, bin?, scale?}
  let mark = 'bar';
  const enc = {};
  const need = (cond, msg) => { if (!cond) warnings.push(msg); return cond; };
  const cat = N[0], cat2 = N[1], q0 = Q[0], q1 = Q[1], t0 = T[0];
  let horizontal = false;
  switch (g) {
    case 'trend':
    case 'composition': {
      if (!need(t0 && q0, `${GOALS[g]} needs a temporal and a quantitative field.`)) break;
      mark = g === 'composition' ? 'area' : (n && n <= 12 ? 'line+point' : 'line');
      enc.x = { field: t0.name, type: 'temporal' };
      enc.y = { field: q0.name, type: 'quantitative', agg: cat || g === 'composition' ? agg : null };
      if (cat) enc.color = { field: cat.name, type: cat.type };
      else if (Q.length > 1 && g === 'trend') enc.fold = Q.slice(0, 4).map((f) => f.name);
      why.push(['Chart', mark === 'area' ? 'stacked area' : 'line', g === 'composition' ? 'stacked areas show how parts add up over time' : 'position along a common time axis shows change best (Cleveland & McGill)']);
      if (mark === 'line+point') why.push(['Points', 'marked', `only ${n} points: show each one`]);
      if (g === 'composition' && !cat) warnings.push('Composition over time needs a categorical field for the parts; without it this is one area.');
      break;
    }
    case 'compare':
    case 'ranking':
    case 'part': {
      if (!need(cat, `${GOALS[g]} needs a categorical (nominal or ordinal) field.`)) break;
      const k = cat.distinct;
      if (g === 'part' && k && k <= 5 && !cat2) {
        mark = 'arc';
        enc.theta = { field: q0?.name, type: 'quantitative', agg: q0 ? agg : 'count' };
        enc.color = { field: cat.name, type: cat.type };
        why.push(['Chart', 'donut', `${k} parts: few enough to compare angles`]);
      } else {
        mark = 'bar';
        horizontal = g === 'ranking' || (k != null && k > 7);
        const catEnc = { field: cat.name, type: cat.type, sort: cat.type === 'nominal' ? '-value' : null };
        const valEnc = { field: q0?.name, type: 'quantitative', agg: q0 ? agg : 'count', stack: g === 'part' ? 'normalize' : null };
        if (horizontal) { enc.y = catEnc; enc.x = valEnc; } else { enc.x = catEnc; enc.y = valEnc; }
        if (cat2) { enc.color = { field: cat2.name, type: cat2.type }; if (g !== 'part') enc.offset = cat2.name; }
        if (g === 'part') {
          if (!cat2) { enc.color = { field: cat.name, type: cat.type }; }
          why.push(['Chart', '100 % stacked bar', k > 5 ? `${k} parts are too many for a pie: angles that close cannot be compared` : 'parts of a whole as lengths on one bar']);
        } else {
          why.push(['Chart', `${horizontal ? 'horizontal ' : ''}${cat2 ? 'grouped ' : ''}bar`, horizontal ? (g === 'ranking' ? 'a ranking reads top-down, labels stay horizontal' : `${k} categories: long label lists fit better on the vertical axis`) : 'length from a common baseline compares values best']);
        }
        if (cat.type === 'nominal') why.push(['Order', 'by value, descending', 'nominal categories have no order of their own: sort so the ranking is visible']);
        else why.push(['Order', 'the ordinal order', 'ordinal categories keep their natural order']);
        if (g === 'ranking' && k > 20) { enc.top = 20; why.push(['Limit', 'top 20', `${k} bars would not fit; filter to the top 20`]); }
      }
      if (!q0) why.push(['Value', 'count of rows', 'no quantitative field: bars count the rows per category']);
      break;
    }
    case 'distribution': {
      if (!need(q0, 'A distribution needs a quantitative field.')) break;
      if (cat && (cat.distinct || 99) <= 8) {
        mark = 'boxplot';
        enc.x = { field: cat.name, type: cat.type };
        enc.y = { field: q0.name, type: 'quantitative' };
        why.push(['Chart', 'box plot per group', `compares ${cat.distinct || 'a few'} distributions side by side (median, quartiles, 1.5 IQR whiskers)`]);
      } else {
        mark = 'bar';
        const bins = n ? (n < 200 ? Math.ceil(Math.log2(n)) + 1 : Math.ceil(2 * Math.cbrt(n))) : 20;
        enc.x = { field: q0.name, type: 'quantitative', bin: bins };
        enc.y = { type: 'quantitative', agg: 'count' };
        why.push(['Chart', 'histogram', `${bins} bins (${n ? (n < 200 ? 'Sturges' : 'Rice rule') : 'default'}${n ? `, n = ${n}` : ''})`]);
      }
      break;
    }
    case 'relationship': {
      if (!need(q0 && q1, 'A relationship needs two quantitative fields.')) break;
      mark = 'point';
      enc.x = { field: q0.name, type: 'quantitative' };
      enc.y = { field: q1.name, type: 'quantitative' };
      if (Q[2]) enc.size = { field: Q[2].name, type: 'quantitative' };
      if (cat) enc.color = { field: cat.name, type: cat.type };
      why.push(['Chart', Q[2] ? 'bubble scatter' : 'scatter', 'two positions show correlation, clusters and outliers']);
      if (n && n > 5000) { enc.opacity = 0.3; why.push(['Overplotting', 'opacity 0.3', `${n} points overlap; consider a 2D binned heatmap above ~50 000`]); }
      break;
    }
    default: break;
  }
  if (!enc.x && !enc.theta) return { warnings, tables: [{ title: 'Decisions', columns: ['Decision', 'Choice', 'Why'], rows: why }] };

  // 3. Scales
  const scales = {};
  const byName = Object.fromEntries(F.map((f) => [f.name, f]));
  for (const ch of ['x', 'y']) {
    const e = enc[ch];
    if (!e) continue;
    const f = byName[e.field];
    if (e.type === 'temporal') {
      const span = f && f.min != null && f.max != null ? f.max - f.min : null;
      const fmt = span ? timeFormat(span) : null;
      scales[ch] = { type: 'time', format: fmt };
      why.push([`${ch} scale`, `time${fmt ? `, ticks ${fmt}` : ''}`, span ? `spans ${fmtNum(span / 86400000, 3)} days` : 'give min and max dates for a tick format']);
    } else if (e.type === 'quantitative' && !e.bin && e.agg !== 'count' && f) {
      const lengthMark = mark === 'bar' || mark === 'area';
      if (f.min != null && f.max != null && f.min > 0 && f.max / f.min >= 1000) {
        if (lengthMark) {
          scales[ch] = { type: 'linear', zero: true };
          why.push([`${ch} scale`, 'linear from zero, not log', `${f.name} spans ${fmtNum(Math.log10(f.max / f.min), 2)} decades, but a bar on a log axis has no zero to start from; if the small values matter, use a dot plot on a log axis`]);
          continue;
        } else {
          scales[ch] = { type: 'log', zero: false };
          why.push([`${ch} scale`, 'log', `${f.name} spans ${fmtNum(Math.log10(f.max / f.min), 2)} decades (${fmtNum(f.min, 3)} to ${fmtNum(f.max, 3)})`]);
          continue;
        }
      }
      let zero;
      if (lengthMark) { zero = true; why.push([`${ch} scale`, 'linear from zero', 'bar and area length must start at zero or it lies']); }
      else if (f.min != null && f.max != null) {
        zero = f.min >= 0 && f.min < 0.3 * f.max;
        why.push([`${ch} scale`, zero ? 'linear from zero' : 'linear, fitted to the data', zero ? 'the data starts near zero anyway' : f.min < 0 && f.max > 0 ? `the data crosses zero (${fmtNum(f.min, 3)} to ${fmtNum(f.max, 3)})` : `values sit in ${fmtNum(f.min, 3)} to ${fmtNum(f.max, 3)}: a zero baseline would flatten the change`]);
      } else { zero = false; why.push([`${ch} scale`, 'linear, fitted to the data', 'give min and max to decide about zero']); }
      scales[ch] = { type: 'linear', zero };
      if (lengthMark && f.min != null && f.min < 0) why.push(['Negative values', 'bars go below zero', 'fine for gains/losses; colour by sign if it matters']);
    } else if (e.bin) {
      continue; // binned: the bins are the axis
    } else if (e.type === 'quantitative') {
      scales[ch] = { type: 'linear', zero: true };
    } else {
      scales[ch] = { type: 'band' };
    }
  }
  if (enc.color) {
    const f = byName[enc.color.field];
    const k = f?.distinct;
    if (k && k > 10) warnings.push(`${f.name} has ${k} values: more than ~8-10 colours cannot be told apart. Facet into small multiples, or colour the top few and grey the rest.`);
    why.push(['Colour', f?.type === 'ordinal' ? 'sequential scheme' : 'categorical scheme', f?.type === 'ordinal' ? 'ordered categories need an ordered palette' : 'unordered categories need distinct hues']);
  }
  if (enc.fold) {
    const fs = enc.fold.map((nm) => byName[nm]).filter((f) => f.min != null && f.max != null);
    const mags = fs.map((f) => Math.max(Math.abs(f.min), Math.abs(f.max))).filter((v) => v > 0);
    if (mags.length > 1 && Math.max(...mags) / Math.min(...mags) > 10) warnings.push(`${enc.fold.join(', ')} differ over 10× in size: on one axis the small one looks flat. Use separate panels rather than a second y axis (dual axes invite false correlation).`);
    why.push(['Series', `${enc.fold.length} measures as lines`, 'several quantitative fields share the time axis; folded into one colour legend']);
  }
  if (n && n > 2000 && (mark === 'line' || mark === 'area')) why.push(['Data', `${n} points`, 'more points than pixels: aggregate by time unit (hour, day) or the line turns into a band']);

  // 4. The configurations
  const name = String(title || '').trim();
  const url = String(dataUrl || '').trim();
  const out = { vegalite: vegaLite(), chartjs: chartJs(), echarts: eCharts() };
  const lib = out[library] ? library : 'vegalite';

  function vegaLite() {
    const vlMark = mark === 'line+point' ? { type: 'line', point: true } : mark === 'arc' ? { type: 'arc', innerRadius: 50 } : mark === 'point' && enc.opacity ? { type: 'point', opacity: enc.opacity } : mark;
    const e = {};
    const chan = (c) => {
      const x = enc[c]; if (!x) return;
      const o = {};
      if (x.field && !(x.agg === 'count' && !x.field)) o.field = x.field;
      o.type = x.type;
      if (x.agg && x.field) o.aggregate = x.agg; else if (x.agg === 'count') o.aggregate = 'count';
      if (x.bin) o.bin = { maxbins: x.bin };
      if (x.sort) o.sort = x.sort;
      if (x.stack) o.stack = x.stack;
      const sc = scales[c];
      if (sc && sc.type === 'log') o.scale = { type: 'log' };
      else if (sc && sc.type === 'linear') o.scale = { zero: sc.zero };
      if (sc?.format) o.axis = { format: sc.format };
      e[c] = o;
    };
    ['x', 'y', 'color', 'size', 'theta'].forEach(chan);
    if (enc.offset) e.xOffset = { field: enc.offset };
    const spec = { $schema: 'https://vega.github.io/schema/vega-lite/v5.json' };
    if (name) spec.title = name;
    spec.data = url ? { url } : { values: [] };
    if (enc.fold) { spec.transform = [{ fold: enc.fold, as: ['measure', 'value'] }]; e.y = { field: 'value', type: 'quantitative', scale: e.y?.scale }; e.color = { field: 'measure', type: 'nominal' }; }
    if (enc.top) {
      // aggregate per category, rank, keep the top 20; the encoding then reads the aggregated field
      const v = enc.x.field || 'count', op = enc.x.field ? (enc.x.agg || 'sum') : 'count';
      spec.transform = [{ aggregate: [{ op, ...(enc.x.field ? { field: v } : {}), as: v }], groupby: [enc.y.field] },
        { window: [{ op: 'row_number', as: 'rank' }], sort: [{ field: v, order: 'descending' }] }, { filter: 'datum.rank <= 20' }];
      e.x = { field: v, type: 'quantitative', scale: e.x?.scale };
    }
    spec.mark = vlMark;
    spec.encoding = e;
    spec.width = 'container';
    return JSON.stringify(spec, null, 2);
  }

  function chartJs() {
    const type = { line: 'line', 'line+point': 'line', area: 'line', bar: 'bar', point: enc.size ? 'bubble' : 'scatter', arc: 'doughnut', boxplot: 'boxplot' }[mark];
    const axis = (c) => {
      const sc = scales[c], x = enc[c];
      if (!x) return undefined;
      const o = {};
      if (sc?.type === 'time') { o.type = 'time'; if (sc.format) o.time = { tooltipFormat: 'PP' }; }
      else if (sc?.type === 'log') o.type = 'logarithmic';
      else if (sc?.type === 'band') o.type = 'category';
      else { o.type = 'linear'; o.beginAtZero = !!sc?.zero; }
      if (x.stack) o.stacked = true;
      if (mark === 'area' && c === 'y') o.stacked = true;
      o.title = { display: true, text: x.field ? `${x.agg && x.agg !== 'count' ? x.agg + ' of ' : ''}${x.field}` : 'count' };
      return o;
    };
    const cfg = {
      type,
      data: { labels: [], datasets: enc.fold ? enc.fold.map((f) => ({ label: f, data: [] })) : [{ label: (horizontal ? enc.x : enc.y || enc.theta)?.field || 'count', data: [], ...(mark === 'area' ? { fill: true } : {}), ...(mark === 'line' ? { pointRadius: 0 } : {}) }] },
      options: {
        responsive: true,
        ...(horizontal ? { indexAxis: 'y' } : {}),
        plugins: { ...(name ? { title: { display: true, text: name } } : {}), legend: { display: !!(enc.color || enc.fold) } },
        ...(type === 'doughnut' ? {} : { scales: { x: axis('x'), y: axis('y') } }),
      },
    };
    const notes = [];
    if (scales.x?.type === 'time' || scales.y?.type === 'time') notes.push('// time axes need a date adapter: import "chartjs-adapter-date-fns"');
    if (type === 'boxplot') notes.push('// box plots need the @sgratzl/chartjs-chart-boxplot plugin');
    if (enc.color && !enc.fold) notes.push(`// one dataset per ${enc.color.field} value`);
    if (enc.x?.bin) notes.push(`// histogram: bin ${enc.x.field} into ${enc.x.bin} bins first, labels = bin ranges, data = counts`);
    return [...notes, `const config = ${JSON.stringify(cfg, null, 2)};`].join('\n');
  }

  function eCharts() {
    const ax = (c) => {
      const sc = scales[c];
      if (!enc[c]) return { type: 'value' };
      if (enc[c].bin) return { type: 'category', data: [], name: `${enc[c].field} (bins)` };
      if (sc?.type === 'time') return { type: 'time' };
      if (sc?.type === 'log') return { type: 'log' };
      if (sc?.type === 'band') return { type: 'category', data: [] };
      return { type: 'value', scale: !sc?.zero, name: enc[c].field || 'count' };
    };
    const stype = { line: 'line', 'line+point': 'line', area: 'line', bar: 'bar', point: 'scatter', arc: 'pie', boxplot: 'boxplot' }[mark];
    const series = (enc.fold || [enc.y?.field || 'count']).map((nm) => ({ name: nm, type: stype, data: [],
      ...(mark === 'area' ? { stack: 'total', areaStyle: {} } : {}), ...(mark === 'line' ? { showSymbol: false } : {}),
      ...(enc.x?.stack || enc.y?.stack ? { stack: 'total' } : {}), ...(stype === 'pie' ? { radius: ['40%', '70%'] } : {}) }));
    const opt = { ...(name ? { title: { text: name } } : {}), tooltip: { trigger: stype === 'scatter' || stype === 'pie' ? 'item' : 'axis' },
      ...(enc.color || enc.fold ? { legend: {} } : {}),
      ...(stype === 'pie' ? {} : { xAxis: ax('x'), yAxis: ax('y') }),
      series };
    const pre = [];
    if (enc.color && !enc.fold && stype !== 'pie') pre.push(`// one series per ${enc.color.field} value`);
    if (enc.x?.bin) pre.push(`// histogram: bin ${enc.x.field} into ${enc.x.bin} bins first (xAxis category = bin ranges)`);
    return [...pre, `const option = ${JSON.stringify(opt, null, 2)};`].join('\n');
  }

  const label = { vegalite: 'Vega-Lite', chartjs: 'Chart.js', echarts: 'ECharts' }[lib];
  const markName = { line: 'line', 'line+point': 'line with points', area: 'stacked area', bar: enc.x?.bin ? 'histogram' : 'bar', point: enc.size ? 'bubble' : 'scatter', arc: 'donut', boxplot: 'box plot' }[mark];
  const fieldDesc = (c) => (!enc[c] ? '–' : enc[c].bin ? `${enc[c].field} (binned)` : enc[c].agg && enc[c].field ? `${enc[c].agg}(${enc[c].field})` : enc[c].agg === 'count' ? 'count' : enc[c].field);
  const scaleDesc = (c) => (enc[c]?.bin ? `${enc[c].bin} bins` : scales[c] ? `${scales[c].type} scale${scales[c].type === 'linear' ? (scales[c].zero ? ', from 0' : ', fitted') : ''}` : null);
  return {
    values: [
      { label: 'Chart', value: markName, tone: 'ok', hint: horizontal ? 'horizontal' : null },
      ...(enc.theta ? [{ label: 'Angle', value: fieldDesc('theta') }] : [
        { label: 'x', value: fieldDesc('x'), hint: scaleDesc('x') },
        { label: 'y', value: enc.fold ? enc.fold.join(', ') : fieldDesc('y'), hint: scaleDesc('y') }]),
      { label: 'Colour', value: enc.fold ? 'measure' : enc.color?.field || '–', hint: enc.color || enc.fold ? `${(enc.fold || []).length || enc.color && byName[enc.color.field]?.distinct || '?'} categories` : null },
    ],
    tables: [{ title: 'Decisions', columns: ['Decision', 'Choice', 'Why'], rows: why }],
    texts: [
      { title: label, body: out[lib], lang: lib === 'vegalite' ? 'json' : 'js' },
      ...Object.entries(out).filter(([k]) => k !== lib).map(([k, v]) => ({ title: { vegalite: 'Vega-Lite', chartjs: 'Chart.js', echarts: 'ECharts' }[k], body: v, lang: k === 'vegalite' ? 'json' : 'js' })),
    ],
    warnings,
    notes: ['The configurations have empty data: fill data.values (Vega-Lite), labels/datasets (Chart.js) or series data (ECharts) from your source.', 'Aggregation applies when several rows share an x value or category; choose None for data that is already one row per point.'],
    spec: { mark, horizontal, encoding: enc, scales },
  };
}
