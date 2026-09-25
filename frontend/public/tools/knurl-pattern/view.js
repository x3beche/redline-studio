// Knurl & Grip Pattern page: the knurled part itself. A shaded side view you
// spin by dragging and size by its edges, a helix knob that leans the ridges,
// the surface unrolled flat (where pitch, circumferential pitch and the seam
// that must close on a whole tooth are measured), the end view with the tooth
// ring and the twist, and a magnified tooth whose depth you drag. Every number
// shown comes from run()'s result.drawing.

const NS = 'http://www.w3.org/2000/svg';
const DEG = Math.PI / 180;

const CSS = `
:root { --tool-kn-metal: #8a98a6; --tool-kn-groove: #1d2b38; --tool-kn-lit: #ffffff; --tool-kn-ridge: #1f4ed8; --tool-kn-ridge2: #0f8a78; --tool-kn-dim: #5b6b7a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-kn-metal: #6d7c8a; --tool-kn-groove: #0b1117; --tool-kn-lit: #e8eef4; --tool-kn-ridge: #7d9bff; --tool-kn-ridge2: #3cc7b3; --tool-kn-dim: #8ea0b0; } }
:root[data-theme="dark"] { --tool-kn-metal: #6d7c8a; --tool-kn-groove: #0b1117; --tool-kn-lit: #e8eef4; --tool-kn-ridge: #7d9bff; --tool-kn-ridge2: #3cc7b3; --tool-kn-dim: #8ea0b0; }
.k-page { padding: 12px; }
.kn { display: grid; grid-template-columns: minmax(0, 1fr) 420px; grid-template-areas: "bar bar" "main side"; gap: 10px 12px; align-items: start; }
.kn-main { grid-area: main; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.kn-bar { grid-area: bar; display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px 14px; }
.kn-side { grid-area: side; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
@media (max-width: 1040px) { .kn { grid-template-columns: minmax(0, 1fr); grid-template-areas: "bar" "main" "side"; } }
.kn-group { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.kn-group > span { font-size: 10.5px; color: var(--ink-soft); letter-spacing: .02em; }
.kn-pats { display: flex; gap: 4px; }
.kn-pat { display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px 3px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface);
  cursor: pointer; font-size: 12px; color: var(--ink-soft); }
.kn-pat svg { width: 30px; height: 30px; display: block; border-radius: 3px; background: var(--sunken); }
.kn-pat b { display: block; font: 600 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.kn-pat[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); color: var(--ink); }
.kn-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); height: 38px; }
.kn-seg button { border: 0; background: transparent; padding: 0 10px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.kn-seg button + button { border-left: 1px solid var(--line); }
.kn-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.kn-pitch { display: flex; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); overflow: hidden; height: 38px; }
.kn-pitch button { border: 0; background: transparent; cursor: pointer; padding: 0 7px; min-width: 42px; display: flex; flex-direction: column; justify-content: center;
  align-items: center; line-height: 1.15; color: var(--ink-soft); position: relative; }
.kn-pitch button + button { border-left: 1px solid var(--line-soft); }
.kn-pitch button b { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.kn-pitch button small { font: 10px "IBM Plex Mono", ui-monospace, monospace; }
.kn-pitch button[aria-pressed="true"] { background: var(--accent); }
.kn-pitch button[aria-pressed="true"] b, .kn-pitch button[aria-pressed="true"] small { color: var(--accent-ink); }
.kn-pitch button.din::after { content: ""; position: absolute; top: 3px; right: 3px; width: 5px; height: 5px; border-radius: 50%; background: var(--ok); }
.kn-pitch button.bad small { color: var(--danger); }
.kn-nums { display: flex; gap: 6px; align-items: flex-end; }
.kn-num { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--ink-soft); }
.kn-num input { width: 60px; height: 38px; padding: 0 6px; border: 1px solid var(--line); border-radius: 5px; background: var(--sunken);
  font: 13px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.kn-num input::placeholder { color: var(--ink-soft); }
.kn-num input.bad { border-color: var(--danger); }
.kn-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; position: relative; }
.kn-card h2 { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--ink-soft); padding: 6px 10px 0; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.kn-card h2 b { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.kn-card h2 em { font-style: normal; margin-left: auto; font-size: 11px; }
.kn-part .kn-svg { height: clamp(290px, calc(100vh - 420px), 640px); }
.kn-strip .kn-svg { height: 170px; }
.kn-side .k-count { display: none; }
.kn-tooth .kn-svg { height: 150px; }
.kn-svg { position: relative; }
.kn-svg svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.kn svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; fill: var(--ink-soft); }
.kn svg text.v { fill: var(--ink); font-weight: 600; }
.kn svg text.bad { fill: var(--danger); font-weight: 600; }
.kn svg .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.kn svg .dim { stroke: var(--tool-kn-dim); stroke-width: 1; fill: none; }
.kn .hd { cursor: grab; outline: none; }
.kn .hd .foc { fill: none; stroke: none; }
.kn .hd .ring { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.kn .hd:hover .ring { fill: var(--accent); }
.kn .hd:focus-visible .ring { stroke-width: 3.5; fill: var(--accent); }
.kn .hd:focus-visible .foc { stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 3 2; fill: none; }
.kn .spin { cursor: ew-resize; outline: none; }
.kn .spin:focus-visible .body-edge { stroke: var(--accent); stroke-width: 2.5; }
.kn .dragging, .kn .dragging * { cursor: grabbing !important; }
.kn-hint { position: absolute; right: 10px; bottom: 6px; font-size: 11px; color: var(--ink-soft); pointer-events: none; text-align: right; max-width: 60%; }
.kn-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.kn-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.kn-msgs div.note { border-left-color: var(--line); color: var(--ink-soft); }
.kn-msgs:empty { display: none; }
.kn-side .k-out { max-height: 300px; }
@media (max-width: 640px) {
  .kn-part .kn-svg { height: 480px; }
  .kn-strip .kn-svg { height: 170px; }
  .kn-pitch { overflow-x: auto; max-width: 100%; }
  .kn-pats { flex-wrap: wrap; }
  .kn-hint { display: none; }
}
`;

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
const s = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};
const r2 = (v) => (Math.round(v * 100) / 100).toString();
const P = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

const PATTERNS = [
  ['diamond', 'Diamond', 'RGE', [1, -1]],
  ['straight', 'Straight', 'RAA', [0]],
  ['left', 'Left', 'RBL', [-1]],
  ['right', 'Right', 'RBR', [1]],
];
const PROCESS = [['machined', 'Machined'], ['printed', '3D printed'], ['moulded', 'Moulded']];
const PITCHES = ['auto', '0.5', '0.6', '0.8', '1', '1.2', '1.6', '2', '2.5'];

function swatch(hands) {
  const svg = s('svg', { viewBox: '0 0 30 30', 'aria-hidden': 'true' });
  let d = '';
  for (const hd of hands) {
    for (let i = -4; i <= 8; i++) {
      const x = i * 6;
      d += hd === 0 ? `M${x + 3},0L${x + 3},30` : `M${x},${hd > 0 ? 30 : 0}L${x + 17},${hd > 0 ? 0 : 30}`;
    }
  }
  svg.append(s('path', { d, stroke: 'var(--tool-kn-ridge)', 'stroke-width': 1.3, fill: 'none' }));
  return svg;
}

// Pointer drag with a frozen frame: `start` returns state, `move(state, dx, dy, ev)`.
// The listeners sit on the window: the drawing is rebuilt under the pointer on
// every change, so the node that was grabbed does not survive the drag.
function draggable(node, start, move, root) {
  node.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    node.focus?.({ preventScroll: true });
    const st = start(ev);
    const x0 = ev.clientX, y0 = ev.clientY, id = ev.pointerId;
    root.classList.add('dragging');
    const mv = (e) => { if (e.pointerId === id) move(st, e.clientX - x0, e.clientY - y0, e); };
    const up = (e) => {
      if (e.pointerId !== id) return;
      root.classList.remove('dragging');
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

function handle(x, y, label, keys) {
  const g = s('g', { class: 'hd', tabindex: '0', role: 'slider', 'aria-label': label, transform: `translate(${x.toFixed(1)},${y.toFixed(1)})` });
  g.append(s('circle', { r: 13, fill: 'transparent' }), s('circle', { class: 'foc', r: 11 }), s('circle', { class: 'ring', r: 6 }));
  g.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (dir == null) return;
    e.preventDefault();
    keys(dir * big, e.key);
  });
  return g;
}

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  let res = null, g = null, spin = 0.35, dragFrame = null;
  const refocus = { key: null };

  // ---------------- toolbar ----------------
  const patBtns = PATTERNS.map(([id, name, din, hands]) => h('button', { class: 'kn-pat', 'aria-pressed': 'false', title: `${name} (DIN 82 ${din})`,
    onclick: () => ctx.set('pattern', id) }, swatch(hands), h('span', {}, h('b', {}, din), name)));
  const procBtns = PROCESS.map(([id, name]) => h('button', { 'aria-pressed': 'false', onclick: () => ctx.set('process', id) }, name));
  const pitchBtns = PITCHES.map((p) => h('button', { 'aria-pressed': 'false', onclick: () => ctx.set('pitch', p) }, h('b', {}, p === 'auto' ? 'Auto' : p), h('small', {}, '')));
  const field = (key, label, unit, ph) => {
    const inp = h('input', { inputmode: 'decimal', spellcheck: 'false', placeholder: ph || '', 'aria-label': `${label} ${unit}` });
    inp.addEventListener('change', () => ctx.set(key, inp.value.trim()));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ctx.set(key, inp.value.trim()); });
    return [inp, h('label', { class: 'kn-num' }, `${label} ${unit}`, inp)];
  };
  const [dIn, dF] = field('d', 'Ø', 'mm');
  const [lIn, lF] = field('len', 'L', 'mm');
  const [bIn, bF] = field('beta', 'Helix', '°');
  const [hIn, hF] = field('depth', 'Depth', 'mm', 'sharp');
  const bar = h('div', { class: 'kn-bar' },
    h('div', { class: 'kn-group' }, h('span', {}, 'Pattern (DIN 82)'), h('div', { class: 'kn-pats', role: 'group', 'aria-label': 'Pattern' }, patBtns)),
    h('div', { class: 'kn-group' }, h('span', {}, 'Made by'), h('div', { class: 'kn-seg', role: 'group', 'aria-label': 'Made by' }, procBtns)),
    h('div', { class: 'kn-group' }, h('span', {}, 'Pitch mm · grooves round'), h('div', { class: 'kn-pitch', role: 'group', 'aria-label': 'Pitch' }, pitchBtns)),
    h('div', { class: 'kn-nums' }, dF, lF, bF, hF));

  // ---------------- canvases ----------------
  const mk = (cls, title, hint) => {
    const svg = document.createElementNS(NS, 'svg');
    const head = h('h2', {}, title);
    const box = h('div', { class: 'kn-svg' }, svg, hint ? h('div', { class: 'kn-hint' }, hint) : null);
    const card = h('section', { class: `kn-card ${cls}` }, head, box);
    return { svg, head, box, card };
  };
  const part = mk('kn-part', 'Part: side and end view, to scale', 'drag the part to spin it · drag ○ for Ø, length and helix · arrow keys on a focused handle');
  const strip = mk('kn-strip', 'Surface unrolled: circumference × length', null);
  const tooth = mk('kn-tooth', 'Detail A: tooth profile, cross-section', null);
  tooth.head.append(h('em', {}, 'drag ○ for the depth'));
  const msgs = h('div', { class: 'kn-msgs', 'aria-live': 'polite' });
  const side = h('aside', { class: 'kn-side' }, tooth.card, msgs, ctx.outputs);
  const wrap = h('div', { class: 'kn' }, bar, h('div', { class: 'kn-main' }, part.card, strip.card), side);
  root.append(wrap);

  const set = (key, v, focusKey) => { refocus.key = focusKey || null; ctx.set(key, v); };

  // ---------------- side view ----------------
  function drawPart() {
    const svg = part.svg;
    const W = part.box.clientWidth || 800, H = part.box.clientHeight || 400;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    if (!g) return;
    const R = g.d / 2;
    const padL = 92, gapV = 80, padR = 150, padT = 40, padB = 70;
    const Rend = Math.max(R, g.process === 'machined' ? g.blank / 2 : 0);
    // Wide: side and end view next to each other on the axis. Narrow: the end view under the side view.
    const stacked = W < 640;
    const k = dragFrame?.k ?? (stacked
      ? Math.min((W - padL - 30) / g.len, (W - 170) / (2 * Rend), (H - padT - padB - 40) / (g.d + 2 * Rend))
      : Math.min((W - padL - gapV - padR) / (g.len + 2 * Rend), (H - padT - padB) / g.d));
    const Lp = g.len * k, Rk = R * k;
    const x0 = dragFrame?.x0 ?? (stacked ? padL + Math.max(0, (W - padL - 30 - Lp) / 2)
      : padL + Math.max(0, (W - padL - gapV - padR - Lp - 2 * Rend * k) / 2));
    const yc = dragFrame?.yc ?? (stacked ? padT + Rk : padT + (H - padT - padB) / 2);
    const tb = Math.tan(g.beta * DEG);
    const clipId = 'kn-clip-body';
    const defs = s('defs');
    const clip = s('clipPath', { id: clipId });
    clip.append(s('rect', { x: x0, y: yc - Rk, width: Lp, height: 2 * Rk }));
    defs.append(clip);
    svg.append(defs);

    // axis
    svg.append(s('line', { x1: x0 - 24, x2: x0 + Lp + 24, y1: yc, y2: yc, stroke: 'var(--tool-kn-dim)', 'stroke-dasharray': '10 3 2 3', 'stroke-width': 0.8 }));
    // body: metal with shading bands, lit from above-front
    const body = s('g', { class: 'spin', tabindex: '0', role: 'slider', 'aria-label': 'Spin the part (visual only)', 'aria-valuetext': `${Math.round((spin / DEG) % 360)}°` });
    body.append(s('rect', { x: x0, y: yc - Rk, width: Lp, height: 2 * Rk, fill: 'var(--tool-kn-metal)' }));
    const bands = 24;
    for (let j = 0; j < bands; j++) {
      const a0 = -90 + (180 * j) / bands, a1 = a0 + 180 / bands;
      const am = ((a0 + a1) / 2) * DEG;
      const light = Math.cos(am - 38 * DEG); // light from above
      const ya = yc - Rk * Math.sin(a1 * DEG), yb = yc - Rk * Math.sin(a0 * DEG);
      if (light > 0.55) body.append(s('rect', { x: x0, y: ya, width: Lp, height: yb - ya + 0.4, fill: 'var(--tool-kn-lit)', opacity: ((light - 0.55) * 0.9).toFixed(3) }));
      else body.append(s('rect', { x: x0, y: ya, width: Lp, height: yb - ya + 0.4, fill: 'var(--tool-kn-groove)', opacity: ((0.55 - light) * 0.55).toFixed(3) }));
    }
    // grooves on the front half, darker where they face you
    const buckets = ['', '', ''];
    const steps = g.beta > 0 ? Math.max(10, Math.min(90, Math.ceil(Math.abs(g.twistDeg) / 2))) : 1;
    for (const hd of g.hands) {
      for (let i = 0; i < g.N; i++) {
        const t0 = (2 * Math.PI * i) / g.N + spin;
        let prev = null;
        for (let j = 0; j <= steps; j++) {
          const z = (g.len * j) / steps;
          const th = t0 + (hd * z * tb) / R;
          const c = Math.cos(th);
          const pt = [x0 + z * k, yc - Rk * Math.sin(th), c];
          if (prev && prev[2] > 0 && c > 0) {
            const b = (prev[2] + c) / 2 > 0.66 ? 2 : (prev[2] + c) / 2 > 0.3 ? 1 : 0;
            buckets[b] += `M${P(prev[0], prev[1])}L${P(pt[0], pt[1])}`;
          }
          prev = pt;
        }
      }
    }
    const gw = Math.max(0.7, Math.min(2.2, g.pc * k * 0.28));
    buckets.forEach((d, b) => { if (d) body.append(s('path', { d, stroke: 'var(--tool-kn-groove)', 'stroke-width': gw, 'stroke-opacity': [0.35, 0.6, 0.9][b], fill: 'none', 'clip-path': `url(#${clipId})` })); });
    // serrated silhouette: where a helical groove crosses the top or bottom limb
    if (g.beta > 0 && g.depth > 0) {
      let notch = '';
      const aw = g.pc / tb; // axial width of a groove at the limb
      for (const hd of g.hands) {
        for (const limb of [Math.PI / 2, -Math.PI / 2]) {
          for (let i = 0; i < g.N; i++) {
            const t0 = (2 * Math.PI * i) / g.N + spin;
            // hd z tb / R = limb - t0 + 2 pi m
            const per = (2 * Math.PI * R) / tb;
            let z = ((((limb - t0) * R) / tb) * hd) % per;
            if (z < 0) z += per;
            for (; z < g.len + aw; z += per) {
              const yy = yc - Rk * Math.sin(limb), dir = limb > 0 ? 1 : -1;
              const za = Math.max(0, z - aw / 2), zb = Math.min(g.len, z + aw / 2);
              if (zb <= za) continue;
              const dep = Math.min(g.depth, R) * k * Math.min(1, (zb - za) / aw * 1.0);
              notch += `M${P(x0 + za * k, yy)}L${P(x0 + Math.min(Math.max(z, 0), g.len) * k, yy + dir * dep)}L${P(x0 + zb * k, yy)}Z`;
            }
          }
        }
      }
      if (notch) body.append(s('path', { d: notch, fill: 'var(--surface)', stroke: 'none' }));
    }
    body.append(s('rect', { class: 'body-edge', x: x0, y: yc - Rk, width: Lp, height: 2 * Rk, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.2 }));
    // root diameter, hidden line
    if (g.root > 0) {
      const Rr = (g.root / 2) * k;
      body.append(s('path', { d: `M${P(x0, yc - Rr)}H${(x0 + Lp).toFixed(1)}M${P(x0, yc + Rr)}H${(x0 + Lp).toFixed(1)}`, stroke: 'var(--ink)', 'stroke-dasharray': '4 3', 'stroke-width': 0.8, opacity: 0.55 }));
    }
    svg.append(body);
    draggable(body, () => ({ s0: spin }), (st, dx) => { spin = st.s0 + (dx / Math.max(Rk, 20)); drawPart(); }, wrap);
    body.addEventListener('keydown', (e) => {
      const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!dir) return;
      e.preventDefault(); spin += dir * (Math.PI / g.N) * (e.shiftKey ? 4 : 1); drawPart(); svg.querySelector('.spin')?.focus();
    });

    // dimensions: diameter on the left
    const xd = x0 - 46;
    svg.append(s('path', { class: 'dim', d: `M${P(x0 - 4, yc - Rk)}H${xd - 6}M${P(x0 - 4, yc + Rk)}H${xd - 6}M${P(xd, yc - Rk)}V${(yc + Rk).toFixed(1)}` }));
    svg.append(s('path', { d: `M${P(xd, yc - Rk)}l-3,7h6ZM${P(xd, yc + Rk)}l-3,-7h6Z`, fill: 'var(--tool-kn-dim)' }));
    const tD = s('text', { class: 'v halo', x: xd - 6, y: yc, 'text-anchor': 'middle', transform: `rotate(-90 ${xd - 6} ${yc})` }, `Ø${r2(g.d)}`);
    svg.append(tD);
    if (g.root > 0) {
      const xr = x0 - 20, Rr = (g.root / 2) * k;
      svg.append(s('path', { class: 'dim', d: `M${P(xr, yc - Rr)}V${(yc + Rr).toFixed(1)}`, 'stroke-dasharray': '2 2' }));
      svg.append(s('text', { class: 'halo', x: xr - 5, y: yc, 'text-anchor': 'middle', transform: `rotate(-90 ${xr - 5} ${yc})` }, `root Ø${r2(g.root)}`));
    } else {
      svg.append(s('text', { class: 'bad halo', x: x0 + Lp / 2, y: yc + 4, 'text-anchor': 'middle' }, 'grooves reach the axis'));
    }
    // length below
    const yl = yc + Rk + 26;
    svg.append(s('path', { class: 'dim', d: `M${P(x0, yc + Rk + 4)}V${yl + 6}M${P(x0 + Lp, yc + Rk + 4)}V${yl + 6}M${P(x0, yl)}H${(x0 + Lp).toFixed(1)}` }));
    svg.append(s('path', { d: `M${P(x0, yl)}l7,-3v6ZM${P(x0 + Lp, yl)}l-7,-3v6Z`, fill: 'var(--tool-kn-dim)' }));
    const longWarn = g.len > 3 * g.d && g.process === 'machined';
    svg.append(s('text', { class: `${longWarn ? 'bad' : 'v'} halo`, x: x0 + Lp / 2, y: yl + 16, 'text-anchor': 'middle' }, `L ${r2(g.len)}${longWarn ? ' > 3×Ø' : ''}`));

    svg.append(s('text', { class: 'halo', x: x0 + Lp / 2, y: yl + 32, 'text-anchor': 'middle' },
      g.beta > 0 ? `helix lead ${r2(g.lead)} · twist ${r2(g.twistDeg)}° over L` : 'straight ribs, no helix'));

    // end view, same scale, on the axis, with projection lines
    if (stacked) {
      drawEnd(svg, k, Math.max(Rend * k + 10, (W - 150) / 2), yc + Rk + padB + 10 + Rend * k, W);
    } else {
      const ecx = x0 + Lp + gapV + Rend * k;
      svg.append(s('path', { d: `M${P(x0 + Lp + 4, yc - Rk)}H${(ecx).toFixed(1)}M${P(x0 + Lp + 4, yc + Rk)}H${(ecx).toFixed(1)}`, stroke: 'var(--tool-kn-dim)', 'stroke-width': 0.6, 'stroke-dasharray': '2 4' }));
      drawEnd(svg, k, ecx, yc, W);
    }

    // a headline over the part
    part.head.replaceChildren('Part: side and end view, to scale', h('b', {}, `${g.N} grooves${g.hands.length > 1 ? ' per hand' : ''}`),
      h('span', {}, `p ${r2(g.pAct)} mm · pc ${r2(g.pc)} mm${g.beta > 0 ? ` · β ${r2(g.beta)}°` : ''}`));
    if (g.process === 'moulded' && g.hands[0] !== 0) {
      svg.append(s('text', { class: 'bad halo', x: x0 + Lp / 2, y: yc - Rk - 10, 'text-anchor': 'middle' }, 'undercut in an axial mould draw'));
    }

    // handles: diameter (top edge), length (right end), helix (front ridge)
    const hD = handle(x0 + Lp * 0.5, yc - Rk, `Diameter ${r2(g.d)} mm`, (step) => set('d', r2(Math.max(1, g.d + step * 0.5)), 'd'));
    hD.dataset.key = 'd';
    hD.style.cursor = 'ns-resize';
    draggable(hD, () => ({ d0: g.d, frame: freeze(k, x0, yc) }), (st, dx, dy) => {
      set('d', r2(Math.max(1, Math.round((st.d0 - (2 * dy) / k) * 2) / 2)), 'd');
    }, wrap);
    const hL = handle(x0 + Lp, yc, `Knurled length ${r2(g.len)} mm`, (step) => set('len', r2(Math.max(0.5, g.len + step * 0.5)), 'len'));
    hL.dataset.key = 'len';
    hL.style.cursor = 'ew-resize';
    draggable(hL, () => ({ l0: g.len, frame: freeze(k, x0, yc) }), (st, dx) => {
      set('len', r2(Math.max(0.5, Math.round((st.l0 + dx / k) * 2) / 2)), 'len');
    }, wrap);
    svg.append(hD, hL);
    if (g.hands[0] !== 0) {
      const cx = x0 + Lp / 2, cy = Lp < 140 ? yc - Rk * 0.5 : yc;
      const Lr = Math.max(44, Math.min(Lp * 0.42, Rk * 0.9, 150));
      const ang = g.beta * DEG;
      // the ridge direction of hand +1 at the front: dy/dz = -tan(beta) (screen y down)
      const sgn = g.hands.includes(1) ? -1 : 1;
      const ex = cx + Lr * Math.cos(ang), ey = cy + sgn * Lr * Math.sin(ang);
      svg.append(s('line', { x1: cx - Lr * 0.25 * Math.cos(ang), y1: cy - sgn * Lr * 0.25 * Math.sin(ang), x2: ex, y2: ey, stroke: 'var(--accent)', 'stroke-width': 2 }));
      svg.append(s('line', { x1: cx, y1: cy, x2: cx + Lr, y2: cy, stroke: 'var(--accent)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
      const ar = Lr * 0.55;
      svg.append(s('path', { d: `M${P(cx + ar, cy)}A${ar},${ar} 0 0 ${sgn < 0 ? 0 : 1} ${P(cx + ar * Math.cos(ang), cy + sgn * ar * Math.sin(ang))}`, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.2 }));
      svg.append(s('text', { class: 'v halo', x: cx + ar + 6, y: cy + sgn * (ar * Math.sin(ang / 2)) + (sgn < 0 ? -2 : 12) }, `β ${r2(g.beta)}°`));
      const hB = handle(ex, ey, `Helix angle ${r2(g.beta)}°`, (step) => set('beta', r2(Math.min(59, Math.max(1, g.beta + step))), 'beta'));
      hB.dataset.key = 'beta';
      draggable(hB, (ev) => {
        const r = svg.getBoundingClientRect();
        return { cx: r.left + (cx / W) * r.width, cy: r.top + (cy / H) * r.height, frame: freeze(k, x0, yc) };
      }, (st, dx, dy, e) => {
        const a = Math.atan2(Math.abs(e.clientY - st.cy), Math.max(1, e.clientX - st.cx)) / DEG;
        set('beta', String(Math.min(59, Math.max(1, Math.round(a)))), 'beta');
      }, wrap);
      svg.append(hB);
    }
  }
  function freeze(k, x0, yc) { dragFrame = { k, x0, yc }; const off = () => { dragFrame = null; window.removeEventListener('pointerup', off); redraw(); }; window.addEventListener('pointerup', off); return dragFrame; }

  // ---------------- developed surface ----------------
  function drawStrip() {
    const svg = strip.svg;
    const W = strip.box.clientWidth || 800, H = strip.box.clientHeight || 170;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    if (!g) return;
    const C = Math.PI * g.d;
    // The longer of circumference and length runs across the page.
    const swap = g.len > C;
    const padL = swap ? 78 : 40, padR = swap ? 170 : 24, padT = 30, padB = swap ? 48 : 38;
    const Wav = W - padL - padR, Hav = H - padT - padB;
    let ks, shownC = C;
    if (swap) ks = Math.min(Wav / g.len, Hav / C);
    else {
      ks = Math.min(Wav / C, Hav / g.len);
      // Long circumferences: keep the strip tall enough to read and show a window of it.
      const minH = Math.min(Hav, 64);
      if (g.len * ks < minH) ks = minH / g.len;
      shownC = Math.min(C, Wav / ks);
    }
    const cut = shownC < C - 1e-9;
    const x0 = padL, y0 = padT;
    const Wb = swap ? g.len * ks : shownC * ks, Hb = swap ? shownC * ks : g.len * ks;
    const pt = (u, z) => (swap ? [x0 + z * ks, y0 + u * ks] : [x0 + u * ks, y0 + z * ks]);
    const vec = (du, dz) => (swap ? [dz, du] : [du, dz]);
    const tb = Math.tan(g.beta * DEG);
    const defs = s('defs'), clip = s('clipPath', { id: 'kn-clip-strip' });
    clip.append(s('rect', { x: x0, y: y0, width: Wb, height: Hb }));
    defs.append(clip); svg.append(defs);
    svg.append(s('rect', { x: x0, y: y0, width: Wb, height: Hb, fill: 'var(--sunken)', stroke: 'var(--ink)', 'stroke-width': 1 }));
    const lines = s('g', { 'clip-path': 'url(#kn-clip-strip)' });
    const colors = { 1: 'var(--tool-kn-ridge)', '-1': 'var(--tool-kn-ridge2)', 0: 'var(--tool-kn-ridge)' };
    for (const hd of g.hands) {
      let d = '';
      const du = hd * g.len * tb;
      const wraps = Math.ceil(Math.abs(du) / C) + 1;
      for (let i = 0; i < g.N; i++) {
        for (let wk = -wraps; wk <= 1; wk++) {
          const ua = i * g.pc + wk * C * Math.sign(du || 1), ub = ua + du;
          if (Math.max(ua, ub) < 0 || Math.min(ua, ub) > shownC) continue;
          d += `M${P(...pt(ua, 0))}L${P(...pt(ub, g.len))}`;
        }
      }
      lines.append(s('path', { d, stroke: colors[hd], 'stroke-width': 1.2, fill: 'none', opacity: 0.85 }));
    }
    svg.append(lines);
    const T = (x, y, text, cls, anchor, extra = {}) => svg.append(s('text', { class: cls ? `${cls} halo` : 'halo', x, y, 'text-anchor': anchor || 'start', ...extra }, text));

    // the length axis
    if (swap) T(x0 + Wb / 2, y0 + Hb + 16, `L ${r2(g.len)}`, 'v', 'middle');
    else { T(x0 - 6, y0 + Hb / 2 + 4, 'L', '', 'end'); T(x0 - 6, y0 + Hb / 2 + 18, r2(g.len), 'v', 'end'); }

    // pc across one tooth at the front edge
    if (2 * g.pc < shownC) {
      const a = pt(g.pc, 0), b2 = pt(2 * g.pc, 0);
      if (swap) {
        svg.append(s('path', { class: 'dim', d: `M${P(x0, a[1])}H${x0 - 12}M${P(x0, b2[1])}H${x0 - 12}M${P(x0 - 8, a[1])}V${b2[1].toFixed(1)}` }));
        T(x0 - 12, b2[1] + 12, `pc ${r2(g.pc)}`, 'v', 'end');
      } else {
        svg.append(s('path', { class: 'dim', d: `M${P(a[0], y0)}V${y0 - 12}M${P(b2[0], y0)}V${y0 - 12}M${P(a[0], y0 - 8)}H${b2[0].toFixed(1)}` }));
        T(b2[0] + 6, y0 - 4, `pc ${r2(g.pc)}`, 'v');
      }
    }
    // p, normal to the ridges, half way along
    if (g.beta > 0) {
      const hd = g.hands[0], zc = g.len / 2;
      const uc = 3 * g.pc + hd * zc * tb;
      const um = ((uc % C) + C) % C;
      if (um + g.pAct < shownC) {
        const pa = pt(um, zc);
        const [dx, dy] = vec(Math.cos(g.beta * DEG) * g.pAct, -hd * Math.sin(g.beta * DEG) * g.pAct);
        const pb = [pa[0] + dx * ks, pa[1] + dy * ks];
        svg.append(s('line', { x1: pa[0], y1: pa[1], x2: pb[0], y2: pb[1], stroke: 'var(--ink)', 'stroke-width': 2 }));
        svg.append(s('circle', { cx: pa[0], cy: pa[1], r: 2.2, fill: 'var(--ink)' }), s('circle', { cx: pb[0], cy: pb[1], r: 2.2, fill: 'var(--ink)' }));
        T(Math.max(pa[0], pb[0]) + 6, Math.max(pa[1], pb[1]) + 4, `p ${r2(g.pAct)}`, 'v');
      }
    } else if (4 * g.pc < shownC) {
      const m = pt(3.5 * g.pc, g.len / 2);
      T(m[0] + (swap ? 0 : 0), m[1] + 4, `p ${r2(g.pAct)}`, 'v', 'middle');
    }
    // the seam: whole teeth close the circumference; ticks at the nominal pitch show why the count is rounded
    let ticks = '';
    for (let u = 0; u <= shownC + 1e-9; u += g.pcNom) {
      const q = pt(u, g.len);
      ticks += swap ? `M${P(q[0], q[1])}h5` : `M${P(q[0], q[1])}v5`;
    }
    svg.append(s('path', { d: ticks, stroke: 'var(--tool-kn-dim)', 'stroke-width': 1 }));
    const bad = Math.abs(g.err) > 3 && g.process === 'machined';
    const seam = `πD ${r2(C)} = ${g.N} × ${r2(g.pc)}`;
    let foot;
    if (!cut) {
      const nomEnd = Math.floor(C / g.pcNom + 1e-9) * g.pcNom;
      const gap = C - nomEnd;
      if (gap > 1e-6 && gap < g.pcNom - 1e-6) {
        const q = pt(nomEnd, g.len);
        const fill = bad ? 'var(--danger)' : 'var(--warn)';
        svg.append(s('rect', swap ? { x: q[0] + 1, y: q[1], width: 6, height: gap * ks, fill } : { x: q[0], y: q[1] + 1, width: gap * ks, height: 6, fill }));
      }
      foot = `ticks: nominal ${r2(g.pNom)} mm pitch leaves ${r2(gap)} mm at the seam → rounded to ${g.N} whole teeth, ${g.err >= 0 ? '+' : ''}${r2(g.err)} %`;
    } else {
      let zig = `M${P(x0 + Wb, y0)}`;
      for (let j = 1; j <= 8; j++) zig += `L${P(x0 + Wb + (j % 2 ? 5 : 0), y0 + (Hb * j) / 8)}`;
      svg.append(s('path', { d: zig, stroke: 'var(--surface)', 'stroke-width': 5, fill: 'none' }), s('path', { d: zig, stroke: 'var(--ink)', 'stroke-width': 1, fill: 'none' }));
      foot = `first ${r2(shownC)} of ${r2(C)} mm shown · ${g.N} whole teeth close πD, ${g.err >= 0 ? '+' : ''}${r2(g.err)} % from ${r2(g.pNom)} mm`;
    }
    if (swap) {
      T(x0 + Wb + 14, y0 + 10, seam, bad ? 'bad' : 'v');
      T(x0, y0 + Hb + 34, foot);
    } else {
      T(x0 + Wb, y0 - 6, seam, bad ? 'bad' : 'v', 'end');
      T(x0, y0 + Hb + 22, foot);
    }
    if (g.process === 'printed' && g.pc < 1.2) T(x0 + Wb / 2, y0 + Hb / 2 + 4, `${r2(g.pc)} mm teeth: under 3 nozzle widths`, 'bad', 'middle');
    strip.head.replaceChildren(`Surface unrolled: ${swap ? 'length × circumference' : 'circumference × length'}`,
      h('em', {}, g.hands.length > 1 ? 'both hands cross into raised diamonds' : g.hands[0] === 0 ? 'ribs along the axis' : `${g.hands[0] > 0 ? 'right' : 'left'} hand`));
  }

  // ---------------- end view ----------------
  function drawEnd(svg, k, cx, cy, W) {
    const R = g.d / 2, Rr = Math.max(0, g.root / 2);
    const Rblank = g.process === 'machined' ? g.blank / 2 : 0;
    const pts = [];
    for (let i = 0; i < g.N; i++) {
      const a0 = (2 * Math.PI * i) / g.N + spin, a1 = a0 + Math.PI / g.N;
      // flat crest when the groove is shallower than a sharp tooth
      const frac = Math.min(1, g.depth / g.full);
      const half = (Math.PI / g.N) * frac;
      pts.push([cx + R * k * Math.cos(a0 - 0), cy - R * k * Math.sin(a0)]);
      pts.push([cx + R * k * Math.cos(a1 - half), cy - R * k * Math.sin(a1 - half)]);
      pts.push([cx + Rr * k * Math.cos(a1), cy - Rr * k * Math.sin(a1)]);
      pts.push([cx + R * k * Math.cos(a1 + half), cy - R * k * Math.sin(a1 + half)]);
    }
    const bad = g.root <= 0;
    svg.append(s('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${P(p[0], p[1])}`).join('') + 'Z', fill: 'var(--tool-kn-metal)', 'fill-opacity': 0.55,
      stroke: bad ? 'var(--danger)' : 'var(--ink)', 'stroke-width': 0.8 }));
    svg.append(s('circle', { cx, cy, r: Math.max(0, Rr * k), fill: 'none', stroke: 'var(--ink)', 'stroke-dasharray': '3 3', 'stroke-width': 0.7, opacity: 0.6 }));
    if (Rblank > 0) svg.append(s('circle', { cx, cy, r: Rblank * k, fill: 'none', stroke: 'var(--warn)', 'stroke-dasharray': '6 3', 'stroke-width': 1 }));
    svg.append(s('path', { d: `M${P(cx - 6, cy)}h12M${P(cx, cy - 6)}v12`, stroke: 'var(--ink)', 'stroke-width': 1 }));
    // twist: a groove's start (front face) and end (back face)
    if (g.beta > 0) {
      const a0 = spin + (2 * Math.PI) / g.N * Math.round(((Math.PI / 2 - spin) / (2 * Math.PI)) * g.N);
      const hd = g.hands[0];
      const tw = hd * g.twistDeg * DEG;
      const rr = R * k + 12;
      const large = Math.abs(tw) > Math.PI ? 1 : 0;
      const p1 = [cx + rr * Math.cos(a0), cy - rr * Math.sin(a0)];
      const p2 = [cx + rr * Math.cos(a0 + tw), cy - rr * Math.sin(a0 + tw)];
      if (Math.abs(tw) < 2 * Math.PI - 0.01) {
        svg.append(s('path', { d: `M${P(...p1)}A${rr},${rr} 0 ${large} ${tw > 0 ? 0 : 1} ${P(...p2)}`, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.6 }));
      } else svg.append(s('circle', { cx, cy, r: rr, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.6 }));
      svg.append(s('circle', { cx: p1[0], cy: p1[1], r: 3, fill: 'var(--accent)' }));
      svg.append(s('path', { d: `M${P(cx + R * k * Math.cos(a0 + tw), cy - R * k * Math.sin(a0 + tw))}L${P(...p2)}`, stroke: 'var(--accent)', 'stroke-width': 1.2 }));
      const am = a0 + tw / 2;
      const lx = cx + (rr + 10) * Math.cos(am), ly = cy - (rr + 10) * Math.sin(am);
      let anchor = Math.cos(am) > 0.2 ? 'start' : Math.cos(am) < -0.2 ? 'end' : 'middle';
      let tx2 = lx, ty2 = ly + 4;
      if (Math.abs(tw) >= Math.PI * 1.5) { anchor = 'middle'; tx2 = cx; ty2 = cy - rr - 8; }
      else if (anchor === 'end' && lx < 96) { anchor = 'start'; tx2 = 4; ty2 -= 14; }
      svg.append(s('text', { class: 'v halo', x: tx2, y: ty2, 'text-anchor': anchor }, `twist ${r2(g.twistDeg)}°`));
    }
    // detail A marker at the top
    const bx = cx, by = cy + R * k;
    svg.append(s('rect', { x: bx - 16, y: by - 10, width: 32, height: 20, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1, 'stroke-dasharray': '3 2' }));
    svg.append(s('text', { class: 'v', x: bx + 20, y: by + 14 }, 'A'));
    // readouts at the right
    const tx = cx + Math.max(R, Rblank) * k + 22;
    const rows = [
      [`${g.N}`, g.hands.length > 1 ? 'teeth, per hand' : 'teeth'],
      [`Ø${r2(g.d)}`, 'crests'],
      [g.root > 0 ? `Ø${r2(g.root)}` : '—', 'root', bad],
    ];
    if (Rblank > 0) rows.push([`Ø${r2(g.blank)}`, 'blank to turn', false], [`Ø${r2(g.dExact)}`, 'after form knurling']);
    const ty = cy - (rows.length * 28) / 2 + 8;
    rows.forEach(([v, t, b], i) => {
      svg.append(s('text', { class: `${b ? 'bad' : 'v'} halo`, x: tx, y: ty + i * 28 }, v));
      svg.append(s('text', { class: 'halo', x: tx, y: ty + 12 + i * 28, 'font-size': 10 }, t));
    });
    if (Rblank > 0) svg.append(s('line', { x1: tx + 64, x2: tx + 84, y1: ty + 3 * 28 - 4, y2: ty + 3 * 28 - 4, stroke: 'var(--warn)', 'stroke-dasharray': '6 3' }));
  }

  // ---------------- tooth detail ----------------
  function drawTooth() {
    const svg = tooth.svg;
    const W = tooth.box.clientWidth || 380, H = tooth.box.clientHeight || 150;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    if (!g) return;
    const n = 3;
    const kt = dragFrame?.kt ?? Math.min((W - 60) / (n * g.pc), (H - 50) / Math.max(g.full, g.depth));
    const x0 = (W - n * g.pc * kt) / 2, ys = 26;
    const over = g.depth > g.full * 1.001;
    // material: the surface, V grooves at the middle of each pitch
    // Deeper than sharp: neighbouring grooves overlap and the crests drop below the surface.
    const yCrest = over ? ys + (g.depth - g.full) * kt : ys;
    let d = `M${P(x0 - 12, yCrest)}`;
    for (let i = 0; i < n; i++) {
      const c = x0 + (i + 0.5) * g.pc * kt, hw = Math.min(g.depth, g.pc / 2) * kt;
      d += `L${P(c - hw, yCrest)}L${P(c, ys + g.depth * kt)}L${P(c + hw, yCrest)}`;
    }
    if (over) svg.append(s('line', { x1: x0 - 12, x2: x0 + n * g.pc * kt + 12, y1: ys, y2: ys, stroke: 'var(--danger)', 'stroke-dasharray': '4 3' }));
    const base = ys + Math.max(g.full, g.depth) * kt + 16;
    d += `L${P(x0 + n * g.pc * kt + 12, yCrest)}L${P(x0 + n * g.pc * kt + 12, base)}L${P(x0 - 12, base)}Z`;
    svg.append(s('path', { d, fill: 'var(--tool-kn-metal)', 'fill-opacity': 0.45, stroke: over ? 'var(--danger)' : 'var(--ink)', 'stroke-width': 1.1 }));
    // full sharp tooth for reference
    if (Math.abs(g.depth - g.full) > 1e-6) {
      let r = '';
      for (let i = 0; i < n; i++) {
        const c = x0 + (i + 0.5) * g.pc * kt, hw = g.full * kt;
        r += `M${P(c - hw, ys)}L${P(c, ys + g.full * kt)}L${P(c + hw, ys)}`;
      }
      svg.append(s('path', { d: r, fill: 'none', stroke: 'var(--tool-kn-dim)', 'stroke-dasharray': '3 3' }));
      svg.append(s('text', { class: 'halo', x: x0 + 0.5 * g.pc * kt, y: ys + g.full * kt + 14, 'text-anchor': 'middle', 'font-size': 10 }, `sharp ${r2(g.full)}`));
    }
    // pc dimension above
    const c1 = x0 + 0.5 * g.pc * kt, c2 = x0 + 1.5 * g.pc * kt;
    svg.append(s('path', { class: 'dim', d: `M${P(c1, ys - 3)}V10M${P(c2, ys - 3)}V10M${P(c1, 14)}H${c2.toFixed(1)}` }));
    svg.append(s('text', { class: 'v halo', x: (c1 + c2) / 2, y: 11, 'text-anchor': 'middle' }, `pc ${r2(g.pc)}`));
    // 90 deg
    svg.append(s('text', { x: c1, y: ys + g.depth * kt * 0.62, 'text-anchor': 'middle', 'font-size': 10 }, '90°'));
    // depth dimension + handle on the middle groove
    const cm = x0 + 1.5 * g.pc * kt, yb = ys + g.depth * kt;
    const xd = x0 + n * g.pc * kt + 22;
    svg.append(s('path', { class: 'dim', d: `M${P(cm + 8, yb)}H${xd + 4}M${P(xd, ys)}V${yb.toFixed(1)}` }));
    svg.append(s('text', { class: `${over ? 'bad' : 'v'} halo`, x: xd - 4, y: (ys + yb) / 2 + 4, 'text-anchor': 'end' }, `h ${r2(g.depth)}`));
    if (over) svg.append(s('text', { class: 'bad halo', x: W / 2, y: H - 6, 'text-anchor': 'middle' }, 'deeper than a sharp tooth: crests cut away'));
    else svg.append(s('text', { x: W / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 10 }, ctx.raw.depth === '' || ctx.raw.depth == null ? 'full sharp depth (empty field)' : `flat crest ${r2(g.pc - 2 * g.depth)} mm`));
    const hH = handle(cm, yb, `Groove depth ${r2(g.depth)} mm`, (step) => {
      const v = Math.max(0.02, g.depth + step * 0.02);
      set('depth', v >= g.full - 1e-9 ? '' : r2(v), 'depth');
    });
    hH.dataset.key = 'depth';
    hH.style.cursor = 'ns-resize';
    draggable(hH, () => { dragFrame = { kt }; const off = () => { dragFrame = null; window.removeEventListener('pointerup', off); redraw(); }; window.addEventListener('pointerup', off); return { d0: g.depth, full: g.full }; }, (st, dx, dy) => {
      let v = Math.round((st.d0 + dy / kt) * 100) / 100;
      v = Math.max(0.02, v);
      set('depth', v >= st.full * 0.98 ? '' : r2(v), 'depth');
    }, wrap);
    svg.append(hH);
  }

  // ---------------- toolbar state + messages ----------------
  function drawBar() {
    const raw = ctx.raw;
    patBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(PATTERNS[i][0] === (raw.pattern || 'diamond'))));
    procBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(PROCESS[i][0] === (raw.process || 'machined'))));
    pitchBtns.forEach((b, i) => {
      const p = PITCHES[i];
      b.setAttribute('aria-pressed', String(p === String(raw.pitch || 'auto')));
      const row = g && (p === 'auto' ? null : g.pitches.find((x) => String(x.p) === p));
      b.classList.toggle('din', !!(g && p !== 'auto' && Number(p) === g.pAuto));
      b.classList.toggle('bad', !!(row && g.process === 'machined' && Math.abs(row.err) > 3));
      b.querySelector('small').textContent = !g ? '' : p === 'auto' ? `${g.pAuto}` : row ? `${row.N}` : '';
      b.title = !g ? '' : p === 'auto' ? `DIN 82 guide: ${g.pAuto} mm at Ø${r2(g.d)}` : row ? `${row.N} grooves, actual ${r2(row.pAct)} mm (${row.err >= 0 ? '+' : ''}${r2(row.err)} %)` : '';
    });
    const sync = (inp, v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    sync(dIn, raw.d); sync(lIn, raw.len); sync(bIn, raw.beta); sync(hIn, raw.depth);
    bF.style.display = (raw.pattern || 'diamond') === 'straight' ? 'none' : '';
    for (const [inp, key] of [[dIn, 'd'], [lIn, 'len'], [bIn, 'beta'], [hIn, 'depth']]) {
      const v = String(raw[key] ?? '').trim();
      inp.classList.toggle('bad', v !== '' && num(v) == null);
    }
  }
  function drawMsgs() {
    msgs.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
  }

  function redraw() {
    drawPart(); drawStrip(); drawTooth();
    if (refocus.key) {
      const el = wrap.querySelector(`.hd[data-key="${refocus.key}"]`);
      if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    }
  }
  ctx.onResult((r) => {
    res = r; g = r && r.drawing ? r.drawing : null;
    drawBar(); drawMsgs(); redraw();
    refocus.key = null;
  });
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(redraw); }).observe(wrap);
}
