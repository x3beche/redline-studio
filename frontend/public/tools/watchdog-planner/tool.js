// Watchdog timeout planning.
//   worst gap  G = normal feed interval + longest task (WCET) + interrupt load
//   minimum timeout  Tmin = margin × G, required at the FASTEST watchdog clock
//   (a fast clock shortens the real timeout), while the timeout at the SLOWEST
//   clock is the real worst-case time to reset a hung system.
// Counter models:
//   STM32 IWDG  t = 4·2^PR · (RLR+1) / f_LSI, PR 0..6, RLR 0..4095 (ST RM0090 §21.3)
//   AVR WDT     t = 2048·2^WDP / 128 kHz, WDP 0..9 = 16 ms … 8 s (ATmega328P §10.9.2)
//   nRF52 WDT   t = (CRV+1) / 32768 Hz, CRV ≥ 15 (nRF52840 PS, WDT)
//   custom      t = 2^k · (reload+1) / f, reload < 2^bits
// Feed-only-when-all-tasks-checked-in follows Ganssle's watchdog guidance.
import { fmtEng, fmtNum } from '../kit/eng.js';

const TARGETS = {
  'stm32-iwdg': { name: 'STM32 IWDG', f: 32000 },
  avr: { name: 'AVR WDT', f: 128000 },
  nrf52: { name: 'nRF52 WDT', f: 32768 },
  custom: { name: 'Custom counter', f: null },
};

const ms = (t) => fmtEng(t / 1000, 's'); // t in ms -> "12.3 ms"

// Smallest configuration whose count reaches `need` counts.
function configure(target, need, f, bits, maxDivExp) {
  if (target === 'stm32-iwdg') {
    for (let pr = 0; pr <= 6; pr++) {
      const div = 4 * 2 ** pr;
      const rlr = Math.max(0, Math.ceil(need / div) - 1);
      if (rlr <= 4095) return { count: div * (rlr + 1), pre: `PR ${pr} (÷${div})`, rel: `RLR ${rlr}`, regs: `IWDG_PR = ${pr} (÷${div}), IWDG_RLR = ${rlr} (0x${rlr.toString(16).toUpperCase()})`, max: false };
    }
    return { count: 256 * 4096, pre: 'PR 6 (÷256)', rel: 'RLR 4095', regs: 'IWDG_PR = 6 (÷256), IWDG_RLR = 4095 (0xFFF)', max: true };
  }
  if (target === 'avr') {
    const names = ['WDTO_15MS', 'WDTO_30MS', 'WDTO_60MS', 'WDTO_120MS', 'WDTO_250MS', 'WDTO_500MS', 'WDTO_1S', 'WDTO_2S', 'WDTO_4S', 'WDTO_8S'];
    for (let k = 0; k <= 9; k++) {
      const count = 2048 * 2 ** k;
      if (count >= need) return { count, pre: `WDP ${k}`, rel: names[k], regs: `WDP = ${k} (${2048 * 2 ** k / 1024}K cycles, avr-libc ${names[k]})`, max: false };
    }
    return { count: 2048 * 512, pre: 'WDP 9', rel: 'WDTO_8S', regs: 'WDP = 9 (1024K cycles, WDTO_8S)', max: true };
  }
  if (target === 'nrf52') {
    const crv = Math.max(15, Math.ceil(need) - 1);
    if (crv <= 0xFFFFFFFF) return { count: crv + 1, pre: 'none', rel: `CRV ${crv}`, regs: `NRF_WDT->CRV = ${crv} (0x${crv.toString(16).toUpperCase()})`, max: false };
    return { count: 2 ** 32, pre: 'none', rel: 'CRV max', regs: 'NRF_WDT->CRV = 0xFFFFFFFF', max: true };
  }
  const top = 2 ** bits;
  for (let k = 0; k <= maxDivExp; k++) {
    const div = 2 ** k;
    const rel = Math.max(0, Math.ceil(need / div) - 1);
    if (rel < top) return { count: div * (rel + 1), pre: `÷${div}`, rel: `${rel}`, regs: `prescaler ÷${div} (2^${k}), reload = ${rel} (0x${rel.toString(16).toUpperCase()})`, max: false };
  }
  const div = 2 ** maxDivExp;
  return { count: div * top, pre: `÷${div}`, rel: `${top - 1}`, regs: `prescaler ÷${div}, reload = ${top - 1} (maximum)`, max: true };
}

export function run(input) {
  const { target, feedInterval, wcet, isr, longOp, margin, tol, maxRecovery, windowed, windowPct, minGap } = input;
  const t = TARGETS[target] || TARGETS['stm32-iwdg'];
  const warnings = [], notes = [];
  if (!(feedInterval > 0)) return { warnings: ['Give the normal feed interval in ms, e.g. 10.'] };
  if (!(wcet >= 0)) return { warnings: ['Give the longest task time in ms (0 if every task is short).'] };
  const irq = isr > 0 ? isr : 0, lop = longOp > 0 ? longOp : 0;
  let m = margin;
  if (!(m >= 1)) { warnings.push('The safety margin must be at least 1 (timeout ≥ worst gap); 2 is used.'); m = 2; }
  let tl = Number.isFinite(tol) ? Math.abs(tol) : 10;
  if (tl >= 90) { warnings.push('A clock tolerance of 90 % or more makes no sense; 50 % is used.'); tl = 50; }
  const f = target === 'custom' ? input.clock : t.f;
  if (!(f > 0)) return { warnings: ['Give the custom counter clock in Hz, e.g. 32k.'] };
  const bits = Math.round(input.bits) || 16, maxDivExp = Math.max(0, Math.round(input.maxDivExp ?? 8));
  if (target === 'custom' && (bits < 4 || bits > 32)) return { warnings: ['Give a counter width between 4 and 32 bits.'] };

  const fFast = f * (1 + tl / 100), fSlow = f * (1 - tl / 100);
  const gap = feedInterval + wcet + irq;          // ms
  const tMin = m * gap;                            // ms, needed at the fast clock
  const need = (tMin / 1000) * fFast;              // counts
  const cfg = configure(target, need, f, bits, maxDivExp);
  const tNom = (cfg.count / f) * 1000, tFast = (cfg.count / fFast) * 1000, tSlow = (cfg.count / fSlow) * 1000;
  const allowedGap = tFast / m;                    // the longest gap the timeout still covers with margin

  if (cfg.max) warnings.push(`${t.name} cannot reach ${ms(tMin)} even at its largest setting (${ms(tFast)} at the fast clock). Feed more often, shorten the longest task or lower the margin.`);
  if (maxRecovery > 0 && tSlow > maxRecovery) warnings.push(`At the slowest clock the timeout is ${ms(tSlow)}, over the ${ms(maxRecovery)} allowed hang. Split the longest task (it sets the gap) or calibrate the watchdog clock to cut the tolerance.`);
  if (target === 'stm32-iwdg' && tl < 30) notes.push('STM32 LSI tolerance: most STM32F4/F1 parts specify 17–47 kHz (≈ −47/+47 %). Unless you measure LSI against HSE (TIM input capture), size with a wider tolerance.');

  // Long blocking operation: feed inside it in chunks, or it sets the timeout.
  const feedRows = [
    ['Main loop, once per pass', `≤ ${ms(feedInterval + wcet + irq)} apart`, 'Feed only after every task has checked in (set its alive flag) this pass; clear the flags on feed.'],
  ];
  let chunk = null, extraFeeds = 0;
  if (lop > 0) {
    if (lop + irq > allowedGap) {
      chunk = Math.max(0, allowedGap - irq);
      extraFeeds = chunk > 0 ? Math.ceil(lop / chunk) - 1 : Infinity;
      if (!Number.isFinite(extraFeeds)) warnings.push('The interrupt load alone uses the whole timeout: raise the timeout or cut the interrupt load.');
      else feedRows.push(['Inside the long operation', `every ≤ ${ms(chunk)} of work (${extraFeeds} extra feeds)`, 'Split it (erase page by page, poll the modem in steps) and feed between steps; keep the feed conditional on progress so a stuck step still resets.']);
      const tNeeded = m * (lop + irq);
      notes.push(`Not feeding during the ${ms(lop)} operation would need a timeout of ${ms(tNeeded)} at the fast clock, i.e. up to ${ms(tNeeded * fFast / fSlow)} before a hang is caught.`);
    } else {
      feedRows.push(['Around the long operation', 'before it starts', `It fits inside the timeout (${ms(lop + irq)} < ${ms(allowedGap)}); feed just before starting it.`]);
    }
  }
  feedRows.push(['Startup', 'before long init', 'Enable the watchdog early; feed between slow init steps (clock start, SD card mount, radio calibration).']);
  feedRows.push(['Never', 'in a timer ISR', 'A timer interrupt keeps firing while the main loop is stuck, so feeding there defeats the watchdog.']);

  const values = [
    { label: 'Worst feed gap', value: ms(gap), hint: 'interval + WCET + interrupts' },
    { label: 'Minimum timeout', value: ms(tMin), hint: `${fmtNum(m, 3)} × gap, at the fast clock` },
    { label: 'Prescaler', value: cfg.pre, tone: cfg.max ? 'bad' : 'ok' },
    { label: 'Reload / count', value: cfg.rel, tone: cfg.max ? 'bad' : 'ok' },
    { label: 'Timeout, nominal clock', value: ms(tNom), hint: `${fmtEng(f, 'Hz')}` },
    { label: 'Timeout, fast clock', value: ms(tFast), tone: tFast >= tMin ? 'ok' : 'bad', hint: `+${fmtNum(tl, 3)} %: shortest real timeout` },
    { label: 'Timeout, slow clock', value: ms(tSlow), tone: maxRecovery > 0 && tSlow > maxRecovery ? 'bad' : 'ok', hint: `−${fmtNum(tl, 3)} %: longest hang before reset` },
    { label: 'Longest safe gap', value: ms(allowedGap), hint: 'fast-clock timeout ÷ margin' },
  ];
  if (lop > 0) values.push({ label: 'Extra feeds in long op', value: Number.isFinite(extraFeeds) ? extraFeeds : '–', hint: chunk ? `chunks ≤ ${ms(chunk)}` : 'fits without' });

  if (windowed) {
    const pct = windowPct > 0 && windowPct < 100 ? windowPct : 50;
    const open = (pct / 100) * tSlow;             // the window opens latest at the slow clock
    const g = minGap > 0 ? minGap : feedInterval;
    values.push({ label: 'Window opens (slow clock)', value: ms(open), tone: g >= open ? 'ok' : 'bad', hint: `${fmtNum(pct, 3)} % of the slow-clock timeout` });
    if (g < open) warnings.push(`A feed can come after ${ms(g)}, before the window opens at ${ms(open)} (slow clock): that resets the part. Lower the window percentage or feed from a fixed-period point.`);
    notes.push('Window check: the shortest feed gap must be after the window opens at the slowest clock, and the worst gap before the timeout at the fastest clock.');
  }

  // The same numbers, structured, for the drawing (times in ms, clocks in Hz).
  const plan = { target, targetName: t.name, f, fFast, fSlow, tol: tl, margin: m, feedInterval, wcet, isr: irq, longOp: lop,
    gap, tMin, tNom, tFast, tSlow, allowedGap, maxRecovery: maxRecovery > 0 ? maxRecovery : null,
    chunk, extraFeeds: Number.isFinite(extraFeeds) ? extraFeeds : null,
    count: cfg.count, prescaler: cfg.pre, reload: cfg.rel, registers: cfg.regs, atMax: cfg.max, window: null };
  if (windowed) {
    const pct = windowPct > 0 && windowPct < 100 ? windowPct : 50;
    plan.window = { pct, open: (pct / 100) * tSlow, minGap: minGap > 0 ? minGap : feedInterval };
  }
  notes.push('Worst gap is taken as the sum of the normal interval, the longest task and the interrupt load: a pass feeds, then the next pass runs the slowest task on top.');
  return {
    values,
    warnings,
    tables: [
      { title: 'Register setting', columns: ['Watchdog', 'Setting'], rows: [[t.name, cfg.regs]] },
      { title: 'Feed points', columns: ['Where', 'How often', 'Why'], rows: feedRows },
      { title: 'Timeout at the three clocks', columns: ['Clock', 'Frequency', 'Timeout', 'Covers gap × margin?'],
        rows: [['fast', fmtEng(fFast, 'Hz'), ms(tFast), tFast >= tMin ? 'yes' : 'no'], ['nominal', fmtEng(f, 'Hz'), ms(tNom), tNom >= tMin ? 'yes' : 'no'], ['slow', fmtEng(fSlow, 'Hz'), ms(tSlow), tSlow >= tMin ? 'yes' : 'no']] },
    ],
    notes,
    plan,
  };
}
