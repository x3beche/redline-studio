// Belt & Pulley page: the drive itself, to scale. Drag the driven pulley to
// set the centre distance, drag a pulley's rim knob for more or fewer teeth
// (or a larger diameter), and watch the belt run. Under it the belt is
// unrolled as a tape: every whole-tooth closed belt near this layout is a
// place to click, and the drive moves to the centre distance that belt needs.
// Every number drawn comes from run()'s result.drive.

import { PROFILES } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const KINDS = ['gt2', 'gt3', 'htd3', 'htd5', 'htd8', 'mxl', 'xl', 'l', 'diameter'];
const SHAPE = { gt2: 'round', gt3: 'round', htd3: 'round', htd5: 'round', htd8: 'round', mxl: 'trap', xl: 'trap', l: 'trap', diameter: 'v' };

const CSS = `
:root { --tool-p1: #1f4ed8; --tool-p2: #0f8a78; --tool-belt: #4a5663; --tool-wrap: #c26a00; --tool-dim: #5b6b7a;
  --tool-pfill: color-mix(in srgb, #8795a3 22%, var(--surface)); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-p1: #7d9bff; --tool-p2: #3cc7b3; --tool-belt: #aab6c2; --tool-wrap: #f0a33a; --tool-dim: #8ea0b0;
  --tool-pfill: color-mix(in srgb, #7a8997 24%, var(--surface)); } }
:root[data-theme="dark"] { --tool-p1: #7d9bff; --tool-p2: #3cc7b3; --tool-belt: #aab6c2; --tool-wrap: #f0a33a; --tool-dim: #8ea0b0;
  --tool-pfill: color-mix(in srgb, #7a8997 24%, var(--surface)); }
.k-page { padding: 10px 12px 12px; }
.bp { display: grid; gap: 10px; height: calc(100vh - 64px); min-height: 660px;
  grid-template-columns: minmax(0, 1fr) 360px; grid-template-rows: auto minmax(300px, 1fr) 132px;
  grid-template-areas: "strip strip" "stage side" "tape side"; }
.bp-strip { grid-area: strip; display: flex; gap: 6px 12px; align-items: center; flex-wrap: wrap; min-width: 0; }
.bp-profs { display: flex; gap: 6px; min-width: 0; max-width: 100%; overflow-x: auto; scrollbar-width: thin; }
.bp-prof { flex: none; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 4px 8px 4px 6px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--surface); cursor: pointer; color: var(--ink-soft); min-width: 0; }
.bp-prof svg { width: 78px; height: 18px; display: block; }
.bp-prof b { font: 600 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.bp-prof span { font-size: 10px; }
.bp-prof[aria-checked="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.bp-prof:hover { border-color: var(--ink-soft); }
.bp-fields { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.bp-fld { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.bp-fld input { width: 60px; padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.bp-fld input.bad { border-color: var(--danger); }
.bp-btn { padding: 3px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 12px; }
.bp-btn.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.bp-stage { grid-area: stage; position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; min-height: 0; overflow: hidden; }
.bp-stage svg, .bp-tape svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.bp-hud { position: absolute; left: 10px; top: 8px; display: flex; gap: 18px; pointer-events: none; }
.bp-hud div { display: flex; flex-direction: column; }
.bp-hud span { font-size: 10.5px; color: var(--ink-soft); }
.bp-hud b { font: 600 16px "IBM Plex Mono", ui-monospace, monospace; }
.bp-hud b small { font-size: 11px; font-weight: 400; color: var(--ink-soft); }
.bp-play { position: absolute; right: 10px; top: 8px; }
.bp-hint { position: absolute; right: 10px; top: 40px; max-width: 300px; font-size: 11px; color: var(--ink-soft); pointer-events: none; text-align: right; }
.bp-tape { grid-area: tape; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; display: flex; flex-direction: column; }
.bp-tape h2 { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--ink-soft); padding: 6px 10px 0; display: flex; gap: 10px; }
.bp-tape h2 b { font-weight: 500; color: var(--ink); }
.bp-tape .tp { flex: 1; min-height: 0; }
.bp-side { grid-area: side; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.bp-side .k-outwrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.bp-side .k-out { flex: 1; max-height: none; min-height: 0; }
.bp-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.bp-msgs div { padding: 4px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.bp-msgs div.ok { border-left-color: var(--ok); color: var(--ink-soft); }
.bp svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.bp .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.bp .knob { cursor: grab; outline: none; }
.bp .knob:focus-visible .kc { stroke: var(--accent); stroke-width: 3px; }
.bp .knob:focus-visible .kf { stroke: var(--accent); stroke-width: 1.5px; stroke-dasharray: 3 2; }
.bp .body2 { cursor: ew-resize; }
.bp .belt { cursor: pointer; outline: none; }
.bp .belt:hover .bk, .bp .belt:focus-visible .bk { stroke: var(--accent); stroke-width: 1.5px; }
.bp .dragging, .bp .dragging * { cursor: grabbing !important; }
@media (max-width: 980px) {
  .bp { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 400px 132px auto; height: auto; min-height: 0;
    grid-template-areas: "strip" "stage" "tape" "side"; }
  .bp-side .k-out { max-height: 280px; }
  .bp-fields { margin-left: 0; }
}
@media (max-width: 560px) { .bp-hint { display: none; } .bp-hud { gap: 10px; } .bp-hud b { font-size: 13px; } .bp-prof svg { width: 56px; } }
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
const g4 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(4))));
const g5 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(5))));
// Belt teeth: whole numbers plain; a near miss keeps enough digits to show it is one.
const teethTxt = (t) => (Math.abs(t - Math.round(t)) < 1e-6 ? String(Math.round(t)) : Math.abs(t - Math.round(t)) < 0.005 ? t.toFixed(3) : g5(t));
const f2 = (v) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(2));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const arrowHead = (x, y, ang, L = 7, w = 2.8) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return `M${x},${y}L${x - L * c + w * s},${y - L * s - w * c}L${x - L * c - w * s},${y - L * s + w * c}Z`;
};

/** A few teeth of the belt, side on, at 6 px/mm - every swatch at the same scale. */
function swatch(kind) {
  const k = 6, H = 18;
  if (SHAPE[kind] === 'v') return `<svg viewBox="0 0 78 ${H}"><path d="M20,2H58L50,16H28Z" fill="currentColor" fill-opacity=".35" stroke="currentColor"/></svg>`;
  const p = PROFILES[kind].p * k;
  let d = `M0,2H78V8`;
  const teeth = [];
  for (let x = 78 - p / 2; x > -p; x -= p) teeth.push(x);
  for (const x of teeth) {
    const w = p * 0.5, h = Math.min(7, p * 0.38);
    if (SHAPE[kind] === 'round') d += `L${x + w / 2},8A${w / 2},${h} 0 0,1 ${x - w / 2},8`;
    else d += `L${x + w / 2},8L${x + w / 2 - h * 0.45},${8 + h}L${x - w / 2 + h * 0.45},${8 + h}L${x - w / 2},8`;
  }
  d += 'L0,8Z';
  return `<svg viewBox="0 0 78 ${H}"><defs><clipPath id="sw-${kind}"><rect width="78" height="${H}"/></clipPath></defs><path clip-path="url(#sw-${kind})" d="${d}" fill="currentColor" fill-opacity=".35" stroke="currentColor" stroke-width=".8"/></svg>`;
}

export function page(root, ctx) {
  document.head.append(el('style', { text: CSS }));
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let playing = !(reduced && reduced.matches);
  let Dv = null, res = null, drag = null, V = null, theta = 0, lastT = 0;

  // ---------- profile strip ----------
  const profs = el('div', { class: 'bp-profs', role: 'radiogroup', 'aria-label': 'Belt' });
  const zfA = el('input', { inputmode: 'decimal', spellcheck: 'false' });
  const zfB = el('input', { inputmode: 'decimal', spellcheck: 'false' });
  const lblA = el('span'), lblB = el('span'), unitA = el('span'), unitB = el('span');
  const cIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Centre distance C, mm' });
  const rpmIn = el('input', { inputmode: 'decimal', spellcheck: 'false', placeholder: '–', 'aria-label': 'Driver speed, rpm' });
  const fields = el('div', { class: 'bp-fields' },
    el('label', { class: 'bp-fld' }, lblA, zfA, unitA), el('label', { class: 'bp-fld' }, lblB, zfB, unitB),
    el('label', { class: 'bp-fld' }, 'C', cIn, 'mm'), el('label', { class: 'bp-fld' }, 'driver', rpmIn, 'rpm'));
  const strip = el('div', { class: 'bp-strip' }, profs, fields);
  const timing = () => ctx.raw.kind !== 'diameter';
  zfA.addEventListener('change', () => ctx.set(timing() ? 'z1' : 'd1', zfA.value.trim()));
  zfB.addEventListener('change', () => ctx.set(timing() ? 'z2' : 'd2', zfB.value.trim()));
  cIn.addEventListener('change', () => ctx.setMany({ mode: 'length', C: cIn.value.trim() }));
  rpmIn.addEventListener('change', () => ctx.set('rpm', rpmIn.value.trim()));

  // ---------- stage ----------
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('role', 'group');
  const hud = el('div', { class: 'bp-hud' });
  const playBtn = el('button', { class: 'bp-btn bp-play', onclick: () => setPlaying(!playing) });
  const hint = el('div', { class: 'bp-hint' }, 'Drag the driven pulley for the centre distance, a + knob for teeth. Arrow keys on a focused knob.');
  const stage = el('section', { class: 'bp-stage' }, svg, hud, playBtn, hint);

  // ---------- tape ----------
  const tsvg = document.createElementNS(NS, 'svg');
  tsvg.setAttribute('role', 'group');
  const tapeHead = el('h2');
  const tape = el('section', { class: 'bp-tape' }, tapeHead, el('div', { class: 'tp' }, tsvg));

  const msgs = el('div', { class: 'bp-msgs', 'aria-live': 'polite' });
  const side = el('aside', { class: 'bp-side' }, msgs, ctx.outputs);
  root.append(el('div', { class: 'bp' }, strip, stage, tape, side));

  function setPlaying(p) {
    playing = p;
    playBtn.textContent = p ? 'Pause' : 'Run';
    playBtn.classList.toggle('on', p);
    playBtn.setAttribute('aria-pressed', String(p));
    if (p) { lastT = 0; requestAnimationFrame(tick); }
  }
  reduced?.addEventListener?.('change', (e) => { if (e.matches) setPlaying(false); });
  function tick(t) {
    if (!playing) return;
    if (lastT && Dv && V && !drag) {
      const dt = Math.min(0.1, (t - lastT) / 1000);
      theta += (dt * 36) / (V.s * Dv.a / 2); // the belt runs at 36 px/s on screen
      frame();
    }
    lastT = t;
    requestAnimationFrame(tick);
  }

  function syncControls() {
    const raw = ctx.raw;
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'gt2';
    profs.replaceChildren(...KINDS.map((k) => {
      const on = k === kind;
      const b = el('button', { class: 'bp-prof', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1',
        title: k === 'diameter' ? 'Flat or V-belt: give pulley diameters' : `${PROFILES[k].name}, pitch ${PROFILES[k].p} mm`,
        onclick: () => ctx.set('kind', k),
        onkeydown: (e) => {
          const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          ctx.set('kind', KINDS[clamp(KINDS.indexOf(k) + d, 0, KINDS.length - 1)]);
          requestAnimationFrame(() => profs.querySelector('[aria-checked="true"]')?.focus());
        } });
      b.innerHTML = `${swatch(k)}<b>${k === 'diameter' ? 'Flat / V' : esc(PROFILES[k].name.replace(' (GT3)', '').replace(/ \(.*\)/, ''))}</b><span>${k === 'diameter' ? 'by diameter' : `${PROFILES[k].p} mm pitch`}</span>`;
      return b;
    }));
    const t = kind !== 'diameter';
    lblA.textContent = t ? 'z1' : 'd1'; lblB.textContent = t ? 'z2' : 'd2';
    unitA.textContent = t ? 'T' : 'mm'; unitB.textContent = t ? 'T' : 'mm';
    zfA.setAttribute('aria-label', t ? 'Driver pulley teeth' : 'Driver pulley diameter, mm');
    zfB.setAttribute('aria-label', t ? 'Driven pulley teeth' : 'Driven pulley diameter, mm');
    for (const [i, k] of [[zfA, t ? 'z1' : 'd1'], [zfB, t ? 'z2' : 'd2'], [rpmIn, 'rpm']]) {
      if (document.activeElement !== i) i.value = raw[k] ?? '';
      i.classList.toggle('bad', String(raw[k] ?? '').trim() !== '' && ctx.parseEng(raw[k]) == null);
    }
    if (document.activeElement !== cIn) cIn.value = Dv ? (raw.mode === 'centre' ? f2(Dv.c) : raw.C ?? '') : raw.C ?? '';
  }

  // ---------- the drive ----------
  // Belt loop in mm, driver at the origin, driven at (c, 0), y up. Travel:
  // top span left to right, round the driven pulley, back along the bottom.
  function loop(D) {
    const r1 = D.a / 2, r2 = D.b / 2, c = D.c;
    const sph = (r2 - r1) / c, cph = Math.sqrt(Math.max(0, 1 - sph * sph)), ph = Math.asin(sph);
    const Ls = c * cph, a0 = Math.PI / 2 + ph, s2 = Math.PI + 2 * ph, s1 = Math.PI - 2 * ph;
    const P1t = [-r1 * sph, r1 * cph], P2t = [c - r2 * sph, r2 * cph], P2b = [c - r2 * sph, -r2 * cph], P1b = [-r1 * sph, -r1 * cph];
    const segs = [Ls, r2 * s2, Ls, r1 * s1];
    const total = segs.reduce((x, y) => x + y, 0);
    const at = (u) => {
      u = ((u % total) + total) % total;
      if (u < segs[0]) { const f = u / Ls; return { p: [P1t[0] + f * (P2t[0] - P1t[0]), P1t[1] + f * (P2t[1] - P1t[1])], n: [sph, -cph] }; }
      u -= segs[0];
      if (u < segs[1]) { const a = a0 - u / r2; return { p: [c + r2 * Math.cos(a), r2 * Math.sin(a)], n: [-Math.cos(a), -Math.sin(a)] }; }
      u -= segs[1];
      if (u < segs[2]) { const f = u / Ls; return { p: [P2b[0] + f * (P1b[0] - P2b[0]), P2b[1] + f * (P1b[1] - P2b[1])], n: [sph, cph] }; }
      u -= segs[2];
      const a = -a0 - u / r1;
      return { p: [r1 * Math.cos(a), r1 * Math.sin(a)], n: [-Math.cos(a), -Math.sin(a)] };
    };
    return { at, total, r1, r2, a0, s1, s2, ph };
  }

  function fit(W, H, D) {
    const r1 = D.a / 2, r2 = D.b / 2, R = Math.max(r1, r2);
    const narrow = W < 560;
    const padX = narrow ? 24 : 120, padT = narrow ? 84 : 104, padB = narrow ? 64 : 58;
    const s = Math.max(0.02, Math.min((W - 2 * padX) / (r1 + D.c + r2), (H - padT - padB) / (2 * R)));
    const cx = (-r1 + D.c + r2) / 2;
    return { s, ox: W / 2 - s * cx, oy: padT + (H - padT - padB) / 2, narrow };
  }

  function pulleyPath(Rp, i) {
    // outline about the centre in px: grooves on a timing pulley, a plain rim otherwise
    const D = Dv, s = V.s;
    if (!D.profile) return `<circle r="${Rp + 3}" /><circle r="${Math.max(2, Rp - 5)}" fill="none" stroke-opacity="0.5"/>`;
    const z = i ? D.z2 : D.z1, ro = (D.od[i] / 2) * s, p = D.profile.p;
    const depth = Math.min(0.38 * p * s, ro * 0.14);
    if (z > 180 || (2 * Math.PI * ro) / z < 3) return `<circle r="${ro}" />`;
    const pts = [];
    const pa = 2 * Math.PI / z, gw = pa * 0.5;
    for (let k = 0; k < z; k++) {
      const c = pa * k;
      const P = (r, a) => pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
      // a rounded groove, then the land up to the next one
      for (let j = 0; j <= 6; j++) { const t = (j / 6) * Math.PI; P(ro - depth * Math.sin(t), c - (gw / 2) * Math.cos(t)); }
      P(ro, c + pa / 2);
    }
    return `<path d="M${pts.join('L')}Z" />`;
  }

  function drawDrive() {
    const W = Math.max(280, stage.clientWidth), H = Math.max(240, stage.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!Dv) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--danger)">${esc((res?.warnings || ['No drive'])[0])}</text>`;
      hud.replaceChildren();
      return;
    }
    V = drag?.frozen || fit(W, H, Dv);
    const D = Dv, s = V.s;
    const X = (x) => V.ox + s * x, Y = (y) => V.oy - s * y;
    const L = loop(D);
    const o = [];
    const overlap = D.c < D.touchC;
    const lowWrap = D.wrap < 120, lowMesh = D.mesh != null && D.mesh < 6;
    // pulleys
    for (const i of [0, 1]) {
      const cxp = X(i ? D.c : 0), cyp = Y(0);
      const col = i ? 'var(--tool-p2)' : 'var(--tool-p1)';
      const Rp = ((i ? D.b : D.a) / 2) * s;
      const hub = Math.max(3, Math.min(Rp * 0.28, 16));
      o.push(`<g class="${i ? 'body2' : 'body1'}" ${i ? 'data-drag="C"' : ''}><g transform="translate(${cxp.toFixed(2)},${cyp.toFixed(2)})"><g class="rot${i}" fill="var(--tool-pfill)" stroke="${overlap ? 'var(--danger)' : col}" stroke-width="1.3" stroke-linejoin="round">${pulleyPath(Rp, i)}`
        + `<circle r="${hub}" fill="var(--surface)"/><line x1="${hub}" y1="0" x2="${Math.max(hub + 3, Rp * 0.72)}" y2="0" stroke-opacity="0.7"/></g></g>`
        + `<circle cx="${cxp}" cy="${cyp}" r="${Rp}" fill="none" stroke="var(--ink-soft)" stroke-width="0.8" stroke-dasharray="7 3 2 3"/></g>`);
    }
    // wrap on the small pulley
    const sm = D.small - 1;
    {
      const r = (sm ? L.r2 : L.r1) * s + 5;
      const a0 = sm ? L.a0 : -L.a0, span = sm ? L.s2 : L.s1;
      const cxp = X(sm ? D.c : 0), cyp = Y(0);
      const pt = (a) => [cxp + r * Math.cos(a), cyp - r * Math.sin(a)];
      const [x0, y0] = pt(a0), [x1, y1] = pt(a0 - span);
      const col = lowWrap || lowMesh ? 'var(--danger)' : 'var(--tool-wrap)';
      o.push(`<path d="M${x0},${y0}A${r},${r} 0 ${span > Math.PI ? 1 : 0},1 ${x1},${y1}" fill="none" stroke="${col}" stroke-width="4" stroke-opacity="0.55"/>`);
      const mid = a0 - span / 2;
      const lr = r + 14;
      let lx = cxp + lr * Math.cos(mid), ly = cyp - lr * Math.sin(mid);
      let anchor = Math.cos(mid) > 0.3 ? 'start' : Math.cos(mid) < -0.3 ? 'end' : 'middle';
      if (V.narrow) { anchor = 'middle'; lx = clamp(cxp, 60, W - 60); ly = cyp + ((sm ? L.r2 : L.r1) * s) + 38; } // narrow: under the pulley's name
      else if ((anchor === 'end' && lx < 130) || (anchor === 'start' && lx > W - 130)) { anchor = 'middle'; lx = clamp(cxp, 70, W - 70); ly = cyp + ((sm ? L.r2 : L.r1) * s) + 52; } // no room beside it: under the pulley's name
      o.push(`<text x="${lx}" y="${ly - 2}" text-anchor="${anchor}" font-size="12" font-weight="600" class="halo" fill="${col}">wrap ${g4(D.wrap)}°</text>`);
      if (D.mesh != null) o.push(`<text x="${lx}" y="${ly + 12}" text-anchor="${anchor}" font-size="10.5" class="halo" fill="${lowMesh ? 'var(--danger)' : 'var(--ink-soft)'}">${g4(D.mesh)} teeth in mesh${lowMesh ? ' < 6' : ''}</text>`);
    }
    // the belt: a band on the pitch line, its teeth on the inside
    const n = 240, pts = [];
    for (let k = 0; k <= n; k++) { const q = L.at((L.total * k) / n).p; pts.push(`${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`); }
    const bw = clamp((D.profile ? D.profile.p * 0.7 : 0.08 * Math.min(D.a, D.b)) * s, 3, 9);
    o.push(`<path d="M${pts.join('L')}Z" fill="none" stroke="var(--tool-belt)" stroke-width="${bw}" stroke-linejoin="round" stroke-opacity="0.9"/>`);
    o.push('<g class="bteeth"></g>');
    // centre marks
    for (const i of [0, 1]) { const x = X(i ? D.c : 0), y = Y(0); o.push(`<path d="M${x - 6},${y}h12M${x},${y - 6}v12" stroke="var(--ink)" stroke-width="1"/>`); }
    // pulley labels
    for (const i of [0, 1]) {
      const R = ((i ? D.b : D.a) / 2) * s;
      const y = Y(0) + R + 22;
      const col = i ? 'var(--tool-p2)' : 'var(--tool-p1)';
      const name = D.profile ? `${i ? D.z2 : D.z1}T` : `Ø${g4(i ? D.b : D.a)}`;
      const sub = D.profile ? `pitch Ø${f2(i ? D.b : D.a)} · OD ${f2(D.od[i])}` : 'pitch Ø';
      const sp = i ? D.n2 : D.rpm;
      const main = `${i ? 'driven' : 'driver'} ${name}${sp ? ` · ${g4(sp)} rpm` : ''}`;
      const hw = main.length * 3.9 + 4;
      const x = clamp(X(i ? D.c : 0), hw, W - hw);
      o.push(`<text x="${x}" y="${y}" text-anchor="middle" font-size="13" font-weight="600" class="halo" fill="${col}">${esc(main)}</text>`);
      if (!V.narrow) o.push(`<text x="${x}" y="${y + 14}" text-anchor="middle" font-size="10.5" class="halo" fill="var(--ink-soft)">${esc(sub)}</text>`);
    }
    // belt length on the top span
    const top = L.at((L.total * 0) + D.c * Math.cos(L.ph) / 2).p;
    const blab = D.profile ? `belt ${g5(D.len)} mm · ${teethTxt(D.teeth)} teeth` : `belt ${g5(D.len)} mm`;
    const whole = !D.profile || Math.abs(D.teeth - Math.round(D.teeth)) < 1e-6;
    const tilt = (Math.atan2(-(D.b - D.a) / 2, Math.sqrt(Math.max(0, D.c * D.c - ((D.b - D.a) / 2) ** 2))) * 180) / Math.PI;
    if (!V.narrow) o.push(`<text transform="translate(${X(top[0])},${Y(top[1])}) rotate(${tilt}) translate(0,${-bw / 2 - 7})" text-anchor="middle" font-size="12" font-weight="600" class="halo" fill="${whole ? 'var(--ink)' : 'var(--warn)'}">${esc(blab)}${whole ? '' : ' · not a closed belt'}</text>`);
    // centre distance: dimension above, knob at the driven end
    const R = Math.max(D.a, D.b) / 2 * s;
    const yd = Math.max(V.narrow ? 64 : 76, Y(0) - R - 38);
    const x1 = X(0), x2 = X(D.c);
    o.push(`<line x1="${x1}" y1="${yd - 6}" x2="${x1}" y2="${Y(0) - 8}" stroke="var(--tool-dim)" stroke-width="0.6" stroke-opacity="0.5"/><line x1="${x2}" y1="${yd - 6}" x2="${x2}" y2="${Y(0) - 8}" stroke="var(--tool-dim)" stroke-width="0.6" stroke-opacity="0.5"/>`);
    o.push(`<line x1="${x1}" y1="${yd}" x2="${x2}" y2="${yd}" stroke="var(--tool-dim)" stroke-width="0.9"/><path d="${arrowHead(x1, yd, Math.PI)}${arrowHead(x2, yd, 0)}" fill="var(--tool-dim)"/>`);
    o.push(`<text x="${(x1 + x2) / 2}" y="${yd - 5}" text-anchor="middle" font-size="12.5" font-weight="600" class="halo" fill="${overlap ? 'var(--danger)' : 'var(--ink)'}">C ${f2(D.c)} mm${D.mode === 'centre' ? (D.profile ? ` · for a ${Math.round(D.teeth)}T belt` : ' · for this belt') : ''}${overlap ? ' · pulleys overlap' : ''}</text>`);
    o.push(`<g class="knob" data-knob="C" tabindex="0" role="slider" aria-label="Centre distance, drag the driven pulley or use arrow keys" aria-valuenow="${D.c.toFixed(2)}" aria-valuetext="${f2(D.c)} mm">`
      + `<rect class="kf" x="${x2 - 11}" y="${yd - 11}" width="22" height="22" fill="transparent" stroke="none"/>`
      + `<path class="kc" d="M${x2},${yd - 7}L${x2 + 7},${yd}L${x2},${yd + 7}L${x2 - 7},${yd}Z" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/><title>Drag to set the centre distance</title></g>`);
    // rim knobs: teeth (or diameter)
    for (const i of [0, 1]) {
      const Rr = ((i ? D.b : D.a) / 2) * s + 12;
      const ang = (i ? 40 : 140) * Math.PI / 180;
      const kx = X(i ? D.c : 0) + Rr * Math.cos(ang), ky = Y(0) - Rr * Math.sin(ang);
      const col = i ? 'var(--tool-p2)' : 'var(--tool-p1)';
      const key = D.profile ? `z${i + 1}` : `d${i + 1}`;
      o.push(`<g class="knob" data-knob="${key}" tabindex="0" role="slider" aria-label="${i ? 'Driven' : 'Driver'} pulley ${D.profile ? 'teeth' : 'diameter'}, drag outward for more or use arrow keys" aria-valuenow="${D.profile ? (i ? D.z2 : D.z1) : g4(i ? D.b : D.a)}">`
        + `<circle class="kf" cx="${kx}" cy="${ky}" r="12" fill="transparent" stroke="none"/>`
        + `<circle class="kc" cx="${kx}" cy="${ky}" r="7" fill="var(--surface)" stroke="${col}" stroke-width="2"/><path d="M${kx - 3.2},${ky}h6.4M${kx},${ky - 3.2}v6.4" stroke="${col}" stroke-width="1.4"/><title>Drag outward for a larger pulley</title></g>`);
    }
    // direction of travel on the bottom span
    const q = L.at(L.total * 0 + D.c * Math.cos(L.ph) + L.r2 * L.s2 + D.c * Math.cos(L.ph) * 0.5);
    o.push(`<path d="${arrowHead(X(q.p[0]) - 4, Y(q.p[1]) + bw / 2 + 9, Math.PI, 8, 3.2)}" fill="var(--ink-soft)"/><line x1="${X(q.p[0]) - 4}" y1="${Y(q.p[1]) + bw / 2 + 9}" x2="${X(q.p[0]) + 18}" y2="${Y(q.p[1]) + bw / 2 + 9}" stroke="var(--ink-soft)"/>`);
    svg.innerHTML = o.join('');
    svg.setAttribute('aria-label', `Belt drive: ${D.profile ? `${D.z1} and ${D.z2} teeth` : `${g4(D.a)} and ${g4(D.b)} mm pulleys`}, centre distance ${f2(D.c)} mm, belt ${g5(D.len)} mm`);
    svg.classList.toggle('dragging', !!drag);
    V.L = L;
    frame();
    // HUD
    const box = (t, v, u) => el('div', {}, el('span', {}, t), el('b', {}, v, u ? el('small', {}, ` ${u}`) : null));
    hud.replaceChildren(
      box('ratio', `${g4(D.ratio)} : 1`, D.ratio >= 1 ? 'slower' : 'faster'),
      ...(D.v != null ? [box('belt speed', g4(D.v), 'm/s')] : []),
      V.narrow ? box('belt', g5(D.len), D.profile ? `mm · ${teethTxt(D.teeth)}T` : 'mm') : box('approx. formula', g5(D.approx), 'mm'));
  }

  function frame() {
    if (!Dv || !V?.L) return;
    const D = Dv, L = V.L, s = V.s;
    const r1 = svg.querySelector('.rot0'), r2 = svg.querySelector('.rot1');
    const deg = (theta * 180) / Math.PI;
    if (r1) r1.setAttribute('transform', `rotate(${deg})`);
    if (r2) r2.setAttribute('transform', `rotate(${(deg * D.a) / D.b})`);
    const g = svg.querySelector('.bteeth');
    if (!g) return;
    const X = (x) => V.ox + s * x, Y = (y) => V.oy - s * y;
    const u0 = (theta * D.a) / 2;
    const step = D.profile ? D.profile.p : 36 / s; // flat / V: a mark every 36 px so the running belt shows
    const N = Math.floor(L.total / step);
    if (step * s < 2.2) { g.innerHTML = ''; return; }
    const bw = clamp((D.profile ? D.profile.p * 0.7 : 0.08 * Math.min(D.a, D.b)) * s, 3, 9);
    let h = '';
    for (let k = 0; k < N; k++) {
      const { p, n } = L.at(u0 + k * step);
      const x = X(p[0]), y = Y(p[1]);
      const nx = n[0], ny = -n[1];
      if (D.profile) h += `<line x1="${(x - nx * bw * 0.1).toFixed(1)}" y1="${(y - ny * bw * 0.1).toFixed(1)}" x2="${(x + nx * (bw * 0.5 + 2)).toFixed(1)}" y2="${(y + ny * (bw * 0.5 + 2)).toFixed(1)}"/>`;
      else h += `<line x1="${(x - nx * bw * 0.3).toFixed(1)}" y1="${(y - ny * bw * 0.3).toFixed(1)}" x2="${(x + nx * bw * 0.3).toFixed(1)}" y2="${(y + ny * bw * 0.3).toFixed(1)}"/>`;
    }
    g.innerHTML = `<g stroke="var(--surface)" stroke-width="${D.profile ? Math.max(1.2, Math.min(3, step * s * 0.35)) : 1.5}" stroke-opacity="${D.profile ? 0.8 : 0.45}">${h}</g>`;
  }

  // ---------- the tape: the belt unrolled ----------
  function drawTape() {
    const W = Math.max(260, tsvg.parentElement.clientWidth), H = Math.max(70, tsvg.parentElement.clientHeight);
    tsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!Dv) { tsvg.innerHTML = ''; tapeHead.replaceChildren(); return; }
    const D = Dv;
    const o = [];
    const y0 = 16, bh = 14;
    if (D.profile) {
      tapeHead.replaceChildren('Closed belts near this layout · click one and the driven pulley moves to fit it', el('b', { style: 'margin-left:auto' }, `${D.profile.name}, ${D.profile.p} mm pitch`));
      const bl = D.belts;
      const lo = bl[0].n - 0.5, hi = bl[bl.length - 1].n + 0.5;
      const X = (t) => 12 + ((t - lo) / (hi - lo)) * (W - 24);
      // the belt strip, one tooth per unit
      o.push(`<rect x="${X(lo)}" y="${y0}" width="${X(hi) - X(lo)}" height="${bh}" fill="var(--tool-belt)" fill-opacity="0.25" stroke="var(--tool-belt)" stroke-opacity="0.6"/>`);
      const tw = (X(1) - X(0));
      for (let t = Math.ceil(lo); t <= hi; t++) o.push(`<rect x="${X(t) - tw * 0.22}" y="${y0 + bh}" width="${tw * 0.44}" height="5" rx="2" fill="var(--tool-belt)" fill-opacity="0.5"/>`);
      for (const b of bl) {
        const x = X(b.n), on = D.mode === 'centre' && Math.round(D.teeth) === b.n;
        const dc = b.c == null ? null : b.c - D.c;
        const tip = b.c == null ? `${b.n}T belt: too short for these pulleys` : `${b.n}T belt, ${g5(b.len)} mm: centre distance ${f2(b.c)} mm (${dc >= 0 ? '+' : ''}${f2(dc)})`;
        o.push(`<g class="belt" data-n="${b.n}" tabindex="0" role="button" aria-pressed="${on}" aria-label="${esc(tip)}">`
          + `<rect class="bk" x="${x - tw / 2 + 2}" y="${y0 - 10}" width="${tw - 4}" height="${H - y0 + 6}" rx="4" fill="${on ? 'var(--sunken)' : 'transparent'}" stroke="${on ? 'var(--accent)' : 'transparent'}"/>`
          + `<line x1="${x}" y1="${y0 - 4}" x2="${x}" y2="${y0 + bh + 8}" stroke="var(--ink)" stroke-width="1.4"/>`
          + `<text x="${x}" y="${y0 + bh + 22}" text-anchor="middle" font-size="12" font-weight="600" fill="${b.c == null ? 'var(--ink-soft)' : 'var(--ink)'}">${b.n}T</text>`
          + `<text x="${x}" y="${y0 + bh + 36}" text-anchor="middle" font-size="${tw < 70 ? 9.5 : 10.5}" fill="var(--ink-soft)">${b.c == null ? 'too short' : `${tw < 70 ? '' : 'C '}${f2(b.c)}`}</text>`
          + (b.c == null ? '' : `<text x="${x}" y="${y0 + bh + 49}" text-anchor="middle" font-size="10" fill="${Math.abs(dc) < 0.005 ? 'var(--ok)' : 'var(--ink-soft)'}">${Math.abs(dc) < 0.005 ? 'this one' : `${dc >= 0 ? '+' : ''}${f2(dc)}`}</text>`)
          + `<title>${esc(tip)}</title></g>`);
      }
      // where the layout is now
      const xn = X(D.teeth);
      const whole = Math.abs(D.teeth - Math.round(D.teeth)) < 1e-6;
      o.push(`<path d="M${xn - 6},${y0 - 9}h12l-6,8z" fill="${whole ? 'var(--ok)' : 'var(--warn)'}"/><line x1="${xn}" y1="${y0}" x2="${xn}" y2="${y0 + bh}" stroke="${whole ? 'var(--ok)' : 'var(--warn)'}" stroke-width="2"/>`);
      o.push(`<text x="${Math.min(W - 4, xn + 9)}" y="${y0 - 3}" text-anchor="${xn > W - 90 ? 'end' : 'start'}" font-size="10.5" class="halo" fill="${whole ? 'var(--ok)' : 'var(--warn)'}">now ${teethTxt(D.teeth)}</text>`);
    } else {
      tapeHead.replaceChildren('Belt pitch length · drag the marker to a belt you have, the driven pulley moves to fit it', el('b', { style: 'margin-left:auto' }, `${g5(D.len)} mm`));
      const span = Math.max(40, D.len * 0.12);
      const lo = D.mode === 'centre' && drag?.tape ? drag.lo : D.len - span / 2, hi = lo + span;
      V.tape = { lo, hi };
      const X = (l) => 12 + ((l - lo) / (hi - lo)) * (W - 24);
      o.push(`<rect x="${X(lo)}" y="${y0}" width="${X(hi) - X(lo)}" height="${bh}" fill="var(--tool-belt)" fill-opacity="0.25" stroke="var(--tool-belt)" stroke-opacity="0.6"/>`);
      const st = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((v) => span / v <= 14) || 500;
      for (let l = Math.ceil(lo / st) * st; l <= hi; l += st) {
        o.push(`<line x1="${X(l)}" y1="${y0 + bh}" x2="${X(l)}" y2="${y0 + bh + 6}" stroke="var(--ink-soft)"/><text x="${X(l)}" y="${y0 + bh + 18}" text-anchor="middle" font-size="10" fill="var(--ink-soft)">${l}</text>`);
      }
      const xn = X(D.len);
      o.push(`<g class="knob" data-knob="L" tabindex="0" role="slider" aria-label="Belt length, drag or use arrow keys" aria-valuenow="${D.len.toFixed(1)}" aria-valuetext="${g5(D.len)} mm">`
        + `<rect class="kf" x="${xn - 12}" y="${y0 - 12}" width="24" height="${bh + 24}" fill="transparent" stroke="none"/>`
        + `<line x1="${xn}" y1="${y0 - 4}" x2="${xn}" y2="${y0 + bh + 4}" stroke="var(--accent)" stroke-width="2.5"/><path class="kc" d="M${xn - 7},${y0 - 11}h14l-7,8z" fill="var(--accent)" stroke="var(--surface)"/></g>`);
      o.push(`<text x="${xn}" y="${y0 + bh + 34}" text-anchor="middle" font-size="11" class="halo" fill="var(--ink)">C ${f2(D.c)} mm</text>`);
    }
    tsvg.innerHTML = o.join('');
  }

  function drawMsgs() {
    const w = res?.warnings || [];
    msgs.replaceChildren(...(w.length ? w.map((t) => el('div', {}, t)) : Dv ? [el('div', { class: 'ok' }, Dv.profile ? `A closed ${Math.round(Dv.teeth)}T belt fits: ${g4(Dv.wrap)}° of wrap, ${g4(Dv.mesh)} teeth in mesh.` : `${g4(Dv.wrap)}° of wrap on the small pulley.`)] : []));
  }

  // ---------- interaction ----------
  const ptIn = (s, e) => { const r = s.getBoundingClientRect(), vb = s.viewBox.baseVal; return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)]; };
  const setC = (c) => ctx.setMany({ mode: 'length', C: String(Math.round(c * 100) / 100) });

  function step(k, dir, big) {
    if (!Dv) return;
    const raw = ctx.raw;
    if (k === 'C') setC(Math.max(Dv.minC + 0.01, Math.round((Dv.c + dir * (big ? 10 : 1)) * 100) / 100));
    else if (k === 'z1' || k === 'z2') ctx.set(k, String(Math.max(6, (num(raw[k]) || 20) + dir * (big ? 5 : 1))));
    else if (k === 'd1' || k === 'd2') ctx.set(k, String(Math.max(5, Math.round(((num(raw[k]) || 50) + dir * (big ? 10 : 1)) * 10) / 10)));
    else if (k === 'L') ctx.setMany({ mode: 'centre', L: String(Math.round(Dv.len + dir * (big ? 10 : 1))) });
  }

  for (const s of [svg, tsvg]) {
    s.addEventListener('keydown', (e) => {
      const b = e.target.closest?.('.belt');
      if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickBelt(Number(b.dataset.n)); return; }
      const k = e.target.closest?.('.knob')?.dataset.knob;
      if (!k) return;
      const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      step(k, dir, e.shiftKey);
      requestAnimationFrame(() => s.querySelector(`[data-knob="${k}"]`)?.focus());
    });
  }
  function pickBelt(n) {
    const bl = Dv?.belts?.find((b) => b.n === n);
    if (!bl || bl.c == null) return;
    ctx.setMany({ mode: 'centre', teeth: String(n), C: String(Math.round(bl.c * 100) / 100) });
    requestAnimationFrame(() => tsvg.querySelector(`[data-n="${n}"]`)?.focus({ preventScroll: true }));
  }
  tsvg.addEventListener('click', (e) => { const b = e.target.closest?.('.belt'); if (b) pickBelt(Number(b.dataset.n)); });

  svg.addEventListener('pointerdown', (e) => {
    if (!Dv) return;
    const knob = e.target.closest('.knob');
    const body = e.target.closest('.body2');
    if (!knob && !body) return;
    e.preventDefault();
    const k = knob ? knob.dataset.knob : 'C';
    const raw = ctx.raw;
    drag = { k, p0: ptIn(svg, e), c0: Dv.c, v0: num(raw[k]), frozen: { ...V } };
    (knob || svg.querySelector('[data-knob="C"]'))?.focus({ preventScroll: true });
    svg.classList.add('dragging');
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || drag.tape) return;
    const p = ptIn(svg, e);
    const s = drag.frozen.s;
    const dx = (p[0] - drag.p0[0]) / s, dy = -(p[1] - drag.p0[1]) / s;
    const k = drag.k;
    if (k === 'C') {
      const c = Math.max(Dv.minC + 0.5, drag.c0 + dx);
      const snap = Math.round(c * 2) / 2;
      if (Math.abs(snap - Dv.c) > 1e-9) setC(snap);
      return;
    }
    const i = k.endsWith('2') ? 1 : 0;
    const ang = (i ? 40 : 140) * Math.PI / 180;
    const dr = dx * Math.cos(ang) + dy * Math.sin(ang) + (i ? 0 : 0);
    if (k[0] === 'z') {
      const per = Dv.profile.p / (2 * Math.PI); // radius per tooth
      const z = clamp(Math.round(drag.v0 + dr / per), 6, 300);
      if (String(z) !== String(ctx.raw[k])) ctx.set(k, String(z));
    } else {
      const d = clamp(Math.round((drag.v0 + 2 * dr) * 2) / 2, 5, 5000);
      if (String(d) !== String(ctx.raw[k])) ctx.set(k, String(d));
    }
  });
  tsvg.addEventListener('pointerdown', (e) => {
    const knob = e.target.closest('.knob');
    if (!knob || !Dv || !V?.tape) return;
    e.preventDefault();
    drag = { tape: true, k: 'L', p0: ptIn(tsvg, e), l0: Dv.len, lo: V.tape.lo, hi: V.tape.hi };
    knob.focus({ preventScroll: true });
    try { tsvg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  });
  tsvg.addEventListener('pointermove', (e) => {
    if (!drag?.tape) return;
    const W = tsvg.viewBox.baseVal.width;
    const dl = ((ptIn(tsvg, e)[0] - drag.p0[0]) / (W - 24)) * (drag.hi - drag.lo);
    const l = Math.round(drag.l0 + dl);
    if (String(l) !== String(ctx.raw.L) || ctx.raw.mode !== 'centre') ctx.setMany({ mode: 'centre', L: String(l) });
  });
  const end = (s) => () => {
    if (!drag) return;
    const k = drag.k;
    drag = null;
    s.classList.remove('dragging');
    drawDrive(); drawTape();
    requestAnimationFrame(() => s.querySelector(`[data-knob="${k}"]`)?.focus({ preventScroll: true }));
  };
  for (const s of [svg, tsvg]) {
    s.addEventListener('pointerup', end(s));
    s.addEventListener('pointercancel', end(s));
    s.addEventListener('lostpointercapture', end(s));
  }

  ctx.onResult((r) => {
    res = r;
    Dv = r.drive || null;
    syncControls();
    drawDrive();
    drawTape();
    drawMsgs();
  });
  new ResizeObserver(() => { if (!drag) { drawDrive(); drawTape(); } }).observe(stage);
  setPlaying(playing);
}
