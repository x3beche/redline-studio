// Op-Amp Gain page: the stage on a bench.
//   Schematic  - the op-amp with Rf, Rg and Rp, the source and ground on the
//                two input feet (swap them: that is inverting against
//                non-inverting), the supply pins and the op-amp's datasheet
//                figures. Every value on it is a scrub: drag sideways (or arrow
//                keys) to step it - resistors through the chosen E-series -
//                and click or Enter to type it.
//   Scope      - input and output over two periods of the signal against the
//                rails and the output swing limits; drag the rails, the swing
//                limits and the input crest. Clipping and slew limiting show
//                on the trace.
//   Bode       - closed-loop gain, the open-loop GBW/f line (drag it to change
//                the GBW), the noise gain it meets at f-3dB, the signal
//                frequency (drag it) and the slew-limited region.
// Every number shown comes from run()'s result.stage; the page only draws.
import { fmtEng, fmtNum, SERIES } from '../kit/eng.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const h = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (cls, label) => {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls); s.setAttribute('role', 'group'); s.setAttribute('aria-label', label);
  return s;
};
const eng = (v) => fmtEng(v, '').replace(/\s+/g, ''); // 4700 -> "4.7k" for an input box
const f1 = (v, d = 3) => fmtNum(v, d);

// Value ladders the scrubs step along.
const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const ladder = (base, lo, hi) => {
  const out = [];
  for (let d = 1e-6; d <= 1e10; d *= 10) for (const b of base) { const v = Number((b * d).toPrecision(3)); if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v); }
  return out;
};
const stepOn = (list, v, n) => {
  let i = 0, best = Infinity;
  list.forEach((x, k) => { const d = Math.abs(Math.log(Math.max(x, 1e-30) / Math.max(v, 1e-30))); if (d < best) { best = d; i = k; } });
  return list[clamp(i + n, 0, list.length - 1)];
};

// What each scrub edits: how to step it, how to write it, how to show it.
function specFor(key, inp) {
  const res = SERIES[inp.series] || SERIES.E96;
  const R = (lo) => ({ step: (v, n) => stepOn(ladder(res, lo, 10e6), v || 1000, n), write: eng, show: (v) => `${key[0].toUpperCase()}${key[1]} ${fmtEng(v, 'Ω')}` });
  const N = (lo, hi, unit, write = eng) => ({ step: (v, n) => stepOn(ladder(NICE, lo, hi), v || lo, n), write, show: (v) => fmtEng(v, unit) });
  const lin = (st, lo, hi, show) => ({ step: (v, n) => Number(clamp(Math.round(((v || 0) + n * st) / st) * st, lo, hi).toFixed(3)), write: (v) => fmtNum(v, 4), show });
  switch (key) {
    case 'rf': return { ...R(1), label: 'Rf', step: (v, n) => (v <= 0 && n > 0 ? 10 : stepOn([0, ...ladder(res, 10, 10e6)], v, n)) };
    case 'rg': return { ...R(1), label: 'Rg' };
    case 'rp': return { ...R(1), label: 'Rp', step: (v, n) => stepOn([0, ...ladder(res, 10, 10e6)], v, n), show: (v) => `Rp ${v > 0 ? fmtEng(v, 'Ω') : '0 Ω'}` };
    case 'gbw': return { ...N(1e3, 10e9, 'Hz'), label: 'GBW' };
    case 'fsig': return { ...N(1, 1e9, 'Hz'), label: 'signal f' };
    case 'sr': return { ...N(0.01, 1e4, 'V/µs', (v) => fmtNum(v, 4)), show: (v) => `${fmtNum(v, 3)} V/µs`, label: 'slew rate' };
    case 'vos': return { ...N(1, 1e5, '', (v) => fmtNum(v, 4)), show: (v) => fmtEng(v * 1e-6, 'V'), label: 'Vos max' };
    case 'ib': return { ...N(1e-4, 1e5, '', (v) => fmtNum(v, 4)), show: (v) => fmtEng(v * 1e-9, 'A'), label: 'Ib' };
    case 'ios': return { ...N(1e-4, 1e5, '', (v) => fmtNum(v, 4)), show: (v) => fmtEng(v * 1e-9, 'A'), label: 'Ios' };
    case 'vin': return { ...N(1e-3, 100, 'V', (v) => fmtNum(v, 4)), show: (v) => `${fmtEng(v, 'V')} pk`, label: 'input peak' };
    case 'vpos': return { ...lin(0.5, 0, 60, (v) => `V+ ${fmtNum(v, 3)} V`), label: 'V+' };
    case 'vneg': return { ...lin(0.5, -60, 0, (v) => `V− ${fmtNum(v, 3)} V`), label: 'V−' };
    case 'swing': return { ...lin(0.05, 0, 10, (v) => `${fmtNum(v, 3)} V`), label: 'headroom' };
    default: return null;
  }
}

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const sch = h('section', { class: 'og-card og-sch' });
  const schHead = h('div', { class: 'og-head' }, '<h2>Stage</h2><span class="og-tip">Drag a value sideways or use the arrow keys · click it to type · ⇅ swaps source and ground</span>');
  const schBox = h('div', { class: 'og-box og-schbox' });
  const S = svgEl('og-svg', 'Schematic of the gain stage; its values are adjustable');
  schBox.append(S);
  const tgt = h('div', { class: 'og-target' });
  const tgtIn = h('input', { class: 'og-in', id: 'og-target', type: 'text', inputmode: 'decimal', spellcheck: 'false', placeholder: 'e.g. 11', 'aria-label': 'Target gain, V/V' });
  tgtIn.addEventListener('input', () => ctx.set('target', tgtIn.value));
  const seriesSeg = h('div', { class: 'og-seg', role: 'group', 'aria-label': 'Resistor series' },
    ['E12', 'E24', 'E96'].map((s) => `<button type="button" data-s="${s}">${s}</button>`).join(''));
  seriesSeg.addEventListener('click', (e) => { const s = e.target.closest('[data-s]')?.dataset.s; if (s) ctx.set('series', s); });
  const cands = h('div', { class: 'og-cands' });
  tgt.append(h('label', { for: 'og-target' }, 'Target gain'), tgtIn, h('span', { class: 'og-u' }, 'V/V'), seriesSeg, cands);
  sch.append(schHead, schBox, tgt);

  const scope = h('section', { class: 'og-card og-scope' });
  const scopeHead = h('div', { class: 'og-head' });
  const scBox = h('div', { class: 'og-box og-scbox' });
  const SC = svgEl('og-svg', 'Input and output against the supply rails');
  scBox.append(SC);
  scope.append(scopeHead, scBox);

  const bode = h('section', { class: 'og-card og-bode' });
  const bodeHead = h('div', { class: 'og-head' }, '<h2>Gain (dB) against frequency</h2><span class="og-tip">Drag the open-loop line to change the GBW · drag the signal marker</span>');
  const bdBox = h('div', { class: 'og-box og-bdbox' });
  const BD = svgEl('og-svg', 'Closed-loop and open-loop gain against frequency');
  bdBox.append(BD);
  bode.append(bodeHead, bdBox);

  const warn = h('section', { class: 'og-warn', 'aria-live': 'polite' });
  const side = h('section', { class: 'og-side' });
  const notes = h('details', { class: 'og-notes' });
  side.append(ctx.outputs, notes);

  const grid = h('div', { class: 'og' });
  grid.append(sch, scope, bode, warn, side);
  root.append(grid);

  // ---------------- state ----------------
  let drag = null, pending = null, editing = null;
  let scAxes = null, bdAxes = null;
  const setSoon = (obj) => {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  };
  const st = () => (ctx.result && ctx.result.stage) || null;

  // Which part a warning is about -> where its mark goes.
  function warnParts(ws) {
    const p = {};
    const add = (k, w) => { (p[k] ||= []).push(w); };
    for (const w of ws) {
      if (/bandwidth|GBW|Gain drops/.test(w)) add('amp', w);
      if (/clips/.test(w)) add('out', w);
      if (/Bias current/.test(w)) add('rp', w);
      if (/slews/.test(w)) add('sr', w);
      if (/single supply/.test(w)) add('vneg', w);
      if (/1 MΩ/.test(w)) add('rf', w);
      if (/under 1 kΩ/.test(w)) add('rf', w);
      if (/gain below 1|negative gain/.test(w)) add('target', w);
    }
    return p;
  }
  const mark = (x, y, texts) => `<g class="og-wm"><title>${esc(texts.join(' '))}</title><circle cx="${x}" cy="${y}" r="7.5"/><text x="${x}" y="${y + 4}" text-anchor="middle">!</text></g>`;

  // A scrubbable value drawn in SVG text.
  function scrub(key, x, y, anchor = 'start', extra = '') {
    const inp = ctx.input, sp = specFor(key, inp);
    const v = inp[key];
    const txt = v == null ? '–' : sp.show(v);
    const w = txt.length * 7.1 + 10;
    const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    return `<g class="og-sc ${extra}" data-k="${key}" tabindex="0" role="slider" aria-label="${esc(sp.label)}" aria-valuetext="${esc(`${sp.label} ${txt}`)}">`
      + `<rect class="og-scbg" x="${x0 - 3}" y="${y - 13}" width="${w + 6}" height="18" rx="3"/>`
      + `<text class="og-scv" x="${x0 + 5}" y="${y}">${esc(txt)}</text></g>`;
  }

  // ---------------- schematic ----------------
  function drawSch() {
    const s = st(), inp = ctx.input, res = ctx.result || {};
    const W = Math.max(300, schBox.clientWidth), H = Math.max(360, schBox.clientHeight);
    const wp = warnParts(res.warnings || []);
    const inv = inp.cfg === 'inv';
    const wide = W >= 560;
    const band = wide ? 62 : 82;           // datasheet band at the bottom
    const Hc = H - band;
    const pinDy = clamp(Hc * 0.075, 24, 46);
    const cy = Math.round(Hc * (wide ? 0.55 : 0.5));
    const xS = 30, xF = W * 0.17, xN = W * 0.40, tx0 = W * 0.46, tip = W * 0.64, xO = W * 0.72, xT = W * 0.80;
    const th = Math.min((tip - tx0) * 1.15, 2 * pinDy + 84);
    const yA = cy - pinDy, yB = cy + pinDy;
    const yRf = Math.max(cy - th / 2 - clamp(Hc * 0.1, 40, 80), 96);
    const rw = clamp((xN - xF) * 0.5, 34, 72), rh = 14;
    const o = [];
    const wire = (d, cls = '') => o.push(`<path class="og-w ${cls}" d="${d}"/>`);
    const dot = (x, y) => o.push(`<circle class="og-dot" cx="${x}" cy="${y}" r="3"/>`);
    const resistor = (key, cx, cy0, name, dashed) => {
      o.push(`<rect class="og-r${dashed ? ' off' : ''}${wp[key] ? ' w' : ''}" x="${cx - rw / 2}" y="${cy0 - rh / 2}" width="${rw}" height="${rh}" rx="1.5"/>`);
      if (name && wide) o.push(`<text class="og-rn" x="${cx - rw / 2 - 3}" y="${cy0 + rh / 2 + 14}">${name}</text>`);
      o.push(scrub(key, cx - rw / 2 - 5, cy0 - rh / 2 - 6, 'start', 'res'));
    };
    const ground = (x, y) => o.push(`<path class="og-w" d="M${x} ${y}V${y + 8}M${x - 9} ${y + 8}H${x + 9}M${x - 6} ${y + 12}H${x + 6}M${x - 3} ${y + 16}H${x + 3}"/>`);

    // gain readout, top-left
    if (s) {
      const g = s.G;
      o.push(`<text class="og-big" x="14" y="30">G = ${g > 0 ? '+' : '−'}${esc(f1(Math.abs(g), 4))}<tspan class="og-bigu"> V/V</tspan></text>`);
      o.push(`<text class="og-sub" x="14" y="50">${esc(`${f1(s.gainDb, 3)} dB · noise gain ${f1(s.NG, 4)} · ${inv ? 'inverting' : 'non-inverting'}`)}</text>`);
      if (s.bw) o.push(`<text class="og-sub" x="14" y="66">${esc(`f−3dB ${fmtEng(s.bw, 'Hz')} = GBW / ${f1(s.NG, 3)}`)}</text>`);
    }

    // feet: A (top row, Rg) and B (bottom row, Rp); the source sits on one, ground on the other
    const srcY = inv ? yA : yB, gndY = inv ? yB : yA;
    // source
    wire(`M${xS + 14} ${srcY}H${xF}`); wire(`M${xS} ${gndY}H${xF}`);
    o.push(`<circle class="og-src" cx="${xS}" cy="${srcY}" r="14"/><path class="og-sine" d="M${xS - 8} ${srcY}q4 -9 8 0t8 0"/>`);
    ground(xS, gndY);
    // source values next to it (above when on top, below when on the bottom)
    const ly = inv ? srcY - 30 : srcY + 32;
    o.push(scrub('vin', xS - 16, ly, 'start'));
    o.push(scrub('fsig', xS - 16, ly + (inv ? -20 : 20), 'start'));
    // swap button between the rows
    const swX = xS + Math.max(26, (xF - xS) * 0.55);
    o.push(`<g class="og-swap" tabindex="0" role="button" data-act="swap" aria-label="Swap source and ground: ${inv ? 'make it non-inverting' : 'make it inverting'}">`
      + `<title>Swap source and ground (${inv ? 'to non-inverting' : 'to inverting'})</title>`
      + `<rect class="og-swbg" x="${swX - 12}" y="${cy - 12}" width="24" height="24" rx="12"/><text x="${swX}" y="${cy + 5}" text-anchor="middle">⇅</text></g>`);
    // Rg on row A, Rp on row B
    const rc = (xF + xN) / 2;
    wire(`M${xF} ${yA}H${rc - rw / 2}M${rc + rw / 2} ${yA}H${tx0}`);
    wire(`M${xF} ${yB}H${rc - rw / 2}M${rc + rw / 2} ${yB}H${tx0}`);
    resistor('rg', rc, yA, inv ? 'the input resistance' : '', false);
    resistor('rp', rc, yB, inv ? 'bias-current return' : 'source resistance', !(inp.rp > 0));
    if (s && s.offset && !(inp.rp > 0) && s.offset.ib > s.offset.vos && inp.ib > 0) {
      const bx = rc - rw / 2 - 5, by = yB + rh / 2 + (wide ? 38 : 20);
      o.push(`<g class="og-sugg" tabindex="0" role="button" data-act="rp" aria-label="Set Rp to ${esc(fmtEng(s.offset.rpBestE24, 'Ω'))}, about Rf parallel Rg">`
        + `<rect x="${bx}" y="${by - 13}" width="${(`Rp = Rf‖Rg ≈ ${fmtEng(s.offset.rpBestE24, 'Ω')}`).length * 6.6 + 12}" height="18" rx="9"/>`
        + `<text x="${bx + 6}" y="${by}">${esc(`Rp = Rf‖Rg ≈ ${fmtEng(s.offset.rpBestE24, 'Ω')}`)}</text></g>`);
      if (wp.rp) o.push(mark(rc + rw / 2 + 12, yB - 12, wp.rp));
    }
    // − node and Rf loop
    dot(xN, yA);
    const rfc = (xN + xO) / 2;
    wire(`M${xN} ${yA}V${yRf}H${rfc - rw / 2}M${rfc + rw / 2} ${yRf}H${xO}V${cy}`);
    resistor('rf', rfc, yRf, '', !(inp.rf > 0));
    if (wp.rf) o.push(mark(rfc + rw / 2 + 12, yRf - 12, wp.rf));
    // op-amp
    const tri = `M${tx0} ${cy - th / 2}L${tip} ${cy}L${tx0} ${cy + th / 2}Z`;
    o.push(`<path class="og-amp${wp.amp ? ' w' : ''}" d="${tri}"/>`);
    o.push(`<text class="og-pin" x="${tx0 + 8}" y="${yA + 5}">−</text><text class="og-pin" x="${tx0 + 8}" y="${yB + 5}">+</text>`);
    const xm = (tx0 + tip) / 2, eT = cy - th / 4, eB = cy + th / 4;
    wire(`M${xm} ${eT}V${eT - 18}M${xm} ${eB}V${eB + 18}`);
    o.push(scrub('vpos', xm + 6, eT - 10, 'start'));
    o.push(scrub('vneg', xm + 6, eB + 26, 'start', wp.vneg ? 'w' : ''));
    if (wp.vneg) o.push(mark(xm + 80, eB + 20, wp.vneg));
    if (wp.amp) o.push(mark(tip - 8, cy - th / 2 + 6, wp.amp));
    // output
    wire(`M${tip} ${cy}H${xT - 5}`);
    dot(xO, cy);
    o.push(`<circle class="og-term" cx="${xT}" cy="${cy}" r="5"/>`);
    o.push(`<text class="og-rn" x="${xT + 10}" y="${cy - 8}">Vout</text>`);
    if (s && s.swing) {
      const sw = s.swing;
      o.push(`<text class="og-val ${sw.clips ? 'bad' : 'ok'}" x="${xT + 10}" y="${cy + 10}">±${esc(fmtEng(sw.vop, 'V'))}</text>`);
      if (sw.clips) o.push(`<text class="og-val bad" x="${xT + 10}" y="${cy + 25}">clips</text>`);
      if (wp.out) o.push(mark(xT, cy - 22, wp.out));
    }

    // output offset, under the output
    if (s && s.offset) {
      const O = s.offset;
      const beside = W - 12 - Math.max(xO - 10, xm + 70) > 150;
      const x0 = beside ? Math.max(xO - 10, xm + 70) : 14, x1 = W - 12, y0 = beside ? cy + 44 : Math.min(yB + 76, Hc - 72);
      {
        o.push(`<text class="og-rn" x="${x0}" y="${y0}">output offset, worst</text>`);
        o.push(`<text class="og-val" x="${x0}" y="${y0 + 17}">±${esc(fmtEng(O.total, 'V'))}</text>`);
        const bw = x1 - x0, tot = O.total || 1;
        let bx = x0;
        const segs = [['vos', O.vos, 'Vos × NG'], ['ib', O.ib, 'Ib'], ['ios', O.ios, 'Ios']];
        for (const [k, v, name] of segs) {
          const w = (v / tot) * bw;
          if (w > 0.3) o.push(`<rect class="og-off ${k}" x="${bx}" y="${y0 + 24}" width="${w}" height="9"><title>${esc(`${name}: ${fmtEng(v, 'V')}`)}</title></rect>`);
          bx += w;
        }
        let lx = x0, ly = y0 + 40;
        for (const [k, v, name] of segs) {
          const t = `${name} ${fmtEng(v, 'V')}`, tw = t.length * 6.4 + 14;
          if (lx + tw > x1 && lx > x0) { lx = x0; ly += 15; }
          o.push(`<rect class="og-off ${k}" x="${lx}" y="${ly}" width="8" height="8"/><text class="og-lg" x="${lx + 11}" y="${ly + 8}">${esc(t)}</text>`);
          lx += tw + 8;
        }
        o.push(`<text class="og-lg" x="${x0}" y="${ly + 24}">${esc(`input-referred ${fmtEng(O.inputReferred, 'V')}`)}</text>`);
      }
    }

    // datasheet band
    const by0 = Hc + 6;
    o.push(`<line class="og-sep" x1="10" x2="${W - 10}" y1="${by0 - 4}" y2="${by0 - 4}"/>`);
    o.push(`<text class="og-rn" x="14" y="${by0 + 12}">op-amp, from its datasheet</text>`);
    const keys = ['gbw', 'sr', 'vos', 'ib', 'ios', 'swing'];
    const cols = wide ? 3 : 2, cw = (W - 28) / cols;
    keys.forEach((k, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const x = 14 + c * cw, y = by0 + 32 + r * 21;
      const sp = specFor(k, inp);
      const lab = k === 'swing' ? 'out headroom' : sp.label;
      o.push(`<text class="og-dl" x="${x}" y="${y}">${esc(lab)}</text>`);
      o.push(scrub(k, x + 86, y, 'start', (k === 'sr' && wp.sr) || (k === 'gbw' && wp.amp) ? 'w' : ''));
    });

    S.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const fk = focusKey(S);
    S.innerHTML = o.join('');
    restoreFocus(S, fk);
  }

  // ---------------- scope ----------------
  function drawScope() {
    const s = st(), inp = ctx.input;
    const W = Math.max(280, scBox.clientWidth), H = Math.max(180, scBox.clientHeight);
    const sw = s && s.swing;
    scopeHead.innerHTML = `<h2>Output against the rails</h2><span class="og-tip">${inp.fsig > 0 ? esc(`two periods at ${fmtEng(inp.fsig, 'Hz')}`) : ''} · drag a rail, a swing limit or the input crest</span>`;
    if (!s || !sw) { SC.setAttribute('viewBox', `0 0 ${W} ${H}`); SC.innerHTML = `<text class="og-empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Give an input peak and the supply rails to see the output</text>`; return; }
    const m = { l: 44, r: W < 420 ? 70 : 96, t: 12, b: 20 };
    const aOut = sw.vop * (s.atF ?? 1);
    if (!drag || drag.svg !== SC || !scAxes) {
      const top = Math.max(sw.vpos, sw.mid + aOut, sw.mid + sw.vin), bot = Math.min(sw.vneg, sw.mid - aOut, sw.mid - sw.vin);
      const pad = (top - bot) * 0.08 || 1;
      scAxes = { y0: bot - pad, y1: top + pad };
    }
    const A = scAxes;
    const px = (t) => m.l + t * (W - m.l - m.r);          // t in periods / 2
    const py = (v) => m.t + (1 - (v - A.y0) / (A.y1 - A.y0)) * (H - m.t - m.b);
    const o = [];
    o.push(`<rect class="og-scr" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>`);
    for (let i = 1; i < 8; i++) o.push(`<line class="og-grat" x1="${px(i / 8)}" x2="${px(i / 8)}" y1="${m.t}" y2="${H - m.b}"/>`);
    const vs = niceStep(A.y1 - A.y0, 6);
    for (let v = Math.ceil(A.y0 / vs) * vs; v <= A.y1; v += vs) {
      o.push(`<line class="og-grat" x1="${m.l}" x2="${W - m.r}" y1="${py(v)}" y2="${py(v)}"/><text class="og-ax" x="${m.l - 6}" y="${py(v) + 3.5}" text-anchor="end">${esc(f1(v, 3))}</text>`);
    }
    o.push(`<text class="og-ax" x="${m.l - 6}" y="${m.t + 4}" text-anchor="end" dy="-2"></text>`);
    // headroom bands and rails
    const clipX = m.l, clipW = W - m.l - m.r;
    o.push(`<rect class="og-hr" x="${clipX}" width="${clipW}" y="${py(sw.vpos)}" height="${Math.max(0, py(sw.hi) - py(sw.vpos))}"/>`);
    o.push(`<rect class="og-hr" x="${clipX}" width="${clipW}" y="${py(sw.lo)}" height="${Math.max(0, py(sw.vneg) - py(sw.lo))}"/>`);
    const lines = [];
    const line = (key, v, cls, label, lab2) => lines.push({ key, y: py(v), cls, label, lab2 });
    const drawLines = () => {
      // labels at the right, pushed apart when two lines are close
      const byY = [...lines].sort((a, b) => a.y - b.y);
      byY.forEach((l, i) => { l.ly = i ? Math.max(l.y, byY[i - 1].ly + 14) : l.y; });
      for (let i = byY.length - 1; i >= 0; i--) if (byY[i].ly > H - 4) byY[i].ly = Math.min(byY[i].ly, i < byY.length - 1 ? byY[i + 1].ly - 14 : H - 4);
      for (const l of lines) {
        o.push(`<g class="og-h ns" data-k="${l.key}" tabindex="0" role="slider" aria-label="${esc(l.label)}" aria-valuetext="${esc(`${l.label} ${l.lab2}`)}">`
          + `<rect class="hit" x="${m.l}" y="${l.y - 6}" width="${W - m.l}" height="12"/>`
          + `<line class="${l.cls}" x1="${m.l}" x2="${W - m.r + 2}" y1="${l.y}" y2="${l.y}"/>`
          + (Math.abs(l.ly - l.y) > 1 ? `<path class="og-lead" d="M${W - m.r + 2} ${l.y}L${W - m.r + 7} ${l.ly}"/>` : '')
          + `<rect class="ring" x="${W - m.r + 5}" y="${l.ly - 9}" width="${m.r - 7}" height="18" rx="3"/>`
          + `<text class="og-rl" x="${W - m.r + 9}" y="${l.ly + 4}">${esc(l.lab2)}</text></g>`);
      }
    };
    const hiLab = `${W < 420 ? '' : 'swing '}${f1(sw.hi, 3)} V`, loLab = `${W < 420 ? '' : 'swing '}${f1(sw.lo, 3)} V`;
    line('vpos', sw.vpos, 'og-rail', 'Supply V+', `V+ ${f1(sw.vpos, 3)} V`);
    line('vneg', sw.vneg, 'og-rail', 'Supply V−', `V− ${f1(sw.vneg, 3)} V`);
    if (sw.headroom > 0) {
      line('swing', sw.hi, 'og-lim', 'Output headroom (top limit)', hiLab);
      if (Math.abs(py(sw.lo) - py(sw.vneg)) > 3) line('swingL', sw.lo, 'og-lim', 'Output headroom (bottom limit)', loLab);
    }
    drawLines();
    o.push(`<line class="og-mid" x1="${m.l}" x2="${W - m.r}" y1="${py(sw.mid)}" y2="${py(sw.mid)}"/>`);
    // input
    const N = 320, sgn = s.cfg === 'inv' ? -1 : 1, ph = ((s.phase || 0) * Math.PI) / 180;
    const pin = [];
    for (let i = 0; i <= N; i++) { const t = i / N; pin.push(`${px(t).toFixed(1)},${py(sw.mid + sw.vin * Math.sin(4 * Math.PI * t)).toFixed(1)}`); }
    o.push(`<polyline class="og-vin" points="${pin.join(' ')}"/>`);
    // output: ideal sine at the gain and phase at f, slewed at SR, clipped at the swing
    const T = inp.fsig > 0 ? 1 / inp.fsig : 1;
    const srVs = s.slew ? s.slew.sr * 1e6 : Infinity, dt = (2 * T) / N;
    const ideal = (t) => sw.mid + sgn * aOut * Math.sin(4 * Math.PI * t - ph);
    let y = ideal(0);
    for (let i = 0; i <= 2 * N; i++) { const tgt0 = ideal((i % N) / N); y += clamp(tgt0 - y, -srVs * dt, srVs * dt); } // settle
    const seg = { ok: [], clip: [], slew: [] };
    let cur = null, pts = [];
    const flush = () => { if (pts.length > 1) seg[cur].push(pts.join(' ')); pts = []; };
    for (let i = 0; i <= N; i++) {
      const t = i / N, want = ideal(t);
      y += clamp(want - y, -srVs * dt, srVs * dt);
      const slewing = Math.abs(want - y) > aOut * 0.02;
      const v = clamp(y, sw.lo, sw.hi);
      const kind = v !== y ? 'clip' : slewing ? 'slew' : 'ok';
      const p = `${px(t).toFixed(1)},${py(v).toFixed(1)}`;
      if (kind !== cur) { if (pts.length) { pts.push(p); flush(); } cur = kind; pts = [p]; } else pts.push(p);
    }
    flush();
    for (const k of ['ok', 'slew', 'clip']) for (const p of seg[k]) o.push(`<polyline class="og-out ${k}" points="${p}"/>`);
    // labels on the traces
    // legend, top-left of the screen
    const lg = `out ±${fmtEng(aOut, 'V')}${s.errPct > 0.05 ? ` at ${fmtEng(inp.fsig, 'Hz')}` : ''} · ${s.cfg === 'inv' ? 'inverted' : 'in phase'}${seg.clip.length ? ' · clipping' : ''}`;
    o.push(`<rect class="og-lgbg" x="${m.l + 4}" y="${m.t + 4}" width="${lg.length * 6.7 + 26}" height="17" rx="2"/><line class="og-out${seg.clip.length ? ' clip' : ''}" x1="${m.l + 9}" x2="${m.l + 21}" y1="${m.t + 12.5}" y2="${m.t + 12.5}"/>`
      + `<text class="og-tl ${seg.clip.length ? 'bad' : 'out'}" x="${m.l + 25}" y="${m.t + 16.5}">${esc(lg)}</text>`);
    if (seg.slew.length) o.push(`<text class="og-tl bad" x="${m.l + 6}" y="${H - m.b - 6}">${esc(`slew-limited: needs ${f1(s.slew.need, 3)} V/µs, has ${f1(s.slew.sr, 3)}`)}</text>`);
    // input crest handle (first positive peak of the input)
    const ix = px(0.125), iy = py(sw.mid + sw.vin);
    o.push(`<g class="og-h ns" data-k="vin" tabindex="0" role="slider" aria-label="Input peak" aria-valuetext="${esc(`input ${fmtEng(sw.vin, 'V')} peak`)}">`
      + `<circle class="hit" cx="${ix}" cy="${iy}" r="12"/><circle class="ring" cx="${ix}" cy="${iy}" r="9"/><circle class="og-knob in" cx="${ix}" cy="${iy}" r="5"/>`
      + `<text class="og-tl in" x="${ix + 10}" y="${iy + (iy - m.t < 30 ? 16 : -8)}">${esc(`in ±${fmtEng(sw.vin, 'V')}`)}</text></g>`);
    SC.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const fk = focusKey(SC);
    SC.innerHTML = o.join('');
    restoreFocus(SC, fk);
    scGeo = { py, m, H, A };
  }
  let scGeo = null;

  // ---------------- bode ----------------
  function drawBode() {
    const s = st(), inp = ctx.input;
    const W = Math.max(280, bdBox.clientWidth), H = Math.max(170, bdBox.clientHeight);
    BD.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!s || !s.bode) { BD.innerHTML = `<text class="og-empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Give the op-amp's GBW to see the frequency response</text>`; return; }
    const B = s.bode;
    const m = { l: 40, r: 14, t: 12, b: 24 };
    if (!drag || drag.svg !== BD || !bdAxes) {
      const g = Math.max(s.gainDb, B.noiseGainDb);
      bdAxes = { x0: Math.log10(B.f[0]), x1: Math.log10(B.f[B.f.length - 1]), y0: Math.min(-20, Math.floor((Math.min(...B.closed) - 5) / 20) * 20), y1: Math.ceil((g + 30) / 20) * 20 };
    }
    const A = bdAxes;
    const px = (f) => m.l + ((Math.log10(f) - A.x0) / (A.x1 - A.x0)) * (W - m.l - m.r);
    const py = (d) => m.t + (1 - (d - A.y0) / (A.y1 - A.y0)) * (H - m.t - m.b);
    const o = [];
    o.push(`<defs><clipPath id="og-bclip"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></clipPath></defs>`);
    for (let d = Math.ceil(A.x0); d <= A.x1; d++) {
      const x = px(10 ** d);
      const lab = fmtEng(10 ** d, 'Hz', 1), edge = x + lab.length * 3.3 > W - 2;
      if (W < 420 && (d - Math.ceil(A.x0)) % 2) { o.push(`<line class="og-grat" x1="${x}" x2="${x}" y1="${m.t}" y2="${H - m.b}"/>`); continue; }
      o.push(`<line class="og-grat" x1="${x}" x2="${x}" y1="${m.t}" y2="${H - m.b}"/><text class="og-ax" x="${edge ? W - 2 : x}" y="${H - m.b + 14}" text-anchor="${edge ? 'end' : 'middle'}">${esc(lab)}</text>`);
    }
    for (let d = A.y0; d <= A.y1; d += 20) o.push(`<line class="og-grat${d === 0 ? ' z' : ''}" x1="${m.l}" x2="${W - m.r}" y1="${py(d)}" y2="${py(d)}"/><text class="og-ax" x="${m.l - 5}" y="${py(d) + 3.5}" text-anchor="end">${d}</text>`);
    const poly = (ys) => B.f.map((f, i) => `${px(f).toFixed(1)},${py(ys[i]).toFixed(1)}`).join(' ');
    const g = [];
    // slew-limited region: above the full-power bandwidth
    if (s.slew && s.slew.fpbw < B.f[B.f.length - 1]) {
      const x = Math.max(m.l, px(s.slew.fpbw));
      g.push(`<rect class="og-slew" x="${x}" y="${m.t}" width="${W - m.r - x}" height="${H - m.t - m.b}"/>`);
      const lbl = `slew-limited above ${fmtEng(s.slew.fpbw, 'Hz')}`;
      g.push(`<text class="og-tl bad" x="${Math.min(x + 5, W - m.r - 4 - lbl.length * 6.7)}" y="${H - m.b - 6}">${esc(lbl)}</text>`);
    }
    // noise gain level up to f-3dB
    g.push(`<line class="og-ng" x1="${m.l}" x2="${px(s.bw)}" y1="${py(B.noiseGainDb)}" y2="${py(B.noiseGainDb)}"/>`);
    if (Math.abs(B.noiseGainDb - s.gainDb) > 0.5) g.push(`<text class="og-tl" x="${m.l + 6}" y="${py(B.noiseGainDb) - 5}">${esc(`noise gain ${f1(B.noiseGainDb, 3)} dB`)}</text>`);
    g.push(`<polyline class="og-cl" points="${poly(B.closed)}"/>`);
    o.push(`<g clip-path="url(#og-bclip)">${g.join('')}</g>`);
    // open-loop line: the handle for GBW
    const olPts = poly(B.open);
    const gx = px(s.gbw);
    o.push(`<g class="og-h ew" data-k="gbw" tabindex="0" role="slider" aria-label="Gain-bandwidth product, the open-loop line" aria-valuetext="${esc(`GBW ${fmtEng(s.gbw, 'Hz')}`)}" clip-path="url(#og-bclip)">`
      + `<polyline class="hitl" points="${olPts}"/><polyline class="ring" points="${olPts}"/><polyline class="og-ol" points="${olPts}"/>`
      + `<circle class="og-knob" cx="${gx}" cy="${py(0)}" r="4.5"/></g>`);
    const gl = `GBW ${fmtEng(s.gbw, 'Hz')}`;
    o.push(`<text class="og-tl" x="${Math.min(gx + 8, W - m.r - gl.length * 6.3)}" y="${py(0) + 16}">${esc(gl)}</text>`);
    const ki = B.open.findIndex((d) => d < A.y1 - 6);
    if (ki >= 0 && W >= 420 && px(B.f[ki]) < gx - 60) o.push(`<text class="og-tl" x="${px(B.f[ki]) + 10}" y="${py(B.open[ki]) + 4}">open loop</text>`);
    // f-3dB
    const bx = px(s.bw), byy = py(s.gainDb - 3);
    o.push(`<circle class="og-bw" cx="${bx}" cy="${byy}" r="4"/>`);
    const bl = `−3 dB at ${fmtEng(s.bw, 'Hz')}`;
    const bLeft = bx - 8 - bl.length * 6.3 > m.l;
    o.push(`<text class="og-tl acc" x="${bLeft ? bx - 8 : bx + 8}" y="${byy + 17}" text-anchor="${bLeft ? 'end' : 'start'}">${esc(bl)}</text>`);
    // signal frequency marker
    if (inp.fsig > 0) {
      const fx = px(inp.fsig);
      const txt = s.errPct != null ? `${fmtEng(inp.fsig, 'Hz')} · −${f1(s.errPct, 2)} % · ${f1(s.phase, 2)}°` : fmtEng(inp.fsig, 'Hz');
      const right = fx + 8 + txt.length * 6.3 < W - m.r;
      o.push(`<g class="og-h ew" data-k="fsig" tabindex="0" role="slider" aria-label="Signal frequency" aria-valuetext="${esc(txt)}">`
        + `<rect class="hit" x="${fx - 7}" y="${m.t}" width="14" height="${H - m.t - m.b}"/><rect class="ring" x="${fx - 5}" y="${m.t}" width="10" height="${H - m.t - m.b}" rx="3"/>`
        + `<line class="og-fs" x1="${fx}" x2="${fx}" y1="${m.t}" y2="${H - m.b}"/>`
        + `<path class="og-fsk" d="M${fx - 6} ${m.t}h12l-6 8z"/>`
        + `<text class="og-tl in" x="${right ? fx + 8 : fx - 8}" y="${m.t + 12}" text-anchor="${right ? 'start' : 'end'}">${esc(txt)}</text></g>`);
    }
    const fk = focusKey(BD);
    BD.innerHTML = o.join('');
    restoreFocus(BD, fk);
    bdGeo = { m, W, A };
  }
  let bdGeo = null;

  function niceStep(span, target) {
    const raw = span / target, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  function focusKey(svg) {
    const a = document.activeElement;
    return a && svg.contains(a) ? (a.dataset.k || a.dataset.act) : null;
  }
  function restoreFocus(svg, k) {
    if (!k) return;
    (svg.querySelector(`[data-k="${k}"]`) || svg.querySelector(`[data-act="${k}"]`))?.focus({ preventScroll: true });
  }

  // ---------------- the rest of the page ----------------
  function drawTarget() {
    const s = st(), raw = ctx.raw;
    if (document.activeElement !== tgtIn) tgtIn.value = raw.target ?? '';
    for (const b of seriesSeg.children) b.setAttribute('aria-pressed', String(b.dataset.s === (raw.series || 'E96')));
    const t = s && s.target;
    const inv = ctx.input.cfg === 'inv';
    if (!t) { cands.innerHTML = `<span class="og-hint">${inv ? 'e.g. −4.7' : 'e.g. 11'} gives a standard Rf for your Rg</span>`; return; }
    cands.innerHTML = `<span class="og-hint">Rf for ${esc(f1(t.gain, 4))} (Rg ${esc(fmtEng(ctx.input.rg, 'Ω'))}):</span>` + t.options.map((c) => {
      const on = Math.abs(c.rf - ctx.input.rf) < 1e-6 * Math.max(1, c.rf);
      return `<button type="button" class="og-chip" data-rf="${c.rf}" aria-pressed="${on}" title="${esc(`gain ${f1(c.gain, 5)}${c.bw ? `, bandwidth ${fmtEng(c.bw, 'Hz')}` : ''}`)}">${esc(c.rf === 0 ? '0 Ω' : fmtEng(c.rf, 'Ω'))} <small>${c.errPct >= 0 ? '+' : ''}${esc(f1(c.errPct, 2))} %</small></button>`;
    }).join('');
  }
  cands.addEventListener('click', (e) => { const b = e.target.closest('[data-rf]'); if (b) ctx.set('rf', eng(Number(b.dataset.rf))); });

  function drawWarn() {
    const res = ctx.result || {};
    const ws = res.warnings || [];
    warn.innerHTML = ws.length ? `<h2>Check</h2>${ws.map((w) => `<div class="og-wl">${esc(w)}</div>`).join('')}` : '<h2>Check</h2><div class="og-okl">No problems found for this stage.</div>';
    notes.innerHTML = `<summary>Model and limits (${(res.notes || []).length} notes)</summary>${(res.notes || []).map((n) => `<div>${esc(n)}</div>`).join('')}`;
  }

  // ---------------- interaction ----------------
  function stepKey(key, n) {
    const inp = ctx.input;
    if (key === 'swingL') key = 'swing';
    const sp = specFor(key, inp);
    if (!sp) return;
    ctx.set(key, sp.write(sp.step(inp[key] ?? 0, n)));
  }

  function openEditor(svg, g) {
    const key = g.dataset.k;
    const sp = specFor(key, ctx.input);
    if (!sp || editing) return;
    const box = svg.parentElement, r = g.getBoundingClientRect(), br = box.getBoundingClientRect();
    const unit = { rf: 'Ω', rg: 'Ω', rp: 'Ω', gbw: 'Hz', fsig: 'Hz', sr: 'V/µs', vos: 'µV', ib: 'nA', ios: 'nA', vin: 'V', vpos: 'V', vneg: 'V', swing: 'V' }[key];
    const inpEl = h('input', { class: 'og-in og-edit', type: 'text', spellcheck: 'false', 'aria-label': `${sp.label} in ${unit}` });
    inpEl.value = ctx.raw[key] ?? '';
    inpEl.style.left = `${Math.max(0, r.left - br.left - 4)}px`;
    inpEl.style.top = `${r.top - br.top - 3}px`;
    const tag = h('span', { class: 'og-editu' }, unit);
    tag.style.left = `${Math.max(0, r.left - br.left - 4) + 92}px`;
    tag.style.top = `${r.top - br.top}px`;
    box.append(inpEl, tag);
    editing = { key, inpEl, tag, svg };
    inpEl.focus(); inpEl.select();
    const done = (commit) => {
      if (!editing) return;
      const ed = editing; editing = null;
      ed.inpEl.remove(); ed.tag.remove();
      if (commit && ed.inpEl.value.trim() !== String(ctx.raw[key] ?? '')) ctx.set(key, ed.inpEl.value.trim());
      requestAnimationFrame(() => ed.svg.querySelector(`[data-k="${key}"]`)?.focus({ preventScroll: true }));
    };
    inpEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') { e.preventDefault(); done(false); } });
    inpEl.addEventListener('blur', () => done(true));
  }

  function wire(svg) {
    svg.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const act = e.target.closest('[data-act]');
      if (act) return; // buttons use click
      const g = e.target.closest('[data-k]');
      if (!g) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      drag = { svg, g, key: g.dataset.k, x0: e.clientX, y0: e.clientY, moved: false, inp: ctx.input, ratio: svg.viewBox.baseVal.width / rect.width, rect };
      svg.setPointerCapture(e.pointerId);
      g.focus({ preventScroll: true });
      g.classList.add('on');
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag || drag.svg !== svg) return;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      const k = drag.key, i = drag.inp;
      if (svg === SC && scGeo) {
        const { m, H, A } = scGeo;
        const y = (e.clientY - drag.rect.top) * drag.ratio;
        const v = A.y0 + (1 - (clamp(y, m.t, H - m.b) - m.t) / (H - m.t - m.b)) * (A.y1 - A.y0);
        const sw = st()?.swing; if (!sw) return;
        const r2 = (x, q) => fmtNum(Math.round(x / q) * q, 4);
        if (k === 'vpos') setSoon({ vpos: r2(Math.max(v, (i.vneg ?? 0) + 0.5), 0.1) });
        else if (k === 'vneg') setSoon({ vneg: r2(Math.min(v, (i.vpos ?? 0) - 0.5), 0.1) });
        else if (k === 'swing') setSoon({ swing: r2(clamp(sw.vpos - v, 0, (sw.vpos - sw.vneg) / 2), 0.05) });
        else if (k === 'swingL') setSoon({ swing: r2(clamp(v - sw.vneg, 0, (sw.vpos - sw.vneg) / 2), 0.05) });
        else if (k === 'vin') setSoon({ vin: fmtNum(Math.max(0.001, Math.abs(v - sw.mid)), 3) });
        return;
      }
      if (svg === BD && bdGeo && (k === 'fsig' || k === 'gbw')) {
        const { m, W, A } = bdGeo;
        if (k === 'fsig') {
          const x = (e.clientX - drag.rect.left) * drag.ratio;
          const f = 10 ** (A.x0 + ((clamp(x, m.l, W - m.r) - m.l) / (W - m.l - m.r)) * (A.x1 - A.x0));
          setSoon({ fsig: eng(Number(f.toPrecision(2))) });
        } else {
          const decades = (dx * drag.ratio) / (W - m.l - m.r) * (A.x1 - A.x0);
          setSoon({ gbw: eng(Number((i.gbw * 10 ** decades).toPrecision(2))) });
        }
        return;
      }
      // a scrub: 10 px per step
      const sp = specFor(k, i);
      if (!sp) return;
      const n = Math.round(dx / 10);
      setSoon({ [k]: sp.write(sp.step(i[k] ?? 0, n)) });
    });
    const end = () => {
      if (!drag || drag.svg !== svg) return;
      const d = drag; drag = null;
      d.g.classList.remove('on');
      if (!d.moved && d.g.classList.contains('og-sc')) { openEditor(svg, d.g); return; }
      requestAnimationFrame(drawAll);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (a) doAct(a.dataset.act);
    });
    svg.addEventListener('keydown', (e) => {
      const a = e.target.closest?.('[data-act]');
      if (a && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); doAct(a.dataset.act); return; }
      const g = e.target.closest?.('[data-k]');
      if (!g) return;
      if (e.key === 'Enter' && g.classList.contains('og-sc')) { e.preventDefault(); openEditor(svg, g); return; }
      const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const k = g.dataset.k;
      // the lower swing limit moves the other way
      stepKey(k, (k === 'swingL' ? -dir : dir) * (e.shiftKey ? 5 : 1));
    });
  }
  function doAct(a) {
    const s = st();
    if (a === 'swap') ctx.set('cfg', ctx.input.cfg === 'inv' ? 'noninv' : 'inv');
    if (a === 'rp' && s?.offset) ctx.set('rp', eng(s.offset.rpBestE24));
  }
  wire(S); wire(SC); wire(BD);

  function drawAll() {
    if (editing) return;
    drawSch(); drawScope(); drawBode(); drawTarget(); drawWarn();
  }
  ctx.onResult(() => { if (!editing) drawAll(); else { drawScope(); drawBode(); drawTarget(); drawWarn(); } });
  new ResizeObserver(() => { if (!drag) drawAll(); }).observe(grid);
}
