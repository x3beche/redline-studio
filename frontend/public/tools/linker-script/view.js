// Linker Script Helper, drawn as the thing itself: the part's memory map.
// Every region is a column (low address at the bottom, as datasheets draw
// it): the code region with the vector table, code, constants and the load
// image of .data; the data region with .data, .bss, the heap growing up and
// the stack growing down from _estack, both to scale; the other regions with
// the extra sections placed in them. Arrows show what start-up copies from
// flash to RAM.
//   Drag the stack's lower edge or the heap's upper edge to size them, drag a
//   column's top edge to change the region's length, drag an extra section
//   to another region; click a column head or a section to edit it below.
// The script itself sits beside the map (the output panel). Every address,
// size and share drawn comes from run()'s result.map.

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
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

const KINDS = {
  init: { label: 'init', tip: 'copied from flash at start-up (initialised variables)', color: 'var(--tool-data)' },
  zero: { label: 'zero', tip: 'zeroed at start-up (like .bss)', color: 'var(--tool-bss)' },
  noload: { label: 'noload', tip: 'left alone: survives a reset (crash log, boot flags)', color: 'var(--tool-noload)' },
  rom: { label: 'rom', tip: 'constant data kept in that region', color: 'var(--tool-rom)' },
};
const WHAT = {
  vectors: { color: 'var(--tool-code)', tag: 'vectors' },
  code: { color: 'var(--tool-code)', tag: 'code' },
  const: { color: 'var(--tool-code)', tag: 'const' },
  cpp: { color: 'var(--tool-code)', tag: 'C++' },
  image: { color: 'var(--tool-data)', tag: 'load image' },
  data: { color: 'var(--tool-data)', tag: 'copied' },
  bss: { color: 'var(--tool-bss)', tag: 'zeroed' },
};
const hexs = (v) => '0x' + Math.round(v).toString(16).toUpperCase();
const kb = (b) => (b >= 1024 ? `${Number((b / 1024).toFixed(b % 1024 ? 2 : 0))} KiB` : `${b} B`);
const lenText = (b) => (b % 1048576 === 0 ? `${b / 1048576}M` : b % 1024 === 0 ? `${b / 1024}K` : hexs(b));

export function page(root, ctx) {
  const wrap = h('div', { class: 'lds' });
  root.append(wrap);

  // ---------- toolbar ----------
  const fields = {};
  const text = (key, label, cls) => {
    const el = h('input', { type: 'text', spellcheck: 'false', class: cls || null, oninput: (e) => ctx.set(key, e.target.value) });
    fields[key] = el;
    return h('label', {}, label, el);
  };
  const cppBox = h('input', { type: 'checkbox', onchange: (e) => ctx.set('cpp', e.target.checked) });
  const addRegion = h('button', { class: 'k-btn', onclick: () => {
    const rows = ctx.raw.regions.map((r) => ({ ...r }));
    const m = res && res.map;
    const top = m ? Math.max(...m.regions.map((r) => r.end)) : 0x20000000;
    const origin = Math.ceil(top / 0x10000) * 0x10000;
    rows.push({ name: `REGION${rows.length}`, attr: 'rw', origin: '0x' + origin.toString(16).toUpperCase().padStart(8, '0'), length: '4K' });
    selected = { type: 'region', row: rows.length - 1 };
    ctx.set('regions', rows);
  } }, '+ Region');
  const addSection = h('button', { class: 'k-btn', onclick: () => {
    const rows = (ctx.raw.extra || []).map((r) => ({ ...r }));
    const m = res && res.map;
    const other = m && (m.regions.find((r) => r.role === 'other') || m.regions.find((r) => r.role === 'data'));
    rows.push({ name: `.section${rows.length + 1}`, region: other ? other.name : ctx.raw.ram, kind: 'zero' });
    selected = { type: 'section', row: rows.length - 1 };
    ctx.set('extra', rows);
  } }, '+ Section');
  const bar = h('div', { class: 'lds-bar' },
    text('entry', 'Entry point', 'wide'), text('stack', 'Stack size'), text('heap', 'Heap size'),
    h('label', { class: 'chk', title: '.ARM.exidx, .preinit/.init/.fini_array' }, cppBox, 'C++ sections'),
    h('span', { class: 'lds-right' }, addRegion, addSection));

  // ---------- the map ----------
  const svg = s('svg', { class: 'lds-svg', role: 'group', 'aria-label': 'Memory map' });
  const mapSub = h('span', { class: 'lds-sub' });
  const mapCard = h('section', { class: 'lds-card' },
    h('div', { class: 'lds-head' }, h('h2', {}, 'Memory map'), mapSub), bar, svg,
    h('div', { class: 'lds-help' }, 'Drag the stack\'s lower edge or the heap\'s upper edge, a column\'s top edge (region length), or an extra section onto another region. Click a region head or a section to edit it. Focused handles: ',
      h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' (', h('kbd', {}, 'Shift'), ' ×4); sections: ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' move, ', h('kbd', {}, 'Del'), ' remove.'));

  // ---------- editor ----------
  const edTitle = h('h2', {});
  const edSub = h('span', { class: 'lds-sub' });
  const ed = h('div', { class: 'lds-ed' });
  const edCard = h('section', { class: 'lds-card' }, h('div', { class: 'lds-head' }, edTitle, edSub), ed);

  const warns = h('div', { class: 'lds-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'lds-notes' }, h('summary', {}, 'Notes'));
  wrap.append(h('div', { class: 'lds-col' }, mapCard, edCard, notes), h('div', { class: 'lds-col' }, warns, ctx.outputs));

  let res = null, selected = null, frozen = null, resFrozen = null, dragging = false, focusId = null, dropCol = null;
  const M = () => res && res.map;

  const setRegion = (row, patch) => {
    const rows = ctx.raw.regions.map((r) => ({ ...r }));
    if (!rows[row]) return;
    Object.assign(rows[row], patch);
    ctx.set('regions', rows);
  };
  const setExtra = (row, patch) => {
    const rows = (ctx.raw.extra || []).map((r) => ({ ...r }));
    if (!rows[row]) return;
    Object.assign(rows[row], patch);
    ctx.set('extra', rows);
  };
  const drag = (move, done) => {
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragging = false;
      done && done(ev);
    };
    dragging = true;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const track = (el, id) => {
    el.setAttribute('data-id', id);
    const mark = () => { focusId = id; };
    el.addEventListener('focus', mark);
    el.addEventListener('keydown', mark, true);
    el.addEventListener('pointerdown', mark, true);
  };

  function drawMap() {
    const had = svg.contains(document.activeElement) || dragging;
    svg.replaceChildren();
    try { drawMapInner(); } finally {
      if (had && focusId) svg.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
    }
  }
  function drawMapInner() {
    const m = M();
    const W = Math.max(300, svg.clientWidth || mapCard.clientWidth || 800);
    if (!m) {
      svg.setAttribute('viewBox', `0 0 ${W} 60`); svg.setAttribute('height', 60);
      svg.append(s('text', { x: 12, y: 34, class: 'soft' }, 'Nothing to draw yet: see the messages on the right.'));
      mapSub.textContent = '';
      return;
    }
    const narrow = W < 560;
    // code region, data region, then the rest by address
    const cols = [...m.regions].sort((a, b) => rank(a) - rank(b) || a.origin - b.origin);
    const gap = narrow ? 16 : 54, pad = narrow ? 8 : 14;
    const minW = narrow ? 138 : 150, maxW = 230;
    const perRow = Math.max(1, Math.min(cols.length, Math.floor((W - 2 * pad + gap) / (minW + gap))));
    const cw = Math.min(maxW, (W - 2 * pad - gap * (perRow - 1)) / perRow);
    const rowsN = Math.ceil(cols.length / perRow);
    const headH = 62, footH = 40, CH = narrow ? 330 : 430;
    const rowH = headH + CH + footH + 16;
    const H = rowsN * rowH + 6;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    const used = perRow * cw + (perRow - 1) * gap;
    const left0 = Math.max(pad, (W - used) / 2);
    const bh = narrow ? 22 : 24;

    const geo = new Map();   // region name -> {x, top, bottom, bands: name -> {y, h}}
    const defs = s('defs');
    const hatch = (id, color, op) => {
      const p = s('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      p.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: color, 'stroke-width': 1.6, 'stroke-opacity': op }));
      defs.append(p);
    };
    hatch('lds-free', 'var(--line)', 0.9);
    hatch('lds-bad', 'var(--danger)', 0.55);
    const ah = s('marker', { id: 'lds-arr', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    ah.append(s('path', { d: 'M0,0L8,4L0,8z', fill: 'var(--tool-data)' }));
    defs.append(ah);
    svg.append(defs);
    const ptY = (ev) => { const r = svg.getBoundingClientRect(); return (ev.clientY - r.top) * (H / r.height); };
    const ptX = (ev) => { const r = svg.getBoundingClientRect(); return (ev.clientX - r.left) * (W / r.width); };

    cols.forEach((r, i) => {
      const rowI = Math.floor(i / perRow), colI = i % perRow;
      const x = left0 + colI * (cw + gap);
      const y0 = rowI * rowH + 6;
      const bottom = y0 + headH + CH;
      // the column's own scale; frozen while its top edge is dragged
      const bpp = frozen && frozen.region === r.name ? frozen.bpp : r.length / CH;
      const colH = Math.max(40, Math.min(CH + headH - 26, r.length / bpp));
      const top = bottom - colH;
      const g = { x, w: cw, top, bottom, bands: new Map(), region: r };
      geo.set(r.name, g);
      const bad = r.overlaps.length > 0;
      const isSel = selected && selected.type === 'region' && selected.row === r.row;

      // head: name, attributes, role (click to edit)
      const head = s('g', { class: 'sel', tabindex: 0, role: 'button', 'aria-pressed': String(!!isSel), 'aria-label': `Region ${r.name}: ${r.size} at ${r.originHex}` });
      track(head, `reg-${r.name}`);
      head.append(s('rect', { class: 'ring', x, y: y0, width: cw, height: 38, rx: 4, fill: isSel ? 'var(--accent)' : 'var(--sunken)', 'fill-opacity': isSel ? 0.14 : 1, stroke: isSel ? 'var(--accent)' : 'var(--line)' }));
      head.append(s('text', { x: x + 8, y: y0 + 16, class: 'big' }, r.name));
      head.append(s('text', { x: x + cw - 8, y: y0 + 16, 'text-anchor': 'end', class: `small${r.role === 'code' && !r.exec ? ' bad' : ' soft'}` }, `(${r.attr})`));
      const role = r.role === 'both' ? 'code + data' : r.role === 'code' ? 'code' : r.role === 'data' ? 'data + stack' : 'extra';
      head.append(s('text', { x: x + 8, y: y0 + 31, class: 'small soft' }, `${r.size} · ${role}`));
      head.addEventListener('click', () => { selected = { type: 'region', row: r.row }; drawMap(); drawEditor(); });
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected = { type: 'region', row: r.row }; drawMap(); drawEditor(); } });
      svg.append(head);

      // body
      const body = s('g', { 'data-col': r.name });
      body.append(s('rect', { class: 'ring', x, y: top, width: cw, height: colH, fill: 'url(#lds-free)', stroke: bad ? 'var(--danger)' : 'var(--line)', 'stroke-width': bad ? 2 : 1, 'stroke-dasharray': bad ? '5 3' : null }));
      svg.append(body);
      // addresses
      svg.append(s('text', { x: x + cw, y: top - 4, 'text-anchor': 'end', class: 'small soft' }, r.role === 'data' || r.role === 'both' ? '' : r.endHex));
      svg.append(s('text', { x, y: bottom + 13, class: `small${r.vtorBad ? ' bad' : ' soft'}` }, r.originHex));
      svg.append(s('text', { x: x + cw, y: bottom + 13, 'text-anchor': 'end', class: 'small soft' }, r.lengthText));

      // bands from the bottom, in link order (not to scale: sizes come from your code)
      let yb = bottom;
      const bandsFit = Math.max(0, Math.floor((colH - 8) / (bh + 2)));
      const holds = r.holds;
      holds.forEach((b, j) => {
        if (j >= bandsFit) return;
        const yy = yb - bh;
        const extra = b.what === 'extra';
        const kind = extra ? KINDS[b.kind] : null;
        const c = extra ? kind.color : WHAT[b.what].color;
        const image = b.what === 'image';
        const isSelSec = extra && selected && selected.type === 'section' && selected.row === b.row;
        const band = s('g', extra ? { class: 'chip', tabindex: 0, role: 'button', 'aria-label': `Section ${b.name}, ${b.kind}, in ${r.name}: drag to another region` } : {});
        band.append(s('rect', { class: 'ring', x: x + 3, y: yy, width: cw - 6, height: bh - 1, rx: 3,
          fill: image ? 'var(--surface)' : c, 'fill-opacity': image ? 1 : isSelSec ? 0.5 : 0.24, stroke: c, 'stroke-width': isSelSec ? 2 : 1.2, 'stroke-dasharray': image ? '4 3' : null }));
        const nm = b.name.length > (narrow ? 12 : 17) && cw < 190 ? b.name.slice(0, narrow ? 11 : 16) + '…' : b.name;
        band.append(s('text', { x: x + 9, y: yy + bh / 2 + 3.5 }, nm));
        const tag = extra ? (b.kind === 'init' && r.role !== 'code' ? 'init' : kind.label) : image ? `→ ${b.of}` : WHAT[b.what].tag;
        if (cw - 18 - nm.length * 6.6 > tag.length * 6 + 4) band.append(s('text', { x: x + cw - 9, y: yy + bh / 2 + 3.5, 'text-anchor': 'end', class: 'small soft' }, tag));
        band.append(s('title', {}, extra ? `${b.name}: ${kind.tip}. Drag to another region; click to edit.` : image ? `Initial values of ${b.name}, stored here and copied to ${b.of} at start-up (${b.symbol})` : `${b.name}${b.symbol ? ` (${b.symbol})` : ''}`));
        if (extra) {
          track(band, `sec-${b.row}`);
          sectionDrag(band, b, r, () => cols, geo, ptX, ptY);
        }
        svg.append(band);
        g.bands.set(`${b.what === 'image' ? 'img:' : ''}${b.name}`, { y: yy, h: bh - 1 });
        yb = yy - 2;
      });
      if (holds.length > bandsFit) svg.append(s('text', { x: x + cw / 2, y: yb - 4, 'text-anchor': 'middle', class: 'small soft' }, `+${holds.length - bandsFit} more`));
      g.bandsTop = yb;

      if (r.role === 'data' || r.role === 'both') drawStackHeap(g, r, m, ptY, bpp);
      else {
        // the free rest of the region
        const freeH = yb - top;
        if (freeH > 20) svg.append(s('text', { x: x + cw / 2, y: top + freeH / 2 + 4, 'text-anchor': 'middle', class: 'small soft' }, r.role === 'code' ? 'rest: code grows up' : 'free'));
      }
      if (bad) {
        svg.append(s('text', { x: x + cw / 2, y: bottom + 27, 'text-anchor': 'middle', class: 'small bad' }, `overlaps ${r.overlaps.join(', ')}`));
      } else if (r.vtorBad) {
        svg.append(s('text', { x: x + cw / 2, y: bottom + 27, 'text-anchor': 'middle', class: 'small bad' }, 'origin not 512-aligned (VTOR)'));
      } else if (r.role === 'code' && !r.exec) {
        svg.append(s('text', { x: x + cw / 2, y: bottom + 27, 'text-anchor': 'middle', class: 'small bad' }, 'not executable: add x'));
      }

      // top edge: the region's length
      const edge = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': `Length of ${r.name}`, 'aria-valuenow': r.length, 'aria-valuetext': r.size });
      track(edge, `len-${r.name}`);
      edge.append(s('rect', { class: 'ring', x: x + 10, y: top - 3, width: 32, height: 6, rx: 3, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 1.2 }));
      edge.append(s('rect', { x, y: top - 6, width: cw, height: 12, fill: 'transparent' }));
      edge.append(s('title', {}, `Drag: length of ${r.name} (now ${r.lengthText})`));
      const snapLen = (v) => { const q = v >= 256 * 1024 ? 16384 : v >= 16384 ? 1024 : 256; return Math.max(q, Math.round(v / q) * q); };
      const setLen = (v) => { const L = snapLen(v); if (L !== r.length) setRegion(r.row, { length: lenText(L) }); };
      edge.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        edge.focus({ preventScroll: true });
        const y0p = ptY(e), L0 = r.length, k = L0 / colH;
        frozen = { region: r.name, bpp: k };
        drag((ev) => setLen(L0 + (y0p - ptY(ev)) * k), () => { frozen = null; drawMap(); });
      });
      edge.addEventListener('keydown', (e) => {
        const st = (r.length >= 256 * 1024 ? 16384 : 1024) * (e.shiftKey ? 4 : 1);
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); setLen(r.length + st); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); setLen(Math.max(st, r.length - st)); }
      });
      svg.append(edge);
    });

    // what start-up copies: load image in the code region -> run address
    const code = geo.get(m.code);
    if (code) {
      for (const b of code.region.holds.filter((q) => q.what === 'image')) {
        const src = code.bands.get(`img:${b.name}`);
        const dst = geo.get(b.of);
        const dstBand = dst && dst.bands.get(b.name);
        if (!src || !dstBand || dst === code) continue;
        const sameRow = Math.abs(dst.bottom - code.bottom) < 1;
        const right = dst.x > code.x;
        const sx = right ? code.x + code.w - 3 : code.x + 3, sy = src.y + src.h / 2;
        const tx = right ? dst.x + 3 : dst.x + dst.w - 3, ty = dstBand.y + dstBand.h / 2;
        const dx = sameRow ? (tx - sx) / 2 : 40 * (right ? 1 : -1);
        svg.append(s('path', { d: `M${sx},${sy}C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`, fill: 'none', stroke: 'var(--tool-data)', 'stroke-width': 1.5, 'marker-end': 'url(#lds-arr)' }));
        if (!narrow && sameRow && Math.abs(tx - sx) > 60) {
          const mx = (sx + tx) / 2, my = (sy + ty) / 2;
          svg.append(s('text', { x: mx, y: my - 6, 'text-anchor': 'middle', class: 'small', style: 'fill:var(--tool-data)' }, 'copied'));
          svg.append(s('text', { x: mx, y: my + 12, 'text-anchor': 'middle', class: 'small soft' }, 'at reset'));
        }
      }
    }

    const tone = !m.fits ? 'bad' : m.share > 0.75 ? 'warn' : '';
    mapSub.replaceChildren('_estack ', h('b', { class: m.estackAligned ? '' : 'bad' }, '0x' + m.estack.toString(16).toUpperCase().padStart(8, '0')),
      ' · stack + heap ', h('b', { class: tone }, kb(m.reserve)), ` = ${Math.round(m.share * 100)} % of ${m.data}`,
      m.fits ? ` · ${kb(m.free)} left for .data and .bss` : '');
  }
  const rank = (r) => (r.role === 'code' || r.role === 'both' ? 0 : r.role === 'data' ? 1 : 2);

  // Heap up from the end of .bss, stack down from _estack, to the region's scale.
  function drawStackHeap(g, r, m, ptY, trueBpp) {
    const { x, w: cw, top } = g;
    const room0 = g.bandsTop - top;
    // A few KiB in a big RAM would be a hairline: zoom the stack and heap
    // (and break the free space between them) until they take up to ~45 %.
    let bpp = trueBpp;
    if (resFrozen) bpp = resFrozen;
    else if (m.fits && m.reserve > 0 && m.reserve / trueBpp < room0 * 0.45) bpp = Math.max(m.reserve / (room0 * 0.45), trueBpp / 40);
    const zoom = trueBpp / bpp;
    const px = (bytes) => bytes / bpp;
    const stH = Math.max(m.stack > 0 ? 6 : 0, px(m.stackBlock));
    const hpH = Math.max(m.heap > 0 ? 6 : 0, px(m.heapBlock));
    const base = g.bandsTop;
    const room = base - top;
    const over = !m.fits || stH + hpH > room;
    // stack
    const sY1 = top + Math.min(stH, room);
    svg.append(s('rect', { x: x + 3, y: top + 1, width: cw - 6, height: Math.max(0, sY1 - top - 1), fill: 'var(--tool-stack)', 'fill-opacity': 0.26, stroke: 'var(--tool-stack)', 'stroke-width': 1.2 }));
    // heap
    const hY0 = Math.max(top, base - hpH);
    svg.append(s('rect', { x: x + 3, y: hY0, width: cw - 6, height: Math.max(0, base - hY0), fill: 'var(--tool-heap)', 'fill-opacity': 0.26, stroke: 'var(--tool-heap)', 'stroke-width': 1.2 }));
    if (over) svg.append(s('rect', { x: x + 3, y: top + 1, width: cw - 6, height: Math.max(0, base - top - 1), fill: 'url(#lds-bad)' }));
    // labels
    const lab = (y, t1, cls, anchorMid) => svg.append(s('text', { x: x + cw / 2, y, 'text-anchor': 'middle', class: cls }, t1));
    if (sY1 - top > 30) { lab(top + (sY1 - top) / 2 - 2, `stack ${kb(m.stackBlock)}`, ''); lab(top + (sY1 - top) / 2 + 12, '↓ grows down', 'small soft'); }
    else lab(sY1 + 12, `stack ${kb(m.stackBlock)} ↓`, 'small');
    if (base - hY0 > 30) { lab(hY0 + (base - hY0) / 2 - 2, `heap ${kb(m.heapBlock)}`, ''); lab(hY0 + (base - hY0) / 2 + 12, '↑ grows up', 'small soft'); }
    else if (m.heap > 0) lab(hY0 - 5, `heap ${kb(m.heapBlock)} ↑`, 'small');
    else lab(base - 6, 'no heap', 'small soft');
    const freeMid = (sY1 + hY0) / 2;
    if (over) svg.append(s('text', { x: x + cw / 2, y: g.bottom + 27, 'text-anchor': 'middle', class: 'small bad' }, `stack + heap: ${kb(m.reserve)} > ${r.size}`));
    else if (hY0 - sY1 > 46) {
      if (zoom > 1.05) {
        // scale break across the free space
        const zy = freeMid - 26;
        const zig = (y) => { let d = `M${x + 3},${y}`; for (let i = 0, n = 8; i < n; i++) d += `L${x + 3 + ((i + 0.5) * (cw - 6)) / n},${y + (i % 2 ? 4 : -4)}`; return d + `L${x + cw - 3},${y}`; };
        svg.append(s('path', { d: zig(zy), fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 1.2 }));
        svg.append(s('path', { d: zig(zy + 6), fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 1.2 }));
        lab(zy - 10, cw < 190 ? `stack, heap ×${Math.round(zoom)}` : `scale break: stack, heap ×${Math.round(zoom)}`, 'small soft');
      }
      lab(freeMid + 8, `${kb(m.free)} free`, 'soft'); lab(freeMid + 22, 'for .data + .bss', 'small soft');
    }
    // _estack
    svg.append(s('text', { x: x + cw, y: top - 4, 'text-anchor': 'end', class: `small${m.estackAligned ? '' : ' bad'}` }, cw < 190 ? r.endHex : `_estack ${r.endHex}`));

    // handles: stack's lower edge, heap's upper edge
    const handle = (id, y, label, value, apply) => {
      const hg = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuenow': value, 'aria-valuetext': `${kb(value)} (${hexs(value)})` });
      track(hg, id);
      hg.append(s('line', { x1: x + 3, x2: x + cw - 3, y1: y, y2: y, stroke: 'var(--ink)', 'stroke-width': 1.4, 'stroke-dasharray': '6 3' }));
      hg.append(s('rect', { class: 'ring', x: x + cw - 30, y: y - 4, width: 22, height: 8, rx: 3, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 1.2 }));
      hg.append(s('rect', { x, y: y - 6, width: cw, height: 12, fill: 'transparent' }));
      hg.append(s('title', {}, `Drag: ${label.toLowerCase()} (now ${kb(value)}, ${hexs(value)})`));
      const snap = (v) => Math.max(0, Math.round(v / 256) * 256);
      const set = (v) => { const q = snap(v); if (q !== value) apply(q); };
      hg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        hg.focus({ preventScroll: true });
        const y0 = ptY(e), v0 = value;
        resFrozen = bpp;
        drag((ev) => set(v0 + (id === 'stack' ? 1 : -1) * (ptY(ev) - y0) * bpp), () => { resFrozen = null; drawMap(); });
      });
      hg.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 1024 : 256;
        const dir = id === 'stack' ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowUp: 1, ArrowDown: -1 };
        const k = dir[e.key] ?? (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
        if (!k) return;
        e.preventDefault();
        apply(Math.max(0, snap(value) + k * st));
      });
      svg.append(hg);
    };
    if (!over && sY1 - top > 14) svg.append(s('text', { x: x + 8, y: sY1 - 5, class: 'small soft' }, m.stackLimitHex));
    handle('stack', sY1, 'Stack size', m.stack, (v) => ctx.set('stack', hexs(v)));
    handle('heap', hY0, 'Heap size', m.heap, (v) => ctx.set('heap', hexs(v)));
  }

  // Extra sections move between regions by dragging (or ← → when focused).
  function sectionDrag(band, b, r, colsOf, geo, ptX, ptY) {
    const order = () => [...geo.values()].map((g) => g.region.name);
    const moveTo = (name) => { if (name && name !== r.name) setExtra(b.row, { region: name }); };
    band.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      band.focus({ preventScroll: true });
      const x0 = ptX(e), y0 = ptY(e);
      let ghost = null, moved = false, target = null;
      drag((ev) => {
        const dx = ptX(ev) - x0, dy = ptY(ev) - y0;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        moved = true;
        band.setAttribute('transform', `translate(${dx},${dy})`);
        band.style.opacity = '0.8';
        const px = ptX(ev), py = ptY(ev);
        target = null;
        for (const g of geo.values()) {
          const inside = px >= g.x && px <= g.x + g.w && py >= g.top - 60 && py <= g.bottom + 20;
          const body = svg.querySelector(`[data-col="${CSS.escape(g.region.name)}"]`);
          if (body) body.classList.toggle('drop', inside && g.region.name !== r.name);
          if (inside) target = g.region.name;
        }
        void ghost;
      }, () => {
        if (!moved) { selected = { type: 'section', row: b.row }; drawMap(); drawEditor(); return; }
        band.removeAttribute('transform');
        if (target && target !== r.name) { selected = { type: 'section', row: b.row }; moveTo(target); } else drawMap();
      });
    });
    band.addEventListener('keydown', (e) => {
      const o = order();
      const i = o.indexOf(r.name);
      if (e.key === 'ArrowRight') { e.preventDefault(); moveTo(o[Math.min(o.length - 1, i + 1)]); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); moveTo(o[Math.max(0, i - 1)]); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected = { type: 'section', row: b.row }; drawMap(); drawEditor(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const rows = (ctx.raw.extra || []).map((q) => ({ ...q })); rows.splice(b.row, 1); selected = null; focusId = null; ctx.set('extra', rows);
      }
    });
  }

  // ---------- editor: the selected region or section ----------
  let edKey = null;
  function drawEditor() {
    const m = M();
    const raw = ctx.raw;
    if (!selected || (selected.type === 'region' && !raw.regions[selected.row]) || (selected.type === 'section' && !(raw.extra || [])[selected.row])) {
      // default: the data region, the one with the most to decide
      const d = m && m.regions.find((r) => r.role === 'data' || r.role === 'both');
      selected = d ? { type: 'region', row: d.row } : raw.regions.length ? { type: 'region', row: 0 } : null;
    }
    if (!selected) { edTitle.textContent = 'Nothing selected'; edSub.textContent = ''; ed.replaceChildren(); edKey = null; return; }
    const key = `${selected.type}:${selected.row}`;
    const rebuild = key !== edKey;
    edKey = key;
    if (selected.type === 'region') {
      const row = raw.regions[selected.row];
      const reg = m && m.regions.find((r) => r.row === selected.row);
      edTitle.textContent = `Region ${row.name || '(unnamed)'}`;
      edSub.replaceChildren(reg ? h('span', {}, h('b', {}, reg.originHex), ' – ', h('b', {}, reg.endHex), ` · ${reg.size}`) : 'skipped: check the name, origin and length');
      if (rebuild) {
        const inp = (k, label) => h('label', {}, label, h('input', { type: 'text', spellcheck: 'false', 'data-k': k, oninput: (e) => {
          const old = ctx.raw.regions[selected.row][k];
          const patch = { [k]: e.target.value };
          const rows = ctx.raw.regions.map((q) => ({ ...q }));
          Object.assign(rows[selected.row], patch);
          // renaming keeps the region's roles and sections with it
          if (k === 'name') {
            const more = { regions: rows };
            if (String(ctx.raw.flash).trim().toUpperCase() === String(old).trim().toUpperCase()) more.flash = e.target.value;
            if (String(ctx.raw.ram).trim().toUpperCase() === String(old).trim().toUpperCase()) more.ram = e.target.value;
            const ex = (ctx.raw.extra || []).map((q) => (String(q.region).trim().toUpperCase() === String(old).trim().toUpperCase() ? { ...q, region: e.target.value } : q));
            more.extra = ex;
            ctx.setMany(more);
          } else ctx.set('regions', rows);
        } }));
        const attr = h('select', { 'data-k': 'attr', onchange: (e) => setRegion(selected.row, { attr: e.target.value }) },
          ['rx', 'rwx', 'xrw', 'rw', 'r'].map((a) => h('option', { value: a }, a)));
        ed.replaceChildren(inp('name', 'Name'), h('label', {}, 'Attributes', attr), inp('origin', 'Origin'), inp('length', 'Length'),
          h('div', { class: 'acts' },
            h('button', { class: 'k-btn', 'data-role': 'code', onclick: () => ctx.set('flash', ctx.raw.regions[selected.row].name) }, 'Code goes here'),
            h('button', { class: 'k-btn', 'data-role': 'data', onclick: () => ctx.set('ram', ctx.raw.regions[selected.row].name) }, 'Data + stack go here'),
            h('button', { class: 'k-btn push', style: 'color:var(--danger)', onclick: () => {
              const rows = ctx.raw.regions.map((q) => ({ ...q })); rows.splice(selected.row, 1); selected = null; ctx.set('regions', rows);
            } }, 'Remove region')),
          h('div', { class: 'note' }, 'Origin as 0x hex, length as 512K, 1M or 0x hex, from the datasheet memory map.'));
      }
      for (const el of ed.querySelectorAll('[data-k]')) {
        if (document.activeElement !== el) el.value = row[el.dataset.k] ?? '';
      }
      const upper = (v) => String(v ?? '').trim().toUpperCase();
      for (const b of ed.querySelectorAll('[data-role]')) {
        const on = b.dataset.role === 'code' ? (m ? m.code : raw.flash) : (m ? m.data : raw.ram);
        b.setAttribute('aria-pressed', String(upper(on) === upper(row.name)));
      }
    } else {
      const row = raw.extra[selected.row];
      edTitle.textContent = `Section ${row.name || '(unnamed)'}`;
      edSub.textContent = KINDS[row.kind] ? KINDS[row.kind].tip : '';
      if (rebuild) {
        const regSel = h('select', { 'data-k': 'region', onchange: (e) => setExtra(selected.row, { region: e.target.value }) });
        const kinds = h('div', { class: 'lds-kinds', role: 'group', 'aria-label': 'Kind' },
          Object.entries(KINDS).map(([k, v]) => h('button', { 'data-kind': k, title: v.tip, onclick: () => setExtra(selected.row, { kind: k }) }, v.label)));
        ed.replaceChildren(
          h('label', {}, 'Name', h('input', { type: 'text', spellcheck: 'false', 'data-k': 'name', oninput: (e) => setExtra(selected.row, { name: e.target.value }) })),
          h('label', {}, 'Region', regSel),
          h('label', { style: 'grid-column: span 2' }, 'Kind', kinds),
          h('div', { class: 'acts' }, h('button', { class: 'k-btn push', style: 'color:var(--danger)', onclick: () => {
            const rows = (ctx.raw.extra || []).map((q) => ({ ...q })); rows.splice(selected.row, 1); selected = null; ctx.set('extra', rows);
          } }, 'Remove section')),
          h('div', { class: 'note' }, 'Place a variable in it with __attribute__((section("', h('b', {}, row.name || '.name'), '"))). init and zero sections need the start-up C (output tab).'));
      }
      const regSel = ed.querySelector('select[data-k="region"]');
      const names = raw.regions.map((r) => r.name).filter(Boolean);
      if (!names.includes(row.region)) names.push(row.region);
      regSel.replaceChildren(...names.map((n) => h('option', { value: n }, n)));
      regSel.value = row.region;
      const nameIn = ed.querySelector('input[data-k="name"]');
      if (document.activeElement !== nameIn) nameIn.value = row.name ?? '';
      for (const b of ed.querySelectorAll('[data-kind]')) b.setAttribute('aria-pressed', String(b.dataset.kind === row.kind));
    }
  }

  function syncBar() {
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(fields)) if (document.activeElement !== el) el.value = raw[k] ?? '';
    const sizeOk = (t) => /^\s*(0x[0-9a-f]+|\d+\s*(|b|k|kb|kib|m|mb|mib))\s*$/i.test(String(t ?? ''));
    fields.stack.classList.toggle('bad', !sizeOk(raw.stack));
    fields.heap.classList.toggle('bad', !sizeOk(raw.heap));
    cppBox.checked = !!raw.cpp;
  }
  function drawSide() {
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }

  // The script is what this tool makes: show it first unless a tab was chosen.
  let firstTab = true;
  ctx.onResult((r) => {
    res = r; syncBar(); drawMap(); drawEditor(); drawSide();
    if (firstTab) {
      firstTab = false;
      let chosen = null;
      try { chosen = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { chosen = null; }
      if (!chosen) [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'Linker script')?.click();
    }
  });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = mapCard.clientWidth;
    if (w !== lastW) { lastW = w; drawMap(); }
  }).observe(mapCard);
}
