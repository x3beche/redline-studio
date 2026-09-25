// Cable Bend Radius: the cable leaving the panel. A drawer of cable ends in
// section to pick the cable by what it looks like; the cable itself, to
// scale, coming out of its gland and turning, with the zone it may not be
// bent into, the depth it needs behind the panel and, for a moving cable,
// the drag chain it runs in. Grab the cable's end to change the angle, the
// gland end of the bend to change the straight lead-out, the jacket edge to
// change the diameter, the thermometer for the laying temperature.
// Every number drawn comes from run()'s result (result.drawing, values, tables).

const DEG = Math.PI / 180;
const NS = 'http://www.w3.org/2000/svg';

const CSS = `
:root { --tool-jacket: #3b4a57; --tool-cu: #c26a00; --tool-shield: #7b8a97; --tool-core: #1f4ed8; --tool-keep: #c0392b; --tool-chain: #0f8a78; --tool-dim: #5b6b7a;
  --tool-cable: color-mix(in srgb, #3b4a57 70%, var(--surface)); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-jacket: #9fb0bf; --tool-cu: #f0a33a; --tool-shield: #8ea0b0; --tool-core: #7d9bff; --tool-keep: #e57373; --tool-chain: #3cc7b3; --tool-dim: #8ea0b0;
  --tool-cable: color-mix(in srgb, #9fb0bf 38%, var(--surface)); } }
:root[data-theme="dark"] { --tool-jacket: #9fb0bf; --tool-cu: #f0a33a; --tool-shield: #8ea0b0; --tool-core: #7d9bff; --tool-keep: #e57373; --tool-chain: #3cc7b3; --tool-dim: #8ea0b0;
  --tool-cable: color-mix(in srgb, #9fb0bf 38%, var(--surface)); }
.k-page { padding: 10px 12px; }
.cb { display: grid; grid-template-columns: 236px minmax(0, 1fr); grid-template-areas: "drawer scene" "drawer msgs" "out out"; gap: 10px 12px; align-items: start; }
.cb [hidden] { display: none !important; }
.cb-drawer { grid-area: drawer; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0;
  max-height: clamp(420px, calc(100vh - 78px), 980px); overflow: auto; }
.cb-drawer h2 { position: sticky; top: 0; z-index: 1; margin: 0; background: var(--surface); font-size: 11.5px; font-weight: 500; color: var(--ink-soft);
  padding: 6px 10px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
.cb-grp { font-size: 10.5px; color: var(--ink-soft); padding: 6px 10px 2px; text-transform: uppercase; letter-spacing: 0.04em; }
.cb-type { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; gap: 8px; align-items: center; width: 100%; text-align: left;
  border: 0; border-left: 3px solid transparent; background: transparent; padding: 4px 8px 4px 7px; cursor: pointer; color: var(--ink); }
.cb-type:hover { background: var(--sunken); }
.cb-type[aria-checked="true"] { background: var(--sunken); border-left-color: var(--accent); }
.cb-type svg { width: 38px; height: 38px; display: block; }
.cb-type .nm { font-size: 11.5px; line-height: 1.25; min-width: 0; }
.cb-type .rr { font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); text-align: right; white-space: nowrap; }
.cb-type .rr b { display: block; color: var(--ink); font-weight: 500; font-size: 12px; }
.cb-type[aria-checked="true"] .rr b { color: var(--accent); }
.cb-scene { grid-area: scene; position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0;
  height: clamp(420px, calc(100vh - 150px), 900px); overflow: hidden; display: flex; flex-direction: column; }
.cb-bar { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); font-size: 12px; color: var(--ink-soft); }
.cb-bar label { display: inline-flex; align-items: center; gap: 5px; }
.cb-bar input { width: 56px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 3px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.cb-bar input.bad { border-color: var(--danger); }
.cb-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.cb-seg button { border: 0; background: transparent; padding: 3px 10px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.cb-seg button + button { border-left: 1px solid var(--line); }
.cb-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.cb-stage { position: relative; flex: 1; min-height: 0; }
.cb-stage svg { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.cb-read { position: absolute; right: 10px; top: 8px; display: grid; grid-template-columns: auto auto; gap: 1px 10px; font-size: 11.5px; color: var(--ink-soft);
  background: color-mix(in srgb, var(--surface) 88%, transparent); border: 1px solid var(--line-soft); border-radius: 5px; padding: 5px 9px; pointer-events: none; }
.cb-read b { font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); text-align: right; }
.cb-read .main { font-size: 17px; color: var(--accent); }
.cb-foot { position: absolute; left: 10px; bottom: 6px; font-size: 11px; color: var(--ink-soft); pointer-events: none; max-width: calc(100% - 90px); }
.cb-msgs { grid-area: msgs; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.cb-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.cb-msgs div.src { border-left-color: var(--line); color: var(--ink-soft); }
.cb-msgs:empty { display: none; }
.cb-out { grid-area: out; min-width: 0; }
.cb svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.cb .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.cb .knob { cursor: grab; outline: none; }
.cb .knob:focus-visible .kc { stroke: var(--accent); stroke-width: 3px; }
.cb .knob:focus-visible .kf { stroke: var(--accent); stroke-width: 1.5px; stroke-dasharray: 3 2; }
.cb .dragging, .cb .dragging * { cursor: grabbing !important; }
@media (max-width: 760px) {
  .cb { grid-template-columns: minmax(0, 1fr); grid-template-areas: "scene" "drawer" "msgs" "out"; }
  .cb-scene { height: 560px; }
  .cb-drawer { max-height: none; display: grid; grid-template-columns: 1fr 1fr; }
  .cb-drawer h2, .cb-grp { grid-column: 1 / -1; }
  .cb-type { grid-template-columns: 30px minmax(0, 1fr); }
  .cb-type svg { width: 30px; height: 30px; }
  .cb-type .rr { grid-column: 2; text-align: left; }
  .cb-type .rr b { display: inline; margin-right: 4px; }
  .cb-read { position: static; margin: 6px 8px 0; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto; font-size: 10.5px; gap: 1px 6px; }
  .cb-read b { font-size: 11.5px; }
  .cb-read .main { font-size: 14px; }
  .cb-foot { display: none; }
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

// Cable ends in section, 40 x 40, by type: what the cable looks like cut.
const ring = (r, col, w = 1.2, extra = '') => `<circle cx="20" cy="20" r="${r}" fill="none" stroke="${col}" stroke-width="${w}" ${extra}/>`;
const dot = (x, y, r, fill, stroke = 'none') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>`;
const around = (n, rr, r, fill, stroke, off = 0) => Array.from({ length: n }, (_, i) => dot(20 + rr * Math.cos(off + (2 * Math.PI * i) / n), 20 + rr * Math.sin(off + (2 * Math.PI * i) / n), r, fill, stroke)).join('');
const pairs = (n, rr) => Array.from({ length: n }, (_, i) => {
  const a = (2 * Math.PI * i) / n + Math.PI / 4, cx = 20 + rr * Math.cos(a), cy = 20 + rr * Math.sin(a), o = 2.3;
  return dot(cx - o * Math.sin(a), cy + o * Math.cos(a), 2.2, 'var(--tool-cu)', 'var(--tool-core)') + dot(cx + o * Math.sin(a), cy - o * Math.cos(a), 2.2, 'var(--tool-cu)', 'var(--surface)');
}).join('');
const flatBand = (layers) => {
  const h = 4 + layers * 3, y = 20 - h / 2;
  let s = `<rect x="3" y="${y}" width="34" height="${h}" rx="1.5" fill="var(--tool-cable)" stroke="var(--tool-jacket)" stroke-width="1"/>`;
  for (let l = 0; l < layers; l++) for (let i = 0; i < 6; i++) s += `<rect x="${6 + i * 5.2}" y="${y + 2 + l * 3}" width="3.4" height="1.4" fill="var(--tool-cu)"/>`;
  return s;
};
const GLYPH = {
  pvcPower: () => dot(20, 20, 16, 'var(--tool-cable)', 'var(--tool-jacket)') + around(3, 6.5, 5, 'var(--tool-cu)', 'var(--tool-core)', -Math.PI / 2),
  armoured: () => dot(20, 20, 17, 'var(--tool-cable)', 'var(--tool-jacket)') + around(22, 14, 1.4, 'var(--tool-shield)') + around(3, 5.8, 4.2, 'var(--tool-cu)', 'var(--tool-core)', -Math.PI / 2),
  control: () => dot(20, 20, 16, 'var(--tool-cable)', 'var(--tool-jacket)') + around(6, 8.5, 3, 'var(--tool-cu)', 'var(--tool-core)') + dot(20, 20, 3, 'var(--tool-cu)', 'var(--tool-core)'),
  controlScr: () => dot(20, 20, 17, 'var(--tool-cable)', 'var(--tool-jacket)') + ring(13.5, 'var(--tool-shield)', 1.6, 'stroke-dasharray="1.5 1"') + around(6, 7.5, 2.6, 'var(--tool-cu)', 'var(--tool-core)') + dot(20, 20, 2.6, 'var(--tool-cu)', 'var(--tool-core)'),
  chain: () => dot(20, 20, 17, 'var(--tool-cable)', 'var(--tool-jacket)') + ring(15, 'var(--tool-jacket)', 2) + around(8, 9, 2.6, 'var(--tool-cu)', 'var(--tool-core)') + around(3, 3.6, 2.2, 'var(--tool-cu)', 'var(--tool-core)'),
  hookup: () => dot(20, 20, 9, 'var(--tool-cable)', 'var(--tool-jacket)') + around(6, 3.2, 1.6, 'var(--tool-cu)') + dot(20, 20, 1.6, 'var(--tool-cu)'),
  silicone: () => dot(20, 20, 12, 'var(--tool-cable)', 'var(--tool-jacket)') + around(10, 4.4, 1.2, 'var(--tool-cu)') + around(5, 2, 1.2, 'var(--tool-cu)') + dot(20, 20, 1.2, 'var(--tool-cu)'),
  utp: () => dot(20, 20, 15, 'var(--tool-cable)', 'var(--tool-jacket)') + pairs(4, 7),
  stp: () => dot(20, 20, 17, 'var(--tool-cable)', 'var(--tool-jacket)') + ring(14.5, 'var(--tool-shield)', 1.6) + pairs(4, 7.2),
  multipair: () => dot(20, 20, 18, 'var(--tool-cable)', 'var(--tool-jacket)') + pairs(8, 11) + pairs(3, 4),
  coax: () => dot(20, 20, 15, 'var(--tool-cable)', 'var(--tool-jacket)') + ring(11.5, 'var(--tool-shield)', 2, 'stroke-dasharray="1.6 1"') + dot(20, 20, 10, 'var(--surface)', 'var(--tool-jacket)') + dot(20, 20, 2.8, 'var(--tool-cu)'),
  semirigid: () => dot(20, 20, 12, 'var(--tool-cu)') + dot(20, 20, 9.5, 'var(--surface)') + dot(20, 20, 2.6, 'var(--tool-cu)'),
  usb: () => dot(20, 20, 15, 'var(--tool-cable)', 'var(--tool-jacket)') + ring(12.5, 'var(--tool-shield)', 1.4) + pairs(2, 5) + around(2, 7, 2, 'var(--tool-cu)', 'var(--tool-core)', 0),
  fibre: () => dot(20, 20, 13, 'var(--tool-cable)', 'var(--tool-jacket)') + ring(8.5, 'var(--tool-cu)', 1.2, 'stroke-dasharray="0.8 1.2"') + dot(20, 20, 4.5, 'var(--surface)', 'var(--tool-jacket)') + dot(20, 20, 1.2, 'var(--tool-core)'),
  ffc: () => flatBand(1),
  fpc1: () => flatBand(1).replace(/rx="1.5"/, 'rx="0"'),
  fpc2: () => flatBand(2).replace(/rx="1.5"/, 'rx="0"'),
  fpcN: () => flatBand(4).replace(/rx="1.5"/, 'rx="0"'),
  custom: () => dot(20, 20, 14, 'var(--tool-cable)', 'var(--tool-jacket)') + '<text x="20" y="25" text-anchor="middle" font-size="14" fill="var(--ink)">k</text>',
};
const GROUPS = [
  ['Power and control', ['pvcPower', 'armoured', 'control', 'controlScr', 'chain', 'hookup', 'silicone']],
  ['Data and signal', ['utp', 'stp', 'multipair', 'coax', 'semirigid', 'usb', 'fibre']],
  ['Flat and flex', ['ffc', 'fpc1', 'fpc2', 'fpcN']],
  ['Other', ['custom']],
];

export function page(root, ctx) {
  document.head.append(el('style', { text: CSS }));
  const F = (v, dg = 4) => (Number.isFinite(v) ? ctx.fmtNum(v, dg) : '–');
  const typeDef = ctx.manifest.inputs.find((i) => i.key === 'type');
  const LABEL = Object.fromEntries(typeDef.options.map(([v, t]) => [v, t]));
  let d = null, res = null, drag = null, frozen = null;

  // ---------- the drawer of cable ends ----------
  const drawer = el('div', { class: 'cb-drawer', role: 'radiogroup', 'aria-label': 'Cable type' });

  // ---------- the scene ----------
  const inputs = {};
  const field = (key, label, unit, w) => {
    const i = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label}${unit ? ` in ${unit}` : ''}`, style: w ? `width:${w}px` : null });
    i.addEventListener('change', () => ctx.set(key, i.value.trim()));
    i.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const st = { od: e.shiftKey ? 1 : 0.1, angle: e.shiftKey ? 15 : 5, straight: e.shiftKey ? 10 : 1, temp: e.shiftKey ? 10 : 1, mult: e.shiftKey ? 1 : 0.5 }[key];
      const v = round((num(i.value) || 0) + (e.key === 'ArrowUp' ? st : -st), 1e-4);
      i.value = String(v); ctx.set(key, String(v));
    });
    inputs[key] = i;
    return el('label', {}, label, i, unit);
  };
  const segUse = el('span', { class: 'cb-seg', role: 'group', 'aria-label': 'Use' });
  const odLab = el('span');
  const multWrap = el('span', {}, field('mult', 'k', '× OD', 48));
  const bar = el('div', { class: 'cb-bar' }, segUse,
    el('label', {}, odLab, (() => { const f = field('od', '', 'mm'); return f; })()),
    field('angle', 'bend', '°', 48), field('straight', 'lead-out', 'mm', 50), field('temp', 'laid at', '°C', 44), multWrap);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'The cable leaving the panel, to scale');
  const read = el('div', { class: 'cb-read', 'aria-live': 'polite' });
  const foot = el('div', { class: 'cb-foot' });
  const stage = el('div', { class: 'cb-stage' }, svg, foot);
  const scene = el('div', { class: 'cb-scene' }, bar, read, stage);
  const msgs = el('div', { class: 'cb-msgs', 'aria-live': 'polite' });
  root.append(el('div', { class: 'cb' }, drawer, scene, msgs, el('div', { class: 'cb-out' }, ctx.outputs)));

  function drawDrawer() {
    const raw = ctx.raw;
    const rows = res?.tables?.[0]?.rows || [];
    const byLabel = Object.fromEntries(rows.map((r) => [r[0], r]));
    const flexing = raw.use === 'flex';
    const kids = [el('h2', {}, el('span', {}, 'Cable'), el('span', {}, `R min at ${F(d?.od ?? num(raw.od))} mm, ${flexing ? 'flexing' : 'fixed'}`))];
    for (const [g, keys] of GROUPS) {
      kids.push(el('div', { class: 'cb-grp' }, g));
      for (const k of keys) {
        const r = byLabel[LABEL[k]];
        const cur = raw.type === k;
        let rr = null;
        if (k === 'custom') rr = el('span', { class: 'rr' }, cur && d ? el('b', {}, F(d.R)) : null, 'your k');
        else if (r) {
          const R = flexing ? r[4] : r[2], mult = flexing ? r[3] : r[1];
          rr = el('span', { class: 'rr' }, el('b', {}, R === '–' ? 'fixed only' : R), R === '–' ? '' : mult);
        } else rr = el('span', { class: 'rr' }, (/^(ffc|fpc)/.test(k) ? '× thickness' : '× OD'));
        const svgG = document.createElementNS(NS, 'svg');
        svgG.setAttribute('viewBox', '0 0 40 40');
        svgG.setAttribute('aria-hidden', 'true');
        svgG.innerHTML = GLYPH[k]();
        kids.push(el('button', { class: 'cb-type', role: 'radio', 'aria-checked': String(cur), tabindex: cur ? '0' : '-1', 'data-k': k,
          onclick: () => ctx.set('type', k),
          onkeydown: (e) => {
            const all = GROUPS.flatMap((x) => x[1]);
            const i = all.indexOf(k);
            const j = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? i - 1 : null;
            if (j == null) return;
            e.preventDefault();
            const nk = all[(j + all.length) % all.length];
            ctx.set('type', nk);
            requestAnimationFrame(() => drawer.querySelector(`[data-k="${nk}"]`)?.focus());
          } }, svgG, el('span', { class: 'nm' }, LABEL[k].replace(/ \(.*\)$/, '')), rr));
      }
    }
    const top = drawer.scrollTop;
    drawer.replaceChildren(...kids);
    drawer.scrollTop = top;
  }

  function syncControls() {
    const raw = ctx.raw;
    for (const [k, i] of Object.entries(inputs)) {
      if (document.activeElement !== i) i.value = raw[k] ?? '';
      i.classList.toggle('bad', String(raw[k] ?? '').trim() !== '' && ctx.input[k] == null);
    }
    segUse.replaceChildren(...[['fixed', 'fixed', 'Bent once and clamped'], ['flex', 'flexing', 'Moves in use: drag chain, door, arm']].map(([v, t, title]) =>
      el('button', { 'aria-pressed': String(raw.use === v), title, onclick: () => ctx.set('use', v) }, t)));
    odLab.textContent = d?.flat || /^(ffc|fpc)/.test(raw.type) ? 'thickness' : 'OD';
    multWrap.hidden = raw.type !== 'custom';
  }

  // ---------- geometry (mm; panel face at x = 0, cable axis along +x, bending up) ----------
  function geom(g) {
    const th = g.deg * DEG, C = [g.L0, g.Rc];
    const at = (r, a) => [C[0] + r * Math.sin(a), C[1] - r * Math.cos(a)]; // a = 0 at the start of the bend
    const dir = [Math.cos(th), Math.sin(th)];
    let tail = Math.max(2.5 * g.od, 0.7 * g.Rc);
    // past 90 degrees the tail heads back to the panel: stop it short of the panel
    if (Math.cos(th) < -1e-6) { const x1 = C[0] + g.Rc * Math.sin(th); tail = Math.max(1.5 * g.od, Math.min(tail, (x1 - 1.2 * g.od) / -Math.cos(th))); }
    const end = (r) => { const p = at(r, th); return [p[0] + tail * dir[0], p[1] + tail * dir[1]]; };
    return { th, C, at, dir, tail, end };
  }
  function fit(W, H, g, G) {
    const pts = [[-(4.4 * g.od + 5), -g.od * 2], [g.L0 + g.Ro, 0], G.end(g.Rc - g.od / 2), G.end(g.Rc + g.od / 2), G.at(g.Ro, Math.min(G.th, Math.PI / 2)), [0, g.Rc + g.Ro * 0.2]];
    if (g.deg > 90) pts.push([g.L0 + g.Ro, g.Rc], G.at(g.Ro, Math.PI));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const narrow = W < 520;
    const pad = { l: narrow ? 20 : 50, r: narrow ? 56 : 250, t: narrow ? 30 : 50, b: narrow ? 56 : 84 };
    const s = Math.max(1e-3, Math.min((W - pad.l - pad.r) / Math.max(1e-6, x1 - x0), (H - pad.t - pad.b) / Math.max(1e-6, y1 - y0)));
    return { s, ox: pad.l + ((W - pad.l - pad.r) - s * (x1 - x0)) / 2 - s * x0, oy: pad.t + ((H - pad.t - pad.b) - s * (y1 - y0)) / 2 + s * y1 };
  }
  const arrow = (x, y, ang, col = 'var(--tool-dim)') => {
    const L = 7, w = 2.6, c = Math.cos(ang), s = Math.sin(ang);
    return `<path d="M${x},${y}L${x - L * c + w * s},${y - L * s - w * c}L${x - L * c - w * s},${y - L * s + w * c}Z" fill="${col}"/>`;
  };

  // the thermometer's span on the stage: under the readout when it floats over the drawing
  const thermo = (H) => {
    const float = getComputedStyle(read).position === 'absolute';
    const t0 = float ? read.offsetTop + read.offsetHeight - stage.offsetTop + 26 : 26;
    return [t0, Math.max(t0 + 80, Math.min(H - 70, t0 + 240))];
  };

  function drawScene() {
    const W = Math.max(240, stage.clientWidth), H = Math.max(200, stage.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!d) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--danger)">${esc((res?.warnings || ['No cable'])[0])}</text>`;
      read.replaceChildren();
      return;
    }
    const g = d, G = geom(g);
    const V = frozen || fit(W, H, g, G);
    svg._V = V;
    const X = (p) => [V.ox + V.s * p[0], V.oy - V.s * p[1]];
    const P = (p) => X(p).map((v) => v.toFixed(2)).join(',');
    const o = [];
    const s = V.s;
    // hatch for the keep-out zone
    o.push(`<defs><pattern id="cb-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="var(--tool-keep)" stroke-width="1.2" stroke-opacity="0.45"/></pattern></defs>`);
    // the panel, in section
    const top = X([0, 0])[1] - Math.max(60, (g.Rc + g.Ro) * s * 1.1), bot = X([0, 0])[1] + Math.max(40, g.od * 3 * s);
    const px = X([0, 0])[0];
    o.push(`<rect x="${px - 10}" y="${Math.max(0, top)}" width="10" height="${Math.min(H, bot) - Math.max(0, top)}" fill="var(--tool-shield)" fill-opacity="0.35" stroke="var(--tool-shield)"/>`);
    o.push(`<text x="${px - 14}" y="${Math.max(14, top + 12)}" text-anchor="end" font-size="10.5" fill="var(--ink-soft)" transform="rotate(-90 ${px - 14} ${Math.max(14, top + 12)})">panel</text>`);
    // the keep-out zone: inside the minimum radius
    const Cx = X(G.C);
    if (g.R > 0) {
      const a0 = X(G.at(g.R, 0)), a1 = X(G.at(g.R, G.th));
      o.push(`<path d="M${Cx[0]},${Cx[1]}L${a0}A${g.R * s},${g.R * s} 0 ${G.th > Math.PI ? 1 : 0} 0 ${a1}Z" fill="url(#cb-hatch)" stroke="var(--tool-keep)" stroke-width="1" stroke-dasharray="4 3"/>`);
    }
    // drag chain, when it flexes: link plates outside the cable around the bend
    if (g.flexing && g.chainR) {
      const rc = g.chainR, rin = rc, rout = rc + g.od * 1.7;
      const n = Math.max(4, Math.round((G.th * (rin + rout) / 2) / Math.max(g.od * 1.3, 6 / s)));
      const Cc = [g.L0, rc + g.od / 2];
      for (let i = 0; i < n; i++) {
        const aa = (G.th * i) / n, ab = (G.th * (i + 1)) / n;
        const q = (r, a) => X([Cc[0] + r * Math.sin(a), Cc[1] - r * Math.cos(a)]);
        o.push(`<path d="M${q(rin - g.od * 0.35, aa)}L${q(rout - g.od * 0.35, aa)}A${(rout - g.od * 0.35) * s},${(rout - g.od * 0.35) * s} 0 0 0 ${q(rout - g.od * 0.35, ab)}L${q(rin - g.od * 0.35, ab)}A${(rin - g.od * 0.35) * s},${(rin - g.od * 0.35) * s} 0 0 1 ${q(rin - g.od * 0.35, aa)}Z" fill="none" stroke="var(--tool-chain)" stroke-width="1" stroke-opacity="0.8"/>`);
      }
      const lp = X([Cc[0] + (rout + g.od) * Math.sin(G.th / 2), Cc[1] - (rout + g.od) * Math.cos(G.th / 2)]);
      o.push(`<text x="${lp[0] + 6}" y="${lp[1] + 14}" font-size="11" font-weight="600" class="halo" fill="var(--tool-chain)">chain KR ${F(g.chainR)}</text>`);
    }
    // the cable: straight lead-out, bend, tail
    const ri = g.Rc - g.od / 2, ro = g.Rc + g.od / 2;
    const xin = -(10 / s) - Math.max(g.od * 1.6, 14 / s) - 2.5 * g.od;
    const i0 = X([xin, g.od / 2]), o0 = X([xin, -g.od / 2]);
    const iB0 = X(G.at(ri, 0)), oB0 = X(G.at(ro, 0)), iB1 = X(G.at(ri, G.th)), oB1 = X(G.at(ro, G.th));
    const iE = X(G.end(ri)), oE = X(G.end(ro));
    const large = G.th > Math.PI ? 1 : 0;
    const cable = `M${o0}L${oB0}A${ro * s},${ro * s} 0 ${large} 0 ${oB1}L${oE}L${iE}L${iB1}A${ri * s},${ri * s} 0 ${large} 1 ${iB0}L${i0}Z`;
    o.push(`<path d="${cable}" fill="var(--tool-cable)" stroke="var(--tool-jacket)" stroke-width="1.4" stroke-linejoin="round"/>`);
    // gland on the outside of the panel, a lock nut on the inside face
    const pw = 10 / s, gl = Math.max(g.od * 1.6, 14 / s), gh = g.od * 1.9;
    const g0 = X([-pw - gl, gh / 2]), g1 = X([-pw, -gh / 2]);
    o.push(`<rect x="${g0[0]}" y="${g0[1]}" width="${g1[0] - g0[0]}" height="${g1[1] - g0[1]}" rx="2" fill="var(--sunken)" stroke="var(--ink-soft)"/>`);
    for (let i = 1; i < 4; i++) { const xx = g0[0] + ((g1[0] - g0[0]) * i) / 4; o.push(`<line x1="${xx}" x2="${xx}" y1="${g0[1]}" y2="${g1[1]}" stroke="var(--line)" stroke-width="0.8"/>`); }
    const n0 = X([0, gh * 0.62]), n1 = X([Math.max(3 / s, g.od * 0.35), -gh * 0.62]);
    o.push(`<rect x="${n0[0]}" y="${n0[1]}" width="${n1[0] - n0[0]}" height="${n1[1] - n0[1]}" fill="var(--sunken)" stroke="var(--ink-soft)"/>`);
    o.push(`<text x="${(g0[0] + g1[0]) / 2}" y="${g1[1] + 13}" text-anchor="middle" font-size="10" fill="var(--ink-soft)">gland</text>`);
    // lead-out, highlighted
    o.push(`<path d="M${X([0, 0])}L${X([g.L0, 0])}" stroke="${g.flags.shortLead ? 'var(--danger)' : 'var(--ink-soft)'}" stroke-width="1" stroke-dasharray="1 3"/>`);
    // centre line
    const c0 = X([xin, 0]), cB0 = X(G.at(g.Rc, 0)), cB1 = X(G.at(g.Rc, G.th)), cE = X(G.end(g.Rc));
    o.push(`<path d="M${c0}L${cB0}A${g.Rc * s},${g.Rc * s} 0 ${large} 0 ${cB1}L${cE}" fill="none" stroke="var(--tool-core)" stroke-width="1" stroke-dasharray="9 3 2 3"/>`);
    // bend start and end tangent ticks
    for (const [a, b] of [[iB0, oB0], [iB1, oB1]]) o.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="var(--tool-jacket)" stroke-width="0.8" stroke-dasharray="2 2"/>`);
    // radius leader to the inside edge
    const rm = Math.min(G.th / 2, Math.PI / 3);
    const rp = X(G.at(g.R, rm));
    o.push(`<line x1="${Cx[0]}" y1="${Cx[1]}" x2="${rp[0]}" y2="${rp[1]}" stroke="var(--tool-keep)" stroke-width="1"/>` + arrow(rp[0], rp[1], Math.atan2(rp[1] - Cx[1], rp[0] - Cx[0]), 'var(--tool-keep)'));
    o.push(`<path d="M${Cx[0] - 5},${Cx[1]}h10M${Cx[0]},${Cx[1] - 5}v10" stroke="var(--ink-soft)"/>`);
    const lr = X(G.at(g.R * 0.45, rm + 0.35));
    o.push(`<text x="${lr[0]}" y="${lr[1]}" text-anchor="middle" font-size="13" font-weight="600" class="halo" fill="var(--tool-keep)">R min ${F(g.R)}</text>`);
    o.push(`<text x="${lr[0]}" y="${lr[1] + 14}" text-anchor="middle" font-size="10.5" class="halo" fill="var(--ink-soft)">${F(g.k, 3)} × ${g.flat ? 'T' : 'OD'} · keep out</text>`);
    // OD across the lead-out
    // arc length label along the outside of the bend
    const am = G.th / 2, al = X(G.at(ro + (g.flexing && g.chainR ? g.chainR - g.Rc + g.od * 2.2 : 0) + 14 / s, am));
    if (W >= 520) o.push(`<text x="${al[0] + 4}" y="${al[1]}" font-size="11" class="halo" fill="var(--tool-core)">${F(g.arc)} mm of cable in the ${F(g.deg, 4)}° bend</text>`);
    // depth behind the panel: for a 90° turn, panel to the outside of the cable
    const yd = X([0, -g.od / 2])[1] + 34;
    const xd = X([g.L0 + g.Ro, 0])[0];
    o.push(`<line x1="${px}" x2="${xd}" y1="${yd}" y2="${yd}" stroke="var(--ink)" stroke-width="1"/>` + arrow(px, yd, Math.PI, 'var(--ink)') + arrow(xd, yd, 0, 'var(--ink)'));
    o.push(`<line x1="${xd}" x2="${xd}" y1="${yd + 5}" y2="${Math.min(X(G.at(g.Ro, Math.min(G.th, Math.PI / 2)))[1], yd)}" stroke="var(--ink-soft)" stroke-width="0.7" stroke-dasharray="3 2"/>`);
    o.push(`<text x="${(px + xd) / 2}" y="${yd + 16}" text-anchor="middle" font-size="12.5" font-weight="600" class="halo" fill="var(--ink)">depth ${F(g.depth)} mm${Math.abs(g.deg - 90) > 0.5 ? ' (90° turn)' : ''}</text>`);
    // lead-out dimension
    const yl = X([0, g.od * 1.9 * 0.62])[1] - 12;
    if ((g.L0 - 0) * s > 30) {
      const xl = X([g.L0, 0])[0];
      o.push(`<line x1="${px}" x2="${xl}" y1="${yl}" y2="${yl}" stroke="var(--tool-dim)" stroke-width="0.8"/>` + arrow(px, yl, Math.PI) + arrow(xl, yl, 0));
      o.push(`<line x1="${xl}" x2="${xl}" y1="${yl - 4}" y2="${X([0, g.od / 2])[1] - 2}" stroke="var(--tool-dim)" stroke-width="0.6"/>`);
      o.push(`<text x="${(px + xl) / 2}" y="${yl - 4}" text-anchor="middle" font-size="10.5" class="halo" fill="${g.flags.shortLead ? 'var(--danger)' : 'var(--ink-soft)'}">straight ${F(g.L0)}${g.flags.shortLead ? ' < OD' : ''}</text>`);
    } else if (g.flags.shortLead) {
      o.push(`<text x="${px + 6}" y="${yl - 4}" font-size="10.5" class="halo" fill="var(--danger)">straight ${F(g.L0)} &lt; OD</text>`);
    }
    // knobs: cable end (angle), bend start (lead-out), jacket edge (OD)
    const eK = X(G.end(g.Rc));
    const knob = (k, p, label, shape) => `<g class="knob" data-k="${k}" tabindex="0" role="slider" aria-label="${label}"><circle class="kf" cx="${p[0]}" cy="${p[1]}" r="14" fill="transparent" stroke="none"/>${shape(p)}<title>${label}</title></g>`;
    o.push(knob('angle', eK, `Bend angle ${F(g.deg, 4)}°: drag the cable end round, or arrow keys`,
      (p) => `<path class="kc" d="M${p[0]},${p[1] - 8}L${p[0] + 8},${p[1]}L${p[0]},${p[1] + 8}L${p[0] - 8},${p[1]}Z" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/>`));
    o.push(knob('straight', cB0, `Straight lead-out ${F(g.L0)} mm: drag along the cable, or arrow keys`,
      (p) => `<rect class="kc" x="${p[0] - 5}" y="${p[1] - 9}" width="10" height="18" rx="2" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>`));
    const ek = X([Math.max(g.L0 * 0.5, g.od * 0.9), -g.od / 2]);
    o.push(knob('od', ek, `${g.flat ? 'Thickness' : 'Outside diameter'} ${F(g.od)} mm: drag the jacket edge, or arrow keys`,
      (p) => `<circle class="kc" cx="${p[0]}" cy="${p[1]}" r="6" fill="var(--surface)" stroke="var(--tool-jacket)" stroke-width="2"/>`));
    o.push(`<text x="${ek[0] + 10}" y="${ek[1] + 15}" text-anchor="start" font-size="11" font-weight="600" class="halo" fill="var(--ink)">${g.flat ? 'T' : 'Ø'} ${F(g.od)}</text>`);
    // thermometer, for jacketed round cables
    if (!g.flat) {
      const tx = W - (W < 520 ? 26 : 30), [ty0, ty1] = thermo(H), T0 = -40, T1 = 60;
      const temp = num(ctx.raw.temp);
      const ty = (t) => ty1 - ((Math.max(T0, Math.min(T1, t)) - T0) / (T1 - T0)) * (ty1 - ty0);
      const cold = g.flags.cold;
      o.push(`<g class="knob" data-k="temp" tabindex="0" role="slider" aria-label="Lowest laying temperature ${temp ?? 'not given'} °C: drag, or arrow keys">`
        + `<rect class="kf" x="${tx - 14}" y="${ty0 - 6}" width="28" height="${ty1 - ty0 + 26}" fill="transparent" stroke="none"/>`
        + `<rect x="${tx - 3.5}" y="${ty0}" width="7" height="${ty1 - ty0}" rx="3.5" fill="var(--sunken)" stroke="var(--line)"/>`
        + `<rect x="${tx - 6}" y="${ty(-5)}" width="12" height="${ty1 - ty(-5)}" fill="url(#cb-hatch)"/>`
        + (temp != null ? `<rect x="${tx - 2}" y="${ty(temp)}" width="4" height="${ty1 - ty(temp) + 4}" fill="${cold ? 'var(--tool-keep)' : 'var(--tool-cu)'}"/>` : '')
        + `<circle cx="${tx}" cy="${ty1 + 8}" r="7" fill="${cold ? 'var(--tool-keep)' : 'var(--tool-cu)'}" stroke="var(--line)"/>`
        + (temp != null ? `<path class="kc" d="M${tx - 12},${ty(temp) - 5}l7,5l-7,5z" fill="var(--ink)" stroke="var(--surface)" stroke-width="1"/>` : '')
        + `</g>`);
      for (const t of [-40, -5, 20, 60]) o.push(`<text x="${tx + 9}" y="${ty(t) + 3}" font-size="9" fill="${t === -5 ? 'var(--tool-keep)' : 'var(--ink-soft)'}">${t}</text>`);
      const narrowT = W < 520;
      if (temp != null) o.push(`<text x="${narrowT ? W - 4 : tx - 15}" y="${narrowT ? ty1 + 30 : ty(temp) + 4}" text-anchor="end" font-size="11" font-weight="600" class="halo" fill="${cold ? 'var(--tool-keep)' : 'var(--ink)'}">${F(temp, 3)} °C</text>`);
      if (cold) o.push(`<text x="${narrowT ? W - 4 : tx - 15}" y="${narrowT ? ty1 + 42 : ty(temp) + 17}" text-anchor="end" font-size="10" class="halo" fill="var(--tool-keep)">PVC stiff</text>`);
    }
    svg.innerHTML = o.join('');
    svg.classList.toggle('dragging', !!drag);
    // readout: the result's values, in order
    const vals = res.values || [];
    read.replaceChildren(...vals.flatMap((v, i) => [el('span', {}, v.label.replace('Minimum bend radius (inside)', 'Min. bend radius').replace('Depth behind a panel, 90° turn', 'Depth, 90° turn').replace('Drag-chain radius (next size up)', 'Drag chain KR').replace(/Cable length in a (.*) bend/, 'In the $1 bend')),
      el('b', { class: i === 0 ? 'main' : null }, `${v.value} ${v.unit || ''}`)]));
    foot.textContent = W < 520 ? '' : 'Drag ◆ the cable end to bend it, ▮ the start of the bend for the straight lead-out, ● the jacket for the diameter, the thermometer for the laying temperature.';
  }

  function drawMsgs() {
    const T = d ? res.notes?.[0] : null;
    msgs.replaceChildren(...(res?.warnings || []).map((w) => el('div', {}, w)),
      ...(T ? [el('div', { class: 'src' }, T.replace('Basis: ', 'Multiplier from '))] : []));
  }

  // ---------- interaction ----------
  const pt = (e) => {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)];
  };
  function keyStep(k, key, big) {
    const dir = key === 'ArrowUp' || key === 'ArrowRight' ? 1 : -1;
    const raw = ctx.raw;
    if (k === 'angle') ctx.set('angle', String(Math.max(1, Math.min(180, round(d.deg + dir * (big ? 15 : 5), 1)))));
    else if (k === 'straight') ctx.set('straight', String(Math.max(0, round(d.L0 + dir * (big ? 10 : 1), 0.5))));
    else if (k === 'od') ctx.set('od', String(Math.max(0.05, round(d.od + dir * (big ? 1 : 0.1), 0.01))));
    else if (k === 'temp') ctx.set('temp', String(Math.max(-60, Math.min(80, round((num(raw.temp) ?? 20) + dir * (big ? 10 : 1), 1)))));
  }
  svg.addEventListener('keydown', (e) => {
    const k = e.target.closest?.('.knob')?.dataset.k;
    if (!k || !d || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    keyStep(k, e.key, e.shiftKey);
    requestAnimationFrame(() => svg.querySelector(`[data-k="${k}"]`)?.focus());
  });
  svg.addEventListener('pointerdown', (e) => {
    const kn = e.target.closest('.knob');
    if (!kn || !d) return;
    e.preventDefault();
    frozen = { ...svg._V };
    drag = { k: kn.dataset.k };
    kn.focus({ preventScroll: true });
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    svg.classList.add('dragging');
    if (drag.k === 'temp') move(e);
  });
  const move = (e) => {
    if (!drag || !d) return;
    const V = frozen, p = pt(e);
    const m = [(p[0] - V.ox) / V.s, (V.oy - p[1]) / V.s];
    const setIf = (key, v) => { if (String(v) !== String(num(ctx.raw[key]))) ctx.set(key, String(v)); };
    const q = V.s > 6 ? 0.5 : V.s > 2 ? 1 : 5;
    if (drag.k === 'angle') {
      const C = [d.L0, d.Rc];
      let a = Math.atan2(m[0] - C[0], -(m[1] - C[1])) / DEG; // 0 at the bend start, growing as the cable turns up
      if (a < -90) a += 360;
      setIf('angle', Math.max(1, Math.min(180, Math.round(a))));
    } else if (drag.k === 'straight') setIf('straight', Math.max(0, round(m[0], q)));
    else if (drag.k === 'od') setIf('od', Math.max(0.05, round(-2 * m[1], V.s > 10 ? 0.1 : 0.5)));
    else if (drag.k === 'temp') {
      const [ty0, ty1] = thermo(svg.viewBox.baseVal.height);
      setIf('temp', Math.round(-40 + ((ty1 - p[1]) / (ty1 - ty0)) * 100));
    }
  };
  svg.addEventListener('pointermove', move);
  const end = () => {
    if (!drag) return;
    const k = drag.k;
    drag = null; frozen = null;
    svg.classList.remove('dragging');
    drawScene();
    requestAnimationFrame(() => svg.querySelector(`[data-k="${k}"]`)?.focus({ preventScroll: true }));
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('lostpointercapture', end);

  ctx.onResult((r) => {
    res = r;
    d = r.drawing || null;
    syncControls();
    drawDrawer();
    drawMsgs();
    drawScene();
  });
  new ResizeObserver(() => { if (!drag) drawScene(); }).observe(stage);
}
