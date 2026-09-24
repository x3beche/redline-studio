// Flash map: one bar from 0 to the end of the flash, a block per region
// (bootloader, table, data, app slots, filesystem), free space dashed,
// and a legend with offsets underneath.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

const COL = { boot: 'var(--ink-soft)', data: 'var(--tool-s1)', app: 'var(--tool-s0)', fs: 'var(--tool-s2)' };

export function view(el, result) {
  el.replaceChildren();
  const M = result && result.map;
  if (!M || !M.parts) return;
  const F = Math.max(M.flash, ...M.parts.map((p) => p.offset + p.size));
  const VW = 600, pad = 10, barY = 18, barH = 34;
  const X = (v) => pad + (v / F) * (VW - 2 * pad);
  const mono = 'IBM Plex Mono, ui-monospace, monospace';
  const legendRows = Math.ceil(M.parts.length / 2);
  const VH = barY + barH + 30 + legendRows * 18 + 6;
  const svg = s('svg', { viewBox: `0 0 ${VW} ${VH}`, width: '100%', role: 'img', 'aria-label': 'Flash map', style: 'display:block;max-width:760px' });

  // free space
  svg.append(s('rect', { x: X(0), y: barY, width: X(M.flash) - X(0), height: barH, fill: 'var(--sunken)', stroke: 'var(--line)', 'stroke-dasharray': '4 3' }));
  if (F > M.flash) svg.append(s('rect', { x: X(M.flash), y: barY, width: X(F) - X(M.flash), height: barH, fill: 'var(--danger)', 'fill-opacity': 0.15, stroke: 'var(--danger)' }));
  for (const p of M.parts) {
    const w = Math.max(1.5, X(p.offset + p.size) - X(p.offset));
    const r = s('rect', { x: X(p.offset), y: barY, width: w, height: barH, fill: COL[p.kind], 'fill-opacity': 0.35, stroke: COL[p.kind] });
    r.append(s('title', {}, `${p.name}: 0x${p.offset.toString(16)}, ${p.size / 1024} KiB`));
    svg.append(r);
    if (w > 44) svg.append(s('text', { x: X(p.offset) + w / 2, y: barY + barH / 2 + 4, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink)' }, p.name.length * 6.2 < w - 4 ? p.name : p.name.slice(0, Math.max(1, Math.floor((w - 8) / 6.2))) + '…'));
  }
  // MiB ticks
  const MiB = 1024 * 1024;
  const step = F / MiB > 8 ? 4 * MiB : F / MiB > 2 ? MiB : MiB / 2;
  for (let v = 0; v <= F + 1; v += step) {
    svg.append(s('line', { x1: X(v), x2: X(v), y1: barY + barH, y2: barY + barH + 4, stroke: 'var(--ink-soft)' }));
    svg.append(s('text', { x: X(v), y: barY + barH + 15, 'text-anchor': v === 0 ? 'start' : v >= F ? 'end' : 'middle', 'font-size': 10, 'font-family': mono, fill: 'var(--ink-soft)' }, `${v / MiB} MB`));
  }
  // legend, two columns
  M.parts.forEach((p, i) => {
    const col = i < legendRows ? 0 : 1, row = i % legendRows;
    const x = pad + col * (VW / 2), y = barY + barH + 34 + row * 18;
    svg.append(s('rect', { x, y: y - 9, width: 10, height: 10, rx: 2, fill: COL[p.kind], 'fill-opacity': 0.6 }));
    const size = p.size >= 1024 * 1024 ? `${+(p.size / MiB).toFixed(3)} MiB` : `${+(p.size / 1024).toFixed(1)} KiB`;
    svg.append(s('text', { x: x + 15, y, 'font-size': 11, 'font-family': mono, fill: 'var(--ink)' }, `${p.name.padEnd(15).slice(0, 15)} 0x${p.offset.toString(16).padStart(6, '0')} ${size}`));
  });
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = `Flash map, ${M.flash / MiB} MB (dashed: unused)`;
  wrap.append(title, svg);
  el.append(wrap);
}
