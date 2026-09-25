// PCB Weight & CoG page: the populated board as a drawing sheet in three views
// (top, front edge, right edge), to scale, sharing their axes the way a
// mechanical drawing does. Parts are discs whose area is their mass; pick one
// up and move it (top view: x and y; the edge views: along the edge, and across
// the board to flip it to the other side), drag the board's corner to resize
// it, and the centre of gravity moves in all three views. The ledger beside the
// sheet weighs the board layer by layer. Every mass, share and CoG coordinate
// drawn comes from tool.js run() (result.drawing / result.values).

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
const snap = (v, st) => Math.round(v / st) * st;
const str = (v) => String(Number(Number(v).toFixed(2)));

const CSS = `
:root { --tool-lam: #3f7d5a; --tool-lam-f: #d8eadc; --tool-cu: #a8522a; --tool-mask: #1d5a73;
  --tool-top: #d99a0b; --tool-bot: #7c5cc4; --tool-cog: var(--accent); --tool-zone: rgba(47,133,90,.10); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --tool-lam: #5fae83; --tool-lam-f: #17302a; --tool-cu: #d9804a; --tool-mask: #4fa3c4;
  --tool-top: #f2c14e; --tool-bot: #a78bfa; --tool-zone: rgba(104,179,107,.12); } }
:root[data-theme="dark"] { --tool-lam: #5fae83; --tool-lam-f: #17302a; --tool-cu: #d9804a; --tool-mask: #4fa3c4;
  --tool-top: #f2c14e; --tool-bot: #a78bfa; --tool-zone: rgba(104,179,107,.12); }

.k-page { padding: 12px; }
.pw { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) 340px; align-items: start; }
@media (max-width: 1080px) { .pw { grid-template-columns: minmax(0, 1fr); } }
.pw-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.pw-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }

/* build strip: the board itself */
.pw-build { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 7px 10px; }
.pw-grp { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.pw-grp b { color: var(--ink); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; margin-right: 2px; }
.pw-in { width: 52px; padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; color: var(--ink); }
.pw-in.bad { border-color: var(--danger); }
.pw-in.w2 { width: 40px; }
.pw-sel { padding: 3px 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font-size: 12px; max-width: 160px; }
.pw-step { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.pw-step button { border: 0; background: var(--surface); width: 22px; cursor: pointer; font-size: 13px; color: var(--ink-soft); }
.pw-step button:hover { background: var(--sunken); color: var(--ink); }
.pw-step span { min-width: 22px; text-align: center; font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); background: var(--sunken); padding: 2px 3px; }
.pw-chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--ink-soft); cursor: pointer; }

/* the sheet */
.pw-sheet { position: relative; padding: 6px 8px 4px; }
.pw-svg { display: block; width: 100%; overflow: visible; touch-action: none; user-select: none; -webkit-user-select: none; }
.pw-hint { font-size: 11.5px; color: var(--ink-soft); padding: 0 2px 4px; }
.pw-hint .short { display: none; }
@media (max-width: 600px) { .pw-hint .long { display: none; } .pw-hint .short { display: inline; } }
.pw-vt { font: 600 10.5px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); letter-spacing: .06em; text-transform: uppercase; }
.pw-dim { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.pw-dl { stroke: var(--ink-soft); stroke-width: .8; fill: none; }
.pw-grid { stroke: var(--line-soft); stroke-width: 1; }
.pw-board { fill: var(--tool-lam-f); stroke: var(--tool-lam); stroke-width: 1.5; }
.pw-slab { fill: var(--tool-lam); }
.pw-cu { fill: var(--tool-cu); }
.pw-zone { fill: var(--tool-zone); stroke: var(--ok); stroke-width: 1; stroke-dasharray: 4 3; }
.pw-ctr { stroke: var(--ink-soft); stroke-width: 1; }
.pw-part { cursor: grab; outline: none; }
.pw-part:active { cursor: grabbing; }
.pw-part .b { stroke-width: 1.5; }
.pw-part.top .b { fill: var(--tool-top); fill-opacity: .55; stroke: var(--tool-top); }
.pw-part.bottom .b { fill: var(--tool-bot); fill-opacity: .18; stroke: var(--tool-bot); stroke-dasharray: 4 2.5; }
.pw-part.bad .b { stroke: var(--danger); stroke-width: 2.2; }
.pw-part .ring { fill: none; stroke: var(--accent); stroke-width: 2; opacity: 0; }
.pw-part.sel .ring { opacity: 1; }
.pw-part:focus-visible .ring { opacity: 1; stroke-dasharray: 4 2; }
.pw-plab { font: 11px "IBM Plex Sans", sans-serif; fill: var(--ink); pointer-events: none; }
.pw-plab.soft { fill: var(--ink-soft); }
.pw-halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.pw-warn { font: 600 11px "IBM Plex Sans", sans-serif; fill: var(--danger); pointer-events: none; }
.pw-cog .o { fill: var(--surface); stroke: var(--tool-cog); stroke-width: 2; }
.pw-cog .q { fill: var(--tool-cog); }
.pw-cog.off .o { stroke: var(--warn); } .pw-cog.off .q { fill: var(--warn); }
.pw-cogt { font: 600 11.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--tool-cog); }
.pw-cogt.off { fill: var(--warn); }
.pw-arm { stroke: var(--tool-cog); stroke-width: 1.2; stroke-dasharray: 3 3; }
.pw-arm.off { stroke: var(--warn); }
.pw-corner { fill: var(--surface); stroke: var(--tool-lam); stroke-width: 2; cursor: nwse-resize; outline: none; }
.pw-corner:focus-visible { stroke: var(--accent); stroke-width: 3; }
.pw-tb { fill: var(--sunken); stroke: var(--line); }
.pw-tbk { font: 10.5px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); }
.pw-tbv { font: 600 12.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.pw-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11.5px; color: var(--ink-soft); padding: 4px 4px 6px; }
.pw-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: -1px; margin-right: 5px; }

/* ledger */
.pw-led { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.pw-tot { display: flex; align-items: baseline; gap: 8px; }
.pw-tot b { font: 600 30px/1 "IBM Plex Mono", ui-monospace, monospace; }
.pw-tot span { color: var(--ink-soft); font-size: 13px; }
.pw-bar { display: flex; height: 16px; border-radius: 3px; overflow: hidden; background: var(--sunken); }
.pw-bar i { display: block; height: 100%; border-right: 1px solid var(--surface); min-width: 1px; }
.pw-rows { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto auto; gap: 2px 8px; font-size: 12px; align-items: center; }
.pw-rows i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.pw-rows .n { color: var(--ink-soft); font: 12px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.pw-rows .m { font: 12px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.pw-cogrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.pw-cogrow div { background: var(--sunken); border-radius: 4px; padding: 4px 7px; }
.pw-cogrow span { display: block; font-size: 10.5px; color: var(--ink-soft); }
.pw-cogrow b { font: 600 14px "IBM Plex Mono", ui-monospace, monospace; }
.pw-cogrow em { display: block; font-style: normal; font-size: 10.5px; color: var(--ink-soft); }

/* parts list */
.pw-ph { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.pw-ph h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.pw-ph .g { flex: 1; }
.pw-btn { padding: 3px 9px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 12px; }
.pw-btn:hover { border-color: var(--ink-soft); }
.pw-list { display: flex; flex-direction: column; }
.pw-row { display: grid; grid-template-columns: minmax(0, 1fr) 58px 58px 44px 22px; gap: 4px 6px; align-items: center;
  padding: 5px 10px 6px; border-bottom: 1px solid var(--line-soft); border-left: 3px solid transparent; }
.pw-row.sel { background: var(--sunken); border-left-color: var(--accent); }
.pw-row .nm { min-width: 0; border: 1px solid transparent; background: transparent; padding: 2px 4px; border-radius: 3px; font-size: 12.5px; font-weight: 500; }
.pw-row .nm:hover, .pw-row .nm:focus { border-color: var(--line); background: var(--sunken); }
.pw-row .pw-in { width: 100%; }
.pw-row .sb { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ink-soft); }
.pw-row .sb .tr { flex: 1; height: 4px; background: var(--line-soft); border-radius: 2px; overflow: hidden; }
.pw-row .sb .tr i { display: block; height: 100%; }
.pw-row .x { border: 0; background: transparent; cursor: pointer; color: var(--ink-soft); font-size: 14px; padding: 0; }
.pw-row .x:hover { color: var(--danger); }
.pw-side { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.pw-side button { border: 0; background: transparent; padding: 2px 0; width: 29px; font-size: 11px; cursor: pointer; color: var(--ink-soft); }
.pw-side button + button { border-left: 1px solid var(--line); }
.pw-side button[aria-pressed="true"].t { background: var(--tool-top); color: #1b1206; font-weight: 600; }
.pw-side button[aria-pressed="true"].b { background: var(--tool-bot); color: #fff; font-weight: 600; }
.pw-lh { display: grid; grid-template-columns: minmax(0, 1fr) 58px 58px 44px 22px; gap: 6px; padding: 4px 10px 2px 13px; font-size: 10.5px; color: var(--ink-soft); }
.pw-warns { display: flex; flex-direction: column; gap: 4px; }
.pw-warns div { font-size: 12px; padding: 5px 8px; border-left: 3px solid var(--danger); background: var(--surface); border-radius: 0 4px 4px 0; }
.pw-warns div.n { border-left-color: var(--warn); }
.pw-more { font-size: 12px; }
.pw-more summary { cursor: pointer; color: var(--ink-soft); padding: 6px 2px; }
.pw-more ul { margin: 0; padding: 0 0 0 16px; color: var(--ink-soft); }
`;

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  const fmt = ctx.fmtNum;

  // ---------- build strip ----------
  const fld = (key, label, unit, cls = '') => {
    const inp = h('input', { class: `pw-in ${cls}`, id: `pw-${key}`, type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label}${unit ? ` in ${unit}` : ''}` });
    inp.addEventListener('input', () => ctx.set(key, inp.value));
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const v = ctx.parseEng(inp.value); if (v == null) return;
      e.preventDefault();
      const st = key === 'thick' ? 0.1 : /Cov$/.test(key) ? 5 : /Oz$/.test(key) ? 0.5 : 1;
      const nv = Math.max(0, snap(v + (e.key === 'ArrowUp' ? st : -st) * (e.shiftKey ? 10 : 1), st / 10));
      inp.value = str(nv); ctx.set(key, inp.value);
    });
    bind[key] = inp;
    return inp;
  };
  const bind = {};
  const matSel = h('select', { class: 'pw-sel', 'aria-label': 'Laminate' },
    (ctx.manifest.inputs.find((d) => d.key === 'material').options).map(([v, t]) => h('option', { value: v }, t)));
  matSel.addEventListener('change', () => ctx.set('material', matSel.value));
  const layN = h('span', { 'aria-live': 'polite' });
  const layStep = h('span', { class: 'pw-step' },
    h('button', { 'aria-label': 'Fewer copper layers', onclick: () => stepLayers(-1) }, '−'), layN,
    h('button', { 'aria-label': 'More copper layers', onclick: () => stepLayers(1) }, '+'));
  const stepLayers = (d) => {
    const n = Math.round(ctx.input.layers) || 2;
    const nn = n === 1 && d > 0 ? 2 : n === 2 && d < 0 ? 1 : clamp(n + d * 2, 1, 32);
    ctx.set('layers', String(nn));
  };
  const maskChk = h('input', { type: 'checkbox', id: 'pw-mask' });
  maskChk.addEventListener('change', () => ctx.set('mask', maskChk.checked));
  const innerGrp = h('span', { class: 'pw-grp' }, 'inner', fld('innerOz', 'Inner copper', 'oz', 'w2'), 'oz', fld('innerCov', 'Inner coverage', '%', 'w2'), '%');
  const build = h('div', { class: 'pw-card pw-build' },
    h('span', { class: 'pw-grp' }, h('b', {}, 'Board'), fld('width', 'Board width', 'mm'), '×', fld('height', 'Board height', 'mm'), '×', fld('thick', 'Thickness', 'mm', 'w2'), 'mm'),
    h('span', { class: 'pw-grp' }, matSel),
    h('span', { class: 'pw-grp' }, h('b', {}, 'Copper'), layStep, 'layers · outer', fld('outerOz', 'Outer copper', 'oz', 'w2'), 'oz', fld('outerCov', 'Outer coverage', '%', 'w2'), '%'),
    innerGrp,
    h('label', { class: 'pw-chk', for: 'pw-mask' }, maskChk, 'solder mask'));

  // ---------- sheet ----------
  const svg = sv('svg', { class: 'pw-svg', role: 'group', 'aria-label': 'Board in three views: top, front edge and right edge. Parts are draggable.' });
  const hint = h('div', { class: 'pw-hint' },
    h('span', { class: 'long' }, 'Drag a part to move it · drag it across the board in an edge view to flip it to the other side · drag the board corner to resize · double-click the board to add a part · keys on a focused part: arrows move, F flips, Delete removes'),
    h('span', { class: 'short' }, 'Drag parts and the board corner · Tab to a part: arrows move, F flips side'));
  const legend = h('div', { class: 'pw-legend' },
    h('span', {}, h('i', { style: 'background:var(--tool-top)' }), 'top side'),
    h('span', {}, h('i', { style: 'background:transparent;border:1.5px dashed var(--tool-bot)' }), 'bottom side'),
    h('span', {}, 'disc area ∝ mass'),
    h('span', {}, h('i', { style: 'background:var(--tool-zone);border:1px dashed var(--ok)' }), 'CoG within 15 % of centre'),
    h('span', {}, '+ board centre'));
  const sheet = h('section', { class: 'pw-card pw-sheet' }, hint, svg, legend);
  const warnsEl = h('div', { class: 'pw-warns', role: 'status' });
  const notesEl = h('details', { class: 'pw-more' });

  // ---------- ledger ----------
  const totB = h('b', {}, '–');
  const totS = h('span', {});
  const bar = h('div', { class: 'pw-bar', 'aria-hidden': 'true' });
  const ledRows = h('div', { class: 'pw-rows' });
  const cogRow = h('div', { class: 'pw-cogrow' });
  const ledger = h('section', { class: 'pw-card pw-led', 'aria-live': 'polite' }, h('div', { class: 'pw-tot' }, totB, h('span', {}, 'g total'), totS), bar, ledRows, cogRow);

  // ---------- parts list ----------
  const list = h('div', { class: 'pw-list' });
  const addBtn = h('button', { class: 'pw-btn', onclick: () => addPart() }, '+ Part');
  const partsCard = h('section', { class: 'pw-card' },
    h('div', { class: 'pw-ph' }, h('h2', {}, 'Parts'), h('span', { class: 'g' }), addBtn),
    h('div', { class: 'pw-lh' }, h('span', {}, 'name'), h('span', {}, 'mass g'), h('span', {}, 'height mm'), h('span', {}, 'side'), h('span', {})),
    list);

  root.append(h('div', { class: 'pw' },
    h('div', { class: 'pw-col' }, build, sheet, warnsEl),
    h('div', { class: 'pw-col' }, ledger, partsCard, ctx.outputs, notesEl)));

  // ---------- state ----------
  let sel = null;            // selected row index
  let drag = null;
  let frozen = null;         // geometry frozen during a drag
  let pending = null;
  let geo = null;

  const rows = () => (Array.isArray(ctx.raw.parts) ? ctx.raw.parts.map((r) => ({ ...r })) : []);
  const setSoon = (obj) => {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  };
  const setRow = (i, patch, soon) => {
    const rs = rows(); if (!rs[i]) return;
    Object.assign(rs[i], patch);
    if (soon) setSoon({ parts: rs }); else ctx.set('parts', rs);
  };
  function addPart(x, y) {
    const d = ctx.result?.drawing;
    const rs = rows();
    rs.push({ ref: `P${rs.length + 1} new part`, mass: '1', x: str(x ?? (d ? d.w / 2 : 10)), y: str(y ?? (d ? d.h / 2 : 10)), h: '2', side: 'top' });
    sel = rs.length - 1;
    ctx.set('parts', rs);
    listSig = '';
  }
  function removePart(i) {
    const rs = rows(); rs.splice(i, 1);
    if (sel === i) sel = null; else if (sel > i) sel -= 1;
    listSig = '';
    ctx.set('parts', rs);
  }

  // ---------- layout of the sheet ----------
  function layout(d) {
    const Wp = Math.max(300, sheet.clientWidth - 16);
    const narrow = Wp < 560;
    const zTop = d.t + Math.max(0, ...d.parts.filter((p) => p.side === 'top').map((p) => p.h));
    const zBot = Math.max(0, ...d.parts.filter((p) => p.side === 'bottom').map((p) => p.h));
    const L = narrow ? 30 : 44, T = 26, G = narrow ? 34 : 44, R = 10, B = 30;
    const top = svg.getBoundingClientRect().top + window.scrollY;
    const maxH = Math.max(340, window.innerHeight - top - 36);
    // edge views: z drawn at the plan scale, but at most 150 px deep
    const zspan = zTop + zBot;
    // plan extents: the board, and any part placed off it (so it stays visible)
    const mrg = 4;
    const e = { x0: Math.min(0, ...d.parts.map((p) => p.x - mrg)), x1: Math.max(d.w, ...d.parts.map((p) => p.x + mrg)),
      y0: Math.min(0, ...d.parts.map((p) => p.y - mrg)), y1: Math.max(d.h, ...d.parts.map((p) => p.y + mrg)) };
    const ew = e.x1 - e.x0, eh = e.y1 - e.y0;
    const tbMin = narrow ? 92 : 112;
    const zCap = narrow ? 80 : 150;
    let k = 1, kz = 1;
    for (let it = 0; it < 4; it++) {
      kz = Math.min(k, zCap / Math.max(zspan, 1));
      const tbE = Math.max(zspan * kz, tbMin);
      k = Math.min((Wp - L - R - (narrow ? 0 : G + tbE)) / ew, (maxH - T - G - B - (narrow ? Math.max(zspan * kz, 56) : tbE)) / eh);
      k = Math.max(0.8, k);
    }
    kz = Math.min(k, zCap / Math.max(zspan, 1));
    const ez = zspan * kz;                 // edge depth in px
    const tb = narrow ? Math.max(ez, 56) : Math.max(ez, tbMin); // right column / bottom row size
    return { Wp, narrow, L, T, G, R, B, k, kz, zTop, zBot, ez, tb, e };
  }

  // ---------- drawing ----------
  function draw() {
    const res = ctx.result || {};
    const d = res.drawing;
    svg.replaceChildren();
    if (!d) { svg.setAttribute('viewBox', '0 0 400 60'); svg.append(sv('text', { x: 10, y: 30, class: 'pw-warn' }, (res.warnings || ['Give the board size.'])[0])); return; }
    const g = frozen || layout(d);
    geo = g;
    const { L, T, G, k, kz, zTop, zBot, ez, tb, e } = g;
    const bw = d.w * k, bh = d.h * k;
    // while the corner is dragged the board's 0,0 corner stays put on screen
    const y0s = g.anchorY != null ? g.anchorY : T + e.y1 * k;   // screen y of y = 0
    const ox = L - e.x0 * k, oy = y0s - bh;
    const fy = T + (e.y1 - e.y0) * k + G;       // front view: top of strip
    const sx = L + (e.x1 - e.x0) * k + G;       // right view: left of strip
    const side = !g.narrow;                      // the right edge view needs the width
    const W = side ? sx + tb + g.R : L + (e.x1 - e.x0) * k + g.R, H = fy + tb + g.B;
    if (g.anchorY == null) {
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.style.maxHeight = `${Math.round(H)}px`;
    }
    const X = (x) => ox + x * k, Y = (y) => oy + bh - y * k;
    // z to screen: front view, z up; the board's top face at FZ(t)
    const fz0 = fy + (tb - ez) / 2 + zTop * kz;  // screen y of z = 0
    const FZ = (z) => fz0 - z * kz;
    const sz0 = sx + (tb - ez) / 2 + zBot * kz;  // right view, z to the right: screen x of z = 0
    const SZ = (z) => sz0 + z * kz;

    const maxM = Math.max(...d.parts.map((p) => p.m), 1e-6);
    const rMax = clamp(k * 7, 9, 22);
    const rad = (p) => Math.max(3.5, rMax * Math.sqrt(p.m / maxM));
    const off = !!d.offCentre;

    // --- view titles
    svg.append(sv('text', { x: L, y: 14, class: 'pw-vt' }, 'Top view'));
    svg.append(sv('text', { x: L, y: fy - 8, class: 'pw-vt' }, 'Front edge'));
    if (side) svg.append(sv('text', { x: sx, y: 14, class: 'pw-vt' }, 'Right edge'));

    // --- top view: grid, board, zone
    const gstep = [5, 10, 20, 25, 50, 100].find((s) => s * k >= 28) || 100;
    for (let x = gstep; x < d.w; x += gstep) svg.append(sv('line', { x1: X(x), x2: X(x), y1: oy, y2: oy + bh, class: 'pw-grid' }));
    for (let y = gstep; y < d.h; y += gstep) svg.append(sv('line', { x1: ox, x2: ox + bw, y1: Y(y), y2: Y(y), class: 'pw-grid' }));
    const board = sv('rect', { x: ox, y: oy, width: bw, height: bh, rx: 2, class: 'pw-board', 'fill-opacity': 0.55 });
    board.addEventListener('dblclick', (e) => { const p = toBoard(e); addPart(snap(p.x, 0.5), snap(p.y, 0.5)); });
    svg.append(board);
    svg.append(sv('rect', { x: ox, y: oy, width: bw, height: bh, rx: 2, fill: 'none', stroke: 'var(--tool-lam)', 'stroke-width': 1.5, 'pointer-events': 'none' }));
    svg.append(sv('ellipse', { cx: X(d.w / 2), cy: Y(d.h / 2), rx: 0.15 * bw, ry: 0.15 * bh, class: 'pw-zone', 'pointer-events': 'none' }));
    const cx = X(d.w / 2), cy = Y(d.h / 2);
    svg.append(sv('path', { d: `M${cx - 7},${cy}H${cx + 7}M${cx},${cy - 7}V${cy + 7}`, class: 'pw-ctr' }));
    // dimensions
    dimH(ox, ox + bw, oy + bh + 14, `${fmt(d.w, 4)}`);
    dimV(ox - 14, oy, oy + bh, `${fmt(d.h, 4)}`);
    svg.append(sv('text', { x: ox - 3, y: oy + bh + 12, class: 'pw-dim', 'text-anchor': 'end' }, '0,0'));

    // --- front view (x, z)
    svg.append(sv('line', { x1: ox - 6, x2: ox + bw + 6, y1: FZ(0), y2: FZ(0), class: 'pw-grid' }));
    svg.append(sv('rect', { x: ox, y: FZ(d.t), width: bw, height: Math.max(1.5, d.t * kz), class: 'pw-slab' }));
    svg.append(sv('rect', { x: ox, y: FZ(d.t) - 1, width: bw, height: 1.2, class: 'pw-cu' }));
    svg.append(sv('rect', { x: ox, y: FZ(0), width: bw, height: 1.2, class: 'pw-cu' }));
    svg.append(sv('text', { x: ox + bw + 6, y: FZ(d.t / 2) + 4, class: 'pw-dim' }, `${fmt(d.t, 3)}`));
    svg.append(sv('text', { x: ox - 6, y: FZ(d.t) - 4, class: 'pw-dim', 'text-anchor': 'end' }, 'top'));
    svg.append(sv('text', { x: ox - 6, y: FZ(0) + 13, class: 'pw-dim', 'text-anchor': 'end' }, 'bot'));
    // --- right view (z, y)
    if (side) {
    svg.append(sv('line', { x1: SZ(0), x2: SZ(0), y1: oy - 6, y2: oy + bh + 6, class: 'pw-grid' }));
    svg.append(sv('rect', { x: SZ(0), y: oy, width: Math.max(1.5, d.t * kz), height: bh, class: 'pw-slab' }));
    svg.append(sv('text', { x: SZ(d.t) + 4, y: oy + bh + 14, class: 'pw-dim' }, 'top →'));
    svg.append(sv('text', { x: SZ(0) - 4, y: oy + bh + 14, class: 'pw-dim', 'text-anchor': 'end' }, '← bot'));
    // projection lines (faint)
    }
    svg.append(sv('path', { d: `M${ox + bw},${oy + bh}V${fy - 2}${side ? `M${ox + bw},${oy}H${sx - 2}` : ''}`, stroke: 'var(--line-soft)', 'stroke-dasharray': '2 4', fill: 'none' }));

    // --- parts: edge views first (under), then the top view
    const order = [...d.parts].sort((a, b) => b.m - a.m);
    for (const p of order) {
      const r = rad(p), bad = p.off || p.heavyBottom;
      const hz = Math.max(1.5, p.h * kz);
      const top = p.side === 'top';
      // front
      const fr = sv('g', { class: `pw-part ${p.side}${bad ? ' bad' : ''}${sel === p.i ? ' sel' : ''}`, 'data-i': p.i, 'data-v': 'front' });
      const fyTop = top ? FZ(d.t) - hz : FZ(0);
      fr.append(sv('rect', { x: X(p.x) - r, y: fyTop, width: 2 * r, height: hz, rx: 1.5, class: 'b' }));
      fr.append(sv('rect', { x: X(p.x) - r - 3, y: fyTop - 3, width: 2 * r + 6, height: hz + 6, rx: 3, class: 'ring' }));
      svg.append(fr);
      // right
      if (!side) continue;
      const rr = sv('g', { class: `pw-part ${p.side}${bad ? ' bad' : ''}${sel === p.i ? ' sel' : ''}`, 'data-i': p.i, 'data-v': 'right' });
      const rxL = top ? SZ(d.t) : SZ(0) - hz;
      rr.append(sv('rect', { x: rxL, y: Y(p.y) - r, width: hz, height: 2 * r, rx: 1.5, class: 'b' }));
      rr.append(sv('rect', { x: rxL - 3, y: Y(p.y) - r - 3, width: hz + 6, height: 2 * r + 6, rx: 3, class: 'ring' }));
      svg.append(rr);
    }
    for (const p of order) {
      const r = rad(p), bad = p.off || p.heavyBottom;
      const gp = sv('g', { class: `pw-part ${p.side}${bad ? ' bad' : ''}${sel === p.i ? ' sel' : ''}`, 'data-i': p.i, 'data-v': 'top',
        tabindex: 0, role: 'button', 'aria-label': `${p.ref}: ${fmt(p.m, 3)} g on the ${p.side} at x ${fmt(p.x, 4)}, y ${fmt(p.y, 4)} mm. Arrows move, F flips side, Delete removes.` });
      const px = X(p.x), py = Y(p.y);
      gp.append(sv('circle', { cx: px, cy: py, r, class: 'b' }));
      gp.append(sv('circle', { cx: px, cy: py, r: r + 4, class: 'ring' }));
      gp.append(sv('title', {}, `${p.ref}\n${fmt(p.m, 3)} g · ${fmt(p.share * 100, 3)} % of total · ${p.side} · ${fmt(p.h, 3)} mm tall\n(${fmt(p.x, 4)}, ${fmt(p.y, 4)}) mm`));
      svg.append(gp);
    }
    // labels (on top of every disc)
    for (const p of order) {
      const r = rad(p), px = X(p.x), py = Y(p.y);
      const name = p.ref.split(' ')[0];
      const big = r >= 12;
      svg.append(sv('text', { x: px, y: py - r - 4, 'text-anchor': 'middle', class: `pw-plab pw-halo${p.side === 'bottom' ? ' soft' : ''}` }, `${name}${big || sel === p.i ? ` ${fmt(p.m, 2)} g` : ''}`));
      if (p.off) svg.append(sv('text', { x: px, y: py + r + 13, 'text-anchor': 'middle', class: 'pw-warn pw-halo' }, 'off the board'));
      else if (p.heavyBottom) svg.append(sv('text', { x: px, y: py + r + 13, 'text-anchor': 'middle', class: 'pw-warn pw-halo' }, '≥ 5 g on bottom: glue'));
    }

    // --- CoG in the three views
    const oc = off ? ' off' : '';
    const gx = X(d.cog.x), gy = Y(d.cog.y);
    svg.append(sv('line', { x1: cx, y1: cy, x2: gx, y2: gy, class: `pw-arm${oc}` }));
    cogMark(gx, gy, 9, oc);
    const lx = gx + 13, rightSide = lx + (g.narrow ? 70 : 150) < ox + bw;
    const anc = rightSide ? 'start' : 'end', tx = rightSide ? lx : gx - 13;
    svg.append(sv('text', { x: tx, y: gy - 12, class: `pw-cogt pw-halo${oc}`, 'text-anchor': anc }, g.narrow ? 'CoG' : `CoG ${fmt(d.cog.x, 3)}, ${fmt(d.cog.y, 3)}`));
    if (!g.narrow) svg.append(sv('text', { x: tx, y: gy + 2, class: `pw-dim pw-halo`, 'text-anchor': anc }, `${fmt(d.offset, 2)} mm from centre`));
    // front and right
    svg.append(sv('line', { x1: gx, x2: gx, y1: oy + bh, y2: FZ(d.cog.z), class: `pw-arm${oc}`, opacity: 0.45 }));
    cogMark(gx, FZ(d.cog.z), 7, oc);
    const fb = FZ(0) + zBotH(d) * kz + 6;   // fulcrum: where the board balances along x
    svg.append(sv('path', { d: `M${gx},${fb}l-7,11h14z`, fill: 'var(--ink-soft)', opacity: 0.8 }));
    svg.append(sv('text', { x: gx + 10, y: fb + 10, class: 'pw-dim' }, 'balances here'));
    svg.append(sv('text', { x: gx + 10, y: FZ(d.cog.z) - 8, class: `pw-cogt pw-halo${oc}` }, `z ${fmt(d.cog.z, 3)}`));
    if (side) {
      svg.append(sv('line', { x1: ox + bw, x2: SZ(d.cog.z), y1: gy, y2: gy, class: `pw-arm${oc}`, opacity: 0.45 }));
      cogMark(SZ(d.cog.z), gy, 7, oc);
    }

    // --- title block in the free corner
    const tbx = sx, tby = fy, tbw = tb, tbh = tb;
    if (side) {
    svg.append(sv('rect', { x: tbx, y: tby, width: tbw, height: tbh, rx: 4, class: 'pw-tb' }));
    const lines = [['total', `${fmt(d.total, 4)} g`], ['CoG x, y mm', `${fmt(d.cog.x, 3)}, ${fmt(d.cog.y, 3)}`], ['CoG z mm', `${fmt(d.cog.z, 3)}`]];
    const lh = Math.min(30, (tbh - 26) / 3);
    lines.forEach(([kk, v], i) => {
      svg.append(sv('text', { x: tbx + 8, y: tby + 14 + i * lh, class: 'pw-tbk' }, kk));
      svg.append(sv('text', { x: tbx + 8, y: tby + 28 + i * lh, class: 'pw-tbv' }, v));
    });
    svg.append(sv('text', { x: tbx + 8, y: tby + tbh - 7, class: 'pw-tbk' }, kz < k * 0.999 ? `edges: z ×${fmt(k / kz, 2)} shorter` : 'all views to scale'));
    }

    // --- corner handle (board size)
    const ch = sv('rect', { x: ox + bw - 6, y: oy - 6, width: 12, height: 12, rx: 2, class: 'pw-corner', tabindex: 0, role: 'slider',
      'aria-label': `Board size ${fmt(d.w, 4)} by ${fmt(d.h, 4)} mm. Left/right change width, up/down height.`, 'data-corner': '1',
      'aria-valuetext': `${fmt(d.w, 4)} × ${fmt(d.h, 4)} mm` });
    ch.append(sv('title', {}, 'Drag to resize the board'));
    svg.append(ch);

    function cogMark(x, y, r, oc2) {
      const gC = sv('g', { class: `pw-cog${oc2}`, 'pointer-events': 'none' });
      gC.append(sv('circle', { cx: x, cy: y, r, class: 'o' }));
      gC.append(sv('path', { d: `M${x},${y - r}A${r},${r} 0 0 1 ${x + r},${y}L${x},${y}Z M${x},${y + r}A${r},${r} 0 0 1 ${x - r},${y}L${x},${y}Z`, class: 'q' }));
      svg.append(gC);
    }
    function dimH(x1, x2, y, t) {
      svg.append(sv('path', { d: `M${x1},${y - 4}V${y + 4}M${x2},${y - 4}V${y + 4}M${x1},${y}H${x2}`, class: 'pw-dl' }));
      svg.append(sv('text', { x: (x1 + x2) / 2, y: y - 3, 'text-anchor': 'middle', class: 'pw-dim pw-halo' }, t));
    }
    function dimV(x, y1, y2, t) {
      svg.append(sv('path', { d: `M${x - 4},${y1}H${x + 4}M${x - 4},${y2}H${x + 4}M${x},${y1}V${y2}`, class: 'pw-dl' }));
      const tx = x - 3, ty = (y1 + y2) / 2;
      svg.append(sv('text', { x: tx, y: ty, 'text-anchor': 'middle', transform: `rotate(-90 ${tx} ${ty})`, class: 'pw-dim pw-halo' }, t));
    }
    geo.map = { ox, oy, bw, bh, k, kz, X, Y, FZ, SZ, sx, fy, d };
  }

  function zBotH(d) { return Math.max(0, ...d.parts.filter((p) => p.side === 'bottom').map((p) => p.h)); }

  // screen -> svg coordinates
  function pt(e) {
    const m = svg.getScreenCTM(); if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }
  function toBoard(e) {
    const q = pt(e), M = geo.map;
    return { x: (q.x - M.ox) / M.k, y: (M.oy + M.bh - q.y) / M.k };
  }

  // ---------- pointer ----------
  svg.addEventListener('pointerdown', (e) => {
    const corner = e.target.closest('[data-corner]');
    const part = e.target.closest('.pw-part');
    if (!corner && !part) return;
    e.preventDefault();
    frozen = { ...geo };
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (corner) { drag = { kind: 'corner', M: geo.map }; frozen.anchorY = geo.map.oy + geo.map.bh; corner.focus({ preventScroll: true }); return; }
    const i = Number(part.dataset.i);
    const view = part.dataset.v;
    const rs = rows()[i] || {};
    const q = pt(e);
    drag = { kind: 'part', i, view, x0: q.x, y0: q.y, px: Number(rs.x) || 0, py: Number(rs.y) || 0, side: String(rs.side || 'top') };
    if (sel !== i) { sel = i; markSel(); syncList(); }
    svg.querySelector(`.pw-part[data-v="top"][data-i="${i}"]`)?.focus({ preventScroll: true });
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const M = geo.map, q = pt(e);
    const st = e.shiftKey ? 0.1 : 0.5;
    if (drag.kind === 'corner') {
      const M0 = drag.M;
      const w = Math.max(5, snap((q.x - M0.ox) / M0.k, st));
      const hh = Math.max(5, snap((M0.oy + M0.bh - q.y) / M0.k, st));
      setSoon({ width: str(w), height: str(hh) });
      return;
    }
    const dx = (q.x - drag.x0) / M.k, dy = -(q.y - drag.y0) / M.k;
    const patch = {};
    if (drag.view === 'top') { patch.x = str(snap(drag.px + dx, st)); patch.y = str(snap(drag.py + dy, st)); }
    else if (drag.view === 'front') {
      patch.x = str(snap(drag.px + dx, st));
      const z = (M.FZ(0) - q.y) / M.kz;  // above or below the board's mid-plane
      patch.side = z > M.d.t / 2 ? 'top' : 'bottom';
    } else {
      patch.y = str(snap(drag.py + dy, st));
      const z = (q.x - M.SZ(0)) / M.kz;
      patch.side = z > M.d.t / 2 ? 'top' : 'bottom';
    }
    setRow(drag.i, patch, true);
  });
  const end = () => { if (!drag) return; drag = null; frozen = null; requestAnimationFrame(() => { draw(); restoreFocus(); }); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  // ---------- keyboard ----------
  let focusKey = null;
  svg.addEventListener('focusin', (e) => {
    const p = e.target.closest?.('.pw-part');
    focusKey = e.target.closest?.('[data-corner]') ? 'corner' : p ? Number(p.dataset.i) : null;
    if (p && sel !== Number(p.dataset.i)) { sel = Number(p.dataset.i); markSel(); syncList(); }
  });
  svg.addEventListener('keydown', (e) => {
    const d = ctx.result?.drawing; if (!d) return;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (e.target.closest('[data-corner]')) {
      const a = arrows[e.key]; if (!a) return;
      e.preventDefault();
      const st = e.shiftKey ? 5 : 1;
      ctx.setMany({ width: str(Math.max(5, d.w + a[0] * st)), height: str(Math.max(5, d.h + a[1] * st)) });
      return;
    }
    const p = e.target.closest('.pw-part'); if (!p) return;
    const i = Number(p.dataset.i), r = rows()[i]; if (!r) return;
    if (arrows[e.key]) {
      e.preventDefault();
      const st = e.shiftKey ? 5 : e.altKey ? 0.1 : 1, a = arrows[e.key];
      setRow(i, { x: str((Number(r.x) || 0) + a[0] * st), y: str((Number(r.y) || 0) + a[1] * st) });
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault(); setRow(i, { side: String(r.side).startsWith('b') ? 'top' : 'bottom' });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); removePart(i);
    }
  });
  function restoreFocus() {
    if (focusKey == null || !svg.contains(document.activeElement) && document.activeElement !== document.body) return;
    const t = focusKey === 'corner' ? svg.querySelector('[data-corner]') : svg.querySelector(`.pw-part[data-v="top"][data-i="${focusKey}"]`);
    if (t && document.activeElement !== t) t.focus({ preventScroll: true });
  }
  function markSel() {
    for (const n of svg.querySelectorAll('.pw-part')) n.classList.toggle('sel', Number(n.dataset.i) === sel);
    for (const n of list.querySelectorAll('.pw-row')) n.classList.toggle('sel', Number(n.dataset.i) === sel);
  }

  // ---------- list ----------
  let listSig = '';
  function syncList() {
    const rs = rows();
    const d = ctx.result?.drawing;
    const byI = new Map((d?.parts || []).map((p) => [p.i, p]));
    const sig = `${rs.length}`;
    if (sig !== listSig || !list.children.length) {
      listSig = sig;
      list.replaceChildren(...rs.map((r, i) => {
        const nm = h('input', { class: 'nm', 'data-f': 'ref', spellcheck: 'false', 'aria-label': `Part ${i + 1} name` });
        nm.addEventListener('input', () => setRow(i, { ref: nm.value }));
        const m = h('input', { class: 'pw-in', 'data-f': 'mass', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `Part ${i + 1} mass in grams` });
        m.addEventListener('input', () => setRow(i, { mass: m.value }));
        const hh = h('input', { class: 'pw-in', 'data-f': 'h', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `Part ${i + 1} height in mm` });
        hh.addEventListener('input', () => setRow(i, { h: hh.value }));
        for (const [inp, key, st] of [[m, 'mass', 0.1], [hh, 'h', 0.5]]) {
          inp.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            const v = Number(String(inp.value).replace(',', '.')); if (!Number.isFinite(v)) return;
            e.preventDefault();
            inp.value = str(Math.max(0, v + (e.key === 'ArrowUp' ? 1 : -1) * st * (e.shiftKey ? 10 : 1)));
            setRow(i, { [key]: inp.value });
          });
        }
        const side = h('span', { class: 'pw-side', role: 'group', 'aria-label': 'Side' },
          h('button', { class: 't', 'data-s': 'top', title: 'Top side', onclick: () => setRow(i, { side: 'top' }) }, 'T'),
          h('button', { class: 'b', 'data-s': 'bottom', title: 'Bottom side', onclick: () => setRow(i, { side: 'bottom' }) }, 'B'));
        const x = h('button', { class: 'x', title: 'Remove part', 'aria-label': `Remove part ${i + 1}`, onclick: () => removePart(i) }, '×');
        const sb = h('div', { class: 'sb' }, h('span', { class: 'tr' }, h('i', {})), h('span', { class: 'sh' }));
        const row = h('div', { class: 'pw-row', 'data-i': i }, nm, m, hh, side, x, sb);
        row.addEventListener('focusin', () => { if (sel !== i) { sel = i; markSel(); } });
        return row;
      }));
    }
    rs.forEach((r, i) => {
      const row = list.children[i]; if (!row) return;
      for (const inp of row.querySelectorAll('input[data-f]')) if (document.activeElement !== inp) inp.value = r[inp.dataset.f] ?? '';
      const top = !String(r.side).toLowerCase().startsWith('b');
      for (const b of row.querySelectorAll('.pw-side button')) b.setAttribute('aria-pressed', String((b.dataset.s === 'top') === top));
      const p = byI.get(i);
      const tr = row.querySelector('.tr i'), sh = row.querySelector('.sh');
      if (p) {
        tr.style.width = `${Math.min(100, p.share * 100)}%`;
        tr.style.background = top ? 'var(--tool-top)' : 'var(--tool-bot)';
        sh.textContent = `${fmt(p.share * 100, 3)} % · (${fmt(p.x, 4)}, ${fmt(p.y, 4)})${p.off ? ' · off board' : ''}`;
        sh.style.color = p.off || p.heavyBottom ? 'var(--danger)' : '';
      } else { tr.style.width = '0'; sh.textContent = 'skipped: mass, x, y or height is not a number'; sh.style.color = 'var(--danger)'; }
      row.classList.toggle('sel', i === sel);
    });
  }

  // ---------- ledger ----------
  function drawLedger(res) {
    const d = res.drawing;
    if (!d) { totB.textContent = '–'; bar.replaceChildren(); ledRows.replaceChildren(); cogRow.replaceChildren(); return; }
    totB.textContent = fmt(d.total, 4);
    totS.textContent = '';
    const segs = [
      ['Laminate', d.lam, 'var(--tool-lam)'], ['Copper', d.cu, 'var(--tool-cu)'], ['Solder mask', d.mask, 'var(--tool-mask)'],
      ['Parts, top', d.parts.filter((p) => p.side === 'top').reduce((s, p) => s + p.m, 0), 'var(--tool-top)'],
      ['Parts, bottom', d.parts.filter((p) => p.side === 'bottom').reduce((s, p) => s + p.m, 0), 'var(--tool-bot)'],
    ];
    bar.replaceChildren(...segs.filter((s) => s[1] > 0).map(([n, m, c]) => h('i', { title: `${n} ${fmt(m, 3)} g`, style: `width:${(100 * m) / d.total}%;background:${c}` })));
    ledRows.replaceChildren(...segs.flatMap(([n, m, c]) => [h('i', { style: `background:${c}` }), h('span', {}, n), h('span', { class: 'm' }, `${fmt(m, 3)} g`), h('span', { class: 'n' }, `${fmt((100 * m) / d.total, 3)} %`)]));
    const vals = res.values || [];
    const v = (re) => vals.find((x) => re.test(x.label));
    cogRow.replaceChildren(...[['x', v(/^CoG x/)], ['y', v(/^CoG y/)], ['z', v(/^CoG z/)]].map(([a, x]) => h('div', {},
      h('span', {}, `CoG ${a} mm`), h('b', { style: d.offCentre && a !== 'z' ? 'color:var(--warn)' : '' }, x ? x.value : '–'), h('em', {}, x?.hint || ''))));
  }

  // ---------- strip sync ----------
  function syncStrip(inp) {
    const raw = ctx.raw;
    for (const [key, el] of Object.entries(bind)) {
      if (document.activeElement !== el) el.value = raw[key] ?? '';
      el.classList.toggle('bad', String(raw[key] ?? '').trim() !== '' && ctx.parseEng(String(raw[key])) == null);
    }
    matSel.value = raw.material;
    maskChk.checked = !!raw.mask;
    const n = Math.max(1, Math.round(inp.layers) || 2);
    layN.textContent = String(n);
    innerGrp.style.display = n > 2 ? '' : 'none';
  }

  ctx.onResult((res, inp) => {
    syncStrip(inp);
    draw();
    if (!drag) restoreFocus();
    drawLedger(res);
    syncList();
    const w = res.warnings || [], nn = (res.notes || []);
    warnsEl.replaceChildren(...w.map((t) => h('div', {}, t)), ...nn.filter((t) => /^The centre of gravity/.test(t)).map((t) => h('div', { class: 'n' }, t)));
    notesEl.replaceChildren(h('summary', {}, 'Assumptions and method'), h('ul', {}, nn.filter((t) => !/^The centre of gravity/.test(t)).map((t) => h('li', {}, t))));
  });
  let rt = null;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (!drag) draw(); }, 60); }).observe(sheet);
}
