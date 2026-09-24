// LDO against buck for one rail.
// LDO (TI SLVA118A):  Iin = Iout + Iq,  P = (Vin − Vout)·Iout + Vin·Iq,  η = Vout·Iout / (Vin·Iin)
//                     Tj = Ta + P · θJA
// Buck:               Pin = Pout / η (η from the datasheet curve),  P = Pin − Pout,
//                     about 70 % of the loss in the IC (the rest in the inductor), θJA ≈ 50 °C/W
//                     for a small QFN buck on a 4-layer board (assumption).
// Buck + LDO:         the buck makes Vout + dropout + 150 mV, the LDO cleans it up.
// Efficiency against load (chart): LDO exact; buck loss scaled from the given point as
//   P(I) = P_full · (0.02 + 0.68·(I/Iout) + 0.3·(I/Iout)²) + Vin·20 µA
//   - a rule-of-thumb model of a buck with automatic pulse skipping (PFM) at light load.
import { fmtEng, fmtNum } from '../kit/eng.js';

const THETA = { 'sot23-5': 180, sc70: 250, dfn2x2: 70, sot223: 60, sot89: 110, dpak: 40 };
const THETA_BUCK = 50, BUCK_IC_SHARE = 0.7, TJ_MAX = 125;
const LDO_NOISE = '10-50 µVrms (10 Hz-100 kHz), low-noise LDOs < 10 µVrms';

export function run({ vin, vout, iout, ta, pkg, dropout, iq, eff, ripple, quiet }) {
  const warnings = [];
  if (!(vin > 0) || !(vout > 0)) return { warnings: ['Give the input and output voltages in volts, e.g. 5 and 3.3.'] };
  if (!(iout > 0)) return { warnings: ['Give the load current in amperes, e.g. 300m.'] };
  if (vout >= vin) return { warnings: [`${fmtNum(vout, 3)} V out from ${fmtNum(vin, 3)} V in needs a boost or buck-boost: neither an LDO nor a buck can step up.`] };
  const Ta = Number.isFinite(ta) ? ta : 25;
  const th = THETA[pkg] || 180;
  const vdo = dropout > 0 ? dropout / 1000 : 0.25;
  const iqA = iq > 0 ? iq * 1e-6 : 0;
  let eta = eff > 0 && eff < 100 ? eff / 100 : 0.88;
  if (!(eff > 0 && eff < 100)) warnings.push('Buck efficiency must be between 0 and 100 %: 88 % is used.');
  const rip = ripple > 0 ? ripple : 10;
  const pout = vout * iout;

  // LDO
  const ldoP = (vin - vout) * iout + vin * iqA;
  const ldoEta = pout / (vin * (iout + iqA));
  const ldoTj = Ta + ldoP * th;
  const headroom = vin - vout;
  const ldoRegulates = headroom >= vdo;
  // Buck
  const bPin = pout / eta, bP = bPin - pout;
  const bTj = Ta + bP * BUCK_IC_SHARE * THETA_BUCK;
  // Buck then LDO
  const vmid = Math.min(vin, vout + vdo + 0.15);
  const cEta = eta * (vout / vmid) * (iout / (iout + iqA));
  const cPin = pout / cEta;
  const cLdoP = (vmid - vout) * iout + vmid * iqA;
  const cBuckP = cPin - pout - cLdoP;
  const cTj = Ta + cLdoP * th;

  if (!ldoRegulates) warnings.push(`Only ${fmtEng(headroom, 'V')} of headroom, less than the LDO's ${fmtEng(vdo, 'V')} dropout: the LDO will not regulate. Use a lower-dropout part or a buck (or buck-boost if the input can fall below the output).`);
  if (ldoTj > TJ_MAX) warnings.push(`The LDO would reach ${fmtNum(ldoTj, 3)} °C, over ${TJ_MAX} °C: it dissipates ${fmtEng(ldoP, 'W')}. Use a bigger package (SOT-223, DPAK), a buck, or a series resistor to share the heat.`);
  else if (ldoTj > 100) warnings.push(`The LDO runs at ${fmtNum(ldoTj, 3)} °C: that works but leaves little margin; add copper under it or pick a larger package.`);
  if (quiet && !ldoRegulates) warnings.push('The load is noise-sensitive but an LDO has no headroom here: filter the buck output with a ferrite and an LC stage, or use a low-noise buck.');

  // Recommendation
  let pick, why;
  if (!ldoRegulates) { pick = 'Buck'; why = 'the LDO has no dropout headroom'; }
  else if (ldoTj > TJ_MAX) { pick = quiet ? 'Buck + LDO' : 'Buck'; why = `the LDO alone would overheat (${fmtNum(ldoTj, 3)} °C)`; }
  else if (quiet) { pick = ldoEta >= eta - 0.1 || ldoP < 0.3 ? 'LDO' : 'Buck + LDO'; why = pick === 'LDO' ? 'the load is noise-sensitive and the LDO loses little' : 'the load is noise-sensitive, and a buck ahead of the LDO saves most of the heat'; }
  else if (ldoEta >= eta - 0.05) { pick = 'LDO'; why = `it is about as efficient (${fmtNum(ldoEta * 100, 3)} % against ${fmtNum(eta * 100, 3)} %) and simpler, cheaper and quieter`; }
  else if (ldoP < 0.1) { pick = 'LDO'; why = `it wastes only ${fmtEng(ldoP, 'W')}; a buck pays off when battery life matters`; }
  else { pick = 'Buck'; why = `it saves ${fmtEng(ldoP - bP, 'W')} of heat and ${fmtEng((pout / ldoEta - bPin) / vin, 'A')} of input current`; }

  const values = [
    { label: 'Recommended', value: pick, tone: 'ok', hint: why },
    { label: 'LDO efficiency', value: `${fmtNum(ldoEta * 100, 3)} %`, tone: ldoRegulates ? undefined : 'bad', hint: `Vout/Vin = ${fmtNum(vout / vin * 100, 3)} %` },
    { label: 'LDO dissipation', value: fmtEng(ldoP, 'W'), hint: `Tj ${fmtNum(ldoTj, 3)} °C at θJA ${th} °C/W`, tone: ldoTj > TJ_MAX ? 'bad' : ldoTj > 100 ? 'warn' : 'ok' },
    { label: 'Buck efficiency', value: `${fmtNum(eta * 100, 3)} %`, hint: 'from the datasheet' },
    { label: 'Buck dissipation', value: fmtEng(bP, 'W'), hint: `Tj ≈ ${fmtNum(bTj, 3)} °C` },
    { label: 'Heat saved by the buck', value: fmtEng(ldoP - bP, 'W') },
  ];
  const row = (name, e, pin, pd, tj, noise, parts) => [name, `${fmtNum(e * 100, 3)} %`, fmtEng(pin / vin, 'A'), fmtEng(pd, 'W'), `${fmtNum(tj, 3)} °C`, noise, parts];
  const table = {
    title: 'Side by side',
    columns: ['Option', 'Efficiency', 'Input current', 'Dissipation', 'Hottest Tj', 'Output noise', 'Parts'],
    rows: [
      row('LDO', ldoEta, pout / ldoEta, ldoP, ldoTj, LDO_NOISE, 'IC + 2 capacitors'),
      row('Buck', eta, bPin, bP, bTj, `${fmtNum(rip, 3)} mV p-p at fsw, plus switching spikes`, 'IC + inductor + 3-5 capacitors'),
      row(`Buck to ${fmtNum(vmid, 3)} V + LDO`, cEta, cPin, cBuckP + cLdoP, Math.max(cTj, Ta + cBuckP * BUCK_IC_SHARE * THETA_BUCK), 'LDO noise; its PSRR (typ. 20-40 dB at 1 MHz) lowers the ripple', 'both'),
    ],
  };

  // Efficiency against load, 1 % to 100 % of the given current.
  const fr = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  const pFull = bP;
  const chart = {
    title: 'Efficiency against load',
    type: 'line',
    x: fr.map((f) => fmtEng(f * iout, 'A')),
    series: [
      { name: 'LDO', y: fr.map((f) => Number((100 * (vout * f * iout) / (vin * (f * iout + iqA))).toPrecision(3))) },
      { name: 'Buck, auto PFM (model)', y: fr.map((f) => { const po = vout * f * iout; const pl = pFull * (0.02 + 0.68 * f + 0.3 * f * f) + vin * 20e-6; return Number((100 * po / (po + pl)).toPrecision(3)); }) },
    ],
    xLabel: 'load current', yLabel: 'efficiency (%)',
  };

  return {
    values,
    warnings,
    charts: [chart],
    tables: [table],
    notes: [
      `LDO junction temperature uses θJA = ${th} °C/W, a typical JEDEC figure; your copper area changes it by a factor of two either way.`,
      `The buck's heat assumes ${BUCK_IC_SHARE * 100} % of its loss in the IC at θJA ${THETA_BUCK} °C/W.`,
      'LDO efficiency can never beat Vout/Vin; a buck stays near its datasheet efficiency whatever the drop, until light load.',
      'The buck curve below the given load is a rule-of-thumb model of a buck with automatic pulse skipping; a forced-PWM buck falls much lower at light load.',
      'Buck + LDO assumes the buck keeps the same efficiency at the lower intermediate voltage.',
    ],
  };
}
