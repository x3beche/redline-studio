// Knurl / grip pattern on a cylinder: tooth count, real pitch, depth, helix
// and ready CAD code.
//   Pattern names and pitches after DIN 82 (RAA straight, RBL/RBR left/right
//   diagonal, RGE diamond with raised points); pitch series 0.5, 0.6, 0.8,
//   1.0, 1.2, 1.6 mm; 30 deg helix for diagonal and diamond knurls.
//   Tracking: a formed knurl only tracks cleanly when the circumference holds a
//   whole number of teeth (ANSI B94.6 states it as N = P x D with diametral
//   pitch P). With p measured normal to the ridges:
//     circumferential pitch  pc = p / cos(beta)
//     tooth count            N  = round(pi D / pc)
//   90 deg tooth: full (sharp) depth h = pc / 2 in the cross-section.
//   Helix: lead = pi D / tan(beta); twist over L = L tan(beta) / R (radians).
//   Blank for form (rolled) knurling ~ D - p/2: the material the tool pushes
//   up raises the crests (common shop rule quoted with DIN 82).
import { fmtNum } from '../kit/eng.js';

const DIN_PITCHES = [0.5, 0.6, 0.8, 1.0, 1.2, 1.6];
const PATTERNS = {
  straight: { name: 'Straight (DIN 82 RAA)', hands: [0], beta: false },
  left: { name: 'Diagonal, left hand (RBL)', hands: [-1], beta: true },
  right: { name: 'Diagonal, right hand (RBR)', hands: [1], beta: true },
  diamond: { name: 'Diamond, raised points (RGE)', hands: [1, -1], beta: true },
};

// Rule of thumb after the DIN 82 guidance table: finer pitch on small diameters.
function autoPitch(D, process) {
  if (process === 'printed') return D < 12 ? 1.2 : 1.6;
  if (D <= 8) return 0.5;
  if (D <= 16) return 0.6;
  if (D <= 32) return 0.8;
  if (D <= 63) return 1.0;
  if (D <= 125) return 1.2;
  return 1.6;
}

const f = (v, d = 4) => fmtNum(v, d);

export function run({ pattern, d, len, pitch, beta, depth, process }) {
  const warnings = [];
  const pat = PATTERNS[pattern] || PATTERNS.diamond;
  if (!(d > 0)) return { warnings: ['Give the knurled diameter in mm, e.g. 20.'] };
  if (!(len > 0)) return { warnings: ['Give the knurled length in mm, e.g. 15.'] };
  const b = pat.beta ? (Number.isFinite(beta) ? beta : 30) : 0;
  if (pat.beta && !(b > 0 && b < 60)) return { warnings: ['Helix angle must be between 0° and 60° (30° is the DIN 82 standard).'] };
  const pAuto = autoPitch(d, process);
  const pNom = pitch === 'auto' ? pAuto : Number(pitch);
  if (!(pNom > 0)) return { warnings: ['Choose a pitch.'] };

  const R = d / 2;
  const cos = Math.cos((b * Math.PI) / 180), tan = Math.tan((b * Math.PI) / 180);
  const pcNom = pNom / cos;
  const N = Math.max(3, Math.round((Math.PI * d) / pcNom));
  const pc = (Math.PI * d) / N;
  const pAct = pc * cos;
  const full = pc / 2;                         // 90 deg V, sharp crest
  const h = depth > 0 ? depth : full;
  const root = d - 2 * h;
  const dExact = (N * pcNom) / Math.PI;        // diameter where the nominal pitch fits N times
  const blank = dExact - pNom / 2;
  const lead = b > 0 ? (Math.PI * d) / tan : null;
  const twistDeg = b > 0 ? ((len * tan) / R) * (180 / Math.PI) : 0;
  const err = ((pAct - pNom) / pNom) * 100;

  if (depth > 0 && depth > full * 1.001) warnings.push(`Depth ${f(depth)} mm is deeper than a sharp 90° tooth (${f(full)} mm): the grooves overlap and cut the crests away. Use ${f(full)} mm or less.`);
  if (root <= 0) warnings.push('The grooves reach the axis: the diameter is too small for this pitch/depth. Use a finer pitch or less depth.');
  if (process === 'printed' && pc < 1.2) warnings.push(`A ${f(pc)} mm tooth is below about 3 nozzle widths (0.4 mm nozzle): it prints as a blur. Use 1.2 mm pitch or coarser.`);
  if (process === 'moulded' && pat.hands[0] !== 0) warnings.push('Diagonal and diamond knurls are undercuts in an axial mould draw: they need a split cavity through the axis or an unscrewing core. A straight knurl along the draw direction is the simple choice.');
  if (process === 'machined' && pitch !== 'auto' && pNom !== pAuto) warnings.push(`DIN 82 suggests about ${pAuto} mm pitch at Ø${f(d)} mm; ${pNom} mm will work but looks ${pNom > pAuto ? 'coarse' : 'fine'}.`);
  if (Math.abs(err) > 3 && process === 'machined') warnings.push(`The pitch is off the tool's ${pNom} mm by ${f(err, 2)} %: a formed knurl may double-track. Turn the blank to ${f(blank)} mm (for Ø${f(dExact)} mm after knurling).`);
  if (len > 3 * d && process === 'machined') warnings.push('Long knurls (over 3x the diameter) need a feed-type knurling tool and good support against deflection.');

  const hands = pat.hands;
  const slices = Math.max(2, Math.ceil(Math.abs(twistDeg) / 3));
  const grooves = hands.map((s) => (s === 0 ? 'groove(0);' : `groove(${s > 0 ? '-' : ''}twist);`)).join(' ');
  const scad = `// ${pat.name}: Ø${f(d)} x ${f(len)} mm, ${N} grooves${hands.length > 1 ? ' per hand' : ''}, pitch ${f(pAct)} mm${b ? `, helix ${f(b)}°` : ''}\n`
    + `D = ${f(d, 6)};      // outside diameter\nL = ${f(len, 6)};      // knurled length\nN = ${N};      // grooves round the circumference\n`
    + `depth = ${f(h, 5)};  // groove depth (90° V)\ntwist = ${f(twistDeg, 6)};  // degrees over L; OpenSCAD positive twist = left hand\n\n`
    + `module groove(tw)\n  linear_extrude(height = L, twist = tw, slices = ${slices})\n    translate([D / 2, 0]) rotate(45) square(depth * sqrt(2), center = true);\n\n`
    + `difference() {\n  cylinder(d = D, h = L, $fn = ${Math.min(360, Math.max(64, 2 * N))});\n  for (i = [0 : N - 1]) rotate(i * 360 / N) { ${grooves} }\n}\n`;
  const cqHands = hands.map((s) => (s === 0 ? '0' : s > 0 ? 'twist' : '-twist')).join(', ');
  const cq = `import cadquery as cq\n\n# ${pat.name}: Ø${f(d)} x ${f(len)} mm, ${N} grooves${hands.length > 1 ? ' per hand' : ''}\n`
    + `D, L, N = ${f(d, 6)}, ${f(len, 6)}, ${N}\ndepth = ${f(h, 5)}          # 90° V groove\ntwist = ${f(twistDeg, 6)}    # degrees over L (right hand); negate if your version mirrors it\n\n`
    + `body = cq.Workplane("XY").circle(D / 2).extrude(L)\nfor tw in (${cqHands}${hands.length === 1 ? ',' : ''}):\n`
    + `    g = cq.Workplane("XY").center(D / 2, 0).polygon(4, 2 * depth)\n    g = g.twistExtrude(L, tw) if tw else g.extrude(L)\n`
    + `    for i in range(N):\n        body = body.cut(g.rotate((0, 0, 0), (0, 0, 1), i * 360 / N))\n\nshow_object(body)  # or cq.exporters.export(body, "knurl.step")\n`;

  const values = [
    { label: 'Grooves round', value: N, hint: hands.length > 1 ? 'per hand' : 'teeth on the circumference', tone: 'ok' },
    { label: 'Actual pitch', value: f(pAct), unit: 'mm', hint: `nominal ${pNom} mm${pitch === 'auto' ? ' (auto)' : ''}, ${err >= 0 ? '+' : ''}${f(err, 2)} %`, tone: Math.abs(err) > 3 ? 'warn' : undefined },
    { label: 'Circumferential pitch', value: f(pc), unit: 'mm' },
    { label: 'Groove depth', value: f(h), unit: 'mm', hint: depth > 0 ? `sharp tooth ${f(full)} mm` : 'sharp 90° tooth' },
    { label: 'Root diameter', value: root > 0 ? f(root) : '–', unit: root > 0 ? 'mm' : undefined, tone: root > 0 ? undefined : 'bad' },
    { label: 'Helix lead', value: lead ? f(lead) : '–', unit: lead ? 'mm' : undefined, hint: b ? `${f(b)}° helix` : 'straight' },
    { label: 'Twist over length', value: f(twistDeg), unit: '°' },
  ];
  if (process === 'machined') values.push({ label: 'Blank for form knurling', value: f(blank), unit: 'mm', hint: `for Ø${f(dExact)} after` });

  return {
    values,
    warnings,
    tables: [{
      title: `Standard pitches at Ø${f(d)} mm${b ? `, ${f(b)}° helix` : ''}`,
      columns: ['Pitch', 'Grooves', 'Actual pitch', 'Exact Ø for N', 'Depth (sharp)'],
      rows: DIN_PITCHES.map((p) => {
        const n = Math.max(3, Math.round((Math.PI * d) / (p / cos)));
        return [`${p} mm${p === pNom ? ' ←' : ''}`, n, `${f((Math.PI * d * cos) / n)} mm`, `${f((n * p) / cos / Math.PI)} mm`, `${f((Math.PI * d) / n / 2)} mm`];
      }),
    }],
    texts: [{ title: 'OpenSCAD', body: scad, lang: 'openscad' }, { title: 'CadQuery', body: cq, lang: 'python' }],
    notes: [
      'Pitch is measured normal to the ridges, as on a knurling wheel; the circumferential pitch is pitch / cos(helix).',
      'Depth is a 90° V groove; the default is the full sharp depth, where neighbouring grooves meet at a crest.',
      'Tooth count is rounded so the circumference holds a whole number of teeth; that is what lets a formed knurl track and a CAD pattern close.',
      process === 'printed' ? 'Printed grips: print the axis vertical so the ridges run across layers; diamond pitch of 1.2-2 mm grips well with bare hands.' : 'Machined: cut knurls (on a knurl cutting tool) need no blank correction; formed (rolled) knurls raise the crests, so turn the blank about half a pitch under.',
    ],
    drawing: { d, len, N, beta: b, hands, depth: h, root },
  };
}
