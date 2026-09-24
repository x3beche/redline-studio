// I2C pull-up: the page is the bus itself.
//   Bus    - VDD rail, the two pull-ups, SDA and SCL running past the devices;
//            add or remove devices, drag the end of the wiring: that builds the
//            bus capacitance (the budget bar under it adds it up).
//   Edge   - the rising edge from 0 to VDD, 30 % / 70 % thresholds, the rise
//            time measured on it and the chosen speed mode's limit as a wall.
//            The three speed modes sit on its time axis: click one.
//   Ruler  - a log resistor ruler, Rmin..Rmax shaded, the series' standard
//            values as ticks; drag the pull-up along it.
// Every number shown comes from run()'s result.bus; the page only draws it.
import { fmtEng, standard, SERIES } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const MAX_DEVICES = 12;

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
const txt = (x, y, s, cls = '', anchor = 'start', extra = {}) => sv('text', { x, y, class: cls, 'text-anchor': anchor, ...extra }, s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const E = (v, u, d = 3) => fmtEng(v, u, d);
const compactR = (v) => E(v, '').replace(/\s+/g, '');
const pF = (f) => f * 1e12;

// All standard values of a series between lo and hi.
function ladder(series, lo, hi) {
  const out = [];
  for (let d = 1; d <= 1e7; d *= 10) for (const s of SERIES[series] || SERIES.E24) {
    const v = Number((s * d).toPrecision(3));
    if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
  }
  return out;
}

const CSS = `
.i2c { --tool-sda: var(--tool-s0); --tool-scl: var(--tool-s2); --tool-wire: var(--tool-s1); --tool-chip: #26313b; --tool-chip-ink: #e9eef3;
  display: grid; grid-template-columns: minmax(0, 1.28fr) minmax(0, 1fr); gap: 12px; align-items: start; }
:root[data-theme="dark"] .i2c { --tool-chip: #0b1116; --tool-chip-ink: #dfe7ee; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .i2c { --tool-chip: #0b1116; --tool-chip-ink: #dfe7ee; } }
.i2c-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.i2c-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); min-height: 38px; }
.i2c-head h2 { font-size: 12.5px; font-weight: 600; margin: 0; }
.i2c-head .i2c-sub { color: var(--ink-soft); font-size: 11.5px; }
.i2c-head .i2c-grow { flex: 1; }
.i2c-f { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-soft); }
.i2c-f input { width: 58px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.i2c-f input.bad { border-color: var(--danger); }
.i2c-f.rp input { width: 84px; }
.i2c-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.i2c-seg button { border: 0; background: transparent; padding: 2px 8px; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.i2c-seg button + button { border-left: 1px solid var(--line); }
.i2c-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.i2c-draw { position: relative; touch-action: none; user-select: none; -webkit-user-select: none; }
.i2c-draw svg { display: block; width: 100%; overflow: visible; }
.i2c-foot { padding: 4px 10px 7px; color: var(--ink-soft); font-size: 11px; display: flex; gap: 6px 14px; flex-wrap: wrap; align-items: center; }
.i2c-foot kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }
.i2c-edit { display: flex; gap: 6px 10px; flex-wrap: wrap; align-items: center; padding: 6px 10px; border-top: 1px solid var(--line-soft); font-size: 11.5px; }
.i2c-edit b { font-weight: 600; }
.i2c-edit .i2c-f input { width: 120px; }
.i2c-edit .i2c-f.pf input { width: 52px; }
.i2c-bus { grid-column: 1; grid-row: 1; }
.i2c-edge { grid-column: 2; grid-row: 1; }
.i2c-ruler { grid-column: 1; grid-row: 2; }
.i2c-side { grid-column: 2; grid-row: 2; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.i2c-side .k-out { max-height: 220px; }
.i2c-warns:empty { display: none; }
@media (max-width: 1080px) {
  .i2c { grid-template-columns: minmax(0, 1fr); }
  .i2c-bus, .i2c-edge, .i2c-ruler, .i2c-side { grid-column: 1; grid-row: auto; }
}
/* drawing */
.i2c svg text { font: 11px "IBM Plex Sans", -apple-system, sans-serif; fill: var(--ink); }
.i2c svg .m { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 10.5px; }
.i2c svg .soft { fill: var(--ink-soft); }
.i2c svg .b { font-weight: 600; }
.i2c svg .sm { font-size: 9.5px; }
.i2c svg .lbl-bg { fill: var(--surface); }
.i2c svg .rail { stroke: var(--danger); stroke-width: 2.5; }
.i2c svg .gnd { stroke: var(--ink-soft); stroke-width: 1.5; }
.i2c svg .sda { stroke: var(--tool-sda); stroke-width: 2.5; fill: none; }
.i2c svg .scl { stroke: var(--tool-scl); stroke-width: 2.5; fill: none; }
.i2c svg .sda-f { fill: var(--tool-sda); } .i2c svg .scl-f { fill: var(--tool-scl); }
.i2c svg .res { fill: var(--surface); stroke: var(--ink); stroke-width: 1.5; }
.i2c svg .chip { fill: var(--tool-chip); stroke: var(--line); stroke-width: 1; }
.i2c svg .chip-t { fill: var(--tool-chip-ink); }
.i2c svg .chip-pin { fill: var(--ink-soft); }
.i2c svg g.dev { cursor: pointer; outline: none; }
.i2c svg g.dev:focus-visible .chip, .i2c svg g.dev.sel .chip { stroke: var(--accent); stroke-width: 2; }
.i2c svg g.add { cursor: pointer; outline: none; }
.i2c svg g.add rect { fill: transparent; stroke: var(--line); stroke-dasharray: 4 3; }
.i2c svg g.add:hover rect, .i2c svg g.add:focus-visible rect { stroke: var(--accent); }
.i2c svg g.add text { fill: var(--ink-soft); }
.i2c svg g.add:hover text, .i2c svg g.add:focus-visible text { fill: var(--accent); }
.i2c svg g.x { cursor: pointer; }
.i2c svg g.x circle { fill: var(--surface); stroke: var(--line); }
.i2c svg g.x:hover circle { stroke: var(--danger); }
.i2c svg g.x path { stroke: var(--ink-soft); stroke-width: 1.5; }
.i2c svg .wire-ghost { stroke: var(--line); stroke-width: 1.5; stroke-dasharray: 3 4; }
.i2c svg .tick { stroke: var(--line); stroke-width: 1; }
.i2c svg .grid { stroke: var(--line-soft); stroke-width: 1; }
.i2c svg .axis { stroke: var(--ink-soft); stroke-width: 1; }
.i2c svg g.knob { cursor: ew-resize; outline: none; }
.i2c svg g.knob.v { cursor: ns-resize; }
.i2c svg g.knob .cap { fill: var(--surface); stroke: var(--tool-wire); stroke-width: 2; }
.i2c svg g.knob:focus-visible .cap, .i2c svg g.knob:hover .cap { stroke-width: 3; }
.i2c svg g.knob:focus-visible .ring { stroke: var(--accent); stroke-width: 2; fill: none; }
.i2c svg .wire-f { fill: var(--tool-wire); }
.i2c svg .dev-f { fill: var(--tool-s0); }
.i2c svg .over { fill: var(--danger); fill-opacity: var(--fill-alpha); }
.i2c svg .limit { stroke: var(--danger); stroke-width: 1.5; }
.i2c svg .danger { fill: var(--danger); } .i2c svg .ok-t { fill: var(--ok); }
.i2c svg .wall { fill: url(#i2c-hatch); }
.i2c svg .wall-edge { stroke: var(--danger); stroke-width: 1.5; }
.i2c svg .hatch-l { stroke: var(--danger); stroke-opacity: .45; stroke-width: 1; }
.i2c svg .env { fill: var(--ok); fill-opacity: calc(var(--fill-alpha) * .8); }
.i2c svg .env-l { stroke: var(--ok); stroke-width: 1; stroke-dasharray: 3 3; fill: none; }
.i2c svg .edge { stroke: var(--accent); stroke-width: 2.5; fill: none; stroke-linejoin: round; }
.i2c svg .edge.bad { stroke: var(--danger); }
.i2c svg .thr { stroke: var(--ink-soft); stroke-width: 1; stroke-dasharray: 5 4; }
.i2c svg .dim { stroke: var(--ink); stroke-width: 1; }
.i2c svg .dot { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.i2c svg .dot.bad { fill: var(--danger); }
.i2c svg g.spd { cursor: pointer; outline: none; }
.i2c svg g.spd rect { fill: var(--surface); stroke: var(--line); }
.i2c svg g.spd:hover rect { stroke: var(--ink-soft); }
.i2c svg g.spd[aria-pressed="true"] rect { fill: var(--accent); stroke: var(--accent); }
.i2c svg g.spd[aria-pressed="true"] text { fill: var(--accent-ink); }
.i2c svg g.spd:focus-visible rect { stroke: var(--accent); stroke-width: 2; }
.i2c svg .band { fill: var(--ok); fill-opacity: var(--fill-alpha); }
.i2c svg .band-e { stroke: var(--ok); stroke-width: 2; }
.i2c svg .bad-zone { fill: url(#i2c-hatch); }
.i2c svg .track { stroke: var(--line); stroke-width: 1; }
.i2c svg .sug { fill: var(--ok); }
.i2c svg g.rh { cursor: ew-resize; outline: none; }
.i2c svg g.rh .stem { stroke: var(--accent); stroke-width: 2; }
.i2c svg g.rh .knobc { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.i2c svg g.rh.bad .stem { stroke: var(--danger); } .i2c svg g.rh.bad .knobc { fill: var(--danger); }
.i2c svg g.rh .tag { fill: var(--accent); }
.i2c svg g.rh.bad .tag { fill: var(--danger); }
.i2c svg g.rh .tag-t { fill: var(--accent-ink); font-weight: 600; }
.i2c svg g.rh:focus-visible .ring { stroke: var(--accent); stroke-width: 2; fill: none; }
.i2c svg .rlink { cursor: pointer; }
.i2c svg .rlink:hover .res { stroke: var(--accent); }
`;

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const state = { sel: 0, drag: null };

  // ---------- panels ----------
  const field = (label, unit, key, cls = '', aria) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria || label,
      oninput: (e) => ctx.set(key, e.target.value) });
    inp.value = ctx.raw[key] ?? '';
    return { el: h('label', { class: `i2c-f ${cls}` }, label, inp, unit), inp, key };
  };
  const vddF = field('VDD', 'V', 'vdd', '', 'Bus supply in volts');
  const pfcmF = field('wiring', 'pF/cm', 'pfcm', '', 'Wiring capacitance in pF per cm');
  const cbIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Bus capacitance in pF',
    oninput: (e) => ctx.set('cb', e.target.value) });
  const cbF = h('label', { class: 'i2c-f' }, 'Cb', cbIn, 'pF');

  const busDraw = h('div', { class: 'i2c-draw' });
  const devEdit = h('div', { class: 'i2c-edit' });
  const busPanel = h('section', { class: 'i2c-panel i2c-bus', 'aria-label': 'The bus' },
    h('div', { class: 'i2c-head' }, h('h2', {}, 'Bus'), h('span', { class: 'i2c-sub' }, 'add devices, drag the wiring'),
      h('span', { class: 'i2c-grow' }), vddF.el, pfcmF.el, cbF),
    busDraw, devEdit);

  const edgeDraw = h('div', { class: 'i2c-draw' });
  const edgeRead = h('span', { class: 'i2c-sub' });
  const edgePanel = h('section', { class: 'i2c-panel i2c-edge', 'aria-label': 'Rising edge' },
    h('div', { class: 'i2c-head' }, h('h2', {}, 'Rising edge'), edgeRead),
    edgeDraw,
    h('div', { class: 'i2c-foot' }, h('span', {}, 'Click a speed on the time axis to change the mode.'),
      h('span', {}, 'Green: the edges any allowed pull-up gives.')));

  const rpIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Chosen pull-up in ohms',
    placeholder: 'suggested', oninput: (e) => ctx.set('rp', e.target.value) });
  const rpF = h('label', { class: 'i2c-f rp' }, 'Rp', rpIn, 'Ω');
  const sugBtn = h('button', { class: 'k-btn', type: 'button', onclick: () => ctx.set('rp', '') }, 'Use suggested');
  const seg = h('div', { class: 'i2c-seg', role: 'group', 'aria-label': 'Values made in' });
  const rulerDraw = h('div', { class: 'i2c-draw' });
  const rulerPanel = h('section', { class: 'i2c-panel i2c-ruler', 'aria-label': 'Pull-up resistor' },
    h('div', { class: 'i2c-head' }, h('h2', {}, 'Pull-up'), h('span', { class: 'i2c-sub' }, 'drag it along the ruler'),
      h('span', { class: 'i2c-grow' }), rpF, sugBtn, seg),
    rulerDraw,
    h('div', { class: 'i2c-foot' }, h('span', {}, h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' next standard value'),
      h('span', {}, h('kbd', {}, 'PgUp'), ' ', h('kbd', {}, 'PgDn'), ' ×10'), h('span', {}, h('kbd', {}, 'Home'), ' suggested')));

  const warns = h('div', { class: 'k-warns i2c-warns', 'aria-live': 'polite' });
  const side = h('section', { class: 'i2c-side' }, warns, ctx.outputs);
  root.append(h('div', { class: 'i2c' }, busPanel, edgePanel, rulerPanel, side));

  // ---------- inputs from the drawing ----------
  const bus = () => ctx.result?.bus;
  const devicesRaw = () => (Array.isArray(ctx.raw.devices) ? ctx.raw.devices.map((d) => ({ ...d })) : []);
  // Keep the wiring as it is and let the bus capacitance follow the devices.
  const setDevices = (list) => {
    const b = bus();
    const wire = b ? pF(b.cwire) : 0;
    const sum = list.reduce((a, d) => a + (ctx.parseEng(d.pf) || 0), 0);
    ctx.setMany({ devices: list, cb: String(Number((sum + wire).toPrecision(4))) });
  };
  const addDevice = () => {
    const list = devicesRaw();
    if (list.length >= MAX_DEVICES) return;
    list.push({ name: `Device ${list.length + 1}`, pf: '10' });
    state.sel = list.length - 1;
    setDevices(list);
  };
  const removeDevice = (i) => {
    const list = devicesRaw();
    list.splice(i, 1);
    state.sel = clamp(state.sel, 0, Math.max(0, list.length - 1));
    setDevices(list);
  };
  const setWireCm = (cm) => {
    const b = bus(); if (!b) return;
    const wirePf = Math.max(0, cm) * b.pfcm;
    ctx.set('cb', String(Number((pF(b.cdev) + wirePf).toPrecision(4))));
  };
  const setR = (r) => ctx.set('rp', compactR(r));

  // Keyboard focus survives a redraw: the element with the same data-fk is focused again.
  const redraw = (fn) => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    fn();
    if (fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };

  // ---------- drawing: the bus ----------
  const WIRE_K = 80; // wiring cm -> fraction of the wiring zone: cm / (cm + 80)
  const cmToF = (cm) => cm / (cm + WIRE_K);
  const fToCm = (f) => (WIRE_K * f) / (1 - f);

  function drawBus() {
    const b = bus();
    const W = Math.max(300, busDraw.clientWidth || 700);
    busDraw.replaceChildren();
    if (!b) return;
    const vertical = W < 560;
    const devs = b.devices;
    const svg = sv('svg', { role: 'group', 'aria-label': `I2C bus with ${devs.length} devices` });
    const g = (cls, attrs = {}) => sv('g', { class: cls, ...attrs });
    const line = (x1, y1, x2, y2, cls) => sv('line', { x1, y1, x2, y2, class: cls });
    const resistor = (x, y1, y2, label) => {
      const gg = g('rlink', { 'data-rlink': '1' });
      gg.append(line(x, y1, x, y1 + 10, 'gnd'), sv('rect', { x: x - 6, y: y1 + 10, width: 12, height: 36, rx: 1, class: 'res' }),
        line(x, y1 + 46, x, y2, 'gnd'), sv('title', {}, `${label} pull-up - click to pick it on the ruler`));
      return gg;
    };
    const rLabel = b.r ? `Rp ${E(b.r, 'Ω')}` : 'Rp: none fits';
    const W2 = W;
    let H;
    const wireActive = b.wireCm > 0.05;

    if (!vertical) {
      const yRail = 26, ySda = 120, yScl = 146, xSda = 58, xScl = 84, chipY = 176, chipH = 50;
      const xWireEnd = W2 - 28;
      const devZoneEnd = Math.round(W2 * 0.64);
      const n = devs.length + (devs.length < MAX_DEVICES ? 1 : 0);
      const gap = 10, x0 = 112;
      const cw = clamp(Math.floor((devZoneEnd - x0 - gap * (n - 1)) / Math.max(1, n)), 44, 98);
      const lastX = x0 + n * (cw + gap) - gap;
      const wx0 = Math.max(lastX + 18, devZoneEnd + 10);
      const f = cmToF(b.wireCm);
      const xKnob = wx0 + f * (xWireEnd - wx0);
      H = 300;
      // rail
      svg.append(line(24, yRail, W2 - 16, yRail, 'rail'), txt(W2 - 16, yRail - 8, `VDD ${E(b.vdd, 'V')}`, 'm b', 'end'));
      svg.append(resistor(xSda, yRail, ySda, 'SDA'), resistor(xScl, yRail, yScl, 'SCL'));
      const rl = txt(xScl + 14, yRail + 28, rLabel, 'm b rlink');
      rl.setAttribute('data-rlink', '1');
      svg.append(rl, txt(xScl + 14, yRail + 42, b.r ? `${E(b.iLow, 'A')} when low` : '', 'm soft sm'));
      // lines
      svg.append(sv('path', { d: `M${xSda},${ySda} H${xKnob}`, class: 'sda' }), sv('path', { d: `M${xScl},${yScl} H${xKnob}`, class: 'scl' }));
      svg.append(sv('circle', { cx: xSda, cy: ySda, r: 3.5, class: 'sda-f' }), sv('circle', { cx: xScl, cy: yScl, r: 3.5, class: 'scl-f' }));
      svg.append(txt(12, ySda + 4, 'SDA', 'm b'), txt(12, yScl + 4, 'SCL', 'm b'));
      if (xKnob < xWireEnd) svg.append(line(xKnob, ySda, xWireEnd, ySda, 'wire-ghost'), line(xKnob, yScl, xWireEnd, yScl, 'wire-ghost'));
      // devices
      devs.forEach((d, i) => {
        const x = x0 + i * (cw + gap);
        const dg = g(`dev${i === state.sel ? ' sel' : ''}`, { tabindex: 0, role: 'button', 'data-fk': `dev${i}`, 'data-dev': i,
          'aria-label': `${d.name}, ${d.pf} pF. Enter to edit, Delete to remove` });
        const ps = x + cw * 0.36, pc = x + cw * 0.64;
        dg.append(line(ps, ySda, ps, chipY, 'sda'), line(pc, yScl, pc, chipY, 'scl'),
          sv('circle', { cx: ps, cy: ySda, r: 3.2, class: 'sda-f' }), sv('circle', { cx: pc, cy: yScl, r: 3.2, class: 'scl-f' }),
          sv('rect', { x, y: chipY, width: cw, height: chipH, rx: 3, class: 'chip' }));
        for (let k = 0; k < 3; k++) {
          const px = x + (cw / 4) * (k + 1) - 2;
          dg.append(sv('rect', { x: px, y: chipY + chipH, width: 4, height: 5, class: 'chip-pin' }));
        }
        const name = d.name.length > Math.floor(cw / 6.4) ? d.name.slice(0, Math.max(3, Math.floor(cw / 6.4) - 1)) + '…' : d.name;
        dg.append(txt(x + cw / 2, chipY + 21, name, 'chip-t', 'middle'), txt(x + cw / 2, chipY + 38, `${E(d.pf * 1e-12, 'F')}`, 'm chip-t sm', 'middle'),
          sv('title', {}, `${d.name}: ${d.pf} pF`));
        if (i === state.sel) {
          const xg = g('x', { 'data-del': i });
          xg.append(sv('circle', { cx: x + cw, cy: chipY, r: 8 }), sv('path', { d: `M${x + cw - 3},${chipY - 3} l6,6 m0,-6 l-6,6` }), sv('title', {}, 'Remove this device'));
          dg.append(xg);
        }
        svg.append(dg);
      });
      if (devs.length < MAX_DEVICES) {
        const x = x0 + devs.length * (cw + gap);
        const ag = g('add', { tabindex: 0, role: 'button', 'data-fk': 'add', 'data-add': '1', 'aria-label': 'Add a device, 10 pF' });
        ag.append(sv('rect', { x, y: chipY, width: cw, height: chipH, rx: 3 }), txt(x + cw / 2, chipY + 22, '+ device', '', 'middle'),
          txt(x + cw / 2, chipY + 37, '10 pF', 'm sm', 'middle'));
        svg.append(ag);
      }
      // wiring zone: a length scale and the knob
      const ys = yScl + 22;
      svg.append(line(wx0, ys, xWireEnd, ys, 'tick'));
      for (const cm of [0, 20, 50, 100, 200, 500]) {
        const x = wx0 + cmToF(cm) * (xWireEnd - wx0);
        svg.append(line(x, ys - 3, x, ys + 3, 'tick'), txt(x, ys + 14, cm === 500 ? '500 cm' : String(cm), 'm soft sm', 'middle'));
      }
      const kg = g('knob', { tabindex: 0, role: 'slider', 'data-fk': 'wire', 'data-drag': 'wire',
        'aria-label': 'Wiring length in cm', 'aria-valuenow': b.wireCm.toFixed(0), 'aria-valuemin': 0, 'aria-valuetext': `${b.wireCm.toFixed(0)} cm, ${pF(b.cwire).toFixed(0)} pF` });
      kg.append(sv('rect', { x: xKnob - 14, y: ySda - 14, width: 28, height: yScl - ySda + 28, fill: 'transparent' }),
        sv('rect', { x: xKnob - 6, y: ySda - 9, width: 12, height: yScl - ySda + 18, rx: 6, class: 'cap' }),
        sv('rect', { x: xKnob - 9, y: ySda - 12, width: 18, height: yScl - ySda + 24, rx: 9, class: 'ring', fill: 'none', stroke: 'none' }));
      svg.append(kg);
      const wl = `wiring ${b.wireCm >= 10 ? b.wireCm.toFixed(0) : b.wireCm.toFixed(1)} cm · ${E(b.cwire, 'F')}`;
      const half = wl.length * 3.3;
      const lx = clamp(xKnob, wx0 + half - 20, W2 - 12 - half);
      svg.append(txt(lx, ySda - 18, wl, `m ${wireActive ? '' : 'soft'}`, 'middle'));
      svg.append(budget(svg, b, 16, W2 - 16, 262));
      state.busGeom = { vertical, wx0, wx1: xWireEnd };
    } else {
      // narrow: the bus runs down, devices to its right
      const yRail = 22, xSda = 34, xScl = 58, yLines = 96, chipX = 96, chipW = W2 - chipX - 12, chipH = 40, gap = 10;
      const n = devs.length + (devs.length < MAX_DEVICES ? 1 : 0);
      const y0 = yLines + 18;
      const lastY = y0 + n * (chipH + gap) - gap;
      const wy0 = lastY + 18, wy1 = wy0 + 150;
      const yKnob = wy0 + cmToF(b.wireCm) * (wy1 - wy0);
      H = wy1 + 70;
      svg.append(line(14, yRail, W2 - 14, yRail, 'rail'), txt(W2 - 14, yRail - 7, `VDD ${E(b.vdd, 'V')}`, 'm b', 'end'));
      svg.append(resistor(xSda, yRail, yLines - 8, 'SDA'), resistor(xScl, yRail, yLines, 'SCL'));
      const rl = txt(xScl + 16, 50, rLabel, 'm b rlink'); rl.setAttribute('data-rlink', '1');
      svg.append(rl, txt(xScl + 16, 64, b.r ? `${E(b.iLow, 'A')} when low` : '', 'm soft sm'));
      svg.append(sv('path', { d: `M${xSda},${yLines - 8} V${yKnob}`, class: 'sda' }), sv('path', { d: `M${xScl},${yLines} V${yKnob}`, class: 'scl' }));
      svg.append(txt(xSda - 4, yLines + 6, 'SDA', 'm b sm', 'end'));
      svg.append(txt(xScl + 5, yLines + 6, 'SCL', 'm b sm'));
      if (yKnob < wy1) svg.append(line(xSda, yKnob, xSda, wy1, 'wire-ghost'), line(xScl, yKnob, xScl, wy1, 'wire-ghost'));
      devs.forEach((d, i) => {
        const y = y0 + i * (chipH + gap);
        const dg = g(`dev${i === state.sel ? ' sel' : ''}`, { tabindex: 0, role: 'button', 'data-fk': `dev${i}`, 'data-dev': i,
          'aria-label': `${d.name}, ${d.pf} pF. Enter to edit, Delete to remove` });
        dg.append(line(xSda, y + 13, chipX, y + 13, 'sda'), line(xScl, y + 27, chipX, y + 27, 'scl'),
          sv('circle', { cx: xSda, cy: y + 13, r: 3, class: 'sda-f' }), sv('circle', { cx: xScl, cy: y + 27, r: 3, class: 'scl-f' }),
          sv('rect', { x: chipX, y, width: chipW, height: chipH, rx: 3, class: 'chip' }),
          txt(chipX + 10, y + 24, d.name, 'chip-t'), txt(chipX + chipW - 10, y + 24, E(d.pf * 1e-12, 'F'), 'm chip-t', 'end'));
        if (i === state.sel) {
          const xg = g('x', { 'data-del': i });
          xg.append(sv('circle', { cx: chipX + chipW, cy: y, r: 8 }), sv('path', { d: `M${chipX + chipW - 3},${y - 3} l6,6 m0,-6 l-6,6` }));
          dg.append(xg);
        }
        svg.append(dg);
      });
      if (devs.length < MAX_DEVICES) {
        const y = y0 + devs.length * (chipH + gap);
        const ag = g('add', { tabindex: 0, role: 'button', 'data-fk': 'add', 'data-add': '1', 'aria-label': 'Add a device, 10 pF' });
        ag.append(sv('rect', { x: chipX, y, width: chipW, height: chipH, rx: 3 }), txt(chipX + chipW / 2, y + 24, '+ device, 10 pF', '', 'middle'));
        svg.append(ag);
      }
      const xs = xScl + 22;
      svg.append(line(xs, wy0, xs, wy1, 'tick'));
      for (const cm of [0, 20, 50, 100, 200, 500]) {
        const y = wy0 + cmToF(cm) * (wy1 - wy0);
        svg.append(line(xs - 3, y, xs + 3, y, 'tick'), txt(xs + 7, y + 3, `${cm}${cm === 500 ? ' cm' : ''}`, 'm soft sm'));
      }
      const kg = g('knob v', { tabindex: 0, role: 'slider', 'data-fk': 'wire', 'data-drag': 'wire',
        'aria-label': 'Wiring length in cm', 'aria-valuenow': b.wireCm.toFixed(0), 'aria-valuemin': 0 });
      kg.append(sv('rect', { x: xSda - 16, y: yKnob - 14, width: xScl - xSda + 32, height: 28, fill: 'transparent' }),
        sv('rect', { x: xSda - 9, y: yKnob - 6, width: xScl - xSda + 18, height: 12, rx: 6, class: 'cap' }),
        sv('rect', { x: xSda - 12, y: yKnob - 9, width: xScl - xSda + 24, height: 18, rx: 9, class: 'ring', fill: 'none', stroke: 'none' }));
      svg.append(kg);
      svg.append(txt(chipX + 30, clamp(yKnob, wy0 + 10, wy1) + 4, `wiring ${b.wireCm.toFixed(0)} cm · ${E(b.cwire, 'F')}`, 'm'));
      svg.append(budget(svg, b, 12, W2 - 12, wy1 + 34));
      state.busGeom = { vertical, wy0, wy1 };
    }
    svg.setAttribute('viewBox', `0 0 ${W2} ${H}`);
    svg.setAttribute('height', H);
    svg.prepend(defs());
    busDraw.append(svg);
    drawEditor();
  }

  // The bus capacitance, built up: one segment per device, then the wiring,
  // against the mode's limit.
  function budget(svg, b, x0, x1, y) {
    const gg = sv('g');
    const cbp = pF(b.cb), lim = pF(b.cmax);
    const max = Math.max(lim * 1.12, cbp * 1.06);
    const X = (v) => x0 + (v / max) * (x1 - x0);
    const hgt = 12;
    gg.append(sv('rect', { x: x0, y, width: x1 - x0, height: hgt, rx: 2, fill: 'var(--sunken)' }));
    if (cbp > lim) gg.append(sv('rect', { x: X(lim), y: y - 3, width: X(cbp) - X(lim), height: hgt + 6, class: 'over' }));
    let acc = 0;
    b.devices.forEach((d, i) => {
      const v = Math.min(d.pf, Math.max(0, cbp - acc));
      if (v > 0) {
        const r = sv('rect', { x: X(acc), y, width: Math.max(0.5, X(acc + v) - X(acc) - 1), height: hgt, class: 'dev-f', 'fill-opacity': i % 2 ? 0.62 : 0.9 });
        r.append(sv('title', {}, `${d.name}: ${d.pf} pF`));
        gg.append(r);
      }
      acc += d.pf;
    });
    const devEnd = Math.min(pF(b.cdev), cbp);
    if (b.cwire > 0) {
      const r = sv('rect', { x: X(devEnd), y, width: Math.max(0.5, X(devEnd + pF(b.cwire)) - X(devEnd)), height: hgt, class: 'wire-f', 'fill-opacity': 0.85 });
      r.append(sv('title', {}, `wiring: ${pF(b.cwire).toFixed(0)} pF`));
      gg.append(r);
    }
    gg.append(sv('line', { x1: X(lim), y1: y - 6, x2: X(lim), y2: y + hgt + 6, class: 'limit' }));
    const over = cbp > lim;
    const head = txt(x0, y - 7, '', 'sm');
    if (x1 - x0 > 420) head.append(sv('tspan', { class: 'soft' }, 'Bus capacitance  '));
    head.append( sv('tspan', { class: `m b ${over ? 'danger' : ''}` }, `Cb ${E(b.cb, 'F')}`),
      sv('tspan', { class: 'm soft' }, `  = devices ${E(b.cdev, 'F')} + wiring ${E(b.cwire, 'F')}`));
    gg.append(head);
    gg.append(sv('line', { x1: X(cbp), y1: y - 3, x2: X(cbp), y2: y + hgt + 3, stroke: 'var(--ink)', 'stroke-width': 1.5 }));
    gg.append(txt(X(lim), y + hgt + 14, `${b.modeName} limit ${E(b.cmax, 'F')}`, `m sm ${over ? 'danger' : 'soft'}`, 'end'));
    return gg;
  }

  function defs() {
    const d = sv('defs');
    const p = sv('pattern', { id: 'i2c-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    p.append(sv('rect', { width: 7, height: 7, class: 'over', style: 'fill-opacity: calc(var(--fill-alpha) * .55)' }), sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-l' }));
    d.append(p);
    return d;
  }

  // The selected device's name and capacitance, as fields.
  function drawEditor() {
    const b = bus();
    const list = devicesRaw();
    devEdit.replaceChildren();
    if (!list.length) {
      devEdit.append(h('span', { class: 'i2c-sub' }, 'No devices listed: the whole bus capacitance counts as wiring. Click + device to add one.'));
      return;
    }
    state.sel = clamp(state.sel, 0, list.length - 1);
    const d = list[state.sel];
    const name = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Device name', 'data-fk': 'ed-name',
      oninput: (e) => { const l = devicesRaw(); l[state.sel].name = e.target.value; ctx.set('devices', l); } });
    name.value = d.name ?? '';
    const pf = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Pin capacitance in pF', 'data-fk': 'ed-pf',
      oninput: (e) => { const l = devicesRaw(); l[state.sel].pf = e.target.value; setDevices(l); } });
    pf.value = d.pf ?? '';
    if (ctx.parseEng(d.pf) == null) pf.classList.add('bad');
    devEdit.append(h('b', {}, `Device ${state.sel + 1} of ${list.length}`),
      h('label', { class: 'i2c-f' }, 'name', name), h('label', { class: 'i2c-f pf' }, 'pin', pf, 'pF'),
      h('button', { class: 'k-btn', type: 'button', onclick: () => removeDevice(state.sel) }, 'Remove'),
      h('span', { class: 'i2c-sub' }, b ? `${list.length} devices, ${E(b.cdev, 'F')} of pins` : ''));
  }

  // ---------- drawing: the rising edge ----------
  function drawEdge() {
    const b = bus();
    const W = Math.max(300, edgeDraw.clientWidth || 500);
    edgeDraw.replaceChildren();
    if (!b) { edgeRead.textContent = ''; return; }
    const H = W < 460 ? 250 : 312;
    const L = 58, R = 14, T = 20, B = 68;
    const lim = b.trMax;
    const t0 = -0.32 * lim, t1 = 2.2 * lim;
    const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const Y = (v) => T + (1 - v / (b.vdd * 1.08)) * (H - T - B);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img',
      'aria-label': `Rising edge: rise time ${b.tr ? E(b.tr, 's') : 'none'}, limit ${E(lim, 's')}` });
    svg.append(defs());
    // wall: past the limit the edge is too slow
    const xw = X(lim);
    svg.append(sv('rect', { x: xw, y: T, width: W - R - xw, height: H - T - B, class: 'wall' }),
      sv('line', { x1: xw, y1: T, x2: xw, y2: H - B, class: 'wall-edge' }));
    const wl = `${b.modeName}: tr ≤ ${E(lim, 's')}`;
    svg.append(sv('rect', { x: xw + 2, y: T + 1, width: Math.min(W - R - xw - 4, wl.length * 5.8 + 8), height: 28, class: 'lbl-bg', opacity: 0.85 }));
    svg.append(txt(xw + 6, T + 12, wl, 'danger sm b'));
    svg.append(txt(xw + 6, T + 25, 'too slow past here', 'danger sm'));
    // grid and thresholds
    const vt = [[0, '0'], [b.v30, '30 %'], [b.v70, '70 %'], [b.vdd, 'VDD']];
    for (const [v, lab] of vt) {
      const cls = lab.includes('%') ? 'thr' : 'grid';
      svg.append(sv('line', { x1: L, y1: Y(v), x2: W - R, y2: Y(v), class: cls }));
      svg.append(txt(L - 6, Y(v) - 1, lab, 'sm b', 'end'), txt(L - 6, Y(v) + 10, E(v, 'V'), 'm soft sm', 'end'));
    }
    svg.append(sv('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, class: 'axis' }));
    // time ticks
    const step = niceStep((t1 - t0) / Math.max(3, Math.floor((W - L - R) / 90)));
    for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-15; t += step) {
      const x = X(t);
      svg.append(sv('line', { x1: x, y1: H - B, x2: x, y2: H - B + 4, class: 'axis' }));
      if (Math.abs(x - xw) > 26) svg.append(txt(x, H - B + 14, Math.abs(t) < step / 100 ? '0' : E(t, 's', 2), 'm soft sm', 'middle'));
    }
    svg.append(sv('line', { x1: X(0), y1: T, x2: X(0), y2: H - B, class: 'grid' }));
    // the edge for a given time constant, t = 0 where it crosses 30 %
    const curve = (tau) => {
      const pts = [];
      const tStart = -tau * Math.log(1 / 0.7);
      const N = 140;
      for (let k = 0; k <= N; k++) {
        const t = t0 + ((t1 - t0) * k) / N;
        const v = t <= tStart ? 0 : b.vdd * (1 - 0.7 * Math.exp(-t / tau));
        pts.push([X(t), Y(v)]);
      }
      return pts;
    };
    const path = (pts) => 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
    if (b.fits) {
      const fast = curve(b.tauMin), slow = curve(b.tauMax);
      svg.append(sv('path', { d: path(fast) + ' L' + slow.slice().reverse().map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L') + ' Z', class: 'env' }));
      svg.append(sv('path', { d: path(fast), class: 'env-l' }), sv('path', { d: path(slow), class: 'env-l' }));
    }
    const bad = b.tr != null && b.tr > lim;
    if (b.tau) svg.append(sv('path', { d: path(curve(b.tau)), class: `edge${bad ? ' bad' : ''}` }));
    else if (!b.fits) {
      // nothing fits: even the strongest pull-up a device can sink is too slow
      svg.append(sv('path', { d: path(curve(b.tauMin)), class: 'edge bad', 'stroke-dasharray': '6 4' }));
      const xr = Math.min(X(b.trAtRmin), W - R - 4);
      svg.append(sv('circle', { cx: xr, cy: Y(b.v70), r: 4.5, class: 'dot bad' }),
        txt(Math.min(xr + 8, W - R - 150), Y(b.v70) + 18, `at Rmin ${E(b.rmin, 'Ω')}: tr ${E(b.trAtRmin, 's')}`, 'm b danger sm'));
    }
    // the measured rise time
    if (b.tr != null) {
      const xa = X(0), xb = Math.min(X(b.tr), W - R);
      const yd = Y(b.v70) - 12;
      svg.append(sv('line', { x1: xa, y1: yd, x2: xb, y2: yd, class: 'dim' }),
        sv('path', { d: `M${xa},${yd} l6,-3 v6 Z`, fill: 'var(--ink)' }));
      if (X(b.tr) <= W - R) svg.append(sv('path', { d: `M${xb},${yd} l-6,-3 v6 Z`, fill: 'var(--ink)' }));
      svg.append(sv('line', { x1: xb, y1: yd - 4, x2: xb, y2: Y(b.v70), class: 'dim' }));
      const lab = `tr ${E(b.tr, 's')}${X(b.tr) > W - R ? ' →' : ''}`;
      const lx = clamp((xa + xb) / 2, L + 40, W - R - 40);
      svg.append(sv('rect', { x: lx - 42, y: yd - 17, width: 84, height: 14, class: 'lbl-bg' }), txt(lx, yd - 6, lab, `m b ${bad ? 'danger' : ''}`, 'middle'));
      svg.append(sv('circle', { cx: X(0), cy: Y(b.v30), r: 4, class: 'dot' }));
      if (X(b.tr) <= W - R) svg.append(sv('circle', { cx: X(b.tr), cy: Y(b.v70), r: 4.5, class: `dot${bad ? ' bad' : ''}` }));
    }
    // the speeds, on the time axis
    const ySp = H - B + 32;
    const chips = b.modes.map((m) => {
      const label = `${m.short} ${E(m.f, 'Hz', 3).replace(' ', ' ')}`;
      return { m, label, w: label.length * 6.4 + 14, x: X(m.trMax) };
    });
    // off the axis: pinned at the right end with an arrow; then keep them apart
    for (const c of chips) if (c.x > W - R) { c.x = W - R - c.w / 2; c.off = true; }
    chips.sort((a, bb) => a.m.trMax - bb.m.trMax);
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i];
      const prev = chips[i - 1];
      const minX = Math.max(L + c.w / 2 - 20, prev ? prev.x + prev.w / 2 + c.w / 2 + 4 : -1e9);
      c.x = Math.max(c.x, minX);
    }
    for (let i = chips.length - 1; i >= 0; i--) {
      const c = chips[i], next = chips[i + 1];
      const maxX = next ? next.x - next.w / 2 - c.w / 2 - 4 : W - R - c.w / 2;
      c.x = Math.min(c.x, maxX);
    }
    for (const c of chips) {
      const on = c.m.key === b.mode;
      const sg = sv('g', { class: 'spd', tabindex: 0, role: 'button', 'aria-pressed': String(on), 'data-fk': `spd-${c.m.key}`, 'data-mode': c.m.key,
        'aria-label': `${c.m.name}, ${E(c.m.f, 'Hz')}, rise time at most ${E(c.m.trMax, 's')}` });
      const real = X(c.m.trMax);
      if (real <= W - R) sg.append(sv('line', { x1: real, y1: H - B, x2: c.x, y2: ySp - 8, class: on ? 'wall-edge' : 'tick' }));
      sg.append(sv('rect', { x: c.x - c.w / 2, y: ySp - 8, width: c.w, height: 18, rx: 9 }),
        txt(c.x, ySp + 5, c.label + (c.off ? ' →' : ''), 'm sm', 'middle'), sv('title', {}, `${c.m.name}: rise time at most ${E(c.m.trMax, 's')}`));
      svg.append(sg);
    }
    svg.append(txt(L, H - 6, 'time from the 30 % crossing', 'soft sm'));
    edgeDraw.append(svg);
    edgeRead.textContent = b.tr != null ? `tr ${E(b.tr, 's')} of ${E(lim, 's')} allowed · τ = ${E(b.tau, 's')}` : 'no pull-up fits';
    edgeRead.style.color = bad ? 'var(--danger)' : '';
  }

  function niceStep(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  // ---------- drawing: the resistor ruler ----------
  function rulerRange(b) {
    const lo = Math.min(100, Math.pow(10, Math.floor(Math.log10(Math.min(b.rmin, b.rmax) * 0.7))));
    const hi = Math.max(1e5, Math.pow(10, Math.ceil(Math.log10(Math.max(b.rmin, b.rmax) * 1.4))));
    return [lo, hi];
  }
  function drawRuler() {
    const b = bus();
    const W = Math.max(300, rulerDraw.clientWidth || 700);
    rulerDraw.replaceChildren();
    if (!b) return;
    const narrow = W < 520;
    const H = 170;
    const L = 20, R = 20, yT = 74, bandTop = 46, bandBot = 102;
    const [lo, hi] = rulerRange(b);
    const X = (r) => L + (Math.log10(r / lo) / Math.log10(hi / lo)) * (W - L - R);
    state.ruler = { L, R, W, lo, hi };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': 'Pull-up resistor ruler' });
    svg.append(defs());
    const xmin = X(clamp(b.rmin, lo, hi)), xmax = X(clamp(b.rmax, lo, hi));
    // the zones
    if (b.fits) {
      svg.append(sv('rect', { x: L, y: bandTop, width: xmin - L, height: bandBot - bandTop, class: 'bad-zone' }),
        sv('rect', { x: xmax, y: bandTop, width: W - R - xmax, height: bandBot - bandTop, class: 'bad-zone' }),
        sv('rect', { x: xmin, y: bandTop, width: xmax - xmin, height: bandBot - bandTop, class: 'band' }),
        sv('line', { x1: xmin, y1: bandTop - 6, x2: xmin, y2: bandBot, class: 'band-e' }),
        sv('line', { x1: xmax, y1: bandTop - 6, x2: xmax, y2: bandBot, class: 'band-e' }));
    } else {
      svg.append(sv('rect', { x: L, y: bandTop, width: W - L - R, height: bandBot - bandTop, class: 'bad-zone' }),
        sv('line', { x1: xmin, y1: bandTop - 6, x2: xmin, y2: bandBot, class: 'limit' }),
        sv('line', { x1: xmax, y1: bandTop - 6, x2: xmax, y2: bandBot, class: 'limit' }));
      svg.append(sv('rect', { x: W / 2 - 150, y: bandTop + 6, width: 300, height: 18, class: 'lbl-bg', rx: 3 }),
        txt(W / 2, bandTop + 19, `no value fits: Rmax ${E(b.rmax, 'Ω')} is below Rmin ${E(b.rmin, 'Ω')}`, 'danger b sm', 'middle'));
    }
    // limit labels
    const minLab = `Rmin ${E(b.rmin, 'Ω')}`, maxLab = `Rmax ${E(b.rmax, 'Ω')}`;
    // the lower limit's label to the left of its line, the upper's to the right
    // (when nothing fits, Rmax lies left of Rmin)
    const [xl, ll, xh, lh] = xmin <= xmax ? [xmin, minLab, xmax, maxLab] : [xmax, maxLab, xmin, minLab];
    svg.append(txt(Math.max(xl - 3, L + ll.length * 6.4), 14, ll, 'm b', 'end'), txt(Math.min(xh + 3, W - R - lh.length * 6.4), 14, lh, 'm b', 'start'));
    const zl = narrow ? `sink > ${E(b.iol, 'A')}` : `too strong: more than ${E(b.iol, 'A')} to sink`;
    const zr = narrow ? `tr > ${E(b.trMax, 's')}` : `too slow: rise over ${E(b.trMax, 's')}`;
    const ym = bandBot - 8;
    if (xmin - L > zl.length * 5.6 + 10) svg.append(txt((L + xmin) / 2, ym, zl, 'danger sm b', 'middle'));
    if (W - R - xmax > zr.length * 5.6 + 10) svg.append(txt((xmax + W - R) / 2, ym, zr, 'danger sm b', 'middle'));
    // track, standard values, decades
    svg.append(sv('line', { x1: L, y1: yT, x2: W - R, y2: yT, class: 'track' }));
    const series = ctx.raw.series || 'E24';
    const vals = ladder(series, lo, hi);
    const pxPerDecade = (W - L - R) / Math.log10(hi / lo);
    for (const v of vals) {
      const x = X(v);
      const dec = Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-6;
      const len = dec ? 14 : series === 'E96' ? 5 : 8;
      svg.append(sv('line', { x1: x, y1: bandBot, x2: x, y2: bandBot + len, class: dec ? 'axis' : 'tick' }));
    }
    const labelled = pxPerDecade > 300 ? [1, 1.5, 2.2, 3.3, 4.7, 6.8] : pxPerDecade > 140 ? [1, 2.2, 4.7] : [1];
    for (let d = 1; d <= 1e7; d *= 10) for (const m of labelled) {
      const v = m * d;
      if (v < lo * 0.999 || v > hi * 1.001) continue;
      const dec = m === 1;
      svg.append(txt(X(v), bandBot + 26, compactR(v) + (dec ? 'Ω' : ''), `m sm ${dec ? 'b' : 'soft'}`, 'middle'));
    }
    // the suggested value
    if (b.pick) {
      const x = X(b.pick);
      svg.append(sv('path', { d: `M${x},${bandBot + 2} l-5,8 h10 Z`, class: 'sug' }));
      if (b.chosen) svg.append(txt(x, bandBot + 42, `suggested ${compactR(b.pick)}`, 'm sm ok-t', 'middle'));
    }
    // the handle
    const r = b.r || (b.fits ? Math.sqrt(b.rmin * b.rmax) : b.rmax);
    const xr = X(clamp(r, lo, hi));
    const bad = !b.r || b.r < b.rmin || b.r > b.rmax;
    const hg = sv('g', { class: `rh${bad ? ' bad' : ''}`, tabindex: 0, role: 'slider', 'data-fk': 'rp', 'data-drag': 'rp',
      'aria-label': 'Pull-up resistor', 'aria-valuenow': r, 'aria-valuemin': lo, 'aria-valuemax': hi,
      'aria-valuetext': b.r ? `${E(b.r, 'Ω')}, rise ${E(b.tr, 's')}, ${E(b.iLow, 'A')} when low` : 'none' });
    const tag = b.r ? E(b.r, 'Ω') : '–';
    const tw = tag.length * 7 + 16;
    const tx = clamp(xr, L + tw / 2, W - R - tw / 2);
    hg.append(sv('rect', { x: xr - 14, y: 24, width: 28, height: bandBot - 14, fill: 'transparent' }),
      sv('line', { x1: xr, y1: 40, x2: xr, y2: bandBot, class: 'stem' }),
      sv('rect', { x: tx - tw / 2, y: 22, width: tw, height: 19, rx: 3, class: 'tag' }), txt(tx, 35.5, tag, 'm tag-t', 'middle'),
      sv('circle', { cx: xr, cy: yT, r: 8, class: 'knobc' }), sv('circle', { cx: xr, cy: yT, r: 12, class: 'ring', fill: 'none' }));
    svg.append(hg);
    if (b.r) {
      const info = `${E(b.iLow, 'A')} when low · tr ${E(b.tr, 's')}`;
      const iw = info.length * 6.2;
      const ix = clamp(xr, L + iw / 2, W - R - iw / 2);
      svg.append(sv('rect', { x: ix - iw / 2 - 4, y: bandBot + 30, width: iw + 8, height: 16, class: 'lbl-bg' }),
        txt(ix, bandBot + 42, info, `m sm b ${bad ? 'danger' : ''}`, 'middle'));
    }
    svg.append(txt(L, H - 6, `standard ${series} values; ${b.chosen ? 'your choice' : 'the suggested value'}: ${b.r ? E(b.r, 'Ω') : 'none'}`, 'soft sm'));
    rulerDraw.append(svg);
  }

  // ---------- pointer and keys ----------
  const rFromX = (clientX) => {
    const q = state.ruler; if (!q) return null;
    const rect = rulerDraw.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * q.W;
    const f = clamp((x - q.L) / (q.W - q.L - q.R), 0, 1);
    const v = q.lo * Math.pow(q.hi / q.lo, f);
    return standard(v, SERIES[ctx.raw.series] || SERIES.E24, 'near');
  };
  rulerDraw.addEventListener('pointerdown', (e) => {
    if (!bus()) return;
    e.preventDefault();
    rulerDraw.setPointerCapture(e.pointerId);
    state.drag = 'rp';
    root.querySelector('[data-fk="rp"]')?.focus({ preventScroll: true });
    const r = rFromX(e.clientX); if (r && r !== bus()?.r) setR(r);
  });
  rulerDraw.addEventListener('pointermove', (e) => {
    if (state.drag !== 'rp') return;
    const r = rFromX(e.clientX); if (r && r !== bus()?.r) setR(r);
  });
  const endDrag = () => { state.drag = null; };
  rulerDraw.addEventListener('pointerup', endDrag);
  rulerDraw.addEventListener('pointercancel', endDrag);
  rulerDraw.addEventListener('keydown', (e) => {
    const b = bus(); if (!b || !e.target.closest('[data-drag="rp"]')) return;
    const [lo, hi] = rulerRange(b);
    const vals = ladder(ctx.raw.series || 'E24', lo, hi);
    const r = b.r || b.rmax;
    let i = vals.findIndex((v) => v >= r * 0.999);
    if (i < 0) i = vals.length - 1;
    const perDec = (SERIES[ctx.raw.series] || SERIES.E24).length;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = vals[Math.min(vals.length - 1, vals[i] > r * 1.001 ? i : i + 1)];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = vals[Math.max(0, i - 1)];
    else if (e.key === 'PageUp') next = vals[Math.min(vals.length - 1, i + perDec)];
    else if (e.key === 'PageDown') next = vals[Math.max(0, i - perDec)];
    else if (e.key === 'Home') { e.preventDefault(); ctx.set('rp', ''); return; }
    if (next) { e.preventDefault(); setR(next); }
  });

  // the bus: devices, the add chip, the wiring knob, the pull-ups
  const wireFrom = (e) => {
    const gm = state.busGeom, b = bus(); if (!gm || !b) return null;
    const rect = busDraw.getBoundingClientRect();
    const svgW = busDraw.querySelector('svg')?.viewBox.baseVal.width || rect.width;
    const k = svgW / rect.width;
    const f = gm.vertical ? ((e.clientY - rect.top) * k - gm.wy0) / (gm.wy1 - gm.wy0) : ((e.clientX - rect.left) * k - gm.wx0) / (gm.wx1 - gm.wx0);
    const cm = fToCm(clamp(f, 0, 0.97));
    return cm < 20 ? Math.round(cm) : cm < 100 ? Math.round(cm / 2) * 2 : Math.round(cm / 5) * 5;
  };
  busDraw.addEventListener('pointerdown', (e) => {
    const t = e.target;
    const del = t.closest('[data-del]');
    if (del) { e.preventDefault(); removeDevice(Number(del.getAttribute('data-del'))); return; }
    const dev = t.closest('[data-dev]');
    if (dev) { state.sel = Number(dev.getAttribute('data-dev')); e.preventDefault(); redraw(drawBus); root.querySelector(`[data-fk="dev${state.sel}"]`)?.focus({ preventScroll: true }); return; }
    if (t.closest('[data-add]')) { e.preventDefault(); addDevice(); return; }
    if (t.closest('[data-rlink]')) { e.preventDefault(); root.querySelector('[data-fk="rp"]')?.focus(); return; }
    if (t.closest('[data-drag="wire"]')) {
      e.preventDefault();
      busDraw.setPointerCapture(e.pointerId);
      state.drag = 'wire';
      t.closest('[data-drag="wire"]').focus({ preventScroll: true });
    }
  });
  busDraw.addEventListener('pointermove', (e) => {
    if (state.drag !== 'wire') return;
    const cm = wireFrom(e);
    if (cm != null && Math.abs(cm - bus().wireCm) > 0.01) setWireCm(cm);
  });
  busDraw.addEventListener('pointerup', endDrag);
  busDraw.addEventListener('pointercancel', endDrag);
  busDraw.addEventListener('keydown', (e) => {
    const t = e.target, b = bus(); if (!b) return;
    if (t.closest('[data-drag="wire"]')) {
      const step = e.shiftKey ? 1 : 5;
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (dir) {
        e.preventDefault();
        const base = Math.round(b.wireCm / step) * step;
        setWireCm(Math.max(0, base + dir * step));
      }
      return;
    }
    const dev = t.closest('[data-dev]');
    if (dev) {
      const i = Number(dev.getAttribute('data-dev'));
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeDevice(i); return; }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.sel = i; redraw(drawBus); devEdit.querySelector('[data-fk="ed-name"]')?.focus(); }
      return;
    }
    if (t.closest('[data-add]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); addDevice(); }
  });

  edgeDraw.addEventListener('click', (e) => {
    const s = e.target.closest('[data-mode]'); if (s) ctx.set('mode', s.getAttribute('data-mode'));
  });
  edgeDraw.addEventListener('keydown', (e) => {
    const s = e.target.closest('[data-mode]');
    if (s && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.set('mode', s.getAttribute('data-mode')); }
  });

  // ---------- result -> page ----------
  const sync = (inp, v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
  function renderAll() {
    const raw = ctx.raw;
    sync(vddF.inp, raw.vdd); sync(pfcmF.inp, raw.pfcm); sync(cbIn, raw.cb); sync(rpIn, raw.rp);
    vddF.inp.classList.toggle('bad', ctx.parseEng(raw.vdd) == null);
    cbIn.classList.toggle('bad', ctx.parseEng(raw.cb) == null);
    rpIn.classList.toggle('bad', String(raw.rp ?? '').trim() !== '' && ctx.parseEng(raw.rp) == null);
    seg.replaceChildren(...['E12', 'E24', 'E96'].map((s) => h('button', { type: 'button', 'aria-pressed': String((raw.series || 'E24') === s),
      onclick: () => ctx.set('series', s) }, s)));
    sugBtn.disabled = String(raw.rp ?? '').trim() === '';
    rpIn.placeholder = ctx.result?.bus?.pick ? `${compactR(ctx.result.bus.pick)} (sugg.)` : 'suggested';
    const res = ctx.result || {};
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    redraw(() => { drawBus(); drawEdge(); drawRuler(); });
    if (!res.bus) {
      // a bad supply or capacitance: say so where the drawing would be
      busDraw.replaceChildren(h('div', { class: 'i2c-foot', style: 'padding:24px 12px' }, (res.warnings || []).join(' ')));
    }
  }
  ctx.onResult(renderAll);
  // Redraw at the new width (the drawings are laid out in pixels, so text
  // keeps its size from 360 px to a wide screen).
  let raf = 0, lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => redraw(() => { drawBus(); drawEdge(); drawRuler(); }));
  }).observe(root);
}
