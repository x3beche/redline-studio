// Standoff length from what is under the board (or between two boards).
//   floor:  L_min = max(tallest bottom part, through-hole lead protrusion) + air gap + tolerance − boss height
//   stack:  L_min = lower-board top part + upper-board bottom part + gap + tolerance  (parts may overlap in x/y)
//           L_min = max(the two) + gap + tolerance                                  (they never overlap)
//           with a board-to-board connector, the spacing IS its mated height
//   screw into a female standoff: length = board t + washer t + engagement,
//   engagement ≤ L/2 − 0.1 so the two screws do not meet; 1.5·d for full strength
//   of a steel screw in a brass/aluminium thread (rule of thumb, cf. VDI 2230 /
//   Machinery's Handbook); ≥ 0.5·d as the least that holds a board at all.
// Standard lengths: catalogue hex standoffs (Würth WA-SSTII, Keystone, Ettinger).
import { fmtNum } from '../kit/eng.js';

const LENGTHS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 25, 28, 30, 32, 35, 40, 45, 50, 55, 60];
const SCREWS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 25, 30]; // ISO 7045 / ISO 4762 preferred lengths, mm
const WASHER_T = { M2: 0.3, 'M2.5': 0.5, M3: 0.5, M4: 0.8, M5: 1.0 }; // ISO 7089 thickness
const D = { M2: 2, 'M2.5': 2.5, M3: 3, M4: 4, M5: 5 };
const f = (v, d = 4) => fmtNum(v, d);

export function run({ mode, under, leads, lowerTop, upperBottom, overlap, b2b, gap, tol, boss, t, top, screw, washer }) {
  const warnings = [];
  const g = gap >= 0 ? gap : 1;
  const tl = tol >= 0 ? tol : 0;
  const bt = t > 0 ? t : 1.6;
  const bossH = boss > 0 ? boss : 0;
  const stack = mode === 'stack';
  let need, why;
  if (stack) {
    const a = lowerTop >= 0 ? lowerTop : 0, b = upperBottom >= 0 ? upperBottom : 0;
    need = (overlap ? a + b : Math.max(a, b)) + g + tl;
    why = overlap ? `${f(a)} + ${f(b)} mm parts + ${f(g)} gap + ${f(tl)} tol.` : `max(${f(a)}, ${f(b)}) mm + ${f(g)} gap + ${f(tl)} tol.`;
  } else {
    const u = Math.max(under >= 0 ? under : 0, leads >= 0 ? leads : 0);
    need = u + g + tl - bossH;
    why = `${f(u)} mm under the board + ${f(g)} gap + ${f(tl)} tol.${bossH ? ` − ${f(bossH)} boss` : ''}`;
    if (leads > 2.5) warnings.push(`${f(leads)} mm of lead below the board is over IPC-A-610's 2.5 mm maximum protrusion: trim the leads and plan with 1.5-2.5 mm.`);
  }
  if (need < 0) need = 0;
  let L = LENGTHS.find((x) => x >= need - 1e-9) ?? null;
  let fixed = false;
  if (stack && b2b > 0) {
    fixed = true;
    if (b2b < need - 1e-9) warnings.push(`The connector's ${f(b2b)} mm mated height is less than the ${f(need)} mm the parts need: the boards would collide. Choose a taller connector (or move the tall parts apart so they do not overlap).`);
    if (!LENGTHS.some((x) => Math.abs(x - b2b) < 1e-6)) warnings.push(`${f(b2b)} mm is not a stock standoff length: order a custom length, stack a spacer/washer, or pick a connector with a stock height (${LENGTHS.filter((x) => Math.abs(x - b2b) < 3).join(', ')} mm).`);
    L = b2b;
  }
  if (L == null) return { warnings: [...warnings, `${f(need)} mm is longer than stock standoffs (${LENGTHS[LENGTHS.length - 1]} mm): stack two, or use a threaded rod with a sleeve.`] };
  const clear = L - (need - g - tl) ; // air left under/between the parts with the chosen length
  const values = [
    { label: 'Minimum standoff length', value: f(need), unit: 'mm', hint: why },
    { label: fixed ? 'Standoff length (= connector height)' : 'Stock length', value: f(L), unit: 'mm', tone: clear >= g ? 'ok' : 'bad' },
    { label: 'Air gap with it', value: f(clear), unit: 'mm', hint: `asked ${f(g)} mm` },
  ];
  if (!stack) {
    const boardBottom = bossH + L;
    values.push(
      { label: 'Board bottom above floor', value: f(boardBottom), unit: 'mm' },
      { label: 'Top of tallest top part above floor', value: f(boardBottom + bt + (top >= 0 ? top : 0)), unit: 'mm', hint: 'for the enclosure height' },
    );
  } else {
    values.push({ label: 'Board-to-board pitch (top to top)', value: f(L + bt), unit: 'mm' });
  }
  // Screw for a female thread: the longest stock screw whose tip stays short of
  // the middle of the standoff (room for the second screw from the other end).
  const d = D[screw] || 3;
  const wt = washer ? WASHER_T[screw] || 0.5 : 0;
  const engMax = Math.max(0, L / 2 - 0.1);
  const sMax = bt + wt + engMax;
  const sPick = [...SCREWS].reverse().find((x) => x <= sMax + 1e-9 && x - bt - wt >= 0.5 * d);
  const eng = sPick ? sPick - bt - wt : 0;
  values.push({ label: `${screw || 'M3'} screw length (female standoff)`, value: sPick ? f(sPick) : '–', unit: 'mm', tone: !sPick ? 'bad' : eng < d ? 'warn' : 'ok',
    hint: sPick ? `${f(eng, 3)} mm of thread (${f(eng / d, 2)}·d)` : 'no stock length fits' });
  if (!sPick) warnings.push(`A ${f(L)} mm standoff leaves under ${f(0.5 * d, 2)} mm of thread for each of two ${screw} screws: use a male-female standoff with a nut, one screw right through, or a longer standoff.`);
  else if (eng < d) warnings.push(`Only ${f(eng, 3)} mm (${f(eng / d, 2)}·d) of thread per screw: enough to hold a board, but for load or vibration aim for 1.5·d in a brass or aluminium standoff (${f(1.5 * d, 3)} mm): use a longer standoff, or a male-female one.`);
  if (g < 0.5) warnings.push(`A ${f(g)} mm gap leaves no room for board bow (up to 0.75 % of the diagonal per IPC-6012) or for insulation: use at least 1 mm, more over a metal floor.`);
  const table = LENGTHS.filter((x) => x >= need - 2 && x <= need + 8).map((x) => [x, f(x - (need - g - tl)), x >= need - 1e-9 ? 'yes' : 'no', stack ? '' : f(bossH + x + bt)]);
  return {
    values, warnings,
    tables: [{ title: 'Nearby stock lengths', columns: ['Length (mm)', 'Air gap (mm)', 'Enough?', stack ? '' : 'Board top above floor (mm)'].filter(Boolean), rows: table.map((r) => (stack ? r.slice(0, 3) : r)) }],
    notes: [
      'Over a metal floor or chassis at a different potential, the gap is also an insulation clearance: check it against IEC 62368-1 / IEC 60664-1 for the voltage, or add an insulating sheet.',
      'Board bow: IPC-6012 allows 0.75 % of the diagonal for SMT boards (about 0.9 mm on a 120 mm diagonal): add it to the gap on large boards held only at the corners.',
      stack ? 'In a stack, the connector sets the spacing; the standoffs only follow it. Mated-height tolerance is typically ±0.1-0.2 mm: order standoffs to the nominal height.' : 'Tolerance on catalogue standoffs is typically ±0.1 mm.',
    ],
  };
}
