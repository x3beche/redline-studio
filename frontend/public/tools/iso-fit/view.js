// Tolerance zones of hole and shaft against the zero line (nominal size), in µm.
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
  if (!d) return;
  const W = 600, H = 260, T = 24, B = 24, zx = 70;
  const lo = Math.min(0, d.hole[0], d.shaft[0]), hi = Math.max(0, d.hole[1], d.shaft[1]);
  const pad = (hi - lo) * 0.12 || 5;
  const a = lo - pad, b = hi + pad;
  const Y = (v) => T + (H - T - B) * (1 - (v - a) / (b - a));
  const txt = { 'font-size': 12, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Tolerance zones of hole and shaft', style: 'display:block;max-height:300px' });
  // grid and axis
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((x) => (b - a) / x <= 8) || 500;
  for (let v = Math.ceil(a / step) * step; v <= b; v += step) {
    svg.append(s('line', { x1: zx, x2: W - 10, y1: Y(v), y2: Y(v), stroke: 'var(--line-soft)' }));
    svg.append(s('text', { ...txt, x: zx - 6, y: Y(v) + 4, 'text-anchor': 'end', fill: 'var(--ink-soft)' }, v > 0 ? `+${v}` : `${v}`));
  }
  svg.append(s('text', { ...txt, x: 6, y: 14, fill: 'var(--ink-soft)' }, 'µm'));
  const zone = (x, w, [l, h], cls, name) => {
    svg.append(s('rect', { x, y: Y(h), width: w, height: Math.max(2, Y(l) - Y(h)), rx: 3, fill: `var(${cls})`, 'fill-opacity': 0.35, stroke: `var(${cls})`, 'stroke-width': 1.5 }));
    svg.append(s('text', { ...txt, x: x + w / 2, y: Y(h) - 6, 'text-anchor': 'middle', fill: 'var(--ink)' }, name));
    svg.append(s('text', { ...txt, x: x + w + 6, y: Y(h) + 4, fill: 'var(--ink-soft)' }, h > 0 ? `+${h}` : `${h}`));
    svg.append(s('text', { ...txt, x: x + w + 6, y: Y(l) + 4, fill: 'var(--ink-soft)' }, l > 0 ? `+${l}` : `${l}`));
  };
  zone(150, 110, d.hole, '--tool-s0', `hole ${d.holeName}`);
  zone(360, 110, d.shaft, '--tool-s1', `shaft ${d.shaftName}`);
  svg.append(s('line', { x1: zx, x2: W - 10, y1: Y(0), y2: Y(0), stroke: 'var(--ink)', 'stroke-width': 1.5 }));
  svg.append(s('text', { ...txt, x: W - 12, y: Y(0) - 5, 'text-anchor': 'end', fill: 'var(--ink)' }, `Ø${api.fmtNum(d.size, 5)} (zero line)`));
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = `Tolerance zones: ${d.type} fit`;
  wrap.append(title, svg);
  el.append(wrap);
}
