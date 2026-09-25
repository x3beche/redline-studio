// Package Dimension Explorer page: the parts themselves.
//   Tray     - every package shown, top view, all at one scale on a 1 mm grid
//              (zoom in and out). Point at one to put it under the loupe. Your
//              own block lies on the tray as a dashed outline: drag it over a
//              part to compare, drag its corner to size it.
//   Loupe    - the picked package large, with its body, overall size, pitch
//              and exposed pad dimensioned, and its side view with the height.
//   Skyline  - every package's side profile on one height scale.
//   Picker   - the group's packages as chips: click to add or take away (it
//              writes the filter).
// Every number drawn comes from run()'s result.shapes.
import { fmtNum } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const h = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const svg = (cls, label) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', cls); if (label) { s.setAttribute('role', 'group'); s.setAttribute('aria-label', label); } return s; };
const n2 = (v) => fmtNum(v, 3);
const short = (id) => id.replace(/ \(.*\)$/, '');
const GROUPS = [['all', 'All'], ['chip', 'Passive chips'], ['discrete', 'Diodes, transistors'], ['ic', 'ICs']];
const YOURS = '__yours'; // the selection when your block is under the loupe
const CATNAME = { chip: 'Passive chip', discrete: 'Diode / transistor', ic: 'IC package', custom: 'Your block' };

// Top view of one package centred on 0,0 at k px/mm, as an SVG string.
function topView(p, k, opt = {}) {
  const bw = p.bx * k, bh = p.by * k, o = [], inner = [];
  const min = opt.min ?? 0.6;
  for (const [side, count, pitch, width, ext] of p.leads || []) {
    const along = side === 'T' || side === 'B';
    const span = (count - 1) * pitch, inside = ext < 0, len = Math.abs(ext) * k, w = width * k;
    for (let i = 0; i < count; i++) {
      const c = (-span / 2 + i * pitch) * k;
      let x, y, rw, rh;
      if (along) { rw = w; rh = len; x = c - w / 2; y = side === 'T' ? (inside ? -bh / 2 : -bh / 2 - len) : (inside ? bh / 2 - len : bh / 2); }
      else { rw = len; rh = w; y = c - w / 2; x = side === 'L' ? (inside ? -bw / 2 : -bw / 2 - len) : (inside ? bw / 2 - len : bw / 2); }
      const r = `<rect class="pe-metal" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(rw, min).toFixed(2)}" height="${Math.max(rh, min).toFixed(2)}"/>`;
      if (inside) inner.push(r); else o.push(r);
    }
  }
  if (p.cat === 'custom') return `<rect class="pe-yours" x="${-bw / 2}" y="${-bh / 2}" width="${bw}" height="${bh}"/>`;
  o.push(`<rect class="pe-body${p.cat === 'chip' ? ' chip' : ''}" x="${-bw / 2}" y="${-bh / 2}" width="${bw}" height="${bh}" rx="${Math.min(bw, bh) * 0.04}"/>`);
  o.push(...inner);
  if (p.term) { const t = p.term * k; o.push(`<rect class="pe-metal" x="${-bw / 2}" y="${-bh / 2}" width="${t}" height="${bh}"/><rect class="pe-metal" x="${bw / 2 - t}" y="${-bh / 2}" width="${t}" height="${bh}"/>`); }
  if (p.ep) o.push(`<rect class="pe-metal ep" x="${-p.ep[0] * k / 2}" y="${-p.ep[1] * k / 2}" width="${p.ep[0] * k}" height="${p.ep[1] * k}"/>`);
  if (p.balls) {
    const [cols, rows, pitch, dia] = p.balls;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      o.push(`<circle class="pe-metal" cx="${((i - (cols - 1) / 2) * pitch * k).toFixed(2)}" cy="${((j - (rows - 1) / 2) * pitch * k).toFixed(2)}" r="${Math.max(dia * k / 2, 0.4).toFixed(2)}"/>`);
    }
  }
  if ((p.cat === 'ic' || (p.cat === 'discrete' && (p.pins || 0) > 3)) && Math.min(bw, bh) > 8) {
    const r = Math.max(1.2, Math.min(bw, bh) * 0.045);
    o.push(`<circle class="pe-pin1" cx="${-bw / 2 + r * 2.4}" cy="${bh / 2 - r * 2.4}" r="${r}"/>`);
  }
  return o.join('');
}

// Side view (looking at the long side): body on the board, leads as feet.
function sideView(p, kx, kz, x0, yb) {
  const o = [], L = p.bx * kx, Hh = (p.h || 0) * kz;
  const hasOut = (p.leads || []).some((l) => l[4] > 0);
  const lr = (p.leads || []).find((l) => (l[0] === 'L' || l[0] === 'R') && l[4] > 0);
  const tb = (p.leads || []).find((l) => (l[0] === 'T' || l[0] === 'B') && l[4] > 0);
  const standoff = hasOut && p.cat !== 'chip' ? Math.min(Hh * 0.12, 3) : p.balls ? Math.min(Hh * 0.25, (p.balls[3] * kz) * 0.8) : 0;
  if (p.cat === 'custom') return `<rect class="pe-yours" x="${x0 - L / 2}" y="${yb - Hh}" width="${L}" height="${Hh}"/>`;
  o.push(`<rect class="pe-body${p.cat === 'chip' ? ' chip' : ''}" x="${x0 - L / 2}" y="${yb - Hh}" width="${L}" height="${Math.max(1, Hh - standoff)}" rx="1"/>`);
  if (p.term) { const t = p.term * kx; o.push(`<rect class="pe-metal" x="${x0 - L / 2}" y="${yb - Hh}" width="${t}" height="${Hh}"/><rect class="pe-metal" x="${x0 + L / 2 - t}" y="${yb - Hh}" width="${t}" height="${Hh}"/>`); }
  if (tb) { // gull-wing leads seen side on: a row of feet under the body edge
    const [, count, pitch, width] = tb, span = (count - 1) * pitch;
    for (let i = 0; i < count; i++) { const c = x0 + (-span / 2 + i * pitch) * kx; o.push(`<rect class="pe-metal" x="${c - (width * kx) / 2}" y="${yb - Math.max(2, Hh * 0.45)}" width="${Math.max(1, width * kx)}" height="${Math.max(2, Hh * 0.45)}"/>`); }
  }
  if (lr) { // leads out of the ends
    const e = lr[4] * kx, t = Math.max(1.5, Math.min(Hh * 0.25, 4));
    o.push(`<path class="pe-leadp" d="M${x0 - L / 2} ${yb - Hh * 0.5}h${-e * 0.4}V${yb - t / 2}h${-e * 0.6}M${x0 + L / 2} ${yb - Hh * 0.5}h${e * 0.4}V${yb - t / 2}h${e * 0.6}" style="stroke-width:${t}"/>`);
  }
  if (p.ep || (!hasOut && (p.leads || []).length)) o.push(`<rect class="pe-metal" x="${x0 - L / 2 + 1}" y="${yb - 1.5}" width="${L - 2}" height="1.5"/>`);
  if (p.balls) {
    const [cols, , pitch, dia] = p.balls, r = Math.max(1, (dia * kx) / 2);
    for (let i = 0; i < cols; i++) o.push(`<circle class="pe-metal" cx="${x0 + (i - (cols - 1) / 2) * pitch * kx}" cy="${yb - Math.min(r, standoff / 1.6 || r)}" r="${Math.min(r, standoff / 1.6 || r)}"/>`);
  }
  return o.join('');
}

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const bar = h('div', { class: 'pe-bar' });
  const groupSeg = h('div', { class: 'pe-seg', role: 'radiogroup', 'aria-label': 'Package group' }, GROUPS.map(([v, t]) => `<button type="button" role="radio" data-g="${v}">${t}</button>`).join(''));
  groupSeg.addEventListener('click', (e) => { const g = e.target.closest('[data-g]')?.dataset.g; if (g) ctx.setMany({ group: g, filter: '' }); });
  const sortSeg = h('div', { class: 'pe-seg', role: 'radiogroup', 'aria-label': 'Order' }, '<button type="button" role="radio" data-o="area">By size</button><button type="button" role="radio" data-o="list">As listed</button>');
  sortSeg.addEventListener('click', (e) => { const o = e.target.closest('[data-o]')?.dataset.o; if (o) ctx.set('sort', o); });
  const zoomBox = h('div', { class: 'pe-zoom', role: 'group', 'aria-label': 'Tray zoom' },
    '<button type="button" data-z="-1" aria-label="Zoom out">−</button><button type="button" data-z="0" class="pe-zfit">fit</button><button type="button" data-z="1" aria-label="Zoom in">+</button>');
  zoomBox.addEventListener('click', (e) => { const z = e.target.closest('[data-z]')?.dataset.z; if (z == null) return; zoom = z === '0' ? 1 : clamp(zoom * (z === '1' ? 1.5 : 1 / 1.5), 1, 12); drawTray(); });
  const yours = h('div', { class: 'pe-yoursf' });
  const yIn = h('input', { class: 'pe-in', id: 'pe-custom', type: 'text', spellcheck: 'false', placeholder: 'L x W (x H) mm', 'aria-label': 'Your own block, length x width (x height) in mm' });
  yIn.addEventListener('input', () => ctx.set('custom', yIn.value));
  const yAdd = h('button', { type: 'button', class: 'pe-btn' }, '+ Your block');
  yAdd.addEventListener('click', () => { ctx.set('custom', '10x8'); });
  const yDel = h('button', { type: 'button', class: 'pe-btn pe-x', 'aria-label': 'Remove your block', title: 'Remove your block' }, '×');
  yDel.addEventListener('click', () => ctx.set('custom', ''));
  yours.append(h('label', { for: 'pe-custom' }, 'Your block'), yIn, yDel, yAdd);
  bar.append(groupSeg, sortSeg, zoomBox, yours);

  const chips = h('div', { class: 'pe-chips', role: 'group', 'aria-label': 'Packages shown' });

  const tray = h('section', { class: 'pe-card pe-tray' });
  const trayHead = h('div', { class: 'pe-head' });
  const trayBox = h('div', { class: 'pe-traybox' });
  const T = svg('pe-svg', 'Packages to one scale on a 1 mm grid; pick one with the arrow keys');
  trayBox.append(T);
  tray.append(trayHead, trayBox);

  const loupe = h('section', { class: 'pe-card pe-loupe' });
  const loupeHead = h('div', { class: 'pe-head' });
  const lBox = h('div', { class: 'pe-lbox' });
  const L = svg('pe-svg', 'The picked package, dimensioned');
  lBox.append(L);
  const facts = h('dl', { class: 'pe-facts' });
  loupe.append(loupeHead, lBox, facts);

  const sky = h('section', { class: 'pe-card pe-sky' });
  const skyHead = h('div', { class: 'pe-head' }, '<h2>Side view · heights to one scale</h2><span class="pe-tip">widths not to scale · click a part to pick it</span>');
  const skyBox = h('div', { class: 'pe-skybox' });
  const K = svg('pe-svg', 'Package heights');
  skyBox.append(K);
  sky.append(skyHead, skyBox);

  const warnEl = h('div', { class: 'pe-warn', role: 'status' });
  const foot = h('section', { class: 'pe-foot' });
  const notes = h('details', { class: 'pe-notes' });
  foot.append(ctx.outputs, notes);

  const grid = h('div', { class: 'pe' });
  grid.append(bar, chips, warnEl, tray, loupe, sky, foot);
  root.append(grid);

  // ---------------- state ----------------
  let sel = null, zoom = 1, drag = null, pending = null;
  let block = null; // your block's top-left on the tray, mm
  let catalogue = [];
  let trayGeo = null;
  try { sel = localStorage.getItem('redline.pe.sel'); } catch { /* none */ }
  const setSoon = (obj) => {
    const first = !pending; pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  };
  const shapes = () => (ctx.result && ctx.result.shapes) || [];
  const parts = () => shapes().filter((s) => s.cat !== 'custom');
  const yoursShape = () => shapes().find((s) => s.cat === 'custom');
  const pick = (id, focus) => {
    sel = id;
    try { localStorage.setItem('redline.pe.sel', id); } catch { /* private */ }
    drawTray(); drawLoupe(); drawSky();
    if (focus) T.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false });
  };

  // ---------------- bar and chips ----------------
  function drawBar() {
    const inp = ctx.raw;
    for (const b of groupSeg.children) b.setAttribute('aria-checked', String(b.dataset.g === (inp.group || 'all')));
    for (const b of sortSeg.children) b.setAttribute('aria-checked', String(b.dataset.o === (inp.sort || 'area')));
    if (document.activeElement !== yIn) yIn.value = inp.custom || '';
    const has = String(inp.custom || '').trim() !== '';
    yAdd.hidden = has; yDel.hidden = !has; yIn.hidden = !has;
    yours.querySelector('label').hidden = !has;
    zoomBox.querySelector('.pe-zfit').textContent = zoom === 1 ? 'fit' : `${fmtNum(zoom, 2)}×`;
  }

  function drawChips() {
    const g = ctx.raw.group || 'all';
    const shown = new Set(parts().map((s) => s.id));
    const list = catalogue.filter((c) => g === 'all' || c.cat === g);
    const filterEmpty = !String(ctx.raw.filter || '').trim();
    chips.innerHTML = `<span class="pe-chiplab">${filterEmpty ? 'Showing the whole group' : `Showing ${shown.size} of ${list.length}`}</span>`
      + list.map((c) => `<button type="button" class="pe-chip" data-id="${esc(c.id)}" aria-pressed="${shown.has(c.id)}" title="${esc(c.id + (c.metric ? ` · metric ${c.metric}` : ''))}">${esc(short(c.id))}</button>`).join('')
      + (filterEmpty ? '' : '<button type="button" class="pe-btn pe-all">Show all</button>');
  }
  chips.addEventListener('click', (e) => {
    if (e.target.closest('.pe-all')) { ctx.set('filter', ''); return; }
    const b = e.target.closest('[data-id]');
    if (!b) return;
    const id = b.dataset.id;
    const g = ctx.raw.group || 'all';
    const inGroup = catalogue.filter((c) => g === 'all' || c.cat === g);
    const shown = new Set(parts().map((s) => s.id));
    if (shown.has(id)) { if (shown.size === 1) return; shown.delete(id); } else { shown.add(id); sel = id; }
    // Write the filter as names; a name that is part of another name not wanted is quoted (exact).
    const names = inGroup.filter((c) => shown.has(c.id)).map((c) => {
      const n = short(c.id), nl = n.toLowerCase();
      const clash = inGroup.some((o) => o.id !== c.id && !shown.has(o.id) && o.id.toLowerCase().includes(nl));
      return clash ? `"${n}"` : n;
    });
    ctx.set('filter', names.length === inGroup.length ? '' : names.join(', '));
  });

  // ---------------- tray ----------------
  function pack(list, W, k) {
    const GAP = 16, LABEL = 32, MINCELL = 72, TOP = 34;
    const rows = []; let row = [], x = 12;
    for (const p of list) {
      const cw = Math.max(p.sx * k, MINCELL);
      if (row.length && x + cw > W - 12) { rows.push(row); row = []; x = 12; }
      row.push({ p, cw, x }); x += cw + GAP;
    }
    if (row.length) rows.push(row);
    let y = TOP; const placed = [];
    for (const r of rows) {
      const rh = Math.max(...r.map((c) => c.p.sy * k), 8);
      for (const c of r) placed.push({ ...c, y, rh });
      y += rh + LABEL + GAP;
    }
    return { placed, H: y };
  }

  function drawTray() {
    const list = parts(), you = yoursShape();
    const W = Math.max(300, trayBox.clientWidth);
    const Hbox = Math.max(260, trayBox.clientHeight);
    if (!list.length) { T.setAttribute('viewBox', `0 0 ${W} 120`); T.style.height = '120px'; T.innerHTML = `<text class="pe-empty" x="${W / 2}" y="60" text-anchor="middle">Nothing to show: pick packages above</text>`; trayHead.innerHTML = '<h2>Tray</h2>'; return; }
    const maxDim = Math.max(...list.map((p) => Math.max(p.sx, p.sy)), you ? Math.max(you.sx, you.sy) : 0);
    // fit: the largest scale at which the packed tray fits the box
    let kf = Math.min((W - 60) / maxDim, 140);
    for (let i = 0; i < 80 && pack(list, W, kf).H > Hbox - 8; i++) kf *= 0.95;
    const k = Math.min(kf * zoom, (W - 40) / maxDim);
    const { placed, H } = pack(list, W, k);
    if (!you) block = null;
    if (you && !block) {
      // start it to the right of the last part, or under the tray
      const last = placed[placed.length - 1];
      const x = last.x + last.cw + 24, fitsRow = x + you.bx * k < W - 12;
      block = { x: (fitsRow ? x : 12) / k, y: (fitsRow ? last.y : H) / k };
    }
    if (you) block.x = clamp(block.x, 0, Math.max(0, (W - 6) / k - you.bx));
    const Ht = Math.max(H, Hbox, you ? (block.y + you.by) * k + 24 : 0);
    if (!sel || (sel === YOURS ? !you : !list.some((p) => p.id === sel))) sel = (list.find((p) => p.id === 'SOT-23') || list[Math.floor(list.length / 2)]).id;
    const o = [];
    const step = k >= 5 ? 1 : k >= 1.2 ? 5 : 10;
    o.push(`<defs><pattern id="pe-g" width="${step * k}" height="${step * k}" patternUnits="userSpaceOnUse"><path d="M ${step * k} 0 L 0 0 0 ${step * k}" class="pe-gl"/></pattern>`
      + (step === 1 && k >= 5 ? `<pattern id="pe-g5" width="${5 * k}" height="${5 * k}" patternUnits="userSpaceOnUse"><path d="M ${5 * k} 0 L 0 0 0 ${5 * k}" class="pe-gl5"/></pattern>` : '') + '</defs>');
    o.push(`<rect x="0" y="0" width="${W}" height="${Ht}" fill="url(#pe-g)"/>`);
    if (step === 1 && k >= 5) o.push(`<rect x="0" y="0" width="${W}" height="${Ht}" fill="url(#pe-g5)"/>`);
    // scale bar
    const sb = [1, 2, 5, 10, 20].find((v) => v * k >= 50) || 20;
    o.push(`<rect class="pe-sbar" x="12" y="10" width="${sb * k}" height="4"/><text class="pe-lab2" x="${sb * k + 18}" y="16">${sb} mm · grid ${step} mm${step === 1 && k >= 5 ? ' (5 mm bold)' : ''}</text>`);
    for (const c of placed) {
      const cx = c.x + c.cw / 2, cy = c.y + c.rh / 2, p = c.p, on = p.id === sel;
      o.push(`<g class="pe-pk${on ? ' on' : ''}" data-id="${esc(p.id)}" tabindex="${on ? 0 : -1}" role="button" aria-pressed="${on}" aria-label="${esc(`${p.id}: ${n2(p.sx)} by ${n2(p.sy)} mm with leads`)}">`
        + `<rect class="pe-cell" x="${c.x - 6}" y="${c.y - 6}" width="${c.cw + 12}" height="${c.rh + 38}" rx="4"/>`
        + `<g transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})">${topView(p, k)}</g>`
        + `<text class="pe-lab" x="${cx}" y="${c.y + c.rh + 15}" text-anchor="middle">${esc(short(p.id))}</text>`
        + `<text class="pe-lab2" x="${cx}" y="${c.y + c.rh + 27}" text-anchor="middle">${n2(p.sx)}×${n2(p.sy)}</text></g>`);
    }
    // your block, free on the tray
    if (you) {
      const bx = block.x * k, by = block.y * k, bw = you.bx * k, bh = you.by * k;
      const on = sel === YOURS;
      o.push(`<g class="pe-block${on ? ' on' : ''}" data-block="1" tabindex="0" role="button" aria-label="${esc(`Your block ${n2(you.bx)} by ${n2(you.by)} mm; arrow keys move it`)}">`
        + `<rect class="pe-yoursfill" x="${bx}" y="${by}" width="${bw}" height="${bh}"/><rect class="pe-yours" x="${bx}" y="${by}" width="${bw}" height="${bh}"/>`
        + `<text class="pe-ylab" x="${bx + 4}" y="${by - 5}">yours ${n2(you.bx)} × ${n2(you.by)}${you.h != null ? ` × ${n2(you.h)}` : ''} mm</text></g>`);
      o.push(`<g class="pe-hdl" data-hdl="1" tabindex="0" role="slider" aria-label="Size of your block" aria-valuetext="${esc(`${n2(you.bx)} by ${n2(you.by)} mm`)}">`
        + `<rect class="hit" x="${bx + bw - 10}" y="${by + bh - 10}" width="20" height="20"/><rect class="ring" x="${bx + bw - 8}" y="${by + bh - 8}" width="16" height="16" rx="3"/><rect class="pe-grip" x="${bx + bw - 5}" y="${by + bh - 5}" width="10" height="10" rx="2"/></g>`);
    }
    T.setAttribute('viewBox', `0 0 ${W} ${Ht}`);
    T.style.height = `${Ht}px`;
    const act = document.activeElement, fk = act && T.contains(act) ? (act.dataset.id ? 'pk' : act.dataset.hdl ? 'hdl' : act.dataset.block ? 'block' : null) : null;
    T.innerHTML = o.join('');
    if (fk === 'pk') T.querySelector('.pe-pk.on')?.focus({ preventScroll: true });
    if (fk === 'hdl') T.querySelector('[data-hdl]')?.focus({ preventScroll: true });
    if (fk === 'block') T.querySelector('[data-block]')?.focus({ preventScroll: true });
    trayGeo = { k, placed, W };
    const sp = placed.find((c) => c.p.id === sel);
    trayHead.innerHTML = `<h2>Tray · top view, one scale</h2><span class="pe-tip">${esc(`${fmtNum(k, 3)} px/mm`)} · ${list.length} packages · click one or use the arrow keys${you ? ' · drag your block, or its corner' : ''}</span>`;
    return sp;
  }

  // ---------------- loupe ----------------
  function drawLoupe() {
    const all = shapes();
    const p = (sel === YOURS ? all.find((s) => s.cat === 'custom') : all.find((s) => s.id === sel)) || parts()[0];
    const W = Math.max(280, lBox.clientWidth), H = Math.max(300, lBox.clientHeight);
    L.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!p) { L.innerHTML = ''; facts.innerHTML = ''; loupeHead.innerHTML = '<h2>Loupe</h2>'; return; }
    loupeHead.innerHTML = `<h2>${esc(p.id)}</h2><span class="pe-tip">${esc(CATNAME[p.cat] || '')}${p.metric ? ` · metric ${esc(p.metric)}` : ''}</span>`;
    const side = p.h != null;
    const topH = side ? H * 0.68 : H;
    const padX = Math.abs(p.sy - p.by) > 0.01 ? 88 : 64, padY = 46;
    const k = Math.min((W - 2 * padX) / p.sx, (topH - 2 * padY) / p.sy);
    const cx = W / 2 - 8, cy = topH / 2 + 4;
    const o = [];
    const dimH = (x0, x1, y, label, below = true) => {
      o.push(`<path class="pe-ext" d="M${x0} ${y + (below ? -6 : 6)}V${y}M${x1} ${y + (below ? -6 : 6)}V${y}"/>`);
      o.push(`<path class="pe-dim" d="M${x0} ${y}H${x1}M${x0 + 5} ${y - 3}L${x0} ${y}L${x0 + 5} ${y + 3}M${x1 - 5} ${y - 3}L${x1} ${y}L${x1 - 5} ${y + 3}"/>`);
      const fits = x1 - x0 > label.length * 7 + 8;
      o.push(`<text class="pe-dimt" x="${fits ? (x0 + x1) / 2 : x1 + 6}" y="${below ? y + 14 : y - 5}" text-anchor="${fits ? 'middle' : 'start'}">${esc(label)}</text>`);
    };
    const dimV = (y0, y1, x, label) => {
      o.push(`<path class="pe-dim" d="M${x} ${y0}V${y1}M${x - 3} ${y0 + 5}L${x} ${y0}L${x + 3} ${y0 + 5}M${x - 3} ${y1 - 5}L${x} ${y1}L${x + 3} ${y1 - 5}"/>`);
      o.push(`<text class="pe-dimt" x="${x + 6}" y="${(y0 + y1) / 2 + 4}">${esc(label)}</text>`);
    };
    // grid under the part: 1 mm (or 0.5 mm when it is big on screen)
    const gs = k > 60 ? 0.5 : k > 12 ? 1 : 5;
    o.push(`<defs><pattern id="pe-lg" x="${cx}" y="${cy}" width="${gs * k}" height="${gs * k}" patternUnits="userSpaceOnUse"><path d="M ${gs * k} 0 L 0 0 0 ${gs * k}" class="pe-gl"/></pattern></defs>`);
    o.push(`<rect x="0" y="0" width="${W}" height="${topH}" fill="url(#pe-lg)"/>`);
    o.push(`<text class="pe-lab2" x="8" y="14">top view · grid ${gs} mm</text>`);
    o.push(`<g transform="translate(${cx},${cy})">${topView(p, k, { min: 1 })}</g>`);
    const hx = p.sx * k / 2, hy = p.sy * k / 2, bx = p.bx * k / 2, by = p.by * k / 2;
    // overall and body dimensions
    dimH(cx - hx, cx + hx, cy + hy + 22, `${n2(p.sx)}`);
    if (Math.abs(p.sx - p.bx) > 0.01) dimH(cx - bx, cx + bx, cy - hy - 18, `body ${n2(p.bx)}`, false);
    dimV(cy - hy, cy + hy, cx + hx + 18, `${n2(p.sy)}`);
    if (Math.abs(p.sy - p.by) > 0.01) dimV(cy - by, cy + by, cx - hx - 18 - 0, '');
    if (Math.abs(p.sy - p.by) > 0.01) o.push(`<text class="pe-dimt" x="${cx - hx - 24}" y="${cy + 4}" text-anchor="end">body ${n2(p.by)}</text>`);
    // pitch between two neighbouring leads (or balls)
    const row = (p.leads || []).find((l) => (l[0] === 'B') && l[1] >= 2) || (p.leads || []).find((l) => l[1] >= 2);
    if (row && p.pitch) {
      const [sd, count, pitch, , ext] = row, span = (count - 1) * pitch;
      const plab = Math.abs(pitch - p.pitch) < 1e-6 ? `pitch ${n2(pitch)}` : `${n2(pitch)} (pitch ${n2(p.pitch)})`;
      if (sd === 'B' || sd === 'T') {
        const x0 = cx + (-span / 2) * k, x1 = x0 + pitch * k;
        const y = ext > 0 ? cy + by + Math.abs(ext) * k + 6 : cy + by + 6;
        if (x1 - x0 > 10) {
          o.push(`<path class="pe-dim acc" d="M${x0} ${y}H${x1}"/><path class="pe-ext acc" d="M${x0} ${y - 4}V${y + 4}M${x1} ${y - 4}V${y + 4}"/>`);
          o.push(`<text class="pe-dimt acc" x="${x0 - 4}" y="${y + 4}" text-anchor="end">${esc(plab)}</text>`);
        }
      }
    }
    if (p.balls && p.pitch) {
      const [cols, rows] = p.balls, x0 = cx + (-(cols - 1) / 2) * p.pitch * k, y0 = cy + (-(rows - 1) / 2) * p.pitch * k;
      o.push(`<path class="pe-dim acc" d="M${x0} ${y0 - 10}H${x0 + p.pitch * k}"/><text class="pe-dimt acc" x="${x0}" y="${y0 - 14}">pitch ${n2(p.pitch)}</text>`);
    }
    if (p.ep && p.ep[0] * k > 60) o.push(`<text class="pe-dimt onmetal" x="${cx}" y="${cy + 4}" text-anchor="middle">pad ${n2(p.ep[0])} × ${n2(p.ep[1])}</text>`);
    if (p.term && p.term * k > 26) o.push(`<text class="pe-dimt" x="${cx - bx + p.term * k / 2}" y="${cy - by - 6}" text-anchor="middle">${n2(p.term)}</text>`);
    // side view with the height
    if (side) {
      const y0 = topH + 8, yb = H - 22;
      o.push(`<line class="pe-sep" x1="8" x2="${W - 8}" y1="${y0}" y2="${y0}"/><text class="pe-lab2" x="8" y="${y0 + 15}">side view</text>`);
      const kz = Math.min(k, (yb - y0 - 26) / Math.max(p.h, 0.1));
      const kx = Math.min(k, (W - 2 * padX) / p.sx);
      o.push(`<line class="pe-board" x1="20" x2="${W - 20}" y1="${yb}" y2="${yb}"/>`);
      o.push(sideView(p, kx, kz, cx, yb));
      dimV(yb - p.h * kz, yb, cx + (p.sx * kx) / 2 + 16, `h ${n2(p.h)}`);
      if (kz < k * 0.999) o.push(`<text class="pe-lab2" x="${W - 8}" y="${y0 + 15}" text-anchor="end">height ×${fmtNum(k / kz, 2)} smaller</text>`);
    }
    L.innerHTML = o.join('');
    const row2 = (k2, v) => (v == null || v === '' ? '' : `<dt>${k2}</dt><dd>${esc(v)}</dd>`);
    facts.innerHTML = row2('Body', `${n2(p.bx)} × ${n2(p.by)} mm`) + row2('With leads', `${n2(p.sx)} × ${n2(p.sy)} mm`)
      + row2('Height', p.h != null ? `${n2(p.h)} mm` : '') + row2('Pitch', p.pitch ? `${n2(p.pitch)} mm` : '') + row2('Pins', p.pins)
      + row2('Area', `${fmtNum(p.area, 3)} mm²`) + row2('vs 0603', p.vs0603 != null ? `${fmtNum(p.vs0603, 3)}×` : '');
  }

  // ---------------- skyline ----------------
  function drawSky() {
    const list = shapes().filter((s) => s.h != null);
    const W = Math.max(300, skyBox.clientWidth), H = Math.max(120, skyBox.clientHeight);
    K.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!list.length) { K.innerHTML = ''; return; }
    const m = { l: 40, r: 10, t: 22, b: 20 };
    const maxH = Math.max(...list.map((s) => s.h));
    const kz = (H - m.t - m.b) / maxH;
    const slot = (W - m.l - m.r) / list.length;
    const yb = H - m.b;
    const o = [];
    const st = maxH > 1.6 ? 0.5 : 0.25;
    for (let v = 0; v <= maxH + 1e-9; v += st) o.push(`<line class="pe-gl" x1="${m.l}" x2="${W - m.r}" y1="${yb - v * kz}" y2="${yb - v * kz}"/><text class="pe-lab2" x="${m.l - 5}" y="${yb - v * kz + 3.5}" text-anchor="end">${fmtNum(v, 2)}</text>`);
    o.push(`<text class="pe-lab2" x="${m.l - 5}" y="${m.t - 10}" text-anchor="end">mm</text>`);
    o.push(`<line class="pe-board" x1="${m.l}" x2="${W - m.r}" y1="${yb}" y2="${yb}"/>`);
    list.forEach((p, i) => {
      const cx = m.l + slot * (i + 0.5), wv = Math.max(6, Math.min(slot * 0.62, 70));
      const kx = wv / p.bx;
      const on = p.id === sel || (sel === YOURS && p.cat === 'custom');
      o.push(`<g class="pe-sk${on ? ' on' : ''}" data-id="${esc(p.id)}"><title>${esc(`${p.id}: ${n2(p.h)} mm high`)}</title><rect class="pe-skhit" x="${cx - slot / 2}" y="${m.t - 16}" width="${slot}" height="${H - m.t}"/>`
        + sideView(p, kx, kz, cx, yb)
        + (slot > 26 ? `<text class="pe-lab2 ${on ? 'acc' : ''}" x="${cx}" y="${yb - p.h * kz - 5}" text-anchor="middle">${n2(p.h)}</text>` : '')
        + (slot > 38 ? `<text class="pe-lab2 ${on ? 'acc' : ''}" x="${cx}" y="${H - 5}" text-anchor="middle">${esc(short(p.id).slice(0, Math.floor(slot / 6.2)))}</text>` : '') + '</g>');
    });
    K.innerHTML = o.join('');
  }

  // ---------------- warnings, notes ----------------
  function drawFoot() {
    const res = ctx.result || {};
    warnEl.innerHTML = (res.warnings || []).map((w) => `<div>${esc(w)}</div>`).join('');
    notes.innerHTML = `<summary>About the sizes (${(res.notes || []).length} notes)</summary>${(res.notes || []).map((n) => `<div>${esc(n)}</div>`).join('')}`;
  }

  // ---------------- interaction ----------------
  const trayPt = (e) => { const r = T.getBoundingClientRect(); const s = T.viewBox.baseVal.width / r.width; return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s }; };
  T.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const hd = e.target.closest('[data-hdl]'), bl = e.target.closest('[data-block]'), pk = e.target.closest('[data-id]');
    if (hd || bl) {
      e.preventDefault();
      const you = yoursShape(); if (!you || !trayGeo) return;
      const p = trayPt(e);
      drag = { kind: hd ? 'size' : 'move', p0: p, b0: { ...block }, s0: { bx: you.bx, by: you.by, h: you.h }, k: trayGeo.k, moved: false };
      T.setPointerCapture(e.pointerId);
      (hd || bl).focus({ preventScroll: true });
      return;
    }
    if (pk) { e.preventDefault(); pick(pk.dataset.id, true); }
  });
  T.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = trayPt(e), dx = (p.x - drag.p0.x) / drag.k, dy = (p.y - drag.p0.y) / drag.k;
    if (!drag.moved && Math.hypot(p.x - drag.p0.x, p.y - drag.p0.y) < 3) return;
    drag.moved = true;
    if (drag.kind === 'move') { block.x = Math.max(0, drag.b0.x + dx); block.y = Math.max(0, drag.b0.y + dy); drawTray(); }
    else {
      const q = (v) => Math.max(0.1, Math.round(v * 10) / 10);
      const Ln = q(drag.s0.bx + dx), Wn = q(drag.s0.by + dy);
      setSoon({ custom: `${fmtNum(Ln, 4)}x${fmtNum(Wn, 4)}${drag.s0.h != null ? `x${fmtNum(drag.s0.h, 4)}` : ''}` });
    }
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved && d.kind === 'move') { pick(YOURS, false); T.querySelector('[data-block]')?.focus({ preventScroll: true }); return; }
    requestAnimationFrame(() => { drawTray(); drawSky(); });
  };
  T.addEventListener('pointerup', endDrag);
  T.addEventListener('pointercancel', endDrag);
  T.addEventListener('keydown', (e) => {
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    const t = e.target;
    if (t.dataset?.hdl && dir) {
      e.preventDefault();
      const you = yoursShape(); if (!you) return;
      const st = e.shiftKey ? 1 : 0.1, q = (v) => Math.max(0.1, Math.round(v * 10) / 10);
      ctx.set('custom', `${fmtNum(q(you.bx + dir[0] * st), 4)}x${fmtNum(q(you.by + dir[1] * st), 4)}${you.h != null ? `x${fmtNum(you.h, 4)}` : ''}`);
      return;
    }
    if (t.dataset?.block && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(YOURS, false); t.focus(); return; }
    if (t.dataset?.block && dir) {
      e.preventDefault();
      const st = e.shiftKey ? 5 : 0.5;
      block.x = Math.max(0, block.x + dir[0] * st); block.y = Math.max(0, block.y + dir[1] * st);
      drawTray();
      return;
    }
    if (t.dataset?.id && trayGeo) {
      const pl = trayGeo.placed, i = pl.findIndex((c) => c.p.id === t.dataset.id);
      if (i < 0) return;
      let j = null;
      if (e.key === 'ArrowRight') j = Math.min(pl.length - 1, i + 1);
      if (e.key === 'ArrowLeft') j = Math.max(0, i - 1);
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = pl.length - 1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const c = pl[i], cx = c.x + c.cw / 2;
        const rows = [...new Set(pl.map((q) => q.y))].sort((a, b) => a - b);
        const r = rows.indexOf(c.y) + (e.key === 'ArrowDown' ? 1 : -1);
        if (r >= 0 && r < rows.length) {
          const cand = pl.filter((q) => q.y === rows[r]);
          j = pl.indexOf(cand.reduce((b, q) => (Math.abs(q.x + q.cw / 2 - cx) < Math.abs(b.x + b.cw / 2 - cx) ? q : b)));
        }
      }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(t.dataset.id, true); return; }
      if (j != null) { e.preventDefault(); pick(pl[j].p.id, true); }
    }
  });
  K.addEventListener('click', (e) => { const g = e.target.closest('[data-id]'); if (g) pick(yoursShape()?.id === g.dataset.id ? YOURS : g.dataset.id, false); });

  function drawAll() {
    const res = ctx.result || {};
    if (res.catalogue) catalogue = res.catalogue;
    drawBar(); drawChips(); drawTray(); drawLoupe(); drawSky(); drawFoot();
  }
  ctx.onResult(drawAll);
  let lastW = 0;
  new ResizeObserver(() => { const w = grid.clientWidth; if (drag || Math.abs(w - lastW) < 2) return; lastW = w; drawTray(); drawLoupe(); drawSky(); }).observe(grid);
}
