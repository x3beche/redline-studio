// MOSFET Gate Drive Check page: the switching edge is the interface.
//   - the gate-drive path (driver, Rg, Rg,int, the MOSFET and its load): scrub
//     any value sideways, or focus it and use the arrow keys;
//   - the gate-charge curve VGS(Qg): drag the plateau knee, the plateau end,
//     the end point (Qg at Vdrv) and the threshold line;
//   - the turn-on and turn-off edges on one time scale, the V·I overlap shaded
//     as the energy lost per edge, the other switch's gate bump (Miller);
//   - one PWM period with the edges to scale (drag the falling edge for duty)
//     and loss against frequency (drag the marker for f).
// Every number shown comes from tool.js run() (result.drawing / values).
import { fmtEng, standard, E24 } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const svgEl = (cls, label) => {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', cls);
  s.setAttribute('role', 'group');
  s.setAttribute('aria-label', label);
  return s;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sig = (v, n = 3) => String(Number(Number(v).toPrecision(n)));
const E = (v, u, d = 3) => fmtEng(v, u, d);
const engIn = (v) => { // 100000 -> '100k' for an input field
  const s = fmtEng(v, '', 3).replace(/\s+/g, '');
  return s.replace(/µ$/, 'u');
};
function niceStep(span, target) {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
const niceCeil = (v) => { const s = niceStep(v, 4); return Math.ceil(v / s - 1e-9) * s; };

// Scrubbable values on the gate-drive path.
const SPEC = {
  vdrv: { name: 'Driver supply', unit: 'V', lin: 0.5, min: 3, max: 30 },
  isrc: { name: 'Driver peak source current', unit: 'A', min: 0.05, max: 30 },
  isnk: { name: 'Driver peak sink current', unit: 'A', min: 0.05, max: 30 },
  rg: { name: 'External gate resistor', unit: 'Ω', e24: true, min: 0, max: 220 },
  rgi: { name: 'Internal gate resistance', unit: 'Ω', e24: true, min: 0, max: 30 },
  vbus: { name: 'Switched voltage VDS', unit: 'V', min: 1, max: 1500 },
  id: { name: 'Drain current when switching', unit: 'A', min: 0.1, max: 500 },
  rds: { name: 'RDS(on) hot', unit: 'mΩ', min: 0.3, max: 5000 },
  crss: { name: 'Crss', unit: 'pF', min: 1, max: 5000 },
  f: { name: 'Switching frequency', unit: 'Hz', min: 1e3, max: 5e6, eng: true },
};

function stepValue(key, v, dir, big) {
  const sp = SPEC[key];
  if (sp.lin) return clamp(Math.round((v + dir * sp.lin * (big ? 4 : 1)) / sp.lin) * sp.lin, sp.min, sp.max);
  if (sp.e24) {
    if (!(v > 0)) return dir > 0 ? 1 : 0;
    let x = v;
    for (let i = 0; i < (big ? 4 : 1); i++) {
      const n = standard(x * (dir > 0 ? 1.001 : 0.999), E24, dir > 0 ? 'up' : 'down');
      x = n ?? x;
    }
    if (dir < 0 && x < 1 && v <= 1) return 0;
    return clamp(x, sp.min, sp.max);
  }
  return clamp(Number((v * (dir > 0 ? (big ? 1.5 : 1.08) : 1 / (big ? 1.5 : 1.08))).toPrecision(2)), sp.min, sp.max);
}
function scrubValue(key, v0, dxPx) {
  const sp = SPEC[key];
  if (sp.lin) return clamp(Math.round((v0 + dxPx * sp.lin * 0.2) / sp.lin) * sp.lin, sp.min, sp.max);
  const base = v0 > 0 ? v0 : 1;
  const x = clamp(base * Math.exp(dxPx * 0.012), sp.min, sp.max);
  if (sp.e24) return x < 0.9 ? 0 : standard(x, E24);
  return Number(x.toPrecision(2));
}
const asInput = (key, v) => (SPEC[key]?.eng ? engIn(v) : sig(v, 4));

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const card = (cls, title, hint) => {
    const c = el('section', { class: `mg-card ${cls}` });
    const h = el('div', { class: 'mg-head' });
    h.append(el('h2', {}, esc(title)));
    if (hint) h.append(el('span', { class: 'mg-hint' }, hint));
    c.append(h);
    return c;
  };

  const drv = card('mg-drv', 'Gate drive path', 'drag a value sideways · arrow keys when focused');
  const schBox = el('div', { class: 'mg-box mg-sch-box' });
  const sch = svgEl('mg-svg', 'Gate drive circuit; values are adjustable');
  schBox.append(sch); drv.append(schBox);

  const qgc = card('mg-qg', 'Gate charge', 'drag the knee, the plateau end, the end point or the Vth line');
  const qgBox = el('div', { class: 'mg-box mg-qg-box' });
  const qsv = svgEl('mg-svg', 'Gate charge curve, VGS against Qg; its corners are draggable');
  qgBox.append(qsv); qgc.append(qgBox);

  const edg = card('mg-edge', 'Switching edges', 'one time scale · shaded: V × I overlap, the energy lost per edge');
  const edBox = el('div', { class: 'mg-box mg-ed-box' });
  const esv = svgEl('mg-svg', 'Turn-on and turn-off waveforms');
  edBox.append(esv); edg.append(edBox);

  const per = card('mg-per', 'One period and frequency', 'drag the falling edge for duty · drag the marker for frequency');
  const peBox = el('div', { class: 'mg-box mg-pe-box' });
  const psv = svgEl('mg-svg', 'One switching period and loss against frequency');
  peBox.append(psv); per.append(peBox);

  const side = el('aside', { class: 'mg-side' });
  const loss = el('section', { class: 'mg-card mg-loss', 'aria-live': 'polite' });
  const warnsEl = el('div', { class: 'mg-warns', role: 'status' });
  const all = el('details', { class: 'mg-card mg-all' });
  all.append(el('summary', {}, 'All inputs as numbers'), ctx.form);
  const notesEl = el('details', { class: 'mg-notes' });
  side.append(loss, warnsEl, all, ctx.outputs, notesEl);

  const grid = el('div', { class: 'mg' });
  grid.append(drv, qgc, edg, per, side);
  root.append(grid);

  // ---------------- state ----------------
  let drag = null;
  let pending = null;
  let qAxes = null;   // gate-charge axes, frozen while dragging
  let fAxes = null;
  const geo = {};
  let lastGood = null; // the last drawable result: kept on screen (dimmed) while an input is invalid
  const D = () => ctx.result?.drawing || lastGood;

  function setSoon(obj) {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  }
  const toSvg = (svg, e) => {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    return { x: (e.clientX - r.left) * (vb.width / r.width), y: (e.clientY - r.top) * (vb.height / r.height) };
  };
  const keepFocus = (svg, fn) => {
    const a = document.activeElement;
    const k = a && svg.contains(a) ? a.dataset.h : null;
    fn();
    if (drag?.svg === svg) svg.querySelector(`[data-h="${drag.h}"]`)?.classList.add('on');
    if (k) svg.querySelector(`[data-h="${k}"]`)?.focus({ preventScroll: true });
  };
  const handle = (key, cls, label, now, inner) =>
    `<g class="mg-h ${cls}" data-h="${key}" tabindex="0" role="slider" aria-label="${esc(label)}" aria-valuetext="${esc(`${label} ${now}`)}">${inner}</g>`;
  const wmark = (x, y, text) => `<g class="wmark"><title>${esc(text)}</title><circle cx="${x}" cy="${y}" r="7.5"/><text x="${x}" y="${y + 4}" text-anchor="middle">!</text></g>`;
  const warnAbout = (re) => (ctx.result?.warnings || []).filter((w) => re.test(w)).join(' ');

  // ================= gate-drive path =================
  function drawSch() {
    const d = D(), raw = ctx.raw;
    const Wp = Math.max(300, schBox.clientWidth), Hp = Math.max(140, schBox.clientHeight);
    const LW = Math.max(Wp, 620), sc = Wp / LW, LH = Math.max(150, Hp / sc);
    const fk = Math.min(1.35, 1 / sc); // bigger type when the drawing is scaled down
    sch.setAttribute('viewBox', `0 0 ${LW} ${LH}`);
    sch.style.setProperty('--fk', fk);
    if (!d) { sch.innerHTML = `<text x="12" y="24" class="lbl">${esc((ctx.result?.warnings || [])[0] || '')}</text>`; return; }
    const o = [];
    const cw = 7.0 * fk;
    const yG = Math.round(clamp(LH * 0.56, 80, LH - 62));
    const drvX = 14, drvW = 124, drvT = yG - 48, drvB = yG + 44;
    const xOut = drvX + drvW;
    const xRg = 238, pkgL = 318, xRgi = 372, xGate = 448, xFet = xGate + 16, xR = xFet + 18, pkgR = xR + 26;
    const yD = yG - 30, yS = yG + 30;
    const chip = (key, x, y, text, anchor = 'middle', warn = false) => {
      const w = text.length * cw + 14, x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
      const sp = SPEC[key];
      return handle(key, 'ew chip', sp.name, `${raw[key]} ${sp.unit}`,
        `<rect class="ring" x="${x0 - 3}" y="${y - 13 * fk}" width="${w + 6}" height="${22 * fk}" rx="5"/><rect class="cbox${warn ? ' w' : ''}" x="${x0}" y="${y - 10 * fk}" width="${w}" height="${16 * fk}" rx="3"/><text class="ct" x="${x0 + 7}" y="${y + 2.5 * fk}">${esc(text)}</text>`);
    };
    // driver: totem pole between VDRV and ground
    const xs = xOut - 22;
    o.push(`<rect class="blk" x="${drvX}" y="${drvT}" width="${drvW}" height="${drvB - drvT}" rx="4"/>`);
    o.push(`<path class="wire" d="M${xs} ${drvT - 14}V${yG - 26}M${xs} ${yG + 26}V${drvB}M${xs} ${yG - 10}V${yG + 10}M${xs} ${yG}H${xOut}"/>`);
    o.push(`<rect class="sw on" x="${xs - 5}" y="${yG - 26}" width="10" height="16" rx="2"/><rect class="sw off" x="${xs - 5}" y="${yG + 10}" width="10" height="16" rx="2"/>`);
    o.push(`<path class="wire" d="M${drvX} ${drvT - 14}H${xs}"/>`);
    o.push(`<path class="wire" d="M${xs} ${drvB}V${drvB + 8}M${xs - 8} ${drvB + 8}H${xs + 8}M${xs - 4} ${drvB + 12}H${xs + 4}"/>`);
    o.push(chip('vdrv', drvX + 4, drvT - 30, `VDRV ${raw.vdrv} V`, 'start'));
    o.push(`<text class="small" x="${drvX + 6}" y="${yG - 24}">source</text>`);
    o.push(chip('isrc', drvX + 6, yG - 8, `${raw.isrc} A`, 'start'));
    o.push(`<text class="small" x="${drvX + 6}" y="${yG + 16}">sink</text>`);
    o.push(chip('isnk', drvX + 6, yG + 32, `${raw.isnk} A`, 'start'));
    // gate path: out -> Rg -> package (Rg,int -> gate)
    const res = (x) => `<path class="res" d="M${x - 20} ${yG}l3 -5l5 10l5 -10l5 10l5 -10l5 10l5 -10l3 5"/>`;
    o.push(`<path class="wire" d="M${xOut} ${yG}H${xRg - 20}M${xRg + 20} ${yG}H${xRgi - 20}M${xRgi + 20} ${yG}H${xGate}"/>`);
    o.push(res(xRg), res(xRgi));
    o.push(chip('rg', xRg, yG + 24, `Rg ${raw.rg || 0} Ω`, 'middle', d.share > 0.1));
    o.push(`<rect class="pkg" x="${pkgL}" y="${yD - 22}" width="${pkgR - pkgL}" height="${yS - yD + 40}" rx="6"/><text class="small" x="${pkgR - 6}" y="${yS + 14}" text-anchor="end">MOSFET</text>`);
    o.push(chip('rgi', xRgi, yG + 24, `Rg,int ${raw.rgi || 0} Ω`));
    // MOSFET symbol
    o.push(`<path class="wire" d="M${xGate} ${yG - 16}V${yG + 16}"/>`);
    o.push(`<path class="wire" d="M${xFet} ${yG - 18}V${yG - 9}M${xFet} ${yG - 4}V${yG + 4}M${xFet} ${yG + 9}V${yG + 18}"/>`);
    o.push(`<path class="wire" d="M${xFet} ${yG - 13}H${xR}V${yD}M${xFet} ${yG + 13}H${xR}V${yS}M${xFet} ${yG}H${xR}V${yG + 13}"/>`);
    o.push(`<path class="arr" d="M${xFet + 2} ${yG}l7 -4v8z"/>`);
    // Crss gate-drain
    if (d.crss) {
      const xc = xGate - 12;
      o.push(`<path class="wire dash" d="M${xGate} ${yG - 12}H${xc}V${yD + 12}M${xc} ${yD + 6}V${yD - 6}H${xR}"/><path class="cap" d="M${xc - 6} ${yD + 12}H${xc + 6}M${xc - 6} ${yD + 6}H${xc + 6}"/>`);
    }
    // drain to the switched node (load), source to ground
    const yTop = 10;
    o.push(`<path class="wire" d="M${xR} ${yD}V${yTop + 26}M${xR} ${yS}V${yS + 22}M${xR - 8} ${yS + 22}H${xR + 8}M${xR - 4} ${yS + 26}H${xR + 4}"/>`);
    o.push(`<path class="ind" d="M${xR} ${yTop + 26}c9 0 9 -8 0 -8c9 0 9 -8 0 -8c9 0 9 -8 0 -8"/>`);
    o.push(chip('crss', xGate - 18, yD - 12, raw.crss !== '' && raw.crss != null ? `Crss ${raw.crss} pF` : 'Crss –', 'end', d.vInd != null && d.vInd > 0.8 * d.vth));
    o.push(chip('vbus', xR + 16, yTop + 10, `VDS ${raw.vbus} V`, 'start'));
    o.push(chip('id', xR + 16, yTop + 10 + 22 * fk, `ID ${raw.id} A`, 'start'));
    o.push(chip('rds', xR + 16, yG + 2, `RDS ${raw.rds} mΩ`, 'start'));
    // gate currents along the path (from the result)
    const xa0 = xRg + 26, xa1 = xRgi - 26;
    o.push(`<path class="iarr on" d="M${xa0} ${yG - 12}H${xa1}m-5 -3.5l5 3.5l-5 3.5"/><text class="ival" x="${(xa0 + xa1) / 2}" y="${yG - 18}" text-anchor="middle">${esc(E(d.igOn, 'A'))}</text>`);
    o.push(`<path class="iarr off" d="M${xa1} ${yG + 44 * fk}H${xa0}m5 -3.5l-5 3.5l5 3.5"/><text class="ival" x="${(xa0 + xa1) / 2}" y="${yG + 44 * fk + 14 * fk}" text-anchor="middle">${esc(E(d.igOff, 'A'))}</text>`);
    // the gate-current sums, when there is room for them
    const xq = pkgR + 150;
    if (LW - xq > 330) {
      const f3 = (v) => sig(v, 3);
      const ln = (y, cls, lab, rs, rsv, num, ig) => {
        o.push(`<text class="eq ${cls}" x="${xq}" y="${y}"><tspan class="eqh">${lab}</tspan></text>`);
        o.push(`<text class="eq" x="${xq}" y="${y + 17}">${rs} ${f3(rsv)} + Rg ${f3(d.rg)} + Rg,int ${f3(d.rgi)} = <tspan class="eqb">${f3(rsv + d.rg + d.rgi)} Ω</tspan></text>`);
        o.push(`<text class="eq" x="${xq}" y="${y + 34}">Ig = ${num} / ${f3(rsv + d.rg + d.rgi)} Ω = <tspan class="eqb">${esc(E(ig, 'A'))}</tspan></text>`);
      };
      ln(yTop + 14, 'on', 'Turn-on: driver pulls the gate up', 'R src', d.rSrc, `(${f3(d.vdrv)} − ${f3(d.vpl)}) V`, d.igOn);
      ln(yTop + 14 + 60, 'off', 'Turn-off: driver sinks from the plateau', 'R snk', d.rSnk, `${f3(d.vpl)} V`, d.igOff);
      o.push(`<text class="small" x="${xq}" y="${yTop + 14 + 118}">driver R ≈ VDRV / I peak · plateau from the gate-charge curve below</text>`);
    }
    keepFocus(sch, () => { sch.innerHTML = o.join(''); });
    geo.sch = { sc };
  }

  // ================= gate-charge curve =================
  function drawQg() {
    const d = D(), inp = ctx.input, raw = ctx.raw;
    const Wp = Math.max(280, qgBox.clientWidth), Hp = Math.max(220, qgBox.clientHeight);
    qsv.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    if (!d) { qsv.innerHTML = ''; return; }
    const qg = d.qg * 1e9, qgs = d.qgs * 1e9, qgd = d.qgd * 1e9, qgs2 = d.qgs2 * 1e9;
    const { vpl, vth, vdrv } = d;
    if (!drag || drag.svg !== qsv || !qAxes) qAxes = { x1: niceCeil(Math.max(qg, qgs + qgd) * 1.12), y1: niceCeil(Math.max(vdrv, vpl) * 1.14) };
    const A = qAxes;
    const m = { l: 40, r: 16, t: 18, b: 66 };
    const px = (q) => m.l + (q / A.x1) * (Wp - m.l - m.r);
    const py = (v) => m.t + (1 - v / A.y1) * (Hp - m.t - m.b);
    const o = [];
    const yAx = Hp - m.b;
    // grid
    const xs = niceStep(A.x1, Wp > 480 ? 8 : 5), ys = niceStep(A.y1, 5);
    for (let q = 0; q <= A.x1 + 1e-9; q += xs) o.push(`<line class="grid" x1="${px(q)}" x2="${px(q)}" y1="${m.t}" y2="${yAx}"/><text class="tick" x="${px(q)}" y="${yAx + 13}" text-anchor="middle">${sig(q, 3)}</text>`);
    for (let v = 0; v <= A.y1 + 1e-9; v += ys) o.push(`<line class="grid" x1="${m.l}" x2="${Wp - m.r}" y1="${py(v)}" y2="${py(v)}"/><text class="tick" x="${m.l - 6}" y="${py(v) + 3.5}" text-anchor="end">${sig(v, 3)}</text>`);
    o.push(`<text class="tick" x="${Wp - m.r - 2}" y="${yAx - 6}" text-anchor="end">Qg (nC)</text><text class="tick" x="4" y="${m.t - 6}">VGS (V)</text>`);
    const q1 = qgs - qgs2; // Qgs1: 0 -> Vth
    // phase bands: Qgs2 (current rises) and Qgd (voltage falls)
    o.push(`<rect class="band-i" x="${px(q1)}" y="${m.t}" width="${px(qgs) - px(q1)}" height="${yAx - m.t}"/>`);
    o.push(`<rect class="band-v" x="${px(qgs)}" y="${m.t}" width="${px(qgs + qgd) - px(qgs)}" height="${yAx - m.t}"/>`);
    // level lines
    o.push(`<line class="lvl drvl" x1="${m.l}" x2="${Wp - m.r}" y1="${py(vdrv)}" y2="${py(vdrv)}"/><text class="lvt" x="${m.l + 6}" y="${py(vdrv) - 5}">driver ${esc(raw.vdrv)} V</text>`);
    o.push(`<line class="lvl" x1="${m.l}" x2="${px(qgs + qgd)}" y1="${py(vpl)}" y2="${py(vpl)}"/>`);
    // the curve
    const pts = [[0, 0], [q1, vth], [qgs, vpl], [qgs + qgd, vpl], [qg, vdrv]];
    o.push(`<polyline class="curve" points="${pts.map(([q, v]) => `${px(q).toFixed(1)},${py(v).toFixed(1)}`).join(' ')}"/>`);
    o.push(`<polyline class="curve hot-i" points="${px(q1)},${py(vth)} ${px(qgs)},${py(vpl)}"/><polyline class="curve hot-v" points="${px(qgs)},${py(vpl)} ${px(qgs + qgd)},${py(vpl)}"/>`);
    // plateau annotation: the gate current that pushes Qsw through
    const midP = (px(qgs) + px(qgs + qgd)) / 2;
    o.push(`<text class="ann" x="${midP}" y="${py(vpl) - 8}" text-anchor="middle">plateau ${sig(vpl, 3)} V</text>`);
    // ruler of charge phases under the axis
    const yR = yAx + 40;
    const seg = (a, b, cls, label) => {
      const w = px(b) - px(a);
      o.push(`<rect class="rs ${cls}" x="${px(a)}" y="${yR}" width="${Math.max(0.5, w)}" height="10"/>`);
      if (w > label.length * 6.2 + 4) o.push(`<text class="rt" x="${(px(a) + px(b)) / 2}" y="${yR + 22}" text-anchor="middle">${label}</text>`);
    };
    seg(0, q1, 'r0', 'Qgs1');
    seg(q1, qgs, 'ri', 'Qgs2');
    seg(qgs, qgs + qgd, 'rv', 'Qgd');
    seg(qgs + qgd, Math.max(qg, qgs + qgd), 'r0', 'to Qg');
    // Qsw brace with the times it gives
    const b0 = px(q1), b1 = px(qgs + qgd), yb = yR - 5;
    o.push(`<path class="brace" d="M${b0} ${yb + 3}V${yb}H${b1}V${yb + 3}"/>`);
    const qswTxt = `Qsw ${sig(d.qsw * 1e9, 3)} nC → on ${E(d.tOn, 's')} · off ${E(d.tOff, 's')}`;
    const qx = clamp((b0 + b1) / 2, 4 + qswTxt.length * 3.3, Wp - m.r - qswTxt.length * 3.3);
    o.push(`<text class="ann" x="${qx}" y="${yR - 9}" text-anchor="middle">${esc(qswTxt)}</text>`);
    // warning on the plateau when drive is close to it
    if (d.vdrv < d.vpl + 3) o.push(wmark(px(qg) - 14, py(vdrv) + 14, warnAbout(/above the plateau/)));
    if (d.tFull > 0.5 * d.minOn && d.D > 0 && d.D < 1) o.push(wmark(px(qg) + 12, py(vdrv) - 12, warnAbout(/whole gate/)));
    // handles
    const dot = (x, y, r = 6) => `<circle class="hit" cx="${x}" cy="${y}" r="14"/><circle class="ring" cx="${x}" cy="${y}" r="10"/><circle class="grip" cx="${x}" cy="${y}" r="${r}"/>`;
    const vthLen = Math.min(px(q1) + 14, Wp - m.r - 90);
    o.push(handle('vth', 'ns', 'Gate threshold VGS(th), V', raw.vth,
      `<rect class="hit" x="${m.l}" y="${py(vth) - 7}" width="${vthLen - m.l + 84}" height="14"/><line class="lvl vthl" x1="${m.l}" x2="${vthLen}" y1="${py(vth)}" y2="${py(vth)}"/><rect class="ring" x="${vthLen + 2}" y="${py(vth) - 10}" width="76" height="20" rx="3"/><rect class="vtbox" x="${vthLen + 5}" y="${py(vth) - 7}" width="70" height="14" rx="2"/><text class="lvt vtt" x="${vthLen + 10}" y="${py(vth) + 4}">Vth ${esc(sig(vth, 3))} V ↕</text>`));
    o.push(handle('knee', 'xy', 'Plateau knee: Qgs (nC) and plateau voltage (V)', `${raw.qgs} nC, ${raw.vpl} V`, dot(px(qgs), py(vpl))));
    o.push(handle('pend', 'ew', 'Plateau end: Qgd, nC', raw.qgd, dot(px(qgs + qgd), py(vpl))));
    o.push(handle('end', 'xy', 'End point: total gate charge Qg (nC) at the driver supply (V)', `${raw.qg} nC, ${raw.vdrv} V`, dot(px(qg), py(vdrv), 6.5)));
    // corner labels
    o.push(`<text class="ann" x="${px(qgs) - 8}" y="${py(vpl) + 16}" text-anchor="end">Qgs ${esc(raw.qgs)}</text>`);
    o.push(`<text class="ann" x="${px(qgs + qgd) + 10}" y="${py(vpl) + 16}">Qgd ${esc(raw.qgd)}</text>`);
    o.push(`<text class="ann" x="${px(qg) - 10}" y="${py(vdrv) + 18}" text-anchor="end">Qg ${esc(raw.qg)} nC</text>`);
    keepFocus(qsv, () => { qsv.innerHTML = o.join(''); });
    geo.qg = { px, py, A, m, Wp, Hp };
    void inp;
  }

  // ================= switching edges =================
  function drawEdges() {
    const d = D();
    const Wp = Math.max(280, edBox.clientWidth), Hp = Math.max(240, edBox.clientHeight);
    esv.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    if (!d) { esv.innerHTML = ''; return; }
    const narrow = Wp < 560;
    const gap = 18, lab = narrow ? 34 : 46;
    const paneW = narrow ? Wp - lab - 10 : (Wp - lab - gap - 10) / 2;
    const span = Math.max(d.tOn, d.tOff) * 1.55;
    const pre = span * 0.18;
    const kx = paneW / span; // px per second, the same in both panes
    const o = [];
    // rows
    const top = 26, bottom = narrow ? 44 : 30;
    const rowsH = narrow ? (Hp - top - bottom - 20) / 2 : Hp - top - bottom;
    const rH = [0.34, 0.36, 0.30].map((f) => f * rowsH);
    const panes = narrow
      ? [{ x0: lab, y0: top, on: true }, { x0: lab, y0: top + rowsH + 20 + 12, on: false }]
      : [{ x0: lab, y0: top, on: true }, { x0: lab + paneW + gap, y0: top, on: false }];
    const fastest = d.tOn <= d.tOff;
    for (const P of panes) {
      const on = P.on;
      const X = (t) => P.x0 + (t + pre) * kx;
      const tEnd = on ? d.tOn : d.tOff;
      const tA = on ? d.tOnI : d.tOffV; // first phase ends
      const yV0 = P.y0, yV1 = yV0 + rH[0] - 8;           // VGS row
      const yW0 = yV1 + 8, yW1 = yW0 + rH[1] - 8;         // VDS / ID row
      const yP0 = yW1 + 8, yP1 = yP0 + rH[2] - 6;         // P row
      const vg = (v) => yV1 - (v / Math.max(d.vdrv, 1e-9)) * (yV1 - yV0 - 4);
      const vv = (v) => yW1 - (v / d.vbus) * (yW1 - yW0 - 6);
      const ii = (i) => yW1 - (i / d.id) * (yW1 - yW0 - 6);
      const pMax = d.vbus * d.id / 4;
      const pp = (p) => yP1 - (p / pMax) * (yP1 - yP0 - 4) / 4 * 4 / 1; // scale to vbus*id/4 = top? keep peak visible
      void pp;
      const pk = (p) => yP1 - (p / (d.vbus * d.id)) * (yP1 - yP0 - 4);
      const xL = P.x0, xR = P.x0 + paneW;
      // phase tints
      o.push(`<rect class="${on ? 'band-i' : 'band-v'}" x="${X(0)}" y="${yV0}" width="${X(tA) - X(0)}" height="${yP1 - yV0}"/>`);
      o.push(`<rect class="${on ? 'band-v' : 'band-i'}" x="${X(tA)}" y="${yV0}" width="${X(tEnd) - X(tA)}" height="${yP1 - yV0}"/>`);
      // row frames
      for (const [a, b] of [[yV0, yV1], [yW0, yW1], [yP0, yP1]]) o.push(`<line class="base" x1="${xL}" x2="${xR}" y1="${b}" y2="${b}"/>`);
      o.push(`<text class="pane" x="${xL}" y="${P.y0 - 10}">${on ? 'Turn-on' : 'Turn-off'} <tspan class="mono">${esc(E(tEnd, 's'))}</tspan>${(on ? fastest : !fastest) ? `<tspan class="soft">  · dv/dt ${esc(sig(d.dvdt / 1e9, 3))} V/ns</tspan>` : ''}</text>`);
      if (P === panes[0] || narrow) {
        o.push(`<text class="rowl vgs" x="${xL - 6}" y="${(yV0 + yV1) / 2 + 4}" text-anchor="end">VGS</text>`);
        o.push(`<text class="rowl vds" x="${xL - 6}" y="${(yW0 + yW1) / 2 - 2}" text-anchor="end">VDS</text><text class="rowl id" x="${xL - 6}" y="${(yW0 + yW1) / 2 + 11}" text-anchor="end">ID</text>`);
        o.push(`<text class="rowl loss" x="${xL - 6}" y="${(yP0 + yP1) / 2 + 4}" text-anchor="end">V·I</text>`);
      }
      // threshold and plateau guides
      o.push(`<line class="guide" x1="${xL}" x2="${xR}" y1="${vg(d.vth)}" y2="${vg(d.vth)}"/><line class="guide" x1="${xL}" x2="${xR}" y1="${vg(d.vpl)}" y2="${vg(d.vpl)}"/>`);
      if (on) o.push(`<text class="gl" x="${xR - 2}" y="${vg(d.vpl) - 3}" text-anchor="end">plateau</text><text class="gl" x="${xR - 2}" y="${vg(d.vth) + 11}" text-anchor="end">Vth</text>`);
      // VGS: modelled part solid, before and after dashed
      const tRest = Math.max(0, d.qg - d.qgs - d.qgd) / (on ? d.igOn : d.igOff);
      const tMax = span - pre;
      if (on) {
        o.push(`<path class="w vgs dash" d="M${X(-pre)} ${vg(0)}Q${X(-pre * 0.3)} ${vg(0)} ${X(0)} ${vg(d.vth)}"/>`);
        o.push(`<path class="w vgs" d="M${X(0)} ${vg(d.vth)}L${X(tA)} ${vg(d.vpl)}L${X(tEnd)} ${vg(d.vpl)}"/>`);
        o.push(`<path class="w vgs dash" d="M${X(tEnd)} ${vg(d.vpl)}L${X(Math.min(tMax, tEnd + tRest))} ${vg(d.vpl + (d.vdrv - d.vpl) * Math.min(1, (tMax - tEnd) / Math.max(tRest, 1e-15)))}${tEnd + tRest < tMax ? `H${X(tMax)}` : ''}"/>`);
        o.push(`<path class="w id" d="M${X(-pre)} ${ii(0)}H${X(0)}L${X(tA)} ${ii(d.id)}H${X(tMax)}"/>`);
        o.push(`<path class="w vds" d="M${X(-pre)} ${vv(d.vbus)}H${X(tA)}L${X(tEnd)} ${vv(0)}H${X(tMax)}"/>`);
        o.push(`<path class="pw" d="M${X(0)} ${pk(0)}L${X(tA)} ${pk(d.vbus * d.id)}L${X(tEnd)} ${pk(0)}Z"/>`);
      } else {
        o.push(`<path class="w vgs dash" d="M${X(-pre)} ${vg(d.vdrv)}Q${X(-pre * 0.3)} ${vg(d.vpl)} ${X(0)} ${vg(d.vpl)}"/>`);
        o.push(`<path class="w vgs" d="M${X(0)} ${vg(d.vpl)}L${X(tA)} ${vg(d.vpl)}L${X(tEnd)} ${vg(d.vth)}"/>`);
        o.push(`<path class="w vgs dash" d="M${X(tEnd)} ${vg(d.vth)}Q${X(tEnd + (tMax - tEnd) * 0.4)} ${vg(0)} ${X(tMax)} ${vg(0)}"/>`);
        o.push(`<path class="w vds" d="M${X(-pre)} ${vv(0)}H${X(0)}L${X(tA)} ${vv(d.vbus)}H${X(tMax)}"/>`);
        o.push(`<path class="w id" d="M${X(-pre)} ${ii(d.id)}H${X(tA)}L${X(tEnd)} ${ii(0)}H${X(tMax)}"/>`);
        o.push(`<path class="pw" d="M${X(0)} ${pk(0)}L${X(tA)} ${pk(d.vbus * d.id)}L${X(tEnd)} ${pk(0)}Z"/>`);
      }
      // energy per edge and its loss at f
      const eTxt = `${E(on ? d.eOn : d.eOff, 'J')} → ${E(on ? d.pSwOn : d.pSwOff, 'W')}`;
      const ex = Math.min(X(tEnd) + 6, xR - eTxt.length * 6.4);
      o.push(`<text class="etxt halo" x="${ex}" y="${yP1 - 6}">${esc(eTxt)}</text>`);
      // value tags
      if (on) {
        o.push(`<text class="vt vds halo" x="${X(-pre) + 2}" y="${vv(d.vbus) - 4}">${esc(sig(d.vbus, 3))} V</text>`);
        o.push(`<text class="vt id halo" x="${xR - 2}" y="${ii(d.id) - 4}" text-anchor="end">${esc(sig(d.id, 3))} A</text>`);
      }
      // gate current during the plateau
      o.push(`<text class="vt vgs halo" x="${X(tA) + 3}" y="${vg(d.vpl) - 5}">${on ? '+' : '−'}${esc(E(on ? d.igOn : d.igOff, 'A'))}</text>`);
      // the other switch's gate, lifted through Crss during this edge's dv/dt
      if (on && d.vInd != null) {
        const bad = d.vInd > 0.8 * d.vth;
        const yb = vg(d.vInd);
        o.push(`<path class="w other${bad ? ' bad' : ''}" d="M${X(-pre)} ${vg(0)}H${X(tA)}L${X(tA) + Math.min(6, (X(tEnd) - X(tA)) / 3)} ${yb}H${X(tEnd) - Math.min(6, (X(tEnd) - X(tA)) / 3)}L${X(tEnd)} ${vg(0)}H${X(tMax)}"/>`);
        o.push(`<text class="vt other halo" x="${X(tEnd) + 4}" y="${Math.min(yb, vg(0) - 10) + 2}">other gate +${esc(sig(d.vInd, 3))} V</text>`);
        if (bad) o.push(wmark(X((tA + tEnd) / 2), yb - 12, warnAbout(/Miller/)));
      }
      // time brackets
      const yT = yP1 + 12;
      o.push(`<path class="dim" d="M${X(0)} ${yT - 4}V${yT + 4}M${X(0)} ${yT}H${X(tEnd)}M${X(tEnd)} ${yT - 4}V${yT + 4}M${X(tA)} ${yT - 3}V${yT + 3}"/>`);
      o.push(`<text class="tick" x="${X(tEnd) + 4}" y="${yT + 4}">${esc(E(tEnd, 's'))}</text>`);
      const tPh1 = on ? 'I rises' : 'V rises', tPh2 = on ? 'V falls' : 'I falls';
      if (X(tA) - X(0) > 44) o.push(`<text class="ph" x="${(X(0) + X(tA)) / 2}" y="${yV0 + 10}" text-anchor="middle">${tPh1}</text>`);
      if (X(tEnd) - X(tA) > 44) o.push(`<text class="ph" x="${(X(tA) + X(tEnd)) / 2}" y="${yV0 + 10}" text-anchor="middle">${tPh2}</text>`);
      if (d.share > 0.1 && on) o.push(wmark(X(tEnd) + 12, yW0 + 10, warnAbout(/edges take/)));
    }
    // scale bar
    const sb = niceStep(span, 4), sbPx = sb * kx;
    o.push(`<path class="scale" d="M${Wp - 12 - sbPx} ${Hp - 8}h${sbPx}M${Wp - 12 - sbPx} ${Hp - 12}v8M${Wp - 12} ${Hp - 12}v8"/><text class="tick" x="${Wp - 16 - sbPx}" y="${Hp - 5}" text-anchor="end">${esc(E(sb, 's'))}</text>`);
    o.push(`<text class="gl" x="${lab}" y="${Hp - 5}">dashed: delay and gate charging beyond the model</text>`);
    esv.innerHTML = o.join('');
  }

  // ================= period and frequency =================
  function drawPeriod() {
    const d = D(), raw = ctx.raw;
    const Wp = Math.max(280, peBox.clientWidth), Hp = Math.max(150, peBox.clientHeight);
    psv.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    if (!d) { psv.innerHTML = ''; return; }
    const narrow = Wp < 520;
    const o = [];
    // --- the period ---
    const pW = narrow ? Wp - 20 : Wp * 0.52 - 20, x0 = 12, x1 = x0 + pW;
    const pH = narrow ? Math.min(92, Hp * 0.42) : Hp - 50;
    const yHi = 30, yLo = yHi + Math.max(40, pH - 30);
    const X = (t) => x0 + (t / d.T) * pW;
    const tr = Math.max(1.5, X(d.tOn) - x0), tf = Math.max(1.5, X(d.tOff) - x0);
    const xOff = X(d.D * d.T);
    o.push(`<rect class="per-bg" x="${x0}" y="${yHi}" width="${pW}" height="${yLo - yHi}"/>`);
    o.push(`<path class="w vgs" d="M${x0} ${yLo}L${x0 + tr} ${yHi}H${xOff}L${xOff + tf} ${yLo}H${x1}"/>`);
    o.push(`<rect class="edgebar" x="${x0}" y="${yHi}" width="${tr}" height="${yLo - yHi}"/><rect class="edgebar" x="${xOff}" y="${yHi}" width="${tf}" height="${yLo - yHi}"/>`);
    // gate fully charged marker
    const xFull = X(Math.min(d.tFull, d.T));
    const fullBad = d.tFull > 0.5 * d.minOn && d.D > 0 && d.D < 1;
    o.push(`<line class="full${fullBad ? ' bad' : ''}" x1="${xFull}" x2="${xFull}" y1="${yHi - 4}" y2="${yLo}"/>`);
    o.push(`<text class="gl${fullBad ? ' badt' : ''}" x="${xFull + 4}" y="${yHi + 12}">gate full ≈ ${esc(E(d.tFull, 's'))}</text>`);
    o.push(`<text class="ann" x="${x0}" y="${yHi - 10}">T ${esc(E(d.T, 's'))} · edges ${esc(sig(d.share * 100, 3))} % of the period</text>`);
    o.push(`<text class="gl" x="${(x0 + xOff) / 2}" y="${yLo - 8}" text-anchor="middle">on ${esc(sig(d.D * 100, 3))} %</text>`);
    if (fullBad) o.push(wmark(xFull + 10, yHi - 10, warnAbout(/whole gate/)));
    o.push(handle('duty', 'ew', 'Duty, % on time', raw.duty,
      `<rect class="hit" x="${xOff - 8}" y="${yHi - 6}" width="16" height="${yLo - yHi + 12}"/><rect class="ring" x="${xOff - 6}" y="${yHi - 4}" width="12" height="${yLo - yHi + 8}" rx="3"/><rect class="grip" x="${xOff - 1.5}" y="${yHi + (yLo - yHi) / 2 - 12}" width="3" height="24" rx="1.5"/>`));
    geo.per = { x0, pW };
    // --- loss against frequency ---
    const cL = narrow ? 44 : x1 + 64, cR = Wp - 14, cT = narrow ? yLo + 30 : 22, cB = Hp - 24;
    const sw = d.sweep;
    if (!drag || drag.svg !== psv || !fAxes) {
      const f0 = Math.min(sw[0].f, d.f), f1 = Math.max(sw[sw.length - 1].f, d.f);
      fAxes = { l0: Math.log10(f0), l1: Math.log10(f1), y1: niceCeil(Math.max(...sw.map((s) => s.total), d.pSw + d.pCond) * 1.05) };
    }
    const F = fAxes;
    const fx = (f) => cL + ((Math.log10(f) - F.l0) / (F.l1 - F.l0)) * (cR - cL);
    const fy = (p) => cB - (p / F.y1) * (cB - cT);
    const ysS = niceStep(F.y1, 3);
    for (let p = 0; p <= F.y1 + 1e-9; p += ysS) o.push(`<line class="grid" x1="${cL}" x2="${cR}" y1="${fy(p)}" y2="${fy(p)}"/><text class="tick" x="${cL - 5}" y="${fy(p) + 3.5}" text-anchor="end">${esc(sig(p, 3))}</text>`);
    for (const s of sw) o.push(`<text class="tick" x="${fx(s.f)}" y="${cB + 13}" text-anchor="middle">${esc(E(s.f, '').replace(' ', ''))}</text>`);
    o.push(`<text class="tick" x="${cL - 5}" y="${cT - 8}" text-anchor="end">W</text>`);
    const line = (key, cls) => `<polyline class="fl ${cls}" points="${sw.map((s) => `${fx(s.f).toFixed(1)},${fy(s[key]).toFixed(1)}`).join(' ')}"/>`;
    o.push(line('cond', 'cond'), line('sw', 'sw'), line('total', 'tot'));
    const xf = fx(d.f), tot = d.pSw + d.pCond;
    o.push(`<text class="lg tot" x="${cL + 8}" y="${cT + 4}">total</text><text class="lg sw" x="${cL + 48}" y="${cT + 4}">switching</text><text class="lg cond" x="${cL + 122}" y="${cT + 4}">conduction</text>`);
    const tag = `${E(d.f, 'Hz')} · ${E(tot, 'W')}`;
    const right = xf < cR - tag.length * 6.6 - 14;
    o.push(handle('f', 'ew', 'Switching frequency, Hz', raw.f,
      `<rect class="hit" x="${xf - 9}" y="${cT}" width="18" height="${cB - cT}"/><line class="fline" x1="${xf}" x2="${xf}" y1="${cT}" y2="${cB}"/><circle class="ring" cx="${xf}" cy="${fy(tot)}" r="10"/><circle class="grip dotp" cx="${xf}" cy="${fy(tot)}" r="5.5"/><text class="ftag halo" x="${xf + (right ? 9 : -9)}" y="${Math.max(cT + 10, fy(tot) - 9)}" text-anchor="${right ? 'start' : 'end'}">${esc(tag)}</text>`));
    geo.f = { fx, cL, cR, F };
    keepFocus(psv, () => { psv.innerHTML = o.join(''); });
  }

  // ================= side: losses =================
  function drawLoss() {
    const res = ctx.result || {}, d = D();
    const vals = res.values || [];
    const by = (re) => vals.find((v) => re.test(v.label));
    if (!ctx.result?.drawing) { loss.innerHTML = '<div class="mg-lab">Loss in this MOSFET</div><div class="mg-big">–</div>'; }
    else {
      const tot = by(/^Total MOSFET loss/), sw = by(/^Switching loss/), cond = by(/^Conduction loss/), gate = by(/^Gate drive power/);
      const parts = [['on', d.pSwOn, 'turn-on edge'], ['off', d.pSwOff, 'turn-off edge'], ['cond', d.pCond, 'conduction']];
      const sum = parts.reduce((a, p) => a + p[1], 0) || 1;
      const bar = parts.map(([k, v, t]) => `<i class="lb-${k}" style="width:${(v / sum) * 100}%" title="${esc(t)} ${esc(E(v, 'W'))}"></i>`).join('');
      const row = (lab, v, cls = '') => (v ? `<dt>${lab}</dt><dd class="${cls}">${esc(v.value)}${v.unit ? ` ${esc(v.unit)}` : ''}${v.hint ? `<small>${esc(v.hint)}</small>` : ''}</dd>` : '');
      const tone = (v) => (v?.tone ? `t-${v.tone}` : '');
      loss.innerHTML = `<div class="mg-lab">Loss in this MOSFET</div>`
        + `<div class="mg-big">${esc(tot?.value || '–')}</div>`
        + `<div class="mg-bar">${bar}</div>`
        + `<div class="mg-leg"><span><i class="lb-on"></i>on ${esc(E(d.pSwOn, 'W'))}</span><span><i class="lb-off"></i>off ${esc(E(d.pSwOff, 'W'))}</span><span><i class="lb-cond"></i>cond. ${esc(cond?.value || '–')}</span></div>`
        + `<dl class="mg-dl">${row('Switching', sw, tone(sw))}${row('Edges / period', by(/^Edges share/), tone(by(/^Edges share/)))}`
        + `${row('Gate drive', gate)}${row('Driver avg. current', by(/^Driver average/))}${row('dv/dt', by(/^dv\/dt/))}${row('Miller VGS', by(/^Miller/), tone(by(/^Miller/)))}</dl>`;
    }
    warnsEl.replaceChildren(...(res.warnings || []).map((w) => el('div', {}, esc(w))));
    notesEl.replaceChildren(el('summary', {}, `Model and limits (${(res.notes || []).length} notes)`), ...(res.notes || []).map((n) => el('div', {}, esc(n))));
  }

  // ================= interaction =================
  function start(svg, e) {
    const h = e.target.closest('[data-h]');
    if (!h || e.button > 0) return;
    e.preventDefault();
    const pt = toSvg(svg, e);
    drag = { svg, h: h.dataset.h, pt0: pt, x0: e.clientX, inp: ctx.input, sc: svg.viewBox.baseVal.width / svg.getBoundingClientRect().width };
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    h.focus({ preventScroll: true });
    h.classList.add('on');
  }
  function move(svg, e) {
    if (!drag || drag.svg !== svg) return;
    const pt = toSvg(svg, e), i = drag.inp;
    const k = drag.h;
    if (SPEC[k] && svg === sch) { // scrub
      const v = scrubValue(k, i[k], e.clientX - drag.x0);
      setSoon({ [k]: asInput(k, v) });
      return;
    }
    if (svg === qsv && geo.qg) {
      const { A, m, Wp, Hp } = geo.qg;
      const q = clamp(((pt.x - m.l) / (Wp - m.l - m.r)) * A.x1, 0, A.x1);
      const v = clamp((1 - (pt.y - m.t) / (Hp - m.t - m.b)) * A.y1, 0, A.y1);
      const r1 = (x) => sig(Math.round(x * 10) / 10, 4);
      const r2 = (x) => sig(Math.round(x * 20) / 20, 4);
      if (k === 'knee') {
        const qgs = clamp(q, 0.5, Math.max(0.5, i.qg - i.qgd - 0.5));
        const vpl = clamp(v, Math.max(0.5, (i.vth || 0) + 0.2), i.vdrv - 0.3);
        setSoon({ qgs: r1(qgs), vpl: r2(vpl) });
      } else if (k === 'pend') {
        setSoon({ qgd: r1(clamp(q - i.qgs, 0.5, Math.max(0.5, i.qg - i.qgs - 0.2))) });
      } else if (k === 'end') {
        setSoon({ qg: r1(Math.max(q, (i.qgs || 0) + i.qgd + 0.2)), vdrv: sig(clamp(Math.round(v * 2) / 2, i.vpl + 0.5, 30), 3) });
      } else if (k === 'vth') {
        setSoon({ vth: r2(clamp(v, 0.2, i.vpl - 0.1)) });
      }
      return;
    }
    if (svg === psv) {
      if (k === 'duty' && geo.per) {
        const du = clamp(Math.round(((pt.x - geo.per.x0) / geo.per.pW) * 100), 1, 99);
        setSoon({ duty: String(du) });
      } else if (k === 'f' && geo.f) {
        const { cL, cR, F } = geo.f;
        const lf = F.l0 + ((clamp(pt.x, cL, cR) - cL) / (cR - cL)) * (F.l1 - F.l0);
        setSoon({ f: engIn(Number((10 ** lf).toPrecision(2))) });
      }
    }
  }
  function end() {
    if (!drag) return;
    drag = null;
    requestAnimationFrame(drawAll);
  }
  for (const s of [sch, qsv, psv]) {
    s.addEventListener('pointerdown', (e) => start(s, e));
    s.addEventListener('pointermove', (e) => move(s, e));
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('keydown', (e) => onKey(e));
  }
  function onKey(e) {
    const h = e.target.closest?.('[data-h]');
    if (!h) return;
    const map = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0], PageUp: [0, 1], PageDown: [0, -1] };
    const mv = map[e.key];
    if (!mv) return;
    e.preventDefault();
    const big = e.shiftKey || e.key.startsWith('Page');
    const i = ctx.input, k = h.dataset.h;
    const [dx, dy] = mv, dir = dx || dy;
    const n = big ? 5 : 1;
    const q = (x) => sig(Math.max(0.1, Math.round(x * 10) / 10), 4);
    if (SPEC[k]) {
      if (k === 'f') ctx.set('f', engIn(stepValue('f', i.f, dir, big)));
      else ctx.set(k, asInput(k, stepValue(k, i[k] || 0, dir, big)));
    } else if (k === 'knee') {
      if (dx) ctx.set('qgs', q(clamp(i.qgs + dx * 0.5 * n, 0.5, i.qg - i.qgd - 0.5)));
      else ctx.set('vpl', sig(clamp(i.vpl + dy * 0.1 * n, (i.vth || 0) + 0.2, i.vdrv - 0.3), 3));
    } else if (k === 'pend') ctx.set('qgd', q(clamp(i.qgd + dir * 0.5 * n, 0.5, i.qg - i.qgs - 0.2)));
    else if (k === 'end') {
      if (dx) ctx.set('qg', q(Math.max(i.qg + dx * n, i.qgs + i.qgd + 0.2)));
      else ctx.set('vdrv', sig(clamp(i.vdrv + dy * 0.5 * n, i.vpl + 0.5, 30), 3));
    } else if (k === 'vth') ctx.set('vth', sig(clamp(i.vth + dir * 0.1 * n, 0.2, i.vpl - 0.1), 3));
    else if (k === 'duty') ctx.set('duty', String(clamp(Math.round(i.duty + dir * n), 1, 99)));
  }

  function drawAll() {
    const d = ctx.result?.drawing;
    if (d) lastGood = d;
    grid.classList.toggle('stale', !d && !!lastGood);
    if (!d && !lastGood) all.open = true;
    drawSch(); drawQg(); drawEdges(); drawPeriod(); drawLoss();
  }
  ctx.onResult(drawAll);
  new ResizeObserver(() => { if (!drag) drawAll(); }).observe(grid);
}
