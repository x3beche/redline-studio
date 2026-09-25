// Flash Partition Planner, custom page: the flash chip's address space.
//
// A tall memory map, address 0 at the top: bootloader, partition table, the
// data partitions, the app slots, core dump, filesystem, the unused rest and
// (if it does not fit) the overflow past the end of the chip. Small
// partitions get a readable minimum height; a true-to-scale strip at the left
// edge, joined to the map by zoom lines, keeps the proportions honest.
//
// You resize by dragging edges on the map: the NVS end, the app slot end
// (headroom), the image line inside ota_0 / factory (image size) and the
// filesystem end. Each handle takes arrow keys too. The chip, the flash size,
// the slot scheme and the filesystem type sit on the map's header; the
// optional partitions toggle in the table beside it.
// Offsets, sizes, fill and free space all come from run()'s result.map.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
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
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const KB = 1024, MB = 1024 * 1024;
const hex = (v) => '0x' + v.toString(16);
const hex6 = (v) => '0x' + v.toString(16).padStart(6, '0');
const size = (v) => (v >= MB && v % (64 * KB) === 0 ? `${+(v / MB).toFixed(3)} MiB` : v % KB === 0 ? `${v / KB} KiB` : `${(v / KB).toFixed(1)} KiB`);
const OPTIONAL = [['phy', 'phy_init', '4 KiB', 'RF calibration data'], ['nvsKeys', 'nvs_keys', '4 KiB', 'keys for NVS encryption'], ['coredump', 'coredump', '64 KiB', 'crash dump written to flash']];

export function page(root, ctx) {
  const st = { hover: null, w: 700 };

  // ------------------------------------------------------------ map header: the chip
  const seg = (key, opts, label) => {
    const btns = opts.map(([v, t, tip]) => h('button', { class: 'fp-seg', 'data-v': v, title: tip || null, 'aria-pressed': 'false', onclick: () => ctx.set(key, v) }, t));
    const grp = h('div', { class: 'fp-segs', role: 'group', 'aria-label': label }, btns);
    return { grp, sync: (val) => { for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.v === String(val))); } };
  };
  const chipSel = h('select', { class: 'fp-sel', 'aria-label': 'Chip', onchange: (e) => ctx.set('chip', e.target.value) },
    (ctx.manifest.inputs.find((d) => d.key === 'chip').options).map(([v, t]) => h('option', { value: v }, t)));
  const flashSeg = seg('flash', [['2', '2 MB'], ['4', '4 MB'], ['8', '8 MB'], ['16', '16 MB'], ['32', '32 MB']], 'Flash size');
  const otaSeg = seg('ota', [['ota2nf', 'ota_0 + ota_1', 'two OTA slots, no factory app'], ['ota2', 'factory + 2 OTA', 'factory app plus two OTA slots'], ['ota3', '3 OTA', 'three OTA slots'], ['factory', 'factory only', 'no OTA']], 'App slots');
  const fsSeg = seg('fs', [['littlefs', 'LittleFS'], ['spiffs', 'SPIFFS'], ['fat', 'FAT'], ['none', 'none']], 'Filesystem');
  const modeSeg = seg('appMode', [['image', 'image + headroom', 'slots sized from the image plus headroom'], ['max', 'as large as possible', 'slots split whatever the filesystem leaves']], 'App slot size');
  const head = h('div', { class: 'fp-mhead' },
    h('div', { class: 'fp-hrow' }, h('span', { class: 'fp-h' }, 'Flash'), chipSel, flashSeg.grp, h('span', { class: 'fp-grow' }), h('span', { class: 'fp-sum', 'data-k': 'sum' })),
    h('div', { class: 'fp-hrow' }, h('span', { class: 'fp-lab' }, 'app slots'), otaSeg.grp, h('span', { class: 'fp-lab' }, 'sized'), modeSeg.grp, h('span', { class: 'fp-lab' }, 'filesystem'), fsSeg.grp));
  const warns = h('div', { class: 'fp-warns', 'aria-live': 'polite' });
  const mapWrap = h('div', { class: 'fp-mapwrap' });
  const mapPanel = h('section', { class: 'fp-panel fp-map' }, head, warns, mapWrap,
    h('div', { class: 'fp-hint' }, 'Drag the handles on the map: the end of nvs, the image line and the end of the first app slot, the end of the filesystem. Focus a handle and use ↑ ↓ (Shift for bigger steps).'));

  // ------------------------------------------------------------ side: the table
  const list = h('div', { class: 'fp-list', role: 'list' });
  const optRow = h('div', { class: 'fp-opts' });
  const tableHead = h('div', { class: 'fp-lrow fp-lhead' }, h('span', {}, ''), h('span', {}, 'name'), h('span', {}, 'type / subtype'), h('span', { class: 'fp-r' }, 'offset'), h('span', { class: 'fp-r' }, 'size'));
  const ptIn = h('input', { class: 'fp-num', type: 'text', spellcheck: 'false', 'aria-label': 'Partition table offset', oninput: (e) => ctx.set('ptOffset', e.target.value) });
  const side = h('section', { class: 'fp-panel fp-side' },
    h('div', { class: 'fp-hrow' }, h('span', { class: 'fp-h' }, 'Partition table'), h('span', { class: 'fp-grow' }), h('label', { class: 'fp-lab' }, 'at ', ptIn)),
    tableHead, list,
    h('div', { class: 'fp-h fp-mt' }, 'Optional partitions'), optRow,
    h('details', { class: 'fp-all' }, h('summary', {}, 'All inputs as numbers'), ctx.form));
  const notes = h('div', { class: 'fp-notes' });
  root.append(h('div', { class: 'fp-page' }, mapPanel, h('div', { class: 'fp-col' }, side, ctx.outputs), notes));

  // ------------------------------------------------------------ result in
  let M = null;
  ctx.onResult((res) => {
    const raw = ctx.raw;
    M = res.map || null;
    chipSel.value = raw.chip; flashSeg.sync(raw.flash); otaSeg.sync(raw.ota); fsSeg.sync(raw.fs); modeSeg.sync(raw.appMode);
    if (document.activeElement !== ptIn) ptIn.value = raw.ptOffset ?? '';
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    optRow.replaceChildren(...OPTIONAL.map(([key, name, sz, what]) => h('label', { class: 'fp-opt', title: what },
      h('input', { type: 'checkbox', checked: !!raw[key], onchange: (e) => ctx.set(key, e.target.checked) }), h('b', {}, name), h('span', {}, ` ${sz}`))));
    mapPanel.classList.toggle('fp-stale', !M);
    drawMap(); drawList();
  });
  new ResizeObserver(() => {
    const w = Math.floor(mapWrap.clientWidth);
    if (M && w && Math.abs(w - st.w) > 1) drawMap();
  }).observe(mapWrap);

  // ------------------------------------------------------------ segments with display heights
  function segments() {
    const parts = [...M.parts].sort((a, b) => a.offset - b.offset);
    const segs = [];
    let at = 0;
    for (const p of parts) {
      if (p.offset > at) segs.push({ kind: 'gap', offset: at, size: p.offset - at });
      segs.push({ ...p });
      at = p.offset + p.size;
    }
    if (at < M.flash) segs.push({ kind: 'free', offset: at, size: M.flash - at });
    return segs;
  }
  function layout(segs, H) {
    const minH = (s) => (s.kind === 'gap' ? 7 : s.kind === 'free' ? 34 : s.kind === 'app' ? 44 : 23);
    let clamped = new Set();
    let k = 0;
    for (let it = 0; it < 8; it++) {
      const fixed = segs.filter((s) => clamped.has(s)).reduce((a, s) => a + minH(s), 0);
      const bytes = segs.filter((s) => !clamped.has(s)).reduce((a, s) => a + s.size, 0);
      k = (H - fixed) / Math.max(1, bytes);
      const next = new Set(segs.filter((s) => s.size * k < minH(s)));
      if ([...next].every((s) => clamped.has(s)) && next.size === clamped.size) break;
      clamped = new Set([...clamped, ...next]);
    }
    let y = 0;
    for (const s of segs) { s.h = clamped.has(s) ? minH(s) : s.size * k; s.y = y; y += s.h; s.ppb = s.h / s.size; }
    return k;
  }

  // ------------------------------------------------------------ the map
  function drawMap() {
    mapWrap.replaceChildren();
    if (!M) { mapWrap.append(h('div', { class: 'fp-empty' }, 'Fix the inputs above to draw the flash map.')); return; }
    const W = Math.max(300, Math.floor(mapWrap.clientWidth || 700));
    st.w = W;
    const narrow = W < 560;
    const top = 26, bottom = 30;
    const Hm = narrow ? 540 : Math.max(500, Math.min(680, window.innerHeight - 262));
    const segs = segments();
    layout(segs, Hm);
    const over = M.end > M.flash ? M.end - M.flash : 0;
    const Y = (s) => top + s.y;
    const sx = 6, sw = 12;                       // true-scale strip
    const ax = narrow ? 76 : 116;                // address labels end
    const bx = ax + 8;                           // blocks start
    const bw = Math.max(150, Math.min(narrow ? W - bx - 22 : 380, W - bx - (narrow ? 22 : 230)));
    const rx = bx + bw;                          // blocks end
    const svgH = top + Hm + bottom;
    const svg = sv('svg', { width: W, height: svgH, viewBox: `0 0 ${W} ${svgH}`, class: 'fp-svg', role: 'group', 'aria-label': `Flash map of ${size(M.flash)}` });
    const defs = sv('defs');
    const hatch = sv('pattern', { id: 'fp-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'fp-hatchl' }));
    const hatchR = sv('pattern', { id: 'fp-hatchr', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatchR.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'fp-hatchr' }));
    defs.append(hatch, hatchR);
    svg.append(defs);

    // true-scale strip and zoom lines
    const total = Math.max(M.flash, M.end);
    const TY = (addr) => top + (addr / total) * Hm;
    svg.append(sv('rect', { x: sx, y: top, width: sw, height: Hm, class: 'fp-strip' }));
    for (const s of segs) {
      if (s.kind === 'gap' || s.kind === 'free') continue;
      svg.append(sv('rect', { x: sx, y: TY(s.offset), width: sw, height: Math.max(0.6, TY(s.offset + s.size) - TY(s.offset)), class: `fp-k-${s.kind} fp-sfill` }));
    }
    if (over) svg.append(sv('rect', { x: sx, y: TY(M.flash), width: sw, height: TY(M.end) - TY(M.flash), fill: 'url(#fp-hatchr)', class: 'fp-overs' }));
    const zx0 = sx + sw + 1, zx1 = ax - 58 > zx0 + 10 ? ax - 58 : zx0 + 10;
    for (const s of segs) {
      if (s.kind === 'gap') continue;
      svg.append(sv('path', { d: `M${zx0},${TY(s.offset)}L${zx1},${Y(s)}L${zx1},${Y(s) + s.h}L${zx0},${TY(s.offset + s.size)}Z`, class: `fp-zoom fp-k-${s.kind}` }));
    }
    for (let m = 0; m <= total / MB + 0.001; m += total > 8 * MB ? 4 : 1) {
      svg.append(sv('text', { x: sx + sw / 2, y: m === 0 ? top - 8 : TY(m * MB) + 3, 'text-anchor': 'middle', class: 'fp-mb' }, m === 0 ? '0' : ''));
    }
    svg.append(sv('text', { x: sx, y: svgH - 8, class: 'fp-mb' }, `${Math.round(M.flash / MB)} MB, to scale`));

    // blocks
    const firstApp = segs.find((s) => s.kind === 'app');
    for (const s of segs) {
      const y = Y(s);
      const g = sv('g', { class: `fp-seg-${s.kind}${st.hover === s.name ? ' fp-hot' : ''}`, 'data-name': s.name || '' });
      if (s.kind === 'gap') {
        g.append(sv('rect', { x: bx, y, width: bw, height: s.h, fill: 'url(#fp-hatch)', class: 'fp-gap' }));
        const what = s.offset === 0 ? 'before the bootloader' : 'alignment gap';
        if (!narrow && s.h >= 7 && s.size >= 4 * KB) g.append(sv('text', { x: rx + 6, y: y + s.h / 2 + 3.5, class: 'fp-gapt' }, `${size(s.size)} ${what}`));
        g.append(sv('title', {}, `${size(s.size)} unused at ${hex(s.offset)} (${what})`));
        svg.append(g); continue;
      }
      if (s.kind === 'free') {
        g.append(sv('rect', { x: bx + 0.5, y: y + 0.5, width: bw - 1, height: s.h - 1, class: 'fp-free' }));
        g.append(sv('text', { x: bx + bw / 2, y: y + s.h / 2 + 4, 'text-anchor': 'middle', class: 'fp-freet' }, `unused ${size(s.size)}`));
        svg.append(g); continue;
      }
      g.append(sv('rect', { x: bx, y, width: bw, height: s.h, class: `fp-blk fp-k-${s.kind}` }));
      // app slots: the image inside
      if (s.kind === 'app' && M.image) {
        const f = Math.min(1, M.image / s.size);
        const ih = s.h * f;
        g.append(sv('rect', { x: bx + 3, y: y + 2, width: bw - 6, height: Math.max(0, ih - 2), class: `fp-img${M.fill > 1 ? ' fp-img-bad' : M.fill > 0.9 ? ' fp-img-warn' : ''}${s === firstApp ? '' : ' fp-img-other'}` }));
      }
      const big = s.h >= 34;
      const ty = big ? y + 17 : y + s.h / 2 + 4.5;
      const room = Math.floor((bw - 18 - size(s.size).length * 7.6 - 10) / 7.8);
      g.append(sv('text', { x: bx + 9, y: ty, class: 'fp-name' }, s.name.length > room ? s.name.slice(0, Math.max(3, room - 1)) + '…' : s.name));
      if (s.type && (big || bw > 300)) g.append(sv('text', { x: bx + (big ? 9 : 16 + s.name.length * 7.4), y: big ? ty + 15 : ty, class: 'fp-type' }, `${s.type}/${s.sub}${s.flags ? ', ' + s.flags : ''}`));
      g.append(sv('text', { x: rx - 9, y: ty, 'text-anchor': 'end', class: 'fp-size' }, size(s.size)));
      if (s.kind === 'app' && big && M.image) {
        const pct = Math.round(M.fill * 100);
        g.append(sv('text', { x: rx - 9, y: ty + (bw < 260 ? 30 : 15), 'text-anchor': 'end', class: `fp-fillt${M.fill > 1 ? ' fp-bad' : M.fill > 0.9 ? ' fp-warn' : ''}` },
          M.fill > 1 ? `image does not fit (${pct} %)` : `image fills ${pct} %`));
      }
      g.append(sv('title', {}, `${s.name}: ${hex(s.offset)} … ${hex(s.offset + s.size)}, ${size(s.size)}${s.type ? ` (${s.type}/${s.sub})` : ''}`));
      svg.append(g);
    }
    // address labels at every boundary
    let lastY = -99;
    for (const s of segs) {
      const y = Y(s);
      svg.append(sv('line', { x1: ax - 2, x2: bx, y1: y, y2: y, class: 'fp-tickl' }));
      if (y - lastY >= 11) { svg.append(sv('text', { x: ax - 4, y: y + 4, 'text-anchor': 'end', class: 'fp-addr' }, hex6(s.offset))); lastY = y; }
    }
    const endY = top + Hm;
    svg.append(sv('text', { x: ax - 4, y: Math.max(endY + 4, lastY + 11), 'text-anchor': 'end', class: 'fp-addr' }, hex6(Math.max(M.flash, M.end))));

    // end of the chip, and overflow past it
    if (over) {
      const s = segs.find((x) => x.offset < M.flash && x.offset + x.size > M.flash) || segs[segs.length - 1];
      const yEnd = Y(s) + (M.flash - s.offset) * s.ppb;
      svg.append(sv('rect', { x: bx, y: yEnd, width: bw, height: endY - yEnd, fill: 'url(#fp-hatchr)', class: 'fp-over' }));
      svg.append(sv('line', { x1: ax - 2, x2: rx + 6, y1: yEnd, y2: yEnd, class: 'fp-endl' }));
      const ex = narrow ? rx - 6 : rx + 8, ea = narrow ? 'end' : 'start';
      svg.append(sv('text', { x: ex, y: narrow ? yEnd - 6 : yEnd + 4, 'text-anchor': ea, class: 'fp-bad fp-endt' }, `flash ends ${hex(M.flash)}`));
      svg.append(sv('text', { x: ex, y: narrow ? yEnd + 15 : yEnd + 19, 'text-anchor': ea, class: 'fp-bad fp-endt' }, `${size(over)} too much`));
    } else {
      svg.append(sv('line', { x1: ax - 2, x2: rx, y1: endY, y2: endY, class: 'fp-endok' }));
    }

    // ------------------------------------------------------------ handles
    const R = ctx.raw;
    const handle = (name, y, label, onDrag, onKey, x = rx, ldy = 0) => {
      const g = sv('g', { class: 'fp-hdl', tabindex: '0', role: 'slider', 'aria-label': label, 'data-h': name });
      const lw = Math.min(narrow ? 0 : 200, W - x - 14);
      g.append(sv('line', { x1: bx, x2: x + 4, y1: y, y2: y, class: 'fp-hline' }),
        sv('rect', { x: x - 11, y: y - 6, width: 22, height: 12, rx: 3, class: 'fp-hknob' }),
        sv('path', { d: `M${x - 4},${y - 2}l4,-3l4,3M${x - 4},${y + 2}l4,3l4,-3`, class: 'fp-harr' }),
        sv('rect', { x: bx, y: y - 7, width: x - bx + 14, height: 14, class: 'fp-hhit' }));
      if (lw > 40) g.append(sv('text', { x: x + 16, y: y + 4 + ldy, class: `fp-hlab${name === 'img' && M.fill > 1 ? ' fp-bad' : ''}` }, label));
      g.append(sv('title', {}, `${label}: drag, or focus and use the arrow keys`));
      svg.append(g);
      dragY(g, onDrag);
      g.addEventListener('keydown', (e) => {
        const d = { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (d == null) return;
        e.preventDefault();
        onKey(d * (e.shiftKey ? 4 : 1));
        requestAnimationFrame(() => mapWrap.querySelector(`[data-h="${name}"]`)?.focus());
      });
    };
    const nvsSeg = segs.find((s) => s.name === 'nvs');
    if (nvsSeg) {
      handle('nvs', Y(nvsSeg) + nvsSeg.h, `nvs ${size(nvsSeg.size)}`,
        (dy, s0) => ctx.set('nvs', String(Math.max(12, Math.round((s0.nvs + dy / s0.ppb / KB) / 4) * 4))),
        (d) => ctx.set('nvs', String(Math.max(12, Math.round(nvsSeg.size / KB) + d * 4))));
      starts.nvs = () => ({ nvs: nvsSeg.size / KB, ppb: nvsSeg.ppb });
    }
    if (firstApp) {
      const slotY = Y(firstApp) + firstApp.h;
      // an image bigger than its slot hangs out of the bottom, hatched red
      const hang = M.image > firstApp.size ? Math.max(10, Math.min(70, (M.image - firstApp.size) * firstApp.ppb)) : 0;
      const imgY = hang ? slotY + hang : Y(firstApp) + firstApp.h * (M.image / firstApp.size);
      if (hang) svg.append(sv('rect', { x: bx + 3, y: slotY, width: bw - 32, height: hang, fill: 'url(#fp-hatchr)', class: 'fp-hang' }));
      const close = Math.abs(imgY - slotY) < 16;
      handle('img', imgY, `image ${size(M.image)}${hang ? ' does not fit' : ''}`,
        (dy, s0) => ctx.set('image', String(Math.max(16, Math.round(s0.image + dy / s0.ppb / KB)))),
        (d) => ctx.set('image', String(Math.max(16, Math.round(M.image / KB) + d * 16))), rx - 26, close ? (imgY > slotY ? 9 : -9) : 0);
      starts.img = () => ({ image: M.image / KB, ppb: firstApp.ppb });
      handle('slot', Y(firstApp) + firstApp.h, `slot ${size(M.appSize)}${R.appMode === 'max' ? ' (max)' : ` · +${M.headroom} %`}`,
        (dy, s0) => setSlot(s0.slot + dy / s0.ppb),
        (d) => setSlot(M.appSize + d * 64 * KB), rx, close ? (imgY > slotY ? -8 : 8) : 0);
      starts.slot = () => ({ slot: M.appSize, ppb: firstApp.ppb });
    }
    const fsSeg = M.fs && segs.find((s) => s.kind === 'fs');
    if (fsSeg) {
      handle('fs', Y(fsSeg) + fsSeg.h, `${fsSeg.name} ${size(fsSeg.size)}${M.fs.rest ? ' (the rest)' : ''}`,
        (dy, s0) => ctx.set('fsSize', String(Math.max(4, Math.round((s0.fs + dy / s0.ppb / KB) / 4) * 4))),
        (d) => ctx.set('fsSize', String(Math.max(4, Math.round(fsSeg.size / KB) + d * 64))));
      starts.fs = () => ({ fs: fsSeg.size / KB, ppb: fsSeg.ppb });
      if (!M.fs.rest && R.appMode !== 'max') {
        const b = sv('g', { class: 'fp-rest', tabindex: '0', role: 'button' });
        const y = Y(fsSeg) + Math.min(fsSeg.h - 6, 36);
        b.append(sv('rect', { x: bx + 8, y: y - 12, width: 118, height: 18, rx: 3 }), sv('text', { x: bx + 67, y: y + 1, 'text-anchor': 'middle' }, 'take the rest'));
        const go = () => ctx.set('fsSize', '0');
        b.addEventListener('click', go);
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        if (fsSeg.h > 44) svg.append(b);
      }
    }

    // hover joins map and table
    svg.addEventListener('pointerover', (e) => { const n = e.target.closest('[data-name]')?.dataset.name; if (n) hover(n); });
    svg.addEventListener('pointerleave', () => hover(null));
    mapWrap.append(svg);

    const sum = head.querySelector('[data-k="sum"]');
    sum.replaceChildren(h('span', {}, `ends ${hex(M.end)}`), ' · ',
      M.free >= 0 ? h('span', {}, `${size(M.free)} unused`) : h('b', { class: 'fp-bad' }, `${size(-M.free)} over`),
      M.gaps ? h('span', { class: 'fp-soft' }, ` + ${size(M.gaps)} in gaps`) : null);
  }
  const starts = {};
  function setSlot(bytes) {
    // a slot of this size (64 KiB steps) from the image: the headroom that rounds up to it
    const slot = Math.max(64 * KB, Math.round(bytes / (64 * KB)) * 64 * KB);
    const hr = Math.max(0, Math.floor((slot / M.image - 1) * 1000) / 10);
    ctx.setMany({ appMode: 'image', headroom: String(hr) });
  }
  function dragY(el, fn) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const name = el.dataset.h;
      const y0 = e.clientY, s0 = starts[name] ? starts[name]() : {};
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      el.classList.add('fp-dragging');
      el.focus();
      const move = (ev) => fn(ev.clientY - y0, s0);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
  function hover(name) {
    if (st.hover === name) return;
    st.hover = name;
    for (const el of root.querySelectorAll('[data-name]')) el.classList.toggle('fp-hot', !!name && el.dataset.name === name);
  }

  // ------------------------------------------------------------ the table
  function drawList() {
    list.replaceChildren();
    if (!M) return;
    for (const p of [...M.parts].sort((a, b) => a.offset - b.offset)) {
      const row = h('div', { class: `fp-lrow${st.hover === p.name ? ' fp-hot' : ''}`, role: 'listitem', 'data-name': p.name,
        onpointerenter: () => hover(p.name), onpointerleave: () => hover(null) },
      h('i', { class: `fp-sw fp-k-${p.kind}` }),
      h('b', {}, p.kind === 'boot' ? `(${p.name})` : p.name),
      h('span', { class: 'fp-soft' }, p.type ? `${p.type}/${p.sub}${p.flags ? ' · ' + p.flags : ''}` : ''),
      h('span', { class: 'fp-mono fp-r' }, hex(p.offset)),
      h('span', { class: 'fp-mono fp-r' }, size(p.size)));
      if (p.gap >= 4 * KB) list.append(h('div', { class: 'fp-lgap' }, `${size(p.gap)} alignment gap`));
      list.append(row);
    }
    if (M.free > 0) list.append(h('div', { class: 'fp-lrow fp-lfree' }, h('i', { class: 'fp-sw fp-sw-free' }), h('span', {}, 'unused'), h('span', {}, ''), h('span', { class: 'fp-mono fp-r' }, hex(M.end)), h('span', { class: 'fp-mono fp-r' }, size(M.free))));
    if (M.free < 0) list.append(h('div', { class: 'fp-lrow fp-lover' }, h('i', { class: 'fp-sw fp-sw-over' }), h('b', {}, 'past the end'), h('span', {}, ''), h('span', { class: 'fp-mono fp-r' }, hex(M.flash)), h('span', { class: 'fp-mono fp-r' }, size(-M.free))));
  }
}
