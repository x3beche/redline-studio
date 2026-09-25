// Bolt Circle Generator: the plate on the machine table. The pattern, to
// scale, with the drawing origin, the drill order and the web between holes;
// you grab hole 1 to turn the pattern, the ring to change the PCD, the edge
// of a hole to size it, the centre to move it, the last hole to open an arc.
// Beside it a setup sheet: a digital readout you step hole by hole, the
// coordinate list and the program. Every number shown comes from run().

const DEG = Math.PI / 180;

const CSS = `
:root { --tool-ring: #1f4ed8; --tool-hole: #d97706; --tool-path: #0f9d8a; --tool-dim: #5b6b7a;
  --tool-plate: color-mix(in srgb, #8a98a6 16%, var(--surface)); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-ring: #7d9bff; --tool-hole: #f0a33a; --tool-path: #3cc7b3; --tool-dim: #8ea0b0;
  --tool-plate: color-mix(in srgb, #7d8d9c 14%, var(--surface)); } }
:root[data-theme="dark"] { --tool-ring: #7d9bff; --tool-hole: #f0a33a; --tool-path: #3cc7b3; --tool-dim: #8ea0b0;
  --tool-plate: color-mix(in srgb, #7d8d9c 14%, var(--surface)); }
.k-page { padding: 10px 12px; }
.bc { display: grid; grid-template-columns: minmax(0, 1fr) minmax(330px, 400px); gap: 12px; align-items: start; }
.bc-table { position: relative; background: var(--sunken); border: 1px solid var(--line); border-radius: 6px; min-width: 0;
  height: clamp(420px, calc(100vh - 78px), 980px); overflow: hidden; }
.bc-table svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.bc-ov { position: absolute; display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.bc-ov.tl { left: 8px; top: 8px; } .bc-ov.tr { right: 8px; top: 8px; align-items: flex-end; } .bc-ov.bl { left: 8px; bottom: 8px; }
.bc-row { display: flex; align-items: center; gap: 5px; background: var(--surface); border: 1px solid var(--line); border-radius: 5px; padding: 3px 6px; }
.bc-row label { display: inline-flex; align-items: center; gap: 4px; }
.bc-row input { width: 62px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 3px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.bc-row input.bad { border-color: var(--danger); }
.bc-count { display: flex; align-items: stretch; background: var(--surface); border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
.bc-count button { border: 0; background: transparent; width: 30px; font-size: 16px; cursor: pointer; color: var(--ink); }
.bc-count button:hover { background: var(--sunken); }
.bc-count input { width: 44px; border: 0; border-left: 1px solid var(--line); border-right: 1px solid var(--line); background: var(--surface);
  text-align: center; font: 600 16px "IBM Plex Mono", ui-monospace, monospace; padding: 3px 0; }
.bc-count span { align-self: center; padding: 0 8px; font-size: 11.5px; color: var(--ink-soft); }
.bc-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.bc-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.bc-seg button + button { border-left: 1px solid var(--line); }
.bc-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.bc [hidden] { display: none !important; }
.bc-hint { position: absolute; right: 10px; bottom: 7px; font-size: 11px; color: var(--ink-soft); pointer-events: none; text-align: right; max-width: 50%; }
.bc-side { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.bc-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.bc-card h2 { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--ink-soft); padding: 6px 10px 4px; display: flex; gap: 8px; align-items: center; }
.bc-dro { display: grid; grid-template-columns: auto 1fr; gap: 0 10px; padding: 2px 12px 8px; align-items: baseline; }
.bc-dro .ax { font: 600 13px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.bc-dro .v { font: 500 26px/1.15 "IBM Plex Mono", ui-monospace, monospace; text-align: right; letter-spacing: 0.02em; }
.bc-dro .v small { font-size: 12px; color: var(--ink-soft); margin-left: 4px; }
.bc-step { display: flex; gap: 6px; align-items: center; padding: 0 10px 8px; }
.bc-step button { border: 1px solid var(--line); background: var(--surface); border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
.bc-step button:hover { border-color: var(--ink-soft); }
.bc-step .n { font: 600 13px "IBM Plex Mono", ui-monospace, monospace; margin: 0 auto; }
.bc-list { max-height: 216px; overflow: auto; border-top: 1px solid var(--line-soft); }
.bc-list table { width: 100%; border-collapse: collapse; font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.bc-list th { position: sticky; top: 0; background: var(--surface); font: 500 11px "IBM Plex Sans", sans-serif; color: var(--ink-soft); text-align: right; padding: 3px 10px; border-bottom: 1px solid var(--line); }
.bc-list td { text-align: right; padding: 2px 10px; border-bottom: 1px solid var(--line-soft); cursor: pointer; }
.bc-list th:first-child, .bc-list td:first-child { text-align: left; }
.bc-list tr[aria-selected="true"] td { background: color-mix(in srgb, var(--tool-hole) 20%, var(--surface)); }
.bc-list tr:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.bc-facts { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--line-soft); }
.bc-facts div { padding: 5px 10px; font-size: 11px; color: var(--ink-soft); min-width: 0; }
.bc-facts div + div { border-left: 1px solid var(--line-soft); }
.bc-facts b { display: block; font: 500 13.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); white-space: nowrap; }
.bc-facts .bad b { color: var(--danger); } .bc-facts .warn b { color: var(--warn); } .bc-facts .ok b { color: var(--ok); }
.bc-prog { display: flex; flex-wrap: wrap; gap: 6px 12px; padding: 6px 10px; font-size: 12px; color: var(--ink-soft); align-items: center; border-bottom: 1px solid var(--line-soft); }
.bc-prog input { width: 52px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 3px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.bc-side .k-outwrap { border: 0; border-radius: 0; }
.bc-side .k-out { max-height: 260px; }
.bc-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.bc-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.bc-msgs:empty { display: none; }
.bc svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.bc .halo { paint-order: stroke; stroke: var(--sunken); stroke-width: 3px; stroke-linejoin: round; }
.bc .knob { cursor: grab; outline: none; }
.bc .knob:focus-visible .kc { stroke: var(--accent); stroke-width: 3px; }
.bc .knob:focus-visible .kf { stroke: var(--accent); stroke-width: 1.5px; stroke-dasharray: 3 2; }
.bc .pick { cursor: pointer; }
.bc .dragging, .bc .dragging * { cursor: grabbing !important; }
@media (max-width: 900px) {
  .bc { grid-template-columns: minmax(0, 1fr); }
  .bc-table { height: min(560px, calc(100vw + 90px)); }
}
@media (max-width: 620px) {
  .bc-table { height: auto; display: flex; flex-wrap: wrap; gap: 5px; padding: 6px; }
  .bc-ov { position: static; flex-direction: row; flex-wrap: wrap; }
  .bc-ov.tr { align-items: center; }
  .bc-table svg { order: 5; flex-basis: 100%; height: 360px; border-top: 1px solid var(--line); margin: 2px -6px -6px; width: calc(100% + 12px); }
  .bc-hint { display: none; }
  .bc-row input { width: 52px; }
  .bc-dro .v { font-size: 22px; }
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
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const round = (v, q) => Math.round(Math.round(v / q) * q * 1e6) / 1e6;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function page(root, ctx) {
  document.head.append(el('style', { text: CSS }));
  const F = (v, d = 4) => (Number.isFinite(v) ? ctx.fmtNum(v, d) : '–');
  let d = null, res = null, drag = null, frozen = null, sel = 1;

  // ---------- fields that live on the drawing's corners ----------
  const field = (key, label, unit, w) => {
    const i = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label}${unit ? ` in ${unit}` : ''}`, style: w ? `width:${w}px` : null });
    i.addEventListener('change', () => ctx.set(key, i.value.trim()));
    i.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const st = { start: e.shiftKey ? 15 : 1, arc: e.shiftKey ? 15 : 1, cx: e.shiftKey ? 10 : 1, cy: e.shiftKey ? 10 : 1, hole: e.shiftKey ? 1 : 0.1, depth: 1 }[key] ?? (e.shiftKey ? 10 : 1);
      const v = round((num(i.value) || 0) + (e.key === 'ArrowUp' ? st : -st), 1e-4);
      i.value = String(v); ctx.set(key, String(v));
    });
    inputs[key] = i;
    return el('label', {}, label, i, unit || '');
  };
  const inputs = {};
  const nIn = el('input', { inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Number of holes' });
  inputs.n = nIn;
  nIn.addEventListener('change', () => ctx.set('n', nIn.value.trim()));
  const bumpN = (dn) => ctx.set('n', String(Math.max(1, Math.min(360, Math.round(num(ctx.raw.n) || 1) + dn))));
  nIn.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); bumpN(e.key === 'ArrowUp' ? 1 : -1); } });
  const count = el('div', { class: 'bc-count', role: 'group', 'aria-label': 'Number of holes' },
    el('button', { 'aria-label': 'One hole fewer', onclick: () => bumpN(-1) }, '−'), nIn,
    el('button', { 'aria-label': 'One hole more', onclick: () => bumpN(1) }, '+'), el('span', {}, 'holes'));
  const segDir = el('span', { class: 'bc-seg', role: 'group', 'aria-label': 'Direction' });
  const segSpan = el('span', { class: 'bc-seg', role: 'group', 'aria-label': 'Spread' });
  const arcWrap = el('span', { class: 'bc-row' }, field('arc', 'arc', '°', 50));
  const tl = el('div', { class: 'bc-ov tl' }, count, el('div', { class: 'bc-row' }, segDir, segSpan), arcWrap);
  const tr = el('div', { class: 'bc-ov tr' },
    el('div', { class: 'bc-row' }, field('pcd', 'PCD', 'mm')),
    el('div', { class: 'bc-row' }, field('hole', 'hole Ø', 'mm', 52)),
    el('div', { class: 'bc-row' }, field('start', 'hole 1 at', '°', 52)));
  const bl = el('div', { class: 'bc-ov bl' }, el('div', { class: 'bc-row' }, 'centre', field('cx', 'x', '', 52), field('cy', 'y', '', 52)));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Bolt circle, top view to scale');
  const hint = el('div', { class: 'bc-hint' });
  const table = el('div', { class: 'bc-table' }, svg, tl, tr, bl, hint);

  // ---------- setup sheet ----------
  const droHead = el('h2');
  const dro = el('div', { class: 'bc-dro', 'aria-live': 'polite' });
  const prev = el('button', { onclick: () => select(sel - 1), 'aria-label': 'Previous hole' }, '◀ prev');
  const next = el('button', { onclick: () => select(sel + 1), 'aria-label': 'Next hole' }, 'next ▶');
  const stepN = el('span', { class: 'n' });
  const facts = el('div', { class: 'bc-facts' });
  const list = el('div', { class: 'bc-list' });
  const dp = el('select', { 'aria-label': 'Decimals in the output', onchange: (e) => ctx.set('dp', e.target.value) }, ['0', '1', '2', '3', '4'].map((v) => el('option', { value: v }, v)));
  const depthIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Drill depth for the G-code in mm' });
  depthIn.addEventListener('change', () => ctx.set('depth', depthIn.value.trim()));
  const prog = el('div', { class: 'bc-prog' }, el('label', {}, 'decimals ', dp), el('label', {}, 'drill depth ', depthIn, ' mm'));
  const msgs = el('div', { class: 'bc-msgs', 'aria-live': 'polite' });
  const side = el('aside', { class: 'bc-side' },
    el('div', { class: 'bc-card' }, droHead, dro, el('div', { class: 'bc-step' }, prev, stepN, next), facts, list),
    msgs,
    el('div', { class: 'bc-card' }, el('h2', {}, 'Program'), prog, ctx.outputs));
  root.append(el('div', { class: 'bc' }, table, side));

  function select(i) {
    if (!d) return;
    const N = d.holes.length;
    sel = ((i - 1 + N) % N) + 1;
    drawSheet();
    drawTable();
    const row = list.querySelector(`tr[data-i="${sel}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  function syncControls() {
    const raw = ctx.raw;
    for (const [k, i] of Object.entries(inputs)) {
      if (document.activeElement !== i) i.value = raw[k] ?? '';
      i.classList.toggle('bad', String(raw[k] ?? '').trim() !== '' && ctx.input[k] == null);
    }
    const seg = (host, key, opts) => host.replaceChildren(...opts.map(([v, t, title]) =>
      el('button', { 'aria-pressed': String(String(raw[key]) === v), title, onclick: () => ctx.set(key, v) }, t)));
    seg(segDir, 'dir', [['ccw', '↺ CCW', 'Counter-clockwise from hole 1'], ['cw', '↻ CW', 'Clockwise from hole 1']]);
    seg(segSpan, 'span', [['full', 'full circle', 'Equal spacing all round'], ['arc', 'arc', 'Spread over an arc, first and last on its ends']]);
    arcWrap.hidden = raw.span !== 'arc';
    dp.value = String(raw.dp ?? '3');
    if (document.activeElement !== depthIn) depthIn.value = raw.depth ?? '';
  }

  // ---------- the drawing ----------
  function fit(W, H) {
    const R = d.pcd / 2 + Math.max(d.hole / 2, 0);
    const xs = [d.cx - R, d.cx + R, 0], ys = [d.cy - R, d.cy + R, 0];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const narrow = W < 520;
    const inside = getComputedStyle(tl).position === 'absolute';
    const pad = { l: narrow ? 34 : 60, r: narrow ? 34 : 60, t: inside ? 100 : 30, b: inside ? 60 : 44 };
    const s = Math.max(1e-3, Math.min((W - pad.l - pad.r) / Math.max(1e-6, x1 - x0), (H - pad.t - pad.b) / Math.max(1e-6, y1 - y0)));
    return { s, ox: pad.l + ((W - pad.l - pad.r) - s * (x1 - x0)) / 2 - s * x0, oy: pad.t + ((H - pad.t - pad.b) - s * (y1 - y0)) / 2 + s * y1 };
  }

  function drawTable() {
    const W = Math.max(240, svg.clientWidth), H = Math.max(240, svg.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!d) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--danger)">${esc((res?.warnings || ['No pattern'])[0])}</text>`;
      return;
    }
    const V = frozen || fit(W, H);
    svg._V = V;
    const X = (x) => V.ox + V.s * x, Y = (y) => V.oy - V.s * y;
    const R = d.pcd / 2, rs = R * V.s, hr = Math.max(2.5, (d.hole / 2) * V.s);
    const cX = X(d.cx), cY = Y(d.cy);
    const o = [];
    // the plate: a disc a little past the holes
    const plateR = rs + Math.max(hr * 2.2, 18);
    o.push(`<circle cx="${cX}" cy="${cY}" r="${plateR}" fill="var(--tool-plate)" stroke="var(--line)" stroke-width="1"/>`);
    // origin axes (the drawing's 0,0), faint grid ticks every 10 mm when legible
    const ox = X(0), oy = Y(0);
    o.push(`<line x1="0" x2="${W}" y1="${oy}" y2="${oy}" stroke="var(--line)" stroke-width="1"/><line x1="${ox}" x2="${ox}" y1="0" y2="${H}" stroke="var(--line)" stroke-width="1"/>`);
    o.push(`<text x="${W - 8}" y="${oy + 14}" text-anchor="end" font-size="10.5" fill="var(--ink-soft)">+X 0°</text>`);
    if (Math.abs(d.cx) > 1e-9 || Math.abs(d.cy) > 1e-9) o.push(`<text x="${ox + 5}" y="${oy + 14}" font-size="10.5" fill="var(--ink-soft)">origin 0,0</text>`);
    // the pitch circle (drag it)
    o.push(`<circle cx="${cX}" cy="${cY}" r="${rs}" fill="none" stroke="var(--tool-ring)" stroke-width="1.2" stroke-dasharray="10 3 2 3"/>`);
    // arc span, in arc mode
    const holes = d.holes;
    const ang = (h) => Math.atan2(h.y - d.cy, h.x - d.cx);
    // drill path in program order
    if (holes.length > 1) {
      const path = holes.map((h, i) => `${i ? 'L' : 'M'}${X(h.x).toFixed(1)},${Y(h.y).toFixed(1)}`).join('');
      o.push(`<path d="${path}" fill="none" stroke="var(--tool-path)" stroke-width="1" stroke-opacity="0.75" stroke-dasharray="4 3"/>`);
      holes.slice(1).forEach((h, i) => {
        const a = holes[i], mx = (X(a.x) + X(h.x)) / 2, my = (Y(a.y) + Y(h.y)) / 2, t = Math.atan2(Y(h.y) - Y(a.y), X(h.x) - X(a.x));
        if (Math.hypot(X(h.x) - X(a.x), Y(h.y) - Y(a.y)) > 2 * hr + 16 && holes.length <= 48) o.push(`<path d="M${mx + 4 * Math.cos(t)},${my + 4 * Math.sin(t)}l${-7 * Math.cos(t) + 3 * Math.sin(t)},${-7 * Math.sin(t) - 3 * Math.cos(t)}l${-6 * Math.sin(t)},${6 * Math.cos(t)}z" fill="var(--tool-path)"/>`);
      });
    }
    // the web between hole 1 and 2: the metal left, coloured by how much
    if (holes.length > 1 && d.hole > 0) {
      const a = holes[0], b = holes[1];
      const ux = (X(b.x) - X(a.x)), uy = (Y(b.y) - Y(a.y)), L = Math.hypot(ux, uy) || 1;
      const p = [X(a.x) + (ux / L) * hr, Y(a.y) + (uy / L) * hr], q = [X(b.x) - (ux / L) * hr, Y(b.y) - (uy / L) * hr];
      const col = d.ligTone === 'bad' ? 'var(--danger)' : d.ligTone === 'warn' ? 'var(--warn)' : 'var(--ok)';
      if (d.lig > 0) o.push(`<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${col}" stroke-width="4" stroke-opacity="0.8"/>`);
      const nx = -uy / L, ny = ux / L, sgn = ((X(a.x) + X(b.x)) / 2 - cX) * nx + ((Y(a.y) + Y(b.y)) / 2 - cY) * ny > 0 ? 1 : -1;
      const mx = (X(a.x) + X(b.x)) / 2 + nx * sgn * 18, my = (Y(a.y) + Y(b.y)) / 2 + ny * sgn * 18;
      o.push(`<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="11.5" font-weight="600" class="halo" fill="${col}">web ${F(d.lig, 3)}</text>`);
    }
    // step angle between hole 1 and 2, drawn as an arc near the centre
    if (holes.length > 1) {
      const a0 = ang(holes[0]), a1 = ang(holes[1]);
      const ra = Math.min(rs * 0.42, 70);
      const sweep = d.sign > 0 ? 0 : 1;
      const large = d.step > 180 ? 1 : 0;
      o.push(`<line x1="${cX}" y1="${cY}" x2="${X(holes[0].x)}" y2="${Y(holes[0].y)}" stroke="var(--tool-dim)" stroke-width="0.7" stroke-dasharray="2 3"/>`);
      o.push(`<line x1="${cX}" y1="${cY}" x2="${X(holes[1].x)}" y2="${Y(holes[1].y)}" stroke="var(--tool-dim)" stroke-width="0.7" stroke-dasharray="2 3"/>`);
      o.push(`<path d="M${cX + ra * Math.cos(a0)},${cY - ra * Math.sin(a0)}A${ra},${ra} 0 ${large} ${sweep} ${cX + ra * Math.cos(a1)},${cY - ra * Math.sin(a1)}" fill="none" stroke="var(--tool-dim)" stroke-width="1"/>`);
      const am = a0 + (d.sign * d.step * DEG) / 2;
      o.push(`<text x="${cX + (ra + 14) * Math.cos(am)}" y="${cY - (ra + 14) * Math.sin(am) + 4}" text-anchor="middle" font-size="11" class="halo" fill="var(--ink)">${F(d.step, 5)}°</text>`);
    }
    // start angle from +X
    {
      const ra = Math.min(rs * 0.22, 36), a0 = ang(holes[0]);
      if (Math.abs(((d.start % 360) + 360) % 360) > 0.05) {
        const a = ((d.start % 360) + 360) % 360;
        o.push(`<line x1="${cX}" y1="${cY}" x2="${cX + ra + 10}" y2="${cY}" stroke="var(--tool-dim)" stroke-width="0.7"/>`);
        o.push(`<path d="M${cX + ra},${cY}A${ra},${ra} 0 ${a > 180 ? 1 : 0} 0 ${cX + ra * Math.cos(a0)},${cY - ra * Math.sin(a0)}" fill="none" stroke="var(--tool-hole)" stroke-width="1.2"/>`);
      }
    }
    // holes
    holes.forEach((h, idx) => {
      const x = X(h.x), y = Y(h.y), first = h.i === 1, cur = h.i === sel;
      const g = first ? `<g class="knob" data-k="h1" tabindex="0" role="slider" aria-label="Hole 1, at ${F(h.deg, 5)} degrees: drag round the circle, or arrow keys" aria-valuenow="${d.start}">` : `<g class="pick" data-i="${h.i}">`;
      o.push(g + `<circle class="kf" cx="${x}" cy="${y}" r="${hr + 7}" fill="transparent" stroke="none"/>`
        + `<circle class="kc" cx="${x}" cy="${y}" r="${hr}" fill="${cur ? 'color-mix(in srgb, var(--tool-hole) 32%, var(--sunken))' : 'var(--sunken)'}" stroke="${first ? 'var(--tool-hole)' : 'var(--ink)'}" stroke-width="${first || cur ? 2 : 1.3}"/>`
        + (hr > 7 ? `<path d="M${x - 4},${y}h8M${x},${y - 4}v8" stroke="var(--ink-soft)" stroke-width="0.8"/>` : '')
        + `</g>`);
      const out = (hr + 13) / (rs || 1);
      const lx = cX + (x - cX) * (1 + out), ly = cY + (y - cY) * (1 + out);
      if (holes.length <= 36 || first || cur || idx === holes.length - 1) o.push(`<text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="${first || cur ? 12 : 11}" font-weight="${first || cur ? 700 : 400}" class="halo" fill="${first ? 'var(--tool-hole)' : cur ? 'var(--ink)' : 'var(--ink-soft)'}">${h.i}</text>`);
    });
    // hole size knob on hole 1's outer edge
    const h1 = holes[0], a1 = ang(h1);
    const ex = X(h1.x) + hr * Math.cos(a1 + 0.9), ey = Y(h1.y) - hr * Math.sin(a1 + 0.9);
    o.push(`<g class="knob" data-k="hole" tabindex="0" role="slider" aria-label="Hole diameter ${F(d.hole)} mm: drag the edge, or arrow keys">`
      + `<circle class="kf" cx="${ex}" cy="${ey}" r="11" fill="transparent" stroke="none"/>`
      + `<rect class="kc" x="${ex - 4.5}" y="${ey - 4.5}" width="9" height="9" fill="var(--surface)" stroke="var(--tool-hole)" stroke-width="2"/></g>`);
    const hx = X(h1.x) + (hr + 12) * Math.cos(a1 + 0.9), hy = Y(h1.y) - (hr + 12) * Math.sin(a1 + 0.9);
    o.push(`<text x="${hx}" y="${hy + 4}" text-anchor="${Math.cos(a1 + 0.9) >= 0 ? 'start' : 'end'}" font-size="11" class="halo" fill="var(--tool-hole)">Ø${F(d.hole)}</text>`);
    // PCD knob on the ring, half a step past the last hole (between holes)
    const aPk = d.full ? ang(holes[holes.length - 1]) + (d.sign * d.step * DEG) / 2 : ang(holes[0]) + d.sign * (((d.arc || 0) / 2 + 180) * DEG);
    const px = cX + rs * Math.cos(aPk), py = cY - rs * Math.sin(aPk);
    o.push(`<g class="knob" data-k="pcd" tabindex="0" role="slider" aria-label="Bolt circle diameter ${F(d.pcd)} mm: drag the ring in or out, or arrow keys">`
      + `<circle class="kf" cx="${px}" cy="${py}" r="12" fill="transparent" stroke="none"/>`
      + `<path class="kc" d="M${px},${py - 7}L${px + 7},${py}L${px},${py + 7}L${px - 7},${py}Z" fill="var(--tool-ring)" stroke="var(--sunken)" stroke-width="1.5"/></g>`);
    const pl = rs + 16;
    const plx = cX + pl * Math.cos(aPk), plab = `PCD ${F(d.pcd)}`, pw = plab.length * 7.4;
    let anc = Math.cos(aPk) >= 0.2 ? 'start' : Math.cos(aPk) <= -0.2 ? 'end' : 'middle';
    if (anc === 'start' && plx + pw > W - 4) anc = 'end'; else if (anc === 'end' && plx - pw < 4) anc = 'start';
    o.push(`<text x="${anc === 'end' && Math.cos(aPk) > 0 ? cX + (rs - 12) * Math.cos(aPk) : anc === 'start' && Math.cos(aPk) < 0 ? cX + (rs - 12) * Math.cos(aPk) : plx}" y="${cY - pl * Math.sin(aPk) + 4}" text-anchor="${anc}" font-size="12" font-weight="600" class="halo" fill="var(--tool-ring)">${plab}</text>`);
    // arc end knob: the last hole, in arc mode
    if (!d.full && holes.length > 1) {
      const hl = holes[holes.length - 1];
      o.push(`<g class="knob" data-k="arc" tabindex="0" role="slider" aria-label="Arc span ${F(d.arc)} degrees: drag the last hole round, or arrow keys">`
        + `<circle class="kf" cx="${X(hl.x)}" cy="${Y(hl.y)}" r="${hr + 7}" fill="transparent" stroke="none"/>`
        + `<circle class="kc" cx="${X(hl.x)}" cy="${Y(hl.y)}" r="${hr + 4}" fill="none" stroke="var(--tool-ring)" stroke-width="1.5" stroke-dasharray="3 2"/></g>`);
      const ra = rs + Math.max(hr * 1.6, 12) + 10, a0 = ang(holes[0]), a2 = ang(hl);
      o.push(`<path d="M${cX + ra * Math.cos(a0)},${cY - ra * Math.sin(a0)}A${ra},${ra} 0 ${d.arc > 180 ? 1 : 0} ${d.sign > 0 ? 0 : 1} ${cX + ra * Math.cos(a2)},${cY - ra * Math.sin(a2)}" fill="none" stroke="var(--tool-ring)" stroke-width="1" stroke-opacity="0.7"/>`);
      const am = a0 + (d.sign * (d.arc || 0) * DEG) / 2, rl = ra + 12;
      o.push(`<text x="${cX + rl * Math.cos(am)}" y="${cY - rl * Math.sin(am) + 4}" text-anchor="${Math.cos(am) > 0.2 ? 'start' : Math.cos(am) < -0.2 ? 'end' : 'middle'}" font-size="11.5" font-weight="600" class="halo" fill="var(--tool-ring)">arc ${F(d.arc)}°</text>`);
    }
    // centre (drag it)
    o.push(`<g class="knob" data-k="c" tabindex="0" role="slider" aria-label="Centre at ${F(d.cx)}, ${F(d.cy)}: drag, or arrow keys">`
      + `<circle class="kf" cx="${cX}" cy="${cY}" r="12" fill="transparent" stroke="none"/>`
      + `<circle class="kc" cx="${cX}" cy="${cY}" r="6" fill="var(--surface)" stroke="var(--ink)" stroke-width="1.4"/>`
      + `<path d="M${cX - 11},${cY}h22M${cX},${cY - 11}v22" stroke="var(--ink)" stroke-width="1"/></g>`);
    if (Math.abs(d.cx) > 1e-9 || Math.abs(d.cy) > 1e-9) o.push(`<text x="${cX + 10}" y="${cY + 18}" font-size="10.5" class="halo" fill="var(--ink-soft)">(${F(d.cx)}, ${F(d.cy)})</text>`);
    // overall clear diameter across the hole edges, as a dimension under the plate
    if (d.hole > 0) {
      const yd = cY + plateR + 16, x1 = cX - rs - hr, x2 = cX + rs + hr;
      if (yd < H - 40) {
        o.push(`<line x1="${x1}" x2="${x2}" y1="${yd}" y2="${yd}" stroke="var(--tool-dim)" stroke-width="0.8"/><path d="M${x1},${yd}l6,-3v6zM${x2},${yd}l-6,-3v6z" fill="var(--tool-dim)"/>`);
        o.push(`<text x="${cX}" y="${yd + 13}" text-anchor="middle" font-size="10.5" class="halo" fill="var(--ink-soft)">over hole edges ${F(d.pcd + d.hole, 5)}</text>`);
      }
    }
    svg.innerHTML = o.join('');
    svg.classList.toggle('dragging', !!drag);
    hint.textContent = 'Drag hole 1 to turn the pattern · ◆ the ring for PCD · ■ the hole edge for Ø · the centre to move it · click a hole to read it';
  }

  function drawSheet() {
    if (!d || !res) { dro.replaceChildren(); list.replaceChildren(); facts.replaceChildren(); return; }
    const rows = res.tables?.[0]?.rows || [];
    const row = rows[sel - 1] || rows[0];
    droHead.textContent = `Hole ${row?.[0] ?? '–'} of ${rows.length} · from the origin`;
    const unit = (t) => el('small', {}, t);
    dro.replaceChildren(
      el('span', { class: 'ax' }, 'X'), el('span', { class: 'v' }, String(row?.[2] ?? '–'), unit('mm')),
      el('span', { class: 'ax' }, 'Y'), el('span', { class: 'v' }, String(row?.[3] ?? '–'), unit('mm')),
      el('span', { class: 'ax' }, 'A'), el('span', { class: 'v', style: 'font-size:17px' }, String(row?.[1] ?? '–'), unit('°')));
    stepN.textContent = `${sel} / ${rows.length}`;
    const val = (label) => (res.values || []).find((v) => v.label === label);
    const fact = (label, short) => { const v = val(label); return el('div', { class: v?.tone || '' }, short, el('b', {}, `${v?.value ?? '–'}${v?.unit && v.value !== '–' ? ` ${v.unit}` : ''}`)); };
    facts.replaceChildren(fact('Angle between holes', 'step'), fact('Chord between neighbours', 'chord'), fact('Material between holes', 'web'));
    const t = res.tables[0];
    list.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, t.columns.map((c) => el('th', {}, c.replace(' (mm)', '').replace(' (°)', ' °'))))),
      el('tbody', {}, rows.map((r) => el('tr', { 'data-i': r[0], tabindex: '0', 'aria-selected': String(r[0] === sel),
        onclick: () => select(r[0]),
        onkeydown: (e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); select(sel + (e.key === 'ArrowDown' ? 1 : -1)); list.querySelector(`tr[data-i="${sel}"]`)?.focus(); }
        } }, r.map((c) => el('td', {}, String(c))))))));
  }

  function drawMsgs() { msgs.replaceChildren(...(res?.warnings || []).map((w) => el('div', {}, w))); }

  // ---------- interaction ----------
  const pt = (e) => {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)];
  };
  const toMM = (p, V) => [(p[0] - V.ox) / V.s, (V.oy - p[1]) / V.s];
  const q = (V) => (V.s > 8 ? 0.1 : V.s > 2 ? 0.5 : 1);

  function keyStep(k, key, big) {
    const dir = key === 'ArrowUp' || key === 'ArrowRight' ? 1 : -1;
    if (k === 'h1') ctx.set('start', String(round((d.start + dir * (big ? 15 : 1) + 360) % 360, 1e-4)));
    else if (k === 'pcd') ctx.set('pcd', String(Math.max(0.1, round(d.pcd + dir * (big ? 10 : 1), 1e-4))));
    else if (k === 'hole') ctx.set('hole', String(Math.max(0.1, round(d.hole + dir * (big ? 1 : 0.1), 1e-4))));
    else if (k === 'arc') ctx.set('arc', String(Math.max(1, Math.min(360, round((d.arc || 0) + dir * (big ? 15 : 1), 1e-4)))));
    else if (k === 'c') {
      const st = big ? 10 : 1;
      if (key === 'ArrowLeft' || key === 'ArrowRight') ctx.set('cx', String(round(d.cx + dir * st, 1e-4)));
      else ctx.set('cy', String(round(d.cy + dir * st, 1e-4)));
    }
  }
  svg.addEventListener('keydown', (e) => {
    const k = e.target.closest?.('.knob')?.dataset.k;
    if (!k || !d) return;
    if (e.key === '+' || e.key === '=' || e.key === '-') { e.preventDefault(); bumpN(e.key === '-' ? -1 : 1); return; }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    keyStep(k, e.key, e.shiftKey);
    requestAnimationFrame(() => svg.querySelector(`[data-k="${k}"]`)?.focus());
  });
  svg.addEventListener('pointerdown', (e) => {
    if (!d) return;
    const pick = e.target.closest('.pick');
    if (pick) { select(Number(pick.dataset.i)); return; }
    const kn = e.target.closest('.knob');
    if (!kn) return;
    e.preventDefault();
    frozen = { ...svg._V };
    const k = kn.dataset.k;
    drag = { k, p0: toMM(pt(e), frozen), cx0: d.cx, cy0: d.cy, moved: false };
    if (k === 'h1') sel = 1;
    kn.focus({ preventScroll: true });
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || !d) return;
    const V = frozen, m = toMM(pt(e), V);
    const rx = m[0] - d.cx, ry = m[1] - d.cy;
    const a = ((Math.atan2(ry, rx) / DEG) + 360) % 360;
    drag.moved = true;
    const setIf = (key, v) => { if (String(v) !== String(num(ctx.raw[key]))) ctx.set(key, String(v)); };
    if (drag.k === 'h1') setIf('start', round(a, e.shiftKey ? 0.1 : 1) % 360);
    else if (drag.k === 'pcd') setIf('pcd', Math.max(q(V), round(2 * Math.hypot(rx, ry), q(V))));
    else if (drag.k === 'hole') {
      const h1 = d.holes[0];
      setIf('hole', Math.max(0.1, round(2 * Math.hypot(m[0] - h1.x, m[1] - h1.y), V.s > 4 ? 0.1 : 0.5)));
    } else if (drag.k === 'arc') {
      const a0 = d.start;
      let span = d.sign > 0 ? a - a0 : a0 - a;
      span = ((span % 360) + 360) % 360;
      if (span < 1) span = 360;
      setIf('arc', Math.max(1, round(span, e.shiftKey ? 0.1 : 1)));
    } else if (drag.k === 'c') {
      const nx = round(drag.cx0 + m[0] - drag.p0[0], q(V)), ny = round(drag.cy0 + m[1] - drag.p0[1], q(V));
      if (String(nx) !== String(num(ctx.raw.cx)) || String(ny) !== String(num(ctx.raw.cy))) ctx.setMany({ cx: String(nx), cy: String(ny) });
    }
  });
  const end = () => {
    if (!drag) return;
    const k = drag.k;
    drag = null; frozen = null;
    svg.classList.remove('dragging');
    drawTable();
    requestAnimationFrame(() => svg.querySelector(`[data-k="${k}"]`)?.focus({ preventScroll: true }));
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('lostpointercapture', end);

  ctx.onResult((r) => {
    res = r;
    d = r.drawing || null;
    if (d && sel > d.holes.length) sel = 1;
    syncControls();
    drawMsgs();
    drawSheet();
    drawTable();
  });
  new ResizeObserver(() => { if (!drag) drawTable(); }).observe(table);
}
