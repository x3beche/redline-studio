// Bolt circle (pitch circle diameter, PCD) hole positions.
//   θ_i = θ0 ± i · Δθ,   Δθ = 360°/n (full circle) or span/(n−1) (an arc, ends included)
//   x_i = cx + (PCD/2)·cos θ_i,   y_i = cy + (PCD/2)·sin θ_i
//   chord between neighbours c = PCD · sin(Δθ/2)     (plane geometry)
//   ligament (metal between holes) = c − hole Ø
// Angles from +X, counter-clockwise positive (the CAD convention).
import { fmtNum } from '../kit/eng.js';

const f = (v, d = 4) => fmtNum(v, d);
const fx = (v, dp) => { const s = (Math.abs(v) < 0.5 * 10 ** -dp ? 0 : v).toFixed(dp); return s === `-${(0).toFixed(dp)}` ? (0).toFixed(dp) : s; };

export function run({ n, pcd, start, cx, cy, hole, dir, span, arc, depth, dp }) {
  const warnings = [];
  const N = Math.round(n);
  if (!(N >= 1) || N > 360) return { warnings: ['Give the number of holes, 1 to 360.'] };
  if (N !== n) warnings.push(`${n} holes rounded to ${N}.`);
  if (!(pcd > 0)) return { warnings: ['Give the bolt circle (pitch circle) diameter in mm, e.g. 100.'] };
  const a0 = Number.isFinite(start) ? start : 0;
  const X0 = Number.isFinite(cx) ? cx : 0, Y0 = Number.isFinite(cy) ? cy : 0;
  const D = hole > 0 ? hole : 0;
  const decimals = [0, 1, 2, 3, 4].includes(Math.round(dp)) ? Math.round(dp) : 3;
  const full = span !== 'arc';
  let step;
  if (full) step = 360 / N;
  else {
    if (!(arc > 0 && arc <= 360)) return { warnings: ['Give the arc span in degrees, more than 0 and up to 360.'] };
    step = N > 1 ? arc / (N - 1) : 0;
    if (arc >= 360) warnings.push('A 360° arc puts the first and last holes on top of each other: choose Full circle instead.');
  }
  const sign = dir === 'cw' ? -1 : 1;
  const R = pcd / 2;
  const holes = Array.from({ length: N }, (_, i) => {
    const deg = a0 + sign * i * step;
    const t = (deg * Math.PI) / 180;
    return { i: i + 1, deg: ((deg % 360) + 360) % 360, x: X0 + R * Math.cos(t), y: Y0 + R * Math.sin(t) };
  });
  const chord = N > 1 ? pcd * Math.sin((step * Math.PI) / 360) : null;
  const lig = chord != null && D ? chord - D : null;
  if (lig != null && lig <= 0) warnings.push(`The ${f(D)} mm holes overlap: the centres are only ${f(chord)} mm apart. Use fewer holes, smaller holes or a larger bolt circle.`);
  else if (lig != null && lig < 0.5 * D) warnings.push(`Only ${f(lig, 3)} mm of material between neighbouring holes (less than half a hole diameter): the web can tear or distort when drilled. Aim for at least ${f(0.5 * D, 3)} mm.`);
  if (D && D >= pcd) warnings.push('The hole is as big as the bolt circle: check the diameters.');

  const P = (v) => fx(v, decimals);
  const csv = 'hole,angle_deg,x_mm,y_mm\n' + holes.map((h) => `${h.i},${fx(h.deg, 3)},${P(h.x)},${P(h.y)}`).join('\n') + '\n';
  const scad = `// ${N} holes Ø${f(D || 0)} on PCD ${f(pcd)}, start ${f(a0)}°, ${full ? 'full circle' : `${f(arc)}° arc`}\n`
    + `pcd = ${f(pcd, 6)};\nhole_d = ${f(D || 3, 6)};\nstart = ${f(a0, 6)};\nstep = ${f(sign * step, 8)};\nn = ${N};\n`
    + 'module bolt_circle(h = 10) {\n  translate([' + `${f(X0, 6)}, ${f(Y0, 6)}` + ', 0])\n    for (i = [0 : n - 1])\n      rotate([0, 0, start + i * step])\n        translate([pcd / 2, 0, -h / 2]) cylinder(d = hole_d, h = h, $fn = 48);\n}\n'
    + '// difference() { your_plate(); bolt_circle(); }\n';
  const cq = 'import cadquery as cq\n\n'
    + `pts = [\n${holes.map((h) => `    (${P(h.x)}, ${P(h.y)}),`).join('\n')}\n]\n`
    + `# plate = plate.faces(">Z").workplane(origin=(0, 0, 0)).pushPoints(pts).hole(${f(D || 3, 6)})\n`
    + `# or, on a workplane centred at (${f(X0, 6)}, ${f(Y0, 6)}): .polarArray(${f(R, 6)}, ${f(a0, 6)}, ${full ? 360 : f(sign * arc, 6)}, ${N}).hole(${f(D || 3, 6)})\n`;
  const zd = depth > 0 ? depth : 5;
  const gcode = `(${N} holes on PCD ${f(pcd)}, drill Z-${f(zd)}, peck-free G81)\nG21 G90 G17\nG0 Z5\n`
    + `G81 R2 Z-${f(zd, 6)} F100 X${P(holes[0].x)} Y${P(holes[0].y)}\n`
    + holes.slice(1).map((h) => `X${P(h.x)} Y${P(h.y)}`).join('\n') + (N > 1 ? '\n' : '')
    + 'G80\nG0 Z5\nM30\n';
  return {
    values: [
      { label: 'Angle between holes', value: N > 1 ? f(step, 6) : '–', unit: '°' },
      { label: 'Chord between neighbours', value: chord != null ? f(chord, 5) : '–', unit: 'mm', hint: 'centre to centre, straight' },
      { label: 'Material between holes', value: lig != null ? f(lig, 4) : '–', unit: 'mm', tone: lig == null ? undefined : lig <= 0 ? 'bad' : lig < 0.5 * D ? 'warn' : 'ok' },
      { label: 'Bolt circle radius', value: f(R, 6), unit: 'mm' },
      { label: 'Across outer hole edges', value: D ? f(pcd + D, 5) : '–', unit: 'mm', hint: 'minimum clear diameter the holes need' },
      { label: 'Inside inner hole edges', value: D ? f(Math.max(0, pcd - D), 5) : '–', unit: 'mm' },
    ],
    warnings,
    tables: [{
      title: `Hole centres (angle from +X, ${sign > 0 ? 'counter-clockwise' : 'clockwise'})`,
      columns: ['Hole', 'Angle (°)', 'x (mm)', 'y (mm)'],
      rows: holes.map((h) => [h.i, fx(h.deg, 3), P(h.x), P(h.y)]),
    }],
    texts: [
      { title: 'CSV', body: csv },
      { title: 'OpenSCAD', body: scad, lang: 'openscad' },
      { title: 'CadQuery', body: cq, lang: 'python' },
      { title: 'G-code', body: gcode, lang: 'gcode' },
    ],
    notes: [
      'Hole 1 is at the start angle; x/y are from the drawing origin, with the bolt circle centre at (cx, cy).',
      'G-code is a plain G81 drill cycle in mm and absolute coordinates: set the feed, retract and work offset for your machine before running it.',
    ],
    drawing: { pcd, hole: D, cx: X0, cy: Y0, start: a0, holes: holes.map((h) => ({ i: h.i, x: h.x, y: h.y, deg: h.deg })),
      step, sign, full, arc: full ? null : arc, chord, lig, ligTone: lig == null ? null : lig <= 0 ? 'bad' : lig < 0.5 * D ? 'warn' : 'ok', decimals, depth: zd },
  };
}
