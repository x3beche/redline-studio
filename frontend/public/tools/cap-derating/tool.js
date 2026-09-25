// MLCC effective capacitance under DC bias, temperature and aging.
//
// DC bias: BaTiO3 permittivity falls with the electric field E across one dielectric layer.
//   A stack of N layers of thickness d in an active volume V: C ≈ ε0·εr·V / d²
//   so d ≈ sqrt(ε0·εr·V / C): the thickest layer the package volume allows for this C.
//   A part is also designed for its rating: its layers are about V_rated / E_design thick
//   (E_design = 8 V/µm, rule of thumb for BME class II parts). The layer is the thinner of the two:
//   d = min(V_rated / E_design, sqrt(ε0·εr·V / C)), and E = V_bias / d. So a lower rating in the same
//   package means thinner layers and more loss, up to the point where the volume caps the thickness.
//   E_design was chosen so parts whose layers are limited by the volume (all that the earlier,
//   volume-only model covered, including both manifest examples) keep their earlier numbers.
//   Remaining fraction  C(E)/C0 = 1 / (1 + (E/E50)^k)   - a logistic fitted by hand to the
//   Murata / TDK published DC-bias curves (rule of thumb, typically within about 15-20 points of the measured percentage).
// Temperature: typical curves (rough, from maker datasheets) and the EIA-198 code band for the
//   worst case (X7R: ±15 % from -55 to 125 °C, and so on).
// Aging: C(t) = C(t0)·(1 - a·log10(t/t0)), t0 = 1000 h (the time the tolerance refers to).
import { fmtEng, fmtNum } from '../kit/eng.js';

const EPS0 = 8.854e-12;
const ACTIVE = 0.5; // fraction of the body that is active dielectric (electrode overlap)
const E_DESIGN = 8; // V/µm: the field across one layer at the rated voltage (rule of thumb)

// Body size in mm: length, width, typical maximum height of the high-capacitance parts.
const PKG = {
  '0201': [0.6, 0.3, 0.3], '0402': [1.0, 0.5, 0.5], '0603': [1.6, 0.8, 0.8], '0805': [2.0, 1.25, 1.25],
  '1206': [3.2, 1.6, 1.6], '1210': [3.2, 2.5, 2.5], '1812': [4.5, 3.2, 2.5], '2220': [5.7, 5.0, 2.5],
};

// er: effective permittivity, e50: field in V/µm at which half the capacitance is left, k: steepness,
// band: EIA code limits [lo, hi, tmin, tmax], curve: typical ΔC vs °C, aging: fraction per decade hour.
const DIEL = {
  C0G: { cls: 1, band: [-0.0035, 0.0035, -55, 125], ppm: 30, aging: 0 },
  X7R: { er: 3000, e50: 3.0, k: 1.6, band: [-0.15, 0.15, -55, 125], aging: 0.015,
    curve: [[-55, -0.10], [-25, -0.05], [0, -0.02], [25, 0], [50, 0.0], [85, -0.03], [105, -0.06], [125, -0.12]] },
  X5R: { er: 3000, e50: 2.5, k: 1.6, band: [-0.15, 0.15, -55, 85], aging: 0.03,
    curve: [[-55, -0.10], [-25, -0.05], [0, -0.02], [25, 0], [50, -0.02], [85, -0.08]] },
  X6S: { er: 3000, e50: 2.3, k: 1.6, band: [-0.22, 0.22, -55, 105], aging: 0.03,
    curve: [[-55, -0.12], [-25, -0.06], [0, -0.02], [25, 0], [50, -0.03], [85, -0.10], [105, -0.16]] },
  X7S: { er: 3000, e50: 2.3, k: 1.6, band: [-0.22, 0.22, -55, 125], aging: 0.03,
    curve: [[-55, -0.12], [-25, -0.06], [0, -0.02], [25, 0], [50, -0.03], [85, -0.08], [125, -0.18]] },
  X8R: { er: 2500, e50: 3.0, k: 1.6, band: [-0.15, 0.15, -55, 150], aging: 0.015,
    curve: [[-55, -0.08], [0, -0.02], [25, 0], [85, -0.01], [125, -0.05], [150, -0.12]] },
  Y5V: { er: 10000, e50: 0.8, k: 1.5, band: [-0.82, 0.22, -30, 85], aging: 0.06,
    curve: [[-30, -0.65], [0, -0.30], [10, -0.10], [25, 0], [50, -0.30], [85, -0.70]] },
};

function interp(curve, t) {
  if (t <= curve[0][0]) { const [a, b] = curve; return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]); }
  for (let i = 1; i < curve.length; i++) {
    const [t0, y0] = curve[i - 1], [t1, y1] = curve[i];
    if (t <= t1) return y0 + (y1 - y0) * (t - t0) / (t1 - t0);
  }
  const a = curve[curve.length - 2], b = curve[curve.length - 1];
  return b[1] + (b[1] - a[1]) * (t - b[0]) / (b[0] - a[0]);
}

// What you need against what is left: a value, and a warning when even the typical falls short.
function needCheck(need, ceff, worst, values, warnings) {
  if (!(need > 0)) return;
  values.push({ label: 'Against what you need', value: `${fmtNum(ceff / need * 100, 3)} %`, tone: worst >= need ? 'ok' : ceff >= need ? 'warn' : 'bad',
    hint: `typical ${fmtEng(ceff, 'F')} for ${fmtEng(need, 'F')}; worst case ${fmtNum(worst / need * 100, 3)} %` });
  if (ceff < need) warnings.push(`Typically ${fmtEng(ceff, 'F')} is left, less than the ${fmtEng(need, 'F')} you need: put parts in parallel, or pick a larger package or a higher rating.`);
  else if (worst < need) warnings.push(`The typical ${fmtEng(ceff, 'F')} meets the ${fmtEng(need, 'F')} you need, but the worst case (${fmtEng(worst, 'F')}) does not.`);
}

export function run({ cnom, vrated, pkg, diel, vbias, temp, tol, years, need }) {
  const warnings = [];
  if (!(cnom > 0)) return { warnings: ['Give the nominal capacitance, e.g. 10u for 10 µF.'] };
  const d = DIEL[diel] || DIEL.X5R;
  const [pl, pw, ph] = PKG[pkg] || PKG['0603'];
  const vb = Math.abs(vbias ?? 0);
  const t = Number.isFinite(temp) ? temp : 25;
  const tolF = (Number(tol) || 10) / 100;
  const yrs = years > 0 ? years : 0;
  if (vrated > 0 && vb > vrated) warnings.push(`${fmtNum(vb, 3)} V is above the ${fmtNum(vrated, 3)} V rating: choose a higher-rated part. Most designs keep class II MLCCs at or below the rating (80 % for reliability).`);
  if (!(vrated > 0)) warnings.push('Give the rated voltage to check the bias against it.');
  if (t < d.band[2] || t > d.band[3]) warnings.push(`${fmtNum(t, 3)} °C is outside ${diel}'s rated range (${d.band[2]} to ${d.band[3]} °C): the part is not specified there. Choose a dielectric rated for it (X7R to 125 °C, X8R to 150 °C).`);
  if (cnom > 1e-3) warnings.push('Over 1 mF is not an MLCC value: check the unit (10u = 10 µF).');

  // Class I (C0G): no bias effect, ±30 ppm/°C.
  if (d.cls === 1) {
    const dT = (t - 25) * d.ppm * 1e-6;
    const worst = cnom * (1 - tolF - Math.abs(dT));
    if (cnom > 0.12e-6) warnings.push('C0G parts above about 0.1 µF are rare and large: check the value.');
    const values = [
      { label: 'Effective capacitance', value: fmtEng(cnom, 'F'), tone: 'ok', hint: '100 % of nominal' },
      { label: 'Worst case', value: fmtEng(worst, 'F'), hint: `-${fmtNum(tolF * 100, 2)} % tolerance, ±30 ppm/°C` },
      { label: 'Bias effect', value: 'none', hint: 'class I dielectric' },
    ];
    needCheck(need, cnom, worst, values, warnings);
    return {
      values,
      // Plain numbers for the page's drawing.
      model: { cls: 1, cnom, ceff: cnom, worst, frac: 1, fBias: 1, fTemp: 1, fAge: 1, tolF, dUm: null, field: 0, vbias: vb, temp: t, pkg, diel,
        body: PKG[pkg] || PKG['0603'], band: d.band, tcurve: [[d.band[2], 1 + (d.band[2] - 25) * d.ppm * 1e-6], [d.band[3], 1 + (d.band[3] - 25) * d.ppm * 1e-6]],
        curve: [[0, 1], [Math.max(vrated > 0 ? vrated : 0, vb, 1), 1]] },
      warnings,
      notes: ['C0G (NP0) is a class I dielectric: no DC-bias or aging loss, ±30 ppm/°C from -55 to 125 °C.'],
    };
  }

  const vol = pl * pw * ph * 1e-9 * ACTIVE; // m³
  const dVolUm = Math.sqrt(EPS0 * d.er * vol / cnom) * 1e6; // µm, what the volume allows
  const dRateUm = vrated > 0 ? vrated / E_DESIGN : Infinity; // µm, what the rating calls for
  const dUm = Math.min(dVolUm, dRateUm);
  const limitBy = dRateUm < dVolUm ? 'rating' : 'volume';
  const biasFrac = (v) => 1 / (1 + Math.pow((v / dUm) / d.e50, d.k));
  const fBias = biasFrac(vb);
  const fTemp = 1 + interp(d.curve, t);
  const hours = yrs * 8766;
  const fAge = hours > 1000 ? 1 - d.aging * Math.log10(hours / 1000) : 1;
  const ceff = cnom * fBias * fTemp * fAge;
  const worst = cnom * (1 - tolF) * fBias * (1 + d.band[0]) * fAge;
  const frac = ceff / cnom;

  if (dVolUm < 0.3) warnings.push(`${fmtEng(cnom, 'F')} is more than ${pkg} parts usually hold: check the package or the value.`);
  if (dVolUm > 60) warnings.push(`${fmtEng(cnom, 'F')} is very small for a class II part in ${pkg}: the model is meant for 1 nF and up. Such parts barely lose capacitance with bias.`);
  if (frac < 0.3) warnings.push(`Only ${fmtNum(frac * 100, 2)} % of the nominal is left. Use a larger package or a higher voltage rating (both give thicker layers), or put more capacitors in parallel.`);
  else if (frac < 0.5) warnings.push(`Less than half of the nominal is left (${fmtNum(frac * 100, 2)} %): size the design with ${fmtEng(ceff, 'F')}, not ${fmtEng(cnom, 'F')}.`);

  const vmax = Math.max(vrated > 0 ? vrated : 0, vb, 1);
  const xs = Array.from({ length: 21 }, (_, i) => (vmax * i) / 20);
  const round = (v) => Number(v.toPrecision(3));
  const unitScale = cnom >= 1e-6 ? [1e-6, 'µF'] : cnom >= 1e-9 ? [1e-9, 'nF'] : [1e-12, 'pF'];
  const chart = {
    title: `Capacitance against DC bias at ${fmtNum(t, 3)} °C`,
    type: 'line',
    x: xs.map((v) => round(v)),
    series: [{ name: 'typical', y: xs.map((v) => round(cnom * biasFrac(v) * fTemp * fAge / unitScale[0])) }],
    xLabel: 'DC bias (V)', yLabel: `capacitance (${unitScale[1]})`,
  };
  const steps = vrated > 0 ? [0, 0.25, 0.5, 0.75, 1].map((k) => k * vrated) : [0, vb];
  const rows = [...new Set([...steps, vb].map((v) => round(v)))].sort((a, b) => a - b).map((v) => {
    const f = biasFrac(v);
    return [`${fmtNum(v, 3)} V`, fmtNum((v / dUm), 3), fmtEng(cnom * f * fTemp * fAge, 'F'), `${fmtNum(f * fTemp * fAge * 100, 3)} %`];
  });

  const values = [
      { label: 'Effective capacitance', value: fmtEng(ceff, 'F'), tone: frac < 0.3 ? 'bad' : frac < 0.5 ? 'warn' : 'ok', hint: `${fmtNum(frac * 100, 3)} % of nominal` },
      { label: 'Worst case', value: fmtEng(worst, 'F'), hint: `-${fmtNum(tolF * 100, 2)} % tolerance and ${fmtNum(d.band[0] * 100, 3)} % ${diel} band` },
      { label: 'DC-bias factor', value: `${fmtNum(fBias * 100, 3)} %`, hint: `field ${fmtNum(vb / dUm, 3)} V/µm` },
      { label: 'Temperature factor', value: `${fmtNum(fTemp * 100, 3)} %`, hint: `typical ${diel} at ${fmtNum(t, 3)} °C` },
      { label: 'Aging factor', value: `${fmtNum(fAge * 100, 3)} %`, hint: yrs ? `${fmtNum(yrs, 3)} years, ${fmtNum(d.aging * 100, 2)} %/decade` : 'not counted' },
      { label: 'Estimated layer thickness', value: fmtNum(dUm, 3), unit: 'µm', hint: limitBy === 'rating'
        ? `set by the ${fmtNum(vrated, 3)} V rating (the volume would allow ${fmtNum(dVolUm, 3)} µm)`
        : `set by the ${pkg} volume${Number.isFinite(dRateUm) ? ` (the rating alone would give ${fmtNum(dRateUm, 3)} µm)` : ''}` },
  ];
  needCheck(need, ceff, worst, values, warnings);
  return {
    values,
    // Plain numbers for the page's drawing: the factors, the body and both curves.
    model: { cls: 2, cnom, ceff, worst, frac, fBias, fTemp, fAge, tolF, dUm, dVolUm, dRateUm: Number.isFinite(dRateUm) ? dRateUm : null, limitBy, field: vb / dUm, vbias: vb, temp: t, pkg, diel,
      body: [pl, pw, ph], band: d.band, tcurve: d.curve.map(([tc, y]) => [tc, 1 + y]),
      curve: Array.from({ length: 41 }, (_, i) => { const v = (vmax * i) / 40; return [v, biasFrac(v) * fTemp * fAge]; }) },
    warnings,
    charts: [chart],
    tables: [{ title: 'Capacitance at other bias voltages', columns: ['DC bias', 'Field (V/µm)', 'Capacitance', 'Of nominal'], rows }],
    notes: [
      'The loss follows the field across one layer: the same capacitance in a larger package, or with a higher rating in the same package, keeps more of its value.',
      `Layer thickness is the thinner of rated voltage ÷ ${E_DESIGN} V/µm and what the package volume allows for this capacitance: a higher rating helps until the volume caps the layer (here ${limitBy === 'rating' ? `the rating sets it; up to about ${fmtNum(dVolUm * E_DESIGN, 3)} V rating would still help` : 'the volume sets it, so a higher rating in this package does not help in the model'}).`,
      'The model assumes the typical maximum chip height for the package and half its volume active; thin (low-profile) parts lose more.',
      'Temperature and bias effects are multiplied; in real parts they interact somewhat. AC ripple of more than about 0.5 Vrms also lowers the value.',
      'For a final design, compare with the maker\'s measured curve (Murata SimSurfing, TDK SEAT, KEMET K-SIM).',
    ],
  };
}
