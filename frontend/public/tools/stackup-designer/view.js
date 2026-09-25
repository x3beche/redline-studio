// Stackup Designer: the page is the build itself, drawn to scale.
//   Stack   - every row, top to bottom, at its real thickness: copper (signal
//             layers with traces, planes solid, mixed planes with gaps),
//             prepreg with its glass weave, cores, mask. Drag the lower edge
//             of any prepreg or core to make it thicker or thinner; click a
//             row to edit it; click a copper row's name to cycle Signal /
//             Plane / Mixed. The mirror axis says whether the build is
//             symmetric.
//   Caliper - the finished thickness against your target band, on the left.
//   Gutter  - an arc from each signal layer to the plane it refers to, with
//             the height H between them.
//   Widths  - beside each signal layer, the trace and the pair it needs for
//             your impedance targets, drawn to one scale, with the numbers.
//   Rails   - builds to start from and the targets (left); the chosen row,
//             the warnings and the outputs (right).
// Every thickness, width, reference and verdict drawn comes from run()'s
// result (result.stack, result.planePairs, result.values).

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
const sv = (parent, tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const KIND = { signal: 'Signal', plane: 'Plane', mixed: 'Mixed', prepreg: 'Prepreg', core: 'Core', mask: 'Mask' };
const isCu = (k) => k === 'signal' || k === 'plane' || k === 'mixed';
const isDiel = (k) => k === 'prepreg' || k === 'core';
const OZ = 34.8;

const r = (kind, t, er = '') => ({ kind, t: String(t), er: String(er) });
const PRESETS = [
  { id: '2', name: '2 layers', note: '1.6 mm, one core', rows: [r('Signal', 35), r('Core', 1530, 4.5), r('Signal', 35)] },
  { id: '4', name: '4 layers', note: 'S · G · G · S', rows: [r('Signal', 35), r('Prepreg', 200, 4.2), r('Plane', 35), r('Core', 1065, 4.5), r('Plane', 35), r('Prepreg', 200, 4.2), r('Signal', 35)] },
  { id: '6', name: '6 layers', note: 'S · G · S · P · G · S', rows: [r('Signal', 35), r('Prepreg', 110, 4.1), r('Plane', 35), r('Core', 250, 4.4), r('Signal', 35), r('Prepreg', 670, 4.3),
    r('Plane', 35), r('Core', 250, 4.4), r('Plane', 35), r('Prepreg', 110, 4.1), r('Signal', 35)] },
  { id: '8', name: '8 layers', note: 'S · G · S · P · G · S · G · S', rows: [r('Signal', 35), r('Prepreg', 100, 4.1), r('Plane', 35), r('Core', 305, 4.4), r('Signal', 35), r('Prepreg', 100, 4.1),
    r('Plane', 35), r('Core', 305, 4.4), r('Plane', 35), r('Prepreg', 100, 4.1), r('Signal', 35), r('Core', 305, 4.4), r('Plane', 35), r('Prepreg', 100, 4.1), r('Signal', 35)] },
];

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let res = null;
  let sel = 0;              // selected raw row index
  let frozenK = null;       // px per µm, kept while dragging
  let drag = null;
  let pending = null;
  let focusSel = false;

  const fmt = (v, d = 3) => ctx.fmtNum(v, d);
  const rows = () => (Array.isArray(ctx.raw.layers) ? ctx.raw.layers.map((x) => ({ ...x })) : []);
  const setRows = (l, newSel) => { if (newSel != null) sel = newSel; ctx.set('layers', l); };
  const setSoon = (l) => {
    const first = !pending;
    pending = l;
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.set('layers', p); });
  };
  const kindOf = (row) => String(row?.kind || '').toLowerCase();

  // ---------- left rail: builds and targets ----------
  const presetBox = h('div', { class: 'su-presets' });
  function miniStack(rs) {
    const s = sv(null, 'svg', { viewBox: '0 0 44 56', class: 'su-mstack', 'aria-hidden': 'true' });
    const tot = rs.reduce((a, x) => a + Number(x.t), 0);
    let y = 2;
    for (const x of rs) {
      const k = kindOf(x), hh = Math.max(isCu(k) ? 2.2 : 1, (Number(x.t) / tot) * 46);
      sv(s, 'rect', { x: 2, y, width: 40, height: hh, class: `m-${k}` });
      y += hh;
    }
    return s;
  }
  for (const p of PRESETS) {
    presetBox.append(h('button', { type: 'button', class: 'su-preset', title: `Start from a ${p.name} build (${p.note})`,
      onclick: () => { sel = 0; ctx.set('layers', structuredClone(p.rows)); } }, miniStack(p.rows), h('b', {}, p.name), h('small', {}, p.note)));
  }
  const field = (key, label, unit, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', id: `su-${key}`, oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('div', { class: 'su-f', title: title || null }, h('label', { for: `su-${key}` }, label), h('div', { class: 'su-fin' }, inp, h('small', {}, unit)));
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    w.key = key;
    return w;
  };
  const fields = [
    field('target', 'Board', 'mm', 'Target finished thickness'), field('tol', 'Tolerance', '%'),
    field('zse', 'Single-ended', 'Ω'), field('zdiff', 'Differential', 'Ω'),
    field('gap', 'Pair gap', 'mm'), field('minw', "Fab's min trace", 'mm'),
  ];
  const mirrorBtn = h('button', { type: 'button', class: 'su-btn su-mirror', onclick: () => mirror() }, 'Mirror the top half onto the bottom');
  const rail = h('aside', { class: 'su-rail' },
    h('section', { class: 'su-card' }, h('div', { class: 'su-h' }, 'Start from a build'), presetBox),
    h('section', { class: 'su-card' }, h('div', { class: 'su-h' }, 'Targets'), h('div', { class: 'su-fields' }, fields)),
    h('section', { class: 'su-card su-fix' }, h('div', { class: 'su-h' }, 'Symmetry'), h('p', { class: 'su-soft su-symtext' }), mirrorBtn));

  // ---------- stage ----------
  const sumEl = h('div', { class: 'su-sum', 'aria-live': 'polite' });
  const svg = sv(null, 'svg', { class: 'su-svg', role: 'group', 'aria-label': 'The layer stack to scale. Drag the lower edge of a prepreg or core to change its thickness; click a row to edit it.' });
  const stage = h('section', { class: 'su-card su-stage' },
    h('div', { class: 'su-stage-head' }, sumEl, h('span', { class: 'su-tip' }, 'Drag a dielectric’s lower edge · click a row · click a copper name to switch Signal / Plane / Mixed')),
    h('div', { class: 'su-box' }, svg));

  // ---------- right: inspector, warnings, outputs ----------
  const insp = h('section', { class: 'su-card su-insp' });
  const warnBox = h('section', { class: 'su-card su-warns' });
  const right = h('aside', { class: 'su-right' }, insp, warnBox, ctx.outputs);

  root.append(h('div', { class: 'su' }, rail, stage, right));

  // ---------- edits ----------
  function mirror() {
    const l = rows();
    const n = l.length;
    for (let i = 0; i < Math.floor(n / 2); i++) l[n - 1 - i] = { ...l[i] };
    setRows(l);
  }
  function setRow(i, patch) { const l = rows(); if (!l[i]) return; Object.assign(l[i], patch); setRows(l); }
  function cycleCu(i) {
    const l = rows(), k = kindOf(l[i]);
    const order = ['signal', 'plane', 'mixed'];
    if (!isCu(k)) return;
    l[i].kind = KIND[order[(order.indexOf(k) + 1) % 3]];
    setRows(l, i);
  }
  function move(i, d) {
    const l = rows(), j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    setRows(l, j);
  }
  function del(i) { const l = rows(); l.splice(i, 1); setRows(l, clamp(i, 0, l.length - 1)); }
  function addBelow(i, what) {
    const l = rows();
    const add = {
      pair: [r('Prepreg', 200, 4.2), r('Signal', 35)],
      prepreg: [r('Prepreg', 200, 4.2)], core: [r('Core', 400, 4.5)],
      signal: [r('Signal', 35)], plane: [r('Plane', 35)], mask: [r('Mask', 20, 3.8)],
    }[what];
    l.splice(i + 1, 0, ...add.map((x) => ({ ...x })));
    setRows(l, i + 1);
  }
  const stepT = (i, dUm) => {
    const l = rows(), t = Number(ctx.parseEng(l[i]?.t)) || 0;
    setRow(i, { t: String(Math.max(1, Math.round((t + dUm) * 10) / 10)) });
  };

  // ---------- drawing ----------
  function layout(stack, W, H) {
    const narrow = W < 640;
    const top = 30, bottom = 30;
    const avail = Math.max(120, H - top - bottom);
    const total = stack.reduce((a, x) => a + x.t, 0) || 1;
    // leave room for the target band when the board is thinner than it
    const inp = ctx.input;
    const span = Math.max(total, inp.target > 0 ? inp.target * 1000 * (1 + (inp.tol > 0 ? inp.tol : 10) / 100) : 0);
    const minH = (x) => (isCu(x.kind) ? 9 : x.kind === 'mask' ? 6 : 12);
    let k = frozenK;
    if (!k) {
      k = avail / span;
      for (let it = 0; it < 3; it++) {
        const extra = stack.reduce((a, x) => a + Math.max(0, minH(x) - x.t * k), 0);
        k = Math.max(0.01, (avail - extra) / span);
      }
    }
    let y = top;
    const pos = stack.map((x) => { const hh = Math.max(minH(x), x.t * k); const o = { y, h: hh }; y += hh; return o; });
    const cal = narrow ? { x: 8, w: 22 } : { x: 14, w: 30 };
    const gut = { x0: cal.x + cal.w + 14, x1: narrow ? cal.x + cal.w + 54 : cal.x + cal.w + 96 };
    const cx0 = gut.x1 + 4;
    const cw = narrow ? W - cx0 - 22 : clamp(W * 0.44, 260, 560);
    return { narrow, k, pos, top, bottom: y, cal, gut, cx0, cw, wx: cx0 + cw + 22, total };
  }

  function draw() {
    svg.replaceChildren();
    const stack = res?.stack;
    const box = svg.getBoundingClientRect();
    const W = Math.max(300, box.width), H = Math.max(260, box.height);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!stack?.length) {
      sv(svg, 'text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'su-empty' }, 'Start from a build on the left, or add rows in the panel on the right.');
      return;
    }
    const L = layout(stack, W, H);
    const { pos, cx0, cw, narrow } = L;
    const warns = res.warnings || [];
    const input = ctx.input;

    const defs = sv(svg, 'defs');
    const wid = `suw${Math.random().toString(36).slice(2, 7)}`;
    const weave = sv(defs, 'pattern', { id: wid, width: 14, height: 6, patternUnits: 'userSpaceOnUse' });
    sv(weave, 'path', { d: 'M0,3 Q3.5,0 7,3 T14,3', class: 'su-weave' });
    const hid = `suh${Math.random().toString(36).slice(2, 7)}`;
    const hatch = sv(defs, 'pattern', { id: hid, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    sv(hatch, 'line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'su-hatch' });

    // rows
    stack.forEach((x, i) => {
      const { y, h: hh } = pos[i];
      const g = sv(svg, 'g', { class: `su-row k-${x.kind}${x.src === sel ? ' on' : ''}`, tabindex: 0, role: 'button', 'data-i': i, 'data-src': x.src,
        'aria-label': `${x.name ? x.name + ' ' : ''}${KIND[x.kind]}, ${fmt(x.t, 4)} µm${x.er ? `, Er ${x.er}` : ''}` });
      if (x.kind === 'signal') {
        sv(g, 'rect', { x: cx0, y, width: cw, height: hh, class: 'su-resin' });
        for (let tx = cx0 + 10; tx < cx0 + cw - 30; tx += 46) sv(g, 'rect', { x: tx, y: y + 1, width: 26, height: hh - 2, class: 'su-cu' });
      } else if (x.kind === 'plane') {
        sv(g, 'rect', { x: cx0, y, width: cw, height: hh, class: 'su-cu' });
      } else if (x.kind === 'mixed') {
        sv(g, 'rect', { x: cx0, y, width: cw, height: hh, class: 'su-cu' });
        for (let tx = cx0 + 60; tx < cx0 + cw - 40; tx += 110) sv(g, 'rect', { x: tx, y, width: 12, height: hh, class: 'su-resin' });
      } else if (x.kind === 'prepreg') {
        sv(g, 'rect', { x: cx0, y, width: cw, height: hh, class: 'su-pp' });
        sv(g, 'rect', { x: cx0, y, width: cw, height: hh, fill: `url(#${wid})` });
      } else if (x.kind === 'core') {
        sv(g, 'rect', { x: cx0, y, width: cw, height: hh, class: 'su-core' });
        sv(g, 'rect', { x: cx0, y, width: cw, height: hh, fill: `url(#${hid})` });
      } else {
        sv(g, 'rect', { x: cx0, y, width: cw, height: hh, class: 'su-mask' });
      }
      sv(g, 'rect', { x: cx0 - 1, y: y + 0.5, width: cw + 2, height: Math.max(1, hh - 1), class: 'su-sel' });
      // labels
      const mid = y + hh / 2 + 4;
      const lab = sv(g, 'g', { class: 'su-lab' });
      const left = x.name ? `${x.name} ${KIND[x.kind]}` : KIND[x.kind];
      const cuTxt = `${fmt(x.t, 3)} µm · ${fmt(x.t / OZ, 2)} oz`;
      const wTxt = (x.wse != null || x.wdiff != null) ? `${x.wse != null ? fmt(x.wse, 3) : '–'} | ${x.wdiff != null ? fmt(x.wdiff, 3) : '–'} mm` : cuTxt;
      const right = isCu(x.kind) ? (narrow && x.kind !== 'plane' ? wTxt : cuTxt) : `${fmt(x.t, 4)} µm${x.er ? ` · Er ${x.er}` : ''}`;
      if (isCu(x.kind)) {
        const nm = sv(lab, 'g', { class: 'su-name', 'data-cycle': x.src, role: 'button', 'aria-label': `Switch ${x.name} between signal, plane and mixed` });
        const tw = left.length * 6.6 + 12;
        sv(nm, 'rect', { x: cx0 + 4, y: mid - 12, width: tw, height: 16, rx: 3, class: 'su-tag' });
        sv(nm, 'text', { x: cx0 + 10, y: mid, class: 'su-t su-tagt' }, left);
        const st = `${x.structure}${x.erRef != null ? ` · Er ${fmt(x.erRef, 3)}` : ''}`;
        const sx = cx0 + 4 + tw + 6, sw = st.length * 6.4 + 10;
        if (x.structure && x.kind !== 'plane' && sx + sw + right.length * 6.4 + 22 < cx0 + cw) {
          sv(lab, 'rect', { x: sx, y: mid - 12, width: sw, height: 16, rx: 3, class: 'su-tag2' });
          sv(lab, 'text', { x: sx + 5, y: mid, class: `su-t su-soft${x.h1 == null ? ' bad' : ''}` }, st);
        }
        const rw = right.length * 6.4 + 10;
        sv(lab, 'rect', { x: cx0 + cw - rw - 4, y: mid - 12, width: rw, height: 16, rx: 3, class: 'su-tag2' });
        sv(lab, 'text', { x: cx0 + cw - 9, y: mid, 'text-anchor': 'end', class: 'su-t su-soft' }, right);
      } else if (hh >= 12) {
        const ly = hh >= 44 ? y + 17 : mid;   // tall rows: labels at the top, the middle stays free
        sv(lab, 'text', { x: cx0 + 10, y: ly, class: 'su-t su-dl' }, left);
        sv(lab, 'text', { x: cx0 + cw - 10, y: ly, 'text-anchor': 'end', class: 'su-t su-dl' }, right);
      }
      // warnings that name this row
      const mine = warns.filter((w) => (x.name && new RegExp(`\\b${x.name}\\b`).test(w)) || new RegExp(`\\bRows? ${i + 1}\\b|\\band ${i + 1}\\b`).test(w));
      if (mine.length) {
        const fl = sv(g, 'g', { class: 'su-flag' });
        sv(fl, 'title', {}, mine.join('\n'));
        sv(fl, 'circle', { cx: cx0 + cw + 11, cy: y + hh / 2, r: 7 });
        sv(fl, 'text', { x: cx0 + cw + 11, y: y + hh / 2 + 4, 'text-anchor': 'middle' }, '!');
      }
    });

    // drag handles on each dielectric's lower edge
    stack.forEach((x, i) => {
      if (!isDiel(x.kind) && x.kind !== 'mask') return;
      const yb = pos[i].y + pos[i].h;
      const g = sv(svg, 'g', { class: 'su-edge', tabindex: 0, role: 'slider', 'data-i': i, 'data-src': x.src,
        'aria-label': `${KIND[x.kind]} row ${i + 1} thickness`, 'aria-valuenow': x.t, 'aria-valuetext': `${fmt(x.t, 4)} µm` });
      sv(g, 'line', { x1: cx0, x2: cx0 + cw, y1: yb, y2: yb, class: 'su-edge-hit' });
      sv(g, 'line', { x1: cx0, x2: cx0 + cw, y1: yb, y2: yb, class: 'su-edge-line' });
      const px = cx0 + cw / 2;
      sv(g, 'rect', { x: px - 16, y: yb - 4, width: 32, height: 8, rx: 4, class: 'su-grip' });
      sv(g, 'path', { d: `M${px - 6},${yb - 1.5} L${px + 6},${yb - 1.5} M${px - 6},${yb + 1.5} L${px + 6},${yb + 1.5}`, class: 'su-griplines' });
    });

    // mirror axis
    const axisY = (pos[0].y + L.bottom) / 2;
    const symV = (res.values || []).find((v) => v.label === 'Symmetric');
    const sym = symV?.value === 'yes';
    sv(svg, 'line', { x1: cx0 - 20, x2: cx0 + cw + 8, y1: axisY, y2: axisY, class: `su-axis${sym ? '' : ' bad'}` });
    sv(svg, 'text', { x: cx0 + cw - 8, y: axisY - 5, 'text-anchor': 'end', class: `su-t su-axt halo${sym ? '' : ' bad'}` }, sym ? 'mirror axis · symmetric' : 'not symmetric: the board bows');

    // caliper: total against the target band
    const tv = (res.values || []).find((v) => v.label === 'Board thickness');
    const totalMm = tv ? Number(tv.value) : L.total / 1000;
    const { x: kx, w: kw } = L.cal;
    const y0 = pos[0].y, y1 = L.bottom;
    const perMm = (y1 - y0) / Math.max(1e-6, totalMm);
    sv(svg, 'rect', { x: kx, y: y0, width: kw, height: y1 - y0, class: 'su-cal' });
    if (input.target > 0) {
      const tol = input.tol > 0 ? input.tol : 10;
      const a = y0 + input.target * (1 - tol / 100) * perMm, b = y0 + input.target * (1 + tol / 100) * perMm;
      const inBand = tv?.tone === 'ok';
      sv(svg, 'rect', { x: kx - 4, y: a, width: kw + 8, height: Math.max(2, b - a), class: `su-band${inBand ? '' : ' bad'}` });
      sv(svg, 'line', { x1: kx - 6, x2: kx + kw + 6, y1: y0 + input.target * perMm, y2: y0 + input.target * perMm, class: 'su-tgt' });
    }
    for (let mm = 0.2; mm < totalMm - 0.05; mm += 0.2) {
      const yy = y0 + mm * perMm;
      sv(svg, 'line', { x1: kx + kw - (Math.round(mm * 10) % 10 === 0 ? 12 : 6), x2: kx + kw, y1: yy, y2: yy, class: 'su-tick' });
    }
    sv(svg, 'line', { x1: kx - 4, x2: kx + kw + 4, y1: y0, y2: y0, class: 'su-jaw' });
    sv(svg, 'line', { x1: kx - 4, x2: kx + kw + 4, y1: y1, y2: y1, class: 'su-jaw' });
    sv(svg, 'rect', { x: kx - 4, y: y1 - 8, width: 8, height: 16, class: 'su-jawtip' });
    if (input.target > 0) {
      const yt = y0 + input.target * perMm;
      if (yt > y1 + 2) sv(svg, 'line', { x1: kx + kw / 2, x2: kx + kw / 2, y1, y2: yt, class: 'su-short' });
    }
    sv(svg, 'text', { x: kx + kw + 8, y: y1 + 4, class: `su-t su-total ${tv?.tone === 'bad' ? 'bad' : ''}` }, narrow ? '' : `${fmt(totalMm, 4)}`);

    // references: arcs in the gutter
    const { x0: gx0, x1: gx1 } = L.gut;
    let lane = 0;
    stack.forEach((x, i) => {
      if (x.kind !== 'signal' && x.kind !== 'mixed') return;
      const ym = pos[i].y + pos[i].h / 2;
      const refs = [[x.refUp, x.h1], [x.refDn, x.refUp != null ? x.h2 : x.h1]];
      let any = false;
      for (const [j, hUm] of refs) {
        if (j == null || !pos[j]) continue;
        any = true;
        const yr = pos[j].y + pos[j].h / 2;
        const span = (gx1 - gx0) * (0.35 + 0.2 * (lane % 3));
        const xc = gx1 - span;
        sv(svg, 'path', { d: `M${gx1},${ym} C${xc},${ym} ${xc},${yr} ${gx1},${yr}`, class: 'su-ref' });
        sv(svg, 'circle', { cx: gx1, cy: yr, r: 2.5, class: 'su-refdot' });
        if (!narrow && hUm != null) sv(svg, 'text', { x: xc + 2, y: (ym + yr) / 2 + 4, 'text-anchor': 'end', class: 'su-t su-reft' }, `${fmt(hUm, 3)}`);
      }
      lane += 1;
      if (!any) {
        sv(svg, 'text', { x: gx1 - 4, y: ym + 4, 'text-anchor': 'end', class: 'su-t su-bad' }, 'no ref');
      }
    });
    if (!narrow) sv(svg, 'text', { x: (gx0 + gx1) / 2, y: 18, 'text-anchor': 'middle', class: 'su-t su-cap' }, 'H to plane, µm');

    // widths beside each signal layer
    if (!narrow) drawWidths(stack, L, W, warns);
  }

  function drawWidths(stack, L, W, warns) {
    const { pos, wx } = L;
    const input = ctx.input;
    const sig = stack.filter((x) => x.kind === 'signal' || x.kind === 'mixed');
    const gp0 = input.gap > 0 ? input.gap : 0.15, room = W - wx - 24;
    // px per mm, one scale for every layer, leaving room for the numbers after each drawing
    const s = Math.max(20, Math.min(420, ...sig.map((x) => Math.min(
      x.wse ? (room - 100) / x.wse : Infinity, x.wdiff ? (room - 170) / (2 * x.wdiff + gp0) : Infinity))));
    sv(svg, 'text', { x: wx, y: 18, class: 'su-t su-cap' }, 'Trace and pair widths, to one scale');
    stack.forEach((x, i) => {
      const ym = pos[i].y + pos[i].h / 2;
      if (x.kind === 'plane') {
        sv(svg, 'text', { x: wx, y: ym + 4, class: 'su-t su-soft' }, `${x.name} reference plane`);
        return;
      }
      if (x.kind !== 'signal' && x.kind !== 'mixed') return;
      const bad = warns.some((w) => new RegExp(`\\b${x.name}\\b`).test(w));
      const g = sv(svg, 'g', { class: `su-w${bad ? ' warn' : ''}` });
      if (x.h1 == null) {
        sv(g, 'text', { x: wx, y: ym + 4, class: 'su-t su-bad' }, `${x.name}: no plane next to it, impedance not controlled`);
        return;
      }
      // single trace, then the pair, each with its number and target
      const xx = wx, th = 8;
      const under = (w) => input.minw > 0 && w != null && w < input.minw;
      if (x.wse != null) {
        const w = Math.max(1.5, x.wse * s);
        sv(g, 'rect', { x: xx, y: ym - 9 - th / 2, width: w, height: th, class: `su-trace${under(x.wse) ? ' bad' : ''}` });
        const t = sv(g, 'text', { x: xx + w + 8, y: ym - 5, class: `su-t su-wv${under(x.wse) ? ' bad' : ''}` }, `${fmt(x.wse, 3)} mm`);
        t.append(sv(null, 'tspan', { class: 'su-wz' }, `  ${fmt(input.zse, 3)} Ω`));
      } else if (input.zse > 0) sv(g, 'text', { x: xx, y: ym - 5, class: 'su-t su-bad' }, `no width for ${fmt(input.zse, 3)} Ω`);
      const gap = input.gap > 0 ? input.gap : 0.15;
      if (x.wdiff != null) {
        const w = Math.max(1.5, x.wdiff * s), gp = gap * s;
        sv(g, 'rect', { x: xx, y: ym + 9 - th / 2, width: w, height: th, class: `su-trace pair${under(x.wdiff) ? ' bad' : ''}` });
        sv(g, 'rect', { x: xx + w + gp, y: ym + 9 - th / 2, width: w, height: th, class: `su-trace pair${under(x.wdiff) ? ' bad' : ''}` });
        const t = sv(g, 'text', { x: xx + 2 * w + gp + 8, y: ym + 13, class: `su-t su-wv${under(x.wdiff) ? ' bad' : ''}` }, `${fmt(x.wdiff, 3)} / ${fmt(gap, 3)} mm`);
        t.append(sv(null, 'tspan', { class: 'su-wz' }, `  ${fmt(input.zdiff, 3)} Ω`));
      } else if (input.zdiff > 0) sv(g, 'text', { x: xx, y: ym + 13, class: 'su-t su-bad' }, `no width for ${fmt(input.zdiff, 3)} Ω`);
    });
    // plane pairs: buried capacitance bracket
    for (const pp of res.planePairs || []) {
      const a = pos[pp.a], b = pos[pp.b];
      if (!a || !b) continue;
      const ya = a.y + a.h / 2, yb = b.y + b.h / 2, xb = W - 14;
      sv(svg, 'path', { d: `M${xb - 6},${ya} L${xb},${ya} L${xb},${yb} L${xb - 6},${yb}`, class: 'su-pp-brk' });
      sv(svg, 'text', { x: xb - 10, y: (ya + yb) / 2 + 4, 'text-anchor': 'end', class: 'su-t su-soft' }, `plane pair ${fmt(pp.pfPerCm2, 3)} pF/cm²`);
    }
  }

  // ---------- inspector ----------
  function drawInspector() {
    const l = rows();
    sel = clamp(sel, 0, Math.max(0, l.length - 1));
    const raw = l[sel];
    const st = (res?.stack || []).find((x) => x.src === sel);
    insp.replaceChildren();
    if (!raw) {
      insp.append(h('div', { class: 'su-h' }, 'No rows'), h('button', { type: 'button', class: 'su-btn', onclick: () => setRows([r('Signal', 35)], 0) }, 'Add a copper layer'));
      return;
    }
    const k = kindOf(raw);
    insp.append(h('div', { class: 'su-h' }, `Row ${sel + 1} of ${l.length}`, st?.name ? h('span', { class: 'su-soft' }, ` · ${st.name}`) : null));
    const group = isCu(k) ? ['signal', 'plane', 'mixed'] : isDiel(k) ? ['prepreg', 'core'] : [k];
    const seg = h('div', { class: 'su-seg', role: 'radiogroup', 'aria-label': 'Row type' },
      group.map((g) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(g === k), onclick: () => setRow(sel, { kind: KIND[g] || raw.kind }) }, KIND[g] || raw.kind)));
    insp.append(seg);
    const tIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', id: 'su-t', value: raw.t ?? '', oninput: (e) => setRow(sel, { t: e.target.value }) });
    const stepBy = isCu(k) ? 17.5 : 5;
    insp.append(h('div', { class: 'su-irow' }, h('label', { for: 'su-t' }, 'Thickness'),
      h('div', { class: 'su-fin' }, h('button', { type: 'button', class: 'su-btn sm', 'aria-label': 'Thinner', onclick: () => stepT(sel, -stepBy) }, '−'), tIn,
        h('button', { type: 'button', class: 'su-btn sm', 'aria-label': 'Thicker', onclick: () => stepT(sel, stepBy) }, '+'), h('small', {}, 'µm'))));
    if (isCu(k)) {
      insp.append(h('div', { class: 'su-irow' }, h('span', {}, 'Copper'), h('div', { class: 'su-chips' },
        [['½ oz', '17.5'], ['1 oz', '35'], ['2 oz', '70']].map(([t, um]) => h('button', { type: 'button', class: 'su-chip', 'aria-pressed': String(Number(raw.t) === Number(um)), onclick: () => setRow(sel, { t: um }) }, t)))));
    } else {
      const eIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', id: 'su-er', value: raw.er ?? '', oninput: (e) => setRow(sel, { er: e.target.value }) });
      insp.append(h('div', { class: 'su-irow' }, h('label', { for: 'su-er' }, 'Er'), h('div', { class: 'su-fin' }, eIn,
        h('div', { class: 'su-chips' }, ['3.8', '4.2', '4.5'].map((v) => h('button', { type: 'button', class: 'su-chip', 'aria-pressed': String(raw.er === v), onclick: () => setRow(sel, { er: v }) }, v))))));
    }
    if (st && (st.kind === 'signal' || st.kind === 'mixed')) {
      const dl = h('dl', { class: 'su-dl' });
      const row = (a, b) => dl.append(h('dt', {}, a), h('dd', {}, b));
      row('Structure', st.structure || '–');
      if (st.h1 != null) row('H to plane', st.h2 != null ? `${fmt(st.h1, 3)} / ${fmt(st.h2, 3)} µm` : `${fmt(st.h1, 3)} µm`);
      if (st.erRef != null) row('Er to plane', fmt(st.erRef, 3));
      row(`${fmt(ctx.input.zse, 3)} Ω single`, st.wse != null ? `${fmt(st.wse, 3)} mm` : '–');
      row(`${fmt(ctx.input.zdiff, 3)} Ω pair`, st.wdiff != null ? `${fmt(st.wdiff, 3)} mm` : '–');
      insp.append(dl);
    }
    const addSel = h('select', { 'aria-label': 'Row to add below' },
      [['pair', 'Prepreg + signal'], ['prepreg', 'Prepreg'], ['core', 'Core'], ['signal', 'Signal copper'], ['plane', 'Plane copper'], ['mask', 'Solder mask']].map(([v, t]) => h('option', { value: v }, t)));
    insp.append(h('div', { class: 'su-actions' },
      h('button', { type: 'button', class: 'su-btn', onclick: () => move(sel, -1), disabled: sel === 0 }, 'Move up'),
      h('button', { type: 'button', class: 'su-btn', onclick: () => move(sel, 1), disabled: sel >= l.length - 1 }, 'Move down'),
      h('button', { type: 'button', class: 'su-btn danger', onclick: () => del(sel) }, 'Delete')),
    h('div', { class: 'su-actions' }, h('span', { class: 'su-soft' }, 'Add below'), addSel, h('button', { type: 'button', class: 'su-btn', onclick: () => addBelow(sel, addSel.value) }, 'Add')));
  }

  function drawWarnings() {
    const w = res?.warnings || [];
    warnBox.hidden = !w.length;
    warnBox.replaceChildren(h('div', { class: 'su-h' }, `${w.length} to check`), ...w.map((t) => {
      const m = /\bL(\d+)\b/.exec(t) || /\bRows? (\d+)\b/.exec(t);
      let target = null;
      if (m && res?.stack) {
        target = m[0].startsWith('L') ? res.stack.find((x) => x.name === m[0])?.src : res.stack[Number(m[1]) - 1]?.src;
      }
      return h('button', { type: 'button', class: 'su-warn', disabled: target == null, onclick: () => { if (target != null) { sel = target; render(); } } }, t);
    }));
  }

  function render() {
    for (const f of fields) f.sync(ctx.raw[f.key]);
    const v = res?.values || [];
    const tv = v.find((x) => x.label === 'Board thickness');
    const sym = v.find((x) => x.label === 'Symmetric');
    const nCu = v.find((x) => x.label === 'Copper layers');
    const refd = v.find((x) => x.label === 'Signal layers with a reference');
    sumEl.replaceChildren(
      tv ? h('span', { class: `su-big ${tv.tone || ''}` }, `${tv.value} mm`) : null,
      tv?.hint ? h('span', {}, tv.hint) : null,
      nCu ? h('span', {}, `${nCu.value} copper`) : null,
      sym ? h('span', { class: sym.tone }, sym.value === 'yes' ? 'symmetric' : 'not symmetric') : null,
      refd ? h('span', {}, `${refd.value} signal layers referenced`) : null);
    rail.querySelector('.su-symtext').textContent = sym ? (sym.value === 'yes' ? 'The build mirrors about its centre: it stays flat.' : 'Top and bottom halves differ: the board will bow and twist.') : '';
    mirrorBtn.disabled = !sym || sym.value === 'yes';
    drawInspector();
    drawWarnings();
    draw();
    if (focusSel) { focusSel = false; svg.querySelector(`.su-row[data-src="${sel}"]`)?.focus({ preventScroll: true }); }
  }
  ctx.onResult((x) => { res = x; if (!drag) frozenK = null; render(); });

  // ---------- pointer and keys on the drawing ----------
  const toSvg = (e) => {
    const b = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    return { x: (e.clientX - b.left) * (vb.width / b.width), y: (e.clientY - b.top) * (vb.height / b.height) };
  };
  svg.addEventListener('pointerdown', (e) => {
    const edge = e.target.closest('.su-edge');
    if (edge) {
      e.preventDefault();
      edge.focus({ preventScroll: true });
      svg.setPointerCapture(e.pointerId);
      const i = Number(edge.dataset.i), x = res.stack[i];
      const box = svg.getBoundingClientRect();
      frozenK = layout(res.stack, Math.max(300, box.width), Math.max(260, box.height)).k;
      drag = { src: Number(edge.dataset.src), t0: x.t, y0: toSvg(e).y };
      sel = drag.src;
      svg.classList.add('dragging');
      return;
    }
    const cyc = e.target.closest('.su-name');
    if (cyc) { e.preventDefault(); cycleCu(Number(cyc.dataset.cycle)); return; }
    const row = e.target.closest('.su-row');
    if (row) { sel = Number(row.dataset.src); render(); requestAnimationFrame(() => svg.querySelector(`.su-row[data-src="${sel}"]`)?.focus({ preventScroll: true })); }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = toSvg(e).y - drag.y0;
    const t = Math.max(10, Math.round((drag.t0 + dy / frozenK) / 5) * 5);
    const l = rows();
    if (!l[drag.src]) return;
    l[drag.src].t = String(t);
    setSoon(l);
  });
  const end = () => { if (!drag) return; drag = null; svg.classList.remove('dragging'); requestAnimationFrame(() => { frozenK = null; draw(); }); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('keydown', (e) => {
    const edge = e.target.closest?.('.su-edge');
    if (edge && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const src = Number(edge.dataset.src);
      sel = src;
      stepT(src, (e.key === 'ArrowDown' ? 1 : -1) * (e.shiftKey ? 25 : 5));
      requestAnimationFrame(() => svg.querySelector(`.su-edge[data-src="${src}"]`)?.focus({ preventScroll: true }));
      return;
    }
    const row = e.target.closest?.('.su-row');
    if (!row) return;
    const src = Number(row.dataset.src), i = Number(row.dataset.i);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const n = res.stack[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, res.stack.length - 1)];
      sel = n.src; focusSel = true; render();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isCu(res.stack[i].kind)) { sel = src; focusSel = true; cycleCu(src); }
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      sel = src; focusSel = true;
      stepT(src, (e.key === '-' ? -1 : 1) * (isCu(res.stack[i].kind) ? 17.5 : e.shiftKey ? 25 : 5));
    } else if (e.key === 'Delete') {
      e.preventDefault(); focusSel = true; del(src);
    }
  });

  let rz = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (!drag) frozenK = null; draw(); }); }).observe(svg.parentElement);
}
