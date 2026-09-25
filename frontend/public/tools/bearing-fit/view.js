// Bearing Fit page: the bearing in its seat, seen end-on, is where the case
// is set - click the shaft or the housing to say which one turns against the
// load, pull the load arrow for light / normal / heavy, click the rolling
// elements for ball or roller. Its two seats, A (shaft) and B (housing), open
// as ISO fit diagrams: the bearing's own tolerance runs across as a band and
// every class stands against it; click a class to put it on the drawing.
// Every number drawn comes from run()'s result.fit.

const NS = 'http://www.w3.org/2000/svg';
const DEG = Math.PI / 180;

// Deep-groove ball bearing series 60, 62, 63: bore code -> [D, B] (ISO 15, catalogue sizes).
const SERIES = {
  60: [[26, 8], [28, 8], [32, 9], [35, 10], [42, 12], [47, 12], [55, 13], [62, 14], [68, 15], [75, 16], [80, 16], [90, 18], [95, 18], [100, 18], [110, 20], [115, 20], [125, 22], [130, 22], [140, 24], [145, 24], [150, 24]],
  62: [[30, 9], [32, 10], [35, 11], [40, 12], [47, 14], [52, 15], [62, 16], [72, 17], [80, 18], [85, 19], [90, 20], [100, 21], [110, 22], [120, 23], [125, 24], [130, 25], [140, 26], [150, 28], [160, 30], [170, 32], [180, 34]],
  63: [[35, 11], [37, 12], [42, 13], [47, 14], [52, 15], [62, 17], [72, 19], [80, 21], [90, 23], [100, 25], [110, 27], [120, 29], [130, 31], [140, 33], [150, 35], [160, 37], [170, 39], [180, 41], [190, 43], [200, 45], [215, 47]],
};
const boreOf = (code) => [10, 12, 15, 17][code] ?? code * 5;
const designation = (d, D) => {
  for (const [s, rows] of Object.entries(SERIES)) for (let i = 0; i < rows.length; i++) if (boreOf(i) === d && rows[i][0] === D) return `${s}${String(i).padStart(2, '0')}`;
  return '';
};
const lookup = (txt) => {
  const m = /^\s*(6[023])(\d\d)\s*(?:-?2?Z|-?2?RS|ZZ|2RS)?\s*$/i.exec(txt || '');
  if (!m) return null;
  const row = SERIES[m[1]]?.[Number(m[2])];
  return row ? { d: boreOf(Number(m[2])), D: row[0], B: row[1] } : null;
};
const ALL = Object.entries(SERIES).flatMap(([s, rows]) => rows.map((r, i) => `${s}${String(i).padStart(2, '0')}`));

const ROT = [['inner', 'Shaft turns', 'The shaft turns, the load stays put (belt pull, gear force, weight)'],
  ['outer', 'Hub turns', 'The hub turns on a fixed axle (wheel, idler pulley)'],
  ['indeterminate', 'Unbalance', 'The load direction wanders (unbalance, vibration)']];
const LOADS = [['light', 'Light', 'P ≤ 0.05 C'], ['normal', 'Normal', '0.05-0.1 C'], ['heavy', 'Heavy', '> 0.1 C or shock']];

const CSS = `
:root { --tool-int: #c2410c; --tool-trn: #9333ea; --tool-clr: #0f8a78; --tool-steel: #8795a3; --tool-load: #b45309;
  --tool-ring: color-mix(in srgb, #8795a3 34%, var(--surface)); --tool-shaft: color-mix(in srgb, #8795a3 22%, var(--surface)); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-int: #fb8c4a; --tool-trn: #c084fc; --tool-clr: #3cc7b3; --tool-steel: #7a8997; --tool-load: #f0a33a;
  --tool-ring: color-mix(in srgb, #7a8997 40%, var(--surface)); --tool-shaft: color-mix(in srgb, #7a8997 26%, var(--surface)); } }
:root[data-theme="dark"] { --tool-int: #fb8c4a; --tool-trn: #c084fc; --tool-clr: #3cc7b3; --tool-steel: #7a8997; --tool-load: #f0a33a;
  --tool-ring: color-mix(in srgb, #7a8997 40%, var(--surface)); --tool-shaft: color-mix(in srgb, #7a8997 26%, var(--surface)); }
.k-page { padding: 10px 12px 12px; }
.bf { display: grid; gap: 10px; grid-template-columns: minmax(360px, 0.85fr) minmax(0, 1.2fr); height: calc(100vh - 64px); min-height: 680px; }
.bf-left, .bf-right { min-width: 0; min-height: 0; display: grid; gap: 10px; }
.bf-left { grid-template-rows: minmax(300px, 1fr) minmax(170px, 34%); }
.bf-right { grid-template-rows: minmax(0, 1fr) minmax(0, 1fr) auto; }
.bf-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.bf-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 7px 10px 5px; }
.bf-head h2 { margin: 0; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 7px; }
.bf-tag { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--ink); color: var(--surface); font: 600 11px "IBM Plex Mono", ui-monospace, monospace; }
.bf-head .sub { font-size: 11.5px; color: var(--ink-soft); }
.bf-head .pick { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; }
.bf-head .pick b { font: 600 14px "IBM Plex Mono", ui-monospace, monospace; }
.bf-btn { padding: 1px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 11.5px; color: var(--ink-soft); }
.bf-btn:hover { border-color: var(--ink-soft); color: var(--ink); }
.bf-rec { font-size: 10.5px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--ok); color: var(--ok); }
.bf-rec.off { border-color: var(--warn); color: var(--warn); }
.bf-plot { flex: 1; min-height: 150px; }
.bf-plot svg, .bf-view svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.bf-read { display: flex; flex-wrap: wrap; gap: 3px 16px; padding: 4px 10px 8px; font-size: 12px; border-top: 1px solid var(--line-soft); }
.bf-read span { color: var(--ink-soft); }
.bf-read b { font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.bf-read .interference { color: var(--tool-int); } .bf-read .transition { color: var(--tool-trn); } .bf-read .clearance { color: var(--tool-clr); }
.bf-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 10px 4px; }
.bf-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.bf-seg button { border: 0; background: transparent; padding: 3px 8px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.bf-seg button + button { border-left: 1px solid var(--line); }
.bf-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.bf-fld { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--ink-soft); }
.bf-fld input[type="text"], .bf-fld input:not([type]) { width: 52px; padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.bf-fld input.des { width: 64px; text-align: left; }
.bf-fld input.bad { border-color: var(--danger); }
.bf-view { flex: 1; min-height: 0; }
.bf-hint { position: absolute; left: 10px; bottom: 6px; font-size: 11px; color: var(--ink-soft); pointer-events: none; display: flex; flex-direction: column; gap: 2px; }
.bf-hint .lg { display: flex; gap: 10px; align-items: center; }
.bf-hint .sw { display: inline-flex; align-items: center; gap: 4px; }
.bf-hint .sw i { width: 10px; height: 10px; border-radius: 2px; opacity: .7; }
.bf-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.bf-msgs div { padding: 4px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--accent); color: var(--ink-soft); }
.bf-msgs div.w { border-left-color: var(--warn); color: var(--ink); }
.bf-left .k-outwrap { display: flex; flex-direction: column; min-height: 0; }
.bf-left .k-out { flex: 1; max-height: none; min-height: 0; }
.bf svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.bf .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.bf .hit { cursor: pointer; outline: none; }
.bf .hit:hover .hl, .bf .hit:focus-visible .hl { stroke: var(--accent); stroke-width: 2px; }
.bf .col { cursor: pointer; outline: none; }
.bf .col:hover .zb { stroke-width: 2px; }
.bf .col:focus-visible .fr { stroke: var(--accent); stroke-width: 1.5px; stroke-dasharray: 3 2; }
.bf .knob { cursor: ns-resize; outline: none; }
.bf .knob:focus-visible .kc { stroke: var(--accent); stroke-width: 3px; }
.bf .dragging, .bf .dragging * { cursor: grabbing !important; }
@media (max-width: 900px) {
  .bf { grid-template-columns: minmax(0, 1fr); height: auto; min-height: 0; }
  .bf-left, .bf-right { display: contents; }
  .bf-left > .bf-card { height: 420px; }
  .bf-right > .bf-card { height: 310px; }
  .bf-left .k-outwrap { order: 5; }
  .bf-left .k-out { max-height: 260px; }
  .bf-hint > div:first-child { display: none; }
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
const sg = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Number(v.toFixed(1)))}`;
const mm = (n, v) => (n + v / 1000).toFixed(3);
const KCOL = { interference: 'var(--tool-int)', transition: 'var(--tool-trn)', clearance: 'var(--tool-clr)' };
const arrowHead = (x, y, ang, L = 8, w = 3.2) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return `M${x},${y}L${x - L * c + w * s},${y - L * s - w * c}L${x - L * c - w * s},${y - L * s + w * c}Z`;
};
const niceStep = (span, n) => { const r = span / n, p = 10 ** Math.floor(Math.log10(r)), m = r / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

export function page(root, ctx) {
  document.head.append(el('style', { text: CSS }));
  let F = null, res = null, drag = null;

  // ---------- the bearing, end-on ----------
  const desIn = el('input', { class: 'des', spellcheck: 'false', list: 'bf-des', placeholder: '6204', 'aria-label': 'Bearing designation, e.g. 6204' });
  const dIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Bearing bore d, mm' });
  const DIn = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Bearing outside diameter D, mm' });
  const segType = el('div', { class: 'bf-seg', role: 'group', 'aria-label': 'Bearing type' });
  const segRot = el('div', { class: 'bf-seg', role: 'group', 'aria-label': 'What turns relative to the load' });
  const segLoad = el('div', { class: 'bf-seg', role: 'group', 'aria-label': 'Load' });
  const segHouse = el('div', { class: 'bf-seg', role: 'group', 'aria-label': 'Housing' });
  const slideIn = el('input', { type: 'checkbox', 'aria-label': 'Floating bearing: the stationary ring must slide axially' });
  const datalist = el('datalist', { id: 'bf-des' }, ALL.map((v) => el('option', { value: v })));
  desIn.addEventListener('change', () => {
    const r = lookup(desIn.value);
    if (r) ctx.setMany({ d: String(r.d), D: String(r.D) }); else desIn.classList.add('bad');
  });
  desIn.addEventListener('input', () => desIn.classList.remove('bad'));
  dIn.addEventListener('change', () => ctx.set('d', dIn.value.trim()));
  DIn.addEventListener('change', () => ctx.set('D', DIn.value.trim()));
  slideIn.addEventListener('change', () => ctx.set('slide', slideIn.checked));
  const tools = el('div', { class: 'bf-tools' },
    el('label', { class: 'bf-fld' }, 'Bearing', desIn), datalist,
    el('label', { class: 'bf-fld' }, 'd', dIn), el('label', { class: 'bf-fld' }, 'D', DIn, 'mm'), segType,
    segRot, segLoad, segHouse, el('label', { class: 'bf-fld' }, slideIn, 'floating'));
  const vsvg = document.createElementNS(NS, 'svg');
  vsvg.setAttribute('role', 'group');
  const sw = (v, t) => el('span', { class: 'sw' }, el('i', { style: `background:${KCOL[v]}` }), t);
  const hint = el('div', { class: 'bf-hint' }, el('div', {}, 'Click the shaft or the housing: which turns · drag the load arrow · click the balls'),
    el('div', { class: 'lg' }, 'zones: ', sw('interference', 'interference'), sw('transition', 'transition'), sw('clearance', 'clearance')));
  const viewCard = el('section', { class: 'bf-card' }, tools, el('div', { class: 'bf-view' }, vsvg), hint);

  // ---------- the two seats ----------
  const mkSeat = (tag, title) => {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('role', 'radiogroup');
    const sub = el('span', { class: 'sub' });
    const pick = el('div', { class: 'pick' });
    const read = el('div', { class: 'bf-read', 'aria-live': 'polite' });
    const card = el('section', { class: 'bf-card' },
      el('div', { class: 'bf-head' }, el('h2', {}, el('span', { class: 'bf-tag' }, tag), title), sub, pick),
      el('div', { class: 'bf-plot' }, svg), read);
    return { svg, sub, pick, read, card };
  };
  const A = mkSeat('A', 'Shaft seat');
  const Bs = mkSeat('B', 'Housing bore');
  const msgs = el('div', { class: 'bf-msgs', 'aria-live': 'polite' });
  root.append(el('div', { class: 'bf' },
    el('div', { class: 'bf-left' }, viewCard, ctx.outputs),
    el('div', { class: 'bf-right' }, A.card, Bs.card, msgs)));

  function syncControls() {
    const raw = ctx.raw;
    const seg = (host, opts, key, cur) => host.replaceChildren(...opts.map(([v, t, tip]) =>
      el('button', { 'aria-pressed': String(cur === v), title: tip || null, onclick: () => ctx.set(key, v) }, t)));
    seg(segType, [['ball', 'Ball'], ['roller', 'Roller']], 'type', raw.type === 'roller' ? 'roller' : 'ball');
    seg(segRot, ROT, 'rotating', ['outer', 'indeterminate'].includes(raw.rotating) ? raw.rotating : 'inner');
    seg(segLoad, LOADS.map(([v, t, tip]) => [v, t, tip]), 'load', ['light', 'heavy'].includes(raw.load) ? raw.load : 'normal');
    seg(segHouse, [['solid', 'Solid'], ['split', 'Split']], 'housing', raw.housing === 'split' ? 'split' : 'solid');
    slideIn.checked = !!raw.slide;
    if (document.activeElement !== dIn) dIn.value = raw.d ?? '';
    if (document.activeElement !== DIn) DIn.value = raw.D ?? '';
    if (document.activeElement !== desIn) { desIn.value = designation(ctx.input.d, ctx.input.D); desIn.classList.remove('bad'); }
  }

  // ---------- end view ----------
  function drawView() {
    const W = Math.max(280, vsvg.parentElement.clientWidth), H = Math.max(220, vsvg.parentElement.clientHeight);
    vsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!F) {
      vsvg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--danger)">${esc((res?.warnings || ['No bearing'])[0])}</text>`;
      return;
    }
    const { d, D } = F;
    const hub = F.rotating === 'outer';
    const t = D - d;
    const Rh = D / 2 + Math.max(0.28 * D, 0.55 * t); // housing / hub outer size
    const narrow = W < 520;
    const calloutW = narrow ? 0 : Math.min(190, W * 0.34);
    const topM = 58, botM = 44;
    const s = Math.min((W - calloutW - 40) / (2 * Rh), (H - topM - botM) / (2 * Rh + 10));
    const cx = (W - calloutW) / 2 + (narrow ? 0 : 6), cy = topM + (H - topM - botM) / 2 + 4;
    const r = (mmv) => mmv * s;
    const o = [];
    const ri = d / 2 + 0.2 * t, ro = D / 2 - 0.2 * t, rp = (d + D) / 4;
    const roller = F.type === 'roller';
    const re = (ro - ri) / 2 * (roller ? 0.98 : 0.92);
    const n = Math.max(7, Math.floor((Math.PI * 2 * rp) / (re * 2 * (roller ? 1.12 : 1.5))));
    o.push('<defs><pattern id="bf-h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--tool-steel)" stroke-width="0.8" stroke-opacity="0.55"/></pattern></defs>');

    // housing or hub (clicking it: the outer ring's side turns)
    const hl = hub ? 'Hub: the outer ring turns (selected)' : 'Housing: click if it is the housing or hub that turns';
    let house;
    if (hub) house = `<circle class="hl" cx="${cx}" cy="${cy}" r="${r(Rh)}" fill="var(--tool-shaft)" stroke="var(--tool-steel)" stroke-width="1.3"/>`;
    else {
      const hw = r(Rh), hh = r(Rh) * 0.92, base = cy + hh;
      house = `<path class="hl" d="M${cx - hw},${base}V${cy - hh + 10}Q${cx - hw},${cy - hh} ${cx - hw + 10},${cy - hh}H${cx + hw - 10}Q${cx + hw},${cy - hh} ${cx + hw},${cy - hh + 10}V${base}Z" fill="url(#bf-h)" stroke="var(--tool-steel)" stroke-width="1.3"/>`
        + `<rect x="${cx - hw - 16}" y="${base}" width="${2 * hw + 32}" height="7" fill="var(--tool-steel)" fill-opacity="0.35"/>`;
      for (const sx of [-1, 1]) house += `<circle cx="${cx + sx * (hw - r(Rh - D / 2) / 2.2)}" cy="${cy + (F.housing === 'split' ? 0 : hh * 0.55)}" r="${Math.max(3, r(Rh - D / 2) * 0.16)}" fill="var(--surface)" stroke="var(--tool-steel)"/>`;
      if (F.housing === 'split') house += `<line x1="${cx - hw - 6}" y1="${cy}" x2="${cx + hw + 6}" y2="${cy}" stroke="var(--ink)" stroke-width="1.6" stroke-dasharray="8 4"/>`
        + `<text x="${cx - hw - 8}" y="${cy - 5}" text-anchor="end" font-size="10" class="halo" fill="var(--ink-soft)">split</text>`;
    }
    o.push(`<g class="hit" data-hit="outer" tabindex="0" role="button" aria-label="${esc(hl)}">${house}<title>${esc(hl)}</title></g>`);
    o.push(`<circle cx="${cx}" cy="${cy}" r="${r(D / 2)}" fill="var(--surface)" stroke="none"/>`);

    // outer ring, rolling elements, inner ring
    const ring = (a, b) => `<path d="M${cx - r(b)},${cy}a${r(b)},${r(b)} 0 1,0 ${2 * r(b)},0a${r(b)},${r(b)} 0 1,0 ${-2 * r(b)},0ZM${cx - r(a)},${cy}a${r(a)},${r(a)} 0 1,1 ${2 * r(a)},0a${r(a)},${r(a)} 0 1,1 ${-2 * r(a)},0Z" fill="var(--tool-ring)" stroke="var(--tool-steel)" stroke-width="1.2" fill-rule="evenodd"/>`;
    o.push(ring(ro, D / 2));
    let els = '';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI + 0.2;
      const x = cx + r(rp) * Math.cos(a), y = cy + r(rp) * Math.sin(a);
      els += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r(re).toFixed(2)}" fill="var(--tool-ring)" stroke="var(--tool-steel)" stroke-width="1"/>`;
      if (roller) els += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r(re) * 0.55).toFixed(2)}" fill="none" stroke="var(--tool-steel)" stroke-width="0.7"/>`;
      else els += `<circle cx="${(x - r(re) * 0.3).toFixed(1)}" cy="${(y - r(re) * 0.3).toFixed(1)}" r="${(r(re) * 0.28).toFixed(2)}" fill="var(--surface)" fill-opacity="0.5"/>`;
    }
    const elab = `${roller ? 'Rollers' : 'Balls'}: click for ${roller ? 'a ball' : 'a roller'} bearing`;
    o.push(`<g class="hit" data-hit="type" tabindex="0" role="button" aria-label="${esc(elab)}">${els}<circle class="hl" cx="${cx}" cy="${cy}" r="${r(rp)}" fill="none" stroke="transparent" stroke-width="${r(re) * 2}"/><title>${esc(elab)}</title></g>`);
    o.push(ring(d / 2, ri));

    // shaft (clicking it: the inner ring's side turns)
    const sl = hub ? 'Axle: click if it is the shaft that turns' : 'Shaft: the inner ring turns (selected)';
    let shaft = `<circle class="hl" cx="${cx}" cy="${cy}" r="${r(d / 2)}" fill="var(--tool-shaft)" stroke="var(--tool-steel)" stroke-width="1.3"/>`;
    if (hub) shaft += `<circle cx="${cx}" cy="${cy}" r="${r(d / 2)}" fill="url(#bf-h)"/>`;
    shaft += `<path d="M${cx - r(d / 2) - 8},${cy}h${2 * r(d / 2) + 16}M${cx},${cy - r(d / 2) - 8}v${2 * r(d / 2) + 16}" stroke="var(--ink-soft)" stroke-width="0.7" stroke-dasharray="8 3 2 3"/>`;
    o.push(`<g class="hit" data-hit="inner" tabindex="0" role="button" aria-label="${esc(sl)}">${shaft}<title>${esc(sl)}</title></g>`);

    // what turns: an arc arrow on the turning part
    const arc = (rad, a0, a1, col, w) => {
      const p = (a) => [cx + rad * Math.cos(a * DEG), cy + rad * Math.sin(a * DEG)];
      const [x0, y0] = p(a0), [x1, y1] = p(a1);
      const tang = (a1 + 90) * DEG;
      return `<path d="M${x0},${y0}A${rad},${rad} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0},1 ${x1},${y1}" fill="none" stroke="${col}" stroke-width="${w}"/><path d="${arrowHead(x1 + 2 * Math.cos(tang), y1 + 2 * Math.sin(tang), tang, 10, 4.5)}" fill="${col}"/>`;
    };
    if (F.rotating === 'outer') {
      o.push(arc(r(Rh) + 12, 200, 320, 'var(--accent)', 2.2));
      o.push(`<text x="${cx}" y="${cy + r(Rh) + 16}" text-anchor="middle" font-size="11" class="halo" fill="var(--accent)">hub turns · axle fixed</text>`);
    } else {
      o.push(arc(r(d / 2) * 0.62, 200, 320, 'var(--accent)', 2.2));
      if (F.rotating === 'indeterminate') o.push(arc(r(D / 2) + (hub ? 0 : r(Rh - D / 2) * 0.0) - 3, 20, 140, 'var(--tool-load)', 1.4));
    }

    // load arrow: fixed in space (or wandering), drag for light / normal / heavy
    const li = Math.max(0, LOADS.findIndex(([v]) => v === F.load));
    const len = [34, 50, 68][li], wid = [2, 3.5, 5.5][li];
    const tipY = cy - r(d / 2) * 0.1, tailY = Math.max(56, tipY - r(d / 2) - len - 24);
    const lx = cx + (F.rotating === 'outer' ? 0 : 0);
    const col = 'var(--tool-load)';
    const topY = Math.min(tipY - 12, tailY + len + 30);
    o.push(`<line x1="${lx}" y1="${tailY}" x2="${lx}" y2="${tipY - 10}" stroke="${col}" stroke-width="${wid}" stroke-opacity="0.9"/>`);
    o.push(`<path d="${arrowHead(lx, tipY, Math.PI / 2, 12 + wid, 4 + wid)}" fill="${col}"/>`);
    const lt = `F ${LOADS[li][1].toLowerCase()} · ${LOADS[li][2]}${F.rotating === 'indeterminate' ? ' · direction wanders' : F.rotating === 'outer' ? ' · stands still with the axle' : ' · fixed in space, the shaft turns under it'}`;
    o.push(`<text x="${lx + 14}" y="${tailY + 10}" font-size="11.5" font-weight="600" class="halo" fill="${col}">${esc(narrow ? lt.split(' · ')[0] : lt.split(' · ')[0] + ' · ' + lt.split(' · ')[1])}</text>`);
    if (!narrow) o.push(`<text x="${lx + 14}" y="${tailY + 24}" font-size="10" class="halo" fill="var(--ink-soft)">${esc(lt.split(' · ').slice(2).join(' · '))}</text>`);
    o.push(`<g class="knob" data-knob="load" tabindex="0" role="slider" aria-label="Load class, drag up or down or use arrow keys" aria-valuetext="${LOADS[li][1]}">`
      + `<circle class="kc" cx="${lx}" cy="${tailY}" r="8" fill="${col}" stroke="var(--surface)" stroke-width="1.5"/><path d="M${lx},${tailY - 4}v8M${lx - 4},${tailY}h8" stroke="var(--surface)" stroke-width="1.5"/><title>Drag up for a heavier load</title></g>`);
    void topY;

    // callouts A and B to the fit diagrams
    const callout = (tag, rad, ang, lines, kind) => {
      const px = cx + r(rad) * Math.cos(ang * DEG), py = cy + r(rad) * Math.sin(ang * DEG);
      const ex = narrow ? px + 8 : cx + r(Rh) + 24, ey = narrow ? py : py;
      let g = `<circle cx="${px}" cy="${py}" r="3.5" fill="var(--ink)"/>`;
      if (!narrow) g += `<path d="M${px},${py}L${ex},${ey}H${ex + 10}" fill="none" stroke="var(--ink)" stroke-width="0.9"/>`;
      const tx = narrow ? px + 12 : ex + 14;
      g += `<circle cx="${tx + 7}" cy="${ey}" r="9" fill="var(--ink)"/><text x="${tx + 7}" y="${ey + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--surface)">${tag}</text>`;
      if (!narrow) {
        g += `<text x="${tx + 22}" y="${ey + 1}" font-size="12.5" font-weight="600" class="halo" fill="var(--ink)">${esc(lines[0])}</text>`;
        g += `<text x="${tx + 22}" y="${ey + 15}" font-size="10.5" class="halo" fill="${KCOL[kind] || 'var(--ink-soft)'}">${esc(lines[1])}</text>`;
      }
      return g;
    };
    o.push(callout('A', d / 2, 38, [`Ø${d} ${F.shaft}`, `${F.shaftKind} ${sg(F.shaftFit[0])}…${sg(F.shaftFit[1])} µm`], F.shaftKind));
    o.push(callout('B', D / 2, -22, [`Ø${D} ${F.hole}`, `${F.housingKind === 'clearance' ? 'clearance' : F.housingKind} ${sg(F.housingFit[0])}…${sg(F.housingFit[1])} µm`], F.housingKind));
    const des = designation(d, D);
    o.push(`<text x="12" y="20" font-size="12" font-weight="600" fill="var(--ink)">${esc(des ? `${des} · ` : '')}${d} × ${D} mm ${roller ? 'roller' : 'ball'} bearing</text>`);
    o.push(`<text x="12" y="35" font-size="10.5" fill="var(--ink-soft)">${esc(F.slide ? 'floating: the stationary ring slides axially' : 'locating')}${F.housing === 'split' && !hub ? ' · split housing' : ''}</text>`);
    const fk = vsvg.contains(document.activeElement) ? document.activeElement.getAttribute('data-hit') || document.activeElement.getAttribute('data-knob') : null;
    vsvg.innerHTML = o.join('');
    if (fk) vsvg.querySelector(`[data-hit="${fk}"], [data-knob="${fk}"]`)?.focus({ preventScroll: true });
    vsvg.setAttribute('aria-label', `Bearing ${d} by ${D} mm seen end-on; shaft ${F.shaft}, housing ${F.hole}`);
    vsvg.classList.toggle('dragging', !!drag);
  }

  // ---------- fit diagrams ----------
  function drawSeat(S, side) {
    const shaft = side === 'shaft';
    const list = shaft ? F.shafts : F.holes;
    const cur = shaft ? F.shaft : F.hole, rec = shaft ? F.recShaft : F.recHole;
    const brg = shaft ? F.bore : F.od;
    const nom = shaft ? F.d : F.D;
    const key = shaft ? 'shaft_cls' : 'hole_cls';
    S.sub.textContent = `Ø${nom} · bearing ${shaft ? 'bore' : 'outside Ø'} ${sg(brg[0])} / 0 µm (ISO 492 normal)`;
    const rb = el('span', { class: `bf-rec${cur === rec ? '' : ' off'}` }, cur === rec ? 'recommended' : `recommended ${rec}`);
    S.pick.replaceChildren(...[el('span', {}, 'class'), el('b', { style: `color:${KCOL[(shaft ? F.shaftKind : F.housingKind)]}` }, cur), rb,
      cur !== rec ? el('button', { class: 'bf-btn', onclick: () => ctx.set(key, '') }, `Back to ${rec}`) : null].filter(Boolean));

    const svg = S.svg;
    const W = Math.max(260, svg.parentElement.clientWidth), H = Math.max(140, svg.parentElement.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', `${shaft ? 'Shaft' : 'Housing'} tolerance classes at Ø${nom}; arrow keys choose`);
    const lo = Math.min(brg[0], ...list.map((c) => c.dev[0])), hi = Math.max(0, ...list.map((c) => c.dev[1]));
    const pad = (hi - lo) * 0.08 + 2;
    const y0 = 14, y1 = H - 30;
    const Y = (u) => y1 - ((u - (lo - pad)) / (hi + pad - (lo - pad))) * (y1 - y0);
    const left = 40, bw = Math.min(64, (W - left) * 0.12), gx = left + bw + 14;
    const cw = (W - gx - 6) / list.length;
    const o = [];
    // grid
    const st = niceStep(hi - lo + 2 * pad, 6);
    for (let u = Math.ceil((lo - pad) / st) * st; u <= hi + pad; u += st) {
      o.push(`<line x1="${left}" y1="${Y(u)}" x2="${W - 4}" y2="${Y(u)}" stroke="var(--line-soft)"/>`);
      o.push(`<text x="${left - 5}" y="${Y(u) + 3.5}" text-anchor="end" font-size="10" fill="var(--ink-soft)">${sg(u)}</text>`);
    }
    o.push(`<text x="4" y="${y0 - 2}" font-size="10" fill="var(--ink-soft)">µm</text>`);
    // the bearing's own zone, and its band across every class
    o.push(`<rect x="${gx - 4}" y="${Y(0)}" width="${W - gx}" height="${Y(brg[0]) - Y(0)}" fill="var(--ink-soft)" fill-opacity="0.12"/>`);
    o.push(`<rect x="${left + 4}" y="${Y(0)}" width="${bw - 4}" height="${Y(brg[0]) - Y(0)}" fill="url(#bf-hz-${side})" stroke="var(--ink)" stroke-width="1.2"/>`);
    o.push(`<defs><pattern id="bf-hz-${side}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--ink)" stroke-width="0.9" stroke-opacity="0.6"/></pattern></defs>`);
    o.push(`<text x="${left + bw / 2 + 2}" y="${y1 + 13}" text-anchor="middle" font-size="10.5" fill="var(--ink)">${shaft ? 'bore' : 'OD'}</text>`);
    o.push(`<text x="${left + bw / 2 + 2}" y="${y1 + 25}" text-anchor="middle" font-size="9.5" fill="var(--ink-soft)">bearing</text>`);
    // zero line: the nominal size
    o.push(`<line x1="${left}" y1="${Y(0)}" x2="${W - 4}" y2="${Y(0)}" stroke="var(--ink)" stroke-width="1.2"/>`);
    // the classes
    list.forEach((c, i) => {
      const x = gx + i * cw, w = Math.min(cw - 6, 34), zx = x + (cw - w) / 2;
      const on = c.cls === cur;
      const col = KCOL[c.kind];
      const tip = `${c.cls}: ${sg(c.dev[0])} / ${sg(c.dev[1])} µm, Ø${mm(nom, c.dev[0])}-${mm(nom, c.dev[1])} mm; ${c.kind} ${sg(c.fit[0])}…${sg(c.fit[1])} µm${c.cls === rec ? ' (recommended)' : ''}`;
      let g = `<rect class="fr" x="${x + 1}" y="${y0 - 6}" width="${cw - 2}" height="${y1 - y0 + 34}" rx="3" fill="${on ? 'var(--sunken)' : 'transparent'}" stroke="none"/>`;
      g += `<rect class="zb" x="${zx}" y="${Y(c.dev[1])}" width="${w}" height="${Math.max(1.5, Y(c.dev[0]) - Y(c.dev[1]))}" fill="${col}" fill-opacity="${on ? 0.55 : 0.2}" stroke="${col}" stroke-width="${on ? 2 : 1}"/>`;
      g += `<text x="${x + cw / 2}" y="${y1 + 14}" text-anchor="middle" font-size="${cw < 30 ? (on ? 10.5 : 9.5) : on ? 12 : 11}" font-weight="${on ? 700 : 400}" fill="${on ? 'var(--ink)' : 'var(--ink-soft)'}">${c.cls}</text>`;
      if (c.cls === rec) g += `<path d="M${x + cw / 2 - 4},${y1 + 20}h8l-4,5z" fill="var(--ok)"/>`;
      if (on) {
        g += `<text x="${x + cw / 2}" y="${Y(c.dev[1]) - 4}" text-anchor="middle" font-size="10" class="halo" fill="var(--ink)">${sg(c.dev[1])}</text>`;
        g += `<text x="${x + cw / 2}" y="${Y(c.dev[0]) + 12}" text-anchor="middle" font-size="10" class="halo" fill="var(--ink)">${sg(c.dev[0])}</text>`;
      }
      o.push(`<g class="col" data-cls="${c.cls}" tabindex="${on ? 0 : -1}" role="radio" aria-checked="${on}" aria-label="${esc(tip)}">${g}<title>${esc(tip)}</title></g>`);
    });
    o.push(`<text x="${W - 6}" y="${Y(0) - 4}" text-anchor="end" font-size="10" class="halo" fill="var(--ink)" pointer-events="none">0 = Ø${nom}.000</text>`);
    const hadFocus = svg.contains(document.activeElement);
    svg.innerHTML = o.join('');
    if (hadFocus) svg.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });

    // readout
    const dev = shaft ? F.shaftDev : F.holeDev;
    const fit = shaft ? F.shaftFit : F.housingFit;
    const kind = shaft ? F.shaftKind : F.housingKind;
    const word = shaft ? ['interference', 'clearance'] : ['clearance', 'interference'];
    const ends = [fit[0], fit[1]].map((v) => (v >= 0 ? `${Math.abs(v)} µm ${word[0]}` : `${Math.abs(v)} µm ${word[1]}`));
    const span = fit[0] >= 0 || fit[1] <= 0 ? `, ${Math.abs(fit[fit[0] >= 0 ? 0 : 1])} to ${Math.abs(fit[fit[0] >= 0 ? 1 : 0])} µm` : ` from ${ends[0]} to ${ends[1]}`;
    S.read.replaceChildren(
      el('span', {}, `${shaft ? 'Shaft' : 'Bore'} Ø${nom} ${cur} `, el('b', {}, `${mm(nom, dev[0])} – ${mm(nom, dev[1])} mm`)),
      el('span', {}, 'fit ', el('b', { class: kind }, kind), span));
  }

  function drawMsgs() {
    const w = res?.warnings || [];
    const notes = (res?.notes || []).slice(0, 2);
    msgs.replaceChildren(...w.map((t) => el('div', { class: 'w' }, t)), ...notes.map((t) => el('div', {}, t)));
  }

  function drawAll() {
    drawView();
    if (F) { drawSeat(A, 'shaft'); drawSeat(Bs, 'hole'); } else for (const S of [A, Bs]) { S.svg.innerHTML = ''; S.read.replaceChildren(); S.pick.replaceChildren(); S.sub.textContent = ''; }
  }

  // ---------- interaction ----------
  const act = (hit) => {
    if (hit === 'type') ctx.set('type', F.type === 'roller' ? 'ball' : 'roller');
    else ctx.set('rotating', hit);
  };
  vsvg.addEventListener('click', (e) => {
    const h = e.target.closest?.('.hit');
    if (h && F) act(h.dataset.hit);
  });
  const loadStep = (dir) => {
    const i = LOADS.findIndex(([v]) => v === F.load);
    const j = Math.max(0, Math.min(2, i + dir));
    if (j !== i) ctx.set('load', LOADS[j][0]);
  };
  vsvg.addEventListener('keydown', (e) => {
    const h = e.target.closest?.('.hit');
    if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); const k = h.dataset.hit; act(k); requestAnimationFrame(() => vsvg.querySelector(`[data-hit="${k}"]`)?.focus()); return; }
    if (e.target.closest?.('.knob')) {
      const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault(); loadStep(dir);
      requestAnimationFrame(() => vsvg.querySelector('[data-knob="load"]')?.focus());
    }
  });
  const pt = (e) => { const r = vsvg.getBoundingClientRect(), vb = vsvg.viewBox.baseVal; return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)]; };
  vsvg.addEventListener('pointerdown', (e) => {
    const k = e.target.closest?.('.knob');
    if (!k || !F) return;
    e.preventDefault();
    drag = { y0: pt(e)[1], i0: LOADS.findIndex(([v]) => v === F.load) };
    k.focus({ preventScroll: true });
    vsvg.classList.add('dragging');
    try { vsvg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  });
  vsvg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const j = Math.max(0, Math.min(2, drag.i0 + Math.round(-(pt(e)[1] - drag.y0) / 18)));
    if (LOADS[j][0] !== F.load) ctx.set('load', LOADS[j][0]);
  });
  const end = () => { if (!drag) return; drag = null; vsvg.classList.remove('dragging'); drawView(); requestAnimationFrame(() => vsvg.querySelector('[data-knob="load"]')?.focus({ preventScroll: true })); };
  vsvg.addEventListener('pointerup', end);
  vsvg.addEventListener('pointercancel', end);
  vsvg.addEventListener('lostpointercapture', end);

  for (const [S, side] of [[A, 'shaft'], [Bs, 'hole']]) {
    const key = side === 'shaft' ? 'shaft_cls' : 'hole_cls';
    const choose = (cls) => {
      const rec = side === 'shaft' ? F.recShaft : F.recHole;
      ctx.set(key, cls === rec ? '' : cls);
    };
    S.svg.addEventListener('click', (e) => { const c = e.target.closest?.('.col'); if (c && F) choose(c.dataset.cls); });
    S.svg.addEventListener('keydown', (e) => {
      const c = e.target.closest?.('.col');
      if (!c || !F) return;
      const list = (side === 'shaft' ? F.shafts : F.holes).map((x) => x.cls);
      const i = list.indexOf(c.dataset.cls);
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(c.dataset.cls); return; }
      if (!dir) return;
      e.preventDefault();
      const nx = list[Math.max(0, Math.min(list.length - 1, i + dir))];
      choose(nx);
      requestAnimationFrame(() => S.svg.querySelector(`[data-cls="${nx}"]`)?.focus());
    });
  }

  ctx.onResult((r) => {
    res = r;
    F = r.fit || null;
    syncControls();
    drawAll();
    drawMsgs();
  });
  const ro = new ResizeObserver(() => { if (!drag) drawAll(); });
  for (const n of [vsvg.parentElement, A.svg.parentElement, Bs.svg.parentElement]) ro.observe(n);
}
