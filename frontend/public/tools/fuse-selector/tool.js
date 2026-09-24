// Fuse / PTC selection, after the Littelfuse Fuseology selection guide.
//
//   Fuse rating  >= I_normal / (0.75 * K_T)        75 % derating (UL fuses), K_T
//                                                  = temperature re-rating
//   Pulse I²t    rectangular  Ipk² t,  triangular Ipk² t / 3,  half sine Ipk² t / 2,
//                exponential (capacitor charge)   Ipk² τ / 2
//   Melting I²t  >= pulse I²t / pulse factor       factor 38 % (1k), 29 % (10k),
//                                                  22 % (100k pulses) - Littelfuse
//   PTC hold     >= I_normal / K_T                 trip current ~ 2 x hold (typical)
//   Opening      UL 248-14: 135 % within 60 min, 200 % within 2 min, so a fault
//                has to be well over twice the rating to open in seconds or less.
// K_T here is a straight-line fit to typical datasheet re-rating curves:
//   fuse  1 - 0.25 %/°C above 25 °C   (~85 % at 85 °C)
//   PTC   1 - 0.65 %/°C from 25 °C    (~61 % at 85 °C, ~116 % at 0 °C)
import { fmtEng, fmtNum } from '../kit/eng.js';

const FUSES = [0.05, 0.063, 0.08, 0.1, 0.125, 0.16, 0.2, 0.25, 0.315, 0.375, 0.4, 0.5, 0.63, 0.75, 0.8, 1, 1.25, 1.5, 1.6,
  2, 2.5, 3, 3.15, 3.5, 4, 5, 6.3, 7, 8, 10, 12, 15, 16, 20, 25, 30];
const HOLDS = [0.05, 0.1, 0.14, 0.2, 0.25, 0.3, 0.35, 0.5, 0.75, 1.1, 1.25, 1.5, 1.6, 2, 2.5, 2.6, 3, 3.5, 4, 5, 6, 7, 8, 9];
const PULSE = { 1000: 0.38, 10000: 0.29, 100000: 0.22 };
const SHAPE = { rect: 1, tri: 1 / 3, sine: 1 / 2, exp: 1 / 2, none: 0 };
const f = (v, d = 3) => fmtNum(v, d);

export function run({ type, inom, vcirc, temp, wave, ipk, tp, pulses, ifault }) {
  const warnings = [];
  if (!(inom > 0)) return { warnings: ['Give the normal operating current in amps, e.g. 1.5.'] };
  const ptc = type === 'ptc';
  const T = Number.isFinite(temp) ? temp : 25;
  if (T > 125 || T < -40) warnings.push(`${f(T)} °C is outside the -40...125 °C most fuses are rated for: check the part's range.`);
  const kT = ptc
    ? Math.min(1.3, Math.max(0.2, 1 - 0.0065 * (T - 25)))
    : Math.min(1, Math.max(0.5, 1 - 0.0025 * (T - 25)));
  if (ptc && T > 85) warnings.push('PTC hold current falls fast above 85 °C: this estimate is rough there; use the datasheet derating table.');

  const minRating = ptc ? inom / kT : inom / (0.75 * kT);
  const list = ptc ? HOLDS : FUSES;
  const pick = list.find((x) => x >= minRating * 0.9999) ?? null;
  if (pick == null) warnings.push(`${f(minRating)} A is over the largest standard value here (${list[list.length - 1]} A): use a bigger fuse family, or split the load.`);

  // Inrush
  const shape = SHAPE[wave] ?? 0;
  const t = (tp > 0 ? tp : 0) * 1e-3;
  const i2t = shape && ipk > 0 && t > 0 ? shape * ipk * ipk * t : 0;
  const factor = PULSE[pulses] ?? 0.22;
  const needI2t = i2t / factor;

  const values = [
    { label: ptc ? 'Minimum hold current' : 'Minimum rating', value: f(minRating), unit: 'A', hint: ptc ? `I / K_T, K_T = ${f(kT, 2)}` : `I / (0.75 x ${f(kT, 2)})` },
    { label: ptc ? 'Standard hold current' : 'Standard rating', value: pick != null ? f(pick) : '–', unit: pick != null ? 'A' : '', tone: pick != null ? 'ok' : 'bad',
      hint: pick != null ? `${f((inom / pick) * 100, 2)} % loaded at 25 °C` : 'none fits' },
    { label: 'Voltage rating', value: `≥ ${f(vcirc > 0 ? vcirc : 0)}`, unit: 'V', hint: 'DC rating for DC circuits' },
  ];
  if (!(vcirc > 0)) warnings.push('Give the circuit voltage: the fuse must be rated for it (DC rating on DC).');

  if (!ptc) {
    if (i2t > 0) {
      values.push({ label: 'Inrush I²t', value: fmtEng(i2t, 'A²s'), hint: `${wave}, ${f(ipk)} A, ${f(tp)} ms` });
      values.push({ label: 'Fuse melting I²t, at least', value: fmtEng(needI2t, 'A²s'), tone: 'warn', hint: `/ ${f(factor * 100, 2)} % for ${Number(pulses).toLocaleString('en')} pulses` });
      if (type === 'fast' && ipk > 10 * (pick || minRating)) warnings.push(`The inrush peak is ${f(ipk / (pick || minRating), 2)} x the rating: a fast-acting fuse with enough I²t will be oversized. A time-delay fuse, or an inrush limiter, usually fits better.`);
    } else values.push({ label: 'Inrush I²t', value: 'none given' });
  } else if (ipk > 0 && pick) {
    const itrip = 2 * pick;
    values.push({ label: 'Trip current (typ.)', value: `~${f(itrip)}`, unit: 'A', hint: '≈ 2 x hold; check the part' });
    if (ipk > itrip && t > 0.005) warnings.push(`The ${f(ipk)} A inrush lasts ${f(tp)} ms above the ~${f(itrip)} A trip current: a small PTC can heat and trip. Check the datasheet's time-to-trip curve, or limit the inrush.`);
  }

  // Fault
  if (ifault > 0 && pick) {
    const ref = ptc ? 2 * pick : pick;
    const ratio = ifault / ref;
    const tone = ratio >= (type === 'slow' ? 10 : 5) ? 'ok' : ratio >= 2 ? 'warn' : 'bad';
    values.push({ label: ptc ? 'Fault / trip current' : 'Fault / rating', value: `${f(ratio, 3)} x`, tone,
      hint: ptc ? (ratio >= 1 ? 'trips faster the higher this is' : 'will not trip') : ratio >= 2 ? 'UL 248-14: opens within 2 min at 2 x' : ratio >= 1.35 ? 'UL 248-14: within 60 min at 1.35 x' : 'may never open' });
    values.push({ label: ptc ? 'Max current rating (Imax)' : 'Breaking capacity', value: `≥ ${f(ifault)}`, unit: 'A', hint: 'at the circuit voltage' });
    if (ratio < (ptc ? 1 : 1.35)) warnings.push(`The fault current (${f(ifault)} A) is ${ptc ? 'below the trip current' : 'under 1.35 x the fuse rating'}: the ${ptc ? 'PTC will not trip' : 'fuse may never blow'} and the wiring carries the fault. Protect differently (eFuse, current limit, a lower-rated fuse on a branch with less normal current).`);
    else if (ratio < 2) warnings.push(`At ${f(ratio, 2)} x its ${ptc ? 'trip current' : 'rating'} the ${ptc ? 'PTC' : 'fuse'} may take minutes to open: check that the traces and connectors survive that long.`);
    if (!ptc && ifault > 50) warnings.push(`${f(ifault)} A is more than most SMD fuses can break (often 35-50 A): pick a fuse whose breaking capacity at ${f(vcirc)} V is at least that.`);
  } else if (!(ifault > 0)) warnings.push('Give the fault current the source can deliver, to check that the fuse actually opens.');

  // A table: the rating at other temperatures
  const temps = [0, 25, 40, 60, 85];
  const rows = temps.map((tc) => {
    const k = ptc ? Math.min(1.3, Math.max(0.2, 1 - 0.0065 * (tc - 25))) : Math.min(1, Math.max(0.5, 1 - 0.0025 * (tc - 25)));
    const m = ptc ? inom / k : inom / (0.75 * k);
    return [`${tc} °C`, f(k, 3), f(m), f(list.find((x) => x >= m * 0.9999) ?? NaN)];
  });
  return {
    values,
    warnings,
    tables: [{ title: 'The same load at other temperatures', columns: ['Ambient', 'K_T', ptc ? 'Min hold A' : 'Min rating A', 'Standard A'], rows }],
    notes: [
      ptc ? 'PTC: hold current = carries it forever; trip current = always trips; in between it may or may not. The PTC adds resistance (and voltage drop) and stays hot and high-resistance until the power is removed.'
        : 'The 75 % derating is the UL-fuse rule; IEC 60127 fuses are often run up to ~90 % of rating - check the maker\'s guide.',
      'Temperature re-rating here is a straight-line fit to typical curves: the fuse\'s own re-rating chart wins.',
      !ptc ? 'Pick a part whose nominal melting I²t is at least the value above; then check its time-current curve against the fault current.' : 'Pick a part whose hold current at your ambient (datasheet table) is above the normal current.',
    ],
  };
}
