// Top views of the packages, all at one scale, packed into rows. Draws result.shapes.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const n2 = (v) => String(Number(v.toPrecision(3)));

function drawPackage(g, p, k) {
  const bw = p.bx * k, bh = p.by * k;
  const metal = { fill: 'var(--tool-s1)' };
  // Order: leads outside the body, the body, then pads inside its edge (no-lead parts).
  const inner = [];
  for (const [side, count, pitch, width, ext] of p.leads) {
    const along = side === 'T' || side === 'B';
    const span = (count - 1) * pitch;
    const inside = ext < 0, len = Math.abs(ext) * k, w = width * k;
    for (let i = 0; i < count; i++) {
      const c = (-span / 2 + i * pitch) * k;
      let x, y, rw, rh;
      if (along) {
        rw = w; rh = len; x = c - w / 2;
        y = side === 'T' ? (inside ? -bh / 2 : -bh / 2 - len) : (inside ? bh / 2 - len : bh / 2);
      } else {
        rw = len; rh = w; y = c - w / 2;
        x = side === 'L' ? (inside ? -bw / 2 : -bw / 2 - len) : (inside ? bw / 2 - len : bw / 2);
      }
      const r = s('rect', { x, y, width: Math.max(rw, 0.6), height: Math.max(rh, 0.6), ...metal });
      if (inside) inner.push(r); else g.append(r);
    }
  }
  const custom = p.cat === 'custom';
  g.append(s('rect', { x: -bw / 2, y: -bh / 2, width: bw, height: bh, rx: Math.min(bw, bh) * 0.04,
    fill: custom ? 'none' : 'var(--ink-soft)', 'fill-opacity': 0.85,
    stroke: custom ? 'var(--accent)' : 'var(--ink)', 'stroke-width': custom ? 1.5 : 0.8, 'stroke-dasharray': custom ? '4 3' : 'none' }));
  g.append(...inner);
  if (p.term) {
    const t = p.term * k;
    g.append(s('rect', { x: -bw / 2, y: -bh / 2, width: t, height: bh, ...metal }), s('rect', { x: bw / 2 - t, y: -bh / 2, width: t, height: bh, ...metal }));
  }
  if (p.ep) g.append(s('rect', { x: -p.ep[0] * k / 2, y: -p.ep[1] * k / 2, width: p.ep[0] * k, height: p.ep[1] * k, ...metal, 'fill-opacity': 0.7 }));
  if (p.balls) {
    const [cols, rows, pitch, dia] = p.balls;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      g.append(s('circle', { cx: (i - (cols - 1) / 2) * pitch * k, cy: (j - (rows - 1) / 2) * pitch * k, r: Math.max(dia * k / 2, 0.4), ...metal }));
    }
  }
  // Pin 1 mark on ICs and transistors.
  if (p.cat === 'ic' && Math.min(bw, bh) > 8) g.append(s('circle', { cx: -bw / 2 + Math.min(bw, bh) * 0.12, cy: -bh / 2 + Math.min(bw, bh) * 0.12, r: Math.max(1.2, Math.min(bw, bh) * 0.04), fill: 'var(--surface)' }));
}

export function view(el, result) {
  el.replaceChildren();
  const shapes = result && result.shapes;
  if (!shapes || !shapes.length) return;
  const W = Math.max(280, Math.round(el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 560) - 22);
  const maxDim = Math.max(...shapes.map((p) => Math.max(p.sx, p.sy)));
  // One scale for all: the largest part takes at most 40 % of the width or 170 px.
  const k = Math.min((W * 0.4) / maxDim, 170 / maxDim, 60);
  const GAP = 14, LABEL = 30, MINCELL = 64;
  const rows = [];
  let row = [], x = 0;
  for (const p of shapes) {
    const cw = Math.max(p.sx * k, MINCELL);
    if (row.length && x + cw > W) { rows.push(row); row = []; x = 0; }
    row.push({ p, cw, x }); x += cw + GAP;
  }
  if (row.length) rows.push(row);
  const TOP = 30;
  let y = TOP;
  const placed = [];
  for (const r of rows) {
    const rh = Math.max(...r.map((c) => c.p.sy * k));
    for (const c of r) placed.push({ ...c, y, rh });
    y += rh + LABEL + GAP;
  }
  const H = y;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Package outlines to one scale', style: 'display:block;height:auto' });
  // 1 mm grid behind everything (5 mm when 1 mm would be under 4 px).
  const step = k >= 4 ? 1 : 5;
  const pat = s('pattern', { id: 'pe-grid', width: step * k, height: step * k, patternUnits: 'userSpaceOnUse' });
  pat.append(s('path', { d: `M ${step * k} 0 L 0 0 0 ${step * k}`, fill: 'none', stroke: 'var(--line-soft)', 'stroke-width': 1 }));
  const defs = s('defs'); defs.append(pat); svg.append(defs);
  svg.append(s('rect', { x: 0, y: TOP - 6, width: W, height: H - TOP + 6, fill: 'url(#pe-grid)' }));
  // Scale bar.
  const bar = Math.min(10, Math.max(1, Math.round(60 / k))) ;
  svg.append(s('rect', { x: 0, y: 8, width: bar * k, height: 4, fill: 'var(--ink)' }));
  svg.append(s('text', { x: bar * k + 6, y: 14, fill: 'var(--ink-soft)', 'font-size': 11 }, `${bar} mm  ·  grid ${step} mm  ·  ${n2(k)} px/mm`));
  for (const c of placed) {
    const cx = c.x + c.cw / 2, cy = c.y + c.rh / 2;
    const g = s('g', { transform: `translate(${cx.toFixed(1)},${cy.toFixed(1)})` });
    const tt = s('title', {}, `${c.p.id}: body ${n2(c.p.bx)} × ${n2(c.p.by)} mm, with leads ${n2(c.p.sx)} × ${n2(c.p.sy)} mm`);
    g.append(tt);
    drawPackage(g, c.p, k);
    svg.append(g);
    const name = c.p.id.replace(/ \(.*\)$/, '');
    svg.append(s('text', { x: cx, y: c.y + c.rh + 13, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-size': 11 }, name));
    svg.append(s('text', { x: cx, y: c.y + c.rh + 25, 'text-anchor': 'middle', fill: 'var(--ink-soft)', 'font-size': 10 }, `${n2(c.p.sx)}×${n2(c.p.sy)}`));
  }
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Top view, one scale (overall size with leads, mm)';
  const box = document.createElement('div');
  box.className = 'k-block';
  box.append(title, svg);
  el.append(box);
}
