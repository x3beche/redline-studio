// NVIC priority planner for Arm Cortex-M: orders the interrupts by priority,
// encodes the priority register values, and runs a worst-case response-time
// analysis to show which handlers miss their deadlines and why.
//
// Priority encoding (Armv7-M ARM B3.4.8 / Armv6-M ARM B3.4): a priority byte
// keeps only its top `bits` implemented bits. AIRCR.PRIGROUP = n splits the byte
// into group (preemption) priority = bits [7:n+1] and subpriority = bits [n:0],
// so with p preemption bits, PRIGROUP = 7 - p, and
//   IPR byte = ((pre << (bits - p)) | sub) << (8 - bits).
// Only the group priority preempts; the subpriority only orders pending
// interrupts of the same group (then the lower exception number wins).
// Armv6-M (M0/M0+) has no PRIGROUP: every implemented bit is preemption.
//
// Response time (fixed-priority preemptive scheduling, Joseph & Pandya 1986;
// Audsley et al. 1993):
//   R = C + B + sum over higher group j of ceil(R / T_j) * C_j   (iterate to a fixed point)
//   B = the longest same-group handler that may already be running (it cannot be preempted)
//     + one run of each same-group handler that wins on subpriority.
import { fmtNum } from '../kit/eng.js';

const fmtUs = (v) => (Number.isFinite(v) ? `${fmtNum(v, 3)} µs` : '–');
const num = (x) => { const v = Number(String(x ?? '').trim().replace(',', '.')); return String(x ?? '').trim() === '' || !Number.isFinite(v) ? null : v; };

export function run({ bits: bitsIn, pbits: pIn, rtos, irqs }) {
  const bits = Math.max(1, Math.min(8, Number(bitsIn) || 4));
  const v6m = bits === 2;
  let p = pIn === 'all' || pIn == null || pIn === '' || v6m ? bits : Math.max(0, Math.min(bits, Number(pIn) || 0));
  const warnings = [], notes = [];
  if (!v6m && Number(pIn) > bits) warnings.push(`${pIn} preemption bits is more than the ${bits} the chip implements; using ${bits}.`);
  const sb = bits - p;
  const maxPre = (1 << p) - 1, maxSub = (1 << sb) - 1;
  const list = [];
  (irqs || []).forEach((r, idx) => {
    const name = String(r.name ?? '').trim();
    if (!name) return;
    const pre = num(r.pre), sub = num(r.sub) ?? 0, C = num(r.time), T = num(r.period), Dd = num(r.deadline);
    const bad = [];
    if (pre == null || pre < 0 || !Number.isInteger(pre)) bad.push('priority');
    if (!(C > 0)) bad.push('handler time');
    if (!(T > 0)) bad.push('period');
    if (bad.length) { warnings.push(`${name}: give ${bad.join(', ')} as numbers (priority an integer, times in µs). Row skipped.`); return; }
    let pr = pre, su = sub;
    if (pre > maxPre) { warnings.push(`${name}: priority ${pre} does not fit ${p} preemption bits (0-${maxPre}); the hardware keeps only the low bits, so it acts as ${pre & maxPre}. Use 0-${maxPre}.`); pr = pre & maxPre; }
    if (sub > maxSub || sub < 0 || !Number.isInteger(sub)) { warnings.push(`${name}: subpriority ${sub} does not fit ${sb} subpriority bits (0-${maxSub}); treated as ${Math.max(0, Math.min(maxSub, Math.trunc(sub)))}.`); su = Math.max(0, Math.min(maxSub, Math.trunc(sub))); }
    list.push({ name, pre: pr, sub: su, C, T, D: Dd > 0 ? Dd : T, rtos: String(r.rtos).toLowerCase() === 'yes', idx });
  });
  if (!list.length) return { warnings: [...warnings, 'Add at least one interrupt: name, priority, handler time and period in µs.'] };
  // hardware order: group, then subpriority, then exception number (here: row order)
  list.sort((a, b) => a.pre - b.pre || a.sub - b.sub || a.idx - b.idx);

  const U = list.reduce((s, x) => s + x.C / x.T, 0);
  for (const x of list) {
    const same = list.filter((y) => y !== x && y.pre === x.pre);
    const wins = same.filter((y) => y.sub < x.sub || (y.sub === x.sub && y.idx < x.idx));
    const loses = same.filter((y) => !wins.includes(y));
    x.B = Math.max(0, ...loses.map((y) => y.C)) + wins.reduce((s, y) => s + y.C, 0);
    const hp = list.filter((y) => y.pre < x.pre);
    let R = x.C + x.B, ok = true;
    for (let k = 0; k < 500; k++) {
      const next = x.C + x.B + hp.reduce((s, y) => s + Math.ceil(R / y.T) * y.C, 0);
      if (next === R) break;
      R = next;
      if (R > 100 * x.D) { ok = false; break; }
    }
    x.R = ok ? R : Infinity;
    x.I = ok ? R - x.C - x.B : Infinity;
    x.ok = x.R <= x.D;
    x.ipr = ((x.pre << sb) | x.sub) << (8 - bits);
  }

  // conflicts
  const conflicts = [];
  const groups = new Map();
  for (const x of list) groups.set(x.pre, [...(groups.get(x.pre) || []), x]);
  for (const [pre, g] of groups) if (g.length > 1) conflicts.push([`group ${pre}`, g.map((x) => x.name).join(', '), 'cannot preempt each other; each waits for the one running']);
  for (const a of list) for (const b of list) {
    if (a.pre < b.pre && b.D < a.D) conflicts.push([`${b.name} under ${a.name}`, `deadline ${fmtUs(b.D)} < ${fmtUs(a.D)}`,
      b.ok ? 'deadline order would swap them; fine while it meets its deadline' : 'it misses its deadline: give the shorter deadline the higher priority']);
  }
  const rt = num(rtos);
  if (rt != null) {
    for (const x of list) if (x.rtos && x.pre < rt) {
      warnings.push(`${x.name} calls the RTOS API but has priority ${x.pre}, above configMAX_SYSCALL_INTERRUPT_PRIORITY ${rt}: FreeRTOS will assert or corrupt its lists. Set it to ${rt} or lower urgency (a number >= ${rt}).`);
      conflicts.push([x.name, `priority ${x.pre} < RTOS limit ${rt}`, 'uses the RTOS from an interrupt the kernel cannot mask']);
    }
    notes.push(`Interrupts with priority ${rt} or above (numerically) are masked while the RTOS is in a critical section; those below ${rt} (more urgent) are never delayed by the kernel but must not call it. In FreeRTOSConfig.h: configMAX_SYSCALL_INTERRUPT_PRIORITY = ${rt} << (8 - ${bits}) = 0x${((rt << (8 - bits)) & 0xff).toString(16).toUpperCase()}.`);
    if (rt > maxPre) warnings.push(`The RTOS limit ${rt} is outside 0-${maxPre}.`);
  }
  const miss = list.filter((x) => !x.ok);
  for (const x of miss) warnings.push(`${x.name} can miss its ${fmtUs(x.D)} deadline: worst-case response ${Number.isFinite(x.R) ? fmtUs(x.R) : 'unbounded'} (${fmtUs(x.B)} blocked by its own group, ${Number.isFinite(x.I) ? fmtUs(x.I) : 'unbounded'} preempted). Raise its priority, shorten the handlers above it, or move work out of them.`);
  if (U > 1) warnings.push(`Interrupt load is ${fmtNum(U * 100, 3)} % of the CPU: over 100 %, nothing else can run and some handler will overrun. Move work to tasks or lower the rates.`);
  else if (U > 0.7) warnings.push(`Interrupt load is ${fmtNum(U * 100, 3)} %: little CPU is left for the main loop or tasks.`);
  if (v6m) notes.push('Cortex-M0/M0+ (2 bits): there is no PRIGROUP and no subpriority; all 4 levels preempt.');
  notes.push('Handler times should include the exception entry and exit (12 + 10 cycles on M3/M4 without FPU stacking) and the flash wait states.',
    'Blocking assumes each same-group handler runs once while this one waits; an interrupt that fires faster than another\'s handler time needs its own group.');

  const hal = [`/* ${bits} priority bits, ${p} preemption + ${sb} sub: AIRCR.PRIGROUP = ${7 - p} */`];
  if (!v6m) hal.push(`HAL_NVIC_SetPriorityGrouping(${bits === 4 ? `NVIC_PRIORITYGROUP_${p}` : 7 - p});  /* or NVIC_SetPriorityGrouping(${7 - p}) */`);
  for (const x of list) hal.push(`HAL_NVIC_SetPriority(${x.name.replace(/[^A-Za-z0-9_]/g, '_')}_IRQn, ${x.pre}, ${x.sub});   /* IPR byte 0x${x.ipr.toString(16).toUpperCase().padStart(2, '0')} */`);

  return {
    values: [
      { label: 'Levels', value: `${1 << p} × ${1 << sb}`, hint: `preempt × sub, PRIGROUP ${7 - p}` },
      { label: 'Interrupt CPU load', value: `${fmtNum(U * 100, 3)} %`, tone: U > 1 ? 'bad' : U > 0.7 ? 'warn' : 'ok' },
      { label: 'Deadlines met', value: `${list.length - miss.length} of ${list.length}`, tone: miss.length ? 'bad' : 'ok' },
      { label: 'Conflicts', value: conflicts.length, tone: conflicts.length ? 'warn' : 'ok' },
    ],
    tables: [
      { title: 'Priority order (most urgent first)', columns: ['Interrupt', 'Group', 'Sub', 'IPR byte', 'Handler', 'Period', 'Blocking', 'Preempted', 'Response', 'Deadline', 'OK'],
        rows: list.map((x) => [x.name, x.pre, x.sub, `0x${x.ipr.toString(16).toUpperCase().padStart(2, '0')}`, fmtUs(x.C), fmtUs(x.T), fmtUs(x.B), fmtUs(x.I), Number.isFinite(x.R) ? fmtUs(x.R) : 'unbounded', fmtUs(x.D), x.ok ? 'yes' : 'NO']) },
      ...(conflicts.length ? [{ title: 'Preemption conflicts', columns: ['Where', 'What', 'Why it matters'], rows: conflicts }] : []),
    ],
    texts: [{ title: 'HAL', lang: 'c', body: hal.join('\n') + '\n' }],
    irqs: list.map((x) => ({ name: x.name, pre: x.pre, sub: x.sub, C: x.C, B: x.B, I: Number.isFinite(x.I) ? x.I : null, R: Number.isFinite(x.R) ? x.R : null, D: x.D, ok: x.ok, rtos: x.rtos,
      // for the page: the table row it came from, its period, IPR byte, and what is wrong with it
      idx: x.idx, T: x.T, ipr: x.ipr, rtosBad: rt != null && x.rtos && x.pre < rt,
      shared: (groups.get(x.pre) || []).length > 1,
      inverted: list.filter((a) => a.pre < x.pre && x.D < a.D).map((a) => a.name) })),
    rtosLimit: rt,
    nvic: { bits, p, sb, prigroup: 7 - p, maxPre, maxSub, v6m, load: U, missed: miss.length, conflicts: conflicts.length,
      rtosByte: rt != null ? (rt << (8 - bits)) & 0xff : null },
    warnings, notes,
  };
}
