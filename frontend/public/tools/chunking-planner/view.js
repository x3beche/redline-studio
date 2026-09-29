// Chunking Planner, drawn as the thing itself: the document with every chunk
// tinted in turn, the text two chunks share hatched, a label with each chunk's
// number and size where it starts, and a red bar wherever a boundary cuts a
// code block or a table. Above it a ruler in the size unit carries the chunk
// size histogram and the two handles that set the plan: drag the size line and
// the overlap edge (or focus them and use the arrow keys) and the chunks move
// on the text. Click a chunk (on the text, a histogram bar or a dot) to read it
// beside the text with its header path, token estimate and findings.
// Everything drawn comes from run()'s result.view.

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
const STRATS = [['tokens', 'Token windows'], ['recursive', 'Recursive'], ['headings', 'Headings'], ['sentences', 'Sentences'], ['code', 'Code']];
const niceMax = (v) => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v)))); for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; };
const niceStep = (range, n) => { const raw = range / n; const p = Math.pow(10, Math.floor(Math.log10(raw))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p; return 10 * p; };

export function page(root, ctx) {
  const wrap = h('div', { class: 'cp' });
  root.append(wrap);

  // ---------- plan card: strategy, ruler with histogram and handles ----------
  const stratSeg = h('div', { class: 'cp-seg', role: 'group', 'aria-label': 'Strategy' });
  const unitSeg = h('div', { class: 'cp-seg', role: 'group', 'aria-label': 'Size unit' });
  const sepIn = h('input', { type: 'text', spellcheck: 'false', class: 'cp-sep', 'aria-label': 'Separators', oninput: (e) => ctx.set('separators', e.target.value) });
  const sepLab = h('label', { class: 'cp-seplab' }, 'Separators, in order (| between, \\n = newline)', sepIn);
  const keepBox = h('input', { type: 'checkbox', onchange: (e) => ctx.set('keep_headers', e.target.checked) });
  const sizeIn = h('input', { type: 'text', inputmode: 'numeric', class: 'num', 'aria-label': 'Chunk size', oninput: (e) => ctx.set('size', e.target.value) });
  const ovIn = h('input', { type: 'text', inputmode: 'numeric', class: 'num', 'aria-label': 'Overlap', oninput: (e) => ctx.set('overlap', e.target.value) });
  const bar = h('div', { class: 'cp-bar' },
    h('label', {}, 'Strategy', stratSeg), h('label', {}, 'Unit', unitSeg),
    h('label', {}, 'Size', sizeIn), h('label', {}, 'Overlap', ovIn),
    h('label', { class: 'chk', title: 'Put "Heading > Subheading" before each chunk\'s embed text' }, keepBox, 'Header path in embed text'),
    sepLab);
  const ruler = s('svg', { class: 'cp-ruler', role: 'group', 'aria-label': 'Chunk size ruler with histogram' });
  const planSub = h('span', { class: 'cp-sub' });
  const planCard = h('section', { class: 'cp-card' }, h('div', { class: 'cp-head' }, h('h2', {}, 'Plan'), planSub), bar, ruler,
    h('div', { class: 'cp-help' }, 'Drag the size line or the overlap edge; focused: ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' (', h('kbd', {}, 'Shift'), ' ×10). Bars and dots pick a chunk.'));

  // ---------- the document ----------
  const doc = h('div', { class: 'cp-doc', tabindex: '0', role: 'region', 'aria-label': 'Document with chunks. Arrow keys move between chunks; paste to replace the text.' });
  const ta = h('textarea', { class: 'cp-ta', spellcheck: 'false', 'aria-label': 'Document text', hidden: true });
  const editBtn = h('button', { class: 'k-btn', onclick: () => { editing = !editing; draw(); if (editing) ta.focus(); } }, 'Edit text');
  const docSub = h('span', { class: 'cp-sub' });
  const legend = h('div', { class: 'cp-legend' },
    h('span', {}, h('i', { class: 'sw c0' }), h('i', { class: 'sw c1' }), 'chunks in turn'), h('span', {}, h('i', { class: 'sw ovl' }), 'overlap (in two chunks)'),
    h('span', {}, h('i', { class: 'sw cut' }), 'boundary cuts a code block or table'), h('span', {}, h('i', { class: 'sw gap' }), 'not in any chunk'));
  const docCard = h('section', { class: 'cp-card' }, h('div', { class: 'cp-head' }, h('h2', {}, 'Document'), docSub, h('span', { class: 'cp-right' }, editBtn)), doc, ta, legend);

  // ---------- chunk detail, totals, outputs ----------
  const dTitle = h('h2', {});
  const dSub = h('span', { class: 'cp-sub' });
  const prevBtn = h('button', { class: 'k-btn', 'aria-label': 'Previous chunk', onclick: () => step(-1) }, '←');
  const nextBtn = h('button', { class: 'k-btn', 'aria-label': 'Next chunk', onclick: () => step(1) }, '→');
  const dPath = h('div', { class: 'cp-path' });
  const dStats = h('div', { class: 'cp-stats' });
  const dWarn = h('div', { class: 'cp-dwarn' });
  const dText = h('pre', { class: 'cp-dtext', tabindex: '0' });
  const detail = h('section', { class: 'cp-card' }, h('div', { class: 'cp-head' }, dTitle, dSub, h('span', { class: 'cp-right' }, prevBtn, nextBtn)), dPath, dStats, dWarn, dText);
  const priceIn = h('input', { type: 'text', inputmode: 'decimal', class: 'num', 'aria-label': 'Embedding price in dollars per million tokens', oninput: (e) => ctx.set('price', e.target.value) });
  const totals = h('div', { class: 'cp-totals' });
  const totCard = h('section', { class: 'cp-card' }, h('div', { class: 'cp-head' }, h('h2', {}, 'Index cost'),
    h('label', { class: 'cp-price' }, '$', priceIn, '/ MTok'), h('span', { class: 'cp-sub' }, 'example price as of 2026-09: check your provider')), totals);
  const warns = h('div', { class: 'cp-warns', role: 'status' });
  const notes = h('details', { class: 'cp-notes' }, h('summary', {}, 'Notes'));
  wrap.append(h('div', { class: 'cp-col' }, planCard, warns, docCard), h('div', { class: 'cp-col cp-side' }, detail, totCard, ctx.outputs, notes));

  let res = null, sel = 0, editing = false, typing = null, drag = null, frozenMax = null;

  ta.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => ctx.set('text', ta.value), 300); });
  doc.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text');
    if (t == null) return;
    e.preventDefault(); sel = 0; ctx.set('text', t);
  });
  doc.addEventListener('click', (e) => {
    const seg = e.target.closest('[data-c]');
    if (!seg) return;
    const list = seg.dataset.c.split(',').map(Number);
    const k = list.indexOf(sel);
    select(k >= 0 ? list[(k + 1) % list.length] : list[list.length - 1], false);
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
    else if (e.key === 'End') { e.preventDefault(); select((res?.view.chunks.length || 1) - 1, true); }
  });
  const step = (d) => { const n = res?.view.chunks.length || 0; if (n) select(Math.max(0, Math.min(n - 1, sel + d)), true); };
  const select = (i, scroll) => {
    sel = i; drawDoc(); drawDetail(); drawRuler();
    if (scroll) doc.querySelector('.cp-lab.on')?.scrollIntoView({ block: 'nearest' });
  };

  // ---------- ruler ----------
  function drawRuler() {
    const v = res?.view; if (!v) return;
    const W = Math.max(280, Math.round(ruler.parentElement.clientWidth || 600));
    const H = 150, L = 14, R = 14, TOP = 26, AX = 108;
    ruler.setAttribute('viewBox', `0 0 ${W} ${H}`); ruler.setAttribute('height', H);
    ruler.replaceChildren();
    const maxChunk = Math.max(0, ...v.chunks.map((c) => c.m));
    const want = niceMax(Math.max(v.size * 1.5, maxChunk * 1.1, v.overlap * 2.2, 10));
    const maxX = drag && frozenMax ? frozenMax : want;
    const X = (val) => L + (Math.min(val, maxX) / maxX) * (W - L - R);
    const unit = v.unit === 'chars' ? 'chars' : 'tokens';
    // hatch pattern for the overlap band
    const defs = s('defs');
    const pat = s('pattern', { id: 'cp-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(s('rect', { width: 6, height: 6, class: 'hbg' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hln' }));
    defs.append(pat); ruler.append(defs);
    // axis
    ruler.append(s('line', { x1: L, x2: W - R, y1: AX, y2: AX, class: 'axis' }));
    const st = niceStep(maxX, Math.max(3, Math.floor((W - L - R) / 70)));
    for (let t = 0; t <= maxX + 1e-9; t += st) {
      ruler.append(s('line', { x1: X(t), x2: X(t), y1: AX, y2: AX + 4, class: 'axis' }));
      ruler.append(s('text', { x: X(t), y: AX + 15, 'text-anchor': 'middle', class: 'tick' }, String(Math.round(t))));
    }
    ruler.append(s('text', { x: W - R, y: AX + 28, 'text-anchor': 'end', class: 'tick' }, `chunk size, ${unit}${unit === 'tokens' ? ' (estimated)' : ''}`));
    // overlap band on the axis
    ruler.append(s('rect', { x: L, y: AX - 8, width: Math.max(0, X(v.overlap) - L), height: 8, fill: 'url(#cp-hatch)', class: 'band' }));
    // histogram
    const nMax = Math.max(1, ...v.bins.map((b) => b.n));
    const barTop = TOP + 4, barH = AX - 14 - barTop;
    v.bins.forEach((b) => {
      if (!b.n) return;
      const x0 = X(b.lo), x1 = X(Math.min(b.hi, maxX));
      const hgt = (b.n / nMax) * barH;
      const first = v.chunks.findIndex((c) => c.m >= b.lo && c.m < b.hi);
      const onBin = v.chunks[sel] && v.chunks[sel].m >= b.lo && v.chunks[sel].m < b.hi;
      const r = s('rect', { x: x0 + 1, y: AX - 12 - hgt, width: Math.max(2, x1 - x0 - 2), height: hgt, rx: 2, class: `bin${b.lo > v.size ? ' over' : ''}${onBin ? ' on' : ''}` });
      r.append(s('title', {}, `${b.n} chunk${b.n > 1 ? 's' : ''} of ${b.lo}-${b.hi - 1} ${unit}`));
      r.addEventListener('click', () => first >= 0 && select(first, true));
      ruler.append(r);
      if (x1 - x0 > 14) ruler.append(s('text', { x: (x0 + x1) / 2, y: AX - 16 - hgt, 'text-anchor': 'middle', class: 'tick' }, String(b.n)));
    });
    // one dot per chunk just under the bars
    v.chunks.forEach((c, i) => {
      const d = s('circle', { cx: X(c.m), cy: AX - 4 - (i % 2) * 0, r: i === sel ? 4.5 : 2.6, class: `dot${c.warn.length ? ' warn' : ''}${i === sel ? ' on' : ''}` });
      d.append(s('title', {}, `#${c.i}: ${c.m} ${unit}`));
      d.addEventListener('click', () => select(i, true));
      ruler.append(d);
    });
    // handles
    const handle = (key, val, label, cls, y) => {
      const g = s('g', { class: `hdl ${cls}`, tabindex: '0', role: 'slider', 'aria-label': label, 'aria-valuenow': String(val), 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(maxX)), 'data-key': key });
      const x = X(val);
      g.append(s('line', { x1: x, x2: x, y1: y, y2: AX + 2, class: 'hline' }));
      const text = `${key === 'size' ? 'size' : 'overlap'} ${val}`;
      const tw = text.length * 6.6 + 12;
      const bx = Math.max(2, Math.min(W - tw - 2, x - tw / 2));
      g.append(s('rect', { x: bx, y: y - 16, width: tw, height: 17, rx: 3, class: 'hbox' }));
      g.append(s('text', { x: bx + tw / 2, y: y - 4, 'text-anchor': 'middle', class: 'htext' }, text));
      g.append(s('rect', { x: x - 7, y: y - 16, width: 14, height: AX - y + 20, class: 'hgrab' }));
      g.append(s('rect', { x: bx - 3, y: y - 19, width: tw + 6, height: 23, rx: 4, class: 'ring' }));
      const toVal = (clientX) => {
        const rc = ruler.getBoundingClientRect();
        const px = ((clientX - rc.left) / rc.width) * W;
        return Math.max(key === 'size' ? 1 : 0, Math.round(((px - L) / (W - L - R)) * maxX));
      };
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        drag = key; frozenMax = maxX;
        const move = (ev) => {
          let nv = toVal(ev.clientX);
          if (key === 'overlap') nv = Math.min(nv, Math.max(0, (res?.view.size || 1) - 1));
          if (String(nv) !== String(ctx.raw[key])) ctx.set(key, nv);
        };
        // the handle is redrawn on every result, so the drag listens on the window
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); drag = null; frozenMax = null; drawRuler(); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      });
      g.addEventListener('keydown', (e) => {
        const d = (e.key === 'ArrowRight' || e.key === 'ArrowUp') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowDown') ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        let nv = val + d * (e.shiftKey ? 10 : 1);
        nv = key === 'size' ? Math.max(1, nv) : Math.max(0, Math.min(nv, (res?.view.size || 1) - 1));
        focusKey = key;
        ctx.set(key, nv);
      });
      return g;
    };
    ruler.append(handle('overlap', v.overlap, 'Overlap', 'ov', TOP + 22), handle('size', v.size, 'Chunk size', 'sz', TOP - 2));
    if (focusKey) { ruler.querySelector(`[data-key="${focusKey}"]`)?.focus(); focusKey = null; }
    planSub.textContent = `${v.chunks.length} chunks · ${STRATS.find((x) => x[0] === v.strategy)?.[1]} · ${v.size} ${unit}, overlap ${v.overlap}`;
  }
  let focusKey = null;

  // ---------- document ----------
  function drawDoc() {
    const v = res?.view; if (!v) return;
    const text = ctx.raw.text ?? '';
    if (text.length !== v.textLen) return; // a result for other text is on its way
    const ch = v.chunks;
    const cuts = new Map();
    ch.forEach((c) => c.warn.filter((w) => w.kind === 'cut').forEach((w) => cuts.set(w.at, `#${c.i} ${w.msg}`)));
    const pts = new Set([0, text.length]);
    for (const c of ch) { pts.add(c.s); pts.add(c.e); }
    const P = [...pts].sort((a, b) => a - b);
    const frag = document.createDocumentFragment();
    // chunks cover [s,e); a sweep keeps the ones open at each point
    let k = 0;
    const open = [];
    for (let n = 0; n < P.length - 1; n++) {
      const p = P[n], q = P[n + 1];
      for (let j = open.length - 1; j >= 0; j--) if (ch[open[j]].e <= p) open.splice(j, 1);
      while (k < ch.length && ch[k].s <= p) { if (ch[k].e > p) open.push(k); k++; }
      if (cuts.has(p)) frag.append(h('span', { class: 'cp-cut', title: cuts.get(p) }, '​'));
      for (const i of open) if (ch[i].s === p) {
        const c = ch[i];
        frag.append(h('span', { class: `cp-lab${i === sel ? ' on' : ''}${c.warn.length ? ' warn' : ''}`, 'data-c': String(i), title: c.warn.map((w) => w.msg).join('\n') || null }, `#${c.i} · ${c.m}`));
      }
      const seg = text.slice(p, q);
      if (!open.length) { frag.append(h('span', { class: 'gap' }, seg)); continue; }
      const cls = open.length > 1 ? 'ovl' : `c${open[0] % 2}`;
      frag.append(h('span', { class: `${cls}${open.includes(sel) ? ' on' : ''}`, 'data-c': open.join(',') }, seg));
    }
    if (cuts.has(text.length)) frag.append(h('span', { class: 'cp-cut', title: cuts.get(text.length) }, '​'));
    doc.replaceChildren(frag);
    docSub.textContent = `${text.length} characters · ${v.docTokens} tokens (est.) · ${v.headings.length} headings · ${v.fences.length} code blocks · ${v.tables.length} tables`;
  }

  function drawDetail() {
    const v = res?.view; if (!v) return;
    const c = v.chunks[sel];
    const unit = v.unit === 'chars' ? 'chars' : 'tokens';
    prevBtn.disabled = sel <= 0; nextBtn.disabled = sel >= v.chunks.length - 1;
    if (!c) { dTitle.textContent = 'No chunks'; dSub.textContent = ''; dPath.replaceChildren(); dStats.replaceChildren(); dWarn.replaceChildren(); dText.textContent = ''; return; }
    dTitle.textContent = `Chunk #${c.i}`;
    dSub.textContent = `of ${v.chunks.length} · lines ${c.line}-${c.endLine}`;
    dPath.replaceChildren(...(c.path.length ? c.path.flatMap((p, k) => [k ? h('span', { class: 'sepr' }, '›') : null, h('span', { class: 'crumb' }, p)]).filter(Boolean) : [h('span', { class: 'cp-sub' }, 'no heading above')]));
    const pct = Math.round((c.m / v.size) * 100);
    dStats.replaceChildren(
      h('div', {}, h('span', {}, `Size (${unit})`), h('b', { class: c.m > v.size ? 'bad' : '' }, String(c.m)), h('i', { class: 'meter' }, h('i', { style: `width:${Math.min(100, pct)}%`, class: c.m > v.size ? 'bad' : pct < 25 ? 'warn' : '' })), h('em', {}, `${pct}% of ${v.size}`)),
      h('div', {}, h('span', {}, 'Tokens (est.)'), h('b', {}, String(c.tokens))),
      h('div', {}, h('span', {}, 'Characters'), h('b', {}, String(c.chars))),
      h('div', {}, h('span', {}, 'Shared with previous'), h('b', {}, c.ov ? `${c.ov} ch` : 'none')));
    dWarn.replaceChildren(...c.warn.map((w) => h('div', {}, `#${c.i} ${w.msg}.`)));
    const text = ctx.raw.text ?? '';
    const body = text.slice(c.s, c.e);
    dText.replaceChildren(...(c.ov ? [h('span', { class: 'ovl' }, body.slice(0, Math.min(c.ov, body.length))), body.slice(Math.min(c.ov, body.length))] : [body]));
  }

  function drawTotals() {
    const r = res;
    const vals = r.values || [];
    totals.replaceChildren(...vals.map((x) => h('div', { class: `cp-val${x.tone ? ' ' + x.tone : ''}` }, h('span', {}, x.label),
      h('b', {}, typeof x.value === 'number' ? String(x.value) : String(x.value), x.unit ? h('small', {}, ` ${x.unit}`) : null), x.hint ? h('em', {}, x.hint) : null)));
  }

  function draw() {
    if (!res?.view) return;
    const v = res.view;
    const raw = ctx.raw;
    stratSeg.replaceChildren(...STRATS.map(([k, t]) => h('button', { 'aria-pressed': String(v.strategy === k), onclick: () => { sel = 0; ctx.set('strategy', k); } }, t)));
    unitSeg.replaceChildren(...[['tokens', 'tokens'], ['chars', 'chars']].map(([k, t]) => h('button', { 'aria-pressed': String(v.unit === k), onclick: () => ctx.set('unit', k) }, t)));
    if (document.activeElement !== sizeIn) sizeIn.value = raw.size ?? '';
    if (document.activeElement !== ovIn) ovIn.value = raw.overlap ?? '';
    if (document.activeElement !== sepIn) sepIn.value = raw.separators ?? '';
    if (document.activeElement !== priceIn) priceIn.value = raw.price ?? '';
    keepBox.checked = !!raw.keep_headers;
    sepLab.hidden = !(v.strategy === 'recursive' || v.strategy === 'headings');
    editBtn.textContent = editing ? 'Done' : 'Edit text';
    editBtn.setAttribute('aria-pressed', String(editing));
    doc.hidden = editing; ta.hidden = !editing; legend.hidden = editing;
    if (editing && document.activeElement !== ta) ta.value = raw.text ?? '';
    if (sel >= v.chunks.length) sel = Math.max(0, v.chunks.length - 1);
    drawRuler(); drawDoc(); drawDetail(); drawTotals();
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes'), ...(res.notes || []).map((n) => h('div', {}, n)));
  }

  let lastW = 0;
  new ResizeObserver(() => { const w = ruler.parentElement.clientWidth; if (res && Math.abs(w - lastW) > 1) { lastW = w; drawRuler(); } }).observe(ruler.parentElement);
  let firstTab = true;
  ctx.onResult((r) => {
    res = r; draw();
    if (firstTab) {
      firstTab = false;
      let picked = null;
      try { picked = localStorage.getItem('redline.tool.chunking-planner.input.tab'); } catch { /* private window */ }
      if (!picked) [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'Chunks JSONL')?.click();
    }
  });
}
