// Prompt Anatomy Builder, drawn as the thing itself: the prompt's own text,
// each part tinted by its section (role, context, task, constraints,
// examples, output format, data), a gutter that shows where each section
// starts and ends, and the findings underlined in place.
//   Type or paste straight into the text: it is a real textarea laid over the
//   tinted copy. Put the caret in a part to see (and change) its section.
//   Drag the rows of the Sections rail (or Alt+Up/Down) to reorder the
//   prompt; click a finding to select its words; Fix applies the change.
// Everything drawn comes from run()'s result.anatomy; the edits (reorder,
// fixes) are computed by tool.js's own rebuild()/applyFix().

import { applyFix, SECTIONS, SECTION_LABEL } from './tool.js';

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
const SHORT = { role: 'Role', context: 'Ctx', task: 'Task', constraints: 'Rules', examples: 'Ex', format: 'Fmt', data: 'Data' };
const SEV = { bad: 'Bad', warn: 'Warn', info: 'Info' };

export function page(root, ctx) {
  const state = { selSpan: -1, hot: -1, undo: [], narrow: false, drag: null, focusRow: -1 };
  const an = () => ctx.result?.anatomy || null;

  // ---------- editor ----------
  const back = h('div', { class: 'pa-back', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'pa-ta', spellcheck: 'false', 'aria-label': 'Prompt text (sections are tinted behind it)', autocomplete: 'off' });
  ta.value = ctx.raw.prompt || '';
  const gutter = h('div', { class: 'pa-gutter', 'aria-hidden': 'true' });
  const textwrap = h('div', { class: 'pa-textwrap' }, back, ta);
  const doc = h('div', { class: 'pa-doc' }, gutter, textwrap);
  const scroller = h('div', { class: 'pa-scroll' }, doc);
  const tokOut = h('span', { class: 'pa-sub' });
  const msg = h('span', { class: 'pa-msg', role: 'status' });
  const undoBtn = h('button', { class: 'k-btn', type: 'button', disabled: true, title: 'Undo the last reorder, fix, paste or clear', onclick: () => undo() }, 'Undo');
  const pasteBtn = h('button', { class: 'k-btn', type: 'button', title: 'Replace the prompt with the clipboard', onclick: async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { say('The clipboard is empty.'); return; }
      change(t, 'Pasted from the clipboard.');
    } catch { say('The browser did not give the clipboard; click in the text and press Ctrl+V.'); ta.focus(); }
  } }, 'Paste');
  const clearBtn = h('button', { class: 'k-btn', type: 'button', onclick: () => { change('', 'Cleared. Paste a prompt or type one.'); ta.focus(); } }, 'Clear');
  const legend = h('div', { class: 'pa-legend' }, SECTIONS.map((c) => h('span', { class: `pa-chip c-${c}` }, h('i'), SECTION_LABEL[c])));
  const selBar = h('div', { class: 'pa-selbar' });
  const warnBox = h('div', { class: 'pa-warns', role: 'alert' });
  const editor = h('section', { class: 'pa-card pa-editor' },
    h('div', { class: 'pa-head' }, h('h2', {}, 'Prompt'), tokOut, h('span', { class: 'pa-grow' }), msg, pasteBtn, clearBtn, undoBtn),
    legend, scroller, selBar, warnBox);

  // ---------- rail ----------
  const shareBar = h('div', { class: 'pa-share', role: 'img' });
  const rows = h('ol', { class: 'pa-rows', 'aria-label': 'Sections in prompt order. Alt+Up or Alt+Down moves the focused section.' });
  const secCard = h('section', { class: 'pa-card' },
    h('div', { class: 'pa-head' }, h('h2', {}, 'Sections in order'), h('span', { class: 'pa-sub', text: 'drag to reorder' })),
    shareBar, rows);
  const findSum = h('span', { class: 'pa-sub' });
  const fixAll = h('button', { class: 'k-btn k-primary', type: 'button', title: 'Wrap data in tags, move the task after the data, calm the capitals, add a format skeleton', onclick: () => {
    const draft = ctx.result?.texts?.find((t) => t.title === 'Improved draft')?.body;
    if (draft != null && draft !== ctx.raw.prompt) change(draft, 'Applied every mechanical fix. Vague words and contradictions are left for you.');
  } }, 'Apply mechanical fixes');
  const findList = h('ul', { class: 'pa-finds' });
  const findCard = h('section', { class: 'pa-card' },
    h('div', { class: 'pa-head' }, h('h2', {}, 'Findings'), findSum, h('span', { class: 'pa-grow' }), fixAll), findList);
  const notes = h('div', { class: 'k-notes pa-notes' });
  const rail = h('aside', { class: 'pa-rail' }, secCard, findCard, ctx.outputs, notes);
  root.append(h('div', { class: 'pa' }, editor, rail));

  // ---------- edits ----------
  function say(t) { msg.textContent = t; if (t) setTimeout(() => { if (msg.textContent === t) msg.textContent = ''; }, 6000); }
  function change(text, note) {
    const cur = ctx.raw.prompt || '';
    if (text === cur) return;
    state.undo.push(cur); if (state.undo.length > 50) state.undo.shift();
    undoBtn.disabled = false;
    ta.value = text; state.hot = -1;
    back.textContent = text + '\n';
    ctx.set('prompt', text);
    if (note) say(note);
  }
  function undo() {
    const prev = state.undo.pop();
    if (prev == null) return;
    ta.value = prev; back.textContent = prev + '\n';
    ctx.set('prompt', prev); undoBtn.disabled = !state.undo.length; say('Undone.');
  }
  ta.addEventListener('input', () => {
    back.textContent = ta.value + '\n';                    // keeps the height right until the result is in
    ctx.set('prompt', ta.value);
  });
  const caret = () => {
    const a = an(); if (!a) return;
    const p = ta.selectionStart;
    let k = a.spans.findIndex((x) => p >= x.s && p <= x.e);
    if (k < 0) k = a.spans.reduce((b, x, i) => (x.s <= p ? i : b), -1);
    if (k !== state.selSpan) { state.selSpan = k; markSel(); drawSelBar(); }
  };
  for (const ev of ['click', 'keyup', 'select', 'focus']) ta.addEventListener(ev, caret);

  function selectRange(s, e) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(s, Math.max(s, e));
    const piece = [...back.querySelectorAll('[data-s]')].find((x) => +x.dataset.s <= s && s < +x.dataset.e) || back.lastElementChild;
    if (piece) {
      const top = piece.getBoundingClientRect().top - doc.getBoundingClientRect().top;
      if (scroller.scrollHeight > scroller.clientHeight + 4) scroller.scrollTo({ top: Math.max(0, top - 60), behavior: 'smooth' });
      else piece.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    caret();
  }

  // ---------- draw: the tinted text ----------
  function drawBack(a) {
    const text = a.text;
    const cuts = new Set([0, text.length]);
    for (const sp of a.spans) { cuts.add(sp.s); cuts.add(sp.e); }
    for (const f of a.findings) if (f.e > f.s) { cuts.add(f.s); cuts.add(f.e); }
    const pts = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((x, y) => x - y);
    const rank = { bad: 3, warn: 2, info: 1 };
    const frag = document.createDocumentFragment();
    let si = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const s = pts[k], e = pts[k + 1];
      if (e <= s) continue;
      while (si < a.spans.length && a.spans[si].e <= s) si++;
      const sp = a.spans[si] && a.spans[si].s <= s && a.spans[si].e >= e ? a.spans[si] : null;
      const fs = a.findings.filter((f) => f.e > f.s && f.s <= s && f.e >= e && f.rule !== 'undelimited-data' && f.rule !== 'label-only-data');
      const sev = fs.reduce((b, f) => (rank[f.sev] > (rank[b] || 0) ? f.sev : b), '');
      const cls = [sp ? `mk c-${sp.cls}` : '', sev ? `lint-${sev}` : '', fs.some((f) => f.id === state.hot) ? 'hot' : ''].filter(Boolean).join(' ');
      const el = h(cls ? 'mark' : 'span', { class: cls || null, 'data-s': s, 'data-e': e, 'data-span': sp ? a.spans.indexOf(sp) : null, 'data-seg': sp ? sp.seg : null });
      el.textContent = text.slice(s, e);
      frag.append(el);
    }
    frag.append(document.createTextNode('\n'));
    back.replaceChildren(frag);
    // Data that is not delimited gets a dashed frame, drawn on its marks.
    for (const f of a.findings.filter((x) => x.rule === 'undelimited-data')) {
      for (const el of back.querySelectorAll('mark')) if (+el.dataset.s >= f.s && +el.dataset.e <= f.e) el.classList.add('undelim');
    }
    markSel();
  }
  function markSel() {
    const a = an(); if (!a) return;
    const seg = a.spans[state.selSpan]?.seg;
    for (const el of back.querySelectorAll('mark.on')) el.classList.remove('on');
    if (seg != null) for (const el of back.querySelectorAll(`mark[data-seg="${seg}"]`)) el.classList.add('on');
    for (const r of rows.children) r.classList.toggle('on', r.dataset.seg != null && +r.dataset.seg === seg);
    for (const g of gutter.querySelectorAll('.pa-gbar')) g.classList.toggle('on', +g.dataset.seg === seg);
  }

  // ---------- draw: the gutter ----------
  function drawGutter(a) {
    gutter.replaceChildren();
    const top0 = back.getBoundingClientRect().top;
    const marks = [...back.querySelectorAll('mark[data-seg]')];
    const bySeg = new Map();
    for (const m of marks) {
      const r = m.getBoundingClientRect();
      if (!r.height) continue;
      const g = bySeg.get(m.dataset.seg) || { top: Infinity, bot: -Infinity };
      g.top = Math.min(g.top, r.top - top0); g.bot = Math.max(g.bot, r.bottom - top0);
      bySeg.set(m.dataset.seg, g);
    }
    let lastLabel = -99;
    a.segs.forEach((g, i) => {
      const y = bySeg.get(String(i));
      if (!y) return;
      const bar = h('div', { class: `pa-gbar c-${g.cls}`, 'data-seg': i, style: `top:${y.top}px;height:${Math.max(6, y.bot - y.top)}px`, title: `${SECTION_LABEL[g.cls]} · ~${g.tok} tokens` });
      bar.addEventListener('click', () => selectRange(g.s, g.s));
      gutter.append(bar);
      if (y.top - lastLabel >= (state.narrow ? 16 : 30)) {
        gutter.append(h('div', { class: `pa-glabel c-${g.cls}`, style: `top:${y.top}px` }, state.narrow ? SHORT[g.cls] : SECTION_LABEL[g.cls],
          state.narrow ? null : h('small', {}, `${g.tok} tk`)));
        lastLabel = y.top;
      }
    });
    // Severity ticks where findings sit.
    const seenY = new Set();
    for (const f of a.findings) {
      if (f.e <= f.s && f.rule !== 'missing-format' && f.rule !== 'missing-task') continue;
      const piece = [...back.querySelectorAll('[data-s]')].find((x) => +x.dataset.s <= f.s && f.s < +x.dataset.e) || back.lastElementChild;
      if (!piece) continue;
      const r = piece.getClientRects()[0] || piece.getBoundingClientRect();
      const y = Math.round(r.top - top0);
      const key = `${y}-${f.sev}`;
      if (seenY.has(key)) continue;
      seenY.add(key);
      const dot = h('button', { class: `pa-gdot sev-${f.sev}`, type: 'button', style: `top:${y + 3}px`, title: f.msg, 'aria-label': `${SEV[f.sev]}: ${f.msg}`, tabindex: '-1' });
      dot.addEventListener('click', () => focusFinding(f));
      gutter.append(dot);
    }
    gutter.style.height = `${back.offsetHeight}px`;
  }

  // ---------- draw: selected part ----------
  function drawSelBar() {
    const a = an();
    const sp = a?.spans[state.selSpan];
    if (!sp) { selBar.replaceChildren(h('span', { class: 'pa-sub' }, 'Put the caret in a part of the prompt to see why it got its section, and change it.')); return; }
    const snippet = a.text.slice(sp.s, sp.e).replace(/\s+/g, ' ').trim();
    const sel = h('select', { 'aria-label': 'Section of the selected part' }, SECTIONS.map((c) => h('option', { value: c, selected: c === sp.cls }, SECTION_LABEL[c])));
    sel.addEventListener('change', () => {
      const lead = snippet.toLowerCase().split(' ').slice(0, 6).join(' ').replace(/[=;]/g, ' ').trim();
      const lines = String(ctx.raw.overrides || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.toLowerCase().startsWith(lead));
      lines.push(`${lead} = ${sel.value}`);
      ctx.set('overrides', lines.join('\n'));
      say(`"${lead}…" is now ${SECTION_LABEL[sel.value]}.`);
    });
    const ovN = String(ctx.raw.overrides || '').split('\n').filter((l) => l.trim()).length;
    selBar.replaceChildren(
      h('span', { class: `pa-chip c-${sp.cls}` }, h('i')),
      h('label', { class: 'pa-f' }, 'Section', sel),
      h('span', { class: 'pa-sub pa-why' }, `by ${sp.how}: "${snippet.length > 70 ? snippet.slice(0, 69) + '…' : snippet}"`),
      ovN ? h('button', { class: 'k-btn', type: 'button', title: String(ctx.raw.overrides), onclick: () => { ctx.set('overrides', ''); say('Section overrides cleared.'); } }, `Clear ${ovN} override${ovN > 1 ? 's' : ''}`) : null);
  }

  // ---------- draw: sections rail ----------
  function drawRail(a) {
    shareBar.replaceChildren(...a.segs.map((g, i) => h('span', { class: `c-${g.cls}`, style: `flex-grow:${Math.max(0.004, g.share)}`, title: `${i + 1}. ${SECTION_LABEL[g.cls]} ${Math.round(g.share * 100)} %` })));
    shareBar.setAttribute('aria-label', 'Token share per section: ' + a.segs.map((g) => `${SECTION_LABEL[g.cls]} ${Math.round(g.share * 100)}%`).join(', '));
    const maxShare = Math.max(0.01, ...a.segs.map((g) => g.share));
    const list = a.segs.map((g, i) => {
      const row = h('li', { class: `pa-row c-${g.cls}`, tabindex: '0', 'data-seg': i,
        'aria-label': `${i + 1}. ${SECTION_LABEL[g.cls]}, about ${g.tok} tokens: ${g.head}` },
      h('span', { class: 'pa-grip', 'aria-hidden': 'true' }),
      h('span', { class: 'pa-n' }, String(i + 1)),
      h('span', { class: 'pa-rname' }, SECTION_LABEL[g.cls]),
      h('span', { class: 'pa-rhead' }, g.head),
      h('span', { class: 'pa-rtok' }, `${g.tok}`),
      h('span', { class: 'pa-rbar' }, h('i', { style: `width:${(g.share / maxShare) * 100}%` })));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRange(g.s, g.e); }
        else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          const to = i + (e.key === 'ArrowUp' ? -1 : 1);
          if (to < 0 || to >= a.segs.length) return;
          state.focusRow = to; move(i, to);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          (e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling)?.focus();
        }
      });
      row.addEventListener('pointerdown', (e) => startDrag(e, row, i));
      return row;
    });
    const missing = ['task', 'format'].filter((c) => !a.perClass[c]);
    const ghosts = missing.map((c) => h('li', { class: `pa-row pa-ghost c-${c}` },
      h('span', { class: 'pa-grip', 'aria-hidden': 'true' }), h('span', { class: 'pa-n' }, '–'),
      h('span', { class: 'pa-rname' }, SECTION_LABEL[c]), h('span', { class: 'pa-rhead' }, 'missing'),
      h('button', { class: 'k-btn', type: 'button', onclick: () => change(applyFix(ctx.raw.prompt || '', c === 'task' ? 'add-task' : 'add-format'), `Added a ${SECTION_LABEL[c].toLowerCase()} skeleton at the end: fill in the <…> parts.`) }, 'Add skeleton')));
    rows.replaceChildren(...list, ...ghosts);
    if (state.focusRow >= 0) { rows.children[state.focusRow]?.focus(); state.focusRow = -1; }
  }
  function move(from, to) {
    const a = an(); if (!a) return;
    const order = a.segs.map((_, i) => i);
    const [x] = order.splice(from, 1); order.splice(to, 0, x);
    const next = applyFix(ctx.raw.prompt || '', 'reorder', ctx.raw.overrides || '', order);
    change(next, `Moved ${SECTION_LABEL[a.segs[from].cls]} to position ${to + 1}.`);
  }
  function startDrag(e, row, i) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const items = [...rows.querySelectorAll('.pa-row:not(.pa-ghost)')];
    const rects = items.map((r) => r.getBoundingClientRect());
    const y0 = e.clientY;
    let to = i, moved = false;
    row.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const dy = ev.clientY - y0;
      if (!moved && Math.abs(dy) < 4) return;
      moved = true;
      row.classList.add('drag');
      row.style.transform = `translateY(${dy}px)`;
      const mid = rects[i].top + rects[i].height / 2 + dy;
      to = rects.findIndex((r) => mid < r.top + r.height / 2);
      if (to < 0) to = items.length - 1;
      else if (to > i) to -= 1;
      items.forEach((r, k) => r.classList.toggle('drop-before', k === (to >= i ? to + 1 : to) && k !== i));
      rows.classList.toggle('drop-end', to === items.length - 1 && to !== i);
    };
    const onUp = () => {
      row.removeEventListener('pointermove', onMove); row.removeEventListener('pointerup', onUp); row.removeEventListener('pointercancel', onUp);
      row.classList.remove('drag'); row.style.transform = '';
      items.forEach((r) => r.classList.remove('drop-before')); rows.classList.remove('drop-end');
      if (!moved) { const g = an()?.segs[i]; if (g) selectRange(g.s, g.e); return; }
      if (to !== i) move(i, to);
    };
    row.addEventListener('pointermove', onMove); row.addEventListener('pointerup', onUp); row.addEventListener('pointercancel', onUp);
  }

  // ---------- draw: findings ----------
  function focusFinding(f) {
    state.hot = f.id;
    for (const li of findList.children) li.classList.toggle('on', +li.dataset.id === f.id);
    for (const el of back.querySelectorAll('.hot')) el.classList.remove('hot');
    for (const el of back.querySelectorAll('[data-s]')) if (+el.dataset.s >= f.s && +el.dataset.e <= f.e && f.e > f.s) el.classList.add('hot');
    selectRange(f.s, f.e);
  }
  const FIXLABEL = { 'wrap-data': 'Wrap in tags', 'task-last': 'Move task to end', 'add-format': 'Add format', 'add-task': 'Add task', 'add-role': 'Add role',
    calm: 'Calm capitals', 'drop-duplicate': 'Drop repeat', 'add-data-rule': 'Add data rule' };
  function drawFindings(a) {
    const n = (s) => a.findings.filter((f) => f.sev === s).length;
    findSum.replaceChildren(...['bad', 'warn', 'info'].map((s) => h('b', { class: `sev-${s}` }, `${n(s)} ${s}`)));
    fixAll.disabled = !a.findings.some((f) => f.fix && ['wrap-data', 'task-last', 'calm', 'add-format', 'add-data-rule'].includes(f.fix));
    if (!a.findings.length) { findList.replaceChildren(h('li', { class: 'pa-none' }, 'No findings. The checks are heuristics: read it once more as the model would.')); return; }
    findList.replaceChildren(...a.findings.map((f) => {
      const li = h('li', { class: `pa-find sev-${f.sev}${f.id === state.hot ? ' on' : ''}`, 'data-id': f.id },
        h('button', { class: 'pa-fbtn', type: 'button', onclick: () => focusFinding(f) },
          h('span', { class: `pa-sev sev-${f.sev}` }, SEV[f.sev]), h('span', { class: 'pa-ftext' }, f.msg)),
        f.fix ? h('button', { class: 'k-btn pa-fix', type: 'button', onclick: () => {
          const next = applyFix(ctx.raw.prompt || '', f.fix, ctx.raw.overrides || '', f.fix === 'drop-duplicate' ? [f.s, f.e] : null);
          if (next === (ctx.raw.prompt || '')) { say('Nothing to change for that one.'); return; }
          change(next, `${FIXLABEL[f.fix] || 'Fixed'}: done. Undo brings it back.`);
        } }, FIXLABEL[f.fix] || 'Fix') : null);
      return li;
    }));
  }

  // ---------- result ----------
  function render(res) {
    const a = res?.anatomy;
    if (!a) return;
    if (ta.value !== a.text && document.activeElement !== ta) ta.value = a.text;
    const tk = a.tokens;
    tokOut.replaceChildren(h('b', {}, `≈ ${tk.est}`), ' tokens ', h('span', { class: 'pa-est', title: 'An estimate, not the model\'s tokenizer' }, `(chars/4 ${tk.chars} · word-piece ${tk.wp}, estimate)`));
    if (state.selSpan >= a.spans.length) state.selSpan = -1;
    drawBack(a);
    drawRail(a);
    drawFindings(a);
    drawSelBar();
    requestAnimationFrame(() => drawGutter(a));
    const extra = (res.warnings || []).filter((w) => /override/i.test(w));
    warnBox.replaceChildren(...extra.map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((t) => h('div', {}, t)));
  }
  let tabChosen = false;
  ctx.onResult((res) => {
    render(res);
    if (!tabChosen) {
      tabChosen = true;
      let saved = null;
      try { saved = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
      if (!saved) [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'Improved draft')?.click();
    }
  });
  let rt = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(rt);
    rt = requestAnimationFrame(() => {
      const narrow = root.clientWidth < 560;
      if (narrow !== state.narrow) state.narrow = narrow;
      const a = an(); if (a) drawGutter(a);
    });
  }).observe(textwrap);
  // Pick up an example loaded from the bar (the kit changes the input, not the textarea).
  ctx.onResult(() => { const p = ctx.raw.prompt || ''; if (ta.value !== p && document.activeElement !== ta) { ta.value = p; } });
}
