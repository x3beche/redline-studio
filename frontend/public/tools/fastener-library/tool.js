// Metric screw, nut and washer dimensions, with the holes and the length to order.
// Data (nominal / maximum values of the standards; confirm on the supplier's drawing):
//   ISO 4762 (DIN 912) socket head cap screw     dk max, k max, hex key s
//   ISO 7380-1 button head socket screw          dk max, k max, hex key s
//   ISO 10642 (DIN 7991) countersunk socket      dk theoretical max, k max, hex key s, 90 deg
//   ISO 7045 pan head, cross recess (H)          dk max, k max, Phillips size
//   ISO 4017 (DIN 933) hex head screw            s across flats, k nominal, e min
//   ISO 4032 (DIN 934) hex nut                   s, m max, e min
//   DIN 985 prevailing-torque (nyloc) nut        s, h max
//   ISO 7089 (DIN 125-A) plain washer            d1 min, d2 max, h nominal
//   ISO 273 medium clearance holes; DIN 974-1 counterbore diameters for ISO 4762.
// Rules of thumb (said so in the notes): counterbore depth = k + 0.5 mm; nut protrusion >= 2 P;
// thread engagement in a tapped hole 1.0 d steel, 1.25 d cast iron, 1.5 d aluminium, 2 d plastic.
import { fmtNum } from '../kit/eng.js';

const SIZES = ['M1.6', 'M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M16'];
const D = { 'M1.6': 1.6, M2: 2, 'M2.5': 2.5, M3: 3, M4: 4, M5: 5, M6: 6, M8: 8, M10: 10, M12: 12, M16: 16 };
const P = { 'M1.6': 0.35, M2: 0.4, 'M2.5': 0.45, M3: 0.5, M4: 0.7, M5: 0.8, M6: 1, M8: 1.25, M10: 1.5, M12: 1.75, M16: 2 };
const CLEAR = { 'M1.6': 1.8, M2: 2.4, 'M2.5': 2.9, M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5, M16: 17.5 }; // ISO 273 medium
const CBORE_974 = { 'M1.6': 3.5, M2: 4.4, 'M2.5': 5.5, M3: 6.5, M4: 8, M5: 10, M6: 11, M8: 15, M10: 18, M12: 20, M16: 26 }; // DIN 974-1, ISO 4762

// head: size -> [dk (or s for hex), k, drive]
const HEADS = {
  socket: { name: 'Socket head cap (ISO 4762)', seat: 'counterbore', data: {
    'M1.6': [3, 1.6, 'hex 1.5'], M2: [3.8, 2, 'hex 1.5'], 'M2.5': [4.5, 2.5, 'hex 2'], M3: [5.5, 3, 'hex 2.5'], M4: [7, 4, 'hex 3'],
    M5: [8.5, 5, 'hex 4'], M6: [10, 6, 'hex 5'], M8: [13, 8, 'hex 6'], M10: [16, 10, 'hex 8'], M12: [18, 12, 'hex 10'], M16: [24, 16, 'hex 14'] } },
  button: { name: 'Button head (ISO 7380-1)', seat: 'counterbore', data: {
    M3: [5.7, 1.65, 'hex 2'], M4: [7.6, 2.2, 'hex 2.5'], M5: [9.5, 2.75, 'hex 3'], M6: [10.5, 3.3, 'hex 4'], M8: [14, 4.4, 'hex 5'],
    M10: [17.5, 5.5, 'hex 6'], M12: [21, 6.6, 'hex 8'] } },
  countersunk: { name: 'Countersunk socket (ISO 10642)', seat: 'countersink', data: {
    M3: [6.72, 1.86, 'hex 2'], M4: [8.96, 2.48, 'hex 2.5'], M5: [11.2, 3.1, 'hex 3'], M6: [13.44, 3.72, 'hex 4'], M8: [17.92, 4.96, 'hex 5'],
    M10: [22.4, 6.2, 'hex 6'], M12: [26.88, 7.44, 'hex 8'], M16: [33.6, 8.8, 'hex 10'] } },
  pan: { name: 'Pan head Phillips (ISO 7045)', seat: 'counterbore', data: {
    'M1.6': [3.2, 1.3, 'PH0'], M2: [4, 1.6, 'PH0'], 'M2.5': [5, 2.1, 'PH1'], M3: [5.6, 2.4, 'PH1'], M4: [8, 3.1, 'PH2'],
    M5: [9.5, 3.7, 'PH2'], M6: [12, 4.6, 'PH3'], M8: [16, 6, 'PH4'], M10: [20, 7.5, 'PH4'] } },
  hex: { name: 'Hex head (ISO 4017)', seat: 'counterbore', data: {
    'M1.6': [3.2, 1.1, 'AF 3.2'], M2: [4, 1.4, 'AF 4'], 'M2.5': [5, 1.7, 'AF 5'], M3: [5.5, 2, 'AF 5.5'], M4: [7, 2.8, 'AF 7'],
    M5: [8, 3.5, 'AF 8'], M6: [10, 4, 'AF 10'], M8: [13, 5.3, 'AF 13'], M10: [16, 6.4, 'AF 16'], M12: [18, 7.5, 'AF 18'], M16: [24, 10, 'AF 24'] } },
};
// ISO 4032 hex nut: s, m, e
const NUT = { 'M1.6': [3.2, 1.3, 3.41], M2: [4, 1.6, 4.32], 'M2.5': [5, 2, 5.45], M3: [5.5, 2.4, 6.01], M4: [7, 3.2, 7.66], M5: [8, 4.7, 8.79],
  M6: [10, 5.2, 11.05], M8: [13, 6.8, 14.38], M10: [16, 8.4, 17.77], M12: [18, 10.8, 20.03], M16: [24, 14.8, 26.75] };
// DIN 985 nyloc height h (same s as ISO 4032)
const NYLOC_H = { M3: 4, M4: 5, M5: 5, M6: 6, M8: 8, M10: 10, M12: 12, M16: 16 };
// ISO 7089 washer: d1, d2, h
const WASHER = { 'M1.6': [1.7, 4, 0.3], M2: [2.2, 5, 0.3], 'M2.5': [2.7, 6, 0.5], M3: [3.2, 7, 0.5], M4: [4.3, 9, 0.8], M5: [5.3, 10, 1],
  M6: [6.4, 12, 1.6], M8: [8.4, 16, 1.6], M10: [10.5, 20, 2], M12: [13, 24, 2.5], M16: [17, 30, 3] };
// Preferred lengths of ISO 4762 / ISO 4017 (not every size is made in every length)
const LENGTHS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 150];
const ENGAGE = { steel: [1.0, 'steel'], castiron: [1.25, 'cast iron'], aluminium: [1.5, 'aluminium'], plastic: [2.0, 'plastic'] };

const r2 = (v) => Math.round(v * 100) / 100;
const mm = (v) => `${fmtNum(r2(v))} mm`;

function seatOf(headKey, size, washer) {
  const h = HEADS[headKey]; const [dk, k] = h.data[size];
  if (h.seat === 'countersink') return { kind: 'countersink', d: dk, depth: k, angle: 90 };
  const wd = washer ? WASHER[size][1] + 1 : 0;
  // Socket heads: DIN 974-1; other heads: head (or hex corners) + 1 mm, rule of thumb.
  const base = headKey === 'socket' ? CBORE_974[size] : headKey === 'hex' ? NUT[size][2] + 2 : dk + 1;
  return { kind: 'counterbore', d: Math.max(base, wd), depth: k + 0.5 + (washer ? WASHER[size][2] : 0) };
}

export function run({ size, head, nut, washer, grip, material }) {
  const warnings = [];
  const h = HEADS[head] || HEADS.socket;
  const headKey = HEADS[head] ? head : 'socket';
  let s = D[size] ? size : 'M3';
  if (!h.data[s]) {
    const alt = SIZES.filter((x) => h.data[x]);
    warnings.push(`${h.name} is not made in ${s} (listed ${alt[0]}-${alt[alt.length - 1]}); ${alt[0]} is shown.`);
    s = alt[0];
  }
  const d = D[s], p = P[s];
  const [dk, k, drive] = h.data[s];
  const seat = seatOf(headKey, s, washer && h.seat !== 'countersink');
  if (washer && h.seat === 'countersink') warnings.push('A countersunk head takes no washer under the head; the washer is counted under the nut only.');

  // Required length. ISO lengths are under the head, except countersunk: overall.
  const g = grip;
  const values = [
    { label: 'Screw', value: `${s} x ${fmtNum(p)}`, hint: h.name },
    { label: headKey === 'hex' ? 'Head across flats' : 'Head diameter', value: mm(dk), hint: headKey === 'countersunk' ? 'theoretical max, 90°' : 'max' },
    { label: 'Head height', value: mm(k), hint: `drive ${drive}` },
    { label: 'Clearance hole', value: mm(CLEAR[s]), hint: 'ISO 273 medium', tone: 'ok' },
    seat.kind === 'countersink'
      ? { label: 'Countersink', value: `Ø${fmtNum(r2(seat.d))} x 90°`, hint: `mm; head flush, depth ${mm(seat.depth)}` }
      : { label: 'Counterbore', value: `Ø${fmtNum(r2(seat.d))} x ${fmtNum(r2(seat.depth))}`, unit: 'mm', hint: headKey === 'socket' ? 'DIN 974-1 Ø, depth k + 0.5' : 'head + 1 mm, depth k + 0.5' },
  ];
  let nutH = 0, nutRow = null;
  if (nut === 'hex' || nut === 'nyloc') {
    const [ns, m, e] = NUT[s];
    nutH = nut === 'nyloc' ? NYLOC_H[s] : m;
    if (nut === 'nyloc' && !NYLOC_H[s]) { warnings.push(`DIN 985 nyloc nuts are listed from M3; ${s} uses a plain ISO 4032 nut here.`); nutH = m; }
    nutRow = { s: ns, e, h: nutH };
    values.push(
      { label: nut === 'nyloc' && NYLOC_H[s] ? 'Nyloc nut (DIN 985)' : 'Hex nut (ISO 4032)', value: `AF ${mm(ns)}`, hint: `height ${mm(nutH)}, corners ${mm(e)}` },
      { label: 'Printed nut trap', value: `AF ${mm(ns + 0.2)}`, hint: `corners ${mm((ns + 0.2) / Math.cos(Math.PI / 6))}, depth ${mm(nutH + 0.2)}` },
    );
  }
  const [wd1, wd2, wh] = WASHER[s];
  if (washer) values.push({ label: 'Washer (ISO 7089)', value: `${mm(wd1)} / ${mm(wd2)}`, hint: `inner / outer, ${mm(wh)} thick` });

  let need = null, pick = null, thread = null;
  if (g == null || !(g > 0)) {
    warnings.push('Give the clamped thickness (grip) in mm to get the screw length.');
  } else {
    const wUnderHead = washer && h.seat !== 'countersink' ? wh : 0;
    if (nutRow) {
      const wUnderNut = washer ? wh : 0;
      need = g + wUnderHead + wUnderNut + nutRow.h + 2 * p; // >= 2 threads past the nut
      values.push({ label: 'Length needed', value: mm(need), hint: `grip + washers + nut + 2 P` });
    } else {
      const [f, name] = ENGAGE[material] || ENGAGE.steel;
      const eng = f * d;
      need = g + wUnderHead + eng;
      thread = { eng, depth: eng + 2 * p, drill: eng + 2 * p + 3 * p };
      values.push({ label: 'Length needed', value: mm(need), hint: `grip + ${fmtNum(f)} d engagement in ${name}` });
    }
    pick = LENGTHS.find((L) => L >= need - 1e-9) ?? null;
    if (pick == null) warnings.push(`${mm(need)} is longer than the listed lengths (to 150 mm): use a threaded rod or a stud.`);
    else values.push({ label: 'Order length', value: `${s} x ${pick}`, tone: 'ok', hint: headKey === 'countersunk' ? 'overall length' : 'length under the head' });
    if (thread && pick != null) {
      const into = pick - (need - thread.eng);
      values.push({ label: 'Tapped thread depth', value: mm(into + 2 * p), hint: `drill ${mm(into + 5 * p)} deep; screw goes ${mm(into)} in` });
      if (into > 3 * d) warnings.push(`The ${pick} mm screw reaches ${mm(into)} into the part (${fmtNum(into / d, 2)} d): make the tapped hole that deep or pick a shorter screw.`);
    }
    if (headKey === 'countersunk' && g < k) warnings.push(`The grip (${mm(g)}) is thinner than the countersunk head (${mm(k)}): the head would not sit flush. Use a counterbore and a button head, or a thicker part.`);
  }

  const rows = SIZES.filter((x) => h.data[x]).map((x) => {
    const [a, b, dr] = h.data[x];
    const st = seatOf(headKey, x, washer && h.seat !== 'countersink');
    return [x, fmtNum(P[x]), fmtNum(a), fmtNum(b), dr, fmtNum(CLEAR[x]),
      st.kind === 'countersink' ? `csk Ø${fmtNum(r2(st.d))}` : `Ø${fmtNum(r2(st.d))} x ${fmtNum(r2(st.depth))}`,
      `${fmtNum(NUT[x][0])} / ${fmtNum(NUT[x][1])}`, `${fmtNum(WASHER[x][0])}/${fmtNum(WASHER[x][1])}/${fmtNum(WASHER[x][2])}`];
  });

  const v = (name, val, c) => `${name} = ${fmtNum(r2(val), 5)};${c ? `  // ${c}` : ''}`;
  const cad = [`// ${s} ${h.name}, mm`, v('screw_d', d), v('screw_pitch', p), v('head_d', dk, headKey === 'hex' ? 'across flats' : ''), v('head_h', k),
    v('hole_d', CLEAR[s], 'ISO 273 medium')];
  if (seat.kind === 'countersink') cad.push(v('csk_d', seat.d), 'csk_angle = 90;');
  else cad.push(v('cbore_d', seat.d), v('cbore_depth', seat.depth));
  if (pick != null) cad.push(v('screw_len', pick));
  if (nutRow) cad.push(v('nut_af', nutRow.s), v('nut_ac', nutRow.e, 'across corners'), v('nut_h', nutRow.h), v('nut_trap_af', nutRow.s + 0.2, 'printed pocket'));
  if (washer) cad.push(v('washer_id', wd1), v('washer_od', wd2), v('washer_h', wh));
  if (thread && pick != null) cad.push(v('tap_drill', d - p, 'D - P'));

  return {
    values,
    tables: [{ title: `${h.name}: all sizes (mm)`, columns: ['Size', 'Pitch', headKey === 'hex' ? 'Head AF' : 'Head Ø', 'Head h', 'Drive', 'Clearance', seat.kind === 'countersink' ? 'Countersink' : 'Counterbore', 'Nut AF / h', 'Washer d1/d2/h'], rows }],
    texts: [{ title: 'CAD variables', body: cad.join('\n') + '\n', lang: 'scad' }],
    warnings,
    notes: [
      'Dimensions are the standards\' maximum (heads) or nominal values; screws from a given supplier can be a few tenths smaller.',
      'Counterbore depth k + 0.5 mm and the printed nut trap (+0.2 mm) are rules of thumb; for FDM, check a test print.',
      'Thread engagement for a tapped hole: 1 d in steel, 1.25 d cast iron, 1.5 d aluminium, 2 d plastic, so that the screw breaks before the thread strips.',
    ],
  };
}
