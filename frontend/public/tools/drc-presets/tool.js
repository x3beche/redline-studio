// DRC rule presets from a board house's published capabilities.
//
//   board minimums  = the fab's limits (what it can make; DRC errors below them)
//   working rules   = limit x margin, rounded up (0.01 mm, or 0.05 mm for "safe")
//   via pad         = drill + 2 x annular ring
//   heavy copper    2 oz outer copper etches wider: tracks and gaps of at least
//                   0.2 mm (8 mil) - the figure most fabs publish for 2 oz
// Output: the Redline Rules-tab JSON (backend/rules.py SCHEMA: classes, board,
// pours, route) and a KiCad custom-rules (.kicad_dru) file with the limits.
import { fmtNum } from '../kit/eng.js';

// Published minimums at the time of writing, mm (check the fab's page: they change).
// t track, c clearance, d via drill, v via pad, e copper to board edge, h hole to hole
const FABS = {
  jlc2: { name: 'JLCPCB 2-layer', layers: 2, t: 0.127, c: 0.127, d: 0.2, v: 0.45, e: 0.3, h: 0.5 },
  jlc4: { name: 'JLCPCB 4/6-layer', layers: 4, t: 0.09, c: 0.09, d: 0.2, v: 0.45, e: 0.3, h: 0.5 },
  pcbway: { name: 'PCBWay standard', layers: 2, t: 0.1, c: 0.1, d: 0.2, v: 0.5, e: 0.3, h: 0.5 },
  osh2: { name: 'OSH Park 2-layer', layers: 2, t: 0.1524, c: 0.1524, d: 0.254, v: 0.508, e: 0.381, h: 0.5 },
  osh4: { name: 'OSH Park 4-layer', layers: 4, t: 0.127, c: 0.127, d: 0.254, v: 0.4572, e: 0.381, h: 0.5 },
  generic: { name: 'Generic prototype (6/6 mil, 0.3 mm drill)', layers: 2, t: 0.1524, c: 0.1524, d: 0.3, v: 0.6, e: 0.5, h: 0.5 },
};
const MARGIN = { limit: [1, 0.01], plus20: [1.2, 0.01], safe: [1.5, 0.05] };
// backend/rules.py SCHEMA bounds, so the JSON is accepted as it is
const BOUNDS = { track: [0.1, 5], clearance: [0.1, 5], via: [0.3, 3], drill: [0.15, 2], min_track: [0.09, 1], min_clearance: [0.09, 1], min_via: [0.25, 2], min_drill: [0.15, 1.5] };
const up = (v, step) => Math.round(Math.ceil(v / step - 1e-9) * step * 1e4) / 1e4;
const f = (v) => fmtNum(v, 4);
const mil = (v) => fmtNum(v / 0.0254, 3);

export function run({ fab, copper, margin, sig, pwr, ct, cc, cd, cv, ce }) {
  const warnings = [];
  let F;
  if (fab === 'custom') {
    F = { name: 'Custom', layers: 2, t: ct, c: cc, d: cd, v: cv, e: ce > 0 ? ce : 0.3, h: 0.5 };
    const miss = [['track', ct], ['gap', cc], ['via drill', cd], ['via pad', cv]].filter(([, v]) => !(v > 0)).map(([k]) => k);
    if (miss.length) return { warnings: [`Custom fab: give the ${miss.join(', ')} in mm (from the fab's capabilities page).`] };
  } else F = { ...(FABS[fab] || FABS.jlc2) };
  if (copper === '2oz') {
    if (F.t < 0.2 || F.c < 0.2) warnings.push(`2 oz copper: tracks and gaps raised from ${f(F.t)} / ${f(F.c)} mm to at least 0.2 mm, the usual heavy-copper minimum. Check the fab's 2 oz figures.`);
    F.t = Math.max(F.t, 0.2); F.c = Math.max(F.c, 0.2);
  }
  if (F.v <= F.d) return { warnings: [`A ${f(F.v)} mm via pad on a ${f(F.d)} mm drill leaves no copper: the pad must be bigger than the drill.`] };
  const [k, step] = MARGIN[margin] || MARGIN.plus20;
  const ring = (F.v - F.d) / 2;
  const w = { t: up(F.t * k, step), c: up(F.c * k, step), d: up(F.d * k, step), ring: up(ring * k, step), e: up(F.e * k, step) };
  w.v = up(w.d + 2 * w.ring, step);

  const sigT = sig > 0 ? sig : 0.25;
  const pwrT = pwr > 0 ? pwr : 0.5;
  const def = { track: Math.max(sigT, w.t), clearance: w.c, via: w.v, drill: w.d };
  if (sigT < w.t) warnings.push(`The ${f(sigT)} mm signal track is under the ${f(w.t)} mm working minimum: using ${f(w.t)} mm.`);
  const power = { track: Math.max(pwrT, def.track), clearance: w.c, via: up(Math.max(w.v, 0.8), 0.05), drill: up(Math.max(w.d, 0.4), 0.05) };
  const board = { min_track: F.t, min_clearance: F.c, min_via: F.v, min_drill: F.d };

  // keep inside what the Rules tab accepts
  const fit = (obj, where) => {
    for (const key of Object.keys(obj)) {
      const b = BOUNDS[key];
      if (!b) continue;
      if (obj[key] < b[0]) { warnings.push(`${where}.${key}: ${f(obj[key])} mm is under the Rules tab's lowest ${b[0]} mm; set to ${b[0]} mm.`); obj[key] = b[0]; }
      if (obj[key] > b[1]) { warnings.push(`${where}.${key}: ${f(obj[key])} mm is over the Rules tab's ${b[1]} mm; set to ${b[1]} mm.`); obj[key] = b[1]; }
    }
  };
  fit(board, 'board'); fit(def, 'classes.Default'); fit(power, 'classes.Power');
  if (F.d < 0.15) warnings.push(`A ${f(F.d)} mm drill is a laser microvia size: most fabs price it as HDI.`);
  if (ring < 0.1) warnings.push(`The fab's annular ring is only ${f(ring)} mm: fine for its process, but use the working value (${f(w.ring)} mm) or more on vias you can.`);

  const rules = {
    classes: [
      { name: 'Default', ...def, nets: [], patterns: [] },
      { name: 'Power', ...power, nets: [], patterns: [] },
    ],
    pairs: [],
    board,
    pours: [{ net: 'GND', layers: ['F.Cu', 'B.Cu'], clearance: Math.max(0.3, w.c), edge: Math.max(0.3, w.e), connection: 'solid' }],
    route: { passes: 40, tries: 3 },
  };
  const dru = [
    '(version 1)',
    `# ${F.name}${copper === '2oz' ? ', 2 oz' : ''}: the fab's limits`,
    `(rule "Min track" (constraint track_width (min ${f(F.t)}mm)))`,
    `(rule "Min clearance" (constraint clearance (min ${f(F.c)}mm)))`,
    `(rule "Min drill" (constraint hole_size (min ${f(F.d)}mm)))`,
    `(rule "Min annular ring" (constraint annular_width (min ${f(ring)}mm)))`,
    `(rule "Min via" (condition "A.Type == 'Via'") (constraint via_diameter (min ${f(F.v)}mm)))`,
    `(rule "Copper to edge" (constraint edge_clearance (min ${f(F.e)}mm)))`,
    `(rule "Hole to hole" (constraint hole_to_hole (min ${f(F.h)}mm)))`,
  ].join('\n') + '\n';

  const rows = [
    ['Track width', f(F.t), mil(F.t), f(w.t), `Default ${f(def.track)}, Power ${f(power.track)}`],
    ['Clearance', f(F.c), mil(F.c), f(w.c), 'every class'],
    ['Via drill', f(F.d), mil(F.d), f(w.d), `Power ${f(power.drill)}`],
    ['Via pad', f(F.v), mil(F.v), f(w.v), `Power ${f(power.via)}`],
    ['Annular ring', f(ring), mil(ring), f(w.ring), '(pad - drill) / 2'],
    ['Copper to board edge', f(F.e), mil(F.e), f(w.e), 'pour edge'],
    ['Hole to hole', f(F.h), mil(F.h), f(up(F.h * k, step)), 'rule of thumb'],
  ];
  return {
    values: [
      { label: 'Fab', value: F.name, hint: `${copper === '2oz' ? '2 oz' : '1 oz'} outer copper` },
      { label: 'Track / gap', value: `${f(w.t)} / ${f(w.c)}`, unit: 'mm', tone: 'ok', hint: `limit ${f(F.t)} / ${f(F.c)} mm` },
      { label: 'Via (pad / drill)', value: `${f(w.v)} / ${f(w.d)}`, unit: 'mm', tone: 'ok', hint: `limit ${f(F.v)} / ${f(F.d)} mm` },
      { label: 'Margin', value: `x ${k}`, hint: `rounded up to ${step} mm` },
      { label: 'Copper to edge', value: f(w.e), unit: 'mm' },
    ],
    warnings,
    tables: [{ title: 'Rules, mm', columns: ['Rule', 'Fab limit', 'Limit (mil)', 'Working', 'Used for'], rows }],
    texts: [
      { title: 'Rules tab JSON', body: JSON.stringify(rules, null, 2) + '\n', lang: 'json' },
      { title: 'KiCad .kicad_dru', body: dru },
    ],
    notes: [
      'Fab limits are the published minimums at the time of writing: check the fab\'s capabilities page, and its extra-cost options, before routing to the limit.',
      '"Rules tab JSON" pastes into the board room\'s Rules tab (or `revisions.py board rules`): add your nets to Power, or give it patterns such as vbus, v*v*.',
      'The board minimums are the fab limits so DRC flags only what cannot be made; the classes use the working values with margin.',
    ],
  };
}
