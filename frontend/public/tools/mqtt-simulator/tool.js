// MQTT message simulator: fake telemetry from N devices, the same every time for
// the same seed, to test an IoT dashboard. run() only builds the messages (pure);
// view.js publishes them live to a broker over MQTT-over-WebSocket, and writes
// what the broker sent back into "Received" so run() can report on it.
// Value models (all seeded, mulberry32 PRNG + Box-Muller for normal noise):
//   walk     x[k] = clamp(x[k-1] + N(0, step)), starting mid-range - a slowly drifting sensor
//   sine     mid + amp * sin(2*pi*t / period) + N(0, amp/20) - a daily cycle, a vibration
//   random   uniform in [min, max]
//   counter  min + k * step, wraps at max - an uptime or pulse counter
//   bool     true with probability p (min column), sticky between samples
//   enum     one of the options (a|b|c), mostly the first
// Topic rules from the MQTT 3.1.1 specification (OASIS, 2014) section 4.7:
// no wildcards (+ #) in a published topic; topics starting with $ are the broker's.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (v, d) => { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim()); return Number.isFinite(x) ? x : d; };

export function fieldsOf(input) {
  return (Array.isArray(input.fields) ? input.fields : []).map((f) => ({
    name: String(f.name || '').trim(), kind: String(f.kind || 'walk'), min: n(f.min, 0), max: n(f.max, 100),
    extra: String(f.extra ?? '').trim(), decimals: Math.max(0, Math.min(6, Math.round(n(f.decimals, 1)))),
  })).filter((f) => f.name);
}

/** One generator per device: next(tMs) -> the payload object for that moment. */
export function makeDevice(input, dev) {
  const fields = fieldsOf(input);
  const rnd = mulberry32((Math.round(n(input.seed, 1)) * 7919 + dev * 104729) >>> 0);
  const gauss = () => { const u = 1 - rnd(), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const state = fields.map((f) => (f.kind === 'walk' ? (f.min + f.max) / 2 + (f.max - f.min) * 0.1 * (rnd() - 0.5) : f.kind === 'bool' ? rnd() < f.min : 0));
  const phase = fields.map(() => rnd() * 2 * Math.PI);
  let k = 0;
  const round = (v, d) => Number(v.toFixed(d));
  return {
    next(tMs) {
      const out = { device: deviceId(input, dev) };
      if (input.with_ts !== false) out.ts = new Date(tMs).toISOString();
      fields.forEach((f, i) => {
        const lo = Math.min(f.min, f.max), hi = Math.max(f.min, f.max);
        let v;
        switch (f.kind) {
          case 'sine': {
            const period = n(f.extra, 3600) > 0 ? n(f.extra, 3600) : 3600;
            const mid = (lo + hi) / 2, amp = (hi - lo) / 2;
            v = round(Math.min(hi, Math.max(lo, mid + amp * Math.sin((2 * Math.PI * tMs) / 1000 / period + phase[i]) + gauss() * amp / 20)), f.decimals);
            break;
          }
          case 'random': v = round(lo + rnd() * (hi - lo), f.decimals); break;
          case 'counter': {
            const step = n(f.extra, 1) || 1;
            const span = hi - lo + (Number.isInteger(step) ? 1 : 0);
            v = round(lo + ((k * step) % (span > 0 ? span : 1)), f.decimals);
            break;
          }
          case 'bool': {
            // Sticky: flips with probability 0.2 towards the target share p.
            const p = Math.min(1, Math.max(0, f.min));
            if (rnd() < 0.2) state[i] = rnd() < p;
            v = !!state[i];
            break;
          }
          case 'enum': {
            const opts = f.extra.split('|').map((s) => s.trim()).filter(Boolean);
            const list = opts.length ? opts : ['ok'];
            v = rnd() < 0.8 ? list[0] : list[Math.floor(rnd() * list.length)];
            break;
          }
          default: { // walk
            const step = n(f.extra, (hi - lo) / 50) || (hi - lo) / 50;
            state[i] = Math.min(hi, Math.max(lo, state[i] + gauss() * step));
            v = round(state[i], f.decimals);
          }
        }
        out[f.name] = v;
      });
      k += 1;
      return out;
    },
  };
}

export function deviceId(input, dev) {
  const p = String(input.prefix ?? 'dev').trim() || 'dev';
  return `${p}-${String(dev + 1).padStart(2, '0')}`;
}

export function topicFor(input, dev, field = '') {
  return String(input.topic || '').replace(/\{device\}/g, deviceId(input, dev)).replace(/\{field\}/g, field);
}

/** Payload text: JSON, or InfluxDB line protocol. */
export function encode(input, obj) {
  if (input.format === 'influx') {
    const { device, ts, ...rest } = obj;
    const f = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : typeof v === 'boolean' ? v : Number.isInteger(v) ? `${v}` : v}`).join(',');
    return `${String(input.measurement || 'telemetry').replace(/[ ,]/g, '_')},device=${device} ${f}${ts ? ` ${Date.parse(ts) * 1e6}` : ''}`;
  }
  return JSON.stringify(obj);
}

const utf8len = (s) => { let b = 0; for (const ch of s) { const c = ch.codePointAt(0); b += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return b; };

export function run(input) {
  const warnings = [], notes = [];
  const devices = Math.max(1, Math.min(200, Math.round(n(input.devices, 1))));
  const steps = Math.max(1, Math.min(50, Math.round(n(input.count, 5))));
  const interval = n(input.interval, 5);
  const fields = fieldsOf(input);
  const topic = String(input.topic || '').trim();
  const t0 = Date.parse(String(input.start || '').trim());
  const start = Number.isFinite(t0) ? t0 : Date.UTC(2026, 0, 1);
  if (!Number.isFinite(t0)) warnings.push('Start time is not a date: write it like 2026-01-01T00:00:00Z. Using 2026-01-01T00:00:00Z.');
  if (!(interval > 0)) return { warnings: ['Give the interval between messages in seconds, e.g. 5.'] };
  if (n(input.devices, 1) > 200) warnings.push('At most 200 devices are simulated.');
  if (!topic) return { warnings: ['Give a topic, e.g. site/{device}/telemetry.'] };
  if (/[+#]/.test(topic)) warnings.push('The topic has + or #: those are subscription wildcards and a broker rejects them in a published topic (MQTT 3.1.1, 4.7.1). Remove them.');
  if (topic.startsWith('$')) warnings.push('Topics starting with $ are reserved for the broker ($SYS): pick another root.');
  if (topic.startsWith('/')) notes.push('A leading / makes an empty first level ("" then site...): allowed, but a common source of subscriptions that do not match.');
  if (!topic.includes('{device}') && devices > 1) notes.push('The topic has no {device}: every device publishes on the same topic, told apart only by the "device" key.');
  if (!fields.length) warnings.push('Add at least one field (name, kind, min, max).');
  const url = String(input.broker || '').trim();
  if (url && !/^wss?:\/\/[^\s/]+/i.test(url)) warnings.push('The broker must be a WebSocket URL (ws:// or wss://host:port/path): browsers cannot open raw MQTT (TCP 1883).');
  if (/^ws:\/\//i.test(url)) notes.push('ws:// is unencrypted: an https page may not open it (mixed content). Use wss:// or open the app over http.');
  for (const f of fields) {
    if (!['walk', 'sine', 'random', 'counter', 'bool', 'enum'].includes(f.kind)) warnings.push(`Field ${f.name}: unknown kind "${f.kind}", treated as walk.`);
    if (['walk', 'sine', 'random', 'counter'].includes(f.kind) && f.min === f.max) notes.push(`Field ${f.name}: min equals max, the value never changes.`);
    if (['device', 'ts'].includes(f.name)) warnings.push(`Field name "${f.name}" is used by the simulator itself: rename it.`);
  }

  const gens = Array.from({ length: devices }, (_, d) => makeDevice(input, d));
  const rows = [], lines = [];
  // The page's drawing: every field's values per device and step, and each
  // message, for the first 16 devices (agentOmit: agents get the texts).
  const SD = Math.min(devices, 16);
  const series = {
    t: [], shown: SD, devices, ids: Array.from({ length: SD }, (_, d) => deviceId(input, d)),
    topics: Array.from({ length: SD }, (_, d) => topicFor(input, d)),
    fields: fields.map((f) => ({ name: f.name, kind: f.kind, lo: Math.min(f.min, f.max), hi: Math.max(f.min, f.max), v: Array.from({ length: SD }, () => []) })),
    payloads: Array.from({ length: SD }, () => []),
  };
  let bytes = 0, count = 0;
  for (let k = 0; k < steps; k++) {
    const t = start + k * interval * 1000;
    series.t.push(new Date(t).toISOString());
    for (let d = 0; d < devices; d++) {
      const obj = gens[d].next(t);
      const payload = encode(input, obj);
      if (d < SD) {
        series.fields.forEach((f) => f.v[d].push(obj[f.name]));
        series.payloads[d].push(payload);
      }
      const tp = topicFor(input, d);
      bytes += utf8len(payload) + utf8len(tp); count += 1;
      if (rows.length < 40) rows.push([new Date(t).toISOString().slice(11, 19), tp, payload]);
      lines.push(`${tp} ${payload}`);
    }
  }
  const avg = bytes / count;
  const perMin = (devices * 60) / interval;
  // MQTT PUBLISH on the wire (QoS 0): 1 byte header + 1-4 length bytes + 2 bytes topic length + topic + payload.
  const wire = avg + 2 + 1 + (avg > 125 ? 2 : 1);
  const bps = (wire * devices) / interval;
  if (perMin > 600 && /mosquitto\.org|hivemq\.com|emqx\.io/.test(url)) warnings.push(`${Math.round(perMin)} messages/min to a public test broker: it may throttle or drop you. Raise the interval or use your own broker.`);
  if (avg > 256 * 1024) warnings.push('Messages over 256 kB: many brokers and cloud IoT services (AWS IoT: 128 kB) reject them.');

  // What came back (view.js writes "ISO-time topic payload" lines after a live run).
  const rec = String(input.received || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const recRows = [];
  let bad = 0; const lat = []; const perTopic = new Map();
  for (const l of rec) {
    const m = /^(\S+)\s+(\S+)\s+(.*)$/.exec(l);
    const at = m ? Date.parse(m[1]) : NaN;
    if (!m || !Number.isFinite(at)) { bad += 1; continue; }
    perTopic.set(m[2], (perTopic.get(m[2]) || 0) + 1);
    try { const p = JSON.parse(m[3]); const ts = Date.parse(p?.ts); if (Number.isFinite(ts)) lat.push(at - ts); } catch { /* not JSON */ }
  }
  for (const [t, c] of perTopic) recRows.push([t, c]);
  const values = [
    { label: 'Messages / min', value: Number(perMin.toFixed(2)), hint: `${devices} devices every ${interval} s` },
    { label: 'Payload, average', value: Math.round(avg), unit: 'B', hint: 'topic + payload' },
    { label: 'Broker traffic', value: bps >= 1000 ? (bps / 1000).toFixed(2) : bps.toFixed(1), unit: bps >= 1000 ? 'kB/s' : 'B/s', hint: 'QoS 0, headers included' },
    { label: 'Per day', value: ((bps * 86400) / 1e6).toFixed(1), unit: 'MB' },
  ];
  if (rec.length) {
    values.push({ label: 'Received back', value: rec.length - bad, hint: `${perTopic.size} topic(s)` });
    if (lat.length) {
      const s = [...lat].sort((a, b) => a - b);
      values.push({ label: 'Round trip, median', value: s[Math.floor(s.length / 2)], unit: 'ms', hint: `max ${s[s.length - 1]} ms, from the ts key` });
    }
    if (bad) warnings.push(`${bad} line(s) in Received could not be read (expected: ISO-time topic payload).`);
  }
  const host = (/^wss?:\/\/([^/:]+)/i.exec(url) || [])[1] || 'localhost';
  const script = ['#!/bin/sh', `# The preview messages, published with mosquitto_pub over plain MQTT (TCP 1883) to ${host}.`,
    `# A broker's TCP port may differ from its WebSocket port; public test brokers use 1883.`,
    ...lines.map((l) => { const i = l.indexOf(' '); return `mosquitto_pub -h ${host} -p 1883 -q ${input.qos === '1' ? 1 : 0}${input.retain ? ' -r' : ''} -t '${l.slice(0, i)}' -m '${l.slice(i + 1).replace(/'/g, "'\\''")}'`; }),
    ''].join('\n');
  return {
    series,
    values, warnings, notes: [...notes,
      'The same seed gives the same values every time, so a dashboard test can be repeated; change the seed for a new run.',
      'Live publishing (in the app) uses QoS 0 from the browser; the script uses the QoS you chose.',
      'Round trip is measured only when the payload is JSON with a ts key and the broker echoes to the page\'s own subscription.'],
    tables: [
      { title: `Preview: first ${Math.min(rows.length, count)} of ${count} messages`, columns: ['Time (UTC)', 'Topic', 'Payload'], rows },
      ...(recRows.length ? [{ title: 'Received back, by topic', columns: ['Topic', 'Messages'], rows: recRows }] : []),
    ],
    texts: [
      { title: 'Messages', body: lines.join('\n') + '\n' },
      { title: 'mosquitto_pub', body: script, lang: 'sh' },
    ],
  };
}
