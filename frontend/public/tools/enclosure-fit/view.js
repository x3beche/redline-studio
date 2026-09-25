// Enclosure Fit Checker: the page is the box, unfolded. The floor plan with
// the board in it sits in the middle and the four walls are folded out flat
// around it, so every cut-out lies in its wall right beside the board edge
// its connector sits on. Drag a connector along the board edge (or onto
// another edge), drag a cut-out up and down its wall, drag the board's corner
// to size the board; the height stack on the left is a section through the
// box with each layer's number on it. Every number drawn comes from run()'s
// result (result.draw).

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
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const n = (v, d = 4) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(d))));
const snap = (v, st) => Math.round(v / st) * st;
const fmtIn = (v) => String(Number(v.toFixed(2)));

const SIDES = [['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right']];
// Typical connector bodies (width × height above the board, overhang past the edge).
// Starting points only: take the real numbers from the datasheet.
const PRESETS = [
  ['USB-C receptacle', 8.94, 3.26, 0.5],
  ['Micro-USB B', 7.5, 2.6, 0.6],
  ['USB-A receptacle', 13.2, 5.6, 0.5],
  ['RJ45 jack', 16, 13.5, 2],
  ['DC jack 5.5/2.1', 9, 11, 0],
  ['SMA edge jack', 6.35, 6.35, 1],
  ['3.5 mm audio jack', 6, 5, 0.5],
  ['Tactile switch 6×6', 6, 5, 0.5],
];
const COLORS = ['var(--tool-c0)', 'var(--tool-c1)', 'var(--tool-c2)', 'var(--tool-c3)'];
const colorOf = (i) => COLORS[i % COLORS.length];

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let res = null, D = null;
  let sel = 0;                 // selected connector row
  let frozen = null;           // the transform held while a drag runs
  let dragging = false;
  let focusAfter = null;

  const rows = () => (Array.isArray(ctx.raw.conns) ? ctx.raw.conns.map((r) => ({ ...r })) : []);
  const setRow = (i, patch) => { const r = rows(); if (!r[i]) return; Object.assign(r[i], patch); ctx.set('conns', r); };

  // ---------- left: board, walls, height stack ----------
  const field = (key, label, unit, cls) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label}${unit ? ` ${unit}` : ''}`,
      oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: cls || 'ef-f' }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    w.sync = () => { if (document.activeElement !== inp) inp.value = ctx.raw[key] ?? ''; inp.classList.toggle('ef-bad', String(ctx.raw[key] ?? '').trim() !== '' && ctx.input[key] == null); };
    w.input = inp;
    return w;
  };
  const fBoard = [field('bl', 'Length x', 'mm'), field('bw', 'Width y', 'mm'), field('bt', 'Thickness', 'mm')];
  const fWalls = [field('wall', 'Wall', 'mm'), field('clr', 'Board to wall', 'mm'), field('margin', 'Cut-out margin', 'mm')];
  const boardCard = h('div', { class: 'ef-card' }, h('div', { class: 'ef-cap' }, 'Board'), fBoard,
    h('div', { class: 'ef-cap', style: 'margin-top:8px' }, 'Walls'), fWalls);

  // stack layers: key, label, class
  const stackInputs = {};
  const stackIn = (key, label) => {
    const inp = h('input', { class: 'ef-in', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label} mm`,
      oninput: (e) => ctx.set(key, e.target.value) });
    stackInputs[key] = inp;
    return inp;
  };
  const LAYERS = [
    ['lid', 'floor', 'Lid', 'ef-l-lid'],
    ['gap', 'lidgap', 'Gap under lid', 'ef-l-gap'],
    ['top', 'top', 'Tallest top part', 'ef-l-top'],
    ['board', 'bt', 'Board', 'ef-l-board'],
    ['so', 'so', 'Standoff', 'ef-l-so'],
    ['floor', null, 'Floor', 'ef-l-floor'],
    ['bottom', 'bottom', 'Bottom-side part', null],
  ];
  const stackEls = {};
  for (const [id, key, label] of LAYERS) if (key && !stackInputs[key]) stackIn(key, label);
  const stack = h('div', { class: 'ef-stack', role: 'group', 'aria-label': 'Height stack, section through the box' });
  const hsum = h('div', { class: 'ef-hsum' });
  const stackCard = h('div', { class: 'ef-card' }, h('div', { class: 'ef-cap' }, 'Height stack', h('b', {}, 'mm')), stack, hsum);
  const left = h('div', { class: 'ef-col ef-col-l' }, boardCard, stackCard);

  function drawStack() {
    if (!D) { stack.replaceChildren(); return; }
    const conn = D.connTop > D.top;
    const total = D.oH;
    const px = (mm) => Math.max(22, (mm / total) * 330);
    const tallest = conn ? D.cut.reduce((a, c) => (c.z0 + c.h > (a?.z0 ?? -1) + (a?.h ?? 0) ? c : a), null) : null;
    const lay = (id, mm, cls, label, inputKey, extra) => {
      const bar = h('div', { class: 'ef-bar' }, extra?.bar || null);
      const lab = h('div', { class: 'ef-lab' }, label, extra?.sub ? h('div', {}, extra.sub) : null);
      const el = h('div', { class: `ef-layer ${cls}${extra?.bad ? ' ef-bad' : ''}`, style: `height:${px(mm)}px` }, bar, lab, inputKey ? stackInputs[inputKey] : h('span', {}));
      stackEls[id] = el;
      return el;
    };
    const topSub = conn ? h('span', {}, `set by ${tallest?.name || 'a connector'}: `, h('em', {}, n(D.above))) : null;
    const soBar = [h('s'), h('s')];
    const bottomBar = h('i', { style: `height:${clamp((D.bottom / Math.max(D.so, 1e-6)) * 100, 0, 100)}%` });
    stack.replaceChildren(
      lay('lid', D.floor, 'ef-l-lid', 'Lid', 'floor'),
      lay('gap', D.lidgap, 'ef-l-gap', 'Gap under lid', 'lidgap'),
      lay('top', D.above, 'ef-l-top', 'Tallest top part', 'top', { sub: topSub, bar: conn ? h('i', { style: `height:${(D.top / D.above) * 100}%` }) : null }),
      lay('board', D.bt, 'ef-l-board', 'Board', 'bt'),
      lay('so', D.so, 'ef-l-so', 'Standoff', 'so', { bar: [...soBar, bottomBar] }),
      h('div', { class: `ef-layer${D.underGap < 1 ? ' ef-bad' : ''}`, style: 'min-height:24px' }, h('span', {}),
        h('div', { class: 'ef-lab' }, 'Bottom parts, gap ', h('em', {}, n(D.underGap)), D.underGap < 1 ? ' (< 1)' : ''), stackInputs.bottom),
      lay('floor', D.floor, 'ef-l-floor', 'Floor = lid', null),
    );
    // the bottom-parts row sits under the standoff layer in the list but belongs to it
    hsum.replaceChildren(h('span', {}, 'inner H ', h('b', {}, n(D.iH))), h('span', {}, 'outer H ', h('b', {}, n(D.oH))));
    for (const [k, inp] of Object.entries(stackInputs)) {
      if (document.activeElement !== inp) inp.value = ctx.raw[k] ?? '';
      inp.classList.toggle('ef-bad', String(ctx.raw[k] ?? '').trim() !== '' && ctx.input[k] == null);
    }
  }

  // ---------- centre: the unfolded box ----------
  const svg = sv(null, 'svg', { role: 'group', 'aria-label': 'Enclosure unfolded: floor plan with the board, walls folded out around it' });
  const head = h('div', { class: 'ef-head' });
  const warns = h('div', { class: 'ef-warns', 'aria-live': 'polite' });
  const stageEl = h('section', { class: 'ef-stage' }, head, h('div', { class: 'ef-box' }, svg), warns);

  // ---------- right: selected connector ----------
  const insp = h('div', { class: 'ef-card ef-insp' });
  const right = h('div', { class: 'ef-col ef-col-r' }, insp, ctx.outputs);
  root.append(h('div', { class: 'ef' }, left, stageEl, right));

  function drawHead() {
    if (!D) { head.replaceChildren(h('span', {}, res?.warnings?.[0] || '')); return; }
    head.replaceChildren(
      h('span', {}, 'inner ', h('b', {}, `${n(D.iL)} × ${n(D.iW)} × ${n(D.iH)}`)),
      h('span', {}, 'outer ', h('b', {}, `${n(D.oL)} × ${n(D.oW)} × ${n(D.oH)}`), ' mm'),
      h('span', {}, 'volume ', h('b', {}, n(D.volume, 3)), ' cm³'),
      h('span', { class: 'ef-hint' }, 'walls folded out flat, floor edge at the fold'));
  }

  function drawNet() {
    const keep = focusAfter || document.activeElement?.getAttribute?.('data-h');
    svg.replaceChildren();
    const W = Math.max(300, svg.clientWidth || 800), H = Math.max(300, svg.clientHeight || 600);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!D) { sv(svg, 'text', { x: 16, y: 30, class: 'ef-t ef-t-soft' }, res?.warnings?.[0] || ''); return; }
    const narrow = W < 560;
    const gap = narrow ? 4 : 7, mX = narrow ? 32 : 48, mY = narrow ? 26 : 40;
    let s, ox, oy;
    if (frozen) ({ s, ox, oy } = frozen);
    else {
      s = Math.min((W - 2 * mX - 2 * gap) / (D.oL + 2 * D.oH), (H - 2 * mY - 2 * gap) / (D.oW + 2 * D.oH));
      const netW = (D.oL + 2 * D.oH) * s + 2 * gap, netH = (D.oW + 2 * D.oH) * s + 2 * gap;
      ox = (W - netW) / 2 + D.oH * s + gap;
      oy = (H - netH) / 2 + D.oH * s + gap;
    }
    const cur = { s, ox, oy };
    // plan: x right, y up (front = y 0 at the bottom)
    const PX = (x) => ox + x * s, PY = (y) => oy + (D.oW - y) * s;
    // walls: (along, z) -> screen, per side
    const WALL = {
      front: (a, z) => [PX(a), oy + D.oW * s + gap + z * s],
      back: (a, z) => [PX(a), oy - gap - z * s],
      left: (a, z) => [ox - gap - z * s, PY(a)],
      right: (a, z) => [ox + D.oL * s + gap + z * s, PY(a)],
    };
    const wallLen = { front: D.oL, back: D.oL, left: D.oW, right: D.oW };
    const rectW = (side, a0, a1, z0, z1, attrs) => {
      const [x0, y0] = WALL[side](a0, z0), [x1, y1] = WALL[side](a1, z1);
      return sv(svg, 'rect', { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), ...attrs });
    };
    const lineW = (side, a0, z0, a1, z1, attrs) => { const [x0, y0] = WALL[side](a0, z0), [x1, y1] = WALL[side](a1, z1); return sv(svg, 'line', { x1: x0, y1: y0, x2: x1, y2: y1, ...attrs }); };

    const defs = sv(svg, 'defs');
    const mk = sv(defs, 'marker', { id: 'ef-ar', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,0 L10,5 L0,10 z', class: 'ef-ah' });

    // walls, folded out
    for (const [side] of SIDES) {
      const L = wallLen[side];
      rectW(side, 0, L, 0, D.oH, { class: 'ef-wallbg' });
      // floor and lid thickness, board level, seen through the wall
      rectW(side, 0, L, 0, D.floor, { class: 'ef-wallband' });
      rectW(side, 0, L, D.oH - D.floor, D.oH, { class: 'ef-wallband' });
      rectW(side, D.wall, L - D.wall, D.zb, D.zt, { class: 'ef-boardz' });
      lineW(side, 0, 0, L, 0, { class: 'ef-fold' });
      const [tx, ty] = WALL[side](L / 2, D.oH - D.floor / 2);
      const rot = side === 'left' ? -90 : side === 'right' ? 90 : 0;
      sv(svg, 'text', { x: tx, y: ty + 3.5, class: 'ef-t ef-t-soft', 'text-anchor': 'middle', 'font-size': 10, 'letter-spacing': '0.08em',
        transform: rot ? `rotate(${rot} ${tx} ${ty})` : null }, narrow ? side.toUpperCase() : `${side.toUpperCase()} WALL · lid edge`);
    }
    // plan: outer, inner, board
    sv(svg, 'rect', { x: PX(0), y: PY(D.oW), width: D.oL * s, height: D.oW * s, class: 'ef-wallband', stroke: 'var(--tool-wall)', 'stroke-width': 1.2 });
    sv(svg, 'rect', { x: PX(D.wall), y: PY(D.oW - D.wall), width: D.iL * s, height: D.iW * s, class: 'ef-inner' });
    sv(svg, 'rect', { x: PX(D.bx), y: PY(D.by + D.bw), width: D.bl * s, height: D.bw * s, class: 'ef-board' });
    if (!narrow) sv(svg, 'text', { x: PX(D.bx + D.bl / 2), y: PY(D.by + D.bw) + 16, class: 'ef-t ef-t-soft', 'text-anchor': 'middle' }, `board ${n(D.bl)} × ${n(D.bw)} × ${n(D.bt)}`);

    // cut-outs: notch in the plan wall band, opening in the folded-out wall
    const planCut = (c) => {
      const lo = c.centre - c.cw / 2;
      if (c.side === 'front') return [PX(lo), PY(D.wall), c.cw * s, D.wall * s];
      if (c.side === 'back') return [PX(lo), PY(D.oW), c.cw * s, D.wall * s];
      if (c.side === 'left') return [PX(0), PY(lo + c.cw), D.wall * s, c.cw * s];
      return [PX(D.oL - D.wall), PY(lo + c.cw), D.wall * s, c.cw * s];
    };
    const bodyRect = (c) => {
      // the connector on the board, seen from above: width along the edge,
      // a nominal depth into the board, the face `over` past the edge
      const dep = clamp(Math.max(c.w * 0.8, 6), 3, (c.along === 'x' ? D.bw : D.bl) * 0.45);
      const lo = c.centre - c.w / 2;
      if (c.side === 'front') return [lo, D.by - c.over, c.w, dep];
      if (c.side === 'back') return [lo, D.by + D.bw + c.over - dep, c.w, dep];
      if (c.side === 'left') return [D.bx - c.over, lo, dep, c.w];
      return [D.bx + D.bl + c.over - dep, lo, dep, c.w];
    };

    const planToMm = (clientX, clientY) => {
      const r = svg.getBoundingClientRect();
      const x = (((clientX - r.left) / r.width) * W - cur.ox) / cur.s;
      const y = D.oW - (((clientY - r.top) / r.height) * H - cur.oy) / cur.s;
      return [x, y];
    };
    const startDrag = (el, e, move) => {
      e.preventDefault(); capture(el, e); frozen = cur; dragging = true;
      const mv = (ev) => move(ev);
      const up = () => { el.removeEventListener('pointermove', mv); frozen = null; dragging = false; drawNet(); };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up, { once: true });
      el.addEventListener('pointercancel', up, { once: true });
    };
    const select = (i) => { if (sel !== i) { sel = i; drawInsp(); } };

    D.cut.forEach((c) => {
      const col = colorOf(c.i);
      const bad = c.flags.length > 0;
      const isSel = c.i === sel;
      // wall opening
      const g = sv(svg, 'g', { class: `ef-cut${isSel ? ' ef-sel' : ''}`, tabindex: 0, role: 'button', 'data-h': `cut-${c.i}`,
        'aria-label': `${c.name} cut-out in the ${c.side} wall, ${n(c.cw)} by ${n(c.ch)} mm from z ${n(c.zLo)}; arrow keys move it, up and down change its height on the board` });
      const along0 = c.centre - c.cw / 2, along1 = c.centre + c.cw / 2;
      g.append(rectW(c.side, along0, along1, c.zLo, c.zHi, { class: 'ef-hole', stroke: bad ? 'var(--danger)' : col }));
      const bz0 = D.zt + c.z0, bz1 = bz0 + c.h;
      const bodyW = rectW(c.side, c.centre - c.w / 2, c.centre + c.w / 2, bz0, bz1, { class: 'ef-body', fill: `color-mix(in srgb, ${col} 30%, transparent)`, stroke: col, 'stroke-width': 0.8 });
      g.append(bodyW);
      if (bad) { const [mx, my] = WALL[c.side](along1, c.zHi); const m = sv(g, 'circle', { cx: mx, cy: my, r: 6, class: 'ef-bad-mark' }); sv(g, 'text', { x: mx, y: my + 3.5, 'text-anchor': 'middle', class: 'ef-t', fill: 'var(--paper)', style: 'fill:var(--paper);font-weight:700' }, '!'); void m; }
      g.addEventListener('pointerdown', (e) => {
        select(c.i); focusAfter = `cut-${c.i}`; g.focus();
        const [a0] = planToMm(e.clientX, e.clientY);
        const start = { x: e.clientX, y: e.clientY, pos: c.pos, z0: c.z0 };
        void a0;
        startDrag(g, e, (ev) => {
          const dx = (ev.clientX - start.x) / cur.s * (svg.getBoundingClientRect().width ? W / svg.getBoundingClientRect().width : 1);
          const dy = (ev.clientY - start.y) / cur.s * (svg.getBoundingClientRect().height ? H / svg.getBoundingClientRect().height : 1);
          // along the wall and up the wall, in that wall's screen directions
          const dAlong = c.side === 'front' || c.side === 'back' ? dx : -dy;
          const dUp = c.side === 'front' ? dy : c.side === 'back' ? -dy : c.side === 'left' ? -dx : dx;
          const edge = c.along === 'x' ? D.bl : D.bw;
          setRow(c.i, { pos: fmtIn(clamp(snap(start.pos + dAlong, 0.5), 0, edge)), z0: fmtIn(snap(start.z0 + dUp, 0.25)) });
        });
      });
      g.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 5 : 0.5;
        const edge = c.along === 'x' ? D.bl : D.bw;
        let patch = null;
        const along = c.side === 'front' || c.side === 'back';
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const d = (e.key === 'ArrowRight' ? 1 : -1) * st;
          patch = along ? { pos: fmtIn(clamp(c.pos + d, 0, edge)) } : { z0: fmtIn(c.z0 + (c.side === 'right' ? d : -d) / 2) };
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const d = (e.key === 'ArrowUp' ? 1 : -1) * st;
          patch = along ? { z0: fmtIn(c.z0 + (c.side === 'back' ? d : -d) / 2) } : { pos: fmtIn(clamp(c.pos + d, 0, edge)) };
        }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(c.i); insp.querySelector('.ef-name')?.focus(); return; }
        if (patch) { e.preventDefault(); sel = c.i; focusAfter = `cut-${c.i}`; setRow(c.i, patch); }
      });

      // plan: notch and the body on the board
      const [nx, ny, nw, nh] = planCut(c);
      sv(svg, 'rect', { x: nx, y: ny, width: nw, height: nh, class: 'ef-hole', stroke: bad ? 'var(--danger)' : col, 'stroke-width': 1 });
      const [bx0, by0, bw0, bh0] = bodyRect(c);
      const pg = sv(svg, 'g', { class: `ef-conn${isSel ? ' ef-sel' : ''}`, tabindex: 0, role: 'button', 'data-h': `conn-${c.i}`,
        'aria-label': `${c.name} on the ${c.side} edge at ${n(c.pos)} mm; arrow keys move it along the edge` });
      sv(pg, 'rect', { x: PX(bx0), y: PY(by0 + bh0), width: bw0 * s, height: bh0 * s, rx: 1.5, class: 'ef-body', fill: `color-mix(in srgb, ${col} 34%, var(--surface))`, stroke: col });
      if (isSel) sv(pg, 'rect', { x: PX(bx0) - 4, y: PY(by0 + bh0) - 4, width: bw0 * s + 8, height: bh0 * s + 8, rx: 3, class: 'ef-sel-ring' });
      // name inside the board, beside the body
      const inward = { front: [0, 1], back: [0, -1], left: [1, 0], right: [-1, 0] }[c.side];
      const tcx = PX(bx0 + bw0 / 2) + inward[0] * (bw0 * s / 2 + 6), tcy = PY(by0 + bh0 / 2) - inward[1] * (bh0 * s / 2 + 6);
      const anchor = inward[0] > 0 ? 'start' : inward[0] < 0 ? 'end' : 'middle';
      const tl = narrow && !isSel ? sv(null, 'text') : sv(pg, 'text', { x: tcx, y: tcy + (inward[1] > 0 ? -2 : inward[1] < 0 ? 9 : 4), class: 'ef-t', 'text-anchor': anchor });
      sv(tl, 'tspan', { class: 'ef-t-b' }, c.name);
      sv(tl, 'tspan', { class: c.flags.includes('deep') || c.flags.includes('proud') ? 'ef-t-bad' : 'ef-t-soft', dx: 6 },
        c.behind < -0.01 ? `${n(-c.behind, 3)} proud` : `face ${n(c.behind, 3)} in`);
      pg.addEventListener('pointerdown', (e) => {
        select(c.i); focusAfter = `conn-${c.i}`; pg.focus();
        startDrag(pg, e, (ev) => {
          const [x, y] = planToMm(ev.clientX, ev.clientY);
          const cand = [
            ['front', Math.abs(y - D.by), x - D.bx, D.bl], ['back', Math.abs(y - D.by - D.bw), x - D.bx, D.bl],
            ['left', Math.abs(x - D.bx), y - D.by, D.bw], ['right', Math.abs(x - D.bx - D.bl), y - D.by, D.bw],
          ].sort((a, b) => a[1] - b[1])[0];
          setRow(c.i, { side: cand[0], pos: fmtIn(clamp(snap(cand[2], 0.5), 0, cand[3])) });
        });
      });
      pg.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 5 : 0.5;
        const edge = c.along === 'x' ? D.bl : D.bw;
        const d = c.along === 'x' ? { ArrowRight: st, ArrowLeft: -st }[e.key] : { ArrowUp: st, ArrowDown: -st }[e.key];
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(c.i); insp.querySelector('.ef-name')?.focus(); return; }
        if (!d) return;
        e.preventDefault(); sel = c.i; focusAfter = `conn-${c.i}`;
        setRow(c.i, { pos: fmtIn(clamp(c.pos + d, 0, edge)) });
      });
    });

    // dimensions for the selected cut-out, in its wall
    const sc = D.cut.find((c) => c.i === sel);
    if (sc) {
      const side = sc.side;
      const out = side === 'front' || side === 'right' ? 1 : -1; // which way "further from the fold" goes on screen
      void out;
      const zDim = D.oH + (narrow ? 3 : 4) / s * 4;
      // centre position from the wall's start (outer corner)
      const [ax, ay] = WALL[side](0, zDim), [bx, by] = WALL[side](sc.centre, zDim);
      sv(svg, 'line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'ef-dim', 'marker-start': 'url(#ef-ar)', 'marker-end': 'url(#ef-ar)' });
      const [cx0, cy0] = WALL[side](sc.centre, sc.zHi);
      sv(svg, 'line', { x1: cx0, y1: cy0, x2: bx, y2: by, class: 'ef-dim', 'stroke-dasharray': '2 2' });
      const hor = side === 'front' || side === 'back';
      const t = sv(svg, 'text', { x: (ax + bx) / 2 + (hor ? 0 : side === 'left' ? -4 : 4), y: (ay + by) / 2 + (hor ? (side === 'front' ? 13 : -4) : 4),
        class: 'ef-t ef-t-big', 'text-anchor': hor ? 'middle' : side === 'left' ? 'end' : 'start' }, `${sc.along} ${n(sc.centre)}`);
      void t;
      // width and z range beside the opening
      const [lx, ly] = WALL[side](sc.centre + sc.cw / 2, (sc.zLo + sc.zHi) / 2);
      const lab = sv(svg, 'text', { x: hor ? lx + 6 : lx, y: hor ? ly + 4 : ly + (side === 'left' || side === 'right' ? -6 : 0), class: 'ef-t',
        'text-anchor': hor ? 'start' : 'middle' });
      sv(lab, 'tspan', { class: 'ef-t-b' }, `${n(sc.cw)} × ${n(sc.ch)}`);
      sv(lab, 'tspan', { x: hor ? lx + 6 : lx, dy: 12, class: 'ef-t-soft' }, `z ${n(sc.zLo)}–${n(sc.zHi)}`);
      if (!hor) { lab.setAttribute('transform', `rotate(${side === 'left' ? -90 : 90} ${lx} ${ly})`); lab.setAttribute('y', ly + (side === 'left' ? -8 : -8)); lab.querySelectorAll('tspan')[1].setAttribute('x', lx); }
    }

    // overall dimensions: outer length under the front wall, outer width right of the right wall
    const yl = oy - gap - D.oH * s - (narrow ? 12 : 16);
    sv(svg, 'line', { x1: PX(0), y1: yl, x2: PX(D.oL), y2: yl, class: 'ef-dim', 'marker-start': 'url(#ef-ar)', 'marker-end': 'url(#ef-ar)' });
    sv(svg, 'text', { x: PX(D.oL / 2), y: yl - 4, class: 'ef-t', 'text-anchor': 'middle' }, narrow ? `${n(D.oL)}` : `outer ${n(D.oL)}  (inner ${n(D.iL)})`);
    const xw = ox - gap - D.oH * s - (narrow ? 12 : 16);
    sv(svg, 'line', { x1: xw, y1: PY(0), x2: xw, y2: PY(D.oW), class: 'ef-dim', 'marker-start': 'url(#ef-ar)', 'marker-end': 'url(#ef-ar)' });
    sv(svg, 'text', { x: xw - 4, y: PY(D.oW / 2), class: 'ef-t', 'text-anchor': 'middle', transform: `rotate(-90 ${xw - 4} ${PY(D.oW / 2)})` }, narrow ? `${n(D.oW)}` : `outer ${n(D.oW)}  (inner ${n(D.iW)})`);
    // height on the front wall's left end
    const [hx0, hy0] = WALL.front(D.oL, 0), [, hy1] = WALL.front(D.oL, D.oH);
    const hx = hx0 + (narrow ? 8 : 12);
    sv(svg, 'line', { x1: hx, y1: hy0, x2: hx, y2: hy1, class: 'ef-dim', 'marker-start': 'url(#ef-ar)', 'marker-end': 'url(#ef-ar)' });
    sv(svg, 'text', { x: hx + 4, y: (hy0 + hy1) / 2, class: 'ef-t', 'text-anchor': 'middle', transform: `rotate(90 ${hx + 4} ${(hy0 + hy1) / 2})` }, narrow ? `H ${n(D.oH)}` : `H ${n(D.oH)} (inner ${n(D.iH)})`);

    // board corner knob: drag to size the board
    const kx = PX(D.bx + D.bl), ky = PY(D.by + D.bw);
    const kg = sv(svg, 'g', { class: 'ef-knob', tabindex: 0, role: 'slider', 'data-h': 'board', 'aria-label': `Board ${n(D.bl)} by ${n(D.bw)} mm; arrow keys resize it` });
    sv(kg, 'circle', { cx: kx, cy: ky, r: 13 }); sv(kg, 'circle', { cx: kx, cy: ky, r: 5.5 });
    kg.addEventListener('pointerdown', (e) => {
      focusAfter = 'board'; kg.focus();
      startDrag(kg, e, (ev) => {
        const [x, y] = planToMm(ev.clientX, ev.clientY);
        ctx.setMany({ bl: fmtIn(clamp(snap(x - D.bx, 0.5), 5, 1000)), bw: fmtIn(clamp(snap(y - D.by, 0.5), 5, 1000)) });
      });
    });
    kg.addEventListener('keydown', (e) => {
      const st = e.shiftKey ? 5 : 0.5;
      const d = { ArrowRight: ['bl', st], ArrowLeft: ['bl', -st], ArrowUp: ['bw', st], ArrowDown: ['bw', -st] }[e.key];
      if (!d) return;
      e.preventDefault(); focusAfter = 'board';
      ctx.set(d[0], fmtIn(Math.max(5, D[d[0]] + d[1])));
    });

    if (keep) { const el = svg.querySelector(`[data-h="${CSS.escape(keep)}"]`); if (el && document.activeElement !== el) el.focus({ preventScroll: true }); }
    if (!dragging) focusAfter = null;
  }

  // ---------- inspector ----------
  let inspFocus = null;
  function drawInsp() {
    const rs = rows();
    if (sel >= rs.length) sel = Math.max(0, rs.length - 1);
    const active = document.activeElement;
    inspFocus = insp.contains(active) ? active.getAttribute('data-k') : null;
    const chips = h('div', { class: 'ef-chips', role: 'group', 'aria-label': 'Connectors' }, rs.map((r, i) => {
      const c = D?.cut.find((x) => x.i === i);
      return h('button', { type: 'button', class: `ef-chip${c?.flags.length ? ' ef-bad' : ''}`, 'aria-pressed': String(i === sel),
        onclick: () => { sel = i; drawInsp(); drawNet(); } }, h('i', { style: `background:${colorOf(i)}` }), r.name || `Connector ${i + 1}`);
    }));
    const presetSel = h('select', { 'aria-label': 'Add a connector', onchange: (e) => {
      const p = PRESETS[Number(e.target.value)];
      if (!p) return;
      const r = rows();
      const used = new Set(r.map((x) => x.side));
      const side = ['back', 'right', 'left', 'front'].find((x) => !used.has(x)) || 'back';
      const edge = side === 'front' || side === 'back' ? D?.bl ?? 40 : D?.bw ?? 30;
      r.push({ name: p[0].replace(/ (receptacle|jack|edge jack)$/, ''), side, pos: fmtIn(edge / 2), w: String(p[1]), h: String(p[2]), z0: '0', over: String(p[3]) });
      sel = r.length - 1; ctx.set('conns', r);
    } }, h('option', { value: '' }, '+ Add connector…'), PRESETS.map((p, i) => h('option', { value: i }, `${p[0]}  ${p[1]} × ${p[2]}`)),
    h('option', { value: PRESETS.length }, 'Custom 10 × 5'));
    presetSel.addEventListener('change', (e) => {
      if (Number(e.target.value) === PRESETS.length) {
        const r = rows(); r.push({ name: `Connector ${r.length + 1}`, side: 'back', pos: fmtIn((D?.bl ?? 40) / 2), w: '10', h: '5', z0: '0', over: '0' });
        sel = r.length - 1; ctx.set('conns', r);
      }
    });
    const r = rs[sel];
    const c = D?.cut.find((x) => x.i === sel);
    const body = [];
    if (r) {
      const name = h('input', { class: 'ef-name', 'data-k': 'name', value: r.name ?? '', 'aria-label': 'Connector name', oninput: (e) => setRow(sel, { name: e.target.value }) });
      const seg = h('div', { class: 'ef-seg', role: 'radiogroup', 'aria-label': 'Board edge' }, SIDES.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-k': `side-${v}`,
        'aria-checked': String(r.side === v), tabindex: r.side === v ? 0 : -1, onclick: () => setRow(sel, { side: v }),
        onkeydown: (e) => {
          const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault();
          const i = SIDES.findIndex((x) => x[0] === r.side); const nv = SIDES[clamp(i + d, 0, 3)][0]; setRow(sel, { side: nv }); inspFocus = `side-${nv}`;
        } }, t)));
      const f = (k, label, unit) => h('label', { class: 'ef-f' }, h('span', {}, label),
        h('input', { type: 'text', inputmode: 'decimal', 'data-k': k, value: r[k] ?? '', 'aria-label': `${label} ${unit}`, oninput: (e) => setRow(sel, { [k]: e.target.value }) }), h('small', {}, unit));
      body.push(h('div', { class: 'ef-row' }, h('i', { style: `width:10px;height:10px;border-radius:2px;background:${colorOf(sel)}` }), name),
        h('div', { class: 'ef-row' }, 'Edge', seg),
        h('div', { class: 'ef-grid2' }, f('pos', 'Centre', 'mm'), f('w', 'Width', 'mm'), f('z0', 'z on board', 'mm'), f('h', 'Height', 'mm'), f('over', 'Overhang', 'mm')));
      if (c) {
        const bad = (k) => (c.flags.includes(k) ? 'ef-bad' : '');
        body.push(h('div', { class: 'ef-out' },
          h('span', {}, `Cut-out centre, ${c.side} wall`), h('b', { class: bad('corner') || bad('edge') }, `${c.along} = ${n(c.centre)}`),
          h('span', {}, 'Cut-out width × height'), h('b', { class: bad('web') }, `${n(c.cw)} × ${n(c.ch)}`),
          h('span', {}, 'z from outer bottom'), h('b', { class: bad('floor') || bad('lid') }, `${n(c.zLo)} – ${n(c.zHi)}`),
          h('span', {}, c.behind < -0.01 ? 'Sticks out past the wall' : 'Face behind outer surface'), h('b', { class: bad('deep') || bad('proud') }, `${n(Math.abs(c.behind), 3)} mm`)));
      } else body.push(h('div', { class: 'ef-out' }, h('span', {}, 'Incomplete row: give side, position, width and height.')));
    }
    const del = r ? h('button', { type: 'button', class: 'ef-btn ef-del', onclick: () => { const x = rows(); x.splice(sel, 1); sel = Math.max(0, sel - 1); ctx.set('conns', x); } }, 'Delete') : null;
    insp.replaceChildren(h('div', { class: 'ef-cap' }, 'Connectors', h('b', {}, String(rs.length))), chips, ...body, h('div', { class: 'ef-actions' }, presetSel, del));
    if (inspFocus) { const el = insp.querySelector(`[data-k="${CSS.escape(inspFocus)}"]`); if (el) { el.focus(); if (el.setSelectionRange && el.value != null) el.setSelectionRange(el.value.length, el.value.length); } }
  }

  function drawWarns() { warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w))); }
  const draw = () => {
    for (const f of [...fBoard, ...fWalls]) f.sync();
    drawHead(); drawStack(); drawNet(); drawInsp(); drawWarns();
  };
  ctx.onResult((r) => { res = r; D = r.draw || null; draw(); });
  new ResizeObserver(() => { if (!dragging) drawNet(); }).observe(svg);
}
