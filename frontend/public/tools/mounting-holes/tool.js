// Mounting hole: drill, pad and keep-out rings from the screw, its head or
// washer and the standoff.
//
//   drill            clearance hole: ISO 273 fine/medium/coarse (metric);
//                    close/free fit drill chart (Machinery's Handbook) for inch
//   metal on board   the biggest thing that touches the board: head or washer
//                    on one side, standoff (hex: across corners = AF * 2/sqrt 3)
//                    on the other
//   PTH pad          at least the metal diameter, so the head/standoff seats on copper
//   copper keep-out  metal + 2 x copper clearance
//   part keep-out    metal + 2 x tool/part margin
//   edge distance    max(metal radius, hole radius + board thickness)  (rule of
//                    thumb: a web of at least the board thickness beside the hole)
import { fmtNum } from '../kit/eng.js';

const IN = 25.4;
// [fine, medium, coarse] clearance holes, mm
const HOLE = {
  M2: [2.2, 2.4, 2.6], 'M2.5': [2.7, 2.9, 3.1], M3: [3.2, 3.4, 3.6],
  M4: [4.3, 4.5, 4.8], M5: [5.3, 5.5, 5.8], M6: [6.4, 6.6, 7.0],
  // close fit / free fit drills; no loose class in the chart
  '#2-56': [0.0890 * IN, 0.0960 * IN, null],   // #43, #41
  '#4-40': [0.1160 * IN, 0.1285 * IN, null],   // #32, #30
  '#6-32': [0.1440 * IN, 0.1495 * IN, null],   // #27, #25
};
// Nominal max head diameters, mm. Metric: ISO 7045 pan, ISO 4762 socket,
// ISO 7380-1 button. Inch: ASME B18.6.3 pan, B18.3 socket and button.
const HEAD = {
  pan: { M2: 4.0, 'M2.5': 5.0, M3: 5.6, M4: 8.0, M5: 9.5, M6: 12.0, '#2-56': 0.167 * IN, '#4-40': 0.219 * IN, '#6-32': 0.270 * IN },
  socket: { M2: 3.8, 'M2.5': 4.5, M3: 5.5, M4: 7.0, M5: 8.5, M6: 10.0, '#2-56': 0.140 * IN, '#4-40': 0.183 * IN, '#6-32': 0.226 * IN },
  button: { M3: 5.7, M4: 7.6, M5: 9.5, M6: 10.5, '#4-40': 0.213 * IN, '#6-32': 0.262 * IN },
};
// Flat washer outside diameter: ISO 7089 (metric); small-pattern inch washers (rule of thumb).
const WASHER = { M2: 5, 'M2.5': 6, M3: 7, M4: 9, M5: 10, M6: 12, '#2-56': 0.188 * IN, '#4-40': 0.250 * IN, '#6-32': 0.312 * IN };
// Usual standoff across-flats (hex) and outside diameter (round), mm: catalogue sizes.
const STANDOFF = {
  hex: { M2: 4, 'M2.5': 5, M3: 5.5, M4: 7, M5: 8, M6: 10, '#2-56': 0.1875 * IN, '#4-40': 0.1875 * IN, '#6-32': 0.25 * IN },
  round: { M2: 4, 'M2.5': 5, M3: 6, M4: 8, M5: 9, M6: 10, '#2-56': 0.1875 * IN, '#4-40': 0.1875 * IN, '#6-32': 0.25 * IN },
};
const up = (v, step = 0.1) => Math.ceil(v / step - 1e-9) * step;
const f = (v) => fmtNum(v, 3);

export function run({ screw, fit, head, washer, standoff, sd, plated, cu, tool, t }) {
  const warnings = [];
  const holes = HOLE[screw] || HOLE.M3;
  if (!HOLE[screw]) screw = 'M3';
  let fi = fit === 'fine' ? 0 : fit === 'coarse' ? 2 : 1;
  let drill = holes[fi];
  if (drill == null) { fi = 1; drill = holes[1]; warnings.push(`There is no loose class for ${screw} in the inch chart: using the free fit, ${f(drill)} mm.`); }
  if (!(cu >= 0)) cu = 0.5;
  if (!(tool >= 0)) tool = 1;
  if (!(t > 0)) t = 1.6;

  let headD = 0, headName = 'none';
  if (head !== 'none') {
    headD = HEAD[head]?.[screw];
    headName = head;
    if (headD == null) { headD = HEAD.pan[screw]; headName = 'pan'; warnings.push(`No ${head} head is standard for ${screw}: using the pan head, ${f(headD)} mm.`); }
  }
  const washD = washer ? WASHER[screw] : 0;
  const topD = Math.max(headD, washD);
  let soAF = 0, soAC = 0;
  if (standoff !== 'none') {
    soAF = sd > 0 ? sd : STANDOFF[standoff === 'round' ? 'round' : 'hex'][screw];
    soAC = standoff === 'round' ? soAF : soAF * 2 / Math.sqrt(3);   // hex: across corners
    if (soAF <= drill) warnings.push(`A ${f(soAF)} mm standoff is not bigger than the ${f(drill)} mm hole: it would go through. Give the standoff's real size.`);
  }
  const metal = Math.max(topD, soAC);
  if (!(metal > 0)) warnings.push('Neither a head nor a standoff touches the board here: the keep-outs below are just the hole. Pick a head or a standoff.');
  const bearing = Math.max(metal, drill);
  const pad = plated === 'pth' ? up(Math.max(bearing, drill + 2 * 0.3)) : 0;
  const metalOrPad = Math.max(bearing, pad);
  const cuKeep = metalOrPad + 2 * cu;
  const partKeep = metalOrPad + 2 * tool;
  const edge = Math.max(metalOrPad / 2, drill / 2 + t);

  if (cu < 0.2) warnings.push(`${f(cu)} mm between the screw metal and other copper is tight: the screw can shift in its clearance hole and the head with it. Use 0.5 mm or more.`);
  if (plated === 'pth' && (pad - drill) / 2 < 0.15) warnings.push('The annular ring is under 0.15 mm: make the pad bigger.');

  const kicad = `MountingHole_${f(drill)}mm_${screw.replace('#', 'No')}${plated === 'pth' ? '_Pad' : ''}`;
  const values = [
    { label: 'Drill (clearance hole)', value: f(drill), unit: 'mm', hint: `${screw}, ${['fine', 'medium', 'coarse'][fi]}${plated === 'pth' ? ', finished size' : ''}`, tone: 'ok' },
    plated === 'pth' ? { label: 'Pad diameter', value: f(pad), unit: 'mm', hint: `ring ${f((pad - drill) / 2)} mm` } : { label: 'Pad', value: 'none', hint: 'NPTH, no copper' },
    { label: 'Copper keep-out', value: f(up(cuKeep)), unit: 'mm', hint: `dia., metal ${f(metalOrPad)} + 2 x ${f(cu)}` },
    { label: 'Part keep-out', value: f(up(partKeep)), unit: 'mm', hint: `dia., + 2 x ${f(tool)} tool margin` },
    { label: 'Hole centre to board edge', value: f(up(edge)), unit: 'mm', hint: 'at least' },
    { label: 'Head / washer', value: topD ? f(topD) : '–', unit: topD ? 'mm' : '', hint: [headName !== 'none' ? `${headName} head ${f(headD)}` : '', washD ? `washer ${f(washD)}` : ''].filter(Boolean).join(', ') || 'none' },
    { label: 'Standoff', value: soAC ? f(soAC) : '–', unit: soAC ? 'mm' : '', hint: soAC ? (standoff === 'round' ? 'outside diameter' : `across corners (AF ${f(soAF)})`) : 'none' },
  ];
  const rows = Object.keys(HOLE).map((k) => [k, ...HOLE[k].map((v) => (v == null ? '–' : f(v))), f(HEAD.pan[k]), f(HEAD.socket[k]), WASHER[k] ? f(WASHER[k]) : '–', f(STANDOFF.hex[k])]);
  return {
    values,
    warnings,
    tables: [{ title: 'Clearance holes and nominal sizes, mm', columns: ['Screw', 'Fine', 'Medium', 'Coarse', 'Pan head', 'Socket head', 'Washer', 'Hex AF'], rows }],
    texts: [{ title: 'Footprint', body: [
      `Footprint: ${kicad} (KiCad-style name)`,
      `Hole: ${f(drill)} mm ${plated === 'pth' ? 'plated, finished size' : 'non-plated'}`,
      plated === 'pth' ? `Pad: ${f(pad)} mm round, both layers, to GND/chassis` : 'Pad: none',
      `Copper keep-out (all layers): ${f(up(cuKeep))} mm diameter`,
      `Courtyard / part keep-out: ${f(up(partKeep))} mm diameter`,
      `Place the centre at least ${f(up(edge))} mm from the board edge.`,
    ].join('\n') + '\n' }],
    notes: [
      'Head, washer and standoff sizes are nominal maxima from the standards; a catalogue part can differ - check its drawing.',
      'The keep-outs apply to both sides: the head (or washer) sits on one side, the standoff on the other, so the larger one sets the ring.',
      'Plated holes: the fab drills bigger and plates down to the finished size you give. A grounded pad is usually repeated on both layers, often with a ring of small vias.',
    ],
    drawing: { drill, pad, metal: metalOrPad, cuKeep: up(cuKeep), partKeep: up(partKeep), headD: topD, standoff: soAC },
  };
}
