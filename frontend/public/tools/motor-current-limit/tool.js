// Chopper motor driver current limit from VREF and the sense resistor.
// Each driver's regulation equation is from its datasheet (see DRIVERS).
// Stepper coils in microstepping follow a sine: rms = peak / √2.
import { fmtEng, fmtNum } from '../kit/eng.js';

const DRIVERS = {
  // gain: I_peak = VREF / (gain × Rs)
  a4988: { name: 'A4988', gain: 8, vrefMax: 4, vsMax: 0.5, iMax: 2, iBare: 1, stepper: true, src: 'ITripMAX = VREF / (8 × RS)' },
  drv8825: { name: 'DRV8825', gain: 5, vrefMax: 3.5, vsMax: 0.7, iMax: 2.5, iBare: 1.5, stepper: true, src: 'ICHOP = VREF / (5 × RISENSE)' },
  a4950: { name: 'A4950', gain: 10, vrefMax: 5, vsMax: 0.5, iMax: 3.5, stepper: false, src: 'ITRIP = VREF / (10 × RS)' },
  drv8870: { name: 'DRV8870', gain: 10, vrefMax: 5, vsMax: 0.5, iMax: 3.6, stepper: false, src: 'ITRIP = VREF / (10 × RISEN)' },
  // TMC22xx standalone: I_rms = (VREF/2.5 V) · VFS / (Rs + 20 mΩ) / √2, VREF clamps at 2.5 V
  tmc22xx: { name: 'TMC2208/2209', vrefMax: 2.5, iMax: 2.8, iRmsMax: 2, stepper: true, tmc: true, src: 'IRMS = VREF/2.5 V × VFS/(RSENSE + 20 mΩ) / √2' },
};

export function run({ driver, mode, rs, iset, vref, kind, gain, vsense, irated }) {
  const d = driver === 'custom' ? { name: 'custom driver', gain, stepper: true, src: 'I = VREF / (gain × Rs)' } : (DRIVERS[driver] || DRIVERS.a4988);
  const warnings = [];
  if (!(rs > 0)) return { warnings: ['Give the sense resistor in ohms, e.g. 0.068 or 0.1 (read the marking: R068 = 0.068 Ω).'] };
  if (rs > 2) warnings.push(`${fmtEng(rs, 'Ω')} is unusually large for a sense resistor (they are 0.05-0.5 Ω): check the value or the marking.`);
  if (!d.tmc && !(d.gain > 0)) return { warnings: ['Give the driver gain (VREF divided by the sense voltage at the limit), e.g. 5 or 8.'] };
  const vfs = vsense === '1' ? 0.18 : 0.325;
  // peak current from VREF, and VREF from peak current
  const iOf = (v) => (d.tmc ? (Math.min(v, 2.5) / 2.5) * vfs / (rs + 0.02) : v / (d.gain * rs));
  const vOf = (ip) => (d.tmc ? (ip * (rs + 0.02) / vfs) * 2.5 : ip * d.gain * rs);
  const toPeak = (i) => (kind === 'rms' && d.stepper ? i * Math.SQRT2 : i);
  let v, ipk;
  if (mode === 'current') {
    if (vref == null || !(vref >= 0)) return { warnings: ['Give the VREF you measured, in volts (between the trimpot wiper and GND).'] };
    v = vref; ipk = iOf(v);
    if (d.tmc && v > 2.5) warnings.push(`VREF above 2.5 V is clipped by the TMC: the current stays at ${fmtEng(ipk, 'A')} peak. Turn it down.`);
  } else {
    if (!(iset > 0)) return { warnings: ['Give the coil current you want, in amperes.'] };
    ipk = toPeak(iset); v = vOf(ipk);
  }
  const irms = d.stepper ? ipk / Math.SQRT2 : ipk;
  const vsns = d.tmc ? ipk * (rs + 0.02) : ipk * rs;
  // Worst-case sense resistor dissipation: the coil current flows through it the whole cycle.
  const prs = irms * irms * rs;
  const values = [
    { label: 'VREF', value: fmtNum(v, 3), unit: 'V', tone: d.vrefMax && v > d.vrefMax ? 'bad' : 'ok', hint: d.vrefMax ? `max ${d.vrefMax} V` : null },
    { label: 'Peak coil current', value: fmtEng(ipk, 'A'), hint: 'the chopper limit' },
    { label: d.stepper ? 'RMS coil current' : 'Motor current', value: fmtEng(irms, 'A'), hint: d.stepper ? 'microstepping, sine' : 'at the limit' },
    { label: 'Sense voltage at limit', value: fmtEng(vsns, 'V'), tone: d.vsMax && vsns > d.vsMax ? 'bad' : null },
    { label: 'Sense resistor dissipation', value: fmtEng(prs, 'W'), hint: `choose ≥ ${fmtEng(Math.max(0.125, prs * 2), 'W')} rating` },
  ];
  if (driver === 'a4988' || driver === 'drv8825') values.push({ label: 'Full-step coil current', value: fmtEng(ipk * Math.SQRT1_2, 'A'), hint: 'full-step mode: 70.7 % of the limit' });
  if (d.vrefMax && v > d.vrefMax) warnings.push(`VREF ${fmtNum(v, 3)} V is above the ${d.name}'s ${d.vrefMax} V range: use a larger sense resistor or accept a lower current.`);
  if (d.vsMax && vsns > d.vsMax) warnings.push(`The sense voltage ${fmtEng(vsns, 'V')} is above the ${d.name}'s ${fmtEng(d.vsMax, 'V')} limit: use a smaller sense resistor.`);
  if (d.iMax && ipk > d.iMax) warnings.push(`${fmtEng(ipk, 'A')} peak is above the ${d.name}'s ${fmtEng(d.iMax, 'A')} absolute rating: choose a bigger driver.`);
  else if (d.iRmsMax && irms > d.iRmsMax) warnings.push(`${fmtEng(irms, 'A')} rms is above the ${d.name}'s ${fmtEng(d.iRmsMax, 'A')} rms rating (TMC2208: 1.4 A): choose a bigger driver.`);
  else if (d.iBare && ipk > d.iBare) warnings.push(`Above about ${fmtEng(d.iBare, 'A')} the ${d.name} needs a heatsink and airflow, or its thermal shutdown will cut in.`);
  if (irated > 0) {
    const motorI = ipk;   // motor rating is per phase, both phases on (DC) ≈ the peak of the sine
    values.push({ label: 'Of motor rating', value: fmtNum((motorI / irated) * 100, 3), unit: '%', tone: motorI > irated * 1.05 ? 'bad' : motorI < irated * 0.5 ? 'warn' : 'ok' });
    if (motorI > irated * 1.05) warnings.push(`The limit ${fmtEng(motorI, 'A')} is above the motor's rated ${fmtEng(irated, 'A')}: it will overheat. Set VREF for ${fmtNum(vOf(irated), 3)} V or less.`);
  }
  const rows = [0.5, 0.8, 1, 1.2, 1.5, 1.7, 2, 2.5].map((i) => [fmtEng(i, 'A'), fmtNum(vOf(i), 3) + ' V', fmtEng(d.stepper ? i / Math.SQRT2 : i, 'A'),
    (d.vrefMax && vOf(i) > d.vrefMax) || (d.iMax && i > d.iMax) ? 'no' : 'yes']);
  const notes = [`${d.name}: ${d.src}.`,
    'Measure VREF between the trimpot wiper (or VREF pin) and GND with the driver powered, motor idle.',
    'Stepper motor ratings are per phase with both phases on; setting the chopper limit to that value is the usual choice.'];
  if (d.tmc) notes.push('TMC: the 20 mΩ adds the internal bond wires and traces; with UART control IRUN/IHOLD (CS) scale it by (CS+1)/32 and VREF is ignored unless i_scale_analog = 1.');
  // The numbers for a drawing: the operating point and the limits it is held against.
  const motor = {
    driver: driver in DRIVERS || driver === 'custom' ? driver : 'a4988', name: d.name, stepper: !!d.stepper, tmc: !!d.tmc, gain: d.tmc ? null : d.gain,
    mode: mode === 'current' ? 'current' : 'vref', kind: kind === 'rms' ? 'rms' : 'peak', rs,
    vref: v, ipk, irms, vsense: vsns, prs, prsRating: Math.max(0.125, prs * 2),
    fullStep: driver === 'a4988' || driver === 'drv8825' ? ipk * Math.SQRT1_2 : null,
    vrefMax: d.vrefMax ?? null, vsMax: d.vsMax ?? null, iMax: d.iMax ?? null, iRmsMax: d.iRmsMax ?? null, iBare: d.iBare ?? null,
    irated: irated > 0 ? irated : null, ofRated: irated > 0 ? (ipk / irated) * 100 : null,
    ladder: [0.5, 0.8, 1, 1.2, 1.5, 1.7, 2, 2.5].map((i) => ({ i, vref: vOf(i) })), // VREF for other peak currents (the table)
    iAtVrefMax: d.vrefMax ? iOf(d.vrefMax) : null, // the most this Rs allows at the top of the VREF range
    vfs: d.tmc ? vfs : null, clipped: !!(d.tmc && mode === 'current' && v > 2.5),
  };
  return { motor, values, warnings, notes,
    tables: [{ title: `VREF for other peak currents with ${fmtEng(rs, 'Ω')}`, columns: ['Peak current', 'VREF', d.stepper ? 'RMS' : 'Current', 'Within ratings'], rows }] };
}
