// Shrinkage compensation: the size to make the mould, pattern or print so the part ends at size.
// Formula: the part shrinks by s of the mould size, part = mould · (1 - s), so
//   mould = part / (1 - s)                     exact (e.g. Rees, "Mold Engineering"; Beaumont, "Runner and Gating")
//   mould ≈ part · (1 + s)                     the common approximation, low by about s² · part
//   s from a test piece = (design - measured) / design
// Shrinkage values: typical linear ranges from resin data sheets (moulding), patternmaker's
// allowances (casting, e.g. Campbell "Castings" / foundry practice), and rules of thumb for FDM and clay.
import { parseEng, fmtNum } from '../kit/eng.js';

// key: [label, min %, max %, group]
const MATERIALS = {
  abs: ['ABS', 0.4, 0.7, 'Injection moulding'], pc: ['PC', 0.5, 0.7, 'Injection moulding'], pcabs: ['PC/ABS', 0.5, 0.7, 'Injection moulding'],
  pmma: ['PMMA (acrylic)', 0.3, 0.6, 'Injection moulding'], ps: ['PS (GPPS)', 0.3, 0.6, 'Injection moulding'],
  pp: ['PP', 1.0, 2.5, 'Injection moulding'], hdpe: ['HDPE', 1.5, 3.0, 'Injection moulding'], ldpe: ['LDPE', 1.5, 3.0, 'Injection moulding'],
  pom: ['POM (acetal)', 1.8, 2.5, 'Injection moulding'], pa6: ['PA6', 0.8, 1.5, 'Injection moulding'], pa66: ['PA66', 1.0, 2.0, 'Injection moulding'],
  pa66gf: ['PA66 GF30 (flow direction)', 0.3, 0.8, 'Injection moulding'], pbt: ['PBT', 1.5, 2.0, 'Injection moulding'],
  castiron: ['Grey cast iron', 0.8, 1.0, 'Casting'], caststeel: ['Cast steel', 1.5, 2.0, 'Casting'], castal: ['Aluminium alloy', 1.0, 1.5, 'Casting'],
  brass: ['Brass', 1.3, 1.5, 'Casting'], bronze: ['Bronze', 1.0, 2.0, 'Casting'], zinc: ['Zinc die casting', 0.4, 0.7, 'Casting'],
  fdmpla: ['PLA', 0.2, 0.4, 'FDM print'], fdmpetg: ['PETG', 0.3, 0.5, 'FDM print'], fdmabs: ['ABS / ASA', 0.5, 0.8, 'FDM print'], fdmpa: ['Nylon (PA)', 1.0, 1.5, 'FDM print'],
  clay: ['Stoneware clay, wet to fired', 10, 13, 'Ceramics'],
};

const r3 = (v) => Math.round(v * 1000) / 1000;

export function run({ mode, material, shrink, design, measured, dims }) {
  const warnings = [];
  let smin, smax, label;
  if (mode === 'measured') {
    if (!(design > 0) || measured == null || !(measured > 0)) return { warnings: ['Give the designed and the measured size of the test piece in mm, e.g. 100 and 99.4.'] };
    const s = ((design - measured) / design) * 100;
    if (s < 0) warnings.push(`The test piece is larger than designed (${fmtNum(-s, 3)} % growth): the correction scales down. Check the measurement.`);
    smin = smax = s; label = `measured on a ${fmtNum(design)} mm test piece`;
  } else if (mode === 'custom') {
    if (shrink == null) return { warnings: ['Give the shrinkage in %, e.g. 0.5.'] };
    smin = smax = shrink; label = 'as given';
  } else {
    const m = MATERIALS[material] || MATERIALS.abs;
    [smin, smax] = [m[1], m[2]]; label = `${m[0]}, ${m[3].toLowerCase()} (${fmtNum(smin)}-${fmtNum(smax)} %)`;
  }
  const sNom = (smin + smax) / 2;
  if (Math.abs(sNom) >= 50) return { warnings: [`A shrinkage of ${fmtNum(sNom, 3)} % is not physical for this formula: check the inputs.`] };
  if (Math.abs(sNom) > 20) warnings.push(`${fmtNum(sNom, 3)} % is a very large shrinkage: check the value.`);
  const s = sNom / 100;
  const k = 1 / (1 - s);
  const values = [
    { label: 'Shrinkage', value: `${fmtNum(sNom, 4)} %`, hint: label },
    { label: 'Scale factor', value: fmtNum(k, 6), tone: 'ok', hint: 'mould = part / (1 - s)' },
    { label: 'Scale in CAD / slicer', value: `${fmtNum(k * 100, 6)} %` },
    { label: 'Approximation 1 + s', value: fmtNum(1 + s, 6), hint: `low by ${fmtNum((k - 1 - s) * 1000, 3)} mm per metre` },
  ];
  const rows = [];
  // For the page's contraction rule (omitted for agents): every dimension as numbers, the range, the materials.
  const rule = { mode: mode === 'measured' || mode === 'custom' ? mode : 'material', material: MATERIALS[material] ? material : 'abs',
    sMin: smin, sMax: smax, sNom, k, approx: 1 + s, label, dims: [],
    test: mode === 'measured' ? { design, measured } : null,
    materials: Object.entries(MATERIALS).map(([key, m]) => ({ key, name: m[0], min: m[1], max: m[2], group: m[3] })) };
  (dims || []).forEach((r, i) => {
    const name = String(r.name || `#${i + 1}`).trim() || `#${i + 1}`;
    if (String(r.size ?? '').trim() === '') return;
    const v = parseEng(r.size);
    if (v == null || !(v > 0)) { warnings.push(`"${name}": the size "${r.size}" is not a positive number; skipped.`); return; }
    const mould = v * k;
    rule.dims.push({ index: i, name, part: v, mould, added: mould - v, lo: mould * (1 - smax / 100), hi: mould * (1 - smin / 100) });
    const row = [name, fmtNum(v, 6), fmtNum(r3(mould), 7), `+${fmtNum(r3(mould - v), 5)}`];
    if (smax > smin) {
      const lo = mould * (1 - smax / 100), hi = mould * (1 - smin / 100);
      row.push(`${fmtNum(r3(lo), 7)} … ${fmtNum(r3(hi), 7)}`, `± ${fmtNum(r3((hi - lo) / 2), 4)}`);
    }
    rows.push(row);
  });
  if (!rows.length) warnings.push('Add the part dimensions (mm) to get their corrected sizes.');
  const columns = ['Dimension', 'Part (mm)', 'Make it (mm)', 'Added'];
  if (smax > smin) columns.push(`Part if s = ${fmtNum(smax)}…${fmtNum(smin)} %`, 'Spread');
  if (smax > smin && rows.length) {
    const big = Math.max(...(dims || []).map((r) => parseEng(r.size)).filter((v) => v > 0));
    const spread = (big * k * (smax - smin)) / 200;
    values.push({ label: 'Spread from the range', value: `± ${fmtNum(r3(spread), 4)} mm`, tone: spread > 0.1 ? 'warn' : 'ok', hint: `on ${fmtNum(big)} mm` });
    if (spread > 0.1) warnings.push(`The material's shrinkage range alone moves a ${fmtNum(big)} mm dimension by ± ${fmtNum(r3(spread), 3)} mm: for tight tolerances, mould a first shot, measure, and correct the tool ("steel safe").`);
  }
  return {
    rule,
    values,
    tables: [{ title: 'Corrected dimensions (scaled at the mid shrinkage)', columns, rows }],
    warnings,
    notes: [
      'Shrinkage differs along and across the flow (fibre-filled plastics most) and with wall thickness, packing and mould temperature: use the resin data sheet for the real value.',
      'Scale every dimension, holes included: a hole shrinks with the part around it. For a mould, leave "steel safe" metal where you can still cut.',
      'FDM prints often shrink less in Z than in X/Y; calibrate each axis with a test piece if it matters.',
    ],
  };
}
