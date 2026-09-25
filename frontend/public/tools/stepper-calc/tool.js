// Stepper motor: STEP rate from speed, and torque left at that speed.
//   f_step = rev/s × (360 / step angle) × microsteps            (definition)
//   f_elec = rev/s × full steps per rev / 4                      (2-phase hybrid: 4 full steps per electrical cycle)
//   phase:  V_s ≥ |I·(R + j·2π·f_elec·L) + E|,  E = Ke·ω          (first-order winding model, E in phase with I)
//   Ke ≈ T_hold / (√2 · I_rated)  [V·s/rad per phase]             (rule of thumb: holding torque is with both phases on)
//   T(speed) ≈ T_hold · I_avail / I_rated  (· 0.707 when microstepping: peak-per-phase regulation)
//   T_inc = T · sin(90° / n)                                       (Faulhaber, 'Microstepping myths and realities')
import { fmtEng, fmtNum } from '../kit/eng.js';

const TWO_PI = 2 * Math.PI;

// Current the supply can push at a given electrical angular speed: solve
// (I·R + E)² + (X·I)² = V²  for I  (E = back-EMF amplitude, X = ωL).
function currentAt(V, R, X, E) {
  if (E >= V) return 0;
  const a = R * R + X * X, b = 2 * R * E, c = E * E - V * V;
  if (a === 0) return Infinity;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

export function run(inp) {
  const { step, micro, motion, rpm, vlin, lead, thold, irated, idrive, lmh, rph, vs, fmax } = inp;
  const warnings = [];
  if (!(step > 0 && step <= 90)) return { warnings: ['Give the full-step angle in degrees, e.g. 1.8 (200 steps/rev) or 0.9 (400).'] };
  const n = Number(micro) || 1;
  const full = 360 / step;
  if (Math.abs(full - Math.round(full)) > 1e-6) warnings.push(`360 / ${step}° is not a whole number of steps (${fmtNum(full, 5)}): check the step angle.`);
  let rps;
  const linear = motion === 'linear';
  if (linear) {
    if (!(lead > 0)) return { warnings: ['Give the travel per revolution in mm (lead screw lead, or belt pitch × pulley teeth).'] };
    if (vlin == null || !(vlin >= 0)) return { warnings: ['Give the linear speed in mm/s.'] };
    rps = vlin / lead;
  } else {
    if (rpm == null || !(rpm >= 0)) return { warnings: ['Give the shaft speed in rpm.'] };
    rps = rpm / 60;
  }
  const speedRpm = rps * 60;
  const perRev = full * n;
  const fstep = rps * perRev;
  const fel = rps * full / 4;

  const values = [
    { label: 'STEP pulse frequency', value: fmtEng(fstep, 'Hz'), tone: fmax > 0 && fstep > fmax * 1e3 ? 'bad' : 'ok' },
    { label: 'Step period', value: fstep > 0 ? fmtEng(1 / fstep, 's') : '–', hint: 'timer period between pulses' },
    { label: 'Microsteps per revolution', value: fmtNum(perRev, 6) },
    { label: 'Microstep angle', value: fmtNum(step / n, 4), unit: '°' },
  ];
  if (linear) {
    values.push({ label: 'Steps per mm', value: fmtNum(perRev / lead, 6) },
      { label: 'Resolution per microstep', value: fmtEng(lead / perRev * 1e-3, 'm') });
  }
  values.push({ label: 'Shaft speed', value: fmtNum(speedRpm, 4), unit: 'rpm' }, { label: 'Electrical frequency', value: fmtEng(fel, 'Hz') });
  if (fmax > 0 && fstep > fmax * 1e3) warnings.push(`${fmtEng(fstep, 'Hz')} is above the ${fmtNum(fmax, 4)} kHz step input limit: use a coarser microstep setting or a faster pulse source.`);
  if (fstep > 50e3 && !(fmax > 0)) warnings.push(`${fmtEng(fstep, 'Hz')} of STEP pulses is a lot for interrupt-driven stepping: use timer PWM/DMA or less microstepping.`);

  const motorOk = thold > 0 && irated > 0 && idrive > 0 && lmh > 0 && rph != null && rph >= 0 && vs > 0;
  const notes = [
    'Model: one winding with R, L and a back-EMF in phase with the current; ignores detent torque, iron losses, resonance and the chopper\'s decay mode. It is optimistic at high speed - trust the datasheet pull-out curve over it.',
    'Microstepping (n > 1) regulates the peak phase current, so holding torque is about 70.7 % of the two-phases-on full-step value.',
    'Plan the load at no more than 50-70 % of the available torque: steppers lose steps without warning.',
  ];
  let curve = null;
  // For the page's drawing: the numbers it places on the motor, the curve and the pulse train.
  const motor = { step, n, full, perRev, microAngle: step / n, rps, rpm: speedRpm, fstep, period: fstep > 0 ? 1 / fstep : null, fel,
    linear, lead: linear ? lead : null, stepsPerMm: linear ? perRev / lead : null, fmaxHz: fmax > 0 ? fmax * 1e3 : null,
    fmaxRpm: fmax > 0 ? (fmax * 1e3 / perRev) * 60 : null, hzPerRpm: perRev / 60, motorOk };
  if (!motorOk) {
    warnings.push('Give holding torque, rated and driver current, inductance, resistance and supply to estimate torque at speed.');
  } else {
    const L = lmh * 1e-3;
    const ke = thold / (Math.SQRT2 * irated);                 // V per rad/s, per phase (estimate)
    const mf = n > 1 ? Math.SQRT1_2 : 1;
    const tAt = (revs) => {
      const w = TWO_PI * revs, X = TWO_PI * (revs * full / 4) * L;
      const ia = Math.min(idrive, currentAt(vs, rph, X, ke * w));
      return { t: thold * mf * ia / irated, i: ia };
    };
    if (idrive > irated * 1.05) warnings.push(`The driver current ${fmtEng(idrive, 'A')} is above the motor's rated ${fmtEng(irated, 'A')}: the motor will run hot; set the limit at or below rated.`);
    if (idrive * rph > vs) warnings.push('The supply cannot even push the set current through the winding resistance at standstill: raise the supply or lower the current.');
    const hold = thold * mf * Math.min(idrive, irated * 1.5) / irated;
    const here = tAt(rps);
    // corner speed: where the available current first drops below the set current
    let lo = 0, hi = 1;
    while (tAt(hi).i >= idrive * 0.999 && hi < 1e4) hi *= 2;
    for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (tAt(mid).i >= idrive * 0.999) lo = mid; else hi = mid; }
    const corner = lo;
    // speed at which back-EMF alone reaches the supply (torque gone)
    const zero = vs / (ke * TWO_PI);
    const frac = hold > 0 ? here.t / hold : 0;
    const tinc = hold * Math.sin(Math.PI / 2 / n);
    values.push(
      { label: 'Torque at standstill', value: fmtNum(hold, 3), unit: 'N·m', hint: n > 1 ? 'microstepping, set current' : 'full step, set current' },
      { label: 'Torque at this speed (est.)', value: fmtNum(here.t, 3), unit: 'N·m', tone: frac < 0.3 ? 'bad' : frac < 0.6 ? 'warn' : 'ok', hint: `${fmtNum(frac * 100, 3)} % of standstill` },
      { label: 'Phase current reachable', value: fmtEng(here.i, 'A'), hint: `set ${fmtEng(idrive, 'A')}` },
      { label: 'Corner speed', value: fmtNum(corner * 60, 4), unit: 'rpm', hint: 'torque starts to fall above it' },
      { label: 'Back-EMF limit (est.)', value: fmtNum(zero * 60, 4), unit: 'rpm', hint: 'no torque left' },
      { label: 'Torque of one microstep', value: fmtNum(tinc, 3), unit: 'N·m', hint: 'a load above it holds the shaft back by up to a step' },
    );
    if (here.t <= 0) warnings.push(`At ${fmtNum(speedRpm, 4)} rpm the back-EMF reaches the ${vs} V supply: the motor will stall. Raise the supply, use a lower-inductance motor or slow down.`);
    else if (frac < 0.3) warnings.push(`Only ${fmtNum(frac * 100, 3)} % of the standstill torque is left at ${fmtNum(speedRpm, 4)} rpm: expect missed steps under load. Raise the supply voltage (up to the driver's limit) or choose a lower-inductance motor.`);
    if (n >= 32) notes.push(`At 1/${n} one microstep only holds ${fmtNum(tinc, 3)} N·m: finer microstepping gives smoothness, not proportionally better positioning accuracy.`);
    const top = Math.max(rps * 1.5, corner * 3, 1);
    const xs = Array.from({ length: 25 }, (_, i) => (top * i) / 24);
    const topD = Math.max(rps * 1.25, zero * 1.12, corner * 1.5, 1e-3);
    Object.assign(motor, { hold, torque: here.t, current: here.i, frac, cornerRpm: corner * 60, zeroRpm: zero * 60, tinc, mf,
      points: Array.from({ length: 121 }, (_, i) => { const r = (topD * i) / 120; return [r * 60, tAt(r).t]; }) });
    curve = { title: 'Estimated torque against speed', type: 'line', x: xs.map((r) => Math.round(r * 60)),
      series: [{ name: 'torque N·m', y: xs.map((r) => Number(tAt(r).t.toFixed(4))) }], xLabel: 'rpm', yLabel: 'N·m' };
  }
  const table = {
    title: 'STEP frequency at other microstep settings (same speed)',
    columns: ['Microstepping', 'Steps/rev', 'STEP frequency', linear ? 'Resolution' : 'Angle/step'],
    rows: [1, 2, 4, 8, 16, 32, 64, 128, 256].map((m) => [m === 1 ? 'full' : `1/${m}`, fmtNum(full * m, 6), fmtEng(rps * full * m, 'Hz'),
      linear ? fmtEng(lead / (full * m) * 1e-3, 'm') : `${fmtNum(step / m, 4)}°`]),
  };
  return { values, warnings, charts: curve ? [curve] : [], tables: [table], notes, motor };
}
