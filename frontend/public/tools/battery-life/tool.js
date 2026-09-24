// Battery run time.
//   usable capacity  C_u = C · cells in parallel · usable fraction          [mAh]
//   self-discharge   I_sd = C · parallel · (loss %/month / 100) / 730 h     [mA] (a month = 730 h)
//   run time         t = C_u / (I_avg + I_sd)                               [h]
//   capped at the chemistry's shelf life (the cell dries out / passivates whatever the load).
// Chemistry data: typical figures, BU-802b (self-discharge) and manufacturer datasheets.
import { fmtEng, fmtNum } from '../kit/eng.js';

const H_PER_MONTH = 730;
const CHEM = {
  cr2032: { name: 'CR2032', v: 3.0, cap: 225, sd: 0.08, shelf: 10, cont: 3e-3, pulse: 15e-3, rated: 0.2e-3, note: 'Rated at about 0.2 mA; above ~1 mA continuous, or with pulses over ~10 mA, it delivers far less. Put a large low-leakage capacitor across it for radio bursts.' },
  cr2450: { name: 'CR2450', v: 3.0, cap: 620, sd: 0.08, shelf: 10, cont: 3e-3, pulse: 15e-3, rated: 0.2e-3, note: 'Rated at about 0.2 mA, like other lithium coin cells.' },
  'aa-alk': { name: 'AA alkaline', v: 1.5, cap: 2500, sd: 0.17, shelf: 10, cont: 1, pulse: 2, rated: 25e-3, note: 'Capacity falls steeply above ~100 mA and in the cold.' },
  'aaa-alk': { name: 'AAA alkaline', v: 1.5, cap: 1100, sd: 0.17, shelf: 10, cont: 0.5, pulse: 1, rated: 25e-3, note: 'Capacity falls steeply above ~50 mA and in the cold.' },
  'aa-li': { name: 'AA Li-FeS2', v: 1.5, cap: 3000, sd: 0.08, shelf: 20, cont: 2, pulse: 3, rated: 25e-3, note: 'Keeps its capacity at high drain and down to −40 °C.' },
  'aa-lisocl2': { name: 'AA Li-SOCl2 (ER14505)', v: 3.6, cap: 2600, sd: 0.08, shelf: 20, cont: 0.1, pulse: 0.2, rated: 1e-3, note: 'Bobbin cells passivate: the voltage sags on the first pulse after a long rest. Buffer radio pulses with a hybrid layer capacitor or a supercap.' },
  'aa-nimh': { name: 'AA NiMH', v: 1.2, cap: 2000, sd: 20, shelf: 1, cont: 4, pulse: 10, rated: 400e-3, note: 'High self-discharge: it dominates at low loads. Use an LSD type for long standby.' },
  'aa-lsd': { name: 'AA NiMH LSD', v: 1.2, cap: 1900, sd: 1.3, shelf: 5, cont: 4, pulse: 10, rated: 400e-3, note: 'Low self-discharge NiMH keeps about 85 % after a year.' },
  liion: { name: 'Li-ion / LiPo', v: 3.7, cap: null, sd: 3, shelf: 5, cont: null, pulse: null, rated: null, note: 'Self-discharge includes a protection circuit; check the cell\'s C rating for peaks. Never discharge below its cut-off (about 3.0 V).' },
  lifepo4: { name: 'LiFePO4', v: 3.2, cap: null, sd: 3, shelf: 5, cont: null, pulse: null, rated: null, note: 'Flat discharge curve: state of charge is hard to read from voltage.' },
};

const life = (cu, iavgMa, isdMa) => cu / (iavgMa + isdMa);
const fmtT = (h) => (h >= 24 * 365 * 2 ? `${fmtNum(h / 8766, 3)} years` : h >= 24 * 60 ? `${fmtNum(h / 730.5, 3)} months` : h >= 48 ? `${fmtNum(h / 24, 3)} days` : `${fmtNum(h, 3)} h`);

export function run({ chem, cap, np, iavg, ipeak, usable, sd, shelf }) {
  const warnings = [];
  let c = CHEM[chem];
  if (chem === 'custom') {
    if (!(cap > 0)) return { warnings: ['Give the capacity per cell in mAh for a custom battery, e.g. 1000.'] };
    c = { name: 'Custom cell', v: null, cap, sd: sd >= 0 ? sd : 0, shelf: shelf > 0 ? shelf : 10, cont: null, pulse: null, rated: null, note: null };
    if (!(sd >= 0)) warnings.push('Self-discharge must be 0 or more %/month: 0 used.');
  }
  if (!c) c = CHEM.cr2032;
  const capCell = cap > 0 ? cap : c.cap;
  if (!(capCell > 0)) return { warnings: [`Give the capacity per cell in mAh: a ${c.name} comes in many sizes, e.g. 1000.`] };
  if (!(iavg > 0)) return { warnings: ['Give the average current in A, e.g. 10u for 10 µA.'] };
  let n = np > 0 ? Math.round(np) : 1;
  if (!(np >= 1)) { n = 1; warnings.push('Cells in parallel must be 1 or more: 1 used.'); }
  let u = usable;
  if (!(usable > 0 && usable <= 100)) { u = 80; warnings.push('The usable fraction must be above 0 and at most 100 %: 80 % used.'); }
  const capTot = capCell * n;
  const cu = capTot * (u / 100);
  const iMa = iavg * 1e3;
  const isdMa = (capTot * (c.sd / 100)) / H_PER_MONTH;
  const hRaw = life(cu, iMa, isdMa);
  const hShelf = c.shelf * 8766;
  const h = Math.min(hRaw, hShelf);
  const limit = hRaw > hShelf ? 'shelf life' : isdMa > iMa ? 'self-discharge' : 'load';
  const hNoSd = cu / iMa;

  if (limit === 'shelf life') warnings.push(`The load alone would last ${fmtT(hRaw)}, longer than the ${c.name}'s ~${fmtNum(c.shelf)}-year shelf life: expect the cell to age out first. A smaller cell would do.`);
  if (limit === 'self-discharge') warnings.push(`Self-discharge (${fmtEng(isdMa / 1e3, 'A')} equivalent) drains the cell faster than the load: choose a low self-discharge chemistry.`);
  const perCell = iavg / n, perPeak = ipeak > 0 ? ipeak / n : 0;
  if (c.cont != null && perCell > c.cont) warnings.push(`${fmtEng(perCell, 'A')} average per cell is over the ${fmtEng(c.cont, 'A')} a ${c.name} is meant to supply continuously: the real capacity will be much lower. Use a bigger cell or more in parallel.`);
  else if (c.rated != null && perCell > 5 * c.rated) warnings.push(`The capacity is rated at about ${fmtEng(c.rated, 'A')}; at ${fmtEng(perCell, 'A')} per cell expect less than the rated mAh. Lower the usable fraction.`);
  if (c.pulse != null && perPeak > c.pulse) warnings.push(`${fmtEng(perPeak, 'A')} peaks per cell exceed the ~${fmtEng(c.pulse, 'A')} a ${c.name} delivers without a large voltage drop: buffer the bursts with a capacitor or pick a higher-rate cell.`);
  else if (c.pulse != null && perPeak > c.pulse / 2) warnings.push(`${fmtEng(perPeak, 'A')} peaks are near a ${c.name}'s pulse limit (~${fmtEng(c.pulse, 'A')}): the voltage will dip, more so when cold or near empty. Check brown-out margin.`);

  const values = [
    { label: 'Run time', value: fmtT(h), tone: h >= 8766 ? 'ok' : h >= 720 ? undefined : 'warn', hint: `limited by ${limit}` },
    { label: 'Days', value: fmtNum(h / 24, 4) },
    { label: 'Years', value: fmtNum(h / 8766, 3) },
    { label: 'Usable capacity', value: fmtNum(cu, 4), unit: 'mAh', hint: `${fmtNum(capCell)} mAh × ${n} × ${fmtNum(u)} %` },
    { label: 'Self-discharge as current', value: fmtEng(isdMa / 1e3, 'A'), hint: `${fmtNum(c.sd)} %/month` },
    { label: 'Without self-discharge', value: fmtT(hNoSd) },
    { label: 'Energy stored', value: c.v ? fmtNum((cu * c.v) / 1000, 4) : '–', unit: c.v ? 'Wh' : '', hint: c.v ? `at ${fmtNum(c.v)} V nominal` : undefined },
  ];
  const currents = [1e-6, 3e-6, 10e-6, 30e-6, 100e-6, 300e-6, 1e-3, 3e-3, 10e-3, 30e-3, 100e-3];
  const rows = currents.map((i) => {
    const hr = Math.min(life(cu, i * 1e3, isdMa), hShelf);
    return [fmtEng(i, 'A'), fmtT(hr), fmtNum(hr / 24, 4), c.cont != null && i / n > c.cont ? 'over rating' : ''];
  });
  return {
    values,
    warnings,
    tables: [{ title: 'Run time at other average currents', columns: ['Average current', 'Run time', 'Days', ''], rows }],
    notes: [
      ...(c.note ? [c.note] : []),
      'Self-discharge is taken as a constant loss of the full capacity per month, which is on the safe side: real cells lose a share of what is left. Figures are typical at room temperature and roughly double every 10 °C warmer.',
      'The rated mAh is measured at a light constant load to a set cut-off voltage. If your circuit stops at a higher voltage, lower the usable fraction.',
    ],
  };
}
