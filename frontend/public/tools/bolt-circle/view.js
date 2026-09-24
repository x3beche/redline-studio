// Top view of the bolt circle, to scale. Click the drawing to set the start angle
// (hole 1) to where you clicked, rounded to 5°.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

export function view(el, result, input, api) {
  el.replaceChildren();
  const d = result && result.drawing;
  if (!d || !(d.pcd > 0)) return;
  const W = 520, H = 360, ox = W / 2, oy = H / 2;
  const R = d.pcd / 2;
  const reach = R + Math.max(d.hole / 2, R * 0.04);
  const k = (H / 2 - 34) / reach;
  const X = (x) => ox + (x - d.cx) * k, Y = (y) => oy - (y - d.cy) * k;
  const f = (v) => api.fmtNum(v, 4);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `Bolt circle with ${d.holes.length} holes`, style: 'display:block;max-height:380px;cursor:crosshair' });
  const txt = { 'font-size': 12, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' };
  // axes
  svg.append(s('line', { x1: 12, x2: W - 12, y1: oy, y2: oy, stroke: 'var(--line-soft)' }));
  svg.append(s('line', { x1: ox, x2: ox, y1: 10, y2: H - 10, stroke: 'var(--line-soft)' }));
  svg.append(s('text', { ...txt, x: W - 14, y: oy - 6, fill: 'var(--ink-soft)', 'text-anchor': 'end' }, '+X 0°'));
  svg.append(s('text', { ...txt, x: ox + 6, y: 20, fill: 'var(--ink-soft)' }, '+Y 90°'));
  // pitch circle
  svg.append(s('circle', { cx: ox, cy: oy, r: R * k, fill: 'none', stroke: 'var(--accent)', 'stroke-dasharray': '6 4' }));
  svg.append(s('text', { ...txt, x: ox + R * k * 0.7071 + 6, y: oy + R * k * 0.7071 + 16, fill: 'var(--accent)' }, `PCD ${f(d.pcd)}`));
  // start angle arc
  const t0 = (d.start * Math.PI) / 180, ra = Math.min(R * k * 0.35, 46);
  svg.append(s('line', { x1: ox, y1: oy, x2: ox + R * k * Math.cos(t0), y2: oy - R * k * Math.sin(t0), stroke: 'var(--ink-soft)', 'stroke-dasharray': '2 3' }));
  if (Math.abs(d.start % 360) > 0.5) {
    const a = ((d.start % 360) + 360) % 360;
    const large = a > 180 ? 1 : 0;
    svg.append(s('path', { d: `M${ox + ra},${oy} A${ra},${ra} 0 ${large} 0 ${ox + ra * Math.cos(t0)},${oy - ra * Math.sin(t0)}`, fill: 'none', stroke: 'var(--ink-soft)' }));
    svg.append(s('text', { ...txt, x: ox + ra + 4, y: oy - 6, fill: 'var(--ink-soft)' }, `${f(d.start)}°`));
  }
  const hr = Math.max(3, (d.hole / 2) * k);
  for (const h of d.holes) {
    const first = h.i === 1;
    svg.append(s('circle', { cx: X(h.x), cy: Y(h.y), r: hr, fill: first ? 'var(--tool-s1)' : 'var(--sunken)', 'fill-opacity': first ? 0.5 : 1, stroke: 'var(--ink)', 'stroke-width': 1.5 }));
    const lx = ox + (X(h.x) - ox) * (1 + (hr + 12) / (R * k || 1));
    const ly = oy + (Y(h.y) - oy) * (1 + (hr + 12) / (R * k || 1));
    if (d.holes.length <= 36 || first) svg.append(s('text', { ...txt, x: lx, y: ly + 4, 'text-anchor': 'middle', fill: first ? 'var(--ink)' : 'var(--ink-soft)', 'font-weight': first ? 700 : 400 }, String(h.i)));
  }
  svg.append(s('line', { x1: ox - 6, x2: ox + 6, y1: oy, y2: oy, stroke: 'var(--ink)' }));
  svg.append(s('line', { x1: ox, x2: ox, y1: oy - 6, y2: oy + 6, stroke: 'var(--ink)' }));
  svg.append(s('text', { ...txt, x: 12, y: H - 12, fill: 'var(--ink-soft)' }, `centre (${f(d.cx)}, ${f(d.cy)})`));
  svg.addEventListener('click', (e) => {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const px = ((e.clientX - r.left) / r.width) * W - ox, py = oy - ((e.clientY - r.top) / r.height) * H;
    if (Math.hypot(px, py) < 8) return;
    const a = Math.round(((Math.atan2(py, px) * 180) / Math.PI) / 5) * 5;
    api.set('start', String((a + 360) % 360));
  });
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Top view, to scale · click to move hole 1';
  wrap.append(title, svg);
  el.append(wrap);
}
