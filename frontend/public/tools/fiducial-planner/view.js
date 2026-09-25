// Fiducial & Tooling Planner: the page is the board on the assembly line.
//   Stage  - the board (or the panel with its rails) from above, to scale, as
//            the pick-and-place camera sees it: solder mask, the copper
//            fiducials in their clear areas, the tooling holes, the conveyor
//            gripping the long edges. Drag the board's corner to size it,
//            drag a fiducial or a tooling hole in from its corner to set the
//            edge distance, drag the rail's inner edge to set its width.
//            A mark with a problem is ringed red with the reason beside it.
//   Loupes - one fiducial and one tooling hole close up: drag the copper
//            dot, the clear area and the hole to size them.
//   Marks  - the coordinate list; pointing at a row lights the mark.
// Every coordinate and size drawn comes from run()'s result.drawing; the
// fine-pitch parts in the middle only show how many there are.

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
const f = (v, d = 4) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(d))));
const snap = (v, st) => Math.round(v / st) * st;
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };

function svgBox(cls, label, draw) {
  const svg = sv(null, 'svg', { role: 'group', 'aria-label': label });
  const box = h('div', { class: `fp-box ${cls}` }, svg);
  let last = '';
  new ResizeObserver(() => {
    const key = `${box.clientWidth}x${box.clientHeight}`;
    if (key !== last) { last = key; draw(); }
  }).observe(box);
  return { svg, box, size: () => [Math.max(160, box.clientWidth), Math.max(120, box.clientHeight)] };
}

// Drag on an SVG whose viewBox is its pixel size: calls fn(x, y) in px.
function dragger(svg, el, fn, onStart) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); capture(svg, e);
    onStart?.();
    const vb = svg.viewBox.baseVal;
    const at = (ev) => { const r = svg.getBoundingClientRect(); fn((ev.clientX - r.left) * (vb.width / r.width), (ev.clientY - r.top) * (vb.height / r.height)); };
    const up = () => { svg.removeEventListener('pointermove', at); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up); };
    svg.addEventListener('pointermove', at); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  });
}

export function page(root, ctx) {
  let D = null, focusKey = null, hot = null;

  // ---------- toolbar ----------
  const seg = (label, key, items) => {
    const g = h('div', { class: 'fp-seg', role: 'radiogroup', 'aria-label': label });
    const btns = items.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set(key, v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const i = clamp(items.findIndex((it) => it[0] === v) + d, 0, items.length - 1);
        ctx.set(key, items[i][0]); requestAnimationFrame(() => g.querySelector(`[data-v="${items[i][0]}"]`)?.focus());
      } }, t));
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => { const on = b.dataset.v === String(cur); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    return g;
  };
  const num = (key, label, unit, title, width = 52) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label, style: `width:${width}px`,
      oninput: (e) => ctx.set(key, e.target.value.trim()) });
    const w = h('label', { class: 'fp-num', title: title || null }, label ? h('span', {}, label) : null, inp, unit ? h('small', {}, unit) : null);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const wF = num('w', '', '', 'Board width X, mm'), hF = num('h', '×', 'mm', 'Board height Y, mm');
  const placeSeg = seg('Marks go on', 'place', [['board', 'Board'], ['rails', 'Panel rails']]);
  const railF = num('rail', 'rail', 'mm', 'Rail width, mm', 40);
  const fidSeg = seg('Global fiducials', 'nfid', [['3', '3 in L'], ['2', '2 diagonal']]);
  const holeSeg = seg('Tooling holes', 'nhole', [['0', 'none'], ['2', '2'], ['3', '3']]);
  const fineOut = h('output', { class: 'fp-count' }, '0');
  const stepFine = (d) => ctx.set('fine', String(clamp((Number(ctx.raw.fine) || 0) + d, 0, 12)));
  const fine = h('div', { class: 'fp-step', role: 'group', 'aria-label': 'Fine-pitch parts' },
    h('button', { type: 'button', 'aria-label': 'One fine-pitch part less', onclick: () => stepFine(-1) }, '−'), fineOut,
    h('button', { type: 'button', 'aria-label': 'One fine-pitch part more', onclick: () => stepFine(1) }, '+'));
  const bar = h('div', { class: 'fp-bar' },
    h('div', { class: 'fp-g' }, h('span', { class: 'fp-cap' }, 'Board'), wF, hF),
    h('div', { class: 'fp-g' }, h('span', { class: 'fp-cap' }, 'Marks on'), placeSeg, railF),
    h('div', { class: 'fp-g' }, h('span', { class: 'fp-cap' }, 'Fiducials'), fidSeg),
    h('div', { class: 'fp-g' }, h('span', { class: 'fp-cap' }, 'Tooling holes'), holeSeg),
    h('div', { class: 'fp-g' }, h('span', { class: 'fp-cap' }, 'Fine-pitch parts'), fine));

  // ---------- stage ----------
  const stage = svgBox('fp-stagebox', 'Board top view with fiducials and tooling holes', () => drawStage());
  const stageWarn = h('div', { class: 'fp-warns', 'aria-live': 'polite' });
  const stageHint = h('div', { class: 'fp-hint' });
  const pStage = h('section', { class: 'fp-panel fp-stage' }, stage.box, stageHint, stageWarn);

  // ---------- loupes ----------
  const feF = num('fe', 'edge', 'mm', 'Fiducial centre from the edge, mm', 40);
  const heF = num('he', 'edge', 'mm', 'Tooling hole centre from the edge, mm', 40);
  const fdF = num('fd', '⌀', '', 'Fiducial diameter, mm', 46);
  const clF = num('clear', 'clear', '', 'Clear area diameter, mm', 46);
  const hdF = num('hd', '⌀', '', 'Tooling hole diameter, mm', 46);
  const fidL = svgBox('fp-loupebox', 'Fiducial close up', () => drawFidLoupe());
  const holeL = svgBox('fp-loupebox', 'Tooling hole close up', () => drawHoleLoupe());
  const fidHead = h('div', { class: 'fp-head' }, h('h2', {}, 'Fiducial'), h('div', { class: 'fp-grow' }), fdF, clF, feF);
  const holeHead = h('div', { class: 'fp-head' }, h('h2', {}, 'Tooling hole'), h('span', { class: 'fp-sub' }, ''), h('div', { class: 'fp-grow' }), hdF, heF);
  const pFid = h('section', { class: 'fp-panel fp-loupe' }, fidHead, fidL.box);
  const pHole = h('section', { class: 'fp-panel fp-loupe' }, holeHead, holeL.box);

  // ---------- marks ----------
  const marks = h('div', { class: 'fp-marks' });
  const pMarks = h('section', { class: 'fp-panel fp-list' }, h('div', { class: 'fp-head' }, h('h2', {}, 'Marks'), h('span', { class: 'fp-sub fp-origin' }, '')), marks);
  const side = h('div', { class: 'fp-side' }, pMarks, ctx.outputs);

  root.append(h('div', { class: 'fp' }, bar, pStage, h('div', { class: 'fp-loupes' }, pFid, pHole), side));

  const refocus = (svg) => {
    if (!focusKey) return;
    const el = svg.querySelector(`[data-key="${focusKey}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  };
  // a focusable handle with arrow keys; set(v) gets the new value
  const keyed = (g, key, cur, step, set, title) => {
    g.setAttribute('tabindex', '0'); g.setAttribute('data-key', key); g.setAttribute('role', 'slider');
    g.setAttribute('aria-label', title); g.setAttribute('aria-valuenow', f(cur));
    g.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return;
      e.preventDefault(); focusKey = key;
      set(cur + d * step * (e.shiftKey ? 10 : 1), e.key);
    });
    g.addEventListener('focus', () => { focusKey = key; });
    g.addEventListener('blur', () => setTimeout(() => { if (focusKey === key && !g.ownerSVGElement?.contains(document.activeElement)) focusKey = null; }, 0));
    sv(g, 'title', {}, `${title}: drag, or arrow keys (Shift = ×10)`);
  };
  const setNum = (key, v, st, lo, hi) => ctx.set(key, String(Number(clamp(snap(v, st), lo, hi).toFixed(3))));

  // ---------- the board ----------
  function drawStage() {
    if (!D) return;
    const svg = stage.svg; svg.replaceChildren();
    const [Wp, Hp] = stage.size();
    svg.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    const narrow = Wp < 560;
    const mL = narrow ? 34 : 64, mR = narrow ? 16 : 40, mT = narrow ? 40 : 52, mB = narrow ? 48 : 58;
    const k = Math.min((Wp - mL - mR) / D.W, (Hp - mT - mB) / D.H);
    const ox = mL + (Wp - mL - mR - D.W * k) / 2, oy = mT + (Hp - mT - mB - D.H * k) / 2;
    const X = (x) => ox + x * k, Y = (y) => oy + (D.H - y) * k;
    const mmX = (px) => (px - ox) / k, mmY = (py) => D.H - (py - oy) / k;
    const rails = D.rails > 0, b = D.board;
    const defs = sv(svg, 'defs');
    const pt = sv(defs, 'pattern', { id: 'fp-hatch', patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' });
    sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'fp-hatch-l' });
    const ar = sv(defs, 'marker', { id: 'fp-ar', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(ar, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'fp-arh' });

    // conveyor belts along the two long (X) edges of the frame
    const bw = 9;
    for (const [y, up] of [[Y(D.H) - bw - 2, true], [Y(0) + 2, false]]) {
      sv(svg, 'rect', { x: X(0) - 18, y, width: D.W * k + 36, height: bw, rx: 2, class: 'fp-belt' });
      for (let x = X(0) - 10; x < X(D.W) + 12; x += 22) sv(svg, 'path', { d: `M${x},${y + 2} l5,${bw / 2 - 2} l-5,${bw / 2 - 2}`, class: 'fp-chev' });
      if (up) sv(svg, 'text', { x: X(0) - 18, y: y - 5, class: 'fp-t fp-soft fp-sm' }, rails || narrow ? 'conveyor →' : `conveyor →   hatched: ${f(D.conveyor)} mm it grips`);
    }

    // panel rails / board
    if (rails) {
      sv(svg, 'rect', { x: X(0), y: Y(D.H), width: D.W * k, height: D.H * k, class: 'fp-rail' });
      sv(svg, 'rect', { x: X(b.x), y: Y(b.y + b.h), width: b.w * k, height: b.h * k, class: 'fp-mask' });
      for (const y of [b.y, b.y + b.h]) sv(svg, 'line', { x1: X(0), x2: X(D.W), y1: Y(y), y2: Y(y), class: 'fp-score' });
      if (!narrow) sv(svg, 'text', { x: X(D.W) + 6, y: Y(b.y + b.h) - (D.rails * k) / 2 + 4, class: 'fp-t fp-soft fp-sm' }, 'rail');
    } else {
      sv(svg, 'rect', { x: X(0), y: Y(D.H), width: D.W * k, height: D.H * k, class: 'fp-mask' });
      // the grip bands: nothing that needs the camera in here
      const g = D.conveyor * k;
      sv(svg, 'rect', { x: X(0), y: Y(D.H), width: D.W * k, height: g, class: 'fp-grip' });
      sv(svg, 'rect', { x: X(0), y: Y(0) - g, width: D.W * k, height: g, class: 'fp-grip' });
    }
    sv(svg, 'rect', { x: X(b.x), y: Y(b.y + b.h), width: b.w * k, height: b.h * k, class: 'fp-edge' });

    // fine-pitch parts: how many, not where
    if (D.fine > 0) {
      const n = Math.min(D.fine, 6);
      const cell = Math.min(b.w / (n + 1), b.h * 0.55);
      const s = Math.min(14, cell * 0.55);
      if (s * k >= 10) {
        for (let i = 0; i < n; i++) {
          const cx = b.x + (b.w * (i + 1)) / (n + 1), cy = b.y + b.h / 2;
          sv(svg, 'rect', { x: X(cx - s / 2), y: Y(cy + s / 2), width: s * k, height: s * k, rx: 2, class: 'fp-bga' });
          const g = Math.max(3, Math.min(6, Math.floor((s * k) / 8)));
          for (let a = 0; a < g; a++) for (let c = 0; c < g; c++) sv(svg, 'circle', { cx: X(cx - s / 2) + ((a + 0.5) * s * k) / g, cy: Y(cy + s / 2) + ((c + 0.5) * s * k) / g, r: Math.max(0.8, (s * k) / g / 4), class: 'fp-ball' });
          for (const [dx, dy] of [[-1, 1], [1, -1]]) {
            const lx = X(cx + dx * (s / 2 + D.clear / 2 + 0.5)), ly = Y(cy + dy * (s / 2 + D.clear / 2 + 0.5));
            sv(svg, 'circle', { cx: lx, cy: ly, r: (D.clear / 2) * k, class: 'fp-clear' });
            sv(svg, 'circle', { cx: lx, cy: ly, r: Math.max(1.2, (D.fd / 2) * k), class: 'fp-cu' });
          }
          if (i === 0) sv(svg, 'text', { x: X(cx), y: Y(cy - s / 2 - D.clear - 0.5) + 12, class: 'fp-t fp-lbl fp-sm', 'text-anchor': 'middle' },
            `${D.fine} fine-pitch · ${D.local} local fiducials`);
        }
        if (D.fine > n) sv(svg, 'text', { x: X(b.x + b.w) - 6, y: Y(b.y + b.h / 2) + 4, class: 'fp-t fp-soft fp-sm', 'text-anchor': 'end' }, `+${D.fine - n}`);
      }
    }

    // overall dimensions
    const dimH = (x1, x2, y, text, cls = '') => {
      sv(svg, 'line', { x1, x2, y1: y, y2: y, class: `fp-dim ${cls}`, 'marker-start': 'url(#fp-ar)', 'marker-end': 'url(#fp-ar)' });
      const t = sv(svg, 'text', { x: (x1 + x2) / 2, y: y - 4, class: `fp-t fp-dimt ${cls}`, 'text-anchor': 'middle' }, text);
      return t;
    };
    const dimV = (x, y1, y2, text) => {
      sv(svg, 'line', { x1: x, x2: x, y1, y2, class: 'fp-dim', 'marker-start': 'url(#fp-ar)', 'marker-end': 'url(#fp-ar)' });
      sv(svg, 'text', { x: x - 5, y: (y1 + y2) / 2, class: 'fp-t fp-dimt', 'text-anchor': 'middle', transform: `rotate(-90 ${x - 5} ${(y1 + y2) / 2})` }, text);
    };
    dimH(X(0), X(D.W), Y(0) + bw + 26, `${f(D.W)} mm`);
    dimV(X(0) - (narrow ? 16 : 26), Y(D.H), Y(0), `${f(D.H)} mm`);
    if (rails && !narrow) dimV(X(D.W) + 26, Y(b.y + b.h), Y(b.y), `board ${f(b.h)}`);
    // origin
    sv(svg, 'circle', { cx: X(0), cy: Y(0), r: 3, class: 'fp-origin' });
    sv(svg, 'text', { x: X(0) - 5, y: Y(0) + bw + 12, class: 'fp-t fp-sm fp-orig-t', 'text-anchor': 'end' }, '0,0');

    // marks: holes first, then fiducials on top
    // labels: tried around each mark, towards the middle first, clear of
    // every mark and of the labels already placed
    const boxes = [...D.fids, ...D.holes].map((m) => { const r = (m.keep / 2) * k + 2; return { x: X(m.x) - r, y: Y(m.y) - r, w: 2 * r, h: 2 * r }; });
    const hits = (a) => boxes.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
    const place = (m, w, hh) => {
      const cx = X(m.x), cy = Y(m.y), rr = (m.keep / 2) * k + 5;
      const sx = m.x < D.W / 2 ? 1 : -1, sy = m.y < D.H / 2 ? -1 : 1;   // towards the middle, px
      const c = [
        [sx > 0 ? cx + rr : cx - rr - w, cy - hh / 2],
        [sx > 0 ? cx + rr * 0.7 : cx - rr * 0.7 - w, sy < 0 ? cy - rr * 0.7 - hh : cy + rr * 0.7],
        [cx - w / 2, sy < 0 ? cy - rr - hh : cy + rr],
        [sx > 0 ? cx - rr - w : cx + rr, cy - hh / 2],
        [cx - w / 2, sy < 0 ? cy + rr : cy - rr - hh],
      ];
      for (let step = 0; step < 4; step++) for (const [x, y] of c) {
        const a = { x, y: y + sy * step * (hh + 2), w, h: hh };
        if (a.x >= 2 && a.x + a.w <= Wp - 2 && a.y >= 2 && a.y + a.h <= Hp - 2 && !hits(a)) { boxes.push(a); return a; }
      }
      const a = { x: c[0][0], y: c[0][1], w, h: hh }; boxes.push(a); return a;
    };
    const markG = (m, isFid) => {
      const key = `m-${m.ref}`;
      const g = sv(svg, 'g', { class: `fp-mark ${isFid ? 'fid' : 'hole'}${m.bad ? ' bad' : ''}${hot === m.ref ? ' hot' : ''}`, 'data-ref': m.ref });
      const cx = X(m.x), cy = Y(m.y);
      if (isFid) {
        sv(g, 'circle', { cx, cy, r: (m.keep / 2) * k, class: 'fp-clear' });
        sv(g, 'circle', { cx, cy, r: Math.max(1.5, (m.d / 2) * k), class: 'fp-cu' });
      } else {
        sv(g, 'circle', { cx, cy, r: (m.keep / 2) * k, class: 'fp-clear' });
        sv(g, 'circle', { cx, cy, r: (m.d / 2) * k, class: 'fp-drill' });
      }
      if (m.bad) sv(g, 'circle', { cx, cy, r: (m.keep / 2) * k + 4, class: 'fp-badring' });
      sv(g, 'circle', { cx, cy, r: Math.max(12, (m.keep / 2) * k + 3), class: 'fp-hit' });
      // label: ref and coordinates, the problem under it
      const why = [m.off && 'off the edge', m.edge && 'in the conveyor grip', m.overlap && 'overlaps another', m.rail && 'wider than the rail'].filter(Boolean);
      const l1 = `${m.ref} ${f(m.x)}, ${f(m.y)}`, l2 = why.length ? `! ${why.join(', ')}` : '';
      const lw = Math.max(l1.length * 6.7, l2.length * 6.1) + 4, lh = l2 ? 28 : 15;
      const a = place(m, lw, lh);
      const t = sv(g, 'text', { x: a.x + 2, y: a.y + 11, class: 'fp-t fp-lbl' });
      sv(t, 'tspan', { class: 'fp-b' }, m.ref);
      sv(t, 'tspan', { class: 'fp-soft' }, ` ${f(m.x)}, ${f(m.y)}`);
      if (l2) sv(g, 'text', { x: a.x + 2, y: a.y + 24, class: 'fp-t fp-sm fp-bad-t' }, l2);
      // drag: its distance in from its corner
      const setIn = (px, py) => {
        const x = mmX(px), y = mmY(py);
        const dx = m.corner.includes('L') ? x : D.W - x;
        const dy = m.corner.includes('B') ? y : D.H - y;
        const v = rails ? dx : (dx + dy) / 2;
        setNum(isFid ? 'fe' : 'he', v, 0.5, 0.5, Math.max(1, Math.min(D.W, D.H) / 2));
      };
      dragger(svg, g, setIn, () => { focusKey = key; g.focus({ preventScroll: true }); });
      keyed(g, key, isFid ? D.fe : D.he, 0.5, (v) => setNum(isFid ? 'fe' : 'he', v, 0.5, 0.5, Math.max(1, Math.min(D.W, D.H) / 2)),
        `${m.ref} ${isFid ? 'fiducial' : 'tooling hole'} centre from the edge, ${f(isFid ? D.fe : D.he)} mm`);
      g.addEventListener('pointerenter', () => setHot(m.ref));
      g.addEventListener('pointerleave', () => setHot(null));
    };
    for (const m of D.holes) markG(m, false);
    for (const m of D.fids) markG(m, true);

    // board corner: size
    const cxp = X(b.x + b.w), cyp = Y(b.y + b.h);
    const corner = sv(svg, 'g', { class: 'fp-handle' });
    sv(corner, 'rect', { x: cxp - 7, y: cyp - 7, width: 14, height: 14, rx: 2, class: 'fp-hbox' });
    sv(corner, 'path', { d: `M${cxp - 3},${cyp + 3} l6,-6 M${cxp - 3},${cyp - 1} l2,-2`, class: 'fp-hgrip' });
    dragger(svg, corner, (px, py) => {
      const w = snap(clamp(mmX(px) - b.x, 5, 600), 0.5);
      const hh = snap(clamp(mmY(py) - b.y, 5, 600), 0.5);
      ctx.setMany({ w: String(w), h: String(hh) });
    }, () => { focusKey = 'corner'; corner.focus({ preventScroll: true }); });
    corner.setAttribute('tabindex', '0'); corner.setAttribute('data-key', 'corner'); corner.setAttribute('role', 'slider');
    corner.setAttribute('aria-label', `Board size ${f(b.w)} by ${f(b.h)} mm: arrow keys, Shift = 5 mm`);
    corner.setAttribute('aria-valuenow', f(b.w));
    corner.addEventListener('keydown', (e) => {
      const st = e.shiftKey ? 5 : 0.5;
      const d = { ArrowRight: [st, 0], ArrowLeft: [-st, 0], ArrowUp: [0, st], ArrowDown: [0, -st] }[e.key];
      if (!d) return; e.preventDefault(); focusKey = 'corner';
      ctx.setMany({ w: String(clamp(b.w + d[0], 5, 600)), h: String(clamp(b.h + d[1], 5, 600)) });
    });
    sv(corner, 'title', {}, 'Board size: drag the corner, or arrow keys (Shift = 5 mm)');

    // rail width
    if (rails) {
      const ry = Y(D.H - D.rails);
      const rh = sv(svg, 'g', { class: 'fp-handle fp-rh' });
      sv(rh, 'rect', { x: X(D.W / 2) - 18, y: ry - 4, width: 36, height: 8, rx: 3, class: 'fp-hbox' });
      sv(rh, 'rect', { x: X(0), y: ry - 6, width: D.W * k, height: 12, class: 'fp-hitr' });
      dragger(svg, rh, (px, py) => setNum('rail', D.H - mmY(py), 0.5, 2, 30), () => { focusKey = 'rail'; rh.focus({ preventScroll: true }); });
      keyed(rh, 'rail', D.rails, 0.5, (v) => setNum('rail', v, 0.5, 2, 30), 'Rail width');
      if (!narrow) sv(svg, 'text', { x: X(D.W / 2) + 24, y: ry + 4, class: 'fp-t fp-sm fp-lbl' }, `${f(D.rails)} mm`);
    }
    refocus(svg);
  }

  function setHot(ref) {
    hot = ref;
    for (const g of stage.svg.querySelectorAll('.fp-mark')) g.classList.toggle('hot', g.dataset.ref === ref);
    for (const r of marks.querySelectorAll('tr[data-ref]')) r.classList.toggle('hot', r.dataset.ref === ref);
  }

  // ---------- loupes ----------
  function loupe(L, key, d, keep, minRing, isFid) {
    const svg = L.svg; svg.replaceChildren();
    const [W, H] = L.size();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const cx = W * 0.42, cy = H / 2 + 4;
    const span = Math.max(keep, minRing || 0, d) * 1.02;
    const k = Math.min(W * 0.62, H - 40) / span;
    sv(svg, 'rect', { x: 0, y: 0, width: W, height: H, class: 'fp-mask-bg' });
    if (minRing && Math.abs(minRing - keep) > 1e-9) sv(svg, 'circle', { cx, cy, r: (minRing / 2) * k, class: 'fp-minring' });
    sv(svg, 'circle', { cx, cy, r: (keep / 2) * k, class: 'fp-clear' });
    sv(svg, 'circle', { cx, cy, r: (d / 2) * k, class: isFid ? 'fp-cu' : 'fp-drill' });
    // dimensions: the dot across its middle, the clear area below
    const defs = sv(svg, 'defs');
    const ar = sv(defs, 'marker', { id: `fp-ar-${key}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(ar, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'fp-arh' });
    const dim = (r, y, text, cls) => {
      sv(svg, 'line', { x1: cx - r, x2: cx + r, y1: y, y2: y, class: `fp-dim ${cls}`, 'marker-start': `url(#fp-ar-${key})`, 'marker-end': `url(#fp-ar-${key})` });
      sv(svg, 'text', { x: cx, y: y - 5, class: `fp-t fp-dimt ${cls}`, 'text-anchor': 'middle' }, text);
    };
    dim((d / 2) * k, cy, `⌀ ${f(d)}`, isFid ? 'fp-on-cu' : 'fp-on-drill');
    // keep-out ring dimension at the right, as a label with a leader
    const rx = cx + (keep / 2) * k * Math.SQRT1_2, ry = cy - (keep / 2) * k * Math.SQRT1_2;
    const tx = Math.min(W - 6, cx + (Math.max(keep, minRing || 0) / 2) * k + 14);
    sv(svg, 'path', { d: `M${rx},${ry} L${rx + 10},${ry - 10} H${tx}`, class: 'fp-leader' });
    sv(svg, 'text', { x: tx, y: ry - 14, class: 'fp-t fp-b', 'text-anchor': 'end' }, `⌀ ${f(keep)}`);
    sv(svg, 'text', { x: tx, y: ry + 2, class: 'fp-t fp-sm fp-soft', 'text-anchor': 'end' }, isFid ? 'clear area' : `${f(D.holeRing)} mm ring, copper-free`);
    if (minRing && keep < minRing - 1e-9) sv(svg, 'text', { x: 8, y: H - 8, class: 'fp-t fp-sm fp-bad-t' }, `! under 3 × dot = ${f(minRing)} mm`);
    else if (minRing) sv(svg, 'text', { x: 8, y: H - 8, class: 'fp-t fp-sm fp-soft' }, `dashed: 3 × dot = ${f(minRing)} mm`);
    return { svg, cx, cy, k };
  }
  function drawFidLoupe() {
    if (!D) return;
    const { svg, cx, cy, k } = loupe(fidL, 'fid', D.fd, D.clear, D.minClear, true);
    const bad = D.fd < 1 || D.fd > 3;
    // dot handle (right edge) and clear-area handle (lower right)
    const dotH = sv(svg, 'g', { class: `fp-lh${bad ? ' bad' : ''}` });
    sv(dotH, 'circle', { cx: cx + (D.fd / 2) * k, cy, r: 6, class: 'fp-lh-c' });
    dragger(svg, dotH, (px, py) => setNum('fd', 2 * Math.hypot(px - cx, py - cy) / k, 0.05, 0.3, 5), () => { focusKey = 'fd'; dotH.focus({ preventScroll: true }); });
    keyed(dotH, 'fd', D.fd, 0.05, (v) => setNum('fd', v, 0.05, 0.3, 5), `Fiducial dot diameter, ${f(D.fd)} mm`);
    const a = Math.PI / 4;
    const clH = sv(svg, 'g', { class: `fp-lh fp-lh-clear${D.clear < D.minClear - 1e-9 ? ' bad' : ''}` });
    sv(clH, 'circle', { cx: cx + (D.clear / 2) * k * Math.cos(a), cy: cy + (D.clear / 2) * k * Math.sin(a), r: 6, class: 'fp-lh-c' });
    dragger(svg, clH, (px, py) => setNum('clear', 2 * Math.hypot(px - cx, py - cy) / k, 0.1, 0.5, 12), () => { focusKey = 'clear'; clH.focus({ preventScroll: true }); });
    keyed(clH, 'clear', D.clear, 0.1, (v) => setNum('clear', v, 0.1, 0.5, 12), `Clear area diameter, ${f(D.clear)} mm`);
    if (bad) sv(svg, 'text', { x: 8, y: 16, class: 'fp-t fp-sm fp-bad-t' }, '! IPC-7351B: 1.0–3.0 mm dot');
    refocus(svg);
  }
  function drawHoleLoupe() {
    if (!D) return;
    const svg = holeL.svg;
    if (!D.holes.length) {
      svg.replaceChildren();
      const [W, H] = holeL.size();
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      sv(svg, 'text', { x: W / 2, y: H / 2, class: 'fp-t fp-soft', 'text-anchor': 'middle' }, 'No tooling holes');
      return;
    }
    const { cx, cy, k } = loupe(holeL, 'hole', D.hd, D.hKeep, 0, false);
    const g = sv(svg, 'g', { class: 'fp-lh' });
    sv(g, 'circle', { cx: cx + (D.hd / 2) * k, cy, r: 6, class: 'fp-lh-c' });
    dragger(svg, g, (px, py) => setNum('hd', 2 * Math.hypot(px - cx, py - cy) / k, 0.1, 0.5, 8), () => { focusKey = 'hd'; g.focus({ preventScroll: true }); });
    keyed(g, 'hd', D.hd, 0.1, (v) => setNum('hd', v, 0.1, 0.5, 8), `Tooling hole diameter, ${f(D.hd)} mm`);
    sv(svg, 'text', { x: 8, y: 16, class: 'fp-t fp-sm fp-soft' }, 'NPTH · 2.0 / 3.0 / 3.2 mm common');
    refocus(svg);
  }

  // ---------- marks list ----------
  function drawMarks() {
    const all = [...D.fids.map((m) => [m, true]), ...D.holes.map((m) => [m, false])];
    const tbody = h('tbody', {}, all.map(([m, isFid]) => h('tr', { 'data-ref': m.ref, class: `${m.bad ? 'bad' : ''}${hot === m.ref ? ' hot' : ''}`, tabindex: '0',
      onpointerenter: () => setHot(m.ref), onpointerleave: () => setHot(null), onfocus: () => setHot(m.ref), onblur: () => setHot(null) },
    h('td', {}, h('i', { class: isFid ? 'fp-sw-cu' : 'fp-sw-drill' }), m.ref),
    h('td', {}, f(m.x)), h('td', {}, f(m.y)), h('td', {}, f(m.d)), h('td', {}, f(m.keep)))));
    const sp = h('div', { class: 'fp-spans' },
      h('span', {}, 'Fiducial span ', h('b', {}, `X ${f(D.spanX)}`), ' · ', h('b', {}, `Y ${f(D.spanY)}`), ' mm'),
      h('span', {}, 'Local fiducials ', h('b', {}, String(D.local))));
    marks.replaceChildren(h('table', { class: 'fp-table' },
      h('thead', {}, h('tr', {}, ['Ref', 'X', 'Y', '⌀', 'keep'].map((c) => h('th', {}, c)))), tbody), sp);
  }

  ctx.onResult((r) => {
    D = r.drawing;
    const raw = ctx.raw;
    wF.sync(raw.w); hF.sync(raw.h); railF.sync(raw.rail); feF.sync(raw.fe); heF.sync(raw.he); fdF.sync(raw.fd); clF.sync(raw.clear); hdF.sync(raw.hd);
    placeSeg.sync(raw.place); fidSeg.sync(raw.nfid); holeSeg.sync(raw.nhole);
    fineOut.textContent = String(Math.max(0, Math.round(Number(raw.fine) || 0)));
    railF.style.display = raw.place === 'rails' ? '' : 'none';
    stageWarn.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    if (!D) { stage.svg.replaceChildren(); return; }
    stageHint.textContent = `Drag the corner to size the board · drag a mark in from its corner${D.rails ? ' · drag the rail edge' : ''}`;
    holeHead.querySelector('.fp-sub').textContent = D.holes.length ? `${D.holes.length} × NPTH` : 'none';
    pMarks.querySelector('.fp-origin').textContent = D.rails ? `mm from the panel's bottom-left; board at Y ${f(D.board.y)}` : 'mm from the board\'s bottom-left';
    drawStage(); drawFidLoupe(); drawHoleLoupe(); drawMarks();
  });
}
