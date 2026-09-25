// Servo Pulse Mapper: the page is the servo and the wire that drives it.
//   Servo  - the servo seen from above with its horn, big. Turn the horn to
//            set the target angle; the two end stops on the ring are the
//            allowed range (drag them). The angle-to-pulse table is the dial's
//            own scale: every row a tick with its pulse written on it. Where
//            the line needs a pulse outside 500…2500 µs the ring is red.
//   Line   - the calibration itself: pulse against angle, a straight line
//            through the two measured points. Drag a point (or its fields) to
//            recalibrate; the target rides the line.
//   Wire   - one frame of the PWM signal with the timer counter under it: the
//            counter ramps to ARR, the output falls where it passes CCR. The
//            zoom shows the pulse edge; drag it to set the pulse directly.
// Every number shown comes from run()'s result.drawing and result.values.
import { fmtEng } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
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
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const RAD = Math.PI / 180;

const CSS = `
.sp { --tool-horn: #26323d; --tool-horn-ink: #f3f6f9; --tool-body: #d5dde4; --tool-line: var(--tool-s0); --tool-cnt: var(--tool-s2);
  --tool-sig: var(--tool-s1); --tool-stop: #5b6b7a; }
:root[data-theme="dark"] .sp { --tool-horn: #e4ebf1; --tool-horn-ink: #0f151b; --tool-body: #1f2a34; --tool-stop: #8ea0b0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .sp { --tool-horn: #e4ebf1; --tool-horn-ink: #0f151b; --tool-body: #1f2a34; --tool-stop: #8ea0b0; } }
.sp { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.12fr); gap: 12px; align-items: start; }
.sp-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
@media (max-width: 1000px) { .sp { grid-template-columns: minmax(0, 1fr); } .sp-col { display: contents; } .sp-servo { order: 1; } .sp-line { order: 2; } .sp-wire { order: 3; } .sp-warn { order: 4; } .sp-out { order: 5; } }
.sp-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.sp-warn { min-width: 0; } .sp-warn:has(.sp-warns:empty) { display: none; } .sp-out { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.sp-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.sp-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.sp-sub { font-size: 11.5px; color: var(--ink-soft); }
.sp-sub b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.sp-read { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 18px; padding: 10px 12px 2px; font: 500 13px "IBM Plex Mono", ui-monospace, monospace; }
.sp-read .big { font-size: 26px; font-weight: 600; letter-spacing: -0.5px; }
.sp-read .arr { color: var(--ink-soft); font-size: 18px; }
.sp-read small { font-size: 11px; color: var(--ink-soft); font-weight: 400; }
.sp-read .bad { color: var(--danger); }
.sp-svg { display: block; width: 100%; user-select: none; -webkit-user-select: none; touch-action: none; }
.sp-svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.sp-svg text.soft { fill: var(--ink-soft); }
.sp-svg text.sm { font-size: 10px; }
.sp-svg text.b { font-weight: 600; }
.sp-svg .grab { cursor: grab; }
.sp-svg .grab:active { cursor: grabbing; }
.sp-svg .hd:focus { outline: none; }
.sp-svg .hd:focus-visible .ring { stroke: var(--accent); stroke-width: 2.5; stroke-dasharray: 3 2; }
.sp-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 7px 10px 9px; border-top: 1px solid var(--line-soft); font-size: 11.5px; color: var(--ink-soft); }
.sp-f { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.sp-f input { width: 62px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink);
  font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.sp-f input.bad { border-color: var(--danger); }
.sp-f b { font-weight: 600; color: var(--ink); }
.sp-chips { display: inline-flex; gap: 3px; }
.sp-chip { padding: 1px 7px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink-soft); cursor: pointer;
  font: 11px "IBM Plex Mono", ui-monospace, monospace; }
.sp-chip:hover { border-color: var(--ink-soft); color: var(--ink); }
.sp-chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.sp-help { padding: 0 10px 8px; font-size: 11px; color: var(--ink-soft); }
.sp-help kbd { font: 10px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.sp-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.sp-warns div + div { margin-top: 3px; }
.sp-warns:empty { display: none; }
.sp-notes { font-size: 11.5px; color: var(--ink-soft); }
.sp-notes summary { cursor: pointer; }
.sp-notes div { margin-top: 3px; }
.sp .k-out { max-height: 260px; }
`;

export function page(root, ctx) {
  const f = ctx.fmtNum;
  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'sp' });
  root.append(wrap);

  // ---------- inline fields: every input can also be typed ----------
  const fields = {};
  const field = (key, label, unit, width) => {
    const el = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label}${unit ? ` (${unit})` : ''}`,
      style: width ? `width:${width}px` : null, oninput: (e) => ctx.set(key, e.target.value) });
    fields[key] = el;
    return h('label', { class: 'sp-f' }, label, el, unit || null);
  };
  const syncFields = () => {
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(fields)) {
      if (document.activeElement !== el) el.value = raw[k] ?? '';
      const t = String(raw[k] ?? '').trim();
      el.classList.toggle('bad', t !== '' && ctx.parseEng(t) == null);
    }
  };
  const chips = (list, keyOf, onPick) => {
    const btns = list.map(([label, val]) => h('button', { class: 'sp-chip', type: 'button', onclick: () => onPick(val) }, label));
    const box = h('span', { class: 'sp-chips' }, btns);
    const draw = () => list.forEach(([, val], i) => btns[i].setAttribute('aria-pressed', String(keyOf(val))));
    return { box, draw };
  };

  // ---------- servo card ----------
  const read = h('div', { class: 'sp-read', 'aria-live': 'polite' });
  const dial = s('svg', { class: 'sp-svg', role: 'group', 'aria-label': 'Servo seen from above: turn the horn to set the target angle' });
  const servoCard = h('section', { class: 'sp-card sp-servo' },
    h('div', { class: 'sp-head' }, h('h2', {}, 'Servo'), h('span', { class: 'sp-sub' }, 'seen from above · the scale is the angle-to-pulse table')),
    read, dial,
    h('div', { class: 'sp-fields' }, field('target', 'Target', '°'), field('amin', 'Stops', ''), '…', field('amax', '', '°'), field('step', 'Scale every', '°', 44)),
    h('div', { class: 'sp-help' }, 'Drag the horn, or focus it and press ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' (', h('kbd', {}, 'Shift'),
      ' 10°). Drag an end stop to change the allowed range.'));

  // ---------- calibration line ----------
  const lineSub = h('span', { class: 'sp-sub' });
  const plot = s('svg', { class: 'sp-svg', role: 'group', 'aria-label': 'Calibration line: pulse width against angle' });
  const presets = chips([['1000–2000', [1000, 2000]], ['500–2500', [500, 2500]], ['SG90 544–2400', [544, 2400]]],
    ([q1, q2]) => ctx.input.p1 === q1 && ctx.input.p2 === q2 && ctx.input.a1 === 0 && ctx.input.a2 === 180,
    ([q1, q2]) => ctx.setMany({ a1: '0', p1: String(q1), a2: '180', p2: String(q2) }));
  const lineCard = h('section', { class: 'sp-card sp-line' },
    h('div', { class: 'sp-head' }, h('h2', {}, 'Calibration'), lineSub),
    plot,
    h('div', { class: 'sp-fields' },
      h('b', {}, '1'), field('a1', '', '°', 50), field('p1', '', 'µs', 58),
      h('b', {}, '2'), field('a2', '', '°', 50), field('p2', '', 'µs', 58),
      h('span', { class: 'sp-f' }, '0/180° at', presets.box)),
    h('div', { class: 'sp-help' }, 'Drag a measured point. Focused: ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' angle, ', h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' pulse (',
      h('kbd', {}, 'Shift'), ' ×10). Click the plot to aim the horn there.'));

  // ---------- wire ----------
  const wireSub = h('span', { class: 'sp-sub' });
  const scope = s('svg', { class: 'sp-svg', role: 'group', 'aria-label': 'One PWM frame with the timer counter' });
  const frameChips = chips([['50', '50'], ['100', '100'], ['200', '200'], ['333', '333']], (v) => ctx.input.frame === Number(v), (v) => ctx.set('frame', v));
  const clkChips = chips([['1M', '1M'], ['2M', '2M'], ['4M', '4M']], (v) => ctx.input.tclk === ctx.parseEng(v), (v) => ctx.set('tclk', v));
  const wireCard = h('section', { class: 'sp-card sp-wire' },
    h('div', { class: 'sp-head' }, h('h2', {}, 'Signal and timer'), wireSub),
    scope,
    h('div', { class: 'sp-fields' }, field('frame', 'Frame', 'Hz', 50), frameChips.box, field('tclk', 'Timer clock', 'Hz', 58), clkChips.box),
    h('div', { class: 'sp-help' }, 'Drag the falling edge in the zoom to set the pulse width; the horn follows.'));

  const warns = h('div', { class: 'sp-warns', role: 'status' });
  const notes = h('details', { class: 'sp-notes' });
  wrap.append(h('div', { class: 'sp-col' }, servoCard, h('div', { class: 'sp-warn' }, warns), h('div', { class: 'sp-out' }, ctx.outputs, notes)),
    h('div', { class: 'sp-col' }, lineCard, wireCard));

  let res = null;
  let frozen = null;     // dial / plot geometry kept still while something is dragged
  const onDrag = (move, done) => {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      frozen = null;
      done && done();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const svgPt = (svg, ev, W) => {
    const r = svg.getBoundingClientRect();
    const k = W / r.width;
    return [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k];
  };
  const keepFocus = (svg, draw) => {
    const id = svg.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    svg.replaceChildren();
    draw();
    if (id) svg.querySelector(`[data-id="${id}"]`)?.focus({ preventScroll: true });
  };
  const num = (v, d = 4) => String(Number(Number(v).toPrecision(d)));
  const setAngle = (key, a) => ctx.set(key, num(Math.round(a * 2) / 2, 6));
  const keyStep = (e) => (e.shiftKey ? 10 : 1) * ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key] || 0);

  // Angle range drawn on the dial and the plot: stops, calibration points, a margin.
  const span = (d) => {
    const tg = Number.isFinite(d.target) ? [d.target] : [];
    let a = Math.min(d.lo, d.hi, d.a1, d.a2, ...tg), b = Math.max(d.lo, d.hi, d.a1, d.a2, ...tg);
    const m = Math.max(8, (b - a) * 0.08);
    a -= m; b += m;
    if (b - a > 340) { const c = (a + b) / 2; a = c - 170; b = c + 170; }
    return [a, b];
  };

  // ---------- the servo ----------
  function drawDial() { keepFocus(dial, drawDialInner); }
  function drawDialInner() {
    const d = res && res.drawing;
    const W = Math.max(300, dial.clientWidth || servoCard.clientWidth || 600);
    if (!d) { dial.setAttribute('viewBox', `0 0 ${W} 80`); dial.setAttribute('height', 80); dial.append(s('text', { x: 14, y: 44, class: 'soft' }, 'Give two calibration points to draw the servo.')); return; }
    const geo = frozen?.dial || (() => {
      const [a0, a1] = span(d);
      const off = 90 - (d.a1 + d.a2) / 2;       // the middle of the calibration points points up
      return { a0, a1, off };
    })();
    const { a0, a1, off } = geo;
    const dir = (a) => (a + off) * RAD;        // screen angle, counter-clockwise from +x
    const R = Math.max(70, Math.min(W * 0.34, W / 2 - 92, 230));
    const Rs = R + 14, Rl = R + 34;            // scale ring, label ring
    // Fit the height to what is drawn: the arc and the servo body.
    const pts = [];
    for (let a = a0; a <= a1 + 1e-9; a += (a1 - a0) / 60) pts.push(Math.sin(dir(a)));
    const up = Math.max(0.55, ...pts) * (Rl + 22), down = Math.max(0.74 * R, -Math.min(...pts) * (Rl + 22));
    const cx = W / 2, cy = up + 14, H = Math.round(cy + down + 14);
    dial.setAttribute('viewBox', `0 0 ${W} ${H}`);
    dial.setAttribute('height', H);
    const P = (a, r) => [cx + r * Math.cos(dir(a)), cy - r * Math.sin(dir(a))];
    const arc = (b0, b1, r) => {
      const [x0, y0] = P(b0, r), [x1, y1] = P(b1, r);
      return `M${x0},${y0}A${r},${r} 0 ${Math.abs(b1 - b0) > 180 ? 1 : 0} 0 ${x1},${y1}`;
    };
    const band = (b0, b1, r0, r1) => {
      const [x0, y0] = P(b0, r1), [x1, y1] = P(b1, r1), [x2, y2] = P(b1, r0), [x3, y3] = P(b0, r0);
      const L = Math.abs(b1 - b0) > 180 ? 1 : 0;
      return `M${x0},${y0}A${r1},${r1} 0 ${L} 0 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${L} 1 ${x3},${y3}Z`;
    };

    // Servo body, from above: case with two mounting ears; the shaft at the centre.
    const bw = R * 0.5, bh = R * 0.92, by = cy - bh * 0.22;
    dial.append(s('rect', { x: cx - bw / 2 - R * 0.2, y: by + bh * 0.16, width: bw + R * 0.4, height: R * 0.13, rx: 3, fill: 'var(--tool-body)', stroke: 'var(--line)' }));
    for (const sx of [-1, 1]) dial.append(s('circle', { cx: cx + sx * (bw / 2 + R * 0.1), cy: by + bh * 0.16 + R * 0.065, r: R * 0.03, fill: 'var(--surface)', stroke: 'var(--line)' }));
    dial.append(s('rect', { x: cx - bw / 2, y: by, width: bw, height: bh, rx: 6, fill: 'var(--tool-body)', stroke: 'var(--line)' }));
    dial.append(s('circle', { cx, cy, r: R * 0.2, fill: 'none', stroke: 'var(--line)' }));

    // Scale ring: allowed range, the rest, and where the pulse leaves 500…2500 µs.
    dial.append(s('path', { d: band(a0, a1, Rs - 6, Rs + 6), fill: 'var(--sunken)', stroke: 'var(--line)' }));
    const lo = Math.min(d.lo, d.hi), hi = Math.max(d.lo, d.hi);
    dial.append(s('path', { d: band(clamp(lo, a0, a1), clamp(hi, a0, a1), Rs - 6, Rs + 6), fill: 'var(--ok)', 'fill-opacity': 0.22, stroke: 'var(--ok)', 'stroke-opacity': 0.6 }));
    const out = [];
    const aLow = Math.min(d.a500, d.a2500), aHigh = Math.max(d.a500, d.a2500);
    if (aLow > a0) out.push([a0, Math.min(aLow, a1)]);
    if (aHigh < a1) out.push([Math.max(aHigh, a0), a1]);
    for (const [b0, b1] of out) {
      if (b1 - b0 < 0.2) continue;
      dial.append(s('path', { d: band(b0, b1, Rs - 6, Rs + 6), fill: 'var(--danger)', 'fill-opacity': 0.35 }));
      const mid = (b0 + b1) / 2, [tx, ty] = P(mid, Rs - 16);
      if (Math.abs(b1 - b0) > 12) dial.append(s('text', { x: tx, y: ty + 3, 'text-anchor': 'middle', class: 'sm', style: 'fill:var(--danger)' }, (mid < (aLow + aHigh) / 2) === (d.k > 0) ? '<500µs' : '>2500µs'));
    }

    // Ticks: the table rows, with the pulse at each.
    const rows = d.rows || [{ a: lo, p: d.pmin }, { a: hi, p: d.pmax }];
    const arcPx = (da) => Math.abs(da) * RAD * Rl;
    const every = Math.max(1, Math.ceil(46 / Math.max(1, arcPx(rows.length > 1 ? rows[1].a - rows[0].a : 30))));
    rows.forEach((r, i) => {
      const [x0, y0] = P(r.a, Rs + 6), [x1, y1] = P(r.a, Rs + 12);
      dial.append(s('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: 'var(--ink-soft)' }));
      if (i % every && i !== rows.length - 1) return;
      const [lx, ly] = P(r.a, Rl + 8), [px, py] = P(r.a, Rs - 22);
      const c = Math.cos(dir(r.a));
      const anchor = c > 0.35 ? 'start' : c < -0.35 ? 'end' : 'middle';
      dial.append(s('text', { x: lx, y: ly + 4, 'text-anchor': anchor, class: 'b' }, `${f(r.a, 4)}°`));
      dial.append(s('text', { x: lx, y: ly + 16, 'text-anchor': anchor, class: 'soft sm' }, `${f(r.p, 4)}`));
      if (R > 150) dial.append(s('line', { x1: px, y1: py, x2: P(r.a, Rs - 8)[0], y2: P(r.a, Rs - 8)[1], stroke: 'var(--line)' }));
    });
    // Calibration points on the ring.
    for (const [a, p, n] of [[d.a1, d.p1, 1], [d.a2, d.p2, 2]]) {
      if (a < a0 - 1e-9 || a > a1 + 1e-9) continue;
      const [x, y] = P(a, Rs - 20);
      dial.append(s('path', { d: `M${x},${y - 7}l7,7l-7,7l-7,-7z`, fill: 'var(--tool-line)', stroke: 'var(--surface)' }, null));
      dial.append(s('text', { x, y: y + 3.5, 'text-anchor': 'middle', class: 'sm b', style: 'fill:var(--surface)' }, String(n)));
    }

    // End stops: draggable tabs on the ring.
    const stop = (key, a, label) => {
      const [x0, y0] = P(a, Rs - 12), [x1, y1] = P(a, Rs + 16);
      const g = s('g', { class: 'hd grab', tabindex: 0, 'data-id': key, role: 'slider', 'aria-label': label, 'aria-valuenow': a, 'aria-valuetext': `${f(a, 4)}°` });
      g.append(s('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: 'transparent', 'stroke-width': 18 }));
      g.append(s('line', { class: 'ring', x1: x0, y1: y0, x2: x1, y2: y1, stroke: 'var(--tool-stop)', 'stroke-width': 4, 'stroke-linecap': 'round' }));
      g.append(s('title', {}, `${label}: ${f(a, 4)}°`));
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation(); g.focus({ preventScroll: true });
        frozen = { dial: geo };
        onDrag((ev) => setAngle(key, pointerAngle(ev)), drawDial);
      });
      g.addEventListener('keydown', (e) => { const k = keyStep(e); if (!k) return; e.preventDefault(); setAngle(key, (ctx.input[key] ?? a) + k); });
      dial.append(g);
    };
    stop('amin', d.lo, 'Allowed angle min');
    stop('amax', d.hi, 'Allowed angle max');

    // Requested target outside the stops: a ghost where it would have gone.
    const bad = d.pw < 500 || d.pw > 2500;
    if (d.clamped && d.target >= a0 && d.target <= a1) {
      const [gx, gy] = P(d.target, R * 0.92);
      dial.append(s('line', { x1: cx, y1: cy, x2: gx, y2: gy, stroke: 'var(--danger)', 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
      dial.append(s('text', { x: gx, y: gy - 6, 'text-anchor': 'middle', class: 'sm', style: 'fill:var(--danger)' }, `${f(d.target, 4)}° asked`));
    }

    // The horn, at the target.
    const horn = s('g', { class: 'hd grab', tabindex: 0, 'data-id': 'horn', role: 'slider', 'aria-label': 'Horn: target angle',
      'aria-valuemin': lo, 'aria-valuemax': hi, 'aria-valuenow': d.t, 'aria-valuetext': `${f(d.t, 4)}°, ${f(d.pw, 5)} µs` });
    const L = R * 0.94, r0 = R * 0.13, r1 = R * 0.06;
    const ang = -(d.t + off);                  // svg rotation is clockwise
    const g2 = s('g', { transform: `translate(${cx},${cy}) rotate(${ang})` });
    g2.append(s('path', { class: 'ring', d: `M0,${-r0}L${L},${-r1}A${r1},${r1} 0 0 1 ${L},${r1}L0,${r0}A${r0},${r0} 0 0 1 0,${-r0}Z`,
      fill: 'var(--tool-horn)', stroke: bad ? 'var(--danger)' : 'var(--tool-horn)', 'stroke-width': 2 }));
    for (let i = 1; i <= 5; i++) g2.append(s('circle', { cx: L * (0.3 + i * 0.13), cy: 0, r: Math.max(1.8, R * 0.012), fill: 'var(--tool-body)' }));
    g2.append(s('circle', { cx: 0, cy: 0, r: r0 * 0.55, fill: 'var(--tool-body)' }));
    g2.append(s('circle', { cx: 0, cy: 0, r: r0 * 0.2, fill: 'var(--tool-horn)' }));
    horn.append(g2);
    // The pulse this angle needs, at the tip.
    const [tx, ty] = P(d.t, L * 0.62);
    horn.append(s('rect', { x: tx - 38, y: ty - 10, width: 76, height: 18, rx: 9, fill: bad ? 'var(--danger)' : 'var(--accent)' }));
    horn.append(s('text', { x: tx, y: ty + 3.5, 'text-anchor': 'middle', class: 'b', style: 'fill:var(--accent-ink)' }, `${f(d.pw, 5)} µs`));
    dial.append(horn);

    const pointerAngle = (ev) => {
      const [x, y] = svgPt(dial, ev, W);
      let a = Math.atan2(cy - y, x - cx) / RAD - off;
      const mid = (a0 + a1) / 2;
      while (a < mid - 180) a += 360;
      while (a > mid + 180) a -= 360;
      return a;
    };
    const turn = (e) => {
      e.preventDefault(); horn.focus({ preventScroll: true });
      frozen = { dial: geo };
      const mv = (ev) => { const a = clamp(pointerAngle(ev), lo, hi); setAngle('target', Math.round(a)); };
      mv(e);
      onDrag(mv, drawDial);
    };
    horn.addEventListener('pointerdown', turn);
    const surf = s('circle', { cx, cy, r: Rs + 6, fill: 'transparent', class: 'grab' });
    surf.addEventListener('pointerdown', turn);
    dial.insertBefore(surf, dial.firstChild);
    horn.addEventListener('keydown', (e) => {
      let v = null;
      const k = keyStep(e);
      if (k) v = d.t + k;
      if (e.key === 'Home') v = lo;
      if (e.key === 'End') v = hi;
      if (v == null) return;
      e.preventDefault();
      setAngle('target', clamp(v, lo, hi));
    });
  }

  // ---------- the calibration line ----------
  function drawPlot() { keepFocus(plot, drawPlotInner); }
  function drawPlotInner() {
    const d = res && res.drawing;
    const W = Math.max(300, plot.clientWidth || lineCard.clientWidth || 600);
    const H = W < 520 ? 210 : 250;
    plot.setAttribute('viewBox', `0 0 ${W} ${H}`);
    plot.setAttribute('height', H);
    if (!d) { lineSub.textContent = ''; plot.append(s('text', { x: 14, y: 40, class: 'soft' }, 'No line: see the message below.')); return; }
    const geo = frozen?.plot || (() => {
      const [a0, a1] = span(d);
      const pa = d.p1 + (a0 - d.a1) * d.k, pb = d.p1 + (a1 - d.a1) * d.k;
      let y0 = Math.min(400, pa, pb, d.p1, d.p2), y1 = Math.max(2600, pa, pb, d.p1, d.p2);
      y0 = Math.max(0, Math.floor(y0 / 250) * 250); y1 = Math.ceil(y1 / 250) * 250;
      return { a0, a1, y0, y1 };
    })();
    const { a0, a1, y0, y1 } = geo;
    const Lm = 50, Rm = 14, Tm = 12, Bm = 30;
    const X = (a) => Lm + ((a - a0) / (a1 - a0)) * (W - Lm - Rm);
    const Y = (p) => Tm + (1 - (p - y0) / (y1 - y0)) * (H - Tm - Bm);
    const inv = (x, y) => [a0 + ((x - Lm) / (W - Lm - Rm)) * (a1 - a0), y0 + (1 - (y - Tm) / (H - Tm - Bm)) * (y1 - y0)];
    // Bands: outside 500…2500 µs; the allowed angles.
    const clipY = (p) => clamp(Y(p), Tm, H - Bm);
    plot.append(s('rect', { x: Lm, y: Tm, width: W - Lm - Rm, height: clipY(2500) - Tm, fill: 'var(--danger)', 'fill-opacity': 0.08 }));
    plot.append(s('rect', { x: Lm, y: clipY(500), width: W - Lm - Rm, height: H - Bm - clipY(500), fill: 'var(--danger)', 'fill-opacity': 0.08 }));
    const lo = Math.min(d.lo, d.hi), hi = Math.max(d.lo, d.hi);
    plot.append(s('rect', { x: X(lo), y: Tm, width: X(hi) - X(lo), height: H - Tm - Bm, fill: 'var(--ok)', 'fill-opacity': 0.08 }));
    // Grid.
    const pStep = y1 - y0 > 2500 ? 500 : 250;
    for (let p = Math.ceil(y0 / pStep) * pStep; p <= y1 + 1e-9; p += pStep) {
      plot.append(s('line', { x1: Lm, x2: W - Rm, y1: Y(p), y2: Y(p), stroke: p === 500 || p === 2500 ? 'var(--danger)' : 'var(--line-soft)', 'stroke-opacity': p === 500 || p === 2500 ? 0.5 : 1 }));
      plot.append(s('text', { x: Lm - 6, y: Y(p) + 3.5, 'text-anchor': 'end', class: 'soft sm' }, String(p)));
    }
    const aStep = [5, 10, 15, 30, 45, 60, 90].find((st) => ((a1 - a0) / st) * 44 <= W - Lm - Rm) || 90;
    for (let a = Math.ceil(a0 / aStep) * aStep; a <= a1 + 1e-9; a += aStep) {
      plot.append(s('line', { x1: X(a), x2: X(a), y1: Tm, y2: H - Bm, stroke: 'var(--line-soft)' }));
      plot.append(s('text', { x: X(a), y: H - Bm + 14, 'text-anchor': 'middle', class: 'soft sm' }, `${a}°`));
    }
    plot.append(s('text', { x: 6, y: Tm + 8, class: 'soft sm' }, 'µs'));
    plot.append(s('text', { x: W - Rm, y: H - 3, 'text-anchor': 'end', class: 'soft sm' }, 'angle'));
    // The line: solid between the measured points, dashed where it is extrapolated.
    const pa = (a) => d.p1 + (a - d.a1) * d.k;
    const clipPath = s('clipPath', { id: 'sp-clip' });
    clipPath.append(s('rect', { x: Lm, y: Tm, width: W - Lm - Rm, height: H - Tm - Bm }));
    plot.append(clipPath);
    const lg = s('g', { 'clip-path': 'url(#sp-clip)' });
    plot.append(lg);
    const cMin = Math.min(d.a1, d.a2), cMax = Math.max(d.a1, d.a2);
    const seg = (b0, b1, dash) => { if (b1 > b0) lg.append(s('line', { x1: X(b0), y1: Y(pa(b0)), x2: X(b1), y2: Y(pa(b1)), stroke: 'var(--tool-line)', 'stroke-width': 2, 'stroke-dasharray': dash })); };
    seg(a0, cMin, '5 4'); seg(cMin, cMax, null); seg(cMax, a1, '5 4');
    // Table rows as dots.
    for (const r of d.rows || []) lg.append(s('circle', { cx: X(r.a), cy: Y(r.p), r: 2.5, fill: 'var(--tool-line)', 'fill-opacity': 0.55 }));
    // Target.
    const tx = X(d.t), ty = Y(d.pw);
    lg.append(s('line', { x1: tx, x2: tx, y1: H - Bm, y2: ty, stroke: 'var(--accent)', 'stroke-dasharray': '3 3' }));
    lg.append(s('line', { x1: Lm, x2: tx, y1: ty, y2: ty, stroke: 'var(--accent)', 'stroke-dasharray': '3 3' }));
    lg.append(s('circle', { cx: tx, cy: ty, r: 4.5, fill: 'var(--accent)' }));
    const tl = `${f(d.t, 4)}° → ${f(d.pw, 5)} µs`;
    const tlx = tx + 8 + tl.length * 6.7 > W - Rm ? tx - 8 : tx + 8;
    lg.append(s('text', { x: tlx, y: ty + (d.k > 0 ? 16 : -8), 'text-anchor': tlx < tx ? 'end' : 'start', class: 'b', style: 'fill:var(--accent)' }, tl));
    // Click anywhere to aim.
    const surf = s('rect', { x: Lm, y: Tm, width: W - Lm - Rm, height: H - Tm - Bm, fill: 'transparent', style: 'cursor:crosshair' });
    surf.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      frozen = { plot: geo };
      const mv = (ev) => { const [a] = inv(...svgPt(plot, ev, W)); setAngle('target', Math.round(clamp(a, lo, hi))); };
      mv(e);
      onDrag(mv, drawPlot);
    });
    lg.insertBefore(surf, lg.firstChild);
    // The two measured points.
    for (const [ka, kp, a, p, n] of [['a1', 'p1', d.a1, d.p1, 1], ['a2', 'p2', d.a2, d.p2, 2]]) {
      const x = X(a), y = Y(p);
      const g = s('g', { class: 'hd grab', tabindex: 0, 'data-id': `cal${n}`, role: 'group', 'aria-label': `Calibration point ${n}: ${f(a, 4)}°, ${f(p, 5)} µs. Arrow keys move it.` });
      g.append(s('circle', { cx: x, cy: y, r: 14, fill: 'transparent' }));
      g.append(s('path', { class: 'ring', d: `M${x},${y - 9}l9,9l-9,9l-9,-9z`, fill: 'var(--tool-line)', stroke: 'var(--surface)', 'stroke-width': 1.5 }));
      g.append(s('text', { x, y: y + 3.5, 'text-anchor': 'middle', class: 'sm b', style: 'fill:var(--surface)' }, String(n)));
      const lab = `${f(a, 4)}°, ${f(p, 5)} µs`;
      const right = x + 14 + lab.length * 6.7 < W - Rm;
      const below = right === (d.k > 0);
      g.append(s('text', { x: right ? x + 13 : x - 13, y: below ? y + 20 : y - 10, 'text-anchor': right ? 'start' : 'end', class: 'b', style: 'fill:var(--tool-line)' }, lab));
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation(); g.focus({ preventScroll: true });
        frozen = { plot: geo };
        onDrag((ev) => {
          const [na, np] = inv(...svgPt(plot, ev, W));
          const other = n === 1 ? d.a2 : d.a1;
          let aa = Math.round(na);
          if (aa === other) aa += na > other ? 1 : -1;
          ctx.setMany({ [ka]: String(aa), [kp]: String(Math.round(clamp(np, 100, 4000) / 2) * 2) });
        }, drawPlot);
      });
      g.addEventListener('keydown', (e) => {
        const m = e.shiftKey ? 10 : 1;
        const cur = ctx.input;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          let aa = (cur[ka] ?? a) + (e.key === 'ArrowRight' ? m : -m);
          if (aa === (n === 1 ? cur.a2 : cur.a1)) aa += e.key === 'ArrowRight' ? 1 : -1;
          ctx.set(ka, num(aa, 6));
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          ctx.set(kp, num(Math.max(1, (cur[kp] ?? p) + (e.key === 'ArrowUp' ? m : -m)), 6));
        }
      });
      plot.append(g);
    }
    lineSub.replaceChildren('slope ', h('b', {}, `${f(d.k, 4)} µs/°`), ' · range used ', h('b', {}, `${f(d.pmin, 4)}–${f(d.pmax, 4)} µs`));
  }

  // ---------- the wire ----------
  function drawScope() { keepFocus(scope, drawScopeInner); }
  function drawScopeInner() {
    const d = res && res.drawing;
    const W = Math.max(300, scope.clientWidth || wireCard.clientWidth || 600);
    const narrow = W < 520;
    const H = narrow ? 272 : 296;
    scope.setAttribute('viewBox', `0 0 ${W} ${H}`);
    scope.setAttribute('height', H);
    if (!d || !(d.period > 0)) { wireSub.textContent = ''; scope.append(s('text', { x: 14, y: 40, class: 'soft' }, 'Give the frame rate to draw the signal.')); return; }
    const val = (label) => (res.values || []).find((v) => v.label === label);
    const Lm = narrow ? 50 : 64, Rm = 14;
    const timer = d.tclk > 0;
    // Row 1: the whole frame, the start of the next one, and the counter.
    const T = d.period * 1.12;
    const X1 = (t) => Lm + (t / T) * (W - Lm - Rm);
    const yHi = 18, yLo = 50;
    scope.append(s('text', { x: 6, y: 38, class: 'soft sm' }, 'PWM'));
    const trace = (pts, X, a, b) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${v ? a : b}`).join('');
    const one = [[0, 0], [0, 1], [d.pw, 1], [d.pw, 0], [d.period, 0], [d.period, 1], [Math.min(T, d.period + d.pw), 1]];
    if (d.period + d.pw < T) one.push([d.period + d.pw, 0], [T, 0]);
    scope.append(s('path', { d: trace(one, X1, yHi, yLo), fill: 'none', stroke: 'var(--tool-sig)', 'stroke-width': 2 }));
    // Period dimension.
    const yD = yLo + 16;
    scope.append(s('path', { d: `M${X1(0)},${yD}H${X1(d.period)}M${X1(0)},${yD - 4}v8M${X1(d.period)},${yD - 4}v8`, stroke: 'var(--ink-soft)', fill: 'none' }));
    const perLab = `frame ${f(d.period, 5)} µs · ${f(d.frame, 4)} Hz · duty ${f(d.duty * 100, 4)} %`;
    scope.append(s('rect', { x: X1(d.period / 2) - perLab.length * 3.3 - 4, y: yD - 8, width: perLab.length * 6.6 + 8, height: 15, fill: 'var(--surface)' }));
    scope.append(s('text', { x: X1(d.period / 2), y: yD + 4, 'text-anchor': 'middle', class: 'sm' }, perLab));
    let yZ = yD + 22;
    if (timer) {
      // Counter sawtooth: 0 → ARR over the frame, CCR as a level.
      const yC0 = yD + 70, yC1 = yD + 18;
      const Yc = (c) => yC0 - (c / d.counts) * (yC0 - yC1);
      scope.append(s('text', { x: 6, y: yC0 - 18, class: 'soft sm' }, 'counter'));
      scope.append(s('path', { d: `M${X1(0)},${Yc(0)}L${X1(d.period)},${Yc(d.counts)}L${X1(d.period)},${Yc(0)}L${X1(T)},${Yc(d.counts * (T - d.period) / d.period)}`,
        fill: 'none', stroke: 'var(--tool-cnt)', 'stroke-width': 1.5 }));
      scope.append(s('line', { x1: X1(0), x2: X1(T), y1: Yc(d.cmp), y2: Yc(d.cmp), stroke: 'var(--accent)', 'stroke-dasharray': '4 3' }));
      const arrBad = d.counts > 65536;
      scope.append(s('text', { x: X1(d.period) - 4, y: Yc(d.counts) + 2, 'text-anchor': 'end', class: 'sm b', style: `fill:${arrBad ? 'var(--danger)' : 'var(--tool-cnt)'}` },
        `ARR ${d.counts - 1}${arrBad ? ' > 16 bit' : ''}`));
      scope.append(s('text', { x: X1(d.pw) + 6, y: Yc(d.cmp) - 4, class: 'sm b', style: 'fill:var(--accent)' }, `CCR ${d.cmp}`));
      yZ = yC0 + 16;
    }
    // Row 2: zoom on the pulse.
    const zEnd = Math.max(2800, Math.ceil((d.pmax + 250) / 250) * 250);
    const X2 = (t) => Lm + (t / zEnd) * (W - Lm - Rm);
    const zHi = yZ + 30, zLo = yZ + 60;
    scope.append(s('line', { x1: Lm, x2: W - Rm, y1: yZ + 4, y2: yZ + 4, stroke: 'var(--line-soft)' }));
    scope.append(s('text', { x: 6, y: zHi + 20, class: 'soft sm' }, 'zoom'));
    // The usual servo window and the range this setup uses.
    scope.append(s('rect', { x: X2(0), y: zHi - 8, width: X2(500) - X2(0), height: zLo - zHi + 16, fill: 'var(--danger)', 'fill-opacity': 0.07 }));
    scope.append(s('rect', { x: X2(2500), y: zHi - 8, width: X2(zEnd) - X2(2500), height: zLo - zHi + 16, fill: 'var(--danger)', 'fill-opacity': 0.07 }));
    scope.append(s('rect', { x: X2(d.pmin), y: zHi - 8, width: Math.max(1, X2(d.pmax) - X2(d.pmin)), height: zLo - zHi + 16, fill: 'var(--ok)', 'fill-opacity': 0.12 }));
    scope.append(s('path', { d: trace([[0, 0], [0, 1], [d.pw, 1], [d.pw, 0], [zEnd, 0]], X2, zHi, zLo).replace(/^M[^L]*/, `M${X2(0) - 0},${zLo}`),
      fill: 'none', stroke: 'var(--tool-sig)', 'stroke-width': 2 }));
    // Timer ticks as a staircase when they are wide enough to see.
    if (timer) {
      const pxTick = (X2(d.tick) - X2(0));
      if (pxTick >= 3) {
        let p = `M${X2(0)},${zLo + 10}`;
        for (let t = 0; t < zEnd; t += d.tick) p += `V${zLo + 10 - Math.min(6, 6)}H${X2(Math.min(zEnd, t + d.tick))}V${zLo + 10}`;
        scope.append(s('path', { d: p, fill: 'none', stroke: 'var(--tool-cnt)', 'stroke-opacity': 0.6 }));
      }
    }
    // Axis.
    const yA = zLo + 28;
    for (let t = 0; t <= zEnd + 1e-9; t += 500) {
      scope.append(s('line', { x1: X2(t), x2: X2(t), y1: yA - 4, y2: yA, stroke: 'var(--ink-soft)' }));
      if (!narrow || t % 1000 === 0) scope.append(s('text', { x: X2(t), y: yA + 11, 'text-anchor': 'middle', class: 'soft sm' }, `${t}`));
    }
    scope.append(s('text', { x: W - Rm, y: yA - 7, 'text-anchor': 'end', class: 'soft sm' }, 'µs'));
    scope.append(s('text', { x: X2((d.pmin + d.pmax) / 2), y: zLo + 20, 'text-anchor': 'middle', class: 'sm', style: 'fill:var(--ok)' }, `${f(d.pmin, 4)}…${f(d.pmax, 4)} used`));
    // The falling edge: a handle.
    const bad = d.pw < 500 || d.pw > 2500;
    const ex = X2(d.pw);
    const edge = s('g', { class: 'hd grab', tabindex: 0, 'data-id': 'edge', role: 'slider', 'aria-label': 'Pulse width', 'aria-valuenow': d.pw, 'aria-valuetext': `${f(d.pw, 5)} µs` });
    edge.append(s('rect', { x: ex - 9, y: zHi - 12, width: 18, height: zLo - zHi + 24, fill: 'transparent' }));
    edge.append(s('line', { class: 'ring', x1: ex, x2: ex, y1: zHi - 10, y2: zLo + 4, stroke: bad ? 'var(--danger)' : 'var(--accent)', 'stroke-width': 3 }));
    const lab = `${f(d.pw, 5)} µs${timer ? ` = ${d.cmp} ticks` : ''}`;
    const right = ex + 10 + lab.length * 6.7 < W - Rm;
    edge.append(s('text', { x: right ? ex + 6 : ex - 6, y: zHi - 13, 'text-anchor': right ? 'start' : 'end', class: 'b', style: `fill:${bad ? 'var(--danger)' : 'var(--accent)'}` }, lab));
    scope.append(edge);
    const lo = Math.min(d.lo, d.hi), hi = Math.max(d.lo, d.hi);
    const toAngle = (pw) => clamp(d.a1 + (pw - d.p1) / d.k, lo, hi);
    edge.addEventListener('pointerdown', (e) => {
      e.preventDefault(); edge.focus({ preventScroll: true });
      const r = scope.getBoundingClientRect();
      onDrag((ev) => {
        const x = (ev.clientX - r.left) * (W / r.width);
        const pw = ((x - Lm) / (W - Lm - Rm)) * zEnd;
        setAngle('target', Math.round(toAngle(pw) * 2) / 2);
      }, drawScope);
    });
    edge.addEventListener('keydown', (e) => {
      const k = keyStep(e);
      if (!k) return;
      e.preventDefault();
      setAngle('target', clamp(d.t + k * Math.sign(d.k), lo, hi));
    });

    const tick = val('Angle per timer tick');
    wireSub.replaceChildren(timer ? h('span', {}, 'one tick ', h('b', {}, fmtEng(d.tick * 1e-6, 's')), ' = ', h('b', { style: d.degPerTick > 1 ? 'color:var(--danger)' : null }, `${tick ? tick.value : f(d.degPerTick, 3)}°`)) : 'give the timer clock for ARR and CCR');
  }

  // ---------- readout, warnings, notes ----------
  function drawRead() {
    const d = res && res.drawing;
    const val = (label) => (res?.values || []).find((v) => v.label === label);
    if (!d) { read.replaceChildren(h('span', { class: 'sp-sub' }, 'No calibration line yet.')); return; }
    const bad = d.pw < 500 || d.pw > 2500;
    const pw = val('Pulse width'), ccr = val('Compare value (CCR)'), duty = val('Duty cycle');
    read.replaceChildren(
      h('span', { class: 'big' }, `${f(d.t, 4)}°`), h('span', { class: 'arr' }, '→'),
      h('span', { class: `big${bad ? ' bad' : ''}` }, pw ? pw.value : f(d.pw, 5), h('small', {}, ' µs')),
      ccr ? h('span', {}, h('small', {}, 'CCR '), ccr.value) : '',
      duty ? h('span', {}, h('small', {}, 'duty '), duty.value, h('small', {}, ' %')) : '',
      d.clamped ? h('small', { style: 'color:var(--danger)' }, `clamped from ${f(d.target, 4)}°`) : '');
  }
  function drawText() {
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }

  const draw = () => { drawRead(); drawDial(); drawPlot(); drawScope(); drawText(); presets.draw(); frameChips.draw(); clkChips.draw(); };
  ctx.onResult((r) => { res = r; syncFields(); draw(); });
  let lastW = '';
  new ResizeObserver(() => {
    const w = `${servoCard.clientWidth}/${lineCard.clientWidth}`;
    if (w !== lastW) { lastW = w; drawDial(); drawPlot(); drawScope(); }
  }).observe(wrap);
}
