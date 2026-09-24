// Gear Calculator page: the pair itself, drawn from run()'s geometry with true
// involute teeth. Drag a rim knob to change a tooth count, drag the centre
// distance to get the profile shift it needs, turn the gears by hand or let
// them run. Every number shown comes from result.geometry.

const NS = 'http://www.w3.org/2000/svg';
const MODULES = [0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const DPS = [64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2];
const ALPHAS = [['14.5', '14.5°'], ['20', '20°'], ['25', '25°']];
const DEG = Math.PI / 180;
const inv = (a) => Math.tan(a) - a;

const CSS = `
:root { --tool-g1: #1f4ed8; --tool-g2: #0f8a78; --tool-loa: #c26a00; --tool-dim: #5b6b7a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-g1: #7d9bff; --tool-g2: #3cc7b3; --tool-loa: #f0a33a; --tool-dim: #8ea0b0; } }
:root[data-theme="dark"] { --tool-g1: #7d9bff; --tool-g2: #3cc7b3; --tool-loa: #f0a33a; --tool-dim: #8ea0b0; }
.k-page { padding: 12px; }
.gc { display: grid; grid-template-columns: minmax(0, 1fr) 372px; gap: 12px; align-items: start; }
@media (max-width: 980px) { .gc { grid-template-columns: minmax(0, 1fr); } }
.gc-stage { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.gc-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.gc-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.gc-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.gc-seg button + button { border-left: 1px solid var(--line); }
.gc-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.gc-fld { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.gc-fld input { width: 58px; padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.gc-fld input.bad { border-color: var(--danger); }
.gc-play { margin-left: auto; display: inline-flex; gap: 6px; }
.gc-btn { padding: 3px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 12px; }
.gc-btn:hover { border-color: var(--ink-soft); }
.gc-btn.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.gc-work { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px; }
.gc-ladder { display: flex; flex-direction: column; gap: 1px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px;
  padding: 4px 3px; align-self: start; }
.gc-ladder .lh { font-size: 10.5px; color: var(--ink-soft); text-align: center; padding: 0 0 3px; border-bottom: 1px solid var(--line-soft); margin-bottom: 2px; }
.gc-ladder button { border: 0; background: transparent; cursor: pointer; font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft);
  padding: 2px 4px; border-radius: 3px; text-align: right; position: relative; }
.gc-ladder button:hover { background: var(--sunken); color: var(--ink); }
.gc-ladder button[aria-checked="true"] { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
.gc-ladder input { width: 100%; margin-top: 3px; padding: 2px 3px; border: 1px solid var(--line); border-radius: 3px; background: var(--sunken);
  font: 12px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.gc-canvas { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0;
  height: clamp(340px, calc(100vh - 118px), 900px); overflow: hidden; }
.gc-canvas svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.gc-hint { position: absolute; left: 10px; top: 7px; font-size: 11px; color: var(--ink-soft); pointer-events: none; max-width: calc(100% - 20px); }
.gc-legend { position: absolute; left: 10px; bottom: 6px; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--ink-soft); pointer-events: none; }
.gc-legend svg { width: 22px; height: 8px; vertical-align: middle; margin-right: 4px; }
@media (max-width: 640px) {
  .gc-work { grid-template-columns: minmax(0, 1fr); }
  .gc-ladder { flex-direction: row; flex-wrap: wrap; align-items: center; }
  .gc-ladder .lh { border: 0; margin: 0; padding: 0 4px 0 2px; }
  .gc-ladder input { width: 56px; margin: 0 0 0 4px; }
  .gc-canvas { height: 340px; }
  .gc-legend { display: none; }
}
.gc-side { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.gc-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.gc-card h2 { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--ink-soft); padding: 6px 10px 4px; display: flex; align-items: center; gap: 8px; }
.gc-card h2 b { margin-left: auto; font: 500 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.gc-detail { height: 206px; border-top: 1px solid var(--line-soft); }
.gc-detail svg { display: block; width: 100%; height: 100%; touch-action: none; }
.gc-tab { width: 100%; border-collapse: collapse; font-size: 12px; }
.gc-tab th { font-weight: 500; color: var(--ink-soft); text-align: right; padding: 3px 8px; border-bottom: 1px solid var(--line); }
.gc-tab th:first-child { text-align: left; }
.gc-tab td { padding: 2px 8px; border-bottom: 1px solid var(--line-soft); text-align: right; font-family: "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; }
.gc-tab td:first-child { text-align: left; font-family: inherit; color: var(--ink-soft); white-space: normal; }
.gc-tab td:first-child i { font-family: "IBM Plex Mono", ui-monospace, monospace; font-style: normal; color: var(--ink); }
.gc-tab tr.sep td { border-bottom-color: var(--line); }
.gc-tab input { width: 76px; padding: 1px 4px; border: 1px solid var(--line); border-radius: 3px; background: var(--sunken);
  font: 12px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.gc-tab input.lock { border-style: dashed; }
.gc-tab .g1 { color: var(--tool-g1); } .gc-tab .g2 { color: var(--tool-g2); }
.gc-tab .bad { color: var(--danger); font-weight: 600; } .gc-tab .ok { color: var(--ok); } .gc-tab .warn { color: var(--warn); }
.gc-tab button { border: 1px solid var(--line); background: var(--surface); border-radius: 3px; font-size: 11px; padding: 0 5px; cursor: pointer; margin-left: 4px; }
.gc-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.gc-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.gc-msgs div.note { border-left-color: var(--accent); color: var(--ink-soft); }
.gc-msgs:empty { display: none; }
.gc svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.gc .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.gc .knob { cursor: grab; outline: none; }
.gc .knob:focus-visible .kc { stroke: var(--accent); stroke-width: 3px; }
.gc .knob:focus-visible .kf { stroke: var(--accent); stroke-width: 2px; stroke-dasharray: 3 2; fill: none; }
.gc .track { opacity: 0; transition: opacity .12s; }
.gc .knob:hover ~ .track, .gc .knob:focus-visible ~ .track, .gc .dragging .track { opacity: 1; }
.gc .body { cursor: grab; }
.gc .dragging, .gc .dragging * { cursor: grabbing !important; }
.gc-canvas:focus-within { border-color: var(--line); }
`;

const el = (tag, attrs = {}, ...kids) => {
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
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '–');
const fx = (v, n = 4) => (Number.isFinite(v) ? String(Math.round(v * 10 ** n) / 10 ** n) : '–');
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** One gear's outline in mm about its centre, teeth centred at 2 pi k / z. */
function gearOutline(G, alphaT) {
  const { z, df, db, da, st, d } = G;
  const rf = df / 2, rb = db / 2, ra = da / 2;
  const half = (r) => st / d + inv(alphaT) - (r > rb ? inv(Math.acos(rb / r)) : 0);
  const pitch = (2 * Math.PI) / z;
  const r0 = Math.max(rb, rf);
  // flank samples from the lower start up to the tip (or to where the flanks meet)
  const flank = [];
  if (rf < rb) flank.push([rf, half(rb)]);
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const r = r0 + ((ra - r0) * (1 - Math.cos((i / N) * Math.PI / 2)) ** 0.9);
    let t = half(r);
    if (t <= 0) { flank.push([r, 0]); break; }
    flank.push([r, Math.min(t, pitch / 2)]);
  }
  const tipT = flank[flank.length - 1][1];
  const rootT = Math.min(flank[0][1], pitch / 2);
  const pts = [];
  const P = (r, a) => pts.push(`${(r * Math.cos(a)).toFixed(4)},${(r * Math.sin(a)).toFixed(4)}`);
  for (let k = 0; k < z; k++) {
    const c = k * pitch;
    for (const [r, t] of flank) P(r, c - t);
    const tipN = Math.max(1, Math.ceil((2 * tipT) / 0.06));
    for (let i = 1; i < tipN; i++) P(flank[flank.length - 1][0], c - tipT + (2 * tipT * i) / tipN);
    for (let i = flank.length - 1; i >= 0; i--) P(flank[i][0], c + flank[i][1]);
    const gap = pitch - 2 * rootT;
    const rootN = Math.max(1, Math.ceil(gap / 0.06));
    for (let i = 1; i < rootN; i++) P(rf, c + rootT + (gap * i) / rootN);
  }
  // undercut marks: the flank foot below the base circle, on every tooth
  let notch = '';
  if (G.undercut) {
    const lo = rf, hi = Math.max(rb, rf + 0.35 * (da - df) / 2);
    const t = flank[0][1];
    const dt = (0.28 * (hi - lo)) / rb;
    for (let k = 0; k < z; k++) {
      const c = k * pitch;
      for (const sgn of [-1, 1]) {
        const a1 = c + sgn * t, a2 = c + sgn * (t - dt);
        const m = (lo + hi) / 2;
        notch += `M${(hi * Math.cos(a1)).toFixed(4)},${(hi * Math.sin(a1)).toFixed(4)}L${(m * Math.cos(a2)).toFixed(4)},${(m * Math.sin(a2)).toFixed(4)}L${(lo * Math.cos(a1)).toFixed(4)},${(lo * Math.sin(a1)).toFixed(4)}Z`;
      }
    }
  }
  return { d: `M${pts.join('L')}Z`, notch };
}

export function page(root, ctx) {
  document.head.append(el('style', { text: CSS }));
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let playing = !(reduced && reduced.matches);
  let theta = 0; // pinion rotation, rad (math sense)
  let geo = null, res = null, outlines = null, frozen = null, drag = null, lastT = 0;

  // ---------- toolbar ----------
  const segSystem = el('div', { class: 'gc-seg', role: 'group', 'aria-label': 'Size by' });
  const segAlpha = el('div', { class: 'gc-seg', role: 'group', 'aria-label': 'Pressure angle' });
  const betaIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Helix angle in degrees' });
  const rpmIn = el('input', { inputmode: 'decimal', spellcheck: 'false', placeholder: '–', 'aria-label': 'Pinion speed in rpm' });
  const playBtn = el('button', { class: 'gc-btn', onclick: () => setPlaying(!playing) });
  const bar = el('div', { class: 'gc-bar' },
    segSystem,
    el('span', { class: 'gc-fld' }, 'α', segAlpha),
    el('label', { class: 'gc-fld' }, 'β', betaIn, '°'),
    el('label', { class: 'gc-fld' }, 'n1', rpmIn, 'rpm'),
    el('span', { class: 'gc-play' }, playBtn));
  betaIn.addEventListener('change', () => ctx.set('beta', betaIn.value.trim() || '0'));
  rpmIn.addEventListener('change', () => ctx.set('rpm', rpmIn.value.trim()));

  // ---------- module / DP ladder ----------
  const ladder = el('div', { class: 'gc-ladder', role: 'radiogroup' });
  const ladderIn = el('input', { inputmode: 'decimal', spellcheck: 'false' });
  ladderIn.addEventListener('change', () => { const k = ctx.raw.system === 'dp' ? 'dp' : 'm'; ctx.set(k, ladderIn.value.trim()); });

  // ---------- canvas ----------
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Gear pair in mesh');
  const hint = el('div', { class: 'gc-hint' });
  const legend = el('div', { class: 'gc-legend' },
    ...[['pitch Ø d', 'var(--ink-soft)', '6 2 1 2'], ['base Ø db', 'var(--ink-soft)', '1 2'], ['line of action', 'var(--tool-loa)', ''], ['contact zone', 'var(--tool-loa)', '', 4]]
      .map(([t, c, da, w]) => el('span', {}, (() => {
        const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 22 8');
        s.innerHTML = `<line x1="1" y1="4" x2="21" y2="4" stroke="${c}" stroke-width="${w || 1.2}" stroke-dasharray="${da}"/>`; return s;
      })(), t)));
  const canvas = el('div', { class: 'gc-canvas' }, svg, hint, legend);
  const work = el('div', { class: 'gc-work' }, ladder, canvas);
  const stage = el('section', { class: 'gc-stage' }, bar, work);

  // ---------- side ----------
  const dsvg = document.createElementNS(NS, 'svg');
  dsvg.setAttribute('role', 'img');
  const detailZoom = el('b');
  const detail = el('div', { class: 'gc-card' }, el('h2', {}, 'Mesh, line of action', detailZoom), el('div', { class: 'gc-detail' }, dsvg));
  const table = el('table', { class: 'gc-tab' });
  const tableCard = el('div', { class: 'gc-card' }, table);
  const msgs = el('div', { class: 'gc-msgs', 'aria-live': 'polite' });
  const side = el('aside', { class: 'gc-side' }, detail, tableCard, msgs, ctx.outputs);
  root.append(el('div', { class: 'gc' }, stage, side));

  function setPlaying(p) {
    playing = p;
    playBtn.textContent = p ? 'Pause' : 'Play';
    playBtn.classList.toggle('on', p);
    playBtn.setAttribute('aria-pressed', String(p));
    if (p) { lastT = 0; requestAnimationFrame(tick); }
  }
  reduced?.addEventListener?.('change', (e) => { if (e.matches) setPlaying(false); });

  function tick(t) {
    if (!playing) return;
    if (lastT && geo && !drag) {
      const dt = Math.min(0.1, (t - lastT) / 1000);
      theta += (dt * 1.2 * 2 * Math.PI) / geo.gears[0].z; // 1.2 teeth a second
      frame();
    }
    lastT = t;
    requestAnimationFrame(tick);
  }

  // ---------- controls from the input ----------
  function syncControls() {
    const raw = ctx.raw;
    const sys = raw.system === 'dp' ? 'dp' : 'module';
    segSystem.replaceChildren(...[['module', 'Module'], ['dp', 'DP']].map(([v, t]) =>
      el('button', { 'aria-pressed': String(sys === v), onclick: () => ctx.set('system', v) }, t)));
    segAlpha.replaceChildren(...ALPHAS.map(([v, t]) =>
      el('button', { 'aria-pressed': String(String(raw.alpha) === v), onclick: () => ctx.set('alpha', v) }, t)));
    if (document.activeElement !== betaIn) betaIn.value = raw.beta ?? '';
    if (document.activeElement !== rpmIn) rpmIn.value = raw.rpm ?? '';
    const key = sys === 'dp' ? 'dp' : 'm';
    const list = sys === 'dp' ? DPS : MODULES;
    const cur = num(raw[key]);
    const rungs = list.map((v) => el('button', { role: 'radio', 'aria-checked': String(cur === v), tabindex: cur === v ? '0' : '-1',
      title: sys === 'dp' ? `${v} DP (module ${(25.4 / v).toFixed(4)} mm)` : `module ${v} mm`,
      onclick: () => ctx.set(key, String(v)),
      onkeydown: (e) => {
        const i = list.indexOf(v);
        const j = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? i - 1 : -9;
        if (j === -9) return;
        e.preventDefault();
        const nv = list[Math.max(0, Math.min(list.length - 1, j))];
        ctx.set(key, String(nv));
        requestAnimationFrame(() => ladder.querySelector('[aria-checked="true"]')?.focus());
      } }, String(v)));
    if (!list.includes(cur)) { const first = rungs[0]; first.tabIndex = 0; }
    ladder.setAttribute('aria-label', sys === 'dp' ? 'Diametral pitch' : 'Module');
    if (document.activeElement !== ladderIn) ladderIn.value = raw[key] ?? '';
    ladderIn.setAttribute('aria-label', sys === 'dp' ? 'Diametral pitch, any value' : 'Module in mm, any value');
    ladder.replaceChildren(el('div', { class: 'lh' }, sys === 'dp' ? 'DP 1/in' : 'm mm'), ...rungs, ladderIn);
  }

  // ---------- views ----------
  function fitMain(W, H, g) {
    const [G1, G2] = g.gears;
    const ra1 = G1.da / 2, ra2 = G2.da / 2, R = Math.max(ra1, ra2);
    const narrow = W < 520;
    const padX = narrow ? 40 : 80, padT = narrow ? 34 : 30, padB = narrow ? 52 : 80;
    const s = Math.max(0.01, Math.min((W - 2 * padX) / (ra1 + g.aw + ra2), (H - padT - padB) / (2 * R)));
    const cx = (-ra1 + g.aw + ra2) / 2;
    return { s, ox: W / 2 - s * cx, oy: padT + (H - padT - padB) / 2 };
  }

  const mesh = (g) => {
    const [G1, G2] = g.gears;
    const aw = g.aw, a = g.alphaW * DEG;
    const rb1 = G1.db / 2, rb2 = G2.db / 2, ra1 = G1.da / 2, ra2 = G2.da / 2;
    const T1 = [rb1 * Math.cos(-a), rb1 * Math.sin(-a)];
    const u = [Math.sin(a), Math.cos(a)];
    const L = aw * Math.sin(a);
    const sA = L - Math.sqrt(Math.max(0, ra2 * ra2 - rb2 * rb2));
    const sE = Math.sqrt(Math.max(0, ra1 * ra1 - rb1 * rb1));
    const at = (s) => [T1[0] + s * u[0], T1[1] + s * u[1]];
    const rw1 = (aw * G1.z) / (G1.z + G2.z);
    return { T1, u, L, sA, sE, at, rw1, a };
  };

  function sceneSVG(g, V, W, H, main) {
    const [G1, G2] = g.gears;
    const X = (x) => V.ox + V.s * x, Y = (y) => V.oy - V.s * y;
    const M = mesh(g);
    const out = [];
    const circle = (cx, r, cls, extra = '') => `<circle cx="${X(cx).toFixed(1)}" cy="${Y(0).toFixed(1)}" r="${(r * V.s).toFixed(2)}" ${cls} ${extra}/>`;
    const tr = (cx) => `translate(${X(cx).toFixed(2)},${Y(0).toFixed(2)}) scale(${V.s},${-V.s})`;
    // rings: tip, root faint; base dotted; pitch chain line
    for (const [G, cx, col] of [[G1, 0, 'var(--tool-g1)'], [G2, g.aw, 'var(--tool-g2)']]) {
      out.push(`<g class="gear" data-i="${cx ? 1 : 0}">`);
      out.push(`<g class="body" data-gear="${cx ? 1 : 0}" transform="${tr(cx)}"><g class="rot">`
        + `<path d="${outlines[cx ? 1 : 0].d}" fill="${col}" fill-opacity="0.13" stroke="${col}" stroke-width="1.3" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`
        + (outlines[cx ? 1 : 0].notch ? `<path d="${outlines[cx ? 1 : 0].notch}" fill="var(--danger)" stroke="var(--danger)" stroke-width="1" vector-effect="non-scaling-stroke"/>` : '')
        + (main ? `<circle r="${Math.max(G.df * 0.16, Math.min(G.df * 0.22, 6 * g.mn))}" fill="var(--surface)" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>`
          + `<line x1="${Math.max(G.df * 0.16, Math.min(G.df * 0.22, 6 * g.mn))}" y1="0" x2="${G.df * 0.44}" y2="0" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke" stroke-opacity="0.7"/>` : '')
        + `</g></g>`);
      out.push(circle(cx, G.da / 2, 'fill="none" stroke="var(--ink-soft)" stroke-opacity="0.35" stroke-width="0.7" pointer-events="none"'));
      out.push(circle(cx, G.df / 2, 'fill="none" stroke="var(--ink-soft)" stroke-opacity="0.35" stroke-width="0.7" pointer-events="none"'));
      out.push(circle(cx, G.db / 2, 'fill="none" stroke="var(--ink-soft)" stroke-opacity="0.7" stroke-width="0.9" stroke-dasharray="1.2 2.6" pointer-events="none"'));
      out.push(circle(cx, G.d / 2, 'fill="none" stroke="var(--ink-soft)" stroke-width="0.9" stroke-dasharray="9 3 2 3" pointer-events="none"'));
      if (main) {
        const c = 7;
        out.push(`<path d="M${X(cx) - c},${Y(0)}h${2 * c}M${X(cx)},${Y(0) - c}v${2 * c}" stroke="var(--ink)" stroke-width="1" pointer-events="none"/>`);
      }
      out.push('</g>');
    }
    // line of action and contact zone
    const p = (s) => { const q = M.at(s); return [X(q[0]), Y(q[1])]; };
    const t1 = p(0), t2 = p(M.L), A = p(M.sA), E = p(M.sE);
    const bad = g.ea < 1.2, col = bad ? 'var(--danger)' : 'var(--tool-loa)';
    out.push(`<g pointer-events="none">`);
    out.push(`<line x1="${t1[0]}" y1="${t1[1]}" x2="${t2[0]}" y2="${t2[1]}" stroke="var(--tool-loa)" stroke-width="1" stroke-opacity="0.8"/>`);
    for (const q of [t1, t2]) out.push(`<circle cx="${q[0]}" cy="${q[1]}" r="2.2" fill="var(--tool-loa)"/>`);
    out.push(`<line x1="${A[0]}" y1="${A[1]}" x2="${E[0]}" y2="${E[1]}" stroke="${col}" stroke-width="${main ? 5 : 6}" stroke-opacity="0.45" stroke-linecap="butt"/>`);
    for (const q of [A, E]) out.push(`<line x1="${q[0] - 5 * Math.cos(M.a)}" y1="${q[1] - 5 * Math.sin(M.a)}" x2="${q[0] + 5 * Math.cos(M.a)}" y2="${q[1] + 5 * Math.sin(M.a)}" stroke="${col}" stroke-width="1.4"/>`);
    // pitch point
    const P = [X(M.rw1), Y(0)];
    out.push(`<circle cx="${P[0]}" cy="${P[1]}" r="2.6" fill="var(--surface)" stroke="var(--ink)" stroke-width="1"/>`);
    out.push(`<g class="dots"></g>`);
    // contact ratio label beside the zone (beyond the pinion-tip end)
    const lx = Math.max(4, Math.min(W - 118, E[0] + 10)), ly = Math.max(14, Math.min(H - 20, E[1] - 8));
    out.push(`<text x="${lx}" y="${ly}" class="halo" font-size="${main ? 12 : 11.5}" font-weight="600" fill="${col}">εα ${fx(g.ea, 3)}</text>`);
    out.push(`<text x="${lx}" y="${ly + 13}" class="halo" font-size="10" fill="var(--ink-soft)">gα ${f3(g.contactLength)} · pb ${f3(g.pb)}</text>`);
    if (!main) {
      out.push(`<text x="${t1[0] + 8}" y="${t1[1] + 4}" class="halo" font-size="10" fill="var(--ink-soft)">T1</text>`);
      out.push(`<text x="${t2[0] + 8}" y="${t2[1] + 4}" class="halo" font-size="10" fill="var(--ink-soft)">T2</text>`);
      out.push(`<text x="${P[0] + 7}" y="${P[1] + 14}" class="halo" font-size="10" fill="var(--ink-soft)">P  αw ${fx(g.alphaW, 2)}°</text>`);
    }
    out.push('</g>');
    if (main) out.push(dimensions(g, V, X, Y, W));
    return out.join('');
  }

  function dimensions(g, V, X, Y, W) {
    const [G1, G2] = g.gears;
    const o = [];
    const arrow = (x, y, ang) => {
      const L = 7, w = 2.6, c = Math.cos(ang), s = Math.sin(ang);
      return `<path d="M${x},${y}L${x - L * c + w * s},${y - L * s - w * c}L${x - L * c - w * s},${y - L * s + w * c}Z" fill="var(--tool-dim)"/>`;
    };
    const dimV = (x, yTop, yBot, x0, label, anchorLeft) => {
      // extension lines from x0 (circle top/bottom) to x
      const ext = (y) => `<line x1="${x0}" y1="${y}" x2="${x + (anchorLeft ? -3 : 3)}" y2="${y}" stroke="var(--tool-dim)" stroke-width="0.6" stroke-opacity="0.6"/>`;
      const mid = (yTop + yBot) / 2;
      const tx = x + (anchorLeft ? -4 : 4);
      return ext(yTop) + ext(yBot)
        + `<line x1="${x}" y1="${yTop}" x2="${x}" y2="${yBot}" stroke="var(--tool-dim)" stroke-width="0.9"/>`
        + arrow(x, yTop, -Math.PI / 2) + arrow(x, yBot, Math.PI / 2)
        + `<text transform="translate(${tx},${mid}) rotate(-90)" text-anchor="middle" font-size="10.5" class="halo" fill="var(--ink)">${esc(label)}</text>`;
    };
    const gap = V.s * Math.min(G1.da, G2.da) < 120 ? 15 : 17;
    for (const [G, cx, side] of [[G1, 0, -1], [G2, g.aw, 1]]) {
      const ra = G.da / 2;
      const base = X(cx) + side * (ra * V.s + 12);
      const items = W < 520 ? [['da', G.da]] : [['df', G.df], ['d', G.d], ['da', G.da]];
      items.forEach(([k, v], i) => {
        const x = base + side * i * gap;
        o.push(dimV(x, Y(v / 2), Y(-v / 2), X(cx), `${k} ${f3(v)}`, side < 0));
      });
    }
    // centre distance, below, draggable at the gear end
    const R = Math.max(G1.da, G2.da) / 2;
    const y = Y(-R) + 26;
    const x1 = X(0), x2 = X(g.aw);
    o.push(`<line x1="${x1}" y1="${Y(0) + 9}" x2="${x1}" y2="${y + 5}" stroke="var(--tool-dim)" stroke-width="0.6" stroke-opacity="0.6"/>`);
    o.push(`<line x1="${x2}" y1="${Y(0) + 9}" x2="${x2}" y2="${y + 5}" stroke="var(--tool-dim)" stroke-width="0.6" stroke-opacity="0.6"/>`);
    o.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--tool-dim)" stroke-width="0.9"/>`);
    o.push(arrow(x1, y, Math.PI) + arrow(x2, y, 0));
    const shifted = Math.abs(g.aw - g.a) > 1e-9;
    o.push(`<text x="${(x1 + x2) / 2}" y="${y - 5}" text-anchor="middle" font-size="11.5" font-weight="600" class="halo" fill="var(--ink)">a ${f3(g.aw)}</text>`);
    const xs = `x1 ${fx(g.gears[0].x, 3)} · x2 ${fx(g.gears[1].x, 3)}`;
    o.push(`<text x="${(x1 + x2) / 2}" y="${y + 14}" text-anchor="middle" font-size="10" class="halo" fill="${shifted ? 'var(--accent)' : 'var(--ink-soft)'}">${shifted ? `a0 ${f3(g.a)} · ${xs}${g.fromAw ? ' (from a)' : ''}` : 'standard, no profile shift'}</text>`);
    o.push(`<g class="knob" data-knob="a" tabindex="0" role="slider" aria-label="Centre distance a, drag or use arrow keys" aria-valuenow="${g.aw.toFixed(3)}" aria-valuetext="${f3(g.aw)} mm">`
      + `<rect class="kf" x="${x2 - 11}" y="${y - 11}" width="22" height="22" fill="transparent"/>`
      + `<path class="kc" d="M${x2},${y - 7}L${x2 + 7},${y}L${x2},${y + 7}L${x2 - 7},${y}Z" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/>`
      + `<title>Drag to set the centre distance; the profile shift follows</title></g>`);
    // tooth-count knobs on the rims
    const narrow = W < 520;
    for (const [G, cx, ang, i, col] of [[G1, 0, narrow ? 100 : 135, 0, 'var(--tool-g1)'], [G2, g.aw, narrow ? 72 : 45, 1, 'var(--tool-g2)']]) {
      const r = (G.da / 2) * V.s + 11;
      const a = ang * DEG;
      const kx = X(cx) + r * Math.cos(a), ky = Y(0) - r * Math.sin(a);
      const lab = `z${i + 1} ${G.z}`;
      const right = i || narrow;
      const tx = kx + (right ? 12 : -12);
      o.push(`<g class="rim"><g class="knob" data-knob="z${i + 1}" tabindex="0" role="slider" aria-label="${i ? 'Gear' : 'Pinion'} teeth z${i + 1}, drag outward for more teeth or use arrow keys" aria-valuenow="${G.z}">`
        + `<circle class="kf" cx="${kx}" cy="${ky}" r="13" fill="transparent"/>`
        + `<circle class="kc" cx="${kx}" cy="${ky}" r="7" fill="var(--surface)" stroke="${col}" stroke-width="2"/>`
        + `<path d="M${kx - 3.2},${ky}h6.4M${kx},${ky - 3.2}v6.4" stroke="${col}" stroke-width="1.4"/>`
        + `<text x="${tx}" y="${ky + 4}" text-anchor="${right ? 'start' : 'end'}" font-size="12" font-weight="600" class="halo" fill="${col}">${lab}</text>`
        + `<title>Drag outward for more teeth, inward for fewer</title></g>`
        + `<circle class="track" cx="${X(cx)}" cy="${Y(0)}" r="${r}" fill="none" stroke="${col}" stroke-width="1" stroke-dasharray="3 4" pointer-events="none"/></g>`);
      if (G.undercut) {
        const lab = `undercut: z${i + 1} ${G.z} < zmin ${fx(G.zmin, 1)}`, hw = lab.length * 3.4 + 4;
        const ux = Math.max(hw, Math.min(W - hw, X(cx)));
        o.push(`<text x="${ux}" y="${narrow ? Y(0) + (G.da / 2) * V.s + 18 : Y(0) - (G.da / 2) * V.s - 26}" text-anchor="middle" font-size="11" font-weight="600" class="halo" fill="var(--danger)">${esc(lab)}</text>`);
      }
    }
    return o.join('');
  }

  function frame() {
    if (!geo) return;
    const z1 = geo.gears[0].z, z2 = geo.gears[1].z;
    const a1 = theta / DEG;
    const a2 = (Math.PI + Math.PI / z2 - (theta * z1) / z2) / DEG;
    for (const s of [svg, dsvg]) {
      const rots = s.querySelectorAll('.rot');
      if (rots[0]) rots[0].setAttribute('transform', `rotate(${a1})`);
      if (rots[1]) rots[1].setAttribute('transform', `rotate(${a2})`);
      const V = s === svg ? s._V : s._V;
      const dots = s.querySelector('.dots');
      if (!V || !dots) continue;
      const M = mesh(geo);
      const G1 = geo.gears[0];
      const rb1 = G1.db / 2;
      const psi = G1.st / G1.d + inv(geo.alphaT * DEG);
      let s0 = rb1 * (theta + psi + M.a);
      const pb = geo.pb;
      s0 = ((s0 - M.sA) % pb + pb) % pb + M.sA;
      let html = '';
      for (let q = s0; q <= M.sE + 1e-9; q += pb) {
        const [x, y] = M.at(q);
        html += `<circle cx="${(V.ox + V.s * x).toFixed(1)}" cy="${(V.oy - V.s * y).toFixed(1)}" r="${s === svg ? 3.6 : 4.2}" fill="var(--tool-loa)" stroke="var(--surface)" stroke-width="1.2"/>`;
      }
      dots.innerHTML = html;
    }
  }

  function render() {
    if (!geo) {
      svg.innerHTML = '';
      dsvg.innerHTML = '';
      const W = canvas.clientWidth, H = canvas.clientHeight;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--danger)">${esc((res?.warnings || ['No gear pair'])[0])}</text>`;
      return;
    }
    const W = Math.max(200, canvas.clientWidth), H = Math.max(200, canvas.clientHeight);
    const V = frozen || fitMain(W, H, geo);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = sceneSVG(geo, V, W, H, true);
    svg._V = V;
    if (drag) svg.classList.add('dragging');
    // detail: centred on the contact zone
    const dW = Math.max(160, dsvg.parentElement.clientWidth), dH = Math.max(120, dsvg.parentElement.clientHeight);
    const M = mesh(geo);
    const mid = M.at((M.sA + M.sE) / 2);
    const span = Math.max(M.L * 0.62, (M.sE - M.sA) * 1.25, 3.2 * geo.mn);
    const ds = Math.min(dW, dH * 1.2) / span;
    const DV = { s: ds, ox: dW / 2 - ds * mid[0] - 18, oy: dH / 2 + ds * mid[1] };
    dsvg.setAttribute('viewBox', `0 0 ${dW} ${dH}`);
    dsvg.innerHTML = sceneSVG(geo, DV, dW, dH, false);
    dsvg._V = DV;
    dsvg.setAttribute('aria-label', `Mesh detail: contact ratio ${fx(geo.ea, 3)}, working pressure angle ${fx(geo.alphaW, 2)} degrees`);
    detailZoom.textContent = `${(ds / V.s).toFixed(1)}×`;
    frame();
  }

  // ---------- table ----------
  function drawTable() {
    const raw = ctx.raw;
    if (!geo) { table.replaceChildren(); return; }
    const [G1, G2] = geo.gears;
    const locked = geo.fromAw;
    const inp = (key, val, label, lock) => {
      const i = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': label, class: lock ? 'lock' : null, title: lock ? 'Set by the centre distance; typing here frees it' : null });
      i.value = val;
      i.addEventListener('change', () => {
        const v = i.value.trim();
        if (lock) ctx.setMany({ aw: '', x1: fx(G1.x, 6), x2: fx(G2.x, 6), [key]: v });
        else ctx.set(key, v);
      });
      i.addEventListener('keydown', (e) => {
        if (key[0] !== 'z' || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const n = Math.max(3, (num(i.value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 1));
        i.value = String(n); ctx.set(key, String(n));
      });
      return i;
    };
    const tr = (label, a, b, cls = '') => el('tr', { class: cls }, el('td', {}, label), el('td', {}, a), el('td', {}, b));
    const zCls = (G) => (G.undercut ? 'bad' : '');
    const rows = [
      el('tr', {}, el('th', {}, ''), el('th', { class: 'g1' }, 'Pinion'), el('th', { class: 'g2' }, 'Gear')),
      tr(el('span', {}, 'Teeth ', el('i', {}, 'z')), inp('z1', raw.z1, 'Pinion teeth z1'), inp('z2', raw.z2, 'Gear teeth z2')),
      tr(el('span', {}, 'Profile shift ', el('i', {}, 'x')), inp('x1', locked ? fx(G1.x) : raw.x1, 'Pinion profile shift x1', locked), inp('x2', locked ? fx(G2.x) : raw.x2, 'Gear profile shift x2', locked)),
      tr(el('span', {}, 'Pitch Ø ', el('i', {}, 'd')), f3(G1.d), f3(G2.d)),
      tr(el('span', {}, 'Tip Ø ', el('i', {}, 'da')), f3(G1.da), f3(G2.da)),
      tr(el('span', {}, 'Root Ø ', el('i', {}, 'df')), f3(G1.df), f3(G2.df)),
      tr(el('span', {}, 'Base Ø ', el('i', {}, 'db')), f3(G1.db), f3(G2.db)),
      tr(el('span', {}, 'Tooth thk. at d ', el('i', {}, 's')), f3(G1.st), f3(G2.st)),
      tr(el('span', {}, 'Tip thickness ', el('i', {}, 'sa')), el('span', { class: G1.sa < 0.2 * geo.mn ? 'bad' : '' }, f3(G1.sa)), el('span', { class: G2.sa < 0.2 * geo.mn ? 'bad' : '' }, f3(G2.sa))),
      tr(el('span', {}, 'Undercut limit ', el('i', {}, 'zmin')), el('span', { class: zCls(G1) }, fx(G1.zmin, 2)), el('span', { class: zCls(G2) }, fx(G2.zmin, 2)), 'sep'),
    ];
    const awIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Centre distance a in mm (sets the profile shift)', class: locked ? 'lock' : null });
    awIn.value = locked ? raw.aw : fx(geo.aw, 4);
    awIn.addEventListener('change', () => { const v = awIn.value.trim(); ctx.set('aw', v); });
    const std = el('button', { title: 'Back to the standard centre distance, no profile shift', onclick: () => ctx.setMany({ aw: '', x1: '0', x2: '0' }) }, 'std');
    const pair = (label, val, cls) => el('tr', {}, el('td', {}, label), el('td', { colspan: '2', class: cls || null }, val));
    const outSpeed = (res.values || []).find((v) => v.label === 'Output speed');
    rows.push(
      pair(el('span', {}, 'Centre distance ', el('i', {}, 'a')), el('span', {}, awIn, Math.abs(geo.aw - geo.a) > 1e-9 || locked ? std : null)),
      pair(el('span', {}, 'Standard ', el('i', {}, 'a0'), ' · shift ', el('i', {}, 'y')), `${f3(geo.a)} · ${fx(geo.y, 4)}`),
      pair(el('span', {}, 'Ratio ', el('i', {}, 'i')), `${fx(geo.ratio, 4)} : 1`),
      pair(el('span', {}, 'Contact ratio ', el('i', {}, 'εα')), `${fx(geo.ea, 3)}`, geo.ea < 1.2 ? 'bad' : geo.ea < 1.4 ? 'warn' : 'ok'),
      pair(el('span', {}, 'Working pressure angle ', el('i', {}, 'αw')), `${fx(geo.alphaW, 3)}°`),
      pair(el('span', {}, 'Module ', el('i', {}, 'm'), geo.beta ? ' · transverse mt' : ' · DP'), geo.beta ? `${fx(geo.mn, 4)} · ${fx(geo.mt, 4)}` : `${fx(geo.mn, 4)} · ${fx(25.4 / geo.mn, 3)}`),
      pair(el('span', {}, 'Whole depth ', el('i', {}, 'h'), ' · base pitch ', el('i', {}, 'pb')), `${f3(geo.h)} · ${f3(geo.pb)}`),
    );
    if (outSpeed) rows.push(pair(el('span', {}, 'Output speed ', el('i', {}, 'n2')), `${outSpeed.value} rpm`));
    const act = table.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = act?.getAttribute('aria-label');
    table.replaceChildren(el('tbody', {}, rows));
    if (focusKey) [...table.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === focusKey)?.focus();
  }

  function drawMsgs() {
    const fixes = (geo?.gears || []).map((G, i) => (G.undercut && !geo.fromAw
      ? el('div', { class: 'note' }, `Clear the undercut on ${i ? 'the gear' : 'the pinion'}: `,
        el('button', { class: 'gc-btn', onclick: () => ctx.set(`x${i + 1}`, String(Math.ceil(G.xFree * 1000) / 1000)) }, `Set x${i + 1} = ${fx(Math.ceil(G.xFree * 1000) / 1000, 3)}`))
      : null)).filter(Boolean);
    msgs.replaceChildren(...fixes, ...(res?.warnings || []).map((w) => el('div', {}, w)),
      ...(geo?.fromAw ? (res.notes || []).slice(0, 1).map((n) => el('div', { class: 'note' }, n)) : []));
  }

  function drawHint() {
    hint.textContent = window.innerWidth < 640
      ? 'Drag a + knob for teeth, the ◆ for centre distance, a gear to turn it.'
      : 'Drag the + knobs on the rims to change tooth counts, the ◆ on a to set the centre distance (profile shift follows), a gear to turn the pair. Arrow keys work on focused knobs.';
  }

  // ---------- interaction ----------
  const pt = (e) => {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)];
  };

  function knobStep(k, dir, big) {
    if (!geo) return;
    const raw = ctx.raw;
    if (k === 'a') {
      const step = geo.mn * (big ? 0.2 : 0.02);
      const v = Math.round((geo.aw + dir * step) * 1e4) / 1e4;
      ctx.set('aw', String(v));
    } else {
      const key = k;
      const z = Math.max(3, (num(raw[key]) || geo.gears[key === 'z1' ? 0 : 1].z) + dir * (big ? 5 : 1));
      ctx.set(key, String(z));
    }
  }

  svg.addEventListener('keydown', (e) => {
    const k = e.target.closest?.('.knob')?.dataset.knob;
    const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (k) {
      knobStep(k, dir, e.shiftKey);
      requestAnimationFrame(() => svg.querySelector(`[data-knob="${k}"]`)?.focus());
    }
  });

  svg.addEventListener('pointerdown', (e) => {
    if (!geo) return;
    const knob = e.target.closest('.knob');
    const body = e.target.closest('.body');
    if (!knob && !body) return;
    e.preventDefault();
    const V = svg._V;
    const p = pt(e);
    frozen = { ...V };
    if (knob) {
      const k = knob.dataset.knob;
      const raw = ctx.raw;
      drag = { kind: k, p0: p, aw0: geo.aw, z0: geo.gears[k === 'z2' ? 1 : 0].z, awFixed: num(raw.aw) > 0 };
      knob.focus({ preventScroll: true });
    } else {
      const i = Number(body.dataset.gear);
      const c = [V.ox + V.s * (i ? geo.aw : 0), V.oy];
      drag = { kind: 'turn', gear: i, c, ang0: Math.atan2(-(p[1] - c[1]), p[0] - c[0]), th0: theta };
    }
    svg.classList.add('dragging');
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag || !geo) return;
    const p = pt(e);
    const V = frozen;
    const dx = (p[0] - drag.p0?.[0]) / V.s, dy = -(p[1] - drag.p0?.[1]) / V.s; // mm, math sense
    if (drag.kind === 'turn') {
      const ang = Math.atan2(-(p[1] - drag.c[1]), p[0] - drag.c[0]);
      let d = ang - drag.ang0;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const z1 = geo.gears[0].z, z2 = geo.gears[1].z;
      theta = drag.gear ? drag.th0 - (d * z2) / z1 : drag.th0 + d;
      drag.ang0 = ang; drag.th0 = theta;
      frame();
      return;
    }
    if (drag.kind === 'a') {
      const v = Math.max(1e-3, drag.aw0 + dx);
      const snap = geo.mn * 0.01;
      const nv = Math.round(Math.round(v / snap) * snap * 1e4) / 1e4;
      if (String(nv) !== String(ctx.raw.aw)) ctx.set('aw', String(nv));
      return;
    }
    const i = drag.kind === 'z2' ? 1 : 0;
    const ang = (i ? 45 : 135) * DEG;
    const e1 = [Math.cos(ang), Math.sin(ang)];
    const half = geo.mt / 2;
    // how the knob moves per tooth: its own radius, plus the gear's centre moving with a
    const g = i && !drag.awFixed ? [half * (1 + e1[0]), half * e1[1]] : [half * e1[0], half * e1[1]];
    const n = (dx * g[0] + dy * g[1]) / (g[0] * g[0] + g[1] * g[1]);
    const z = Math.max(3, Math.min(400, drag.z0 + Math.round(n)));
    if (z !== geo.gears[i].z) ctx.set(`z${i + 1}`, String(z));
  });

  const endDrag = () => {
    if (!drag) return;
    const k = drag.kind;
    drag = null; frozen = null;
    svg.classList.remove('dragging');
    render();
    if (k !== 'turn') requestAnimationFrame(() => svg.querySelector(`[data-knob="${k}"]`)?.focus({ preventScroll: true }));
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('lostpointercapture', endDrag);

  // ---------- result ----------
  let outlineKey = '';
  ctx.onResult((r) => {
    res = r;
    geo = r.geometry || null;
    if (geo) {
      const key = JSON.stringify([geo.alphaT, geo.gears.map((G) => [G.z, G.d, G.da, G.df, G.db, G.st, G.undercut])]);
      if (key !== outlineKey) { outlineKey = key; outlines = geo.gears.map((G) => gearOutline(G, geo.alphaT * DEG)); }
    }
    syncControls();
    drawTable();
    drawMsgs();
    render();
  });

  drawHint();
  window.addEventListener('resize', drawHint);
  new ResizeObserver(() => { if (!drag) render(); }).observe(canvas);
  setPlaying(playing);
}
