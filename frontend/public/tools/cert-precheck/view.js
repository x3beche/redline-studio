// Certification Pre-Check page: the product on its way to the lab, in a
// cutaway - the power source, the enclosure with the board inside (input
// filter, DC/DC, MCU, crystal, radio, connectors, battery), the cable to what
// it is used with, the rating label, the paperwork and the pre-scan probe.
// Every check item is a numbered pin on the part of the product it is about:
// red = critical and open, outlined = open, green = done. Click a pin (or
// Space / Enter on a focused one) to tick it; arrows walk the pins. The
// product redraws with the market, power and radio chosen at the top - a
// mains product gets its inlet, fuse and creepage slot, a module its keep-out
// and exposure distance, a battery its cell - and items that do not apply
// leave the drawing. At the side: the selected item in full and the punch
// list by group (same numbers), the rules in scope and the outputs below.
// Every state, count and percentage shown comes from run()'s result
// (result.checklist, result.values).

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

// Where each item sits on the drawing: pin p, leader to anchor a.
const PINS = {
  f_input: { p: [322, 226], a: [322, 262] },
  e_surge: { p: [296, 362], a: [320, 336] },
  f_switcher: { p: [462, 226], a: [460, 250] },
  f_decouple: { p: [466, 190], a: [487, 211] },
  e_recover: { p: [604, 212], a: [580, 232] },
  g_crystal: { p: [480, 380], a: [505, 348] },
  f_edges: { p: [606, 266], a: [600, 300] },
  e_reset: { p: [566, 402], a: [548, 384] },
  g_plane: { p: [400, 398], a: [412, 380] },
  g_edge: { p: [282, 134], a: [268, 119] },
  e_esd: { p: [664, 290], a: [676, 268] },
  g_shield: { p: [765, 190], a: [748, 214] },
  f_cables: { p: [812, 196], a: [812, 226] },
  p_worst: { p: [868, 176], a: [884, 205] },
  r_grant: { p: [572, 148], a: [596, 150] },
  r_discrete: { p: [572, 148], a: [596, 150] },
  r_testmode: { p: [706, 196], a: [690, 176] },
  r_keepout: { p: [560, 98], a: [596, 106] },
  r_exposure: { p: [800, 72], a: [772, 92] },
  s_fuse: { p: [322, 164], a: [320, 190] },
  s_creepage: { p: [384, 136], a: [362, 150] },
  s_adapter: { p: [100, 216], a: [100, 236] },
  s_battery: { p: [524, 444], a: [502, 444] },
  l_ce: { p: [290, 506], a: [306, 534] },
  l_weee: { p: [392, 506], a: [392, 524] },
  l_fcc: { p: [736, 566], a: [712, 566] },
  l_doc: { p: [796, 300], a: [812, 312] },
  l_manual: { p: [796, 384], a: [812, 396] },
  r_red: { p: [796, 468], a: [812, 480] },
  p_prescan: { p: [70, 470], a: [92, 494] },
};
const GROUP_SHORT = { 'EMC filtering': 'EMC', 'Grounding & layout': 'GND', 'ESD & immunity': 'ESD', Safety: 'SAF', Radio: 'RF', 'Labels & documents': 'DOC', 'Pre-test': 'PRE' };
const MK = { both: 'CE + FCC', ce: 'CE', fcc: 'FCC' };

const ICON = {
  battery: '<svg viewBox="0 0 24 16" aria-hidden="true"><rect x="1" y="3" width="19" height="10" rx="2"/><rect x="20" y="6" width="2.5" height="4"/><rect x="3" y="5" width="9" height="6" class="f"/></svg>',
  lowv: '<svg viewBox="0 0 24 16" aria-hidden="true"><rect x="1" y="3" width="11" height="10" rx="2"/><path d="M12 8 H17 Q20 8 20 5 V2"/><rect x="18.5" y="1" width="3" height="3" class="f"/></svg>',
  mains: '<svg viewBox="0 0 24 16" aria-hidden="true"><path d="M3 3 V8 M7 3 V8"/><rect x="1" y="7" width="8" height="6" rx="1.5"/><path d="M9 10 Q15 10 15 5 T22 4"/></svg>',
  none: '<svg viewBox="0 0 24 16" aria-hidden="true"><rect x="6" y="4" width="12" height="9" rx="1.5"/><path d="M4 2 L20 14"/></svg>',
  module: '<svg viewBox="0 0 24 16" aria-hidden="true"><rect x="5" y="6" width="14" height="9" rx="1.5"/><path d="M7 6 V3 H10 V5 H13 V3 H16 V5"/></svg>',
  discrete: '<svg viewBox="0 0 24 16" aria-hidden="true"><rect x="3" y="7" width="7" height="7" rx="1"/><path d="M10 10 H14 M14 7 V13 M16 10 H19 V3"/></svg>',
};

export function page(root, ctx) {
  const state = { sel: null, hoverGroup: null, refocus: null };
  const ck = () => ctx.result?.checklist || null;

  // ---------- skeleton ----------
  const mkSeg = h('div', { class: 'cp-seg', role: 'group', 'aria-label': 'Market' });
  const pwSeg = h('div', { class: 'cp-seg ic', role: 'group', 'aria-label': 'Power' });
  const rfSeg = h('div', { class: 'cp-seg ic', role: 'group', 'aria-label': 'Radio' });
  const liBtn = h('button', { type: 'button', class: 'cp-tog', onclick: () => ctx.set('battery', !ctx.raw.battery) });
  const stats = h('div', { class: 'cp-stats', 'aria-live': 'polite' });
  const gauge = h('div', { class: 'cp-gauge' });
  const svg = sv('svg', { class: 'cp-svg', viewBox: '0 0 1000 632', role: 'group', 'aria-label': 'The product in cutaway, with a pin on each check item' });
  const defs = sv('defs');
  defs.innerHTML = '<pattern id="cp-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2.4" height="7" style="fill:var(--tool-keep)"/></pattern>'
    + '<pattern id="cp-plane" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="1" height="10" style="fill:var(--tool-cu);opacity:.16"/></pattern>';
  const gArt = sv('g'), gLead = sv('g'), gPins = sv('g');
  svg.append(defs, gArt, gLead, gPins);
  const scroller = h('div', { class: 'cp-scroll' }, svg);
  const legend = h('div', { class: 'cp-legend' });
  legend.innerHTML = '<span><i class="pin crit"></i>critical, open</span><span><i class="pin open"></i>open</span><span><i class="pin done"></i>done</span>'
    + '<span class="cp-keys">Click a pin to tick it · focused pin: Space ticks, arrows go to the next · the list at the side has the same numbers</span>';
  const drawP = h('section', { class: 'cp-panel cp-drawp' },
    h('div', { class: 'cp-head' }, h('h2', {}, 'The product'), h('span', { class: 'cp-sub', id: 'cp-cfg' }), h('span', { class: 'cp-grow' }), gauge),
    scroller, legend);
  const detail = h('section', { class: 'cp-panel cp-detail', 'aria-live': 'polite' });
  const listHead = h('div', { class: 'cp-head' }, h('h2', {}, 'Punch list'), h('span', { class: 'cp-sub' }, 'open first within each group'));
  const list = h('div', { class: 'cp-list' });
  const listP = h('section', { class: 'cp-panel cp-listp' }, listHead, list);
  const regs = h('section', { class: 'cp-panel cp-regs' });
  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  root.append(h('div', { class: 'cp' },
    h('div', { class: 'cp-top' },
      h('div', { class: 'cp-ctl' }, h('span', { class: 'cp-lbl' }, 'Market'), mkSeg),
      h('div', { class: 'cp-ctl' }, h('span', { class: 'cp-lbl' }, 'Power'), pwSeg),
      h('div', { class: 'cp-ctl' }, h('span', { class: 'cp-lbl' }, 'Radio'), rfSeg),
      liBtn, stats),
    h('div', { class: 'cp-work' }, drawP, h('div', { class: 'cp-side' }, detail, listP)),
    h('div', { class: 'cp-bottom' }, h('div', { class: 'cp-col' }, warns, regs, notes), ctx.outputs)));

  // ---------- actions ----------
  const itemBy = (key) => ck()?.items.find((it) => it.key === key) || null;
  const liveItems = () => (ck()?.items || []).filter((it) => it.live);
  const toggle = (key) => { const it = itemBy(key); if (!it || !it.live) return; state.sel = key; state.refocus = key; ctx.set(key, !it.done); };
  const select = (key) => { state.sel = key; render(); };

  // ---------- the drawing ----------
  function art(c) {
    gArt.replaceChildren();
    const A = (el) => { gArt.append(el); return el; };
    const T = (x, y, t, cls = 'cp-t', anchor = 'start') => A(sv('text', { x, y, class: cls, 'text-anchor': anchor }, t));
    const mains = c.power === 'mains', lowv = c.power === 'lowv', wired = c.power !== 'battery';
    const hasCell = c.power === 'battery' || c.battery;
    // RF exposure distance (behind everything)
    if (c.radio !== 'none') {
      A(sv('path', { d: 'M 645 106 m -150 0 a 150 150 0 0 1 300 0', class: 'cp-arc' }));
      T(790, 104, '20 cm', 'cp-t soft', 'start');
    }
    // power source, outside
    if (lowv) {
      A(sv('rect', { x: 40, y: 236, width: 120, height: 72, rx: 8, class: 'cp-box' }));
      T(100, 268, 'Adapter', 'cp-t b', 'middle'); T(100, 284, '5 V / 12 V out', 'cp-t soft', 'middle');
      A(sv('path', { d: 'M160 272 C 190 272, 195 277, 224 277', class: 'cp-cable' }));
    } else if (mains) {
      A(sv('rect', { x: 50, y: 250, width: 64, height: 50, rx: 6, class: 'cp-box' }));
      A(sv('path', { d: 'M66 250 V236 M98 250 V236', class: 'cp-prong' }));
      T(82, 318, 'Mains cord', 'cp-t soft', 'middle');
      A(sv('path', { d: 'M114 275 C 170 275, 180 277, 224 277', class: 'cp-cable thick' }));
    } else {
      T(128, 280, 'Battery only:', 'cp-t soft', 'middle'); T(128, 296, 'no power cable', 'cp-t soft', 'middle');
    }
    // enclosure and board
    A(sv('rect', { x: 230, y: 70, width: 520, height: 400, rx: 18, class: 'cp-encl' }));
    T(244, 90, 'Enclosure', 'cp-t soft');
    A(sv('rect', { x: 265, y: 115, width: 450, height: 305, rx: 6, class: 'cp-pcb' }));
    A(sv('rect', { x: 265, y: 115, width: 450, height: 305, rx: 6, class: 'cp-plane' }));
    for (let x = 275; x <= 705; x += 18) { A(sv('circle', { cx: x, cy: 122, r: 2.2, class: 'cp-via' })); A(sv('circle', { cx: x, cy: 413, r: 2.2, class: 'cp-via' })); }
    for (let y = 140; y <= 395; y += 18) { A(sv('circle', { cx: 272, cy: y, r: 2.2, class: 'cp-via' })); A(sv('circle', { cx: 708, cy: y, r: 2.2, class: 'cp-via' })); }
    T(420, 405, 'GND plane', 'cp-t soft');
    // input
    if (wired) {
      A(sv('rect', { x: 222, y: 257, width: 58, height: 40, rx: 4, class: 'cp-conn' }));
      T(251, 312, mains ? 'Inlet' : 'Power in', 'cp-t soft', 'middle');
      // filter: common-mode choke
      A(sv('rect', { x: 308, y: 262, width: 28, height: 30, rx: 3, class: 'cp-part' }));
      A(sv('path', { d: 'M312 270 q 5 -5 10 0 q 5 5 10 0 M312 284 q 5 -5 10 0 q 5 5 10 0', class: 'cp-coil' }));
      A(sv('path', { d: 'M280 277 H308 M336 277 H392', class: 'cp-trace' }));
      // TVS / MOV
      A(sv('path', { d: 'M320 292 V316 M312 316 H328 L320 328 Z M312 328 H328 M320 328 V342', class: 'cp-sym' }));
    }
    if (mains) {
      A(sv('rect', { x: 300, y: 190, width: 40, height: 14, rx: 3, class: 'cp-part' }));
      T(346, 201, 'F1', 'cp-t soft');
      A(sv('path', { d: 'M290 204 V257', class: 'cp-trace' }));
      A(sv('line', { x1: 362, y1: 126, x2: 362, y2: 410, class: 'cp-slot' }));
      A(sv('text', { x: 354, y: 330, class: 'cp-t soft', 'text-anchor': 'middle', transform: 'rotate(-90 354 330)' }, 'creepage slot'));
    }
    // DC/DC
    A(sv('rect', { x: 392, y: 257, width: 38, height: 38, rx: 3, class: 'cp-ic' }));
    T(411, 280, 'DC/DC', 'cp-t ic', 'middle');
    A(sv('rect', { x: 444, y: 252, width: 32, height: 28, rx: 5, class: 'cp-part' }));
    A(sv('path', { d: 'M449 266 q 4 -7 8 0 q 4 7 8 0 q 4 -7 8 0', class: 'cp-coil' }));
    A(sv('path', { d: 'M476 266 H490', class: 'cp-trace' }));
    // MCU with decoupling
    A(sv('rect', { x: 490, y: 215, width: 90, height: 90, rx: 4, class: 'cp-ic' }));
    T(535, 258, 'MCU', 'cp-t ic b', 'middle'); T(535, 274, 'watchdog', 'cp-t ic', 'middle');
    for (const [x, y] of [[480, 206], [582, 206], [480, 306], [582, 306]]) A(sv('rect', { x, y, width: 10, height: 6, rx: 1, class: 'cp-cap' }));
    // crystal
    A(sv('rect', { x: 492, y: 335, width: 30, height: 13, rx: 6, class: 'cp-part' }));
    T(528, 346, 'XTAL', 'cp-t soft');
    A(sv('path', { d: 'M507 305 V335', class: 'cp-trace' }));
    // clock / data to a peripheral, with a series resistor
    A(sv('path', { d: 'M580 290 H594 M606 290 H612 Q620 290 620 300 V320', class: 'cp-trace fast' }));
    A(sv('rect', { x: 594, y: 286, width: 12, height: 8, rx: 1, class: 'cp-cap' }));
    A(sv('rect', { x: 612, y: 320, width: 58, height: 44, rx: 3, class: 'cp-ic' }));
    T(641, 346, 'Sensor', 'cp-t ic', 'middle');
    // reset
    A(sv('circle', { cx: 548, cy: 384, r: 9, class: 'cp-part' }));
    T(535, 388, 'RST', 'cp-t soft', 'end');
    A(sv('path', { d: 'M548 375 V305', class: 'cp-trace' }));
    // I/O connector, cable, accessory
    A(sv('rect', { x: 700, y: 214, width: 60, height: 42, rx: 4, class: 'cp-conn shell' }));
    A(sv('path', { d: 'M670 262 H700 M676 258 V268', class: 'cp-sym' }));
    A(sv('path', { d: 'M580 240 H700', class: 'cp-trace' }));
    A(sv('path', { d: 'M760 235 C 800 235, 820 236, 884 234', class: 'cp-cable' }));
    A(sv('rect', { x: 800, y: 226, width: 24, height: 18, rx: 4, class: 'cp-ferrite' }));
    A(sv('rect', { x: 884, y: 205, width: 96, height: 60, rx: 6, class: 'cp-box' }));
    T(932, 232, 'Sensor / host', 'cp-t b', 'middle'); T(932, 248, 'as sold', 'cp-t soft', 'middle');
    // radio
    if (c.radio === 'module') {
      A(sv('rect', { x: 596, y: 96, width: 100, height: 26, class: 'cp-keep' }));
      A(sv('rect', { x: 596, y: 122, width: 100, height: 56, rx: 3, class: 'cp-mod' }));
      A(sv('path', { d: 'M604 130 H612 V140 H622 V130 H632 V140 H642 V130 H652 V140 H662 V130 H672', class: 'cp-ant' }));
      T(646, 164, 'Radio module', 'cp-t ic', 'middle');
      T(646, 91, 'keep-out', 'cp-t soft', 'middle');
    } else if (c.radio === 'discrete') {
      A(sv('rect', { x: 596, y: 96, width: 100, height: 26, class: 'cp-keep' }));
      A(sv('rect', { x: 600, y: 140, width: 34, height: 34, rx: 3, class: 'cp-ic' }));
      T(617, 161, 'RF', 'cp-t ic', 'middle');
      A(sv('path', { d: 'M634 157 H648 M648 150 V164 M656 150 V164 M656 157 H676 V128', class: 'cp-sym' }));
      A(sv('rect', { x: 668, y: 118, width: 18, height: 10, rx: 2, class: 'cp-part' }));
      T(646, 91, 'keep-out', 'cp-t soft', 'middle');
    }
    // battery
    if (hasCell) {
      A(sv('rect', { x: 300, y: 428, width: 200, height: 32, rx: 10, class: 'cp-cell' }));
      A(sv('rect', { x: 500, y: 438, width: 6, height: 12, rx: 1, class: 'cp-cell' }));
      A(sv('rect', { x: 306, y: 434, width: 36, height: 20, rx: 3, class: 'cp-part' }));
      T(324, 448, 'PCM', 'cp-t soft', 'middle');
      T(420, 449, 'Li-ion cell', 'cp-t b', 'middle');
    }
    // the rating label
    A(sv('rect', { x: 262, y: 494, width: 456, height: 126, rx: 8, class: 'cp-label' }));
    T(276, 488, 'Rating label (underside)', 'cp-t soft');
    const showCE = c.market !== 'fcc', showFCC = c.market !== 'ce';
    if (showCE) {
      A(sv('text', { x: 292, y: 574, class: 'cp-ce' }, 'CE'));
      // WEEE bin
      A(sv('path', { d: 'M380 528 H404 L400 566 H384 Z M378 528 H406 M388 524 H396 M374 522 L410 572 M410 522 L374 572', class: 'cp-bin' }));
      A(sv('rect', { x: 378, y: 576, width: 28, height: 5, class: 'cp-binbar' }));
    }
    const lx = showCE ? 430 : 290;
    T(lx, 530, 'Manufacturer name, postal address', 'cp-t lbl');
    T(lx, 546, 'Type / model · rating · serial no.', 'cp-t lbl');
    if (showFCC) {
      T(lx, 566, c.radio === 'module' ? 'Contains FCC ID: XXX-MOD01' : 'FCC SDoC: complies with Part 15', 'cp-t lbl');
      T(lx, 582, 'This device complies with part 15 of the FCC', 'cp-t lbl soft');
      T(lx, 596, 'Rules. Operation is subject to two conditions…', 'cp-t lbl soft');
    }
    // paperwork
    const doc = (y, hh, t1, t2) => {
      A(sv('path', { d: `M812 ${y} h140 l18 18 v${hh - 18} h-158 z`, class: 'cp-doc' }));
      A(sv('path', { d: `M952 ${y} v18 h18`, class: 'cp-doc' }));
      T(824, y + 22, t1, 'cp-t b'); T(824, y + 38, t2, 'cp-t soft');
    };
    T(812, 290, 'Paperwork', 'cp-t soft');
    doc(302, 60, 'DoC + technical file', 'EU DoC / FCC SDoC');
    doc(386, 60, 'User manual', 'safety, 15.105, disposal');
    if (c.radio !== 'none' && c.market !== 'fcc') doc(470, 60, 'RED test plan', 'EN 300 328, 301 489, 62311');
    // pre-scan bench
    A(sv('circle', { cx: 100, cy: 504, r: 22, class: 'cp-probe' }));
    A(sv('path', { d: 'M114 521 L170 596', class: 'cp-probe shaft' }));
    T(40, 548, 'Near-field', 'cp-t soft'); T(40, 562, 'probe', 'cp-t soft');
    T(40, 612, 'Pre-test bench', 'cp-t soft');
  }

  function pins(c) {
    gLead.replaceChildren(); gPins.replaceChildren();
    const items = liveItems();
    const sc = scroller.clientWidth ? Math.min(1, svg.getBoundingClientRect().width / 1000) : 1;
    const r = Math.max(12, 8.5 / (sc || 1));
    items.forEach((it, idx) => {
      const pos = PINS[it.key]; if (!pos) return;
      const [x, y] = pos.p, [ax, ay] = pos.a;
      const cls = it.done ? 'done' : it.critical ? 'crit' : 'open';
      const dim = state.hoverGroup && state.hoverGroup !== it.group;
      gLead.append(sv('line', { x1: x, y1: y, x2: ax, y2: ay, class: `cp-lead ${cls}${dim ? ' dim' : ''}` }), sv('circle', { cx: ax, cy: ay, r: 2.6, class: `cp-anchor ${cls}${dim ? ' dim' : ''}` }));
      const g = sv('g', { class: `cp-pin ${cls}${state.sel === it.key ? ' is-sel' : ''}${dim ? ' dim' : ''}`, transform: `translate(${x} ${y})`, tabindex: 0,
        role: 'checkbox', 'aria-checked': String(it.done), 'data-key': it.key,
        'aria-label': `${idx + 1}. ${it.name}${it.critical ? ', critical' : ''}: ${it.done ? 'done' : 'open'}` });
      g.append(sv('circle', { r: r + 5, class: 'sel' }), sv('circle', { r, class: 'core' }),
        sv('text', { y: r * 0.36, class: 'num', 'text-anchor': 'middle', 'font-size': r * 0.95 }, it.done ? '✓' : idx + 1),
        sv('title', {}, `${idx + 1}. ${it.name} (${it.group})${it.critical ? ' - critical' : ''}: ${it.done ? 'done' : 'open'}. Click to ${it.done ? 'reopen' : 'tick'}.`));
      gPins.append(g);
    });
    document.getElementById('cp-cfg').textContent = `${MK[c.market]} · ${{ battery: 'battery only', lowv: 'USB / adapter', mains: 'mains inside' }[c.power]} · ${{ none: 'no radio', module: 'radio module', discrete: 'own RF design' }[c.radio]}${c.battery && c.power !== 'battery' ? ' · Li cell' : ''}`;
  }
  gPins.addEventListener('click', (e) => { const g = e.target.closest('.cp-pin'); if (g) toggle(g.dataset.key); });
  gPins.addEventListener('focusin', (e) => {
    const g = e.target.closest('.cp-pin'); if (!g || state.sel === g.dataset.key) return;
    state.sel = g.dataset.key; drawDetail(); markSel();
  });
  gPins.addEventListener('keydown', (e) => {
    const g = e.target.closest('.cp-pin'); if (!g) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(g.dataset.key); return; }
    const items = liveItems(); const i = items.findIndex((it) => it.key === g.dataset.key);
    let j = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    if (j == null) return;
    e.preventDefault();
    gPins.querySelector(`.cp-pin[data-key="${items[j].key}"]`)?.focus();
  });
  const markSel = () => {
    for (const el of root.querySelectorAll('.cp-pin, .cp-row')) el.classList.toggle('is-sel', el.dataset.key === state.sel);
  };

  // ---------- side ----------
  function drawDetail() {
    const items = liveItems();
    const it = itemBy(state.sel);
    if (!it || !it.live) {
      detail.replaceChildren(h('div', { class: 'cp-head' }, h('h2', {}, 'Item')), h('div', { class: 'cp-empty' }, 'Click a pin on the product or a line in the list.'));
      return;
    }
    const n = items.findIndex((x) => x.key === it.key) + 1;
    detail.replaceChildren(
      h('div', { class: 'cp-head' }, h('span', { class: `cp-num ${it.done ? 'done' : it.critical ? 'crit' : 'open'}` }, n), h('h2', {}, it.name),
        h('span', { class: 'cp-grow' }), h('span', { class: 'cp-sub' }, it.group)),
      h('div', { class: 'cp-dbody' },
        h('p', { class: 'cp-item' }, it.item),
        h('p', { class: 'cp-why' }, h('b', {}, 'Why: '), it.why),
        h('div', { class: 'cp-tags' },
          h('span', { class: 'cp-tag' }, `for ${MK[it.market]}`),
          it.critical ? h('span', { class: 'cp-tag bad' }, 'critical: likely fail or respin') : null,
          h('span', { class: 'cp-grow' }),
          h('button', { type: 'button', class: `k-btn${it.done ? '' : ' k-primary'}`, onclick: () => toggle(it.key) }, it.done ? 'Reopen' : 'Mark done'))));
  }
  function drawList() {
    const c = ck(); list.replaceChildren(); if (!c) return;
    const items = liveItems();
    const num = new Map(items.map((it, i) => [it.key, i + 1]));
    for (const g of c.groups) {
      const all = c.items.filter((it) => it.group === g.group);
      const live = all.filter((it) => it.live).sort((a, b) => (a.done - b.done) || (b.critical - a.critical) || (num.get(a.key) - num.get(b.key)));
      const na = all.length - live.length;
      const pct = g.total ? (100 * g.done) / g.total : 0;
      const box = h('div', { class: 'cp-grp', onpointerenter: () => { state.hoverGroup = g.group; pins(c); markSel(); }, onpointerleave: () => { state.hoverGroup = null; pins(c); markSel(); } },
        h('div', { class: 'cp-gh' }, h('b', {}, g.group),
          g.criticalOpen ? h('span', { class: 'cp-crit' }, `${g.criticalOpen} critical`) : null,
          h('span', { class: 'cp-grow' }),
          h('span', { class: 'cp-gc' }, g.total ? `${g.done} / ${g.total}` : 'n/a'),
          h('span', { class: 'cp-gbar' }, h('i', { style: `width:${pct}%` }))));
      for (const it of live) {
        const cb = h('input', { type: 'checkbox', 'aria-label': it.name, onchange: () => toggle(it.key) });
        cb.checked = it.done;
        box.append(h('div', { class: `cp-row ${it.done ? 'done' : it.critical ? 'crit' : 'open'}${state.sel === it.key ? ' is-sel' : ''}`, 'data-key': it.key },
          cb, h('span', { class: 'cp-num' }, num.get(it.key)),
          h('button', { type: 'button', class: 'cp-rn', title: it.item, onclick: () => { select(it.key); gPins.querySelector(`.cp-pin[data-key="${it.key}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } }, it.name)));
      }
      if (na) box.append(h('div', { class: 'cp-na' }, `${na} not applicable here`));
      list.append(box);
    }
  }

  // ---------- top ----------
  function drawTop() {
    const c = ck() || { market: ctx.raw.market, power: ctx.raw.power, radio: ctx.raw.radio };
    const seg = (el, key, opts, icons) => el.replaceChildren(...opts.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String((ctx.raw[key] ?? c[key]) === v), title: t,
      onclick: () => ctx.set(key, v) }, icons ? h('span', { class: 'ico' }) : null, t)));
    seg(mkSeg, 'market', [['both', 'CE + FCC'], ['ce', 'CE'], ['fcc', 'FCC']]);
    seg(pwSeg, 'power', [['battery', 'Battery'], ['lowv', 'USB / adapter'], ['mains', 'Mains']], true);
    seg(rfSeg, 'radio', [['none', 'None'], ['module', 'Module'], ['discrete', 'Own RF']], true);
    pwSeg.querySelectorAll('.ico').forEach((e, i) => { e.innerHTML = ICON[['battery', 'lowv', 'mains'][i]]; });
    rfSeg.querySelectorAll('.ico').forEach((e, i) => { e.innerHTML = ICON[['none', 'module', 'discrete'][i]]; });
    liBtn.setAttribute('aria-pressed', String(!!ctx.raw.battery));
    liBtn.replaceChildren(h('span', { class: 'ico' }), 'Li cell');
    liBtn.querySelector('.ico').innerHTML = ICON.battery;
    const vals = ctx.result?.values || [];
    stats.replaceChildren(...vals.map((v) => h('div', { class: `cp-stat${v.tone ? ` ${v.tone}` : ''}`, title: v.hint || null },
      h('span', {}, v.label), h('b', {}, String(v.value)))));
    // gauge: one segment per group with items, filled by its done share
    const gs = (ck()?.groups || []).filter((g) => g.total);
    gauge.replaceChildren(...gs.map((g) => h('span', { class: `cp-gs${g.criticalOpen ? ' crit' : g.done === g.total ? ' full' : ''}`, style: `flex:${g.total}`, title: `${g.group}: ${g.done} / ${g.total}` },
      h('i', { style: `width:${(100 * g.done) / g.total}%` }), h('em', {}, GROUP_SHORT[g.group] || g.group))));
  }

  function drawRegs(res) {
    const t = (res.tables || []).find((x) => x.title === 'Rules in scope');
    regs.replaceChildren(h('div', { class: 'cp-head' }, h('h2', {}, 'Rules in scope')),
      h('ul', { class: 'cp-rl' }, (t?.rows || []).map((r) => h('li', {}, r[0]))));
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res.warnings || []).length;
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
  }

  function render() {
    const res = ctx.result || {}; const c = ck(); if (!c) return;
    if (state.sel && !itemBy(state.sel)?.live) state.sel = null;
    if (!state.sel) state.sel = liveItems().find((it) => !it.done && it.critical)?.key || liveItems()[0]?.key || null;
    const act = document.activeElement;
    const refocus = state.refocus || (act?.closest?.('.cp-pin') ? act.dataset.key : null);
    const refocusRow = !state.refocus && act?.closest?.('.cp-row') ? act.closest('.cp-row').dataset.key : null;
    const rowWasCb = act?.type === 'checkbox';
    state.refocus = null;
    drawTop(); art(c); pins(c); drawDetail(); drawList(); drawRegs(res);
    if (refocus && !refocusRow && act?.closest?.('.cp-pin')) gPins.querySelector(`.cp-pin[data-key="${refocus}"]`)?.focus({ preventScroll: true });
    else if (refocusRow) list.querySelector(`.cp-row[data-key="${refocusRow}"] ${rowWasCb ? 'input' : '.cp-rn'}`)?.focus({ preventScroll: true });
    else if (refocus && act?.closest?.('.cp-pin')) gPins.querySelector(`.cp-pin[data-key="${refocus}"]`)?.focus({ preventScroll: true });
  }
  let lastW = 0;
  new ResizeObserver(() => {
    const w = scroller.clientWidth;
    if (Math.abs(w - lastW) > 20 && ck()) { lastW = w; requestAnimationFrame(() => { pins(ck()); markSel(); }); }
  }).observe(scroller);
  ctx.onResult(() => render());
}
