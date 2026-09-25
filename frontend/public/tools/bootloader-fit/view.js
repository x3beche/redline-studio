// Bootloader Size Check: the page is the flash itself.
//   Map     - the chip's flash as one tall column, low address at the bottom,
//             cut into its real erase sectors. The bootloader, the slots, the
//             scratch sector and the reserved data are laid on it; inside
//             each the programmed image is a solid fill with the growth margin
//             hatched above it. Drag the top of an image to change its size,
//             the bootloader's top edge to move its reserve sector by sector,
//             the margin band to change the margin, the reserved data's lower
//             edge to grow it. Every handle takes the arrow keys too.
//   Ledger  - one card per region, placed beside it with a leader line: its
//             addresses, sectors, image, headroom; the sizes are typed there.
//   Rail    - the verdict, the slot scheme (three small maps to pick from),
//             the chip's flash, the vector table lens (header + VTOR
//             alignment), the warnings and the output panel.
// Every number drawn comes from run()'s result (result.drawing / tables / values).

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const CSS = `
.blf { --tool-boot: #b45309; --tool-slota: #1f4ed8; --tool-slotb: #0f8a7a; --tool-scratch: #8b3fb0; --tool-nvm: #5b6b7a; --tool-over: var(--danger); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .blf {
  --tool-boot: #f0a33a; --tool-slota: #7b98ff; --tool-slotb: #3cc7b3; --tool-scratch: #c982e0; --tool-nvm: #93a5b5; } }
:root[data-theme="dark"] .blf { --tool-boot: #f0a33a; --tool-slota: #7b98ff; --tool-slotb: #3cc7b3; --tool-scratch: #c982e0; --tool-nvm: #93a5b5; }
.blf { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 12px; align-items: start; min-width: 0; }
@media (max-width: 980px) { .blf { grid-template-columns: minmax(0, 1fr); } }
.blf-stage { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.blf-top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 16px; padding: 7px 12px; border-bottom: 1px solid var(--line-soft); font-size: 11.5px; color: var(--ink-soft); }
.blf-top h2 { margin: 0; font-size: 12.5px; font-weight: 600; color: var(--ink); }
.blf-top b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.blf-key { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-left: auto; align-items: center; }
.blf-key i { display: inline-block; width: 14px; height: 10px; margin-right: 4px; vertical-align: -1px; border: 1px solid var(--ink-soft); }
.blf-key label { display: inline-flex; align-items: center; gap: 4px; }
.blf-body { position: relative; }
.blf-svg { display: block; width: 100%; user-select: none; -webkit-user-select: none; }
.blf-svg text { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.blf-svg text.ink { fill: var(--ink); }
.blf-svg .hdl { cursor: ns-resize; touch-action: none; }
.blf-svg .hdl:focus { outline: none; }
.blf-svg .hdl:focus-visible .tab { stroke: var(--accent); stroke-width: 2.5; }
.blf-svg .hdl:hover .tab { stroke: var(--ink); }
.blf-help { padding: 6px 12px 9px; font-size: 11.5px; color: var(--ink-soft); border-top: 1px solid var(--line-soft); }
.blf-help kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.blf-card { position: absolute; background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--rc); border-radius: 4px;
  padding: 4px 8px 5px; font-size: 11.5px; min-width: 0; box-sizing: border-box; }
.blf-card.bad { border-color: var(--danger); border-left-color: var(--danger); }
.blf-card .l1 { display: flex; gap: 8px; align-items: baseline; white-space: nowrap; }
.blf-card .l1 b { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.blf-card .l1 .sz { margin-left: auto; font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.blf-card .ad { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.blf-card .l3 { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: center; margin-top: 2px; color: var(--ink-soft); }
.blf-card .l3 .v { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.blf-card .l3 .v.ok { color: var(--ok); } .blf-card .l3 .v.warn { color: var(--warn); } .blf-card .l3 .v.bad { color: var(--danger); }
.blf input[type="text"], .blf select { padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); min-width: 0; }
.blf input.bad { border-color: var(--danger); }
.blf-card input[type="text"] { width: 76px; }
.blf-card label { display: inline-flex; gap: 4px; align-items: center; }
.blf-rail { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.blf-box { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.blf-box > h3 { margin: 0; padding: 6px 10px; font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--line-soft); display: flex; gap: 8px; align-items: baseline; }
.blf-box > h3 span { font-weight: 400; color: var(--ink-soft); font-size: 11px; }
.blf-verdict { padding: 8px 10px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 12px; align-items: center; }
.blf-verdict .big { grid-row: span 3; font: 600 20px "IBM Plex Sans", sans-serif; padding: 4px 10px; border-radius: 4px; border: 1.5px solid; text-align: center; }
.blf-verdict .big.ok { color: var(--ok); } .blf-verdict .big.warn { color: var(--warn); } .blf-verdict .big.bad { color: var(--danger); }
.blf-verdict .row { font-size: 11.5px; color: var(--ink-soft); display: flex; justify-content: space-between; gap: 8px; }
.blf-verdict .row b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.blf-schemes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 8px 10px; }
.blf-scheme { display: flex; gap: 7px; align-items: center; text-align: left; border: 1px solid var(--line); border-radius: 5px; background: var(--surface);
  padding: 5px 6px; cursor: pointer; font-size: 11px; line-height: 1.25; color: var(--ink-soft); }
.blf-scheme:hover { border-color: var(--ink-soft); }
.blf-scheme[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; color: var(--ink); }
.blf-scheme svg { flex: none; width: 16px; height: 44px; }
.blf-chip { padding: 8px 10px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
.blf-chip label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--ink-soft); min-width: 0; }
.blf-chip label.w { grid-column: 1 / -1; }
.blf-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.blf-seg button { border: 0; background: var(--surface); padding: 2px 9px; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.blf-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 500; }
.blf-strip { display: block; width: 100%; height: 22px; margin-top: 3px; }
.blf-lens { padding: 6px 10px 8px; }
.blf-lens svg { display: block; width: 100%; }
.blf-lens svg text { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.blf-lens svg text.ink { fill: var(--ink); }
.blf-lens .f { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11px; color: var(--ink-soft); margin-top: 4px; align-items: center; }
.blf-lens .f label { display: inline-flex; gap: 5px; align-items: center; }
.blf-lens .f input { width: 70px; }
.blf-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.blf-warns div + div { margin-top: 4px; }
.blf-warns:empty { display: none; }
.blf-notes { font-size: 11.5px; color: var(--ink-soft); }
.blf-notes summary { cursor: pointer; }
.blf-notes div { margin-top: 4px; }
.blf .k-out { max-height: 220px; }
@media (max-width: 560px) {
  .blf-card { padding: 3px 6px 4px; }
  .blf-card .l3 { gap: 1px 8px; }
  .blf-card input[type="text"] { width: 64px; }
  .blf-scheme .sub { display: none; }
}
`;

const KIND = {
  boot: { color: 'var(--tool-boot)', short: 'Boot' },
  slota: { color: 'var(--tool-slota)', short: 'A' },
  slotb: { color: 'var(--tool-slotb)', short: 'B' },
  scratch: { color: 'var(--tool-scratch)', short: 'Scr' },
  nvm: { color: 'var(--tool-nvm)', short: 'Data' },
  unused: { color: 'var(--line)', short: '' },
};

const hex = (v) => '0x' + v.toString(16).toUpperCase().padStart(8, '0');
const kb = (b) => (b >= 1048576 && b % 1048576 === 0 ? `${b / 1048576} MiB` : b >= 1024 ? `${+(b / 1024).toFixed(b % 1024 ? 2 : 0)} KiB` : `${b} B`);
const sizeText = (b) => (b > 0 && b % 1024 === 0 ? `${b / 1024}K` : String(b));

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'blf' });
  root.append(wrap);

  // ---------- the stage: map + ledger ----------
  const topInfo = h('span', {});
  const marginIn = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Growth margin in percent', style: 'width:46px',
    oninput: (e) => ctx.set('margin', e.target.value) });
  const top = h('div', { class: 'blf-top' }, h('h2', {}, 'Flash'), topInfo,
    h('span', { class: 'blf-key' },
      h('span', {}, h('i', { style: 'background:color-mix(in srgb,var(--tool-slota) 55%,transparent);border-color:var(--tool-slota)' }), 'image'),
      h('span', {}, h('i', { class: 'hatch-key', style: 'background:repeating-linear-gradient(135deg,var(--tool-slota) 0 1.5px,transparent 1.5px 4px);border-color:var(--tool-slota)' }), 'growth margin'),
      h('label', {}, 'margin', marginIn, '%')));
  const svg = s('svg', { class: 'blf-svg', role: 'group', 'aria-label': 'Flash memory map' });
  const body = h('div', { class: 'blf-body' }, svg);
  const help = h('div', { class: 'blf-help' }, 'Drag the top of an image to resize it, the bootloader\'s top edge to move its reserve by a sector, the hatched band to change the margin, the reserved data\'s lower edge to grow it. Focus a handle and use ',
    h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' (', h('kbd', {}, 'Shift'), ' for bigger steps).');
  const stage = h('section', { class: 'blf-stage' }, top, body, help);

  // ---------- the rail ----------
  const verdict = h('div', { class: 'blf-verdict' });
  const vBox = h('section', { class: 'blf-box' }, verdict);
  const schemes = h('div', { class: 'blf-schemes', role: 'group', 'aria-label': 'Slot scheme' });
  const sBox = h('section', { class: 'blf-box' }, h('h3', {}, 'Slots'), schemes);

  const inputs = {};
  const txt = (key, label, extra = {}) => {
    const el = h('input', { type: 'text', spellcheck: 'false', 'aria-label': label, oninput: (e) => ctx.set(key, e.target.value), ...extra });
    inputs[key] = el;
    return el;
  };
  const layoutSeg = h('span', { class: 'blf-seg', role: 'group', 'aria-label': 'Erase sectors' });
  const stripSvg = s('svg', { class: 'blf-strip', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  const pageLab = h('label', {}, 'Page / sector size', txt('page', 'Page size'));
  const listLab = h('label', { class: 'w' }, 'Sector list, address order (n*size repeats)', txt('sectors', 'Sector list'));
  const chip = h('div', { class: 'blf-chip' },
    h('label', {}, 'Flash start', txt('base', 'Flash start address')),
    h('label', {}, 'Flash size', txt('size', 'Flash size')),
    h('label', { class: 'w' }, 'Erase sectors', layoutSeg),
    pageLab, listLab,
    h('div', { class: 'w', style: 'grid-column:1/-1' }, stripSvg));
  const cBox = h('section', { class: 'blf-box' }, h('h3', {}, 'Chip flash', h('span', {}, 'erase units the regions snap to')), chip);

  const lensSvg = s('svg', { role: 'img', 'aria-label': 'Application start, header and vector table alignment' });
  const lensSub = h('span', {});
  const lens = h('div', { class: 'blf-lens' }, lensSvg,
    h('div', { class: 'f' },
      h('label', {}, 'header + trailer', txt('hdr', 'Image header and trailer bytes')),
      h('label', {}, 'vector entries', txt('vectors', 'Vector table entries', { inputmode: 'numeric' }))));
  const lBox = h('section', { class: 'blf-box' }, h('h3', {}, 'Vector table', lensSub), lens);

  const warns = h('div', { class: 'blf-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'blf-notes' }, h('summary', {}, 'How it is laid out'));
  const rail = h('div', { class: 'blf-rail' }, vBox, warns, sBox, lBox, cBox, ctx.outputs, notes);
  wrap.append(stage, rail);

  let res = null, draggingKey = null, frozenKnots = null, curKnots = null;
  const drag = (move, done) => {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      draggingKey = null;
      done();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // ---------- the map ----------
  function drawMap() {
    const focused = svg.querySelector('.hdl:focus')?.dataset.key || null;
    svg.replaceChildren();
    for (const c of body.querySelectorAll('.blf-card')) c.remove();
    const d = res && res.drawing;
    const W = Math.max(300, body.clientWidth || 700);
    const narrow = W < 560;
    const Hh = Math.max(520, Math.min(900, (window.innerHeight || 800) - 150));
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    svg.setAttribute('height', Hh);
    body.style.height = `${Hh}px`;
    if (!d) {
      svg.append(s('text', { x: 16, y: 40, class: 'ink' }, 'No map: see the message on the right.'));
      topInfo.textContent = '';
      return;
    }
    const T = 16, B = 16;
    const axisW = narrow ? 70 : 92;
    const colW = narrow ? 64 : Math.min(280, Math.max(120, W * 0.26));
    const x0 = axisW, x1 = axisW + colW;
    // The scale: bytes to pixels, piecewise, so a small region (a 4 KiB data
    // area on 1 MiB) still gets room for its handle. Frozen while dragging.
    const avail = Hh - T - B;
    let knots = frozenKnots;
    if (!knots) {
      const segs = d.regions.map((r) => ({ a: r.start, b: r.end, h: ((r.end - r.start) / d.end) * avail }));
      const minH = narrow ? 40 : 52;
      for (let it = 0; it < 4; it++) {
        const small = segs.filter((g) => g.h < minH);
        if (!small.length) break;
        for (const g of small) g.h = minH;
        const big = segs.filter((g) => g.h > minH);
        const rest = avail - segs.filter((g) => g.h <= minH).reduce((a, g) => a + g.h, 0);
        const bigBytes = big.reduce((a, g) => a + (g.b - g.a), 0);
        for (const g of big) g.h = Math.max(minH, ((g.b - g.a) / bigBytes) * rest);
      }
      const tot = segs.reduce((a, g) => a + g.h, 0);
      knots = [[0, Hh - B]];
      let yy = Hh - B;
      for (const g of segs) { yy -= (g.h / tot) * avail; knots.push([g.b, yy]); }
      if (knots.at(-1)[0] < d.end) knots.push([d.end, T]);
    }
    curKnots = knots;
    const Y = (off) => {
      if (off <= 0) return knots[0][1] - (off / d.end) * avail;
      for (let i = 1; i < knots.length; i++) {
        const [a, ya] = knots[i - 1], [b, yb] = knots[i];
        if (off <= b || i === knots.length - 1) return ya + ((off - a) / (b - a || 1)) * (yb - ya);
      }
      return T;
    };
    const Yinv = (y) => {
      for (let i = 1; i < knots.length; i++) {
        const [a, ya] = knots[i - 1], [b, yb] = knots[i];
        if (y >= yb || i === knots.length - 1) return a + ((y - ya) / (yb - ya || -1)) * (b - a);
      }
      return d.end;
    };
    const pxPerByte = (Y(0) - Y(d.page || 1)) / (d.page || 1);
    const defs = s('defs');
    for (const k of Object.keys(KIND)) {
      const p = s('pattern', { id: `blf-h-${k}`, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      p.append(s('rect', { width: 1.6, height: 5, fill: KIND[k].color }));
      defs.append(p);
    }
    const pu = s('pattern', { id: 'blf-h-free', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pu.append(s('rect', { width: 1, height: 6, fill: 'var(--line)' }));
    defs.append(pu);
    const po = s('pattern', { id: 'blf-h-over', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' });
    po.append(s('rect', { width: 2.2, height: 6, fill: 'var(--danger)', 'fill-opacity': 0.8 }));
    defs.append(po);
    svg.append(defs);

    // Column background and outline.
    svg.append(s('rect', { x: x0, y: T, width: colW, height: Hh - T - B, fill: 'var(--sunken)', stroke: 'var(--line)' }));

    // Regions.
    for (const r of d.regions) {
      const k = KIND[r.kind];
      const ya = Y(r.end), yb = Y(r.start);
      if (r.kind === 'unused') {
        svg.append(s('rect', { x: x0, y: ya, width: colW, height: yb - ya, fill: 'url(#blf-h-free)' }));
        continue;
      }
      svg.append(s('rect', { x: x0, y: ya, width: colW, height: yb - ya, fill: k.color, 'fill-opacity': 0.1 }));
    }
    // Sector boundaries: every one where there is room, else every n-th.
    const bnd = d.boundaries;
    const minGap = 3.2;
    let every = 1;
    if (d.page) every = Math.max(1, Math.ceil(minGap / (d.page * pxPerByte)));
    bnd.forEach((b, i) => {
      if (i === 0 || i === bnd.length - 1) return;
      if (every > 1 && i % every) return;
      const y = Y(b);
      const sparse = !d.page || d.page * pxPerByte > 12;
      svg.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, stroke: 'var(--ink-soft)', 'stroke-width': sparse ? 0.8 : 0.6, 'stroke-opacity': sparse ? 0.55 : 0.22, 'stroke-dasharray': sparse ? '3 3' : null }));
      svg.append(s('line', { x1: x0, x2: x0 + 5, y1: y, y2: y, stroke: 'var(--ink-soft)', 'stroke-width': 0.8, 'stroke-opacity': 0.8 }));
    });
    // Images: header slice, image fill, growth margin (hatched) and overflow.
    const images = [];
    for (const r of d.regions) {
      if (!r.used || r.kind === 'unused') continue;
      const k = KIND[r.kind];
      const size = r.end - r.start;
      const isBoot = r.kind === 'boot';
      const img = r.used;
      const withMargin = Math.ceil(img * (1 + d.margin));
      const inset = 6;
      const xi = x0 + inset, wi = colW - inset * 2;
      const yTopImg = Y(r.start + Math.min(img, size));
      svg.append(s('rect', { x: xi, y: yTopImg, width: wi, height: Y(r.start) - yTopImg, fill: k.color, 'fill-opacity': 0.55 }));
      if (!isBoot && d.hdr > 0) {
        const yh = Y(r.start + Math.min(d.hdr, size));
        svg.append(s('rect', { x: xi, y: yh, width: wi, height: Math.max(1.5, Y(r.start) - yh), fill: k.color, 'fill-opacity': 0.95 }));
      }
      const yM = Y(r.start + Math.min(withMargin, size));
      if (withMargin > img) svg.append(s('rect', { x: xi, y: yM, width: wi, height: Math.max(0, yTopImg - yM), fill: `url(#blf-h-${r.kind})`, opacity: 0.9 }));
      if (withMargin > size && r.kind !== 'slotb') {
        // Margin (or image) past the region: drawn outside the column, where it collides.
        const yO = Y(r.start + withMargin), yE = Y(r.end);
        const bad = img > size;
        svg.append(s('rect', { x: x1 + 2, y: Math.max(T - 6, yO), width: 8, height: Math.max(2, yE - Math.max(T - 6, yO)),
          fill: bad ? 'var(--danger)' : 'var(--warn)', 'fill-opacity': bad ? 0.85 : 0.55 }));
        if (bad) {
          const yI = Math.max(T - 6, Y(r.start + img));
          svg.append(s('rect', { x: x0 + 2, y: yI, width: colW - 4, height: Math.max(2, yE - yI), fill: 'url(#blf-h-over)', stroke: 'var(--danger)', 'stroke-width': 1.5, 'stroke-dasharray': '4 2' }));
          const lab = `${kb(img - size)} over`;
          svg.append(s('text', { x: x0 + colW / 2, y: Math.max(yI + 14, Math.min(yE - 6, (yI + yE) / 2 + 4)), 'text-anchor': 'middle', style: 'fill:var(--danger);font-weight:600;paint-order:stroke;stroke:var(--surface);stroke-width:3px' }, lab));
        }
      }
      images.push({ r, yTopImg: Math.max(T, Y(r.start + img)), yM, isBoot });
    }
    // Region outlines on top; a break mark where a region is drawn larger than to scale.
    for (const r of d.regions) {
      const ya = Y(r.end), yb = Y(r.start);
      if (yb - ya > 1.6 * ((r.end - r.start) / d.end) * avail + 4) {
        const ym = (ya + yb) / 2;
        for (const dy of [-2.5, 2.5]) svg.append(s('path', { d: `M${x0 - 4},${ym + dy + 3}l8,-6`, stroke: 'var(--ink-soft)', 'stroke-width': 1.2 }));
        svg.append(s('rect', { x: x0 - 1, y: ym - 3, width: 3, height: 6, fill: 'var(--surface)' }));
      }
      svg.append(s('rect', { x: x0, y: ya, width: colW, height: yb - ya, fill: 'none', stroke: r.kind === 'unused' ? 'var(--line)' : KIND[r.kind].color, 'stroke-width': 1.6 }));
      const k = KIND[r.kind];
      if (k.short && yb - ya > 44 && !narrow) svg.append(s('text', { x: x0 + colW / 2, y: (ya + yb) / 2 + 4, 'text-anchor': 'middle', class: 'ink',
        style: 'font-weight:600;paint-order:stroke;stroke:var(--surface);stroke-width:3px' }, k.short));
    }
    // Vector table marker at slot A start.
    {
      const yv = Y(d.bootEnd + d.hdr);
      const col = d.vtOk ? 'var(--ink-soft)' : 'var(--danger)';
      svg.append(s('path', { d: `M${x0 - 1},${yv}l-7,-4v8z`, fill: col }));
      if (!d.vtOk) svg.append(s('text', { x: x0 - 10, y: yv - 6, 'text-anchor': 'end', style: 'fill:var(--danger)' }, 'VTOR!'));
    }

    // Address axis: every region boundary, thinned where they crowd.
    const marks = [...new Set([0, ...d.regions.flatMap((r) => [r.start, r.end])])].sort((a, b) => b - a);
    let lastY = -Infinity;
    for (const m of marks) {
      const y = Y(m);
      svg.append(s('line', { x1: x0 - 5, x2: x0, y1: y, y2: y, stroke: 'var(--ink-soft)' }));
      if (Math.abs(lastY - y) < 12 && m !== 0) continue;
      const lab = m === d.end ? hex(d.base + m - 1) : hex(d.base + m);
      svg.append(s('text', { x: x0 - 8, y: y + (m === d.end ? 9 : m === 0 ? -2 : 3.5), 'text-anchor': 'end', style: narrow ? 'font-size:9.5px' : null }, narrow ? lab.replace(/^0x/, '') : lab));
      lastY = y;
    }

    // ---------- handles ----------
    const handles = [];
    const handle = (key, y, label, value, opts) => {
      const g = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuetext': value, 'data-key': key });
      const tw = opts.w || 28;
      const xt = opts.x ?? (x0 + colW / 2 - tw / 2);
      g.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, stroke: opts.color, 'stroke-width': 2 }));
      g.append(s('rect', { class: 'tab', x: xt, y: y - 5, width: tw, height: 10, rx: 3, fill: 'var(--surface)', stroke: opts.color, 'stroke-width': 1.5 }));
      for (const dx of [-4, 0, 4]) g.append(s('line', { x1: xt + tw / 2 + dx, x2: xt + tw / 2 + dx, y1: y - 2.5, y2: y + 2.5, stroke: opts.color, 'stroke-width': 1 }));
      g.append(s('rect', { x: x0 - 2, y: y - 7, width: colW + 4, height: 14, fill: 'transparent' }));
      g.append(s('title', {}, `${label}: ${value}`));
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        g.focus({ preventScroll: true });
        draggingKey = key;
        frozenKnots = curKnots;
        const toOff = (ev) => {
          const rc = svg.getBoundingClientRect();
          return Yinv((ev.clientY - rc.top) * (Hh / rc.height));
        };
        const grab = toOff(e) - opts.at;
        const move = (ev) => opts.set(toOff(ev) - grab);
        drag(move, () => { frozenKnots = null; drawMap(); svg.querySelector(`.hdl[data-key="${key}"]`)?.focus({ preventScroll: true }); });
      });
      g.addEventListener('keydown', (e) => {
        const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
        if (!dir && e.key !== 'Home') return;
        e.preventDefault();
        if (e.key === 'Home') opts.home?.(); else opts.step(dir, e.shiftKey);
      });
      handles.push(g);
    };
    const snapUpBoundary = (off, lo, hi) => {
      let best = null;
      for (const b of bnd) if (b > lo && b < hi && (best == null || Math.abs(b - off) < Math.abs(best - off))) best = b;
      return best;
    };
    const areaTop = d.scratch ? d.scratch.start : d.nvmStart;
    // Bootloader reserve edge: snaps to sector boundaries.
    handle('bootres', Y(d.bootEnd), 'Bootloader reserve (top edge)', `${kb(d.bootEnd)}${d.bootAuto ? ' (auto)' : ''}`, {
      color: 'var(--tool-boot)', at: d.bootEnd, x: x1 - 34, w: 28,
      set: (off) => { const b = snapUpBoundary(off, 0, areaTop); if (b != null && (b !== d.bootEnd || d.bootAuto)) ctx.set('bootres', sizeText(b)); },
      step: (dir, big) => {
        const i = bnd.indexOf(d.bootEnd);
        const j = Math.max(1, Math.min(bnd.length - 2, i + dir * (big ? 4 : 1)));
        if (bnd[j] < areaTop) ctx.set('bootres', sizeText(bnd[j]));
      },
      home: () => ctx.set('bootres', ''),
    });
    // Images.
    for (const im of images) {
      const r = im.r;
      if (im.isBoot) {
        handle('boot', im.yTopImg, 'Bootloader image size', `${r.used} bytes`, {
          color: 'var(--tool-boot)', at: r.start + r.used, x: x0 + 6,
          set: (off) => { const v = Math.max(256, Math.round((off - r.start) / 256) * 256); if (v !== d.boot) ctx.set('boot', String(v)); },
          step: (dir, big) => ctx.set('boot', String(Math.max(0, d.boot + dir * (big ? 8192 : 1024)))),
        });
      } else if (r.kind === 'slota') {
        handle('app', im.yTopImg, 'Application image size', `${d.app} bytes`, {
          color: 'var(--tool-slota)', at: r.start + r.used, x: x0 + 6,
          set: (off) => { const v = Math.max(1024, Math.round((off - r.start - d.hdr) / 1024) * 1024); if (v !== d.app) ctx.set('app', String(v)); },
          step: (dir, big) => ctx.set('app', String(Math.max(0, d.app + dir * (big ? 16384 : 1024)))),
        });
        if (d.margin >= 0 && r.used > 0) {
          const mt = Math.ceil(r.used * (1 + d.margin));
          handle('margin', Y(r.start + mt), 'Growth margin', `${Math.round(d.margin * 100)} %`, {
            color: 'var(--tool-slota)', at: r.start + mt, x: x0 + colW - 34, w: 28,
            set: (off) => { const pct = Math.max(0, Math.min(200, Math.round(((off - r.start) / r.used - 1) * 100))); if (pct !== Math.round(d.margin * 100)) ctx.set('margin', String(pct)); },
            step: (dir, big) => ctx.set('margin', String(Math.max(0, Math.round(d.margin * 100) + dir * (big ? 10 : 1)))),
          });
        }
      }
    }
    // Reserved data lower edge: sector boundaries counted from the end.
    handle('nvm', Y(d.nvmStart), 'Reserved data (lower edge)', kb(d.end - d.nvmStart), {
      color: 'var(--tool-nvm)', at: d.nvmStart, x: x0 + colW / 2 - 14,
      set: (off) => {
        const b = off >= d.end - (bnd.at(-1) - bnd.at(-2)) / 2 ? d.end : snapUpBoundary(off, d.bootEnd, d.end + 1);
        if (b != null && b !== d.nvmStart) ctx.set('nvm', b === d.end ? '0' : sizeText(d.end - b));
      },
      step: (dir, big) => {
        const i = bnd.indexOf(d.nvmStart);
        const j = Math.max(1, Math.min(bnd.length - 1, i - dir * (big ? 4 : 1)));
        if (bnd[j] > d.bootEnd) ctx.set('nvm', bnd[j] === d.end ? '0' : sizeText(d.end - bnd[j]));
      },
    });
    svg.append(...handles);
    if (focused) svg.querySelector(`.hdl[data-key="${focused}"]`)?.focus({ preventScroll: true });

    // ---------- the ledger ----------
    const rows = (res.tables || [])[0]?.rows || [];
    const cardX = x1 + 30;
    const cardW = Math.min(520, W - cardX - 8);
    const cards = [];
    d.regions.forEach((r, i) => {
      const row = rows[i];
      if (!row) return;
      const k = KIND[r.kind];
      const card = h('div', { class: 'blf-card', style: `--rc:${k.color};left:${cardX}px;width:${cardW}px` });
      const l3 = h('div', { class: 'l3' });
      const free = row[6];
      const overflow = /^over/.test(free);
      if (r.kind === 'boot') {
        const tone = !d.bootOk ? 'bad' : d.bootMarginOk ? 'ok' : 'warn';
        l3.append(h('label', {}, 'image', numIn('boot', 'Bootloader image bytes')),
          h('label', {}, 'reserve', numIn('bootres', 'Bootloader reserve', 'auto')),
          h('span', {}, 'free ', h('span', { class: `v ${tone}` }, free)));
        if (!d.bootOk) card.classList.add('bad');
      } else if (r.kind === 'slota') {
        const tone = !d.appOk ? 'bad' : d.appMarginOk ? 'ok' : 'warn';
        l3.append(h('label', {}, 'image', numIn('app', 'Application image bytes')),
          h('span', {}, `+ ${d.hdr} B hdr`),
          h('span', {}, 'free ', h('span', { class: `v ${tone}` }, free)));
        if (!d.appOk) card.classList.add('bad');
      } else if (r.kind === 'slotb') {
        l3.append(h('span', {}, 'download copy, same size as A'), h('span', {}, 'free ', h('span', { class: 'v' }, free)));
      } else if (r.kind === 'nvm') {
        l3.append(h('label', {}, 'wanted', numIn('nvm', 'Reserved data size')), h('span', {}, 'whole sectors'));
      } else if (r.kind === 'scratch') {
        l3.append(h('span', {}, `≥ largest slot sector (${kb(Math.max(...d.sectors.filter((_, j) => bnd[j] >= d.bootEnd && bnd[j] < areaTop)))})`));
      } else {
        l3.append(h('span', {}, 'not used by either slot'));
      }
      if (overflow) card.classList.add('bad');
      card.append(
        h('div', { class: 'l1' }, h('b', {}, r.name), h('span', { class: 'sz' }, row[3])),
        h('div', { class: 'ad' }, `${row[1]} – ${row[2]} · ${row[4]} sector${row[4] === '1' ? '' : 's'}`),
        l3);
      body.append(card);
      cards.push({ card, want: (Y(r.end) + Y(r.start)) / 2, r });
    });
    // Place the cards beside their regions without overlap (top to bottom = high to low address).
    for (const c of cards) c.hgt = c.card.offsetHeight || 58;
    const gap = 6;
    let y = T;
    const sorted = cards.slice().sort((a, b) => a.want - b.want);
    for (const c of sorted) { c.y = Math.max(y, c.want - c.hgt / 2); y = c.y + c.hgt + gap; }
    let over = y - gap - (Hh - B);
    for (let i = sorted.length - 1; i >= 0 && over > 0; i--) {
      const c = sorted[i];
      const lim = i ? sorted[i - 1].y + sorted[i - 1].hgt + gap : T;
      const mv = Math.min(over, c.y - lim);
      // shift this card and all below it
      for (let j = i; j < sorted.length; j++) sorted[j].y -= mv;
      over -= mv;
      if (mv <= 0) continue;
    }
    for (const c of sorted) {
      c.card.style.top = `${c.y}px`;
      const yc = c.y + Math.min(c.hgt / 2, 14);
      const ya = Y(c.r.end), yb = Y(c.r.start);
      const ym = Math.max(ya + 1, Math.min(yb - 1, c.want));
      svg.insertBefore(s('path', { d: `M${x1 + (c.r.used && c.r.kind !== 'unused' ? 12 : 1)},${ym}H${x1 + 16}L${cardX - 6},${yc}H${cardX}`, fill: 'none',
        stroke: c.r.kind === 'unused' ? 'var(--line)' : KIND[c.r.kind].color, 'stroke-width': 1.2 }), svg.firstChild.nextSibling);
    }

    const sectorDesc = d.page ? `${bnd.length - 1} × ${kb(d.page)} pages` : `${bnd.length - 1} sectors (${kb(Math.min(...d.sectors))} – ${kb(Math.max(...d.sectors))})`;
    topInfo.replaceChildren(h('b', {}, kb(d.end)), ` at ${hex(d.base)} · ${sectorDesc}`);
  }

  // A text input bound to an input key, kept in sync with the kit's raw value.
  function numIn(key, label, placeholder) {
    const el = h('input', { type: 'text', spellcheck: 'false', inputmode: 'text', 'aria-label': label, placeholder: placeholder || null,
      oninput: (e) => ctx.set(key, e.target.value) });
    el.value = ctx.raw[key] ?? '';
    el.dataset.key = key;
    return el;
  }
  // Keep the focused ledger input alive across redraws.
  function withFocus(fn) {
    const a = document.activeElement;
    const key = a && a.closest && a.closest('.blf-card') ? a.dataset.key : null;
    const sel = key ? [a.selectionStart, a.selectionEnd] : null;
    fn();
    if (key) {
      const el = body.querySelector(`.blf-card input[data-key="${key}"]`);
      if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(...sel); } catch { /* */ } }
    }
  }

  // ---------- rail ----------
  function drawRail() {
    const d = res && res.drawing;
    const vals = (res && res.values) || [];
    const val = (label) => vals.find((v) => v.label === label || v.label.startsWith(label));
    const fits = val('Fits');
    verdict.replaceChildren();
    if (fits) {
      verdict.append(h('div', { class: `big ${fits.tone || ''}` }, fits.value === 'no' ? 'Does not fit' : fits.value === 'yes' ? 'Fits' : 'Fits, tight'));
      for (const lab of ['Slot size', 'Application region', 'Application headroom', 'Application start']) {
        const v = val(lab);
        if (v) verdict.append(h('div', { class: 'row' }, v.label, h('b', { style: v.tone === 'bad' ? 'color:var(--danger)' : null }, String(v.value))));
      }
    } else {
      verdict.append(h('div', { class: 'big bad' }, '–'), h('div', { class: 'row' }, 'Nothing to lay out yet'));
    }

    // Slot schemes as tiny maps.
    const cur = String(ctx.raw.slots || '2');
    schemes.replaceChildren();
    const mini = (parts) => {
      const m = s('svg', { viewBox: '0 0 16 44', 'aria-hidden': 'true' });
      let y = 44;
      for (const [k, hgt] of parts) { y -= hgt; m.append(s('rect', { x: 0.5, y: y + 0.5, width: 15, height: hgt - 1, fill: KIND[k].color, 'fill-opacity': 0.5, stroke: KIND[k].color })); }
      return m;
    };
    for (const [v, title, sub, parts] of [
      ['1', 'One slot', 'update in place', [['boot', 8], ['slota', 30], ['nvm', 6]]],
      ['2', 'A / B', 'download slot', [['boot', 8], ['slota', 15], ['slotb', 15], ['nvm', 6]]],
      ['2s', 'A / B + scratch', 'MCUboot swap', [['boot', 8], ['slota', 13], ['slotb', 13], ['scratch', 4], ['nvm', 6]]],
    ]) {
      schemes.append(h('button', { class: 'blf-scheme', 'aria-pressed': String(cur === v), onclick: () => ctx.set('slots', v) },
        mini(parts), h('span', {}, h('b', { style: 'display:block;color:var(--ink);font-weight:500' }, title), h('span', { class: 'sub' }, sub))));
    }

    // Erase sectors: toggle + a strip of the sectors to scale.
    const lay = ctx.raw.layout || 'uniform';
    layoutSeg.replaceChildren(
      h('button', { 'aria-pressed': String(lay === 'uniform'), onclick: () => ctx.set('layout', 'uniform') }, 'Uniform pages'),
      h('button', { 'aria-pressed': String(lay === 'list'), onclick: () => ctx.set('layout', 'list') }, 'Listed sectors'));
    pageLab.style.display = lay === 'uniform' ? '' : 'none';
    listLab.style.display = lay === 'list' ? '' : 'none';
    stripSvg.replaceChildren();
    if (d) {
      stripSvg.setAttribute('viewBox', `0 0 ${d.end} 22`);
      const many = d.sectors.length > 120;
      d.sectors.forEach((sz, i) => {
        if (many && i % Math.ceil(d.sectors.length / 120)) return;
        stripSvg.append(s('rect', { x: d.boundaries[i], y: 2, width: many ? sz * Math.ceil(d.sectors.length / 120) : sz, height: 12, fill: 'var(--sunken)', stroke: 'var(--ink-soft)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
      });
      for (const r of d.regions) if (r.kind !== 'unused') stripSvg.append(s('rect', { x: r.start, y: 16, width: r.end - r.start, height: 5, fill: KIND[r.kind].color }));
    }

    // Vector table lens: slot start, header, the table, alignment grid.
    drawLens(d);

    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'How it is laid out'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }

  function drawLens(d) {
    lensSvg.replaceChildren();
    if (!d) { lensSub.textContent = ''; return; }
    const W = Math.max(260, lens.clientWidth - 20 || 340), H = 98;
    lensSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    lensSvg.setAttribute('height', H);
    const start = d.bootEnd, vt = d.vt, tableLen = d.entries * 4;
    // Show from the slot start to past the table, at least 3 alignment steps.
    const span = Math.max(d.align * 3, d.hdr + tableLen + d.align, 256);
    const L = 8, R = 8;
    const X = (off) => L + ((off - start) / span) * (W - L - R);
    const yB = 34, hB = 22;
    // Alignment grid: every multiple of align from the slot start's aligned floor.
    const first = Math.ceil(start / d.align) * d.align;
    for (let a = first; a <= start + span; a += d.align) {
      const x = X(a);
      lensSvg.append(s('line', { x1: x, x2: x, y1: yB - 8, y2: yB + hB + 8, stroke: 'var(--line)', 'stroke-dasharray': '3 2' }));
    }
    lensSvg.append(s('text', { x: X(first) + 3, y: yB - 10, class: '' }, `every ${d.align} B = VTOR alignment`));
    // Header block, then the vector table.
    if (d.hdr > 0) {
      lensSvg.append(s('rect', { x: X(start), y: yB, width: Math.max(1, X(start + d.hdr) - X(start)), height: hB, fill: 'var(--tool-slota)', 'fill-opacity': 0.9 }));
      if (X(start + d.hdr) - X(start) > 44) lensSvg.append(s('text', { x: (X(start) + X(start + d.hdr)) / 2, y: yB + 15, 'text-anchor': 'middle', style: 'fill:var(--accent-ink)' }, 'header'));
    }
    const col = d.vtOk ? 'var(--ok)' : 'var(--danger)';
    lensSvg.append(s('rect', { x: X(vt), y: yB, width: Math.max(2, X(vt + tableLen) - X(vt)), height: hB, fill: 'var(--tool-slota)', 'fill-opacity': 0.35, stroke: col, 'stroke-width': 1.5 }));
    if (X(vt + tableLen) - X(vt) > 70) lensSvg.append(s('text', { x: (X(vt) + X(vt + tableLen)) / 2, y: yB + 15, 'text-anchor': 'middle', class: 'ink' }, `${d.entries} vectors`));
    lensSvg.append(s('path', { d: `M${X(vt)},${yB + hB + 2}l-5,8h10z`, fill: col }));
    const t = `${hex(d.base + vt)} ${d.vtOk ? 'aligned' : `not ${d.align}-aligned`}`;
    const tx = Math.min(W - R, Math.max(L, X(vt) - 6));
    lensSvg.append(s('text', { x: tx, y: yB + hB + 22, 'text-anchor': X(vt) > W * 0.6 ? 'end' : 'start', style: `fill:${col}` }, t));
    lensSvg.append(s('text', { x: L, y: 12, class: 'ink' }, `slot start ${hex(d.base + start)}`));
    lensSub.textContent = `${d.entries} entries → ${d.align}-byte aligned`;
  }

  function syncInputs() {
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(inputs)) if (document.activeElement !== el) el.value = raw[k] ?? '';
    if (document.activeElement !== marginIn) marginIn.value = raw.margin ?? '';
    const bad = (k) => { const t = String(raw[k] ?? '').trim(); return t !== '' && ctx.parseEng(t) == null; };
    marginIn.classList.toggle('bad', bad('margin'));
    inputs.vectors.classList.toggle('bad', bad('vectors'));
  }

  function draw() {
    withFocus(drawMap);
    drawRail();
  }
  ctx.onResult((r) => { res = r; syncInputs(); draw(); });
  let lastW = 0, lastH = 0;
  new ResizeObserver(() => {
    const w = body.clientWidth, hh = window.innerHeight;
    if (w !== lastW || hh !== lastH) { lastW = w; lastH = hh; if (!draggingKey) draw(); }
  }).observe(body);
}
