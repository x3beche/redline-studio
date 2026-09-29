// WIC Partition Layout, drawn as the thing itself: the storage device as a
// strip to scale, every partition where wic puts it. A zoom strip under it
// opens up the first megabytes, where the partition table and the raw
// bootloader live at their ROM offsets.
//   Drag a partition's right edge (or focus it and use the arrow keys) to
//   size it: that writes --fixed-size (or --size for an empty partition) into
//   the .wks. Click a partition to edit its line below. The .wks text beside
//   the drawing is the input itself - paste one and it is drawn.
// Every position and size comes from run()'s result.layout.

import { parseWks, writeWks, setOpt, opt, sizeArg, TEMPLATES } from './wks.js';

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
const human = (k) => (k >= 1048576 ? `${Number((k / 1048576).toFixed(2))} GiB` : k >= 1024 ? `${Number((k / 1024).toFixed(k % 1024 ? 1 : 0))} MiB` : `${Number(k.toFixed(1))} KiB`);
const COLOR = { rawcopy: 'var(--tool-raw)', 'bootimg-partition': 'var(--tool-boot)', 'bootimg-efi': 'var(--tool-boot)', 'bootimg-pcbios': 'var(--tool-boot)',
  rootfs: 'var(--tool-rootfs)', empty: 'var(--tool-data)', swap: 'var(--tool-swap)' };
const colorOf = (p) => COLOR[p.source] || 'var(--tool-other)';
const SOURCES = ['rootfs', 'bootimg-partition', 'bootimg-efi', 'bootimg-pcbios', 'rawcopy', '(none)'];
const FSTYPES = ['ext4', 'ext3', 'ext2', 'vfat', 'msdos', 'btrfs', 'squashfs', 'erofs', 'swap', 'none', '(default vfat)'];

export function page(root, ctx) {
  const wrap = h('div', { class: 'wic' });
  root.append(wrap);
  let res = null, sel = 0, dragging = false, focusId = null, frozenZoom = null;
  const L = () => res && res.layout;

  // ---------- toolbar ----------
  const tpl = h('select', { 'aria-label': 'Load a template', onchange: (e) => {
    const t = TEMPLATES.find((x) => x.id === e.target.value);
    if (t) { sel = 0; ctx.setMany({ wks: t.wks, ...(t.device ? { device: t.device } : {}), content: t.content.map((c) => ({ ...c })) }); }
    e.target.value = '';
  } }, h('option', { value: '' }, 'Load a board template…'), TEMPLATES.map((t) => h('option', { value: t.id }, t.title)));
  const devSel = h('select', { 'aria-label': 'Device', onchange: (e) => ctx.set('device', e.target.value) },
    ctx.manifest.inputs.find((d) => d.key === 'device').options.map(([v, t]) => h('option', { value: v }, t)));
  const diskIn = h('input', { type: 'text', spellcheck: 'false', class: 'short', 'aria-label': 'Device size', oninput: (e) => ctx.set('diskSize', e.target.value) });
  const diskLab = h('label', {}, 'Size', diskIn);
  const eraseIn = h('input', { type: 'text', spellcheck: 'false', class: 'short', oninput: (e) => ctx.set('erase', e.target.value) });
  const ptBtns = ['msdos', 'gpt'].map((pt) => h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => setPtable(pt) }, pt));
  const addBtn = h('button', { class: 'k-btn', type: 'button', onclick: addPart }, '+ Partition');
  const bar = h('div', { class: 'wic-bar' },
    h('label', {}, 'Template', tpl), h('label', {}, 'Device', devSel), diskLab,
    h('label', { title: 'eMMC erase group or SD allocation unit: partitions should start on it' }, 'Erase block', eraseIn),
    h('div', { class: 'wic-seg-l' }, h('span', {}, 'Table'), h('div', { class: 'wic-seg', role: 'group', 'aria-label': 'Partition table' }, ptBtns)),
    h('span', { class: 'wic-right' }, addBtn));

  // ---------- the device ----------
  const svg = s('svg', { class: 'wic-svg', role: 'group', 'aria-label': 'Device layout' });
  const devSub = h('span', { class: 'wic-sub' });
  const legend = h('div', { class: 'wic-legend' },
    [['var(--tool-raw)', 'raw bootloader'], ['var(--tool-boot)', 'boot'], ['var(--tool-rootfs)', 'rootfs'], ['var(--tool-data)', 'empty / data'], ['var(--tool-swap)', 'swap'], ['var(--line)', 'table / free']]
      .map(([c, t]) => h('span', {}, h('i', { style: `background:${c}` }), t)));
  const devCard = h('section', { class: 'wic-card' },
    h('div', { class: 'wic-head' }, h('h2', {}, 'Device'), devSub), bar, svg, legend,
    h('div', { class: 'wic-help' }, 'Drag a partition\'s right edge to size it (writes --fixed-size, or --size for an empty partition; snaps to the erase block). Click a partition to edit its line. Focused edge: ',
      h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' one erase block, ', h('kbd', {}, 'Shift'), ' ×8.'));

  // ---------- editor, estimator ----------
  const edTitle = h('h2', {}), edSub = h('span', { class: 'wic-sub' });
  const ed = h('div', { class: 'wic-ed' });
  const edCard = h('section', { class: 'wic-card' }, h('div', { class: 'wic-head' }, edTitle, edSub), ed);
  const estSvg = s('svg', { class: 'wic-svg', role: 'img', 'aria-label': 'Rootfs size calculation' });
  const estIns = h('div', { class: 'wic-est-in' });
  const estCard = h('section', { class: 'wic-card' },
    h('div', { class: 'wic-head' }, h('h2', {}, 'Rootfs size'), h('span', { class: 'wic-sub' }, 'image.bbclass ROOTFS_SIZE, then wic')), estIns, estSvg);
  const warns = h('div', { class: 'wic-warns', role: 'status', 'aria-live': 'polite' });
  const src = h('textarea', { class: 'wic-src', rows: 9, spellcheck: 'false', 'aria-label': '.wks kickstart', oninput: (e) => ctx.set('wks', e.target.value) });
  const srcCard = h('section', { class: 'wic-card' }, h('div', { class: 'wic-head' }, h('h2', {}, 'Kickstart (.wks)'), h('span', { class: 'wic-sub' }, 'the input - paste yours; drawing edits write here')), src);
  const contentTbl = h('div', { class: 'wic-content' });
  const contentCard = h('section', { class: 'wic-card' }, h('div', { class: 'wic-head' }, h('h2', {}, 'Content sizes'), h('span', { class: 'wic-sub' }, 'files wic copies: sized by what is in them')), contentTbl);
  const notes = h('details', { class: 'wic-notes' }, h('summary', {}, 'Notes'));
  wrap.append(devCard,
    h('div', { class: 'wic-cols' },
      h('div', { class: 'wic-col' }, edCard, estCard, contentCard),
      h('div', { class: 'wic-col' }, warns, srcCard, ctx.outputs, notes)));

  // ---------- model edits ----------
  const model = () => parseWks(ctx.raw.wks);
  const commit = (m) => ctx.set('wks', writeWks(m));
  const editPart = (lineIdx, fn) => {
    const m = model(); const l = m.lines[lineIdx];
    if (!l || l.kind !== 'part') return;
    fn(l.part, l); l.dirty = true; commit(m);
  };
  function setPtable(pt) {
    const m = model();
    let b = m.lines.find((l) => l.kind === 'bootloader');
    if (!b) { b = { kind: 'bootloader', text: '', boot: { mount: '', opts: [], bad: [] } }; m.lines.push(b); }
    setOpt(b.boot, 'ptable', pt); b.dirty = true;
    if (pt === 'msdos') for (const l of m.lines) if (l.kind === 'part' && (opt(l.part, 'part-name') || opt(l.part, 'part-type'))) { setOpt(l.part, 'part-name', null); setOpt(l.part, 'part-type', null); l.dirty = true; }
    commit(m);
  }
  function addPart() {
    const m = model(); const lay = L();
    const erase = lay ? lay.eraseK : 4096;
    const n = m.lines.filter((l) => l.kind === 'part').length + 1;
    const line = { kind: 'part', word: 'part', text: '', dirty: true, part: { mount: `/part${n}`, bad: [], opts: [
      { k: 'fstype', v: 'ext4', eq: true }, { k: 'label', v: `part${n}` }, { k: 'align', v: String(erase) }, { k: 'size', v: '256' }] } };
    const bi = m.lines.findIndex((l) => l.kind === 'bootloader');
    if (bi >= 0) m.lines.splice(bi, 0, line); else m.lines.push(line);
    sel = n - 1; commit(m);
  }
  const resize = (p, k) => editPart(p.line, (pp) => {
    const empty = p.source === 'empty' || p.source === 'swap';
    if (empty && p.mode !== 'fixed') { setOpt(pp, 'size', sizeArg(k)); setOpt(pp, 'fixed-size', null); }
    else { setOpt(pp, 'fixed-size', sizeArg(k)); setOpt(pp, 'size', null); setOpt(pp, 'extra-space', null); setOpt(pp, 'overhead-factor', null); }
  });
  const resizable = (p) => p.source !== 'rawcopy';

  // ---------- pointer helpers ----------
  const drag = (move, done) => {
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); dragging = false; done && done(); };
    dragging = true;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  const track = (el, id) => {
    el.setAttribute('data-id', id);
    const mark = () => { focusId = id; };
    el.addEventListener('focus', mark); el.addEventListener('keydown', mark, true); el.addEventListener('pointerdown', mark, true);
  };
  const select = (i) => { sel = i; draw(); drawEditor(); };

  // ---------- the strips ----------
  function draw() {
    const had = svg.contains(document.activeElement) || dragging;
    svg.replaceChildren();
    try { drawInner(); } finally {
      if (had && focusId) svg.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
    }
  }
  function drawInner() {
    const lay = L();
    const W = Math.max(320, svg.clientWidth || devCard.clientWidth || 900);
    const narrow = W < 620;
    if (!lay) { svg.setAttribute('viewBox', `0 0 ${W} 40`); svg.setAttribute('height', 40); return; }
    const pad = 14, x0 = pad, x1 = W - pad;
    const spanK = Math.max(lay.diskK, lay.imageK);
    const X = (k) => x0 + ((x1 - x0) * k) / spanK;
    const defs = s('defs');
    const hatch = (id, color, op) => {
      const p = s('pattern', { id, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      p.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: color, 'stroke-width': 1.5, 'stroke-opacity': op }));
      defs.append(p);
    };
    hatch('wic-free', 'var(--line)', 1); hatch('wic-bad', 'var(--danger)', 0.7);
    svg.append(defs);
    const parts = lay.parts;
    let y = 30;
    const SH = narrow ? 50 : 60;

    // scale ticks
    const stepG = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].find((g) => spanK / (g * 1048576) <= (narrow ? 5 : 10)) || 128;
    for (let k = 0; k <= spanK; k += stepG * 1048576) {
      svg.append(s('line', { x1: X(k), x2: X(k), y1: y - 6, y2: y, stroke: 'var(--line)' }));
      svg.append(s('text', { x: X(k), y: y - 9, 'text-anchor': k === 0 ? 'start' : 'middle', class: 'small soft' }, k === 0 ? '0' : `${stepG * Math.round(k / (stepG * 1048576))}G`));
    }
    // device body, free space
    svg.append(s('rect', { x: X(0), y, width: X(lay.diskK) - X(0), height: SH, fill: 'url(#wic-free)', stroke: 'var(--line)', rx: 3 }));
    if (lay.imageK > lay.diskK) svg.append(s('rect', { x: X(lay.diskK), y, width: X(lay.imageK) - X(lay.diskK), height: SH, fill: 'url(#wic-bad)', stroke: 'var(--danger)' }));
    // device end, image end
    svg.append(s('line', { x1: X(lay.diskK), x2: X(lay.diskK), y1: y - 4, y2: y + SH + 4, stroke: 'var(--ink)', 'stroke-width': 1.5 }));
    const lanes = [];     // labels that do not fit inside, placed below
    parts.forEach((p, i) => drawPart(p, i, X, y, SH, lanes, false));
    // image end marker
    const ie = X(lay.imageK);
    svg.append(s('line', { x1: ie, x2: ie, y1: y - 2, y2: y + SH + 2, stroke: lay.imageK > lay.diskK ? 'var(--danger)' : 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': '3 2' }));
    const freeK = lay.diskK - lay.imageK;
    const freeW = X(lay.diskK) - ie;
    if (freeK > 0 && freeW > 90) {
      svg.append(s('text', { x: ie + freeW / 2, y: y + SH / 2 - 2, 'text-anchor': 'middle', class: 'soft' }, 'unused'));
      svg.append(s('text', { x: ie + freeW / 2, y: y + SH / 2 + 13, 'text-anchor': 'middle', class: 'small soft' }, human(freeK)));
    }
    if (lay.imageK > lay.diskK) svg.append(s('text', { x: Math.min(x1 - 4, X(lay.diskK) + 4), y: y - 12, 'text-anchor': 'end', class: 'small bad' }, `image ${human(lay.imageK - lay.diskK)} past the end`));
    y += SH;
    const mainBot = y;
    // label lanes for small partitions
    let laneY = y + 14;
    const placed = [];
    for (const lb of lanes) {
      let row = 0;
      while (placed.some((q) => q.row === row && !(lb.x + lb.w < q.x || lb.x > q.x + q.w + 8))) row++;
      placed.push({ ...lb, row });
    }
    const rows = placed.length ? Math.max(...placed.map((q) => q.row)) + 1 : 0;
    for (const q of placed) {
      const ly = laneY + q.row * 15;
      svg.append(s('line', { x1: q.ax, x2: q.ax, y1: y, y2: ly - 10, stroke: 'var(--ink-soft)', 'stroke-width': 0.8 }));
      const t = s('text', { x: q.x, y: ly, class: `small${q.bad ? ' bad' : ''}` }, q.text);
      svg.append(t);
    }
    y = laneY + rows * 15 + 4;

    // ---- zoom: the first megabytes ----
    // the raw area up to the first real filesystem, plus a little of it
    const first = parts.find((p) => p.source !== 'rawcopy' && p.sizeK >= 1024);
    let Z = frozenZoom || Math.max(1024, first ? first.startK + Math.min(first.sizeK, Math.max(first.startK, 1024)) : lay.imageK);
    if (!frozenZoom) Z = niceCeil(Z);
    const zy = y + 26;
    const ZX = (k) => x0 + ((x1 - x0) * k) / Z;
    // callout trapezoid
    svg.append(s('path', { d: `M${X(0)},${mainBot}L${x0},${zy}M${X(Math.min(Z, spanK))},${mainBot}L${x1},${zy}`, stroke: 'var(--line)', 'stroke-dasharray': '2 3', fill: 'none' }));
    svg.append(s('text', { x: x0, y: zy - 6, class: 'small soft' }, `first ${human(Z)}, enlarged`));
    const ZH = narrow ? 44 : 50;
    svg.append(s('rect', { x: x0, y: zy, width: x1 - x0, height: ZH, fill: 'url(#wic-free)', stroke: 'var(--line)', rx: 3 }));
    // the partition table itself
    const tW = Math.max(3, ZX(lay.tableK) - x0);
    svg.append(s('rect', { x: x0, y: zy, width: tW, height: ZH, fill: 'var(--ink-soft)', 'fill-opacity': 0.55 }));
    const zlanes = [];
    zlanes.push({ ax: x0 + tW / 2, x: x0, w: 60, text: lay.gpt ? `GPT 0–17K` : 'MBR', bad: false });
    parts.forEach((p, i) => { if (p.startK < Z) drawPart(p, i, ZX, zy, ZH, zlanes, true, Z); });
    // zoom ticks in KiB/MiB
    const tStep = [1, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].find((t) => Z / t <= (narrow ? 5 : 10)) || 131072;
    for (let k = 0; k <= Z; k += tStep) {
      svg.append(s('line', { x1: ZX(k), x2: ZX(k), y1: zy + ZH, y2: zy + ZH + 5, stroke: 'var(--line)' }));
      if (k > 0) svg.append(s('text', { x: ZX(k), y: zy + ZH + 15, 'text-anchor': 'middle', class: 'small soft' }, k >= 1024 ? `${k / 1024}M` : `${k}K`));
    }
    let zly = zy + ZH + 30;
    const zplaced = [];
    for (const lb of zlanes) {
      let row = 0;
      while (zplaced.some((q) => q.row === row && !(lb.x + lb.w < q.x || lb.x > q.x + q.w + 8))) row++;
      zplaced.push({ ...lb, row });
    }
    const zrows = zplaced.length ? Math.max(...zplaced.map((q) => q.row)) + 1 : 0;
    for (const q of zplaced) {
      const ly = zly + q.row * 15;
      svg.append(s('line', { x1: q.ax, x2: q.ax, y1: zy + ZH, y2: ly - 10, stroke: 'var(--ink-soft)', 'stroke-width': 0.8 }));
      svg.append(s('text', { x: q.x, y: ly, class: `small${q.bad ? ' bad' : ''}` }, q.text));
    }
    const H = zly + zrows * 15 + 6;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);

    const tone = lay.imageK > lay.diskK ? 'bad' : '';
    devSub.replaceChildren('image ', h('b', { class: tone }, human(lay.imageK)), ` on ${human(lay.diskK)} · ${lay.ptable} · erase block ${human(lay.eraseK)}`);
  }

  function drawPart(p, i, X, y, SH, lanes, zoom, Z) {
    const lay = L();
    const end = zoom ? Math.min(p.endK, Z) : p.endK;
    const xa = X(p.startK), xb = X(end);
    const w = Math.max(zoom ? 2 : 1.5, xb - xa);
    const isSel = i === sel;
    const bad = p.overlap || p.warns.length > 0;
    const g = s('g', { class: 'part', tabindex: zoom ? -1 : 0, role: 'button', 'aria-pressed': String(isSel), 'aria-label': `${p.name}: ${human(p.sizeK)} at ${human(p.startK)}` });
    if (!zoom) track(g, `p-${i}`);
    g.append(s('rect', { class: 'ring', x: xa, y: y + 1, width: w, height: SH - 2, rx: 2, fill: colorOf(p), 'fill-opacity': isSel ? 0.55 : 0.3,
      stroke: p.overlap ? 'var(--danger)' : isSel ? 'var(--accent)' : colorOf(p), 'stroke-width': isSel || p.overlap ? 2 : 1.2 }));
    if (p.overlap) g.append(s('rect', { x: xa, y: y + 1, width: w, height: SH - 2, fill: 'url(#wic-bad)', 'pointer-events': 'none' }));
    if (!p.table) g.append(s('line', { x1: xa, x2: xa + w, y1: y + SH - 5, y2: y + SH - 5, stroke: colorOf(p), 'stroke-dasharray': '3 2' }));
    // content fill (files inside the partition)
    if (p.contentK && p.sizeK && p.source !== 'rawcopy') {
      const cw = Math.min(w, ((xb - xa) * Math.min(p.contentK, p.sizeK)) / p.sizeK);
      g.append(s('rect', { x: xa, y: y + SH - 9, width: Math.max(0, cw), height: 4, fill: colorOf(p), 'fill-opacity': 0.9, 'pointer-events': 'none' }));
    }
    const title = `${p.name}${p.table ? ` (#${p.num}${p.type === 'logical' ? ', logical' : ''})` : ' (not in table)'}: ${p.source}, ${p.fstype}, ${human(p.startK)} – ${human(p.endK)}, ${human(p.sizeK)}${p.how ? `; ${p.how}` : ''}${p.warns.length ? '\n! ' + p.warns.join('\n! ') : ''}`;
    g.append(s('title', {}, title));
    const nameT = `${p.name}${bad ? ' !' : ''}`;
    const sizeT = human(p.sizeK);
    const fitsName = w > nameT.length * 7 + 12;
    if (fitsName) {
      g.append(s('text', { x: xa + 6, y: y + (zoom ? 17 : 20), class: `strong${bad ? ' bad' : ''}` }, nameT));
      const sub = zoom ? `@${human(p.startK)}` : `${sizeT}${p.table ? '' : ' raw'}`;
      if (w > sub.length * 6.4 + 12) g.append(s('text', { x: xa + 6, y: y + (zoom ? 32 : 36), class: 'small soft' }, sub));
      if (!zoom && w > 170 && p.fstype !== '–') g.append(s('text', { x: xb - 6, y: y + 20, 'text-anchor': 'end', class: 'small soft' }, p.fstype));
    } else if (!zoom || p.startK < Z) {
      const txt = zoom ? `${p.name} @${human(p.startK)}${bad ? ' !' : ''}` : `${p.name} ${sizeT}${bad ? ' !' : ''}`;
      lanes.push({ ax: xa + w / 2, x: Math.max(4, xa + w / 2 - 3), w: txt.length * 6.3, text: txt, bad });
    }
    g.addEventListener('click', () => select(i));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); } });
    svg.append(g);

    // the resize handle on the right edge (main strip, and zoom when it ends there)
    const showHandle = resizable(p) && (!zoom || (p.endK <= Z && xb - xa > 6));
    if (!showHandle) return;
    const hd = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': `Size of ${p.name}`, 'aria-valuenow': p.sizeK, 'aria-valuetext': human(p.sizeK) });
    track(hd, `h-${zoom ? 'z' : 'm'}-${i}`);
    hd.append(s('rect', { x: xb - 6, y, width: 12, height: SH, fill: 'transparent' }));
    hd.append(s('rect', { class: 'ring', x: xb - 3, y: y + SH / 2 - 11, width: 6, height: 22, rx: 3, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 1.2 }));
    hd.append(s('title', {}, `Drag: size of ${p.name} (now ${human(p.sizeK)})`));
    const erase = lay.eraseK;
    const snap = (k) => Math.max(erase, Math.round(k / erase) * erase);
    hd.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      hd.focus({ preventScroll: true });
      sel = i;
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const k0 = p.sizeK, px0 = e.clientX;
      const kPerPx = (X(1048576) - X(0)) ? 1048576 / ((X(1048576) - X(0)) * (r.width / vb.width)) : 1;
      if (zoom) frozenZoom = Z;
      let last = k0;
      drag((ev) => {
        const k = snap(k0 + (ev.clientX - px0) * kPerPx);
        if (k !== last) { last = k; resize(p, k); }
      }, () => { frozenZoom = null; draw(); });
    });
    hd.addEventListener('keydown', (e) => {
      const st = erase * (e.shiftKey ? 8 : 1);
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); sel = i; resize(p, snap(p.sizeK + st)); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); sel = i; resize(p, Math.max(erase, snap(p.sizeK - st))); }
    });
    svg.append(hd);
  }
  const niceCeil = (k) => { const steps = [1, 2, 4, 8, 16, 32, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576].map((m) => m * 1024); return steps.find((v) => v >= k) || k; };

  // ---------- the editor for one line ----------
  function drawEditor() {
    const lay = L();
    ed.replaceChildren();
    if (!lay || !lay.parts.length) { edTitle.textContent = 'Partition'; edSub.textContent = 'no part lines'; return; }
    if (sel >= lay.parts.length) sel = lay.parts.length - 1;
    const p = lay.parts[sel];
    const m = model(); const pp = m.lines[p.line]?.part;
    if (!pp) return;
    edTitle.textContent = p.name;
    edSub.replaceChildren(`line ${p.line + 1} · ${p.table ? `#${p.num}${p.type === 'logical' ? ' logical' : ''}` : 'not in table'} · `, h('b', {}, human(p.startK)), ' → ', h('b', {}, human(p.endK)), ` · ${human(p.sizeK)}`);
    const field = (label, key, value, attrs = {}) => h('label', {}, label, h('input', { type: 'text', spellcheck: 'false', value: value ?? '', ...attrs,
      onchange: (e) => editPart(p.line, (q) => (key === 'mount' ? (q.mount = e.target.value.trim()) : setOpt(q, key, e.target.value.trim() || null))) }));
    const choose = (label, key, list, value) => h('label', {}, label, h('select', { onchange: (e) => editPart(p.line, (q) => {
      const v = e.target.value; setOpt(q, key, v.startsWith('(') ? null : v);
    }) }, list.map((o) => h('option', { value: o, selected: o === value || (value == null && o.startsWith('(')) }, o))));
    const flag = (label, key, tip) => h('label', { class: 'chk', title: tip }, h('input', { type: 'checkbox', checked: !!opt(pp, key),
      onchange: (e) => editPart(p.line, (q) => setOpt(q, key, e.target.checked || null)) }), label);
    const mode = p.mode === 'fixed' ? 'fixed-size' : p.mode === 'size' ? 'size' : 'auto';
    const modeSeg = h('div', { class: 'wic-seg', role: 'group', 'aria-label': 'Size mode' }, ['auto', 'size', 'fixed-size'].map((md) => h('button', { type: 'button', 'aria-pressed': String(md === mode),
      title: md === 'auto' ? 'from the content (+ extra space) × overhead factor' : md === 'size' ? '--size: at least this, then × overhead' : '--fixed-size: exactly this',
      onclick: () => editPart(p.line, (q) => {
        const cur = Math.max(1024, Math.ceil(p.sizeK / 1024) * 1024);
        setOpt(q, 'size', null); setOpt(q, 'fixed-size', null);
        if (md === 'size') setOpt(q, 'size', sizeArg(cur));
        if (md === 'fixed-size') { setOpt(q, 'fixed-size', sizeArg(cur)); setOpt(q, 'extra-space', null); setOpt(q, 'overhead-factor', null); }
      }) }, md)));
    const sizeVal = opt(pp, mode === 'fixed-size' ? 'fixed-size' : 'size');
    ed.append(...[
      field('Mount / name', 'mount', pp.mount, { placeholder: '/, /boot, u-boot' }),
      field('Label', 'label', opt(pp, 'label')),
      choose('Source', 'source', SOURCES, opt(pp, 'source')),
      choose('fstype', 'fstype', FSTYPES, opt(pp, 'fstype')),
      h('label', { class: 'span2' }, 'Size', h('div', { class: 'wic-row' }, modeSeg,
        mode !== 'auto' ? h('input', { type: 'text', class: 'short', spellcheck: 'false', value: sizeVal ?? '', 'aria-label': `--${mode}`, onchange: (e) => editPart(p.line, (q) => setOpt(q, mode, e.target.value.trim() || null)) }) : null)),
      field('--align (KiB)', 'align', opt(pp, 'align'), { placeholder: String(lay.eraseK) }),
      field('--offset', 'offset', opt(pp, 'offset'), { placeholder: 'e.g. 8M' }),
      lay.gpt ? field('--part-name', 'part-name', opt(pp, 'part-name')) : null,
      field('--sourceparams', 'sourceparams', opt(pp, 'sourceparams'), { placeholder: 'file=imx-boot' }),
      h('div', { class: 'flags' }, flag('--active', 'active', 'boot flag'), flag('--no-table', 'no-table', 'raw data, no partition table entry'), flag('--use-uuid', 'use-uuid', 'root=PARTUUID= in the kernel command line')),
      h('div', { class: 'calc' }, p.how ? ['sized by ', h('code', {}, p.how)] : null,
        p.headroomK != null && p.contentK ? [' · ', h('b', {}, `${Math.round((p.contentK / p.sizeK) * 100)} %`), ` full (${human(p.contentK)} of files)`] : null,
        p.gapK > 0 ? [' · ', `${human(p.gapK)} skipped for --align`] : null),
      p.warns.length ? h('div', { class: 'pwarn' }, p.warns.map((t) => h('div', {}, t))) : null,
      h('div', { class: 'acts' },
        h('button', { class: 'k-btn', type: 'button', disabled: sel === 0 ? '' : null, onclick: () => move(-1) }, '← Earlier'),
        h('button', { class: 'k-btn', type: 'button', disabled: sel === lay.parts.length - 1 ? '' : null, onclick: () => move(1) }, 'Later →'),
        h('button', { class: 'k-btn', type: 'button', title: 'A copy after it; a label ending in A becomes B', onclick: dup }, 'Duplicate (A/B)'),
        h('button', { class: 'k-btn danger push', type: 'button', onclick: del }, 'Delete'))].filter(Boolean));
    function move(d) {
      const m2 = model(); const idx = lay.parts.map((q) => q.line);
      const a = idx[sel], b = idx[sel + d];
      if (b == null) return;
      [m2.lines[a], m2.lines[b]] = [m2.lines[b], m2.lines[a]];
      sel += d; commit(m2);
    }
    function dup() {
      const m2 = model(); const l = m2.lines[p.line];
      const copy = { ...l, dirty: true, part: { ...l.part, opts: l.part.opts.map((o) => ({ ...o })) } };
      const lab = opt(copy.part, 'label');
      if (lab) setOpt(copy.part, 'label', /A$/.test(lab) ? lab.replace(/A$/, 'B') : `${lab}B`);
      const pn = opt(copy.part, 'part-name');
      if (pn) setOpt(copy.part, 'part-name', /a$/i.test(pn) ? pn.replace(/a$/i, (c) => (c === 'a' ? 'b' : 'B')) : `${pn}_b`);
      if (copy.part.mount === '/') copy.part.mount = '';
      else if (copy.part.mount) copy.part.mount = `${copy.part.mount}_b`;
      setOpt(copy.part, 'offset', null);
      m2.lines.splice(p.line + 1, 0, copy);
      sel += 1; commit(m2);
    }
    function del() {
      const m2 = model(); m2.lines.splice(p.line, 1);
      sel = Math.max(0, sel - 1); commit(m2);
    }
  }

  // ---------- the rootfs estimator ----------
  const estFields = {};
  for (const [key, label, tip] of [['rootfsDu', 'du -ks rootfs', 'du -ks of IMAGE_ROOTFS, KiB'], ['overhead', 'IMAGE_OVERHEAD_FACTOR', ''], ['imageRootfsSize', 'IMAGE_ROOTFS_SIZE', 'KiB'],
    ['extraSpace', 'IMAGE_ROOTFS_EXTRA_SPACE', 'KiB'], ['alignment', 'IMAGE_ROOTFS_ALIGNMENT', 'KiB'], ['maxSize', 'IMAGE_ROOTFS_MAXSIZE', 'KiB, 0 = unset']]) {
    const el = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', title: tip, oninput: (e) => ctx.set(key, e.target.value) });
    estFields[key] = el;
    estIns.append(h('label', {}, label, el));
  }
  function drawEst() {
    const lay = L();
    estSvg.replaceChildren();
    if (!lay) return;
    const r = lay.rootfs;
    const W = Math.max(300, estSvg.clientWidth || estCard.clientWidth || 500);
    const rootParts = lay.parts.filter((p) => p.source === 'rootfs');
    const rows = [
      { t: 'files (du)', k: r.du, c: 'var(--tool-rootfs)', op: 0.85 },
      { t: `× ${r.factor}`, k: r.base, c: 'var(--tool-rootfs)', op: 0.45 },
      { t: `max(·, ${r.req})${r.extra ? ` + ${r.extra}` : ''}`, k: r.base2, c: 'var(--tool-rootfs)', op: 0.35 },
      { t: 'ROOTFS_SIZE', k: r.aligned, c: r.over ? 'var(--danger)' : 'var(--accent)', op: 0.35, strong: true },
      ...rootParts.map((p) => ({ t: `wic ${p.name}`, k: p.sizeK, c: p.overlap || p.warns.length ? 'var(--warn)' : 'var(--tool-rootfs)', op: 0.25, fill: p.contentK, how: p.how })),
    ];
    if (r.max > 0) rows.push({ t: 'IMAGE_ROOTFS_MAXSIZE', k: r.max, c: 'var(--ink-soft)', op: 0.15 });
    const LW = Math.min(170, W * 0.36), RW = 86;
    const maxK = Math.max(1, ...rows.map((q) => q.k));
    const bw = W - LW - RW - 16;
    const rh = 22;
    rows.forEach((q, i) => {
      const y = 6 + i * (rh + 4);
      estSvg.append(s('text', { x: LW - 8, y: y + 15, 'text-anchor': 'end', class: q.strong ? 'strong' : 'small soft' }, q.t));
      const w = Math.max(1, (bw * q.k) / maxK);
      estSvg.append(s('rect', { x: LW, y, width: w, height: rh, rx: 2, fill: q.c, 'fill-opacity': q.op, stroke: q.c }));
      if (q.fill != null) estSvg.append(s('rect', { x: LW, y: y + rh - 5, width: Math.max(0, (bw * Math.min(q.fill, q.k)) / maxK), height: 5, fill: 'var(--tool-rootfs)' }));
      if (q.how) { const tt = s('title', {}, q.how); estSvg.lastChild.append(tt); }
      estSvg.append(s('text', { x: LW + w + 6, y: y + 15, class: 'small' }, human(q.k)));
    });
    // the du handle: drag to try another rootfs size
    const y0 = 6, wdu = Math.max(1, (bw * r.du) / maxK);
    const hd = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': 'Rootfs files size', 'aria-valuetext': human(r.du) });
    track(hd, 'du');
    hd.append(s('rect', { x: LW + wdu - 6, y: y0, width: 12, height: rh, fill: 'transparent' }));
    hd.append(s('rect', { class: 'ring', x: LW + wdu - 3, y: y0 + 3, width: 6, height: rh - 6, rx: 3, fill: 'var(--surface)', stroke: 'var(--ink)' }));
    const setDu = (k) => ctx.set('rootfsDu', String(Math.max(0, Math.round(k / 1024) * 1024)));
    hd.addEventListener('pointerdown', (e) => {
      e.preventDefault(); hd.focus({ preventScroll: true });
      const rr = estSvg.getBoundingClientRect(); const vb = estSvg.viewBox.baseVal;
      const kpp = maxK / (bw * (rr.width / vb.width)); const x0 = e.clientX, k0 = r.du;
      drag((ev) => setDu(k0 + (ev.clientX - x0) * kpp), () => drawEst());
    });
    hd.addEventListener('keydown', (e) => {
      const st = (e.shiftKey ? 65536 : 8192);
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setDu(r.du + st); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setDu(Math.max(0, r.du - st)); }
    });
    estSvg.append(hd);
    const H = 6 + rows.length * (rh + 4) + 4;
    estSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); estSvg.setAttribute('height', H);
    const had = estSvg.contains(document.activeElement);
    if (had && focusId === 'du') hd.focus({ preventScroll: true });
  }

  // ---------- content sizes ----------
  function drawContent() {
    const rows = (ctx.raw.content || []).map((r) => ({ ...r }));
    const lay = L();
    const wanted = lay ? lay.parts.filter((p) => ['rawcopy', 'bootimg-partition', 'bootimg-efi', 'bootimg-pcbios'].includes(p.source)) : [];
    const setRows = (next) => ctx.set('content', next);
    contentTbl.replaceChildren(
      h('table', {}, h('tbody', {}, rows.map((r, i) => h('tr', {},
        h('td', {}, h('input', { type: 'text', spellcheck: 'false', value: r.part ?? '', 'aria-label': 'Partition', onchange: (e) => { rows[i].part = e.target.value; setRows(rows); } })),
        h('td', {}, h('input', { type: 'text', spellcheck: 'false', class: 'short', value: r.size ?? '', 'aria-label': 'Size', onchange: (e) => { rows[i].size = e.target.value; setRows(rows); } })),
        h('td', {}, h('button', { class: 'k-btn', type: 'button', 'aria-label': 'Remove row', onclick: () => { rows.splice(i, 1); setRows(rows); } }, '×')))))),
      h('div', { class: 'acts' }, wanted.filter((p) => !rows.some((r) => [p.mount, p.label, p.partName, p.file].includes(r.part))).slice(0, 4).map((p) =>
        h('button', { class: 'k-btn', type: 'button', onclick: () => setRows([...rows, { part: p.file || p.mount || p.label || p.partName, size: '1M' }]) }, `+ ${p.name}`)),
      h('button', { class: 'k-btn', type: 'button', onclick: () => setRows([...rows, { part: '', size: '' }]) }, '+ Row')));
  }

  // ---------- result ----------
  const syncInputs = () => {
    const raw = ctx.raw;
    if (document.activeElement !== src) src.value = raw.wks ?? '';
    devSel.value = raw.device;
    diskLab.hidden = raw.device !== 'custom';
    if (document.activeElement !== diskIn) diskIn.value = raw.diskSize ?? '';
    if (document.activeElement !== eraseIn) eraseIn.value = raw.erase ?? '';
    for (const [k, el] of Object.entries(estFields)) if (document.activeElement !== el) el.value = raw[k] ?? '';
  };
  ctx.onResult((r) => {
    res = r;
    syncInputs();
    const lay = L();
    for (const b of ptBtns) b.setAttribute('aria-pressed', String(!!lay && (b.textContent === 'gpt' ? lay.gpt : !lay.gpt)));
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Notes (${(r.notes || []).length})`), ...(r.notes || []).map((n) => h('div', {}, n)));
    draw(); drawEst();
    if (!dragging) { drawEditor(); drawContent(); }
    else drawEditorLite();
  });
  // while dragging only the numbers in the editor head change
  function drawEditorLite() {
    const lay = L(); const p = lay && lay.parts[sel];
    if (p) edSub.replaceChildren(`line ${p.line + 1} · `, h('b', {}, human(p.startK)), ' → ', h('b', {}, human(p.endK)), ` · ${human(p.sizeK)}`);
  }
  let rw = 0;
  new ResizeObserver(() => { const w = svg.clientWidth; if (w && Math.abs(w - rw) > 2) { rw = w; draw(); drawEst(); } }).observe(devCard);
}
