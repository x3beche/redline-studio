// DP / PX / DPI: the page is the asset itself on a screen's pixel grid.
//   Stage    - the square, drawn on the pixel lattice of the chosen density,
//              with its size in dp, px and mm on dimension lines. Drag the
//              corner (or focus it and use the arrow keys) to resize it; a
//              pixel the edge only partly covers is shaded: that is the blur.
//   Density  - a dpi axis with the Android buckets and the logical densities
//              devices report; drag the marker for a custom density, click a
//              bucket, or describe a screen and see its panel ppi land.
//   Ladder   - the same asset in every bucket and at @1x-@3x, each with a
//              loupe on its corner pixel, the px count and the folder.
//   Export   - the files to export as a res/ tree; then the output panel.
// Every number drawn comes from run()'s result (values, tables, view).

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
const whole = (v) => Math.abs(v - Math.round(v)) < 0.005;

const UNITS = [['dp', 'dp'], ['sp', 'sp'], ['px', 'px'], ['pt', 'pt'], ['css', 'CSS px'], ['mm', 'mm'], ['in', 'in']];
const STEP = { dp: 1, sp: 1, px: 1, pt: 1, css: 1, mm: 0.1, in: 0.01 };
const DPI_LO = 100, DPI_HI = 680;

export function page(root, ctx) {
  const F = (v, d = 4) => ctx.fmtNum(v, d);
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('style.css', import.meta.url).href;
  document.head.append(link);

  let res = null;

  // ---------------- size bar ----------------
  const fValue = h('input', { type: 'text', class: 'dp-num dp-big', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Size',
    oninput: (e) => ctx.set('value', e.target.value) });
  const unitSeg = h('div', { class: 'dp-seg', role: 'group', 'aria-label': 'Unit' },
    UNITS.map(([v, t]) => h('button', { type: 'button', 'data-v': v, onclick: () => changeUnit(v) }, t)));
  const fFont = h('input', { type: 'text', class: 'dp-num', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Font scale',
    oninput: (e) => ctx.set('fontScale', e.target.value) });
  const fontCtl = h('label', { class: 'dp-ctl' }, h('span', {}, 'Font scale'), fFont, h('i', {}, '×'));
  const readout = h('div', { class: 'dp-readout', 'aria-live': 'polite' });
  const bar = h('div', { class: 'dp-bar' },
    h('label', { class: 'dp-ctl' }, h('span', {}, 'Size'), fValue), unitSeg, fontCtl, readout);

  // Changing the unit keeps the size: the value is rewritten in the new unit
  // with the factor run() reported (value per dp).
  const PER_DP = (u, v) => ({ dp: 1, sp: 1 / v.fs, px: v.scale, pt: 1, css: 1, in: 1 / 160, mm: 25.4 / 160 })[u];
  function changeUnit(u) {
    const v = res?.view;
    if (!v || !(v.dp >= 0)) { ctx.set('unit', u); return; }
    const nv = v.dp * PER_DP(u, v);
    const step = STEP[u];
    const rounded = Math.round(nv / step) * step;
    ctx.setMany({ unit: u, value: String(Number(rounded.toFixed(4))) });
  }

  // ---------------- stage ----------------
  const stageSvg = sv('svg', { class: 'dp-stage-svg', role: 'img', 'aria-label': 'The asset on the pixel grid' });
  const stageHead = h('div', { class: 'dp-phead' });
  const stageWarn = h('div', { class: 'dp-warns' });
  const stage = h('section', { class: 'dp-panel dp-stage' }, stageHead, h('div', { class: 'dp-stage-wrap' }, stageSvg), stageWarn,
    h('div', { class: 'dp-hint' }, 'Drag the corner handle to resize (Shift: half steps) · focus it and use the arrow keys (Shift: ×10). Shaded pixels are only partly covered: they come out blurred.'));

  // ---------------- density axis ----------------
  const modeSeg = h('div', { class: 'dp-seg', role: 'group', 'aria-label': 'Density from' },
    [['bucket', 'Bucket'], ['custom', 'Custom dpi'], ['device', 'From a screen']].map(([v, t]) =>
      h('button', { type: 'button', 'data-mode': v, onclick: () => setMode(v) }, t)));
  const axisSvg = sv('svg', { class: 'dp-axis-svg', role: 'group', 'aria-label': 'Screen density axis' });
  const fDpi = h('input', { type: 'text', class: 'dp-num', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Custom density in dpi',
    oninput: (e) => ctx.set('customDpi', e.target.value) });
  const fW = h('input', { type: 'text', class: 'dp-num', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Screen width in px', oninput: (e) => ctx.set('screenW', e.target.value) });
  const fH = h('input', { type: 'text', class: 'dp-num', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Screen height in px', oninput: (e) => ctx.set('screenH', e.target.value) });
  const fD = h('input', { type: 'text', class: 'dp-num', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Diagonal in inches', oninput: (e) => ctx.set('diagonal', e.target.value) });
  const customRow = h('div', { class: 'dp-row' }, h('label', { class: 'dp-ctl' }, h('span', {}, 'Density'), fDpi, h('i', {}, 'dpi')),
    h('span', { class: 'dp-sub' }, 'Drag the marker; it snaps to the densities devices report (Alt: any value).'));
  const phoneSvg = sv('svg', { class: 'dp-phone', role: 'img', 'aria-label': 'The screen' });
  const phoneInfo = h('div', { class: 'dp-phone-info' });
  const deviceRow = h('div', { class: 'dp-device' }, phoneSvg,
    h('div', { class: 'dp-device-f' },
      h('label', { class: 'dp-ctl' }, h('span', {}, 'Resolution'), fW, h('i', {}, '×'), fH, h('i', {}, 'px')),
      h('label', { class: 'dp-ctl' }, h('span', {}, 'Diagonal'), fD, h('i', {}, 'in')),
      phoneInfo));
  const axis = h('section', { class: 'dp-panel dp-axis' },
    h('div', { class: 'dp-phead' }, h('span', { class: 'dp-h' }, 'Screen density'), modeSeg),
    h('div', { class: 'dp-axis-wrap' }, axisSvg), customRow, deviceRow);

  function setMode(m) {
    const v = res?.view;
    if (m === 'bucket') {
      const cur = ctx.raw.density;
      if (['custom', 'device'].includes(cur)) {
        // the bucket nearest the density in use
        const dpi = v?.dpi || 480;
        const b = (v?.buckets || []).filter((x) => x.key !== 'tvdpi').reduce((a, x) => (Math.abs(x.dpi - dpi) < Math.abs(a.dpi - dpi) ? x : a), { dpi: 1e9, key: 'xxhdpi' });
        ctx.set('density', b.key);
      }
    } else if (m === 'custom') {
      ctx.setMany({ density: 'custom', customDpi: v?.dpi ? String(v.dpi) : ctx.raw.customDpi });
    } else ctx.set('density', 'device');
  }

  // ---------------- ladder ----------------
  const ladder = h('div', { class: 'dp-ladder' });
  const ladderPanel = h('section', { class: 'dp-panel dp-ladder-panel' },
    h('div', { class: 'dp-phead' }, h('span', { class: 'dp-h' }, 'Every density'), h('span', { class: 'dp-sub' }, 'the corner pixel of the asset, magnified · click a bucket to draw it')),
    ladder);

  // ---------------- export tree ----------------
  const tree = h('div', { class: 'dp-tree' });
  const treePanel = h('section', { class: 'dp-panel' },
    h('div', { class: 'dp-phead' }, h('span', { class: 'dp-h' }, 'Files to export')), tree);

  const notes = h('details', { class: 'dp-notes' });

  root.classList.add('dp-root');
  root.append(h('div', { class: 'dp' },
    h('div', { class: 'dp-main' }, bar, stage, axis, treePanel),
    h('div', { class: 'dp-side' }, ladderPanel, ctx.outputs, notes)));

  // ---------------- drawing: stage ----------------
  let drag = null;
  function stageDraw() {
    stageSvg.replaceChildren();
    const v = res?.view;
    const W = Math.max(280, stageSvg.clientWidth || 600);
    const H = W < 520 ? 330 : 440;
    stageSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    stageSvg.setAttribute('height', H);
    if (!v) {
      stageSvg.append(sv('text', { x: W / 2, y: H / 2, class: 'dp-empty', 'text-anchor': 'middle' }, (res?.warnings || ['Give a size.'])[0]));
      return;
    }
    const N = v.px;                              // the edge in pixels of the chosen density
    const touch = v.dp > 0 && v.dp < 48 ? 48 * v.scale : 0; // Material minimum touch target, in px
    const ext = Math.max(N, touch, 1);
    const wideStage = W >= 620;
    const mL = wideStage ? 170 : 40, mR = 78, mT = wideStage ? 50 : 66, mB = 56;
    const k = Math.min((W - mL - mR) / ext, (H - mT - mB) / ext);  // screen px per device pixel
    const cx = mL + ((W - mL - mR) - ext * k) / 2 + (ext * k) / 2;
    const cy = mT + ((H - mT - mB) - ext * k) / 2 + (ext * k) / 2;
    const x0 = cx - (N * k) / 2, y0 = cy - (N * k) / 2;       // square's top left
    const g = sv('g');
    // pixel lattice (whole device pixels), aligned to the square's corner
    const gx0 = cx - (ext * k) / 2 - 6, gx1 = cx + (ext * k) / 2 + 6;
    const gy0 = cy - (ext * k) / 2 - 6, gy1 = cy + (ext * k) / 2 + 6;
    const lattice = k >= 2.2;
    if (lattice) {
      let d = '';
      for (let i = Math.floor((gx0 - x0) / k); x0 + i * k <= gx1; i++) { const x = x0 + i * k; if (x >= gx0) d += `M${x.toFixed(1)},${gy0.toFixed(1)}V${gy1.toFixed(1)}`; }
      for (let j = Math.floor((gy0 - y0) / k); y0 + j * k <= gy1; j++) { const y = y0 + j * k; if (y >= gy0) d += `M${gx0.toFixed(1)},${y.toFixed(1)}H${gx1.toFixed(1)}`; }
      g.append(sv('path', { d, class: 'dp-lattice', style: k < 5 ? 'opacity:.55' : null }));
    }
    // 4 dp baseline grid
    const g4 = 4 * v.scale * k;
    if (g4 >= 7) {
      let d = '';
      for (let i = Math.floor((gx0 - x0) / g4); x0 + i * g4 <= gx1; i++) { const x = x0 + i * g4; if (x >= gx0) d += `M${x.toFixed(1)},${gy0.toFixed(1)}V${gy1.toFixed(1)}`; }
      for (let j = Math.floor((gy0 - y0) / g4); y0 + j * g4 <= gy1; j++) { const y = y0 + j * g4; if (y >= gy0) d += `M${gx0.toFixed(1)},${y.toFixed(1)}H${gx1.toFixed(1)}`; }
      g.append(sv('path', { d, class: 'dp-grid4' }));
    }
    // touch target
    if (touch) {
      const t = touch * k;
      g.append(sv('rect', { x: cx - t / 2, y: cy - t / 2, width: t, height: t, class: 'dp-touch' }));
      g.append(sv('text', { x: cx - t / 2 + 4, y: cy - t / 2 - 5, class: 'dp-touch-t' }, '48 dp touch target'));
    }
    // the square, whole pixels solid, the partial row / column shaded
    const full = Math.floor(N + 1e-6), frac = N - full;
    g.append(sv('rect', { x: x0, y: y0, width: N * k, height: N * k, class: 'dp-sq' }));
    if (frac > 0.005) {
      const px0 = x0 + full * k;
      g.append(sv('rect', { x: px0, y: y0, width: k, height: (full + 1) * k, class: 'dp-partial' }));
      g.append(sv('rect', { x: x0, y: y0 + full * k, width: full * k, height: k, class: 'dp-partial' }));
      if (k >= 10) g.append(sv('text', { x: px0 + k + 6, y: y0 + full * k + k * 0.7, class: 'dp-warn-t' }, `${Math.round(frac * 100)} % of a pixel: blurred edge`));
      else g.append(sv('text', { x: x0 + N * k + 8, y: y0 + N * k - 4, class: 'dp-warn-t' }, `${F(N, 5)} px: not whole`));
    }
    g.append(sv('rect', { x: x0, y: y0, width: N * k, height: N * k, class: 'dp-sq-edge' }));
    // dimension lines: dp on top, px on the right, mm below
    const dim = (x1, y1, x2, y2, label, cls, vertical) => {
      const d = sv('g', { class: `dp-dim ${cls || ''}` });
      d.append(sv('line', { x1, y1, x2, y2 }));
      if (vertical) {
        d.append(sv('line', { x1: x1 - 4, y1, x2: x1 + 4, y2: y1 }), sv('line', { x1: x2 - 4, y1: y2, x2: x2 + 4, y2 }));
        const t = sv('text', { x: x1 + 8, y: (y1 + y2) / 2 + 4 }, label); d.append(t);
      } else {
        d.append(sv('line', { x1, y1: y1 - 4, x2: x1, y2: y1 + 4 }), sv('line', { x1: x2, y1: y2 - 4, x2, y2: y2 + 4 }));
        d.append(sv('text', { x: (x1 + x2) / 2, y: y1 - 7, 'text-anchor': 'middle' }, label));
      }
      return d;
    };
    const top = Math.min(y0, cy - (ext * k) / 2) - 16;
    const unitLbl = v.unit === 'sp' ? `${F(v.dp / v.fs, 4)} sp = ${F(v.dp, 4)} dp` : `${F(v.dp, 4)} dp${['pt', 'css'].includes(v.unit) ? ` = ${F(v.value, 4)} ${v.unit === 'pt' ? 'pt' : 'CSS px'}` : ''}`;
    g.append(dim(x0, top, x0 + N * k, top, unitLbl, 'dp-dim-dp'));
    const right = Math.max(x0 + N * k, cx + (ext * k) / 2) + 14;
    g.append(dim(right, y0, right, y0 + N * k, `${F(N, 5)} px`, `dp-dim-px${whole(N) ? '' : ' dp-bad'}`, true));
    const bot = Math.max(y0 + N * k, cy + (ext * k) / 2) + 26;
    const mmLbl = (res.values || []).find((x) => x.label === 'Physical size');
    g.append(dim(x0, bot, x0 + N * k, bot, `${mmLbl ? mmLbl.value : F(v.mm, 3) + ' mm'} nominal`, 'dp-dim-mm'));
    // corner handle
    const hx = x0 + N * k, hy = y0 + N * k;
    const handle = sv('g', { class: 'dp-handle', tabindex: '0', role: 'slider', 'aria-label': `Size in ${v.unit}`,
      'aria-valuenow': String(v.value), 'aria-valuetext': `${F(v.value, 4)} ${v.unit}` });
    handle.append(sv('circle', { cx: hx, cy: hy, r: 16, class: 'dp-handle-hit' }), sv('circle', { cx: hx, cy: hy, r: 6.5, class: 'dp-handle-dot' }));
    g.append(handle);
    // what we are looking at
    const lbl = v.density === 'device' ? `${v.dpi} dpi (logical, from the screen)` : v.density === 'custom' ? `${v.dpi} dpi (custom)` : `${v.density} · ${v.dpi} dpi`;
    g.append(sv('text', { x: 10, y: 18, class: 'dp-corner-t' }, `${lbl} · ×${F(v.scale, 4)}`));
    g.append(sv('text', { x: 10, y: 34, class: 'dp-corner-s' }, lattice ? 'one cell = one device pixel' + (g4 >= 7 ? ' · dashed: 4 dp grid' : '') : 'pixels too small to draw at this zoom: see the loupes'));
    // loupe on the corner: 6 × 6 device pixels around it, each cell shaded by how much the asset covers it
    if (wideStage) {
      const n = 6, c = 21, lx = 16, ly = H - n * c - 34;
      const cornerCell = Math.ceil(N - 1e-6), first = cornerCell - 4;
      const lg = sv('g', { class: 'dp-bigloupe' });
      lg.append(sv('path', { d: `M${lx + n * c},${ly + 4 * c} L${hx},${hy}`, class: 'dp-leader' }));
      lg.append(sv('rect', { x: lx - 1, y: ly - 1, width: n * c + 2, height: n * c + 2, class: 'dp-bl-frame' }));
      const cov = (a) => clamp(N - a, 0, 1);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const ci = first + i, cj = first + j;
        const cv = ci < 0 || cj < 0 ? 0 : cov(ci) * cov(cj);
        const r = sv('rect', { x: lx + i * c, y: ly + j * c, width: c, height: c, class: cv > 0.995 ? 'dp-lp-full' : cv > 0.005 ? 'dp-lp-part' : 'dp-lp-empty' });
        if (cv > 0.005 && cv <= 0.995) r.setAttribute('style', `fill-opacity:${(0.25 + cv * 0.6).toFixed(2)}`);
        lg.append(r);
        if (cv > 0.005 && cv <= 0.995 && i >= j) lg.append(sv('text', { x: lx + i * c + c / 2, y: ly + j * c + c / 2 + 3.5, 'text-anchor': 'middle', class: 'dp-bl-pct' }, Math.round(cv * 100)));
      }
      lg.append(sv('text', { x: lx, y: ly - 8, class: 'dp-corner-s' }, 'corner, 6 × 6 device px'));
      lg.append(sv('text', { x: lx, y: ly + n * c + 15, class: whole(N) ? 'dp-bl-ok' : 'dp-warn-t' }, whole(N) ? 'edge on a pixel boundary' : `edge at ${F(N, 5)} px: % covered`));
      g.append(lg);
      g.append(handle);   // keep the handle on top of the leader
    }
    stageSvg.append(g);
    stageSvg._geom = { x0, y0, k, v };
    handle.addEventListener('keydown', (e) => {
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const st = STEP[v.unit] * (e.shiftKey ? 10 : 1);
      const nv = Math.max(0, Math.round((Number(v.value) + dir * st) / STEP[v.unit]) * STEP[v.unit]);
      focusAfter = 'handle';
      ctx.set('value', String(Number(nv.toFixed(4))));
    });
  }
  let focusAfter = null;
  stageSvg.style.touchAction = 'none';
  stageSvg.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.dp-handle')) return;
    e.preventDefault();
    stageSvg.setPointerCapture(e.pointerId);
    const { x0, y0, k, v } = stageSvg._geom;
    drag = { x0, y0, k, v };
    stageSvg.classList.add('dp-dragging');
  });
  stageSvg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = stageSvg.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (stageSvg.viewBox.baseVal.width / r.width);
    const sy = (e.clientY - r.top) * (stageSvg.viewBox.baseVal.height / r.height);
    const { x0, y0, k, v } = drag;
    const npx = Math.max(0, ((sx - x0) + (sy - y0)) / 2 / k);   // device pixels
    const dp = npx / v.scale;
    const inUnit = dp * PER_DP(v.unit, v);
    const st = STEP[v.unit] / (e.shiftKey ? 2 : 1);
    const nv = Math.round(inUnit / st) * st;
    if (String(Number(nv.toFixed(4))) !== String(ctx.raw.value)) ctx.set('value', String(Number(nv.toFixed(4))));
  });
  const end = () => { drag = null; stageSvg.classList.remove('dp-dragging'); };
  stageSvg.addEventListener('pointerup', end);
  stageSvg.addEventListener('pointercancel', end);

  // ---------------- drawing: density axis ----------------
  let axisDrag = false;
  function axisDraw() {
    axisSvg.replaceChildren();
    const v = res?.view;
    const W = Math.max(280, axisSvg.clientWidth || 600), H = 92;
    axisSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); axisSvg.setAttribute('height', H);
    const L = 14, R = 14, Y = 50;
    const X = (d) => L + ((clamp(d, DPI_LO, DPI_HI) - DPI_LO) / (DPI_HI - DPI_LO)) * (W - L - R);
    axisSvg._X = X; axisSvg._inv = (x) => DPI_LO + ((x - L) / (W - L - R)) * (DPI_HI - DPI_LO);
    axisSvg.append(sv('line', { x1: L, x2: W - R, y1: Y, y2: Y, class: 'dp-ax' }));
    for (const d of v?.logical || []) axisSvg.append(sv('line', { x1: X(d), x2: X(d), y1: Y - 4, y2: Y + 4, class: 'dp-ax-minor' }));
    const narrow = W < 460;
    for (const b of v?.buckets || []) {
      const on = v.density === b.key;
      const gb = sv('g', { class: `dp-bk${on ? ' dp-on' : ''}`, tabindex: '0', role: 'button', 'aria-pressed': String(on), 'aria-label': `${b.key}, ${b.dpi} dpi` });
      gb.append(sv('line', { x1: X(b.dpi), x2: X(b.dpi), y1: Y - 12, y2: Y + 12 }));
      const lblY = b.key === 'tvdpi' ? Y + 26 : Y + 26;
      if (!(narrow && b.key === 'tvdpi')) gb.append(sv('text', { x: X(b.dpi), y: b.key === 'tvdpi' ? Y - 17 : lblY, 'text-anchor': 'middle', class: 'dp-bk-t' }, narrow ? b.key.replace('dpi', '') : b.key));
      if (!narrow) gb.append(sv('text', { x: X(b.dpi), y: lblY + 13, 'text-anchor': 'middle', class: 'dp-bk-s' }, `×${F(b.scale, 3)}`));
      gb.append(sv('rect', { x: X(b.dpi) - 18, y: Y - 18, width: 36, height: 60, class: 'dp-hit' }));
      const pick = () => ctx.set('density', b.key);
      gb.addEventListener('click', pick);
      gb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      axisSvg.append(gb);
    }
    if (!v) return;
    // panel ppi (from a screen) and where it lands
    if (v.physPpi) {
      axisSvg.append(sv('circle', { cx: X(v.physPpi), cy: Y, r: 5, class: 'dp-ppi' }));
      axisSvg.append(sv('path', { d: `M${X(v.physPpi)},${Y - 8} Q${(X(v.physPpi) + X(v.dpi)) / 2},${Y - 30} ${X(v.dpi)},${Y - 12}`, class: 'dp-ppi-arc' }));
      axisSvg.append(sv('text', { x: X(v.physPpi), y: Y + 42, 'text-anchor': 'middle', class: 'dp-ppi-t' }, `panel ${Math.round(v.physPpi)} ppi`));
    }
    const m = sv('g', { class: 'dp-marker', tabindex: '0', role: 'slider', 'aria-label': 'Density in dpi', 'aria-valuenow': String(v.dpi), 'aria-valuetext': `${v.dpi} dpi` });
    m.append(sv('line', { x1: X(v.dpi), x2: X(v.dpi), y1: 6, y2: Y + 8 }),
      sv('path', { d: `M${X(v.dpi) - 7},${Y - 22} L${X(v.dpi) + 7},${Y - 22} L${X(v.dpi)},${Y - 12} Z` }),
      sv('text', { x: clamp(X(v.dpi), 30, W - 30), y: 14, 'text-anchor': 'middle' }, `${v.dpi} dpi`),
      sv('rect', { x: X(v.dpi) - 14, y: 0, width: 28, height: Y, class: 'dp-hit' }));
    m.addEventListener('keydown', (e) => {
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const L2 = v.logical;
      let i = L2.findIndex((d) => d >= v.dpi);
      if (i < 0) i = L2.length - 1;
      const next = dir > 0 ? L2.find((d) => d > v.dpi) ?? L2[L2.length - 1] : [...L2].reverse().find((d) => d < v.dpi) ?? L2[0];
      focusAfter = 'marker';
      ctx.setMany({ density: 'custom', customDpi: String(next) });
    });
    axisSvg.append(m);
  }
  axisSvg.style.touchAction = 'none';
  const axisSet = (e) => {
    const r = axisSvg.getBoundingClientRect();
    const x = (e.clientX - r.left) * (axisSvg.viewBox.baseVal.width / r.width);
    let d = Math.round(axisSvg._inv(x));
    d = clamp(d, DPI_LO, DPI_HI);
    const L2 = res?.view?.logical || [];
    if (!e.altKey && L2.length) d = L2.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a), L2[0]);
    if (String(d) !== String(ctx.raw.customDpi) || ctx.raw.density !== 'custom') ctx.setMany({ density: 'custom', customDpi: String(d) });
  };
  axisSvg.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.dp-marker')) return;
    e.preventDefault(); axisDrag = true; axisSvg.setPointerCapture(e.pointerId); axisSvg.classList.add('dp-dragging');
  });
  axisSvg.addEventListener('pointermove', (e) => { if (axisDrag) axisSet(e); });
  const axEnd = () => { axisDrag = false; axisSvg.classList.remove('dp-dragging'); };
  axisSvg.addEventListener('pointerup', axEnd);
  axisSvg.addEventListener('pointercancel', axEnd);

  // ---------------- drawing: phone (from a screen) ----------------
  function phoneDraw() {
    phoneSvg.replaceChildren();
    const v = res?.view, s = v?.screen;
    phoneInfo.replaceChildren();
    if (!s) return;
    const pw = Math.min(s.w, s.h), ph = Math.max(s.w, s.h);
    const H = 120, Wd = Math.max(40, (H - 12) * pw / ph + 12);
    phoneSvg.setAttribute('viewBox', `0 0 ${Wd + 36} ${H + 4}`); phoneSvg.setAttribute('width', Wd + 36); phoneSvg.setAttribute('height', H + 4);
    phoneSvg.append(sv('rect', { x: 2, y: 2, width: Wd, height: H, rx: 9, class: 'dp-ph-body' }),
      sv('rect', { x: 8, y: 8, width: Wd - 12, height: H - 12, rx: 3, class: 'dp-ph-screen' }),
      sv('line', { x1: 8, y1: H - 4, x2: Wd - 4, y2: 8, class: 'dp-ph-diag' }),
      sv('text', { x: Wd / 2 + 2, y: H / 2 + 4, 'text-anchor': 'middle', class: 'dp-ph-t', transform: `rotate(${-Math.atan2(H - 12, Wd - 12) * 180 / Math.PI} ${Wd / 2 + 2} ${H / 2})` }, `${F(s.diagonal, 3)}″`),
      sv('text', { x: Wd + 6, y: H / 2, class: 'dp-ph-s' }, `${ph}`), sv('text', { x: Wd + 6, y: H / 2 + 12, class: 'dp-ph-s' }, 'px'));
    const sc = (res.values || []).find((x) => x.label === 'Screen in dp');
    const pp = (res.values || []).find((x) => x.label === 'Panel density');
    phoneInfo.append(
      h('div', {}, h('b', {}, sc ? `${sc.value} dp` : ''), ' ', h('span', { class: 'dp-sub' }, sc?.hint || '')),
      h('div', { class: 'dp-sub' }, pp ? `panel ${pp.value} ppi · ${pp.hint}` : ''));
  }

  // ---------------- drawing: ladder ----------------
  const loupe = (px, bad) => {
    // a 5 × 5 pixel window on the square's bottom-right corner
    const n = 5, c = 9, svg = sv('svg', { viewBox: `0 0 ${n * c} ${n * c}`, width: n * c, height: n * c, class: 'dp-loupe', 'aria-hidden': 'true' });
    const cornerCell = Math.ceil(px - 1e-6);    // cell index just past the edge
    const first = cornerCell - 3;               // leftmost cell shown
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const ci = first + i, cj = first + j;
      const cov = (a) => clamp(px - a, 0, 1);   // how much of cell a the square covers
      const cv = ci < 0 || cj < 0 ? 0 : cov(ci) * cov(cj);
      const r = sv('rect', { x: i * c, y: j * c, width: c, height: c, class: cv > 0.995 ? 'dp-lp-full' : cv > 0.005 ? 'dp-lp-part' : 'dp-lp-empty' });
      if (cv > 0.005 && cv <= 0.995) r.setAttribute('style', `fill-opacity:${(0.25 + cv * 0.6).toFixed(2)}`);
      svg.append(r);
    }
    if (bad) svg.classList.add('dp-lp-bad');
    return svg;
  };
  function ladderDraw() {
    ladder.replaceChildren();
    const v = res?.view;
    if (!v) return;
    const t0 = res.tables?.[0];
    const maxPx = Math.max(...v.buckets.map((b) => b.px), ...v.ios.map((b) => b.px), 1);
    const row = (key, sub, px, folder, on, onPick) => {
      const ok = whole(px);
      const el = h(onPick ? 'button' : 'div', { class: `dp-lrow${on ? ' dp-on' : ''}${ok ? '' : ' dp-frac'}`, type: onPick ? 'button' : null,
        'aria-pressed': onPick ? String(on) : null, onclick: onPick || null },
      loupe(px, !ok),
      h('span', { class: 'dp-lname' }, h('b', {}, key), h('small', {}, sub)),
      h('span', { class: 'dp-lbar' }, h('i', { style: `width:${(100 * px / maxPx).toFixed(1)}%` })),
      h('span', { class: 'dp-lpx' }, h('b', {}, F(Math.round(px * 100) / 100, 6)), h('small', {}, ok ? ' px' : ` px → ${Math.round(px)}`)),
      h('span', { class: 'dp-lfold' }, folder));
      return el;
    };
    ladder.append(h('div', { class: 'dp-lgroup' }, 'Android'));
    v.buckets.forEach((b, i) => {
      const trow = t0?.rows?.[i];
      ladder.append(row(b.key, `${b.dpi} dpi · ×${F(b.scale, 3)}`, trow ? trow[3] : b.px, trow ? trow[5] : '', v.density === b.key, () => ctx.set('density', b.key)));
    });
    const t1 = res.tables?.[1];
    ladder.append(h('div', { class: 'dp-lgroup' }, 'iOS'));
    v.ios.forEach((b, i) => {
      const trow = t1?.rows?.[i];
      ladder.append(row(b.key, `×${b.scale}`, trow ? trow[1] : b.px, trow ? trow[3] : '', false, null));
    });
    if (v.density === 'custom' || v.density === 'device') {
      ladder.append(h('div', { class: 'dp-lgroup' }, 'This screen'));
      ladder.append(row(`${v.dpi} dpi`, `×${F(v.scale, 4)}`, v.px, v.density === 'device' ? 'logical density of the screen' : 'custom density', true, null));
    }
  }

  // ---------------- drawing: export tree ----------------
  function treeDraw() {
    tree.replaceChildren();
    const t = res?.tables?.[2];
    if (!t) return;
    const groups = [['res/', (r) => r[0].startsWith('Android'), (r) => r[0].replace('Android ', '') + '/'],
      ['Assets.xcassets/', (r) => r[0].startsWith('iOS'), (r) => `icon${r[0].replace('iOS ', '')}.png`],
      ['web (srcset)', (r) => r[0].startsWith('Web'), (r) => `icon-${r[0].replace(/^Web (\dx).*/, '$1')}.png`]];
    for (const [head, test, name] of groups) {
      const rows = t.rows.filter(test);
      if (!rows.length) continue;
      const col = h('div', { class: 'dp-tcol' }, h('div', { class: 'dp-tdir' }, head));
      tree.append(col);
      for (const r of rows) {
        col.append(h('div', { class: `dp-tfile${r[3] ? ' dp-frac' : ''}` },
          h('span', { class: 'dp-tname' }, name(r)), h('span', { class: 'dp-tscale' }, r[1]),
          h('b', {}, r[2]), r[3] ? h('span', { class: 'dp-tnote' }, r[3]) : null));
      }
    }
  }

  // ---------------- sync ----------------
  const syncField = (el, key) => { if (document.activeElement !== el) el.value = ctx.raw[key] ?? ''; };
  function sync() {
    const raw = ctx.raw;
    syncField(fValue, 'value'); syncField(fFont, 'fontScale'); syncField(fDpi, 'customDpi');
    syncField(fW, 'screenW'); syncField(fH, 'screenH'); syncField(fD, 'diagonal');
    for (const b of unitSeg.children) b.setAttribute('aria-pressed', String(b.dataset.v === raw.unit));
    fontCtl.hidden = raw.unit !== 'sp';
    const mode = raw.density === 'custom' ? 'custom' : raw.density === 'device' ? 'device' : 'bucket';
    for (const b of modeSeg.children) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    customRow.hidden = mode !== 'custom';
    deviceRow.hidden = mode !== 'device';
    const v = res?.view;
    readout.replaceChildren();
    if (v) {
      const px = (res.values || [])[1];
      readout.append(h('span', {}, '= '), h('b', { class: whole(v.px) ? '' : 'dp-badtxt' }, `${F(v.px, 5)} px`),
        h('span', { class: 'dp-sub' }, ` at ${v.dpi} dpi`), ...(px?.tone === 'warn' ? [h('span', { class: 'dp-badtxt' }, ' · not whole')] : []));
    }
    stageHead.replaceChildren(h('span', { class: 'dp-h' }, 'On the pixel grid'),
      h('span', { class: 'dp-sub' }, v ? `${F(v.dp, 4)} dp at ${v.dpi} dpi = ${F(v.px, 5)} device pixels` : ''));
    stageWarn.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Notes (${(res?.notes || []).length})`), ...(res?.notes || []).map((n) => h('p', {}, n)));
  }
  function drawAll() {
    sync(); stageDraw(); axisDraw(); phoneDraw(); ladderDraw(); treeDraw();
    if (focusAfter === 'handle') stageSvg.querySelector('.dp-handle')?.focus();
    if (focusAfter === 'marker') axisSvg.querySelector('.dp-marker')?.focus();
    focusAfter = null;
  }
  ctx.onResult((r) => { res = r; drawAll(); });
  let rw = 0;
  new ResizeObserver(() => {
    const w = stageSvg.clientWidth + axisSvg.clientWidth;
    if (w !== rw) { rw = w; stageDraw(); axisDraw(); }
  }).observe(root);
}
