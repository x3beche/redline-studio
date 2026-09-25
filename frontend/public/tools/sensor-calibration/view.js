// Sensor Calibration Fit, custom page: the sensor's transfer line is the tool.
//   Equation - "°C = gain × counts + offset" across the top; the two unit
//              names are edited in place inside it.
//   Plot     - raw reading (x) against the reference (y). The points are
//              drag handles (arrow keys move a focused one, Delete removes
//              it); a click on empty paper adds a point there. The fitted
//              line, each point's miss drawn to it, the calibrated range and
//              the extrapolated ends shaded. The probe is a cursor: drag it
//              (or its handle on the x axis) and read the converted value
//              where it meets the line.
//   Residuals- the misses magnified under the same x axis, the ±1 % of span
//              band that the linearity warning uses shaded.
//   Points   - the same points as numbers, each with its residual as a bar.
//   Firmware - the Q-format word as a bit ruler: drag the binary point to
//              set the fraction bits, see the gain constant and the peak
//              product against the int32 sign bit; the integer arithmetic
//              for the probe written out.
// Every number drawn comes from run()'s result.cal.

const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

const CSS = `
:root { --tool-fit: #1f4ed8; --tool-pt: #16202a; --tool-probe: #0f8a78; --tool-gain: #c26a00; --tool-peak: #7a45b0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-fit: #7d9bff; --tool-pt: #e4ebf1; --tool-probe: #3cc7b3; --tool-gain: #f0a33a; --tool-peak: #c982e0; } }
:root[data-theme="dark"] { --tool-fit: #7d9bff; --tool-pt: #e4ebf1; --tool-probe: #3cc7b3; --tool-gain: #f0a33a; --tool-peak: #c982e0; }
.k-page { padding: 12px; }
.sc { display: grid; grid-template-columns: minmax(0, 1fr) 360px; grid-template-areas: "eq side" "plot side" "out side"; gap: 12px; align-items: start; }
@media (max-width: 1020px) { .sc { grid-template-columns: minmax(0, 1fr); grid-template-areas: "eq" "plot" "side" "out"; } }
.sc-eq { grid-area: eq; display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 18px; }
.sc-formula { font: 500 20px/1.3 "IBM Plex Mono", ui-monospace, monospace; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; }
.sc-formula .sc-num { color: var(--tool-fit); }
.sc-formula .sc-op { color: var(--ink-soft); }
.sc-unit { font: inherit; font-size: 17px; width: auto; min-width: 2ch; padding: 0 4px; border: 1px dashed var(--line); border-radius: 4px; background: transparent; color: var(--ink); }
.sc-unit:hover { border-color: var(--ink-soft); }
.sc-stats { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink-soft); }
.sc-stats b { font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.sc-stats .ok { color: var(--ok); } .sc-stats .warn { color: var(--warn); } .sc-stats .bad { color: var(--danger); }
.sc-plotbox { grid-area: plot; min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 6px 6px 4px; }
.sc-warns:empty { display: none; }
.sc-warns { margin: 2px 4px 6px; border-left: 3px solid var(--warn); padding: 3px 8px; font-size: 12px; background: var(--sunken); border-radius: 0 4px 4px 0; }
.sc-warns div + div { margin-top: 2px; }
.sc-svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.sc-svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.sc-svg .t-ink { fill: var(--ink); }
.sc-svg .t-b { font-weight: 600; }
.sc-svg .t-warn { fill: var(--warn); } .sc-svg .t-on { fill: var(--surface); font-weight: 600; } .sc-qsvg .t-danger { fill: var(--danger); }
.sc-grid { stroke: var(--line-soft); }
.sc-axis { stroke: var(--line); }
.sc-extra { fill: var(--warn); fill-opacity: .08; }
.sc-range { stroke: var(--line); stroke-dasharray: 2 3; }
.sc-fitline { stroke: var(--tool-fit); stroke-width: 2; }
.sc-miss { stroke: var(--ink-soft); stroke-width: 1; stroke-dasharray: 2 2; }
.sc-pt { cursor: grab; outline: none; }
.sc-pt circle.dot { fill: var(--tool-pt); stroke: var(--surface); stroke-width: 2; }
.sc-pt circle.hit { fill: transparent; }
.sc-pt circle.ring { fill: none; stroke: var(--accent); stroke-width: 2; opacity: 0; }
.sc-pt.sel circle.ring, .sc-pt:focus-visible circle.ring { opacity: 1; }
.sc-pt.worst circle.dot { fill: var(--warn); }
.sc-pt:active { cursor: grabbing; }
.sc-probe line { stroke: var(--tool-probe); stroke-width: 1.5; stroke-dasharray: 5 3; }
.sc-probe .knob { fill: var(--tool-probe); stroke: var(--surface); stroke-width: 2; cursor: ew-resize; }
.sc-probe .grab { stroke: transparent; stroke-width: 14; stroke-dasharray: none; cursor: ew-resize; }
.sc-probe:focus-visible .knob { stroke: var(--accent); stroke-width: 3; }
.sc-probe { outline: none; }
.sc-tag rect { fill: var(--surface); stroke: var(--tool-probe); }
.sc-tag.warn rect { stroke: var(--warn); }
.sc-tag text { fill: var(--ink); }
.sc-band { fill: var(--ok); fill-opacity: var(--fill-alpha); }
.sc-stem { stroke-width: 3; }
.sc-stem.ok { stroke: var(--ok); } .sc-stem.warn { stroke: var(--warn); }
.sc-help { font-size: 11.5px; color: var(--ink-soft); padding: 2px 6px 2px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.sc-help kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; background: var(--sunken); }
.sc-side { grid-area: side; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.sc-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.sc-ph { display: flex; align-items: baseline; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.sc-ph b { font-size: 13px; }
.sc-ph span { font-size: 11.5px; color: var(--ink-soft); }
.sc-ph .k-btn { margin-left: auto; }
.sc-rows { display: grid; grid-template-columns: 22px minmax(0, 1fr) minmax(0, 1fr) 76px 22px; gap: 3px 6px; padding: 6px 10px 8px; align-items: center; }
.sc-rows .hd { font-size: 10.5px; color: var(--ink-soft); }
.sc-rows input { width: 100%; min-width: 0; padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.sc-rows input.bad { border-color: var(--danger); }
.sc-rows .no { font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); text-align: right; cursor: pointer; border: 0; background: none; padding: 0; }
.sc-rows .no.sel { color: var(--accent); font-weight: 600; }
.sc-rbar { position: relative; height: 16px; }
.sc-rbar i { position: absolute; top: 3px; height: 10px; border-radius: 1px; }
.sc-rbar i.ok { background: var(--ok); } .sc-rbar i.warn { background: var(--warn); }
.sc-rbar::before { content: ""; position: absolute; left: 32%; top: 0; bottom: 0; border-left: 1px solid var(--line); }
.sc-rbar em { position: absolute; right: 0; top: -1px; font: 10px "IBM Plex Mono", ui-monospace, monospace; font-style: normal; color: var(--ink-soft); }
.sc-rows .k-x { padding: 0 6px; }
.sc-q { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.sc-qsvg { display: block; width: 100%; touch-action: none; user-select: none; }
.sc-qsvg text { font: 10px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.sc-qsvg .t-ink { fill: var(--ink); }
.sc-qcell { fill: var(--sunken); stroke: var(--line-soft); }
.sc-qcell.frac { fill: var(--surface); }
.sc-qgain { fill: var(--tool-gain); }
.sc-qpeak { fill: var(--tool-peak); }
.sc-qover { fill: var(--danger); fill-opacity: .18; }
.sc-qsign { stroke: var(--danger); stroke-width: 1.5; }
.sc-qpoint { cursor: ew-resize; outline: none; }
.sc-qpoint path { fill: var(--accent); }
.sc-qpoint line { stroke: var(--accent); stroke-width: 2; }
.sc-qpoint .grab { stroke: transparent; stroke-width: 16; }
.sc-qpoint:focus-visible path { stroke: var(--ink); stroke-width: 1.5; }
.sc-qrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 12px; color: var(--ink-soft); }
.sc-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
.sc-seg button { border: 0; background: var(--surface); padding: 2px 8px; font: 12px "IBM Plex Mono", ui-monospace, monospace; cursor: pointer; color: var(--ink-soft); }
.sc-seg button + button { border-left: 1px solid var(--line); }
.sc-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.sc-small { width: 64px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.sc-calc { font: 12px/1.6 "IBM Plex Mono", ui-monospace, monospace; background: var(--sunken); border-radius: 4px; padding: 6px 8px; overflow-x: auto; white-space: nowrap; }
.sc-calc .g { color: var(--tool-gain); } .sc-calc .p { color: var(--tool-peak); } .sc-calc .r { color: var(--tool-probe); font-weight: 600; }
.sc-calc .soft { color: var(--ink-soft); }
.sc-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--ink-soft); }
.sc-legend i { display: inline-block; width: 10px; height: 8px; margin-right: 4px; vertical-align: 0; border-radius: 1px; }
.sc-out { grid-area: out; min-width: 0; }
.sc-out .k-out { max-height: 300px; }
`;

// ---------------------------------------------------------------- helpers
function niceStep(span, n) {
  const raw = span / Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
function ticks(lo, hi, n) {
  const st = niceStep(hi - lo, n);
  const out = [];
  for (let v = Math.ceil(lo / st) * st; v <= hi + st * 1e-9; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : v);
  return { st, vals: out };
}
const decimalsFor = (step) => Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)));
const fixedStr = (v, step) => {
  const d = decimalsFor(step);
  const r = Math.round(v / step) * step;
  return (Math.abs(r) < step / 2 ? 0 : r).toFixed(d);
};

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const f = (v, d = 4) => ctx.fmtNum(v, d);
  const st = { sel: null, frozen: null, drag: null, W: 0 };

  // ------------------------------------------------------------ layout
  const yUnit = h('input', { class: 'sc-unit', 'aria-label': 'Reference unit', spellcheck: 'false', size: 3, oninput: (e) => { fit(e.target); ctx.set('refUnit', e.target.value); } });
  const xUnit = h('input', { class: 'sc-unit', 'aria-label': 'Raw unit', spellcheck: 'false', size: 6, oninput: (e) => { fit(e.target); ctx.set('rawUnit', e.target.value); } });
  const gainEl = h('span', { class: 'sc-num', title: 'gain' });
  const offOp = h('span', { class: 'sc-op' });
  const offEl = h('span', { class: 'sc-num', title: 'offset' });
  const stats = h('div', { class: 'sc-stats', 'aria-live': 'polite' });
  const eq = h('div', { class: 'sc-eq' },
    h('div', { class: 'sc-formula', 'aria-label': 'Calibration line' }, yUnit, h('span', { class: 'sc-op' }, '='), gainEl, h('span', { class: 'sc-op' }, '×'), xUnit, offOp, offEl),
    stats);

  const warns = h('div', { class: 'sc-warns', 'aria-live': 'polite' });
  const svg = sv('svg', { class: 'sc-svg', role: 'group', 'aria-label': 'Calibration plot: points, fitted line and probe' });
  const help = h('div', { class: 'sc-help' },
    h('span', {}, 'Drag a point; click empty paper to add one'),
    h('span', {}, h('kbd', {}, '←↑→↓'), ' move the focused point (', h('kbd', {}, 'Shift'), ' ×10), ', h('kbd', {}, 'Del'), ' removes it'),
    h('span', {}, 'Drag the teal cursor to convert a reading'));
  const plotBox = h('section', { class: 'sc-plotbox' }, warns, svg, help);

  const rowsEl = h('div', { class: 'sc-rows' });
  const addBtn = h('button', { class: 'k-btn', onclick: () => addPoint() }, '+ Point');
  const pointsPanel = h('section', { class: 'sc-panel' },
    h('div', { class: 'sc-ph' }, h('b', {}, 'Points'), h('span', { class: 'sc-pcount' }), addBtn), rowsEl);

  const qsvg = sv('svg', { class: 'sc-qsvg', role: 'group', 'aria-label': 'Fixed-point word' });
  const scaleSeg = h('span', { class: 'sc-seg', role: 'group', 'aria-label': 'Output scale' });
  const scaleIn = h('input', { class: 'sc-small', 'aria-label': 'Output scale', spellcheck: 'false', oninput: (e) => ctx.set('scale', e.target.value) });
  const bitsIn = h('input', { class: 'sc-small', 'aria-label': 'Fraction bits', spellcheck: 'false', style: 'width:44px', oninput: (e) => ctx.set('shift', e.target.value) });
  const calc = h('div', { class: 'sc-calc', tabindex: '0', 'aria-label': 'Integer arithmetic for the probe reading' });
  const qnote = h('div', { class: 'sc-legend' });
  const fwPanel = h('section', { class: 'sc-panel' },
    h('div', { class: 'sc-ph' }, h('b', {}, 'Firmware'), h('span', { class: 'sc-qtitle' })),
    h('div', { class: 'sc-q' },
      h('div', { class: 'sc-qrow' }, h('span', {}, 'result in'), h('span', { class: 'sc-yu' }), h('span', {}, '×'), scaleSeg, scaleIn),
      qsvg,
      h('div', { class: 'sc-qrow' }, h('span', {}, 'fraction bits'), bitsIn, h('span', {}, 'drag the blue binary point or use ← →')),
      qnote, calc));

  const side = h('aside', { class: 'sc-side' }, pointsPanel, fwPanel);
  const out = h('div', { class: 'sc-out' }, ctx.outputs);
  root.append(h('div', { class: 'sc' }, eq, plotBox, side, out));

  function fit(inp) { inp.size = Math.max(2, (inp.value || '').length + 1); }
  const syncVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };

  // ------------------------------------------------------------ input edits
  const rows = () => (Array.isArray(ctx.raw.points) ? ctx.raw.points.map((r) => ({ ...r })) : []);
  function setRow(idx, patch) {
    const rs = rows();
    if (!rs[idx]) return;
    Object.assign(rs[idx], patch);
    ctx.set('points', rs);
  }
  function addPoint(x, y) {
    const rs = rows();
    const c = ctx.result?.cal;
    if (x == null && c) {
      // after the last point, one step further along the line
      const last = c.points[c.points.length - 1];
      const step = c.xmax > c.xmin ? (c.xmax - c.xmin) / Math.max(1, c.n - 1) : 100;
      x = last.x + step; y = c.gain * x + c.offset;
      const sx = niceStep(step, 50), sy = niceStep(Math.abs(c.gain * step) || 1, 50);
      rs.push({ raw: fixedStr(x, sx), ref: fixedStr(y, sy) });
    } else rs.push({ raw: x == null ? '' : String(x), ref: y == null ? '' : String(y) });
    st.sel = rs.length;
    ctx.set('points', rs);
  }
  function removeRow(idx) {
    const rs = rows();
    rs.splice(idx, 1);
    st.sel = null;
    ctx.set('points', rs);
  }

  // ------------------------------------------------------------ plot scales
  const M = { l: 58, r: 16, t: 14, b: 34 }, RH = 120, GAP = 30;
  function scales(c) {
    if (st.frozen) return st.frozen;
    const xs = c.points.map((p) => p.x), ys = c.points.map((p) => p.y);
    if (c.probe != null) xs.push(c.probe);
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (!(x1 > x0)) { x0 -= 1; x1 += 1; }
    const px = (x1 - x0) * 0.08;
    x0 -= px; x1 += px;
    ys.push(c.gain * x0 + c.offset, c.gain * x1 + c.offset);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
    const py = (y1 - y0) * 0.08;
    y0 -= py; y1 += py;
    const rm = Math.max(c.linLimit * 0.2, ...c.points.map((p) => Math.abs(p.res) * 1.35)) || 1;
    return { x0, x1, y0, y1, rm };
  }

  // ------------------------------------------------------------ plot
  function drawPlot(c) {
    const W = Math.max(300, Math.round(svg.getBoundingClientRect().width || plotBox.clientWidth - 12));
    st.W = W;
    const PH = W < 560 ? 280 : 360;
    const H = M.t + PH + GAP + RH + M.b;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    const S = scales(c);
    const L = M.l, R = W - M.r, T = M.t, B = M.t + PH, RT = B + GAP, RB = RT + RH, RZ = (RT + RB) / 2;
    const X = (v) => L + ((v - S.x0) / (S.x1 - S.x0)) * (R - L);
    const Y = (v) => B - ((v - S.y0) / (S.y1 - S.y0)) * (B - T);
    const RY = (v) => RZ - (v / S.rm) * (RH / 2);
    st.map = { X, Y, S, L, R, T, B, RT, RB };
    const keepFocus = document.activeElement?.getAttribute?.('data-fk');
    svg.replaceChildren();
    const u = c.units;

    // extrapolated ends and calibrated range
    const span = c.xmax - c.xmin;
    const e0 = c.xmin - 0.1 * span, e1 = c.xmax + 0.1 * span;
    if (X(e0) > L) svg.append(sv('rect', { class: 'sc-extra', x: L, y: T, width: X(e0) - L, height: RB - T }));
    if (X(e1) < R) svg.append(sv('rect', { class: 'sc-extra', x: X(e1), y: T, width: R - X(e1), height: RB - T }));
    if (X(e1) < R - 60) svg.append(sv('text', { x: R - 4, y: T + 12, 'text-anchor': 'end' }, 'extrapolated'));
    if (X(e0) > L + 60) svg.append(sv('text', { x: L + 4, y: T + 12 }, 'extrapolated'));

    // grid and axes
    const tx = ticks(S.x0, S.x1, Math.max(3, Math.floor((R - L) / 90)));
    const ty = ticks(S.y0, S.y1, 7);
    for (const v of tx.vals) {
      svg.append(sv('line', { class: 'sc-grid', x1: X(v), x2: X(v), y1: T, y2: B }));
      svg.append(sv('line', { class: 'sc-grid', x1: X(v), x2: X(v), y1: RT, y2: RB }));
      svg.append(sv('text', { x: X(v), y: RB + 14, 'text-anchor': 'middle' }, f(v, 6)));
    }
    for (const v of ty.vals) {
      svg.append(sv('line', { class: 'sc-grid', x1: L, x2: R, y1: Y(v), y2: Y(v) }));
      svg.append(sv('text', { x: L - 6, y: Y(v) + 3.5, 'text-anchor': 'end' }, f(v, 5)));
    }
    svg.append(sv('rect', { x: L, y: T, width: R - L, height: B - T, fill: 'none', class: 'sc-axis' }));
    svg.append(sv('text', { x: L - 6, y: T - 3, 'text-anchor': 'end', class: 't-ink' }, u.ref));
    svg.append(sv('text', { x: R, y: RB + 28, 'text-anchor': 'end', class: 't-ink' }, `raw (${u.raw})`));
    for (const v of [c.xmin, c.xmax]) svg.append(sv('line', { class: 'sc-range', x1: X(v), x2: X(v), y1: T, y2: RB }));

    // the fitted line across the plot
    const clipY = (x) => c.gain * x + c.offset;
    svg.append(sv('line', { class: 'sc-fitline', x1: L, y1: Y(clipY(S.x0)), x2: R, y2: Y(clipY(S.x1)), 'clip-path': 'url(#sc-clip)' }));
    const defs = sv('defs');
    const cp = sv('clipPath', { id: 'sc-clip' });
    cp.append(sv('rect', { x: L, y: T, width: R - L, height: B - T }));
    defs.append(cp);
    svg.prepend(defs);

    // residual strip
    svg.append(sv('rect', { x: L, y: RT, width: R - L, height: RH, fill: 'none', class: 'sc-axis' }));
    const bandH = Math.min(RH / 2, (c.linLimit / S.rm) * (RH / 2));
    if (c.n > 2 && c.linLimit > 0) svg.append(sv('rect', { class: 'sc-band', x: L, y: RZ - bandH, width: R - L, height: 2 * bandH }));
    svg.append(sv('line', { class: 'sc-axis', x1: L, x2: R, y1: RZ, y2: RZ }));
    svg.append(sv('text', { x: L - 6, y: RZ + 3.5, 'text-anchor': 'end' }, '0'));
    svg.append(sv('text', { x: L - 6, y: RT + 10, 'text-anchor': 'end' }, `+${f(S.rm, 2)}`));
    svg.append(sv('text', { x: L - 6, y: RB - 2, 'text-anchor': 'end' }, `−${f(S.rm, 2)}`));
    svg.append(sv('text', { x: L + 6, y: RT + 12, class: 't-ink' }, `residual, ${u.ref}`));
    if (c.n > 2 && c.linLimit > 0) svg.append(sv('text', { x: R - 6, y: Math.max(RT + 12, RZ - bandH - 4), 'text-anchor': 'end' }, `±1 % of span = ±${f(c.linLimit, 3)} ${u.ref}`));
    else svg.append(sv('text', { x: R - 6, y: RB - 6, 'text-anchor': 'end' }, 'two points: nothing to check'));

    // points
    const worst = c.n > 2 && Math.abs(c.maxRes) > c.linLimit ? c.points.reduce((a, p) => (Math.abs(p.res) > Math.abs(a.res) ? p : a)) : null;
    c.points.forEach((p) => {
      const ok = !(c.n > 2 && Math.abs(p.res) > c.linLimit);
      svg.append(sv('line', { class: 'sc-miss', x1: X(p.x), x2: X(p.x), y1: Y(p.y), y2: Y(p.fit) }));
      svg.append(sv('line', { class: `sc-stem ${ok ? 'ok' : 'warn'}`, x1: X(p.x), x2: X(p.x), y1: RZ, y2: RY(Math.max(-S.rm, Math.min(S.rm, p.res))) }));
      const up = p.res >= 0;
      svg.append(sv('text', { x: X(p.x) + 5, y: up ? RY(Math.min(S.rm, p.res)) + 4 : RY(Math.max(-S.rm, p.res)), class: ok ? '' : 't-ink' }, f(p.res, 3)));
    });
    c.points.forEach((p) => {
      const g = sv('g', { class: `sc-pt${st.sel === p.row ? ' sel' : ''}${worst === p ? ' worst' : ''}`, tabindex: '0', 'data-fk': `p${p.row}`, 'data-row': p.row,
        role: 'button', 'aria-label': `Point ${p.row}: raw ${f(p.x, 6)} ${u.raw}, reference ${f(p.y, 6)} ${u.ref}, residual ${f(p.res, 3)}` });
      g.append(sv('circle', { class: 'hit', cx: X(p.x), cy: Y(p.y), r: 13 }));
      g.append(sv('circle', { class: 'ring', cx: X(p.x), cy: Y(p.y), r: 9 }));
      g.append(sv('circle', { class: 'dot', cx: X(p.x), cy: Y(p.y), r: 5.5 }));
      const right = X(p.x) < (L + R) / 2;
      const lab = sv('text', { x: X(p.x) + (right ? 10 : -10), y: Y(p.y) - 9, 'text-anchor': right ? 'start' : 'end', class: 't-ink' }, `${f(p.x, 6)} → ${f(p.y, 6)}`);
      g.append(lab);
      if (worst === p) g.append(sv('text', { x: X(p.x) + (right ? 10 : -10), y: Y(p.y) + 18, 'text-anchor': right ? 'start' : 'end', class: 't-warn' }, `off the line by ${f(Math.abs(p.res), 3)} ${u.ref}`));
      svg.append(g);
    });

    // probe
    if (c.probe != null && Number.isFinite(c.probeOut)) {
      const px = Math.max(L, Math.min(R, X(c.probe)));
      const py = Math.max(T, Math.min(B, Y(c.probeOut)));
      const g = sv('g', { class: 'sc-probe', tabindex: '0', 'data-fk': 'probe', role: 'slider', 'aria-label': `Probe reading ${f(c.probe, 6)} ${u.raw}, converts to ${f(c.probeOut, 6)} ${u.ref}`,
        'aria-valuenow': c.probe });
      g.append(sv('line', { x1: px, x2: px, y1: RB, y2: py }));
      g.append(sv('line', { x1: L, x2: px, y1: py, y2: py }));
      g.append(sv('line', { class: 'grab', x1: px, x2: px, y1: T, y2: RB }));
      const xt = f(c.probe, 6), xw = xt.length * 6.7 + 12;
      g.append(sv('rect', { class: 'knob', x: px - xw / 2, y: RB + 2, width: xw, height: 17, rx: 3 }));
      g.append(sv('text', { x: px, y: RB + 14, 'text-anchor': 'middle', class: 't-on' }, xt));
      g.append(sv('circle', { class: 'knob', cx: px, cy: py, r: 4.5 }));
      svg.append(g);
      // readouts: value on the y axis, a tag at the crossing
      const yl = sv('g', { class: 'sc-tag' });
      const ytxt = f(c.probeOut, 5);
      yl.append(sv('rect', { x: 2, y: py - 9, width: L - 6, height: 18, rx: 3 }));
      yl.append(sv('text', { x: L - 7, y: py + 4, 'text-anchor': 'end', class: 't-b' }, ytxt));
      svg.append(yl);
      const fx = c.fixed;
      const t1 = `${f(c.probe, 6)} ${u.raw} → ${f(c.probeOut, 6)} ${u.ref}`;
      const t2 = fx.out != null ? `integer ${fx.out} = ${f(fx.out / fx.scale, 6)} ${u.ref}` : '';
      const tw = Math.max(t1.length, t2.length) * 6.7 + 14;
      const onRight = px + 12 + tw < R;
      const bx = Math.max(L + 2, Math.min(R - tw - 2, onRight ? px + 12 : px - 12 - tw));
      const by = Math.min(B - 40, Math.max(T + 4, py + 10));
      const tag = sv('g', { class: `sc-tag${c.extrapolated ? ' warn' : ''}` });
      tag.append(sv('rect', { x: bx, y: by, width: tw, height: c.extrapolated ? 50 : 36, rx: 4 }));
      tag.append(sv('text', { x: bx + 7, y: by + 14, class: 't-b' }, t1));
      tag.append(sv('text', { x: bx + 7, y: by + 29 }, t2));
      if (c.extrapolated) tag.append(sv('text', { x: bx + 7, y: by + 43, class: 't-warn' }, 'outside the calibrated range'));
      svg.append(tag);
    }
    if (keepFocus) svg.querySelector(`[data-fk="${keepFocus}"]`)?.focus();
  }

  // ------------------------------------------------------------ plot interaction
  const toData = (e) => {
    const r = svg.getBoundingClientRect();
    const m = st.map;
    const sx = (e.clientX - r.left) * (st.W / r.width);
    const sy = (e.clientY - r.top) * (st.W / r.width);
    const x = m.S.x0 + ((sx - m.L) / (m.R - m.L)) * (m.S.x1 - m.S.x0);
    const y = m.S.y0 + ((m.B - sy) / (m.B - m.T)) * (m.S.y1 - m.S.y0);
    return { x, y, sx, sy };
  };
  const steps = () => {
    const S = st.map.S;
    return { sx: niceStep(S.x1 - S.x0, 500), sy: niceStep(S.y1 - S.y0, 500) };
  };
  svg.addEventListener('pointerdown', (e) => {
    const c = ctx.result?.cal;
    if (!c || !st.map) return;
    const pt = e.target.closest('.sc-pt');
    const probe = e.target.closest('.sc-probe');
    svg.setPointerCapture(e.pointerId);
    st.frozen = st.map.S;
    if (pt) {
      const row = Number(pt.dataset.row);
      st.sel = row;
      st.drag = { kind: 'pt', row };
      pt.focus();
      drawSel();
    } else if (probe) {
      st.drag = { kind: 'probe' };
      probe.focus();
    } else {
      const d = toData(e);
      st.drag = { kind: 'bg', x0: e.clientX, y0: e.clientY, d };
    }
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!st.drag) return;
    const d = toData(e);
    const { sx, sy } = steps();
    if (st.drag.kind === 'pt') {
      const y = d.sy > st.map.B ? null : d.y;
      setRow(st.drag.row - 1, y == null ? { raw: fixedStr(d.x, sx) } : { raw: fixedStr(d.x, sx), ref: fixedStr(d.y, sy) });
    } else if (st.drag.kind === 'probe') {
      ctx.set('probe', fixedStr(d.x, sx));
    }
  });
  const endDrag = (e) => {
    if (!st.drag) return;
    const dr = st.drag;
    st.drag = null;
    st.frozen = null;
    if (dr.kind === 'bg' && Math.hypot(e.clientX - dr.x0, e.clientY - dr.y0) < 4 && dr.d.sy <= st.map.B && dr.d.sy >= st.map.T && dr.d.sx >= st.map.L) {
      const { sx, sy } = steps();
      addPoint(fixedStr(dr.d.x, sx), fixedStr(dr.d.y, sy));
      return;
    }
    if (ctx.result?.cal) redraw(ctx.result);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('keydown', (e) => {
    const c = ctx.result?.cal;
    if (!c || !st.map) return;
    const pt = e.target.closest('.sc-pt');
    const probe = e.target.closest('.sc-probe');
    const k = e.shiftKey ? 10 : 1;
    const S = st.map.S;
    const sx = niceStep(S.x1 - S.x0, 100), sy = niceStep(S.y1 - S.y0, 100);
    if (pt) {
      const row = Number(pt.dataset.row);
      const p = c.points.find((q) => q.row === row);
      st.sel = row;
      let patch = null;
      if (e.key === 'ArrowLeft') patch = { raw: fixedStr(p.x - k * sx, sx) };
      else if (e.key === 'ArrowRight') patch = { raw: fixedStr(p.x + k * sx, sx) };
      else if (e.key === 'ArrowUp') patch = { ref: fixedStr(p.y + k * sy, sy) };
      else if (e.key === 'ArrowDown') patch = { ref: fixedStr(p.y - k * sy, sy) };
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeRow(row - 1); return; }
      if (patch) { e.preventDefault(); st.frozen = S; setRow(row - 1, patch); st.frozen = null; }
    } else if (probe) {
      let v = null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = c.probe - k * sx;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = c.probe + k * sx;
      if (v != null) { e.preventDefault(); ctx.set('probe', fixedStr(v, sx)); }
    }
  });
  svg.addEventListener('keyup', () => { if (ctx.result?.cal && !st.drag) redraw(ctx.result); });

  // ------------------------------------------------------------ points list
  let rowSig = '';
  function drawRows(res) {
    const c = res.cal;
    const rs = rows();
    const byRow = new Map((c?.points || []).map((p) => [p.row, p]));
    const sig = rs.length + '|' + st.sel;
    const focused = rowsEl.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null;
    if (sig !== rowSig || !focused) {
      rowSig = sig;
      const u = c?.units || { raw: ctx.raw.rawUnit, ref: ctx.raw.refUnit };
      rowsEl.replaceChildren(h('span', { class: 'hd' }, '#'), h('span', { class: 'hd' }, `raw, ${u.raw}`), h('span', { class: 'hd' }, `ref, ${u.ref}`), h('span', { class: 'hd' }, 'residual'), h('span', {}));
      rs.forEach((r, i) => {
        const row = i + 1;
        rowsEl.append(
          h('button', { class: `no${st.sel === row ? ' sel' : ''}`, title: 'Select on the plot', onclick: () => { st.sel = row; redraw(ctx.result); svg.querySelector(`[data-fk="p${row}"]`)?.focus(); } }, String(row)),
          h('input', { 'aria-label': `Point ${row} raw`, 'data-k': `r${row}`, spellcheck: 'false', inputmode: 'decimal', value: r.raw ?? '', onfocus: () => { st.sel = row; drawSel(); }, oninput: (e) => setRow(i, { raw: e.target.value }) }),
          h('input', { 'aria-label': `Point ${row} reference`, 'data-k': `y${row}`, spellcheck: 'false', inputmode: 'decimal', value: r.ref ?? '', onfocus: () => { st.sel = row; drawSel(); }, oninput: (e) => setRow(i, { ref: e.target.value }) }),
          h('div', { class: 'sc-rbar', 'data-bar': row }),
          h('button', { class: 'k-btn k-x', title: 'Remove point', 'aria-label': `Remove point ${row}`, onclick: () => removeRow(i) }, '×'));
      });
      if (focused) rowsEl.querySelector(`[data-k="${focused}"]`)?.focus();
    }
    // bars and validity follow every result without rebuilding the inputs
    const rm = c ? Math.max(c.linLimit * 0.2, ...c.points.map((p) => Math.abs(p.res) * 1.35)) || 1 : 1;
    rs.forEach((r, i) => {
      const row = i + 1, p = byRow.get(row);
      const bar = rowsEl.querySelector(`[data-bar="${row}"]`);
      const blank = !String(r.raw ?? '').trim() && !String(r.ref ?? '').trim();
      for (const k of ['r', 'y']) rowsEl.querySelector(`[data-k="${k}${row}"]`)?.classList.toggle('bad', !p && !blank);
      if (!bar) return;
      if (!p) { bar.replaceChildren(h('em', {}, blank ? 'empty' : 'skipped')); return; }
      const ok = !(c.n > 2 && Math.abs(p.res) > c.linLimit);
      const w = Math.min(31, (Math.abs(p.res) / rm) * 31);
      bar.replaceChildren(h('i', { class: ok ? 'ok' : 'warn', style: `left:${p.res >= 0 ? 32 : 32 - w}%;width:${Math.max(w, 0.8)}%` }), h('em', {}, f(p.res, 2)));
    });
    pointsPanel.querySelector('.sc-pcount').textContent = c ? `${c.n} used · ${c.n === 2 ? 'exact line' : 'least squares'}` : '';
  }
  function drawSel() {
    for (const b of rowsEl.querySelectorAll('.no')) b.classList.toggle('sel', Number(b.textContent) === st.sel);
    for (const g of svg.querySelectorAll('.sc-pt')) g.classList.toggle('sel', Number(g.dataset.row) === st.sel);
  }

  // ------------------------------------------------------------ Q-format word
  const qdrag = { on: false };
  function drawQ(c) {
    const fx = c.fixed;
    const peakBits = fx.peak > 1 ? Math.ceil(Math.log2(fx.peak + 1)) : 1;
    const gBits = Math.abs(fx.G) > 0 ? Math.ceil(Math.log2(Math.abs(fx.G) + 1)) : 0;
    const nb = Math.min(64, Math.max(32, peakBits + 2));
    const W = 336, cw = (W - 8) / nb, x0 = 4;
    const H = 112;
    qsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    qsvg.replaceChildren();
    const bx = (b) => x0 + (nb - 1 - b) * cw; // left edge of bit b (MSB left)
    const rowY = { cells: 14, gain: 60, peak: 86 };
    for (let b = 0; b < nb; b++) {
      qsvg.append(sv('rect', { class: `sc-qcell${b < fx.bits ? ' frac' : ''}`, x: bx(b), y: rowY.cells, width: cw, height: 14 }));
      if (b === 31 || ((b % 8 === 0 || b === nb - 1) && Math.abs(b - 31) > 2)) qsvg.append(sv('text', { x: bx(b) + cw / 2, y: rowY.cells - 3, 'text-anchor': 'middle' }, String(b)));
    }
    if (nb > 32) qsvg.append(sv('rect', { class: 'sc-qover', x: bx(nb - 1), y: rowY.cells, width: bx(31) - bx(nb - 1), height: rowY.peak + 10 - rowY.cells }));
    // gain constant, and the peak of raw × G + O
    const bar = (cls, bits, y, label) => {
      const w = Math.min(nb, bits) * cw;
      qsvg.append(sv('rect', { class: cls, x: bx(0) + cw - w, y, width: Math.max(w, 1), height: 9, rx: 1 }));
      qsvg.append(sv('text', { x: bx(0) + cw, y: y - 3, 'text-anchor': 'end', class: 't-ink' }, label));
    };
    bar('sc-qgain', gBits, rowY.gain, `gain G = ${fx.G}: ${gBits} bits`);
    bar('sc-qpeak', peakBits, rowY.peak, `peak raw × G + O: ${peakBits} bits`);
    // int32 sign bit
    const sx = bx(31) + cw;
    qsvg.append(sv('line', { class: 'sc-qsign', x1: bx(31), x2: bx(31), y1: rowY.cells - 2, y2: rowY.peak + 12 }));
    qsvg.append(sv('text', { x: bx(31) + 3, y: rowY.gain - 3, class: 't-danger' }, nb > 32 ? '← past int32' : 'int32 sign bit'));
    void sx;
    // binary point, draggable
    const px = bx(fx.bits) + cw; // between bit bits and bits-1
    const g = sv('g', { class: 'sc-qpoint', tabindex: '0', role: 'slider', 'aria-label': 'Fraction bits', 'aria-valuemin': 0, 'aria-valuemax': 30, 'aria-valuenow': fx.bits, 'data-fk': 'qp' });
    g.append(sv('line', { x1: px, x2: px, y1: rowY.cells - 4, y2: rowY.peak + 12 }));
    g.append(sv('line', { class: 'grab', x1: px, x2: px, y1: 0, y2: H }));
    g.append(sv('path', { d: `M${px},${rowY.cells + 16} l6,8 h-12 z` }));
    qsvg.append(g);
    qsvg.append(sv('text', { x: px + (px > W - 110 ? -6 : 6), y: rowY.cells + 26, 'text-anchor': px > W - 110 ? 'end' : 'start', class: 't-ink' }, `Q${fx.bits}`));
    qsvg._geo = { bx, cw, nb, x0, W };
  }
  const qFromEvent = (e) => {
    const r = qsvg.getBoundingClientRect();
    const g = qsvg._geo;
    const x = (e.clientX - r.left) * (g.W / r.width);
    const b = Math.round((g.x0 + g.nb * g.cw - x) / g.cw);
    return Math.max(0, Math.min(30, b));
  };
  qsvg.addEventListener('pointerdown', (e) => {
    if (!qsvg._geo) return;
    qsvg.setPointerCapture(e.pointerId);
    qdrag.on = true;
    qsvg.querySelector('.sc-qpoint')?.focus();
    ctx.set('shift', String(qFromEvent(e)));
    e.preventDefault();
  });
  qsvg.addEventListener('pointermove', (e) => {
    if (!qdrag.on) return;
    const b = qFromEvent(e);
    if (String(b) !== String(ctx.raw.shift)) ctx.set('shift', String(b));
  });
  qsvg.addEventListener('pointerup', () => { qdrag.on = false; });
  qsvg.addEventListener('pointercancel', () => { qdrag.on = false; });
  qsvg.addEventListener('keydown', (e) => {
    const b = ctx.result?.cal?.fixed?.bits;
    if (b == null) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); ctx.set('shift', String(Math.min(30, b + 1))); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); ctx.set('shift', String(Math.max(0, b - 1))); }
  });

  function drawFirmware(c) {
    const fx = c.fixed, u = c.units;
    fwPanel.querySelector('.sc-qtitle').textContent = `${fx.itype} arithmetic`;
    fwPanel.querySelector('.sc-yu').textContent = u.ref;
    scaleSeg.replaceChildren(...[1, 10, 100, 1000].map((v) => h('button', { 'aria-pressed': String(fx.scale === v), onclick: () => ctx.set('scale', String(v)) }, String(v))));
    syncVal(scaleIn, String(ctx.raw.scale ?? ''));
    syncVal(bitsIn, String(ctx.raw.shift ?? ''));
    const hadFocus = document.activeElement?.closest?.('.sc-qpoint');
    drawQ(c);
    if (hadFocus) qsvg.querySelector('.sc-qpoint')?.focus();
    qnote.replaceChildren(
      h('span', {}, h('i', { style: 'background:var(--tool-gain)' }), 'gain constant G'),
      h('span', {}, h('i', { style: 'background:var(--tool-peak)' }), `largest raw × G + O (to 1.25 × ${f(Math.max(Math.abs(c.xmin), Math.abs(c.xmax)), 6)})`),
      h('span', {}, `offset O ${fx.O}`),
      h('span', {}, `rounding ≤ ${f(fx.fixErr, 2)} ${u.ref} at the points`));
    if (c.probe != null && fx.acc != null) {
      const half = fx.bits ? ` + 2^${fx.bits - 1}` : '';
      calc.replaceChildren(
        h('div', {}, h('span', { class: 'soft' }, '('), `${f(c.probe, 8)} × `, h('span', { class: 'g' }, String(fx.G)), ` ${fx.O < 0 ? '−' : '+'} ${Math.abs(fx.O)}${half}`, h('span', { class: 'soft' }, ')'), ` >> ${fx.bits}`),
        h('div', {}, h('span', { class: 'soft' }, '= '), h('span', { class: 'p' }, f(fx.acc, 12)), ` >> ${fx.bits} = `, h('span', { class: 'r' }, String(fx.out))),
        h('div', {}, h('span', { class: 'soft' }, '= '), h('span', { class: 'r' }, `${f(fx.out / fx.scale, 8)} ${u.ref}`), h('span', { class: 'soft' }, `   float: ${f(c.probeOut, 7)}`)));
    } else calc.replaceChildren(h('span', { class: 'soft' }, 'Give a raw reading to convert (drag the teal cursor).'));
  }

  // ------------------------------------------------------------ equation
  function drawEq(res) {
    const c = res.cal;
    syncVal(yUnit, String(ctx.raw.refUnit ?? '')); fit(yUnit);
    syncVal(xUnit, String(ctx.raw.rawUnit ?? '')); fit(xUnit);
    if (!c) { gainEl.textContent = '?'; offOp.textContent = '+'; offEl.textContent = '?'; stats.replaceChildren(); return; }
    gainEl.textContent = f(c.gain, 7);
    offOp.textContent = c.offset < 0 ? '−' : '+';
    offEl.textContent = f(Math.abs(c.offset), 7);
    const r2cls = c.r2 == null ? '' : c.r2 > 0.999 ? 'ok' : c.r2 > 0.99 ? 'warn' : 'bad';
    const lin = c.n > 2 && Math.abs(c.maxRes) > c.linLimit;
    stats.replaceChildren(
      h('span', {}, h('b', {}, String(c.n)), c.n === 2 ? ' points, exact line' : ' points, least squares'),
      h('span', {}, 'R² ', h('b', { class: r2cls }, c.r2 == null ? '–' : f(c.r2, 6))),
      h('span', {}, 'worst ', h('b', { class: lin ? 'warn' : '' }, `${f(c.maxRes, 3)} ${c.units.ref}`)),
      h('span', {}, 'RMS ', h('b', {}, f(c.rms, 3))),
      h('span', {}, 'inverse ', h('b', {}, `${c.units.raw} = ${f(c.inverse, 6)} × ${c.units.ref} ${c.inverseOffset < 0 ? '−' : '+'} ${f(Math.abs(c.inverseOffset), 6)}`)));
  }

  function redraw(res) {
    if (res.cal) drawPlot(res.cal);
  }

  ctx.onResult((res) => {
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    drawEq(res);
    drawRows(res);
    if (res.cal) {
      plotBox.style.opacity = '';
      drawPlot(res.cal);
      drawFirmware(res.cal);
    } else plotBox.style.opacity = '0.55';
  });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = Math.round(svg.getBoundingClientRect().width);
    if (w && w !== lastW && ctx.result?.cal && !st.drag) { lastW = w; requestAnimationFrame(() => { if (ctx.result?.cal) drawPlot(ctx.result.cal); }); }
  }).observe(plotBox);
}
