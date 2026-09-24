// Live publishing: a minimal MQTT 3.1.1 client over WebSocket (subprotocol
// "mqtt"), enough for CONNECT, PUBLISH (QoS 0), SUBSCRIBE (to see our own
// messages come back), PINGREQ and DISCONNECT - packet layouts from OASIS MQTT
// 3.1.1 section 3. Messages come from the same generators as run(), stamped
// with the real time. On Stop, what came back is written into "Received".
import { makeDevice, topicFor, encode } from './tool.js';

const S = { ws: null, state: 'idle', msg: '', sent: 0, got: 0, log: [], rec: [], timer: null, ping: null, gens: null, cfg: null, redraw: null };
const MAX_REC = 400;

const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};

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

export function view(el, result, input, api) {
  const served = /^https?:/.test(location.protocol);
  const draw = () => {
    const running = S.state !== 'idle';
    el.replaceChildren($('div', { class: 'k-block' },
      $('div', { class: 'k-title' }, 'Live publish'),
      !served
        ? $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app to publish live. The preview, the Messages text and the mosquitto_pub script work here too.')
        : $('div', {},
          $('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
            running
              ? $('button', { class: 'k-btn', onclick: () => { stop('Stopped.'); flush(api); draw(); } }, 'Stop')
              : $('button', { class: 'k-btn k-primary', onclick: () => { start(input, api.raw, api); draw(); } }, 'Connect and publish'),
            $('span', { style: `font-size:12px;color:var(${S.state === 'running' ? '--ok' : '--ink-soft'})`, role: 'status' }, S.msg || 'Not connected.'),
            $('span', { style: 'margin-left:auto;font-size:12px;font-family:IBM Plex Mono,ui-monospace,monospace' }, `sent ${S.sent} · back ${S.got}`)),
          S.log.length ? $('pre', { style: 'margin:8px 0 0;font-size:11px;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--ink-soft)' }, S.log.join('\n')) : null,
          $('div', { style: 'font-size:11px;color:var(--ink-soft);margin-top:6px' }, 'QoS 0 from the browser. The page subscribes to the same topics (with + for {device}) to count what the broker delivers; Stop writes those messages into Received.'))));
  };
  S.redraw = () => { if (el.isConnected) draw(); };
  draw();
}
