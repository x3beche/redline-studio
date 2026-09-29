// Structured Output Validator, drawn as the thing itself: the model's reply
// as it was pasted, with every repair made in place (struck = removed, green
// = inserted, tinted = rewritten) and every schema error underlined at its
// value with a numbered call-out under its line, like a compiler. Beside it
// the parsed value as a tree with the failing nodes red and the missing
// required members as ghost rows, and the error list with JSON Pointers.
//   Click a repair chip to switch that step off and see what the strict
//   parser says without it; click a mark, a tree row or an error to light the
//   same place everywhere; apply a suggested fix or pick an allowed enum value
//   right under the line; Edit (or paste onto the text) to change the reply;
//   the Schema tab shows the schema with the keyword each error comes from.
// Everything drawn comes from run()'s result.view.

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
const clip = (t, n = 48) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const vis = (t) => t.replace(/\n/g, '↵').replace(/\t/g, '⇥');

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

export function page(root, ctx) {
  const KEY = 'redline.tool.output-validator.ui';
  const ui = { tab: 'output', collapsed: {}, ...(store.get(KEY) || {}) };
  ui.collapsed = ui.collapsed || {};
  const saveUi = () => store.set(KEY, { tab: ui.tab });

  const wrap = h('div', { class: 'ov' });
  root.append(wrap);

  // ---------- repair strip ----------
  const chips = h('div', { class: 'ov-chips', role: 'group', 'aria-label': 'Repair steps' });
  const verdict = h('div', { class: 'ov-verdict', role: 'status', 'aria-live': 'polite' });
  const strip = h('section', { class: 'ov-card ov-strip' },
    h('div', { class: 'ov-striphead' }, h('h2', {}, 'Repairs'), h('span', { class: 'ov-sub' }, 'each step can be switched off: the strict parser then shows what it breaks'), verdict),
    chips);

  // ---------- the text ----------
  const tabOut = h('button', { class: 'ov-tab', role: 'tab', onclick: () => { ui.tab = 'output'; saveUi(); editing = false; draw(); } }, 'Model output');
  const tabSch = h('button', { class: 'ov-tab', role: 'tab', onclick: () => { ui.tab = 'schema'; saveUi(); editing = false; draw(); } }, 'Schema');
  const editBtn = h('button', { class: 'k-btn', onclick: () => { editing = !editing; draw(); if (editing) ta.focus(); } }, 'Edit');
  const useBtn = h('button', { class: 'k-btn', title: 'Replace the reply with the repaired, pretty-printed JSON', onclick: () => {
    const v = res?.view; if (v?.pretty) { sel = null; ctx.set('output', v.pretty); }
  } }, 'Use repaired');
  const where = h('span', { class: 'ov-sub ov-where' });
  const code = h('div', { class: 'ov-code', tabindex: '0', role: 'region', 'aria-label': 'Model output with repairs and errors marked. Paste here to replace it.' });
  const ta = h('textarea', { class: 'ov-ta', spellcheck: 'false', 'aria-label': 'Text' });
  const status = h('div', { class: 'ov-status', 'aria-live': 'polite' });
  const legend = h('div', { class: 'ov-legend' },
    h('span', {}, h('s', { class: 'ov-del' }, 'removed')), h('span', {}, h('ins', { class: 'ov-ins' }, 'inserted')),
    h('span', {}, h('span', { class: 'ov-rep' }, 'rewritten')), h('span', {}, h('span', { class: 'ov-err' }, 'schema error')),
    h('span', { class: 'ov-keys' }, 'Paste onto the text to replace it · ', h('kbd', {}, 'Tab'), ' to marks, ', h('kbd', {}, 'Enter'), ' selects'));
  const textCard = h('section', { class: 'ov-card ov-textcard' },
    h('div', { class: 'ov-head' }, h('div', { class: 'ov-tabs', role: 'tablist' }, tabOut, tabSch), where, h('span', { class: 'ov-right' }, useBtn, editBtn)),
    code, ta, status, legend);

  // ---------- tree and errors ----------
  const treeSub = h('span', { class: 'ov-sub' });
  const tree = h('div', { class: 'ov-tree', role: 'tree', 'aria-label': 'Parsed value' });
  const treeCard = h('section', { class: 'ov-card' }, h('div', { class: 'ov-head' }, h('h2', {}, 'Parsed value'), treeSub), tree);
  const errSub = h('span', { class: 'ov-sub' });
  const errs = h('div', { class: 'ov-errs' });
  const errCard = h('section', { class: 'ov-card' }, h('div', { class: 'ov-head' }, h('h2', {}, 'Schema errors'), errSub), errs);
  const warns = h('div', { class: 'ov-warns', role: 'status' });
  const notes = h('details', { class: 'ov-notes' }, h('summary', {}, 'Notes'));

  wrap.append(strip,
    h('div', { class: 'ov-col ov-main' }, warns, textCard),
    h('div', { class: 'ov-col ov-side' }, treeCard, errCard, ctx.outputs, notes));

  let res = null, sel = null, editing = false, typing = null;

  ta.addEventListener('input', () => {
    clearTimeout(typing);
    const key = ui.tab === 'schema' ? 'schema' : 'output';
    typing = setTimeout(() => ctx.set(key, ta.value), 250);
  });
  code.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text');
    if (t == null) return;
    e.preventDefault();
    sel = null;
    ctx.set(ui.tab === 'schema' ? 'schema' : 'output', t);
  });

  const select = (s) => { sel = s; draw(); focusSel(); };
  const focusSel = () => {
    const el = code.querySelector('.on');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const row = tree.querySelector('.ov-row.on');
    if (row) row.scrollIntoView({ block: 'nearest' });
  };
  const replaceSpan = (s, e, text) => {
    const src = ctx.raw.output ?? '';
    sel = null;
    ctx.set('output', src.slice(0, s) + text + src.slice(e));
  };

  // ---------- drawing ----------
  function drawChips(v) {
    chips.replaceChildren(...v.steps.map((st) => h('button', {
      class: `ov-chip${st.on ? '' : ' off'}${st.n ? ' hit' : ''}`, 'aria-pressed': String(st.on),
      title: st.on ? `${st.label}: on (${st.n} change${st.n === 1 ? '' : 's'}). Click to switch off.` : `${st.label}: off. Click to switch on.`,
      onclick: () => ctx.set(st.key, !st.on),
    }, h('i', { class: 'ov-box', 'aria-hidden': 'true' }), st.label, h('b', {}, st.on ? String(st.n) : 'off'))));
    verdict.className = `ov-verdict ${v.tone}`;
    verdict.textContent = v.verdict;
  }

  /** The text as pieces with the marks laid on it, split into numbered lines. */
  function drawCode(text, marks, errList, isSchema) {
    const bounds = new Set([0, text.length]);
    for (const m of marks) { bounds.add(m.s); bounds.add(m.e); }
    for (const e of errList) if (e.s < e.e) { bounds.add(e.s); bounds.add(e.e); }
    const pts = [...bounds].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);
    const lines = [[]];
    const lineOf = [];      // which line each callout goes under
    const push = (el) => lines[lines.length - 1].push(el);
    const addText = (t, cls, attrs) => {
      const parts = t.split('\n');
      parts.forEach((p, k) => {
        if (k) lines.push([]);
        if (p) push(cls ? h('span', { class: cls, ...attrs }, p) : document.createTextNode(p));
        else if (k < parts.length - 1 && cls && cls.includes('ov-del')) push(h('span', { class: cls, ...attrs }, '↵'));
      });
    };
    const selErr = sel?.type === 'err' ? sel.id : null;
    const selPtr = sel?.type === 'ptr' ? sel.ptr : sel?.type === 'err' ? (errList.find((e) => e.id === sel.id) || {}).ptr : null;
    const selRep = sel?.type === 'rep' ? sel.id : null;
    const callouts = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      // insertions at p
      for (const m of marks) if (m.kind === 'repair' && m.s === p && m.e === p) {
        push(h('ins', { class: `ov-ins ov-mark${selRep === m.id ? ' on' : ''}`, tabindex: '0', 'data-rep': m.id, title: `${m.why} (line ${m.at})` }, vis(m.after)));
      }
      for (const m of marks) if (m.kind === 'parse' && m.s === p && m.s >= text.length) {
        push(h('span', { class: 'ov-perr on', title: m.msg }, '⌁'));
      }
      if (k === pts.length - 1) break;
      const q = pts[k + 1];
      const seg = text.slice(p, q);
      const reps = marks.filter((m) => m.kind === 'repair' && m.s <= p && m.e >= q && m.e > m.s);
      const parse = marks.find((m) => m.kind === 'parse' && m.s <= p && m.e >= q);
      const es = errList.filter((e) => e.s <= p && e.e >= q && e.e > e.s);
      const cls = [];
      const attrs = {};
      if (reps.length) {
        const r = reps[0];
        cls.push(r.after === '' ? 'ov-del' : 'ov-rep', 'ov-mark');
        if (r.after === '' && r.e - r.s <= 3) cls.push('tiny');
        if (selRep === r.id) cls.push('on');
        attrs['data-rep'] = r.id; attrs.tabindex = '0';
        attrs.title = r.after === '' ? `${r.why}: removed (line ${r.at})` : `${r.why}: ${clip(r.before, 30)} → ${clip(r.after, 30)} (line ${r.at})`;
      }
      if (es.length) {
        cls.push('ov-err');
        if (es.some((e) => e.id === selErr || (!selErr && e.ptr === selPtr))) cls.push('on');
        attrs['data-err'] = String(es[0].id);
        if (!attrs.title) attrs.title = es.map((e) => `#${e.id} ${e.ptr}: ${e.msg}`).join('\n');
      }
      if (!es.length && !isSchema && selPtr != null && res?.view.tree) {
        const node = res.view.tree.find((n) => n.ptr === selPtr);
        if (node && ((node.s <= p && node.e >= q) || (node.ks >= 0 && node.ks <= p && node.ke >= q))) cls.push('ov-hl', 'on');
      }
      if (parse) cls.push('ov-perr', 'on');
      addText(seg, cls.join(' '), attrs);
      // a replacement shows its new text right after the old, small
      for (const r of reps) if (r.e === q && r.after && r.after.length <= 10 && r.before.length <= 12 && r.after.replace(/"/g, '') !== r.before.replace(/'/g, '')) {
        push(h('sup', { class: 'ov-new' }, vis(r.after)));
      }
      // error badges where their span ends
      for (const e of errList) {
        const end = e.e;
        if (end === q && e.e > e.s) {
          push(h('button', { class: `ov-badge${e.id === selErr ? ' on' : ''}`, 'data-err': String(e.id), title: `${e.ptr}: ${e.msg}`,
            onclick: (ev) => { ev.stopPropagation(); select({ type: 'err', id: e.id }); } }, String(e.id)));
          if (!callouts.some((c) => c.e === e)) callouts.push({ e, line: lines.length - 1 });
        }
      }
      if (parse && parse.s === p) callouts.push({ parse, line: lines.length - 1 });
    }
    for (const m of marks) if (m.kind === 'parse' && m.s >= text.length && !callouts.some((c) => c.parse)) callouts.push({ parse: m, line: lines.length - 1 });
    // errors without a place in the text (a missing member of the root) go under line 1
    for (const e of errList) if (!e.e > e.s && !callouts.some((c) => c.e === e)) callouts.push({ e, line: 0 });

    const frag = document.createDocumentFragment();
    const width = String(lines.length).length;
    lines.forEach((kids, n) => {
      frag.append(h('div', { class: 'ov-ln' }, h('span', { class: 'ov-no', 'aria-hidden': 'true' }, String(n + 1).padStart(width, ' ')), h('span', { class: 'ov-tx' }, kids.length ? kids : '​')));
      for (const c of callouts.filter((x) => x.line === n)) frag.append(calloutFor(c, isSchema));
    });
    code.replaceChildren(frag);
  }

  function calloutFor(c, isSchema) {
    if (c.parse) {
      return h('div', { class: 'ov-call bad' }, h('b', {}, 'Parse error'), ` ${c.parse.msg} (line ${c.parse.at})`,
        res?.view.steps.some((s) => !s.on) ? h('span', { class: 'ov-sub' }, ' · a repair step is off') : null);
    }
    const e = c.e;
    const on = sel?.type === 'err' && sel.id === e.id;
    const kids = [h('button', { class: `ov-badge${on ? ' on' : ''}`, onclick: () => select({ type: 'err', id: e.id }) }, String(e.id)),
      h('code', {}, e.ptr), ' ', e.msg, e.via ? h('span', { class: 'ov-sub' }, ` (${e.via})`) : null];
    if (!isSchema && e.fix) kids.push(' ', h('button', { class: 'k-btn ov-fix', title: 'Apply this fix to the reply', onclick: () => replaceSpan(e.s, e.e, e.fix.text) }, `Fix: ${e.fix.label}`));
    if (!isSchema && e.choices && e.choices.length > 1 && e.e > e.s) {
      const pick = h('select', { class: 'ov-pick', 'aria-label': `Set ${e.ptr} to an allowed value`, onchange: (ev) => {
        if (ev.target.value === '') return;
        replaceSpan(e.s, e.e, JSON.stringify(e.choices[Number(ev.target.value)]));
      } }, h('option', { value: '' }, 'set to…'), e.choices.map((ch, k) => h('option', { value: String(k) }, JSON.stringify(ch))));
      kids.push(' ', pick);
    }
    return h('div', { class: `ov-call${on ? ' on' : ''}` }, kids);
  }

  function drawTree(v) {
    const t = v.tree;
    if (!t.length) { tree.replaceChildren(h('div', { class: 'ov-empty' }, 'Nothing parsed yet: see the parse error at its line.')); treeSub.textContent = ''; return; }
    const errBy = new Map();
    for (const e of v.errors) { if (!errBy.has(e.ptr)) errBy.set(e.ptr, []); errBy.get(e.ptr).push(e); }
    const below = (ptr) => v.errors.filter((e) => e.ptr !== ptr && (ptr === '/' ? true : e.ptr.startsWith(ptr + '/'))).length;
    const selPtr = sel?.type === 'ptr' ? sel.ptr : sel?.type === 'err' ? (v.errors.find((e) => e.id === sel.id) || {}).ptr : null;
    const rows = [];
    let hideDepth = Infinity;
    for (const n of t) {
      if (n.depth > hideDepth) continue;
      hideDepth = Infinity;
      const own = errBy.get(n.ptr) || [];
      const deep = n.type === 'object' || n.type === 'array' ? below(n.ptr) : 0;
      const shut = !!ui.collapsed[n.ptr];
      if (shut) hideDepth = n.depth;
      const bad = own.some((e) => e.kw !== 'required' && e.kw !== 'oneOf' && e.kw !== 'anyOf') || own.some((e) => e.kw === 'required');
      const row = h('div', {
        class: `ov-row${bad ? ' bad' : ''}${n.ptr === selPtr ? ' on' : ''}`, role: 'treeitem', tabindex: '-1', 'data-ptr': n.ptr,
        'aria-level': String(n.depth + 1), 'aria-expanded': n.type === 'object' || n.type === 'array' ? String(!shut) : null,
        style: `--d:${n.depth}`, onclick: () => select({ type: 'ptr', ptr: n.ptr }),
      },
      n.type === 'object' || n.type === 'array'
        ? h('span', { class: 'ov-tog', onclick: (ev) => { ev.stopPropagation(); ui.collapsed[n.ptr] = !shut; draw(); } }, shut ? '▸' : '▾')
        : h('span', { class: 'ov-tog' }),
      h('span', { class: 'ov-key' }, n.key == null ? 'root' : typeof n.key === 'number' ? `[${n.key}]` : n.key),
      h('span', { class: `ov-pv t-${n.type}` }, n.pv),
      h('span', { class: 'ov-type' }, n.type),
      own.length ? h('span', { class: 'ov-cnt bad', title: own.map((e) => `#${e.id} ${e.msg}`).join('\n') }, own.map((e) => `#${e.id}`).join(' ')) : null,
      deep && shut ? h('span', { class: 'ov-cnt', title: 'errors inside' }, `${deep} inside`) : null);
      rows.push(row);
      // missing required members as ghost rows
      if (!shut) for (const e of own.filter((x) => x.kw === 'required' || x.kw === 'dependentRequired')) {
        rows.push(h('div', { class: `ov-row ghost${sel?.type === 'err' && sel.id === e.id ? ' on' : ''}`, role: 'treeitem', tabindex: '-1', style: `--d:${n.depth + 1}`,
          onclick: () => select({ type: 'err', id: e.id }) },
        h('span', { class: 'ov-tog' }), h('span', { class: 'ov-key' }, e.missing), h('span', { class: 'ov-pv' }, 'missing'), h('span', { class: 'ov-type' }, 'required'),
        h('span', { class: 'ov-cnt bad' }, `#${e.id}`)));
      }
    }
    const cur = rows.find((r) => r.classList.contains('on')) || rows[0];
    if (cur) cur.tabIndex = 0;
    tree.replaceChildren(...rows);
    treeSub.textContent = `${t.length} values${v.errors.length ? ` · ${new Set(v.errors.map((e) => e.ptr)).size} failing` : ''}`;
  }

  tree.addEventListener('keydown', (e) => {
    const rows = [...tree.querySelectorAll('.ov-row')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    const go = (k) => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]; rows.forEach((x) => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); };
    const ptr = rows[i].dataset.ptr;
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && ptr) {
      e.preventDefault();
      ui.collapsed[ptr] = e.key === 'ArrowLeft';
      draw();
      tree.querySelector(`.ov-row[data-ptr="${CSS.escape(ptr)}"]`)?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); rows[i].click();
      const again = ptr ? tree.querySelector(`.ov-row[data-ptr="${CSS.escape(ptr)}"]`) : [...tree.querySelectorAll('.ov-row')][i];
      again?.focus();
    }
  });

  code.addEventListener('click', (e) => {
    const r = e.target.closest('[data-rep]');
    const er = e.target.closest('[data-err]');
    if (er) select({ type: 'err', id: Number(er.dataset.err) });
    else if (r) select({ type: 'rep', id: r.dataset.rep });
  });
  code.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const r = e.target.closest('[data-rep],[data-err]');
    if (!r || r.tagName === 'BUTTON') return;
    e.preventDefault();
    const id = r.dataset.err ? { type: 'err', id: Number(r.dataset.err) } : { type: 'rep', id: r.dataset.rep };
    select(id);
    const again = code.querySelector(r.dataset.err ? `[data-err="${r.dataset.err}"]` : `[data-rep="${r.dataset.rep}"]`);
    again?.focus();
  });

  function drawErrs(v) {
    if (!v.schemaOk) { errs.replaceChildren(h('div', { class: 'ov-empty' }, ctx.raw.schema?.trim() ? 'The schema could not be read: see the warning.' : 'No schema: paste one in the Schema tab to check against it.')); errSub.textContent = ''; return; }
    if (!v.tree.length) { errs.replaceChildren(h('div', { class: 'ov-empty' }, 'The reply did not parse, so it was not checked.')); errSub.textContent = ''; return; }
    if (!v.errors.length) { errs.replaceChildren(h('div', { class: 'ov-empty ok' }, 'The value matches the schema.')); errSub.textContent = ''; return; }
    errSub.textContent = `${v.errors.length} · click one to find it`;
    errs.replaceChildren(...v.errors.map((e) => h('button', {
      class: `ov-erow${sel?.type === 'err' && sel.id === e.id ? ' on' : ''}${sel?.type === 'ptr' && sel.ptr === e.ptr ? ' on' : ''}`,
      onclick: () => { if (ui.tab !== 'output' && ui.tab !== 'schema') ui.tab = 'output'; select({ type: 'err', id: e.id }); },
    }, h('span', { class: 'ov-badge' }, String(e.id)), h('code', {}, e.ptr), h('span', { class: 'ov-kw' }, e.kw), h('span', { class: 'ov-msg' }, e.msg),
    h('span', { class: 'ov-at' }, e.at ? `line ${e.at}` : ''))));
  }

  function drawStatus(v) {
    let t = null;
    if (sel?.type === 'rep') {
      const m = v.marks.find((x) => x.id === sel.id);
      const st = m && v.steps.find((s) => s.key === m.step);
      if (m) t = [h('b', {}, st.label), ` · line ${m.at} · `, m.before ? h('code', { class: 'ov-was' }, clip(vis(m.before), 60)) : 'nothing', ' → ', m.after ? h('code', {}, clip(vis(m.after), 60)) : 'removed',
        ' ', h('button', { class: 'k-btn', onclick: () => ctx.set(st.key, false) }, `Switch "${st.short}" off`)];
    } else if (sel?.type === 'err') {
      const e = v.errors.find((x) => x.id === sel.id);
      if (e) t = [h('b', {}, `#${e.id}`), ' ', h('code', {}, e.ptr), ` · ${e.kw} · schema `, h('code', {}, e.sp), e.via ? ` via ${e.via}` : ''];
    } else if (sel?.type === 'ptr') {
      const n = v.tree.find((x) => x.ptr === sel.ptr);
      if (n) t = [h('code', {}, n.ptr), ` · ${n.type} · ${n.pv}`];
    }
    status.replaceChildren(...(t || [h('span', { class: 'ov-sub' }, 'Click a mark, a tree row or an error to find the same place everywhere.')]));
  }

  function draw() {
    if (!res?.view) return;
    const v = res.view;
    drawChips(v);
    tabOut.setAttribute('aria-selected', String(ui.tab === 'output'));
    tabSch.setAttribute('aria-selected', String(ui.tab === 'schema'));
    editBtn.textContent = editing ? 'Done' : 'Edit';
    editBtn.setAttribute('aria-pressed', String(editing));
    useBtn.hidden = ui.tab !== 'output' || !v.pretty;
    code.hidden = editing; ta.hidden = !editing;
    legend.hidden = editing;
    if (editing) {
      const want = (ui.tab === 'schema' ? ctx.raw.schema : ctx.raw.output) ?? '';
      if (document.activeElement !== ta && ta.value !== want) ta.value = want;
    } else if (ui.tab === 'schema') {
      const st = ctx.raw.schema ?? '';
      const list = v.errors.filter((e) => e.ss >= 0).map((e) => ({ ...e, s: e.ss, e: e.se }));
      drawCode(st, [], list, true);
    } else {
      drawCode(v.src, v.marks, v.errors, false);
    }
    const r = v.region;
    where.textContent = ui.tab === 'output' && r.how !== 'none' ? `JSON ${r.how === 'fence' ? `in a \`\`\`${r.lang} fence` : 'found'} at ${r.start}–${r.end}` : '';
    drawTree(v);
    drawErrs(v);
    drawStatus(v);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes'), ...(res.notes || []).map((n) => h('div', {}, n)));
  }

  let firstTab = true;
  ctx.onResult((r) => {
    res = r;
    if (firstTab) {
      firstTab = false;
      let picked = null;
      try { picked = localStorage.getItem('redline.tool.output-validator.input.tab'); } catch { /* private window */ }
      if (!picked) setTimeout(() => [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'Retry prompt')?.click(), 0);
    }
    if (sel?.type === 'err' && !r.view?.errors.some((e) => e.id === sel.id)) sel = null;
    if (sel?.type === 'rep' && !r.view?.marks.some((m) => m.id === sel.id)) sel = null;
    draw();
  });
}
