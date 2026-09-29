// DMA Stream Planner page: the request matrix IS the interface.
//   Matrix  one per controller. Stream families (F4/F7) and CSELR families
//           (L0/L4): a row per stream/channel, a column per CHSEL/CSELR value,
//           every request line printed in the cell it lives in. Click a line to
//           put it in the plan pinned there (or to move a planned request
//           there); click it again to take it out. The "Assigned" column holds
//           the request that owns the stream: drag it to another row, or focus
//           it and use the arrow keys to walk its possible streams.
//           Hardwired families (F1/F0): a row per channel with its ORed lines.
//           DMAMUX / GPDMA: a row per channel, any request fits; add from the
//           catalogue (click, or drag onto a channel).
//   Plan    the requests with priority (L/M/H/VH), pin state and remove.
// Everything drawn comes from run()'s result (grid, values, warnings); the page
// only rewrites the Requests text.

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

const PRIOS = ['low', 'medium', 'high', 'veryhigh'];
const PRIO_SHORT = { low: 'L', medium: 'M', high: 'H', veryhigh: 'VH' };
const NQ = 8;

function lineFor(p, grid) {
  let s = p.name;
  if (p.prio !== 'low') s += ` ${p.prio}`;
  if (p.pinned && p.at) s += ` @${p.at.ctrl}_${grid.kind === 'stream' || grid.unitWord === 'Stream' ? 'S' : 'C'}${p.at.unit}`;
  return s;
}

export function page(root, ctx) {
  const st = { sel: null, drag: null };
  let res = null;

  // ---------- chrome ----------
  const famSel = h('select', { class: 'dsp-in', 'aria-label': 'MCU family', onchange: (e) => ctx.set('family', e.target.value) },
    ctx.manifest.inputs[0].options.map(([v, t]) => h('option', { value: v }, t)));
  const addIn = h('input', { class: 'dsp-in dsp-add', type: 'text', list: 'dsp-cat', spellcheck: 'false', placeholder: 'Add request: USART1_RX, SPI2_TX, ADC1...',
    'aria-label': 'Add a DMA request', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addReq(addIn.value); } } });
  const cat = h('datalist', { id: 'dsp-cat' });
  const autoBox = h('input', { type: 'checkbox', id: 'dsp-auto', onchange: (e) => ctx.set('solve', e.target.checked) });
  const bar = h('div', { class: 'dsp-bar' },
    h('label', { class: 'dsp-f' }, 'Family', famSel),
    h('div', { class: 'dsp-addwrap' }, addIn, cat, h('button', { class: 'k-btn', onclick: () => addReq(addIn.value) }, 'Add')),
    h('label', { class: 'dsp-chk', for: 'dsp-auto' }, autoBox, 'Auto-assign'),
    h('button', { class: 'k-btn', title: 'Remove every pin and let the solver place everything', onclick: () => rewrite((p) => ({ ...p, pinned: false })) }, 'Re-solve all'),
    h('button', { class: 'k-btn', title: 'Pin every placed request where it is now', onclick: () => rewrite((p) => ({ ...p, pinned: !!p.at })) }, 'Pin all'));
  const summary = h('div', { class: 'dsp-sum' });
  const matrixWrap = h('div', { class: 'dsp-mats' });
  const catalogCard = h('div', { class: 'dsp-card dsp-catalog' });
  const planCard = h('div', { class: 'dsp-card' });
  const warnBox = h('div', { class: 'dsp-warns', 'aria-live': 'polite' });
  const noteBox = h('div', { class: 'dsp-notes' });
  const text = h('textarea', { class: 'dsp-text', rows: 8, spellcheck: 'false', 'aria-label': 'Requests as text',
    onchange: (e) => ctx.set('requests', e.target.value) });
  const details = h('details', { class: 'dsp-det' }, h('summary', {}, 'Requests as text'), text,
    h('div', { class: 'dsp-help' }, 'NAME [low|medium|high|veryhigh] [@DMA2_S3] per line; paste a list here.'));
  planCard.append(h('div', { class: 'dsp-head' }, h('h2', {}, 'Plan'), h('span', { class: 'dsp-sub', id: 'dsp-plancount' })));
  const planList = h('div', { class: 'dsp-plan', role: 'list' });
  planCard.append(planList, details);

  root.append(h('div', { class: 'dsp' },
    h('div', { class: 'dsp-top' }, bar, summary),
    h('div', { class: 'dsp-main' }, warnBox, matrixWrap, catalogCard, noteBox),
    h('div', { class: 'dsp-side' }, planCard, ctx.outputs)));

  // ---------- writing the plan back ----------
  function rewrite(fn, extra) {
    const g = res.grid;
    const list = g.plan.map((p) => fn(p)).filter(Boolean);
    if (extra) list.push(extra);
    ctx.set('requests', list.map((p) => lineFor(p, g)).join('\n'));
  }
  function addReq(name) {
    const n = String(name || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!n) return;
    addIn.value = '';
    if (res.grid.plan.some((p) => p.name === n)) { st.sel = n; draw(); return; }
    st.sel = n;
    rewrite((p) => p, { name: n, prio: 'low', pinned: false, at: null });
  }
  function pinTo(name, ctrl, unit) {
    const g = res.grid;
    const p = g.plan.find((x) => x.name === name);
    st.sel = name;
    if (!p) { rewrite((x) => x, { name, prio: 'low', pinned: true, at: { ctrl, unit } }); return; }
    rewrite((x) => (x.name === name ? { ...x, pinned: true, at: { ctrl, unit } } : x));
  }
  const remove = (name) => { if (st.sel === name) st.sel = null; rewrite((x) => (x.name === name ? null : x)); };
  const setPrio = (name, prio) => rewrite((x) => (x.name === name ? { ...x, prio } : x));
  const cyclePrio = (p) => setPrio(p.name, PRIOS[(PRIOS.indexOf(p.prio) + 1) % 4]);
  // Arrow keys on an assigned chip: the next / previous stream it may use.
  function step(p, dir) {
    const g = res.grid;
    const order = g.ctrls.flatMap((c) => c.units.map((u) => [c.name, u.u]));
    const cands = order.filter(([c, u]) => p.cands.some((x) => x[0] === c && x[1] === u));
    if (!cands.length) return;
    let i = p.at ? cands.findIndex(([c, u]) => c === p.at.ctrl && u === p.at.unit) : -1;
    i = (i + dir + cands.length) % cands.length;
    st.refocus = p.name;
    pinTo(p.name, cands[i][0], cands[i][1]);
  }

  // ---------- drag ----------
  function startDrag(e, name) {
    if (e.button !== 0) return;
    const ghost = h('div', { class: 'dsp-ghost' }, name);
    st.drag = { name, ghost, x0: e.clientX, y0: e.clientY, moved: false };
    e.target.setPointerCapture?.(e.pointerId);
  }
  function moveDrag(e) {
    const d = st.drag; if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
    if (!d.moved) { d.moved = true; document.body.append(d.ghost); st.sel = d.name; markCands(); }
    d.ghost.style.left = `${e.clientX + 10}px`; d.ghost.style.top = `${e.clientY + 8}px`;
    for (const r of root.querySelectorAll('.dsp-row.drop')) r.classList.remove('drop');
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('.dsp-row');
    if (row) row.classList.add('drop');
  }
  function endDrag(e) {
    const d = st.drag; if (!d) return;
    st.drag = null; d.ghost.remove();
    for (const r of root.querySelectorAll('.dsp-row.drop')) r.classList.remove('drop');
    if (!d.moved) return false;
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('.dsp-row');
    if (!row) return true;
    const ctrl = row.dataset.ctrl, unit = Number(row.dataset.unit);
    const p = res.grid.plan.find((x) => x.name === d.name);
    const ok = !p || !p.known || p.cands.some((c) => c[0] === ctrl && c[1] === unit) || res.grid.kind === 'mux';
    if (!ok) { row.classList.add('nope'); setTimeout(() => row.classList.remove('nope'), 500); return true; }
    pinTo(d.name, ctrl, unit);
    return true;
  }
  root.addEventListener('pointermove', moveDrag);
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', () => { if (st.drag) { st.drag.ghost.remove(); st.drag = null; } });

  // ---------- drawing ----------
  const colorOf = (g, name) => g.plan.findIndex((p) => p.name === name) % NQ;
  function occupantChip(g, p) {
    const q = colorOf(g, p.name);
    const chip = h('div', { class: `dsp-chip q${q}${p.clash ? ' clash' : ''}${st.sel === p.name ? ' sel' : ''}`, tabindex: '0', role: 'button',
      'data-name': p.name, 'aria-label': `${p.name}, ${p.prio} priority, ${p.pinned ? 'pinned' : 'auto'}. Arrows move, Delete removes, P changes priority.`,
      onpointerdown: (e) => { if (!e.target.closest('.dsp-pr')) startDrag(e, p.name); },
      onclick: (e) => { if (e.target.closest('.dsp-pr')) return; st.sel = st.sel === p.name ? null : p.name; draw(); },
      onkeydown: (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); step(p, 1); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); step(p, -1); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(p.name); }
        else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); st.refocus = p.name; cyclePrio(p); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = st.sel === p.name ? null : p.name; st.refocus = p.name; draw(); }
      } },
      h('span', { class: 'dsp-cn' }, p.name),
      h('button', { class: `dsp-pr pr-${p.prio}`, tabindex: '-1', title: `Priority ${p.prio} - click to change`, onclick: () => cyclePrio(p) }, PRIO_SHORT[p.prio]),
      h('span', { class: 'dsp-pin', title: p.pinned ? 'pinned here' : 'placed by the solver' }, p.pinned ? 'pin' : 'auto'));
    return chip;
  }

  function matrix(g, c) {
    const kind = g.kind;
    const cols = g.selCols;
    const selName = g.sel === 'CSELR' ? 'REQ' : 'CH';
    const occ = (u) => g.plan.filter((p) => p.at && p.at.ctrl === c.name && p.at.unit === u);
    const selP = g.plan.find((p) => p.name === st.sel);
    const table = h('div', { class: `dsp-grid k-${kind}`, role: 'grid', 'aria-label': `${c.name} ${g.unitWord.toLowerCase()}s`,
      style: kind === 'stream' || cols.length ? `--cols:${cols.length}` : null });
    // header
    const head = h('div', { class: 'dsp-row dsp-hrow', role: 'row' }, h('div', { class: 'dsp-uh' }, g.unitWord),
      h('div', { class: 'dsp-hc dsp-ah' }, 'Assigned'));
    if (kind === 'mux') head.append(h('div', { class: 'dsp-hc' }, g.family === 'u575' ? 'IRQ' : 'DMAMUX line'));
    else if (cols.length) for (const s of cols) head.append(h('div', { class: 'dsp-hc' }, `${selName}${s}`));
    else head.append(h('div', { class: 'dsp-hc' }, 'request lines on this channel (ORed - one at a time)'));
    table.append(head);
    for (const unit of c.units) {
      const u = unit.u;
      const owners = occ(u);
      const clash = owners.length > 1;
      const candHere = selP && selP.cands.some((x) => x[0] === c.name && x[1] === u);
      const row = h('div', { class: `dsp-row${owners.length ? ' used' : ''}${clash ? ' clash' : ''}${candHere ? ' cand' : ''}`, role: 'row',
        'data-ctrl': c.name, 'data-unit': String(u) },
        h('div', { class: 'dsp-uh', title: unit.irq }, h('b', {}, `${g.unitWord === 'Stream' ? 'S' : 'C'}${u}`), h('small', {}, unit.irq.replace(/_IRQn$/, '').replace(/^G?P?DMA\d_/, ''))));
      const owners2 = owners;
      const as = h('div', { class: 'dsp-as' }, owners2.map((p) => occupantChip(g, p)));
      if (!owners2.length) as.append(h('span', { class: 'dsp-free' }, candHere ? 'drop here' : 'free'));
      row.append(as);
      if (kind === 'mux') {
        row.append(h('div', { class: 'dsp-mx' }, g.family === 'u575' ? unit.irq.replace('_IRQn', '') : `DMAMUX1 ch ${unit.mux}`));
      } else {
        const lines = g.cells[`${c.name}.${u}`] || [];
        const cellsOf = cols.length ? cols.map((s) => lines.filter((l) => l[1] === s)) : [lines];
        for (const list of cellsOf) {
          const cell = h('div', { class: 'dsp-cell', role: 'gridcell' });
          for (const [name, sel, dir] of list) {
            const owner = g.plan.find((p) => p.at && p.at.ctrl === c.name && p.at.unit === u && p.at.line === name);
            const wanted = owner || g.plan.find((p) => p.cands.some((x) => x[0] === c.name && x[1] === u && x[3] === name));
            const q = wanted ? colorOf(g, wanted.name) : -1;
            const isSel = wanted && st.sel === wanted.name;
            const cls = ['dsp-line', dir === 'R' ? 'rx' : 'tx'];
            if (owner) cls.push('placed', `q${q}`); else if (wanted) cls.push('cand', `q${q}`, wanted.at ? '' : 'lost');
            if (owner && clash) cls.push('clash');
            if (isSel) cls.push('sel');
            const reqName = wanted ? wanted.name : name.split('/')[0];
            cell.append(h('button', { class: cls.join(' '), 'data-name': name,
              title: owner ? `${reqName} is here - click to take it out of the plan` : wanted ? `move ${reqName} here (${c.name} ${g.unitWord} ${u}${sel != null ? `, ${selName}${sel}` : ''})` : `add ${name} pinned to ${c.name} ${g.unitWord} ${u}`,
              onclick: () => {
                if (owner) remove(owner.name);
                else pinTo(reqName, c.name, u);
              } }, name.replace(/\//g, '/​')));
          }
          row.append(cell);
        }
      }
      table.append(row);
    }
    const used = c.units.filter((x) => occ(x.u).length).length;
    return h('section', { class: 'dsp-card' },
      h('div', { class: 'dsp-head' }, h('h2', {}, c.name),
        h('span', { class: 'dsp-sub' }, `${used} of ${c.units.length} ${g.unitWord.toLowerCase()}s in use`),
        g.m2m.includes(c.name) ? h('span', { class: 'dsp-tag' }, 'mem-to-mem') : h('span', { class: 'dsp-tag off' }, 'no mem-to-mem')),
      h('div', { class: 'dsp-scroll' }, table));
  }

  function drawCatalog(g) {
    catalogCard.replaceChildren();
    if (g.kind !== 'mux') { catalogCard.hidden = true; return; }
    catalogCard.hidden = false;
    const groups = new Map();
    for (const n of g.catalog) {
      const k = n.replace(/_.*$/, '').replace(/\d+$/, '');
      groups.set(k, [...(groups.get(k) || []), n]);
    }
    const inPlan = new Set(g.plan.map((p) => p.line));
    catalogCard.append(h('div', { class: 'dsp-head' }, h('h2', {}, 'Request catalogue'), h('span', { class: 'dsp-sub' }, `${g.catalog.length} requests - click to add, or drag onto a channel`)));
    const body = h('div', { class: 'dsp-catbody' });
    for (const [k, list] of groups) {
      body.append(h('div', { class: 'dsp-catg' }, h('span', { class: 'dsp-catk' }, k),
        list.map((n) => h('button', { class: `dsp-cat${inPlan.has(n) ? ' on' : ''}`, 'data-name': n,
          onpointerdown: (e) => startDrag(e, n),
          onclick: () => { if (!inPlan.has(n)) addReq(n); else { const p = g.plan.find((x) => x.line === n); st.sel = p?.name; draw(); } } }, n))));
    }
    catalogCard.append(body);
  }

  function drawPlan(g) {
    root.querySelector('#dsp-plancount').textContent = `${g.plan.filter((p) => p.at).length} placed of ${g.plan.length}`;
    planList.replaceChildren(...g.plan.map((p) => {
      const q = colorOf(g, p.name);
      const where = p.at ? `${p.at.ctrl} ${g.unitWord[0]}${p.at.unit}${p.at.sel != null && g.kind !== 'mux' ? ` · ${g.sel === 'CSELR' ? 'REQ' : 'CH'}${p.at.sel}` : ''}` : p.known ? 'not placed' : 'unknown';
      const bad = !p.at || p.clash;
      return h('div', { class: `dsp-pi${st.sel === p.name ? ' sel' : ''}${bad ? ' bad' : ''}`, role: 'listitem' },
        h('button', { class: `dsp-dot q${q}`, 'aria-label': `Show where ${p.name} can go`, onclick: () => { st.sel = st.sel === p.name ? null : p.name; draw(); } }),
        h('button', { class: 'dsp-pn', onclick: () => { st.sel = st.sel === p.name ? null : p.name; draw(); },
          onpointerdown: (e) => startDrag(e, p.name) }, p.name),
        h('span', { class: `dsp-where${bad ? ' bad' : ''}` }, p.clash ? `${where} · clash` : where),
        h('div', { class: 'dsp-prseg', role: 'group', 'aria-label': `${p.name} priority` },
          PRIOS.map((v) => h('button', { 'aria-pressed': String(p.prio === v), title: v, onclick: () => setPrio(p.name, v) }, PRIO_SHORT[v]))),
        h('button', { class: `dsp-pinb${p.pinned ? ' on' : ''}`, 'aria-pressed': String(p.pinned), disabled: !p.at,
          title: p.pinned ? 'Pinned - click to let the solver move it' : 'Pin it where it is',
          onclick: () => rewrite((x) => (x.name === p.name ? { ...x, pinned: !x.pinned } : x)) }, p.pinned ? 'pinned' : 'auto'),
        h('button', { class: 'k-btn k-x', 'aria-label': `Remove ${p.name}`, title: 'Remove', onclick: () => remove(p.name) }, '×'));
    }));
    if (!g.plan.length) planList.append(h('div', { class: 'dsp-empty' }, 'No requests yet - click a request line in the matrix or type one above.'));
  }

  function markCands() {
    const g = res.grid;
    const p = g.plan.find((x) => x.name === st.sel);
    for (const r of root.querySelectorAll('.dsp-row[data-ctrl]')) {
      const on = p && (g.kind === 'mux' || p.cands.some((x) => x[0] === r.dataset.ctrl && x[1] === Number(r.dataset.unit)));
      r.classList.toggle('cand', !!on);
    }
  }

  function draw() {
    if (!res?.grid) return;
    const g = res.grid;
    famSel.value = g.family;
    autoBox.checked = ctx.input.solve !== false;
    cat.replaceChildren(...g.catalog.map((n) => h('option', { value: n })));
    if (document.activeElement !== text) text.value = ctx.raw.requests ?? '';
    summary.replaceChildren(...(res.values || []).map((v) => h('div', { class: `dsp-v${v.tone ? ` t-${v.tone}` : ''}`, title: v.hint || '' },
      h('span', {}, v.label), h('b', {}, String(v.value)))));
    warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    noteBox.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    matrixWrap.replaceChildren(...g.ctrls.map((c) => matrix(g, c)));
    matrixWrap.classList.toggle('two', g.kind === 'mux' && g.ctrls.length > 1);
    drawCatalog(g);
    drawPlan(g);
    if (st.refocus) {
      const el = root.querySelector(`.dsp-chip[data-name="${CSS.escape(st.refocus)}"]`);
      st.refocus = null;
      el?.focus();
    }
  }

  ctx.onResult((r) => { res = r; draw(); });
}
