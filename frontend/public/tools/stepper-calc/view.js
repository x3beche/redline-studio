// Stepper Motor Calculator page: the motor and what it can pull.
//   Motor       - the flange seen end-on with its step dial (every full step a
//                 tick) turning, and a loupe on one full step split into the
//                 microsteps; the microstep buttons carry the STEP rate each
//                 would need at this speed. The nameplate under it holds the
//                 motor data.
//   Torque      - the estimated pull-out curve against speed. Drag the
//                 operating point along it to set the speed, the flat top to
//                 set the driver current, the end of the curve (where back-EMF
//                 eats the supply) to set the supply voltage. The top axis is
//                 the STEP rate; beyond the step-input limit it is hatched.
//   STEP pulses - the pulse train at this speed on a scope, with its period,
//                 and the shaft angle climbing one microstep per pulse.
// Every number drawn comes from run()'s result.motor and result.tables.

const NS = 'http://www.w3.org/2000/svg';
const MICROS = [1, 2, 4, 8, 16, 32, 64, 128, 256];

const CSS = `
:root { --tool-curve: #2458c6; --tool-op: #c26a00; --tool-band: #2f855a; --tool-plate: #d9dee3; --tool-metal: #aab4be; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-curve: #7d9bff; --tool-op: #f0a33a; --tool-band: #68b36b; --tool-plate: #1d2731; --tool-metal: #3a4957; } }
:root[data-theme="dark"] { --tool-curve: #7d9bff; --tool-op: #f0a33a; --tool-band: #68b36b; --tool-plate: #1d2731; --tool-metal: #3a4957; }
.k-page { padding: 10px 12px 14px; }
.sm { display: grid; grid-template-columns: 330px minmax(0, 1fr); grid-template-areas: "motor chart" "motor scope" "out out"; gap: 10px; min-width: 0; }
.sm svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.sm .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.sm-motor { grid-area: motor; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.sm-chart { grid-area: chart; } .sm-scope { grid-area: scope; } .sm-out { grid-area: out; min-width: 0; }
.sm-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.sm-card h2 { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--ink-soft); padding: 6px 10px 2px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.sm-card h2 b { margin-left: auto; font: 500 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.sm-dial svg { display: block; width: 100%; height: 300px; }
.sm-micro { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 2px; padding: 0 8px 8px; }
.sm-micro button { border: 1px solid var(--line); background: var(--surface); border-radius: 3px; padding: 3px 0 2px; cursor: pointer; min-width: 0;
  display: flex; flex-direction: column; align-items: center; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.sm-micro button small { font-size: 9px; color: var(--ink-soft); white-space: nowrap; }
.sm-micro button[aria-checked="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.sm-micro button[aria-checked="true"] small { color: var(--accent-ink); }
.sm-micro button.over small { color: var(--danger); font-weight: 600; }
.sm-plate { background: var(--tool-plate); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px 9px; position: relative; }
.sm-plate .t { display: flex; justify-content: space-between; font: 600 11px "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .08em; color: var(--ink-soft);
  border-bottom: 1px solid var(--line); padding-bottom: 4px; margin-bottom: 6px; }
.sm-plate .g { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; }
.sm-plate label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-soft); min-width: 0; }
.sm-plate label span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-plate input, .sm-bar input { width: 58px; padding: 2px 4px; border: 1px solid var(--line); border-radius: 3px; background: var(--surface);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.sm-plate input.bad, .sm-bar input.bad { border-color: var(--danger); }
.sm-plate i { font-style: normal; font-size: 10.5px; width: 26px; }
.sm-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); font-size: 12px; color: var(--ink-soft); }
.sm-bar label { display: inline-flex; align-items: center; gap: 4px; }
.sm-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
.sm-seg button { border: 0; background: transparent; padding: 2px 8px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.sm-seg button + button { border-left: 1px solid var(--line); }
.sm-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.sm-bar label[hidden] { display: none; }
.sm-read { margin-left: auto; font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.sm-plot { height: clamp(300px, calc(100vh - 330px), 620px); position: relative; }
.sm-plot svg, .sm-scope svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.sm-scopebox { height: 150px; }
.sm .h { outline: none; }
.sm .h:focus-visible .hc { stroke: var(--accent); stroke-width: 3; }
.sm .h.x { cursor: ew-resize; } .sm .h.y { cursor: ns-resize; }
.sm .dragging, .sm .dragging * { cursor: grabbing !important; }
.sm-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.sm-msgs:empty { display: none; }
.sm-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.sm-msgs div.note { border-left-color: var(--line); color: var(--ink-soft); }
@media (max-width: 900px) {
  .sm { grid-template-columns: minmax(0, 1fr); grid-template-areas: "chart" "scope" "motor" "out"; }
  .sm-out { grid-template-columns: minmax(0, 1fr); }
  .sm-plot { height: 340px; }
}
`;

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const niceStep = (span, n) => { const r = span / n, p = 10 ** Math.floor(Math.log10(r || 1)); return [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= r) || 10 * p; };
const eng = (v, u) => {
  if (!Number.isFinite(v)) return '–';
  if (v === 0) return `0 ${u}`;
  const a = Math.abs(v);
  const [d, p] = a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'k'] : a >= 1 || a === 0 ? [1, ''] : a >= 1e-3 ? [1e-3, 'm'] : a >= 1e-6 ? [1e-6, 'µ'] : [1e-9, 'n'];
  const x = v / d;
  return `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)} ${p}${u}`;
};
const r3 = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3)) : '–');
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let res = null, M = null, drag = null, frozen = null, angle = 0, lastT = 0;

  // ---------- motor column ----------
  const dsvg = document.createElementNS(NS, 'svg');
  dsvg.setAttribute('role', 'img');
  const dialHead = h('b');
  const micro = h('div', { class: 'sm-micro', role: 'radiogroup', 'aria-label': 'Microstepping' });
  const dialCard = h('section', { class: 'sm-card sm-dial' }, h('h2', {}, 'Motor, end view', dialHead), dsvg, micro);
  const plateFields = [
    ['step', 'Step', '°'], ['thold', 'Holding', 'N·m'], ['irated', 'Rated I', 'A'],
    ['rph', 'R phase', 'Ω'], ['lmh', 'L phase', 'mH'],
  ];
  const plateIns = {};
  const plateGrid = h('div', { class: 'g' }, plateFields.map(([k, t, u]) => {
    const i = h('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${({ Step: 'Full-step angle', Holding: 'Holding torque', 'Rated I': 'Rated phase current', 'R phase': 'Phase resistance', 'L phase': 'Phase inductance' })[t]} in ${u}` });
    i.addEventListener('change', () => ctx.set(k, i.value.trim()));
    plateIns[k] = i;
    return h('label', {}, h('span', {}, t), i, h('i', {}, u));
  }));
  const plateSteps = h('span');
  const plate = h('section', { class: 'sm-plate', 'aria-label': 'Motor nameplate' }, h('div', { class: 't' }, h('span', {}, 'HYBRID STEPPER · 2 PHASE'), plateSteps), plateGrid);
  const motorCol = h('div', { class: 'sm-motor' }, dialCard, plate);

  // ---------- chart ----------
  const seg = h('div', { class: 'sm-seg', role: 'group', 'aria-label': 'Speed given as' });
  const barIns = {};
  const fld = (k, t, u, w) => {
    const i = h('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${t}${u ? ' in ' + u : ''}`, style: w ? `width:${w}px` : null });
    i.addEventListener('change', () => ctx.set(k, i.value.trim()));
    barIns[k] = i;
    return h('label', { 'data-k': k }, t, i, u);
  };
  const speedF = fld('rpm', 'n', 'rpm'), vlinF = fld('vlin', 'v', 'mm/s'), leadF = fld('lead', 'lead', 'mm/rev');
  const read = h('span', { class: 'sm-read', 'aria-live': 'polite' });
  const bar = h('div', { class: 'sm-bar' }, seg, speedF, vlinF, leadF, fld('vs', 'Supply', 'V'), fld('idrive', 'Driver', 'A'), fld('fmax', 'STEP max', 'kHz'), read);
  const psvg = document.createElementNS(NS, 'svg');
  psvg.setAttribute('role', 'group');
  psvg.setAttribute('aria-label', 'Torque against speed');
  const plot = h('div', { class: 'sm-plot' }, psvg);
  const chart = h('section', { class: 'sm-card sm-chart' }, bar, plot);

  // ---------- scope ----------
  const ssvg = document.createElementNS(NS, 'svg');
  ssvg.setAttribute('role', 'img');
  const scopeHead = h('b');
  const scope = h('section', { class: 'sm-card sm-scope' }, h('h2', {}, 'STEP input and shaft angle', scopeHead), h('div', { class: 'sm-scopebox' }, ssvg));

  const msgs = h('div', { class: 'sm-msgs', 'aria-live': 'polite' });
  motorCol.append(msgs);
  root.append(h('div', { class: 'sm' }, motorCol, chart, scope, h('div', { class: 'sm-out' }, ctx.outputs)));

  // ---------- sync inputs ----------
  function syncInputs() {
    const raw = ctx.raw;
    for (const [k, i] of Object.entries({ ...plateIns, ...barIns })) {
      if (document.activeElement !== i) i.value = raw[k] ?? '';
      const bad = String(raw[k] ?? '').trim() !== '' && ctx.parseEng(raw[k]) == null;
      i.classList.toggle('bad', bad);
    }
    const lin = raw.motion === 'linear';
    seg.replaceChildren(...[['rotary', 'rpm'], ['linear', 'mm/s']].map(([v, t]) => h('button', { 'aria-pressed': String((raw.motion || 'rotary') === v), onclick: () => ctx.set('motion', v) }, t)));
    speedF.hidden = lin; vlinF.hidden = !lin; leadF.hidden = !lin;
    const cur = Number(raw.micro) || 1;
    const rows = res?.tables?.[0]?.rows || [];
    micro.replaceChildren(...MICROS.map((m, k) => {
      const hz = rows[k]?.[2] || '';
      const over = M?.fmaxHz && M.fstep != null && (M.fstep / M.n) * m > M.fmaxHz;
      const b = h('button', { role: 'radio', 'aria-checked': String(cur === m), tabindex: cur === m ? '0' : '-1', class: over ? 'over' : null,
        title: `${m === 1 ? 'Full step' : '1/' + m}: STEP ${hz}${over ? ', above the step input limit' : ''}`,
        onclick: () => ctx.set('micro', String(m)),
        onkeydown: (e) => {
          const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          const nm = MICROS[Math.max(0, Math.min(8, k + d))];
          ctx.set('micro', String(nm));
          requestAnimationFrame(() => micro.querySelector('[aria-checked="true"]')?.focus());
        } }, m === 1 ? 'full' : `/${m}`, h('small', {}, hz.replace(' ', '')));
      return b;
    }));
  }

  // ---------- dial ----------
  function drawDial() {
    const W = Math.max(240, dsvg.clientWidth || 300), H = 300;
    dsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!M) { dsvg.innerHTML = ''; return; }
    const cx = W * 0.4, cy = 138, F = Math.min(116, W * 0.38);
    const o = [];
    // flange: square with chamfers and four holes
    const c = F * 0.16;
    o.push(`<path d="M${cx - F + c},${cy - F}H${cx + F - c}L${cx + F},${cy - F + c}V${cy + F - c}L${cx + F - c},${cy + F}H${cx - F + c}L${cx - F},${cy + F - c}V${cy - F + c}Z" fill="var(--tool-plate)" stroke="var(--tool-metal)" stroke-width="1.5"/>`);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) o.push(`<circle cx="${cx + sx * F * 0.73}" cy="${cy + sy * F * 0.73}" r="${F * 0.075}" fill="var(--surface)" stroke="var(--tool-metal)"/>`);
    const R = F * 0.8;
    o.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="var(--surface)" stroke="var(--line)"/>`);
    // full-step ticks, rotating
    const ticks = [];
    const full = Math.round(M.full);
    const nT = Math.min(full, 400);
    for (let k = 0; k < nT; k++) {
      const a = (k / nT) * 2 * Math.PI;
      const long = k % 10 === 0, len = long ? 9 : 4;
      ticks.push(`M${(R - 2) * Math.cos(a)},${(R - 2) * Math.sin(a)}L${(R - 2 - len) * Math.cos(a)},${(R - 2 - len) * Math.sin(a)}`);
    }
    o.push(`<g class="rot" transform="translate(${cx},${cy}) rotate(${angle})">`
      + `<path d="${ticks.join('')}" stroke="var(--ink-soft)" stroke-width="0.8"/>`
      + `<circle r="${R * 0.46}" fill="var(--sunken)" stroke="var(--tool-metal)"/>`
      + `<path d="M${-R * 0.16},${-R * 0.1}A${R * 0.19},${R * 0.19} 0 1 0 ${R * 0.16},${-R * 0.1}Z" fill="var(--tool-metal)" stroke="var(--ink-soft)" stroke-width="0.8"/>`
      + `<line x1="0" y1="${-R * 0.46}" x2="0" y2="${-R + 12}" stroke="var(--tool-op)" stroke-width="2"/></g>`);
    o.push(`<path d="M${cx},${cy - R - 5}l-5,-8h10z" fill="var(--ink)"/>`);
    // loupe on one full step at the top
    const lx = Math.min(W - 58, cx + F + 16), ly = 34, lw = W - lx - 6;
    if (lw > 40) {
      o.push(`<path d="M${cx + 6},${cy - R + 4}L${lx},${ly + 60}" stroke="var(--line)" stroke-dasharray="2 2"/>`);
      o.push(`<rect x="${lx}" y="${ly}" width="${lw}" height="122" rx="4" fill="var(--surface)" stroke="var(--line)"/>`);
      o.push(`<text x="${lx + lw / 2}" y="${ly + 14}" font-size="9.5" text-anchor="middle" fill="var(--ink-soft)">1 step</text>`);
      const top = ly + 24, bot = ly + 108, n = M.n;
      o.push(`<line x1="${lx + 10}" y1="${top}" x2="${lx + 10}" y2="${bot}" stroke="var(--ink)" stroke-width="1.5"/>`);
      o.push(`<line x1="${lx + 6}" y1="${top}" x2="${lx + lw - 6}" y2="${top}" stroke="var(--ink)" stroke-width="1.5"/><line x1="${lx + 6}" y1="${bot}" x2="${lx + lw - 6}" y2="${bot}" stroke="var(--ink)" stroke-width="1.5"/>`);
      if (n <= 64) for (let k = 1; k < n; k++) { const y = top + ((bot - top) * k) / n; o.push(`<line x1="${lx + 10}" y1="${y}" x2="${lx + 10 + Math.min(lw - 20, 16)}" y2="${y}" stroke="var(--accent)" stroke-width="${n > 32 ? 0.6 : 1}"/>`); }
      else o.push(`<rect x="${lx + 10}" y="${top}" width="${Math.min(lw - 20, 16)}" height="${bot - top}" fill="var(--accent)" fill-opacity="0.35"/>`);
      o.push(`<text x="${lx + lw - 5}" y="${(top + bot) / 2 - 4}" font-size="10" text-anchor="end" fill="var(--accent)">×${n}</text>`);
      o.push(`<text x="${lx + lw / 2}" y="${ly + 118}" font-size="9.5" text-anchor="middle" fill="var(--ink-soft)">${r3(M.step)}°</text>`);
    }
    // readouts under the flange
    o.push(`<text x="10" y="${H - 22}" font-size="10.5" fill="var(--ink-soft)">${M.full} steps/rev · ${r3(M.microAngle)}° per microstep</text>`);
    if (M.tinc != null) o.push(`<text x="10" y="${H - 8}" font-size="10.5" fill="var(--ink-soft)">one microstep holds ${r3(M.tinc)} N·m</text>`);
    dsvg.innerHTML = o.join('');
    dsvg.setAttribute('aria-label', `Motor with ${M.full} full steps per revolution, microstepping 1/${M.n}`);
    const shown = Math.min(M.rps, 0.2);
    dialHead.textContent = M.rps > 0 ? `${r3(M.rpm)} rpm${M.rps > 0.2 ? ` · shown ×${(M.rps / shown).toFixed(0)} slower` : ''}` : 'stopped';
  }
  function tick(t) {
    if (lastT && M && M.rps > 0 && !(reduced && reduced.matches)) {
      const dt = Math.min(0.1, (t - lastT) / 1000);
      angle = (angle + 360 * Math.min(M.rps, 0.2) * dt) % 360;
      const g = dsvg.querySelector('.rot');
      if (g) g.setAttribute('transform', g.getAttribute('transform').replace(/rotate\([^)]*\)/, `rotate(${angle.toFixed(2)})`));
    }
    lastT = t;
    requestAnimationFrame(tick);
  }

  // ---------- torque chart ----------
  function plotGeo(W, H) {
    const padL = 52, padR = 16, padT = 36, padB = 38;
    let xMax, yMax;
    if (frozen) ({ xMax, yMax } = frozen);
    else {
      xMax = M.motorOk ? M.points[M.points.length - 1][0] : Math.max(M.rpm * 1.6, 60);
      yMax = M.motorOk ? M.hold * 1.3 || 1 : 1;
    }
    const X = (r) => padL + (r / xMax) * (W - padL - padR);
    const Y = (t) => H - padB - (t / yMax) * (H - padT - padB);
    const R = (x) => ((x - padL) / (W - padL - padR)) * xMax;
    const T = (y) => ((H - padB - y) / (H - padT - padB)) * yMax;
    return { padL, padR, padT, padB, xMax, yMax, X, Y, R, T, W, H };
  }
  function drawPlot() {
    const W = Math.max(280, plot.clientWidth), H = Math.max(220, plot.clientHeight);
    psvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!M) { psvg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--danger)" font-size="12">${(res?.warnings || [''])[0]}</text>`; return; }
    const G = plotGeo(W, H);
    const { X, Y, xMax, yMax, padL, padT, padB, padR } = G;
    psvg._G = G;
    const o = [];
    o.push(`<defs><pattern id="sm-over" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--danger)" stroke-width="1.5" stroke-opacity="0.35"/></pattern></defs>`);
    // grid + axes
    const xs = niceStep(xMax, W < 500 ? 4 : 8), ys = niceStep(yMax, 5);
    for (let r = 0; r <= xMax + 1e-9; r += xs) {
      o.push(`<line x1="${X(r)}" y1="${padT}" x2="${X(r)}" y2="${H - padB}" stroke="var(--line-soft)"/>`);
      o.push(`<text x="${X(r)}" y="${H - padB + 14}" font-size="10" text-anchor="middle" fill="var(--ink-soft)">${+r.toFixed(3)}</text>`);
      o.push(`<text x="${X(r)}" y="${padT - 6}" font-size="10" text-anchor="middle" fill="var(--ink-soft)">${eng(r * M.hzPerRpm, 'Hz').replace(' ', '')}</text>`);
    }
    for (let t = 0; t <= yMax + 1e-9; t += ys) {
      o.push(`<line x1="${padL}" y1="${Y(t)}" x2="${W - padR}" y2="${Y(t)}" stroke="var(--line-soft)"/>`);
      o.push(`<text x="${padL - 6}" y="${Y(t) + 3.5}" font-size="10" text-anchor="end" fill="var(--ink-soft)">${+t.toFixed(3)}</text>`);
    }
    o.push(`<text x="${W - padR}" y="${H - 8}" font-size="10.5" text-anchor="end" fill="var(--ink-soft)">shaft speed, rpm${M.linear ? ` (${M.lead} mm/rev)` : ''}</text>`);
    o.push(`<text x="${W - padR}" y="${padT - 20}" font-size="10.5" text-anchor="end" fill="var(--ink-soft)">STEP rate at 1/${M.n}</text>`);
    o.push(`<text x="12" y="${padT - 20}" font-size="10.5" fill="var(--ink-soft)">torque, N·m</text>`);
    // step input limit
    if (M.fmaxRpm != null && M.fmaxRpm < xMax) {
      o.push(`<rect x="${X(M.fmaxRpm)}" y="${padT}" width="${W - padR - X(M.fmaxRpm)}" height="${H - padT - padB}" fill="url(#sm-over)"/>`);
      o.push(`<text x="${X(M.fmaxRpm) + 5}" y="${padT + 13}" font-size="10.5" class="halo" fill="var(--danger)">STEP > ${eng(M.fmaxHz, 'Hz')}</text>`);
    }
    if (M.motorOk) {
      const P = M.points;
      const line = P.map(([r, t], k) => `${k ? 'L' : 'M'}${X(r).toFixed(1)},${Y(t).toFixed(1)}`).join('');
      const band = (f) => P.map(([r, t], k) => `${k ? 'L' : 'M'}${X(r).toFixed(1)},${Y(t * f).toFixed(1)}`).join('');
      // usable load band: 50-70 % of what is available
      o.push(`<path d="${band(0.7)}${P.slice().reverse().map(([r, t]) => `L${X(r).toFixed(1)},${Y(t * 0.5).toFixed(1)}`).join('')}Z" fill="var(--tool-band)" fill-opacity="0.16"/>`);
      o.push(`<path d="${band(0.5)}" fill="none" stroke="var(--tool-band)" stroke-width="1" stroke-dasharray="4 3"/>`);
      const lab = P[Math.round(P.length * 0.12)];
      o.push(`<text x="${X(lab[0])}" y="${Y(lab[1] * 0.6) + 4}" font-size="10" class="halo" fill="var(--tool-band)">plan the load here (50–70 %)</text>`);
      o.push(`<path d="${line}L${X(P[P.length - 1][0])},${Y(0)}L${X(0)},${Y(0)}Z" fill="var(--tool-curve)" fill-opacity="0.07"/>`);
      o.push(`<path d="${line}" fill="none" stroke="var(--tool-curve)" stroke-width="2.2"/>`);
      // corner speed
      const xc = X(M.cornerRpm);
      o.push(`<line x1="${xc}" y1="${Y(M.hold)}" x2="${xc}" y2="${H - padB}" stroke="var(--ink-soft)" stroke-dasharray="2 3"/>`);
      o.push(`<text x="${xc + 4}" y="${Y(M.hold) - 9}" font-size="10" class="halo" fill="var(--ink-soft)">corner ${Math.round(M.cornerRpm)}${W < 560 ? '' : ' rpm'}</text>`);
      // driver current: the flat top
      const yh = Y(M.hold);
      const xo0 = X(Math.min(M.rpm, xMax));
      let xh = (padL + xc) / 2;
      if (Math.abs(xh - xo0) < 40) xh = xo0 < xh ? Math.min(xc - 20, xo0 + 44) : Math.max(padL + 20, xo0 - 44);
      o.push(`<g class="h y" data-h="i" tabindex="0" role="slider" aria-label="Driver current: drag the flat top up or down, or arrow keys" aria-valuetext="${ctx.raw.idrive} A, ${r3(M.hold)} N·m at standstill">`
        + `<rect x="${padL}" y="${yh - 9}" width="${Math.max(30, xc - padL)}" height="18" fill="transparent"/>`
        + `<rect class="hc" x="${xh - 13}" y="${yh - 5}" width="26" height="10" rx="3" fill="var(--tool-curve)" stroke="var(--surface)" stroke-width="1.5"/>`
        + `<text x="${padL + 6}" y="${yh - 9}" font-size="11" font-weight="600" class="halo" fill="var(--tool-curve)">${r3(M.hold)} N·m${W < 560 ? '' : ' standstill'} at ${eng(num(ctx.raw.idrive), 'A')}</text>`
        + `<title>Drag up or down to set the driver current</title></g>`);
      // back-EMF end: supply voltage
      if (M.zeroRpm < xMax * 1.001) {
        const xz = X(M.zeroRpm), yz = Y(0);
        o.push(`<g class="h x" data-h="v" tabindex="0" role="slider" aria-label="Supply voltage: drag the end of the curve left or right, or arrow keys" aria-valuetext="${ctx.raw.vs} V">`
          + `<rect x="${xz - 10}" y="${yz - 30}" width="20" height="36" fill="transparent"/>`
          + `<path class="hc" d="M${xz},${yz - 7}L${xz + 7},${yz}L${xz},${yz + 7}L${xz - 7},${yz}Z" fill="var(--tool-curve)" stroke="var(--surface)" stroke-width="1.5"/>`
          + `<text x="${xz - 10}" y="${yz - 10}" font-size="10.5" text-anchor="end" class="halo" fill="var(--tool-curve)">${W < 560 ? `${ctx.raw.vs} V: 0 at ${Math.round(M.zeroRpm)}` : `${ctx.raw.vs} V supply: no torque left at ${Math.round(M.zeroRpm)} rpm`}</text>`
          + `<title>Drag to set the supply voltage (back-EMF uses it all here)</title></g>`);
      }
    }
    // operating point
    const xo = X(Math.min(M.rpm, xMax)), to = M.motorOk ? M.torque : 0, yo = Y(to);
    const col = M.motorOk && M.frac < 0.3 ? 'var(--danger)' : 'var(--tool-op)';
    o.push(`<g class="h x" data-h="n" tabindex="0" role="slider" aria-label="Speed: drag the operating point, or arrow keys" aria-valuenow="${M.rpm.toFixed(1)}" aria-valuetext="${r3(M.rpm)} rpm">`
      + `<rect x="${xo - 12}" y="${padT}" width="24" height="${H - padT - padB}" fill="transparent"/>`
      + `<line x1="${xo}" y1="${padT}" x2="${xo}" y2="${H - padB}" stroke="${col}" stroke-width="1.4"/>`
      + (M.motorOk ? `<line x1="${padL}" y1="${yo}" x2="${xo}" y2="${yo}" stroke="${col}" stroke-width="1" stroke-dasharray="3 3"/>` : '')
      + `<circle class="hc" cx="${xo}" cy="${yo}" r="6.5" fill="${col}" stroke="var(--surface)" stroke-width="2"/>`
      + `<path d="M${xo - 6},${H - padB + 20}l6,-7l6,7z" fill="${col}"/>`
      + `<title>Drag to set the speed</title></g>`);
    const right = xo > W - 190;
    const lines = [
      `${r3(M.rpm)} rpm${M.linear ? ` · ${r3(M.rpm / 60 * M.lead)} mm/s` : ''}`,
      `STEP ${eng(M.fstep, 'Hz')} · ${eng(M.period, 's')}`,
      M.motorOk ? `${r3(M.torque)} N·m · ${Math.round(M.frac * 100)} % · ${eng(M.current, 'A')}` : '',
    ].filter(Boolean);
    lines.forEach((t, k) => o.push(`<text x="${xo + (right ? -10 : 10)}" y="${Math.min(H - padB - 40, yo + 22) + k * 14}" font-size="${k ? 10.5 : 12}" font-weight="${k ? 400 : 600}" text-anchor="${right ? 'end' : 'start'}" class="halo" fill="${k === 2 ? col : 'var(--ink)'}">${t}</text>`));
    psvg.innerHTML = o.join('');
    read.textContent = M.motorOk ? `${r3(M.torque)} N·m left of ${r3(M.hold)}` : `STEP ${eng(M.fstep, 'Hz')}`;
  }

  // ---------- scope ----------
  function drawScope() {
    const W = Math.max(280, ssvg.clientWidth || 600), H = 150;
    ssvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!M || !(M.fstep > 0)) { ssvg.innerHTML = `<text x="${W / 2}" y="75" text-anchor="middle" font-size="11" fill="var(--ink-soft)">No pulses: the motor stands still</text>`; scopeHead.textContent = ''; return; }
    const x0 = 64, x1 = W - 10;
    const nP = W < 500 ? 6 : 12;
    const px = (x1 - x0) / nP;
    const o = [];
    // graticule
    o.push(`<rect x="${x0}" y="8" width="${x1 - x0}" height="${H - 34}" fill="var(--sunken)" rx="3"/>`);
    for (let k = 0; k <= nP; k++) o.push(`<line x1="${x0 + k * px}" y1="8" x2="${x0 + k * px}" y2="${H - 26}" stroke="var(--line-soft)"/>`);
    const hi = 22, lo = 50;
    o.push(`<text x="${x0 - 8}" y="${(hi + lo) / 2 + 4}" font-size="10.5" text-anchor="end" fill="var(--ink-soft)">STEP</text>`);
    o.push(`<text x="${x0 - 8}" y="${96}" font-size="10.5" text-anchor="end" fill="var(--ink-soft)">angle</text>`);
    // pulses: high time 30 % of the period (or the limit's half period, if tighter)
    const duty = 0.3;
    let d = `M${x0},${lo}`;
    for (let k = 0; k < nP; k++) { const a = x0 + k * px + px * 0.2; d += `H${a}V${hi}H${a + px * duty}V${lo}`; }
    d += `H${x1}`;
    o.push(`<path d="${d}" fill="none" stroke="var(--tool-op)" stroke-width="1.8"/>`);
    // angle staircase
    const ya = 118, yb = 72;
    let s = `M${x0},${ya}`;
    for (let k = 0; k < nP; k++) { const a = x0 + k * px + px * 0.2; const y = ya - ((k + 1) / nP) * (ya - yb); s += `H${a}V${y}`; }
    s += `H${x1}`;
    o.push(`<path d="${s}" fill="none" stroke="var(--tool-curve)" stroke-width="1.6"/>`);
    o.push(`<text x="${x1 - 4}" y="${yb - 4}" font-size="10" text-anchor="end" class="halo" fill="var(--tool-curve)">+${r3(M.microAngle * nP)}° after ${nP} pulses</text>`);
    // period dimension between two rising edges
    const a1 = x0 + px * 1.2, a2 = a1 + px;
    o.push(`<path d="M${a1},${hi - 3}V${hi - 12}M${a2},${hi - 3}V${hi - 12}M${a1},${hi - 8}H${a2}" stroke="var(--ink)" stroke-width="1"/>`);
    o.push(`<path d="M${a1},${hi - 8}l5,-3v6zM${a2},${hi - 8}l-5,-3v6z" fill="var(--ink)"/>`);
    o.push(`<text x="${(a1 + a2) / 2}" y="${hi - 11}" font-size="10.5" font-weight="600" text-anchor="middle" class="halo" fill="var(--ink)">${eng(M.period, 's')}</text>`);
    const step = M.microAngle;
    o.push(`<text x="${x0 + px * 2.2 + 4}" y="${ya - (2 / nP) * (ya - yb) + 12}" font-size="10" class="halo" fill="var(--tool-curve)">${r3(step)}° / pulse</text>`);
    o.push(`<text x="${x0}" y="${H - 10}" font-size="10" fill="var(--ink-soft)">${eng(M.period, 's')}/div · ${eng(M.fstep, 'Hz')}${M.fmaxHz ? ` · limit ${eng(M.fmaxHz, 'Hz')}${W < 500 ? '' : ` (${eng(1 / M.fmaxHz, 's')})`}` : ''}${M.fel && W >= 500 ? ` · phase current ${eng(M.fel, 'Hz')}` : ''}</text>`);
    ssvg.innerHTML = o.join('');
    ssvg.setAttribute('aria-label', `STEP pulses at ${eng(M.fstep, 'Hz')}, period ${eng(M.period, 's')}`);
    const over = M.fmaxHz && M.fstep > M.fmaxHz;
    scopeHead.textContent = `${eng(M.fstep, 'Hz')}${over ? ' · above the limit' : ''}`;
    scopeHead.style.color = over ? 'var(--danger)' : '';
  }

  function drawMsgs() {
    msgs.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)), ...(res?.notes || []).slice(0, 1).map((n) => h('div', { class: 'note' }, n)));
  }

  function renderAll() {
    syncInputs(); drawDial(); drawPlot(); drawScope(); drawMsgs();
    plateSteps.textContent = M ? `${M.full} STEPS/REV` : '';
  }

  // ---------- interaction ----------
  const svgPt = (e) => { const r = psvg.getBoundingClientRect(), vb = psvg.viewBox.baseVal; return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)]; };
  const setSpeed = (rpm) => {
    rpm = Math.max(0, rpm);
    if (M.linear) {
      const lead = M.lead;
      const v = rpm / 60 * lead;
      const st = v >= 100 ? 1 : v >= 10 ? 0.5 : 0.1;
      ctx.set('vlin', String(+(Math.round(v / st) * st).toFixed(2)));
    } else {
      const st = rpm >= 1000 ? 10 : rpm >= 100 ? 5 : 1;
      ctx.set('rpm', String(Math.round(rpm / st) * st));
    }
  };
  psvg.addEventListener('pointerdown', (e) => {
    if (!M) return;
    const g = e.target.closest('.h');
    const G = psvg._G;
    const p = svgPt(e);
    let kind = g?.dataset.h;
    if (!kind && p[0] > G.padL && p[1] > G.padT && p[1] < G.H - G.padB) kind = 'n'; // click anywhere on the plot moves the speed
    if (!kind) return;
    e.preventDefault();
    frozen = { xMax: G.xMax, yMax: G.yMax };
    drag = { kind, i0: num(ctx.raw.idrive), hold0: M.hold, vs0: num(ctx.raw.vs), zero0: M.zeroRpm };
    psvg.classList.add('dragging');
    psvg.setPointerCapture(e.pointerId);
    move(e);
  });
  function move(e) {
    if (!drag) return;
    const G = plotGeo(psvg._G.W, psvg._G.H);
    const p = svgPt(e);
    if (drag.kind === 'n') setSpeed(G.R(p[0]));
    else if (drag.kind === 'i' && drag.i0 > 0 && drag.hold0 > 0) {
      const v = Math.max(0.05, drag.i0 * G.T(p[1]) / drag.hold0);
      const s = String(Math.round(v * 20) / 20);
      if (s !== String(ctx.raw.idrive)) ctx.set('idrive', s);
    } else if (drag.kind === 'v' && drag.vs0 > 0 && drag.zero0 > 0) {
      const v = Math.max(1, drag.vs0 * G.R(p[0]) / drag.zero0);
      const s = String(Math.round(v * 2) / 2);
      if (s !== String(ctx.raw.vs)) ctx.set('vs', s);
    }
  }
  psvg.addEventListener('pointermove', move);
  const end = () => {
    if (!drag) return;
    const k = drag.kind; drag = null; frozen = null; psvg.classList.remove('dragging'); renderAll();
    psvg.querySelector(`.h[data-h="${k}"]`)?.focus({ preventScroll: true });
  };
  psvg.addEventListener('pointerup', end);
  psvg.addEventListener('pointercancel', end);
  psvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('.h');
    if (!g || !M) return;
    const k = g.dataset.h;
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const big = e.shiftKey;
    if (k === 'n') setSpeed(M.rpm + dir * psvg._G.xMax * (big ? 0.05 : 0.01));
    if (k === 'i') { const i0 = num(ctx.raw.idrive) || 0; ctx.set('idrive', String(Math.max(0.05, Math.round((i0 + dir * (big ? 0.25 : 0.05)) * 100) / 100))); }
    if (k === 'v') { const v0 = num(ctx.raw.vs) || 0; ctx.set('vs', String(Math.max(1, v0 + dir * (big ? 5 : 1)))); }
    requestAnimationFrame(() => psvg.querySelector(`.h[data-h="${k}"]`)?.focus({ preventScroll: true }));
  });

  ctx.onResult((r) => {
    res = r;
    M = r.motor || null;
    if (drag) { syncInputs(); drawPlot(); drawScope(); drawDial(); return; }
    renderAll();
  });
  new ResizeObserver(() => { if (!drag) { drawDial(); drawPlot(); drawScope(); } }).observe(root);
  requestAnimationFrame(tick);
}
