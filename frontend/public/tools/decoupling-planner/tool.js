// Decoupling plan by the target-impedance method (Smith et al., IEEE Trans. Adv. Packaging 1999):
//   Z_target = Vdd · ripple / ΔI
// Each capacitor is a series R-L-C: Z = ESR + j(ωL − 1/(ωC)), L = ESL + mounting inductance.
// The regulator is R = Z_target/2 in series with the L that makes it reach Z_target/2·√2 at its
// bandwidth (flat below, inductive above - rule of thumb).
// Everything is combined in parallel as complex admittances, so anti-resonances show.
// Plan: one small 100 nF per supply pin, then greedily add the part that removes the most
// excess impedance (sum of log(|Z|/Z_target) above the target), until |Z| ≤ Z_target.
import { fmtEng, fmtNum } from '../kit/eng.js';

// Typical ESL (nH, part alone) and ESR (Ω) of X7R/X5R MLCCs at their resonance (Murata/TDK data).
const SMALL = {
  '0201': [{ c: 100e-9, esl: 0.30, esr: 0.045 }, { c: 1e-6, esl: 0.30, esr: 0.020 }],
  '0402': [{ c: 100e-9, esl: 0.40, esr: 0.030 }, { c: 1e-6, esl: 0.40, esr: 0.012 }, { c: 10e-6, esl: 0.40, esr: 0.008 }],
  '0603': [{ c: 100e-9, esl: 0.55, esr: 0.025 }, { c: 1e-6, esl: 0.55, esr: 0.010 }, { c: 10e-6, esl: 0.55, esr: 0.005 }],
};
const LARGER = [
  { c: 4.7e-6, pkg: '0603', esl: 0.55, esr: 0.006 },
  { c: 10e-6, pkg: '0603', esl: 0.55, esr: 0.005 },
  { c: 22e-6, pkg: '0805', esl: 0.65, esr: 0.003 },
  { c: 47e-6, pkg: '1206', esl: 0.9, esr: 0.003 },
];
const BULK = { c: 100e-6, pkg: 'polymer (B case)', esl: 1.5, esr: 0.015, polymer: true };

const NF = 121;

export function run({ vdd, ripple, istep, pins, freg, fmax, pkg, lmount, derate, bulk }) {
  const warnings = [];
  if (!(vdd > 0)) return { warnings: ['Give the supply voltage in volts, e.g. 1.8.'] };
  if (!(ripple > 0)) return { warnings: ['Give the allowed ripple in %, e.g. 5.'] };
  if (!(istep > 0)) return { warnings: ['Give the transient current step in amperes, e.g. 0.5.'] };
  const zt = vdd * (ripple / 100) / istep;
  const fr = freg > 0 ? freg : 50e3;
  let fh = fmax > 0 ? fmax : 100e6;
  if (fh <= fr * 10) { fh = fr * 100; warnings.push(`The highest frequency must be well above the regulator bandwidth: ${fmtEng(fh, 'Hz')} is used.`); }
  if (fh > 1e9) { fh = 1e9; warnings.push('Frequencies above 1 GHz are out of reach of board capacitors: the plan stops at 1 GHz.'); }
  else if (fh > 200e6) warnings.push(`Above about 200 MHz, board capacitors are held back by their mounting inductance: meeting ${fmtEng(fh, 'Hz')} takes many parts. The IC package and on-die capacitance usually cover that range.`);
  const npins = pins >= 1 ? Math.min(Math.round(pins), 200) : 1;
  const lm = lmount >= 0 && Number.isFinite(lmount) ? lmount * 1e-9 : 0.5e-9;
  const der = derate > 0 && derate <= 100 ? derate / 100 : 0.7;
  if (!(derate > 0 && derate <= 100)) warnings.push('Effective capacitance must be 1-100 %: 70 % is used.');
  if (ripple > 20) warnings.push(`${fmtNum(ripple, 3)} % ripple is unusually loose: most ICs allow 2-5 % on their supply.`);

  const small = SMALL[pkg] || SMALL['0402'];
  const cands = [...small.map((s) => ({ ...s, pkg: pkg || '0402' })), ...LARGER.filter((l) => !small.some((s) => s.c === l.c)), ...(bulk ? [BULK] : [])];
  cands.forEach((k) => { k.ceff = k.polymer ? k.c : k.c * der; k.l = k.esl * 1e-9 + lm; k.srf = 1 / (2 * Math.PI * Math.sqrt(k.l * k.ceff)); });

  const fs = Array.from({ length: NF }, (_, i) => fr * Math.pow(fh / fr, i / (NF - 1)));
  const w = fs.map((f) => 2 * Math.PI * f);
  // Admittance of one capacitor at each frequency: 1 / (R + jX).
  const admit = (k) => w.map((om) => { const x = om * k.l - 1 / (om * k.ceff); const d = k.esr * k.esr + x * x; return [k.esr / d, -x / d]; });
  const Y = cands.map(admit);
  // Regulator: R + jωL, |Z| = zt/2 flat, zt/√2 at its bandwidth.
  const rv = zt / 2, lv = rv / (2 * Math.PI * fr);
  const yv = w.map((om) => { const x = om * lv; const d = rv * rv + x * x; return [rv / d, -x / d]; });

  const count = cands.map(() => 0);
  const sum = yv.map((y) => [...y]);
  const add = (i, n = 1) => { count[i] += n; for (let j = 0; j < NF; j++) { sum[j][0] += n * Y[i][j][0]; sum[j][1] += n * Y[i][j][1]; } };
  const mag = (y) => 1 / Math.hypot(y[0], y[1]);
  const excess = (extra) => { let e = 0, worst = 0; for (let j = 0; j < NF; j++) { const y = extra ? [sum[j][0] + extra[j][0], sum[j][1] + extra[j][1]] : sum[j]; const r = mag(y) / zt; if (r > 1) e += Math.log(r); if (r > worst) worst = r; } return [e, worst]; };

  const i100 = cands.findIndex((k) => k.c === 100e-9);
  add(i100, npins);
  let [e, worst] = excess();
  let steps = 0;
  const LIMIT = 400;
  while (worst > 1.0001 && steps < LIMIT) {
    let best = -1, bestE = Infinity;
    cands.forEach((k, i) => { const [ei] = excess(Y[i]); if (ei < bestE - 1e-12) { bestE = ei; best = i; } });
    if (best < 0 || bestE >= e - 1e-9) break;
    add(best);
    [e, worst] = excess();
    steps++;
  }
  const total = count.reduce((a, b) => a + b, 0);
  const zs = sum.map(mag);
  let jmax = 0; zs.forEach((z, j) => { if (z > zs[jmax]) jmax = j; });
  const met = zs[jmax] <= zt * 1.0001;
  if (!met) warnings.push(`After ${total} capacitors the impedance still reaches ${fmtEng(zs[jmax], 'Ω')} at ${fmtEng(fs[jmax], 'Hz')}, above the ${fmtEng(zt, 'Ω')} target. ${fs[jmax] > 20e6 ? 'Lower the mounting inductance (via-in-pad, planes close to the surface), or lower the highest frequency.' : 'Allow the bulk capacitor, raise the regulator bandwidth or reduce the current step.'}`);
  if (total > 60) warnings.push(`${total} capacitors is a lot for one supply: check the current step and ripple, and lower the mounting inductance first (it sets the high-frequency count).`);
  if (zt < 0.002) warnings.push(`A ${fmtEng(zt, 'Ω')} target is very low: plane spreading inductance and the regulator's own impedance, not modelled here, will matter. Simulate the PDN.`);

  const plan = cands.map((k, i) => ({ k, n: count[i] })).filter((p) => p.n > 0).sort((a, b) => a.k.c - b.k.c);
  const planRows = plan.map(({ k, n }) => [fmtEng(k.c, 'F'), k.pkg, n, fmtEng(k.ceff, 'F'), fmtEng(k.l, 'H'), fmtEng(k.esr, 'Ω'), fmtEng(k.srf, 'Hz')]);
  const decades = [];
  for (let f = Math.pow(10, Math.ceil(Math.log10(fr))); f <= fh * 1.0001; f *= 10) decades.push(f);
  const zAt = (f) => { const om = 2 * Math.PI * f; const y = [...[rv / (rv * rv + (om * lv) ** 2), -(om * lv) / (rv * rv + (om * lv) ** 2)]];
    cands.forEach((k, i) => { if (!count[i]) return; const x = om * k.l - 1 / (om * k.ceff); const d = k.esr * k.esr + x * x; y[0] += count[i] * k.esr / d; y[1] += count[i] * -x / d; });
    return mag(y); };
  const zRows = decades.map((f) => { const z = zAt(f); return [fmtEng(f, 'Hz'), fmtEng(z, 'Ω'), `${fmtNum(z / zt * 100, 3)} %`, z <= zt * 1.0001 ? 'yes' : 'no']; });

  const r4 = (v) => Number(v.toPrecision(4));
  return {
    values: [
      { label: 'Target impedance', value: fmtEng(zt, 'Ω'), tone: 'ok', hint: `${fmtNum(vdd, 3)} V × ${fmtNum(ripple, 3)} % / ${fmtEng(istep, 'A')}` },
      { label: 'Capacitors', value: total, hint: plan.map(({ k, n }) => `${n} × ${fmtEng(k.c, 'F')}`).join(' + ') },
      { label: 'Worst |Z| in band', value: fmtEng(zs[jmax], 'Ω'), tone: met ? 'ok' : 'bad', hint: `at ${fmtEng(fs[jmax], 'Hz')}` },
      { label: 'Band covered', value: `${fmtEng(fr)}–${fmtEng(fh)}`, unit: 'Hz' },
      { label: 'HF count from inductance alone', value: Math.ceil(2 * Math.PI * fh * (small[0].esl * 1e-9 + lm) / zt), hint: 'N ≥ 2π·fmax·L / Z_target' },
    ],
    warnings,
    tables: [
      { title: 'Capacitor plan', columns: ['Value', 'Package', 'Count', 'Effective C', 'ESL + mount', 'ESR', 'Resonance'], rows: planRows },
      { title: '|Z| of the network at each decade', columns: ['Frequency', '|Z|', 'Of target', 'Under target?'], rows: zRows },
    ],
    plot: {
      target: r4(zt), f: fs.map(r4), z: zs.map(r4),
      parts: plan.map(({ k, n }) => ({ label: `${n} × ${fmtEng(k.c, 'F')} ${k.pkg}`, n, c: r4(k.ceff), l: r4(k.l), esr: r4(k.esr) })),
    },
    notes: [
      'Place the smallest values closest to the pins, each with its own vias to the planes; the mounting inductance is what limits the high end.',
      'Spread the count across the supply pins; the plan assumes all capacitors see the same plane and ignores plane spreading inductance and plane capacitance.',
      'The regulator is modelled as flat below its bandwidth and inductive above. The plan does not model the package and die, which cover the range above the highest frequency.',
      'Ceramic capacitances are multiplied by the effective share you gave; the polymer bulk capacitor is not derated.',
    ],
  };
}
