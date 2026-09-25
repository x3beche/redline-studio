// Cantilever snap-fit, rectangular section, after Bayer MaterialScience
// "Snap-Fit Joints for Plastics - A Design Guide" (cantilever design equations):
//   shape A, constant thickness h:        y = 0.67 * eps * l^2 / h
//   shape B, thickness tapers to h/2:     y = 1.09 * eps * l^2 / h
//   deflection force   P = (b * h^2 / 6) * Es * eps / l      (Es = secant modulus)
//   mating force       W = P * (mu + tan a) / (1 - mu * tan a)
// and the same with the retaining angle a' for the separation force.
import { fmtNum } from '../kit/eng.js';

const DEG = Math.PI / 180;

// Permissible short-term strain for a single assembly (Bayer table, rounded),
// secant modulus near that strain and friction against steel (Bayer table,
// mid-range). Approximate: check the grade's datasheet.
const MATERIALS = {
  abs: { name: 'ABS', eps: 2.5, es: 2.0, mu: 0.6 },
  pc: { name: 'PC', eps: 4.0, es: 2.0, mu: 0.5 },
  pcabs: { name: 'PC/ABS', eps: 3.0, es: 2.0, mu: 0.55 },
  pbt: { name: 'PBT', eps: 5.0, es: 2.2, mu: 0.38 },
  pom: { name: 'POM (acetal)', eps: 6.0, es: 2.2, mu: 0.28 },
  pa6: { name: 'PA6, conditioned', eps: 6.0, es: 0.9, mu: 0.35 },
  pa6gf: { name: 'PA6 GF30, conditioned', eps: 2.0, es: 5.5, mu: 0.35 },
  pp: { name: 'PP', eps: 8.0, es: 1.0, mu: 0.28 },
  custom: { name: 'Custom', eps: null, es: null, mu: 0.4 },
};

export function run({ material, shape, l, h, b, y, alpha, alpha2, mu, repeated, es, eps }) {
  const warnings = [];
  const m = MATERIALS[material] || MATERIALS.abs;
  if (!(l > 0) || !(h > 0) || !(b > 0)) return { warnings: ['Give the arm length, root thickness and width in mm, all above zero.'] };
  if (!(y > 0)) return { warnings: ['Give the deflection (the undercut depth the hook has to clear) in mm, above zero.'] };
  const Es = material === 'custom' ? es : m.es; // GPa
  let epsPerm = material === 'custom' ? eps : m.eps; // %
  if (!(Es > 0)) return { warnings: ['Give the secant modulus of your material in GPa, e.g. 2.'] };
  if (!(epsPerm > 0)) return { warnings: ['Give the permissible strain of your material in %, e.g. 2.5.'] };
  if (repeated) epsPerm *= 0.6; // Bayer: about 60 % of the single-assembly strain for frequent assembly
  const f = mu != null && Number.isFinite(mu) ? mu : m.mu;
  if (f < 0 || f > 1.5) warnings.push('A friction coefficient outside 0-1.5 is unusual: check it.');
  const a = Number.isFinite(alpha) ? alpha : 30;
  const a2 = Number.isFinite(alpha2) ? alpha2 : 90;

  const k = shape === 'tapered' ? 1.09 : 0.67; // Bayer deflection factor
  const strain = (y * h) / (k * l * l); // fraction
  const yAllow = (k * (epsPerm / 100) * l * l) / h; // mm
  const P = ((b * h * h) / 6) * (Es * 1000) * strain / l; // N  (Es in N/mm^2)
  const mate = (ang) => {
    const t = Math.tan(ang * DEG);
    const den = 1 - f * t;
    return den <= 1e-9 ? null : P * (f + t) / den;
  };
  const W = a >= 90 ? null : mate(a);
  const R = a2 >= 90 ? null : mate(a2);
  const pct = strain * 100;
  const tone = pct <= epsPerm ? 'ok' : 'bad';

  if (a <= 0 || a >= 90) warnings.push('The lead-in angle must be between 0 and 90 degrees; 20-35° is usual.');
  else if (W == null) warnings.push(`At ${fmtNum(a, 3)}° with µ = ${fmtNum(f, 3)} the hook locks instead of sliding in: use a shallower lead-in angle.`);
  if (pct > epsPerm) warnings.push(`Strain ${fmtNum(pct, 3)} % is over the ${fmtNum(epsPerm, 3)} % allowed: make the arm longer, thinner at the root, or use the tapered shape.`);
  if (l / h < 5) warnings.push(`The arm is short for its thickness (l/h = ${fmtNum(l / h, 3)}): beam theory underestimates the root strain below about l/h = 5.`);
  if (y > 0.3 * l) warnings.push('The deflection is large for the arm length (over 30 %): small-deflection beam theory is no longer accurate.');

  const values = [
    { label: 'Root strain', value: fmtNum(pct, 3), unit: '%', tone, hint: `allowed ${fmtNum(epsPerm, 3)} %${repeated ? ' (60 % for repeated assembly)' : ''}` },
    { label: 'Allowed deflection', value: fmtNum(yAllow, 3), unit: 'mm', hint: 'at the permissible strain' },
    { label: 'Deflection force P', value: fmtNum(P, 3), unit: 'N', hint: 'to bend the hook by y' },
    { label: 'Insertion force W', value: W == null ? 'locks' : fmtNum(W, 3), unit: W == null ? '' : 'N', tone: W == null ? 'bad' : undefined, hint: `lead-in ${fmtNum(a, 3)}°, µ ${fmtNum(f, 3)}` },
    { label: 'Separation force', value: R == null ? 'self-locking' : fmtNum(R, 3), unit: R == null ? '' : 'N', tone: R == null ? 'ok' : undefined,
      hint: R == null ? `retaining ${fmtNum(a2, 3)}°: only breaks by overload` : `retaining angle ${fmtNum(a2, 3)}°` },
    { label: 'Root stress (approx.)', value: fmtNum(Es * 1000 * strain, 3), unit: 'MPa', hint: 'Es × strain' },
  ];

  // Everything the page draws, as numbers (manifest agentOmit: "hook").
  // The insertion stroke: the lead-in ramp lifts the hook by u * tan(a) until
  // it has cleared the undercut, then it drags over the lip at mu * P, then it
  // drops in. Pulling out, the retaining face does the same with a'.
  const lip = Math.max(1.5, h); // lip thickness drawn and used for the drag plateau
  const tIn = a > 0 && a < 90 ? y / Math.tan(a * DEG) : 0;
  const tOut = a2 > 0 && a2 < 90 ? y / Math.tan(a2 * DEG) : 0;
  const drag = f * P;
  const sample = (travel, Fpeak, n) => Array.from({ length: n + 1 }, (_, i) => {
    const u = (travel * i) / n, d = travel > 0 ? (y * i) / n : y;
    return { u, defl: d, strain: (d * h) / (k * l * l) * 100, F: Fpeak == null ? null : (Fpeak * i) / n };
  });
  const push = [...sample(tIn, W, 24), { u: tIn + lip, defl: y, strain: pct, F: W == null ? null : drag, drag: true }];
  const pull = a2 >= 90 ? [] : [...sample(tOut, R, 24), { u: tOut + lip, defl: y, strain: pct, F: R == null ? null : drag, drag: true }];
  // Strain along the arm, as a share of the root strain (constant: falls
  // linearly to the hook; tapered: M / h(x)^2 stays nearly level).
  const along = Array.from({ length: 21 }, (_, i) => {
    const xi = i / 20;
    const hx = shape === 'tapered' ? 1 - xi / 2 : 1;
    const r = (1 - xi) / (hx * hx);
    return { x: xi * l, h: h * hx, strain: pct * r };
  });
  const hook = {
    material, materialName: m.name, shape, l, h, b, y, k, alpha: a, alpha2: a2, mu: f, muDefault: m.mu, Es, epsPerm, epsSingle: material === 'custom' ? eps : m.eps,
    repeated: !!repeated, fillet: 0.5 * h, strain: pct, yAllow, P, W, R, drag, stress: Es * 1000 * strain, lip, tIn, tOut, push, pull, along,
    ok: pct <= epsPerm,
    materials: Object.entries(MATERIALS).filter(([id]) => id !== 'custom').map(([id, x]) => ({
      id, name: x.name, eps: x.eps * (repeated ? 0.6 : 1), es: x.es, mu: x.mu,
      P: ((b * h * h) / 6) * (x.es * 1000) * strain / l, ok: pct <= x.eps * (repeated ? 0.6 : 1) })),
  };

  // How the numbers change with the arm length: helps pick a length.
  const lens = [0.6, 0.8, 1, 1.25, 1.5, 2].map((s) => l * s);
  return {
    values,
    warnings,
    hook,
    tables: [{
      title: `Other arm lengths (h ${fmtNum(h, 3)} mm, y ${fmtNum(y, 3)} mm)`,
      columns: ['Length', 'Strain', 'Deflection force', 'Insertion force', 'OK?'],
      rows: lens.map((L) => {
        const s = (y * h) / (k * L * L);
        const p = ((b * h * h) / 6) * (Es * 1000) * s / L;
        const t = Math.tan(a * DEG);
        const den = 1 - f * t;
        const w = a > 0 && a < 90 && den > 1e-9 ? `${fmtNum(p * (f + t) / den, 3)} N` : '–';
        return [`${fmtNum(L, 3)} mm`, `${fmtNum(s * 100, 3)} %`, `${fmtNum(p, 3)} N`, w, s * 100 <= epsPerm ? 'yes' : 'no'];
      }),
    }],
    notes: [
      'Assumes a rigid base; the real root flexes a little, so the strain is somewhat lower than shown (conservative).',
      'Give the root a fillet of at least 0.5 × h: a sharp corner concentrates stress far above this estimate.',
      `Friction is against steel by default (${m.name}: ${fmtNum(m.mu, 3)}); plastic on plastic is usually higher, so raise µ for a moulded mating part.`,
      'Material data are typical values: take the permissible strain and secant modulus from the grade datasheet for a final design.',
    ],
  };
}
