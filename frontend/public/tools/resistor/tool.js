// Resistor & LED, ported from the app's Angular calculator (src/app/tools/resistor/resistor.ts)
// so an agent gets the same answers: Ohm's law from any two of V, I, R, P; an LED's
// series resistor in a value that is made; a divider from two standard values.
import { SERIES, fmtEng, fmtNum, standard } from '../kit/eng.js';

const Q = [
  { k: 'V', key: 'v', label: 'Voltage', unit: 'V' },
  { k: 'I', key: 'i', label: 'Current', unit: 'A' },
  { k: 'R', key: 'r', label: 'Resistance', unit: 'Ω' },
  { k: 'P', key: 'p', label: 'Power', unit: 'W' },
];

/** The other two of V, I, R and P from any two: V = I·R, P = V·I. */
function ohmsLaw(g) {
  const { V, I, R, P } = g;
  if (V !== undefined && I !== undefined) return { V, I, R: V / I, P: V * I };
  if (V !== undefined && R !== undefined) return { V, R, I: V / R, P: V * V / R };
  if (V !== undefined && P !== undefined) return { V, P, I: P / V, R: V * V / P };
  if (I !== undefined && R !== undefined) return { I, R, V: I * R, P: I * I * R };
  if (I !== undefined && P !== undefined) return { I, P, V: P / I, R: P / (I * I) };
  if (R !== undefined && P !== undefined) return { R, P, V: Math.sqrt(P * R), I: Math.sqrt(P / R) };
  return null;
}

// What an SMD thick-film chip resistor is rated for, by size, in watts (typical
// datasheet values at 70 °C); a part is used at half its rating, the way it lasts.
const PACKAGES = [['0402', 0.063], ['0603', 0.1], ['0805', 0.125], ['1206', 0.25], ['2010', 0.75], ['2512', 1]];

// Typical forward voltages at a few mA; the datasheet's figure wins.
const LEDS = [['red', 2.0], ['yellow', 2.1], ['green', 3.0], ['blue', 3.1], ['white', 3.1]];

/** Every value of a series from 1 Ω to 10 MΩ, smallest first (as the app's valuesOf). */
function valuesOf(series, lo = 1, hi = 1e7) {
  const out = [];
  for (let d = lo; d < hi; d *= 10) for (const s of series) out.push(Math.round(s * d * 1000) / 1000);
  out.push(hi);
  return out;
}

function ohm(input) {
  const typed = Q.filter((q) => input[q.key] != null);
  const bad = typed.filter((q) => !(input[q.key] > 0));
  if (bad.length) return { warnings: [`${bad.map((q) => q.label).join(', ')} must be above 0. Leave the ones you want worked out empty.`] };
  if (typed.length < 2) return { warnings: ['Give any two of voltage, current, resistance and power; the other two are worked out.'] };
  const [a, b] = typed;
  const s = ohmsLaw({ [a.k]: input[a.key], [b.k]: input[b.key] });
  const warnings = [];
  // A third or fourth value given too: say whether it agrees with the first two.
  for (const q of typed.slice(2)) {
    const off = Math.abs(input[q.key] - s[q.k]) / s[q.k];
    if (off > 0.005) warnings.push(`${q.label} was given as ${fmtEng(input[q.key], q.unit, 4)}, but ${a.label.toLowerCase()} and ${b.label.toLowerCase()} give ${fmtEng(s[q.k], q.unit, 4)}. Give only two; the others are worked out from the first two (in the order V, I, R, P).`);
  }
  return {
    values: Q.map((q) => ({ label: q.label, value: fmtEng(s[q.k], q.unit, 4), tone: q === a || q === b ? undefined : 'ok',
      hint: q === a || q === b ? 'given' : 'worked out' })),
    warnings,
    notes: ['V = I·R and P = V·I; 4k7, 10m and 2.2M all read.'],
  };
}

function led({ supply: v, vf: f, led_ma: ma, led_series }) {
  if (v == null || f == null || !ma || ma <= 0 || v <= f) {
    return { warnings: ["The supply has to be above the LED's forward voltage, and the current above 0 (in mA)."] };
  }
  const series = SERIES[led_series] || SERIES.E24;
  const i = ma / 1000;
  // R = (Vsupply - Vf) / I; the next standard value up, so the LED gets no more than asked.
  const exact = (v - f) / i;
  const fit = standard(exact, series, 'up') ?? exact;
  const amps = (v - f) / fit;
  const watts = amps * amps * fit;
  const pkg = (PACKAGES.find(([, w]) => w >= 2 * watts) ?? ['more than 2512'])[0];
  const warnings = [];
  if (ma > 30) warnings.push(`${fmtNum(ma, 3)} mA is more than a standard indicator LED takes (20 mA is a common maximum): check the LED's datasheet.`);
  if (v - f < 0.5) warnings.push(`Only ${fmtNum(v - f, 3)} V is left across the resistor, so the current swings a lot with Vf's spread and temperature. Use a higher supply or a current source.`);
  return {
    values: [
      { label: 'Exactly', value: fmtEng(exact, 'Ω') },
      { label: `Fit (${led_series in SERIES ? led_series : 'E24'}, next up)`, value: fmtEng(fit, 'Ω'), tone: 'ok' },
      { label: 'Current then', value: fmtEng(amps, 'A') },
      { label: 'Resistor burns', value: fmtEng(watts, 'W'), hint: `${pkg} or larger` },
    ],
    warnings,
    notes: [`Typical forward voltages: ${LEDS.map(([n, x]) => `${n} ${x} V`).join(', ')}; the LED's datasheet wins.`,
      'The package is the smallest whose rating is at least twice the power.'],
  };
}

function divider({ vin, vout, tot_lo, tot_hi, div_series }) {
  const lo = tot_lo ?? 0, hi = tot_hi ?? Infinity;
  if (!vin || !vout || vout <= 0 || vout >= vin || hi < lo) {
    return { warnings: ['Vout has to be between 0 and Vin, and the total range "from" not above "to".'] };
  }
  const series = SERIES[div_series] || SERIES.E24;
  const ratio = vout / vin;
  let best = null;
  // Vout = Vin · R2 / (R1 + R2). Every R2 in range, with the R1 nearest the ratio
  // for it; the pair closest to the target wins, a smaller total breaking a tie.
  for (const r2 of valuesOf(series, 1, 1e7)) {
    if (r2 >= hi) break;
    const r1 = standard(r2 * (1 / ratio - 1), series);
    if (!r1 || r1 + r2 < lo || r1 + r2 > hi) continue;
    const out = vin * r2 / (r1 + r2);
    const err = 100 * Math.abs(out - vout) / vout;
    if (!best || err < best.err - 1e-9) best = { r1, r2, out, err };
  }
  if (!best) return { warnings: ['No standard pair fits in that total range: widen the R1 + R2 range.'] };
  const { r1, r2, out, err } = best;
  const zout = r1 * r2 / (r1 + r2);
  const warnings = [];
  if (err > 1) warnings.push(`The nearest pair is ${fmtNum(err, 2)} % off: use a finer series (E96) or a wider total range.`);
  return {
    values: [
      { label: 'R1 (top)', value: fmtEng(r1, 'Ω'), tone: 'ok' },
      { label: 'R2 (bottom)', value: fmtEng(r2, 'Ω'), tone: 'ok' },
      { label: 'Vout then', value: fmtNum(out, 5), unit: 'V', hint: err < 0.005 ? 'exact' : `${fmtNum(err, 2)} % off` },
      { label: 'Draws', value: fmtEng(vin / (r1 + r2), 'A') },
      { label: 'Source impedance', value: fmtEng(zout, 'Ω'), hint: 'what an ADC pin sees' },
    ],
    warnings,
    notes: ['Vout = Vin · R2 / (R1 + R2); the standard pair nearest the target, both within the total you allow.',
      'Resistor tolerance adds to this: two 1 % parts can move the ratio by up to about 2 %.'],
  };
}

export function run(input) {
  switch (input.mode) {
    case 'led': return led(input);
    case 'divider': return divider(input);
    default: return ohm(input);
  }
}
