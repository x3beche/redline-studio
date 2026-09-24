// Cross-section of the stack: one bar per copper layer, coloured by role, with
// its reference plane on the right.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

const FILL = { S: 'var(--tool-s1)', SP: 'var(--tool-s1)', G: 'var(--tool-s2)', M: 'var(--tool-s2)', P: 'var(--danger)' };

export function view(el, result) {
  el.replaceChildren();
  const st = result && result.stack;
  if (!st || !st.length) return;
  const row = 26, gap = 10, W = 600, top = 8;
  const H = top * 2 + st.length * row + (st.length - 1) * gap;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Layer stack cross-section', style: 'display:block' });
  const txt = { 'font-size': 13, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' };
  st.forEach((l, i) => {
    const y = top + i * (row + gap);
    if (i) svg.append(s('rect', { x: 60, y: y - gap, width: 300, height: gap, fill: 'var(--sunken)' }));
    const plane = l.role === 'G' || l.role === 'P' || l.role === 'M';
    svg.append(s('rect', { x: 60, y, width: 300, height: row, rx: 2, fill: FILL[l.role], 'fill-opacity': plane ? 0.85 : 0.35, stroke: FILL[l.role] }));
    if (!plane) for (let k = 0; k < 6; k++) svg.append(s('rect', { x: 78 + k * 46, y: y + row / 2 - 3, width: 26, height: 6, rx: 1, fill: FILL[l.role] }));
    svg.append(s('text', { ...txt, x: 50, y: y + row / 2 + 4, 'text-anchor': 'end', fill: 'var(--ink)' }, `L${l.layer}`));
    svg.append(s('text', { ...txt, x: 372, y: y + row / 2 - 2, fill: 'var(--ink)' }, l.name));
    if (l.role === 'S' || l.role === 'SP') svg.append(s('text', { ...txt, 'font-size': 11, x: 372, y: y + row / 2 + 11, fill: 'var(--ink-soft)' }, `ref: ${l.ref}`));
  });
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Cross-section (not to scale)';
  wrap.append(title, svg);
  el.append(wrap);
}
