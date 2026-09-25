// Thread & Tap Drill: the page is the tapped hole. A drill index to pick the
// thread from (holes sized by diameter), the hole in axial section to scale
// with the screw in it and the drill wall to slide (it sets the % of thread),
// and the tapped and clearance holes as drawn in plan.
// Every number drawn comes from run()'s result (result.draw).

const NS = 'http://www.w3.org/2000/svg';
const IN = 25.4;
const T30 = Math.tan(Math.PI / 6);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function sv(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const g = (v, d = 4) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(d))));
const r3 = (v) => String(Math.round(v * 1000) / 1000);
const PLATES = [
  ['Metric coarse', (r) => r.family === 'Metric coarse'],
  ['Metric fine', (r) => r.family === 'Metric fine'],
  ['Unified UNC / UNF', (r) => /Unified/.test(r.family)],
];

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let D = null, res = null;

  // ---------- index ----------
  const filterIn = h('input', { class: 'td-filter', type: 'search', spellcheck: 'false', placeholder: 'filter: M1, fine, UNF',
    'aria-label': 'Filter the threads', oninput: (e) => ctx.set('filter', e.target.value) });
  const plates = h('div', { class: 'td-plates' });
  const index = h('section', { class: 'td-card td-index' },
    h('div', { class: 'td-head' }, h('span', { class: 'td-cap' }, 'Drill index'), filterIn), plates);

  // ---------- section ----------
  const title = h('div', { class: 'td-title' });
  const secSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'The tapped hole in section, with the screw in it' });
  const foot = h('div', { class: 'td-foot' });
  const secBox = h('div', { class: 'td-box' }, secSvg, foot);
  const sec = h('section', { class: 'td-card td-sec' },
    h('div', { class: 'td-head' }, title,
      h('div', { class: 'td-legend' }, h('span', {}, h('i', { class: 'nut' }), 'part, tapped'), h('span', {}, h('i', { class: 'scr' }), 'screw'),
        h('span', {}, h('i', { class: 'eng' }), 'flanks in contact'))),
    secBox);

  // ---------- side ----------
  const plan = h('div', { class: 'td-card td-plan' });
  const engIn = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Thread engagement, %', oninput: (e) => ctx.set('engagement', e.target.value) });
  const read = h('div', { class: 'td-card td-read' });
  const warns = h('div', { class: 'td-warns', 'aria-live': 'polite' });
  const side = h('aside', { class: 'td-side' }, read, plan, warns, ctx.outputs);
  root.append(h('div', { class: 'td' }, index, sec, side));

  // ---------- drill index ----------
  function drawIndex() {
    const had = document.activeElement?.closest?.('.td-cell')?.dataset.name;
    plates.replaceChildren();
    if (!D) return;
    const W = Math.max(220, plates.clientWidth - 16 || 290);
    const cur = D.sel.name;
    const k = 1.25; // px per mm of hole diameter
    for (const [name, test] of PLATES) {
      const items = D.list.filter(test);
      const cols = Math.max(4, Math.floor(W / 50));
      const cw = W / cols;
      const maxD = Math.max(...items.map((r) => r.D));
      const holeH = Math.max(18, maxD * k + 6);
      const ch = holeH + 30;
      const rows = Math.ceil(items.length / cols);
      const svg = sv(null, 'svg', { viewBox: `0 0 ${W} ${rows * ch + 6}`, role: 'radiogroup', 'aria-label': name });
      items.forEach((r, i) => {
        const x = (i % cols) * cw, y = Math.floor(i / cols) * ch + 3;
        const on = r.name === cur;
        const cell = sv(svg, 'g', { class: `td-cell${on ? ' on' : ''}${r.match ? '' : ' off'}`, 'data-name': r.name, role: 'radio',
          'aria-checked': String(on), tabindex: on ? 0 : -1, 'aria-label': `${r.name}, tap drill ${r.tapLabel}` });
        sv(cell, 'title', {}, `${r.name} · ${r.family}\ntap drill ${r.tapLabel}`);
        sv(cell, 'rect', { x: x + 1.5, y, width: cw - 3, height: ch - 2, rx: 4, class: 'cellbg' });
        sv(cell, 'circle', { cx: x + cw / 2, cy: y + holeH / 2 + 2, r: Math.max(1.6, (r.D * k) / 2), class: 'hole' });
        const short = r.name.replace(/ UN[CF]$/, '');
        sv(cell, 'text', { x: x + cw / 2, y: y + holeH + 13, style: short.length > 7 ? 'font-size:9.5px' : null }, short);
        sv(cell, 'text', { x: x + cw / 2, y: y + holeH + 25, style: 'font-size:9.5px' }, r.tpi ? r.tapLabel.split(' ')[0] : g(r.tap, 3));
      });
      plates.append(h('div', { class: 'td-plate' }, h('h3', {}, h('span', {}, name), h('span', {}, items.some((r) => /Unified/.test(r.family)) ? 'tap drill: size / letter / fraction' : 'tap drill, mm')), svg));
    }
    const focusName = had || null;
    if (focusName) plates.querySelector(`[data-name="${CSS.escape(focusName)}"]`)?.focus();
  }
  plates.addEventListener('click', (e) => {
    const c = e.target.closest?.('.td-cell');
    if (c) ctx.set('thread', c.dataset.name);
  });
  plates.addEventListener('keydown', (e) => {
    const c = e.target.closest?.('.td-cell');
    if (!c || !D) return;
    const all = [...plates.querySelectorAll('.td-cell')];
    const i = all.indexOf(c);
    const svg = c.ownerSVGElement;
    const inPlate = [...svg.querySelectorAll('.td-cell')];
    const cols = Math.max(4, Math.floor((Number(svg.viewBox.baseVal.width) || 290) / 50));
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.set('thread', c.dataset.name); return; }
    if (!d) return;
    e.preventDefault();
    const j = inPlate.indexOf(c);
    const n = Math.abs(d) === 1 ? all[i + d]
      : inPlate[j + d] || (d > 0 ? all[i + (inPlate.length - j)] : all[i - j - 1]);
    if (n) { n.focus(); ctx.set('thread', n.dataset.name); }
  });

  // ---------- section ----------
  let geo = null;
  function drawSection() {
    const svg = secSvg; svg.replaceChildren();
    const W = Math.max(300, secBox.clientWidth || 700), H = Math.max(300, secBox.clientHeight || 500);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!D) return;
    const s = D.sel;
    const narrow = W < 520;
    const Dm = s.D, P = s.P, drill = s.drill;
    const Rm = Dm / 2 - 0.6495 * P;          // crest of a 100 % thread
    const Rs = Dm / 2 - 0.6134 * P;          // screw root (basic)
    const top = narrow ? 74 : 86, bot = narrow ? 92 : 84, side = narrow ? 14 : 56;
    // a detail of the wall: from inside the screw root to beyond the major diameter
    const need0 = Math.max(0, Rs - 1.1 * P), need1 = Dm / 2 + 1.1 * P;
    const sx = Math.min((W - 2 * side) / (need1 - need0), (H - top - bot) / (3.4 * P));
    const mid = (need0 + need1) / 2, half = (W - 2 * side) / (2 * sx);
    const rL = Math.max(0, mid - half), rR = rL + 2 * half;
    const Ly = (H - top - bot) / sx;
    const X = (r) => side + (r - rL) * sx, Y = (y) => top + y * sx;
    geo = { X, sx, rL, side, top, s };
    const c0 = P / 16;
    const dist = (y) => Math.abs((((y - c0 + P / 2) % P) + P) % P - P / 2);
    const nutR = (y) => { const d = dist(y); return d <= P / 16 ? Dm / 2 : Math.max(Rm, Dm / 2 - (d - P / 16) / T30); };
    const scrR = (y) => { const d = dist(y); return d <= P / 16 ? Dm / 2 : Math.max(Rs, Dm / 2 - (d - P / 16) / T30); };
    const nutB = (y) => Math.max(nutR(y), drill / 2);
    const N = Math.ceil((Ly / P) * 96);
    const ys = Array.from({ length: N + 1 }, (_, i) => (i / N) * Ly);
    // the screw enters from below: its end face sits at a root, about a third down
    const yS0 = c0 + P / 2 + P * Math.max(0, Math.floor(Ly / P / 3));
    const ysS = ys.filter((y) => y >= yS0);

    const defs = sv(svg, 'defs');
    const pt = sv(defs, 'pattern', { id: 'td-hatch', patternUnits: 'userSpaceOnUse', width: 8, height: 8, patternTransform: 'rotate(45)' });
    sv(pt, 'rect', { width: 8, height: 8, class: 'td-hbg' }); sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'td-hln' });
    const mk = sv(defs, 'marker', { id: 'td-ar', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,0 L10,5 L0,10 z', class: 'td-dimhead' });

    // the usual 65-77 % drill band, as a strip through the hole
    const [b77, b65] = s.band;
    sv(svg, 'rect', { x: X(b77 / 2), y: top, width: X(b65 / 2) - X(b77 / 2), height: Ly * sx, class: 'td-band' });
    // the part, tapped
    const np = ys.map((y) => `${X(nutB(y)).toFixed(1)},${Y(y).toFixed(1)}`);
    sv(svg, 'path', { class: 'td-nut', d: `M${X(rR)},${Y(0)} L${np.join(' L')} L${X(rR)},${Y(Ly)} Z` });
    // the screw, from the left edge (toward the axis) to its thread
    const xl = X(rL);
    const spts = ysS.map((y) => `${X(scrR(y)).toFixed(1)},${Y(y).toFixed(1)}`);
    sv(svg, 'path', { class: 'td-screw', d: `M${xl},${Y(yS0)} L${spts.join(' L')} L${xl},${Y(Ly)} Z` });
    // contact: the shared flank between the drill wall and the screw crest
    let seg = [];
    const flush = () => { if (seg.length > 1) sv(svg, 'polyline', { class: 'td-eng', points: seg.join(' ') }); seg = []; };
    for (const y of ysS) {
      const r = scrR(y);
      if (r >= drill / 2 && r < Dm / 2 - 1e-9 && r > Rs + 1e-9) seg.push(`${X(r).toFixed(1)},${Y(y).toFixed(1)}`);
      else flush();
    }
    flush();
    // axis or the break toward it
    if (rL <= 0) sv(svg, 'line', { x1: X(0), x2: X(0), y1: top - 6, y2: Y(Ly) + 6, class: 'td-axis' });
    else {
      const zz = []; for (let y = 0, i = 0; y <= Ly * sx; y += 10, i++) zz.push(`${xl + (i % 2 ? 4 : -4)},${top + y}`);
      sv(svg, 'polyline', { points: zz.join(' '), class: 'td-dim' });
      sv(svg, 'text', { x: xl + 6, y: Y(Ly) - 8, class: 'td-lbl-s td-scr-t' }, narrow ? 'screw' : `screw · axis ${g(rL, 3)} mm left`);
    }
    // chart drill and the drill wall
    sv(svg, 'line', { x1: X(s.tap / 2), x2: X(s.tap / 2), y1: top, y2: Y(Ly), class: 'td-chart' });
    sv(svg, 'line', { x1: X(drill / 2), x2: X(drill / 2), y1: top - 8, y2: Y(Ly) + 6, class: 'td-drill' });
    sv(svg, 'text', { x: X(rR) - 8, y: Y(Ly) - 8, 'text-anchor': 'end', class: 'td-lbl-s' }, 'part, tapped');
    if (yS0 > P) sv(svg, 'text', { x: X(drill / 2) - 8, y: Y(yS0 / 2) + 4, 'text-anchor': 'end', class: 'td-lbl-s' }, 'tapped, empty');

    // % of thread scale above the drawing, with the knob
    const rOf = (p) => Dm / 2 - (p / 100) * 0.6495 * P; // drill wall radius for p % thread
    const yS = top - (narrow ? 30 : 34);
    sv(svg, 'line', { x1: X(rOf(100)), x2: X(rOf(0)), y1: yS, y2: yS, class: 'td-scale' });
    sv(svg, 'rect', { x: X(rOf(77)), y: yS - 5, width: X(rOf(65)) - X(rOf(77)), height: 10, class: 'td-band' });
    const px10 = Math.abs(X(rOf(10)) - X(rOf(0)));
    const every = px10 > 26 ? 10 : px10 > 13 ? 20 : 50;
    for (let p = 0; p <= 100; p += 5) {
      sv(svg, 'line', { x1: X(rOf(p)), x2: X(rOf(p)), y1: yS, y2: yS + (p % 10 ? 3 : 6), class: 'td-scale' });
      if (p % every === 0) sv(svg, 'text', { x: X(rOf(p)), y: yS + 17, class: 'td-tick' }, `${p}`);
    }
    sv(svg, 'text', { x: X(rOf(0)) + 8, y: yS + 4, class: 'td-lbl-s' }, '% thread');
    const xc = X(s.tap / 2);
    sv(svg, 'path', { d: `M${xc},${yS + 1} l-4,7 h8 z`, class: 'td-okc' });
    const xk = X(drill / 2);
    const knob = sv(svg, 'g', { class: 'td-knob', tabindex: 0, role: 'slider', 'data-h': 'knob', 'aria-label': 'Thread engagement: slide the drill wall',
      'aria-valuemin': 50, 'aria-valuemax': 100, 'aria-valuenow': s.e, 'aria-valuetext': `${g(s.e, 3)} %, drill ${r3(drill)} mm` });
    sv(knob, 'rect', { x: xk - 12, y: yS - 16, width: 24, height: Y(Ly) - yS + 16, class: 'hit' });
    sv(knob, 'path', { d: `M${xk},${yS + 1} l-7,-11 h14 z`, class: 'grip' });
    const eTone = s.e < 55 || s.e > 85 ? 'td-badc' : s.e < 65 || s.e > 77 ? 'td-warnc' : 'td-acc';
    const kt = narrow ? `${g(s.e, 3)} % · Ø${r3(drill)}` : `${g(s.e, 3)} % thread · drill Ø${r3(drill)}`;
    const kw = kt.length * 8;
    const [kx, ka] = xk + 10 + kw < W - 4 ? [xk + 10, 'start'] : xk - 10 - kw > 4 ? [xk - 10, 'end'] : [W / 2, 'middle'];
    sv(svg, 'text', { x: kx, y: yS - 18, 'text-anchor': ka, class: `td-lbl-b ${eTone}` }, kt);
    sv(svg, 'text', { x: xc + 6, y: top + 14, class: 'td-lbl-s td-okc' }, `chart ${s.tapLabel.replace(/ \(.*/, '')} · ${g(s.pctTap, 3)} %`);

    // diameters as marks below the drawing, one row each
    const yb = Y(Ly);
    const mark = (r, row, text, cls) => {
      const y = yb + 16 + row * 19, x = X(r);
      sv(svg, 'line', { x1: x, x2: x, y1: yb, y2: y, class: 'td-ext' });
      sv(svg, 'circle', { cx: x, cy: y, r: 2.5, class: cls.includes('td-acc') ? 'td-acc' : 'td-dimhead' });
      const right = x < W - 170;
      sv(svg, 'text', { x: x + (right ? 7 : -7), y: y + 4, 'text-anchor': right ? 'start' : 'end', class: cls }, text);
    };
    const inch = s.inch;
    mark(Dm / 2, 0, `Ø${r3(Dm)} major${inch ? ` (${(Dm / IN).toFixed(4)}")` : ''}`, 'td-lbl');
    mark(s.minor / 2, 1, `Ø${r3(s.minor)} minor, basic`, 'td-lbl-s');
    mark(drill / 2, 2, `Ø${r3(drill)} drill`, 'td-lbl td-acc');
    // pitch, at the right edge in the part
    const xP = X(rR) - (narrow ? 18 : 26);
    const k0 = Math.max(1, Math.floor(Ly / P) - 2);
    const y1 = c0 + P * k0, y2 = y1 + P;
    if (Y(y2) < yb) {
      sv(svg, 'line', { x1: X(Dm / 2), x2: xP + 5, y1: Y(y1), y2: Y(y1), class: 'td-ext' });
      sv(svg, 'line', { x1: X(Dm / 2), x2: xP + 5, y1: Y(y2), y2: Y(y2), class: 'td-ext' });
      sv(svg, 'line', { x1: xP, x2: xP, y1: Y(y1), y2: Y(y2), class: 'td-dim', 'marker-start': 'url(#td-ar)', 'marker-end': 'url(#td-ar)' });
      const t = inch ? `${s.tpi} TPI` : `P ${g(P)}`;
      sv(svg, 'rect', { x: xP - 8 - t.length * 7.4, y: (Y(y1) + Y(y2)) / 2 - 9, width: t.length * 7.4 + 4, height: 17, rx: 3, fill: 'var(--surface)' });
      sv(svg, 'text', { x: xP - 6, y: (Y(y1) + Y(y2)) / 2 + 4, 'text-anchor': 'end', class: 'td-lbl' }, t);
    }
    foot.textContent = narrow ? `Wall detail, ${g(sx, 3)} px/mm · drag the drill wall`
      : `Detail of the wall, to scale ${g(sx, 3)} px/mm · drag the drill wall or the % scale, arrow keys on the knob`;
  }
  const setFromX = (x) => {
    const s = geo.s;
    const drill = 2 * (geo.rL + (x - geo.side) / geo.sx);
    const e = Math.round(clamp((76.98 * (s.D - drill)) / s.P, 50, 100));
    if (String(e) !== String(ctx.raw.engagement)) ctx.set('engagement', String(e));
  };
  secSvg.addEventListener('pointerdown', (e) => {
    if (!geo || !D) return;
    const r = secSvg.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const onScale = y < geo.top - 4;
    const onWall = Math.abs(x - geo.X(D.sel.drill / 2)) < 12;
    if (!onScale && !onWall) return;
    capture(secSvg, e); e.preventDefault();
    setFromX(x);
    const move = (ev) => setFromX(ev.clientX - r.left);
    const up = () => { secSvg.removeEventListener('pointermove', move); secSvg.removeEventListener('pointerup', up); secSvg.removeEventListener('pointercancel', up); };
    secSvg.addEventListener('pointermove', move); secSvg.addEventListener('pointerup', up); secSvg.addEventListener('pointercancel', up);
  });
  secSvg.addEventListener('keydown', (e) => {
    if (!e.target.closest?.('.td-knob') || !D) return;
    // right = larger drill = less thread
    const d = { ArrowRight: -1, ArrowLeft: 1, ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    ctx.set('engagement', String(clamp(Math.round(D.sel.e) + d * (e.shiftKey ? 5 : 1), 50, 100)));
  });

  // ---------- plan views ----------
  function drawPlan() {
    plan.replaceChildren();
    if (!D) return;
    const s = D.sel;
    const big = Math.max(...s.clear);
    const S = 120, k = (S * 0.72) / big, c = S / 2;
    const fig = (cap, build) => {
      const svg = sv(null, 'svg', { viewBox: `0 0 ${S} ${S}`, role: 'img', 'aria-label': cap });
      sv(svg, 'rect', { x: 2, y: 2, width: S - 4, height: S - 4, rx: 4, class: 'td-pl-part' });
      build(svg);
      sv(svg, 'line', { x1: c - big * k * 0.62, x2: c + big * k * 0.62, y1: c, y2: c, class: 'td-pl-c', 'stroke-dasharray': '6 2 1 2' });
      sv(svg, 'line', { y1: c - big * k * 0.62, y2: c + big * k * 0.62, x1: c, x2: c, class: 'td-pl-c', 'stroke-dasharray': '6 2 1 2' });
      return h('figure', {}, svg, h('figcaption', {}, cap));
    };
    const tapped = fig(`Tapped: Ø${r3(s.drill)} drill, ${s.name}`, (svg) => {
      sv(svg, 'circle', { cx: c, cy: c, r: (s.drill * k) / 2, class: 'td-pl-hole' });
      // the drafting convention: a thin three-quarter circle at the major diameter
      const r = (s.D * k) / 2;
      sv(svg, 'path', { d: `M${c + r},${c} A${r},${r} 0 1 1 ${c},${c - r}`, class: 'td-pl-thin' });
    });
    const use = s.clearUse;
    const clear = fig(`Clearance: Ø${r3(s.clear[use])} ${s.clearLabels[use]}`, (svg) => {
      s.clear.forEach((d, i) => { if (i !== use) sv(svg, 'circle', { cx: c, cy: c, r: (d * k) / 2, class: 'td-pl-ring' }); });
      sv(svg, 'circle', { cx: c, cy: c, r: (s.clear[use] * k) / 2, class: 'td-pl-use' });
      sv(svg, 'circle', { cx: c, cy: c, r: (s.D * k) / 2, class: 'td-pl-bolt' });
    });
    plan.append(h('div', { class: 'td-cap', style: 'margin-bottom:4px' }, 'In plan, as drawn · same scale'), h('div', { class: 'td-plan-row' }, tapped, clear));
  }

  // ---------- readouts ----------
  function drawRead() {
    read.replaceChildren();
    if (!D) return;
    const s = D.sel;
    const inch = s.inch;
    const mmIn = (mm) => (inch ? [`${r3(mm)}`, h('small', {}, ` mm · ${(mm / IN).toFixed(4)}"`)] : [`${r3(mm)}`, h('small', {}, ' mm')]);
    const eTone = s.e < 55 || s.e > 85 ? 'var(--danger)' : s.e < 65 || s.e > 77 ? 'var(--warn)' : 'var(--accent)';
    read.append(
      h('div', { class: 'td-cap' }, `Drill for ${g(s.e, 3)} % thread`),
      h('div', { class: 'td-big', style: `color:${eTone}` }, `Ø${r3(s.drill)}`, h('small', {}, inch ? `mm · ${(s.drill / IN).toFixed(4)}"` : 'mm')),
      h('div', { class: 'td-eng-row' }, h('span', {}, 'Engagement'), engIn, h('span', {}, '%'),
        ...[65, 70, 75].map((p) => h('button', { type: 'button', class: 'k-btn', style: 'padding:1px 7px', onclick: () => ctx.set('engagement', String(p)) }, `${p}`))),
    );
    const row = (k, v, cls) => [h('dt', {}, k), h('dd', { class: cls || null }, ...(Array.isArray(v) ? v : [v]))];
    const dl = h('dl', { class: 'td-dl' },
      row('Tap drill, chart', [s.tapLabel, h('small', {}, ` · ${g(s.pctTap, 3)} %`)], 'use'),
      row('Pitch', inch ? [`${s.tpi} TPI`, h('small', {}, ` · ${r3(s.P)} mm`)] : [`${g(s.P)}`, h('small', {}, ' mm')]),
      row('Major Ø', mmIn(s.D)),
      row('Minor Ø, basic', mmIn(s.minor)),
      ...s.clear.map((d, i) => row(`Clearance, ${s.clearLabels[i]}`,
        inch ? [s.clearNames[i], h('small', {}, ` · ${r3(d)} mm`)] : [`${g(d)}`, h('small', {}, ' mm')], i === s.clearUse ? 'use' : null)));
    read.append(dl);
  }

  function drawAll() {
    const fk = document.activeElement?.dataset?.h;
    if (D) {
      title.replaceChildren(D.sel.name, h('small', {}, `${D.sel.family}${D.sel.inch ? '' : ` · ${g(D.sel.P)} mm pitch`}`));
    }
    drawIndex(); drawSection(); drawPlan(); drawRead();
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    if (fk) root.querySelector(`[data-h="${fk}"]`)?.focus();
  }
  ctx.onResult((r) => {
    res = r; D = r?.draw || null;
    const raw = ctx.raw;
    if (document.activeElement !== filterIn) filterIn.value = raw.filter ?? '';
    if (document.activeElement !== engIn) engIn.value = raw.engagement ?? '';
    drawAll();
  });
  let rt = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rt); rt = requestAnimationFrame(drawAll); }).observe(root);
}
