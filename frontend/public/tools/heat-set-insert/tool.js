// Heat-set (thermal) threaded insert: the hole to model and the boss around it.
// Basis:
//   Insert sizes and hole diameters: typical tapered knurled brass inserts for 3D prints
//     (Ruthex RX-M.. / CNC Kitchen standard series), confirm on your insert's data sheet.
//   Hole for an unknown insert: OD - 0.6 mm, which reproduces those data sheets within 0.2 mm
//     (rule of thumb: the knurl has to cut about 0.3 mm of plastic per side).
//   Hole depth: insert length + 1 mm, room for the plastic the insert displaces (CNC Kitchen tests).
//   Boss outer diameter: >= 2 x insert OD (Spirol / PEM / Tappex design guides for thermoplastic
//     bosses), i.e. a wall of about half the insert OD around it; 1.6 x OD is the lower limit here.
//   FDM: the wall should be solid perimeters; >= 3 lines, 4+ for pull-out strength (CNC Kitchen tests).
//   Iron temperature: about the material's printing temperature (supplier guides, rule of thumb).
import { fmtNum } from '../kit/eng.js';

// thread, OD (mm), length (mm), hole (mm)
const INSERTS = {
  m2: ['M2', 3.6, 4.0, 3.2],
  'm2.5': ['M2.5', 4.0, 5.7, 3.6],
  m3: ['M3', 4.6, 5.7, 4.0],
  'm3-short': ['M3 short', 4.6, 3.0, 4.0],
  m4: ['M4', 6.3, 8.1, 5.6],
  m5: ['M5', 7.0, 9.5, 6.4],
  m6: ['M6', 8.7, 12.7, 8.0],
};
const MATERIALS = {
  pla: ['PLA', '190-220 °C'], petg: ['PETG', '220-240 °C'], abs: ['ABS / ASA', '230-250 °C'],
  pa: ['Nylon (PA)', '250-270 °C'], pc: ['PC', '260-290 °C'], other: ['Other thermoplastic', 'per the insert supplier'],
};

const r2 = (v) => Math.round(v * 100) / 100;
const mm = (v) => `${fmtNum(r2(v))} mm`;

export function run({ insert, od, length, process, material, boss, line }) {
  const warnings = [];
  let name, OD, L, hole, fromSheet = true;
  if (insert === 'custom') {
    if (!(od > 0) || !(length > 0)) return { warnings: ['Give the insert outer (knurl) diameter and length in mm, e.g. 4.6 and 5.7.'] };
    [name, OD, L] = ['Custom insert', od, length];
    hole = OD - 0.6; fromSheet = false;
    if (OD < 2.5 || OD > 16) warnings.push(`An insert of Ø ${mm(OD)} is outside the 2.5-16 mm range the hole rule is based on: take the hole from the insert's data sheet.`);
  } else {
    [name, OD, L, hole] = INSERTS[insert] || INSERTS.m3;
  }
  const depth = L + 1;
  const bossRec = 2 * OD;
  const bossMin = 1.6 * OD;
  const mat = MATERIALS[material] || MATERIALS.pla;
  const values = [
    { label: 'Insert', value: name, hint: `Ø ${mm(OD)} x ${mm(L)}` },
    { label: 'Hole diameter', value: mm(hole), tone: 'ok', hint: fromSheet ? 'typical data-sheet value' : 'estimate: OD - 0.6 mm' },
    { label: 'Hole depth', value: `≥ ${mm(depth)}`, hint: 'length + 1 mm for displaced plastic' },
    { label: 'Boss outer Ø, recommended', value: `≥ ${mm(bossRec)}`, hint: `wall ${mm((bossRec - hole) / 2)}` },
    { label: 'Boss outer Ø, minimum', value: mm(bossMin), hint: `wall ${mm((bossMin - hole) / 2)}` },
    { label: 'Iron temperature', value: mat[1], hint: mat[0] },
  ];

  let wall = null;
  if (boss == null || boss === 0) {
    warnings.push('Give your boss outer diameter in mm to check it.');
  } else if (boss <= hole) {
    warnings.push(`A boss of Ø ${mm(boss)} is not larger than the hole (Ø ${mm(hole)}): there is no wall. Make it at least ${mm(bossMin)}.`);
  } else {
    wall = (boss - hole) / 2;
    const tone = boss >= bossRec - 1e-9 ? 'ok' : boss >= bossMin - 1e-9 ? 'warn' : 'bad';
    values.push({ label: 'Your wall', value: mm(wall), tone, hint: `boss Ø ${mm(boss)} = ${fmtNum(boss / OD, 3)} x insert OD` });
    if (tone === 'bad') warnings.push(`The wall around the insert (${mm(wall)}) is too thin: the boss will split while pressing or under torque. Make the boss at least Ø ${mm(bossMin)}, better ${mm(bossRec)}.`);
    else if (tone === 'warn') warnings.push(`The boss (Ø ${mm(boss)}) is under the recommended 2 x OD (${mm(bossRec)}): fine for light loads, add ribs or grow it for torque and pull-out.`);
  }
  if (process === 'fdm') {
    if (!(line > 0)) warnings.push('Give the extrusion line width in mm, e.g. 0.45.');
    else if (wall != null) {
      const lines = wall / line;
      values.push({ label: 'Perimeters in the wall', value: `${fmtNum(lines, 2)} lines`, tone: lines >= 4 ? 'ok' : lines >= 3 ? 'warn' : 'bad',
        hint: `set ${Math.max(3, Math.ceil(lines - 1e-9))} walls (perimeters) so the boss is all perimeters` });
      if (lines < 3) warnings.push(`Only ${fmtNum(lines, 2)} lines fit in the wall at ${mm(line)} line width: the insert will crack it. Grow the boss.`);
    }
  }
  if (L > 3 * OD) warnings.push('An insert longer than 3 x its OD is unusual: check the values.');

  const rows = Object.values(INSERTS).map(([n, o, l, h]) => [n, fmtNum(o), fmtNum(l), fmtNum(h), fmtNum(l + 1), fmtNum(r2(1.6 * o)), fmtNum(r2(2 * o))]);
  return {
    values,
    tables: [{ title: 'Common heat-set inserts (mm, typical tapered brass inserts)', columns: ['Thread', 'Insert OD', 'Length', 'Hole Ø', 'Hole depth', 'Boss Ø min', 'Boss Ø rec.'], rows }],
    texts: [{ title: 'CAD variables', lang: 'scad', body: [
      `// ${name} heat-set insert, mm`,
      `insert_od = ${fmtNum(r2(OD))};`, `insert_len = ${fmtNum(r2(L))};`, `insert_hole_d = ${fmtNum(r2(hole))};`,
      `insert_hole_depth = ${fmtNum(r2(depth))};`, `boss_d = ${fmtNum(r2(bossRec))};`].join('\n') + '\n' }],
    warnings,
    notes: [
      process === 'fdm'
        ? 'FDM: vertical holes print 0.1-0.2 mm undersize on most printers; print one test hole and adjust. A 0.5 mm 45° chamfer at the entry helps the insert start straight.'
        : 'Moulded part: hold the hole to about ±0.05 mm and keep draft under 1° over the insert length; the supplier\'s hole table wins over these values.',
      'Press with a flat tip to 0.1-0.2 mm below the surface, then hold it flat for a few seconds while the plastic sets.',
      'Values are for tapered knurled brass inserts; straight (ultrasonic or press-in) inserts need the supplier\'s hole size.',
    ],
  };
}
