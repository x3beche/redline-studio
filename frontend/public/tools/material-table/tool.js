// Typical room-temperature properties of common engineering materials,
// filtered and sorted. Values are typical datasheet values (MatWeb, ASM
// Handbook, supplier datasheets) for the named condition, not minimums:
// use the supplier's certified values for a strength calculation.
//   specific stiffness = E / ρ    (GPa per g/cm³, i.e. MN·m/kg)
//   specific strength  = Sy / ρ   (MPa per g/cm³, i.e. kN·m/kg)
import { fmtNum } from '../kit/eng.js';

// id, name, category, condition, density g/cm³, E GPa, yield MPa (null: brittle / none),
// UTS MPa, CTE µm/(m·K) near 20-100 °C, thermal conductivity W/(m·K)
export const MATERIALS = [
  ['al6061', 'Aluminium 6061-T6', 'metal', 'wrought, T6', 2.70, 68.9, 276, 310, 23.6, 167],
  ['al6082', 'Aluminium 6082-T6', 'metal', 'wrought, T6', 2.70, 70, 260, 310, 23.4, 170],
  ['al5052', 'Aluminium 5052-H32', 'metal', 'sheet, H32', 2.68, 70.3, 193, 228, 23.8, 138],
  ['al7075', 'Aluminium 7075-T6', 'metal', 'wrought, T6', 2.81, 71.7, 503, 572, 23.6, 130],
  ['a380', 'Aluminium A380 die cast', 'metal', 'as cast', 2.71, 71, 160, 324, 21.8, 96],
  ['s235', 'Steel S235 / A36', 'metal', 'hot rolled', 7.85, 200, 235, 400, 12.0, 50],
  ['c1018', 'Steel 1018', 'metal', 'cold drawn', 7.87, 205, 370, 440, 11.5, 51.9],
  ['c4140', 'Steel 4140', 'metal', 'quenched and tempered', 7.85, 205, 655, 1020, 12.3, 42.6],
  ['ss304', 'Stainless 304', 'metal', 'annealed', 8.00, 193, 215, 505, 17.3, 16.2],
  ['ss316', 'Stainless 316', 'metal', 'annealed', 8.00, 193, 205, 515, 16.0, 16.3],
  ['ss174', 'Stainless 17-4PH', 'metal', 'H900', 7.78, 197, 1170, 1310, 10.8, 18.3],
  ['brass', 'Brass C360', 'metal', 'half hard', 8.50, 97, 310, 385, 20.5, 115],
  ['cu110', 'Copper C110', 'metal', 'half hard', 8.94, 115, 250, 290, 17.0, 388],
  ['becu', 'Beryllium copper C17200', 'metal', 'TH04 (hardened)', 8.25, 128, 1100, 1310, 17.8, 105],
  ['ti64', 'Titanium Ti-6Al-4V', 'metal', 'annealed', 4.43, 114, 880, 950, 8.6, 6.7],
  ['az31', 'Magnesium AZ31B', 'metal', 'H24 sheet', 1.77, 45, 220, 290, 26.0, 96],
  ['zamak3', 'Zinc Zamak 3', 'metal', 'die cast', 6.60, 96, 221, 283, 27.4, 113],
  ['invar', 'Invar 36', 'metal', 'annealed', 8.05, 141, 276, 490, 1.3, 10.4],
  ['kovar', 'Kovar (ASTM F15)', 'metal', 'annealed', 8.36, 138, 345, 517, 5.5, 17.3],
  ['abs', 'ABS', 'plastic', 'moulded', 1.04, 2.3, 40, 44, 90, 0.17],
  ['pc', 'Polycarbonate (PC)', 'plastic', 'moulded', 1.20, 2.35, 62, 65, 68, 0.20],
  ['pcabs', 'PC/ABS', 'plastic', 'moulded', 1.14, 2.4, 53, 55, 75, 0.20],
  ['pa66', 'Nylon PA66', 'plastic', 'dry as moulded', 1.14, 3.0, 82, 85, 80, 0.25],
  ['pa66gf', 'Nylon PA66-GF30', 'plastic', 'dry, in flow direction', 1.36, 9.5, null, 190, 25, 0.35],
  ['pa12', 'Nylon PA12 (SLS)', 'plastic', 'printed, XY', 1.01, 1.7, null, 48, 110, 0.22],
  ['pom', 'Acetal POM-H (Delrin)', 'plastic', 'moulded', 1.42, 3.1, 71, 71, 110, 0.37],
  ['pmma', 'Acrylic PMMA', 'plastic', 'cast sheet', 1.18, 3.2, null, 70, 70, 0.19],
  ['peek', 'PEEK', 'plastic', 'unfilled', 1.30, 3.6, 97, 100, 47, 0.25],
  ['ptfe', 'PTFE', 'plastic', 'unfilled', 2.17, 0.5, 10, 25, 125, 0.25],
  ['hdpe', 'HDPE', 'plastic', 'moulded', 0.95, 1.0, 26, 30, 150, 0.45],
  ['pp', 'Polypropylene (PP)', 'plastic', 'homopolymer', 0.905, 1.5, 33, 35, 120, 0.20],
  ['pla', 'PLA (FDM print)', 'plastic', 'printed, along layers', 1.24, 3.5, null, 55, 68, 0.13],
  ['petg', 'PETG (FDM print)', 'plastic', 'printed, along layers', 1.27, 2.0, 48, 50, 68, 0.20],
  ['asa', 'ASA (FDM print)', 'plastic', 'printed, along layers', 1.07, 2.0, 40, 42, 95, 0.17],
  ['fr4', 'FR-4 laminate', 'electronics', 'in plane (x/y); z ≈ 50-70 ppm/K', 1.85, 22, null, 310, 15, 0.30],
  ['alu96', 'Alumina 96 %', 'ceramic', 'sintered, flexural strength', 3.72, 300, null, 350, 7.1, 24],
  ['si', 'Silicon', 'electronics', 'single crystal ⟨110⟩, brittle', 2.33, 169, null, null, 2.6, 149],
  ['sac305', 'Solder SAC305', 'electronics', 'as solidified', 7.38, 51, 40, 50, 21.7, 58],
  ['boro', 'Borosilicate glass', 'ceramic', 'annealed', 2.23, 64, null, 50, 3.3, 1.14],
  ['soda', 'Soda-lime glass', 'ceramic', 'annealed', 2.50, 72, null, 45, 9.0, 1.0],
  ['cfrp', 'CFRP quasi-isotropic', 'composite', 'laminate, in plane', 1.60, 60, null, 600, 2.0, 5],
  ['gfrp', 'GFRP quasi-isotropic', 'composite', 'laminate, in plane', 1.90, 20, null, 250, 12, 0.35],
].map(([id, name, cat, cond, rho, E, sy, uts, cte, k]) => ({ id, name, cat, cond, rho, E, sy, uts, cte, k }));

const COLS = {
  rho: 'Density (g/cm³)', E: 'Young\'s modulus (GPa)', sy: 'Yield (MPa)', uts: 'Tensile (MPa)',
  cte: 'CTE (ppm/K)', k: 'Conductivity (W/m·K)', spE: 'E/ρ (GPa·cm³/g)', spS: 'Sy/ρ (MPa·cm³/g)',
};
const f = (v, d = 3) => (v == null || !Number.isFinite(v) ? '–' : fmtNum(v, d));
const derive = (m) => ({ ...m, spE: m.E / m.rho, spS: m.sy != null ? m.sy / m.rho : null });

export function run({ category, filter, sort, focus, compare }) {
  const warnings = [];
  const all = MATERIALS.map(derive);
  const q = String(filter || '').trim().toLowerCase();
  let rows = all.filter((m) => (!category || category === 'all' || m.cat === category)
    && (!q || `${m.name} ${m.cond} ${m.cat} ${m.id}`.toLowerCase().includes(q)));
  if (!rows.length) warnings.push(`Nothing matches "${filter}"${category && category !== 'all' ? ` in ${category}` : ''}: clear the filter or pick All.`);
  const key = COLS[sort] ? sort : 'name';
  rows = [...rows].sort((a, b) => (key === 'name' ? a.name.localeCompare(b.name)
    : (b[key] ?? -Infinity) - (a[key] ?? -Infinity)));

  const A = all.find((m) => m.id === focus) || all[0];
  const B = compare && compare !== 'none' ? all.find((m) => m.id === compare) : null;
  const values = [
    { label: `${A.name}: density`, value: f(A.rho), unit: 'g/cm³' },
    { label: 'Young\'s modulus', value: f(A.E), unit: 'GPa' },
    { label: 'Yield strength', value: f(A.sy), unit: 'MPa', hint: A.sy == null ? 'brittle / no clear yield' : A.cond },
    { label: 'Tensile strength', value: f(A.uts), unit: 'MPa', hint: A.cat === 'ceramic' || A.id === 'si' ? 'flexural / fracture, scatters widely' : null },
    { label: 'Thermal expansion', value: f(A.cte), unit: 'ppm/K' },
    { label: 'Thermal conductivity', value: f(A.k), unit: 'W/(m·K)' },
  ];
  const tables = [];
  if (B) {
    const ratio = (x, y) => (x != null && y != null && y !== 0 ? `${f(x / y, 3)}×` : '–');
    tables.push({
      title: `${A.name} against ${B.name}`,
      columns: ['Property', A.name, B.name, 'Ratio A/B'],
      rows: Object.entries(COLS).map(([k2, lab]) => [lab, f(A[k2]), f(B[k2]), ratio(A[k2], B[k2])]),
    });
    const dcte = Math.abs(A.cte - B.cte);
    values.push({ label: 'CTE mismatch A−B', value: f(dcte), unit: 'ppm/K', tone: dcte > 10 ? 'warn' : 'ok',
      hint: `${f(dcte, 3)} µm of difference per 100 mm per 10 K` });
    values.push({ label: 'Same part in B weighs', value: f(B.rho / A.rho, 3), unit: '× A' });
  }
  tables.push({
    title: `Materials (${rows.length} of ${all.length}), sorted by ${key === 'name' ? 'name' : COLS[key]}`,
    columns: ['Material', 'Condition', ...Object.values(COLS)],
    rows: rows.map((m) => [m.name, m.cond, f(m.rho), f(m.E), f(m.sy), f(m.uts), f(m.cte), f(m.k), f(m.spE), f(m.spS)]),
  });
  const charts = key !== 'name' && rows.length > 1 && rows.length <= 16 ? [{
    title: COLS[key], type: 'bars', x: rows.map((m) => m.name.replace(/ \(.*\)$/, '')),
    series: [{ name: COLS[key], y: rows.map((m) => (m[key] == null ? NaN : Number(f(m[key])))) }],
  }] : [];
  // For the page's chart only (manifest agentOmit): every material with its
  // derived values, and whether the category and filter keep it.
  const kept = new Set(rows.map((m) => m.id));
  const points = all.map((m) => ({ ...m, shown: kept.has(m.id) }));
  return {
    values, tables, charts, warnings, points,
    notes: [
      'Typical room-temperature values for the named condition. Strength varies with temper, thickness and supplier: design with certified minimums (e.g. EN 573/755, ASTM B221) and a safety factor.',
      'Plastics: modulus and strength fall steeply with temperature and (for nylon) with moisture; 3D-printed parts are weaker across layers (often 50-70 % of the in-layer value).',
      'CTE is the mean over roughly 20-100 °C; FR-4 is given in plane, its z-axis CTE is 3-4× higher below Tg.',
    ],
  };
}
