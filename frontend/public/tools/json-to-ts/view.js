// JSON to TypeScript, custom page: the sample on the left, the shape it
// implies drawn as a map of type cards in the middle, the code on the right.
//
// Every object shape the tool names is a card; its fields are rows with
// their type, how many of the sample objects had them (a presence bar - the
// reason a field is optional), a format tag and a real example value.
// Fields that hold another named type are wired to that card. Click a
// field and its lines light up in the sample; click a type's name to
// rename it (that writes the "names" input, or rootName for the root).
// Everything drawn comes from run()'s result.shape.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Rough JSON colouring for the backdrop under the textarea (same metrics).
function paint(src) {
  return esc(src).replace(/("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b/g, (m, str, colon, bool) => {
    if (str) return colon ? `<span class="jt-k">${str}</span>${colon}` : `<span class="jt-s">${str}</span>`;
    if (bool) return `<span class="jt-b">${m}</span>`;
    if (m === 'null') return `<span class="jt-n">${m}</span>`;
    return `<span class="jt-num">${m}</span>`;
  });
}

function parseNames(txt) {
  const m = new Map();
  for (const part of String(txt ?? '').split(/[,;\n]+/)) {
    const [a, b] = part.split('=').map((x) => (x || '').trim());
    if (a && b) m.set(a, b);
  }
  return m;
}

export function page(root, ctx) {
  const st = { sel: null, shape: null, errLine: null, renaming: null };
  const defaults = Object.fromEntries(ctx.manifest.inputs.map((d) => [d.key, d.default ?? '']));

  // ------------------------------------------------------------ source
  const ta = h('textarea', { class: 'jt-ta', spellcheck: 'false', wrap: 'off', 'aria-label': 'Sample JSON',
    oninput: (e) => { drawBack(e.target.value); ctx.set('json', e.target.value); } });
  const back = h('pre', { class: 'jt-back', 'aria-hidden': 'true' });
  const gutter = h('pre', { class: 'jt-gut', 'aria-hidden': 'true' });
  ta.addEventListener('scroll', () => { back.scrollTop = ta.scrollTop; back.scrollLeft = ta.scrollLeft; gutter.scrollTop = ta.scrollTop; });
  const readAs = h('span', { class: 'jt-soft jt-mono' });
  const exBtns = (ctx.manifest.examples || []).map((ex, i) => h('button', { class: 'jt-chip', title: ex.title,
    onclick: () => { st.sel = null; ctx.setMany({ ...defaults, ...structuredClone(ex.input) }); } }, i === 0 ? 'Record' : 'NDJSON log'));
  const source = h('section', { class: 'jt-panel jt-src' },
    h('div', { class: 'jt-head' }, h('span', { class: 'jt-h' }, 'Sample'), readAs),
    h('div', { class: 'jt-editor' }, gutter, h('div', { class: 'jt-edbox' }, back, ta)),
    h('div', { class: 'jt-hint' }, 'One object, an array of samples, or one object per line. More samples show which fields are optional.'),
    h('div', { class: 'jt-exrow' }, h('span', { class: 'jt-soft' }, 'Load an example'), exBtns));

  // ------------------------------------------------------------ map
  const seg = (key, opts, label) => h('span', { class: 'jt-seg', role: 'group', 'aria-label': label },
    opts.map(([v, t, tip]) => h('button', { 'data-key': key, 'data-v': v, 'aria-pressed': 'false', title: tip, onclick: () => ctx.set(key, v) }, t)));
  const exportCb = h('input', { type: 'checkbox', onchange: (e) => ctx.set('exportKw', e.target.checked) });
  const stats = h('span', { class: 'jt-stats jt-mono' });
  const toolbar = h('div', { class: 'jt-tools' },
    seg('declare', [['interface', 'interface'], ['type', 'type =']], 'Declare as'),
    seg('nulls', [['union', 'T | null', 'A null value makes the field T | null'], ['optional', 'field?', 'A null value makes the field optional']], 'Null values'),
    h('label', { class: 'jt-cb' }, exportCb, 'export'), h('span', { class: 'jt-grow' }), stats);
  const warn = h('div', { class: 'jt-warn', 'aria-live': 'polite' });
  const cards = h('div', { class: 'jt-cards' });
  const wires = sv('svg', { class: 'jt-wires', 'aria-hidden': 'true' });
  const canvas = h('div', { class: 'jt-canvas' }, wires, cards);
  const detail = h('div', { class: 'jt-detail', 'aria-live': 'polite' });
  const map = h('section', { class: 'jt-panel jt-map' },
    h('div', { class: 'jt-head' }, h('span', { class: 'jt-h' }, 'Type map'), h('span', { class: 'jt-soft' }, 'click a field to find it in the sample, a type name to rename it')),
    toolbar, warn, canvas, detail);

  const out = h('section', { class: 'jt-outcol' }, ctx.outputs);
  root.append(h('div', { class: 'jt-page' }, source, map, out));

  // ------------------------------------------------------------ source backdrop
  function drawBack(text) {
    const lines = text.split('\n');
    const hits = new Set();
    if (st.sel) {
      const re = new RegExp(`"${st.sel.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
      lines.forEach((l, i) => { if (re.test(l)) hits.add(i); });
    }
    back.innerHTML = lines.map((l, i) => {
      const cls = i + 1 === st.errLine ? 'jt-line jt-errl' : hits.has(i) ? 'jt-line jt-hit' : 'jt-line';
      return `<span class="${cls}">${paint(l) || ' '}</span>`;
    }).join('\n') + '\n';
    gutter.textContent = lines.map((_, i) => String(i + 1)).join('\n') + '\n';
    st.hitLines = [...hits];
  }
  function revealHit() {
    if (!st.hitLines?.length) return;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const y = st.hitLines[0] * lh;
    if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - lh * 2) ta.scrollTop = Math.max(0, y - lh * 3);
  }

  // ------------------------------------------------------------ renaming
  function commitRename(t, value) {
    const v = value.trim();
    st.renaming = null;
    if (!v || v === t.name) { drawMap(); return; }
    if (t.root) { ctx.set('rootName', v); return; }
    const m = parseNames(ctx.raw.names);
    if (v === t.auto) m.delete(t.auto); else m.set(t.auto, v);
    ctx.set('names', [...m].map(([a, b]) => `${a}=${b}`).join(', '));
  }

  // ------------------------------------------------------------ map drawing
  function layoutColumns(types) {
    const byName = new Map(types.map((t) => [t.name, t]));
    const depth = new Map();
    const rootT = types.find((t) => t.root) || types[0];
    const q = rootT ? [[rootT.name, 0]] : [];
    while (q.length) {
      const [n, d] = q.shift();
      if (depth.has(n)) continue;
      depth.set(n, d);
      for (const f of byName.get(n)?.fields || []) for (const r of f.refs) if (!depth.has(r)) q.push([r, d + 1]);
    }
    for (const t of types) if (!depth.has(t.name)) depth.set(t.name, 0);
    const cols = [];
    for (const t of types) (cols[depth.get(t.name)] ||= []).push(t);
    return cols.filter(Boolean);
  }

  function fieldRow(t, f) {
    const isSel = st.sel && st.sel.type === t.name && st.sel.key === f.key;
    const typeEl = h('span', { class: 'jt-ftype' });
    // the type text, with named types in it coloured as links
    const parts = f.type.split(/(\b[A-Z][A-Za-z0-9]*\b)/);
    for (const p of parts) {
      if (f.refs.includes(p)) typeEl.append(h('b', { class: 'jt-ref' }, p));
      else if (p) typeEl.append(h('span', { class: /null/.test(p) ? 'jt-tn' : '' }, p));
    }
    const pres = f.of > 1 ? h('span', { class: `jt-pres${f.missing ? ' is-miss' : ''}`, title: `in ${f.seen} of ${f.of} objects` },
      h('i', { style: `width:${Math.round((f.seen / f.of) * 100)}%` })) : null;
    const onlyNull = f.type === 'null';
    return h('button', { class: `jt-row${isSel ? ' is-sel' : ''}${f.opt ? ' is-opt' : ''}${onlyNull ? ' is-null' : ''}`, title: onlyNull ? 'Only ever null in the sample: its real type is unknown' : null, 'data-type': t.name, 'data-key': f.key,
      'aria-pressed': String(!!isSel),
      onclick: () => { st.sel = isSel ? null : { type: t.name, key: f.key }; drawMap(); drawBack(ta.value); revealHit(); } },
      h('span', { class: 'jt-fkey' }, f.key, f.opt ? h('em', { class: 'jt-q' }, '?') : null),
      h('span', { class: 'jt-tcell' }, typeEl,
        f.fmt ? h('span', { class: 'jt-fmt' }, f.fmt) : null,
        onlyNull ? h('span', { class: 'jt-nullflag' }, 'unknown') : null),
      h('span', { class: 'jt-fmeta' },
        pres,
        f.of > 1 ? h('span', { class: `jt-cnt${f.missing ? ' is-miss' : ''}` }, `${f.seen}/${f.of}`) : null));
  }

  function card(t, res) {
    const decl = ctx.input.declare === 'type' ? 'type' : 'interface';
    const nameEl = st.renaming === t.name
      ? h('input', { class: 'jt-rename', value: t.name, 'aria-label': `New name for ${t.name}`, spellcheck: 'false',
        onkeydown: (e) => { if (e.key === 'Enter') commitRename(t, e.target.value); if (e.key === 'Escape') { st.renaming = null; drawMap(); } },
        onblur: (e) => { if (st.renaming === t.name) commitRename(t, e.target.value); } })
      : h('button', { class: 'jt-name', title: 'Rename this type', onclick: () => { st.renaming = t.name; drawMap(); } }, t.name);
    const c = h('article', { class: `jt-card${t.root ? ' is-root' : ''}`, 'data-name': t.name },
      h('header', { class: 'jt-chead' },
        h('span', { class: 'jt-decl' }, decl), nameEl,
        t.name !== t.auto ? h('span', { class: 'jt-soft jt-was', title: 'inferred name' }, `was ${t.auto}`) : null,
        h('span', { class: 'jt-grow' }),
        t.root ? h('span', { class: 'jt-tag' }, 'root') : null,
        h('span', { class: 'jt-seen', title: 'objects of this shape in the sample' }, `${t.seen}×`)),
      t.fields.map((f) => fieldRow(t, f)));
    if (t.fields.length === 0) c.append(h('div', { class: 'jt-empty' }, 'no fields (always an empty object)'));
    return c;
  }

  function drawMap() {
    const res = ctx.result;
    const shape = res?.shape || st.shape;
    cards.replaceChildren();
    if (!shape) { wires.replaceChildren(); return; }
    const cols = layoutColumns(shape.types);
    if (shape.rootAlias) cards.append(h('div', { class: 'jt-col' }, h('div', { class: 'jt-alias jt-mono' }, h('span', { class: 'jt-decl' }, 'type'), ` ${shape.rootAlias}`)));
    for (const col of cols) cards.append(h('div', { class: 'jt-col' }, col.map((t) => card(t, res))));
    const ren = cards.querySelector('.jt-rename');
    if (ren) { ren.focus(); ren.select(); }
    drawDetail(shape);
    requestAnimationFrame(drawWires);
  }

  function drawWires() {
    wires.replaceChildren();
    const shape = ctx.result?.shape || st.shape;
    if (!shape) return;
    const box = canvas.getBoundingClientRect();
    wires.setAttribute('width', cards.offsetWidth);
    wires.setAttribute('height', cards.offsetHeight);
    const off = (r) => ({ l: r.left - box.left + canvas.scrollLeft, r: r.right - box.left + canvas.scrollLeft, t: r.top - box.top + canvas.scrollTop, b: r.bottom - box.top + canvas.scrollTop });
    for (const t of shape.types) for (const f of t.fields) for (const ref of f.refs) {
      const row = cards.querySelector(`.jt-row[data-type="${CSS.escape(t.name)}"][data-key="${CSS.escape(f.key)}"]`);
      const tgt = cards.querySelector(`.jt-card[data-name="${CSS.escape(ref)}"] .jt-chead`);
      if (!row || !tgt) continue;
      const a = off(row.getBoundingClientRect()), b = off(tgt.getBoundingClientRect());
      const y1 = (a.t + a.b) / 2, y2 = (b.t + b.b) / 2;
      const sel = st.sel && st.sel.type === t.name && st.sel.key === f.key;
      let d;
      if (b.l >= a.r + 8) {
        const x1 = a.r, x2 = b.l, dx = Math.max(24, (x2 - x1) / 2);
        d = `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
      } else {
        // stacked (narrow screens): leave on the right, come back into the card's header from the right
        const x1 = a.r, x2 = b.r, xr = Math.max(x1, x2) + 14;
        d = `M${x1} ${y1} C${xr} ${y1} ${xr} ${y2} ${x2} ${y2}`;
      }
      const isArr = /\[\]/.test(f.type);
      wires.append(sv('path', { d, class: `jt-wire${sel ? ' is-sel' : ''}${f.opt ? ' is-opt' : ''}` }));
      wires.append(sv('circle', { cx: a.r, cy: y1, r: 3, class: 'jt-dot' }));
      if (isArr) {
        // a crow's foot at the target: many items of this type
        const x2 = b.l >= a.r + 8 ? b.l : b.r, s = b.l >= a.r + 8 ? -1 : 1;
        wires.append(sv('path', { d: `M${x2 + s * 9} ${y2} L${x2} ${y2 - 5} M${x2 + s * 9} ${y2} L${x2} ${y2 + 5}`, class: `jt-wire jt-foot${sel ? ' is-sel' : ''}` }));
      }
    }
  }

  function drawDetail(shape) {
    const t = st.sel && shape.types.find((x) => x.name === st.sel.type);
    const f = t && t.fields.find((x) => x.key === st.sel.key);
    if (!f) {
      detail.replaceChildren(h('span', { class: 'jt-soft' }, `${shape.types.length} types, ${shape.fields} fields, ${shape.optional} optional, ${shape.depth} levels deep. Select a field for its evidence.`));
      return;
    }
    const why = f.missing ? `missing from ${f.of - f.seen} of ${f.of} ${t.name} objects, so optional`
      : f.nul && f.opt ? 'null in the sample, typed as optional (Null values: field?)'
        : f.of > 1 ? `present in all ${f.of} ${t.name} objects, so required` : 'required (one object seen: give more samples to learn which fields can be missing)';
    detail.replaceChildren(...[
      h('span', { class: 'jt-mono jt-dpath' }, `${t.name}.${f.key}${f.opt ? '?' : ''}: ${f.type}`),
      h('span', {}, why),
      f.fmt ? h('span', {}, `every value matched ${f.fmt}`) : null,
      f.ex.length ? h('span', { class: 'jt-mono jt-soft' }, `e.g. ${f.ex.join(', ')}`) : null,
      f.type === 'null' ? h('span', { class: 'jt-bad' }, 'only ever null: add a sample where it has a value') : null].filter(Boolean));
  }

  // keyboard: arrows move between field rows
  cards.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('jt-row') || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const rows = [...cards.querySelectorAll('.jt-row')];
    const i = rows.indexOf(e.target) + (e.key === 'ArrowDown' ? 1 : -1);
    if (rows[i]) { e.preventDefault(); rows[i].focus(); }
  });
  new ResizeObserver(() => requestAnimationFrame(drawWires)).observe(canvas);
  canvas.addEventListener('scroll', () => requestAnimationFrame(drawWires));

  // ------------------------------------------------------------ result in
  ctx.onResult((res) => {
    const raw = ctx.raw;
    if (document.activeElement !== ta && ta.value !== String(raw.json ?? '')) ta.value = String(raw.json ?? '');
    for (const b of toolbar.querySelectorAll('.jt-seg button')) b.setAttribute('aria-pressed', String(String(raw[b.dataset.key]) === b.dataset.v));
    exportCb.checked = !!raw.exportKw;
    const m = (res.warnings || []).join(' ').match(/at line (\d+), column (\d+)/);
    st.errLine = m ? Number(m[1]) : null;
    warn.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    if (res.shape) {
      st.shape = res.shape;
      map.classList.remove('is-stale');
      readAs.textContent = res.shape.read.join(' · ');
      stats.textContent = `${res.shape.types.length} types · ${res.shape.fields} fields · ${res.shape.optional} optional`;
      if (st.sel && !res.shape.types.some((t) => t.name === st.sel.type && t.fields.some((f) => f.key === st.sel.key))) st.sel = null;
    } else {
      map.classList.add('is-stale');
      readAs.textContent = m ? `error at line ${m[1]}` : '';
    }
    drawBack(ta.value);
    drawMap();
    // the code is what people came for: open on the TypeScript tab unless they picked another before
    if (!st.tabDone) {
      st.tabDone = true;
      let picked = null;
      try { picked = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
      if (!picked) [...ctx.outputs.querySelectorAll('.k-tab')].find((b) => b.textContent === 'TypeScript')?.click();
    }
  });
}
