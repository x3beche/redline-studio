// Flat length of a one-bend sheet metal part.
//   BA   = θ · (R + K·T)                    bend allowance, the neutral-axis arc length
//   OSSB = tan(θ/2) · (R + T)               outside setback, bend tangent to outside mould line
//   ISSB = tan(θ/2) · R                     inside setback, to the inside mould line
//   BD   = 2·OSSB − BA                      bend deduction
//   flat = A + B − BD                       flanges to the outside mould line
//   flat = A + B − 2·ISSB + BA              flanges to the inside mould line
// (Machinery's Handbook, sheet metal; the same as SolidWorks / Inventor use.)
// K-factor:
//   DIN 6935: k = 0.65 + 0.5·lg(R/T) for R/T < 5, k = 1 above; K = k/2.
//   Table: common press-brake rule of thumb by R/T and hardness.
import { fmtNum } from '../kit/eng.js';

const TABLE = { // [R <= T, T < R <= 3T, R > 3T]
  soft: [0.33, 0.40, 0.50],
  medium: [0.38, 0.43, 0.50],
  hard: [0.40, 0.45, 0.50],
};
const f = (v, d = 4) => fmtNum(v, d);
const mm = (v) => `${f(v)} mm`;

export function kDin(rt) {
  if (!(rt > 0)) return null;
  if (rt >= 5) return 0.5;
  return Math.min(0.5, Math.max(0, (0.65 + 0.5 * Math.log10(rt)) / 2));
}

export function run({ t, r, angle, angleType, a, b, dims, kmode, k, hard }) {
  const warnings = [];
  if (!(t > 0)) return { warnings: ['Give the sheet thickness in mm, e.g. 2.'] };
  if (!(r >= 0)) return { warnings: ['Give the inside bend radius in mm (0 or more), e.g. 2.'] };
  if (!(angle > 0 && angle < 180)) return { warnings: ['Give an angle between 0 and 180 degrees (a hem of 180° needs its own allowance).'] };
  const deg = angleType === 'included' ? 180 - angle : angle;
  const th = (deg * Math.PI) / 180;
  const rt = r / t;

  let K, kWhy;
  if (kmode === 'manual') {
    if (!(k >= 0 && k <= 1)) return { warnings: ['Give a K-factor between 0 and 1 (usually 0.3 to 0.5).'] };
    K = k; kWhy = 'typed in';
    if (k > 0.5) warnings.push(`A K-factor of ${f(k)} puts the neutral axis past mid-thickness, which does not happen in bending: use 0.5 or less.`);
  } else if (kmode === 'table') {
    const row = TABLE[hard] || TABLE.medium;
    K = rt <= 1 ? row[0] : rt <= 3 ? row[1] : row[2];
    kWhy = `table, R/T = ${f(rt, 3)}, ${hard || 'medium'}`;
  } else {
    K = r > 0 ? kDin(rt) : 0.325; // R = 0: DIN's formula has no value; the sharp-bend limit is about 0.3 to 0.35
    kWhy = r > 0 ? `DIN 6935, R/T = ${f(rt, 3)}` : 'R = 0: DIN 6935 has no value, 0.325 assumed';
  }

  const tan = Math.tan(th / 2);
  const BA = th * (r + K * t);
  const OSSB = tan * (r + t);
  const ISSB = tan * r;
  const BD = 2 * OSSB - BA;
  const inside = dims === 'inside';
  const flatFor = (kk) => {
    const ba = th * (r + kk * t);
    return inside ? a + b - 2 * ISSB + ba : a + b - (2 * OSSB - ba);
  };
  if (!(a > 0) || !(b > 0)) return { warnings: ['Give both flange lengths in mm.'] };
  const flat = flatFor(K);
  // Straight (flat) part of each flange, from its end to the bend tangent line.
  const setback = inside ? ISSB : OSSB;
  const straightA = a - setback, straightB = b - setback;

  if (r < t * 0.5) warnings.push(`R is ${f(rt, 2)}·T: under about 0.5·T to 1·T the outside of the bend can crack, especially in hard aluminium or across the rolling direction. Use R ≥ T, or check the material's minimum bend radius.`);
  if (deg > 150) warnings.push(`A ${f(deg, 3)}° bend is close to a hem: the setback tan(θ/2) grows fast and small angle errors change the flat a lot. Check with a test piece.`);
  const minFlange = 2.5 * t + r; // rule of thumb: the flange has to rest on the die
  if (Math.min(a, b) < minFlange) warnings.push(`A flange shorter than about 2.5·T + R (${mm(minFlange)}) cannot rest across the V-die: lengthen it or bend it before trimming.`);
  if (straightA < 0 || straightB < 0) warnings.push('A flange is shorter than the setback: it ends inside the bend. Make the flanges longer.');

  const ks = [0.30, 0.33, 0.38, 0.40, 0.42, 0.44, 0.45, 0.50];
  return {
    values: [
      { label: 'Flat length', value: straightA < 0 || straightB < 0 ? '–' : f(flat, 5), unit: 'mm', tone: 'ok', hint: inside ? 'A + B − 2·ISSB + BA' : 'A + B − BD' },
      { label: 'K-factor', value: f(K, 3), hint: kWhy },
      { label: 'Bend angle', value: f(deg, 4), unit: '°', hint: angleType === 'included' ? `included ${f(angle, 4)}°` : 'turned through' },
      { label: 'Bend allowance BA', value: f(BA), unit: 'mm', hint: 'neutral-axis arc' },
      { label: 'Outside setback OSSB', value: f(OSSB), unit: 'mm' },
      { label: 'Bend deduction BD', value: f(BD), unit: 'mm' },
      { label: 'Inside setback ISSB', value: f(ISSB), unit: 'mm' },
      { label: 'Bend line from end A', value: straightA < 0 ? '–' : f(straightA + BA / 2), unit: 'mm', hint: 'on the flat, to the bend centre line' },
    ],
    warnings,
    tables: [{
      title: 'Flat length at other K-factors',
      columns: ['K-factor', 'Bend allowance (mm)', 'Flat length (mm)', 'Change (mm)'],
      rows: ks.map((kk) => [f(kk, 2), f(th * (r + kk * t)), f(flatFor(kk), 5), f(flatFor(kk) - flat, 3)]),
    }],
    notes: [
      'Flat = straight parts + bend allowance; the flat length measured along the neutral axis does not stretch.',
      'Flat tolerance is about ±(0.1 to 0.2)·T per bend in practice: for a precise part, bend a test strip and back-calculate K = (BA/θ − R)/T.',
      'The inside radius in air bending depends on the die, not on the drawing: use the radius your press brake actually makes.',
    ],
  };
}
