// Byte map of the struct: one row per machine word, members in colour,
// padding hatched. Long arrays that fill many whole rows are folded.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

export function view(el, result) {
  el.replaceChildren();
  const L = result && result.layout;
  if (!L || !L.size) return;
  const R = L.rowBytes || 4;
  const nRows = Math.ceil(L.size / R);
  // pieces per row
  const rows = [];
  for (let r = 0; r < nRows; r++) {
    const a = r * R, b = Math.min(L.size, a + R);
    const pieces = [];
    for (const c of L.cells) {
      const s0 = Math.max(a, c.start), e0 = Math.min(b, c.start + c.len);
      if (e0 > s0) pieces.push({ c, s: s0 - a, e: e0 - a, first: s0 === c.start });
    }
    rows.push({ r, pieces });
  }
  // fold runs of whole rows owned by one member
  const shown = [];
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k];
    const whole = row.pieces.length === 1 && row.pieces[0].s === 0 && row.pieces[0].e === R ? row.pieces[0].c : null;
    let j = k;
    if (whole) while (j + 1 < rows.length && rows[j + 1].pieces.length === 1 && rows[j + 1].pieces[0].c === whole && rows[j + 1].pieces[0].e === R) j++;
    if (whole && j - k >= 3) {
      shown.push(row, { fold: true, bytes: (j - k - 1) * R, label: whole.label }, rows[j]);
      k = j;
    } else shown.push(row);
  }

  const VW = 600, lw = 52, top = 18, rh = 26;
  const cw = (VW - lw - 4) / R;
  const VH = top + shown.length * rh + 6;
  const svg = s('svg', { viewBox: `0 0 ${VW} ${VH}`, width: '100%', role: 'img', 'aria-label': `Byte map of ${L.title}`, style: 'display:block;max-width:720px' });
  const mono = 'IBM Plex Mono, ui-monospace, monospace';
  const defs = s('defs');
  const pat = s('pattern', { id: 'sp-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--danger)', 'stroke-width': 2, 'stroke-opacity': 0.45 }));
  defs.append(pat);
  svg.append(defs);
  for (let b = 0; b < R; b++) svg.append(s('text', { x: lw + b * cw + cw / 2, y: 12, 'text-anchor': 'middle', 'font-size': 10, 'font-family': mono, fill: 'var(--ink-soft)' }, `+${b}`));
  const colour = (c) => (c.kind === 'pad' ? 'var(--danger)' : `var(--tool-s${c.idx % 4})`);
  shown.forEach((row, n) => {
    const y = top + n * rh;
    if (row.fold) {
      svg.append(s('text', { x: lw + (VW - lw) / 2, y: y + rh / 2 + 4, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink-soft)' }, `⋮ ${row.label}: ${row.bytes} more bytes`));
      return;
    }
    svg.append(s('text', { x: lw - 6, y: y + rh / 2 + 4, 'text-anchor': 'end', 'font-size': 10, 'font-family': mono, fill: 'var(--ink-soft)' }, String(row.r * R)));
    for (const p of row.pieces) {
      const x = lw + p.s * cw, w = (p.e - p.s) * cw;
      const pad = p.c.kind === 'pad';
      svg.append(s('rect', { x: x + 1, y: y + 1, width: Math.max(1, w - 2), height: rh - 3, rx: 3,
        fill: pad ? 'url(#sp-hatch)' : colour(p.c), 'fill-opacity': pad ? 1 : 0.22, stroke: colour(p.c), 'stroke-opacity': pad ? 0.5 : 0.9 }));
      // byte ticks inside multi-byte pieces
      for (let b = p.s + 1; b < p.e; b++) svg.append(s('line', { x1: lw + b * cw, x2: lw + b * cw, y1: y + rh - 7, y2: y + rh - 2, stroke: colour(p.c), 'stroke-opacity': 0.5 }));
      const label = pad ? (w > 30 ? 'pad' : '') : p.first ? p.c.label : '…';
      const max = Math.floor((w - 6) / 6.4);
      if (label && max >= 1) {
        const t = label.length > max ? label.slice(0, Math.max(1, max - 1)) + '…' : label;
        svg.append(s('text', { x: x + w / 2, y: y + rh / 2 + 3, 'text-anchor': 'middle', 'font-size': 11, 'font-family': mono, fill: pad ? 'var(--danger)' : 'var(--ink)' }, t));
      }
    }
  });
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = `${L.title}: ${L.size} bytes, ${L.padding} padding (hatched), ${R} bytes per row`;
  wrap.append(title, svg);
  el.append(wrap);
}
