// Average current of a duty-cycled device, by charge balance over one wake-up period T:
//   each active state k draws I_k for t_k, once every N_k wake-ups -> mean time per period t_k / N_k
//   sleep time per period  = T - Σ t_k / N_k
//   I_avg = (Σ I_k t_k / N_k + I_sleep · t_sleep) / T
//   charge per day = I_avg · 86400 s  (÷ 3.6 -> mAh when I is in mA)
import { parseEng, fmtEng, fmtNum } from '../kit/eng.js';

export function run({ period, isleep, states, vbat }) {
  const warnings = [];
  if (!(period > 0)) return { warnings: ['Give the wake-up period in seconds, e.g. 10.'] };
  if (!(isleep >= 0)) return { warnings: ['Give the sleep current in A, e.g. 2u for 2 µA.'] };
  const rows = [], bad = [];
  (Array.isArray(states) ? states : []).forEach((r, idx) => {
    const name = String(r?.name ?? '').trim() || `State ${idx + 1}`;
    const is = String(r?.i ?? '').trim(), ts = String(r?.t ?? '').trim(), es = String(r?.every ?? '').trim();
    if (!is && !ts) return;
    const i = parseEng(is), t = parseEng(ts), n = es ? parseEng(es) : 1;
    if (i == null || t == null || n == null || i < 0 || t < 0 || !(n >= 1)) { bad.push(`${name} (${is || '–'} A, ${ts || '–'} s, every ${es || '1'})`); return; }
    rows.push({ name, i, t, n, idx });
  });
  if (bad.length) warnings.push(`Skipped, not readable: ${bad.join('; ')}. Current in A (5m), time in s (2m), every = a whole number ≥ 1.`);
  const tAct = rows.reduce((a, r) => a + r.t / r.n, 0);
  const tWorst = rows.reduce((a, r) => a + r.t, 0);
  if (tWorst > period) warnings.push(`On a wake-up where every state runs, the states take ${fmtEng(tWorst, 's')}, longer than the ${fmtEng(period, 's')} period: lengthen the period or shorten the states.`);
  if (tAct > period) return { warnings: [...warnings, `The active states take ${fmtEng(tAct, 's')} per period on average, more than the ${fmtEng(period, 's')} period itself: there is no time left to sleep. Lengthen the period, shorten the states or run some of them less often.`] };
  const tSleep = Math.max(0, period - tAct);
  const qSleep = isleep * tSleep;
  const parts = rows.map((r) => ({ ...r, q: (r.i * r.t) / r.n }));
  const qTotal = parts.reduce((a, p) => a + p.q, qSleep);
  const iavg = qTotal / period;
  const perDay = iavg * 86400 / 3.6; // A·s -> mAh: 1 mAh = 3.6 A·s
  const duty = tAct / period;
  const v = vbat > 0 ? vbat : null;
  if (!v) warnings.push('Give the supply voltage to see power and energy.');
  if (isleep > 1e-3) warnings.push(`A sleep current of ${fmtEng(isleep, 'A')} is high for a sleeping MCU board: check regulator quiescent current, pull-ups and sensors left powered.`);
  const top = [...parts, { name: 'Sleep', q: qSleep }].sort((a, b) => b.q - a.q)[0];
  const share = (q) => (qTotal > 0 ? (100 * q) / qTotal : 0);

  const values = [
    { label: 'Average current', value: fmtEng(iavg, 'A'), tone: 'ok' },
    { label: 'Duty cycle (awake)', value: fmtNum(duty * 100, 3), unit: '%', hint: `${fmtEng(tAct, 's')} of ${fmtEng(period, 's')} on average` },
    { label: 'Charge per period', value: fmtEng(qTotal, 'C'), hint: `${fmtNum(qTotal / 3.6e-3 * 1e3, 4)} µAh` },
    { label: 'Charge per day', value: fmtNum(perDay, 4), unit: 'mAh/day' },
    { label: 'Average power', value: v ? fmtEng(iavg * v, 'W') : '–', hint: v ? `at ${fmtNum(v)} V` : undefined },
    { label: 'Energy per day', value: v ? fmtEng(iavg * v * 86400, 'J') : '–', hint: v ? fmtEng(iavg * v * 24, 'Wh') : undefined },
    { label: 'Biggest share', value: top ? top.name : '–', hint: top ? `${fmtNum(share(top.q), 3)} % of the charge` : undefined },
  ];
  if (share(qSleep) > 50) values.push({ label: 'Sleep dominates', value: `${fmtNum(share(qSleep), 3)} %`, tone: 'warn', hint: 'lower the sleep current first' });

  const tbl = [...parts.map((p) => [p.name, fmtEng(p.i, 'A'), fmtEng(p.t, 's'), p.n === 1 ? 'every wake' : `1 in ${fmtNum(p.n)}`, fmtEng(p.q / period, 'A'), `${fmtNum(share(p.q), 3)} %`]),
    ['Sleep', fmtEng(isleep, 'A'), fmtEng(tSleep, 's'), 'rest of period', fmtEng(qSleep / period, 'A'), `${fmtNum(share(qSleep), 3)} %`]];
  const periods = [1, 5, 10, 30, 60, 300, 900, 3600].map((T) => {
    const ts = Math.max(0, T - tAct);
    const i = (parts.reduce((a, p) => a + p.q, 0) + isleep * ts) / T;
    return [fmtEng(T, 's'), fmtEng(i, 'A'), fmtNum(i * 86400 / 3.6, 4), T < tWorst ? 'too short' : ''];
  });
  // What the page draws, as plain numbers: each state (idx = its row in the
  // states table), the sleep, and the average at other periods.
  const drawing = {
    period, isleep, tSleep, tAct, tWorst, duty, iavg, qTotal, perDay, v,
    parts: parts.map((p) => ({ name: p.name, idx: p.idx, i: p.i, t: p.t, n: p.n, q: p.q, avg: p.q / period, share: share(p.q) })),
    sleep: { q: qSleep, avg: qSleep / period, share: share(qSleep) },
    sweep: [...new Set([1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, period])].sort((a, b) => a - b).map((T) => {
      const ts = Math.max(0, T - tAct);
      return { T, i: (parts.reduce((a, p) => a + p.q, 0) + isleep * ts) / T, ok: T >= tWorst };
    }),
  };
  return {
    drawing,
    values,
    warnings,
    charts: [{ title: 'Share of the average current', type: 'bars', x: [...parts.map((p) => p.name), 'Sleep'],
      series: [{ name: 'Average current (µA)', y: [...parts.map((p) => Number((p.q / period * 1e6).toPrecision(4))), Number((qSleep / period * 1e6).toPrecision(4))] }],
      yLabel: 'µA' }],
    tables: [
      { title: 'Breakdown', columns: ['State', 'Current', 'Time', 'Runs', 'Adds on average', 'Share'], rows: tbl },
      { title: 'The same states at other wake-up periods', columns: ['Period', 'Average current', 'mAh/day', ''], rows: periods },
    ],
    notes: [
      'Use measured currents where you can: datasheet run currents exclude peripherals, clock start-up and regulator losses.',
      'The average hides peaks: a coin cell or a long wire may not deliver a 25 mA radio burst even when the average is small. Check the peak against the battery.',
      'Leakage of capacitors and of the battery itself is not counted here; the battery life estimator adds self-discharge.',
    ],
  };
}
