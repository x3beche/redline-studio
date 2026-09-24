// Top view of the mounting hole: the rings from the part keep-out in to the drill.
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
  if (!d || !(d.partKeep > 0)) return;
  const W = 600, H = 250, cx = 150, cy = H / 2;
  const k = (H - 30) / d.partKeep;
  const f = (v) => api.fmtNum(v, 3);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Mounting hole keep-out rings', style: 'display:block;max-height:280px' });
  const rings = [
    { d: d.partKeep, label: 'Part keep-out', attrs: { fill: 'var(--warn)', 'fill-opacity': 0.10, stroke: 'var(--warn)', 'stroke-dasharray': '5 3' } },
    { d: d.cuKeep, label: 'Copper keep-out', attrs: { fill: 'var(--surface)', stroke: 'var(--danger)', 'stroke-dasharray': '3 3' } },
    d.pad ? { d: d.pad, label: 'Pad (plated)', attrs: { fill: 'var(--tool-s1)', 'fill-opacity': 0.55, stroke: 'var(--tool-s1)' } } : null,
    d.metal > 0 ? { d: d.metal, label: 'Head / washer / standoff', attrs: { fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 1.5 } } : null,
    { d: d.drill, label: 'Drill', attrs: { fill: 'var(--sunken)', stroke: 'var(--ink)', 'stroke-width': 1.5 } },
  ].filter(Boolean);
  for (const r of rings) svg.append(s('circle', { cx, cy, r: (r.d / 2) * k, ...r.attrs }));
  svg.append(s('line', { x1: cx - 6, x2: cx + 6, y1: cy, y2: cy, stroke: 'var(--ink)' }));
  svg.append(s('line', { x1: cx, x2: cx, y1: cy - 6, y2: cy + 6, stroke: 'var(--ink)' }));
  const txt = { 'font-size': 12, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' };
  rings.forEach((r, i) => {
    const y = 40 + i * 38;
    svg.append(s('line', { x1: cx + (r.d / 2) * k * Math.cos(-0.6 + i * 0.3), y1: cy + (r.d / 2) * k * Math.sin(-0.6 + i * 0.3), x2: 320, y2: y - 4, stroke: 'var(--line)' }));
    svg.append(s('text', { ...txt, x: 326, y, fill: 'var(--ink)' }, `${r.label}`));
    svg.append(s('text', { ...txt, x: 326, y: y + 15, fill: 'var(--ink-soft)' }, `Ø ${f(r.d)} mm`));
  });
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Top view, to scale';
  wrap.append(title, svg);
  el.append(wrap);
}
