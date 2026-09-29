// Prompt Diff & History, drawn as the thing itself: the version timeline
// (each version a node, its size in tokens above it, the change from the one
// before on the link) and the two chosen versions side by side, sentence
// against sentence, with the words that changed marked inside them and moved
// sentences linked. The rail says what kind of change each one is.
//   Click two versions on the timeline to compare them (double-click: against
//   the one before). "New version" copies B so you can edit it and say why.
//   In the app the versions are the project's record (GET/PUT
//   /api/tools/data/prompt-diff); outside it they live on this page only.
// Everything drawn comes from run()'s result.diff.

import { parseHistory } from './tool.js';

const TOOL = 'prompt-diff';
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
const KIND_CLASS = { 'instruction added': 'add', 'instruction removed': 'del', 'rule changed': 'rule', 'instruction reworded': 'chg', 'text reworded': 'chg',
  'example changed': 'ex', moved: 'mv', 'section added': 'add', 'section removed': 'del' };

export function page(root, ctx) {
  const state = { pick: null, mode: 'side', editing: false, showAll: false, tabChosen: false };
  const D = () => ctx.result?.diff || null;
  const versions = () => parseHistory(ctx.raw.history).versions;
  const setVersions = (vs, extra = {}) => ctx.setMany({ history: JSON.stringify(vs, null, 1), ...extra });

  // ---------- project record ----------
  const inApp = /^https?:/.test(location.protocol);
  const proj = { name: 'default', saved: null, msg: '', tone: '', busy: false, updated: null };
  try { proj.name = (new URLSearchParams(location.search).get('project') || 'default').trim() || 'default'; } catch { /* no query */ }
  const projBar = h('div', { class: 'pd-proj' });
  const url = () => `/api/tools/data/${TOOL}?project=${encodeURIComponent(proj.name)}`;
  const dirty = () => proj.saved !== JSON.stringify(versions());
  async function load() {
    proj.busy = true; proj.msg = 'Loading…'; drawProj();
    try {
      const r = await fetch(url());
      if (!r.ok) throw new Error(`the app answered ${r.status}`);
      const body = await r.json();
      proj.updated = body.updated || null;
      const hist = body.data?.history;
      if (Array.isArray(hist) && hist.length) {
        proj.saved = JSON.stringify(parseHistory(JSON.stringify(hist)).versions);
        setVersions(hist, { from: String(Math.max(1, hist.length - 1)), to: String(hist.length), left: '', right: '' });
        proj.msg = `Loaded ${hist.length} versions of project "${proj.name}".`; proj.tone = 'ok';
      } else { proj.saved = null; proj.msg = `No versions saved for "${proj.name}" yet: this is the example. Save to start the project's history.`; proj.tone = 'warn'; }
    } catch (e) {
      proj.msg = `No project record here (${e.message || e}): saving needs the app. Versions live on this page only; copy the JSON output to keep them.`; proj.tone = '';
    }
    proj.busy = false; drawProj();
  }
  async function save() {
    proj.busy = true; proj.msg = 'Saving…'; drawProj();
    const data = { history: versions() };
    try {
      const r = await fetch(url(), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' }, body: JSON.stringify({ data }) });
      if (!r.ok) { let why = String(r.status); try { why = (await r.json()).detail || why; } catch { /* not JSON */ } throw new Error(why); }
      const body = await r.json();
      proj.saved = JSON.stringify(data.history); proj.updated = body.updated || null;
      proj.msg = `Saved ${data.history.length} versions to "${proj.name}".`; proj.tone = 'ok';
    } catch (e) { proj.msg = `Not saved: ${e.message || e}.`; proj.tone = 'bad'; }
    proj.busy = false; drawProj();
  }
  function drawProj() {
    if (!inApp) {
      projBar.replaceChildren(h('b', {}, 'Versions'), h('span', { class: 'pd-msg' }, 'Opened as a file: versions live on this page only (the browser keeps your last inputs). Copy the JSON output to keep them; in the app they are saved per project.'));
      return;
    }
    const inp = h('input', { type: 'text', class: 'pd-in', 'aria-label': 'Project', spellcheck: 'false' });
    inp.value = proj.name;
    inp.addEventListener('change', () => { const p = inp.value.trim() || 'default'; if (p !== proj.name) { proj.name = p; load(); } });
    projBar.replaceChildren(h('label', { class: 'pd-f' }, 'Project', inp),
      h('button', { class: 'k-btn k-primary', type: 'button', disabled: proj.busy, onclick: save }, proj.busy ? 'Working…' : 'Save versions'),
      h('button', { class: 'k-btn', type: 'button', disabled: proj.busy, onclick: () => { if (!dirty() || proj.saved == null || confirm('Replace these versions with the saved ones?')) load(); } }, 'Reload'),
      h('span', { class: `pd-msg${dirty() && proj.saved != null ? ' warn' : ''}` }, proj.updated ? `Last saved ${new Date(proj.updated).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not saved yet', dirty() && proj.saved != null ? ' · unsaved changes' : ''),
      proj.msg ? h('span', { class: `pd-msg ${proj.tone}`, role: 'status' }, proj.msg) : null);
  }

  // ---------- timeline ----------
  const tl = h('div', { class: 'pd-tl', role: 'listbox', 'aria-label': 'Versions. Enter picks one; pick two to compare them.' });
  const tlHint = h('span', { class: 'pd-sub' });
  const newBtn = h('button', { class: 'k-btn k-primary', type: 'button', title: 'Copy version B as a new last version and edit it', onclick: () => newVersion() }, '+ New version from B');
  const editBtn = h('button', { class: 'k-btn', type: 'button', 'aria-pressed': 'false', onclick: () => toggleEdit() }, 'Edit B');
  const delBtn = h('button', { class: 'k-btn', type: 'button', onclick: () => deleteB() }, 'Delete B');
  const meta = h('div', { class: 'pd-meta' });
  const tlCard = h('section', { class: 'pd-card pd-tlcard' },
    h('div', { class: 'pd-head' }, h('h2', {}, 'Versions'), tlHint, h('span', { class: 'pd-grow' }), newBtn, editBtn, delBtn),
    h('div', { class: 'pd-tlscroll' }, tl), meta, projBar);

  // ---------- diff ----------
  const diffHead = h('div', { class: 'pd-head' });
  const editTa = h('textarea', { class: 'pd-edit', spellcheck: 'false', 'aria-label': 'Text of version B' });
  const editWrap = h('div', { class: 'pd-editwrap', hidden: true }, h('div', { class: 'pd-sub' }, 'Editing version B: the diff below follows as you type.'), editTa);
  const grid = h('div', { class: 'pd-grid' });
  const diffCard = h('section', { class: 'pd-card pd-diffcard' }, diffHead, editWrap, h('div', { class: 'pd-gridscroll' }, grid));
  const whatList = h('ul', { class: 'pd-what' });
  const whatCard = h('section', { class: 'pd-card' }, h('div', { class: 'pd-head' }, h('h2', {}, 'What changed')), whatList);
  const secBars = h('div', { class: 'pd-secs' });
  const secCard = h('section', { class: 'pd-card' }, h('div', { class: 'pd-head' }, h('h2', {}, 'Tokens per section'), h('span', { class: 'pd-sub' }, 'A above, B below; estimates')), secBars);
  const warnBox = h('div', { class: 'pd-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes pd-notes' });
  root.append(h('div', { class: 'pd' }, tlCard, h('div', { class: 'pd-main' }, h('div', { class: 'pd-col' }, warnBox, diffCard),
    h('aside', { class: 'pd-rail' }, whatCard, secCard, ctx.outputs, notes))));

  // ---------- actions ----------
  const idx = () => ({ a: D()?.ia || 1, b: D()?.ib || 1 });
  function compareTo(a, b) {
    state.pick = null;
    ctx.setMany({ from: String(Math.min(a, b)), to: String(Math.max(a, b)), left: '', right: '' });
  }
  function nodeClick(i) {
    if (D()?.direct) { compareTo(Math.max(1, i - 1), i); return; }
    if (state.pick == null) { state.pick = i; drawTimeline(D()); tlHint.textContent = `A = ${versions()[i - 1]?.label}. Now pick B (Esc cancels).`; return; }
    if (state.pick === i) { state.pick = null; drawTimeline(D()); return; }
    compareTo(state.pick, i);
  }
  function newVersion() {
    const vs = versions();
    const { b } = idx();
    const src = vs[b - 1] || { text: '' };
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const at = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    vs.push({ label: `v${vs.length + 1}`, at, note: '', text: src.text });
    state.editing = true;
    setVersions(vs, { from: String(Math.max(1, b)), to: String(vs.length), left: '', right: '' });
    requestAnimationFrame(() => meta.querySelector('input[name=label]')?.select());
  }
  function deleteB() {
    const vs = versions();
    const { b } = idx();
    if (vs.length <= 1) return;
    if (!confirm(`Delete version "${vs[b - 1].label}"?`)) return;
    vs.splice(b - 1, 1);
    setVersions(vs, { from: String(Math.max(1, Math.min(vs.length - 1, b - 1))), to: String(Math.min(vs.length, Math.max(2, b))) });
  }
  function toggleEdit() {
    state.editing = !state.editing;
    drawEdit();
    if (state.editing) editTa.focus();
  }
  function drawEdit() {
    const d = D();
    editBtn.setAttribute('aria-pressed', String(state.editing));
    editBtn.textContent = state.editing ? 'Done editing' : 'Edit B';
    editWrap.hidden = !state.editing || !d || d.direct;
    if (state.editing && d && !d.direct && document.activeElement !== editTa) editTa.value = versions()[d.ib - 1]?.text || '';
  }
  editTa.addEventListener('input', () => {
    const vs = versions(); const { b } = idx();
    if (!vs[b - 1]) return;
    vs[b - 1].text = editTa.value;
    setVersions(vs);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.pick != null) { state.pick = null; drawTimeline(D()); } });

  // ---------- draw ----------
  function drawTimeline(d) {
    const tlv = d?.timeline || [];
    const maxT = Math.max(1, ...tlv.map((t) => t.tokens));
    if (!d?.direct) tlHint.textContent = state.pick != null ? tlHint.textContent : 'click two versions to compare them · double-click: against the one before';
    else tlHint.textContent = 'Comparing the two pasted texts (left/right inputs), not versions.';
    tl.replaceChildren(...tlv.flatMap((t, k) => {
      const isA = !d.direct && t.i === d.ia, isB = !d.direct && t.i === d.ib;
      const inRange = !d.direct && t.i > Math.min(d.ia, d.ib) && t.i <= Math.max(d.ia, d.ib);
      const link = k ? h('div', { class: `pd-link${inRange ? ' in' : ''}`, 'aria-hidden': 'true' },
        h('span', { class: t.delta > 0 ? 'up' : t.delta < 0 ? 'down' : '' }, `${t.delta > 0 ? '+' : ''}${t.delta} tk`),
        h('small', {}, `+${t.add} −${t.del} words`)) : null;
      const node = h('button', { type: 'button', role: 'option', class: `pd-node${isA ? ' a' : ''}${isB ? ' b' : ''}${state.pick === t.i ? ' pick' : ''}`,
        'aria-selected': String(isA || isB), 'aria-label': `${t.label}, ${t.at}, ${t.tokens} tokens${isA ? ', side A' : ''}${isB ? ', side B' : ''}`, title: t.note || t.label,
        onclick: () => nodeClick(t.i), ondblclick: () => compareTo(Math.max(1, t.i - 1), t.i) },
      h('span', { class: 'pd-tk' }, h('i', { style: `height:${Math.max(3, (t.tokens / maxT) * 38)}px` }), h('b', {}, String(t.tokens))),
      h('span', { class: 'pd-dot' }, isA ? 'A' : isB ? 'B' : state.pick === t.i ? 'A?' : ''),
      h('span', { class: 'pd-lbl' }, t.label), h('span', { class: 'pd-date' }, t.at || '—'),
      h('span', { class: 'pd-kinds' }, (t.kinds || []).slice(0, 3).map((x) => h('i', { class: `k-${KIND_CLASS[x] || 'chg'}`, title: x }))));
      node.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); node.nextElementSibling?.nextElementSibling?.focus(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); node.previousElementSibling?.previousElementSibling?.focus(); }
      });
      return [link, node].filter(Boolean);
    }));
    const bNode = tl.querySelector('.pd-node.b');
    const sc = tl.parentElement;
    if (bNode && sc.scrollWidth > sc.clientWidth) {
      const x = bNode.offsetLeft - sc.offsetLeft;
      if (x < sc.scrollLeft || x + bNode.offsetWidth > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = Math.max(0, x + bNode.offsetWidth - sc.clientWidth + 10);
    }
    if (!tlv.length) tl.append(h('div', { class: 'pd-sub pd-empty' }, 'No versions yet. Paste two texts, or press New version.'));
    newBtn.disabled = !!d?.direct; delBtn.disabled = !!d?.direct || tlv.length <= 1; editBtn.disabled = !!d?.direct || !tlv.length;
  }
  function drawMeta(d) {
    if (d.direct) {
      meta.replaceChildren(h('span', { class: 'pd-sub' }, 'The left/right texts are set (an agent or the JSON input gave them).'),
        h('button', { class: 'k-btn', type: 'button', onclick: () => ctx.setMany({ left: '', right: '' }) }, 'Compare versions instead'));
      return;
    }
    const vs = versions(); const v = vs[d.ib - 1];
    if (!v) { meta.replaceChildren(); return; }
    const field = (name, label, value, wide) => {
      const inp = h('input', { type: 'text', class: `pd-in${wide ? ' wide' : ''}`, name, spellcheck: name === 'note' ? 'true' : 'false', 'aria-label': `${label} of version B` });
      inp.value = value;
      inp.addEventListener('change', () => { const all = versions(); all[d.ib - 1][name] = inp.value; setVersions(all); });
      return h('label', { class: `pd-f${wide ? ' grow' : ''}` }, label, inp);
    };
    if (meta.contains(document.activeElement)) return;               // do not rebuild under the caret
    meta.replaceChildren(h('span', { class: 'pd-bb' }, 'B'), field('label', 'Label', v.label), field('at', 'Date', v.at),
      field('note', 'Why this change', v.note, true));
  }
  function wordsHtml(words, side) {
    return words.filter((w) => w.op === 'eq' || w.op === (side === 'a' ? 'del' : 'ins'))
      .map((w) => (w.op === 'eq' ? document.createTextNode(w.t) : h('mark', { class: side === 'a' ? 'w-del' : 'w-ins' }, w.t)));
  }
  function cell(d, side, u, cls, content, tag) {
    if (!u) return h('div', { class: `pd-c pd-${side} none` });
    return h('div', { class: `pd-c pd-${side} ${cls}${u.gap ? ' gap' : ''}` },
      h('span', { class: 'pd-ln' }, u.first ? String(u.line) : ''),
      h('span', { class: 'pd-t' }, u.indent ? h('span', { class: 'pd-ind' }, u.indent) : null, content ?? u.t),
      tag ? h('span', { class: `pd-tag k-${KIND_CLASS[tag] || 'chg'}` }, tag) : null);
  }
  function drawGrid(d) {
    const rows = d.rows;
    const out = [];
    const eqRun = [];
    const flushEq = () => {
      if (!eqRun.length) return;
      if (state.showAll || eqRun.length <= 6) out.push(...eqRun.map((r) => r.el));
      else {
        out.push(...eqRun.slice(0, 2).map((r) => r.el));
        out.push(h('button', { type: 'button', class: 'pd-fold', onclick: () => { state.showAll = true; drawGrid(D()); } }, `… ${eqRun.length - 4} unchanged sentences (show all)`));
        out.push(...eqRun.slice(-2).map((r) => r.el));
      }
      eqRun.length = 0;
    };
    rows.forEach((r, ri) => {
      const ua = r.a != null ? d.a[r.a] : null, ub = r.b != null ? d.b[r.b] : null;
      let el;
      if (state.mode === 'inline') {
        let content, cls;
        if (r.op === 'eq') { content = ub.t; cls = 'eq'; }
        else if (r.op === 'del' || r.op === 'mvdel') { content = h('mark', { class: 'w-del' }, ua.t); cls = r.op === 'mvdel' ? 'mv' : 'del'; }
        else if (r.op === 'ins' || r.op === 'mvins') { content = h('mark', { class: 'w-ins' }, ub.t); cls = r.op === 'mvins' ? 'mv' : 'ins'; }
        else { content = r.words.map((w) => (w.op === 'eq' ? document.createTextNode(w.t) : h('mark', { class: w.op === 'del' ? 'w-del' : 'w-ins' }, w.t))); cls = 'chg'; }
        const u = ub || ua;
        const tag = r.op === 'mvdel' ? `moved to line ${d.b[r.to].line}` : r.op === 'mvins' ? `moved from line ${d.a[r.from].line}` : r.kind;
        el = h('div', { class: `pd-row inline`, 'data-row': ri }, cell(d, r.b != null ? 'b' : 'a', u, cls, content, tag));
      } else {
        const tagA = r.op === 'mvdel' ? `moved to line ${d.b[r.to].line}` : null;
        const tagB = r.op === 'mvins' ? `moved from line ${d.a[r.from].line}` : r.kind && r.kind !== 'moved' ? r.kind : null;
        const cls = { eq: 'eq', del: 'del', ins: 'ins', chg: 'chg', mvdel: 'mv', mvins: 'mv' }[r.op];
        el = h('div', { class: 'pd-row', 'data-row': ri },
          cell(d, 'a', ua, cls, r.op === 'chg' ? wordsHtml(r.words, 'a') : null, tagA),
          cell(d, 'b', ub, cls, r.op === 'chg' ? wordsHtml(r.words, 'b') : null, tagB));
      }
      if (r.op === 'eq') eqRun.push({ el }); else { flushEq(); out.push(el); }
    });
    flushEq();
    grid.classList.toggle('inline', state.mode === 'inline');
    grid.replaceChildren(state.mode === 'side' ? h('div', { class: 'pd-row pd-colhead' }, h('div', { class: 'pd-c' }, h('b', {}, 'A'), ` ${d.la}`), h('div', { class: 'pd-c' }, h('b', {}, 'B'), ` ${d.lb}`)) : '',
      ...out);
    if (!rows.length) grid.append(h('div', { class: 'pd-empty' }, 'Both versions are empty.'));
    else if (!rows.some((r) => r.op !== 'eq')) grid.prepend(h('div', { class: 'pd-same' }, 'No difference: A and B are the same text.'));
  }
  function drawHead(d) {
    const dt = d.tokensB - d.tokensA;
    const mk = (m) => h('button', { type: 'button', class: 'pd-seg', 'aria-pressed': String(state.mode === m), onclick: () => { state.mode = m; drawGrid(D()); drawHead(D()); } }, m === 'side' ? 'Side by side' : 'Inline');
    diffHead.replaceChildren(h('h2', {}, h('span', { class: 'pd-ab a' }, 'A'), ` ${d.la} `, h('span', { class: 'pd-arrow' }, '→'), ' ', h('span', { class: 'pd-ab b' }, 'B'), ` ${d.lb}`),
      h('span', { class: 'pd-stat' }, h('b', { class: dt > 0 ? 'up' : dt < 0 ? 'down' : '' }, `${dt > 0 ? '+' : ''}${dt} tokens`), ` (${d.tokensA} → ${d.tokensB}, est.)`),
      h('span', { class: 'pd-stat' }, h('b', { class: 'up' }, `+${d.wAdd}`), ' / ', h('b', { class: 'down' }, `−${d.wDel}`), ' words'),
      h('span', { class: 'pd-grow' }), h('span', { class: 'pd-segs' }, mk('side'), mk('inline')));
  }
  function drawWhat(d) {
    if (!d.items.length) { whatList.replaceChildren(h('li', { class: 'pd-empty' }, d.rows.some((r) => r.op !== 'eq') ? 'Only whitespace or context lines changed.' : 'Nothing changed.')); return; }
    whatList.replaceChildren(...d.items.map((it) => h('li', {}, h('button', { type: 'button', class: 'pd-wbtn', onclick: () => {
      const el = grid.querySelector(`[data-row="${it.row}"]`);
      if (!el) { state.showAll = true; drawGrid(D()); }
      const t = grid.querySelector(`[data-row="${it.row}"]`);
      if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }
    } }, h('span', { class: `pd-kind k-${KIND_CLASS[it.kind] || 'chg'}` }, it.kind), h('span', {}, it.detail)))));
  }
  function drawSecs(d) {
    const maxT = Math.max(1, ...d.per.flatMap((p) => [p.a, p.b]));
    secBars.replaceChildren(...d.per.map((p) => {
      const dt = p.b - p.a;
      return h('div', { class: 'pd-sec', title: `${p.label}: ${p.a} → ${p.b} tokens` },
        h('span', { class: 'pd-secname' }, p.label),
        h('span', { class: 'pd-secbars' }, h('i', { class: 'a', style: `width:${(p.a / maxT) * 100}%` }), h('i', { class: 'b', style: `width:${(p.b / maxT) * 100}%` })),
        h('span', { class: `pd-secd ${dt > 0 ? 'up' : dt < 0 ? 'down' : ''}` }, dt ? `${dt > 0 ? '+' : ''}${dt}` : '0'));
    }));
  }

  ctx.onResult((res) => {
    const d = res?.diff; if (!d) return;
    drawTimeline(d); drawMeta(d); drawHead(d); drawGrid(d); drawWhat(d); drawSecs(d); drawEdit();
    warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((t) => h('div', {}, t)));
    if (inApp && proj.saved !== undefined) drawProj();
    if (!state.tabChosen) {
      state.tabChosen = true;
      let saved = null;
      try { saved = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
      if (!saved) [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'Unified diff')?.click();
    }
  });
  drawProj();
  if (inApp) load();
}
