// Silkscreen Legibility Check: the page is the legend under a loupe.
//   Loupe  - a patch of board (solder mask, pads of an 0402, an 0603 and a
//            SOT-23, their pad clearance) with the reference designators
//            printed at your height and stroke, drawn with a stroke font to
//            scale. Drag the cap line (or its grip) to set the height, drag
//            the grip on the R's stem to set the stroke. The fab's minimum
//            height is a line (a red band when the text is under it), strokes
//            under the fab's minimum print broken, counters that fill in are
//            ringed. Beside it the smallest text the fab prints legibly, and
//            in the corner the same patch at actual size.
//   Map    - height against stroke: the fab's limits as lines, the legible
//            wedge (4-10 : 1) and the ideal one (5-8 : 1) shaded, common sizes
//            as dots to click; drag your own dot.
// Every number drawn comes from run()'s result (result.legend, in mm).

const NS = 'http://www.w3.org/2000/svg';
const MIL = 0.0254;
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

// A small stroke font: cap height 1, y down, cell 0.6 wide, advance 0.8.
const GLYPH = {
  0: 'M0.3,0 A0.3,0.5 0 0 1 0.3,1 A0.3,0.5 0 0 1 0.3,0 Z',
  1: 'M0.12,0.2 L0.34,0 L0.34,1',
  2: 'M0.03,0.24 A0.28,0.25 0 0 1 0.58,0.26 C0.58,0.46 0.3,0.62 0.02,1 L0.6,1',
  3: 'M0.05,0 L0.56,0 L0.27,0.4 A0.3,0.3 0 1 1 0.02,0.86',
  4: 'M0.46,1 L0.46,0 L0,0.7 L0.6,0.7',
  5: 'M0.56,0 L0.1,0 L0.06,0.43 A0.3,0.3 0 1 1 0.02,0.87',
  6: 'M0.54,0.03 Q0.06,0.18 0.02,0.7 M0.02,0.7 A0.29,0.29 0 1 0 0.6,0.7 A0.29,0.29 0 1 0 0.02,0.7',
  7: 'M0,0 L0.6,0 L0.2,1',
  8: 'M0.3,0.47 A0.24,0.235 0 1 1 0.3,0 A0.24,0.235 0 1 1 0.3,0.47 Z M0.3,0.47 A0.29,0.265 0 1 0 0.3,1 A0.29,0.265 0 1 0 0.3,0.47 Z',
  9: 'M0.58,0.3 A0.29,0.29 0 1 0 0,0.3 A0.29,0.29 0 1 0 0.58,0.3 Q0.56,0.84 0.08,0.97',
  R: 'M0.05,1 L0.05,0 L0.33,0 A0.25,0.25 0 0 1 0.33,0.5 L0.05,0.5 M0.3,0.5 L0.6,1',
  C: 'M0.58,0.18 A0.3,0.5 0 1 0 0.58,0.82',
  Q: 'M0.3,0 A0.3,0.5 0 0 1 0.3,1 A0.3,0.5 0 0 1 0.3,0 Z M0.36,0.72 L0.62,1.02',
};
const ADV = 0.8;
// Counters (holes) that close first when the stroke is too heavy: [char index, cx, cy] in glyph units.
const COUNTERS = [[1, 0.3, 0.5], [2, 0.3, 0.235], [2, 0.3, 0.735]];

// Footprints to scale (mm), pads as [cx, cy, w, h] about the part centre.
const PARTS = [
  { ref: 'R108', fp: '0402', pads: [[-0.5, 0, 0.55, 0.6], [0.5, 0, 0.55, 0.6]], body: [1.0, 0.5] },
  { ref: 'C47', fp: '0603', pads: [[-0.8, 0, 0.9, 0.95], [0.8, 0, 0.9, 0.95]], body: [1.6, 0.8] },
  { ref: 'Q3', fp: 'SOT-23', pads: [[-0.95, 1.0, 0.6, 0.8], [0.95, 1.0, 0.6, 0.8], [0, -1.0, 0.6, 0.8]], body: [2.9, 1.3] },
];

const FABS = [['jlcpcb', 'JLCPCB'], ['pcbway', 'PCBWay'], ['generic', 'Generic'], ['fine', 'Fine inkjet'], ['custom', 'Custom']];
const FONTS = [['stroke', 'Stroke font'], ['ttf', 'TrueType'], ['ttfbold', 'TrueType bold']];

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let L = null;          // result.legend
  let res = null;
  let frozen = null;     // loupe transform kept while dragging
  let mapFrozen = null;  // map axes kept while dragging
  let pending = null;

  const isMil = () => ctx.input.units === 'mil';
  const toU = (mm) => (isMil() ? mm / MIL : mm);
  const uName = () => (isMil() ? 'mil' : 'mm');
  const show = (mm, d = 3) => ctx.fmtNum(toU(mm), d);
  const inStr = (mm) => String(Number(toU(mm).toFixed(isMil() ? 1 : 3)));
  // dragging snaps to a round value: 0.01 mm / 0.5 mil for height, 0.005 mm / 0.2 mil for stroke
  const snap = (mm, fine) => { const q = isMil() ? (fine ? 0.2 : 0.5) : (fine ? 0.005 : 0.01); return String(Number((Math.round(toU(mm) / q) * q).toFixed(3))); };
  const setSoon = (obj) => {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  };

  // ---------- controls ----------
  const seg = (label, items, key, onPick) => {
    const g = h('div', { class: 'ss-seg', role: 'radiogroup', 'aria-label': label });
    const pick = (v) => (onPick ? onPick(v) : ctx.set(key, v));
    const btns = items.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => pick(v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const n = items[clamp(items.findIndex((x) => x[0] === v) + d, 0, items.length - 1)][0];
        pick(n); requestAnimationFrame(() => g.querySelector(`[data-v="${n}"]`)?.focus());
      } }, t));
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => { const on = b.dataset.v === cur; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    return g;
  };
  const num = (key, label, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label, oninput: (e) => ctx.set(key, e.target.value) });
    const unit = h('small');
    const w = h('label', { class: 'ss-num', title: title || null }, h('span', {}, label), inp, unit);
    w.sync = (raw) => { if (document.activeElement !== inp) inp.value = raw ?? ''; unit.textContent = uName(); };
    w.inp = inp;
    return w;
  };
  const fabSeg = seg('Fab', FABS, 'fab');
  const fontSeg = seg('Font', FONTS, 'font');
  const unitSeg = seg('Units', [['mm', 'mm'], ['mil', 'mil']], 'units', (u) => {
    if (u === ctx.input.units) return;
    const f = u === 'mil' ? 1 / MIL : MIL, i = ctx.input, upd = { units: u };
    for (const k of ['height', 'stroke', 'minStroke', 'minHeight', 'clearance']) if (i[k] > 0) upd[k] = String(Number((i[k] * f).toFixed(u === 'mil' ? 1 : 3)));
    frozen = null; mapFrozen = null;
    ctx.setMany(upd);
  });
  const cMinStroke = num('minStroke', 'min line', 'Custom fab: minimum legend line width');
  const cMinHeight = num('minHeight', 'min height', 'Custom fab: minimum text height');
  const cClear = num('clearance', 'pad clearance', 'Custom fab: legend-to-pad clearance');
  const custom = h('div', { class: 'ss-custom' }, cMinStroke, cMinHeight, cClear);
  const bar = h('div', { class: 'ss-bar' },
    h('div', { class: 'ss-group' }, h('span', { class: 'ss-cap' }, 'Fab'), fabSeg, custom),
    h('div', { class: 'ss-group' }, h('span', { class: 'ss-cap' }, 'Font'), fontSeg),
    h('div', { class: 'ss-group' }, unitSeg));

  // loupe
  const fH = num('height', 'Text height', 'Text height (cap height)');
  const fW = num('stroke', 'Stroke', 'Stroke (line) width of the font');
  const ratioOut = h('span', { class: 'ss-ratio' });
  const verdictPill = h('span', { class: 'ss-pill' });
  const loupeSvg = sv(null, 'svg', { class: 'ss-loupe-svg', role: 'group', 'aria-label': 'The legend on the board, to scale. Drag the cap line to set the height, the grip on the stem to set the stroke.' });
  const loupeWarn = h('div', { class: 'ss-warns', 'aria-live': 'polite' });
  const loupe = h('section', { class: 'ss-card ss-loupe' },
    h('div', { class: 'ss-loupe-head' }, fH, fW, ratioOut, verdictPill,
      h('span', { class: 'ss-tip' }, 'Drag the cap line or the stem grip · arrow keys on a focused grip')),
    h('div', { class: 'ss-box' }, loupeSvg), loupeWarn);

  // side: verdict, map, outputs
  const verdict = h('div', { class: 'ss-verdict' });
  const facts = h('dl', { class: 'ss-facts' });
  const mapSvg = sv(null, 'svg', { class: 'ss-map-svg', role: 'group', 'aria-label': 'Text height against stroke width with the fab limits' });
  const side = h('aside', { class: 'ss-side' },
    h('div', { class: 'ss-card ss-read' }, verdict, facts),
    h('div', { class: 'ss-card ss-map' }, h('div', { class: 'ss-map-head' }, h('b', {}, 'Height against stroke'), h('span', {}, 'drag the dot · click a common size')),
      h('div', { class: 'ss-mapbox' }, mapSvg)),
    ctx.outputs);

  root.append(h('div', { class: 'ss' }, bar, loupe, side));

  // ---------- loupe drawing ----------
  function textWidth(n, H, W) { return (n - 1) * ADV * H + 0.6 * H + W; }

  function drawText(g, str, x, base, H, W, cls, broken) {
    const t = sv(g, 'g', { transform: `translate(${x} ${base - H}) scale(${H})`, class: cls });
    const sw = W / H;
    [...str].forEach((ch, i) => {
      const p = sv(t, 'path', { d: GLYPH[ch] || '', transform: `translate(${i * ADV + sw / 2} 0)`, 'stroke-width': sw });
      if (broken) p.setAttribute('stroke-dasharray', broken);
    });
    return t;
  }

  function drawLoupe() {
    loupeSvg.replaceChildren();
    if (!L) return;
    const box = loupeSvg.getBoundingClientRect();
    const Wpx = Math.max(280, box.width), Hpx = Math.max(220, box.height);
    loupeSvg.setAttribute('viewBox', `0 0 ${Wpx} ${Hpx}`);
    const H = L.h, W = L.w, F = L.fab, clear = F.clear || 0;
    // layout in mm: each part centred in its column, its refdes above it
    const narrow = Wpx < 560;
    const gapCol = Math.max(1.4, 1.0 * H);
    const cols = (narrow ? PARTS.slice(0, 1) : PARTS).map((p) => {
      const xs = p.pads.flatMap(([cx, , w]) => [cx - w / 2, cx + w / 2]);
      const ys = p.pads.flatMap(([, cy, , hh]) => [cy - hh / 2, cy + hh / 2]);
      const fpW = Math.max(...xs) - Math.min(...xs) + 2 * clear, tw = textWidth(p.ref.length, H, W);
      return { p, fpW, tw, width: Math.max(fpW, tw), top: Math.min(...ys) - clear, bottom: Math.max(...ys) + clear };
    });
    let x = 0;
    for (const c of cols) { c.cx = x + c.width / 2; x += c.width + gapCol; }
    const lift = 0.25;  // text bottom to the pad clearance
    for (const c of cols) c.base = c.top - lift - W / 2;
    const partsBot = Math.max(...cols.map((c) => c.bottom));
    // second row: the fab's smallest legible text
    const gh = L.minLegible, gw = F.stroke, gtw = textWidth(4, gh, gw);
    const gx = 0, gBase = partsBot + 1.1 + gh;
    const sceneW = Math.max(x - gapCol, gtw + (narrow ? 0 : 3.2));
    const sceneTop = Math.min(...cols.map((c) => c.base - H - W / 2)) - 0.15;
    const sceneBot = gBase + gw / 2 + 0.2;
    const flags = [];
    if (L.ratio < 4) flags.push(narrow ? 'counters fill in' : 'counters fill in (height : stroke under 4 : 1)');
    if (!L.wOk) flags.push(narrow ? 'stroke under min line' : L.font === 'stroke' ? `stroke under the ${F.name} minimum line: may break up` : `estimated stems under the ${F.name} minimum line`);
    if (L.ratio > 10) flags.push(narrow ? 'strokes thin for the size' : 'strokes thin for the size (over 10 : 1)');
    if (!L.hOk) flags.push(narrow ? 'under min height' : `text under the ${F.name} minimum height`);
    const padL = narrow ? 92 : 118, padR = narrow ? 14 : 24, padT = 40 + 16 * flags.length, padB = narrow ? 44 : 24;
    if (!frozen) {
      const k = Math.min((Wpx - padL - padR) / sceneW, (Hpx - padT - padB) / (sceneBot - sceneTop), 400);
      frozen = { k, ox: padL + Math.max(0, ((Wpx - padL - padR) - sceneW * k) / 2), oy: padT - sceneTop * k + Math.max(0, ((Hpx - padT - padB) - (sceneBot - sceneTop) * k) / 2) };
    }
    const { k, ox, oy } = frozen;
    const X = (mm) => ox + mm * k, Y = (mm) => oy + mm * k;

    sv(loupeSvg, 'rect', { x: 0, y: 0, width: Wpx, height: Hpx, class: 'ss-mask' });
    const scene = sv(loupeSvg, 'g', { transform: `translate(${ox} ${oy}) scale(${k})` });
    const drawParts = (g, withText) => {
      for (const c of cols) {
        const p = c.p;
        sv(g, 'rect', { x: c.cx - p.body[0] / 2, y: -p.body[1] / 2, width: p.body[0], height: p.body[1], class: 'ss-body' });
        for (const [cx, cy, w, hh] of p.pads) {
          if (clear) sv(g, 'rect', { x: c.cx + cx - w / 2 - clear, y: cy - hh / 2 - clear, width: w + 2 * clear, height: hh + 2 * clear, rx: clear, class: 'ss-keep' });
          sv(g, 'rect', { x: c.cx + cx - w / 2, y: cy - hh / 2, width: w, height: hh, rx: 0.03, class: 'ss-pad' });
        }
        if (withText) {
          const tx = c.cx - c.tw / 2;
          const broken = !L.wOk ? `${0.28} ${0.06 + 0.25 * (1 - W / F.stroke)}` : null;
          drawText(g, p.ref, tx, c.base, H, W, 'ss-ink', broken);
        }
      }
    };
    drawParts(scene, true);
    drawText(scene, 'R108', gx, gBase, gh, gw, 'ss-ghost');

    // --- annotations in px ---
    const ann = sv(loupeSvg, 'g', { class: 'ss-ann' });
    const c0 = cols[0], tx0 = c0.cx - c0.tw / 2;
    const base = c0.base, capY = base - H;
    const minY = base - F.height;
    const dimX = X(tx0) - 18, x1px = X(tx0 + c0.tw) + 8;
    // fab min height: a line, a red band when the text is short of it
    if (!L.hOk) sv(ann, 'rect', { x: X(tx0) - 4, y: Y(minY), width: X(tx0 + c0.tw) - X(tx0) + 8, height: Y(capY) - Y(minY), class: 'ss-short' });
    sv(ann, 'line', { x1: dimX - 6, x2: x1px, y1: Y(minY), y2: Y(minY), class: L.hOk ? 'ss-lim' : 'ss-lim bad' });
    sv(ann, 'line', { x1: dimX - 6, x2: x1px, y1: Y(base), y2: Y(base), class: 'ss-ext' });
    // height: dimension on the left, the cap line is the handle
    sv(ann, 'line', { x1: dimX, x2: dimX, y1: Y(capY), y2: Y(base), class: 'ss-dim' });
    sv(ann, 'path', { d: `M${dimX - 4},${Y(base) - 7} L${dimX},${Y(base)} L${dimX + 4},${Y(base) - 7}`, class: 'ss-dim' });
    const hLab = sv(ann, 'text', { x: dimX - 10, y: Math.min(Y(capY), Y(minY)) + 12, 'text-anchor': 'end', class: `ss-t ${L.hOk ? 'ss-strong' : 'ss-strong ss-badv'}` }, `${show(H)} ${uName()}`);
    hLab.append(sv(null, 'tspan', { x: dimX - 10, dy: 14, class: L.hOk ? 'ss-soft' : 'ss-soft ss-badv' }, `min ${show(F.height)}`));
    const capH = sv(ann, 'g', { class: 'ss-h', tabindex: 0, role: 'slider', 'aria-label': 'Text height', 'aria-valuenow': show(H), 'aria-valuetext': `${show(H)} ${uName()}`, 'data-h': 'height' });
    sv(capH, 'line', { x1: dimX - 6, x2: x1px, y1: Y(capY), y2: Y(capY), class: 'ss-hit' });
    sv(capH, 'line', { x1: dimX, x2: x1px, y1: Y(capY), y2: Y(capY), class: 'ss-capline' });
    sv(capH, 'circle', { cx: dimX, cy: Y(capY), r: 6, class: 'ss-grip' });
    sv(capH, 'path', { d: `M${dimX - 3},${Y(capY) - 1} L${dimX},${Y(capY) - 4} L${dimX + 3},${Y(capY) - 1} M${dimX - 3},${Y(capY) + 1} L${dimX},${Y(capY) + 4} L${dimX + 3},${Y(capY) + 1}`, class: 'ss-griparrow' });

    // stroke: a leader from the left margin to the R's stem, grip on its right edge
    const stemX = tx0 + W / 2 + 0.05 * H, sy = base - 0.22 * H;
    const sL = X(stemX - W / 2), sR = X(stemX + W / 2);
    const labX = dimX - 10;
    sv(ann, 'line', { x1: labX + 4, x2: sL, y1: Y(sy), y2: Y(sy), class: 'ss-dim' });
    sv(ann, 'path', { d: `M${sL - 7},${Y(sy) - 4} L${sL},${Y(sy)} L${sL - 7},${Y(sy) + 4}`, class: 'ss-dim' });
    const sLab = sv(ann, 'text', { x: labX, y: Y(sy) - 2, 'text-anchor': 'end', class: `ss-t ${L.wOk ? 'ss-strong' : 'ss-strong ss-badv'}` },
      `${L.font === 'stroke' ? '' : '≈'}${show(W)} ${uName()}`);
    sLab.append(sv(null, 'tspan', { x: labX, dy: 14, class: L.wOk ? 'ss-soft' : 'ss-soft ss-badv' }, `min ${show(F.stroke)}`));
    const on = L.font === 'stroke';
    const stH = sv(ann, 'g', { class: `ss-h${on ? '' : ' off'}`, tabindex: on ? 0 : -1, role: 'slider', 'aria-label': 'Stroke width',
      'aria-valuenow': show(W), 'aria-valuetext': `${show(W)} ${uName()}`, 'aria-disabled': on ? null : 'true', 'data-h': 'stroke' });
    sv(stH, 'circle', { cx: sR + 9, cy: Y(sy), r: 12, class: 'ss-hit' });
    sv(stH, 'line', { x1: sR, x2: sR + 9, y1: Y(sy), y2: Y(sy), class: 'ss-dim' });
    sv(stH, 'circle', { cx: sR + 9, cy: Y(sy), r: 5.5, class: 'ss-grip' });
    sv(stH, 'path', { d: `M${sR + 8},${Y(sy) - 3} L${sR + 5},${Y(sy)} L${sR + 8},${Y(sy) + 3} M${sR + 10},${Y(sy) - 3} L${sR + 13},${Y(sy)} L${sR + 10},${Y(sy) + 3}`, class: 'ss-griparrow' });

    // problems: numbered marks where they are, their words top left
    const mark = (n, px, py) => {
      const g = sv(ann, 'g', { class: 'ss-flag' });
      sv(g, 'circle', { cx: px, cy: py, r: 8 });
      sv(g, 'text', { x: px, y: py + 4, 'text-anchor': 'middle' }, String(n));
    };
    let n = 0;
    if (L.ratio < 4) {
      n += 1;
      for (const [ci, cx, cy] of COUNTERS) {
        const gx0 = tx0 + W / 2 + ci * ADV * H;
        sv(ann, 'ellipse', { cx: X(gx0 + cx * H), cy: Y(base - H + cy * H), rx: 0.2 * H * k + 3, ry: (ci === 1 ? 0.36 : 0.17) * H * k + 3, class: 'ss-ring' });
      }
      mark(n, X(tx0 + W / 2 + 2 * ADV * H + 0.3 * H), Y(capY) - 12);
    }
    if (L.ratio > 10) { n += 1; mark(n, X(tx0 + c0.tw) + 14, Y(base - 0.5 * H)); }
    // the list: numbered when a mark on the drawing points at it, else the red label is the mark
    let num = 0;
    flags.forEach((t, i) => {
      const y = 40 + i * 16;
      const numbered = /counters|thin for the size/.test(t);
      const g = sv(ann, 'g', { class: 'ss-flag' });
      sv(g, 'circle', { cx: 20, cy: y - 4, r: 6.5 });
      sv(g, 'text', { x: 20, y: y, 'text-anchor': 'middle', style: 'font-size:9.5px' }, numbered ? String(++num) : '!');
      sv(ann, 'text', { x: 32, y, class: 'ss-t ss-bad' }, t + (numbered || narrow ? '' : ' (red on the drawing)'));
    });

    // captions
    for (const c of cols) sv(ann, 'text', { x: X(c.cx), y: Y(c.bottom) + 15, 'text-anchor': 'middle', class: 'ss-t ss-cap2' }, c.p.fp);
    const gcx = narrow ? X(gx) : X(gx + gtw) + 14, gcy = narrow ? Y(gBase) + 18 : Y(gBase - gh / 2);
    sv(ann, 'text', { x: gcx, y: gcy - 3, class: 'ss-t ss-cap2' }, `smallest legible at ${F.name}`);
    sv(ann, 'text', { x: gcx, y: gcy + 12, class: 'ss-t ss-cap2' }, `${show(gh)} high, ${show(gw)} stroke`);

    // scale bar and key
    const barMm = isMil() ? 40 * MIL : 1; // 1 mm or 40 mil
    sv(ann, 'line', { x1: 14, x2: 14 + barMm * k, y1: 16, y2: 16, class: 'ss-scale' });
    sv(ann, 'text', { x: 20 + barMm * k, y: 20, class: 'ss-t ss-cap2' },
      `${isMil() ? '40 mil' : '1 mm'} · ${ctx.fmtNum(k / (96 / 25.4), 2)}× on screen${clear && !narrow ? ` · dashed: keep legend ${show(clear)} off pads` : ''}`);

    // actual size inset (CSS px: 96 per inch)
    const k1 = 96 / 25.4, iw = Math.max(84, sceneW * k1 + 16), ih = (sceneBot - sceneTop) * k1 + 22;
    if (!narrow && iw < Wpx * 0.4) {
      const ix = Wpx - iw - 10, iy = Hpx - ih - 10;
      const inset = sv(loupeSvg, 'g', { class: 'ss-inset' });
      sv(inset, 'rect', { x: ix, y: iy, width: iw, height: ih, rx: 3, class: 'ss-inset-bg' });
      sv(inset, 'text', { x: ix + 6, y: iy + 11, class: 'ss-t ss-cap3' }, 'actual size');
      const g1 = sv(inset, 'g', { transform: `translate(${ix + 8} ${iy + 16 - sceneTop * k1}) scale(${k1})` });
      drawParts(g1, true);
      drawText(g1, 'R108', gx, gBase, gh, gw, 'ss-ghost');
    }
  }

  // ---------- map ----------
  function drawMap() {
    mapSvg.replaceChildren();
    if (!L) return;
    const box = mapSvg.getBoundingClientRect();
    const Wpx = Math.max(240, box.width), Hpx = Math.max(180, box.height);
    mapSvg.setAttribute('viewBox', `0 0 ${Wpx} ${Hpx}`);
    const F = L.fab;
    if (!mapFrozen) {
      const xm = Math.max(0.36, L.w * 1.2, F.stroke * 2.1), ym = Math.max(2.3, L.h * 1.2, L.minLegible * 1.4);
      mapFrozen = { xm, ym };
    }
    const { xm, ym } = mapFrozen;
    const m = { l: 40, r: 14, t: 10, b: 30 };
    const X = (w) => m.l + (w / xm) * (Wpx - m.l - m.r), Y = (hh) => Hpx - m.b - (hh / ym) * (Hpx - m.t - m.b);
    const id = `ssclip${Math.random().toString(36).slice(2, 7)}`;
    const defs = sv(mapSvg, 'defs');
    const clip = sv(defs, 'clipPath', { id });
    sv(clip, 'rect', { x: X(F.stroke), y: m.t, width: Math.max(0, X(xm) - X(F.stroke)), height: Math.max(0, Y(F.height) - m.t) });
    const wedge = (a, b) => `M${X(0)},${Y(0)} L${X(Math.min(xm, ym / a))},${Y(Math.min(ym, xm * a))} L${X(xm)},${Y(Math.min(ym, xm * a))} L${X(xm)},${Y(Math.min(ym, xm * b))} Z`;
    // grid
    const g = sv(mapSvg, 'g', { class: 'ss-grid' });
    const nice = (span) => { const r = span / 5, p = 10 ** Math.floor(Math.log10(r)), f = r / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; };
    const mm = isMil() ? MIL : 1;
    const xStep = nice(toU(xm)), yStep = nice(toU(ym));
    for (let i = 0; i * xStep <= toU(xm) + 1e-9; i++) {
      const v = i * xStep * mm;
      sv(g, 'line', { x1: X(v), x2: X(v), y1: m.t, y2: Hpx - m.b });
      if (i % 2 === 0) sv(mapSvg, 'text', { x: X(v), y: Hpx - m.b + 13, 'text-anchor': 'middle', class: 'ss-ax' }, ctx.fmtNum(i * xStep, 3));
    }
    for (let i = 0; i * yStep <= toU(ym) + 1e-9; i++) {
      const v = i * yStep * mm;
      sv(g, 'line', { x1: m.l, x2: Wpx - m.r, y1: Y(v), y2: Y(v) });
      if (i % 2 === 0) sv(mapSvg, 'text', { x: m.l - 5, y: Y(v) + 3, 'text-anchor': 'end', class: 'ss-ax' }, ctx.fmtNum(i * yStep, 3));
    }
    sv(mapSvg, 'text', { x: Wpx - m.r, y: Hpx - 4, 'text-anchor': 'end', class: 'ss-ax' }, `stroke, ${uName()} →`);
    sv(mapSvg, 'text', { x: 4, y: m.t + 2, class: 'ss-ax', transform: `rotate(-90 ${4} ${m.t + 2})`, 'text-anchor': 'end', dy: 8 }, `height, ${uName()} →`);
    // regions
    sv(mapSvg, 'path', { d: wedge(10, 4), class: 'ss-zone', 'clip-path': `url(#${id})` });
    sv(mapSvg, 'path', { d: wedge(8, 5), class: 'ss-zone2', 'clip-path': `url(#${id})` });
    for (const [r, t] of [[4, '4:1'], [5, '5'], [8, '8'], [10, '10:1']]) {
      const xe = Math.min(xm, ym / r), ye = xe * r;
      sv(mapSvg, 'line', { x1: X(0), y1: Y(0), x2: X(xe), y2: Y(ye), class: 'ss-ray' });
      sv(mapSvg, 'text', { x: X(xe) + (ye >= ym - 1e-9 ? 0 : -4), y: Y(ye) + (ye >= ym - 1e-9 ? 10 : -4), 'text-anchor': ye >= ym - 1e-9 ? 'middle' : 'end', class: 'ss-ax' }, t);
    }
    // fab limits
    sv(mapSvg, 'line', { x1: X(F.stroke), x2: X(F.stroke), y1: m.t, y2: Hpx - m.b, class: 'ss-flim' });
    sv(mapSvg, 'line', { x1: m.l, x2: Wpx - m.r, y1: Y(F.height), y2: Y(F.height), class: 'ss-flim' });
    sv(mapSvg, 'text', { x: X(F.stroke) + 4, y: Hpx - m.b - 5, class: 'ss-ax ss-fl' }, `min line ${show(F.stroke)}`);
    sv(mapSvg, 'text', { x: Wpx - m.r - 3, y: Y(F.height) - 4, 'text-anchor': 'end', class: 'ss-ax ss-fl' }, `min height ${show(F.height)}`);
    // common sizes
    for (const s of L.sizes) {
      if (s.w > xm || s.h > ym) continue;
      const d = sv(mapSvg, 'g', { class: `ss-size ${s.ok ? 'ok' : 'no'}`, tabindex: 0, role: 'button',
        'aria-label': `Use ${show(s.h)} ${uName()} text with ${show(s.w)} stroke${s.ok ? '' : ' (not legible here)'}` });
      sv(d, 'title', {}, `${show(s.h)} / ${show(s.w)} ${uName()} · ${s.ok ? 'prints legibly' : 'not at this fab'} · click to use`);
      sv(d, 'circle', { cx: X(s.w), cy: Y(s.h), r: 9, class: 'ss-hit' });
      sv(d, 'circle', { cx: X(s.w), cy: Y(s.h), r: 4 });
      const use = () => ctx.setMany({ height: inStr(s.h), stroke: inStr(s.w), font: 'stroke' });
      d.addEventListener('click', use);
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); use(); } });
    }
    // you
    const cx = X(Math.min(L.w, xm)), cy = Y(Math.min(L.h, ym));
    const tone = L.pass ? (L.good ? 'ok' : 'warn') : 'bad';
    const me = sv(mapSvg, 'g', { class: `ss-me ${tone}`, tabindex: 0, role: 'slider', 'aria-label': 'Height and stroke: arrow up and down for height, left and right for stroke',
      'aria-valuetext': `${show(L.h)} by ${show(L.w)} ${uName()}`, 'data-h': 'map' });
    sv(me, 'line', { x1: cx, x2: cx, y1: cy, y2: Hpx - m.b, class: 'ss-drop' });
    sv(me, 'line', { x1: m.l, x2: cx, y1: cy, y2: cy, class: 'ss-drop' });
    sv(me, 'circle', { cx, cy, r: 14, class: 'ss-hit' });
    sv(me, 'circle', { cx, cy, r: 7 });
    const right = cx > Wpx - 80;
    sv(mapSvg, 'text', { x: right ? cx - 10 : cx + 10, y: cy - 8, 'text-anchor': right ? 'end' : 'start', class: 'ss-ax ss-me-t halo' }, `${ctx.fmtNum(L.ratio, 3)} : 1`);
    mapSvg._X = { X, Y, m, Wpx, Hpx, xm, ym };
  }

  // ---------- read-outs ----------
  function drawRead() {
    const v = res?.values || [];
    if (!v.length || !L) {
      verdict.replaceChildren(h('b', { class: 'bad' }, 'No result'));
      facts.replaceChildren();
      verdictPill.textContent = ''; ratioOut.textContent = '';
      return;
    }
    const tone = v[0].tone;
    verdict.replaceChildren(h('span', {}, `At ${L.fab.name}`), h('b', { class: tone }, v[0].value));
    verdictPill.className = `ss-pill ${tone}`;
    verdictPill.textContent = v[0].value;
    ratioOut.innerHTML = '';
    ratioOut.append('ratio ', h('b', {}, v.find((x) => /Height : stroke/.test(x.label))?.value || ''));
    const rows = v.slice(1).map((x) => {
      const dd = h('dd', { class: x.tone || '' }, x.value, x.hint ? h('small', {}, x.hint) : null);
      if (/Suggested stroke/.test(x.label) && L.font === 'stroke' && Math.abs(L.suggestStroke - L.w) > 1e-4) {
        dd.append(h('button', { type: 'button', class: 'ss-apply', onclick: () => ctx.set('stroke', inStr(L.suggestStroke)) }, 'Use'));
      }
      if (/Smallest legible/.test(x.label) && Math.abs(L.minLegible - L.h) > 1e-4 && !L.hOk) {
        dd.append(h('button', { type: 'button', class: 'ss-apply', onclick: () => ctx.setMany({ height: inStr(L.minLegible), stroke: inStr(Math.max(L.fab.stroke, L.minLegible / 6)) }) }, 'Use'));
      }
      return [h('dt', {}, x.label), dd];
    });
    facts.replaceChildren(...rows.flat());
  }

  function sync(input) {
    const raw = ctx.raw;
    fabSeg.sync(raw.fab); fontSeg.sync(raw.font); unitSeg.sync(raw.units === 'mil' ? 'mil' : 'mm');
    custom.hidden = raw.fab !== 'custom';
    for (const [f, k] of [[cMinStroke, 'minStroke'], [cMinHeight, 'minHeight'], [cClear, 'clearance'], [fH, 'height'], [fW, 'stroke']]) f.sync(raw[k]);
    fW.inp.disabled = raw.font !== 'stroke';
    fW.classList.toggle('off', raw.font !== 'stroke');
    for (const [f, k] of [[fH, 'height'], [fW, 'stroke']]) f.inp.classList.toggle('bad', String(raw[k] ?? '').trim() !== '' && !(input[k] > 0));
  }

  function render() {
    L = res?.legend || null;
    if (!drag) frozen = null;
    if (!mdrag) mapFrozen = null;
    sync(ctx.input);
    drawRead();
    drawLoupe();
    drawMap();
    const w = res?.warnings || [];
    loupeWarn.replaceChildren(...w.map((t) => h('div', {}, t)));
    loupeWarn.hidden = !w.length;
  }
  ctx.onResult((r) => { res = r; render(); });

  // ---------- dragging ----------
  function pointerMm(svg, e) {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    return { x: (e.clientX - r.left) * (vb.width / r.width), y: (e.clientY - r.top) * (vb.height / r.height) };
  }
  let drag = null;
  loupeSvg.addEventListener('pointerdown', (e) => {
    const hnd = e.target.closest('.ss-h');
    if (!hnd || !L || hnd.classList.contains('off')) return;
    e.preventDefault();
    hnd.focus({ preventScroll: true });
    loupeSvg.setPointerCapture(e.pointerId);
    drag = { kind: hnd.dataset.h, startH: L.h, startW: L.w, p0: pointerMm(loupeSvg, e) };
    loupeSvg.classList.add('dragging');
  });
  loupeSvg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pointerMm(loupeSvg, e), k = frozen.k;
    if (drag.kind === 'height') {
      const hh = clamp(drag.startH - (p.y - drag.p0.y) / k, 0.2, 6);
      setSoon({ height: snap(hh) });
    } else {
      const ww = clamp(drag.startW + 2 * (p.x - drag.p0.x) / k, 0.02, Math.max(0.05, L.h / 2));
      setSoon({ stroke: snap(ww, true) });
    }
  });
  const endDrag = () => { if (!drag) return; drag = null; loupeSvg.classList.remove('dragging'); requestAnimationFrame(render); };
  loupeSvg.addEventListener('pointerup', endDrag);
  loupeSvg.addEventListener('pointercancel', endDrag);

  const stepMm = (e) => (isMil() ? (e.shiftKey ? 5 : 0.5) * MIL : (e.shiftKey ? 0.1 : 0.01));
  loupeSvg.addEventListener('keydown', (e) => {
    const hnd = e.target.closest?.('.ss-h');
    if (!hnd || !L || hnd.classList.contains('off')) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const kind = hnd.dataset.h;
    if (kind === 'height') ctx.set('height', inStr(clamp(L.h + d * stepMm(e), 0.1, 10)));
    else ctx.set('stroke', inStr(clamp(L.w + d * stepMm(e) / 2, 0.01, 2)));
    requestAnimationFrame(() => loupeSvg.querySelector(`[data-h="${kind}"]`)?.focus());
  });

  let mdrag = null;
  mapSvg.addEventListener('pointerdown', (e) => {
    const me = e.target.closest('.ss-me');
    if (!me || !L) return;
    e.preventDefault();
    me.focus({ preventScroll: true });
    mapSvg.setPointerCapture(e.pointerId);
    mdrag = true;
    mapSvg.classList.add('dragging');
  });
  mapSvg.addEventListener('pointermove', (e) => {
    if (!mdrag || !mapSvg._X) return;
    const { m, Wpx, Hpx, xm, ym } = mapSvg._X;
    const p = pointerMm(mapSvg, e);
    const w = clamp((p.x - m.l) / (Wpx - m.l - m.r) * xm, 0.02, xm);
    const hh = clamp((Hpx - m.b - p.y) / (Hpx - m.t - m.b) * ym, 0.1, ym);
    if (L.font === 'stroke') setSoon({ height: snap(hh), stroke: snap(w, true) });
    else setSoon({ height: snap(hh) });
  });
  const endM = () => { if (!mdrag) return; mdrag = null; mapSvg.classList.remove('dragging'); requestAnimationFrame(render); };
  mapSvg.addEventListener('pointerup', endM);
  mapSvg.addEventListener('pointercancel', endM);
  mapSvg.addEventListener('keydown', (e) => {
    if (!e.target.closest?.('.ss-me') || !L) return;
    const dh = { ArrowUp: 1, ArrowDown: -1 }[e.key], dw = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!dh && !dw) return;
    e.preventDefault();
    if (dh) ctx.set('height', inStr(clamp(L.h + dh * stepMm(e), 0.1, 10)));
    else if (L.font === 'stroke') ctx.set('stroke', inStr(clamp(L.w + dw * stepMm(e) / 2, 0.01, 2)));
    mapFrozen = null;
    requestAnimationFrame(() => mapSvg.querySelector('.ss-me')?.focus());
  });

  // ---------- size ----------
  let rz = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (!drag) frozen = null; if (!mdrag) mapFrozen = null; drawLoupe(); drawMap(); }); })
    .observe(loupeSvg.parentElement);
}
