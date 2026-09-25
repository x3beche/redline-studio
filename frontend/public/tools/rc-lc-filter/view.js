// RC / LC Filter Designer: the page is the filter on the bench. The circuit
// is drawn across the top with its parts' values written on the parts (type
// into a part and it becomes the fixed one; arrow keys or a vertical drag step
// it through its E-series), and the magnitude response fills the stage below
// on a log-frequency axis. Drag the cutoff marker along the frequency axis,
// drag the LC curve's shoulder up or down to change the alignment, and hover
// the curve to probe gain and phase. Every number drawn comes from run()'s
// result (result.design); the page only places it.

import { fmtEng, fmtNum, parseEng, SERIES, E12, E96 } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const TOPOS = [
  ['rc-lp', 'RC low-pass', 'RC low-pass, 1st order: series R, shunt C'],
  ['rc-hp', 'RC high-pass', 'RC high-pass, 1st order: series C, shunt R'],
  ['lc-lp', 'LC low-pass', 'LC low-pass, 2nd order: series L, shunt C, into load R'],
  ['lc-hp', 'LC high-pass', 'LC high-pass, 2nd order: series C, shunt L, into load R'],
];
const ALIGNS = [
  ['critical', 'Critical', 0.5], ['bessel', 'Bessel', 0.5773], ['butterworth', 'Butterworth', Math.SQRT1_2], ['cheby1', 'Cheby 1 dB', 0.9565],
];

const h = (tag, attrs = {}, ...kids) => {
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
};
const svgEl = (cls, label) => {
  const e = document.createElementNS(NS, 'svg');
  e.setAttribute('class', cls);
  if (label) { e.setAttribute('role', 'group'); e.setAttribute('aria-label', label); }
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const eng = (v, u) => fmtEng(v, u, 4);
/** 1234 -> '1.23k': what a person would type */
const typed = (v, digits = 3) => fmtEng(v, '', digits).replace(/\s+/g, '');

/** mini schematic for the topology buttons */
function pict(t) {
  const lc = t.startsWith('lc'), hp = t.endsWith('hp');
  // horizontal parts span x 10..22 on the wire y 7; vertical ones y 9..19
  const hs = { R: 'M10 7l1.5 -3l3 6l3 -6l3 6l1.5 -3', C: 'M10 7h4.5M14.5 3v8M17.5 3v8M17.5 7H22', L: 'M10 7a1.5 1.5 0 0 1 3 0a1.5 1.5 0 0 1 3 0a1.5 1.5 0 0 1 3 0a1.5 1.5 0 0 1 3 0' };
  const vs = (k, x) => ({ R: `M${x} 9l-3 1.25l6 2.5l-6 2.5l6 2.5l-3 1.25`, C: `M${x} 9v3.5M${x - 4} 12.5h8M${x - 4} 15.5h8M${x} 15.5V19`, L: `M${x} 9a2.5 2.5 0 0 1 0 5a2.5 2.5 0 0 1 0 5` }[k]);
  const ser = hp ? 'C' : lc ? 'L' : 'R', sh = hp ? (lc ? 'L' : 'R') : 'C';
  let d = `M2 7H10${hs[ser]}M22 7H54M2 21H54M34 7v2M34 19v2${vs(sh, 34)}`;
  if (lc) d += `M46 7v2M46 19v2${vs('R', 46)}`;
  return `<svg viewBox="0 0 56 26" aria-hidden="true"><g><path d="${d}"/></g></svg>`;
}

// ---------------- the part symbols (schematic) ----------------
function symbol(kind, x, y, vert, len = 56) {
  // centred at (x, y); returns the path for a part spanning `len` px
  const a = len / 2;
  if (kind === 'R') {
    const w = 8, n = 6, step = (len - 16) / n;
    if (!vert) {
      let d = `M${x - a} ${y}h8`;
      for (let i = 0; i < n; i++) d += `l${step / 2} ${i % 2 ? w : -w}l${step / 2} ${i % 2 ? -w : w}`;
      return `${d}h8`;
    }
    let d = `M${x} ${y - a}v8`;
    for (let i = 0; i < n; i++) d += `l${i % 2 ? w : -w} ${step / 2}l${i % 2 ? -w : w} ${step / 2}`;
    return `${d}v8`;
  }
  if (kind === 'C') {
    const g = 5, p = 13;
    return vert
      ? `M${x} ${y - a}V${y - g}M${x - p} ${y - g}h${2 * p}M${x - p} ${y + g}h${2 * p}M${x} ${y + g}V${y + a}`
      : `M${x - a} ${y}H${x - g}M${x - g} ${y - p}v${2 * p}M${x + g} ${y - p}v${2 * p}M${x + g} ${y}H${x + a}`;
  }
  // L: four humps
  const n = 4, lead = 8, r = (len - 2 * lead) / n / 2;
  if (!vert) {
    let d = `M${x - a} ${y}h${lead}`;
    for (let i = 0; i < n; i++) d += `a${r} ${r} 0 0 1 ${2 * r} 0`;
    return `${d}h${lead}`;
  }
  let d = `M${x} ${y - a}v${lead}`;
  for (let i = 0; i < n; i++) d += `a${r} ${r} 0 0 1 0 ${2 * r}`;
  return `${d}v${lead}`;
}

function niceTicks(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const topos = h('div', { class: 'fl-topos', role: 'radiogroup', 'aria-label': 'Filter type' });
  for (const [k, name, title] of TOPOS) {
    const b = h('button', { class: 'fl-topo', role: 'radio', 'data-k': k, title, 'aria-label': title });
    b.innerHTML = `${pict(k)}<span>${esc(name)}</span>`;
    b.addEventListener('click', () => chooseTopo(k));
    b.addEventListener('keydown', (e) => {
      const i = TOPOS.findIndex((t) => t[0] === k);
      const j = /Right|Down/.test(e.key) ? i + 1 : /Left|Up/.test(e.key) ? i - 1 : null;
      if (j == null) return;
      e.preventDefault();
      const nk = TOPOS[(j + TOPOS.length) % TOPOS.length][0];
      chooseTopo(nk);
      topos.querySelector(`[data-k="${nk}"]`).focus();
    });
    topos.append(b);
  }
  const aligns = h('div', { class: 'fl-seg fl-aligns', role: 'radiogroup', 'aria-label': 'LC alignment' });
  for (const [k, name, q] of ALIGNS) {
    aligns.append(h('button', { 'data-a': k, role: 'radio', title: `${name}: Q ${fmtNum(q, 3)}`, onclick: () => ctx.set('align', k) },
      name, h('small', {}, ` Q ${fmtNum(q, 3)}`)));
  }
  const seriesSeg = h('div', { class: 'fl-seg', role: 'radiogroup', 'aria-label': 'Resistor series' });
  for (const k of ['E12', 'E24', 'E96']) seriesSeg.append(h('button', { 'data-s': k, role: 'radio', onclick: () => ctx.set('series', k) }, k));
  const seriesWrap = h('label', { class: 'fl-lab' }, 'R series', seriesSeg);
  const orderTag = h('span', { class: 'fl-order' });
  const bar = h('div', { class: 'fl-bar' }, topos, h('div', { class: 'fl-bar2' }, aligns, seriesWrap, orderTag));

  const schBox = h('div', { class: 'fl-sch-box' });
  const sch = svgEl('fl-sch', 'The filter circuit with its part values; type into a part to fix it, arrow keys step it through its series');
  schBox.append(sch);

  const plotHead = h('div', { class: 'fl-plot-head' });
  const plotBox = h('div', { class: 'fl-plot-box' });
  const plot = svgEl('fl-plot', 'Magnitude and phase response on a log frequency axis');
  const probeTip = h('div', { class: 'fl-tip', hidden: true });
  plotBox.append(plot, probeTip);

  const stage = h('section', { class: 'fl-card fl-stage' }, bar, schBox, plotHead, plotBox);

  // side: the corner read-out, the parts, warnings, outputs
  const readCard = h('section', { class: 'fl-card fl-read', 'aria-live': 'polite' });
  const warnsEl = h('div', { class: 'fl-warns', role: 'status' });
  const notesEl = h('details', { class: 'fl-notes' });
  const side = h('aside', { class: 'fl-side' }, readCard, warnsEl, ctx.outputs, notesEl);
  root.append(h('div', { class: 'fl' }, stage, side));

  // ---------------- state ----------------
  let drag = null;      // {kind: 'fc'|'q'|'part', ...}
  let view = null;      // frozen frequency window while dragging {lo, dec}
  let pending = null;
  let probeX = null;    // pointer x in the plot, for the probe
  const inputs = {};    // part inputs by ref

  function setSoon(obj) {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  }

  function chooseTopo(k) {
    const was = String(ctx.input.topo || 'rc-lp'), r = ctx.input.r;
    const upd = { topo: k };
    // a load for an LC filter is rarely 10 kΩ, a resistor for an RC rarely 50 Ω
    if (was.startsWith('rc') && k.startsWith('lc') && r > 1000) upd.r = '50';
    if (was.startsWith('lc') && k.startsWith('rc') && r < 100) upd.r = '10k';
    view = null;
    ctx.setMany(upd);
  }

  const topo = () => (TOPOS.some((t) => t[0] === ctx.input.topo) ? ctx.input.topo : 'rc-lp');
  const D = () => ctx.result?.design || null;

  // which part a warning points at
  function warnParts(ws) {
    const p = new Set();
    for (const w of ws || []) {
      if (/^R is only/.test(w)) p.add('R');
      if (/^C is/.test(w)) p.add('C');
      if (/^L is/.test(w)) p.add('L');
      if (/peaking/.test(w)) p.add('peak');
      if (/Standard values move the cutoff/.test(w)) p.add('corner');
      if (/load resistance/.test(w)) p.add('R');
    }
    return p;
  }

  // ---------------- stepping a part through its series ----------------
  function stepValue(v, series, dir) {
    const list = SERIES[series] || E12;
    if (!(v > 0)) return null;
    const dec = Math.floor(Math.log10(v) + 1e-9);
    const all = [];
    for (let d = dec - 1; d <= dec + 1; d++) for (const s of list) all.push(Number((s * 10 ** d).toPrecision(3)));
    if (dir > 0) return all.find((x) => x > v * 1.0001);
    return [...all].reverse().find((x) => x < v * 0.9999);
  }
  function commitPart(ref, value) {
    const T = topo();
    if (T.startsWith('rc')) {
      if (ref === 'R') ctx.setMany({ r: value, c: '' });
      else ctx.setMany({ c: value });
    } else if (ref === 'R') ctx.set('r', value);
  }
  function stepPart(ref, dir) {
    const d = D(); if (!d) return;
    const p = d.parts.find((x) => x.ref === ref); if (!p) return;
    const T = topo();
    const series = ref === 'R' ? (T.startsWith('rc') ? ctx.input.series || 'E24' : 'E24') : 'E12';
    const base = ref === 'R' && T.startsWith('lc') ? ctx.input.r : p.std;
    const nv = stepValue(base, series, dir);
    if (nv) commitPart(ref, typed(nv, 3));
  }

  // ---------------- schematic ----------------
  function drawSch() {
    const d = D(), T = topo();
    const W = Math.max(300, schBox.clientWidth), H = 176;
    sch.setAttribute('viewBox', `0 0 ${W} ${H}`);
    sch.setAttribute('height', H);
    const narrow = W < 560;
    const yW = 76, yG = 152;
    const lc = T.startsWith('lc'), hp = T.endsWith('hp');
    const xIn = narrow ? 18 : 40, xOut = W - (narrow ? 18 : 40);
    const xS = lc ? W * (narrow ? 0.22 : 0.3) : W * (narrow ? 0.28 : 0.34);
    const xN = lc ? W * (narrow ? 0.42 : 0.52) : W * (narrow ? 0.42 : 0.6);
    const xLd = W * (narrow ? 0.88 : 0.76);
    const ws = warnParts(ctx.result?.warnings);
    const parts = d?.parts || [];
    const part = (ref) => parts.find((p) => p.ref === ref);
    const serRef = hp ? 'C' : lc ? 'L' : 'R';
    const shRef = hp ? (lc ? 'L' : 'R') : 'C';
    const o = [];
    const ser = 64, sh = 56;
    // wires
    o.push(`<path class="wire" d="M${xIn} ${yW}H${xS - ser / 2}M${xS + ser / 2} ${yW}H${xOut}M${xN} ${yW}V${yW + 20}M${xN} ${yW + 20 + sh}V${yG}"/>`);
    if (lc) o.push(`<path class="wire" d="M${xLd} ${yW}V${yW + 20}M${xLd} ${yW + 20 + sh}V${yG}"/>`);
    o.push(`<path class="wire" d="M${xIn + 10} ${yG}H${xOut - 10}"/>`);
    // ground symbol under the node
    const gx = lc ? (xN + xLd) / 2 : xN + 40;
    o.push(`<path class="wire" d="M${gx} ${yG}v6M${gx - 10} ${yG + 6}h20M${gx - 6} ${yG + 10}h12M${gx - 2} ${yG + 14}h4"/>`);
    // terminals
    o.push(`<circle class="term" cx="${xIn}" cy="${yW}" r="4"/><circle class="term" cx="${xOut}" cy="${yW}" r="4"/>`);
    o.push(`<circle class="term" cx="${xIn}" cy="${yG}" r="4"/><circle class="term" cx="${xOut}" cy="${yG}" r="4"/>`);
    o.push(`<text class="lbl" x="${xIn}" y="${yW - 12}" text-anchor="${narrow ? 'start' : 'middle'}">Vin</text><text class="lbl" x="${xOut}" y="${yW - 12}" text-anchor="${narrow ? 'end' : 'middle'}">Vout</text>`);
    o.push(`<circle class="dot" cx="${xN}" cy="${yW}" r="3"/>`);
    if (lc) o.push(`<circle class="dot" cx="${xLd}" cy="${yW}" r="3"/>`);
    // signal flow arrow
    
    // parts
    const place = [];
    place.push({ ref: serRef, x: xS, y: yW, vert: false, len: ser, role: 'series' });
    place.push({ ref: shRef, x: xN, y: yW + 20 + sh / 2, vert: true, len: sh, role: 'shunt' });
    if (lc) place.push({ ref: 'R', x: xLd, y: yW + 20 + sh / 2, vert: true, len: sh, role: 'load' });
    const tags = [];
    for (const pl of place) {
      const p = part(pl.ref);
      const warn = ws.has(pl.ref) ? ' warn' : '';
      const editable = pl.ref === 'R' || (pl.ref === 'C' && !lc);
      const fixed = p?.fixed;
      const title = `${pl.ref}${pl.role === 'load' ? ' (load)' : ''}: ${p ? eng(p.std, pl.ref === 'R' ? 'Ω' : pl.ref === 'C' ? 'F' : 'H') : ''}`;
      o.push(`<g class="part${warn}${fixed ? ' fixed' : ''}${editable ? ' ed' : ''}" data-part="${pl.ref}"${editable ? ` tabindex="0" role="spinbutton" aria-label="${esc(title)}; arrow keys step through the series"` : ''}>`
        + `<rect class="hit" x="${pl.x - (pl.vert ? 18 : pl.len / 2)}" y="${pl.y - (pl.vert ? pl.len / 2 : 18)}" width="${pl.vert ? 36 : pl.len}" height="${pl.vert ? pl.len : 36}" rx="4"/>`
        + `<path class="sym" d="${symbol(pl.ref, pl.x, pl.y, pl.vert, pl.len)}"/></g>`);
      // where its tag goes
      let tx, ty, anchor;
      if (pl.role === 'series') { tx = pl.x; ty = yW - 58; anchor = 'middle'; }
      else if (pl.role === 'load') {
        if (narrow) { tx = W - 4; ty = yW - 58; anchor = 'end'; } else { tx = pl.x + 18; ty = pl.y - 22; anchor = 'start'; }
      }
      else { tx = pl.x + 20; ty = pl.y - 22; anchor = 'start'; }
      tags.push({ ...pl, p, tx, ty, anchor, editable, fixed, warn: !!warn });
    }
    // tags: ref, standard value (an input when editable), exact value
    const unit = (ref) => (ref === 'R' ? 'Ω' : ref === 'C' ? 'F' : 'H');
    for (const t of tags) {
      const p = t.p;
      const refTxt = t.role === 'load' ? 'R load' : t.ref;
      const sub = !p ? '' : t.role === 'load' ? (narrow ? '' : 'sets the damping')
        : t.fixed ? (t.ref === 'R' && Math.abs(p.std / p.exact - 1) > 1e-6 ? `${p.series} of ${eng(p.exact, 'Ω')}` : '')
        : `exact ${eng(p.exact, unit(t.ref))}${narrow ? '' : ` → ${p.series}`}`;
      const x0 = t.anchor === 'middle' ? t.tx : t.tx;
      o.push(`<text class="ref${t.warn ? ' warn' : ''}" x="${x0}" y="${t.ty}" text-anchor="${t.anchor}">${esc(refTxt)}${t.fixed && t.role !== 'load' ? ' <tspan class="lock">· fixed</tspan>' : ''}</text>`);
      if (!t.editable) o.push(`<text class="val${t.warn ? ' warn' : ''}" x="${x0}" y="${t.ty + 19}" text-anchor="${t.anchor}">${p ? esc(eng(p.std, unit(t.ref))) : '–'}</text>`);
      o.push(`<text class="sub" x="${x0}" y="${t.ty + (t.editable ? 40 : 34)}" text-anchor="${t.anchor}">${esc(sub)}</text>`);
    }
    sch.innerHTML = o.join('');
    // inputs over the editable tags
    for (const k of Object.keys(inputs)) if (!tags.some((t) => t.editable && t.ref === k)) { inputs[k].wrap.remove(); delete inputs[k]; }
    for (const t of tags.filter((x) => x.editable)) {
      let rec = inputs[t.ref];
      if (!rec) {
        const inp = h('input', { class: 'fl-pin', type: 'text', inputmode: 'decimal', spellcheck: 'false' });
        const u = h('span', { class: 'fl-pu' });
        const wrap = h('div', { class: 'fl-pwrap' }, inp, u);
        inp.addEventListener('focus', () => inp.select());
        inp.addEventListener('input', () => { if (parseEng(inp.value) > 0) commitPart(t.ref === 'R' ? 'R' : 'C', inp.value); });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepPart(t.ref, e.key === 'ArrowUp' ? 1 : -1); }
        });
        schBox.append(wrap);
        rec = inputs[t.ref] = { inp, u, wrap };
      }
      const p = t.p, raw = ctx.raw;
      const own = t.ref === 'R' ? (lc || !String(raw.c ?? '').trim() ? raw.r : null) : (String(raw.c ?? '').trim() ? raw.c : null);
      if (document.activeElement !== rec.inp) rec.inp.value = own != null ? String(own) : p ? typed(p.std, 3) : '';
      rec.inp.classList.toggle('calc', own == null);
      rec.inp.setAttribute('aria-label', `${t.role === 'load' ? 'Load resistance' : t.ref} ${own == null ? '(worked out; type to fix it)' : '(fixed)'}`);
      rec.inp.title = own == null ? 'Worked out from the cutoff. Type a value to fix this part instead.' : 'Fixed: the other part is worked out from it. Arrow keys step through the series.';
      rec.u.textContent = unit(t.ref);
      rec.wrap.classList.toggle('warn', t.warn);
      const w = 96;
      const left = t.anchor === 'middle' ? t.tx - w / 2 : t.anchor === 'end' ? t.tx - w : t.tx - 4;
      rec.wrap.style.left = `${clamp(left, 0, W - w)}px`;
      rec.wrap.style.top = `${t.ty + 4}px`;
      rec.wrap.style.width = `${w}px`;
    }
  }

  // ---------------- the response ----------------
  function frame() {
    const d = D();
    const fc = d?.fcTarget || ctx.input.fc || 1000;
    if (!view || (!drag && (fc < view.lo * 30 || fc > view.lo * 3000))) {
      view = { lo: 10 ** (Math.floor(Math.log10(fc)) - 2), dec: 5 };
    }
    return view;
  }

  let geo = null;
  function drawPlot() {
    const d = D(), T = topo();
    const W = Math.max(300, plotBox.clientWidth), H = Math.max(240, plotBox.clientHeight);
    plot.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const narrow = W < 560;
    const L = narrow ? 36 : 50, R = narrow ? 42 : 50, Tm = 30, B = 30;
    const pw = W - L - R, ph = H - Tm - B;
    const v = frame();
    const lg0 = Math.log10(v.lo);
    const X = (f) => L + ((Math.log10(f) - lg0) / v.dec) * pw;
    const Finv = (x) => 10 ** (lg0 + ((x - L) / pw) * v.dec);
    const lc = T.startsWith('lc'), hp = T.endsWith('hp');
    const peak = d?.peakDb || 0;
    const top = peak > 0.3 ? Math.ceil((peak + 3) / 5) * 5 : 5;
    const bot = lc ? -90 : -60;
    const Y = (db) => Tm + ((top - db) / (top - bot)) * ph;
    const phLo = lc ? (hp ? 0 : -180) : (hp ? 0 : -90), phHi = phLo + (lc ? 180 : 90);
    const Yp = (deg) => Tm + ((phHi - deg) / (phHi - phLo)) * ph;
    geo = { X, Y, Finv, L, R, Tm, B, pw, ph, W, H };
    const ws = warnParts(ctx.result?.warnings);
    const o = [];
    // a label beside x that stays inside the plot: right of it, left of it, or centred and clamped
    const place = (x, text, gap = 10) => {
      const w = String(text).length * 6.9;
      if (x + gap + w <= L + pw - 2) return { x: x + gap, a: 'start' };
      if (x - gap - w >= L + 2) return { x: x - gap, a: 'end' };
      return { x: clamp(x - w / 2, L + 2, L + pw - 2 - w), a: 'start' };
    };

    // grid
    o.push(`<rect class="bg" x="${L}" y="${Tm}" width="${pw}" height="${ph}"/>`);
    for (let k = 0; k <= v.dec; k++) {
      const f0 = v.lo * 10 ** k, x = X(f0);
      o.push(`<line class="gd" x1="${x}" x2="${x}" y1="${Tm}" y2="${Tm + ph}"/>`);
      o.push(`<text class="ax" x="${x}" y="${Tm + ph + 16}" text-anchor="middle">${esc(fmtEng(f0, 'Hz', 3))}</text>`);
      if (k < v.dec) for (let m = 2; m <= 9; m++) o.push(`<line class="gm" x1="${X(f0 * m)}" x2="${X(f0 * m)}" y1="${Tm}" y2="${Tm + ph}"/>`);
    }
    const step = (top - bot) > 70 ? 10 : 10;
    for (const db of niceTicks(bot, top, step)) {
      o.push(`<line class="${db === 0 ? 'g0' : 'gm'}" x1="${L}" x2="${L + pw}" y1="${Y(db)}" y2="${Y(db)}"/>`);
      o.push(`<text class="ax" x="${L - 6}" y="${Y(db) + 3}" text-anchor="end">${db}</text>`);
    }
    for (const deg of niceTicks(phLo, phHi, 45)) o.push(`<text class="ax ph" x="${L + pw + 6}" y="${Yp(deg) + 3}">${deg}°</text>`);
    o.push(`<text class="ax" x="${L - 6}" y="${Tm - 16}" text-anchor="end">dB</text><text class="ax ph" x="${L + pw + R - 2}" y="${Tm - 16}" text-anchor="end">phase</text>`);

    if (!d) { plot.innerHTML = o.join(''); return; }
    const fcX = X(d.fcTarget), fbX = X(d.fcBuilt);
    // stopband: shaded past the corner
    const sbX0 = hp ? L : fcX, sbX1 = hp ? fcX : L + pw;
    o.push(`<rect class="stop" x="${Math.min(sbX0, sbX1)}" y="${Tm}" width="${Math.abs(sbX1 - sbX0)}" height="${ph}"/>`);
    o.push(`<text class="zone" x="${hp ? L + 8 : L + pw - 8}" y="${Tm + ph - 8}" text-anchor="${hp ? 'start' : 'end'}">stopband · ${hp ? '+' : '−'}${d.slope} dB/decade</text>`);
    o.push(`<text class="zone" x="${hp ? L + pw - 8 : L + 8}" y="${Tm + ph - 8}" text-anchor="${hp ? 'end' : 'start'}">passband</text>`);
    // −3 dB line
    o.push(`<line class="m3" x1="${L}" x2="${L + pw}" y1="${Y(-3)}" y2="${Y(-3)}"/><text class="m3t" x="${L + 4}" y="${Y(-3) + 13}">−3 dB</text>`);

    // curves (clipped to the plot)
    o.push(`<clipPath id="fl-clip"><rect x="${L}" y="${Tm}" width="${pw}" height="${ph}"/></clipPath>`);
    const c = d.curve;
    let dm = '', dp = '';
    c.f.forEach((f, i) => {
      const x = X(f);
      if (x < L - 20 || x > L + pw + 20) return;
      dm += `${dm ? 'L' : 'M'}${x.toFixed(1)} ${Y(Math.max(bot - 20, c.db[i])).toFixed(1)}`;
      dp += `${dp ? 'L' : 'M'}${x.toFixed(1)} ${Yp(c.deg[i]).toFixed(1)}`;
    });
    o.push(`<g clip-path="url(#fl-clip)"><path class="phase" d="${dp}"/><path class="mag" d="${dm}"/></g>`);

    // attenuation marks from the result (0.1, 10, 100 × fc)
    for (const mk of d.marks) {
      if (![0.01, 0.1, 10, 100].includes(mk.m)) continue;
      if ((hp && mk.m > 1) || (!hp && mk.m < 1)) continue;
      const x = X(mk.f), y = Y(Math.max(bot, mk.db));
      if (x < L + 4 || x > L + pw - 4 || mk.db < bot) continue;
      o.push(`<circle class="mk" cx="${x}" cy="${y}" r="3.2"/>`);
      const lb = `${fmtNum(mk.db, 3)} dB @ ${mk.m}·fc`;
      const pp = x < L + pw * 0.62 ? place(x, lb, 8) : (x - 8 - lb.length * 6.9 >= L ? { x: x - 8, a: 'end' } : place(x, lb, 8));
      o.push(`<text class="mkt halo" x="${pp.x}" y="${y - 8}" text-anchor="${pp.a}">${fmtNum(mk.db, 3)} dB <tspan class="dim">@ ${mk.m}·fc</tspan></text>`);
    }

    // LC: the peak, and the shoulder handle (gain at f0 = Q)
    if (lc) {
      if (d.peakF && peak > 0.05) {
        const x = X(d.peakF), y = Y(peak);
        const pkTxt = `+${fmtNum(peak, 3)} dB peak`;
        const pk = hp ? place(x, pkTxt) : (x - 10 - pkTxt.length * 6.9 >= L ? { x: x - 10, a: 'end' } : place(x, pkTxt));
        o.push(`<path class="pk${ws.has('peak') ? ' warn' : ''}" d="M${x} ${Y(0)}V${y}"/><text class="pkt halo${ws.has('peak') ? ' warn' : ''}" x="${pk.x}" y="${y - 8}" text-anchor="${pk.a}">+${fmtNum(peak, 3)} dB peak</text>`);
      }
      // stops for the four alignments at f0
      const x0 = X(d.f0);
      const i0 = c.f.reduce((b, f, i) => (Math.abs(Math.log(f / d.f0)) < Math.abs(Math.log(c.f[b] / d.f0)) ? i : b), 0);
      const yq = Y(c.db[i0]);
      if (x0 > L && x0 < L + pw) {
        // the alignment ladder: a detent slider next to the shoulder, Q rising upward
        const cur = ctx.input.align || 'butterworth';
        const ci = Math.max(0, ALIGNS.findIndex((a) => a[0] === cur));
        const bw = 168, rowH = 19, bh = 26 + rowH * ALIGNS.length;
        let bx = hp ? x0 + 40 : x0 - 40 - bw;
        if (bx < L + 6) bx = L + 6;
        if (bx + bw > L + pw - 6) bx = L + pw - 6 - bw;
        const by = clamp(Y(-3) + 46, Tm + 4, Tm + ph - bh - 30);
        if (!narrow) {
        o.push(`<path class="lead" d="M${x0} ${yq}L${hp ? bx : bx + bw} ${by + 26 + rowH * (ALIGNS.length - 1 - ci) + rowH / 2}"/>`);
        o.push(`<rect class="ladder" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5"/>`);
        o.push(`<text class="lt" x="${bx + 8}" y="${by + 16}">f0 ${esc(eng(d.f0, 'Hz'))} · Q ${fmtNum(d.q, 3)}</text>`);
        ALIGNS.forEach(([k, name, q], i) => {
          const yy = by + 26 + rowH * (ALIGNS.length - 1 - i);
          const on = i === ci;
          o.push(`<g class="qstop${on ? ' on' : ''}" data-align="${k}"><rect x="${bx + 3}" y="${yy}" width="${bw - 6}" height="${rowH - 1}" rx="3"/>`
            + `<circle cx="${bx + 14}" cy="${yy + rowH / 2}" r="${on ? 4.5 : 3}"/><text x="${bx + 26}" y="${yy + 13}">${esc(name)}</text>`
            + `<text class="q" x="${bx + bw - 10}" y="${yy + 13}" text-anchor="end">Q ${fmtNum(q, 3)}</text></g>`);
        });
        }
        o.push(`<g class="hq" data-h="q" tabindex="0" role="slider" aria-label="Alignment: drag the shoulder up for more Q, or use the arrow keys" aria-valuetext="${esc(d.align)}, Q ${fmtNum(d.q, 3)}">`
          + `<circle class="hit" cx="${x0}" cy="${yq}" r="16"/><circle class="knob" cx="${x0}" cy="${yq}" r="6.5"/><path class="arr" d="M${x0} ${yq - 11}l-3 3h6zM${x0} ${yq + 11}l-3 -3h6z"/></g>`);
      }
    }

    // the corner the standard parts give
    const y3 = Y(-3);
    const bad = ws.has('corner');
    if (Math.abs(fbX - fcX) > 12) o.push(`<path class="gapb${bad ? ' warn' : ''}" d="M${fcX} ${y3 + 16}H${fbX}M${fbX} ${y3 + 12}v8"/>`);
    o.push(`<circle class="corner${bad ? ' warn' : ''}" cx="${fbX}" cy="${y3}" r="5"/>`);
    const errTxt = `${d.errPct >= 0 ? '+' : ''}${fmtNum(d.errPct, 2)} %`;
    const ctp = place(fbX, `built −3 dB ${eng(d.fcBuilt, 'Hz')} ${errTxt}`, 12);
    o.push(`<text class="ct halo${bad ? ' warn' : ''}" x="${ctp.x}" y="${y3 + 30}" text-anchor="${ctp.a}">built −3 dB ${esc(eng(d.fcBuilt, 'Hz'))} <tspan class="dim">${errTxt}</tspan></text>`);

    // the target cutoff: the handle
    o.push(`<g class="hfc" data-h="fc" tabindex="0" role="slider" aria-label="Target cutoff frequency" aria-valuetext="${esc(eng(d.fcTarget, 'Hz'))}">`
      + `<rect class="hit" x="${fcX - 12}" y="${Tm - 26}" width="24" height="${ph + 26}"/>`
      + `<line class="fcl" x1="${fcX}" x2="${fcX}" y1="${Tm}" y2="${Tm + ph}"/>`
      + `<rect class="grip" x="${fcX - 48}" y="${Tm - 26}" width="96" height="20" rx="10"/>`
      + `<text class="gript" x="${fcX}" y="${Tm - 12}" text-anchor="middle">fc ${esc(eng(d.fcTarget, 'Hz'))} ⇆</text></g>`);

    // probe
    if (probeX != null && !drag && probeX >= L && probeX <= L + pw) {
      const f = Finv(probeX);
      const i = c.f.reduce((b, ff, j) => (Math.abs(Math.log(ff / f)) < Math.abs(Math.log(c.f[b] / f)) ? j : b), 0);
      const x = X(c.f[i]);
      o.push(`<line class="probe" x1="${x}" x2="${x}" y1="${Tm}" y2="${Tm + ph}"/><circle class="probed" cx="${x}" cy="${Y(Math.max(bot, c.db[i]))}" r="3.5"/><circle class="probep" cx="${x}" cy="${Yp(c.deg[i])}" r="3"/>`);
      probeTip.hidden = false;
      probeTip.innerHTML = `<b>${esc(eng(c.f[i], 'Hz'))}</b><span>${fmtNum(c.db[i], 3)} dB</span><span class="ph">${fmtNum(c.deg[i], 3)}°</span>`;
      const tw = 150;
      probeTip.style.left = `${clamp(x + 10, 0, W - tw)}px`;
      probeTip.style.top = `${Tm + 6}px`;
    } else probeTip.hidden = true;

    const fk = document.activeElement?.closest?.('[data-h]')?.dataset.h;
    plot.innerHTML = o.join('');
    if (fk) plot.querySelector(`[data-h="${fk}"]`)?.focus({ preventScroll: true });
    plotHead.innerHTML = `<b>Response with the standard parts</b><span>${narrow ? 'drag fc · hover to probe' : `drag the fc marker along the axis${lc ? ' · drag the dot at f0 up or down for the alignment' : ''} · hover the curve to probe · arrow keys on a focused handle`}</span>`
      + `<span class="fl-key"><i class="k-mag"></i>gain <i class="k-ph"></i>phase</span>`;
  }

  // ---------------- side ----------------
  function drawSide() {
    const res = ctx.result || {}, d = res.design, T = topo();
    const ws = res.warnings || [];
    if (!d) {
      readCard.innerHTML = '<div class="fl-rl">Cutoff</div><div class="fl-big">–</div>';
    } else {
      const err = d.errPct, tone = Math.abs(err) > 10 ? 'warn' : 'ok';
      const g = clamp(err, -15, 15);
      const unit = (ref) => (ref === 'R' ? 'Ω' : ref === 'C' ? 'F' : 'H');
      const rows = d.parts.map((p) => `<tr${warnParts(ws).has(p.ref) ? ' class="warn"' : ''}><th>${p.series === 'load' ? 'R load' : p.ref}</th><td>${esc(eng(p.std, unit(p.ref)))}</td><td class="soft">${p.series === 'load' ? 'given' : p.fixed ? (p.series === 'fixed' ? 'fixed' : `fixed, ${p.series}`) : `${esc(eng(p.exact, unit(p.ref)))} exact · ${p.series}`}</td></tr>`).join('');
      const extra = d.order === 2 ? `
        <dl class="fl-dl">
          <dt>Q with these parts</dt><dd>${fmtNum(d.q, 3)} <small>${esc(d.align)} ${fmtNum(d.qTarget, 3)}</small></dd>
          <dt>Resonance f0</dt><dd>${esc(eng(d.f0, 'Hz'))}</dd>
          <dt>Impedance √(L/C)</dt><dd>${esc(eng(d.z, 'Ω'))}</dd>
          <dt>Peaking</dt><dd class="${d.peakDb > 3 ? 'bad' : d.peakDb > 0.5 ? 'warn' : ''}">${fmtNum(d.peakDb, 2)} dB</dd>
        </dl>` : '';
      const marks = d.marks.filter((m) => [0.1, 0.5, 2, 10].includes(m.m)).map((m) => `<tr><th>${m.m}·fc</th><td>${esc(eng(m.f, 'Hz'))}</td><td>${fmtNum(m.db, 3)} dB</td><td class="soft">${fmtNum(m.deg, 3)}°</td></tr>`).join('');
      readCard.innerHTML = `
        <div class="fl-rl">−3 dB with standard parts</div>
        <div class="fl-big t-${tone}"><b>${esc(fmtEng(d.fcBuilt, 'Hz', 4).split(' ')[0])}</b><span>${esc(fmtEng(d.fcBuilt, 'Hz', 4).split(' ')[1] || 'Hz')}</span></div>
        <div class="fl-dev">${err >= 0 ? '+' : ''}${fmtNum(err, 2)} % from the ${esc(eng(d.fcTarget, 'Hz'))} target</div>
        <svg class="fl-gauge" viewBox="0 0 300 30" preserveAspectRatio="none" aria-hidden="true">
          <rect class="gz" x="0" y="8" width="300" height="10"/><rect class="gok" x="${150 - 100}" y="8" width="200" height="10"/>
          <line class="g0" x1="150" x2="150" y1="4" y2="22"/><path class="gm t-${tone}" d="M${150 + g * 10} 4l-5 -4h10z"/><line class="gm t-${tone}" x1="${150 + g * 10}" x2="${150 + g * 10}" y1="4" y2="22"/>
          <text x="2" y="30">−15 %</text><text x="150" y="30" text-anchor="middle">±10 %</text><text x="298" y="30" text-anchor="end">+15 %</text>
        </svg>
        <table class="fl-parts"><tbody>${rows}</tbody></table>
        ${extra}
        <table class="fl-marks"><thead><tr><th></th><th>f</th><th>gain</th><th>phase</th></tr></thead><tbody>${marks}</tbody></table>`;
    }
    warnsEl.replaceChildren(...ws.map((w) => h('div', {}, w)));
    warnsEl.hidden = !ws.length;
    const notes = res.notes || [];
    notesEl.innerHTML = `<summary>Model and assumptions (${notes.length})</summary>${notes.map((n) => `<p>${esc(n)}</p>`).join('')}`;
    notesEl.hidden = !notes.length;
  }

  function drawBar() {
    const T = topo(), lc = T.startsWith('lc');
    for (const b of topos.children) b.setAttribute('aria-checked', String(b.dataset.k === T));
    for (const b of aligns.children) b.setAttribute('aria-checked', String(b.dataset.a === (ctx.input.align || 'butterworth')));
    for (const b of seriesSeg.children) b.setAttribute('aria-checked', String(b.dataset.s === (ctx.input.series || 'E24')));
    aligns.hidden = !lc;
    seriesWrap.hidden = lc;
    orderTag.textContent = lc ? '2nd order · 40 dB/decade' : '1st order · 20 dB/decade';
  }

  function drawAll() { drawBar(); drawSch(); drawPlot(); drawSide(); }

  // ---------------- interaction: plot ----------------
  const ptX = (e) => { const r = plot.getBoundingClientRect(); return (e.clientX - r.left) * (geo.W / r.width); };
  const ptY = (e) => { const r = plot.getBoundingClientRect(); return (e.clientY - r.top) * (geo.H / r.height); };
  const snapF = (f) => {
    const dec = Math.floor(Math.log10(f)), m = f / 10 ** dec;
    const s = E96.reduce((b, x) => (Math.abs(Math.log(x / m)) < Math.abs(Math.log(b / m)) ? x : b), 1);
    return Number((s * 10 ** dec).toPrecision(3));
  };
  plot.addEventListener('pointerdown', (e) => {
    const st = e.target.closest('[data-align]');
    if (st) { e.preventDefault(); ctx.set('align', st.dataset.align); return; }
    const hEl = e.target.closest('[data-h]');
    if (!hEl || !geo) return;
    e.preventDefault();
    drag = { kind: hEl.dataset.h, y0: ptY(e), i0: Math.max(0, ALIGNS.findIndex((a) => a[0] === (ctx.input.align || 'butterworth'))) };
    plot.setPointerCapture(e.pointerId);
    hEl.focus({ preventScroll: true });
    probeX = null;
    plot.classList.add('dragging');
  });
  plot.addEventListener('pointermove', (e) => {
    if (!geo) return;
    if (!drag) {
      if (e.pointerType === 'mouse') { probeX = ptX(e); drawPlot(); }
      return;
    }
    if (drag.kind === 'fc') {
      const x = clamp(ptX(e), geo.L + 2, geo.L + geo.pw - 2);
      const f = snapF(geo.Finv(x));
      setSoon({ fc: typed(f, 3) });
    } else if (drag.kind === 'q') {
      const i = clamp(drag.i0 + Math.round((drag.y0 - ptY(e)) / 19), 0, ALIGNS.length - 1);
      const k = ALIGNS[i][0];
      if (k !== ctx.input.align) setSoon({ align: k });
    }
  });
  const endDrag = () => { if (!drag) return; drag = null; plot.classList.remove('dragging'); drawPlot(); };
  plot.addEventListener('pointerup', endDrag);
  plot.addEventListener('pointercancel', endDrag);
  plot.addEventListener('pointerleave', () => { if (!drag && probeX != null) { probeX = null; drawPlot(); } });
  plot.addEventListener('keydown', (e) => {
    const hEl = e.target.closest?.('[data-h]');
    if (!hEl) return;
    const k = hEl.dataset.h;
    if (k === 'fc') {
      const fc = ctx.input.fc; if (!(fc > 0)) return;
      let f = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') f = stepValue(fc, 'E24', 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') f = stepValue(fc, 'E24', -1);
      else if (e.key === 'PageUp') f = fc * 10;
      else if (e.key === 'PageDown') f = fc / 10;
      if (f) { e.preventDefault(); ctx.set('fc', typed(f, 3)); }
    } else if (k === 'q') {
      const i = ALIGNS.findIndex((a) => a[0] === (ctx.input.align || 'butterworth'));
      const j = /Up|Right/.test(e.key) ? i + 1 : /Down|Left/.test(e.key) ? i - 1 : null;
      if (j == null) return;
      e.preventDefault();
      ctx.set('align', ALIGNS[clamp(j, 0, ALIGNS.length - 1)][0]);
    }
  });

  // ---------------- interaction: parts ----------------
  sch.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-part].ed');
    if (!g) return;
    e.preventDefault();
    drag = { kind: 'part', ref: g.dataset.part, y0: e.clientY, steps: 0 };
    sch.setPointerCapture(e.pointerId);
    g.focus({ preventScroll: true });
  });
  sch.addEventListener('pointermove', (e) => {
    if (drag?.kind !== 'part') return;
    const n = Math.trunc((drag.y0 - e.clientY) / 14);
    if (n !== drag.steps) { stepPart(drag.ref, n > drag.steps ? 1 : -1); drag.steps = n; }
  });
  const endPart = (e) => {
    if (drag?.kind !== 'part') return;
    const ref = drag.ref, moved = drag.steps !== 0;
    drag = null;
    if (!moved) inputs[ref]?.inp.focus(); // a click: type into it
    void e;
  };
  sch.addEventListener('pointerup', endPart);
  sch.addEventListener('pointercancel', endPart);
  sch.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-part]');
    if (!g) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepPart(g.dataset.part, e.key === 'ArrowUp' ? 1 : -1); }
    if (e.key === 'Enter') { e.preventDefault(); inputs[g.dataset.part]?.inp.focus(); }
  });

  ctx.onResult(() => drawAll());
  new ResizeObserver(() => { if (!drag) { drawSch(); drawPlot(); } }).observe(stage);
}
