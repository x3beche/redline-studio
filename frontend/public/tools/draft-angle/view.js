// Draft Angle Checker: the page is the wall in its mould. A half-section of a
// moulded cup on its core, depth to scale, with the drafted face you tilt by
// dragging its top corner and the wall depth you pull up and down. The
// angles that stick, only just release and release well are shaded as a fan
// from the foot of the face. Every number drawn comes from run()'s result
// (result.draw and result.values).

const NS = 'http://www.w3.org/2000/svg';
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
const n3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(3))));
const niceCeil = (v) => {
  const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};

const PROCS = [
  ['injection', 'Injection moulding', 'thermoplastic'],
  ['die', 'Die casting', 'NADCA'],
  ['sand', 'Sand casting', ''],
  ['investment', 'Investment casting', ''],
  ['silicone', 'Urethane in silicone', ''],
  ['vac-male', 'Vacuum forming, male', 'plug'],
  ['vac-female', 'Vacuum forming, female', 'cavity'],
  ['compression', 'Rubber / compression', ''],
];
const FINISHES = [
  ['spi-a', 'SPI A', 'diamond polish'], ['spi-b', 'SPI B', 'paper polish'], ['spi-c', 'SPI C', 'stone'],
  ['spi-d', 'SPI D', 'bead blast'], ['texture', 'Texture', 'etched'],
];
const ALLOYS = [['al', 'Al'], ['zn', 'Zn'], ['mg', 'Mg'], ['cu', 'Cu / brass']];
const WALLS = [['inside', 'Inside wall'], ['outside', 'Outside wall'], ['hole', 'Cored hole']];

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let res = null, D = null;
  let scaleDepth = null;      // the depth the vertical scale is fitted to; held while dragging
  let dragging = null;        // 'draft' | 'depth'
  let focusAfter = null;

  // ---------- radio helpers ----------
  const radios = (group, items, cur, pick, render) => {
    group.replaceChildren(...items.map(([v, ...rest]) => {
      const on = String(v) === String(cur);
      const b = render(v, rest, on);
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
      b.dataset.v = v;
      b.addEventListener('click', () => pick(v));
      b.addEventListener('keydown', (e) => {
        const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const i = items.findIndex((it) => String(it[0]) === String(v));
        const nv = items[clamp(i + d, 0, items.length - 1)][0];
        pick(nv);
        requestAnimationFrame(() => group.querySelector(`[data-v="${CSS.escape(nv)}"]`)?.focus());
      });
      return b;
    }));
  };

  // ---------- stage ----------
  const numField = (key, label, unit) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label} ${unit}`,
      oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'da-num' }, h('span', {}, label), inp, h('small', {}, unit));
    w.sync = (v, bad) => { if (document.activeElement !== inp) inp.value = v ?? ''; inp.classList.toggle('da-bad', !!bad); };
    return w;
  };
  const draftF = numField('draft', 'Your draft', '° per side');
  const depthF = numField('depth', 'Wall depth', 'mm');
  const useRec = h('button', { type: 'button', class: 'da-link', onclick: () => {
    const rec = D?.rec; if (rec != null) ctx.set('draft', String(Math.ceil(rec * 20 - 1e-6) / 20));
  } }, 'use recommended');
  const clearDraft = h('button', { type: 'button', class: 'da-link', onclick: () => ctx.set('draft', '') }, 'clear');
  const verdict = h('span', { class: 'da-verdict', 'aria-live': 'polite' });
  const svg = sv(null, 'svg', { role: 'group', 'aria-label': 'Half-section of the moulded wall on its core' });
  const foot = h('div', { class: 'da-foot', 'aria-live': 'polite' });
  const stage = h('section', { class: 'da-stage' },
    h('div', { class: 'da-head' }, draftF, depthF, useRec, clearDraft, verdict),
    h('div', { class: 'da-box' }, svg), foot);

  // ---------- side ----------
  const procList = h('div', { role: 'radiogroup', 'aria-label': 'Process', class: 'da-proclist' });
  const procs = h('div', { class: 'da-card da-procs' }, h('div', { class: 'da-cap' }, 'Process'), procList);
  const surf = h('div', { class: 'da-card da-surf' });
  const side = h('aside', { class: 'da-side' }, procs, surf, ctx.outputs);
  root.append(h('div', { class: 'da' }, stage, side));

  // swatch pictures: how the steel surface of each finish looks, schematically
  const swatch = (v) => {
    const s = sv(null, 'svg', { viewBox: '0 0 60 30', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    sv(s, 'rect', { width: 60, height: 30, class: 'da-sw-bg' });
    if (v === 'spi-a') { sv(s, 'line', { x1: 6, y1: 24, x2: 22, y2: 8, class: 'da-sw-ln' }); sv(s, 'line', { x1: 12, y1: 26, x2: 26, y2: 12, class: 'da-sw-ln' }); }
    if (v === 'spi-b') for (let i = 0; i < 12; i++) sv(s, 'line', { x1: 0, y1: 3 + i * 2.4, x2: 60, y2: 2 + i * 2.4, class: 'da-sw-ln' });
    if (v === 'spi-c') for (let i = 0; i < 16; i++) sv(s, 'line', { x1: -10 + i * 5, y1: 30, x2: i * 5, y2: 0, class: 'da-sw-ln' });
    if (v === 'spi-d') { let seed = 7; const r = () => (seed = (seed * 9301 + 49297) % 233280) / 233280; for (let i = 0; i < 90; i++) sv(s, 'circle', { cx: r() * 60, cy: r() * 30, r: 0.7, class: 'da-sw-dot' }); }
    if (v === 'texture') { let seed = 3; const r = () => (seed = (seed * 9301 + 49297) % 233280) / 233280; for (let i = 0; i < 16; i++) sv(s, 'ellipse', { cx: r() * 60, cy: r() * 30, rx: 2 + r() * 4, ry: 1.5 + r() * 2.5, class: 'da-sw-dot', opacity: 0.8 }); }
    return s;
  };

  function drawSide() {
    const raw = ctx.raw;
    radios(procList, PROCS, raw.process, (v) => ctx.set('process', v),
      (v, [name, sub]) => h('button', { type: 'button', class: 'da-proc' }, h('span', {}, name), sub ? h('small', {}, sub) : null));
    surf.replaceChildren();
    if (raw.process === 'injection') {
      const g = h('div', { class: 'da-swatches', role: 'radiogroup', 'aria-label': 'Surface finish' });
      radios(g, FINISHES, raw.finish, (v) => ctx.set('finish', v),
        (v, [name, sub]) => h('button', { type: 'button', class: 'da-sw', title: `${name}, ${sub}` }, swatch(v), h('b', {}, name), h('span', {}, sub)));
      surf.append(h('div', { class: 'da-cap' }, 'Surface of the steel'), g);
      if (raw.finish === 'texture') {
        const tv = Number(ctx.input.texture) || 0;
        const range = h('input', { type: 'range', min: 5, max: 150, step: 1, value: clamp(tv, 5, 150), 'aria-label': 'Texture depth, µm',
          oninput: (e) => { focusAfter = 'range'; ctx.set('texture', e.target.value); } });
        const num = h('input', { type: 'text', inputmode: 'decimal', value: raw.texture ?? '', class: 'da-tex', 'aria-label': 'Texture depth µm',
          style: 'width:52px;padding:3px 6px;border:1px solid var(--line);border-radius:4px;background:var(--sunken);font:12.5px \'IBM Plex Mono\',ui-monospace,monospace;text-align:right',
          oninput: (e) => { focusAfter = 'tex'; ctx.set('texture', e.target.value); } });
        surf.append(h('div', { class: 'da-row' }, h('span', {}, 'Texture depth'), range, num, h('span', {}, 'µm')));
      }
    } else if (raw.process === 'die') {
      const a = h('div', { class: 'da-seg', role: 'radiogroup', 'aria-label': 'Alloy' });
      radios(a, ALLOYS, raw.alloy, (v) => ctx.set('alloy', v), (v, [name]) => h('button', { type: 'button' }, name));
      const w = h('div', { class: 'da-seg', role: 'radiogroup', 'aria-label': 'Wall type' });
      radios(w, WALLS, raw.wall, (v) => ctx.set('wall', v), (v, [name]) => h('button', { type: 'button' }, name));
      surf.append(h('div', { class: 'da-cap' }, 'Alloy and wall (NADCA)'), h('div', { class: 'da-row' }, a), h('div', { class: 'da-row' }, w),
        h('p', { class: 'da-note' }, 'The inside wall shrinks onto the core and needs the most draft; NADCA draft falls as the wall gets deeper.'));
    } else {
      surf.append(h('div', { class: 'da-cap' }, 'Rule of thumb'), h('p', { class: 'da-note' }, res?.notes?.[0] || ''));
    }
    if (focusAfter === 'range') surf.querySelector('input[type=range]')?.focus();
    if (focusAfter === 'tex') { const t = surf.querySelector('.da-tex'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
    focusAfter = focusAfter === 'range' || focusAfter === 'tex' ? null : focusAfter;
  }

  // ---------- the drawing ----------
  function drawStage() {
    const keep = focusAfter || document.activeElement?.getAttribute?.('data-h');
    svg.replaceChildren();
    const W = Math.max(300, svg.clientWidth || 800), H = Math.max(320, svg.clientHeight || 560);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!D) {
      sv(svg, 'text', { x: 20, y: 40, class: 'da-t da-t-soft' }, res?.warnings?.[0] || 'Give the wall depth.');
      return;
    }
    const narrow = W < 560;
    const depth = D.depth;
    if (!dragging && (scaleDepth == null || depth > scaleDepth * 0.97 || depth < scaleDepth * 0.35)) scaleDepth = depth * 1.12;
    const mL = narrow ? 18 : 46, mR = narrow ? 64 : 150, mT = narrow ? 58 : 60, mB = narrow ? 92 : 78;
    const tw = clamp((H - mT - mB) * 0.06, 12, 24);          // wall thickness, drawn (not an input)
    const sy = (H - mT - mB - tw) / scaleDepth;                // px per mm, vertical
    const yb = H - mB, yt = yb - depth * sy;
    const xa = mL, xR = W - mR;
    const xf = xa + (xR - xa) * (narrow ? 0.64 : 0.66);         // face foot of the core
    // Offsets are a few tenths of a millimetre: draw them exaggerated, with the
    // factor written on the page.
    const need = Math.max(D.offsetRec, D.offsetDraft || 0, depth * Math.tan((3 * Math.PI) / 180));
    const room = (xf - xa) * 0.62;
    const EX = [100, 50, 20, 10, 5, 2, 1].find((e) => need * sy * e <= room) || 1;
    const kx = sy * EX;                                         // px per mm, horizontal offsets
    const outer = ctx.raw.process === 'die' && ctx.raw.wall === 'outside';
    const hole = ctx.raw.process === 'die' && ctx.raw.wall === 'hole';
    const off = D.offsetDraft ?? D.offsetRec;
    const offPx = off * kx;
    const slope = offPx / (yb - yt || 1);
    const pivotX = outer ? xf + tw : xf;
    const faceTopX = pivotX - offPx;
    const outTopY = yt - tw;
    const outTopX = xf + tw - slope * (yb - outTopY);
    const coreBase = yb + Math.min(40, mB - 30);

    // hatches and markers
    const defs = sv(svg, 'defs');
    const pt = sv(defs, 'pattern', { id: 'da-hatch', patternUnits: 'userSpaceOnUse', width: 8, height: 8, patternTransform: 'rotate(45)' });
    sv(pt, 'rect', { width: 8, height: 8, class: 'da-hs-bg' }); sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'da-hs-ln' });
    const pt2 = sv(defs, 'pattern', { id: 'da-hatch2', patternUnits: 'userSpaceOnUse', width: 8, height: 8, patternTransform: 'rotate(-45)' });
    sv(pt2, 'rect', { width: 8, height: 8, class: 'da-hk-bg' }); sv(pt2, 'line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'da-hs-ln' });
    const mk = sv(defs, 'marker', { id: 'da-ar', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,0 L10,5 L0,10 z', class: 'da-ah' });
    const P = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('') + 'Z';

    // steel: core (below and inside), cavity (above and outside)
    const cavTop = Math.max(8, outTopY - Math.max(26, (mT - 8) * 0.6));
    sv(svg, 'path', { d: P([[xa, yt], [faceTopX + (outer ? tw : 0) - (outer ? slope * 0 : 0) - (outer ? tw : 0) + (outer ? 0 : 0), yt], [xf, yb], [xR, yb], [xR, coreBase], [xa, coreBase]]), class: 'da-steel', fill: 'url(#da-hatch)' });
    sv(svg, 'path', { d: P([[xa, cavTop], [xR, cavTop], [xR, yb], [xf + tw, yb], [outTopX, outTopY], [xa, outTopY]]), class: 'da-steel', fill: 'url(#da-hatch2)' });
    // labels on the steel
    const tagBg = (x, y, text, cls, anchor = 'start') => {
      const t = sv(svg, 'text', { x, y, class: `da-t ${cls || ''}`, 'text-anchor': anchor }, text);
      const b = t.getBBox?.();
      if (b && b.width) { const r = sv(null, 'rect', { x: b.x - 3, y: b.y - 1, width: b.width + 6, height: b.height + 2, rx: 3, fill: 'var(--surface)', opacity: 0.92 }); svg.insertBefore(r, t); }
      return t;
    };
    tagBg(xa + 8, yt + (yb - yt) * (narrow ? 0.85 : 0.55), hole ? 'core pin (cored hole)' : 'core', 'da-t-soft');
    tagBg(xR - 6, cavTop + 16, 'cavity', 'da-t-soft', 'end');

    // the part: half a cup over the core
    const partPts = [[xf, yb], [pivotX === xf ? faceTopX : xf - offPx, yt], [xa, yt], [xa, outTopY], [outTopX, outTopY], [xf + tw, yb]];
    sv(svg, 'path', { d: P(partPts), class: `da-part${D.draft == null ? ' da-ghost' : ''}` });

    // fan of angles from the foot of the drafted face: sticks / minimum / good
    const zx = (mm) => pivotX - mm * kx;
    const oMin = D.offsetMin, oRec = D.offsetRec;
    const maxShow = Math.min((pivotX - xa) / kx, Math.max(oRec * 1.8, depth * Math.tan((5 * Math.PI) / 180)));
    const wedge = (a, b, cls) => { if (b > a + 1e-9) sv(svg, 'path', { d: P([[pivotX, yb], [zx(a), yt], [zx(b), yt]]), class: cls }); };
    wedge(0, Math.min(oMin, maxShow), 'da-zone-bad');
    wedge(Math.min(oMin, maxShow), Math.min(oRec, maxShow), 'da-zone-min');
    wedge(Math.min(oRec, maxShow), maxShow, 'da-zone-ok');
    for (const [o, c] of [[oMin, 'da-zl-bad'], [oRec, 'da-zl-ok']]) if (o <= maxShow) sv(svg, 'line', { x1: pivotX, y1: yb, x2: zx(o), y2: yt, class: `da-zline ${c}` });
    sv(svg, 'line', { x1: pivotX, y1: yb + 10, x2: pivotX, y2: cavTop + 4, class: 'da-vert' });

    // the drafted face
    const faceCls = D.verdict === 'bad' ? ' da-bad' : D.verdict === 'warn' ? ' da-warn' : '';
    const faceTop = outer ? [outTopX + slope * tw, yt] : [faceTopX, yt];
    sv(svg, 'line', { x1: pivotX, y1: yb, x2: faceTop[0], y2: faceTop[1], class: `da-face${faceCls}` });
    // axis, parting line
    sv(svg, 'line', { x1: xa, y1: cavTop - 6, x2: xa, y2: coreBase + 8, class: 'da-axis' });
    sv(svg, 'line', { x1: xa - 10, y1: yb, x2: xR + 14, y2: yb, class: 'da-pl' });
    sv(svg, 'text', { x: xR + 16, y: yb + 4, class: 'da-t da-t-soft' }, 'PL');

    // pull direction
    const px = xa + 28, py = cavTop - 2;
    sv(svg, 'path', { d: `M${px - 5},${py} L${px + 5},${py} L${px + 5},${py - 22} L${px + 11},${py - 22} L${px},${py - 36} L${px - 11},${py - 22} L${px - 5},${py - 22} Z`, class: 'da-pull' });
    sv(svg, 'text', { x: px + 18, y: py - 22, class: 'da-t da-t-soft' }, 'pull');

    // ruler of standard angles along the top of the core
    const ry = yt + 4;
    let lastX = Infinity;
    for (const r of D.ladder) {
      const x = zx(r.offset);
      if (x < xa + 4) continue;
      const cls = r.enough === 'yes' ? 'ok' : r.enough === 'minimum' ? 'min' : 'bad';
      const g = sv(svg, 'g', { class: 'da-tick', tabindex: 0, role: 'button', 'data-h': `tick-${r.angle}`,
        'aria-label': `Set draft to ${r.angle} degrees: offset ${n3(r.offset)} mm, ${r.enough === 'yes' ? 'enough' : r.enough === 'minimum' ? 'minimum only' : 'not enough'}` });
      sv(g, 'rect', { x: x - 14, y: ry - 2, width: 28, height: 30, rx: 3 });
      sv(g, 'line', { x1: x, y1: yt, x2: x, y2: ry + 8, class: `da-zl-${cls}` });
      if (lastX - x > 30) { sv(g, 'text', { x, y: ry + 20, class: `da-t da-t-${cls}`, 'text-anchor': 'middle' }, `${r.angle}°`); lastX = x; }
      const pick = () => { focusAfter = `tick-${r.angle}`; ctx.set('draft', String(r.angle)); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    }
    // min and recommended, named at the bottom of the fan
    const labY = yb + (narrow ? 30 : 26);
    const minX = zx(Math.min(oMin, maxShow)), recX = zx(Math.min(oRec, maxShow));
    const same = Math.abs(D.min - D.rec) < 1e-9;
    const lab2 = (x, y, head, sub, cls, anchor) => {
      const t = sv(svg, 'text', { x, y, class: `da-t ${cls}`, 'text-anchor': anchor });
      sv(t, 'tspan', { x, dy: 0, class: 'da-t-b' }, head);
      sv(t, 'tspan', { x, dy: 14, class: 'da-t-soft' }, sub);
    };
    const pivotLabX = pivotX - 6;
    if (same) lab2(pivotLabX, labY, `min = rec ${n3(D.min)}°`, `${n3(oMin)} mm over the depth`, 'da-t-ok', 'end');
    else {
      lab2(pivotLabX, labY, `min ${n3(D.min)}°`, `${n3(oMin)} mm`, 'da-t-bad', 'end');
      lab2(Math.min(pivotLabX - (narrow ? 96 : 120), recX), labY, `rec ${n3(D.rec)}°`, `${n3(oRec)} mm`, 'da-t-ok', 'end');
    }
    void minX;

    // depth dimension with its knob
    const xd = xR + (narrow ? 26 : 40);
    sv(svg, 'line', { x1: xR + 2, y1: yt, x2: xd + 8, y2: yt, class: 'da-dim' });
    sv(svg, 'line', { x1: xd, y1: yb, x2: xd, y2: yt, class: 'da-dim', 'marker-start': 'url(#da-ar)', 'marker-end': 'url(#da-ar)' });
    const dl = sv(svg, 'text', { x: xd + (narrow ? -8 : 14), y: (yt + yb) / 2, class: 'da-t', 'text-anchor': narrow ? 'end' : 'start',
      transform: narrow ? `rotate(-90 ${xd - 8} ${(yt + yb) / 2})` : null });
    if (narrow) { dl.setAttribute('x', xd - 8); dl.setAttribute('text-anchor', 'middle'); }
    sv(dl, 'tspan', { class: 'da-t-b' }, `depth ${n3(depth)} mm`);
    const knob = (id, cx, cy, cls, label, onKey, onDrag) => {
      const g = sv(svg, 'g', { class: `da-knob ${cls}`, tabindex: 0, role: 'slider', 'data-h': id, 'aria-label': label });
      sv(g, 'circle', { cx, cy, r: 15, class: 'da-kh' });
      sv(g, 'circle', { cx, cy, r: 6.5, class: 'da-kd' });
      g.addEventListener('keydown', (e) => { if (onKey(e)) { e.preventDefault(); focusAfter = id; } });
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault(); capture(g, e); g.classList.add('da-drag'); dragging = id; focusAfter = id; g.focus();
        const move = (ev) => { const r = svg.getBoundingClientRect(); onDrag(((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H); };
        const up = () => { g.removeEventListener('pointermove', move); dragging = null; drawStage(); };
        g.addEventListener('pointermove', move);
        g.addEventListener('pointerup', up, { once: true });
        g.addEventListener('pointercancel', up, { once: true });
      });
      return g;
    };
    const setDepth = (v) => ctx.set('depth', String(v));
    const kd = knob('depth', xd, yt, 'da-v', `Wall depth ${n3(depth)} mm; arrow keys change it`, (e) => {
      const st = e.shiftKey ? 5 : depth >= 50 ? 1 : 0.5;
      const d = { ArrowUp: st, ArrowRight: st, ArrowDown: -st, ArrowLeft: -st }[e.key];
      if (!d) return false;
      setDepth(Math.max(0.5, Math.round((depth + d) / st) * st)); return true;
    }, (x, y) => {
      const v = (yb - y) / sy; const st = v >= 50 ? 1 : 0.5;
      setDepth(clamp(Math.round(v / st) * st, 0.5, scaleDepth * 3));
    });
    kd.setAttribute('aria-valuenow', depth);

    // the draft knob on the top of the face
    const cur = D.draft;
    const setDraft = (v) => ctx.set('draft', String(Math.round(clamp(v, 0, 30) * 100) / 100));
    const kf = knob('draft', faceTop[0], faceTop[1], `${cur == null ? 'da-empty' : ''}`,
      cur == null ? 'Draft not set; arrow keys or drag to set it' : `Draft ${n3(cur)} degrees per side; arrow keys change it`, (e) => {
        const st = e.shiftKey ? 0.5 : 0.05;
        const d = { ArrowLeft: st, ArrowUp: st, ArrowRight: -st, ArrowDown: -st }[e.key];
        if (!d) return false;
        const base = cur ?? D.rec;
        setDraft(Math.round((base + d) / 0.05) * 0.05); return true;
      }, (x) => {
        const o = (pivotX - x) / kx;                               // mm of offset
        const deg = (Math.atan(Math.max(0, o) / depth) * 180) / Math.PI;
        setDraft(Math.round(deg / 0.05) * 0.05);
      });
    if (cur != null) kf.setAttribute('aria-valuenow', cur);

    // your draft, next to the knob
    const vcls = D.verdict === 'bad' ? 'da-t-bad' : D.verdict === 'warn' ? 'da-t-min' : D.verdict === 'ok' ? 'da-t-ok' : 'da-t-soft';
    const lx = faceTop[0] + 20, ly = cavTop + (outTopY - cavTop) * 0.5 + 4;
    const lt = sv(svg, 'text', { x: lx, y: ly - 6, class: 'da-t' });
    if (cur != null) {
      sv(lt, 'tspan', { class: `da-t-big ${vcls}` }, `${n3(cur)}°`);
      sv(lt, 'tspan', { dx: 8, class: 'da-t-soft' }, `offset ${n3(D.offsetDraft)} mm`);
    } else {
      sv(lt, 'tspan', { class: 'da-t-soft' }, `drawn at rec ${n3(D.rec)}°, drag to try yours`);
    }
    const bb = lt.getBBox?.();
    if (bb && bb.width) { const r = sv(null, 'rect', { x: bb.x - 5, y: bb.y - 2, width: bb.width + 10, height: bb.height + 4, rx: 4, fill: 'var(--surface)', stroke: 'var(--line)' }); svg.insertBefore(r, lt); if (bb.x + bb.width > W - 4) { lt.setAttribute('x', faceTop[0] - 20); lt.setAttribute('text-anchor', 'end'); const b2 = lt.getBBox(); r.setAttribute('x', b2.x - 5); } }
    sv(svg, 'path', { d: `M${faceTop[0] + 6},${faceTop[1] - 8} L${lx - 2},${ly - 2}`, class: 'da-dim' });

    // what is wrong, on the face
    if (D.verdict === 'bad') {
      const mx = (pivotX + faceTop[0]) / 2 - 10, my = (yb + yt) / 2;
      tagBg(mx, my, 'sticks: below min', 'da-t-bad da-t-b', 'end');
    }

    // face name and scale note
    const oRight = outer && !narrow;
    sv(svg, 'text', { x: pivotX + (oRight ? 8 : outer ? -tw - 8 : -8), y: yb - 8, class: 'da-t da-t-soft', 'text-anchor': oRight ? 'start' : 'end' },
      narrow ? (outer ? 'cavity face' : hole ? 'hole wall' : 'core face') : outer ? 'outside wall (cavity face)' : hole ? 'hole wall' : 'inside wall (core face)');
    const cap = sv(svg, 'text', { x: xa + 4, y: H - (narrow ? 24 : 10), class: 'da-t da-t-soft' });
    sv(cap, 'tspan', { x: xa + 4 }, narrow ? `half-section · offsets drawn ×${EX}` : `half-section · depth to scale · draft offsets drawn ×${EX}`);
    if (D.widthDraft != null) sv(cap, 'tspan', { x: narrow ? xa + 4 : null, dx: narrow ? null : 0, dy: narrow ? 14 : 0 }, `${narrow ? '' : ' · '}width change top to bottom ${n3(D.widthDraft)} mm`);

    if (keep) { const el = svg.querySelector(`[data-h="${CSS.escape(keep)}"]`); if (el && document.activeElement !== el) el.focus({ preventScroll: true }); }
    if (focusAfter && !dragging) focusAfter = null;
  }

  function drawHead() {
    const raw = ctx.raw;
    draftF.sync(raw.draft, String(raw.draft ?? '').trim() !== '' && ctx.input.draft == null);
    depthF.sync(raw.depth, !(ctx.input.depth > 0));
    const yours = res?.values?.find((v) => v.label === 'Your draft');
    verdict.dataset.v = yours ? (yours.tone === 'ok' ? 'ok' : yours.tone === 'warn' ? 'warn' : 'bad') : 'none';
    verdict.textContent = yours ? yours.hint : D ? `recommended ${n3(D.rec)}° per side` : '';
    clearDraft.hidden = D?.draft == null;
  }

  function drawFoot() {
    const warns = (res?.warnings || []).map((w) => h('div', { class: 'da-w' }, w));
    const basis = D?.basis ? [h('div', { class: 'da-n' }, `Basis: ${D.basis}`)] : [];
    foot.replaceChildren(...warns, ...basis);
  }

  const draw = () => { drawHead(); drawSide(); drawStage(); drawFoot(); };
  ctx.onResult((r) => { res = r; D = r.draw || null; draw(); });
  new ResizeObserver(() => { if (!dragging) drawStage(); }).observe(svg);
}
