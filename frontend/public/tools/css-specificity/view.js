// CSS Specificity page: the stylesheet itself is the interface. The two rules
// sit in source order like in an editor; every part of each selector carries
// a bracket with what it adds (IDs, classes, types) in that column's colour.
// Click a bracket to wrap the part in :where() (or unwrap it), Delete removes
// it; click !important to toggle it; drag a rule's grip (or its arrow keys)
// to change which comes later. Beside it the cascade is drawn as the gates it
// checks in order, and the gate that decides is lit. Everything shown comes
// from tool.js run() (result.drawing).

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const COLS = ['id', 'cls', 'typ'];
const COL_NAME = ['IDs', 'classes', 'types'];
const colOf = (adds) => {
  const n = adds.filter((v) => v > 0).length;
  if (!n) return 'zero';
  if (n > 1) return 'mix';
  return COLS[adds.findIndex((v) => v > 0)];
};
const tag = (adds) => {
  const n = adds.filter((v) => v > 0).length;
  if (!n) return '0';
  if (n === 1) return String(adds.find((v) => v > 0));
  return adds.join('·');
};

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const sheet = el('section', { class: 'cs-sheet' });
  const sheetHead = el('div', { class: 'cs-sheet-head' });
  sheetHead.innerHTML = '<span class="cs-file">styles.css</span>'
    + '<span class="cs-legend"><i class="c-id"></i>ID <i class="c-cls"></i>class · attribute · pseudo-class <i class="c-typ"></i>type · pseudo-element <i class="c-zero"></i>adds 0</span>';
  const exRow = el('div', { class: 'cs-ex' });
  exRow.append(el('span', {}, 'Try'));
  for (const ex of ctx.manifest.examples || []) {
    const b = el('button', { class: 'cs-chip', type: 'button' }, esc(ex.title));
    b.addEventListener('click', () => ctx.setMany(structuredClone(ex.input)));
    exRow.append(b);
  }
  sheetHead.append(exRow);

  const code = el('div', { class: 'cs-code' });
  const rules = {};
  for (const w of ['a', 'b']) rules[w] = buildRule(w);
  const verdictLine = el('div', { class: 'cs-comment' });
  const between = el('div', { class: 'cs-between' });
  const warnBox = el('div', { class: 'cs-warns', role: 'status' });
  const hint = el('div', { class: 'cs-hint' },
    'Type in a selector · click a bracket to wrap that part in <code>:where()</code> (0) or unwrap it · <kbd>Del</kbd> on a bracket removes the part · drag <b>⠿</b> to change source order');
  const info = el('div', { class: 'cs-info', hidden: true });
  sheet.append(sheetHead, code, warnBox, hint, info);
  function showInfo(w, p) {
    if (!p) { info.hidden = true; hint.hidden = false; return; }
    const where = /^:where\(/i.test(p.text);
    info.innerHTML = `<span class="cs-badge ${w === 'b' ? 'b' : ''}">${w.toUpperCase()}</span><code class="c-${colOf(p.adds)}">${esc(p.text)}</code>`
      + `<span>${esc(p.kind)}</span><b>adds (${p.adds.map((v, i) => `<span class="c-${COLS[i]}">${v}</span>`).join(', ')})</b>`
      + `<em>click: ${where ? 'unwrap' : 'wrap in :where()'} · Del: remove</em>`;
    info.hidden = false; hint.hidden = true;
  }

  const side = el('aside', { class: 'cs-side' });
  const casc = el('section', { class: 'cs-casc' });
  const cascHead = el('div', { class: 'cs-casc-head' }, '<b>Cascade</b><span>checked top to bottom; the first difference decides</span>');
  const gates = el('div', { class: 'cs-gates' });
  const out = el('div', { class: 'cs-verdict', 'aria-live': 'polite' });
  const preview = el('div', { class: 'cs-preview' });
  casc.append(cascHead, gates, out, preview);
  const notes = el('section', { class: 'cs-notes' });
  side.append(casc, notes);
  const main = el('div', { class: 'cs-main' });
  main.append(sheet, ctx.outputs);

  const grid = el('div', { class: 'cs' });
  grid.append(main, side);
  root.append(grid);

  // ---------------- a rule: selector editor + declaration ----------------
  function buildRule(w) {
    const box = el('div', { class: `cs-rule cs-${w}`, 'data-w': w });
    const grip = el('button', { class: 'cs-grip', type: 'button', 'aria-label': `Move rule ${w.toUpperCase()} up or down in the stylesheet (arrow keys)`, title: 'Drag to change source order' }, '⠿');
    const badge = el('span', { class: 'cs-badge' }, w.toUpperCase());
    const specBig = el('div', { class: 'cs-spec' });
    const head = el('div', { class: 'cs-rule-head' });
    head.append(grip, badge, el('span', { class: 'cs-rule-lab' }, `Selector ${w.toUpperCase()}`), specBig);

    const ed = el('div', { class: 'cs-ed' });
    const back = el('div', { class: 'cs-back', 'aria-hidden': 'true' });
    const ta = el('textarea', { class: 'cs-ta', rows: '1', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
      'aria-label': `Selector ${w.toUpperCase()}` });
    const marks = el('div', { class: 'cs-marks' });
    ed.append(back, ta, marks);
    ta.addEventListener('input', () => { sizeTa(); ctx.set(w, ta.value); });
    ta.addEventListener('scroll', () => { back.scrollTop = ta.scrollTop; });
    const brace = el('span', { class: 'cs-brace' }, '{');
    const selLine = el('div', { class: 'cs-selline' });
    selLine.append(ed, brace);

    const decl = el('div', { class: 'cs-decl' });
    const imp = el('button', { class: 'cs-imp', type: 'button', 'aria-pressed': 'false' }, '!important');
    const ikey = w === 'a' ? 'importantA' : 'importantB';
    imp.addEventListener('click', () => ctx.set(ikey, !ctx.input[ikey]));
    const prop = el('span', { class: 'cs-prop' }, `<span class="cs-k">color</span>: <i class="cs-sw"></i><span class="cs-v">var(--${w})</span>`);
    const keep = el('span', { class: 'cs-keep' });
    keep.append(prop, imp, el('span', { class: 'cs-semi' }, ';'));
    decl.append(keep, el('span', { class: 'cs-over' }));
    const close = el('div', { class: 'cs-close' }, '}');
    box.append(head, selLine, decl, close);

    // source order by dragging the grip
    let drag = null;
    grip.addEventListener('pointerdown', (e) => {
      grip.setPointerCapture(e.pointerId);
      drag = { y0: e.clientY, h: box.offsetHeight };
      box.classList.add('dragging');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      box.style.transform = `translateY(${dy}px)`;
    });
    const end = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      box.style.transform = ''; box.classList.remove('dragging');
      const first = orderOf(w) === 0;
      if ((first && dy > drag.h * 0.5) || (!first && dy < -drag.h * 0.5)) swapOrder(w);
      drag = null;
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const first = orderOf(w) === 0;
      if ((first && e.key === 'ArrowDown') || (!first && e.key === 'ArrowUp')) { swapOrder(w); requestAnimationFrame(() => grip.focus()); }
    });

    function sizeTa() {
      back.textContent = ta.value + '​';
      ta.style.height = `${back.scrollHeight}px`;
    }
    return { box, ta, back, marks, specBig, imp, decl, sizeTa, grip, w };
  }

  const orderOf = (w) => ((ctx.input.bLater ? ['a', 'b'] : ['b', 'a']).indexOf(w));
  const swapOrder = () => ctx.set('bLater', !ctx.input.bLater);

  // ---------------- part edits ----------------
  function editPart(w, part, how) {
    const text = String(ctx.raw[w] ?? '');
    const [s, e] = part.at;
    if (text.slice(s, e) !== part.text) return;
    if (how === 'remove') {
      const before = text.slice(0, s), after = text.slice(e);
      const sep = (/\s$/.test(before) || /^\s/.test(after)) && before.trim() && after.trim() ? ' ' : '';
      ctx.set(w, before.replace(/\s+$/, '') + sep + after.replace(/^\s+/, ''));
      return;
    }
    const m = /^:where\(([\s\S]*)\)$/i.exec(part.text);
    const rep = m ? m[1] : `:where(${part.text})`;
    ctx.set(w, text.slice(0, s) + rep + text.slice(e));
  }

  // ---------------- drawing ----------------
  function drawRule(w, d, win, decided) {
    const R = rules[w];
    const raw = String(ctx.raw[w] ?? '');
    if (R.ta.value !== raw) R.ta.value = raw;
    const X = d[w];
    // backdrop: the typed text with each part coloured by its column
    const spans = [];
    const parts = [];
    X.list.forEach((sel, si) => sel.parts.forEach((p) => parts.push({ ...p, si, best: si === X.best || X.list.length === 1 })));
    parts.sort((p, q) => p.at[0] - q.at[0]);
    let pos = 0;
    for (const [k, p] of parts.entries()) {
      if (p.at[0] < pos) continue;
      if (p.at[0] > pos) spans.push(`<span class="cs-gap">${esc(raw.slice(pos, p.at[0]))}</span>`);
      spans.push(`<span class="cs-part c-${colOf(p.adds)}${p.best ? '' : ' dim'}" data-k="${k}">${esc(raw.slice(p.at[0], p.at[1]))}</span>`);
      pos = p.at[1];
    }
    if (pos < raw.length) spans.push(`<span class="cs-gap">${esc(raw.slice(pos))}</span>`);
    R.back.innerHTML = spans.join('') + '​';
    R.ta.style.height = `${R.back.scrollHeight}px`;
    R.ta.classList.toggle('bad', X.errors.length > 0 && !(X.errors[0] === 'empty'));

    // brackets under each part, placed from the backdrop's rendered spans
    R.marks.replaceChildren();
    const base = R.back.getBoundingClientRect();
    for (const sp of R.back.querySelectorAll('.cs-part')) {
      const p = parts[Number(sp.dataset.k)];
      const rects = [...sp.getClientRects()];
      if (!rects.length) continue;
      const r = rects[0];
      const where = /^:where\(/i.test(p.text);
      const b = el('button', { class: `cs-mark c-${colOf(p.adds)}${p.best ? '' : ' dim'}`, type: 'button',
        style: `left:${r.left - base.left}px;top:${r.bottom - base.top + 1}px;width:${Math.max(6, r.width)}px`,
        'aria-label': `${p.text}: ${p.kind}, adds (${p.adds.join(', ')}). Enter: ${where ? 'unwrap from :where()' : 'wrap in :where()'}; Delete: remove`,
        title: `${p.text}\n${p.kind} → adds (${p.adds.join(', ')})\nClick: ${where ? 'unwrap from :where()' : 'wrap in :where() (counts 0)'} · Del: remove` },
      `<span>${tag(p.adds)}</span>`);
      b.addEventListener('click', () => editPart(w, p, 'where'));
      const info = () => showInfo(w, p);
      b.addEventListener('pointerenter', info);
      b.addEventListener('focus', info);
      b.addEventListener('pointerleave', () => showInfo());
      b.addEventListener('blur', () => showInfo());
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editPart(w, p, 'remove'); }
      });
      R.marks.append(b);
    }

    // specificity triple next to the rule
    const col = { ids: 0, classes: 1, types: 2 }[decided];
    R.specBig.innerHTML = `<span class="cs-trip">(${X.spec.map((v, i) => `<b class="c-${COLS[i]}${i === col ? ' key' : ''}">${v}</b>`).join('<em>,</em>')})</span>`
      + (win === w.toUpperCase() ? '<span class="cs-wins">applies</span>' : '<span class="cs-loses">overridden</span>');
    const imp = !!ctx.input[w === 'a' ? 'importantA' : 'importantB'];
    R.imp.setAttribute('aria-pressed', String(imp));
    R.imp.title = imp ? 'Click to remove !important' : 'Click to add !important';
    R.box.classList.toggle('lost', win !== w.toUpperCase());
    R.decl.querySelector('.cs-over').textContent = win !== w.toUpperCase() ? `overridden by ${win}` : '';
  }

  function pips(n, cls) {
    const show = Math.min(n, 8);
    let h = '';
    for (let i = 0; i < show; i++) h += `<i class="${cls}"></i>`;
    if (n > 8) h += `<small>+${n - 8}</small>`;
    return h;
  }

  function drawGates(d) {
    const inp = ctx.input;
    const A = d.a.spec, B = d.b.spec;
    const order = ['important', 'ids', 'classes', 'types', 'order'];
    const at = order.indexOf(d.decided);
    const rows = [
      { k: 'important', name: '!important', sub: 'importance beats everything below',
        a: inp.importantA ? '!important' : 'normal', b: inp.importantB ? '!important' : 'normal', cmp: inp.importantA === inp.importantB ? '=' : inp.importantA ? '>' : '<', toggle: true },
      ...[0, 1, 2].map((i) => ({ k: ['ids', 'classes', 'types'][i], name: ['IDs', 'Classes', 'Types'][i],
        sub: ['#id', '.class  [attr]  :pseudo-class', 'element  ::pseudo-element'][i], a: A[i], b: B[i], col: COLS[i],
        cmp: A[i] === B[i] ? '=' : A[i] > B[i] ? '>' : '<' })),
      { k: 'order', name: 'Source order', sub: 'the later rule wins', a: inp.bLater ? '1st' : '2nd', b: inp.bLater ? '2nd' : '1st',
        cmp: inp.bLater ? '<' : '>', swap: true },
    ];
    gates.replaceChildren();
    rows.forEach((r, i) => {
      const state = i < at ? 'tie' : i === at ? 'key' : 'skip';
      const g = el('div', { class: `cs-gate ${state}` });
      const mk = (w) => {
        const v = r[w];
        const winner = state === 'key' && d.winner === w.toUpperCase();
        if (r.col) return `<div class="cs-gv ${w}${winner ? ' win' : ''}"><b class="c-${r.col}">${v}</b><span class="cs-pips">${pips(v, `c-${r.col}`)}</span></div>`;
        return `<div class="cs-gv ${w}${winner ? ' win' : ''}"><button type="button" class="cs-gbtn" data-w="${w}" ${r.toggle ? `aria-pressed="${w === 'a' ? !!inp.importantA : !!inp.importantB}"` : ''}>${v}</button></div>`;
      };
      const verdict = state === 'key' ? `<span class="cs-dec">${d.winner} wins here</span>` : state === 'tie' ? '<span class="cs-tie">tie, next</span>' : '<span class="cs-skip">not reached</span>';
      g.innerHTML = `<div class="cs-gn"><b>${r.name}</b><span>${esc(r.sub)}</span></div>${mk('a')}<div class="cs-cmp">${r.cmp === '=' ? '=' : r.cmp === '>' ? '&gt;' : '&lt;'}</div>${mk('b')}<div class="cs-gd">${verdict}</div>`;
      for (const b of g.querySelectorAll('.cs-gbtn')) {
        b.addEventListener('click', () => {
          if (r.toggle) { const key = b.dataset.w === 'a' ? 'importantA' : 'importantB'; ctx.set(key, !ctx.input[key]); }
          else swapOrder();
        });
        b.title = r.toggle ? 'Toggle !important' : 'Swap source order';
      }
      gates.append(g);
    });
    const head = el('div', { class: 'cs-gate cs-gh' }, '<div></div><div class="cs-gv a"><span class="cs-badge">A</span></div><div></div><div class="cs-gv b"><span class="cs-badge b">B</span></div><div></div>');
    gates.prepend(head);
  }

  function render(res) {
    const d = res && res.drawing;
    if (!d) {
      warnBox.innerHTML = (res?.warnings || []).map((w) => `<div>${esc(w)}</div>`).join('');
      return;
    }
    // stylesheet order
    const first = ctx.input.bLater ? 'a' : 'b';
    const second = first === 'a' ? 'b' : 'a';
    // Reorder only when the order changed: moving a focused textarea blurs it.
    if (code.firstChild !== rules[first].box) code.replaceChildren(rules[first].box, between, rules[second].box, verdictLine);
    drawRule('a', d, d.winner, d.decided);
    drawRule('b', d, d.winner, d.decided);
    verdictLine.innerHTML = `/* ${esc(d.why)} */`;
    warnBox.innerHTML = (res.warnings || []).map((w) => `<div>${esc(w)}</div>`).join('');
    drawGates(d);
    out.innerHTML = `<span class="cs-badge ${d.winner === 'B' ? 'b' : ''}">${d.winner}</span><div><b>${d.winner} applies</b> <span>by ${d.decided === 'important' ? '!important' : d.decided === 'order' ? 'source order' : `specificity, ${COL_NAME[{ ids: 0, classes: 1, types: 2 }[d.decided]]} column`}</span><p>${esc(d.why)}</p></div>`;
    preview.innerHTML = `<span class="cs-pv-lab">An element both select</span><span class="cs-pv-el w-${d.winner.toLowerCase()}">&lt;a&gt; Menu link &lt;/a&gt;</span><span class="cs-pv-lab">color from ${d.winner}</span>`;
    notes.innerHTML = `<b>How it counts</b>${(res.notes || []).slice(1).map((n) => `<p>${esc(n)}</p>`).join('')}`;
  }

  ctx.onResult((res) => render(res));
  // Brackets are placed from the text's layout: redo on resize.
  let rz = null;
  let lastW = 0;
  new ResizeObserver(() => {
    if (code.clientWidth === lastW) return;
    lastW = code.clientWidth;
    cancelAnimationFrame(rz); rz = requestAnimationFrame(() => ctx.result && render(ctx.result));
  }).observe(code);
}
