// Naming Convention Enforcer: the page is the rename map.
//   Rule     - the case rules as specimen cards: each shows a name from the
//              list written that way and how many of the names would pass
//              under it (run() tries every rule). Click one to switch.
//   Names    - every name as a strip of type, grouped by kind, with the
//              characters that break a rule marked where they are. A line
//              runs from each failing name to its suggested name; names that
//              differ only in case or separators run into one target, folded
//              together. Click a suggestion to apply it (the source line is
//              rewritten), "Apply all" for every one. Click a name to edit it.
//              The character ruler on top carries the length limit: drag its
//              handle (or arrow keys on it) and the over-long tails light up.
//   Source   - the pasted list itself, and the rename map output.
// Every verdict, span, suggestion, group and count comes from run()'s result.

const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  return el;
};
const KINDS = [['auto', 'Mixed'], ['net', 'Nets'], ['refdes', 'Ref. des.'], ['part', 'Parts'], ['file', 'Files']];
const KIND_TITLE = { net: 'Nets', refdes: 'Reference designators', part: 'Library parts / symbols', file: 'Files' };
const PREFIX_RE = /^(net|ref|refdes|symbol|part|file)\s*:\s*/i;

function glyph(kind) {
  const s = sv('svg', { viewBox: '0 0 20 20', class: `ne-glyph ne-g-${kind}`, 'aria-hidden': 'true' });
  const p = (d) => s.append(sv('path', { d }));
  if (kind === 'net') { p('M2,10 H18'); s.append(sv('circle', { cx: 4, cy: 10, r: 2.2 }), sv('circle', { cx: 16, cy: 10, r: 2.2 })); }
  else if (kind === 'refdes') p('M1,10 H4 L5.5,6 L8,14 L10.5,6 L13,14 L15.5,6 L16.5,10 H19');
  else if (kind === 'part') { s.append(sv('rect', { x: 5, y: 3, width: 10, height: 14, rx: 1 })); p('M2,6 H5 M2,10 H5 M2,14 H5 M15,6 H18 M15,10 H18 M15,14 H18'); }
  else { p('M5,2 H12 L16,6 V18 H5 Z M12,2 V6 H16'); }
  return s;
}

export function page(root, ctx) {
  const st = { showPass: true, edit: null, cw: 8.4 };
  const R = () => ctx.result || {};
  const lines = () => String(ctx.raw.names ?? '').split(/\r?\n/);
  const setLines = (ls) => ctx.set('names', ls.join('\n'));

  // ---------- skeleton ----------
  const cards = h('div', { class: 'ne-cards', role: 'radiogroup', 'aria-label': 'Case rule' });
  const kindSeg = h('div', { class: 'ne-seg', role: 'group', 'aria-label': 'These names are' });
  const prefIn = h('input', { type: 'text', class: 'ne-in', placeholder: 'any', spellcheck: 'false', 'aria-label': 'Allowed prefixes' });
  prefIn.addEventListener('change', () => ctx.set('prefixes', prefIn.value));
  prefIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') ctx.set('prefixes', prefIn.value); });
  const lenIn = h('input', { type: 'text', inputmode: 'numeric', class: 'ne-in ne-num', spellcheck: 'false', 'aria-label': 'Max length in characters, 0 = no limit' });
  lenIn.addEventListener('change', () => ctx.set('maxlen', lenIn.value));
  const rulePanel = h('section', { class: 'ne-panel ne-rulep' },
    h('div', { class: 'ne-head' }, h('h2', {}, 'Case rule'), h('span', { class: 'ne-sub' }, 'the names below written in each style, and how many would pass')),
    cards,
    h('div', { class: 'ne-opts' },
      h('span', { class: 'ne-lbl' }, 'The names are'), kindSeg,
      h('label', { class: 'ne-lbl' }, 'Allowed prefixes', prefIn),
      h('label', { class: 'ne-lbl' }, 'Max length', lenIn, h('span', {}, 'chars (0 = none)'))));

  const score = h('div', { class: 'ne-score', 'aria-live': 'polite' });
  const passBtn = h('button', { type: 'button', class: 'k-btn', 'aria-pressed': 'true', onclick: () => { st.showPass = !st.showPass; render(); } });
  const allBtn = h('button', { type: 'button', class: 'k-btn k-primary', onclick: () => applyAll() });
  const rulerEl = h('div', { class: 'ne-ruler' });
  const handle = h('div', { class: 'ne-handle', tabindex: '0', role: 'slider', 'aria-label': 'Length limit', 'aria-valuemin': '0', 'aria-valuemax': '200' });
  const body = h('div', { class: 'ne-body' });
  const over = sv('svg', { class: 'ne-over', 'aria-hidden': 'true' });
  const probe = h('span', { class: 'ne-probe', 'aria-hidden': 'true' }, 'MMMMMMMMMM');
  const addIn = h('input', { type: 'text', class: 'ne-in ne-addin', placeholder: 'Add a name (net:, ref:, part: or file: to say its kind) and press Enter', spellcheck: 'false' });
  addIn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !addIn.value.trim()) return;
    const ls = lines(); while (ls.length && !ls[ls.length - 1].trim()) ls.pop();
    ls.push(addIn.value.trim()); addIn.value = ''; setLines(ls);
  });
  const mapPanel = h('section', { class: 'ne-panel ne-mapp' },
    h('div', { class: 'ne-head' }, h('h2', {}, 'Names'), score, h('span', { class: 'ne-grow' }), passBtn, allBtn),
    h('div', { class: 'ne-mapwrap' }, h('div', { class: 'ne-rulerrow' }, h('span', {}), h('div', { class: 'ne-rulerbox' }, rulerEl, handle)), body, over, probe),
    h('div', { class: 'ne-foot' }, addIn));

  const src = h('textarea', { class: 'ne-src', spellcheck: 'false', rows: 14, 'aria-label': 'Names, one per line' });
  src.addEventListener('input', () => ctx.set('names', src.value));
  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const auto = h('div', { class: 'ne-auto' });
  const side = h('div', { class: 'ne-side' },
    h('section', { class: 'ne-panel' }, h('div', { class: 'ne-head' }, h('h2', {}, 'Source list'), h('span', { class: 'ne-sub' }, 'one name per line; # comments')), h('div', { class: 'ne-srcwrap' }, src), auto),
    warns, ctx.outputs);

  root.append(h('div', { class: 'ne' }, rulePanel, h('div', { class: 'ne-work' }, mapPanel, side)));

  // ---------- edits ----------
  function rewrite(ls, n, raw, kind, to) {
    const i = n.line - 1; const was = ls[i]; if (was == null) return;
    const pre = PREFIX_RE.exec(was.trim());
    if (pre) { ls[i] = pre[0] + to; return; }
    // Hierarchical net: only its last part is the name.
    if (kind === 'net' && raw.includes('/') && !to.includes('/')) to = raw.slice(0, raw.lastIndexOf('/') + 1) + to;
    const t = was.trim();
    if (t !== raw && t.startsWith(raw)) { ls[i] = was.replace(raw, to); return; } // a pasted table row: first cell only
    ls[i] = to;
  }
  const targetOf = (members) => { const p = members.find((m) => !m.fix && !m.problems.some((x) => !/^clashes with|^duplicate/.test(x))); return p ? p.raw : (members.find((m) => m.fix)?.fix || members[0].raw); };
  function apply(n, to) { const ls = lines(); rewrite(ls, n, n.raw, n.kind, to); setLines(ls); }
  function merge(members, to) {
    const ls = lines();
    const [first, ...rest] = members.slice().sort((a, b) => a.line - b.line);
    rewrite(ls, first, first.raw, first.kind, to);
    for (const m of rest.sort((a, b) => b.line - a.line)) ls.splice(m.line - 1, 1);   // folded into the first
    setLines(ls);
  }
  function applyAll() {
    const names = R().names || [];
    const ls = lines(); const drop = [];
    const groups = new Map();
    for (const n of names) if (n.group != null) { if (!groups.has(n.group)) groups.set(n.group, []); groups.get(n.group).push(n); }
    for (const n of names) if (n.group == null && n.fix) rewrite(ls, n, n.raw, n.kind, n.fix);
    for (const g of groups.values()) {
      const [first, ...rest] = g.slice().sort((a, b) => a.line - b.line);
      rewrite(ls, first, first.raw, first.kind, targetOf(g));
      drop.push(...rest.map((m) => m.line - 1));
    }
    for (const i of drop.sort((a, b) => b - a)) ls.splice(i, 1);
    setLines(ls);
  }

  // ---------- drawing ----------
  function tape(n) {
    const kids = []; let at = 0;
    for (const [s, e, why] of n.spans) {
      if (s < at) continue;
      kids.push(n.raw.slice(at, s));
      const seg = n.raw.slice(s, e).replace(/ /g, '␣');
      kids.push(h('mark', { class: `ne-bad${why === 'over the length limit' ? ' ne-long' : ''}`, title: why }, seg));
      at = e;
    }
    kids.push(n.raw.slice(at));
    return kids;
  }
  function rowEl(n, members) {
    const fail = n.problems.length > 0;
    const first = !members || members[0] === n;
    const row = h('div', { class: `ne-row${fail ? ' ne-fail' : ' ne-pass'}${members ? ' ne-grp' : ''}`, 'data-line': n.line });
    let left;
    if (st.edit === n.line) {
      left = h('input', { type: 'text', class: 'ne-in ne-edit', spellcheck: 'false', 'aria-label': `Edit line ${n.line}` });
      left.value = n.raw;
      const commit = () => { st.edit = null; if (left.value !== n.raw) apply(n, left.value.trim()); else render(); };
      left.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { st.edit = null; render(); } });
      left.addEventListener('blur', commit);
    } else {
      left = h('button', { type: 'button', class: 'ne-tape', title: `line ${n.line}: click to edit`, onclick: () => { st.edit = n.line; render(); body.querySelector('.ne-edit')?.focus(); } }, h('span', { class: 'ne-t' }, ...tape(n)));
    }
    const probs = fail ? h('div', { class: 'ne-probs' }, n.problems.join('; ')) : null;
    let target;
    if (members) {
      target = first ? h('div', { class: 'ne-target' },
        h('button', { type: 'button', class: 'ne-fix', title: `Merge ${members.map((m) => m.raw).join(', ')} into one name`, onclick: () => merge(members, targetOf(members)) },
          h('span', { class: 'ne-t' }, targetOf(members)), h('small', {}, `fold ${members.length} into one`))) : h('div', { class: 'ne-target' });
    } else if (fail && n.fix) {
      target = h('div', { class: 'ne-target' }, h('button', { type: 'button', class: 'ne-fix', title: 'Apply this rename to the source line', onclick: () => apply(n, n.fix) },
        h('span', { class: 'ne-t' }, n.fix), h('small', {}, 'apply')));
    } else if (fail) target = h('div', { class: 'ne-target' }, h('span', { class: 'ne-nosug' }, 'no suggestion: rename by hand'));
    else target = h('div', { class: 'ne-target' }, h('span', { class: 'ne-ok' }, 'passes'));
    row.append(h('span', { class: 'ne-line' }, String(n.line)), glyph(n.kind), h('div', { class: 'ne-left' }, left, probs), h('div', { class: 'ne-mid' }), target);
    return row;
  }

  function drawBody() {
    const r = R(); const names = r.names || [];
    const kids = [];
    for (const kind of ['net', 'refdes', 'part', 'file']) {
      const all = names.filter((n) => n.kind === kind);
      if (!all.length) continue;
      const bad = all.filter((n) => n.problems.length).length;
      const pct = (100 * (all.length - bad)) / all.length;
      kids.push(h('div', { class: 'ne-sec' }, glyph(kind), h('b', {}, KIND_TITLE[kind]),
        h('span', { class: 'ne-sub' }, `${all.length - bad} of ${all.length} pass`),
        h('span', { class: 'ne-bar', role: 'img', 'aria-label': `${Math.round(pct)} % pass` }, h('i', { style: `width:${pct}%` })),
        kind === 'refdes' ? h('span', { class: 'ne-sub' }, 'IEEE 315 class letters; the case rule does not apply') : null));
      // Rows in line order, each clash group pulled together at its first member.
      const done = new Set();
      for (const n of all) {
        if (done.has(n)) continue;
        if (n.group != null) {
          const g = names.filter((m) => m.group === n.group);
          g.forEach((m) => done.add(m));
          for (const m of g) kids.push(rowEl(m, g));
        } else {
          done.add(n);
          if (!st.showPass && !n.problems.length) continue;
          kids.push(rowEl(n, null));
        }
      }
    }
    if (!names.length) kids.push(h('div', { class: 'ne-empty' }, 'No names yet: paste a list into Source list, or add one below.'));
    body.replaceChildren(...kids);
    requestAnimationFrame(drawOver);
  }

  // Connectors, the length limit and the ruler, measured from the laid-out rows.
  function drawOver() {
    const wrap = over.parentElement; const wb = wrap.getBoundingClientRect();
    over.setAttribute('width', wb.width); over.setAttribute('height', wb.height);
    over.setAttribute('viewBox', `0 0 ${wb.width} ${wb.height}`);
    over.replaceChildren();
    st.cw = probe.getBoundingClientRect().width / 10 || 8.4;
    const firstTape = body.querySelector('.ne-left');
    const x0 = firstTape ? firstTape.getBoundingClientRect().left - wb.left + 7 : 60;
    const groupTarget = new Map();
    const rows = [...body.querySelectorAll('.ne-row')];
    for (const row of rows) {
      const fix = row.querySelector('.ne-fix');
      if (fix && row.classList.contains('ne-grp')) groupTarget.set(row, fix);
    }
    let lastFix = null;
    for (const row of rows) {
      if (!row.classList.contains('ne-fail')) continue;
      const t = row.querySelector('.ne-t') || row.querySelector('.ne-edit'); if (!t) continue;
      let fix = row.querySelector('.ne-fix');
      if (row.classList.contains('ne-grp')) { if (fix) lastFix = fix; else fix = lastFix; }
      if (!fix) continue;
      const a = t.getBoundingClientRect(), b = fix.getBoundingClientRect();
      const x1 = a.right - wb.left + 6, y1 = a.top - wb.top + a.height / 2;
      const x2 = b.left - wb.left - 4, y2 = b.top - wb.top + 13;
      if (x2 - x1 < 8) continue;
      const mx = (x1 + x2) / 2;
      over.append(sv('path', { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, class: `ne-link${row.classList.contains('ne-grp') ? ' ne-link-grp' : ''}` }),
        sv('path', { d: `M${x2 - 5},${y2 - 4} L${x2},${y2} L${x2 - 5},${y2 + 4}`, class: `ne-link${row.classList.contains('ne-grp') ? ' ne-link-grp' : ''}` }));
    }
    // Ruler and length limit.
    const box = rulerEl.parentElement; const bb = box.getBoundingClientRect();
    const rx0 = x0 - (bb.left - wb.left);
    const maxChars = Math.max(10, Math.floor((bb.width - rx0) / st.cw));
    const ticks = [];
    for (let i = 0; i <= maxChars; i++) {
      const major = i % 8 === 0;
      if (i % 4 && !major) continue;
      ticks.push(h('span', { class: `ne-tick${major ? ' ne-major' : ''}`, style: `left:${rx0 + i * st.cw}px` }, major ? String(i) : ''));
    }
    rulerEl.replaceChildren(...ticks);
    const ml = +(ctx.input.maxlen) > 0 ? Math.round(+ctx.input.maxlen) : 0;
    handle.style.left = `${rx0 + (ml || 0) * st.cw}px`;
    handle.textContent = ml ? String(ml) : 'no limit';
    handle.classList.toggle('ne-off', !ml);
    handle.setAttribute('aria-valuenow', String(ml));
    handle.setAttribute('aria-valuetext', ml ? `${ml} characters` : 'no limit');
    if (ml) {
      const x = x0 + ml * st.cw;
      const top = box.getBoundingClientRect().bottom - wb.top;
      over.append(sv('rect', { x, y: top, width: Math.max(0, wb.width - x), height: body.getBoundingClientRect().bottom - wb.top - top, class: 'ne-overlen' }),
        sv('path', { d: `M${x},${top} V${body.getBoundingClientRect().bottom - wb.top}`, class: 'ne-limit' }));
    }
    st.x0 = x0; st.rx0 = rx0;
  }
  // Dragging the limit: position -> characters.
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const box = rulerEl.parentElement;
    const move = (ev) => {
      const x = ev.clientX - box.getBoundingClientRect().left - st.rx0;
      const n = Math.max(0, Math.min(200, Math.round(x / st.cw)));
      if (String(n) !== String(ctx.raw.maxlen)) ctx.set('maxlen', String(n));
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (e) => {
    const cur = +(ctx.input.maxlen) > 0 ? Math.round(+ctx.input.maxlen) : 0;
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 8, PageDown: -8 }[e.key];
    if (d) { e.preventDefault(); ctx.set('maxlen', String(Math.max(0, Math.min(200, cur + d)))); }
    if (e.key === 'Home') { e.preventDefault(); ctx.set('maxlen', '0'); }
  });

  function drawRules() {
    const r = R(); const style = ctx.raw.style || 'upper_snake';
    const list = r.rules || [];
    const card = (id, name, sample, pass, total, extra) => {
      const on = style === id;
      const pct = total ? (100 * pass) / total : 0;
      return h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: `ne-card${on ? ' ne-on' : ''}`, onclick: () => { if (!on) ctx.set('style', id); } },
        h('span', { class: 'ne-cname' }, name),
        h('span', { class: 'ne-sample' }, sample),
        total != null ? h('span', { class: 'ne-cbar' }, h('i', { style: `width:${pct}%` })) : null,
        total != null ? h('span', { class: 'ne-cpass' }, `${pass} of ${total} pass`) : extra);
    };
    const kids = list.map((x) => card(x.style, x.name, x.sample, x.pass, x.total));
    const pat = h('input', { type: 'text', class: 'ne-in ne-pat', spellcheck: 'false', 'aria-label': 'Custom pattern (regex)' });
    pat.value = ctx.raw.pattern ?? '';
    pat.addEventListener('click', (e) => e.stopPropagation());
    pat.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') ctx.setMany({ pattern: pat.value, style: 'custom' }); });
    pat.addEventListener('change', () => ctx.setMany({ pattern: pat.value, style: 'custom' }));
    const vals = Object.fromEntries((r.values || []).map((v) => [v.label, v.value]));
    kids.push(card('custom', 'Custom regex', '/…/', style === 'custom' ? vals.Pass : null, style === 'custom' ? vals['Names checked'] : null, h('span', { class: 'ne-cpass' }, 'your own pattern')));
    const cust = kids[kids.length - 1]; cust.classList.add('ne-custom'); cust.querySelector('.ne-sample').replaceWith(pat);
    const focused = document.activeElement?.classList.contains('ne-pat');
    cards.replaceChildren(...kids);
    if (focused) pat.focus();
    kindSeg.replaceChildren(...KINDS.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String((ctx.raw.kind || 'auto') === v), onclick: () => ctx.set('kind', v) }, t)));
    if (document.activeElement !== prefIn) prefIn.value = ctx.raw.prefixes ?? '';
    if (document.activeElement !== lenIn) lenIn.value = ctx.raw.maxlen ?? '';
  }

  function render() {
    const r = R();
    drawRules();
    const vals = Object.fromEntries((r.values || []).map((v) => [v.label, v]));
    const total = vals['Names checked']?.value || 0, pass = vals.Pass?.value || 0;
    score.replaceChildren(h('b', { class: pass === total ? 'ne-good' : '' }, `${pass} of ${total}`), ' pass', vals.Compliance ? h('span', { class: 'ne-sub' }, ` · ${vals.Compliance.value} · rule ${vals.Rule?.value}`) : null);
    const names = r.names || [];
    const fixable = names.filter((n) => n.problems.length && (n.fix || n.group != null)).length;
    allBtn.textContent = fixable ? `Apply all ${fixable} renames` : 'Nothing to apply';
    allBtn.disabled = !fixable;
    passBtn.textContent = st.showPass ? 'Hide passing' : 'Show passing';
    passBtn.setAttribute('aria-pressed', String(!st.showPass));
    drawBody();
    if (document.activeElement !== src) src.value = ctx.raw.names ?? '';
    const w = r.warnings || [];
    warns.hidden = !w.length; warns.replaceChildren(...w.map((x) => h('div', {}, x)));
    const an = r.autoNamed || [];
    auto.replaceChildren(...(an.length ? [h('div', { class: 'ne-sub' }, `Auto-named nets, not checked: ${an.map((a) => a.raw).join(', ')}`)] : []));
  }
  new ResizeObserver(() => requestAnimationFrame(drawOver)).observe(mapPanel);
  ctx.onResult(() => render());
}
