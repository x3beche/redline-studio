// Impedance Calculator page: the board's cross-section, drawn to scale, is the
// interface. Drag the copper edges (W), the gap (S), the dielectric top (H),
// the upper plane (H2), the copper top (T) and scrub εr; the impedance and the
// width sweep follow. Every number shown comes from tool.js run().

const MIL = 0.0254; // mm
const SVGNS = 'http://www.w3.org/2000/svg';

const KINDS = [
  ['microstrip', 'Microstrip', 'Surface microstrip: trace on the outer layer over one plane'],
  ['stripline', 'Stripline', 'Stripline: trace between two planes (offset when H1 differs from H2)'],
  ['diff-microstrip', 'Pair, outer', 'Edge-coupled differential pair on the outer layer'],
  ['diff-stripline', 'Pair, inner', 'Edge-coupled differential pair between two planes'],
];

const pict = (kind) => {
  const diff = kind.startsWith('diff'), strip = kind.includes('stripline');
  const tr = diff ? '<rect class="pk-cu" x="11" y="Y" width="7" height="3"/><rect class="pk-cu" x="22" y="Y" width="7" height="3"/>'
    : '<rect class="pk-cu" x="15" y="Y" width="10" height="3"/>';
  return `<svg viewBox="0 0 40 24" aria-hidden="true">${strip
    ? `<rect class="pk-pl" x="2" y="2" width="36" height="2.5"/><rect class="pk-d" x="2" y="4.5" width="36" height="15"/>${tr.replaceAll('Y', '10.5')}<rect class="pk-pl" x="2" y="19.5" width="36" height="2.5"/>`
    : `<rect class="pk-d" x="2" y="11" width="36" height="8.5"/>${tr.replaceAll('Y', '8')}<rect class="pk-pl" x="2" y="19.5" width="36" height="2.5"/>`}</svg>`;
};

const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const trim = (v, d) => String(Number(Number(v).toFixed(d)));

// Monotone cubic (Fritsch-Carlson) through the sweep points: for drawing only.
function monotone(xs, ys) {
  const n = xs.length, d = [], m = [];
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (3 * (h0 + h1)) / ((2 * h1 + h0) / d[i - 1] + (h1 + 2 * h0) / d[i]);
  }
  return (x) => {
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

function niceStep(span, target) {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const kinds = el('div', { class: 'ic-kinds', role: 'radiogroup', 'aria-label': 'Line structure' });
  for (const [k, name, title] of KINDS) {
    const b = el('button', { class: 'ic-kind', role: 'radio', 'data-k': k, title, 'aria-label': title }, `${pict(k)}<span>${name}</span>`);
    b.addEventListener('click', () => chooseKind(k));
    b.addEventListener('keydown', (e) => {
      const i = KINDS.findIndex((x) => x[0] === k);
      const j = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : null;
      if (j == null) return;
      e.preventDefault();
      const nk = KINDS[(j + KINDS.length) % KINDS.length][0];
      chooseKind(nk);
      kinds.querySelector(`[data-k="${nk}"]`).focus();
    });
    kinds.append(b);
  }
  const unitSeg = el('div', { class: 'ic-seg', role: 'group', 'aria-label': 'Length unit' },
    '<button data-u="mm">mm</button><button data-u="mil">mil</button>');
  unitSeg.addEventListener('click', (e) => { const u = e.target.closest('[data-u]')?.dataset.u; if (u) setUnits(u); });
  const badge = el('span', { class: 'ic-badge', hidden: true });
  const tip = el('span', { class: 'ic-tip' }, 'Drag the copper edges, the gap, the dielectric top or the upper plane · arrow keys on a focused handle');
  const head = el('div', { class: 'ic-head' });
  head.append(kinds, unitSeg, badge, tip);

  const xsBox = el('div', { class: 'ic-xs-box' });
  const xs = document.createElementNS(SVGNS, 'svg');
  xs.setAttribute('class', 'ic-xs');
  xs.setAttribute('role', 'group');
  xs.setAttribute('aria-label', 'Cross-section of the line, to scale; its dimensions are draggable');
  xsBox.append(xs);

  const read = el('aside', { class: 'ic-read', 'aria-live': 'polite' });
  const zLab = el('div', { class: 'ic-zlab' });
  const zBig = el('div', { class: 'ic-z' }, '<b>–</b><span>Ω</span>');
  const zDev = el('div', { class: 'ic-dev' });
  const gauge = document.createElementNS(SVGNS, 'svg');
  gauge.setAttribute('class', 'ic-gauge'); gauge.setAttribute('aria-hidden', 'true');
  const tgtRow = el('div', { class: 'ic-target' });
  const tgtIn = el('input', { class: 'ic-in', id: 'ic-target', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Target impedance in ohms' });
  tgtIn.addEventListener('input', () => ctx.set('target', tgtIn.value));
  const chips = el('span', { style: 'display:flex;gap:4px;flex-wrap:wrap' });
  tgtRow.append(el('label', { for: 'ic-target' }, 'Target'), tgtIn, el('span', {}, 'Ω'), chips);
  const solveBtn = el('button', { class: 'ic-solve', hidden: true });
  solveBtn.addEventListener('click', () => { if (solved) ctx.set('w', trim(solved.w, isMil() ? 2 : 4)); });
  const dl = el('dl', { class: 'ic-dl' });
  read.append(zLab, zBig, zDev, gauge, tgtRow, solveBtn, dl);

  const body = el('div', { class: 'ic-body' });
  body.append(xsBox, read);

  // numeric strip: the keyboard/typing path for every input
  const FIELDS = [
    ['w', 'Width W', 'len'], ['s', 'Gap S', 'len'], ['h', 'Dielectric H', 'len'], ['h2', 'Above H2', 'len'],
    ['t', 'Copper T', 'µm'], ['er', 'εr', ''],
  ];
  const strip = el('div', { class: 'ic-strip' });
  const fieldEls = {};
  for (const [key, label, unit] of FIELDS) {
    const f = el('div', { class: key === 't' ? 'ic-f wide2' : 'ic-f' });
    const lab = el('label', { for: `ic-f-${key}` });
    const inp = el('input', { class: 'ic-in', id: `ic-f-${key}`, type: 'text', inputmode: 'decimal', spellcheck: 'false' });
    inp.addEventListener('input', () => ctx.set(key, inp.value));
    const row = el('div', { class: 'ic-row' });
    row.append(inp);
    if (key === 't') {
      for (const [oz, um] of [['½', '17.5'], ['1', '35'], ['2', '70']]) {
        const c = el('button', { class: 'ic-chip', title: `${oz} oz copper = ${um} µm` }, `${oz}oz`);
        c.addEventListener('click', () => ctx.set('t', um));
        row.append(c);
      }
    }
    f.append(lab, row);
    strip.append(f);
    fieldEls[key] = { f, lab, inp, label, unit };
  }

  const stage = el('section', { class: 'ic-card ic-stage' });
  stage.append(head, body, strip);

  const sweep = el('section', { class: 'ic-card ic-sweep' });
  const swTitle = el('h2');
  const swHint = el('span', {}, 'Drag the green target line to solve the width · drag the dot to set W');
  const swHead = el('div', { class: 'ic-sweep-head' });
  swHead.append(swTitle, swHint);
  const swBox = el('div', { class: 'ic-sweep-box' });
  const sw = document.createElementNS(SVGNS, 'svg');
  sw.setAttribute('class', 'ic-sw');
  sw.setAttribute('role', 'group');
  swBox.append(sw);
  const etch = el('div', { class: 'ic-etch' });
  sweep.append(swHead, swBox, etch);

  const side = el('aside', { class: 'ic-side' });
  const warnsEl = el('div', { class: 'ic-warns', role: 'status' });
  const notesEl = el('details', { class: 'ic-notes' });
  side.append(warnsEl, ctx.outputs, notesEl);

  const grid = el('div', { class: 'ic' });
  grid.append(stage, sweep, side);
  root.append(grid);

  // ---------------- state ----------------
  let drag = null;            // active pointer drag
  let xsScale = null;         // px per mm, kept steady while dragging
  let swAxes = null;          // sweep axes, frozen while dragging
  let solved = null;          // {w (units), text}
  let lastG = { w: 0.34, s: 0.2, h: 0.2, h2: 0.2, t: 0.035 };
  let pending = null;

  const isMil = () => ctx.input.units === 'mil';
  const lenStep = () => (isMil() ? 0.1 : 0.001);
  const fmtLen = (v) => trim(v, isMil() ? 1 : 3);
  const unitName = () => (isMil() ? 'mil' : 'mm');

  function setSoon(obj) { // one run per frame while dragging
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  }

  function chooseKind(k) {
    const wasDiff = String(ctx.input.kind).startsWith('diff'), nowDiff = k.startsWith('diff');
    const tg = ctx.input.target, upd = { kind: k };
    if (!wasDiff && nowDiff && tg === 50) upd.target = '100';
    if (wasDiff && !nowDiff && [85, 90, 100].includes(tg)) upd.target = '50';
    xsScale = null;
    ctx.setMany(upd);
  }

  function setUnits(u) {
    const cur = ctx.input.units === 'mil' ? 'mil' : 'mm';
    if (u === cur) return;
    const f = u === 'mil' ? 1 / MIL : MIL, upd = { units: u }, inp = ctx.input;
    for (const k of ['w', 's', 'h', 'h2']) if (inp[k] > 0) upd[k] = String(Number((inp[k] * f).toPrecision(u === 'mil' ? 3 : 3)));
    ctx.setMany(upd);
  }

  // ---------------- result reading ----------------
  function readRes(res) {
    const vals = res?.values || [];
    const by = (re) => vals.find((v) => re.test(v.label));
    const main = vals[0] && /impedance/i.test(vals[0].label) ? vals[0] : null;
    const wv = by(/^Width for/);
    const chart = res?.charts?.[0];
    const rows = res?.tables?.[0]?.rows || [];
    return {
      main, one: by(/^Single-ended/), eeff: by(/^Effective/), delay: by(/^Propagation/),
      L: by(/^Inductance/), C: by(/^Capacitance/), wv,
      solvedW: wv ? parseFloat(wv.value) : null,
      chart, rows: rows.map((r) => ({ w: parseFloat(r[0]), change: r[1], z: parseFloat(r[2]) })),
    };
  }

  // Which part of the drawing a warning is about.
  function warnParts(ws) {
    const p = new Set();
    for (const w of ws) {
      if (/W\/H|W\/b|Very narrow/.test(w)) p.add('trace');
      if (/Copper/.test(w)) p.add('t');
      if (/S\/H|S\/b|pair formula/.test(w)) p.add('gap');
      if (/^Er =/.test(w)) p.add('er');
      if (/No H2/.test(w)) p.add('h2');
      if (/No trace width reaches/.test(w)) p.add('target');
    }
    return p;
  }

  // ---------------- cross-section ----------------
  function geometry(inp) {
    const k = inp.units === 'mil' ? MIL : 1;
    const kind = inp.kind || 'microstrip';
    const diff = kind.startsWith('diff'), strip = kind.includes('stripline');
    const L = (v, fb) => (v > 0 ? v * k : fb);
    const g = {
      w: L(inp.w, lastG.w), s: L(inp.s, lastG.s), h: L(inp.h, lastG.h),
      h2: inp.h2 > 0 ? inp.h2 * k : (inp.h > 0 ? inp.h * k : lastG.h2), t: inp.t > 0 ? inp.t / 1000 : 0,
    };
    lastG = { ...g, t: g.t || lastG.t };
    return { g, diff, strip, kind };
  }

  function drawXS() {
    const inp = ctx.input, res = ctx.result || {};
    const R = readRes(res);
    const Wp = Math.max(280, xsBox.clientWidth), Hp = Math.max(220, xsBox.clientHeight);
    const { g, diff, strip } = geometry(inp);
    const parts = warnParts(res.warnings || []);
    const X = diff ? 2 * g.w + g.s : g.w;
    const V = strip ? g.h + g.t + g.h2 : g.h + g.t;
    // to scale: one px/mm for both axes
    const narrow = Wp < 520;
    const leftM = narrow ? 22 : Math.max(150, Wp * 0.3), rightM = narrow ? 116 : Math.max(150, Wp * 0.3);
    const availX = Wp - leftM - rightM;
    const ideal = Math.min(availX / X, (Hp - (strip ? 80 : 120)) / V * (strip ? 1 : 0.8));
    const fits = (s) => X * s <= availX + 1 && V * s <= Hp - (strip ? 70 : 100);
    if (!drag) {
      if (!xsScale || !fits(xsScale) || xsScale / ideal > 2.4 || ideal / xsScale > 1.6) xsScale = ideal;
    }
    const sc = xsScale;
    if (narrow && !drag) { // phone: the box takes the height the to-scale stack needs
      const want = Math.round(clamp((V * (availX / X)) / (strip ? 1 : 0.8) + (strip ? 80 : 150), 190, 320));
      if (Math.abs(want - Hp) > 4) { xsBox.style.height = `${want}px`; }
    } else if (xsBox.style.height) xsBox.style.height = '';
    const cx = Math.round(narrow ? leftM + availX / 2 : (Wp - 70) / 2);
    const Tpx = Math.max(1.5, g.t * sc);
    const planePx = clamp(g.t * sc, 3, 18);
    const stackPx = V * sc;
    const yP = Math.round(strip ? clamp((Hp + stackPx) / 2, 0, Hp - planePx - 24) : clamp((Hp + stackPx) / 2 + 18, 0, Hp - planePx - 26));
    const yB = yP - g.h * sc;          // trace bottom
    const yT = yB - Tpx;               // trace top
    const yTop = strip ? yT - g.h2 * sc : null; // upper plane's lower face
    const wpx = g.w * sc, spx = g.s * sc;
    const traces = diff
      ? [[cx - spx / 2 - wpx, cx - spx / 2], [cx + spx / 2, cx + spx / 2 + wpx]]
      : [[cx - wpx / 2, cx + wpx / 2]];
    const xL = traces[0][0], xR = traces[traces.length - 1][1];
    const maskPx = strip ? 0 : clamp(0.02 * sc, 2, 10);
    const out = [];
    const u = unitName();
    const raw = ctx.raw;

    // dielectric
    if (strip) {
      out.push(`<rect class="diel" x="-2" y="${yTop}" width="${Wp + 4}" height="${yP - yTop}"/>`);
      out.push(`<line class="ply" x1="0" x2="${Wp}" y1="${yB}" y2="${yB}"/>`);
    } else {
      out.push(`<rect class="diel" x="-2" y="${yB}" width="${Wp + 4}" height="${yP - yB}"/>`);
    }
    // field lines (behind copper): odd mode for pairs, weighted by coupling from the result
    const coupling = diff && R.main && R.one ? clamp(1 - parseFloat(R.main.value) / (2 * parseFloat(R.one.value)), 0, 0.6) : 0;
    const fl = [];
    const hPx = g.h * sc, h2Px = strip ? g.h2 * sc : 0;
    const ym = yB - Tpx / 2;
    traces.forEach(([a, b], i) => {
      const n = clamp(Math.round((b - a) / 16), 2, 9);
      for (let j = 0; j < n; j++) {
        const x = a + ((j + 0.5) * (b - a)) / n;
        fl.push(`M${x} ${yB}V${yP}`);
        if (strip) fl.push(`M${x} ${yT}V${yTop}`);
      }
      const outer = diff ? [i === 0 ? -1 : 1] : [-1, 1];
      for (const dir of outer) {
        const xe = dir < 0 ? a : b;
        for (let j = 1; j <= 4; j++) {
          const d = j * hPx * 0.55 + 3;
          fl.push(`M${xe} ${ym}Q${xe + dir * d * 0.85} ${ym - (strip ? 0 : j * hPx * 0.12)} ${xe + dir * d} ${yP}`);
          if (strip) { const d2 = j * h2Px * 0.55 + 3; fl.push(`M${xe} ${ym}Q${xe + dir * d2 * 0.85} ${ym} ${xe + dir * d2} ${yTop}`); }
        }
      }
    });
    out.push(`<path class="fl" style="opacity:.28" d="${fl.join('')}"/>`);
    if (diff) {
      const [, a1] = traces[0], [b0] = traces[1], mid = (a1 + b0) / 2, gp = b0 - a1;
      const cf = [];
      for (let j = 0; j < 3; j++) {
        const yy = yT + (Tpx * (j + 0.5)) / 3;
        cf.push(`M${a1} ${yy}H${b0}`);
      }
      for (let j = 1; j <= 3; j++) {
        const up = Math.min(gp * 0.25 * j + 2, 6 + j * 6);
        cf.push(`M${a1} ${yT + 1}Q${mid} ${yT - up} ${b0} ${yT + 1}`);
        cf.push(`M${a1} ${yB - 1}Q${mid} ${yB + Math.min(up, hPx * 0.8)} ${b0} ${yB - 1}`);
      }
      out.push(`<path class="fl" style="opacity:${clamp(0.2 + coupling * 1.6, 0.2, 0.7).toFixed(2)};stroke-width:${(1 + coupling * 2).toFixed(2)}" d="${cf.join('')}"/>`);
    }
    // planes
    out.push(`<rect class="plane" x="-2" y="${yP}" width="${Wp + 4}" height="${planePx}"/>`);
    if (strip) out.push(`<rect class="plane" x="-2" y="${yTop - planePx}" width="${Wp + 4}" height="${planePx}"/>`);
    // solder mask (not in the model): drawn so the stack looks like the board
    if (!strip) {
      let d = `M-2 ${yB - maskPx}`;
      for (const [a, b] of traces) d += `H${a - maskPx}V${yT - maskPx}H${b + maskPx}V${yB - maskPx}`;
      d += `H${Wp + 2}V${yB}`;
      for (const [a, b] of [...traces].reverse()) d += `H${b}V${yT}H${a}V${yB}`;
      d += 'H-2Z';
      out.push(`<path class="mask" d="${d}"/>`);
    }
    // solved-width ghost
    if (R.solvedW > 0 && Math.abs(R.solvedW - inp.w) / inp.w > 0.004) {
      const ws = R.solvedW * (isMil() ? MIL : 1) * sc;
      const gt = diff ? [[cx - spx / 2 - ws, cx - spx / 2], [cx + spx / 2, cx + spx / 2 + ws]] : [[cx - ws / 2, cx + ws / 2]];
      for (const [a, b] of gt) out.push(`<rect class="ghost" x="${a}" y="${yT - 3}" width="${b - a}" height="${Tpx + 6}"/>`);
    }
    // copper
    const cuW = parts.has('trace') || parts.has('t') ? ' w' : '';
    for (const [a, b] of traces) out.push(`<rect class="cu${cuW}" x="${a}" y="${yT}" width="${Math.max(1, b - a)}" height="${Tpx}"/>`);
    if (diff && Tpx >= 11 && wpx >= 14) {
      traces.forEach(([a, b], i) => out.push(`<text class="pol" x="${(a + b) / 2}" y="${ym + 4}" text-anchor="middle">${i ? '−' : '+'}</text>`));
    }

    // ---- dimensions ----
    const dimsAbove = strip ? (yT - yTop >= 34) : true;
    const dimsBelow = strip && !dimsAbove && yP - yB >= 34;
    const yDim = dimsAbove ? yT - maskPx - 16 : dimsBelow ? yB + 18 : yTop - planePx - 14;
    const hDim = (x0, x1, y, label, cls = '') => {
      const tw = label.length * 6.9 + 6, fitsIn = x1 - x0 > tw + 8;
      const ty = dimsBelow ? y + 15 : y - 5;
      out.push(`<path class="dim" d="M${x0} ${y}H${x1}M${x0} ${y - 4}V${y + 4}M${x1} ${y - 4}V${y + 4}"/>`);
      out.push(`<text class="dimt halo ${cls}" x="${fitsIn ? (x0 + x1) / 2 : x1 + 6}" y="${fitsIn ? ty : y + 4}" text-anchor="${fitsIn ? 'middle' : 'start'}">${esc(label)}</text>`);
    };
    const yExt0 = dimsBelow ? yB : yT - maskPx;
    for (const [a, b] of traces) out.push(`<path class="ext" d="M${a} ${yExt0}V${yDim}M${b} ${yExt0}V${yDim}"/>`);
    const trW = traces[traces.length - 1];
    hDim(trW[0], trW[1], yDim, `W ${raw.w} ${u}`);
    if (diff) {
      const [, a1] = traces[0], [b0] = traces[1];
      const lbl = `S ${raw.s}`, tw = lbl.length * 6.9;
      if (b0 - a1 > tw + 10) hDim(a1, b0, yDim, lbl);
      else {
        out.push(`<path class="dim" d="M${a1} ${yDim}H${b0}M${a1} ${yDim - 4}V${yDim + 4}M${b0} ${yDim - 4}V${yDim + 4}"/>`);
        out.push(`<text class="dimt halo" x="${a1 - 6}" y="${yDim + 4}" text-anchor="end">${esc(lbl)}</text>`);
      }
    }
    // vertical dims on the right
    const xV = xR + (strip ? 34 : 34) + maskPx;
    const vDim = (y0, y1, label, ly) => {
      out.push(`<path class="dim" d="M${xV} ${y0}V${y1}M${xV - 4} ${y0}H${xV + 4}M${xV - 4} ${y1}H${xV + 4}"/>`);
      out.push(`<text class="dimt halo-d" x="${xV + 8}" y="${ly + 4}">${esc(label)}</text>`);
    };
    out.push(`<path class="ext" d="M${xR} ${yB}H${xV + 5}M${xR} ${yT}H${xV + 5}"/>`);
    let yH = (yB + yP) / 2, yTl = ym, yH2 = strip ? (yTop + yT) / 2 : null;
    if (yH - yTl < 15) yH = yTl + 15;
    if (strip && yTl - yH2 < 15) yH2 = yTl - 15;
    vDim(yB, yP, `${strip ? 'H1' : 'H'} ${raw.h} ${u}`, yH);
    if (strip) vDim(yTop, yT, `H2 ${String(raw.h2 ?? '').trim() || raw.h} ${u}`, yH2);
    out.push(`<text class="dimt ${strip ? 'halo-d' : 'halo'}" x="${xV + 8}" y="${yTl + 4}" style="${parts.has('t') ? 'fill:var(--warn)' : ''}">T ${esc(raw.t)} µm</text>`);

    // labels
    out.push(`<text class="lbl" x="${Wp - 10}" y="${yP + planePx + 14}" text-anchor="end">reference plane</text>`);
    if (strip) out.push(`<text class="lbl" x="${Wp - 10}" y="${yTop - planePx - 6}" text-anchor="end">reference plane</text>`);
    if (!strip) out.push(`<text class="lbl" x="10" y="${xL > 210 ? yB - maskPx - 8 : yP + planePx + 14}" style="fill:var(--tool-mask)">solder mask · not in the model</text>`);
    else if (Math.abs(g.h - g.h2) > 1e-9) out.push(`<text class="lbl" x="10" y="${yB - 6}" style="fill:var(--tool-diel-ink)">offset: H1 ≠ H2</text>`);

    // scale bar: shows the drawing is to scale
    const kU = isMil() ? MIL : 1, sbL = niceStep(100 / (sc * kU), 1), sbPx = sbL * kU * sc;
    const sbLabel = isMil() ? `${trim(sbL, 3)} mil` : sbL >= 0.1 ? `${trim(sbL, 3)} mm` : `${trim(sbL * 1000, 1)} µm`;
    out.push(`<path class="scale" d="M12 ${14}H${12 + sbPx}M12 10V18M${12 + sbPx} 10V18"/><text x="${18 + sbPx}" y="18">${sbLabel}${narrow ? '' : ' · to scale'}</text>`);

    // ---- handles (on top) ----
    const H = (key, cls, label, now, inner, extra = '') =>
      `<g class="ic-h ${cls}" data-h="${key}" tabindex="0" role="slider" aria-label="${esc(label)}" aria-valuenow="${esc(now)}" aria-valuetext="${esc(`${label} ${now}`)}" ${extra}>${inner}</g>`;
    // H (dielectric top / H1): the whole surface is the grip, a pill marks it
    const gwid = narrow ? 24 : 44, gx = Math.max(6, Math.min(xL - gwid - 14, 60));
    out.push(H('h', 'ns', strip ? 'Dielectric below the trace H1' : 'Dielectric height H', raw.h,
      `<rect class="hit" x="0" y="${yB - 6}" width="${Wp}" height="12"/><rect class="ring" x="${gx - 4}" y="${yB - 8}" width="${gwid + 8}" height="16" rx="3"/><rect class="grip" x="${gx}" y="${yB - 2.5}" width="${gwid}" height="5" rx="2.5"/>`));
    if (strip) {
      out.push(H('h2', 'ns', 'Dielectric above the trace H2', raw.h2,
        `<rect class="hit" x="0" y="${yTop - 6}" width="${Wp}" height="12"/><rect class="ring" x="${gx - 4}" y="${yTop - 8}" width="${gwid + 8}" height="16" rx="3"/><rect class="grip" x="${gx}" y="${yTop - 2.5}" width="${gwid}" height="5" rx="2.5"/>`));
    }
    // T: the copper's top face
    out.push(H('t', 'ns', 'Copper thickness T in µm', raw.t,
      `<rect class="hit" x="${trW[0] + 4}" y="${yT - 4}" width="${Math.max(6, trW[1] - trW[0] - 8)}" height="8"/><rect class="ring" x="${trW[0] - 2}" y="${yT - 5}" width="${trW[1] - trW[0] + 4}" height="10" rx="2"/><rect class="grip" x="${(trW[0] + trW[1]) / 2 - 8}" y="${yT - 1.5}" width="16" height="3" rx="1.5" style="opacity:.35"/>`));
    // W: outer copper edges; S: inner edges of a pair
    const edge = (key, x, dir, label, now) => {
      const gh = Math.max(14, Tpx + 10);
      return H(key, 'ew', label, now,
        `<rect class="hit" x="${x - 7}" y="${ym - gh / 2 - 4}" width="14" height="${gh + 8}"/><rect class="ring" x="${x - 6}" y="${ym - gh / 2 - 3}" width="12" height="${gh + 6}" rx="3"/><rect class="grip" x="${x - 1.5}" y="${ym - gh / 2}" width="3" height="${gh}" rx="1.5"/>`,
        `data-dir="${dir}"`);
    };
    out.push(edge('w', xL, -1, 'Trace width W', raw.w));
    out.push(edge('w', xR, 1, 'Trace width W', raw.w));
    if (diff) {
      out.push(edge('s', traces[0][1], -1, 'Gap S between the pair', raw.s));
      out.push(edge('s', traces[1][0], 1, 'Gap S between the pair', raw.s));
    }
    // εr: scrub sideways
    const erY = strip ? (yP - yB >= 30 ? (yB + yP) / 2 : clamp((yTop + yT) / 2, yTop + 14, yT - 12)) : (yP - yB >= 22 && xL > 110 ? (yB + yP) / 2 : yP + planePx + 36);
    const erTxt = `εr ${raw.er}`;
    const erW = erTxt.length * 7.2 + 26;
    const erX = 10;
    const erTop = strip && Math.abs(erY - yB) < 14 ? erY + 14 : erY;
    out.push(H('er', 'ew', 'Dielectric constant εr', raw.er,
      `<rect class="erbox" x="${erX}" y="${erTop - 11}" width="${erW}" height="20" rx="3" style="${parts.has('er') ? 'stroke:var(--warn)' : ''}"/><rect class="ring" x="${erX - 3}" y="${erTop - 14}" width="${erW + 6}" height="26" rx="4"/><text class="ert" x="${erX + 7}" y="${erTop + 3.5}">${esc(erTxt)}</text><text x="${erX + erW - 15}" y="${erTop + 3.5}">↔</text>`));

    // warning marks where the problem is
    const mark = (x, y, text) => out.push(`<g class="wmark"><title>${esc(text)}</title><circle cx="${x}" cy="${y}" r="7.5"/><text x="${x}" y="${y + 4}" text-anchor="middle">!</text></g>`);
    const ws = res.warnings || [];
    const wt = (re) => ws.filter((w) => re.test(w)).join(' ');
    if (parts.has('trace')) mark(xL - 14, yT - 10, wt(/W\/H|W\/b|Very narrow/));
    if (parts.has('gap')) mark(cx, yB + 14, wt(/S\/H|S\/b|pair formula/));
    if (parts.has('t')) mark(xR + 14, yT - 10, wt(/Copper/));
    if (parts.has('er')) mark(erX + erW + 12, erTop, wt(/^Er =/));

    // keep keyboard focus on the same handle across redraws
    const act = document.activeElement;
    const fkey = act && xs.contains(act) ? { h: act.dataset.h, dir: act.dataset.dir } : null;
    xs.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    xs.innerHTML = out.join('');
    if (drag?.svg === xs) {
      const q = drag.dir ? `[data-h="${drag.h}"][data-dir="${drag.dir}"]` : `[data-h="${drag.h}"]`;
      xs.querySelector(q)?.classList.add('on');
    }
    if (fkey) (xs.querySelector(fkey.dir ? `[data-h="${fkey.h}"][data-dir="${fkey.dir}"]` : `[data-h="${fkey.h}"]`))?.focus({ preventScroll: true });
    geo = { sc, g };
  }
  let geo = { sc: 1, g: lastG };

  // drag on the cross-section
  function startXS(e) {
    const hEl = e.target.closest('[data-h]');
    if (!hEl || e.button > 0) return;
    e.preventDefault();
    const inp = ctx.input;
    drag = { svg: xs, h: hEl.dataset.h, dir: Number(hEl.dataset.dir) || 0, x0: e.clientX, y0: e.clientY, inp, sc: geo.sc,
      ratio: xs.viewBox.baseVal.width / xs.getBoundingClientRect().width };
    xs.setPointerCapture(e.pointerId);
    hEl.focus({ preventScroll: true });
    hEl.classList.add('on');
  }
  function moveXS(e) {
    if (!drag || drag.svg !== xs) return;
    const dx = (e.clientX - drag.x0) * drag.ratio, dy = (e.clientY - drag.y0) * drag.ratio;
    const k = isMil() ? MIL : 1, per = 1 / (drag.sc * k); // units per px
    const i = drag.inp, st = lenStep(), minL = isMil() ? 0.2 : 0.005;
    const q = (v) => fmtLen(Math.max(minL, Math.round(v / st) * st));
    switch (drag.h) {
      case 'w': setSoon({ w: q(i.w + 2 * dx * drag.dir * per) }); break;
      case 's': setSoon({ s: q(i.s + 2 * dx * drag.dir * per) }); break;
      case 'h': setSoon({ h: q(i.h - dy * per) }); break;
      case 'h2': setSoon({ h2: q((i.h2 > 0 ? i.h2 : i.h) - dy * per) }); break;
      case 't': setSoon({ t: trim(clamp(Math.round(((i.t || 0) - (dy / drag.sc) * 1000) * 2) / 2, 1, 210), 1) }); break;
      case 'er': setSoon({ er: trim(clamp(Math.round(((i.er || 4) + dx * 0.01) * 100) / 100, 1, 16), 2) }); break;
    }
  }
  function endDrag() {
    if (!drag) return;
    drag = null;
    if (grid.contains(document.activeElement) && document.activeElement.dataset?.h) document.activeElement.blur();
    requestAnimationFrame(() => { drawXS(); drawSweep(); });
  }
  xs.addEventListener('pointerdown', startXS);
  xs.addEventListener('pointermove', moveXS);
  xs.addEventListener('pointerup', endDrag);
  xs.addEventListener('pointercancel', endDrag);

  function keyStep(key, dir, big) {
    const i = ctx.input, st = isMil() ? 0.2 : 0.005, m = big ? 10 : 1, minL = isMil() ? 0.2 : 0.005;
    const L = (v) => fmtLen(Math.max(minL, Math.round((v + dir * st * m) / lenStep()) * lenStep()));
    switch (key) {
      case 'w': ctx.set('w', L(i.w)); break;
      case 's': ctx.set('s', L(i.s)); break;
      case 'h': ctx.set('h', L(i.h)); break;
      case 'h2': ctx.set('h2', L(i.h2 > 0 ? i.h2 : i.h)); break;
      case 't': ctx.set('t', trim(clamp((i.t || 0) + dir * m * 0.5, 1, 210), 1)); break;
      case 'er': ctx.set('er', trim(clamp((i.er || 4) + dir * m * 0.05, 1, 16), 2)); break;
      case 'target': ctx.set('target', trim(Math.max(1, (i.target || 50) + dir * m * 0.5), 1)); break;
      case 'pt': ctx.set('w', L(i.w)); break;
    }
  }
  const onKey = (e) => {
    const hEl = e.target.closest?.('[data-h]');
    if (!hEl) return;
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 1, PageDown: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    let d = dir;
    // the left W edge and the inner edge of the left trace move the other way
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (hEl.dataset.h === 'w' && hEl.dataset.dir === '-1') d = -dir;
      if (hEl.dataset.h === 's') d = hEl.dataset.dir === '-1' ? -dir : dir;
    }
    keyStep(hEl.dataset.h, d, e.shiftKey || e.key.startsWith('Page'));
  };
  xs.addEventListener('keydown', onKey);
  sw.addEventListener('keydown', onKey);

  // ---------------- width sweep ----------------
  function drawSweep() {
    const res = ctx.result || {}, inp = ctx.input;
    const R = readRes(res);
    const diff = String(inp.kind).startsWith('diff');
    swTitle.textContent = `${diff ? 'Zdiff' : 'Z0'} against trace width`;
    const Wp = Math.max(260, swBox.clientWidth), Hp = Math.max(160, swBox.clientHeight);
    const act = document.activeElement;
    const fkey = act && sw.contains(act) ? act.dataset.h : null;
    sw.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    const c = R.chart;
    if (!c || !c.x?.length) { sw.innerHTML = `<text x="${Wp / 2}" y="${Hp / 2}" text-anchor="middle">No sweep for these inputs</text>`; etch.textContent = ''; return; }
    const xs0 = c.x, ys0 = c.series[0].y;
    const tg = inp.target > 0 ? inp.target : null;
    const m = { l: 46, r: 18, t: 14, b: 30 };
    if (!drag || drag.svg !== sw || !swAxes) {
      let y0 = Math.min(...ys0), y1 = Math.max(...ys0);
      if (tg) { y0 = Math.min(y0, tg * 0.9); y1 = Math.max(y1, tg * 1.1); }
      const pad = (y1 - y0) * 0.06;
      swAxes = { x0: xs0[0], x1: xs0[xs0.length - 1], y0: y0 - pad, y1: y1 + pad };
    }
    const A = swAxes;
    const px = (x) => m.l + ((x - A.x0) / (A.x1 - A.x0)) * (Wp - m.l - m.r);
    const py = (y) => m.t + (1 - (y - A.y0) / (A.y1 - A.y0)) * (Hp - m.t - m.b);
    const f = monotone(xs0, ys0);
    const o = [];
    o.push(`<defs><clipPath id="ic-clip"><rect x="${m.l}" y="${m.t}" width="${Wp - m.l - m.r}" height="${Hp - m.t - m.b}"/></clipPath></defs>`);
    // grid + ticks
    const ys = niceStep(A.y1 - A.y0, 5), xsS = niceStep(A.x1 - A.x0, Wp > 500 ? 8 : 4);
    for (let y = Math.ceil(A.y0 / ys) * ys; y <= A.y1; y += ys) {
      o.push(`<line class="grid" x1="${m.l}" x2="${Wp - m.r}" y1="${py(y)}" y2="${py(y)}"/><text x="${m.l - 6}" y="${py(y) + 3.5}" text-anchor="end">${trim(y, 1)}</text>`);
    }
    for (let x = Math.ceil(A.x0 / xsS) * xsS; x <= A.x1 + 1e-9; x += xsS) {
      o.push(`<line class="grid" y1="${m.t}" y2="${Hp - m.b}" x1="${px(x)}" x2="${px(x)}"/><text x="${px(x)}" y="${Hp - m.b + 14}" text-anchor="middle">${trim(x, 4)}</text>`);
    }
    o.push(`<line class="axis" x1="${m.l}" x2="${Wp - m.r}" y1="${Hp - m.b}" y2="${Hp - m.b}"/><line class="axis" x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${Hp - m.b}"/>`);
    o.push(`<text x="${Wp - m.r}" y="${Hp - 4}" text-anchor="end">W (${esc(unitName())})</text><text x="6" y="${m.t + 4}">Ω</text>`);
    const g = [];
    // target band ±5 % / ±10 %
    if (tg) {
      o.push(`<g clip-path="url(#ic-clip)"><rect class="band-w" x="${m.l}" width="${Wp - m.l - m.r}" y="${py(tg * 1.1)}" height="${py(tg * 0.9) - py(tg * 1.1)}"/>`
        + `<rect class="band-ok" x="${m.l}" width="${Wp - m.l - m.r}" y="${py(tg * 1.05)}" height="${py(tg * 0.95) - py(tg * 1.05)}"/></g>`);
    }
    // etch tolerance: span of widths and the impedance they give
    const rows = R.rows.filter((r) => Number.isFinite(r.w) && Number.isFinite(r.z));
    if (rows.length >= 3) {
      const lo = rows[0], hi = rows[rows.length - 1];
      o.push(`<rect class="tolspan" x="${px(lo.w)}" width="${Math.max(1, px(hi.w) - px(lo.w))}" y="${m.t}" height="${Hp - m.t - m.b}"/>`);
      const pts = []; for (let k = 0; k <= 16; k++) { const x = lo.w + ((hi.w - lo.w) * k) / 16; pts.push(`${px(x)},${py(f(x))}`); }
      o.push(`<polyline class="tolseg" points="${pts.join(' ')}"/>`);
      const zmin = Math.min(lo.z, hi.z), zmax = Math.max(lo.z, hi.z);
      o.push(`<path class="tolbr" d="M${m.l + 3} ${py(zmax)}V${py(zmin)}M${m.l} ${py(zmax)}H${m.l + 8}M${m.l} ${py(zmin)}H${m.l + 8}"/>`);
      const r12 = rows.filter((r) => /12\.5/.test(r.change));
      etch.textContent = `Etch ±25 µm: ${trim(zmin, 4)} – ${trim(zmax, 4)} Ω`
        + (r12.length === 2 ? `   ·   ±12.5 µm: ${trim(Math.min(r12[0].z, r12[1].z), 4)} – ${trim(Math.max(r12[0].z, r12[1].z), 4)} Ω` : '')
        + '   (orange band)';
    } else etch.textContent = '';
    // the curve
    const cp = []; const N = 140;
    for (let k = 0; k <= N; k++) { const x = A.x0 + ((A.x1 - A.x0) * k) / N; cp.push(`${px(x).toFixed(1)},${py(f(x)).toFixed(1)}`); }
    o.push(`<polyline class="curve" clip-path="url(#ic-clip)" points="${cp.join(' ')}"/>`);
    // current point: the result's nominal sample (the width itself)
    const nx = xs0[5], ny = ys0[5]; // run() samples 0.5..2 x W; index 5 is W itself
    // solved width where the target crosses the curve
    let tgLine = '';
    if (tg) {
      const yT = py(tg);
      const tagTxt = `target ${trim(tg, 4)} Ω`, tw = tagTxt.length * 6.8 + 22;
      const tx = Wp - m.r - tw - 4;
      if (R.solvedW > 0) {
        const sx = px(R.solvedW);
        if (sx >= m.l && sx <= Wp - m.r) {
          o.push(`<path class="sline" d="M${sx} ${yT}V${Hp - m.b}"/><circle class="sdot" cx="${sx}" cy="${yT}" r="4.5"/>`);
          o.push(`<text x="${sx + 5}" y="${Hp - m.b - 5}" style="fill:var(--ok)">${esc(R.wv.value)}</text>`);
        } else {
          const edgeX = sx < m.l ? m.l + 4 : Wp - m.r - 4;
          o.push(`<text x="${edgeX}" y="${yT + 16}" text-anchor="${sx < m.l ? 'start' : 'end'}" style="fill:var(--ok)">${sx < m.l ? '◀ ' : ''}${esc(R.wv.value)}${sx < m.l ? '' : ' ▶'}</text>`);
        }
      }
      tgLine = `<g class="ic-h ns" data-h="target" tabindex="0" role="slider" aria-label="Target impedance, ohms" aria-valuenow="${tg}">`
        + `<rect class="hit" x="${m.l}" y="${yT - 7}" width="${Wp - m.l - m.r}" height="14"/>`
        + `<line class="tline" x1="${m.l}" x2="${Wp - m.r}" y1="${yT}" y2="${yT}"/>`
        + `<rect class="ring" x="${tx - 3}" y="${yT - 12}" width="${tw + 6}" height="24" rx="4"/>`
        + `<rect class="tag" x="${tx}" y="${yT - 9}" width="${tw}" height="18" rx="3"/>`
        + `<text class="tagt" x="${tx + 7}" y="${yT + 4}">${esc(tagTxt)}</text><text x="${tx + tw - 13}" y="${yT + 4}">↕</text></g>`;
    }
    const pxN = px(nx), pyN = py(ny);
    o.push(`<path class="sline" style="stroke:var(--tool-s0)" d="M${pxN} ${pyN}V${Hp - m.b}M${m.l} ${pyN}H${pxN}"/>`);
    o.push(tgLine);
    const labR = pxN < Wp - 170;
    o.push(`<g class="ic-h ew" data-h="pt" tabindex="0" role="slider" aria-label="Trace width W on the curve" aria-valuenow="${inp.w}">`
      + `<circle class="hit" cx="${pxN}" cy="${pyN}" r="13"/><circle class="ring" cx="${pxN}" cy="${pyN}" r="10"/><circle class="pt" cx="${pxN}" cy="${pyN}" r="6"/>`
      + `<text class="ptag halo" x="${pxN + (labR ? 11 : -11)}" y="${pyN - 9}" text-anchor="${labR ? 'start' : 'end'}">${esc(`${trim(ny, 4)} Ω @ ${ctx.raw.w} ${unitName()}`)}</text></g>`);
    sw.innerHTML = o.join('');
    if (drag?.svg === sw) sw.querySelector(`[data-h="${drag.h}"]`)?.classList.add('on');
    if (fkey) sw.querySelector(`[data-h="${fkey}"]`)?.focus({ preventScroll: true });
    swGeo = { px, py, Wp, Hp, m };
  }
  let swGeo = null;
  sw.addEventListener('pointerdown', (e) => {
    const hEl = e.target.closest('[data-h]');
    if (!hEl || e.button > 0 || !swGeo) return;
    e.preventDefault();
    drag = { svg: sw, h: hEl.dataset.h, ratio: sw.viewBox.baseVal.width / sw.getBoundingClientRect().width, rect: sw.getBoundingClientRect() };
    sw.setPointerCapture(e.pointerId);
    hEl.focus({ preventScroll: true });
    hEl.classList.add('on');
  });
  sw.addEventListener('pointermove', (e) => {
    if (!drag || drag.svg !== sw) return;
    const A = swAxes, { m, Wp, Hp } = swGeo;
    const x = (e.clientX - drag.rect.left) * drag.ratio, y = (e.clientY - drag.rect.top) * drag.ratio;
    if (drag.h === 'target') {
      const v = A.y0 + (1 - (clamp(y, m.t, Hp - m.b) - m.t) / (Hp - m.t - m.b)) * (A.y1 - A.y0);
      setSoon({ target: trim(Math.max(1, Math.round(v * 2) / 2), 1) });
    } else if (drag.h === 'pt') {
      const v = A.x0 + ((clamp(x, m.l, Wp - m.r) - m.l) / (Wp - m.l - m.r)) * (A.x1 - A.x0);
      setSoon({ w: fmtLen(Math.max(isMil() ? 0.2 : 0.005, Math.round(v / lenStep()) * lenStep())) });
    }
  });
  sw.addEventListener('pointerup', endDrag);
  sw.addEventListener('pointercancel', endDrag);

  // ---------------- readout ----------------
  function drawRead() {
    const res = ctx.result || {}, inp = ctx.input, raw = ctx.raw;
    const R = readRes(res);
    const diff = String(inp.kind).startsWith('diff');
    zLab.textContent = diff ? 'Differential impedance · Zdiff' : 'Characteristic impedance · Z0';
    const z = R.main ? parseFloat(R.main.value) : null;
    zBig.className = `ic-z${R.main?.tone ? ` t-${R.main.tone}` : ''}`;
    zBig.querySelector('b').textContent = R.main ? R.main.value : '–';
    const tg = inp.target > 0 ? inp.target : null;
    zDev.textContent = z != null && tg ? `${z >= tg ? '+' : '−'}${trim(Math.abs(z - tg), 3)} Ω from ${trim(tg, 4)} Ω` + (R.main.tone === 'ok' ? '  · within 5 %' : R.main.tone === 'warn' ? '  · within 10 %' : '') : '';
    // gauge: target ±30 %, shaded ±10 % and ±5 %
    const gw = Math.max(160, gauge.clientWidth || 240), gh = 44;
    gauge.setAttribute('viewBox', `0 0 ${gw} ${gh}`);
    if (tg && z != null) {
      const lo = tg * 0.7, hi = tg * 1.3, X = (v) => 4 + ((clamp(v, lo, hi) - lo) / (hi - lo)) * (gw - 8);
      const mx = X(z), off = z < lo || z > hi;
      gauge.innerHTML = `<rect class="g-bg" x="4" y="14" width="${gw - 8}" height="12" rx="2"/>`
        + `<rect class="g-w" x="${X(tg * 0.9)}" y="14" width="${X(tg * 1.1) - X(tg * 0.9)}" height="12"/>`
        + `<rect class="g-ok" x="${X(tg * 0.95)}" y="14" width="${X(tg * 1.05) - X(tg * 0.95)}" height="12"/>`
        + `<line class="g-t" x1="${X(tg)}" x2="${X(tg)}" y1="11" y2="29"/>`
        + `<path class="g-m" d="M${mx - 5} 4L${mx + 5} 4L${mx} 12Z"/>`
        + `<text x="4" y="41">${z < lo ? '◀ ' : ''}−30 %</text><text x="${X(tg * 0.95)}" y="41" text-anchor="middle">±5 %</text><text x="${gw - 4}" y="41" text-anchor="end">+30 %${z > hi ? ' ▶' : ''}</text>`;
    } else gauge.innerHTML = tg ? '' : `<text x="4" y="26">Set a target to see the band</text>`;
    if (document.activeElement !== tgtIn) tgtIn.value = raw.target ?? '';
    const presets = diff ? ['85', '90', '100'] : ['50', '55', '75'];
    chips.replaceChildren(...presets.map((p) => {
      const b = el('button', { class: 'ic-chip', 'aria-pressed': String(Number(p) === tg) }, p);
      b.addEventListener('click', () => ctx.set('target', p));
      return b;
    }));
    solved = R.solvedW > 0 ? { w: R.solvedW } : null;
    const needs = solved && Math.abs(solved.w - inp.w) / inp.w > 0.004;
    solveBtn.hidden = !needs;
    if (needs) solveBtn.innerHTML = `Set W to <b>${esc(R.wv.value)}</b> for ${trim(tg, 4)} Ω<br><small style="color:var(--ink-soft)">dashed outline on the drawing</small>`;
    const row = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v.value)}${v.unit ? ` ${esc(v.unit)}` : ''}${v.hint ? `<br><small>${esc(v.hint)}</small>` : ''}</dd>` : '');
    dl.innerHTML = (diff ? row('Z0 one trace', R.one) : '') + row('Effective εr', R.eeff && { ...R.eeff, hint: '' }) + row('Delay', R.delay)
      + row('Inductance', R.L) + row('Capacitance', R.C);
  }

  function drawHead() {
    const inp = ctx.input, raw = ctx.raw;
    for (const b of kinds.children) b.setAttribute('aria-checked', String(b.dataset.k === inp.kind));
    for (const b of unitSeg.children) b.setAttribute('aria-pressed', String(b.dataset.u === (inp.units === 'mil' ? 'mil' : 'mm')));
    const strip = String(inp.kind).includes('stripline'), diff = String(inp.kind).startsWith('diff');
    const offset = strip && inp.h2 > 0 && Math.abs(inp.h2 - inp.h) > 1e-9;
    badge.hidden = !strip;
    badge.textContent = offset ? 'offset stripline' : 'centred stripline';
    for (const [key, { f, lab, inp: box, label, unit }] of Object.entries(fieldEls)) {
      const off = (key === 's' && !diff) || (key === 'h2' && !strip);
      f.classList.toggle('off', off);
      box.disabled = off;
      lab.textContent = `${key === 'h' && strip ? 'Below H1' : label}${unit === 'len' ? ` (${unitName()})` : unit ? ` (${unit})` : ''}`;
      if (document.activeElement !== box) box.value = raw[key] ?? '';
      const v = String(raw[key] ?? '').trim();
      box.classList.toggle('bad', v !== '' && ctx.parseEng(v) == null);
    }
  }

  function drawSide() {
    const res = ctx.result || {};
    warnsEl.replaceChildren(...(res.warnings || []).map((w) => el('div', {}, esc(w))));
    notesEl.replaceChildren(el('summary', {}, `Model and accuracy (${(res.notes || []).length} notes)`), ...(res.notes || []).map((n) => el('div', {}, esc(n))));
  }

  function drawAll() { drawHead(); drawRead(); drawXS(); drawSweep(); drawSide(); }
  ctx.onResult(drawAll);
  new ResizeObserver(() => { if (!drag) { drawXS(); drawSweep(); drawRead(); } }).observe(grid);
}
