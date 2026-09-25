// Safe Area Overlay: the page is the phone.
//   Shelf  - every preset standing side by side to scale (portrait), with
//            its cutout; click one (or arrow keys) to pick it.
//   Phone  - the chosen screen drawn large with its bars, cutout, home
//            indicator or navigation bar hatched as unsafe and the safe
//            rectangle dashed. Insets are dimensioned on the drawing.
//            Point anywhere on the screen to read the position in pt/dp and
//            px and whether it is safe (click pins it, arrow keys move it).
//            Drag a green grip on the safe edge to change that inset: the
//            screen becomes a Custom one with those values. Drop a
//            screenshot on the phone to lay it under the overlay (it stays
//            in this page).
//   Side   - the four insets around the safe size, the screenshot controls,
//            and the CSS / native code.
// Every size and inset shown comes from run()'s result (drawing, values,
// tables, lineup); the probe only converts the pointer position.

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
const r1 = (v) => Math.round(v * 10) / 10;

let shot = null; // { url, w, h, name } - kept across re-renders, never uploaded
let uid = 0;

export function page(root, ctx) {
  const id = ++uid;
  const state = { probe: null, hover: null, drag: null, op: 0.85, dropping: false };
  const f = (v) => ctx.fmtNum(v, 4);

  // ---------- skeleton ----------
  const shelfSvg = sv('svg', { class: 'sa-shelf-svg', role: 'radiogroup', 'aria-label': 'Devices, drawn to scale' });
  const shelfScroll = h('div', { class: 'sa-shelf-scroll' }, shelfSvg);
  const shelf = h('section', { class: 'sa-card sa-shelf', title: 'Devices side by side to scale: click to pick, arrow keys on a focused phone' }, shelfScroll);

  const title = h('h2', {});
  const orientSeg = h('div', { class: 'sa-seg', role: 'group', 'aria-label': 'Orientation' });
  const navSeg = h('div', { class: 'sa-seg', role: 'group', 'aria-label': 'Android navigation' });
  const navWrap = h('span', { class: 'sa-lbl' }, 'Navigation', navSeg);
  const cutSeg = h('div', { class: 'sa-seg', role: 'group', 'aria-label': 'Cutout' });
  const numIn = (key, label, unit) => {
    const i = h('input', { class: 'sa-num', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': label });
    i.addEventListener('input', () => ctx.set(key, i.value));
    return { key, el: h('label', { class: 'sa-lbl' }, label, i, unit ? h('span', {}, unit) : null), i };
  };
  const cw = numIn('cw', 'W', 'pt'), chh = numIn('ch', 'H', 'pt'), cs = numIn('cs', '×', null);
  const custWrap = h('span', { class: 'sa-lbl', style: 'gap:10px;flex-wrap:wrap' }, h('span', { class: 'sa-lbl' }, 'Cutout', cutSeg), cw.el, chh.el, cs.el);

  const svg = sv('svg', { class: 'sa-svg', tabindex: '0', role: 'application', 'aria-label': 'Phone screen. Point to read a position; arrow keys move the pinned probe; drag a green grip to change an inset.' });
  const box = h('div', { class: 'sa-box' }, svg);
  const foot = h('div', { class: 'sa-foot', 'aria-live': 'polite' });
  const stage = h('section', { class: 'sa-card sa-stagecard' },
    h('div', { class: 'sa-head' }, title, orientSeg, navWrap, custWrap), box, foot);

  const cross = h('div', { class: 'sa-cross' });
  const shotBox = h('div', { class: 'sa-shot' });
  const msgs = h('div', { class: 'sa-msgs' });
  const side = h('div', { class: 'sa-side' },
    h('section', { class: 'sa-card' }, h('div', { class: 'sa-head' }, h('h2', {}, 'Insets'), h('span', { class: 'sa-soft', id: `sa-lost-${id}` })), cross),
    h('section', { class: 'sa-card' }, h('div', { class: 'sa-head' }, h('h2', {}, 'Screenshot')), shotBox),
    ctx.outputs, msgs);

  root.append(h('div', { class: 'sa' }, shelf, h('div', { class: 'sa-work' }, stage, side)));

  // ---------- helpers ----------
  const res = () => ctx.result || {};
  const dr = () => res().drawing || null;
  const table = () => (res().tables || [])[0]?.rows || [];
  const edgeRow = (name) => table().find((r) => r[0] === name) || null;
  const val = (label) => (res().values || []).find((v) => v.label === label) || null;
  const isAndroid = () => dr()?.unit === 'dp' && ctx.raw.device !== 'custom';

  const seg = (el, items, cur, onPick) => {
    el.replaceChildren(...items.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(v === cur), onclick: () => onPick(v) }, t)));
  };

  const loadFile = (fl) => {
    if (!fl || !/^image\//.test(fl.type || 'image/')) return;
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => { shot = { url: rd.result, w: im.naturalWidth, h: im.naturalHeight, name: fl.name }; drawAll(); };
      im.src = rd.result;
    };
    rd.readAsDataURL(fl);
  };

  // Turning a preset into Custom with one inset changed: keeps the screen,
  // its scale and cutout, and every other inset.
  const setInset = (edge, v) => {
    const d = dr(); if (!d) return;
    const cur = { top: d.top, bottom: d.bottom, left: d.left, right: d.right };
    cur[edge] = Math.max(0, Math.round(v));
    const patch = { ctop: String(cur.top), cbottom: String(cur.bottom), cleft: String(cur.left), cright: String(cur.right) };
    if (ctx.raw.device !== 'custom') {
      Object.assign(patch, {
        device: 'custom',
        cw: String(r1(d.land ? d.H : d.W)), ch: String(r1(d.land ? d.W : d.H)), cs: String(d.scale),
        ccut: d.cut ? d.cut.kind : 'none',
      });
    }
    ctx.setMany(patch);
  };

  // ---------- shelf ----------
  function drawShelf() {
    const list = res().lineup || [];
    const inp = ctx.input;
    const items = [...list.map((x) => ({ ...x, grp: x.os === 'android' ? 'Android' : /^ipad/.test(x.id) ? 'iPad' : 'iPhone' })),
      { id: 'custom', short: 'Custom', name: 'Custom screen', w: inp.cw > 0 ? inp.cw : 390, h: inp.ch > 0 ? inp.ch : 844, r: 0, cut: null, grp: 'Custom', cust: true }];
    if (!list.length) { shelfSvg.replaceChildren(); return; }
    const avail = Math.max(300, shelfScroll.clientWidth - 12);
    const GAP = 14, GGAP = 30;
    let groups = 0; items.forEach((x, i) => { if (i && x.grp !== items[i - 1].grp) groups++; });
    const sumW = items.reduce((a, x) => a + Math.min(x.w, x.h), 0);
    const sc = clamp((avail - GAP * (items.length - 1) - GGAP * groups) / sumW, 0.058, 0.08);
    const maxH = Math.max(...items.map((x) => Math.max(x.w, x.h))) * sc;
    const TOP = 18, base = TOP + maxH + 2;
    let x = 4;
    const kids = [];
    let totalW = 0;
    const g0 = sv('g');
    let lastGrp = null;
    const cur = ctx.raw.device;
    items.forEach((it, i) => {
      if (i && it.grp !== items[i - 1].grp) x += GGAP - GAP;
      const w = Math.min(it.w, it.h) * sc, hh = Math.max(it.w, it.h) * sc;
      const minW = Math.max(w, 44);
      const cx = x + minW / 2;
      if (it.grp !== lastGrp) { g0.append(sv('text', { x, y: 11, class: 'grp' }, it.grp)); lastGrp = it.grp; }
      const g = sv('g', { class: `sa-dev${it.cust ? ' cust' : ''}`, role: 'radio', 'aria-checked': String(cur === it.id), tabindex: cur === it.id ? '0' : '-1',
        'aria-label': `${it.name}, ${f(it.w)} × ${f(it.h)} ${it.os === 'android' ? 'dp' : 'pt'}`, 'data-id': it.id });
      g.append(sv('title', {}, `${it.name} · ${f(it.w)} × ${f(it.h)} ${it.os === 'android' ? 'dp' : 'pt'}${it.s ? ` · ×${f(it.s)}` : ''}`));
      // hit area
      g.append(sv('rect', { x: cx - minW / 2 - 3, y: TOP - 2, width: minW + 6, height: base - TOP + 34, fill: 'transparent' }));
      const bx = cx - w / 2, by = base - hh, rr = Math.max(2.5, (it.r || 6) * sc + 1.5);
      g.append(sv('rect', { x: bx, y: by, width: w, height: hh, rx: rr, class: 'bd' }));
      g.append(sv('rect', { x: bx + 1.6, y: by + 1.6, width: w - 3.2, height: hh - 3.2, rx: Math.max(1, rr - 1.6), class: 'sc' }));
      const c = it.cut;
      if (c) {
        if (c.kind === 'punch') g.append(sv('circle', { cx, cy: by + 1.6 + ((c.y || 0) + c.h / 2) * sc, r: Math.max(1.2, (c.w / 2) * sc), class: 'ct' }));
        else if (c.kind === 'island') g.append(sv('rect', { x: cx - (c.w * sc) / 2, y: by + 1.6 + (c.y || 0) * sc, width: c.w * sc, height: Math.max(1.5, c.h * sc), rx: Math.max(1, (c.h * sc) / 2), class: 'ct' }));
        else g.append(sv('rect', { x: cx - (c.w * sc) / 2, y: by + 1.2, width: c.w * sc, height: Math.max(1.5, c.h * sc), rx: 1, class: 'ct' }));
      } else if (!it.cust && it.r === 0 && it.os !== 'android') {
        // Home button phones
        g.append(sv('circle', { cx, cy: base - 3.2, r: 1.8, class: 'ct', style: 'fill:none;stroke:var(--tool-screen-ink)' }));
      }
      g.append(sv('text', { x: cx, y: base + 14, 'text-anchor': 'middle', class: 'lb' }, it.short));
      g.append(sv('text', { x: cx, y: base + 26, 'text-anchor': 'middle', class: 'sz' }, `${Math.round(it.w)}×${Math.round(it.h)}`));
      g.addEventListener('click', () => pickDevice(it.id));
      g.addEventListener('keydown', (e) => {
        const ids = items.map((q) => q.id); const k = ids.indexOf(it.id);
        let n = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = ids[(k + 1) % ids.length];
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = ids[(k - 1 + ids.length) % ids.length];
        else if (e.key === 'Home') n = ids[0];
        else if (e.key === 'End') n = ids[ids.length - 1];
        else if (e.key === 'Enter' || e.key === ' ') n = it.id;
        if (n) { e.preventDefault(); pickDevice(n, true); }
      });
      kids.push(g);
      x += minW + GAP;
      totalW = x;
    });
    g0.append(sv('line', { x1: 0, x2: totalW, y1: base + 0.5, y2: base + 0.5, class: 'base' }));
    shelfSvg.replaceChildren(g0, ...kids);
    shelfSvg.setAttribute('width', totalW);
    shelfSvg.setAttribute('height', base + 32);
    shelfSvg.setAttribute('viewBox', `0 0 ${totalW} ${base + 32}`);
    shelf.title = `Devices side by side, to scale (1 : ${Math.round(1 / sc)} of pt): click to pick, arrow keys on a focused phone`;
    // keep the chosen phone in view when the shelf scrolls (narrow screens)
    if (cur !== shelfSeen) {
      shelfSeen = cur;
      const sel = shelfSvg.querySelector('[aria-checked="true"]');
      if (sel && shelfScroll.scrollWidth > shelfScroll.clientWidth) {
        const bb = sel.getBBox();
        shelfScroll.scrollLeft = Math.max(0, bb.x + bb.width / 2 - shelfScroll.clientWidth / 2);
      }
    }
  }
  let shelfSeen = null;
  let refocus = null;
  const pickDevice = (idv, focus = false) => {
    refocus = focus ? idv : null;
    state.probe = null;
    if (idv === ctx.raw.device) { drawAll(); return; }
    ctx.set('device', idv);
  };

  // ---------- stage ----------
  let geo = null;
  function drawStage() {
    const d = dr();
    const bw = box.clientWidth || 600, bh = box.clientHeight || 600;
    svg.setAttribute('viewBox', `0 0 ${bw} ${bh}`);
    svg.replaceChildren();
    if (!d) {
      svg.append(sv('text', { x: bw / 2, y: bh / 2, 'text-anchor': 'middle', class: 'empty-t' }, (res().warnings || ['No screen'])[0]));
      geo = null; return;
    }
    const narrow = bw < 560;
    const ml = narrow ? 64 : 150, mr = narrow ? 44 : 190, mt = 50, mb = 58;
    const k = Math.min((bw - ml - mr) / d.W, (bh - mt - mb) / d.H);
    const ox = ml + ((bw - ml - mr) - d.W * k) / 2, oy = mt + ((bh - mt - mb) - d.H * k) / 2;
    const X = (x) => ox + x * k, Y = (y) => oy + y * k;
    geo = { k, ox, oy, X, Y, d };
    const PW = d.W * k, PH = d.H * k;
    const R = Math.min(d.r * k, PW / 2);
    const bez = clamp(k * 11, 5, 13);

    const defs = sv('defs');
    const clip = sv('clipPath', { id: `sa-clip-${id}` });
    clip.append(sv('rect', { x: X(0), y: Y(0), width: PW, height: PH, rx: R }));
    const pat = sv('pattern', { id: `sa-hatch-${id}`, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch' }));
    defs.append(clip, pat);
    svg.append(defs);

    // body and screen
    svg.append(sv('rect', { x: X(0) - bez, y: Y(0) - bez, width: PW + 2 * bez, height: PH + 2 * bez, rx: R ? R + bez : bez * 1.8, class: 'body' }));
    const g = sv('g', { 'clip-path': `url(#sa-clip-${id})` });
    g.append(sv('rect', { x: X(0), y: Y(0), width: PW, height: PH, class: 'screen' }));
    if (shot) g.append(sv('image', { href: shot.url, x: X(0), y: Y(0), width: PW, height: PH, preserveAspectRatio: 'none', opacity: state.op }));
    const band = (x, y, w, hh) => {
      if (!(w > 0 && hh > 0)) return;
      g.append(sv('rect', { x: X(x), y: Y(y), width: w * k, height: hh * k, class: 'unsafe' }));
      g.append(sv('rect', { x: X(x), y: Y(y), width: w * k, height: hh * k, fill: `url(#sa-hatch-${id})` }));
    };
    band(0, 0, d.W, d.top);
    band(0, d.H - d.bottom, d.W, d.bottom);
    band(0, d.top, d.left, d.H - d.top - d.bottom);
    band(d.W - d.right, d.top, d.right, d.H - d.top - d.bottom);

    // status bar content: the time and a battery, where the phone puts them
    if (d.status > 0 && !shot) {
      const fs = clamp(15 * k, 8, 17);
      const sy = d.land ? d.status / 2 : Math.min(d.status, 54) * (d.cut && d.cut.kind !== 'punch' ? 0.55 : 0.5);
      const c = d.cut && !d.land && d.cut.kind !== 'punch' ? d.cut : null;
      const tx = c ? c.x / 2 : d.left + 26, bxr = c ? d.W - c.x / 2 : d.W - d.right - 26;
      g.append(sv('text', { x: X(tx), y: Y(sy) + fs * 0.36, 'text-anchor': 'middle', class: 'sysink', 'font-size': fs, 'font-weight': 600 }, '9:41'));
      const bw2 = 24 * k, bh2 = 11.5 * k;
      g.append(sv('rect', { x: X(bxr) - bw2 / 2, y: Y(sy) - bh2 / 2, width: bw2, height: bh2, rx: 3 * k, class: 'sysink-s' }));
      g.append(sv('rect', { x: X(bxr) - bw2 / 2 + 2 * k, y: Y(sy) - bh2 / 2 + 2 * k, width: bw2 * 0.62, height: bh2 - 4 * k, rx: 1.5 * k, class: 'sysink' }));
    }
    // cutout
    if (d.cut) {
      const c = d.cut;
      if (c.kind === 'punch') g.append(sv('circle', { cx: X(c.x + c.w / 2), cy: Y(c.y + c.h / 2), r: (c.w / 2) * k, class: 'cut' }));
      else if (c.kind === 'island') g.append(sv('rect', { x: X(c.x), y: Y(c.y), width: c.w * k, height: c.h * k, rx: (Math.min(c.w, c.h) / 2) * k, class: 'cut' }));
      else {
        const rr = Math.min(c.w, c.h) * 0.35 * k;
        if (!d.land) g.append(sv('path', { class: 'cut', d: `M${X(c.x)},${Y(0)} h${c.w * k} v${c.h * k - rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(c.w * k - 2 * rr)} a${rr},${rr} 0 0 1 ${-rr},${-rr} z` }));
        else g.append(sv('path', { class: 'cut', d: `M${X(0)},${Y(c.y)} h${c.w * k - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${c.h * k - 2 * rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(c.w * k - rr)} z` }));
      }
    }
    if (d.homeInd) {
      const w = d.homeInd.w, y = d.H - d.homeInd.gap - d.homeInd.h;
      g.append(sv('rect', { x: X((d.W - w) / 2), y: Y(y), width: w * k, height: d.homeInd.h * k, rx: 2.5 * k, class: 'sysink' }));
    }
    if (d.nav && d.nav.kind === 'buttons') {
      const n = d.nav, z = 7 * k;
      [0.28, 0.5, 0.72].forEach((t, i) => {
        const x = n.side === 'bottom' ? d.W * t : d.W - n.size / 2;
        const y = n.side === 'bottom' ? d.H - n.size / 2 : d.H * (n.side === 'bottom' ? t : 1 - t);
        const cx = X(x), cy = Y(y);
        const kind = n.side === 'bottom' ? i : 2 - i;
        if (kind === 0) g.append(sv('path', { class: 'sysink-s', d: `M${cx + z * 0.8},${cy - z} L${cx - z * 0.9},${cy} L${cx + z * 0.8},${cy + z} Z` }));
        else if (kind === 1) g.append(sv('circle', { class: 'sysink-s', cx, cy, r: z }));
        else g.append(sv('rect', { class: 'sysink-s', x: cx - z * 0.85, y: cy - z * 0.85, width: z * 1.7, height: z * 1.7, rx: 1.5 }));
      });
    } else if (d.nav) {
      g.append(sv('rect', { x: X((d.W - 108) / 2), y: Y(d.H - 12), width: 108 * k, height: 4 * k, rx: 2 * k, class: 'sysink' }));
    }
    // probe crosshair (inside the screen)
    const p = state.hover || state.probe;
    if (p) {
      g.append(sv('line', { x1: X(0), x2: X(d.W), y1: Y(p.y), y2: Y(p.y), class: 'probe' }));
      g.append(sv('line', { x1: X(p.x), x2: X(p.x), y1: Y(0), y2: Y(d.H), class: 'probe' }));
    }
    svg.append(g);

    // safe rectangle
    const sw = d.W - d.left - d.right, shh = d.H - d.top - d.bottom;
    svg.append(sv('rect', { x: X(d.left), y: Y(d.top), width: sw * k, height: shh * k, class: 'safe' }));
    const sa = val('Safe area');
    const cxs = X(d.left + sw / 2), cys = Y(d.top + shh / 2);
    svg.append(sv('text', { x: cxs, y: cys - 4, 'text-anchor': 'middle', class: 'safe-lbl' }, `safe area ${sa ? sa.value : ''} ${d.unit}`));
    if (sa?.hint) svg.append(sv('text', { x: cxs, y: cys + 12, 'text-anchor': 'middle', class: 'safe-sub' }, sa.hint));
    if (shot) {
      const expW = Math.round(d.W * d.scale), expH = Math.round(d.H * d.scale);
      const aspect = Math.abs(shot.w / shot.h - d.W / d.H) / (d.W / d.H);
      if (aspect > 0.02) {
        svg.append(sv('text', { x: cxs, y: cys + 32, 'text-anchor': 'middle', class: 'warn-t' }, `screenshot ${shot.w} × ${shot.h} px is stretched`));
        svg.append(sv('text', { x: cxs, y: cys + 47, 'text-anchor': 'middle', class: 'warn-t' }, `this screen is ${expW} × ${expH} px`));
      }
    }

    // dimensions: top and bottom insets on the left, left and right insets above
    const pxOf = (edge) => edgeRow(edge)?.[2];
    const vdim = (y0, y1, edge, v) => {
      const x = X(0) - bez - 14;
      svg.append(sv('line', { x1: x, x2: x, y1: Y(y0), y2: Y(y1), class: 'dim' }));
      for (const yy of [y0, y1]) svg.append(sv('line', { x1: x - 5, x2: X(0) - bez - 2, y1: Y(yy), y2: Y(yy), class: 'dim' }));
      const my = (Y(y0) + Y(y1)) / 2;
      svg.append(sv('text', { x: x - 7, y: my + (narrow ? 4 : -1), 'text-anchor': 'end', class: 'dim-t' }, `${f(v)} ${d.unit}`));
      if (!narrow) svg.append(sv('text', { x: x - 7, y: my + 13, 'text-anchor': 'end', class: 'dim-s' }, `${pxOf(edge)} px · ${edge.toLowerCase()}`));
    };
    if (d.top > 0) vdim(0, d.top, 'Top', d.top);
    if (d.bottom > 0) vdim(d.H - d.bottom, d.H, 'Bottom', d.bottom);
    const hdim = (x0, x1, edge, v, anchor) => {
      const y = Y(0) - bez - 12;
      svg.append(sv('line', { x1: X(x0), x2: X(x1), y1: y, y2: y, class: 'dim' }));
      for (const xx of [x0, x1]) svg.append(sv('line', { x1: X(xx), x2: X(xx), y1: y - 5, y2: Y(0) - bez - 2, class: 'dim' }));
      const tx = anchor === 'start' ? X(x0) : X(x1);
      svg.append(sv('text', { x: tx, y: y - 6, 'text-anchor': anchor, class: 'dim-t' }, `${edge.toLowerCase()} ${f(v)} ${d.unit}${narrow ? '' : ` · ${pxOf(edge)} px`}`));
    };
    if (d.left > 0) hdim(0, d.left, 'Left', d.left, 'start');
    if (d.right > 0) hdim(d.W - d.right, d.W, 'Right', d.right, 'end');
    // overall size under the phone and along its right side
    const scr = val('Screen');
    const yb = Y(d.H) + bez + 16;
    svg.append(sv('line', { x1: X(0), x2: X(d.W), y1: yb, y2: yb, class: 'dim' }));
    for (const xx of [0, d.W]) svg.append(sv('line', { x1: X(xx), x2: X(xx), y1: yb - 5, y2: yb + 5, class: 'dim' }));
    svg.append(sv('text', { x: X(d.W / 2), y: yb + 16, 'text-anchor': 'middle', class: 'dim-t' }, `${f(d.W)} ${d.unit}`));
    if (scr?.hint) svg.append(sv('text', { x: X(d.W / 2), y: yb + 30, 'text-anchor': 'middle', class: 'dim-s' }, scr.hint));
    const xr = X(d.W) + bez + 16;
    svg.append(sv('line', { x1: xr, x2: xr, y1: Y(0), y2: Y(d.H), class: 'dim' }));
    for (const yy of [0, d.H]) svg.append(sv('line', { x1: xr - 5, x2: xr + 5, y1: Y(yy), y2: Y(yy), class: 'dim' }));
    svg.append(sv('text', { x: xr + 13, y: Y(d.H / 2), 'text-anchor': 'middle', class: 'dim-t', transform: `rotate(90 ${xr + 13} ${Y(d.H / 2)})` }, `${f(d.H)} ${d.unit}`));

    // callouts: what sits in the top and bottom bands
    if (!narrow) {
      const lx = xr + 32;
      const call = (yPt, xPt, text) => {
        const yy = Y(yPt);
        svg.append(sv('path', { class: 'lead', d: `M${X(xPt)},${yy} H${lx - 4}` }));
        svg.append(sv('circle', { cx: X(xPt), cy: yy, r: 2.2, fill: 'var(--ink-soft)' }));
        svg.append(sv('text', { x: lx, y: yy + 4, class: 'lead-t' }, text));
      };
      const tw = edgeRow('Top')?.[3], bw3 = edgeRow('Bottom')?.[3];
      if (d.top > 0 && tw && tw !== '–') call(d.top / 2, d.W - d.right - 6, tw);
      if (d.bottom > 0 && bw3 && bw3 !== '–') call(d.H - d.bottom / 2, d.W - d.right - 6, bw3);
      if (d.right > 0 && d.nav?.side === 'right') call(d.H * 0.18, d.W - d.right / 2, edgeRow('Right')?.[3] || '');
    }

    // grips on the safe edges
    const grip = (edge, cx, cy, horiz) => {
      const gg = sv('g', { class: `grip${horiz ? ' h' : ''}${state.drag === edge ? ' on' : ''}`, tabindex: '0', role: 'slider', 'data-edge': edge,
        'aria-label': `${edge} inset`, 'aria-valuenow': d[edge], 'aria-valuemin': 0, 'aria-valuetext': `${f(d[edge])} ${d.unit}` });
      const W2 = horiz ? 10 : 30, H2 = horiz ? 30 : 10;
      gg.append(sv('rect', { x: cx - W2 / 2, y: cy - H2 / 2, width: W2, height: H2, rx: 4 }));
      for (const o of [-3, 0, 3]) {
        if (horiz) gg.append(sv('line', { x1: cx - 2.5, x2: cx + 2.5, y1: cy + o, y2: cy + o }));
        else gg.append(sv('line', { x1: cx + o, x2: cx + o, y1: cy - 2.5, y2: cy + 2.5 }));
      }
      gg.append(sv('title', {}, `Drag to change the ${edge} inset (${f(d[edge])} ${d.unit}); arrow keys: ±1, Shift: ±10`));
      svg.append(gg);
    };
    const gx = X(d.left + sw * 0.3);
    grip('top', gx, Y(d.top), false);
    grip('bottom', gx, Y(d.H - d.bottom), false);
    grip('left', X(d.left), Y(d.top + shh * 0.3), true);
    grip('right', X(d.W - d.right), Y(d.top + shh * 0.3), true);

    // rotate button at the lower right corner
    const rb = sv('g', { class: 'rot', tabindex: '0', role: 'button', 'aria-label': `Rotate to ${d.land ? 'portrait' : 'landscape'} (R)` });
    const rcx = X(d.W) + bez + 22, rcy = Y(d.H) + bez + 22;
    rb.append(sv('circle', { cx: rcx, cy: rcy, r: 14 }),
      sv('path', { d: `M${rcx - 6},${rcy - 2} a6.5,6.5 0 1 1 1.5,6.5 M${rcx - 6},${rcy - 7} v5 h5` }),
      sv('title', {}, `Rotate to ${d.land ? 'portrait' : 'landscape'} (R)`));
    rb.addEventListener('click', rotate);
    rb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rotate(); } });
    svg.append(rb);

    // probe tag
    if (p) {
      svg.append(sv('circle', { cx: X(p.x), cy: Y(p.y), r: 4, class: 'probe-dot' }));
      const z = zoneAt(p);
      const t1 = `${f(r1(p.x))}, ${f(r1(p.y))} ${d.unit}`;
      const t2 = z.safe ? 'safe' : z.what;
      const w = Math.max(t1.length, t2.length) * 6.9 + 14;
      let tx = X(p.x) + 10, ty = Y(p.y) + 10;
      if (tx + w > bw - 4) tx = X(p.x) - 10 - w;
      if (ty + 36 > bh - 4) ty = Y(p.y) - 46;
      const tg = sv('g', { class: 'probe-tag' });
      tg.append(sv('rect', { x: tx, y: ty, width: w, height: 36, rx: 4 }),
        sv('text', { x: tx + 7, y: ty + 14 }, t1),
        sv('text', { x: tx + 7, y: ty + 29, style: `fill:var(${z.safe ? '--tool-safe' : '--danger'})` }, t2));
      svg.append(tg);
    }
    if (state.dropping) {
      svg.append(sv('rect', { x: X(0), y: Y(0), width: PW, height: PH, rx: R, class: 'drop' }));
      svg.append(sv('text', { x: X(d.W / 2), y: Y(d.H / 2) + 40, 'text-anchor': 'middle', class: 'drop-t' }, 'Drop the screenshot'));
    }
  }

  // Where a point on the screen falls: the cutout, a band, or safe.
  function zoneAt(p) {
    const d = dr();
    const c = d.cut;
    if (c) {
      const inCut = c.kind === 'punch' ? Math.hypot(p.x - (c.x + c.w / 2), p.y - (c.y + c.h / 2)) <= c.w / 2
        : p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
      if (inCut) return { safe: false, what: c.kind === 'island' ? 'Dynamic Island' : c.kind === 'notch' ? 'notch' : 'camera hole', out: outside(p) };
    }
    const row = (e) => edgeRow(e)?.[3] || e.toLowerCase();
    if (p.y < d.top) return { safe: false, what: row('Top'), out: outside(p) };
    if (p.y > d.H - d.bottom) return { safe: false, what: row('Bottom'), out: outside(p) };
    if (p.x < d.left) return { safe: false, what: row('Left'), out: outside(p) };
    if (p.x > d.W - d.right) return { safe: false, what: row('Right'), out: outside(p) };
    return { safe: true, clear: Math.min(p.y - d.top, d.H - d.bottom - p.y, p.x - d.left, d.W - d.right - p.x) };
  }
  function outside(p) {
    const d = dr();
    const dx = Math.max(d.left - p.x, 0, p.x - (d.W - d.right));
    const dy = Math.max(d.top - p.y, 0, p.y - (d.H - d.bottom));
    return Math.hypot(dx, dy);
  }

  function drawFoot() {
    const d = dr();
    const p = state.hover || state.probe;
    if (!d) { foot.replaceChildren(); return; }
    if (!p) {
      foot.replaceChildren(h('span', { class: 'sa-soft' }, 'Point at the screen to read a position · click to pin it · drag a green grip to change an inset · drop a screenshot on the phone'));
      return;
    }
    const z = zoneAt(p);
    foot.replaceChildren(...[
      h('span', {}, h('b', { class: 'sa-mono' }, `x ${f(r1(p.x))}  y ${f(r1(p.y))} ${d.unit}`)),
      h('span', { class: 'sa-mono sa-soft' }, `${f(Math.round(p.x * d.scale))}, ${f(Math.round(p.y * d.scale))} px`),
      z.safe ? h('span', { class: 'sa-zone-safe' }, `safe · ${f(r1(z.clear))} ${d.unit} clear of the nearest safe edge`)
        : h('span', { class: 'sa-zone-bad' }, `unsafe: ${z.what} · ${f(r1(z.out))} ${d.unit} outside the safe area`),
      state.probe && !state.hover ? h('span', { class: 'sa-soft' }, 'pinned · arrow keys move it · Esc clears') : null].filter(Boolean));
  }

  function drawHead() {
    const d = dr(); const raw = ctx.raw;
    title.textContent = d ? d.name : 'Safe area';
    seg(orientSeg, [['portrait', 'Portrait'], ['landscape', 'Landscape']], raw.orientation, (v) => ctx.set('orientation', v));
    const android = isAndroid();
    navWrap.style.display = android ? '' : 'none';
    seg(navSeg, [['gesture', 'Gesture'], ['buttons', '3 buttons']], raw.androidNav, (v) => ctx.set('androidNav', v));
    const cust = raw.device === 'custom';
    custWrap.style.display = cust ? '' : 'none';
    seg(cutSeg, [['none', 'None'], ['notch', 'Notch'], ['island', 'Island'], ['punch', 'Hole']], raw.ccut, (v) => ctx.set('ccut', v));
    for (const n of [cw, chh, cs]) {
      if (document.activeElement !== n.i) n.i.value = raw[n.key] ?? '';
      const v = ctx.input[n.key];
      n.i.classList.toggle('bad', cust && !(v > 0));
    }
  }

  function drawSide() {
    const d = dr();
    const lost = val('Outside safe area');
    root.querySelector(`#sa-lost-${id}`).textContent = lost ? `${lost.value} of the screen is outside` : '';
    if (!d) { cross.replaceChildren(); } else {
      const e = (cls, edge, v) => {
        const row = edgeRow(edge);
        return h('div', { class: `e ${cls}${v > 0 ? ' nz' : ''}` }, h('span', { class: 'k' }, edge),
          h('b', {}, `${f(v)} ${d.unit}`), h('small', {}, `${row?.[2] ?? ''} px${row && row[3] !== '–' ? ` · ${row[3]}` : ''}`));
      };
      const sa = val('Safe area'), scr = val('Screen');
      cross.replaceChildren(
        h('div', { class: 'x1' }, d.land ? 'landscape' : 'portrait'),
        e('t', 'Top', d.top), e('l', 'Left', d.left),
        h('div', { class: 'c' }, h('span', { class: 'k' }, 'safe area'), h('b', {}, `${sa?.value ?? ''}`), h('small', {}, `${d.unit} · ${sa?.hint ?? ''}`)),
        e('r', 'Right', d.right), e('b', 'Bottom', d.bottom),
        h('div', { class: 'x3' }, scr ? `screen ${scr.value} ${d.unit}` : ''));
    }
    // screenshot
    const file = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    file.addEventListener('change', () => loadFile(file.files && file.files[0]));
    const pick = h('label', { class: 'k-btn', tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } }, shot ? 'Change…' : 'Load a screenshot…', file);
    const rows = [h('div', { class: 'row' }, pick,
      shot ? h('button', { class: 'k-btn', type: 'button', onclick: () => { shot = null; drawAll(); } }, 'Remove') : null,
      shot ? h('label', { class: 'sa-lbl' }, 'Opacity', (() => {
        const r = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', 'aria-label': 'Screenshot opacity' });
        r.value = String(state.op);
        r.addEventListener('input', () => { state.op = +r.value; drawStage(); });
        return r;
      })()) : null)];
    if (d) {
      const expW = Math.round(d.W * d.scale), expH = Math.round(d.H * d.scale);
      if (shot) {
        const aspect = Math.abs(shot.w / shot.h - d.W / d.H) / (d.W / d.H);
        const exact = shot.w === expW && shot.h === expH;
        rows.push(h('div', { class: exact ? 'good' : aspect > 0.02 ? 'bad' : '' },
          `${shot.name}: ${shot.w} × ${shot.h} px${exact ? ' - matches this screen exactly' : ` - this screen is ${expW} × ${expH} px${aspect > 0.02 ? '; the aspect differs, so it is stretched: pick the matching device or orientation' : '; same aspect, scaled'}`}`));
      } else rows.push(h('div', { class: 'sa-soft' }, `Or drop an image on the phone. A full screenshot of this screen is ${expW} × ${expH} px. It stays in this page.`));
    }
    shotBox.replaceChildren(...rows);
    msgs.replaceChildren(
      ...(res().warnings?.length ? [h('div', { class: 'k-warns' }, res().warnings.map((w) => h('div', {}, w)))] : []),
      ...(res().notes?.length ? [h('div', { class: 'k-notes' }, res().notes.map((w) => h('div', {}, w)))] : []));
  }

  function drawAll() {
    drawHead(); drawShelf(); drawStage(); drawFoot(); drawSide();
    if (refocus) { shelfSvg.querySelector(`[data-id="${refocus}"]`)?.focus(); refocus = null; }
  }

  function rotate() {
    state.probe = null;
    ctx.set('orientation', ctx.raw.orientation === 'landscape' ? 'portrait' : 'landscape');
    setTimeout(() => svg.querySelector('.rot')?.focus(), 0);
  }

  // ---------- pointer ----------
  const toPt = (e) => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const q = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: (q.x - geo.ox) / geo.k, y: (q.y - geo.oy) / geo.k };
  };
  const onScreen = (p) => geo && p.x >= 0 && p.y >= 0 && p.x <= geo.d.W && p.y <= geo.d.H;
  svg.addEventListener('pointerdown', (e) => {
    if (!geo) return;
    const gr = e.target.closest('.grip');
    if (gr) {
      state.drag = gr.dataset.edge; state.hover = null;
      svg.setPointerCapture(e.pointerId); e.preventDefault();
      drawStage(); return;
    }
    if (e.target.closest('.rot')) return;
    const p = toPt(e);
    if (onScreen(p)) { state.probe = { x: p.x, y: p.y }; drawStage(); drawFoot(); }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!geo) return;
    const p = toPt(e);
    if (state.drag) {
      const d = geo.d, edge = state.drag;
      const lim = (edge === 'top' || edge === 'bottom') ? d.H - d.top - d.bottom + d[edge] - 20 : d.W - d.left - d.right + d[edge] - 20;
      const v = edge === 'top' ? p.y : edge === 'bottom' ? d.H - p.y : edge === 'left' ? p.x : d.W - p.x;
      const nv = clamp(Math.round(v), 0, Math.max(0, lim));
      if (nv !== d[edge]) setInset(edge, nv);
      return;
    }
    if (e.pointerType === 'touch' && e.buttons === 0) return;
    const was = !!state.hover;
    state.hover = onScreen(p) ? { x: p.x, y: p.y } : null;
    if (state.hover || was) { drawStage(); drawFoot(); }
  });
  const endDrag = () => { if (state.drag) { state.drag = null; drawStage(); } };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', () => { if (!state.drag && state.hover) { state.hover = null; drawStage(); drawFoot(); } });

  svg.addEventListener('keydown', (e) => {
    if (!geo) return;
    const d = geo.d;
    const step = e.shiftKey ? 10 : 1;
    const gr = e.target.closest && e.target.closest('.grip');
    const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (gr) {
      const edge = gr.dataset.edge;
      const sgn = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] }[edge];
      const dir = dirs[e.key]; if (!dir) return;
      e.preventDefault();
      const delta = (dir[0] * sgn[0] + dir[1] * sgn[1]) * step;
      if (!delta) return;
      setInset(edge, clamp(d[edge] + delta, 0, 10000));
      setTimeout(() => svg.querySelector(`.grip[data-edge="${edge}"]`)?.focus(), 0);
      return;
    }
    if (e.target !== svg) return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotate(); return; }
    if (e.key === 'Escape') { state.probe = null; drawStage(); drawFoot(); return; }
    const dir = dirs[e.key]; if (!dir) return;
    e.preventDefault();
    const p = state.probe || { x: d.W / 2, y: d.H / 2 };
    state.probe = { x: clamp(p.x + dir[0] * step, 0, d.W), y: clamp(p.y + dir[1] * step, 0, d.H) };
    drawStage(); drawFoot();
  });

  // ---------- drop a screenshot ----------
  box.addEventListener('dragover', (e) => { e.preventDefault(); if (!state.dropping) { state.dropping = true; drawStage(); } });
  box.addEventListener('dragleave', (e) => { if (e.target === svg || !box.contains(e.relatedTarget)) { state.dropping = false; drawStage(); } });
  box.addEventListener('drop', (e) => {
    e.preventDefault(); state.dropping = false;
    loadFile(e.dataTransfer?.files?.[0]); drawStage();
  });

  // ---------- run ----------
  const ro = new ResizeObserver(() => { drawShelf(); drawStage(); });
  ro.observe(box); ro.observe(shelfScroll);
  let lastDev = null;
  ctx.onResult(() => {
    if (ctx.raw.device !== lastDev) { state.probe = null; lastDev = ctx.raw.device; }
    drawAll();
  });
}
