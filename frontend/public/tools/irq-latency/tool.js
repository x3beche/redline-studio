// Interrupt load and worst-case response times.
//   C_i = handler time + (entry + exit + extra cycles) / f_cpu       (Arm TRM: 12-cycle entry on M3/M4, 16 on M0, 15 on M0+)
//   U   = Σ C_i · rate_i                                            (CPU share taken by interrupts)
//   R_i = B_i + C_i + Σ_{j preempts or ties i} ceil(R_i / T_j) · C_j   (Joseph & Pandya 1986, iterated to a fixed point)
//   B_i = max(interrupts-off section, longest lower-priority handler)   (a running handler cannot be preempted by i)
// Equal priorities are counted as interference (conservative: the NVIC serves ties by IRQ number).
import { parseEng, fmtNum, fmtEng } from '../kit/eng.js';

const CORES = { m0: 32, m0p: 30, m3: 22, m4f: 56 };

export function run({ fclk, core, entry, ws, mode, crit, irqs }) {
  const warnings = [];
  if (!(fclk > 0)) return { warnings: ['Give the CPU clock in Hz, e.g. 72M.'] };
  const ovCycles = (core === 'custom' ? (entry != null && entry >= 0 ? entry : 40) : CORES[core] ?? 22) + Math.max(0, ws || 0);
  const ov = ovCycles / fclk * 1e6;                   // µs
  const B0 = crit > 0 ? crit : 0;
  const list = [], skipped = [];
  (irqs || []).forEach((r, k) => {
    const rate = parseEng(r.rate), t = parseEng(r.time), p = parseEng(r.prio), d = parseEng(r.deadline);
    const name = String(r.name || `IRQ ${k + 1}`).trim();
    if (rate == null || t == null || !(rate > 0) || !(t >= 0)) { if (Object.values(r).some((v) => String(v ?? '').trim())) skipped.push(`${name} (needs rate > 0 and a handler time)`); return; }
    list.push({ name, prio: mode === 'flat' ? 0 : p ?? 0, rate, T: 1e6 / rate, h: t, C: t + ov, D: d > 0 ? d : 1e6 / rate, k });
  });
  if (skipped.length) warnings.push(`Rows skipped: ${skipped.join('; ')}.`);
  if (!list.length) return { warnings: [...warnings, 'Add interrupts: name, priority, rate in Hz (e.g. 10k) and handler time in µs.'] };
  const U = list.reduce((a, x) => a + x.C / x.T, 0);
  for (const x of list) {
    const hp = list.filter((y) => y !== x && y.prio <= x.prio);        // preempt, or tie (served first in the worst case)
    const lp = list.filter((y) => y.prio > x.prio);
    x.B = Math.max(B0, mode === 'flat' ? 0 : Math.max(0, ...lp.map((y) => y.C)));
    const Uhp = hp.reduce((a, y) => a + y.C / y.T, 0);
    let R = x.B + x.C, ok = true;
    if (Uhp >= 1) ok = false;
    else {
      for (let it = 0; it < 1000; it++) {
        const n = x.B + x.C + hp.reduce((a, y) => a + Math.ceil(R / y.T - 1e-12) * y.C, 0);
        if (Math.abs(n - R) < 1e-9) break;
        R = n;
        if (R > 1e3 * x.D + 1e6) { ok = false; break; }
      }
    }
    x.R = ok ? R : Infinity;
    x.start = ok ? R - x.h : Infinity;              // worst time from the event until its handler's first instruction
    x.slack = x.D - x.R;
    x.lost = x.start > x.T;                          // a second event arrives while the first is still pending
    x.miss = x.R > x.D;
    x.load = x.C / x.T;
  }
  const byPrio = [...list].sort((a, b) => a.prio - b.prio || a.k - b.k);
  const fmtUs = (v) => (Number.isFinite(v) ? fmtNum(v, 4) : 'unbounded');
  const rows = byPrio.map((x) => [x.name, x.prio, fmtEng(x.rate, 'Hz'), fmtNum(x.C, 4), `${fmtNum(x.load * 100, 3)} %`, fmtUs(x.start), fmtUs(x.R), fmtNum(x.D, 4),
    Number.isFinite(x.slack) ? fmtNum(x.slack, 4) : '–', x.lost ? 'loses events' : x.miss ? 'misses deadline' : x.slack < 0.2 * x.D ? 'tight' : 'ok']);
  const misses = list.filter((x) => x.miss), lost = list.filter((x) => x.lost);
  const worst = [...list].sort((a, b) => (a.slack / a.D) - (b.slack / b.D))[0];
  const values = [
    { label: 'Interrupt CPU load', value: fmtNum(U * 100, 3), unit: '%', tone: U >= 1 ? 'bad' : U > 0.5 ? 'warn' : 'ok' },
    { label: 'CPU left for the main loop / tasks', value: fmtNum(Math.max(0, 1 - U) * 100, 3), unit: '%' },
    { label: 'Overhead per interrupt', value: `${ovCycles} cycles`, hint: `${fmtNum(ov, 3)} µs entry + exit` },
    { label: 'Overhead share of the load', value: fmtNum((list.reduce((a, x) => a + ov / x.T, 0) / (U || 1)) * 100, 3), unit: '%' },
    { label: 'Deadline misses', value: misses.length, tone: misses.length ? 'bad' : 'ok' },
    { label: 'Can lose events', value: lost.length, tone: lost.length ? 'bad' : 'ok' },
    { label: 'Least slack', value: worst ? worst.name : '–', hint: worst && Number.isFinite(worst.slack) ? `${fmtNum(worst.slack, 4)} µs of ${fmtNum(worst.D, 4)} µs` : 'unbounded' },
  ];
  if (U >= 1) warnings.push(`Interrupts alone need ${fmtNum(U * 100, 3)} % of the CPU: the system is overloaded. Shorten handlers (move work to the main loop or DMA), lower rates, or raise the clock.`);
  else if (U > 0.7) warnings.push(`Interrupts take ${fmtNum(U * 100, 3)} % of the CPU: little is left for the main loop or tasks. Move work out of handlers or use DMA.`);
  for (const x of lost) warnings.push(`${x.name}: ${Number.isFinite(x.start) ? `it can wait ${fmtUs(x.start)} µs to start` : 'the interrupts above it leave it no CPU time'} but events come every ${fmtNum(x.T, 4)} µs, so a second event can arrive while the first is still pending and one is lost (a UART overrun, a missed edge). Raise its priority, shorten the handlers above it${B0 ? ' or the interrupts-off section' : ''}, or use DMA/a FIFO.`);
  for (const x of misses.filter((m) => !m.lost)) warnings.push(`${x.name}: worst-case response ${fmtUs(x.R)} µs exceeds its ${fmtNum(x.D, 4)} µs deadline. Raise its priority or shorten the handlers that can run first.`);
  const hRate = list.filter((x) => ov / x.C > 0.3 && x.rate > 5000);
  if (hRate.length) warnings.push(`${hRate.map((x) => x.name).join(', ')}: entry/exit overhead is over 30 % of the handler at a high rate; batch the work (FIFO threshold, DMA, half-transfer interrupt).`);
  const notes = ['Worst case, not average: it assumes every higher-or-equal interrupt fires at the worst moment, and one lower handler (or the interrupts-off section) is already running.',
    'Handler times should be measured worst cases (GPIO toggle on a scope, or the DWT cycle counter).',
    'Cortex-M tail-chaining (6 cycles instead of exit + entry) makes back-to-back interrupts slightly cheaper than modelled.'];
  if (core === 'm4f') notes.push('Cortex-M4F/M7: the 29/27 cycles include lazy FP stacking, paid only when the handler (or the interrupted code) uses the FPU.');
  if (mode === 'flat') notes.push('Flat mode: every interrupt waits for all others (they cannot preempt), so the response times are long but no handler is ever interrupted.');
  return {
    values, warnings, notes,
    tables: [{ title: 'Per interrupt, most urgent first (times in µs)', columns: ['Interrupt', 'Prio', 'Rate', 'C incl. overhead', 'Load', 'Worst start', 'Worst response', 'Deadline', 'Slack', 'Verdict'], rows }],
    charts: [{ title: 'Worst-case response against deadline (µs)', type: 'bars', x: byPrio.map((x) => x.name.length > 14 ? x.name.slice(0, 13) + '…' : x.name),
      series: [{ name: 'worst response', y: byPrio.map((x) => (Number.isFinite(x.R) ? Number(x.R.toFixed(3)) : null)) }, { name: 'deadline', y: byPrio.map((x) => Number(x.D.toFixed(3))) }] }],
  };
}
