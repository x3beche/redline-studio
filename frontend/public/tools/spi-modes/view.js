// Timing diagram of one SPI byte per mode: CS, SCK, MOSI and MISO, with the
// sample edges marked. Built from result.drawing so the numbers stay in run().
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

function diagram(m, d, api, width) {
  const W = width, L = 44, R = 10, rowH = 30, gap = 12, top = 38;
  const P = (W - L - R - 24) / 8.5;       // one clock period
  const x0 = L + 12;                       // CS falls
  const rows = ['CS', 'SCK', 'MOSI', 'MISO'];
  const H = top + rows.length * (rowH + gap) + 6;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', style: 'display:block;max-height:260px',
    'aria-label': `SPI mode ${m.n} timing: CPOL ${m.cpol}, CPHA ${m.cpha}` });
  const txt = { 'font-size': 11, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' };
  const yOf = (r) => top + r * (rowH + gap);
  const hi = (r) => yOf(r) + 4, lo = (r) => yOf(r) + rowH - 4;
  const end = x0 + 8 * P + P / 2;          // CS rises
  rows.forEach((name, r) => svg.append(s('text', { ...txt, x: 6, y: yOf(r) + rowH / 2 + 4, fill: 'var(--ink-soft)' }, name)));
  svg.append(s('text', { ...txt, x: 6, y: 13, fill: 'var(--ink)' }, `Mode ${m.n}  CPOL=${m.cpol} CPHA=${m.cpha}  sample on ${m.sample} edge`));
  svg.append(s('text', { ...txt, x: 6, y: 28, fill: 'var(--ink-soft)' }, `MOSI ${d.mosiHex}  MISO ${d.misoHex}  ${d.order}`));

  // sample edges (dashed) behind the traces
  for (let i = 0; i < 8; i++) {
    const xs = x0 + P / 2 + i * P + (m.cpha ? P / 2 : 0);
    svg.append(s('line', { x1: xs, x2: xs, y1: yOf(1), y2: yOf(3) + rowH, stroke: 'var(--accent)', 'stroke-dasharray': '3 3', 'stroke-width': 1, opacity: 0.7 }));
  }
  const line = (pts) => s('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(''), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.6 });
  // CS: high, low from x0 to end, high
  svg.append(line([[L, hi(0)], [x0, hi(0)], [x0, lo(0)], [end, lo(0)], [end, hi(0)], [W - R, hi(0)]]));
  // SCK
  const idle = m.cpol ? hi(1) : lo(1), act = m.cpol ? lo(1) : hi(1);
  const ck = [[L, idle]];
  for (let i = 0; i < 8; i++) {
    const a = x0 + P / 2 + i * P, b = a + P / 2;
    ck.push([a, idle], [a, act], [b, act], [b, idle]);
  }
  ck.push([W - R, idle]);
  svg.append(line(ck));
  // sample dots on SCK
  for (let i = 0; i < 8; i++) {
    const xs = x0 + P / 2 + i * P + (m.cpha ? P / 2 : 0);
    svg.append(s('circle', { cx: xs, cy: (hi(1) + lo(1)) / 2, r: 3, fill: 'var(--accent)' }));
  }
  // data buses: bit i valid from its shift point for one period
  const bus = (r, bits, key, val) => {
    const start = m.cpha ? x0 + P / 2 : x0;
    const yh = hi(r), yl = lo(r), ym = (yh + yl) / 2, k = 4;
    svg.append(s('path', { d: `M${L},${ym}L${start},${ym}M${start + 8 * P},${ym}L${W - R},${ym}`, stroke: 'var(--ink-soft)', 'stroke-dasharray': '2 3', fill: 'none' }));
    for (let i = 0; i < 8; i++) {
      const a = start + i * P, b = a + P;
      const cell = s('path', { d: `M${a},${ym}L${a + k},${yh}L${b - k},${yh}L${b},${ym}L${b - k},${yl}L${a + k},${yl}Z`,
        fill: bits[i] ? 'var(--tool-s1)' : 'var(--sunken)', 'fill-opacity': bits[i] ? 0.25 : 1, stroke: 'var(--ink)', 'stroke-width': 1.2 });
      // Click a bit to flip it: the byte input changes and everything re-runs.
      if (api && api.set) {
        const pos = d.lsb ? i : 7 - i;
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', () => api.set(key, '0x' + (val ^ (1 << pos)).toString(16).toUpperCase().padStart(2, '0')));
        cell.append(s('title', {}, `${key.toUpperCase()} bit ${pos}: click to flip`));
      }
      svg.append(cell);
      svg.append(s('text', { ...txt, x: (a + b) / 2, y: ym + 4, 'text-anchor': 'middle', fill: 'var(--ink)', 'pointer-events': 'none' }, bits[i]));
    }
  };
  bus(2, d.mosi, 'mosi', d.mosiVal);
  bus(3, d.miso, 'miso', d.misoVal);
  return svg;
}

export function view(el, result, input, api) {
  el.replaceChildren();
  const d = result && result.drawing;
  if (!d || !d.modes?.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Timing: one byte (dots and dashed lines = sample edges; click a bit to flip it)';
  wrap.append(title);
  const width = Math.max(300, Math.min(640, (el.parentElement?.clientWidth || 640) - 22));
  for (const m of d.modes) wrap.append(diagram(m, d, api, width));
  el.append(wrap);
}
