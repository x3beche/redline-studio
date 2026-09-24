// Board density: how full the board is (placement) and how hard it will be to
// route (wiring demand against wiring capacity).
//
// Method after the wiring-demand / wiring-capacity comparison in C. F. Coombs,
// Printed Circuits Handbook (7th ed.), ch. "Planning for design, fabrication and
// assembly" / density evaluation, and H. Holden, The HDI Handbook, ch. 2:
//   Connections       Nc  = pins - nets = pins · (1 - 1 / pins-per-net)   (a net of k pins needs k-1 links)
//   Average link      Lav = k · √(board area / parts)                     (k ≈ 2.25: a link spans ~1.5 part pitches in
//                                                                          x and y, Manhattan; rule of thumb for a
//                                                                          reasonably placed board)
//   Wiring demand     Wd  = Nc · Lav
//   Wiring capacity   Wc  = routing layers · area / (trace + space) · η   (η ≈ 0.5: pads, vias and the one-direction-
//                                                                          per-layer habit use about half the channels)
//   Utilisation       Wd / Wc
// Pin density classes (pins per square inch) are the common fab/HDI rule of
// thumb: < 50 low, 50-100 moderate, 100-150 high, > 150 consider HDI (microvias).
import { fmtNum } from '../kit/eng.js';

const MM2_PER_IN2 = 645.16;

const PIN_CLASSES = [
  [50, 'Low', 'Through-hole or loose SMT; 2 layers usually route.'],
  [100, 'Moderate', 'Typical SMT board; 2-4 layers.'],
  [150, 'High', 'Fine-pitch SMT, small BGAs; 4-6 layers, 0.1-0.125 mm tracks.'],
  [Infinity, 'Very high', 'Consider HDI: microvias, via-in-pad, 0.075-0.1 mm tracks.'],
];
const UTIL = [
  [0.3, 'Easy', 'ok'],
  [0.5, 'Moderate', 'ok'],
  [0.7, 'Hard', 'warn'],
  [Infinity, 'Very hard / will not route', 'bad'],
];
const PLACE = [
  [0.4, 'Comfortable', 'ok'],
  [0.6, 'Dense', 'warn'],
  [0.75, 'Very dense', 'warn'],
  [Infinity, 'Unrealistic', 'bad'],
];
const pick = (tbl, v) => tbl.find((r) => v < r[0]);

export function run({ width, height, sides, parts, pins, courtyard, layers, track, space, ppn }) {
  const warnings = [];
  const need = [[width, 'board width'], [height, 'board height'], [parts, 'part count'], [pins, 'pin count'], [layers, 'routing layers'], [track, 'track width'], [space, 'clearance']];
  const missing = need.filter(([v]) => !(v > 0)).map(([, n]) => n);
  if (missing.length) return { warnings: [`Give a value above zero for: ${missing.join(', ')}.`] };
  const k = ppn > 1 ? ppn : 2.5;
  if (!(ppn > 1)) warnings.push('Pins per net must be above 1; using 2.5 (typical for mixed digital boards).');
  const nSides = sides === '2' ? 2 : 1;
  const A = width * height; // mm²
  const Ain = A / MM2_PER_IN2;

  const pinDen = pins / Ain;
  const cls = pick(PIN_CLASSES, pinDen);
  const partDen = parts / (A / 100);
  const place = courtyard > 0 ? (parts * courtyard) / (A * nSides) : null;
  const placeCls = place != null ? pick(PLACE, place) : null;

  const nc = Math.max(0, pins * (1 - 1 / k));
  const lav = 2.25 * Math.sqrt(A / parts); // mm
  const wd = nc * lav / 1000; // m
  const eta = 0.5;
  const pitch = track + space;
  const wc = layers * (A / pitch) * eta / 1000; // m
  const util = wd / wc;
  const u = pick(UTIL, util);
  // Layers needed to bring utilisation to 0.5
  const layersFor = (target) => Math.ceil((wd / target) / ((A / pitch) * eta / 1000));

  if (pins < parts) warnings.push('Fewer pins than parts: every part has at least 1 pin, usually 2. Check the pin count (a BOM export or the netlist gives it).');
  if (pins / parts > 60) warnings.push(`${fmtNum(pins / parts, 3)} pins per part on average is unusual: check the part and pin counts.`);
  if (util >= 0.7) warnings.push(`Wiring demand is ${fmtNum(util * 100, 3)} % of capacity: add routing layers (≈${layersFor(0.5)} for 50 %), use finer track/space, or a bigger board.`);
  if (place != null && place >= 0.75) warnings.push(`Parts cover ${fmtNum(place * 100, 3)} % of the usable area: no room for routing escape and assembly clearance. Use both sides, a bigger board, or smaller packages.`);
  if (pitch < 0.15) warnings.push(`Track + space of ${fmtNum(pitch, 3)} mm is below what standard fabs make (≈0.1 + 0.1 mm); price it as HDI.`);

  return {
    values: [
      { label: 'Pin density', value: fmtNum(pinDen, 3), unit: 'pins/in²', hint: `${fmtNum(pins / (A / 100), 3)} pins/cm²` },
      { label: 'Density class', value: cls[1], tone: cls[1] === 'Very high' ? 'bad' : cls[1] === 'High' ? 'warn' : 'ok', hint: cls[2] },
      { label: 'Part density', value: fmtNum(partDen, 3), unit: 'parts/cm²' },
      { label: 'Placement fill', value: place != null ? `${fmtNum(place * 100, 3)} %` : '–', tone: placeCls?.[2], hint: placeCls ? `${placeCls[1]}; courtyards over ${nSides} side${nSides > 1 ? 's' : ''}` : 'give an average courtyard' },
      { label: 'Wiring demand', value: fmtNum(wd, 3), unit: 'm', hint: `${fmtNum(nc, 4)} links × ${fmtNum(lav, 3)} mm` },
      { label: 'Wiring capacity', value: fmtNum(wc, 3), unit: 'm', hint: `${layers} layer${layers > 1 ? 's' : ''} at ${fmtNum(pitch, 3)} mm pitch, 50 % usable` },
      { label: 'Routing difficulty', value: u[1], tone: u[2], hint: `demand / capacity = ${fmtNum(util * 100, 3)} %` },
      { label: 'Routing layers for 50 %', value: layersFor(0.5), hint: 'at this track and space' },
    ],
    warnings,
    tables: [
      { title: 'Routing difficulty against routing layers', columns: ['Routing layers', 'Capacity (m)', 'Demand / capacity', 'Difficulty'],
        rows: [1, 2, 3, 4, 6, 8].map((n) => { const c = n * (A / pitch) * eta / 1000; const r = wd / c; return [n === Number(layers) ? `▶ ${n}` : String(n), fmtNum(c, 3), `${fmtNum(r * 100, 3)} %`, pick(UTIL, r)[1]]; }) },
      { title: 'Pin density classes (rule of thumb)', columns: ['Pins per in²', 'Class', 'What it usually takes'],
        rows: PIN_CLASSES.map((r, i) => [i === 0 ? `< ${r[0]}` : r[0] === Infinity ? `> ${PIN_CLASSES[i - 1][0]}` : `${PIN_CLASSES[i - 1][0]}-${r[0]}`, r[0] === cls[0] ? `▶ ${r[1]}` : r[1], r[2]]) },
    ],
    notes: [
      'Routing layers are the layers you route signals on: a 4-layer board with two planes has 2.',
      'Average link length assumes a sensible placement (connected parts near each other): about 2.25 × the square root of the area per part. Poor placement or long buses can double it.',
      '50 % of the theoretical channels is usable (pads, vias, keep-outs, one main direction per layer). Above ~70 % of that, autorouters and people start failing.',
      'Placement fill = parts × average courtyard / (board area × sides used). Include connectors and big parts in the average.',
    ],
  };
}
