// The bit pattern as boxes: sign, exponent and fraction in their own colours,
// 32 bits to a row (two rows for a double), bit numbers above.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

export function view(el, result) {
  el.replaceChildren();
  const b = result && result.bits;
  if (!b) return;
  const all = b.sign + b.exp + b.frac;
  const W = b.W;
  const narrow = (el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 600) < 520; // phones: 16 bits a row so the digits stay readable
  const perRow = Math.min(W, narrow ? 16 : 32);
  const rows = Math.ceil(W / perRow);
  const VW = 640, pad = 8, cell = (VW - 2 * pad) / perRow, ch = 26, rowH = ch + 22;
  const VH = rows * rowH + 40;
  const svg = s('svg', { viewBox: `0 0 ${VW} ${VH}`, width: '100%', role: 'img',
    'aria-label': `Bit pattern ${b.hex}: sign, exponent, fraction`, style: `display:block;max-width:760px;max-height:${narrow ? 420 : 220}px` });
  const mono = 'IBM Plex Mono, ui-monospace, monospace';
  const colour = (i) => (i === 0 ? 'var(--tool-s3)' : i <= b.E ? 'var(--tool-s1)' : 'var(--tool-s0)');
  for (let i = 0; i < W; i++) {
    const r = Math.floor(i / perRow), c = i % perRow;
    const x = pad + c * cell, y = 16 + r * rowH;
    const on = all[i] === '1';
    svg.append(s('rect', { x: x + 0.5, y, width: cell - 1, height: ch, rx: 2,
      fill: colour(i), 'fill-opacity': on ? 0.85 : 0.12, stroke: colour(i), 'stroke-opacity': 0.6 }));
    svg.append(s('text', { x: x + cell / 2, y: y + ch / 2 + 4, 'text-anchor': 'middle', 'font-size': 12, 'font-family': mono,
      fill: on ? 'var(--surface)' : 'var(--ink-soft)' }, all[i]));
    const bitNo = W - 1 - i;
    if (bitNo % 4 === 3 || i === 0) {
      svg.append(s('text', { x: x + cell / 2, y: y - 4, 'text-anchor': 'middle', 'font-size': 9, 'font-family': mono, fill: 'var(--ink-soft)' }, String(bitNo)));
    }
  }
  // legend
  const ly = rows * rowH + 24;
  const exp = b.exponent == null ? b.cls : `2^${b.exponent}`;
  const items = [['sign', 'var(--tool-s3)'], [`exponent ${b.E} bits (${exp})`, 'var(--tool-s1)'], [`fraction ${b.M} bits`, 'var(--tool-s0)']];
  let lx = pad;
  for (const [t, c] of items) {
    svg.append(s('rect', { x: lx, y: ly - 10, width: 12, height: 12, rx: 2, fill: c, 'fill-opacity': 0.85 }));
    const tx = s('text', { x: lx + 17, y: ly, 'font-size': 12, fill: 'var(--ink)' }, t);
    svg.append(tx);
    lx += 17 + t.length * 6.6 + 18;
  }
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = `Bits of ${b.hex} (bit ${W - 1} first)`;
  wrap.append(title, svg);
  el.append(wrap);
}
