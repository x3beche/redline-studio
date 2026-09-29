// CLAUDE.md / AGENTS.md Linter, drawn as the thing itself: the instruction
// file as a list of its rules, one row each, grouped under its headings. Each
// row carries its topic, its token cost and its findings, with the offending
// words marked in place (vague words, commands outside backticks, stale paths,
// secrets, shouting). Above it, the file's length as a strip of its sections
// against the line target; beside it, the topic map and the findings.
//   Click a row (or focus it and press Enter) to open it: fix it with one
//   click, edit its text, ignore a finding or delete the rule. Up/Down move
//   between rows, F applies the first fix, Delete removes the rule.
//   Click a topic to light its rules; click a finding to jump to its row.
// Everything drawn comes from run()'s result.lint; edits change the input
// text and the tool runs again.

import { applyFix, TOPICS } from './tool.js';

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
const TOPIC_LABEL = Object.fromEntries([...TOPICS.map((t) => [t.id, t.label]), ['other', 'Other']]);
const TOPIC_SHORT = { build: 'build', test: 'test', style: 'style', git: 'git', structure: 'layout', security: 'security', deps: 'deps', workflow: 'flow', comms: 'comms', other: 'other' };
const FIX_LABEL = { secret: 'Redact', 'unformatted-command': 'Add backticks', shouting: 'Calm capitals', duplicate: 'Delete this copy', 'self-evident': 'Delete rule', 'empty-section': 'Delete heading' };
const cap = (r) => { const t = r.replace(/-/g, ' '); return t[0].toUpperCase() + t.slice(1); };
const SEV_RANK = { bad: 3, warn: 2, info: 1 };
const KEYS = ['file', 'second'];
const NAMES = ['nameA', 'nameB'];

export function page(root, ctx) {
  const st = { fi: 0, sel: -1, topic: null, sev: null, mode: 'rules', editing: false, undo: [], focusAfter: null };
  const lint = () => ctx.result?.lint || null;

  // ---------- skeleton ----------
  const fileTabs = h('div', { class: 'am-files', role: 'tablist', 'aria-label': 'Files' });
  const modeBtn = h('button', { class: 'k-btn', type: 'button', onclick: () => { st.mode = st.mode === 'rules' ? 'source' : 'rules'; st.editing = false; draw(); } });
  const pasteBtn = h('button', { class: 'k-btn', type: 'button', title: 'Replace this file with the clipboard', onclick: async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) { say('The clipboard is empty.'); return; }
      setText(st.fi, t, 'Pasted from the clipboard.');
    } catch { st.mode = 'source'; draw(); say('The browser did not give the clipboard: paste into the text with Ctrl+V.'); }
  } }, 'Paste');
  const undoBtn = h('button', { class: 'k-btn', type: 'button', disabled: true, onclick: () => undo() }, 'Undo');
  const useBtn = h('button', { class: 'k-btn k-primary', type: 'button', title: 'Replace the file with the tightened copy (fixes applied, duplicates and filler removed, same-name sections merged)', onclick: () => {
    const L = lint(); if (!L) return;
    const t = ctx.result.texts?.find((x) => x.title === `Tightened ${L.files[st.fi].name}`)?.body;
    if (t != null) setText(st.fi, t.replace(/\n$/, '') + '\n', 'Replaced with the tightened copy. Conflicts are marked with <!-- conflict --> comments for you to settle.');
  } }, 'Use tightened');
  const msg = h('span', { class: 'am-msg', role: 'status' });
  const meter = h('div', { class: 'am-meter' });
  const body = h('div', { class: 'am-body' });
  const main = h('section', { class: 'am-card am-main' },
    h('div', { class: 'am-head' }, fileTabs, h('span', { class: 'am-grow' }), msg, modeBtn, pasteBtn, undoBtn, useBtn),
    meter, body);

  const topicGrid = h('div', { class: 'am-topics' });
  const topicSub = h('span', { class: 'am-sub' });
  const topicCard = h('section', { class: 'am-card' },
    h('div', { class: 'am-head' }, h('h2', {}, 'Topics'), topicSub), topicGrid);
  const findSub = h('span', { class: 'am-sub' });
  const sevBar = h('div', { class: 'am-sevbar', role: 'group', 'aria-label': 'Show findings of one severity' });
  const findList = h('ul', { class: 'am-finds' });
  const ignored = h('div', { class: 'am-ignored' });
  const findCard = h('section', { class: 'am-card' },
    h('div', { class: 'am-head' }, h('h2', {}, 'Findings'), findSub, h('span', { class: 'am-grow' }), sevBar), findList, ignored);
  const pathsTa = h('textarea', { class: 'am-ta am-paths', spellcheck: 'false', rows: 6, 'aria-label': 'File list, one path per line',
    placeholder: 'git ls-files output: one path per line', oninput: () => ctx.set('paths', pathsTa.value) });
  const pathsSub = h('span', { class: 'am-sub' });
  const pathsCard = h('details', { class: 'am-card am-det' },
    h('summary', { class: 'am-head' }, h('h2', {}, 'File list for path checks'), pathsSub), pathsTa,
    h('div', { class: 'am-hint' }, 'Paste the output of ', h('code', {}, 'git ls-files'), '. Paths the rules mention are looked up here; a nested file\'s paths are also tried relative to its folder.'));
  const notes = h('details', { class: 'am-notes' }, h('summary', {}, 'Notes and sources'));
  const rail = h('aside', { class: 'am-rail' }, topicCard, findCard, pathsCard, ctx.outputs, notes);
  root.append(h('div', { class: 'am' }, main, rail));

  // ---------- edits ----------
  function say(t) { msg.textContent = t; if (t) setTimeout(() => { if (msg.textContent === t) msg.textContent = ''; }, 7000); }
  function setText(fi, text, note) {
    const key = KEYS[fi];
    const cur = ctx.raw[key] ?? '';
    if (text === cur) return;
    st.undo.push({ key, value: cur }); if (st.undo.length > 60) st.undo.shift();
    undoBtn.disabled = false;
    ctx.set(key, text);
    if (note) say(note);
  }
  function undo() {
    const u = st.undo.pop(); if (!u) return;
    ctx.set(u.key, u.value); undoBtn.disabled = !st.undo.length; say('Undone.');
  }
  function fixRow(f) {
    if (!f?.fix) return;
    const t = ctx.raw[KEYS[f.fix.file]] ?? '';
    const L = lint(); const row = L?.files[f.file].rows[f.row];
    st.focusAfter = f.fix.text === null ? Math.max(0, f.row - 1) : f.row;
    setText(f.fix.file, applyFix(t, f.fix), `${FIX_LABEL[f.rule] || 'Fixed'}: line ${f.line}${row ? ` (${(row.body || row.title || '').slice(0, 40)})` : ''}.`);
    if (f.fix.text === null) st.sel = -1;
  }
  function ignoreFinding(f) {
    const cur = String(ctx.raw.ignore || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (!cur.includes(f.key)) cur.push(f.key);
    ctx.set('ignore', cur.join('\n'));
    say(`Ignored ${f.rule} on line ${f.line}. Clear ignores under Findings.`);
  }
  function deleteRow(ri) {
    const L = lint(); const row = L.files[st.fi].rows[ri]; if (!row) return;
    st.focusAfter = Math.max(0, ri - 1); st.sel = -1;
    setText(st.fi, applyFix(ctx.raw[KEYS[st.fi]] ?? '', { line: row.line, end: row.end, text: null }), `Deleted line ${row.line + 1}.`);
  }
  function editRow(ri, text) {
    const L = lint(); const row = L.files[st.fi].rows[ri]; if (!row) return;
    const lines = String(ctx.raw[KEYS[st.fi]] ?? '').replace(/\r\n?/g, '\n').split('\n');
    const next = row.kind === 'heading' ? `${'#'.repeat(row.level)} ${text.trim()}` : `${row.prefix || ''}${text.trim()}`;
    lines.splice(row.line, row.end - row.line + 1, next);
    st.editing = false; st.focusAfter = ri;
    setText(st.fi, lines.join('\n'), `Line ${row.line + 1} changed.`);
  }
  function goTo(file, line) {
    const L = lint(); if (!L || !L.files[file]) return;
    st.fi = file; st.mode = 'rules';
    const ri = L.files[file].rows.findIndex((r) => r.line <= line - 1 && r.end >= line - 1);
    st.sel = ri; st.editing = false; st.focusAfter = ri;
    draw();
  }

  // ---------- drawing helpers ----------
  function marked(text, spans) {
    // Cut the text at every span edge and every `code` edge; each piece takes
    // the classes of the spans over it, code pieces are drawn as code and the
    // backticks themselves are left out.
    const code = [];
    for (const m of text.matchAll(/`+[^`]*`+/g)) {
      const n = /^`+/.exec(m[0])[0].length;
      code.push([m.index, m.index + n, m.index + m[0].length - n, m.index + m[0].length]);
    }
    const cuts = new Set([0, text.length]);
    for (const s of spans) { cuts.add(Math.max(0, Math.min(text.length, s.s))); cuts.add(Math.max(0, Math.min(text.length, s.e))); }
    for (const c of code) c.forEach((x) => cuts.add(x));
    const pts = [...cuts].sort((a, b) => a - b);
    const TIP = { 'm-cmd': 'command outside backticks', 'm-vague': 'vague', 'm-caps': 'shouting', 'm-secret': 'secret', 'm-path-ok': 'path found in the file list', 'm-path-stale': 'path not in the file list', 'm-path-unchecked': 'path (not checked: no file list)', 'm-path-abs': 'absolute path', 'm-bloat': 'self-evident' };
    const out = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1]; if (b <= a) continue;
      if (code.some((c) => (a >= c[0] && b <= c[1]) || (a >= c[2] && b <= c[3]))) continue;   // a backtick run
      const inCode = code.some((c) => a >= c[1] && b <= c[2]);
      const on = spans.filter((s) => s.s <= a && s.e >= b).map((s) => `m-${s.kind}`);
      let piece = text.slice(a, b);
      let node = inCode ? h('code', {}, piece) : document.createTextNode(piece);
      if (on.length) node = h('mark', { class: on.join(' '), title: on.map((c) => TIP[c] || '').filter(Boolean).join(', ') }, node);
      out.push(node);
    }
    return out;
  }
  const worst = (ids, F) => ids.map((i) => F[i]).reduce((b, f) => (SEV_RANK[f.sev] > (SEV_RANK[b] || 0) ? f.sev : b), '');

  // ---------- draw ----------
  function drawTabs(L) {
    const tabs = L.files.map((F, fi) => {
      const n = L.findings.filter((f) => f.file === fi);
      const sev = n.length ? worst(n.map((f) => f.id), L.findings) : '';
      return h('button', { class: `am-ftab${sev ? ' s-' + sev : ''}`, role: 'tab', type: 'button', 'aria-selected': String(fi === st.fi),
        onclick: () => { st.fi = fi; st.sel = -1; st.editing = false; draw(); } },
      h('b', {}, F.name), h('span', {}, `${F.lines} lines · ${n.length} finding${n.length === 1 ? '' : 's'}`));
    });
    if (L.files.length < 2) {
      tabs.push(h('button', { class: 'am-ftab am-add', type: 'button', title: 'Add a nested file (web/CLAUDE.md, a subfolder AGENTS.md) to check against the first',
        onclick: () => { st.fi = 1; st.mode = 'source'; draw(); } }, '+ second file'));
    }
    fileTabs.replaceChildren(...tabs);
  }

  function drawMeter(L) {
    const F = L.files[st.fi];
    if (!F) { meter.replaceChildren(); return; }
    // Sections by line count, coloured by the topic of their rules.
    const secs = [];
    let cur = { title: '(top)', start: 0, lines: 0, tokens: 0, topics: {}, ri: -1 };
    secs.push(cur);
    F.rows.forEach((r, ri) => {
      if (r.kind === 'heading') { cur = { title: r.title, start: r.line, lines: 0, tokens: 0, topics: {}, ri }; secs.push(cur); }
      cur.lines += r.end - r.line + 1; cur.tokens += r.tokens || 0;
      if (r.kind === 'rule' && r.topic) cur.topics[r.topic] = (cur.topics[r.topic] || 0) + 1;
    });
    const scale = Math.max(F.lines, L.maxLines * 1.08, 1);
    const strip = h('div', { class: 'am-strip', role: 'img', 'aria-label': `${F.lines} of ${L.maxLines} lines` });
    for (const s of secs.filter((x) => x.lines)) {
      const top = Object.entries(s.topics).sort((a, b) => b[1] - a[1])[0]?.[0] || 'none';
      strip.append(h('button', { class: `am-seg t-${top}`, type: 'button', style: `width:${(100 * s.lines / scale).toFixed(2)}%`,
        title: `${s.title}: ${s.lines} lines, ~${s.tokens} tokens${top !== 'none' ? ` (${TOPIC_LABEL[top]})` : ''}`,
        onclick: () => { if (s.ri >= 0) { st.sel = s.ri; st.focusAfter = s.ri; st.mode = 'rules'; draw(); } } },
      s.lines / scale > 0.07 ? h('span', {}, s.title) : null));
    }
    const over = F.lines > L.maxLines;
    strip.append(h('i', { class: `am-target${over ? ' over' : ''}`, style: `left:${(100 * L.maxLines / scale).toFixed(2)}%`, title: `target ${L.maxLines} lines` }));
    const target = h('input', { type: 'text', inputmode: 'numeric', class: 'am-num', value: String(ctx.raw.maxLines ?? L.maxLines), 'aria-label': 'Line target',
      onchange: (e) => ctx.set('maxLines', e.target.value) });
    const kb = (F.bytes / 1024).toFixed(1);
    const tight = L.tightened[st.fi];
    meter.replaceChildren(
      h('div', { class: 'am-mline' },
        h('span', { class: `am-big${over ? ' bad' : ''}` }, `${F.lines}`), h('span', { class: 'am-sub' }, ' lines of a target of '), target,
        h('span', { class: 'am-sub' }, ' (Claude Code memory docs, verify)'),
        h('span', { class: 'am-grow' }),
        h('span', { class: 'am-sub' }, h('b', {}, `~${F.tokens}`), ' tokens est. · ', h('b', {}, `${kb}`), ' KB · ', h('b', {}, `${F.rules}`), ' rules'),
        tight ? h('span', { class: 'am-sub am-tight', title: 'The tightened copy (Output tab), conflict markers not counted' }, ' → tightened ', h('b', {}, `~${tight.tokens}`)) : null),
      strip);
  }

  function drawBody(L) {
    const F = L.files[st.fi];
    if (st.mode === 'source' || !F) {
      const ta = h('textarea', { class: 'am-ta am-src', spellcheck: 'false', rows: 24, 'aria-label': 'File text',
        placeholder: st.fi ? 'Paste a nested CLAUDE.md or a subfolder AGENTS.md to check it against the first file.' : 'Paste a CLAUDE.md or AGENTS.md.' });
      ta.value = ctx.raw[KEYS[st.fi]] ?? '';
      ta.addEventListener('input', () => ctx.set(KEYS[st.fi], ta.value));
      const name = h('input', { type: 'text', class: 'am-name', spellcheck: 'false', 'aria-label': 'Path of this file in the repository', value: ctx.raw[NAMES[st.fi]] ?? '' });
      name.addEventListener('change', () => ctx.set(NAMES[st.fi], name.value));
      body.replaceChildren(h('div', { class: 'am-srcbar' }, h('label', {}, 'Path in the repository ', name),
        h('span', { class: 'am-hint' }, 'Edit the text directly; switch back to Rules to see it checked.')), ta);
      return;
    }
    const list = h('div', { class: 'am-rows', role: 'list', 'aria-label': `Rules of ${F.name}. Up and Down move, Enter opens a rule.` });
    const topicRows = st.topic ? new Set(L.topics.find((t) => t.id === st.topic)?.rows.filter(([fi]) => fi === st.fi).map(([, ri]) => ri)) : null;
    // Token subtotal per heading.
    const secTok = {}; let curH = -1;
    F.rows.forEach((r, ri) => { if (r.kind === 'heading') curH = ri; else if (curH >= 0) { secTok[curH] = secTok[curH] || { tok: 0, rules: 0 }; secTok[curH].tok += r.tokens || 0; if (r.kind === 'rule') secTok[curH].rules++; } });
    F.rows.forEach((r, ri) => {
      if (r.kind === 'blank') return;
      const finds = (r.finds || []).map((i) => L.findings[i]).filter((f) => !st.sev || f.sev === st.sev);
      const sev = finds.length ? worst(finds.map((f) => f.id), L.findings) : '';
      const dim = ri !== st.sel && ((topicRows && !topicRows.has(ri) && r.kind !== 'heading') || (st.sev && !finds.length && r.kind !== 'heading'));
      const sel = ri === st.sel;
      let el;
      if (r.kind === 'heading') {
        const t = secTok[ri] || { tok: 0, rules: 0 };
        el = h('div', { class: `am-row am-h lv${r.level}${sev ? ' s-' + sev : ''}${sel ? ' sel' : ''}`, role: 'listitem', tabindex: '0', 'data-ri': ri },
          h('span', { class: 'am-ln' }, r.line + 1),
          h('span', { class: 'am-htext' }, h('i', {}, '#'.repeat(r.level)), ' ', r.title),
          h('span', { class: 'am-meta' }, `${t.rules} rule${t.rules === 1 ? '' : 's'} · ~${t.tok} tok`),
          badges(finds));
      } else if (r.kind === 'code') {
        const lines = r.text.split('\n');
        el = h('div', { class: `am-row am-code${sev ? ' s-' + sev : ''}${sel ? ' sel' : ''}${dim ? ' dim' : ''}`, role: 'listitem', tabindex: '0', 'data-ri': ri },
          h('span', { class: 'am-ln' }, r.line + 1),
          h('pre', {}, lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n… ${lines.length - 4} more lines` : '')),
          h('span', { class: 'am-tok', title: 'estimated tokens' }, r.tokens), badges(finds));
      } else {
        const text = r.kind === 'import' ? r.text.trim() : r.body || '';
        el = h('div', { class: `am-row am-${r.kind}${sev ? ' s-' + sev : ''}${sel ? ' sel' : ''}${dim ? ' dim' : ''}`, role: 'listitem', tabindex: '0', 'data-ri': ri, 'aria-expanded': String(sel) },
          h('span', { class: 'am-ln' }, r.line + 1 + (r.end > r.line ? `-${r.end + 1}` : '')),
          r.kind === 'rule' && r.topic ? h('button', { class: `am-topic t-${r.topic}`, type: 'button', tabindex: '-1', title: `${TOPIC_LABEL[r.topic]} - click to light this topic`,
            onclick: (e) => { e.stopPropagation(); st.topic = st.topic === r.topic ? null : r.topic; draw(); } }, TOPIC_SHORT[r.topic] || r.topic) : h('span', { class: 'am-topic none' }, r.kind === 'import' ? 'import' : 'text'),
          h('div', { class: 'am-text' }, r.kind === 'rule' && r.prefix.trim() ? h('span', { class: 'am-bullet' }, r.prefix.trim().replace(/^[-*+]$/, '•')) : null, marked(text, r.spans || [])),
          h('span', { class: 'am-tok', title: 'estimated tokens' }, r.tokens), badges(finds));
      }
      el.addEventListener('click', (e) => { if (e.target.closest('.am-detail')) return; st.sel = sel ? -1 : ri; st.editing = false; st.focusAfter = ri; draw(); });
      el.addEventListener('keydown', (e) => rowKey(e, ri, finds));
      list.append(el);
      if (sel) list.append(detail(r, ri, (r.finds || []).map((i) => L.findings[i]), L));
    });
    body.replaceChildren(list);
  }

  function badges(finds) {
    if (!finds.length) return h('span', { class: 'am-badges' });
    const by = {};
    for (const f of finds) by[f.rule] = f.sev;
    return h('span', { class: 'am-badges' }, Object.entries(by).map(([rule, sev]) => h('span', { class: `am-badge s-${sev}`, title: rule }, rule.replace(/-/g, ' '))));
  }

  function detail(r, ri, finds, L) {
    const box = h('div', { class: 'am-detail' });
    for (const f of finds) {
      box.append(h('div', { class: `am-f s-${f.sev}` },
        h('span', { class: 'am-pill' }, f.sev), h('b', {}, cap(f.rule)), ' ', f.msg,
        L.advice[f.rule] ? h('div', { class: 'am-why' }, L.advice[f.rule]) : null,
        h('div', { class: 'am-acts' },
          f.fix ? h('button', { class: 'k-btn k-primary', type: 'button', onclick: () => fixRow(f) }, FIX_LABEL[f.rule] || 'Fix') : null,
          (f.related || []).map((x) => h('button', { class: 'k-btn', type: 'button', onclick: () => goTo(x.file, x.line) }, `Go to ${x.file !== st.fi ? L.files[x.file].name + ':' : 'line '}${x.line}`)),
          h('button', { class: 'k-btn', type: 'button', title: `Hide this finding (adds ${f.key} to the ignore list)`, onclick: () => ignoreFinding(f) }, 'Ignore'))));
    }
    if (!finds.length) box.append(h('div', { class: 'am-hint' }, r.kind === 'rule' ? 'No findings on this rule.' : 'Not a rule: text, a heading or code.'));
    if (r.kind === 'rule' || r.kind === 'heading' || r.kind === 'text') {
      const inp = h('textarea', { class: 'am-ta am-edit', rows: 2, spellcheck: 'false', 'aria-label': 'Edit this line. Enter saves, Escape cancels.' });
      inp.value = r.kind === 'heading' ? r.title : r.body || '';
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editRow(ri, inp.value); }
        if (e.key === 'Escape') { e.preventDefault(); st.editing = false; st.focusAfter = ri; draw(); }
      });
      box.append(h('div', { class: 'am-editrow' }, inp,
        h('div', { class: 'am-acts' },
          h('button', { class: 'k-btn', type: 'button', onclick: () => editRow(ri, inp.value) }, 'Save'),
          h('button', { class: 'k-btn', type: 'button', onclick: () => deleteRow(ri) }, r.kind === 'heading' ? 'Delete heading' : 'Delete line'),
          h('span', { class: 'am-hint' }, 'Enter saves · Esc closes · F fixes · Del deletes'))));
      if (st.editing) setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 0);
    }
    return box;
  }

  function rowKey(e, ri, finds) {
    if (e.target.closest('textarea, input, button:not(.am-row)') && e.target !== e.currentTarget) return;
    const rows = [...body.querySelectorAll('.am-row')];
    const i = rows.indexOf(e.currentTarget);
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus(); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); rows[Math.max(0, i - 1)]?.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (st.sel === ri) { st.editing = true; } else { st.sel = ri; st.editing = false; }
      st.focusAfter = ri; draw();
    } else if (e.key === 'Escape') { st.sel = -1; st.focusAfter = ri; draw(); }
    else if (e.key === 'Delete') { e.preventDefault(); deleteRow(ri); }
    else if (e.key === 'f' || e.key === 'F') { const f = finds.find((x) => x.fix); if (f) { e.preventDefault(); fixRow(f); } }
  }

  function drawTopics(L) {
    const shown = L.topics.filter((t) => t.count || t.core);
    const total = shown.reduce((n, t) => n + t.tokens, 0) || 1;
    topicSub.textContent = `${L.topics.filter((t) => t.gap).length} gap${L.topics.filter((t) => t.gap).length === 1 ? '' : 's'} · click to light`;
    topicGrid.replaceChildren(...shown.map((t) => h('button', { class: `am-tile t-${t.id}${t.gap ? ' gap' : ''}${st.topic === t.id ? ' on' : ''}`, type: 'button', 'aria-pressed': String(st.topic === t.id),
      title: t.gap ? `No rules about ${t.label.toLowerCase()}: an agent will guess. Add one concrete line.` : `${t.count} rules, ~${t.tokens} tokens`,
      onclick: () => { st.topic = st.topic === t.id ? null : t.id; st.mode = 'rules'; draw(); } },
    h('span', { class: 'am-tl' }, t.label),
    h('b', {}, t.gap ? 'gap' : t.count),
    h('i', { class: 'am-tbar' }, h('i', { style: `width:${(100 * t.tokens / total).toFixed(1)}%` })),
    h('span', { class: 'am-tt' }, t.gap ? 'add a rule' : `~${t.tokens} tok`))));
  }

  function drawFindings(L) {
    const c = { bad: 0, warn: 0, info: 0 };
    for (const f of L.findings) c[f.sev]++;
    findSub.textContent = `${L.findings.length} in ${L.files.length} file${L.files.length > 1 ? 's' : ''}`;
    sevBar.replaceChildren(...['bad', 'warn', 'info'].map((s) => h('button', { class: `am-sevb s-${s}`, type: 'button', 'aria-pressed': String(st.sev === s),
      title: `Show only ${s} findings in the rows`, onclick: () => { st.sev = st.sev === s ? null : s; draw(); } }, `${c[s]} ${s}`)));
    const ord = [...L.findings].filter((f) => !st.sev || f.sev === st.sev).sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev] || a.file - b.file || a.line - b.line);
    findList.replaceChildren(...ord.map((f) => h('li', {},
      h('button', { class: `am-fi s-${f.sev}${f.file === st.fi && f.row === st.sel ? ' on' : ''}`, type: 'button', onclick: () => goTo(f.file, f.line) },
        h('span', { class: 'am-where' }, `${L.files.length > 1 ? L.files[f.file].name + ':' : 'L'}${f.line}`),
        h('b', {}, cap(f.rule)), ' ', h('span', { class: 'am-fm' }, f.msg)))));
    if (!ord.length) findList.append(h('li', { class: 'am-hint' }, st.sev ? `No ${st.sev} findings.` : 'No findings. The file reads clean by these checks.'));
    const ign = String(ctx.raw.ignore || '').split('\n').map((x) => x.trim()).filter(Boolean);
    ignored.replaceChildren(...(ign.length ? [h('span', { class: 'am-hint' }, `${ign.length} ignored`),
      h('button', { class: 'k-btn', type: 'button', onclick: () => ctx.set('ignore', '') }, 'Show them again')] : []));
  }

  function drawPaths(L) {
    if (document.activeElement !== pathsTa) pathsTa.value = ctx.raw.paths ?? '';
    const stale = L.findings.filter((f) => f.rule === 'stale-path').length;
    pathsSub.textContent = L.pathsChecked ? `${L.pathsChecked} paths · ${stale} stale` : 'empty: paths not checked';
    pathsSub.className = `am-sub${stale ? ' warn' : ''}`;
  }

  function draw() {
    const L = lint(); if (!L) return;
    if (st.fi >= L.files.length && st.mode !== 'source') st.fi = 0;
    modeBtn.textContent = st.mode === 'rules' ? 'Edit text' : 'Show rules';
    modeBtn.setAttribute('aria-pressed', String(st.mode === 'source'));
    useBtn.disabled = !L.files[st.fi];
    drawTabs(L);
    if (st.fi >= L.files.length) {
      // The second file's tab, still empty.
      fileTabs.querySelector('.am-add')?.setAttribute('aria-selected', 'true');
    }
    drawMeter(L);
    const focusedSrc = document.activeElement?.classList.contains('am-src') || document.activeElement?.classList.contains('am-name');
    if (!(st.mode === 'source' && focusedSrc)) drawBody(L);
    drawTopics(L);
    drawFindings(L);
    drawPaths(L);
    notes.replaceChildren(h('summary', {}, 'Notes and sources'),
      ...(ctx.result.notes || []).map((n) => h('div', {}, n)),
      ...(ctx.manifest.sources || []).map((n) => h('div', { class: 'am-src-l' }, n)));
    if (st.focusAfter != null && st.mode === 'rules') {
      const el = body.querySelector(`.am-row[data-ri="${st.focusAfter}"]`) || body.querySelector('.am-row');
      st.focusAfter = null;
      if (el && !st.editing) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
    }
  }

  ctx.onResult(() => draw());
}
