// Prompt Template & Variables, drawn as the work itself: the template with
// its {{tags}} coloured per variable, the variables as chips that say where
// each value comes from, the data as a table whose column heads you drag onto
// a chip to bind them, and a strip of every rendered prompt with its token
// bar against the limit. Click a card to read that prompt with the filled
// values tinted by variable and the empty ones marked where they fell.
//   Keyboard: a chip opens its column list with Enter; cards take arrows.
// Everything drawn comes from run()'s result.render.

import { parseMapping } from './tool.js';

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
const SEV = { bad: 'Bad', warn: 'Warn', info: 'Info' };

export function page(root, ctx) {
  const state = { sel: 0, pop: null, drag: null, dataText: false, flash: null };
  const R = () => ctx.result?.render || null;
  const vIndex = (name) => Math.max(0, (R()?.vars || []).findIndex((v) => v.name === name));
  const vClass = (name) => `v${vIndex(name) % 10}`;

  // ---------- template ----------
  const back = h('div', { class: 'pt-back', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'pt-ta', spellcheck: 'false', 'aria-label': 'Template', autocomplete: 'off' });
  ta.value = ctx.raw.template || '';
  const ed = h('div', { class: 'pt-ed' }, back, ta);
  const chips = h('div', { class: 'pt-chips', role: 'list', 'aria-label': 'Variables: drop a data column on one to bind it' });
  const tplStat = h('span', { class: 'pt-sub' });
  const syntax = h('details', { class: 'pt-syntax' }, h('summary', {}, 'Syntax'),
    h('div', {}, h('code', {}, '{{name}}'), ' value · ', h('code', {}, '{{name|default}}'), ' fallback · ',
      h('code', {}, '{{#if name}}…{{else}}…{{/if}}'), ' · ', h('code', {}, '{{#unless name}}…{{/unless}}'), ' · ',
      h('code', {}, '{{#each list}}- {{.}}{{/each}}'), ' with ', h('code', {}, '{{@index}}'), ' / ', h('code', {}, '{{@number}}'), ' · ',
      h('code', {}, '{{! note}}'), '. A Mustache/Handlebars subset; values are not HTML-escaped; a block tag alone on its line removes the line.'));
  const tplCard = h('section', { class: 'pt-card pt-tpl' },
    h('div', { class: 'pt-head' }, h('h2', {}, 'Template'), tplStat, h('span', { class: 'pt-grow' }), syntax),
    chips, h('div', { class: 'pt-edscroll' }, ed));
  ta.addEventListener('input', () => { back.textContent = ta.value + '\n'; ctx.set('template', ta.value); });

  // ---------- data ----------
  const dataStat = h('span', { class: 'pt-sub' });
  const sepIn = h('input', { type: 'text', class: 'pt-in pt-sep', 'aria-label': 'List separator in cells', spellcheck: 'false', title: 'How a cell used by {{#each}} is split into items' });
  sepIn.value = ctx.raw.listSep ?? ';';
  sepIn.addEventListener('input', () => ctx.set('listSep', sepIn.value));
  const dataTa = h('textarea', { class: 'pt-datata', spellcheck: 'false', 'aria-label': 'Data as CSV, TSV or a JSON array', rows: 10 });
  dataTa.value = ctx.raw.data || '';
  dataTa.addEventListener('input', () => ctx.set('data', dataTa.value));
  const editBtn = h('button', { class: 'k-btn', type: 'button', 'aria-pressed': 'false', onclick: () => {
    state.dataText = !state.dataText; editBtn.setAttribute('aria-pressed', String(state.dataText));
    editBtn.textContent = state.dataText ? 'Show table' : 'Edit as text';
    dataTa.hidden = !state.dataText; tableWrap.hidden = state.dataText;
    if (state.dataText) { dataTa.value = ctx.raw.data || ''; dataTa.focus(); }
  } }, 'Edit as text');
  const tableWrap = h('div', { class: 'pt-tablewrap' });
  const rowDetail = h('dl', { class: 'pt-rowdetail' });
  dataTa.hidden = true;
  const dataCard = h('section', { class: 'pt-card pt-data' },
    h('div', { class: 'pt-head' }, h('h2', {}, 'Data'), dataStat, h('span', { class: 'pt-grow' }),
      h('label', { class: 'pt-f' }, 'List separator', sepIn), editBtn),
    h('div', { class: 'pt-hint' }, 'Drag a column head onto a variable chip to bind it. Paste CSV, TSV or JSON with Ctrl+V anywhere on the table.'),
    tableWrap, dataTa, rowDetail);
  tableWrap.tabIndex = 0;
  tableWrap.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text');
    if (t && t.trim()) { e.preventDefault(); dataTa.value = t; ctx.set('data', t); }
  });

  // ---------- strip ----------
  const limitIn = h('input', { type: 'text', class: 'pt-in pt-limit', inputmode: 'numeric', 'aria-label': 'Token limit per prompt' });
  limitIn.value = ctx.raw.limit ?? '';
  limitIn.addEventListener('input', () => ctx.set('limit', limitIn.value));
  const stripStat = h('span', { class: 'pt-sub' });
  const strip = h('div', { class: 'pt-strip', role: 'listbox', 'aria-label': 'Rendered prompts, one per row' });
  const stripCard = h('section', { class: 'pt-card pt-stripcard' },
    h('div', { class: 'pt-head' }, h('h2', {}, 'Rendered prompts'), stripStat, h('span', { class: 'pt-grow' }),
      h('label', { class: 'pt-f' }, 'Limit', limitIn, 'tokens')), strip);

  // ---------- preview ----------
  const sysTa = h('textarea', { class: 'pt-sys', rows: 2, spellcheck: 'false', 'aria-label': 'System message', placeholder: 'System message (optional)' });
  sysTa.value = ctx.raw.system || '';
  sysTa.addEventListener('input', () => ctx.set('system', sysTa.value));
  const prevHead = h('div', { class: 'pt-head' });
  const prevBody = h('pre', { class: 'pt-prev', tabindex: '0' });
  const prevCard = h('section', { class: 'pt-card pt-prevcard' }, prevHead,
    h('div', { class: 'pt-role' }, h('span', { class: 'pt-rolelbl' }, 'system'), sysTa),
    h('div', { class: 'pt-role pt-user' }, h('span', { class: 'pt-rolelbl' }, 'user'), prevBody));

  // ---------- findings ----------
  const findHead = h('span', { class: 'pt-sub' });
  const findList = h('ul', { class: 'pt-finds' });
  const findCard = h('section', { class: 'pt-card' }, h('div', { class: 'pt-head' }, h('h2', {}, 'Findings'), findHead), findList);
  const notes = h('div', { class: 'k-notes pt-notes' });

  root.append(h('div', { class: 'pt' }, tplCard, dataCard, stripCard, prevCard,
    h('div', { class: 'pt-side' }, findCard, ctx.outputs, notes)));

  // ---------- mapping ----------
  function setMap(name, col) {
    const { map } = parseMapping(ctx.raw.mapping || '');
    map[name] = col;
    // A binding that equals the automatic one is dropped, to keep the mapping short.
    const r = R();
    const same = col && r && r.columns.find((c) => c.toLowerCase().replace(/[^a-z0-9]/g, '') === name.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (same === col) delete map[name];
    const text = Object.entries(map).map(([k, v]) => `${k} = ${v}`).join('\n');
    state.flash = name;
    ctx.set('mapping', text);
  }
  function closePop() { if (state.pop) { state.pop.remove(); state.pop = null; } }
  document.addEventListener('pointerdown', (e) => { if (state.pop && !state.pop.contains(e.target) && !e.target.closest('.pt-chip')) closePop(); });
  function openPop(chip, v) {
    closePop();
    const r = R(); if (!r) return;
    const opts = [...r.columns.map((c) => ({ c, t: c })), { c: '', t: 'no column (use the default)' }];
    const pop = h('div', { class: 'pt-pop', role: 'listbox', 'aria-label': `Column for ${v.name}` },
      opts.map((o) => h('button', { type: 'button', role: 'option', class: `pt-opt${(v.col || '') === o.c ? ' on' : ''}`, 'aria-selected': String((v.col || '') === o.c),
        onclick: () => { closePop(); setMap(v.name, o.c); } }, o.t, r.unused.includes(o.c) ? h('small', {}, ' unused') : null)));
    pop.addEventListener('keydown', (e) => {
      const bs = [...pop.querySelectorAll('button')];
      const i = bs.indexOf(document.activeElement);
      if (e.key === 'Escape') { closePop(); chip.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); bs[Math.min(bs.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); bs[Math.max(0, i - 1)].focus(); }
    });
    chips.append(pop);
    const cr = chip.getBoundingClientRect(), pr = chips.getBoundingClientRect();
    pop.style.left = `${Math.min(cr.left - pr.left, Math.max(0, pr.width - 220))}px`;
    pop.style.top = `${cr.bottom - pr.top + 4}px`;
    state.pop = pop;
    (pop.querySelector('.on') || pop.querySelector('button')).focus();
  }

  function startColDrag(e, col) {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let ghost = null, over = null;
    const th = e.currentTarget;
    th.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!ghost) { ghost = h('div', { class: 'pt-ghost' }, col); document.body.append(ghost); root.classList.add('pt-dragging'); }
      ghost.style.left = `${ev.clientX + 10}px`; ghost.style.top = `${ev.clientY + 8}px`;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pt-chip');
      if (el !== over) { over?.classList.remove('drop'); over = el; over?.classList.add('drop'); }
    };
    const up = () => {
      th.removeEventListener('pointermove', move); th.removeEventListener('pointerup', up); th.removeEventListener('pointercancel', up);
      ghost?.remove(); root.classList.remove('pt-dragging');
      if (over) { over.classList.remove('drop'); setMap(over.dataset.name, col); }
    };
    th.addEventListener('pointermove', move); th.addEventListener('pointerup', up); th.addEventListener('pointercancel', up);
  }

  // ---------- draw ----------
  function drawChips(r) {
    closePop();
    chips.replaceChildren(...r.vars.map((v) => {
      const st = v.col ? (v.empty ? 'part' : 'ok') : v.how === 'bad-map' ? 'bad' : v.def != null ? 'def' : v.kind === 'condition' ? 'def' : 'bad';
      const src = v.col ? v.col : v.how === 'bad-map' ? 'unknown column' : v.def != null ? `default "${v.def}"` : v.kind === 'condition' ? 'never true' : 'no column';
      const chip = h('button', { type: 'button', role: 'listitem', class: `pt-chip ${vClass(v.name)} st-${st}${state.flash === v.name ? ' flash' : ''}`, 'data-name': v.name,
        title: `${v.name} (${v.kind}) ← ${src}${v.col && v.empty ? `; empty in ${v.empty} row${v.empty > 1 ? 's' : ''}` : ''}. Enter: choose the column.`,
        'aria-haspopup': 'listbox', onclick: (e) => openPop(e.currentTarget, v) },
      h('i'), h('b', {}, v.kind === 'list' ? `#${v.name}` : v.kind === 'condition' ? `?${v.name}` : v.name),
      h('span', { class: 'pt-arrow' }, '←'), h('span', { class: 'pt-src' }, src),
      v.col && v.empty ? h('em', {}, `${v.empty} empty`) : null);
      return chip;
    }));
    if (!r.vars.length) chips.append(h('span', { class: 'pt-sub' }, 'No {{variables}} in the template yet.'));
    state.flash = null;
  }
  function drawTemplate(r) {
    const text = ctx.raw.template || '';
    if (document.activeElement !== ta && ta.value !== text) ta.value = text;
    const marks = [...r.tags].sort((a, b) => a.s - b.s);
    const errs = r.errors;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const t of marks) {
      if (t.s < pos) continue;
      frag.append(text.slice(pos, t.s));
      const bad = errs.some((e) => e.s < t.e && e.e > t.s);
      const cls = t.kind === 'var' ? `pt-tag ${vClass(t.name)}` : t.kind === 'open' || t.kind === 'close' || t.kind === 'else' ? `pt-blk${t.name ? ` ${vClass(t.name)}` : ''}` : t.kind === 'comment' ? 'pt-cmt' : 'pt-err';
      frag.append(h('mark', { class: `${cls}${bad ? ' pt-err' : ''}` }, text.slice(t.s, t.e)));
      pos = t.e;
    }
    // soft errors (single braces) outside tags
    let rest = text.slice(pos);
    const soft = errs.filter((e) => e.soft && e.s >= pos).sort((a, b) => a.s - b.s);
    let p2 = pos;
    for (const e of soft) { frag.append(text.slice(p2, e.s)); frag.append(h('mark', { class: 'pt-err' }, text.slice(e.s, e.e))); p2 = e.e; }
    rest = text.slice(p2);
    frag.append(rest, '\n');
    back.replaceChildren(frag);
    const nErr = errs.filter((e) => !e.soft).length;
    tplStat.replaceChildren(nErr ? h('b', { class: 'bad' }, `${nErr} syntax error${nErr > 1 ? 's' : ''}`) : h('span', {}, `${r.vars.length} variable${r.vars.length === 1 ? '' : 's'}`));
  }
  function drawTable(r) {
    const used = new Map();
    for (const v of r.vars) if (v.col) (used.get(v.col) || used.set(v.col, []).get(v.col)).push(v.name);
    dataStat.textContent = r.format === 'none' ? 'no data' : `${r.format.toUpperCase()} · ${r.columns.length} columns × ${r.rows.length} rows`;
    if (!r.columns.length) { tableWrap.replaceChildren(h('div', { class: 'pt-empty' }, 'No table: paste CSV, TSV or a JSON array here, or press Edit as text.')); return; }
    const head = h('tr', {}, h('th', { class: 'pt-rn' }, '#'), r.columns.map((c) => {
      const vs = used.get(c) || [];
      const th = h('th', { class: `pt-col${vs.length ? '' : ' unused'}`, title: vs.length ? `Feeds ${vs.join(', ')}. Drag onto another chip to bind it there too.` : 'Not used by the template: drag it onto a chip' },
        h('span', { class: 'pt-colname' }, h('span', { class: 'pt-grip', 'aria-hidden': 'true' }), c),
        h('span', { class: 'pt-feeds' }, vs.length ? vs.map((v) => h('span', { class: `pt-feed ${vClass(v)}` }, v)) : h('span', { class: 'pt-unused' }, 'unused')));
      th.addEventListener('pointerdown', (e) => startColDrag(e, c));
      return th;
    }));
    const body = r.data.map((row, i) => h('tr', { class: i === state.sel ? 'on' : null, onclick: () => select(i) },
      h('td', { class: 'pt-rn' }, String(i + 1)),
      row.map((cell, k) => {
        const empty = !String(cell).trim();
        const needed = empty && (used.get(r.columns[k]) || []).length;
        return h('td', { class: `${empty ? 'empty' : ''}${needed ? ' needed' : ''}`, title: cell.length > 40 ? cell : null }, empty ? (needed ? 'empty' : '') : cell.replace(/\s+/g, ' '));
      })));
    tableWrap.replaceChildren(h('table', { class: 'pt-table' }, h('thead', {}, head), h('tbody', {}, body)));
    drawRowDetail(r, used);
  }
  function drawRowDetail(r, used) {
    const row = r.data[state.sel];
    if (!row) { rowDetail.replaceChildren(); return; }
    rowDetail.replaceChildren(h('h3', {}, `Row ${state.sel + 1}, every column`),
      ...r.columns.flatMap((c, k) => {
        const vs = used.get(c) || [];
        const empty = !String(row[k]).trim();
        return [h('dt', { class: vs.length ? `used ${vClass(vs[0])}` : null, title: vs.length ? `feeds ${vs.join(', ')}` : 'unused' }, c),
          h('dd', { class: empty ? (vs.length ? 'empty needed' : 'empty') : null }, empty ? (vs.length ? 'empty, and the template uses it' : 'empty') : row[k])];
      }));
  }
  function drawStrip(r) {
    const maxT = Math.max(r.limit || 0, ...r.rows.map((x) => x.tokens), 1);
    const over = r.rows.filter((x) => x.over).length;
    stripStat.textContent = `${r.rows.length} prompt${r.rows.length === 1 ? '' : 's'}${r.limit ? ` · ${over} over ${r.limit}` : ''} · tokens are estimates`;
    if (!r.rows.length) { strip.replaceChildren(h('div', { class: 'pt-empty' }, 'No rows to render: add data.')); return; }
    strip.replaceChildren(...r.rows.map((x, i) => {
      const lines = x.text.split('\n').filter((l) => l.trim()).slice(0, 6);
      const card = h('button', { type: 'button', role: 'option', class: `pt-rc${i === state.sel ? ' on' : ''}${x.over ? ' over' : ''}${x.empty.length ? ' holes' : ''}`, 'aria-selected': String(i === state.sel),
        'aria-label': `Row ${i + 1}, ${x.tokens} tokens${x.over ? ', over the limit' : ''}${x.empty.length ? `, empty: ${x.empty.join(', ')}` : ''}`,
        onclick: () => select(i) },
      h('div', { class: 'pt-rchead' }, h('b', {}, `Row ${i + 1}`), h('span', {}, x.label)),
      h('div', { class: 'pt-bar' }, h('i', { style: `width:${(x.tokens / maxT) * 100}%` }), r.limit ? h('u', { style: `left:${(r.limit / maxT) * 100}%`, title: `limit ${r.limit}` }) : null),
      h('div', { class: 'pt-rcnum' }, h('b', {}, `${x.tokens}`), ' tk · ', `${x.chars} ch`, x.over ? h('span', { class: 'pt-overtag' }, `+${x.tokens - r.limit}`) : null),
      h('div', { class: 'pt-badges' },
        ...x.empty.map((n) => h('span', { class: 'pt-badge bad' }, `${n} empty`)),
        ...x.notProvided.filter((n) => !x.empty.includes(n)).map((n) => h('span', { class: 'pt-badge bad' }, `${n} unbound`)),
        ...x.defaults.filter((n) => r.vars.find((v) => v.name === n)?.col).map((n) => h('span', { class: 'pt-badge' }, `${n} default`))),
      h('div', { class: 'pt-rcprev' }, lines.join('\n')));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(r.rows.length - 1, i + 1), true); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, i - 1), true); }
      });
      return card;
    }));
  }
  function drawPreview(r) {
    const x = r.rows[state.sel];
    if (document.activeElement !== sysTa && sysTa.value !== (ctx.raw.system || '')) sysTa.value = ctx.raw.system || '';
    if (!x) { prevHead.replaceChildren(h('h2', {}, 'Prompt')); prevBody.textContent = ''; return; }
    const names = [...new Set(x.pieces.map((p) => p.v))].filter((n) => !n.startsWith('@') && n !== '.');
    prevHead.replaceChildren(h('h2', {}, `Row ${state.sel + 1}`), h('span', { class: 'pt-sub' }, `${x.label} · ≈ ${x.tokens} tokens · ${x.chars} characters`),
      h('span', { class: 'pt-grow' }),
      h('div', { class: 'pt-legend' }, names.map((n) => h('span', { class: `pt-lg ${vClass(n)}` }, h('i'), n))));
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const p of x.pieces) {
      if (p.s < pos) continue;
      frag.append(x.text.slice(pos, p.s));
      if (p.e === p.s) frag.append(h('span', { class: 'pt-hole', title: `${p.v} is ${p.state === 'missing' ? 'not provided' : 'empty'} in this row` }, p.v));
      else frag.append(h('mark', { class: `pt-val ${p.v === '.' || p.v.startsWith('@') ? 'item' : vClass(p.v)}${p.state === 'default' ? ' def' : ''}`, title: `${p.v}${p.state === 'default' ? ' (default)' : ''}` }, x.text.slice(p.s, p.e)));
      pos = p.e;
    }
    frag.append(x.text.slice(pos));
    prevBody.replaceChildren(frag);
  }
  function drawFindings(r) {
    const F = r.findings;
    const n = (s) => F.filter((f) => f.sev === s).length;
    findHead.replaceChildren(...['bad', 'warn', 'info'].map((s) => h('b', { class: `sev-${s}` }, `${n(s)} ${s}`)));
    if (!F.length) { findList.replaceChildren(h('li', { class: 'pt-none' }, 'No findings: every variable has a value in every row.')); return; }
    findList.replaceChildren(...F.map((f) => h('li', {}, h('button', { type: 'button', class: 'pt-fbtn', onclick: () => {
      if (f.rows?.length) select(f.rows[0] - 1, true);
      if (f.v) { const c = chips.querySelector(`[data-name="${CSS.escape(f.v)}"]`); if (c) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); c.focus(); } }
      if (f.s != null && f.rule === 'syntax') { ta.focus(); ta.setSelectionRange(f.s, f.e); }
      if (f.cols) for (const th of tableWrap.querySelectorAll('th.unused')) { th.classList.remove('flash'); void th.offsetWidth; th.classList.add('flash'); }
    } }, h('span', { class: `pt-sev sev-${f.sev}` }, SEV[f.sev]), h('span', {}, f.msg)))));
  }
  function select(i, focus) {
    state.sel = i;
    const r = R(); if (!r) return;
    drawStrip(r); drawPreview(r);
    for (const [k, tr] of [...tableWrap.querySelectorAll('tbody tr')].entries()) tr.classList.toggle('on', k === i);
    const used = new Map();
    for (const v of r.vars) if (v.col) (used.get(v.col) || used.set(v.col, []).get(v.col)).push(v.name);
    drawRowDetail(r, used);
    const card = strip.children[i];
    if (card) { card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); if (focus) card.focus(); }
  }

  ctx.onResult((res) => {
    const r = res?.render; if (!r) return;
    if (state.sel >= r.rows.length) state.sel = Math.max(0, r.rows.length - 1);
    if (document.activeElement !== dataTa && dataTa.value !== (ctx.raw.data || '')) dataTa.value = ctx.raw.data || '';
    if (document.activeElement !== limitIn) limitIn.value = ctx.raw.limit ?? '';
    if (document.activeElement !== sepIn) sepIn.value = ctx.raw.listSep ?? ';';
    drawChips(r); drawTemplate(r); drawTable(r); drawStrip(r); drawPreview(r); drawFindings(r);
    notes.replaceChildren(...(res.notes || []).map((t) => h('div', {}, t)));
    if (!state.tabChosen) {
      state.tabChosen = true;
      let saved = null;
      try { saved = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
      if (!saved) [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'JSONL (messages)')?.click();
    }
  });
}
