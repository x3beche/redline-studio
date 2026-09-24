// Trace Width, ported from the app's Angular calculator (src/app/tools/trace-width/trace-width.ts)
// so an agent gets the same answers: the width a current needs on an outer and an
// inner layer, what that track drops and burns, what a given width carries, and a via.
import { fmtEng, fmtNum } from '../kit/eng.js';

// IPC-2221 (the published curve fit of its conductor-sizing charts):
//   I = k · ΔT^0.44 · A^0.725, A the copper's cross-section in square mils.
// Outer layers shed heat into the air, inner ones only into the board, so an
// inner track needs about 2.6 times the section.
const K = { outer: 0.048, inner: 0.024 };
const MIL_PER_OZ = 1.378;              // 1 oz/ft² of copper is 35 µm thick
const MM_PER_MIL = 0.0254;
const RHO_20 = 1.724e-8;               // annealed copper, Ω·m at 20 °C (IACS)
const ALPHA = 0.00393;                 // its resistance rise per °C
const WEIGHTS = [0.5, 1, 2, 3];

/** The cross-section a current needs, in square mils. */
const areaFor = (amps, rise, layer) => Math.pow(amps / (K[layer] * Math.pow(rise, 0.44)), 1 / 0.725);
/** The current a cross-section carries at a temperature rise. */
const ampsFor = (areaMil2, rise, layer) => K[layer] * Math.pow(rise, 0.44) * Math.pow(areaMil2, 0.725);
/** Resistance of a copper strip, hot: length and section in metres. */
const ohms = (lengthM, areaM2, tempC) => RHO_20 * (1 + ALPHA * (tempC - 20)) * lengthM / areaM2;

export function run(input) {
  const i = input.amps > 0 ? input.amps : null;
  const dt = input.rise > 0 ? input.rise : null;
  const oz = WEIGHTS.includes(Number(input.oz)) ? Number(input.oz) : 1;
  const t = oz * MIL_PER_OZ;
  const ambient = input.ambient ?? 25;
  const hot = ambient + (dt ?? 0);
  const warnings = [];
  const values = [];
  const tables = [];
  const notes = [
    `Copper ${oz} oz/ft² = ${fmtNum(oz * 35, 3)} µm (${fmtNum(t, 4)} mil) thick; resistance at ${fmtNum(hot, 4)} °C (ambient + rise).`,
    'Inner layers use half the outer k (0.024 against 0.048), so they need about 2.6 times the cross-section.',
    'IPC-2152 (which replaced these charts) gives narrower tracks for most boards with planes; IPC-2221 is the conservative figure.',
  ];

  if (dt === null) return { warnings: ['Give the allowed temperature rise in °C, above 0 (10 °C is a common choice).'] };
  if (i === null) warnings.push('Give the current in A, above 0, to size a track.');

  // ---- the track a current needs ----
  const len = (input.length ?? 0) / 1000;
  if (i !== null) {
    const one = (layer) => {
      const mil = areaFor(i, dt, layer) / t;
      const section = (mil * MM_PER_MIL / 1000) * (t * MM_PER_MIL / 1000);
      const r = len > 0 ? ohms(len, section, hot) : 0;
      return { mil, mm: mil * MM_PER_MIL, r, v: i * r, p: i * i * r };
    };
    const outer = one('outer'), inner = one('inner');
    values.push(
      { label: 'Outer layer width', value: fmtNum(outer.mm, 3), unit: 'mm', hint: `${fmtNum(outer.mil, 3)} mil`, tone: 'ok' },
      { label: 'Inner layer width', value: fmtNum(inner.mm, 3), unit: 'mm', hint: `${fmtNum(inner.mil, 3)} mil`, tone: 'ok' },
    );
    tables.push({
      title: `A track for ${fmtNum(i, 4)} A at ${fmtNum(dt, 4)} °C rise${len > 0 ? `, ${fmtNum(len * 1000, 4)} mm long` : ''}`,
      columns: ['Layer', 'Width (mm)', 'Width (mil)', 'Resistance', 'Voltage drop', 'Power lost'],
      rows: [['outer', outer], ['inner', inner]].map(([n, x]) => [n, fmtNum(x.mm, 3), fmtNum(x.mil, 3),
        ...(len > 0 ? [fmtEng(x.r, 'Ω'), fmtEng(x.v, 'V'), fmtEng(x.p, 'W')] : ['–', '–', '–'])]),
    });
    if (!(len > 0)) warnings.push('Give the track length in mm to get its resistance, voltage drop and power loss.');
    // The range the chart was measured on: up to 35 A, 10-100 °C rise, 400 mil (about 10 mm) wide.
    if (i > 35 || dt < 10 || dt > 100 || outer.mm > 10.4) {
      warnings.push("Past what IPC-2221's curves were measured on (up to 35 A, 10–100 °C rise, 10 mm wide): read it as a rough figure, and widen, pour a plane or use heavier copper instead.");
    }
  }

  // ---- what a track of a given width carries ----
  const w = input.width;
  if (w > 0) {
    const area = (w / MM_PER_MIL) * t;
    const co = ampsFor(area, dt, 'outer'), ci = ampsFor(area, dt, 'inner');
    values.push(
      { label: `A ${fmtNum(w, 4)} mm track carries, outer`, value: fmtNum(co, 3), unit: 'A', hint: `${fmtNum(dt, 4)} °C rise, ${oz} oz` },
      { label: `A ${fmtNum(w, 4)} mm track carries, inner`, value: fmtNum(ci, 3), unit: 'A', hint: `${fmtNum(dt, 4)} °C rise, ${oz} oz` },
    );
  }

  // ---- a via: the barrel as a tube of plating, rated like an outer track ----
  const d = input.drill, pl = input.plating, h = input.board;
  if (d > 0 && pl > 0 && h > 0) {
    const tMm = pl / 1000;
    // The plated ring: π · (d + t) · t, the drill being the inside.
    const sectionMm2 = Math.PI * (d + tMm) * tMm;
    const amps = ampsFor(sectionMm2 / (MM_PER_MIL * MM_PER_MIL), dt, 'outer');
    const r = ohms(h / 1000, sectionMm2 / 1e6, hot);
    values.push(
      { label: 'One via carries', value: fmtNum(amps, 3), unit: 'A', hint: `${fmtNum(d, 3)} mm drill, ${fmtNum(pl, 3)} µm plating` },
      { label: 'Via resistance', value: fmtEng(r, 'Ω'), hint: `${fmtNum(h, 3)} mm barrel` },
    );
    if (i !== null) values.push({ label: `Vias for ${fmtNum(i, 4)} A`, value: Math.max(1, Math.ceil(i / amps)), hint: 'use one more where it is close' });
    notes.push('A via is rated as its plated barrel, a tube of copper, treated like an outer track: a rough guide.');
  } else {
    warnings.push('Give the via drill (mm), plating (µm) and board thickness (mm), all above 0, to rate a via.');
  }

  return { values, tables, warnings, notes };
}
