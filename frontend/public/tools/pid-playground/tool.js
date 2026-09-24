// PID loop simulation.
// Controller (Åström & Hägglund, Advanced PID Control, ch. 3), run every dt:
//   e = r - y
//   P = Kp e
//   D = Tf/(Tf+dt) D - Kd/(Tf+dt) (y - y_prev)   derivative on measurement, filter Tf = Kd/(Kp N)
//   u = clamp(P + I + D, umin, umax)
//   I += Ki e dt  unless u is saturated and e would push it further (clamping anti-windup)
// Plants, integrated between controller samples with a fine step h (zero-order hold on u):
//   fo : τ y' = K u(t-θ) - y                   exact update y += (K u - y)(1 - e^(-h/τ))
//   so : y'' = ωn² (K u(t-θ) - y) - 2ζωn y'     semi-implicit Euler, h ≤ 0.02/ωn
//   int: τ v' = K u(t-θ) - v,  y' = v           exact update for v, then y += v h
// Tuning references:
//   SIMC (Skogestad 2003), τc = θe, θe = θ + dt/2 (half the sample period counts as delay):
//     fo : Kc = τ / (K (τc+θe)),  τI = min(τ, 4 (τc+θe))                     PI
//     int: Kc = 1 / (K (τc+θe)),  τI = 4 (τc+θe),  τD = τ  (series form)      PID
//     so, ζ ≥ 1: Kc = τ1 / (K (τc+θe)), τI = min(τ1, 4 (τc+θe)), τD = τ2 (series)
//     so, ζ < 1: direct synthesis, Kc = 2ζ/ωn / (K (τc+θe)), τI = 2ζ/ωn, τD = 1/(2ζωn) (parallel)
//   Series to parallel: Kp = Kc (1 + τD/τI), Ki = Kc/τI, Kd = Kc τD.
//   Ziegler–Nichols reaction curve (1942): Kp = 1.2 τ/(K L), Ti = 2 L, Td = 0.5 L
import { fmtEng, fmtNum } from '../kit/eng.js';

const MAX_STEPS = 300000;
const OUT_POINTS = 240;

function simulate(p, g) {
  const { plant, K, tau, wn, zeta, theta, dt, umin, umax, sp, dist, tdist, tend } = p;
  // Fine step: resolve the plant's fastest dynamics and the dead time.
  let hmax = dt;
  if (plant !== 'so' && tau > 0) hmax = Math.min(hmax, tau / 20);
  if (plant === 'so') hmax = Math.min(hmax, 0.02 / wn);
  if (theta > 0) hmax = Math.min(hmax, theta / 10);
  let m = Math.max(1, Math.ceil(dt / hmax - 1e-9));
  const nCtl = Math.max(2, Math.ceil(tend / dt));
  let coarse = false;
  if (nCtl * m > MAX_STEPS) { m = Math.max(1, Math.floor(MAX_STEPS / nCtl)); coarse = true; }
  const h = dt / m;
  const D = Math.max(0, Math.round(theta / h));
  const buf = new Float64Array(D + 1);
  let bi = 0;
  let y = 0, v = 0, I = 0, Dt = 0, yPrev = 0;
  const Tf = g.kd > 0 ? (g.kp > 0 && p.nf > 0 ? g.kd / (g.kp * p.nf) : dt) : 0;
  const decay = plant !== 'so' && tau > 0 ? 1 - Math.exp(-h / tau) : 1;
  const t = [], ys = [], us = [], rs = [];
  let diverged = false, satCount = 0;
  const lim = 1e4 * Math.max(1, Math.abs(sp), Math.abs(dist) * Math.abs(K) * Math.max(1, tend));
  for (let k = 0; k <= nCtl; k++) {
    const tk = k * dt;
    const r = sp;
    const e = r - y;
    const P = g.kp * e;
    Dt = Tf + dt > 0 ? (Tf / (Tf + dt)) * Dt - (g.kd / (Tf + dt)) * (y - yPrev) : 0;
    yPrev = y;
    const raw = P + I + Dt;
    const u = Math.min(umax, Math.max(umin, raw));
    const sat = raw > umax || raw < umin;
    if (sat) satCount++;
    // Clamping: integrate unless saturated and the error drives it further into the limit.
    if (!(sat && ((raw > umax && e > 0) || (raw < umin && e < 0)))) I += g.ki * e * dt;
    t.push(tk); ys.push(y); us.push(u); rs.push(r);
    if (k === nCtl) break;
    for (let j = 0; j < m; j++) {
      const tt = tk + j * h;
      const uin = u + (dist && tt >= tdist ? dist : 0);
      buf[bi] = uin;
      const ud = buf[(bi + 1) % (D + 1)]; // written D steps ago (0 before the loop started)
      bi = (bi + 1) % (D + 1);
      if (plant === 'fo') y += (K * ud - y) * decay;
      else if (plant === 'int') { v += (K * ud - v) * decay; y += v * h; }
      else { v += h * (wn * wn * (K * ud - y) - 2 * zeta * wn * v); y += v * h; }
    }
    if (!Number.isFinite(y) || Math.abs(y) > lim) { diverged = true; break; }
  }
  return { t, y: ys, u: us, r: rs, diverged, coarse, h, satFrac: satCount / t.length };
}

function metrics(s, p) {
  const { sp, dist, tdist } = p;
  const n = s.t.length;
  const segEnd = dist ? s.t.findIndex((x) => x >= tdist) : n;
  const end = segEnd > 0 ? segEnd : n;
  const out = { rise: null, overshoot: null, settle: null, sse: null, peakU: null, dPeak: null, dRecover: null, settled: false };
  if (!sp || s.diverged) return out;
  // Rise, overshoot and settling are taken against the final value (Ogata), so a
  // P-only loop with an offset still gets a settling time; the offset is reported apart.
  // With integral action (Ki or an integrating plant) the final value is the setpoint;
  // otherwise it is where the output ended, which carries the P-only offset.
  let yf = p.integral ? sp : s.y[end - 1];
  if (!(yf / sp > 0.05)) yf = sp;
  const yn = s.y.map((y) => y / yf);
  const i10 = yn.findIndex((y, i) => i < end && y >= 0.1);
  const i90 = yn.findIndex((y, i) => i < end && y >= 0.9);
  if (i10 >= 0 && i90 >= 0) out.rise = s.t[i90] - s.t[i10];
  let mx = -Infinity;
  for (let i = 0; i < end; i++) mx = Math.max(mx, yn[i]);
  out.overshoot = Math.max(0, (mx - 1) * 100);
  let last = -1;
  for (let i = 0; i < end; i++) if (Math.abs(yn[i] - 1) > 0.02) last = i;
  out.settled = last < end - 1;
  out.settle = out.settled ? s.t[last + 1] : null;
  out.sse = sp - s.y[end - 1];
  out.peakU = Math.max(...s.u.map(Math.abs));
  if (dist && segEnd > 0) {
    let dp = 0, lastD = -1;
    for (let i = segEnd; i < n; i++) {
      const dev = s.y[i] - sp;
      if (Math.abs(dev) > Math.abs(dp)) dp = dev;
      if (Math.abs(dev) > 0.02 * Math.abs(sp)) lastD = i;
    }
    out.dPeak = dp;
    out.dRecover = lastD < n - 1 ? (lastD < 0 ? 0 : s.t[lastD + 1] - s.t[segEnd]) : null;
  }
  return out;
}

function down(arr, idx) { return idx.map((i) => Number(arr[i].toPrecision(5))); }

function suggestions(p) {
  const { plant, K, tau, wn, zeta, theta, dt } = p;
  const te = theta + dt / 2;
  const tc = te;
  const list = [];
  const series = (Kc, tI, tD) => ({ kp: Kc * (1 + tD / tI), ki: Kc / tI, kd: Kc * tD });
  if (plant === 'fo') {
    const Kc = tau / (K * (tc + te)), tI = Math.min(tau, 4 * (tc + te));
    list.push({ name: 'SIMC PI (τc = θ)', kp: Kc, ki: Kc / tI, kd: 0 });
    const zp = (1.2 * tau) / (K * te);
    list.push({ name: 'Ziegler–Nichols PID', kp: zp, ki: zp / (2 * te), kd: zp * 0.5 * te });
  } else if (plant === 'int') {
    const Kc = 1 / (K * (tc + te)), tI = 4 * (tc + te);
    list.push({ name: tau > 0 ? 'SIMC PID (series τD = τ)' : 'SIMC PI', ...series(Kc, tI, tau > 0 ? tau : 0) });
    const L = te + tau;
    const zp = 1.2 / (K * L);
    list.push({ name: 'Ziegler–Nichols PID', kp: zp, ki: zp / (2 * L), kd: zp * 0.5 * L });
  } else if (zeta >= 1) {
    const r = Math.sqrt(zeta * zeta - 1);
    const t1 = 1 / (wn * (zeta - r)), t2 = 1 / (wn * (zeta + r));
    const Kc = t1 / (K * (tc + te)), tI = Math.min(t1, 4 * (tc + te));
    list.push({ name: 'SIMC PID (series τD = τ2)', ...series(Kc, tI, t2) });
  } else {
    const t0 = 1 / wn, a = K * (tc + te);
    list.push({ name: 'SIMC / direct synthesis PID', kp: (2 * zeta * t0) / a, ki: 1 / a, kd: (t0 * t0) / a });
  }
  return list;
}

export function run(input) {
  const { plant = 'fo', K, tau, wn, zeta, theta, kp, ki, kd, dt, nf, umin, umax, sp, dist, tdist, tend } = input;
  const warnings = [];
  if (!(K != null && K !== 0)) return { warnings: ['Give the plant gain K (not 0), e.g. 2.'] };
  if (plant !== 'so' && !(tau >= 0)) return { warnings: ['Give the plant time constant τ in seconds (0 or more), e.g. 5.'] };
  if (plant === 'so' && !(wn > 0)) return { warnings: ['Give the natural frequency ωn in rad/s, e.g. 1.'] };
  if (plant === 'so' && !(zeta >= 0)) return { warnings: ['Give the damping ratio ζ (0 or more), e.g. 0.5.'] };
  if (!(dt > 0)) return { warnings: ['Give the controller period dt in seconds, e.g. 50m.'] };
  if (!(umax > umin)) return { warnings: ['Output max must be above output min, e.g. 0 and 2.'] };
  if (!sp) return { warnings: ['Give a setpoint step other than 0, e.g. 1.'] };
  const th = theta > 0 ? theta : 0;
  if (theta < 0) warnings.push('Dead time cannot be negative: 0 used.');
  const g = { kp: kp || 0, ki: ki || 0, kd: kd || 0 };
  if (g.kp < 0 || g.ki < 0 || g.kd < 0) warnings.push('A negative gain makes the loop act the wrong way. For a plant whose output falls when the drive rises, give a negative K instead.');
  const dom = plant === 'so' ? 1 / wn : (tau > 0 ? tau : Math.max(th, dt * 10));
  const auto = 10 * (dom + th) * (plant === 'so' && zeta < 0.5 ? 2 : 1);
  let T = tend > 0 ? tend : auto;
  if (T / dt > 20000) { T = 20000 * dt; warnings.push(`The run is capped at 20 000 controller periods (${fmtEng(T, 's')}): shorten it or use a larger dt.`); }
  const p = { plant, K, tau: tau > 0 ? tau : 0, wn, zeta, theta: th, dt, nf: nf > 0 ? nf : 0, umin, umax, sp, dist: dist || 0, tdist: 0, tend: T };
  p.tdist = p.dist ? (tdist > 0 && tdist < T ? tdist : T / 2) : T;
  if (p.dist && tdist >= T) warnings.push('The load step time is past the end of the run: it is moved to half-way.');
  if (dt > dom / 5) warnings.push(`The controller period (${fmtEng(dt, 's')}) is long against the plant's ${fmtEng(dom, 's')} time scale: sampling adds about dt/2 of dead time. Aim for dt ≤ ${fmtEng(dom / 10, 's')}.`);
  const uNeed = plant === 'int' ? 0 : sp / K;
  if (uNeed > umax || uNeed < umin) warnings.push(`Holding the setpoint needs a steady output of ${fmtNum(uNeed, 3)}, outside ${fmtNum(umin)} … ${fmtNum(umax)}: the loop cannot reach it. Widen the output range or lower the setpoint.`);

  const s = simulate(p, g);
  p.integral = g.ki > 0 || plant === 'int';
  const mt = metrics(s, p);
  if (s.diverged) warnings.push('The loop is unstable: the output grew without bound. Lower Kp and Kd, or lower Ki, or shorten the dead time / controller period.');
  if (s.coarse) warnings.push('The plant is fast against this run length: it was integrated with a coarser step and the curve may be less exact. Shorten the run.');
  if (!s.diverged && !mt.settled) warnings.push('The response has not settled within 2 % of its final value by the end of the run (or before the load step): lengthen the run, or the loop oscillates.');
  if (!s.diverged && ki === 0 && plant !== 'int' && Math.abs(mt.sse) > 0.02 * Math.abs(sp)) warnings.push('Without Ki a type-0 plant keeps a steady-state error: add some integral action.');
  if (s.satFrac > 0.3) warnings.push(`The output sits on a limit ${fmtNum(s.satFrac * 100, 2)} % of the time: the response is set by the actuator, not by the gains.`);

  // Tuning references, each simulated with the same plant and limits.
  const sug = suggestions(p).map((x) => {
    const r = simulate(p, x); const q = metrics(r, { ...p, integral: x.ki > 0 || plant === 'int' });
    return [x.name, fmtNum(x.kp, 3), fmtNum(x.ki, 3), fmtNum(x.kd, 3),
      r.diverged ? 'unstable' : `${fmtNum(q.overshoot, 3)} %`, r.diverged ? '–' : q.settle != null ? fmtEng(q.settle, 's') : 'not settled'];
  });

  const n = s.t.length;
  const step = Math.max(1, Math.ceil(n / OUT_POINTS));
  const idx = []; for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const tone = (ok, warn) => (ok ? 'ok' : warn ? 'warn' : 'bad');
  const values = [
    { label: 'Rise time 10–90 %', value: mt.rise != null ? fmtEng(mt.rise, 's') : '–' },
    { label: 'Overshoot', value: mt.overshoot != null ? fmtNum(mt.overshoot, 3) : '–', unit: '%', tone: mt.overshoot == null ? 'bad' : tone(mt.overshoot <= 10, mt.overshoot <= 25) },
    { label: 'Settling time (2 % band)', value: mt.settle != null ? fmtEng(mt.settle, 's') : 'not settled', tone: mt.settled ? 'ok' : 'bad' },
    { label: 'Steady-state error', value: mt.sse != null ? fmtNum(mt.sse, 3) : '–', hint: 'setpoint − output, end of step' },
    { label: 'Peak controller output', value: mt.peakU != null ? fmtNum(mt.peakU, 4) : '–', hint: `limits ${fmtNum(umin)} … ${fmtNum(umax)}` },
    { label: 'Time on a limit', value: fmtNum(s.satFrac * 100, 3), unit: '%' },
  ];
  if (p.dist) values.push(
    { label: 'Load step: peak deviation', value: mt.dPeak != null ? fmtNum(mt.dPeak, 3) : '–', hint: `step ${fmtNum(p.dist)} at ${fmtEng(p.tdist, 's')}` },
    { label: 'Load step: recovery (2 %)', value: mt.dRecover != null ? fmtEng(mt.dRecover, 's') : 'not recovered' },
  );
  const ctrlCode = [
    `// Parallel PID, dt = ${fmtEng(dt, 's')}, derivative on measurement, clamping anti-windup`,
    `#define KP ${fmtNum(g.kp, 6)}f`, `#define KI ${fmtNum(g.ki, 6)}f`, `#define KD ${fmtNum(g.kd, 6)}f`,
    `#define DT ${fmtNum(dt, 6)}f`, `#define TF ${fmtNum(g.kd > 0 ? (g.kp > 0 && p.nf > 0 ? g.kd / (g.kp * p.nf) : dt) : 0, 6)}f   /* derivative filter */`,
    `#define UMIN ${fmtNum(umin, 6)}f`, `#define UMAX ${fmtNum(umax, 6)}f`,
    'static float i_term, d_term, y_prev;',
    'float pid_step(float r, float y)',
    '{',
    '    float e = r - y;',
    '    d_term = (TF / (TF + DT)) * d_term - (KD / (TF + DT)) * (y - y_prev);',
    '    y_prev = y;',
    '    float raw = KP * e + i_term + d_term;',
    '    float u = raw > UMAX ? UMAX : raw < UMIN ? UMIN : raw;',
    '    if (!((raw > UMAX && e > 0) || (raw < UMIN && e < 0))) i_term += KI * e * DT;',
    '    return u;',
    '}',
  ].join('\n');
  return {
    values,
    warnings,
    sim: { t: down(s.t, idx), sp: down(s.r, idx), y: down(s.y, idx), u: down(s.u, idx), umin, umax,
      settle: mt.settle, tdist: p.dist ? p.tdist : null, diverged: s.diverged },
    tables: [{ title: 'SIMC and Ziegler–Nichols gains for this plant, simulated',
      columns: ['Rule', 'Kp', 'Ki', 'Kd', 'Overshoot', 'Settling'], rows: sug }],
    texts: [{ title: 'C code', body: ctrlCode, lang: 'c' }],
    notes: [
      `The tuning rules use the effective dead time θ + dt/2 = ${fmtEng(p.theta + dt / 2, 's')} (sampling adds half a period) and SIMC's τc = that; each rule's overshoot and settling come from the same simulation.`,
      'Rise time (10–90 %), overshoot and settling (2 % band) are measured against the final value of the setpoint step; the steady-state error is the gap to the setpoint.',
      'Gains are in parallel form u = Kp e + Ki ∫e dt + Kd de/dt; for the standard form Ti = Kp/Ki and Td = Kd/Kp.',
      'The D term acts on the measurement, so a setpoint step gives no derivative kick; it is low-passed with Tf = Kd / (Kp N).',
      'The model is linear and noise-free: real sensors add noise that a large Kd amplifies, and real actuators add rate limits and backlash.',
      'Ziegler–Nichols gains are aggressive by design (about quarter-amplitude decay); SIMC with τc = θ aims at a robust, fast response.',
    ],
  };
}
