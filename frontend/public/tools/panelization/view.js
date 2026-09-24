// The panel drawn to scale: rails, the board grid, and the separation lines
// (dashed V-score lines, or dotted mouse-bite tabs).
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

export function view(el, result, input, api) {
  el.replaceChildren();
  const L = result && result.layout;
  if (!L || !(L.pw > 0 && L.ph > 0)) return;
  const fmt = api && api.fmtNum ? api.fmtNum : (v) => String(v);
  const pad = 26;
  const W = Math.max(300, Math.min(1000, el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 560));
  const k = (W - 2 * pad) / L.pw;
  const H = Math.min(520, L.ph * k + 2 * pad);
  const sc = Math.min(k, (H - 2 * pad) / L.ph);
  const ox = (W - L.pw * sc) / 2, oy = pad;
  const svg = s('svg', { viewBox: `0 0 ${W} ${L.ph * sc + 2 * pad + (W < 520 ? 12 : 0)}`, width: '100%', role: 'img',
    'aria-label': `Panel ${L.pw} by ${L.ph} mm with ${L.cols * L.rows} boards`, style: 'display:block;max-height:560px' });
  const X = (x) => ox + x * sc, Y = (y) => oy + y * sc;
  // panel and rails
  svg.append(s('rect', { x: X(0), y: Y(0), width: L.pw * sc, height: L.ph * sc, fill: 'var(--sunken)', stroke: 'var(--line)' }));
  const railStyle = { fill: 'var(--line-soft)', stroke: 'none' };
  if (L.ry > 0) {
    svg.append(s('rect', { x: X(0), y: Y(0), width: L.pw * sc, height: L.ry * sc, ...railStyle }));
    svg.append(s('rect', { x: X(0), y: Y(L.ph - L.ry), width: L.pw * sc, height: L.ry * sc, ...railStyle }));
  }
  if (L.rx > 0) {
    svg.append(s('rect', { x: X(0), y: Y(0), width: L.rx * sc, height: L.ph * sc, ...railStyle }));
    svg.append(s('rect', { x: X(L.pw - L.rx), y: Y(0), width: L.rx * sc, height: L.ph * sc, ...railStyle }));
  }
  // tooling holes in the rails' corners
  if (L.ry > 0 && L.ry * sc > 5) {
    for (const [x, y] of [[L.ry, L.ry / 2], [L.pw - L.ry, L.ry / 2], [L.ry, L.ph - L.ry / 2], [L.pw - L.ry, L.ph - L.ry / 2]]) {
      svg.append(s('circle', { cx: X(x), cy: Y(y), r: Math.max(1.5, Math.min(L.ry * 0.3, 1.5) * sc), fill: 'var(--surface)', stroke: 'var(--ink-soft)' }));
    }
  }
  // boards
  for (let c = 0; c < L.cols; c++) {
    for (let r = 0; r < L.rows; r++) {
      const x = L.rx + c * (L.bw + L.gap), y = L.ry + r * (L.bh + L.gap);
      svg.append(s('rect', { x: X(x), y: Y(y), width: L.bw * sc, height: L.bh * sc, fill: 'var(--tool-s2)', 'fill-opacity': 0.28,
        stroke: 'var(--tool-s2)', 'stroke-width': 1 }));
    }
  }
  const aw = L.cols * L.bw + Math.max(0, L.cols - 1) * L.gap, ah = L.rows * L.bh + Math.max(0, L.rows - 1) * L.gap;
  if (L.cols && L.rows) {
    if (L.method === 'vscore') {
      // score lines run edge to edge across the whole panel
      const dash = { stroke: 'var(--accent)', 'stroke-width': 1.2, 'stroke-dasharray': '5 3' };
      for (let c = 0; c <= L.cols; c++) {
        const x = L.rx + c * (L.bw + L.gap) - (c === L.cols ? L.gap : 0);
        svg.append(s('line', { x1: X(x), x2: X(x), y1: Y(0), y2: Y(L.ph), ...dash }));
      }
      for (let r = 0; r <= L.rows; r++) {
        const y = L.ry + r * (L.bh + L.gap) - (r === L.rows ? L.gap : 0);
        svg.append(s('line', { x1: X(0), x2: X(L.pw), y1: Y(y), y2: Y(y), ...dash }));
      }
    } else {
      // mouse-bite tabs: small dotted bridges in the middle of each shared edge
      const dot = (x, y) => svg.append(s('circle', { cx: X(x), cy: Y(y), r: Math.max(1.2, 0.35 * sc), fill: 'var(--accent)' }));
      const g = Math.max(L.gap, 0.5);
      for (let c = 0; c < L.cols; c++) {
        for (let r = 0; r <= L.rows; r++) {
          const x = L.rx + c * (L.bw + L.gap) + L.bw / 2;
          const y = r === 0 ? L.ry - g / 2 : r === L.rows ? L.ry + ah + g / 2 : L.ry + r * (L.bh + L.gap) - L.gap / 2;
          if ((r === 0 || r === L.rows) && L.ry <= 0) continue;
          for (let i = -2; i <= 2; i++) dot(x + i * 0.8, y);
        }
      }
      for (let r = 0; r < L.rows; r++) {
        for (let c = 1; c < L.cols; c++) {
          const x = L.rx + c * (L.bw + L.gap) - L.gap / 2, y = L.ry + r * (L.bh + L.gap) + L.bh / 2;
          for (let i = -2; i <= 2; i++) dot(x, y + i * 0.8);
        }
      }
    }
  }
  // dimensions
  const t = (x, y, text, anchor = 'middle') => svg.append(s('text', { x, y, 'text-anchor': anchor, fill: 'var(--ink-soft)',
    style: 'font: 11px ui-monospace, monospace' }, text));
  t(X(L.pw / 2), Y(0) - 8, `${fmt(L.pw)} mm`);
  t(X(L.pw) + 4, Y(L.ph / 2), `${fmt(L.ph)}`, 'start');
  if (L.cols && L.rows && L.bw * sc > 40 && L.bh * sc > 16) {
    t(X(L.rx + L.bw / 2), Y(L.ry + L.bh / 2) + 4, `${fmt(L.bw)} × ${fmt(L.bh)}`);
  }
  const key = L.method === 'vscore' ? 'dashed: V-score' : 'dots: mouse-bite tabs';
  const cap = `${L.cols} × ${L.rows} = ${L.cols * L.rows} boards · array ${fmt(aw + 2 * L.rx)} × ${fmt(ah + 2 * L.ry)} mm`;
  if (W < 520) { t(8, Y(L.ph) + 16, cap, 'start'); t(8, Y(L.ph) + 30, key, 'start'); } else t(X(0), Y(L.ph) + 16, `${cap} · ${key}`, 'start');
  el.append(svg);
}
