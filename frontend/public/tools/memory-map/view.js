// One strip per memory region, drawn to scale: each section a coloured block
// at its offset (load copies hatched), the rest free. From result.regions.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const COLS = ['var(--tool-s0)', 'var(--tool-s1)', 'var(--tool-s2)', 'var(--tool-s3)'];
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MiB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KiB` : `${b} B`);

export function view(el, result) {
  el.replaceChildren();
  const regs = result?.regions || [];
  if (!regs.length) return;
  const W = Math.max(280, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22);
  const RH = 92, SH = 26;
  const H = regs.length * RH;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'memory regions drawn to scale', style: 'display:block' });
  const defs = s('defs');
  const pat = s('pattern', { id: 'mm-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.append(s('rect', { width: 6, height: 6, fill: 'var(--sunken)' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--ink-soft)', 'stroke-width': 3 }));
  defs.append(pat); svg.append(defs);
  const bw = W - 4;
  regs.forEach((r, ri) => {
    const y = ri * RH + 18;
    const over = r.used > r.length;
    svg.append(s('text', { x: 2, y: y - 6, fill: 'var(--ink)', 'font-size': 12, 'font-weight': 600 }, r.name));
    svg.append(s('text', { x: W - 2, y: y - 6, 'text-anchor': 'end', fill: over ? 'var(--danger)' : r.pct > 90 ? 'var(--warn)' : 'var(--ink-soft)', 'font-size': 11 },
      `${kb(r.used)} / ${kb(r.length)} · ${r.pct.toFixed(1)} %`));
    svg.append(s('rect', { x: 2, y, width: bw, height: SH, rx: 3, fill: 'var(--sunken)', stroke: over ? 'var(--danger)' : 'var(--line)' }));
    // scale: the region, or the used span if it overflows (so the overflow still shows)
    const span = Math.max(r.length, ...r.parts.map((p) => p.offset + p.size));
    const X = (o) => 2 + (o / span) * bw;
    let ci = 0;
    const labelled = [];
    for (const p of r.parts) {
      const x = X(p.offset), w = Math.max(1, X(p.offset + p.size) - x);
      const col = COLS[ci++ % 4];
      const rect = s('rect', { x, y, width: w, height: SH, fill: p.copy ? 'url(#mm-hatch)' : col, stroke: 'var(--surface)', 'stroke-width': 0.5 });
      rect.append(s('title', {}, `${p.name}: ${kb(p.size)} at +0x${p.offset.toString(16).toUpperCase()}`));
      svg.append(rect);
      if (w > 44) svg.append(s('text', { x: x + 4, y: y + 17, fill: p.copy ? 'var(--ink)' : 'var(--surface)', 'font-size': 10.5, 'pointer-events': 'none' }, p.name.replace(' (load copy)', ' copy').slice(0, Math.floor(w / 6.5))));
      else labelled.push(p);
    }
    if (over) svg.append(s('line', { x1: X(r.length), x2: X(r.length), y1: y - 3, y2: y + SH + 3, stroke: 'var(--danger)', 'stroke-width': 2 }));
    // address scale
    svg.append(s('text', { x: 2, y: y + SH + 13, fill: 'var(--ink-soft)', 'font-size': 10, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' }, '0x' + r.origin.toString(16).toUpperCase()));
    svg.append(s('text', { x: W - 2, y: y + SH + 13, 'text-anchor': 'end', fill: 'var(--ink-soft)', 'font-size': 10, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' }, '0x' + (r.origin + r.length).toString(16).toUpperCase()));
    if (labelled.length) {
      const small = labelled.map((p) => p.name.replace(' (load copy)', ' copy')).join(', ');
      svg.append(s('text', { x: 2, y: y + SH + 27, fill: 'var(--ink-soft)', 'font-size': 10 }, `small: ${small.length > W / 5.5 ? small.slice(0, Math.floor(W / 5.5)) + '…' : small}`));
    }
  });
  const block = document.createElement('div');
  block.className = 'k-block';
  const t = document.createElement('div'); t.className = 'k-title'; t.textContent = 'Regions to scale (hatched = load copy of initialised data)';
  block.append(t, svg);
  el.append(block);
}
