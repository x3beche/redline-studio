// ESD Protection Selector: the page is the protected line itself.
//   Path    - the signal from the connector pin to the IC pin, the TVS drawn
//             at the connector with its polarity, the strike coming in, the
//             stand-off, capacitance and clamp targets written on the parts.
//   Window  - the TVS's V-I plane. The line's normal swing is a band the
//             diode must stay out of (VRWM), the protected pin's absolute
//             maximum a wall; the clamp at the IEC test current has to land
//             in the window between them. Drag the line's top voltage and the
//             pin's absolute maximum; click a level on the current axis.
//   Map     - every interface placed by the capacitance its speed allows
//             (across) and the stand-off it needs (up). Click one to pick it;
//             the text filter dims the others.
//   Pulse   - the IEC 61000-4-2 contact-discharge current for the level.
// Every number shown comes from run()'s result.esd; the curve of "a part
// that fits" is a shape, drawn without numbers.

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
const sv = (parent, tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f = (v, d = 3) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(d))));
const niceStep = (span, n) => {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const capTxt = (c) => (c >= 1000 ? 'not critical' : `≤ ${f(c)} pF`);

const SHORT = {
  gpio: 'GPIO', i2c: 'I2C', uart: 'UART / SPI', rs232: 'RS-232', rs485: 'RS-485', can: 'CAN', canfd: 'CAN FD', lin: 'LIN',
  usb2fs: 'USB FS', usb2hs: 'USB 2 HS', usb3: 'USB 3', usbccc: 'USB-C CC', vbus5: 'VBUS 5 V', vbuspd: 'VBUS PD',
  hdmi14: 'HDMI 1.4', hdmi20: 'HDMI 2 / DP', lvds: 'LVDS', eth100: 'Eth 100', eth1g: 'Eth 1G', sd: 'SD card', sim: 'SIM',
  audio: 'Audio', rf: 'RF feed', dc12: '12 V in', dc24: '24 V in',
};

// A box whose SVG fills it and never sizes it; redraws when it changes size.
function svgBox(cls, label, draw) {
  const svg = sv(null, 'svg', { role: 'group', 'aria-label': label });
  const box = h('div', { class: `esd-box ${cls}` }, svg);
  let last = '';
  new ResizeObserver(() => {
    const key = `${box.clientWidth}x${box.clientHeight}`;
    if (key !== last) { last = key; draw(); }
  }).observe(box);
  return { svg, box, size: () => [Math.max(200, box.clientWidth), Math.max(120, box.clientHeight)] };
}

export function page(root, ctx) {
  let E = null, res = null, focusKey = null;
  const IFACES = ctx.manifest.inputs.find((d) => d.key === 'iface').options;
  const NAMES = Object.fromEntries(IFACES);

  // ---------- top bar ----------
  const sel = h('select', { 'aria-label': 'Interface', onchange: (e) => ctx.set('iface', e.target.value) },
    IFACES.map(([v, t]) => h('option', { value: v }, t)));
  const filt = h('input', { type: 'search', spellcheck: 'false', placeholder: 'usb, can, eth…', 'aria-label': 'Filter the interfaces',
    oninput: (e) => ctx.set('filter', e.target.value) });
  const num = (key, label, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title,
      oninput: (e) => ctx.set(key, e.target.value.trim()) });
    const w = h('label', { class: 'esd-num', title }, h('span', {}, label), inp, h('small', {}, 'V'));
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    w.inp = inp;
    return w;
  };
  const vlineF = num('vline', 'Line max', 'Highest line voltage in normal use; empty = the interface\'s usual level');
  const absF = num('absmax', 'Pin abs max', 'The protected pin\'s absolute maximum from the IC datasheet; empty = not known');
  const top = h('div', { class: 'esd-top' },
    h('label', { class: 'esd-pick' }, h('span', {}, 'Interface'), sel),
    h('label', { class: 'esd-pick esd-filter' }, h('span', {}, 'Filter'), filt),
    h('div', { class: 'esd-grow' }), vlineF, absF);

  // ---------- panels ----------
  const path = svgBox('esd-pathbox', 'Signal path from connector to IC with the TVS', () => drawPath());
  const iv = svgBox('esd-ivbox', 'TVS voltage-current window', () => drawIV());
  const map = svgBox('esd-mapbox', 'Interfaces by capacitance and stand-off voltage', () => drawMap());
  const pulse = svgBox('esd-pulsebox', 'IEC 61000-4-2 contact discharge current', () => drawPulse());
  const ivWarn = h('div', { class: 'esd-warns', 'aria-live': 'polite' });
  const ivHead = h('div', { class: 'esd-head' }, h('h2', {}, 'Clamp window'), h('span', { class: 'esd-sub' }, ''));
  const mapHead = h('div', { class: 'esd-head' }, h('h2', {}, 'Interfaces'), h('span', { class: 'esd-sub' }, 'capacitance its speed allows × stand-off it needs · click one'));
  const lvlSeg = h('div', { class: 'esd-seg', role: 'radiogroup', 'aria-label': 'IEC 61000-4-2 level' });
  const pulseHead = h('div', { class: 'esd-head' }, h('h2', {}, 'IEC 61000-4-2'), h('span', { class: 'esd-sub' }, 'contact'), h('div', { class: 'esd-grow' }), lvlSeg);
  const facts = h('div', { class: 'esd-facts' });

  const pPath = h('section', { class: 'esd-panel esd-path' }, path.box);
  const pIV = h('section', { class: 'esd-panel esd-iv' }, ivHead, iv.box, ivWarn);
  const pMap = h('section', { class: 'esd-panel esd-map' }, mapHead, map.box);
  const pPulse = h('section', { class: 'esd-panel esd-pulse' }, pulseHead, pulse.box);
  const pFacts = h('section', { class: 'esd-panel esd-parts' }, facts);
  const side = h('div', { class: 'esd-side' }, pPulse, pFacts, ctx.outputs);
  root.append(h('div', { class: 'esd' }, top, pPath, pIV, pMap, side));

  // level buttons
  const lvlBtns = [1, 2, 3, 4].map((l) => h('button', { type: 'button', role: 'radio', 'data-v': String(l),
    onclick: () => ctx.set('level', String(l)),
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return; e.preventDefault();
      const n = clamp(l + d, 1, 4); ctx.set('level', String(n));
      requestAnimationFrame(() => lvlSeg.querySelector(`[data-v="${n}"]`)?.focus());
    } }, `±${l * 2} kV`));
  lvlSeg.append(...lvlBtns);

  const refocus = (svg) => {
    if (!focusKey) return;
    const el = svg.querySelector(`[data-key="${focusKey}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  };

  // ---------- path: connector -> TVS -> IC ----------
  function drawPath() {
    if (!E) return;
    const svg = path.svg; svg.replaceChildren();
    const [W, H] = path.size();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const narrow = W < 560;
    const yL = Math.round(H * 0.47), yG = H - 16;
    const xC = narrow ? 10 : 20, cw = narrow ? 44 : 58;   // connector
    const xT = xC + cw + (narrow ? 30 : 70);      // TVS
    const xIC = W - (narrow ? 96 : 150);          // IC body left
    // connector shell
    sv(svg, 'rect', { x: xC, y: yL - 30, width: cw, height: 60, rx: 4, class: 'esd-conn' });
    for (let i = -1; i <= 1; i++) sv(svg, 'rect', { x: xC + cw - 20, y: yL - 3 + i * 16, width: 20, height: 6, class: i ? 'esd-pin-o' : 'esd-pin' });
    sv(svg, 'text', { x: xC + cw / 2, y: yL + 44, class: 'esd-t esd-soft esd-sm', 'text-anchor': 'middle' }, 'connector');
    // the strike
    const zx = xC + cw + 6, zy = yL - 8;
    sv(svg, 'path', { d: `M${zx + 4},${zy - 44} L${zx - 6},${zy - 26} L${zx + 2},${zy - 24} L${zx - 4},${zy - 6}`, class: 'esd-zap' });
    sv(svg, 'path', { d: `M${zx - 4},${zy - 4} l-3,-8 l7,2 z`, class: 'esd-zap-h' });
    sv(svg, 'text', { x: zx + 10, y: zy - 34, class: 'esd-t esd-b esd-zap-t' }, `±${E.kv} kV`);
    sv(svg, 'text', { x: zx + 10, y: zy - 21, class: 'esd-t esd-soft esd-sm' }, `${f(E.ipk)} A peak`);
    // the line
    sv(svg, 'line', { x1: xC + cw, x2: xIC, y1: yL, y2: yL, class: 'esd-line' });
    sv(svg, 'circle', { cx: xT, cy: yL, r: 3.5, class: 'esd-node' });
    // IC
    sv(svg, 'rect', { x: xIC, y: yL - 36, width: narrow ? 70 : 96, height: 72, rx: 3, class: 'esd-ic' });
    sv(svg, 'rect', { x: xIC - 8, y: yL - 3, width: 8, height: 6, class: 'esd-pin' });
    sv(svg, 'text', { x: xIC + (narrow ? 35 : 48), y: yL - 14, class: 'esd-t esd-ic-t', 'text-anchor': 'middle' }, 'IC');
    sv(svg, 'text', { x: xIC + (narrow ? 35 : 48), y: yL + 8, class: 'esd-t esd-ic-t esd-sm', 'text-anchor': 'middle' }, 'abs max');
    sv(svg, 'text', { x: xIC + (narrow ? 35 : 48), y: yL + 22, class: `esd-t esd-b ${E.absmax ? 'esd-ic-t' : 'esd-ic-q'}`, 'text-anchor': 'middle' },
      E.absmax ? `${f(E.absmax)} V` : '? V');
    // speed and capacitance on the line
    const mid = (xT + 150 + xIC) / 2;
    const lt = sv(svg, 'text', { x: xIC - 14, y: yL - 9, class: 'esd-t', 'text-anchor': 'end' });
    sv(lt, 'tspan', { class: 'esd-b' }, SHORT[E.id] || E.id);
    sv(lt, 'tspan', { class: 'esd-soft' }, narrow ? '' : `  ${E.speed} · up to ${f(E.vmax)} V`);
    if (narrow) sv(svg, 'text', { x: xIC - 14, y: yL - 24, class: 'esd-t esd-soft esd-sm', 'text-anchor': 'end' }, `${E.speed}`);
    const roomy = xIC - (xT + 170) > 250;
    if (roomy) sv(svg, 'path', { d: `M${xT + 170},${yL + 16} H${xIC - 20}`, class: 'esd-flow', 'marker-end': 'url(#esd-ar)' });
    const defs = sv(svg, 'defs');
    const mk = sv(defs, 'marker', { id: 'esd-ar', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' });
    sv(mk, 'path', { d: 'M0,0 L10,5 L0,10 z', class: 'esd-ar' });
    if (roomy) sv(svg, 'text', { x: xT + 170, y: yL + 30, class: 'esd-t esd-soft esd-sm' }, 'flow-through: the TVS at the connector, then the IC');

    // TVS symbol, vertical, from the line down to ground
    const ty0 = yL + 8, ty1 = yG - 10, tm = (ty0 + ty1) / 2;
    sv(svg, 'line', { x1: xT, x2: xT, y1: yL, y2: ty0, class: 'esd-wire' });
    sv(svg, 'line', { x1: xT, x2: xT, y1: ty1, y2: yG, class: 'esd-wire' });
    const diode = (yc, up) => {           // a diode with its bar; up = cathode on top
      const s = 8, yb = up ? yc - s : yc + s, ya = up ? yc + s : yc - s;
      sv(svg, 'path', { d: `M${xT - s},${ya} L${xT + s},${ya} L${xT},${yb} Z`, class: 'esd-tvs' });
      sv(svg, 'path', { d: `M${xT - s - 3},${yb} h${2 * s + 6}`, class: 'esd-tvs-bar' });
      // zener wings
      sv(svg, 'path', { d: `M${xT - s - 3},${yb} l-3,${up ? 4 : -4} M${xT + s + 3},${yb} l3,${up ? -4 : 4}`, class: 'esd-tvs-bar' });
    };
    if (E.bidirectional) {
      diode(tm - 10, true); diode(tm + 10, false);
      sv(svg, 'line', { x1: xT, x2: xT, y1: ty0, y2: tm - 18, class: 'esd-wire' });
      sv(svg, 'line', { x1: xT, x2: xT, y1: tm + 18, y2: ty1, class: 'esd-wire' });
    } else {
      diode(tm, true);
      sv(svg, 'line', { x1: xT, x2: xT, y1: ty0, y2: tm - 8, class: 'esd-wire' });
      sv(svg, 'line', { x1: xT, x2: xT, y1: tm + 8, y2: ty1, class: 'esd-wire' });
    }
    // ground
    sv(svg, 'path', { d: `M${xT - 12},${yG} h24 M${xT - 8},${yG + 4} h16 M${xT - 4},${yG + 8} h8`, class: 'esd-gnd' });
    // TVS labels
    const lx = xT + 18;
    sv(svg, 'text', { x: lx, y: tm - 14, class: 'esd-t esd-b esd-tvs-t' }, narrow ? `TVS ${E.pol.replace('bidirectional', 'bi').replace('unidirectional', 'uni')}` : `TVS · ${E.pol}`);
    sv(svg, 'text', { x: lx, y: tm + 1, class: 'esd-t' }, `VRWM ≥ ${f(E.vrwm)} V`);
    sv(svg, 'text', { x: lx, y: tm + 15, class: 'esd-t' }, `C ${capTxt(E.cmax)}`);
    sv(svg, 'text', { x: lx, y: yG + 6, class: 'esd-t esd-soft esd-sm' }, E.rail ? 'rail clamp, PHY side of the magnetics' : 'short via to the GND plane');
  }

  // ---------- the V-I window ----------
  function drawIV() {
    if (!E) return;
    const svg = iv.svg; svg.replaceChildren();
    const [W, H] = iv.size();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 50, R = 16, T = 30, B = 40;
    const bi = E.bidirectional;
    const vHi0 = Math.max(E.absmax || 0, E.vrwm * 1.9, E.vmax * 1.15) * 1.1;
    const vStep = niceStep(vHi0, 6);
    const vHi = Math.ceil(vHi0 / vStep) * vStep;
    const vLo = -(bi ? Math.ceil((vHi * 0.4) / vStep) * vStep : vStep);
    const iHi0 = E.ipk * 1.12;
    const iStep = niceStep(iHi0, 5);
    const iHi = Math.ceil(iHi0 / iStep) * iStep;
    const iLo = -(bi ? iHi * 0.32 : iHi * 0.12);
    const X = (v) => L + ((v - vLo) / (vHi - vLo)) * (W - L - R);
    const Y = (i) => T + ((iHi - i) / (iHi - iLo)) * (H - T - B);
    const Vx = (px) => vLo + ((px - L) / (W - L - R)) * (vHi - vLo);
    const defs = sv(svg, 'defs');
    const pt = sv(defs, 'pattern', { id: 'esd-hatch', patternUnits: 'userSpaceOnUse', width: 7, height: 7, patternTransform: 'rotate(45)' });
    sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'esd-hatch-l' });

    // grid + axes
    for (let v = Math.ceil(vLo / vStep) * vStep; v <= vHi + 1e-9; v += vStep) {
      sv(svg, 'line', { x1: X(v), x2: X(v), y1: T, y2: H - B, class: 'esd-grid' });
      sv(svg, 'text', { x: X(v), y: H - B + 14, class: 'esd-ax', 'text-anchor': 'middle' }, f(v));
    }
    for (let i = 0; i <= iHi + 1e-9; i += iStep) {
      sv(svg, 'line', { x1: L, x2: W - R, y1: Y(i), y2: Y(i), class: 'esd-grid' });
      if (i > 0 && !E.levels.some((lv) => Math.abs(Y(lv.i30) - Y(i)) < 22)) sv(svg, 'text', { x: L - 8, y: Y(i) + 4, class: 'esd-ax', 'text-anchor': 'end' }, `${f(i)} A`);
    }
    sv(svg, 'text', { x: W - R, y: H - 8, class: 'esd-ax', 'text-anchor': 'end' }, 'voltage across the TVS, V →');
    sv(svg, 'text', { x: L - 6, y: T - 14, class: 'esd-ax' }, '↑ current, A');

    // the line's normal swing: the TVS must stay off here
    const swLo = bi ? Math.max(vLo, -E.vmax) : 0;
    sv(svg, 'rect', { x: X(swLo), y: T, width: X(E.vmax) - X(swLo), height: H - T - B, class: 'esd-swing' });
    // above the pin's absolute maximum: damage
    if (E.absmax) {
      sv(svg, 'rect', { x: X(E.absmax), y: T, width: Math.max(0, W - R - X(E.absmax)), height: H - T - B, class: 'esd-dead' });
      if (bi) sv(svg, 'rect', { x: L, y: T, width: Math.max(0, X(-E.absmax) - L), height: H - T - B, class: 'esd-dead' });
    }
    sv(svg, 'line', { x1: L, x2: W - R, y1: Y(0), y2: Y(0), class: 'esd-axis' });
    sv(svg, 'line', { x1: X(0), x2: X(0), y1: T, y2: H - B, class: 'esd-axis' });

    // the four test levels on the current axis; the chosen one is the clamp row
    for (const lv of E.levels) {
      const g = sv(svg, 'g', { class: `esd-lvl${lv.level === E.level ? ' on' : ''}`, tabindex: -1, role: 'button',
        'aria-label': `Level ${lv.level}, ±${lv.kv} kV` });
      g.addEventListener('click', () => ctx.set('level', String(lv.level)));
      sv(g, 'rect', { x: 2, y: Y(lv.i30) - 8, width: L - 6, height: 16, rx: 3, class: 'esd-lvl-bg' });
      sv(g, 'text', { x: L - 8, y: Y(lv.i30) + 4, class: 'esd-ax esd-lvl-t', 'text-anchor': 'end' }, `${f(lv.i30)} A`);
      sv(g, 'line', { x1: L - 3, x2: L + 3, y1: Y(lv.i30), y2: Y(lv.i30), class: 'esd-axis' });
      sv(g, 'title', {}, `Level ${lv.level}: ±${lv.kv} kV contact, ${f(lv.i30)} A at 30 ns, ${f(lv.ipk)} A first peak`);
    }
    sv(svg, 'line', { x1: L, x2: W - R, y1: Y(E.ipk), y2: Y(E.ipk), class: 'esd-peak' });
    sv(svg, 'text', { x: L + 6, y: Y(E.ipk) - 5, class: 'esd-ax' }, `first peak ${f(E.ipk)} A`);

    // the target: clamp at the 30 ns current between VRWM and the pin's abs max
    const y30 = Y(E.i30);
    const winR = E.absmax ? E.absmax : vHi;
    const ok = !E.absmax || E.absmax > E.vrwm;
    if (ok) {
      sv(svg, 'rect', { x: X(E.vrwm), y: y30 - 7, width: Math.max(2, X(winR) - X(E.vrwm)), height: 14, rx: 2, class: `esd-win${E.absmax ? '' : ' open'}` });
      const wt = E.absmax ? `clamp at ${f(E.i30)} A lands in ${f(E.margin, 2)} V` : `clamp at ${f(E.i30)} A: below the pin's abs max`;
      const half = wt.length * 3.4;
      sv(svg, 'text', { x: clamp((X(E.vrwm) + X(winR)) / 2, L + half, W - R - half), y: y30 - 12, class: 'esd-t esd-b esd-win-t', 'text-anchor': 'middle' }, wt);
    } else {
      sv(svg, 'rect', { x: X(E.absmax), y: y30 - 7, width: Math.max(2, X(E.vrwm) - X(E.absmax)), height: 14, rx: 2, class: 'esd-win bad' });
      sv(svg, 'text', { x: X(E.vrwm) + 6, y: y30 - 12, class: 'esd-t esd-b esd-bad-t' }, 'no window: abs max ≤ VRWM');
    }

    // a part that fits: shape only
    const vbr = E.vrwm * 1.1;
    const vc = E.absmax && ok ? E.vrwm + 0.55 * (E.absmax - E.vrwm) : E.vrwm * (E.absmax ? 1.25 : 1.45);
    const rd = Math.max(1e-3, (vc - vbr) / E.i30);
    const vAt = (i) => vbr + rd * i;
    const knee = (s) => {
      const pts = [[0, 0], [s * vbr * 0.92, s * iHi * 0.004], [s * vbr, s * iHi * 0.02]];
      for (let i = iHi * 0.06; i <= iHi; i += iHi / 20) pts.push([s * vAt(i), s * i]);
      return pts;
    };
    const line = (pts) => pts.map(([v, i], k) => `${k ? 'L' : 'M'}${X(clamp(v, vLo, vHi)).toFixed(1)},${Y(clamp(i, iLo, iHi)).toFixed(1)}`).join('');
    const pos = knee(1);
    const neg = bi ? knee(-1) : [[0, 0], [-Math.min(0.7, -vLo * 0.6), -iHi * 0.01], [-Math.min(1.1, -vLo * 0.9), iLo]];
    sv(svg, 'path', { d: line(pos), class: `esd-curve${ok ? '' : ' bad'}` });
    sv(svg, 'path', { d: line(neg), class: `esd-curve${ok ? '' : ' bad'}` });
    sv(svg, 'circle', { cx: X(vAt(E.i30)), cy: y30, r: 4, class: `esd-cdot${ok ? '' : ' bad'}` });
    const ci = iHi * 0.24;
    const ct = W < 520 ? null : sv(svg, 'text', { x: X(vAt(ci)) + 8, y: Y(ci), class: 'esd-t esd-soft esd-sm' }, ok ? 'a part that fits (shape only)' : 'no part fits (shape only)');
    if (ct && X(vAt(ci)) + 170 > W - R) { ct.setAttribute('x', X(vAt(ci)) - 8); ct.setAttribute('text-anchor', 'end'); }
    if (!bi) sv(svg, 'text', { x: X(0) - 6, y: Y(iLo) - 4, class: 'esd-t esd-soft esd-sm', 'text-anchor': 'end' }, 'forward');

    // VRWM line
    sv(svg, 'line', { x1: X(E.vrwm), x2: X(E.vrwm), y1: T, y2: H - B, class: 'esd-vrwm' });
    sv(svg, 'text', { x: X(E.vrwm) - 6, y: Y(iHi * 0.72), class: 'esd-t esd-b esd-vrwm-t', 'text-anchor': 'end' }, `VRWM ≥ ${f(E.vrwm)} V`);
    sv(svg, 'text', { x: X(E.vrwm) - 6, y: Y(iHi * 0.72) + 13, class: 'esd-t esd-soft esd-sm', 'text-anchor': 'end' }, 'TVS stays off');

    // handles
    const handle = (key, v, cls, label, given, title) => {
      const x = X(clamp(v, vLo, vHi));
      const g = sv(svg, 'g', { class: `esd-h ${cls}${given ? '' : ' ghost'}`, tabindex: 0, role: 'slider', 'data-key': key,
        'aria-label': title, 'aria-valuenow': f(v), 'aria-valuetext': given ? `${f(v)} V` : 'not set' });
      sv(g, 'line', { x1: x, x2: x, y1: T - 2, y2: H - B, class: 'esd-h-ln' });
      const tw = label.length * 6.6 + 14;
      const tx = clamp(x - tw / 2, 2, W - R - tw);
      const cap = sv(g, 'g', { 'data-x': tx, 'data-w': tw });
      sv(cap, 'rect', { x: tx, y: T - 24, width: tw, height: 18, rx: 3, class: 'esd-h-cap' });
      sv(cap, 'text', { x: tx + tw / 2, y: T - 11, class: 'esd-t esd-b esd-h-t', 'text-anchor': 'middle' }, label);
      sv(g, 'rect', { x: x - 8, y: T - 24, width: 16, height: H - B - T + 24, class: 'esd-hit' });
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault(); capture(svg, e); focusKey = key; g.focus({ preventScroll: true });
        const move = (ev) => {
          const r = svg.getBoundingClientRect();
          let nv = Vx((ev.clientX - r.left) * (W / r.width));
          nv = nv < 10 ? Math.round(nv * 10) / 10 : Math.round(nv * 2) / 2;
          ctx.set(key, String(clamp(nv, 0.5, 400)));
        };
        const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up); };
        svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
        move(e);
      });
      g.addEventListener('keydown', (e) => {
        const cur = given ? v : (key === 'vline' ? E.vmax : Math.round(E.vrwm * 1.5));
        const st = e.shiftKey ? 1 : (cur < 10 ? 0.1 : 0.5);
        let nv = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nv = cur + st;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nv = cur - st;
        else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Home') { e.preventDefault(); focusKey = key; ctx.set(key, ''); return; }
        if (nv == null) return;
        e.preventDefault(); focusKey = key;
        ctx.set(key, String(Math.round(clamp(nv, 0.5, 400) * 10) / 10));
      });
      g.addEventListener('blur', () => { if (focusKey === key) setTimeout(() => { if (!svg.contains(document.activeElement)) focusKey = null; }, 0); });
      sv(g, 'title', {}, `${title}. Drag, or arrow keys (Shift = 1 V); Delete to clear.`);
    };
    handle('vline', E.vmax, 'esd-h-line', E.vline ? `line ${f(E.vmax)} V` : `line ${f(E.vmax)} V usual`, true, 'Highest line voltage');
    handle('absmax', E.absmax || Math.min(vHi * 0.94, Math.max(E.vrwm * 1.6, E.vrwm + 2)), 'esd-h-abs',
      E.absmax ? `pin abs max ${f(E.absmax)} V` : 'pin abs max? drag', !!E.absmax, 'Protected pin absolute maximum');
    // keep the two captions apart: the line's steps aside to the left
    const [ca, cb] = [...svg.querySelectorAll('.esd-h > g[data-x]')];
    if (ca && cb) {
      const ax = Number(ca.dataset.x), aw = Number(ca.dataset.w), bx = Number(cb.dataset.x), bw = Number(cb.dataset.w);
      if (ax < bx + bw && bx < ax + aw) {
        const want = ax <= bx ? bx - aw - 4 : bx + bw + 4;
        const nx = clamp(want, 2, W - R - aw);
        ca.setAttribute('transform', `translate(${nx - ax},0)`);
        if (nx < bx + bw && bx < nx + aw) cb.setAttribute('transform', `translate(${nx + aw + 4 - bx},0)`);
      }
    }
    refocus(svg);
  }

  // ---------- the interface map ----------
  function drawMap() {
    if (!E) return;
    const svg = map.svg; svg.replaceChildren();
    const [W, H] = map.size();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 44, R = 10, T = 26, B = 34, colW = Math.min(92, W * 0.2);
    const xR = W - R - colW - 8;
    const lc0 = Math.log10(0.1), lc1 = Math.log10(300);
    const v0 = Math.log10(2.8), v1 = Math.log10(40);
    const X = (c) => (c >= 1000 ? xR + 8 + colW / 2 : L + ((Math.log10(c) - lc0) / (lc1 - lc0)) * (xR - L));
    const Y = (v) => T + ((v1 - Math.log10(clamp(v, 2.8, 40))) / (v1 - v0)) * (H - T - B);
    // speed zones
    const tight = W < 400;
    const zones = [[0.1, 1, tight ? 'Gb/s' : 'multi-Gb/s'], [1, 10, tight ? 'fast' : '100 M–1 Gb/s'], [10, 300, 'slow']];
    zones.forEach(([a, b, t], i) => {
      sv(svg, 'rect', { x: X(a), y: T, width: X(b) - X(a), height: H - T - B, class: `esd-zone z${i}` });
      sv(svg, 'text', { x: (X(a) + X(b)) / 2, y: T - 8, class: 'esd-ax', 'text-anchor': 'middle' }, t);
    });
    sv(svg, 'rect', { x: xR + 8, y: T, width: colW, height: H - T - B, class: 'esd-zone z3' });
    sv(svg, 'text', { x: xR + 8 + colW / 2, y: T - 8, class: 'esd-ax', 'text-anchor': 'middle' }, tight ? 'DC' : 'DC / power');
    for (const c of [0.1, 0.3, 1, 3, 10, 30, 100, 300]) {
      sv(svg, 'line', { x1: X(c), x2: X(c), y1: T, y2: H - B, class: 'esd-grid' });
      sv(svg, 'text', { x: X(c), y: H - B + 13, class: 'esd-ax', 'text-anchor': 'middle' }, c < 1 ? String(c) : f(c));
    }
    sv(svg, 'text', { x: (L + xR) / 2, y: H - 6, class: 'esd-ax', 'text-anchor': 'middle' }, 'max capacitance per line, pF (log) →');
    sv(svg, 'text', { x: xR + 8 + colW / 2, y: H - B + 13, class: 'esd-ax', 'text-anchor': 'middle' }, tight ? 'n/c' : 'not critical');
    for (const v of [3, 5, 10, 20, 30]) {
      sv(svg, 'line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'esd-grid' });
      sv(svg, 'text', { x: L - 5, y: Y(v) + 3, class: 'esd-ax', 'text-anchor': 'end' }, `${v} V`);
    }
    sv(svg, 'text', { x: 4, y: T - 8, class: 'esd-ax' }, 'VRWM');

    // points, then labels placed greedily around them
    const items = E.list.map((it) => ({ ...it, px: X(it.cmax), py: Y(it.vrwm) }));
    const placed = items.map((it) => ({ x: it.px - 4, y: it.py - 4, w: 8, h: 8 }));
    const mine = E.vrwm > E.vrwm0 + 1e-9;
    if (mine) placed.push({ x: X(E.cmax) - 6, y: Y(E.vrwm) - 18, w: 100, h: 24 });
    const hit = (a) => placed.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
    const order = [...items].sort((a, b) => (a.id === E.id ? -1 : b.id === E.id ? 1 : a.py - b.py || a.px - b.px));
    for (const it of order) {
      const w = (SHORT[it.id] || it.id).length * 6.3 + 10, hh = 16;
      const cands = [];
      for (let k = 0; k < 7; k++) {
        const dy = [0, -1, 1, -2, 2, -3, 3][k] * 17;
        cands.push({ x: it.px + 7, y: it.py - 8 + dy }, { x: it.px - 7 - w, y: it.py - 8 + dy });
      }
      let pick = cands.find((c) => c.x >= L && c.x + w <= W - R && c.y >= T && c.y + hh <= H - B && !hit({ ...c, w, h: hh }));
      if (!pick && it.id !== E.id) { it.lb = null; continue; }   // no room: the dot alone, its name on hover
      if (!pick) pick = cands[0];
      it.lb = { x: pick.x, y: pick.y, w, h: hh };
      placed.push(it.lb);
    }
    // the user's own stand-off, when above the interface's usual one
    if (mine) {
      const x = X(E.cmax);
      sv(svg, 'path', { d: `M${x},${Y(E.vrwm0)} L${x},${Y(E.vrwm) + 6}`, class: 'esd-move', 'marker-end': 'url(#esd-ar2)' });
      const defs = sv(svg, 'defs');
      const mk = sv(defs, 'marker', { id: 'esd-ar2', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' });
      sv(mk, 'path', { d: 'M0,0 L10,5 L0,10 z', class: 'esd-ar' });
      sv(svg, 'circle', { cx: x, cy: Y(E.vrwm), r: 5, class: 'esd-mine' });
      sv(svg, 'text', { x: x + 8, y: Y(E.vrwm) - 6, class: 'esd-t esd-b esd-mine-t' }, `yours ${f(E.vrwm)} V`);
    }
    const grp = sv(svg, 'g', { class: 'esd-pts', tabindex: 0, 'data-key': 'map', role: 'listbox', 'aria-label': 'Interfaces: arrow keys move, Enter picks',
      'aria-activedescendant': `esd-pt-${E.id}` });
    for (const it of items) {
      const on = it.id === E.id;
      const g = sv(grp, 'g', { class: `esd-pt${on ? ' on' : ''}${it.match ? '' : ' dim'}`, id: `esd-pt-${it.id}`, role: 'option', 'aria-selected': String(on), 'data-id': it.id });
      if (it.lb) sv(g, 'line', { x1: it.px, y1: it.py, x2: it.lb.x < it.px ? it.lb.x + it.lb.w : it.lb.x, y2: it.lb.y + 8, class: 'esd-lead' });
      sv(g, 'circle', { cx: it.px, cy: it.py, r: 9, class: 'esd-hitc' });
      sv(g, 'circle', { cx: it.px, cy: it.py, r: on ? 5.5 : 3.5, class: 'esd-dot' });
      if (it.lb) {
        sv(g, 'rect', { x: it.lb.x, y: it.lb.y, width: it.lb.w, height: it.lb.h, rx: 3, class: 'esd-pill' });
        sv(g, 'text', { x: it.lb.x + it.lb.w / 2, y: it.lb.y + 12, class: 'esd-pill-t', 'text-anchor': 'middle' }, SHORT[it.id] || it.id);
      }
      sv(g, 'title', {}, `${NAMES[it.id] || it.id}\nVRWM ≥ ${f(it.vrwm)} V · C ${capTxt(it.cmax)}`);
      g.addEventListener('click', () => { focusKey = null; ctx.set('iface', it.id); });
    }
    grp.addEventListener('keydown', (e) => {
      const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!dir) return;
      e.preventDefault();
      const cur = items.find((i) => i.id === E.id);
      let best = null, bd = Infinity;
      for (const it of items) {
        if (it === cur) continue;
        const dx = it.px - cur.px, dy = it.py - cur.py;
        const along = dx * dir[0] + dy * dir[1];
        if (along <= 0.5) continue;
        const d = along + 2.5 * Math.abs(dx * dir[1] - dy * dir[0]);
        if (d < bd) { bd = d; best = it; }
      }
      if (!best) { // same spot: step through the stack
        const same = items.filter((i) => i.px === cur.px && i.py === cur.py);
        if (same.length > 1) best = same[(same.indexOf(cur) + (dir[0] + dir[1] > 0 ? 1 : same.length - 1)) % same.length];
      }
      if (best) { focusKey = 'map'; ctx.set('iface', best.id); }
    });
    refocus(svg);
  }

  // ---------- the IEC pulse ----------
  function drawPulse() {
    if (!E) return;
    const svg = pulse.svg; svg.replaceChildren();
    const [W, H] = pulse.size();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 36, R = 12, T = 14, B = 24;
    const tMax = 100;
    const iMax = E.levels[3].ipk * 1.08;
    const X = (t) => L + (t / tMax) * (W - L - R);
    const Y = (i) => T + (1 - i / iMax) * (H - T - B);
    for (const t of [0, 30, 60, 90]) {
      sv(svg, 'line', { x1: X(t), x2: X(t), y1: T, y2: H - B, class: 'esd-grid' });
      sv(svg, 'text', { x: X(t), y: H - B + 13, class: 'esd-ax', 'text-anchor': 'middle' }, `${t} ns`);
    }
    for (const i of [0, 10, 20, 30]) sv(svg, 'text', { x: L - 5, y: Y(i) + 3, class: 'esd-ax', 'text-anchor': 'end' }, `${i} A`);
    sv(svg, 'line', { x1: L, x2: W - R, y1: Y(0), y2: Y(0), class: 'esd-axis' });
    // the four levels as ghosts, the chosen one solid; the curve runs through
    // the standard's defined points (peak, 30 ns, 60 ns)
    const wave = (lv) => {
      const p = lv.ipk, a = lv.i30, b = lv.i60;
      return `M${X(0)},${Y(0)} C${X(0.3)},${Y(0)} ${X(0.5)},${Y(p)} ${X(0.8)},${Y(p)} C${X(1.4)},${Y(p)} ${X(2)},${Y(a * 0.9)} ${X(4)},${Y(a * 0.95)}`
        + ` C${X(10)},${Y(a * 1.08)} ${X(20)},${Y(a * 1.06)} ${X(30)},${Y(a)} C${X(42)},${Y(a * 0.86)} ${X(52)},${Y(b * 1.15)} ${X(60)},${Y(b)}`
        + ` C${X(72)},${Y(b * 0.75)} ${X(88)},${Y(b * 0.4)} ${X(100)},${Y(b * 0.22)}`;
    };
    for (const lv of E.levels) if (lv.level !== E.level) sv(svg, 'path', { d: wave(lv), class: 'esd-wave ghost' });
    const lv = E.levels.find((l) => l.level === E.level);
    sv(svg, 'path', { d: `${wave(lv)} L${X(100)},${Y(0)} L${X(0)},${Y(0)} Z`, class: 'esd-wave-fill' });
    sv(svg, 'path', { d: wave(lv), class: 'esd-wave' });
    const pts = [[0.8, lv.ipk, `${f(lv.ipk)} A peak`], [30, lv.i30, `${f(lv.i30)} A at 30 ns`], [60, lv.i60, `${f(lv.i60)} A at 60 ns`]];
    for (const [t, i, s] of pts) {
      sv(svg, 'circle', { cx: X(t), cy: Y(i), r: 3.5, class: 'esd-cdot' });
      sv(svg, 'text', { x: X(t) + 7, y: Y(i) - 6, class: 'esd-t esd-sm esd-b' }, s);
    }
  }

  // ---------- facts ----------
  function drawFacts() {
    const warn = (res.warnings || []);
    facts.replaceChildren(
      h('div', { class: 'esd-fhead' }, h('b', {}, E.name), h('span', {}, E.speed)),
      h('dl', {},
        h('dt', {}, 'Stand-off VRWM'), h('dd', {}, `≥ ${f(E.vrwm)} V`),
        h('dt', {}, 'Capacitance'), h('dd', {}, capTxt(E.cmax)),
        h('dt', {}, 'Polarity'), h('dd', {}, E.pol),
        h('dt', {}, 'Clamp below'), h('dd', {}, E.absmax ? `${f(E.absmax)} V at ${f(E.i30)} A` : `abs max at ${f(E.i30)} A`)),
      h('div', { class: 'esd-note' }, E.note),
      h('div', { class: 'esd-partsl' }, h('span', {}, 'Example parts'), h('b', {}, E.parts)));
    ivWarn.replaceChildren(...warn.map((w) => h('div', {}, w)));
    ivHead.querySelector('.esd-sub').textContent = `${SHORT[E.id] || E.id} · ±${E.kv} kV · drag the line and the pin's abs max`;
  }

  ctx.onResult((r) => {
    res = r; E = r.esd;
    if (!E) { ivWarn.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w))); return; }
    const raw = ctx.raw;
    sel.value = E.id;
    if (document.activeElement !== filt) filt.value = raw.filter ?? '';
    vlineF.sync(raw.vline); absF.sync(raw.absmax);
    vlineF.inp.placeholder = `${f(E.vl)} usual`; absF.inp.placeholder = 'unknown';
    lvlBtns.forEach((b) => { const on = Number(b.dataset.v) === E.level; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    drawPath(); drawIV(); drawMap(); drawPulse(); drawFacts();
  });
}
