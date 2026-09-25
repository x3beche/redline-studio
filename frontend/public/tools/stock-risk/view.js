// Stock Risk Scanner: the page is the shelf. Every part of the BOM is a row,
// worst first, with its distributor stock drawn on one log scale of units
// against what this build pulls from it: the need tick (qty per board x
// boards), the comfortable-stock tick (coverage x need), red where the stock
// cannot even cover this build. Drag any need tick to change the number of
// boards - every row's need moves with it, so you watch which parts run dry
// first; drag a coverage tick for the comfortable multiple. Click the source
// dots or the lifecycle chip on a row to try "what if we qualify a second
// source": the change is written back into the BOM text.
// Every score, count and ratio drawn comes from run()'s result.stock.

import { splitRow } from './tool.js';

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
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ } };
const units = (v) => {
  if (v == null) return '?';
  if (v >= 1e6) return `${Number((v / 1e6).toPrecision(3))}M`;
  if (v >= 1e4) return `${Number((v / 1e3).toPrecision(3))}k`;
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
const covTxt = (c) => (c == null ? '–' : `${Number(c.toPrecision(2))}×`);
const LIFE_CYCLE = ['Active', 'NRND', 'Last time buy', 'Obsolete'];
const lifeTone = (label) => (/obsolete|last-time/.test(label) ? 'bad' : /NRND/.test(label) ? 'warn' : /active/.test(label) ? 'ok' : 'soft');
const FACT = [['life', 'Lifecycle', 40], ['src', 'Sources', 25], ['stock', 'Stock', 35], ['lead', 'Lead time', 15]];
// 1-2-5 steps for the boards-to-build keyboard path
const nextNice = (v, d) => {
  const list = [];
  for (let e = 0; e <= 6; e++) for (const m of [1, 2, 5]) list.push(m * 10 ** e);
  if (d > 0) return list.find((x) => x > v + 1e-9) ?? v;
  return [...list].reverse().find((x) => x < v - 1e-9) ?? v;
};
const roundBuild = (v) => (v < 20 ? Math.max(1, Math.round(v)) : v < 200 ? Math.round(v / 5) * 5 : v < 2000 ? Math.round(v / 10) * 10 : v < 20000 ? Math.round(v / 100) * 100 : Math.round(v / 1000) * 1000);

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let R = null;              // result.stock
  let sel = null;            // selected part name
  let filter = null;         // 'high' | 'single' | 'short' | null
  let drag = null;           // {kind, axis, qty|need}
  let axisFrozen = null;
  let focusKey = null;

  // ---------- top: the build ----------
  const range = h('input', { type: 'range', min: '0', max: '5', step: '0.01', class: 'sr-range', 'aria-label': 'Boards to build (logarithmic)',
    oninput: (e) => ctx.set('builds', String(roundBuild(10 ** Number(e.target.value)))) });
  const buildsIn = h('input', { type: 'text', inputmode: 'numeric', class: 'sr-in', 'aria-label': 'Boards to build', oninput: (e) => ctx.set('builds', e.target.value) });
  const covIn = h('input', { type: 'text', inputmode: 'decimal', class: 'sr-in sm', 'aria-label': 'Comfortable stock, multiple of the build need', oninput: (e) => ctx.set('coverage', e.target.value) });
  const chips = h('div', { class: 'sr-chips', role: 'group', 'aria-label': 'Highlight parts' });
  const top = h('div', { class: 'sr-top' },
    h('label', { class: 'sr-build' }, h('span', { class: 'sr-cap' }, 'Build'), range, buildsIn, h('span', { class: 'sr-cap' }, 'boards')),
    h('label', { class: 'sr-build' }, h('span', { class: 'sr-cap' }, 'comfortable at'), covIn, h('span', { class: 'sr-cap' }, '× need')),
    chips);

  // ---------- shelf ----------
  const shelfSvg = sv(null, 'svg', { class: 'sr-svg', role: 'group', 'aria-label': 'Parts by risk with stock against need' });
  const shelfHead = h('div', { class: 'sr-head' });
  const warnBox = h('div', { class: 'sr-warns', 'aria-live': 'polite' });
  const shelfScroll = h('div', { class: 'sr-scroll' }, shelfSvg);
  const shelf = h('section', { class: 'sr-card sr-shelf' }, shelfHead, shelfScroll,
    h('div', { class: 'sr-legend' },
      h('span', {}, h('i', { class: 'lg need' }), 'need = qty × boards (drag)'),
      h('span', {}, h('i', { class: 'lg cov' }), 'comfortable stock (drag)'),
      h('span', {}, h('i', { class: 'lg bad' }), 'short for this build'),
      h('span', {}, h('i', { class: 'lg warn' }), 'thin'),
      h('span', {}, h('i', { class: 'lg ok' }), 'covered'),
      h('span', {}, '● source dots and the lifecycle chip are clickable')));

  // ---------- side: the part, the BOM, the outputs ----------
  const detail = h('section', { class: 'sr-card sr-detail', 'aria-live': 'polite' });
  const bomTa = h('textarea', { class: 'sr-bom', spellcheck: 'false', rows: '9', 'aria-label': 'BOM with supply data (CSV or TSV)',
    oninput: (e) => ctx.set('bom', e.target.value) });
  const bomCard = h('details', { class: 'sr-card sr-bomcard' },
    h('summary', {}, h('b', {}, 'BOM text'), h('span', {}, ' paste a distributor export; edits on the shelf are written here')), bomTa);
  const side = h('aside', { class: 'sr-side' }, detail, bomCard, h('div', { class: 'sr-out' }, ctx.outputs));

  root.append(h('div', { class: 'sr' }, top, h('div', { class: 'sr-main' }, warnBox, shelf), side));

  // ---------- writing a cell back into the BOM text ----------
  const HEAD = { sources: 'Sources', life: 'Lifecycle', stock: 'Stock', lead: 'Lead time' };
  function writeCell(part, key, value) {
    if (!R || part.line == null) return;
    const text = String(ctx.raw.bom || '');
    const lines = text.split(/\r?\n/);
    const d = R.delim;
    const q = (c) => (c.includes(d) || c.includes('"') ? `"${c.replace(/"/g, '""')}"` : c);
    let col = R.columns[key];
    if (col == null) {
      const hc = splitRow(lines[R.headerLine], d);
      col = hc.length; hc.push(HEAD[key]);
      lines[R.headerLine] = hc.map(q).join(d);
    }
    const cells = splitRow(lines[part.line], d);
    while (cells.length <= col) cells.push('');
    cells[col] = String(value);
    lines[part.line] = cells.map(q).join(d);
    ctx.set('bom', lines.join(text.includes('\r\n') ? '\r\n' : '\n'));
  }

  // ---------- the shelf drawing ----------
  let axis = null;
  function drawShelf() {
    const svg = shelfSvg;
    svg.replaceChildren();
    const W = Math.max(300, shelfScroll.clientWidth || 800);
    const narrow = W < 660;
    const AX = 26;
    const parts = R.parts;
    const avail = (shelfScroll.clientHeight || 500) - AX - 8;
    const RH = narrow ? 66 : clamp(Math.floor(avail / Math.max(1, parts.length)), 46, 60);
    const H = AX + parts.length * RH + 6;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    const x0 = narrow ? 12 : 262, x1 = narrow ? W - 14 : W - 222;
    if (!axisFrozen) {
      let hi = 1;
      for (const p of parts) hi = Math.max(hi, p.stock || 0, p.need * R.cov, p.need);
      const b = Math.max(3, Math.ceil(Math.log10(hi * 1.6)));
      axis = { a: 0, b };
    } else axis = axisFrozen;
    const X = (v) => x0 + ((Math.log10(Math.max(1, v)) - axis.a) / (axis.b - axis.a)) * (x1 - x0);
    axis.X = X; axis.inv = (px) => 10 ** (axis.a + ((px - x0) / (x1 - x0)) * (axis.b - axis.a));
    // decade grid and labels
    const grid = sv(svg, 'g', { class: 'sr-grid' });
    for (let e = axis.a; e <= axis.b; e++) {
      const x = X(10 ** e);
      sv(grid, 'line', { x1: x, y1: AX - 4, x2: x, y2: H });
      sv(svg, 'text', { x, y: AX - 9, class: 'sr-ax', 'text-anchor': 'middle' }, units(10 ** e));
      if (e < axis.b) for (const m of [2, 5]) sv(grid, 'line', { x1: X(m * 10 ** e), y1: AX, x2: X(m * 10 ** e), y2: H, class: 'minor' });
    }
    if (!narrow) {
      sv(svg, 'text', { x: 12, y: AX - 9, class: 'sr-ax' }, '#  score   part');
      sv(svg, 'text', { x: x1 + 16, y: AX - 9, class: 'sr-ax' }, 'sources');
      sv(svg, 'text', { x: x1 + 96, y: AX - 9, class: 'sr-ax', 'text-anchor': 'middle' }, 'life');
      sv(svg, 'text', { x: x1 + 126, y: AX - 9, class: 'sr-ax' }, 'lead, wk');
    }

    parts.forEach((p, i) => {
      const y = AX + i * RH;
      const on = p.name === sel;
      const dim = filter && !(filter === 'high' ? p.level === 'High' : filter === 'single' ? p.src === 1 : p.stock != null && p.stock < p.need);
      const g = sv(svg, 'g', { class: `sr-row lv-${p.level.toLowerCase()}${on ? ' on' : ''}${dim ? ' dim' : ''}`, 'data-i': i });
      sv(g, 'rect', { x: 0, y, width: W, height: RH, class: 'bg' });
      const ty = narrow ? y + 44 : y + RH / 2;          // track centre
      // --- rank, score ring, name
      const sx = narrow ? 20 : 40, sy = narrow ? y + 17 : y + RH / 2;
      if (!narrow) sv(g, 'text', { x: 8, y: sy + 4, class: 'sr-rank' }, String(p.rank));
      const ring = sv(g, 'g', { class: 'sr-score' });
      const rr = 13, circ = 2 * Math.PI * rr;
      sv(ring, 'circle', { cx: sx, cy: sy, r: rr, class: 'trk' });
      sv(ring, 'circle', { cx: sx, cy: sy, r: rr, class: 'arc', 'stroke-dasharray': `${(circ * p.score) / 100} ${circ}`, transform: `rotate(-90 ${sx} ${sy})` });
      sv(ring, 'text', { x: sx, y: sy + 4, 'text-anchor': 'middle', class: 'num' }, String(p.score));
      const nx = narrow ? 40 : 62;
      const nameMax = narrow ? Math.floor((W - 200) / 7.2) : 26;
      const nm = p.name.length > nameMax ? `${p.name.slice(0, nameMax - 1)}…` : p.name;
      sv(g, 'text', { x: nx, y: narrow ? y + 15 : y + RH / 2 - 3, class: 'sr-name' }, nm).append(sv(null, 'title', {}, p.name));
      const sub = [p.mfr, p.refs.length ? (p.refs.length > 3 ? `${p.refs[0]}…${p.refs[p.refs.length - 1]}` : p.refs.join(' ')) : '', `${p.qty}/board`].filter(Boolean).join(' · ');
      sv(g, 'text', { x: nx, y: narrow ? y + 28 : y + RH / 2 + 12, class: 'sr-sub' }, sub.length > (narrow ? nameMax + 6 : 34) ? `${sub.slice(0, narrow ? nameMax + 5 : 33)}…` : sub);

      // --- the track
      const st = p.stock == null ? 'unk' : p.stock < p.need ? 'bad' : p.stock < R.cov * p.need ? 'warn' : 'ok';
      sv(g, 'rect', { x: x0, y: ty - 8, width: x1 - x0, height: 16, class: 'trk' });
      const xn = X(p.need), xc = X(p.need * R.cov);
      sv(g, 'rect', { x: x0, y: ty - 8, width: Math.max(0, xn - x0), height: 16, class: 'zone bad' });
      sv(g, 'rect', { x: xn, y: ty - 8, width: Math.max(0, xc - xn), height: 16, class: 'zone warn' });
      if (p.stock == null) {
        sv(g, 'rect', { x: x0, y: ty - 5, width: x1 - x0, height: 10, class: 'stock unk' });
        sv(g, 'text', { x: x0 + 6, y: ty + 4, class: 'sr-val soft' }, 'stock not in the BOM');
      } else if (p.stock <= 0) {
        sv(g, 'text', { x: x0 + 6, y: ty + 4, class: 'sr-val bad' }, '0 in stock');
      } else {
        const xs = X(p.stock);
        sv(g, 'rect', { x: x0, y: ty - 5, width: Math.max(2, xs - x0), height: 10, rx: 1.5, class: `stock ${st}` });
        const label = `${units(p.stock)} · ${covTxt(p.cov)}`;
        const inside = xs - x0 > 120 && (xs > xc + 70 || xs < xn - 10);
        sv(g, 'text', { x: inside ? xs - 6 : xs + 6, y: ty + 4, class: `sr-val ${inside ? 'in' : st}`, 'text-anchor': inside ? 'end' : 'start' }, label);
      }
      // need and comfortable-stock ticks (the handles)
      const nh = sv(g, 'g', { class: 'sr-h need', tabindex: on || (!sel && i === 0) ? '0' : '-1', role: 'slider', 'data-h': 'need', 'data-i': i,
        'aria-label': `Boards to build (need of ${p.name}: ${p.need})`, 'aria-valuenow': R.builds });
      sv(nh, 'rect', { x: xn - 7, y: ty - 14, width: 14, height: 28, class: 'hit' });
      sv(nh, 'line', { x1: xn, y1: ty - 12, x2: xn, y2: ty + 12, class: 'tick' });
      sv(nh, 'path', { d: `M${xn - 4},${ty - 15}h8l-4,5z`, class: 'tri' });
      const ch = sv(g, 'g', { class: 'sr-h cov', tabindex: on || (!sel && i === 0) ? '0' : '-1', role: 'slider', 'data-h': 'cov', 'data-i': i,
        'aria-label': 'Comfortable stock, multiple of need', 'aria-valuenow': R.cov });
      sv(ch, 'rect', { x: xc - 6, y: ty - 12, width: 12, height: 24, class: 'hit' });
      sv(ch, 'line', { x1: xc, y1: ty - 10, x2: xc, y2: ty + 10, class: 'tick' });
      if (on || (!sel && i === 0)) sv(g, 'text', { x: xn, y: ty + 23, class: 'sr-ax need', 'text-anchor': 'middle' }, `need ${units(p.need)}`);

      // --- sources, lifecycle, lead
      const bx = narrow ? W - 150 : x1 + 16, by = narrow ? y + 15 : y + RH / 2;
      const pips = sv(g, 'g', { class: 'sr-pips', role: 'group', 'aria-label': `${p.name} sources` });
      const nSrc = p.src == null ? 0 : Math.min(4, p.src);
      for (let k = 1; k <= 4; k++) {
        const pip = sv(pips, 'g', { class: `sr-pip${k <= nSrc ? ' fill' : ''}${p.src == null ? ' unk' : ''}${p.src === 1 && k === 1 ? ' single' : ''}`, tabindex: '-1', role: 'button', 'data-src': k, 'data-i': i,
          'aria-label': `Set ${p.name} to ${k} source${k > 1 ? 's' : ''}` });
        sv(pip, 'circle', { cx: bx + (k - 1) * 11 + 5, cy: by - 1, r: 6.5, class: 'hit' });
        sv(pip, 'circle', { cx: bx + (k - 1) * 11 + 5, cy: by - 1, r: 4, class: 'dot' });
      }
      if (p.src == null) sv(g, 'text', { x: bx + 47, y: by + 3, class: 'sr-mini soft' }, p.generic ? 'gen' : '?');
      else if (p.src > 4) sv(g, 'text', { x: bx + 47, y: by + 3, class: 'sr-mini' }, `${p.src}`);
      const lx = bx + 58;
      const lt = lifeTone(p.life);
      const short = /obsolete/.test(p.life) ? 'EOL' : /last-time/.test(p.life) ? 'LTB' : /NRND/.test(p.life) ? 'NRND' : /active/.test(p.life) ? 'Active' : /preview/.test(p.life) ? 'New' : '?';
      const chip = sv(g, 'g', { class: `sr-life ${lt}`, tabindex: '-1', role: 'button', 'data-i': i, 'aria-label': `${p.name} lifecycle ${p.life}; click for the next state` });
      sv(chip, 'rect', { x: lx, y: by - 9, width: 44, height: 16, rx: 3 });
      sv(chip, 'text', { x: lx + 22, y: by + 3, 'text-anchor': 'middle' }, short);
      // lead: a small bar to 40 wk with the 12 / 26 wk marks
      const ex = lx + 52, ew = narrow ? 30 : 56;
      if (!narrow) {
        sv(g, 'rect', { x: ex, y: by - 3, width: ew, height: 5, class: 'lead-trk' });
        sv(g, 'line', { x1: ex + (12 / 40) * ew, y1: by - 5, x2: ex + (12 / 40) * ew, y2: by + 4, class: 'lead-mk' });
        sv(g, 'line', { x1: ex + (26 / 40) * ew, y1: by - 5, x2: ex + (26 / 40) * ew, y2: by + 4, class: 'lead-mk' });
        if (p.lead != null) sv(g, 'rect', { x: ex, y: by - 3, width: (Math.min(40, p.lead) / 40) * ew, height: 5, class: `lead ${p.lead > 26 ? 'bad' : p.lead > 12 ? 'warn' : 'ok'}` });
      }
      if (!narrow) sv(g, 'text', { x: ex + ew + 4, y: by + 3, class: 'sr-mini' }, p.lead == null ? '–' : `${Math.round(p.lead)}w`);
    });
    const need = R.parts.find((p) => p.name === sel) || R.parts[0];
    shelfHead.replaceChildren(h('b', {}, 'Stock on the shelf'),
      h('span', {}, ` ${R.counts.parts} parts, worst first · log scale of units · ${R.builds} board${R.builds === 1 ? '' : 's'}: `),
      h('span', { class: 'm' }, `${need ? `${need.name} needs ${units(need.need)}` : ''}`));
    // restore keyboard focus after a redraw
    if (focusKey) {
      const fi = parts.findIndex((q) => q.name === focusKey.name);
      const el = fi < 0 ? null : svg.querySelector(`.sr-h.${focusKey.h}[data-i="${fi}"]`);
      if (el && (document.activeElement === document.body || document.activeElement?.closest?.('.sr-svg'))) el.focus({ preventScroll: true });
    }
  }

  // ---------- detail of the selected part ----------
  function drawDetail() {
    const p = R.parts.find((q) => q.name === sel) || R.parts[0];
    if (!p) { detail.replaceChildren(); return; }
    const segs = FACT.map(([k, label, max]) => {
      const v = p.pts[k];
      return h('div', { class: `sr-f f-${k}${v ? '' : ' zero'}` },
        h('span', { class: 'l' }, label),
        h('span', { class: 'bar' }, h('i', { style: `width:${(v / max) * 100}%` })),
        h('b', {}, v ? `+${v}` : '0'));
    });
    const lines = String(ctx.raw.bom || '').split(/\r?\n/);
    const srcStep = (d) => writeCell(p, 'sources', Math.max(1, (p.src || 1) + d));
    const lifeSel = h('select', { 'aria-label': 'Lifecycle', onchange: (e) => writeCell(p, 'life', e.target.value) },
      ['', ...LIFE_CYCLE].map((v) => h('option', { value: v, selected: v.toLowerCase() === String(p.lifeRaw || '').toLowerCase() }, v || '(blank)')));
    const stockIn = h('input', { type: 'text', value: p.stock == null ? '' : String(p.stock), 'aria-label': 'Stock', class: 'sr-in',
      onchange: (e) => writeCell(p, 'stock', e.target.value.trim()) });
    detail.replaceChildren(
      h('div', { class: 'sr-dh' },
        h('div', { class: `sr-big lv-${p.level.toLowerCase()}` }, String(p.score), h('small', {}, p.level)),
        h('div', { class: 'sr-dn' }, h('b', {}, p.name), h('span', {}, [p.mfr, p.refs.join(' ')].filter(Boolean).join(' · ') || '–'))),
      h('div', { class: 'sr-facts' },
        h('span', {}, 'need ', h('b', {}, units(p.need))), h('span', {}, 'stock ', h('b', {}, units(p.stock))),
        h('span', {}, 'coverage ', h('b', {}, covTxt(p.cov))), h('span', {}, 'lead ', h('b', {}, p.lead == null ? '–' : `${Math.round(p.lead)} wk`))),
      h('div', { class: 'sr-fs' }, segs),
      h('div', { class: 'sr-why' }, p.reasons.length ? `Why: ${p.reasons.join('; ')}.` : 'No flags.'),
      h('div', { class: 'sr-edit' },
        h('span', { class: 'sr-cap' }, 'Try'),
        h('span', { class: 'sr-step' }, h('button', { type: 'button', class: 'k-btn', 'aria-label': 'One source fewer', onclick: () => srcStep(-1) }, '−'),
          h('span', {}, `${p.src ?? '?'} source${p.src === 1 ? '' : 's'}`),
          h('button', { type: 'button', class: 'k-btn', 'aria-label': 'One source more', onclick: () => srcStep(1) }, '+')),
        lifeSel,
        h('label', { class: 'sr-cap' }, 'stock ', stockIn)),
      p.line != null ? h('div', { class: 'sr-line' }, h('span', {}, `BOM line ${p.line + 1}`), h('code', {}, lines[p.line] || '')) : null);
  }

  // ---------- interaction on the shelf ----------
  shelfSvg.addEventListener('pointerdown', (e) => {
    if (!R) return;
    const hEl = e.target.closest?.('.sr-h');
    const pip = e.target.closest?.('.sr-pip');
    const life = e.target.closest?.('.sr-life');
    const row = e.target.closest?.('.sr-row');
    if (hEl) {
      e.preventDefault();
      const p = R.parts[Number(hEl.dataset.i)];
      sel = p.name;
      drag = { kind: hEl.dataset.h, qty: p.qty, need: p.need };
      axisFrozen = { a: axis.a, b: axis.b };
      focusKey = { h: hEl.dataset.h, name: p.name };
      capture(shelfSvg, e);
      shelfSvg.classList.add('dragging');
      return;
    }
    if (pip) { const p = R.parts[Number(pip.dataset.i)]; sel = p.name; writeCell(p, 'sources', pip.dataset.src); return; }
    if (life) {
      const p = R.parts[Number(life.dataset.i)]; sel = p.name;
      const cur = LIFE_CYCLE.findIndex((v) => v.toLowerCase() === String(p.lifeRaw || '').toLowerCase());
      writeCell(p, 'life', LIFE_CYCLE[(cur + 1) % LIFE_CYCLE.length]);
      return;
    }
    if (row) { sel = R.parts[Number(row.dataset.i)].name; drawShelf(); drawDetail(); }
  });
  shelfSvg.addEventListener('pointermove', (e) => {
    if (!drag || !R) return;
    const r = shelfSvg.getBoundingClientRect();
    const v = axis.inv(e.clientX - r.left);
    if (drag.kind === 'need') ctx.set('builds', String(roundBuild(clamp(v / drag.qty, 1, 1e6))));
    else ctx.set('coverage', String(clamp(Math.round((v / drag.need) * 10) / 10, 1, 100)));
  });
  const endDrag = () => { if (!drag) return; drag = null; axisFrozen = null; shelfSvg.classList.remove('dragging'); if (R) drawShelf(); };
  shelfSvg.addEventListener('pointerup', endDrag);
  shelfSvg.addEventListener('pointercancel', endDrag);
  shelfSvg.addEventListener('keydown', (e) => {
    if (!R) return;
    const t = e.target.closest?.('.sr-h, .sr-pip, .sr-life');
    if (!t) return;
    if (t.classList.contains('sr-h')) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const i = clamp(Number(t.dataset.i) + (e.key === 'ArrowDown' ? 1 : -1), 0, R.parts.length - 1);
        sel = R.parts[i].name; focusKey = { h: t.dataset.h, name: sel };
        drawShelf(); drawDetail();
        const el = shelfSvg.querySelector(`.sr-h.${t.dataset.h}[data-i="${i}"]`); el?.focus({ preventScroll: false });
        return;
      }
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      focusKey = { h: t.dataset.h, name: R.parts[Number(t.dataset.i)].name };
      if (t.dataset.h === 'need') ctx.set('builds', String(e.shiftKey ? clamp(R.builds * (d > 0 ? 10 : 0.1), 1, 1e6) : nextNice(R.builds, d)));
      else ctx.set('coverage', String(clamp(Math.round((R.cov + d * (e.shiftKey ? 1 : 0.5)) * 10) / 10, 1, 100)));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    }
  });
  // rows: up/down on a focused handle moves the selection with the keyboard
  shelfSvg.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-i]');
    if (t && R) { const p = R.parts[Number(t.dataset.i)]; if (p && p.name !== sel) { sel = p.name; drawDetail(); } }
  });

  // ---------- chips ----------
  function drawChips() {
    const c = R.counts;
    const mk = (key, label, n, tone) => h('button', { type: 'button', class: `sr-chip ${tone}`, 'aria-pressed': String(filter === key), disabled: key && !n ? true : null,
      onclick: () => { filter = filter === key ? null : key; drawChips(); drawShelf(); } }, h('b', {}, String(n)), ` ${label}`);
    chips.replaceChildren(
      mk('high', 'high risk', c.high, c.high ? 'bad' : 'ok'),
      h('span', { class: `sr-chip static ${c.medium ? 'warn' : 'ok'}` }, h('b', {}, String(c.medium)), ' medium'),
      mk('single', 'single-source', c.single, c.single ? 'warn' : 'ok'),
      mk('short', 'short for this build', c.short, c.short ? 'bad' : 'ok'));
  }

  ctx.onResult((res) => {
    const raw = ctx.raw;
    if (document.activeElement !== buildsIn) buildsIn.value = raw.builds ?? '';
    if (document.activeElement !== covIn) covIn.value = raw.coverage ?? '';
    if (document.activeElement !== bomTa) bomTa.value = raw.bom ?? '';
    const b = Number(ctx.input.builds);
    if (document.activeElement !== range && b > 0) range.value = String(Math.log10(b));
    warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    warnBox.hidden = !(res.warnings || []).length;
    R = res.stock || null;
    if (!R) {
      shelfSvg.replaceChildren(); shelfSvg.setAttribute('height', '0'); detail.replaceChildren(h('div', { class: 'sr-empty' }, 'Paste a BOM with a header row to see its parts here.'));
      chips.replaceChildren(); shelfHead.textContent = 'No parts read.'; bomCard.open = true;
      return;
    }
    if (!R.parts.some((p) => p.name === sel)) sel = R.parts[0]?.name ?? null;
    drawChips(); drawShelf(); drawDetail();
  });
  let lastW = 0;
  new ResizeObserver(() => { const w = shelfScroll.clientWidth; if (R && !drag && Math.abs(w - lastW) > 2) { lastW = w; drawShelf(); } }).observe(shelfScroll);
}
