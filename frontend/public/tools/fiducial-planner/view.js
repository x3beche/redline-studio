// Top view of the board (or panel) with its fiducials, their clear areas and
// the tooling holes. Y up, as in the coordinate table.
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
  const pad = 26;
  const VW = 600;
  const k = Math.min((VW - 2 * pad) / d.W, 300 / d.H);
  const VH = d.H * k + 2 * pad;
  const X = (x) => pad + x * k + (VW - 2 * pad - d.W * k) / 2;
  const Y = (y) => pad + (d.H - y) * k;
  const f = (v) => api.fmtNum(v, 3);

  const svg = s('svg', { viewBox: `0 0 ${VW} ${VH}`, width: '100%', role: 'img',
    'aria-label': 'Board with fiducials and tooling holes', style: 'display:block;max-height:380px' });
  const txt = { fill: 'var(--ink-soft)', 'font-size': 11, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' };

  // panel (rails) behind the board
  if (d.rails) {
    svg.append(s('rect', { x: X(0), y: Y(d.H), width: d.W * k, height: d.H * k, fill: 'var(--sunken)', stroke: 'var(--line)' }));
  }
  const b = d.board;
  svg.append(s('rect', { x: X(b.x), y: Y(b.y + b.h), width: b.w * k, height: b.h * k,
    fill: 'var(--surface)', stroke: 'var(--ink-soft)', 'stroke-width': 1.5 }));
  if (d.rails) {
    svg.append(s('line', { x1: X(0), x2: X(d.W), y1: Y(b.y), y2: Y(b.y), stroke: 'var(--ink-soft)', 'stroke-dasharray': '6 4' }));
    svg.append(s('line', { x1: X(0), x2: X(d.W), y1: Y(b.y + b.h), y2: Y(b.y + b.h), stroke: 'var(--ink-soft)', 'stroke-dasharray': '6 4' }));
    svg.append(s('text', { ...txt, x: X(d.W / 2), y: Y(d.H - d.rails / 2) + 4, 'text-anchor': 'middle' }, 'rail'));
  } else {
    // the conveyor band along the long edges
    const band = 3 * k;
    for (const y of [0, d.H - 3]) svg.append(s('rect', { x: X(0), y: Y(y + 3), width: d.W * k, height: band, fill: 'var(--warn)', opacity: 0.12 }));
  }

  for (const m of d.holes) {
    svg.append(s('circle', { cx: X(m.x), cy: Y(m.y), r: (m.keep / 2) * k, fill: 'none', stroke: 'var(--line)', 'stroke-dasharray': '3 3' }));
    svg.append(s('circle', { cx: X(m.x), cy: Y(m.y), r: (m.d / 2) * k, fill: 'var(--sunken)', stroke: 'var(--ink)', 'stroke-width': 1.5 }));
    // label outside the board edge nearest to it, clear of the fiducials
    const low = m.y < d.H / 2;
    svg.append(s('text', { ...txt, x: X(m.x), y: low ? Y(0) + 13 : Y(d.H) - 5, 'text-anchor': 'middle' }, m.ref));
  }
  for (const m of d.fids) {
    svg.append(s('circle', { cx: X(m.x), cy: Y(m.y), r: (m.keep / 2) * k, fill: 'var(--accent)', 'fill-opacity': 0.12, stroke: 'var(--accent)', 'stroke-dasharray': '3 2' }));
    svg.append(s('circle', { cx: X(m.x), cy: Y(m.y), r: Math.max(1.5, (m.d / 2) * k), fill: 'var(--accent)' }));
    // label beside the mark, towards the middle of the board, above or below it
    const left = m.x < d.W / 2, low = m.y < d.H / 2;
    svg.append(s('text', { ...txt, fill: 'var(--ink)', x: X(m.x) + (left ? -4 : 4), y: Y(m.y) + (low ? -1 : 1) * ((m.keep / 2) * k + 5) + (low ? 0 : 8), 'text-anchor': left ? 'start' : 'end' },
      `${m.ref} (${f(m.x)}, ${f(m.y)})`));
  }
  // overall size
  svg.append(s('text', { ...txt, x: X(d.W / 2), y: VH - 6, 'text-anchor': 'middle' }, `${f(d.W)} mm`));
  const vt = s('text', { ...txt, x: 12, y: (Y(0) + Y(d.H)) / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${(Y(0) + Y(d.H)) / 2})` }, `${f(d.H)} mm`);
  svg.append(vt);

  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = d.rails ? 'Panel, top view (rails dashed off)' : 'Board, top view (shaded: conveyor edge)';
  wrap.append(title, svg);
  el.append(wrap);
}
