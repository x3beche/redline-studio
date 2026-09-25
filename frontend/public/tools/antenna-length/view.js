// Antenna Length: the page is the antenna, on the edge of its board.
//   Spectrum - a log dial from 1 MHz to 10 GHz with the common bands on it:
//              drag the needle, or click a band, to tune.
//   Antenna  - drawn to scale for the chosen type: the ground plane it needs,
//              the element with its current distribution, the keep-out, and
//              for a PCB trace the range it will resonate in (cut long, trim
//              down). Drag the tip: the frequency follows the length.
//   Wave     - the same element against one free-space wavelength, so the
//              quarter / half / 5/8 fraction and the shortening are visible.
// Every number drawn comes from run()'s result.antenna; the page only draws it.

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
const txt = (x, y, s, cls = '', anchor = 'start') => sv('text', { x, y, class: cls, 'text-anchor': anchor }, s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const C = 299792458;
const F_LO = 1e6, F_HI = 1e10;

const g3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(3))));
const g4 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(4))));
// length in mm, switching to m for long elements
const len = (mm, d = 4) => (mm >= 1000 ? `${Number((mm / 1000).toPrecision(d))} m` : `${Number(mm.toPrecision(d))} mm`);
// frequency as the input wants it: 433.9M, 2.44G
const fIn = (f) => {
  const [div, p] = f >= 1e9 ? [1e9, 'G'] : f >= 1e6 ? [1e6, 'M'] : f >= 1e3 ? [1e3, 'k'] : [1, ''];
  return `${Number((f / div).toPrecision(6))}${p}`;
};
const fTxt = (f) => {
  const [div, p] = f >= 1e9 ? [1e9, 'GHz'] : f >= 1e6 ? [1e6, 'MHz'] : f >= 1e3 ? [1e3, 'kHz'] : [1, 'Hz'];
  return `${Number((f / div).toPrecision(4))} ${p}`;
};

const SHORT = { 13.56e6: 'NFC 13.56', 27.12e6: '27 MHz', 144e6: '2 m', 315e6: '315', 433.92e6: '433', 868e6: '868', 915e6: '915', 1575.42e6: 'GPS L1', 2.44e9: '2.4 GHz', 5.5e9: '5 GHz' };
const TYPES = [
  ['quarter', 'λ/4 monopole', 'M8,20 H20 M14,20 V4'],
  ['half', 'λ/2 dipole', 'M2,12 H11 M13,12 H22 M12,12 V20'],
  ['fiveeighths', '5/8 λ monopole', 'M8,20 H20 M14,20 V16 M11,16 q3,-1.5 6,0 q-3,1.5 -6,0 M14,14 V2'],
  ['loop', 'Full-wave loop', 'M5,4 H19 V18 H14 M10,18 H5 Z M12,18 V22'],
];
const MEDIA = [['wire', 'Wire'], ['pcb', 'PCB trace'], ['custom', 'Custom VF']];
const LAMINATES = [['FR-4', '4.4'], ['RO4003', '3.55'], ['PTFE', '2.2']];

const CSS = `
.an { --tool-cu: #c98636; --tool-cu-edge: #9c6224; --tool-sub: #cfdcc4; --tool-sub-edge: #a9bb9c; --tool-gnd: #b9793a; --tool-cur: var(--tool-s2);
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px); gap: 10px; }
:root[data-theme="dark"] .an { --tool-cu: #c8873f; --tool-cu-edge: #e4aa66; --tool-sub: #1d2a22; --tool-sub-edge: #34463a; --tool-gnd: #8a5a2a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .an { --tool-cu: #c8873f; --tool-cu-edge: #e4aa66; --tool-sub: #1d2a22; --tool-sub-edge: #34463a; --tool-gnd: #8a5a2a; } }
.an-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.an-tools { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 7px 10px; }
.an-tools .grow { flex: 1; }
.an-types { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.an-type { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--surface); border-radius: 5px; padding: 3px 9px 3px 5px; cursor: pointer; font-size: 12px; color: var(--ink-soft); }
.an-type svg { width: 22px; height: 22px; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; }
.an-type[aria-pressed="true"] { border-color: var(--accent); color: var(--ink); box-shadow: inset 0 0 0 1px var(--accent); }
.an-type[aria-pressed="true"] svg { stroke: var(--accent); }
.an-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.an-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.an-seg button + button { border-left: 1px solid var(--line); }
.an-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.an-f { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.an-f input { width: 70px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.an-f input.bad { border-color: var(--danger); }
.an-f.freq input { width: 92px; font-weight: 600; }
.an-chip { border: 1px solid var(--line); background: transparent; border-radius: 10px; padding: 0 7px; font-size: 11px; cursor: pointer; color: var(--ink-soft); }
.an-chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.an-spec { grid-column: 1 / -1; }
.an-scene { grid-column: 1 / -1; }
.an-draw { position: relative; touch-action: none; user-select: none; -webkit-user-select: none; }
.an-draw svg { display: block; width: 100%; }
.an-cap { display: flex; align-items: baseline; gap: 6px 14px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--line-soft); }
.an-cap h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.an-cap .sub { color: var(--ink-soft); font-size: 11.5px; }
.an-cap .grow { flex: 1; }
.an-cap kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }
.an-low { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.an-notes { padding: 8px 12px; color: var(--ink-soft); font-size: 12px; }
.an-notes div + div { margin-top: 4px; }
.an-warns:empty { display: none; }
.an .k-out { max-height: 150px; }
@media (max-width: 900px) { .an { grid-template-columns: minmax(0, 1fr); } }
/* drawing */
.an svg text { font: 11px "IBM Plex Sans", -apple-system, sans-serif; fill: var(--ink); }
.an svg .m { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.an svg .b { font-weight: 600; } .an svg .sm { font-size: 10px; } .an svg .soft { fill: var(--ink-soft); } .an svg .big { font-size: 15px; }
.an svg .axis { stroke: var(--ink-soft); stroke-width: 1; }
.an svg .tick { stroke: var(--line); stroke-width: 1; }
.an svg .grid { stroke: var(--line-soft); stroke-width: 1; }
.an svg g.band { cursor: pointer; outline: none; }
.an svg g.band rect { fill: var(--sunken); stroke: var(--line); }
.an svg g.band:hover rect, .an svg g.band:focus-visible rect { stroke: var(--accent); }
.an svg g.band.on rect { fill: var(--accent); stroke: var(--accent); }
.an svg g.band.on text { fill: var(--accent-ink); }
.an svg g.band line { stroke: var(--line); }
.an svg g.needle { cursor: ew-resize; outline: none; }
.an svg g.needle .stem { stroke: var(--accent); stroke-width: 2; }
.an svg g.needle .tag { fill: var(--accent); } .an svg g.needle .tag-t { fill: var(--accent-ink); font-weight: 600; }
.an svg g.needle .knobc { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.an svg g.needle .ring, .an svg g.tip .ring { fill: none; stroke: none; }
.an svg g.needle:focus-visible .ring, .an svg g.tip:focus-visible .ring { stroke: var(--accent); stroke-width: 2; }
.an svg .air { fill: var(--sunken); }
.an svg .sub { fill: var(--tool-sub); stroke: var(--tool-sub-edge); stroke-width: 1; }
.an svg .gnd { fill: url(#an-gnd); stroke: var(--tool-cu-edge); stroke-width: 1; }
.an svg .gnd-h { stroke: var(--tool-gnd); stroke-width: 1.3; }
.an svg .cu { stroke: var(--tool-cu); stroke-linecap: round; fill: none; }
.an svg .cu-f { fill: var(--tool-cu); }
.an svg .ko { fill: var(--warn); fill-opacity: calc(var(--fill-alpha) * .55); stroke: var(--warn); stroke-width: 1.2; stroke-dasharray: 5 4; }
.an svg .trim { fill: var(--warn); fill-opacity: .9; }
.an svg .trim-e { stroke: var(--warn); stroke-width: 1.3; }
.an svg .cur { fill: var(--tool-cur); fill-opacity: .18; stroke: var(--tool-cur); stroke-width: 1.4; }
.an svg .cur-t { fill: var(--tool-cur); }
.an svg .dim { stroke: var(--ink); stroke-width: 1; fill: none; }
.an svg .ext { stroke: var(--ink-soft); stroke-width: .8; stroke-dasharray: 2 2; }
.an svg .arr { fill: var(--ink); }
.an svg .lbg { fill: var(--surface); fill-opacity: .9; }
.an svg .feed { fill: var(--surface); stroke: var(--ink); stroke-width: 1.3; }
.an svg .coax { stroke: var(--ink-soft); stroke-width: 3; fill: none; }
.an svg .ok-t { fill: var(--ok); } .an svg .warn-t { fill: var(--warn); } .an svg .danger-t { fill: var(--danger); }
.an svg g.tip { cursor: ew-resize; outline: none; }
.an svg g.tip .cap { fill: var(--surface); stroke: var(--accent); stroke-width: 2.2; }
.an svg g.tip:hover .cap { stroke-width: 3; }
.an svg .wave { stroke: var(--tool-cur); stroke-width: 1.4; fill: none; opacity: .7; }
.an svg .bar-free { fill: none; stroke: var(--ink-soft); stroke-dasharray: 3 3; }
.an svg .bar { fill: var(--tool-cu); }
.an svg .bar-low { fill: var(--warn); }
.an svg .scale { stroke: var(--ink); stroke-width: 2; }
`;

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const state = { drag: null, scene: null, spec: null, frozen: null };
  const A = () => ctx.result?.antenna;

  // ---------- toolbar ----------
  const types = h('div', { class: 'an-types', role: 'group', 'aria-label': 'Antenna type' });
  const media = h('div', { class: 'an-seg', role: 'group', 'aria-label': 'Made as' });
  const inp = (key, aria) => h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria, oninput: (e) => ctx.set(key, e.target.value) });
  const freqIn = inp('freq', 'Frequency in Hz, like 2.44G');
  const erIn = inp('er', 'Laminate relative permittivity');
  const vfIn = inp('vf', 'Velocity factor');
  const erChips = h('span', { class: 'an-f' });
  const erBox = h('span', { class: 'an-f' }, 'εr', erIn, erChips);
  const vfBox = h('label', { class: 'an-f' }, 'VF', vfIn);
  const tools = h('section', { class: 'an-panel an-tools', 'aria-label': 'Antenna' },
    types, media, erBox, vfBox, h('span', { class: 'grow' }), h('label', { class: 'an-f freq' }, 'Frequency', freqIn, 'Hz'));

  const spec = h('div', { class: 'an-draw' });
  const specPanel = h('section', { class: 'an-panel an-spec', 'aria-label': 'Spectrum' }, spec);
  const scene = h('div', { class: 'an-draw' });
  const wave = h('div', { class: 'an-draw' });
  const sceneCap = h('span', { class: 'sub' });
  const scenePanel = h('section', { class: 'an-panel an-scene', 'aria-label': 'The antenna, to scale' },
    h('div', { class: 'an-cap' }, h('h2', {}, 'The antenna, to scale'), sceneCap, h('span', { class: 'grow' }),
      h('span', { class: 'sub' }, 'drag the tip to tune by length · ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' on the tip or the needle, ', h('kbd', {}, 'PgUp'), ' ', h('kbd', {}, 'PgDn'), ' next band')),
    scene, wave);
  const warns = h('div', { class: 'k-warns an-warns', 'aria-live': 'polite' });
  const notes = h('div', { class: 'an-panel an-notes' });
  root.append(h('div', { class: 'an' }, tools, specPanel, scenePanel, h('div', { class: 'an-low' }, warns, notes), ctx.outputs));

  const redraw = (fn) => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    fn();
    if (fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };
  const setF = (f) => ctx.set('freq', fIn(clamp(f, 1e3, 1e11)));

  // ---------- spectrum dial ----------
  function drawSpec() {
    const a = A();
    spec.replaceChildren();
    const W = Math.max(300, spec.clientWidth || 900);
    const narrow = W < 640;
    const H = narrow ? 122 : 86, L = 16, R = 16, yA = narrow ? 76 : 46;
    const X = (f) => L + (Math.log10(clamp(f, F_LO, F_HI) / F_LO) / 4) * (W - L - R);
    state.spec = { W, L, R };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Radio spectrum, 1 MHz to 10 GHz' });
    // decades and minor ticks
    for (let d = 0; d <= 4; d++) {
      const f0 = F_LO * 10 ** d;
      svg.append(sv('line', { x1: X(f0), y1: yA - 8, x2: X(f0), y2: yA + 8, class: 'axis' }),
        txt(X(f0), yA + 21, f0 >= 1e9 ? `${f0 / 1e9} GHz` : `${f0 / 1e6} MHz`, 'm sm soft', d === 0 ? 'start' : d === 4 ? 'end' : 'middle'));
      if (d < 4) for (let k = 2; k < 10; k++) svg.append(sv('line', { x1: X(f0 * k), y1: yA - 3, x2: X(f0 * k), y2: yA + 3, class: 'tick' }));
    }
    svg.append(sv('line', { x1: L, y1: yA, x2: W - R, y2: yA, class: 'axis' }));
    // bands, in lanes above the axis
    const bands = a?.bands || [];
    const laneEnd = [];
    bands.forEach((b) => {
      const x = X(b.f);
      const t = SHORT[b.f] || fTxt(b.f);
      const w = t.length * 6.2 + 12;
      const bx = clamp(x - w / 2, 2, W - w - 2);
      // the lowest lane where this chip does not touch the one before it
      let lane = laneEnd.findIndex((end) => bx > end + 3);
      if (lane < 0) lane = laneEnd.length;
      laneEnd[lane] = bx + w;
      const y = yA - 16 - lane * 17;
      const on = a && Math.abs(a.freq / b.f - 1) < 0.002;
      const g = sv('g', { class: `band${on ? ' on' : ''}`, tabindex: 0, role: 'button', 'data-fk': `band${b.f}`, 'data-f': b.f,
        'aria-label': `${b.name}: ${b.lenLow ? `${len(b.lenLow, 3)} to ${len(b.len, 3)}` : len(b.len)}` });
      g.append(sv('line', { x1: x, y1: y + 3, x2: x, y2: yA }), sv('rect', { x: bx, y: y - 11, width: w, height: 15, rx: 7.5 }),
        txt(bx + w / 2, y + 0.5, t, 'sm', 'middle'), sv('title', {}, `${b.name}: ${b.lenLow ? `${len(b.lenLow, 3)}–${len(b.len, 3)}` : len(b.len)}`));
      svg.append(g);
    });
    // needle
    if (a) {
      const f = a.freq, x = X(f);
      const out = f < F_LO || f > F_HI;
      const tag = `${fTxt(f)}${out ? (f < F_LO ? ' ◂' : ' ▸') : ''}`;
      const tw = tag.length * 7 + 14;
      const tx = clamp(x, L + tw / 2, W - R - tw / 2);
      const g = sv('g', { class: 'needle', tabindex: 0, role: 'slider', 'data-fk': 'needle', 'data-drag': 'needle', 'aria-label': 'Frequency',
        'aria-valuenow': f, 'aria-valuetext': fTxt(f) });
      g.append(sv('rect', { x: x - 12, y: 0, width: 24, height: H, fill: 'transparent' }),
        sv('line', { x1: x, y1: yA - 4, x2: x, y2: H - 18, class: 'stem' }),
        sv('rect', { x: tx - tw / 2, y: H - 19, width: tw, height: 17, rx: 3, class: 'tag' }), txt(tx, H - 6.5, tag, 'm sm tag-t', 'middle'),
        sv('circle', { cx: x, cy: yA, r: 6.5, class: 'knobc' }), sv('circle', { cx: x, cy: yA, r: 10.5, class: 'ring' }));
      svg.append(g);
    }
    spec.append(svg);
  }

  // ---------- the antenna ----------
  function drawScene() {
    const a = A();
    scene.replaceChildren();
    if (!a) { scene.append(h('div', { class: 'an-notes' }, (ctx.result?.warnings || []).join(' '))); return; }
    const W = Math.max(300, scene.clientWidth || 900);
    const narrow = W < 640;
    const Hs = narrow ? 300 : clamp(window.innerHeight - 470, 270, 420);
    const Lm = a.len, ko = a.keepout;
    const pcb = a.medium === 'pcb';
    const mono = a.type === 'quarter' || a.type === 'fiveeighths';
    // extents in mm
    let x0, x1, yHalf;
    const G = a.ground || 0;
    const boardH = Math.max(G * 0.62, ko * 2.6);
    if (mono) { x0 = -G; x1 = Lm + ko; yHalf = Math.max(boardH / 2, ko * 1.3); }
    else if (a.type === 'half') { x0 = -(Lm / 2 + ko); x1 = Lm / 2 + ko; yHalf = ko * 1.6; }
    else { const s4 = Lm / 4; x0 = -(s4 / 2 + ko); x1 = s4 / 2 + ko; yHalf = s4 / 2 + ko; }
    const mx = narrow ? 30 : 150, my = narrow ? 120 : 130;
    let s = Math.min((W - mx) / (x1 - x0), (Hs - my) / (2 * yHalf));
    if (state.drag === 'tip' && state.frozen) s = state.frozen.s;
    const cxm = (x0 + x1) / 2;
    let ox = W / 2 - cxm * s;
    if (state.drag === 'tip' && state.frozen) ox = state.frozen.ox;
    const oy = Math.round(Hs / 2 + (narrow ? 14 : 4));
    const X = (mm) => ox + mm * s, Y = (mm) => oy + mm * s;
    state.scene = { s, ox, oy, type: a.type };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${Hs}`, role: 'group', 'aria-label': `${a.type} antenna, ${len(Lm)}` });
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'an-gnd', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('rect', { width: 7, height: 7, fill: 'var(--tool-cu)', opacity: 0.55 }), sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'gnd-h' }));
    const arrow = sv('marker', { id: 'an-a', viewBox: '0 0 8 8', refX: 7.5, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    arrow.append(sv('path', { d: 'M0,0.8 L8,4 L0,7.2 Z', class: 'arr' }));
    defs.append(pat, arrow);
    svg.append(defs, sv('rect', { x: 0, y: 0, width: W, height: Hs, class: 'air' }));
    const dim = (xa, xb, y, label, cls = 'm b', below = false) => {
      if (Math.abs(xb - xa) > 4) svg.append(sv('line', { x1: xa + 1, y1: y, x2: xb - 1, y2: y, class: 'dim', 'marker-start': 'url(#an-a)', 'marker-end': 'url(#an-a)' }));
      const w = label.length * (/\bbig\b/.test(cls) ? 9.1 : /\bsm\b/.test(cls) ? 6.1 : 6.8) + 10;
      const tx = clamp((xa + xb) / 2, w / 2 + 4, W - w / 2 - 4);
      const ty = below ? y + 15 : y - 6;
      const big = /\bbig\b/.test(cls);
      svg.append(sv('rect', { x: tx - w / 2, y: ty - (big ? 15 : 11), width: w, height: big ? 20 : 15, rx: 3, class: 'lbg' }), txt(tx, ty, label, cls, 'middle'));
    };
    const vext = (x, ya, yb) => svg.append(sv('line', { x1: x, y1: ya, x2: x, y2: yb, class: 'ext' }));
    const trace = Math.max(3, Math.min(7, 0.8 * s));
    const cutLabel = pcb ? `cut ${len(Lm)} · trim down` : `cut ${len(Lm)}`;
    let tip;

    if (mono) {
      // board: ground-plane copper, and for a trace the bare laminate the antenna runs on
      const bh = boardH / 2;
      if (pcb) svg.append(sv('rect', { x: X(-G), y: Y(-bh), width: (G + Lm + ko) * s, height: 2 * bh * s, class: 'sub' }));
      svg.append(sv('rect', { x: X(-G), y: Y(-bh), width: G * s, height: 2 * bh * s, class: 'gnd' }));
      // keep-out
      svg.append(sv('rect', { x: X(0), y: Y(-ko), width: (Lm + ko) * s, height: 2 * ko * s, class: 'ko' }));
      // current along the element
      const amp = Math.min(2 * ko * s * 0.9, 46);
      const pts = [];
      for (let i = 0; i <= 60; i++) { const u = i / 60; pts.push([X(u * Lm), Y(0) - amp * Math.abs(Math.sin(2 * Math.PI * a.frac * (1 - u)))]); }
      const peak = Math.max(...pts.map((p) => Y(0) - p[1])) || 1;
      svg.append(sv('path', { d: `M${X(0)},${Y(0)} ${pts.map(([x, y]) => `L${x},${Y(0) - ((Y(0) - y) / peak) * amp}`).join(' ')} L${X(Lm)},${Y(0)} Z`, class: 'cur' }));
      // element
      if (a.type === 'fiveeighths') {
        const cl = Math.min(ko * 0.7, Lm * 0.08) * s;
        svg.append(sv('path', { d: `M${X(0)},${Y(0)} ${Array.from({ length: 5 }, (_, i) => `q${cl / 10},${-9} ${cl / 5},0`).join(' ')}`, class: 'cu', 'stroke-width': 2 }));
        svg.append(sv('line', { x1: X(0) + cl, y1: Y(0), x2: X(Lm), y2: Y(0), class: 'cu', 'stroke-width': trace }));
      } else {
        svg.append(sv('line', { x1: X(0), y1: Y(0), x2: X(Lm), y2: Y(0), class: 'cu', 'stroke-width': trace }));
      }
      if (pcb && a.lenLow) {
        svg.append(sv('rect', { x: X(a.lenLow), y: Y(0) - trace / 2 - 1, width: (Lm - a.lenLow) * s, height: trace + 2, class: 'trim' }));
        for (const xm of [a.lenLow, Lm]) svg.append(sv('line', { x1: X(xm), y1: Y(0) - trace - 4, x2: X(xm), y2: Y(0) + trace + 4, class: 'trim-e' }));
      }
      // feed
      svg.append(sv('circle', { cx: X(0), cy: Y(0), r: 5, class: 'feed' }));
      if (!pcb) svg.append(sv('rect', { x: X(0) - 6, y: Y(0) - 9, width: 8, height: 18, rx: 1.5, class: 'feed' }));
      // dimensions
      const yTop = Y(-Math.max(ko, bh)) - 16;
      vext(X(0), Y(0) - 8, yTop - 4); vext(X(Lm), Y(0) - 8, yTop - 4);
      dim(X(0), X(Lm), yTop, cutLabel, 'm b big ok-t');
      if (pcb && a.lenLow) {
        const yb = Y(Math.max(ko, bh)) + 18;
        vext(X(a.lenLow), Y(0) + 8, yb + 4);
        vext(X(Lm), Y(0) + 8, yb + 4);
        dim(X(a.lenLow), X(Lm), yb, `resonates ${g3(a.lenLow)}–${g3(Lm)} mm`, 'm sm b warn-t', true);
      }
      if (!narrow) {
        vext(X(-G), Y(-bh), yTop - 4);
        dim(X(-G), X(0), yTop, `ground ≥ ${len(G, 3)} (λ/4)`, 'm sm b');
      } else {
        const yg = Y(Math.max(ko, bh)) + (pcb && a.lenLow ? 46 : 18);
        vext(X(-G), Y(bh), yg + 4); vext(X(0), Y(bh), yg + 4);
        dim(X(-G), X(0), yg, `ground ≥ ${len(G, 3)}`, 'm sm b', true);
      }
      svg.append(txt(X(-G / 2), Y(0) + 4, 'ground plane', 'sm b', 'middle'));
      // keep-out at the tip
      const yk = Y(-ko) - 1;
      if (ko * s > 26) dim(X(Lm), X(Lm + ko), Y(ko * 0.55), `≥ ${g3(ko)}`, 'm sm', true);
      svg.append(txt(X(Lm + ko) - 4, yk - 4, 'keep-out λ/20', 'sm warn-t', 'end'));
      svg.append(txt(X(Lm * 0.5), Y(0) - Math.min(2 * ko * s * 0.9, 46) - 5, 'current', 'sm cur-t', 'middle'));
      tip = [X(Lm), Y(0)];
    } else if (a.type === 'half') {
      const Lh = Lm / 2;
      if (pcb) svg.append(sv('rect', { x: X(-Lh - ko), y: Y(-ko * 1.5), width: (Lm + 2 * ko) * s, height: 3 * ko * s, class: 'sub' }));
      svg.append(sv('rect', { x: X(-Lh - ko), y: Y(-ko), width: (Lm + 2 * ko) * s, height: 2 * ko * s, class: 'ko' }));
      const amp = Math.min(2 * ko * s * 0.9, 46);
      const pts = [];
      for (let i = 0; i <= 80; i++) { const u = -1 + (2 * i) / 80; pts.push(`L${X(u * Lh)},${Y(0) - amp * Math.cos((Math.PI / 2) * Math.abs(u))}`); }
      svg.append(sv('path', { d: `M${X(-Lh)},${Y(0)} ${pts.join(' ')} L${X(Lh)},${Y(0)} Z`, class: 'cur' }));
      const gap = 3;
      svg.append(sv('line', { x1: X(-Lh), y1: Y(0), x2: X(0) - gap, y2: Y(0), class: 'cu', 'stroke-width': trace }),
        sv('line', { x1: X(0) + gap, y1: Y(0), x2: X(Lh), y2: Y(0), class: 'cu', 'stroke-width': trace }));
      if (pcb && a.lenLow) {
        const ll = a.lenLow / 2;
        for (const sg of [-1, 1]) {
          const xa = X(sg * ll), xb = X(sg * Lh);
          svg.append(sv('rect', { x: Math.min(xa, xb), y: Y(0) - trace / 2 - 1, width: Math.abs(xb - xa), height: trace + 2, class: 'trim' }));
        }
      }
      svg.append(sv('path', { d: `M${X(0)},${Y(0) + 4} V${Hs - 8}`, class: 'coax' }), sv('circle', { cx: X(0), cy: Y(0), r: 5, class: 'feed' }));
      const yTop = Y(-ko * 1.6) - 14;
      vext(X(-Lh), Y(0) - 8, yTop - 4); vext(X(Lh), Y(0) - 8, yTop - 4);
      dim(X(-Lh), X(Lh), yTop, `cut ${len(Lm)} tip to tip${pcb ? ' · trim down' : ''}`, 'm b big ok-t');
      if (pcb && a.lenLow) dim(X(-a.lenLow / 2), X(a.lenLow / 2), Y(ko * 1.6) + 16, `resonates ${g3(a.lenLow)}–${g3(Lm)} mm`, 'm sm b warn-t', true);
      svg.append(txt(X(Lh + ko) - 4, Y(-ko) - 5, 'keep-out λ/20', 'sm warn-t', 'end'));
      svg.append(txt(X(0) + 8, Hs - 12, 'feed (balanced: use a balun)', 'sm soft'));
      tip = [X(Lh), Y(0)];
    } else {
      // full-wave loop: a square of the perimeter, feed gap at the bottom
      const s4 = Lm / 4, hs = s4 / 2;
      if (pcb) svg.append(sv('rect', { x: X(-hs - ko), y: Y(-hs - ko), width: (s4 + 2 * ko) * s, height: (s4 + 2 * ko) * s, class: 'sub' }));
      svg.append(sv('path', { d: `M${X(-hs - ko)},${Y(-hs - ko)} h${(s4 + 2 * ko) * s} v${(s4 + 2 * ko) * s} h${-(s4 + 2 * ko) * s} Z M${X(-hs + ko)},${Y(-hs + ko)} v${Math.max(0, s4 - 2 * ko) * s} h${Math.max(0, s4 - 2 * ko) * s} v${-Math.max(0, s4 - 2 * ko) * s} Z`, class: 'ko', 'fill-rule': 'evenodd' }));
      const gap = 4;
      svg.append(sv('path', { d: `M${X(0) - gap},${Y(hs)} H${X(-hs)} V${Y(-hs)} H${X(hs)} V${Y(hs)} H${X(0) + gap}`, class: 'cu', 'stroke-width': trace, 'stroke-linejoin': 'round' }));
      svg.append(sv('path', { d: `M${X(0)},${Y(hs) + 4} V${Hs - 6}`, class: 'coax' }), sv('circle', { cx: X(0), cy: Y(hs), r: 5, class: 'feed' }));
      const yTop = Y(-hs - ko) - 14;
      const pl = `perimeter ${len(Lm)} (4 sides)${pcb ? ' · trim down' : ''}`;
      svg.append(sv('rect', { x: X(0) - pl.length * 4.6, y: yTop - 17, width: pl.length * 9.2, height: 21, rx: 3, class: 'lbg' }), txt(X(0), yTop, pl, 'm b big ok-t', 'middle'));
      if (pcb && a.lenLow) svg.append(txt(X(hs + ko) + 8, Y(0), `resonates at ${g3(a.lenLow)}–${g3(Lm)} mm perimeter`, 'm sm b warn-t'));
      svg.append(txt(X(hs + ko) - 4, Y(hs + ko) + 14, 'keep-out λ/20', 'sm warn-t', 'end'));
      tip = [X(hs), Y(0)];
    }
    // tip handle
    const tg = sv('g', { class: 'tip', tabindex: 0, role: 'slider', 'data-fk': 'tip', 'data-drag': 'tip', 'aria-label': 'Antenna length: drag to tune by length',
      'aria-valuetext': `${len(Lm)}, ${fTxt(a.freq)}` });
    tg.append(sv('circle', { cx: tip[0], cy: tip[1], r: 18, fill: 'transparent' }), sv('circle', { cx: tip[0], cy: tip[1], r: 7, class: 'cap' }), sv('circle', { cx: tip[0], cy: tip[1], r: 11.5, class: 'ring' }));
    svg.append(tg);
    // scale bar
    const want = 90 / s, p = 10 ** Math.floor(Math.log10(want)), m = want / p;
    const sb = (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
    svg.append(sv('line', { x1: 14, y1: Hs - 14, x2: 14 + sb * s, y2: Hs - 14, class: 'scale' }), txt(14, Hs - 21, len(sb, 3), 'm sm soft'));
    svg.append(txt(W - 12, Hs - 10, `${a.medium === 'pcb' ? 'PCB trace, no copper under it' : a.medium === 'custom' ? `velocity factor ${g3(a.vf)}` : 'wire in air'} · to scale`, 'sm soft', 'end'));
    scene.append(svg);
  }

  // ---------- the element against one wavelength ----------
  function drawWave() {
    const a = A();
    wave.replaceChildren();
    if (!a) return;
    const W = Math.max(300, wave.clientWidth || 900);
    const two = W < 700;
    const H = two ? 90 : 78, L = 16, R = 16;
    const X = (mm) => L + (mm / a.lambda) * (W - L - R);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Element against one wavelength, ${len(a.lambda)}` });
    const yb = two ? 48 : 36;
    const pts = [];
    for (let i = 0; i <= 120; i++) { const u = i / 120; pts.push(`${i ? 'L' : 'M'}${X(u * a.lambda)},${yb - 13 * Math.sin(2 * Math.PI * u)}`); }
    svg.append(sv('path', { d: pts.join(' '), class: 'wave' }));
    svg.append(sv('line', { x1: L, y1: yb, x2: W - R, y2: yb, class: 'axis' }));
    for (const [f, t] of [[0.25, 'λ/4'], [0.5, 'λ/2'], [0.625, '5/8 λ'], [1, 'λ']]) {
      const x = X(f * a.lambda);
      svg.append(sv('line', { x1: x, y1: yb - 5, x2: x, y2: yb + 5, class: 'axis' }), txt(x, yb + 17, t, `sm ${Math.abs(f - a.frac) < 1e-9 ? 'b' : 'soft'}`, f === 1 ? 'end' : 'middle'));
    }
    svg.append(sv('rect', { x: L, y: yb + 26, width: X(a.lenFree) - L, height: 8, class: 'bar-free' }),
      sv('rect', { x: L, y: yb + 26, width: X(a.len) - L, height: 8, class: 'bar' }));
    if (a.lenLow) svg.append(sv('rect', { x: X(a.lenLow), y: yb + 26, width: X(a.len) - X(a.lenLow), height: 8, class: 'bar-low', opacity: 0.8 }));
    const t1 = `λ0 ${len(a.lambda)} · element ${len(a.len)} = ${g3(a.frac)} λ0 × VF ${g3(a.vf)}${a.lenLow ? ` (down to ${g3(a.vfLow)})` : ''}`;
    const t2 = `unshortened ${len(a.lenFree)} (dashed)`;
    if (two) svg.append(txt(L, 12, t1, 'm sm soft'), txt(L, 25, t2, 'm sm soft'));
    else svg.append(txt(L, 12, `${t1} · ${t2}`, 'm sm soft'));
    wave.append(svg);
  }

  // ---------- pointer and keys ----------
  const local = (el, e) => {
    const rect = el.getBoundingClientRect();
    const vb = el.querySelector('svg')?.viewBox.baseVal;
    const k = vb ? vb.width / rect.width : 1;
    return [(e.clientX - rect.left) * k, (e.clientY - rect.top) * k];
  };
  const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* ended */ } };
  const fFromSpec = (e) => {
    const q = state.spec; if (!q) return null;
    const [x] = local(spec, e);
    const f = F_LO * 10 ** (4 * clamp((x - q.L) / (q.W - q.L - q.R), 0, 1));
    const band = (A()?.bands || []).find((b) => Math.abs(Math.log(b.f / f)) < 0.012);
    return band ? band.f : Number(f.toPrecision(3));
  };
  spec.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-f]');
    if (b) { e.preventDefault(); setF(Number(b.getAttribute('data-f'))); return; }
    e.preventDefault();
    capture(spec, e);
    state.drag = 'needle';
    spec.querySelector('[data-fk="needle"]')?.focus({ preventScroll: true });
    const f = fFromSpec(e); if (f) setF(f);
  });
  spec.addEventListener('pointermove', (e) => {
    if (state.drag !== 'needle') return;
    const f = fFromSpec(e); if (f && Math.abs(f / A().freq - 1) > 1e-4) setF(f);
  });
  scene.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-drag="tip"]')) return;
    e.preventDefault();
    capture(scene, e);
    state.drag = 'tip';
    state.frozen = { s: state.scene.s, ox: state.scene.ox };
    e.target.closest('[data-drag="tip"]').focus({ preventScroll: true });
  });
  scene.addEventListener('pointermove', (e) => {
    if (state.drag !== 'tip' || !state.scene) return;
    const a = A(); if (!a) return;
    const [x] = local(scene, e);
    const q = state.scene;
    const u = (x - q.ox) / q.s;                     // mm from the feed / centre
    const L = q.type === 'half' ? 2 * u : q.type === 'loop' ? 8 * u : u;
    if (!(L > 0.5)) return;
    // the length to cut -> the frequency that gives it (L = frac · c/f · VF)
    const f = Number(((a.frac * C * a.vf * 1000) / L).toPrecision(4));
    if (Math.abs(f / a.freq - 1) > 1e-4) setF(f);
  });
  const endDrag = () => { if (state.drag) { state.drag = null; state.frozen = null; redraw(drawAll); } };
  for (const el of [spec, scene]) { el.addEventListener('pointerup', endDrag); el.addEventListener('pointercancel', endDrag); }
  const bandStep = (dir) => {
    const a = A(); if (!a) return;
    const bs = a.bands.map((b) => b.f);
    const next = dir > 0 ? bs.find((f) => f > a.freq * 1.001) : [...bs].reverse().find((f) => f < a.freq * 0.999);
    if (next) setF(next);
  };
  root.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('[data-fk]'); const a = A();
    if (!t || !a) return;
    const k = t.getAttribute('data-fk');
    if (k.startsWith('band') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setF(Number(t.getAttribute('data-f'))); return; }
    if (k !== 'needle' && k !== 'tip') return;
    if (e.key === 'PageUp') { e.preventDefault(); bandStep(1); return; }
    if (e.key === 'PageDown') { e.preventDefault(); bandStep(-1); return; }
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : 0.01;
    // on the tip, right makes the antenna longer: the frequency goes down
    const d = k === 'tip' ? -dir : dir;
    setF(Number((a.freq * (1 + d * step)).toPrecision(4)));
  });

  // ---------- result -> page ----------
  const sync = (el, v) => { if (document.activeElement !== el) el.value = v ?? ''; };
  function renderBar() {
    const raw = ctx.raw;
    types.replaceChildren(...TYPES.map(([v, t, d]) => {
      const ic = sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }); ic.append(sv('path', { d }));
      return h('button', { type: 'button', class: 'an-type', 'aria-pressed': String(raw.type === v), onclick: () => ctx.set('type', v) }, ic, t);
    }));
    media.replaceChildren(...MEDIA.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(raw.medium === v), onclick: () => ctx.set('medium', v) }, t)));
    erChips.replaceChildren(...LAMINATES.map(([n, v]) => h('button', { type: 'button', class: 'an-chip', 'aria-pressed': String(String(raw.er) === v), title: `εr ${v}`, onclick: () => ctx.set('er', v) }, n)));
    erBox.hidden = raw.medium !== 'pcb';
    vfBox.hidden = raw.medium !== 'custom';
    sync(freqIn, raw.freq); sync(erIn, raw.er); sync(vfIn, raw.vf);
    freqIn.classList.toggle('bad', ctx.parseEng(raw.freq) == null);
    erIn.classList.toggle('bad', String(raw.er ?? '').trim() !== '' && ctx.parseEng(raw.er) == null);
    const res = ctx.result || {};
    const a = res.antenna;
    sceneCap.textContent = a ? `${fTxt(a.freq)} · λ0 ${len(a.lambda)} · keep-out ≥ ${g3(a.keepout)} mm${a.ground ? ` · ground ≥ ${g3(a.ground)} mm` : ''}` : '';
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((n) => h('div', {}, n)));
  }
  const drawAll = () => { drawSpec(); drawScene(); drawWave(); };
  ctx.onResult(() => { renderBar(); redraw(drawAll); });
  let raf = 0, lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => redraw(drawAll));
  }).observe(root);
}
