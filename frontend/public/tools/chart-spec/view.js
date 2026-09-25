// Chart Spec Builder page: the chart is the interface. The chosen chart is
// drawn large with sample data shaped by your fields' ranges, and every
// decision the tool made is pinned where it shows (the zero baseline, the log
// axis, the sort order, the bins, the legend). Ask a different question from
// the strip on top, drag the field cards to change which field leads, click a
// type badge to retype a field, click the value-axis title to change the
// aggregate, scrub the row count; the configuration below follows.
// The encodings, scales, bins and limits all come from run(); only the
// sample marks are made up, and the page says so.

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const QUESTIONS = [
  ['auto', 'Decide', 'Decide from the fields'],
  ['trend', 'Trend', 'Trend over time'],
  ['compare', 'Compare', 'Compare categories'],
  ['ranking', 'Ranking', 'Ranking'],
  ['distribution', 'Distribution', 'Distribution'],
  ['relationship', 'Relationship', 'Relationship between two measures'],
  ['part', 'Part of whole', 'Part of a whole'],
  ['composition', 'Composition', 'Composition over time'],
];
const QPICT = {
  auto: '<path d="M6 18l6-6 4 3 8-9" class="qp-l"/><circle cx="26" cy="7" r="2.4" class="qp-f"/><path d="M4 21h28" class="qp-a"/>',
  trend: '<path d="M4 17l6-4 5 2 6-7 6 3 4-4" class="qp-l"/><path d="M4 21h28" class="qp-a"/>',
  compare: '<rect x="5" y="9" width="5" height="12" class="qp-f"/><rect x="13" y="5" width="5" height="16" class="qp-f"/><rect x="21" y="12" width="5" height="9" class="qp-f"/><path d="M3 21h29" class="qp-a"/>',
  ranking: '<rect x="4" y="4" width="26" height="4" class="qp-f"/><rect x="4" y="10" width="19" height="4" class="qp-f"/><rect x="4" y="16" width="12" height="4" class="qp-f"/><path d="M4 2v20" class="qp-a"/>',
  distribution: '<rect x="4" y="15" width="4" height="6" class="qp-f"/><rect x="9" y="9" width="4" height="12" class="qp-f"/><rect x="14" y="4" width="4" height="17" class="qp-f"/><rect x="19" y="8" width="4" height="13" class="qp-f"/><rect x="24" y="15" width="4" height="6" class="qp-f"/><path d="M3 21h29" class="qp-a"/>',
  relationship: '<circle cx="8" cy="17" r="1.8" class="qp-f"/><circle cx="12" cy="14" r="1.8" class="qp-f"/><circle cx="17" cy="13" r="1.8" class="qp-f"/><circle cx="21" cy="9" r="1.8" class="qp-f"/><circle cx="26" cy="6" r="1.8" class="qp-f"/><circle cx="15" cy="17" r="1.8" class="qp-f"/><path d="M4 21h28M4 21V2" class="qp-a"/>',
  part: '<circle cx="18" cy="12" r="8.5" class="qp-l" style="stroke-width:5"/><path d="M18 3.5a8.5 8.5 0 0 1 8.2 10.7" class="qp-l2" style="stroke-width:5"/>',
  composition: '<path d="M4 21V14l7-3 7 2 7-5 7 2v11z" class="qp-f"/><path d="M4 21v-3l7-2 7 1 7-3 7 1v6z" class="qp-f2"/>',
};
const TYPES = [['quantitative', 'Q', 'number'], ['temporal', 'T', 'date/time'], ['nominal', 'N', 'category'], ['ordinal', 'O', 'ordered category']];

// ---------------- sample data (only for the drawing) ----------------
function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const num = (v) => { const n = Number(String(v ?? '').trim().replace(/k$/i, 'e3')); return Number.isFinite(n) ? n : null; };
function niceTicks(lo, hi, want = 5) {
  if (!(hi > lo)) { hi = lo + 1; }
  const raw = (hi - lo) / want, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, out = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}
const short = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toPrecision(3)}G`;
  if (a >= 1e6) return `${+(v / 1e6).toPrecision(3)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toPrecision(3)}k`;
  return String(+Number(v).toPrecision(4));
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function tfmt(ms, f) {
  const d = new Date(ms);
  const p2 = (x) => String(x).padStart(2, '0');
  return String(f || '%b %Y').replace('%Y', d.getUTCFullYear()).replace('%b', MON[d.getUTCMonth()]).replace('%d', p2(d.getUTCDate()))
    .replace('%H', p2(d.getUTCHours())).replace('%M', p2(d.getUTCMinutes()));
}
function timeTicks(lo, hi, f) {
  const days = (hi - lo) / 864e5, out = [];
  if (f === '%H:%M' || days <= 2) { const st = 3 * 3600e3 * Math.max(1, Math.round(days)); for (let t = Math.ceil(lo / st) * st; t <= hi; t += st) out.push(t); return out; }
  const d = new Date(lo); d.setUTCHours(0, 0, 0, 0);
  const monthly = days > 90, yearly = days > 3 * 365;
  if (!monthly) { const st = Math.max(1, Math.round(days / 7)) * 864e5; for (let t = d.getTime(); t <= hi; t += st) if (t >= lo) out.push(t); return out; }
  d.setUTCDate(1);
  const every = yearly ? 12 * Math.max(1, Math.round(days / 365 / 6)) : Math.max(1, Math.round(days / 30 / 7));
  if (yearly) d.setUTCMonth(0);
  while (d.getTime() <= hi) { if (d.getTime() >= lo) out.push(d.getTime()); d.setUTCMonth(d.getUTCMonth() + every); }
  return out;
}

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const qStrip = el('div', { class: 'cs-q', role: 'radiogroup', 'aria-label': 'The question the chart answers' });
  for (const [k, name, title] of QUESTIONS) {
    const b = el('button', { class: 'cs-qb', role: 'radio', 'data-q': k, title }, `<svg viewBox="0 0 36 24" aria-hidden="true">${QPICT[k]}</svg><span>${name}</span>`);
    qStrip.append(b);
  }
  qStrip.addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) ctx.set('goal', b.dataset.q); });
  qStrip.addEventListener('keydown', (e) => {
    const b = e.target.closest('[data-q]'); if (!b) return;
    const i = QUESTIONS.findIndex((q) => q[0] === b.dataset.q);
    const j = /Right|Down/.test(e.key) ? i + 1 : /Left|Up/.test(e.key) ? i - 1 : null;
    if (j == null) return;
    e.preventDefault();
    const nk = QUESTIONS[(j + QUESTIONS.length) % QUESTIONS.length][0];
    ctx.set('goal', nk);
    requestAnimationFrame(() => qStrip.querySelector(`[data-q="${nk}"]`)?.focus());
  });

  // field tray
  const tray = el('section', { class: 'cs-card cs-tray' });
  const trayHead = el('div', { class: 'cs-head' }, '<h2>Fields</h2><span class="cs-dim">drag ⠿ to reorder: the first of each kind leads</span>');
  const cards = el('div', { class: 'cs-cards' });
  const addB = el('button', { class: 'cs-add' }, '+ Add field');
  const rowsBox = el('div', { class: 'cs-rows' });
  tray.append(trayHead, cards, addB, rowsBox);

  // the chart
  const stage = el('section', { class: 'cs-card cs-stage' });
  const titleIn = el('input', { class: 'cs-title', type: 'text', spellcheck: 'false', 'aria-label': 'Chart title', placeholder: 'Chart title' });
  titleIn.addEventListener('input', () => ctx.set('title', titleIn.value));
  const chartWhat = el('span', { class: 'cs-what' });
  const stageHead = el('div', { class: 'cs-shead' });
  stageHead.append(titleIn, chartWhat);
  const warnBar = el('div', { class: 'cs-warnbar', role: 'status' });
  const box = el('div', { class: 'cs-box' });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'cs-svg'); svg.setAttribute('role', 'img');
  box.append(svg);
  const foot = el('div', { class: 'cs-foot' }, '<span>Sample marks, shaped by the field ranges - the encodings, scales, bins and limits are the spec\'s. Numbered pins match the decisions.</span>');
  stage.append(stageHead, warnBar, box, foot);

  // decisions + code
  const side = el('section', { class: 'cs-card cs-dec' });
  const decHead = el('div', { class: 'cs-head' }, '<h2>Decisions</h2><span class="cs-dim">hover to find it on the chart</span>');
  const decList = el('ol', { class: 'cs-declist' });
  side.append(decHead, decList);

  const codeCol = el('div', { class: 'cs-code' });
  const libBar = el('div', { class: 'cs-lib' });
  const lib = el('div', { class: 'cs-seg', role: 'group', 'aria-label': 'Write it for' },
    '<button data-l="vegalite">Vega-Lite 5</button><button data-l="chartjs">Chart.js 4</button><button data-l="echarts">ECharts 5</button>');
  lib.addEventListener('click', (e) => { const l = e.target.closest('[data-l]')?.dataset.l; if (l) ctx.set('library', l); });
  const urlIn = el('input', { class: 'cs-url', type: 'text', spellcheck: 'false', placeholder: 'data URL (optional)', 'aria-label': 'Data URL' });
  urlIn.addEventListener('input', () => ctx.set('dataUrl', urlIn.value));
  libBar.append(el('span', { class: 'cs-dim' }, 'Write it for'), lib, urlIn);
  const notes = el('details', { class: 'cs-notes' });
  codeCol.append(libBar, ctx.outputs, notes);

  const grid = el('div', { class: 'cs' });
  grid.append(qStrip, tray, stage, side, codeCol);
  root.append(grid);

  // ---------------- fields ----------------
  const fieldsRaw = () => (Array.isArray(ctx.raw.fields) ? ctx.raw.fields.map((f) => ({ ...f })) : []);
  const setFields = (fs) => ctx.set('fields', fs);
  let dragF = null;
  function leadSet(spec) {
    // which fields the chart uses, and for what
    const used = new Map();
    if (!spec) return used;
    const e = spec.encoding;
    for (const [ch, x] of Object.entries(e)) {
      if (ch === 'fold') { for (const f of x) used.set(f, 'y'); continue; }
      if (x && typeof x === 'object' && x.field) used.set(x.field, used.has(x.field) ? used.get(x.field) : ch);
    }
    if (e.offset) used.set(e.offset, used.get(e.offset) || 'group');
    return used;
  }
  function drawCards() {
    const fs = fieldsRaw(), spec = ctx.result?.spec;
    const used = leadSet(spec);
    const foc = document.activeElement;
    const focKey = foc && cards.contains(foc) ? `${foc.closest('[data-i]')?.dataset.i}|${foc.dataset.k || ''}` : null;
    cards.innerHTML = fs.map((f, i) => {
      const t = TYPES.find((x) => x[0] === f.type) || TYPES[0];
      const use = used.get(String(f.name).trim());
      const q = f.type === 'quantitative' || f.type === 'temporal';
      return `<div class="cs-fc t-${t[1]}${use ? ' used' : ''}" data-i="${i}">
        <span class="cs-grip" data-k="grip" tabindex="0" role="button" aria-label="Move ${esc(f.name)}: arrow up or down" title="Drag to reorder">⠿</span>
        <button class="cs-type" data-k="type" title="${esc(t[2])} - click to change" aria-label="Type ${esc(f.type)}, click to change">${t[1]}</button>
        <input class="cs-fname" data-k="name" value="${esc(f.name)}" aria-label="Field name" spellcheck="false">
        ${use ? `<span class="cs-use">${esc(use === 'theta' ? 'angle' : use === 'color' ? 'colour' : use)}</span>` : '<span class="cs-use off">unused</span>'}
        <button class="cs-x" data-k="del" aria-label="Remove ${esc(f.name)}" title="Remove">×</button>
        <div class="cs-frange">${q
          ? `<input data-k="min" value="${esc(f.min ?? '')}" aria-label="${esc(f.name)} minimum" placeholder="min" spellcheck="false"><i></i><input data-k="max" value="${esc(f.max ?? '')}" aria-label="${esc(f.name)} maximum" placeholder="max" spellcheck="false">`
          : `<span class="cs-dots">${Array.from({ length: Math.min(12, Number(f.distinct) || 0) }, (_, k) => `<i style="--k:${k}"></i>`).join('')}${Number(f.distinct) > 12 ? '<em>…</em>' : ''}</span><input data-k="distinct" value="${esc(f.distinct ?? '')}" aria-label="${esc(f.name)} distinct values" placeholder="n" spellcheck="false"><span class="cs-dim">values</span>`}</div>
      </div>`;
    }).join('');
    if (focKey) {
      const [i, k] = focKey.split('|');
      const t = cards.querySelector(`[data-i="${i}"] [data-k="${k}"]`);
      if (t) { t.focus(); if (t.setSelectionRange && foc.selectionStart != null) { try { t.setSelectionRange(foc.selectionStart, foc.selectionEnd); } catch { /* */ } } }
    }
  }
  cards.addEventListener('input', (e) => {
    const k = e.target.dataset.k, i = +e.target.closest('[data-i]')?.dataset.i;
    if (!['name', 'min', 'max', 'distinct'].includes(k)) return;
    const fs = fieldsRaw(); fs[i][k] = e.target.value; setFields(fs);
  });
  cards.addEventListener('click', (e) => {
    const k = e.target.dataset.k, c = e.target.closest('[data-i]'); if (!c) return;
    const i = +c.dataset.i, fs = fieldsRaw();
    if (k === 'type') {
      const j = TYPES.findIndex((t) => t[0] === fs[i].type);
      fs[i].type = TYPES[(j + 1) % TYPES.length][0];
      if (fs[i].type === 'nominal' && !fs[i].distinct) fs[i].distinct = '5';
      setFields(fs);
      requestAnimationFrame(() => cards.querySelector(`[data-i="${i}"] [data-k="type"]`)?.focus());
    }
    if (k === 'del') { fs.splice(i, 1); setFields(fs); }
  });
  cards.addEventListener('keydown', (e) => {
    if (e.target.dataset.k !== 'grip' || !/^Arrow(Up|Down)$/.test(e.key)) return;
    e.preventDefault();
    const i = +e.target.closest('[data-i]').dataset.i, j = i + (e.key === 'ArrowUp' ? -1 : 1), fs = fieldsRaw();
    if (j < 0 || j >= fs.length) return;
    [fs[i], fs[j]] = [fs[j], fs[i]];
    setFields(fs);
    requestAnimationFrame(() => cards.querySelector(`[data-i="${j}"] [data-k="grip"]`)?.focus());
  });
  cards.addEventListener('pointerdown', (e) => {
    if (e.target.dataset.k !== 'grip') return;
    e.preventDefault();
    const c = e.target.closest('[data-i]');
    dragF = { i: +c.dataset.i, y0: e.clientY, el: c };
    c.classList.add('drag');
    cards.setPointerCapture(e.pointerId);
  });
  cards.addEventListener('pointermove', (e) => {
    if (!dragF) return;
    dragF.el.style.transform = `translateY(${e.clientY - dragF.y0}px)`;
  });
  const endF = (e) => {
    if (!dragF) return;
    const list = [...cards.querySelectorAll('.cs-fc')];
    const y = e.clientY;
    let to = list.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (to < 0) to = list.length;
    const from = dragF.i;
    dragF.el.classList.remove('drag'); dragF.el.style.transform = '';
    dragF = null;
    const fs = fieldsRaw();
    const [m] = fs.splice(from, 1);
    fs.splice(to > from ? to - 1 : to, 0, m);
    if (to !== from && to !== from + 1) setFields(fs);
  };
  cards.addEventListener('pointerup', endF);
  cards.addEventListener('pointercancel', endF);
  addB.addEventListener('click', () => {
    const fs = fieldsRaw();
    let n = fs.length + 1; while (fs.some((f) => f.name === `field${n}`)) n++;
    fs.push({ name: `field${n}`, type: 'quantitative', min: '0', max: '100', distinct: '' });
    setFields(fs);
    requestAnimationFrame(() => cards.querySelector(`[data-i="${fs.length - 1}"] [data-k="name"]`)?.select());
  });

  // row count scrubber
  let scrub = null;
  function drawRows() {
    const n = ctx.input.rows, agg = ctx.raw.aggregate;
    rowsBox.innerHTML = `<div class="cs-rl"><span class="cs-dim">Rows of data</span><span class="cs-scrub" tabindex="0" role="slider" aria-label="Rows of data; drag or arrow keys" aria-valuenow="${esc(n ?? '')}" title="Drag sideways to change">⟷ <b>${n != null ? esc(String(Math.round(n))) : '–'}</b></span></div>
      <div class="cs-rl"><span class="cs-dim">Aggregate</span><div class="cs-seg sm" role="group" aria-label="Aggregate">${['sum', 'mean', 'median', 'max', 'min', 'none'].map((a) => `<button data-a="${a}" aria-pressed="${a === agg}">${a}</button>`).join('')}</div></div>`;
  }
  rowsBox.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) ctx.set('aggregate', a); });
  rowsBox.addEventListener('pointerdown', (e) => {
    const s = e.target.closest('.cs-scrub'); if (!s) return;
    e.preventDefault(); s.focus();
    scrub = { x0: e.clientX, n0: Math.max(1, ctx.input.rows || 100) };
    rowsBox.setPointerCapture(e.pointerId);
  });
  rowsBox.addEventListener('pointermove', (e) => {
    if (!scrub) return;
    const n = Math.round(clamp(scrub.n0 * Math.exp((e.clientX - scrub.x0) / 60), 2, 1e7));
    ctx.set('rows', String(n > 1000 ? Math.round(n / 10) * 10 : n));
  });
  const endS = () => { if (scrub) { scrub = null; requestAnimationFrame(() => rowsBox.querySelector('.cs-scrub')?.focus()); } };
  rowsBox.addEventListener('pointerup', endS); rowsBox.addEventListener('pointercancel', endS);
  rowsBox.addEventListener('keydown', (e) => {
    if (!e.target.closest('.cs-scrub')) return;
    const d = /Right|Up/.test(e.key) ? 1 : /Left|Down/.test(e.key) ? -1 : 0; if (!d) return;
    e.preventDefault();
    const n = Math.max(1, ctx.input.rows || 100), f = e.shiftKey ? 2 : 1.1;
    ctx.set('rows', String(Math.max(2, Math.round(d > 0 ? n * f : n / f))));
    requestAnimationFrame(() => rowsBox.querySelector('.cs-scrub')?.focus());
  });

  // ---------------- the chart ----------------
  let pins = [];  // [{n, x, y}]
  let hot = null; // hovered decision
  const aggCycle = ['sum', 'mean', 'median', 'max', 'min', 'none'];

  function drawChart() {
    const res = ctx.result || {}, spec = res.spec, inp = ctx.input;
    const W = Math.max(300, box.clientWidth), H = Math.max(260, box.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    pins = [];
    if (!spec) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="cs-empty">${esc(res.warnings?.[0] || 'Add fields to see a chart.')}</text>`;
      chartWhat.textContent = '';
      svg.setAttribute('aria-label', 'No chart');
      return;
    }
    const E = spec.encoding, S = spec.scales, mark = spec.mark;
    const F = Object.fromEntries((inp.fields || []).map((f) => [String(f.name).trim(), f]));
    const R = rng(JSON.stringify(inp.fields) + mark);
    const n = inp.rows > 0 ? inp.rows : 100;
    const narrow = W < 520;
    const legendW = (E.color || E.fold) && mark !== 'arc' && !narrow ? 130 : 0;
    const P = { l: narrow ? 46 : 64, t: 26, r: W - 16 - legendW, b: H - (narrow ? 40 : 46) };
    if (spec.horizontal) P.l = narrow ? 76 : 110;
    const o = [];
    const decisions = res.tables?.[0]?.rows || [];
    const pinFor = (re) => decisions.findIndex((r) => re.test(r[0])) + 1;
    let topX = P.l + 14;
    const topPin = (re) => { const k = pinFor(re); if (k > 0 && !pins.some((p) => p.n === k)) { pins.push({ n: k, x: topX, y: P.t - 13 }); topX += 22; } };
    const addPin = (re, x, y) => { const k = pinFor(re); if (k > 0 && !pins.some((p) => p.n === k)) pins.push({ n: k, x, y }); };
    const range = (f, lo = 0, hi = 100) => {
      if (!f) return [lo, hi];
      if (f.type === 'temporal') { const a = Date.parse(f.min), b = Date.parse(f.max); return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : [Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31)]; }
      const a = num(f.min), b = num(f.max);
      return a != null && b != null && b > a ? [a, b] : a != null && b == null ? [a, a * 2 + 10] : [lo, hi];
    };
    const catCount = (fname, dflt = 5) => { const d = num(F[fname]?.distinct); return d > 0 ? Math.round(d) : dflt; };
    const catLabels = (fname, k) => Array.from({ length: k }, (_, i) => `${fname} ${i + 1}`);
    const colourK = E.fold ? E.fold.length : E.color ? catCount(E.color.field, 3) : 1;
    const series = Math.min(colourK, 10);
    const colOf = (i) => `cs-c${i % 10}`;
    const aggWord = (x) => (x?.agg && x.agg !== 'count' && x.field ? `${x.agg} of ${x.field}` : x?.agg === 'count' ? 'count of rows' : x?.field || '');

    // ---- value axis helper ----
    const valueAxis = (axis, dom, sc, label, fieldName) => {
      // axis: 'y' (vertical) or 'x' (horizontal value axis)
      const log = sc?.type === 'log';
      let [lo, hi] = dom;
      if (log) { lo = 10 ** Math.floor(Math.log10(Math.max(lo, 1e-9))); hi = 10 ** Math.ceil(Math.log10(hi)); }
      else if (sc?.zero !== false) lo = Math.min(0, lo);
      const ticks = log ? (() => { const t = []; for (let v = lo; v <= hi * 1.0001; v *= 10) t.push(v); return t; })() : niceTicks(lo, hi, axis === 'y' ? 5 : narrow ? 3 : 6);
      if (!log) { lo = ticks[0]; hi = ticks[ticks.length - 1]; }
      const f = (v) => (log ? (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (v - lo) / (hi - lo));
      const map = axis === 'y' ? (v) => P.b - f(v) * (P.b - P.t) : (v) => P.l + f(v) * (P.r - P.l);
      for (const t of ticks) {
        const p = map(t);
        if (axis === 'y') o.push(`<line class="gr${t === 0 ? ' z' : ''}" x1="${P.l}" x2="${P.r}" y1="${p}" y2="${p}"/><text class="tk" x="${P.l - 7}" y="${p + 3.5}" text-anchor="end">${short(t)}</text>`);
        else o.push(`<line class="gr${t === 0 ? ' z' : ''}" y1="${P.t}" y2="${P.b}" x1="${p}" x2="${p}"/><text class="tk" x="${p}" y="${P.b + 15}" text-anchor="middle">${short(t)}</text>`);
      }
      // the baseline decision, drawn: a heavy zero line, a fitted-axis break, or the log label
      if (!log && sc?.zero && lo === 0) {
        if (axis === 'y') o.push(`<line class="zero" x1="${P.l}" x2="${P.r}" y1="${map(0)}" y2="${map(0)}"/>`);
        else o.push(`<line class="zero" y1="${P.t}" y2="${P.b}" x1="${map(0)}" x2="${map(0)}"/>`);
      } else if (!log && lo > 0) {
        if (axis === 'y') o.push(`<path class="brk" d="M${P.l - 5} ${P.b - 4}l10 -4M${P.l - 5} ${P.b + 1}l10 -4"/>`);
        else o.push(`<path class="brk" d="M${P.l - 2} ${P.b + 5}l4 -10M${P.l + 3} ${P.b + 5}l4 -10"/>`);
      }
      if (log) o.push(axis === 'y' ? `<text class="axn log" x="${P.l + 6}" y="${P.t + 12}">log</text>` : `<text class="axn log" x="${P.r - 4}" y="${P.b - 6}" text-anchor="end">log</text>`);
      // axis title: the aggregate, clickable
      const tt = label || '';
      if (axis === 'y') o.push(`<g class="axt" tabindex="0" role="button" data-agg="1" aria-label="Value axis: ${esc(tt)}. Click to change the aggregate"><text x="${P.l - 8}" y="${P.t - 10}" text-anchor="start">${esc(tt)}${fieldName ? ' ▾' : ''}</text></g>`);
      else o.push(`<g class="axt" tabindex="0" role="button" data-agg="1" aria-label="Value axis: ${esc(tt)}. Click to change the aggregate"><text x="${P.r}" y="${P.b + 32}" text-anchor="end">${esc(tt)}${fieldName ? ' ▾' : ''}</text></g>`);
      // the scale's pin sits on the baseline it decided
      const ypin = axis === 'y' ? [P.l + 14, map(lo) - 12] : [(P.l + P.r) / 2, P.b + 28];
      if (axis === 'y') topX = Math.max(topX, P.l - 8 + (tt.length + 2) * 6.8 + 14);
      addPin(new RegExp(`^${axis} scale`), ...ypin);
      return map;
    };
    const timeAxis = (dom, fmt) => {
      const [lo, hi] = dom;
      const map = (t) => P.l + ((t - lo) / (hi - lo)) * (P.r - P.l);
      let ticks = timeTicks(lo, hi, fmt);
      const maxT = Math.floor((P.r - P.l) / (narrow ? 64 : 76));
      if (ticks.length > maxT) { const k = Math.ceil(ticks.length / maxT); ticks = ticks.filter((_, i) => i % k === 0); }
      for (const t of ticks) o.push(`<line class="tkl" x1="${map(t)}" x2="${map(t)}" y1="${P.b}" y2="${P.b + 4}"/><text class="tk" x="${map(t)}" y="${P.b + 16}" text-anchor="middle">${esc(tfmt(t, fmt))}</text>`);
      o.push(`<line class="ax" x1="${P.l}" x2="${P.r}" y1="${P.b}" y2="${P.b}"/>`);
      addPin(/^x scale/, (P.l + P.r) / 2, P.b + 30);
      return map;
    };
    const legend = (names) => {
      if (!names.length) return;
      if (narrow) {
        const shown = names.slice(0, 5), stp = (W - 12 - P.l + 30) / shown.length, chars = Math.max(3, Math.floor((stp - 16) / 6.6));
        shown.forEach((nm, i) => { const x = P.l - 30 + i * stp; o.push(`<rect class="${colOf(i)}" x="${x}" y="${H - 14}" width="9" height="9" rx="2"/><text class="lg" x="${x + 12}" y="${H - 6}">${esc(nm.length > chars ? nm.slice(0, chars - 1) + '…' : nm)}</text>`); });
        return;
      }
      const x0 = P.r + 22;
      o.push(`<text class="lgt" x="${x0}" y="${P.t + 4}">${esc(E.fold ? 'measure' : E.color.field)}</text>`);
      const show = names.slice(0, 10);
      show.forEach((nm, i) => o.push(`<rect class="${colOf(i)}" x="${x0}" y="${P.t + 14 + i * 17}" width="10" height="10" rx="2"/><text class="lg" x="${x0 + 15}" y="${P.t + 23 + i * 17}">${esc(nm.length > 14 ? nm.slice(0, 13) + '…' : nm)}</text>`));
      if (names.length > 10) o.push(`<text class="lg bad" x="${x0}" y="${P.t + 30 + 10 * 17}">+${names.length - 10} more</text>`);
      if (colourK > 10) o.push(`<rect class="warnbox" x="${x0 - 6}" y="${P.t - 10}" width="${legendW - 8}" height="${Math.min(11, names.length) * 17 + 28}" rx="4"/><text class="wtx" x="${x0}" y="${P.t + 50 + 10 * 17}">${colourK} colours:</text><text class="wtx" x="${x0}" y="${P.t + 64 + 10 * 17}">can't tell apart</text>`);
      addPin(/^Colour|^Series/, x0 - 12, P.t);
    };

    // ---- marks ----
    const svgLabel = [];
    if (mark === 'line' || mark === 'line+point' || mark === 'area') {
      const tf = F[E.x.field], tdom = range(tf);
      const qFields = E.fold ? E.fold : [E.y.field];
      const k = E.fold ? E.fold.length : series;
      const m = clamp(Math.round(mark === 'line+point' ? n : Math.min(n / Math.max(1, k), 80)), 2, 80);
      const data = Array.from({ length: k }, (_, s) => {
        const [lo, hi] = range(F[qFields[E.fold ? s : 0]]);
        const amp = E.fold ? 1 : 1 / Math.max(1, k) * (1 + R());
        let v = lo + (hi - lo) * (0.35 + 0.3 * R());
        return Array.from({ length: m }, (_, i) => {
          v += (hi - lo) * (R() - 0.47) * 0.12;
          v = clamp(v, lo, hi);
          return { t: tdom[0] + (i / (m - 1)) * (tdom[1] - tdom[0]), v: mark === 'area' ? v * amp : v };
        });
      });
      let vlo = Infinity, vhi = -Infinity;
      if (mark === 'area') { for (let i = 0; i < m; i++) { const sum = data.reduce((a, d) => a + d[i].v, 0); vhi = Math.max(vhi, sum); } vlo = 0; } else for (const d of data) for (const p of d) { vlo = Math.min(vlo, p.v); vhi = Math.max(vhi, p.v); }
      const Y = valueAxis('y', [vlo, vhi], S.y, E.fold ? 'value' : aggWord(E.y), E.y?.field);
      const X = timeAxis(tdom, S.x?.format);
      if (mark === 'area') {
        const base = new Array(m).fill(0);
        data.forEach((d, s) => {
          const top = d.map((p, i) => base[i] + p.v);
          const pth = `M${d.map((p, i) => `${X(p.t).toFixed(1)},${Y(top[i]).toFixed(1)}`).join('L')}L${[...d].reverse().map((p, ri) => { const i = m - 1 - ri; return `${X(p.t).toFixed(1)},${Y(base[i]).toFixed(1)}`; }).join('L')}Z`;
          o.push(`<path class="${colOf(s)} ar" d="${pth}"/>`);
          top.forEach((v, i) => { base[i] = v; });
        });
      } else {
        data.forEach((d, s) => {
          o.push(`<path class="${colOf(s)} ln" d="M${d.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('L')}"/>`);
          if (mark === 'line+point') for (const p of d) o.push(`<circle class="${colOf(s)} pt" cx="${X(p.t)}" cy="${Y(p.v)}" r="3.5"/>`);
        });
        if (mark === 'line+point') addPin(/^Points/, X(data[0][Math.floor(m / 2)].t), Y(data[0][Math.floor(m / 2)].v) - 16);
      }
      if (n > 2000) addPin(/^Data/, P.r - 30, P.t + 30);
      legend(E.fold ? E.fold : E.color ? catLabels(E.color.field, colourK) : []);
      svgLabel.push(`${mark} of ${qFields.join(', ')} over ${E.x.field}`);
    } else if (mark === 'bar' && !(E.x && E.x.bin)) {
      const hor = spec.horizontal;
      const catE = hor ? E.y : E.x, valE = hor ? E.x : E.y;
      const kAll = catCount(catE.field, 5);
      const limit = E.top || kAll;
      const kDraw = Math.min(kAll, limit, 30);
      const normalize = valE.stack === 'normalize';
      const [lo, hi] = valE.field ? range(F[valE.field]) : [1, Math.max(5, n / kAll * 2)];
      const labs = catLabels(catE.field, kDraw);
      let vals = labs.map(() => lo + (hi - lo) * (0.15 + 0.85 * R()));
      if (catE.sort === '-value') vals.sort((a, b) => b - a);
      const groups = E.offset ? Math.min(catCount(E.offset, 3), 6) : 1;
      const segs = normalize ? (E.color ? Math.min(catCount(E.color.field, 3), 10) : 1) : 1;
      let vmax = Math.max(...vals);
      if (normalize) vmax = 1;
      const V = valueAxis(hor ? 'x' : 'y', [normalize ? 0 : Math.min(...vals), vmax], hor ? S.x : S.y, normalize ? `share of ${valE.field || 'rows'}` : aggWord(valE), valE.field);
      const band = ((hor ? P.b - P.t : P.r - P.l) / kDraw);
      const bw = band * 0.72;
      const onePart = normalize && E.color && E.color.field === catE.field;
      labs.forEach((lab, i) => {
        const c0 = (hor ? P.t : P.l) + band * i + (band - bw) / 2;
        for (let g = 0; g < groups; g++) {
          const gw = bw / groups, cs = c0 + g * gw;
          const v = groups > 1 ? vals[i] * (0.5 + 0.5 * R()) : vals[i];
          if (normalize) {
            // 100 % stack: parts of each bar (or one bar split by the category itself)
            const parts = onePart ? [1] : Array.from({ length: segs }, () => 0.3 + R());
            const tot = parts.reduce((a, b) => a + b, 0);
            let acc = 0;
            parts.forEach((pv, s) => {
              const a = V(acc / tot), b = V((acc + pv) / tot);
              const cls = colOf(onePart ? i : s);
              o.push(hor ? `<rect class="${cls} br" x="${a}" y="${cs}" width="${Math.max(0, b - a)}" height="${gw - 1}"/>` : `<rect class="${cls} br" x="${cs}" y="${b}" width="${gw - 1}" height="${Math.max(0, a - b)}"/>`);
              acc += pv;
            });
          } else {
            const a = V(Math.max(0, Math.min(0, v)) || (S[hor ? 'x' : 'y']?.zero ? 0 : Math.min(...vals))), b = V(v);
            const cls = groups > 1 ? colOf(g) : 'cs-c0';
            o.push(hor ? `<rect class="${cls} br" x="${Math.min(a, b)}" y="${cs}" width="${Math.abs(b - a)}" height="${gw - 1}"/>` : `<rect class="${cls} br" x="${cs}" y="${Math.min(a, b)}" width="${gw - 1}" height="${Math.abs(a - b)}"/>`);
          }
        }
        const every = Math.ceil(kDraw / Math.max(1, Math.floor((hor ? P.b - P.t : P.r - P.l) / (hor ? 14 : 58))));
        if (i % every === 0) {
          const t = lab.length > (hor ? 14 : 10) ? lab.slice(0, hor ? 13 : 9) + '…' : lab;
          o.push(hor ? `<text class="tk cat" x="${P.l - 7}" y="${c0 + bw / 2 + 3.5}" text-anchor="end">${esc(t)}</text>` : `<text class="tk cat" x="${c0 + bw / 2}" y="${P.b + 15}" text-anchor="middle">${esc(t)}</text>`);
        }
      });
      o.push(hor ? `<line class="ax" x1="${P.l}" x2="${P.l}" y1="${P.t}" y2="${P.b}"/>` : `<line class="ax" x1="${P.l}" x2="${P.r}" y1="${P.b}" y2="${P.b}"/>`);
      o.push(hor ? `<text class="axn" x="${P.l - 7}" y="${P.t - 10}" text-anchor="end">${esc(catE.field)}</text>` : `<text class="axn" x="${P.l}" y="${P.b + 32}">${esc(catE.field)}</text>`);
      if (catE.sort === '-value') {
        const ax = hor ? P.l - 96 : P.l + 10, ay = hor ? P.t + 10 : P.b + 28;
        o.push(hor ? `<path class="sortar" d="M${P.r + 7} ${P.t}V${P.t + 40}m-4 -6l4 6 4 -6"/><text class="sortt" x="${P.r}" y="${P.t - 10}" text-anchor="end">largest first</text>`
          : `<path class="sortar" d="M${P.l + 14} ${P.t + 4}H${P.l + 60}m-6 -4l6 4 -6 4"/><text class="sortt" x="${P.l + 66}" y="${P.t + 8}">largest first</text>`);
        addPin(/^Order/, hor ? P.r - 96 : P.l + 8, hor ? P.t - 13 : P.t + 4);
        void ax; void ay;
      } else addPin(/^Order/, hor ? P.l - 20 : P.l + 20, hor ? P.t + 8 : P.b + 26);
      if (E.top && kAll > E.top) {
        o.push(`<text class="lim" x="${hor ? P.l + 14 : P.r - 4}" y="${hor ? P.b + 34 : P.t + 8}" text-anchor="${hor ? 'start' : 'end'}">top ${E.top} of ${kAll} · ${kAll - E.top} filtered out</text>`);
        addPin(/^Limit/, hor ? P.l + 2 : P.r - 190, hor ? P.b + 30 : P.t + 4);
      } else if (kAll > kDraw) o.push(`<text class="lim" x="${P.r}" y="${P.t - 10}" text-anchor="end">first ${kDraw} of ${kAll} drawn</text>`);
      if (E.color && !onePart) legend(catLabels(E.color.field, colourK));
      else if (onePart) legend(labs);
      svgLabel.push(`${hor ? 'horizontal ' : ''}bar chart of ${aggWord(valE)} by ${catE.field}`);
    } else if (mark === 'bar' && E.x?.bin) {
      const bins = E.x.bin, [lo, hi] = range(F[E.x.field]);
      const w = (hi - lo) / bins;
      const counts = Array.from({ length: bins }, (_, i) => { const z = ((i + 0.5) / bins - 0.45) * 3.2; return Math.max(0, Math.round((n / bins) * 2.2 * Math.exp(-z * z / 2) * (0.8 + 0.4 * R()))); });
      const Y = valueAxis('y', [0, Math.max(...counts, 1)], { type: 'linear', zero: true }, 'count of rows', null);
      const X = (v) => P.l + ((v - lo) / (hi - lo)) * (P.r - P.l);
      counts.forEach((c, i) => o.push(`<rect class="cs-c0 br" x="${X(lo + i * w) + 0.5}" y="${Y(c)}" width="${Math.max(1, X(lo + (i + 1) * w) - X(lo + i * w) - 1)}" height="${Y(0) - Y(c)}"/>`));
      for (const t of niceTicks(lo, hi, narrow ? 4 : 7)) if (t >= lo && t <= hi) o.push(`<line class="tkl" x1="${X(t)}" x2="${X(t)}" y1="${P.b}" y2="${P.b + 4}"/><text class="tk" x="${X(t)}" y="${P.b + 16}" text-anchor="middle">${short(t)}</text>`);
      o.push(`<line class="ax" x1="${P.l}" x2="${P.r}" y1="${P.b}" y2="${P.b}"/><text class="axn" x="${P.r}" y="${P.b + 32}" text-anchor="end">${esc(E.x.field)} · ${bins} bins of ${short(w)}</text>`);
      o.push(`<path class="binm" d="M${X(lo)} ${P.b + 22}V${P.b + 26}H${X(lo + w)}V${P.b + 22}"/>`);
      addPin(/^Chart/, X(lo + w * bins * 0.5), Y(Math.max(...counts)) - 14);
      svgLabel.push(`histogram of ${E.x.field} in ${bins} bins`);
    } else if (mark === 'boxplot') {
      const k = Math.min(catCount(E.x.field, 4), 8), [lo, hi] = range(F[E.y.field]);
      const Y = valueAxis('y', [lo, hi], S.y, E.y.field, null);
      const band = (P.r - P.l) / k;
      for (let i = 0; i < k; i++) {
        const c = P.l + band * (i + 0.5), med = lo + (hi - lo) * (0.35 + 0.3 * R()), iqr = (hi - lo) * (0.1 + 0.12 * R());
        const q1 = med - iqr * (0.4 + 0.2 * R()), q3 = q1 + iqr, w1 = Math.max(lo, q1 - 1.5 * iqr * 0.7), w3 = Math.min(hi, q3 + 1.5 * iqr * 0.7);
        const bw = Math.min(60, band * 0.5);
        o.push(`<path class="whisk" d="M${c} ${Y(w1)}V${Y(q1)}M${c} ${Y(q3)}V${Y(w3)}M${c - bw / 4} ${Y(w1)}h${bw / 2}M${c - bw / 4} ${Y(w3)}h${bw / 2}"/><rect class="${colOf(i)} bx" x="${c - bw / 2}" y="${Y(q3)}" width="${bw}" height="${Y(q1) - Y(q3)}"/><path class="med" d="M${c - bw / 2} ${Y(med)}h${bw}"/><text class="tk" x="${c}" y="${P.b + 15}" text-anchor="middle">${esc(`${E.x.field} ${i + 1}`)}</text>`);
      }
      o.push(`<line class="ax" x1="${P.l}" x2="${P.r}" y1="${P.b}" y2="${P.b}"/>`);
      addPin(/^Chart/, P.l + band * 0.5 + 34, P.t + 8);
      svgLabel.push(`box plots of ${E.y.field} by ${E.x.field}`);
    } else if (mark === 'point') {
      const [xl, xh] = range(F[E.x.field]), [yl, yh] = range(F[E.y.field]);
      const m = Math.min(n, 400);
      const logX = S.x?.type === 'log', logY = S.y?.type === 'log';
      const draw = (l, h, log, r) => (log ? Math.exp(Math.log(Math.max(l, 1e-9)) + (Math.log(h) - Math.log(Math.max(l, 1e-9))) * r) : l + (h - l) * r);
      const X = valueAxis('x', [xl, xh], S.x, E.x.field, null);
      const Y = valueAxis('y', [yl, yh], S.y, E.y.field, null);
      const gk = E.color ? Math.min(catCount(E.color.field, 3), 10) : 1;
      const op = E.opacity || 0.75;
      for (let i = 0; i < m; i++) {
        const a = R(), b = clamp(a * 0.8 + 0.1 + (R() - 0.5) * 0.35, 0, 1);
        const g = Math.floor(R() * gk), sz = E.size ? 2 + R() * 9 : 3.2;
        o.push(`<circle class="${colOf(g)} pt" cx="${X(draw(xl, xh, logX, a)).toFixed(1)}" cy="${Y(draw(yl, yh, logY, b)).toFixed(1)}" r="${sz.toFixed(1)}" style="fill-opacity:${op};stroke-opacity:${op}"/>`);
      }
      if (E.opacity) addPin(/^Overplotting/, P.r - 40, P.t + 30);
      if (E.color) legend(catLabels(E.color.field, colourK));
      if (E.size) o.push(`<text class="lim" x="${P.r}" y="${P.t - 10}" text-anchor="end">size: ${esc(E.size.field)}</text>`);
      svgLabel.push(`scatter of ${E.y.field} against ${E.x.field}`);
    } else if (mark === 'arc') {
      const k = Math.min(catCount(E.color.field, 4), 10);
      const cx = (P.l + P.r) / 2 - (narrow ? 0 : 60), cy = (P.t + P.b) / 2 + 6, r = Math.min(P.r - P.l, P.b - P.t) / 2 - 10, ri = r * 0.55;
      const parts = Array.from({ length: k }, () => 0.4 + R()).sort((a, b) => b - a), tot = parts.reduce((a, b) => a + b, 0);
      let a0 = -Math.PI / 2;
      parts.forEach((p, i) => {
        const a1 = a0 + (p / tot) * 2 * Math.PI, big = a1 - a0 > Math.PI ? 1 : 0;
        const pt = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`;
        o.push(`<path class="${colOf(i)} arc" d="M${pt(r, a0)}A${r} ${r} 0 ${big} 1 ${pt(r, a1)}L${pt(ri, a1)}A${ri} ${ri} 0 ${big} 0 ${pt(ri, a0)}Z"/>`);
        const am = (a0 + a1) / 2;
        o.push(`<text class="tk" x="${cx + (r + 14) * Math.cos(am)}" y="${cy + (r + 14) * Math.sin(am) + 4}" text-anchor="${Math.cos(am) > 0.2 ? 'start' : Math.cos(am) < -0.2 ? 'end' : 'middle'}">${Math.round((p / tot) * 100)} %</text>`);
        a0 = a1;
      });
      o.push(`<text class="axn" x="${cx}" y="${cy + 4}" text-anchor="middle">${esc(aggWord(E.theta) || 'count')}</text>`);
      const x0 = narrow ? P.l : cx + r + 60;
      if (!narrow) catLabels(E.color.field, k).forEach((nm, i) => o.push(`<rect class="${colOf(i)}" x="${x0}" y="${P.t + 20 + i * 18}" width="10" height="10" rx="2"/><text class="lg" x="${x0 + 15}" y="${P.t + 29 + i * 18}">${esc(nm)}</text>`));
      addPin(/^Chart/, cx + r * 0.75, cy - r * 0.9);
      svgLabel.push(`donut of ${E.color.field}`);
    }
    // pins for the rest
    if (spec.horizontal) topX = Math.max(topX, P.l + 10);
    addPin(/^Colour/, P.r - 10, P.t + 10);
    addPin(/^Negative/, P.l + 20, P.b - 20);
    topPin(/^Question/); topPin(/^Chart/); topPin(/^Value/);
    decisions.forEach((r, k) => { if (!pins.some((p) => p.n === k + 1)) { pins.push({ n: k + 1, x: topX, y: P.t - 13 }); topX += 22; } });
    for (const p of pins) o.push(`<g class="pin${hot === p.n ? ' hot' : ''}" data-pin="${p.n}"><circle cx="${clamp(p.x, 10, W - 10)}" cy="${clamp(p.y, 10, H - 10)}" r="8.5"/><text x="${clamp(p.x, 10, W - 10)}" y="${clamp(p.y, 10, H - 10) + 3.5}" text-anchor="middle">${p.n}</text></g>`);
    svg.innerHTML = o.join('');
    svg.setAttribute('aria-label', `Sample ${svgLabel.join(', ')}`);
    const vals = res.values || [];
    chartWhat.innerHTML = vals.map((v) => `<span><em>${esc(v.label)}</em> ${esc(v.value)}${v.hint ? ` <small>${esc(v.hint)}</small>` : ''}</span>`).join('');
  }
  svg.addEventListener('click', (e) => {
    if (!e.target.closest('[data-agg]')) return;
    const a = ctx.raw.aggregate || 'sum', j = aggCycle.indexOf(a);
    ctx.set('aggregate', aggCycle[(j + 1) % aggCycle.length]);
  });
  svg.addEventListener('keydown', (e) => {
    if (!e.target.closest('[data-agg]') || !(e.key === 'Enter' || e.key === ' ')) return;
    e.preventDefault();
    const a = ctx.raw.aggregate || 'sum', j = aggCycle.indexOf(a);
    ctx.set('aggregate', aggCycle[(j + 1) % aggCycle.length]);
    requestAnimationFrame(() => svg.querySelector('[data-agg]')?.focus());
  });
  svg.addEventListener('pointerover', (e) => { const p = e.target.closest('[data-pin]'); setHot(p ? +p.dataset.pin : null); });

  function setHot(n) {
    if (hot === n) return;
    hot = n;
    for (const g of svg.querySelectorAll('[data-pin]')) g.classList.toggle('hot', +g.dataset.pin === n);
    for (const li of decList.querySelectorAll('[data-d]')) li.classList.toggle('hot', +li.dataset.d === n);
  }

  function drawDecisions() {
    const res = ctx.result || {};
    const rows = res.tables?.[0]?.rows || [];
    decList.innerHTML = rows.map((r, k) => `<li data-d="${k + 1}" tabindex="0"><i>${k + 1}</i><div><b>${esc(r[0])}</b> <span class="ch">${esc(r[1])}</span><div class="why">${esc(r[2])}</div></div></li>`).join('');
    const ws = res.warnings || [];
    warnBar.innerHTML = ws.map((w) => `<div>${esc(w)}</div>`).join('');
    notes.innerHTML = `<summary>Notes (${(res.notes || []).length})</summary>${(res.notes || []).map((x) => `<div>${esc(x)}</div>`).join('')}`;
  }
  decList.addEventListener('pointerover', (e) => { const li = e.target.closest('[data-d]'); setHot(li ? +li.dataset.d : null); });
  decList.addEventListener('focusin', (e) => { const li = e.target.closest('[data-d]'); setHot(li ? +li.dataset.d : null); });
  decList.addEventListener('pointerleave', () => setHot(null));

  function drawChrome() {
    const inp = ctx.input, raw = ctx.raw;
    for (const b of qStrip.querySelectorAll('[data-q]')) b.setAttribute('aria-checked', String(b.dataset.q === (raw.goal || 'auto')));
    // under Decide, show which question it picked
    const picked = (ctx.result?.tables?.[0]?.rows || []).find((r) => r[0] === 'Question')?.[1];
    for (const b of qStrip.querySelectorAll('[data-q]')) b.classList.toggle('picked', raw.goal === 'auto' && QUESTIONS.find((q) => q[0] === b.dataset.q)?.[2].startsWith(picked || '§'));
    for (const b of lib.querySelectorAll('[data-l]')) b.setAttribute('aria-pressed', String(b.dataset.l === inp.library));
    if (document.activeElement !== titleIn) titleIn.value = raw.title ?? '';
    if (document.activeElement !== urlIn) urlIn.value = raw.dataUrl ?? '';
  }

  ctx.onResult(() => {
    drawChrome();
    if (!dragF) drawCards();
    drawRows();
    drawDecisions();
    drawChart();
  });
  new ResizeObserver(() => drawChart()).observe(box);
}
