// WebSocket echo tester. run() is pure: it checks the URL and the messages to
// send, and reads a transcript (written by view.js after a live session in the
// app, or pasted) into counts, echo matches and round-trip times.
// Transcript line: <ISO time> <dir> <text>   dir: -> sent, <- received, ** event
// URL rules and close codes from RFC 6455 (sections 3, 7.4.1) and the WHATWG
// WebSockets standard (a fragment is not allowed; the browser picks ws/wss).

export const CLOSE = {
  1000: 'normal closure', 1001: 'going away (server shutting down or page left)', 1002: 'protocol error', 1003: 'unsupported data',
  1005: 'no status code given', 1006: 'abnormal: closed without a close frame (network, TLS, proxy or refused)', 1007: 'invalid payload data (e.g. bad UTF-8)',
  1008: 'policy violation', 1009: 'message too big', 1010: 'extension not negotiated', 1011: 'server error', 1012: 'service restart',
  1013: 'try again later', 1014: 'bad gateway', 1015: 'TLS handshake failed',
};

export function checkUrl(u) {
  const problems = [];
  const url = String(u || '').trim();
  let parsed = null;
  try { parsed = new URL(url); } catch { problems.push('Not a URL: write it like wss://echo.websocket.org or ws://localhost:8080/ws.'); return { problems, parsed }; }
  if (!/^wss?:$/.test(parsed.protocol)) problems.push(`The scheme is ${parsed.protocol.replace(':', '')}: a WebSocket URL starts with ws:// or wss:// (http(s) URLs are for the HTTP tester).`);
  if (parsed.hash) problems.push('A WebSocket URL may not have a #fragment (RFC 6455 3): remove it.');
  return { problems, parsed };
}

const utf8len = (s) => { let b = 0; for (const ch of s) { const c = ch.codePointAt(0); b += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return b; };
// Frame overhead client -> server: 2 bytes + 4 byte mask, +2 over 125 bytes, +8 over 65535 (RFC 6455 5.2).
const frame = (n) => n + 6 + (n > 65535 ? 8 : n > 125 ? 2 : 0);

export function outgoing(input) {
  const text = String(input.messages ?? '');
  if (input.mode === 'whole') return text.trim() ? [text] : [];
  return text.split(/\r?\n/).filter((l) => l.trim() !== '');
}

export function run(input) {
  const warnings = [], notes = [];
  const { problems, parsed } = checkUrl(input.url);
  warnings.push(...problems);
  if (parsed && parsed.protocol === 'ws:' && !/^(localhost|127\.|\[::1\])/.test(parsed.hostname)) {
    notes.push('ws:// is not encrypted and an https page may not open it (mixed content): use wss:// unless the server is local.');
  }
  const protos = String(input.protocols || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of protos) if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p)) warnings.push(`Subprotocol "${p}" has characters a token may not have (RFC 6455 4.1): the browser will refuse to connect.`);

  const out = outgoing(input);
  const jsonCount = out.filter((m) => { try { JSON.parse(m); return /^[[{]/.test(m.trim()); } catch { return false; } }).length;
  const looksJson = out.filter((m) => /^\s*[[{]/.test(m));
  const badJson = looksJson.filter((m) => { try { JSON.parse(m); return false; } catch { return true; } });
  if (badJson.length) warnings.push(`${badJson.length} message(s) start like JSON but do not parse, e.g. ${badJson[0].slice(0, 60)}: a JSON server will reject them.`);
  const outBytes = out.reduce((a, m) => a + utf8len(m), 0);

  // ---- transcript ----
  const lines = String(input.transcript || '').split(/\r?\n/).filter((l) => l.trim());
  const ev = []; let unread = 0;
  for (const l of lines) {
    const m = /^(\S+)\s+(->|<-|\*\*|→|←|·)\s?(.*)$/.exec(l.trim());
    const t = m ? Date.parse(m[1]) : NaN;
    if (!m || !Number.isFinite(t)) { unread += 1; continue; }
    const dir = { '→': '->', '←': '<-', '·': '**' }[m[2]] || m[2];
    ev.push({ t, dir, text: m[3] });
  }
  const sent = ev.filter((e) => e.dir === '->');
  const got = ev.filter((e) => e.dir === '<-');
  // Echo matching: each reply is paired with the earliest unmatched sent message of the same text before it.
  const pending = [...sent];
  const rtts = [];
  const rows = [];
  const t0 = ev.length ? ev[0].t : 0;
  for (const e of ev) {
    let note = '';
    if (e.dir === '<-') {
      const i = pending.findIndex((s) => s.text === e.text && s.t <= e.t);
      if (i >= 0) { const d = e.t - pending[i].t; rtts.push(d); note = `echo, ${d} ms`; e.pair = ev.indexOf(pending[i]); e.rtt = d; pending.splice(i, 1); }
      else note = 'not an echo';
    }
    if (e.dir === '**') {
      const c = /close\D*(\d{4})/i.exec(e.text);
      if (c) { note = CLOSE[c[1]] || (Number(c[1]) >= 4000 ? 'application-defined code' : ''); e.code = Number(c[1]); }
    }
    e.note = note;
    rows.push([`+${e.t - t0} ms`, { '->': 'sent', '<-': 'received', '**': 'event' }[e.dir], e.text.length > 160 ? e.text.slice(0, 160) + '…' : e.text, note]);
  }
  const opened = ev.find((e) => e.dir === '**' && /^open/i.test(e.text));
  const connecting = ev.find((e) => e.dir === '**' && /^connect/i.test(e.text));
  const closed = ev.find((e) => e.dir === '**' && /close/i.test(e.text));
  const code = closed ? (/(\d{4})/.exec(closed.text) || [])[1] : null;
  if (code === '1006') warnings.push('Closed with 1006: the connection dropped without a close frame. Usual causes: wrong URL or port, TLS certificate, a proxy that does not pass WebSocket, or the server refused the handshake (check its log).');
  if (code === '1015') warnings.push('Closed with 1015: the TLS handshake failed. Check the certificate (self-signed certificates must be accepted in the browser first).');
  if (code === '1009') warnings.push('Closed with 1009: a message was larger than the server accepts. Split it or raise the server limit.');
  if (unread) warnings.push(`${unread} transcript line(s) could not be read (expected: ISO-time, then -> <- or **, then the text).`);
  if (sent.length && !got.length && lines.length) warnings.push('Nothing came back: the server is not an echo server, or it expects another format (JSON, a subprotocol) before it answers.');

  const s = [...rtts].sort((a, b) => a - b);
  const values = [
    { label: 'URL', value: parsed && !problems.length ? (parsed.protocol === 'wss:' ? 'wss (TLS)' : 'ws (plain)') : 'invalid', hint: parsed?.host || '', tone: problems.length ? 'bad' : 'ok' },
    { label: 'To send', value: out.length, hint: `${outBytes} B payload, ${out.reduce((a, m) => a + frame(utf8len(m)), 0)} B framed${jsonCount ? `, ${jsonCount} JSON` : ''}` },
  ];
  if (ev.length) {
    values.push({ label: 'Sent / received', value: `${sent.length} / ${got.length}` });
    values.push({ label: 'Echoed', value: `${rtts.length} / ${sent.length}`, tone: sent.length ? (rtts.length === sent.length ? 'ok' : 'warn') : undefined });
    if (s.length) values.push({ label: 'Round trip, median', value: s[Math.floor((s.length - 1) / 2)], unit: 'ms', hint: `min ${s[0]} · max ${s[s.length - 1]} ms` });
    if (opened && connecting) values.push({ label: 'Handshake', value: opened.t - connecting.t, unit: 'ms', hint: 'connect to open' });
    if (code) values.push({ label: 'Close code', value: Number(code), hint: CLOSE[code] || '', tone: code === '1000' || code === '1005' ? 'ok' : 'warn' });
  }
  const js = [
    `const ws = new WebSocket(${JSON.stringify(String(input.url || '').trim())}${protos.length ? `, ${JSON.stringify(protos)}` : ''});`,
    'ws.onopen = () => {',
    ...out.slice(0, 20).map((m) => `  ws.send(${JSON.stringify(m)});`),
    '};',
    'ws.onmessage = (e) => console.log(new Date().toISOString(), \'<-\', e.data);',
    'ws.onclose = (e) => console.log(\'closed\', e.code, e.reason);',
    '',
  ].join('\n');
  const cli = `# websocat (https://github.com/vi/websocat): type a line, see the reply\nwebsocat${protos.length ? ` --protocol ${protos.join(',')}` : ''} ${String(input.url || '').trim()}\n`;
  // For the page's drawing only (agentOmit): every event with its frame, the
  // messages to send, and the URL in parts.
  const frameOf = (text, dir) => {
    const n = utf8len(text), masked = dir === '->';
    const extBytes = n > 65535 ? 8 : n > 125 ? 2 : 0;
    return { payload: n, fin: 1, opcode: 1, masked, len7: n > 65535 ? 127 : n > 125 ? 126 : n, ext: extBytes ? n : null, extBytes,
      header: 2 + extBytes + (masked ? 4 : 0), total: n + 2 + extBytes + (masked ? 4 : 0) };
  };
  const json = (m) => (/^\s*[[{]/.test(m) ? (badJson.includes(m) ? 'bad' : 'ok') : 'no');
  const drawing = {
    url: parsed ? { ok: !problems.length, scheme: parsed.protocol.replace(':', ''), host: parsed.hostname, port: parsed.port,
      path: parsed.pathname, query: parsed.search, hash: parsed.hash, tls: parsed.protocol === 'wss:' } : { ok: false },
    protocols: protos,
    outbox: out.map((m) => ({ text: m, json: json(m), frame: frameOf(m, '->'), echoFrame: frameOf(m, '<-') })),
    events: ev.map((e) => {
      const o = { t: e.t - t0, dir: e.dir, text: e.text, note: e.note || '' };
      if (e.dir !== '**') o.frame = frameOf(e.text, e.dir);
      if (e.pair != null) { o.pair = e.pair; o.rtt = e.rtt; }
      if (e.code != null) o.code = e.code;
      if (e.dir === '**') o.kind = (/^(connect|open|close|error)/i.exec(e.text) || [, 'event'])[1].toLowerCase();
      return o;
    }),
    t0: ev.length ? new Date(t0).toISOString() : null,
    handshake: opened && connecting ? opened.t - connecting.t : null,
    unread,
  };
  return {
    drawing,
    values, warnings,
    notes: [...notes,
      'In the app, Connect opens the socket from this page; the transcript is written into the Transcript field so the results and the Prompt see it.',
      'Browsers cannot set headers (Authorization, cookies for other sites) on a WebSocket: pass a token in the URL query or the first message, or use a subprotocol.',
      'Round trip pairs each reply with the earliest unanswered sent message of the same text; servers that change the text (JSON wrappers) show as "not an echo".'],
    tables: rows.length ? [{ title: 'Transcript', columns: ['Time', 'Dir', 'Message', 'Note'], rows }] : [],
    charts: rtts.length > 1 ? [{ title: 'Round trip per echo', type: 'bars', x: rtts.map((_, i) => i + 1), series: [{ name: 'ms', y: rtts }], yLabel: 'ms', xLabel: 'echo #' }] : [],
    texts: [{ title: 'JavaScript', body: js, lang: 'js' }, { title: 'websocat', body: cli, lang: 'sh' }],
  };
}
