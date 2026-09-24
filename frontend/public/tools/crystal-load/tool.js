// Crystal load capacitors for a Pierce oscillator (ST AN2867):
//   CL = C1·C2/(C1 + C2) + Cs      ->  with C1 = C2 = C:  C = 2·(CL − Cs)
//   gm,crit = 4·ESR·(2πF)²·(C0 + CL)²     (AN2867 section 3.4)
//   margin: gm,crit ≤ Gm_crit_max (newer datasheets), or gm / gm,crit ≥ 5 (older ones)
// Load pulling from the crystal's equivalent circuit (motional C1m, shunt C0):
//   Δf/f(CL) = C1m / (2·(C0 + CL)), so fitting CLa instead of CL shifts the frequency by
//   C1m/2 · (1/(C0 + CLa) − 1/(C0 + CL))
import { fmtEng, fmtNum, E12, E24 } from '../kit/eng.js';

const E6 = [1.0, 1.5, 2.2, 3.3, 4.7, 6.8];
const SER = { E6, E12, E24 };

function ladder(series) {
  const out = [];
  for (const d of [0.1, 1, 10, 100]) for (const v of series) out.push(Number((v * d).toPrecision(3)));
  return out; // pF, 0.1 … 820
}

export function run({ cl, cs, series, f, esr, c0, cm, gspec, gmode }) {
  const warnings = [];
  if (!(cl > 0)) return { warnings: ['Give the crystal load capacitance CL in pF, from the crystal datasheet (e.g. 12).'] };
  const stray = cs >= 0 ? cs : 0;
  if (cs == null) warnings.push('No stray capacitance given; 0 pF used. A real board adds 3–7 pF.');
  const cExact = 2 * (cl - stray);
  const values = [];
  if (!(cExact > 0)) {
    return { values: [{ label: 'Each capacitor', value: 'none possible', tone: 'bad' }],
      warnings: [`The stray capacitance (${fmtNum(stray)} pF) already reaches CL (${fmtNum(cl)} pF): pick a crystal with a higher CL, or shorten the traces.`] };
  }
  const lad = ladder(SER[series] || E12);
  const near = lad.reduce((b, x) => (Math.abs(x - cExact) < Math.abs(b - cExact) ? x : b), lad[0]);
  const idx = lad.indexOf(near);
  const clOf = (c) => c / 2 + stray;

  const hasF = f > 0, hasC0 = c0 >= 0 && c0 != null, hasCm = cm > 0;
  const ppm = (c) => (hasCm && hasC0 ? (cm * 1e-3 / 2) * (1 / (c0 + clOf(c)) - 1 / (c0 + cl)) * 1e6 : null); // fF→pF
  const clA = clOf(near);
  const errPpm = ppm(near);

  values.push(
    { label: 'Each capacitor (exact)', value: fmtEng(cExact * 1e-12, 'F') },
    { label: `Fit (${series || 'E12'}, C0G/NP0)`, value: fmtEng(near * 1e-12, 'F'), tone: 'ok' },
    { label: 'CL obtained', value: fmtNum(clA, 4), unit: 'pF', hint: `target ${fmtNum(cl, 4)} pF` },
  );
  if (errPpm != null) values.push({ label: 'Frequency error from CL', value: `${errPpm >= 0 ? '+' : ''}${fmtNum(errPpm, 2)}`, unit: 'ppm',
    tone: Math.abs(errPpm) > 10 ? 'warn' : 'ok', hint: 'pulling only; add crystal tolerance' });
  if (cExact < 4) warnings.push(`Only ${fmtNum(cExact, 2)} pF per side: the stray capacitance dominates and varies board to board. A crystal with a higher CL gives a more predictable frequency.`);
  if (errPpm != null && Math.abs(errPpm) > 10) warnings.push(`The standard value pulls the frequency ${fmtNum(errPpm, 2)} ppm; try the ${series === 'E24' ? 'neighbouring' : 'E24'} values in the table or a series with finer steps.`);

  // start-up margin
  let gcrit = null;
  if (hasF && esr > 0 && hasC0) {
    const w = 2 * Math.PI * f;
    gcrit = 4 * esr * w * w * Math.pow((c0 + cl) * 1e-12, 2); // A/V, with the datasheet CL
    const gUA = gcrit * 1e6;
    values.push({ label: 'gm,crit', value: fmtNum(gUA, 3), unit: 'µA/V', hint: `ESR ${fmtEng(esr, 'Ω')}, C0 + CL ${fmtNum(c0 + cl, 3)} pF` });
    if (gspec > 0) {
      if (gmode === 'gm') {
        const gain = gspec / gUA;
        const ok = gain >= 5;
        values.push({ label: 'Gain margin gm / gm,crit', value: fmtNum(gain, 3), tone: ok ? 'ok' : 'bad', hint: 'needs ≥ 5' });
        if (!ok) warnings.push(`Gain margin ${fmtNum(gain, 2)} is under 5: the oscillator may not start over temperature. Use a crystal with lower ESR or lower CL, or a stronger drive setting.`);
      } else {
        const ratio = gUA / gspec;
        const ok = ratio <= 1;
        values.push({ label: 'gm,crit / Gm_crit_max', value: `${fmtNum(ratio * 100, 3)} %`, tone: ok ? (ratio > 0.8 ? 'warn' : 'ok') : 'bad', hint: 'must be ≤ 100 %' });
        if (!ok) warnings.push(`gm,crit ${fmtNum(gUA, 3)} µA/V exceeds the MCU's Gm_crit_max ${fmtNum(gspec, 3)} µA/V: the oscillator may not start. Pick a crystal with lower ESR or lower CL, or a higher drive level.`);
      }
    }
    if (f < 1e6 && esr < 1000) warnings.push('ESR under 1 kΩ at a kHz frequency looks wrong: 32.768 kHz crystals are typically 35–90 kΩ. Check the unit (70k).');
    if (f >= 1e6 && esr > 1000) warnings.push('ESR over 1 kΩ for a MHz crystal looks wrong: MHz crystals are typically 20–150 Ω.');
  }

  const rows = [];
  for (let i = Math.max(0, idx - 2); i <= Math.min(lad.length - 1, idx + 2); i++) {
    const c = lad[i], p = ppm(c);
    rows.push([fmtEng(c * 1e-12, 'F'), fmtNum(clOf(c), 4), p == null ? '–' : `${p >= 0 ? '+' : ''}${fmtNum(p, 2)}`, c === near ? '← fit' : '']);
  }

  return {
    values,
    warnings,
    tables: [{ title: 'Standard values near the exact one', columns: ['Each capacitor', 'CL obtained pF', 'Error ppm', ''], rows }],
    notes: [
      'Use C0G/NP0 capacitors: X7R/X5R drift with temperature and voltage and move the frequency.',
      'The stray figure is the least certain input: measure the real frequency on a board and trim both capacitors together.',
      'Drive level is not checked here: measure it (current probe or AN2867 method) against the crystal\'s maximum, especially for small 32.768 kHz and 2016-size crystals.',
    ],
  };
}
