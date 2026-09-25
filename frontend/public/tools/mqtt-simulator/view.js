// Live publishing: a minimal MQTT 3.1.1 client over WebSocket (subprotocol
// "mqtt"), enough for CONNECT, PUBLISH (QoS 0), SUBSCRIBE (to see our own
// messages come back), PINGREQ and DISCONNECT - packet layouts from OASIS MQTT
// 3.1.1 section 3. Messages come from the same generators as run(), stamped
// with the real time. On Stop, what came back is written into "Received".
// The page itself (the channel rack, the message tape) is page() below.
import { makeDevice, topicFor, encode } from './tool.js';

const S = { ws: null, state: 'idle', msg: '', sent: 0, got: 0, log: [], rec: [], timer: null, ping: null, gens: null, cfg: null, redraw: null };
const MAX_REC = 400;

// ---- packets ----
const enc = new TextEncoder(), dec = new TextDecoder();
const str = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
function remLen(n) { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0); return out; }
const packet = (type, body) => new Uint8Array([type, ...remLen(body.length), ...body]);

function connectPkt(cfg) {
  let flags = 0x02; // clean session
  const payload = [...str(cfg.clientId)];
  if (cfg.username) { flags |= 0x80; payload.push(...str(cfg.username)); }
  if (cfg.username && cfg.password) { flags |= 0x40; payload.push(...str(cfg.password)); }
  return packet(0x10, [...str('MQTT'), 4, flags, 0, 60, ...payload]);
}
const publishPkt = (topic, payload, retain) => packet(0x30 | (retain ? 1 : 0), [...str(topic), ...enc.encode(payload)]);
const subscribePkt = (filter) => packet(0x82, [0, 1, ...str(filter), 0]);

function parse(buf) {
  const b = new Uint8Array(buf);
  const out = [];
  let i = 0;
  while (i < b.length) {
    const type = b[i] >> 4;
    let mult = 1, len = 0, j = i + 1, d;
    do { d = b[j++]; len += (d & 127) * mult; mult *= 128; } while (d & 128 && j < b.length);
    const body = b.subarray(j, j + len);
    out.push({ type, flags: b[i] & 15, body });
    i = j + len;
  }
  return out;
}

const CONNACK = ['accepted', 'refused: protocol version', 'refused: client id rejected', 'refused: server unavailable', 'refused: bad username or password', 'refused: not authorised'];

function stop(reason) {
  clearInterval(S.timer); clearInterval(S.ping); S.timer = S.ping = null;
  if (S.ws) {
    try { if (S.ws.readyState === 1) S.ws.send(new Uint8Array([0xE0, 0])); S.ws.close(); } catch { /* closing anyway */ }
    S.ws = null;
  }
  S.state = 'idle';
  if (reason) S.msg = reason;
}

function start(input, raw, api) {
  stop();
  const url = String(raw.broker || '').trim();
  if (!/^wss?:\/\//i.test(url)) { S.msg = 'The broker must be a ws:// or wss:// URL.'; return; }
  if (location.protocol === 'https:' && /^ws:/i.test(url)) { S.msg = 'This page is https: the browser blocks ws:// (mixed content). Use the broker\'s wss:// port.'; return; }
  const devices = Math.max(1, Math.min(200, Math.round(input.devices || 1)));
  const interval = input.interval > 0 ? Math.max(0.2, input.interval) : 5;
  S.cfg = { url, devices, interval, retain: !!input.retain, clientId: `redline-sim-${Math.random().toString(36).slice(2, 10)}`, username: raw.username, password: raw.password };
  S.gens = Array.from({ length: devices }, (_, d) => makeDevice(input, d));
  S.sent = 0; S.got = 0; S.log = []; S.rec = [];
  S.state = 'connecting'; S.msg = `Connecting to ${url}…`;
  let ws;
  try { ws = new WebSocket(url, ['mqtt']); } catch (e) { S.state = 'idle'; S.msg = `Could not open the socket: ${e.message}`; return; }
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  const opened = Date.now();
  ws.onopen = () => ws.send(connectPkt(S.cfg));
  ws.onerror = () => {
    S.msg = `The WebSocket failed (${url}). Check the URL, port and path (often /mqtt), that the broker offers WebSocket, and a firewall or mixed-content block.`;
  };
  ws.onclose = (e) => {
    if (S.ws === ws) {
      const was = S.state, prev = S.msg;
      stop();
      const how = `closed${e.code ? ` (code ${e.code})` : ''} after ${Math.round((Date.now() - opened) / 1000)} s.`;
      S.msg = was === 'running' ? `The broker ${how}` : `${prev} Socket ${how}`;
      flush(api);
    }
    S.redraw?.();
  };
  ws.onmessage = (ev) => {
    for (const p of parse(ev.data)) {
      if (p.type === 2) { // CONNACK
        const rc = p.body[1];
        if (rc !== 0) { S.msg = `Broker ${CONNACK[rc] || `refused (${rc})`}.`; stop(); S.redraw?.(); return; }
        S.state = 'running'; S.msg = `Connected. Publishing ${devices} device(s) every ${interval} s.`;
        const filter = String(raw.topic || '').replace(/\{device\}/g, '+').replace(/\{field\}/g, '+');
        if (!/[#]/.test(String(raw.topic))) ws.send(subscribePkt(filter));
        const tick = () => {
          const t = Date.now();
          for (let d = 0; d < devices; d++) {
            const tp = topicFor(input, d);
            const pl = encode(input, S.gens[d].next(t));
            ws.send(publishPkt(tp, pl, S.cfg.retain));
            S.sent += 1;
            S.log.unshift(`${new Date(t).toISOString().slice(11, 23)} → ${tp} ${pl}`);
          }
          S.log.length = Math.min(S.log.length, 8);
          S.redraw?.();
        };
        tick();
        S.timer = setInterval(tick, interval * 1000);
        S.ping = setInterval(() => { if (ws.readyState === 1) ws.send(new Uint8Array([0xC0, 0])); }, 30000);
      } else if (p.type === 3) { // PUBLISH from our subscription
        const tl = (p.body[0] << 8) | p.body[1];
        const topic = dec.decode(p.body.subarray(2, 2 + tl));
        const qos = (p.flags >> 1) & 3;
        const payload = dec.decode(p.body.subarray(2 + tl + (qos ? 2 : 0)));
        S.got += 1;
        S.rec.push(`${new Date().toISOString()} ${topic} ${payload}`);
        if (S.rec.length > MAX_REC) S.rec.shift();
      }
    }
    S.redraw?.();
  };
}

function flush(api) {
  if (!S.rec.length) return;
  const text = S.rec.join('\n');
  S.rec = [];
  api.set('received', text);
}


// ---------------------------------------------------------------- the page
// A signal rack: every field is a channel drawn as its traces across the
// preview (one line per device), with its range as two handles you drag
// (or focus and step with the arrow keys). Under the channels, on the same
// time axis, the message tape: one cell per message, device by step; a
// click opens that message. The fleet (devices, interval, seed, payload
// format) and the broker link sit at the side. Every value drawn comes from
// run()'s result.series, made by the same generators the messages use.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const KINDS = ['walk', 'sine', 'random', 'counter', 'bool', 'enum'];
const EXTRA = { walk: ['step', 'drift per message (σ)'], sine: ['period s', 'one full cycle, in seconds'], random: ['', ''], counter: ['step', 'added per message; wraps at max'], bool: ['', ''], enum: ['options', 'a|b|c, the first is the usual one'] };
const DEVCOLS = 8;
const fmtV = (v, d) => (typeof v === 'number' ? v.toFixed(Math.max(0, Math.min(6, d))) : String(v));
const decOf = (f) => Math.max(0, Math.min(6, Math.round(parseFloat(f.decimals) || 0)));

export function page(root, ctx) {
  const served = /^https?:/.test(location.protocol);
  const st = { dev: 0, step: 0, drag: null, dom: new Map(), hoverField: null };
  const fieldsRaw = () => (Array.isArray(ctx.raw.fields) ? ctx.raw.fields.map((f) => ({ ...f })) : []);
  // series.fields skips rows without a name: map a drawn channel back to its row
  const rawIndex = (i) => { const fs = fieldsRaw(); let n = -1; for (let j = 0; j < fs.length; j++) if (String(fs[j].name || '').trim() && ++n === i) return j; return -1; };
  const setField = (i, patch) => { const j = rawIndex(i); if (j < 0) return; const fs = fieldsRaw(); fs[j] = { ...fs[j], ...patch }; ctx.set('fields', fs); };

  // ------------------------------------------------------------ broker bar
  const brokerIn = h('input', { type: 'text', class: 'mq-in mq-url', spellcheck: 'false', 'aria-label': 'Broker WebSocket URL', onchange: (e) => ctx.set('broker', e.target.value) });
  const topicIn = h('input', { type: 'text', class: 'mq-in mq-topic', spellcheck: 'false', 'aria-label': 'Topic', oninput: (e) => ctx.set('topic', e.target.value) });
  const topicEx = h('span', { class: 'mq-soft mq-mono mq-small' });
  const lamp = h('span', { class: 'mq-lamp' });
  const liveBtn = h('button', { class: 'k-btn k-primary mq-live' });
  const liveMsg = h('span', { class: 'mq-small', role: 'status' });
  const liveCnt = h('span', { class: 'mq-mono mq-small mq-soft' });
  const liveLog = h('pre', { class: 'mq-log' });
  const userIn = h('input', { type: 'text', class: 'mq-in', spellcheck: 'false', 'aria-label': 'Username', placeholder: 'username', onchange: (e) => ctx.set('username', e.target.value) });
  const passIn = h('input', { type: 'password', class: 'mq-in', 'aria-label': 'Password', placeholder: 'password', onchange: (e) => ctx.set('password', e.target.value) });
  const qosSel = h('select', { class: 'mq-in', 'aria-label': 'QoS in the script', onchange: (e) => ctx.set('qos', e.target.value) }, h('option', { value: '0' }, 'QoS 0'), h('option', { value: '1' }, 'QoS 1'));
  const retainCb = h('input', { type: 'checkbox', onchange: (e) => ctx.set('retain', e.target.checked) });
  const bar = h('section', { class: 'mq-panel mq-bar' },
    h('div', { class: 'mq-barrow' },
      h('label', { class: 'mq-lbl mq-grow' }, h('span', {}, 'Broker'), brokerIn),
      h('label', { class: 'mq-lbl mq-grow2' }, h('span', {}, 'Topic'), topicIn),
      h('div', { class: 'mq-livebox' }, lamp, liveBtn, liveCnt)),
    h('div', { class: 'mq-barrow mq-bar2' }, topicEx, h('span', { class: 'mq-grow' }), liveMsg,
      h('details', { class: 'mq-login' }, h('summary', {}, 'login, QoS, retain'),
        h('div', { class: 'mq-loginrow' }, userIn, passIn, qosSel, h('label', { class: 'mq-cb' }, retainCb, 'retain')))),
    liveLog);

  // ------------------------------------------------------------ rack + tape
  const rack = h('div', { class: 'mq-rack' });
  const addBtn = h('button', { class: 'k-btn mq-add', onclick: () => {
    const fs = fieldsRaw();
    let n = fs.length + 1; while (fs.some((f) => f.name === `field_${n}`)) n++;
    fs.push({ name: `field_${n}`, kind: 'walk', min: '0', max: '100', extra: '2', decimals: '1' });
    ctx.set('fields', fs);
  } }, '+ Add field');
  const axis = h('div', { class: 'mq-axis' });
  const tape = h('div', { class: 'mq-tape', tabindex: '0', role: 'grid', 'aria-label': 'Messages: device by step. Arrow keys move, the message opens at the side.' });
  const tapeHead = h('div', { class: 'mq-h' }, 'Messages');
  const tapeNote = h('span', { class: 'mq-soft mq-small' });
  const main = h('section', { class: 'mq-panel mq-main' },
    h('div', { class: 'mq-head' }, h('span', { class: 'mq-h' }, 'Channels'), h('span', { class: 'mq-soft mq-small' }, 'one line per device · drag the min / max handles · click a column to open that message'), h('span', { class: 'mq-grow' }), addBtn),
    rack, axis,
    h('div', { class: 'mq-head mq-tapehead' }, tapeHead, tapeNote), tape);

  // ------------------------------------------------------------ fleet + inspector
  const devN = h('input', { type: 'text', inputmode: 'numeric', class: 'mq-in mq-num', 'aria-label': 'Devices', onchange: (e) => ctx.set('devices', e.target.value) });
  const step = (key, d, lo, hi) => { const v = Math.round(parseFloat(ctx.raw[key]) || 0) + d; ctx.set(key, String(Math.max(lo, Math.min(hi, v)))); };
  const prefixIn = h('input', { type: 'text', class: 'mq-in mq-pre', spellcheck: 'false', 'aria-label': 'Device id prefix', onchange: (e) => ctx.set('prefix', e.target.value) });
  const devChips = h('div', { class: 'mq-devs', role: 'listbox', 'aria-label': 'Devices: pick one to follow' });
  const intIn = h('input', { type: 'text', inputmode: 'decimal', class: 'mq-in mq-num', 'aria-label': 'Interval, seconds', onchange: (e) => ctx.set('interval', e.target.value) });
  const cntIn = h('input', { type: 'text', inputmode: 'numeric', class: 'mq-in mq-num', 'aria-label': 'Preview steps', onchange: (e) => ctx.set('count', e.target.value) });
  const seedIn = h('input', { type: 'text', inputmode: 'numeric', class: 'mq-in mq-num', 'aria-label': 'Seed', onchange: (e) => ctx.set('seed', e.target.value) });
  const startIn = h('input', { type: 'text', class: 'mq-in mq-start', spellcheck: 'false', 'aria-label': 'Preview start (UTC)', onchange: (e) => ctx.set('start', e.target.value) });
  const fmtSeg = h('span', { class: 'mq-seg', role: 'group', 'aria-label': 'Payload format' },
    [['json', 'JSON'], ['influx', 'Line protocol']].map(([v, t]) => h('button', { 'data-v': v, 'aria-pressed': 'false', onclick: () => ctx.set('format', v) }, t)));
  const measIn = h('input', { type: 'text', class: 'mq-in mq-pre', spellcheck: 'false', 'aria-label': 'Measurement', onchange: (e) => ctx.set('measurement', e.target.value) });
  const measBox = h('label', { class: 'mq-lbl' }, h('span', {}, 'measurement'), measIn);
  const tsCb = h('input', { type: 'checkbox', onchange: (e) => ctx.set('with_ts', e.target.checked) });
  const stats = h('div', { class: 'mq-stats' });
  const fleet = h('section', { class: 'mq-panel mq-fleet' },
    h('div', { class: 'mq-head' }, h('span', { class: 'mq-h' }, 'Fleet')),
    h('div', { class: 'mq-frow' },
      h('span', { class: 'mq-stepper' }, h('button', { class: 'k-btn', 'aria-label': 'One device less', onclick: () => step('devices', -1, 1, 200) }, '−'), devN,
        h('button', { class: 'k-btn', 'aria-label': 'One device more', onclick: () => step('devices', 1, 1, 200) }, '+')),
      h('span', { class: 'mq-soft' }, 'devices named'), prefixIn, h('span', { class: 'mq-soft mq-mono' }, '-01')),
    devChips,
    h('div', { class: 'mq-frow' },
      h('label', { class: 'mq-lbl' }, h('span', {}, 'every'), intIn, h('span', { class: 'mq-soft' }, 's')),
      h('label', { class: 'mq-lbl' }, h('span', {}, 'preview'), cntIn, h('span', { class: 'mq-soft' }, 'steps')),
      h('label', { class: 'mq-lbl' }, h('span', {}, 'seed'), seedIn),
      h('button', { class: 'k-btn mq-dice', title: 'New seed: a different, still repeatable, run', onclick: () => ctx.set('seed', String(1 + Math.floor(Math.random() * 9999))) }, 'new seed')),
    h('div', { class: 'mq-frow' }, h('label', { class: 'mq-lbl' }, h('span', {}, 'from'), startIn, h('span', { class: 'mq-soft' }, 'UTC'))),
    h('div', { class: 'mq-frow' }, fmtSeg, measBox, h('label', { class: 'mq-cb' }, tsCb, 'ts key')),
    stats);
  const insHead = h('div', { class: 'mq-inshead' });
  const insBody = h('pre', { class: 'mq-payload' });
  const inspector = h('section', { class: 'mq-panel mq-ins' }, h('div', { class: 'mq-head' }, h('span', { class: 'mq-h' }, 'Message'), insHead), insBody);
  const warnBox = h('div', { class: 'mq-warn', 'aria-live': 'polite' });
  const side = h('div', { class: 'mq-side' }, fleet, inspector, ctx.outputs);
  root.append(h('div', { class: 'mq-page' }, bar, h('div', { class: 'mq-body' }, h('div', { class: 'mq-left' }, warnBox, main), side)));

  // ------------------------------------------------------------ live publish
  function drawLive() {
    const running = S.state !== 'idle';
    lamp.className = `mq-lamp is-${S.state}`;
    liveBtn.textContent = running ? 'Stop' : 'Connect and publish';
    liveBtn.classList.toggle('k-primary', !running);
    liveBtn.disabled = !served;
    liveBtn.title = served ? '' : 'Open this tool in the app to publish live.';
    liveMsg.textContent = served ? (S.msg || 'Not connected. Live messages use this preview\'s generators, stamped with the real time.') : 'Live publishing works when the tool is opened in the app; the preview and the script work here.';
    liveMsg.className = `mq-small ${S.state === 'running' ? 'mq-ok' : 'mq-soft'}`;
    liveCnt.textContent = `sent ${S.sent} · back ${S.got}`;
    liveLog.textContent = S.log.slice(0, 3).join('\n');
    liveLog.hidden = !S.log.length;
  }
  liveBtn.addEventListener('click', () => {
    if (S.state !== 'idle') { stop('Stopped.'); flush({ set: ctx.set }); } else start(ctx.input, ctx.raw, { set: ctx.set });
    drawLive();
  });
  S.redraw = () => { if (liveBtn.isConnected) drawLive(); };

  // ------------------------------------------------------------ geometry shared by channels and tape
  const geo = () => {
    const W = Math.max(280, rack.clientWidth || 700);
    const L = 64, R = 12;
    const n = Math.max(1, ctx.result?.series?.t.length || 1);
    const cw = (W - L - R) / n;
    return { W, L, R, n, cw, X: (k) => L + cw * (k + 0.5) };
  };

  // ------------------------------------------------------------ one channel
  function channel(f, i, fr, g, series) {
    const T = 10, B = 8;
    const nOpts = f.kind === 'enum' ? Math.max(1, String(fr.extra || '').split('|').filter((x) => x.trim()).length) : 0;
    const PH = f.kind === 'bool' ? 58 : f.kind === 'enum' ? Math.max(52, nOpts * 17 + T + B) : 80;
    const dec = decOf(fr);
    const isNum = ['walk', 'sine', 'random', 'counter'].includes(f.kind);
    const shown = series.shown;
    // y domain: the range with a margin, frozen while its handle is dragged
    let dom = st.drag && st.drag.i === i ? st.dom.get(i) : null;
    if (!dom) {
      if (f.kind === 'bool') dom = { lo: -0.08, hi: 1.08 };
      else if (f.kind === 'enum') dom = { lo: 0, hi: 1 };
      else { const span = (f.hi - f.lo) || Math.abs(f.hi) || 1; dom = { lo: f.lo - span * 0.22, hi: f.hi + span * 0.22 }; }
      st.dom.set(i, dom);
    }
    const Y = (v) => T + (1 - (v - dom.lo) / (dom.hi - dom.lo)) * (PH - T - B);
    const svg = sv('svg', { class: 'mq-plot', viewBox: `0 0 ${g.W} ${PH}`, width: g.W, height: PH, 'data-ph': PH });
    // step columns (click opens that message)
    for (let k = 0; k < g.n; k++) {
      svg.append(sv('rect', { x: g.L + g.cw * k, y: 0, width: g.cw, height: PH, class: `col${k === st.step ? ' is-cur' : ''}`, 'data-k': k }));
    }
    const opts = f.kind === 'enum' ? (String(fr.extra || '').split('|').map((s) => s.trim()).filter(Boolean)) : [];
    if (isNum) {
      svg.append(sv('rect', { x: g.L, y: Y(f.hi), width: g.W - g.L - g.R, height: Math.max(1, Y(f.lo) - Y(f.hi)), class: 'band' }));
    }
    // traces, the followed device last (on top)
    const order = [...Array(shown).keys()].filter((d) => d !== st.dev).concat(st.dev < shown ? [st.dev] : []);
    for (const d of order) {
      const vals = f.v[d] || [];
      const cur = d === st.dev;
      const cls = `tr d${d % DEVCOLS}${cur ? ' is-cur' : ''}`;
      let path = '';
      vals.forEach((v, k) => {
        let y;
        if (f.kind === 'bool') y = Y(v ? 1 : 0);
        else if (f.kind === 'enum') { const j = Math.max(0, opts.indexOf(v)); y = T + (j + 0.5) * ((PH - T - B) / Math.max(1, opts.length)); }
        else y = Y(Number(v));
        const x = g.X(k);
        if (f.kind === 'bool' || f.kind === 'enum') path += k ? `H${x - g.cw / 2}V${y}H${x}` : `M${g.L} ${y}H${x}`;
        else path += `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
        if (f.kind === 'bool' || f.kind === 'enum') { if (k === vals.length - 1) path += `H${g.W - g.R}`; }
      });
      if (path) svg.append(sv('path', { d: path, class: cls }));
      if (cur && g.cw >= 14) vals.forEach((v, k) => {
        if (f.kind === 'bool' || f.kind === 'enum') return;
        svg.append(sv('circle', { cx: g.X(k), cy: Y(Number(v)), r: 2.6, class: `pt d${d % DEVCOLS}` }));
      });
    }
    // enum lanes
    if (f.kind === 'enum') opts.forEach((o, j) => {
      const y = T + (j + 0.5) * ((PH - T - B) / Math.max(1, opts.length));
      svg.append(sv('text', { x: g.L - 6, y: y + 3.5, class: 'ylab', 'text-anchor': 'end' }, o));
    });
    if (f.kind === 'bool') { svg.append(sv('text', { x: g.W - g.R - 2, y: Y(1) - 4, class: 'ylab', 'text-anchor': 'end' }, 'true')); svg.append(sv('text', { x: g.W - g.R - 2, y: Y(0) - 4, class: 'ylab', 'text-anchor': 'end' }, 'false')); }
    // the followed device's value at the open step, on the drawing
    const cv = f.v[st.dev]?.[st.step];
    if (cv !== undefined) {
      const x = g.X(st.step);
      let y = f.kind === 'bool' ? Y(cv ? 1 : 0) : f.kind === 'enum' ? T + (Math.max(0, opts.indexOf(cv)) + 0.5) * ((PH - T - B) / Math.max(1, opts.length)) : Y(Number(cv));
      svg.append(sv('circle', { cx: x, cy: y, r: 4.5, class: `pt cur d${st.dev % DEVCOLS}` }));
      const lab = fmtV(cv, dec);
      const right = x + 8 + lab.length * 7 < g.W - g.R;
      svg.append(sv('text', { x: right ? x + 8 : x - 8, y: Math.max(12, Math.min(PH - 4, y - 6)), class: 'vlab', 'text-anchor': right ? 'start' : 'end' }, lab));
    }
    // range handles (numbers: min and max; bool: p)
    const handles = [];
    if (isNum) handles.push({ key: 'max', v: f.hi }, { key: 'min', v: f.lo });
    if (f.kind === 'bool') handles.push({ key: 'min', v: Math.min(1, Math.max(0, parseFloat(fr.min) || 0)), p: true });
    for (const hd of handles) {
      const y = Y(hd.v);
      const g2 = sv('g', { class: 'hnd', tabindex: '0', role: 'slider', 'data-i': i, 'data-key': hd.key,
        'aria-label': `${f.name} ${hd.p ? 'probability of true' : hd.key}`, 'aria-valuenow': hd.v });
      g2.append(sv('line', { x1: g.L, x2: g.W - g.R, y1: y, y2: y, class: `hl${hd.p ? ' is-p' : ''}` }));
      g2.append(sv('rect', { x: 2, y: y - 9, width: g.L - 8, height: 18, rx: 3, class: 'hb' }));
      g2.append(sv('text', { x: g.L - 10, y: y + 4, class: 'ht', 'text-anchor': 'end' }, hd.p ? `p ${fmtV(hd.v, 2)}` : fmtV(hd.v, dec)));
      g2.append(sv('rect', { x: g.L - 6, y: y - 4, width: 8, height: 8, rx: 2, class: 'hk' }));
      svg.append(g2);
    }
    // controls of the channel
    const nameIn = h('input', { type: 'text', class: 'mq-in mq-fname', value: fr.name ?? '', spellcheck: 'false', 'aria-label': 'Field name', onchange: (e) => setField(i, { name: e.target.value }) });
    const kindSel = h('select', { class: 'mq-in mq-kind', 'aria-label': `${f.name} kind`, onchange: (e) => {
      const k = e.target.value; const patch = { kind: k };
      if (k === 'bool') Object.assign(patch, { min: '0.2', max: '', extra: '', decimals: '0' });
      else if (k === 'enum') Object.assign(patch, { min: '', max: '', extra: 'ok|warn|fault', decimals: '0' });
      else if (['bool', 'enum'].includes(fr.kind)) Object.assign(patch, { min: '0', max: '100', extra: k === 'sine' ? '3600' : k === 'counter' ? '1' : '2', decimals: '1' });
      else if (k === 'sine' && !(parseFloat(fr.extra) > 10)) patch.extra = '3600';
      setField(i, patch);
    } }, KINDS.map((k) => h('option', { value: k, selected: k === f.kind }, k)));
    const [exLab, exTip] = EXTRA[f.kind] || ['', ''];
    const exIn = exLab ? h('label', { class: 'mq-lbl mq-ex', title: exTip }, h('span', {}, exLab),
      h('input', { type: 'text', class: `mq-in ${f.kind === 'enum' ? 'mq-opts' : 'mq-num'}`, value: fr.extra ?? '', spellcheck: 'false', 'aria-label': `${f.name} ${exLab}`, onchange: (e) => setField(i, { extra: e.target.value }) })) : null;
    const decIn = isNum ? h('label', { class: 'mq-lbl', title: 'decimals' }, h('span', {}, '.0'),
      h('input', { type: 'text', inputmode: 'numeric', class: 'mq-in mq-dec', value: fr.decimals ?? '', 'aria-label': `${f.name} decimals`, onchange: (e) => setField(i, { decimals: e.target.value }) })) : null;
    const del = h('button', { class: 'mq-del', title: `Remove ${f.name}`, 'aria-label': `Remove ${f.name}`, onclick: () => { const j = rawIndex(i); if (j < 0) return; const fs = fieldsRaw(); fs.splice(j, 1); ctx.set('fields', fs); } }, '×');
    const plotWrap = h('div', { class: 'mq-plotwrap', 'data-i': i }, svg);
    return h('div', { class: `mq-ch${st.hoverField === f.name ? ' is-hl' : ''}`, 'data-name': f.name },
      h('div', { class: 'mq-chead' }, nameIn, kindSel, exIn, decIn, h('span', { class: 'mq-grow' }),
        isNum ? h('span', { class: 'mq-soft mq-small mq-mono' }, `${fmtV(f.lo, dec)} … ${fmtV(f.hi, dec)}`) : null, del),
      plotWrap);
  }

  // ------------------------------------------------------------ handle dragging (on the rack, which outlives redraws)
  const plotVal = (i, clientY) => {
    const wrap = rack.querySelector(`.mq-plotwrap[data-i="${i}"] svg`);
    const dom = st.dom.get(i);
    if (!wrap || !dom) return null;
    const r = wrap.getBoundingClientRect();
    const PH = Number(wrap.dataset.ph) || 80, T = 10, B = 8;
    const y = ((clientY - r.top) / r.height) * PH;
    return dom.lo + (1 - (y - T) / (PH - T - B)) * (dom.hi - dom.lo);
  };
  function applyHandle(i, key, v) {
    const fr = fieldsRaw()[rawIndex(i)];
    const s = ctx.result?.series?.fields[i];
    if (!fr || !s) return;
    if (fr.kind === 'bool') { setField(i, { min: String(Math.round(Math.min(1, Math.max(0, v)) * 100) / 100) }); return; }
    const dec = decOf(fr);
    let x = Number(v.toFixed(dec));
    if (key === 'max' && x <= s.lo) x = Number((s.lo + 10 ** -dec).toFixed(dec));
    if (key === 'min' && x >= s.hi) x = Number((s.hi - 10 ** -dec).toFixed(dec));
    setField(i, { [key]: String(x) });
  }
  rack.addEventListener('pointerdown', (e) => {
    const hd = e.target.closest('.hnd');
    if (hd) {
      e.preventDefault();
      st.drag = { i: Number(hd.dataset.i), key: hd.dataset.key };
      rack.setPointerCapture(e.pointerId);
      return;
    }
    const col = e.target.closest('rect.col');
    if (col) { st.step = Number(col.dataset.k); drawAll(); }
  });
  rack.addEventListener('pointermove', (e) => {
    if (!st.drag) return;
    const v = plotVal(st.drag.i, e.clientY);
    if (v != null) applyHandle(st.drag.i, st.drag.key, v);
  });
  const endDrag = () => { if (st.drag) { const d = st.drag; st.drag = null; st.refocus = d; drawAll(); } };
  rack.addEventListener('pointerup', endDrag);
  rack.addEventListener('pointercancel', endDrag);
  rack.addEventListener('keydown', (e) => {
    const hd = e.target.closest?.('.hnd');
    if (!hd || !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) return;
    e.preventDefault();
    const i = Number(hd.dataset.i), key = hd.dataset.key;
    const s = ctx.result?.series?.fields[i];
    const fr = fieldsRaw()[rawIndex(i)];
    if (!s || !fr) return;
    const cur = fr.kind === 'bool' ? parseFloat(fr.min) || 0 : key === 'max' ? s.hi : s.lo;
    const span = fr.kind === 'bool' ? 1 : (s.hi - s.lo) || 1;
    const stp = Math.max(10 ** -decOf(fr), span * (e.key.startsWith('Page') ? 0.1 : 0.01)) * (e.key.endsWith('Up') ? 1 : -1);
    st.refocus = { i, key };
    applyHandle(i, key, cur + stp);
  });

  // ------------------------------------------------------------ tape
  function drawTape(series, g) {
    tape.replaceChildren();
    const rows = series.shown;
    const RH = rows > 10 ? 12 : 18;
    const H = rows * RH + 4;
    const svg = sv('svg', { class: 'mq-tapesvg', viewBox: `0 0 ${g.W} ${H}`, width: g.W, height: H });
    for (let d = 0; d < rows; d++) {
      const y = 2 + d * RH;
      svg.append(sv('text', { x: g.L - 6, y: y + RH / 2 + 3.5, class: `ylab${d === st.dev ? ' is-cur' : ''}`, 'text-anchor': 'end' }, series.ids[d]));
      for (let k = 0; k < g.n; k++) {
        const cur = d === st.dev && k === st.step;
        svg.append(sv('rect', { x: g.L + g.cw * k + 1, y: y + 1, width: Math.max(1, g.cw - 2), height: RH - 2, rx: 2,
          class: `cell d${d % DEVCOLS}${d === st.dev ? ' is-dev' : ''}${k === st.step ? ' is-step' : ''}${cur ? ' is-cur' : ''}`, 'data-d': d, 'data-k': k }));
      }
    }
    tape.append(svg);
    tapeNote.textContent = `${series.t.length} steps × ${series.devices} devices${series.devices > series.shown ? ` (first ${series.shown} drawn; all are in the texts)` : ''}`;
  }
  tape.addEventListener('click', (e) => {
    const c = e.target.closest('rect.cell');
    if (!c) return;
    st.dev = Number(c.dataset.d); st.step = Number(c.dataset.k);
    drawAll();
    tape.focus({ preventScroll: true });
  });
  tape.addEventListener('keydown', (e) => {
    const s = ctx.result?.series;
    if (!s) return;
    const mv = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    if (!mv) return;
    e.preventDefault();
    st.dev = Math.max(0, Math.min(s.shown - 1, st.dev + mv[0]));
    st.step = Math.max(0, Math.min(s.t.length - 1, st.step + mv[1]));
    drawAll();
  });

  function drawAxis(series, g) {
    axis.replaceChildren();
    const svg = sv('svg', { viewBox: `0 0 ${g.W} 20`, width: g.W, height: 20, class: 'mq-axsvg' });
    const every = Math.max(1, Math.ceil(64 / g.cw));
    for (let k = 0; k < g.n; k += every) {
      svg.append(sv('text', { x: g.X(k), y: 13, class: `xlab${k === st.step ? ' is-cur' : ''}`, 'text-anchor': 'middle' }, series.t[k].slice(11, 19)));
    }
    if (st.step % every) svg.append(sv('text', { x: g.X(st.step), y: 13, class: 'xlab is-cur', 'text-anchor': 'middle' }, series.t[st.step].slice(11, 19)));
    axis.append(svg);
  }

  // ------------------------------------------------------------ inspector
  function drawInspector(series) {
    const d = st.dev, k = st.step;
    const pl = series.payloads[d]?.[k];
    insHead.replaceChildren(
      h('span', { class: `mq-dev d${d % DEVCOLS}` }, h('i'), series.ids[d] || ''),
      h('span', { class: 'mq-soft mq-mono mq-small' }, `step ${k + 1} · ${series.t[k] || ''}`));
    insBody.replaceChildren();
    if (pl == null) return;
    const topic = h('div', { class: 'mq-itopic' }, series.topics[d]);
    let body;
    if (ctx.input.format === 'influx') body = h('div', { class: 'mq-iline' }, pl);
    else {
      body = h('div', {});
      try {
        const obj = JSON.parse(pl);
        body.append('{\n');
        const ks = Object.keys(obj);
        ks.forEach((key, j) => {
          const line = h('span', { class: `mq-kv${st.hoverField === key ? ' is-hl' : ''}`, 'data-key': key,
            onmouseenter: () => { st.hoverField = key; hl(); }, onmouseleave: () => { st.hoverField = null; hl(); } },
          `  ${JSON.stringify(key)}: `, h('b', {}, JSON.stringify(obj[key])), j < ks.length - 1 ? ',' : '');
          body.append(line, '\n');
        });
        body.append('}');
      } catch { body.append(pl); }
    }
    insBody.append(topic, body, h('div', { class: 'mq-soft mq-small mq-isize' }, `${new TextEncoder().encode(pl).length + new TextEncoder().encode(series.topics[d]).length} bytes, topic + payload`));
  }
  function hl() {
    for (const c of rack.querySelectorAll('.mq-ch')) c.classList.toggle('is-hl', c.dataset.name === st.hoverField);
    for (const c of insBody.querySelectorAll('.mq-kv')) c.classList.toggle('is-hl', c.dataset.key === st.hoverField);
  }
  rack.addEventListener('mouseover', (e) => { const c = e.target.closest('.mq-ch'); const n = c?.dataset.name || null; if (n !== st.hoverField) { st.hoverField = n; hl(); } });
  rack.addEventListener('mouseleave', () => { st.hoverField = null; hl(); });

  // ------------------------------------------------------------ all
  function drawAll() {
    const res = ctx.result;
    const series = res?.series;
    if (!series) { rack.replaceChildren(h('div', { class: 'mq-soft mq-empty' }, 'Nothing to draw: see the message above.')); tape.replaceChildren(); axis.replaceChildren(); return; }
    st.dev = Math.min(st.dev, series.shown - 1);
    st.step = Math.min(st.step, series.t.length - 1);
    const g = geo();
    const fr = fieldsRaw().filter((f) => String(f.name || '').trim());
    rack.replaceChildren(...series.fields.map((f, i) => channel(f, i, fr[i] || {}, g, series)));
    if (!series.fields.length) rack.append(h('div', { class: 'mq-soft mq-empty' }, 'No fields yet: add one.'));
    drawAxis(series, g);
    drawTape(series, g);
    drawInspector(series);
    devChips.replaceChildren(...series.ids.map((id, d) => h('button', { class: `mq-dev d${d % DEVCOLS}`, role: 'option', 'aria-selected': String(d === st.dev),
      onclick: () => { st.dev = d; drawAll(); } }, h('i'), id)),
    ...(series.devices > series.shown ? [h('span', { class: 'mq-soft mq-small' }, `+${series.devices - series.shown} more`)] : []));
    if (st.refocus) {
      const { i, key } = st.refocus; st.refocus = null;
      rack.querySelector(`.hnd[data-i="${i}"][data-key="${key}"]`)?.focus({ preventScroll: true });
    }
  }

  new ResizeObserver(() => { if (!st.drag && ctx.result?.series) drawAll(); }).observe(rack);

  // ------------------------------------------------------------ result in
  const sync = (el, v) => { if (document.activeElement !== el && el.value !== String(v ?? '')) el.value = String(v ?? ''); };
  ctx.onResult((res) => {
    const raw = ctx.raw;
    sync(brokerIn, raw.broker); sync(topicIn, raw.topic); sync(devN, raw.devices); sync(prefixIn, raw.prefix);
    sync(intIn, raw.interval); sync(cntIn, raw.count); sync(seedIn, raw.seed); sync(startIn, raw.start); sync(measIn, raw.measurement);
    sync(userIn, raw.username); sync(passIn, raw.password); qosSel.value = String(raw.qos ?? '0');
    retainCb.checked = !!raw.retain; tsCb.checked = raw.with_ts !== false;
    for (const b of fmtSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String((raw.format || 'json') === b.dataset.v));
    measBox.hidden = raw.format !== 'influx';
    const s = res.series;
    topicEx.textContent = s ? `→ ${s.topics[Math.min(st.dev, s.shown - 1)]}` : '';
    warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    stats.replaceChildren(...(res.values || []).map((v) => h('div', { class: 'mq-stat' },
      h('span', { class: 'mq-soft' }, v.label), h('b', {}, `${v.value}${v.unit ? ` ${v.unit}` : ''}`), v.hint ? h('em', {}, v.hint) : null)));
    drawAll();
    drawLive();
    if (!st.tabDone) {
      st.tabDone = true;
      let picked = null;
      try { picked = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
      if (!picked) [...ctx.outputs.querySelectorAll('.k-tab')].find((b) => b.textContent === 'Messages')?.click();
    }
  });
}
