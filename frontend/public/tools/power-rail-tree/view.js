// Power Rail Tree page: the board's power as a flow, left to right, from the
// input through each converter to the loads. Every band is as thick as the
// power it carries, so where the watts go is the picture: a converter's loss
// leaves it as a warm band turning down into heat. Scrub a load's current or a
// switcher's efficiency up and down on the drawing, drag a node onto another
// rail to re-hang it, press + on a rail to hang a new load on it, and click a
// node to edit it in the inspector. Every current, power, loss and rating use
// drawn comes from tool.js run() (result.tree / result.totals / result.values).

const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sig2 = (v) => (v <= 0 ? 0 : Number(v.toPrecision(v < 0.1 ? 2 : 3)));
const TYPES = ['source', 'switcher', 'ldo', 'load'];
const TYPE_NAME = { source: 'Source', switcher: 'Switcher', ldo: 'LDO', load: 'Load' };

const CSS = `
:root { --tool-src: #1f4ed8; --tool-sw: #0f8a78; --tool-ldo: #7a55c7; --tool-load: #5b6b7a; --tool-heat: #d9480f;
  --tool-flow: .30; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --tool-src: #6d8dff; --tool-sw: #3cc7b3; --tool-ldo: #b196f0; --tool-load: #9fb0bf; --tool-heat: #ff7a3d; --tool-flow: .36; } }
:root[data-theme="dark"] { --tool-src: #6d8dff; --tool-sw: #3cc7b3; --tool-ldo: #b196f0; --tool-load: #9fb0bf; --tool-heat: #ff7a3d; --tool-flow: .36; }

.k-page { padding: 12px; }
.pr { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) 320px; align-items: start; }
@media (max-width: 1000px) { .pr { grid-template-columns: minmax(0, 1fr); } }
.pr-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.pr-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }

/* totals: the budget in one line */
.pr-tot { display: flex; flex-wrap: wrap; align-items: stretch; border-bottom: 1px solid var(--line-soft); }
.pr-tot > div { padding: 7px 14px 8px; border-right: 1px solid var(--line-soft); min-width: 0; }
.pr-tot span { display: block; font-size: 11px; color: var(--ink-soft); }
.pr-tot b { font: 600 18px/1.2 "IBM Plex Mono", ui-monospace, monospace; }
.pr-tot b.warn { color: var(--warn); } .pr-tot b.bad { color: var(--danger); }
.pr-tot em { font-style: normal; font-size: 11px; color: var(--ink-soft); }
.pr-tot .grow { flex: 1; border-right: 0; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.pr-btn { padding: 3px 9px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 12px; white-space: nowrap; }
.pr-btn:hover { border-color: var(--ink-soft); }
.pr-btn.danger:hover { border-color: var(--danger); color: var(--danger); }

.pr-stage { position: relative; padding: 4px 6px 0; }
.pr-hint { font-size: 11.5px; color: var(--ink-soft); padding: 6px 8px 0; }
.pr-svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; overflow: visible; }
.pr-link { fill-opacity: var(--tool-flow); stroke: none; }
.pr-link.sel { fill-opacity: calc(var(--tool-flow) + .25); }
.pr-heat { fill: var(--tool-heat); fill-opacity: .55; }
.pr-heat.hot { fill-opacity: .85; }
.pr-heatt { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--tool-heat); }
.pr-direct { fill-opacity: var(--tool-flow); }
.pr-node { cursor: grab; outline: none; }
.pr-node .bar { stroke: none; }
.pr-node .hit { fill: transparent; }
.pr-node .ring { fill: none; stroke: var(--accent); stroke-width: 2; opacity: 0; }
.pr-node.sel .ring { opacity: 1; }
.pr-node:focus-visible .ring { opacity: 1; stroke-dasharray: 4 2; }
.pr-node.warn .bar { stroke: var(--warn); stroke-width: 2; }
.pr-node.bad .bar { stroke: var(--danger); stroke-width: 2.5; }
.pr-node.drop-ok .ring { opacity: .6; stroke: var(--ok); stroke-dasharray: 3 3; }
.pr-node.drop-hover .ring { opacity: 1; stroke: var(--ok); stroke-width: 3; stroke-dasharray: none; }
.pr-name { font: 600 12px "IBM Plex Sans", sans-serif; fill: var(--ink); pointer-events: none; }
.pr-meta { font: 11px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); pointer-events: none; }
.pr-val { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); pointer-events: none; }
.pr-halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.pr-chip { cursor: ns-resize; outline: none; }
.pr-chip rect { fill: var(--sunken); stroke: var(--line); }
.pr-chip:hover rect, .pr-chip.on rect { stroke: var(--accent); }
.pr-chip:focus-visible rect { stroke: var(--accent); stroke-width: 2; }
.pr-chip text { font: 600 11.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); pointer-events: none; }
.pr-gauge .tr { fill: var(--sunken); stroke: var(--line-soft); }
.pr-gauge .fl.ok { fill: var(--ok); } .pr-gauge .fl.warn { fill: var(--warn); } .pr-gauge .fl.bad { fill: var(--danger); }
.pr-gauge .tk { stroke: var(--ink-soft); stroke-width: 1; }
.pr-gt { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.pr-gt.warn { fill: var(--warn); font-weight: 600; } .pr-gt.bad { fill: var(--danger); font-weight: 600; }
.pr-plus { cursor: pointer; outline: none; }
.pr-plus circle { fill: var(--surface); stroke: var(--line); }
.pr-plus:hover circle, .pr-plus:focus-visible circle { stroke: var(--accent); stroke-width: 2; }
.pr-plus path { stroke: var(--ink-soft); stroke-width: 1.5; }
.pr-bang circle { fill: var(--danger); } .pr-bang.warn circle { fill: var(--warn); }
.pr-bang text { font: 700 10px "IBM Plex Sans", sans-serif; fill: #fff; text-anchor: middle; pointer-events: none; }
.pr-ghost { fill: var(--accent); fill-opacity: .25; stroke: var(--accent); stroke-dasharray: 3 2; pointer-events: none; }
.pr-colh { font: 600 10.5px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); letter-spacing: .06em; text-transform: uppercase; }
.pr-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11.5px; color: var(--ink-soft); padding: 2px 10px 8px; }
.pr-legend i { display: inline-block; width: 12px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }

/* where the watts go */
.pr-where { padding: 8px 10px 10px; border-top: 1px solid var(--line-soft); }
.pr-where h3 { margin: 0 0 5px; font-size: 11.5px; font-weight: 600; color: var(--ink-soft); }
.pr-wbar { display: flex; height: 22px; border-radius: 3px; overflow: hidden; }
.pr-wbar i { display: flex; align-items: center; justify-content: center; font: 10.5px "IBM Plex Mono", ui-monospace, monospace; font-style: normal;
  color: var(--ink); overflow: hidden; white-space: nowrap; border-right: 1px solid var(--surface); min-width: 2px; cursor: pointer; }
.pr-wbar i.loss { background: color-mix(in srgb, var(--tool-heat) 55%, var(--surface)); }
.pr-wbar i.load { background: color-mix(in srgb, var(--tool-load) 30%, var(--surface)); }
.pr-wbar i.load.alt { background: color-mix(in srgb, var(--tool-load) 18%, var(--surface)); }
.pr-wbar i.sel { outline: 2px solid var(--accent); outline-offset: -2px; }
.pr-wkey { display: flex; justify-content: space-between; font-size: 11px; color: var(--ink-soft); margin-top: 3px; }

/* inspector */
.pr-insp { padding: 0 0 8px; }
.pr-ih { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.pr-ih h2 { margin: 0; font-size: 12.5px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-ih i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.pr-if { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; padding: 8px 10px 4px; }
.pr-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pr-f.w { grid-column: 1 / -1; }
.pr-f label, .pr-f .l { font-size: 11px; color: var(--ink-soft); }
.pr-f input, .pr-f select { width: 100%; min-width: 0; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.pr-f input.bad { border-color: var(--danger); }
.pr-f[hidden] { display: none; }
.pr-seg { display: flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.pr-seg button { flex: 1; border: 0; background: transparent; padding: 4px 0; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.pr-seg button + button { border-left: 1px solid var(--line); }
.pr-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.pr-read { margin: 4px 10px 0; padding: 6px 8px; background: var(--sunken); border-radius: 4px; font: 11.5px/1.6 "IBM Plex Mono", ui-monospace, monospace; }
.pr-read div { display: flex; justify-content: space-between; gap: 8px; }
.pr-read span { color: var(--ink-soft); font-family: "IBM Plex Sans", sans-serif; }
.pr-iw { margin: 6px 10px 0; font-size: 11.5px; color: var(--danger); }
.pr-iw.warn { color: var(--warn); }
.pr-acts { display: flex; gap: 6px; padding: 8px 10px 0; flex-wrap: wrap; }
.pr-empty { padding: 10px; font-size: 12px; color: var(--ink-soft); }
.pr-warns { display: flex; flex-direction: column; gap: 4px; }
.pr-warns div { font-size: 12px; padding: 5px 8px; border-left: 3px solid var(--warn); background: var(--surface); border-radius: 0 4px 4px 0; cursor: pointer; }
.pr-warns div.bad { border-left-color: var(--danger); }
.pr-more { font-size: 12px; }
.pr-more summary { cursor: pointer; color: var(--ink-soft); padding: 4px 2px; }
.pr-more ul { margin: 0; padding: 0 0 0 16px; color: var(--ink-soft); }
`;

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  const fmt = ctx.fmtNum;
  const fA = (v) => (v == null || !Number.isFinite(v) ? '–' : Math.abs(v) < 1 && v !== 0 ? `${fmt(v * 1000, 3)} mA` : `${fmt(v, 3)} A`);
  const fW = (v) => (v == null || !Number.isFinite(v) ? '–' : Math.abs(v) < 1 && v !== 0 ? `${fmt(v * 1000, 3)} mW` : `${fmt(v, 3)} W`);
  const fV = (v) => (v == null || !Number.isFinite(v) ? '–' : `${fmt(v, 3)} V`);
  const COL = { source: 'var(--tool-src)', switcher: 'var(--tool-sw)', ldo: 'var(--tool-ldo)', load: 'var(--tool-load)' };

  // ---------- DOM ----------
  const tot = h('div', { class: 'pr-tot', 'aria-live': 'polite' });
  const addSrc = h('button', { class: 'pr-btn', onclick: () => addRow({ name: uniq('Input'), parent: '', type: 'source', v: '5', load: '0', limit: '1', eff: '' }) }, '+ Source');
  const svg = sv('svg', { class: 'pr-svg', role: 'group', 'aria-label': 'Power flow from sources to loads; band thickness is power' });
  const hint = h('div', { class: 'pr-hint' }, 'Band thickness = power. Drag the value chips up/down to scrub a current or an efficiency · drag a node onto another rail to move it there · + hangs a new load on a rail · click a node to edit it · on a focused node: ↑↓ change its value, Delete removes it');
  const legend = h('div', { class: 'pr-legend' },
    ...TYPES.map((t) => h('span', {}, h('i', { style: `background:${COL[t]}` }), TYPE_NAME[t])),
    h('span', {}, h('i', { style: 'background:var(--tool-heat)' }), 'loss, to heat'),
    h('span', {}, 'bar under a rail = its current against its rating (tick at 80 %)'));
  const wbar = h('div', { class: 'pr-wbar' });
  const wkey = h('div', { class: 'pr-wkey' });
  const where = h('div', { class: 'pr-where' }, h('h3', {}, 'Where the input power goes'), wbar, wkey);
  const stage = h('section', { class: 'pr-card' }, tot, hint, h('div', { class: 'pr-stage' }, svg), legend, where);
  const warnsEl = h('div', { class: 'pr-warns', role: 'status' });
  const notesEl = h('details', { class: 'pr-more' });
  const insp = h('section', { class: 'pr-card pr-insp', 'aria-label': 'Selected node' });

  root.append(h('div', { class: 'pr' },
    h('div', { class: 'pr-col' }, stage, warnsEl),
    h('div', { class: 'pr-col' }, insp, ctx.outputs, notesEl)));

  // ---------- state ----------
  let sel = null;        // selected row index
  let drag = null;
  let pending = null;
  let lay = null;        // last layout: row -> {x, y, h, ...}
  let frozenS = null;    // px per watt kept steady while scrubbing
  let focusRow = null;

  const rows = () => (Array.isArray(ctx.raw.rails) ? ctx.raw.rails.map((r) => ({ ...r })) : []);
  const setSoon = (obj) => {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  };
  const setRow = (i, patch, soon) => {
    const rs = rows(); if (!rs[i]) return;
    Object.assign(rs[i], patch);
    if (soon) setSoon({ rails: rs }); else ctx.set('rails', rs);
  };
  function uniq(base) {
    const names = new Set(rows().map((r) => String(r.name || '').trim()));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }
  function addRow(r) {
    const rs = rows(); rs.push(r); sel = rs.length - 1; focusRow = sel;
    ctx.set('rails', rs);
  }
  function addLoadUnder(i) {
    const p = rows()[i]; if (!p) return;
    addRow({ name: uniq('New load'), parent: String(p.name || '').trim(), type: 'load', v: '', load: '0.1', limit: '', eff: '' });
  }
  function removeRow(i) {
    const rs = rows(); const r = rs[i]; if (!r) return;
    const nm = String(r.name || '').trim();
    for (const o of rs) if (String(o.parent || '').trim() === nm && nm) o.parent = String(r.parent || '');
    rs.splice(i, 1);
    sel = null; focusRow = null;
    ctx.set('rails', rs);
  }
  function renameRow(i, name) {
    const rs = rows(); const r = rs[i]; if (!r) return;
    const old = String(r.name || '').trim();
    r.name = name;
    if (old) for (const o of rs) if (o !== r && String(o.parent || '').trim() === old) o.parent = name.trim();
    ctx.set('rails', rs);
  }

  // ---------- warnings by node ----------
  function warnMap(ws) {
    const m = new Map();
    for (const w of ws || []) {
      const mm = /^"([^"]+)"/.exec(w);
      if (!mm) continue;
      const lvl = /over its|cannot make|not a number|loop/.test(w) ? 'bad' : 'warn';
      const cur = m.get(mm[1]) || { lvl: 'warn', list: [] };
      if (lvl === 'bad') cur.lvl = 'bad';
      cur.list.push(w);
      m.set(mm[1], cur);
    }
    return m;
  }

  // ---------- layout ----------
  function layout(tree, W, s) {
    const byName = new Map(tree.map((n) => [n.name, n]));
    const kids = new Map(tree.map((n) => [n.name, []]));
    const roots = [];
    for (const n of tree) { if (n.parent && byName.has(n.parent)) kids.get(n.parent).push(n); else roots.push(n); }
    const maxD = Math.max(0, ...tree.map((n) => n.depth));
    const narrow = W < 560;
    const NW = narrow ? 10 : 13, LAB = 38, GAP = narrow ? 10 : 14, L = 8;
    // room for the widest leaf label (a regulator with nothing hung on it carries three lines)
    const isLeaf0 = (n) => !tree.some((t) => t.parent === n.name);
    const leafW = (n) => {
      const heatW = n.loss > 0 ? n.loss * 0 + 24 : 0;
      const l1 = n.name.length * 7 + (n.vout != null && n.type !== 'load' ? 50 : 0);
      const l2 = (n.type === 'load' || n.type === 'switcher' ? 64 : 0) + 110;
      const l3 = n.use != null ? 61 + 15 * 6.4 : 0;
      return heatW + Math.max(l1, l2, l3) + 30;
    };
    const LEAFW = narrow ? 118 : clamp(Math.max(150, ...tree.filter(isLeaf0).map(leafW)), 150, 280);
    const colW = maxD ? Math.max(narrow ? 56 : 150, (W - L - NW - LEAFW) / maxD) : 0;
    // tight columns: each level starts one label lower, so labels never meet side by side
    const stair = narrow || colW < 200;
    const hOf = (n) => Math.max(3, (n.pin ?? n.pout ?? 0) * s);
    const leaf = (n) => !kids.get(n.name).length;
    const heat = (n) => (n.loss > 0 ? n.loss * s : 0);
    const H = new Map();
    const hgt = (n) => {
      let v;
      if (leaf(n)) v = Math.max(hOf(n) + (heat(n) ? 30 : 0), 40 + (n.use != null ? 14 : 0) + (n.loss > 0 ? 14 : 0));
      else {
        const ks = kids.get(n.name);
        const off = stair ? LAB + 8 : leaf(ks[0]) ? LAB : 0;
        const ch = off + ks.reduce((a, k) => a + hgt(k), 0) + GAP * (ks.length - 1) + (n.pload > 0 && n.type !== 'source' ? 24 : 0);
        v = Math.max(LAB + hOf(n) + (heat(n) ? 34 : 0), ch);
      }
      H.set(n.name, v); return v;
    };
    const pos = new Map();
    const place = (n, top) => {
      const x = L + n.depth * colW;
      const lf = leaf(n);
      const ry = lf ? top + Math.max(0, (Math.min(H.get(n.name), 40) - hOf(n)) / 2) * 0 : top + LAB;
      pos.set(n.name, { n, x, y: ry, h: hOf(n), top, leaf: lf });
      if (!lf) {
        const ks = kids.get(n.name);
        let y = top + (stair ? LAB + 8 : leaf(ks[0]) ? LAB : 0);
        for (const k of ks) { place(k, y); y += H.get(k.name) + GAP; }
      }
    };
    let y = 22, total = 22;
    for (const r of roots) { hgt(r); place(r, y); y += H.get(r.name) + 22; }
    total = y;
    return { pos, kids, roots, NW, LAB, colW, narrow, stair, total, s, maxD, LEAFW, W };
  }

  // ---------- draw ----------
  function draw() {
    const res = ctx.result || {};
    const tree = res.tree || [];
    svg.replaceChildren();
    const W = Math.max(300, svg.parentElement.clientWidth - 12);
    if (!tree.length) { svg.setAttribute('viewBox', `0 0 ${W} 60`); svg.append(sv('text', { x: 10, y: 30, class: 'pr-meta' }, (res.warnings || [])[0] || 'Add a source.')); return; }
    const wm = warnMap(res.warnings);
    // px per watt: fit the tallest stack into the room the page has
    const top = svg.getBoundingClientRect().top + window.scrollY;
    const avail = W < 560 ? Math.max(560, window.innerHeight * 0.9) : Math.max(320, window.innerHeight - top - 120);
    const pmax = Math.max(1e-6, ...tree.filter((n) => !n.parent).map((n) => n.pin ?? n.pout ?? 0));
    let s = frozenS;
    if (s == null) {
      const fixed = layout(tree, W, 0).total;
      s = Math.max(0, (avail - fixed) * 0.9 / pmax);
      for (let it = 0; it < 4; it++) {
        const t = layout(tree, W, s).total;
        if (t <= avail || s < 1e-6) break;
        s *= Math.max(0.2, (avail - fixed) / Math.max(1, t - fixed));
      }
      s = Math.min(s, 260 / pmax);
    }
    const Lo = layout(tree, W, s);
    lay = Lo;
    const H = Math.max(Lo.total + 10, 120);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const { pos, kids, NW } = Lo;

    // links (under everything)
    const gL = sv('g'); svg.append(gL);
    const gN = sv('g'); svg.append(gN);
    const band = (x1, y1a, y1b, x2, y2a, y2b) => {
      const mx = (x1 + x2) / 2;
      return `M${x1},${y1a}C${mx},${y1a} ${mx},${y2a} ${x2},${y2a}L${x2},${y2b}C${mx},${y2b} ${mx},${y1b} ${x1},${y1b}Z`;
    };
    for (const [, P] of pos) {
      const n = P.n;
      const x1 = P.x + NW;
      let yy = P.y;
      const pin = Math.max(1e-12, n.pin ?? n.pout ?? 0);
      const k = P.h / pin;  // this node's own px per watt (its bar may have a minimum height)
      for (const c of kids.get(n.name)) {
        const C = pos.get(c.name);
        const hh = Math.max(0.8, (c.pin ?? 0) * k);
        gL.append(sv('path', { d: band(x1, yy, yy + hh, C.x, C.y, C.y + C.h), class: `pr-link${sel === c.row || sel === n.row ? ' sel' : ''}`, fill: COL[n.type] }));
        yy += hh;
      }
      if (n.pload > 0 && n.type !== 'load' && kids.get(n.name).length) {
        const hh = Math.max(1, n.pload * k);
        const x2 = x1 + 34, y2 = yy;
        gL.append(sv('path', { d: `M${x1},${yy}H${x2}L${x2 + 7},${yy + hh / 2}L${x2},${yy + hh}H${x1}Z`, class: 'pr-direct', fill: COL[n.type] }));
        gL.append(sv('text', { x: x2 + 11, y: y2 + hh / 2 + 4, class: 'pr-val pr-halo' }, `on rail ${fA(n.load)}`));
        yy += hh;
      } else if (n.pload > 0 && n.type !== 'load') yy += n.pload * k;
      if (n.loss > 0) {
        const lh = Math.max(1.5, n.loss * k);
        const y0 = Math.min(yy, P.y + P.h - lh), y1 = y0 + lh, r = 7, R = r + lh;
        const yEnd = y1 + r + 12;
        const hot = (wm.get(n.name)?.list || []).some((w) => /dissipates/.test(w));
        gL.append(sv('path', { d: `M${x1},${y0}A${R},${R} 0 0 1 ${x1 + R},${y0 + R}V${yEnd}L${x1 + r + lh / 2},${yEnd + 7}L${x1 + r},${yEnd}V${y1 + r}A${r},${r} 0 0 0 ${x1},${y1}Z`, class: `pr-heat${hot ? ' hot' : ''}` }));
        if (!Lo.stair && !P.leaf) gL.append(sv('text', { x: x1 + R + 5, y: yEnd + 2, class: 'pr-heatt pr-halo', 'font-weight': hot ? 700 : 400 }, `${fW(n.loss)} heat${hot ? ' — hot' : ''}`));
      }
    }

    // nodes
    for (const [, P] of pos) {
      const n = P.n, w = wm.get(n.name);
      const cls = `pr-node${sel === n.row ? ' sel' : ''}${w ? ` ${w.lvl}` : ''}`;
      const g = sv('g', { class: cls, 'data-row': n.row, tabindex: 0, role: 'button',
        'aria-label': `${n.name}, ${TYPE_NAME[n.type]}${n.vout != null ? `, ${fmt(n.vout, 3)} V` : ''}, ${fA(n.iout)} out${n.use != null ? `, ${Math.round(n.use * 100)} % of rating` : ''}. ${n.type === 'load' ? 'Up/down change its current.' : n.type === 'switcher' ? 'Up/down change its efficiency.' : 'Up/down change its rating.'} Drag onto another rail to move it.` });
      g.append(sv('rect', { x: P.x - 4, y: P.y - 4, width: NW + 8, height: P.h + 8, class: 'hit' }));
      g.append(sv('rect', { x: P.x, y: P.y, width: NW, height: P.h, rx: 2, class: 'bar', fill: COL[n.type] }));
      g.append(sv('rect', { x: P.x - 3, y: P.y - 3, width: NW + 6, height: P.h + 6, rx: 4, class: 'ring' }));
      g.append(sv('title', {}, `${n.name}\n${TYPE_NAME[n.type]}${n.vout != null ? ` · ${fmt(n.vout, 4)} V` : ''}\nout ${fA(n.iout)} · in ${fA(n.iin)}\n${n.pout != null ? `P out ${fW(n.pout)}` : ''}${n.loss ? ` · loss ${fW(n.loss)}` : ''}${w ? `\n\n${w.list.join('\n')}` : ''}`));
      gN.append(g);
      labels(P, n, w);
    }

    function labels(P, n, w) {
      const narrow = Lo.narrow;
      let lx, ly;
      if (P.leaf) { lx = P.x + NW + 7 + (n.loss > 0 ? Math.max(1.5, n.loss * (P.h / Math.max(1e-12, n.pin ?? n.pout ?? 0))) + 12 : 0); ly = Math.max(P.y + Math.min(P.h, 40) / 2 - 6, P.y + 5); }
      else { lx = P.x; ly = P.y - 26; }
      const nm = sv('text', { x: lx, y: ly, class: 'pr-name pr-halo' }, n.name);
      if (n.type !== 'load' && n.vout != null) nm.append(sv('tspan', { class: 'pr-meta', dx: 5 }, `${fmt(n.vout, 3)} V${n.type === 'ldo' ? ' LDO' : ''}`));
      gN.append(nm);
      let cx = lx; const cy = ly + 5;
      // value chip: a load's current, a switcher's efficiency
      if (n.type === 'load' || n.type === 'switcher') {
        const isLoad = n.type === 'load';
        const txt = isLoad ? fA(n.load) : `η ${fmt(n.eff, 3)} %`;
        const cw = txt.length * 7 + 12;
        const chip = sv('g', { class: `pr-chip${drag?.kind === 'scrub' && drag.row === n.row ? ' on' : ''}`, 'data-scrub': isLoad ? 'load' : 'eff', 'data-row': n.row, tabindex: 0, role: 'slider',
          'aria-label': isLoad ? `${n.name} current` : `${n.name} efficiency`, 'aria-valuetext': txt });
        chip.append(sv('rect', { x: cx, y: cy, width: cw, height: 17, rx: 3 }));
        chip.append(sv('text', { x: cx + 6, y: cy + 12.5 }, txt));
        chip.append(sv('title', {}, isLoad ? 'Drag up/down to change the current (arrow keys when focused)' : 'Drag up/down to change the efficiency (arrow keys when focused)'));
        gN.append(chip);
        cx += cw + 6;
      }
      const vtxt = n.type === 'load' ? fW(n.pout) : `${fA(n.iout)}${narrow ? '' : ` · ${fW(n.pout)}`}`;
      const vt = sv('text', { x: cx, y: cy + 12.5, class: 'pr-val pr-halo' }, vtxt);
      gN.append(vt);
      cx += vtxt.length * 6.7 + 8;
      if (Lo.stair && !P.leaf && n.loss > 0) {   // no room beside the heat band: the loss goes on the label line
        const ht = ` ${fW(n.loss)} heat`;
        vt.append(sv('tspan', { class: 'pr-heatt' }, ht));
        cx += ht.length * 6.7;
      }
      if (P.leaf && n.loss > 0) gN.append(sv('text', { x: lx, y: cy + (n.use != null ? 42 : 29), class: 'pr-heatt pr-halo' }, `${fW(n.loss)} heat`));
      // rating gauge, after the values on the same line
      if (n.use != null && n.limit > 0) {
        const gw = narrow ? 36 : 56;
        const tone = n.use > 1 ? 'bad' : n.use > 0.8 ? 'warn' : 'ok';
        const gg = sv('g', { class: 'pr-gauge', 'pointer-events': 'none' });
        // where it fits before the next column: after the name, after the values, or short
        const room = P.leaf || Lo.stair ? Lo.W - lx - 8 : Lo.colW - 12;
        const gtxtFull = `${Math.round(n.use * 100)} % of ${fA(n.limit)}`;
        const nameW = n.name.length * 7 + (n.vout != null ? 46 : 0) + 10;
        const needG = gw + 8 + gtxtFull.length * 6.4;
        let bx = cx, by = cy + 6, gtxt = gtxtFull;
        if (P.leaf) { bx = lx; by = cy + 23; }
        else if (cx - lx + needG > room) {
          if (nameW + needG <= room) { bx = lx + nameW; by = ly - 7; }
          else gtxt = `${Math.round(n.use * 100)} %`;
        }
        gg.append(sv('rect', { x: bx, y: by, width: gw, height: 5, rx: 2.5, class: 'tr' }));
        gg.append(sv('rect', { x: bx, y: by, width: Math.max(1, Math.min(1, n.use) * gw), height: 5, rx: 2.5, class: `fl ${tone}` }));
        gg.append(sv('line', { x1: bx + 0.8 * gw, x2: bx + 0.8 * gw, y1: by - 2, y2: by + 7, class: 'tk' }));
        gN.append(gg);
        gN.append(sv('text', { x: bx + gw + 5, y: by + 6, class: `pr-gt pr-halo ${tone === 'ok' ? '' : tone}` }, gtxt));
      }
      if (w) {
        const bx = lx - 12, by = ly - 4;
        const b = sv('g', { class: `pr-bang ${w.lvl}` });
        b.append(sv('circle', { cx: P.leaf ? P.x - 9 : bx + 2, cy: P.leaf ? P.y + Math.min(P.h, 40) / 2 : by, r: 6 }));
        b.append(sv('text', { x: P.leaf ? P.x - 9 : bx + 2, y: (P.leaf ? P.y + Math.min(P.h, 40) / 2 : by) + 3.5 }, '!'));
        b.append(sv('title', {}, w.list.join('\n')));
        gN.append(b);
      }
      // + : hang a new load on this rail
      if (n.type !== 'load') {
        const px = P.x + NW / 2, py = P.y + P.h + 12 + (n.loss > 0 ? 0 : 0);
        const pl = sv('g', { class: 'pr-plus', 'data-plus': n.row, tabindex: 0, role: 'button', 'aria-label': `Add a load on ${n.name}` });
        pl.append(sv('circle', { cx: px, cy: py, r: 7 }));
        pl.append(sv('path', { d: `M${px - 3.5},${py}H${px + 3.5}M${px},${py - 3.5}V${py + 3.5}` }));
        pl.append(sv('title', {}, `Hang a new load on ${n.name}`));
        gN.append(pl);
      }
    }
    if (drag?.kind === 'move' && drag.moved) markDrop();
  }

  // ---------- pointer ----------
  function pt(e) {
    const m = svg.getScreenCTM(); if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }
  const descendants = (row) => {
    const tree = ctx.result?.tree || [];
    const n = tree.find((t) => t.row === row); if (!n) return new Set();
    const out = new Set([n.name]);
    let grew = true;
    while (grew) { grew = false; for (const t of tree) if (!out.has(t.name) && out.has(t.parent)) { out.add(t.name); grew = true; } }
    return out;
  };
  function markDrop() {
    const tree = ctx.result?.tree || [];
    const bad = descendants(drag.row);
    for (const g of svg.querySelectorAll('.pr-node')) {
      const r = Number(g.dataset.row), n = tree.find((t) => t.row === r);
      const ok = n && n.type !== 'load' && !bad.has(n.name);
      g.classList.toggle('drop-ok', !!ok);
      g.classList.toggle('drop-hover', !!ok && drag.over === r);
    }
  }
  svg.addEventListener('pointerdown', (e) => {
    const plus = e.target.closest('[data-plus]');
    if (plus) { e.preventDefault(); addLoadUnder(Number(plus.dataset.plus)); return; }
    const chip = e.target.closest('[data-scrub]');
    const node = e.target.closest('.pr-node');
    if (!chip && !node) return;
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const q = pt(e);
    if (chip) {
      const row = Number(chip.dataset.row), key = chip.dataset.scrub;
      const r = rows()[row] || {};
      const v0 = key === 'eff' ? (ctx.parseEng(String(r.eff ?? '')) ?? 85) : (ctx.parseEng(String(r.load ?? '')) ?? 0);
      drag = { kind: 'scrub', row, key, y0: q.y, v0 };
      frozenS = lay?.s ?? null;
      if (sel !== row) { sel = row; drawInspector(); }
      chip.focus({ preventScroll: true }); focusRow = null;
      return;
    }
    const row = Number(node.dataset.row);
    drag = { kind: 'move', row, x0: q.x, y0: q.y, moved: false, over: null };
    sel = row; focusRow = row;
    node.focus({ preventScroll: true });
    markSel(); drawInspector();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const q = pt(e);
    if (drag.kind === 'scrub') {
      const dy = drag.y0 - q.y;
      let v;
      if (drag.key === 'eff') v = String(Math.round(clamp(drag.v0 + dy / 3, 30, 99)));
      else {
        const base = drag.v0 > 0 ? drag.v0 : 0.01;
        v = String(sig2(clamp(base * Math.pow(1.015, dy), 0.001, 100)));
        if (drag.v0 <= 0 && dy <= 0) v = '0';
      }
      setRow(drag.row, { [drag.key]: v }, true);
      return;
    }
    if (!drag.moved && Math.hypot(q.x - drag.x0, q.y - drag.y0) < 6) return;
    drag.moved = true;
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.pr-node');
    drag.over = hit ? Number(hit.dataset.row) : null;
    markDrop();
    let gh = svg.querySelector('.pr-ghost');
    if (!gh) { gh = sv('circle', { r: 9, class: 'pr-ghost' }); svg.append(gh); }
    gh.setAttribute('cx', q.x); gh.setAttribute('cy', q.y);
  });
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    svg.querySelector('.pr-ghost')?.remove();
    for (const g of svg.querySelectorAll('.drop-ok, .drop-hover')) g.classList.remove('drop-ok', 'drop-hover');
    if (d.kind === 'scrub') { frozenS = null; requestAnimationFrame(() => { draw(); }); return; }
    if (d.moved && d.over != null && d.over !== d.row) {
      const tree = ctx.result?.tree || [];
      const tgt = tree.find((t) => t.row === d.over);
      if (tgt && tgt.type !== 'load' && !descendants(d.row).has(tgt.name)) {
        const rs = rows();
        rs[d.row].parent = tgt.name;
        if (rs[d.row].type === 'source') rs[d.row].type = 'load';
        ctx.set('rails', rs);
      }
    }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  // ---------- keyboard ----------
  svg.addEventListener('keydown', (e) => {
    const chip = e.target.closest?.('[data-scrub]');
    const node = e.target.closest?.('.pr-node');
    const plus = e.target.closest?.('[data-plus]');
    if (plus && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); addLoadUnder(Number(plus.dataset.plus)); return; }
    const row = chip ? Number(chip.dataset.row) : node ? Number(node.dataset.row) : null;
    if (row == null) return;
    const r = rows()[row]; if (!r) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = row; markSel(); drawInspector(); insp.querySelector('input')?.focus(); return; }
    if (node && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removeRow(row); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const up = e.key === 'ArrowUp';
    const key = chip ? chip.dataset.scrub : r.type === 'load' ? 'load' : r.type === 'switcher' ? 'eff' : 'limit';
    const cur = ctx.parseEng(String(r[key] ?? '')) ?? (key === 'eff' ? 85 : 0);
    let v;
    if (key === 'eff') v = clamp(cur + (up ? 1 : -1) * (e.shiftKey ? 5 : 1), 1, 100);
    else { const f = e.shiftKey ? 1.5 : 1.1; v = cur > 0 ? sig2(up ? cur * f : cur / f) : (up ? 0.01 : 0); }
    focusKey = chip ? `chip:${row}:${key}` : `node:${row}`;
    setRow(row, { [key]: String(v) });
  });
  let focusKey = null;
  svg.addEventListener('focusin', (e) => {
    const c = e.target.closest?.('[data-scrub]'), n = e.target.closest?.('.pr-node'), p = e.target.closest?.('[data-plus]');
    focusKey = c ? `chip:${c.dataset.row}:${c.dataset.scrub}` : n ? `node:${n.dataset.row}` : p ? `plus:${p.dataset.plus}` : null;
  });
  function restoreFocus() {
    let k = focusKey;
    if (focusRow != null) { k = `node:${focusRow}`; focusRow = null; }
    if (!k) return;
    if (document.activeElement && document.activeElement !== document.body && !svg.contains(document.activeElement)) return;
    const [t, r, key] = k.split(':');
    const el = t === 'chip' ? svg.querySelector(`[data-scrub="${key}"][data-row="${r}"]`) : t === 'node' ? svg.querySelector(`.pr-node[data-row="${r}"]`) : svg.querySelector(`[data-plus="${r}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }
  function markSel() {
    for (const g of svg.querySelectorAll('.pr-node')) g.classList.toggle('sel', Number(g.dataset.row) === sel);
    for (const i of wbar.querySelectorAll('i')) i.classList.toggle('sel', Number(i.dataset.row) === sel);
  }

  // ---------- totals ----------
  function drawTotals(res) {
    const T = res.totals || {};
    const vals = res.values || [];
    const lost = vals.find((v) => /^Lost/.test(v.label));
    const srcs = vals.filter((v) => / current$/.test(v.label));
    tot.replaceChildren(
      h('div', {}, h('span', {}, 'Input power'), h('b', {}, fW(T.pIn))),
      h('div', {}, h('span', {}, 'Delivered to loads'), h('b', {}, fW(T.pLoad))),
      h('div', {}, h('span', {}, 'Lost in regulators'), h('b', { class: lost?.tone === 'warn' ? 'warn' : '' }, fW(T.pLoss))),
      h('div', {}, h('span', {}, 'Efficiency'), h('b', {}, T.eff != null ? `${fmt(T.eff * 100, 3)} %` : '–')),
      ...srcs.map((v) => h('div', {}, h('span', {}, v.label), h('b', { class: v.tone === 'bad' ? 'bad' : v.tone === 'warn' ? 'warn' : '' }, v.value), h('em', {}, ` ${v.hint || ''}`))),
      h('div', { class: 'grow' }, addSrc));
  }

  // ---------- where the watts go ----------
  function drawWhere(res) {
    const tree = res.tree || [], T = res.totals || {};
    const segs = [];
    for (const n of tree) {
      if (n.type === 'load' && n.pout > 0) segs.push({ row: n.row, name: n.name, p: n.pout, kind: 'load' });
      else if (n.type !== 'load' && n.pload > 0) segs.push({ row: n.row, name: `${n.name} (on rail)`, p: n.pload, kind: 'load' });
      if (n.loss > 0) segs.push({ row: n.row, name: `${n.name} loss`, p: n.loss, kind: 'loss' });
    }
    const sum = segs.reduce((a, b) => a + b.p, 0) || 1;
    let alt = false;
    wbar.replaceChildren(...segs.map((sg) => {
      const pct = (100 * sg.p) / sum;
      if (sg.kind === 'load') alt = !alt;
      const i = h('i', { class: `${sg.kind}${sg.kind === 'load' && !alt ? ' alt' : ''}${sel === sg.row ? ' sel' : ''}`, 'data-row': sg.row, style: `width:${pct}%`, title: `${sg.name}: ${fW(sg.p)} (${fmt(pct, 3)} %)` },
        pct > 9 ? sg.name.replace(/ \(on rail\)$/, '') : '');
      i.addEventListener('click', () => { sel = sg.row; markSel(); drawInspector(); });
      return i;
    }));
    wkey.replaceChildren(h('span', {}, `loads ${fW(T.pLoad)}`), h('span', { style: 'color:var(--tool-heat)' }, `heat ${fW(T.pLoss)}`), h('span', {}, `input ${fW(T.pIn)}`));
  }

  // ---------- inspector ----------
  let inspSig = '';
  function drawInspector(force) {
    const rs = rows(), tree = ctx.result?.tree || [];
    const r = sel != null ? rs[sel] : null;
    if (!r) {
      inspSig = '';
      insp.replaceChildren(h('div', { class: 'pr-ih' }, h('h2', {}, 'Inspector')),
        h('div', { class: 'pr-empty' }, 'Click a rail or a load in the flow to edit it. Its currents, power and rating use show here.'));
      return;
    }
    const n = tree.find((t) => t.row === sel);
    const sig = `${sel}|${r.type}|${rs.length}|${rs.map((o) => o.name).join(',')}`;
    const focusedInside = insp.contains(document.activeElement);
    if (sig !== inspSig || force || !focusedInside) {
      inspSig = sig;
      const fld = (key, label, unit, wide) => {
        const inp = h('input', { id: `pr-i-${key}`, 'data-k': key, spellcheck: 'false', inputmode: key === 'name' ? null : 'decimal' });
        inp.value = r[key] ?? '';
        inp.addEventListener('input', () => { if (key === 'name') renameRow(sel, inp.value); else setRow(sel, { [key]: inp.value }); });
        return h('div', { class: `pr-f${wide ? ' w' : ''}` }, h('label', { for: `pr-i-${key}` }, `${label}${unit ? ` (${unit})` : ''}`), inp);
      };
      const seg = h('div', { class: 'pr-seg', role: 'group', 'aria-label': 'Type' },
        TYPES.map((t) => h('button', { 'aria-pressed': String(r.type === t), onclick: () => setRow(sel, { type: t }) }, TYPE_NAME[t])));
      const bad = descendants(sel);
      const parentSel = h('select', { id: 'pr-i-parent' },
        h('option', { value: '' }, '(none: a root)'),
        rs.filter((o, i) => i !== sel && o.type !== 'load' && !bad.has(String(o.name).trim())).map((o) =>
          h('option', { value: String(o.name).trim(), selected: String(o.name).trim() === String(r.parent || '').trim() }, String(o.name))));
      parentSel.addEventListener('change', () => setRow(sel, { parent: parentSel.value }));
      const isLoad = r.type === 'load';
      insp.replaceChildren(
        h('div', { class: 'pr-ih' }, h('i', { style: `background:${COL[r.type] || COL.load}` }), h('h2', {}, String(r.name || `row ${sel + 1}`))),
        h('div', { class: 'pr-if' },
          fld('name', 'Name', '', true),
          h('div', { class: 'pr-f w' }, h('span', { class: 'l' }, 'Type'), seg),
          r.type !== 'source' ? h('div', { class: 'pr-f w' }, h('label', { for: 'pr-i-parent' }, 'Fed from'), parentSel) : null,
          isLoad ? null : fld('v', 'V out', 'V'),
          fld('load', isLoad ? 'Current' : 'Load on this rail', 'A'),
          isLoad ? null : fld('limit', 'Rating', 'A'),
          r.type === 'switcher' ? fld('eff', 'Efficiency', '%') : null),
        h('div', { class: 'pr-read' }),
        h('div', { class: 'pr-iws' }),
        h('div', { class: 'pr-acts' },
          isLoad ? null : h('button', { class: 'pr-btn', onclick: () => addLoadUnder(sel) }, '+ Load on this rail'),
          h('button', { class: 'pr-btn danger', onclick: () => removeRow(sel) }, 'Delete')));
    } else {
      for (const inp of insp.querySelectorAll('input[data-k]')) if (document.activeElement !== inp) inp.value = r[inp.dataset.k] ?? '';
    }
    for (const inp of insp.querySelectorAll('input[data-k]')) {
      const k = inp.dataset.k;
      inp.classList.toggle('bad', k !== 'name' && String(r[k] ?? '').trim() !== '' && ctx.parseEng(String(r[k]).replace(/%$/, '')) == null);
    }
    const read = insp.querySelector('.pr-read');
    if (read) {
      read.replaceChildren(...(n ? [
        ['Rail', n.type === 'load' ? `${fV(n.vin)} (its feed)` : `${fV(n.vin)} in → ${fV(n.vout)} out`],
        ['Current out', fA(n.iout)], ['Current drawn from feed', n.type === 'source' ? '–' : fA(n.iin)],
        ['Power out', fW(n.pout)], ...(n.loss ? [['Loss', fW(n.loss)]] : []),
        ...(n.use != null ? [['Rating use', `${Math.round(n.use * 100)} % of ${fA(n.limit)}`]] : []),
      ] : [['Not in the tree', 'see the warnings']]).map(([a, b]) => h('div', {}, h('span', {}, a), h('b', {}, b))));
    }
    const iws = insp.querySelector('.pr-iws');
    if (iws) {
      const w = warnMap(ctx.result?.warnings).get(n?.name);
      iws.replaceChildren(...(w ? w.list.map((t) => h('div', { class: `pr-iw${/over its|cannot make/.test(t) ? '' : ' warn'}` }, t)) : []));
    }
  }

  ctx.onResult((res) => {
    const rs = rows();
    if (sel != null && sel >= rs.length) sel = null;
    drawTotals(res);
    if (!(drag && drag.kind === 'move')) draw();
    restoreFocus();
    drawWhere(res);
    drawInspector();
    const wm = warnMap(res.warnings);
    warnsEl.replaceChildren(...(res.warnings || []).map((t) => {
      const mm = /^"([^"]+)"/.exec(t);
      const n = mm ? (res.tree || []).find((x) => x.name === mm[1]) : null;
      const d = h('div', { class: wm.get(mm?.[1])?.lvl === 'bad' && /over its|cannot make/.test(t) ? 'bad' : '' }, t);
      if (n) d.addEventListener('click', () => { sel = n.row; markSel(); drawInspector(); svg.querySelector(`.pr-node[data-row="${n.row}"]`)?.focus(); });
      return d;
    }));
    notesEl.replaceChildren(h('summary', {}, 'Method and assumptions'), h('ul', {}, (res.notes || []).map((t) => h('li', {}, t))));
  });
  let rt = null;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (!drag) draw(); }, 60); }).observe(stage);
}
