// Land Pattern: the page is the footprint on a drafting sheet. The copper
// lands are drawn to scale over the part they were calculated for (body,
// leads, lead-tip tolerance), inside the courtyard, with Z, G, C, X, Y and the
// pitch dimensioned on the drawing. Packages are picked from a tray where
// every outline is drawn to one scale; the title block holds the IPC name,
// the density levels (click a row) and the tolerances (drag the label).
// Every land dimension drawn comes from run()'s result (result.pattern /
// result.patterns); the tray draws only the component outlines.

import { OUTLINES } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function sv(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mm = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toFixed(3))));
const mid = (r) => (r[0] + r[1]) / 2;
const FAMILIES = ['Chip', 'Molded', 'SOD / SOT', 'SOIC / SOP', 'LQFP', 'QFN / DFN'];
const LEVELS = [['M', 'M', 'most: hand solder, wave'], ['N', 'N', 'nominal'], ['L', 'L', 'least: dense boards']];
const LAYERS = [
  ['cu', 'Copper', '--tool-cu'], ['lead', 'Leads', '--tool-lead'], ['body', 'Body', '--tool-body'],
  ['cy', 'Courtyard', '--tool-cy'], ['dim', 'Dimensions', '--ink-soft'], ['ghost', 'Other levels', '--ink-soft'],
];

const VKEY = 'redline.tool.land-pattern.view';
const loadView = () => {
  const d = { cu: true, lead: true, body: true, cy: true, dim: true, ghost: false };
  try { return { ...d, ...(JSON.parse(localStorage.getItem(VKEY) || '{}')) }; } catch { return d; }
};
const saveView = (v) => { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* private window */ } };

/**
 * Where the lands go, in mm with y up and pin 1 top left, counter-clockwise -
 * the geometry of the pattern run() sized (its C, pitch, X, Y and tab).
 */
export function padsOf(q) {
  const pads = [];
  const { C, X, Y, p } = q;
  if (!p) { // two-terminal part
    pads.push({ n: 1, x: -C / 2, y: 0, w: Y, h: X, side: 'L' }, { n: 2, x: C / 2, y: 0, w: Y, h: X, side: 'R' });
    return pads;
  }
  const row = q.row;
  const top = (row - 1) * p / 2;
  if (q.sides === 4) {
    let n = 1;
    for (let i = 0; i < row; i++) pads.push({ n: n++, x: -C / 2, y: top - i * p, w: Y, h: X, side: 'L' });
    for (let i = 0; i < row; i++) pads.push({ n: n++, x: -top + i * p, y: -C / 2, w: X, h: Y, side: 'B' });
    for (let i = 0; i < row; i++) pads.push({ n: n++, x: C / 2, y: -top + i * p, w: Y, h: X, side: 'R' });
    for (let i = 0; i < row; i++) pads.push({ n: n++, x: top - i * p, y: C / 2, w: X, h: Y, side: 'T' });
  } else {
    for (let i = 0; i < row; i++) pads.push({ n: i + 1, x: -C / 2, y: top - i * p, w: Y, h: X, side: 'L' });
    const m = q.n - row;
    if (q.Xtab) pads.push({ n: q.n, x: C / 2, y: 0, w: Y, h: q.Xtab, side: 'R', tab: true });
    else if (m === row) for (let i = 0; i < m; i++) pads.push({ n: row + 1 + i, x: C / 2, y: -top + i * p, w: Y, h: X, side: 'R' });
    else if (m === 1) pads.push({ n: q.n, x: C / 2, y: 0, w: Y, h: X, side: 'R' });
    else { // SOT-23-5: the right row has its middle position empty
      const ys = Array.from({ length: row }, (_, i) => -top + i * p).filter((_, i) => row % 2 === 0 || i !== (row - 1) / 2).slice(0, m);
      ys.forEach((y, i) => pads.push({ n: row + 1 + i, x: C / 2, y, w: Y, h: X, side: 'R' }));
    }
  }
  if (q.ep) pads.push({ n: q.n + 1, x: 0, y: 0, w: q.ep[0], h: q.ep[1], ep: true });
  return pads;
}

/** Lead (terminal) rectangles of a part at nominal size, mm, y up: [{x0,x1,y0,y1,foot}]. */
function leadsOf(o) {
  const L = mid(o.L), T = mid(o.T), W = mid(o.W);
  const out = [];
  const inner = (o.form === 'gull' || o.form === 'gullFine') ? Math.min(o.bx / 2, L / 2 - T) : L / 2 - T;
  const bar = (along, sideSign, rot, w = W) => {
    const a = sideSign * inner, b = sideSign * L / 2, f = sideSign * (L / 2 - T);
    const r = { x0: Math.min(a, b), x1: Math.max(a, b), y0: along - w / 2, y1: along + w / 2 };
    const ft = { x0: Math.min(f, b), x1: Math.max(f, b), y0: along - w / 2, y1: along + w / 2, foot: true };
    const rotate = (q) => (rot ? { x0: q.y0, x1: q.y1, y0: q.x0, y1: q.x1, foot: q.foot } : q);
    out.push(rotate(r), rotate(ft));
  };
  if (!o.p) { bar(0, -1, false); bar(0, 1, false); return out; }
  const top = (o.row - 1) * o.p / 2;
  const ys = Array.from({ length: o.row }, (_, i) => top - i * o.p);
  if (o.sides === 4) { for (const y of ys) { bar(y, -1, false); bar(y, 1, false); bar(y, -1, true); bar(y, 1, true); } return out; }
  for (const y of ys) bar(y, -1, false);
  const m = o.n - o.row;
  if (o.tab) bar(0, 1, false, mid(o.tab));
  else if (m === o.row) for (const y of ys) bar(y, 1, false);
  else if (m === 1) bar(0, 1, false);
  else ys.filter((_, i) => o.row % 2 === 0 || i !== (o.row - 1) / 2).slice(0, m).forEach((y) => bar(y, 1, false));
  return out;
}

function silhouette(o, s) {
  // One outline drawn at s px/mm, centred.
  const L = mid(o.L);
  const w = Math.max(o.bx, L) * s, hgt = (o.sides === 4 ? Math.max(o.by, L) : o.by) * s;
  const svg = sv(null, 'svg', { width: Math.max(4, w + 2), height: Math.max(4, hgt + 2), viewBox: `${-w / 2 - 1} ${-hgt / 2 - 1} ${w + 2} ${hgt + 2}`, 'aria-hidden': 'true' });
  sv(svg, 'rect', { x: -o.bx * s / 2, y: -o.by * s / 2, width: o.bx * s, height: o.by * s, class: 'lp-sil-body' });
  for (const r of leadsOf(o)) if (r.foot || o.form.startsWith('gull')) {
    sv(svg, 'rect', { x: r.x0 * s, y: -r.y1 * s, width: Math.max(.6, (r.x1 - r.x0) * s), height: Math.max(.6, (r.y1 - r.y0) * s), class: 'lp-sil-lead' });
  }
  return svg;
}

export function page(root, ctx) {
  const view = loadView();
  let res = null, sel = 1;
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));

  // ---------- tray ----------
  const filterIn = h('input', { class: 'lp-filter', type: 'text', spellcheck: 'false', placeholder: 'filter: SOT, QFN, 0.5…', 'aria-label': 'Filter packages',
    oninput: (e) => ctx.set('filter', e.target.value) });
  const allBtn = h('button', { type: 'button', class: 'lp-all', 'aria-pressed': 'false', title: 'Show every matching land pattern side by side',
    onclick: () => ctx.set('pkg', ctx.raw.pkg === 'all' ? (lastOne || 'SOIC-8') : 'all') }, 'Compare all');
  const TRAY_S = 3.4;
  const cells = new Map();
  const trayBody = h('div', { class: 'lp-tray-body', role: 'radiogroup', 'aria-label': 'Package' });
  for (const fam of FAMILIES) {
    const list = OUTLINES.filter((o) => o.family === fam);
    const grid = h('div', { class: 'lp-cells' });
    for (const o of list) {
      const b = h('button', { type: 'button', role: 'radio', class: 'lp-cell', 'data-id': o.id, title: `${o.id}  ${o.ipc}`,
        onclick: () => pick(o.id), onkeydown: (e) => trayKey(e, o.id) }, silhouette(o, TRAY_S), h('b', {}, o.id.replace(/ \(.*\)$/, '')));
      cells.set(o.id, b); grid.append(b);
    }
    trayBody.append(h('div', { class: 'lp-fam' }, h('div', { class: 'lp-fam-h' }, fam), grid));
  }
  const ORDER = FAMILIES.flatMap((f) => OUTLINES.filter((o) => o.family === f).map((o) => o.id));
  let lastOne = null;
  function pick(id) { sel = 1; ctx.set('pkg', id); }
  function trayKey(e, id) {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const n = ORDER[clamp(ORDER.indexOf(id) + d, 0, ORDER.length - 1)];
    pick(n); requestAnimationFrame(() => cells.get(n)?.focus());
  }
  const tray = h('aside', { class: 'lp-tray' },
    h('div', { class: 'lp-tray-head' },
      h('div', { class: 'lp-tray-row' }, h('span', { class: 'lp-cap' }, 'Packages ', h('small', {}, `outlines to scale, ${TRAY_S} px/mm`))),
      h('div', { class: 'lp-tray-row' }, filterIn, allBtn)),
    trayBody);

  // ---------- sheet ----------
  const levelSeg = h('div', { class: 'lp-seg', role: 'radiogroup', 'aria-label': 'Density level' },
    LEVELS.map(([v, t, title]) => h('button', { type: 'button', role: 'radio', 'data-v': v, title: `${v}: ${title}`,
      onclick: () => ctx.set('level', v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return; e.preventDefault();
        const i = clamp(LEVELS.findIndex((l) => l[0] === v) + d, 0, 2); ctx.set('level', LEVELS[i][0]);
        requestAnimationFrame(() => levelSeg.querySelector(`[data-v="${LEVELS[i][0]}"]`)?.focus());
      } }, t)));
  const layerBtns = LAYERS.map(([k, t, c]) => h('button', { type: 'button', class: 'lp-layer', 'aria-pressed': String(!!view[k]), style: `--c: var(${c})`,
    onclick: (e) => { view[k] = !view[k]; saveView(view); e.currentTarget.setAttribute('aria-pressed', String(view[k])); draw(); } }, h('i'), t));
  const scaleCap = h('span', { class: 'lp-scale' });
  const svg = sv(null, 'svg', { tabindex: '0', role: 'img', 'aria-label': 'Land pattern drawing. Arrow keys step through the pads.' });
  const cat = h('div', { class: 'lp-cat', style: 'display:none' });
  const box = h('div', { class: 'lp-box' }, svg, cat);
  const readout = h('div', { class: 'lp-readout', 'aria-live': 'polite' });
  const warns = h('div', { class: 'lp-warns', 'aria-live': 'polite' });
  const sheet = h('section', { class: 'lp-sheet' },
    h('div', { class: 'lp-bar' }, h('span', { class: 'lp-cap' }, 'Density'), levelSeg, h('div', { class: 'lp-layers' }, layerBtns), scaleCap),
    box, readout, warns);

  // ---------- title block ----------
  const tb = h('div', { class: 'lp-tb' });
  const scrub = (key, label, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title,
      oninput: (e) => ctx.set(key, e.target.value),
      onkeydown: (e) => {
        const d = { ArrowUp: 1, ArrowDown: -1 }[e.key]; if (!d) return; e.preventDefault();
        const v = clamp(Math.round(((ctx.input[key] ?? 0) + d * 0.005) * 1000) / 1000, 0, 0.3); ctx.set(key, String(v)); inp.value = String(v);
      } });
    const lab = h('span', { title: `${title}: drag sideways, or arrow keys in the field` }, label);
    lab.addEventListener('pointerdown', (e) => {
      e.preventDefault(); try { lab.setPointerCapture(e.pointerId); } catch { /* ended */ }
      const x0 = e.clientX, v0 = ctx.input[key] ?? 0;
      const move = (ev) => { const v = clamp(Math.round((v0 + (ev.clientX - x0) / 8 * 0.005) * 1000) / 1000, 0, 0.3); inp.value = String(v); ctx.set(key, String(v)); };
      const up = () => { lab.removeEventListener('pointermove', move); lab.removeEventListener('pointerup', up); };
      lab.addEventListener('pointermove', move); lab.addEventListener('pointerup', up);
    });
    const w = h('label', { class: 'lp-scrub' }, lab, inp, h('small', {}, 'mm'));
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const fScrub = scrub('fab', 'F fab', 'Fabrication tolerance F');
  const pScrub = scrub('place', 'P place', 'Placement tolerance P');
  const title = h('aside', { class: 'lp-title' }, tb, ctx.outputs);

  const wrap = h('div', { class: 'lp' }, tray, sheet, title);
  root.append(wrap);

  new ResizeObserver(() => draw()).observe(box);

  // pad stepping with the keyboard, hover and click
  let pads = [];
  svg.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -1e3, End: 1e3 }[e.key];
    if (!d || !pads.length) return;
    e.preventDefault();
    const i = pads.findIndex((p) => p.n === sel);
    sel = pads[clamp((i < 0 ? 0 : i) + d, 0, pads.length - 1)].n; draw();
  });

  ctx.onResult((r) => { res = r; sync(); draw(); });

  function sync() {
    const raw = ctx.raw;
    if (raw.pkg !== 'all') lastOne = raw.pkg;
    allBtn.setAttribute('aria-pressed', String(raw.pkg === 'all'));
    if (document.activeElement !== filterIn) filterIn.value = raw.filter || '';
    const q = String(raw.filter || '').trim().toLowerCase();
    for (const o of OUTLINES) {
      const b = cells.get(o.id);
      const on = o.id === raw.pkg;
      b.setAttribute('aria-checked', String(on)); b.tabIndex = on || (raw.pkg === 'all' && o.id === ORDER[0]) ? 0 : -1;
      b.classList.toggle('lp-dim', !!q && !`${o.id} ${o.ipc} ${o.formName}`.toLowerCase().includes(q));
    }
    for (const b of levelSeg.children) { const on = b.dataset.v === (raw.level || 'N'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    fScrub.sync(raw.fab); pScrub.sync(raw.place);
    drawTitle();
  }

  // ---------- title block ----------
  function cell(k, v, cls = '') { return h('div', { class: cls }, h('span', { class: 'lp-tb-k' }, k), h('div', { class: 'lp-tb-v' }, v)); }
  function drawTitle() {
    const P = res?.pattern;
    const lvTable = () => {
      if (!P) return null;
      const t = h('table', { class: 'lp-lv', role: 'grid', 'aria-label': 'Density levels' },
        h('tr', {}, ['Level', 'Pad Y × X', 'C', 'Z / G', 'Courtyard'].map((c) => h('th', {}, c))));
      for (const [k] of LEVELS) {
        const q = P.levels[k];
        const tr = h('tr', { 'data-lv': k, tabindex: '0', 'aria-selected': String(k === P.level), title: `Use density ${k}`,
          onclick: () => ctx.set('level', k), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.set('level', k); } } },
        h('td', {}, k), h('td', {}, `${mm(q.Y)}×${mm(q.X)}`), h('td', {}, mm(q.C)), h('td', {}, `${mm(q.Z)}/${mm(q.G)}`), h('td', {}, `${mm(q.cyX)}×${mm(q.cyY)}`));
        t.append(tr);
      }
      return t;
    };
    const kids = [];
    if (P) {
      kids.push(
        cell('IPC-7351B name', P.ipc, 'lp-tb-wide lp-tb-name'),
        cell('Package', P.id), cell('Lead form', P.formName),
        cell('Pad Y × X', [`${mm(P.Y)} × ${mm(P.X)}`, h('small', {}, ' mm')], 'lp-tb-big'),
        cell('Pad centres C', [mm(P.C), h('small', {}, ` mm  (±${mm(P.C / 2)})`)], 'lp-tb-big'),
        cell('Z outer / G inner', `${mm(P.Z)} / ${mm(P.G)}`), cell('Courtyard', [`${mm(P.cyX)} × ${mm(P.cyY)}`, h('small', {}, ` +${P.cy}`)]),
        cell('Pitch · pins', P.p ? `${mm(P.p)} · ${P.n}` : `– · ${P.n}`),
        cell('Pin 1 (x, y)', P.pin1 ? `${mm(P.pin1[0])}, ${mm(P.pin1[1])}` : `${mm(-P.C / 2)}, 0`),
      );
      if (P.Xtab) kids.push(cell('Tab pad', `${mm(P.Y)} × ${mm(P.Xtab)}`, 'lp-tb-wide'));
      if (P.ep) kids.push(cell('Thermal pad', [`${mm(P.ep[0])} × ${mm(P.ep[1])}`, h('small', {}, '  take it from the datasheet')], 'lp-tb-wide'));
      kids.push(h('div', { class: 'lp-tb-wide' }, h('span', { class: 'lp-tb-k' }, 'Density level (click a row)'), lvTable()));
      kids.push(h('div', { class: 'lp-tb-wide' }, h('span', { class: 'lp-tb-k' }, 'Tolerances'), h('div', { class: 'lp-scrubs' }, fScrub, pScrub)));
      kids.push(h('div', { class: 'lp-tb-wide' }, h('span', { class: 'lp-tb-k' }, 'Part used (datasheet, mm)'),
        h('table', { class: 'lp-part' },
          h('tr', {}, h('td', {}, ''), h('td', {}, 'min'), h('td', {}, 'max')),
          h('tr', {}, h('td', {}, 'L tip to tip'), h('td', {}, mm(P.L[0])), h('td', {}, mm(P.L[1]))),
          h('tr', {}, h('td', {}, 'T terminal'), h('td', {}, mm(P.T[0])), h('td', {}, mm(P.T[1]))),
          h('tr', {}, h('td', {}, 'W terminal'), h('td', {}, mm(P.W[0])), h('td', {}, mm(P.W[1]))),
          h('tr', {}, h('td', {}, 'Body, height'), h('td', { colspan: '2' }, `${mm(P.bx)} × ${mm(P.by)}, ${mm(P.h)}`)))));
    } else {
      const vals = res?.values || [];
      kids.push(cell('Comparing', vals[0]?.value ?? '–', 'lp-tb-wide lp-tb-name'),
        cell('Density level', vals[1]?.value ?? '–', 'lp-tb-wide'),
        h('div', { class: 'lp-tb-wide' }, h('span', { class: 'lp-tb-k' }, 'Tolerances'), h('div', { class: 'lp-scrubs' }, fScrub, pScrub)),
        cell('How to read it', 'All lands at one scale. Click one to open it on the sheet.', 'lp-tb-wide'));
    }
    tb.replaceChildren(...kids);
  }

  // ---------- the sheet ----------
  function draw() {
    if (!res) return;
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    const P = res.pattern;
    if (!P) { drawCatalogue(); return; }
    cat.style.display = 'none'; svg.style.display = '';
    const W = box.clientWidth, H = box.clientHeight;
    if (W < 20 || H < 20) return;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    pads = padsOf(P);
    if (!pads.some((p) => p.n === sel)) sel = 1;

    // extent in mm, then the scale that fits it with room for the dimensions
    const ex = Math.max(P.cyX, P.Z, P.bx), ey = Math.max(P.cyY, P.sides === 4 ? P.Z : 0, P.by);
    const k = W < 560 ? 0.76 : 1;
    const padL = view.dim ? 100 * k : 26, padR = view.dim ? 96 * k : 26, padT = view.dim ? 74 : 26, padB = view.dim ? 84 : 26;
    const s = clamp(Math.min((W - padL - padR) / ex, (H - padT - padB) / ey), 4, 220);
    const cx = padL + (W - padL - padR) / 2, cy = padT + (H - padT - padB) / 2;
    const X = (x) => cx + x * s, Y = (y) => cy - y * s;
    scaleCap.textContent = `to scale · ${Math.round(s)} px/mm · grid ${gridStep(s)} mm`;

    const defs = sv(svg, 'defs');
    const mk = sv(defs, 'marker', { id: 'lp-arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,1 L10,5 L0,9 z' });

    // grid
    const g = gridStep(s);
    const gg = sv(svg, 'g');
    const x0 = Math.floor(-cx / s / g) * g, x1 = Math.ceil((W - cx) / s / g) * g;
    const y0 = Math.floor(-(H - cy) / s / g) * g, y1 = Math.ceil(cy / s / g) * g;
    for (let x = x0; x <= x1 + 1e-9; x += g) sv(gg, 'line', { x1: X(x), x2: X(x), y1: 0, y2: H, class: Math.abs(x / (g * 5) - Math.round(x / (g * 5))) < 1e-6 ? 'lp-grid-major' : 'lp-grid' });
    for (let y = y0; y <= y1 + 1e-9; y += g) sv(gg, 'line', { y1: Y(y), y2: Y(y), x1: 0, x2: W, class: Math.abs(y / (g * 5) - Math.round(y / (g * 5))) < 1e-6 ? 'lp-grid-major' : 'lp-grid' });
    sv(svg, 'path', { d: `M${X(0) - 7},${Y(0)}h14M${X(0)},${Y(0) - 7}v14`, class: 'lp-origin' });

    // courtyard
    if (view.cy) {
      sv(svg, 'rect', { x: X(-P.cyX / 2), y: Y(P.cyY / 2), width: P.cyX * s, height: P.cyY * s, class: 'lp-cy' });
      sv(svg, 'text', { x: X(P.cyX / 2) - 4, y: Y(P.cyY / 2) - 5, 'text-anchor': 'end', class: 'lp-cy-t' }, `courtyard ${mm(P.cyX)} × ${mm(P.cyY)}  (+${P.cy})`);
    }
    // body
    if (view.body) {
      sv(svg, 'rect', { x: X(-P.bx / 2), y: Y(P.by / 2), width: P.bx * s, height: P.by * s, class: 'lp-body' });
      const r = clamp(Math.min(P.bx, P.by) * s * 0.05, 2, 5);
      if (P.n > 2 || P.form === 'molded') sv(svg, 'circle', { cx: X(-P.bx / 2) + r * 2.4, cy: Y(P.by / 2) + r * 2.4, r, class: 'lp-pin1' });
    }
    // copper
    const padG = sv(svg, 'g');
    if (view.cu) {
      for (const p of pads) {
        const el = sv(padG, 'rect', { x: X(p.x - p.w / 2), y: Y(p.y + p.h / 2), width: p.w * s, height: p.h * s, rx: Math.min(3, Math.min(p.w, p.h) * s * 0.08),
          class: `lp-pad${p.ep ? ' lp-ep' : ''}${p.n === sel ? ' lp-sel' : ''}`, 'data-n': p.n });
        el.addEventListener('pointerenter', () => showPad(p));
        el.addEventListener('pointerdown', () => { sel = p.n; draw(); });
        const fs = Math.min(p.w, p.h) * s;
        if (fs >= 11 || p.ep) sv(padG, 'text', { x: X(p.x), y: Y(p.y) + 4, 'text-anchor': 'middle', class: 'lp-pad-n' }, p.ep ? `EP ${p.n}` : p.n);
      }
    }
    // leads over the copper: where the part actually lands
    if (view.lead) {
      const lg = sv(svg, 'g');
      for (const r of leadsOf(P)) sv(lg, 'rect', { x: X(r.x0), y: Y(r.y1), width: (r.x1 - r.x0) * s, height: (r.y1 - r.y0) * s, class: r.foot ? 'lp-foot' : 'lp-lead' });
      // lead tip at L min and L max: the toe fillet is the copper beyond them
      const yTop = P.p ? ((P.row - 1) * P.p / 2 + P.X / 2) : P.X / 2;
      for (const [L, t] of [[P.L[0], 'L min'], [P.L[1], 'L max']]) {
        for (const sg of [-1, 1]) sv(lg, 'line', { x1: X(sg * L / 2), x2: X(sg * L / 2), y1: Y(yTop) - 10, y2: Y(-yTop) + 10, class: 'lp-tip' });
      }
      sv(lg, 'text', { x: X(P.L[1] / 2) + 3, y: Y(-yTop) + 20, class: 'lp-tip-t' }, `tip ${mm(P.L[0])}…${mm(P.L[1])}`);
    }
    // other density levels, dashed
    if (view.ghost) {
      for (const [k] of LEVELS) {
        if (k === P.level) continue;
        const q = { ...P, ...P.levels[k] };
        const gp = padsOf(q).filter((p) => !p.ep);
        for (const p of gp) sv(svg, 'rect', { x: X(p.x - p.w / 2), y: Y(p.y + p.h / 2), width: p.w * s, height: p.h * s, class: 'lp-ghost' });
      }
      sv(svg, 'text', { x: 10, y: 18, class: 'lp-ghost-t' }, `dashed: density ${LEVELS.map((l) => l[0]).filter((k) => k !== P.level).join(' and ')}`);
    }

    // dimensions
    if (view.dim) drawDims(P, X, Y, s);
    const cur = pads.find((p) => p.n === sel);
    if (cur) showPad(cur);
  }

  function showPad(p) {
    const P = res?.pattern; if (!P) return;
    readout.replaceChildren(
      h('span', {}, p.ep ? 'Thermal pad ' : p.tab ? 'Tab ' : 'Pad ', h('b', {}, p.n)),
      h('span', {}, 'centre ', h('b', {}, `${mm(p.x)}, ${mm(p.y)}`), ' mm'),
      h('span', {}, 'size ', h('b', {}, `${mm(p.w)} × ${mm(p.h)}`), ' mm'),
      h('span', {}, 'origin: part centre, y up · arrow keys step the pads'));
  }

  function dim(parent, ax, ay, bx, by, off, label, { bad = false, anchor } = {}) {
    // Linear dimension between two points (px), offset perpendicular by `off` px.
    const g = sv(parent, 'g', { class: bad ? 'lp-bad' : '' });
    const horiz = Math.abs(ay - by) < 1e-6;
    let p1, p2;
    if (horiz) { p1 = [ax, ay + off]; p2 = [bx, by + off]; } else { p1 = [ax + off, ay]; p2 = [bx + off, by]; }
    sv(g, 'line', { x1: ax, y1: ay, x2: p1[0], y2: p1[1], class: 'lp-ext' });
    sv(g, 'line', { x1: bx, y1: by, x2: p2[0], y2: p2[1], class: 'lp-ext' });
    const span = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (span > 18) sv(g, 'line', { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], class: 'lp-dim', 'marker-start': 'url(#lp-arrow)', 'marker-end': 'url(#lp-arrow)' });
    else { // arrows from outside
      const [ux, uy] = horiz ? [1, 0] : [0, 1];
      sv(g, 'line', { x1: p1[0] - ux * 16, y1: p1[1] - uy * 16, x2: p1[0], y2: p1[1], class: 'lp-dim', 'marker-end': 'url(#lp-arrow)' });
      sv(g, 'line', { x1: p2[0] + ux * 16, y1: p2[1] + uy * 16, x2: p2[0], y2: p2[1], class: 'lp-dim', 'marker-end': 'url(#lp-arrow)' });
    }
    const [k, v] = label;
    let tx, ty, ta;
    if (horiz) { tx = (p1[0] + p2[0]) / 2; ty = p1[1] + (off < 0 ? -5 : 14); ta = 'middle'; } else { tx = p1[0] + (off < 0 ? -6 : 6); ty = (p1[1] + p2[1]) / 2 + 4; ta = off < 0 ? 'end' : 'start'; }
    if (anchor) ta = anchor;
    const t = sv(g, 'text', { x: tx, y: ty, 'text-anchor': ta, class: 'lp-dim-t' });
    sv(t, 'tspan', { class: 'lp-k' }, `${k} `); sv(t, 'tspan', {}, v);
    return g;
  }

  function drawDims(P, X, Y, s) {
    const g = sv(svg, 'g');
    const left = pads.filter((p) => p.side === 'L');
    const right = pads.filter((p) => p.side === 'R');
    const p1 = left[0];
    const topY = Y(Math.max(P.cyY / 2, P.by / 2, ...pads.map((p) => p.y + p.h / 2)));
    const botY = Y(-Math.max(P.cyY / 2, P.by / 2, ...pads.map((p) => -(p.y - p.h / 2))));
    const rightX = X(Math.max(P.cyX / 2, P.Z / 2, P.bx / 2));
    const leftX = X(-Math.max(P.cyX / 2, P.Z / 2, P.bx / 2));
    // Y (pad length) over pin 1, C over the two rows
    dim(g, X(p1.x - p1.w / 2), Y(p1.y + p1.h / 2), X(p1.x + p1.w / 2), Y(p1.y + p1.h / 2), topY - Y(p1.y + p1.h / 2) - 16, ['Y', mm(P.Y)]);
    const pr = right.length ? right[right.length - 1] : p1;
    dim(g, X(p1.x), Y(p1.y + p1.h / 2), X(-p1.x), Y(p1.y + p1.h / 2), topY - Y(p1.y + p1.h / 2) - 42, ['C', mm(P.C)]);
    // Z and G under the part
    const rowBot = Y(Math.min(...left.map((p) => p.y - p.h / 2)));
    dim(g, X(-P.Z / 2), rowBot, X(P.Z / 2), rowBot, botY - rowBot + 22, ['Z', mm(P.Z)]);
    dim(g, X(-P.G / 2), rowBot, X(P.G / 2), rowBot, botY - rowBot + 48, ['G', mm(P.G)], { bad: P.G < 0.2 });
    if (P.G < 0.2) sv(g, 'rect', { x: X(-P.G / 2), y: Y(P.X / 2 + (P.p ? (P.row - 1) * P.p / 2 : 0)), width: Math.max(2, P.G * s), height: (P.X + (P.p ? (P.row - 1) * P.p : 0)) * s, class: 'lp-badzone' });
    // X (pad width) at the top right pad
    const tr = pr.side === 'R' ? pr : p1;
    const w = tr.tab ? P.X : tr.h;
    const trTop = pr.tab ? (right.find((p) => !p.tab) || p1) : tr;
    const xr = trTop === p1 ? p1 : trTop;
    if (!pr.tab) dim(g, X(xr.x + xr.w / 2), Y(xr.y + w / 2), X(xr.x + xr.w / 2), Y(xr.y - w / 2), rightX - X(xr.x + xr.w / 2) + 20, ['X', mm(P.X)]);
    else {
      dim(g, X(pr.x + pr.w / 2), Y(pr.y + pr.h / 2), X(pr.x + pr.w / 2), Y(pr.y - pr.h / 2), rightX - X(pr.x + pr.w / 2) + 20, ['tab', mm(P.Xtab)]);
      dim(g, X(p1.x - p1.w / 2), Y(p1.y + p1.h / 2), X(p1.x - p1.w / 2), Y(p1.y - p1.h / 2), leftX - X(p1.x - p1.w / 2) - 58, ['X', mm(P.X)]);
    }
    // pitch and the gap between neighbouring pads, at the left row
    if (P.p && left.length > 1) {
      const a = left[0], b = left[1];
      dim(g, X(a.x - a.w / 2), Y(a.y), X(b.x - b.w / 2), Y(b.y), leftX - X(a.x - a.w / 2) - 20, ['p', mm(P.p)]);
      const bad = P.gap != null && P.gap < 0.15;
      const gy0 = Y(a.y - a.h / 2), gy1 = Y(b.y + b.h / 2);
      if (bad) sv(g, 'rect', { x: X(a.x - a.w / 2), y: gy0, width: a.w * s, height: Math.max(1.5, gy1 - gy0), class: 'lp-badzone' });
      const t = sv(g, 'g', { class: bad ? 'lp-bad' : '' });
      const tx = sv(t, 'text', { x: X(a.x + a.w / 2) + 6, y: (gy0 + gy1) / 2 + 4, class: 'lp-dim-t' });
      sv(tx, 'tspan', { class: 'lp-k' }, 'gap '); sv(tx, 'tspan', {}, mm(P.gap) + (bad ? '  < 0.15 mask web' : ''));
    }
  }

  function gridStep(s) {
    for (const g of [0.05, 0.1, 0.25, 0.5, 1, 2]) if (g * s >= 14) return g;
    return 5;
  }

  // ---------- pkg = all: every matching pattern side by side, one scale ----------
  function drawCatalogue() {
    svg.style.display = 'none'; cat.style.display = '';
    const list = res.patterns || [];
    readout.replaceChildren(h('span', {}, h('b', {}, list.length), ` land patterns at density ${ctx.raw.level || 'N'}, all drawn at one scale`));
    const maxE = Math.max(...list.map((q) => Math.max(q.cyX, q.cyY)), 1);
    const s = clamp(136 / maxE, 4, 60);
    scaleCap.textContent = `to scale · ${Math.round(s * 10) / 10} px/mm`;
    cat.replaceChildren(...list.map((q) => {
      const size = Math.max(q.cyX, q.cyY) * s + 8;
      const w = 136 + 8;
      const hh = Math.max(24, Math.min(size, 144));
      const card = h('button', { type: 'button', class: 'lp-card', title: `Open ${q.id}`, onclick: () => pick(q.id) });
      const g = sv(null, 'svg', { viewBox: `${-w / 2} ${-hh / 2} ${w} ${hh}`, height: hh, 'aria-hidden': 'true' });
      sv(g, 'rect', { x: -q.cyX * s / 2, y: -q.cyY * s / 2, width: q.cyX * s, height: q.cyY * s, class: 'lp-cy' });
      for (const p of padsOf(q)) sv(g, 'rect', { x: (p.x - p.w / 2) * s, y: -(p.y + p.h / 2) * s, width: Math.max(.8, p.w * s), height: Math.max(.8, p.h * s), class: `lp-pad${p.ep ? ' lp-ep' : ''}` });
      card.append(g, h('b', {}, q.id), h('span', {}, `pad ${mm(q.Y)} × ${mm(q.X)}  C ${mm(q.C)}`), h('span', {}, `cy ${mm(q.cyX)} × ${mm(q.cyY)}${q.p ? `  p ${mm(q.p)}` : ''}`));
      return card;
    }));
  }
}
