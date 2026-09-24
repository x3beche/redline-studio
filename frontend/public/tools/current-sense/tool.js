// Shunt + current-sense amplifier into an ADC (TI INA180 / INA240 datasheets):
//   R        = largest standard shunt with Imax·R ≤ Vsense,max
//   G        = largest available gain with G·Imax·R ≤ use·Vspan
//              Vspan = VFS (unidirectional) or VFS/2 (bidirectional, Vref = VFS/2)
//   Vout     = Vref + G·I·R
//   LSB      = VFS / 2^bits  ->  current per step = LSB / (G·R)
//   P        = Imax²·R;  offset error current = Vos / R
import { fmtEng, fmtNum } from '../kit/eng.js';

const GAINS = {
  ina18x: [20, 50, 100, 200],
  ina21x: [50, 75, 100, 200, 500, 1000],
  ina199: [50, 100, 200],
  any: null,
};

// Common current-sense resistor values, ohms.
const SHUNTS = [0.0005, 0.001, 0.0015, 0.002, 0.0025, 0.003, 0.004, 0.005, 0.006, 0.008, 0.01, 0.012, 0.015, 0.02,
  0.025, 0.03, 0.033, 0.039, 0.04, 0.047, 0.05, 0.056, 0.068, 0.075, 0.082, 0.1, 0.12, 0.15, 0.2, 0.22, 0.25, 0.3,
  0.33, 0.39, 0.47, 0.5, 0.56, 0.68, 0.75, 0.82, 1, 1.2, 1.5, 2, 2.2, 3.3, 4.7, 5.6, 6.8, 8.2, 10];

// Typical metal-strip / thick-film current-sense ratings (rule of thumb).
const SIZES = [['0603', 0.25], ['0805', 0.5], ['1206', 1], ['2010', 1], ['2512', 2], ['2512 wide / 3921', 3], ['4-terminal / 5930', 5]];

export function run({ imax, dir, vsh, vfs, bits, head, gains, vos }) {
  const warnings = [];
  if (!(imax > 0)) return { warnings: ['Give the full-scale current in A (e.g. 5).'] };
  if (!(vsh > 0)) return { warnings: ['Give the largest shunt voltage you accept, in mV (e.g. 50).'] };
  if (!(vfs > 0)) return { warnings: ['Give the ADC full-scale voltage in V (e.g. 3.3).'] };
  const nb = bits >= 1 && bits <= 32 ? Math.round(bits) : 12;
  if (!(bits >= 1 && bits <= 32)) warnings.push('ADC bits not between 1 and 32; 12 used.');
  let use = head > 0 && head <= 100 ? head / 100 : 0.9;
  if (!(head > 0 && head <= 100)) warnings.push('Use of ADC range must be 1–100 %; 90 % used.');
  const bi = dir === 'bi';
  const vspan = bi ? vfs / 2 : vfs;
  const vref = bi ? vfs / 2 : 0;
  const vshV = vsh / 1000;
  if (vsh > 200) warnings.push(`${fmtNum(vsh)} mV across the shunt is a lot: most current-sense amplifiers are specified to about 100–200 mV differential. Check the amplifier's input range.`);

  let r = [...SHUNTS].reverse().find((x) => x * imax <= vshV * 1.0001);
  if (!r) { r = SHUNTS[0]; warnings.push(`Even ${fmtEng(r, 'Ω')} drops more than ${fmtNum(vsh)} mV at ${fmtEng(imax, 'A')}; it is used anyway - consider a Hall-effect sensor at this current.`); }
  const set = GAINS[gains] === undefined ? GAINS.ina18x : GAINS[gains];
  let gNeed = (use * vspan) / (imax * r);
  let g;
  if (!set) g = Number(gNeed.toPrecision(3));
  else {
    g = [...set].reverse().find((x) => x <= gNeed * 1.0001);
    if (!g) {
      // even the smallest gain overflows: lower the shunt so the smallest gain fits
      g = set[0];
      const rFit = (use * vspan) / (imax * g);
      const r2 = [...SHUNTS].reverse().find((x) => x <= rFit * 1.0001) || SHUNTS[0];
      warnings.push(`With ${fmtEng(r, 'Ω')} even gain ${g} overflows the ADC, so the shunt was lowered to ${fmtEng(r2, 'Ω')}.`);
      r = r2; gNeed = (use * vspan) / (imax * r);
    }
  }

  const vsFull = imax * r;
  const vout = vref + g * vsFull;
  const vlo = bi ? vref - g * vsFull : 0;
  const lsb = vfs / 2 ** nb;
  const perStep = lsb / (g * r);
  const counts = Math.round((vout / vfs) * (2 ** nb));
  const p = imax * imax * r;
  const rating = 2 * p;
  const size = SIZES.find(([, w]) => w >= rating);
  const offI = vos > 0 ? (vos * 1e-6) / r : null;
  const usedPct = (g * vsFull) / vspan * 100;

  if (vout > vfs) warnings.push(`At ${fmtEng(imax, 'A')} the output reaches ${fmtNum(vout, 3)} V, over the ${fmtNum(vfs, 3)} V ADC range: lower the gain or the shunt.`);
  if (usedPct < 50) warnings.push(`Only ${fmtNum(usedPct, 2)} % of the ADC range is used at full current (the gain steps are coarse here): a larger shunt voltage or the "any gain" option resolves better.`);
  if (p > 3) warnings.push(`The shunt burns ${fmtEng(p, 'W')}: lower the shunt voltage and use more gain, or use a Hall-effect sensor.`);
  if (offI != null && offI > 0.01 * imax) warnings.push(`The amplifier offset alone is ${fmtNum((offI / imax) * 100, 2)} % of full scale: pick a zero-drift amplifier or a larger shunt voltage, or calibrate the zero.`);

  const values = [
    { label: 'Shunt', value: fmtEng(r, 'Ω'), tone: 'ok', hint: `${fmtNum(vsFull * 1000, 3)} mV at ${fmtEng(imax, 'A')}` },
    { label: 'Gain', value: `${fmtNum(g, 3)} V/V`, tone: 'ok', hint: set ? `exact would be ${fmtNum(gNeed, 3)}` : 'set with resistors' },
    { label: 'Shunt power at Imax', value: fmtEng(p, 'W'), tone: p > 1 ? 'warn' : undefined },
    { label: 'Shunt rating ≥', value: fmtEng(rating, 'W'), hint: size ? `e.g. ${size[0]} (typ. ${size[1]} W)` : 'bigger than a chip shunt' },
    { label: 'Output at +Imax', value: fmtNum(vout, 4), unit: 'V', tone: vout > vfs ? 'bad' : 'ok', hint: bi ? `${fmtNum(vlo, 4)} V at −Imax, ${fmtNum(vref, 4)} V at 0` : `${fmtNum(usedPct, 3)} % of range` },
    { label: 'ADC counts at +Imax', value: String(counts), hint: `of ${2 ** nb}` },
    { label: 'Current per ADC step', value: fmtEng(perStep, 'A') },
    { label: 'Offset error', value: offI == null ? '–' : fmtEng(offI, 'A'), hint: offI == null ? 'no offset given' : `${fmtNum((offI / imax) * 100, 2)} % of Imax` },
  ];

  const rows = SHUNTS.filter((x) => x <= r * 2.51 && x >= r / 2.51).map((x) => {
    const gg = set ? ([...set].reverse().find((y) => y <= (use * vspan) / (imax * x) * 1.0001) ?? null) : (use * vspan) / (imax * x);
    return [fmtEng(x, 'Ω'), fmtNum(imax * x * 1000, 3), fmtEng(imax * imax * x, 'W'), gg == null ? 'overflows' : fmtNum(gg, 3),
      gg == null ? '–' : fmtEng(lsb / (gg * x), 'A'), vos > 0 ? fmtEng((vos * 1e-6) / x, 'A') : '–', x === r ? '← chosen' : ''];
  });

  return {
    values,
    warnings,
    tables: [{ title: 'Neighbouring shunt values', columns: ['Shunt', 'mV at Imax', 'Power', 'Gain', 'A per step', 'Offset error', ''], rows }],
    notes: [
      'Use a 4-terminal (Kelvin) layout: route the sense lines from the inner edges of the shunt pads, as a pair.',
      'Shunt tolerance (0.5–1 %) and its temperature coefficient add a gain error; calibrate or choose a low-TCR metal-strip part.',
      'Check the amplifier\'s common-mode range for high-side sensing, and its output swing to the rails (a few mV to 100 mV).',
      bi ? 'Bidirectional: the reference is taken as exactly mid-scale; drive REF from the ADC reference through a divider or buffer.' : 'Unidirectional: near zero current the output sits at the amplifier\'s swing-to-ground limit, so the lowest few mA may read as zero.',
    ],
  };
}
