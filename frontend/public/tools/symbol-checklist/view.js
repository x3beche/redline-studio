// Schematic Symbol Checklist: the page is the symbol under review, on its
// library sheet. Every check that applies to this part sits on the drawing
// as a numbered balloon with a leader to the place it is about - the pin
// numbers, the ~RESET name, the stacked GND pins, the exposed pad, the pin
// end on the 100 mil grid, the fields in the properties block - and the
// verification steps are rubber stamps at the foot of the sheet. Click a
// balloon, the spot it points at, a stamp or a row in the list to tick it.
// Open items that would put wrong connections on the board are red.
// The part kind, multi-unit and exposed pad switch the drawing and the list.
// Every state and count shown comes from run()'s result.symbol.

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

const VW = 960, VH = 640, G = 20;
const KINDS = [['ic', 'IC / active'], ['passive', 'Passive'], ['conn', 'Connector']];
const TYPE_TAG = { I: 'in', O: 'out', B: 'bidir', OD: 'open-drain', P: 'pwr in', PS: 'passive', NC: 'nc' };

// ---------- the three symbols: pins and the spots the checks point at ----------
// A spot: [x, y] the leader ends at, a box [x, y, w, h] that lights up and
// can be clicked, and the side its balloon goes on.
function icSymbol(o) {
  const body = [240, 120, 200, 320];
  const L = [['~{RESET}', 7, 'I'], ['BOOT0', 44, 'I'], ['OSC_IN', 5, 'I'], ['PA0/ADC0', 10, 'I'], ['SWDIO', 34, 'B'], ['SWCLK', 37, 'I'], ['PA8', 29, 'B']];
  const R = [['UART_TX', 30, 'O'], ['SPI_MOSI', 17, 'O'], ['SPI_SCK', 15, 'O'], ['SDA', 42, 'OD'], ['SCL', 43, 'OD'], ['~{INT}', 12, 'OD'], ['NC', 21, 'NC']];
  const pins = [
    ...L.map(([n, num, t], i) => ({ name: n, num, t, x1: 180, y1: 160 + i * 40, x2: 240, y2: 160 + i * 40, side: 'L' })),
    ...R.map(([n, num, t], i) => ({ name: n, num, t, x1: 500, y1: 160 + i * 40, x2: 440, y2: 160 + i * 40, side: 'R' })),
    { name: 'VDD', num: 1, t: 'P', x1: 280, y1: 60, x2: 280, y2: 120, side: 'T' },
    { name: 'VDD', num: 24, t: 'P', x1: 320, y1: 60, x2: 320, y2: 120, side: 'T' },
    { name: 'VDDA', num: 9, t: 'P', x1: 400, y1: 60, x2: 400, y2: 120, side: 'T' },
    { name: 'GND', num: '8, 23', t: 'P', x1: 280, y1: 500, x2: 280, y2: 440, side: 'B', stacked: true },
    { name: 'VSSA', num: 25, t: 'P', x1: 320, y1: 500, x2: 320, y2: 440, side: 'B' },
  ];
  if (o.ep) pins.push({ name: 'EP', num: 49, t: 'P', x1: 400, y1: 500, x2: 400, y2: 440, side: 'B', ep: true });
  const spots = {
    p_count: { at: [250, 120], box: [176, 56, 328, 448], side: 'T', hint: `QFN-48${o.ep ? ' + EP' : ''} = ${o.ep ? 49 : 48} pins` },
    p_numbers: { at: [210, 194], box: [196, 184, 28, 12], side: 'L' },
    p_names: { at: [262, 158], box: [244, 150, 58, 18], side: 'L' },
    p_types: { at: [210, 246], box: [192, 240, 40, 12], side: 'L' },
    p_power: { at: [320, 76], box: [270, 56, 140, 64], side: 'T' },
    p_od: { at: [470, 274], box: [410, 268, 94, 36], side: 'R' },
    p_nc: { at: [496, 400], box: [408, 390, 100, 20], side: 'R' },
    p_hidden: { at: [360, 76], box: [346, 50, 30, 72], side: 'T' },
    p_stacked: { at: [280, 470], box: [268, 440, 26, 64], side: 'L' },
    p_ep: { at: [400, 472], box: [388, 440, 26, 64], side: 'R' },
    g_grid: { at: [180, 160], box: [170, 150, 20, 20], side: 'L' },
    g_layout: { at: [256, 330], box: [244, 150, 192, 280], side: 'L' },
    g_pin1: { at: [266, 130], box: [258, 122, 16, 16], side: 'T' },
    g_text: { at: [420, 200], box: [372, 192, 64, 16], side: 'R' },
    g_origin: { at: [340, 290], box: [326, 276, 28, 28], side: 'R' },
    m_units: { at: [140, 104], box: [100, 94, 120, 22], side: 'L' },
    m_swap: { at: [170, 104], box: [100, 94, 120, 22], side: 'L' },
    m_power: { at: [200, 104], box: [100, 94, 120, 22], side: 'L' },
  };
  return { body, pins, spots, ref: 'U1', value: 'STM32G031K8U6', ghost: { x: 360, name: 'VDDIO' },
    refAt: [446, 112], valAt: [446, 462], pin1: [266, 130], origin: [340, 290],
    fields: { Reference: 'U1', Value: 'STM32G031K8U6', Footprint: 'QFN-48_7x7mm_P0.5mm_EP5.6x5.6mm', 'Manufacturer / MPN': 'ST · STM32G031K8U6', Datasheet: 'st.com/…/stm32g031k8.pdf', 'Description / keywords': 'Arm Cortex-M0+ MCU, 64 KB flash' } };
}
function passiveSymbol(o) {
  const pins = [
    { name: '+', num: 1, t: 'PS', x1: 160, y1: 300, x2: 290, y2: 300, side: 'L', hideName: true },
    { name: '−', num: 2, t: 'PS', x1: 440, y1: 300, x2: 312, y2: 300, side: 'R', hideName: true },
  ];
  if (o.ep) pins.push({ name: 'EP', num: 3, t: 'PS', x1: 300, y1: 460, x2: 300, y2: 400, side: 'B', ep: true });
  const spots = {
    p_count: { at: [300, 262], box: [156, 250, 290, 130], side: 'T', hint: `${o.ep ? 3 : 2} pins` },
    p_numbers: { at: [222, 290], box: [212, 280, 20, 14], side: 'L' },
    p_ep: { at: [300, 430], box: [288, 380, 24, 84], side: 'R' },
    g_grid: { at: [160, 300], box: [150, 290, 20, 20], side: 'L' },
    g_pin1: { at: [270, 272], box: [258, 260, 24, 24], side: 'L' },
    g_text: { at: [330, 220], box: [276, 206, 80, 36], side: 'R' },
    g_origin: { at: [300, 300], box: [288, 288, 24, 24], side: 'R' },
    m_units: { at: [140, 104], box: [100, 94, 120, 22], side: 'L' },
    m_swap: { at: [170, 104], box: [100, 94, 120, 22], side: 'L' },
    m_power: { at: [200, 104], box: [100, 94, 120, 22], side: 'L' },
  };
  return { cap: true, pins, spots, ref: 'C1', value: '100µF', refAt: [304, 226], valAt: [304, 246], pin1: [270, 272], origin: [300, 300],
    fields: { Reference: 'C1', Value: '100µF', Rating: '25 V · 20 % · 105 °C', Footprint: 'CP_Elec_6.3x7.7', 'Manufacturer / MPN': 'Panasonic · EEE-FK1E101P', Datasheet: 'industrial.panasonic.com/…', 'Description / keywords': 'Aluminium electrolytic, SMD' } };
}
function connSymbol(o) {
  const body = [300, 140, 90, 240];
  const names = [['VBUS', 1, 'P'], ['D−', 2, 'B'], ['D+', 3, 'B'], ['ID', 4, 'NC'], ['GND', 5, 'P']];
  const pins = names.map(([n, num, t], i) => ({ name: n, num, t: t === 'P' ? 'PS' : t, x1: 240, y1: 180 + i * 40, x2: 300, y2: 180 + i * 40, side: 'L' }));
  pins.push({ name: 'SHIELD', num: 6, t: 'PS', x1: 360, y1: 440, x2: 360, y2: 380, side: 'B', shell: true });
  if (o.ep) pins.push({ name: 'EP', num: 7, t: 'PS', x1: 320, y1: 440, x2: 320, y2: 380, side: 'B', ep: true });
  const spots = {
    p_count: { at: [330, 140], box: [236, 136, 158, 308], side: 'T', hint: `${o.ep ? 7 : 6} pins incl. shell` },
    p_numbers: { at: [270, 216], box: [260, 206, 20, 12], side: 'L' },
    p_names: { at: [318, 176], box: [304, 168, 46, 16], side: 'L' },
    p_nc: { at: [250, 300], box: [236, 290, 110, 20], side: 'L' },
    p_ep: { at: [320, 424], box: [308, 380, 24, 64], side: 'L' },
    g_grid: { at: [240, 180], box: [230, 170, 20, 20], side: 'L' },
    g_pin1: { at: [306, 180], box: [300, 172, 14, 16], side: 'R' },
    g_text: { at: [330, 256], box: [304, 248, 50, 16], side: 'R' },
    g_origin: { at: [340, 260], box: [328, 248, 24, 24], side: 'R' },
    c_mating: { at: [470, 250], box: [440, 200, 150, 90], side: 'R' },
    c_shell: { at: [360, 424], box: [348, 380, 24, 64], side: 'R' },
    m_units: { at: [140, 104], box: [100, 94, 120, 22], side: 'L' },
    m_swap: { at: [170, 104], box: [100, 94, 120, 22], side: 'L' },
    m_power: { at: [200, 104], box: [100, 94, 120, 22], side: 'L' },
  };
  return { body, pins, spots, ref: 'J1', value: 'USB_B_Micro', refAt: [396, 132], valAt: [396, 396], pin1: [306, 180], origin: [340, 260], mating: true,
    fields: { Reference: 'J1', Value: 'USB_B_Micro', Footprint: 'USB_Micro-B_Molex-105017-0001', 'Manufacturer / MPN': 'Molex · 105017-0001', Datasheet: 'molex.com/…/1050170001', 'Description / keywords': 'USB 2.0 Micro-B receptacle, SMD' } };
}
const FIELD_KEY = { Reference: 'f_ref', Value: 'f_value', Footprint: 'f_fp', 'Manufacturer / MPN': 'f_mpn', Rating: 'f_rating', Datasheet: 'f_ds', 'Description / keywords': 'f_desc' };
const STAMPS = [['v_lib', 'LIBRARY CHECK'], ['v_erc', 'ERC TEST SHEET'], ['v_review', '2ND REVIEWER']];

// Name with KiCad's ~{...} overbar
function nameText(parent, x, y, name, attrs) {
  const t = sv(parent, 'text', { x, y, ...attrs });
  const m = /^~\{(.*)\}$/.exec(name);
  if (m) { sv(t, 'tspan', { 'text-decoration': 'overline', class: 'ovl' }, m[1]); } else t.textContent = name;
  return t;
}

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let Y = null;          // result.symbol
  let hot = null;        // key under the pointer / keyboard
  let focusKey = null;

  // ---------- top bar ----------
  const kindSeg = h('div', { class: 'sc-seg', role: 'radiogroup', 'aria-label': 'Part kind' });
  const kindBtns = KINDS.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set('kind', v),
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault();
      const i = (KINDS.findIndex((k) => k[0] === v) + d + KINDS.length) % KINDS.length; ctx.set('kind', KINDS[i][0]);
      requestAnimationFrame(() => kindSeg.querySelector(`[data-v="${KINDS[i][0]}"]`)?.focus());
    } }, t));
  kindSeg.append(...kindBtns);
  const tog = (key, label) => h('button', { type: 'button', class: 'sc-tog', 'aria-pressed': 'false', onclick: () => ctx.set(key, !ctx.raw[key]) }, label);
  const multiBtn = tog('multi', 'Multi-unit');
  const epBtn = tog('ep', 'Exposed / thermal pad');
  const clearBtn = h('button', { type: 'button', class: 'k-btn', onclick: () => {
    if (!Y) return; ctx.setMany(Object.fromEntries(Y.items.map((it) => [it.key, false])));
  } }, 'Untick all');
  const bar = h('div', { class: 'sc-bar' }, h('span', { class: 'sc-cap' }, 'Symbol of a'), kindSeg, multiBtn, epBtn, h('span', { class: 'sc-sp' }), clearBtn);

  // ---------- the sheet ----------
  const svg = sv(null, 'svg', { class: 'sc-svg', viewBox: `0 0 ${VW} ${VH}`, role: 'group', 'aria-label': 'Schematic symbol under review, with a numbered balloon for each check' });
  const note = h('div', { class: 'sc-note', 'aria-live': 'polite' });
  const sheet = h('section', { class: 'sc-sheet' }, h('div', { class: 'sc-svgwrap' }, svg), note);

  // ---------- the list ----------
  const prog = h('div', { class: 'sc-prog' });
  const list = h('div', { class: 'sc-list', role: 'group', 'aria-label': 'Checks' });
  const side = h('aside', { class: 'sc-side' }, prog, list, h('div', { class: 'sc-out' }, ctx.outputs));
  root.append(h('div', { class: 'sc' }, bar, sheet, side));

  const toggle = (key) => { if (!Y) return; const it = Y.items.find((x) => x.key === key); if (it) ctx.set(key, !it.done); };
  const setHot = (key) => { if (hot === key) return; hot = key; paintHot(); };

  // ---------- drawing ----------
  function draw() {
    svg.replaceChildren();
    const o = { ep: Y.ep, multi: Y.multi };
    const S = Y.kind === 'passive' ? passiveSymbol(o) : Y.kind === 'conn' ? connSymbol(o) : icSymbol(o);
    const num = Object.fromEntries(Y.items.map((it, i) => [it.key, i + 1]));
    const state = Object.fromEntries(Y.items.map((it) => [it.key, it]));
    const defs = sv(svg, 'defs');
    const pat = sv(defs, 'pattern', { id: 'sc-dots', width: G, height: G, patternUnits: 'userSpaceOnUse' });
    sv(pat, 'circle', { cx: 0, cy: 0, r: 1, class: 'sc-dot' });
    sv(svg, 'rect', { x: 0, y: 0, width: VW, height: VH, class: 'sc-paper' });
    sv(svg, 'rect', { x: 0, y: 0, width: 680, height: 550, fill: 'url(#sc-dots)' });
    sv(svg, 'rect', { x: 6, y: 6, width: VW - 12, height: VH - 12, class: 'sc-frame' });

    const g = sv(svg, 'g', { class: 'sc-sym' });
    // multi-unit tabs
    if (Y.multi) {
      const tabs = [['A', 'unit A'], ['B', 'unit B'], ['C', 'power']];
      tabs.forEach(([t, lab], i) => {
        sv(g, 'rect', { x: 100 + i * 40, y: 94, width: 38, height: 22, rx: 3, class: `sc-tab${i === 0 ? ' on' : ''}` });
        sv(g, 'text', { x: 119 + i * 40, y: 109, class: 'sc-tabt', 'text-anchor': 'middle' }, t);
      });
      sv(g, 'text', { x: 100, y: 88, class: 'sc-soft' }, 'units: A (shown), B, C = power');
    }
    // body
    if (S.body) sv(g, 'rect', { x: S.body[0], y: S.body[1], width: S.body[2], height: S.body[3], class: 'sc-body' });
    if (S.cap) {
      sv(g, 'line', { x1: 290, y1: 260, x2: 290, y2: 340, class: 'sc-plate' });
      sv(g, 'path', { d: 'M318,260 Q306,300 318,340', class: 'sc-plate' });
      sv(g, 'text', { x: 270, y: 280, class: 'sc-plus', 'text-anchor': 'middle' }, '+');
    }
    // hidden pin ghost
    if (S.ghost) {
      sv(g, 'line', { x1: S.ghost.x, y1: 60, x2: S.ghost.x, y2: 120, class: 'sc-ghost' });
      sv(g, 'text', { x: S.ghost.x + 5, y: 90, class: 'sc-soft' }, `${S.ghost.name} hidden?`);
    }
    // pins
    for (const p of S.pins) {
      sv(g, 'line', { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, class: `sc-pin${p.t === 'NC' ? ' nc' : ''}` });
      sv(g, 'circle', { cx: p.x1, cy: p.y1, r: 2.2, class: 'sc-end' });
      if (p.t === 'NC') { sv(g, 'path', { d: `M${p.x1 - 5},${p.y1 - 5}l10,10M${p.x1 + 5},${p.y1 - 5}l-10,10`, class: 'sc-x' }); }
      const horiz = p.side === 'L' || p.side === 'R';
      const mx = (p.x1 + p.x2) / 2, my = (p.y1 + p.y2) / 2;
      const tag = TYPE_TAG[p.t];
      if (horiz) {
        sv(g, 'text', { x: mx, y: p.y1 - 4, class: 'sc-num', 'text-anchor': 'middle' }, String(p.num));
        sv(g, 'text', { x: mx, y: p.y1 + 11, class: `sc-type t-${p.t}`, 'text-anchor': 'middle' }, tag);
        if (!p.hideName) nameText(g, p.side === 'L' ? p.x2 + 6 : p.x2 - 6, p.y1 + 4, p.name, { class: 'sc-name', 'text-anchor': p.side === 'L' ? 'start' : 'end' });
      } else {
        sv(g, 'text', { x: p.x1 - 4, y: my + 4, class: 'sc-num', 'text-anchor': 'end' }, String(p.num));
        sv(g, 'text', { x: p.x1, y: p.side === 'T' ? p.y1 - 5 : p.y1 + 12, class: `sc-type t-${p.t}`, 'text-anchor': 'middle' }, p.stacked ? `${tag} ×2` : tag);
        const ny = p.side === 'T' ? p.y2 + 14 : p.y2 - 6;
        const nt = nameText(g, p.x1, ny, p.name, { class: 'sc-name', 'text-anchor': 'middle' });
        if (S.cap && p.ep) nt.setAttribute('y', p.y1 + 14);
      }
      if (p.stacked) { sv(g, 'line', { x1: p.x1 + 3, y1: p.y1, x2: p.x2 + 3, y2: p.y2, class: 'sc-pin' }); }
    }
    // pin 1, origin, ref and value
    sv(g, 'circle', { cx: S.pin1[0], cy: S.pin1[1], r: 3, class: 'sc-pin1' });
    const [ox, oy] = S.origin;
    sv(g, 'path', { d: `M${ox - 8},${oy}h16M${ox},${oy - 8}v16`, class: 'sc-origin' });
    sv(g, 'circle', { cx: ox, cy: oy, r: 4, class: 'sc-origin' });
    sv(g, 'text', { x: S.refAt[0], y: S.refAt[1], class: 'sc-ref', 'text-anchor': S.cap ? 'middle' : 'start' }, S.ref);
    sv(g, 'text', { x: S.valAt[0], y: S.valAt[1], class: 'sc-val', 'text-anchor': S.cap ? 'middle' : 'start' }, S.value);
    if (Y.kind === 'ic') {
      sv(g, 'text', { x: 234, y: 436, class: 'sc-soft', 'text-anchor': 'end' }, 'inputs →');
      sv(g, 'text', { x: 446, y: 436, class: 'sc-soft' }, '→ outputs');
    }
    if (S.mating) {
      const mg = sv(g, 'g', {});
      sv(mg, 'rect', { x: 450, y: 210, width: 130, height: 50, rx: 8, class: 'sc-body' });
      [5, 4, 3, 2, 1].forEach((n, i) => {
        sv(mg, 'rect', { x: 464 + i * 22, y: 222, width: 12, height: 18, class: 'sc-contact' });
        sv(mg, 'text', { x: 470 + i * 22, y: 254, class: 'sc-num', 'text-anchor': 'middle' }, String(n));
      });
      sv(mg, 'text', { x: 450, y: 202, class: 'sc-soft' }, 'plug, mating face: 5 … 1');
    }
    // properties block
    const fx = 700, fy = 44;
    sv(svg, 'text', { x: fx, y: fy, class: 'sc-h' }, 'Properties');
    const fields = Object.entries(S.fields).filter(([k]) => state[FIELD_KEY[k]] || k === 'Reference' || k === 'Value' || k === 'Footprint');
    const fspots = {};
    fields.forEach(([k, v], i) => {
      const y = fy + 16 + i * 40;
      sv(svg, 'rect', { x: fx, y, width: 240, height: 34, class: 'sc-field' });
      sv(svg, 'text', { x: fx + 30, y: y + 13, class: 'sc-fk' }, k);
      sv(svg, 'text', { x: fx + 30, y: y + 27, class: 'sc-fv' }, v.length > 29 ? `${v.slice(0, 28)}…` : v);
      const key = FIELD_KEY[k];
      if (state[key]) fspots[key] = { balloon: [fx + 15, y + 17], box: [fx, y, 240, 34] };
    });
    // verification stamps
    const stampSpots = {};
    STAMPS.forEach(([key, label], i) => {
      if (!state[key]) return;
      stampSpots[key] = { box: [30 + i * 205, 566, 190, 58], balloon: [44 + i * 205, 580] };
    });
    sv(svg, 'text', { x: 30, y: 558, class: 'sc-h' }, 'Verification');
    // title block
    const tb = sv(svg, 'g', { class: 'sc-title' });
    sv(tb, 'rect', { x: 690, y: 520, width: 256, height: 108 });
    sv(tb, 'line', { x1: 690, y1: 546, x2: 946, y2: 546 });
    sv(tb, 'text', { x: 700, y: 538, class: 'sc-h' }, 'SYMBOL REVIEW');
    sv(tb, 'text', { x: 936, y: 538, class: 'sc-soft', 'text-anchor': 'end' }, `${S.ref} · ${KINDS.find((k) => k[0] === Y.kind)[1]}`);
    sv(tb, 'text', { x: 700, y: 578, class: `sc-big ${Y.pct === 100 ? 'ok' : Y.blockers.length ? 'bad' : 'warn'}` }, `${Y.pct} %`);
    sv(tb, 'text', { x: 800, y: 568, class: 'sc-fv' }, `${Y.done} of ${Y.total} checked`);
    sv(tb, 'text', { x: 800, y: 584, class: `sc-fv ${Y.blockers.length ? 'bad' : 'ok'}` }, Y.blockers.length ? `${Y.blockers.length} blocking open` : 'no blocking item open');
    sv(tb, 'rect', { x: 700, y: 596, width: 236, height: 8, class: 'sc-ptrk' });
    sv(tb, 'rect', { x: 700, y: 596, width: (236 * Y.pct) / 100, height: 8, class: `sc-pbar ${Y.pct === 100 ? 'ok' : Y.blockers.length ? 'bad' : 'warn'}` });
    sv(tb, 'text', { x: 700, y: 620, class: 'sc-soft' }, `${Y.notApplicable} checks not applicable to this part`);

    // ---------- the spots, stamps and balloons ----------
    const hl = sv(svg, 'g', { class: 'sc-hl' });  // highlight layer, drawn under the balloons
    const lay = sv(svg, 'g', { class: 'sc-balloons' });
    const place = (side) => {
      const list = Y.items.filter((it) => S.spots[it.key] && S.spots[it.key].side === side)
        .map((it) => ({ it, sp: S.spots[it.key], y: S.spots[it.key].at[1] }))
        .sort((a, b) => a.y - b.y);
      const gap = 30, top = 40, bottom = 530;
      for (let i = 0; i < list.length; i++) list[i].y = Math.max(list[i].y, i ? list[i - 1].y + gap : top);
      for (let i = list.length - 1; i >= 0; i--) list[i].y = Math.min(list[i].y, i < list.length - 1 ? list[i + 1].y - gap : bottom);
      return list;
    };
    const balloon = (it, bx, by, leaderTo, box, extraCls = '') => {
      const st = it.done ? 'done' : it.blocker ? 'block' : 'open';
      const grp = sv(lay, 'g', { class: `sc-b ${st}${extraCls}`, tabindex: '0', role: 'checkbox', 'aria-checked': String(it.done), 'data-k': it.key,
        'aria-label': `${num[it.key]}. ${it.group}: ${it.what}` });
      if (leaderTo && extraCls === ' top') {
        sv(grp, 'path', { d: `M${bx},${by + 12} L${bx},${Math.min(leaderTo[1] - 6, by + 22)} L${leaderTo[0]},${leaderTo[1]}`, class: 'lead' });
        sv(grp, 'circle', { cx: leaderTo[0], cy: leaderTo[1], r: 2.6, class: 'tip' });
      } else if (leaderTo) {
        sv(grp, 'path', { d: `M${bx + (leaderTo[0] > bx ? 12 : -12)},${by} L${leaderTo[0] > bx ? Math.min(leaderTo[0] - 8, bx + 40) : Math.max(leaderTo[0] + 8, bx - 40)},${by} L${leaderTo[0]},${leaderTo[1]}`, class: 'lead' });
        sv(grp, 'circle', { cx: leaderTo[0], cy: leaderTo[1], r: 2.6, class: 'tip' });
      }
      sv(grp, 'circle', { cx: bx, cy: by, r: 12, class: 'ring' });
      sv(grp, 'text', { x: bx, y: by + 4, 'text-anchor': 'middle', class: 'n' }, it.done ? '✓' : String(num[it.key]));
      if (box) {
        const r = sv(hl, 'rect', { x: box[0] - 3, y: box[1] - 3, width: box[2] + 6, height: box[3] + 6, rx: 4, class: `sc-spot ${st}`, 'data-k': it.key });
        r.addEventListener('click', () => { focusKey = it.key; toggle(it.key); });
        r.addEventListener('pointerenter', () => setHot(it.key));
        r.addEventListener('pointerleave', () => setHot(null));
      }
      return grp;
    };
    for (const { it, sp, y } of place('L')) balloon(it, 60, y, sp.at, sp.box);
    for (const { it, sp, y } of place('R')) balloon(it, 640, y, sp.at, sp.box);
    // along the top: sorted by x
    const topList = Y.items.filter((it) => S.spots[it.key]?.side === 'T').map((it) => ({ it, sp: S.spots[it.key], x: S.spots[it.key].at[0] })).sort((a, b) => a.x - b.x);
    for (let i = 0; i < topList.length; i++) topList[i].x = Math.max(topList[i].x - 40, i ? topList[i - 1].x + 30 : 120);
    for (const { it, sp, x } of topList) balloon(it, x, 28, sp.at, sp.box, ' top');
    for (const [key, sp] of Object.entries(fspots)) balloon(state[key], sp.balloon[0], sp.balloon[1], null, sp.box);
    STAMPS.forEach(([key, label]) => {
      const sp = stampSpots[key]; if (!sp) return;
      const it = state[key];
      const [x, y, w, hh] = sp.box;
      const sg = sv(hl, 'g', { class: `sc-stamp ${it.done ? 'done' : it.blocker ? 'block' : 'open'}`, 'data-k': key });
      sv(sg, 'rect', { x, y, width: w, height: hh, rx: 4, class: 'frame' });
      const tg = sv(sg, 'g', { transform: it.done ? `rotate(-4 ${x + w / 2} ${y + hh / 2})` : null });
      sv(tg, 'text', { x: x + w / 2 + 8, y: y + 26, class: 'st1', 'text-anchor': 'middle' }, label);
      sv(tg, 'text', { x: x + w / 2 + 8, y: y + 45, class: 'st2', 'text-anchor': 'middle' }, it.done ? 'PASSED' : 'not yet');
      sg.addEventListener('click', () => { focusKey = key; toggle(key); });
      sg.addEventListener('pointerenter', () => setHot(key));
      sg.addEventListener('pointerleave', () => setHot(null));
      balloon(it, sp.balloon[0], sp.balloon[1], null, null, ' stampb');
    });
    // spot hint text (pin count)
    if (S.spots.p_count?.hint && state.p_count) sv(svg, 'text', { x: S.cap ? 330 : S.valAt[0], y: S.cap ? 480 : S.valAt[1] + 16, class: 'sc-soft' }, S.spots.p_count.hint);

    for (const b of lay.querySelectorAll('.sc-b')) {
      const k = b.dataset.k;
      b.addEventListener('click', () => { focusKey = k; toggle(k); });
      b.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); focusKey = k; toggle(k); } });
      b.addEventListener('focus', () => setHot(k));
      b.addEventListener('blur', () => setHot(null));
      b.addEventListener('pointerenter', () => setHot(k));
      b.addEventListener('pointerleave', () => setHot(null));
    }
    if (focusKey) {
      const el = lay.querySelector(`.sc-b[data-k="${focusKey}"]`);
      if (el && (document.activeElement === document.body || document.activeElement?.closest?.('.sc-svg'))) el.focus({ preventScroll: true });
    }
  }

  // ---------- the list ----------
  function drawList() {
    const groups = [...new Set(Y.items.map((it) => it.group))];
    list.replaceChildren(...groups.map((gname) => {
      const items = Y.items.map((it, i) => ({ it, n: i + 1 })).filter(({ it }) => it.group === gname);
      const gs = Y.groups.find((x) => x.group === gname);
      return h('div', { class: 'sc-grp' },
        h('div', { class: 'sc-gh' }, h('b', {}, gname), h('span', { class: gs?.done ? 'ok' : '' }, gs ? gs.count : '')),
        ...items.map(({ it, n }) => {
          const cb = h('input', { type: 'checkbox', id: `sc-${it.key}`, checked: it.done, onchange: () => { focusKey = null; ctx.set(it.key, !it.done); } });
          const row = h('div', { class: `sc-row ${it.done ? 'done' : it.blocker ? 'block' : 'open'}`, 'data-k': it.key,
            onpointerenter: () => setHot(it.key), onpointerleave: () => setHot(null) },
          cb, h('label', { for: `sc-${it.key}` }, h('span', { class: 'sc-n' }, String(n)), h('span', { class: 'w' }, it.what)),
          h('div', { class: 'sc-why' }, it.why));
          cb.addEventListener('focus', () => setHot(it.key));
          cb.addEventListener('blur', () => setHot(null));
          return row;
        }));
    }));
    const tone = Y.pct === 100 ? 'ok' : Y.blockers.length ? 'bad' : 'warn';
    prog.replaceChildren(
      h('div', { class: 'sc-ph' }, h('b', { class: tone }, `${Y.done} / ${Y.total}`), h('span', {}, ` checked · ${Y.pct} %`)),
      h('div', { class: 'sc-pb' }, h('i', { class: tone, style: `width:${Y.pct}%` })),
      Y.blockers.length
        ? h('div', { class: 'sc-block' }, `Do not use the symbol yet: ${Y.blockers.length} open item${Y.blockers.length > 1 ? 's' : ''} (red) would put wrong or missing connections on the board.`)
        : h('div', { class: 'sc-okmsg' }, Y.pct === 100 ? 'Every check is done: the symbol is ready to use.' : 'No blocking item open.'));
  }

  function paintHot() {
    for (const el of root.querySelectorAll('.is-hot')) el.classList.remove('is-hot');
    if (!Y) return;
    const it = hot && Y.items.find((x) => x.key === hot);
    if (!it) {
      const next = Y.items.find((x) => !x.done && x.blocker) || Y.items.find((x) => !x.done);
      note.replaceChildren(next
        ? h('span', {}, h('b', {}, 'Next: '), `${Y.items.indexOf(next) + 1}. ${next.what}`)
        : h('span', {}, h('b', {}, 'All checked. '), 'Hover a balloon to read what it covers.'));
      note.className = 'sc-note';
      return;
    }
    for (const el of root.querySelectorAll(`[data-k="${hot}"]`)) el.classList.add('is-hot');
    note.className = `sc-note ${it.done ? 'done' : it.blocker ? 'block' : 'open'}`;
    note.replaceChildren(h('b', {}, `${Y.items.indexOf(it) + 1}. ${it.group}: ${it.what}`), h('span', {}, ` ${it.done ? 'Checked.' : 'Open'}${it.done ? '' : ` - ${it.why}`}`));
  }

  ctx.onResult((res) => {
    const raw = ctx.raw;
    kindBtns.forEach((b) => { const on = b.dataset.v === (raw.kind || 'ic'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    multiBtn.setAttribute('aria-pressed', String(!!raw.multi));
    epBtn.setAttribute('aria-pressed', String(!!raw.ep));
    Y = res.symbol || null;
    if (!Y) { svg.replaceChildren(); list.replaceChildren(); return; }
    draw(); drawList(); paintHot();
  });
}
