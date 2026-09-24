// Characteristic impedance of PCB transmission lines.
//
//   Surface microstrip   Hammerstad & Jensen, "Accurate models for microstrip
//                        computer-aided design", IEEE MTT-S 1980 (with their
//                        finite-thickness correction). About 1 % against field
//                        solvers for 0.01 < W/H < 100.
//   Stripline            Wheeler, "Transmission-line properties of a strip on a
//                        dielectric sheet on a plane" / Wadell, Transmission Line
//                        Design Handbook (1991) eq. 3.5.1, finite thickness,
//                        about 0.5 % for W'/(b-t) < 10.
//   Offset stripline     two symmetric striplines of plane spacing 2*H1+T and
//                        2*H2+T in parallel: Z = 2 Z1 Z2 / (Z1 + Z2) (Wadell 3.5.3).
//   Edge-coupled pairs   National Semiconductor AN-905 (IPC-2141):
//                        microstrip Zdiff = 2 Z0 (1 - 0.48 exp(-0.96 S/H))
//                        stripline  Zdiff = 2 Z0 (1 - 0.347 exp(-2.9 S/b))
import { fmtNum } from '../kit/eng.js';

const ETA0 = 376.730313; // impedance of free space, ohm
const C_MM_PER_PS = 0.299792458; // speed of light, mm/ps
const MIL = 0.0254; // mm

const coth = (x) => 1 / Math.tanh(x);

/** Hammerstad-Jensen microstrip. All lengths in one unit. Returns {z, eeff}. */
export function microstrip(w, h, t, er) {
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
export function striplineSym(w, b, t, er) {
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
export function stripline(w, h1, h2, t, er) {
  const z1 = striplineSym(w, 2 * h1 + t, t, er);
  if (Math.abs(h1 - h2) < 1e-12) return z1;
  const z2 = striplineSym(w, 2 * h2 + t, t, er);
  return (2 * z1 * z2) / (z1 + z2);
}

/** One line of the chosen kind: {z (single), zd (pair or null), eeff}. */
export function line(kind, g) {
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
export function solveWidth(kind, g, target, diff) {
  const f = (w) => { const r = line(kind, { ...g, w }); return diff ? r.zd : r.z; };
  let lo = g.h * 0.005, hi = g.h * 60;
  if (!(f(lo) > target && f(hi) < target)) return null;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (f(mid) > target) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

const KINDS = {
  microstrip: 'Surface microstrip',
  stripline: 'Stripline',
  'diff-microstrip': 'Edge-coupled microstrip pair',
  'diff-stripline': 'Edge-coupled stripline pair',
};

export function run({ kind, units, w, s, h, h2, t, er, target }) {
  kind = KINDS[kind] ? kind : 'microstrip';
  const mm = units !== 'mil';
  const toMm = (v) => (mm ? v : v * MIL);
  const show = (vmm) => `${fmtNum(mm ? vmm : vmm / MIL, 4)} ${mm ? 'mm' : 'mil'}`;
  const isDiff = kind.startsWith('diff');
  const isStrip = kind.includes('stripline');
  const warnings = [];
  if (!(w > 0)) return { warnings: ['Give the trace width, e.g. 0.3 (mm) or 12 (mil).'] };
  if (!(h > 0)) return { warnings: ['Give the dielectric height H between trace and reference plane.'] };
  if (!(er >= 1)) return { warnings: ['Give the dielectric constant Er (FR-4 is about 4.2-4.6 at 1 GHz); it cannot be below 1.'] };
  if (isDiff && !(s > 0)) return { warnings: ['Give the gap S between the two traces of the pair.'] };
  const tt = t > 0 ? t * 1e-3 : 0; // µm -> mm
  if (!(t > 0)) warnings.push('Copper thickness is 0 or missing: computed as an infinitely thin trace (slightly high impedance). 1 oz copper is 35 µm.');
  const g = { w: toMm(w), s: isDiff ? toMm(s) : 0, h: toMm(h), h2: isStrip ? toMm(h2 > 0 ? h2 : h) : 0, t: tt, er };
  if (isStrip && !(h2 > 0)) warnings.push('No H2 given: treated as a symmetric stripline (H2 = H1).');

  // validity ranges of the formulas used
  const u = g.w / g.h;
  if (!isStrip && (u < 0.01 || u > 100)) warnings.push(`W/H = ${fmtNum(u, 3)} is outside 0.01-100, where Hammerstad-Jensen holds: check with a field solver.`);
  if (isStrip && g.t >= Math.min(g.h, g.h2)) warnings.push('Copper is as thick as the dielectric to a plane: the stripline formula is not valid there.');
  if (isStrip && g.w / (g.h + g.h2) < 0.1) warnings.push('Very narrow for the plane spacing (W/b < 0.1): stripline accuracy drops; check with a field solver.');
  if (kind === 'diff-microstrip' && (u < 0.1 || u > 3 || g.s / g.h < 0.1 || g.s / g.h > 5)) warnings.push('AN-905 pair formula is fitted for 0.1 < W/H < 3 and 0.1 < S/H < 5: outside that, expect more than 5-10 % error.');
  if (kind === 'diff-stripline' && g.s / (g.h + g.h2 + g.t) > 3) warnings.push('Traces far apart (S/b > 3): they barely couple, the pair is about 2 × Z0.');
  if (er > 16) warnings.push(`Er = ${er} is not a PCB laminate value; check the input.`);

  const r = line(kind, g);
  if (!Number.isFinite(r.z)) return { warnings: [...warnings, 'The geometry gives no finite impedance: check the inputs.'] };
  const main = isDiff ? r.zd : r.z;
  const delay = Math.sqrt(r.eeff) / C_MM_PER_PS; // ps per mm
  const Lpm = (r.z * Math.sqrt(r.eeff)) / (C_MM_PER_PS * 1e3); // nH/mm: Z0 * sqrt(eeff) / c
  const Cpm = Math.sqrt(r.eeff) / (r.z * C_MM_PER_PS); // pF/mm: sqrt(eeff) / (Z0 c)

  const values = [
    { label: isDiff ? 'Differential impedance' : 'Characteristic impedance', value: fmtNum(main, 4), unit: 'Ω',
      tone: target > 0 ? (Math.abs(main - target) / target <= 0.05 ? 'ok' : Math.abs(main - target) / target <= 0.1 ? 'warn' : 'bad') : undefined,
      hint: target > 0 ? `target ${fmtNum(target, 4)} Ω` : undefined },
  ];
  if (isDiff) values.push({ label: 'Single-ended Z0 of one trace', value: fmtNum(r.z, 4), unit: 'Ω', hint: `odd-mode ≈ ${fmtNum(r.zd / 2, 3)} Ω` });
  values.push(
    { label: 'Effective Er', value: fmtNum(r.eeff, 3), hint: isStrip ? 'stripline: equals Er' : 'field partly in air' },
    { label: 'Propagation delay', value: `${fmtNum(delay, 3)} ps/mm`, hint: `${fmtNum(delay * 25.4, 3)} ps/in` },
    { label: 'Inductance', value: fmtNum(Lpm, 3), unit: 'nH/mm' },
    { label: 'Capacitance', value: fmtNum(Cpm * 1e3, 3), unit: 'fF/mm' },
  );
  if (target > 0) {
    const wt = solveWidth(kind, g, target, isDiff);
    if (wt == null) warnings.push(`No trace width reaches ${target} Ω with this dielectric: change H or Er${isDiff ? ' or the gap' : ''}.`);
    else {
      values.push({ label: `Width for ${fmtNum(target, 4)} Ω`, value: show(wt), tone: 'ok',
        hint: isDiff ? `gap stays ${show(g.s)}` : 'same H, T, Er' });
      if (Math.abs(main - target) / target > 0.1) warnings.push(`${fmtNum(main, 3)} Ω is ${fmtNum((100 * (main - target)) / target, 2)} % off the ${target} Ω target: make the trace ${show(wt)} wide.`);
    }
  }

  // Sweep of width: how sensitive the line is to etch tolerance
  const ws = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2].map((k) => g.w * k);
  const zs = ws.map((wi) => { const ri = line(kind, { ...g, w: wi }); return Number(fmtNum(isDiff ? ri.zd : ri.z, 4)); });
  const rows = [-0.025, -0.0125, 0, 0.0125, 0.025].map((dw) => {
    const wi = g.w + dw;
    if (!(wi > 0)) return null;
    const ri = line(kind, { ...g, w: wi });
    return [show(wi), dw === 0 ? 'nominal' : `${dw > 0 ? '+' : ''}${fmtNum(dw * 1000, 3)} µm`, fmtNum(isDiff ? ri.zd : ri.z, 4)];
  }).filter(Boolean);

  const notes = [
    `${KINDS[kind]}: ${isStrip ? 'H is the dielectric between the trace and each plane (b = H1 + T + H2).' : 'H is the dielectric between the trace and the plane below it.'}`,
    isDiff ? 'Pair impedance from the AN-905 / IPC-2141 coupling approximation: expect ±5-10 %; confirm tight-tolerance pairs with a field solver or the fab.' : (isStrip ? 'Wheeler stripline, finite thickness: about 0.5 % against exact solutions.' : 'Hammerstad-Jensen with thickness correction: about 1 % against field solvers.'),
    !isStrip ? 'Solder mask over a microstrip lowers it by roughly 1-3 Ω; this is computed without mask.' : 'Er for FR-4 falls with frequency (about 4.6 at 1 MHz, 4.2 at 1-5 GHz): use the fab\'s value for your prepreg/core.',
    'Etched traces are trapezoidal: fabs tune the final width to hit the impedance you specify (ask for impedance control).',
  ];
  return {
    values,
    warnings,
    charts: [{ title: `${isDiff ? 'Differential' : 'Characteristic'} impedance against trace width`, type: 'line',
      x: ws.map((wi) => Number(fmtNum(mm ? wi : wi / MIL, 3))), series: [{ name: 'Z', y: zs }], xLabel: `width (${mm ? 'mm' : 'mil'})`, yLabel: 'Ω' }],
    tables: [{ title: 'Etch tolerance: impedance when the width is off by 12.5 or 25 microns', columns: ['Width', 'Change', 'Impedance (Ω)'], rows }],
    notes,
  };
}
