// Tightening torque and preload of a metric coarse-thread bolt, after
// VDI 2230 Part 1 (2015), section 5.5 (assembly preload and tightening torque):
//
//   F_M,zul = A0 * nu * Rp0.2 / sqrt(1 + 3 * [ 3/2 * d2/d0 * (P / (pi d2) + 1.155 muG) ]^2)
//             (the preload at which the von Mises stress from tension plus
//              thread torsion reaches nu * yield; A0 = As, d0 = ds)
//   M_A     = F_M * (0.16 P + 0.58 d2 muG + muK * D_Km / 2)
//             D_Km = (dw + dh) / 2, the mean diameter of the head bearing face
//
// Thread geometry per ISO 724 / ISO 898-1:
//   d2 = d - 0.64952 P,  d3 = d - 1.22687 P,  ds = (d2 + d3) / 2,  As = pi/4 ds^2
import { fmtNum } from '../kit/eng.js';

// d, pitch P, hex dw (ISO 4017, min bearing dia.), socket-cap dw (ISO 4762),
// clearance hole dh (ISO 273 medium), all mm.
const SIZES = {
  M2: [2, 0.4, 3.1, 3.5, 2.4], 'M2.5': [2.5, 0.45, 4.1, 4.3, 2.9], M3: [3, 0.5, 4.6, 5.1, 3.4],
  M4: [4, 0.7, 5.9, 6.5, 4.5], M5: [5, 0.8, 6.9, 8.0, 5.5], M6: [6, 1.0, 8.9, 9.4, 6.6],
  M8: [8, 1.25, 11.6, 12.3, 9], M10: [10, 1.5, 14.6, 15.3, 11], M12: [12, 1.75, 16.6, 17.2, 13.5],
  M14: [14, 2.0, 19.6, 20.2, 15.5], M16: [16, 2.0, 22.5, 23.2, 17.5], M20: [20, 2.5, 28.2, 28.9, 22],
  M24: [24, 3.0, 33.6, 34.8, 26],
};

// Property classes: minimum 0.2 % proof (yield) Rp0.2 and tensile Rm, MPa
// (ISO 898-1 for steel, ISO 3506-1 for stainless), and proof load stress Sp.
const GRADES = {
  '4.6': { rp: 240, rm: 400, sp: 225 },
  '5.6': { rp: 300, rm: 500, sp: 280 },
  '8.8': { rp: 640, rm: 800, sp: 580, big: { rp: 660, rm: 830, sp: 600 } }, // d > 16 mm
  '10.9': { rp: 940, rm: 1040, sp: 830 },
  '12.9': { rp: 1100, rm: 1220, sp: 970 },
  'A2-70': { rp: 450, rm: 700, sp: null },
  'A4-70': { rp: 450, rm: 700, sp: null },
  'A4-80': { rp: 600, rm: 800, sp: null },
};

export function run({ size, grade, head, muG, muK, nu, alphaA }) {
  const warnings = [];
  const s = SIZES[size];
  if (!s) return { warnings: [`Unknown size ${size}: pick M2 to M24.`] };
  const [d, P, dwHex, dwCap, dh] = s;
  let g = GRADES[grade] || GRADES['8.8'];
  if (g.big && d > 16) g = g.big;
  const mg = muG > 0 ? muG : null;
  if (mg == null) return { warnings: ['Give the thread friction coefficient µG, e.g. 0.12 for lightly oiled zinc-plated steel.'] };
  const mk = muK > 0 ? muK : mg;
  const util = nu > 0 ? nu / 100 : 0.9;
  if (mg < 0.04 || mg > 0.3) warnings.push(`µG = ${mg} is outside the 0.04-0.30 range seen in practice: check it.`);
  if (util > 1) warnings.push('Utilisation above 100 % of yield plasticises the bolt: VDI 2230 uses 90 %.');
  if (util < 0.3) warnings.push('Utilisation below 30 % leaves little preload: joints this loose tend to slip or loosen.');

  // thread geometry
  const d2 = d - 0.64952 * P;
  const d3 = d - 1.22687 * P;
  const ds = (d2 + d3) / 2;
  const As = (Math.PI / 4) * ds * ds;
  const dw = head === 'socket' ? dwCap : dwHex;
  const DKm = (dw + dh) / 2;

  // VDI 2230 section 5.5.1: permissible assembly preload
  const k = 1.5 * (d2 / ds) * (P / (Math.PI * d2) + 1.155 * mg);
  const F = (As * util * g.rp) / Math.sqrt(1 + 3 * k * k); // N
  // VDI 2230 section 5.5.1: tightening torque, split into its three parts
  const tPitch = F * 0.16 * P; // N mm, the part that stretches the bolt
  const tThread = F * 0.58 * d2 * mg;
  const tHead = F * mk * DKm / 2;
  const MA = (tPitch + tThread + tHead) / 1000; // N m
  const K = (MA * 1000) / (F * d); // equivalent nut factor, T = K F d
  const sigma = F / As;
  // VDI 2230 takes the torsion on the partly plastic section, W = pi ds^3 / 12 (hence its 3/2)
  const tau = (F * (0.16 * P + 0.58 * d2 * mg)) / ((Math.PI * ds ** 3) / 12);
  const vm = Math.sqrt(sigma * sigma + 3 * tau * tau);
  const aA = alphaA >= 1 ? alphaA : 1.6;
  if (!(alphaA >= 1)) warnings.push('The tightening factor αA must be 1 or more; 1.6 (torque wrench) is used.');

  const values = [
    { label: 'Tightening torque', value: fmtNum(MA, 3), unit: 'N m', tone: 'ok', hint: `${size} ${grade}, µG ${mg}, µK ${fmtNum(mk, 3)}` },
    { label: 'Preload (max, at that torque)', value: fmtNum(F / 1000, 3), unit: 'kN', hint: `${fmtNum(util * 100, 3)} % of yield, von Mises` },
    { label: 'Preload (min, with scatter)', value: fmtNum(F / aA / 1000, 3), unit: 'kN', hint: `÷ αA ${fmtNum(aA, 3)}: what you can count on` },
    { label: 'Tensile stress', value: fmtNum(sigma, 3), unit: 'MPa', hint: `on As ${fmtNum(As, 3)} mm²` },
    { label: 'Of proof load', value: g.sp ? fmtNum((sigma / g.sp) * 100, 3) : '–', unit: g.sp ? '%' : '', hint: g.sp ? `Sp ${g.sp} MPa` : 'no proof load for stainless' },
    { label: 'Equivalent nut factor K', value: fmtNum(K, 3), hint: 'T = K · F · d' },
    { label: 'Torque to thread / head', value: `${fmtNum((100 * (tPitch + tThread)) / (MA * 1000), 3)} / ${fmtNum((100 * tHead) / (MA * 1000), 3)} %`,
      hint: `only ${fmtNum((100 * tPitch) / (MA * 1000), 2)} % stretches the bolt` },
  ];
  if (/^A[24]/.test(grade) && mg < 0.15) warnings.push('Stainless on stainless galls when dry: with µ below 0.15 you are assuming a lubricant or anti-seize; dry it is 0.2-0.35.');

  // Torque over the usual friction range, for when the lubrication is not known.
  const mus = [0.08, 0.1, 0.12, 0.14, 0.16, 0.2];
  const rows = mus.map((m) => {
    const kk = 1.5 * (d2 / ds) * (P / (Math.PI * d2) + 1.155 * m);
    const f = (As * util * g.rp) / Math.sqrt(1 + 3 * kk * kk);
    const t = (f * (0.16 * P + 0.58 * d2 * m + m * DKm / 2)) / 1000;
    return [String(m), `${fmtNum(f / 1000, 3)} kN`, `${fmtNum(t, 3)} N m`];
  });
  return {
    values,
    warnings,
    tables: [
      { title: `${size} ${grade} at other friction values (µG = µK)`, columns: ['µ', 'Preload', 'Torque'], rows },
      { title: 'Thread and head data used', columns: ['d', 'Pitch', 'd2', 'd3', 'As', 'Bearing dw', 'Hole dh', 'Yield Rp0.2'],
        rows: [[`${d} mm`, `${P} mm`, `${fmtNum(d2, 4)} mm`, `${fmtNum(d3, 4)} mm`, `${fmtNum(As, 3)} mm²`, `${dw} mm`, `${dh} mm`, `${g.rp} MPa`]] },
    ],
    notes: [
      `Stress check during tightening: von Mises ${fmtNum(vm, 3)} MPa = ${fmtNum((vm / g.rp) * 100, 3)} % of yield (tension ${fmtNum(sigma, 3)} MPa, thread torsion ${fmtNum(tau, 3)} MPa on the VDI 2230 plastic section modulus π ds³/12).`,
      'Typical µ: 0.08-0.10 with MoS2 paste or wax; 0.10-0.12 black oxide or zinc, oiled; 0.12-0.16 zinc, dry; 0.20-0.35 stainless or aluminium, dry.',
      'Friction is the biggest unknown: the same torque on a dry bolt gives far less preload than on an oiled one. Use the µ that matches the real parts.',
      'αA: about 1.6 for a torque wrench, 1.2-1.4 with angle or yield-controlled tightening, 2.5-4 for an impact driver.',
      'A tapped hole in aluminium or plastic needs enough engagement (about 2 × d in aluminium) or the thread strips before the bolt reaches this preload.',
    ],
  };
}
