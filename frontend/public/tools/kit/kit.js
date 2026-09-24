// The kit every folder tool is built on: a form from the manifest's inputs,
// the tool's run() on every change, its results drawn, and the outputs
// (Prompt, JSON and the tool's own texts) with Copy.
//
// A tool folder holds:
//   manifest.json  what it is, its inputs, how to use it (read by the app,
//                  the MCP server and the tool-picking model too)
//   tool.js        export function run(input) -> result   (pure: no DOM)
//   index.html     three lines that call mount()
//   view.js        optional: export function view(el, result, input, api)
//                  for a drawing the standard blocks cannot make; api.set(key,
//                  value) changes an input (a clicked bit), api.raw is the form
//
// A result is { values, tables, texts, charts, warnings, notes } - every key
// optional:
//   values   [{label, value, unit?, hint?, tone?: 'ok'|'warn'|'bad'}]
//   tables   [{title?, columns: [..], rows: [[..]]}]
//   texts    [{title, body, lang?}]          -> each becomes an output tab
//   charts   [{title?, type: 'line'|'bars', x: [..], series: [{name, y: [..]}],
//              xLabel?, yLabel?}]
//   warnings [string]                       notes [string]

import { parseEng, fmtNum } from './eng.js';

const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ } },
};

// Usage, for the Analytics tab: only when served by the app, never from a file.
// A keepalive fetch rather than a beacon, because with sign-in on the app's
// API wants its CSRF header, which a beacon cannot carry.
function ping(id, event) {
  if (!/^https?:/.test(location.protocol)) return;
  try {
    fetch('/api/tools/usage', {
      method: 'POST', keepalive: true, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' },
      body: JSON.stringify({ id, event, surface: 'ui' }),
    }).catch(() => undefined);
  } catch { /* analytics never breaks a tool */ }
}

async function copy(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = $('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
    document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const was = btn.textContent;
  btn.textContent = ok ? 'Copied' : 'Select and copy';
  setTimeout(() => { btn.textContent = was; }, 1400);
  return ok;
}

// ---------------- inputs ----------------
function readValue(def, raw) {
  switch (def.type) {
    case 'number': {
      const v = parseEng(raw);
      return v;
    }
    case 'bool': return !!raw;
    case 'table': return raw || [];
    default: return raw ?? '';
  }
}

function fieldFor(def, value, onChange) {
  const id = `f-${def.key}`;
  const label = $('label', { for: id, class: 'k-label' }, def.label, def.unit ? $('span', { class: 'k-unit' }, ` ${def.unit}`) : null);
  let control;
  if (def.type === 'select') {
    control = $('select', { id, onchange: (e) => onChange(e.target.value) },
      (def.options || []).map((o) => {
        const [v, t] = Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, o];
        return $('option', { value: v, selected: String(v) === String(value) }, t);
      }));
  } else if (def.type === 'bool') {
    control = $('input', { id, type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked) });
    const long = def.wide || String(def.label).length > 22 || def.help;
    return $('div', { class: `k-field k-check${long ? ' k-wide' : ''}` }, control, label, def.help ? $('div', { class: 'k-help' }, def.help) : null);
  } else if (def.type === 'textarea') {
    control = $('textarea', { id, rows: def.rows || 6, spellcheck: 'false', placeholder: def.placeholder || '',
      oninput: (e) => onChange(e.target.value) });
    control.value = value ?? '';
  } else if (def.type === 'table') {
    control = tableEditor(def, value || [], onChange);
  } else {
    control = $('input', { id, type: 'text', inputmode: def.type === 'number' ? 'decimal' : null,
      spellcheck: 'false', placeholder: def.placeholder || '', oninput: (e) => onChange(e.target.value) });
    control.value = value ?? '';
  }
  const wide = def.type === 'textarea' || def.type === 'table' || def.wide;
  return $('div', { class: `k-field${wide ? ' k-wide' : ''}` }, label, control,
    def.help ? $('div', { class: 'k-help' }, def.help) : null);
}

/** Rows of cells, one column per def.columns entry: {key, label, type?, options?}. */
function tableEditor(def, rows, onChange) {
  const wrap = $('div', { class: 'k-tedit' });
  const draw = () => {
    wrap.replaceChildren();
    const head = $('tr', {}, def.columns.map((c) => $('th', {}, c.label)), $('th', {}, ''));
    const body = rows.map((r, i) => $('tr', {},
      def.columns.map((c) => {
        const cell = c.type === 'select'
          ? $('select', { 'aria-label': c.label, onchange: (e) => { r[c.key] = e.target.value; onChange(rows); } },
            (c.options || []).map((o) => $('option', { value: o, selected: String(r[c.key]) === String(o) }, o)))
          : $('input', { 'aria-label': c.label, spellcheck: 'false', oninput: (e) => { r[c.key] = e.target.value; onChange(rows); } });
        if (c.type !== 'select') cell.value = r[c.key] ?? '';
        return $('td', {}, cell);
      }),
      $('td', {}, $('button', { class: 'k-btn k-x', title: 'Remove row', 'aria-label': 'Remove row',
        onclick: () => { rows.splice(i, 1); onChange(rows); draw(); } }, '×'))));
    wrap.append($('table', {}, $('thead', {}, head), $('tbody', {}, body)),
      $('button', { class: 'k-btn', onclick: () => {
        rows.push(Object.fromEntries(def.columns.map((c) => [c.key, c.default ?? ''])));
        onChange(rows); draw();
      } }, '+ Add row'));
  };
  draw();
  return wrap;
}

// ---------------- results ----------------
// Whole numbers as they are (a byte count of 41236 is not 41240); the rest
// to four significant figures.
const show = (v, digits = 4) => (Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : fmtNum(v, digits));

function drawValues(values) {
  return $('div', { class: 'k-values' }, values.map((v) =>
    $('div', { class: `k-value${v.tone ? ` k-${v.tone}` : ''}`, title: v.hint || null },
      $('span', {}, v.label),
      $('b', {}, typeof v.value === 'number' ? show(v.value) : String(v.value ?? '–'), v.unit ? $('small', {}, ` ${v.unit}`) : null),
      v.hint ? $('em', {}, v.hint) : null)));
}

function drawTable(t) {
  return $('div', { class: 'k-block' }, t.title ? $('div', { class: 'k-title' }, t.title) : null,
    $('div', { class: 'k-tablewrap' }, $('table', { class: 'k-table' },
      $('thead', {}, $('tr', {}, t.columns.map((c) => $('th', {}, c)))),
      $('tbody', {}, t.rows.map((r) => $('tr', {}, r.map((c) => $('td', {}, typeof c === 'number' ? show(c) : String(c ?? '')))))))));
}

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

function drawChart(c) {
  const W = 560, H = 220, L = 46, R = 12, T = 12, B = 30;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'k-chart', role: 'img', 'aria-label': c.title || 'chart' });
  const all = c.series.flatMap((se) => se.y).filter(Number.isFinite);
  // The axis includes zero for bars; lines (a dB response, all below zero)
  // keep to their data. A flat series still gets a visible range.
  let lo = Math.min(...all), hi = Math.max(...all);
  if (c.type === 'bars' || !all.length) { lo = Math.min(0, lo || 0); hi = Math.max(0, hi || 0); }
  if (!(hi > lo)) { const pad = Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad; }
  const n = c.x.length;
  const X = (i) => L + (n <= 1 ? 0 : (i * (W - L - R)) / (c.type === 'bars' ? n : n - 1)) + (c.type === 'bars' ? (W - L - R) / n / 2 : 0);
  const Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    svg.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'k-grid' }));
    const t = s('text', { x: L - 6, y: Y(v) + 3, class: 'k-axis', 'text-anchor': 'end' }); t.textContent = fmtNum(v, 3); svg.append(t);
  }
  const every = Math.max(1, Math.ceil(n / 8));
  c.x.forEach((xv, i) => {
    if (i % every) return;
    const t = s('text', { x: X(i), y: H - 10, class: 'k-axis', 'text-anchor': 'middle' });
    t.textContent = typeof xv === 'number' ? fmtNum(xv, 3) : xv; svg.append(t);
  });
  c.series.forEach((se, si) => {
    const cls = `k-s${si % 4}`;
    if (c.type === 'bars') {
      const bw = Math.max(2, ((W - L - R) / n) * 0.7 / c.series.length);
      se.y.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = X(i) - (bw * c.series.length) / 2 + si * bw;
        const base = Y(Math.max(lo, Math.min(hi, 0)));
        const r = s('rect', { x, y: Math.min(Y(v), base), width: bw - 1, height: Math.abs(Y(v) - base), rx: 2, class: cls });
        const tt = s('title'); tt.textContent = `${se.name}: ${c.x[i]} → ${fmtNum(v, 4)}`; r.append(tt); svg.append(r);
      });
    } else {
      const d = se.y.map((v, i) => (Number.isFinite(v) ? `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}` : '')).join('');
      svg.append(s('path', { d, class: `${cls} k-line` }));
    }
  });
  const legend = c.series.length > 1
    ? $('div', { class: 'k-legend' }, c.series.map((se, si) => $('span', {}, $('i', { class: `k-s${si % 4}` }), se.name))) : null;
  return $('div', { class: 'k-block' }, c.title ? $('div', { class: 'k-title' }, c.title) : null, svg, legend,
    c.xLabel || c.yLabel ? $('div', { class: 'k-help' }, [c.yLabel, c.xLabel].filter(Boolean).join(' against ')) : null);
}

// ---------------- the prompt ----------------
/** Whether an input is in play: one with `when` only while that other input has that value. */
export function isShown(d, input) {
  const w = d.when;
  if (!w) return true;
  const v = String(input[w.key] ?? '');
  return w.in ? w.in.map(String).includes(v) : v === String(w.equals);
}

function inputText(manifest, input) {
  return manifest.inputs.filter((d) => isShown(d, input)).map((d) => {
    const v = input[d.key];
    if (d.type === 'table') {
      const rows = (v || []).map((r) => '  - ' + d.columns.map((c) => `${c.label}: ${r[c.key] ?? ''}`).join(', '));
      return `- ${d.label}:\n${rows.join('\n') || '  (none)'}`;
    }
    if (d.type === 'textarea') return `- ${d.label}:\n${String(v || '').split('\n').map((l) => '    ' + l).join('\n')}`;
    return `- ${d.label}: ${d.type === 'bool' ? (v ? 'yes' : 'no') : (v ?? '')}${d.unit ? ' ' + d.unit : ''}`;
  }).join('\n');
}

export function promptFor(manifest, input, result) {
  const out = [`Tool: ${manifest.name} - ${manifest.blurb}`, '', 'Inputs:', inputText(manifest, input), ''];
  if (result.values?.length) {
    out.push('Results:');
    for (const v of result.values) out.push(`- ${v.label}: ${typeof v.value === 'number' ? show(v.value, 5) : v.value}${v.unit ? ' ' + v.unit : ''}${v.hint ? ` (${v.hint})` : ''}`);
    out.push('');
  }
  for (const t of result.tables || []) {
    out.push(`${t.title || 'Table'}:`, '| ' + t.columns.join(' | ') + ' |', '|' + t.columns.map(() => '---').join('|') + '|');
    for (const r of t.rows) out.push('| ' + r.map((c) => (typeof c === 'number' ? show(c, 5) : String(c ?? ''))).join(' | ') + ' |');
    out.push('');
  }
  if (result.warnings?.length) out.push('Warnings:', ...result.warnings.map((w) => `- ${w}`), '');
  if (result.notes?.length) out.push('Notes:', ...result.notes.map((w) => `- ${w}`), '');
  if (manifest.prompt) out.push(manifest.prompt);
  return out.join('\n').trim() + '\n';
}

// ---------------- mount ----------------
export async function mount(base = './') {
  const manifest = await (await fetch(base + 'manifest.json')).json();
  const tool = await import(new URL(base + 'tool.js', location.href).href);
  let view = null;
  if (manifest.view) { try { view = (await import(new URL(base + 'view.js', location.href).href)).view; } catch (e) { console.error(e); } }
  document.title = `${manifest.name} — ${manifest.blurb}`;
  const KEY = `redline.tool.${manifest.id}.input`;
  const defaults = () => Object.fromEntries(manifest.inputs.map((d) => [d.key, d.default ?? (d.type === 'table' ? [] : d.type === 'bool' ? false : '')]));
  let raw = { ...defaults(), ...(store.get(KEY) || {}) };
  let tab = store.get(KEY + '.tab') || 'Prompt';
  let last = null, pinged = false;

  const form = $('div', { class: 'k-form' });
  const results = $('div', { class: 'k-results', 'aria-live': 'polite' });
  const custom = $('div', { class: 'k-view' });
  const tabs = $('div', { class: 'k-tabs', role: 'tablist' });
  const pre = $('pre', { class: 'k-out', tabindex: '0' });
  const count = $('span', { class: 'k-count' });
  const copyBtn = $('button', { class: 'k-btn k-primary', onclick: async () => {
    if (await copy(pre.textContent, copyBtn)) ping(manifest.id, 'copy');
  } }, 'Copy');

  // An input with `when: {key, equals | in}` shows only while that other
  // input has that value - a fab's custom limits only when the fab is Custom.
  const shown = (d) => isShown(d, raw);
  const drawForm = () => {
    form.replaceChildren(...manifest.inputs.filter(shown).map((d) => fieldFor(d, raw[d.key], (v) => {
      raw[d.key] = v; store.set(KEY, raw);
      if (manifest.inputs.some((x) => x.when?.key === d.key)) drawForm();
      compute();
    })));
  };

  const outputs = () => {
    if (!last) return [];
    const input = Object.fromEntries(manifest.inputs.map((d) => [d.key, readValue(d, raw[d.key])]));
    return [
      ...(last.texts || []).map((t) => ({ name: t.title, body: t.body })),
      { name: 'Prompt', body: promptFor(manifest, raw, last) },
      { name: 'JSON', body: JSON.stringify({ tool: manifest.id, input, result: last }, null, 2) },
    ];
  };

  const drawOutputs = () => {
    const outs = outputs();
    if (!outs.find((o) => o.name === tab)) tab = outs[0]?.name || 'Prompt';
    tabs.replaceChildren(...outs.map((o) => $('button', { role: 'tab', class: 'k-tab', 'aria-selected': String(o.name === tab),
      onclick: () => { tab = o.name; store.set(KEY + '.tab', tab); drawOutputs(); } }, o.name)));
    const cur = outs.find((o) => o.name === tab);
    pre.textContent = cur ? cur.body : '';
    count.textContent = cur ? `${cur.body.length} characters` : '';
  };

  const compute = async () => {
    const input = Object.fromEntries(manifest.inputs.map((d) => [d.key, readValue(d, raw[d.key])]));
    const bad = manifest.inputs.filter((d) => d.type === 'number' && d.required !== false && String(raw[d.key] ?? '').trim() !== '' && input[d.key] == null);
    for (const el of form.querySelectorAll('.k-bad')) el.classList.remove('k-bad');
    for (const d of bad) form.querySelector(`#f-${d.key}`)?.classList.add('k-bad');
    try {
      last = await tool.run(input) || {};
      if (bad.length) (last.warnings ||= []).unshift(`Not a number: ${bad.map((d) => d.label).join(', ')}. Write it like 4.7, 4k7 or 100n.`);
    } catch (e) {
      last = { warnings: [`${e.message || e}`] };
    }
    results.replaceChildren(
      ...(last.warnings?.length ? [$('div', { class: 'k-warns' }, last.warnings.map((w) => $('div', {}, w)))] : []),
      ...(last.values?.length ? [drawValues(last.values)] : []),
      ...(last.charts || []).map(drawChart),
      ...(last.tables || []).map(drawTable),
      ...(last.notes?.length ? [$('div', { class: 'k-notes' }, last.notes.map((w) => $('div', {}, w)))] : []));
    if (view) {
      // A drawing may change an input - a bit clicked, a node dragged - with api.set.
      const set = (key, value) => { raw[key] = value; store.set(KEY, raw); drawForm(); compute(); };
      try { view(custom, last, input, { fmtNum, set, raw: { ...raw } }); } catch (e) { console.error(e); }
    }
    drawOutputs();
    if (!pinged) { pinged = true; ping(manifest.id, 'run'); }
  };

  const ex = manifest.examples?.[0];
  const bar = $('header', { class: 'k-bar' },
    $('h1', { class: 'brand' }, manifest.name, $('span', {}, ` — ${manifest.blurb}`)),
    $('div', { class: 'k-actions' },
      ex ? $('button', { class: 'k-btn', onclick: () => { raw = { ...defaults(), ...structuredClone(ex.input) }; store.set(KEY, raw); drawForm(); compute(); } }, 'Example') : null,
      $('button', { class: 'k-btn', onclick: () => { raw = defaults(); store.set(KEY, raw); drawForm(); compute(); } }, 'Reset')));
  document.body.replaceChildren(bar,
    $('main', { class: 'k-main' },
      $('section', { class: 'k-left' }, manifest.intro ? $('p', { class: 'k-intro' }, manifest.intro) : null, form),
      $('section', { class: 'k-right' }, results, custom,
        $('div', { class: 'k-outwrap' }, $('div', { class: 'k-outbar' }, tabs, count, copyBtn), pre))));
  drawForm();
  compute();
}
