// Telemetry mock: a sensor time series built from a model you can reason about,
//   x[k] = base + A·sin(2π·t/P) + drift·t + wander[k] + noise[k] (+ faults),
// then clipped to the sensor's range and quantised to its resolution.
//   noise  - white Gaussian, σ given (Box-Muller transform on a seeded PRNG)
//   wander - random walk, σ per √hour (a sensor's slow 1/f-like bias)
//   faults - spikes, dropouts (missing samples), a stuck-at run, an offset step
// Everything is seeded (mulberry32), so the same inputs give the same data.
// Preset values are typical of common parts (datasheet resolution and noise):
// DS18B20 (0.0625 °C), SHT31 (0.01 %RH), BMP280 (0.16 Pa rms at high res),
// SCD30 CO2 (±30 ppm), a 12-bit ±8 g accelerometer (3.9 mg/LSB).
import { fmtNum } from '../kit/eng.js';

const PRESETS = {
  temperature: { label: 'Temperature', unit: '°C', field: 'temperature', base: 22, amp: 3, noise: 0.08, drift: 0, wander: 0.05, quant: 0.0625, min: -55, max: 125 },
  humidity: { label: 'Relative humidity', unit: '%RH', field: 'humidity', base: 45, amp: 8, noise: 0.3, drift: 0, wander: 0.3, quant: 0.01, min: 0, max: 100 },
  pressure: { label: 'Air pressure', unit: 'hPa', field: 'pressure', base: 1013.25, amp: 0.8, noise: 0.02, drift: -0.1, wander: 0.2, quant: 0.01, min: 300, max: 1100 },
  battery: { label: 'Battery voltage', unit: 'V', field: 'vbat', base: 4.15, amp: 0, noise: 0.004, drift: -0.012, wander: 0.002, quant: 0.001, min: 0, max: 4.35 },
  current: { label: 'Supply current', unit: 'mA', field: 'current', base: 12, amp: 2, noise: 0.4, drift: 0, wander: 0.2, quant: 0.1, min: 0, max: 500 },
  co2: { label: 'CO2', unit: 'ppm', field: 'co2', base: 650, amp: 200, noise: 12, drift: 0, wander: 15, quant: 1, min: 400, max: 10000 },
  accel: { label: 'Acceleration (z)', unit: 'g', field: 'accel_z', base: 1, amp: 0, noise: 0.004, drift: 0, wander: 0.001, quant: 0.0039, min: -8, max: 8 },
  custom: { label: 'Custom', unit: '', field: 'value', base: 0, amp: 1, noise: 0.05, drift: 0, wander: 0, quant: 0, min: -1e9, max: 1e9 },
};

// mulberry32: a small, well-mixed 32-bit PRNG (Tommy Ettinger, public domain).
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Box-Muller: two uniforms -> one standard normal.
const gauss = (rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

const pick = (v, d) => (v == null || !Number.isFinite(v) ? d : v);
const decimalsOf = (q) => {
  if (!(q > 0)) return 4;
  const s = String(Number(q.toPrecision(6)));
  return Math.min(6, s.includes('.') ? s.split('.')[1].length : 0);
};
const MAXN = 20000;

export function run(input) {
  const warnings = [];
  const p = PRESETS[input.sensor] || PRESETS.temperature;
  const base = pick(input.base, p.base), amp = pick(input.amp, p.amp), noise = Math.abs(pick(input.noise, p.noise));
  const drift = pick(input.drift, p.drift), wander = Math.abs(pick(input.wander, p.wander)), quant = Math.abs(pick(input.quant, p.quant));
  const period = pick(input.period, 24);
  const dt = input.interval;
  let n = Math.round(pick(input.count, 0));
  if (!(dt > 0)) return { warnings: ['Give the sample interval in seconds, e.g. 60.'] };
  if (!(n >= 2)) return { warnings: ['Give at least 2 samples.'] };
  if (n > MAXN) { warnings.push(`${n} samples is more than ${MAXN}; made the first ${MAXN}. Use a longer interval or several runs.`); n = MAXN; }
  if (!(period > 0) && amp) warnings.push('The cycle period must be over 0 hours; the cycle is left out.');
  const t0 = Date.parse(String(input.start || '').trim());
  if (!Number.isFinite(t0)) return { warnings: [`Start "${input.start}" is not a date; write it like 2026-01-01T00:00:00Z.`] };
  const spikePct = Math.max(0, pick(input.spikes, 0)), dropPct = Math.max(0, pick(input.dropouts, 0));
  if (spikePct + dropPct > 50) warnings.push(`Spikes plus dropouts are ${spikePct + dropPct} % of the samples: that is mostly faults. Real links drop 0.1-5 %.`);
  const stuckN = Math.max(0, Math.round(pick(input.stuck, 0)));
  const step = pick(input.step, 0);
  const seed = Math.round(pick(input.seed, 1)) >>> 0;
  const rnd = mulberry32(seed);
  const span = p.max - p.min < 1e8 ? p.max - p.min : Math.max(1, Math.abs(amp) * 4 + noise * 20);
  const spikeMag = Math.max(10 * noise, 0.05 * Math.min(span, Math.abs(amp) * 4 + noise * 40 || span));
  const stuckAt = stuckN ? Math.floor(n * (0.2 + 0.6 * rnd())) : -1;
  const stepAt = step ? Math.floor(n / 2) : -1;

  const hours = (k) => (k * dt) / 3600;
  const rows = []; // [ms, value|null, truth]
  const faults = [];
  let walk = 0, clipped = 0, held = null;
  for (let k = 0; k < n; k++) {
    const th = hours(k);
    if (k) walk += wander * Math.sqrt(dt / 3600) * gauss(rnd); // random walk: σ grows with √t
    const cyc = period > 0 ? amp * Math.sin((2 * Math.PI * th) / period) : 0;
    let truth = base + cyc + drift * th + walk + (stepAt >= 0 && k >= stepAt ? step : 0);
    let v = truth + noise * gauss(rnd);
    const u = rnd();
    let kind = null;
    if (stuckAt >= 0 && k >= stuckAt && k < stuckAt + stuckN) {
      if (held == null) held = v;
      v = held; kind = k === stuckAt ? `stuck for ${stuckN} samples` : null;
    } else if (u < spikePct / 100) {
      v += (rnd() < 0.5 ? -1 : 1) * spikeMag * (1 + rnd()); kind = 'spike';
    } else if (u < (spikePct + dropPct) / 100) {
      v = null; kind = 'dropout';
    }
    if (k === stepAt) faults.push([k, new Date(t0 + k * dt * 1000).toISOString(), `offset step ${step > 0 ? '+' : ''}${fmtNum(step, 4)} ${p.unit}`.trim(), '–']);
    if (v != null) {
      if (v > p.max) { v = p.max; clipped++; } else if (v < p.min) { v = p.min; clipped++; }
      if (quant > 0) v = Math.round(v / quant) * quant; // ADC resolution
    }
    if (kind) faults.push([k, new Date(t0 + k * dt * 1000).toISOString(), kind, v == null ? 'missing' : v]);
    rows.push([t0 + k * dt * 1000, v, truth]);
  }
  if (clipped) warnings.push(`${clipped} samples hit the sensor range (${p.min} to ${p.max} ${p.unit}) and were clipped; lower the amplitude, drift or spikes if that is not wanted.`);

  const dec = decimalsOf(quant);
  const f = (v) => (v == null ? '' : Number(v.toFixed(dec)).toString());
  const field = String(input.field || '').trim() || p.field;
  const device = String(input.device || '').trim() || 'dev-01';
  const iso = (ms) => new Date(ms).toISOString();
  let body;
  switch (input.format) {
    case 'json': body = JSON.stringify(rows.map(([ms, v]) => ({ ts: iso(ms), device, [field]: v == null ? null : Number(f(v)) })), null, 1); break;
    case 'ndjson': body = rows.map(([ms, v]) => JSON.stringify({ ts: iso(ms), device, [field]: v == null ? null : Number(f(v)) })).join('\n'); break;
    case 'influx': // InfluxDB line protocol: measurement,tag=v field=v timestamp(ns); missing samples are simply absent
      body = rows.filter((r) => r[1] != null).map(([ms, v]) => `sensor,device=${device.replace(/[ ,=]/g, '\\$&')} ${field}=${f(v)} ${ms}000000`).join('\n'); break;
    default: body = ['timestamp,device,' + field, ...rows.map(([ms, v]) => `${iso(ms)},${device},${f(v)}`)].join('\n');
  }

  const got = rows.map((r) => r[1]).filter((v) => v != null);
  const mean = got.reduce((a, b) => a + b, 0) / (got.length || 1);
  const sd = Math.sqrt(got.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, got.length - 1));
  // Chart: at most ~300 points (every m-th sample) so a day at 1 s stays drawable.
  const m = Math.ceil(n / 300);
  const idx = rows.map((_, k) => k).filter((k) => k % m === 0);
  const unitTxt = p.unit ? ` ${p.unit}` : '';
  const durH = hours(n - 1);
  const values = [
    { label: 'Samples', value: n, hint: `${fmtNum(dt, 4)} s apart, ${durH >= 48 ? fmtNum(durH / 24, 4) + ' days' : fmtNum(durH, 4) + ' h'}` },
    { label: 'Mean', value: got.length ? `${fmtNum(mean, 5)}${unitTxt}` : '–' },
    { label: 'Min / max', value: got.length ? `${fmtNum(Math.min(...got), 4)} / ${fmtNum(Math.max(...got), 4)}${unitTxt}` : '–' },
    { label: 'Std deviation', value: got.length ? `${fmtNum(sd, 3)}${unitTxt}` : '–', hint: 'of the whole series' },
    { label: 'Faults', value: faults.length, hint: `${faults.filter((x) => x[2] === 'spike').length} spikes, ${faults.filter((x) => x[2] === 'dropout').length} dropouts`, tone: faults.length ? 'warn' : 'ok' },
  ];
  if (body.length > 2e6) warnings.push(`The output is ${fmtNum(body.length / 1e6, 3)} MB: copy may be slow. Use fewer samples.`);
  return {
    values,
    charts: [{ title: `${p.label}${unitTxt ? ' (' + p.unit + ')' : ''}${m > 1 ? `, every ${m}th sample` : ''}`, type: 'line',
      x: idx.map((k) => { const h = hours(k); return durH >= 48 ? `${fmtNum(h / 24, 3)} d` : `${fmtNum(h, 3)} h`; }),
      series: [{ name: 'Reported', y: (() => { let last = null; return idx.map((k) => { last = rows[k][1] ?? last ?? rows[k][2]; return last; }); })() }, { name: 'True value', y: idx.map((k) => rows[k][2]) }],
      xLabel: 'time since start', yLabel: p.unit || 'value' }],
    tables: faults.length ? [{ title: `Injected faults${faults.length > 200 ? ' (first 200)' : ''}`, columns: ['Sample', 'Time', 'Fault', 'Reported'], rows: faults.slice(0, 200) }] : [],
    texts: [{ title: input.format === 'influx' ? 'Line protocol' : String(input.format || 'csv').toUpperCase(), body, lang: input.format === 'csv' ? 'csv' : 'json' }],
    warnings,
    notes: [
      `Model: ${fmtNum(base, 5)} + ${fmtNum(amp, 4)}·sin(2πt/${fmtNum(period, 4)} h) + ${fmtNum(drift, 4)}/h·t + random walk (σ ${fmtNum(wander, 3)}/√h) + white noise (σ ${fmtNum(noise, 3)}), quantised to ${quant > 0 ? fmtNum(quant, 4) : 'none'}${unitTxt}.`,
      'Dropouts are empty cells in CSV, null in JSON and absent lines in line protocol. Blank inputs take the preset value.',
      `Seed ${seed}: the same inputs always give the same series.`,
    ],
  };
}
