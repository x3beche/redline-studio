// Build Error & QA Explainer, drawn as the thing itself: the log.
//   Log       - every line of the pasted log with its number; the lines that
//               decide a failure carry the finding's number in the gutter and
//               its colour, the lines that only follow from it (Logfile...,
//               Task ... failed) are tinted. A ruler on the right marks where
//               the findings are in a long log. Paste or drop a log onto it,
//               or Edit it in place. "Context only" folds the lines no finding
//               needs.
//   Findings  - one card per finding: what, why, the fix lines with Copy, the
//               Yocto doc section. Click a card or a numbered line: both sides
//               follow. Keys on the log: n / p (or j / k) next / previous finding.
//   Map       - the failed tasks and the kinds of finding as chips; a kind
//               chip filters the cards and the marks.
// Everything drawn comes from run()'s result.view; the page writes only the
// log text and the two options back.

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
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};
const KEY = 'redline.tool.yocto-build-errors.page';

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const was = btn.textContent; btn.textContent = ok ? 'Copied' : 'Select and copy';
  setTimeout(() => { btn.textContent = was; }, 1300);
}

export function page(root, ctx) {
  const saved = store.get(KEY) || {};
  let res = null, sel = 0, filter = '', fold = !!saved.fold, editing = false;

  // ---------- map strip ----------
  const build = h('div', { class: 'ybe-build' });
  const chips = h('div', { class: 'ybe-chips', role: 'toolbar', 'aria-label': 'Failed tasks and kinds' });
  const strip = h('section', { class: 'ybe-strip' }, build, chips);

  // ---------- log ----------
  const syntaxSel = h('select', { 'aria-label': 'Override syntax of the fixes', onchange: (e) => ctx.set('syntax', e.target.value) },
    h('option', { value: 'auto' }, 'Fix syntax: auto'), h('option', { value: 'colon' }, 'FILES:${PN} (3.4+)'), h('option', { value: 'underscore' }, 'FILES_${PN} (≤3.3)'));
  const warnBox = h('input', { type: 'checkbox', onchange: (e) => ctx.set('warnings', e.target.checked) });
  const foldBox = h('input', { type: 'checkbox', onchange: (e) => { fold = e.target.checked; store.set(KEY, { fold }); drawLog(); } });
  const fileIn = h('input', { type: 'file', accept: '.log,.txt,text/*', hidden: true, onchange: (e) => readFile(e.target.files[0]) });
  const editBtn = h('button', { class: 'k-btn', onclick: () => setEditing(!editing), title: 'Edit the log text in place' }, 'Edit');
  const prevBtn = h('button', { class: 'k-btn', title: 'Previous finding (p)', 'aria-label': 'Previous finding', onclick: () => step(-1) }, '↑');
  const nextBtn = h('button', { class: 'k-btn', title: 'Next finding (n)', 'aria-label': 'Next finding', onclick: () => step(1) }, '↓');
  const logSub = h('span', { class: 'ybe-sub' });
  const logBar = h('div', { class: 'ybe-bar' },
    h('button', { class: 'k-btn', onclick: pasteClip, title: 'Replace the log with the clipboard' }, 'Paste'),
    h('button', { class: 'k-btn', onclick: () => fileIn.click(), title: 'Open a log file (or drop one on the log)' }, 'Open…'), fileIn, editBtn,
    h('label', { class: 'ybe-chk', title: 'Fold the lines no finding needs' }, foldBox, 'Context only'),
    h('label', { class: 'ybe-chk', title: 'Off: only ERROR lines become findings' }, warnBox, 'Warnings'),
    syntaxSel, h('span', { class: 'ybe-nav' }, prevBtn, nextBtn));
  const lines = h('div', { class: 'ybe-lines', role: 'list' });
  const ruler = h('div', { class: 'ybe-ruler', 'aria-hidden': 'true' });
  const scroller = h('div', { class: 'ybe-scroll', tabindex: '0', 'aria-label': 'Log. n / p: next / previous finding. Paste replaces the log.' }, lines);
  const ta = h('textarea', { class: 'ybe-ta', spellcheck: 'false', hidden: true, 'aria-label': 'Log text' });
  const drop = h('div', { class: 'ybe-drop', hidden: true }, 'Drop the log file');
  const logCard = h('section', { class: 'ybe-card ybe-log' },
    h('div', { class: 'ybe-head' }, h('h2', {}, 'Log'), logSub), logBar,
    h('div', { class: 'ybe-body' }, scroller, ta, ruler, drop));

  // ---------- findings ----------
  const warns = h('div', { class: 'ybe-warns', role: 'status' });
  const list = h('div', { class: 'ybe-list', role: 'listbox', 'aria-label': 'Findings' });
  const findSub = h('span', { class: 'ybe-sub' });
  const findCard = h('section', { class: 'ybe-card ybe-find' }, h('div', { class: 'ybe-head' }, h('h2', {}, 'Findings'), findSub), warns, list);
  const notes = h('details', { class: 'ybe-notes' }, h('summary', {}, 'Notes'));

  const wrap = h('div', { class: 'ybe' }, strip, h('div', { class: 'ybe-grid' }, logCard, h('div', { class: 'ybe-col' }, findCard, ctx.outputs, notes)));
  root.append(wrap);

  // ---------- input ----------
  let tmr = null;
  ta.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => ctx.set('log', ta.value), 350); });
  function setEditing(on) {
    editing = on;
    if (on) { ta.value = ctx.raw.log || ''; ta.hidden = false; scroller.hidden = true; ruler.hidden = true; editBtn.textContent = 'Done'; editBtn.setAttribute('aria-pressed', 'true'); ta.focus(); }
    else { clearTimeout(tmr); if (ta.value !== ctx.raw.log) ctx.set('log', ta.value); ta.hidden = true; scroller.hidden = false; ruler.hidden = false; editBtn.textContent = 'Edit'; editBtn.removeAttribute('aria-pressed'); }
  }
  async function pasteClip() {
    try { const t = await navigator.clipboard.readText(); if (t && t.trim()) { sel = 0; ctx.set('log', t); } }
    catch { logSub.textContent = 'Clipboard not readable here: click the log and press Ctrl+V.'; }
  }
  function readFile(file) {
    if (!file) return;
    if (file.size > 30e6) { logSub.textContent = 'That file is over 30 MB: cut it to the failing part.'; return; }
    const r = new FileReader();
    r.onload = () => { sel = 0; ctx.set('log', String(r.result)); };
    r.readAsText(file);
  }
  scroller.addEventListener('paste', (e) => {
    const t = e.clipboardData && e.clipboardData.getData('text/plain');
    if (t && t.trim()) { e.preventDefault(); sel = 0; ctx.set('log', t); }
  });
  const body = logCard.querySelector('.ybe-body');
  body.addEventListener('dragover', (e) => { e.preventDefault(); drop.hidden = false; });
  body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) drop.hidden = true; });
  body.addEventListener('drop', (e) => {
    e.preventDefault(); drop.hidden = true;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f); else { const t = e.dataTransfer.getData('text/plain'); if (t) ctx.set('log', t); }
  });
  scroller.addEventListener('keydown', (e) => {
    if (e.target !== scroller && !e.target.classList.contains('ybe-badge')) return;
    if (e.key === 'n' || e.key === 'j') { e.preventDefault(); step(1); }
    else if (e.key === 'p' || e.key === 'k') { e.preventDefault(); step(-1); }
  });

  // ---------- selection ----------
  const visibleCards = () => (res ? res.view.cards.filter((c) => !filter || c.cat === filter) : []);
  function step(d) {
    const cs = visibleCards(); if (!cs.length) return;
    const k = cs.findIndex((c) => c.id === sel);
    select(cs[(k + d + cs.length) % cs.length].id, { log: true, card: true });
  }
  function select(id, how = {}) {
    sel = id;
    paintSel();
    drawCards();
    const c = res && res.view.cards.find((x) => x.id === id);
    if (!c) return;
    if (how.log) {
      const first = c.lines[0] || c.ctx[0];
      if (fold) drawLog();
      const el = lines.querySelector(`[data-n="${first}"]`);
      if (el) scroller.scrollTop = Math.max(0, el.offsetTop - scroller.clientHeight * 0.3);
    }
    if (how.card) list.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    if (how.focusCard) list.querySelector(`[data-id="${id}"]`)?.focus({ preventScroll: true });
  }
  function paintSel() {
    for (const el of lines.querySelectorAll('.on')) el.classList.remove('on');
    for (const el of lines.querySelectorAll(`[data-f="${sel}"]`)) el.classList.add('on');
    for (const el of ruler.querySelectorAll('.on')) el.classList.remove('on');
    ruler.querySelector(`[data-id="${sel}"]`)?.classList.add('on');
  }

  // ---------- drawing ----------
  function drawStrip() {
    const v = res.view, b = v.build;
    build.replaceChildren(
      ...[['Release', b.release], ['MACHINE', b.machine], ['Target', b.target], ['BitBake', b.bb]].filter(([, x]) => x)
        .map(([k, x]) => h('span', { class: 'ybe-kv' }, h('i', {}, k), h('b', {}, x))),
      h('span', { class: 'ybe-kv' }, h('i', {}, 'Lines'), h('b', {}, String(v.total))));
    const kinds = {};
    for (const c of v.cards) (kinds[c.cat] ||= { label: c.catLabel, n: 0, bad: 0 }), kinds[c.cat].n++, kinds[c.cat].bad += c.sev === 'error' ? 1 : 0;
    const tasks = v.failed.map((t) => {
      const c = v.cards.find((x) => x.recipe === t.recipe && (x.task === t.task || !x.task));
      return h('button', { class: 'ybe-task', title: `Failed task ${t.recipe}:${t.task} (line ${t.line})`,
        onclick: () => { if (c) { filter = ''; select(c.id, { log: true, card: true }); drawStrip(); drawLog(); } } },
      h('span', { class: 'x' }, '✕'), h('b', {}, t.recipe), h('span', {}, t.task), c ? h('em', {}, `#${c.id}`) : h('em', { class: 'none' }, 'no finding'));
    });
    chips.replaceChildren(
      tasks.length ? h('span', { class: 'ybe-lbl' }, 'Failed') : h('span', { class: 'ybe-lbl' }, v.cards.length ? 'No task failure line' : 'Nothing found'),
      ...tasks,
      Object.keys(kinds).length > 1 || filter ? h('span', { class: 'ybe-lbl gap' }, 'Kinds') : null,
      ...(Object.keys(kinds).length > 1 || filter ? [
        h('button', { class: 'ybe-kind', 'aria-pressed': String(!filter), onclick: () => { filter = ''; drawAll(); } }, 'All ', h('small', {}, String(v.cards.length))),
        ...Object.entries(kinds).map(([k, o]) => h('button', { class: `ybe-kind ${o.bad ? 'bad' : 'warn'}`, 'aria-pressed': String(filter === k),
          onclick: () => { filter = filter === k ? '' : k; const cs = visibleCards(); if (cs.length && !cs.some((c) => c.id === sel)) sel = cs[0].id; drawAll(); } },
        o.label, ' ', h('small', {}, String(o.n))))] : []));
  }

  function drawLog() {
    const v = res.view, L = v.lines, N = L.length;
    const cards = new Map(v.cards.map((c) => [c.id, c]));
    const hidden = (f) => filter && f && cards.get(f)?.cat !== filter;
    const firstOf = new Map(v.cards.map((c) => [c.id, (c.lines[0] || c.ctx[0] || 0) - 1]));
    let keep = null;
    if (fold) {
      keep = new Uint8Array(N);
      L.forEach((l, i) => { if ((l.role === 'dec' || l.role === 'ctx' || l.lv === 'e') && !hidden(l.f)) for (let k = Math.max(0, i - 2); k <= Math.min(N - 1, i + 2); k++) keep[k] = 1; });
    }
    const frag = document.createDocumentFragment();
    let gap = 0;
    const flushGap = (at) => {
      if (!gap) return;
      const from = at - gap;
      const n = gap;
      frag.append(h('button', { class: 'ybe-fold', onclick: () => { fold = false; foldBox.checked = false; store.set(KEY, { fold }); drawLog(); lines.querySelector(`[data-n="${from + 1}"]`)?.scrollIntoView({ block: 'center' }); } }, `⋯ ${n} line${n === 1 ? '' : 's'}`));
      gap = 0;
    };
    for (let i = 0; i < N; i++) {
      if (keep && !keep[i]) { gap++; continue; }
      flushGap(i);
      const l = L[i];
      const hid = hidden(l.f);
      const cls = ['ybe-ln', l.lv ? `lv-${l.lv}` : '', l.p ? 'piped' : '', !hid && l.role ? `r-${l.role}` : '', l.f && !hid ? `sev-${cards.get(l.f)?.sev === 'error' ? 'e' : 'w'}` : '', l.f === sel && !hid ? 'on' : ''].filter(Boolean).join(' ');
      const badge = l.f && !hid && firstOf.get(l.f) === i
        ? h('button', { class: 'ybe-badge', 'data-id': l.f, title: `Finding #${l.f}: ${cards.get(l.f)?.title || ''}`, onclick: () => select(l.f, { card: true }) }, `#${l.f}`)
        : null;
      const row = h('div', { class: cls, 'data-n': i + 1, 'data-f': l.f && !hid ? l.f : null, role: 'listitem' },
        h('span', { class: 'no' }, String(i + 1)), h('span', { class: 'mk' }, badge), h('span', { class: 'tx' }, l.t || ' '));
      if (l.f && !hid) row.addEventListener('click', (e) => { if (!e.target.closest('.ybe-badge') && !window.getSelection().toString()) select(l.f, { card: true }); });
      frag.append(row);
    }
    flushGap(N);
    lines.replaceChildren(frag);
    // the ruler: where the findings are in the whole log
    ruler.replaceChildren(...v.cards.filter((c) => !filter || c.cat === filter).map((c) => {
      const at = ((c.lines[0] || c.ctx[0] || 1) - 1) / Math.max(1, N);
      return h('button', { class: `ybe-tick sev-${c.sev === 'error' ? 'e' : 'w'}${c.id === sel ? ' on' : ''}`, 'data-id': c.id, tabindex: '-1',
        style: `top:calc(${(at * 100).toFixed(2)}% - 1px)`, title: `#${c.id} ${c.title} (line ${c.lines[0] || c.ctx[0]})`, onclick: () => select(c.id, { log: true, card: true }) });
    }));
    const e = v.cards.filter((c) => c.sev === 'error').length;
    logSub.replaceChildren(`${v.total} lines · `, h('b', { class: e ? 'bad' : '' }, `${v.cards.length} finding${v.cards.length === 1 ? '' : 's'}`), ' · paste or drop a log here');
  }

  function drawCards() {
    const v = res.view;
    const cs = visibleCards();
    findSub.textContent = cs.length ? `${cs.length}${filter ? ` of ${v.cards.length}` : ''} · click one, or a numbered line` : '';
    list.replaceChildren(...cs.map((c, k) => {
      const open = c.id === sel;
      const lineBtns = [...c.lines.slice(0, 3)].map((n) => h('button', { class: 'ybe-ref', onclick: (e) => { e.stopPropagation(); select(c.id); const el = lines.querySelector(`[data-n="${n}"]`); if (el) scroller.scrollTop = Math.max(0, el.offsetTop - scroller.clientHeight * 0.3); } }, `line ${n}`));
      const pre = h('pre', { class: 'ybe-fix' }, c.fix);
      const cp = h('button', { class: 'k-btn ybe-copy', onclick: (e) => { e.stopPropagation(); copyText(c.fix, cp); } }, 'Copy');
      const card = h('article', { class: `ybe-f sev-${c.sev === 'error' ? 'e' : 'w'}${open ? ' open' : ''}${c.unclassified ? ' unk' : ''}`, 'data-id': c.id, tabindex: '0', role: 'option', 'aria-selected': String(open),
        onclick: (e) => { if (e.target.closest('a,pre,.ybe-copy')) return; select(c.id, { log: true }); },
        onkeydown: (e) => {
          if (e.target !== card) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(c.id, { log: true, focusCard: true }); }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const nx = cs[(k + (e.key === 'ArrowDown' ? 1 : -1) + cs.length) % cs.length]; select(nx.id, { log: true, focusCard: true }); }
        } },
      h('div', { class: 'ybe-fh' }, h('span', { class: 'ybe-num' }, `#${c.id}`), h('b', { class: 'ybe-title' }, c.title)),
      h('div', { class: 'ybe-meta' }, h('span', { class: `ybe-sev ${c.sev}` }, c.sev), h('code', { class: 'ybe-check' }, c.check),
        c.recipe ? h('span', { class: 'ybe-rt' }, c.recipe, c.task ? h('i', {}, ` : ${c.task}`) : null) : null, ...lineBtns),
      h('p', { class: 'ybe-what' }, c.what),
      open ? h('p', { class: 'ybe-why' }, h('b', {}, 'Why '), c.why) : null,
      open ? h('div', { class: 'ybe-fixwrap' }, h('div', { class: 'ybe-fixbar' }, h('span', {}, 'Fix'), cp), pre) : null,
      open && c.url ? h('a', { class: 'ybe-doc', href: c.url, target: '_blank', rel: 'noopener' }, c.doc) : null);
      return card;
    }));
    if (!cs.length) list.append(h('div', { class: 'ybe-empty' }, res.view.total ? 'No finding. A clean log, or a failure no rule knows: look for the first "ERROR:" line.' : 'Paste a BitBake log (console output or temp/log.do_<task>) onto the log panel.'));
  }

  function drawAll() { drawStrip(); drawLog(); drawCards(); }

  ctx.onResult((r) => {
    if (!r || !r.view) return;
    const prevTotal = res ? res.view.total : -1;
    res = r;
    const raw = ctx.raw;
    syntaxSel.value = raw.syntax || 'auto';
    warnBox.checked = raw.warnings !== false;
    foldBox.checked = fold;
    if (!res.view.cards.some((c) => c.id === sel)) sel = (res.view.cards.find((c) => c.sev === 'error') || res.view.cards[0] || { id: 0 }).id;
    if (filter && !res.view.cards.some((c) => c.cat === filter)) filter = '';
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes'), ...(r.notes || []).map((n) => h('div', {}, n)));
    const top = scroller.scrollTop;
    drawAll();
    if (prevTotal !== res.view.total && !editing) select(sel, { log: true });
    else scroller.scrollTop = top;
  });
}
