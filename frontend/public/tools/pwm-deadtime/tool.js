// PWM & Dead-time Calculator for an STM32 advanced-control timer (TIM1/TIM8).
//
// Period (RM0090 §17.3.10 / RM0008 §14.3.10, PWM mode):
//   edge-aligned (up-counting)  f = fCK / ((PSC+1)(ARR+1)),  duty = CCR/(ARR+1)
//   center-aligned (CMS != 00)  f = fCK / (2 (PSC+1) ARR),   duty = CCR/ARR
// Dead time (TIMx_BDTR.DTG[7:0], RM0090 §17.4.18, same on F1/F3/F7/G4/H7):
//   DTG[7:5] = 0xx : DT = DTG[7:0]        x tDTS
//   DTG[7:5] = 10x : DT = (64 + DTG[5:0]) x 2  tDTS
//   DTG[7:5] = 110 : DT = (32 + DTG[4:0]) x 8  tDTS
//   DTG[7:5] = 111 : DT = (32 + DTG[4:0]) x 16 tDTS
//   tDTS = tCK_INT x 1, 2 or 4 from TIMx_CR1.CKD[1:0].
// The dead time delays the rising edge of OCx and of OCxN; a pulse shorter
// than the dead time is not generated at all (RM0090 §17.3.13).
// Suggested dead time (Infineon AN2007-04):
//   t_dead = ((td_off,max - td_on,min) + (t_pd,max - t_pd,min)) x 1.2
import { fmtEng, fmtNum } from '../kit/eng.js';

const ns = (s) => s * 1e9;
const CKD = [1, 2, 4];

/** DT in tDTS units for a DTG byte. */
export function dtgTicks(dtg) {
  const d = dtg & 0xff;
  if ((d & 0x80) === 0) return d;
  if ((d & 0xc0) === 0x80) return (64 + (d & 0x3f)) * 2;
  if ((d & 0xe0) === 0xc0) return (32 + (d & 0x1f)) * 8;
  return (32 + (d & 0x1f)) * 16;
}
export const dtgRange = (dtg) => ((dtg & 0x80) === 0 ? 0 : (dtg & 0xc0) === 0x80 ? 1 : (dtg & 0xe0) === 0xc0 ? 2 : 3);

/** The smallest DTG whose dead time is at least `ticks` tDTS; null if none. */
export function dtgFor(ticks) {
  let best = null;
  for (let d = 0; d < 256; d++) {
    const t = dtgTicks(d);
    if (t >= ticks * (1 - 1e-6) && (best == null || t < dtgTicks(best))) best = d;
  }
  return best;
}

const num = (v, d) => (Number.isFinite(v) ? v : d);

export function run(input) {
  const warnings = [], notes = [];
  const fck = num(input.fclk, 0);
  const f = num(input.freq, 0);
  const center = input.mode === 'center';
  const bits = input.width === '32' ? 32 : 16;
  const maxCnt = bits === 32 ? 0xffffffff : 0xffff;
  const duty = Math.min(100, Math.max(0, num(input.duty, 50))) / 100;
  const comp = input.complementary !== false;
  if (!(fck > 0) || !(f > 0)) {
    return { warnings: ['Give a timer clock and a PWM frequency above zero.'], values: [{ label: 'PWM frequency', value: '-' }] };
  }
  if (num(input.duty, 50) < 0 || num(input.duty, 50) > 100) warnings.push('Duty is limited to 0-100 %.');

  // ---- PSC / ARR ----
  const N = center ? fck / (2 * f) : fck / f; // counts per period x (PSC+1)
  const period = (psc, arr) => (center ? 2 * (psc + 1) * arr : (psc + 1) * (arr + 1)) / fck;
  const arrFor = (psc) => Math.max(1, Math.round(center ? N / (psc + 1) : N / (psc + 1) - 1));
  const pscMin = Math.max(0, Math.ceil(N / (center ? maxCnt : maxCnt + 1)) - 1);
  let psc = pscMin;
  const pscIn = input.psc;
  if (Number.isFinite(pscIn) && String(pscIn) !== '') {
    const p = Math.round(pscIn);
    if (p < 0 || p > 0xffff) warnings.push(`PSC ${p} is outside 0-65535; the best one is used.`);
    else if (arrFor(p) > maxCnt) warnings.push(`PSC ${p} needs ARR ${arrFor(p)}, more than the ${bits}-bit counter holds; PSC ${pscMin} is used.`);
    else psc = p;
  }
  if (psc > 0xffff) {
    psc = 0xffff;
    warnings.push(`${fmtEng(f, 'Hz')} is too slow for this clock even with PSC 65535; use a slower timer clock or a 32-bit timer.`);
  }
  let arr = Math.min(maxCnt, arrFor(psc));
  if (N < 2) warnings.push(`${fmtEng(f, 'Hz')} is too fast: the period is under two timer ticks.`);
  const T = period(psc, arr);
  const fAct = 1 / T;
  const err = (fAct - f) / f * 100;
  const steps = center ? arr : arr + 1; // distinct duty levels between 0 and 100 %
  const resBits = Math.log2(Math.max(1, steps));
  const ccr = Math.round(duty * steps);
  const dutyAct = ccr / steps;
  if (resBits < 8) warnings.push(`Only ${fmtNum(resBits, 3)} bits of duty resolution (${steps} steps): the clock is too slow for ${fmtEng(f, 'Hz')}. Raise the timer clock or lower the frequency.`);
  if (Math.abs(err) > 0.5) warnings.push(`The nearest frequency is ${fmtEng(fAct, 'Hz', 5)} (${fmtNum(err, 3)} % off).`);

  // ---- dead time ----
  const tck = 1 / fck;
  let dtReq = Math.max(0, num(input.deadtime, 0)) * 1e-9;
  let suggest = null;
  if (input.suggest) {
    const off = num(input.tdoff, 0), on = num(input.tdon, 0), pmax = num(input.tpdmax, 0), pmin = num(input.tpdmin, 0);
    suggest = Math.max(0, ((off - on) + (pmax - pmin)) * 1.2) * 1e-9;
    notes.push(`Suggested dead time ((${fmtNum(off)} - ${fmtNum(on)}) + (${fmtNum(pmax)} - ${fmtNum(pmin)})) x 1.2 = ${fmtNum(ns(suggest), 4)} ns (Infineon AN2007-04).`);
    if (dtReq < suggest) warnings.push(`The dead time ${fmtNum(ns(dtReq), 4)} ns is below the ${fmtNum(ns(suggest), 4)} ns the switch timings call for: risk of shoot-through.`);
  }
  let ckd = input.ckd === '2' ? 1 : input.ckd === '4' ? 2 : input.ckd === '1' ? 0 : null;
  if (ckd == null) {
    ckd = 0;
    while (ckd < 2 && dtgFor(dtReq / (tck * CKD[ckd])) == null) ckd++;
  }
  const tdts = tck * CKD[ckd];
  let dtg = dtgFor(dtReq / tdts);
  if (dtg == null) {
    dtg = 255;
    warnings.push(`${fmtNum(ns(dtReq), 4)} ns is more than the timer can insert (${fmtNum(ns(1008 * tdts), 4)} ns at CKD /${CKD[ckd]}). ${ckd < 2 ? 'Use a larger CKD or ' : ''}a slower timer clock, or add dead time in the gate driver.`);
  }
  const dt = comp ? dtgTicks(dtg) * tdts : 0;
  const range = dtgRange(dtg);
  const stepDt = [1, 2, 8, 16][range] * tdts;
  if (comp && dtReq > 0 && dt - dtReq > 1e-12) notes.push(`${fmtNum(ns(dtReq), 4)} ns is not a DTG step here; the next longer one, ${fmtNum(ns(dt), 5)} ns, is used (steps of ${fmtNum(ns(stepDt), 4)} ns in this range).`);
  if (ckd > 0 && input.ckd !== '1' && input.ckd !== '2' && input.ckd !== '4') notes.push(`CKD = /${CKD[ckd]}: at /1 the DTG cannot reach ${fmtNum(ns(dtReq), 4)} ns. CKD also divides the input filters' sampling clock.`);

  // ---- the waveform (two periods) ----
  const onT = dutyAct * T;
  const refOn = [];
  for (let k = 0; k < 2; k++) {
    const t0 = k * T;
    if (onT <= 0) continue;
    if (center) refOn.push([t0 + T / 2 - onT / 2, t0 + T / 2 + onT / 2]);
    else refOn.push([t0, t0 + onT]);
  }
  const merged = [];
  for (const iv of refOn) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last[1] - iv[0]) < 1e-15) last[1] = iv[1]; else merged.push([...iv]);
  }
  const refOff = [];
  let t = 0;
  for (const [a, b] of merged) { if (a > t) refOff.push([t, a]); t = b; }
  if (t < 2 * T) refOff.push([t, 2 * T]);
  // Rising edges delayed by DT; an edge at the window start is not a real edge.
  const delay = (list) => list.map(([a, b]) => [a > 1e-15 ? a + dt : a, b]).filter(([a, b]) => b - a > 1e-15);
  const hi = delay(merged), lo = comp ? delay(refOff) : [];
  const hiOn = Math.max(0, onT - (comp ? dt : 0));
  const loOn = comp ? Math.max(0, T - onT - dt) : 0;
  const lost = comp && dt > 0 && ((onT > 0 && onT <= dt) || (T - onT > 0 && T - onT <= dt));
  if (lost) warnings.push(`At ${fmtNum(dutyAct * 100, 4)} % duty one output's pulse is shorter than the dead time and is not generated at all; limit the duty to ${fmtNum(dt / T * 100, 3)}-${fmtNum(100 - dt / T * 100, 3)} %.`);
  if (comp && 2 * dt > 0.1 * T) warnings.push(`Dead time takes ${fmtNum(2 * dt / T * 100, 3)} % of every period: large distortion. Lower the dead time or the frequency.`);

  // ---- registers ----
  const cms = center ? 1 : 0;
  const cr1 = (ckd << 8) | (1 << 7) | (cms << 5); // CKD[9:8], ARPE, CMS[6:5]
  const bdtr = (1 << 15) | (dtg & 0xff); // MOE | DTG
  const hex = (v, w = 4) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

  // ---- nearby settings ----
  const alts = [];
  const seen = new Set();
  for (let p = pscMin; p <= Math.min(0xffff, pscMin + 400) && alts.length < 60; p++) {
    const a = arrFor(p);
    if (a > maxCnt || a < 2) continue;
    const fa = 1 / period(p, a);
    const e = (fa - f) / f * 100;
    const key = fa.toPrecision(9);
    if (seen.has(key)) continue;
    seen.add(key);
    alts.push({ psc: p, arr: a, f: fa, err: e, bits: Math.log2(center ? a : a + 1) });
  }
  alts.sort((x, y) => Math.abs(x.err) - Math.abs(y.err) || y.bits - x.bits);
  const list = alts.slice(0, 8);

  const mode = center ? 'TIM_COUNTERMODE_CENTERALIGNED1' : 'TIM_COUNTERMODE_UP';
  const ckdHal = ['TIM_CLOCKDIVISION_DIV1', 'TIM_CLOCKDIVISION_DIV2', 'TIM_CLOCKDIVISION_DIV4'][ckd];
  const hal = `/* ${fmtEng(fAct, 'Hz', 6)} ${center ? 'center' : 'edge'}-aligned, ${fmtNum(dutyAct * 100, 4)} % duty, dead time ${fmtNum(ns(dt), 5)} ns */
htim1.Instance = TIM1;
htim1.Init.Prescaler = ${psc};
htim1.Init.CounterMode = ${mode};
htim1.Init.Period = ${arr};
htim1.Init.ClockDivision = ${ckdHal};
htim1.Init.RepetitionCounter = 0;
htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
if (HAL_TIM_PWM_Init(&htim1) != HAL_OK) Error_Handler();

TIM_OC_InitTypeDef oc = {0};
oc.OCMode = TIM_OCMODE_PWM1;
oc.Pulse = ${ccr};
oc.OCPolarity = TIM_OCPOLARITY_HIGH;
oc.OCNPolarity = TIM_OCNPOLARITY_HIGH;
oc.OCFastMode = TIM_OCFAST_DISABLE;
oc.OCIdleState = TIM_OCIDLESTATE_RESET;
oc.OCNIdleState = TIM_OCNIDLESTATE_RESET;
if (HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_1) != HAL_OK) Error_Handler();
${comp ? `
TIM_BreakDeadTimeConfigTypeDef bd = {0};
bd.OffStateRunMode = TIM_OSSR_ENABLE;
bd.OffStateIDLEMode = TIM_OSSI_ENABLE;
bd.LockLevel = TIM_LOCKLEVEL_OFF;
bd.DeadTime = ${dtg};   /* DTG = ${hex(dtg, 2)} -> ${fmtNum(ns(dt), 5)} ns */
bd.BreakState = TIM_BREAK_DISABLE;
bd.BreakPolarity = TIM_BREAKPOLARITY_HIGH;
bd.AutomaticOutput = TIM_AUTOMATICOUTPUT_DISABLE;
if (HAL_TIMEx_ConfigBreakDeadTime(&htim1, &bd) != HAL_OK) Error_Handler();

HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);
HAL_TIMEx_PWMN_Start(&htim1, TIM_CHANNEL_1);` : `
HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);`}
`;
  const regs = `TIM1->PSC  = ${psc};
TIM1->ARR  = ${arr};
TIM1->CCR1 = ${ccr};
TIM1->CCMR1 = 0x0068;          /* OC1M = 110 (PWM mode 1), OC1PE */
TIM1->CCER  = ${comp ? '0x0005' : '0x0001'};          /* CC1E${comp ? ' | CC1NE' : ''} */
TIM1->BDTR  = ${hex(bdtr)};          /* MOE | DTG ${hex(dtg, 2)} */
TIM1->CR1   = ${hex(cr1 | 1)};          /* CKD /${CKD[ckd]}, ARPE, CMS ${center ? '01' : '00'}, CEN */
`;

  const tone = (b) => (b ? 'bad' : 'ok');
  return {
    values: [
      { label: 'PWM frequency', value: fmtEng(fAct, 'Hz', 6), hint: `${fmtNum(err, 3)} % from ${fmtEng(f, 'Hz')}`, tone: Math.abs(err) > 0.5 ? 'warn' : 'ok' },
      { label: 'PSC / ARR', value: `${psc} / ${arr}` },
      { label: 'CCR1', value: ccr, hint: `${fmtNum(dutyAct * 100, 5)} % duty` },
      { label: 'Resolution', value: `${fmtNum(resBits, 3)} bit`, hint: `${steps} steps`, tone: resBits < 8 ? 'warn' : 'ok' },
      { label: 'Dead time', value: comp ? `${fmtNum(ns(dt), 5)} ns` : 'off', hint: comp ? `DTG ${hex(dtg, 2)}, CKD /${CKD[ckd]}` : 'no complementary output', tone: comp && suggest != null ? tone(dt < suggest) : undefined },
      { label: 'BDTR', value: hex(bdtr), hint: 'MOE | DTG' },
      { label: 'High side on', value: `${fmtNum(hiOn / T * 100, 4)} %`, hint: fmtEng(hiOn, 's') },
      { label: 'Low side on', value: comp ? `${fmtNum(loOn / T * 100, 4)} %` : '-', hint: comp ? fmtEng(loOn, 's') : '' },
    ],
    tables: [{ title: 'Nearby settings', columns: ['PSC', 'ARR', 'Frequency', 'Error %', 'Bits'],
      rows: list.map((a) => [a.psc, a.arr, fmtEng(a.f, 'Hz', 6), Number(a.err.toFixed(4)), Number(a.bits.toFixed(2))]) }],
    texts: [{ title: 'HAL code', body: hal, lang: 'c' }, { title: 'Registers', body: regs, lang: 'c' }],
    warnings,
    notes: [...notes, `tDTS = ${fmtNum(ns(tdts), 4)} ns; DTG range ${range} (DTG[7:5] = ${['0xx', '10x', '110', '111'][range]}), step ${fmtNum(ns(stepDt), 4)} ns; the longest dead time at this CKD is ${fmtNum(ns(1008 * tdts), 4)} ns.`,
      'Formulas: RM0090 §17.3.10 (PWM), §17.3.13 and §17.4.18 (dead time, BDTR.DTG); identical on F1 (RM0008 §14), F7, G4 and H7 advanced timers.'],
    wave: {
      T, center, dt, dtReq: comp ? dtReq : 0, tdts, dtg, ckd, range, arr, ccr, steps, comp,
      hi, lo, ref: merged, suggest, psc, fck, bits, alts: list,
    },
  };
}
