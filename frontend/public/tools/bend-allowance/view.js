// Sheet Metal Bend Allowance: the part itself. The formed part in section,
// to scale, where you grab a flange tip to lengthen it or swing it round to
// change the angle, and pull the inside radius; a magnified slice of the
// sheet where the neutral axis (K-factor) is a line you drag; and under both
// the flat blank, unrolled, with the bend zone and the bend line on it.
// Every number drawn comes from run()'s result (result.drawing).

const DEG = Math.PI / 180;

const CSS = `
:root { --tool-metal: #8a98a6; --tool-metal-fill: color-mix(in srgb, #8a98a6 30%, var(--surface));
  --tool-neutral: #d97706; --tool-bend: #0f9d8a; --tool-dim: #5b6b7a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-metal: #7d8d9c;
  --tool-metal-fill: color-mix(in srgb, #7d8d9c 34%, var(--surface)); --tool-neutral: #f0a33a; --tool-bend: #3cc7b3; --tool-dim: #8ea0b0; } }
:root[data-theme="dark"] { --tool-metal: #7d8d9c; --tool-metal-fill: color-mix(in srgb, #7d8d9c 34%, var(--surface));
  --tool-neutral: #f0a33a; --tool-bend: #3cc7b3; --tool-dim: #8ea0b0; }
.k-page { padding: 10px 12px; }
.ba { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 30%); grid-template-areas: "bar bar" "form slice" "flat flat" "msgs msgs" "out out"; gap: 8px; }
.ba-bar { grid-area: bar; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.ba-form { grid-area: form; } .ba-slice { grid-area: slice; } .ba-flat { grid-area: flat; } .ba-msgs { grid-area: msgs; } .ba-out { grid-area: out; }
.ba-panel { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; overflow: hidden; }
.ba-form { height: clamp(300px, calc(100vh - 390px), 700px); }
.ba-flat { height: 170px; }
.ba .kalt:focus-visible { outline: 2px solid var(--accent); }
.ba-panel svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.ba-cap { position: absolute; left: 10px; top: 6px; font-size: 11px; color: var(--ink-soft); pointer-events: none; }
.ba-cap b { color: var(--ink); font-weight: 600; }
.ba-slice { display: flex; flex-direction: column; }
.ba-slice .sv { flex: 1; min-height: 230px; position: relative; }
.ba-slice .sv svg { position: absolute; inset: 0; }
.ba-kseg { display: grid; grid-template-columns: 1fr 1fr 1fr; border-top: 1px solid var(--line); }
.ba-kseg button { border: 0; background: transparent; padding: 5px 0; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.ba-kseg button + button { border-left: 1px solid var(--line); }
.ba-kseg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.ba-hard { display: flex; border-top: 1px solid var(--line-soft); }
.ba-hard button { flex: 1; border: 0; background: transparent; padding: 4px 0; font-size: 11px; cursor: pointer; color: var(--ink-soft); }
.ba-hard button[aria-pressed="true"] { color: var(--ink); font-weight: 600; box-shadow: inset 0 -2px 0 var(--tool-neutral); }
.ba-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.ba-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.ba-seg button + button { border-left: 1px solid var(--line); }
.ba-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.ba-fld { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.ba-fld input { width: 60px; padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.ba-fld input.bad { border-color: var(--danger); }
.ba-gauges { display: inline-flex; gap: 3px; }
.ba-gauges button { border: 1px solid var(--line); background: var(--surface); border-radius: 3px; padding: 1px 5px; cursor: pointer;
  font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.ba-gauges button[aria-pressed="true"] { border-color: var(--ink-soft); color: var(--ink); background: var(--sunken); }
.ba-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.ba-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.ba-msgs div.note { border-left-color: var(--line); color: var(--ink-soft); }
.ba-msgs:empty { display: none; }
.ba svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.ba .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.ba .knob { cursor: grab; outline: none; }
.ba .knob:focus-visible .kc { stroke: var(--accent); stroke-width: 3px; }
.ba .knob:focus-visible .kf { stroke: var(--accent); stroke-width: 1.5px; stroke-dasharray: 3 2; }
.ba .dragging, .ba .dragging * { cursor: grabbing !important; }
@media (max-width: 760px) {
  .ba { grid-template-columns: minmax(0, 1fr); grid-template-areas: "bar" "form" "slice" "flat" "msgs" "out"; }
  .ba-form { height: 330px; }
  .ba-slice .sv { min-height: 250px; height: 250px; }
  .ba-flat { height: 196px; }
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
const svgEl = (label) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('role', 'group'); s.setAttribute('aria-label', label); return s; };
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const round = (v, q) => Math.round(Math.round(v / q) * q * 1e6) / 1e6;
const GAUGES = ['0.5', '0.8', '1', '1.2', '1.5', '2', '2.5', '3', '4', '5', '6'];

export function page(root, ctx) {
  document.head.append(el('style', { text: CSS }));
  const F = (v, d = 4) => (Number.isFinite(v) ? ctx.fmtNum(v, d) : '–');
  let d = null, res = null, drag = null, frozen = null;

  // ---------- toolbar: the sheet and how the drawing is dimensioned ----------
  const tIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Sheet thickness T in mm' });
  const rIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Inside bend radius R in mm' });
  const angIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Angle in degrees' });
  const aIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Flange A in mm' });
  const bIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Flange B in mm' });
  const gauges = el('span', { class: 'ba-gauges', role: 'group', 'aria-label': 'Common thicknesses' });
  const segAngle = el('span', { class: 'ba-seg', role: 'group', 'aria-label': 'The angle is the' });
  const segDims = el('span', { class: 'ba-seg', role: 'group', 'aria-label': 'Flanges measured to the' });
  for (const [inp, key] of [[tIn, 't'], [rIn, 'r'], [angIn, 'angle'], [aIn, 'a'], [bIn, 'b']]) {
    inp.addEventListener('change', () => ctx.set(key, inp.value.trim()));
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const step = key === 'angle' ? (e.shiftKey ? 5 : 1) : key === 't' || key === 'r' ? (e.shiftKey ? 0.5 : 0.1) : (e.shiftKey ? 5 : 0.5);
      const v = Math.max(key === 'r' ? 0 : step, round((num(inp.value) || 0) + (e.key === 'ArrowUp' ? step : -step), 1e-4));
      inp.value = String(v); ctx.set(key, String(v));
    });
  }
  const bar = el('div', { class: 'ba-bar' },
    el('label', { class: 'ba-fld' }, 'T', tIn, 'mm'), gauges,
    el('label', { class: 'ba-fld' }, 'R', rIn, 'mm'),
    el('label', { class: 'ba-fld' }, 'A', aIn), el('label', { class: 'ba-fld' }, 'B', bIn),
    el('label', { class: 'ba-fld' }, 'angle', angIn, '°'), segAngle, segDims);

  // ---------- the formed part ----------
  const fsvg = svgEl('Formed part in section: drag the flange tips and the radius knob');
  const fcap = el('div', { class: 'ba-cap' });
  const form = el('div', { class: 'ba-panel ba-form' }, fsvg, fcap);

  // ---------- the slice of sheet: K-factor ----------
  const ssvg = svgEl('The bend magnified: drag the neutral axis to set the K-factor');
  const kseg = el('div', { class: 'ba-kseg', role: 'group', 'aria-label': 'K-factor from' });
  const hardSeg = el('div', { class: 'ba-hard', role: 'group', 'aria-label': 'Material hardness' });
  const slice = el('div', { class: 'ba-panel ba-slice' }, el('div', { class: 'sv' }, ssvg), el('div', { class: 'ba-cap' }, 'Bend, magnified · drag the neutral axis'), kseg, hardSeg);

  // ---------- the flat blank ----------
  const lsvg = svgEl('Flat blank');
  const flat = el('div', { class: 'ba-panel ba-flat' }, lsvg, el('div', { class: 'ba-cap' }, 'Flat blank, unrolled'));
  const msgs = el('div', { class: 'ba-msgs', 'aria-live': 'polite' });
  const out = el('div', { class: 'ba-out' }, ctx.outputs);
  root.append(el('div', { class: 'ba' }, bar, form, slice, flat, msgs, out));

  function syncControls() {
    const raw = ctx.raw;
    for (const [inp, key] of [[tIn, 't'], [rIn, 'r'], [angIn, 'angle'], [aIn, 'a'], [bIn, 'b']]) {
      if (document.activeElement !== inp) inp.value = raw[key] ?? '';
      inp.classList.toggle('bad', String(raw[key] ?? '').trim() !== '' && ctx.input[key] == null);
    }
    const seg = (host, key, opts) => host.replaceChildren(...opts.map(([v, t, title]) =>
      el('button', { 'aria-pressed': String(String(raw[key]) === v), title, onclick: () => ctx.set(key, v) }, t)));
    gauges.replaceChildren(...GAUGES.map((g) => el('button', { 'aria-pressed': String(num(raw.t) === num(g)), title: `${g} mm sheet`, onclick: () => ctx.set('t', g) }, g)));
    seg(segAngle, 'angleType', [['bend', 'bend angle', 'The angle turned through: 90 for an L'], ['included', 'included', 'The angle between the flanges']]);
    seg(segDims, 'dims', [['outside', 'outside mould', 'Flanges measured to where the outer faces meet'], ['inside', 'inside mould', 'Flanges measured to where the inner faces meet']]);
    seg(kseg, 'kmode', [['din', 'DIN 6935', 'k = 0.65 + 0.5 lg(R/T), K = k/2'], ['table', 'Table', 'Rule of thumb by R/T and hardness'], ['manual', 'Typed', 'Your own K (drag the line)']]);
    hardSeg.hidden = raw.kmode !== 'table';
    seg(hardSeg, 'hard', [['soft', 'soft', 'Annealed Al, copper, brass'], ['medium', 'medium', 'Mild steel, 5052 Al'], ['hard', 'hard', 'Stainless, spring steel, 6061-T6']]);
  }

  // ---------- geometry of the formed part (mm, y up), bend centre at the origin ----------
  // Flange A runs along -x under the centre; the bend turns counter-clockwise through
  // deg; flange B leaves the arc along its tangent.
  function shape(g) {
    const th = g.deg * DEG, r = g.r, t = g.t;
    const p0 = -Math.PI / 2, p1 = p0 + th;
    const u = [-Math.sin(p1), Math.cos(p1)]; // flange B direction
    const sA = Math.max(0, g.straightA), sB = Math.max(0, g.straightB);
    const at = (rad, a) => [rad * Math.cos(a), rad * Math.sin(a)];
    const iA0 = [-sA, -r], oA0 = [-sA, -r - t];
    const iB1 = at(r, p1), oB1 = at(r + t, p1);
    const iB2 = [iB1[0] + sB * u[0], iB1[1] + sB * u[1]], oB2 = [oB1[0] + sB * u[0], oB1[1] + sB * u[1]];
    // mould lines: outer (or inner) faces extended to where they meet
    const tan = Math.tan(th / 2);
    const mouldO = [(r + t) * tan, -r - t], mouldI = [r * tan, -r];
    return { th, p0, p1, u, sA, sB, iA0, oA0, iB1, oB1, iB2, oB2, mouldO, mouldI, at };
  }

  function fit(W, H, g, S) {
    const pts = [S.iA0, S.oA0, S.oB2, S.iB2, S.mouldO, [0, 0], S.at(g.r + g.t, S.p0 + S.th / 2)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const narrow = W < 520;
    const pad = { l: narrow ? 30 : 70, r: narrow ? 52 : 90, t: narrow ? 50 : 56, b: narrow ? 58 : 70 };
    const s = Math.max(0.05, Math.min((W - pad.l - pad.r) / Math.max(1e-6, x1 - x0), (H - pad.t - pad.b) / Math.max(1e-6, y1 - y0)));
    return { s, ox: pad.l + ((W - pad.l - pad.r) - s * (x1 - x0)) / 2 - s * x0, oy: pad.t + ((H - pad.t - pad.b) - s * (y1 - y0)) / 2 + s * y1 };
  }

  const arrow = (x, y, ang, col = 'var(--tool-dim)') => {
    const L = 7, w = 2.6, c = Math.cos(ang), s = Math.sin(ang);
    return `<path d="M${x},${y}L${x - L * c + w * s},${y - L * s - w * c}L${x - L * c - w * s},${y - L * s + w * c}Z" fill="${col}"/>`;
  };
  /** An aligned dimension between two screen points, offset by off px to the left of p->q. */
  const dim = (p, q, off, label, opts = {}) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1;
    const n = [dy / L, -dx / L];
    const a = [p[0] + n[0] * off, p[1] + n[1] * off], b = [q[0] + n[0] * off, q[1] + n[1] * off];
    const ang = Math.atan2(dy, dx);
    const col = opts.col || 'var(--tool-dim)';
    const ext = (s, e) => `<line x1="${s[0] + n[0] * 3 * Math.sign(off)}" y1="${s[1] + n[1] * 3 * Math.sign(off)}" x2="${e[0] + n[0] * 4 * Math.sign(off)}" y2="${e[1] + n[1] * 4 * Math.sign(off)}" stroke="${col}" stroke-width="0.6" stroke-opacity="0.7"/>`;
    let rot = ang / DEG;
    if (rot > 90) rot -= 180; else if (rot < -90) rot += 180;
    const mx = (a[0] + b[0]) / 2 + n[0] * 5 * Math.sign(off), my = (a[1] + b[1]) / 2 + n[1] * 5 * Math.sign(off);
    const vy = Math.sign(off) * (n[1] >= 0 ? 1 : -1) > 0 ? 9 : -3;
    return ext(p, a) + ext(q, b)
      + `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${col}" stroke-width="0.9"/>`
      + (L > 18 ? arrow(a[0], a[1], ang + Math.PI, col) + arrow(b[0], b[1], ang, col) : '')
      + `<text transform="translate(${mx},${my}) rotate(${rot})" y="${Math.abs(rot) < 45 ? vy - 3 : 3}" text-anchor="middle" font-size="${opts.size || 11}" font-weight="${opts.bold ? 600 : 400}" class="halo" fill="${opts.tcol || 'var(--ink)'}">${label}</text>`;
  };

  function drawForm() {
    const W = Math.max(240, form.clientWidth), H = Math.max(200, form.clientHeight);
    fsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!d) {
      fsvg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--danger)">${(res?.warnings || ['No part'])[0]}</text>`;
      fcap.textContent = '';
      return;
    }
    const g = d, S = shape(g);
    const V = frozen || fit(W, H, g, S);
    fsvg._V = V;
    const X = (p) => [V.ox + V.s * p[0], V.oy - V.s * p[1]];
    const P = (p) => X(p).map((v) => v.toFixed(2)).join(',');
    const o = [];
    // section: flange A, bend, flange B as one outline
    const arcI = `A${g.r * V.s},${g.r * V.s} 0 0 1 ${P(S.at(g.r, S.p0))}`;
    const arcO = `A${(g.r + g.t) * V.s},${(g.r + g.t) * V.s} 0 0 0 ${P(S.oB1)}`;
    const outline = `M${P(S.oA0)}L${P([0, -g.r - g.t])}${arcO}L${P(S.oB2)}L${P(S.iB2)}L${P(S.iB1)}${g.r > 0 ? arcI : `L${P([0, -g.r])}`}L${P(S.iA0)}Z`;
    const bad = g.flags.crack;
    o.push(`<path d="${outline}" fill="var(--tool-metal-fill)" stroke="var(--tool-metal)" stroke-width="1.4" stroke-linejoin="round"/>`);
    // bend zone shaded between the tangent lines
    const rn = g.r + g.K * g.t;
    const zone = `M${P([0, -g.r - g.t])}A${(g.r + g.t) * V.s},${(g.r + g.t) * V.s} 0 0 0 ${P(S.oB1)}L${P(S.iB1)}${g.r > 0 ? `A${g.r * V.s},${g.r * V.s} 0 0 1 ${P([0, -g.r])}` : `L${P([0, 0])}`}Z`;
    o.push(`<path d="${zone}" fill="var(--tool-bend)" fill-opacity="0.22" stroke="none"/>`);
    for (const p of [[[0, -g.r + 0.0001], [0, -g.r - g.t]], [S.iB1, S.oB1]]) {
      const [a, b] = p.map(X);
      o.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="var(--tool-bend)" stroke-width="1" stroke-dasharray="3 2"/>`);
    }
    // neutral axis through the whole part
    const nA = X([-S.sA, -rn]), nB0 = X([0, -rn]), nB1 = X(S.at(rn, S.p1)), nB2 = X([S.at(rn, S.p1)[0] + S.sB * S.u[0], S.at(rn, S.p1)[1] + S.sB * S.u[1]]);
    o.push(`<path d="M${nA}L${nB0}A${rn * V.s},${rn * V.s} 0 0 0 ${nB1}L${nB2}" fill="none" stroke="var(--tool-neutral)" stroke-width="1.2" stroke-dasharray="7 3 1.5 3"/>`);
    // crack warning on the outside of the bend
    if (bad) {
      const n = Math.max(6, Math.round(((g.r + g.t) * S.th * V.s) / 6)), pts = [];
      for (let i = 0; i <= n; i++) {
        const a = S.p0 + (S.th * i) / n, rr = g.r + g.t + (i % 2 ? 7 : 2) / V.s;
        pts.push(X(S.at(rr, a)).join(','));
      }
      o.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="var(--danger)" stroke-width="1.6"/>`);
      const lp = X(S.at(g.r + g.t + 16 / V.s, S.p0 + S.th / 2));
      o.push(`<text x="${lp[0] + 4}" y="${lp[1] + 4}" font-size="11" font-weight="600" class="halo" fill="var(--danger)">R ${F(g.r / g.t, 2)}·T: outside may crack</text>`);
    }
    // mould lines: faces extended to the virtual sharp
    const M = g.inside ? S.mouldI : S.mouldO;
    const faceA = g.inside ? [0, -g.r] : [0, -g.r - g.t], faceB = g.inside ? S.iB1 : S.oB1;
    const mm = X(M);
    for (const f of [faceA, faceB]) { const a = X(f); o.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${mm[0]}" y2="${mm[1]}" stroke="var(--ink-soft)" stroke-width="0.8" stroke-dasharray="2 3"/>`); }
    o.push(`<circle cx="${mm[0]}" cy="${mm[1]}" r="2.4" fill="var(--surface)" stroke="var(--ink-soft)"/>`);
    // dimensions A and B, to the mould line
    const endA = X(g.inside ? [-S.sA, -g.r] : [-S.sA, -g.r - g.t]);
    const endB = X(g.inside ? S.iB2 : S.oB2);
    const warnA = g.flags.shortA || g.straightA < 0, warnB = g.flags.shortB || g.straightB < 0;
    o.push(dim(endA, mm, -(26 + (g.inside ? g.t * V.s : 0)), `A ${F(g.a)}`, { bold: true, tcol: warnA ? 'var(--danger)' : 'var(--ink)' }));
    o.push(dim(mm, endB, -(26 + (g.inside ? g.t * V.s : 0)), `B ${F(g.b)}`, { bold: true, tcol: warnB ? 'var(--danger)' : 'var(--ink)' }));
    // radius leader and thickness
    const c0 = X([0, 0]);
    const rm = S.p0 + S.th / 2;
    if (g.r > 0) {
      const rp = X(S.at(g.r, rm));
      o.push(`<line x1="${c0[0]}" y1="${c0[1]}" x2="${rp[0]}" y2="${rp[1]}" stroke="var(--tool-dim)" stroke-width="0.8"/>` + arrow(rp[0], rp[1], Math.atan2(rp[1] - c0[1], rp[0] - c0[0])));
    }
    o.push(`<path d="M${c0[0] - 5},${c0[1]}h10M${c0[0]},${c0[1] - 5}v10" stroke="var(--ink-soft)" stroke-width="0.9"/>`);
    // thickness on flange A
    const tx = X([-S.sA * 0.55, -g.r - g.t]), ty = X([-S.sA * 0.55, -g.r]);
    o.push(`<text x="${tx[0]}" y="${tx[1] + 13}" text-anchor="middle" font-size="10.5" class="halo" fill="var(--ink-soft)">T ${F(g.t)}</text>`);
    void ty;
    // labels on the bend: angle and allowance
    const cb = [c0[0] - Math.cos(rm) * 34, c0[1] + Math.sin(rm) * 34];
    const la = Math.cos(rm) >= 0 ? 'end' : 'start';
    o.push(`<text x="${cb[0]}" y="${cb[1] - 16}" text-anchor="${la}" font-size="12" font-weight="600" class="halo" fill="var(--tool-bend)">BA ${F(g.BA)}</text>`);
    o.push(`<text x="${cb[0]}" y="${cb[1] - 3}" text-anchor="${la}" font-size="10.5" class="halo" fill="${g.flags.nearHem ? 'var(--warn)' : 'var(--ink-soft)'}">${F(g.deg, 4)}° bend${ctx.raw.angleType === 'included' ? ` · ${F(180 - g.deg, 4)}° incl.` : ''}${g.flags.nearHem ? ' · near a hem' : ''}</text>`);
    // knobs: tip of A (length), tip of B (length + angle), radius
    const tipA = X([-S.sA, -g.r - g.t / 2]);
    const tipB = X([(S.iB2[0] + S.oB2[0]) / 2, (S.iB2[1] + S.oB2[1]) / 2]);
    const rk = X(S.at(Math.max(g.r, 0) * 0.5, rm));
    const knob = (k, p, label, col, shapeD) => `<g class="knob" data-k="${k}" tabindex="0" role="slider" aria-label="${label}">`
      + `<circle class="kf" cx="${p[0]}" cy="${p[1]}" r="14" fill="transparent" stroke="none"/>`
      + (shapeD ? shapeD(p) : `<circle class="kc" cx="${p[0]}" cy="${p[1]}" r="7" fill="var(--surface)" stroke="${col}" stroke-width="2"/>`)
      + `<title>${label}</title></g>`;
    const diamond = (p) => `<path class="kc" d="M${p[0]},${p[1] - 7}L${p[0] + 7},${p[1]}L${p[0]},${p[1] + 7}L${p[0] - 7},${p[1]}Z" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/>`;
    o.push(knob('a', tipA, 'Flange A: drag along the flange, or arrow keys', warnA ? 'var(--danger)' : 'var(--accent)'));
    o.push(knob('b', tipB, 'Flange B tip: drag to lengthen or swing round to change the angle; arrows: up/down angle, left/right length', 'var(--accent)', diamond));
    o.push(knob('r', rk, 'Inside radius R: drag away from the bend centre, or arrow keys', 'var(--tool-bend)',
      (p) => `<rect class="kc" x="${p[0] - 5.5}" y="${p[1] - 5.5}" width="11" height="11" rx="2" fill="var(--surface)" stroke="var(--tool-bend)" stroke-width="2"/>`));
    const rl = X(S.at(Math.max(g.r, 0) * 0.5, rm));
    o.push(`<text x="${rl[0] + (Math.cos(rm) >= 0 ? -12 : 12)}" y="${rl[1] - 10}" text-anchor="${Math.cos(rm) >= 0 ? 'end' : 'start'}" font-size="11" font-weight="600" class="halo" fill="var(--tool-bend)">R ${F(g.r)}</text>`);
    // short-flange marks at the tips
    if (warnA) o.push(`<text x="${tipA[0]}" y="${tipA[1] + g.t * V.s / 2 + 38}" text-anchor="middle" font-size="10.5" class="halo" fill="var(--danger)">${g.straightA < 0 ? 'ends in the bend' : `min ${F(g.minFlange, 3)}`}</text>`);
    if (warnB) o.push(`<text x="${tipB[0] + 12}" y="${tipB[1] - 12}" font-size="10.5" class="halo" fill="var(--danger)">${g.straightB < 0 ? 'ends in the bend' : `min ${F(g.minFlange, 3)}`}</text>`);
    fsvg.innerHTML = o.join('');
    fcap.innerHTML = W < 520 ? 'Drag the tips and the radius knob' : 'Formed part, section to scale. Drag <b>●</b> A along, <b>◆</b> B along or round (angle), <b>■</b> the inside radius. Arrow keys on a focused knob.';
    fsvg.classList.toggle('dragging', !!drag);
  }

  // The bend, magnified: the zone between the tangent lines, the neutral axis
  // as an arc you drag (K), the inside radius, the setback to the mould line.
  function drawSlice() {
    const W = Math.max(150, ssvg.parentElement.clientWidth), H = Math.max(140, ssvg.parentElement.clientHeight);
    ssvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!d) { ssvg.innerHTML = ''; return; }
    const g = d, S = shape(g);
    const ro = g.r + g.t, stub = Math.max(ro * 0.9, g.t * 2.5);
    const M = g.inside ? S.mouldI : S.mouldO;
    const pts = [[-stub, -ro], [-stub, -g.r], S.at(ro, S.p1), [S.oB1[0] + stub * S.u[0], S.oB1[1] + stub * S.u[1]], [S.iB1[0] + stub * S.u[0], S.iB1[1] + stub * S.u[1]], [0, 0], M];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = { l: 86, r: 22, t: 60, b: 30 };
    const sc = Math.min((W - pad.l - pad.r) / (x1 - x0 || 1), (H - pad.t - pad.b) / (y1 - y0 || 1));
    const ox = pad.l + ((W - pad.l - pad.r) - sc * (x1 - x0)) / 2 - sc * x0, oy = pad.t + ((H - pad.t - pad.b) - sc * (y1 - y0)) / 2 + sc * y1;
    const X = (p) => [ox + sc * p[0], oy - sc * p[1]];
    const P = (p) => X(p).map((v) => v.toFixed(2)).join(',');
    const o = [];
    const bOut = [S.oB1[0] + stub * S.u[0], S.oB1[1] + stub * S.u[1]], bIn = [S.iB1[0] + stub * S.u[0], S.iB1[1] + stub * S.u[1]];
    const arcO = `A${ro * sc},${ro * sc} 0 0 0 ${P(S.oB1)}`, arcI = g.r > 0 ? `A${g.r * sc},${g.r * sc} 0 0 1 ${P([0, -g.r])}` : `L${P([0, 0])}`;
    o.push(`<path d="M${P([-stub, -ro])}L${P([0, -ro])}${arcO}L${P(bOut)}L${P(bIn)}L${P(S.iB1)}${arcI}L${P([-stub, -g.r])}Z" fill="var(--tool-metal-fill)" stroke="var(--tool-metal)" stroke-width="1.3"/>`);
    o.push(`<path d="M${P([0, -ro])}${arcO}L${P(S.iB1)}${arcI}Z" fill="var(--tool-bend)" fill-opacity="0.24"/>`);
    for (const [q1, q2] of [[[0, -g.r], [0, -ro]], [S.iB1, S.oB1]]) { const [a1, a2] = [X(q1), X(q2)]; o.push(`<line x1="${a1[0]}" y1="${a1[1]}" x2="${a2[0]}" y2="${a2[1]}" stroke="var(--tool-bend)" stroke-dasharray="3 2"/>`); }
    // K scale across the thickness at the end of the A stub
    const e0 = X([-stub, -g.r]), e1 = X([-stub, -ro]);
    for (const k of [0, 0.25, 0.5, 0.75, 1]) {
      const y = e0[1] + (e1[1] - e0[1]) * k;
      o.push(`<line x1="${e0[0] - 4}" x2="${e0[0]}" y1="${y}" y2="${y}" stroke="var(--ink-soft)"/>`);
    }
    o.push(`<text x="${e0[0] + 3}" y="${e0[1] - 3}" font-size="9" fill="var(--ink-soft)">K 0 inside</text>`);
    o.push(`<text x="${e0[0] + 3}" y="${e1[1] + 10}" font-size="9" fill="var(--ink-soft)">K 1 outside</text>`);
    // DIN / table references beside the scale (click to use)
    const refs = [['DIN', g.kDin, 'din'], ['table', g.kTable, 'table']].filter((r) => Number.isFinite(r[1]));
    const ry = refs.map((r) => e0[1] + (e1[1] - e0[1]) * r[1]);
    if (refs.length === 2 && Math.abs(ry[0] - ry[1]) < 11) { const m = (ry[0] + ry[1]) / 2, up = ry[0] <= ry[1] ? -1 : 1; ry[0] = m + up * 5.5; ry[1] = m - up * 5.5; }
    refs.forEach(([t, k, m], i) => {
      const y = e0[1] + (e1[1] - e0[1]) * k, cur = g.kmode === m;
      o.push(`<g class="kref" data-k="${m}" style="cursor:pointer"><rect x="${e0[0] - 60}" y="${ry[i] - 6}" width="58" height="12" fill="transparent"/>`
        + `<path d="M${e0[0] - 5},${y}l-6,-4v8z" fill="${cur ? 'var(--tool-neutral)' : 'var(--ink-soft)'}"/>`
        + `<text x="${e0[0] - 13}" y="${ry[i] + 3}" text-anchor="end" font-size="9.5" fill="${cur ? 'var(--ink)' : 'var(--ink-soft)'}">${t} ${F(k, 2)}</text><title>Use ${m === 'din' ? 'DIN 6935' : 'the table'}: K ${F(k, 3)}</title></g>`);
    });
    // neutral axis arc (drag it)
    const rn = g.r + g.K * g.t, over = g.K > 0.5, col = over ? 'var(--danger)' : 'var(--tool-neutral)';
    const nA = [-stub, -rn], n0 = [0, -rn], n1 = S.at(rn, S.p1), n2 = [n1[0] + stub * S.u[0], n1[1] + stub * S.u[1]];
    const mid = X(S.at(rn, S.p0 + S.th / 2));
    o.push(`<g class="knob" data-k="k" tabindex="0" role="slider" aria-label="K-factor: drag the neutral axis, or arrow keys" aria-valuenow="${g.K}" aria-valuemin="0" aria-valuemax="1">`
      + `<path class="kf" d="M${P(nA)}L${P(n0)}A${rn * sc},${rn * sc} 0 0 0 ${P(n1)}L${P(n2)}" fill="none" stroke="transparent" stroke-width="16"/>`
      + `<path class="kc" d="M${P(nA)}L${P(n0)}A${rn * sc},${rn * sc} 0 0 0 ${P(n1)}L${P(n2)}" fill="none" stroke="${col}" stroke-width="2.4"/>`
      + `<circle cx="${mid[0]}" cy="${mid[1]}" r="5" fill="var(--surface)" stroke="${col}" stroke-width="2"/></g>`);
    // labels: K, R, T, setback
    const rm = S.p0 + S.th / 2, cr = Math.cos(rm) >= 0;
    const why = { din: 'DIN 6935', table: `table, ${ctx.raw.hard || 'medium'}`, manual: 'typed / dragged' }[g.kmode] || '';
    o.push(`<text x="10" y="36" font-size="15" font-weight="600" class="halo" fill="${col}">K ${F(g.K, 3)}</text>`);
    o.push(`<text x="10" y="50" font-size="10" class="halo" fill="var(--ink-soft)">${F(g.K * g.t, 3)} mm from the inside · ${why}</text>`);
    const c0 = X([0, 0]);
    o.push(`<path d="M${c0[0] - 4},${c0[1]}h8M${c0[0]},${c0[1] - 4}v8" stroke="var(--ink-soft)"/>`);
    if (g.r > 0) {
      const rp = X(S.at(g.r, rm));
      o.push(`<line x1="${c0[0]}" y1="${c0[1]}" x2="${rp[0]}" y2="${rp[1]}" stroke="var(--tool-dim)" stroke-width="0.8"/>` + arrow(rp[0], rp[1], Math.atan2(rp[1] - c0[1], rp[0] - c0[0])));
    }
    o.push(`<text x="${c0[0] - 6}" y="${c0[1] - 6}" text-anchor="end" font-size="10.5" class="halo" fill="var(--tool-bend)">R ${F(g.r)}</text>`);
    if (W > 330) o.push(`<text x="${(e0[0] + X([0, 0])[0]) / 2 + 30}" y="${e1[1] + 13}" text-anchor="middle" font-size="10" class="halo" fill="var(--ink-soft)">T ${F(g.t)}</text>`);
    // setback: tangent line to the mould point along the measured face
    const mm = X(M), fA = X(g.inside ? [0, -g.r] : [0, -ro]);
    for (const f of [fA, X(g.inside ? S.iB1 : S.oB1)]) o.push(`<line x1="${f[0]}" y1="${f[1]}" x2="${mm[0]}" y2="${mm[1]}" stroke="var(--ink-soft)" stroke-width="0.8" stroke-dasharray="2 3"/>`);
    o.push(`<circle cx="${mm[0]}" cy="${mm[1]}" r="2.4" fill="var(--surface)" stroke="var(--ink-soft)"/>`);
    const sb = g.inside ? g.ISSB : g.OSSB;
    if (Math.abs(mm[0] - fA[0]) > 14) o.push(dim(fA, mm, g.inside ? 12 + g.t * sc : -12, `${g.inside ? 'ISSB' : 'OSSB'} ${F(sb, 3)}`, { size: 10 }));
    ssvg.innerHTML = o.join('');
    ssvg._B = { ox, oy, sc };
  }

  function drawFlat() {
    const W = Math.max(240, flat.clientWidth), H = Math.max(120, flat.clientHeight);
    lsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!d) { lsvg.innerHTML = ''; return; }
    const g = d;
    const ks = g.ks.map((x) => x.flat);
    const maxL = Math.max(g.flat, ...ks);
    const narrow = W < 520;
    const L = narrow ? 14 : 40, R = narrow ? 14 : 70;
    const s = (W - L - R) / maxL;
    const yT = narrow ? 72 : 50, h = 30;
    const x = (v) => L + v * s;
    const sA = Math.max(0, g.straightA);
    const o = [];
    o.push(`<rect x="${x(0)}" y="${yT}" width="${g.flat * s}" height="${h}" fill="var(--tool-metal-fill)" stroke="var(--tool-metal)" stroke-width="1.2"/>`);
    o.push(`<rect x="${x(sA)}" y="${yT}" width="${g.BA * s}" height="${h}" fill="var(--tool-bend)" fill-opacity="0.28"/>`);
    for (const v of [sA, sA + g.BA]) o.push(`<line x1="${x(v)}" x2="${x(v)}" y1="${yT}" y2="${yT + h}" stroke="var(--tool-bend)" stroke-dasharray="3 2"/>`);
    // bend centre line, extends past the blank like a drawing's bend line
    o.push(`<line x1="${x(g.bendLine)}" x2="${x(g.bendLine)}" y1="${yT - 8}" y2="${yT + h + 8}" stroke="var(--ink)" stroke-width="1" stroke-dasharray="8 3 2 3"/>`);
    o.push(`<text x="${x(g.bendLine)}" y="${yT - 11}" text-anchor="middle" font-size="10" class="halo" fill="var(--ink)">bend line ${F(g.bendLine)}</text>`);
    // overall flat, above
    const yO = yT - (narrow ? 32 : 26);
    o.push(`<line x1="${x(0)}" x2="${x(g.flat)}" y1="${yO}" y2="${yO}" stroke="var(--ink)" stroke-width="0.9"/>` + arrow(x(0), yO, Math.PI, 'var(--ink)') + arrow(x(g.flat), yO, 0, 'var(--ink)'));
    for (const v of [0, g.flat]) o.push(`<line x1="${x(v)}" x2="${x(v)}" y1="${yO - 4}" y2="${yT}" stroke="var(--ink-soft)" stroke-width="0.6"/>`);
    o.push(`<text x="${x(g.flat / 2)}" y="${yO - 5}" text-anchor="middle" font-size="13" font-weight="600" class="halo" fill="var(--ok)">flat ${g.straightA < 0 || g.straightB < 0 ? '–' : F(g.flat, 5)} mm</text>`);
    // pieces below
    const yP = yT + h + 16;
    const piece = (a, b, label, col) => {
      o.push(`<line x1="${x(a)}" x2="${x(b)}" y1="${yP}" y2="${yP}" stroke="${col}" stroke-width="0.9"/>` + (Math.abs(b - a) * s > 16 ? arrow(x(a), yP, Math.PI, col) + arrow(x(b), yP, 0, col) : ''));
      return label;
    };
    piece(0, sA, '', 'var(--tool-dim)'); piece(sA, sA + g.BA, '', 'var(--tool-bend)'); piece(sA + g.BA, g.flat, '', 'var(--tool-dim)');
    const labs = [[sA / 2, `${F(g.straightA)}`, 'var(--ink)'], [sA + g.BA / 2, `BA ${F(g.BA)}`, 'var(--tool-bend)'], [sA + g.BA + Math.max(0, g.straightB) / 2, `${F(g.straightB)}`, 'var(--ink)']];
    // keep the three labels apart on a short blank
    let prev = -1e9;
    labs.forEach(([v, t, c], i) => {
      let px = x(v); const w = t.length * 6.4;
      if (px - w / 2 < prev + 4) px = prev + 4 + w / 2;
      prev = px + w / 2;
      o.push(`<text x="${px}" y="${yP + 14 + (i === 1 && narrow ? 12 : 0)}" text-anchor="middle" font-size="11" class="halo" fill="${c}">${t}</text>`);
    });
    // Where the blank would end at other K-factors: a loupe on the blank's end,
    // on its own scale (the spread is a fraction of a millimetre).
    {
      const lo = Math.min(...ks, g.flat), hi = Math.max(...ks, g.flat), span = Math.max(hi - lo, 1e-3);
      const lw = Math.min(narrow ? W - 40 : 300, W * 0.4), lx1 = W - (narrow ? 16 : 30), lx0 = lx1 - lw;
      const yK = yT + h + (narrow ? 60 : 50);
      const kx = (v) => lx0 + 10 + ((v - lo) / span) * (lw - 20);
      o.push(`<line x1="${x(g.flat)}" y1="${yT + h}" x2="${kx(g.flat)}" y2="${yK - 8}" stroke="var(--ink-soft)" stroke-width="0.6" stroke-dasharray="2 2"/>`);
      o.push(`<line x1="${lx0}" x2="${lx1}" y1="${yK}" y2="${yK}" stroke="var(--ink-soft)" stroke-width="0.8"/>`);
      o.push(`<text x="${lx0 - 6}" y="${yK + 3}" text-anchor="end" font-size="9.5" fill="var(--ink-soft)">${narrow ? 'end at K' : `blank end at other K · ${F(span, 2)} mm spread`}</text>`);
      g.ks.forEach((q, i) => {
        const cur = Math.abs(q.k - g.K) < 5e-4, px = kx(q.flat);
        o.push(`<g class="kalt" data-kv="${q.k}" style="cursor:pointer" tabindex="0" role="button" aria-label="Use K ${q.k.toFixed(2)}: flat ${F(q.flat, 5)} mm"><rect x="${px - 7}" y="${yK - 9}" width="14" height="30" fill="transparent"/>`
          + `<line x1="${px}" x2="${px}" y1="${yK - 6}" y2="${yK + 6}" stroke="${cur ? 'var(--tool-neutral)' : 'var(--ink-soft)'}" stroke-width="${cur ? 2.5 : 1.2}"/>`
          + (narrow && !cur && i !== 0 && i !== g.ks.length - 1 ? '' : `<text x="${px}" y="${yK + (narrow ? 17 : i % 2 ? 26 : 17)}" text-anchor="middle" font-size="9" fill="${cur ? 'var(--ink)' : 'var(--ink-soft)'}">${q.k.toFixed(2)}</text>`)
          + `<title>K ${q.k.toFixed(2)}: flat ${F(q.flat, 5)} mm (${q.flat - g.flat >= 0 ? '+' : ''}${F(q.flat - g.flat, 3)})</title></g>`);
      });
      const px = kx(g.flat);
      o.push(`<path d="M${px},${yK - 7}l-4,-7h8z" fill="var(--ok)"/>`);
    }
    lsvg.innerHTML = o.join('');
  }

  function drawMsgs() {
    msgs.replaceChildren(...(res?.warnings || []).map((w) => el('div', {}, w)));
  }

  const render = () => { drawForm(); drawSlice(); drawFlat(); };

  // ---------- interaction ----------
  const pt = (svg, e) => {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)];
  };
  const setAngle = (deg) => {
    const v = Math.max(1, Math.min(179, Math.round(deg)));
    return ctx.raw.angleType === 'included' ? String(180 - v) : String(v);
  };

  function step(k, key, big) {
    if (!d) return;
    const raw = ctx.raw;
    if (k === 'k') {
      const K = Math.max(0, Math.min(1, round(d.K + (key === 'ArrowUp' || key === 'ArrowRight' ? 1 : -1) * (big ? 0.05 : 0.01), 0.001)));
      ctx.setMany({ kmode: 'manual', k: String(K) });
      return;
    }
    const dir = key === 'ArrowUp' || key === 'ArrowRight' ? 1 : -1;
    if (k === 'a') ctx.set('a', String(Math.max(0.5, round(d.a + dir * (big ? 5 : 0.5), 0.1))));
    else if (k === 'r') ctx.set('r', String(Math.max(0, round(d.r + dir * (big ? 1 : 0.1), 0.01))));
    else if (k === 'b') {
      if (key === 'ArrowUp' || key === 'ArrowDown') ctx.set('angle', setAngle(d.deg + dir * (big ? 5 : 1)));
      else ctx.set('b', String(Math.max(0.5, round(d.b + dir * (big ? 5 : 0.5), 0.1))));
    }
    void raw;
  }

  for (const svg of [fsvg, ssvg]) {
    svg.addEventListener('keydown', (e) => {
      const k = e.target.closest?.('.knob')?.dataset.k;
      if (!k || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      step(k, e.key, e.shiftKey);
      requestAnimationFrame(() => svg.querySelector(`[data-k="${k}"]`)?.focus());
    });
  }

  fsvg.addEventListener('pointerdown', (e) => {
    const kn = e.target.closest('.knob');
    if (!kn || !d) return;
    e.preventDefault();
    frozen = { ...fsvg._V };
    drag = { k: kn.dataset.k, svg: fsvg };
    kn.focus({ preventScroll: true });
    try { fsvg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    fsvg.classList.add('dragging');
  });
  fsvg.addEventListener('pointermove', (e) => {
    if (!drag || drag.svg !== fsvg || !d) return;
    const V = frozen, p = pt(fsvg, e);
    const m = [(p[0] - V.ox) / V.s, (V.oy - p[1]) / V.s]; // mm, bend centre at 0
    const S = shape(d);
    const M = d.inside ? S.mouldI : S.mouldO;
    const q = (v) => Math.max(0.5, round(v, V.s > 6 ? 0.1 : 0.5));
    if (drag.k === 'a') {
      const v = q(M[0] - m[0]);
      if (v !== num(ctx.raw.a)) ctx.set('a', String(v));
    } else if (drag.k === 'b') {
      // swing: the flange direction from the mould point to the pointer
      const dx = m[0] - M[0], dy = m[1] - M[1];
      // flange B leaves the mould point at the bend angle from +x (A runs along -x)
      let deg = Math.atan2(dy, dx) / DEG;
      if (deg < 0) deg = dx >= 0 ? 1 : 179;
      deg = Math.max(1, Math.min(179, deg));
      const len = q(Math.hypot(dx, dy));
      const ns = { b: String(len), angle: setAngle(deg) };
      if (ns.b !== String(num(ctx.raw.b)) || ns.angle !== String(num(ctx.raw.angle))) ctx.setMany(ns);
    } else if (drag.k === 'r') {
      const rm = S.p0 + S.th / 2;
      const along = m[0] * Math.cos(rm) + m[1] * Math.sin(rm);
      const v = Math.max(0, round(along * 2, V.s > 6 ? 0.05 : 0.1));
      if (v !== num(ctx.raw.r)) ctx.set('r', String(v));
    }
  });
  ssvg.addEventListener('pointerdown', (e) => {
    if (!d) return;
    const ref = e.target.closest('.kref');
    if (ref) { ctx.set('kmode', ref.dataset.k); return; }
    e.preventDefault();
    drag = { k: 'k', svg: ssvg };
    ssvg.querySelector('[data-k="k"]')?.focus({ preventScroll: true });
    try { ssvg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    ssvg.classList.add('dragging');
    moveK(e);
  });
  const moveK = (e) => {
    const B = ssvg._B; if (!B || !d) return;
    const p = pt(ssvg, e);
    const m = [(p[0] - B.ox) / B.sc, (B.oy - p[1]) / B.sc];
    const S = shape(d);
    // distance from the bend centre on the arc, from the A face straight part otherwise
    const ang = Math.atan2(m[1], m[0]);
    const inArc = m[0] >= 0 && ((ang - S.p0 + 4 * Math.PI) % (2 * Math.PI)) <= S.th;
    const dist = inArc ? Math.hypot(m[0], m[1]) : m[0] < 0 ? -m[1] : m[0] * S.u[1] - m[1] * S.u[0];
    const K = Math.max(0, Math.min(1, round((dist - d.r) / d.t, 0.005)));
    if (String(K) !== String(num(ctx.raw.k)) || ctx.raw.kmode !== 'manual') ctx.setMany({ kmode: 'manual', k: String(K) });
  };
  ssvg.addEventListener('pointermove', (e) => { if (drag && drag.svg === ssvg) moveK(e); });
  lsvg.addEventListener('keydown', (e) => {
    const a = e.target.closest?.('.kalt');
    if (a && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.setMany({ kmode: 'manual', k: a.dataset.kv }); }
  });
  lsvg.addEventListener('click', (e) => {
    const a = e.target.closest('.kalt');
    if (a) ctx.setMany({ kmode: 'manual', k: a.dataset.kv });
  });
  const end = () => {
    if (!drag) return;
    const { k, svg } = drag;
    drag = null; frozen = null;
    svg.classList.remove('dragging');
    render();
    requestAnimationFrame(() => svg.querySelector(`[data-k="${k}"]`)?.focus({ preventScroll: true }));
  };
  for (const svg of [fsvg, ssvg]) {
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('lostpointercapture', end);
  }

  ctx.onResult((r) => {
    res = r;
    d = r.drawing || null;
    syncControls();
    drawMsgs();
    render();
  });
  new ResizeObserver(() => { if (!drag) render(); }).observe(root);
}
