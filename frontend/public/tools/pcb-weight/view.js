// Top view of the board to scale: parts as discs (area ∝ mass), bottom-side
// parts dashed, the board centre and the centre of gravity marked.
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
  if (!d || !(d.w > 0) || !(d.h > 0)) return;
  const W = 600, pad = 34;
  const k = Math.min((W - 2 * pad) / d.w, 340 / d.h);
  const bw = d.w * k, bh = d.h * k;
  const H = bh + 2 * pad + 18;
  const ox = (W - bw) / 2, oy = pad;
  const X = (x) => ox + x * k, Y = (y) => oy + bh - y * k;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Board top view with centre of gravity', style: 'display:block;max-height:440px' });
  svg.append(s('rect', { x: ox, y: oy, width: bw, height: bh, rx: 3, fill: 'var(--tool-s2)', 'fill-opacity': 0.12, stroke: 'var(--tool-s2)', 'stroke-width': 1.5 }));
  const txt = { 'font-size': 11, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' };
  const maxM = Math.max(...d.parts.map((p) => p.m), 0.001);
  for (const p of d.parts) {
    const r = Math.max(3, 18 * Math.sqrt(p.m / maxM));
    const top = p.side === 'top';
    const c = s('circle', { cx: X(p.x), cy: Y(p.y), r, fill: top ? 'var(--tool-s1)' : 'none', 'fill-opacity': 0.5, stroke: 'var(--tool-s1)', 'stroke-width': 1.5, ...(top ? {} : { 'stroke-dasharray': '3 2' }) });
    const t = s('title', {}, `${p.ref}: ${api.fmtNum(p.m, 3)} g, ${p.side}`); c.append(t);
    svg.append(c);
    svg.append(s('text', { ...txt, x: X(p.x), y: Y(p.y) - r - 3, 'text-anchor': 'middle', fill: 'var(--ink-soft)' }, p.ref.split(' ')[0]));
  }
  // board centre
  const cx = X(d.w / 2), cy = Y(d.h / 2);
  svg.append(s('line', { x1: cx - 7, x2: cx + 7, y1: cy, y2: cy, stroke: 'var(--ink-soft)' }));
  svg.append(s('line', { x1: cx, x2: cx, y1: cy - 7, y2: cy + 7, stroke: 'var(--ink-soft)' }));
  // CoG
  const gx = X(d.cog.x), gy = Y(d.cog.y);
  svg.append(s('circle', { cx: gx, cy: gy, r: 8, fill: 'var(--surface)', stroke: 'var(--accent)', 'stroke-width': 2 }));
  svg.append(s('path', { d: `M${gx},${gy - 8}A8,8 0 0 1 ${gx + 8},${gy}L${gx},${gy}Z M${gx},${gy + 8}A8,8 0 0 1 ${gx - 8},${gy}L${gx},${gy}Z`, fill: 'var(--accent)' }));
  svg.append(s('text', { ...txt, x: gx + 12, y: gy + 4, fill: 'var(--accent)' }, `CoG (${api.fmtNum(d.cog.x, 3)}, ${api.fmtNum(d.cog.y, 3)})`));
  svg.append(s('text', { ...txt, x: ox, y: oy + bh + 16, fill: 'var(--ink-soft)' }, `0,0   ${api.fmtNum(d.w, 4)} × ${api.fmtNum(d.h, 4)} mm   ● top  ◌ bottom  + centre`));
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Top view, to scale';
  wrap.append(title, svg);
  el.append(wrap);
}
