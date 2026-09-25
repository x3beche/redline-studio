// Project Constants, custom page: the project drawn from its own numbers.
//   Board  - the outline to scale from BOARD_W x BOARD_H, the mounting holes
//            at their inset with their diameter, dimensioned with value and
//            tolerance; under it the side section: board thickness, the part
//            height envelope, the enclosure wall. Drag the outline's corner,
//            a hole or the envelope's top to change the constant it shows.
//   Rails  - every supply constant on one voltage axis, its tolerance as a
//            shaded band with min and max; drag a rail to change its value.
//   Limits - every other value with limits (a tolerance or a range) as a
//            strip: nominal, band, min, max.
//   Ledger - the list itself, edited in place, grouped; selecting a row
//            lights its place in the drawing and the other way round.
//   Record - the project's shared record (/api/tools/data/project-constants):
//            loaded when the page opens, saved with "Save to project".
// Every number and limit drawn comes from run()'s result.sheet; the page
// only recognises which constant is which part of the drawing by its name.

const TOOL = 'project-constants';
const NS = 'http://www.w3.org/2000/svg';
const GROUPS = ['board', 'power', 'mechanical', 'thermal', 'interface', 'environment', 'other'];
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
const tidy = (v) => String(Number(v.toFixed(4)));
const roundTo = (v, step) => Math.round(v / step) * step;

// Which constant is which part of the drawing: by name, first match wins.
const ROLES = [
  ['w', /^(BOARD|PCB)_?(W|WIDTH|X|SIZE_?X|LEN_?X)$/i],
  ['h', /^(BOARD|PCB)_?(H|HEIGHT|Y|SIZE_?Y|LEN_?Y|L|LENGTH|D|DEPTH)$/i],
  ['t', /^(BOARD_|PCB_)?(THICK|THICKNESS|T)$|^(PCB|BOARD)_?THICK/i],
  ['holeD', /HOLE_?(D|DIA|DIAM|DIAMETER)$/i],
  ['inset', /HOLE_?(INSET|OFFSET|EDGE|MARGIN)|HOLE.*FROM_?EDGE/i],
  ['partH', /(PART|COMP|COMPONENT)S?_?(HEIGHT|H)$|^MAX_?(PART_?)?HEIGHT/i],
  ['wall', /WALL/i],
];
const VOLT = { V: 1, mV: 1e-3, kV: 1e3 };

export function page(root, ctx) {
  const state = { sel: null, drag: null, sig: '' };
  const sheet = () => ctx.result?.sheet || [];
  const rowsNow = () => structuredClone(ctx.raw.constants || []);
  const setValue = (row, v) => { const rows = rowsNow(); if (!rows[row]) return; rows[row].value = v; ctx.set('constants', rows); };
  const byRow = (row) => sheet().find((it) => it.row === row) || null;
  const roles = () => {
    const out = {};
    for (const it of sheet()) {
      if (!it.name) continue;
      for (const [role, re] of ROLES) if (!out[role] && re.test(it.name)) { out[role] = it; break; }
    }
    return out;
  };
  const select = (row, from) => {
    state.sel = row; paint();
    if (from !== 'ledger') ledger.querySelector(`.pc-row[data-row="${row}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // ---------- skeleton ----------
  const rec = h('div', { class: 'pc-rec' });
  const boardSvg = sv('svg', { class: 'pc-svg pc-board', role: 'group', 'aria-label': 'The board outline and side section, to scale' });
  const boardHint = h('div', { class: 'pc-hint' });
  const railSvg = sv('svg', { class: 'pc-svg pc-rails', role: 'group', 'aria-label': 'Supply rails on a voltage axis' });
  const railMore = h('div', { class: 'pc-more' });
  const limitsBox = h('div', { class: 'pc-limits' });
  const filterIn = h('input', { type: 'search', class: 'pc-in', placeholder: 'name, note or group', 'aria-label': 'Show only', spellcheck: 'false' });
  filterIn.addEventListener('input', () => ctx.set('filter', filterIn.value));
  const ledger = h('div', { class: 'pc-ledger' });
  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  const stats = h('div', { class: 'pc-stats' });

  root.append(h('div', { class: 'pc' },
    rec,
    h('div', { class: 'pc-work' },
      h('section', { class: 'pc-panel pc-boardp' }, h('div', { class: 'pc-head' }, h('h2', {}, 'Board'), h('span', { class: 'pc-sub' }, 'top view and section, to scale'), h('span', { class: 'pc-grow' }), stats),
        h('div', { class: 'pc-paper' }, boardSvg), boardHint),
      h('div', { class: 'pc-side' },
        h('section', { class: 'pc-panel' }, h('div', { class: 'pc-head' }, h('h2', {}, 'Rails'), h('span', { class: 'pc-sub' }, 'power group, volts; band = tolerance')), railSvg, railMore),
        h('section', { class: 'pc-panel' }, h('div', { class: 'pc-head' }, h('h2', {}, 'Limits'), h('span', { class: 'pc-sub' }, 'the other values with a tolerance or a range')), limitsBox))),
    h('section', { class: 'pc-panel pc-ledgerp' }, h('div', { class: 'pc-head' }, h('h2', {}, 'Constants'), h('span', { class: 'pc-sub' }, 'the project\'s list; edit in place'),
      h('span', { class: 'pc-grow' }), h('label', { class: 'pc-f' }, h('span', {}, 'Show only'), filterIn)), ledger),
    h('div', { class: 'pc-bottom' }, h('div', { class: 'pc-msgs' }, warns, notes), ctx.outputs)));

  // ---------- board drawing ----------
  const BW = 760, BH = 560;
  let geo = null;           // the last drawing's scale, for dragging
  function dim(g, x1, y1, x2, y2, off, text, cls = '') {
    // a dimension line parallel to (x1,y1)-(x2,y2), off units along its left-hand normal
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    const ux = -dy / L, uy = dx / L, sg = Math.sign(off) || 1;
    const a = [x1 + ux * off, y1 + uy * off], b = [x2 + ux * off, y2 + uy * off];
    const over = (p) => [p[0] + ux * 4 * sg, p[1] + uy * 4 * sg];
    const ea = over(a), eb = over(b);
    g.append(sv('line', { x1: x1 + ux * 3 * sg, y1: y1 + uy * 3 * sg, x2: ea[0], y2: ea[1], class: 'pc-ext' }),
      sv('line', { x1: x2 + ux * 3 * sg, y1: y2 + uy * 3 * sg, x2: eb[0], y2: eb[1], class: 'pc-ext' }),
      sv('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: `pc-dim ${cls}`, 'marker-start': 'url(#pc-arr)', 'marker-end': 'url(#pc-arr)' }));
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const vert = Math.abs(dy) > Math.abs(dx);
    // text on the outer side of the line, clear of it
    const ox = ux * sg, oy = uy * sg;
    const tx = vert ? (ox < 0 ? mx - 5 : mx + 14) : mx, ty = vert ? my : (oy < 0 ? my - 5 : my + 14);
    g.append(sv('text', { x: tx, y: ty, class: `pc-dimt ${cls}`, 'text-anchor': 'middle', transform: vert ? `rotate(-90 ${tx} ${ty})` : null }, text));
  }
  const valText = (it) => (it ? `${it.text}${it.tol ? ` ${it.tol}` : ''}${it.unit && it.unit !== '-' && it.unit !== 'mm' ? ` ${it.unit}` : ''}` : '');
  const handle = (attrs, row, label) => sv('g', { class: `pc-h${state.sel === row ? ' on' : ''}`, tabindex: 0, role: 'slider', 'data-row': row, 'aria-label': label, ...attrs });

  function drawBoard() {
    boardSvg.replaceChildren();
    boardSvg.setAttribute('viewBox', `0 0 ${BW} ${BH}`);
    const defs = sv('defs');
    const arr = sv('marker', { id: 'pc-arr', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    arr.append(sv('path', { d: 'M0,2 L10,5 L0,8 z', class: 'pc-arrh' }));
    const hatch = sv('pattern', { id: 'pc-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.append(sv('rect', { width: 2, height: 6, class: 'pc-hatchl' }));
    defs.append(arr, hatch);
    boardSvg.append(defs);
    const r = roles();
    const W = r.w?.kind === 'number' ? r.w.value : null, H = r.h?.kind === 'number' ? r.h.value : null;
    if (!(W > 0 && H > 0)) {
      geo = null;
      boardSvg.append(sv('text', { x: BW / 2, y: BH / 2 - 8, class: 'pc-lbl b', 'text-anchor': 'middle' }, 'No board outline to draw'),
        sv('text', { x: BW / 2, y: BH / 2 + 12, class: 'pc-lbl', 'text-anchor': 'middle' }, 'Name two numbers BOARD_W and BOARD_H (in mm) and the board is drawn here to scale.'));
      return;
    }
    const unit = r.w.unit || 'mm';
    const T = r.t?.kind === 'number' ? r.t.value : null;
    const PH = r.partH?.kind === 'number' ? r.partH.value : null;
    const WALL = r.wall?.kind === 'number' ? r.wall.value : null;
    const same = (it) => it && it.kind === 'number' && (it.unit || 'mm') === unit;
    // scale: the top view and the section share it
    const secH = (T || 0) + (same(r.partH) ? PH : 0);
    const compact = boardSvg.classList.contains('compact');
    const availW = BW - (compact ? 250 : 170), availH = BH - 175;
    // while a handle is dragged the scale holds still, so the handle stays under the pointer
    const k = state.drag?.k || Math.min(availW / (W + 2 * (same(r.wall) ? WALL : 0)), availH / (H + secH + 8));
    const x0 = compact ? 150 : 95, y0 = 48;
    const bw = W * k, bh = H * k;
    geo = { k, x0, y0, W, H, unit };
    const g = sv('g');
    boardSvg.append(g);
    // board
    const on = (it) => (it && state.sel === it.row ? ' on' : '');
    const bad = (it) => (it && it.problems.length ? ' bad' : '');
    const dimW = sv('g', { class: `pc-dimg${on(r.w)}${bad(r.w)}`, 'data-row': r.w.row }), dimH = sv('g', { class: `pc-dimg${on(r.h)}${bad(r.h)}`, 'data-row': r.h.row });
    g.append(sv('rect', { x: x0, y: y0, width: bw, height: bh, rx: Math.min(8, 1 * k), class: 'pc-pcb' }));
    // tolerance band on the outline (drawn only when it is visible at this scale)
    if (r.w.max != null && (r.w.max - r.w.min) * k >= 1.5) g.append(sv('rect', { x: x0 + bw - (r.w.value - r.w.min) * k, y: y0 - 4, width: (r.w.max - r.w.min) * k, height: bh + 8, class: 'pc-tolband' }));
    if (r.h.max != null && (r.h.max - r.h.min) * k >= 1.5) g.append(sv('rect', { x: x0 - 4, y: y0 + bh - (r.h.value - r.h.min) * k, width: bw + 8, height: (r.h.max - r.h.min) * k, class: 'pc-tolband' }));
    g.append(sv('text', { x: x0 + bw / 2, y: y0 + bh / 2 + 4, class: 'pc-lbl soft onpcb', 'text-anchor': 'middle' }, `${r.w.name} × ${r.h.name}`));
    dim(dimW, x0, y0, x0 + bw, y0, -26, `${valText(r.w)}`); g.append(dimW);
    dim(dimH, x0, y0 + bh, x0, y0, -30, `${valText(r.h)}`); g.append(dimH);
    // holes
    const D = same(r.holeD) ? r.holeD.value : null, I = same(r.inset) ? r.inset.value : null;
    if (D > 0 || I > 0) {
      const inset = I > 0 ? I : (D || 3) * 1.1;
      const rad = ((D > 0 ? D : 3) / 2) * k;
      const pts = [[x0 + inset * k, y0 + inset * k], [x0 + bw - inset * k, y0 + inset * k], [x0 + inset * k, y0 + bh - inset * k], [x0 + bw - inset * k, y0 + bh - inset * k]];
      const holeBad = inset * 2 >= Math.min(W, H) || (D > 0 && inset < D / 2);
      for (const [cx, cy] of pts) {
        g.append(sv('circle', { cx, cy, r: rad, class: `pc-hole${holeBad ? ' bad' : ''}` }),
          sv('line', { x1: cx - rad - 5, x2: cx + rad + 5, y1: cy, y2: cy, class: 'pc-cl' }), sv('line', { x1: cx, x2: cx, y1: cy - rad - 5, y2: cy + rad + 5, class: 'pc-cl' }));
      }
      const [hx, hy] = pts[3];
      if (r.holeD) {
        const dg = sv('g', { class: `pc-dimg${on(r.holeD)}${bad(r.holeD)}`, 'data-row': r.holeD.row });
        const ang = Math.PI / 4, lx = hx + Math.cos(ang) * rad, ly = hy - Math.sin(ang) * rad;
        dg.append(sv('path', { d: `M${lx},${ly} L${lx + 22},${ly - 22} h 18`, class: 'pc-lead' }),
          sv('text', { x: lx + 44, y: ly - 18, class: 'pc-dimt' }, `Ø${valText(r.holeD)}`));
        g.append(dg);
      }
      if (r.inset) {
        const ig = sv('g', { class: `pc-dimg${on(r.inset)}${bad(r.inset)}`, 'data-row': r.inset.row });
        dim(ig, x0, y0 + bh, pts[2][0], y0 + bh, 22, valText(r.inset));
        g.append(ig);
        const [cx, cy] = pts[0];
        const hd = handle({ transform: `translate(${cx} ${cy})` }, r.inset.row, `${r.inset.name} ${r.inset.text} ${unit}: drag the hole, or arrow keys`);
        hd.dataset.kind = 'inset';
        hd.append(sv('circle', { r: Math.max(rad + 6, 11), class: 'pc-hring' }), sv('title', {}, `${r.inset.name}: drag the hole to move all four`));
        g.append(hd);
      }
      if (holeBad) g.append(sv('text', { x: x0 + bw / 2, y: y0 + bh / 2 + 22, class: 'pc-lbl bad', 'text-anchor': 'middle' }, D > 0 && inset < D / 2 ? 'hole breaks the board edge' : 'holes overlap: inset too large'));
    }
    // outline corner handle
    const ch = handle({ transform: `translate(${x0 + bw} ${y0 + bh})` }, r.w.row, `${r.w.name} ${r.w.text} and ${r.h.name} ${r.h.text} ${unit}: drag the corner, or arrow keys`);
    ch.dataset.kind = 'corner';
    ch.append(sv('rect', { x: -7, y: -7, width: 14, height: 14, rx: 2, class: 'pc-hbox' }), sv('title', {}, 'Drag to resize the board'));
    g.append(ch);

    // ---- side section ----
    const sy = y0 + bh + 78;
    if (!compact) g.append(sv('text', { x: 10, y: sy + 4, class: 'pc-lbl b' }, 'Section'));
    const tt = T > 0 && same(r.t) ? T * k : 6;
    const top = sy + (same(r.partH) && PH > 0 ? PH * k : 20);
    // walls
    if (same(r.wall) && WALL > 0) {
      const wk = WALL * k, hgt = top + tt - sy + 10;
      const wg = sv('g', { class: `pc-dimg${on(r.wall)}${bad(r.wall)}`, 'data-row': r.wall.row });
      wg.append(sv('rect', { x: x0 - wk - 3, y: sy - 10, width: wk, height: hgt, class: 'pc-wall' }),
        sv('rect', { x: x0 + bw + 3, y: sy - 10, width: wk, height: hgt, class: 'pc-wall' }));
      wg.append(sv('text', { x: x0 + bw + 3 + wk / 2, y: sy + hgt + 6, class: 'pc-dimt', 'text-anchor': 'middle' }, `wall ${valText(r.wall)}`));
      g.append(wg);
    }
    // parts envelope
    if (same(r.partH) && PH > 0) {
      const pg = sv('g', { class: `pc-dimg${on(r.partH)}${bad(r.partH)}`, 'data-row': r.partH.row });
      pg.append(sv('rect', { x: x0 + 2, y: sy, width: bw - 4, height: top - sy, class: 'pc-env' }));
      // a few parts, for scale
      const parts = [[0.12, 0.35, 0.9], [0.52, 0.18, 0.55], [0.76, 0.14, 0.3]];
      for (const [fx, fw, fh] of parts) pg.append(sv('rect', { x: x0 + bw * fx, y: top - (top - sy) * fh, width: bw * fw, height: (top - sy) * fh, class: 'pc-part' }));
      dim(pg, x0 + bw, top, x0 + bw, sy, 34, valText(r.partH));
      g.append(pg);
      const hh = handle({ transform: `translate(${x0 + bw / 2} ${sy})` }, r.partH.row, `${r.partH.name} ${r.partH.text} ${unit}: drag the top, or arrow keys`);
      hh.dataset.kind = 'partH';
      hh.append(sv('rect', { x: -16, y: -5, width: 32, height: 10, rx: 3, class: 'pc-hbox' }), sv('title', {}, 'Drag to change the part height'));
      g.append(hh);
    } else g.append(sv('text', { x: x0 + 4, y: top - 6, class: 'pc-lbl soft' }, 'name a MAX_PART_HEIGHT to draw the parts envelope'));
    g.append(sv('rect', { x: x0, y: top, width: bw, height: tt, class: 'pc-pcb' }));
    if (r.t) {
      const tg = sv('g', { class: `pc-dimg${on(r.t)}${bad(r.t)}`, 'data-row': r.t.row });
      tg.append(sv('path', { d: `M${x0 - 2},${top + tt / 2} h -22`, class: 'pc-lead' }),
        sv('text', { x: x0 - 28, y: top + tt / 2 + 4, class: 'pc-dimt', 'text-anchor': 'end' }, `${valText(r.t)}`));
      g.append(tg);
    }
    // scale note
    g.append(sv('text', { x: BW - 12, y: BH - 10, class: 'pc-lbl soft', 'text-anchor': 'end' }, `drawn in ${unit}, 1 ${unit} = ${k.toFixed(1)} px`));
    boardHint.textContent = 'Drag the corner square to resize the board, a top-left hole to move the holes, the bar on the parts to change their height · focused handle: arrows change it (Shift: ×10) · click a dimension to find its row.';
  }

  // ---------- rails ----------
  const RW = 420, RH = 300;
  let rgeo = null;
  function drawRails() {
    railSvg.replaceChildren();
    railSvg.setAttribute('viewBox', `0 0 ${RW} ${RH}`);
    const rails = sheet().filter((it) => it.group === 'power' && it.kind === 'number' && VOLT[it.unit] != null);
    const others = sheet().filter((it) => it.group === 'power' && !(it.kind === 'number' && VOLT[it.unit] != null));
    railMore.replaceChildren(...others.map((it) => h('button', { type: 'button', class: `pc-chip${state.sel === it.row ? ' on' : ''}`, onclick: () => select(it.row) }, h('b', {}, it.name || '(no name)'), ` ${it.text} ${it.unit}`)));
    if (!rails.length) {
      rgeo = null;
      railSvg.append(sv('text', { x: RW / 2, y: RH / 2, class: 'pc-lbl', 'text-anchor': 'middle' }, 'No voltages in the power group yet.'));
      return;
    }
    const volts = (it, v) => v * VOLT[it.unit];
    const hi = Math.max(...rails.map((it) => volts(it, it.max ?? it.value))) * 1.18 || 1;
    const raw = hi / 5, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
    const vmax = state.drag?.vmax || Math.ceil(hi / step) * step;
    const L = 44, R = RW - 8, T = 14, B = RH - 22;
    const Y = (v) => B - (v / vmax) * (B - T);
    rgeo = { Y, vmax, T, B };
    for (let i = 0; i <= Math.round(vmax / step); i++) {
      const v = i * step;
      railSvg.append(sv('line', { x1: L, x2: R, y1: Y(v), y2: Y(v), class: 'pc-grid' }),
        sv('text', { x: L - 6, y: Y(v) + 3.5, class: 'pc-tick', 'text-anchor': 'end' }, `${tidy(v)}`));
    }
    railSvg.append(sv('text', { x: L - 6, y: B + 16, class: 'pc-tick', 'text-anchor': 'end' }, 'V'));
    // labels without overlap: sorted by height, pushed apart
    const sorted = [...rails].sort((a, b) => volts(b, b.value) - volts(a, a.value));
    let last = -Infinity;
    const ly = new Map();
    for (const it of sorted) { let y = Y(volts(it, it.value)); if (y - last < 30) y = last + 30; ly.set(it.row, y); last = y; }
    const over = last - (B - 4);
    if (over > 0) for (const [k2, y] of ly) ly.set(k2, y - over);
    const lineX = L + 16, lineW = 150;
    for (const it of rails) {
      const y = Y(volts(it, it.value));
      const g = sv('g', { class: `pc-rail${state.sel === it.row ? ' on' : ''}${it.problems.length ? ' bad' : ''}${it.shown ? '' : ' dim'}`, 'data-row': it.row });
      if (it.min != null) g.append(sv('rect', { x: lineX, y: Y(volts(it, it.max)), width: lineW, height: Math.max(1, Y(volts(it, it.min)) - Y(volts(it, it.max))), class: 'pc-band' }));
      g.append(sv('line', { x1: lineX, x2: lineX + lineW, y1: y, y2: y, class: 'pc-rl' }));
      const yl = ly.get(it.row);
      g.append(sv('path', { d: `M${lineX + lineW},${y} L${lineX + lineW + 14},${yl} h 6`, class: 'pc-lead' }));
      g.append(sv('text', { x: lineX + lineW + 24, y: yl - 2, class: 'pc-rname' }, it.name || '(no name)'),
        sv('text', { x: lineX + lineW + 24, y: yl + 11, class: 'pc-rval' }, `${it.text} ${it.unit}${it.tol ? ` ${it.tol}` : ''}${it.min != null ? `  ·  ${tidy(it.min)}…${tidy(it.max)}` : ''}`));
      const hd = handle({ transform: `translate(${lineX + lineW / 2} ${y})` }, it.row, `${it.name} ${it.text} ${it.unit}: drag up or down, or arrow keys`);
      hd.dataset.kind = 'rail';
      hd.append(sv('rect', { x: -lineW / 2, y: -7, width: lineW, height: 14, class: 'pc-hit' }), sv('circle', { r: 5, class: 'pc-knob' }), sv('title', {}, `${it.name}: drag to change`));
      g.append(hd);
      railSvg.append(g);
    }
  }

  // ---------- limits strips ----------
  function drawLimits() {
    const r = roles();
    const drawn = new Set(Object.values(r).map((it) => it.row));
    const list = sheet().filter((it) => it.min != null && !drawn.has(it.row) && !(it.group === 'power' && VOLT[it.unit] != null));
    limitsBox.replaceChildren();
    if (!list.length) { limitsBox.append(h('div', { class: 'pc-empty' }, 'Nothing else has limits. Give a value a tolerance (±5%) or write a range (-20..60).')); return; }
    for (const it of list) {
      const span = it.max - it.min;
      const range = it.kind === 'range';
      // the strip's axis: the limits with a margin, zero included when it is close
      let a = it.min - span * 0.25, b = it.max + span * 0.25;
      if (range && a > 0 && a < span) a = 0;
      if (range && b < 0 && -b < span) b = 0;
      if (!(b > a)) { a -= 1; b += 1; }
      const X = (v) => 6 + ((v - a) / (b - a)) * 288;
      const s = sv('svg', { viewBox: '0 0 300 30', class: 'pc-strip', 'aria-hidden': 'true' });
      s.append(sv('line', { x1: 6, x2: 294, y1: 16, y2: 16, class: 'pc-axis' }));
      if (range && a <= 0 && b >= 0) s.append(sv('line', { x1: X(0), x2: X(0), y1: 8, y2: 24, class: 'pc-zero' }), sv('text', { x: X(0), y: 7, class: 'pc-tick', 'text-anchor': 'middle' }, '0'));
      s.append(sv('rect', { x: X(it.min), y: 10, width: Math.max(2, X(it.max) - X(it.min)), height: 12, rx: 2, class: 'pc-band' }));
      if (!range) s.append(sv('line', { x1: X(it.value), x2: X(it.value), y1: 6, y2: 26, class: 'pc-nom' }));
      s.append(sv('text', { x: X(it.min) - 3, y: 29, class: 'pc-tick', 'text-anchor': 'end' }, tidy(it.min)), sv('text', { x: X(it.max) + 3, y: 29, class: 'pc-tick' }, tidy(it.max)));
      limitsBox.append(h('button', { type: 'button', class: `pc-lim${state.sel === it.row ? ' on' : ''}${it.problems.length ? ' bad' : ''}${it.shown ? '' : ' dim'}`, 'data-row': it.row, onclick: () => select(it.row) },
        h('span', { class: 'n' }, it.name || `(row ${it.row + 1})`), h('span', { class: 'v' }, `${it.text} ${it.unit}${it.tol ? ` ${it.tol}` : ''}`), s));
    }
  }

  // ---------- drag and keys ----------
  function applyDrag(kind, row, px, py) {
    const r = roles();
    if (kind === 'corner' && geo) {
      const W = clamp(roundTo((px - geo.x0) / geo.k, 0.5), 1, geo.W * 4), H = clamp(roundTo((py - geo.y0) / geo.k, 0.5), 1, geo.H * 4);
      const rows = rowsNow();
      if (rows[r.w.row]) rows[r.w.row].value = tidy(W);
      if (rows[r.h.row]) rows[r.h.row].value = tidy(H);
      ctx.set('constants', rows);
    } else if (kind === 'inset' && geo) {
      const v = clamp(roundTo(((px - geo.x0) + (py - geo.y0)) / 2 / geo.k, 0.1), 0.5, Math.min(geo.W, geo.H) / 2);
      setValue(row, tidy(v));
    } else if (kind === 'rail' && rgeo) {
      const it = byRow(row); if (!it) return;
      const volts = clamp(roundTo(((rgeo.B - py) / (rgeo.B - rgeo.T)) * rgeo.vmax, 0.05), 0, rgeo.vmax * 1.5);
      setValue(row, tidy(volts / VOLT[it.unit]));
    }
  }
  const svgPoint = (svg, e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  for (const svg of [boardSvg, railSvg]) {
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const hd = e.target.closest('.pc-h');
      if (!hd) { const g = e.target.closest('[data-row]'); if (g) select(+g.dataset.row); return; }
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      const row = +hd.dataset.row;
      // the parts envelope's top is dragged against the board's top surface
      let base = null;
      if (hd.dataset.kind === 'partH') { const it = byRow(row); base = svgPoint(svg, e).y + (it?.value || 0) * geo.k; }
      state.drag = { svg, kind: hd.dataset.kind, row, base, k: svg === boardSvg ? geo?.k : null, vmax: svg === railSvg ? rgeo?.vmax : null };
      state.sel = row;
      hd.focus({ preventScroll: true });
    });
    svg.addEventListener('pointermove', (e) => {
      const d = state.drag; if (!d || d.svg !== svg) return;
      const p = svgPoint(svg, e);
      if (d.kind === 'partH') {
        const v = clamp(roundTo((d.base - p.y) / geo.k, 0.5), 0.5, 200);
        if (String(v) !== String(byRow(d.row)?.value)) setValue(d.row, tidy(v));
      } else applyDrag(d.kind, d.row, p.x, p.y);
    });
    const end = (e) => { if (!state.drag) return; const d = state.drag; state.drag = null; try { svg.releasePointerCapture(e.pointerId); } catch { /* gone */ } state.refocus = { kind: d.kind, row: d.row }; paint(); };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('keydown', (e) => {
      const hd = e.target.closest('.pc-h'); if (!hd) return;
      const kind = hd.dataset.kind, row = +hd.dataset.row, r = roles();
      const big = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      const dy = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      state.refocus = { kind, row };
      if (kind === 'corner') {
        const rows = rowsNow();
        if (dx) rows[r.w.row].value = tidy(Math.max(0.5, r.w.value + dx * 0.5 * big));
        if (dy) rows[r.h.row].value = tidy(Math.max(0.5, r.h.value - dy * 0.5 * big));
        ctx.set('constants', rows);
      } else {
        const it = byRow(row); if (!it || it.kind !== 'number') return;
        const stepv = kind === 'rail' ? 0.05 / VOLT[it.unit] : kind === 'inset' ? 0.1 : 0.5;
        setValue(row, tidy(Math.max(0, it.value + (dx || dy) * stepv * big)));
      }
    });
  }

  // ---------- ledger ----------
  const cols = [['name', 'Name'], ['value', 'Value'], ['unit', 'Unit'], ['tol', 'Tolerance']];
  function buildLedger() {
    const rows = ctx.raw.constants || [];
    const f = String(ctx.raw.filter || '').trim().toLowerCase();
    state.sig = JSON.stringify([rows.length, rows.map((r) => r.group), f]);
    ledger.replaceChildren();
    const byGroup = new Map(GROUPS.map((g) => [g, []]));
    rows.forEach((r, i) => (byGroup.get(GROUPS.includes(r.group) ? r.group : 'other')).push(i));
    for (const g of GROUPS) {
      const idx = byGroup.get(g);
      const sec = h('div', { class: 'pc-grp' }, h('div', { class: 'pc-gh' }, h('span', {}, g), h('small', {}, idx.length || ''),
        h('button', { type: 'button', class: 'pc-add', title: `Add a constant to ${g}`, onclick: () => addRow(g) }, '+ add')));
      for (const i of idx) sec.append(ledgerRow(rows[i], i));
      if (idx.length || g !== 'other') ledger.append(sec);
    }
    syncLedger();
  }
  function ledgerRow(r, i) {
    const cells = cols.map(([k, label]) => {
      const inp = h('input', { type: 'text', class: `pc-c c-${k}`, 'aria-label': `${label}, row ${i + 1}`, spellcheck: 'false', 'data-k': k });
      inp.value = r[k] ?? '';
      inp.addEventListener('input', () => { const rows = rowsNow(); rows[i][k] = inp.value; ctx.set('constants', rows); });
      inp.addEventListener('focus', () => { if (state.sel !== i) select(i, 'ledger'); });
      return inp;
    });
    const grp = h('select', { class: 'pc-c c-group', 'aria-label': `Group, row ${i + 1}` }, GROUPS.map((g) => h('option', { value: g, selected: g === r.group }, g)));
    grp.addEventListener('change', () => { const rows = rowsNow(); rows[i].group = grp.value; ctx.set('constants', rows); });
    const note = h('input', { type: 'text', class: 'pc-c c-note', 'aria-label': `Note, row ${i + 1}`, placeholder: 'note' });
    note.value = r.note ?? '';
    note.addEventListener('input', () => { const rows = rowsNow(); rows[i].note = note.value; ctx.set('constants', rows); });
    note.addEventListener('focus', () => { if (state.sel !== i) select(i, 'ledger'); });
    const del = h('button', { type: 'button', class: 'pc-del', title: 'Remove this constant', 'aria-label': `Remove row ${i + 1}`, onclick: () => { const rows = rowsNow(); rows.splice(i, 1); state.sel = null; ctx.set('constants', rows); } }, '×');
    return h('div', { class: 'pc-row', 'data-row': i, onclick: (e) => { if (e.target === e.currentTarget) select(i, 'ledger'); } },
      ...cells, h('span', { class: 'pc-lims' }), grp, note, del, h('div', { class: 'pc-prob' }));
  }
  function syncLedger() {
    const f = String(ctx.raw.filter || '').trim();
    for (const el of ledger.querySelectorAll('.pc-row')) {
      const i = +el.dataset.row, it = byRow(i);
      el.classList.toggle('on', state.sel === i);
      el.classList.toggle('bad', !!it?.problems.length);
      el.classList.toggle('dim', !!f && !!it && !it.shown);
      el.querySelector('.pc-lims').textContent = it && it.min != null ? `${tidy(it.min)} … ${tidy(it.max)}` : '';
      el.querySelector('.pc-lims').title = it && it.min != null ? 'min … max' : '';
      el.querySelector('.pc-prob').textContent = it?.problems.join(' ') || '';
      const raw = (ctx.raw.constants || [])[i] || {};
      for (const inp of el.querySelectorAll('input[data-k]')) if (document.activeElement !== inp) inp.value = raw[inp.dataset.k] ?? '';
    }
  }
  function addRow(group) {
    const rows = rowsNow();
    let n = 1; while (rows.some((r) => r.name === `NEW_${n}`)) n++;
    rows.push({ name: `NEW_${n}`, value: '', unit: group === 'power' ? 'V' : group === 'environment' || group === 'thermal' ? '°C' : 'mm', tol: '', group, note: '' });
    state.sel = rows.length - 1;
    ctx.set('constants', rows);
    const inp = ledger.querySelector(`.pc-row[data-row="${rows.length - 1}"] input[data-k="name"]`);
    if (inp) { inp.focus(); inp.select(); }
  }

  // ---------- the project record ----------
  const recSt = { project: null, loaded: false, busy: false, msg: '', tone: '', updated: null, saved: null };
  const inApp = /^https?:/.test(location.protocol);
  const recUrl = () => `/api/tools/data/${TOOL}?project=${encodeURIComponent(recSt.project)}`;
  const dirty = () => recSt.saved == null || JSON.stringify(ctx.raw.constants ?? null) !== recSt.saved;
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
  async function load() {
    recSt.busy = true; recSt.msg = `Loading project "${recSt.project}"…`; recSt.tone = ''; drawRec();
    try {
      const r = await fetch(recUrl());
      if (!r.ok) throw new Error(`the app answered ${r.status}`);
      const body = await r.json();
      const data = body.data || {};
      recSt.loaded = true; recSt.busy = false; recSt.updated = body.updated || null;
      if (!('constants' in data)) {
        recSt.saved = null; recSt.tone = 'warn';
        recSt.msg = `Nothing saved for "${recSt.project}" yet: the sheet shows your last edit or the example. Press Save to make it the project's record.`;
        drawRec(); return;
      }
      recSt.saved = JSON.stringify(data.constants); recSt.msg = `Loaded project "${recSt.project}".`; recSt.tone = 'ok';
      ctx.set('constants', structuredClone(data.constants));
    } catch (e) {
      recSt.loaded = true; recSt.busy = false; recSt.tone = 'bad';
      recSt.msg = `Could not load the project record (${e.message || e}). The sheet still works; save again later.`;
      drawRec();
    }
  }
  async function save() {
    recSt.busy = true; recSt.msg = 'Saving…'; recSt.tone = ''; drawRec();
    const data = { constants: ctx.raw.constants ?? null };
    try {
      const r = await fetch(recUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' }, body: JSON.stringify({ data }) });
      if (!r.ok) {
        let why = String(r.status);
        try { why = (await r.json()).detail || why; } catch { /* not JSON */ }
        throw new Error(r.status === 403 ? `not allowed to edit this project (${why})` : why);
      }
      const body = await r.json();
      recSt.saved = JSON.stringify(data.constants); recSt.updated = body.updated || new Date().toISOString();
      recSt.msg = `Saved to project "${recSt.project}".`; recSt.tone = 'ok';
    } catch (e) { recSt.msg = `Not saved: ${e.message || e}.`; recSt.tone = 'bad'; }
    recSt.busy = false; drawRec();
  }
  const projIn = h('input', { type: 'text', class: 'pc-in pc-proj', 'aria-label': 'Project', spellcheck: 'false' });
  projIn.addEventListener('change', () => {
    const p = projIn.value.trim() || 'default';
    if (p === recSt.project) return;
    if (recSt.saved != null && dirty() && !confirm(`Load project "${p}"? Unsaved changes here stay only if "${p}" has no record yet.`)) { projIn.value = recSt.project; return; }
    recSt.project = p; recSt.saved = null; load();
  });
  function drawRec() {
    const tone = (t) => (t === 'bad' ? 'bad' : t === 'warn' ? 'warn' : t === 'ok' ? 'ok' : '');
    if (!inApp) {
      rec.replaceChildren(h('b', {}, 'Project record'), h('span', { class: 'pc-msg' }, 'Open this tool in the app to load and save the project\'s shared record. Opened as a file it edits the sheet only: copy the JSON output to keep it.'));
      return;
    }
    if (document.activeElement !== projIn) projIn.value = recSt.project;
    const changed = recSt.loaded && !recSt.busy && dirty();
    rec.replaceChildren(h('b', {}, 'Project record'),
      h('label', { class: 'pc-f' }, h('span', {}, 'Project'), projIn),
      h('button', { class: 'k-btn k-primary', disabled: recSt.busy, onclick: save }, recSt.busy ? 'Working…' : 'Save to project'),
      h('button', { class: 'k-btn', disabled: recSt.busy, title: 'Load the saved record again (replaces the sheet)',
        onclick: () => { if (!dirty() || recSt.saved == null || confirm('Replace the sheet with the saved record?')) load(); } }, 'Reload'),
      h('span', { class: `pc-saved${changed ? ' warn' : ''}` }, recSt.updated ? `saved ${when(recSt.updated)}` : 'never saved', changed ? ' · unsaved changes' : ''),
      recSt.msg ? h('span', { class: `pc-msg ${tone(recSt.tone)}`, role: 'status' }, recSt.msg) : null,
      h('span', { class: 'pc-agent' }, `agents: MCP tool_data, id "${TOOL}", project "${recSt.project}"`));
  }

  // ---------- render ----------
  function paint() {
    const res = ctx.result; if (!res) return;
    drawBoard(); drawRails(); drawLimits(); syncLedger();
    if (state.refocus) {
      const { kind, row } = state.refocus; state.refocus = null;
      const el = root.querySelector(`.pc-h[data-kind="${kind}"][data-row="${row}"]`);
      el?.focus({ preventScroll: true });
    }
  }
  function render(res) {
    if (!res) return;
    if (document.activeElement !== filterIn) filterIn.value = ctx.raw.filter ?? '';
    const rows = ctx.raw.constants || [];
    if (state.sel != null && !rows[state.sel]) state.sel = null;
    const sig = JSON.stringify([rows.length, rows.map((r) => r.group), String(ctx.raw.filter || '').trim().toLowerCase()]);
    if (sig !== state.sig) buildLedger();
    if (!state.refocus && document.activeElement?.closest?.('.pc-h')) {
      const a = document.activeElement.closest('.pc-h'); state.refocus = { kind: a.dataset.kind, row: +a.dataset.row };
    }
    paint();
    stats.replaceChildren(...(res.values || []).map((v) => h('span', { class: `pc-stat${v.tone ? ` ${v.tone}` : ''}`, title: v.hint || null }, `${v.label} `, h('b', {}, String(v.value)))));
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    drawRec();
  }
  // Narrow: the drawings are shown small, so their text is set larger in SVG units.
  new ResizeObserver(() => {
    const c = boardSvg.clientWidth > 0 && boardSvg.clientWidth < 560;
    if (c !== boardSvg.classList.contains('compact')) { boardSvg.classList.toggle('compact', c); if (ctx.result) drawBoard(); }
    railSvg.classList.toggle('compact', railSvg.clientWidth > 0 && railSvg.clientWidth < 380);
  }).observe(root);
  ctx.onResult((res) => render(res));
  if (inApp) {
    let p = null;
    try { p = new URLSearchParams(location.search).get('project'); } catch { /* none */ }
    recSt.project = (p || 'default').trim() || 'default';
    load();
  } else drawRec();
}
