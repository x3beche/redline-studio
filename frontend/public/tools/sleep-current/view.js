// Sleep Current Profiler: the page is the current trace of one wake-up.
//   Trace   - what a current probe would show: the wake-up burst, state after
//             state, on a log current axis, then the long sleep (the time axis
//             breaks to fit it). Each state is a block: drag its top for the
//             current, its right edge for the time. Drag the sleep floor for
//             the sleep current. The average current is the dashed line that
//             sits between them. A state that runs only every Nth wake-up is
//             hatched and marked "1 in N".
//   Wakes   - the next wake-ups in a row, so "every N" is visible as the
//             bursts that carry that state; click a burst's state to change N.
//   States  - the same states as a list, for names and exact values.
//   Period  - the average current against the wake-up period (log-log):
//             drag the point along the curve to change the period.
//   Budget  - where the charge goes, as one bar split by state.
// Every number shown comes from run()'s result.drawing and result.values.
import { fmtEng } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const L10 = Math.log10;
// A value as the table wants it: 2 significant figures, SI prefix, no space.
const eng = (v, d = 2) => fmtEng(v, '', d).replace(/\s+/g, '');
const E = (v, u, d = 3) => fmtEng(v, u, d);

const CSS = `
.sc { --tool-c0: #d97706; --tool-c1: #0f9d8a; --tool-c2: #a23fbf; --tool-c3: #1f4ed8; --tool-c4: #c2410c; --tool-c5: #4d7c0f;
  --tool-sleep: #5b6b7a; --tool-avg: #16202a; }
:root[data-theme="dark"] .sc { --tool-c0: #f0a33a; --tool-c1: #3cc7b3; --tool-c2: #c982e0; --tool-c3: #6d8dff; --tool-c4: #f28c5b; --tool-c5: #9ccc65;
  --tool-sleep: #8ea0b0; --tool-avg: #e4ebf1; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .sc { --tool-c0: #f0a33a; --tool-c1: #3cc7b3; --tool-c2: #c982e0; --tool-c3: #6d8dff;
  --tool-c4: #f28c5b; --tool-c5: #9ccc65; --tool-sleep: #8ea0b0; --tool-avg: #e4ebf1; } }
.sc { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 0.9fr); grid-template-areas: "trace trace trace" "states period budget" "out out out";
  gap: 12px; align-items: start; }
@media (max-width: 1180px) { .sc { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "trace trace" "states states" "period budget" "out out"; } }
@media (max-width: 700px) { .sc { grid-template-columns: minmax(0, 1fr); grid-template-areas: "trace" "budget" "states" "period" "out"; } }
.sc-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.sc-trace { grid-area: trace; } .sc-states { grid-area: states; } .sc-period { grid-area: period; } .sc-budget { grid-area: budget; }
.sc-out { grid-area: out; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.sc-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.sc-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.sc-sub { font-size: 11.5px; color: var(--ink-soft); }
.sc-sub b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.sc-grow { flex: 1; }
.sc-f { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-soft); white-space: nowrap; }
.sc input, .sc select { padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink);
  font: 12px "IBM Plex Mono", ui-monospace, monospace; min-width: 0; }
.sc input.bad { border-color: var(--danger); }
.sc-f input { width: 58px; }
.sc-svg { display: block; width: 100%; user-select: none; -webkit-user-select: none; touch-action: none; }
.sc-svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.sc-svg text.soft { fill: var(--ink-soft); }
.sc-svg text.sm { font-size: 10px; }
.sc-svg text.b { font-weight: 600; }
.sc-svg .hd:focus { outline: none; }
.sc-svg .hd:focus-visible .ring { stroke: var(--accent); stroke-width: 2.5; stroke-dasharray: 3 2; }
.sc-svg .ns { cursor: ns-resize; } .sc-svg .ew { cursor: ew-resize; } .sc-svg .mv { cursor: grab; }
.sc-help { padding: 3px 10px 8px; font-size: 11px; color: var(--ink-soft); }
.sc-help kbd { font: 10px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.sc-list { width: 100%; border-collapse: collapse; font-size: 12px; }
.sc-list th { text-align: left; font-weight: 500; font-size: 11px; color: var(--ink-soft); padding: 5px 4px 3px; }
.sc-list th:first-child, .sc-list td:first-child { padding-left: 10px; }
.sc-list td { padding: 2px 4px; border-top: 1px solid var(--line-soft); vertical-align: middle; }
.sc-list td.num { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); text-align: right; white-space: nowrap; }
.sc-list input { width: 100%; }
.sc-list .nm { min-width: 90px; }
@media (max-width: 560px) { .sc-list th:nth-child(6), .sc-list td:nth-child(6) { display: none; } .sc-list .nm { min-width: 0; } .sc-list input { width: 100% !important; } }
.sc-list i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; }
.sc-list tr.on td { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.sc-list .sleep td { color: var(--ink-soft); }
.sc-x { border: 0; background: transparent; color: var(--ink-soft); cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 3px; }
.sc-x:hover { color: var(--danger); background: var(--sunken); }
.sc-add { margin: 6px 10px 9px; }
.sc-figs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line-soft); border-top: 1px solid var(--line-soft); }
.sc-fig { background: var(--surface); padding: 6px 10px; min-width: 0; }
.sc-fig span { display: block; font-size: 10.5px; color: var(--ink-soft); }
.sc-fig b { display: block; font: 500 15px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-fig b small { font-size: 11px; color: var(--ink-soft); font-weight: 400; }
.sc-fig em { display: block; font-style: normal; font-size: 10.5px; color: var(--ink-soft); }
.sc-fig.main { grid-column: span 2; }
.sc-fig.main b { font-size: 24px; font-weight: 600; }
.sc-fig.warn b { color: var(--warn); }
.sc-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.sc-warns div + div { margin-top: 3px; }
.sc-warns:empty { display: none; }
.sc-notes { font-size: 11.5px; color: var(--ink-soft); }
.sc-notes summary { cursor: pointer; }
.sc-notes div { margin-top: 3px; }
.sc .k-out { max-height: 240px; }
`;

const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const snapNice = (v) => {
  const p = 10 ** Math.floor(L10(v));
  let best = p, err = Infinity;
  for (const m of [...NICE, 10]) { const e = Math.abs(L10(m * p) - L10(v)); if (e < err) { err = e; best = m * p; } }
  return Number(best.toPrecision(3));
};
const snap2 = (v) => Number(v.toPrecision(2));

export function page(root, ctx) {
  const f = ctx.fmtNum;
  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'sc' });
  root.append(wrap);
  const col = (k) => `var(--tool-c${k % 6})`;
  let sel = null;           // the state row (table index) last touched
  let res = null;
  let frozen = null;        // axes kept still while dragging

  // ---------- inputs that are not on the drawing ----------
  const fields = {};
  const field = (key, label, unit, w) => {
    const el = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label} (${unit})`, style: w ? `width:${w}px` : null,
      oninput: (e) => ctx.set(key, e.target.value) });
    fields[key] = el;
    return h('label', { class: 'sc-f' }, label, el, unit);
  };

  // ---------- trace ----------
  const traceSub = h('span', { class: 'sc-sub' });
  const trace = s('svg', { class: 'sc-svg', role: 'group', 'aria-label': 'Current against time for one wake-up period' });
  const wakes = s('svg', { class: 'sc-svg', role: 'group', 'aria-label': 'The next wake-ups, with the states each one runs' });
  const traceCard = h('section', { class: 'sc-card sc-trace' },
    h('div', { class: 'sc-head' }, h('h2', {}, 'Current trace, one wake-up'), traceSub, h('span', { class: 'sc-grow' }),
      field('period', 'Period', 's', 52), field('isleep', 'Sleep', 'A', 52), field('vbat', 'Supply', 'V', 40)),
    trace,
    wakes,
    h('div', { class: 'sc-help' }, 'Drag a state\'s top for its current, its right edge for its time; drag the sleep floor for the sleep current. Focus a state and use ',
      h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' current, ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' time (', h('kbd', {}, 'Shift'), ' larger steps). Click a state in a wake-up below to run it more or less often.'));

  // ---------- states list ----------
  const listBody = h('tbody');
  const statesCard = h('section', { class: 'sc-card sc-states' },
    h('div', { class: 'sc-head' }, h('h2', {}, 'States'), h('span', { class: 'sc-sub' }, 'in the order they run')),
    h('div', { style: 'overflow-x:auto' }, h('table', { class: 'sc-list' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'State'), h('th', {}, 'Current'), h('th', {}, 'Time'), h('th', {}, 'Every'), h('th', { style: 'text-align:right' }, 'Adds'), h('th', {}, ''))),
      listBody)),
    h('button', { class: 'k-btn sc-add', type: 'button', onclick: () => {
      const st = states();
      st.push({ name: `State ${st.length + 1}`, i: '1m', t: '1m', every: '1' });
      sel = st.length - 1;
      ctx.set('states', st);
    } }, '+ Add state'));

  // ---------- period ----------
  const periodSub = h('span', { class: 'sc-sub' });
  const curve = s('svg', { class: 'sc-svg', role: 'group', 'aria-label': 'Average current against the wake-up period' });
  const periodCard = h('section', { class: 'sc-card sc-period' },
    h('div', { class: 'sc-head' }, h('h2', {}, 'Wake-up period'), periodSub),
    curve,
    h('div', { class: 'sc-help' }, 'Drag the point along the curve, or focus it and use ', h('kbd', {}, '←'), h('kbd', {}, '→'), '.'));

  // ---------- budget ----------
  const bar = s('svg', { class: 'sc-svg', role: 'img', 'aria-label': 'Share of the charge per state' });
  const figs = h('div', { class: 'sc-figs' });
  const budgetCard = h('section', { class: 'sc-card sc-budget' },
    h('div', { class: 'sc-head' }, h('h2', {}, 'Where the charge goes')), bar, figs);

  const warns = h('div', { class: 'sc-warns', role: 'status' });
  const notes = h('details', { class: 'sc-notes' });
  wrap.append(traceCard, statesCard, periodCard, budgetCard, h('div', { class: 'sc-out' }, warns, ctx.outputs, notes));

  const states = () => structuredClone(Array.isArray(ctx.raw.states) ? ctx.raw.states : []);
  const setRow = (idx, patch) => { const st = states(); if (!st[idx]) return; Object.assign(st[idx], patch); sel = idx; ctx.set('states', st); };

  const onDrag = (move, done) => {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      frozen = null;
      done && done();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const toSvg = (svg, ev, W) => {
    const r = svg.getBoundingClientRect();
    const k = W / r.width;
    return [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k];
  };
  const keepFocus = (svg, draw) => {
    const id = svg.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    svg.replaceChildren();
    draw();
    if (id) svg.querySelector(`[data-id="${id}"]`)?.focus({ preventScroll: true });
  };
  // Hatch for states that do not run every wake-up.
  const defs = (svg) => {
    const d = s('defs');
    for (let k = 0; k < 6; k++) {
      const p = s('pattern', { id: `sc-h${k}-${svg.dataset.n}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      p.append(s('rect', { width: 6, height: 6, fill: col(k), 'fill-opacity': 0.12 }));
      p.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: col(k), 'stroke-width': 2.2, 'stroke-opacity': 0.55 }));
      d.append(p);
    }
    svg.append(d);
  };
  trace.dataset.n = 't'; wakes.dataset.n = 'w';

  // ---------- the trace ----------
  function drawTrace() { keepFocus(trace, drawTraceInner); }
  function drawTraceInner() {
    const d = res && res.drawing;
    const W = Math.max(300, trace.clientWidth || traceCard.clientWidth || 900);
    const narrow = W < 620;
    const H = narrow ? 300 : 330;
    trace.setAttribute('viewBox', `0 0 ${W} ${H}`);
    trace.setAttribute('height', H);
    if (!d) { traceSub.textContent = ''; trace.setAttribute('height', 60); trace.setAttribute('viewBox', `0 0 ${W} 60`); trace.append(s('text', { x: 14, y: 34, class: 'soft' }, 'Nothing to draw: see the message below.')); return; }
    defs(trace);
    const Lm = narrow ? 46 : 58, Rm = 12, Tm = 16, Bm = 34;
    const parts = d.parts;
    // Current axis: log, whole decades around everything drawn.
    const geo = frozen?.trace || (() => {
      const lo = Math.min(d.isleep > 0 ? d.isleep : 1e-7, d.iavg || 1, ...parts.map((p) => p.i || 1));
      const hi = Math.max(d.isleep, ...parts.map((p) => p.i), 1e-6);
      const burst = Math.max(d.tWorst, 1e-4) * 1.18;
      return { y0: 10 ** Math.floor(L10(lo) - 0.35), y1: 10 ** Math.ceil(L10(hi) + 0.35), burst };
    })();
    const { y0, y1, burst } = geo;
    const Y = (i) => Tm + (1 - (L10(clamp(i, y0, y1)) - L10(y0)) / (L10(y1) - L10(y0))) * (H - Tm - Bm);
    const Yinv = (y) => 10 ** (L10(y0) + (1 - (y - Tm) / (H - Tm - Bm)) * (L10(y1) - L10(y0)));
    // Time axis: the burst linear over most of the width, a break, then the sleep.
    const xB0 = Lm, xB1 = Lm + (W - Lm - Rm) * (narrow ? 0.7 : 0.76), xS0 = xB1 + 18, xS1 = W - Rm;
    const X = (t) => xB0 + (t / burst) * (xB1 - xB0);
    const Xinv = (x) => ((x - xB0) / (xB1 - xB0)) * burst;
    const yBase = H - Bm;
    // Decade grid.
    for (let e = Math.round(L10(y0)); e <= Math.round(L10(y1)); e++) {
      const y = Y(10 ** e);
      trace.append(s('line', { x1: Lm, x2: W - Rm, y1: y, y2: y, stroke: 'var(--line-soft)' }));
      trace.append(s('text', { x: Lm - 5, y: y + 3.5, 'text-anchor': 'end', class: 'soft sm' }, E(10 ** e, 'A', 1)));
    }
    // Time ticks in the burst.
    const unit = burst >= 1 ? [1, 's'] : burst >= 1e-3 ? [1e-3, 'ms'] : [1e-6, 'µs'];
    const raw = burst / Math.max(2, Math.floor((xB1 - xB0) / 80));
    const p10 = 10 ** Math.floor(L10(raw));
    const step = [1, 2, 5, 10].map((m) => m * p10).find((v) => v >= raw);
    for (let t = 0; t <= burst + 1e-12; t += step) {
      const x = X(t);
      trace.append(s('line', { x1: x, x2: x, y1: yBase, y2: yBase + 4, stroke: 'var(--ink-soft)' }));
      trace.append(s('text', { x, y: yBase + 15, 'text-anchor': 'middle', class: 'soft sm' }, `${f(t / unit[0], 3)}${t === 0 ? '' : ''}`));
    }
    trace.append(s('text', { x: xB1, y: yBase + 28, 'text-anchor': 'end', class: 'soft sm' }, `${unit[1]} after wake-up`));
    trace.append(s('line', { x1: Lm, x2: W - Rm, y1: yBase, y2: yBase, stroke: 'var(--line)' }));
    // The axis break.
    trace.append(s('rect', { x: xB1 + 3, y: Tm - 4, width: 12, height: yBase - Tm + 12, fill: 'var(--surface)' }));
    for (const dx of [4, 12]) trace.append(s('path', { d: `M${xB1 + dx - 3},${yBase + 6}l6,-12`, stroke: 'var(--ink-soft)' }));

    // Sleep floor across everything, including under the burst after the states.
    const tEnd = parts.reduce((a, p) => a + p.t, 0);
    const yS = Y(d.isleep > 0 ? d.isleep : y0);
    trace.append(s('rect', { x: X(tEnd), y: yS, width: xB1 - X(tEnd), height: yBase - yS, fill: 'var(--tool-sleep)', 'fill-opacity': 0.14 }));
    trace.append(s('rect', { x: xS0, y: yS, width: xS1 - xS0, height: yBase - yS, fill: 'var(--tool-sleep)', 'fill-opacity': 0.14 }));
    // The states.
    let t0 = 0;
    let lastLab = { x: -1, y: 1e9 };
    const pos = [];
    parts.reduce((t, p) => { pos.push({ xa: X(t), xb: X(t + p.t), yt: Y(p.i) }); return t + p.t; }, 0);
    const ghost = frozen?.ghost;
    parts.forEach((p, k) => {
      const xa = X(t0), xb = X(t0 + p.t), yt = Y(p.i);
      const on = sel === p.idx;
      const g = s('g', { class: 'hd', tabindex: 0, 'data-id': `st${p.idx}`, role: 'group',
        'aria-label': `${p.name}: ${E(p.i, 'A')} for ${E(p.t, 's')}${p.n > 1 ? `, 1 in ${p.n} wake-ups` : ''}. Up and down change the current, left and right the time.` });
      g.append(s('rect', { class: 'ring', x: xa, y: yt, width: Math.max(1, xb - xa), height: yBase - yt,
        fill: p.n > 1 ? `url(#sc-h${k % 6}-t)` : col(k), 'fill-opacity': p.n > 1 ? 1 : on ? 0.34 : 0.22, stroke: col(k), 'stroke-width': on ? 2 : 1.2 }));
      g.append(s('title', {}, `${p.name}: ${E(p.i, 'A')} × ${E(p.t, 's')} = ${E(p.i * p.t, 'C')}${p.n > 1 ? ` once every ${p.n} wake-ups` : ''}`));
      // Labels inside when there is room, else above.
      const w = xb - xa;
      const l1 = p.name, l2 = `${E(p.i, 'A')} · ${E(p.t, 's')}`, l3 = p.n > 1 ? `1 in ${p.n} · ${E(p.q, 'C')}/wake` : `${E(p.q, 'C')}`;
      const fits = w > Math.max(l1.length, l2.length) * 6.4 + 10 && yBase - yt > 44;
      if (fits) {
        g.append(s('text', { x: xa + 6, y: yt + 15, class: 'b', style: `fill:${col(k)}` }, l1));
        g.append(s('text', { x: xa + 6, y: yt + 28, class: 'sm' }, l2));
        g.append(s('text', { x: xa + 6, y: yt + 40, class: 'sm soft' }, l3));
      } else {
        // Above the block, lifted clear of the label before it.
        const nm = l1.length > 16 ? `${l1.slice(0, 15)}…` : l1;
        const tw = Math.max(nm.length, l2.length) * 6.3;
        let lx = Math.max(Lm + 2, (xa + xb) / 2 - tw / 2);
        const over = pos.filter((q) => q.xb > lx && q.xa < lx + tw).map((q) => q.yt);
        let ly = Math.min(yt, ...over) - 20;
        if (lx < lastLab.x && ly + 26 > lastLab.y - 12) ly = Math.min(ly, lastLab.y - 30);
        if (ly < Tm + 4) { ly = Tm + 4; lx = Math.max(lx, lastLab.x); }
        g.append(s('text', { x: lx, y: ly, class: 'b', style: `fill:${col(k)}` }, nm));
        g.append(s('text', { x: lx, y: ly + 12, class: 'sm' }, l2));
        lastLab = { x: lx + tw + 6, y: ly };
      }
      // Grips: top edge (current), right edge (time).
      const top = s('rect', { class: 'ns', x: xa, y: yt - 5, width: Math.max(6, w), height: 10, fill: 'transparent' });
      const right = s('rect', { class: 'ew', x: xb - 5, y: yt, width: 10, height: yBase - yt, fill: 'transparent' });
      g.append(s('line', { x1: xa, x2: xb, y1: yt, y2: yt, stroke: col(k), 'stroke-width': 3, 'pointer-events': 'none' }));
      if (w > 14) g.append(s('path', { d: `M${xb - 2.5},${(yt + yBase) / 2 - 6}v12M${xb + 0.5},${(yt + yBase) / 2 - 6}v12`, stroke: col(k), 'stroke-width': 1, 'pointer-events': 'none' }));
      g.append(top, right);
      const start = (kind) => (e) => {
        e.preventDefault(); e.stopPropagation(); g.focus({ preventScroll: true });
        sel = p.idx;
        frozen = { trace: geo };
        const tStart = t0;
        onDrag((ev) => {
          const [x, y] = toSvg(trace, ev, W);
          if (kind === 'i') setRow(p.idx, { i: eng(snap2(clamp(Yinv(y), y0, y1))) });
          else setRow(p.idx, { t: eng(snap2(Math.max(burst / 400, Xinv(x) - tStart))) });
        }, () => { drawAll(); });
      };
      top.addEventListener('pointerdown', start('i'));
      right.addEventListener('pointerdown', start('t'));
      g.addEventListener('pointerdown', () => { if (sel !== p.idx) { sel = p.idx; drawList(); } });
      g.addEventListener('keydown', (e) => {
        const big = e.shiftKey;
        let patch = null;
        if (e.key === 'ArrowUp') patch = { i: eng(snap2(p.i * (big ? 2 : 1.1))) };
        if (e.key === 'ArrowDown') patch = { i: eng(snap2(p.i / (big ? 2 : 1.1))) };
        if (e.key === 'ArrowRight') patch = { t: eng(snap2(p.t * (big ? 2 : 1.1))) };
        if (e.key === 'ArrowLeft') patch = { t: eng(snap2(p.t / (big ? 2 : 1.1))) };
        if (!patch) return;
        e.preventDefault();
        setRow(p.idx, patch);
      });
      trace.append(g);
      t0 += p.t;
    });
    if (ghost) trace.append(ghost);

    // Sleep floor handle.
    const sl = s('g', { class: 'hd ns', tabindex: 0, 'data-id': 'sleep', role: 'slider', 'aria-label': 'Sleep current', 'aria-valuetext': E(d.isleep, 'A') });
    sl.append(s('rect', { x: X(tEnd), y: yS - 6, width: xS1 - X(tEnd), height: 12, fill: 'transparent' }));
    sl.append(s('line', { class: 'ring', x1: X(tEnd), x2: xB1, y1: yS, y2: yS, stroke: 'var(--tool-sleep)', 'stroke-width': 2.5 }));
    sl.append(s('line', { x1: xS0, x2: xS1, y1: yS, y2: yS, stroke: 'var(--tool-sleep)', 'stroke-width': 2.5 }));
    const sLab = `sleep ${E(d.isleep, 'A')} for ${E(d.tSleep, 's')}`;
    const sx = (xS0 + xS1) / 2;
    const sLy = yS + 15 < yBase - 2 ? yS + 15 : yS - 7;
    sl.append(s('text', { x: sx, y: sLy, 'text-anchor': 'middle', class: 'b sm', style: 'fill:var(--tool-sleep)' }, narrow ? E(d.isleep, 'A') : sLab));
    trace.append(sl);
    sl.addEventListener('pointerdown', (e) => {
      e.preventDefault(); sl.focus({ preventScroll: true });
      frozen = { trace: geo };
      onDrag((ev) => { const [, y] = toSvg(trace, ev, W); ctx.set('isleep', eng(snap2(clamp(Yinv(y), y0, y1)))); }, drawAll);
    });
    sl.addEventListener('keydown', (e) => {
      const m = e.key === 'ArrowUp' ? (e.shiftKey ? 2 : 1.1) : e.key === 'ArrowDown' ? 1 / (e.shiftKey ? 2 : 1.1) : 0;
      if (!m) return;
      e.preventDefault();
      ctx.set('isleep', eng(snap2(d.isleep * m)));
    });
    // Next wake-up at the far end.
    trace.append(s('line', { x1: xS1, x2: xS1, y1: Tm, y2: yBase + 4, stroke: 'var(--ink-soft)', 'stroke-dasharray': '2 3' }));
    trace.append(s('text', { x: xS1, y: yBase + 15, 'text-anchor': 'end', class: 'soft sm' }, `${E(d.period, 's')}`));
    trace.append(s('text', { x: xS0, y: yBase + 15, 'text-anchor': 'start', class: 'soft sm' }, 'sleep'));
    if (!narrow) trace.append(s('text', { x: xS1, y: yBase + 28, 'text-anchor': 'end', class: 'soft sm' }, 'next wake-up'));

    // The average: a line across the whole period.
    const yA = Y(d.iavg);
    trace.append(s('line', { x1: Lm, x2: xS1, y1: yA, y2: yA, stroke: 'var(--tool-avg)', 'stroke-width': 1.5, 'stroke-dasharray': '7 4', 'pointer-events': 'none' }));
    const aLab = `average ${E(d.iavg, 'A')}`;
    trace.append(s('rect', { x: xS1 - aLab.length * 7 - 8, y: yA - 17, width: aLab.length * 7 + 8, height: 15, rx: 3, fill: 'var(--surface)', 'fill-opacity': 0.9 }));
    trace.append(s('text', { x: xS1 - 4, y: yA - 6, 'text-anchor': 'end', class: 'b' }, aLab));
    if (d.tWorst > d.period) {
      trace.append(s('text', { x: xB1 - 4, y: Tm + 12, 'text-anchor': 'end', class: 'b', style: 'fill:var(--danger)' }, `the states take ${E(d.tWorst, 's')}: longer than the ${E(d.period, 's')} period`));
    }
    traceSub.replaceChildren('awake ', h('b', {}, `${f(d.duty * 100, 3)} %`), ' of the time · average ', h('b', {}, E(d.iavg, 'A')));
  }

  // ---------- the wake-ups row ----------
  function drawWakes() { keepFocus(wakes, drawWakesInner); }
  function drawWakesInner() {
    const d = res && res.drawing;
    const W = Math.max(300, wakes.clientWidth || traceCard.clientWidth || 900);
    if (!d || !d.parts.length) { wakes.setAttribute('height', 0); return; }
    defs(wakes);
    const nMax = Math.max(1, ...d.parts.map((p) => p.n));
    // Enough wake-ups to show every state's rhythm, at most 24.
    const lcm = d.parts.reduce((a, p) => { const g = (x, y) => (y ? g(y, x % y) : x); const n = Math.round(p.n); return Math.min(240, (a * n) / g(a, n)); }, 1);
    const count = clamp(Math.max(nMax, Math.min(lcm, 12)), 4, W < 620 ? 8 : 16);
    const Lm = W < 620 ? 46 : 58, Rm = 12;
    const cw = (W - Lm - Rm) / count, rh = 12;
    const H = 26 + d.parts.length * (rh + 2) + 18;
    wakes.setAttribute('viewBox', `0 0 ${W} ${H}`);
    wakes.setAttribute('height', H);
    wakes.append(s('line', { x1: 0, x2: W, y1: 0.5, y2: 0.5, stroke: 'var(--line-soft)' }));
    wakes.append(s('text', { x: 10, y: 17, class: 'soft sm' }, `Wake-ups 1–${count}: which states run in each`));
    for (let w = 0; w < count; w++) {
      const x = Lm + w * cw;
      wakes.append(s('text', { x: x + cw / 2, y: H - 5, 'text-anchor': 'middle', class: 'soft sm' }, String(w + 1)));
      d.parts.forEach((p, k) => {
        const runs = w % Math.round(p.n) === 0;
        const y = 24 + k * (rh + 2);
        const r = s('rect', { x: x + 2, y, width: Math.max(2, cw - 4), height: rh, rx: 2,
          fill: runs ? col(k) : 'var(--sunken)', 'fill-opacity': runs ? 0.75 : 1, stroke: runs ? col(k) : 'var(--line-soft)' });
        r.append(s('title', {}, `${p.name}: ${runs ? 'runs' : 'skipped'} on wake-up ${w + 1} (1 in ${p.n})`));
        wakes.append(r);
      });
    }
    // Per state: a handle to change N (click cycles 1 → 2 → … ; keyboard ±1).
    d.parts.forEach((p, k) => {
      const y = 24 + k * (rh + 2);
      const g = s('g', { class: 'hd', tabindex: 0, 'data-id': `n${p.idx}`, role: 'spinbutton', 'aria-label': `${p.name}: runs once every ${p.n} wake-ups`,
        'aria-valuenow': p.n, 'aria-valuemin': 1, style: 'cursor:pointer' });
      g.append(s('rect', { class: 'ring', x: 4, y: y - 1, width: Lm - 10, height: rh + 2, rx: 3, fill: 'var(--surface)', stroke: 'var(--line)' }));
      g.append(s('text', { x: Lm / 2 - 3, y: y + 9.5, 'text-anchor': 'middle', class: 'sm b', style: `fill:${col(k)}` }, p.n === 1 ? 'every' : `1 in ${p.n}`));
      g.append(s('title', {}, `${p.name}: click for less often, Shift+click for more often; arrow keys too`));
      const setN = (n) => setRow(p.idx, { every: String(clamp(Math.round(n), 1, 1000)) });
      g.addEventListener('click', (e) => setN(e.shiftKey ? p.n - 1 : p.n + 1));
      g.addEventListener('keydown', (e) => {
        const dn = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
        if (!dn) return;
        e.preventDefault();
        setN(p.n + dn);
      });
      wakes.append(g);
      // Clicking a cell of a state sets N so it runs on that wake-up.
      for (let w = 1; w < count; w++) {
        const x = Lm + w * cw;
        const hit = s('rect', { x, y, width: cw, height: rh, fill: 'transparent', style: 'cursor:pointer' });
        hit.append(s('title', {}, `Run ${p.name} once every ${w} wake-up${w === 1 ? '' : 's'}`));
        hit.addEventListener('click', () => setN(w));
        wakes.append(hit);
      }
    });
  }

  // ---------- states list ----------
  function drawList() {
    const d = res && res.drawing;
    const st = Array.isArray(ctx.raw.states) ? ctx.raw.states : [];
    const had = listBody.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    const byIdx = new Map((d?.parts || []).map((p, k) => [p.idx, { p, k }]));
    const inp = (idx, key, w, label) => {
      const el = h('input', { type: 'text', spellcheck: 'false', 'data-id': `${key}${idx}`, 'aria-label': label, style: w ? `width:${w}px` : null,
        onfocus: () => { if (sel !== idx) { sel = idx; drawTrace(); markSel(); } },
        oninput: (e) => { const s2 = states(); s2[idx][key] = e.target.value; ctx.set('states', s2); } });
      el.value = st[idx]?.[key] ?? '';
      if (key !== 'name' && String(el.value).trim() && ctx.parseEng(el.value) == null) el.classList.add('bad');
      return el;
    };
    listBody.replaceChildren(...st.map((r, idx) => {
      const m = byIdx.get(idx);
      return h('tr', { 'data-idx': idx, class: sel === idx ? 'on' : null },
        h('td', {}, h('i', { style: `background:${m ? col(m.k) : 'var(--line)'}` })),
        h('td', { class: 'nm' }, inp(idx, 'name', null, 'State name')),
        h('td', {}, inp(idx, 'i', 64, 'Current in A')),
        h('td', {}, inp(idx, 't', 64, 'Time in s')),
        h('td', {}, inp(idx, 'every', 40, 'Runs once every N wake-ups')),
        h('td', { class: 'num' }, m ? E(m.p.avg, 'A') : '–'),
        h('td', {}, h('button', { class: 'sc-x', type: 'button', title: 'Remove state', 'aria-label': `Remove ${r.name || 'state'}`,
          onclick: () => { const s2 = states(); s2.splice(idx, 1); sel = null; ctx.set('states', s2); } }, '×')));
    }), d ? h('tr', { class: 'sleep' }, h('td', {}, h('i', { style: 'background:var(--tool-sleep)' })), h('td', {}, 'Sleep'),
      h('td', { class: 'num', style: 'text-align:left' }, E(d.isleep, 'A')), h('td', { class: 'num', style: 'text-align:left' }, E(d.tSleep, 's')), h('td', {}, ''),
      h('td', { class: 'num' }, E(d.sleep.avg, 'A')), h('td', {}, '')) : '');
    if (had) listBody.querySelector(`[data-id="${had}"]`)?.focus({ preventScroll: true });
  }
  const markSel = () => { for (const tr of listBody.querySelectorAll('tr[data-idx]')) tr.classList.toggle('on', Number(tr.dataset.idx) === sel); };

  // ---------- period curve ----------
  function drawCurve() { keepFocus(curve, drawCurveInner); }
  function drawCurveInner() {
    const d = res && res.drawing;
    const W = Math.max(260, curve.clientWidth || periodCard.clientWidth || 400);
    const H = 230;
    curve.setAttribute('viewBox', `0 0 ${W} ${H}`);
    curve.setAttribute('height', H);
    if (!d) { periodSub.textContent = ''; return; }
    const pts = d.sweep;
    const Lm = 54, Rm = 14, Tm = 14, Bm = 30;
    const geo = frozen?.curve || (() => {
      const T0 = Math.min(1, ...pts.map((p) => p.T)), T1 = Math.max(3600, ...pts.map((p) => p.T));
      const ok = pts.filter((p) => p.i > 0);
      const i0 = 10 ** Math.floor(L10(Math.min(...ok.map((p) => p.i)))), i1 = 10 ** Math.ceil(L10(Math.max(...ok.map((p) => p.i))));
      return { T0, T1, i0, i1: i1 === i0 ? i0 * 10 : i1 };
    })();
    const { T0, T1, i0, i1 } = geo;
    const X = (T) => Lm + ((L10(T) - L10(T0)) / (L10(T1) - L10(T0))) * (W - Lm - Rm);
    const Xinv = (x) => 10 ** (L10(T0) + ((x - Lm) / (W - Lm - Rm)) * (L10(T1) - L10(T0)));
    const Y = (i) => Tm + (1 - (L10(clamp(i, i0, i1)) - L10(i0)) / (L10(i1) - L10(i0))) * (H - Tm - Bm);
    for (let e = Math.round(L10(i0)); e <= Math.round(L10(i1)); e++) {
      curve.append(s('line', { x1: Lm, x2: W - Rm, y1: Y(10 ** e), y2: Y(10 ** e), stroke: 'var(--line-soft)' }));
      curve.append(s('text', { x: Lm - 5, y: Y(10 ** e) + 3.5, 'text-anchor': 'end', class: 'soft sm' }, E(10 ** e, 'A', 1)));
    }
    for (const [T, lab] of [[1, '1 s'], [10, '10 s'], [60, '1 min'], [600, '10 min'], [3600, '1 h']]) {
      if (T < T0 || T > T1) continue;
      curve.append(s('line', { x1: X(T), x2: X(T), y1: Tm, y2: H - Bm, stroke: 'var(--line-soft)' }));
      curve.append(s('text', { x: X(T), y: H - Bm + 14, 'text-anchor': 'middle', class: 'soft sm' }, lab));
    }
    // Periods too short for a wake-up with every state.
    if (d.tWorst > T0) curve.append(s('rect', { x: Lm, y: Tm, width: X(Math.min(T1, d.tWorst)) - Lm, height: H - Tm - Bm, fill: 'var(--danger)', 'fill-opacity': 0.1 }));
    // Sleep-only floor: the average can never go below the sleep current.
    if (d.isleep >= i0) {
      curve.append(s('line', { x1: Lm, x2: W - Rm, y1: Y(d.isleep), y2: Y(d.isleep), stroke: 'var(--tool-sleep)', 'stroke-dasharray': '4 3' }));
      curve.append(s('text', { x: W - Rm - 2, y: Y(d.isleep) - 4, 'text-anchor': 'end', class: 'sm', style: 'fill:var(--tool-sleep)' }, `sleep floor ${E(d.isleep, 'A')}`));
    }
    const good = pts.filter((p) => p.ok && p.i > 0);
    curve.append(s('path', { d: good.map((p, k) => `${k ? 'L' : 'M'}${X(p.T).toFixed(1)},${Y(p.i).toFixed(1)}`).join(''), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2 }));
    for (const p of good) if (p.T !== d.period) curve.append(s('circle', { cx: X(p.T), cy: Y(p.i), r: 2.2, fill: 'var(--accent)', 'fill-opacity': 0.6 }));
    // The current period: a handle.
    const x = X(d.period), y = Y(d.iavg);
    const g = s('g', { class: 'hd ew', tabindex: 0, 'data-id': 'period', role: 'slider', 'aria-label': 'Wake-up period', 'aria-valuetext': `${E(d.period, 's')}, average ${E(d.iavg, 'A')}` });
    g.append(s('circle', { cx: x, cy: y, r: 14, fill: 'transparent' }));
    g.append(s('circle', { class: 'ring', cx: x, cy: y, r: 6.5, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2 }));
    g.append(s('line', { x1: x, x2: x, y1: y + 8, y2: H - Bm, stroke: 'var(--accent)', 'stroke-dasharray': '3 3' }));
    const lab = `${E(d.period, 's')} → ${E(d.iavg, 'A')}`;
    const right = x + 12 + lab.length * 6.7 < W - Rm;
    g.append(s('text', { x: right ? x + 11 : x - 11, y: y - 9, 'text-anchor': right ? 'start' : 'end', class: 'b', style: 'fill:var(--accent)' }, lab));
    curve.append(g);
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault(); g.focus({ preventScroll: true });
      frozen = { curve: geo };
      onDrag((ev) => { const [px] = toSvg(curve, ev, W); ctx.set('period', String(snapNice(clamp(Xinv(px), T0, T1)))); }, drawCurve);
    });
    g.addEventListener('keydown', (e) => {
      const m = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!m) return;
      e.preventDefault();
      const p = d.period;
      const lst = [...NICE, 10];
      const pw = 10 ** Math.floor(L10(p) + 1e-9);
      const all = [pw / 10, pw, pw * 10].flatMap((q) => lst.map((n) => Number((n * q).toPrecision(3))));
      const next = m > 0 ? all.find((v) => v > p * 1.0001) : all.reverse().find((v) => v < p * 0.9999);
      if (next) ctx.set('period', String(next));
    });
    periodSub.replaceChildren('every ', h('b', {}, E(d.period, 's')), ' · ', h('b', {}, `${f(d.perDay, 4)} mAh/day`));
  }

  // ---------- budget ----------
  function drawBudget() {
    const d = res && res.drawing;
    const W = Math.max(240, bar.clientWidth || budgetCard.clientWidth || 360);
    bar.replaceChildren();
    figs.replaceChildren();
    if (!d) { bar.setAttribute('height', 0); return; }
    const items = [...d.parts.map((p, k) => ({ name: p.name, share: p.share, avg: p.avg, c: col(k), idx: p.idx })), { name: 'Sleep', share: d.sleep.share, avg: d.sleep.avg, c: 'var(--tool-sleep)' }];
    const Lm = 10, Rm = 10, bh = 26;
    const rows = items.length;
    const H = 14 + bh + 10 + rows * 17 + 6;
    bar.setAttribute('viewBox', `0 0 ${W} ${H}`);
    bar.setAttribute('height', H);
    let x = Lm;
    const bw = W - Lm - Rm;
    for (const it of items) {
      const w = (it.share / 100) * bw;
      if (w > 0) {
        const r = s('rect', { x, y: 12, width: Math.max(0.5, w), height: bh, fill: it.c, 'fill-opacity': 0.8 });
        r.append(s('title', {}, `${it.name}: ${f(it.share, 3)} % of the charge, ${E(it.avg, 'A')} of the average`));
        bar.append(r);
        if (w > 34) bar.append(s('text', { x: x + w / 2, y: 12 + bh / 2 + 4, 'text-anchor': 'middle', class: 'b sm', style: 'fill:var(--surface)' }, `${f(it.share, 2)}%`));
      }
      x += w;
    }
    const sorted = [...items].sort((a, b) => b.share - a.share);
    sorted.forEach((it, r) => {
      const y = 12 + bh + 20 + r * 17;
      bar.append(s('rect', { x: Lm, y: y - 9, width: 10, height: 10, rx: 2, fill: it.c }));
      bar.append(s('text', { x: Lm + 16, y }, it.name.length > 26 ? `${it.name.slice(0, 25)}…` : it.name));
      bar.append(s('text', { x: W - Rm - 58, y, 'text-anchor': 'end', class: 'soft' }, E(it.avg, 'A')));
      bar.append(s('text', { x: W - Rm, y, 'text-anchor': 'end', class: r === 0 ? 'b' : '' }, `${f(it.share, 3)} %`));
    });
    const vals = res.values || [];
    const pick = (label, cls) => {
      const v = vals.find((q) => q.label === label);
      if (!v) return;
      figs.append(h('div', { class: `sc-fig${cls ? ` ${cls}` : ''}${v.tone === 'warn' ? ' warn' : ''}` }, h('span', {}, v.label),
        h('b', {}, String(v.value), v.unit ? h('small', {}, ` ${v.unit}`) : null), v.hint ? h('em', {}, v.hint) : null));
    };
    pick('Average current', 'main');
    pick('Charge per day');
    pick('Duty cycle (awake)');
    pick('Average power');
    pick('Energy per day');
    pick('Sleep dominates', 'main');
  }

  function drawText() {
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
    for (const [k, el] of Object.entries(fields)) {
      const raw = ctx.raw[k];
      if (document.activeElement !== el) el.value = raw ?? '';
      el.classList.toggle('bad', String(raw ?? '').trim() !== '' && ctx.parseEng(raw) == null);
    }
  }
  function drawAll() { drawTrace(); drawWakes(); drawList(); drawCurve(); drawBudget(); drawText(); }

  ctx.onResult((r) => { res = r; drawAll(); });
  let lastW = '';
  new ResizeObserver(() => {
    const w = `${traceCard.clientWidth}/${periodCard.clientWidth}/${budgetCard.clientWidth}`;
    if (w !== lastW) { lastW = w; drawTrace(); drawWakes(); drawCurve(); drawBudget(); }
  }).observe(wrap);
}
