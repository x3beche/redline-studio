// Skill Builder, drawn as the thing itself: the SKILL.md as a document you
// edit in place (frontmatter fields, the allowed-tools chips, the numbered
// steps you can reorder), and beside it how the skill shows up where the
// model chooses it (the skill list line), a trigger tester whose threshold
// you drag across the score bars, and the skill folder as a tree you add
// files to. Lint sits beside the field it is about.
//   Steps: Alt+Up/Down (or drag the grip) moves a step, Enter adds one below,
//   Backspace on an empty step removes it. Threshold: drag the line or focus
//   it and use the arrows. Tree: + adds a file to a folder, click a purpose to
//   edit it, x removes the file.
// Everything drawn comes from run()'s result.skill; edits change the inputs.

import { ROOTS } from './tool.js';

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
const PALETTE = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Agent', 'Skill'];
const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };

export function page(root, ctx) {
  const S = () => ctx.result?.skill || null;
  const st = { dragStep: null, addDir: null, editPurpose: -1, focusStep: null };

  // ---------- the document ----------
  const nameIn = h('input', { class: 'sk-in sk-name', type: 'text', spellcheck: 'false', 'aria-label': 'name', oninput: () => ctx.set('name', nameIn.value) });
  const descIn = h('textarea', { class: 'sk-in sk-desc', rows: 3, spellcheck: 'false', 'aria-label': 'description', oninput: () => { grow(descIn); ctx.set('description', descIn.value); } });
  const descMeter = h('div', { class: 'sk-meter' });
  const toolChips = h('div', { class: 'sk-chips' });
  const toolAdd = h('input', { class: 'sk-in sk-tooladd', type: 'text', spellcheck: 'false', placeholder: 'Bash(git diff:*)', 'aria-label': 'Add an allowed tool (Enter)',
    onkeydown: (e) => { if (e.key === 'Enter' && toolAdd.value.trim()) { e.preventDefault(); setTools([...curTools(), toolAdd.value.trim()]); toolAdd.value = ''; } } });
  const palette = h('div', { class: 'sk-palette', role: 'group', 'aria-label': 'Toggle a tool' });
  const slot = {};
  for (const k of ['name', 'description', 'tools', 'when', 'steps', 'files', 'notes']) slot[k] = h('div', { class: 'sk-lint', role: 'status' });
  const title = h('div', { class: 'sk-h1' });
  const whenIn = h('textarea', { class: 'sk-in sk-block', rows: 3, spellcheck: 'false', 'aria-label': 'When to use', oninput: () => { grow(whenIn); ctx.set('whenToUse', whenIn.value); } });
  const stepList = h('ol', { class: 'sk-steps', 'aria-label': 'Steps. Alt+Up/Down moves a step, Enter adds one.' });
  const addStep = h('button', { class: 'k-btn', type: 'button', onclick: () => { const s = curSteps(); s.push(''); st.focusStep = s.length - 1; setSteps(s, true); } }, '+ Step');
  const filesList = h('ul', { class: 'sk-flist' });
  const notesIn = h('textarea', { class: 'sk-in sk-block', rows: 3, spellcheck: 'false', 'aria-label': 'Notes', oninput: () => { grow(notesIn); ctx.set('notes', notesIn.value); } });
  const docSub = h('span', { class: 'sk-sub' });
  const doc = h('section', { class: 'sk-card sk-doc' },
    h('div', { class: 'sk-head' }, h('h2', {}, 'SKILL.md'), docSub),
    h('div', { class: 'sk-fm' },
      h('div', { class: 'sk-dash' }, '---'),
      h('div', { class: 'sk-kv' }, h('label', { class: 'sk-k' }, 'name:'), h('div', { class: 'sk-v' }, nameIn, slot.name)),
      h('div', { class: 'sk-kv' }, h('label', { class: 'sk-k' }, 'description:'), h('div', { class: 'sk-v' }, descIn, descMeter, slot.description)),
      h('div', { class: 'sk-kv' }, h('label', { class: 'sk-k' }, 'allowed-tools:'), h('div', { class: 'sk-v' }, h('div', { class: 'sk-toolrow' }, toolChips, toolAdd), palette, slot.tools)),
      h('div', { class: 'sk-dash' }, '---')),
    h('div', { class: 'sk-body' },
      title,
      h('div', { class: 'sk-h2' }, '## When to use'), whenIn, slot.when,
      h('div', { class: 'sk-h2' }, '## Steps', h('span', { class: 'sk-grow' }), addStep), stepList, slot.steps,
      h('div', { class: 'sk-h2' }, '## Files', h('span', { class: 'sk-sub' }, 'from the folder tree')), filesList, slot.files,
      h('div', { class: 'sk-h2' }, '## Notes'), notesIn, slot.notes));

  // ---------- rail ----------
  const listing = h('div', { class: 'sk-listing' });
  const listSub = h('span', { class: 'sk-sub' });
  const listCard = h('section', { class: 'sk-card' }, h('div', { class: 'sk-head' }, h('h2', {}, 'In the skill list'), listSub), listing);
  const testRows = h('div', { class: 'sk-tests' });
  const thrLine = h('div', { class: 'sk-thr', role: 'slider', tabindex: '0', 'aria-label': 'Trigger threshold', 'aria-valuemin': '0.05', 'aria-valuemax': '0.95' });
  const bars = h('div', { class: 'sk-bars' }, testRows, thrLine);
  const testAdd = h('input', { class: 'sk-in', type: 'text', spellcheck: 'false', placeholder: 'Type what a user would say, Enter adds it (start with - for one that should not load it)', 'aria-label': 'Add a test message',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !testAdd.value.trim()) return;
      e.preventDefault();
      const v = testAdd.value.trim();
      const line = /^[+-]\s/.test(v) ? v : `+ ${v}`;
      ctx.set('tests', [String(ctx.raw.tests || '').trim(), line].filter(Boolean).join('\n'));
      testAdd.value = '';
    } });
  const testSub = h('span', { class: 'sk-sub' });
  const testCard = h('section', { class: 'sk-card' },
    h('div', { class: 'sk-head' }, h('h2', {}, 'Trigger tester'), testSub),
    h('div', { class: 'sk-tadd' }, testAdd), bars,
    h('div', { class: 'sk-hint' }, 'A heuristic: shared words (5-letter stems, accents folded) and quoted phrases from the description. The model chooses by meaning; this catches descriptions that share no words with what people say.'));
  const scopeSeg = h('div', { class: 'sk-seg', role: 'group', 'aria-label': 'Where the skill lives' });
  const treeEl = h('ul', { class: 'sk-tree', role: 'tree' });
  const treeCard = h('section', { class: 'sk-card' }, h('div', { class: 'sk-head' }, h('h2', {}, 'Folder'), h('span', { class: 'sk-grow' }), scopeSeg), treeEl);
  const lintList = h('ul', { class: 'sk-lintall' });
  const lintSub = h('span', { class: 'sk-sub' });
  const lintCard = h('section', { class: 'sk-card' }, h('div', { class: 'sk-head' }, h('h2', {}, 'Lint'), lintSub), lintList);
  const notes = h('details', { class: 'sk-notes' }, h('summary', {}, 'Notes and sources'));
  const rail = h('aside', { class: 'sk-rail' }, listCard, testCard, treeCard, lintCard);
  const side = h('div', { class: 'sk-col' }, doc, ctx.outputs, notes);
  root.append(h('div', { class: 'sk' }, side, rail));

  // ---------- state helpers ----------
  const curTools = () => (S()?.tools || []).map((t) => t.text);
  const setTools = (list) => ctx.set('allowedTools', [...new Set(list)].join(', '));
  const curSteps = () => String(ctx.raw.steps || '').split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*+])\s+/, '')).filter((l, i, a) => l.trim() || i < a.length);
  const setSteps = (list, redraw) => { ctx.set('steps', list.join('\n')); if (redraw) drawSteps(true); };
  const curFiles = () => (Array.isArray(ctx.raw.files) ? ctx.raw.files : []).map((r) => ({ path: r.path || '', purpose: r.purpose || '' }));
  const setFiles = (rows) => ctx.set('files', rows);
  const lintFor = (field) => (S()?.lint || []).filter((x) => x.field === field);
  const drawSlot = (field) => slot[field].replaceChildren(...lintFor(field).map((x) => h('div', { class: `sk-l s-${x.sev}` }, h('b', {}, x.sev), ' ', x.msg)));
  const setVal = (el, v) => { if (document.activeElement !== el && el.value !== v) { el.value = v; if (el.tagName === 'TEXTAREA') grow(el); } };

  // ---------- draw: document ----------
  function drawTools(sk) {
    const on = new Set(sk.tools.map((t) => t.text));
    toolChips.replaceChildren(...sk.tools.map((t, i) => h('span', { class: `sk-chip${t.known ? '' : ' bad'}${t.base === 'Bash' && t.arg == null ? ' warn' : ''}` },
      h('code', {}, t.text),
      h('button', { type: 'button', class: 'sk-x', 'aria-label': `Remove ${t.text}`, onclick: () => setTools(curTools().filter((_, k) => k !== i)) }, '×'))));
    if (!sk.tools.length) toolChips.append(h('span', { class: 'sk-sub' }, 'none: every tool call asks'));
    palette.replaceChildren(h('span', { class: 'sk-sub' }, 'toggle:'), ...PALETTE.map((t) => h('button', { type: 'button', class: 'sk-pal', 'aria-pressed': String(on.has(t)),
      onclick: () => setTools(on.has(t) ? curTools().filter((x) => x !== t) : [...curTools(), t]) }, t)));
  }
  function drawSteps(force) {
    if (!force && stepList.contains(document.activeElement)) return;
    const steps = curSteps();
    stepList.replaceChildren(...steps.map((txt, i) => {
      const inp = h('input', { class: 'sk-in sk-step', type: 'text', spellcheck: 'false', 'aria-label': `Step ${i + 1}`, value: txt });
      inp.addEventListener('input', () => { const s = curSteps(); s[i] = inp.value; setSteps(s); });
      inp.addEventListener('keydown', (e) => {
        const s = curSteps();
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
          if (j < 0 || j >= s.length) return;
          [s[i], s[j]] = [s[j], s[i]]; st.focusStep = j; setSteps(s, true);
        } else if (e.key === 'Enter') { e.preventDefault(); s.splice(i + 1, 0, ''); st.focusStep = i + 1; setSteps(s, true); }
        else if (e.key === 'Backspace' && !inp.value && s.length > 1) { e.preventDefault(); s.splice(i, 1); st.focusStep = Math.max(0, i - 1); setSteps(s, true); }
        else if (e.key === 'ArrowDown' && !e.altKey) { stepList.querySelectorAll('.sk-step')[i + 1]?.focus(); }
        else if (e.key === 'ArrowUp' && !e.altKey) { stepList.querySelectorAll('.sk-step')[i - 1]?.focus(); }
      });
      const grip = h('span', { class: 'sk-grip', title: 'Drag to reorder (or Alt+Up/Down in the step)', 'aria-hidden': 'true' }, '⋮⋮');
      const li = h('li', { class: 'sk-li', 'data-i': i }, grip, h('span', { class: 'sk-num' }, `${i + 1}.`), inp,
        h('button', { type: 'button', class: 'sk-x', 'aria-label': `Delete step ${i + 1}`, onclick: () => { const s2 = curSteps(); s2.splice(i, 1); setSteps(s2, true); } }, '×'));
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault(); grip.setPointerCapture(e.pointerId); st.dragStep = { from: i, to: i }; li.classList.add('drag');
      });
      grip.addEventListener('pointermove', (e) => {
        if (!st.dragStep) return;
        const lis = [...stepList.children];
        let to = lis.findIndex((x) => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
        if (to < 0) to = lis.length - 1;
        st.dragStep.to = to;
        lis.forEach((x, k) => x.classList.toggle('drop', k === to && to !== st.dragStep.from));
      });
      grip.addEventListener('pointerup', () => {
        const d = st.dragStep; st.dragStep = null; if (!d) return;
        if (d.to !== d.from) { const s = curSteps(); const [m] = s.splice(d.from, 1); s.splice(d.to, 0, m); setSteps(s, true); } else drawSteps(true);
      });
      return li;
    }));
    if (st.focusStep != null) { const el = stepList.querySelectorAll('.sk-step')[st.focusStep]; st.focusStep = null; el?.focus(); }
  }
  function drawDoc(sk) {
    setVal(nameIn, ctx.raw.name ?? '');
    setVal(descIn, ctx.raw.description ?? '');
    setVal(whenIn, ctx.raw.whenToUse ?? '');
    setVal(notesIn, ctx.raw.notes ?? '');
    nameIn.classList.toggle('bad', lintFor('name').some((x) => x.sev === 'bad'));
    const dl = sk.desc.length, lim = sk.limits.description;
    descMeter.replaceChildren(h('i', { class: dl > lim ? 'over' : dl < 80 ? 'thin' : '', style: `width:${Math.min(100, 100 * dl / lim).toFixed(1)}%` }),
      h('span', {}, `${dl} / ${lim} characters · ~${sk.descTokens} tokens in every session (verify limit)`));
    drawTools(sk);
    title.replaceChildren(h('span', {}, `# ${ctx.result.texts[0].body.split('\n').find((l) => l.startsWith('# '))?.slice(2) || ''}`), h('span', { class: 'sk-sub' }, ' from the name'));
    drawSteps(false);
    filesList.replaceChildren(...(curFiles().filter((f) => f.path).length ? curFiles().filter((f) => f.path).map((f) => h('li', {}, h('code', {}, f.path), f.purpose ? ` - ${f.purpose}` : ''))
      : [h('li', { class: 'sk-sub' }, 'No files: add scripts/ or references/ in the folder tree.')]));
    for (const k of Object.keys(slot)) drawSlot(k);
    docSub.textContent = `${sk.fmLines + sk.bodyLines} lines · body ${sk.bodyLines} / ${sk.limits.bodyLines}`;
  }

  // ---------- draw: listing ----------
  function drawListing(sk) {
    const d = sk.desc;
    const frag = [];
    let last = 0;
    for (const m of d.matchAll(/["“']([^"”']{3,60})["”']/g)) {
      frag.push(d.slice(last, m.index), h('mark', { class: 'sk-ph', title: 'quoted trigger phrase' }, m[0]));
      last = m.index + m[0].length;
    }
    frag.push(d.slice(last));
    listing.replaceChildren(
      h('div', { class: 'sk-line' }, h('span', { class: 'sk-dim' }, '- '), h('b', {}, sk.name || '(no name)'), h('span', { class: 'sk-dim' }, ': '), ...(d ? frag : [h('i', { class: 'sk-bad' }, '(no description: the model cannot pick this skill)')])),
      h('div', { class: 'sk-cmd' }, h('span', { class: 'sk-sub' }, 'Also runs as '), h('code', {}, `/${sk.name || 'my-skill'}`),
        h('span', { class: 'sk-sub' }, ` · ${sk.phrases.length} quoted phrase${sk.phrases.length === 1 ? '' : 's'}`)));
    listSub.textContent = 'what the model reads to choose it';
  }

  // ---------- draw: tests ----------
  function drawTests(sk) {
    const T = sk.tests;
    const ok = T.filter((t) => t.pass).length;
    testSub.textContent = T.length ? `${ok} / ${T.length} as expected · threshold ${sk.threshold}` : 'add messages below';
    testSub.className = `sk-sub${T.length && ok < T.length ? ' warn' : ''}`;
    const lines = String(ctx.raw.tests || '').split('\n').map((l) => l.trim()).filter(Boolean);
    testRows.replaceChildren(...T.map((t, i) => h('div', { class: `sk-trow${t.pass ? '' : ' miss'}` },
      h('button', { type: 'button', class: `sk-exp ${t.expect ? 'yes' : 'no'}`, title: t.expect ? 'Should load the skill (click: should not)' : 'Should not load it (click: should)',
        onclick: () => { lines[i] = `${t.expect ? '-' : '+'} ${t.text}`; ctx.set('tests', lines.join('\n')); } }, t.expect ? 'load' : 'skip'),
      h('div', { class: 'sk-tmsg' }, h('span', {}, t.text),
        h('span', { class: 'sk-tw' }, ...t.phrases.map((p) => h('mark', { class: 'sk-ph' }, `"${p}"`)), ...t.matched.map((w) => h('mark', {}, w)), !t.matched.length && !t.phrases.length ? h('i', {}, 'no shared words') : null)),
      h('div', { class: 'sk-bar', title: 'Drag across the bars to move the threshold' }, h('i', { style: `width:${(t.score * 100).toFixed(0)}%`, class: t.fires ? 'on' : '' }), h('s', { class: 'sk-tick', style: `left:${(sk.threshold * 100).toFixed(0)}%` }), h('b', {}, t.score.toFixed(2))),
      h('span', { class: `sk-res ${t.pass ? 'ok' : 'bad'}` }, t.pass ? (t.fires ? 'loads' : 'stays out') : (t.fires ? 'loads: too broad' : 'misses')),
      h('button', { type: 'button', class: 'sk-x', 'aria-label': 'Remove this test', onclick: () => { lines.splice(i, 1); ctx.set('tests', lines.join('\n')); } }, '×'))));
    placeThr(sk.threshold);
    thrLine.setAttribute('aria-valuenow', String(sk.threshold));
    thrLine.hidden = !T.length;
  }
  function barBox() {
    const b = testRows.querySelector('.sk-bar');
    return b ? b.getBoundingClientRect() : null;
  }
  function placeThr(v) {
    const b = barBox(), o = bars.getBoundingClientRect();
    if (!b) return;
    thrLine.style.left = `${b.left - o.left + v * b.width}px`;
    for (const t of testRows.querySelectorAll('.sk-tick')) t.style.left = `${(v * 100).toFixed(0)}%`;
    thrLine.dataset.v = v.toFixed(2);
  }
  let dragThr = false;
  const thrFrom = (x) => { const b = barBox(); if (!b) return null; return Math.round(Math.min(0.95, Math.max(0.05, (x - b.left) / b.width)) * 100) / 100; };
  thrLine.addEventListener('pointerdown', (e) => { e.preventDefault(); dragThr = true; thrLine.setPointerCapture(e.pointerId); thrLine.classList.add('drag'); });
  testRows.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.sk-bar')) return;
    e.preventDefault(); dragThr = true; thrLine.setPointerCapture(e.pointerId); thrLine.classList.add('drag');
    const v = thrFrom(e.clientX); if (v != null) placeThr(v);
  });
  thrLine.addEventListener('pointermove', (e) => { if (!dragThr) return; const v = thrFrom(e.clientX); if (v != null) { placeThr(v); } });
  thrLine.addEventListener('pointerup', (e) => { if (!dragThr) return; dragThr = false; thrLine.classList.remove('drag'); const v = thrFrom(e.clientX); if (v != null) ctx.set('threshold', String(v)); });
  thrLine.addEventListener('keydown', (e) => {
    const cur = S()?.threshold ?? 0.35;
    const step = e.shiftKey ? 0.1 : 0.05;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); ctx.set('threshold', String(Math.max(0.05, Math.round((cur - step) * 100) / 100))); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); ctx.set('threshold', String(Math.min(0.95, Math.round((cur + step) * 100) / 100))); }
  });
  window.addEventListener('resize', () => { const sk = S(); if (sk) placeThr(sk.threshold); for (const t of [descIn, whenIn, notesIn]) grow(t); });

  // ---------- draw: tree ----------
  function drawTree(sk) {
    scopeSeg.replaceChildren(...Object.keys(ROOTS).map((k) => h('button', { type: 'button', 'aria-pressed': String((ctx.raw.scope || 'project') === k), onclick: () => ctx.set('scope', k) }, k)));
    const files = curFiles();
    const dirs = [...new Set(['scripts', 'references', ...files.filter((f) => f.path.includes('/')).map((f) => f.path.split('/').slice(0, -1).join('/'))])].sort();
    const fileRow = (f, idx, depth) => {
      const nm = f.path.split('/').pop();
      const lint = sk.lint.filter((x) => x.field === 'files' && x.msg.includes(f.path));
      const purpose = idx === st.editPurpose
        ? h('input', { class: 'sk-in sk-pin', type: 'text', value: f.purpose, 'aria-label': `Purpose of ${f.path}`,
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); if (e.key === 'Enter') { const r = curFiles(); r[idx].purpose = e.target.value; st.editPurpose = -1; setFiles(r); } else { st.editPurpose = -1; drawTree(S()); } } },
          onblur: (e) => { if (st.editPurpose !== idx) return; const r = curFiles(); r[idx].purpose = e.target.value; st.editPurpose = -1; setFiles(r); } })
        : h('button', { type: 'button', class: 'sk-purpose', title: 'Edit what this file is for', onclick: () => { st.editPurpose = idx; drawTree(S()); treeEl.querySelector('.sk-pin')?.focus(); } }, f.purpose || 'add a purpose');
      return h('li', { class: `sk-node file${lint.length ? ' s-' + lint[0].sev : ''}`, role: 'treeitem', style: `--d:${depth}` },
        h('span', { class: 'sk-fn' }, nm), purpose,
        lint.length ? h('span', { class: 'sk-flag', title: lint.map((x) => x.msg).join('\n') }, lint[0].rule.replace(/-/g, ' ')) : null,
        h('button', { type: 'button', class: 'sk-x', 'aria-label': `Remove ${f.path}`, onclick: () => setFiles(curFiles().filter((_, k) => k !== idx)) }, '×'));
    };
    const items = [h('li', { class: 'sk-node root', role: 'treeitem' }, h('span', { class: 'sk-fn' }, `${sk.root}/`)),
      h('li', { class: 'sk-node file main', role: 'treeitem', style: '--d:1' }, h('span', { class: 'sk-fn' }, 'SKILL.md'), h('span', { class: 'sk-sub' }, `${sk.fmLines + sk.bodyLines} lines · loads when used`))];
    const top = files.map((f, i) => [f, i]).filter(([f]) => f.path && !f.path.includes('/'));
    for (const [f, i] of top) items.push(fileRow(f, i, 1));
    for (const d of dirs) {
      const depth = d.split('/').length;
      const inDir = files.map((f, i) => [f, i]).filter(([f]) => f.path.split('/').slice(0, -1).join('/') === d);
      items.push(h('li', { class: 'sk-node dir', role: 'treeitem', style: `--d:${depth}` }, h('span', { class: 'sk-fn' }, `${d.split('/').pop()}/`),
        h('span', { class: 'sk-sub' }, d === 'scripts' ? 'run, not read' : d === 'references' ? 'read when a step needs it' : ''),
        h('button', { type: 'button', class: 'sk-add', title: `Add a file to ${d}/`, onclick: () => { st.addDir = d; drawTree(S()); treeEl.querySelector('.sk-newf')?.focus(); } }, '+ file')));
      for (const [f, i] of inDir) items.push(fileRow(f, i, depth + 1));
      if (st.addDir === d) {
        const inp = h('input', { class: 'sk-in sk-newf', type: 'text', spellcheck: 'false', placeholder: d === 'scripts' ? 'check.py' : 'notes.md', 'aria-label': `New file name in ${d}/ (Enter adds, Esc cancels)` });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { st.addDir = null; drawTree(S()); }
          if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); const r = curFiles(); r.push({ path: `${d}/${inp.value.trim().replace(/^\/+/, '')}`, purpose: '' }); st.addDir = null; setFiles(r); }
        });
        inp.addEventListener('blur', () => { if (st.addDir === d && !inp.value.trim()) { st.addDir = null; setTimeout(() => drawTree(S()), 0); } });
        items.push(h('li', { class: 'sk-node file', style: `--d:${depth + 1}` }, inp));
      }
    }
    treeEl.replaceChildren(...items);
  }

  function drawLint(sk) {
    const c = { bad: 0, warn: 0, info: 0 };
    for (const x of sk.lint) c[x.sev]++;
    lintSub.textContent = `${c.bad} bad · ${c.warn} warn · ${c.info} info · rules as of 2026-09, verify`;
    const ord = { bad: 0, warn: 1, info: 2 };
    lintList.replaceChildren(...[...sk.lint].sort((a, b) => ord[a.sev] - ord[b.sev]).map((x) => h('li', { class: `s-${x.sev}` }, h('b', {}, x.field), ' ', x.msg)));
    if (!sk.lint.length) lintList.append(h('li', { class: 'sk-sub' }, 'Nothing to flag.'));
  }

  ctx.onResult(() => {
    const sk = S(); if (!sk) return;
    drawDoc(sk); drawListing(sk); drawTests(sk); drawTree(sk); drawLint(sk);
    notes.replaceChildren(h('summary', {}, 'Notes and sources'), ...(ctx.result.notes || []).map((n) => h('div', {}, n)), ...(ctx.manifest.sources || []).map((n) => h('div', {}, n)));
    requestAnimationFrame(() => { placeThr(sk.threshold); for (const t of [descIn, whenIn, notesIn]) grow(t); });
  });
}
