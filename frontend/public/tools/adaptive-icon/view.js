// The two layers on the 108 dp canvas with the 72 dp visible square and the
// 66 dp safe circle, then the icon under each launcher mask. An image can be
// loaded as the foreground layer (kept in this page only).
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
// AOSP config_icon_mask paths, 100 × 100 units over the 72 dp visible area.
const MASKS = [
  ['Circle', 'M50 0A50 50 0 1 1 50 100A50 50 0 1 1 50 0Z'],
  ['Squircle', 'M50,0 C10,0 0,10 0,50 C0,90 10,100 50,100 C90,100 100,90 100,50 C100,10 90,0 50,0 Z'],
  ['Rounded square', 'M50,0L92,0C96.42,0 100,4.58 100,8L100,92C100,96.42 96.42,100 92,100L8,100C3.58,100 0,96.42 0,92L0,8C0,3.58 3.58,0 8,0L50,0Z'],
  ['Teardrop', 'M50,0A50,50,0,0 1 100,50L100,85A15,15,0,0 1 85,100L50,100A50,50,0,0 1 50,0Z'],
  ['Square', 'M0,0H100V100H0Z'],
];
let image = null, lastArgs = null, uid = 0;

export function view(el, result, input, api) {
  lastArgs = [el, result, input, api];
  el.replaceChildren();
  const d = result && result.drawing;
  if (!d) return;
  const id = ++uid;
  // one layer group in dp units, placed by the caller's transform
  const layers = (g, gid) => {
    if (d.bg2) {
      const defs = s('defs');
      const lg = s('linearGradient', { id: `ai-g${gid}`, x1: 0, y1: 0, x2: 1, y2: 1 });
      lg.append(s('stop', { offset: 0, 'stop-color': d.bg }), s('stop', { offset: 1, 'stop-color': d.bg2 }));
      defs.append(lg); g.append(defs);
    }
    g.append(s('rect', { width: 108, height: 108, fill: d.bg2 ? `url(#ai-g${gid})` : d.bg }));
    if (d.kind === 'image') {
      if (image) g.append(s('image', { href: image.url, x: 54 - d.size / 2, y: 54 - d.size / 2, width: d.size, height: d.size, preserveAspectRatio: 'xMidYMid meet' }));
    } else if (d.kind === 'text') {
      g.append(s('text', { x: 54, y: 54, 'font-family': 'Roboto, Arial, sans-serif', 'font-weight': 700, 'font-size': d.size * 1.05, fill: d.fg, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, d.text));
    } else if (d.kind === 'circle') g.append(s('circle', { cx: 54, cy: 54, r: d.size / 2, fill: d.fg }));
    else g.append(s('rect', { x: 54 - d.size / 2, y: 54 - d.size / 2, width: d.size, height: d.size, rx: d.size * 0.18, fill: d.fg }));
  };
  // Side by side when there is room, stacked on a phone.
  const narrow = ((el.parentElement && el.parentElement.clientWidth) || el.clientWidth || 600) < 520; // el itself is hidden while empty
  const pad = 14, big = narrow ? 180 : 220, cell = narrow ? 96 : 104, cols = 3;
  const W = narrow ? pad * 2 + cols * cell + (cols - 1) * 8 : 600;
  const bigX = narrow ? (W - big) / 2 : pad;
  const maskX0 = narrow ? pad : pad * 2 + big + 10, maskY0 = narrow ? pad + 12 + big + 30 : pad + 12;
  const H = narrow ? maskY0 + 2 * (cell + 34) : 300;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Adaptive icon layers and mask previews', style: `display:block;max-height:${narrow ? 640 : 340}px;margin:0 auto` });
  const txt = { 'font-size': 11, 'font-family': 'IBM Plex Mono, ui-monospace, monospace', fill: 'var(--ink-soft)' };
  // left: the full 108 dp canvas with guides
  const k = big / 108;
  const g0 = s('g', { transform: `translate(${bigX},${pad + 12}) scale(${k})` });
  layers(g0, `${id}a`);
  g0.append(s('rect', { x: 0, y: 0, width: 108, height: 108, fill: 'none', stroke: 'var(--line)', 'stroke-width': 1 / k }));
  g0.append(s('rect', { x: 18, y: 18, width: 72, height: 72, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.5 / k, 'stroke-dasharray': `${4 / k} ${3 / k}` }));
  g0.append(s('circle', { cx: 54, cy: 54, r: 33, fill: 'none', stroke: d.fits ? 'var(--ok)' : 'var(--danger)', 'stroke-width': 1.5 / k, 'stroke-dasharray': `${4 / k} ${3 / k}` }));
  svg.append(s('text', { ...txt, x: bigX, y: pad + 4 }, 'layers, 108 dp'));
  svg.append(g0);
  svg.append(s('text', { ...txt, x: bigX, y: pad + 12 + big + 16 }, '— 72 dp visible'));
  svg.append(s('text', { ...txt, x: bigX + 112, y: pad + 12 + big + 16, fill: d.fits ? 'var(--ok)' : 'var(--danger)' }, '— 66 dp safe'));
  // right: masks, 3 + 2 in a grid
  MASKS.forEach(([name, path], i) => {
    const cx = maskX0 + (i % cols) * (cell + 8), cy = maskY0 + Math.floor(i / cols) * (cell + 34);
    const sc = cell / 72; // 72 dp view -> cell px
    const cid = `ai-m${id}-${i}`;
    const defs = s('defs');
    const cp = s('clipPath', { id: cid });
    cp.append(s('path', { d: path, transform: `scale(${cell / 100})` }));
    defs.append(cp); svg.append(defs);
    const outer = s('g', { transform: `translate(${cx},${cy})` });
    const clipG = s('g', { 'clip-path': `url(#${cid})` });
    const inner = s('g', { transform: `scale(${sc}) translate(-18,-18)` });
    layers(inner, `${id}-${i}`);
    clipG.append(inner); outer.append(clipG);
    svg.append(outer);
    svg.append(s('text', { ...txt, x: cx + cell / 2, y: cy + cell + 14, 'text-anchor': 'middle' }, name));
  });
  // controls for an image foreground
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;font-size:12px;color:var(--ink-soft)';
  if (d.kind === 'image') {
    const pick = document.createElement('label');
    pick.className = 'k-btn';
    pick.textContent = image ? 'Change logo image' : 'Load a logo image';
    const file = document.createElement('input');
    file.type = 'file'; file.accept = 'image/*'; file.style.display = 'none';
    file.addEventListener('change', () => {
      const fl = file.files && file.files[0];
      if (!fl) return;
      const rd = new FileReader();
      rd.onload = () => { image = { url: rd.result, name: fl.name }; if (lastArgs) view(...lastArgs); };
      rd.readAsDataURL(fl);
    });
    pick.append(file); bar.append(pick);
    const note = document.createElement('span');
    note.textContent = image ? `${image.name}, drawn ${api.fmtNum(d.size, 3)} dp square (use a transparent PNG or SVG)` : 'A transparent PNG or SVG; it stays in this page.';
    bar.append(note);
  }
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Layers and launcher masks';
  wrap.append(title);
  if (bar.childNodes.length) wrap.append(bar);
  wrap.append(svg);
  el.append(wrap);
}
