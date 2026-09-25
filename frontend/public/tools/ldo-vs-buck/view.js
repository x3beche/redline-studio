// LDO vs Buck page: each option is drawn on the voltage-current plane, where
// area is power. The load is the rectangle Vout x Iout; what the input has to
// supply beyond it is heat, hatched: for the LDO a slab across the top (the
// whole voltage drop times the current), for the buck a sliver at the side of
// its taller, narrower input rectangle. Drag the Vin and Vout lines, the load
// edge, the LDO's dropout band and the buck's input edge (its efficiency);
// each part's junction temperature sits on a scale under it. All figures come
// from tool.js run().

const NS = 'http://www.w3.org/2000/svg';
const PKGS = [
  // id, name, θJA shown, body w x h (mm), leads: [side, count]
  ['sc70', 'SC-70', 250, 2.0, 1.25, 'sc70'],
  ['sot23-5', 'SOT-23-5', 180, 2.9, 1.6, 'sot23'],
  ['sot89', 'SOT-89', 110, 4.5, 2.5, 'sot89'],
  ['dfn2x2', 'DFN 2×2', 70, 2.0, 2.0, 'dfn'],
  ['sot223', 'SOT-223', 60, 6.5, 3.5, 'sot223'],
  ['dpak', 'DPAK', 40, 6.6, 6.1, 'dpak'],
];
const TJ_MAX = 125;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const PFX = { p: 1e-12, n: 1e-9, 'µ': 1e-6, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6 };
// "225 mA" -> 0.225, "142 °C" -> 142, "66 %" -> 66
const num = (t) => { const m = /(-?[\d.]+(?:e[-+]?\d+)?)\s*([pnµumkM]?)/.exec(String(t ?? '')); return m ? Number(m[1]) * (PFX[m[2]] ?? 1) : null; };
const r3 = (v) => String(Number(Number(v).toPrecision(3)));
const niceStep = (span, n) => { const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; };
const niceCeil = (v, n = 5) => { const st = niceStep(v, n); return Math.ceil(v / st - 1e-9) * st; };
const fmtV = (v) => `${r3(v)} V`;
const fmtA = (a) => (a >= 1 ? `${r3(a)} A` : `${r3(a * 1000)} mA`);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
function s(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}

function pkgIcon(kind) {
  const svg = s(null, 'svg', { viewBox: '0 0 40 30', 'aria-hidden': 'true' });
  const body = (x, y, w, hh) => s(svg, 'rect', { x, y, width: w, height: hh, rx: 1, class: 'pk-body' });
  const lead = (x, y, w, hh) => s(svg, 'rect', { x, y, width: w, height: hh, class: 'pk-lead' });
  if (kind === 'sc70') { body(15, 11, 10, 8); for (const x of [16, 22]) lead(x, 19, 2, 3); lead(19, 8, 2, 3); }
  if (kind === 'sot23') { body(12, 10, 16, 10); for (const x of [13, 19, 25]) lead(x, 20, 2.4, 4); for (const x of [13, 25]) lead(x, 6, 2.4, 4); }
  if (kind === 'sot89') { body(8, 9, 24, 13); lead(16, 3, 8, 6); for (const x of [10, 19, 28]) lead(x - 1, 22, 3, 5); }
  if (kind === 'dfn') { body(11, 6, 18, 18); s(svg, 'rect', { x: 15, y: 10, width: 10, height: 10, class: 'pk-lead' }); }
  if (kind === 'sot223') { body(4, 7, 32, 14); lead(12, 1, 16, 6); for (const x of [7, 18, 29]) lead(x, 21, 4, 6); }
  if (kind === 'dpak') { body(6, 3, 28, 20); lead(10, 1, 20, 3); for (const x of [11, 26]) lead(x, 23, 3, 6); }
  return svg;
}

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let res = null;
  let frozen = null;      // axes held still while dragging
  let refocus = null;

  // ---------- numeric fields (the typing path for every input) ----------
  const fields = {};
  const field = (key, label, unit, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', id: `lb-${key}`, 'aria-label': title || label,
      oninput: () => ctx.set(key, inp.value) });
    fields[key] = inp;
    return h('label', { class: 'lb-f', for: `lb-${key}`, title: title || null }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
  };
  const quietBtn = h('button', { type: 'button', class: 'lb-toggle', 'aria-pressed': 'false',
    title: 'ADC reference, RF, audio, PLL', onclick: () => ctx.set('quiet', !ctx.input.quiet) }, h('i', { 'aria-hidden': 'true' }), 'Noise-sensitive load');
  const top = h('div', { class: 'lb-top' },
    h('div', { class: 'lb-rail' },
      field('vin', 'Vin', 'V', 'Input voltage'), h('span', { class: 'lb-arrow', 'aria-hidden': 'true' }, '→'),
      field('vout', 'Vout', 'V', 'Output voltage'), field('iout', 'Load', 'A', 'Load current (300m = 300 mA)'),
      field('ta', 'Ambient', '°C', 'Ambient temperature')),
    quietBtn,
    h('span', { class: 'lb-tip' }, 'Area is power · drag the Vin and Vout lines, the load edge, the dropout band and the buck input edge'));

  // ---------- the three options ----------
  const mk = (id, name) => {
    const svg = s(null, 'svg', { class: 'lb-vi', role: 'group', 'aria-label': `${name} on the voltage-current plane` });
    const therm = s(null, 'svg', { class: 'lb-therm', role: 'group', 'aria-label': `${name} junction temperature` });
    const scope = s(null, 'svg', { class: 'lb-scope', role: 'group', 'aria-label': `${name} output noise` });
    const head = h('div', { class: 'lb-head' });
    const foot = h('div', { class: 'lb-foot' });
    const card = h('section', { class: 'lb-opt', 'data-o': id }, head, h('div', { class: 'lb-vibox' }, svg),
      h('div', { class: 'lb-row' }, h('span', { class: 'lb-cap' }, 'Junction'), therm),
      h('div', { class: 'lb-row' }, h('span', { class: 'lb-cap' }, 'Output'), scope), foot);
    return { id, name, svg, therm, scope, head, foot, card };
  };
  const O = [mk('ldo', 'LDO'), mk('buck', 'Buck'), mk('both', 'Buck + LDO')];

  // LDO foot: package footprints, dropout, Iq
  const pkgs = h('div', { class: 'lb-pkgs', role: 'radiogroup', 'aria-label': 'LDO package' });
  for (const [id, name, th, , , kind] of PKGS) {
    const b = h('button', { type: 'button', role: 'radio', 'data-v': id, title: `${name}, θJA ≈ ${th} °C/W`,
      onclick: () => ctx.set('pkg', id),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const i = clamp(PKGS.findIndex((p) => p[0] === id) + d, 0, PKGS.length - 1);
        ctx.set('pkg', PKGS[i][0]);
        requestAnimationFrame(() => pkgs.querySelector(`[data-v="${PKGS[i][0]}"]`)?.focus());
      } }, pkgIcon(kind), h('b', {}, name), h('small', {}, `${th} °C/W`));
    pkgs.append(b);
  }
  O[0].foot.append(pkgs, h('div', { class: 'lb-fs' }, field('dropout', 'Dropout', 'mV'), field('iq', 'Iq', 'µA', 'LDO quiescent current')));
  O[1].foot.append(h('div', { class: 'lb-fs' }, field('eff', 'η', '%', 'Buck efficiency at this load, from its datasheet curve'), field('ripple', 'Ripple', 'mV p-p', 'Buck output ripple')),
    h('p', { class: 'lb-small' }, 'Efficiency from the datasheet curve at this Vin, Vout and load. Heat: 70 % of the loss in the IC at θJA 50 °C/W.'));
  const bothNote = h('p', { class: 'lb-small' });
  O[2].foot.append(bothNote);

  const opts = h('div', { class: 'lb-opts' }, ...O.map((o) => o.card));

  // ---------- below: verdict, curve, outputs ----------
  const verdict = h('div', { class: 'lb-verdict', 'aria-live': 'polite' });
  const warns = h('div', { class: 'lb-warns', role: 'status' });
  const curve = s(null, 'svg', { class: 'lb-curve', role: 'img', 'aria-label': 'Efficiency against load current' });
  const curveCard = h('section', { class: 'lb-card' }, h('div', { class: 'lb-cardhead' }, h('b', {}, 'Efficiency against load'), h('span', { class: 'lb-legend' },
    h('i', { class: 'c-ldo' }), 'LDO', h('i', { class: 'c-buck' }), 'Buck, auto PFM (model)')), curve);
  const notes = h('details', { class: 'lb-notes' });
  const below = h('div', { class: 'lb-below' }, h('div', { class: 'lb-col' }, warns, curveCard, notes), ctx.outputs);

  root.append(h('div', { class: 'lb' }, top, verdict, opts, below));

  // ---------- reading the result ----------
  function R() {
    const rows = res?.tables?.[0]?.rows || [];
    const vals = res?.values || [];
    const by = (re) => vals.find((v) => re.test(v.label));
    const row = (i) => rows[i] ? { eff: num(rows[i][1]), iin: num(rows[i][2]), pd: num(rows[i][3]), tj: num(rows[i][4]),
      effT: rows[i][1], iinT: rows[i][2], pdT: rows[i][3], tjT: rows[i][4], noise: rows[i][5], parts: rows[i][6], name: rows[i][0] } : null;
    const both = row(2);
    return {
      ok: rows.length === 3, ldo: row(0), buck: row(1), both,
      vmid: both ? num(/to ([\d.]+) V/.exec(both.name)?.[1]) : null,
      pick: by(/^Recommended/), saved: by(/^Heat saved/), ldoD: by(/^LDO dissipation/), buckD: by(/^Buck dissipation/),
    };
  }
  const warnAbout = (re) => (res?.warnings || []).some((w) => re.test(w));

  // ---------- V-I plane ----------
  function axes(inp, r) {
    if (frozen) return frozen;
    const vmax = niceCeil(Math.max(inp.vin || 5, inp.vout || 3.3) * 1.18, 5);
    const imax = niceCeil(Math.max(inp.iout || 0.3, r.ldo?.iin || 0, r.buck?.iin || 0) * 1.28, 4);
    return { vmax, imax };
  }

  function drawVI(o, r, inp, ax) {
    const svg = o.svg;
    svg.replaceChildren();
    const box = svg.parentNode;
    const W = Math.max(240, box.clientWidth), H = Math.max(200, box.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 46, Rm = 14, T = 12, B = 30;
    const X = (a) => L + (a / ax.imax) * (W - L - Rm);
    const Y = (v) => H - B - (v / ax.vmax) * (H - T - B);
    const defs = s(svg, 'defs');
    const pat = s(defs, 'pattern', { id: `lb-hatch-${o.id}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    s(pat, 'rect', { width: 6, height: 6, class: 'lb-heatbg' });
    s(pat, 'line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'lb-heatline' });

    // grid
    const g = s(svg, 'g', { class: 'lb-grid' });
    const vs = niceStep(ax.vmax, 5), is = niceStep(ax.imax, 4);
    for (let v = 0; v <= ax.vmax + 1e-9; v += vs) { s(g, 'line', { x1: L, x2: W - Rm, y1: Y(v), y2: Y(v) }); s(svg, 'text', { x: L - 6, y: Y(v) + 3.5, class: 'lb-tick', 'text-anchor': 'end' }, r3(v)); }
    for (let a = 0; a <= ax.imax + 1e-9; a += is) { s(g, 'line', { x1: X(a), x2: X(a), y1: T, y2: H - B }); s(svg, 'text', { x: X(a), y: H - B + 14, class: 'lb-tick', 'text-anchor': 'middle' }, a >= 1 || is >= 1 ? r3(a) : r3(a * 1000)); }
    s(svg, 'text', { x: W - Rm, y: H - 4, class: 'lb-axl', 'text-anchor': 'end' }, is >= 1 ? 'current, A' : 'current, mA');
    s(svg, 'text', { x: 6, y: T + 2, class: 'lb-axl', 'dominant-baseline': 'hanging' }, 'V');

    if (!r.ok) {
      s(svg, 'text', { x: (L + W) / 2, y: (T + H) / 2, class: 'lb-empty', 'text-anchor': 'middle' }, inp.vout >= inp.vin ? 'step-up: needs a boost' : 'give Vin, Vout and the load');
      return;
    }
    const vin = inp.vin, vout = inp.vout, iout = inp.iout, pout = vout * iout;
    const load = (clear = iout) => {   // clear: the label stays left of this current
      s(svg, 'rect', { x: X(0), y: Y(vout), width: X(iout) - X(0), height: Y(0) - Y(vout), class: 'lb-load' });
      const span = Math.min(iout, clear);
      const big = X(span) - X(0) > 76 && Y(0) - Y(vout) > 36;
      if (big) {
        s(svg, 'text', { x: X(span / 2), y: Y(vout / 2) - 2, class: 'lb-in-lab', 'text-anchor': 'middle' }, 'to the load');
        s(svg, 'text', { x: X(span / 2), y: Y(vout / 2) + 13, class: 'lb-in-val', 'text-anchor': 'middle' }, `${r3(pout)} W`);
      }
    };
    const heat = (x0, v0, x1, v1, label, value) => {
      s(svg, 'rect', { x: X(x0), y: Y(v1), width: Math.max(1.5, X(x1) - X(x0)), height: Y(v0) - Y(v1), fill: `url(#lb-hatch-${o.id})`, class: 'lb-heat' });
      return { cx: X((x0 + x1) / 2), cy: Y((v0 + v1) / 2), w: X(x1) - X(x0), h: Y(v0) - Y(v1), label, value };
    };
    const inputRect = (iin, vtop) => s(svg, 'rect', { x: X(0), y: Y(vtop), width: X(iin) - X(0), height: Y(0) - Y(vtop), class: 'lb-input' });
    const heatLabel = (hz, side) => {
      if (!hz) return;
      if (hz.w > 80 && hz.h > 30) {
        s(svg, 'text', { x: hz.cx, y: hz.cy - 1, class: 'lb-heat-lab', 'text-anchor': 'middle' }, hz.label);
        s(svg, 'text', { x: hz.cx, y: hz.cy + 14, class: 'lb-heat-val', 'text-anchor': 'middle' }, hz.value);
      } else {
        const x = side === 'right' ? hz.cx + hz.w / 2 + 8 : hz.cx;
        const tx = s(svg, 'text', { x, y: hz.cy - 4, class: 'lb-heat-val' }, hz.value);
        s(svg, 'text', { x, y: hz.cy + 10, class: 'lb-heat-lab sm' }, hz.label);
        void tx;
      }
    };

    let hz = null, hz2 = null;
    if (o.id === 'ldo') {
      inputRect(r.ldo.iin, vin);
      load();
      hz = heat(0, vout, iout, vin, 'heat in the LDO', r.ldo.pdT);
      // dropout band just above Vout
      const vdo = (inp.dropout > 0 ? inp.dropout : 250) / 1000;
      const bad = warnAbout(/will not regulate/);
      s(svg, 'rect', { x: X(0), y: Y(vout + vdo), width: X(ax.imax) - X(0), height: Y(vout) - Y(vout + vdo), class: `lb-drop${bad ? ' bad' : ''}` });
      handle(svg, 'dropout', X(ax.imax) - 4, Y(vout + vdo), 'h', `dropout ${r3(vdo * 1000)} mV`, 'end',
        (pt) => ({ dropout: r3(clamp((Yinv(pt.y) - vout) * 1000, 10, 3000)) }), (d, big) => ({ dropout: r3(clamp((inp.dropout || 250) + d * (big ? 100 : 10), 10, 3000)) }));
      if (bad) s(svg, 'text', { x: X(ax.imax) - 8, y: Y(vout + vdo) - 6, class: 'lb-bad', 'text-anchor': 'end' }, 'Vin inside the dropout: no regulation');
    } else if (o.id === 'buck') {
      const ideal = pout / vin;
      inputRect(r.buck.iin, vin);
      load(ideal);
      hz = heat(ideal, 0, r.buck.iin, vin, 'loss', r.buck.pdT);
      // the input edge sets the efficiency
      handle(svg, 'eff', X(r.buck.iin), Y(vin) + 16, 'v', `Iin ${r.buck.iinT} · η ${r3(inp.eff)} %`, 'start',
        (pt) => { const iin = Math.max(ideal * 1.005, Xinv(pt.x)); return { eff: r3(clamp((100 * pout) / (vin * iin), 30, 99.5)) }; },
        (d, big) => ({ eff: r3(clamp((inp.eff || 88) - d * (big ? 5 : 0.5), 30, 99.5)) }));
    } else {
      const vmid = r.vmid ?? vout;
      const ideal = pout / vin;
      inputRect(r.both.iin, vin);
      load(ideal + (vmid - vout) * iout / vin);
      // LDO slab from Vout to Vmid over the load, buck loss beside the input
      hz2 = heat(0, vout, iout, vmid, 'LDO', '');
      const bl = heat(ideal + (vmid - vout) * iout / vin, 0, r.both.iin, vin, 'buck loss', '');
      s(svg, 'line', { x1: X(0), x2: X(ax.imax), y1: Y(vmid), y2: Y(vmid), class: 'lb-mid' });
      s(svg, 'text', { x: X(ax.imax) - 4, y: Y(vmid) - 4, class: 'lb-midtxt', 'text-anchor': 'end' }, `buck makes ${r3(vmid)} V`);
      hz = { ...bl, label: 'total loss', value: r.both.pdT };
      void hz2;
    }
    heatLabel(hz, o.id === 'ldo' ? 'in' : 'right');

    // Vin, Vout lines and the load edge: shared by all three, draggable in any
    s(svg, 'line', { x1: L, x2: W - Rm, y1: Y(vin), y2: Y(vin), class: 'lb-vin' });
    s(svg, 'line', { x1: L, x2: W - Rm, y1: Y(vout), y2: Y(vout), class: 'lb-vout' });
    s(svg, 'line', { x1: X(iout), x2: X(iout), y1: Y(0), y2: Y(vout) - 1, class: 'lb-iedge' });
    handle(svg, 'vin', L + 2, Y(vin), 'h', `Vin ${fmtV(vin)}`, 'start',
      (pt) => ({ vin: r3(clamp(Yinv(pt.y), 0.5, 60)) }), (d, big) => ({ vin: r3(clamp(vin + d * (big ? 1 : 0.1), 0.5, 60)) }));
    handle(svg, 'vout', L + 2, Y(vout), 'h', `Vout ${fmtV(vout)}`, 'start',
      (pt) => ({ vout: r3(clamp(Yinv(pt.y), 0.3, 60)) }), (d, big) => ({ vout: r3(clamp(vout + d * (big ? 0.5 : 0.05), 0.3, 60)) }));
    handle(svg, 'iout', X(iout), Y(0) - 12, 'v', `load ${fmtA(iout)}`, 'start',
      (pt) => ({ iout: r3(clamp(Xinv(pt.x), 1e-3, 20)) }), (d, big) => ({ iout: r3(clamp(iout + d * (big ? 0.1 : 0.01) * Math.max(1, ax.imax), 1e-3, 20)) }));

    function Yinv(y) { return ((H - B - y) / (H - T - B)) * ax.vmax; }
    function Xinv(x) { return ((x - L) / (W - L - Rm)) * ax.imax; }
  }

  // A draggable handle: 'h' moves up and down (a voltage), 'v' left and right (a current).
  function handle(svg, key, x, y, dir, label, anchor, fromPoint, fromKey) {
    const g = s(svg, 'g', { class: `lb-h h-${key}`, tabindex: 0, role: 'slider', 'aria-label': label, 'data-k': key });
    const w = label.length * 6.75 + 22;
    const bx = anchor === 'end' ? x - w : x;
    if (dir === 'h') s(g, 'rect', { x: bx - 4, y: y - 10, width: w + 8, height: 20, class: 'lb-hhit' });
    else s(g, 'rect', { x: Math.min(x - 10, (svg.viewBox.baseVal?.width || 9999) - w - 20), y: y - 10, width: w + 20, height: 20, class: 'lb-hhit' });
    const VW = svg.viewBox.baseVal?.width || 9999;
    const tx = dir === 'h' ? bx : (x + 6 + w > VW - 2 ? x - 6 - w : x + 6);
    s(g, 'rect', { x: tx, y: y - 9, width: w, height: 18, rx: 3, class: 'lb-hbox' });
    s(g, 'text', { x: tx + 8, y: y + 4, class: 'lb-htxt' }, `${dir === 'h' ? '↕' : '↔'} ${label}`);
    if (dir === 'v') s(g, 'circle', { cx: x, cy: y, r: 4.5, class: 'lb-hdot' });
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      capture(g, e);
      frozen = axes(ctx.input, R());
      const pt = svg.createSVGPoint();
      const move = (ev) => {
        pt.x = ev.clientX; pt.y = ev.clientY;
        const p = pt.matrixTransform(svg.getScreenCTM().inverse());
        ctx.setMany(fromPoint(p));
      };
      const up = () => { frozen = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); draw(); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    g.addEventListener('keydown', (e) => {
      const d = dir === 'h' ? { ArrowUp: 1, ArrowDown: -1 }[e.key] : { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      refocus = { key, o: svg.closest('.lb-opt')?.dataset.o };
      ctx.setMany(fromKey(d, e.shiftKey));
    });
  }

  // ---------- thermometer ----------
  function drawTherm(o, tj, pdT, inp, hint) {
    const svg = o.therm;
    svg.replaceChildren();
    const W = Math.max(200, svg.parentNode.clientWidth - 70), H = 34;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const lo = Math.min(0, Math.floor(((inp.ta ?? 25) - 10) / 25) * 25), hi = Math.max(175, Math.ceil(((tj || 0) + 10) / 25) * 25);
    const X = (t) => 6 + ((t - lo) / (hi - lo)) * (W - 12);
    s(svg, 'rect', { x: X(lo), y: 12, width: X(hi) - X(lo), height: 8, rx: 2, class: 'lb-tbg' });
    s(svg, 'rect', { x: X(100), y: 12, width: X(TJ_MAX) - X(100), height: 8, class: 'lb-twarn' });
    s(svg, 'rect', { x: X(TJ_MAX), y: 12, width: X(hi) - X(TJ_MAX), height: 8, class: 'lb-tbad' });
    const tstep = Math.max(25, Math.ceil((hi - lo) / Math.max(3, Math.floor(W / 34)) / 25) * 25);
    for (let t = lo; t <= hi; t += tstep) s(svg, 'text', { x: X(t), y: 32, class: 'lb-tt', 'text-anchor': 'middle' }, String(t));
    if (!(tj != null)) return;
    const ta = inp.ta ?? 25;
    const tone = tj > TJ_MAX ? 'bad' : tj > 100 ? 'warn' : 'ok';
    s(svg, 'rect', { x: X(ta), y: 13, width: Math.max(0, X(tj) - X(ta)), height: 6, class: `lb-trise t-${tone}` });
    // ambient: draggable
    const g = s(svg, 'g', { class: 'lb-h lb-ta', tabindex: 0, role: 'slider', 'aria-label': `Ambient ${r3(ta)} °C`, 'data-k': 'ta' });
    s(g, 'rect', { x: X(ta) - 8, y: 4, width: 16, height: 24, class: 'lb-hhit' });
    s(g, 'path', { d: `M${X(ta) - 4},6 L${X(ta) + 4},6 L${X(ta)},12 z`, class: 'lb-tamark' });
    s(g, 'line', { x1: X(ta), x2: X(ta), y1: 11, y2: 21, class: 'lb-taline' });
    s(svg, 'line', { x1: X(tj), x2: X(tj), y1: 8, y2: 24, class: `lb-tjline t-${tone}` });
    const lab = `Tj ${r3(tj)} °C · ${pdT}`;
    const right = X(tj) + lab.length * 6.2 + 8 < W;
    s(svg, 'text', { x: right ? X(tj) + 5 : X(tj) - 5, y: 9, class: `lb-tjtxt t-${tone}`, 'text-anchor': right ? 'start' : 'end' }, lab);
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault(); capture(g, e);
      const pt = svg.createSVGPoint();
      const move = (ev) => { pt.x = ev.clientX; pt.y = ev.clientY; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); ctx.set('ta', r3(Math.round(clamp(lo + ((p.x - 6) / (W - 12)) * (hi - lo), -40, 125)))); };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    g.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return; e.preventDefault();
      refocus = { key: 'ta', o: o.id, therm: true };
      ctx.set('ta', r3(clamp(ta + d * (e.shiftKey ? 10 : 1), -40, 125)));
    });
    void hint;
  }

  // ---------- scope: what the output looks like ----------
  function drawScope(o, inp, text) {
    const svg = o.scope;
    svg.replaceChildren();
    const W = Math.max(200, svg.parentNode.clientWidth - 70), H = 40, mid = 20;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    s(svg, 'line', { x1: 0, x2: W, y1: mid, y2: mid, class: 'lb-sref' });
    const rip = inp.ripple > 0 ? inp.ripple : 10;
    const amp = o.id === 'buck' ? clamp(3 + rip * 0.6, 3, 15) : o.id === 'both' ? clamp(rip * 0.04, 0.6, 2) : 0.8;
    let d = '';
    const n = 180, per = 22;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * (W * 0.62);
      let y = mid;
      if (o.id === 'ldo') y += rnd() * 1.6;
      else {
        const ph = (i % per) / per;
        const tri = ph < 0.5 ? ph * 4 - 1 : 3 - ph * 4;
        y -= tri * amp;
        if (o.id === 'buck' && i % per === 0) y -= amp * 1.1;         // switching spike
        y += rnd() * (o.id === 'both' ? 1.2 : 0.8);
      }
      d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    s(svg, 'path', { d, class: `lb-trace s-${o.id}` });
    const short = o.id === 'ldo' ? String(text || '').split(' (')[0] + ' noise' : o.id === 'buck' ? `${r3(rip)} mV p-p ripple + spikes` : 'ripple cut by the LDO';
    s(svg, 'text', { x: W * 0.62 + 8, y: mid + 4, class: 'lb-stxt' }, W < 300 ? short.replace(' + spikes', '').replace(' (10 Hz-100 kHz)', '').replace('ripple cut by the LDO', 'PSRR-cut ripple') : short);
    if (o.id === 'buck') {
      const g = s(svg, 'g', { class: 'lb-h', tabindex: 0, role: 'slider', 'aria-label': `Buck ripple ${r3(rip)} mV p-p`, 'data-k': 'ripple' });
      s(g, 'rect', { x: 0, y: 0, width: W * 0.62, height: H, class: 'lb-hhit' });
      s(g, 'line', { x1: 0, x2: W * 0.62, y1: mid - amp, y2: mid - amp, class: 'lb-ripline' });
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault(); capture(g, e);
        const pt = svg.createSVGPoint();
        const move = (ev) => { pt.x = ev.clientX; pt.y = ev.clientY; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); const a = clamp(Math.abs(mid - p.y), 3, 15); ctx.set('ripple', r3(Math.max(1, Math.round((a - 3) / 0.6)))); };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      g.addEventListener('keydown', (e) => {
        const d2 = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
        if (!d2) return; e.preventDefault();
        refocus = { key: 'ripple', o: 'buck', scope: true };
        ctx.set('ripple', r3(clamp(rip + d2 * (e.shiftKey ? 10 : 1), 1, 500)));
      });
    }
  }

  // ---------- efficiency curve ----------
  function drawCurve() {
    curve.replaceChildren();
    const ch = res?.charts?.[0];
    if (!ch) return;
    const W = Math.max(260, curve.parentNode.clientWidth - 22), H = 150, L = 34, Rm = 10, T = 8, B = 22;
    curve.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const n = ch.x.length;
    const X = (i) => L + (i / (n - 1)) * (W - L - Rm);
    const Y = (v) => H - B - (v / 100) * (H - T - B);
    for (const v of [0, 25, 50, 75, 100]) { s(curve, 'line', { x1: L, x2: W - Rm, y1: Y(v), y2: Y(v), class: 'lb-cgrid' }); s(curve, 'text', { x: L - 5, y: Y(v) + 3, class: 'lb-tick', 'text-anchor': 'end' }, `${v}`); }
    ch.x.forEach((x, i) => s(curve, 'text', { x: X(i), y: H - 6, class: 'lb-tick', 'text-anchor': 'middle' }, x));
    ch.series.forEach((se, k) => {
      s(curve, 'path', { d: se.y.map((v, i) => `${i ? 'L' : 'M'}${X(i)},${Y(v)}`).join(''), class: `lb-cline ${k ? 'c-buck' : 'c-ldo'}` });
      se.y.forEach((v, i) => s(curve, 'circle', { cx: X(i), cy: Y(v), r: i === n - 1 ? 4 : 2.2, class: `lb-cdot ${k ? 'c-buck' : 'c-ldo'}` }));
      s(curve, 'text', { x: X(n - 1) - 8, y: Y(se.y[n - 1]) + (k ? -7 : 13), class: `lb-cval ${k ? 'c-buck' : 'c-ldo'}`, 'text-anchor': 'end' }, `${se.y[n - 1]} %`);
    });
  }

  // ---------- everything ----------
  function draw() {
    const inp = ctx.input, r = R(), ax = axes(inp, r);
    const pick = r.pick?.value;
    const pickId = pick === 'LDO' ? 'ldo' : pick === 'Buck' ? 'buck' : pick === 'Buck + LDO' ? 'both' : null;
    for (const o of O) {
      const row = o.id === 'ldo' ? r.ldo : o.id === 'buck' ? r.buck : r.both;
      o.card.classList.toggle('pick', o.id === pickId);
      const hot = row && row.tj > TJ_MAX;
      o.card.classList.toggle('hot', !!hot);
      o.head.replaceChildren(...[
        h('b', {}, o.id === 'both' && r.vmid ? `Buck → ${r3(r.vmid)} V → LDO` : o.name),
        o.id === pickId ? h('span', { class: 'lb-pickchip' }, 'Recommended') : null,
        row ? h('span', { class: 'lb-eff' }, h('small', {}, 'η'), ` ${row.effT}`) : null,
        row ? h('span', { class: 'lb-sub' }, `Iin ${row.iinT} · ${row.parts}`) : null].filter(Boolean));
      drawVI(o, r, inp, ax);
      drawTherm(o, row?.tj, row?.pdT, inp, o.id === 'ldo' ? r.ldoD?.hint : r.buckD?.hint);
      drawScope(o, inp, row?.noise);
    }
    bothNote.textContent = r.vmid ? `The buck makes ${r3(r.vmid)} V (Vout + dropout + 150 mV); the LDO after it cleans the ripple. Same buck efficiency assumed at the lower voltage.` : '';
    verdict.replaceChildren();
    if (r.pick) verdict.append(h('span', { class: 'lb-vcap' }, 'Pick'), h('b', {}, r.pick.value), h('span', {}, ` because ${r.pick.hint}.`),
      r.saved ? h('span', { class: 'lb-saved' }, ` The buck saves ${r.saved.value} of heat.`) : null);
    verdict.hidden = !r.pick;
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res?.warnings || []).length;
    const ns = res?.notes || [];
    notes.replaceChildren(h('summary', {}, `How it is worked out (${ns.length})`), ...ns.map((t) => h('p', {}, t)));
    notes.hidden = !ns.length;
    drawCurve();
    // keep the field text as typed, unless the field is being edited
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(fields)) if (document.activeElement !== el) el.value = raw[k] ?? '';
    for (const b of pkgs.children) { const on = b.dataset.v === raw.pkg; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    quietBtn.setAttribute('aria-pressed', String(!!inp.quiet));
    if (refocus) {
      const f = refocus; refocus = null;
      const card = opts.querySelector(`.lb-opt[data-o="${f.o}"]`);
      card?.querySelector(`.lb-h[data-k="${f.key}"]`)?.focus();
    }
  }

  ctx.onResult((r) => { res = r; draw(); });
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }).observe(opts);
}
