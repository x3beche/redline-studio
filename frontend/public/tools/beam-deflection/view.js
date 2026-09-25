// Beam Deflection page: the beam on its supports is the interface. Push the
// load along the span, pull its arrow to change the force, drag the far end
// to change the span, click a support to change how the ends are held; the
// beam bends (exaggerated), the limit band and the moment diagram follow.
// Below it the cross-section, drawn to scale, has its own handles, with the
// bending stress across its depth. Every number drawn comes from run()'s
// result.beam.

import { MATERIALS } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const LADDER = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const SUPPORTS = [['simple', 'Simply supported'], ['cantilever', 'Cantilever'], ['fixed', 'Fixed both ends']];
const SECTIONS = [['rect', 'Rectangle'], ['round', 'Round bar'], ['tube', 'Round tube'], ['rhs', 'Box section'], ['custom', 'Custom I, c']];
const SEC_KEYS = { rect: ['b', 'h'], round: ['d'], tube: ['d', 't'], rhs: ['b', 'h', 't'], custom: ['I', 'c', 'A'] };
const KEY_LABEL = { b: ['b', 'mm', 'Width b'], h: ['h', 'mm', 'Height h'], d: ['Ø d', 'mm', 'Outside diameter'], t: ['t', 'mm', 'Wall thickness'],
  I: ['I', 'mm⁴', 'Second moment I'], c: ['c', 'mm', 'Extreme fibre c'], A: ['A', 'mm²', 'Area, for self weight'] };
const LIMITS = ['180', '250', '360', '500'];

const CSS = `
:root { --tool-steel: #8795a3; --tool-load: #c96a0a; --tool-defl: #1f4ed8; --tool-mom: #0f8a78; --tool-dim: #5b6b7a;
  --tool-beam-fill: color-mix(in srgb, #8795a3 30%, var(--surface)); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-steel: #72818f; --tool-load: #f0a33a; --tool-defl: #7d9bff; --tool-mom: #3cc7b3; --tool-dim: #8ea0b0;
  --tool-beam-fill: color-mix(in srgb, #72818f 34%, var(--surface)); } }
:root[data-theme="dark"] { --tool-steel: #72818f; --tool-load: #f0a33a; --tool-defl: #7d9bff; --tool-mom: #3cc7b3; --tool-dim: #8ea0b0;
  --tool-beam-fill: color-mix(in srgb, #72818f 34%, var(--surface)); }
.k-page { padding: 10px 12px 12px; }
.bm { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(330px, 1fr) auto; height: calc(100vh - 64px); min-height: 700px; }
.bm-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.bm-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.bm-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); display: inline-flex; align-items: center; gap: 5px; }
.bm-seg button + button { border-left: 1px solid var(--line); }
.bm-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.bm-seg svg { width: 26px; height: 14px; }
.bm-fld { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.bm-fld input { width: 70px; padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.bm-fld input.bad { border-color: var(--danger); }
.bm-fld input[type="checkbox"] { width: auto; margin: 0; }
.bm-hint { margin-left: auto; font-size: 11px; color: var(--ink-soft); }
.bm-stage { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-height: 0; min-width: 0; overflow: hidden; }
.bm-stage svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.bm-low { display: grid; gap: 10px; grid-template-columns: 330px 260px minmax(0, 1fr); align-items: stretch; }
.bm-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; display: flex; flex-direction: column; }
.bm-card h2 { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--ink-soft); padding: 6px 10px 4px; display: flex; gap: 8px; align-items: center; }
.bm-card h2 b { margin-left: auto; font: 500 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.bm-secpick { display: flex; gap: 3px; padding: 0 8px; }
.bm-secpick button { flex: 1; border: 1px solid var(--line); background: var(--surface); border-radius: 4px; padding: 3px 0; cursor: pointer; color: var(--ink-soft); }
.bm-secpick button[aria-pressed="true"] { background: var(--sunken); border-color: var(--ink-soft); color: var(--ink); }
.bm-secpick svg { width: 22px; height: 18px; display: block; margin: 0 auto; }
.bm-sec { height: 184px; }
.bm-sec svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; }
.bm-secf { display: flex; flex-wrap: wrap; gap: 6px 12px; padding: 4px 10px 9px; }
.bm-mats { list-style: none; margin: 0; padding: 0 6px 4px; display: flex; flex-direction: column; gap: 1px; }
.bm-mats button { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 46px 40px; gap: 4px; align-items: center; border: 0; border-radius: 4px;
  background: transparent; padding: 2px 5px; cursor: pointer; text-align: left; font-size: 12px; color: var(--ink); }
.bm-mats button:hover { background: var(--sunken); }
.bm-mats button[aria-checked="true"] { background: var(--accent); color: var(--accent-ink); }
.bm-mats button span { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; opacity: .85; }
.bm-mats .hd { display: grid; grid-template-columns: minmax(0, 1fr) 46px 40px; gap: 4px; font-size: 10.5px; color: var(--ink-soft); padding: 0 11px 2px; }
.bm-mats .hd span { text-align: right; }
.bm-matx { display: flex; flex-wrap: wrap; gap: 6px 12px; padding: 4px 10px 8px; border-top: 1px solid var(--line-soft); margin-top: auto; }
.bm-chips { display: inline-flex; gap: 2px; }
.bm-chips button { border: 1px solid var(--line); background: var(--surface); border-radius: 10px; font: 11px "IBM Plex Mono", ui-monospace, monospace; padding: 0 6px; cursor: pointer; color: var(--ink-soft); }
.bm-chips button[aria-pressed="true"] { border-color: var(--accent); color: var(--ink); }
.bm-right { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.bm-right .k-out { max-height: 200px; }
.bm-right .k-outwrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.bm-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.bm-msgs div { padding: 4px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.bm-msgs div.bad { border-left-color: var(--danger); }
.bm-msgs div.ok { border-left-color: var(--ok); color: var(--ink-soft); }
.bm svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.bm .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.bm .knob { cursor: grab; outline: none; }
.bm .knob.h { cursor: ew-resize; } .bm .knob.v { cursor: ns-resize; }
.bm .knob:focus-visible .kc { stroke: var(--accent); stroke-width: 3px; }
.bm .knob:focus-visible .kf { stroke: var(--accent); stroke-width: 1.5px; stroke-dasharray: 3 2; }
.bm .sup { cursor: pointer; outline: none; }
.bm .sup:hover .sk, .bm .sup:focus-visible .sk { stroke: var(--accent); }
.bm .sup:focus-visible .kf { stroke: var(--accent); stroke-width: 1.5px; stroke-dasharray: 3 2; }
.bm .dragging, .bm .dragging * { cursor: grabbing !important; }
@media (max-width: 1100px) { .bm-low { grid-template-columns: 330px minmax(0, 1fr); } .bm-right { grid-column: 1 / -1; } }
@media (max-width: 700px) {
  .bm-low { grid-template-columns: minmax(0, 1fr); }
  .bm { height: auto; min-height: 0; grid-template-rows: auto 400px auto; }
  .bm-hint { display: none; }
}
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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const g3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(3))));
const g4 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(4))));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const niceStep = (span) => { const p = 10 ** Math.floor(Math.log10(span)); const m = span / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
const ladderSnap = (v) => { const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; const best = [...LADDER, 10].reduce((b, x) => (Math.abs(Math.log(x / m)) < Math.abs(Math.log(b / m)) ? x : b), 1); return Number((best * p).toPrecision(3)); };
const ladderStep = (v, dir) => {
  const all = [];
  for (let e = -3; e <= 7; e++) for (const s of LADDER) all.push(Number((s * 10 ** e).toPrecision(3)));
  const i = all.findIndex((x) => x >= v * 0.999);
  const j = clamp((i < 0 ? all.length - 1 : all[i] > v * 1.001 && dir > 0 ? i - 1 : i) + dir, 0, all.length - 1);
  return all[j];
};
const arrowHead = (x, y, ang, L = 8, w = 3.2) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return `M${x},${y}L${x - L * c + w * s},${y - L * s - w * c}L${x - L * c - w * s},${y - L * s + w * c}Z`;
};

function supportIcon(kind) {
  const b = '<line x1="3" y1="4" x2="23" y2="4" stroke="currentColor" stroke-width="2"/>';
  if (kind === 'simple') return `<svg viewBox="0 0 26 14">${b}<path d="M3,5l-2.5,5h5z M23,5l-2.5,4h5z" fill="none" stroke="currentColor"/><circle cx="21.5" cy="11" r="1.2" fill="currentColor"/><circle cx="24.5" cy="11" r="1.2" fill="currentColor"/></svg>`;
  if (kind === 'cantilever') return `<svg viewBox="0 0 26 14"><line x1="3" y1="4" x2="23" y2="4" stroke="currentColor" stroke-width="2"/><path d="M2,0v13M2,2l-2,2M2,6l-2,2M2,10l-2,2" stroke="currentColor"/></svg>`;
  return `<svg viewBox="0 0 26 14">${b}<path d="M2,0v13M2,2l-2,2M2,6l-2,2M2,10l-2,2M24,0v13M24,2l2,2M24,6l2,2M24,10l2,2" stroke="currentColor"/></svg>`;
}
function sectionIcon(kind) {
  const s = 'fill="none" stroke="currentColor" stroke-width="1.4"';
  if (kind === 'rect') return `<svg viewBox="0 0 22 18"><rect x="7" y="1.5" width="8" height="15" ${s}/></svg>`;
  if (kind === 'round') return `<svg viewBox="0 0 22 18"><circle cx="11" cy="9" r="7" fill="currentColor" fill-opacity=".25" ${s}/></svg>`;
  if (kind === 'tube') return `<svg viewBox="0 0 22 18"><circle cx="11" cy="9" r="7" ${s}/><circle cx="11" cy="9" r="4.6" ${s}/></svg>`;
  if (kind === 'rhs') return `<svg viewBox="0 0 22 18"><rect x="5.5" y="1.5" width="11" height="15" ${s}/><rect x="8" y="4" width="6" height="10" ${s}/></svg>`;
  return '<svg viewBox="0 0 22 18"><text x="11" y="13" text-anchor="middle" font-size="10" fill="currentColor" font-family="IBM Plex Mono, monospace">I</text></svg>';
}

export function page(root, ctx) {
  document.head.append(el('style', { text: CSS }));
  let B = null, res = null, drag = null, kdef = null, kdefL = null, secV = null, secFrozen = null, geo = null;

  // ---------- toolbar ----------
  const segSup = el('div', { class: 'bm-seg', role: 'group', 'aria-label': 'Supports' });
  const segLoad = el('div', { class: 'bm-seg', role: 'group', 'aria-label': 'Load type' });
  const loadIn = el('input', { inputmode: 'decimal', spellcheck: 'false' });
  const loadLbl = el('span');
  const loadUnit = el('span');
  const aIn = el('input', { inputmode: 'decimal', spellcheck: 'false', placeholder: 'mid', 'aria-label': 'Load position a from the left end, mm' });
  const aFld = el('label', { class: 'bm-fld' }, 'a', aIn, 'mm');
  const LIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Span L in mm' });
  const hint = el('span', { class: 'bm-hint' });
  const tools = el('div', { class: 'bm-tools' }, segSup, segLoad,
    el('label', { class: 'bm-fld' }, loadLbl, loadIn, loadUnit), aFld,
    el('label', { class: 'bm-fld' }, 'L', LIn, 'mm'), hint);
  loadIn.addEventListener('change', () => ctx.set(ctx.raw.load === 'udl' ? 'w' : 'P', loadIn.value.trim()));
  aIn.addEventListener('change', () => ctx.set('a', aIn.value.trim()));
  LIn.addEventListener('change', () => ctx.set('L', LIn.value.trim()));

  // ---------- stage ----------
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'The beam, its load, supports, deflected shape and bending moment');
  const stage = el('div', { class: 'bm-stage' }, svg);

  // ---------- section ----------
  const secPick = el('div', { class: 'bm-secpick', role: 'group', 'aria-label': 'Section shape' });
  const ssvg = document.createElementNS(NS, 'svg');
  ssvg.setAttribute('role', 'group');
  const secI = el('b');
  const secF = el('div', { class: 'bm-secf' });
  const secCard = el('section', { class: 'bm-card' }, el('h2', {}, 'Section, to scale · stress across the depth', secI), secPick, el('div', { class: 'bm-sec' }, ssvg), secF);

  // ---------- material ----------
  const mats = el('ul', { class: 'bm-mats', role: 'radiogroup', 'aria-label': 'Material' });
  const matX = el('div', { class: 'bm-matx' });
  const matCard = el('section', { class: 'bm-card' }, el('h2', {}, 'Material'), el('div', { class: 'bm-mats' }, el('div', { class: 'hd' }, el('b', {}, ''), el('span', {}, 'E GPa'), el('span', {}, 'fy MPa'))), mats, matX);

  const msgs = el('div', { class: 'bm-msgs', 'aria-live': 'polite' });
  const right = el('div', { class: 'bm-right' }, msgs, ctx.outputs);
  root.append(el('div', { class: 'bm' }, tools, stage, el('div', { class: 'bm-low' }, secCard, matCard, right)));

  // ---------- controls ----------
  function syncControls() {
    const raw = ctx.raw;
    const sup = SUPPORTS.some(([v]) => v === raw.support) ? raw.support : 'simple';
    segSup.replaceChildren(...SUPPORTS.map(([v, t]) => {
      const b = el('button', { 'aria-pressed': String(sup === v), title: t, onclick: () => ctx.set('support', v) });
      b.innerHTML = `${supportIcon(v)}<span>${esc(t.split(' ')[0] === 'Fixed' ? 'Fixed' : t.split(' ')[0])}</span>`;
      return b;
    }));
    const udl = raw.load === 'udl';
    segLoad.replaceChildren(...[['point', 'Point P'], ['udl', 'Uniform w']].map(([v, t]) =>
      el('button', { 'aria-pressed': String((udl ? 'udl' : 'point') === v), onclick: () => ctx.set('load', v) }, t)));
    loadLbl.textContent = udl ? 'w' : 'P';
    loadUnit.textContent = udl ? 'N/mm' : 'N';
    loadIn.setAttribute('aria-label', udl ? 'Uniform load w in N/mm' : 'Point load P in N');
    if (document.activeElement !== loadIn) loadIn.value = raw[udl ? 'w' : 'P'] ?? '';
    aFld.style.display = udl ? 'none' : '';
    if (document.activeElement !== aIn) aIn.value = raw.a ?? '';
    if (document.activeElement !== LIn) LIn.value = raw.L ?? '';
    for (const [inp, key] of [[loadIn, udl ? 'w' : 'P'], [LIn, 'L'], [aIn, 'a']]) inp.classList.toggle('bad', String(raw[key] ?? '').trim() !== '' && ctx.parseEng(raw[key]) == null);

    const sec = SEC_KEYS[raw.sec] ? raw.sec : 'rect';
    secPick.replaceChildren(...SECTIONS.map(([v, t]) => {
      const b = el('button', { 'aria-pressed': String(sec === v), title: t, 'aria-label': t, onclick: () => ctx.set('sec', v) });
      b.innerHTML = sectionIcon(v);
      return b;
    }));
    const act = secF.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    secF.replaceChildren(...SEC_KEYS[sec].map((k) => {
      const [s, u, l] = KEY_LABEL[k];
      const i = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${l}, ${u}`, placeholder: k === 'A' ? 'none' : '' });
      i.value = raw[k] ?? '';
      if (String(raw[k] ?? '').trim() !== '' && ctx.parseEng(raw[k]) == null) i.classList.add('bad');
      i.addEventListener('change', () => ctx.set(k, i.value.trim()));
      return el('label', { class: 'bm-fld' }, s, i, u);
    }));
    if (act) [...secF.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === act)?.focus();

    const mat = MATERIALS[raw.mat] ? raw.mat : 's235';
    mats.replaceChildren(...Object.entries(MATERIALS).map(([k, m]) => el('li', {}, el('button', {
      role: 'radio', 'aria-checked': String(mat === k), tabindex: mat === k ? '0' : '-1', onclick: () => ctx.set('mat', k),
      onkeydown: (e) => {
        const keys = Object.keys(MATERIALS);
        const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        ctx.set('mat', keys[clamp(keys.indexOf(k) + d, 0, keys.length - 1)]);
        requestAnimationFrame(() => mats.querySelector('[aria-checked="true"]')?.focus());
      },
    }, el('b', { style: 'font-weight:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, k === 'pla' ? 'PLA, printed' : m.name),
    el('span', {}, m.E ?? '·'), el('span', {}, m.fy ?? '·')))));
    const actM = matX.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    const fld = (k, s, u, l) => {
      const i = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': l });
      i.value = raw[k] ?? '';
      i.addEventListener('change', () => ctx.set(k, i.value.trim()));
      return el('label', { class: 'bm-fld' }, s, i, u);
    };
    const sw = el('input', { type: 'checkbox', 'aria-label': 'Add the beam\'s own weight' });
    sw.checked = !!raw.selfweight;
    sw.addEventListener('change', () => ctx.set('selfweight', sw.checked));
    const lim = String(raw.limit ?? '250');
    matX.replaceChildren(
      ...(mat === 'custom' ? [fld('E', 'E', 'GPa', 'Young\'s modulus E, GPa'), fld('fy', 'fy', 'MPa', 'Yield strength, MPa')] : []),
      el('label', { class: 'bm-fld' }, sw, 'self weight'),
      el('span', { class: 'bm-fld' }, 'limit L /', el('span', { class: 'bm-chips', role: 'group', 'aria-label': 'Deflection limit' },
        LIMITS.map((v) => el('button', { 'aria-pressed': String(lim === v), onclick: () => ctx.set('limit', v) }, v)))));
    if (actM) [...matX.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === actM)?.focus();
  }

  // ---------- the beam ----------
  function layout(W, H) {
    const narrow = W < 560;
    const padL = narrow ? 26 : 70, padR = narrow ? 30 : 84;
    const hm = clamp(H * 0.27, 96, 160);
    const He = H - hm;
    const sx = geo && drag?.kind === 'L' ? geo.sx : (W - padL - padR) / B.L;
    const topDim = 20, aDim = 42, loadTop = 62;
    const depthMM = 2 * B.c;
    const dpx = clamp(depthMM * sx, 7, 30);
    const armMax = clamp(He * 0.25, 44, 100);
    const beamY = loadTop + armMax + dpx / 2 + 8;
    const defMax = Math.max(24, Math.min(110, He - beamY - 40));
    return { W, H, narrow, padL, padR, hm, He, sx, x0: padL, topDim, aDim, loadTop, dpx, armMax, beamY, defMax, depthMM };
  }

  const yAt = (x) => {
    const c = B.curve;
    const t = (x / B.L) * (c.length - 1);
    const i = clamp(Math.floor(t), 0, c.length - 2), f = t - i;
    return c[i][1] * (1 - f) + c[i + 1][1] * f;
  };
  const armFor = (v, lo, G) => clamp(26 + 24 * Math.log10(Math.max(v, 1e-6) / lo), 20, G.armMax);

  function drawBeam() {
    const W = Math.max(280, stage.clientWidth), H = Math.max(300, stage.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!B) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--danger)">${esc((res?.warnings || ['No beam'])[0])}</text>`;
      return;
    }
    const G = layout(W, H);
    geo = G;
    const X = (x) => G.x0 + G.sx * x;
    // deflection scale: sticky, so a heavier load visibly sags more
    // (the larger of the sag and the limit fills most of the room, so the two compare at a glance)
    const yRef = Math.max(Math.abs(B.yMax), B.yAllow, 1e-12);
    if (!drag && (!kdef || kdefL !== B.L || yRef * kdef > G.defMax * 0.95 || yRef * kdef < G.defMax * 0.3)) { kdef = (G.defMax * 0.75) / yRef; kdefL = B.L; }
    const Yd = (y) => G.beamY + y * kdef;
    const o = [];
    const half = G.dpx / 2;
    const xL = X(0), xR = X(B.L);

    // limit band
    const yLim = Yd(B.yAllow);
    const over = B.yMax > B.yAllow;
    const limLabel = `limit ${B.support === 'cantilever' ? '2L' : 'L'}/${B.limit} = ${g3(B.yAllow)} mm`;
    if (yLim <= G.He - 20) {
      o.push(`<rect x="${xL}" y="${yLim + half}" width="${xR - xL}" height="${Math.max(4, Math.min(22, G.He - yLim - half))}" fill="var(--danger)" fill-opacity="${over ? 0.2 : 0.08}"/>`);
      o.push(`<line x1="${xL}" y1="${yLim + half}" x2="${xR}" y2="${yLim + half}" stroke="var(--danger)" stroke-width="1" stroke-dasharray="6 3" stroke-opacity="0.8"/>`);
      // where the beam sags least (near a support), so the bent beam does not cover it
      const lx = B.xAt > B.L * 0.5 ? xL + (xR - xL) * 0.14 : xR - (xR - xL) * 0.14;
      o.push(`<text x="${lx}" y="${yLim + half + 13}" text-anchor="${B.xAt > B.L * 0.5 ? 'start' : 'end'}" font-size="10.5" class="halo" fill="var(--danger)">${esc(limLabel)}</text>`);
    }
    const offNote = yLim > G.He - 20 ? ` · ${limLabel} is below the view` : '';

    // undeformed ghost
    o.push(`<rect x="${xL}" y="${G.beamY - half}" width="${xR - xL}" height="${G.dpx}" fill="none" stroke="var(--tool-steel)" stroke-width="1" stroke-dasharray="4 3" stroke-opacity="0.8"/>`);
    // deformed beam
    const top = [], bot = [];
    for (const [x, y] of B.curve) { top.push(`${X(x).toFixed(1)},${(Yd(y) - half).toFixed(1)}`); bot.unshift(`${X(x).toFixed(1)},${(Yd(y) + half).toFixed(1)}`); }
    o.push(`<path d="M${top.join('L')}L${bot.join('L')}Z" fill="var(--tool-beam-fill)" stroke="var(--tool-steel)" stroke-width="1.3" stroke-linejoin="round"/>`);
    o.push(`<path d="M${B.curve.map(([x, y]) => `${X(x).toFixed(1)},${Yd(y).toFixed(1)}`).join('L')}" fill="none" stroke="var(--tool-defl)" stroke-width="1.6"/>`);

    // supports
    o.push(supportAt(0, 'left', X, G));
    o.push(supportAt(B.L, 'right', X, G));

    // max deflection dimension
    const xm = X(B.xAt), ym = Yd(B.yMax);
    const dcol = over ? 'var(--danger)' : 'var(--tool-defl)';
    o.push(`<line x1="${xm}" y1="${G.beamY}" x2="${xm}" y2="${ym}" stroke="${dcol}" stroke-width="1"/>`);
    if (Math.abs(ym - G.beamY) > 12) o.push(`<path d="${arrowHead(xm, ym, Math.PI / 2, 6, 2.6)}" fill="${dcol}"/>`);
    const right = xm < W * 0.6;
    const tx = right ? xm + 8 : xm - 8, ty = Math.max(ym + half + 16, G.beamY + half + 30);
    o.push(`<text x="${tx}" y="${ty}" text-anchor="${right ? 'start' : 'end'}" font-size="13" font-weight="600" class="halo" fill="${dcol}">δ ${g3(B.yMax)} mm</text>`);
    o.push(`<text x="${tx}" y="${ty + 14}" text-anchor="${right ? 'start' : 'end'}" font-size="10.5" class="halo" fill="var(--ink-soft)">L/${B.ratio ? Math.round(B.ratio) : '–'} · at x ${g4(B.xAt)}</text>`);
    o.push(`<text x="${G.narrow ? 6 : 10}" y="${G.He - 8}" font-size="10" fill="var(--ink-soft)">deflection drawn ×${g3(kdef / G.sx)} · length to scale${B.wself ? ` · self weight ${g3(B.wself * 1000)} N/m included` : ''}${esc(offNote)}</text>`);

    // load
    o.push(B.load === 'udl' ? udlLoad(X, Yd, G) : pointLoad(X, Yd, G));

    // span dimension, knob at the far end
    const yd = G.topDim;
    o.push(`<line x1="${xL}" y1="${yd - 8}" x2="${xL}" y2="${G.beamY - half - 2}" stroke="var(--tool-dim)" stroke-width="0.6" stroke-opacity="0.5"/>`);
    o.push(`<line x1="${xR}" y1="${yd - 8}" x2="${xR}" y2="${G.beamY - half - 2}" stroke="var(--tool-dim)" stroke-width="0.6" stroke-opacity="0.5"/>`);
    o.push(`<line x1="${xL}" y1="${yd}" x2="${xR}" y2="${yd}" stroke="var(--tool-dim)" stroke-width="0.9"/><path d="${arrowHead(xL, yd, Math.PI)}${arrowHead(xR, yd, 0)}" fill="var(--tool-dim)"/>`);
    o.push(`<text x="${(xL + xR) / 2}" y="${yd - 5}" text-anchor="middle" font-size="12" font-weight="600" class="halo" fill="var(--ink)">L ${g4(B.L)} mm</text>`);
    o.push(`<g class="knob h" data-knob="L" tabindex="0" role="slider" aria-label="Span L, drag the end or use arrow keys" aria-valuenow="${B.L}" aria-valuetext="${g4(B.L)} mm">`
      + `<rect class="kf" x="${xR - 11}" y="${yd - 11}" width="22" height="22" fill="transparent" stroke="none"/>`
      + `<path class="kc" d="M${xR},${yd - 7}L${xR + 7},${yd}L${xR},${yd + 7}L${xR - 7},${yd}Z" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/><title>Drag to change the span</title></g>`);

    // moment diagram
    o.push(momentStrip(X, G));
    svg.innerHTML = o.join('');
    svg.classList.toggle('dragging', !!drag);
  }

  function supportAt(x, side, X, G) {
    const px = X(x), y = G.beamY, half = G.dpx / 2;
    const s = B.support;
    const kind = side === 'left' ? (s === 'simple' ? 'pin' : 'wall') : (s === 'simple' ? 'roller' : s === 'fixed' ? 'wall' : 'free');
    const col = 'var(--ink-soft)';
    let g = '';
    const R = side === 'left' ? B.R[0] : B.R[1];
    const M0 = side === 'left' ? B.curve[0][2] : B.curve[B.curve.length - 1][2];
    if (kind === 'pin' || kind === 'roller') {
      const t = y + half;
      g += `<path class="sk" d="M${px},${t}L${px - 9},${t + 15}L${px + 9},${t + 15}Z" fill="var(--surface)" stroke="${col}" stroke-width="1.3"/>`;
      if (kind === 'roller') g += `<circle cx="${px - 5}" cy="${t + 19}" r="3" fill="none" stroke="${col}"/><circle cx="${px + 5}" cy="${t + 19}" r="3" fill="none" stroke="${col}"/>`;
      const gy = t + (kind === 'roller' ? 23 : 16);
      g += `<line x1="${px - 14}" y1="${gy}" x2="${px + 14}" y2="${gy}" stroke="${col}"/>`;
      for (let i = -12; i <= 12; i += 6) g += `<line x1="${px + i}" y1="${gy}" x2="${px + i - 4}" y2="${gy + 5}" stroke="${col}" stroke-width="0.8"/>`;
    } else if (kind === 'wall') {
      const d = side === 'left' ? -1 : 1;
      g += `<line class="sk" x1="${px}" y1="${y - 30}" x2="${px}" y2="${y + 30}" stroke="${col}" stroke-width="2"/>`;
      for (let i = -28; i <= 24; i += 7) g += `<line x1="${px}" y1="${y + i}" x2="${px + d * 7}" y2="${y + i + 6}" stroke="${col}" stroke-width="0.9"/>`;
    } else {
      g += `<circle class="sk" cx="${px + 10}" cy="${y}" r="6" fill="none" stroke="${col}" stroke-dasharray="2 2"/>`;
    }
    // reaction
    let lab = '';
    if (kind !== 'free') {
      const ay = y + half + (kind === 'roller' ? 30 : kind === 'pin' ? 24 : 8), ay2 = ay + 22;
      const rx = kind === 'wall' ? px + (side === 'left' ? 14 : -14) : px;
      lab += `<line x1="${rx}" y1="${ay2}" x2="${rx}" y2="${ay + 2}" stroke="var(--ink)" stroke-width="1.4"/><path d="${arrowHead(rx, ay - 3, -Math.PI / 2, 7, 3)}" fill="var(--ink)"/>`;
      const anchor = side === 'left' ? 'start' : 'end';
      const tx = side === 'left' ? rx + 7 : rx - 7;
      lab += `<text x="${tx}" y="${ay + 12}" text-anchor="${anchor}" font-size="11" class="halo" fill="var(--ink)">R ${g3(R)} N</text>`;
      if (kind === 'wall') lab += `<text x="${tx}" y="${ay + 25}" text-anchor="${anchor}" font-size="10" class="halo" fill="var(--ink-soft)">M ${g3(Math.abs(M0) / 1000)} N m</text>`;
    }
    const next = { simple: 'cantilever', cantilever: 'fixed', fixed: 'simple' }[s];
    const label = `${side === 'left' ? 'Left' : 'Right'} end: ${kind === 'free' ? 'free' : kind === 'wall' ? 'fixed' : kind === 'pin' ? 'pinned' : 'roller'}. Click for ${SUPPORTS.find(([v]) => v === next)[1].toLowerCase()}`;
    const bx = px + (side === 'left' ? -26 : -18), by = y - 34;
    return `<g class="sup" data-sup="${side}" tabindex="0" role="button" aria-label="${esc(label)}"><rect class="kf" x="${bx}" y="${by}" width="44" height="${34 + half + 26}" fill="transparent" stroke="none" rx="4"/>${g}<title>${esc(label)}</title></g>${lab}`;
  }

  function pointLoad(X, Yd, G) {
    const px = X(B.a);
    const tip = Yd(yAt(B.a)) - G.dpx / 2 - 1;
    const len = armFor(B.P, 10, G);
    const tail = tip - len;
    const col = 'var(--tool-load)';
    let s = `<line x1="${px}" y1="${tail}" x2="${px}" y2="${tip - 6}" stroke="${col}" stroke-width="3"/><path d="${arrowHead(px, tip, Math.PI / 2, 11, 5)}" fill="${col}"/>`;
    const right = px < G.W - 150;
    s += `<text x="${px + (right ? 12 : -12)}" y="${tail + 5}" text-anchor="${right ? 'start' : 'end'}" font-size="13" font-weight="600" class="halo" fill="${col}">P ${g4(B.P)} N</text>`;
    // a dimension
    const y = G.aDim, xL = X(0);
    s += `<line x1="${xL}" y1="${y}" x2="${px}" y2="${y}" stroke="var(--tool-dim)" stroke-width="0.8"/>`;
    if (px - xL > 16) s += `<path d="${arrowHead(xL, y, Math.PI, 6, 2.4)}${arrowHead(px, y, 0, 6, 2.4)}" fill="var(--tool-dim)"/>`;
    s += `<line x1="${px}" y1="${y - 5}" x2="${px}" y2="${tail - 8}" stroke="var(--tool-dim)" stroke-width="0.6" stroke-opacity="0.6"/>`;
    s += `<text x="${(xL + px) / 2}" y="${y - 4}" text-anchor="middle" font-size="10.5" class="halo" fill="var(--ink-soft)">a ${g4(B.a)}</text>`;
    // knobs: the head moves along (a), the tail sets the force
    s += `<g class="knob h" data-knob="a" tabindex="0" role="slider" aria-label="Load position a, drag along the beam or use arrow keys" aria-valuenow="${B.a}" aria-valuetext="${g4(B.a)} mm">`
      + `<rect class="kf" x="${px - 12}" y="${tip - 22}" width="24" height="24" fill="transparent" stroke="none"/>`
      + `<circle class="kc" cx="${px}" cy="${tip - 13}" r="5" fill="var(--surface)" stroke="${col}" stroke-width="2"/><path d="M${px - 9},${tip - 13}h-4M${px + 9},${tip - 13}h4" stroke="${col}" stroke-width="1.4"/><title>Drag along the beam to move the load</title></g>`;
    s += `<g class="knob v" data-knob="P" tabindex="0" role="slider" aria-label="Point load P, drag up for more or use arrow keys" aria-valuenow="${B.P}" aria-valuetext="${g4(B.P)} N">`
      + `<rect class="kf" x="${px - 12}" y="${tail - 12}" width="24" height="24" fill="transparent" stroke="none"/>`
      + `<circle class="kc" cx="${px}" cy="${tail}" r="7" fill="${col}" stroke="var(--surface)" stroke-width="1.5"/><path d="M${px},${tail - 3.5}v7M${px - 3.5},${tail}h7" stroke="var(--surface)" stroke-width="1.4"/><title>Drag up for a larger load, down for a smaller one</title></g>`;
    return s;
  }

  function udlLoad(X, Yd, G) {
    const col = 'var(--tool-load)';
    const len = armFor(B.w, 0.01, G);
    const n = Math.max(6, Math.round((X(B.L) - X(0)) / 34));
    const tips = [];
    for (let i = 0; i <= n; i++) { const x = (B.L * i) / n; tips.push([X(x), Yd(yAt(x)) - G.dpx / 2 - 1]); }
    const topY = Math.min(...tips.map((t) => t[1])) - len; // the load line stays straight: the arrows reach down to the bent beam
    let s = '';
    for (const [x, tip] of tips) s += `<line x1="${x}" y1="${topY}" x2="${x}" y2="${tip - 5}" stroke="${col}" stroke-width="1.3"/><path d="${arrowHead(x, tip, Math.PI / 2, 7, 3)}" fill="${col}"/>`;
    s += `<line x1="${X(0)}" y1="${topY}" x2="${X(B.L)}" y2="${topY}" stroke="${col}" stroke-width="2"/>`;
    const mx = X(B.L / 2);
    s += `<text x="${mx + 14}" y="${topY - 7}" font-size="13" font-weight="600" class="halo" fill="${col}">w ${g4(B.w)} N/mm<tspan font-size="10" font-weight="400" fill="var(--ink-soft)"> · ${g3(B.w * B.L)} N total</tspan></text>`;
    s += `<g class="knob v" data-knob="w" tabindex="0" role="slider" aria-label="Uniform load w, drag up for more or use arrow keys" aria-valuenow="${B.w}" aria-valuetext="${g4(B.w)} N/mm">`
      + `<rect class="kf" x="${mx - 12}" y="${topY - 12}" width="24" height="24" fill="transparent" stroke="none"/>`
      + `<circle class="kc" cx="${mx}" cy="${topY}" r="7" fill="${col}" stroke="var(--surface)" stroke-width="1.5"/><path d="M${mx},${topY - 3.5}v7M${mx - 3.5},${topY}h7" stroke="var(--surface)" stroke-width="1.4"/><title>Drag up for a larger load</title></g>`;
    return s;
  }

  function momentStrip(X, G) {
    const y0 = G.He + 6, h = G.hm - 12;
    const Ms = B.curve.map((c) => c[2]);
    const mx = Math.max(...Ms.map(Math.abs), 1e-9);
    const hasNeg = Ms.some((m) => m < -mx * 1e-6), hasPos = Ms.some((m) => m > mx * 1e-6);
    const base = hasNeg && hasPos ? y0 + h * 0.48 : hasNeg ? y0 + h - 8 : y0 + 16;
    const k = (hasNeg && hasPos ? h * 0.3 : h - 52) / mx;
    const Ym = (m) => base + m * k; // sagging drawn below the axis (tension side)
    const col = 'var(--tool-mom)';
    let s = `<line x1="0" y1="${G.He}" x2="${G.W}" y2="${G.He}" stroke="var(--line-soft)"/>`;
    s += `<text x="${G.W - (G.narrow ? 6 : 10)}" y="${y0 + 11}" text-anchor="end" font-size="10.5" fill="var(--ink-soft)">bending moment M${hasNeg && hasPos ? ' · sagging below the axis' : hasNeg ? ' · hogging' : ''}</text>`;
    const pts = B.curve.map(([x, , m]) => `${X(x).toFixed(1)},${Ym(m).toFixed(1)}`);
    s += `<path d="M${X(0)},${base}L${pts.join('L')}L${X(B.L)},${base}Z" fill="${col}" fill-opacity="0.18" stroke="none"/>`;
    s += `<path d="M${pts.join('L')}" fill="none" stroke="${col}" stroke-width="1.6"/>`;
    s += `<line x1="${X(0)}" y1="${base}" x2="${X(B.L)}" y2="${base}" stroke="var(--ink-soft)" stroke-width="0.8"/>`;
    const xm = X(B.xM), ym = Ym(B.mMax);
    s += `<circle cx="${xm}" cy="${ym}" r="3.2" fill="${col}"/>`;
    // sagging peak: label under it; hogging peak (drawn up): label beside it, inside the fill
    let tyy, txx, anchor = 'middle';
    if (B.mMax > 0) { tyy = ym + 15; txx = clamp(xm, 90, G.W - 90); } // sagging peak: under it
    else if (hasPos) { tyy = base + 18; txx = clamp(xm, 90, G.W - 90); } // hogging peak of a mixed diagram: across the axis, where it is empty
    else { tyy = ym - 20; txx = xm < G.W / 2 ? xm + 4 : xm - 4; anchor = xm < G.W / 2 ? 'start' : 'end'; } // all hogging: above the peak
    const sfTone = B.sf == null ? 'var(--ink-soft)' : B.sf < 1 ? 'var(--danger)' : B.sf < 1.5 ? 'var(--warn)' : 'var(--ok)';
    s += `<text x="${txx}" y="${tyy}" text-anchor="${anchor}" font-size="12" font-weight="600" class="halo" fill="${col}">M ${g3(Math.abs(B.mMax) / 1000)} N m${B.mMax < 0 ? ' hogging' : ''}</text>`;
    s += `<text x="${txx}" y="${tyy + 13}" text-anchor="${anchor}" font-size="10.5" class="halo" fill="${sfTone}">σ ${g3(B.sigma)} MPa${B.sf != null ? ` · SF ${g3(B.sf)}` : ''}</text>`;
    return s;
  }

  // ---------- the section ----------
  function drawSection() {
    const W = Math.max(200, ssvg.parentElement.clientWidth), H = Math.max(140, ssvg.parentElement.clientHeight);
    ssvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const inp = ctx.input;
    const sec = SEC_KEYS[inp.sec] ? inp.sec : 'rect';
    secI.textContent = B ? `I ${g3(B.I)} mm⁴` : '';
    if (!B) { ssvg.innerHTML = ''; return; }
    ssvg.setAttribute('aria-label', `${B.section}: I ${g3(B.I)} mm⁴, bending stress ${g3(B.sigma)} MPa`);
    const o = [];
    const boxW = Math.min(W * 0.55, 190), cx = 16 + boxW / 2, cy = H / 2;
    let wmm, hmm;
    if (sec === 'rect' || sec === 'rhs') { wmm = inp.b; hmm = inp.h; } else if (sec === 'custom') { wmm = 2 * B.c * 0.5; hmm = 2 * B.c; } else { wmm = inp.d; hmm = inp.d; }
    const s = secFrozen || Math.min((boxW - 40) / wmm, (H - 44) / hmm);
    secV = { s, cx, cy };
    const fill = 'var(--tool-beam-fill)', st = 'var(--tool-steel)';
    const hw = (wmm * s) / 2, hh = (hmm * s) / 2;
    const knob = (k, x, y, dir, label, val) => `<g class="knob ${dir}" data-knob="${k}" tabindex="0" role="slider" aria-label="${esc(label)}" aria-valuenow="${val}">`
      + `<rect class="kf" x="${x - 10}" y="${y - 10}" width="20" height="20" fill="transparent" stroke="none"/>`
      + `<rect class="kc" x="${x - 4.5}" y="${y - 4.5}" width="9" height="9" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.2" transform="rotate(45 ${x} ${y})"/></g>`;
    const dimH = (x, y1, y2, t) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="var(--tool-dim)" stroke-width="0.8"/><path d="${arrowHead(x, y1, -Math.PI / 2, 5, 2)}${arrowHead(x, y2, Math.PI / 2, 5, 2)}" fill="var(--tool-dim)"/><text transform="translate(${x - 4},${(y1 + y2) / 2}) rotate(-90)" text-anchor="middle" font-size="10" class="halo" fill="var(--ink)">${esc(t)}</text>`;
    const dimW = (y, x1, x2, t) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--tool-dim)" stroke-width="0.8"/><path d="${arrowHead(x1, y, Math.PI, 5, 2)}${arrowHead(x2, y, 0, 5, 2)}" fill="var(--tool-dim)"/><text x="${(x1 + x2) / 2}" y="${y + 12}" text-anchor="middle" font-size="10" class="halo" fill="var(--ink)">${esc(t)}</text>`;
    if (sec === 'rect' || sec === 'rhs') {
      o.push(`<rect x="${cx - hw}" y="${cy - hh}" width="${2 * hw}" height="${2 * hh}" fill="${fill}" stroke="${st}" stroke-width="1.3"/>`);
      if (sec === 'rhs') { const t = inp.t * s; o.push(`<rect x="${cx - hw + t}" y="${cy - hh + t}" width="${Math.max(0, 2 * hw - 2 * t)}" height="${Math.max(0, 2 * hh - 2 * t)}" fill="var(--surface)" stroke="${st}" stroke-width="1"/>`); }
      o.push(dimH(cx - hw - 12, cy - hh, cy + hh, `h ${g4(inp.h)}`));
      o.push(dimW(cy + hh + 10, cx - hw, cx + hw, `b ${g4(inp.b)}`));
      o.push(knob('h', cx, cy - hh, 'v', 'Section height h, drag or use arrow keys', inp.h));
      o.push(knob('b', cx + hw, cy, 'h', 'Section width b, drag or use arrow keys', inp.b));
      if (sec === 'rhs') { o.push(knob('t', cx, cy - hh + inp.t * s, 'v', 'Wall thickness t, drag or use arrow keys', inp.t)); o.push(`<text x="${cx + 8}" y="${cy - hh + inp.t * s + 13}" font-size="10" class="halo" fill="var(--ink-soft)">t ${g3(inp.t)}</text>`); }
    } else if (sec === 'round' || sec === 'tube') {
      o.push(`<circle cx="${cx}" cy="${cy}" r="${hw}" fill="${fill}" stroke="${st}" stroke-width="1.3"/>`);
      if (sec === 'tube') o.push(`<circle cx="${cx}" cy="${cy}" r="${Math.max(0, hw - inp.t * s)}" fill="var(--surface)" stroke="${st}" stroke-width="1"/>`);
      o.push(dimH(cx - hw - 12, cy - hh, cy + hh, `Ø ${g4(inp.d)}`));
      o.push(knob('d', cx + hw, cy, 'h', 'Outside diameter d, drag or use arrow keys', inp.d));
      if (sec === 'tube') { o.push(knob('t', cx, cy - hh + inp.t * s, 'v', 'Wall thickness t, drag or use arrow keys', inp.t)); o.push(`<text x="${cx + 8}" y="${cy - hh + inp.t * s + 13}" font-size="10" class="halo" fill="var(--ink-soft)">t ${g3(inp.t)}</text>`); }
    } else {
      o.push(`<line x1="${cx}" y1="${cy - hh}" x2="${cx}" y2="${cy + hh}" stroke="${st}" stroke-width="3"/>`);
      o.push(`<text x="${cx}" y="${cy + 4}" dx="10" font-size="10.5" fill="var(--ink-soft)">custom I</text>`);
      o.push(dimH(cx - 16, cy - hh, cy + hh, `2c ${g4(2 * B.c)}`));
    }
    // neutral axis
    o.push(`<line x1="${cx - hw - 4}" y1="${cy}" x2="${W - 10}" y2="${cy}" stroke="var(--ink-soft)" stroke-width="0.7" stroke-dasharray="7 3 2 3"/>`);
    // stress across the depth: linear, +-sigma at the extreme fibres
    const sx0 = 16 + boxW + 16, sw = W - sx0 - 30;
    if (sw > 50) {
      const top = cy - hh, botY = cy + hh;
      const ref = Math.max(B.sigma, B.fy || 0) * 1.08 || 1;
      const k = (sw / 2) / ref;
      const xc = sx0 + sw / 2;
      const sag = B.mMax >= 0; // sagging: compression on top
      const sTop = sag ? -B.sigma : B.sigma;
      const col = B.sf == null ? 'var(--tool-mom)' : B.sf < 1 ? 'var(--danger)' : B.sf < 1.5 ? 'var(--warn)' : 'var(--tool-mom)';
      o.push(`<line x1="${xc}" y1="${top - 6}" x2="${xc}" y2="${botY + 6}" stroke="var(--ink-soft)" stroke-width="0.8"/>`);
      if (B.fy) for (const sg of [-1, 1]) {
        const x = xc + sg * B.fy * k;
        o.push(`<line x1="${x}" y1="${top - 4}" x2="${x}" y2="${botY + 4}" stroke="var(--danger)" stroke-width="1" stroke-dasharray="4 3"/>`);
      }
      if (B.fy) o.push(`<text x="${xc + B.fy * k}" y="${top - 8}" text-anchor="middle" font-size="9.5" class="halo" fill="var(--danger)">fy ${g3(B.fy)}</text>`);
      o.push(`<path d="M${xc},${top}L${xc + sTop * k},${top}L${xc - sTop * k},${botY}L${xc},${botY}Z" fill="${col}" fill-opacity="0.22" stroke="${col}" stroke-width="1.3"/>`);
      o.push(`<text x="${xc + sTop * k + (sTop < 0 ? -3 : 3)}" y="${top + 11}" text-anchor="${sTop < 0 ? 'end' : 'start'}" font-size="10" class="halo" fill="${col}">${sTop < 0 ? 'C' : 'T'} ${g3(B.sigma)}</text>`);
      o.push(`<text x="${xc - sTop * k + (sTop < 0 ? 3 : -3)}" y="${botY - 4}" text-anchor="${sTop < 0 ? 'start' : 'end'}" font-size="10" class="halo" fill="${col}">${sTop < 0 ? 'T' : 'C'} ${g3(B.sigma)}</text>`);
      o.push(`<text x="${xc}" y="${H - 6}" text-anchor="middle" font-size="10.5" class="halo" fill="${col}">σ MPa${B.sf != null ? ` · SF ${g3(B.sf)}` : ''}</text>`);
    }
    ssvg.innerHTML = o.join('');
  }

  function drawMsgs() {
    const w = res?.warnings || [];
    const tone = (t) => (/over the yield|impossible|thicker|too thick/i.test(t) ? 'bad' : '');
    msgs.replaceChildren(...(w.length ? w.map((t) => el('div', { class: tone(t) }, t))
      : B ? [el('div', { class: 'ok' }, `Within L/${B.limit} and ${B.sf != null ? `safety factor ${g3(B.sf)} on yield` : 'no yield given'}. ${B.material}, ${B.section}.`)] : []));
  }

  function drawHint() {
    hint.textContent = 'Drag the load, its ⊕ tail for force, the ◆ for span · click a support · arrow keys work';
  }

  // ---------- interaction ----------
  const ptIn = (s, e) => { const r = s.getBoundingClientRect(), vb = s.viewBox.baseVal; return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)]; };
  const aStep = () => niceStep(B.L / 100);
  const aClamp = (v) => (B.support === 'cantilever' ? clamp(v, aStep(), B.L) : clamp(v, aStep(), B.L - aStep()));
  const dimSnap = (v) => { const st = v < 5 ? 0.1 : v < 40 ? 0.5 : v < 200 ? 1 : 5; return Number((Math.round(v / st) * st).toPrecision(6)); };

  function step(k, dir, big) {
    if (!B) return;
    const inp = ctx.input;
    if (k === 'a') ctx.set('a', String(aClamp(Math.round((B.a + dir * aStep() * (big ? 10 : 1)) / aStep()) * aStep())));
    else if (k === 'P' || k === 'w') { let v = B[k]; for (let i = 0; i < (big ? 3 : 1); i++) v = ladderStep(v, dir); ctx.set(k, String(v)); }
    else if (k === 'L') { const st = niceStep(B.L / 20); ctx.set('L', String(Math.max(st, Math.round((B.L + dir * st * (big ? 5 : 1)) / st) * st))); }
    else if (['b', 'h', 'd', 't'].includes(k)) {
      const v = inp[k] || 1; const st = v < 5 ? 0.1 : v < 40 ? 0.5 : v < 200 ? 1 : 5;
      ctx.set(k, String(dimSnap(Math.max(st, v + dir * st * (big ? 10 : 1)))));
    }
  }
  const cycleSupport = () => ctx.set('support', { simple: 'cantilever', cantilever: 'fixed', fixed: 'simple' }[B?.support || 'simple']);

  for (const s of [svg, ssvg]) {
    s.addEventListener('keydown', (e) => {
      const sup = e.target.closest?.('.sup');
      if (sup && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); const side = sup.dataset.sup; cycleSupport(); requestAnimationFrame(() => svg.querySelector(`[data-sup="${side}"]`)?.focus()); return; }
      const k = e.target.closest?.('.knob')?.dataset.knob;
      if (!k) return;
      let dir = 0;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') dir = 1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') dir = -1;
      if (!dir) return;
      e.preventDefault();
      step(k, dir, e.shiftKey);
      requestAnimationFrame(() => s.querySelector(`[data-knob="${k}"]`)?.focus());
    });
    s.addEventListener('pointerdown', (e) => {
      if (!B) return;
      const sup = e.target.closest('.sup');
      if (sup && s === svg) { e.preventDefault(); cycleSupport(); return; }
      const knob = e.target.closest('.knob');
      if (!knob) return;
      e.preventDefault();
      const k = knob.dataset.knob;
      const inp = ctx.input;
      drag = { k, s, p0: ptIn(s, e), a0: B.a, P0: B.P, w0: B.w, L0: B.L, v0: inp[k] };
      if (s === ssvg) secFrozen = secV.s;
      knob.focus({ preventScroll: true });
      s.classList.add('dragging');
      try { s.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    });
    s.addEventListener('pointermove', (e) => {
      if (!drag || drag.s !== s) return;
      const p = ptIn(s, e);
      const dx = p[0] - drag.p0[0], dy = p[1] - drag.p0[1];
      const k = drag.k;
      let v = null;
      if (k === 'a') v = aClamp(Math.round((drag.a0 + dx / geo.sx) / aStep()) * aStep());
      else if (k === 'P') v = ladderSnap(drag.P0 * 10 ** (-dy / 90));
      else if (k === 'w') v = ladderSnap(drag.w0 * 10 ** (-dy / 90));
      else if (k === 'L') { const st = niceStep(drag.L0 / 50); v = Math.max(st, Math.round((drag.L0 + dx / geo.sx) / st) * st); }
      else if (k === 'b' || k === 'd') v = dimSnap(Math.max(0.5, drag.v0 + (2 * dx) / secFrozen));
      else if (k === 'h') v = dimSnap(Math.max(0.5, drag.v0 - (2 * dy) / secFrozen));
      else if (k === 't') v = dimSnap(Math.max(0.1, drag.v0 + dy / secFrozen));
      if (v != null && String(v) !== String(ctx.raw[k])) ctx.set(k, String(v));
    });
    const end = () => {
      if (!drag || drag.s !== s) return;
      const k = drag.k;
      drag = null; secFrozen = null;
      s.classList.remove('dragging');
      drawBeam(); drawSection();
      requestAnimationFrame(() => s.querySelector(`[data-knob="${k}"]`)?.focus({ preventScroll: true }));
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('lostpointercapture', end);
  }

  ctx.onResult((r) => {
    res = r;
    B = r.beam || null;
    syncControls();
    drawBeam();
    drawSection();
    drawMsgs();
  });
  drawHint();
  new ResizeObserver(() => { if (!drag) { drawBeam(); drawSection(); } }).observe(stage);
}
