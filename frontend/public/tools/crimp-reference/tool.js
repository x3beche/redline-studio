// Terminal blocks, ferrules and crimp terminals that take a given wire size.
// Data (typical values; always confirm on the part's data sheet):
//   Ferrules: DIN 46228-4 colour code, Phoenix Contact AI series sizes and pin lengths.
//   Insulated crimp terminals: the red / blue / yellow colour code of IEC 61238 / UL 486A-B
//     practice (0.5-1.5 / 1.5-2.5 / 4-6 mm²).
//   Tube cable lugs: DIN 46235 sizes.
//   PCB and DIN-rail terminal blocks: Phoenix Contact MPT/MKDS/MSTB/UT catalogue ranges.
//   Wire-to-board crimp housings: JST, Molex, TE and Anderson data sheets (wire range, current per contact).
// AWG <-> mm²: d = 0.127 mm · 92^((36 - n) / 39), ASTM B258.
import { fmtNum } from '../kit/eng.js';

const awgArea = (n) => { const d = 0.127 * Math.pow(92, (36 - n) / 39); return (Math.PI * d * d) / 4; };
const awgName = (n) => (n > 0 ? `${n}` : `${1 - n}/0`);
// Wire is sold in even gauges up to 2 AWG, then every size: match against those.
const GAUGES = [40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 3, 2, 1, 0, -1, -2, -3];
const nearestAwg = (a) => GAUGES.reduce((b, n) => (Math.abs(Math.log(awgArea(n) / a)) < Math.abs(Math.log(awgArea(b) / a)) ? n : b), 40);
const awgRange = (a0, a1) => `${awgName(nearestAwg(a1))}-${awgName(nearestAwg(a0))}`;

// DIN 46228-4 ferrules: mm², colour, pin (metal sleeve) length mm = strip length
const FERRULES = [
  [0.25, 'light blue', 8], [0.34, 'turquoise', 8], [0.5, 'white', 8], [0.75, 'grey', 8], [1, 'red', 8], [1.5, 'black', 8],
  [2.5, 'blue', 8], [4, 'grey', 10], [6, 'yellow', 12], [10, 'red', 12], [16, 'blue', 12], [25, 'yellow', 16], [35, 'red', 16], [50, 'blue', 20],
];
const INSULATED = [[0.5, 1.5, 'red', 'M3-M6 rings, 2.8/4.8/6.3 mm blades'], [1.5, 2.5, 'blue', 'M3-M8 rings, 4.8/6.3 mm blades'], [4, 6, 'yellow', 'M4-M10 rings, 6.3/9.5 mm blades']];
const LUGS = [6, 10, 16, 25, 35, 50, 70, 95, 120];

// category, name, pitch / type, min mm², max mm², rated current (A), note
const METRIC_ROWS = [
  ['PCB terminal block', 'Screw / spring, 2.54 mm (e.g. Phoenix MPT 0,5)', '2.54 mm', 0.14, 0.5, 6, 'Signals only; strip 5 mm.'],
  ['PCB terminal block', 'Screw, 3.5 mm (e.g. Phoenix MPT 1,5 / MKDS 1/..-3,5)', '3.5 mm', 0.14, 1.5, 8, 'Strip 5-6 mm.'],
  ['PCB terminal block', 'Pluggable, 3.81 mm (e.g. Phoenix MC 1,5)', '3.81 mm', 0.14, 1.5, 8, 'Strip 7 mm.'],
  ['PCB terminal block', 'Screw / pluggable, 5.0-5.08 mm (e.g. Phoenix MKDS 1,5, MSTB 2,5)', '5.0/5.08 mm', 0.14, 2.5, 16, 'Most common power block; strip 6-7 mm.'],
  ['PCB terminal block', 'Screw / pluggable, 7.5-7.62 mm (e.g. Phoenix MKDS 3, GMSTB 2,5)', '7.5/7.62 mm', 0.2, 4, 24, 'Mains-rated spacing; strip 8 mm.'],
  ['PCB terminal block', 'Screw, 10.16 mm (e.g. Phoenix MKDS 5, PC 6)', '10.16 mm', 0.5, 10, 41, 'High current; strip 10-12 mm.'],
  ['DIN-rail terminal block', 'UT 2,5 / PT 2,5 class', '5.2 mm wide', 0.14, 4, 24, 'Strip 8-10 mm.'],
  ['DIN-rail terminal block', 'UT 4 / PT 4 class', '6.2 mm wide', 0.14, 6, 32, 'Strip 8-10 mm.'],
  ['DIN-rail terminal block', 'UT 6 / PT 6 class', '8.2 mm wide', 0.2, 10, 41, 'Strip 10-12 mm.'],
  ['DIN-rail terminal block', 'UT 10 / PT 10 class', '10.2 mm wide', 0.5, 16, 57, 'Strip 12 mm.'],
  ['DIN-rail terminal block', 'UT 16 / PT 16 class', '12.2 mm wide', 1.5, 25, 76, 'Strip 16 mm.'],
  ['DIN-rail terminal block', 'UT 35 class', '15.2 mm wide', 1.5, 50, 125, 'Strip 18 mm.'],
];
// category, name, pitch, thinnest AWG, thickest AWG, current, note
const AWG_ROWS = [
  ['Wire-to-board crimp', 'JST SH', '1.0 mm', 32, 28, 1, 'Crimp tool JST WC-SH (or equivalent die).'],
  ['Wire-to-board crimp', 'JST GH', '1.25 mm', 30, 26, 1, 'Locking; used on drones and flight controllers.'],
  ['Wire-to-board crimp', 'Molex PicoBlade', '1.25 mm', 32, 26, 1, ''],
  ['Wire-to-board crimp', 'JST PH', '2.0 mm', 32, 24, 2, 'Common for Li-ion packs and small boards.'],
  ['Wire-to-board crimp', 'JST XH', '2.5 mm', 30, 22, 3, 'Balance leads, fans.'],
  ['Wire-to-board crimp', 'Molex KK 254', '2.54 mm', 30, 22, 4, 'Current depends on circuit count.'],
  ['Wire-to-board crimp', 'Dupont / 2.54 mm header housing', '2.54 mm', 28, 22, 3, 'Low retention; prototypes.'],
  ['Wire-to-board crimp', 'Molex Micro-Fit 3.0', '3.0 mm', 30, 18, 8.5, '8.5 A with 18 AWG in a 2-circuit housing; derate with circuit count.'],
  ['Wire-to-board crimp', 'JST VH', '3.96 mm', 22, 16, 10, ''],
  ['Wire-to-board crimp', 'Molex Mini-Fit Jr', '4.2 mm', 24, 16, 13, '13 A with 16 AWG, 2 circuits; 9 A typical in large housings.'],
  ['Wire-to-board crimp', 'Anderson Powerpole PP15', '-', 20, 16, 15, 'Genderless; PP15/30/45 share the housing.'],
  ['Wire-to-board crimp', 'Anderson Powerpole PP30', '-', 16, 12, 30, ''],
  ['Wire-to-board crimp', 'Anderson Powerpole PP45', '-', 14, 10, 45, ''],
];

function parseWire(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(',', '.');
  if (!t) return null;
  const awg = /^(\d+)\s*\/\s*0\s*(awg|ga)?$|^(\d+)\s*(awg|ga|gauge)$|^awg\s*(\d+)$/.exec(t);
  if (awg) {
    const n = awg[1] ? 1 - Number(awg[1]) : Number(awg[3] ?? awg[5]);
    if (n < -3 || n > 40) return { error: `AWG ${text} is outside 4/0 to 40.` };
    return { area: awgArea(n), awg: n, given: `${awgName(n)} AWG` };
  }
  const mm = /^(\d*\.?\d+)\s*(mm2|mm²|mm\^2|sqmm|qmm)?$/.exec(t);
  if (mm) { const a = Number(mm[1]); return a > 0 ? { area: a, given: `${fmtNum(a, 3)} mm²` } : { error: 'The cross-section must be above zero.' }; }
  return { error: `"${text}" does not read as a wire size: write 1.5, 1.5 mm², 18 AWG or 2/0.` };
}

export function run({ wire, category, filter }) {
  const w = parseWire(wire);
  if (!w) return { warnings: ['Give the wire size: a cross-section like 1.5 (mm²) or a gauge like 18 AWG.'] };
  if (w.error) return { warnings: [w.error] };
  const a = w.area;
  const warnings = [];
  // Each entry: kind, part, fit, display range (lo-hi mm², AWG text), accepted area window, amps, note.
  const E = (kind, part, fit, lo, hi, awgText, mLo, mHi, amps, note) => ({ kind, part, fit, lo, hi, awgText, mLo, mHi, amps, note });
  const all = [
    ...FERRULES.map(([s, col, len]) => E('Ferrule (DIN 46228-4)', `${fmtNum(s, 3)} mm² ferrule, ${col}`, `${len} mm pin`, s, s, awgName(nearestAwg(s)),
      s * 0.95 / 1.3, s, null, `Strip ${len} mm. Crimp with a square or trapezoid ferrule crimper.`)),
    ...INSULATED.map(([lo, hi, col, use]) => E('Insulated crimp terminal', `${col[0].toUpperCase()}${col.slice(1)} ring / spade / blade / butt splice`, use, lo, hi, awgRange(lo, hi), lo * 0.95, hi * 1.05, null, 'Colour-coded ratchet crimper; strip 5-7 mm.')),
    ...LUGS.map((s) => E('Tube cable lug (DIN 46235)', `${s} mm² tube lug`, s <= 16 ? 'M5-M10 stud' : 'M8-M16 stud', s, s, awgName(nearestAwg(s)), s * 0.9, s * 1.05, null, `Hexagonal crimp die for ${s} mm²; heat-shrink the barrel.`)),
    ...METRIC_ROWS.map(([k, n, p, lo, hi, i, note]) => E(k, n, p, lo, hi, awgRange(lo, hi), lo * 0.95, hi * 1.05, i, note)),
    ...AWG_ROWS.map(([k, n, p, thin, thick, i, note]) => E(k, n, p, awgArea(thin), awgArea(thick), `${awgName(thick)}-${awgName(thin)}`, awgArea(thin) * 0.97, awgArea(thick) * 1.03, i, note)),
  ];
  // A ferrule fits the wire it is the nearest size up for; other parts by their range.
  const ferPick = FERRULES.find(([s]) => s >= a * 0.95 && a >= s * 0.6);
  const fits = (r) => (r.kind.startsWith('Ferrule') ? ferPick && r.lo === ferPick[0] : a >= r.mLo && a <= r.mHi);
  const cat = category || 'all';
  const q = String(filter || '').trim().toLowerCase();
  const matches = all.filter((r) => fits(r) && (cat === 'all' || r.kind.toLowerCase().startsWith(cat)) && (!q || [r.kind, r.part, r.fit, r.note].join(' ').toLowerCase().includes(q)));

  // Key picks: the ferrule is the smallest nominal ≥ 95 % of the wire area.
  const fer = ferPick;
  const ins = INSULATED.find(([lo, hi]) => a >= lo * 0.95 && a <= hi * 1.05);
  const awg = nearestAwg(a);

  if (!matches.length) warnings.push(q ? `Nothing for ${w.given} matches "${filter}" in this category: clear the filter or pick "All".` : `Nothing in the table takes ${w.given}${cat !== 'all' ? ' in this category' : ''}: ${a < 0.14 ? 'wire this thin is usually soldered or goes to an IDC / micro crimp connector' : 'use lugs on studs or a power distribution block'}.`);
  if (a > 50 && !fer) warnings.push('No DIN 46228 ferrule above 50 mm²: use a tube lug or a terminal made for the bare conductor.');

  const rows = matches.map((r) => [r.kind, r.part, r.fit, r.lo === r.hi ? fmtNum(r.lo, 3) : `${fmtNum(r.lo, 3)}-${fmtNum(r.hi, 3)}`, r.awgText, r.amps == null ? '–' : r.amps, r.note || '']);

  const shown = (r) => (cat === 'all' || r.kind.toLowerCase().startsWith(cat)) && (!q || [r.kind, r.part, r.fit, r.note].join(' ').toLowerCase().includes(q));
  return {
    crimp: {
      area: a, given: w.given, awg: w.awg ?? null, nearestAwg: awgName(awg), nearestAwgArea: awgArea(awg),
      diameter: Math.sqrt((4 * a) / Math.PI),
      ferrule: fer ? { mm2: fer[0], colour: fer[1], pin: fer[2] } : null,
      insulated: ins ? { lo: ins[0], hi: ins[1], colour: ins[2], use: ins[3] } : null,
      category: cat, filter: q,
      catalog: all.map((r, i) => ({ id: i, kind: r.kind, part: r.part, fit: r.fit, lo: r.lo, hi: r.hi, mLo: r.mLo, mHi: r.mHi,
        awgText: r.awgText, amps: r.amps, note: r.note || '', fits: !!fits(r), shown: shown(r) })),
      matches: matches.length,
      awgTicks: GAUGES.map((n) => ({ awg: awgName(n), area: awgArea(n) })),
    },
    values: [
      { label: 'Wire', value: w.given, hint: w.awg != null ? `${fmtNum(a, 3)} mm²` : `nearest ${awgName(awg)} AWG (${fmtNum(awgArea(awg), 3)} mm²)` },
      { label: 'Ferrule', value: fer ? `${fmtNum(fer[0], 3)} mm² ${fer[1]}` : '–', hint: fer ? `${fer[2]} mm pin: strip ${fer[2]} mm` : 'none that size', tone: fer ? 'ok' : undefined },
      { label: 'Insulated terminal', value: ins ? ins[2] : '–', hint: ins ? `${ins[0]}-${ins[1]} mm²` : a < 0.5 ? 'thinner than red: fold the strands back or use a smaller terminal' : 'use a tube lug' },
      { label: 'Matching parts', value: matches.length },
    ],
    warnings,
    tables: [{ title: `Takes ${w.given}`, columns: ['Kind', 'Part', 'Pitch / fit', 'Wire mm²', 'AWG', 'Rated A', 'Note'], rows }],
    notes: [
      'Ranges and currents are typical catalogue values: confirm on the data sheet of the exact part, and check the wire itself can carry the current (Wire Gauge Selector).',
      'Stranded wire into a screw terminal: use a ferrule; do not tin the end with solder (it cold-flows and loosens).',
      'Two wires in one clamp need a twin ferrule (e.g. 2 × 0.75 mm², grey) or a terminal rated for two conductors.',
      'Crimp only with the tool and die made for the contact; a pliers crimp is not a crimp.',
    ],
  };
}
