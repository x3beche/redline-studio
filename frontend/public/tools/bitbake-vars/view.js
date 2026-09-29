// BitBake Variable Resolver, drawn as the evaluation itself.
//   Source      - the pasted lines, editable; the gutter marks every line that
//                 touches the variable, coloured by its file, with its verdict.
//                 Click a line number to resolve that line's variable.
//   Evaluation  - 1. Parse: each assignment of the variable in parse order with
//                 its operator's meaning, what happened (applied, skipped,
//                 queued, error) and the value right after it. 2. getVar: the
//                 steps BitBake takes when the value is read - override
//                 selection, :append, :prepend, ${} expansion, :remove.
//   Final value - the value as coloured segments, one colour per file; hover or
//                 focus a segment to light its line, removed words struck out.
//   OVERRIDES   - chips in priority order; click one to switch it off or on
//                 (and the overrides the lines use but OVERRIDES lacks, to try).
// Everything drawn comes from run()'s result.eval.

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const OPS = {
  '=': ['set', 'assigns now (lazy: ${} stays until read)'],
  '?=': ['default', 'assigns only if nothing has set it yet (checked now)'],
  '??=': ['weak', 'weak default: used only if nothing else ever sets it'],
  ':=': ['immediate', 'expands ${} now, with the values known at this line'],
  '+=': ['append', 'appends with a space now (ignores ??= defaults)'],
  '=+': ['prepend', 'prepends with a space now'],
  '.=': ['append', 'appends without a space now'],
  '=.': ['prepend', 'prepends without a space now'],
};
const STATUS = {
  applied: ['applied', 'ok'], queued: ['queued', 'q'], skipped: ['skipped', 'warn'], error: ['fatal', 'bad'],
  shadowed: ['unused', 'soft'], unparsed: ['unparsed', 'bad'], flag: ['flag', 'soft'], function: ['function', 'soft'],
  'not followed': ['directive', 'soft'],
};
const short = (f) => f.split('/').slice(-1)[0];
const LS = 'redline.tool.bitbake-vars.ui';
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { return {}; } };
const save = (o) => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch { /* private window */ } };

export function page(root, ctx) {
  const ui = { showAll: false, ...load() };
  let res = null, E = null, sel = -1;

  // ---------- evaluation card ----------
  const title = h('div', { class: 'bv-title' });
  const varInput = h('input', { type: 'text', class: 'bv-varin', spellcheck: 'false', 'aria-label': 'Variable to resolve', list: 'bv-vars',
    onchange: (e) => ctx.set('var', e.target.value.trim()) });
  const varList = h('datalist', { id: 'bv-vars' });
  const varChips = h('div', { class: 'bv-chips', role: 'group', 'aria-label': 'Variables in the lines' });
  const ovChips = h('div', { class: 'bv-chips bv-ov', role: 'group', 'aria-label': 'OVERRIDES' });
  const ovMore = h('button', { class: 'bv-link', onclick: () => { ui.showAll = !ui.showAll; save(ui); draw(); } });
  const ctxFields = {};
  const field = (key, label, cls) => {
    const el = h('input', { type: 'text', spellcheck: 'false', class: cls || null, 'aria-label': label,
      onchange: (e) => ctx.set(key, e.target.value) });
    ctxFields[key] = el;
    return h('label', { class: 'bv-f' }, h('span', {}, label), el);
  };
  const ctxRow = h('div', { class: 'bv-ctx' }, field('machine', 'MACHINE'), field('distro', 'DISTRO'), field('pn', 'PN'),
    field('overrides', 'OVERRIDES (later = higher priority)', 'long'));
  const ctxBox = h('details', { class: 'bv-more' }, h('summary', {}, 'MACHINE, DISTRO, PN and the OVERRIDES string'), ctxRow);
  const parseRows = h('div', { class: 'bv-rows', role: 'list' });
  const readRows = h('div', { class: 'bv-rows', role: 'list' });
  const readHead = h('div', { class: 'bv-sec' });
  const finalBox = h('div', { class: 'bv-final', 'aria-live': 'polite' });
  const findings = h('div', { class: 'bv-find' });
  const evalCard = h('section', { class: 'bv-card bv-eval' },
    h('div', { class: 'bv-head' }, title),
    h('div', { class: 'bv-bar' }, h('span', { class: 'bv-lbl' }, 'Variable'), varInput, varList, varChips),
    h('div', { class: 'bv-bar' }, h('span', { class: 'bv-lbl', title: 'Rightmost has the highest priority' }, 'OVERRIDES', h('small', {}, 'low → high')), ovChips, ovMore),
    ctxBox,
    h('div', { class: 'bv-sec' }, h('b', {}, '1'), h('span', {}, 'Parse: each line, in order, as it is read')),
    h('div', { class: 'bv-colhead' }, h('span', {}, 'where'), h('span', {}, 'line'), h('span', {}, 'effect'), h('span', {}, 'value right after')),
    parseRows,
    readHead, readRows,
    finalBox, findings);

  // ---------- source editor ----------
  const gut = h('div', { class: 'bv-gut', 'aria-hidden': 'true' });
  const hl = h('pre', { class: 'bv-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'bv-ta', spellcheck: 'false', wrap: 'off', 'aria-label': 'Lines in parse order',
    oninput: () => { ctx.set('text', ta.value); }, onscroll: () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gut.scrollTop = ta.scrollTop; } });
  ta.addEventListener('click', () => pickFromCaret());
  ta.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') pickFromCaret(); });
  const srcHelp = h('div', { class: 'bv-help' }, 'Paste in parse order (local.conf, machine, distro, recipe, bbappends). Mark files with ', h('code', {}, '# file: path'),
    ' or paste ', h('code', {}, 'grep -rn VAR'), ' output. Click a line number to resolve that variable.');
  const srcCard = h('section', { class: 'bv-card bv-src' },
    h('div', { class: 'bv-head' }, h('h2', {}, 'Source'), h('span', { class: 'bv-sub', id: 'bv-files' })),
    h('div', { class: 'bv-ed' }, gut, h('div', { class: 'bv-wrap' }, hl, ta)), srcHelp);

  // The gutter is as tall as the textarea, whatever size it is dragged to.
  try { new ResizeObserver(() => { gut.style.height = ta.offsetHeight + 'px'; }).observe(ta); } catch { /* old browser */ }
  const left = h('div', { class: 'bv-col bv-left' }, srcCard, h('div', { class: 'bv-outs' }, ctx.outputs));
  root.append(h('div', { class: 'bv' }, h('div', { class: 'bv-col bv-right' }, evalCard), left));

  // ---------- helpers ----------
  const fileCls = (sid) => {
    if (sid === -2) return 'fx';
    const st = E && E.stmts[sid];
    return st ? `f${st.fi % 6}` : 'fx';
  };
  const where = (st) => h('span', { class: `bv-where ${fileCls(st.id)}`, title: `${st.file}:${st.line}` }, h('i'), h('span', { class: 'fn' }, short(st.file)), h('span', { class: 'ln' }, `:${st.line}`));

  // A value as segments; ${X} still unexpanded drawn as a lazy reference.
  const valueEl = (segs, { big = false, removed = null } = {}) => {
    const box = h('span', { class: `bv-val${big ? ' big' : ''}` });
    if (!segs) { box.append(h('em', { class: 'unset' }, 'not set')); return box; }
    if (!segs.length) { box.append(h('em', { class: 'unset' }, '""')); return box; }
    for (const g of segs) {
      const parts = g.t.split(/(\$\{[^}]*\})/);
      for (const p of parts) {
        if (!p) continue;
        const lazy = /^\$\{/.test(p);
        const st = E.stmts[g.s];
        const tip = g.s === -2 ? 'from the tool inputs' : st ? `${st.file}:${st.line}${g.k ? ` via \${${g.k}}` : ''}\n${st.text}` : '';
        const el = h('span', { role: big ? 'button' : null, tabindex: big ? '0' : null, class: `seg ${fileCls(g.s)}${lazy ? ' lazy' : ''}${g.s === sel || g.r === sel ? ' on' : ''}`,
          'data-s': g.s, 'data-r': g.r, title: tip }, p);
        if (big) {
          el.addEventListener('mouseenter', () => mark(g.s, g.r));
          el.addEventListener('mouseleave', () => mark(sel));
          el.addEventListener('focus', () => mark(g.s, g.r));
          el.addEventListener('blur', () => mark(sel));
          el.addEventListener('click', () => select(g.s, true));
          el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(g.s, true); } });
        }
        box.append(el);
      }
    }
    if (removed && removed.length) {
      for (const r of removed) {
        const st = E.stmts[r.by];
        box.append(h('del', { class: `seg gone ${fileCls(r.by)}`, 'data-s': r.by, title: st ? `removed by ${st.file}:${st.line}` : 'removed' }, r.word));
      }
    }
    return box;
  };

  // The statement, with its name split into variable, overrides and keyword.
  const stmtEl = (st) => {
    const out = h('code', { class: 'bv-stmt' });
    const key = st.ekey || st.key;
    const parts = key.split(':');
    out.append(h('b', {}, parts[0]));
    for (const p of parts.slice(1)) {
      if (['append', 'prepend', 'remove'].includes(p)) out.append(h('span', { class: 'kw' }, ':' + p));
      else {
        const on = E.overrides.includes(p);
        out.append(h('span', { class: `ov ${on ? 'on' : 'off'}`, title: on ? `${p} is in OVERRIDES` : `${p} is not in OVERRIDES` }, ':' + p));
      }
    }
    const op = OPS[st.op];
    out.append(' ', h('span', { class: 'op', title: op ? op[1] : '' }, st.op), ' ');
    const v = h('span', { class: 'str' }, '"');
    for (const p of st.value.split(/(\$\{[^}]*\})/)) if (p) v.append(/^\$\{/.test(p) ? h('span', { class: 'ref' }, p) : p);
    v.append('"');
    out.append(v);
    return out;
  };

  const pill = (text, tone, tip) => h('span', { class: `bv-pill ${tone}`, title: tip || null }, text);

  // ---------- fixes: rewrite a source line ----------
  const rewrite = (st, fn) => {
    const lines = ta.value.split('\n');
    const row = st.row;
    if (row < 0 || row >= lines.length) return;
    const next = fn(lines[row]);
    if (next == null || next === lines[row]) return;
    lines[row] = next;
    ta.value = lines.join('\n');
    ctx.set('text', ta.value);
  };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fixFor = (st) => {
    if (st.trapBy) {
      const by = E.stmts[st.trapBy];
      return { label: `Make line ${by.line} an :append`, run: () => rewrite(by, (l) => l.replace(new RegExp(`${esc(by.key)}\\s*\\+=\\s*(["'])\\s*`), `${by.key}:append = $1 `)) };
    }
    if (st.glue) return { label: 'Add the leading space', run: () => rewrite(st, (l) => l.replace(/(:append[^=]*?=\s*)(["'])(?=\S)/, '$1$2 ').replace(/(:prepend[^=]*?=\s*)(["'])([^"']*?\S)(\2)/, '$1$2$3 $4')) };
    if (st.status === 'error') return { label: 'Convert to : syntax', run: () => rewrite(st, (l) => l.replace(st.key, st.key.replace(/_(append|prepend|remove)/g, ':$1'))) };
    return null;
  };

  // ---------- selection ----------
  // Light one statement everywhere: its segments, its rows and its source
  // lines (and, for text pulled in by ${X}, the line that referenced it).
  function mark(sid, rid = -1) {
    const hit = (n) => n >= 0 && (n === sid || n === rid);
    for (const el of root.querySelectorAll('.seg')) el.classList.toggle('on', sid >= 0 && Number(el.dataset.s) === sid);
    for (const el of root.querySelectorAll('.bv-row')) el.classList.toggle('lit', hit(Number(el.dataset.s)));
    finalBox.classList.toggle('focus', sid >= 0);
    const lines = hl.children;
    for (const el of lines) el.classList.remove('hot');
    for (const n of [sid, rid]) {
      const st = n >= 0 && E && E.stmts[n];
      if (st) for (let r = st.row; r <= st.rowEnd; r++) lines[r]?.classList.add('hot');
    }
  }
  function select(sid, reveal) {
    sel = sid;
    mark(sid);
    drawOverlay();
    if (reveal && E.stmts[sid]) {
      const row = root.querySelector(`.bv-row[data-s="${sid}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
      const st = E.stmts[sid];
      ta.scrollTop = Math.max(0, st.row * 20 - ta.clientHeight / 2);
    }
  }
  function pickFromCaret() {
    if (!E) return;
    const row = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
    const st = E.stmts.find((s) => row >= s.row && row <= s.rowEnd);
    if (st && st.rel) select(st.id, false);
  }

  // ---------- drawing ----------
  const row = (st, cells, extra = '') => {
    const el = h('div', { class: `bv-row ${extra}`, role: 'listitem', tabindex: '0', 'data-s': st ? st.id : -1 }, ...cells);
    if (st) {
      el.addEventListener('click', () => select(st.id, true));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const all = [...root.querySelectorAll('.bv-row[tabindex]')];
          const i = all.indexOf(el);
          const nx = all[i + (e.key === 'ArrowDown' ? 1 : -1)];
          if (nx) nx.focus();
        } else if (e.key === 'Enter') {
          select(st.id, true);
          const lines = ta.value.split('\n');
          let pos = 0; for (let i = 0; i < st.row; i++) pos += lines[i].length + 1;
          ta.focus(); ta.setSelectionRange(pos, pos + (lines[st.row] || '').length);
        }
      });
      el.addEventListener('focus', () => select(st.id, false));
    }
    return el;
  };

  function draw() {
    if (!res || !res.eval) return;
    E = res.eval;
    const raw = ctx.raw;
    if (document.activeElement !== varInput) varInput.value = raw.var || '';
    for (const [k, el] of Object.entries(ctxFields)) if (document.activeElement !== el) el.value = raw[k] ?? '';
    if (document.activeElement !== ta && ta.value !== raw.text) ta.value = raw.text ?? '';

    // Title: the variable and its final value in one line.
    title.replaceChildren(h('h2', {}, E.focus || 'No variable'),
      h('span', { class: 'bv-sub' }, E.finalNull ? 'not set' : `${(E.final || []).map((g) => g.t).join('').trim().split(/\s+/).filter(Boolean).length} words`,
        res.warnings?.length ? h('b', { class: 'warn' }, ` · ${res.warnings.length} finding${res.warnings.length > 1 ? 's' : ''}`) : null));

    // Variable chips
    varList.replaceChildren(...E.vars.map((v) => h('option', { value: v.name })));
    varChips.replaceChildren(...E.vars.slice(0, 14).map((v) => h('button', { class: 'bv-chip', 'aria-pressed': String(v.name === E.focus),
      onclick: () => ctx.set('var', v.name), title: `${v.count} line${v.count > 1 ? 's' : ''}` }, v.name, h('small', {}, String(v.count)))));

    // OVERRIDES chips: those the lines use first-class; the rest behind "all".
    const off = new Set(String(raw.off || '').split(/[:\s,]+/).filter(Boolean));
    const add = String(raw.add || '').split(/[:\s,]+/).filter(Boolean);
    const shown = E.chips.filter((c) => ui.showAll || c.used || !c.on || c.added);
    ovChips.replaceChildren(...shown.map((c) => {
      const tip = c.inList ? (c.on ? `${c.name}: active. Click to switch it off.` : `${c.name}: switched off. Click to restore.`)
        : (c.on ? `${c.name}: added for a what-if. Click to take it out.` : `${c.name}: used by the lines but not in OVERRIDES. Click to try it.`);
      return h('button', { class: `bv-chip ov ${c.on ? 'on' : 'off'}${c.inList ? '' : ' extra'}${c.used ? ' used' : ''}`, 'aria-pressed': String(c.on), title: tip,
        onclick: () => {
          if (c.inList) { if (off.has(c.name)) off.delete(c.name); else off.add(c.name); ctx.set('off', [...off].join(':')); }
          else { const i = add.indexOf(c.name); if (i >= 0) add.splice(i, 1); else add.push(c.name); ctx.set('add', add.join(':')); }
        } }, c.name);
    }));
    const hidden = E.chips.length - shown.length;
    ovMore.textContent = ui.showAll ? 'only the ones used' : hidden ? `+${hidden} more` : '';
    ovMore.hidden = !ui.showAll && !hidden;

    // 1. Parse rows
    const rel = E.stmts.filter((s) => s.rel);
    parseRows.replaceChildren(...(rel.length ? rel.map((st) => {
      const [label, tone] = STATUS[st.status] || [st.status, 'soft'];
      const op = OPS[st.op];
      const effect = h('div', { class: 'bv-eff' },
        pill(label, tone, st.note),
        st.status === 'queued' ? h('span', { class: 'why' }, st.queued, st.cond ? h('span', { class: `ov ${st.cond.split(':').every((c) => E.overrides.includes(c)) ? 'on' : 'off'}` }, `[${st.cond}]`) : null, ' at read time')
          : st.status === 'applied' ? h('span', { class: 'why' }, op ? op[0] : st.op, st.ekey !== E.focus ? h('span', { class: 'ov' }, ' as variant ' + st.ekey.slice(E.focus.length + 1)) : null, st.immediate ? ' (expanded now)' : '')
            : h('span', { class: 'why' }, st.note));
      const after = st.status === 'queued' ? h('span', { class: 'bv-q' }, st.queued === ':remove' ? '− ' : '+ ', valueEl(st.after)) : valueEl(st.after);
      const flags = [st.trap ? 'trap' : '', st.glue ? 'glue' : '', st.status === 'error' ? 'err' : ''].filter(Boolean).join(' ');
      return row(st, [where(st), stmtEl(st), effect, h('div', { class: 'bv-after' }, after)], flags);
    }) : [h('div', { class: 'bv-empty' }, `No line assigns ${E.focus}.`)]));

    // 2. getVar steps
    readHead.replaceChildren(h('b', {}, '2'), h('span', {}, 'getVar(', h('code', {}, E.focus), '): what happens when the value is used'));
    const steps = [];
    for (const t of E.steps) {
      if (t.step === 'override') {
        const cands = h('span', { class: 'bv-cands' }, ...t.candidates.map((c) => h('span', { class: `ov ${c.var === t.chosen ? 'win' : c.active ? 'on' : 'off'}`, title: c.active ? 'override active' : 'override not in OVERRIDES' }, c.var)));
        steps.push(row(null, [h('span', { class: 'bv-where fx' }, h('i'), 'override'), h('div', { class: 'bv-stmt' }, 'variants: ', cands),
          h('div', { class: 'bv-eff' }, pill(t.chosen ? 'replaced' : 'none active', t.chosen ? 'q' : 'soft'), h('span', { class: 'why' }, t.chosen ? `${t.chosen} replaces the base value` : 'the base value stays')), h('div')], 'step'));
      } else if (t.step === 'base') {
        const st = E.stmts[t.sid];
        steps.push(row(st || null, [st ? where(st) : h('span', { class: 'bv-where fx' }, h('i'), t.sid === -2 ? 'input' : 'start'),
          h('div', { class: 'bv-stmt' }, t.v ? `start from ${t.from}${t.weak ? ' (weak default)' : ''}` : `${t.from} has no value of its own`),
          h('div', { class: 'bv-eff' }, pill('start', 'soft')), h('div', { class: 'bv-after' }, valueEl(t.v))], 'step'));
      } else if (t.step === 'expand') {
        steps.push(row(null, [h('span', { class: 'bv-where fx' }, h('i'), 'expand'),
          h('div', { class: 'bv-stmt' }, ...t.refs.map((r) => h('button', { class: 'bv-ref', title: r.value == null ? 'not set in the pasted lines' : `= "${r.value}"`, onclick: () => ctx.set('var', r.name) }, '${' + r.name + '}', h('small', {}, r.value == null ? ' unset' : ` → ${r.value.length > 28 ? r.value.slice(0, 26) + '…' : r.value}`)))),
          h('div', { class: 'bv-eff' }, pill('expanded', 'ok')), h('div', { class: 'bv-after' }, valueEl(t.v))], 'step'));
      } else {
        const st = E.stmts[t.sid];
        const label = t.applied ? (t.step === 'remove' ? (t.removed.length ? `removed ${t.removed.length}` : 'no match') : 'applied') : 'skipped';
        const tone = t.applied ? (t.step === 'remove' && !t.removed.length ? 'warn' : 'ok') : 'soft';
        const why = t.applied ? (t.step === 'remove' ? (t.removed.length ? t.removed.join(' ') : `none of: ${t.words.join(' ')}`) : t.glue ? 'no leading space: words glued' : t.step)
          : `${t.cond} not in OVERRIDES`;
        steps.push(row(st, [where(st), stmtEl(st), h('div', { class: 'bv-eff' }, pill(label, tone), h('span', { class: `why${t.glue ? ' warn' : ''}` }, why)),
          h('div', { class: 'bv-after' }, t.applied ? valueEl(t.v) : h('span', { class: 'bv-same' }, 'unchanged'))], `step${t.applied ? '' : ' dim'}${t.glue ? ' glue' : ''}`));
      }
    }
    readRows.replaceChildren(...steps);

    // Final value
    const legend = E.files.map((f, i) => h('span', { class: `lg f${i % 6}` }, h('i'), short(f)));
    finalBox.replaceChildren(
      h('div', { class: 'bv-fhead' }, h('span', {}, 'Final value of ', h('code', {}, E.focus)), h('span', { class: 'bv-legend' }, ...legend)),
      h('div', { class: 'bv-fline' }, h('code', { class: 'eq' }, `${E.focus} = "`), valueEl(E.final, { big: true, removed: E.removed }), h('code', { class: 'eq' }, '"')));

    // Findings, with their fixes.
    for (const s of E.stmts) if (s.trap && s.by >= 0) s.trapBy = s.by;
    const usedFix = new Set();
    const items = (res.warnings || []).map((w) => {
      const st = E.stmts.find((s) => (s.trap || s.glue || s.status === 'error') && w.startsWith(`${s.file}:${s.line} `));
      let fx = st ? fixFor(st) : null;
      if (fx && usedFix.has(fx.label)) fx = null; else if (fx) usedFix.add(fx.label);
      return h('div', { class: 'w' }, h('span', { class: 'ic warn' }, '!'), h('span', { class: 'tx' }, w),
        st ? h('button', { class: 'k-btn', onclick: () => select(st.id, true) }, 'Show') : null,
        fx ? h('button', { class: 'k-btn k-primary', onclick: fx.run }, fx.label) : null);
    });
    const notes = (res.notes || []).map((n) => h('div', { class: 'n' }, h('span', { class: 'ic' }, 'i'), h('span', { class: 'tx' }, n)));
    findings.replaceChildren(...items, ...notes);
    findings.hidden = !items.length && !notes.length;

    document.getElementById('bv-files').textContent = `${E.files.length} file${E.files.length === 1 ? '' : 's'} · ${E.stmts.filter((s) => s.kind === 'assign').length} assignments`;
    drawOverlay();
    if (sel >= 0 && !E.stmts[sel]?.rel) sel = -1;
    mark(sel);
  }

  function drawOverlay() {
    if (!E) return;
    const lines = (ta.value || '').split('\n');
    const byRow = new Map();
    for (const st of E.stmts) for (let r = st.row; r <= st.rowEnd; r++) byRow.set(r, st);
    gut.replaceChildren(...lines.map((_, i) => {
      const st = byRow.get(i);
      const assign = st && (st.kind === 'assign' || st.kind === 'flag') && st.base;
      const tone = st ? (st.status === 'error' || st.status === 'unparsed' ? 'bad' : st.trap || st.glue || st.status === 'skipped' ? 'warn' : st.rel ? 'rel' : '') : '';
      const d = h('div', { class: `${assign ? 'var' : ''} ${tone} ${st && st.rel ? fileCls(st.id) : ''}${st && st.id === sel ? ' sel' : ''}`,
        title: assign ? `resolve ${st.base}` : null }, h('i'), String(i + 1));
      if (assign) d.addEventListener('click', () => ctx.set('var', st.base));
      return d;
    }));
    hl.replaceChildren(...lines.map((l, i) => {
      const st = byRow.get(i);
      return h('span', { class: `ln${st && st.rel ? ' rel' : ''}${st && st.id === sel ? ' sel' : ''}${st && (st.status === 'unparsed' || st.status === 'error') ? ' bad' : ''}` }, l || ' ', '\n');
    }));
  }

  ctx.onResult((r) => { res = r; draw(); });
}
