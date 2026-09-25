// Firmware Size Diff, custom page: the two firmware images side by side.
//
// Each build is drawn as a column of its symbols, stacked by region (text,
// rodata, data, bss) on one byte scale, so the new image is as much taller
// as it is bigger. A ribbon joins each symbol's old block to its new one:
// it widens when the symbol grew, narrows when it shrank, fans out of a point
// when the symbol is new and closes to a point when it vanished. Brackets
// beside each column mark what lands in flash (text + rodata + data) and in
// RAM (data + bss) - they overlap on data, which counts in both.
//
// Beside it the change list, largest first, with two fences you drag: the
// "ignore under" line on the change scale (minDelta) and the "top N" cut
// across the list (top). Rows, blocks and ribbons select one another.
// Every number comes from run()'s result.diff (and result.values).

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

const REGIONS = ['text', 'rodata', 'data', 'bss', 'other'];
const REGION_NOTE = { text: 'code', rodata: 'constants', data: 'initialised, flash + RAM', bss: 'zeroed, RAM', other: 'region unknown' };
const B = (n) => Math.abs(n).toLocaleString('en-US');
const bytes = (n) => `${B(n)} B`;
const signed = (n) => (n > 0 ? `+${B(n)}` : n < 0 ? `−${B(n)}` : '0');
const GLYPH = { added: '+', removed: '−', grew: '▲', shrank: '▼', same: '=' };
const keyOf = (s) => `${s.name}\u0000${s.region}`;
const STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];

export function page(root, ctx) {
  const st = { sel: null, open: null, drag: null };

  // ------------------------------------------------------------ builds strip
  const builds = ['before', 'after'].map((key) => {
    const ta = h('textarea', { class: 'fsd-src', rows: 10, spellcheck: 'false', 'aria-label': key === 'before' ? 'Old build text' : 'New build text',
      placeholder: key === 'before' ? 'arm-none-eabi-nm -S --size-sort old.elf' : 'arm-none-eabi-nm -S --size-sort new.elf',
      oninput: (e) => ctx.set(key, e.target.value) });
    const meta = h('span', { class: 'fsd-meta' });
    const edit = h('button', { class: 'k-btn', 'aria-expanded': 'false', onclick: () => { st.open = st.open === key ? null : key; drawBuilds(); if (st.open) ta.focus(); } }, 'Edit');
    const file = h('input', { type: 'file', hidden: true, accept: '.txt,.map,.csv,.nm,.sym,text/*', onchange: async (e) => {
      const f = e.target.files[0]; if (f) ctx.set(key, await f.text()); e.target.value = '';
    } });
    const load = h('button', { class: 'k-btn', title: 'Load a text file (nm output, .map, size -A, CSV)', onclick: () => file.click() }, 'Load file');
    const card = h('div', { class: `fsd-build fsd-${key}` },
      h('div', { class: 'fsd-bhead' }, h('span', { class: 'fsd-tag' }, key === 'before' ? 'OLD' : 'NEW'), h('b', {}, key === 'before' ? 'Old build' : 'New build'), meta, h('span', { class: 'fsd-grow' }), load, edit, file),
      ta);
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('fsd-drop'); });
    card.addEventListener('dragleave', () => card.classList.remove('fsd-drop'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault(); card.classList.remove('fsd-drop');
      const f = e.dataTransfer.files[0];
      const text = f ? await f.text() : e.dataTransfer.getData('text');
      if (text) ctx.set(key, text);
    });
    return { key, ta, meta, edit, card };
  });
  const swap = h('button', { class: 'k-btn fsd-swap', title: 'Swap old and new', 'aria-label': 'Swap old and new build',
    onclick: () => { const r = ctx.raw; ctx.setMany({ before: r.after, after: r.before }); } }, '⇄');
  const buildRow = h('section', { class: 'fsd-builds', 'aria-label': 'The two builds' }, builds[0].card, swap, builds[1].card);

  // ------------------------------------------------------------ drawing
  const headTotals = h('span', { class: 'fsd-headnums' });
  const selBar = h('div', { class: 'fsd-selbar', 'aria-live': 'polite' });
  const warns = h('div', { class: 'fsd-warns', 'aria-live': 'polite' });
  const svgWrap = h('div', { class: 'fsd-svgwrap' });
  const legend = h('div', { class: 'fsd-legend' });
  const drawing = h('section', { class: 'fsd-panel fsd-drawing' },
    h('div', { class: 'fsd-head' }, h('span', { class: 'fsd-h' }, 'The two images'), headTotals),
    warns, svgWrap, selBar, legend);

  // ------------------------------------------------------------ change list
  const counts = h('span', { class: 'fsd-soft' });
  const fenceHandle = h('button', { class: 'fsd-fence', role: 'slider', 'aria-label': 'Ignore changes under, bytes', 'aria-valuemin': '1' });
  const ruler = h('div', { class: 'fsd-ruler' });
  const axis = h('div', { class: 'fsd-axis' }, h('span', { class: 'fsd-axl' }, 'shrank'), ruler, h('span', { class: 'fsd-axr' }, 'grew'));
  const rowsEl = h('div', { class: 'fsd-rows', role: 'listbox', 'aria-label': 'Changed symbols, largest change first' });
  const changes = h('section', { class: 'fsd-panel fsd-changes' },
    h('div', { class: 'fsd-head' }, h('span', { class: 'fsd-h' }, 'Changes, largest first'), counts),
    h('div', { class: 'fsd-colhead' }, h('span', {}, ''), h('span', {}, 'symbol'), h('span', {}, 'region'), h('span', { class: 'fsd-r' }, 'old → new'), h('span', { class: 'fsd-r' }, 'change'), axis),
    rowsEl,
    h('div', { class: 'fsd-hint' }, 'Drag the amber fence on the scale to ignore small changes, and the ',
      h('b', {}, 'top N'), ' bar up or down to set how many symbols go into the report. Arrow keys work on both.'));
  const notes = h('div', { class: 'fsd-notes' });
  root.append(h('div', { class: 'fsd-page' }, buildRow, drawing, changes, h('div', { class: 'fsd-out' }, ctx.outputs), notes));

  // ------------------------------------------------------------ builds
  function drawBuilds() {
    const res = ctx.result || {};
    const D = res.diff;
    const raw = ctx.raw;
    for (const b of builds) {
      if (document.activeElement !== b.ta && b.ta.value !== String(raw[b.key] ?? '')) b.ta.value = String(raw[b.key] ?? '');
      const empty = !String(raw[b.key] ?? '').trim();
      const open = st.open === b.key || empty || !D;
      b.ta.hidden = !open;
      b.edit.textContent = open ? 'Done' : 'Edit';
      b.edit.setAttribute('aria-expanded', String(open));
      b.card.classList.toggle('fsd-open', open);
      if (D) {
        const side = b.key === 'before' ? 'old' : 'new';
        const n = D.symbols.filter((s) => s[side] > 0).length;
        b.meta.textContent = `${D.formats[side] || '?'} · ${n} symbols · ${bytes(D.total[side])}`;
      } else b.meta.textContent = empty ? 'paste or drop the text here' : 'not understood';
    }
  }

  // ------------------------------------------------------------ result in
  let lastRes = null;
  ctx.onResult((res) => {
    lastRes = res;
    drawBuilds();
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    const D = res.diff;
    if (st.sel && (!D || !D.symbols.some((s) => keyOf(s) === st.sel))) st.sel = null;
    drawDrawing();
    drawList();
  });
  new ResizeObserver(() => { if (lastRes) drawDrawing(); }).observe(svgWrap);

  // ------------------------------------------------------------ the two columns
  function reportedSet(D) {
    const rep = new Set();
    let k = 0;
    for (const s of D.symbols) {
      if (Math.abs(s.d) < D.minDelta || s.d === 0) continue;
      if (k++ < D.top) rep.add(keyOf(s));
    }
    return rep;
  }

  function drawDrawing() {
    const D = lastRes && lastRes.diff;
    svgWrap.replaceChildren();
    legend.replaceChildren();
    if (!D) {
      headTotals.textContent = '';
      selBar.textContent = '';
      svgWrap.append(h('div', { class: 'fsd-empty' }, 'Paste the symbol sizes of both builds above: nm -S output, a linker .map file, size -A, bloaty CSV or "name size" lines.'));
      return;
    }
    const tot = D.total;
    headTotals.replaceChildren(
      h('span', {}, 'flash ', h('b', { class: tone(D.flash.new - D.flash.old) }, signed(D.flash.new - D.flash.old))),
      h('span', {}, 'RAM ', h('b', { class: tone(D.ram.new - D.ram.old) }, signed(D.ram.new - D.ram.old))),
      h('span', {}, 'total ', h('b', { class: tone(tot.new - tot.old) }, signed(tot.new - tot.old)), ' B'));

    const W = Math.max(300, Math.floor(svgWrap.clientWidth || 800));
    const narrow = W < 620;
    const H = narrow ? 470 : Math.max(520, Math.min(640, Math.round(W * 0.72)));
    const colW = narrow ? 46 : 78;
    const brW = narrow ? 32 : 36;
    const labL = narrow ? 4 : Math.min(190, Math.round(W * 0.2));
    const labR = narrow ? Math.min(110, Math.round(W * 0.3)) : Math.min(270, Math.round(W * 0.3));
    const xOld = narrow ? 6 : labL + brW, xNew = W - labR - brW - colW;
    const top = 46, bottom = 14, gapR = 6;
    const present = REGIONS.filter((r) => D.symbols.some((s) => s.region === r && (s.old || s.new)));
    const k = (H - top - bottom - gapR * Math.max(0, present.length - 1)) / Math.max(1, tot.old, tot.new);
    const rep = reportedSet(D);

    // same order in both columns so the ribbons run straight: by size within a region
    const layout = { old: new Map(), new: new Map() };
    const spans = { old: {}, new: {} };
    let listIdx = 0;
    const order = [];
    for (const side of ['old', 'new']) {
      let y = top;
      for (const r of present) {
        const syms = D.symbols.filter((s) => s.region === r).sort((a, b) => Math.max(b.old, b.new) - Math.max(a.old, a.new) || a.name.localeCompare(b.name));
        const y0 = y;
        for (const s of syms) {
          const hh = s[side] > 0 ? Math.max(1, s[side] * k) : 0;
          layout[side].set(keyOf(s), { y, h: hh });
          y += hh;
          if (side === 'old') order.push(s);
        }
        spans[side][r] = [y0, y];
        y += gapR;
      }
    }
    listIdx = order.length;
    const svgH = Math.max(H, ...['old', 'new'].map((sd) => Math.max(...Object.values(spans[sd]).map((v) => v[1])) + bottom));
    const svg = sv('svg', { width: W, height: svgH, viewBox: `0 0 ${W} ${svgH}`, class: 'fsd-svg', role: 'img',
      'aria-label': `Old image ${bytes(tot.old)}, new image ${bytes(tot.new)}; ${listIdx} symbols` });

    // column heads
    const head = (x, anchor, label, total, extra) => {
      const t = sv('text', { x, y: 18, 'text-anchor': anchor, class: 'fsd-colh' });
      t.append(sv('tspan', { class: 'fsd-colk' }, label + '  '), sv('tspan', {}, bytes(total)));
      svg.append(t);
      if (extra) svg.append(extra);
    };
    const oX = narrow ? 2 : xOld + colW / 2, nX = narrow ? W - 2 : xNew + colW / 2;
    head(oX, narrow ? 'start' : 'middle', 'OLD', tot.old);
    head(nX, narrow ? 'end' : 'middle', 'NEW', tot.new,
      sv('text', { x: nX, y: 34, 'text-anchor': narrow ? 'end' : 'middle', class: `fsd-colsub ${tone(tot.new - tot.old)}` },
        `${signed(tot.new - tot.old)} B${tot.old ? ` · ${signed(Math.round(((tot.new - tot.old) / tot.old) * 1000) / 10)} %` : ''}`));

    // ribbons first, blocks over them
    const ribbons = sv('g', { class: 'fsd-ribbons' });
    const blocks = sv('g', {});
    const labels = sv('g', {});
    const x1 = xOld + colW, x2 = xNew, mx = (x1 + x2) / 2;
    order.forEach((s, i) => {
      const key = keyOf(s);
      const a = layout.old.get(key), b = layout.new.get(key);
      const cls = `fsd-rib fsd-${s.status}${rep.has(key) ? ' fsd-rep' : ''}${st.sel === key ? ' fsd-on' : ''}`;
      const d = `M${x1},${a.y}C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}L${x2},${b.y + b.h}C${mx},${b.y + b.h} ${mx},${a.y + a.h} ${x1},${a.y + a.h}Z`;
      const p = sv('path', { d, class: cls, 'data-i': i });
      p.append(sv('title', {}, tip(s)));
      ribbons.append(p);
      for (const [side, x, L] of [['old', xOld, a], ['new', xNew, b]]) {
        if (!L.h) continue;
        const r = sv('rect', { x, y: L.y, width: colW, height: L.h, class: `fsd-blk fsd-r-${s.region}${st.sel === key ? ' fsd-on' : ''}`, 'data-i': i });
        r.append(sv('title', {}, tip(s)));
        blocks.append(r);
        const want = L.h >= 13 || st.sel === key;
        if (!want) continue;
        const cy = L.y + Math.min(L.h, 400) / 2 + 4;
        if (side === 'new') {
          const lx = xNew + colW + brW + (narrow ? 8 : 4);
          const room = Math.max(4, Math.floor((labR - (narrow ? 8 : 104)) / 6.6));
          const t = sv('text', { x: lx, y: Math.max(cy, L.y + 10), class: `fsd-lab${st.sel === key ? ' fsd-lon' : ''}`, 'data-i': i });
          t.append(sv('tspan', {}, trunc(s.name, room)));
          if (!narrow) {
            t.append(sv('tspan', { class: 'fsd-labn', dx: 6 }, B(s.new)));
            if (s.d) t.append(sv('tspan', { class: `fsd-labd ${tone(s.d)}`, dx: 5 }, signed(s.d)));
          }
          labels.append(t);
        } else if (!narrow) {
          const lx = xOld - brW - 4;
          const room = Math.max(4, Math.floor((labL - 56) / 6.6));
          const t = sv('text', { x: lx, y: Math.max(cy, L.y + 10), 'text-anchor': 'end', class: `fsd-lab${st.sel === key ? ' fsd-lon' : ''}`, 'data-i': i });
          t.append(sv('tspan', {}, trunc(s.name, room)), sv('tspan', { class: 'fsd-labn', dx: 6 }, B(s.old)));
          labels.append(t);
        }
      }
    });
    svg.append(ribbons, blocks, labels);

    // flash / RAM brackets beside each column
    const bracket = (side, x, dir) => {
      const sp = spans[side];
      const flashR = ['text', 'rodata', 'data'].filter((r) => sp[r]);
      const ramR = ['data', 'bss'].filter((r) => sp[r]);
      const draw = (regs, off, label, val) => {
        if (!regs.length) return;
        const y0 = sp[regs[0]][0], y1 = sp[regs[regs.length - 1]][1];
        if (y1 - y0 < 2) return;
        const bx = x + dir * off;
        svg.append(sv('path', { d: `M${bx - dir * 4},${y0}H${bx}V${y1}H${bx - dir * 4}`, class: `fsd-br fsd-br-${label}` }));
        if (y1 - y0 > 46) {
          const ty = (y0 + y1) / 2;
          svg.append(sv('text', { x: bx + dir * 4, y: ty, class: `fsd-brt fsd-br-${label}`, transform: `rotate(-90 ${bx + dir * 4} ${ty})`, 'text-anchor': 'middle', dy: dir > 0 ? 9 : -2 },
            `${label} ${B(val)}`));
        }
      };
      draw(flashR, 8, 'flash', D.flash[side]);
      draw(ramR, 22, 'RAM', D.ram[side]);
    };
    if (D.symbols.some((s) => s.region !== 'other')) {
      if (!narrow) bracket('old', xOld, -1);
      bracket('new', xNew + colW, 1);
    }

    // hover joins block, ribbon and label of one symbol; click selects it
    const hot = (i, on) => { for (const el of svg.querySelectorAll(`[data-i="${i}"]`)) el.classList.toggle('fsd-hot', on); };
    svg.addEventListener('pointerover', (e) => { const i = e.target.closest('[data-i]')?.dataset.i; if (i != null) hot(i, true); });
    svg.addEventListener('pointerout', (e) => { const i = e.target.closest('[data-i]')?.dataset.i; if (i != null) hot(i, false); });
    svg.addEventListener('click', (e) => {
      const i = e.target.closest('[data-i]')?.dataset.i;
      select(i == null ? null : keyOf(order[i]));
    });
    svgWrap.append(svg);

    // region legend = the by-region table
    legend.replaceChildren(...D.regions.map((r) => h('span', { class: 'fsd-lg', title: REGION_NOTE[r.region] },
      h('i', { class: `fsd-sw fsd-r-${r.region}` }), h('b', {}, r.region), ` ${B(r.old)} → ${B(r.new)} `, h('span', { class: tone(r.d) }, signed(r.d))),
    ), h('span', { class: 'fsd-lg fsd-soft' }, h('i', { class: 'fsd-sw fsd-sw-grew' }), 'grew / new'),
    h('span', { class: 'fsd-lg fsd-soft' }, h('i', { class: 'fsd-sw fsd-sw-shrank' }), 'shrank / gone'));
    drawSel();
  }

  function drawSel() {
    const D = lastRes && lastRes.diff;
    const s = D && st.sel ? D.symbols.find((x) => keyOf(x) === st.sel) : null;
    if (!s) { selBar.replaceChildren(h('span', { class: 'fsd-soft' }, 'Click a block, a ribbon or a row to follow one symbol.')); return; }
    selBar.replaceChildren(h('b', { class: 'fsd-mono' }, s.name, s.dup > 1 ? h('span', { class: 'fsd-soft' }, ` ×${s.dup}`) : null),
      h('span', { class: 'fsd-chip' }, h('i', { class: `fsd-sw fsd-r-${s.region}` }), s.region),
      h('span', { class: 'fsd-mono' }, `${s.old ? B(s.old) : '–'} → ${s.new ? B(s.new) : '–'} B`),
      h('b', { class: `fsd-mono ${tone(s.d)}` }, signed(s.d)),
      h('span', { class: 'fsd-soft' }, s.status + (s.old && s.new ? ` · ${signed(Math.round((s.d / s.old) * 1000) / 10)} %` : '')),
      h('button', { class: 'k-btn fsd-clear', onclick: () => select(null) }, 'Clear'));
  }

  function select(key) {
    st.sel = st.sel === key ? null : key;
    drawDrawing();
    for (const r of rowsEl.querySelectorAll('.fsd-row')) {
      const on = r.dataset.k === st.sel;
      r.classList.toggle('fsd-on', on);
      r.setAttribute('aria-selected', String(on));
    }
  }

  // ------------------------------------------------------------ list with fences
    function logPos(v, maxAbs) { return 0.96 * Math.log10(1 + Math.abs(v)) / Math.log10(1 + maxAbs); }

  function drawList() {
    const D = lastRes && lastRes.diff;
    rowsEl.replaceChildren();
    ruler.replaceChildren();
    if (!D) { counts.textContent = ''; return; }
    const moved = D.symbols.filter((s) => s.d !== 0);
    const same = D.symbols.length - moved.length;
    const by = (x) => moved.filter((s) => s.status === x).length;
    counts.textContent = `${moved.length} changed · ${by('added')} new · ${by('removed')} gone · ${by('grew')} grew · ${by('shrank')} shrank`;
    const maxAbs = Math.max(2, ...moved.map((s) => Math.abs(s.d)), D.minDelta * 2);
    const fence = logPos(D.minDelta, maxAbs);
    rowsEl.style.setProperty('--fence', fence);
    ruler.style.setProperty('--fence', fence);

    // ruler ticks, mirrored: 1 10 100 1k ...
    const half = (ruler.clientWidth || 160) / 2;
    const decade = (logPos(10, maxAbs) - logPos(1, maxAbs)) * half;
    for (let v = 1; v <= maxAbs * 1.0001; v *= 10) {
      const p = logPos(v, maxAbs);
      const label = v >= 1000 ? `${v / 1000}k` : String(v);
      const show = decade > 19 || v === 1 || (decade > 12 && Math.log10(v) % 2 === 0);
      for (const sgn of [-1, 1]) {
        ruler.append(h('span', { class: 'fsd-tick', style: `left:${50 + sgn * p * 50}%` }, sgn > 0 && show && v > 1 ? label : ''));
      }
    }
    ruler.append(h('span', { class: 'fsd-tick', style: 'left:50%' }, '0'));
    fenceHandle.style.left = `${50 + fence * 50}%`;
    fenceHandle.style.transform = fence > 0.8 ? 'translateX(-100%)' : fence < 0.1 ? 'translateX(-20%)' : '';
    fenceHandle.setAttribute('aria-valuenow', String(D.minDelta));
    fenceHandle.setAttribute('aria-valuetext', `ignore changes under ${D.minDelta} bytes`);
    fenceHandle.title = `Ignore changes under ${D.minDelta} B: drag`;
    fenceHandle.textContent = `${B(D.minDelta)}`;
    ruler.append(h('span', { class: 'fsd-fenceL', style: `left:${50 - fence * 50}%` }), fenceHandle);

    const rep = reportedSet(D);
    const counted = moved.filter((s) => Math.abs(s.d) >= D.minDelta).length;
    const cutAt = Math.min(D.top, counted);
    moved.forEach((s, i) => {
      if (i === cutAt) rowsEl.append(cutBar(D, counted));
      const key = keyOf(s);
      const below = Math.abs(s.d) < D.minDelta;
      const p = logPos(s.d, maxAbs) * 50;
      const bar = h('span', { class: 'fsd-bar' },
        h('i', { class: `fsd-fill ${s.d > 0 ? 'fsd-up' : 'fsd-dn'}`, style: s.d > 0 ? `left:50%;width:${p}%` : `right:50%;width:${p}%` }));
      const row = h('div', { class: `fsd-row${below ? ' fsd-below' : rep.has(key) ? '' : ' fsd-cut'}${st.sel === key ? ' fsd-on' : ''}`,
        role: 'option', tabindex: i === 0 ? '0' : '-1', 'aria-selected': String(st.sel === key), 'data-k': key, 'data-n': i,
        title: tip(s) + (below ? ' (under the ignore fence)' : rep.has(key) ? '' : ' (past the top-N cut, not in the report)'),
        onclick: () => select(key) },
      h('span', { class: `fsd-g fsd-${s.status}` }, GLYPH[s.status]),
      h('span', { class: 'fsd-name' }, s.name, s.dup > 1 ? h('small', {}, ` ×${s.dup}`) : null),
      h('span', { class: 'fsd-reg' }, h('i', { class: `fsd-sw fsd-r-${s.region}` }), s.region),
      h('span', { class: 'fsd-on2 fsd-r' }, `${s.old ? B(s.old) : '–'} → ${s.new ? B(s.new) : '–'}`),
      h('b', { class: `fsd-dv ${tone(s.d)}` }, signed(s.d)),
      bar);
      rowsEl.append(row);
    });
    if (cutAt >= moved.length) rowsEl.append(cutBar(D, counted));
    if (same) rowsEl.append(h('div', { class: 'fsd-same' }, `${same} symbol${same > 1 ? 's' : ''} unchanged`));
    if (!moved.length) rowsEl.append(h('div', { class: 'fsd-same' }, 'No symbol changed size.'));
  }

  function cutBar(D, counted) {
    const n = Math.min(D.top, counted);
    const bar = h('div', { class: 'fsd-cutbar', role: 'slider', tabindex: '0', 'aria-label': 'Symbols in the report (top N)',
      'aria-valuemin': '1', 'aria-valuenow': String(D.top), 'aria-valuetext': `top ${D.top}` },
    h('span', { class: 'fsd-grip', 'aria-hidden': 'true' }, '⋮⋮'),
    h('b', {}, `top ${D.top}`),
    h('span', {}, D.top >= counted ? ` - all ${counted} counted change${counted === 1 ? '' : 's'} are in the report` : ` in the report · ${counted - n} more below the cut`));
    bar.addEventListener('keydown', (e) => {
      const d = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[e.key];
      if (d == null) return;
      e.preventDefault();
      const base = Math.min(D.top, counted);
      ctx.set('top', String(Math.max(1, Math.min(Math.max(counted, 1), base + d))));
      requestAnimationFrame(() => rowsEl.querySelector('.fsd-cutbar')?.focus());
    });
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { bar.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      bar.classList.add('fsd-dragging');
      const move = (ev) => {
        const rows = [...rowsEl.querySelectorAll('.fsd-row')];
        let n2 = rows.length;
        for (const r of rows) {
          const b = r.getBoundingClientRect();
          if (ev.clientY < b.top + b.height / 2) { n2 = Number(r.dataset.n); break; }
        }
        n2 = Math.max(1, Math.min(n2, counted || 1));
        if (n2 !== Math.min(ctx.result?.diff?.top ?? 0, counted)) ctx.set('top', String(n2));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); requestAnimationFrame(() => rowsEl.querySelector('.fsd-cutbar')?.focus()); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return bar;
  }

  // the fence: drag along the log scale, arrows step by powers of two
  const fenceFrom = (clientX) => {
    const D = lastRes?.diff; if (!D) return;
    const b = ruler.getBoundingClientRect();
    const moved = D.symbols.filter((s) => s.d !== 0);
    const maxAbs = Math.max(2, ...moved.map((s) => Math.abs(s.d)), D.minDelta * 2);
    const f = Math.min(1, Math.abs((clientX - (b.left + b.width / 2)) / (b.width / 2)) / 0.96);
    let v = 10 ** (f * Math.log10(1 + maxAbs)) - 1;
    v = v < 10 ? Math.max(1, Math.round(v)) : v < 100 ? Math.round(v) : Number(v.toPrecision(2));
    if (v !== D.minDelta) ctx.set('minDelta', String(v));
  };
  fenceHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { fenceHandle.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    fenceHandle.focus();
    const move = (ev) => fenceFrom(ev.clientX);
    const up = () => { fenceHandle.removeEventListener('pointermove', move); fenceHandle.removeEventListener('pointerup', up); };
    fenceHandle.addEventListener('pointermove', move);
    fenceHandle.addEventListener('pointerup', up);
  });
  ruler.addEventListener('pointerdown', (e) => { if (e.target === ruler || e.target.classList.contains('fsd-tick')) fenceFrom(e.clientX); });
  fenceHandle.addEventListener('keydown', (e) => {
    const D = lastRes?.diff; if (!D) return;
    const cur = D.minDelta;
    let v = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = STEPS.find((x) => x > cur) ?? cur;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = [...STEPS].reverse().find((x) => x < cur) ?? 1;
    else if (e.key === 'Home') v = 1;
    if (v == null) return;
    e.preventDefault();
    ctx.set('minDelta', String(v));
  });

  // list keyboard: up/down moves the selection
  rowsEl.addEventListener('keydown', (e) => {
    const row = e.target.closest('.fsd-row');
    if (!row) return;
    let next = null;
    if (e.key === 'ArrowDown') next = row.nextElementSibling;
    else if (e.key === 'ArrowUp') next = row.previousElementSibling;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(row.dataset.k); return; }
    else return;
    while (next && !next.classList.contains('fsd-row')) next = e.key === 'ArrowDown' ? next.nextElementSibling : next.previousElementSibling;
    e.preventDefault();
    if (!next) return;
    row.tabIndex = -1; next.tabIndex = 0; next.focus();
    st.sel = null; select(next.dataset.k);
  });
}

function tone(d) { return d > 0 ? 'fsd-t-up' : d < 0 ? 'fsd-t-dn' : 'fsd-t-0'; }
function trunc(s, n) { return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; }
function tip(s) { return `${s.name} (${s.region}): ${s.old ? B(s.old) : '–'} → ${s.new ? B(s.new) : '–'} B, ${signed(s.d)} B, ${s.status}${s.dup > 1 ? `, ${s.dup} symbols of this name` : ''}`; }
