// Stackup: layer order, board thickness, and the trace widths each signal layer
// needs for its impedance targets.
//
//   Thickness     sum of every row (copper, prepreg after pressing, core, mask)
//   Reference     the nearest Plane/Mixed copper above and below a signal layer;
//                 H = everything between them, Er = thickness-weighted mean of
//                 the dielectrics in between
//   Impedance     Hammerstad-Jensen microstrip (IEEE MTT-S 1980), Wheeler
//                 stripline (Wadell 3.5.1), offset stripline as two in parallel
//                 (Wadell 3.5.3), pairs after National AN-905 - the same closed
//                 forms as the impedance-calc tool
//   Plane pair    C = ε0 εr A / d
import { fmtNum, parseEng } from '../kit/eng.js';

const ETA0 = 376.730313; // impedance of free space, ohm

const coth = (x) => 1 / Math.tanh(x);

/** Hammerstad-Jensen microstrip. All lengths in one unit. Returns {z, eeff}. */
function microstrip(w, h, t, er) {
  const u = w / h, tn = t / h;
  let du1 = 0, dur = 0;
  if (tn > 0) {
    // H&J eq. (thickness): widen the strip by du1 (in air) and dur (on the dielectric)
    du1 = (tn / Math.PI) * Math.log(1 + (4 * Math.E) / (tn * coth(Math.sqrt(6.517 * u)) ** 2));
    dur = 0.5 * (1 + 1 / Math.cosh(Math.sqrt(Math.max(0, er - 1)))) * du1;
  }
  const u1 = u + du1, ur = u + dur;
  // Z01: the strip in air
  const z01 = (x) => {
    const f = 6 + (2 * Math.PI - 6) * Math.exp(-Math.pow(30.666 / x, 0.7528));
    return (ETA0 / (2 * Math.PI)) * Math.log(f / x + Math.sqrt(1 + 4 / (x * x)));
  };
  // effective permittivity of the zero-thickness strip
  const b = 0.564 * Math.pow((er - 0.9) / (er + 3), 0.053);
  const ee = (x) => {
    const a = 1 + Math.log((x ** 4 + (x / 52) ** 2) / (x ** 4 + 0.432)) / 49 + Math.log(1 + (x / 18.1) ** 3) / 18.7;
    return (er + 1) / 2 + ((er - 1) / 2) * Math.pow(1 + 10 / x, -a * b);
  };
  const z = z01(ur) / Math.sqrt(ee(ur));
  const eeff = ee(ur) * (z01(u1) / z01(ur)) ** 2;
  return { z, eeff };
}

/** Wheeler symmetric stripline: strip of width w, thickness t, centred between planes b apart. */
function striplineSym(w, b, t, er) {
  const x = t / b;
  let dw = 0; // ΔW/(b-t)
  if (x > 0) {
    const m = 2 / (1 + ((2 / 3) * x) / (1 - x));
    dw = (x / (Math.PI * (1 - x))) * (1 - 0.5 * Math.log((x / (2 - x)) ** 2 + ((0.0796 * x) / (w / b + 1.1 * x)) ** m));
  }
  const k = 1 / (w / (b - t) + dw); // (b-t)/W'
  const p = (8 / Math.PI) * k;
  return (30 / Math.sqrt(er)) * Math.log(1 + (4 / Math.PI) * k * (p + Math.sqrt(p * p + 6.27)));
}

/** Stripline with H1 below and H2 above the strip (dielectric between strip and each plane). */
function stripline(w, h1, h2, t, er) {
  const z1 = striplineSym(w, 2 * h1 + t, t, er);
  if (Math.abs(h1 - h2) < 1e-12) return z1;
  const z2 = striplineSym(w, 2 * h2 + t, t, er);
  return (2 * z1 * z2) / (z1 + z2);
}

/** One line of the chosen kind: {z (single), zd (pair or null), eeff}. */
function line(kind, g) {
  const { w, s, h, h2, t, er } = g;
  if (kind === 'microstrip' || kind === 'diff-microstrip') {
    const { z, eeff } = microstrip(w, h, t, er);
    const zd = kind === 'diff-microstrip' ? 2 * z * (1 - 0.48 * Math.exp((-0.96 * s) / h)) : null;
    return { z, zd, eeff };
  }
  const z = stripline(w, h, h2, t, er);
  const b = h + h2 + t;
  const zd = kind === 'diff-stripline' ? 2 * z * (1 - 0.347 * Math.exp((-2.9 * s) / b)) : null;
  return { z, zd, eeff: er };
}

/** Width that gives the target impedance (single or differential), by bisection on log W. */
function solveWidth(kind, g, target, diff) {
  const f = (w) => { const r = line(kind, { ...g, w }); return diff ? r.zd : r.z; };
  let lo = g.h * 0.005, hi = g.h * 60;
  if (!(f(lo) > target && f(hi) < target)) return null;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (f(mid) > target) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}


const KIND = { signal: 'Signal', plane: 'Plane', mixed: 'Mixed', prepreg: 'Prepreg', core: 'Core', mask: 'Mask' };
const isCu = (k) => k === 'signal' || k === 'plane' || k === 'mixed';
const isRef = (k) => k === 'plane' || k === 'mixed';
const isDiel = (k) => k === 'prepreg' || k === 'core';
const OZ = 34.8; // µm of copper per oz/ft²

function norm(rows, warnings) {
  const out = [];
  (rows || []).forEach((r, i) => {
    const kind = String(r.kind || '').toLowerCase();
    if (!KIND[kind]) { warnings.push(`Row ${i + 1}: unknown kind "${r.kind}", skipped. Use Signal, Plane, Mixed, Prepreg, Core or Mask.`); return; }
    const t = parseEng(r.t);
    if (!(t > 0)) { warnings.push(`Row ${i + 1} (${KIND[kind]}): thickness "${r.t ?? ''}" is not a positive number in µm, skipped.`); return; }
    let er = parseEng(r.er);
    if (isDiel(kind) || kind === 'mask') {
      if (!(er >= 1)) { er = kind === 'mask' ? 3.8 : 4.3; warnings.push(`Row ${i + 1} (${KIND[kind]}): no valid Er, ${er} used.`); }
    } else er = null;
    out.push({ kind, t, er, src: i });
  });
  return out;
}

/** Distance (µm) and averaged Er from copper row i to the nearest reference plane in direction dir. */
function reference(rows, i, dir) {
  let h = 0, erT = 0, dT = 0;
  for (let j = i + dir; j >= 0 && j < rows.length; j += dir) {
    const r = rows[j];
    if (isRef(r.kind)) return dT > 0 ? { h, er: erT / dT, j } : null;
    if (r.kind === 'mask') return null;
    h += r.t;
    if (isDiel(r.kind)) { erT += r.er * r.t; dT += r.t; }
  }
  return null;
}

export function run({ layers, target, tol, zse, zdiff, gap, minw }) {
  const warnings = [];
  const rows = norm(layers, warnings);
  if (!rows.some((r) => isCu(r.kind))) return { warnings: [...warnings, 'Add at least one copper layer (Signal, Plane or Mixed), with dielectric rows (Prepreg, Core) between them.'] };
  const total = rows.reduce((a, r) => a + r.t, 0) / 1000; // mm
  const nCu = rows.filter((r) => isCu(r.kind)).length;
  const g = gap > 0 ? gap : 0.15;
  const tolPct = tol > 0 ? tol : 10;

  // structural checks
  for (let i = 1; i < rows.length; i++) {
    if (isCu(rows[i].kind) && isCu(rows[i - 1].kind)) warnings.push(`Rows ${i} and ${i + 1} are two copper layers with no dielectric between: add a prepreg or core.`);
    if (isDiel(rows[i].kind) && isDiel(rows[i - 1].kind) && rows[i].kind === 'core' && rows[i - 1].kind === 'core') warnings.push(`Rows ${i} and ${i + 1}: two cores need prepreg between them to bond.`);
  }
  const firstCu = rows.findIndex((r) => isCu(r.kind));
  const lastCu = rows.length - 1 - [...rows].reverse().findIndex((r) => isCu(r.kind));
  rows.forEach((r, i) => { if (isDiel(r.kind) && (i < firstCu || i > lastCu)) warnings.push(`Row ${i + 1}: a ${KIND[r.kind].toLowerCase()} outside the outer copper; only solder mask belongs there.`); });
  if (nCu > 2 && nCu % 2) warnings.push(`${nCu} copper layers: odd counts are built (and priced) as ${nCu + 1}, and warp more; use ${nCu + 1}.`);

  // symmetry about the centre (bow and twist)
  const cu = rows.map((r, i) => ({ ...r, i })).filter((r) => r.kind !== 'mask');
  let sym = true;
  for (let a = 0, b = cu.length - 1; a < b; a++, b--) {
    const A = cu[a], B = cu[b];
    if (isCu(A.kind) !== isCu(B.kind) || Math.abs(A.t - B.t) > 0.1 * Math.max(A.t, B.t)) { sym = false; break; }
  }
  if (!sym) warnings.push('The stack is not mirror-symmetric about its centre (layer type or thickness differ): unbalanced copper and dielectric make the board bow and twist. Mirror it.');

  const tone = Math.abs(total - target) <= (target * tolPct) / 100 ? 'ok' : 'bad';
  if (target > 0 && tone === 'bad') warnings.push(`Board is ${fmtNum(total, 4)} mm, outside ${fmtNum(target, 3)} mm ± ${tolPct} %: ${total > target ? 'thin' : 'thicken'} the core or prepregs by about ${fmtNum(Math.abs(total - target) * 1000, 3)} µm in total.`);

  // copper layers: reference, structure, widths
  let n = 0;
  const cuRows = [];
  const layerOut = [];
  rows.forEach((r, i) => {
    if (!isCu(r.kind)) return;
    n += 1;
    const name = `L${n}`;
    const out = { name, row: i, kind: r.kind, t: r.t, structure: '–', h1: null, h2: null, er: null, wse: null, wdiff: null };
    layerOut.push(out);
    if (r.kind === 'plane') { out.structure = 'reference plane'; cuRows.push([name, KIND[r.kind], `${fmtNum(r.t, 3)} µm (${fmtNum(r.t / OZ, 2)} oz)`, 'reference', '–', '–', '–', '–']); return; }
    const up = reference(rows, i, -1), dn = reference(rows, i, +1);
    out.refUp = up ? up.j : null; out.refDn = dn ? dn.j : null;
    const outer = i === firstCu || i === lastCu;
    let kind = null, geo = null;
    const T = r.t / 1000;
    if (up && dn) {
      kind = 'stripline';
      const er = (up.er * up.h + dn.er * dn.h) / (up.h + dn.h);
      geo = { h: up.h / 1000, h2: dn.h / 1000, t: T, er, s: g };
      out.structure = Math.abs(up.h - dn.h) < 1 ? 'stripline' : 'offset stripline';
    } else if (up || dn) {
      const ref = up || dn;
      kind = 'microstrip';
      geo = { h: ref.h / 1000, h2: 0, t: T, er: ref.er, s: g };
      out.structure = outer ? 'microstrip' : 'embedded, one plane';
      if (!outer) warnings.push(`${name} is an inner layer with a plane on one side only: computed as a surface microstrip, so its real impedance is some 5-10 % lower. Put a plane on its other side.`);
    } else {
      out.structure = 'no reference';
      warnings.push(`${name} has no plane next to it: its impedance is not controlled. Make an adjacent layer a plane.`);
    }
    if (geo) {
      Object.assign(out, { h1: geo.h * 1000, h2: kind === 'stripline' ? geo.h2 * 1000 : null, er: geo.er });
      out.wse = zse > 0 ? solveWidth(kind, geo, zse, false) : null;
      out.wdiff = zdiff > 0 ? solveWidth(kind === 'stripline' ? 'diff-stripline' : 'diff-microstrip', geo, zdiff, true) : null;
      for (const [w, z] of [[out.wse, zse], [out.wdiff, zdiff]]) {
        if (!(z > 0)) continue;
        if (w == null) warnings.push(`${name}: no width reaches ${z} Ω with this dielectric; change its distance to the plane.`);
        else if (minw > 0 && w < minw) warnings.push(`${name}: ${fmtNum(w, 3)} mm for ${z} Ω is under the fab's ${fmtNum(minw, 3)} mm minimum trace: thicken its dielectric to the plane.`);
      }
    }
    const hTxt = geo ? (kind === 'stripline' ? `${fmtNum(out.h1, 3)} / ${fmtNum(out.h2, 3)}` : fmtNum(out.h1, 3)) : '–';
    cuRows.push([name, KIND[r.kind], `${fmtNum(r.t, 3)} µm (${fmtNum(r.t / OZ, 2)} oz)`, out.structure, hTxt, geo ? fmtNum(geo.er, 3) : '–',
      out.wse != null ? fmtNum(out.wse, 3) : '–', out.wdiff != null ? fmtNum(out.wdiff, 3) : '–']);
  });

  // adjacent plane pairs: buried capacitance C = ε0 εr / d
  const caps = [];
  const planePairs = [];
  for (let i = 0; i < rows.length; i++) {
    if (!isRef(rows[i].kind)) continue;
    const d = reference(rows, i, +1);
    if (d && rows.slice(i + 1, d.j).every((x) => isDiel(x.kind))) {
      const pfcm2 = (8.854e-12 * d.er * 1e-4) / (d.h * 1e-6) * 1e12;
      const a = layerOut.find((l) => l.row === i), b = layerOut.find((l) => l.row === d.j);
      planePairs.push({ a: i, b: d.j, d: Number(fmtNum(d.h, 4)), pfPerCm2: Number(fmtNum(pfcm2, 4)) });
      caps.push(`${a.name}-${b.name} plane pair: ${fmtNum(d.h, 3)} µm apart, ${fmtNum(pfcm2, 3)} pF/cm² of plane capacitance.`);
    }
  }
  const sig = layerOut.filter((l) => l.kind !== 'plane');
  for (let k = 1; k < sig.length; k++) {
    const a = sig[k - 1], b = sig[k];
    const between = rows.slice(a.row + 1, b.row);
    if (between.every((x) => !isCu(x.kind))) {
      const d = between.reduce((s, x) => s + x.t, 0);
      if (d > 0 && d < 300) warnings.push(`${a.name} and ${b.name} are signal layers only ${fmtNum(d, 3)} µm apart with no plane between: route them at right angles or they will crosstalk.`);
    }
  }

  const values = [
    { label: 'Board thickness', value: fmtNum(total, 4), unit: 'mm', tone: target > 0 ? tone : undefined, hint: target > 0 ? `target ${fmtNum(target, 3)} ± ${tolPct} %` : undefined },
    { label: 'Copper layers', value: nCu },
    { label: 'Symmetric', value: sym ? 'yes' : 'no', tone: sym ? 'ok' : 'warn' },
    { label: 'Signal layers with a reference', value: `${sig.filter((l) => l.h1 != null).length} of ${sig.length}` },
  ];
  const outer = layerOut.find((l) => l.wse != null);
  if (outer) values.push({ label: `${outer.name} width for ${fmtNum(zse, 3)} Ω`, value: fmtNum(outer.wse, 3), unit: 'mm', tone: 'ok' });

  let z = 0;
  const r4 = (v) => (v == null ? null : Number(fmtNum(v, 4)));
  const stack = rows.map((r) => { const o = { kind: r.kind, t: r.t, er: r.er, top: z, src: r.src }; z += r.t; return o; });
  layerOut.forEach((l) => { Object.assign(stack[l.row], { name: l.name, structure: l.structure, wse: r4(l.wse), wdiff: r4(l.wdiff), h1: r4(l.h1), h2: r4(l.h2), erRef: r4(l.er), refUp: l.refUp, refDn: l.refDn }); });
  // agents read this: no nulls, lengths in µm, widths in mm
  for (const r of stack) for (const k of Object.keys(r)) if (r[k] == null) delete r[k];
  return {
    values,
    warnings,
    tables: [
      { title: `Copper layers: widths for ${zse > 0 ? fmtNum(zse, 3) + ' Ω single' : '–'} and ${zdiff > 0 ? fmtNum(zdiff, 3) + ' Ω pairs' : '–'} (gap ${fmtNum(g, 3)} mm)`,
        columns: ['Layer', 'Type', 'Copper', 'Structure', 'H to plane µm', 'Er', 'Single mm', 'Pair mm'], rows: cuRows },
      { title: 'Stack, top to bottom', columns: ['#', 'Row', 'Thickness µm', 'Er', 'From top mm'],
        rows: stack.map((r, i) => [i + 1, r.name ? `${r.name} ${KIND[r.kind]}` : KIND[r.kind], fmtNum(r.t, 4), r.er ?? '–', fmtNum(r.top / 1000, 4)]) },
    ],
    stack,
    planePairs,
    notes: [
      ...caps,
      'Widths use Hammerstad-Jensen (microstrip) and Wheeler (stripline) with the thickness-weighted Er of the dielectric to the plane; pairs use the AN-905 coupling approximation (±5-10 %).',
      'Outer copper is usually 1/2 or 1 oz base plus ~20-25 µm plating; prepreg thickness is after pressing. Ask the fab for their standard stack and build to it.',
      'Solder mask rows count in the thickness, but surface microstrips are computed without mask (it lowers them by 1-3 Ω).',
    ],
  };
}
