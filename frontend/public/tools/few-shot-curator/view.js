// Few-shot Example Curator, drawn as the thing itself: the example pool as
// cards on a board, one lane per label, near-duplicates and contradictions
// tied together with lines, leaks of the test input marked; above it the
// sequence that goes into the prompt as a strip whose length is the token
// budget, and the label balance of the pool against the selection.
//   Click a card (or focus it and press Enter) to take it in or out; drag a
//   block in the sequence strip (or focus it and use ← →) to reorder; pick a
//   card's label from its menu to relabel it. Any hand change switches to
//   the manual strategy with the current order as the start.
// Every flag, count and token figure comes from run()'s result (result.draw).

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v); return el; };
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
const STRATS = [['balanced', 'Balanced per label'], ['diverse', 'Diverse'], ['shortest', 'Shortest first'], ['recent', 'Recent last'], ['manual', 'Manual']];
const ord = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

export function page(root, ctx) {
  const wrap = h('div', { class: 'fs' });
  root.append(wrap);
  let res = null, focusKey = null, dragging = false;
  const colorOf = (label) => {
    if (!res || label === '(none)') return 'fs-cn';
    const i = res.draw.labels.findIndex((l) => l.label === label);
    return `fs-c${(i < 0 ? 0 : i) % 6}`;
  };

  // ---------- controls ----------
  const stratSeg = h('div', { class: 'fs-seg', role: 'radiogroup', 'aria-label': 'Strategy' });
  const num = (key, label, w) => {
    const el = h('input', { type: 'text', inputmode: 'decimal', class: 'fs-num', style: `width:${w}px`, 'aria-label': label,
      onchange: (e) => { const v = ctx.parseEng(e.target.value); if (v != null && v >= 0) ctx.set(key, v); } });
    el._key = key;
    return [h('label', { class: 'fs-lab' }, label, el), el];
  };
  const [kLab, kIn] = num('k', 'Examples', 44), [bLab, bIn] = num('budget', 'Budget (tokens)', 64), [dLab, dIn] = num('dup', 'Duplicate ≥', 48);
  const controls = h('div', { class: 'fs-bar' }, stratSeg, kLab, bLab, dLab);

  // ---------- sequence strip ----------
  const seqSvg = s('svg', { class: 'fs-seq', role: 'group', 'aria-label': 'Selected examples in prompt order; width is tokens' });
  const seqSub = h('span', { class: 'fs-sub' });
  const balance = h('div', { class: 'fs-balance' });
  const topCard = h('section', { class: 'fs-card' },
    h('div', { class: 'fs-head' }, h('h2', {}, 'Prompt sequence'), seqSub), controls, h('div', { class: 'fs-seqwrap' }, seqSvg), balance,
    h('div', { class: 'fs-help' }, 'Blocks are the examples in the order the model reads them, as wide as their tokens; the frame is the budget. Drag a block (or focus it and press ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ') to reorder, ', h('kbd', {}, 'Del'), ' to drop it.'));

  // ---------- board ----------
  const board = h('div', { class: 'fs-board' });
  const linkSvg = s('svg', { class: 'fs-links', 'aria-hidden': 'true' });
  const boardWrap = h('div', { class: 'fs-boardwrap' }, board, linkSvg);
  const boardSub = h('span', { class: 'fs-sub' });
  const boardCard = h('section', { class: 'fs-card' }, h('div', { class: 'fs-head' }, h('h2', {}, 'Example pool'), boardSub), boardWrap,
    h('div', { class: 'fs-help' }, 'Click a card, or focus it and press ', h('kbd', {}, 'Enter'), ', to take it in or out. Lines tie near-duplicates (dashed) and contradictions (red). ',
      h('span', { class: 'fs-flag fs-leak' }, 'leak'), ' = too close to the test input.'));

  // ---------- source ----------
  const exTa = h('textarea', { class: 'fs-ta', rows: 10, spellcheck: 'false', 'aria-label': 'Examples (JSONL, CSV or Input/Output blocks)' });
  const testTa = h('textarea', { class: 'fs-ta', rows: 3, spellcheck: 'false', 'aria-label': 'Test input' });
  const fmtSel = h('select', { 'aria-label': 'Format', onchange: (e) => ctx.set('format', e.target.value) },
    [['auto', 'detect'], ['jsonl', 'JSONL'], ['csv', 'CSV'], ['blocks', 'Input:/Output:']].map(([v, t]) => h('option', { value: v }, t)));
  const fieldIn = h('input', { type: 'text', class: 'fs-num', style: 'width:96px', placeholder: 'auto', 'aria-label': 'Label field of JSON outputs', onchange: (e) => ctx.set('labelField', e.target.value.trim()) });
  const deb = (el, key) => { let t = 0; el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => ctx.set(key, el.value), 350); }); };
  deb(exTa, 'examples'); deb(testTa, 'test');
  const srcSub = h('span', { class: 'fs-sub' });
  const srcCard = h('section', { class: 'fs-card' },
    h('div', { class: 'fs-head' }, h('h2', {}, 'Examples'), srcSub),
    h('div', { class: 'fs-bar' }, h('label', { class: 'fs-lab' }, 'Format', fmtSel), h('label', { class: 'fs-lab' }, 'Label field', fieldIn)),
    h('div', { class: 'fs-pad' }, exTa),
    h('div', { class: 'fs-head fs-top' }, h('h2', {}, 'Test input'), h('span', { class: 'fs-sub' }, 'checked for leaks into the examples')),
    h('div', { class: 'fs-pad' }, testTa));

  const warns = h('div', { class: 'fs-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'fs-notes' }, h('summary', {}, 'Method and notes'));
  wrap.append(topCard, warns, h('div', { class: 'fs-main' }, h('div', { class: 'fs-col' }, boardCard, notes), h('div', { class: 'fs-col fs-side' }, ctx.outputs, srcCard)));

  // ---------- actions ----------
  const setOrder = (ids) => ctx.setMany({ strategy: 'manual', picks: ids.join(', ') });
  const toggle = (id) => {
    const cur = [...res.draw.order];
    const i = cur.indexOf(id);
    if (i >= 0) cur.splice(i, 1); else cur.push(id);
    focusKey = `card${id}`;
    setOrder(cur);
  };
  const relabel = (id, label) => {
    const m = new Map([...String(ctx.raw.relabel || '').matchAll(/#?(\d+)\s*[=:]\s*([^,;\n]+)/g)].map((x) => [Number(x[1]), x[2].trim()]));
    const e = res.draw.examples[id - 1];
    if (label === e.autoLabel) m.delete(id); else m.set(id, label);
    ctx.set('relabel', [...m].map(([k, v]) => `${k}=${v}`).join(', '));
  };

  // ---------- drawing ----------
  const drawSeq = () => {
    const d = res.draw;
    const W = Math.max(280, seqSvg.parentNode.clientWidth), H = 50, X0 = 1, X1 = W - 1, Y = 8, BH = 30;
    const total = Math.max(d.budget || 0, d.used, 1);
    const sx = (t) => X0 + (t / total) * (X1 - X0);
    seqSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); seqSvg.setAttribute('height', H);
    const had = seqSvg.contains(document.activeElement);
    seqSvg.replaceChildren();
    const defs = s('defs'); const p = s('pattern', { id: 'fs-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    p.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'fs-hatch' })); defs.append(p); seqSvg.append(defs);
    seqSvg.append(s('rect', { x: X0, y: Y, width: (d.budget ? sx(d.budget) : X1) - X0, height: BH, rx: 3, class: 'fs-frame' }));
    if (d.budget && d.used > d.budget) seqSvg.append(s('rect', { x: sx(d.budget), y: Y - 3, width: X1 - sx(d.budget), height: BH + 6, class: 'fs-over' }));
    let acc = 0;
    d.order.forEach((id, i) => {
      const e = d.examples[id - 1];
      const x = sx(acc), w = Math.max(3, sx(acc + e.tokens) - x);
      const g = s('g', { class: 'fs-blk', tabindex: 0, role: 'button', 'data-k': `blk${id}`, 'aria-label': `${ord(i + 1)}: example ${id}, ${e.label}, ${e.tokens} tokens. Arrow keys move it, Delete drops it.` });
      g.append(s('rect', { x: x + 0.5, y: Y + 1, width: w - 1, height: BH - 2, rx: 2, class: `fs-blkr ${colorOf(e.label)}` }));
      if (w > 26) { const t = s('text', { x: x + w / 2, y: Y + BH / 2 + 4, 'text-anchor': 'middle', class: 'fs-blkt' }); t.textContent = w > 56 ? `#${id} ${e.tokens}` : `#${id}`; g.append(t); }
      const tt = s('title'); tt.textContent = `${ord(i + 1)} · #${id} ${e.label} · ${e.tokens} tokens\n${e.input}`; g.append(tt);
      g.addEventListener('keydown', (ev) => {
        const cur = [...d.order];
        if (ev.key === 'ArrowLeft' && i > 0) { [cur[i - 1], cur[i]] = [cur[i], cur[i - 1]]; }
        else if (ev.key === 'ArrowRight' && i < cur.length - 1) { [cur[i + 1], cur[i]] = [cur[i], cur[i + 1]]; }
        else if (ev.key === 'Delete' || ev.key === 'Backspace') { cur.splice(i, 1); focusKey = null; ev.preventDefault(); setOrder(cur); return; }
        else return;
        ev.preventDefault(); focusKey = `blk${id}`; setOrder(cur);
      });
      g.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        focusKey = `blk${id}`;
        const rect = seqSvg.getBoundingClientRect(), scale = W / rect.width;
        const startX = ev.clientX;
        let moved = false, target = i;
        dragging = true;
        g.classList.add('fs-dragging');
        const mids = () => { let a = 0; return d.order.map((oid) => { const t = d.examples[oid - 1].tokens; const m = sx(a + t / 2); a += t; return m; }); };
        const M = mids();
        const move = (e2) => {
          const dx = (e2.clientX - startX) * scale;
          if (Math.abs(dx) > 3) moved = true;
          g.setAttribute('transform', `translate(${dx},0)`);
          const cx = M[i] + dx;
          target = M.filter((m, j) => j !== i && m < cx).length;
        };
        const up = () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
          dragging = false;
          g.removeAttribute('transform');
          if (!moved) { const el = board.querySelector(`[data-k="card${id}"]`); if (el) { el.scrollIntoView({ block: 'nearest' }); el.focus({ preventScroll: true }); } return; }
          const cur = d.order.filter((x) => x !== id); cur.splice(target, 0, id);
          if (cur.join() !== d.order.join()) setOrder(cur);
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      });
      seqSvg.append(g);
      acc += e.tokens;
    });
    if (!d.order.length) { const t = s('text', { x: W / 2, y: Y + BH / 2 + 4, 'text-anchor': 'middle', class: 'fs-empty' }); t.textContent = 'Nothing selected: click cards below, or pick a strategy'; seqSvg.append(t); }
    if (d.budget) { const t = s('text', { x: Math.min(sx(d.budget), X1) - 3, y: Y + BH + 11, 'text-anchor': 'end', class: 'fs-small' }); t.textContent = `budget ${d.budget}`; seqSvg.append(t); }
    seqSub.replaceChildren(h('b', { class: d.budget && d.used > d.budget ? 'bad' : '' }, `${d.used}`), d.budget ? ` of ${d.budget} tokens (est.)` : ' tokens (est.)', ` · ${d.order.length} of ${d.k} examples · ${STRATS.find((x) => x[0] === d.strategy)?.[1]}`);
    if (had && focusKey) { const el = seqSvg.querySelector(`[data-k="${focusKey}"]`); if (el) el.focus({ preventScroll: true }); }
  };

  const drawBalance = () => {
    const d = res.draw;
    const tot = d.labels.reduce((a, l) => a + l.pool, 0) || 1, stot = d.labels.reduce((a, l) => a + l.sel, 0) || 1;
    const row = (name, key, sum) => h('div', { class: 'fs-brow' }, h('span', { class: 'fs-bname' }, name),
      h('div', { class: 'fs-bbar' }, d.labels.map((l) => (l[key] ? h('i', { class: colorOf(l.label), style: `width:${(l[key] / sum) * 100}%`, title: `${l.label}: ${l[key]}` }, l[key] / sum > 0.07 ? String(l[key]) : '') : null))));
    balance.replaceChildren(row('pool', 'pool', tot), row('selected', 'sel', stot),
      h('div', { class: 'fs-legend' }, d.labels.map((l) => h('span', {}, h('i', { class: colorOf(l.label) }), `${l.label} ${l.sel}/${l.pool}`))));
  };

  const drawBoard = () => {
    const d = res.draw;
    const hadFocus = board.contains(document.activeElement);
    const labels = d.labels.map((l) => l.label);
    const lanes = labels.map((lab) => {
      const cards = d.examples.filter((e) => e.label === lab).map((e) => {
        const selected = e.sel >= 0;
        const flags = [
          e.dupOf ? h('span', { class: 'fs-flag fs-dup', title: `near-duplicate of #${e.dupOf}` }, `≈ #${e.dupOf}`) : null,
          e.conflict.length ? h('span', { class: 'fs-flag fs-bad', title: 'same input, different output' }, `≠ #${e.conflict.join(', #')}`) : null,
          e.leak ? h('span', { class: 'fs-flag fs-leak', title: 'too close to the test input' }, `leak ${Math.round(e.leak * 100)} %`) : null,
        ];
        const sel = h('select', { class: 'fs-lsel', 'aria-label': `Label of example ${e.id}`, onclick: (ev) => ev.stopPropagation(), onkeydown: (ev) => ev.stopPropagation(),
          onchange: (ev) => relabel(e.id, ev.target.value) },
          [...new Set([...labels.filter((l) => l !== '(none)'), ...(e.autoLabel ? [e.autoLabel] : [])])].map((l) => h('option', { value: l, selected: l === e.label || null }, l)),
          e.label === '(none)' ? h('option', { value: '(none)', selected: true }, '(none)') : null);
        const card = h('div', { class: `fs-cardx${selected ? ' fs-in' : ''}${e.candidate ? '' : ' fs-excl'}`, tabindex: 0, role: 'button', 'aria-pressed': String(selected), 'data-k': `card${e.id}`, 'data-id': e.id,
          'aria-label': `Example ${e.id}, ${e.label}, ${e.tokens} tokens${selected ? `, ${ord(e.sel + 1)} in the prompt` : ''}. Enter to ${selected ? 'remove' : 'add'}.`,
          onclick: () => toggle(e.id), onkeydown: (ev) => { if (ev.target === card && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggle(e.id); } } },
          h('div', { class: 'fs-ctop' }, h('b', { class: 'fs-id' }, `#${e.id}`), selected ? h('span', { class: `fs-ord ${colorOf(e.label)}` }, ord(e.sel + 1)) : null, h('span', { class: 'fs-tok' }, `${e.tokens} tok`)),
          h('div', { class: 'fs-in-t' }, e.input),
          h('div', { class: 'fs-out-t' }, '→ ', e.output),
          h('div', { class: 'fs-cfoot' }, sel, e.relabelled ? h('span', { class: 'fs-flag', title: `was "${e.autoLabel ?? '(none)'}"` }, 'relabelled') : null, ...flags));
        return card;
      });
      const L = d.labels.find((l) => l.label === lab);
      return h('div', { class: 'fs-lane' }, h('div', { class: 'fs-lhead' }, h('i', { class: colorOf(lab) }), h('b', {}, lab), h('span', { class: 'fs-sub' }, `${L.sel} of ${L.pool}`)), ...cards);
    });
    board.replaceChildren(...lanes);
    board.style.setProperty('--lanes', Math.max(1, labels.length));
    const ex = d.examples.length;
    boardSub.textContent = `${ex} examples · ${d.labels.length} labels · ${d.examples.filter((e) => !e.candidate).length} held out of automatic picks`;
    if (hadFocus && focusKey) { const el = board.querySelector(`[data-k="${focusKey}"]`); if (el) el.focus({ preventScroll: true }); }
    requestAnimationFrame(drawLinks);
  };

  const drawLinks = () => {
    if (!res) return;
    const box = board.getBoundingClientRect();
    const W = board.offsetWidth, H = board.offsetHeight;
    linkSvg.setAttribute('width', W); linkSvg.setAttribute('height', H);
    linkSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    linkSvg.replaceChildren();
    for (const l of res.draw.links) {
      const a = board.querySelector(`[data-id="${l.a}"]`), b = board.querySelector(`[data-id="${l.b}"]`);
      if (!a || !b) continue;
      let ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (rb.left < ra.left - 4) [ra, rb] = [rb, ra];
      const same = Math.abs(ra.left - rb.left) < 4;
      const y1 = ra.top + Math.min(ra.height / 2, 28) - box.top, y2 = rb.top + Math.min(rb.height / 2, 28) - box.top;
      let d, lx, ly;
      if (same) {
        // same lane: a loop out of the right edges, into the gap between lanes
        const x = ra.right - box.left, bulge = 16;
        d = `M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x},${y2}`;
        lx = x + bulge + 2; ly = (y1 + y2) / 2;
      } else {
        const x1 = ra.right - box.left, x2 = rb.left - box.left, mx = (x1 + x2) / 2;
        d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
        lx = mx; ly = (y1 + y2) / 2 - 4;
      }
      linkSvg.append(s('path', { d, class: `fs-link ${l.kind === 'conflict' ? 'bad' : 'dup'}` }));
      for (const [cx, cy] of same ? [[ra.right - box.left, y1], [rb.right - box.left, y2]] : [[ra.right - box.left, y1], [rb.left - box.left, y2]]) linkSvg.append(s('circle', { cx, cy, r: 2.5, class: `fs-dot ${l.kind === 'conflict' ? 'bad' : ''}` }));
      const t = s('text', { x: lx, y: ly, class: `fs-ltxt ${l.kind === 'conflict' ? 'bad' : ''}`, 'text-anchor': same ? 'start' : 'middle', transform: same ? `rotate(90 ${lx} ${ly})` : null });
      t.textContent = l.kind === 'conflict' ? `≠ ${Math.round(l.sim * 100)} %` : `≈ ${Math.round(l.sim * 100)} %`;
      linkSvg.append(t);
    }
  };

  // The output panel opens on the XML block the first time.
  let firstTab = true;
  try { firstTab = !localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
  ctx.onResult((r) => {
    res = r;
    if (!r.draw) return;
    if (firstTab) { firstTab = false; setTimeout(() => [...ctx.outputs.querySelectorAll('.k-tab')].find((b) => b.textContent === 'XML block')?.click(), 0); }
    const raw = ctx.raw;
    stratSeg.replaceChildren(...STRATS.map(([v, t]) => h('button', { role: 'radio', 'aria-checked': String(raw.strategy === v), onclick: () => {
      if (v === 'manual') ctx.setMany({ strategy: 'manual', picks: res.draw.order.join(', ') }); else ctx.set('strategy', v);
    } }, t)));
    for (const el of [kIn, bIn, dIn]) if (document.activeElement !== el) el.value = String(raw[el._key] ?? '');
    if (document.activeElement !== exTa) exTa.value = String(raw.examples ?? '');
    if (document.activeElement !== testTa) testTa.value = String(raw.test ?? '');
    if (document.activeElement !== fieldIn) fieldIn.value = String(raw.labelField ?? '');
    fmtSel.value = raw.format || 'auto';
    const v = r.values || [];
    srcSub.textContent = `${v[0]?.value ?? 0} read${v[0]?.hint ? ` · ${v[0].hint}` : ''}`;
    drawSeq(); drawBalance(); drawBoard();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Method and notes'), ...(r.notes || []).map((n) => h('div', {}, n)));
  });
  let lastW = 0;
  new ResizeObserver(() => { const w = wrap.clientWidth; if (res && !dragging && Math.abs(w - lastW) > 2) { lastW = w; drawSeq(); drawLinks(); } }).observe(wrap);
  new ResizeObserver(() => { if (res && !dragging) drawLinks(); }).observe(board);
}
