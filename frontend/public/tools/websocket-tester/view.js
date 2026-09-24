// The live half: opens the socket from this page, sends the messages, and
// keeps a timestamped transcript. The transcript is written into the
// Transcript input (api.set) a moment after the traffic settles and on close,
// so run() - and the Prompt/JSON - report on what really happened.
import { outgoing, checkUrl, CLOSE } from './tool.js';

const S = { ws: null, log: [], state: 'closed', msg: '', timer: null, redraw: null, api: null };

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

const text = (d) => (typeof d === 'string' ? d : d instanceof ArrayBuffer ? `[binary ${d.byteLength} B]` : d instanceof Blob ? `[binary ${d.size} B]` : String(d));
const oneLine = (s) => s.replace(/\r?\n/g, '\\n');

function add(dir, t) {
  S.log.push(`${new Date().toISOString()} ${dir} ${oneLine(t)}`);
  if (S.log.length > 500) S.log.shift();
  S.redraw?.();
  // Write the transcript into the form once things are quiet.
  clearTimeout(S.timer);
  S.timer = setTimeout(() => S.api?.set('transcript', S.log.join('\n')), 900);
}

function connect(raw) {
  const url = String(raw.url || '').trim();
  const { problems } = checkUrl(url);
  if (problems.length) { S.msg = problems[0]; return; }
  if (location.protocol === 'https:' && /^ws:/i.test(url)) { S.msg = 'This page is https, so the browser blocks ws:// (mixed content). Use wss://, or open the app over http.'; return; }
  S.log = [];
  const protos = String(raw.protocols || '').split(',').map((s) => s.trim()).filter(Boolean);
  add('**', `connect ${url}${protos.length ? ` protocols=${protos.join(',')}` : ''}`);
  let ws;
  try { ws = protos.length ? new WebSocket(url, protos) : new WebSocket(url); } catch (e) { add('**', `error ${e.message}`); S.msg = e.message; return; }
  S.ws = ws; S.state = 'connecting'; S.msg = 'Connecting…';
  ws.onopen = () => { S.state = 'open'; S.msg = `Open${ws.protocol ? `, subprotocol ${ws.protocol}` : ''}.`; add('**', `open${ws.protocol ? ` protocol=${ws.protocol}` : ''}`); };
  ws.onmessage = (e) => add('<-', text(e.data));
  ws.onerror = () => { S.msg = 'Error: the browser gives no detail for WebSocket errors - see the close code below.'; };
  ws.onclose = (e) => {
    S.state = 'closed';
    S.msg = `Closed ${e.code}${CLOSE[e.code] ? ` (${CLOSE[e.code]})` : ''}${e.reason ? `: ${e.reason}` : ''}.`;
    if (S.ws === ws) S.ws = null;
    add('**', `close ${e.code}${e.reason ? ` ${e.reason}` : ''}${e.wasClean ? '' : ' unclean'}`);
  };
}

function sendAll(raw) {
  if (!S.ws || S.ws.readyState !== 1) { S.msg = 'Not open: connect first.'; return; }
  const msgs = outgoing(raw);
  if (!msgs.length) { S.msg = 'Nothing to send: write messages, one per line.'; return; }
  for (const m of msgs) { S.ws.send(m); add('->', m); }
}

export function view(el, result, input, api) {
  S.api = api;
  const served = /^https?:/.test(location.protocol);
  const draw = () => {
    const open = S.state === 'open';
    el.replaceChildren($('div', { class: 'k-block' },
      $('div', { class: 'k-title' }, 'Live socket'),
      !served ? $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app (or any http page) to connect. Here you can still paste a transcript to have it read.') : null,
      $('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
        S.state === 'closed'
          ? $('button', { class: 'k-btn k-primary', onclick: () => { connect(api.raw); draw(); } }, 'Connect')
          : $('button', { class: 'k-btn', onclick: () => { try { S.ws?.close(1000, 'done'); S.msg = 'Closing… (waiting for the server\'s close frame)'; draw(); } catch { /* already closing */ } } }, 'Close'),
        $('button', { class: 'k-btn', disabled: !open, onclick: () => { sendAll(api.raw); draw(); } }, `Send ${outgoing(api.raw).length} message(s)`),
        $('button', { class: 'k-btn', disabled: !S.log.length, onclick: () => { S.log = []; clearTimeout(S.timer); api.set('transcript', ''); } }, 'Clear'),
        $('span', { style: `font-size:12px;color:var(${open ? '--ok' : /Closed 1000|^$/.test(S.msg) ? '--ink-soft' : S.state === 'connecting' ? '--ink-soft' : '--warn'})`, role: 'status' }, S.msg || 'Not connected.')),
      S.log.length ? $('pre', { style: 'margin:8px 0 0;font-size:11px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-all' },
        S.log.slice(-40).map((l) => l.replace(/^\d{4}-\d\d-\d\dT([\d:.]+)Z/, '$1')).join('\n')) : null));
  };
  S.redraw = () => { if (el.isConnected) draw(); };
  draw();
}
