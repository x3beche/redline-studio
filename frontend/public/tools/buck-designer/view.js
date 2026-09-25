// Buck Converter Designer page: the power stage itself. The schematic carries
// its own numbers (the specs you scrub, the parts it sizes), and under it an
// oscilloscope shows two switching periods: the switch node, the inductor
// current and the output ripple. The waveforms are handles too - pull the
// inductor-current peak for more or less ripple, the average for more load,
// the switch pulse's falling edge for another output voltage, the ripple band
// for a tighter spec. Every number drawn comes from run()'s result.stage.

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};
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

// Engineering format, same style as the tool's texts.
const PFX = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
function eng(v, unit = '', digits = 3) {
  if (!Number.isFinite(v)) return '–';
  if (v === 0) return `0 ${unit}`.trim();
  const a = Math.abs(v);
  const [m, p] = PFX.find(([m]) => a >= m * 0.9995) || PFX[PFX.length - 1];
  return `${Number((v / m).toPrecision(digits))} ${p}${unit}`;
}
const pct = (v, d = 3) => `${Number((v * 100).toPrecision(d))} %`;

// The inputs you can scrub on the drawing: step for arrows and dragging.
const FSW = [100e3, 150e3, 200e3, 250e3, 300e3, 350e3, 400e3, 450e3, 500e3, 600e3, 700e3, 750e3, 800e3, 1e6, 1.2e6, 1.5e6,
  1.8e6, 2e6, 2.2e6, 2.5e6, 3e6, 4e6, 5e6];
const IN = {
  vinmin: { label: 'min', unit: 'V', step: 0.1, min: 0.5, max: 100, px: 8 },
  vinmax: { label: 'max', unit: 'V', step: 0.1, min: 0.5, max: 100, px: 8 },
  eff: { label: 'η', unit: '%', step: 1, min: 50, max: 100, px: 6 },
  fsw: { label: 'fsw', unit: 'Hz', list: FSW, min: 10e3, max: 10e6, px: 14 },
  tonmin: { label: 'ton,min', unit: 'ns', step: 5, min: 0, max: 2000, px: 4 },
  ripple: { label: 'ΔI', unit: '%', step: 1, min: 5, max: 100, px: 5 },
  vout: { label: 'Vout', unit: 'V', step: 0.05, min: 0.3, max: 60, px: 6 },
  vripple: { label: 'ripple', unit: 'mV p-p', step: 1, min: 1, max: 1000, px: 5 },
  iout: { label: 'Iout', unit: 'A', step: 0.1, min: 0.01, max: 100, px: 8 },
  istep: { label: 'step', unit: 'A', step: 0.1, min: 0, max: 100, px: 8 },
  vstep: { label: '±', unit: 'mV', step: 5, min: 1, max: 5000, px: 4 },
};
const dec = (step) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
function fmtIn(key, v) {
  if (key === 'fsw') return v >= 1e6 ? `${Number((v / 1e6).toPrecision(4))}M` : `${Number((v / 1e3).toPrecision(4))}k`;
  return String(Number(v.toFixed(dec(IN[key].step))));
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const CSS = `
.bk { --tool-sw: #6b4fd8; --tool-il: #1f4ed8; --tool-vo: #0f8a78; --tool-ghost: #8a99a8; --tool-wire: #3d4a57; --tool-hatch: #b7791f;
  display: flex; flex-direction: column; gap: 10px; min-width: 0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .bk {
  --tool-sw: #a993ff; --tool-il: #7d9bff; --tool-vo: #3cc7b3; --tool-ghost: #5d6d7c; --tool-wire: #9fb0bf; --tool-hatch: #e8a735; } }
:root[data-theme="dark"] .bk { --tool-sw: #a993ff; --tool-il: #7d9bff; --tool-vo: #3cc7b3; --tool-ghost: #5d6d7c; --tool-wire: #9fb0bf; --tool-hatch: #e8a735; }
.k-page { padding: 12px; }
.bk-side .bk-card:empty { display: none; }
.bk-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; position: relative; }
.bk-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; padding: 6px 10px 0; font-size: 11.5px; color: var(--ink-soft); }
.bk-head b { color: var(--ink); font-weight: 600; font-size: 12.5px; }
.bk-head .r { margin-left: auto; }
.bk-sch svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.bk-mid { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 10px; align-items: start; }
@media (max-width: 1080px) { .bk-mid { grid-template-columns: minmax(0, 1fr); } }
.bk-scope .plot { height: clamp(300px, calc(100vh - 372px), 560px); }
.bk-scope svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
@media (max-width: 640px) { .bk-scope .plot { height: 400px; } }
.bk-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
@media (max-width: 1080px) and (min-width: 700px) { .bk-side { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; } .bk-side .bk-warn { grid-column: 1 / -1; order: -1; } }
.bk-legend { display: inline-flex; flex-wrap: wrap; gap: 3px 12px; }
.bk-legend i { display: inline-block; width: 16px; height: 0; border-top: 2px solid; vertical-align: middle; margin-right: 4px; }
.bk-legend i.g { border-top-style: dashed; border-color: var(--tool-ghost); }
.bk svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11.5px; fill: var(--ink); }
.bk svg text.soft { fill: var(--ink-soft); }
.bk svg text.sm { font-size: 10.5px; }
.bk svg text.big { font-size: 13px; font-weight: 600; }
.bk svg text.sans { font-family: "IBM Plex Sans", -apple-system, "Segoe UI", sans-serif; }
.bk svg .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3.5px; stroke-linejoin: round; }
.bk .wire { stroke: var(--tool-wire); stroke-width: 1.6; fill: none; stroke-linecap: round; }
.bk .part { stroke: var(--ink); stroke-width: 1.8; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.bk .part.sw { stroke: var(--tool-sw); } .bk .part.il { stroke: var(--tool-il); } .bk .part.vo { stroke: var(--tool-vo); }
.bk .dot { fill: var(--tool-wire); }
.bk .chip rect { fill: var(--sunken); stroke: var(--line); }
.bk .chip.out rect { fill: var(--surface); stroke: var(--line-soft); }
.bk .chip.ok rect { stroke: var(--ok); } .bk .chip.warn rect { stroke: var(--warn); } .bk .chip.bad rect { stroke: var(--danger); stroke-width: 1.5; }
.bk .chip.ed { cursor: ew-resize; outline: none; }
.bk .chip.ed rect { stroke-dasharray: 3 2; stroke: var(--ink-soft); }
.bk .chip.ed:hover rect { fill: var(--line-soft); }
.bk .chip.ed:focus-visible rect { stroke: var(--accent); stroke-width: 2; stroke-dasharray: none; }
.bk .chip text.v { font-weight: 600; }
.bk .grid { stroke: var(--line-soft); stroke-width: 1; }
.bk .axis { stroke: var(--line); stroke-width: 1; }
.bk .zero { stroke: var(--line); stroke-width: 1; stroke-dasharray: 2 3; }
.bk .tr { fill: none; stroke-width: 2; stroke-linejoin: round; }
.bk .tr.sw { stroke: var(--tool-sw); } .bk .tr.il { stroke: var(--tool-il); } .bk .tr.vo { stroke: var(--tool-vo); }
.bk .tr.ghost { stroke: var(--tool-ghost); stroke-width: 1.4; stroke-dasharray: 5 3; }
.bk .fill.sw { fill: var(--tool-sw); opacity: .10; } .bk .fill.il { fill: var(--tool-il); opacity: .10; }
.bk .band { fill: var(--tool-vo); opacity: .12; }
.bk .bandedge { stroke: var(--tool-vo); stroke-width: 1; stroke-dasharray: 4 3; }
.bk .lim { stroke: var(--danger); stroke-width: 1.2; stroke-dasharray: 6 3; }
.bk .avg { stroke: var(--ink-soft); stroke-width: 1.2; stroke-dasharray: 7 4; }
.bk .hatch { fill: url(#bk-hatch); stroke: var(--tool-hatch); stroke-width: 1; }
.bk .hatch.bad { fill: url(#bk-hatch-bad); stroke: var(--danger); }
.bk .h { cursor: grab; outline: none; }
.bk .h .hc { fill: var(--surface); stroke-width: 2; }
.bk .h.il .hc { stroke: var(--tool-il); } .bk .h.sw .hc { stroke: var(--tool-sw); } .bk .h.vo .hc { stroke: var(--tool-vo); }
.bk .h.hatchh .hc { stroke: var(--tool-hatch); } .bk .h.cur .hc { stroke: var(--ink-soft); }
.bk .h:hover .hc { fill: var(--sunken); }
.bk .h:focus-visible .hc { stroke: var(--accent); stroke-width: 3; }
.bk .h .hit { fill: transparent; stroke: none; }
.bk .cursor { stroke: var(--ink-soft); stroke-width: 1; stroke-dasharray: 1 2; }
.bk .readout rect { fill: var(--surface); stroke: var(--line); }
.bk .dragging, .bk .dragging * { cursor: grabbing !important; }
.bk-edit { position: absolute; z-index: 3; padding: 1px 4px; border: 2px solid var(--accent); border-radius: 4px; background: var(--surface);
  font: 600 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.bk-bars { padding: 4px 10px 8px; display: flex; flex-direction: column; gap: 5px; }
.bk-bar { display: grid; grid-template-columns: 116px minmax(0, 1fr) 64px; gap: 6px; align-items: center; font-size: 11.5px; color: var(--ink-soft); }
.bk-bar .t { height: 9px; background: var(--sunken); border-radius: 2px; position: relative; overflow: hidden; }
.bk-bar .t i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--line); border-radius: 2px; }
.bk-bar.win { color: var(--ink); font-weight: 600; }
.bk-bar.win .t i { background: var(--tool-vo); }
.bk-bar b { font: 500 11.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; color: var(--ink); }
.bk-big { display: flex; align-items: baseline; gap: 8px; padding: 2px 10px 4px; flex-wrap: wrap; }
.bk-big b { font: 600 20px "IBM Plex Mono", ui-monospace, monospace; color: var(--tool-vo); }
.bk-big span { font-size: 11.5px; color: var(--ink-soft); }
.bk-tab { width: 100%; border-collapse: collapse; font-size: 11.5px; margin: 2px 0 6px; }
.bk-tab th { font-weight: 500; color: var(--ink-soft); text-align: right; padding: 2px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.bk-tab td { padding: 2px 8px; text-align: right; border-bottom: 1px solid var(--line-soft); font-family: "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; }
.bk-tab th:first-child, .bk-tab td:first-child { text-align: left; }
.bk-tab tr.cur td { color: var(--tool-il); font-weight: 600; }
.bk-tab tr.gh td { color: var(--ink-soft); }
.bk-warn { display: flex; flex-direction: column; gap: 5px; }
.bk-warn div { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 5px; padding: 5px 9px; font-size: 12px; }
.bk-warn:empty { display: none; }
.bk-outs .k-out { max-height: 260px; }
.bk-notes { font-size: 12px; color: var(--ink-soft); }
.bk-notes summary { cursor: pointer; }
.bk-notes ul { margin: 6px 0 0; padding-left: 18px; }
.bk-foot { font-size: 11px; color: var(--ink-soft); padding: 0 10px 6px; }
.bk-foot kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; background: var(--sunken); }
`;

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  let st = null, res = null, drag = null, cursorF = 0.36, focusKey = null, editing = null;

  // ---------- structure ----------
  const sch = s('svg', { role: 'group', 'aria-label': 'Buck power stage schematic' });
  const schCard = h('section', { class: 'bk-card bk-sch' },
    h('div', { class: 'bk-head' }, h('b', {}, 'Power stage'),
      h('span', {}, 'Dashed values are yours: drag sideways, arrow keys, or Enter to type. Solid values are what it sizes.')),
    sch);
  const scope = s('svg', { role: 'group', 'aria-label': 'Waveforms over two switching periods' });
  const legend = h('span', { class: 'bk-legend' });
  const scopeCard = h('section', { class: 'bk-card bk-scope' },
    h('div', { class: 'bk-head' }, h('b', {}, 'Waveforms'), h('span', { class: 'sub' }), legend),
    h('div', { class: 'plot' }, scope),
    h('div', { class: 'bk-foot' }, 'Drag the ', h('b', {}, '●'), ' handles: iL peak = ripple, iL average = load, pulse edge = Vout, hatched block = minimum on-time, band edge = allowed output ripple. Drag the background to move the cursor. Focused handles take ',
      h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' / ', h('kbd', {}, '←'), h('kbd', {}, '→'), '.'));
  const coutCard = h('section', { class: 'bk-card' });
  const vinCard = h('section', { class: 'bk-card' });
  const warnBox = h('div', { class: 'bk-warn', 'aria-live': 'polite' });
  const side = h('aside', { class: 'bk-side' }, coutCard, warnBox, vinCard);
  const notes = h('details', { class: 'bk-notes' });
  ctx.outputs.classList.add('bk-outs');
  root.append(h('div', { class: 'bk' }, schCard, h('div', { class: 'bk-mid' }, scopeCard, side), ctx.outputs, notes));

  // ---------- value chips (the scrubbable inputs) ----------
  const cw = 7.0; // monospace advance at 11.5px
  function chip(g, x, y, parts, opts = {}) {
    // parts: [[text, cls]]; opts: {key, tone, anchor}
    const txt = parts.map((p) => p[0]).join('');
    const w = txt.length * cw + 12, hgt = 19;
    const x0 = opts.anchor === 'end' ? x - w : opts.anchor === 'middle' ? x - w / 2 : x;
    const cls = `chip ${opts.key ? 'ed' : 'out'}${opts.tone ? ' ' + opts.tone : ''}`;
    const c = s('g', { class: cls, transform: `translate(${x0.toFixed(1)},${(y - 13).toFixed(1)})` });
    c.append(s('rect', { x: 0, y: 0, width: w.toFixed(1), height: hgt, rx: 3 }));
    const t = s('text', { x: 6, y: 13.5 });
    for (const [str, cl] of parts) t.append(s('tspan', { class: cl || null }, str));
    c.append(t);
    if (opts.key) {
      const def = IN[opts.key];
      c.setAttribute('tabindex', '0');
      c.setAttribute('role', 'spinbutton');
      c.setAttribute('data-key', opts.key);
      c.setAttribute('aria-label', `${opts.name || def.label} in ${def.unit}`);
      c.setAttribute('aria-valuenow', String(ctx.input[opts.key] ?? ''));
      const tt = s('title', {}, `${opts.name || def.label}: drag sideways, arrow keys, Enter to type`); c.append(tt);
    }
    if (opts.title) c.append(s('title', {}, opts.title));
    g.append(c);
    return w;
  }
  function stepIn(key, dir, big) {
    const def = IN[key];
    const v = ctx.input[key];
    const cur = Number.isFinite(v) ? v : def.min;
    let nv;
    if (def.list) {
      const L = def.list;
      let i = L.findIndex((x) => x >= cur * 0.999);
      if (i < 0) i = L.length;
      if (dir > 0) i = L[i] > cur * 1.001 ? i : i + 1; else i = i - 1;
      if (big) i += dir * 3;
      nv = L[clamp(i, 0, L.length - 1)];
    } else nv = cur + dir * def.step * (big ? 10 : 1);
    nv = clamp(nv, def.min, def.max);
    ctx.set(key, fmtIn(key, nv));
  }
  function openEditor(svgEl, key) {
    const card = svgEl.closest('.bk-card');
    const r = svgEl.getBoundingClientRect(), cr = card.getBoundingClientRect();
    const inp = h('input', { class: 'bk-edit', spellcheck: 'false', inputmode: 'decimal', 'aria-label': IN[key].label });
    inp.value = ctx.raw[key] ?? '';
    inp.style.left = `${r.left - cr.left}px`; inp.style.top = `${r.top - cr.top - 2}px`; inp.style.width = `${Math.max(70, r.width + 16)}px`;
    card.append(inp); inp.focus(); inp.select();
    editing = key;
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true; editing = null;
      const v = inp.value.trim(); inp.remove();
      focusKey = key;
      if (commit && v !== String(ctx.raw[key] ?? '')) ctx.set(key, v); else restoreFocus();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }
  function restoreFocus() {
    if (!focusKey || editing) return;
    const el = root.querySelector(`[data-key="${focusKey}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }
  // Which handle had the keyboard, so a redraw can hand focus back to its successor.
  document.addEventListener('focusin', (e) => { if (e.target.classList?.contains('bk-edit')) return; focusKey = e.target.getAttribute?.('data-key') || null; });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('[data-key]')) focusKey = null; }, true);

  // Chips: drag sideways, arrows, Enter.
  sch.addEventListener('keydown', (e) => {
    const c = e.target.closest?.('.chip.ed'); if (!c) return;
    const key = c.dataset.key;
    focusKey = key;
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); openEditor(c, key); return; }
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 1, PageDown: -1 }[e.key];
    if (!dir) return;
    e.preventDefault(); stepIn(key, dir, e.shiftKey || e.key.startsWith('Page'));
  });
  sch.addEventListener('dblclick', (e) => { const c = e.target.closest('.chip.ed'); if (c) openEditor(c, c.dataset.key); });
  sch.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.chip.ed'); if (!c) return;
    e.preventDefault();
    const key = c.dataset.key;
    focusKey = key; c.focus({ preventScroll: true });
    drag = { kind: 'chip', key, x0: e.clientX, v0: ctx.input[key], moved: false, last: 0 };
    sch.setPointerCapture(e.pointerId); sch.classList.add('dragging');
  });
  sch.addEventListener('pointermove', (e) => {
    if (!drag || drag.kind !== 'chip') return;
    const def = IN[drag.key];
    const dx = e.clientX - drag.x0;
    if (Math.abs(dx) > 2) drag.moved = true;
    const n = Math.round(dx / def.px);
    if (n === drag.last) return;
    drag.last = n;
    let nv;
    if (def.list) {
      const L = def.list; let i0 = L.findIndex((x) => x >= (drag.v0 || L[0]) * 0.999); if (i0 < 0) i0 = L.length - 1;
      nv = L[clamp(i0 + n, 0, L.length - 1)];
    } else nv = clamp((Number.isFinite(drag.v0) ? drag.v0 : def.min) + n * def.step, def.min, def.max);
    ctx.set(drag.key, fmtIn(drag.key, nv));
  });
  const endChip = () => { if (drag?.kind === 'chip') { drag = null; sch.classList.remove('dragging'); } };
  sch.addEventListener('pointerup', endChip);
  sch.addEventListener('pointercancel', endChip);

  // ---------- schematic ----------
  function drawSchematic() {
    const W = Math.max(300, sch.clientWidth || sch.parentNode.clientWidth || 900);
    const two = W < 1060;
    sch.replaceChildren();
    if (!st) return;
    const warnIds = new Set(warnKinds());
    const by = { ripple: 'by ripple', release: 'by load release', apply: 'by load apply', loop: 'by loop speed' }[st.cOutBy] || '';
    // Every chip once: [parts, opts]. Wide screens place them by the part; narrow ones flow them under it.
    const C = {
      vinmin: [[['min ', 'soft'], [fmtVal('vinmin'), 'v'], [' V', 'soft']], { key: 'vinmin', name: 'Input voltage, minimum' }],
      vinmax: [[['max ', 'soft'], [fmtVal('vinmax'), 'v'], [' V', 'soft']], { key: 'vinmax', name: 'Input voltage, maximum' }],
      cin: [[['Cin ≥ ', 'soft'], [eng(st.cIn, 'F'), 'v']], { title: 'Input capacitance for 1 % input ripple' }],
      cinrms: [[[eng(st.icinRms, 'A'), 'v'], [' rms', 'soft']], { title: `Input capacitor RMS current at D = ${pct(st.dWorst)}` }],
      duty: [[['D ', 'soft'], [`${Number((st.dmin * 100).toPrecision(3))}–${Number((st.dmax * 100).toPrecision(3))}`, 'v'], [' %', 'soft']],
        { tone: warnIds.has('duty') ? 'warn' : null, title: `Duty cycle at ${eng(st.vinmax, 'V')} and ${eng(st.vinmin, 'V')}` }],
      fsw: [[['fsw ', 'soft'], [fmtVal('fsw', true), 'v'], ['Hz', 'soft']], { key: 'fsw', name: 'Switching frequency' }],
      tonmin: [[['ton,min ', 'soft'], [fmtVal('tonmin'), 'v'], [' ns', 'soft']], { key: 'tonmin', name: 'Controller minimum on-time', tone: warnIds.has('ton') ? 'bad' : null }],
      eff: [[['η ', 'soft'], [fmtVal('eff'), 'v'], [' %', 'soft']], { key: 'eff', name: 'Efficiency' }],
      L: [[['L ', 'soft'], [eng(st.L, 'H'), 'v'], [` E12 · calc ${eng(st.lCalc, 'H')}`, 'soft']], { tone: warnIds.has('ripple') ? 'warn' : 'ok', title: 'Inductance: the nearest E12 value to the calculated one' }],
      ripple: [[['ΔI ', 'soft'], [fmtVal('ripple'), 'v'], [' % of Iout', 'soft']], { key: 'ripple', name: 'Inductor ripple' }],
      isat: [[['Isat ≥ ', 'soft'], [eng(st.isat, 'A'), 'v']], { title: `Peak ${eng(st.ipk, 'A')} plus 20 % margin` }],
      irms: [[['Irms ', 'soft'], [eng(st.irms, 'A'), 'v']], { title: 'Heating rating of the inductor' }],
      vout: [[['Vout ', 'soft'], [fmtVal('vout'), 'v'], [' V', 'soft']], { key: 'vout', name: 'Output voltage' }],
      vripple: [[[fmtVal('vripple'), 'v'], [' mV p-p', 'soft']], { key: 'vripple', name: 'Output ripple allowed' }],
      cout: [[['Cout ≥ ', 'soft'], [eng(st.cOut, 'F'), 'v']], { tone: 'ok', title: 'Minimum effective output capacitance (after DC-bias derating)' }],
      esr: [[['ESR ≤ ', 'soft'], [eng(st.esrMax, 'Ω'), 'v']], { title: 'Maximum ESR for the output ripple' }],
      iout: [[['Iout ', 'soft'], [fmtVal('iout'), 'v'], [' A', 'soft']], { key: 'iout', name: 'Output current, maximum' }],
      istep: [[['step ', 'soft'], [fmtVal('istep'), 'v'], [' A', 'soft']], { key: 'istep', name: 'Load step' }],
      vstep: [[['± ', 'soft'], [fmtVal('vstep'), 'v'], [' mV', 'soft']], { key: 'vstep', name: 'Deviation allowed on the step' }],
    };
    const put = (g, k, x, y, anchor) => chip(g, x, y, C[k][0], { ...C[k][1], anchor });
    const flow = (g, keys, x0, y0, maxX) => {
      let x = x0, y = y0;
      for (const k of keys) {
        const w = C[k][0].map((p) => p[0]).join('').length * cw + 12;
        if (x + w > maxX && x > x0) { x = x0; y += 24; }
        put(g, k, x, y); x += w + 6;
      }
      return y;
    };

    // --- the symbols ---
    const source = (g, x, yt, yg) => {
      const ym = (yt + yg) / 2;
      g.append(s('path', { class: 'wire', d: `M${x},${yt}V${ym - 17}M${x},${ym + 17}V${yg}` }));
      g.append(s('circle', { class: 'part', cx: x, cy: ym, r: 17 }));
      g.append(s('text', { x, y: ym - 3, 'text-anchor': 'middle', class: 'sm' }, '+'));
      g.append(s('text', { x, y: ym + 12, 'text-anchor': 'middle', class: 'sm' }, '−'));
    };
    const cap = (g, x, yt, yg, cls, pol) => {
      const ym = (yt + yg) / 2;
      g.append(s('path', { class: 'wire', d: `M${x},${yt}V${ym - 5}M${x},${ym + 5}V${yg}` }));
      g.append(s('path', { class: `part ${cls}`, d: pol ? `M${x - 13},${ym - 5}H${x + 13}M${x - 13},${ym + 7}q13,-6 26,0` : `M${x - 13},${ym - 5}H${x + 13}M${x - 13},${ym + 5}H${x + 13}` }));
      g.append(s('circle', { class: 'dot', cx: x, cy: yt, r: 2.6 }), s('circle', { class: 'dot', cx: x, cy: yg, r: 2.6 }));
    };
    const hsw = (g, x0, x1, y) => {
      g.append(s('path', { class: 'part sw', d: `M${x0},${y}h8l${(x1 - x0 - 16) * 0.8},-14M${x1 - 8},${y}h8` }));
      g.append(s('circle', { class: 'part sw', cx: x0 + 8, cy: y, r: 2.2 }), s('circle', { class: 'part sw', cx: x1 - 8, cy: y, r: 2.2 }));
    };
    const lsw = (g, x, yt, yg) => {
      const ym = (yt + yg) / 2;
      g.append(s('path', { class: 'wire', d: `M${x},${yt}V${ym - 18}M${x},${ym + 18}V${yg}` }));
      g.append(s('path', { class: 'part sw', d: `M${x},${ym - 18}l12,30` }));
      g.append(s('circle', { class: 'part sw', cx: x, cy: ym - 18, r: 2.2 }), s('circle', { class: 'part sw', cx: x, cy: ym + 18, r: 2.2 }));
      g.append(s('circle', { class: 'dot', cx: x, cy: yt, r: 2.6 }), s('circle', { class: 'dot', cx: x, cy: yg, r: 2.6 }));
    };
    const coil = (g, x0, x1, y) => {
      const n = 4, hw = (x1 - x0) / n;
      let d = `M${x0},${y}`;
      for (let i = 0; i < n; i++) d += `a${hw / 2},${hw / 2 * 0.9} 0 0 1 ${hw},0`;
      g.append(s('path', { class: 'part il', d }));
    };
    const load = (g, x, yt, yg) => {
      const ym = (yt + yg) / 2;
      g.append(s('path', { class: 'wire', d: `M${x},${yt}V${ym - 17}M${x},${ym + 17}V${yg}` }));
      g.append(s('circle', { class: 'part', cx: x, cy: ym, r: 17 }));
      g.append(s('path', { class: 'part', d: `M${x},${ym - 10}V${ym + 11}M${x - 5},${ym + 5}L${x},${ym + 12}L${x + 5},${ym + 5}` }));
      g.append(s('circle', { class: 'dot', cx: x, cy: yt, r: 2.6 }));
    };
    const ground = (g, x, y) => g.append(s('path', { class: 'wire', d: `M${x},${y}v8M${x - 9},${y + 8}h18M${x - 6},${y + 12}h12M${x - 3},${y + 16}h6` }));
    const txt = (g, x, y, t, cls = 'sans soft sm', anchor) => g.append(s('text', { x, y, class: cls, 'text-anchor': anchor || null }, t));
    const swLabel = (g, x, y) => g.append(s('text', { x, y, 'text-anchor': 'end', class: 'sans sm', style: 'fill:var(--tool-sw)' }, 'SW'));

    if (!two) {
      const A = Math.round(W * 0.47), B = W - A, H = 206, top = 68, gnd = 176;
      sch.setAttribute('viewBox', `0 0 ${W} ${H}`); sch.setAttribute('height', H);
      const gA = s('g'), gB = s('g', { transform: `translate(${A},0)` });
      sch.append(gA, gB);
      const xV = 34, xCin = Math.max(110, A * 0.22), xHs0 = A * 0.52, xHs1 = A * 0.70, xLs = A * 0.86;
      gA.append(s('path', { class: 'wire', d: `M${xV},${top}H${xHs0}M${xHs1},${top}H${A}M${xV},${gnd}H${A}` }));
      source(gA, xV, top, gnd);
      txt(gA, 10, 20, 'VIN', 'big');
      let x = 44;
      x += put(gA, 'vinmin', x, 22) + 5; put(gA, 'vinmax', x, 22);
      cap(gA, xCin, top, gnd, '');
      put(gA, 'cin', xCin + 16, 132); put(gA, 'cinrms', xCin + 16, 155);
      hsw(gA, xHs0, xHs1, top);
      txt(gA, (xHs0 + xHs1) / 2, top + 16, 'high side', 'sans soft sm', 'middle');
      put(gA, 'duty', (xHs0 + xHs1) / 2, 34, 'middle');
      const wCin = C.cin[0].map((p) => p[0]).join('').length * cw + 12;
      const cxD = Math.max(xCin + 16 + wCin + 12, xHs0 - 30);
      put(gA, 'fsw', cxD, 104); put(gA, 'tonmin', cxD, 128); put(gA, 'eff', cxD, 152);
      lsw(gA, xLs, top, gnd);
      txt(gA, xLs + 16, 128, 'low'); txt(gA, xLs + 16, 141, 'side');
      swLabel(gA, xLs - 6, top - 8);
      ground(gA, xV + 40, gnd);
      const wCout = C.cout[0].map((p) => p[0]).join('').length * cw + 12;
      const xL0 = 26, xL1 = xL0 + Math.min(170, B * 0.3), xVo = xL1 + 30, xCo = xVo + Math.max(46, B * 0.1), xLd = Math.min(B - 96, xCo + 16 + wCout + 34);
      gB.append(s('path', { class: 'wire', d: `M0,${top}H${xL0}M${xL1},${top}H${xLd}M0,${gnd}H${xLd}` }));
      coil(gB, xL0, xL1, top);
      put(gB, 'L', xL0, 26); put(gB, 'ripple', xL0, 104); put(gB, 'isat', xL0, 128); put(gB, 'irms', xL0, 152);
      gB.append(s('circle', { class: 'dot', cx: xVo, cy: top, r: 3 }));
      txt(gB, xVo + 8, top - 34, 'VOUT', 'big');
      put(gB, 'vout', xVo + 8, top - 12);
      put(gB, 'vripple', xVo + 8 + 90, top - 12);
      cap(gB, xCo, top, gnd, 'vo', true);
      put(gB, 'cout', xCo + 16, 116); put(gB, 'esr', xCo + 16, 140);
      txt(gB, xCo + 18, 164, `set ${by}`);
      load(gB, xLd, top, gnd);
      txt(gB, xLd + 24, 94, 'Load');
      const lx = xLd + 24, sx = Math.min(lx, B - 110);
      put(gB, 'iout', lx, 118); put(gB, 'istep', sx, 144); put(gB, 'vstep', sx, 168);
      sch.querySelectorAll('text.big').forEach((t) => { if (t.textContent === 'VOUT') t.setAttribute('style', 'fill:var(--tool-vo)'); });
    } else {
      // Narrow: each half is a small drawing (at most 480 wide); its numbers flow beside it when
      // there is room, under it when not.
      const Wd = Math.min(W - 4, 480), beside = W - Wd >= 300;
      const fx0 = beside ? Wd + 24 : 8, fmax = W - 6;
      const top = 30, gnd = 104;
      const g1 = s('g'); sch.append(g1);
      const xV = 26, xCin = Wd * 0.30, xHs0 = Wd * 0.44, xHs1 = Wd * 0.64, xLs = Wd * 0.80, xOut = Wd - 12;
      txt(g1, 10, 16, 'VIN', 'big');
      g1.append(s('path', { class: 'wire', d: `M${xV},${top}H${xHs0}M${xHs1},${top}H${xOut}M${xV},${gnd}H${xOut}` }));
      source(g1, xV, top, gnd); cap(g1, xCin, top, gnd, ''); hsw(g1, xHs0, xHs1, top); lsw(g1, xLs, top, gnd);
      txt(g1, xCin + 16, 64, 'Cin'); swLabel(g1, xLs - 6, top - 8);
      txt(g1, xOut, top - 8, 'to L ↓', 'sans soft sm', 'end');
      let y = flow(g1, ['vinmin', 'vinmax', 'duty', 'fsw', 'tonmin', 'eff', 'cin', 'cinrms'], fx0, beside ? top + 4 : gnd + 34, fmax);
      const y2 = Math.max(beside ? gnd + 24 : 0, y + 22);
      const g2 = s('g', { transform: `translate(0,${y2})` }); sch.append(g2);
      const xL0 = 16, xL1 = Math.min(Wd * 0.42, 190), xVo = xL1 + 16, xCo = Wd * 0.62, xLd = Wd * 0.84;
      g2.append(s('path', { class: 'wire', d: `M${xL1},${top}H${xLd}M4,${gnd}H${xLd}M4,${top}H${xL0}` }));
      coil(g2, xL0, xL1, top);
      g2.append(s('circle', { class: 'dot', cx: xVo, cy: top, r: 3 }));
      g2.append(s('text', { x: xVo - 4, y: top - 10, class: 'big', style: 'fill:var(--tool-vo)' }, 'VOUT'));
      cap(g2, xCo, top, gnd, 'vo', true); load(g2, xLd, top, gnd);
      txt(g2, xCo - 16, 64, 'Cout', 'sans soft sm', 'end'); txt(g2, xLd + 21, 64, 'Load');
      txt(g2, xCo - 16, 78, by, 'sans soft sm', 'end');
      y = flow(g2, ['L', 'ripple', 'isat', 'irms', 'vout', 'vripple', 'cout', 'esr', 'iout', 'istep', 'vstep'], fx0, beside ? top + 4 : gnd + 34, fmax);
      const H = y2 + Math.max(y, beside ? gnd + 20 : 0) + 14;
      sch.setAttribute('viewBox', `0 0 ${W} ${H}`); sch.setAttribute('height', H);
    }
    restoreFocus();
  }
  // What the input box holds, shown as typed (500k stays 500k).
  function fmtVal(key, engHz) {
    const v = ctx.input[key];
    if (!Number.isFinite(v)) return String(ctx.raw[key] ?? '–') || '–';
    if (engHz) return eng(v, '').replace(' ', '') + ' ';
    return String(Number(v.toPrecision(4)));
  }
  function warnKinds() {
    const out = [];
    for (const w of res?.warnings || []) {
      if (/on-time/.test(w)) out.push('ton');
      else if (/Duty cycle reaches/.test(w)) out.push('duty');
      else if (/ripple is outside/.test(w)) out.push('ripple');
    }
    return out;
  }

  // ---------- oscilloscope ----------
  let geom = null, frozen = null; // axis scales held still while a waveform handle is dragged
  function drawScope() {
    const W = Math.max(300, scope.clientWidth || 800), H = Math.max(260, scope.clientHeight || 360);
    scope.setAttribute('viewBox', `0 0 ${W} ${H}`);
    scope.replaceChildren();
    if (!st) return;
    const narrow = W < 560;
    const L = narrow ? 46 : 62, R = narrow ? 8 : 150, T = 8, B = 26, gap = 16;
    const ph = H - T - B - 2 * gap;
    const hSW = ph * 0.22, hIL = ph * 0.46, hVO = ph - hSW - hIL;
    const ySW = T, yIL = ySW + hSW + gap, yVO = yIL + hIL + gap;
    const Tp = 1 / st.fsw, span = 2 * Tp;
    const X = (t) => L + ((W - L - R) * t) / span;
    const defs = s('defs');
    defs.innerHTML = `<pattern id="bk-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--tool-hatch)" opacity=".10"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--tool-hatch)" stroke-width="1.6" opacity=".55"/></pattern>
      <pattern id="bk-hatch-bad" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--danger)" opacity=".12"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--danger)" stroke-width="1.6" opacity=".7"/></pattern>
      <clipPath id="bk-clip"><rect x="${L}" y="0" width="${W - L - R}" height="${H}"/></clipPath>`;
    scope.append(defs);
    const bg = s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', 'data-drag': 'cursor' });
    scope.append(bg);
    const plot = s('g', { 'clip-path': 'url(#bk-clip)' });
    // time grid: quarter periods
    for (let k = 0; k <= 8; k++) {
      const t = (k * Tp) / 4, xx = X(t);
      scope.append(s('line', { class: k % 4 ? 'grid' : 'axis', x1: xx, x2: xx, y1: T, y2: H - B }));
      if (k % (narrow ? 4 : 2) === 0) scope.append(s('text', { x: xx, y: H - 8, 'text-anchor': narrow && k === 8 ? 'end' : 'middle', class: 'soft sm' }, k ? eng(t, 's') : '0'));
    }
    scope.append(plot);
    const warnIds = new Set(warnKinds());
    const hi = st.perVin[st.perVin.length - 1], lo = st.perVin[0];
    const ghost = st.perVin.length > 1;
    const lab = (x, y, t, cls = 'soft sm', anchor = 'start') => scope.append(s('text', { x, y, 'text-anchor': anchor, class: `${cls} halo` }, t));
    // The channel's name and numbers: a column at the right, or one line inside the plot when narrow.
    const side = (y0, items) => {
      if (!narrow) { for (const [t, y, cls] of items) lab(W - R + 8, y, t, cls); return; }
      const line = items.filter((it) => it[3]).map((it) => it[0]).join(' · ');
      lab(W - R - 4, y0 + 12, line, 'sm', 'end');
    };
    const handle = (x, y, kind, cls, label, shape = 'c') => {
      const g = s('g', { class: `h ${cls}`, tabindex: '0', role: 'slider', 'aria-label': label, 'data-drag': kind, 'data-key': `h-${kind}` });
      g.append(s('circle', { class: 'hit', cx: x, cy: y, r: 13 }));
      if (shape === 'd') g.append(s('path', { class: 'hc', d: `M${x},${y - 7}L${x + 7},${y}L${x},${y + 7}L${x - 7},${y}Z` }));
      else g.append(s('circle', { class: 'hc', cx: x, cy: y, r: 6 }));
      g.append(s('title', {}, label));
      scope.append(g);
      return g;
    };

    // --- channel 1: switch node ---
    const vTop = frozen?.vTop ?? st.vinmax * 1.18;
    const YS = (v) => ySW + hSW - (hSW * v) / vTop;
    scope.append(s('line', { class: 'zero', x1: L, x2: W - R, y1: YS(0), y2: YS(0) }));
    lab(L - 6, YS(0) + 4, '0', 'soft sm', 'end');
    lab(L - 6, YS(st.vinmax) + 4, `${Number(st.vinmax.toPrecision(3))} V`, 'soft sm', 'end');
    const pulse = (vin, dd) => {
      let p = `M${X(0)},${YS(vin)}`;
      for (let k = 0; k < 2; k++) {
        const t0 = k * Tp, t1 = t0 + dd * Tp, t2 = (k + 1) * Tp;
        p += `L${X(t0)},${YS(vin)}L${X(t1)},${YS(vin)}L${X(t1)},${YS(0)}L${X(t2)},${YS(0)}L${X(t2)},${YS(vin)}`;
      }
      return p;
    };
    // minimum on-time: hatched from each rising edge
    if (st.tonmin > 0) {
      for (let k = 0; k < 2; k++) plot.append(s('rect', { class: `hatch${warnIds.has('ton') ? ' bad' : ''}`, x: X(k * Tp), y: YS(st.vinmax * 1.1), width: Math.max(1, X(k * Tp + st.tonmin) - X(k * Tp)), height: YS(0) - YS(st.vinmax * 1.1) }));
    }
    if (ghost) plot.append(s('path', { class: 'tr ghost', d: pulse(lo.vin, lo.d) }));
    plot.append(s('path', { class: 'fill sw', d: pulse(hi.vin, hi.d) + `L${X(span)},${YS(0)}L${X(0)},${YS(0)}Z` }));
    plot.append(s('path', { class: 'tr sw', d: pulse(hi.vin, hi.d) }));
    // on-time dimension
    const tOnX = X(hi.d * Tp);
    const dimY = YS(st.vinmax) - 7;
    scope.append(s('path', { class: 'axis', d: `M${X(0)},${dimY}H${tOnX}` }));
    if (!narrow) lab(X(Tp + hi.d * Tp) + 6, YS(st.vinmax) + 12, `ton ${eng(st.tonAtMax, 's')} at ${Number(hi.vin.toPrecision(3))} V`, `sm${warnIds.has('ton') ? '' : ' soft'}`);
    if (warnIds.has('ton')) lab(X(Tp) + 6, YS(st.vinmax * 0.35), `below ton,min ${eng(st.tonmin, 's')}: pulses skip`, 'sm', 'start');
    if (ghost && !narrow) lab(X(lo.d * Tp) + 5, YS(lo.vin * 0.55), `${Number(lo.vin.toPrecision(3))} V: D ${pct(lo.d)}`, `sm${warnIds.has('duty') ? '' : ' soft'}`);
    side(ySW, [['SW node', ySW + 12, 'sans sm', 1], [`D ${pct(hi.d)}`, ySW + 26, 'sm', 1]]);
    handle(tOnX, YS(hi.vin * 0.55), 'duty', 'sw', `Pulse falling edge: output voltage ${Number(st.vout.toPrecision(4))} V`);
    if (st.tonmin > 0) handle(X(st.tonmin), YS(st.vinmax * 1.1), 'ton', 'hatchh', `Minimum on-time ${Number((st.tonmin * 1e9).toPrecision(4))} ns`);

    // --- channel 2: inductor current ---
    const iTop = frozen?.iTop ?? Math.max(st.isat, lo.ipk, hi.ipk) * 1.12;
    const iBot = frozen?.iBot ?? Math.min(0, st.iout - Math.max(hi.dIL, lo.dIL) / 2) * 1.1;
    const YI = (i) => yIL + hIL - (hIL * (i - iBot)) / (iTop - iBot);
    const nice = niceStep(iTop - iBot, 4);
    for (let v = Math.ceil(iBot / nice) * nice; v <= iTop; v += nice) {
      scope.append(s('line', { class: 'grid', x1: L, x2: W - R, y1: YI(v), y2: YI(v) }));
      lab(L - 6, YI(v) + 4, eng(v, 'A', 3), 'soft sm', 'end');
    }
    scope.append(s('line', { class: 'zero', x1: L, x2: W - R, y1: YI(0), y2: YI(0) }));
    const tri = (P) => {
      let p = '';
      for (let k = 0; k < 2; k++) {
        const t0 = k * Tp;
        p += `${k ? 'L' : 'M'}${X(t0)},${YI(st.iout - P.dIL / 2)}L${X(t0 + P.d * Tp)},${YI(st.iout + P.dIL / 2)}`;
      }
      return p + `L${X(span)},${YI(st.iout - P.dIL / 2)}`;
    };
    plot.append(s('line', { class: 'lim', x1: L, x2: W - R, y1: YI(st.isat), y2: YI(st.isat) }));
    if (ghost) plot.append(s('path', { class: 'tr ghost', d: tri(lo) }));
    plot.append(s('path', { class: 'fill il', d: tri(hi) + `L${X(span)},${YI(Math.max(0, iBot))}L${X(0)},${YI(Math.max(0, iBot))}Z` }));
    plot.append(s('path', { class: 'tr il', d: tri(hi) }));
    plot.append(s('line', { class: 'avg', x1: L, x2: W - R, y1: YI(st.iout), y2: YI(st.iout) }));
    // ripple bracket at the second period's peak
    const bx = X(Tp + hi.d * Tp) + 10;
    scope.append(s('path', { class: 'axis', d: `M${bx - 4},${YI(st.ipk)}h8M${bx},${YI(st.ipk)}V${YI(st.iout - st.dIL / 2)}M${bx - 4},${YI(st.iout - st.dIL / 2)}h8` }));
    const rTone = warnIds.has('ripple') ? '' : ' soft';
    if (!narrow) lab(bx + 8, (YI(st.ipk) + YI(st.iout)) / 2 + 4, `ΔI ${eng(st.dIL, 'A')} p-p · ${pct(st.dIL / st.iout)}`, `sm${rTone}`);
    const yIsat = Math.max(YI(st.isat) + 4, yIL + 27), yPk = Math.max(YI(st.ipk) + 4, yIsat + 14);
    side(yIL, [['Inductor iL', yIL + 12, 'sans sm', 1], [`Isat ≥ ${eng(st.isat, 'A')}`, yIsat, 'sm'],
      [`peak ${eng(st.ipk, 'A')}`, yPk, 'sm', 1],
      [`Iout ${eng(st.iout, 'A')}`, YI(st.iout) + 4, 'sm soft'], [`valley ${eng(st.iout - st.dIL / 2, 'A')}`, YI(st.iout - st.dIL / 2) + 12, 'sm soft'],
      [`DCM below ${eng(st.dcm, 'A')}`, yIL + hIL - 4, 'sm soft']]);
    if (narrow) lab(L + 4, YI(st.isat) - 4, `Isat ≥ ${eng(st.isat, 'A')}`, 'sm');
    if (ghost && !narrow) lab(X(lo.d * Tp) + 6, YI(lo.ipk) - 6, `${Number(lo.vin.toPrecision(3))} V: ${eng(lo.dIL, 'A')} p-p`, 'sm soft');
    handle(X(hi.d * Tp), YI(st.ipk), 'peak', 'il', `Inductor current peak: ripple ${Number((st.ripple * 100).toPrecision(3))} % of Iout`);
    handle(X(span) - 14, YI(st.iout), 'iout', 'il', `Average inductor current: load ${Number(st.iout.toPrecision(4))} A`, 'd');

    // --- channel 3: output ripple (AC coupled) ---
    const half = Math.max(st.dVout, st.vrippleCap) * 0.5;
    const vSpan = frozen?.vSpan ?? half * 1.55;
    const YV = (v) => yVO + hVO / 2 - ((hVO / 2) * v) / vSpan;
    scope.append(s('rect', { class: 'band', x: L, y: YV(st.dVout / 2), width: W - L - R, height: YV(-st.dVout / 2) - YV(st.dVout / 2) }));
    scope.append(s('line', { class: 'bandedge', x1: L, x2: W - R, y1: YV(st.dVout / 2), y2: YV(st.dVout / 2) }));
    scope.append(s('line', { class: 'bandedge', x1: L, x2: W - R, y1: YV(-st.dVout / 2), y2: YV(-st.dVout / 2) }));
    scope.append(s('line', { class: 'zero', x1: L, x2: W - R, y1: YV(0), y2: YV(0) }));
    lab(L - 6, YV(0) + 4, `${Number(st.vout.toPrecision(3))} V`, 'soft sm', 'end');
    lab(L - 6, YV(st.dVout / 2) + 4, `+${eng(st.dVout / 2, 'V', 2)}`, 'soft sm', 'end');
    lab(L - 6, YV(-st.dVout / 2) + 4, `−${eng(st.dVout / 2, 'V', 2)}`, 'soft sm', 'end');
    // shape: the capacitor integrates iL − Iout; its size is run()'s vrippleCap
    const N = 160, q = [];
    let acc = 0;
    for (let i = 0; i <= N; i++) {
      const ph = (i / N) % 1;
      const iac = ph < hi.d ? -0.5 + ph / hi.d : 0.5 - (ph - hi.d) / (1 - hi.d);
      q.push(acc); acc += iac;
    }
    const qm = (Math.max(...q) + Math.min(...q)) / 2, qa = Math.max(...q) - Math.min(...q) || 1;
    let vp = '';
    for (let k = 0; k < 2; k++) for (let i = 0; i <= N; i++) {
      const v = ((q[i] - qm) / qa) * st.vrippleCap;
      vp += `${k || i ? 'L' : 'M'}${X((k + i / N) * Tp).toFixed(1)},${YV(v).toFixed(1)}`;
    }
    plot.append(s('path', { class: 'tr vo', d: vp }));
    side(yVO, [['Vout ripple', yVO + 12, 'sans sm', 1], [`${eng(st.vrippleCap, 'V', 2)} p-p`, yVO + 26, 'sm', 1],
      [`allowed ${eng(st.dVout, 'V', 2)}`, yVO + 40, 'sm soft', 1], [`with Cout ${eng(st.cOut, 'F')}`, yVO + 54, 'sm soft']]);
    handle(X(Tp * 0.25), YV(st.dVout / 2), 'band', 'vo', `Allowed output ripple ${Number((st.dVout * 1000).toPrecision(3))} mV peak-to-peak`);

    // --- cursor ---
    const tc = cursorF * span, xc = X(tc);
    scope.append(s('line', { class: 'cursor', x1: xc, x2: xc, y1: T, y2: H - B }));
    const phc = (tc % Tp) / Tp;
    const on = phc < hi.d;
    const ilc = on ? st.iout - st.dIL / 2 + st.dIL * (phc / hi.d) : st.iout + st.dIL / 2 - st.dIL * ((phc - hi.d) / (1 - hi.d));
    const vc = ((q[Math.round(phc * N)] - qm) / qa) * st.vrippleCap;
    const ro = [[`t ${eng(tc, 's')}`, ySW + hSW - 4], [`${on ? 'on' : 'off'} · ${on ? Number(hi.vin.toPrecision(3)) : 0} V`, YS(hi.vin) + 14],
      [eng(ilc, 'A'), YI(ilc) - 8], [`${vc >= 0 ? '+' : '−'}${eng(Math.abs(vc), 'V', 2)}`, YV(vc) - 8]];
    const flip = xc > W - R - 110;
    for (const [t, yy] of ro.slice(1)) {
      const w = t.length * 6.4 + 10;
      const g = s('g', { class: 'readout' });
      g.append(s('rect', { x: flip ? xc - w - 6 : xc + 6, y: yy - 11, width: w, height: 16, rx: 3 }));
      g.append(s('text', { x: flip ? xc - w - 1 : xc + 11, y: yy + 1, class: 'sm' }, t));
      scope.append(g);
    }
    scope.append(s('text', { x: xc, y: H - B + 14, 'text-anchor': 'middle', class: 'sm halo' }, ro[0][0]));
    handle(xc, H - B, 'cursor', 'cur', `Cursor at ${eng(tc, 's')}`, 'd');
    scope.append(s('circle', { cx: xc, cy: YI(ilc), r: 3, fill: 'var(--tool-il)' }));

    geom = { X, YS, YI, YV, L, R, W, Tp, span, T, B, H, vTop, iTop, iBot, vSpan };
    restoreFocus();
  }
  function niceStep(range, n) {
    const raw = range / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  // scope dragging
  const pt = (e) => { const r = scope.getBoundingClientRect(), vb = scope.viewBox.baseVal; return { x: ((e.clientX - r.left) * vb.width) / r.width, y: ((e.clientY - r.top) * vb.height) / r.height }; };
  function applyScope(kind, p) {
    if (!geom || !st) return;
    const g = geom;
    if (kind === 'cursor') {
      cursorF = clamp((p.x - g.L) / (g.W - g.L - g.R), 0, 0.999);
      drawScope(); return;
    }
    if (kind === 'peak') {
      // invert YI: current at the pointer
      const i = invY(g.YI, p.y);
      const r = clamp(Math.round(((i - st.iout) * 2 / st.iout) * 100), 5, 100);
      if (String(r) !== String(ctx.raw.ripple)) ctx.set('ripple', String(r));
    } else if (kind === 'iout') {
      const i = invY(g.YI, p.y);
      const v = clamp(Math.round(i * 20) / 20, 0.05, 100);
      if (fmtIn('iout', v) !== String(ctx.raw.iout)) ctx.set('iout', fmtIn('iout', v));
    } else if (kind === 'duty') {
      const t = clamp((p.x - g.L) / (g.W - g.L - g.R) * g.span, 0.02 * g.Tp, 0.98 * g.Tp);
      const vo = Math.round((t / g.Tp) * st.vinmax * st.eta * 20) / 20;
      if (fmtIn('vout', vo) !== String(ctx.raw.vout)) ctx.set('vout', fmtIn('vout', vo));
    } else if (kind === 'ton') {
      const t = clamp((p.x - g.L) / (g.W - g.L - g.R) * g.span, 0, g.Tp);
      const ns = Math.round(t * 1e9 / 5) * 5;
      if (String(ns) !== String(ctx.raw.tonmin)) ctx.set('tonmin', String(ns));
    } else if (kind === 'band') {
      const v = Math.abs(invY(g.YV, p.y)) * 2 * 1000;
      const mv = clamp(v < 10 ? Math.round(v * 2) / 2 : Math.round(v), 1, 1000);
      if (String(mv) !== String(ctx.raw.vripple)) ctx.set('vripple', String(mv));
    }
  }
  const invY = (f, y) => { const a = f(0), b = f(1); return (y - a) / (b - a); };
  scope.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('[data-drag]'); if (!t) return;
    e.preventDefault();
    const kind = t.dataset.drag;
    focusKey = t.dataset.key || 'h-cursor';
    const fe = scope.querySelector(`[data-key="${focusKey}"]`); fe?.focus({ preventScroll: true });
    drag = { kind: 'scope', what: kind };
    if (kind !== 'cursor' && geom) frozen = { vTop: geom.vTop, iTop: geom.iTop, iBot: geom.iBot, vSpan: geom.vSpan };
    scope.setPointerCapture(e.pointerId); scope.classList.add('dragging');
    if (kind === 'cursor') applyScope('cursor', pt(e));
  });
  scope.addEventListener('pointermove', (e) => { if (drag?.kind === 'scope') applyScope(drag.what, pt(e)); });
  const endScope = () => { if (drag?.kind === 'scope') { drag = null; scope.classList.remove('dragging'); if (frozen) { frozen = null; drawScope(); } } };
  scope.addEventListener('pointerup', endScope);
  scope.addEventListener('pointercancel', endScope);
  scope.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('[data-drag]'); if (!t || !st) return;
    if (t.dataset.key) focusKey = t.dataset.key;
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]; if (!dir) return;
    e.preventDefault();
    const big = e.shiftKey;
    switch (t.dataset.drag) {
      case 'peak': stepIn('ripple', dir, big); break;
      case 'iout': stepIn('iout', dir, big); break;
      case 'duty': stepIn('vout', dir, big); break;
      case 'ton': stepIn('tonmin', dir, big); break;
      case 'band': stepIn('vripple', dir, big); break;
      case 'cursor': cursorF = clamp(cursorF + dir * (big ? 0.05 : 0.0125), 0, 0.999); drawScope(); break;
      default: break;
    }
  });

  // ---------- side ----------
  function drawSide() {
    coutCard.replaceChildren();
    vinCard.replaceChildren();
    if (!st) return;
    const lim = st.limits;
    const rows = [['ripple', 'Output ripple'], ['release', 'Load release'], ['apply', 'Load apply'], ['loop', `Loop, fc ${eng(st.fc, 'Hz')}`]];
    const vals = rows.map(([k]) => lim[k]).filter((v) => v > 0);
    const lmax = Math.log10(Math.max(...vals)), lmin = Math.log10(Math.min(...vals)) - 0.4;
    coutCard.append(h('div', { class: 'bk-head' }, h('b', {}, 'Output capacitance'), h('span', {}, 'the largest limit sets it')),
      h('div', { class: 'bk-big' }, h('b', {}, `≥ ${eng(st.cOut, 'F')}`), h('span', {}, `effective, ESR ≤ ${eng(st.esrMax, 'Ω')}`)),
      h('div', { class: 'bk-bars' }, rows.map(([k, name]) => {
        const v = lim[k];
        const w = v > 0 ? clamp((Math.log10(v) - lmin) / (lmax - lmin), 0.02, 1) * 100 : 0;
        return h('div', { class: `bk-bar${k === st.cOutBy ? ' win' : ''}` }, h('span', {}, name),
          h('div', { class: 't' }, h('i', { style: `width:${w.toFixed(1)}%` })), h('b', {}, v > 0 ? eng(v, 'F') : '–'));
      })),
      h('div', { class: 'bk-foot' }, `Step ${eng(st.dI, 'A')} within ±${eng(st.dV, 'V', 3)}. Ceramics lose capacitance under DC bias: buy enough that the derated value clears this.`));
    const t0 = res.tables?.[0];
    const keep = t0 ? t0.columns.map((c, i) => (/^Cout/.test(c) ? -1 : i)).filter((i) => i >= 0) : [];
    const t = t0 && { columns: keep.map((i) => t0.columns[i]), rows: t0.rows.map((r) => keep.map((i) => r[i])) };
    if (t) {
      vinCard.append(h('div', { class: 'bk-head' }, h('b', {}, 'Across the input range'), h('span', {}, 'bold = drawn, dashed = ghost')),
        h('div', { style: 'overflow-x:auto;padding:0 2px' }, h('table', { class: 'bk-tab' },
          h('thead', {}, h('tr', {}, t.columns.map((c) => h('th', {}, c)))),
          h('tbody', {}, t.rows.map((r, i) => h('tr', { class: i === t.rows.length - 1 ? 'cur' : i === 0 && t.rows.length > 1 ? 'gh' : '' }, r.map((c) => h('td', {}, String(c)))))))));
    }
    warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    legend.replaceChildren(
      h('span', {}, h('i', { style: 'border-color:var(--tool-il)' }), `at ${eng(st.vinmax, 'V')} (worst ripple)`),
      st.perVin.length > 1 ? h('span', {}, h('i', { class: 'g' }), `at ${eng(st.vinmin, 'V')}`) : null,
      h('span', {}, h('i', { style: 'border-color:var(--danger);border-top-style:dashed' }), 'Isat'));
    scopeCard.querySelector('.sub').textContent = `two periods at ${eng(st.fsw, 'Hz')}`;
    notes.replaceChildren(h('summary', {}, `Assumptions and sources (${(res.notes || []).length + (ctx.manifest.sources || []).length})`),
      h('ul', {}, [...(res.notes || []), ...(ctx.manifest.sources || []).map((x) => `Source: ${x}`)].map((n) => h('li', {}, n))));
  }

  function drawAll() { drawSchematic(); drawScope(); drawSide(); }
  function showError() {
    sch.replaceChildren(); scope.replaceChildren();
    const sw = Math.max(300, scope.clientWidth || 800);
    scope.setAttribute('viewBox', `0 0 ${sw} 300`);
    scope.append(s('text', { x: sw / 2, y: 150, 'text-anchor': 'middle', class: 'soft sans' }, 'No waveform for these values: see the note on the right, fix the value on the stage.'));
    coutCard.replaceChildren(); vinCard.replaceChildren();
    warnBox.replaceChildren(...(res?.warnings || ['No result.']).map((w) => h('div', {}, w)));
    // keep the chips visible so the input can be fixed where it is
    const W = Math.max(300, sch.clientWidth || 900);
    sch.setAttribute('viewBox', `0 0 ${W} 40`); sch.setAttribute('height', 40);
    const g = s('g'); sch.append(g);
    let x = 8;
    for (const k of ['vinmin', 'vinmax', 'vout', 'iout', 'fsw', 'ripple', 'eff']) {
      if (x > W - 120) break;
      x += chip(g, x, 26, [[`${IN[k].label} `, 'soft'], [String(ctx.raw[k] ?? ''), 'v']], { key: k }) + 6;
    }
    restoreFocus();
  }

  ctx.onResult((r) => {
    res = r; st = r?.stage || null;
    if (!st) { showError(); return; }
    drawAll();
  });
  let rw = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth + 'x' + scope.clientHeight;
    if (w === rw) return; rw = w;
    if (st) { drawSchematic(); drawScope(); } else if (res) showError();
  }).observe(root);
  new ResizeObserver(() => { if (st) drawScope(); }).observe(scope);
}
