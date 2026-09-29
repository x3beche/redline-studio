// Buildhistory Diff, drawn as the thing itself: a waterfall from build A's
// installed size to build B's, one step per package (or directory), largest
// first, so the bars add up on screen to the change you are chasing.
//   Click a row (or focus it and press Enter) to see that package's versions,
//   sizes and changed files on the right; the chips above the chart filter by
//   what happened; drag the "more" row's grip down to draw more rows; paste or
//   drop the buildhistory files into the four boxes below. Arrow keys move
//   between rows. Every number drawn comes from run()'s result.draw.

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

const ST = {
  added: { g: '+', label: 'added', cls: 'st-add' },
  removed: { g: '−', label: 'removed', cls: 'st-rem' },
  upgraded: { g: '↑', label: 'version up', cls: 'st-up' },
  downgraded: { g: '↓', label: 'version down', cls: 'st-down' },
  resized: { g: 'Δ', label: 'size only', cls: 'st-size' },
  moved: { g: '→', label: 'moved', cls: 'st-size' },
  changed: { g: '*', label: 'mode/owner/link', cls: 'st-size' },
  same: { g: '=', label: 'unchanged', cls: 'st-same' },
};
const DEV = /-(dev|dbg|staticdev|src|ptest|doc)$/;

const kib = (v) => {
  if (v == null || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 10240) return `${(v / 1024).toFixed(1)} MiB`;
  if (a >= 100 || Number.isInteger(v)) return `${Math.round(v)} KiB`;
  return `${v.toFixed(1)} KiB`;
};
const sgn = (v, f = kib) => (v > 0 ? '+' : v < 0 ? '−' : '±') + f(Math.abs(v));
const bytes = (v) => {
  const a = Math.abs(v);
  if (a >= 1048576) return `${(v / 1048576).toFixed(2)} MiB`;
  if (a >= 1024) return `${(v / 1024).toFixed(1)} KiB`;
  return `${v} B`;
};
const ok = (...a) => a.flat().filter((x) => x != null && x !== false);
// 5.15.71+gitAUTOINC+b5b2d5e9f0_c21e6e8dc2 -> 5.15.71+git on the chart; the detail keeps it whole
const shortV = (v) => String(v || '').replace(/\+git(AUTOINC)?\+[0-9a-f_]+/i, '+git');
const clip = (t, n) => (t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t);

export function page(root, ctx) {
  const wrap = h('div', { class: 'bhd' });
  root.append(wrap);
  let res = null, mode = 'waterfall', focusKey = null, dragging = false;
  try { mode = localStorage.getItem('redline.bhd.mode') || 'waterfall'; } catch { /* private window */ }

  // ---------- summary + filters ----------
  const sum = h('div', { class: 'bhd-sum' });
  const chips = h('div', { class: 'bhd-chips', role: 'group', 'aria-label': 'Show' });

  // ---------- toolbar ----------
  const modeBtns = ['waterfall', 'deltas'].map((m) => h('button', { type: 'button', 'data-m': m, onclick: () => {
    mode = m; try { localStorage.setItem('redline.bhd.mode', m); } catch { /* ignore */ }
    draw();
  } }, m === 'waterfall' ? 'Waterfall' : 'Deltas'));
  const seg = h('span', { class: 'bhd-seg', role: 'group', 'aria-label': 'Chart' }, modeBtns);
  const sortSel = h('select', { 'aria-label': 'Sort', onchange: (e) => ctx.set('sort', e.target.value) },
    [['abs', 'largest change'], ['growth', 'most growth'], ['shrink', 'most shrink'], ['name', 'name'], ['after', 'size in B']].map(([v, t]) => h('option', { value: v }, t)));
  const bySel = h('select', { 'aria-label': 'Rows are', onchange: (e) => ctx.set('by', e.target.value) },
    [['auto', 'auto'], ['packages', 'packages'], ['dirs', 'directories']].map(([v, t]) => h('option', { value: v }, t)));
  const depthSel = h('select', { 'aria-label': 'Directory depth', onchange: (e) => ctx.set('depth', e.target.value) },
    ['1', '2', '3', '4'].map((v) => h('option', { value: v }, `depth ${v}`)));
  const minIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Minimum size change in KiB', class: 'num',
    oninput: (e) => ctx.set('minKiB', e.target.value) });
  const topIn = h('input', { type: 'text', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Rows drawn', class: 'num',
    oninput: (e) => ctx.set('top', e.target.value) });
  const bar = h('div', { class: 'bhd-bar' },
    seg,
    h('label', {}, 'Sort', sortSel),
    h('label', { class: 'by' }, 'Rows', bySel, depthSel),
    h('label', {}, 'Rows drawn', topIn),
    h('label', {}, 'Min Δ', minIn, h('span', { class: 'u' }, 'KiB')));

  const svg = s('svg', { class: 'bhd-svg', role: 'group', 'aria-label': 'Size waterfall' });
  const warnBox = h('div', { class: 'bhd-warns', role: 'status', 'aria-live': 'polite' });
  const varBox = h('div', { class: 'bhd-vars' });
  const chartCard = h('section', { class: 'bhd-card' },
    h('div', { class: 'bhd-head' }, sum), chips, bar, warnBox, varBox, h('div', { class: 'bhd-chartwrap' }, svg),
    h('div', { class: 'bhd-help' }, h('span', { class: 'legend' }, h('b', { class: 'st-add' }, '+'), ' added ', h('b', { class: 'st-rem' }, '−'), ' removed ',
      h('b', { class: 'st-up' }, '↑'), ' version up ', h('b', { class: 'st-down' }, '↓'), ' down ', h('b', {}, 'Δ'), ' size only ', h('b', { class: 'st-down' }, '!'), ' finding · ',
      h('i', { class: 'sw grow' }), ' grows ', h('i', { class: 'sw shrink' }), ' shrinks; solid = added or removed'), h('br'), 'Click a row for its versions and files. ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' move, ',
      h('kbd', {}, 'Enter'), ' opens. Drag the grip on the last row, or focus it and press ', h('kbd', {}, '↑'), '/', h('kbd', {}, '↓'), ', to draw fewer or more rows.'));

  // ---------- detail ----------
  const detail = h('div', { class: 'bhd-detail' });
  const detailCard = h('section', { class: 'bhd-card' }, detail);

  // ---------- inputs ----------
  const boxes = {};
  const badges = {};
  let typing = null;
  const box = (key, title, hint) => {
    const ta = h('textarea', { spellcheck: 'false', rows: 7, 'aria-label': title, placeholder: hint,
      oninput: (e) => { clearTimeout(typing); const v = e.target.value; typing = setTimeout(() => ctx.set(key, v), 220); } });
    ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.classList.add('drop'); });
    ta.addEventListener('dragleave', () => ta.classList.remove('drop'));
    ta.addEventListener('drop', (e) => {
      e.preventDefault(); ta.classList.remove('drop');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      Promise.all(files.map((f) => f.text())).then((texts) => { ta.value = texts.join('\n'); ctx.set(key, ta.value); });
    });
    boxes[key] = ta;
    badges[key] = h('span', { class: 'badge' });
    return h('div', { class: 'bhd-box' }, h('div', { class: 'bhd-boxhead' }, h('b', {}, title), badges[key]), ta);
  };
  const swap = h('button', { class: 'k-btn', type: 'button', onclick: () => {
    const r = ctx.raw;
    ctx.setMany({ before: r.after, after: r.before, filesBefore: r.filesAfter, filesAfter: r.filesBefore });
    syncInputs(true);
  } }, 'Swap A ↔ B');
  const inCard = h('section', { class: 'bhd-card' },
    h('div', { class: 'bhd-head' }, h('h2', {}, 'Buildhistory files'),
      h('span', { class: 'bhd-sub' }, 'from buildhistory/images/<machine>/<libc>/<image>/ - paste or drop; several files per box are fine'), h('span', { class: 'push' }, swap)),
    h('div', { class: 'bhd-boxes' },
      box('before', 'Build A (before)', 'installed-package-info.txt, installed-package-sizes.txt, installed-packages.txt, image-info.txt ...'),
      box('after', 'Build B (after)', 'the same file(s) from the newer build'),
      box('filesBefore', 'Build A files-in-image.txt', 'optional: file-level diff'),
      box('filesAfter', 'Build B files-in-image.txt', 'optional')));

  const notesBox = h('details', { class: 'bhd-notes' }, h('summary', {}, 'Notes'));
  wrap.append(h('div', { class: 'bhd-col main' }, chartCard, inCard, notesBox), h('div', { class: 'bhd-col side' }, detailCard, ctx.outputs));

  // ---------- sync controls from the input ----------
  function syncInputs(force) {
    const r = ctx.raw;
    for (const k of Object.keys(boxes)) if ((force || document.activeElement !== boxes[k]) && boxes[k].value !== (r[k] ?? '')) boxes[k].value = r[k] ?? '';
    if (sortSel.value !== r.sort) sortSel.value = r.sort || 'abs';
    if (bySel.value !== r.by) bySel.value = r.by || 'auto';
    depthSel.value = String(r.depth || '2');
    if (document.activeElement !== minIn) minIn.value = r.minKiB ?? '';
    if (document.activeElement !== topIn) topIn.value = r.top ?? '';
  }

  // ---------- drawing ----------
  function drawSummary(d) {
    const t = d.totals, dd = t.b - t.a;
    const p = t.a > 0 ? (dd / t.a) * 100 : 0;
    const big = Math.abs(p) >= 10 && d.sizes;
    sum.replaceChildren(...ok(
      h('span', { class: 'tot' }, h('small', {}, 'A'), h('b', {}, d.sizes ? kib(t.a) : `${d.npk.a} pkgs`)),
      h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'tot' }, h('small', {}, 'B'), h('b', {}, d.sizes ? kib(t.b) : `${d.npk.b} pkgs`)),
      d.sizes ? h('span', { class: `delta ${big ? 'warn' : ''}` }, h('b', {}, sgn(dd)), ` ${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`) : null,
      t.imgA != null ? h('span', { class: 'img', title: 'image-info.txt IMAGESIZE: du -ks of the rootfs' }, 'IMAGESIZE ', h('b', {}, `${kib(t.imgA)} → ${kib(t.imgB)}`)) : null,
      h('span', { class: 'what' }, d.by === 'dirs' ? `directories of files-in-image.txt, depth ${d.depth}` : [...new Set([...d.kinds.a, ...d.kinds.b])].filter((k) => k !== 'image-info.txt').join(' + ') || 'nothing read yet')));
    const cur = ctx.raw.show || 'changed';
    const c = d.counts;
    const list = [['changed', 'All changes', c.added + c.removed + c.upgraded + c.downgraded + c.resized],
      ['added', 'Added', c.added], ['removed', 'Removed', c.removed], ['version', 'Version', c.upgraded + c.downgraded],
      ['size', 'Size', null], ['all', 'Everything', null]];
    chips.replaceChildren(...list.map(([v, t, n]) => h('button', { type: 'button', class: `chip ${v === 'version' && c.downgraded ? 'has-warn' : ''}`, 'aria-pressed': String(cur === v),
      onclick: () => ctx.set('show', v) }, t, n != null ? h('span', { class: 'n' }, v === 'version' && c.downgraded ? `${c.upgraded}↑ ${c.downgraded}↓` : String(n)) : null)));
  }

  function draw() {
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.m === mode));
    if (!res || !res.draw) return;
    const d = res.draw;
    drawSummary(d);
    const had = svg.contains(document.activeElement) ? document.activeElement.getAttribute('data-id') : null;
    svg.replaceChildren();
    const W = Math.max(300, Math.floor(svg.parentNode.clientWidth || 800));
    const narrow = W < 620;
    const rowH = 24, top = 28;
    const labW = narrow ? Math.min(150, W * 0.42) : Math.min(360, Math.max(240, W * 0.34));
    const x0 = labW + 8, x1 = W - (narrow ? 56 : 92);
    const sized = d.sizes;
    const seq = [];
    if (mode === 'waterfall' && sized) seq.push({ kind: 'total', name: 'Build A', v: d.totals.a });
    for (const r of d.rows) seq.push({ kind: 'row', r });
    const moreN = d.restCount;
    const otherD = mode === 'waterfall' ? d.unlistedD : d.restD;
    if (moreN || (mode === 'waterfall' && sized && Math.abs(otherD) > 0.05)) seq.push({ kind: 'more', n: moreN, d: otherD });
    if (mode === 'waterfall' && sized) seq.push({ kind: 'total', name: 'Build B', v: d.totals.b });
    if (!d.rows.length && !seq.length) {
      svg.setAttribute('viewBox', `0 0 ${W} 60`); svg.setAttribute('height', 60);
      svg.append(s('text', { x: 12, y: 34, class: 'soft' }, 'Nothing to show for this filter. Pick "All changes" above, or paste the buildhistory files below.'));
      return;
    }
    const H = top + seq.length * rowH + 10;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);

    // scale
    let X, lo, hi;
    if (mode === 'waterfall' && sized) {
      let cum = d.totals.a; const pts = [cum];
      for (const q of seq) if (q.kind === 'row') { cum += q.r.d; pts.push(cum); } else if (q.kind === 'more') { cum += q.d; pts.push(cum); }
      pts.push(d.totals.b);
      lo = Math.min(...pts); hi = Math.max(...pts);
      const span = hi - lo || Math.max(1, hi * 0.05);
      lo -= span * 0.12; hi += span * 0.04;
      lo = Math.max(0, lo);
    } else {
      const m = Math.max(1, ...d.rows.map((r) => Math.abs(r.d)), Math.abs(otherD || 0));
      lo = -m; hi = m;
      if (d.rows.every((r) => r.d >= 0) && (otherD || 0) >= 0) lo = 0;
      if (d.rows.every((r) => r.d <= 0) && (otherD || 0) <= 0) hi = 0;
    }
    X = (v) => x0 + ((v - lo) / (hi - lo || 1)) * (x1 - x0);

    // axis
    if (sized) {
      const ticks = x1 - x0 < 220 ? 1 : x1 - x0 < 420 ? 2 : 4;
      for (let k = 0; k <= ticks; k++) {
        const v = lo + ((hi - lo) * k) / ticks;
        svg.append(s('line', { x1: X(v), x2: X(v), y1: top - 6, y2: H - 6, class: 'grid' }));
        svg.append(s('text', { x: X(v), y: top - 10, 'text-anchor': k === 0 ? 'start' : k === ticks ? 'end' : 'middle', class: 'axis' }, kib(v)));
      }
      if (lo < 0 && hi > 0) svg.append(s('line', { x1: X(0), x2: X(0), y1: top - 6, y2: H - 6, class: 'zero' }));
    } else {
      svg.append(s('text', { x: x0, y: top - 10, class: 'axis' }, 'no sizes in these files: versions and presence only'));
    }

    let cum = d.totals.a;
    const rowEls = [];
    seq.forEach((q, i) => {
      const y = top + i * rowH;
      const cy = y + rowH / 2;
      if (i % 2) svg.append(s('rect', { x: 0, y, width: W, height: rowH, class: 'stripe' }));
      if (q.kind === 'total') {
        const g = s('g', { class: 'total' });
        g.append(s('text', { x: 8, y: cy + 4, class: 'lbl strong' }, q.name));
        const xa = X(lo), xb = X(q.v);
        g.append(s('rect', { x: xa, y: y + 4, width: Math.max(1, xb - xa), height: rowH - 8, class: 'bar-total', rx: 2 }));
        // broken-axis mark: the bar starts well below the axis minimum
        if (lo > 0) g.append(s('path', { d: `M${xa + 10},${y + 3} l4,${rowH - 6} M${xa + 15},${y + 3} l4,${rowH - 6}`, class: 'brk' }));
        g.append(s('text', { x: Math.min(xb + 6, W - 4), y: cy + 4, class: 'val strong', 'text-anchor': xb + 70 > W ? 'end' : 'start' }, kib(q.v)));
        svg.append(g);
        return;
      }
      if (q.kind === 'more') {
        const g = s('g', { class: 'more', tabindex: 0, role: 'slider', 'data-id': 'more', 'aria-label': `Rows drawn: ${d.rows.length}. ${q.n} more rows sum to ${sgn(q.d)}`,
          'aria-valuenow': d.rows.length, 'aria-valuemin': 1, 'aria-valuemax': d.shownCount });
        g.append(s('rect', { x: 2, y: y + 2, width: labW, height: rowH - 4, class: 'ring', rx: 3 }));
        g.append(s('path', { d: `M10,${cy - 3} h12 M10,${cy + 1} h12 M10,${cy + 5} h12`, class: 'grip' }));
        g.append(s('text', { x: 30, y: cy + 4, class: 'lbl soft' }, q.n ? `${q.n} more ${d.by === 'dirs' ? 'directories' : 'packages'}${mode === 'waterfall' && Math.abs(q.d - d.restD) > 0.05 ? ' + hidden' : ''}` : 'hidden / unchanged-filter rest'));
        if (sized) {
          const a = mode === 'waterfall' ? cum : 0, b = a + q.d;
          const xa = X(Math.min(a, b)), xb = X(Math.max(a, b));
          g.append(s('rect', { x: xa, y: y + 6, width: Math.max(1, xb - xa), height: rowH - 12, class: `bar ${q.d >= 0 ? 'grow' : 'shrink'} rest`, rx: 2 }));
          g.append(s('text', { x: Math.min(xb + 5, W - 4), y: cy + 4, class: 'val soft', 'text-anchor': xb + 60 > W ? 'end' : 'start' }, sgn(q.d)));
          if (mode === 'waterfall') cum = b;
        }
        let startY = 0, startTop = 0;
        g.addEventListener('pointerdown', (ev) => {
          ev.preventDefault(); g.focus({ preventScroll: true });
          startY = ev.clientY; startTop = d.rows.length; dragging = true;
          const move = (e) => {
            const n = Math.max(1, Math.min(d.shownCount || 1, startTop + Math.round((e.clientY - startY) / (rowH * svg.getBoundingClientRect().height / H))));
            if (String(n) !== String(ctx.raw.top)) ctx.set('top', n);
          };
          const up = () => { dragging = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
          window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
        });
        g.addEventListener('keydown', (e) => {
          const step = e.shiftKey ? 5 : 1;
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); ctx.set('top', Math.min(d.shownCount || 1, d.rows.length + step)); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault();
            ctx.set('top', Math.max(1, d.rows.length - step));
          }
        });
        svg.append(g);
        return;
      }
      // a package / directory row
      const r = q.r, st = ST[r.st] || ST.same;
      const sel = focusKey === r.key;
      const dev = d.by === 'packages' && r.st === 'added' && DEV.test(r.key);
      const flag = dev || r.st === 'downgraded';
      const g = s('g', { class: `row ${sel ? 'sel' : ''}`, tabindex: 0, role: 'button', 'data-id': `r:${r.key}`, 'aria-pressed': String(sel),
        'aria-label': `${r.name}: ${st.label}${sized ? `, ${sgn(r.d)}` : ''}${r.va || r.vb ? `, ${r.va || '–'} to ${r.vb || '–'}` : ''}` });
      g.append(s('rect', { x: 2, y: y + 1, width: W - 4, height: rowH - 2, rx: 3, class: 'ring' }));
      g.append(s('text', { x: 16, y: cy + 4, class: `glyph ${st.cls}`, 'text-anchor': 'middle' }, st.g));
      const nameMax = Math.floor((labW - 30 - (flag ? 14 : 0)) / 6.7);
      const showVer = !narrow && d.by === 'packages' && (r.va || r.vb);
      const verTxt = r.st === 'upgraded' || r.st === 'downgraded' ? `${shortV(r.va) || '?'} → ${shortV(r.vb) || '?'}` : shortV(r.vb || r.va || '');
      const label = r.newName || r.name;
      const nm = s('text', { x: 28, y: cy + 4, class: 'lbl' }, clip(label, showVer ? Math.max(8, Math.min(nameMax, 30)) : nameMax));
      g.append(nm);
      if (showVer) {
        const used = Math.min(label.length, Math.max(8, Math.min(nameMax, 30))) * 6.7 + 36;
        const left = Math.floor((labW - used) / 6.1);
        if (left > 6) g.append(s('text', { x: used, y: cy + 4, class: `ver ${r.st === 'downgraded' ? 'warn' : ''}` }, clip(verTxt, left)));
      }
      if (flag) {
        const t = s('text', { x: labW - 4, y: cy + 4, 'text-anchor': 'end', class: 'flag' }, '!');
        t.append(s('title', {}, dev ? 'development/debug package in the image' : 'version went down'));
        g.append(t);
      }
      if (sized) {
        const a = mode === 'waterfall' ? cum : 0, b = a + r.d;
        const xa = X(Math.min(a, b)), xb = X(Math.max(a, b));
        g.append(s('rect', { x: xa, y: y + 5, width: Math.max(1.5, xb - xa), height: rowH - 10, rx: 2,
          class: `bar ${r.d > 0 ? 'grow' : r.d < 0 ? 'shrink' : 'flat'} ${r.st === 'added' || r.st === 'removed' ? 'solid' : ''}` }));
        if (mode === 'waterfall' && i > 0) svg.append(s('line', { x1: X(a), x2: X(a), y1: y - rowH + 5, y2: y + 5, class: 'conn' }));
        const lab = `${sgn(r.d)}${!narrow && r.a != null && r.b != null && r.a > 0 ? `  ${r.pct >= 0 ? '+' : '−'}${Math.abs(r.pct).toFixed(r.pct && Math.abs(r.pct) < 10 ? 1 : 0)}%` : ''}`;
        const room = W - xb - 6;
        const inside = room < lab.length * 6.3 + 4;
        g.append(s('text', { x: inside ? xa - 5 : xb + 5, y: cy + 4, class: `val ${r.d > 0 ? 'g' : r.d < 0 ? 'k' : 'soft'}`, 'text-anchor': inside ? 'end' : 'start' }, lab));
        if (mode === 'waterfall') cum = b;
      } else {
        g.append(s('text', { x: x0, y: cy + 4, class: `ver ${r.st === 'downgraded' ? 'warn' : ''}` }, clip(verTxt || st.label, Math.floor((W - x0) / 6.2))));
      }
      g.addEventListener('click', () => pick(r.key));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r.key); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          const all = [...svg.querySelectorAll('g.row, g.more')];
          const k = all.indexOf(g);
          const n = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : Math.max(0, Math.min(all.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)));
          all[n]?.focus();
        }
      });
      rowEls.push(g);
      svg.append(g);
    });
    if (had) svg.querySelector(`[data-id="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
    else if (dragging) svg.querySelector('[data-id="more"]')?.focus({ preventScroll: true });
  }

  function pick(key) {
    focusKey = key;
    ctx.set('focus', key);
  }

  function drawDetail() {
    const d = res && res.draw;
    const f = d && d.focus;
    if (!f) {
      detail.replaceChildren(h('div', { class: 'empty' }, 'Nothing selected. Click a row in the chart.'));
      return;
    }
    const st = ST[f.st] || ST.same;
    const max = Math.max(1, f.a || 0, f.b || 0);
    const sizeBar = (label, v, cls) => h('div', { class: 'sz' }, h('span', { class: 'k' }, label),
      h('span', { class: 'track' }, h('i', { class: cls, style: `width:${v == null ? 0 : Math.max(0.5, (v / max) * 100)}%` })),
      h('b', {}, v == null ? (label === 'A' ? 'not in A' : 'not in B') : d.by === 'dirs' ? kib(v) : kib(v)));
    const files = (f.files || []).map((x) => {
      const fs = ST[x.st] || ST.changed;
      return h('li', { class: fs.cls },
        h('span', { class: `glyph ${fs.cls}`, title: fs.label }, fs.g),
        h('span', { class: 'p', title: x.from ? `${x.from} → ${x.path}` : x.path }, x.from ? h('span', { class: 'from' }, `${x.from} → `) : null, x.path,
          x.target ? h('span', { class: 'from' }, ` → ${x.target}`) : null, x.what ? h('em', {}, ` ${x.what}`) : null,
          x.mode && /^-.......w/.test(x.mode) && x.st !== 'removed' ? h('em', { class: 'warn' }, ` ${x.mode} world-writable`) : null),
        h('span', { class: `d ${x.d > 0 ? 'g' : x.d < 0 ? 'k' : ''}` }, x.mode && x.mode[0] !== '-' ? x.mode[0] === 'l' ? 'link' : x.mode[0] === 'd' ? 'dir' : '' : sgn(x.d, bytes)));
    });
    const title = f.newName ? `${f.key} → ${f.newName}` : f.name;
    const dev = d.by === 'packages' && f.st === 'added' && DEV.test(f.key);
    detail.replaceChildren(...ok(
      h('div', { class: 'dh' }, h('span', { class: `pill ${st.cls}` }, `${st.g} ${st.label}`), h('h2', { title }, title)),
      f.pn ? h('div', { class: 'meta' }, 'recipe ', h('b', {}, f.pn)) : null,
      d.by === 'packages' && (f.va || f.vb) ? h('div', { class: `ver ${f.st === 'downgraded' ? 'warn' : ''}` }, h('span', {}, f.va || '–'), h('span', { class: 'arr' }, '→'), h('span', {}, f.vb || '–')) : null,
      d.by === 'dirs' ? h('div', { class: 'meta' }, `${f.va} → ${f.vb}`) : null,
      d.sizes ? h('div', { class: 'sizes' }, sizeBar('A', f.st === 'added' ? null : f.a, 'a'), sizeBar('B', f.st === 'removed' ? null : f.b, 'b'),
        h('div', { class: `dd ${f.d > 0 ? 'g' : f.d < 0 ? 'k' : ''}` }, sgn(f.d), f.a && f.b ? ` (${f.pct >= 0 ? '+' : '−'}${Math.abs(f.pct)}%)` : '',
          f.a && f.b && Math.abs(f.pct) < 10 && f.d ? h('span', { class: 'soft' }, ' - under buildhistory\'s 10% threshold') : null)) : null,
      dev ? h('div', { class: 'callout' }, 'A ', h('code', {}, f.key.replace(/.*-/, '-')), ' package in an image: headers, static libs or debug symbols. Check IMAGE_FEATURES (dev-pkgs, dbg-pkgs, ptest-pkgs) and IMAGE_INSTALL.') : null,
      f.st === 'downgraded' ? h('div', { class: 'callout' }, 'Version went down. Check PREFERRED_VERSION, layer priority and bbappends.') : null,
      d.hasFiles || d.by === 'dirs' ? h('div', { class: 'files' },
        h('div', { class: 'fh' }, h('b', {}, `Changed files (${(f.files || []).length + (f.filesMore || 0)})`), f.how ? h('span', {}, f.how) : null),
        files.length ? h('ul', {}, files) : h('div', { class: 'empty' }, 'No changed files matched.'),
        f.filesMore ? h('div', { class: 'soft' }, `${f.filesMore} more not listed`) : null)
        : h('div', { class: 'empty' }, 'Paste files-in-image.txt from both builds (the boxes below the chart) to see this package\'s files.'),
    ));
  }

  function drawWarns() {
    const w = (res && res.warnings) || [];
    // each finding folds to its first sentence; the rest (what to do) opens under it
    const vars = (res.draw && res.draw.vars) || [];
    varBox.replaceChildren(...(vars.length ? [h('b', {}, 'image-info.txt '), ...vars.map(([k, v]) => h('span', {}, h('code', {}, k), ' ', v))] : []));
    warnBox.replaceChildren(...w.map((t) => {
      const k = t.search(/\.\s/);
      if (k < 0 || k > t.length - 4) return h('div', { class: 'w1' }, t);
      return h('details', {}, h('summary', {}, t.slice(0, k + 1)), h('div', {}, t.slice(k + 2)));
    }));
    notesBox.replaceChildren(h('summary', {}, `Notes (${(res.notes || []).length})`), ...(res.notes || []).map((t) => h('div', {}, t)));
  }

  function drawBadges() {
    const d = res && res.draw;
    if (!d) return;
    const raw = ctx.raw;
    const info = (key, side) => {
      const text = String(raw[key] || '').trim();
      if (!text) return key.startsWith('files') ? 'empty (optional)' : 'empty';
      const lines = text.split('\n').filter((l) => l.trim()).length;
      return `${lines} lines`;
    };
    badges.before.textContent = `${d.kinds.a.filter((k) => k !== 'files-in-image.txt').join(', ') || info('before')} · ${d.npk.a} pkgs${d.bad.a ? ` · ${d.bad.a} not read` : ''}`;
    badges.after.textContent = `${d.kinds.b.filter((k) => k !== 'files-in-image.txt').join(', ') || info('after')} · ${d.npk.b} pkgs${d.bad.b ? ` · ${d.bad.b} not read` : ''}`;
    badges.filesBefore.textContent = d.nfiles.a ? `${d.nfiles.a} paths · ${kib(d.totals.filesA / 1024)}` : info('filesBefore');
    badges.filesAfter.textContent = d.nfiles.b ? `${d.nfiles.b} paths · ${kib(d.totals.filesB / 1024)}` : info('filesAfter');
    for (const k of ['before', 'after']) badges[k].classList.toggle('bad', !!(k === 'before' ? d.bad.a : d.bad.b));
    depthSel.hidden = d.by !== 'dirs';
    bySel.parentNode.hidden = !d.hasFiles && (ctx.raw.by || 'auto') === 'auto';
  }

  let tabChosen = false;
  ctx.onResult((r) => {
    res = r;
    if (!tabChosen) { tabChosen = true; [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'Report' && t.getAttribute('aria-selected') !== 'true')?.click(); }
    focusKey = r.draw && r.draw.focus ? r.draw.focus.key : null;
    syncInputs(false);
    drawWarns();
    draw();
    drawDetail();
    drawBadges();
  });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = svg.parentNode.clientWidth;
    if (Math.abs(w - lastW) > 2) { lastW = w; draw(); }
  }).observe(chartCard);
}
