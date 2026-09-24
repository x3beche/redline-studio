// Deflection and bending stress of a straight, prismatic, linear-elastic
// beam (Euler-Bernoulli), small deflections. Closed-form cases from Roark's
// Formulas for Stress and Strain, table 8.1 (same as the AISC beam
// diagrams). Loads superpose, so a point load and self weight add up.
//
//   cantilever, point P at a:  y = P x^2 (3a - x) / 6EI (x <= a), P a^2 (3x - a) / 6EI beyond
//                              (tip load a = L: y_max = P L^3 / 3EI, M_max = P L)
//   cantilever, UDL w:         y = w x^2 (6L^2 - 4Lx + x^2) / 24EI   (y_max = wL^4 / 8EI)
//   simply supported, P at a:  y = P b x (L^2 - b^2 - x^2) / 6EIL (x <= a), b = L - a
//                              (centre: y_max = P L^3 / 48EI, M_max = P L / 4)
//   simply supported, UDL:     y = w x (L^3 - 2L x^2 + x^3) / 24EI    (y_max = 5wL^4 / 384EI)
//   fixed both ends, P at a:   y = P b^2 x^2 (3aL - 3ax - bx) / 6EIL^3 (x <= a)
//                              (centre: y_max = P L^3 / 192EI, M_max = P L / 8)
//   fixed both ends, UDL:      y = w x^2 (L - x)^2 / 24EI             (y_max = wL^4 / 384EI)
// Bending stress sigma = M c / I.
import { fmtNum } from '../kit/eng.js';

const MATERIALS = {
  s235: { name: 'Steel S235', E: 210, fy: 235, rho: 7850 },
  s355: { name: 'Steel S355', E: 210, fy: 355, rho: 7850 },
  ss304: { name: 'Stainless 304', E: 193, fy: 215, rho: 8000 },
  al6061: { name: 'Aluminium 6061-T6', E: 68.9, fy: 276, rho: 2700 },
  al6063: { name: 'Aluminium 6063-T6', E: 68.9, fy: 214, rho: 2700 },
  ti: { name: 'Titanium Ti-6Al-4V', E: 114, fy: 880, rho: 4430 },
  pla: { name: 'PLA (3D printed, along layers)', E: 3.5, fy: 50, rho: 1240 },
  abs: { name: 'ABS', E: 2.2, fy: 40, rho: 1050 },
  custom: { name: 'Custom', E: null, fy: null, rho: null },
};

/** Second moment I (mm^4), extreme fibre c (mm) and area A (mm^2), bending about the horizontal axis. */
function section({ sec, b, h, d, t, I, c, A }) {
  const pi = Math.PI;
  switch (sec) {
    case 'rect':
      if (!(b > 0 && h > 0)) return { err: 'Give the width b and height h of the rectangle in mm.' };
      return { I: (b * h ** 3) / 12, c: h / 2, A: b * h, name: `${fmtNum(b, 4)} × ${fmtNum(h, 4)} mm rectangle` };
    case 'round':
      if (!(d > 0)) return { err: 'Give the diameter in mm.' };
      return { I: (pi * d ** 4) / 64, c: d / 2, A: (pi * d * d) / 4, name: `Ø${fmtNum(d, 4)} mm round bar` };
    case 'tube': {
      if (!(d > 0 && t > 0)) return { err: 'Give the tube outside diameter and wall in mm.' };
      if (2 * t >= d) return { err: 'The wall is thicker than the radius: use a round bar instead.' };
      const di = d - 2 * t;
      return { I: (pi * (d ** 4 - di ** 4)) / 64, c: d / 2, A: (pi * (d * d - di * di)) / 4, name: `Ø${fmtNum(d, 4)} × ${fmtNum(t, 3)} mm tube` };
    }
    case 'rhs': {
      if (!(b > 0 && h > 0 && t > 0)) return { err: 'Give the box width, height and wall in mm.' };
      if (2 * t >= b || 2 * t >= h) return { err: 'The wall is too thick for the box size: use a rectangle instead.' };
      return { I: (b * h ** 3 - (b - 2 * t) * (h - 2 * t) ** 3) / 12, c: h / 2, A: b * h - (b - 2 * t) * (h - 2 * t),
        name: `${fmtNum(b, 4)} × ${fmtNum(h, 4)} × ${fmtNum(t, 3)} mm box section` };
    }
    default:
      if (!(I > 0 && c > 0)) return { err: 'Give the second moment of area I in mm⁴ and the distance c to the extreme fibre in mm.' };
      return { I, c, A: A > 0 ? A : null, name: 'custom section' };
  }
}

// Deflection y(x) (mm, downward positive) and moment M(x) (N mm, sagging positive)
// for a unit of each load type; EI in N mm^2.
function pointLoad(sup, L, a, P, EI) {
  const b = L - a;
  if (sup === 'cantilever') {
    return {
      y: (x) => (x <= a ? (P * x * x * (3 * a - x)) / (6 * EI) : (P * a * a * (3 * x - a)) / (6 * EI)),
      M: (x) => (x <= a ? -P * (a - x) : 0),
      R: [P, 0],
    };
  }
  if (sup === 'simple') {
    return {
      y: (x) => (x <= a ? (P * b * x * (L * L - b * b - x * x)) / (6 * EI * L)
        : (P * a * (L - x) * (L * L - a * a - (L - x) ** 2)) / (6 * EI * L)),
      M: (x) => (x <= a ? (P * b * x) / L : (P * a * (L - x)) / L),
      R: [(P * b) / L, (P * a) / L],
    };
  }
  // fixed-fixed (Roark table 8.1 case 1d)
  const RA = (P * b * b * (3 * a + b)) / L ** 3;
  const MA = (-P * a * b * b) / (L * L);
  return {
    y: (x) => (x <= a ? (P * b * b * x * x * (3 * a * L - 3 * a * x - b * x)) / (6 * EI * L ** 3)
      : (P * a * a * (L - x) ** 2 * (3 * b * L - 3 * b * (L - x) - a * (L - x))) / (6 * EI * L ** 3)),
    M: (x) => MA + RA * x - (x > a ? P * (x - a) : 0),
    R: [RA, P - RA],
  };
}

function udl(sup, L, w, EI) {
  if (sup === 'cantilever') return { y: (x) => (w * x * x * (6 * L * L - 4 * L * x + x * x)) / (24 * EI), M: (x) => (-w * (L - x) ** 2) / 2, R: [w * L, 0] };
  if (sup === 'simple') return { y: (x) => (w * x * (L ** 3 - 2 * L * x * x + x ** 3)) / (24 * EI), M: (x) => (w * x * (L - x)) / 2, R: [(w * L) / 2, (w * L) / 2] };
  return { y: (x) => (w * x * x * (L - x) ** 2) / (24 * EI), M: (x) => (w * (6 * L * x - L * L - 6 * x * x)) / 12, R: [(w * L) / 2, (w * L) / 2] };
}

export function run(input) {
  const { support, load, L, P, w, a, mat, E, fy, selfweight, limit } = input;
  const warnings = [];
  const sup = ['cantilever', 'simple', 'fixed'].includes(support) ? support : 'simple';
  if (!(L > 0)) return { warnings: ['Give the span (or cantilever length) L in mm.'] };
  const m = MATERIALS[mat] || MATERIALS.s235;
  const Ey = mat === 'custom' ? E : m.E;
  const fyy = mat === 'custom' ? fy : m.fy;
  if (!(Ey > 0)) return { warnings: ['Give the Young\'s modulus E in GPa (steel 200-210, aluminium 69).'] };
  const s = section(input);
  if (s.err) return { warnings: [s.err] };
  const EI = Ey * 1000 * s.I; // N mm^2

  const parts = [];
  let pos = null;
  if (load === 'udl') {
    if (!(w > 0)) return { warnings: ['Give the distributed load w in N/mm (the same number as kN/m).'] };
    parts.push(udl(sup, L, w, EI));
  } else {
    if (!(P > 0)) return { warnings: ['Give the point load P in N.'] };
    pos = a != null && Number.isFinite(a) ? a : sup === 'cantilever' ? L : L / 2;
    const inside = pos > 0 && (sup === 'cantilever' ? pos <= L : pos < L);
    if (!inside) {
      warnings.push(`The load position a must be within the beam (0 < a ${sup === 'cantilever' ? '≤' : '<'} ${fmtNum(L, 4)} mm); ${sup === 'cantilever' ? 'the tip' : 'mid-span'} is used instead.`);
      pos = sup === 'cantilever' ? L : L / 2;
    }
    parts.push(pointLoad(sup, L, pos, P, EI));
  }
  let wself = 0;
  if (selfweight) {
    if (mat === 'custom' || !s.A) warnings.push('Self weight needs a listed material and a section with a known area; it was left out.');
    else {
      wself = (m.rho * 9.81 * s.A) / 1e9; // kg/m^3 * m/s^2 * mm^2 -> N/mm
      parts.push(udl(sup, L, wself, EI));
    }
  }

  // Sample the curve: the maxima of superposed loads are found numerically.
  const N = 2000;
  let yMax = 0, xAt = 0, mMax = 0, xM = 0;
  for (let i = 0; i <= N; i++) {
    const x = (L * i) / N;
    const y = parts.reduce((acc, p) => acc + p.y(x), 0);
    const Mx = parts.reduce((acc, p) => acc + p.M(x), 0);
    if (Math.abs(y) > Math.abs(yMax)) { yMax = y; xAt = x; }
    if (Math.abs(Mx) > Math.abs(mMax)) { mMax = Mx; xM = x; }
  }
  const R = parts.reduce((acc, p) => [acc[0] + p.R[0], acc[1] + p.R[1]], [0, 0]);
  const sigma = (Math.abs(mMax) * s.c) / s.I; // MPa
  const sf = fyy > 0 ? fyy / sigma : null;
  const ratio = yMax > 0 ? L / yMax : null;
  const lim = limit > 0 ? limit : 250;
  const effL = sup === 'cantilever' ? 2 * L : L; // a cantilever is judged against twice its length

  const values = [
    { label: 'Max deflection', value: fmtNum(yMax, 4), unit: 'mm', hint: `at x = ${fmtNum(xAt, 4)} mm`,
      tone: ratio && effL / yMax >= lim ? 'ok' : 'warn' },
    { label: 'Span / deflection', value: ratio ? `L/${Math.round(ratio)}` : '–', hint: `limit ${sup === 'cantilever' ? '2L' : 'L'}/${lim}` },
    { label: 'Max bending moment', value: fmtNum(Math.abs(mMax) / 1000, 4), unit: 'N m', hint: `at x = ${fmtNum(xM, 4)} mm` },
    { label: 'Max bending stress', value: fmtNum(sigma, 4), unit: 'MPa', tone: sf == null ? undefined : sf >= 1.5 ? 'ok' : sf >= 1 ? 'warn' : 'bad' },
    { label: 'Safety factor on yield', value: sf == null ? '–' : fmtNum(sf, 3), hint: fyy > 0 ? `yield ${fmtNum(fyy, 4)} MPa` : 'give the yield strength' },
    { label: 'Reactions', value: sup === 'cantilever' ? `${fmtNum(R[0], 4)} N` : `${fmtNum(R[0], 4)} / ${fmtNum(R[1], 4)} N`, hint: sup === 'cantilever' ? 'at the fixed end' : 'left / right' },
    { label: 'Second moment I', value: fmtNum(s.I, 4), unit: 'mm⁴', hint: s.name },
    { label: 'Stiffness EI', value: fmtNum(EI / 1e6, 4), unit: 'N m²' },
  ];
  if (wself) values.push({ label: 'Self weight', value: fmtNum(wself * 1000, 4), unit: 'N/m', hint: `${fmtNum(m.rho * s.A * L / 1e9, 4)} kg beam` });

  if (sf != null && sf < 1) warnings.push(`The stress (${fmtNum(sigma, 4)} MPa) is over the yield strength (${fmtNum(fyy, 4)} MPa): the beam bends permanently. Use a deeper section or a stronger material.`);
  else if (sf != null && sf < 1.5) warnings.push(`Safety factor ${fmtNum(sf, 3)} on yield is thin: 1.5 or more is usual for static loads.`);
  if (ratio && effL / yMax < lim) warnings.push(`Deflection is more than ${sup === 'cantilever' ? '2L' : 'L'}/${lim}: stiffen the section (height counts to the third power) or shorten the span.`);
  if (yMax > 0.1 * L) warnings.push('Deflection over 10 % of the length: small-deflection beam theory no longer holds, the real beam behaves differently.');
  if (L / (2 * s.c) < 5) warnings.push('The beam is short for its depth (L/h under 5): shear deflection, not included here, becomes significant.');

  const xs = Array.from({ length: 41 }, (_, i) => (L * i) / 40);
  return {
    values,
    warnings,
    charts: [{
      title: 'Deflection along the beam', type: 'line',
      x: xs.map((x) => Number(x.toPrecision(4))),
      series: [{ name: 'deflection', y: xs.map((x) => -parts.reduce((acc, p) => acc + p.y(x), 0)) }],
      xLabel: 'position x (mm, from the left / fixed end)', yLabel: 'deflection (mm, up positive)',
    }],
    notes: [
      `${m.name === 'Custom' ? 'Custom material' : m.name}, E = ${fmtNum(Ey, 4)} GPa; ${s.name}, bending with the load along the height.`,
      'Euler-Bernoulli beam: linear-elastic, small deflections, no shear deflection, no buckling or lateral-torsional check.',
      'Deflection limits are serviceability rules of thumb: L/250 general, L/360 where finishes crack, 2L/180 is also used for cantilevers.',
    ],
  };
}
