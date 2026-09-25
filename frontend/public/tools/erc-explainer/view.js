// ERC Rule Explainer, drawn as the schematic the error sits on: for each rule
// a small sheet with the faulty wiring and KiCad's red marker on the spot,
// and the same sheet fixed. The atlas on the left is every rule as its own
// thumbnail, grouped by what it checks; paste the ERC line from your tool
// into the bar on top and the matching sheet opens. The words (message,
// meaning, causes, fix, when to waive) come from run(); the pictures are the
// page's own illustrations of that rule.

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

const GROUPS = [
  ['Pins and drivers', ['pin_not_connected', 'pin_not_driven', 'power_pin_not_driven', 'pin_to_pin', 'no_connect_connected', 'no_connect_dangling']],
  ['Labels and net names', ['label_dangling', 'isolated_pin_label', 'single_global_label', 'similar_labels', 'multiple_net_names']],
  ['Wires and grid', ['wire_dangling', 'endpoint_off_grid', 'four_way_junction']],
  ['Buses and hierarchy', ['bus_to_net_conflict', 'net_not_bus_member', 'hier_label_mismatch']],
  ['Annotation and units', ['duplicate_reference', 'unannotated', 'missing_unit', 'missing_power_pin', 'different_unit_footprint']],
  ['Libraries and text', ['lib_symbol_issues', 'footprint_link_issues', 'unresolved_variable']],
];

// ---------- a tiny schematic kit, in grid units (1 = 50 mil) ----------
function kit(g) {
  const add = (el) => { g.append(el); return el; };
  const pl = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('');
  const d = {
    wire: (...pts) => add(s('path', { d: pl(pts), class: 'sw' })),
    bus: (...pts) => add(s('path', { d: pl(pts), class: 'sb' })),
    entry: (x, y, dx = 1, dy = -1) => add(s('path', { d: `M${x},${y}l${dx},${dy}`, class: 'sb thin' })),
    dot: (x, y) => add(s('circle', { cx: x, cy: y, r: 0.32, class: 'sj' })),
    text: (x, y, t, cls = '', anchor = 'start', size = 0.8) => add(s('text', { x, y, 'text-anchor': anchor, 'font-size': size, class: `st ${cls}` }, t)),
    ref: (x, y, t, anchor = 'start') => d.text(x, y, t, 'sref', anchor, 0.75),
    // a box symbol; pins: [side, offset, name, type]; returns pin ends by name
    ic: (x, y, w, hgt, ref, val, pins) => {
      add(s('rect', { x, y, width: w, height: hgt, class: 'sbody' }));
      if (ref) d.ref(x, y - 0.5, ref);
      if (val) d.text(x, y + hgt + 1.1, val, 'sval', 'start', 0.7);
      const ends = {};
      for (const [side, o, name, type] of pins) {
        let b, e;
        if (side === 'L') { b = [x, y + o]; e = [x - 2, y + o]; }
        if (side === 'R') { b = [x + w, y + o]; e = [x + w + 2, y + o]; }
        if (side === 'T') { b = [x + o, y]; e = [x + o, y - 2]; }
        if (side === 'B') { b = [x + o, y + hgt]; e = [x + o, y + hgt + 2]; }
        add(s('path', { d: pl([b, e]), class: 'spin' }));
        const gp = type === 'in' || type === 'out' || type === 'oc' ? 0.7 : 0;
        if (name) {
          if (side === 'L') d.text(x + 0.4 + gp, y + o + 0.28, name, 'spn', 'start', 0.62);
          if (side === 'R') d.text(x + w - 0.4 - gp, y + o + 0.28, name, 'spn', 'end', 0.62);
          if (side === 'T') d.text(x + o, y + 0.9, name, 'spn', 'middle', 0.62);
          if (side === 'B') d.text(x + o, y + hgt - 0.4, name, 'spn', 'middle', 0.62);
        }
        if (type === 'in' || type === 'out' || type === 'oc') {
          const dir = side === 'L' ? 1 : side === 'R' ? -1 : 0;
          const [bx, by] = b;
          if (dir && type === 'in') add(s('path', { d: `M${bx - dir * 0.05},${by - 0.3}l${dir * 0.45},0.3l${-dir * 0.45},0.3`, class: 'spin fillnone' }));
          if (dir && type === 'out') add(s('path', { d: `M${bx + dir * 0.5},${by - 0.3}l${-dir * 0.45},0.3l${dir * 0.45},0.3`, class: 'spin fillnone' }));
          if (dir && type === 'oc') add(s('path', { d: `M${bx - dir * 0.9},${by}l${dir * 0.3},-0.3l${dir * 0.3},0.3l${-dir * 0.3},0.3z`, class: 'spin fillnone' }));
        }
        ends[name || `${side}${o}`] = e;
      }
      return ends;
    },
    res: (x, y, ref, val, horiz = false) => { // from (x,y), 4 units long
      if (horiz) { add(s('path', { d: `M${x},${y}h1M${x + 3},${y}h1`, class: 'spin' })); add(s('rect', { x: x + 1, y: y - 0.4, width: 2, height: 0.8, class: 'sbody' })); if (ref) d.ref(x + 2, y - 0.8, ref, 'middle'); if (val) d.text(x + 2, y + 1.5, val, 'sval', 'middle', 0.65); return [[x, y], [x + 4, y]]; }
      add(s('path', { d: `M${x},${y}v1M${x},${y + 3}v1`, class: 'spin' })); add(s('rect', { x: x - 0.4, y: y + 1, width: 0.8, height: 2, class: 'sbody' }));
      if (ref) d.ref(x + 0.9, y + 1.9, ref); if (val) d.text(x + 0.9, y + 2.8, val, 'sval', 'start', 0.65);
      return [[x, y], [x, y + 4]];
    },
    cap: (x, y, ref, val) => {
      add(s('path', { d: `M${x},${y}v1.7M${x - 0.8},${y + 1.7}h1.6M${x - 0.8},${y + 2.3}h1.6M${x},${y + 2.3}v1.7`, class: 'spin' }));
      if (ref) d.ref(x + 1.1, y + 1.8, ref); if (val) d.text(x + 1.1, y + 2.7, val, 'sval', 'start', 0.65);
      return [[x, y], [x, y + 4]];
    },
    pwr: (x, y, name, side) => { add(s('path', { d: `M${x},${y}v-1M${x - 0.5},${y - 0.6}l0.5,-0.6l0.5,0.6`, class: 'spwr fillnone' }));
      if (side === 'R') d.text(x + 0.8, y - 1, name, 'spwrt', 'start', 0.65); else d.text(x, y - 1.6, name, 'spwrt', 'middle', 0.65); },
    gnd: (x, y) => add(s('path', { d: `M${x},${y}v0.8M${x - 0.7},${y + 0.8}h1.4l-0.7,0.7z`, class: 'spwr fillnone' })),
    flag: (x, y) => { add(s('path', { d: `M${x},${y}v-1M${x},${y - 1}l-0.5,-0.5l0.5,-0.5l0.5,0.5z`, class: 'spwr fillnone' })); d.text(x, y - 2.4, 'PWR_FLAG', 'spwrt', 'middle', 0.6); },
    nc: (x, y) => add(s('path', { d: `M${x - 0.45},${y - 0.45}l0.9,0.9M${x - 0.45},${y + 0.45}l0.9,-0.9`, class: 'snc' })),
    label: (x, y, t) => { d.text(x + 0.2, y - 0.25, t, 'slab', 'start', 0.75); add(s('rect', { x: x - 0.12, y: y - 0.12, width: 0.24, height: 0.24, class: 'sanch' })); },
    glob: (x, y, t, dir = 'R') => { // dir: which side the flag points to
      const w = t.length * 0.5 + 0.9, s1 = dir === 'R' ? 1 : -1;
      add(s('path', { d: `M${x},${y}l${s1 * 0.5},-0.5h${s1 * (w - 0.5)}v1h${-s1 * (w - 0.5)}z`, class: 'sglob' }));
      d.text(x + s1 * (w / 2 + 0.25), y + 0.27, t, 'slab', 'middle', 0.65);
    },
    hier: (x, y, t, dir = 'R') => {
      const s1 = dir === 'R' ? 1 : -1;
      add(s('path', { d: `M${x},${y}l${s1 * 0.5},-0.5h${s1 * 0.5}v1h${-s1 * 0.5}z`, class: 'shier' }));
      d.text(x + s1 * 1.3, y + 0.27, t, 'shiert', dir === 'R' ? 'start' : 'end', 0.65);
    },
    opamp: (x, y, ref, val) => { // + at (x,y+1), − at (x,y+3) after 1-unit stubs; out at (x+6,y+2)
      add(s('path', { d: `M${x + 1},${y - 0.5}v5l4,-2.5z`, class: 'sbody' }));
      add(s('path', { d: `M${x},${y + 1}h1M${x},${y + 3}h1M${x + 5},${y + 2}h1`, class: 'spin' }));
      d.text(x + 1.3, y + 1.3, '+', 'spn', 'start', 0.7); d.text(x + 1.3, y + 3.3, '−', 'spn', 'start', 0.7);
      if (ref) d.ref(x + 2, y - 1, ref); if (val) d.text(x + 2, y + 5.4, val, 'sval', 'start', 0.65);
      return { p: [x, y + 1], n: [x, y + 3], o: [x + 6, y + 2] };
    },
    ghost: (x, y, w, hgt, t) => { add(s('rect', { x, y, width: w, height: hgt, class: 'sghost' })); d.text(x + w / 2, y + hgt / 2 + 0.3, t, 'sghostt', 'middle', 0.7); },
    frame: (x, y, w, hgt, t) => { add(s('rect', { x, y, width: w, height: hgt, class: 'sframe' })); d.text(x + 0.4, y + 0.9, t, 'sframet', 'start', 0.62); },
    sheet: (x, y, w, hgt, name, pins) => {
      add(s('rect', { x, y, width: w, height: hgt, class: 'ssheet' }));
      d.text(x, y - 0.4, name, 'ssheett', 'start', 0.7);
      const ends = {};
      for (const [o, t] of pins) { add(s('path', { d: `M${x + w},${y + o}l-0.5,-0.4h-0.5v0.8h0.5z`, class: 'shier' })); d.text(x + w - 1.3, y + o + 0.27, t, 'shiert', 'end', 0.62); ends[t] = [x + w, y + o]; }
      return ends;
    },
    field: (x, y, t, cls = 'sfield') => d.text(x, y, t, cls, 'start', 0.6),
  };
  return d;
}

// A standard MCU on the left of many sheets: VDD/VSS wired, five port pins on the right.
function mcu(d, names = ['PA0', 'PA1', 'PA2', 'PA3', 'PA4']) {
  const e = d.ic(6, 3, 8, 12, 'U1', 'STM32G0', [['L', 2, 'VDD', 'pwr'], ['L', 10, 'VSS', 'pwr'],
    ...names.map((n, i) => ['R', 2 + 2 * i, n, 'io'])]);
  d.wire(e.VDD, [2, 5], [2, 4]); d.pwr(2, 4, '+3V3');
  d.wire(e.VSS, [2, 13], [2, 15]); d.gnd(2, 15);
  return e;
}

// Each rule: a sheet with the fault (fixed = false) or corrected (fixed = true).
// Returns { spot: [x, y] } - where KiCad puts its marker - and { fix: text } for the corrected one.
const SCENES = {
  pin_not_connected: (d, fx) => {
    const e = mcu(d);
    d.wire(e.PA0, [24, 5]); d.label(21, 5, 'LED');
    d.wire(e.PA1, [24, 7]); d.label(21, 7, 'BTN');
    d.wire(e.PA2, [24, 9]); d.label(21, 9, 'TX');
    d.wire(e.PA4, [24, 13]); d.label(21, 13, 'RX');
    if (fx) d.nc(...e.PA3);
    return { spot: e.PA3, fix: 'Unused on purpose: a no-connect flag on the pin end' };
  },
  pin_not_driven: (d, fx) => {
    const j = d.ic(3, 5, 4, 5, 'J1', 'Conn_01x02', [['R', 2, '1', 'in'], ['R', 4, '2', 'pwr']]);
    d.wire(j['2'], [11, 9], [11, 11]); d.gnd(11, 11);
    const u = d.ic(26, 4, 8, 9, 'U2', 'TPS62130', [['L', 3, 'EN', 'in'], ['L', 7, 'GND', 'pwr']]);
    d.wire(j['1'], u.EN); d.wire(u.GND, [22, 11], [22, 13]); d.gnd(22, 13);
    if (fx) { d.res(17, 3, 'R3', '100k'); d.pwr(17, 3, '+3V3'); d.dot(17, 7); }
    return { spot: u.EN, fix: 'A pull-up gives the input a defined level' };
  },
  power_pin_not_driven: (d, fx) => {
    const j = d.ic(3, 5, 4, 5, 'J1', 'Barrel_Jack', [['R', 1.5, '+', 'pwr'], ['R', 3.5, '−', 'pwr']]);
    const u = d.ic(26, 8, 8, 7, 'U1', 'MCU', [['T', 3, 'VCC', 'pin'], ['B', 3, 'GND', 'pin']]);
    d.wire(j['+'], [29, 6.5], u.VCC); d.wire(j['−'], [11, 8.5], [11, 11]); d.gnd(11, 11); d.gnd(...u.GND);
    d.pwr(19, 6.5, '+12V'); d.dot(19, 6.5);
    if (fx) { d.flag(14, 6.5); d.dot(14, 6.5); }
    return { spot: u.VCC, fix: 'PWR_FLAG where the power enters the board' };
  },
  pin_to_pin: (d, fx) => {
    const a = d.ic(3, 2, 7, 6, 'U1', '74LVC1G04', [['R', 3, 'Y', fx ? 'oc' : 'out']]);
    const b = d.ic(3, 12, 7, 6, 'U2', '74LVC1G04', [['R', 3, 'Y', fx ? 'oc' : 'out']]);
    const c = d.ic(28, 6, 7, 6, 'U3', 'MCU', [['L', 3, 'IRQ', 'in']]);
    d.wire(a.Y, [18, 5], [18, 15], b.Y); d.wire([18, 9], c.IRQ); d.dot(18, 9);
    if (fx) { d.res(22, 3, 'R4', '4k7'); d.pwr(22, 3, '+3V3'); d.wire([22, 7], [22, 9]); d.dot(22, 9); d.text(12.2, 4.3, 'open drain', 'snote', 'start', 0.6); d.text(12.2, 14.3, 'open drain', 'snote', 'start', 0.6); }
    return { spot: [18, 9], fix: 'Open-drain outputs and one pull-up: they can no longer fight' };
  },
  no_connect_connected: (d, fx) => {
    const e = mcu(d);
    d.wire(e.PA0, [24, 5]); d.label(21, 5, 'LED');
    d.wire(e.PA3, [24, 11]); d.label(21, 11, 'SPARE');
    if (!fx) d.nc(...e.PA3);
    return { spot: e.PA3, fix: 'The pin is used, so the flag goes' };
  },
  no_connect_dangling: (d, fx) => {
    const e = mcu(d);
    d.wire(e.PA0, [24, 5]); d.label(21, 5, 'LED');
    if (fx) d.nc(...e.PA3); else d.nc(e.PA3[0] + 1.5, e.PA3[1] + 1);
    return { spot: fx ? e.PA3 : [e.PA3[0] + 1.5, e.PA3[1] + 1], fix: 'The flag sits exactly on the pin end' };
  },
  label_dangling: (d, fx) => {
    const e = mcu(d);
    d.wire(e.PA0, [30, 5]); const r = d.res(30, 5, 'R1', '4k7'); d.pwr(30, 5, '+3V3'); d.dot(30, 5);
    if (fx) d.label(21, 5, 'SDA'); else d.label(21, 3.6, 'SDA');
    void r;
    return { dir: 'ul', spot: fx ? [21, 5] : [21, 3.6], fix: 'The label\'s anchor is on the wire' };
  },
  isolated_pin_label: (d, fx) => {
    const e = mcu(d);
    d.wire(e.PA4, [22, 13]); d.label(18, 13, 'RESET');
    const u = d.ic(30, 4, 7, 6, 'U2', 'ESP32', [['L', 3, 'EN', 'in']]);
    d.wire([24, 7], u.EN); d.label(24, 7, fx ? 'RESET' : 'RST');
    return { dir: 'ul', spot: [18, 13], fix: 'Both ends carry the same name, case included' };
  },
  single_global_label: (d, fx) => {
    d.frame(0.5, 0.5, 18.5, 19, 'mcu.kicad_sch'); d.frame(21, 0.5, 18.5, 19, 'radio.kicad_sch');
    const a = d.ic(3, 5, 6, 8, 'U1', 'MCU', [['R', 3, 'TX', 'out']]);
    d.wire(a.TX, [14, 8]); d.glob(14, 8, 'UART_TX', 'R');
    const b = d.ic(31, 5, 6, 8, 'U4', 'Radio', [['L', 3, 'RXD', 'in']]);
    d.wire([25, 8], b.RXD); d.glob(25, 8, fx ? 'UART_TX' : 'UART_TXD', 'L');
    return { dir: 'ul', spot: [14, 8], fix: 'The global label has its partner on the other sheet' };
  },
  similar_labels: (d, fx) => {
    const e = mcu(d, ['PB6', 'PB7', 'PA2', 'PA3', 'PA4']);
    d.wire(e.PB6, [22, 5]); d.label(18, 5, 'SCL'); d.wire(e.PB7, [22, 7]); d.label(18, 7, 'SDA');
    const u = d.ic(30, 9, 7, 7, 'U5', 'BME280', [['L', 2, 'SCK', 'in'], ['L', 4, 'SDI', 'bi']]);
    d.wire([24, 11], u.SCK); d.label(24, 11, 'SCL'); d.wire([24, 13], u.SDI); d.label(24, 13, fx ? 'SDA' : 'Sda');
    return { dir: 'ul', spot: [24, 13], fix: 'One spelling for one net' };
  },
  multiple_net_names: (d, fx) => {
    const j = d.ic(3, 5, 4, 5, 'J1', 'USB_C', [['R', 2, 'VBUS', 'pwr'], ['R', 4, 'GND', 'pwr']]);
    const u = d.ic(28, 4, 8, 8, 'U2', 'BQ24075', [['L', 3, 'IN', 'pwr']]);
    d.wire(j.VBUS, u.IN); d.wire(j.GND, [11, 9], [11, 11]); d.gnd(11, 11);
    d.label(12, 7, 'VBUS'); if (!fx) d.label(20, 7, '+5V_USB');
    return { dir: 'ul', spot: fx ? [12, 7] : [20, 7], fix: 'One name on the net (a net tie if two must meet)' };
  },
  wire_dangling: (d, fx) => {
    const e = mcu(d);
    d.wire(e.PA0, [26, 5]); d.res(26, 5, 'R1', '330'); d.dot(26, 5); d.wire([26, 5], [26, 3]); d.pwr(26, 3, '+3V3');
    d.wire(e.PA2, [22, 9]); d.label(18, 9, 'TX');
    if (!fx) { d.wire([22, 9], [22, 12], [24, 12]); d.dot(22, 9); }
    return { spot: [24, 12], fix: 'The stub is deleted' };
  },
  endpoint_off_grid: (d, fx) => {
    for (let x = 16; x <= 32; x += 1) for (let y = 2; y <= 16; y += 1) d.dot(x, y).setAttribute('class', 'sgrid');
    const e = mcu(d);
    const rx = fx ? 24 : 24.5;
    d.wire(e.PA0, [24, 5]); d.res(rx, 5, 'R1', '10k'); d.wire([rx, 9], [rx, 11]); d.gnd(rx, 11);
    return { spot: [24.5, 5], fix: 'Symbol back on the 50 mil grid: pin and wire meet' };
  },
  four_way_junction: (d, fx) => {
    const e = mcu(d);
    d.res(22, 1, 'R1', '10k'); d.pwr(22, 1, '+3V3', 'R');
    d.res(22, 11, 'R2', '10k'); d.gnd(22, 15);
    if (fx) { d.cap(30, 6, 'C1', '100n'); d.gnd(30, 10); d.wire(e.PA0, [22, 5]); d.wire([22, 5], [22, 11]); d.wire([22, 6], [30, 6]); d.dot(22, 5); d.dot(22, 6); }
    else { d.cap(30, 5, 'C1', '100n'); d.gnd(30, 9); d.wire(e.PA0, [30, 5]); d.wire([22, 5], [22, 11]); d.dot(22, 5); }
    return { spot: [22, 5], fix: 'Two T-junctions a grid step apart: nothing to guess' };
  },
  bus_to_net_conflict: (d, fx) => {
    const e = mcu(d, ['D0', 'D1', 'D2', 'D3', 'D4']);
    d.bus([28, 2], [28, 18]); d.text(28.6, 2.5, 'D[0..7]', 'sbust', 'start', 0.7);
    for (const [k, n] of [['D0', 5], ['D1', 7], ['D2', 9], ['D4', 13]]) { d.wire(e[k], [27, n]); d.entry(27, n, 1, -1); d.label(21, n, k); }
    if (fx) { d.wire(e.D3, [27, 11]); d.entry(27, 11, 1, -1); d.label(21, 11, 'D3'); } else d.wire(e.D3, [28, 11]);
    return { spot: [28, 11], fix: 'A bus entry and a label that names a member' };
  },
  net_not_bus_member: (d, fx) => {
    const e = mcu(d, ['D4', 'D5', 'D6', 'D7', 'D8']);
    d.bus([28, 2], [28, 18]); d.text(28.6, 2.5, fx ? 'D[0..8]' : 'D[0..7]', 'sbust', 'start', 0.7);
    for (const [k, n] of [['D4', 5], ['D5', 7], ['D6', 9], ['D7', 11], ['D8', 13]]) { d.wire(e[k], [27, n]); d.entry(27, n, 1, -1); d.label(21, n, k); }
    return { dir: 'ul', spot: [21, 13], fix: 'The bus is widened to D[0..8] (or rename the label)' };
  },
  hier_label_mismatch: (d, fx) => {
    const p = d.sheet(3, 4, 9, 10, 'Sheet: sensor', [[2, 'SCL'], [4, 'SDA'], [6, fx ? 'IRQ' : 'INT']]);
    d.wire(p.SCL, [16, 6]); d.wire(p.SDA, [16, 8]); d.wire(p[fx ? 'IRQ' : 'INT'], [16, 10]);
    d.frame(20, 1, 19, 17, 'inside sensor.kicad_sch');
    const u = d.ic(31, 5, 6, 9, 'U7', 'LIS3DH', [['L', 2, 'SCL', 'in'], ['L', 4, 'SDA', 'bi'], ['L', 6, 'INT1', 'out']]);
    for (const [n, y, pin] of [['SCL', 7, 'SCL'], ['SDA', 9, 'SDA'], ['IRQ', 11, 'INT1']]) { d.wire([24, y], u[pin]); d.hier(24, y, n, 'L'); }
    return { spot: [12, 10], fix: 'Sheet pin and hierarchical label share the name' };
  },
  duplicate_reference: (d, fx) => {
    const e = mcu(d);
    d.wire(e.PA0, [22, 5]); d.res(22, 5, 'R5', '330'); d.gnd(22, 9);
    d.wire(e.PA2, [30, 9]); d.res(30, 9, fx ? 'R6' : 'R5', '330'); d.gnd(30, 13);
    return { dir: 'ul', spot: [30.9, 10.9], fix: 'Only the new part re-annotated: R6' };
  },
  unannotated: (d, fx) => {
    const e = mcu(d);
    d.wire(e.PA0, [22, 5]); d.res(22, 5, fx ? 'R1' : 'R?', '10k'); d.gnd(22, 9);
    d.wire(e.PA2, [30, 9]); d.cap(30, 9, fx ? 'C1' : 'C?', '100n'); d.gnd(30, 13);
    return { dir: 'ul', spot: [22.9, 6.9], fix: 'Annotated: every part has a number' };
  },
  missing_unit: (d, fx) => {
    const a = d.opamp(6, 4, 'U3A', 'LM358'); d.wire([2, 5], a.p); d.label(2, 5, 'VIN'); d.wire(a.o, [16, 6]); d.label(13, 6, 'VOUT');
    d.wire(a.n, [5, 7], [5, 10], [14, 10], [14, 6]); d.dot(14, 6);
    if (fx) {
      const b = d.opamp(24, 8, 'U3B', 'LM358'); d.wire(b.o, [32, 10], [32, 14], [23, 14], [23, 11], b.n);
      d.wire([18, 9], b.p); d.label(18, 9, 'VMID');
    } else d.ghost(23, 7, 10, 7, 'U3B not placed');
    return { spot: fx ? [28, 10] : [33, 7], fix: 'Spare unit placed as a follower on a mid-rail' };
  },
  missing_power_pin: (d, fx) => {
    const a = d.opamp(6, 4, 'U4A', 'LM358'); d.wire([2, 5], a.p); d.label(2, 5, 'VIN'); d.wire(a.o, [16, 6]); d.label(13, 6, 'VOUT');
    d.wire(a.n, [5, 7], [5, 10], [14, 10], [14, 6]); d.dot(14, 6);
    if (fx) {
      const u = d.ic(26, 7, 6, 6, 'U4C', 'LM358', [['T', 3, 'V+', 'pwr'], ['B', 3, 'V−', 'pwr']]);
      d.pwr(...u['V+']); d.gnd(...u['V−']);
    } else d.ghost(25, 5, 9, 10, 'U4C (V+, V−) not placed');
    return { spot: fx ? [29, 10] : [34, 5], fix: 'Power unit placed and wired' };
  },
  different_unit_footprint: (d, fx) => {
    d.opamp(4, 4, 'U3A', 'LM358'); d.field(4, 12, 'Footprint: Package_SO:SOIC-8');
    d.opamp(24, 4, 'U3B', 'LM358'); d.field(24, 12, `Footprint: Package_SO:${fx ? 'SOIC-8' : 'TSSOP-8'}`, fx ? 'sfield' : 'sfield bad');
    return { dir: 'ul', spot: [24, 11.8], fix: 'Every unit of U3 on the same footprint' };
  },
  lib_symbol_issues: (d, fx) => {
    const u = d.ic(12, 5, 10, 8, 'U5', 'LM1117-3.3', [['L', 2, 'VI', 'pwr'], ['R', 2, 'VO', 'pwr'], ['B', 5, 'GND', 'pwr']]);
    d.wire([6, 7], u.VI); d.pwr(6, 7, '+5V'); d.wire(u.VO, [28, 7]); d.pwr(28, 7, '+3V3'); d.gnd(...u.GND);
    d.field(12, 16.8, `Symbol: ${fx ? 'Regulator_Linear:LM1117-3.3' : 'MyParts:LM1117 (not in any library)'}`, fx ? 'sfield' : 'sfield bad');
    return { dir: 'ul', spot: [12, 16.6], fix: 'Linked to a library that is in the table' };
  },
  footprint_link_issues: (d, fx) => {
    const e = mcu(d);
    d.wire(e.PA0, [22, 5]); d.res(22, 5, 'R1', '330'); d.gnd(22, 9);
    d.field(16, 17, `Footprint: Resistor_SMD:${fx ? 'R_0603_1608Metric' : 'R_0603_1608Metrc'}`, fx ? 'sfield' : 'sfield bad');
    return { dir: 'ul', spot: [16, 16.8], fix: 'The field names a footprint that exists' };
  },
  unresolved_variable: (d, fx) => {
    const e = mcu(d); d.wire(e.PA0, [22, 5]); d.label(18, 5, 'LED');
    d.frame(22, 12, 17, 7, 'Title block');
    d.text(22.6, 14.6, 'Sensor board', 'st', 'start', 0.75);
    d.text(22.6, 16.2, `Rev: ${fx ? 'B' : '${REVISON}'}`, fx ? 'st' : 'st sbadt', 'start', 0.75);
    d.text(22.6, 17.8, 'Date: 2026-09-25', 'st', 'start', 0.65);
    return { dir: 'ul', spot: [22.6, 16], fix: 'Variable defined (and spelled right) in the project' };
  },
};

const CSS = `
.erc { --tool-wire: #0a7a2f; --tool-sym: #8a1f1f; --tool-body: #fbf6dc; --tool-bus: #2140c9; --tool-lab: #16202a;
  --tool-pwr: #8a1f1f; --tool-hier: #7a3aa3; --tool-sheet: #7a3aa3; --tool-canvas: #fbfcfd; --tool-grid: #c8d2db;
  display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 10px; min-width: 0; align-items: start; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .erc {
  --tool-wire: #4cc46a; --tool-sym: #e0806c; --tool-body: #2a2618; --tool-bus: #7f9bff; --tool-lab: #e4ebf1;
  --tool-pwr: #e0806c; --tool-hier: #c58fe6; --tool-sheet: #c58fe6; --tool-canvas: #0d1318; --tool-grid: #2b3945; } }
:root[data-theme="dark"] .erc { --tool-wire: #4cc46a; --tool-sym: #e0806c; --tool-body: #2a2618; --tool-bus: #7f9bff; --tool-lab: #e4ebf1;
  --tool-pwr: #e0806c; --tool-hier: #c58fe6; --tool-sheet: #c58fe6; --tool-canvas: #0d1318; --tool-grid: #2b3945; }
@media (max-width: 900px) { .erc { grid-template-columns: minmax(0, 1fr); } }
.erc-atlas { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; display: flex; flex-direction: column;
  max-height: calc(100vh - 80px); position: sticky; top: 8px; }
.erc-atlas-head { padding: 7px 10px; border-bottom: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 5px; }
.erc-atlas-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.erc-atlas-head input { width: 100%; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink);
  font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.erc-list { overflow-y: auto; padding: 4px 6px 8px; scrollbar-width: thin; }
.erc-grp { font-size: 10.5px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .04em; padding: 8px 4px 3px; }
.erc-item { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 8px; align-items: center; width: 100%; text-align: left; padding: 3px 5px 3px 4px;
  border: 1px solid transparent; border-left: 3px solid var(--line); border-radius: 4px; background: transparent; cursor: pointer; color: var(--ink); }
.erc-item + .erc-item { margin-top: 2px; }
.erc-item:hover { background: var(--sunken); }
.erc-item[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 10%, var(--surface)); border-color: var(--accent); border-left-color: var(--accent); }
.erc-item.r-high { border-left-color: var(--danger); } .erc-item.r-medium { border-left-color: var(--warn); } .erc-item.r-low { border-left-color: var(--ok); }
.erc-item svg { width: 68px; height: 34px; display: block; border-radius: 2px; background: var(--tool-canvas); }
.erc-item b { display: block; font: 500 11px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.erc-item span { display: block; font-size: 11px; color: var(--ink-soft); line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.erc-none { padding: 10px; font-size: 12px; color: var(--ink-soft); }
@media (max-width: 900px) {
  .erc-atlas { position: static; max-height: none; }
  .erc-list { display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; padding: 6px; }
  .erc-grp { display: none; }
  .erc-item { flex: none; width: 150px; grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .erc-item svg { width: 100%; height: 60px; }
  .erc-item + .erc-item { margin-top: 0; }
}
.erc-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.erc-cmd { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; flex-wrap: wrap; }
.erc-cmd label { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.erc-cmd input { flex: 1; min-width: 180px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink);
  font: 13px "IBM Plex Mono", ui-monospace, monospace; }
.erc-cmd .st { font-size: 11.5px; color: var(--ink-soft); }
.erc-cmd .st.ok { color: var(--ok); } .erc-cmd .st.bad { color: var(--warn); }
.erc-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.erc-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.erc-head h2 { margin: 0; font: 600 13px "IBM Plex Mono", ui-monospace, monospace; }
.erc-head .alt { font-size: 11.5px; color: var(--ink-soft); }
.erc-head .right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.erc-risk { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 3px; border: 1px solid; }
.erc-risk.high { color: var(--danger); } .erc-risk.medium { color: var(--warn); } .erc-risk.low { color: var(--ok); }
.erc-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.erc-seg button { border: 0; background: var(--surface); white-space: nowrap; padding: 3px 11px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.erc-seg button + button { border-left: 1px solid var(--line); }
.erc-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.erc-seg button.b[aria-pressed="true"] { box-shadow: inset 0 -2px 0 var(--danger); } .erc-seg button.a[aria-pressed="true"] { box-shadow: inset 0 -2px 0 var(--ok); }
.erc-sheet { display: block; width: 100%; background: var(--tool-canvas); user-select: none; -webkit-user-select: none; }
.erc-foot { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; border-top: 1px solid var(--line-soft); font-size: 12px; flex-wrap: wrap; }
.erc-foot .tag { font: 600 11px "IBM Plex Mono", ui-monospace, monospace; padding: 0 6px; border-radius: 3px; color: var(--surface); }
.erc-foot .tag.err { background: var(--danger); } .erc-foot .tag.fix { background: var(--ok); }
.erc-foot code { font-size: 12px; }
.erc-foot .hint { margin-left: auto; color: var(--ink-soft); font-size: 11px; }
.erc-foot kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.erc-low { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 10px; align-items: start; }
@media (max-width: 1180px) { .erc-low { grid-template-columns: minmax(0, 1fr); } }
.erc-exp { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line-soft); }
@media (max-width: 520px) { .erc-exp { grid-template-columns: minmax(0, 1fr); } }
.erc-exp div { background: var(--surface); padding: 7px 10px 9px; font-size: 12.5px; line-height: 1.45; }
.erc-exp div b { display: block; font-size: 10.5px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .04em; font-weight: 600; margin-bottom: 2px; }
.erc-exp div.fix { box-shadow: inset 3px 0 0 var(--ok); } .erc-exp div.waive { box-shadow: inset 3px 0 0 var(--warn); }
.erc-exp div.means { box-shadow: inset 3px 0 0 var(--accent); } .erc-exp div.cause { box-shadow: inset 3px 0 0 var(--danger); }
.erc-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.erc-warns:empty { display: none; }
.erc-notes { font-size: 11.5px; color: var(--ink-soft); padding: 0 2px; }
.erc-notes summary { cursor: pointer; } .erc-notes div { margin-top: 4px; }
.erc .k-out { max-height: 240px; }
/* the schematic */
.erc svg .sw { fill: none; stroke: var(--tool-wire); stroke-width: 1.8; vector-effect: non-scaling-stroke; stroke-linecap: round; stroke-linejoin: round; }
.erc svg .sb { fill: none; stroke: var(--tool-bus); stroke-width: 4.5; vector-effect: non-scaling-stroke; stroke-linecap: round; }
.erc svg .sb.thin { stroke-width: 1.8; }
.erc svg .sj { fill: var(--tool-wire); }
.erc svg .sgrid { fill: var(--tool-grid); r: 0.09; }
.erc svg .sbody { fill: var(--tool-body); stroke: var(--tool-sym); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.erc svg .spin { stroke: var(--tool-sym); stroke-width: 1.5; vector-effect: non-scaling-stroke; fill: none; }
.erc svg .spwr { stroke: var(--tool-pwr); stroke-width: 1.5; vector-effect: non-scaling-stroke; fill: none; }
.erc svg .snc { stroke: var(--tool-bus); stroke-width: 2; vector-effect: non-scaling-stroke; }
.erc svg .sanch { fill: none; stroke: var(--tool-lab); stroke-width: 1; vector-effect: non-scaling-stroke; }
.erc svg .sglob, .erc svg .shier { fill: none; stroke: var(--tool-hier); stroke-width: 1.4; vector-effect: non-scaling-stroke; }
.erc svg .sghost { fill: none; stroke: var(--danger); stroke-width: 1.5; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; }
.erc svg .sframe { fill: none; stroke: var(--line); stroke-width: 1.2; vector-effect: non-scaling-stroke; stroke-dasharray: 6 3; }
.erc svg .ssheet { fill: color-mix(in srgb, var(--tool-sheet) 8%, transparent); stroke: var(--tool-sheet); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.erc svg text.st { font-family: "IBM Plex Mono", ui-monospace, monospace; fill: var(--tool-lab); }
.erc svg text.sref { fill: var(--tool-sym); font-weight: 600; }
.erc svg text.sval, .erc svg text.spn, .erc svg text.sframet, .erc svg text.sfield { fill: var(--ink-soft); }
.erc svg text.slab { fill: var(--tool-lab); }
.erc svg text.spwrt { fill: var(--tool-pwr); }
.erc svg text.shiert, .erc svg text.ssheett { fill: var(--tool-hier); }
.erc svg text.sbust { fill: var(--tool-bus); }
.erc svg text.sghostt, .erc svg text.bad, .erc svg text.sbadt { fill: var(--danger); }
.erc svg text.snote { fill: var(--ok); }
.erc svg .mk { fill: var(--danger); stroke: var(--surface); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
.erc svg .mkhalo { fill: none; stroke: var(--danger); stroke-width: 1.5; vector-effect: non-scaling-stroke; opacity: .55; }
.erc svg .fxhalo { fill: color-mix(in srgb, var(--ok) 14%, transparent); stroke: var(--ok); stroke-width: 1.5; vector-effect: non-scaling-stroke; stroke-dasharray: 4 3; }
.erc svg .mkbtn { cursor: pointer; }
.erc svg .mkbtn:focus { outline: none; }
.erc svg .mkbtn:focus-visible .mkhalo { stroke: var(--accent); stroke-width: 3; opacity: 1; }
.erc .erc-item svg text { display: none; }
.erc .erc-item svg .sb { stroke-width: 2.5; } .erc .erc-item svg .sw, .erc .erc-item svg .spin, .erc .erc-item svg .sbody { stroke-width: 1; }
`;

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'erc' });
  root.append(wrap);

  // ---------- the atlas ----------
  const filter = h('input', { type: 'text', spellcheck: 'false', placeholder: 'filter: label, bus, power…', 'aria-label': 'Filter the rule list',
    oninput: (e) => ctx.set('filter', e.target.value) });
  const list = h('div', { class: 'erc-list', role: 'list' });
  const count = h('span', { class: 'alt' });
  wrap.append(h('aside', { class: 'erc-atlas', 'aria-label': 'Every ERC rule' },
    h('div', { class: 'erc-atlas-head' }, h('h2', {}, 'ERC rules ', count), filter), list));

  // ---------- main: the pasted line, the sheet, the explanation ----------
  const msg = h('input', { type: 'text', spellcheck: 'false', placeholder: 'Paste the ERC line, e.g. "Input Power pin not driven by any Output Power pins"',
    'aria-label': 'ERC message from your tool', oninput: (e) => ctx.set('message', e.target.value) });
  const msgState = h('span', { class: 'st' });
  const clearBtn = h('button', { class: 'k-btn', type: 'button', onclick: () => ctx.set('message', '') }, 'Clear');
  const cmd = h('div', { class: 'erc-cmd' }, h('label', { for: 'erc-msg' }, 'ERC ›'), msg, msgState, clearBtn);
  msg.id = 'erc-msg';

  const code = h('h2', {});
  const alt = h('span', { class: 'alt' });
  const risk = h('span', { class: 'erc-risk' });
  let fixed = false;
  const bBtn = h('button', { type: 'button', class: 'b', 'aria-pressed': 'true', onclick: () => { fixed = false; draw(); } }, 'As reported');
  const aBtn = h('button', { type: 'button', class: 'a', 'aria-pressed': 'false', onclick: () => { fixed = true; draw(); } }, 'Fixed');
  const sheetHost = h('div', {});
  const foot = h('div', { class: 'erc-foot', 'aria-live': 'polite' });
  const sheetCard = h('section', { class: 'erc-card', 'aria-label': 'The rule on a schematic' },
    h('div', { class: 'erc-head' }, code, alt, h('div', { class: 'right' }, risk, h('div', { class: 'erc-seg', role: 'group', 'aria-label': 'Show the sheet' }, bBtn, aBtn))),
    sheetHost, foot);
  const exp = h('div', { class: 'erc-exp' });
  const warns = h('div', { class: 'erc-warns', role: 'status' });
  const notes = h('details', { class: 'erc-notes' });
  wrap.append(h('div', { class: 'erc-main' }, cmd, warns, sheetCard,
    h('div', { class: 'erc-low' }, h('section', { class: 'erc-card', 'aria-label': 'Explanation' }, exp), h('div', { style: 'display:flex;flex-direction:column;gap:10px;min-width:0' }, ctx.outputs, notes))));

  let R = null, I = null, lastCode = null, focusCode = null;

  const scene = (svg, codeId, isFixed, k, interactive) => {
    const g = s('g', { transform: `scale(${k})` });
    svg.append(g);
    const fn = SCENES[codeId];
    if (!fn) return null;
    const out = fn(kit(g), isFixed) || {};
    const [x, y] = out.spot || [20, 10];
    if (!isFixed) {
      // KiCad's marker: a red arrow pointing at the spot from the upper right
      const m = s('g', { class: interactive ? 'mkbtn' : null, tabindex: interactive ? 0 : null, role: interactive ? 'button' : null,
        'aria-label': interactive ? 'ERC marker: show the fix' : null, transform: `translate(${x * k},${y * k})${out.dir === 'ul' ? ' scale(-1,1)' : ''}` });
      const r = interactive ? Math.min(16, Math.max(9, k * 0.9)) : 4;
      m.append(s('circle', { cx: 0, cy: 0, r, class: 'mkhalo' }));
      const a = interactive ? Math.min(1.3, Math.max(0.7, k / 16)) : 0.35;
      m.append(s('path', { d: `M0,0l${4 * a},${-13 * a}l${3 * a},${3 * a}l${7 * a},${-7 * a}l${3 * a},${3 * a}l${-7 * a},${7 * a}l${3 * a},${3 * a}z`, class: 'mk' }));
      if (interactive) {
        m.addEventListener('click', () => { fixed = true; draw(); });
        m.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fixed = true; draw(); } });
      }
      svg.append(m);
    } else if (interactive) {
      svg.append(s('circle', { cx: x * k, cy: y * k, r: Math.min(22, Math.max(10, k * 1.2)), class: 'fxhalo' }));
    }
    return out;
  };

  const drawAtlas = () => {
    const rows = R?.tables?.[1]?.rows || [];
    const cur = I.rule;
    const shown = new Map(rows.map((r) => [String(r[0]).replace(/^▶\s*/, ''), r]));
    count.textContent = `${shown.size}`;
    list.replaceChildren();
    if (!shown.size) { list.append(h('div', { class: 'erc-none' }, 'No rule mentions that. Clear the filter.')); return; }
    const current = R.values?.[0]?.value;
    for (const [grp, codes] of GROUPS) {
      const here = codes.filter((c) => shown.has(c));
      if (!here.length) continue;
      list.append(h('div', { class: 'erc-grp' }, grp));
      for (const c of here) {
        const r = shown.get(c);
        const th = s('svg', { viewBox: '0 0 80 40', 'aria-hidden': 'true' });
        scene(th, c, false, 2, false);
        const b = h('button', { type: 'button', class: `erc-item r-${r[3]}`, 'aria-pressed': String(c === current), 'data-code': c, title: r[1],
          onclick: () => { focusCode = c; fixed = false; ctx.setMany({ rule: c, message: '' }); },
          onkeydown: (e) => {
            const items = [...list.querySelectorAll('.erc-item')];
            const i = items.indexOf(e.currentTarget);
            const k = ['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 0;
            if (k) { e.preventDefault(); items[i + k]?.focus(); }
          } },
        th, h('div', {}, h('b', {}, c), h('span', {}, r[1])));
        list.append(b);
      }
    }
    void cur;
  };

  const drawSheet = (c) => {
    const W = Math.max(300, sheetHost.clientWidth || 800);
    const H = Math.round(Math.min(430, Math.max(190, W * 0.47)));
    const k = Math.min(W / 40, H / 20);
    const svg = s('svg', { class: 'erc-sheet', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
      'aria-label': `${c}: schematic ${fixed ? 'after the fix' : 'as ERC reports it'}` });
    const ox = (W - 40 * k) / 2, oy = (H - 20 * k) / 2;
    const pat = s('pattern', { id: 'erc-dots', width: k, height: k, patternUnits: 'userSpaceOnUse', x: ox, y: oy });
    pat.append(s('circle', { cx: 0.5, cy: 0.5, r: 0.8, fill: 'var(--tool-grid)' }));
    const defs = s('defs'); defs.append(pat); svg.append(defs);
    svg.append(s('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#erc-dots)', opacity: 0.7 }));
    const g0 = s('g', { transform: `translate(${ox},${oy})` });
    svg.append(g0);
    const out = scene(g0, c, fixed, k, true);
    sheetHost.replaceChildren(svg);
    return out;
  };

  const sync = () => {
    const raw = ctx.raw;
    if (document.activeElement !== msg) msg.value = raw.message ?? '';
    if (document.activeElement !== filter) filter.value = raw.filter ?? '';
  };

  const draw = () => {
    if (!R) return;
    sync();
    const v = R.values || [];
    const c = v[0]?.value;
    if (c !== lastCode) { if (lastCode != null && !focusCode) fixed = false; lastCode = c; }
    const rk = v[1]?.value || 'low';
    const rows = Object.fromEntries((R.tables?.[0]?.rows || []).map((r) => [r[0], r[1]]));
    code.textContent = c || '';
    alt.textContent = rows['Altium name'] && rows['Altium name'] !== '-' ? `Altium: ${rows['Altium name']}` : 'no Altium equivalent';
    risk.className = `erc-risk ${rk}`;
    risk.textContent = `${rk} bug risk · ${v[1]?.hint || ''}`;
    bBtn.setAttribute('aria-pressed', String(!fixed)); aBtn.setAttribute('aria-pressed', String(fixed));
    const out = drawSheet(c) || {};
    foot.replaceChildren(
      fixed ? h('span', { class: 'tag fix' }, 'FIXED') : h('span', { class: 'tag err' }, 'ERC'),
      fixed ? h('span', {}, out.fix || rows.Fix) : h('code', {}, rows.Message || ''),
      h('span', { class: 'hint' }, fixed ? 'the same sheet after the usual fix' : h('span', {}, 'click the marker or ', h('kbd', {}, 'Enter'), ' on it to see the fix')));
    exp.replaceChildren(
      h('div', { class: 'means' }, h('b', {}, 'Means'), rows.Means || ''),
      h('div', { class: 'cause' }, h('b', {}, 'Usual causes'), rows['Usual causes'] || ''),
      h('div', { class: 'fix' }, h('b', {}, 'Fix'), rows.Fix || ''),
      h('div', { class: 'waive' }, h('b', {}, 'OK to waive'), rows['OK to waive'] || ''));
    const from = v[0]?.hint;
    const m = String(ctx.raw.message || '').trim();
    msgState.className = `st ${m ? (from === 'matched from the message' ? 'ok' : 'bad') : ''}`;
    msgState.textContent = m ? (from === 'matched from the message' ? `matched → ${c}` : 'no match: showing the picked rule') : 'or pick a rule from the list';
    clearBtn.hidden = !m;
    warns.replaceChildren(...(R.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Notes (${(R.notes || []).length})`), ...(R.notes || []).map((n) => h('div', {}, n)));
    drawAtlas();
    const sel = list.querySelector('[aria-pressed="true"]');
    if (focusCode) { list.querySelector(`[data-code="${focusCode}"]`)?.focus(); focusCode = null; }
    else if (sel && list.scrollHeight > list.clientHeight) {
      const lr = list.getBoundingClientRect(), sr = sel.getBoundingClientRect();
      if (sr.top < lr.top || sr.bottom > lr.bottom) list.scrollTop += sr.top - lr.top - 40;
    }
  };

  ctx.onResult((res, input) => { R = res; I = input; draw(); });
  let lastW = 0;
  new ResizeObserver(() => { const w = sheetHost.clientWidth; if (w !== lastW) { lastW = w; draw(); } }).observe(sheetHost);
}
