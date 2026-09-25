// BOM Deduplicator page: the pasted BOM as its lines on the left, the parts
// they really are on the right, and a ribbon from every line to the part it
// folded into (as thick as the line's quantity). A merged part shows its
// spellings stacked and what they were read as (10k, 10K, 10 kohm -> 10 kΩ).
// Point at a line or a part to trace it; Enter on a part folds its spellings
// open or shut; switch the merge rule and watch the ribbons re-route. Lines
// with quantity or designator problems are flagged where they are, possible
// duplicates that were not merged are marked on both parts.
// Parts, quantities and review items are run()'s result; the lines are the
// tool's own parseBom() of the same text.
import { parseBom } from './tool.js';

const GCOL = ['var(--tool-g0)', 'var(--tool-g1)', 'var(--tool-g2)', 'var(--tool-g3)', 'var(--tool-g4)', 'var(--tool-g5)'];
const NS = 'http://www.w3.org/2000/svg';

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const normMpn = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const uniq = (a) => [...new Set(a.filter((x) => String(x || '').trim()))];

export function page(root, ctx) {
  let editing = false, active = null, model = null;
  const open = new Set();         // part keys folded open by the user
  const shut = new Set();         // merged parts folded shut by the user

  // ---------------- skeleton ----------------
  const sum = el('div', { class: 'bm-sum' });
  const stats = el('div', { class: 'bm-stats' });
  const mergeSeg = el('div', { class: 'bm-seg', role: 'group', 'aria-label': 'Merge by' });
  const ignore = el('input', { type: 'checkbox', onchange: (e) => ctx.set('ignoreMfr', e.target.checked) });
  const editBtn = el('button', { class: 'bm-btn', onclick: () => setEditing(!editing) });
  const top = el('section', { class: 'bm-box bm-top' }, sum, stats, el('span', { class: 'bm-grow' }),
    el('div', { class: 'bm-ctl' }, 'Merge by', mergeSeg, el('label', { class: 'bm-chk' }, ignore, 'ignore manufacturer on MPN match'), editBtn));

  const linesHead = el('div', { class: 'bm-colh' });
  const lines = el('div', { class: 'bm-lines', role: 'listbox', 'aria-label': 'BOM lines as pasted' });
  const ta = el('textarea', { spellcheck: 'false', 'aria-label': 'BOM text', placeholder: 'Reference,Qty,Value,Footprint,MPN,Manufacturer\nR1,1,10k,0603,,' });
  ta.addEventListener('input', () => ctx.set('bom', ta.value));
  const edit = el('div', { class: 'bm-edit' }, ta);
  const msgs = el('div', { class: 'bm-msgs', 'aria-live': 'polite' });
  const outBox = el('div', { class: 'bm-out' }, ctx.outputs, msgs);
  const colL = el('div', { class: 'bm-col lines' }, linesHead, lines, outBox);
  const rib = document.createElementNS(NS, 'svg');
  rib.setAttribute('aria-hidden', 'true');
  const ribBox = el('div', { class: 'bm-rib' }, rib);
  const partsHead = el('div', { class: 'bm-colh' });
  const parts = el('div', { class: 'bm-parts', role: 'list', 'aria-label': 'Consolidated parts' });
  const rev = el('div', { class: 'bm-rev' });
  const colR = el('div', { class: 'bm-col parts' }, partsHead, parts, rev);
  const flow = el('section', { class: 'bm-box bm-flow' }, colL, ribBox, colR);
  root.append(el('div', { class: 'bm' }, top, flow));

  function setEditing(on) {
    editing = on;
    if (on) { ta.value = ctx.raw.bom ?? ''; colL.replaceChildren(linesHead, edit, outBox); requestAnimationFrame(() => ta.focus()); }
    else colL.replaceChildren(linesHead, lines, outBox);
    render();
  }

  // ---------------- the model: lines -> parts ----------------
  function build() {
    const res = ctx.result || {};
    const t = res.tables?.find((x) => x.title === 'Consolidated BOM');
    const p = parseBom(ctx.raw.bom || '');
    if (!t || p.error) return { groups: [], rows: p.rows || [], error: p.error || res.warnings?.[0] };
    const groups = t.rows.map((r, i) => ({ i, key: `${r[1]}|${r[2]}|${r[4]}|${r[5]}`, qty: r[0], refs: r[1] === '–' ? [] : String(r[1]).split(' '),
      value: r[2], pkg: r[3], mpn: r[4], mfr: r[5], merged: r[6], lines: [], review: [] }));
    const byRef = new Map();
    groups.forEach((g) => g.refs.forEach((r) => { if (!byRef.has(r)) byRef.set(r, g); }));
    const rows = p.rows.map((r) => ({ ...r, g: null }));
    for (const r of rows) {
      // the part holding most of this line's designators
      const score = new Map();
      for (const ref of r.refs) { const g = byRef.get(ref); if (g) score.set(g, (score.get(g) || 0) + 1); }
      let best = [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!best && r.mpn) best = groups.find((g) => normMpn(g.mpn) === normMpn(r.mpn));
      if (!best) best = groups.find((g) => g.refs.length === 0 && !g.lines.length);
      if (best) { r.g = best; best.lines.push(r); }
    }
    // review pairs from run(): mark both parts
    const rt = res.tables?.find((x) => /^Review/.test(x.title));
    const reviews = (rt?.rows || []).map((row, k) => {
      const sides = String(row[0]).split('  vs  ').map((s) => s.trim().split(/\s+/)[0]);
      const gs = sides.map((ref) => byRef.get(ref)).filter(Boolean);
      const item = { k, row, gs };
      gs.forEach((g) => g.review.push(item));
      return item;
    });
    // line flags from the warnings ("line 16: ...", "R5 appears on line 3 and line 7")
    const flags = new Map(), general = [];
    for (const w of res.warnings || []) {
      const ls = [...w.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
      if (ls.length && !/had no designator/.test(w)) ls.forEach((l) => flags.set(l, [...(flags.get(l) || []), w.replace(/^line \d+: /, '')]));
      else general.push(w);
    }
    // show parts in the order their first line appears, so ribbons cross less
    const order = [...groups].sort((a, b) => (a.lines[0] ? rows.indexOf(a.lines[0]) : 1e9) - (b.lines[0] ? rows.indexOf(b.lines[0]) : 1e9) || a.i - b.i);
    let c = 0;
    for (const g of order) g.col = g.lines.length > 1 ? GCOL[c++ % GCOL.length] : null;
    return { groups: order, rows, reviews, flags, general, map: p.map };
  }

  // ---------------- drawing ----------------
  const qtyOf = (r) => { const n = Number(String(r.qty).replace(',', '.')); return r.refs.length || (Number.isFinite(n) && n > 0 ? n : 1); };
  const thick = (q) => Math.max(2, Math.min(16, 1.2 + 2.2 * Math.sqrt(q)));
  const isOpen = (g) => (g.lines.length > 1 ? !shut.has(g.key) : open.has(g.key));

  function renderTop() {
    const res = ctx.result || {}, v = (l) => res.values?.find((x) => x.label === l);
    const lin = v('Lines in'), out = v('Unique parts out');
    sum.replaceChildren(el('span', { class: 'n' }, lin?.value ?? '–'), el('span', { class: 'l' }, 'lines'), el('span', { class: 'arrow' }, '→'),
      el('span', { class: 'n', style: 'color:var(--ok)' }, out?.value ?? '–'), el('span', { class: 'l' }, 'parts'));
    const st = (lab, key, cls) => { const x = v(key); return x ? el('span', { class: cls || null, title: x.hint || null }, el('b', {}, x.value), lab) : null; };
    const rv = v('Needs review');
    stats.replaceChildren(st('lines merged', 'Lines merged'), st('placements', 'Total placements'), st('to review', 'Needs review', rv && rv.value !== '0' ? 'warn' : ''));
    const mb = ctx.raw.mergeBy === 'value' ? 'value' : 'mpn';
    mergeSeg.replaceChildren(...[['mpn', 'MPN, then value'], ['value', 'Value + package']].map(([k, t]) =>
      el('button', { 'aria-pressed': String(mb === k), onclick: () => ctx.set('mergeBy', k) }, t)));
    ignore.checked = !!ctx.raw.ignoreMfr;
    ignore.disabled = mb === 'value';
    editBtn.textContent = editing ? 'Done editing' : 'Edit the BOM text';
    editBtn.classList.toggle('on', editing);
  }

  function renderLines() {
    const m = model;
    const cols = m.map || {};
    linesHead.replaceChildren(el('b', {}, 'As pasted'), el('span', {}, editing ? 'edit freely: the parts update as you type' : `${m.rows.length} lines · double-click one to edit the text`));
    if (editing) return;
    const head = el('div', { class: 'bm-lhead' }, el('span', {}, '#'), el('span', {}, 'Refs'), el('span', {}, cols.value != null ? 'Value' : ''), el('span', {}, cols.footprint != null ? 'Footprint' : ''), el('span', {}, cols.mpn != null ? 'MPN · Mfr' : ''));
    const kids = m.rows.map((r, i) => {
      const f = m.flags?.get(r.line);
      const g = r.g;
      const row = el('div', { class: `bm-line${f ? ' flag' : ''}`, role: 'option', tabindex: i === 0 ? '0' : '-1', 'data-i': String(i), 'data-g': g ? String(g.i) : '',
        'aria-label': `Line ${r.line}: ${r.refs.join(' ')} ${r.value} ${r.footprint} ${r.mpn}${g ? ` - part ${g.value} ${g.pkg}` : ''}${f ? ` - ${f.join(' ')}` : ''}` },
      el('span', { class: 'ln', style: g?.col ? `color:${g.col};font-weight:600` : null }, String(r.line)),
      el('span', { title: r.refs.join(' ') }, r.refs.join(' ') || '–'),
      el('span', { title: r.value }, r.value),
      el('span', { title: r.footprint }, r.footprint),
      el('span', { class: 'mpn', title: [r.mpn, r.mfr].filter(Boolean).join(' · ') }, [r.mpn, r.mfr].filter(Boolean).join(' · ')),
      f ? el('span', { class: 'bm-flagmsg' }, f.join(' ')) : null);
      row._r = r;
      return row;
    });
    lines.replaceChildren(head, ...kids);
  }

  function renderParts() {
    const m = model;
    partsHead.replaceChildren(el('b', {}, 'Parts'), el('span', {}, m.groups.length ? 'folded lines are stacked · Enter or click to unfold' : ''));
    if (!m.groups.length) {
      parts.replaceChildren(el('div', { style: 'padding:14px;color:var(--ink-soft);font-size:12px' }, m.error || 'No parts yet: paste a BOM with a header row.'));
      rev.replaceChildren(); rev.style.display = 'none';
      return;
    }
    const kids = m.groups.map((g, j) => {
      const multi = g.lines.length > 1;
      const unfolded = isOpen(g);
      const valSp = uniq(g.lines.map((r) => r.value)), pkgSp = uniq(g.lines.map((r) => r.footprint)), mfrSp = uniq(g.lines.map((r) => r.mfr));
      const fold = [];
      if (unfolded) {
        // only what was actually rewritten: several spellings, or one that reads differently
        const line = (lab, raw, to) => (raw.length > 1 || (raw.length === 1 && raw[0] !== to)
          ? el('div', {}, el('span', { class: 'lns' }, lab), ...raw.map((s) => el('s', {}, s)), el('span', { class: 'to' }, '→'), el('b', {}, to)) : null);
        fold.push(line('value', valSp, g.value), line('package', pkgSp, g.pkg));
        if (mfrSp.length > 1 || (mfrSp.length === 1 && mfrSp[0] !== g.mfr && g.mfr !== '–')) fold.push(line('maker', mfrSp, g.mfr));
        if (!fold.some(Boolean)) fold.push(el('div', {}, el('span', { class: 'lns' }, 'read as written')));
      }
      const mp = [g.mpn !== '–' ? g.mpn : '', g.mfr !== '–' ? g.mfr : ''].filter(Boolean).join(' · ');
      const card = el('div', { class: `bm-part${multi ? ' multi' : ''}`, role: 'listitem', tabindex: j === 0 ? '0' : '-1', 'data-g': String(g.i), 'aria-expanded': String(unfolded),
        style: g.col ? `border-left-color:${g.col}` : null,
        'aria-label': `${g.qty} × ${g.value} ${g.pkg}${mp ? ' ' + mp : ''}, ${g.refs.join(' ')}${multi ? `, merged from ${g.lines.length} lines` : ''}${g.review.length ? ', needs review' : ''}` },
      el('div', { class: 'bm-ph' },
        el('span', { class: 'bm-q' }, String(g.qty), el('small', {}, '×')),
        el('span', { class: 'bm-v', title: `${g.value} ${g.pkg}` }, g.value, el('span', {}, g.pkg !== '–' ? g.pkg : '')),
        el('span', {}, multi ? el('span', { class: 'bm-badge', style: `color:${g.col}`, title: `lines ${g.lines.map((r) => r.line).join(', ')}` }, `${g.lines.length} lines`) : null,
          ...g.review.map((it) => el('button', { class: 'bm-badge rv', title: it.row[3], 'data-rv': String(it.k) }, 'review')))),
      el('div', { class: 'bm-sub' }, el('span', {}), el('span', { class: 'refs' }, g.refs.join(' ') || '–', mp ? el('span', { class: 'mp', title: mp }, `  ${mp}`) : null)),
      unfolded ? el('div', { class: 'bm-sub' }, el('span', {}), el('div', { class: 'bm-fold' }, ...fold.filter(Boolean))) : null);
      return card;
    });
    parts.replaceChildren(...kids);
    if (m.reviews.length) {
      rev.style.display = '';
      rev.replaceChildren(el('h3', {}, `Possible duplicates, not merged (${m.reviews.length})`), ...m.reviews.map((it) => el('div', {},
        ...String(it.row[0]).split('  vs  ').flatMap((side, k) => [k ? ' vs ' : null, el('button', { 'data-ref': side.trim().split(/\s+/)[0] }, side.trim())]),
        el('br'), el('b', {}, it.row[1]), ` differs in ${it.row[2]}. `, it.row[3])));
    } else { rev.replaceChildren(); rev.style.display = 'none'; }
  }

  function renderMsgs() {
    const res = ctx.result || {};
    msgs.replaceChildren(...(model.general || []).map((w) => el('div', {}, w)),
      el('details', {}, el('summary', { style: 'cursor:pointer' }, `How lines are matched (${(res.notes || []).length} notes)`), ...(res.notes || []).map((n) => el('div', {}, n))));
  }

  function drawRibbons() {
    if (editing || getComputedStyle(ribBox).display === 'none') { rib.innerHTML = ''; return; }
    const box = ribBox.getBoundingClientRect(), W = box.width;
    const lineEls = [...lines.querySelectorAll('.bm-line')], partEls = new Map([...parts.querySelectorAll('.bm-part')].map((e) => [e.dataset.g, e]));
    const inlet = new Map();
    const o = [];
    // stack each part's incoming ribbons around the middle of its header
    const byG = new Map();
    for (const le of lineEls) { const g = le.dataset.g; if (g) byG.set(g, [...(byG.get(g) || []), le]); }
    for (const [g, les] of byG) {
      const pe = partEls.get(g); if (!pe) continue;
      const pb = pe.getBoundingClientRect(), total = les.reduce((a, le) => a + thick(qtyOf(le._r)), 0);
      let y = pb.top - box.top + Math.min(pb.height / 2, 16) - total / 2;
      for (const le of les) { const t = thick(qtyOf(le._r)); inlet.set(le, y + t / 2); y += t; }
    }
    for (const le of lineEls) {
      const g = le.dataset.g, y2 = inlet.get(le); if (!g || y2 == null) continue;
      const lb = le.getBoundingClientRect(), y1 = lb.top - box.top + lb.height / 2, t = thick(qtyOf(le._r));
      const grp = model.groups.find((x) => String(x.i) === g), col = grp?.col || 'var(--tool-single)';
      const dim = active != null && String(active) !== g;
      o.push(`<path data-g="${g}" d="M-2,${y1.toFixed(1)}C${(W * 0.5).toFixed(1)},${y1.toFixed(1)} ${(W * 0.5).toFixed(1)},${y2.toFixed(1)} ${W + 4},${y2.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${t.toFixed(1)}" stroke-opacity="${dim ? 0.12 : grp?.col ? 0.75 : 0.9}"/>`);
    }
    rib.setAttribute('viewBox', `0 0 ${W} ${box.height}`);
    rib.innerHTML = o.join('');
  }

  function highlight(g) {
    active = g;
    for (const e of flow.querySelectorAll('.bm-line, .bm-part')) {
      const on = g != null && e.dataset.g === String(g);
      e.classList.toggle('on', on);
      e.classList.toggle('dim', g != null && !on);
    }
    for (const p of rib.querySelectorAll('path')) p.setAttribute('stroke-opacity', g != null && p.dataset.g !== String(g) ? '0.12' : '0.8');
  }

  function render() {
    model = build();
    renderTop(); renderLines(); renderParts(); renderMsgs();
    if (active != null && !model.groups.some((g) => g.i === active)) active = null;
    requestAnimationFrame(() => { drawRibbons(); if (active != null) highlight(active); });
  }

  // ---------------- interaction ----------------
  flow.addEventListener('pointerover', (e) => { const t = e.target.closest('.bm-line, .bm-part'); if (t && t.dataset.g) highlight(Number(t.dataset.g)); });
  flow.addEventListener('pointerleave', () => { if (!flow.contains(document.activeElement)) highlight(null); });
  flow.addEventListener('focusin', (e) => { const t = e.target.closest('.bm-line, .bm-part'); if (t && t.dataset.g) highlight(Number(t.dataset.g)); });
  flow.addEventListener('focusout', () => requestAnimationFrame(() => { if (!flow.contains(document.activeElement)) highlight(null); }));
  const toggle = (card) => {
    const g = model.groups.find((x) => String(x.i) === card.dataset.g); if (!g) return;
    if (g.lines.length > 1) { if (shut.has(g.key)) shut.delete(g.key); else shut.add(g.key); } else if (open.has(g.key)) open.delete(g.key); else open.add(g.key);
    const gi = g.i;
    render();
    requestAnimationFrame(() => parts.querySelector(`.bm-part[data-g="${gi}"]`)?.focus({ preventScroll: true }));
  };
  const jumpToRef = (ref) => {
    const g = model.groups.find((x) => x.refs.includes(ref)); if (!g) return;
    const card = parts.querySelector(`.bm-part[data-g="${g.i}"]`); if (card) { card.focus(); card.scrollIntoView({ block: 'nearest' }); }
  };
  flow.addEventListener('click', (e) => {
    const rv = e.target.closest('[data-rv]');
    if (rv) {
      e.stopPropagation();
      const it = model.reviews[Number(rv.dataset.rv)], me = Number(rv.closest('.bm-part').dataset.g);
      const other = it?.gs.find((g) => g.i !== me) || it?.gs[0];
      if (other) jumpToRef(other.refs[0]);
      return;
    }
    const ref = e.target.closest('[data-ref]');
    if (ref) { jumpToRef(ref.dataset.ref); return; }
    const card = e.target.closest('.bm-part'); if (card) { toggle(card); return; }
    const line = e.target.closest('.bm-line');
    if (line && line.dataset.g) { const c = parts.querySelector(`.bm-part[data-g="${line.dataset.g}"]`); c?.scrollIntoView({ block: 'nearest' }); highlight(Number(line.dataset.g)); }
  });
  lines.addEventListener('dblclick', (e) => {
    const line = e.target.closest('.bm-line'); if (!line) return;
    const n = line._r.line;
    setEditing(true);
    requestAnimationFrame(() => {
      const ls = ta.value.split('\n'); let pos = 0;
      for (let i = 0; i < Math.min(n - 1, ls.length); i++) pos += ls[i].length + 1;
      ta.setSelectionRange(pos, pos + (ls[n - 1] || '').length);
    });
  });
  // arrow keys walk a column; left/right cross between a line and its part
  flow.addEventListener('keydown', (e) => {
    const t = e.target.closest('.bm-line, .bm-part'); if (!t) return;
    const isPart = t.classList.contains('bm-part');
    const list = [...(isPart ? parts : lines).querySelectorAll(isPart ? '.bm-part' : '.bm-line')];
    const i = list.indexOf(t);
    let next = null;
    if (e.key === 'ArrowDown') next = list[Math.min(list.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = list[Math.max(0, i - 1)];
    else if (e.key === 'ArrowRight' && !isPart) next = parts.querySelector(`.bm-part[data-g="${t.dataset.g}"]`);
    else if (e.key === 'ArrowLeft' && isPart) next = lines.querySelector(`.bm-line[data-g="${t.dataset.g}"]`);
    else if ((e.key === 'Enter' || e.key === ' ') && isPart) { e.preventDefault(); toggle(t); return; }
    if (!next) return;
    e.preventDefault();
    list.forEach((x) => x.setAttribute('tabindex', '-1'));
    next.setAttribute('tabindex', '0');
    next.focus();
  });

  ctx.onResult(() => {
    if (editing && document.activeElement !== ta) ta.value = ctx.raw.bom ?? '';
    render();
  });
  new ResizeObserver(() => drawRibbons()).observe(flow);
}
