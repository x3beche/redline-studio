// Mass and centre of gravity of an assembly from each part's volume,
// material and centroid.
//   m_i   = ρ_i · V_i · qty_i
//   CoG   = Σ m_i·r_i / Σ m_i          (first moment of mass; statics)
//   I_cg  = Σ m_i·(d_i² ) about axes through the CoG, point masses only
//           (parallel-axis terms; each part's own inertia about its
//           centroid is left out - a lower bound)
// A negative volume removes material (a hole or pocket) of the given
// material at its own centroid.
import { parseEng, fmtNum } from '../kit/eng.js';

// Typical densities, g/cm³ (MatWeb / supplier data).
export const DENSITY = {
  'Aluminium (6061/6082)': 2.70,
  'Aluminium die cast (A380)': 2.71,
  'Steel (carbon)': 7.85,
  'Stainless steel (304/316)': 8.00,
  'Brass': 8.50,
  'Copper': 8.94,
  'Titanium (Ti-6Al-4V)': 4.43,
  'Magnesium (AZ31)': 1.77,
  'Zinc die cast (Zamak)': 6.60,
  'ABS': 1.04,
  'PC': 1.20,
  'PA66 nylon': 1.14,
  'PA66-GF30': 1.36,
  'POM (acetal)': 1.42,
  'PMMA (acrylic)': 1.18,
  'PLA': 1.24,
  'PETG': 1.27,
  'TPU': 1.21,
  'Silicone rubber': 1.15,
  'FR-4 (bare board)': 1.85,
  'Populated PCB (average)': 2.5,
  'Li-ion cell (cylindrical)': 2.8,
  'Glass': 2.50,
  'Wood (pine)': 0.50,
  'Water': 1.00,
};
const VOL = { mm3: 1e-3, cm3: 1, in3: 16.387064, m3: 1e6 }; // to cm³
const f = (v, d = 4) => fmtNum(v, d);

export function run({ unit, infill, parts }) {
  const warnings = [];
  const toCm3 = VOL[unit] || VOL.mm3;
  const rows = Array.isArray(parts) ? parts : [];
  const good = [], bad = [];
  rows.forEach((r, i) => {
    const name = String(r.name || '').trim() || `Row ${i + 1}`;
    const V = parseEng(r.volume);
    const qty = String(r.qty ?? '').trim() === '' ? 1 : parseEng(r.qty);
    const x = parseEng(r.x) ?? 0, y = parseEng(r.y) ?? 0, z = parseEng(r.z) ?? 0;
    const own = String(r.density ?? '').trim() === '' ? null : parseEng(r.density);
    const rho = own ?? DENSITY[r.material];
    if (V == null || qty == null || !(qty >= 0) || !(rho > 0) || [r.x, r.y, r.z].some((c) => String(c ?? '').trim() !== '' && parseEng(c) == null)) {
      bad.push(name); return;
    }
    let factor = 1;
    // FDM prints are not solid: the infill fraction scales the mass of printed plastics.
    if (infill < 100 && own == null && ['PLA', 'PETG', 'ABS', 'TPU'].includes(r.material)) factor = infill / 100;
    const m = rho * V * toCm3 * qty * factor; // g
    good.push({ name, V: V * qty, rho, m, x, y, z, qty, factor, mat: own != null ? `ρ ${f(own)}` : r.material });
  });
  if (bad.length) warnings.push(`Skipped rows with a missing or non-numeric volume, quantity, coordinate or density (or no material): ${bad.join(', ')}.`);
  if (!good.length) return { warnings: [...warnings, 'Add at least one part with a volume and a material.'] };
  const M = good.reduce((s, p) => s + p.m, 0);
  if (!(M > 0)) return { warnings: [...warnings, 'The total mass is zero or negative: the removed volumes (negative rows) are bigger than the solid ones. Check the signs.'] };
  const cog = ['x', 'y', 'z'].map((k) => good.reduce((s, p) => s + p.m * p[k], 0) / M);
  const [cx, cy, cz] = cog;
  // Point-mass inertia about the CoG, g·mm² -> kg·m² (1e-9)
  const I = { xx: 0, yy: 0, zz: 0 };
  for (const p of good) {
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    I.xx += p.m * (dy * dy + dz * dz); I.yy += p.m * (dx * dx + dz * dz); I.zz += p.m * (dx * dx + dy * dy);
  }
  const Vt = good.reduce((s, p) => s + p.V, 0);
  const neg = good.filter((p) => p.m < 0);
  const lowSolid = good.some((p) => p.factor < 1);
  const heavy = [...good].sort((a, b) => b.m - a.m)[0];
  const massStr = M >= 1000 ? `${f(M / 1000)} kg` : `${f(M)} g`;
  return {
    values: [
      { label: 'Total mass', value: M >= 1000 ? f(M / 1000) : f(M), unit: M >= 1000 ? 'kg' : 'g', tone: 'ok' },
      { label: 'CoG x', value: f(cx), unit: 'mm' },
      { label: 'CoG y', value: f(cy), unit: 'mm' },
      { label: 'CoG z', value: f(cz), unit: 'mm' },
      { label: 'Net volume', value: f(Vt * toCm3), unit: 'cm³' },
      { label: 'Average density', value: f(M / (Vt * toCm3)), unit: 'g/cm³' },
      { label: 'Heaviest part', value: heavy.name, hint: `${f(heavy.m)} g, ${f((heavy.m / M) * 100, 3)} %` },
    ],
    warnings,
    tables: [
      {
        title: 'Parts',
        columns: ['Part', 'Material', 'Qty', `Volume (${unit === 'cm3' ? 'cm³' : unit === 'in3' ? 'in³' : unit === 'm3' ? 'm³' : 'mm³'}, total)`, 'Density (g/cm³)', 'Mass (g)', 'Share', 'Centroid (mm)'],
        rows: good.map((p) => [p.name, p.factor < 1 ? `${p.mat}, ${infill} % infill` : p.mat, p.qty, f(p.V), f(p.rho, 3), f(p.m), `${f((p.m / M) * 100, 3)} %`, `(${f(p.x)}, ${f(p.y)}, ${f(p.z)})`]),
      },
      {
        title: 'Moments of inertia about the CoG (point masses, lower bound)',
        columns: ['Axis', 'I (kg·mm²)', 'I (kg·m²)', 'Radius of gyration (mm)'],
        rows: [['x', I.xx], ['y', I.yy], ['z', I.zz]].map(([a, v]) => [a, f(v * 1e-3), v > 0 ? (v * 1e-9).toExponential(3) : '0', f(Math.sqrt(v / M))]),
      },
    ],
    texts: [{ title: 'Summary', body: `Mass ${massStr}\nCoG (${f(cx)}, ${f(cy)}, ${f(cz)}) mm\n` + good.map((p) => `${p.name}: ${f(p.m)} g at (${f(p.x)}, ${f(p.y)}, ${f(p.z)})`).join('\n') + '\n' }],
    notes: [
      'Each row is a lumped mass at its centroid: give a group of identical parts (qty) the centroid of the whole group.',
      'Negative volumes remove material (holes, pockets) at their own centroid.',
      ...(neg.length ? [`Removed: ${neg.map((p) => p.name).join(', ')}.`] : []),
      ...(lowSolid ? [`Printed plastic rows are scaled by ${infill} % infill; walls make a real print heavier, so weigh a test part if it matters.`] : []),
      'Inertia counts only the parts\' distances from the CoG; a part\'s own size adds to it (a box adds m(a²+b²)/12).',
    ],
  };
}
