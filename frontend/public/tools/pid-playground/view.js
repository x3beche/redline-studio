// PID Tuning Playground: the page is the loop and what it does.
//   Loop   - the block diagram, setpoint -> sum -> PID -> output limits ->
//            (+ load) -> plant -> y, fed back. Every gain and plant parameter
//            is a number on its block that you scrub: drag it left or right
//            (log scale), or focus it and press the arrow keys. The plant's
//            kind is chosen on the plant block.
//   Scope  - the closed-loop step response live, with the curve from before
//            the last change kept as a ghost. Rise (10-90 %), the peak and the
//            2 % settling band are drawn where they were measured; drag the
//            setpoint level, the output limits and the load step in time.
//   Readout- the measurements, the SIMC / Ziegler-Nichols gains for this
//            plant with their simulated overshoot (click one to try it), the
//            messages, every input as a form, and the outputs.
// All numbers drawn come from run()'s result (sim, values, tuning).

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
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

const CSS = `
.pg { --tool-y: #1f4ed8; --tool-u: #d97706; --tool-ghost: #8a97a5; --tool-p: #1f4ed8; --tool-i: #0f9d8a; --tool-d: #a23fbf; --tool-plant: #5b6b7a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .pg { --tool-y: #7ea2ff; --tool-u: #f0a33a; --tool-ghost: #5d6d7c; --tool-p: #7ea2ff; --tool-i: #3cc7b3; --tool-d: #c982e0; --tool-plant: #8ea0b0; } }
:root[data-theme="dark"] .pg { --tool-y: #7ea2ff; --tool-u: #f0a33a; --tool-ghost: #5d6d7c; --tool-p: #7ea2ff; --tool-i: #3cc7b3; --tool-d: #c982e0; --tool-plant: #8ea0b0; }
.pg { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pg-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.pg-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.pg-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.pg-sub { font-size: 11.5px; color: var(--ink-soft); }
.pg-sub b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.pg-right { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.pg svg.pg-draw { display: block; width: 100%; user-select: none; -webkit-user-select: none; }
.pg svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.pg svg text.soft { fill: var(--ink-soft); }
.pg svg text.big { font-size: 15px; font-weight: 600; }
.pg svg text.title { font: 600 11px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); letter-spacing: .04em; }
.pg svg .scrub { cursor: ew-resize; touch-action: none; }
.pg svg .scrub:hover .pill { stroke: var(--ink-soft); }
.pg svg .scrub.active .pill { stroke: var(--accent); fill: color-mix(in srgb, var(--accent) 14%, var(--surface)); }
.pg svg .vdrag { cursor: ns-resize; touch-action: none; }
.pg svg .hdrag { cursor: ew-resize; touch-action: none; }
.pg svg .tab { cursor: pointer; }
.pg svg [tabindex]:focus { outline: none; }
.pg svg [tabindex]:focus-visible .pill, .pg svg [tabindex]:focus-visible .ring { stroke: var(--accent); stroke-width: 2; stroke-dasharray: 3 2; }
.pg-help { padding: 4px 10px 7px; font-size: 11.5px; color: var(--ink-soft); }
.pg-help kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.pg-body { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 10px; align-items: start; }
@media (max-width: 980px) { .pg-body { grid-template-columns: minmax(0, 1fr); } }
.pg-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pg-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--ink-soft); }
.pg-legend i { display: inline-block; width: 14px; height: 0; border-top: 2px solid; margin-right: 4px; vertical-align: 3px; }
.pg-read { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line-soft); }
.pg-fig { background: var(--surface); padding: 5px 10px; min-width: 0; }
.pg-fig span { display: block; font-size: 10.5px; color: var(--ink-soft); }
.pg-fig b { display: block; font: 500 14px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pg-fig em { display: block; font-style: normal; font-size: 10.5px; color: var(--ink-soft); }
.pg-fig.ok b { color: var(--ok); } .pg-fig.warn b { color: var(--warn); } .pg-fig.bad b { color: var(--danger); }
.pg-tune { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px; }
.pg-rule { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; text-align: left; border: 1px solid var(--line); border-radius: 5px;
  background: var(--surface); padding: 5px 8px; cursor: pointer; }
.pg-rule:hover { border-color: var(--ink-soft); }
.pg-rule[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.pg-rule .n { font-size: 12px; font-weight: 600; }
.pg-rule .g { grid-column: 1 / -1; font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.pg-rule .r { font: 11px "IBM Plex Mono", ui-monospace, monospace; }
.pg-rule .r.bad { color: var(--danger); }
.pg-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.pg-warns div + div { margin-top: 4px; }
.pg-warns:empty { display: none; }
.pg-all summary, .pg-notes summary { cursor: pointer; font-size: 12px; color: var(--ink-soft); padding: 6px 10px; }
.pg-all .k-form { border: 0; border-top: 1px solid var(--line-soft); border-radius: 0 0 6px 6px; }
.pg-notes { font-size: 11.5px; color: var(--ink-soft); }
.pg-notes summary { padding: 0 2px; }
.pg-notes div { margin-top: 4px; }
.pg .k-out { max-height: 220px; }
`;

// Scrubbable parameters: [key, symbol, unit, floor used when it is 0, may be 0]
const PARAMS = {
  kp: ['Kp', '', 0.05, true], ki: ['Ki', '/s', 0.005, true], kd: ['Kd', 's', 0.005, true],
  K: ['K', '', 0.05, false], tau: ['τ', 's', 0.05, true], theta: ['θ', 's', 0.01, true],
  wn: ['ωn', 'rad/s', 0.05, false], zeta: ['ζ', '', 0.02, true], dt: ['dt', 's', 1e-4, false],
  nf: ['N', '', 1, true],
};
const PLANTS = [['fo', '1st order'], ['so', '2nd order'], ['int', 'integrating']];

function ticks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => span / x <= n + 0.5) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9 * span; v += step) out.push(Number(v.toPrecision(6)));
  return out;
}
const round3 = (v) => (v === 0 ? '0' : String(Number(v.toPrecision(3))));

export function page(root, ctx) {
  const f = (v, d = 3) => ctx.fmtNum(v, d);
  root.append(h('style', {}, CSS));

  let res = null;
  let ghost = null;          // the sim from before the current change
  let active = null;         // key being scrubbed / dragged
  let refocus = null;        // data-key to focus after a redraw
  let pending = null, raf = 0;
  // Coalesce a drag's many changes into one run per frame.
  const setLive = (obj) => {
    pending = { ...(pending || {}), ...obj };
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; const p = pending; pending = null; ctx.setMany(p); });
  };
  const keepGhost = () => { if (res?.sim && !res.sim.diverged) ghost = res.sim; };

  // ---------- loop diagram ----------
  const loopSvg = s('svg', { class: 'pg-draw', role: 'group', 'aria-label': 'Control loop block diagram' });
  const loopSub = h('span', { class: 'pg-sub' });
  const loopCard = h('section', { class: 'pg-card' },
    h('div', { class: 'pg-head' }, h('h2', {}, 'Loop'), loopSub),
    loopSvg,
    h('div', { class: 'pg-help' }, 'Drag any number on a block sideways to scrub it, or focus it and press ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'),
      ' (', h('kbd', {}, 'Shift'), ' for bigger steps, ', h('kbd', {}, '0'), ' sets a gain to zero). Exact values: All inputs, on the right.'));

  // ---------- scope ----------
  const scopeSvg = s('svg', { class: 'pg-draw', role: 'group', 'aria-label': 'Closed-loop step response' });
  const scopeSub = h('span', { class: 'pg-sub' });
  const loadBtn = h('button', { class: 'k-btn', onclick: () => {
    keepGhost();
    if (res?.sim?.dist) ctx.set('dist', '0');
    else ctx.setMany({ dist: round3(-0.2 * (Number(ctx.input.sp) || 1) / (Math.abs(Number(ctx.input.K)) || 1) * 2), tdist: '0' });
  } });
  const legend = h('div', { class: 'pg-legend' },
    h('span', {}, h('i', { style: 'border-color:var(--tool-y)' }), 'output y'),
    h('span', {}, h('i', { style: 'border-color:var(--ink-soft);border-top-style:dashed' }), 'setpoint'),
    h('span', {}, h('i', { style: 'border-color:var(--tool-ghost)' }), 'before the last change'),
    h('span', {}, h('i', { style: 'border-color:var(--tool-u)' }), 'controller u'),
    h('span', {}, h('i', { style: 'border-color:var(--danger);border-top-style:dashed' }), 'u limits'));
  const scopeCard = h('section', { class: 'pg-card' },
    h('div', { class: 'pg-head' }, h('h2', {}, 'Step response'), scopeSub, h('span', { class: 'pg-right' }, loadBtn)),
    h('div', { class: 'pg-head', style: 'padding:4px 10px' }, legend),
    scopeSvg,
    h('div', { class: 'pg-help' }, 'Drag the setpoint handle up or down, the dashed u limits in the lower panel, the load step along time and the run length at the end of the axis. Each has arrow keys when focused.'));

  // ---------- readout ----------
  const read = h('div', { class: 'pg-read' });
  const readCard = h('section', { class: 'pg-card' }, h('div', { class: 'pg-head' }, h('h2', {}, 'Measured on the curve')), read);
  const tune = h('div', { class: 'pg-tune' });
  const tuneCard = h('section', { class: 'pg-card' }, h('div', { class: 'pg-head' }, h('h2', {}, 'Rules for this plant'), h('span', { class: 'pg-sub' }, 'click to try')), tune);
  const warns = h('div', { class: 'pg-warns', role: 'status', 'aria-live': 'polite' });
  const all = h('details', { class: 'pg-card pg-all' }, h('summary', {}, 'All inputs'), ctx.form);
  const notes = h('details', { class: 'pg-notes' });

  root.append(h('div', { class: 'pg' }, loopCard,
    h('div', { class: 'pg-body' },
      h('div', { class: 'pg-col' }, scopeCard, notes),
      h('aside', { class: 'pg-col' }, readCard, warns, tuneCard, all, ctx.outputs))));

  // ---------- scrubbable number ----------
  function scrub(parent, key, x, y, opts = {}) {
    const [sym, unit, floor, zeroOk] = PARAMS[key];
    const v = Number(ctx.input[key]);
    const txt = Number.isFinite(v) ? f(v, 3) : '?';
    const col = opts.color || 'var(--ink)';
    const g = s('g', { class: `scrub${active === key ? ' active' : ''}`, tabindex: 0, role: 'spinbutton', 'data-key': key,
      'aria-label': `${sym}${unit ? ` in ${unit}` : ''}`, 'aria-valuenow': Number.isFinite(v) ? v : null, 'aria-valuetext': `${txt}${unit ? ` ${unit}` : ''}` });
    const symW = sym.length * 7 + 8;
    const valW = Math.max(38, txt.length * 9 + 12);
    const w = opts.w || symW + valW + (unit ? unit.length * 6.2 + 4 : 0) + 6;
    g.append(s('rect', { class: 'pill', x, y: y - 15, width: w, height: 22, rx: 4, fill: 'var(--sunken)', stroke: 'var(--line)' }));
    g.append(s('text', { x: x + 6, y: y + 1, style: `fill:${col};font-weight:600` }, sym));
    g.append(s('text', { x: x + symW, y: y + 1.5, class: 'big', style: `fill:${col}` }, txt));
    if (unit) g.append(s('text', { x: x + symW + valW, y: y + 1, class: 'soft' }, unit));
    g.append(s('title', {}, `${sym}: drag sideways or use the arrow keys`));
    const apply = (nv) => {
      if (!zeroOk && nv <= 0) nv = floor;
      if (key === 'zeta' && nv > 5) nv = 5;
      setLive({ [key]: round3(nv) });
    };
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); g.focus({ preventScroll: true });
      keepGhost(); active = key; refocus = key;
      const x0 = e.clientX;
      const v0 = Number(ctx.input[key]) || 0;
      const base = Math.max(Math.abs(v0), floor);
      const move = (ev) => {
        const dx = ev.clientX - x0;
        if (Math.abs(dx) < 2) return;
        let nv = base * Math.exp(dx / 110);
        if (v0 === 0 && dx < 0) nv = 0;
        else if (zeroOk && v0 > 0 && nv < floor / 4) nv = 0;
        else if (v0 === 0) nv = floor * Math.exp(dx / 110);
        apply(nv);
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        active = null; refocus = key; draw();
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
    g.addEventListener('keydown', (e) => {
      const v0 = Number(ctx.input[key]) || 0;
      const k = e.shiftKey ? 1.5 : 1.1;
      let nv = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nv = v0 === 0 ? floor : v0 * k;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nv = v0 / k < floor / 4 && zeroOk ? 0 : v0 / k;
      if (e.key === '0' && zeroOk) nv = 0;
      if (nv == null) return;
      e.preventDefault(); keepGhost(); refocus = key;
      apply(nv);
    });
    parent.append(g);
    return w;
  }

  // ---------- loop diagram ----------
  function drawLoop() {
    loopSvg.replaceChildren();
    const inp = ctx.input;
    const W = Math.max(320, Math.round(loopSvg.clientWidth || loopCard.clientWidth || 900));
    const wide = W >= 820;
    const plant = inp.plant || 'fo';
    const arrow = (x1, y1, x2, y2, col = 'var(--ink-soft)') => {
      loopSvg.append(s('line', { x1, y1, x2, y2, stroke: col, 'stroke-width': 1.5 }));
      const a = Math.atan2(y2 - y1, x2 - x1);
      const p = (d, t) => `${x2 - d * Math.cos(a) + t * Math.sin(a)},${y2 - d * Math.sin(a) - t * Math.cos(a)}`;
      loopSvg.append(s('path', { d: `M${x2},${y2}L${p(8, 4)}L${p(8, -4)}z`, fill: col }));
    };
    const block = (x, y, w, hh, title, col) => {
      loopSvg.append(s('rect', { x, y, width: w, height: hh, rx: 6, fill: 'var(--surface)', stroke: col, 'stroke-width': 1.5 }));
      loopSvg.append(s('text', { x: x + 10, y: y + 16, class: 'title' }, title));
    };
    const sum = (cx, cy, signs) => {
      loopSvg.append(s('circle', { cx, cy, r: 11, fill: 'var(--surface)', stroke: 'var(--ink-soft)', 'stroke-width': 1.5 }));
      loopSvg.append(s('path', { d: `M${cx - 5},${cy}h10M${cx},${cy - 5}v10`, stroke: 'var(--ink-soft)', 'stroke-width': 1.2 }));
      for (const [dx, dy, t] of signs) loopSvg.append(s('text', { x: cx + dx, y: cy + dy, class: 'soft', 'text-anchor': 'middle' }, t));
    };
    const pidRows = (x, y) => {
      scrub(loopSvg, 'kp', x, y, { color: 'var(--tool-p)', w: 132 });
      scrub(loopSvg, 'ki', x, y + 28, { color: 'var(--tool-i)', w: 132 });
      scrub(loopSvg, 'kd', x, y + 56, { color: 'var(--tool-d)', w: 132 });
    };
    const plantKeys = plant === 'so' ? ['K', 'wn', 'zeta', 'theta'] : ['K', 'tau', 'theta'];
    const formula = plant === 'fo' ? 'K e^-θs / (τs + 1)' : plant === 'so' ? 'K ωn² e^-θs / (s² + 2ζωn s + ωn²)' : 'K e^-θs / (s (τs + 1))';
    const plantTabs = (x, y) => {
      let tx = x;
      for (const [k, t] of PLANTS) {
        const on = plant === k;
        const tw = t.length * 6.6 + 14;
        const g = s('g', { class: 'tab', tabindex: 0, role: 'radio', 'aria-checked': String(on), 'aria-label': `Plant: ${t}` });
        g.append(s('rect', { class: 'ring', x: tx, y: y - 13, width: tw, height: 18, rx: 9, fill: on ? 'var(--tool-plant)' : 'transparent', stroke: 'var(--tool-plant)' }));
        g.append(s('text', { x: tx + tw / 2, y: y, 'text-anchor': 'middle', style: `font-size:10.5px;fill:${on ? 'var(--surface)' : 'var(--ink-soft)'}` }, t));
        const pick = () => { if (!on) { keepGhost(); ctx.set('plant', k); } };
        g.addEventListener('click', pick);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        loopSvg.append(g);
        tx += tw + 4;
      }
      return tx - x;
    };
    const d = res?.sim;
    const lim = `${f(inp.umin)} … ${f(inp.umax)}`;
    const distTxt = d?.dist ? `load ${f(d.dist)}` : 'load';

    if (wide) {
      const H = 182;
      loopSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); loopSvg.setAttribute('height', H);
      const yM = 78;                         // signal line
      const sp = Math.max(0, Math.min(1, (W - 1000) / 500));   // spread on wide screens
      const gp = 44 + sp * 40;
      const xR = 14, xS = 92 + sp * 20;
      const pidX = xS + 36 + sp * 20, pidW = 168 + sp * 40;
      const satX = pidX + pidW + gp, satW = 96 + sp * 20;
      const dX = satX + satW + gp - 4;
      const plX = dX + gp - 4, plW = Math.max(300, Math.min(440, W - plX - 110));
      const yOut = plX + plW;
      // setpoint
      loopSvg.append(s('text', { x: xR, y: yM - 8, class: 'soft' }, 'r'));
      loopSvg.append(s('text', { x: xR, y: yM + 16, style: 'font-weight:600' }, `step ${f(inp.sp)}`));
      arrow(xR + 30, yM, xS - 12, yM);
      sum(xS, yM, [[-17, -8, '+'], [8, 26, '−']]);
      arrow(xS + 11, yM, pidX, yM);
      loopSvg.append(s('text', { x: xS + 16, y: yM - 6, class: 'soft' }, 'e'));
      // PID
      block(pidX, 18, pidW, 128, 'PID', 'var(--accent)');
      loopSvg.append(s('text', { x: pidX + pidW - 10, y: 34, class: 'soft', 'text-anchor': 'end', style: 'font-size:10px' }, 'parallel'));
      pidRows(pidX + 18 + sp * 20, 50);
      loopSvg.append(s('text', { x: pidX + 10, y: 18 + 128 + 14, class: 'soft', style: 'font-size:10.5px' }, `every dt ${f(inp.dt)} s · D filter N ${f(inp.nf)}`));
      arrow(pidX + pidW, yM, satX, yM);
      loopSvg.append(s('text', { x: pidX + pidW + 8, y: yM - 6, class: 'soft' }, 'u'));
      // saturation
      block(satX, yM - 34, satW, 68, 'LIMITS', 'var(--danger)');
      const cx = satX + satW / 2, cy = yM + 6;
      loopSvg.append(s('path', { d: `M${cx - 30},${cy + 14}h14l32,-28h14`, fill: 'none', stroke: 'var(--tool-u)', 'stroke-width': 1.8 }));
      loopSvg.append(s('text', { x: cx, y: yM + 30, 'text-anchor': 'middle', style: 'font-size:10.5px' }, lim));
      arrow(satX + satW, yM, dX - 11, yM);
      // load disturbance
      sum(dX, yM, [[0, -22, '']]);
      arrow(dX, yM - 48, dX, yM - 11, d?.dist ? 'var(--warn)' : 'var(--line)');
      loopSvg.append(s('text', { x: dX, y: yM - 54, 'text-anchor': 'middle', style: `font-size:10.5px;fill:${d?.dist ? 'var(--warn)' : 'var(--ink-soft)'}` }, distTxt));
      arrow(dX + 11, yM, plX, yM);
      // plant
      block(plX, 18, plW, 128, 'PLANT', 'var(--tool-plant)');
      plantTabs(plX + 62, 32);
      loopSvg.append(s('text', { x: plX + 12, y: 58, style: 'font-size:12px' }, formula));
      let px = plX + 12;
      const rowY = [92, 120];
      plantKeys.forEach((k, i) => {
        const row = plantKeys.length > 3 ? (i < 2 ? 0 : 1) : (i < 2 ? 0 : 1);
        if (i === 2) px = plX + 12;
        px += scrub(loopSvg, k, px, rowY[row]) + 8;
      });
      // output and feedback
      arrow(yOut, yM, W - 20, yM);
      loopSvg.append(s('text', { x: W - 14, y: yM - 8, 'text-anchor': 'end', style: 'font-weight:600' }, 'y'));
      const yFb = H - 12;
      const xFb = yOut + 30;
      loopSvg.append(s('path', { d: `M${xFb},${yM}V${yFb}H${xS}`, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 1.5 }));
      loopSvg.append(s('circle', { cx: xFb, cy: yM, r: 2.5, fill: 'var(--ink-soft)' }));
      arrow(xS, yFb, xS, yM + 11);
    } else {
      // Narrow: the PID block and the plant block one under the other.
      const pbh = plantKeys.length > 3 ? 160 : 130;
      const H = 174 + pbh + 16;
      loopSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); loopSvg.setAttribute('height', H);
      const bx = 34, bw = W - 44;
      loopSvg.append(s('text', { x: bx, y: 14, class: 'soft' }, `r = step ${f(inp.sp)}  →  e = r − y`));
      block(bx, 24, bw, 118, 'PID', 'var(--accent)');
      pidRows(bx + 14, 56);
      loopSvg.append(s('text', { x: bx + bw - 8, y: 40, class: 'soft', 'text-anchor': 'end', style: 'font-size:10px' }, `dt ${f(inp.dt)} s`));
      arrow(bx + bw / 2, 142, bx + bw / 2, 172);
      loopSvg.append(s('text', { x: bx + bw / 2 + 8, y: 162, style: 'font-size:10.5px' }, `u limited to ${lim}${d?.dist ? ` · + ${distTxt}` : ''}`));
      block(bx, 174, bw, pbh, 'PLANT', 'var(--tool-plant)');
      plantTabs(bx + 10, 212);
      loopSvg.append(s('text', { x: bx + 12, y: 238, style: 'font-size:11px' }, formula.length > 24 && bw < 330 ? formula.replace(' / ', ' / ') : formula));
      let py = 268;
      let px = bx + 12;
      for (const k of plantKeys) {
        const w = scrub(loopSvg, k, px, py);
        px += w + 8;
        if (px > bx + bw - 120) { px = bx + 12; py += 30; }
      }
      loopSvg.append(s('path', { d: `M${bx + bw / 2},${174 + pbh}V${H - 4}H14V14H${bx - 4}`, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 1.3, 'stroke-dasharray': '4 3' }));
      loopSvg.append(s('text', { x: 18, y: H / 2, class: 'soft', transform: `rotate(-90 18 ${H / 2})`, 'text-anchor': 'middle' }, 'y fed back'));
    }
    loopSub.replaceChildren(...(d ? ['u = ', h('b', { style: 'color:var(--tool-p)' }, 'Kp'), ' e + ', h('b', { style: 'color:var(--tool-i)' }, 'Ki'), ' ∫e dt + ', h('b', { style: 'color:var(--tool-d)' }, 'Kd'), ' de/dt, derivative on the measurement'] : []));
    if (refocus) loopSvg.querySelector(`[data-key="${refocus}"]`)?.focus({ preventScroll: true });
  }

  // ---------- scope ----------
  function drawScope() {
    scopeSvg.replaceChildren();
    const d = res?.sim;
    const W = Math.max(300, Math.round(scopeSvg.clientWidth || scopeCard.clientWidth || 800));
    const narrow = W < 520;
    const L = narrow ? 40 : 52, R = narrow ? 24 : 58, T = 14, gap = 22, B = 30;
    const H1 = narrow ? 210 : 300, H2 = narrow ? 90 : 112;
    const H = T + H1 + gap + H2 + B;
    scopeSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); scopeSvg.setAttribute('height', H);
    loadBtn.textContent = d?.dist ? 'Remove load step' : '+ Load step';
    if (!d || !d.t || d.t.length < 2) {
      scopeSvg.append(s('text', { x: 14, y: 40, class: 'soft' }, (res?.warnings || ['No response to draw.'])[0]));
      scopeSub.textContent = '';
      return;
    }
    const t0 = d.t[0], t1 = d.t[d.t.length - 1];
    const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
    const Tfrom = (x) => t0 + ((x - L) / (W - L - R)) * (t1 - t0);
    const g = ghost && ghost.t.length ? ghost : null;
    const ys = [...d.y, ...d.sp, 0, ...(g ? g.y.filter((_, i) => g.t[i] <= t1) : [])].filter(Number.isFinite);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (d.diverged) { lo = Math.max(lo, -3 * Math.abs(d.sp[0])); hi = Math.min(hi, 3 * Math.abs(d.sp[0])); }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const Y1 = (v) => T + H1 * (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo));
    const us = [...d.u, d.umin, d.umax].filter(Number.isFinite);
    let ulo = Math.min(...us), uhi = Math.max(...us);
    const upad = (uhi - ulo) * 0.12 || 1; ulo -= upad; uhi += upad;
    const top2 = T + H1 + gap;
    const Y2 = (v) => top2 + H2 * (1 - (v - ulo) / (uhi - ulo));
    const V2 = (y) => ulo + (1 - (y - top2) / H2) * (uhi - ulo);
    const V1 = (y) => lo + (1 - (y - T) / H1) * (hi - lo);

    for (const [y0, hh] of [[T, H1], [top2, H2]]) scopeSvg.append(s('rect', { x: L, y: y0, width: W - L - R, height: hh, fill: 'var(--sunken)', stroke: 'var(--line)' }));
    for (const v of ticks(lo, hi, narrow ? 4 : 6)) {
      scopeSvg.append(s('line', { x1: L, x2: W - R, y1: Y1(v), y2: Y1(v), stroke: 'var(--line-soft)' }));
      scopeSvg.append(s('text', { x: L - 5, y: Y1(v) + 3, 'text-anchor': 'end', class: 'soft' }, f(v)));
    }
    for (const v of ticks(ulo, uhi, 3)) {
      scopeSvg.append(s('line', { x1: L, x2: W - R, y1: Y2(v), y2: Y2(v), stroke: 'var(--line-soft)' }));
      scopeSvg.append(s('text', { x: L - 5, y: Y2(v) + 3, 'text-anchor': 'end', class: 'soft' }, f(v)));
    }
    for (const v of ticks(t0, t1, narrow ? 4 : 8)) {
      for (const [y0, hh] of [[T, H1], [top2, H2]]) scopeSvg.append(s('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + hh, stroke: 'var(--line-soft)' }));
      if (X(v) < W - R - 50) scopeSvg.append(s('text', { x: X(v), y: H - B + 16, 'text-anchor': 'middle', class: 'soft' }, f(v)));
    }
    scopeSvg.append(s('text', { x: L - 8, y: H - B + 16, 'text-anchor': 'end', class: 'soft', style: 'font-size:10px' }, 's'));
    scopeSvg.append(s('text', { x: L, y: top2 - 5, class: 'soft', style: 'font-size:10px' }, 'controller output u'));

    // Settling band from the settling time on.
    const spv = d.sp[d.sp.length - 1];
    const band = Math.abs(spv) * 0.02;
    if (d.settle != null && band > 0) {
      const xa = X(d.settle), xb = d.tdist != null ? X(d.tdist) : W - R;
      if (xb > xa) scopeSvg.append(s('rect', { x: xa, y: Y1(spv + band), width: xb - xa, height: Math.max(2, Y1(spv - band) - Y1(spv + band)), fill: 'var(--ok)', 'fill-opacity': 0.22 }));
      scopeSvg.append(s('line', { x1: xa, x2: xa, y1: T, y2: T + H1, stroke: 'var(--ok)', 'stroke-dasharray': '3 3' }));
      scopeSvg.append(s('text', { x: xa + 4, y: T + H1 - 6, style: 'fill:var(--ok)' }, `settled ${f(d.settle)} s (2 %)`));
    }

    const path = (tt, arr, Y) => arr.map((v, i) => (tt[i] > t1 ? '' : `${i ? 'L' : 'M'}${X(tt[i]).toFixed(1)},${Y(Number.isFinite(v) ? v : 0).toFixed(1)}`)).join('');
    if (g) {
      scopeSvg.append(s('path', { d: path(g.t, g.y, Y1), fill: 'none', stroke: 'var(--tool-ghost)', 'stroke-width': 1.4, 'stroke-opacity': 0.6 }));
      scopeSvg.append(s('path', { d: path(g.t, g.u, Y2), fill: 'none', stroke: 'var(--tool-ghost)', 'stroke-width': 1.1, 'stroke-opacity': 0.5 }));
    }
    scopeSvg.append(s('path', { d: path(d.t, d.sp, Y1), fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 1.3, 'stroke-dasharray': '6 4' }));
    scopeSvg.append(s('path', { d: path(d.t, d.y, Y1), fill: 'none', stroke: 'var(--tool-y)', 'stroke-width': 2.2 }));
    scopeSvg.append(s('path', { d: path(d.t, d.u, Y2), fill: 'none', stroke: 'var(--tool-u)', 'stroke-width': 1.7 }));

    // Rise 10-90 %: a dimension on the curve.
    if (d.t10 != null && d.t90 != null && d.yf != null) {
      const y10 = Y1(0.1 * d.yf), y90 = Y1(0.9 * d.yf);
      const xa = X(d.t10), xb = X(d.t90);
      for (const [x, y] of [[xa, y10], [xb, y90]]) scopeSvg.append(s('circle', { cx: x, cy: y, r: 3, fill: 'var(--tool-y)' }));
      const yd = Math.min(y90, y10) + (Math.abs(y10 - y90)) / 2;
      scopeSvg.append(s('line', { x1: xa, x2: xa, y1: y10, y2: yd, stroke: 'var(--ink-soft)', 'stroke-dasharray': '2 2' }));
      scopeSvg.append(s('line', { x1: xb, x2: xb, y1: y90, y2: yd, stroke: 'var(--ink-soft)', 'stroke-dasharray': '2 2' }));
      if (xb - xa > 2) scopeSvg.append(s('path', { d: `M${xa},${yd}H${xb}`, stroke: 'var(--ink)', 'stroke-width': 1.2, 'marker-start': null }));
      const lab = `rise ${f(d.rise)} s`;
      scopeSvg.append(s('text', { x: xb + 6, y: yd + 4 }, lab));
    }
    // Peak and overshoot.
    if (d.tPeak != null && d.overshoot != null && d.overshoot > 0.5) {
      const xp = X(d.tPeak), yp = Y1(d.yPeak), yf = Y1(d.yf);
      scopeSvg.append(s('line', { x1: xp, x2: xp, y1: yp, y2: yf, stroke: d.overshoot > 25 ? 'var(--danger)' : 'var(--warn)', 'stroke-width': 1.5 }));
      scopeSvg.append(s('circle', { cx: xp, cy: yp, r: 3.5, fill: 'none', stroke: d.overshoot > 25 ? 'var(--danger)' : 'var(--warn)', 'stroke-width': 1.5 }));
      const lab = `overshoot ${f(d.overshoot)} %`;
      const right = xp + 8 + lab.length * 6.6 < W - R;
      scopeSvg.append(s('text', { x: right ? xp + 8 : xp - 8, y: yp - 6, 'text-anchor': right ? 'start' : 'end', style: `fill:${d.overshoot > 25 ? 'var(--danger)' : 'var(--warn)'}` }, lab));
    }
    if (d.diverged) scopeSvg.append(s('text', { x: L + 10, y: T + 22, style: 'fill:var(--danger);font-size:13px;font-weight:600' }, 'Unstable: the run stopped when the output diverged'));

    // --- handles ---
    const vHandle = (key, x, y, label, col, toVal, fmt, stepOf) => {
      const gg = s('g', { class: 'vdrag', tabindex: 0, role: 'slider', 'data-key': key, 'aria-label': label, 'aria-valuetext': fmt });
      const bw = fmt.length * 6.5 + 10;
      const bx = Math.min(x, W - bw - 1);
      gg.append(s('rect', { class: 'ring', x: bx, y: y - 9, width: bw, height: 18, rx: 4, fill: col, stroke: col }));
      gg.append(s('text', { x: bx + 5, y: y + 4, style: 'fill:var(--surface);font-size:10.5px;font-weight:600' }, fmt));
      gg.append(s('rect', { x: L, y: y - 6, width: W - L - R, height: 12, fill: 'transparent' }));
      gg.append(s('title', {}, `${label}: drag up or down`));
      const setV = (v) => setLive({ [key]: round3(v) });
      gg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); gg.focus({ preventScroll: true }); keepGhost(); active = key; refocus = key;
        const move = (ev) => {
          const r = scopeSvg.getBoundingClientRect();
          setV(toVal((ev.clientY - r.top) * (H / r.height)));
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); active = null; refocus = key; draw(); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      gg.addEventListener('keydown', (e) => {
        const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
        if (k == null) return;
        e.preventDefault(); keepGhost(); refocus = key;
        const v = Number(ctx.input[key]) || 0;
        setV(v + k * stepOf(e.shiftKey));
      });
      scopeSvg.append(gg);
    };
    const hx = W - R + 3;
    const narrowX = narrow ? W - R - 46 : hx;
    const spStep = (sh) => Math.abs(spv || 1) * (sh ? 0.1 : 0.02);
    vHandle('sp', narrowX, Y1(spv), 'Setpoint step', 'var(--ink-soft)', (y) => V1(y), `r ${f(spv)}`, spStep);
    const uStep = (sh) => (Math.abs(d.umax - d.umin) || 1) * (sh ? 0.1 : 0.02);
    for (const [key, v] of [['umax', d.umax], ['umin', d.umin]]) {
      scopeSvg.append(s('line', { x1: L, x2: W - R, y1: Y2(v), y2: Y2(v), stroke: 'var(--danger)', 'stroke-dasharray': '5 3', 'stroke-width': 1.3 }));
      vHandle(key, narrowX, Y2(v), key === 'umax' ? 'Output max' : 'Output min', 'var(--danger)',
        (y) => (key === 'umax' ? Math.max(V2(y), d.umin + uStep(false)) : Math.min(V2(y), d.umax - uStep(false))), `${key === 'umax' ? 'max' : 'min'} ${f(v)}`, uStep);
    }
    // Load step: drag along time.
    if (d.tdist != null) {
      const xd = X(d.tdist);
      const gg = s('g', { class: 'hdrag', tabindex: 0, role: 'slider', 'data-key': 'tdist', 'aria-label': 'Load step time', 'aria-valuetext': `${f(d.tdist)} s` });
      for (const [y0, hh] of [[T, H1], [top2, H2]]) gg.append(s('line', { x1: xd, x2: xd, y1: y0, y2: y0 + hh, stroke: 'var(--warn)', 'stroke-dasharray': '5 3', 'stroke-width': 1.5 }));
      const lab = `load ${f(d.dist)} at ${f(d.tdist)} s`;
      const lw = lab.length * 6.6 + 10;
      const lx = Math.min(W - R - lw, xd - lw / 2);
      gg.append(s('rect', { class: 'ring', x: lx, y: T + 3, width: lw, height: 17, rx: 3, fill: 'var(--surface)', stroke: 'var(--warn)' }));
      gg.append(s('text', { x: lx + 5, y: T + 15, style: 'fill:var(--warn)' }, lab));
      gg.append(s('rect', { x: xd - 8, y: T, width: 16, height: H1 + gap + H2, fill: 'transparent' }));
      if (d.dPeak != null) scopeSvg.append(s('text', { x: Math.min(xd + 6, W - R - 190), y: T + 36, class: 'soft' }, `dips ${f(d.dPeak)} · back in ${d.dRecover != null ? `${f(d.dRecover)} s` : 'never'}`));
      gg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); gg.focus({ preventScroll: true }); keepGhost(); active = 'tdist'; refocus = 'tdist';
        const move = (ev) => {
          const r = scopeSvg.getBoundingClientRect();
          const t = Tfrom((ev.clientX - r.left) * (W / r.width));
          setLive({ tdist: round3(Math.max(t1 * 0.02, Math.min(t1 * 0.98, t))), tend: String(ctx.raw.tend || '0') === '0' ? round3(d.tend) : ctx.raw.tend });
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); active = null; refocus = 'tdist'; draw(); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      gg.addEventListener('keydown', (e) => {
        const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (k == null) return;
        e.preventDefault(); keepGhost(); refocus = 'tdist';
        const step = (t1 - t0) * (e.shiftKey ? 0.1 : 0.02);
        setLive({ tdist: round3(Math.max(t1 * 0.02, Math.min(t1 * 0.98, d.tdist + k * step))), tend: String(ctx.raw.tend || '0') === '0' ? round3(d.tend) : ctx.raw.tend });
      });
      scopeSvg.append(gg);
    }
    // Run length: drag the end of the time axis.
    {
      const gg = s('g', { class: 'hdrag', tabindex: 0, role: 'slider', 'data-key': 'tend', 'aria-label': 'Run length', 'aria-valuetext': `${f(t1)} s` });
      const xe = W - R;
      const lab = `run ${f(t1)} s`;
      const lw = lab.length * 6.6 + 12;
      const xc = Math.min(xe, W - lw / 2 - 2);
      gg.append(s('rect', { class: 'ring', x: xc - lw / 2, y: H - B + 4, width: lw, height: 18, rx: 9, fill: 'var(--surface)', stroke: 'var(--ink-soft)' }));
      gg.append(s('text', { x: xc, y: H - B + 17, 'text-anchor': 'middle', style: 'font-size:10.5px' }, lab));
      gg.append(s('title', {}, 'Run length: drag sideways (log scale), arrow keys when focused'));
      const setT = (v) => setLive({ tend: round3(Math.max(v, 1e-3)) });
      gg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); gg.focus({ preventScroll: true }); keepGhost(); active = 'tend'; refocus = 'tend';
        const x0 = e.clientX, v0 = t1;
        const move = (ev) => { const dx = ev.clientX - x0; if (Math.abs(dx) > 2) setT(v0 * Math.exp(dx / 160)); };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); active = null; refocus = 'tend'; draw(); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      gg.addEventListener('keydown', (e) => {
        const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (k == null) return;
        e.preventDefault(); keepGhost(); refocus = 'tend';
        setT(t1 * (e.shiftKey ? 1.5 : 1.1) ** k);
      });
      scopeSvg.append(gg);
    }
    if (g) scopeSvg.append(s('text', { x: W - R - 6, y: T + H1 - 6, 'text-anchor': 'end', style: 'fill:var(--tool-ghost);font-size:10.5px' }, 'grey: before the last change'));

    const val = (label) => (res.values || []).find((v) => v.label === label);
    const ov = val('Overshoot'), st = val('Settling time (2 % band)');
    scopeSub.replaceChildren(`${f(t1)} s run · overshoot `, h('b', {}, ov ? `${ov.value} %` : '–'), ' · settles ', h('b', {}, st ? String(st.value) : '–'));
    if (refocus) scopeSvg.querySelector(`[data-key="${refocus}"]`)?.focus({ preventScroll: true });
  }

  // ---------- readout ----------
  function drawSide() {
    read.replaceChildren(...(res?.values || []).map((v) => h('div', { class: `pg-fig ${v.tone || ''}` },
      h('span', {}, v.label), h('b', {}, `${v.value}${v.unit ? ` ${v.unit}` : ''}`), v.hint ? h('em', {}, v.hint) : null)));
    readCard.style.display = res?.values?.length ? '' : 'none';
    const inp = ctx.input;
    const same = (a, b) => Math.abs(a - b) <= 0.006 * Math.max(Math.abs(a), Math.abs(b), 1e-9);
    tune.replaceChildren(...(res?.tuning || []).map((t) => {
      const on = same(t.kp, inp.kp || 0) && same(t.ki, inp.ki || 0) && same(t.kd, inp.kd || 0);
      return h('button', { class: 'pg-rule', 'aria-pressed': String(on), onclick: () => { keepGhost(); ctx.setMany({ kp: round3(t.kp), ki: round3(t.ki), kd: round3(t.kd) }); } },
        h('span', { class: 'n' }, t.name),
        h('span', { class: `r${t.unstable ? ' bad' : ''}` }, t.unstable ? 'unstable' : `${f(t.overshoot)} % · ${t.settle != null ? `${f(t.settle)} s` : 'not settled'}`),
        h('span', { class: 'g' }, `Kp ${f(t.kp)} · Ki ${f(t.ki)} · Kd ${f(t.kd)}`));
    }));
    tuneCard.style.display = res?.tuning?.length ? '' : 'none';
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'How it is worked out'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }

  function draw() {
    drawLoop();
    drawScope();
    drawSide();
    if (!active) refocus = null;
  }

  ctx.onResult((r) => { res = r; draw(); });
  let lastW = 0;
  new ResizeObserver(() => { const w = root.clientWidth; if (w !== lastW) { lastW = w; drawLoop(); drawScope(); } }).observe(root);
}
