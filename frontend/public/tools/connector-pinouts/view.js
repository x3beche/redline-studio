// Connector Pinout Library page: the mating face of the connector itself, pins
// where they sit, coloured by what they carry, seen from the side the standard
// states - with a mirror switch, because the mirrored footprint is the classic
// mistake. Point at a pin to read it (its diff-pair partner and the other pins
// on the same signal light up); type a signal name and the matching pins light
// on this face and on every connector in the shelf. "All connectors" lays the
// whole shelf out as a wall of faces with the matches lit. Pin data and
// matches come from tool.js (the table and run()'s rows).

import { CONNECTORS, FACES, run } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// What a signal carries, for its colour.
const CLASSES = [
  ['nc', 'Not connected / key', /^(NC\b|KEY|Reserved|DBGRQ)/i],
  ['gnd', 'Ground / shield', /GND|VSS|Shield|SHLD/i],
  ['pwr', 'Power / reference', /VBUS|VCC|VDD|3V3|5V|VTref|CAN_V\+|3\.3V|Vsupply/i],
  ['pair', 'Differential pair', /(^|[^A-Z])(D[+-]|TX\d?[+-]|RX\d?[+-])|TMDS|BI_D|CAN_[HL]|SS(TX|RX)|[+-]$/i],
  ['clk', 'Clock', /CLK|SCK|TCK|SCL/i],
  ['ctl', 'Control / detect', /^CC\d|^ID$|RESET|nRST|TRST|SRST|^CS$|HPD|CEC|SBU|DTR|RTS|CTS|DSR|DCD|^RI$|INT|CD\/|DBGACK|RTCK|GPCLK/i],
  ['data', 'Data / I/O', /.*/],
];
const classOf = (sig) => CLASSES.find(([, , re]) => re.test(sig))[0];
const shortSig = (sig) => sig.replace(/^TMDS /, '').replace(/ Shield$/, ' Shld');

// Partner of a differential signal: + <-> -, H <-> L.
function partnerSig(sig) {
  if (/CAN_H/.test(sig)) return sig.replace('CAN_H', 'CAN_L');
  if (/CAN_L/.test(sig)) return sig.replace('CAN_L', 'CAN_H');
  if (!/[+-]/.test(sig) || /\+5V|CAN_V\+/.test(sig)) return null;
  return sig.replace(/[+-]/g, (c) => (c === '+' ? '-' : '+'));
}

const WIRE = { black: '--tool-w-black', brown: '--tool-w-brown', red: '--tool-w-red', orange: '--tool-w-orange', yellow: '--tool-w-yellow',
  green: '--tool-w-green', blue: '--tool-w-blue', white: '--tool-w-white' };

const STYLE = `
.cp { --tool-c-gnd: #5b6b7a; --tool-c-pwr: #c0392b; --tool-c-pair: #1f4ed8; --tool-c-clk: #d97706; --tool-c-ctl: #a23fbf; --tool-c-data: #0f8a78; --tool-c-nc: #b4bec8;
  --tool-pin-ink: #ffffff; --tool-shell: #aab4be; --tool-body: #2a323b; --tool-tongue: #d8dee4; --tool-gold: #c9a227;
  --tool-w-black: #1b1f24; --tool-w-brown: #7a4a21; --tool-w-red: #d23b2f; --tool-w-orange: #e67e22; --tool-w-yellow: #e6c200; --tool-w-green: #2e9e44; --tool-w-blue: #2c6fd6; --tool-w-white: #eef1f4;
  display: grid; grid-template-columns: 236px minmax(0, 1fr) 340px; gap: 10px; align-items: start; min-width: 0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .cp {
  --tool-c-gnd: #8ea0b0; --tool-c-pwr: #e57373; --tool-c-pair: #7d9bff; --tool-c-clk: #f0a33a; --tool-c-ctl: #c982e0; --tool-c-data: #3cc7b3; --tool-c-nc: #3a4652;
  --tool-pin-ink: #0b0f13; --tool-shell: #56626e; --tool-body: #0b0f13; --tool-tongue: #26313b; --tool-w-black: #05070a; --tool-w-white: #d7dde3; } }
:root[data-theme="dark"] .cp { --tool-c-gnd: #8ea0b0; --tool-c-pwr: #e57373; --tool-c-pair: #7d9bff; --tool-c-clk: #f0a33a; --tool-c-ctl: #c982e0; --tool-c-data: #3cc7b3; --tool-c-nc: #3a4652;
  --tool-pin-ink: #0b0f13; --tool-shell: #56626e; --tool-body: #0b0f13; --tool-tongue: #26313b; --tool-w-black: #05070a; --tool-w-white: #d7dde3; }
.k-page { padding: 12px; }
@media (max-width: 1280px) { .cp { grid-template-columns: 200px minmax(0, 1fr); } .cp-side { grid-column: 1 / -1; display: grid !important; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
@media (max-width: 760px) { .cp { grid-template-columns: minmax(0, 1fr); } .cp-side { grid-template-columns: minmax(0, 1fr) !important; } }
.cp-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.cp-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px 12px; padding: 7px 10px 3px; font-size: 11.5px; color: var(--ink-soft); }
.cp-head b { color: var(--ink); font-weight: 600; font-size: 12.5px; }
/* shelf */
.cp-shelf { display: flex; flex-direction: column; gap: 2px; padding: 6px; max-height: calc(100vh - 80px); overflow-y: auto; }
.cp-shelf h3 { margin: 6px 4px 2px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-soft); }
.cp-shelf button { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 8px; align-items: center; text-align: left; border: 1px solid transparent;
  background: transparent; border-radius: 5px; padding: 3px 5px; cursor: pointer; color: var(--ink); font-size: 12px; min-width: 0; }
.cp-shelf button:hover { background: var(--sunken); }
.cp-shelf button[aria-current="true"] { border-color: var(--accent); background: var(--sunken); }
.cp-shelf button.dim { opacity: .45; }
.cp-shelf button svg { width: 64px; height: 26px; display: block; }
.cp-shelf button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-shelf .n { font: 600 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--accent-ink); background: var(--accent); border-radius: 8px; padding: 0 6px; }
.cp-shelf .all { grid-template-columns: minmax(0, 1fr) auto; font-weight: 600; }
@media (max-width: 760px) {
  .cp-shelf { flex-direction: row; flex-wrap: wrap; max-height: none; }
  .cp-shelf h3 { display: none; }
  .cp-shelf button, .cp-shelf .all { display: inline-flex; gap: 6px; padding: 3px 7px; border-color: var(--line); }
  .cp-shelf button svg { display: none; }
}
/* stage */
.cp-center { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.cp-stage { min-width: 0; display: flex; flex-direction: column; gap: 0; }
.cp-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 10px; border-bottom: 1px solid var(--line-soft); }
.cp-search { display: flex; align-items: center; gap: 6px; flex: 1 1 220px; min-width: 0; }
.cp-search input { flex: 1; min-width: 0; padding: 4px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 13px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.cp-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
.cp-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.cp-seg button + button { border-left: 1px solid var(--line); }
.cp-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.cp-title { padding: 10px 12px 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.cp-title h2 { margin: 0; font-size: 15px; font-weight: 600; }
.cp-title span { font-size: 12px; color: var(--ink-soft); }
.cp-face { padding: 4px 8px; min-height: 200px; overflow-x: auto; }
.cp-face svg { display: block; width: 100%; touch-action: manipulation; user-select: none; -webkit-user-select: none; }
.cp-view { margin: 0 12px 10px; padding: 6px 10px; border-left: 3px solid var(--accent); background: var(--sunken); border-radius: 0 4px 4px 0; font-size: 12px; }
.cp-view.mir { border-left-color: var(--warn); }
.cp-view b { font-weight: 600; }
.cp-view .fn { color: var(--ink-soft); display: block; margin-top: 3px; }
.cp-legend { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 12px 10px; }
.cp-legend button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line); background: var(--surface); border-radius: 12px;
  padding: 1px 9px 1px 6px; font-size: 11.5px; color: var(--ink-soft); cursor: pointer; }
.cp-legend button i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.cp-legend button[aria-pressed="true"] { border-color: var(--ink); color: var(--ink); }
.cp svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; fill: var(--ink); }
.cp svg text.soft { fill: var(--ink-soft); } .cp svg text.sm { font-size: 10px; } .cp svg text.b { font-weight: 600; }
.cp svg text.num { font-size: 9.5px; font-weight: 600; fill: var(--tool-pin-ink); pointer-events: none; }
.cp .shell { fill: var(--tool-shell); stroke: var(--ink-soft); stroke-width: 1; }
.cp .body { fill: var(--tool-body); stroke: var(--ink-soft); stroke-width: 1; }
.cp .tongue { fill: var(--tool-tongue); stroke: var(--ink-soft); stroke-width: 1; }
.cp .foot { fill: none; stroke: var(--ink-soft); stroke-width: 1; stroke-dasharray: 4 3; }
.cp .pin { cursor: pointer; outline: none; }
.cp .pin .pd { stroke: var(--surface); stroke-width: 1; }
.cp .pin .ring { fill: none; stroke: none; stroke-width: 2.5; }
.cp .pin.sel .ring { stroke: var(--ink); }
.cp .pin.rel .ring { stroke: var(--ink-soft); stroke-dasharray: 3 2; }
.cp .pin.hit .ring { stroke: var(--accent); }
.cp .pin:focus-visible .ring { stroke: var(--accent); stroke-width: 3.5; stroke-dasharray: none; }
.cp .pin.fade { opacity: .22; }
.cp .lbl.fade { opacity: .3; }
.cp .lbl.sel { font-weight: 700; }
.cp .lead { stroke: var(--line); stroke-width: 1; }
.cp .p1 { fill: var(--accent); }
.cp .wire { stroke-width: 5; stroke-linecap: round; }
.cp .wire-o { stroke: var(--ink-soft); stroke-width: 7; stroke-linecap: round; }
/* inspector */
.cp-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.cp-pin { padding: 8px 12px 10px; }
.cp-pin .big { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.cp-pin .big b { font: 600 22px "IBM Plex Mono", ui-monospace, monospace; }
.cp-pin .big span { font: 600 16px "IBM Plex Mono", ui-monospace, monospace; }
.cp-pin .cls { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--ink-soft); margin: 2px 0 6px; }
.cp-pin .cls i { width: 10px; height: 10px; border-radius: 3px; }
.cp-pin p { margin: 4px 0; font-size: 12.5px; }
.cp-pin .rel { font-size: 12px; color: var(--ink-soft); }
.cp-pin .rel button { border: 1px solid var(--line); background: var(--sunken); border-radius: 3px; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; padding: 0 5px; margin: 1px 2px; cursor: pointer; color: var(--ink); }
.cp-list { max-height: 330px; overflow-y: auto; }
.cp-list table { width: 100%; border-collapse: collapse; font-size: 12px; }
.cp-list td { padding: 2px 8px; border-bottom: 1px solid var(--line-soft); cursor: pointer; vertical-align: top; }
.cp-list td:first-child { font-family: "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; width: 1%; }
.cp-list td:nth-child(2) { font-family: "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; }
.cp-list td i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.cp-list tr:hover td { background: var(--sunken); }
.cp-list tr.sel td { background: var(--sunken); font-weight: 600; }
.cp-list tr.hit td:nth-child(2) { color: var(--accent); font-weight: 600; }
.cp-list tr.fade td { color: var(--ink-soft); }
.cp-notes { padding: 4px 12px 10px; font-size: 12px; }
.cp-notes ul { margin: 4px 0; padding-left: 16px; }
.cp-notes li + li { margin-top: 3px; }
.cp-notes .src { color: var(--ink-soft); font-size: 11.5px; }
.cp-warn { display: flex; flex-direction: column; gap: 5px; padding: 0 12px 10px; }
.cp-warn div { border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 5px; padding: 5px 9px; font-size: 12px; }
.cp-warn:empty { display: none; }
/* wall (all connectors) */
.cp-wall[hidden], .cp-face[hidden], .cp-view[hidden], .cp-legend[hidden] { display: none; }
.cp-wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; padding: 10px; }
.cp-tile { border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: 6px 8px; cursor: pointer; text-align: left; color: var(--ink); font: inherit; min-width: 0; }
.cp-tile:hover { border-color: var(--ink-soft); }
.cp-tile.dim { opacity: .4; }
.cp-tile b { font-size: 12px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-tile svg { display: block; width: 100%; height: 72px; margin: 4px 0; }
.cp-tile .m { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--accent); }
.cp-tile .m span { color: var(--ink-soft); }
.cp-outs .k-out { max-height: 240px; }
`;

// ---------- the face drawing ----------
// Pins keyed by position; an entry 'A1/B12' covers both positions.
function pinMap(id) {
  const c = CONNECTORS[id];
  const map = new Map();
  c.pins.forEach(([pin, sig, fn], i) => { for (const p of pin.split('/')) map.set(p, { pos: p, pin, sig, fn, i, cls: classOf(sig) }); });
  return map;
}

/**
 * Draw connector `id` into group `g`, width W. opts: {mini, labels, mirror, match:Set(entry pin), sel, rel:Set, cls}
 * Returns {height, pins: [{pos, x, y}]}.
 */
function drawFace(g, id, W, opts = {}) {
  const f = FACES[id];
  const pm = pinMap(id);
  const rows = f.rows;
  const ncol = Math.max(...rows.map((r) => r.length));
  const stag = f.shape === 'dsub' || f.shape === 'hdmi' || f.shape === 'usba';
  const cols = ncol + (stag ? 0.5 : 0);
  const mini = !!opts.mini;
  const shellPad = mini ? 4 : (f.shape === 'header' ? 10 : 18);
  const maxP = mini ? 12 : (f.shape === 'usbc' ? 50 : 58);
  const p = clamp((W - 2 * shellPad - (mini ? 4 : 24)) / cols, mini ? 3 : 18, maxP);
  const labels = !!opts.labels && !mini;
  const maxLen = labels ? Math.max(...[...pm.values()].map((e) => shortSig(e.sig).length)) : 0;
  const rot = labels && maxLen * 6.8 > p - 4;
  const labH = labels ? (rot ? Math.min(118, maxLen * 5.2 + 16) : 20) : 0;
  const nrows = rows.length;
  const wire = f.shape === 'wire' || !!f.wires;
  const rowGap = f.shape === 'usbc' ? p * 1.25 : f.shape === 'usba' ? p * 1.1 : p * (f.shape === 'sd' ? 1.4 : 1);
  const topLab = labels && nrows > 1 ? labH : 0;
  const y0 = topLab + shellPad + p * 0.6 + (mini ? 0 : 8);
  const faceW = cols * p;
  const x0 = (W - faceW) / 2 + p / 2;
  const wireLen = wire ? (mini ? 8 : p * 2.2) : 0;
  const pts = [];
  const X = (c) => (opts.mirror ? W - c : c);
  rows.forEach((row, ri) => {
    const off = f.shape === 'dsub' ? (ri === 1 ? p / 2 : 0) : f.shape === 'hdmi' ? (ri === 1 ? p / 2 : 0) : f.shape === 'usba' ? (ri === 1 ? 0 : p / 2) : 0;
    row.forEach((pos, ci) => {
      if (!pos) return;
      pts.push({ pos, ri, x: X(x0 + ci * p + off), y: y0 + ri * rowGap });
    });
  });
  const yLast = y0 + (nrows - 1) * rowGap;
  const bx0 = x0 - p / 2 - shellPad + (stag ? 0 : 0), bx1 = x0 + faceW - p / 2 + shellPad;
  const by0 = y0 - p * 0.6 - shellPad, by1 = yLast + p * 0.6 + shellPad;
  const L = Math.min(X(bx0), X(bx1)), R = Math.max(X(bx0), X(bx1));
  // outline by family
  const sh = f.shape;
  if (sh === 'usbc') {
    const r = (by1 - by0) / 2;
    g.append(s('rect', { class: 'shell', x: L, y: by0, width: R - L, height: by1 - by0, rx: r }));
    g.append(s('rect', { class: 'tongue', x: L + r * 0.55, y: y0 - p * 0.55, width: R - L - r * 1.1, height: yLast - y0 + p * 1.1, rx: 3 }));
  } else if (sh === 'usba') {
    g.append(s('rect', { class: 'shell', x: L, y: by0, width: R - L, height: by1 - by0 + (mini ? 0 : p * 0.4), rx: 2 }));
    g.append(s('rect', { class: 'tongue', x: L + shellPad * 0.4, y: by0 + shellPad * 0.4, width: R - L - shellPad * 0.8, height: yLast - by0 + p * 0.2, rx: 2 }));
  } else if (sh === 'micro') {
    const c = (by1 - by0) * 0.35;
    const d = `M${L},${by0}H${R}V${by1 - c}L${R - c},${by1}H${L + c}L${L},${by1 - c}Z`;
    g.append(s('path', { class: 'shell', d }));
    g.append(s('rect', { class: 'tongue', x: L + c * 0.6, y: y0 - p * 0.45, width: R - L - c * 1.2, height: p * 0.9, rx: 2 }));
  } else if (sh === 'header' || sh === 'boxed') {
    if (sh === 'boxed') {
      const m = mini ? 2 : 7;
      const nx = (L + R) / 2, nw = mini ? 6 : Math.min(3.2 * p, 60);
      g.append(s('path', { class: 'shell', d: `M${L - m},${by0 - m}H${nx - nw / 2}V${by0}H${nx + nw / 2}V${by0 - m}H${R + m}V${by1 + m}H${L - m}Z` }));
    }
    g.append(s('rect', { class: 'body', x: L, y: by0, width: R - L, height: by1 - by0, rx: 2 }));
  } else if (sh === 'pads') {
    g.append(s('rect', { class: 'foot', x: L, y: by0, width: R - L, height: by1 - by0, rx: 6 }));
  } else if (sh === 'jst' || sh === 'wire') {
    const tab = sh === 'jst' ? p * 0.45 : 0;
    g.append(s('rect', { class: 'body', x: L, y: by0, width: R - L, height: by1 - by0, rx: 2 }));
    if (tab) {
      g.append(s('rect', { class: 'shell', x: L - tab, y: by0 + (by1 - by0) * 0.15, width: tab, height: (by1 - by0) * 0.7, rx: 1 }));
      g.append(s('rect', { class: 'shell', x: R, y: by0 + (by1 - by0) * 0.15, width: tab, height: (by1 - by0) * 0.7, rx: 1 }));
    }
  } else if (sh === 'rj45') {
    const hh = by1 - by0;
    g.append(s('rect', { class: 'shell', x: L, y: by0, width: R - L, height: hh * 1.5, rx: 3 }));
    const lw = (R - L) * 0.34;
    g.append(s('rect', { class: 'tongue', x: (L + R) / 2 - lw / 2, y: by0 + hh * 1.5 - 2, width: lw, height: mini ? 3 : hh * 0.5, rx: 2 }));
  } else if (sh === 'dsub') {
    const c = (R - L) * 0.07;
    g.append(s('path', { class: 'shell', d: `M${L - c},${by0}H${R + c}L${R - c},${by1}H${L + c}Z`, 'stroke-linejoin': 'round' }));
  } else if (sh === 'hdmi') {
    const c = (by1 - by0) * 0.45;
    g.append(s('path', { class: 'shell', d: `M${L},${by0}H${R}V${by1 - c}L${R - c},${by1}H${L + c}L${L},${by1 - c}Z` }));
    g.append(s('rect', { class: 'tongue', x: L + 5, y: y0 - p * 0.45, width: R - L - 10, height: yLast - y0 + p * 0.9, rx: 2 }));
  } else if (sh === 'sd') {
    const c = (R - L) * 0.1;
    const d = opts.mirror ? `M${R},${by0}H${L + c}L${L},${by0 + c}V${by1 + p * 2}H${R}Z` : `M${L},${by0}H${R - c}L${R},${by0 + c}V${by1 + p * 2}H${L}Z`;
    g.append(s('path', { class: 'tongue', d }));
  }
  // wires under single-row cable connectors
  if (wire && f.wires) {
    pts.forEach((pt) => {
      const idx = rows[0].indexOf(pt.pos);
      const col = f.wires[idx];
      if (!col) return;
      g.append(s('line', { class: 'wire-o', x1: pt.x, x2: pt.x, y1: by1, y2: by1 + wireLen }));
      g.append(s('line', { class: 'wire', x1: pt.x, x2: pt.x, y1: by1, y2: by1 + wireLen, stroke: `var(${WIRE[col]})` }));
    });
  }
  // pins
  const cardEdge = ['usbc', 'usba', 'micro', 'rj45', 'hdmi', 'sd'].includes(sh);
  const fade = opts.match && opts.match.size >= 0 && opts.filterOn;
  const pinEls = [];
  for (const pt of pts) {
    const e = pm.get(pt.pos);
    if (!e) continue;
    const missing = (f.missing || []).includes(pt.pos);
    const isSel = opts.sel && opts.sel === e.pin;
    const isHit = opts.match?.has(e.pin);
    const isRel = opts.rel?.has(e.pin) && !isSel;
    const clsFade = opts.cls && opts.cls !== e.cls;
    const gg = s('g', { class: `pin${isSel ? ' sel' : ''}${isHit ? ' hit' : ''}${isRel ? ' rel' : ''}${(fade && !isHit) || clsFade ? ' fade' : ''}`,
      'data-pos': pt.pos, 'data-pin': e.pin });
    const col = `var(--tool-c-${e.cls})`;
    let w, hh, rx;
    if (sh === 'sd') { w = p * 0.62; hh = p * 1.5; rx = 1.5; }
    else if (cardEdge) { w = p * 0.5; hh = p * (sh === 'rj45' ? 1.1 : 0.9); rx = 1.5; }
    else if (sh === 'pads') { w = hh = p * 0.72; rx = w / 2; }
    else if (sh === 'jst' || sh === 'wire') { w = p * 0.5; hh = p * 0.6; rx = 1; }
    else { w = hh = p * 0.62; rx = pt.pos === '1' ? 1.5 : w / 2; }
    if (sh === 'usba' && pt.ri === 1) { w *= 0.8; hh *= 0.7; }
    if (missing) {
      gg.append(s('rect', { x: pt.x - w / 2, y: pt.y - hh / 2, width: w, height: hh, rx, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-dasharray': '2 2' }));
    } else {
      gg.append(s('rect', { class: 'pd', x: pt.x - w / 2, y: pt.y - hh / 2, width: w, height: hh, rx, fill: col }));
    }
    if (!mini) {
      gg.append(s('rect', { class: 'ring', x: pt.x - w / 2 - 3, y: pt.y - hh / 2 - 3, width: w + 6, height: hh + 6, rx: Math.min(rx + 3, (w + 6) / 2) }));
      const numTxt = pt.pos.length <= 3 && p >= 24 ? pt.pos : pt.pos.length <= 2 && p >= 18 ? pt.pos : '';
      if (numTxt && !missing) gg.append(s('text', { x: pt.x, y: pt.y + 3.5, 'text-anchor': 'middle', class: 'num', style: e.cls === 'nc' ? 'fill:var(--ink)' : null }, numTxt));
      gg.append(s('title', {}, `Pin ${pt.pos}${e.pin !== pt.pos ? ` (${e.pin})` : ''}: ${e.sig}${e.fn ? ` - ${e.fn}` : ''}`));
      gg.setAttribute('tabindex', '-1');
      gg.setAttribute('role', 'button');
      gg.setAttribute('aria-label', `Pin ${pt.pos}, ${e.sig}${e.fn ? `, ${e.fn}` : ''}`);
    }
    g.append(gg);
    pinEls.push({ ...pt, e, el: gg });
  }
  // pin 1 marker
  if (!mini) {
    const first = pts.find((pt) => pt.pos === '1' || pt.pos === 'A1');
    if (first) {
      const dx = opts.mirror ? 1 : -1;
      const tx = first.x + dx * (p * 0.5 + 6), ty = first.y - p * 0.5 - 4;
      g.append(s('path', { class: 'p1', d: `M${tx},${ty}l${-dx * 7},0l${dx * 3.5},6z` }));
    }
  }
  // labels: row 0 above (when two rows), the last row below
  let bottom = by1 + (sh === 'rj45' ? (by1 - by0) * 1.0 : 0) + (sh === 'sd' ? p * 2 : 0) + wireLen;
  if (labels) {
    for (const pe of pinEls) {
      const above = nrows > 1 && pe.ri === 0;
      const t = shortSig(pe.e.sig);
      const ly = above ? by0 - 8 : bottom + 12;
      const cl = `lbl${pe.el.classList.contains('fade') ? ' fade' : ''}${pe.el.classList.contains('sel') ? ' sel' : ''}`;
      const attrs = { class: `${cl}${pe.e.cls === 'nc' ? ' soft' : ''}`, 'data-pin': pe.e.pin };
      if (rot) {
        const a = above ? -55 : 55;
        const txt = s('text', { ...attrs, x: pe.x, y: ly, transform: `rotate(${a} ${pe.x} ${ly})`, 'text-anchor': 'start' }, t);
        if (above) { txt.setAttribute('text-anchor', 'start'); }
        g.append(txt);
      } else {
        g.append(s('text', { ...attrs, x: pe.x, y: above ? ly : ly + 2, 'text-anchor': 'middle' }, t));
      }
      if (!above && !wire && sh !== 'rj45' && sh !== 'sd') g.append(s('line', { class: 'lead', x1: pe.x, x2: pe.x, y1: pe.y + p * 0.5, y2: bottom + 2 }));
    }
    bottom += labH;
  }
  return { height: bottom + 6, pins: pinEls, p };
}

export function page(root, ctx) {
  document.head.append(h('style', { text: STYLE }));
  let res = null, mirror = false, selPin = null, clsOnly = null, focusPos = null;

  // ---------- shelf ----------
  const shelf = h('nav', { class: 'cp-card cp-shelf', 'aria-label': 'Connectors' });
  const shelfBtns = {};
  const allBtn = h('button', { class: 'all', type: 'button', onclick: () => pick('all') }, h('span', {}, 'All connectors'), h('span', { class: 'n', hidden: true }));
  shelf.append(allBtn);
  let fam = null;
  for (const id of Object.keys(FACES)) {
    if (FACES[id].family !== fam) { fam = FACES[id].family; shelf.append(h('h3', {}, fam)); }
    const mini = s('svg', { viewBox: '0 0 64 26', 'aria-hidden': 'true' });
    const opt = ctx.manifest.inputs.find((d) => d.key === 'connector').options.find((o) => o[0] === id);
    const b = h('button', { type: 'button', title: CONNECTORS[id].name, onclick: () => pick(id) }, mini, h('span', {}, opt ? opt[1] : id), h('span', { class: 'n', hidden: true }));
    shelfBtns[id] = { b, mini };
    shelf.append(b);
  }
  function pick(id) { selPin = null; clsOnly = null; ctx.set('connector', id); }
  function drawMinis(matchBy) {
    for (const [id, { b, mini }] of Object.entries(shelfBtns)) {
      mini.replaceChildren();
      const g = s('g'); mini.append(g);
      const r = drawFace(g, id, 64, { mini: true, match: matchBy?.[id] || new Set(), filterOn: !!matchBy });
      // fit height
      mini.setAttribute('viewBox', `0 ${Math.max(0, r.height / 2 - 20)} 64 ${Math.max(26, Math.min(40, r.height))}`);
      const n = matchBy ? (matchBy[id]?.size || 0) : 0;
      const badge = b.querySelector('.n');
      badge.hidden = !matchBy || !n; badge.textContent = String(n);
      b.classList.toggle('dim', !!matchBy && !n);
      b.setAttribute('aria-current', String(ctx.raw.connector === id));
    }
    allBtn.setAttribute('aria-current', String(ctx.raw.connector === 'all'));
    const tot = matchBy ? Object.values(matchBy).reduce((a, x) => a + x.size, 0) : 0;
    const nb = allBtn.querySelector('.n'); nb.hidden = !matchBy; nb.textContent = String(tot);
  }

  // ---------- stage ----------
  const search = h('input', { type: 'search', spellcheck: 'false', placeholder: 'Find a signal: CC, SWDIO, GND, SDA…', 'aria-label': 'Search pins' });
  search.addEventListener('input', () => { ctx.set('filter', search.value); });
  const mirBtns = [['0', 'As specified'], ['1', 'Mirrored']].map(([v, t]) => h('button', { type: 'button', 'data-v': v, onclick: () => { mirror = v === '1'; draw(); } }, t));
  const bar = h('div', { class: 'cp-bar' }, h('label', { class: 'cp-search' }, search),
    h('span', { class: 'cp-seg', role: 'group', 'aria-label': 'Side seen from' }, mirBtns));
  const title = h('div', { class: 'cp-title' });
  const face = s('svg', { role: 'group', 'aria-label': 'Connector face' });
  const faceBox = h('div', { class: 'cp-face' }, face);
  const view = h('div', { class: 'cp-view' });
  const legend = h('div', { class: 'cp-legend' });
  const stageWarn = h('div', { class: 'cp-warn', 'aria-live': 'polite' });
  const wall = h('div', { class: 'cp-wall' });
  const stage = h('section', { class: 'cp-card cp-stage' }, bar, title, stageWarn, faceBox, wall, view, legend);

  // ---------- inspector ----------
  const pinCard = h('section', { class: 'cp-card cp-pin', 'aria-live': 'polite' });
  const listCard = h('section', { class: 'cp-card' });
  const notesCard = h('section', { class: 'cp-card' });
  ctx.outputs.classList.add('cp-outs');
  const side = h('aside', { class: 'cp-side' }, pinCard, listCard, notesCard);
  root.append(h('div', { class: 'cp' }, shelf, h('div', { class: 'cp-center' }, stage, ctx.outputs), side));

  // ---------- matches from run()'s rows ----------
  const nameToId = Object.fromEntries(Object.entries(CONNECTORS).map(([id, c]) => [c.name, id]));
  function matches() {
    const f = String(ctx.raw.filter || '').trim();
    if (!f || !res?.tables?.[0]) return null;
    const t = res.tables[0];
    const multi = t.columns[0] === 'Connector';
    const out = {};
    for (const r of t.rows) {
      const id = multi ? nameToId[r[0]] : ctx.raw.connector;
      (out[id] ||= new Set()).add(multi ? r[1] : r[0]);
    }
    return out;
  }
  // The shelf counts come from a run over all connectors, done by the kit's own tool.
  let allMatch = null;
  async function shelfMatches() {
    const f = String(ctx.raw.filter || '').trim();
    if (!f) { allMatch = null; return; }
    try {
      const r = run({ connector: 'all', filter: f });
      const out = {};
      for (const row of r.tables?.[0]?.rows || []) (out[nameToId[row[0]]] ||= new Set()).add(row[1]);
      allMatch = out;
    } catch { allMatch = null; }
  }

  function draw() {
    const id = ctx.raw.connector;
    const m = matches();
    drawMinis(allMatch);
    for (const b of mirBtns) b.setAttribute('aria-pressed', String((b.dataset.v === '1') === mirror));
    if (document.activeElement !== search) search.value = ctx.raw.filter || '';
    stageWarn.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    if (!FACES[id]) { drawWall(m); return; }
    wall.hidden = true; faceBox.hidden = false; view.hidden = false; legend.hidden = false;
    const c = CONNECTORS[id], f = FACES[id];
    title.replaceChildren(h('h2', {}, c.name), h('span', {}, `${c.pins.length} ${c.pins.length === 1 ? 'entry' : 'entries'} · ${c.pitch}`));
    // selection defaults to pin 1
    const pm = pinMap(id);
    const entries = [...new Map([...pm.values()].map((e) => [e.pin, e])).values()].sort((a, b) => a.i - b.i);
    if (!selPin || !entries.find((e) => e.pin === selPin)) selPin = (m?.[id] && [...m[id]][0]) || entries[0].pin;
    const sel = entries.find((e) => e.pin === selPin);
    const rel = new Set();
    const ps = partnerSig(sel.sig);
    for (const e of entries) if (e.pin !== sel.pin && (e.sig === sel.sig || (ps && e.sig === ps))) rel.add(e.pin);
    // face
    const cols = Math.max(...f.rows.map((row) => row.length)) + 1;
    const W = Math.max(300, faceBox.clientWidth - 16 || 700, cols * 19 + 40);
    face.replaceChildren();
    const g = s('g');
    face.append(g);
    const r = drawFace(g, id, W, { labels: true, mirror, match: m?.[id] || new Set(), filterOn: !!m, sel: selPin, rel, cls: clsOnly });
    const H = Math.max(160, r.height + 10);
    face.setAttribute('viewBox', `0 0 ${W} ${H}`); face.setAttribute('height', H); face.style.minWidth = `${W}px`;
    // roving focus over pins
    const focusable = r.pins.filter((p) => p.e);
    const fp = focusable.find((p) => p.pos === focusPos) || focusable.find((p) => p.e.pin === selPin) || focusable[0];
    if (fp) fp.el.setAttribute('tabindex', '0');
    face._pins = r.pins;
    if (focusPos) {
      const el = face.querySelector(`.pin[data-pos="${CSS.escape(focusPos)}"]`);
      if (el && document.activeElement !== el && root.contains(document.activeElement) === false) { /* keep page focus */ }
      if (el && refocus) { el.focus({ preventScroll: true }); refocus = false; }
    }
    view.className = `cp-view${mirror ? ' mir' : ''}`;
    view.replaceChildren(...[h('b', {}, mirror ? 'Mirrored: ' : 'Seen as: '), mirror ? `the other side of what the standard shows (${c.view.replace(/\.$/, '')}). A footprint seen from the solder side, or a plug against its receptacle, looks like this.` : c.view,
      f.note ? h('span', { class: 'fn' }, f.note) : null].filter(Boolean));
    // legend (click a class to show only it)
    const present = new Set(entries.map((e) => e.cls));
    legend.replaceChildren(...CLASSES.filter(([k]) => present.has(k)).map(([k, name]) => h('button', { type: 'button', 'aria-pressed': String(clsOnly === k),
      onclick: () => { clsOnly = clsOnly === k ? null : k; draw(); } }, h('i', { style: `background:var(--tool-c-${k})` }), name)));
    // inspector
    const same = entries.filter((e) => e.pin !== sel.pin && e.sig === sel.sig);
    const partner = ps ? entries.find((e) => e.sig === ps) : null;
    const jump = (e) => h('button', { type: 'button', onclick: () => { selPin = e.pin; focusPos = e.pin.split('/')[0]; draw(); } }, e.pin);
    pinCard.replaceChildren(...[
      h('div', { class: 'big' }, h('b', {}, sel.pin), h('span', {}, sel.sig)),
      h('div', { class: 'cls' }, h('i', { style: `background:var(--tool-c-${sel.cls})` }), CLASSES.find(([k]) => k === sel.cls)[1]),
      sel.fn ? h('p', {}, sel.fn) : null,
      partner ? h('div', { class: 'rel' }, 'Pair partner ', jump(partner), ` ${partner.sig}`) : null,
      same.length ? h('div', { class: 'rel' }, `Also ${sel.sig} on `, same.map(jump)) : null].filter(Boolean));
    // compact list
    const hits = m?.[id];
    listCard.replaceChildren(h('div', { class: 'cp-head' }, h('b', {}, 'Pins'), h('span', {}, hits ? `${hits.size} match "${ctx.raw.filter}"` : 'click a row or a pin')),
      h('div', { class: 'cp-list' }, h('table', {}, h('tbody', {}, entries.map((e) => h('tr', {
        class: `${e.pin === selPin ? 'sel' : ''}${hits?.has(e.pin) ? ' hit' : ''}${hits && !hits.has(e.pin) ? ' fade' : ''}`,
        onclick: () => { selPin = e.pin; draw(); } },
      h('td', {}, h('i', { style: `background:var(--tool-c-${e.cls})` }), e.pin), h('td', {}, e.sig), h('td', {}, e.fn)))))));
    notesCard.replaceChildren(h('div', { class: 'cp-head' }, h('b', {}, 'Design notes')),
      h('div', { class: 'cp-notes' }, h('ul', {}, [...c.notes, 'Check pin 1 against the footprint drawing of the exact part: a mirrored footprint is the most common connector error.'].map((n) => h('li', {}, n))),
        h('div', { class: 'src' }, `Source: ${c.src}.`)));
  }
  let refocus = false;

  function drawWall(m) {
    faceBox.hidden = true; view.hidden = true; legend.hidden = true; wall.hidden = false;
    const f = String(ctx.raw.filter || '').trim();
    const n = m ? Object.values(m).reduce((a, x) => a + x.size, 0) : 0;
    title.replaceChildren(h('h2', {}, 'All connectors'), h('span', {}, f ? `${n} pins match "${f}" in ${m ? Object.keys(m).length : 0} connectors` : 'type a signal name to light it up on every face · click a face to open it'));
    wall.replaceChildren();
    const ids = Object.keys(FACES).sort((a, b) => (m ? (m[b]?.size || 0) - (m[a]?.size || 0) : 0));
    for (const id of ids) {
      const svg = s('svg', { 'aria-hidden': 'true' });
      const g = s('g'); svg.append(g);
      const hits = m?.[id] || new Set();
      const tw = Math.max(200, (Math.max(...FACES[id].rows.map((row) => row.length)) + 1) * 19 + 16);
      const r = drawFace(g, id, tw, { mini: false, labels: false, mirror, match: hits, filterOn: !!m });
      svg.setAttribute('viewBox', `0 0 ${tw} ${Math.max(60, r.height)}`);
      const pm = pinMap(id);
      const hitList = [...hits].map((pin) => { const e = [...pm.values()].find((x) => x.pin === pin); return `${pin} ${e ? e.sig : ''}`; });
      wall.append(h('button', { class: `cp-tile${m && !hits.size ? ' dim' : ''}`, type: 'button', onclick: () => { selPin = hits.size ? [...hits][0] : null; ctx.set('connector', id); } },
        h('b', {}, CONNECTORS[id].name), svg,
        m ? h('div', { class: 'm' }, hitList.length ? hitList.slice(0, 4).join(' · ') + (hitList.length > 4 ? ` +${hitList.length - 4}` : '') : h('span', {}, 'no match')) : h('div', { class: 'm' }, h('span', {}, CONNECTORS[id].pitch))));
    }
    pinCard.replaceChildren(h('div', { class: 'rel' }, 'Open a connector to read its pins one by one.'));
    const t = res?.tables?.[0];
    listCard.replaceChildren(h('div', { class: 'cp-head' }, h('b', {}, 'Matching pins'), h('span', {}, t ? `${t.rows.length}` : '')),
      h('div', { class: 'cp-list' }, h('table', {}, h('tbody', {}, (f && t ? t.rows : []).map((r) => h('tr', { onclick: () => { selPin = r[1]; ctx.set('connector', nameToId[r[0]]); } },
        h('td', {}, r[1]), h('td', {}, r[2]), h('td', {}, r[0])))))));
    notesCard.replaceChildren(h('div', { class: 'cp-notes' }, (res?.notes || []).map((x) => h('p', { style: 'margin:4px 0' }, x))));
  }

  // pointer and keyboard on the face
  face.addEventListener('click', (e) => {
    const p = e.target.closest('.pin'); if (!p) return;
    selPin = p.dataset.pin; focusPos = p.dataset.pos; refocus = true; draw();
  });
  face.addEventListener('keydown', (e) => {
    const p = e.target.closest?.('.pin'); if (!p || !face._pins) return;
    const pins = face._pins;
    const cur = pins.find((q) => q.pos === p.dataset.pos);
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const t = e.key === 'Home' ? pins[0] : pins[pins.length - 1];
      selPin = t.e.pin; focusPos = t.pos; refocus = true; draw(); return;
    }
    if (!dir) return;
    e.preventDefault();
    // nearest pin in that direction
    let best = null, bd = Infinity;
    for (const q of pins) {
      if (q === cur) continue;
      const dx = q.x - cur.x, dy = q.y - cur.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 1) continue;
      const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
      const d = along + across * 3;
      if (d < bd) { bd = d; best = q; }
    }
    if (best) { selPin = best.e.pin; focusPos = best.pos; refocus = true; draw(); }
  });

  ctx.onResult(async (r) => { res = r; await shelfMatches(); draw(); });
  let lw = 0;
  new ResizeObserver(() => { const w = faceBox.clientWidth + root.clientWidth; if (w !== lw) { lw = w; if (res) draw(); } }).observe(root);
}
