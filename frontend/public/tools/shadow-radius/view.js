// Shadow & Radius Studio: the page is a light table.
//   Stage    - the card itself at 1:1 with the real box-shadow and radius, lit by
//              a lamp on a ring around it: drag the lamp (or anywhere on the
//              table) to aim the light. The top-right corner carries the
//              radius knob with its concentric arcs, the nested element's
//              padding has a grip, and the shadow's reach is dimensioned
//              below and beside the card.
//   Section  - the card cut along the light: lift the slab to change the
//              elevation (distance); under it every layer's footprint on the
//              table, offset, blurred and spread, with handles for softness,
//              spread and total darkness.
//   Levels   - the five-step elevation scale as real cards; click one to take
//              its elevation.
// Every number shown comes from run()'s result (drawing and stage).

const NS = 'http://www.w3.org/2000/svg';
const SWATCHES = ['hsl(220 40% 12%)', 'hsl(250 45% 20%)', 'hsl(25 50% 14%)', 'hsl(165 45% 11%)', '#000000'];
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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = (d) => (d * Math.PI) / 180;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

export function page(root, ctx) {
  const F = (v, d = 3) => ctx.fmtNum(v, d);
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('style.css', import.meta.url).href;
  document.head.append(link);
  const BGKEY = `redline.tool.${ctx.manifest.id}.table`;

  let res = null;
  let table = store.get(BGKEY) || 'paper';

  // ---------------- spec strip: every input as a number, the keyboard path ----------------
  const num = (key, label, unit, width = 46) => {
    const el = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', class: 'sr-num', style: `width:${width}px`,
      'data-key': key, 'aria-label': `${label}${unit ? ` in ${unit}` : ''}`, oninput: (e) => ctx.set(key, e.target.value) });
    return h('label', { class: 'sr-fld' }, h('span', {}, label), el, unit ? h('i', {}, unit) : null);
  };
  const layersOut = h('output', { class: 'sr-stepv' });
  const bumpLayers = (d) => ctx.set('layers', String(clamp(Math.round(Number(ctx.raw.layers) || 5) + d, 1, 8)));
  const colorIn = h('input', { type: 'text', spellcheck: 'false', class: 'sr-num', style: 'width:132px', 'data-key': 'color', 'aria-label': 'Shadow colour',
    oninput: (e) => ctx.set('color', e.target.value) });
  const chip = h('span', { class: 'sr-chip', 'aria-hidden': 'true' });
  const swatches = h('span', { class: 'sr-sw', role: 'group', 'aria-label': 'Shadow colour presets' },
    SWATCHES.map((c) => h('button', { type: 'button', class: 'sr-swb', title: c, 'aria-label': `Shadow colour ${c}`, 'data-c': c,
      style: `background:${c}`, onclick: () => ctx.set('color', c) })));
  const insetSeg = h('span', { class: 'sr-seg', role: 'group', 'aria-label': 'Shadow type' },
    h('button', { type: 'button', 'data-inset': 'false', onclick: () => ctx.set('inset', false) }, 'Drop'),
    h('button', { type: 'button', 'data-inset': 'true', onclick: () => ctx.set('inset', true) }, 'Inset'));
  const spec = h('div', { class: 'sr-spec' },
    h('div', { class: 'sr-grp' }, h('b', {}, 'Light'), num('angle', 'direction', '°', 44), num('distance', 'elevation', 'px', 40)),
    h('div', { class: 'sr-grp' }, h('b', {}, 'Shadow'),
      h('label', { class: 'sr-fld' }, h('span', {}, 'layers'), h('span', { class: 'sr-stepper', role: 'group', 'aria-label': 'Layers' },
        h('button', { type: 'button', 'aria-label': 'Fewer layers', onclick: () => bumpLayers(-1) }, '−'), layersOut,
        h('button', { type: 'button', 'aria-label': 'More layers', onclick: () => bumpLayers(1) }, '+'))),
      num('softness', 'softness', '', 34), num('spread', 'spread', 'px', 36), num('opacity', 'opacity', '', 40), insetSeg),
    h('div', { class: 'sr-grp' }, h('b', {}, 'Colour'), chip, colorIn, swatches),
    h('div', { class: 'sr-grp' }, h('b', {}, 'Corners'), num('radius', 'radius', 'px', 36), num('padding', 'padding', 'px', 36)));

  // ---------------- stage ----------------
  const inner = h('div', { class: 'sr-inner' }, h('span', { class: 'sr-inner-t' }, 'nested element'));
  const card = h('div', { class: 'sr-card' }, inner);
  const over = sv('svg', { class: 'sr-over', role: 'group', 'aria-label': 'Light table: drag the lamp to aim the light' });
  const tableSeg = h('div', { class: 'sr-seg sr-tableseg', role: 'group', 'aria-label': 'Table colour' },
    [['paper', 'Paper'], ['surface', 'Surface'], ['sunken', 'Sunken']].map(([v, t]) => h('button', { type: 'button', 'data-table': v,
      onclick: () => { table = v; store.set(BGKEY, v); syncTable(); } }, t)));
  const stageHint = h('div', { class: 'sr-hint' }, 'drag the lamp or the table to aim the light · the corner knob sets the radius · the grip inside sets the padding');
  const stage = h('div', { class: 'sr-stage' }, card, over, tableSeg, stageHint);
  const stageWarn = h('div', { class: 'sr-stagewarn', 'aria-live': 'polite' });

  // ---------------- levels ----------------
  const levels = h('div', { class: 'sr-levels', role: 'group', 'aria-label': 'Elevation scale' });

  // ---------------- section ----------------
  const secSvg = sv('svg', { class: 'sr-sec', role: 'group', 'aria-label': 'Section along the light' });
  const secNote = h('span', { class: 'sr-sub' });
  const section = h('section', { class: 'sr-panel' }, h('div', { class: 'sr-phead' }, h('span', { class: 'sr-h' }, 'Section along the light'), secNote), secSvg);
  const warns = h('div', { class: 'sr-warns', 'aria-live': 'polite' });
  const notes = h('details', { class: 'sr-notes' });

  root.classList.add('sr-root');
  ctx.outputs.classList.add('sr-out');
  root.append(h('div', { class: 'sr' },
    h('div', { class: 'sr-main' }, spec, h('div', { class: 'sr-stagewrap' }, stage, stageWarn), levels),
    h('aside', { class: 'sr-side' }, section, warns, ctx.outputs, notes)));
  let tabChosen = null;
  try { tabChosen = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }

  // ---------------- helpers ----------------
  const keepFocus = (fn) => {
    const k = document.activeElement?.dataset?.focus;
    fn();
    if (k) root.querySelector(`[data-focus="${k}"]`)?.focus({ preventScroll: true });
  };
  const drag = (el, onMove, onStart) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const st = onStart(e);
      if (!st) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      root.classList.add('sr-dragging');
      const move = (ev) => onMove(ev, st);
      const up = () => { root.classList.remove('sr-dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      onMove(e, st);
    });
  };
  const arrows = (e) => (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0);
  const setIf = (key, v) => { if (String(v) !== String(ctx.raw[key])) ctx.set(key, String(v)); };
  const syncTable = () => {
    stage.dataset.table = table;
    for (const b of tableSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.table === table));
  };

  // ---------------- stage drawing ----------------
  let geo = null;
  function drawStage() {
    const d = res.drawing, s = res.stage;
    const W = stage.clientWidth || 600, H = stage.clientHeight || 420;
    const narrow = W < 520;
    const cw = Math.round(clamp(W * 0.36, 180, 320)), ch = Math.round(cw * 0.62);
    const cx = Math.round(W / 2), cy = Math.round(H / 2 - (narrow ? 4 : 10));
    const pad = Math.min(d.padding, Math.min(cw, ch) / 2 - 8);
    Object.assign(card.style, { width: `${cw}px`, height: `${ch}px`, left: `${cx - cw / 2}px`, top: `${cy - ch / 2}px`,
      borderRadius: `${d.radius}px`, boxShadow: d.shadow, padding: `${Math.max(0, pad)}px` });
    inner.style.borderRadius = `${d.inner}px`;
    over.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = cx - cw / 2, T = cy - ch / 2, R = cx + cw / 2, B = cy + ch / 2;
    const ring = Math.min(W / 2, H / 2) - 26;
    geo = { cx, cy, L, T, R, B, cw, ch, ring };
    const g = [];
    // The lamp ring and the light's path.
    g.push(sv('circle', { cx, cy, r: ring, class: 'sr-ring' }));
    for (let k = 0; k < 360; k += 15) {
      const a = rad(k), r1 = ring - (k % 45 ? 3 : 6);
      g.push(sv('line', { x1: cx + Math.sin(a) * r1, y1: cy - Math.cos(a) * r1, x2: cx + Math.sin(a) * ring, y2: cy - Math.cos(a) * ring, class: 'sr-tick' }));
    }
    const a = rad(d.angle);
    const lx = cx - Math.sin(a) * ring, ly = cy + Math.cos(a) * ring;
    // Shadow direction: an arrow from the card's far edge, the way the shadow falls.
    const edgeT = Math.min(Math.abs(Math.sin(a)) > 1e-6 ? (cw / 2) / Math.abs(Math.sin(a)) : Infinity, Math.abs(Math.cos(a)) > 1e-6 ? (ch / 2) / Math.abs(Math.cos(a)) : Infinity);
    g.push(sv('line', { x1: lx, y1: ly, x2: cx - Math.sin(a) * edgeT, y2: cy + Math.cos(a) * edgeT, class: 'sr-ray' }));
    const sx = cx + Math.sin(a) * (edgeT + 10), sy = cy - Math.cos(a) * (edgeT + 10);
    const ex = cx + Math.sin(a) * (edgeT + 40), ey = cy - Math.cos(a) * (edgeT + 40);
    g.push(sv('line', { x1: sx, y1: sy, x2: ex, y2: ey, class: 'sr-dir', 'marker-end': 'url(#sr-arrow)' }));
    const defs = sv('defs');
    const mk = sv('marker', { id: 'sr-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    mk.append(sv('path', { d: 'M0,0 L10,5 L0,10 z', class: 'sr-arrowhead' }));
    defs.append(mk); g.unshift(defs);

    // Reach: how far the shadow spreads past the box, dimensioned at 1:1.
    if (!s.inset) {
      const dim = (x1, y1, x2, y2, txt, tx, ty, anchor = 'middle') => {
        g.push(sv('line', { x1, y1, x2, y2, class: 'sr-dim' }));
        const vert = x1 === x2;
        for (const [x, y] of [[x1, y1], [x2, y2]]) g.push(sv('line', vert ? { x1: x - 4, x2: x + 4, y1: y, y2: y, class: 'sr-dim' } : { x1: x, x2: x, y1: y - 4, y2: y + 4, class: 'sr-dim' }));
        g.push(sv('text', { x: tx, y: ty, 'text-anchor': anchor, class: 'sr-dimtxt' }, txt));
      };
      const rb = s.reach.bottom, rr = s.reach.right, rl = s.reach.left, rt = s.reach.top;
      if (rb > 0.5 && B + rb < H - 6) dim(cx + cw / 4, B, cx + cw / 4, B + rb, `reach ${F(rb)} px`, cx + cw / 4 + 7, B + rb / 2 + 4, 'start');
      else if (rb > 0.5) g.push(sv('text', { x: cx + cw / 4 + 7, y: H - 10, class: 'sr-dimtxt' }, `reach ${F(rb)} px below`));
      const side = rr >= rl ? { v: rr, x1: R, x2: R + rr } : { v: rl, x1: L - rl, x2: L };
      const sy2 = cy + ch / 4;
      if (side.v > 0.5 && side.x1 > 6 && side.x2 < W - 6) dim(side.x1, sy2, side.x2, sy2, `${F(side.v)}`, (side.x1 + side.x2) / 2, sy2 - 6);
      if (rt > 0.5 && T - rt > 6) dim(cx - cw / 4, T - rt, cx - cw / 4, T, `${F(rt)}`, cx - cw / 4 - 7, T - rt / 2 + 4, 'end');
    }

    // Corner radius: the knob sits on the arc, on the corner's diagonal.
    const r = Math.min(d.radius, cw / 2, ch / 2);
    const k = r * (1 - Math.SQRT1_2);
    const ox = R - r, oy = T + r; // the arcs' shared centre
    const ir = Math.max(0, d.radius - d.padding);
    const bad = d.radius > 0 && d.padding > 0 && d.radius < d.padding;
    if (r > 0) {
      g.push(sv('circle', { cx: ox, cy: oy, r: 2, class: 'sr-ctr' }));
      g.push(sv('path', { d: `M${ox},${oy} L${R},${oy}`, class: 'sr-rline' }));
      g.push(sv('path', { d: `M${ox},${oy} L${ox},${T}`, class: 'sr-rline' }));
      if (ir > 0 && d.padding > 0) g.push(sv('path', { d: `M${ox},${oy - ir} A${ir},${ir} 0 0 1 ${ox + ir},${oy}`, class: 'sr-iarc' }));
    }
    g.push(sv('text', { x: R + 10, y: T - 8, class: 'sr-rtxt' }, `r ${F(d.radius)}`));
    const knob = sv('g', { class: 'sr-knob', tabindex: '0', role: 'slider', 'data-focus': 'radius', 'aria-label': 'Corner radius, px',
      'aria-valuenow': String(d.radius), 'aria-valuemin': '0', 'aria-valuemax': String(Math.floor(Math.min(cw, ch) / 2)) });
    knob.append(sv('title', {}, 'Corner radius: drag along the diagonal'));
    const kx = R - k, ky = T + k;
    knob.append(sv('circle', { cx: kx, cy: ky, r: 14, class: 'sr-hit' }));
    knob.append(sv('rect', { x: kx - 5, y: ky - 5, width: 10, height: 10, transform: `rotate(45 ${kx} ${ky})`, class: 'sr-knobmark' }));
    knob.addEventListener('keydown', (e) => { const dd = arrows(e); if (!dd) return; e.preventDefault(); setIf('radius', clamp(Math.round(d.radius + dd * (e.shiftKey ? 4 : 1)), 0, 200)); });
    g.push(knob);

    // Padding: a grip on the nested element's left edge, dimensioned from the card edge.
    const iL = L + pad, iT = T + pad, iR = R - pad;
    const my = cy + (narrow ? 0 : 6);
    if (pad > 0) {
      g.push(sv('line', { x1: L, y1: my - 22, x2: iL, y2: my - 22, class: 'sr-dim' }));
      for (const x of [L, iL]) g.push(sv('line', { x1: x, x2: x, y1: my - 26, y2: my - 18, class: 'sr-dim' }));
      g.push(sv('text', { x: iL + 5, y: my - 18, class: 'sr-dimtxt' }, `pad ${F(d.padding)}`));
    }
    const grip = sv('g', { class: 'sr-grip', tabindex: '0', role: 'slider', 'data-focus': 'padding', 'aria-label': 'Padding of the nested element, px',
      'aria-valuenow': String(d.padding), 'aria-valuemin': '0', 'aria-valuemax': '80' });
    grip.append(sv('title', {}, 'Padding: drag sideways'));
    grip.append(sv('rect', { x: iL - 9, y: my - 16, width: 18, height: 32, class: 'sr-hit' }));
    grip.append(sv('rect', { x: iL - 2.5, y: my - 11, width: 5, height: 22, rx: 2, class: 'sr-gripmark' }));
    grip.addEventListener('keydown', (e) => { const dd = arrows(e); if (!dd) return; e.preventDefault(); setIf('padding', clamp(Math.round(d.padding + dd * (e.shiftKey ? 4 : 1)), 0, 80)); });
    g.push(grip);
    // Inner radius label at the nested element's corner.
    g.push(sv('text', { x: iR - 6, y: iT + 14, 'text-anchor': 'end', class: `sr-irtxt${bad ? ' sr-bad' : ''}` },
      bad ? `r 0 · radius < padding` : `r ${F(d.inner)} = ${F(d.radius)} − ${F(d.padding)}`));

    // The lamp.
    const lamp = sv('g', { class: 'sr-lamp', tabindex: '0', role: 'slider', 'data-focus': 'lamp', 'aria-label': 'Light direction (shadow falls opposite), degrees',
      'aria-valuenow': String(d.angle), 'aria-valuemin': '0', 'aria-valuemax': '359' });
    lamp.append(sv('title', {}, 'Lamp: drag around the ring'));
    lamp.append(sv('circle', { cx: lx, cy: ly, r: 17, class: 'sr-hit' }));
    for (let j = 0; j < 8; j++) {
      const t = (j * Math.PI) / 4;
      lamp.append(sv('line', { x1: lx + Math.cos(t) * 10, y1: ly + Math.sin(t) * 10, x2: lx + Math.cos(t) * 14, y2: ly + Math.sin(t) * 14, class: 'sr-lampray' }));
    }
    lamp.append(sv('circle', { cx: lx, cy: ly, r: 7, class: 'sr-lampbody' }));
    const lt = `${F(d.angle)}°`;
    const lxT = lx + (lx < cx - 4 ? -22 : lx > cx + 4 ? 22 : 0), lyT = ly + (Math.abs(lx - cx) < 30 ? (ly < cy ? -22 : 30) : 4);
    lamp.append(sv('text', { x: lxT, y: lyT, 'text-anchor': lx < cx - 4 ? 'end' : lx > cx + 4 ? 'start' : 'middle', class: 'sr-lamptxt' }, lt));
    lamp.addEventListener('keydown', (e) => {
      const dd = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dd) return; e.preventDefault();
      setIf('angle', ((Math.round(d.angle) + dd * (e.shiftKey ? 1 : 5)) % 360 + 360) % 360);
    });
    g.push(lamp);
    keepFocus(() => over.replaceChildren(...g));

    // Warnings where they show: on the stage.
    const w = [];
    if (bad) w.push('radius smaller than padding: the nested corner can only be square');
    if (s.opacity > 0.5) w.push(`opacity ${F(s.opacity)}: heavy on light tables`);
    if (/^(0|#0{3}|#0{6}|black)$/i.test(String(ctx.raw.color).trim())) w.push('pure black shadow: tint it with the table hue');
    stageWarn.replaceChildren(...w.map((t) => h('span', {}, t)));
    stageWarn.hidden = !w.length;
  }
  drag(over, (e, st) => {
    if (!geo) return;
    const rct = over.getBoundingClientRect();
    const x = e.clientX - rct.left, y = e.clientY - rct.top;
    if (st.what === 'lamp') {
      const dx = x - geo.cx, dy = y - geo.cy;
      if (Math.hypot(dx, dy) < 4) return;
      const L = (Math.atan2(dx, -dy) * 180) / Math.PI; // where the light is
      setIf('angle', ((Math.round(L + 180) % 360) + 360) % 360);
    } else if (st.what === 'radius') {
      const t = ((geo.R - x) + (y - geo.T)) / Math.SQRT2;
      setIf('radius', clamp(Math.round(t / (Math.SQRT2 - 1)), 0, Math.floor(Math.min(geo.cw, geo.ch) / 2)));
    } else if (st.what === 'padding') {
      setIf('padding', clamp(Math.round(x - geo.L), 0, Math.floor(Math.min(geo.cw, geo.ch) / 2 - 8)));
    }
  }, (e) => {
    const t = e.target.closest?.('.sr-knob, .sr-grip, .sr-lamp');
    if (t?.classList.contains('sr-knob')) return { what: 'radius' };
    if (t?.classList.contains('sr-grip')) return { what: 'padding' };
    return { what: 'lamp' };
  });

  // ---------------- section drawing ----------------
  let sg = null;
  function drawSection() {
    const d = res.drawing, s = res.stage;
    const W = Math.max(280, secSvg.clientWidth || 400);
    const a = rad(d.angle);
    // The card's width along the light, at the stage's size.
    const cw = geo ? geo.cw : 300, ch = geo ? geo.ch : 186;
    const E = Math.abs(Math.sin(a)) * cw + Math.abs(Math.cos(a)) * ch;
    const lay = s.layers.map((l) => {
      const o = l.x * Math.sin(a) - l.y * Math.cos(a);
      return { ...l, o, lo: -E / 2 + o - l.spread, hi: E / 2 + o + l.spread };
    });
    const umin = Math.min(-E / 2, ...lay.map((l) => l.lo - l.blur)), umax = Math.max(E / 2, ...lay.map((l) => l.hi + l.blur));
    const M = 14, RM = 104, sc = (W - M - RM) / (umax - umin);
    const U = (u) => M + (u - umin) * sc;
    const ZMAX = 96, kz = 1.1;
    const yG = 34 + ZMAX * kz + 14;              // the table
    const rowH = 25;
    const rowsTop = yG + 34;
    const H = rowsTop + lay.length * rowH + 22;
    secSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); secSvg.setAttribute('height', H);
    sg = { U, sc, umin, E, yG, kz, lay, W };
    const g = [];
    const defs = sv('defs');
    g.push(defs);
    const band = (l, i, y, hgt, cls, op) => {
      const id = `sr-g${i}`;
      const lg = sv('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: U(l.lo - l.blur), x2: U(l.hi + l.blur), y1: 0, y2: 0 });
      const span = (l.hi + l.blur) - (l.lo - l.blur) || 1;
      const st = (u) => clamp((u - (l.lo - l.blur)) / span, 0, 1);
      const both = l.blur > 0;
      for (const [off, o] of both ? [[0, 0], [st(l.lo + l.blur), 1], [st(l.hi - l.blur), 1], [1, 0]] : [[0, 1], [1, 1]]) {
        lg.append(sv('stop', { offset: off, class: 'sr-stop', 'stop-opacity': o * op }));
      }
      defs.append(lg);
      g.push(sv('rect', { x: U(l.lo - l.blur), y, width: Math.max(1, U(l.hi + l.blur) - U(l.lo - l.blur)), height: hgt, fill: `url(#${id})`, class: cls }));
    };
    // The composite on the table: each layer at its own alpha (drawn 3x darker to be seen).
    lay.forEach((l, i) => band(l, `c${i}`, yG + 1, 12, 'sr-comp', Math.min(1, l.alpha * 3)));
    g.push(sv('line', { x1: 4, x2: W - 4, y1: yG, y2: yG, class: 'sr-ground' }));
    g.push(sv('text', { x: 4, y: yG + 26, class: 'sr-lbl' }, `on the table · ${s.n} layer${s.n > 1 ? 's' : ''} add up to opacity ${F(s.opacity)}`));

    // The card, lifted.
    const yS = yG - 4 - d.distance * kz;
    const cardTop = Math.max(4, yS - 10);
    g.push(sv('line', { x1: U(0), x2: U(0), y1: yS, y2: yG, class: 'sr-dim' }));
    g.push(sv('text', { x: U(umax) + 8, y: Math.max(cardTop + 10, (yS + yG) / 2 + 4), class: 'sr-dimtxt' }, `↕ ${F(d.distance)} px`));
    g.push(sv('text', { x: U(umax) + 8, y: Math.max(cardTop + 10, (yS + yG) / 2 + 4) + 13, class: 'sr-lbl' }, 'elevation'));
    const slab = sv('g', { class: 'sr-slab', tabindex: '0', role: 'slider', 'data-focus': 'slab', 'aria-label': 'Elevation (shadow distance), px',
      'aria-valuenow': String(d.distance), 'aria-valuemin': '0', 'aria-valuemax': String(ZMAX) });
    slab.append(sv('title', {}, 'Elevation: drag the card up or down'));
    slab.append(sv('rect', { x: U(-E / 2), y: cardTop - 6, width: U(E / 2) - U(-E / 2), height: 22, class: 'sr-hit' }));
    slab.append(sv('rect', { x: U(-E / 2), y: cardTop, width: U(E / 2) - U(-E / 2), height: yS - cardTop + 0.01 || 1, rx: 2, class: 'sr-slabmark' }));
    slab.append(sv('rect', { x: U(0) - 10, y: cardTop + (yS - cardTop) / 2 - 1.5, width: 20, height: 3, rx: 1.5, class: 'sr-slabgrip' }));
    slab.addEventListener('keydown', (e) => { const dd = arrows(e); if (!dd) return; e.preventDefault(); setIf('distance', clamp(Math.round(d.distance + dd * (e.shiftKey ? 4 : 1)), 0, ZMAX)); });
    // The light: rays from the lamp's side past the card's edges.
    const lampSide = -1; // along the section the light always comes from the left
    g.push(sv('text', { x: 6, y: 14, class: 'sr-lbl' }, `light from ${F((d.angle + 180) % 360)}°`));
    g.push(sv('line', { x1: U(-E / 2) + lampSide * 30, y1: 18, x2: U(-E / 2), y2: cardTop, class: 'sr-ray' }));

    // One row per layer: its footprint, offset by o, grown by spread, blurred by blur.
    lay.forEach((l, i) => {
      const y = rowsTop + i * rowH;
      g.push(sv('text', { x: M, y: y + 9, class: 'sr-rowtxt' },
        `${i + 1}  x ${F(l.x)}  y ${F(l.y)}  blur ${F(l.blur)}${l.spread ? `  spread ${F(l.spread)}` : ''}  α ${F(l.alpha)}`));
      band(l, i, y + 13, 7, 'sr-row', 0.6);
      g.push(sv('rect', { x: U(-E / 2), y: y + 12, width: U(E / 2) - U(-E / 2), height: 9, class: 'sr-boxghost' }));
    });
    // Softness and spread handles on the largest layer.
    const big = lay[lay.length - 1];
    const yb = rowsTop + (lay.length - 1) * rowH + 16.5;
    const dbad = s.spread < 0 && -s.spread > d.distance;
    if (dbad) g.push(sv('text', { x: U(0), y: yG - 6, 'text-anchor': 'middle', class: 'sr-badtxt' }, 'spread pulls it under the card'));
    const hnd = (cls, x, focus, label, now, onKey) => {
      const e = sv('g', { class: `sr-sh ${cls}`, tabindex: '0', role: 'slider', 'data-focus': focus, 'aria-label': label, 'aria-valuenow': String(now) });
      e.append(sv('rect', { x: x - 8, y: yb - 11, width: 16, height: 22, class: 'sr-hit' }));
      e.append(sv('path', { d: cls === 'sr-soft' ? `M${x},${yb - 7} l5,7 l-5,7 l-5,-7 z` : `M${x - 1.5},${yb - 8} h3 v16 h-3 z`, class: 'sr-shmark' }));
      e.addEventListener('keydown', (ev) => { const dd = arrows(ev); if (!dd) return; ev.preventDefault(); onKey(dd, ev.shiftKey); });
      g.push(e);
    };
    if (d.distance > 0) {
      hnd('sr-soft', U(big.hi + big.blur), 'soft', 'Softness (blur = 2 × softness × offset)', s.softness,
        (dd, sh) => setIf('softness', clamp(Math.round((s.softness + dd * (sh ? 0.5 : 0.1)) * 100) / 100, 0, 6)));
      g.push(sv('text', { x: Math.min(W - 4, U(big.hi + big.blur) + 4), y: yb + 22, 'text-anchor': U(big.hi + big.blur) > W - 70 ? 'end' : 'start', class: 'sr-lbl' }, `softness ${F(s.softness)}`));
    }
    hnd('sr-spread', U(big.hi), 'spread', 'Spread, px', s.spread,
      (dd, sh) => setIf('spread', clamp(Math.round(s.spread + dd * (sh ? 4 : 1)), -64, 64)));
    // Darkness: a handle on the table's right end, up is darker.
    const oy = yG + 7 - 0;
    const opg = sv('g', { class: 'sr-op', tabindex: '0', role: 'slider', 'data-focus': 'op', 'aria-label': 'Total opacity', 'aria-valuenow': String(s.opacity), 'aria-valuemin': '0.01', 'aria-valuemax': '1' });
    const ox0 = W - 12, oTop = yG - 70, oBot = yG - 6;
    opg.append(sv('rect', { x: ox0 - 10, y: oTop - 6, width: 20, height: oBot - oTop + 12, class: 'sr-hit' }));
    opg.append(sv('line', { x1: ox0, x2: ox0, y1: oTop, y2: oBot, class: 'sr-optrack' }));
    const oyv = oBot - (oBot - oTop) * clamp(s.opacity, 0, 1);
    opg.append(sv('line', { x1: ox0, x2: ox0, y1: oyv, y2: oBot, class: `sr-opfill${s.opacity > 0.5 ? ' sr-bad' : ''}` }));
    opg.append(sv('circle', { cx: ox0, cy: oyv, r: 5, class: 'sr-opmark' }));
    opg.append(sv('text', { x: ox0 + 4, y: oTop - 22, 'text-anchor': 'end', class: 'sr-lbl' }, 'opacity'));
    opg.append(sv('text', { x: ox0 + 4, y: oTop - 10, 'text-anchor': 'end', class: `sr-dimtxt${s.opacity > 0.5 ? ' sr-badtxt' : ''}` }, F(s.opacity)));
    opg.addEventListener('keydown', (e) => { const dd = arrows(e); if (!dd) return; e.preventDefault(); setIf('opacity', clamp(Math.round((s.opacity + dd * (e.shiftKey ? 0.1 : 0.02)) * 100) / 100, 0.01, 1)); });
    sg.op = { top: oTop, bot: oBot };
    void oy;
    g.push(slab, opg);
    keepFocus(() => secSvg.replaceChildren(...g));
    secNote.textContent = s.inset ? 'inset: these footprints fall inside the box' : `drag the card to lift it · ${F(d.angle)}° shadow direction`;
  }
  drag(secSvg, (e, st) => {
    if (!sg) return;
    const rct = secSvg.getBoundingClientRect();
    const vb = secSvg.viewBox.baseVal, k = vb.width / rct.width;
    const x = (e.clientX - rct.left) * k, y = (e.clientY - rct.top) * k;
    const d = res.drawing, s = res.stage;
    const u = sg.umin + (x - 14) / sg.sc;
    const big = sg.lay[sg.lay.length - 1];
    if (st.what === 'slab') setIf('distance', clamp(Math.round(st.d0 + (st.y0 - y) / sg.kz), 0, 96));
    else if (st.what === 'soft' && d.distance > 0) setIf('softness', clamp(Math.round(((u - (sg.E / 2 + big.o + big.spread)) / (2 * d.distance)) * 20) / 20, 0, 6));
    else if (st.what === 'spread') setIf('spread', clamp(Math.round(u - (sg.E / 2 + big.o)), -64, 64));
    else if (st.what === 'op') setIf('opacity', clamp(Math.round(((sg.op.bot - y) / (sg.op.bot - sg.op.top)) * 100) / 100, 0.01, 1));
    void s;
  }, (e) => {
    const t = e.target.closest?.('.sr-slab, .sr-soft, .sr-spread, .sr-op');
    if (!t || !res) return null;
    const rct = secSvg.getBoundingClientRect(), k = secSvg.viewBox.baseVal.width / rct.width;
    if (t.classList.contains('sr-slab')) return { what: 'slab', y0: (e.clientY - rct.top) * k, d0: res.drawing.distance };
    return { what: t.classList.contains('sr-soft') ? 'soft' : t.classList.contains('sr-spread') ? 'spread' : 'op' };
  });

  // ---------------- levels ----------------
  function drawLevels() {
    const s = res.stage, d = res.drawing;
    levels.replaceChildren(h('div', { class: 'sr-lvh' }, h('span', { class: 'sr-h' }, 'Elevation scale'), h('span', { class: 'sr-sub' }, 'each level doubles the elevation · click one to use it')),
      ...s.levels.map((l) => {
        const cur = Math.abs(l.distance - d.distance) < 0.01;
        return h('button', { type: 'button', class: `sr-lv${cur ? ' sr-cur' : ''}`, 'aria-pressed': String(cur), 'data-focus': `lv-${l.name}`,
          'aria-label': `${l.name}: elevation ${F(l.distance)} px`, onclick: () => setIf('distance', l.distance) },
        h('span', { class: 'sr-lvcard', style: `box-shadow:${l.css};border-radius:${Math.min(d.radius, 16)}px` }),
        h('code', {}, l.name), h('span', { class: 'sr-lvd' }, `${F(l.distance)} px`));
      }));
  }

  // ---------------- sync ----------------
  function syncSpec() {
    const raw = ctx.raw;
    for (const el of spec.querySelectorAll('input[data-key]')) if (document.activeElement !== el) el.value = raw[el.dataset.key] ?? '';
    layersOut.textContent = String(raw.layers);
    for (const b of insetSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.inset === String(!!raw.inset)));
    chip.style.background = String(raw.color || '');
    const black = /^(0|#0{3}|#0{6}|black)$/i.test(String(raw.color).trim());
    chip.classList.toggle('sr-warnchip', black || !!res?.warnings?.some((w) => /is not read/.test(w)));
    for (const b of swatches.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.c === String(raw.color).trim()));
  }

  function render() {
    syncSpec(); syncTable();
    if (!res?.drawing || !res?.stage) {
      over.replaceChildren(); secSvg.replaceChildren(); levels.replaceChildren();
      card.style.boxShadow = 'none';
    } else {
      drawStage(); drawSection(); drawLevels();
    }
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res?.warnings || []).length;
    notes.replaceChildren(h('summary', {}, 'Notes and assumptions'), ...(res?.notes || []).map((n) => h('p', {}, n)));
  }

  ctx.onResult((r) => {
    res = r; render();
    if (!tabChosen) { const b = [...ctx.outputs.querySelectorAll('.k-tab')].find((x) => x.textContent === 'CSS'); if (b) { tabChosen = 'CSS'; b.click(); } }
  });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w !== lastW && res?.drawing) { lastW = w; keepFocus(() => { drawStage(); drawSection(); }); }
  }).observe(root);
}
