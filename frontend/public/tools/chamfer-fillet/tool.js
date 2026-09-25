// Recommended chamfers and fillet radii by manufacturing process.
// The numbers are the design-guide values most shops publish; where a value
// scales with the part (wall thickness t, pocket depth d) the rule is written
// next to the row and computed from the inputs.
//   CNC milling:  internal vertical corner R >= d/3 (Hubs / Protolabs CNC design
//                 guides); the smallest cutter that reaches depth d at 4xD reach
//                 has R = d/8. Edge breaks per ISO 13715 (0.2-0.5 mm).
//   Turning:      shoulder radius = insert nose radius (ISO 1832: 0.2/0.4/0.8/1.2).
//   Moulding:     inside R = 0.5 t, outside R = inside + t = 1.5 t, rib/boss
//                 base R = 0.25-0.5 t (Covestro/Bayer "Part and Mold Design",
//                 Protolabs injection moulding guide).
//   Die casting:  inside fillet ~ t, outside = inside + t (NADCA Product
//                 Specification Standards, section 4A "Fillets").
//   Sheet metal:  inside bend R ~ 1 t for mild steel/5052, relief >= t
//                 (typical shop tables, e.g. Protolabs sheet metal guide).
//   3D printing:  FDM bottom edges chamfer 45 deg, not fillet (overhang), SLA/SLS
//                 minimum radii from the printer vendors' design guides.

const STD = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 32, 40, 50];
// The next standard radius at or above v (so a tool exists and the rule is met).
const up = (v) => STD.find((s) => s >= v - 1e-9) ?? Math.ceil(v);
const mm = (v) => `${Number(v.toPrecision(3))} mm`;

const PROCESSES = {
  mill: 'CNC milling',
  turn: 'CNC turning',
  fdm: 'FDM printing',
  sla: 'SLA / resin printing',
  sls: 'SLS / MJF printing',
  mold: 'Injection moulding',
  diecast: 'Die casting',
  sheet: 'Sheet metal',
};

// Each row: feature, recommended, minimum, rule, why. rec/min are functions of
// ({t, d}) returning a string, so the rules can scale with the part.
const ROWS = {
  mill: [
    { f: 'Internal vertical corner radius', key: true,
      rec: ({ d }) => mm(up(Math.max(d / 3, 1))), min: ({ d }) => mm(up(Math.max(d / 8, 0.5))),
      rule: 'R >= depth/3; min = cutter radius at 4xD reach (depth/8)',
      why: 'An end mill leaves its own radius. A slightly larger corner than the tool radius stops chatter from full wrap-around.' },
    { f: 'Pocket floor fillet', key: false,
      rec: () => '0 or 0.5 / 1 mm', min: () => '0 (flat end mill)',
      rule: 'match a stock bull-nose cutter',
      why: 'Floors are sharp with a flat mill; a small floor radius adds a tool change, so specify it only where it carries load.' },
    { f: 'Outside edge break (chamfer)', key: true,
      rec: () => '0.5 mm × 45°', min: () => '0.2 mm × 45°',
      rule: 'ISO 13715 edge break',
      why: 'A chamfer is one pass with a chamfer mill; it removes burrs and sharp edges cheaply.' },
    { f: 'Outside edge fillet', key: false,
      rec: () => '1 mm (use a stock corner-rounding size)', min: () => '0.5 mm',
      rule: 'stock sizes 0.5, 1, 1.5, 2, 3 mm',
      why: 'Needs a corner-rounding cutter and exact setups; prefer a chamfer unless the edge is handled or cosmetic.' },
    { f: 'Hole entry chamfer', key: false,
      rec: () => '0.5 mm × 45° (90° spot)', min: () => '0.2 mm',
      rule: 'spot drill to D + 2 × chamfer',
      why: 'Guides pins and screws, removes the burr; for tapped holes chamfer to the major diameter.' },
  ],
  turn: [
    { f: 'Outside edge chamfer', key: true,
      rec: () => '0.5 mm × 45°', min: () => '0.2 mm × 45°',
      rule: 'ISO 13715 edge break',
      why: 'Free on a lathe (same tool pass); removes burrs and eases assembly.' },
    { f: 'Shoulder (internal) radius', key: true,
      rec: () => '0.4 or 0.8 mm', min: () => '0.2 mm',
      rule: 'insert nose radius, ISO 1832 sizes 0.2 / 0.4 / 0.8 / 1.2',
      why: 'The insert nose radius is left in every shoulder; draw the same value so the mating part clears it.' },
    { f: 'Thread start chamfer', key: true,
      rec: () => '45° down to the minor diameter', min: () => '30°',
      rule: 'chamfer to thread root',
      why: 'Stops a burred first thread and lets the nut start straight.' },
    { f: 'Mating bore entry chamfer', key: false,
      rec: () => '1 mm × 30° (press fits)', min: () => '0.5 mm × 45°',
      rule: 'lead-in for fits',
      why: 'A long lead-in centres a press-fit shaft and avoids shaving the bore.' },
  ],
  fdm: [
    { f: 'Bottom edge (on the bed)', key: true,
      rec: ({ t }) => mm(Math.max(0.5, Math.min(1, t / 3))) + ' × 45° chamfer', min: () => '0.4 mm × 45°',
      rule: 'chamfer, not fillet',
      why: 'Hides elephant foot; a fillet here is an overhang starting at 90° and prints badly.' },
    { f: 'Downward-facing edge', key: true,
      rec: () => '45° chamfer', min: () => '45° chamfer',
      rule: 'overhang <= 45° from vertical',
      why: 'Fillets on down-facing edges need support near their tangent point; a chamfer is self-supporting.' },
    { f: 'Vertical (Z) edge fillet', key: true,
      rec: ({ t }) => mm(up(Math.max(1, t / 2))), min: () => '0.4 mm (nozzle)',
      rule: 'R >= 1 mm; >= nozzle diameter',
      why: 'The nozzle cannot draw a corner sharper than its width; rounded Z edges also print with fewer seams and blobs.' },
    { f: 'Inside corner fillet', key: false,
      rec: ({ t }) => mm(up(Math.max(0.5, t / 2))), min: () => '0.4 mm',
      rule: 'R = 0.5 t',
      why: 'Layer lines crack from sharp inside corners under load; half the wall thickness spreads the stress.' },
    { f: 'Top edge fillet', key: false,
      rec: () => '1 mm', min: () => '0.5 mm',
      rule: 'any radius (upward facing)',
      why: 'Up-facing fillets print fine but show layer steps; small radii look cleaner.' },
  ],
  sla: [
    { f: 'Inside corner fillet', key: true,
      rec: ({ t }) => mm(up(Math.max(0.5, t / 2))), min: () => '0.2 mm',
      rule: 'R >= 0.5 mm or 0.5 t',
      why: 'Cured resin is brittle; sharp inside corners start cracks, most of all after post-cure shrink.' },
    { f: 'Outside edge fillet / chamfer', key: true,
      rec: () => '0.5 mm', min: () => '0.2 mm',
      rule: 'resolution-limited',
      why: 'Sharp edges chip when handled and when supports are removed.' },
    { f: 'Wall-to-floor fillet (hollow parts)', key: false,
      rec: ({ t }) => mm(up(Math.max(1, t))), min: () => '0.5 mm',
      rule: 'R ~ t',
      why: 'Peel forces concentrate at the joint; a fillet stops delamination.' },
  ],
  sls: [
    { f: 'Inside corner fillet', key: true,
      rec: ({ t }) => mm(up(Math.max(0.5, t / 2))), min: () => '0.5 mm',
      rule: 'R = 0.5 t, >= 0.5 mm',
      why: 'Stress concentration in sintered nylon; also lets trapped powder escape from corners.' },
    { f: 'Outside edge fillet', key: true,
      rec: () => '0.5-1 mm', min: () => '0.3 mm',
      rule: 'rounded edges tumble better',
      why: 'Sharp edges get knocked off in bead blasting and tumbling.' },
    { f: 'Hole entry chamfer', key: false,
      rec: () => '0.5 mm × 45°', min: () => '0.3 mm',
      rule: 'lead-in',
      why: 'Holes come out slightly undersize and rough; a chamfer starts a reamer or screw straight.' },
  ],
  mold: [
    { f: 'Inside corner radius', key: true,
      rec: ({ t }) => mm(0.5 * t), min: ({ t }) => mm(0.25 * t),
      rule: 'R_in = 0.5 t (min 0.25 t)',
      why: 'Below R/t = 0.25 the stress concentration rises steeply (Covestro design guide); flow and fill improve too.' },
    { f: 'Outside corner radius', key: true,
      rec: ({ t }) => mm(1.5 * t), min: ({ t }) => mm(1.25 * t),
      rule: 'R_out = R_in + t',
      why: 'Keeps the wall thickness constant around the corner, so it cools evenly and does not sink or warp.' },
    { f: 'Rib base fillet', key: true,
      rec: ({ t }) => mm(0.5 * t), min: ({ t }) => mm(0.25 * t),
      rule: 'R = 0.25-0.5 t',
      why: 'A bigger radius makes a thick spot at the rib root that shows as a sink mark on the face side.' },
    { f: 'Boss base fillet', key: false,
      rec: ({ t }) => mm(0.5 * t), min: ({ t }) => mm(0.25 * t),
      rule: 'R = 0.25-0.5 t',
      why: 'Same trade-off as ribs: strength against sink.' },
    { f: 'Edges on the parting line', key: false,
      rec: () => 'sharp (0)', min: () => 'sharp (0)',
      rule: 'no radius across the split',
      why: 'A radius that crosses the parting line needs both mould halves to match perfectly; it leaves a step.' },
  ],
  diecast: [
    { f: 'Inside fillet', key: true,
      rec: ({ t }) => mm(Math.max(1, t)), min: ({ t }) => mm(Math.max(0.5, 0.5 * t)),
      rule: 'R_in ~ t (NADCA)',
      why: 'Metal flows round the corner without turbulence; sharp inside corners crack the die steel with heat cycling.' },
    { f: 'Outside corner radius', key: true,
      rec: ({ t }) => mm(Math.max(1, t) + t), min: ({ t }) => mm(Math.max(0.5, 0.5 * t) + t),
      rule: 'R_out = R_in + t',
      why: 'Constant section round the corner avoids porosity from a hot spot.' },
    { f: 'Rib / boss root fillet', key: false,
      rec: ({ t }) => mm(Math.max(0.8, 0.5 * t)), min: () => '0.5 mm',
      rule: 'R ~ 0.5 t',
      why: 'Too large makes a heavy section and shrink porosity.' },
    { f: 'Edges to be machined later', key: false,
      rec: () => 'sharp, then edge break 0.3 mm', min: () => '–',
      rule: 'machining stock',
      why: 'A cast radius on a machined face is cut away anyway.' },
  ],
  sheet: [
    { f: 'Inside bend radius', key: true,
      rec: ({ t }) => mm(t), min: ({ t }) => mm(0.5 * t),
      rule: 'R = 1 t (mild steel, 5052); 6061-T6 needs 2-4 t',
      why: 'Tighter than about 0.5 t cracks the outside of the bend; 1 t is the usual stock punch/die.' },
    { f: 'Outside corner radius (flat)', key: true,
      rec: ({ t }) => mm(Math.max(0.5, t)), min: ({ t }) => mm(Math.max(0.25, 0.5 * t)),
      rule: 'R >= 0.5 t',
      why: 'Rounded blank corners are safer to handle and do not tear in forming.' },
    { f: 'Bend relief (width / depth)', key: true,
      rec: ({ t }) => `${mm(t)} wide, R + ${mm(t)} deep`, min: ({ t }) => `${mm(t)} wide`,
      rule: 'width >= t, depth >= t + R',
      why: 'Without relief the metal tears where a bend meets an unbent edge.' },
    { f: 'Edge break / deburr', key: false,
      rec: () => '0.2-0.3 mm', min: () => 'deburr only',
      rule: 'tumble or brush',
      why: 'Laser and punch edges are sharp; call out deburr rather than a modelled chamfer.' },
  ],
};

export function run({ process, t, depth, filter }) {
  const warnings = [];
  const notes = [];
  const tt = t > 0 ? t : 2;
  const dd = depth > 0 ? depth : 10;
  if (!(t > 0)) warnings.push('Give the nominal wall / sheet thickness in mm (e.g. 2); using 2 mm meanwhile.');
  if (process === 'mill' && !(depth > 0)) warnings.push('Give the pocket depth in mm for the corner-radius rule; using 10 mm meanwhile.');
  const procs = process === 'all' ? Object.keys(PROCESSES) : [PROCESSES[process] ? process : 'mill'];
  const q = String(filter || '').trim().toLowerCase();
  const rows = [];
  for (const p of procs) {
    for (const r of ROWS[p]) {
      const text = `${PROCESSES[p]} ${r.f} ${r.rule} ${r.why}`.toLowerCase();
      if (q && !q.split(/\s+/).every((w) => text.includes(w))) continue;
      rows.push({ p, r, rec: r.rec({ t: tt, d: dd }), min: r.min({ t: tt, d: dd }) });
    }
  }
  if (!rows.length) warnings.push(`Nothing matches "${filter}". Clear the filter or try words like corner, edge, bend, rib, hole.`);

  // Range checks on the scaling inputs.
  if (['mold', 'diecast'].includes(process) && t > 0 && (t < 0.5 || t > 6)) {
    warnings.push(`${t} mm is outside the usual ${process === 'mold' ? '0.8-4 mm moulded' : '1-5 mm die-cast'} wall; the radius rules assume a normal wall, so check thick sections for sink/porosity first.`);
  }
  if (process === 'sheet' && t > 6) warnings.push(`${t} mm is plate rather than sheet: bend radii of 1.5-3 t and a press-brake check apply.`);
  if (process === 'mill' && depth > 0) {
    const r = up(Math.max(depth / 3, 1));
    if (depth > 50) warnings.push(`A ${depth} mm deep pocket needs long-reach cutters (over about 4x their diameter): open the corners further, machine from both sides, or split the part.`);
    notes.push(`CNC corner: a Ø${Number((2 * r).toPrecision(3))} mm or smaller end mill cuts the ${mm(r)} corner; draw the corner a little over the cutter radius so the tool never wraps 90° of the corner at once.`);
  }

  const values = [];
  const keys = rows.filter((x) => x.r.key).slice(0, 4);
  for (const k of keys) values.push({ label: process === 'all' ? `${PROCESSES[k.p]}: ${k.r.f}` : k.r.f, value: k.rec, hint: `min ${k.min}` });

  const columns = process === 'all' ? ['Process', 'Feature', 'Recommended', 'Minimum', 'Rule', 'Why'] : ['Feature', 'Recommended', 'Minimum', 'Rule', 'Why'];
  const table = rows.map((x) => (process === 'all' ? [PROCESSES[x.p]] : []).concat([x.r.f, x.rec, x.min, x.r.rule, x.r.why]));
  notes.push(`Computed for t = ${mm(tt)}${procs.includes('mill') ? `, pocket depth ${mm(dd)}` : ''}. Radii are rounded up to stock tool sizes where a tool makes them.`,
    'Chamfer versus fillet: machining and printing favour chamfers (one pass, self-supporting); moulding and casting favour fillets (flow and stress).',
    'Values are design-guide recommendations, not limits of any one machine: confirm tight ones with your supplier.');
  // Everything the page draws: each row with its sizes as numbers (mm; null
  // where the value is an angle or a word), and the t and depth used.
  const firstMm = (str) => { const m = String(str).match(/(\d+(?:\.\d+)?)(?=[^°]*mm|\s*\))/); return m ? Number(m[1]) : null; };
  const draw = {
    t: tt, depth: dd, processes: procs,
    rows: rows.map((x) => ({ p: x.p, process: PROCESSES[x.p], f: x.r.f, key: x.r.key, rec: x.rec, min: x.min, rule: x.r.rule, why: x.r.why,
      recMm: firstMm(x.rec), minMm: firstMm(x.min) })),
  };
  return {
    draw,
    values,
    warnings,
    tables: rows.length ? [{ title: process === 'all' ? 'All processes' : PROCESSES[procs[0]], columns, rows: table }] : [],
    notes,
  };
}
