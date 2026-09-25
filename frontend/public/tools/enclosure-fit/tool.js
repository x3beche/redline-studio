// Enclosure inner/outer size and connector cut-outs from the board.
// Coordinates: the enclosure's outer lower-left-bottom corner is (0, 0, 0);
// x along the board length, y along its width, z up. The board is centred with
// the same clearance on every side.
//   inner L = board L + 2·clearance,     outer = inner + 2·wall
//   inner H = standoff + board t + max(tallest top part, connector tops) + lid gap
//   board bottom z (outer) = floor + standoff
//   cut-out = connector body + margin on every side
//   connector face behind the outer wall face = wall + clearance − overhang
// Rules of thumb (no standard): 0.5 mm cut-out margin for a moulded or printed
// wall, 1 mm+ board-to-wall clearance, ≥ 1 mm under the lowest bottom-side part.
import { parseEng, fmtNum } from '../kit/eng.js';

const f = (v, d = 4) => fmtNum(v, d);
const SIDES = { front: 'Front (y = 0)', back: 'Back (y = max)', left: 'Left (x = 0)', right: 'Right (x = max)' };

export function run({ bl, bw, bt, clr, wall, floor, so, top, bottom, lidgap, margin, conns }) {
  const warnings = [];
  for (const [v, n] of [[bl, 'board length'], [bw, 'board width'], [bt, 'board thickness']]) if (!(v > 0)) return { warnings: [`Give the ${n} in mm.`] };
  clr = clr >= 0 ? clr : 1; wall = wall > 0 ? wall : 2; floor = floor > 0 ? floor : wall;
  so = so >= 0 ? so : 5; top = top >= 0 ? top : 0; bottom = bottom >= 0 ? bottom : 0;
  lidgap = lidgap >= 0 ? lidgap : 1; margin = margin >= 0 ? margin : 0.5;

  const rows = Array.isArray(conns) ? conns : [];
  const cs = [], bad = [];
  rows.forEach((r, i) => {
    const name = String(r.name || '').trim() || `Connector ${i + 1}`;
    const side = SIDES[r.side] ? r.side : null;
    const pos = parseEng(r.pos), w = parseEng(r.w), h = parseEng(r.h);
    const z0 = String(r.z0 ?? '').trim() === '' ? 0 : parseEng(r.z0);
    const over = String(r.over ?? '').trim() === '' ? 0 : parseEng(r.over);
    if (!side || pos == null || !(w > 0) || !(h > 0) || z0 == null || over == null) { bad.push(name); return; }
    cs.push({ i, name, side, pos, w, h, z0, over });
  });
  if (bad.length) warnings.push(`Skipped connectors with a missing side, position, width, height, z or overhang: ${bad.join(', ')}.`);

  const connTop = cs.reduce((m, c) => Math.max(m, c.z0 + c.h), 0);
  const above = Math.max(top, connTop);
  const iL = bl + 2 * clr, iW = bw + 2 * clr;
  const iH = so + bt + above + lidgap;
  const oL = iL + 2 * wall, oW = iW + 2 * wall, oH = iH + 2 * floor;
  const zb = floor + so;        // board bottom, from the outer bottom
  const zt = zb + bt;           // board top
  const bx = wall + clr, by = wall + clr; // board origin, outer coordinates

  const cut = cs.map((c) => {
    const flags = []; // what is wrong with this one, for the drawing
    const along = c.side === 'front' || c.side === 'back' ? 'x' : 'y';
    const edgeLen = along === 'x' ? bl : bw;
    const centre = (along === 'x' ? bx : by) + c.pos;
    const cw = c.w + 2 * margin, ch = c.h + 2 * margin;
    const zLo = zt + c.z0 - margin, zHi = zt + c.z0 + c.h + margin;
    const behind = wall + clr - c.over; // >0: face is inside the outer surface by this much
    const lo = centre - cw / 2, hi = centre + cw / 2;
    const wallLo = wall, wallHi = wall + (along === 'x' ? iL : iW);
    if (c.pos - c.w / 2 < 0 || c.pos + c.w / 2 > edgeLen) flags.push('edge'), warnings.push(`${c.name} hangs past the end of the ${c.side} board edge (${f(c.pos)} ± ${f(c.w / 2)} mm on a ${f(edgeLen)} mm edge): check its position.`);
    if (lo < wallLo || hi > wallHi) flags.push('corner'), warnings.push(`${c.name}'s cut-out runs into the corner of the enclosure: move it at least ${f(Math.max(wallLo - lo, hi - wallHi) + 1, 3)} mm inward or widen the clearance.`);
    if (zLo < floor) flags.push('floor'), warnings.push(`${c.name}'s cut-out reaches the floor (bottom at ${f(zLo - floor, 3)} mm above it): raise the standoffs or make the opening a slot from the split line.`);
    if (zHi > floor + iH) flags.push('lid'), warnings.push(`${c.name}'s cut-out goes past the lid: fine for a slot at the split line, otherwise add lid gap.`);
    if (behind > wall + 1.5) flags.push('deep'), warnings.push(`${c.name}'s face sits ${f(behind, 3)} mm behind the outer surface: many plugs (USB-C overmoulds, RJ45 latches) cannot reach that deep. Reduce the clearance on that side, use a connector that overhangs the board edge, or counterbore the wall.`);
    if (behind < -0.01) flags.push('proud'), warnings.push(`${c.name} sticks ${f(-behind, 3)} mm out past the outer wall: the board cannot be lowered in from above; plan an open side or a split through the connector line.`);
    return { ...c, along, centre, cw, ch, zLo, zHi, behind, flags };
  });
  // Overlaps on the same wall
  for (const side of Object.keys(SIDES)) {
    const on = cut.filter((c) => c.side === side).sort((a, b) => a.centre - b.centre);
    for (let i = 1; i < on.length; i++) {
      const gap = (on[i].centre - on[i].cw / 2) - (on[i - 1].centre + on[i - 1].cw / 2);
      const zOverlap = Math.min(on[i].zHi, on[i - 1].zHi) - Math.max(on[i].zLo, on[i - 1].zLo);
      if (gap < 1.5 && zOverlap > 0) on[i].flags.push('web'), on[i - 1].flags.push('web'), warnings.push(`${on[i - 1].name} and ${on[i].name} leave ${f(Math.max(gap, 0), 3)} mm of wall between their cut-outs: under about 1.5 mm it breaks off; merge them into one opening or move them apart.`);
    }
  }
  const underGap = so - bottom;
  if (underGap < 1) warnings.push(`Only ${f(underGap, 3)} mm between the tallest bottom-side part (${f(bottom)} mm) and the floor: make the standoffs at least ${f(bottom + 1, 3)} mm.`);
  if (clr < 0.5) warnings.push(`${f(clr, 3)} mm board-to-wall clearance does not leave room for the board's ±0.1-0.2 mm outline tolerance plus the enclosure's: use 0.5-1 mm.`);

  const scad = [
    `// Enclosure for a ${f(bl)} x ${f(bw)} mm board, generated by the Enclosure Fit Checker`,
    `wall = ${f(wall, 6)}; floor_t = ${f(floor, 6)};`,
    `outer = [${f(oL, 6)}, ${f(oW, 6)}, ${f(oH, 6)}];`,
    'difference() {',
    '  cube(outer);',
    `  translate([wall, wall, floor_t]) cube([${f(iL, 6)}, ${f(iW, 6)}, ${f(iH, 6)}]);`,
    ...cut.map((c) => {
      const t = wall + 2; // cut through the wall, with overlap
      const cx = c.along === 'x' ? c.centre - c.cw / 2 : c.side === 'left' ? -1 : oL - wall - 1;
      const cy = c.along === 'y' ? c.centre - c.cw / 2 : c.side === 'front' ? -1 : oW - wall - 1;
      const size = c.along === 'x' ? [c.cw, t, c.ch] : [t, c.cw, c.ch];
      return `  translate([${f(cx, 6)}, ${f(cy, 6)}, ${f(c.zLo, 6)}]) cube([${size.map((v) => f(v, 6)).join(', ')}]); // ${c.name}`;
    }),
    '}',
    `// board: translate([${f(bx, 6)}, ${f(by, 6)}, ${f(zb, 6)}]) cube([${f(bl, 6)}, ${f(bw, 6)}, ${f(bt, 6)}]);`,
    '// split into base and lid where it suits your design',
    '',
  ].join('\n');

  // Everything the page draws, as numbers (mm, outer lower-left-bottom corner = 0).
  const draw = {
    bl, bw, bt, clr, wall, floor, so, top, bottom, lidgap, margin,
    iL, iW, iH, oL, oW, oH, zb, zt, bx, by, above, connTop, underGap, volume: (iL * iW * iH) / 1000,
    cut: cut.map(({ i, name, side, pos, w, h, z0, over, along, centre, cw, ch, zLo, zHi, behind, flags }) =>
      ({ i, name, side, pos, w, h, z0, over, along, centre, cw, ch, zLo, zHi, behind, flags })),
  };
  return {
    draw,
    values: [
      { label: 'Inner size L × W × H', value: `${f(iL)}×${f(iW)}×${f(iH)}`, unit: 'mm', tone: 'ok' },
      { label: 'Outer size L × W × H', value: `${f(oL)}×${f(oW)}×${f(oH)}`, unit: 'mm' },
      { label: 'Board bottom above inner floor', value: f(so), unit: 'mm', hint: `${f(zb)} mm from outer bottom` },
      { label: 'Board top above outer bottom', value: f(zt), unit: 'mm' },
      { label: 'Tallest item above the board', value: f(above), unit: 'mm', hint: connTop > top ? 'a connector' : 'a component' },
      { label: 'Gap under bottom-side parts', value: f(underGap), unit: 'mm', tone: underGap < 1 ? 'bad' : 'ok' },
      { label: 'Inner volume', value: f((iL * iW * iH) / 1000), unit: 'cm³' },
    ],
    warnings,
    tables: cut.length ? [{
      title: 'Cut-outs (outer corner = 0, z from the outer bottom)',
      columns: ['Connector', 'Wall', 'Centre along wall (mm)', 'Width (mm)', 'Bottom z (mm)', 'Top z (mm)', 'Height (mm)', 'Face behind outer surface (mm)'],
      rows: cut.map((c) => [c.name, SIDES[c.side], `${c.along} = ${f(c.centre)}`, f(c.cw), f(c.zLo), f(c.zHi), f(c.ch), f(c.behind, 3)]),
    }] : [],
    texts: [{ title: 'OpenSCAD', body: scad, lang: 'openscad' }],
    notes: [
      `Connector positions are the centre along the board edge from the board's lower-left corner (seen from the top); cut-outs add ${f(margin)} mm all round.`,
      'Negative "face behind" means the connector sticks out of the enclosure. Draft angles, ribs, bosses and screw posts are not included: check they clear the board outline.',
    ],
  };
}
