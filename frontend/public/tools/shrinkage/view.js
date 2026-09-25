// Shrinkage Compensator: the page is a patternmaker's contraction rule.
//   Shrinkage - every material's linear shrinkage range as a bar on a log %
//               axis, grouped by process; click one to use it, or drag the
//               marker to set your own value. With a test piece, the piece in
//               a caliper instead: drag the jaw to what you measured.
//   Rule      - the shrink rule on top (its millimetres stretched by
//               1 / (1 - s)), the ordinary rule below, and between them each
//               part dimension as a bar: the part, the size to make it (the
//               extra drawn at the end), and where the part may land across
//               the material's range. Drag a bar's end to change the size,
//               edit the names, add and remove dimensions. The extra and the
//               drift of the rule can be drawn x10 so they can be seen.
// Every number drawn comes from run()'s result.rule.

const NS = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function sv(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const num = (v, p = 4) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(p))));
const mm3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Math.round(v * 1000) / 1000));
const niceStep = (span, n) => {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};
const SMIN = 0.1, SMAX = 20; // % axis
const GROUPS = ['Injection moulding', 'Casting', 'FDM print', 'Ceramics'];
const VKEY = 'redline.tool.shrinkage.view';
const loadView = () => { try { return { ex: 10, ...(JSON.parse(localStorage.getItem(VKEY) || '{}')) }; } catch { return { ex: 10 }; } };
const saveView = (v) => { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* private window */ } };

export function page(root, ctx) {
  const ver = location.search.match(/[?&]v=(\w+)/) ? `?v=${RegExp.$1}` : '';
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href + ver }));
  const view = loadView();
  let R = null, res = null, refocus = null;

  const numField = (key, label, unit, aria) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria || label, oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'sk-num' }, label ? h('span', {}, label) : null, inp, unit ? h('small', {}, unit) : null);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };

  // ---------- top: source and the scale ----------
  const MODES = [['material', 'Material range'], ['custom', 'Known value'], ['measured', 'Test piece']];
  const modeSeg = h('div', { class: 'sk-seg', role: 'radiogroup', 'aria-label': 'Shrinkage from' },
    MODES.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set('mode', v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const n = MODES[clamp(MODES.findIndex((m) => m[0] === v) + d, 0, 2)][0];
        ctx.set('mode', n); requestAnimationFrame(() => modeSeg.querySelector(`[data-v="${n}"]`)?.focus());
      } }, t)));
  const fShrink = numField('shrink', 'Shrinkage', '%');
  const fDesign = numField('design', 'Designed', 'mm', 'Test piece as designed, mm');
  const fMeas = numField('measured', 'Measured', 'mm', 'Test piece as measured, mm');
  const modeFields = h('div', { class: 'sk-mfields' }, fShrink, fDesign, fMeas);
  const readout = h('div', { class: 'sk-read', 'aria-live': 'polite' });
  const top = h('div', { class: 'sk-top' }, h('span', { class: 'sk-cap' }, 'Shrinkage from'), modeSeg, modeFields, readout);

  // ---------- shrinkage chart / test piece ----------
  const chartSvg = sv(null, 'svg', { class: 'sk-chart-svg', role: 'group', 'aria-label': 'Shrinkage ranges by material on a log axis; drag the marker to set a value' });
  const chartHead = h('div', { class: 'sk-head' }, h('span', { class: 'sk-cap' }, 'Linear shrinkage, %'), h('span', { class: 'sk-hint' }, 'click a material, or drag the marker to set your own value'));
  chartSvg.setAttribute('role', 'radiogroup');
  const chart = h('section', { class: 'sk-panel sk-chart' }, chartHead, h('div', { class: 'sk-svgwrap sk-chart-wrap' }, chartSvg));

  // ---------- the rule ----------
  const exSeg = h('div', { class: 'sk-seg', role: 'radiogroup', 'aria-label': 'Drawing of the extra' },
    [[1, 'true scale'], [10, 'extra ×10']].map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-e': v,
      onclick: () => { view.ex = v; saveView(view); drawRule(); syncEx(); } }, t)));
  const syncEx = () => exSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.e) === view.ex)));
  const topRule = sv(null, 'svg', { class: 'sk-ruler', 'aria-hidden': 'true' });
  const botRule = sv(null, 'svg', { class: 'sk-ruler', 'aria-hidden': 'true' });
  const lanes = h('div', { class: 'sk-lanes' });
  const shrinkSub = h('small', {}, 'shrink rule');
  const shrinkLab = h('div', { class: 'sk-rlab' }, 'Make it', shrinkSub);
  const addBtn = h('button', { type: 'button', class: 'sk-addrow', onclick: () => {
    const d = [...(ctx.raw.dims || []).map((r) => ({ ...r }))];
    d.push({ name: `Dimension ${d.length + 1}`, size: '' });
    focusNew = d.length - 1;
    ctx.set('dims', d);
  } }, '+ Add dimension');
  const ruleBox = h('div', { class: 'sk-rulebox' },
    h('div', { class: 'sk-row sk-rrow' }, shrinkLab, h('div', { class: 'sk-rsvg' }, topRule), h('div', { class: 'sk-colh' }, 'Part mm'), h('div', { class: 'sk-colh' }, 'Make it mm'), h('div', { class: 'sk-colh' }, 'Added'), h('div', {})),
    lanes,
    h('div', { class: 'sk-row sk-rrow' }, h('div', { class: 'sk-rlab' }, 'Part', h('small', {}, 'ordinary rule')), h('div', { class: 'sk-rsvg' }, botRule), h('div', { class: 'sk-foot' }, addBtn)));
  const ruleHead = h('div', { class: 'sk-head' }, h('span', { class: 'sk-cap' }, 'The contraction rule'), h('span', { class: 'sk-key' }, h('i', { class: 'sk-k-part' }), 'part'),
    h('span', { class: 'sk-key' }, h('i', { class: 'sk-k-make' }), 'make it'), h('span', { class: 'sk-key' }, h('i', { class: 'sk-k-spread' }), 'part lands here across the range'), exSeg);
  const rulePanel = h('section', { class: 'sk-panel sk-rule' }, ruleHead, ruleBox, h('div', { class: 'sk-hint sk-foothint' }, 'Drag a bar end to change the part size; arrow keys on a focused bar end.'));
  const warnBox = h('div', { class: 'sk-warns', 'aria-live': 'polite' });
  const notes = h('div', { class: 'sk-notes' });
  const side = h('aside', { class: 'sk-side' }, notes, h('div', { class: 'sk-out' }, ctx.outputs));
  const layout = h('div', { class: 'sk' }, top, h('div', { class: 'sk-main' }, rulePanel, warnBox, chart), side);
  root.append(layout);
  let focusNew = null;

  // =====================================================================
  // Shrinkage chart
  // =====================================================================
  let chartGeo = null, chartDrag = null;
  function drawChart() {
    const svg = chartSvg;
    svg.replaceChildren();
    if (!R) return;
    const W = Math.max(280, svg.clientWidth || 700);
    if (R.mode === 'measured') return drawTest(W);
    const L = 118, Rm = 16, top = 24, bh = 14, gap = 2;
    const narrow = W < 520;
    const lx = narrow ? 8 : L;
    const X = (p) => lx + (W - lx - Rm) * (Math.log10(clamp(p, SMIN, SMAX) / SMIN) / Math.log10(SMAX / SMIN));
    // pack each group's bars into sub-rows, a bar's room including its label
    let y = top;
    const rows = [];
    const ctxText = (t) => t.length * 6.4 + 10;
    for (const gname of GROUPS) {
      if (narrow) y += 14;
      const items = R.materials.filter((m) => m.group === gname);
      const ends = [];
      const placed = items.map((m) => {
        const x0 = X(m.min), x1 = Math.max(X(m.max), x0 + 3), fits = x1 - x0 >= ctxText(m.name), room = fits ? x1 : x1 + ctxText(m.name) - 4;
        let r = ends.findIndex((e) => e + 4 <= x0);
        if (r < 0) { r = ends.length; ends.push(0); }
        ends[r] = room;
        return { m, x0, x1, r, fits };
      });
      const hgt = ends.length * (bh + gap);
      rows.push({ gname, y, hgt, placed });
      y += hgt + 8;
    }
    const H = y + 20;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    // grid
    for (const p of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20]) {
      sv(svg, 'line', { x1: X(p), x2: X(p), y1: top - 6, y2: H - 18, class: 'sk-grid' });
      sv(svg, 'text', { x: X(p), y: H - 5, class: 'sk-t sk-soft', 'text-anchor': 'middle' }, `${p} %`);
    }
    for (const row of rows) {
      if (!narrow) sv(svg, 'text', { x: 8, y: row.y + 12, class: 'sk-t sk-glab' }, row.gname);
      else sv(svg, 'text', { x: 8, y: row.y - 5, class: 'sk-t sk-glab' }, row.gname);
      sv(svg, 'line', { x1: 8, x2: W - Rm, y1: row.y - (narrow ? 18 : 4), y2: row.y - (narrow ? 18 : 4), class: 'sk-sep' });
      for (const { m, x0, x1, r, fits } of row.placed) {
        const on = R.mode === 'material' && m.key === R.material;
        const by = row.y + r * (bh + gap);
        const g = sv(svg, 'g', { class: `sk-bar${on ? ' sk-on' : ''}${R.mode !== 'material' ? ' sk-ref' : ''}`, 'data-m': m.key, role: 'radio', 'aria-checked': String(on), tabindex: on ? 0 : -1,
          'aria-label': `${m.name}, ${m.group.toLowerCase()}, ${m.min} to ${m.max} %` });
        sv(g, 'rect', { x: x0, y: by, width: x1 - x0, height: bh, rx: 3, class: 'sk-bar-r' });
        const left = !fits && x1 + ctxText(m.name) > W - Rm;
        sv(g, 'text', { x: fits ? x0 + 5 : left ? x0 - 4 : x1 + 4, y: by + 11, 'text-anchor': left ? 'end' : 'start', class: `sk-t sk-bar-t${fits ? '' : ' sk-bar-out'}` }, m.name);
        sv(g, 'title', {}, `${m.name}, ${m.group.toLowerCase()}: ${m.min}-${m.max} %`);
      }
    }
    // the marker: the shrinkage in use, draggable
    const xs = X(R.sNom);
    if (R.sMax > R.sMin) sv(svg, 'rect', { x: X(R.sMin), y: top - 8, width: X(R.sMax) - X(R.sMin), height: H - top - 10, class: 'sk-range' });
    sv(svg, 'line', { x1: xs, x2: xs, y1: top - 8, y2: H - 18, class: 'sk-mark' });
    const tl = `${num(R.sNom, 4)} %`;
    const tx = clamp(xs, lx + 30, W - Rm - 30);
    const g = sv(svg, 'g', { class: 'sk-handle', tabindex: 0, role: 'slider', 'data-h': 's', 'aria-label': 'Shrinkage in %', 'aria-valuenow': R.sNom, 'aria-valuetext': `${tl}` });
    sv(g, 'rect', { x: tx - 30, y: 0, width: 60, height: 17, rx: 3, class: 'sk-mark-tag' });
    sv(g, 'text', { x: tx, y: 12.5, class: 'sk-t sk-mark-t', 'text-anchor': 'middle' }, tl);
    sv(g, 'rect', { x: xs - 8, y: 17, width: 16, height: H - 35, class: 'sk-hit' });
    chartGeo = { X, lx, Rm, W };
    if (!svg.querySelector('.sk-bar[tabindex="0"]')) svg.querySelector('.sk-bar')?.setAttribute('tabindex', 0);
    if (refocus === 's') svg.querySelector('[data-h="s"]')?.focus();
    if (refocus?.startsWith('m:')) svg.querySelector(`[data-m="${refocus.slice(2)}"]`)?.focus();
  }
  function drawTest(W) {
    const svg = chartSvg;
    const H = 170;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    const t = R.test;
    const L = 40, Rm = 60;
    const sc = (W - L - Rm) / t.design;
    const E = view.ex;
    const X = (mm) => L + mm * sc;
    const xm = X(t.design - (t.design - t.measured) * E);
    const y = 70, hb = 34;
    // designed outline, measured piece
    sv(svg, 'rect', { x: X(0), y, width: t.design * sc, height: hb, class: 'sk-test-des' });
    sv(svg, 'rect', { x: X(0), y, width: Math.max(2, xm - X(0)), height: hb, class: 'sk-test-meas' });
    // caliper: fixed jaw at 0, moving jaw at the measured end, beam above
    sv(svg, 'rect', { x: X(0) - 14, y: y - 38, width: Math.max(xm, X(t.design)) - X(0) + 44, height: 12, class: 'sk-cal-beam' });
    sv(svg, 'path', { d: `M${X(0) - 14},${y - 26} L${X(0)},${y - 26} L${X(0)},${y + hb + 12} L${X(0) - 14},${y + hb + 4} Z`, class: 'sk-cal-jaw' });
    const g = sv(svg, 'g', { class: 'sk-handle', tabindex: 0, role: 'slider', 'data-h': 'jaw', 'aria-label': 'Measured size of the test piece', 'aria-valuenow': t.measured, 'aria-valuetext': `${num(t.measured, 6)} mm` });
    sv(g, 'path', { d: `M${xm},${y - 26} L${xm + 14},${y - 26} L${xm + 14},${y + hb + 4} L${xm},${y + hb + 12} Z`, class: 'sk-cal-jaw sk-cal-move' });
    sv(g, 'rect', { x: xm - 6, y: y - 40, width: 26, height: hb + 56, class: 'sk-hit' });
    sv(svg, 'text', { x: Math.min(xm + 14, W - 4), y: y - 46, class: 'sk-t sk-strong', 'text-anchor': 'end' }, `${num(t.measured, 6)} measured`);
    sv(svg, 'line', { x1: X(t.design), x2: X(t.design), y1: y - 6, y2: y + hb + 26, class: 'sk-des-line' });
    sv(svg, 'text', { x: X(t.design), y: y + hb + 38, class: 'sk-t sk-soft', 'text-anchor': 'end' }, `${num(t.design, 6)} designed`);
    sv(svg, 'text', { x: X(0) + 8, y: y + hb / 2 + 4, class: 'sk-t sk-strong' }, `shrank ${mm3(t.design - t.measured)} mm = ${num(R.sNom, 4)} %`);
    sv(svg, 'text', { x: X(0), y: H - 8, class: 'sk-t sk-soft' }, E > 1 ? `difference drawn ×${E}` : 'to scale');
    chartGeo = { test: true, X, sc, E, design: t.design, L };
    if (refocus === 'jaw') g.focus();
  }
  chartSvg.addEventListener('pointerdown', (e) => {
    if (!R || !chartGeo) return;
    const bar = e.target.closest?.('[data-m]');
    if (bar) { ctx.setMany({ mode: 'material', material: bar.dataset.m }); return; }
    if (!e.target.closest?.('[data-h]') && !chartGeo.test) {
      // a press on the axis area moves the marker there
      chartDrag = { ...chartGeo }; capture(chartSvg, e); moveMark(e); e.preventDefault(); return;
    }
    if (!e.target.closest?.('[data-h]')) return;
    chartDrag = { ...chartGeo }; capture(chartSvg, e); e.preventDefault();
  });
  function moveMark(e) {
    const r = chartSvg.getBoundingClientRect();
    const x = e.clientX - r.left;
    const f = chartDrag;
    if (f.test) {
      const m = f.design - (f.X(f.design) - x) / (f.sc * f.E);
      const v = Number(clamp(m, f.design * 0.5, f.design * 1.2).toFixed(2));
      if (v !== R.test.measured) ctx.set('measured', String(v));
      return;
    }
    const { lx, Rm, W } = f;
    const p = SMIN * Math.pow(SMAX / SMIN, clamp((x - lx) / (W - lx - Rm), 0, 1));
    const v = Number(p.toPrecision(p < 1 ? 2 : 3));
    if (R.mode !== 'custom' || v !== R.sNom) ctx.setMany({ mode: 'custom', shrink: String(v) });
  }
  chartSvg.addEventListener('pointermove', (e) => { if (chartDrag) moveMark(e); });
  chartSvg.addEventListener('pointerup', () => { chartDrag = null; });
  chartSvg.addEventListener('pointercancel', () => { chartDrag = null; });
  chartSvg.addEventListener('keydown', (e) => {
    const bar = e.target.closest?.('[data-m]');
    if (bar && R) {
      const mats = R.materials, i = mats.findIndex((m) => m.key === bar.dataset.m);
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refocus = `m:${bar.dataset.m}`; ctx.setMany({ mode: 'material', material: bar.dataset.m }); return; }
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!d) return; e.preventDefault();
      const n = mats[clamp(i + d, 0, mats.length - 1)].key;
      refocus = `m:${n}`; ctx.setMany({ mode: 'material', material: n });
      return;
    }
    const g = e.target.closest?.('[data-h]');
    if (!R || !g) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (!d) return; e.preventDefault();
    if (g.dataset.h === 'jaw') { refocus = 'jaw'; ctx.set('measured', String(Number((R.test.measured + d * 0.01 * (R.test.design >= 50 ? 5 : 1)).toFixed(2)))); return; }
    refocus = 's';
    const st = R.sNom < 1 ? 0.01 : R.sNom < 5 ? 0.05 : 0.5;
    ctx.setMany({ mode: 'custom', shrink: String(Number(clamp(R.sNom + d * st, -5, 40).toFixed(2))) });
  });

  // =====================================================================
  // The rule
  // =====================================================================
  let laneEls = [], ruleGeo = null, laneDrag = null;
  function buildLanes() {
    const raw = ctx.raw.dims || [];
    lanes.replaceChildren();
    laneEls = raw.map((r, i) => {
      const name = h('input', { type: 'text', class: 'sk-name', spellcheck: 'false', 'aria-label': `Name of dimension ${i + 1}`,
        oninput: (e) => editDim(i, 'name', e.target.value) });
      const size = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', class: 'sk-size', 'aria-label': `Part size of dimension ${i + 1}, mm`,
        oninput: (e) => editDim(i, 'size', e.target.value) });
      const svg = sv(null, 'svg', { class: 'sk-lane-svg', role: 'group', 'aria-label': `Dimension ${i + 1}: part and make-it size` });
      const make = h('div', { class: 'sk-make' }), added = h('div', { class: 'sk-added' });
      const del = h('button', { type: 'button', class: 'sk-x', title: 'Remove', 'aria-label': `Remove dimension ${i + 1}`, onclick: () => {
        const d = (ctx.raw.dims || []).map((x) => ({ ...x })); d.splice(i, 1); ctx.set('dims', d);
      } }, '×');
      const row = h('div', { class: 'sk-row sk-lane' }, h('div', { class: 'sk-rlab' }, name), h('div', { class: 'sk-rsvg' }, svg), h('div', {}, size), make, added, del);
      lanes.append(row);
      svg.addEventListener('pointerdown', (e) => {
        if (!e.target.closest?.('[data-h]') || !ruleGeo) return;
        laneDrag = { i, geo: { ...ruleGeo } }; capture(svg, e); e.preventDefault();
      });
      svg.addEventListener('pointermove', (e) => {
        if (!laneDrag || laneDrag.i !== i) return;
        const rr = svg.getBoundingClientRect();
        const mmv = (e.clientX - rr.left - laneDrag.geo.L) / laneDrag.geo.sc;
        const st = mmv >= 100 ? 1 : mmv >= 10 ? 0.5 : 0.1;
        const v = Math.max(0.1, Math.round(mmv / st) * st);
        const cur = R.dims.find((d) => d.index === i);
        if (!cur || Math.abs(cur.part - v) > 1e-9) editDim(i, 'size', String(Number(v.toFixed(1))));
      });
      const end = () => { if (laneDrag) { laneDrag = null; drawRule(); } };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);
      svg.addEventListener('keydown', (e) => {
        if (!e.target.closest?.('[data-h]')) return;
        const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
        const cur = R?.dims.find((x) => x.index === i);
        if (!d || !cur) return; e.preventDefault();
        const st = cur.part >= 100 ? 1 : cur.part >= 10 ? 0.5 : 0.1;
        refocus = `lane:${i}`;
        editDim(i, 'size', String(Number(Math.max(0.1, cur.part + d * st).toFixed(1))));
      });
      return { row, name, size, svg, make, added };
    });
    if (focusNew != null) { laneEls[focusNew]?.name.focus(); laneEls[focusNew]?.name.select(); focusNew = null; }
  }
  function editDim(i, key, value) {
    const d = (ctx.raw.dims || []).map((x) => ({ ...x }));
    if (!d[i]) return;
    d[i][key] = value;
    ctx.set('dims', d);
  }
  function drawRule() {
    const raw = ctx.raw.dims || [];
    if (laneEls.length !== raw.length) buildLanes();
    laneEls.forEach((el, i) => {
      if (document.activeElement !== el.name) el.name.value = raw[i]?.name ?? '';
      if (document.activeElement !== el.size) el.size.value = raw[i]?.size ?? '';
    });
    if (!R) return;
    const E = view.ex;
    const W = Math.max(160, topRule.clientWidth || 600);
    const L = 8, Rm = 26;
    const drawn = (d, v) => d.part + (v - d.part) * E; // a size drawn with the difference exaggerated
    const maxDim = Math.max(10, ...R.dims.map((d) => Math.max(drawn(d, d.mould), drawn(d, d.hi))));
    const span = laneDrag ? laneDrag.geo.span : maxDim * 1.04;
    const sc = (W - L - Rm) / span;
    ruleGeo = { L, sc, span };
    const X = (mm) => L + mm * sc;
    // rulers: the ordinary one (part mm), the shrink rule (its mm stretched by k, drift drawn xE)
    const stepMm = niceStep(span, W < 400 ? 4 : 8);
    const ruler = (svg, stretched) => {
      svg.replaceChildren();
      const H = 30;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      const base = stretched ? H - 1 : 1;
      sv(svg, 'rect', { x: X(0), y: stretched ? 4 : 0, width: X(span) - X(0) + Rm - 4, height: H - 4, class: `sk-rule-body${stretched ? ' sk-rule-shrink' : ''}` });
      const minor = stepMm / (String(stepMm)[0] === '5' ? 5 : 2);
      for (let n = 0; n <= span + 1e-9; n += minor) {
        const pos = stretched ? n + n * (R.k - 1) * E : n;
        if (pos > span) break;
        const major = Math.abs(n / stepMm - Math.round(n / stepMm)) < 1e-6;
        const len = major ? 11 : 6;
        sv(svg, 'line', { x1: X(pos), x2: X(pos), y1: base, y2: stretched ? base - len : base + len, class: 'sk-tick' });
        if (major) sv(svg, 'text', { x: X(pos) + 2, y: stretched ? 15 : 24, class: 'sk-t sk-rule-n' }, num(n, 5));
      }
    };
    shrinkSub.textContent = `shrink rule ×${num(R.k, 6)}`;
    ruler(topRule, true);
    ruler(botRule, false);
    laneEls.forEach((el, i) => {
      const svg = el.svg;
      svg.replaceChildren();
      const H = 34;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      const d = R.dims.find((x) => x.index === i);
      if (!d) {
        el.make.textContent = '–'; el.added.textContent = '';
        sv(svg, 'text', { x: L + 4, y: 21, class: 'sk-t sk-soft' }, String(raw[i]?.size ?? '').trim() ? 'not a positive number' : 'give the part size');
        return;
      }
      el.make.textContent = mm3(d.mould);
      el.added.textContent = `+${mm3(d.added)}`;
      // guides down from the rulers
      const xp = X(d.part), xm = X(drawn(d, d.mould));
      sv(svg, 'rect', { x: X(0), y: 9, width: xp - X(0), height: 16, class: 'sk-part' });
      sv(svg, 'rect', { x: xp, y: 9, width: Math.max(1.5, xm - xp), height: 16, class: 'sk-extra' });
      sv(svg, 'rect', { x: X(0), y: 5.5, width: xm - X(0), height: 23, class: 'sk-makeo' });
      if (R.sMax > R.sMin) {
        const a = X(drawn(d, d.lo)), b = X(drawn(d, d.hi));
        sv(svg, 'rect', { x: a, y: 1, width: Math.max(2, b - a), height: 32, class: 'sk-spread' });
        sv(svg, 'line', { x1: a, x2: b, y1: 31, y2: 31, class: 'sk-spread-w' });
      }
      const nm = String(raw[i]?.name || '').trim();
      if (xp - X(0) > 60) sv(svg, 'text', { x: X(0) + 6, y: 21.5, class: 'sk-t sk-in' }, `${nm ? `${nm} ` : ''}${num(d.part, 6)}`);
      const g = sv(svg, 'g', { class: 'sk-handle', tabindex: 0, role: 'slider', 'data-h': 'end', 'aria-label': `${nm || `Dimension ${i + 1}`}, part size`, 'aria-valuenow': d.part, 'aria-valuetext': `${num(d.part, 6)} mm, make it ${mm3(d.mould)} mm` });
      sv(g, 'rect', { x: xp - 9, y: 0, width: 18, height: H, class: 'sk-hit' });
      sv(g, 'line', { x1: xp, x2: xp, y1: 4, y2: H - 4, class: 'sk-grip' });
      if (refocus === `lane:${i}`) g.focus();
    });
  }

  // =====================================================================
  function draw() {
    const r = ctx.raw;
    modeSeg.querySelectorAll('button').forEach((b) => { const on = b.dataset.v === r.mode; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    fShrink.hidden = r.mode !== 'custom'; fDesign.hidden = fMeas.hidden = r.mode !== 'measured';
    fShrink.sync(r.shrink); fDesign.sync(r.design); fMeas.sync(r.measured);
    syncEx();
    chartHead.querySelector('.sk-cap').textContent = r.mode === 'measured' ? 'Test piece in the caliper' : 'Linear shrinkage, %';
    chartHead.querySelector('.sk-hint').textContent = r.mode === 'measured' ? 'drag the jaw to what you measured' : 'click a material, or drag the marker to set your own value';
    const warns = res?.warnings || [];
    warnBox.replaceChildren(...warns.map((w) => h('div', {}, w)));
    warnBox.hidden = !warns.length;
    notes.replaceChildren(...(res?.notes || []).map((n) => h('div', {}, n)));
    if (R) {
      const spread = res.values?.find((v) => v.label === 'Spread from the range');
      readout.replaceChildren(
        h('div', { class: 'sk-rd' }, h('small', {}, 'Scale factor'), h('b', {}, num(R.k, 7))),
        h('div', { class: 'sk-rd' }, h('small', {}, 'CAD / slicer'), h('b', {}, `${num(R.k * 100, 7)} %`)),
        h('div', { class: 'sk-rd' }, h('small', {}, `Shrinkage, ${R.mode === 'material' ? R.label.replace(/\s*\(.*$/, '') : R.label}`), h('b', {}, `${num(R.sNom, 4)} %`)),
        ...(spread ? [h('div', { class: `sk-rd${spread.tone === 'warn' ? ' sk-rd-warn' : ''}` }, h('small', {}, `Spread, ${spread.hint}`), h('b', {}, spread.value))] : []));
    } else readout.replaceChildren();
    drawChart(); drawRule();
    refocus = null;
  }
  ctx.onResult((rr) => { res = rr; R = rr.rule || null; draw(); });
  let sizes = '', raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const now = [chartSvg, topRule].map((e) => `${e.clientWidth}`).join();
      if (now === sizes || !R) return;
      sizes = now; drawChart(); drawRule();
    });
  }).observe(layout);
}
