// String Table Editor: the page is the translation sheet itself.
//   Sheet   - one row per string, one column per language, edited in place
//             (click a cell, Enter or double-click to edit, arrows to move).
//             Holes are hatched and show what the file will get instead
//             (per the Missing setting); placeholders are chips, red where
//             they differ from the base language; each translation carries a
//             bar of its length against the base text; rows and cells with a
//             problem are marked where the problem is. Column heads carry the
//             language's coverage and pick the file shown on the right.
//   In app  - the selected string as a button in every language, with a
//             wall you drag to the space the layout gives it: what overflows
//             shows at once.
//   File    - the resource file for the chosen language and format, the
//             selected string's lines highlighted; click a line to jump to it.
// Coverage, lengths, placeholders and problems come from run()'s result
// (sheet, texts, values); every edit is written back into the table text.

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// The same placeholder shapes the tool compares (printf and ICU/brace).
const PH = /%%|%(?:\d+\$)?[-#+0,(]*\d*(?:\.\d+)?(?:ll|l|h|z)?[sdifuxXoceEgG@]|\{\{?\s*[A-Za-z_][\w.]*\s*(?:,[^{}]*)?\}?\}/g;
const FORMATS = [['android', 'Android', 'strings.xml'], ['ios', 'iOS', '.strings'], ['json', 'JSON', 'i18next'], ['arb', 'Flutter', '.arb']];
const MISSING = [['omit', 'leave out'], ['base', 'copy base'], ['empty', 'empty string']];

function quoteCell(v, delim) {
  const s = String(v ?? '');
  return /["\r\n]/.test(s) || s.includes(delim) ? `"${s.replace(/"/g, '""')}"` : s;
}
const serialize = (m, delim) => m.map((row) => row.map((c) => quoteCell(c, delim)).join(delim)).join('\n');

export function page(root, ctx) {
  const state = { row: 0, col: null, edit: null, lang: null, pw: null, pwFor: null, drag: false, adding: false, refocus: false };

  // ---------- skeleton ----------
  const stats = h('div', { class: 'st-head' });
  const table = h('table', { class: 'st-grid', role: 'grid', 'aria-label': 'String table' });
  const scroll = h('div', { class: 'st-scroll' }, table);
  const legend = h('div', { class: 'st-foot' });
  const gridCard = h('section', { class: 'st-card' }, stats, scroll, legend);

  const prevBody = h('div', { class: 'st-prev' });
  const prevHead = h('div', { class: 'st-head' }, h('h2', {}, 'In the app'), h('span', { class: 'st-soft' }, 'drag the wall to the space the button gets'));
  const prevCard = h('section', { class: 'st-card' }, prevHead, prevBody);

  const fmtSeg = h('div', { class: 'st-seg', role: 'group', 'aria-label': 'Output format' });
  const missSeg = h('div', { class: 'st-seg', role: 'group', 'aria-label': 'Missing translations' });
  const nestBox = h('input', { type: 'checkbox', 'aria-label': 'Nest JSON keys at dots' });
  nestBox.addEventListener('change', () => ctx.set('nestKeys', nestBox.checked));
  const nestLbl = h('label', { class: 'st-soft', style: 'display:inline-flex;gap:4px;align-items:center' }, nestBox, 'nest at dots');
  const langTabs = h('div', { class: 'st-langs', role: 'group', 'aria-label': 'Language file' });
  const pathEl = h('span', { class: 'st-path' });
  const copyBtn = h('button', { class: 'k-btn k-primary', type: 'button' }, 'Copy');
  const dlBtn = h('button', { class: 'k-btn', type: 'button', title: 'Save this file' }, 'Save');
  const code = h('div', { class: 'st-code', role: 'list', 'aria-label': 'Resource file' });
  const fileCard = h('section', { class: 'st-card' },
    h('div', { class: 'st-head' }, h('h2', {}, 'File'), fmtSeg),
    h('div', { class: 'st-file-h' }, h('span', { class: 'st-soft' }, 'Missing:'), missSeg, nestLbl),
    h('div', { class: 'st-file-h' }, langTabs, h('span', { class: 'st-grow' }), copyBtn, dlBtn),
    h('div', { class: 'st-file-h' }, pathEl), code);

  const probs = h('div', { class: 'st-probs', 'aria-live': 'polite' });
  const probCard = h('section', { class: 'st-card' }, h('div', { class: 'st-head' }, h('h2', {}, 'Problems')), probs);
  const srcTa = h('textarea', { spellcheck: 'false', 'aria-label': 'String table as CSV or TSV' });
  srcTa.addEventListener('input', () => ctx.set('table', srcTa.value));
  const baseIn = h('input', { type: 'text', spellcheck: 'false', style: 'width:70px', 'aria-label': 'Base language' });
  baseIn.addEventListener('input', () => ctx.set('base', baseIn.value));
  const src = h('details', { class: 'st-card st-src' }, h('summary', {}, 'Sheet as text (paste CSV or TSV from a spreadsheet here)'), srcTa);
  const msgs = h('div', { class: 'st-msgs' });

  root.append(h('div', { class: 'st' }, gridCard, h('div', { class: 'st-side' }, prevCard, fileCard),
    h('div', { class: 'st-below' }, h('div', { style: 'display:flex;flex-direction:column;gap:10px;min-width:0' }, probCard, src, msgs), ctx.outputs)));

  // ---------- data ----------
  const R = () => ctx.result || {};
  const S = () => R().sheet || null;
  const val = (label) => (R().values || []).find((v) => v.label === label);
  const matrix = () => { const s = S(); return s ? [s.header.slice(), ...s.rows.map((r) => [...r.cells, ...r.extra])] : null; };
  const write = (m) => ctx.set('table', serialize(m, S().delim));
  const colKind = (ci) => { const s = S(); return ci === s.keyCol ? 'key' : ci === s.commentCol ? 'cmt' : s.langs.some((l) => l.col === ci) ? 'lang' : 'other'; };
  const langOf = (ci) => S().langs.find((l) => l.col === ci)?.lang;
  const curLang = () => { const s = S(); return s.langs.some((l) => l.lang === state.lang) ? state.lang : s.base; };

  const ops = {
    setCell(ri, ci, v) { const m = matrix(); if (!m[ri + 1]) return; while (m[ri + 1].length <= ci) m[ri + 1].push(''); if (m[ri + 1][ci] === v) return; m[ri + 1][ci] = v; write(m); },
    addRow() {
      const s = S(); const m = matrix();
      const keys = new Set(s.rows.map((r) => r.key));
      let k = 'new_string', i = 2; while (keys.has(k)) k = `new_string_${i++}`;
      m.push(s.header.map((_, ci) => (ci === s.keyCol ? k : '')));
      state.row = s.rows.length; state.col = s.keyCol; state.edit = { ri: s.rows.length, ci: s.keyCol }; state.refocus = true;
      write(m);
    },
    delRow(ri) { const m = matrix(); m.splice(ri + 1, 1); state.row = Math.max(0, Math.min(ri, m.length - 2)); write(m); },
    addLang(codeTxt) {
      const s = S(); const c = codeTxt.trim();
      if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,4})?$/.test(c) || s.header.some((x) => x.toLowerCase() === c.toLowerCase())) return false;
      const m = matrix();
      const last = Math.max(...s.langs.map((l) => l.col));
      const pos = last + 1;
      m.forEach((row, i) => { while (row.length < s.header.length) row.push(''); row.splice(pos, 0, i === 0 ? c : ''); });
      state.lang = c; write(m); return true;
    },
  };

  // ---------- the sheet ----------
  function chips(text, badSet) {
    const out = []; let last = 0;
    const s = String(text);
    for (const m of s.matchAll(PH)) {
      if (m.index > last) out.push(...nl(s.slice(last, m.index)));
      if (m[0] === '%%') out.push('%%');
      else out.push(h('span', { class: `st-ph${badSet ? ' bad' : ''}` }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(...nl(s.slice(last)));
    return out;
  }
  function nl(t) {
    const parts = t.split('\n'); const out = [];
    parts.forEach((p, i) => { if (i) out.push(h('span', { class: 'st-nl' }, '↵'), '\n'); out.push(p); });
    return out;
  }

  function drawGrid() {
    const s = S();
    table.replaceChildren();
    if (!s) return;
    const miss = ctx.raw.missing || 'omit';
    const fileLang = curLang();
    // head
    const tr = h('tr', {}, h('th', { class: 'gut', 'aria-label': 'Line' }));
    s.header.forEach((name, ci) => {
      const k = colKind(ci);
      if (k === 'lang') {
        const cov = s.coverage.find((c) => c.lang === name);
        const isBase = name === s.base;
        const b = h('button', { class: 'st-lh', type: 'button', title: `Show the ${name} file · ${cov.done} of ${cov.done + cov.missing} translated`, onclick: () => { state.lang = name; drawAll(); } },
          h('span', { class: 'top' }, h('b', {}, name), isBase ? h('span', { class: 'pill base' }, 'base') : null, name === fileLang ? h('span', { class: 'pill file' }, 'file') : null,
            h('span', { class: `pct${cov.missing ? ' warn' : ''}` }, cov.missing ? `${cov.missing} missing` : `${Math.round(cov.pct)} %`)),
          h('span', { class: 'st-cov', 'aria-hidden': 'true' }, h('i', { style: `width:${cov.pct}%` }), h('s', { style: `width:${100 - cov.pct}%` })));
        tr.append(h('th', { class: name === fileLang ? 'on' : '', scope: 'col' }, b));
      } else tr.append(h('th', { scope: 'col' }, h('div', { class: 'st-kh' }, k === 'key' ? `${name} · ${s.rows.length} strings` : name || '(unnamed)')));
    });
    const addTh = h('th', { class: 'st-addl' });
    if (state.adding) {
      const inp = h('input', { type: 'text', placeholder: 'fr, pt-BR', spellcheck: 'false', 'aria-label': 'New language code' });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { state.adding = false; if (!ops.addLang(inp.value)) { state.adding = true; inp.style.borderColor = 'var(--danger)'; } }
        if (e.key === 'Escape') { state.adding = false; drawGrid(); }
      });
      addTh.append(inp); setTimeout(() => inp.focus(), 0);
    } else addTh.append(h('button', { class: 'k-btn', type: 'button', onclick: () => { state.adding = true; drawGrid(); } }, '+ language'));
    tr.append(addTh);
    table.append(h('thead', {}, tr));

    const tb = h('tbody');
    s.rows.forEach((r, ri) => {
      const rowIssues = r.issues.filter((x) => !x.lang);
      const trr = h('tr', { class: `${r.issues.length ? 'bad' : ''}${!r.used ? ' dead' : ''}${ri === state.row ? ' cur' : ''}` });
      const gut = h('td', { class: 'gut', title: r.issues.map((x) => x.text).join('\n') || `line ${r.line}` }, String(r.line),
        h('button', { class: 'st-del', type: 'button', title: `Delete the row ${r.key || ''}`, 'aria-label': `Delete row ${r.key}`, onclick: () => ops.delRow(ri) }, '×'));
      trr.append(gut);
      s.header.forEach((_, ci) => {
        const k = colKind(ci);
        const v = r.cells[ci] ?? '';
        const td = h('td', { class: `st-c ${k}`, tabindex: '-1', 'data-r': ri, 'data-c': ci, role: 'gridcell' });
        if (ri === state.row && ci === state.col) td.tabIndex = 0;
        if (state.edit && state.edit.ri === ri && state.edit.ci === ci) {
          td.append(editor(ri, ci, v));
        } else if (k === 'key') {
          const iss = r.issues.filter((x) => x.lang === '@key').concat(rowIssues);
          if (iss.length) { td.classList.add('bad', 'issue'); td.title = iss.map((x) => x.text).join('\n'); }
          td.append(h('span', { class: 't' }, v || '(no key)'));
        } else if (k === 'lang') {
          const lang = langOf(ci);
          const info = r.cell[lang];
          const iss = r.issues.filter((x) => x.lang === lang);
          if (iss.length) { td.classList.add('issue'); td.title = iss.map((x) => x.text).join('\n'); }
          if (info.missing) {
            td.classList.add('hole');
            const baseTxt = r.cells[s.langs.find((l) => l.lang === s.base).col] ?? '';
            if (lang === s.base) td.append(h('div', { class: 'ghost' }, 'no base text', h('small', {}, 'every language falls back to it')));
            else if (miss === 'base') td.append(h('div', { class: 'ghost' }, h('span', { class: 't' }, baseTxt), h('small', {}, `missing · the file copies ${s.base}`)));
            else if (miss === 'empty') td.append(h('div', { class: 'ghost' }, '""', h('small', {}, 'missing · written empty')));
            else td.append(h('div', { class: 'ghost' }, '—', h('small', {}, `missing · left out, falls back to ${s.base}`)));
          } else {
            const phBad = iss.some((x) => /placeholders/.test(x.text));
            td.append(h('div', { class: 't' }, chips(v, phBad)));
            if (info.ratio != null) {
              const rt = info.ratio;
              const cls = rt > 1.6 ? 'vlong' : rt > 1.3 ? 'long' : rt < 0.7 ? 'short' : '';
              td.append(h('div', { class: `st-len ${cls}`, title: `${info.len} characters, ${Math.round(rt * 100)} % of the ${s.base} text` },
                h('span', { class: 'bar' }, h('i', { style: `width:${clamp(rt * 32, 2, 64)}px` }), h('b')), `${rt >= 1 ? '+' : '−'}${Math.abs(Math.round((rt - 1) * 100))} %`));
            }
          }
        } else {
          td.append(h('span', { class: 't' }, v));
        }
        trr.append(td);
      });
      trr.append(h('td'));
      tb.append(trr);
    });
    const addRowTr = h('tr', {}, h('td', { class: 'gut' }), h('td', { colspan: String(s.header.length + 1), style: 'padding:6px 8px' },
      h('button', { class: 'k-btn', type: 'button', onclick: () => ops.addRow() }, '+ string')));
    tb.append(addRowTr);
    table.append(tb);
    if (!table.querySelector('td[tabindex="0"]')) table.querySelector('td.st-c')?.setAttribute('tabindex', '0');
    if (state.refocus) {
      state.refocus = false;
      const el = state.edit ? table.querySelector('.st-ed') : table.querySelector(`td[data-r="${state.row}"][data-c="${state.col}"]`);
      el?.focus();
    }
  }

  function editor(ri, ci, v) {
    const ta = h('textarea', { class: 'st-ed', spellcheck: 'false', rows: String(Math.max(2, String(v).split('\n').length)), 'aria-label': 'Edit cell' });
    ta.value = v;
    let done = false;
    const finish = (commit, move) => {
      if (done) return; done = true;
      state.edit = null; state.refocus = true;
      if (move) { state.row = clamp(state.row + move[0], 0, S().rows.length - 1); state.col = clamp(state.col + move[1], 0, S().header.length - 1); }
      if (commit && ta.value !== v) ops.setCell(ri, ci, colKind(ci) === 'key' ? ta.value.trim() : ta.value);
      else drawGrid();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); finish(true, [1, 0]); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab') { e.preventDefault(); finish(true, [0, e.shiftKey ? -1 : 1]); }
    });
    ta.addEventListener('blur', () => finish(true));
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    return ta;
  }

  // grid pointer and keys
  table.addEventListener('click', (e) => {
    const td = e.target.closest('td.st-c'); if (!td || state.edit) return;
    const ri = +td.dataset.r, ci = +td.dataset.c;
    if (ri === state.row && ci === state.col && document.activeElement === td) { state.edit = { ri, ci }; drawGrid(); return; }
    const rowChanged = ri !== state.row;
    state.row = ri; state.col = ci; state.refocus = true;
    if (rowChanged) drawAll(); else drawGrid();
  });
  table.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td.st-c'); if (!td) return;
    state.row = +td.dataset.r; state.col = +td.dataset.c; state.edit = { ri: state.row, ci: state.col }; drawGrid();
  });
  table.addEventListener('keydown', (e) => {
    const td = e.target.closest && e.target.closest('td.st-c');
    if (!td || e.target !== td) return;
    const s = S();
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (mv) {
      e.preventDefault();
      const r0 = state.row;
      state.row = clamp(+td.dataset.r + mv[0], 0, s.rows.length - 1); state.col = clamp(+td.dataset.c + mv[1], 0, s.header.length - 1);
      state.refocus = true; if (state.row !== r0) drawAll(); else drawGrid(); return;
    }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); state.edit = { ri: +td.dataset.r, ci: +td.dataset.c }; drawGrid(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); state.refocus = true; ops.setCell(+td.dataset.r, +td.dataset.c, ''); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // typing starts editing, replacing the cell like a spreadsheet
      e.preventDefault();
      state.edit = { ri: +td.dataset.r, ci: +td.dataset.c }; drawGrid();
      const ta = table.querySelector('.st-ed'); if (ta) { ta.value = e.key; }
    }
  });
  table.addEventListener('focusin', (e) => {
    const td = e.target.closest && e.target.closest('td.st-c');
    if (!td) return;
    for (const x of table.querySelectorAll('td.st-c[tabindex="0"]')) if (x !== td) x.tabIndex = -1;
    td.tabIndex = 0;
  });

  function drawStats() {
    const s = S();
    const stat = (label, v, cls) => h('span', { class: `st-stat ${cls || ''}` }, h('b', {}, String(v)), ` ${label}`);
    const miss = val('Missing translations'), pr = val('Problems');
    stats.replaceChildren(h('h2', {}, 'Strings'),
      s ? stat('strings', val('Strings')?.value ?? 0) : null, s ? stat('languages', val('Languages')?.value ?? 0) : null,
      miss ? stat('missing', miss.value, miss.value ? 'warn' : '') : null,
      pr ? stat(pr.value === 1 ? 'problem' : 'problems', pr.value, pr.value ? 'bad' : '') : null,
      h('span', { class: 'st-grow' }),
      h('label', { class: 'st-soft', style: 'display:inline-flex;gap:5px;align-items:center' }, 'base', baseIn));
    if (document.activeElement !== baseIn) baseIn.value = ctx.raw.base ?? '';
    legend.replaceChildren(
      h('span', { class: 'lg' }, h('span', { class: 'st-ph' }, '%1$s'), 'placeholder'),
      h('span', { class: 'lg' }, h('span', { class: 'st-ph bad' }, '{nom}'), 'differs from base'),
      h('span', { class: 'lg' }, h('span', { class: 'sw', style: 'background:repeating-linear-gradient(135deg, color-mix(in srgb, var(--tool-hole) 30%, transparent) 0 3px, transparent 3px 6px)' }), 'missing'),
      h('span', { class: 'lg' }, h('span', { class: 'st-len long' }, h('span', { class: 'bar' }, h('i', { style: 'width:46px' }), h('b'))), 'length against base (tick = same)'),
      h('span', { class: 'st-grow' }),
      h('span', {}, 'Click a cell, Enter or type to edit · Shift+Enter new line · Tab next'));
  }

  // ---------- in the app ----------
  const measure = (() => {
    const c = document.createElement('canvas').getContext('2d');
    return (t) => { c.font = `500 14px ${getComputedStyle(document.body).fontFamily}`; return c.measureText(t).width; };
  })();
  const sample = (t) => String(t).replace(/\n/g, ' ').replace(PH, (m) => (m === '%%' ? '%' : /^%.*[diuxXo]$/.test(m) ? '12' : /^%.*[feEgG]$/.test(m) ? '3.5' : 'Alexandra'));
  function drawPreview() {
    const s = S();
    if (!s || !s.rows.length) { prevBody.replaceChildren(h('div', { class: 'st-soft' }, 'No strings yet.')); return; }
    const r = s.rows[clamp(state.row, 0, s.rows.length - 1)];
    const baseCol = s.langs.find((l) => l.lang === s.base).col;
    const baseTxt = r.cells[baseCol] ?? '';
    const miss = ctx.raw.missing || 'omit';
    const items = s.langs.map(({ lang, col }) => {
      let t = r.cells[col] ?? '', ghost = false;
      if (!t.trim() && lang !== s.base) { ghost = true; t = miss === 'empty' ? '' : baseTxt; }
      const text = sample(t);
      return { lang, text, ghost, w: Math.ceil(measure(text)) + 28 };
    });
    const avail = Math.max(120, prevBody.clientWidth - 70);
    const baseW = items.find((x) => x.lang === s.base)?.w || 120;
    const pwKey = `${r.line}:${r.key}`;
    if (state.pwFor !== pwKey && !state.pwUser) { state.pw = Math.round(baseW * 1.3 / 4) * 4; state.pwFor = pwKey; }
    const pw = clamp(state.pw || 160, 40, avail);
    const over = items.filter((x) => x.w > pw);
    const lanes = h('div', { class: 'lanes' });
    for (const it of items) {
      const bw = Math.min(it.w, pw);
      const lane = h('div', { class: 'lane' },
        h('div', { class: `btn${it.ghost ? ' miss' : ''}${it.w > pw ? ' over' : ''}`, style: `width:${bw}px`, title: it.text }, it.text || ' '));
      if (it.w > pw) lane.append(h('span', { class: 'spill', style: `left:${pw}px` }, `+${it.w - pw} px`));
      lanes.append(h('div', { class: 'row' }, h('span', { class: 'code' }, it.lang), lane));
    }
    const wall = h('div', { class: 'wall', style: `left:${50 + pw}px` });
    const handle = h('div', { class: `handle${state.drag ? ' on' : ''}`, tabindex: '0', role: 'slider', style: `left:${50 + pw}px`,
      'aria-label': 'Space for the button', 'aria-valuenow': String(pw), 'aria-valuetext': `${pw} px`, title: 'Drag, or arrow keys (Shift: ×5)' });
    lanes.append(wall, handle);
    const ruler = h('div', { class: 'ruler' }, h('span', { style: `left:${pw}px` }, `${pw} px`));
    handle.addEventListener('pointerdown', (e) => {
      state.drag = true; handle.setPointerCapture(e.pointerId); handle.classList.add('on'); e.preventDefault();
      const x0 = lanes.getBoundingClientRect().left + 50;
      const mv = (ev) => { state.pw = Math.round(clamp(ev.clientX - x0, 40, avail)); state.pwUser = true; drawPreview(); };
      const up = () => { state.drag = false; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); drawPreview(); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!d) return; e.preventDefault();
      state.pw = clamp(pw + d * (e.shiftKey ? 20 : 4), 40, avail); state.pwUser = true; drawPreview();
      prevBody.querySelector('.handle')?.focus();
    });
    const msg = h('div', { class: 'msg' },
      h('b', {}, r.key || '(no key)'), ' · ',
      over.length ? h('span', { class: 'bad' }, `overflows in ${over.map((x) => `${x.lang} (+${x.w - pw} px)`).join(', ')}`) : h('span', { class: 'ok' }, `fits in every language at ${pw} px`),
      h('div', { class: 'st-soft', style: 'margin-top:2px' }, 'Placeholders filled with sample values; measured in this page\'s font at 14 px.'));
    prevBody.replaceChildren(ruler, lanes, msg);
  }

  // ---------- the file ----------
  function keyLines(lines, key, fmt) {
    if (!key) return [];
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    if (fmt === 'android') re = new RegExp(`name="${esc}"`);
    else if (fmt === 'ios') re = new RegExp(`^"${esc}" =`);
    else if (fmt === 'arb') re = new RegExp(`^\\s*"@?${esc}":`);
    else if (ctx.input.nestKeys && key.includes('.')) {
      // walk the nested object: each segment deeper by two spaces
      const segs = key.split('.'); let from = 0, hit = -1;
      for (let d = 0; d < segs.length; d++) {
        const r2 = new RegExp(`^${' '.repeat(2 * (d + 1))}"${segs[d].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":`);
        hit = lines.findIndex((l, i) => i >= from && r2.test(l)); if (hit < 0) return []; from = hit + 1;
      }
      return [hit];
    } else re = new RegExp(`^\\s*"${esc}":`);
    const out = [];
    lines.forEach((l, i) => { if (re.test(l)) { if (i && /^\s*(<!--|\/\*)/.test(lines[i - 1])) out.push(i - 1); out.push(i); } });
    return out;
  }
  function lineKey(lines, i, fmt) {
    const s = S();
    for (const r of s.rows) if (r.key && keyLines(lines, r.key, fmt).includes(i)) return r.key;
    return null;
  }
  function paint(line, fmt) {
    if (fmt === 'android') {
      const m = /^(\s*<string name=")([^"]*)(">)(.*)(<\/string>)$/.exec(line);
      if (m) return [h('span', { class: 'tg' }, m[1]), h('span', { class: 'ky' }, m[2]), h('span', { class: 'tg' }, m[3]), ...escChips(m[4]), h('span', { class: 'tg' }, m[5])];
    }
    return [line];
  }
  const escChips = (t) => { const out = []; let last = 0; for (const m of t.matchAll(/\\['"n\\t@?]|&amp;|&lt;/g)) { out.push(t.slice(last, m.index), h('span', { class: 'es' }, m[0])); last = m.index + m[0].length; } out.push(t.slice(last)); return out; };

  function drawFile() {
    const s = S(); const r = R();
    const fmt = ctx.raw.format || 'android';
    fmtSeg.replaceChildren(...FORMATS.map(([v, t, sub]) => h('button', { type: 'button', 'aria-pressed': String(v === fmt), title: sub, onclick: () => ctx.set('format', v) }, t)));
    missSeg.replaceChildren(...MISSING.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(v === (ctx.raw.missing || 'omit')), onclick: () => ctx.set('missing', v) }, t)));
    nestLbl.style.display = fmt === 'json' ? '' : 'none';
    nestBox.checked = !!ctx.raw.nestKeys;
    if (!s || !r.texts?.length) { langTabs.replaceChildren(); code.replaceChildren(); pathEl.textContent = ''; return; }
    const lang = curLang();
    const li = s.langs.findIndex((l) => l.lang === lang);
    langTabs.replaceChildren(...s.langs.map((l) => h('button', { type: 'button', 'aria-pressed': String(l.lang === lang), onclick: () => { state.lang = l.lang; drawAll(); } }, l.lang)));
    const t = r.texts[li];
    pathEl.textContent = t.title;
    const lines = t.body.replace(/\n$/, '').split('\n');
    const row = s.rows[state.row];
    const hl = new Set(keyLines(lines, row?.key, fmt));
    code.replaceChildren(...lines.map((l, i) => {
      const d = h('div', { class: hl.has(i) ? 'hl' : '', role: 'listitem' }, h('span', {}, String(i + 1)), h('span', {}, ...paint(l, fmt)));
      d.addEventListener('click', () => {
        const k = lineKey(lines, i, fmt); if (!k) return;
        const ri = s.rows.findIndex((x) => x.key === k && x.used);
        if (ri >= 0) { state.row = ri; state.col = s.langs[li]?.col ?? s.keyCol; state.refocus = true; drawAll(); }
      });
      return d;
    }));
    const first = code.querySelector('.hl');
    if (first) { const top = first.offsetTop - code.clientHeight / 3; if (first.offsetTop < code.scrollTop || first.offsetTop > code.scrollTop + code.clientHeight - 20) code.scrollTop = Math.max(0, top); }
    copyBtn.onclick = async () => {
      let ok = false; try { await navigator.clipboard.writeText(t.body); ok = true; } catch { ok = false; }
      copyBtn.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
    };
    dlBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([t.body], { type: 'text/plain;charset=utf-8' }));
      a.download = t.title.replace(/\//g, '_');
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  }

  // ---------- problems, source, notes ----------
  function drawBelow() {
    const s = S(); const r = R();
    const list = [];
    if (s) s.rows.forEach((row, ri) => row.issues.forEach((x) => list.push({ ri, row, x })));
    probs.replaceChildren(...(list.length ? list.map(({ ri, row, x }) => h('button', { type: 'button', onclick: () => {
      state.row = ri; state.col = x.lang && x.lang !== '@key' ? (s.langs.find((l) => l.lang === x.lang)?.col ?? s.keyCol) : s.keyCol; state.refocus = true; drawAll();
      table.querySelector(`td[data-r="${ri}"][data-c="${state.col}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } }, h('span', { class: 'ln' }, `line ${row.line}`), h('span', {}, h('b', {}, row.key || '(no key)'), x.lang && x.lang !== '@key' ? ` · ${x.lang}` : '', ` — ${x.text}`)))
      : [h('div', { class: s ? 'none' : 'st-soft' }, s ? 'No problems: keys, placeholders and base texts check out.' : 'Paste a table to check it.')]));
    if (document.activeElement !== srcTa && srcTa.value !== (ctx.raw.table ?? '')) srcTa.value = ctx.raw.table ?? '';
    if (!s) src.open = true;
    const warns = (r.warnings || []).filter((w) => !/problems? found/.test(w));
    msgs.replaceChildren(
      ...(warns.length ? [h('div', { class: 'k-warns' }, warns.map((w) => h('div', {}, w)))] : []),
      ...(r.notes?.length ? [h('div', { class: 'k-notes' }, r.notes.map((w) => h('div', {}, w)))] : []));
  }

  function drawAll() {
    const s = S();
    if (s) state.row = clamp(state.row, 0, Math.max(0, s.rows.length - 1));
    if (s && state.col == null) state.col = s.langs.find((l) => l.lang === s.base)?.col ?? 1;
    drawStats(); drawGrid(); drawPreview(); drawFile(); drawBelow();
  }
  const ro = new ResizeObserver(() => { if (!state.drag) drawPreview(); });
  ro.observe(prevBody);
  ctx.onResult(() => drawAll());
}
