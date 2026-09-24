// I2C pull-up sizing, after NXP UM10204 section 7.1:
//   Rp(min) = (VDD - VOL(max)) / IOL        - a device must be able to pull it low
//   Rp(max) = tr / (0.8473 * Cb)            - the bus must rise from 0.3 VDD to 0.7 VDD in tr
import { fmtEng, standard, SERIES } from '../kit/eng.js';

const MODES = {
  standard: { name: 'Standard-mode', tr: 1000e-9, iol: 3e-3, vol: 0.4, cmax: 400e-12 },
  fast: { name: 'Fast-mode', tr: 300e-9, iol: 3e-3, vol: 0.4, cmax: 400e-12 },
  fastplus: { name: 'Fast-mode Plus', tr: 120e-9, iol: 20e-3, vol: 0.4, cmax: 550e-12 },
};

export function run({ vdd, mode, cb, series }) {
  const m = MODES[mode] || MODES.fast;
  const warnings = [];
  if (!(vdd > 0)) return { warnings: ['Give the bus supply in volts, e.g. 3.3.'] };
  if (!(cb > 0)) return { warnings: ['Give the bus capacitance in pF, e.g. 100.'] };
  const c = cb * 1e-12;
  const vol = vdd <= 2 ? 0.2 * vdd : m.vol;
  const rmin = (vdd - vol) / m.iol;
  const rmax = m.tr / (0.8473 * c);
  if (c > m.cmax) warnings.push(`${fmtEng(c, 'F')} is over ${m.name}'s ${fmtEng(m.cmax, 'F')} limit: split the bus or add a buffer.`);
  let pick = null;
  if (rmin > rmax) {
    warnings.push(`No resistor works: the bus needs at most ${fmtEng(rmax, 'Ω')} to rise in time, but less than ${fmtEng(rmin, 'Ω')} is more current than a device may sink. Lower the capacitance or the speed.`);
  } else {
    // The largest standard value that still rises in time with some margin:
    // weaker pull-ups waste less current, and 80 % of Rmax leaves room.
    const s = SERIES[series] || SERIES.E24;
    pick = standard(Math.max(rmin, rmax * 0.8), s, 'down');
    if (pick < rmin) pick = standard(rmin, s, 'up');
  }
  const values = [
    { label: 'Minimum pull-up', value: fmtEng(rmin, 'Ω'), hint: `sink ${fmtEng(m.iol, 'A')} at VOL ${vol} V` },
    { label: 'Maximum pull-up', value: fmtEng(rmax, 'Ω'), hint: `rise time ${fmtEng(m.tr, 's')}` },
  ];
  if (pick) {
    const tr = 0.8473 * pick * c;
    values.push(
      { label: `Suggested (${series})`, value: fmtEng(pick, 'Ω'), tone: 'ok' },
      { label: 'Rise time with it', value: fmtEng(tr, 's'), tone: tr <= m.tr ? 'ok' : 'bad', hint: `limit ${fmtEng(m.tr, 's')}` },
      { label: 'Current when low', value: fmtEng(vdd / pick, 'A'), hint: 'per line' },
    );
  }
  const caps = [50, 100, 150, 200, 300, 400];
  return {
    values,
    warnings,
    tables: [{
      title: `${m.name}: the range at other bus capacitances`,
      columns: ['Bus capacitance', 'Min pull-up', 'Max pull-up', 'Fits?'],
      rows: caps.map((p) => {
        const hi = m.tr / (0.8473 * p * 1e-12);
        return [`${p} pF`, fmtEng(rmin, 'Ω'), fmtEng(hi, 'Ω'), hi >= rmin ? 'yes' : 'no'];
      }),
    }],
    notes: ['Rise time is measured from 30 % to 70 % of VDD; 0.8473 = ln(0.7/0.3).',
      'With several pull-ups on one bus, they act in parallel: count them together.'],
  };
}
