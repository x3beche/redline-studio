// The register as a row of bit cells (MSB left), fields as brackets under
// them with their value. Clicking a bit writes the flipped value into the
// Value field (and clears Flip bits), so the whole tool recomputes.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const COLS = ['var(--tool-s0)', 'var(--tool-s1)', 'var(--tool-s2)', 'var(--tool-s3)'];

function setField(id, v) {
  const f = document.getElementById(id);
  if (!f) return;
  f.value = v;
  f.dispatchEvent(new Event('input', { bubbles: true }));
}

export function view(el, result) {
  el.replaceChildren();
  const bits = result?.bits;
  if (!bits?.length) return;
  const width = result.width;
  const W = Math.max(280, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22);
  const perRow = width <= 8 ? 8 : W >= 16 * 34 + 10 ? (width === 32 && W >= 32 * 26 + 10 ? 32 : 16) : 8;
  const cw = Math.min(56, Math.floor((W - 4) / perRow));
  const rowsN = Math.ceil(width / perRow);
  const RH = 92;
  const H = rowsN * RH;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `register bits, ${result.hexValue}`, style: 'display:block' });
  const fields = result.fields || [];
  const colorOf = new Map(fields.map((f, i) => [f.name, COLS[i % 4]]));
  for (let r = 0; r < rowsN; r++) {
    const hi = width - 1 - r * perRow, lo = Math.max(0, hi - perRow + 1);
    const y = r * RH + 14;
    for (let b = hi; b >= lo; b--) {
      const x = 2 + (hi - b) * cw;
      const bit = bits[b];
      const g = s('g', { style: 'cursor:pointer', tabindex: 0, role: 'button', 'aria-label': `bit ${b} is ${bit.on ? 1 : 0}, click to flip` });
      g.append(s('text', { x: x + cw / 2, y: y - 4, 'text-anchor': 'middle', fill: 'var(--ink-soft)', 'font-size': 9.5 }, b));
      g.append(s('rect', { x: x + 1, y, width: cw - 2, height: 24, rx: 3,
        fill: bit.on ? (colorOf.get(bit.field) || 'var(--ink-soft)') : 'var(--sunken)', stroke: bit.field ? 'var(--line)' : 'var(--line-soft)',
        'stroke-dasharray': bit.field ? null : '3 2' }));
      g.append(s('text', { x: x + cw / 2, y: y + 16, 'text-anchor': 'middle', fill: bit.on ? 'var(--surface)' : 'var(--ink-soft)', 'font-size': 12, 'font-weight': 600, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' }, bit.on ? 1 : 0));
      g.append(s('title', {}, `bit ${b}${bit.field ? ` · ${bit.field}` : ' · no field'} — click to flip`));
      const flip = () => {
        const v = (parseInt(result.hexValue, 16) ^ 2 ** b) >>> 0;
        setField('f-flip', '');
        setField('f-value', '0x' + v.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0'));
      };
      g.addEventListener('click', flip);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
      svg.append(g);
    }
    // field brackets in this row; labels that would collide drop to a second line
    const ends = [-1e9, -1e9, -1e9];
    const inRow = fields.filter((f) => Math.min(f.msb, hi) >= Math.max(f.lsb, lo)).sort((a, b) => b.msb - a.msb);
    for (const f of inRow) {
      const a = Math.min(f.msb, hi), z = Math.max(f.lsb, lo);
      const x1 = 2 + (hi - a) * cw + 2, x2 = 2 + (hi - z + 1) * cw - 2;
      const col = colorOf.get(f.name);
      svg.append(s('path', { d: `M${x1},${y + 30} v5 H${x2} v-5`, fill: 'none', stroke: col, 'stroke-width': 1.5 }));
      const w = f.msb - f.lsb + 1;
      const val = w > 4 ? '0x' + (f.value >>> 0).toString(16).toUpperCase() : String(f.value);
      let label = `${f.name} = ${val}`;
      if (label.length * 7.2 > Math.max(x2 - x1, 96)) label = f.name;
      if (label.length * 7.2 > 150) label = label.slice(0, 20) + '…';
      const tw = label.length * 7.2;
      const cx = Math.min(W - 2 - tw / 2, Math.max(2 + tw / 2, (x1 + x2) / 2));
      let line = ends.findIndex((e) => cx - tw / 2 > e + 4);
      if (line < 0) line = 2;
      ends[line] = cx + tw / 2;
      const t = s('text', { x: cx, y: y + 48 + line * 12, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-size': 10.5 }, label);
      t.append(s('title', {}, `${f.name} [${f.msb}:${f.lsb}] = ${f.value}${f.meaning ? ` — ${f.meaning}` : ''}`));
      svg.append(t);
    }
  }
  const block = document.createElement('div');
  block.className = 'k-block';
  const title = document.createElement('div'); title.className = 'k-title'; title.textContent = `${result.hexValue} — click a bit to flip it`;
  block.append(title, svg);
  el.append(block);
}
