// Bolt Torque: the page is the joint itself. A section through the bolted
// joint, to scale for the chosen thread, with the preload as clamp arrows and
// the two friction places as spots to click; a torque wrench dial to turn,
// a stress bar beside the bolt, and torque against friction below.
// Every number drawn comes from run()'s result (result.joint).

const SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20', 'M24'];
const DIAS = { M2: 2, 'M2.5': 2.5, M3: 3, M4: 4, M5: 5, M6: 6, M8: 8, M10: 10, M12: 12, M14: 14, M16: 16, M20: 20, M24: 24 };
const GRADES = [['4.6', '4.6'], ['5.6', '5.6'], ['8.8', '8.8'], ['10.9', '10.9'], ['12.9', '12.9'],
  ['A2-70', 'A2-70'], ['A4-70', 'A4-70'], ['A4-80', 'A4-80']];

// Friction by surface and lubrication, rounded from VDI 2230 table A5.
const FRICTION = [
  ['MoS₂ paste or wax', 0.08],
  ['Black oxide, oiled', 0.1],
  ['Zinc plated, oiled', 0.12],
  ['Zinc plated, dry', 0.14],
  ['Phosphated, dry', 0.16],
  ['Plain steel, dry', 0.18],
  ['Stainless, anti-seize', 0.12],
  ['Aluminium face, dry', 0.2],
  ['Stainless, dry', 0.28],
];

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
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or ended pointer */ } };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f1 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(3))));
const niceStep = (span, n) => {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const niceCeil = (v, n = 5) => { const st = niceStep(v, n); return Math.ceil(v / st - 1e-9) * st; };

const VKEY = 'redline.tool.bolt-torque.view';
const loadView = () => { try { return { joint: 'nut', washer: true, ...(JSON.parse(localStorage.getItem(VKEY) || '{}')) }; } catch { return { joint: 'nut', washer: true }; } };
const saveView = (v) => { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* private window */ } };

export function page(root, ctx) {
  const view = loadView();
  let J = null;       // result.joint
  let res = null;     // the whole result
  let menu = null;    // open friction menu

  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));

  // ---------- controls ----------
  const radioGroup = (label, items, key, cls) => {
    const g = h('div', { class: `bt-seg ${cls || ''}`, role: 'radiogroup', 'aria-label': label });
    const btns = items.map(([v, t, title]) => h('button', { type: 'button', role: 'radio', 'data-v': v, title: title || null,
      onclick: () => pick(v), onkeydown: (e) => nav(e, v) }, t));
    function pick(v) { if (typeof key === 'function') key(v); else ctx.set(key, v); }
    function nav(e, v) {
      const i = items.findIndex((it) => it[0] === v);
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const n = items[clamp(i + d, 0, items.length - 1)][0];
      pick(n);
      requestAnimationFrame(() => g.querySelector(`[data-v="${CSS.escape(n)}"]`)?.focus());
    }
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => {
      const on = b.dataset.v === String(cur);
      b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
    });
    return g;
  };

  const classStrip = radioGroup('Property class', GRADES.map(([v, t]) => [v, t, /^A/.test(v) ? 'Stainless steel, ISO 3506-1' : 'Steel, ISO 898-1']), 'grade', 'bt-class');
  const headSeg = radioGroup('Head', [['hex', 'Hex', 'ISO 4017 hex head'], ['socket', 'Socket cap', 'ISO 4762 socket head cap screw']], 'head');
  const jointSeg = radioGroup('Joint', [['nut', 'Nut'], ['tapped', 'Tapped hole']], (v) => { view.joint = v; saveView(view); draw(); });
  const washerBtn = h('button', { type: 'button', class: 'bt-toggle', 'aria-pressed': 'false',
    onclick: () => { view.washer = !view.washer; saveView(view); draw(); } }, 'Washer');

  const numField = (key, label, unit, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label,
      oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'bt-num', title: title || null }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const nuField = numField('nu', 'Target', '% of yield', 'Yield utilisation at assembly, VDI 2230 uses 90 %');
  const aaField = numField('alphaA', 'αA', '', 'Tightening factor: max / min preload (1.6 torque wrench)');

  const top = h('div', { class: 'bt-top' },
    h('div', { class: 'bt-group' }, h('span', { class: 'bt-cap' }, 'Class'), classStrip),
    h('div', { class: 'bt-group' }, h('span', { class: 'bt-cap' }, 'Head'), headSeg),
    h('div', { class: 'bt-group' }, h('span', { class: 'bt-cap' }, 'Joint'), jointSeg, washerBtn),
    h('div', { class: 'bt-group bt-fields' }, nuField, aaField));

  // thread ladder
  const ladder = h('div', { class: 'bt-ladder', role: 'radiogroup', 'aria-label': 'Thread size' });
  const rungs = SIZES.map((sz) => h('button', { type: 'button', role: 'radio', 'data-v': sz, title: `${sz} coarse`,
    onclick: () => ctx.set('size', sz),
    onkeydown: (e) => {
      const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!d) return; e.preventDefault();
      const n = SIZES[clamp(SIZES.indexOf(sz) + d, 0, SIZES.length - 1)];
      ctx.set('size', n); requestAnimationFrame(() => ladder.querySelector(`[data-v="${CSS.escape(n)}"]`)?.focus());
    } }, h('span', { class: 'bt-rung', style: `--w:${(DIAS[sz] / 24) * 100}%` }), h('b', {}, sz)));
  ladder.append(...rungs);

  // stage: the section
  const stageSvg = sv(null, 'svg', { class: 'bt-section', role: 'group', 'aria-label': 'Section through the bolted joint' });
  const stageWarn = h('div', { class: 'bt-warns', 'aria-live': 'polite' });
  const stage = h('section', { class: 'bt-stage' }, h('div', { class: 'bt-box' }, stageSvg), stageWarn);

  // stress bar
  const stressSvg = sv(null, 'svg', { class: 'bt-stress-svg', role: 'group', 'aria-label': 'Bolt stress against the property class limits' });
  const stress = h('section', { class: 'bt-stress' }, h('div', { class: 'bt-cap' }, 'Bolt stress, MPa'), h('div', { class: 'bt-box' }, stressSvg));

  // dial and numbers
  const dialSvg = sv(null, 'svg', { class: 'bt-dial', viewBox: '0 0 260 200', role: 'group', 'aria-label': 'Torque wrench dial' });
  const split = h('div', { class: 'bt-split' });
  const facts = h('dl', { class: 'bt-facts' });
  const side = h('aside', { class: 'bt-side' },
    h('div', { class: 'bt-card bt-wrench' }, h('div', { class: 'bt-cap' }, 'Torque wrench'), dialSvg, split, facts),
    ctx.outputs);

  // curve
  const curveSvg = sv(null, 'svg', { class: 'bt-curve-svg', role: 'group', 'aria-label': 'Torque and preload against friction' });
  const curveHead = h('div', { class: 'bt-curve-head' });
  const curve = h('section', { class: 'bt-curve' }, curveHead, h('div', { class: 'bt-box' }, curveSvg));

  const layout = h('div', { class: 'bt' }, top, ladder, stage, stress, curve, side);
  root.append(layout);

  // ---------- friction menu ----------
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function openMenu(which, anchor) {
    closeMenu();
    const isHead = which === 'muK';
    const cur = isHead ? J.muK : J.muG;
    const setMu = (v) => { ctx.set(which, v === '' ? '' : String(v)); };
    const inp = h('input', { type: 'text', inputmode: 'decimal', value: String(isHead && !J.muKGiven ? '' : cur),
      placeholder: isHead ? `= µG ${J.muG}` : '', 'aria-label': isHead ? 'Head friction µK' : 'Thread friction µG',
      oninput: (e) => setMu(e.target.value.trim()),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor?.focus(); } } });
    const hit = FRICTION.findIndex(([, mu]) => Math.abs(mu - cur) < 1e-9);
    const items = FRICTION.map(([name, mu], i) => h('button', { type: 'button', role: 'menuitemradio',
      'aria-checked': String(i === hit && (!isHead || J.muKGiven)),
      onclick: () => { setMu(mu); closeMenu(); anchor?.focus(); } }, h('span', {}, name), h('b', {}, mu.toFixed(2))));
    if (isHead) items.unshift(h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(!J.muKGiven),
      onclick: () => { setMu(''); closeMenu(); anchor?.focus(); } }, h('span', {}, 'Same as thread'), h('b', {}, 'µG')));
    menu = h('div', { class: 'bt-menu', role: 'menu', 'aria-label': isHead ? 'Head bearing friction' : 'Thread friction',
      onkeydown: (e) => {
        if (e.key === 'Escape') { closeMenu(); anchor?.focus(); return; }
        const list = [...menu.querySelectorAll('button')];
        const i = list.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); list[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1)]?.focus(); }
      } },
    h('div', { class: 'bt-menu-head' }, isHead ? 'Head bearing face  µK' : 'Thread flanks  µG'),
    ...items,
    h('label', { class: 'bt-menu-num' }, h('span', {}, 'µ'), inp));
    stage.append(menu);
    // under the spot's label box, kept inside the stage
    const sr = stage.getBoundingClientRect(), ar = (anchor.querySelector('.bt-spot-box') || anchor).getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const x = clamp(ar.right - sr.left - mw, 4, Math.max(4, sr.width - mw - 4));
    let y = ar.bottom - sr.top + 4;
    if (y + mh > sr.height - 4) y = Math.max(4, ar.top - sr.top - mh - 4);
    menu.style.left = `${x}px`; menu.style.top = `${y}px`;
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'))?.focus();
  }
  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target) && !e.target.closest?.('.bt-spot')) closeMenu();
  });

  // ---------- drawing: the section ----------
  function drawSection() {
    const svg = stageSvg;
    svg.replaceChildren();
    const W = Math.max(280, stageSvg.clientWidth || 600), H = Math.max(300, stageSvg.clientHeight || 460);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const { d, P, d2, d3, dw, dh, DKm, parts: p } = J;
    const nut = view.joint === 'nut';
    const wsh = view.washer;
    const snap = (v) => Math.max(1, Math.round(v * 2) / 2);
    const wh = wsh ? p.washerH : 0, wd = p.washerD;
    const hexHead = J.head !== 'socket';
    const headW = hexHead ? p.hexS : p.capDk, headK = hexHead ? p.hexK : p.capK;
    const t1 = snap(1.1 * d), t2 = nut ? snap(1.1 * d) : snap(2.6 * d);
    const le = 1.5 * d; // tapped engagement drawn
    const grip = nut ? t1 + t2 : t1;
    const nutW = p.hexS, nutM = p.nutM;
    const L = nut ? Math.ceil((grip + 2 * wh + nutM + 3 * P) / 2) * 2 : Math.ceil((grip + wh + le) / 2) * 2; // under-head length
    const boltEnd = L - wh; // from plate top (y=0), bolt starts at -wh
    const plateHalf = Math.max(headW, wsh ? wd : 0, nut ? nutW : 0) / 2 + 1.25 * d;
    const yTop = -(wh + headK), yBot = nut ? boltEnd : grip + t2;
    // px margins, then the mm scale
    const narrow = W < 520;
    const mL = narrow ? 34 : 70, mR = narrow ? 118 : 200, mT = 74, mB = 62;
    const sc = Math.min((W - mL - mR) / (2 * plateHalf), (H - mT - mB) / (yBot - yTop));
    const cx = mL + ((W - mL - mR) - 0) / 2;
    const cy = mT + ((H - mT - mB) - (yBot - yTop) * sc) / 2 - yTop * sc;
    const X = (x) => cx + x * sc, Y = (y) => cy + y * sc;

    // hatch patterns
    const defs = sv(svg, 'defs');
    const hatch = (id, ang, gap, cls) => {
      const pt = sv(defs, 'pattern', { id, patternUnits: 'userSpaceOnUse', width: gap, height: gap, patternTransform: `rotate(${ang})` });
      sv(pt, 'rect', { width: gap, height: gap, class: `${cls}-bg` });
      sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: gap, class: `${cls}-ln` });
    };
    hatch('bt-h-plate', 45, 7, 'bt-hp');
    hatch('bt-h-plate2', -45, 7, 'bt-hp');
    hatch('bt-h-nut', 45, 4, 'bt-hn');
    hatch('bt-h-washer', -45, 3.5, 'bt-hw');
    const arrowDef = (id, cls) => {
      const m = sv(defs, 'marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      sv(m, 'path', { d: 'M0,0 L10,5 L0,10 z', class: cls });
    };
    arrowDef('bt-ar-dim', 'bt-dimhead');

    const over = J.util > 1;
    // thread profile radius at depth y (y measured from the thread start)
    const cr = P / 8, rt = P / 4, fl = (P - cr - rt) / 2;
    const prof = (y0, y1, rOff, side) => {
      // points from y0 to y1 along the thread boundary, x = side * r
      const pts = [];
      const rMaj = d / 2 + rOff, rMin = d3 / 2 + rOff;
      let y = y0 - (((y0 % P) + P) % P);
      const push = (yy, r) => { if (yy >= y0 - 1e-9 && yy <= y1 + 1e-9) pts.push([side * r, yy]); };
      pts.push([side * profR(y0), y0]);
      for (; y <= y1; y += P) {
        push(y + rt / 2, rMin); push(y + rt / 2 + fl, rMaj); push(y + rt / 2 + fl + cr, rMaj); push(y + rt / 2 + 2 * fl + cr, rMin);
      }
      pts.push([side * profR(y1), y1]);
      function profR(yy) {
        const u = (((yy - rt / 2) % P) + P) % P; // 0 at the end of the root flat's first half
        if (u < fl) return rMin + (rMaj - rMin) * (u / fl);
        if (u < fl + cr) return rMaj;
        if (u < 2 * fl + cr) return rMaj - (rMaj - rMin) * ((u - fl - cr) / fl);
        return rMin;
      }
      return pts;
    };
    const poly = (pts, attrs) => sv(svg, 'path', { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join('') + 'Z', ...attrs });

    const thStart = 2 * P; // plain run-out under the head, then thread
    // ---- plates (clamped parts) ----
    const r1 = dh / 2;
    poly([[-plateHalf, 0], [-r1, 0], [-r1, t1], [-plateHalf, t1]], { class: 'bt-plate', fill: 'url(#bt-h-plate)' });
    poly([[r1, 0], [plateHalf, 0], [plateHalf, t1], [r1, t1]], { class: 'bt-plate', fill: 'url(#bt-h-plate)' });
    if (nut) {
      poly([[-plateHalf, t1], [-r1, t1], [-r1, grip], [-plateHalf, grip]], { class: 'bt-plate', fill: 'url(#bt-h-plate2)' });
      poly([[r1, t1], [plateHalf, t1], [plateHalf, grip], [r1, grip]], { class: 'bt-plate', fill: 'url(#bt-h-plate2)' });
    } else {
      // tapped base: threaded to le, drill a bit deeper
      const tEnd = t1 + le + 0.4 * d, drill = t1 + le + 0.9 * d, rDrill = (d - 1.0825 * P) / 2;
      for (const s of [-1, 1]) {
        const inner = prof(t1, tEnd, 0.05 * P, s).concat([[s * rDrill, tEnd], [s * rDrill, drill], [0, drill + rDrill * 0.6]]);
        poly([[s * plateHalf, t1], ...inner, [0, drill + rDrill * 0.6], [0, t1 + t2], [s * plateHalf, t1 + t2]], { class: 'bt-plate', fill: 'url(#bt-h-plate2)' });
      }
    }
    // ---- washers ----
    if (wsh) {
      const rw = p.washerD / 2, ri = (dh - 0.1) / 2;
      for (const s of [-1, 1]) poly([[s * ri, -wh], [s * rw, -wh], [s * rw, 0], [s * ri, 0]], { class: 'bt-washer', fill: 'url(#bt-h-washer)' });
      if (nut) for (const s of [-1, 1]) poly([[s * ri, grip], [s * rw, grip], [s * rw, grip + wh], [s * ri, grip + wh]], { class: 'bt-washer', fill: 'url(#bt-h-washer)' });
    }
    // ---- nut ----
    const nY0 = grip + wh, nY1 = nY0 + nutM;
    if (nut) {
      for (const s of [-1, 1]) {
        const c = 0.12 * nutM;
        const inner = prof(nY0, nY1, 0.05 * P, s);
        poly([...inner, [s * (nutW / 2 - c), nY1], [s * nutW / 2, nY1 - c], [s * nutW / 2, nY0 + c], [s * (nutW / 2 - c), nY0]],
          { class: 'bt-nut', fill: 'url(#bt-h-nut)' });
      }
    }
    // ---- bolt (one outline: head, shank, thread) ----
    const hy0 = -wh - headK, hy1 = -wh;
    const tail = 0.15 * d;
    const right = prof(hy1 + thStart, boltEnd - tail, 0, 1);
    const left = prof(hy1 + thStart, boltEnd - tail, 0, -1).reverse();
    const hc = hexHead ? 0.1 * headK : 0.08 * headK;
    const r3 = d3 / 2;
    const boltPts = [
      [-headW / 2 + hc, hy0], [headW / 2 - hc, hy0], [headW / 2, hy0 + hc], [headW / 2, hy1],
      [d / 2, hy1], [d / 2, hy1 + thStart],
      ...right,
      [r3, boltEnd - tail], [r3 - tail, boltEnd], [-(r3 - tail), boltEnd], [-r3, boltEnd - tail],
      ...left,
      [-d / 2, hy1 + thStart], [-d / 2, hy1], [-headW / 2, hy1], [-headW / 2, hy0 + hc],
    ];
    poly(boltPts, { class: `bt-bolt${over ? ' bt-over' : ''}` });
    if (!hexHead) {
      // hexagon socket recess with a 118 degree drill point
      const rk = (p.capKey * 1.1547) / 2, dep = 0.5 * headK;
      poly([[-rk, hy0], [rk, hy0], [rk, hy0 + dep], [0, hy0 + dep + rk * 0.6], [-rk, hy0 + dep]], { class: 'bt-socket' });
    } else {
      // hex head: the flats seen beyond the cut
      for (const s of [-1, 1]) sv(svg, 'line', { x1: X(s * headW / 4), x2: X(s * headW / 4), y1: Y(hy0 + hc * 0.3), y2: Y(hy1), class: 'bt-edge' });
    }
    // minor diameter, thin, and the axis
    for (const s of [-1, 1]) sv(svg, 'line', { x1: X(s * r3), x2: X(s * r3), y1: Y(hy1 + thStart), y2: Y(boltEnd - tail), class: 'bt-minor' });
    sv(svg, 'line', { x1: X(0), x2: X(0), y1: Y(hy0) - 14, y2: Y(yBot) + 14, class: 'bt-axis' });

    // ---- head bearing face (µK) and thread flanks (µG) ----
    for (const s of [-1, 1]) sv(svg, 'line', { x1: X(s * dh / 2), x2: X(s * dw / 2), y1: Y(hy1), y2: Y(hy1), class: 'bt-bearing' });
    const engY0 = nut ? nY0 : t1, engY1 = nut ? nY1 : t1 + le;
    for (const s of [-1, 1]) sv(svg, 'rect', { x: Math.min(X(s * d3 / 2), X(s * d / 2)) - 1, y: Y(engY0), width: Math.abs(X(d / 2) - X(d3 / 2)) + 2, height: (engY1 - engY0) * sc, class: 'bt-flanks' });

    // ---- clamp arrows: size follows the preload (log scale, 0.2 to 300 kN) ----
    const aLen = (kN) => 20 + 42 * clamp(Math.log(kN / 0.2) / Math.log(1500), 0, 1);
    const la = aLen(J.preloadMax), lb = aLen(J.preloadMin);
    const ax = plateHalf - 0.55 * d;
    const topY = Y(nut || true ? 0 : 0) - (wsh ? 0 : 0);
    const botY = nut ? Y(grip) : Y(t1);
    const arrow = (x, yTip, dir, len, cls, wBase) => {
      const w = wBase, hl = Math.min(len * 0.45, 12 + w);
      const y0 = yTip - dir * len, yh = yTip - dir * hl;
      sv(svg, 'path', { d: `M${x - w / 2},${y0} L${x + w / 2},${y0} L${x + w / 2},${yh} L${x + w / 2 + 5},${yh} L${x},${yTip} L${x - w / 2 - 5},${yh} L${x - w / 2},${yh} Z`, class: cls });
    };
    for (const s of [-1, 1]) {
      const x = X(s * ax);
      arrow(x, topY - 2, 1, la, 'bt-force-max', 8);
      arrow(x, topY - 2, 1, lb, 'bt-force', 8);
      arrow(x, botY + 2, -1, la, 'bt-force-max', 8);
      arrow(x, botY + 2, -1, lb, 'bt-force', 8);
    }
    const lx = narrow ? 6 : X(ax) + 12;
    const t = sv(svg, 'text', { x: lx, y: narrow ? 16 : topY - la + 10, class: 'bt-lab bt-lab-force' });
    sv(t, 'tspan', { x: lx, dy: 0 }, `F max ${f1(J.preloadMax)} kN`);
    sv(t, 'tspan', { x: lx, dy: 15, class: 'bt-soft' }, `F min ${f1(J.preloadMin)} kN`);

    // ---- tightening arc over the head ----
    const hx = headW / 2 * sc + 10, hy = Y(hy0) - 14;
    sv(svg, 'path', { d: `M${cx - hx},${hy + 4} Q${cx},${hy - 22} ${cx + hx},${hy + 4}`, class: 'bt-turn', 'marker-end': 'url(#bt-ar-dim)' });
    sv(svg, 'text', { x: cx, y: hy - 16, class: 'bt-lab bt-lab-torque', 'text-anchor': 'middle' }, `MA ${f1(J.torque)} N m`);

    // ---- dimensions: dw over the head bearing face, hole dh ----
    const dimH = (xa, xb, y, label, ext0) => {
      sv(svg, 'line', { x1: xa, x2: xa, y1: ext0, y2: y + 4, class: 'bt-ext' });
      sv(svg, 'line', { x1: xb, x2: xb, y1: ext0, y2: y + 4, class: 'bt-ext' });
      sv(svg, 'line', { x1: xa, x2: xb, y1: y, y2: y, class: 'bt-dim', 'marker-start': 'url(#bt-ar-dim)', 'marker-end': 'url(#bt-ar-dim)' });
      sv(svg, 'text', { x: (xa + xb) / 2, y: y - 4, class: 'bt-dimtxt', 'text-anchor': 'middle' }, label);
    };
    const botDimY = Y(yBot) + (nut ? 18 : 22);
    if (nut) dimH(X(-d / 2), X(d / 2), Y(boltEnd) + 16, `d ${J.d}`, Y(boltEnd) + 2);
    // leaders on the left: hole and bearing diameter
    const leftLab = (xp, yp, ty, text) => {
      const tx = narrow ? 4 : 8;
      sv(svg, 'path', { d: `M${xp},${yp} L${Math.max(tx + 50, xp - 30)},${ty} L${tx + 2},${ty}`, class: 'bt-leader' });
      sv(svg, 'text', { x: tx, y: ty - 4, class: 'bt-dimtxt' }, text);
    };
    leftLab(X(-dh / 2), Y(t1 * 0.5), Y(t1 * 0.5), `hole dh ${J.dh}`);
    leftLab(X(-dw / 2) + 2, Y(hy1) + 1, Y(hy1) - 22, `dw ${J.dw}`);
    sv(svg, 'circle', { cx: X(-dw / 2), cy: Y(hy1), r: 2.2, class: 'bt-dot' });

    // ---- friction spots, with leaders to labels on the right ----
    const rx = W - mR + 22;
    const spots = [];
    const spot = (key, xp, yp, ly, title, value, sub, bad) => {
      const g = sv(svg, 'g', { class: `bt-spot${bad ? ' bt-bad' : ''}`, tabindex: 0, role: 'button', 'aria-haspopup': 'menu',
        'aria-label': `${title} ${value}, change` });
      sv(g, 'path', { d: `M${xp + 8},${yp} L${rx - 14},${ly} L${rx - 4},${ly}`, class: 'bt-leader' });
      sv(g, 'circle', { cx: xp, cy: yp, r: 11, class: 'bt-spot-halo' });
      sv(g, 'circle', { cx: xp, cy: yp, r: 5.5, class: 'bt-spot-dot' });
      sv(g, 'rect', { x: rx - 4, y: ly - 17, width: mR - 26, height: 36, rx: 4, class: 'bt-spot-box' });
      sv(g, 'text', { x: rx + 4, y: ly - 3, class: 'bt-spot-t' }, `${title} ${value}`);
      sv(g, 'text', { x: rx + 4, y: ly + 12, class: 'bt-spot-s' }, sub);
      const open = () => openMenu(key, g);
      g.addEventListener('click', open);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        const step = { ArrowUp: 0.01, ArrowRight: 0.01, ArrowDown: -0.01, ArrowLeft: -0.01 }[e.key];
        if (step) {
          e.preventDefault();
          const cur = key === 'muK' ? J.muK : J.muG;
          ctx.set(key, String(Math.round(clamp(cur + step, 0.02, 0.5) * 100) / 100));
          focusAfter = `spot-${key}`;
        }
      });
      g.dataset.key = `spot-${key}`;
      spots.push(g);
    };
    const muBad = (m) => m < 0.04 || m > 0.3;
    const stainlessDry = /^A[24]/.test(J.grade) && J.muG < 0.15;
    spot('muK', X(DKm / 2), Y(hy1), Y(hy1) - 4, 'µK', J.muK.toFixed(2),
      J.muKGiven ? `head face · DKm ${f1(DKm)}` : `head face · = µG`, muBad(J.muK));
    const ty = Y((engY0 + engY1) / 2);
    spot('muG', X(d2 / 2), ty, Math.max(ty, Y(hy1) + 58), 'µG', J.muG.toFixed(2),
      stainlessDry ? 'flanks · lubricated?' : `flanks · d2 ${f1(d2)}`, muBad(J.muG) || stainlessDry);
    // pitch callout
    const pY = Y(nut ? (nY1 + boltEnd) / 2 : (t1 * 0.5 + 0));
    const pLy = Math.max(ty, Y(hy1) + 58) + 52;
    if (pLy < H - 10) {
      sv(svg, 'path', { d: `M${X(d / 2) + 2},${nut ? pY : ty + 20} L${rx - 14},${pLy} L${rx - 4},${pLy}`, class: 'bt-leader' });
      sv(svg, 'text', { x: rx + 4, y: pLy - 2, class: 'bt-dimtxt' }, `${J.size} × ${J.P}`);
      sv(svg, 'text', { x: rx + 4, y: pLy + 12, class: 'bt-dimtxt bt-soft' }, `As ${f1(J.As)} mm²`);
    }
    if (over) {
      sv(svg, 'text', { x: cx, y: Y((hy1 + thStart + boltEnd) / 2), class: 'bt-lab bt-lab-bad', 'text-anchor': 'middle',
        transform: `rotate(-90 ${cx} ${Y((hy1 + thStart + boltEnd) / 2)})` }, 'past yield');
    }
    if (!nut) sv(svg, 'text', { x: X(-plateHalf), y: Y(t1 + t2) + 16, class: 'bt-dimtxt bt-soft' }, `engaged ${f1(le)} (1.5 d); ≥ 2 d in aluminium`);
    sv(svg, 'text', { x: X(-plateHalf), y: H - 8, class: 'bt-dimtxt bt-soft' }, `to scale, ${f1(sc)} px/mm`);
    if (focusAfter) { const g = svg.querySelector(`[data-key="${focusAfter}"]`); focusAfter = null; g?.focus(); }
  }
  let focusAfter = null;

  // ---------- stress bar ----------
  let stressDrag = null;
  function drawStress() {
    const svg = stressSvg;
    svg.replaceChildren();
    const W = Math.max(110, svg.clientWidth || 130), H = Math.max(220, svg.clientHeight || 420);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const top = 14, bot = H - 26, bx = Math.min(W - 80, Math.max(90, W / 2)), bw = 22;
    const max = Math.max(J.rm, J.vonMises) * 1.05;
    const Y = (s) => bot - (bot - top) * (s / max);
    stressScale = { Y, max, top, bot };
    // yield to tensile: plastic zone
    sv(svg, 'rect', { x: bx, y: top, width: bw, height: bot - top, class: 'bt-sb-track' });
    sv(svg, 'rect', { x: bx, y: Y(max), width: bw, height: Y(J.rp) - Y(max), class: 'bt-sb-plastic' });
    // scatter band: tension at min .. max preload
    sv(svg, 'rect', { x: bx, y: Y(J.sigma), width: bw, height: Y(J.sigmaMin) - Y(J.sigma), class: 'bt-sb-band' });
    sv(svg, 'rect', { x: bx, y: Y(J.sigmaMin), width: bw, height: bot - Y(J.sigmaMin), class: 'bt-sb-sure' });
    const tick = (s, label, cls, side = 'r') => {
      sv(svg, 'line', { x1: bx - 3, x2: bx + bw + 3, y1: Y(s), y2: Y(s), class: cls });
      if (label) sv(svg, 'text', { x: side === 'r' ? bx + bw + 4 : bx - 6, y: Y(s) + 3.5, class: 'bt-sb-t', 'text-anchor': side === 'r' ? 'start' : 'end' }, label);
    };
    tick(J.rm, `Rm ${J.rm}`, 'bt-sb-lim');
    tick(J.rp, `Rp ${J.rp}`, 'bt-sb-yield');
    if (J.sp && Math.abs(Y(J.sp) - Y(J.rp)) > 11 && Math.abs(Y(J.sp) - Y(J.rm)) > 11) tick(J.sp, `Sp ${J.sp}`, 'bt-sb-lim');
    sv(svg, 'text', { x: bx + bw / 2, y: bot + 14, class: 'bt-sb-t', 'text-anchor': 'middle' }, '0');
    // labels on the left: sigma max, sigma min, von Mises target
    const labs = [
      { y: Y(J.vonMises), t: `vM ${f1(J.vonMises)}`, s: `${f1(J.util * 100)} % Rp`, cls: 'bt-sb-vm' },
      { y: Y(J.sigma), t: `σ ${f1(J.sigma)}`, s: 'F max', cls: '' },
      { y: Y(J.sigmaMin), t: `σ ${f1(J.sigmaMin)}`, s: 'F min', cls: '' },
    ];
    // keep labels apart
    labs.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labs.length; i++) labs[i].ly = Math.max(labs[i].y, (labs[i - 1].ly ?? labs[i - 1].y) + 26);
    labs[0].ly = labs[0].y;
    for (const l of labs) {
      sv(svg, 'path', { d: `M${bx - 2},${l.y} L${bx - 8},${l.ly}`, class: 'bt-leader' });
      sv(svg, 'text', { x: bx - 10, y: l.ly + 1, class: `bt-sb-v ${l.cls}`, 'text-anchor': 'end' }, l.t);
      sv(svg, 'text', { x: bx - 10, y: l.ly + 13, class: 'bt-sb-t', 'text-anchor': 'end' }, l.s);
    }
    // target handle (von Mises = utilisation x Rp): drag to set the target
    const tg = sv(svg, 'g', { class: `bt-handle${J.util > 1 ? ' bt-bad' : ''}`, tabindex: 0, role: 'slider', 'data-h': 'nu',
      'aria-label': 'Target utilisation of yield', 'aria-valuemin': 10, 'aria-valuemax': 110, 'aria-valuenow': Math.round(J.util * 100),
      'aria-valuetext': `${f1(J.util * 100)} % of yield` });
    sv(tg, 'rect', { x: bx - 4, y: Y(J.vonMises) - 3, width: bw + 8, height: 6, rx: 2 });
    // alpha-A handle at the bottom of the band
    const ag = sv(svg, 'g', { class: 'bt-handle bt-handle-a', tabindex: 0, role: 'slider', 'data-h': 'aa',
      'aria-label': 'Tightening factor alpha A', 'aria-valuemin': 1, 'aria-valuemax': 4, 'aria-valuenow': J.alphaA });
    sv(ag, 'rect', { x: bx + 3, y: Y(J.sigmaMin) - 2.5, width: bw - 6, height: 5, rx: 2 });
    if (Math.abs(Y(J.sigmaMin) - Y(J.rp)) > 12 && Math.abs(Y(J.sigmaMin) - Y(J.rm)) > 12) sv(svg, 'text', { x: bx + bw + 4, y: Y(J.sigmaMin) + 3.5, class: 'bt-sb-t bt-sb-a' }, `αA ${f1(J.alphaA)}`);
    for (const g of [tg, ag]) g.addEventListener('keydown', (e) => {
      const st = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
      if (!st) return; e.preventDefault();
      if (g.dataset.h === 'nu') ctx.set('nu', String(clamp(Math.round(J.util * 100) + st, 10, 110)));
      else ctx.set('alphaA', String(clamp(Math.round((J.alphaA - st * 0.1) * 10) / 10, 1, 4)));
      focusStress = g.dataset.h;
    });
    if (focusStress) { svg.querySelector(`[data-h="${focusStress}"]`)?.focus(); focusStress = null; }
  }
  let stressScale = null, focusStress = null;
  stressSvg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-h]');
    if (!g || !stressScale) return;
    stressDrag = g.dataset.h; capture(stressSvg, e); e.preventDefault();
  });
  stressSvg.addEventListener('pointermove', (e) => {
    if (!stressDrag) return;
    const r = stressSvg.getBoundingClientRect();
    const vb = stressSvg.viewBox.baseVal, y = ((e.clientY - r.top) / r.height) * vb.height;
    const { top, bot, max } = stressScale;
    const s = clamp(((bot - y) / (bot - top)) * max, 0, max);
    if (stressDrag === 'nu') { const nu = clamp(Math.round((s / J.rp) * 100), 10, 110); if (nu !== Math.round(J.util * 100)) ctx.set('nu', String(nu)); } else {
      const aa = clamp(Math.round((J.sigma / Math.max(1, s)) * 10) / 10, 1, 4);
      if (aa !== J.alphaA) ctx.set('alphaA', String(aa));
    }
  });
  const endStress = () => { stressDrag = null; };
  stressSvg.addEventListener('pointerup', endStress);
  stressSvg.addEventListener('pointercancel', endStress);

  // ---------- torque wrench dial ----------
  const A0 = -210, A1 = 30; // degrees, 0 = +x axis, clockwise positive on screen
  let dialMax = 1, dialDrag = false;
  const dcx = 130, dcy = 116, R = 88;
  const pol = (deg, r) => [dcx + r * Math.cos((deg * Math.PI) / 180), dcy + r * Math.sin((deg * Math.PI) / 180)];
  const angOf = (T) => A0 + (A1 - A0) * clamp(T / dialMax, 0, 1.02);
  function drawDial() {
    const svg = dialSvg;
    svg.replaceChildren();
    dialMax = niceCeil(J.torqueAtYield * 1.15, 6);
    const step = niceStep(dialMax, 6);
    const arc = (a, b, r, cls, w) => {
      const [x0, y0] = pol(a, r), [x1, y1] = pol(b, r);
      sv(svg, 'path', { d: `M${x0},${y0} A${r},${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x1},${y1}`, class: cls, 'stroke-width': w });
    };
    sv(svg, 'circle', { cx: dcx, cy: dcy, r: R + 14, class: 'bt-dial-face' });
    arc(A0, A1, R, 'bt-dial-track', 7);
    arc(angOf(J.torqueAtYield), A1, R, 'bt-dial-red', 7);
    arc(angOf(J.torqueAtYield * 0.8), angOf(J.torqueAtYield * 0.9), R, 'bt-dial-green', 7);
    for (let v = 0; v <= dialMax + 1e-9; v += step / 5) {
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      const a = angOf(v);
      const [x0, y0] = pol(a, R - (major ? 14 : 8)), [x1, y1] = pol(a, R - 4);
      sv(svg, 'line', { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? 'bt-dial-major' : 'bt-dial-minor' });
      if (major) { const [tx, ty] = pol(a, R - 26); sv(svg, 'text', { x: tx, y: ty + 4, class: 'bt-dial-num', 'text-anchor': 'middle' }, String(Number(v.toPrecision(4)))); }
    }
    { const [tx, ty] = pol(angOf(J.torqueAtYield) + 4, R + 7); sv(svg, 'text', { x: tx, y: ty, class: 'bt-dial-tag bt-bad-t' }, 'yield'); }
    { const [tx, ty] = pol(angOf(J.torqueAtYield * 0.85) , R + 9); sv(svg, 'text', { x: tx, y: ty, class: 'bt-dial-tag', 'text-anchor': 'middle' }, '80-90 %'); }
    const a = angOf(J.torque);
    const g = sv(svg, 'g', { class: `bt-needle${J.util > 1 ? ' bt-bad' : ''}`, tabindex: 0, role: 'slider', 'aria-label': 'Tightening torque, turn to change the target',
      'aria-valuemin': 0, 'aria-valuemax': dialMax, 'aria-valuenow': Number(J.torque.toPrecision(3)), 'aria-valuetext': `${f1(J.torque)} N m at ${f1(J.util * 100)} % of yield` });
    const [nx, ny] = pol(a, R - 6), [bx0, by0] = pol(a + 90, 4), [bx1, by1] = pol(a - 90, 4), [tx0, ty0] = pol(a + 180, 14);
    sv(g, 'path', { d: `M${bx0},${by0} L${nx},${ny} L${bx1},${by1} L${tx0},${ty0} Z` });
    sv(g, 'circle', { cx: dcx, cy: dcy, r: 6 });
    sv(g, 'circle', { cx: nx, cy: ny, r: 6, class: 'bt-needle-tip' });
    sv(svg, 'text', { x: dcx, y: dcy + 38, class: 'bt-dial-read', 'text-anchor': 'middle' }, f1(J.torque));
    sv(svg, 'text', { x: dcx, y: dcy + 54, class: 'bt-dial-unit', 'text-anchor': 'middle' }, `N m · ${f1(J.util * 100)} % of yield`);
    sv(svg, 'text', { x: dcx, y: dcy + 80, class: 'bt-dial-unit', 'text-anchor': 'middle' }, `yield at ${f1(J.torqueAtYield)} N m`);
    g.addEventListener('keydown', (e) => {
      const st = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
      if (!st) return; e.preventDefault();
      ctx.set('nu', String(clamp(Math.round(J.util * 100) + st, 10, 110))); focusDial = true;
    });
    if (focusDial) { g.focus(); focusDial = false; }
  }
  let focusDial = false;
  const dialAt = (e) => {
    const r = dialSvg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 260, y = ((e.clientY - r.top) / r.height) * 200;
    let deg = (Math.atan2(y - dcy, x - dcx) * 180) / Math.PI; // -180..180
    if (deg > 90) deg -= 360; // the gap sits at the bottom: map to -270..90
    if (deg < A0) deg = deg < A0 - 45 ? A1 : A0;
    const T = clamp((deg - A0) / (A1 - A0), 0, 1) * dialMax;
    const nu = clamp(Math.round(J.util * 100 * (T / J.torque)), 10, 110);
    if (nu !== Math.round(J.util * 100)) ctx.set('nu', String(nu));
  };
  dialSvg.addEventListener('pointerdown', (e) => {
    if (!J) return;
    const r = dialSvg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 260, y = ((e.clientY - r.top) / r.height) * 200;
    if (Math.hypot(x - dcx, y - dcy) > R + 16) return;
    dialDrag = true; capture(dialSvg, e); dialAt(e); e.preventDefault();
  });
  dialSvg.addEventListener('pointermove', (e) => { if (dialDrag) dialAt(e); });
  dialSvg.addEventListener('pointerup', () => { dialDrag = false; });
  dialSvg.addEventListener('pointercancel', () => { dialDrag = false; });

  function drawSplit() {
    const tp = J.torqueParts, tot = tp.pitch + tp.thread + tp.head;
    const seg = (v, cls, label) => h('div', { class: `bt-split-seg ${cls}`, style: `flex:${v / tot}`, title: `${label}: ${f1(v)} N m` });
    const pc = (v) => `${Math.round((100 * v) / tot)} %`;
    split.replaceChildren(
      h('div', { class: 'bt-split-bar' }, seg(tp.pitch, 'bt-sp-pitch', 'stretches the bolt'), seg(tp.thread, 'bt-sp-thread', 'thread friction'), seg(tp.head, 'bt-sp-head', 'head friction')),
      h('div', { class: 'bt-split-legend' },
        h('span', {}, h('i', { class: 'bt-sp-pitch' }), `stretch ${pc(tp.pitch)}`),
        h('span', {}, h('i', { class: 'bt-sp-thread' }), `thread ${pc(tp.thread)}`),
        h('span', {}, h('i', { class: 'bt-sp-head' }), `head ${pc(tp.head)}`)));
    const row = (k, v, u) => [h('dt', {}, k), h('dd', {}, v, u ? h('small', {}, ` ${u}`) : null)];
    facts.replaceChildren(
      ...row('Preload max', f1(J.preloadMax), 'kN'),
      ...row('Preload min', f1(J.preloadMin), 'kN'),
      ...row('Nut factor K', f1(J.nutFactor)),
      ...row('Of proof load', J.sp ? f1((J.sigma / J.sp) * 100) : '–', J.sp ? '%' : ''));
  }

  // ---------- torque against friction ----------
  let curveScale = null, curveDrag = false, hoverMu = null;
  function drawCurve() {
    const svg = curveSvg;
    svg.replaceChildren();
    const W = Math.max(280, svg.clientWidth || 600), H = Math.max(150, svg.clientHeight || 190);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 46, Rr = 48, T = 10, B = 26;
    const c = J.curve;
    const tMax = niceCeil(Math.max(...c.map((p) => p.torque)) * 1.05, 4);
    const fMax = niceCeil(Math.max(...c.map((p) => Math.max(p.preload, Math.min(p.preloadAtTorque, p.preload * 2)))) * 1.02, 4);
    const x0 = c[0].mu, x1 = c[c.length - 1].mu;
    const X = (m) => L + (W - L - Rr) * ((m - x0) / (x1 - x0));
    const YT = (v) => T + (H - T - B) * (1 - v / tMax);
    const YF = (v) => T + (H - T - B) * (1 - clamp(v / fMax, 0, 1.04));
    curveScale = { X, x0, x1, L, Rr, W };
    for (let k = 0; k <= 4; k++) {
      const y = T + ((H - T - B) * k) / 4;
      sv(svg, 'line', { x1: L, x2: W - Rr, y1: y, y2: y, class: 'bt-grid' });
      sv(svg, 'text', { x: L - 6, y: y + 3.5, class: 'bt-ax bt-ax-t', 'text-anchor': 'end' }, String(Number((tMax * (1 - k / 4)).toPrecision(3))));
      sv(svg, 'text', { x: W - Rr + 6, y: y + 3.5, class: 'bt-ax bt-ax-f' }, String(Number((fMax * (1 - k / 4)).toPrecision(3))));
    }
    for (let m = 0.05; m <= 0.301; m += 0.05) {
      sv(svg, 'text', { x: X(m), y: H - 9, class: 'bt-ax', 'text-anchor': 'middle' }, m.toFixed(2));
      sv(svg, 'line', { x1: X(m), x2: X(m), y1: H - B, y2: H - B + 4, class: 'bt-grid' });
    }
    sv(svg, 'text', { x: W - Rr, y: H - 9, class: 'bt-ax', 'text-anchor': 'end' }, '');
    // band: friction lower than assumed takes the bolt past the target (and past yield)
    const over = c.filter((p) => p.preloadAtTorque > p.preload);
    if (over.length) {
      const up = over.map((p) => `${X(p.mu)},${YF(p.preloadAtTorque)}`), dn = over.slice().reverse().map((p) => `${X(p.mu)},${YF(p.preload)}`);
      sv(svg, 'path', { d: `M${up.join('L')}L${dn.join('L')}Z`, class: 'bt-cv-over' });
    }
    const line = (key, Yf, cls) => sv(svg, 'path', { d: c.map((p, i) => `${i ? 'L' : 'M'}${X(p.mu).toFixed(1)},${Yf(p[key]).toFixed(1)}`).join(''), class: cls });
    line('preload', YF, 'bt-cv-f');
    line('preloadAtTorque', YF, 'bt-cv-fat');
    line('torque', YT, 'bt-cv-t');
    // the current point
    const mx = X(clamp(J.muG, x0, x1));
    sv(svg, 'line', { x1: mx, x2: mx, y1: T, y2: H - B, class: 'bt-cv-cur' });
    const g = sv(svg, 'g', { class: 'bt-cv-h', tabindex: 0, role: 'slider', 'aria-label': 'Thread friction µG', 'aria-valuemin': 0.04, 'aria-valuemax': 0.3,
      'aria-valuenow': J.muG, 'data-h': 'mu' });
    sv(g, 'circle', { cx: mx, cy: YT(J.torque), r: 6.5 });
    sv(svg, 'circle', { cx: mx, cy: YF(J.preloadMax), r: 3.5, class: 'bt-cv-fdot' });
    g.addEventListener('keydown', (e) => {
      const st = { ArrowRight: 0.01, ArrowUp: 0.01, ArrowLeft: -0.01, ArrowDown: -0.01 }[e.key];
      if (!st) return; e.preventDefault(); setMuG(J.muG + st); focusCurve = true;
    });
    if (focusCurve) { g.focus(); focusCurve = false; }
    // head: the readout at the hovered or current friction
    const m = hoverMu ?? J.muG;
    const p = c.reduce((a, b) => (Math.abs(b.mu - m) < Math.abs(a.mu - m) ? b : a));
    if (hoverMu != null) {
      sv(svg, 'line', { x1: X(p.mu), x2: X(p.mu), y1: T, y2: H - B, class: 'bt-cv-hover' });
    }
    curveHead.replaceChildren(
      h('span', { class: 'bt-cap' }, 'Against thread friction µG'),
      h('span', { class: 'bt-key' }, h('i', { class: 'bt-k-t' }), 'torque for the target, N m'),
      h('span', { class: 'bt-key' }, h('i', { class: 'bt-k-f' }), 'target preload, kN'),
      h('span', { class: 'bt-key' }, h('i', { class: 'bt-k-fat' }), `preload at ${f1(J.torque)} N m if µ is off`),
      h('span', { class: 'bt-cv-read' }, hoverMu != null
        ? `µ ${p.mu.toFixed(2)}: ${f1(p.torque)} N m for ${f1(p.preload)} kN; ${f1(J.torque)} N m gives ${f1(p.preloadAtTorque)} kN`
        : 'drag the dot to change µG'));
  }
  let focusCurve = false;
  function setMuG(m) {
    const v = Math.round(clamp(m, 0.04, 0.3) * 100) / 100;
    if (Math.abs(v - J.muG) < 1e-9) return;
    // a head friction set apart from the thread keeps its ratio
    if (J.muKGiven) ctx.setMany({ muG: String(v), muK: String(Math.round(v * (J.muK / J.muG) * 100) / 100) });
    else ctx.set('muG', String(v));
  }
  const muAt = (e) => {
    const r = curveSvg.getBoundingClientRect();
    const { X, x0, x1, L, Rr, W } = curveScale;
    const x = ((e.clientX - r.left) / r.width) * W;
    void X;
    return x0 + ((x - L) / (W - L - Rr)) * (x1 - x0);
  };
  curveSvg.addEventListener('pointerdown', (e) => {
    if (!curveScale) return;
    curveDrag = true; capture(curveSvg, e); setMuG(muAt(e)); e.preventDefault();
  });
  curveSvg.addEventListener('pointermove', (e) => {
    if (!curveScale) return;
    if (curveDrag) { setMuG(muAt(e)); return; }
    const m = muAt(e);
    hoverMu = m >= curveScale.x0 - 0.005 && m <= curveScale.x1 + 0.005 ? m : null;
    drawCurve();
  });
  curveSvg.addEventListener('pointerleave', () => { if (!curveDrag) { hoverMu = null; drawCurve(); } });
  curveSvg.addEventListener('pointerup', () => { curveDrag = false; });
  curveSvg.addEventListener('pointercancel', () => { curveDrag = false; });

  // ---------- all together ----------
  function draw() {
    const raw = ctx.raw;
    classStrip.sync(raw.grade); headSeg.sync(raw.head); jointSeg.sync(view.joint);
    washerBtn.setAttribute('aria-pressed', String(!!view.washer));
    nuField.sync(raw.nu); aaField.sync(raw.alphaA);
    rungs.forEach((b) => { const on = b.dataset.v === raw.size; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    const warns = res?.warnings || [];
    stageWarn.replaceChildren(...warns.map((w) => h('div', {}, w)));
    if (!J) { stageSvg.replaceChildren(); return; }
    drawSection(); drawStress(); drawDial(); drawSplit(); drawCurve();
  }
  ctx.onResult((r) => { res = r; J = r.joint || null; if (menu && J) { /* keep the menu, refresh its marks */ } draw(); });
  // Redraw when a drawing box changes size (once per frame, only on a real change).
  let sizes = '', rafId = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      const now = [stageSvg, stressSvg, curveSvg].map((e) => `${e.clientWidth}x${e.clientHeight}`).join();
      if (now === sizes || !J) return;
      sizes = now; drawSection(); drawStress(); drawCurve();
    });
  }).observe(layout);
}
