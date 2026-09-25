// Board Density Estimator page: the board filled with its parts, and the
// wire the netlist needs poured into the routing layers.
//  - Ruler: pin density against the density classes; drag the marker to try
//    another pin count on this board.
//  - Plan: every part drawn as its average courtyard, to scale, spread over
//    the board (both sides when parts go on both) - the gaps are where the
//    routing has to go. Drag the board edges to resize it and the corner of
//    the highlighted part to change the average courtyard. The orange L is
//    one average link.
//  - Routing: one row per routing-layer count, each showing how full its
//    channels would be; click a row to pick it. The magnifier shows track and
//    space to scale; drag their edges.
// Every number shown is from run()'s result.

const NS = 'http://www.w3.org/2000/svg';
const BANDS = [[0, 50, 'Low', 'var(--tool-z0)'], [50, 100, 'Moderate', 'var(--tool-z1)'], [100, 150, 'High', 'var(--tool-z2)'], [150, Infinity, 'Very high · HDI', 'var(--tool-z3)']];
const UBANDS = [[0, 30, 'var(--tool-z0)'], [30, 50, 'var(--tool-z1)'], [50, 70, 'var(--tool-z2)'], [70, 1e9, 'var(--tool-z3)']];
const DIFF_COL = { Easy: 'var(--tool-c0)', Moderate: 'var(--tool-c1)', Hard: 'var(--tool-c2)' };
const MM2_PER_IN2 = 645.16;
// parts differ in shape, not in area: every tile is the average courtyard
const ASPECT = [1, 1.7, 1, 0.6, 1.3, 2.4, 1, 0.8, 1.5, 0.45, 1.1, 1.9];
/** Where the highlighted sample part sits in the grid of k parts on a w × h board. */
function grid(k, w, h) {
  const cols = Math.max(1, Math.round(Math.sqrt((k * w) / h))), rws = Math.max(1, Math.ceil(k / cols));
  return { cols, rws, px: w / cols, py: h / rws, sc: Math.floor(cols * 0.3), sr: Math.floor((rws - 1) / 2) };
}

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
const svgEl = (label) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('role', 'group'); s.setAttribute('aria-label', label); return s; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (s) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.eE+-]/g, '')); return Number.isFinite(n) ? n : null; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (v) => String(Math.round(v * 100) / 100);
const diffCol = (d) => DIFF_COL[d] || 'var(--tool-c3)';

export function page(root, ctx) {
  let drag = null;
  const V = (lab) => ctx.result?.values?.find((v) => v.label === lab);

  // ---------------- skeleton ----------------
  const ruler = svgEl('Pin density against the density classes');
  const field = (key, label, unit, w) => {
    const i = el('input', { inputmode: 'decimal', spellcheck: 'false', 'aria-label': label, 'data-key': key, style: w ? `width:${w}px` : null });
    i.addEventListener('change', () => ctx.set(key, i.value.trim()));
    return el('label', { class: 'bd-f' }, label, i, unit || null);
  };
  const sidesSeg = el('div', { class: 'bd-seg', role: 'group', 'aria-label': 'Parts placed on' });
  const counts = el('div', { class: 'bd-counts' }, field('parts', 'Parts'), field('pins', 'Pins'), field('ppn', 'Pins / net', null, 46), sidesSeg);
  const rulerBox = el('section', { class: 'bd-box bd-ruler' }, ruler, counts);

  const planHead = el('div', { class: 'bd-head' });
  const plan = svgEl('Board with every part drawn as its average courtyard');
  const planSvgBox = el('div', { class: 'bd-plan-svg' }, plan);
  const planBox = el('section', { class: 'bd-box bd-plan' }, planHead, planSvgBox,
    el('div', { class: 'bd-head', style: 'border-top:1px solid var(--line-soft);border-bottom:0' },
      field('width', 'W', 'mm', 54), field('height', 'H', 'mm', 54), field('courtyard', 'Avg courtyard', 'mm²', 50),
      el('span', { class: 'grow' }), el('span', {}, 'Drag the board edges, and the corner of the highlighted part')));

  const routeHead = el('div', { class: 'bd-head' });
  const rows = svgEl('Routing difficulty for each number of routing layers');
  const wire = el('div', { class: 'bd-wire' });
  const mag = svgEl('Track and space, magnified');
  const magBox = el('div', { class: 'bd-mag' }, mag, el('div', { class: 'bd-cap' }, 'Track and space · magnified'));
  const routeBox = el('section', { class: 'bd-box bd-route' }, routeHead, el('div', { class: 'bd-rows' }, rows), wire, magBox,
    el('div', { class: 'bd-head', style: 'border-top:1px solid var(--line-soft);border-bottom:0' },
      field('layers', 'Routing layers', null, 44), field('track', 'Track', 'mm', 54), field('space', 'Space', 'mm', 54)));

  const msgs = el('div', { class: 'bd-msgs', 'aria-live': 'polite' });
  root.append(el('div', { class: 'bd' }, rulerBox, el('div', { class: 'bd-work' }, planBox, routeBox), el('div', { class: 'bd-foot' }, ctx.outputs, msgs)));

  const syncFields = () => {
    const raw = ctx.raw, inp = ctx.input;
    for (const i of root.querySelectorAll('input[data-key]')) {
      const k = i.dataset.key;
      if (document.activeElement !== i) i.value = raw[k] ?? '';
      i.classList.toggle('bad', String(raw[k] ?? '').trim() !== '' && !(inp[k] > 0));
    }
    const s = String(raw.sides) === '2' ? '2' : '1';
    sidesSeg.replaceChildren(...[['1', 'One side'], ['2', 'Both sides']].map(([v, t]) =>
      el('button', { 'aria-pressed': String(s === v), onclick: () => ctx.set('sides', v) }, t)));
  };

  // ---------------- ruler ----------------
  function rGeom(W, den) {
    const L = 14, R = 14, max = Math.max(200, (den || 0) * 1.15);
    return { X: (v) => L + (clamp(v, 0, max) / max) * (W - L - R), D: (x) => ((x - L) / (W - L - R)) * max, L, R, max };
  }
  function renderRuler() {
    const W = ruler.clientWidth || 800, H = 62;
    const res = ctx.result || {}, pd = V('Pin density'), den = num(pd?.value);
    const G = rGeom(W, den), o = [];
    const y0 = 20, bh = 16;
    for (const [a, b, name, col] of BANDS) {
      const x1 = G.X(a), x2 = G.X(Math.min(b, G.max));
      o.push(`<rect x="${x1}" y="${y0}" width="${Math.max(0, x2 - x1)}" height="${bh}" fill="${col}"/>`);
      if (x2 - x1 > name.length * 6.4 + 12) o.push(`<text x="${x1 + 6}" y="${y0 + 12}" font-size="10.5" fill="var(--ink-soft)">${name}</text>`);
      if (a > 0) o.push(`<line x1="${x1}" y1="${y0}" x2="${x1}" y2="${y0 + bh + 4}" stroke="var(--line)"/><text x="${x1}" y="${y0 + bh + 14}" text-anchor="middle" font-size="10" fill="var(--ink-soft)">${a}</text>`);
    }
    o.push(`<text x="${G.L}" y="${y0 + bh + 14}" font-size="10" fill="var(--ink-soft)">0</text><text x="${W - G.R}" y="${y0 + bh + 14}" text-anchor="end" font-size="10" fill="var(--ink-soft)">pins / in²</text>`);
    if (den != null) {
      const x = G.X(den), bad = (res.warnings || []).some((w) => /pins than parts|pins per part/.test(w));
      const cls = V('Density class');
      const lab = W < 560 ? `${pd.value} pins/in² · ${cls?.value || ''}` : `${pd.value} pins/in² · ${pd.hint} · ${cls?.value || ''}`;
      const lw = lab.length * 7.3, lx = clamp(x - lw / 2, 2, W - lw - 2);
      o.push(`<text x="${lx}" y="12" font-size="11.5" font-weight="600" class="halo" fill="${bad ? 'var(--danger)' : 'var(--ink)'}">${esc(lab)}</text>`);
      o.push(`<g class="hdl" data-k="den" tabindex="0" role="slider" aria-label="Pin density; drag or arrow keys to change the pin count" aria-valuenow="${den}">`
        + `<rect x="${x - 12}" y="${y0 - 4}" width="24" height="${bh + 12}" fill="transparent"/>`
        + `<line x1="${x}" y1="${y0 - 3}" x2="${x}" y2="${y0 + bh + 3}" stroke="${bad ? 'var(--danger)' : 'var(--ink)'}" stroke-width="2"/>`
        + `<path class="kc" d="M${x - 6},${y0 + bh + 9}L${x + 6},${y0 + bh + 9}L${x},${y0 + bh + 1}Z" fill="${bad ? 'var(--danger)' : 'var(--accent)'}" stroke="var(--surface)" stroke-width="1"/>`
        + `<title>Drag to try another pin count on this board</title></g>`);
    }
    ruler.setAttribute('viewBox', `0 0 ${W} ${H}`);
    ruler.innerHTML = o.join('');
  }

  // ---------------- plan ----------------
  function pGeom(W, H, w, h, n) {
    const narrow = W < 520;
    const vert = n > 1 && (narrow || (W - 80) / (2 * w) < (H - 80) / (2 * h) * 0.8);
    const ml = narrow ? 14 : 30, mr = narrow ? 34 : 50, mt = n > 1 ? 52 : 40, mb = 16;
    const g = n > 1 ? Math.max((vert ? h : w) * 0.1, 6) : 0;
    const sx = (W - ml - mr) / (vert || n === 1 ? w : 2 * w + g), sy = (H - mt - mb) / (vert ? 2 * h + g : h);
    let s = Math.max(0.02, Math.min(sx, sy));
    if (vert) s = Math.max(0.02, Math.min(sx, (H - mt - mb - 22) / (2 * h + g)));
    const tw = (vert || n === 1 ? w : 2 * w + g) * s, th = (vert ? 2 * h + g : h) * s + (vert ? 22 : 0);
    return { s, g, vert, x0: ml + (W - ml - mr - tw) / 2, y0: mt + (H - mt - mb - th) / 2, maxX: W - 6, maxY: vert ? mt + (H - mt - mb) / 2 : H - 4 };
  }
  const boardAt = (G, b, w, h) => (G.vert ? [G.x0, G.y0 + b * ((h + G.g) * G.s + 22)] : [G.x0 + b * (w + G.g) * G.s, G.y0]);
  function renderPlan() {
    const W = planSvgBox.clientWidth, H = planSvgBox.clientHeight;
    if (!W || !H) return;
    const inp = ctx.input, res = ctx.result || {};
    const w = inp.width > 0 ? inp.width : 100, h = inp.height > 0 ? inp.height : 80;
    const n = String(ctx.raw.sides) === '2' ? 2 : 1;
    const parts = Math.max(0, Math.round(inp.parts > 0 ? inp.parts : 0)), cy = inp.courtyard > 0 ? inp.courtyard : 0;
    const G = drag?.G || pGeom(W, H, w, h, n), s = G.s;
    const crowd = (res.warnings || []).some((x) => /Parts cover/.test(x));
    const o = [];
    let sample = null;
    for (let b = 0; b < n; b++) {
      const [bx, by] = boardAt(G, b, w, h), bw = w * s, bh = h * s;
      const k = Math.min(4000, b === 0 ? Math.ceil(parts / n) : Math.floor(parts / n));
      o.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="3" fill="var(--tool-board)" stroke="var(--tool-board-edge)" stroke-width="1.3"/>`);
      if (n > 1) o.push(`<text x="${G.vert ? bx : bx + bw / 2}" y="${by - (b === 0 || !G.vert ? 30 : 8)}" text-anchor="${G.vert ? 'start' : 'middle'}" font-size="11" fill="var(--ink-soft)">${b ? 'bottom side' : 'top side'} · ${b === 0 ? Math.ceil(parts / n) : Math.floor(parts / n)} parts</text>`);
      if (!k) continue;
      const { cols, px, py, sc, sr } = grid(k, w, h), rws = Math.ceil(k / cols), a = Math.sqrt(cy);
      const over = a > Math.min(px, py);
      let d = '';
      for (let i = 0; i < k; i++) {
        const c = i % cols, r = Math.floor(i / cols);
        if (b === 0 && c === sc && r === sr) continue;
        const q = Math.sqrt(ASPECT[(i * 7 + r) % ASPECT.length]);
        const cx = bx + (c + 0.5) * px * s, cyy = by + (r + 0.5) * py * s, tw = a * q * s, th = (a / q) * s;
        d += `M${(cx - tw / 2).toFixed(1)},${(cyy - th / 2).toFixed(1)}h${tw.toFixed(1)}v${th.toFixed(1)}h${(-tw).toFixed(1)}Z`;
      }
      const col = b ? 'var(--tool-part-b)' : 'var(--tool-part)';
      o.push(`<path d="${d}" fill="${col}" fill-opacity="${over ? 0.55 : 0.8}" stroke="${over || crowd ? 'var(--danger)' : 'var(--tool-part-edge)'}" stroke-width="${a * s > 6 ? 0.7 : 0.35}" pointer-events="none"/>`);
      if (b === 0 && sr < rws) sample = { cx: bx + (sc + 0.5) * px * s, cy: by + (sr + 0.5) * py * s, a };
    }
    // dimensions and handles on the top board
    const bx = G.x0, by = G.y0, bw = w * s, bh = h * s;
    const lastX = G.vert ? bx + bw : G.x0 + (n - 1) * (w + G.g) * s + bw;
    o.push(`<g stroke="var(--ink-soft)" stroke-width=".8" pointer-events="none"><line x1="${bx}" y1="${by - 14}" x2="${bx + bw}" y2="${by - 14}"/><line x1="${bx}" y1="${by - 4}" x2="${bx}" y2="${by - 18}"/><line x1="${bx + bw}" y1="${by - 4}" x2="${bx + bw}" y2="${by - 18}"/>`
      + `<line x1="${lastX + 14}" y1="${by}" x2="${lastX + 14}" y2="${by + bh}"/><line x1="${lastX + 4}" y1="${by}" x2="${lastX + 18}" y2="${by}"/><line x1="${lastX + 4}" y1="${by + bh}" x2="${lastX + 18}" y2="${by + bh}"/></g>`);
    o.push(`<text x="${bx + bw / 2}" y="${by - 18}" text-anchor="middle" font-size="12" font-weight="600" class="halo" fill="var(--ink)">${r2(w)} mm</text>`);
    o.push(`<text transform="translate(${lastX + 28},${by + bh / 2}) rotate(-90)" text-anchor="middle" font-size="12" font-weight="600" class="halo" fill="var(--ink)">${r2(h)} mm</text>`);
    // the average link, from the sample part
    const wd = V('Wiring demand'), m = /links × ([\d.e+-]+) mm/.exec(wd?.hint || '');
    if (sample && m) {
      const L = Number(m[1]) * s, ax = sample.cx, ay = sample.cy;
      const lx = Math.min(L * 0.6, bx + bw - ax - 4), ly = Math.min(L - lx, by + bh - ay - 4);
      o.push(`<path d="M${ax},${ay}h${lx}v${ly}" fill="none" stroke="var(--tool-link)" stroke-width="2.2" stroke-linejoin="round" pointer-events="none"/><circle cx="${ax + lx}" cy="${ay + ly}" r="3" fill="var(--tool-link)" pointer-events="none"/>`);
      o.push(`<text x="${ax + Math.max(lx / 2, 4)}" y="${ay - 7}" text-anchor="${lx > 90 ? 'middle' : 'start'}" font-size="11" font-weight="600" class="halo-b" fill="var(--tool-link)" pointer-events="none">avg link ${m[1]} mm</text>`);
    }
    if (sample && sample.a > 0) {
      const hs = (sample.a * s) / 2, x2 = sample.cx + hs, y2 = sample.cy + hs;
      o.push(`<rect x="${sample.cx - hs}" y="${sample.cy - hs}" width="${2 * hs}" height="${2 * hs}" fill="none" stroke="var(--accent)" stroke-width="1.6" pointer-events="none"/>`);
      o.push(`<rect x="${sample.cx - hs}" y="${sample.cy - hs}" width="${2 * hs}" height="${2 * hs}" fill="var(--accent)" fill-opacity=".25" pointer-events="none"/>`);
      o.push(`<text x="${sample.cx}" y="${sample.cy + hs + 13}" text-anchor="end" font-size="10.5" font-weight="600" class="halo-b" fill="var(--accent)" pointer-events="none">${r2(cy)} mm²</text>`);
      o.push(`<g class="hdl" data-k="cy" tabindex="0" role="slider" aria-label="Average courtyard, drag or arrow keys" aria-valuenow="${cy}"><circle cx="${x2}" cy="${y2}" r="11" fill="transparent"/><circle class="kc" cx="${x2}" cy="${y2}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/><title>Drag to change the average courtyard</title></g>`);
    }
    const knob = (k, x, y, shape, label, now) => `<g class="hdl" data-k="${k}" tabindex="0" role="slider" aria-label="${label}" aria-valuenow="${now}"><rect x="${x - 12}" y="${y - 12}" width="24" height="24" fill="transparent"/>${shape}<title>${label}</title></g>`;
    o.push(knob('w', bx + bw, by + bh / 2, `<rect class="kc" x="${bx + bw - 4}" y="${by + bh / 2 - 13}" width="8" height="26" rx="3" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/>`, 'Board width, drag or arrow keys', r2(w)));
    o.push(knob('h', bx + bw / 2, by + bh, `<rect class="kc" x="${bx + bw / 2 - 13}" y="${by + bh - 4}" width="26" height="8" rx="3" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/>`, 'Board height, drag or arrow keys', r2(h)));
    o.push(knob('wh', bx + bw, by + bh, `<circle class="kc" cx="${bx + bw}" cy="${by + bh}" r="7" fill="var(--surface)" stroke="var(--accent)" stroke-width="2.5"/>`, 'Board size, drag', `${r2(w)} x ${r2(h)}`));
    plan.setAttribute('viewBox', `0 0 ${W} ${H}`);
    plan.innerHTML = o.join('');

    const pf = V('Placement fill'), pdn = V('Part density');
    const tone = pf?.tone === 'bad' ? 'bad' : pf?.tone === 'warn' ? 'warn' : 'ok';
    planHead.replaceChildren(el('h2', {}, 'Placement'), pf ? el('span', { class: `bd-verdict ${tone}` }, `${pf.value} filled`) : null,
      el('span', {}, pf?.hint || ''), el('span', { class: 'grow' }), pdn ? el('span', {}, `${pdn.value} ${pdn.unit}`) : null);
  }

  // ---------------- routing rows ----------------
  function rowData() {
    const res = ctx.result || {};
    const t = res.tables?.find((x) => /against routing layers/.test(x.title));
    if (!t) return [];
    const cur = Math.round(ctx.input.layers);
    const list = t.rows.map((r) => ({ n: Number(String(r[0]).replace(/[^\d]/g, '')), cap: r[1], pct: num(r[2]), txt: r[2], diff: r[3] }));
    if (cur > 0 && !list.some((r) => r.n === cur)) {
      const d = V('Routing difficulty'), c = V('Wiring capacity'), p = /= ([\d.]+) %/.exec(d?.hint || '');
      if (p) { list.push({ n: cur, cap: c?.value, pct: Number(p[1]), txt: `${p[1]} %`, diff: d.value }); list.sort((a, b) => a.n - b.n); }
    }
    return list;
  }
  function renderRows() {
    const W = rows.clientWidth || 360, list = rowData(), cur = Math.round(ctx.input.layers);
    const rh = 27, top = 18, H = top + list.length * rh + 4;
    const narrow = W < 400;
    const x0 = narrow ? 40 : 64, x1 = W - (narrow ? 128 : 132), max = Math.max(100, ...list.map((r) => Math.min(r.pct || 0, 160)));
    const X = (p) => x0 + (clamp(p, 0, max) / max) * (x1 - x0);
    const o = [];
    for (const [a, b, col] of UBANDS) o.push(`<rect x="${X(a)}" y="${top - 2}" width="${Math.max(0, X(Math.min(b, max)) - X(a))}" height="${list.length * rh}" fill="${col}"/>`);
    for (const p of [30, 50, 70, 100]) if (p <= max) o.push(`<line x1="${X(p)}" y1="${top - 4}" x2="${X(p)}" y2="${top + list.length * rh - 2}" stroke="var(--line)" stroke-dasharray="${p === 100 ? '' : '2 3'}"/><text x="${X(p)}" y="${top - 6}" text-anchor="middle" font-size="9.5" fill="var(--ink-soft)">${p} %</text>`);
    o.push(`<text x="10" y="${top - 6}" font-size="9.5" fill="var(--ink-soft)">layers</text>`);
    if (!narrow) o.push(`<text x="${W - 8}" y="${top - 6}" text-anchor="end" font-size="9.5" fill="var(--ink-soft)">demand / capacity</text>`);
    list.forEach((r, i) => {
      const y = top + i * rh, on = r.n === cur, col = diffCol(r.diff);
      o.push(`<g class="row${on ? ' cur' : ''}" data-n="${r.n}" tabindex="${on ? 0 : -1}" role="radio" aria-checked="${on}" aria-label="${r.n} routing layers: ${esc(r.txt)} of capacity, ${esc(r.diff)}">`
        + `<rect class="rbg" x="2" y="${y}" width="${W - 4}" height="${rh - 3}" rx="4" fill="transparent"/>`
        + `<text x="14" y="${y + 16}" font-size="${on ? 13 : 12}" font-weight="${on ? 700 : 500}" fill="var(--ink)">${r.n}</text>`
        + (narrow ? '' : `<text x="32" y="${y + 16}" font-size="10" fill="var(--ink-soft)">lyr</text>`)
        + `<rect x="${x0}" y="${y + 6}" width="${Math.max(1.5, X(r.pct) - x0)}" height="${rh - 15}" rx="2" fill="${col}" fill-opacity="${on ? 1 : 0.7}"/>`
        + (r.pct > max ? `<path d="M${x1 - 1},${y + 4}l6,${(rh - 11) / 2}l-6,${(rh - 11) / 2}" fill="${col}"/>` : '')
        + `<text x="${x1 + 8}" y="${y + 16}" font-size="11.5" font-weight="${on ? 700 : 400}" fill="var(--ink)">${esc(r.txt)}</text>`
        + `<text x="${W - 8}" y="${y + 16}" text-anchor="end" font-size="10.5" fill="${col}" font-weight="600">${esc(narrow ? r.diff.replace('Moderate', 'Mod.').replace(/Very hard.*/, 'V. hard') : r.diff.replace(/ \/ will not route/, ''))}</text>`
        + `<title>${r.n} routing layers: capacity ${r.cap} m, ${r.txt} used - ${r.diff}. Click to use ${r.n}.</title></g>`);
    });
    rows.setAttribute('viewBox', `0 0 ${W} ${H}`);
    rows.style.height = `${H}px`;
    rows.innerHTML = o.join('');

    const d = V('Routing difficulty');
    const tone = d?.tone === 'bad' ? 'bad' : d?.tone === 'warn' ? 'warn' : 'ok';
    routeHead.replaceChildren(el('h2', {}, 'Routing'), d ? el('span', { class: `bd-verdict ${tone}` }, d.value) : null, el('span', {}, d?.hint || ''),
      el('span', { class: 'grow' }), el('span', {}, 'click a row to pick the layer count'));
    const f = (lab, v, sub) => el('div', {}, lab, el('b', {}, v), sub ? el('em', {}, sub) : null);
    const wd = V('Wiring demand'), wc = V('Wiring capacity'), lf = V('Routing layers for 50 %');
    wire.replaceChildren(
      f('Wiring demand', wd ? `${wd.value} m` : '–', wd?.hint),
      f('Wiring capacity', wc ? `${wc.value} m` : '–', wc?.hint?.replace(', 50 % usable', '')),
      f('Layers for 50 %', lf ? String(lf.value) : '–', lf?.hint));
  }

  // ---------------- magnifier ----------------
  function mGeom(H, t, sp) { const z = (H - 44) / (3 * t + 2 * sp); return { z, y0: 26 }; }
  function renderMag() {
    const W = mag.clientWidth || 360, H = 150;
    const inp = ctx.input, t = inp.track > 0 ? inp.track : 0.15, sp = inp.space > 0 ? inp.space : 0.15;
    const G = drag?.MG || mGeom(H, t, sp), z = G.z;
    const bad = (ctx.result?.warnings || []).some((w) => /Track \+ space/.test(w));
    const x0 = 16, x1 = W - (W < 400 ? 118 : 150);
    const o = [];
    o.push(`<rect x="${x0}" y="${G.y0 - 6}" width="${x1 - x0}" height="${H - G.y0 - 8}" fill="var(--tool-lam)" rx="2"/>`);
    const ys = [];
    for (let i = 0; i < 3; i++) {
      const y = G.y0 + i * (t + sp) * z;
      ys.push(y);
      o.push(`<rect x="${x0}" y="${y}" width="${x1 - x0}" height="${t * z}" fill="${bad ? 'var(--danger)' : 'var(--tool-cu)'}"/>`);
    }
    const dx = x1 + 10;
    const dim = (ya, yb, lab, col = 'var(--ink)') => `<line x1="${x1 + 2}" y1="${ya}" x2="${dx + 4}" y2="${ya}" stroke="var(--ink-soft)" stroke-width=".6"/><line x1="${x1 + 2}" y1="${yb}" x2="${dx + 4}" y2="${yb}" stroke="var(--ink-soft)" stroke-width=".6"/>`
      + `<line x1="${dx}" y1="${ya}" x2="${dx}" y2="${yb}" stroke="var(--ink-soft)"/><text x="${dx + 8}" y="${(ya + yb) / 2 + 4}" font-size="11.5" font-weight="600" fill="${col}">${lab}</text>`;
    o.push(dim(ys[1], ys[1] + t * z, `track ${r2(t)}`), dim(ys[1] + t * z, ys[2], `space ${r2(sp)}`));
    const wc = V('Wiring capacity'), pm = /at ([\d.]+) mm pitch/.exec(wc?.hint || '');
    if (pm) o.push(`<text x="${dx + 8}" y="${ys[0] + 6}" font-size="10.5" fill="${bad ? 'var(--danger)' : 'var(--ink-soft)'}">pitch ${pm[1]} mm</text>`);
    if (bad) o.push(`<text x="${x0 + 6}" y="${H - 6}" font-size="10.5" font-weight="600" class="halo" fill="var(--danger)">below standard fab: price as HDI</text>`);
    const kx = x0 + (x1 - x0) * 0.62;
    o.push(`<g class="hdl" data-k="track" tabindex="0" role="slider" aria-label="Track width, drag or arrow keys" aria-valuenow="${t}"><rect x="${kx - 12}" y="${ys[1] + t * z - 10}" width="24" height="20" fill="transparent"/><rect class="kc" x="${kx - 11}" y="${ys[1] + t * z - 3}" width="22" height="6" rx="3" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.2"/><title>Drag to change the track width</title></g>`);
    o.push(`<g class="hdl" data-k="space" tabindex="0" role="slider" aria-label="Clearance, drag or arrow keys" aria-valuenow="${sp}"><rect x="${kx + 20}" y="${ys[2] - 10}" width="24" height="20" fill="transparent"/><rect class="kc" x="${kx + 21}" y="${ys[2] - 3}" width="22" height="6" rx="3" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/><title>Drag to change the clearance</title></g>`);
    mag.setAttribute('viewBox', `0 0 ${W} ${H}`);
    mag.innerHTML = o.join('');
  }

  function renderMsgs() {
    const res = ctx.result || {};
    msgs.replaceChildren(...(res.warnings || []).map((w) => el('div', {}, w)),
      el('details', { class: 'bd-notes' }, el('summary', { style: 'font-size:11.5px;color:var(--ink-soft);cursor:pointer' }, `Method and assumptions (${(res.notes || []).length} notes)`),
        ...(res.notes || []).map((n) => el('div', { class: 'note', style: 'margin-top:4px' }, n))));
  }

  // ---------------- interaction ----------------
  const refocus = (svg, sel) => requestAnimationFrame(() => svg.querySelector(sel)?.focus({ preventScroll: true }));
  const pt = (svg, e) => { const r = svg.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * svg.viewBox.baseVal.width, ((e.clientY - r.top) / r.height) * svg.viewBox.baseVal.height]; };
  const round1 = (v) => String(Math.round(v * 10) / 10);

  function startDrag(svg, e, k) {
    const inp = ctx.input;
    const w = inp.width > 0 ? inp.width : 100, h = inp.height > 0 ? inp.height : 80, n = String(ctx.raw.sides) === '2' ? 2 : 1;
    drag = { svg, k, G: pGeom(planSvgBox.clientWidth, planSvgBox.clientHeight, w, h, n),
      MG: mGeom(150, inp.track > 0 ? inp.track : 0.15, inp.space > 0 ? inp.space : 0.15),
      RG: rGeom(ruler.clientWidth || 800, num(V('Pin density')?.value)) };
    svg.setPointerCapture(e.pointerId); svg.classList.add('dragging');
    e.preventDefault();
  }
  function moveDrag(e) {
    const { svg, k, G, MG, RG } = drag, [x, y] = pt(svg, e), inp = ctx.input, patch = {};
    if (k === 'w' || k === 'wh') patch.width = String(clamp(Math.round((Math.min(x, G.maxX) - G.x0) / G.s), 5, 1000));
    if (k === 'h' || k === 'wh') patch.height = String(clamp(Math.round((Math.min(y, G.maxY) - G.y0) / G.s), 5, 1000));
    if (k === 'cy') {
      const w = inp.width, h = inp.height, n = String(ctx.raw.sides) === '2' ? 2 : 1;
      const q = grid(Math.ceil(Math.round(inp.parts) / n), w, h);
      const cx = G.x0 + (q.sc + 0.5) * q.px * G.s, cyy = G.y0 + (q.sr + 0.5) * q.py * G.s;
      const a = (2 * Math.max(Math.abs(x - cx), Math.abs(y - cyy))) / G.s;
      patch.courtyard = round1(clamp(a * a, 0.5, 5000));
    }
    if (k === 'den') {
      const A = (inp.width * inp.height) / MM2_PER_IN2;
      patch.pins = String(Math.max(1, Math.round(clamp(RG.D(x), 1, RG.max) * A)));
    }
    if (k === 'track') patch.track = r2(clamp((y - (MG.y0 + (inp.track + inp.space) * MG.z)) / MG.z, 0.03, 2));
    if (k === 'space') patch.space = r2(clamp((y - (MG.y0 + (inp.track + inp.space) * MG.z + inp.track * MG.z)) / MG.z, 0.03, 2));
    if (Object.entries(patch).some(([kk, v]) => String(ctx.raw[kk]) !== v)) ctx.setMany(patch);
  }
  function endDrag() {
    if (!drag) return;
    const { svg, k } = drag;
    drag = null; svg.classList.remove('dragging');
    renderAll();
    refocus(svg, `.hdl[data-k="${k}"]`);
  }
  for (const svg of [plan, ruler, mag]) {
    svg.addEventListener('pointerdown', (e) => { const k = e.target.closest('.hdl')?.dataset.k; if (k) startDrag(svg, e, k); });
    svg.addEventListener('pointermove', (e) => { if (drag && drag.svg === svg) moveDrag(e); });
    svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('keydown', (e) => {
      const g = e.target.closest('.hdl'); if (!g) return;
      const k = g.dataset.k, big = e.shiftKey;
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (!d) return;
      e.preventDefault();
      const inp = ctx.input, raw = ctx.raw, patch = {};
      const hz = e.key === 'ArrowRight' || e.key === 'ArrowLeft';
      if (k === 'w' || (k === 'wh' && hz)) patch.width = String(clamp(Math.round(inp.width + d * (big ? 10 : 1)), 5, 1000));
      if (k === 'h' || (k === 'wh' && !hz)) patch.height = String(clamp(Math.round(inp.height + (hz ? d : -d) * (big ? 10 : 1)), 5, 1000));
      if (k === 'cy') patch.courtyard = round1(clamp(inp.courtyard + d * (big ? 10 : 1), 0.5, 5000));
      if (k === 'den') { const A = (inp.width * inp.height) / MM2_PER_IN2; const den = inp.pins / A + d * (big ? 10 : 1); patch.pins = String(Math.max(1, Math.round(den * A))); }
      if (k === 'track' || k === 'space') patch[k] = r2(clamp(inp[k] + d * (big ? 0.05 : 0.01), 0.03, 2));
      if (Object.entries(patch).some(([kk, v]) => String(raw[kk]) !== v)) ctx.setMany(patch);
      refocus(svg, `.hdl[data-k="${k}"]`);
    });
  }
  rows.addEventListener('click', (e) => { const g = e.target.closest('.row'); if (g) { ctx.set('layers', g.dataset.n); refocus(rows, `.row[data-n="${g.dataset.n}"]`); } });
  rows.addEventListener('keydown', (e) => {
    const g = e.target.closest('.row'); if (!g) return;
    const list = rowData().map((r) => r.n), i = list.indexOf(Number(g.dataset.n));
    let n = null;
    if (e.key === 'Enter' || e.key === ' ') n = Number(g.dataset.n);
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = list[Math.min(list.length - 1, i + 1)];
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = list[Math.max(0, i - 1)];
    if (n == null) return;
    e.preventDefault(); ctx.set('layers', String(n)); refocus(rows, `.row[data-n="${n}"]`);
  });

  function renderAll() { syncFields(); renderRuler(); renderPlan(); renderRows(); renderMag(); renderMsgs(); }
  ctx.onResult(renderAll); // while dragging, the drawing keeps the scale it had when the drag began
  new ResizeObserver(() => { if (!drag) { renderPlan(); } }).observe(planSvgBox);
  new ResizeObserver(() => { if (!drag) { renderRows(); renderMag(); } }).observe(routeBox);
  new ResizeObserver(() => { if (!drag) renderRuler(); }).observe(rulerBox);
}
