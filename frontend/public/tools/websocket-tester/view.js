// WebSocket Echo Tester page: the session is drawn as a sequence diagram.
//   Socket    - the URL in its parts, subprotocols, Connect / Close.
//   Outbox    - the messages to send, one card each with its frame size and
//               a Send button; type a new one at the bottom.
//   Session   - this page and the server as two lifelines, time running down:
//               the handshake as a band, each message as an arrow across,
//               each echo drawn back with its round trip bracketed on the
//               right, long pauses folded, the close with its code. Before a
//               session it shows the planned one, dashed. Click a row (or use
//               the arrow keys) to open its frame.
//   Frame     - the selected message as RFC 6455 puts it on the wire: the two
//               header bytes bit by bit, the length and mask fields, the
//               payload bytes; the upgrade request for a connect, the close
//               frame for a close.
// The live half opens the socket from this page and writes the transcript
// into the Transcript input, so run() - and the Prompt / JSON - read what
// really happened. Every number shown comes from run()'s result.
import { CLOSE } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
// append / replaceChildren would write a null as the text "null".
const clean = (a) => a.flat(Infinity).filter((x) => x != null && x !== false);
const put = (el, ...kids) => el.append(...clean(kids));
const reset = (el, ...kids) => el.replaceChildren(...clean(kids));
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
const fmtMs = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);
const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const OPCODES = { 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };

// ---------------- the live socket (lives as long as the page) ----------------
const S = { ws: null, log: [], state: 'closed', msg: '', timer: null };
const oneLine = (s) => s.replace(/\r?\n/g, '\\n');
const dataText = (d) => (typeof d === 'string' ? d : d instanceof ArrayBuffer ? `[binary ${d.byteLength} B]` : d instanceof Blob ? `[binary ${d.size} B]` : String(d));

export function page(root, ctx) {
  const f = ctx.fmtNum;
  const byKey = Object.fromEntries(ctx.manifest.inputs.map((d) => [d.key, d]));
  let res = null, D = null, rows = [], selI = null;

  // ---------------- live ----------------
  const flush = () => { clearTimeout(S.timer); S.timer = setTimeout(() => ctx.set('transcript', S.log.join('\n')), 120); };
  const add = (dir, t) => {
    S.log.push(`${new Date().toISOString()} ${dir} ${oneLine(t)}`);
    if (S.log.length > 500) S.log.shift();
    flush(); drawSocket();
  };
  const connect = () => {
    const raw = ctx.raw;
    const url = String(raw.url || '').trim();
    if (D && D.url && !D.url.ok) { S.msg = (res.warnings || [])[0] || 'Not a WebSocket URL.'; drawSocket(); return; }
    if (location.protocol === 'https:' && /^ws:/i.test(url)) { S.msg = 'This page is https, so the browser blocks ws:// (mixed content). Use wss://, or open the app over http.'; drawSocket(); return; }
    S.log = [];
    const protos = String(raw.protocols || '').split(',').map((s) => s.trim()).filter(Boolean);
    add('**', `connect ${url}${protos.length ? ` protocols=${protos.join(',')}` : ''}`);
    let ws;
    try { ws = protos.length ? new WebSocket(url, protos) : new WebSocket(url); } catch (e) { add('**', `error ${e.message}`); S.msg = e.message; drawSocket(); return; }
    S.ws = ws; S.state = 'connecting'; S.msg = 'Connecting…';
    ws.onopen = () => { S.state = 'open'; S.msg = `Open${ws.protocol ? `, subprotocol ${ws.protocol}` : ''}.`; add('**', `open${ws.protocol ? ` protocol=${ws.protocol}` : ''}`); };
    ws.onmessage = (e) => add('<-', dataText(e.data));
    ws.onerror = () => { S.msg = 'Error: the browser gives no detail for WebSocket errors; the close code says more.'; drawSocket(); };
    ws.onclose = (e) => {
      S.state = 'closed';
      S.msg = `Closed ${e.code}${CLOSE[e.code] ? ` (${CLOSE[e.code]})` : ''}${e.reason ? `: ${e.reason}` : ''}.`;
      if (S.ws === ws) S.ws = null;
      add('**', `close ${e.code}${e.reason ? ` ${e.reason}` : ''}${e.wasClean ? '' : ' unclean'}`);
    };
    drawSocket();
  };
  const sendOne = (m) => {
    if (!S.ws || S.ws.readyState !== 1) { S.msg = 'Not open: connect first.'; drawSocket(); return; }
    S.ws.send(m); add('->', m);
  };
  const outMsgs = () => (D ? D.outbox.map((o) => o.text) : []);

  // ---------------- socket card ----------------
  const urlInp = h('input', { class: 'ws-in', type: 'text', spellcheck: 'false', 'aria-label': 'WebSocket URL', 'data-key': 'url', oninput: (e) => ctx.set('url', e.target.value) });
  const urlParts = h('div', { class: 'ws-parts', 'aria-label': 'URL parts' });
  const protoInp = h('input', { class: 'ws-in', type: 'text', spellcheck: 'false', 'aria-label': 'Subprotocols', placeholder: byKey.protocols.placeholder, 'data-key': 'protocols', oninput: (e) => ctx.set('protocols', e.target.value) });
  const connBtn = h('button', { class: 'k-btn k-primary ws-conn' });
  const light = h('span', { class: 'ws-light', 'aria-hidden': 'true' });
  const status = h('span', { class: 'ws-status', role: 'status' });
  connBtn.addEventListener('click', () => {
    if (S.state === 'closed') connect();
    else { try { S.ws?.close(1000, 'done'); S.msg = 'Closing… (waiting for the server\'s close frame)'; } catch { /* already closing */ } drawSocket(); }
  });
  const clearBtn = h('button', { class: 'k-btn', title: 'Clear the transcript', onclick: () => { S.log = []; clearTimeout(S.timer); ctx.set('transcript', ''); } }, 'Clear');
  const socketCard = h('section', { class: 'ws-card' },
    h('div', { class: 'ws-head' }, h('h2', {}, 'Socket')),
    h('div', { class: 'ws-pad' }, urlInp, urlParts,
      h('label', { class: 'ws-lab' }, 'Subprotocols', protoInp),
      h('div', { class: 'ws-connrow' }, connBtn, clearBtn, h('span', { class: 'ws-st' }, light, status))));

  // ---------------- outbox ----------------
  const modeSeg = h('div', { class: 'ws-seg', role: 'radiogroup', 'aria-label': 'Send' },
    byKey.mode.options.map(([v, t]) => h('button', { role: 'radio', 'data-v': v, title: t, onclick: () => ctx.set('mode', v) }, v === 'lines' ? 'Each line' : 'Whole text')));
  const outList = h('div', { class: 'ws-outbox' });
  const composer = h('input', { class: 'ws-in', type: 'text', spellcheck: 'false', 'aria-label': 'New message', placeholder: 'New message, Enter to add (and send when open)' });
  composer.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !composer.value.trim()) return;
    e.preventDefault();
    const m = composer.value;
    const cur = String(ctx.raw.messages || '').replace(/\n+$/, '');
    ctx.set('messages', cur ? `${cur}\n${m}` : m);
    composer.value = '';
    if (S.state === 'open') sendOne(m);
  });
  const sendAllBtn = h('button', { class: 'k-btn', onclick: () => { for (const m of outMsgs()) sendOne(m); } });
  const outCard = h('section', { class: 'ws-card' },
    h('div', { class: 'ws-head' }, h('h2', {}, 'Outbox'), modeSeg, sendAllBtn),
    outList, h('div', { class: 'ws-pad ws-compose' }, composer));

  // ---------------- session diagram ----------------
  const seqSvg = sv('svg', { class: 'ws-svg', tabindex: 0, role: 'listbox', 'aria-label': 'Session: pick a row with the up and down arrows' });
  const seqHead = h('div', { class: 'ws-head' });
  const seqBox = h('div', { class: 'ws-seqbox' }, seqSvg);
  const seqCard = h('section', { class: 'ws-card ws-seq' }, seqHead, seqBox,
    h('div', { class: 'ws-help' }, 'Click a row, or focus the diagram and use ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ', to open its frame. Pauses over half a second are folded.'));

  // ---------------- frame ----------------
  const frameHead = h('div', { class: 'ws-head' });
  const frameBody = h('div', { class: 'ws-frame' });
  const frameCard = h('section', { class: 'ws-card' }, frameHead, frameBody);
  const warns = h('div', { class: 'ws-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'ws-notes' });

  // ---------------- transcript ----------------
  const trans = h('textarea', { class: 'ws-trans', rows: 6, spellcheck: 'false', 'aria-label': 'Transcript', placeholder: byKey.transcript.placeholder,
    oninput: (e) => ctx.set('transcript', e.target.value) });
  const exBtn = ctx.manifest.examples?.[0]
    ? h('button', { class: 'k-btn', title: 'Load the example session', onclick: () => ctx.setMany(ctx.manifest.examples[0].input) }, 'Load a sample session') : null;
  const transCard = h('section', { class: 'ws-card' },
    h('div', { class: 'ws-head' }, h('h2', {}, 'Transcript'), h('span', { class: 'ws-sub' }, 'written by a live session, or pasted: time, then -> <- or **, then the text'), exBtn),
    h('div', { class: 'ws-pad' }, trans));

  root.append(h('div', { class: 'ws' },
    h('div', { class: 'ws-cols' },
      h('div', { class: 'ws-left' }, socketCard, outCard),
      seqCard,
      h('div', { class: 'ws-right' }, warns, frameCard, notes)),
    h('div', { class: 'ws-foot' }, transCard, ctx.outputs)));

  // ---------------- drawing: socket + outbox ----------------
  function drawSocket() {
    const open = S.state === 'open';
    connBtn.textContent = S.state === 'closed' ? 'Connect' : S.state === 'connecting' ? 'Cancel' : 'Close';
    connBtn.classList.toggle('k-primary', S.state === 'closed');
    light.dataset.s = S.state;
    status.textContent = S.msg || 'Not connected.';
    status.classList.toggle('warn', /^Error|^Closed 10(0[2-9]|1\d)|blocks|Not open/.test(S.msg));
    const n = outMsgs().length;
    sendAllBtn.textContent = `Send ${n === 1 ? 'it' : `all ${n}`}`;
    sendAllBtn.disabled = !open || !n;
    for (const b of outList.querySelectorAll('.ws-send')) b.disabled = !open;
    clearBtn.disabled = !String(ctx.raw.transcript || '').trim();
  }

  function drawOutbox() {
    const had = outList.contains(document.activeElement) ? document.activeElement.dataset.i : null;
    outList.replaceChildren();
    if (!D) return;
    const whole = ctx.raw.mode === 'whole';
    if (whole) {
      const ta = h('textarea', { class: 'ws-in ws-whole', rows: 5, spellcheck: 'false', 'aria-label': 'The message', 'data-i': 'w',
        oninput: (e) => ctx.set('messages', e.target.value) });
      ta.value = ctx.raw.messages || '';
      const o = D.outbox[0];
      outList.append(h('div', { class: 'ws-msg' }, ta, o ? msgFoot(o, 0) : null));
    } else {
      const lines = String(ctx.raw.messages || '').split(/\r?\n/);
      let oi = 0;
      lines.forEach((line, i) => {
        const o = line.trim() !== '' ? D.outbox[oi++] : null;
        const inp = h('input', { class: 'ws-in', type: 'text', spellcheck: 'false', 'aria-label': `Message ${i + 1}`, 'data-i': String(i) });
        inp.value = line;
        inp.addEventListener('input', () => { const ls = String(ctx.raw.messages || '').split(/\r?\n/); ls[i] = inp.value; ctx.set('messages', ls.join('\n')); });
        const rm = h('button', { class: 'k-btn k-x', title: 'Remove', 'aria-label': `Remove message ${i + 1}`, onclick: () => {
          const ls = String(ctx.raw.messages || '').split(/\r?\n/); ls.splice(i, 1); ctx.set('messages', ls.join('\n'));
        } }, '×');
        outList.append(h('div', { class: `ws-msg${o && o.json === 'bad' ? ' bad' : ''}` }, h('div', { class: 'ws-msgtop' }, h('span', { class: 'ws-n' }, String(i + 1)), inp, rm),
          o ? msgFoot(o, oi - 1) : h('div', { class: 'ws-mfoot' }, h('span', {}, 'empty line: not sent'))));
      });
    }
    if (had != null) outList.querySelector(`[data-i="${had}"]`)?.focus();
    drawSocket();
  }
  const msgFoot = (o, idx) => h('div', { class: 'ws-mfoot' },
    h('span', { title: 'UTF-8 payload' }, h('b', {}, `${o.frame.payload} B`)),
    h('span', { title: 'On the wire: header, mask key and payload' }, `${o.frame.total} B framed`),
    o.json === 'ok' ? h('span', { class: 'ok' }, 'JSON') : o.json === 'bad' ? h('span', { class: 'bad' }, 'broken JSON') : null,
    h('button', { class: 'k-btn ws-plan', title: 'Show its frame', onclick: () => { const r = rows.findIndex((x) => x.planned && x.oi === idx) ; if (r >= 0) select(r); else showFrame({ dir: '->', text: o.text, frame: o.frame, planned: true }); } }, 'Frame'),
    h('button', { class: 'k-btn ws-send', disabled: S.state !== 'open', onclick: () => sendOne(o.text) }, 'Send'));

  // ---------------- drawing: sequence ----------------
  function buildRows() {
    if (D.events.length) return D.events.map((e, i) => ({ ...e, i }));
    // No session yet: the planned one, dashed.
    const r = [{ dir: '**', kind: 'connect', text: `connect ${ctx.raw.url || ''}`.trim(), t: 0, planned: true },
      { dir: '**', kind: 'open', text: 'open', t: 0, planned: true }];
    D.outbox.forEach((o, k) => r.push({ dir: '->', text: o.text, frame: o.frame, planned: true, oi: k, t: 0 }));
    D.outbox.forEach((o, k) => r.push({ dir: '<-', text: o.text, frame: o.echoFrame, planned: true, pair: 2 + k, t: 0 }));
    return r.map((x, i) => ({ ...x, i }));
  }

  function drawSeq() {
    seqSvg.replaceChildren();
    if (!D) return;
    rows = buildRows();
    const planned = !D.events.length;
    const W = Math.max(300, seqBox.clientWidth || 640);
    const narrow = W < 540;
    const tx = narrow ? 42 : 50;                         // time labels end here
    const cx = Math.round(narrow ? W * 0.52 : Math.max(250, W * 0.46));
    const sx = Math.round(narrow ? W - 66 : W - Math.max(118, W * 0.2));
    const labW = cx - tx - 16;
    const top = 58, rowH = 26;
    // Row positions: time to scale where it can be, long pauses folded.
    const ys = [];
    const breaks = [];
    let y = top + 16;
    rows.forEach((r, i) => {
      if (i) {
        const dt = r.t - rows[i - 1].t;
        let gap = planned ? rowH : Math.min(64, Math.max(rowH, dt * 0.35));
        if (!planned && dt > 500) { gap = rowH + 16; breaks.push({ y: y + gap / 2, dt }); }
        y += gap;
      }
      ys.push(y);
    });
    const H = y + 46;
    seqSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    seqSvg.setAttribute('height', H);

    // Handshake band (connect -> open) and closed tail.
    const ci = rows.findIndex((r) => r.kind === 'connect'), oi = rows.findIndex((r) => r.kind === 'open');
    const cl = rows.findIndex((r) => r.kind === 'close');
    if (ci >= 0 && oi > ci) {
      seqSvg.append(sv('rect', { x: cx - 6, y: ys[ci] - 6, width: sx - cx + 12, height: ys[oi] - ys[ci] + 12, rx: 4, class: 'ws-hs' }));
      const lab = planned ? (narrow ? 'handshake' : 'handshake: HTTP Upgrade → 101') : `${narrow ? '' : 'handshake '}${D.handshake != null ? fmtMs(D.handshake) : ''}`;
      seqSvg.append(sv('text', { x: (cx + sx) / 2, y: (ys[ci] + ys[oi]) / 2 + 4, 'text-anchor': 'middle', class: 'ws-hst' }, lab));
    }
    // Lifelines.
    const endY = cl >= 0 ? ys[cl] : H - 30;
    const head = (x, name, sub) => {
      const w = narrow ? 84 : 128;
      seqSvg.append(sv('rect', { x: x - w / 2, y: 8, width: w, height: 38, rx: 4, class: 'ws-lh' }));
      seqSvg.append(sv('text', { x, y: 24, 'text-anchor': 'middle', class: 'ws-lht' }, clip(name, narrow ? 12 : 19)));
      seqSvg.append(sv('text', { x, y: 38, 'text-anchor': 'middle', class: 'ws-lhs' }, clip(sub, narrow ? 13 : 20)));
      seqSvg.append(sv('line', { x1: x, x2: x, y1: 46, y2: endY, class: `ws-life${planned ? ' planned' : ''}` }));
      if (cl >= 0) seqSvg.append(sv('path', { d: `M${x - 5},${endY + 4}l10,10m0,-10l-10,10`, class: 'ws-end' }));
    };
    head(cx, 'this page', planned ? 'not connected' : S.state === 'open' ? 'open' : 'browser');
    const u = D.url || {};
    head(sx, u.host || 'server', u.ok ? `${u.tls ? 'wss' : 'ws'} ${u.port || (u.tls ? 443 : 80)}${u.path && u.path !== '/' ? ' ' + u.path : ''}` : 'invalid URL');
    // Folded pauses.
    for (const b of breaks) {
      for (const x of [cx, sx]) seqSvg.append(sv('path', { d: `M${x - 6},${b.y - 5}l12,4l-12,4l12,4`, class: 'ws-fold' }));
      seqSvg.append(sv('text', { x: tx, y: b.y + 4, 'text-anchor': 'end', class: 'ws-foldt' }, `+${fmtMs(b.dt)}`));
    }

    // Round-trip brackets on the right, stacked so they do not overlap.
    const lanes = [];
    const brackets = [];
    rows.forEach((r, i) => {
      if (r.dir !== '<-' || r.pair == null) return;
      const a = ys[r.pair], b = ys[i];
      let lane = lanes.findIndex((end) => end < a - 2);
      if (lane < 0) { lane = lanes.length; lanes.push(b); } else lanes[lane] = b;
      brackets.push({ a, b, lane, r });
    });

    // Rows.
    const rowG = sv('g');
    rows.forEach((r, i) => {
      const yy = ys[i];
      const on = i === selI;
      const g = sv('g', { class: `ws-row ${r.dir === '->' ? 'sent' : r.dir === '<-' ? 'recv' : 'ev'}${on ? ' on' : ''}${r.planned ? ' planned' : ''}`, 'data-i': i, role: 'option', 'aria-selected': String(on) });
      g.append(sv('rect', { x: 0, y: yy - rowH / 2 + 1, width: W, height: rowH - 2, class: 'hit' }));
      // Time.
      if (!planned) g.append(sv('text', { x: tx, y: yy + 4, 'text-anchor': 'end', class: 'ws-t' }, `${r.t}`));
      // Arrow.
      if (r.dir === '->') {
        const rep = rows.find((x) => x.pair === i);
        const yEnd = rep ? (yy + ys[rows.indexOf(rep)]) / 2 : yy + 10;
        g.append(sv('line', { x1: cx, y1: yy, x2: sx - 7, y2: yEnd, class: 'arr' }));
        g.append(arrowHead(sx, yEnd, cx, yy));
        g.append(sv('circle', { cx, cy: yy, r: 2.5, class: 'dot' }));
      } else if (r.dir === '<-') {
        const snd = r.pair != null ? ys[r.pair] : null;
        const yStart = snd != null ? (snd + yy) / 2 : yy - 10;
        g.append(sv('line', { x1: sx, y1: yStart, x2: cx + 7, y2: yy, class: 'arr' }));
        g.append(arrowHead(cx, yy, sx, yStart));
      } else if (r.kind === 'connect') {
        g.append(sv('line', { x1: cx, y1: yy, x2: sx - 7, y2: yy, class: 'arr' }), arrowHead(sx, yy, cx, yy));
        g.append(sv('text', { x: (cx + sx) / 2, y: yy - 4, 'text-anchor': 'middle', class: 'ws-on' }, narrow ? 'GET Upgrade' : `GET ${u.path || '/'} · Upgrade: websocket`));
      } else if (r.kind === 'open') {
        g.append(sv('line', { x1: sx, y1: yy, x2: cx + 7, y2: yy, class: 'arr' }), arrowHead(cx, yy, sx, yy));
        g.append(sv('text', { x: (cx + sx) / 2, y: yy + 13, 'text-anchor': 'middle', class: 'ws-on' }, narrow ? '101' : '101 Switching Protocols'));
      } else if (r.kind === 'close') {
        const clean = r.code === 1000 || r.code === 1001 || r.code === 1005;
        g.append(sv('line', { x1: cx, y1: yy, x2: sx, y2: yy, class: `ws-close${clean ? '' : ' bad'}` }));
        g.append(sv('text', { x: (cx + sx) / 2, y: yy - 5, 'text-anchor': 'middle', class: `ws-cl${clean ? '' : ' bad'}` },
          clip(`close ${r.code ?? ''} · ${r.note || CLOSE[r.code] || ''}`, Math.floor((sx - cx) / 6.3))));
      } else {
        g.append(sv('circle', { cx, cy: yy, r: 4, class: `ws-evdot${/error/i.test(r.text) ? ' bad' : ''}` }));
      }
      // Label on the left: direction, text, size.
      const glyph = r.dir === '->' ? '→' : r.dir === '<-' ? '←' : '·';
      const size = r.frame ? ` ${r.frame.payload} B` : '';
      const room = Math.floor(labW / 6.9) - size.length - 3;
      const t = sv('text', { x: tx + 10, y: yy + 4, class: 'ws-lbl' });
      t.append(sv('tspan', { class: 'g' }, `${glyph} `), sv('tspan', { class: 'm' }, clip(r.dir === '**' ? r.text.replace(/^connect\s+\S+/, 'connect') : r.text, Math.max(4, room))), sv('tspan', { class: 'b' }, size));
      g.append(t);
      g.addEventListener('click', () => { select(i); seqSvg.focus({ preventScroll: true }); });
      rowG.append(g);
    });
    seqSvg.append(rowG);
    // Brackets.
    for (const b of brackets) {
      const x = sx + 12 + b.lane * 9;
      seqSvg.append(sv('path', { d: `M${x - 4},${b.a}h4V${b.b}h-4`, class: `ws-br${b.r.planned ? ' planned' : ''}` }));
      if (b.lane === 0 || !narrow) seqSvg.append(sv('text', { x: sx + 18 + lanes.length * 9, y: (b.a + b.b) / 2 + 4, class: 'ws-brt' }, b.r.planned ? 'echo?' : narrow ? `${b.r.rtt}ms` : `${b.r.rtt} ms`));
    }
    rows.forEach((r, i) => {
      if (r.dir === '<-' && r.pair == null) seqSvg.append(sv('text', { x: sx + 12, y: ys[i] + 4, class: 'ws-noecho' }, narrow ? 'no echo' : 'not an echo'));
    });
    if (planned) seqSvg.append(sv('text', { x: (cx + sx) / 2, y: H - 12, 'text-anchor': 'middle', class: 'ws-plannote' }, 'planned: nothing sent yet'));

    // Header from result.values.
    const vals = Object.fromEntries((res.values || []).map((v) => [v.label, v]));
    const stat = (label, v, extra) => (v ? h('span', { class: `ws-stat${v.tone ? ' ' + v.tone : ''}`, title: v.hint || '' }, h('small', {}, label), h('b', {}, `${v.value}${v.unit ? ' ' + v.unit : ''}`), extra || null) : null);
    reset(seqHead, h('h2', {}, planned ? 'Session (planned)' : 'Session'),
      stat('sent / received', vals['Sent / received']), stat('echoed', vals.Echoed),
      stat('round trip', vals['Round trip, median'], vals['Round trip, median'] ? h('em', {}, `median · ${vals['Round trip, median'].hint}`) : null),
      stat('handshake', vals.Handshake), stat('close', vals['Close code'], vals['Close code'] ? h('em', {}, vals['Close code'].hint) : null),
      planned ? stat('to send', vals['To send'], vals['To send'] ? h('em', {}, vals['To send'].hint) : null) : null);
    seqSvg.setAttribute('aria-activedescendant', '');
  }
  const arrowHead = (x, y, fx, fy) => {
    const a = Math.atan2(y - fy, x - fx);
    const p = (d, s) => `${x + Math.cos(a + s) * d},${y + Math.sin(a + s) * d}`;
    return sv('path', { d: `M${x},${y}L${p(8, Math.PI - 0.4)}L${p(8, Math.PI + 0.4)}Z`, class: 'head' });
  };

  function select(i) {
    selI = i;
    for (const g of seqSvg.querySelectorAll('.ws-row')) { const on = +g.dataset.i === i; g.classList.toggle('on', on); g.setAttribute('aria-selected', String(on)); }
    const r = rows[i];
    if (r) seqSvg.setAttribute('aria-label', `Session row ${i + 1} of ${rows.length}: ${r.dir === '->' ? 'sent' : r.dir === '<-' ? 'received' : 'event'} ${r.text}`);
    showFrame(r);
  }
  seqSvg.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!d || !rows.length) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(rows.length - 1, (selI ?? -1) + d));
    select(i);
    const g = seqSvg.querySelector(`.ws-row[data-i="${i}"] .hit`);
    if (g) { const r = g.getBoundingClientRect(), b = seqBox.getBoundingClientRect(); if (r.top < b.top || r.bottom > b.bottom) seqBox.scrollTop += r.top - b.top - b.height / 2; }
  });

  // ---------------- drawing: frame ----------------
  function showFrame(r) {
    frameBody.replaceChildren();
    if (!r) { reset(frameHead, h('h2', {}, 'Frame')); put(frameBody, h('div', { class: 'ws-sub ws-pad' }, 'Pick a row in the session.')); return; }
    if (r.dir === '**') return showEvent(r);
    const fr = r.frame;
    const bytes = new TextEncoder().encode(r.text);
    const toServer = r.dir === '->';
    reset(frameHead, h('h2', {}, 'Frame'), h('span', { class: 'ws-sub' }, `${toServer ? 'this page → server' : 'server → this page'} · ${OPCODES[fr.opcode]}${r.planned ? ' · planned' : ''}`));
    // Two header bytes, bit by bit.
    const bits = [fr.fin, 0, 0, 0, ...[3, 2, 1, 0].map((b) => (fr.opcode >> b) & 1), fr.masked ? 1 : 0, ...[6, 5, 4, 3, 2, 1, 0].map((b) => (fr.len7 >> b) & 1)];
    const groups = [['FIN', 1, 'fin', `${fr.fin}: last fragment`], ['RSV', 3, 'rsv', '0 0 0: no extension'], ['opcode', 4, 'op', `${fr.opcode} = ${OPCODES[fr.opcode]}`],
      ['MASK', 1, 'mask', fr.masked ? '1: client frames are masked' : '0: server frames are not'], ['payload len', 7, 'len', fr.len7 === 126 ? '126: length in the next 2 bytes' : fr.len7 === 127 ? '127: length in the next 8 bytes' : `${fr.len7} bytes`]];
    const bitGrid = h('div', { class: 'ws-bits' });
    bits.forEach((b, k) => bitGrid.append(h('span', { class: `bit g-${groupOf(groups, k)}` }, String(b))));
    let col = 1;
    for (const [name, n, cls, desc] of groups) { bitGrid.append(h('span', { class: `blab g-${cls}`, style: `grid-column:${col}/span ${n}`, title: desc }, name)); col += n; }
    const legend = h('dl', { class: 'ws-bitdesc' }, groups.map(([name, , cls, desc]) => [h('dt', { class: `g-${cls}` }, name), h('dd', {}, desc)]));
    // The frame as a byte strip.
    const parts = [['header', 2, 'hd'], ...(fr.extBytes ? [['extended length', fr.extBytes, 'ex']] : []), ...(fr.masked ? [['mask key', 4, 'mk']] : []), ['payload', fr.payload, 'pl']];
    const strip = h('div', { class: 'ws-strip' }, parts.map(([name, n, cls]) => h('span', { class: `s-${cls}`, style: `flex:${Math.max(n, fr.total * 0.14)} 1 0`, title: `${name}: ${n} B` },
      h('b', {}, `${n} B`), h('small', {}, name))));
    // Header bytes in hex (mask key is random each frame).
    const hb = [(fr.fin << 7) | fr.opcode, (fr.masked ? 0x80 : 0) | fr.len7];
    if (fr.extBytes) for (let k = fr.extBytes - 1; k >= 0; k--) hb.push(Math.floor(fr.payload / 2 ** (8 * k)) % 256);
    const hdr = h('div', { class: 'ws-hex' }, hb.map((b, k) => h('span', { class: k < 2 ? 'c-hd' : 'c-ex' }, hex(b))),
      fr.masked ? ['k0', 'k1', 'k2', 'k3'].map((k) => h('span', { class: 'c-mk', title: 'Masking key: 4 random bytes, new for every frame' }, '··')) : null);
    // Payload bytes (first 48), the characters under them.
    const shown = bytes.slice(0, 48);
    const pay = h('div', { class: 'ws-pay' });
    let k = 0;
    for (const ch of r.text) {
      const n = new TextEncoder().encode(ch).length;
      if (k >= 48) break;
      const cell = h('span', { class: `pb${n > 1 ? ' multi' : ''}`, style: `grid-column:span ${Math.min(n, 48 - k)}`, title: `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}: ${n} byte${n > 1 ? 's' : ''}` },
        h('b', {}, Array.from(shown.slice(k, k + n)).map(hex).join(' ')), h('small', {}, ch === ' ' ? '␣' : ch));
      pay.append(cell);
      k += n;
    }
    put(frameBody, 
      h('div', { class: 'ws-sec' }, h('div', { class: 'ws-cap' }, 'first two bytes'), bitGrid, legend),
      h('div', { class: 'ws-sec' }, h('div', { class: 'ws-cap' }, `on the wire: ${fr.total} B`), strip, hdr),
      h('div', { class: 'ws-sec' }, h('div', { class: 'ws-cap' }, `payload, UTF-8${bytes.length > 48 ? ` (first 48 of ${bytes.length} B)` : ''}${toServer ? ' · sent XOR-ed with the mask key' : ''}`), pay),
      h('div', { class: 'ws-tot' }, `${fr.payload} B payload + ${fr.header} B header${fr.masked ? ' (incl. 4 B mask key)' : ''} = `, h('b', {}, `${fr.total} B`), ' in the frame; TCP and TLS add theirs.'),
      r.note ? h('div', { class: 'ws-tot' }, r.rtt != null ? `Echo of the message sent ${r.rtt} ms before.` : r.note === 'not an echo' ? 'Not an echo: no sent message had this text.' : r.note) : null);
  }
  const groupOf = (groups, k) => { let a = 0; for (const [, n, cls] of groups) { if (k < a + n) return cls; a += n; } return ''; };

  function showEvent(r) {
    const u = D.url || {};
    reset(frameHead, h('h2', {}, r.kind === 'connect' ? 'Opening handshake' : r.kind === 'open' ? 'Handshake answer' : r.kind === 'close' ? 'Close' : 'Event'),
      h('span', { class: 'ws-sub' }, r.planned ? 'planned' : `+${r.t} ms`));
    if (r.kind === 'connect' || r.kind === 'open') {
      const protos = D.protocols || [];
      const req = [`GET ${(u.path || '/') + (u.query || '')} HTTP/1.1`, `Host: ${u.host || '?'}${u.port ? ':' + u.port : ''}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: <16 random bytes, base64>', 'Sec-WebSocket-Version: 13', ...(protos.length ? [`Sec-WebSocket-Protocol: ${protos.join(', ')}`] : []), `Origin: ${location.origin === 'null' ? '<this page>' : location.origin}`];
      const ans = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: <base64 SHA-1 of key + GUID>', ...(protos.length ? ['Sec-WebSocket-Protocol: <one of them>'] : [])];
      put(frameBody, 
        h('div', { class: 'ws-sec' }, h('div', { class: 'ws-cap' }, `${u.tls ? 'TLS, then ' : ''}HTTP request from this page`), h('pre', { class: 'ws-http' }, req.join('\n'))),
        h('div', { class: 'ws-sec' }, h('div', { class: 'ws-cap' }, 'the answer that opens the socket'), h('pre', { class: 'ws-http' }, ans.join('\n'))),
        h('div', { class: 'ws-tot' }, D.handshake != null && !r.planned ? ['Connect to open took ', h('b', {}, fmtMs(D.handshake)), u.tls ? ' (TCP, TLS and the upgrade).' : ' (TCP and the upgrade).'] : 'Browsers cannot add headers (Authorization, cookies for other sites) to this request.'));
      return;
    }
    if (r.kind === 'close') {
      const reason = (/close\s+\d{4}\s*(.*?)(\s+unclean)?$/i.exec(r.text) || [])[1] || '';
      const payload = r.code != null && r.code !== 1005 && r.code !== 1006 ? [Math.floor(r.code / 256), r.code % 256, ...new TextEncoder().encode(reason)] : [];
      const unclean = / unclean$/.test(r.text) || r.code === 1006;
      put(frameBody, 
        h('div', { class: `ws-code${unclean ? ' bad' : ''}` }, h('b', {}, String(r.code ?? '–')), h('span', {}, r.note || CLOSE[r.code] || 'no code')),
        payload.length ? h('div', { class: 'ws-sec' }, h('div', { class: 'ws-cap' }, `close frame payload: the code as 2 bytes${reason ? ', then the reason' : ''}`),
          h('div', { class: 'ws-hex' }, payload.map((b, k) => h('span', { class: k < 2 ? 'c-hd' : 'c-pl' }, hex(b))))) : null,
        h('div', { class: 'ws-tot' }, unclean ? 'No close frame arrived: the TCP connection just ended. The page reports 1006 then.' : `Opcode 8 (close). ${reason ? `Reason: "${reason}".` : 'No reason given.'}`));
      return;
    }
    put(frameBody, h('div', { class: 'ws-tot' }, r.text));
  }

  // ---------------- sync ----------------
  function sync() {
    const raw = ctx.raw;
    for (const el of root.querySelectorAll('[data-key]')) if (document.activeElement !== el) el.value = raw[el.dataset.key] ?? '';
    if (document.activeElement !== trans) trans.value = raw.transcript || '';
    for (const b of modeSeg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === raw.mode));
    const u = D && D.url;
    urlParts.replaceChildren();
    if (u && u.scheme) {
      put(urlParts, h('span', { class: `p-sc${/^wss?$/.test(u.scheme) ? '' : ' bad'}`, title: u.tls ? 'TLS (encrypted)' : 'plain, not encrypted' }, `${u.scheme}://`),
        h('span', { class: 'p-host', title: 'host' }, u.host), u.port ? h('span', { class: 'p-port', title: 'port' }, `:${u.port}`) : h('span', { class: 'p-port dim', title: 'default port' }, `:${u.tls ? 443 : 80}`),
        h('span', { class: 'p-path', title: 'path' }, u.path), u.query ? h('span', { class: 'p-q', title: 'query' }, u.query) : null, u.hash ? h('span', { class: 'p-bad', title: 'not allowed' }, u.hash) : null,
        h('span', { class: `p-tag${u.ok ? '' : ' bad'}` }, u.ok ? (u.tls ? 'encrypted' : 'plain') : 'invalid'));
    } else put(urlParts, h('span', { class: 'p-tag bad' }, 'not a URL'));
  }

  modeSeg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const v = ctx.raw.mode === 'lines' ? 'whole' : 'lines';
    ctx.set('mode', v);
    requestAnimationFrame(() => modeSeg.querySelector(`[data-v="${v}"]`)?.focus());
  });

  ctx.onResult((r) => {
    res = r; D = r.drawing || null;
    sync();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes'), ...(r.notes || []).map((t) => h('div', {}, t)));
    if (!outList.contains(document.activeElement) || !D) drawOutbox(); else { drawSocket(); refreshFoots(); }
    const prevLen = rows.length;
    drawSeq();
    // Keep a selection: the newest row while a live session grows, else the first message.
    if (selI == null || selI >= rows.length || (S.state !== 'closed' && rows.length > prevLen)) {
      const firstMsg = rows.findIndex((x) => x.dir === '->');
      selI = S.state !== 'closed' && rows.length > prevLen ? rows.length - 1 : firstMsg >= 0 ? firstMsg : rows.length ? 0 : null;
      if (S.state !== 'closed') requestAnimationFrame(() => { seqBox.scrollTop = seqBox.scrollHeight; });
    }
    if (selI != null) select(selI); else showFrame(null);
  });
  // While typing in the outbox, only the size lines under the cards change.
  function refreshFoots() {
    const cards = [...outList.querySelectorAll('.ws-msg')];
    if (ctx.raw.mode === 'whole') { const o = D.outbox[0]; const old = cards[0]?.querySelector('.ws-mfoot'); if (old && o) old.replaceWith(msgFoot(o, 0)); return; }
    const lines = String(ctx.raw.messages || '').split(/\r?\n/);
    if (lines.length !== cards.length) { drawOutbox(); return; }
    let oi = 0;
    lines.forEach((line, i) => {
      const o = line.trim() !== '' ? D.outbox[oi++] : null;
      const old = cards[i].querySelector('.ws-mfoot');
      cards[i].classList.toggle('bad', !!o && o.json === 'bad');
      old.replaceWith(o ? msgFoot(o, oi - 1) : h('div', { class: 'ws-mfoot' }, h('span', {}, 'empty line: not sent')));
    });
  }
  let lw = 0;
  new ResizeObserver(() => { const w = seqBox.clientWidth; if (w !== lw) { lw = w; if (D) { drawSeq(); if (selI != null) select(selI); } } }).observe(seqBox);
  drawSocket();
}
