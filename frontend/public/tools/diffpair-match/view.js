// Differential Pair Matcher, drawn as the pair itself: a driver, the two
// traces with their bends and a connector, seen from above. The shorter trace
// carries a tuning meander you pull out (or press Enter on) to add the length
// it lacks; below it a vernier magnifies the two trace ends against the
// interface's tolerance band, and both ends drag. On the right the edges
// arrive at the receiver in time, P against N, with the skew and the UI.
// "All interfaces" turns the stage into a ladder of every interface's
// tolerance; click a rung to route that one. Every number comes from run().

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
const num = (t) => { const m = String(t ?? '').match(/-?\d+(\.\d+)?(e-?\d+)?/i); return m ? Number(m[0]) : null; };

// The picker: families of interfaces, short names on the chips.
const GROUPS = [
  ['USB', [['usb2', '2.0 HS'], ['usb3', '3.2 G1'], ['usb32g2', '3.2 G2'], ['usb4', 'USB4']]],
  ['PCIe', [['pcie12', 'Gen 1/2'], ['pcie34', 'Gen 3/4']]],
  ['Storage', [['sata', 'SATA']]],
  ['Ethernet', [['eth100', '100BASE-TX'], ['eth1000', '1000BASE-T'], ['sgmii', 'SGMII']]],
  ['Video', [['hdmi14', 'HDMI 1.4'], ['hdmi20', 'HDMI 2.0'], ['dp', 'DP'], ['mipi', 'MIPI D-PHY'], ['lvds', 'LVDS']]],
  ['Memory', [['ddr_ck', 'DDR CK/DQS']]],
  ['Fieldbus', [['can', 'CAN'], ['rs485', 'RS-485']]],
];
// What sits at the far end of the pair, for the drawing.
const FAR = { usb2: 'USB', usb3: 'USB-C', usb32g2: 'USB-C', usb4: 'USB-C', pcie12: 'slot', pcie34: 'slot', sata: 'SATA',
  eth100: 'magnetics', eth1000: 'magnetics', sgmii: 'PHY', hdmi14: 'HDMI', hdmi20: 'HDMI', dp: 'DP', mipi: 'FPC',
  lvds: 'FPC', ddr_ck: 'DRAM', can: 'CAN xcvr', rs485: 'RS-485' };
const NEAR = { eth100: 'PHY', eth1000: 'PHY', ddr_ck: 'SoC', can: 'MCU', rs485: 'UART', mipi: 'SoC', lvds: 'SoC' };
// Table rows name the interface; this finds its id again when a rung is clicked.
const ID_BY_NAME = {
  'USB 2.0 High-Speed': 'usb2', 'USB 3.2 Gen 1': 'usb3', 'USB 3.2 Gen 2': 'usb32g2', 'USB4': 'usb4',
  'PCI Express Gen 1/2': 'pcie12', 'PCI Express Gen 3/4': 'pcie34', 'SATA': 'sata', 'Ethernet 10/100': 'eth100',
  'Ethernet 1000': 'eth1000', 'SGMII': 'sgmii', 'HDMI 1.4': 'hdmi14', 'HDMI 2.0': 'hdmi20', 'DisplayPort': 'dp',
  'MIPI D-PHY': 'mipi', 'LVDS': 'lvds', 'DDR3/DDR4': 'ddr_ck', 'CAN': 'can', 'RS-485': 'rs485',
};
const idOf = (name) => { for (const [k, v] of Object.entries(ID_BY_NAME)) if (String(name).startsWith(k)) return v; return null; };

const CSS = `
.dpm { --tool-p: #c2410c; --tool-n: #1d4ed8; --tool-cu: #b7791f; --tool-pcb: #dfe7df; --tool-part: #2b3945; --tool-part-ink: #e4ebf1; --tool-part-soft: #8ea0b0;
  display: flex; flex-direction: column; gap: 10px; min-width: 0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .dpm {
  --tool-p: #f08a4b; --tool-n: #6d9bff; --tool-cu: #e0a84a; --tool-pcb: #13201a; --tool-part: #0b1116; } }
:root[data-theme="dark"] .dpm { --tool-p: #f08a4b; --tool-n: #6d9bff; --tool-cu: #e0a84a; --tool-pcb: #13201a; --tool-part: #0b1116; }
.dpm-pick { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: flex-end; background: var(--surface);
  border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px 8px; }
.dpm-fam { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dpm-fam > span { font-size: 10.5px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .04em; }
.dpm-fam > div { display: flex; gap: 2px; flex-wrap: wrap; }
.dpm-chip { border: 1px solid var(--line); background: var(--surface); border-radius: 4px; padding: 2px 6px; cursor: pointer;
  font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); white-space: nowrap; }
.dpm-chip:hover { border-color: var(--ink-soft); }
.dpm-chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.dpm-all { margin-left: auto; }
.dpm-grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 10px; align-items: start; }
@media (max-width: 1040px) { .dpm-grid { grid-template-columns: minmax(0, 1fr); } }
.dpm-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dpm-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.dpm-head { display: flex; align-items: center; gap: 6px 14px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.dpm-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.dpm-head .sub { font-size: 11.5px; color: var(--ink-soft); }
.dpm-head .right { margin-left: auto; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.dpm-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.dpm-seg button { border: 0; background: var(--surface); padding: 2px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.dpm-seg button + button { border-left: 1px solid var(--line); }
.dpm-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 500; }
.dpm-num { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-soft); }
.dpm-num input { width: 74px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.dpm-num input.bad { border-color: var(--danger); }
.dpm-num.p b { color: var(--tool-p); } .dpm-num.n b { color: var(--tool-n); }
.dpm-num input.short { width: 52px; }
.dpm-svg { display: block; width: 100%; user-select: none; -webkit-user-select: none; }
.dpm-svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.dpm-svg text.soft { fill: var(--ink-soft); } .dpm-svg text.small { font-size: 10px; }
.dpm-svg text.big { font-size: 13px; font-weight: 600; }
.dpm-svg text.ok { fill: var(--ok); } .dpm-svg text.bad { fill: var(--danger); } .dpm-svg text.warn { fill: var(--warn); }
.dpm-svg text.p { fill: var(--tool-p); } .dpm-svg text.partink { fill: var(--tool-part-ink); } .dpm-svg text.partsoft { fill: var(--tool-part-soft); } .dpm-svg text.n { fill: var(--tool-n); }
.dpm-svg .hdl { cursor: grab; touch-action: none; }
.dpm-svg .hdl:focus { outline: none; }
.dpm-svg .hdl:focus-visible .ring { stroke: var(--accent); stroke-width: 2.5; stroke-dasharray: 3 2; }
.dpm-svg .rung { cursor: pointer; }
.dpm-svg .rung:hover .bg, .dpm-svg .rung:focus-visible .bg { fill: var(--sunken); }
.dpm-svg .rung:focus { outline: none; }
.dpm-help { padding: 5px 10px 8px; font-size: 11.5px; color: var(--ink-soft); border-top: 1px solid var(--line-soft); }
.dpm-help kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.dpm-read { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.dpm-big { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dpm-big b { font: 500 30px "IBM Plex Mono", ui-monospace, monospace; line-height: 1; }
.dpm-big b small { font-size: 14px; color: var(--ink-soft); }
.dpm-big .verdict { font-size: 12px; font-weight: 600; padding: 1px 7px; border-radius: 3px; border: 1px solid; }
.dpm-big .verdict.ok { color: var(--ok); } .dpm-big .verdict.bad { color: var(--danger); } .dpm-big .verdict.none { color: var(--ink-soft); }
.dpm-big.ok b { color: var(--ok); } .dpm-big.bad b { color: var(--danger); }
.dpm-sub2 { font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.dpm-kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; font-size: 12px; margin: 0; }
.dpm-kv dt { color: var(--ink-soft); } .dpm-kv dd { margin: 0; font-family: "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.dpm-kv dd small { color: var(--ink-soft); }
.dpm-note { font-size: 12px; background: var(--sunken); border-radius: 4px; padding: 6px 8px; }
.dpm-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.dpm-warns div + div { margin-top: 4px; } .dpm-warns:empty { display: none; }
.dpm-notes { font-size: 11.5px; color: var(--ink-soft); padding: 0 2px; }
.dpm-notes summary { cursor: pointer; } .dpm-notes div { margin-top: 4px; }
.dpm-filter { display: inline-flex; gap: 4px; align-items: center; font-size: 11.5px; color: var(--ink-soft); }
.dpm-filter input { width: 150px; padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink); font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.dpm .k-out { max-height: 220px; }
`;

export function page(root, ctx) {
  const f = ctx.fmtNum;
  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'dpm' });
  root.append(wrap);

  // ---------- the interface picker ----------
  const chips = {};
  const chip = (id, label, title) => (chips[id] = h('button', { class: 'dpm-chip', type: 'button', title, 'aria-pressed': 'false',
    onclick: () => ctx.setMany({ iface: id, ...(id !== 'all' ? { filter: '' } : {}) }) }, label));
  const optName = Object.fromEntries(ctx.manifest.inputs.find((d) => d.key === 'iface').options);
  const pick = h('nav', { class: 'dpm-pick', 'aria-label': 'Interface' },
    GROUPS.map(([fam, list]) => h('div', { class: 'dpm-fam' }, h('span', {}, fam),
      h('div', {}, list.map(([id, t]) => chip(id, t, optName[id]))))),
    h('div', { class: 'dpm-fam dpm-all' }, h('span', {}, 'Compare'), h('div', {}, chip('all', 'All interfaces', 'Every interface\'s tolerance side by side'))));
  wrap.append(pick);

  // ---------- inputs that live on the stage header ----------
  const fields = {};
  const numField = (key, label, cls, unit) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label}${unit ? ` (${unit})` : ''}`,
      class: key === 'er' ? 'short' : null, oninput: (e) => ctx.set(key, e.target.value) });
    fields[key] = inp;
    return h('label', { class: `dpm-num ${cls || ''}` }, h('b', {}, label), inp, unit ? h('span', {}, unit) : null);
  };
  const layerBtns = {};
  const layerSeg = h('div', { class: 'dpm-seg', role: 'group', 'aria-label': 'Routing layer' },
    [['microstrip', 'Outer'], ['stripline', 'Inner']].map(([v, t]) => (layerBtns[v] = h('button', { type: 'button', 'aria-pressed': 'false',
      title: v === 'microstrip' ? 'Microstrip on an outer layer' : 'Stripline on an inner layer', onclick: () => ctx.set('layer', v) }, t))));
  const filterInp = h('input', { type: 'text', spellcheck: 'false', placeholder: 'e.g. 100 Ω, AC-coupling', 'aria-label': 'Filter text',
    oninput: (e) => ctx.set('filter', e.target.value) });
  fields.filter = filterInp;

  const title = h('h2', {});
  const titleSub = h('span', { class: 'sub' });
  const headRight = h('div', { class: 'right' });
  const routeHost = h('div', {});
  const vernHost = h('div', {});
  const stageHelp = h('div', { class: 'dpm-help' });
  const stage = h('section', { class: 'dpm-card', 'aria-label': 'The pair' },
    h('div', { class: 'dpm-head' }, title, titleSub, headRight), routeHost, vernHost, stageHelp);

  // ---------- right column ----------
  const readBody = h('div', { class: 'dpm-read' });
  const readCard = h('section', { class: 'dpm-card', 'aria-live': 'polite' },
    h('div', { class: 'dpm-head' }, h('h2', {}, 'P/N mismatch'), h('span', { class: 'sub' }, 'intra-pair')), readBody);
  const timeHost = h('div', {});
  const timeSub = h('span', { class: 'sub' });
  const timeCard = h('section', { class: 'dpm-card' },
    h('div', { class: 'dpm-head' }, h('h2', {}, 'At the receiver'), timeSub), timeHost);
  const warns = h('div', { class: 'dpm-warns', role: 'status' });
  const notes = h('details', { class: 'dpm-notes' });
  const right = h('div', { class: 'dpm-col' }, readCard, timeCard, ctx.outputs, notes);
  wrap.append(warns, h('div', { class: 'dpm-grid' }, h('div', { class: 'dpm-col' }, stage), right));

  // ---------- state from the result ----------
  let R = null, I = null;
  let drag = null;           // { kind, ... } while a handle is held
  let vDom = null;           // vernier domain frozen while dragging
  let focusKey = null;       // which handle had the focus, to give it back after a redraw

  const val = (label) => R?.values?.find((v) => v.label === label);
  const model = () => {
    const one = I.iface !== 'all' && (R?.tables?.[0]?.rows?.length === 1);
    const intra = val('Intra-pair tolerance');
    const tol = intra && /mm/.test(intra.value) ? num(intra.value) : null;
    const tolMil = intra?.hint ? num(intra.hint) : null;
    const tolPs = intra?.hint ? num(String(intra.hint).split(',')[1]) : null;
    const mm = val('Your P/N mismatch');
    const d = mm ? num(mm.value) : null;
    const dPs = mm ? num(mm.hint) : null;
    const share = val('Mismatch as share of UI');
    const ui = share ? num(String(share.hint).replace(/^UI\s*/, '')) : null;
    const delay = val('Delay used');
    const row = R?.tables?.[0]?.rows?.[0];
    return { one, tol, tolMil, tolPs, d, dPs, tone: mm?.tone, share: share ? num(share.value) : null, ui,
      psPerMm: delay ? num(delay.value) : null, delayHint: delay?.hint, z: val('Differential impedance')?.value,
      inter: val('Inter-pair tolerance'), row, P: I.lenP, N: I.lenN,
      hasLen: Number.isFinite(I.lenP) && Number.isFinite(I.lenN) };
  };

  // ---------- pointer plumbing: window listeners survive redraws ----------
  const startDrag = (e, d) => {
    e.preventDefault();
    drag = d;
    const move = (ev) => { if (drag) drag.move(ev); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up); drag = null; vDom = null; draw(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  const setLen = (key, v) => ctx.set(key, String(Math.round(Math.max(0, v) * 1000) / 1000));

  // ---------- the route, seen from above ----------
  const offsetLine = (pts, d) => pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let n1 = null, n2 = null;
    if (i > 0) { const dx = p[0] - a[0], dy = p[1] - a[1], L = Math.hypot(dx, dy); n1 = [-dy / L, dx / L]; }
    if (i < pts.length - 1) { const dx = b[0] - p[0], dy = b[1] - p[1], L = Math.hypot(dx, dy); n2 = [-dy / L, dx / L]; }
    if (!n1) n1 = n2; if (!n2) n2 = n1;
    const m = [n1[0] + n2[0], n1[1] + n2[1]], ml = Math.hypot(...m) || 1, cos = (m[0] * n1[0] + m[1] * n1[1]) / ml;
    return [p[0] + (m[0] / ml) * d / cos, p[1] + (m[1] / ml) * d / cos];
  });
  const pathOf = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');

  const drawRoute = (M) => {
    const W = Math.max(300, routeHost.clientWidth || 700);
    const narrow = W < 560;
    const H = narrow ? 250 : 330;
    const svg = s('svg', { class: 'dpm-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'group', 'aria-label': 'The differential pair from the driver to the connector, seen from above' });
    svg.append(s('rect', { x: 0, y: 0, width: W, height: H, fill: 'var(--tool-pcb)' }));
    // faint board grid
    for (let x = 20; x < W; x += 20) svg.append(s('line', { x1: x, x2: x, y1: 0, y2: H, stroke: 'var(--line-soft)', 'stroke-width': 0.5, opacity: 0.5 }));
    const id = I.iface;
    const g = narrow ? 9 : 12, tw = narrow ? 3.5 : 4.5;
    const icW = narrow ? 46 : 84, cnW = narrow ? 52 : 84;
    const yLow = narrow ? H - 50 : H - 78, yHigh = narrow ? H - 130 : 74;
    const x0 = 14 + icW, x3 = W - 14 - cnW;
    const xa = x0 + (x3 - x0) * 0.24, xb = xa + (yLow - yHigh);
    const center = [[x0, yLow], [xa, yLow], [xb, yHigh], [x3, yHigh]];
    const Pp = offsetLine(center, -g / 2), Np = offsetLine(center, g / 2);
    // driver and far end
    const part = (x, w, name, sub) => {
      const gEl = s('g');
      gEl.append(s('rect', { x, y: yLow - 58, width: w, height: 116, rx: 3, fill: 'var(--tool-part)', stroke: 'var(--line)' }));
      gEl.append(s('text', { x: x + w / 2, y: yLow - 36, 'text-anchor': 'middle', class: 'partink' }, name));
      if (sub) gEl.append(s('text', { x: x + w / 2, y: yLow - 22, 'text-anchor': 'middle', class: 'small partsoft' }, sub));
      return gEl;
    };
    svg.append(part(14, icW, NEAR[id] || 'Driver', 'TX'));
    const cn = s('g');
    cn.append(s('rect', { x: x3, y: yHigh - 44, width: cnW, height: 88, rx: 3, fill: 'var(--tool-part)', stroke: 'var(--line)' }));
    cn.append(s('text', { x: x3 + cnW / 2, y: yHigh + 32, 'text-anchor': 'middle', class: 'partink' }, FAR[id] || 'Connector'));
    for (let k = -3; k <= 3; k++) if (Math.abs(k) > 0) cn.append(s('rect', { x: x3 + 6, y: yHigh + k * g / 2 - 1.5, width: 10, height: 3, fill: 'var(--tool-cu)', opacity: 0.45 }));
    svg.append(cn);
    // pads
    for (const [pts, cls] of [[Pp, 'p'], [Np, 'n']]) {
      svg.append(s('rect', { x: pts[0][0] - 8, y: pts[0][1] - 2.5, width: 10, height: 5, fill: 'var(--tool-cu)' }));
      svg.append(s('rect', { x: pts[3][0] - 2, y: pts[3][1] - 2.5, width: 12, height: 5, fill: 'var(--tool-cu)' }));
    }
    // the shorter trace carries the tuning meander
    const shorter = M.hasLen && M.P !== M.N ? (M.P < M.N ? 'N_is_long' : 'P_is_long') : null;
    const tuneOn = shorter === 'N_is_long' ? 'P' : shorter === 'P_is_long' ? 'N' : null;
    const need = M.hasLen ? Math.abs(M.P - M.N) : 0;
    const fail = M.tone === 'bad';
    const mx0 = xb + (x3 - xb) * 0.28, mx1 = xb + (x3 - xb) * 0.62;
    const meanderPath = (pts, side, amp) => {
      // replace the stretch mx0..mx1 of the last segment with a meander
      const y = pts[3][1];
      const bumps = Math.max(2, Math.round((mx1 - mx0) / 22));
      const step = (mx1 - mx0) / bumps;
      let d = `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}L${pts[2][0]},${pts[2][1]}L${mx0},${y}`;
      for (let k = 0; k < bumps; k++) {
        const xL = mx0 + k * step + step * 0.2, xR = mx0 + k * step + step * 0.8;
        d += `L${xL},${y}L${xL},${y + side * amp}L${xR},${y + side * amp}L${xR},${y}`;
      }
      return d + `L${pts[3][0]},${y}`;
    };
    const ampFor = (add) => {
      if (!(add > 0)) return 0;
      const ref = M.tol || Math.max(need, 0.1);
      return clamp(6 + 16 * Math.min(1, add / (ref * 4)), 6, 22);
    };
    const tuneAmp = ampFor(need);
    const drawTrace = (pts, who) => {
      const side = who === 'P' ? -1 : 1;
      const d = who === tuneOn && tuneAmp ? meanderPath(pts, side, tuneAmp) : pathOf(pts);
      svg.append(s('path', { d, fill: 'none', stroke: `var(--tool-${who.toLowerCase()})`, 'stroke-width': tw, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    };
    drawTrace(Pp, 'P'); drawTrace(Np, 'N');
    // bends: where mismatch arises
    for (const i of [1, 2]) {
      const c = center[i];
      svg.append(s('circle', { cx: c[0], cy: c[1], r: g + 3, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-dasharray': '2 3', opacity: 0.8 }));
    }
    if (!narrow) svg.append(s('text', { x: center[1][0] + g + 8, y: center[1][1] + g + 16, class: 'soft small' }, 'bends: the outer trace runs longer here'));
    // lengths on the traces
    if (!narrow && Number.isFinite(M.P)) svg.append(s('text', { x: x0 + 10, y: Pp[0][1] - 9, class: 'p' }, `P ${f(M.P, 5)} mm`));
    if (!narrow && Number.isFinite(M.N)) svg.append(s('text', { x: x0 + 10, y: Np[0][1] + 19, class: 'n' }, `N ${f(M.N, 5)} mm`));
    // impedance tag on the pair
    if (M.z) {
      const tx = narrow ? 14 : (xb + mx0) / 2 - 4, ty = narrow ? 104 : yHigh;
      const t = s('text', { x: tx, y: ty - g / 2 - 14, 'text-anchor': narrow ? 'start' : 'middle', class: 'big' }, M.z.split(' (')[0]);
      svg.append(t);
      svg.append(s('text', { x: tx, y: ty - g / 2 - 28, 'text-anchor': narrow ? 'start' : 'middle', class: 'soft small' }, 'differential Z'));
    }
    // the meander handle
    if (M.hasLen && tuneOn) {
      const pts = tuneOn === 'P' ? Pp : Np, side = tuneOn === 'P' ? -1 : 1;
      const hx = (mx0 + mx1) / 2, hy = pts[3][1] + side * (tuneAmp + 9);
      const lab = fail ? `add ${f(need, 3)} mm to ${tuneOn}` : `${tuneOn} is ${f(need, 3)} mm short`;
      const key = tuneOn === 'P' ? 'lenP' : 'lenN', other = tuneOn === 'P' ? M.N : M.P, base = tuneOn === 'P' ? M.P : M.N;
      const hg = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'data-h': 'meander',
        'aria-label': `Tuning meander on ${tuneOn}: pull it out to add length, Enter matches ${tuneOn} to ${tuneOn === 'P' ? 'N' : 'P'}`,
        'aria-valuenow': f(base, 5), 'aria-valuetext': `${tuneOn} ${f(base, 5)} mm, ${f(need, 3)} mm short` });
      hg.append(s('rect', { x: mx0 - 6, y: Math.min(pts[3][1], pts[3][1] + side * (tuneAmp + 4)) - 4, width: mx1 - mx0 + 12, height: tuneAmp + 16,
        fill: fail ? 'var(--danger)' : 'var(--ok)', opacity: 0.1, stroke: fail ? 'var(--danger)' : 'var(--ok)', 'stroke-dasharray': '3 3', rx: 3 }));
      hg.append(s('circle', { class: 'ring', cx: hx, cy: hy, r: 8, fill: 'var(--surface)', stroke: `var(--tool-${tuneOn.toLowerCase()})`, 'stroke-width': 2 }));
      hg.append(s('path', { d: `M${hx},${hy - 4}L${hx},${hy + 4}M${hx - 3},${hy + side * 1}L${hx},${hy + side * 4}L${hx + 3},${hy + side * 1}`, stroke: 'var(--ink)', 'stroke-width': 1.3, fill: 'none' }));
      hg.append(s('text', { x: narrow ? clamp(hx, 90, W - 90) : hx, y: hy + side * 22 + (side > 0 ? 4 : 0), 'text-anchor': 'middle', class: fail ? 'bad' : 'ok' }, lab));
      hg.addEventListener('pointerdown', (e) => {
        const k = (M.tol || Math.max(need, 0.1)) / 40; // mm per px
        const y0 = e.clientY;
        startDrag(e, { move: (ev) => {
          const pull = side * (ev.clientY - y0);
          setLen(key, clamp(base + Math.max(0, pull) * k, base, other + (M.tol || 0)));
        } });
      });
      hg.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 0.01 : 0.001;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusKey = 'meander'; setLen(key, other); }
        else if (['ArrowUp', 'ArrowRight'].includes(e.key)) { e.preventDefault(); focusKey = 'meander'; setLen(key, base + st); }
        else if (['ArrowDown', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); focusKey = 'meander'; setLen(key, base - st); }
      });
      svg.append(hg);
    } else if (M.hasLen) {
      svg.append(s('text', { x: (mx0 + mx1) / 2, y: yHigh + g / 2 + 24, 'text-anchor': 'middle', class: 'ok' }, 'P and N match exactly'));
    }
    // mismatch callout at the far end
    if (M.hasLen && M.d != null) {
      const cx = narrow ? 14 : x3 - 6, cy = narrow ? 24 : yHigh + g / 2 + 76, anc = narrow ? 'start' : 'end';
      svg.append(s('text', { x: cx, y: cy, 'text-anchor': anc, class: `big ${M.tone === 'bad' ? 'bad' : M.tone === 'ok' ? 'ok' : ''}` },
        `Δ ${f(M.d, 3)} mm${M.dPs != null ? ` · ${f(M.dPs, 3)} ps` : ''}`));
      svg.append(s('text', { x: cx, y: cy + 15, 'text-anchor': anc, class: 'soft small' },
        M.tol != null ? `limit ${f(M.tol, 3)} mm${M.tolPs != null ? ` · ${f(M.tolPs, 3)} ps` : ''}` : 'no tight limit for this interface'));
      if (fail) {
        const pts = tuneOn === 'P' ? Pp : Np;
        svg.append(s('path', { d: `M${x3 - 4},${pts[3][1]}l-8,-6v12z`, fill: 'var(--danger)' }));
      }
    } else if (!M.hasLen) {
      svg.append(s('text', { x: (x0 + x3) / 2, y: H - 14, 'text-anchor': 'middle', class: 'soft' }, 'Give the P and N lengths from your layout tool to check the pair'));
    }
    svg.append(s('text', { x: W - 8, y: H - 8, 'text-anchor': 'end', class: 'soft small' }, 'not to scale'));
    routeHost.replaceChildren(svg);
  };

  // ---------- the vernier: both trace ends, magnified ----------
  const drawVernier = (M) => {
    const W = Math.max(300, vernHost.clientWidth || 700), H = 124;
    const svg = s('svg', { class: 'dpm-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'group', 'aria-label': 'The two trace ends magnified against the tolerance band' });
    svg.append(s('rect', { x: 0, y: 0, width: W, height: H, fill: 'var(--sunken)' }));
    svg.append(s('line', { x1: 0, x2: W, y1: 0.5, y2: 0.5, stroke: 'var(--line-soft)' }));
    if (!M.hasLen || !M.one) {
      svg.append(s('text', { x: W / 2, y: H / 2 + 4, 'text-anchor': 'middle', class: 'soft' },
        M.one ? 'The trace ends appear here, magnified, once both lengths are given' : 'Pick one interface to check a pair'));
      vernHost.replaceChildren(svg); return;
    }
    const L = 70, Rr = 18;
    if (!vDom || !drag) {
      const c = (M.P + M.N) / 2;
      const hs = Math.max(M.tol != null ? M.tol * 2.2 : 0, Math.abs(M.P - M.N) * 0.75 + (M.tol || 0.05) * 0.6, 0.02);
      vDom = [c - hs, c + hs];
    }
    const [a, b] = vDom;
    const X = (v) => L + ((v - a) / (b - a)) * (W - L - Rr);
    const inv = (x) => a + ((x - L) / (W - L - Rr)) * (b - a);
    const yP = 34, yN = 62, yAx = 96;
    // tolerance band around P
    if (M.tol != null) {
      const x1 = clamp(X(M.P - M.tol), L, W - Rr), x2 = clamp(X(M.P + M.tol), L, W - Rr);
      svg.append(s('rect', { x: x1, y: yP - 12, width: Math.max(0, x2 - x1), height: yN - yP + 24, fill: 'var(--ok)', opacity: 0.14 }));
      for (const x of [x1, x2]) svg.append(s('line', { x1: x, x2: x, y1: yP - 12, y2: yN + 12, stroke: 'var(--ok)', 'stroke-dasharray': '3 2' }));
      const txt = W < 560 ? `± ${f(M.tol, 3)} mm` : `N ends in here: P ± ${f(M.tol, 3)} mm`, tw = txt.length * 6.2;
      const hit = (a0, a1, c) => a0 < c + 32 && a1 > c - 32;
      const xn = X(M.N), xp = X(M.P);
      const spots = [[x2 - 4 - tw, yN + 25, xn], [x1 + 4, yN + 25, xn], [x1 + 4, yP - 15, xp], [x2 - 4 - tw, yP - 15, xp]];
      const spot = spots.find(([x0, , c]) => !hit(x0, x0 + tw, c));
      if (spot) svg.append(s('text', { x: spot[0], y: spot[1], class: 'ok small' }, txt));
    }
    // ticks
    const span = b - a, raw = span / Math.max(2, Math.floor((W - L - Rr) / 90));
    const p10 = 10 ** Math.floor(Math.log10(raw)); let step = p10;
    for (const m of [1, 2, 5, 10]) if (m * p10 >= raw) { step = m * p10; break; }
    const dec = Math.max(0, -Math.floor(Math.log10(step)));
    svg.append(s('line', { x1: L, x2: W - Rr, y1: yAx, y2: yAx, stroke: 'var(--line)' }));
    for (let v = Math.ceil(a / step) * step; v <= b + 1e-12; v += step) {
      const x = X(v);
      svg.append(s('line', { x1: x, x2: x, y1: yAx, y2: yAx + 4, stroke: 'var(--ink-soft)' }));
      svg.append(s('text', { x, y: yAx + 16, 'text-anchor': 'middle', class: 'soft small' }, v.toFixed(dec)));
    }
    svg.append(s('text', { x: 8, y: yAx + 16, class: 'soft small' }, 'mm'));
    // the two trace ends
    const end = (who, len, y) => {
      const key = who === 'P' ? 'lenP' : 'lenN';
      const x = clamp(X(len), L - 4, W - Rr + 4);
      const col = `var(--tool-${who.toLowerCase()})`;
      svg.append(s('text', { x: 8, y: y + 4, class: who.toLowerCase() }, who));
      svg.append(s('line', { x1: 22, x2: x, y1: y, y2: y, stroke: col, 'stroke-width': 7, 'stroke-linecap': 'butt' }));
      svg.append(s('path', { d: `M22,${y - 6}l6,6l-6,6`, fill: 'none', stroke: 'var(--sunken)', 'stroke-width': 2 }));
      const hg = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'data-h': key, 'aria-label': `${who} length, mm`, 'aria-valuenow': f(len, 5),
        'aria-valuetext': `${f(len, 5)} mm` });
      hg.append(s('rect', { class: 'ring', x: x - 5, y: y - 11, width: 10, height: 22, rx: 2, fill: 'var(--surface)', stroke: col, 'stroke-width': 2 }));
      hg.append(s('line', { x1: x, x2: x, y1: y - 5, y2: y + 5, stroke: col, 'stroke-width': 1.5 }));
      hg.append(s('text', { x: clamp(x, 40, W - 40), y: who === 'P' ? y - 15 : y + 24, 'text-anchor': 'middle', class: who.toLowerCase() }, `${f(len, 5)}`));
      hg.addEventListener('pointerdown', (e) => {
        const box = svg.getBoundingClientRect(), sc = W / box.width;
        startDrag(e, { move: (ev) => setLen(key, inv((ev.clientX - box.left) * sc)) });
      });
      hg.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 0.01 : 0.001;
        const dir = ['ArrowRight', 'ArrowUp'].includes(e.key) ? 1 : ['ArrowLeft', 'ArrowDown'].includes(e.key) ? -1 : 0;
        if (dir) { e.preventDefault(); focusKey = key; setLen(key, len + dir * st); }
      });
      svg.append(hg);
    };
    end('P', M.P, yP); end('N', M.N, yN);
    // mismatch bracket
    if (M.d != null && M.d > 0) {
      const x1 = X(Math.min(M.P, M.N)), x2 = X(Math.max(M.P, M.N)), ym = (yP + yN) / 2;
      svg.append(s('path', { d: `M${x1},${ym - 4}v8M${x1},${ym}H${x2}M${x2},${ym - 4}v8`, stroke: M.tone === 'bad' ? 'var(--danger)' : 'var(--ink-soft)', fill: 'none' }));
    }
    vernHost.replaceChildren(svg);
  };

  // ---------- the edges at the receiver ----------
  const drawTiming = (M) => {
    const W = Math.max(280, timeHost.clientWidth || 340), H = 206;
    const svg = s('svg', { class: 'dpm-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
      'aria-label': 'P and N edges at the receiver, magnified, and the skew against one unit interval' });
    if (!M.one || !M.hasLen || M.dPs == null || !M.ui) {
      svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'soft' }, M.one ? 'Needs both lengths' : 'Pick one interface'));
      timeHost.replaceChildren(svg); timeSub.textContent = ''; return;
    }
    // The shorter line's edge arrives first (t = 0); the longer one skew later.
    const pLate = M.P >= M.N;
    const skew = M.dPs;
    const win = Math.max(skew * 4, (M.tolPs || 0) * 2.6, M.ui * 0.01);
    const tr = win * 1.4; // edges drawn schematically, steep enough to read in the magnified window
    const t0 = skew / 2 - win / 2;
    const L = 26, Rr = 30, yT = 16, yB = 112, yM = (yT + yB) / 2;
    const X = (t) => L + ((t - t0) / win) * (W - L - Rr);
    const edge = (tc, rising) => (t) => { const u = clamp((t - tc) / tr + 0.5, 0, 1); const y = yB + (yT - yB) * u; return rising ? y : yT + yB - y; };
    const pF = edge(pLate ? skew : 0, true), nF = edge(pLate ? 0 : skew, false);
    // allowed skew band from the first edge
    if (M.tolPs != null) {
      const x1 = clamp(X(0), L, W - Rr), x2 = clamp(X(M.tolPs), L, W - Rr);
      svg.append(s('rect', { x: x1, y: yT - 6, width: Math.max(0, x2 - x1), height: yB - yT + 12, fill: 'var(--ok)', opacity: 0.12 }));
      svg.append(s('line', { x1: x2, x2, y1: yT - 6, y2: yB + 6, stroke: 'var(--ok)', 'stroke-dasharray': '3 2' }));
      if (x2 < W - Rr - 2) svg.append(s('text', { x: x2 + 3, y: yT - 1, class: 'ok small' }, 'limit'));
    }
    svg.append(s('line', { x1: L, x2: W - Rr, y1: yM, y2: yM, stroke: 'var(--line)', 'stroke-dasharray': '2 3' }));
    const line = (fn, col) => {
      const a = fn(t0), b = fn(t0 + win);
      svg.append(s('path', { d: `M${L},${a.toFixed(1)}L${W - Rr},${b.toFixed(1)}`, stroke: col, 'stroke-width': 2.2, fill: 'none' }));
      return b;
    };
    const pe = line(pF, 'var(--tool-p)'), ne = line(nF, 'var(--tool-n)');
    svg.append(s('text', { x: W - Rr + 4, y: pe + 4, class: 'p small' }, 'P'));
    svg.append(s('text', { x: W - Rr + 4, y: ne + 4, class: 'n small' }, 'N'));
    // the two 50 % points and the skew between them
    const xa = X(0), xb = X(skew), bad = M.tone === 'bad';
    for (const [x, who] of [[pLate ? xb : xa, 'p'], [pLate ? xa : xb, 'n']]) {
      svg.append(s('line', { x1: x, x2: x, y1: yT - 2, y2: yB + 14, stroke: `var(--tool-${who})`, 'stroke-dasharray': '2 2', opacity: 0.8 }));
      svg.append(s('circle', { cx: x, cy: yM, r: 3.5, fill: `var(--tool-${who})` }));
    }
    svg.append(s('path', { d: `M${xa},${yB + 10}H${xb}`, stroke: bad ? 'var(--danger)' : 'var(--ink)', 'stroke-width': 2 }));
    const mid = (xa + xb) / 2;
    svg.append(s('text', { x: clamp(mid, L + 40, W - Rr - 40), y: yB + 26, 'text-anchor': 'middle', class: bad ? 'bad' : '' }, `${f(skew, 3)} ps`));
    // the unit interval, and where the magnified window sits in it
    const uy = 170, uL = 12, uR = W - 12, UX = (t) => uL + ((t + M.ui / 2) / M.ui) * (uR - uL);
    svg.append(s('rect', { x: uL, y: uy, width: uR - uL, height: 12, fill: 'var(--sunken)', stroke: 'var(--line)' }));
    const wx1 = UX(t0), wx2 = Math.max(UX(t0 + win), wx1 + 2);
    svg.append(s('path', { d: `M${L},${yB + 32}L${wx1},${uy}M${W - Rr},${yB + 32}L${wx2},${uy}`, stroke: 'var(--line)', fill: 'none' }));
    svg.append(s('rect', { x: wx1, y: uy, width: wx2 - wx1, height: 12, fill: bad ? 'var(--danger)' : 'var(--accent)', opacity: 0.7 }));
    svg.append(s('text', { x: uL, y: uy + 26, class: 'soft small' }, `one UI = ${f(M.ui, 4)} ps`));
    svg.append(s('text', { x: uR, y: uy + 26, 'text-anchor': 'end', class: 'soft small' }, `magnified: ${f(win, 3)} ps`));
    timeHost.replaceChildren(svg);
    timeSub.textContent = M.share != null ? `skew = ${f(M.share, 3)} % of one unit interval` : '';
  };

  // ---------- all interfaces: the ladder ----------
  const drawLadder = () => {
    const rows = R?.tables?.[0]?.rows || [];
    const W = Math.max(300, routeHost.clientWidth || 700);
    const narrow = W < 560;
    const rowH = 24, T = 30, H = T + Math.max(1, rows.length) * rowH + 30;
    const L = narrow ? 118 : 250, Rr = 14;
    const svg = s('svg', { class: 'dpm-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'group', 'aria-label': 'Intra-pair tolerance of each interface' });
    const lo = Math.log10(0.05), hi = Math.log10(3);
    const X = (mm) => L + ((Math.log10(clamp(mm, 0.05, 3)) - lo) / (hi - lo)) * (W - L - Rr);
    for (const t of [0.05, 0.1, 0.127, 0.254, 0.5, 1, 1.27, 2.54]) {
      const x = X(t);
      svg.append(s('line', { x1: x, x2: x, y1: T - 6, y2: H - 24, stroke: 'var(--line-soft)' }));
      if (!narrow || [0.1, 0.254, 1.27].includes(t)) svg.append(s('text', { x, y: H - 10, 'text-anchor': 'middle', class: 'soft small' }, String(t)));
    }
    svg.append(s('text', { x: W - Rr, y: 16, 'text-anchor': 'end', class: 'soft small' }, narrow ? 'P/N tolerance, mm (log)' : 'intra-pair P/N tolerance, mm (log) · thin bar: pair-to-pair'));
    if (!rows.length) svg.append(s('text', { x: W / 2, y: T + 16, 'text-anchor': 'middle', class: 'soft' }, 'Nothing matches the filter'));
    rows.forEach((r, i) => {
      const y = T + i * rowH, id = idOf(r[0]);
      const intra = /mm/.test(r[2]) ? num(r[2]) : null;
      const inter = /mm/.test(r[4]) ? num(r[4]) : null;
      const gEl = s('g', { class: 'rung', tabindex: 0, role: 'button', 'data-h': `rung-${id}`, 'aria-label': `${r[0]}: ${r[2]}; route it` });
      gEl.append(s('rect', { class: 'bg', x: 0, y, width: W, height: rowH, fill: 'transparent' }));
      const nm = narrow ? (GROUPS.flatMap((g) => g[1]).find((c) => c[0] === id)?.[1] || r[0]) : r[0].replace(/\s*\(.*\)$/, '');
      gEl.append(s('text', { x: 8, y: y + 16 }, nm));
      if (!narrow) gEl.append(s('text', { x: L - 8, y: y + 16, 'text-anchor': 'end', class: 'soft small' }, r[1].split(' (')[0]));
      if (intra != null) {
        gEl.append(s('rect', { x: L, y: y + 5, width: X(intra) - L, height: 10, fill: 'var(--tool-p)', opacity: 0.75, rx: 1 }));
        const lab = `${f(intra, 3)} mm${r[3] && r[3] !== '–' ? ` · ${r[3]}` : ''}`;
        const x = X(intra);
        const inside = x + 126 > W;
        gEl.append(s('text', { x: inside ? x - 6 : x + 6, y: y + 14, 'text-anchor': inside ? 'end' : 'start', class: 'small', style: inside ? 'fill:var(--surface)' : null }, lab));
      } else {
        gEl.append(s('rect', { x: L, y: y + 5, width: W - L - Rr, height: 10, fill: 'none', stroke: 'var(--line)', 'stroke-dasharray': '3 3' }));
        gEl.append(s('text', { x: L + 6, y: y + 14, class: 'soft small' }, 'not critical: a few mm is harmless'));
      }
      if (inter != null) gEl.append(s('rect', { x: L, y: y + 17, width: X(inter) - L, height: 3, fill: 'var(--tool-n)' }));
      const go = () => ctx.setMany({ iface: id, filter: '' });
      gEl.addEventListener('click', go);
      gEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const sib = [...svg.querySelectorAll('.rung')]; const k = sib.indexOf(gEl) + (e.key === 'ArrowDown' ? 1 : -1); sib[k]?.focus(); }
      });
      svg.append(gEl);
    });
    routeHost.replaceChildren(svg);
    vernHost.replaceChildren();
  };

  // ---------- readout ----------
  const drawRead = (M) => {
    readBody.replaceChildren();
    if (!M.one) {
      readBody.append(h('div', { class: 'dpm-sub2' }, `${R?.tables?.[0]?.rows?.length || 0} interfaces listed`),
        h('div', { class: 'dpm-note' }, 'Click an interface on the ladder (or a chip above) to route it and check your P and N lengths against it.'));
      return;
    }
    const ok = M.tone === 'ok', bad = M.tone === 'bad';
    if (M.hasLen && M.d != null) {
      readBody.append(h('div', { class: `dpm-big ${ok ? 'ok' : bad ? 'bad' : ''}` }, h('b', {}, f(M.d, 3), h('small', {}, ' mm')),
        h('span', { class: `verdict ${ok ? 'ok' : bad ? 'bad' : 'none'}` }, M.tol == null ? 'no tight limit' : ok ? 'within target' : 'over target')),
        h('div', { class: 'dpm-sub2' }, `${M.dPs != null ? `${f(M.dPs, 3)} ps` : ''}${M.share != null ? ` · ${f(M.share, 3)} % of UI` : ''}`));
    } else readBody.append(h('div', { class: 'dpm-sub2' }, 'Give both P and N lengths to check the pair.'));
    const inter = M.inter;
    readBody.append(h('dl', { class: 'dpm-kv' },
      h('dt', {}, 'Target P/N'), h('dd', {}, M.tol != null ? `≤ ${f(M.tol, 3)} mm` : 'not critical',
        M.tol != null ? h('small', {}, ` · ${f(M.tolMil, 3)} mil · ${f(M.tolPs, 3)} ps`) : null),
      h('dt', {}, 'Pair to pair'), h('dd', {}, inter ? String(inter.value) : '–', inter?.hint ? h('small', {}, ` · ${inter.hint}`) : null),
      h('dt', {}, 'Differential Z'), h('dd', {}, M.z || '–'),
      h('dt', {}, 'Delay'), h('dd', {}, M.psPerMm != null ? `${f(M.psPerMm, 3)} ps/mm` : '–', M.delayHint ? h('small', {}, ` · ${M.delayHint}`) : null),
      M.ui ? [h('dt', {}, 'Unit interval'), h('dd', {}, `${f(M.ui, 4)} ps`)] : null));
    if (M.row?.[5]) readBody.append(h('div', { class: 'dpm-note' }, M.row[5]));
  };

  const syncInputs = () => {
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(fields)) {
      if (document.activeElement !== el) el.value = raw[k] ?? '';
      const d = ctx.manifest.inputs.find((x) => x.key === k);
      const t = String(raw[k] ?? '').trim();
      el.classList.toggle('bad', d?.type === 'number' && t !== '' && ctx.parseEng(t) == null);
    }
    for (const [id, b] of Object.entries(chips)) b.setAttribute('aria-pressed', String(raw.iface === id));
    for (const [v, b] of Object.entries(layerBtns)) b.setAttribute('aria-pressed', String(raw.layer === v));
  };

  const draw = () => {
    if (!R) return;
    const M = model();
    syncInputs();
    const all = I.iface === 'all' || !M.one;
    const lbl = numField;
    headRight.replaceChildren();
    if (all) {
      title.textContent = 'Every interface';
      titleSub.textContent = 'P/N tolerance ladder · click a rung to route it';
      headRight.append(h('label', { class: 'dpm-filter' }, 'Filter', filterInp), layerSeg, fields.er ? fields.er.parentNode : lbl('er', 'εr', '', ''));
      drawLadder();
      stageHelp.innerHTML = 'Bars: the intra-pair (P to N) length tolerance layout guides give. Thin bar under it: the pair-to-pair tolerance where one applies. <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>Enter</kbd> picks.';
    } else {
      const row = M.row;
      title.textContent = row ? row[0] : '';
      titleSub.textContent = '';
      headRight.append(fields.lenP ? fields.lenP.parentNode : lbl('lenP', 'P', 'p', 'mm'), fields.lenN ? fields.lenN.parentNode : lbl('lenN', 'N', 'n', 'mm'),
        layerSeg, fields.er ? fields.er.parentNode : lbl('er', 'εr', '', ''));
      drawRoute(M); drawVernier(M);
      stageHelp.innerHTML = 'Pull the dashed meander on the shorter trace to add length, or focus it and press <kbd>Enter</kbd> to match. Drag either trace end in the magnified strip; <kbd>←</kbd> <kbd>→</kbd> step 0.001 mm, <kbd>Shift</kbd> 0.01 mm.';
      if (R.warnings?.some((w) => /filter|Nothing matches/.test(w)) || String(ctx.raw.filter || '').trim()) {
        titleSub.replaceChildren(h('button', { class: 'k-btn', type: 'button', onclick: () => ctx.set('filter', '') }, `filter "${ctx.raw.filter}" ×`));
      }
    }
    drawRead(M);
    timeCard.hidden = all;
    if (!all) drawTiming(M);
    warns.replaceChildren(...(R.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `How to read it (${(R.notes || []).length} notes)`), ...(R.notes || []).map((n) => h('div', {}, n)));
    if (focusKey) { const el = root.querySelector(`[data-h="${focusKey}"]`); if (el) el.focus(); focusKey = null; }
  };

  // make sure the numeric fields exist once, then move them between layouts
  numField('lenP', 'P', 'p', 'mm'); numField('lenN', 'N', 'n', 'mm'); numField('er', 'εr', '', '');

  ctx.onResult((res, input) => { R = res; I = input; draw(); });
  let lastW = 0;
  new ResizeObserver(() => { const w = routeHost.clientWidth; if (w !== lastW && !drag) { lastW = w; draw(); } }).observe(routeHost);
}
