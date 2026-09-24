// Buck converter power stage, after TI SLVA477B "Basic Calculation of a Buck Converter's Power Stage":
//   D     = Vout / (Vin · η)                                  (eq. 1)
//   L     = Vout · (Vin,max − Vout) / (ΔIL · fsw · Vin,max)    (eq. 5)  - worst ripple at Vin,max
//   ΔIL   = Vout · (Vin,max − Vout) / (L · fsw · Vin,max)      (eq. 6)
//   Cout ≥ ΔIL / (8 · fsw · ΔVout)                            (eq. 12) - capacitive ripple
//   ESR  ≤ ΔVout / ΔIL                                        (eq. 13)
//   Cin  : Irms = Iout · sqrt(D · (1 − D));  Cin ≥ Iout · D · (1 − D) / (fsw · ΔVin)
// Load step, not in SLVA477B:
//   release (energy balance):  ½L(I1² − I2²) = ½C((Vout + ΔV)² − Vout²)
//   apply   (inductor slew):   C ≥ L · ΔI² / (2 · ΔV · (Vin,min − Vout))
//   loop    (rule of thumb):   C ≥ ΔI / (2π · fc · ΔV),  fc = fsw / 10
import { fmtEng, fmtNum, standard, E12 } from '../kit/eng.js';

export function run({ vinmin, vinmax, vout, iout, fsw, ripple, vripple, istep, vstep, eff, tonmin }) {
  const warnings = [];
  if (!(vout > 0)) return { warnings: ['Give the output voltage in volts, e.g. 3.3.'] };
  if (!(vinmax > 0) && !(vinmin > 0)) return { warnings: ['Give the input voltage range in volts, e.g. 10.8 to 13.2.'] };
  let vmin = vinmin > 0 ? vinmin : vinmax, vmax = vinmax > 0 ? vinmax : vinmin;
  if (vmin > vmax) { [vmin, vmax] = [vmax, vmin]; warnings.push('The minimum input was above the maximum: they were swapped.'); }
  if (!(iout > 0)) return { warnings: ['Give the maximum output current in amperes, e.g. 2.'] };
  if (!(fsw > 0)) return { warnings: ['Give the switching frequency in Hz, e.g. 500k.'] };
  const eta = eff > 0 && eff <= 100 ? eff / 100 : 0.9;
  if (!(eff > 0 && eff <= 100)) warnings.push('Efficiency must be between 0 and 100 %: 90 % is used.');
  if (vmin <= vout / eta) return { warnings: [`A buck only steps down: at ${fmtNum(vmin, 3)} V in, ${fmtNum(vout, 3)} V out needs a duty cycle of ${fmtNum(vout / (vmin * eta) * 100, 3)} %. Raise the minimum input or use a buck-boost.`] };
  const r = ripple > 0 ? ripple / 100 : 0.3;
  if (!(ripple > 0)) warnings.push('Ripple must be above 0 %: 30 % is used.');
  else if (r < 0.1 || r > 0.6) warnings.push(`${fmtNum(ripple, 3)} % ripple is outside the usual 20-40 %: below it the inductor gets large and slow, above it the core and capacitor losses rise and light loads go discontinuous.`);
  const dVout = vripple > 0 ? vripple / 1000 : 0.01 * vout;
  const dI = istep > 0 ? Math.min(istep, iout) : 0;
  const dV = vstep > 0 ? vstep / 1000 : 0.03 * vout;
  const tmin = tonmin > 0 ? tonmin * 1e-9 : 0;

  const dmax = vout / (vmin * eta), dmin = vout / (vmax * eta);
  const lCalc = vout * (vmax - vout) / (r * iout * fsw * vmax);
  const L = standard(lCalc, E12, 'near');
  const rippleAt = (vin) => vout * (vin - vout) / (L * fsw * vin);
  const dIL = rippleAt(vmax);
  const ipk = iout + dIL / 2;
  const irms = Math.sqrt(iout * iout + dIL * dIL / 12);
  const cRipple = dIL / (8 * fsw * dVout);
  const esrMax = dVout / dIL;
  // Load step: the three limits; the largest one decides.
  const i1 = iout, i2 = iout - dI;
  const cRelease = dI > 0 ? L * (i1 * i1 - i2 * i2) / ((vout + dV) ** 2 - vout * vout) : 0;
  const cApply = dI > 0 ? L * dI * dI / (2 * dV * (vmin - vout)) : 0;
  const fc = fsw / 10;
  const cLoop = dI > 0 ? dI / (2 * Math.PI * fc * dV) : 0;
  const cOut = Math.max(cRipple, cRelease, cApply, cLoop);
  const dCin = Math.abs(dmax - 0.5) < Math.abs(dmin - 0.5) ? dmax : dmin;
  const dWorst = dmin <= 0.5 && dmax >= 0.5 ? 0.5 : dCin;
  const icinRms = iout * Math.sqrt(dWorst * (1 - dWorst));
  const dVin = 0.01 * vmin; // input ripple target: 1 % of the lowest input
  const cIn = iout * dWorst * (1 - dWorst) / (fsw * dVin);
  const tonAtMax = dmin / fsw;

  if (tmin > 0 && tonAtMax < tmin) warnings.push(`At ${fmtNum(vmax, 3)} V the on-time is ${fmtEng(tonAtMax, 's')}, below the controller's ${fmtEng(tmin, 's')} minimum: it will skip pulses. Lower the switching frequency to at most ${fmtEng(dmin / tmin, 'Hz')}.`);
  if (dmax > 0.85) warnings.push(`Duty cycle reaches ${fmtNum(dmax * 100, 3)} % at ${fmtNum(vmin, 3)} V: most controllers have a maximum duty cycle near 90 % and a minimum off-time, so check dropout in the datasheet.`);
  if (dI > 0 && cOut === cLoop && cLoop > 3 * cRipple) warnings.push('The load step, not the ripple, sets the output capacitance: a faster loop (higher crossover) or a smaller step lowers it.');
  if (istep > iout) warnings.push('The load step was larger than the maximum output current: it is limited to Iout.');
  if (fsw > 5e6) warnings.push('Above 5 MHz the switching losses and the layout dominate: these formulas still hold, but check the controller supports it.');

  const cur = (v) => fmtEng(v, 'A');
  const values = [
    { label: 'Duty cycle', value: `${fmtNum(dmin * 100, 3)} – ${fmtNum(dmax * 100, 3)}`, unit: '%', hint: `at ${fmtNum(vmax, 3)} V and ${fmtNum(vmin, 3)} V` },
    { label: 'Inductance, calculated', value: fmtEng(lCalc, 'H'), hint: `${fmtNum(r * 100, 3)} % ripple at ${fmtNum(vmax, 3)} V` },
    { label: 'Inductor (E12)', value: fmtEng(L, 'H'), tone: 'ok' },
    { label: 'Ripple current', value: cur(dIL), hint: `${fmtNum(dIL / iout * 100, 3)} % of Iout, peak-to-peak` },
    { label: 'Peak inductor current', value: cur(ipk), hint: `buy Isat ≥ ${cur(ipk * 1.2)} (20 % margin)` },
    { label: 'Inductor RMS current', value: cur(irms), hint: 'for the Irms (heating) rating' },
    { label: 'Output capacitance, min', value: fmtEng(cOut, 'F'), tone: 'ok', hint: cOut === cRipple ? 'set by ripple' : 'set by the load step' },
    { label: 'Output capacitor ESR, max', value: fmtEng(esrMax, 'Ω'), hint: `for ${fmtNum(dVout * 1000, 3)} mV ripple` },
    { label: 'Input capacitor RMS current', value: cur(icinRms), hint: `at D = ${fmtNum(dWorst * 100, 3)} %` },
    { label: 'Input capacitance, min', value: fmtEng(cIn, 'F'), hint: `for ${fmtNum(dVin * 1000, 3)} mV input ripple` },
    { label: 'On-time at max input', value: fmtEng(tonAtMax, 's'), tone: tmin > 0 && tonAtMax < tmin ? 'bad' : undefined },
    { label: 'DCM below', value: cur(dIL / 2), hint: 'load where the ripple reaches zero' },
  ];

  const vins = [...new Set([vmin, (vmin + vmax) / 2, vmax].map((v) => Number(v.toPrecision(4))))];
  const rows = vins.map((vin) => {
    const d = vout / (vin * eta), di = rippleAt(vin);
    return [`${fmtNum(vin, 4)} V`, `${fmtNum(d * 100, 3)} %`, cur(di), cur(iout + di / 2), fmtEng(di / (8 * fsw * dVout), 'F'), fmtEng(d / fsw, 's')];
  });
  const ctab = [
    ['Ripple (SLVA477B eq. 12)', fmtEng(cRipple, 'F')],
    ['Load release, overshoot', dI ? fmtEng(cRelease, 'F') : '–'],
    ['Load apply, inductor slew', dI ? fmtEng(cApply, 'F') : '–'],
    [`Loop response, fc = ${fmtEng(fc, 'Hz')}`, dI ? fmtEng(cLoop, 'F') : '–'],
  ];

  // Inductor current over two periods at the highest input: the waveform the ripple values come from.
  const T = 1 / fsw, n = 40;
  const xs = [], ys = [];
  for (let i = 0; i <= n; i++) {
    const t = (2 * T * i) / n, ph = (t % T) / T;
    const y = ph < dmin ? iout - dIL / 2 + dIL * (ph / dmin) : iout + dIL / 2 - dIL * ((ph - dmin) / (1 - dmin));
    xs.push(Number((t * 1e6).toPrecision(3))); ys.push(Number(y.toPrecision(4)));
  }

  return {
    values,
    warnings,
    charts: [{ title: `Inductor current at ${fmtNum(vmax, 3)} V in`, type: 'line', x: xs, series: [{ name: 'iL', y: ys }], xLabel: 'time (µs)', yLabel: 'current (A)' }],
    tables: [
      { title: 'Across the input range', columns: ['Vin', 'Duty', 'Ripple', 'Peak', 'Cout for ripple', 'On-time'], rows },
      { title: 'What sets the output capacitance', columns: ['Limit', 'Cout min'], rows: ctab },
    ],
    notes: [
      'Continuous conduction and a synchronous stage are assumed. Efficiency only corrects the duty cycle.',
      'Output ripple adds the capacitive part and ESR × ΔIL: keep both below the target, and count the DC-bias loss of ceramic capacitors (see Capacitor Derating).',
      'The loop-response limit assumes a crossover at one tenth of fsw; the controller datasheet or its compensation tool gives the real one.',
      'The input capacitor must carry the RMS current; input capacitance assumes a 1 % input ripple target.',
    ],
  };
}
