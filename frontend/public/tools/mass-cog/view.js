// Mass & CoG page: the assembly as masses in space. Three aligned views of a
// drawing sheet (top, front, right side) show every part as a disc whose area
// is its mass, sitting on its centroid; the centre of gravity carries the
// usual CoG mark with its radius of gyration round it in each view. Drag a
// part in any view to move it (arrow keys when it has focus) and watch the
// CoG follow; the parts list on the right is the same data as rows, with each
// part's share of the mass as a bar. Every number shown comes from run().

const NS = 'http://www.w3.org/2000/svg';

const CSS = `
:root { --tool-mc-metal: #5b7fa6; --tool-mc-plastic: #d97706; --tool-mc-elec: #0f9d8a; --tool-mc-other: #a23fbf; --tool-mc-cog: #16202a; --tool-mc-dim: #5b6b7a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-mc-metal: #8fb0d6; --tool-mc-plastic: #f0a33a; --tool-mc-elec: #3cc7b3; --tool-mc-other: #c982e0; --tool-mc-cog: #e4ebf1; --tool-mc-dim: #8ea0b0; } }
:root[data-theme="dark"] { --tool-mc-metal: #8fb0d6; --tool-mc-plastic: #f0a33a; --tool-mc-elec: #3cc7b3; --tool-mc-other: #c982e0; --tool-mc-cog: #e4ebf1; --tool-mc-dim: #8ea0b0; }
.k-page { padding: 12px; }
.mc { display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: 12px; align-items: start; }
@media (max-width: 1080px) { .mc { grid-template-columns: minmax(0, 1fr); } }
.mc-sheet { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0;
  height: clamp(420px, calc(100vh - 86px), 980px); }
.mc-sheet svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.mc svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; fill: var(--ink-soft); }
.mc svg text.v { fill: var(--ink); font-weight: 600; }
.mc svg text.t { font-family: "IBM Plex Sans", sans-serif; font-size: 11.5px; fill: var(--ink-soft); }
.mc svg text.big { font-size: 22px; font-weight: 600; fill: var(--ink); }
.mc svg .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.mc .pt { cursor: grab; outline: none; }
.mc .pt:focus-visible .disc, .mc .pt.sel .disc { stroke: var(--accent); stroke-width: 2.5; }
.mc .pt:focus-visible .foc { stroke: var(--accent); stroke-dasharray: 3 2; fill: none; }
.mc .pt .foc { fill: none; stroke: none; }
.mc .pt.sel text.nm { fill: var(--ink); font-weight: 600; }
.mc.dragging, .mc.dragging * { cursor: grabbing !important; }
.mc-hint { position: absolute; right: 12px; top: 8px; font-size: 11px; color: var(--ink-soft); pointer-events: none; }
.mc-side { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.mc-list { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.mc-lhead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 7px 10px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--ink-soft); }
.mc-lhead b { color: var(--ink); font-weight: 600; font-size: 12px; margin-right: auto; }
.mc-lhead label { display: inline-flex; align-items: center; gap: 5px; }
.mc-lhead select, .mc-lhead input { padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.mc-lhead input { width: 48px; text-align: right; }
.mc-rows { max-height: calc(100vh - 470px); min-height: 180px; overflow-y: auto; }
.mc-row { display: grid; grid-template-columns: 6px minmax(0, 1fr) auto; gap: 2px 8px; padding: 6px 10px 7px 0; border-bottom: 1px solid var(--line-soft); position: relative; }
.mc-row > i { grid-row: 1 / span 3; border-radius: 0 2px 2px 0; }
.mc-row.sel { background: var(--sunken); }
.mc-row.bad { box-shadow: inset 3px 0 0 var(--danger); }
.mc-row input, .mc-row select { min-width: 0; padding: 2px 4px; border: 1px solid transparent; border-radius: 3px; background: transparent; font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.mc-row input:hover, .mc-row select:hover { border-color: var(--line); }
.mc-row input:focus, .mc-row select:focus { border-color: var(--accent); background: var(--surface); outline: none; }
.mc-row input.bad { border-color: var(--danger); }
.mc-row .nm { font: 600 12.5px "IBM Plex Sans", sans-serif; width: 100%; }
.mc-row .mass { text-align: right; font: 600 13px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; align-self: center; }
.mc-row .mass small { color: var(--ink-soft); font-weight: 400; font-size: 11px; }
.mc-l2 { display: flex; gap: 4px; align-items: center; min-width: 0; grid-column: 2 / span 2; flex-wrap: wrap; }
.mc-l2 select { max-width: 190px; }
.mc-f { display: inline-flex; align-items: center; gap: 1px; font-size: 10.5px; color: var(--ink-soft); }
.mc-f input { width: 58px; text-align: right; }
.mc-f.q input { width: 34px; } .mc-f.r input { width: 42px; } .mc-f.c input { width: 46px; }
.mc-bar { grid-column: 2 / span 2; height: 4px; background: var(--sunken); border-radius: 2px; position: relative; overflow: hidden; }
.mc-bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; }
.mc-bar i.neg { background: repeating-linear-gradient(90deg, var(--danger) 0 3px, transparent 3px 5px) !important; }
.mc-x { position: absolute; right: 6px; top: 5px; border: 0; background: transparent; color: var(--ink-soft); cursor: pointer; font-size: 14px; padding: 0 4px; border-radius: 3px; opacity: 0; }
.mc-row:hover .mc-x, .mc-x:focus-visible { opacity: 1; }
.mc-row .mass { padding-right: 18px; }
.mc-add { display: flex; gap: 6px; padding: 7px 10px; }
.mc-add button { padding: 3px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 12px; }
.mc-add button:hover { border-color: var(--ink-soft); }
.mc-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.mc-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.mc-msgs:empty { display: none; }
.mc-side .k-out { max-height: 220px; }
@media (max-width: 1080px) { .mc-rows { max-height: none; } }
@media (max-width: 640px) {
  .mc-sheet { height: 900px; }
  .mc-hint { display: none; }
}
`;

const h = (tag, attrs = {}, ...kids) => {
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
const s = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};
const P = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
const r1 = (v) => (Math.round(v * 10) / 10).toString();
const sig = (v, n = 4) => (Number.isFinite(v) ? String(Number(Number(v).toPrecision(n))) : '–');
const mass = (g) => (Math.abs(g) >= 1000 ? `${sig(g / 1000)} kg` : `${sig(g)} g`);

const family = (mat) => {
  const m = String(mat || '');
  if (/PCB|FR-4|Li-ion/.test(m)) return 'elec';
  if (/Alumin|Steel|steel|Brass|Copper|Titan|Magnes|Zinc/.test(m)) return 'metal';
  if (/ABS|PC$|PA66|POM|PMMA|PLA|PETG|TPU/.test(m)) return 'plastic';
  return 'other';
};
const FAM = { metal: 'var(--tool-mc-metal)', plastic: 'var(--tool-mc-plastic)', elec: 'var(--tool-mc-elec)', other: 'var(--tool-mc-other)' };
const FAMNAME = { metal: 'metal', plastic: 'plastic', elec: 'electronics', other: 'other' };

// The three views of a third-angle sheet: which coordinates go across and up.
const VIEWS = [
  { id: 'top', name: 'Top', a: 'x', b: 'y', axA: 'X', axB: 'Y', k: 'z' },
  { id: 'front', name: 'Front', a: 'x', b: 'z', axA: 'X', axB: 'Z', k: 'y' },
  { id: 'right', name: 'Right side', a: 'y', b: 'z', axA: 'Y', axB: 'Z', k: 'x' },
];

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  const matDef = ctx.manifest.inputs.find((d) => d.key === 'parts');
  const MATERIALS = matDef.columns.find((c) => c.key === 'material').options;
  let res = null, g = null, sel = 0, frame = null, listSig = '';

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Assembly in three views with the centre of gravity');
  const sheet = h('div', { class: 'mc-sheet' }, svg, h('div', { class: 'mc-hint' }, 'drag a part in any view · arrow keys move a focused part 1 mm (shift 10)'));

  const unitSel = h('select', { 'aria-label': 'Volumes in', onchange: (e) => ctx.set('unit', e.target.value) },
    ctx.manifest.inputs.find((d) => d.key === 'unit').options.map(([v, t]) => h('option', { value: v }, t)));
  const infillIn = h('input', { inputmode: 'decimal', 'aria-label': 'Infill of printed plastics in percent' });
  infillIn.addEventListener('change', () => ctx.set('infill', infillIn.value.trim()));
  const rowsBox = h('div', { class: 'mc-rows' });
  const list = h('section', { class: 'mc-list' },
    h('div', { class: 'mc-lhead' }, h('b', {}, 'Parts'), h('label', {}, 'volumes in', unitSel), h('label', {}, 'print infill', infillIn, '%')),
    rowsBox,
    h('div', { class: 'mc-add' },
      h('button', { onclick: () => addPart(false) }, '+ Add part'),
      h('button', { onclick: () => addPart(true), title: 'A hole or pocket: negative volume of the same material' }, '− Add cut-out')));
  const msgs = h('div', { class: 'mc-msgs', 'aria-live': 'polite' });
  const side = h('aside', { class: 'mc-side' }, list, msgs, ctx.outputs);
  const wrap = h('div', { class: 'mc' }, sheet, side);
  root.append(wrap);

  const parts = () => structuredClone(ctx.raw.parts || []);
  const unitName = () => ({ mm3: 'mm³', cm3: 'cm³', in3: 'in³', m3: 'm³' })[ctx.raw.unit] || 'mm³';

  function addPart(cut) {
    const ps = parts();
    const c = g && g.cog ? g.cog : [0, 0, 0];
    const src = ps[sel] || {};
    ps.push(cut
      ? { name: 'Cut-out', material: src.material || MATERIALS[0], volume: '-1000', qty: '1', x: r1(c[0]), y: r1(c[1]), z: r1(c[2]), density: '' }
      : { name: `Part ${ps.length + 1}`, material: MATERIALS[0], volume: '1000', qty: '1', x: r1(c[0] + 10), y: r1(c[1]), z: r1(c[2]), density: '' });
    sel = ps.length - 1;
    listSig = '';
    ctx.set('parts', ps);
  }

  // ---------------- the list ----------------
  function buildList() {
    const ps = ctx.raw.parts || [];
    rowsBox.replaceChildren(...ps.map((r, i) => {
      const fam = family(r.material);
      const field = (key, cls, label, unit) => {
        const inp = h('input', { inputmode: key === 'name' ? null : 'decimal', spellcheck: 'false', 'aria-label': `${label} of ${r.name || `row ${i + 1}`}`, class: key === 'name' ? 'nm' : null });
        inp.value = r[key] ?? '';
        inp.addEventListener('input', () => { const p2 = parts(); p2[i][key] = inp.value; listSig = sigOf(p2); ctx.set('parts', p2); });
        inp.addEventListener('focus', () => select(i, false));
        if (key === 'name') return inp;
        return h('label', { class: `mc-f ${cls}` }, label, inp, unit ? h('span', {}, unit) : null);
      };
      const mat = h('select', { 'aria-label': `Material of ${r.name || `row ${i + 1}`}` }, MATERIALS.map((m) => h('option', { value: m, selected: m === r.material }, m)));
      mat.addEventListener('change', () => { const p2 = parts(); p2[i].material = mat.value; listSig = ''; ctx.set('parts', p2); });
      mat.addEventListener('focus', () => select(i, false));
      const del = h('button', { class: 'mc-x', title: 'Remove part', 'aria-label': `Remove ${r.name || `row ${i + 1}`}`, onclick: () => {
        const p2 = parts(); p2.splice(i, 1); sel = Math.max(0, Math.min(sel, p2.length - 1)); listSig = ''; ctx.set('parts', p2);
      } }, '×');
      const row = h('div', { class: 'mc-row', 'data-row': i, onpointerdown: () => select(i, false) },
        h('i', { style: `background:${FAM[fam]}` }),
        field('name', '', 'Name'),
        h('div', { class: 'mass' }, '–'),
        h('div', { class: 'mc-l2' }, mat, field('volume', '', 'V', ''), field('qty', 'q', '×', ''), field('density', 'r', 'ρ', '')),
        h('div', { class: 'mc-l2' }, field('x', 'c', 'x', ''), field('y', 'c', 'y', ''), field('z', 'c', 'z', ''), h('span', { class: 'mc-f', style: 'margin-left:auto' }, 'mm')),
        h('div', { class: 'mc-bar' }, h('i', {})),
        del);
      row.querySelector('.mc-f.r input').placeholder = 'mat.';
      return row;
    }));
    listSig = sigOf(ps);
  }
  const sigOf = (ps) => JSON.stringify(ps);
  function fillList() {
    const ps = ctx.raw.parts || [];
    const byRow = new Map((g?.parts || []).map((p) => [p.row, p]));
    const bad = new Set(g?.badRows || []);
    const maxAbs = Math.max(1e-9, ...(g?.parts || []).map((p) => Math.abs(p.m)));
    rowsBox.querySelectorAll('.mc-row').forEach((row) => {
      const i = Number(row.dataset.row);
      const p = byRow.get(i);
      row.classList.toggle('sel', i === sel);
      row.classList.toggle('bad', bad.has(i));
      row.querySelector('.mass').replaceChildren(p ? mass(p.m) : '–', p && g.M ? h('small', {}, ` ${sig(p.share * 100, 3)} %`) : null);
      const bar = row.querySelector('.mc-bar i');
      bar.style.width = p ? `${(Math.abs(p.m) / maxAbs) * 100}%` : '0';
      bar.style.background = FAM[family(ps[i]?.material)];
      bar.classList.toggle('neg', !!p && p.m < 0);
      row.querySelectorAll('input').forEach((inp) => {
        const key = inp.getAttribute('aria-label').split(' ')[0];
        const k = { Name: 'name', V: 'volume', '×': 'qty', 'ρ': 'density', x: 'x', y: 'y', z: 'z' }[key];
        if (k && k !== 'name' && k !== 'density') inp.classList.toggle('bad', String(ps[i]?.[k] ?? '').trim() !== '' && ctx.parseEng(ps[i][k]) == null);
      });
      row.querySelector('.mc-f input[aria-label^="V "]')?.setAttribute('title', `volume in ${unitName()}`);
    });
  }
  function select(i, scroll = true) {
    if (sel === i) return;
    sel = i;
    fillList();
    drawSheet();
    if (scroll) rowsBox.querySelector(`.mc-row[data-row="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // ---------------- the sheet ----------------
  function layout(W, H) {
    const ps = g.parts;
    const ext = { x: [], y: [], z: [] };
    for (const p of ps) for (const a of 'xyz') ext[a].push(p[a]);
    for (const a of 'xyz') ext[a].push(g.cog['xyz'.indexOf(a)]);
    const rng = {};
    for (const a of 'xyz') {
      let lo = Math.min(...ext[a]), hi = Math.max(...ext[a]);
      const kk = g.k[a === 'x' ? 'y' : 'x'] || 0;
      const span = Math.max(hi - lo, 20);
      const pad = Math.max(span * 0.18, 8, kk * 0.3);
      lo -= pad; hi += pad;
      if (hi - lo < 40) { const c = (hi + lo) / 2; lo = c - 20; hi = c + 20; }
      rng[a] = [lo, hi];
    }
    const span = (a) => rng[a][1] - rng[a][0];
    const gap = 46, left = 56, top = 30, right = 16, bottom = 40;
    const narrow = W < 640;
    let sc, o = {};
    if (!narrow) {
      sc = Math.min((W - left - right - gap) / (span('x') + span('y')), (H - top - bottom - gap) / (span('y') + span('z')));
      const wx = span('x') * sc, wy = span('y') * sc, hz = span('z') * sc, hy = span('y') * sc;
      const x0 = left + Math.max(0, (W - left - right - gap - wx - wy) / 2);
      const y0 = top + Math.max(0, (H - top - bottom - gap - hy - hz) / 2);
      o.top = { x: x0, y: y0, w: wx, h: hy };
      o.front = { x: x0, y: y0 + hy + gap, w: wx, h: hz };
      o.right = { x: x0 + wx + gap, y: y0 + hy + gap, w: wy, h: hz };
      o.block = { x: x0 + wx + gap, y: y0, w: Math.max(wy, 200), h: hy };
    } else {
      sc = Math.min((W - left - right) / Math.max(span('x'), span('y')), (H - top - bottom - 2 * gap - 170) / (span('y') + 2 * span('z')));
      const wx = span('x') * sc, wy = span('y') * sc, hz = span('z') * sc, hy = span('y') * sc;
      const x0 = left;
      o.block = { x: 14, y: top - 12, w: W - 28, h: 150 };
      o.top = { x: x0, y: top + 170, w: wx, h: hy };
      o.front = { x: x0, y: top + 170 + hy + gap, w: wx, h: hz };
      o.right = { x: x0, y: top + 170 + hy + hz + 2 * gap, w: wy, h: hz };
    }
    return { rng, sc, o, narrow };
  }

  function drawSheet() {
    const W = sheet.clientWidth || 900, H = sheet.clientHeight || 700;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    if (!g || !g.parts || !g.parts.length) {
      svg.append(s('text', { class: 't', x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'Add a part with a volume and a material'));
      return;
    }
    const L = frame || layout(W, H);
    const { rng, sc, o } = L;
    const X = (v, a, box) => box.x + (v - rng[a][0]) * sc;
    const Y = (v, b, box) => box.y + box.h - (v - rng[b][0]) * sc;
    const maxAbs = Math.max(...g.parts.map((p) => Math.abs(p.m)));
    const rOf = (m) => Math.max(4, Math.sqrt(Math.abs(m) / maxAbs) * Math.min(30, 12 + sc * 4));
    const cog = { x: g.cog[0], y: g.cog[1], z: g.cog[2] };
    const hasCog = Number.isFinite(g.M) && g.M > 0;

    // projection lines between the views, through the CoG
    if (hasCog && !L.narrow) {
      const xc = X(cog.x, 'x', o.top), zc = Y(cog.z, 'z', o.front);
      svg.append(s('path', { d: `M${P(xc, o.top.y)}V${(o.front.y + o.front.h).toFixed(1)}M${P(o.front.x, zc)}H${(o.right.x + o.right.w).toFixed(1)}`,
        stroke: 'var(--accent)', 'stroke-width': 0.8, 'stroke-dasharray': '5 4', opacity: 0.55 }));
      // the mitre: y in the top view turns into y in the side view
      const yt = Y(cog.y, 'y', o.top), xr = X(cog.y, 'y', o.right);
      svg.append(s('path', { d: `M${P(o.top.x + o.top.w, yt)}H${xr.toFixed(1)}V${(o.right.y + o.right.h).toFixed(1)}`, stroke: 'var(--accent)', 'stroke-width': 0.8, 'stroke-dasharray': '5 4', opacity: 0.35, fill: 'none' }));
    }

    for (const v of VIEWS) {
      const box = o[v.id];
      const gv = s('g');
      gv.append(s('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: 'var(--sunken)', stroke: 'var(--line)' }));
      // grid every 10/20/50 mm
      const step = [5, 10, 20, 50, 100, 200, 500, 1000].find((st) => st * sc >= 28) || 1000;
      let grid = '';
      for (let a = Math.ceil(rng[v.a][0] / step) * step; a <= rng[v.a][1]; a += step) grid += `M${P(X(a, v.a, box), box.y)}V${(box.y + box.h).toFixed(1)}`;
      for (let b = Math.ceil(rng[v.b][0] / step) * step; b <= rng[v.b][1]; b += step) grid += `M${P(box.x, Y(b, v.b, box))}H${(box.x + box.w).toFixed(1)}`;
      gv.append(s('path', { d: grid, stroke: 'var(--line-soft)', 'stroke-width': 1 }));
      // origin axes
      const ox = X(0, v.a, box), oy = Y(0, v.b, box);
      let ax = '';
      if (ox >= box.x && ox <= box.x + box.w) ax += `M${P(ox, box.y)}V${(box.y + box.h).toFixed(1)}`;
      if (oy >= box.y && oy <= box.y + box.h) ax += `M${P(box.x, oy)}H${(box.x + box.w).toFixed(1)}`;
      if (ax) gv.append(s('path', { d: ax, stroke: 'var(--tool-mc-dim)', 'stroke-width': 0.8, opacity: 0.6 }));
      // view title and axis names
      gv.append(s('text', { class: 't', x: box.x, y: box.y - 8 }, `${v.name} view${v.id === 'top' ? ` · grid ${step} mm` : ''}`));
      gv.append(s('text', { x: box.x + box.w - 2, y: box.y + box.h + 14, 'text-anchor': 'end' }, `${v.axA} →`));
      gv.append(s('text', { x: box.x - 6, y: box.y + 10, 'text-anchor': 'end' }, `${v.axB}↑`));
      svg.append(gv);

      // lever arms: CoG to each part, heavier = stronger
      if (hasCog) {
        const cx = X(cog[v.a], v.a, box), cy = Y(cog[v.b], v.b, box);
        const arms = s('g', { opacity: 0.35 });
        for (const p of g.parts) arms.append(s('line', { x1: cx, y1: cy, x2: X(p[v.a], v.a, box), y2: Y(p[v.b], v.b, box), stroke: 'var(--ink-soft)', 'stroke-width': Math.max(0.5, Math.abs(p.share) * 4) }));
        svg.append(arms);
        // radius of gyration about the axis this view looks along
        const kk = g.k[v.k];
        if (kk > 0) {
          svg.append(s('circle', { cx, cy, r: kk * sc, fill: 'none', stroke: 'var(--accent)', 'stroke-dasharray': '2 3', 'stroke-width': 1 }));
          const lx = cx + kk * sc * 0.707, ly = cy - kk * sc * 0.707;
          svg.append(s('text', { class: 'halo', x: lx + 3, y: ly - 3 }, `k${v.k} ${r1(kk)}`));
        }
      }
      // the parts, heaviest first so light ones stay on top
      const order = [...g.parts].sort((a2, b2) => Math.abs(b2.m) - Math.abs(a2.m));
      const taken = [];
      if (hasCog) { const cx0 = X(cog[v.a], v.a, box), cy0 = Y(cog[v.b], v.b, box); taken.push([cx0 - 11, cy0 - 11, cx0 + 11, cy0 + 11]); }
      const free = (x1, y1, x2, y2) => !taken.some((t) => x1 < t[2] && x2 > t[0] && y1 < t[3] && y2 > t[1]);
      // the selected part claims its label place first
      order.sort((a2, b2) => (b2.row === sel) - (a2.row === sel));
      for (const p of order) {
        const px = X(p[v.a], v.a, box), py = Y(p[v.b], v.b, box), r = rOf(p.m);
        const raw = (ctx.raw.parts || [])[p.row] || {};
        const col = FAM[family(raw.material)];
        const gp = s('g', { class: `pt${p.row === sel ? ' sel' : ''}`, tabindex: '0', role: 'button', 'data-row': p.row, 'data-view': v.id,
          'aria-label': `${p.name}, ${mass(p.m)}, ${v.axA} ${r1(p[v.a])}, ${v.axB} ${r1(p[v.b])} mm in the ${v.name.toLowerCase()} view` });
        gp.append(s('circle', { class: 'foc', cx: px, cy: py, r: r + 4 }));
        if (p.m < 0) gp.append(s('circle', { class: 'disc', cx: px, cy: py, r, fill: 'var(--surface)', 'fill-opacity': 0.6, stroke: 'var(--danger)', 'stroke-width': 1.5, 'stroke-dasharray': '3 2' }));
        else gp.append(s('circle', { class: 'disc', cx: px, cy: py, r, fill: col, 'fill-opacity': 0.55, stroke: col, 'stroke-width': 1.5 }));
        gp.append(s('circle', { cx: px, cy: py, r: 1.8, fill: 'var(--ink)' }));
        if (p.qty > 1) gp.append(s('text', { class: 'halo', x: px + r * 0.7 + 2, y: py + r * 0.7 + 10, 'font-size': 10 }, `×${sig(p.qty)}`));
        {
          const label = p.name.length > 22 ? `${p.name.slice(0, 21)}…` : p.name;
          const tw = label.length * 6.2, lh = p.row === sel ? 26 : 13;
          let lx = px + r + 4, anchor = 'start';
          if (lx + tw > W - 6) { lx = px - r - 4; anchor = 'end'; }
          // right of the disc, else left, else under it
          let ly = py - 2;
          const box0 = (x1, y1) => [x1, y1 - 10, x1 + tw, y1 - 10 + lh];
          const tries = [[lx, anchor, py - 2]];
          if (px - r - 4 - tw > box.x + 2) tries.push([px - r - 4, 'end', py - 2]);
          tries.push([px - tw / 2, 'start', py + r + 12]);
          let ok2 = false;
          for (const [tx, an, ty] of tries) {
            const b0 = box0(an === 'start' ? tx : tx - tw, ty);
            if (free(...b0)) { lx = tx; anchor = an; ly = ty; ok2 = true; break; }
          }
          const bx2 = anchor === 'start' ? lx : lx - tw;
          if (p.row === sel || ok2) {
            taken.push(box0(bx2, ly));
            gp.append(s('text', { class: 'nm halo', x: lx, y: ly, 'font-size': 10.5, 'text-anchor': anchor }, label));
            if (p.row === sel) gp.append(s('text', { class: 'halo', x: lx, y: ly + 13, 'font-size': 10, 'text-anchor': anchor }, `${v.a} ${r1(p[v.a])} · ${v.b} ${r1(p[v.b])}`));
          }
        }
        dragPart(gp, p, v, L);
        svg.append(gp);
      }
      // the CoG mark and its coordinates on the view's edges
      if (hasCog) {
        const cx = X(cog[v.a], v.a, box), cy = Y(cog[v.b], v.b, box);
        svg.append(cogMark(cx, cy, 9));
        svg.append(s('path', { d: `M${P(cx, box.y + box.h)}v6M${P(box.x, cy)}h-6`, stroke: 'var(--accent)', 'stroke-width': 1.5 }));
        svg.append(s('text', { class: 'v halo', x: cx, y: box.y + box.h + 26, 'text-anchor': 'middle' }, `${v.a} ${r1(cog[v.a])}`));
        svg.append(s('text', { class: 'v halo', x: box.x - 8, y: cy + 4, 'text-anchor': 'end' }, `${v.b} ${r1(cog[v.b])}`));
      }
    }
    titleBlock(o.block);
  }

  function cogMark(cx, cy, r) {
    const gm = s('g', { 'aria-label': 'centre of gravity' });
    gm.append(s('circle', { cx, cy, r: r + 2, fill: 'var(--surface)' }));
    gm.append(s('circle', { cx, cy, r, fill: 'var(--surface)', stroke: 'var(--tool-mc-cog)', 'stroke-width': 1.5 }));
    gm.append(s('path', { d: `M${P(cx, cy)}L${P(cx + r, cy)}A${r},${r} 0 0 0 ${P(cx, cy - r)}ZM${P(cx, cy)}L${P(cx - r, cy)}A${r},${r} 0 0 0 ${P(cx, cy + r)}Z`, fill: 'var(--tool-mc-cog)' }));
    return gm;
  }

  function titleBlock(b) {
    const x = b.x, y = b.y;
    const gb = s('g');
    if (!Number.isFinite(g.M)) return;
    gb.append(s('text', { class: 't', x, y: y + 4 }, 'Total mass'));
    gb.append(s('text', { class: 'big', x, y: y + 30 }, mass(g.M)));
    gb.append(cogMark(x + 8, y + 52, 7));
    gb.append(s('text', { class: 'v', x: x + 22, y: y + 56 }, `CoG (${g.cog.map(r1).join(', ')}) mm`));
    const heavy = [...g.parts].sort((a, c) => c.m - a.m)[0];
    const lines = [
      `net volume ${sig(g.Vcm3)} cm³ · ρ avg ${sig(g.rhoAvg, 3)} g/cm³`,
      `heaviest: ${heavy.name.length > 26 ? heavy.name.slice(0, 25) + '…' : heavy.name} ${sig(heavy.share * 100, 3)} %`,
      `k (gyration) x ${r1(g.k.x)} · y ${r1(g.k.y)} · z ${r1(g.k.z)} mm`,
    ];
    lines.forEach((t, i) => gb.append(s('text', { x, y: y + 76 + i * 15 }, t)));
    // mass share, one bar split by part
    const bw = Math.min(b.w, 300), by = y + 76 + lines.length * 15 - 2;
    if (b.h > 150 || L_narrowCheck()) {
      let acc = 0;
      const pos = g.parts.filter((p) => p.m > 0);
      const tot = pos.reduce((a, p) => a + p.m, 0);
      for (const p of pos) {
        const w = (p.m / tot) * bw;
        const raw = (ctx.raw.parts || [])[p.row] || {};
        const r = s('rect', { x: x + acc, y: by, width: Math.max(0, w - 1), height: 8, fill: FAM[family(raw.material)], opacity: p.row === sel ? 1 : 0.6 });
        r.append(s('title', {}, `${p.name}: ${mass(p.m)}`));
        gb.append(r);
        acc += w;
      }
      const fams = [...new Set(g.parts.map((p) => family(((ctx.raw.parts || [])[p.row] || {}).material)))];
      let lx = x, ly = by + 16;
      const item = (w) => { if (lx + w > x + Math.max(bw, 200) && lx > x) { lx = x; ly += 15; } const at = lx; lx += w; return at; };
      fams.forEach((f) => {
        const at = item(FAMNAME[f].length * 6.2 + 26);
        gb.append(s('rect', { x: at, y: ly, width: 9, height: 9, fill: FAM[f], opacity: 0.8 }));
        gb.append(s('text', { x: at + 13, y: ly + 9, 'font-size': 10 }, FAMNAME[f]));
      });
      if (g.parts.some((p) => p.m < 0)) {
        const at = item(70);
        gb.append(s('circle', { cx: at + 5, cy: ly + 4.5, r: 4.5, fill: 'none', stroke: 'var(--danger)', 'stroke-dasharray': '2 1.5' }));
        gb.append(s('text', { x: at + 13, y: ly + 9, 'font-size': 10 }, 'cut-out'));
      }
    }
    svg.append(gb);
  }
  const L_narrowCheck = () => true;

  function dragPart(node, p, v, L) {
    const move = (da, db) => {
      const ps = parts();
      const r = ps[p.row];
      if (!r) return;
      r[v.a] = r1((ctx.parseEng(r[v.a]) ?? 0) + da);
      r[v.b] = r1((ctx.parseEng(r[v.b]) ?? 0) + db);
      listSig = '';
      ctx.set('parts', ps);
    };
    node.addEventListener('keydown', (e) => {
      const st = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, st], ArrowDown: [0, -st] }[e.key];
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.row); return; }
      if (!d) return;
      e.preventDefault();
      refocus = { row: p.row, view: v.id };
      sel = p.row;
      move(d[0], d[1]);
    });
    node.addEventListener('focus', () => { if (sel !== p.row) { sel = p.row; fillList(); } });
    node.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const W = sheet.clientWidth, px2 = rect.width / W;
      const ps0 = parts()[p.row] || {};
      const a0 = ctx.parseEng(ps0[v.a]) ?? 0, b0 = ctx.parseEng(ps0[v.b]) ?? 0;
      const x0 = ev.clientX, y0 = ev.clientY, id = ev.pointerId;
      frame = L;
      sel = p.row;
      refocus = { row: p.row, view: v.id };
      wrap.classList.add('dragging');
      let moved = false;
      const mv = (e) => {
        if (e.pointerId !== id) return;
        const da = (e.clientX - x0) / px2 / L.sc, db = -(e.clientY - y0) / px2 / L.sc;
        if (!moved && Math.hypot(e.clientX - x0, e.clientY - y0) < 3) return;
        moved = true;
        const snap = e.shiftKey ? 0.1 : 1;
        const ps = parts(); const r = ps[p.row];
        r[v.a] = r1(Math.round((a0 + da) / snap) * snap);
        r[v.b] = r1(Math.round((b0 + db) / snap) * snap);
        listSig = '';
        ctx.set('parts', ps);
      };
      const up = (e) => {
        if (e.pointerId !== id) return;
        wrap.classList.remove('dragging');
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        frame = null;
        drawSheet(); fillList();
        rowsBox.querySelector(`.mc-row[data-row="${p.row}"]`)?.scrollIntoView({ block: 'nearest' });
        svg.querySelector(`.pt[data-row="${p.row}"][data-view="${v.id}"]`)?.focus({ preventScroll: true });
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      fillList(); drawSheet();
    });
  }
  let refocus = null;

  ctx.onResult((r) => {
    res = r; g = r && r.drawing ? r.drawing : null;
    const raw = ctx.raw;
    unitSel.value = raw.unit || 'mm3';
    if (document.activeElement !== infillIn) infillIn.value = raw.infill ?? '';
    if (sigOf(raw.parts || []) !== listSig) buildList();
    fillList();
    drawSheet();
    msgs.replaceChildren(...(r?.warnings || []).map((w) => h('div', {}, w)));
    if (refocus) {
      const el = svg.querySelector(`.pt[data-row="${refocus.row}"][data-view="${refocus.view}"]`);
      if (el && !frame) el.focus({ preventScroll: true });
      if (!frame) refocus = null;
    }
  });
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(drawSheet); }).observe(sheet);
}
