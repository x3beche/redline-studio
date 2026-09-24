// CAN bit timing, drawn as the thing itself: two nodes on a bus of the given
// length above one nominal bit in time quanta. The sample point is a handle
// dragged along the bit (it snaps to quantum boundaries and the tool picks
// the best setting for it); the far node is dragged along the bus to change
// its length, and the round trip is drawn against PROP_SEG. Every prescaler
// that works is a small bit to click; the chosen controller's registers are
// drawn as their bit fields. All numbers come from run()'s result.

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
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

const SEG = {
  sync: { long: 'SYNC_SEG', short: 'SYNC' },
  prop: { long: 'PROP_SEG', short: 'PROP' },
  ps1: { long: 'PHASE_SEG1', short: 'PS1' },
  ps2: { long: 'PHASE_SEG2', short: 'PS2' },
};
// Which bit segment a register field sets, for its colour on the card.
const FIELD_SEG = { TS1: 'ps1', NTSEG1: 'ps1', TSEG1: 'ps1', PHSEG1: 'ps1', PSEG1: 'ps1',
  TS2: 'ps2', NTSEG2: 'ps2', TSEG2: 'ps2', PHSEG2: 'ps2', PSEG2: 'ps2', PRSEG: 'prop', PROPSEG: 'prop',
  SJW: 'sjw', NSJW: 'sjw', RJW: 'sjw', BRP: 'brp', NBRP: 'brp', PRESDIV: 'brp' };
const FIELD_MEANS = { SJW: 'SJW', NSJW: 'SJW', RJW: 'SJW', BRP: 'prescaler', NBRP: 'prescaler', PRESDIV: 'prescaler',
  TS1: 'TSEG1', NTSEG1: 'TSEG1', TSEG1: 'TSEG1', TS2: 'TSEG2', NTSEG2: 'TSEG2', TSEG2: 'TSEG2',
  PHSEG1: 'PS1', PSEG1: 'PS1', PHSEG2: 'PS2', PSEG2: 'PS2', PRSEG: 'PROP', PROPSEG: 'PROP' };

const CSS = `
.cbt { --tool-sync: #6b7c8c; --tool-prop: #0f9d8a; --tool-ps1: #d97706; --tool-ps2: #a23fbf;
  --tool-trip: #26323d; --tool-sjw: #1f4ed8; --tool-brp: #5b6b7a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .cbt {
  --tool-sync: #8ea0b0; --tool-prop: #3cc7b3; --tool-ps1: #f0a33a; --tool-ps2: #c982e0;
  --tool-trip: #d7e0e8; --tool-sjw: #6d8dff; --tool-brp: #8ea0b0; } }
:root[data-theme="dark"] .cbt { --tool-sync: #8ea0b0; --tool-prop: #3cc7b3; --tool-ps1: #f0a33a; --tool-ps2: #c982e0;
  --tool-trip: #d7e0e8; --tool-sjw: #6d8dff; --tool-brp: #8ea0b0; }
.cbt { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.cbt-controls { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 6px 10px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
.cbt-controls label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--ink-soft); min-width: 0; }
.cbt-controls label.cbt-wide { grid-column: span 2; }
.cbt-controls input, .cbt-controls select { width: 100%; min-width: 0; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px;
  background: var(--sunken); font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.cbt-controls input.bad { border-color: var(--danger); }
.cbt-grid { display: grid; grid-template-columns: minmax(0, 1fr) 372px; gap: 10px; align-items: start; }
@media (max-width: 1040px) { .cbt-grid { grid-template-columns: minmax(0, 1fr); } }
.cbt-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.cbt-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.cbt-head { display: flex; align-items: baseline; gap: 6px 14px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.cbt-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.cbt-head .cbt-sub { font-size: 11.5px; color: var(--ink-soft); }
.cbt-head .cbt-sub b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.cbt-head .cbt-right { margin-left: auto; }
.cbt-svg { display: block; width: 100%; user-select: none; -webkit-user-select: none; }
.cbt-svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.cbt-svg text.soft { fill: var(--ink-soft); }
.cbt-svg text.small { font-size: 10px; }
.cbt-svg text.big { font-size: 12px; font-weight: 500; }
.cbt-svg .drag { cursor: ew-resize; touch-action: none; }
.cbt-svg .handle:focus { outline: none; }
.cbt-svg .handle:focus-visible .ring { stroke: var(--accent); stroke-width: 2.5; stroke-dasharray: 3 2; }
.cbt-svg .surface { touch-action: none; cursor: crosshair; }
.cbt-help { padding: 4px 10px 8px; font-size: 11.5px; color: var(--ink-soft); }
.cbt-help kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.cbt-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--ink-soft); }
.cbt-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; border: 1.5px solid; }
.cbt-strip { display: flex; gap: 6px; overflow-x: auto; padding: 8px 10px 10px; scrollbar-width: thin; }
.cbt-cand { flex: none; width: 150px; text-align: left; border: 1px solid var(--line); border-radius: 5px; background: var(--surface);
  padding: 5px 7px 6px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; }
.cbt-cand:hover { border-color: var(--ink-soft); }
.cbt-cand[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.cbt-cand .t { display: flex; justify-content: space-between; gap: 4px; font: 500 12px "IBM Plex Mono", ui-monospace, monospace; }
.cbt-cand .t span { color: var(--ink-soft); font-weight: 400; }
.cbt-cand .m { font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); display: flex; justify-content: space-between; }
.cbt-cand .m .w { color: var(--warn); }
.cbt-cand .m .d { color: var(--danger); }
.cbt-cand svg { display: block; width: 100%; height: 16px; }
.cbt-auto { flex: none; width: 92px; }
.cbt-auto .t { justify-content: flex-start; }
.cbt-regs { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 12px; }
.cbt-reg-top { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.cbt-reg-top b { font: 600 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.cbt-reg-top code { font-size: 15px; font-weight: 500; }
.cbt-reg-top .k-btn { margin-left: auto; padding: 1px 8px; font-size: 11px; }
.cbt-bits { display: grid; gap: 1px; margin-top: 2px; }
.cbt-bits .n { font: 9px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); text-align: center; }
.cbt-bits .b { font: 11px "IBM Plex Mono", ui-monospace, monospace; text-align: center; background: var(--sunken); color: var(--ink-soft); border-radius: 2px; padding: 2px 0; }
.cbt-bits .b.f { color: var(--ink); background: color-mix(in srgb, var(--fc) 18%, var(--surface)); box-shadow: inset 0 -2px 0 var(--fc); }
.cbt-bits .b.one { font-weight: 600; }
.cbt-bits .fl { font: 10px "IBM Plex Mono", ui-monospace, monospace; text-align: center; color: var(--ink); border-top: 1.5px solid var(--fc);
  padding-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cbt-bits .fl span { color: var(--ink-soft); }
.cbt-bits .fl.bad { color: var(--danger); }
.cbt-code { display: flex; gap: 6px; align-items: flex-start; }
.cbt-code code { flex: 1; min-width: 0; font-size: 11.5px; background: var(--sunken); border-radius: 4px; padding: 5px 7px; word-break: break-word; }
.cbt-code .k-btn { padding: 1px 8px; font-size: 11px; }
.cbt-figs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line-soft); }
.cbt-fig { background: var(--surface); padding: 5px 10px; min-width: 0; }
.cbt-fig span { display: block; font-size: 10.5px; color: var(--ink-soft); }
.cbt-fig b { display: block; font: 500 14px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cbt-fig b small { font-size: 11px; color: var(--ink-soft); font-weight: 400; }
.cbt-fig em { display: block; font-style: normal; font-size: 10.5px; color: var(--ink-soft); }
.cbt-fig.warn b { color: var(--warn); } .cbt-fig.bad b { color: var(--danger); }
.cbt-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.cbt-warns div + div { margin-top: 4px; }
.cbt-warns:empty { display: none; }
.cbt-notes { font-size: 11.5px; color: var(--ink-soft); padding: 0 2px; }
.cbt-notes summary { cursor: pointer; }
.cbt-notes div { margin-top: 4px; }
.cbt .k-out { max-height: 190px; }
`;

const niceCeil = (v) => {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1e-9)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
};
const niceStep = (range, px) => {
  const target = range / Math.max(2, Math.floor(px / 70));
  const p = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
  return 10 * p;
};

export function page(root, ctx) {
  const f = ctx.fmtNum;
  const fmtT = (sec) => {
    const a = Math.abs(sec);
    if (a >= 1e-3) return `${f(sec * 1e3, 4)} ms`;
    if (a >= 1e-6) return `${f(sec * 1e6, 4)} µs`;
    return `${f(sec * 1e9, 3)} ns`;
  };
  const fmtLen = (m) => (m >= 1000 ? `${f(m / 1000, 3)} km` : `${f(m, m < 10 ? 2 : 3)} m`);

  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'cbt' });
  root.append(wrap);

  // ---------- inputs, compact, one line on a wide screen ----------
  const byKey = Object.fromEntries(ctx.manifest.inputs.map((d) => [d.key, d]));
  const fields = {};
  const control = (key, label, opts = {}) => {
    const d = byKey[key];
    let el;
    if (d.type === 'select') {
      el = h('select', { onchange: (e) => ctx.set(key, e.target.value) },
        d.options.map(([v, t]) => h('option', { value: v }, t)));
    } else {
      el = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', placeholder: opts.placeholder || '',
        oninput: (e) => ctx.set(key, e.target.value) });
    }
    el.title = d.help || '';
    fields[key] = el;
    return h('label', { class: opts.wide ? 'cbt-wide' : null }, `${label}${d.unit ? ` (${d.unit})` : ''}`, el);
  };
  const controls = h('section', { class: 'cbt-controls', 'aria-label': 'Inputs' },
    control('controller', 'Controller', { wide: true }), control('fclk', 'CAN clock'), control('bitrate', 'Bit rate'),
    control('sp', 'Sample point', { placeholder: 'CiA 301' }), control('busLen', 'Bus length'),
    control('loopDelay', 'Loop delay'), control('tolErr', 'Max rate error'), control('brp', 'Prescaler', { placeholder: 'best' }));
  const syncFields = () => {
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(fields)) {
      if (document.activeElement === el) continue;
      el.value = raw[k] ?? '';
    }
    for (const d of ctx.manifest.inputs) {
      if (d.type !== 'number' || !fields[d.key]) continue;
      const t = String(raw[d.key] ?? '').trim();
      fields[d.key].classList.toggle('bad', t !== '' && ctx.parseEng(t) == null);
    }
  };

  // ---------- the stage: bus above, bit below ----------
  const busSub = h('span', { class: 'cbt-sub' });
  const bitSub = h('span', { class: 'cbt-sub' });
  const busSvg = s('svg', { class: 'cbt-svg', role: 'group', 'aria-label': 'Bus with two nodes' });
  const bitSvg = s('svg', { class: 'cbt-svg', role: 'group', 'aria-label': 'One nominal bit in time quanta' });
  const legend = h('div', { class: 'cbt-legend' },
    ['sync', 'prop', 'ps1', 'ps2'].map((k) => h('span', {}, h('i', { style: `background:color-mix(in srgb,var(--tool-${k}) 22%,transparent);border-color:var(--tool-${k})` }), SEG[k].long)),
    h('span', {}, h('i', { style: 'background:var(--tool-trip);border-color:var(--tool-trip);height:4px;border-width:0' }), 'round trip'));
  const stage = h('section', { class: 'cbt-card' },
    h('div', { class: 'cbt-head' }, h('h2', {}, 'Bus'), busSub),
    busSvg,
    h('div', { class: 'cbt-head', style: 'border-top:1px solid var(--line-soft)' }, h('h2', {}, 'One bit'), bitSub, h('span', { class: 'cbt-right' }, legend)),
    bitSvg,
    h('div', { class: 'cbt-help' }, 'Drag the sample point along the bit (or focus it and press ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'),
      '); it snaps to quantum boundaries. Drag Node B along the bus to change the length (', h('kbd', {}, 'Shift'), ' + arrows: 10 m).'));

  const strip = h('div', { class: 'cbt-strip', role: 'group', 'aria-label': 'Prescalers that work' });
  const stripSub = h('span', { class: 'cbt-sub' });
  const cands = h('section', { class: 'cbt-card' }, h('div', { class: 'cbt-head' }, h('h2', {}, 'Every prescaler that works'), stripSub), strip);

  const regTitle = h('h2', {}, 'Registers');
  const regSub = h('span', { class: 'cbt-sub' });
  const regBody = h('div', { class: 'cbt-regs' });
  const regs = h('section', { class: 'cbt-card' }, h('div', { class: 'cbt-head' }, regTitle, regSub), regBody);
  const figs = h('div', { class: 'cbt-figs' });
  const figCard = h('section', { class: 'cbt-card' }, h('div', { class: 'cbt-head' }, h('h2', {}, 'Result')), figs);
  const warns = h('div', { class: 'cbt-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'cbt-notes' }, h('summary', {}, 'How it is worked out'));

  wrap.append(controls, h('div', { class: 'cbt-grid' },
    h('div', { class: 'cbt-col' }, stage, cands, notes),
    h('div', { class: 'cbt-col' }, warns, figCard, regs, ctx.outputs)));

  let res = null;
  let busScale = null; // frozen while Node B is dragged
  let dragging = null;
  // Drags listen on the window: every change redraws the drawing, so the
  // element that was pressed is gone after the first move.
  const drag = (move, done) => {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragging = null;
      done();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const focusHandle = (svg) => svg.querySelector('.handle')?.focus({ preventScroll: true });

  // ---------- bus ----------
  function drawBus() {
    const had = busSvg.contains(document.activeElement);
    busSvg.replaceChildren();
    try { drawBusInner(); } finally { if (had) focusHandle(busSvg); }
  }
  function drawBusInner() {
    const d = res && res.drawing;
    const W = Math.max(300, busSvg.clientWidth || stage.clientWidth || 800);
    const H = 132;
    busSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    busSvg.setAttribute('height', H);
    if (!d) {
      busSvg.append(s('text', { x: 14, y: 60, class: 'soft' }, 'No valid setting: see the message on the right.'));
      busSub.textContent = '';
      return;
    }
    const narrow = W < 560;
    const nw = narrow ? 62 : 96, nh = 46, L = 12, R = 12, yN = 26;
    const x0 = L + nw, x1 = W - R - nw;
    const scale = busScale || niceCeil(Math.max(d.busLen, d.maxLen, 10) * 1.12);
    const X = (len) => x0 + (Math.min(len, scale) / scale) * (x1 - x0);
    const xB = X(d.busLen);
    const over = d.busLen > d.maxLen;
    const yH = yN + 17, yL = yN + 29;

    // Scale ruler with the region a longer bus cannot reach in this timing.
    const yR = 104;
    if (d.maxLen < scale) {
      const xm = X(d.maxLen);
      busSvg.append(s('rect', { x: xm, y: yN - 4, width: Math.max(0, x1 + nw - xm), height: yR - yN + 4, fill: 'var(--danger)', 'fill-opacity': 0.07 }));
      busSvg.append(s('rect', { x: xm, y: yR - 5, width: Math.max(0, x1 - xm), height: 5, fill: 'var(--danger)', 'fill-opacity': 0.45 }));
      busSvg.append(s('line', { x1: xm, x2: xm, y1: yN - 4, y2: yR, stroke: 'var(--danger)', 'stroke-dasharray': '4 3', 'stroke-width': 1.2 }));
      const lab = `max ${fmtLen(d.maxLen)}`;
      const anchorEnd = xm > W - 90;
      busSvg.append(s('text', { x: anchorEnd ? xm - 4 : xm + 4, y: yN - 8, 'text-anchor': anchorEnd ? 'end' : 'start', class: 'small', fill: 'var(--danger)', style: 'fill:var(--danger)' }, lab));
    }
    busSvg.append(s('line', { x1: x0, x2: x1, y1: yR, y2: yR, stroke: 'var(--line)' }));
    const step = niceStep(scale, x1 - x0);
    for (let m = 0; m <= scale + 1e-9; m += step) {
      const x = X(m);
      busSvg.append(s('line', { x1: x, x2: x, y1: yR, y2: yR + 4, stroke: 'var(--ink-soft)' }));
      busSvg.append(s('text', { x, y: yR + 15, 'text-anchor': 'middle', class: 'soft small' }, m === 0 ? '0' : fmtLen(m)));
    }

    // The pair and the terminators.
    for (const [y, name] of [[yH, 'CAN_H'], [yL, 'CAN_L']]) {
      busSvg.append(s('line', { x1: x0, x2: xB, y1: y, y2: y, stroke: over ? 'var(--danger)' : 'var(--ink-soft)', 'stroke-width': 1.6 }));
      busSvg.append(s('title', {}, name));
    }
    // Where the far node would sit if the bus were at its limit, as a ghost.
    // One-way delay arrows: A -> B above, B -> A below.
    if (xB - x0 > 40) {
      const mid = (x0 + xB) / 2;
      const arrow = (xa, xb, y) => {
        const dir = Math.sign(xb - xa) || 1;
        busSvg.append(s('line', { x1: xa, x2: xb - dir * 5, y1: y, y2: y, stroke: 'var(--tool-trip)', 'stroke-width': 1.3, 'stroke-dasharray': '5 3' }));
        busSvg.append(s('path', { d: `M${xb},${y}l${-dir * 7},-3.5v7z`, fill: 'var(--tool-trip)' }));
      };
      arrow(x0 + 4, xB - 4, yN + 4);
      arrow(xB - 4, x0 + 4, yN + 41);
      const t = `${fmtT(d.tBus)} each way`;
      if (xB - x0 > 150) {
        busSvg.append(s('rect', { x: mid - 50, y: yN - 5, width: 100, height: 14, fill: 'var(--surface)' }));
        busSvg.append(s('text', { x: mid, y: yN + 6, 'text-anchor': 'middle', class: 'small' }, t));
      }
    }

    const node = (x, name, sub, extra = {}, stroke = 'var(--ink-soft)') => {
      const g = s('g', extra);
      g.append(s('rect', { class: 'ring', x, y: yN, width: nw, height: nh, rx: 4, fill: 'var(--sunken)', stroke, 'stroke-width': 1.4 }));
      g.append(s('text', { x: x + nw / 2, y: yN + 18, 'text-anchor': 'middle', class: 'big' }, name));
      g.append(s('text', { x: x + nw / 2, y: yN + 33, 'text-anchor': 'middle', class: 'soft small' }, sub));
      return g;
    };
    busSvg.append(node(L, 'Node A', narrow ? 'sends' : `loop ${fmtT(d.tLoop)}`));
    const b = node(xB, 'Node B', narrow ? fmtLen(d.busLen) : `at ${fmtLen(d.busLen)}`, {
      class: 'handle drag', tabindex: 0, role: 'slider', 'aria-label': 'Bus length (Node B position)',
      'aria-valuemin': 0, 'aria-valuenow': d.busLen, 'aria-valuetext': `${fmtLen(d.busLen)}`,
    }, over ? 'var(--danger)' : 'var(--accent)');
    // Grip marks so it reads as something to drag.
    if (!narrow) for (const dx of [-3, 0, 3]) b.append(s('line', { x1: xB + nw - 10 + dx, x2: xB + nw - 10 + dx, y1: yN + 16, y2: yN + 30, stroke: 'var(--ink-soft)' }));
    busSvg.append(b);

    const setLen = (len) => {
      const snapTo = len < 20 ? 0.5 : len < 200 ? 1 : len < 1000 ? 5 : 10;
      const v = Math.max(0, Math.round(len / snapTo) * snapTo);
      if (v !== ctx.input.busLen) ctx.set('busLen', String(v));
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.focus({ preventScroll: true });
      busScale = scale;
      const pt = (ev) => (ev.clientX - busSvg.getBoundingClientRect().left) * (W / busSvg.getBoundingClientRect().width);
      const grab = pt(e) - xB;
      dragging = 'bus';
      const move = (ev) => setLen(((pt(ev) - grab - x0) / (x1 - x0)) * scale);
      drag(move, () => { busScale = null; drawBus(); focusHandle(busSvg); });
    });
    b.addEventListener('keydown', (e) => {
      const step1 = e.shiftKey ? 10 : 1;
      let v = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = d.busLen + step1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = d.busLen - step1;
      if (e.key === 'End') v = Math.floor(d.maxLen);
      if (e.key === 'Home') v = 0;
      if (v == null) return;
      e.preventDefault();
      ctx.set('busLen', String(Math.max(0, Math.round(v))));
    });

    busSub.replaceChildren('round trip 2 × (', h('b', {}, fmtT(d.tBus)), ' bus + ', h('b', {}, fmtT(d.tLoop)), ' loop) = ',
      h('b', { style: over ? 'color:var(--danger)' : null }, fmtT(d.tProp)),
      ` · fits up to `, h('b', {}, fmtLen(d.maxLen)), ' at this timing');
  }

  // ---------- one bit ----------
  function snapK(d, frac) {
    const lim = d.limits;
    const n = d.n;
    const lo = Math.max(1 + lim.ts1[0], n - lim.ts2[1], Math.ceil(0.5 * n - 1e-9));
    const hi = Math.min(1 + lim.ts1[1], n - lim.ts2[0], Math.floor(0.95 * n + 1e-9));
    return Math.max(lo, Math.min(hi, Math.round(frac * n)));
  }
  const setSpK = (d, k) => {
    const v = String(Number(((k / d.n) * 100).toPrecision(6)));
    if (Math.abs(k / d.n - d.sp) > 1e-9 || String(ctx.raw.sp) !== v) ctx.set('sp', v);
  };

  function drawBit() {
    const had = bitSvg.contains(document.activeElement);
    bitSvg.replaceChildren();
    try { drawBitInner(); } finally { if (had) focusHandle(bitSvg); }
  }
  function drawBitInner() {
    const d = res && res.drawing;
    const W = Math.max(300, bitSvg.clientWidth || stage.clientWidth || 800);
    const H = 214;
    bitSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    bitSvg.setAttribute('height', H);
    if (!d) { bitSub.textContent = ''; return; }
    const L = 14, R = 14, n = d.n;
    const q = (W - L - R) / n;
    const X = (k) => L + k * q;
    const yB = 62, hB = narrowH(W);
    const yBot = yB + hB;
    const segs = [['sync', d.sync], ['prop', d.prop], ['ps1', d.ps1], ['ps2', d.ps2]].filter((x) => x[1] > 0);

    // Segment names with brackets.
    let k = 0;
    for (const [key, len] of segs) {
      const xa = X(k), xb = X(k + len), w = xb - xa;
      const full = `${SEG[key].long} · ${len} tq`, mid = `${SEG[key].short} ${len}`;
      const lab = w > full.length * 6.8 + 6 ? full : w > mid.length * 6.8 + 4 ? mid : w > 10 ? String(len) : '';
      bitSvg.append(s('path', { d: `M${xa + 1.5},${30}v-5h${w - 3}v5`, fill: 'none', stroke: `var(--tool-${key})`, 'stroke-width': 1.4 }));
      if (lab) bitSvg.append(s('text', { x: (xa + xb) / 2, y: 18, 'text-anchor': 'middle', style: `fill:var(--tool-${key})`, class: 'big' }, lab));
      const tt = s('title', {}, `${SEG[key].long}: ${len} tq = ${fmtT(len * d.tq)}`);
      // Quanta.
      for (let i = 0; i < len; i++) {
        const gap = q >= 8 ? 1.5 : q >= 4 ? 0.5 : 0;
        const r = s('rect', { x: X(k + i) + gap / 2, y: yB, width: Math.max(0.5, q - gap), height: hB, rx: q >= 8 ? 2 : 0,
          fill: `var(--tool-${key})`, 'fill-opacity': 0.2, stroke: q >= 4 ? `var(--tool-${key})` : 'none', 'stroke-width': 1.2 });
        r.append(tt.cloneNode(true));
        bitSvg.append(r);
        if (q >= 18) bitSvg.append(s('text', { x: X(k + i) + q / 2, y: yB + hB / 2 + 4, 'text-anchor': 'middle', class: 'soft small', 'pointer-events': 'none' }, String(k + i + 1)));
      }
      k += len;
    }
    // Continuous outline when quanta are too thin to draw one by one.
    if (q < 4) {
      let kk = 0;
      for (const [key, len] of segs) { bitSvg.append(s('rect', { x: X(kk), y: yB, width: len * q, height: hB, fill: 'none', stroke: `var(--tool-${key})`, 'stroke-width': 1.4 })); kk += len; }
    }

    // Time axis under the bit.
    const yT = yBot + 4;
    const every = Math.max(1, Math.ceil(24 / q));
    for (let i = 0; i <= n; i++) {
      if (i % every && i !== n) continue;
      bitSvg.append(s('line', { x1: X(i), x2: X(i), y1: yT, y2: yT + 4, stroke: 'var(--ink-soft)' }));
    }
    const xs = X(d.sp * n);
    const tlab = (x, text, anchor) => bitSvg.append(s('text', { x, y: yT + 16, 'text-anchor': anchor, class: 'soft small' }, text));
    tlab(L, '0', 'start');
    tlab(W - R, fmtT(n * d.tq), 'end');
    if (xs - L > 60 && W - R - xs > 60) tlab(xs, fmtT(d.sp * n * d.tq), 'middle');

    // Round trip against PROP_SEG: from the end of SYNC_SEG for tProp.
    const yP = yT + 30;
    const tripQ = d.tProp / d.tq;
    const xPa = X(1), xPb = X(1) + tripQ * q;
    const xPropEnd = X(1 + d.prop);
    bitSvg.append(s('line', { x1: xPropEnd, x2: xPropEnd, y1: yB, y2: yP + 14, stroke: 'var(--tool-prop)', 'stroke-dasharray': '3 3' }));
    const overSp = xPb > xs + 0.5;
    const noPs1 = d.ps1 < 1;
    bitSvg.append(s('rect', { x: xPa, y: yP + 1, width: Math.max(1, Math.min(xPb, xs) - xPa), height: 6, fill: noPs1 ? 'var(--danger)' : 'var(--tool-trip)', 'fill-opacity': noPs1 ? 0.6 : 0.8, rx: 1.5 }));
    if (overSp) {
      bitSvg.append(s('rect', { x: xs, y: yP - 2, width: xPb - xs, height: 12, fill: 'var(--danger)', rx: 1.5 }));
    }
    bitSvg.append(s('path', { d: `M${xPa},${yP - 4}v16`, stroke: 'var(--tool-trip)', 'stroke-width': 1.5 }));
    const tripText = overSp
      ? `round trip ${fmtT(d.tProp)} = ${f(tripQ, 3)} tq, ${fmtT(d.tProp - (d.sp * n - 1) * d.tq)} past the sample point`
      : noPs1 ? `round trip ${fmtT(d.tProp)} = ${f(tripQ, 3)} tq leaves no PHASE_SEG1`
        : `round trip ${fmtT(d.tProp)} = ${f(tripQ, 3)} tq → PROP_SEG ${d.propNeed} tq`;
    const tx = Math.max(xPb, xPropEnd) + 6;
    const tw = tripText.length * 6.1;
    const bad = overSp || noPs1;
    if (tx + tw < W - R) bitSvg.append(s('text', { x: tx, y: yP + 8, class: 'small', style: bad ? 'fill:var(--danger)' : null }, tripText));
    else bitSvg.append(s('text', { x: W - R, y: yP + 24, 'text-anchor': 'end', class: 'small', style: bad ? 'fill:var(--danger)' : null }, tripText));

    // SJW: how far one edge moves the sample point (PS1 lengthened / PS2 shortened).
    const yS = yP + 40;
    const sj = d.sjw * q;
    bitSvg.append(s('path', { d: `M${xs - sj},${yS - 5}v5H${xs + sj}v-5`, fill: 'none', stroke: 'var(--tool-sjw)', 'stroke-width': 1.5 }));
    bitSvg.append(s('rect', { x: xs - sj, y: yB, width: 2 * sj, height: hB, fill: 'var(--tool-sjw)', 'fill-opacity': 0.08, 'pointer-events': 'none' }));
    const sjText = `SJW ${d.sjw} tq: an edge moves the sample point by up to ±${fmtT(d.sjw * d.tq)}`;
    const sjShort = `SJW ±${d.sjw} tq`;
    const sjLab = W > 620 ? sjText : sjShort;
    const sjw = sjLab.length * 6.1;
    const sjx = Math.min(W - R - sjw, Math.max(L, xs - sjw / 2));
    bitSvg.append(s('text', { x: sjx, y: yS + 12, class: 'small', style: 'fill:var(--tool-sjw)' }, sjLab));

    // Target, when the sample point could not land on it.
    const offTarget = Math.abs(d.sp - d.target) > 0.02;
    if (Math.abs(d.sp - d.target) > 5e-4) {
      const xt = X(d.target * n);
      bitSvg.append(s('line', { x1: xt, x2: xt, y1: yB - 4, y2: yBot + 4, stroke: 'var(--ink-soft)', 'stroke-dasharray': '2 3', 'stroke-width': 1.2 }));
    }

    // The sample point handle.
    const col = offTarget ? 'var(--warn)' : 'var(--accent)';
    const hg = s('g', { class: 'handle drag', tabindex: 0, role: 'slider', 'aria-label': 'Sample point',
      'aria-valuemin': 50, 'aria-valuemax': 95, 'aria-valuenow': f(d.sp * 100, 4), 'aria-valuetext': `${f(d.sp * 100, 4)} %, ${Math.round(d.sp * n)} of ${n} tq` });
    const plab = `SP ${f(d.sp * 100, 4)} %`;
    const pw = plab.length * 7 + 14;
    const px = Math.max(L, Math.min(W - R - pw, xs - pw / 2));
    hg.append(s('line', { x1: xs, x2: xs, y1: 52, y2: yBot + 6, stroke: col, 'stroke-width': 2.5 }));
    hg.append(s('rect', { class: 'ring', x: px, y: 34, width: pw, height: 19, rx: 9.5, fill: col, stroke: col }));
    hg.append(s('text', { x: px + pw / 2, y: 47.5, 'text-anchor': 'middle', style: 'fill:var(--accent-ink)', class: 'big' }, plab));
    hg.append(s('path', { d: `M${xs - 5},${53}h10l-5,6z`, fill: col }));
    // A wide invisible grip around the line.
    hg.append(s('rect', { x: xs - 10, y: 34, width: 20, height: yBot - 28, fill: 'transparent' }));

    // Drag surface: the whole bit. Press anywhere to move the sample point there.
    const surf = s('rect', { class: 'surface', x: L, y: yB, width: W - L - R, height: hB, fill: 'transparent' });
    bitSvg.append(surf, hg);
    const toFrac = (ev) => {
      const r = bitSvg.getBoundingClientRect();
      return ((ev.clientX - r.left) * (W / r.width) - L) / (W - L - R);
    };
    const start = (e) => {
      e.preventDefault();
      hg.focus({ preventScroll: true });
      dragging = 'sp';
      const move = (ev) => { const dd = res && res.drawing; if (dd) setSpK(dd, snapK(dd, toFrac(ev))); };
      move(e);
      drag(move, () => { drawCands(); focusHandle(bitSvg); });
    };
    hg.addEventListener('pointerdown', start);
    surf.addEventListener('pointerdown', start);
    hg.addEventListener('keydown', (e) => {
      const cur = Math.round(d.sp * n);
      let k2 = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') k2 = cur + 1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') k2 = cur - 1;
      if (e.key === 'Home') k2 = 0;
      if (e.key === 'End') k2 = n;
      if (k2 == null) return;
      e.preventDefault();
      setSpK(d, snapK(d, k2 / n));
    });

    bitSub.replaceChildren(d.invalid ? h('b', { style: 'color:var(--danger)' }, 'Not legal · ') : '', h('b', {}, `${n} tq`), ' × ', h('b', {}, fmtT(d.tq)), ' = ', h('b', {}, fmtT(n * d.tq)),
      ` · BRP ${d.brp}${d.pinned ? ' (pinned)' : ''} · sample at `, h('b', { style: offTarget ? 'color:var(--warn)' : null }, `${f(d.sp * 100, 4)} %`),
      ` (target ${f(d.target * 100, 4)} %)`);
  }
  const narrowH = (W) => (W < 520 ? 46 : 58);

  // ---------- candidates ----------
  function drawCands() {
    const d = res && res.drawing;
    strip.replaceChildren();
    if (!d) { stripSub.textContent = ''; return; }
    if (!d.candidates.length) { stripSub.textContent = 'none: no prescaler gives a legal setting for this bus and bit rate'; return; }
    stripSub.textContent = `${d.candidates.length} prescaler${d.candidates.length === 1 ? '' : 's'}, best sample point for each · click one to use it`;
    const auto = h('button', { class: 'cbt-cand cbt-auto', 'aria-pressed': String(!d.pinned), title: 'Let the tool pick the prescaler',
      onclick: () => ctx.set('brp', '') }, h('div', { class: 't' }, 'Best'), h('div', { class: 'm' }, 'auto'));
    strip.append(auto);
    for (const c of d.candidates) {
      const mini = s('svg', { viewBox: `0 0 ${c.n} 4`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      let k = 0;
      for (const [key, len] of [['sync', 1], ['prop', c.prop], ['ps1', c.ps1], ['ps2', c.ts2]]) {
        if (len > 0) mini.append(s('rect', { x: k, y: 0, width: len, height: 4, fill: `var(--tool-${key})`, 'fill-opacity': 0.75 }));
        k += len;
      }
      for (let i = 1; i < c.n && c.n <= 40; i++) mini.append(s('line', { x1: i, x2: i, y1: 0, y2: 4, stroke: 'var(--surface)', 'stroke-width': 0.08 }));
      mini.append(s('rect', { x: c.sp * c.n - 0.12, y: 0, width: Math.max(0.24, c.n / 150), height: 4, fill: 'var(--ink)' }));
      const on = c.brp === d.brp;
      const errTxt = c.err === 0 ? 'exact' : `${c.err > 0 ? '+' : ''}${f(c.err * 100, 2)} %`;
      const btn = h('button', { class: 'cbt-cand', 'aria-pressed': String(on),
        title: `BRP ${c.brp}: ${c.n} tq, TSEG1 ${c.ts1}, TSEG2 ${c.ts2}, SJW ${c.sjw}, sample point ${f(c.sp * 100, 4)} %, rate ${errTxt}, oscillator ±${f(c.df * 100, 3)} %`,
        onclick: () => ctx.setMany({ brp: String(c.brp), sp: String(Number((c.sp * 100).toPrecision(6))) }) },
        h('div', { class: 't' }, `BRP ${c.brp}`, h('span', {}, `${c.n} tq`)),
        mini,
        h('div', { class: 'm' }, h('span', {}, `${f(c.sp * 100, 3)} %`),
          c.ps1 < 1 ? h('span', { class: 'd' }, 'prop too long') : c.err !== 0 ? h('span', { class: 'w' }, errTxt) : h('span', {}, `±${f(c.df * 100, 2)} %`)));
      strip.append(btn);
    }
    if (!dragging) requestAnimationFrame(scrollSel);
  }

  // Keep the chosen prescaler in view in the strip.
  function scrollSel() {
    const sel = strip.querySelector('.cbt-cand[aria-pressed="true"]:not(.cbt-auto)');
    if (!sel || !strip.clientWidth) return;
    const l = sel.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft, r = l + sel.offsetWidth;
    if (l < strip.scrollLeft || r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, l - Math.max(0, (strip.clientWidth - sel.offsetWidth) / 2));
  }

  // ---------- registers ----------
  const segVar = (name) => {
    const k = FIELD_SEG[name];
    return k === 'sjw' ? 'var(--tool-sjw)' : k === 'brp' ? 'var(--tool-brp)' : k ? `var(--tool-${k})` : 'var(--ink-soft)';
  };
  const copyBtn = (text) => {
    const b = h('button', { class: 'k-btn', onclick: async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
      b.textContent = ok ? 'Copied' : 'Select it';
      setTimeout(() => { b.textContent = 'Copy'; }, 1200);
    } }, 'Copy');
    return b;
  };
  function drawRegs() {
    regBody.replaceChildren();
    const d = res && res.drawing;
    const table = res && (res.tables || []).find((t) => t.title === 'Registers');
    if (!d || !table) { regSub.textContent = ''; regBody.append(h('div', { class: 'cbt-sub' }, 'No setting to write.')); return; }
    const sel = byKey.controller.options.find(([v]) => v === d.controller);
    regSub.textContent = sel ? sel[1] : '';
    for (const reg of d.registers) {
      const row = table.rows.find((r) => r[0] === reg.name);
      const val = row ? row[1] : '';
      const perRow = reg.bits > 16 ? 16 : reg.bits;
      const box = h('div', {});
      box.append(h('div', { class: 'cbt-reg-top' }, h('b', {}, reg.name), h('code', {}, val), copyBtn(val)));
      const fieldAt = (bit) => reg.fields.find((fl) => bit <= fl.hi && bit >= fl.lo);
      for (let top = reg.bits - 1; top >= 0; top -= perRow) {
        const grid = h('div', { class: 'cbt-bits', style: `grid-template-columns:repeat(${perRow},minmax(0,1fr))` });
        const lo = top - perRow + 1;
        for (let bit = top; bit >= lo; bit--) grid.append(h('div', { class: 'n' }, String(bit)));
        for (let bit = top; bit >= lo; bit--) {
          const fl = fieldAt(bit);
          const one = fl ? (fl.value >= 0 ? Math.floor(fl.value / 2 ** (bit - fl.lo)) % 2 : 1) : 0;
          grid.append(h('div', { class: `b${fl ? ' f' : ''}${one ? ' one' : ''}`, style: fl ? `--fc:${segVar(fl.name)}` : null,
            title: fl ? `${reg.name}[${bit}] · ${fl.name}` : `${reg.name}[${bit}] reserved` }, String(one)));
        }
        // Field names under their bits.
        let col = 1;
        for (let bit = top; bit >= lo;) {
          const fl = fieldAt(bit);
          if (!fl) { const start = bit; while (bit >= lo && !fieldAt(bit)) bit--; col += start - bit; continue; }
          const end = Math.max(fl.lo, lo);
          const span = bit - end + 1;
          const width = fl.hi - fl.lo + 1;
          const badVal = fl.value < 0 || fl.value >= 2 ** width;
          const means = FIELD_MEANS[fl.name];
          const long = `${fl.name}=${fl.value}`;
          const txt = span >= 5 && means ? [`${fl.name}=${fl.value} `, h('span', {}, `(${means} ${fl.value + 1})`)] : span >= 3 ? long : span >= 2 ? String(fl.value) : '';
          grid.append(h('div', { class: `fl${badVal ? ' bad' : ''}`, style: `grid-column:${col}/span ${span};--fc:${segVar(fl.name)}`,
            title: `${fl.name} [${fl.hi}:${fl.lo}] = ${fl.value}${means ? ` → ${means} = ${fl.value + 1}` : ''}${badVal ? ' - does not fit the field' : ''}` },
          span >= 5 && means && perRow * 22 > 300 ? txt : span >= 3 ? long : txt));
          col += span;
          bit = end - 1;
        }
        box.append(grid);
      }
      regBody.append(box);
    }
    for (const r of table.rows.filter((row) => !d.registers.some((g) => g.name === row[0]))) {
      regBody.append(h('div', {}, h('div', { class: 'cbt-reg-top' }, h('b', {}, r[0]), r[2] ? h('span', { class: 'cbt-sub' }, r[2]) : null),
        h('div', { class: 'cbt-code' }, h('code', {}, r[1]), r[1] !== '–' ? copyBtn(r[1]) : null)));
    }
    regBody.append(h('div', { class: 'cbt-sub', style: 'font-size:11px;color:var(--ink-soft)' }, 'Fields hold value − 1. Underline colour = the bit segment it sets.'));
  }

  // ---------- figures, warnings, notes ----------
  function drawSide() {
    figs.replaceChildren();
    const vals = (res && res.values) || [];
    const pick = ['Actual bit rate', 'Sample point', 'Oscillator tolerance', 'Quanta per bit'];
    for (const label of pick) {
      const v = vals.find((x) => x.label === label);
      if (!v) continue;
      figs.append(h('div', { class: `cbt-fig${v.tone === 'warn' ? ' warn' : v.tone === 'bad' ? ' bad' : ''}` },
        h('span', {}, v.label), h('b', {}, String(v.value), v.unit ? h('small', {}, ` ${v.unit}`) : null), v.hint ? h('em', {}, v.hint) : null));
    }
    figCard.style.display = vals.length ? '' : 'none';
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'How it is worked out'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }

  function draw() {
    drawBus();
    drawBit();
    drawCands();
    drawRegs();
    drawSide();
  }

  ctx.onResult((r) => { res = r; syncFields(); draw(); });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = stage.clientWidth;
    if (w !== lastW) { lastW = w; drawBus(); drawBit(); scrollSel(); }
  }).observe(stage);
}
