// Mass and centre of gravity of a populated board: laminate + copper + solder
// mask + the parts listed (each at its own x, y, height, side).
//
//   Laminate   m = W · H · t · ρ                           ρ from the laminate datasheets below
//   Copper     m = W · H · coverage · oz · 305.15 g/m²     1 oz/ft² = 28.3495 g / 0.092903 m² (IPC-4562 nominal
//                                                           foil weights; 1 oz ≈ 34.8 µm of 8.93 g/cm³ copper)
//   Mask       m = W · H · 20 µm · 1.4 g/cm³ per side      LPI mask, typical dry thickness (rule of thumb)
//   CoG        r = Σ mᵢ rᵢ / Σ mᵢ                          first moment of mass; the bare board, its copper and
//                                                           mask sit at the rectangle's centre, mid-thickness
import { fmtNum } from '../kit/eng.js';

// g/cm³
const MATERIALS = {
  fr4: { name: 'FR-4 (standard / high-Tg)', rho: 1.85, src: 'typical FR-4 laminate, 1.8-1.9 g/cm³ (Isola, Kingboard data sheets)' },
  ro4350b: { name: 'Rogers RO4350B', rho: 1.86, src: 'Rogers RO4350B data sheet' },
  ptfe: { name: 'PTFE / glass (RT/duroid 5880)', rho: 2.2, src: 'Rogers RT/duroid 5880 data sheet' },
  polyimide: { name: 'Polyimide (flex)', rho: 1.42, src: 'DuPont Kapton HN data sheet' },
  ims: { name: 'Aluminium IMS (metal core)', rho: 2.6, src: 'aluminium 2.70 g/cm³ with a thin dielectric; approximate' },
  cem1: { name: 'CEM-1 / FR-2 (paper based)', rho: 1.6, src: 'typical, 1.4-1.8 g/cm³' },
};
const OZ = 305.15; // g/m² per oz/ft²
const MASK = 20e-6 * 1.4e6; // g/m² per side = 28

export function run({ width, height, thick, material, layers, outerOz, innerOz, outerCov, innerCov, mask, parts }) {
  const warnings = [];
  const notes = [];
  if (!(width > 0) || !(height > 0) || !(thick > 0)) return { warnings: ['Give board width, height and thickness in mm, all above zero.'] };
  const mat = MATERIALS[material] || MATERIALS.fr4;
  const nL = Math.max(1, Math.round(Number(layers) || 2));
  const area = (width * height) / 1e6; // m²
  const pct = (v, d) => (Number.isFinite(v) && v >= 0 && v <= 100 ? v / 100 : (warnings.push(`Copper coverage must be 0-100 %; using ${d} %.`), d / 100));
  const oc = pct(outerCov, 60), ic = pct(innerCov, 90);
  const oOz = outerOz > 0 ? outerOz : 1, iOz = innerOz > 0 ? innerOz : 0.5;

  const lam = width * height * thick / 1000 * mat.rho; // mm³ -> cm³ -> g
  const nOuter = Math.min(2, nL), nInner = Math.max(0, nL - 2);
  const cu = area * OZ * (nOuter * oOz * oc + nInner * iOz * ic);
  const mk = mask ? area * MASK * 2 : 0;
  const board = lam + cu + mk;

  // Parts: x, y from the board's lower-left corner; z from the board's bottom face.
  const rows = Array.isArray(parts) ? parts : [];
  const good = [];
  const bad = [];
  rows.forEach((r, i) => {
    const m = Number(String(r.mass ?? '').replace(',', '.'));
    const x = Number(String(r.x ?? '').replace(',', '.'));
    const y = Number(String(r.y ?? '').replace(',', '.'));
    const hh = r.h === '' || r.h == null ? 0 : Number(String(r.h).replace(',', '.'));
    const name = String(r.ref || `row ${i + 1}`);
    if (!(m >= 0) || !Number.isFinite(x) || !Number.isFinite(y) || !(hh >= 0)) { bad.push(name); return; }
    const bottom = String(r.side).toLowerCase().startsWith('b');
    const z = bottom ? -hh / 2 : thick + hh / 2;
    if (x < 0 || x > width || y < 0 || y > height) warnings.push(`${name} at (${fmtNum(x, 4)}, ${fmtNum(y, 4)}) mm is off the ${fmtNum(width, 4)} × ${fmtNum(height, 4)} mm board: check its position (origin is the lower-left corner).`);
    good.push({ ref: name, m, x, y, z, h: hh, side: bottom ? 'bottom' : 'top' });
  });
  if (bad.length) warnings.push(`Skipped rows with a missing or non-numeric mass, x, y or height: ${bad.join(', ')}.`);

  const partsMass = good.reduce((s, p) => s + p.m, 0);
  const total = board + partsMass;
  const mx = board * width / 2 + good.reduce((s, p) => s + p.m * p.x, 0);
  const my = board * height / 2 + good.reduce((s, p) => s + p.m * p.y, 0);
  const mz = board * thick / 2 + good.reduce((s, p) => s + p.m * p.z, 0);
  const cog = { x: mx / total, y: my / total, z: mz / total };
  const dx = cog.x - width / 2, dy = cog.y - height / 2;
  const off = Math.hypot(dx / width, dy / height);
  if (off > 0.15) notes.push(`The centre of gravity is ${fmtNum(Math.hypot(dx, dy), 3)} mm from the board centre: put a mounting point or standoff near it, and check the heaviest parts for vibration and drop (a heavy part far from supports loads its solder joints).`);
  const heavy = good.filter((p) => p.m >= 5 && p.side === 'bottom');
  if (heavy.length) warnings.push(`${heavy.map((p) => p.ref).join(', ')} ${heavy.length > 1 ? 'weigh' : 'weighs'} 5 g or more on the bottom side: in a second reflow they can drop off. Glue them, place them on top, or solder them by hand/wave.`);

  const share = (m) => `${fmtNum((100 * m) / total, 3)} %`;
  return {
    values: [
      { label: 'Total mass', value: fmtNum(total, 4), unit: 'g', tone: 'ok' },
      { label: 'Bare board', value: fmtNum(board, 4), unit: 'g', hint: `${share(board)} of total` },
      { label: 'Parts', value: fmtNum(partsMass, 4), unit: 'g', hint: `${good.length} row${good.length === 1 ? '' : 's'}` },
      { label: 'CoG x', value: fmtNum(cog.x, 4), unit: 'mm', hint: `${dx >= 0 ? '+' : ''}${fmtNum(dx, 3)} from centre` },
      { label: 'CoG y', value: fmtNum(cog.y, 4), unit: 'mm', hint: `${dy >= 0 ? '+' : ''}${fmtNum(dy, 3)} from centre` },
      { label: 'CoG z', value: fmtNum(cog.z, 4), unit: 'mm', hint: 'above the board\'s bottom face' },
    ],
    warnings,
    tables: [
      { title: 'Mass breakdown', columns: ['Item', 'Mass (g)', 'Share', 'Basis'], rows: [
        ['Laminate', fmtNum(lam, 4), share(lam), `${fmtNum(width, 4)} × ${fmtNum(height, 4)} × ${fmtNum(thick, 3)} mm, ${mat.rho} g/cm³ (${mat.name})`],
        ['Copper', fmtNum(cu, 4), share(cu), `${nOuter} outer at ${fmtNum(oOz, 3)} oz, ${Math.round(oc * 100)} %; ${nInner} inner at ${fmtNum(iOz, 3)} oz, ${Math.round(ic * 100)} %`],
        ['Solder mask', fmtNum(mk, 3), share(mk), mask ? '2 sides, 20 µm LPI' : 'none'],
        ...good.map((p) => [p.ref, fmtNum(p.m, 4), share(p.m), `(${fmtNum(p.x, 4)}, ${fmtNum(p.y, 4)}) mm, ${p.side}, ${fmtNum(p.h, 3)} mm tall`]),
      ] },
    ],
    notes: [...notes,
      'Origin: lower-left corner of the board seen from the top, x to the right, y up; z from the bottom face of the board. Each part is taken as a point at its body centre (half its height above or below the board).',
      'The board is taken as a full rectangle: holes and cut-outs are not subtracted (a few % high for a drilled board). Plating and surface finish add under 1 %.',
      'Group many small parts into one row at their centroid (e.g. all passives ≈ 0.001-0.01 g each).',
      `Laminate density: ${mat.src}.`],
    drawing: { w: width, h: height, parts: good.map((p) => ({ ref: p.ref, x: p.x, y: p.y, m: p.m, side: p.side })), cog: { x: cog.x, y: cog.y } },
  };
}
