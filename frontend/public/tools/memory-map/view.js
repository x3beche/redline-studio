// Memory Map Viewer, custom page: the address space itself.
//
// Each memory region is a tall column drawn like a datasheet memory map -
// the origin at the bottom, addresses rising - with every section a block at
// its offset, to that region's scale, and its name, size and address on a
// leader beside it. The free space above is left open; the region's end is a
// handle: drag it (or focus it and use the arrows) to try a smaller or larger
// part. Initialised data is linked to its load copy in flash by the start-up
// copy arrow. At the side the pasted size output is shown line by line,
// coloured by where each line went (or why it was skipped); Edit opens it.
//
// Every number drawn comes from run(): result.regions (offsets, sizes, use)
// and result.tables (the Sections and Regions rows with their addresses).

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
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MiB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KiB` : `${b} B`);
const hex8 = (v) => '0x' + v.toString(16).toUpperCase().padStart(8, '0');
// a length as a linker script writes it
const lenText = (b) => (b % 1048576 === 0 ? `${b / 1048576}M` : b % 1024 === 0 ? `${b / 1024}K` : '0x' + b.toString(16).toUpperCase());

// what a section is, for its colour
function kind(name) {
  const n = name.replace(' (load copy)', '');
  if (/ \(load copy\)$/.test(name)) return 'copy';
  if (/heap|stack/i.test(n)) return 'stack';
  if (/bss|noinit|uninit/i.test(n)) return 'bss';
  if (/rodata|ARM|init_array|fini_array|preinit|exidx|extab/i.test(n)) return 'ro';
  if (/data/i.test(n)) return 'data';
  return 'code';
}
const KIND_LABEL = { code: 'code', ro: 'read-only data', data: 'initialised data', copy: 'load copy of initialised data', bss: 'zeroed data (.bss)', stack: 'heap / stack' };
const SKIP = /^\.(debug|comment|ARM\.attributes|stab|note\.gnu|gnu\.attributes)/i;

// a step that suits a region of this size: 1/16 of its power of two, at least 256 bytes
const stepFor = (len) => Math.max(256, 2 ** Math.floor(Math.log2(Math.max(1, len))) / 16);

export function page(root, ctx) {
  const st = { sel: null, hover: null, drag: null, editing: false, scale: new Map() };

  // ---------------------------------------------------------------- layout
  const mapWrap = h('div', { class: 'mm-mapwrap' });
  const status = h('div', { class: 'mm-status', 'aria-live': 'polite' });
  const legend = h('div', { class: 'mm-legend' },
    ['code', 'ro', 'data', 'copy', 'bss', 'stack'].map((k) => h('span', {}, h('i', { class: `mm-k-${k}` }), KIND_LABEL[k])));
  const map = h('section', { class: 'mm-map', 'aria-label': 'Memory map' },
    h('div', { class: 'mm-maphead' }, h('span', { class: 'mm-h' }, 'Address space'),
      h('span', { class: 'mm-soft' }, 'each region to its own scale · addresses rise upward · drag a region\'s top edge to resize it'), legend),
    mapWrap, status);

  const detail = h('div', { class: 'mm-detail', 'aria-live': 'polite' });
  const listing = h('div', { class: 'mm-listing', role: 'list', 'aria-label': 'Size output, line by line' });
  const ta = h('textarea', { class: 'mm-ta', rows: 14, spellcheck: 'false', 'aria-label': 'Size output',
    placeholder: 'arm-none-eabi-size -A firmware.elf  (or the Berkeley line, or "name size region" per line)',
    oninput: (e) => ctx.set('sizes', e.target.value) });
  const editBtn = h('button', { class: 'k-btn', onclick: () => { st.editing = !st.editing; drawSource(); if (st.editing) ta.focus(); } }, 'Edit');
  const fmtTag = h('span', { class: 'mm-tag' });
  const source = h('section', { class: 'mm-panel mm-source' },
    h('div', { class: 'mm-phead' }, h('span', { class: 'mm-h' }, 'Size output'), fmtTag, editBtn),
    listing, ta);

  const regList = h('div', { class: 'mm-regs' });
  const loadSel = h('select', { 'aria-label': 'Load region (where .data is stored)', onchange: (e) => ctx.set('flashName', e.target.value) });
  const ramSel = h('select', { 'aria-label': 'RAM region for the Berkeley format', onchange: (e) => ctx.set('ramName', e.target.value) });
  const regions = h('section', { class: 'mm-panel mm-regpanel' },
    h('div', { class: 'mm-phead' }, h('span', { class: 'mm-h' }, 'Linker MEMORY'),
      h('button', { class: 'k-btn', onclick: addRegion }, '+ Region')),
    regList,
    h('div', { class: 'mm-roles' }, h('label', {}, '.data stored in ', loadSel), h('label', {}, 'Berkeley RAM ', ramSel)));

  const warns = h('div', { class: 'mm-warns', 'aria-live': 'polite' });
  const notes = h('div', { class: 'mm-notes' });
  const side = h('aside', { class: 'mm-side' }, detail, source, regions, ctx.outputs, notes);
  root.append(h('div', { class: 'mm-page' }, h('div', { class: 'mm-main' }, warns, map), side));

  // ---------------------------------------------------------------- inputs
  const rowsNow = () => (ctx.raw.regions || []).map((r) => ({ ...r }));
  function setLength(name, bytes) {
    const rows = rowsNow();
    const r = rows.find((x) => String(x.name).trim() === name);
    if (!r) return;
    r.length = lenText(bytes);
    ctx.set('regions', rows);
  }
  function addRegion() {
    const rows = rowsNow();
    // after the highest region, a 64K block
    let top = 0;
    for (const r of ctx.result?.regions || []) top = Math.max(top, r.origin + r.length);
    rows.push({ name: `REGION${rows.length + 1}`, origin: '0x' + (top || 0x10000000).toString(16).toUpperCase(), length: '64K' });
    ctx.set('regions', rows);
  }

  function drawRegionsPanel(res) {
    const rows = ctx.raw.regions || [];
    const byName = new Map((res.regions || []).map((r) => [r.name, r]));
    const focusKey = document.activeElement?.dataset?.mmcell;
    regList.replaceChildren(h('div', { class: 'mm-reghead' }, h('span', {}, 'name'), h('span', {}, 'origin'), h('span', {}, 'length'), h('span', {}, 'use'), h('span', {})),
      ...rows.map((r, i) => {
        const cell = (key, label) => {
          const el = h('input', { type: 'text', spellcheck: 'false', 'aria-label': `${label}, region ${i + 1}`, 'data-mmcell': `${i}.${key}`,
            onchange: (e) => { const rs = rowsNow(); rs[i][key] = e.target.value; ctx.set('regions', rs); } });
          el.value = r[key] ?? '';
          return el;
        };
        const reg = byName.get(String(r.name).trim());
        const pct = reg ? reg.pct : null;
        return h('div', { class: 'mm-regrow' }, cell('name', 'Name'), cell('origin', 'Origin'), cell('length', 'Length'),
          h('span', { class: `mm-use${pct > 100 ? ' is-bad' : pct > 90 ? ' is-warn' : ''}` }, pct == null ? '–' : `${pct.toFixed(1)} %`),
          h('button', { class: 'k-btn k-x', title: 'Remove region', 'aria-label': `Remove region ${r.name}`,
            onclick: () => { const rs = rowsNow(); rs.splice(i, 1); ctx.set('regions', rs); } }, '×'));
      }));
    if (focusKey) regList.querySelector(`[data-mmcell="${focusKey}"]`)?.focus();
    const names = (res.regions || []).map((r) => r.name);
    const opts = (sel, cur) => {
      sel.replaceChildren(...names.map((n) => h('option', { value: n, selected: n.toUpperCase() === String(cur).trim().toUpperCase() }, n)));
      if (!names.some((n) => n.toUpperCase() === String(cur).trim().toUpperCase())) sel.prepend(h('option', { value: cur, selected: true }, `${cur || '(auto)'}`));
    };
    opts(loadSel, ctx.raw.flashName ?? ''); opts(ramSel, ctx.raw.ramName ?? '');
  }

  // ---------------------------------------------------------------- source listing
  function drawSource() {
    const res = ctx.result || {};
    ta.hidden = !st.editing;
    listing.hidden = st.editing;
    editBtn.textContent = st.editing ? 'Done' : 'Edit';
    if (document.activeElement !== ta && ta.value !== String(ctx.raw.sizes ?? '')) ta.value = String(ctx.raw.sizes ?? '');
    const fmt = (res.values || []).find((v) => v.label === 'Input read as');
    fmtTag.textContent = fmt ? `read as ${fmt.value}` : '';
    if (st.editing) return;
    const parts = new Map();
    for (const r of res.regions || []) for (const p of r.parts) if (!p.copy) parts.set(p.name, { region: r.name, p });
    const lines = String(ctx.raw.sizes ?? '').split('\n');
    const kids = [];
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      const tok = l.split(/\s+/);
      const head = /^section\s+size/i.test(l) || /:\s*$/.test(l) || /^text\s+data\s+bss/i.test(l);
      const hit = head ? null : parts.get(tok[0]);
      let cls = 'mm-line', note = '';
      if (head) { cls += ' is-head'; note = 'header'; }
      else if (hit) { cls += ` is-used mm-k-${kind(tok[0])}`; note = hit.region; }
      else if (SKIP.test(tok[0])) { cls += ' is-skip'; note = 'not loaded'; }
      else if (/^Total$/i.test(tok[0])) { cls += ' is-skip'; note = 'total'; }
      else if (tok.length >= 3 && tok[1] === '0') { cls += ' is-skip'; note = 'empty'; }
      else if (/^\d+\s+\d+\s+\d+/.test(l)) { cls += ' is-used'; note = 'text · data · bss'; }
      else { cls += ' is-bad'; note = 'not placed'; }
      const selected = hit && st.sel === tok[0];
      const el = h(hit ? 'button' : 'div', { class: cls + (selected ? ' is-sel' : ''), role: 'listitem',
        onclick: hit ? () => select(tok[0]) : null,
        onmouseenter: hit ? () => hover(tok[0]) : null, onmouseleave: hit ? () => hover(null) : null },
      h('i', {}), h('code', {}, raw.replace(/\s+$/, '')), h('small', {}, note));
      kids.push(el);
    }
    if (!kids.length) kids.push(h('div', { class: 'mm-soft mm-empty' }, 'Paste the output of arm-none-eabi-size -A firmware.elf: press Edit.'));
    listing.replaceChildren(...kids);
  }

  // ---------------------------------------------------------------- selection
  function select(name) { st.sel = st.sel === name ? null : name; drawMap(); drawSource(); drawDetail(); }
  function hover(name) {
    st.hover = name;
    for (const g of mapWrap.querySelectorAll('.mm-part')) g.classList.toggle('is-hot', !!name && g.dataset.base === name);
    for (const p of mapWrap.querySelectorAll('.mm-copyarrow')) p.classList.toggle('is-hot', !!name && p.dataset.base === name);
  }
  function drawDetail() {
    const res = ctx.result || {};
    const secRows = res.tables?.find((t) => t.title === 'Sections')?.rows || [];
    const regRows = res.tables?.find((t) => t.title === 'Regions')?.rows || [];
    if (st.sel) {
      const rows = secRows.filter((r) => r[1] === st.sel || r[1] === `${st.sel} (load copy)`);
      if (rows.length) {
        const [reg, name, bytes, size, addr, share] = rows[0];
        const copy = rows[1];
        detail.replaceChildren(h('div', { class: 'mm-dhead' }, h('i', { class: `mm-sw mm-k-${kind(name)}` }), h('b', {}, name),
          h('span', { class: 'mm-soft' }, KIND_LABEL[kind(name)]),
          h('button', { class: 'k-btn mm-dx', 'aria-label': 'Clear selection', onclick: () => select(st.sel) }, '×')),
        h('dl', {}, h('dt', {}, 'region'), h('dd', {}, reg), h('dt', {}, 'address'), h('dd', {}, addr),
          h('dt', {}, 'size'), h('dd', {}, `${size} (${bytes} B)`), h('dt', {}, 'of region'), h('dd', {}, share),
          ...(copy ? [h('dt', {}, 'load copy'), h('dd', {}, `${copy[0]} ${copy[4]} · ${copy[3]}`)] : [])));
        return;
      }
    }
    // no selection: the regions at a glance
    detail.replaceChildren(h('div', { class: 'mm-dhead' }, h('b', {}, 'Regions'), h('span', { class: 'mm-soft' }, 'click a section in the map or the listing')),
      h('div', { class: 'mm-sum' }, regRows.map(([name, origin, length, used, free, use]) => {
        const pct = parseFloat(use);
        return h('div', { class: `mm-sumrow${pct > 100 ? ' is-bad' : pct > 90 ? ' is-warn' : ''}` },
          h('b', {}, name), h('span', {}, `${used} / ${length}`), h('span', {}, `${free} free`), h('strong', {}, use));
      })));
  }

  // ---------------------------------------------------------------- the map
  function drawMap() {
    const res = ctx.result || {};
    const regs = res.regions || [];
    if (!regs.length) { mapWrap.replaceChildren(h('div', { class: 'mm-soft mm-empty' }, 'Add a memory region to draw the map.')); return; }
    const secRows = res.tables?.find((t) => t.title === 'Sections')?.rows || [];
    const addrOf = new Map(secRows.map((r) => [`${r[0]}|${r[1]}`, r]));
    const regRows = new Map((res.tables?.find((t) => t.title === 'Regions')?.rows || []).map((r) => [r[0], r]));

    const W = Math.max(320, mapWrap.clientWidth || 800);
    const H = Math.max(360, mapWrap.clientHeight || 600);
    const n = regs.length;
    const narrow = W < 560;
    // per column: bar + one label lane; the first column's labels go left when there are two or more
    const leftFirst = n >= 2;
    const GUT = n >= 2 ? (narrow ? 26 : Math.min(160, Math.max(70, W * 0.1))) : 0;
    // columns: [labels|bar0] gutter [bar1|labels] [bar2|labels] ...
    const barW = narrow ? Math.max(48, Math.min(80, (W - GUT) / n / 3.4)) : Math.max(80, Math.min(150, (W - GUT) / n / 3.2));
    const laneW = Math.max(narrow ? 70 : 130, Math.min(280, (W - GUT - n * barW - (n - 1) * 12) / n - 12));
    const top = 58, bot = 40, colH = H - top - bot;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'mm-svg', role: 'group', 'aria-label': 'Memory regions, drawn to scale' });
    const defs = sv('defs');
    for (const k of ['data', 'copy']) {
      const pat = sv('pattern', { id: `mm-hatch-${k}`, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      pat.append(sv('rect', { width: 7, height: 7, class: 'mm-hatch-bg' }), sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'mm-hatch-ln' }));
      defs.append(pat);
    }
    const free = sv('pattern', { id: 'mm-free', width: 8, height: 8, patternUnits: 'userSpaceOnUse' });
    free.append(sv('circle', { cx: 4, cy: 4, r: 0.7, class: 'mm-freedot' }));
    defs.append(free);
    svg.append(defs);

    const cols = [];
    let x = 0;
    regs.forEach((r, i) => {
      const labelLeft = leftFirst && i === 0;
      if (labelLeft) { cols.push({ r, labelLeft, laneX: x, bx: x + laneW + 12 }); x += laneW + 12 + barW + GUT; }
      else { cols.push({ r, labelLeft, bx: x, laneX: x + barW + 12 }); x += barW + 12 + laneW + 12; }
    });
    const shift = Math.max(4, (W - (x - 12)) / 2);
    for (const c of cols) { c.bx += shift; c.laneX += shift; }

    const Y = {};
    for (const c of cols) {
      const r = c.r;
      const span = Math.max(r.length, ...r.parts.map((p) => p.offset + p.size));
      // the scale: frozen while this region's handle is dragged, else the region plus headroom to pull it up
      let scale = st.drag?.name === r.name ? st.drag.scale : Math.max(span, r.length) * 1.12;
      st.scale.set(r.name, scale);
      const y = (off) => top + colH - (off / scale) * colH;
      Y[r.name] = y;
      c.y = y;
      const over = r.used > r.length || span > r.length;
      const pctCls = over ? 'is-bad' : r.pct > 90 ? 'is-warn' : '';
      const g = sv('g', { class: 'mm-col' });
      // header: name and use
      const hx = c.bx + barW / 2;
      g.append(sv('text', { x: hx, y: 16, class: 'mm-rname', 'text-anchor': 'middle' }, r.name));
      g.append(sv('text', { x: hx, y: 36, class: `mm-rpct ${pctCls}`, 'text-anchor': 'middle' }, `${r.pct.toFixed(1)} %`));
      const rr = regRows.get(r.name);
      if (rr && !narrow) g.append(sv('text', { x: hx, y: 50, class: 'mm-rsub', 'text-anchor': 'middle' }, `${rr[3]} / ${rr[2]}`));

      // the region body: free space dotted, 90 % band, the limit
      const yEnd = y(r.length), y0 = y(0);
      g.append(sv('rect', { x: c.bx, y: yEnd, width: barW, height: y0 - yEnd, class: 'mm-body' }));
      g.append(sv('rect', { x: c.bx, y: yEnd, width: barW, height: y0 - yEnd, fill: 'url(#mm-free)' }));
      const y90 = y(r.length * 0.9);
      const bandX = c.labelLeft ? c.bx - 5 : c.bx + barW;
      g.append(sv('rect', { x: bandX, y: yEnd, width: 5, height: y90 - yEnd, class: 'mm-band' }, null));
      // free label in the free space
      if (rr && !over) {
        const fTop = yEnd, fBot = y(r.parts.reduce((m, p) => Math.max(m, p.offset + p.size), 0));
        if (fBot - fTop > 34 && barW >= 70) {
          g.append(sv('text', { x: hx, y: (fTop + fBot) / 2 - 2, class: 'mm-free', 'text-anchor': 'middle' }, 'free'));
          g.append(sv('text', { x: hx, y: (fTop + fBot) / 2 + 12, class: 'mm-freev', 'text-anchor': 'middle' }, rr[4]));
        }
      }

      // parts
      const labels = [];
      for (const p of r.parts) {
        const k = kind(p.name);
        const base = p.name.replace(' (load copy)', '');
        const y1 = y(p.offset), y2 = y(p.offset + p.size);
        const hgt = Math.max(2, y1 - y2);
        const beyond = p.offset + p.size > r.length;
        const pg = sv('g', { class: `mm-part mm-k-${k}${st.sel === base ? ' is-sel' : ''}${beyond ? ' is-over' : ''}`, 'data-base': base, tabindex: 0,
          role: 'button', 'aria-label': `${p.name}, ${kb(p.size)} in ${r.name}` });
        pg.append(sv('rect', { x: c.bx + 0.5, y: y1 - hgt, width: barW - 1, height: hgt, class: 'mm-blk',
          fill: k === 'copy' ? 'url(#mm-hatch-copy)' : null }));
        if (hgt > 15 && barW > 50) pg.append(sv('text', { x: hx, y: y1 - hgt / 2 + 4, class: 'mm-blabel', 'text-anchor': 'middle' },
          base.length * 6.4 > barW - 6 ? base.slice(0, Math.max(3, Math.floor((barW - 6) / 6.4))) : base));
        pg.append(sv('title', {}, `${p.name}: ${kb(p.size)}`));
        pg.addEventListener('click', () => select(base));
        pg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(base); } });
        pg.addEventListener('mouseenter', () => hover(base));
        pg.addEventListener('mouseleave', () => hover(null));
        g.append(pg);
        const row = addrOf.get(`${r.name}|${p.name}`);
        labels.push({ p, base, k, want: y1 - hgt / 2, row, yTop: y1 - hgt, yBot: y1 });
      }
      // overflow: the limit line and what is past it
      if (over) {
        const yTop = y(span);
        g.append(sv('rect', { x: c.bx, y: yTop, width: barW, height: Math.max(0, yEnd - yTop), class: 'mm-overzone' }));
        g.append(sv('line', { x1: c.bx - 8, x2: c.bx + barW + 8, y1: yEnd, y2: yEnd, class: 'mm-limit' }));
        if (yEnd - yTop > 30) g.append(sv('text', { x: hx, y: (yTop + yEnd) / 2 + 4, class: 'mm-overlab', 'text-anchor': 'middle' }, `+${kb(span - r.length)} over`));
      }
      // labels on a leader, pushed apart
      placeLabels(g, labels, c, barW, laneW, top, top + colH, narrow);
      // origin at the bottom
      g.append(sv('text', { x: hx, y: y0 + 16, class: 'mm-addr', 'text-anchor': 'middle' }, hex8(r.origin)));
      g.append(sv('text', { x: hx, y: y0 + 29, class: 'mm-rsub', 'text-anchor': 'middle' }, 'origin'));

      // the end handle
      const hd = sv('g', { class: `mm-handle${st.drag?.name === r.name ? ' is-drag' : ''}`, tabindex: 0, role: 'slider',
        'aria-label': `${r.name} length`, 'aria-valuetext': `${lenText(r.length)} (${kb(r.length)}), ends at ${hex8(r.origin + r.length)}`,
        'aria-valuenow': r.length, 'aria-valuemin': stepFor(r.length) });
      hd.append(sv('rect', { x: c.bx - 10, y: yEnd - 9, width: barW + 20, height: 18, class: 'mm-hhit' }));
      hd.append(sv('line', { x1: c.bx - 6, x2: c.bx + barW + 6, y1: yEnd, y2: yEnd, class: 'mm-hline' }));
      hd.append(sv('rect', { x: hx - 16, y: yEnd - 4, width: 32, height: 8, rx: 3, class: 'mm-grip' }));
      const endLabX = c.labelLeft ? c.bx - 12 : c.bx + barW + 12;
      hd.append(sv('text', { x: endLabX, y: yEnd - 3, class: 'mm-endlab', 'text-anchor': c.labelLeft ? 'end' : 'start' }, `${lenText(r.length)}`));
      hd.append(sv('text', { x: endLabX, y: yEnd + 10, class: 'mm-addr', 'text-anchor': c.labelLeft ? 'end' : 'start' }, hex8(r.origin + r.length)));
      hd.append(sv('title', {}, `Drag to change ${r.name}'s length (arrows: ±${lenText(stepFor(r.length))}, Page Up/Down: double/halve)`));
      hd.addEventListener('pointerdown', (e) => startDrag(e, r, c));
      hd.addEventListener('keydown', (e) => keyLen(e, r));
      g.append(hd);
      svg.append(g);
    }

    // start-up copy arrows: an initialised section in RAM <- its load copy in flash
    for (const c of cols) for (const p of c.r.parts) {
      if (!p.copy) continue;
      const base = p.name.replace(' (load copy)', '');
      const dst = cols.find((d) => d !== c && d.r.parts.some((q) => q.name === base && !q.copy));
      if (!dst) continue;
      const q = dst.r.parts.find((pp) => pp.name === base && !pp.copy);
      const ya = c.y(p.offset + p.size / 2), yb = dst.y(q.offset + q.size / 2);
      const toRight = dst.bx > c.bx;
      const xa = toRight ? c.bx + barW : c.bx, xb = toRight ? dst.bx : dst.bx + barW;
      const mx = (xa + xb) / 2;
      const path = sv('path', { d: `M${xa} ${ya} C${mx} ${ya} ${mx} ${yb} ${xb + (toRight ? -6 : 6)} ${yb}`,
        class: `mm-copyarrow${st.sel === base ? ' is-hot' : ''}`, 'data-base': base, 'marker-end': 'url(#mm-arrow)' });
      svg.append(path);
      if (Math.abs(xb - xa) > 150) svg.append(sv('text', { x: mx, y: (ya + yb) / 2 - 6, class: 'mm-copylab', 'text-anchor': 'middle' }, `${base} copied at start-up`));
    }
    const mk = sv('marker', { id: 'mm-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    mk.append(sv('path', { d: 'M0 0L8 4L0 8z', class: 'mm-arrowhead' }));
    defs.append(mk);

    mapWrap.replaceChildren(svg);
    if (st.refocus) { mapWrap.querySelectorAll('.mm-handle')[st.refocus.i]?.focus(); st.refocus = null; }
  }

  function placeLabels(g, labels, c, barW, laneW, yMin, yMax, narrow) {
    const LH = 28;
    labels.sort((a, b) => b.want - a.want); // bottom (low address) first
    let prev = yMax + LH;
    for (const l of labels) { l.y = Math.min(l.want, prev - LH); prev = l.y; }
    // pushed off the top: shift the lot down again
    const over = yMin + 8 - labels.at(-1)?.y;
    if (over > 0) { let nxt = yMin + 8 - LH; for (let i = labels.length - 1; i >= 0; i--) { labels[i].y = Math.max(labels[i].y, nxt + LH); nxt = labels[i].y; } }
    const left = c.labelLeft;
    const edge = left ? c.bx - 6 : c.bx + barW + 6;
    const off = narrow ? 20 : 34;
    const tx = left ? c.bx - off : c.bx + barW + off;
    const maxCh = Math.floor((laneW - off) / 6.8);
    for (const l of labels) {
      const lg = sv('g', { class: `mm-lab mm-part mm-k-${l.k}${st.sel === l.base ? ' is-sel' : ''}`, 'data-base': l.base });
      const yy = l.y;
      const attach = Math.max(l.yTop + 1, Math.min(l.yBot - 1, yy));
      lg.append(sv('path', { d: `M${edge} ${attach} L${left ? edge - off / 3 : edge + off / 3} ${attach} L${left ? tx + 4 : tx - 4} ${yy}`, class: 'mm-leader' }));
      lg.append(sv('rect', { x: left ? tx - 2 - 8 : tx - 2, y: yy - 11, width: 6, height: 6, rx: 1, class: 'mm-lsw', transform: left ? `translate(${10} 0)` : null }));
      const name = l.p.name.replace(' (load copy)', ' copy');
      const size = l.row ? l.row[3] : kb(l.p.size);
      const addr = l.row ? l.row[4] : '';
      lg.append(sv('text', { x: left ? tx - 10 : tx + 8, y: yy - 4, class: 'mm-lname', 'text-anchor': left ? 'end' : 'start' },
        name.length > maxCh ? name.slice(0, maxCh - 1) + '…' : name));
      lg.append(sv('text', { x: left ? tx - 10 : tx + 8, y: yy + 9, class: 'mm-lsub', 'text-anchor': left ? 'end' : 'start' },
        laneW > 200 ? `${size} · ${addr}` : size));
      lg.addEventListener('click', () => select(l.base));
      lg.addEventListener('mouseenter', () => hover(l.base));
      lg.addEventListener('mouseleave', () => hover(null));
      g.append(lg);
    }
  }

  // ---------------------------------------------------------------- resizing a region
  function startDrag(e, r, c) {
    e.preventDefault();
    const svg = mapWrap.querySelector('svg');
    const scale = st.scale.get(r.name);
    const rect = svg.getBoundingClientRect();
    const k = rect.height / svg.viewBox.baseVal.height;
    const colTop = 58, colH = svg.viewBox.baseVal.height - 58 - 40;
    st.drag = { name: r.name, scale, origin: r.origin };
    const step = stepFor(r.length);
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    let lastLen = r.length;
    const move = (ev) => {
      const yy = (ev.clientY - rect.top) / k;
      let off = ((colTop + colH - yy) / colH) * scale;
      off = Math.max(step, Math.round(off / step) * step);
      if (off !== lastLen) { lastLen = off; setLength(r.name, off); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      st.drag = null;
      drawMap();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function keyLen(e, r) {
    const step = stepFor(r.length);
    let len = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') len = r.length + step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') len = r.length - step;
    else if (e.key === 'PageUp') len = r.length * 2;
    else if (e.key === 'PageDown') len = Math.floor(r.length / 2);
    if (len == null) return;
    e.preventDefault();
    len = Math.max(256, Math.round(len / 256) * 256);
    st.refocus = { i: (ctx.result.regions || []).findIndex((x) => x.name === r.name) };
    setLength(r.name, len);
  }

  // ---------------------------------------------------------------- result in
  ctx.onResult((res) => {
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    if (st.sel && !(res.regions || []).some((r) => r.parts.some((p) => p.name === st.sel))) st.sel = null;
    drawMap();
    drawSource();
    drawDetail();
    drawRegionsPanel(res);
    const worst = (res.regions || []).reduce((a, r) => (!a || r.pct > a.pct ? r : a), null);
    status.textContent = worst ? `Fullest: ${worst.name} at ${worst.pct.toFixed(1)} %. Arrow keys on a focused top edge step the length; Page Up/Down doubles or halves it.` : '';
  });

  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (!st.drag) drawMap(); }); }).observe(mapWrap);
}
