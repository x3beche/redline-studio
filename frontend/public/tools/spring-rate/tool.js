// Helical compression spring of round wire, after Shigley's Mechanical
// Engineering Design (10th ed.), chapter 10:
//   rate                 k = d^4 G / (8 D^3 Na)                     (eq. 10-9)
//   spring index         C = D / d
//   Bergstrasser factor  KB = (4C + 2) / (4C - 3)                    (eq. 10-5)
//   shear stress         tau = KB * 8 F D / (pi d^3)                 (eq. 10-7)
//   wire strength        Sut = A / d^m                               (eq. 10-14, table 10-4)
//   allowed at solid     0.45 Sut music / hard drawn, 0.50 oil-tempered and alloy,
//                        0.35 stainless and non-ferrous              (table 10-6)
//   end types            total coils, solid length, pitch           (table 10-1)
//   buckling (flat, parallel ends)   stable when L0 < 2.63 D / alpha, alpha = 0.5
import { fmtNum } from '../kit/eng.js';

// G in GPa by wire diameter band [upTo mm, G]; A (MPa mm^m) and m by band [upTo, A, m].
const MATERIALS = {
  music: { name: 'Music wire (ASTM A228)', G: [[0.8, 82.7], [1.6, 81.7], [3, 81.0], [99, 80.7]], S: [[6.5, 2211, 0.145]], allow: 0.45, range: [0.1, 6.5] },
  hd: { name: 'Hard-drawn (ASTM A227)', G: [[0.8, 80.7], [1.6, 80.0], [3, 79.3], [99, 78.6]], S: [[12, 1783, 0.190]], allow: 0.45, range: [0.7, 12] },
  ot: { name: 'Oil-tempered (ASTM A229)', G: [[99, 77.2]], S: [[12, 1855, 0.187]], allow: 0.50, range: [0.5, 12] },
  crv: { name: 'Chrome-vanadium (ASTM A232)', G: [[99, 77.2]], S: [[11, 2005, 0.168]], allow: 0.50, range: [0.8, 11] },
  crsi: { name: 'Chrome-silicon (ASTM A401)', G: [[99, 77.2]], S: [[9.5, 1974, 0.108]], allow: 0.50, range: [1.6, 9.5] },
  ss302: { name: 'Stainless 302 (ASTM A313)', G: [[99, 69.0]], S: [[2.5, 1867, 0.146], [5, 2065, 0.263], [10, 2911, 0.478]], allow: 0.35, range: [0.3, 10] },
  pb: { name: 'Phosphor bronze (ASTM B159)', G: [[99, 41.4]], S: [[0.6, 1000, 0], [2, 913, 0.028], [7.5, 932, 0.064]], allow: 0.35, range: [0.1, 7.5] },
};

// Shigley table 10-1: extra inactive coils, solid length and pitch from free length.
const ENDS = {
  plain: { name: 'Plain', extra: 0, solid: (d, nt) => d * (nt + 1), pitch: (L0, d, na) => (L0 - d) / na },
  plainground: { name: 'Plain and ground', extra: 1, solid: (d, nt) => d * nt, pitch: (L0, d, na) => L0 / (na + 1) },
  squared: { name: 'Squared (closed)', extra: 2, solid: (d, nt) => d * (nt + 1), pitch: (L0, d, na) => (L0 - 3 * d) / na },
  sqground: { name: 'Squared and ground', extra: 2, solid: (d, nt) => d * nt, pitch: (L0, d, na) => (L0 - 2 * d) / na },
};

const band = (rows, d) => rows.find((r) => d <= r[0]) || rows[rows.length - 1];

export function run({ material, d, dia, diaIs, coils, coilsAre, ends, L0, L1, Gc }) {
  const warnings = [];
  const mat = MATERIALS[material];
  const e = ENDS[ends] || ENDS.sqground;
  if (!(d > 0)) return { warnings: ['Give the wire diameter d in mm.'] };
  if (!(dia > 0)) return { warnings: ['Give the coil diameter in mm (outside, mean or inside, as chosen).'] };
  if (!(coils > 0)) return { warnings: ['Give the number of coils.'] };
  const D = diaIs === 'od' ? dia - d : diaIs === 'id' ? dia + d : dia; // mean diameter
  if (!(D > d)) return { warnings: ['The coil diameter is too small for the wire: the mean diameter must be larger than d.'] };
  const Na = coilsAre === 'total' ? coils - e.extra : coils;
  const Nt = Na + e.extra;
  if (!(Na > 0)) return { warnings: [`${fmtNum(coils, 4)} total coils leaves no active coils with ${e.name.toLowerCase()} ends (they use ${e.extra}): give more coils.`] };

  let G, Sut = null, allow = 0.45;
  if (mat) {
    G = band(mat.G, d)[1];
    const [, A, m] = band(mat.S, d);
    Sut = A / d ** m; // MPa, Shigley eq. 10-14
    allow = mat.allow;
    if (d < mat.range[0] || d > mat.range[1]) warnings.push(`${fmtNum(d, 3)} mm is outside the ${mat.range[0]}-${mat.range[1]} mm range this wire is made in: the strength estimate is extrapolated.`);
  } else {
    G = Gc;
    if (!(G > 0)) return { warnings: ['Give the shear modulus G in GPa (steel about 79, stainless 69, bronze 41).'] };
  }

  const k = (d ** 4 * G * 1000) / (8 * D ** 3 * Na); // N/mm
  const C = D / d;
  const KB = (4 * C + 2) / (4 * C - 3);
  const tauPerN = (KB * 8 * D) / (Math.PI * d ** 3); // MPa per N
  if (C < 4) warnings.push(`Spring index ${fmtNum(C, 3)} is under 4: hard to coil and highly stressed on the inside of the wire. Use a larger coil or thinner wire.`);
  if (C > 12) warnings.push(`Spring index ${fmtNum(C, 3)} is over 12: the spring tangles and buckles easily. Use a smaller coil or thicker wire.`);
  if (Na < 3) warnings.push('Fewer than 3 active coils: the rate is not well defined; use at least 3.');

  const values = [
    { label: 'Spring rate k', value: fmtNum(k, 4), unit: 'N/mm', tone: 'ok', hint: `${fmtNum(k * 1000, 4)} N/m` },
    { label: 'Mean coil diameter D', value: fmtNum(D, 4), unit: 'mm', hint: `OD ${fmtNum(D + d, 4)}, ID ${fmtNum(D - d, 4)} mm` },
    { label: 'Active / total coils', value: `${fmtNum(Na, 4)} / ${fmtNum(Nt, 4)}`, hint: `${e.name} ends` },
    { label: 'Spring index C', value: fmtNum(C, 3), tone: C >= 4 && C <= 12 ? 'ok' : 'warn', hint: '4-12 is good' },
    { label: 'Shear modulus G', value: fmtNum(G, 3), unit: 'GPa' },
  ];

  const solid = e.solid(d, Nt);
  values.push({ label: 'Solid length', value: fmtNum(solid, 4), unit: 'mm' });
  const tables = [];
  const rows = [];
  if (L0 > 0) {
    if (L0 <= solid) {
      warnings.push(`The free length ${fmtNum(L0, 4)} mm is not longer than the solid length ${fmtNum(solid, 4)} mm: add length or remove coils.`);
    } else {
      const ys = L0 - solid;
      const Fs = k * ys;
      const tauS = tauPerN * Fs;
      const pitch = e.pitch(L0, d, Na);
      values.push(
        { label: 'Pitch', value: fmtNum(pitch, 4), unit: 'mm' },
        { label: 'Force at solid', value: fmtNum(Fs, 4), unit: 'N', hint: `after ${fmtNum(ys, 4)} mm` },
      );
      if (Sut) {
        const sy = allow * Sut;
        const n = sy / tauS;
        values.push({ label: 'Stress at solid', value: fmtNum(tauS, 4), unit: 'MPa', tone: n >= 1.2 ? 'ok' : n >= 1 ? 'warn' : 'bad',
          hint: `allowed ${fmtNum(sy, 4)} MPa (${allow * 100} % of Sut ${fmtNum(Sut, 4)})` });
        if (n < 1) warnings.push(`Closed solid, the wire is stressed to ${fmtNum(tauS, 4)} MPa, over the ${fmtNum(sy, 4)} MPa allowed: the spring takes a set. Reduce the free length, or raise d or the coil count.`);
        else if (n < 1.2) warnings.push(`Safety at solid is only ${fmtNum(n, 3)} (Shigley suggests 1.2 or more).`);
      } else {
        values.push({ label: 'Stress at solid', value: fmtNum(tauS, 4), unit: 'MPa', hint: 'compare with your wire\'s allowable' });
      }
      // Buckling, Shigley eq. 10-10: flat, parallel ground ends -> alpha = 0.5.
      const crit = (2.63 * D) / 0.5;
      if (L0 >= crit) warnings.push(`Free length ${fmtNum(L0, 4)} mm is over ${fmtNum(crit, 4)} mm (2.63 D / 0.5): the spring can buckle; guide it on a rod or in a bore.`);
      if (L1 != null && Number.isFinite(L1)) {
        if (L1 >= L0 || L1 < solid) warnings.push(`The working length must be between solid (${fmtNum(solid, 4)} mm) and free (${fmtNum(L0, 4)} mm).`);
        else {
          const y = L0 - L1;
          const F = k * y;
          const tau = tauPerN * F;
          values.push(
            { label: 'Working force', value: fmtNum(F, 4), unit: 'N', hint: `at ${fmtNum(L1, 4)} mm (${fmtNum(y, 4)} mm compressed)` },
            { label: 'Working stress', value: fmtNum(tau, 4), unit: 'MPa', hint: `KB ${fmtNum(KB, 4)}` },
          );
          // Shigley: keep 15 % of the travel to solid unused (fractional overrun 0.15)
          if (L1 - solid < 0.15 * (L0 - solid)) warnings.push('The working length is within 15 % of the travel to solid: coils may clash; leave more room.');
        }
      }
      const steps = [0.2, 0.4, 0.6, 0.8, 1].map((f) => f * ys);
      for (const y of steps) rows.push([`${fmtNum(L0 - y, 4)} mm`, `${fmtNum(y, 4)} mm`, `${fmtNum(k * y, 4)} N`, `${fmtNum(tauPerN * k * y, 4)} MPa`]);
      tables.push({ title: 'Force and stress along the travel', columns: ['Length', 'Deflection', 'Force', 'Stress'], rows });
    }
  } else {
    warnings.push('Give the free length to see the solid force, stress and buckling check.');
  }

  return {
    values,
    warnings,
    tables,
    notes: [
      'k = d⁴ G / (8 D³ Na), with D the mean coil diameter and Na the active coils; the end coils do not flex.',
      'Stress uses the Bergsträsser curvature factor KB; allowable stress at solid is Shigley table 10-6 without set removal.',
      'Buckling limit assumes flat, ground ends between parallel plates; a spring with one end free to tilt buckles at about half that length.',
      'The same rate formula holds for the body of an extension spring (count its active coils); its hooks need their own stress check.',
    ],
  };
}
