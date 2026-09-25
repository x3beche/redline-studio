// Periodic task timing by simulation over one hyperperiod (LCM of the periods).
//   U = Σ C_i / T_i                                   (processor utilisation)
//   RM bound: U ≤ n(2^(1/n) − 1) is sufficient        (Liu & Layland 1973)
//   Fixed-priority behaviour is periodic with the hyperperiod, so simulating
//   one hyperperiod from the given offsets shows every conflict (Leung & Whitehead 1982).
// Times are handled as whole microseconds.
import { parseEng, fmtNum } from '../kit/eng.js';

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a / gcd(a, b)) * b;
const MAX_JOBS = 40000;

function simulate(tasks, preempt, horizon) {
  const rel = [];
  for (const t of tasks) for (let r = t.off; r < horizon; r += t.T) rel.push({ t, r, rem: t.C, start: null, fin: null });
  rel.sort((a, b) => a.r - b.r || a.t.prio - b.t.prio);
  const segs = [];
  const better = (a, b) => a.t.prio - b.t.prio || a.r - b.r || a.t.idx - b.t.idx;
  let t = 0, i = 0, run = null, guard = 0;
  const ready = [];
  while (guard++ < 400000) {
    while (i < rel.length && rel[i].r <= t) ready.push(rel[i++]);
    if (!run || preempt) {
      if (run) ready.push(run);
      ready.sort(better);
      run = ready.shift() || null;
    }
    if (!run) { if (i >= rel.length) break; t = rel[i].r; continue; }
    if (run.start == null) run.start = t;
    let end = t + run.rem;
    if (preempt && i < rel.length && rel[i].r < end) end = rel[i].r;
    const last = segs.at(-1);
    if (last && last.job === run && last.e === t) last.e = end; else segs.push({ job: run, s: t, e: end });
    run.rem -= end - t; t = end;
    if (run.rem <= 0) { run.fin = t; run = null; }
  }
  return { jobs: rel, segs };
}

function stats(tasks, sim) {
  const per = tasks.map((t) => ({ t, jobs: 0, maxDelay: 0, maxResp: 0, miss: 0, firstMiss: null }));
  const blame = new Map();           // "victim|culprit" -> {time, count}
  // segments are in time order; for each job find what ran between its release and its finish
  const segs = sim.segs;
  let lo = 0;
  const byRel = [...sim.jobs].sort((a, b) => a.r - b.r);
  for (const j of byRel) {
    const p = per[j.t.idx];
    p.jobs++;
    const fin = j.fin ?? Infinity;
    const delay = (j.start ?? Infinity) - j.r, resp = fin - j.r;
    p.maxDelay = Math.max(p.maxDelay, delay); p.maxResp = Math.max(p.maxResp, resp);
    if (resp > j.t.D) { p.miss++; if (p.firstMiss == null) p.firstMiss = j.r; }
    while (lo < segs.length && segs[lo].e <= j.r) lo++;
    for (let k = lo; k < segs.length && segs[k].s < fin; k++) {
      const s = segs[k];
      if (s.job.t === j.t) continue;
      const ov = Math.min(s.e, fin) - Math.max(s.s, j.r);
      if (ov <= 0) continue;
      const key = `${j.t.idx}|${s.job.t.idx}`;
      const b = blame.get(key) || { time: 0, count: 0, max: 0, lastJob: null };
      b.time += ov;
      if (b.lastJob !== j) { b.count++; b.lastJob = j; }
      blame.set(key, b);
    }
  }
  return { per, blame };
}

// Greedy offsets: tasks in priority order, each at the offset (on a grid) that overlaps least
// with the tasks already placed, assuming they run right at release.
function suggestOffsets(tasks, H) {
  const placed = [];                 // [s, e) intervals over H
  const out = new Map();
  const order = [...tasks].sort((a, b) => a.prio - b.prio || a.idx - b.idx);
  for (const t of order) {
    const n = Math.min(200, Math.max(1, Math.floor(t.T / Math.max(1, Math.min(...tasks.map((x) => x.C)) / 2))));
    const step = Math.max(1, Math.floor(t.T / n));
    let best = { o: 0, cost: Infinity };
    for (let o = 0; o < t.T && o <= t.T - 1; o += step) {
      let cost = 0;
      for (let r = o; r < H && cost < best.cost; r += t.T) {
        const s = r, e = r + t.C;
        for (const [ps, pe] of placed) if (ps < e && pe > s) cost += Math.min(e, pe) - Math.max(s, ps);
        if (e > H) for (const [ps, pe] of placed) if (ps < e - H) cost += Math.min(e - H, pe) - Math.max(0, ps);
      }
      if (cost < best.cost - 1e-9) best = { o, cost };
      if (cost === 0) break;
    }
    out.set(t.idx, best.o);
    for (let r = best.o; r < H; r += t.T) placed.push([r, r + t.C]);
    if (placed.length > 20000) break;
  }
  return out;
}

const ms = (us) => (Number.isFinite(us) ? fmtNum(us / 1000, 4) : '∞');

export function run({ mode, tasks, window }) {
  const warnings = [], notes = [];
  const preempt = mode === 'preempt';
  const list = [], skipped = [];
  (tasks || []).forEach((r, k) => {
    const T = parseEng(r.period), C = parseEng(r.dur), off = parseEng(r.offset) ?? 0, p = parseEng(r.prio), d = parseEng(r.deadline);
    const name = String(r.name || `Task ${k + 1}`).trim();
    if (T == null || C == null || !(T > 0) || !(C >= 0)) { if (Object.values(r).some((v) => String(v ?? '').trim())) skipped.push(name); return; }
    list.push({ row: k, name, T: Math.max(1, Math.round(T * 1000)), C: Math.round(C * 1000), off: Math.max(0, Math.round(off * 1000)), prioIn: p, D: d > 0 ? Math.round(d * 1000) : Math.max(1, Math.round(T * 1000)) });
  });
  if (skipped.length) warnings.push(`Rows skipped (need a period > 0 and a duration): ${skipped.join(', ')}.`);
  if (!list.length) return { warnings: [...warnings, 'Add tasks with a period and a duration in ms.'] };
  // rate monotonic when no priority is given: order by period, then by row
  const rm = [...list].map((t, i) => ({ t, i })).sort((a, b) => a.t.T - b.t.T || a.i - b.i);
  rm.forEach(({ t }, r) => { t.rmRank = r; });
  list.forEach((t, i) => { t.idx = i; t.prio = t.prioIn != null ? t.prioIn : 1000 + t.rmRank; });
  const explicit = list.some((t) => t.prioIn != null) && list.some((t) => t.prioIn == null);
  if (explicit) notes.push('Tasks without a priority come after every task with one, in period order.');
  const U = list.reduce((a, t) => a + t.C / t.T, 0);
  let H = list.reduce((a, t) => lcm(a, t.T), 1);
  const maxOff = Math.max(...list.map((t) => t.off));
  let horizon = H + maxOff;
  const jobsIn = (h) => list.reduce((a, t) => a + Math.ceil(h / t.T), 0);
  let full = true;
  if (!Number.isFinite(H) || H > 6e8 || jobsIn(horizon) > MAX_JOBS) {
    full = false;
    horizon = Math.max(...list.map((t) => t.T)) * 4 + maxOff;
    while (jobsIn(horizon) > MAX_JOBS && horizon > 1) horizon = Math.floor(horizon / 2);
    notes.push(`The hyperperiod is too long to simulate here: ${ms(horizon)} ms were simulated. Periods that are multiples of each other (1, 5, 10, 50 ms) keep it short.`);
  }
  const sim = simulate(list, preempt, horizon);
  const { per, blame } = stats(list, sim);
  const n = list.length, bound = n * (2 ** (1 / n) - 1);
  const misses = per.filter((p) => p.miss);
  const values = [
    { label: 'CPU utilisation', value: fmtNum(U * 100, 3), unit: '%', tone: U > 1 ? 'bad' : U > (preempt ? bound : 0.8) ? 'warn' : 'ok' },
    { label: 'Hyperperiod', value: full ? `${ms(H)} ms` : `> ${ms(horizon)} ms`, hint: 'the pattern repeats after this' },
    { label: 'Tasks missing deadlines', value: misses.length, tone: misses.length ? 'bad' : 'ok' },
    { label: 'Worst start delay', value: `${ms(Math.max(...per.map((p) => p.maxDelay)))} ms`, hint: per.reduce((a, p) => (p.maxDelay > a.maxDelay ? p : a)).t.name },
  ];
  if (preempt) values.push({ label: 'Rate-monotonic bound', value: fmtNum(bound * 100, 3), unit: '%', hint: U <= bound ? 'under it: schedulable' : 'over it: check the simulation' });
  if (U > 1) warnings.push(`The tasks need ${fmtNum(U * 100, 3)} % of the CPU: no scheduler can run them. Shorten durations or lengthen periods.`);
  const urgent = [...list].sort((a, b) => a.D - b.D || a.C - b.C)[0];
  for (const p of misses) {
    const worstBy = [...blame.entries()].filter(([k]) => k.startsWith(`${p.t.idx}|`)).sort((a, b) => b[1].time - a[1].time)[0];
    const culprit = worstBy ? list[Number(worstBy[0].split('|')[1])].name : null;
    warnings.push(`${p.t.name} misses ${p.miss} of ${p.jobs} deadlines (worst response ${ms(p.maxResp)} ms, deadline ${ms(p.t.D)} ms)${culprit ? `, mostly held up by ${culprit}` : ''}. ` +
      (preempt ? 'Raise its priority or shorten the tasks above it.' : `In a cooperative scheduler a long task blocks everyone: split ${culprit || 'the long task'} into steps shorter than ${ms(urgent.D - urgent.C)} ms (the most urgent task's deadline minus its own duration), or move ${p.t.name} into a timer interrupt.`));
  }
  const rows = list.map((t) => {
    const p = per[t.idx];
    return [t.name, ms(t.T), ms(t.C), ms(t.off), t.prioIn != null ? t.prioIn : `${t.rmRank} (RM)`, `${fmtNum(t.C / t.T * 100, 3)} %`, ms(p.maxDelay), ms(p.maxResp), ms(t.D), p.miss ? `${p.miss}/${p.jobs} missed` : 'ok'];
  });
  const brows = [...blame.entries()].sort((a, b) => b[1].time - a[1].time).slice(0, 10)
    .map(([k, b]) => { const [v, c] = k.split('|').map(Number); return [list[v].name, list[c].name, b.count, `${ms(b.time / Math.max(1, b.count))} ms`]; });
  const tables = [
    { title: `Tasks (${preempt ? 'preemptive' : 'cooperative'}, times in ms)`, columns: ['Task', 'Period', 'Duration', 'Offset', 'Priority', 'Load', 'Worst start delay', 'Worst response', 'Deadline', 'Deadlines'], rows },
  ];
  if (brows.length) tables.push({ title: 'Who delays whom most (per hyperperiod, top 10)', columns: ['Delayed task', 'Delayed by', 'Times', 'Average delay'], rows: brows });
  // offset suggestion
  let suggestion = null;
  if (full && jobsIn(H) <= 5000 && list.length > 1) {
    const off = suggestOffsets(list, H);
    const moved = list.map((t) => ({ ...t, off: off.get(t.idx) ?? t.off }));
    moved.forEach((t, i) => { t.idx = i; });
    const s2 = stats(moved, simulate(moved, preempt, H + Math.max(...moved.map((t) => t.off))));
    const w1 = Math.max(...per.map((p) => p.maxDelay)), w2 = Math.max(...s2.per.map((p) => p.maxDelay));
    const m2 = s2.per.reduce((a, p) => a + p.miss, 0), m1 = per.reduce((a, p) => a + p.miss, 0);
    if (m2 < m1 || (m2 === m1 && w2 < w1)) {
      suggestion = { offsets: moved.map((t) => ({ name: t.name, offset: t.off / 1000 })), worstDelay: w2 / 1000, misses: m2 };
      tables.push({ title: 'Suggested offsets (spread the releases apart)', columns: ['Task', 'Offset now', 'Suggested offset', 'Worst start delay then', 'Deadlines then'],
        rows: moved.map((t, i) => [t.name, ms(list[i].off), ms(t.off), ms(s2.per[i].maxDelay), s2.per[i].miss ? `${s2.per[i].miss} missed` : 'ok']) });
      values.push({ label: 'With suggested offsets', value: `${ms(w2)} ms`, hint: `worst start delay, ${m2} misses`, tone: m2 ? 'warn' : 'ok' });
    }
  }
  // timeline for the drawing (and for agents): segments per task inside the window
  const maxT = Math.max(...list.map((t) => t.T));
  let win = window > 0 ? Math.round(window * 1000) : Math.min(full ? H : horizon, 2 * maxT);
  if (win > horizon) win = horizon;
  const lanes = list.map((t) => ({ name: t.name, segs: [], releases: [], misses: [] }));
  let segCount = 0;
  for (const s of sim.segs) {
    if (s.s >= win) break;
    if (segCount++ > 3000) break;
    lanes[s.job.t.idx].segs.push([s.s / 1000, Math.min(s.e, win) / 1000]);
  }
  for (const j of sim.jobs) {
    if (j.r >= win) continue;
    lanes[j.t.idx].releases.push(j.r / 1000);
    if ((j.fin ?? Infinity) - j.r > j.t.D && j.r + j.t.D <= win) lanes[j.t.idx].misses.push((j.r + j.t.D) / 1000);
  }
  notes.push('Durations are worst cases: every job is assumed to take its full duration. Scheduler overhead and interrupts are not included; add them to the durations.',
    preempt ? 'Preemptive: the highest-priority ready task always runs; ties go to the earlier release.' : 'Cooperative: when the CPU is free the most urgent ready task starts and runs to its end, so a long task delays all others.');
  // The same numbers, structured, for the drawing (times in ms; row = index in the input table).
  const byPrio = [...list].sort((a, b) => a.prio - b.prio || a.idx - b.idx);
  const taskData = list.map((t) => {
    const p = per[t.idx];
    return { row: t.row, name: t.name, period: t.T / 1000, dur: t.C / 1000, offset: t.off / 1000, deadline: t.D / 1000,
      prio: t.prioIn != null ? t.prioIn : null, rank: t.rmRank, order: byPrio.indexOf(t), load: t.C / t.T,
      maxDelay: Number.isFinite(p.maxDelay) ? p.maxDelay / 1000 : null, maxResp: Number.isFinite(p.maxResp) ? p.maxResp / 1000 : null,
      jobs: p.jobs, missed: p.miss };
  });
  const blameData = [...blame.entries()].sort((a, b) => b[1].time - a[1].time).slice(0, 10)
    .map(([k, b]) => { const [v, c] = k.split('|').map(Number); return { victim: v, culprit: c, times: b.count, total: b.time / 1000, avg: b.time / Math.max(1, b.count) / 1000 }; });
  return { values, warnings, notes, tables, timeline: { window: win / 1000, unit: 'ms', lanes }, suggestion,
    schedule: { mode: preempt ? 'preempt' : 'coop', utilisation: U, bound, hyperperiod: full ? H / 1000 : null, simulated: horizon / 1000, full, tasks: taskData, blame: blameData } };
}
