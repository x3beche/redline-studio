// LLM Cost Calculator, custom page: the monthly bill drawn as a ladder.
//   Workload - the jobs as editable rows (calls/day, tokens in/out, cached
//              share, batch), each with its share of the focus model's bill.
//   Ladder   - one stacked bar per model for the same workload, cheapest at
//              the top: input, output, cache write, cache read; the dashed
//              outline is what the same model would cost without caching.
//              Click (or Enter on) a bar to put that model in focus.
//   Strip    - drag the calls/day and output-token multipliers or the cache
//              hit rate and watch the bars move (arrows, PageUp/Down, Home).
//   Focus    - the chosen model per workload, its cache break-even.
//   Prices   - the dated price table, editable.
// Everything drawn comes from run()'s result (result.plot).

import { money } from './tool.js';

const h = (tag, attrs = {}, ...kids) => {
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
};
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v); if (text != null) el.textContent = text; return el; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SEG = [['in', 'Input'], ['out', 'Output'], ['cw', 'Cache write'], ['cr', 'Cache read']];
const int = (v) => Math.round(v).toLocaleString('en-US');

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) || 10) * p;
}

// The three sensitivity sliders: [key, label, min, max, log?, format].
const SLIDERS = [
  ['scale_calls', 'Calls/day', 0.1, 10, true, (v) => `×${v >= 1 ? +v.toFixed(2) : +v.toFixed(2)}`],
  ['scale_out', 'Output tokens', 0.25, 4, true, (v) => `×${+v.toFixed(2)}`],
  ['hit', 'Cache hit rate', 0, 100, false, (v) => `${Math.round(v)} %`],
];

export function page(root, ctx) {
  let res = null, plot = null;
  let frozenMax = 0; // the axis holds still while a slider is dragged
  const wrap = h('div', { class: 'lc' });
  root.append(wrap);

  // ---------- workload ----------
  const workBody = h('div', { class: 'lc-work', role: 'table', 'aria-label': 'Workload rows' });
  const workCard = h('section', { class: 'lc-card lc-workcard' },
    h('div', { class: 'lc-head' }, h('h2', {}, 'Workload'), h('span', { class: 'lc-sub', id: 'lc-worksub' }),
      h('button', { class: 'k-btn lc-add', onclick: () => { const w = rows('workload'); w.push({ name: `Job ${w.length + 1}`, calls: '1000', input: '2000', output: '300', cached: '0', batch: 'no' }); ctx.set('workload', w); } }, '+ Row')),
    workBody);

  // ---------- ladder ----------
  const legend = h('div', { class: 'lc-legend' },
    SEG.map(([k, t]) => h('span', {}, h('i', { class: `sw sw-${k}` }), t)),
    h('span', {}, h('i', { class: 'sw sw-nc' }), 'without caching'));
  const svg = sv('svg', { class: 'lc-svg', role: 'list', 'aria-label': 'Monthly cost per model, cheapest first' });
  const ladderSub = h('span', { class: 'lc-sub' });
  const ladderCard = h('section', { class: 'lc-card lc-ladder' },
    h('div', { class: 'lc-head' }, h('h2', {}, 'Monthly cost, same workload on each model'), ladderSub, legend),
    h('div', { class: 'lc-svgbox' }, svg),
    h('div', { class: 'lc-help' }, 'Click a bar (or Tab to it and press Enter) to put the model in focus. The dashed outline is the same model without caching; a warn mark means caching loses money at this hit rate.'));

  // ---------- sensitivity strip ----------
  const strip = h('div', { class: 'lc-strip' });
  const sliders = {};
  for (const [key, label, lo, hi, log, fmt] of SLIDERS) {
    const val = h('b', { class: 'lc-val' });
    const track = sv('svg', { class: 'lc-track' });
    const ticks = sv('g'); const marks = sv('g'); const fill = sv('rect', { class: 'lc-tfill', y: 15, height: 4, x: 8 });
    const bg = sv('rect', { class: 'lc-tbg', x: 8, y: 15, height: 4, rx: 2 });
    track.append(bg, fill, ticks, marks);
    const handle = h('div', { class: 'lc-handle', tabindex: '0', role: 'slider', 'aria-label': label, 'aria-valuemin': lo, 'aria-valuemax': hi });
    const box = h('div', { class: 'lc-trackbox' }, track, handle);
    const toX = (v) => (log ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo));
    const fromX = (f) => (log ? lo * (hi / lo) ** f : lo + f * (hi - lo));
    const snap = (v) => (log ? (Math.abs(Math.log(v)) < 0.04 ? 1 : Number(v.toPrecision(2))) : Math.round(v));
    const s = { key, label, lo, hi, log, fmt, val, track, ticks, marks, fill, bg, handle, box, toX, fromX, snap, cur: null, W: 0 };
    sliders[key] = s;
    let raf = 0, pending = null;
    const push = (v) => { pending = v; if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pending != null) ctx.set(key, pending); pending = null; }); };
    const fromEvent = (e) => { const r = box.getBoundingClientRect(); const f = clamp((e.clientX - r.left - 8) / Math.max(1, r.width - 16), 0, 1); return snap(fromX(f)); };
    box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      frozenMax = plot ? 1e-9 : 0;
      handle.focus({ preventScroll: true });
      try { box.setPointerCapture(e.pointerId); } catch { /* ended pointer */ }
      box.classList.add('drag');
      push(fromEvent(e));
      const move = (ev) => push(fromEvent(ev));
      const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); box.removeEventListener('pointercancel', up); box.classList.remove('drag'); frozenMax = 0; setTimeout(draw, 0); };
      box.addEventListener('pointermove', move); box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
    });
    box.addEventListener('dblclick', () => ctx.set(key, log ? 1 : 90));
    handle.addEventListener('keydown', (e) => {
      const v = s.cur ?? (log ? 1 : 90);
      let n = null;
      const step = log ? 1.1 : 1, big = log ? 2 : 10;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') n = log ? v * step : v + step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') n = log ? v / step : v - step;
      else if (e.key === 'PageUp') n = log ? v * big : v + big;
      else if (e.key === 'PageDown') n = log ? v / big : v - big;
      else if (e.key === 'Home') n = lo; else if (e.key === 'End') n = hi;
      else if (e.key === '0' || e.key === 'Escape') n = log ? 1 : 90;
      if (n == null) return;
      e.preventDefault();
      ctx.set(key, log ? Number(clamp(n, lo, hi).toPrecision(3)) : Math.round(clamp(n, lo, hi)));
    });
    strip.append(h('div', { class: 'lc-srow' }, h('span', { class: 'lc-slab' }, label), val, box));
  }
  const stripNote = h('div', { class: 'lc-help' });
  const stripCard = h('section', { class: 'lc-card lc-stripcard' },
    h('div', { class: 'lc-head' }, h('h2', {}, 'Sensitivity'), h('span', { class: 'lc-sub' }, 'drag, or arrows on a handle; double-click or 0 resets')), strip, stripNote);

  // ---------- side: focus, prices, notes, outputs ----------
  const focusBox = h('div', { class: 'lc-focus' });
  const focusCard = h('section', { class: 'lc-card' }, h('div', { class: 'lc-head' }, h('h2', {}, 'Model in focus'), h('span', { class: 'lc-sub', id: 'lc-fsub' })), focusBox);
  const warnBox = h('div', { class: 'lc-warns', role: 'status' });
  const priceBody = h('div', { class: 'lc-prices' });
  const priceCard = h('details', { class: 'lc-card lc-pricecard' },
    h('summary', { class: 'lc-head' }, h('h2', {}, 'Price table'), h('span', { class: 'lc-sub' }, '$ per million tokens, as of 2026-09 - verify at each provider\'s pricing page')),
    priceBody,
    h('div', { class: 'lc-pbar' },
      h('button', { class: 'k-btn', onclick: () => { const p = rows('prices'); p.push({ model: `my-model-${p.length + 1}`, provider: 'Other', in: '1', out: '4', cw: '', cr: '', batch: '0', on: 'yes' }); ctx.set('prices', p); } }, '+ Model'),
      h('button', { class: 'k-btn', onclick: () => { const d = ctx.manifest.inputs.find((x) => x.key === 'prices').default; ctx.set('prices', structuredClone(d)); } }, 'Restore dated table')));
  try { if (localStorage.getItem('redline.tool.llm-cost.prices.open') === '1') priceCard.open = true; } catch { /* storage off */ }
  priceCard.addEventListener('toggle', () => { try { localStorage.setItem('redline.tool.llm-cost.prices.open', priceCard.open ? '1' : '0'); } catch { /* storage off */ } });
  const notes = h('details', { class: 'lc-notes' }, h('summary', {}, 'Notes and assumptions'));
  const daysIn = h('input', { class: 'lc-num', type: 'text', inputmode: 'decimal', 'aria-label': 'Days per month', spellcheck: 'false',
    onchange: (e) => { const v = ctx.parseEng(e.target.value); if (v > 0) ctx.set('days', v); } });

  const main = h('div', { class: 'lc-col lc-main' }, workCard, ladderCard, stripCard);
  const side = h('div', { class: 'lc-col lc-side' }, warnBox, focusCard, priceCard, notes, h('div', { class: 'lc-out' }, ctx.outputs));
  wrap.append(main, side);

  const rows = (k) => structuredClone(ctx.raw[k] || []);

  // ---------- workload rows ----------
  const WCOLS = [['name', 'Name', 'text'], ['calls', 'Calls/day', 'num'], ['input', 'In tok', 'num'], ['output', 'Out tok', 'num'], ['cached', 'Cached %', 'num']];
  function drawWork() {
    const raw = ctx.raw.workload || [];
    const active = workBody.contains(document.activeElement) ? document.activeElement : null;
    const same = workBody.dataset.n === String(raw.length);
    if (active && same && active.tagName === 'INPUT') { updateShares(); return; }
    workBody.dataset.n = String(raw.length);
    const head = h('div', { class: 'lc-wrow lc-whead', role: 'row' }, WCOLS.map(([, t]) => h('span', { role: 'columnheader' }, t)), h('span', { role: 'columnheader' }, 'Batch'), h('span', { role: 'columnheader' }, 'Share of focus bill'), h('span'));
    const list = raw.map((r, i) => {
      const cells = WCOLS.map(([k, t, kind]) => {
        const inp = h('input', { type: 'text', class: `lc-in ${kind === 'num' ? 'lc-n' : ''}`, 'aria-label': `${t}, row ${i + 1}`, spellcheck: 'false', inputmode: kind === 'num' ? 'decimal' : null, 'data-k': `${i}:${k}` });
        inp.value = r[k] ?? '';
        let t0 = null;
        inp.addEventListener('input', () => { clearTimeout(t0); t0 = setTimeout(() => { const w = rows('workload'); if (!w[i]) return; w[i][k] = inp.value; ctx.set('workload', w); }, 250); });
        return h('span', { role: 'cell' }, inp);
      });
      const on = /^y/i.test(r.batch || '');
      const bt = h('button', { class: `lc-tog${on ? ' on' : ''}`, 'aria-pressed': String(on), title: 'Send through the provider\'s batch API (results within 24 h, discounted)', 'data-k': `${i}:batch`,
        onclick: () => { const w = rows('workload'); w[i].batch = on ? 'no' : 'yes'; ctx.set('workload', w); refocus(`${i}:batch`); } }, on ? 'batch' : 'live');
      const share = h('span', { class: 'lc-share', role: 'cell', 'data-i': i });
      const del = h('button', { class: 'k-btn k-x', 'aria-label': `Remove row ${i + 1}`, title: 'Remove row', onclick: () => { const w = rows('workload'); w.splice(i, 1); ctx.set('workload', w); } }, '×');
      return h('div', { class: 'lc-wrow', role: 'row' }, cells, h('span', { role: 'cell' }, bt), share, h('span', { role: 'cell' }, del));
    });
    workBody.replaceChildren(head, ...list);
    updateShares();
  }
  function refocus(k) { requestAnimationFrame(() => root.querySelector(`[data-k="${k}"]`)?.focus()); }
  function updateShares() {
    if (!plot) return;
    const f = plot.models.find((m) => m.id === plot.focus);
    const tot = f ? f.total : 0;
    for (const el of workBody.querySelectorAll('.lc-share')) {
      const i = Number(el.dataset.i);
      const name = (ctx.raw.workload || [])[i]?.name;
      const p = f ? f.per.find((x, j) => x.name === String(name || '').trim() || j === i) : null;
      const v = p ? p.total : 0;
      const pct = tot > 0 ? v / tot : 0;
      el.replaceChildren(h('i', { class: 'lc-sbar' }, h('i', { style: `width:${(pct * 100).toFixed(1)}%` })), h('span', {}, `${money(v)} · ${Math.round(pct * 100)} %`));
    }
    const sub = root.querySelector('#lc-worksub');
    if (sub) sub.textContent = `${int(plot.work.reduce((a, w) => a + w.calls, 0))} calls/day${plot.scale_calls !== 1 ? ` (×${plot.scale_calls} applied)` : ''} · `;
    if (sub) { sub.append('days/month '); sub.append(daysIn); if (document.activeElement !== daysIn) daysIn.value = plot.days; }
  }

  // ---------- ladder ----------
  function drawLadder() {
    svg.replaceChildren();
    const ms = plot.models;
    const W = Math.max(320, Math.round(svg.parentElement.clientWidth || 800));
    const narrow = W < 560;
    const LAB = narrow ? 118 : 178, RIGHT = narrow ? 70 : 170, TOP = 22, RH = 31, BH = 16;
    const H = TOP + ms.length * RH + 6;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    const top = Math.max(plot.max, ...ms.map((m) => (m.hasCache ? m.noCache : 0)));
    const max = frozenMax && frozenMax >= top ? frozenMax : niceMax(top);
    if (frozenMax) frozenMax = max;
    const X = (v) => LAB + (v / max) * (W - LAB - RIGHT);
    for (let k = 0; k <= 4; k++) {
      const v = (max * k) / 4, x = X(v);
      svg.append(sv('line', { x1: x, x2: x, y1: TOP - 4, y2: H - 4, class: 'lc-grid' }));
      if (!narrow || k % 2 === 0) svg.append(sv('text', { x, y: 12, class: 'lc-ax', 'text-anchor': k === 0 ? 'start' : 'middle' }, money(v)));
    }
    ms.forEach((m, i) => {
      const y = TOP + i * RH;
      const g = sv('g', { class: `lc-row${m.id === plot.focus ? ' on' : ''}${m.losing ? ' losing' : ''}`, tabindex: '0', role: 'listitem', 'data-id': m.id,
        'aria-label': `${i + 1}. ${m.id}: ${money(m.total)} a month, ${money(m.perCall)} per call. Input ${money(m.in)}, output ${money(m.out)}, cache write ${money(m.cw)}, cache read ${money(m.cr)}.` });
      g.append(sv('rect', { x: 0, y: y - 2, width: W, height: RH - 2, class: 'lc-hit' }));
      g.append(sv('text', { x: 4, y: y + BH / 2 + 4, class: 'lc-rank' }, String(i + 1)));
      const lim = narrow ? 14 : 22;
      const name = m.id.length > lim ? m.id.slice(0, lim - 1) + '…' : m.id;
      g.append(sv('text', { x: 20, y: y + 8, class: 'lc-name' }, name));
      g.append(sv('text', { x: 20, y: y + 20, class: 'lc-prov' }, m.provider));
      if (m.hasCache && m.noCache > m.total + 1e-9) g.append(sv('rect', { x: X(0), y: y - 1, width: Math.max(0, X(m.noCache) - X(0)), height: BH + 2, class: 'lc-nc', rx: 2 }));
      let x0 = X(0);
      for (const [k, t] of SEG) {
        const w = X(m[k]) - X(0);
        if (w <= 0.2) continue;
        const r = sv('rect', { x: x0, y, width: w, height: BH, class: `lc-seg seg-${k}` });
        r.append(sv('title', {}, `${m.id} ${t}: ${money(m[k])}/month`));
        g.append(r);
        if (w > 44 && !narrow) g.append(sv('text', { x: x0 + w / 2, y: y + BH / 2 + 4, class: 'lc-segt', 'text-anchor': 'middle' }, money(m[k])));
        x0 += w;
      }
      const xt = Math.min(X(Math.max(m.total, m.hasCache ? m.noCache : 0)) + 6, W - RIGHT + 4);
      g.append(sv('text', { x: xt, y: y + BH / 2 + 4, class: 'lc-tot' }, money(m.total)));
      if (!narrow) {
        const rel = plot.cheapest > 0 ? m.total / plot.cheapest : 1;
        const be = m.breakEven == null ? 'no cache' : m.breakEven > 0 ? `cache pays >${Math.ceil(m.breakEven * 100)} %` : 'cache: no premium';
        g.append(sv('text', { x: W - 4, y: y + BH / 2 + 4, class: `lc-rel${m.losing ? ' bad' : ''}`, 'text-anchor': 'end' }, `${rel < 1.005 ? 'cheapest' : `×${rel.toFixed(rel < 10 ? 2 : 1)}`} · ${be}`));
      } else if (m.losing) g.append(sv('text', { x: W - 4, y: y + 8, class: 'lc-rel bad', 'text-anchor': 'end' }, 'cache loses'));
      const pick = () => { if (m.id !== plot.focus) ctx.set('focus', m.id); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const rs = [...svg.querySelectorAll('.lc-row')]; rs[clamp(rs.indexOf(g) + (e.key === 'ArrowDown' ? 1 : -1), 0, rs.length - 1)]?.focus(); }
      });
      svg.append(g);
    });
    ladderSub.textContent = ms.length ? `${ms.length} models · ${int(plot.work.reduce((a, w) => a + w.calls, 0) * plot.days)} calls/month` : 'no models to compare';
  }

  // ---------- strip ----------
  function drawStrip() {
    const f = plot.models.find((m) => m.id === plot.focus);
    for (const s of Object.values(sliders)) {
      const v = s.key === 'hit' ? plot.hit : plot[s.key];
      s.cur = v;
      const W = Math.max(60, s.box.clientWidth || 300), L = W - 16;
      const X = (f) => 8 + f * L;
      s.track.setAttribute('viewBox', `0 0 ${W} 38`);
      s.bg.setAttribute('width', L);
      if (s.W !== W) {
        s.W = W;
        s.ticks.replaceChildren();
        const tv = s.log ? [0.1, 0.25, 0.5, 1, 2, 4, 10].filter((t) => t >= s.lo && t <= s.hi) : [0, 20, 40, 60, 80, 100];
        for (const t of tv) {
          const x = X(s.toX(t));
          s.ticks.append(sv('line', { x1: x, x2: x, y1: 21, y2: 25, class: 'lc-tick' }));
          s.ticks.append(sv('text', { x, y: 35, class: 'lc-tlab', 'text-anchor': t === tv[0] ? 'start' : t === tv[tv.length - 1] ? 'end' : 'middle' }, s.log ? `×${t}` : `${t}`));
        }
      }
      const fx = clamp(s.toX(clamp(v, s.lo, s.hi)), 0, 1);
      s.handle.style.left = `${X(fx)}px`;
      s.fill.setAttribute('width', (fx * L).toFixed(1));
      s.val.textContent = s.fmt(v);
      s.handle.setAttribute('aria-valuenow', String(v));
      s.handle.setAttribute('aria-valuetext', s.fmt(v));
      s.marks.replaceChildren();
      if (s.key === 'hit') {
        // Break-even marks: where caching starts to pay, per model with a premium.
        const seen = new Set();
        for (const m of plot.models) {
          if (!(m.breakEven > 0)) continue;
          const pct = Math.ceil(m.breakEven * 100);
          const x = X(pct / 100);
          const isF = m.id === plot.focus;
          s.marks.append(sv('line', { x1: x, x2: x, y1: 8, y2: 26, class: `lc-be${isF ? ' on' : ''}` }));
          if (isF || !seen.has(pct)) s.marks.append(sv('text', { x: pct > 60 ? x - 3 : x + 3, y: 9, class: `lc-bet${isF ? ' on' : ''}`, 'text-anchor': pct > 60 ? 'end' : 'start' }, isF ? `${m.id} pays >${pct} %` : ''));
          seen.add(pct);
        }
      }
    }
    stripNote.textContent = f ? `${f.id}: ${money(f.total)} a month at ×${plot.scale_calls} calls, ×${plot.scale_out} output, ${plot.hit} % cache hits.` : '';
  }

  // ---------- focus ----------
  function drawFocus() {
    const f = plot.models.find((m) => m.id === plot.focus);
    root.querySelector('#lc-fsub').textContent = f ? f.provider : '';
    if (!f) { focusBox.replaceChildren(h('div', { class: 'lc-sub' }, 'No model to show.')); return; }
    const tot = f.total || 1;
    const stack = h('div', { class: 'lc-fstack' }, SEG.map(([k, t]) => (f[k] > 0 ? h('i', { class: `seg-${k}`, style: `flex:${f[k] / tot}`, title: `${t}: ${money(f[k])}` }) : null)));
    const segs = h('div', { class: 'lc-fsegs' }, SEG.map(([k, t]) => h('div', {}, h('i', { class: `sw sw-${k}` }), h('span', {}, t), h('b', {}, money(f[k])), h('em', {}, `${Math.round((f[k] / tot) * 100)} %`))));
    const perMax = Math.max(...f.per.map((p) => p.total), 1e-9);
    const per = h('div', { class: 'lc-fper' }, f.per.map((p) => h('div', {}, h('span', {}, p.name), h('i', { class: 'lc-sbar' }, h('i', { style: `width:${((p.total / perMax) * 100).toFixed(1)}%` })), h('b', {}, money(p.total)))));
    const be = f.breakEven == null ? 'This model has no cache price in the table: the cached share is billed as input.'
      : f.breakEven > 0 ? `Caching pays above ${Math.ceil(f.breakEven * 100)} % hits: each miss pays the write premium, each hit the read price. At ${plot.hit} % it ${f.losing ? 'loses' : 'saves'} ${money(Math.abs(f.noCache - f.total))} a month.`
        : `No cache-write premium: any hit saves. At ${plot.hit} % it saves ${money(f.noCache - f.total)} a month.`;
    focusBox.replaceChildren(
      h('div', { class: 'lc-fbig' }, h('b', {}, money(f.total)), h('span', {}, ' per month'), h('em', {}, `${money(f.perCall)} per call`)),
      stack, segs, h('div', { class: `lc-fbe${f.losing ? ' bad' : ''}` }, be), h('div', { class: 'lc-ftitle' }, 'Per workload'), per);
  }

  // ---------- prices ----------
  const PCOLS = [['model', 'Model', 'text'], ['provider', 'Provider', 'text'], ['in', 'In', 'num'], ['out', 'Out', 'num'], ['cw', 'Write', 'num'], ['cr', 'Read', 'num'], ['batch', 'Batch -%', 'num']];
  function drawPrices() {
    const raw = ctx.raw.prices || [];
    if (priceBody.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && priceBody.dataset.n === String(raw.length)) return;
    priceBody.dataset.n = String(raw.length);
    const head = h('div', { class: 'lc-prow lc-phead' }, h('span', {}, ''), PCOLS.map(([, t]) => h('span', {}, t)), h('span'));
    const list = raw.map((r, i) => {
      const on = !/^n/i.test(r.on || 'yes');
      const cb = h('input', { type: 'checkbox', checked: on, 'aria-label': `Compare ${r.model}`, 'data-k': `p${i}:on`,
        onchange: () => { const p = rows('prices'); p[i].on = cb.checked ? 'yes' : 'no'; ctx.set('prices', p); refocus(`p${i}:on`); } });
      const cells = PCOLS.map(([k, t, kind]) => {
        const inp = h('input', { type: 'text', class: `lc-in${kind === 'num' ? ' lc-n' : ''}`, 'aria-label': `${t} for ${r.model}`, spellcheck: 'false', placeholder: kind === 'num' ? '–' : '' });
        inp.value = r[k] ?? '';
        let t0 = null;
        inp.addEventListener('input', () => { clearTimeout(t0); t0 = setTimeout(() => { const p = rows('prices'); if (!p[i]) return; p[i][k] = inp.value; ctx.set('prices', p); }, 300); });
        return inp;
      });
      const del = h('button', { class: 'k-btn k-x', 'aria-label': `Remove ${r.model}`, onclick: () => { const p = rows('prices'); p.splice(i, 1); ctx.set('prices', p); } }, '×');
      return h('div', { class: `lc-prow${on ? '' : ' off'}` }, cb, cells, del);
    });
    priceBody.replaceChildren(head, ...list);
  }

  function draw() {
    if (!res || !plot) return;
    drawWork(); drawLadder(); drawStrip(); drawFocus(); drawPrices();
    const w = res.warnings || [];
    warnBox.replaceChildren(...w.map((t) => h('div', {}, t)));
    warnBox.hidden = !w.length;
    notes.replaceChildren(h('summary', {}, 'Notes and assumptions'), ...(res.notes || []).map((t) => h('p', {}, t)));
  }
  ctx.onResult((r) => { res = r; plot = r.plot || null; draw(); });
  let rw = 0;
  new ResizeObserver(() => { const w = svg.parentElement.clientWidth; if (Math.abs(w - rw) > 4) { rw = w; if (plot) { drawLadder(); drawStrip(); } } }).observe(svg.parentElement);
}
