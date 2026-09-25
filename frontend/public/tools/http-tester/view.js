// HTTP Request Tester page: the exchange itself is the interface. A sequence
// diagram between this page and the server shows what the browser will put
// on the wire - the CORS preflight when one is due, the request with its
// headers riding on the arrow, the response coming back along a time axis
// (dns / connect / tls / waiting / download) - and below it the two messages:
// the request you edit header by header, the response read header by header.
// Click a header on the arrow to switch it off and watch the preflight go.
// Send makes the request from this page with fetch() and writes the capture
// into the Response input, so run() reads it like a pasted one. Everything
// drawn comes from tool.js run() (result.drawing).
import { parseHeaders } from './tool.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_BODY = 60000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const bytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------------- the live send (unchanged behaviour from the first version) ----------------
async function send(raw, input, setResp, status) {
  const method = String(raw.method || 'GET').toUpperCase();
  const url = String(raw.url || '').trim();
  if (!url) return;
  if (location.protocol === 'https:' && /^http:/i.test(url)) {
    setResp('ERROR mixed content: this page is https and the browser blocks http:// requests. Use https:// or open the app over http.');
    return;
  }
  const headers = new Headers();
  const dropped = [];
  for (const [k, v] of parseHeaders(raw.headers).ok) { try { headers.append(k, v); } catch { dropped.push(k); } }
  const body = String(raw.body ?? '');
  const opts = { method, headers, cache: 'no-store', redirect: 'follow', credentials: raw.cookies ? 'include' : 'same-origin' };
  if (body.trim() && !['GET', 'HEAD'].includes(method)) opts.body = body;
  const ctl = new AbortController();
  const secs = input.timeout > 0 ? input.timeout : 15;
  const timer = setTimeout(() => ctl.abort(), secs * 1000);
  opts.signal = ctl.signal;
  status(true, `${method} ${url}…`);
  const t0 = performance.now();
  let text, msg;
  try {
    const res = await fetch(url, opts);
    const tHead = performance.now();
    let b = method === 'HEAD' ? '' : await res.text();
    const t1 = performance.now();
    if (b.length > MAX_BODY) b = b.slice(0, MAX_BODY) + `\n… (${b.length - MAX_BODY} more characters cut)`;
    const abs = new URL(url, location.href).href;
    const e = performance.getEntriesByName(abs).filter((x) => x.entryType === 'resource').pop();
    const tm = [`total=${(t1 - t0).toFixed(1)}`, `ttfb=${(tHead - t0).toFixed(1)}`];
    // Detailed phases are zero for cross-origin requests without Timing-Allow-Origin.
    if (e && e.requestStart > 0) {
      tm.push(`dns=${(e.domainLookupEnd - e.domainLookupStart).toFixed(1)}`, `connect=${(e.connectEnd - e.connectStart).toFixed(1)}`,
        `tls=${e.secureConnectionStart > 0 ? (e.connectEnd - e.secureConnectionStart).toFixed(1) : '0'}`, `download=${(e.responseEnd - e.responseStart).toFixed(1)}`);
    }
    const hs = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`);
    text = [`${res.status} ${res.statusText}`.trim(), `# timing ${tm.join(' ')}`, ...(res.redirected ? [`# redirected to ${res.url}`] : []), ...hs, '', b].join('\n');
    msg = `${res.status} in ${Math.round(t1 - t0)} ms${dropped.length ? ` (the browser refused headers: ${dropped.join(', ')})` : ''}.`;
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    text = aborted ? `ERROR timeout: no answer within ${secs} s` : `ERROR ${err && err.message ? err.message : err}`;
    msg = aborted ? `Timed out after ${secs} s.` : 'Failed: no response reached the page.';
  } finally { clearTimeout(timer); }
  status(false, msg);
  setResp(text);
}

// header text <-> rows
function rowsOf(text) {
  return String(text || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const t = l.trim();
    const off = t.startsWith('#');
    const m = /^#?\s*([^:]*?)\s*:\s*(.*)$/.exec(t);
    return m ? { on: !off, name: m[1], value: m[2] } : { on: !off, name: t.replace(/^#\s*/, ''), value: '', raw: true };
  });
}
const textOf = (rows) => rows.map((r) => `${r.on ? '' : '# '}${r.name}${r.raw && !r.value ? '' : `: ${r.value}`}`).join('\n');

const KIND = {
  safe: ['safelisted', 'CORS-safelisted: no preflight'],
  preflight: ['preflight', 'makes a cross-origin request preflighted'],
  custom: ['custom', 'not safelisted, but same origin: no preflight'],
  forbidden: ['dropped', 'forbidden header name: the browser will not send it'],
  off: ['off', 'switched off (a # comment line)'],
  bad: ['not a header', 'not "Name: value": left out'],
};

export function page(root, ctx) {
  const served = /^https?:/.test(location.protocol);
  let busy = false, busyMsg = '', pasteOpen = false;

  // ---------------- request line bar ----------------
  const bar = el('div', { class: 'ht-bar' });
  const methodSel = el('select', { class: 'ht-method', 'aria-label': 'Method' });
  for (const o of ctx.manifest.inputs.find((d) => d.key === 'method').options) methodSel.append(el('option', { value: o }, o));
  methodSel.addEventListener('change', () => ctx.set('method', methodSel.value));
  const urlIn = el('input', { class: 'ht-url', type: 'text', spellcheck: 'false', 'aria-label': 'URL', placeholder: 'https://… or /api/…' });
  urlIn.addEventListener('input', () => ctx.set('url', urlIn.value));
  urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
  const proto = el('span', { class: 'ht-proto' }, 'HTTP/1.1');
  const tIn = el('input', { class: 'ht-tmo', type: 'text', inputmode: 'decimal', 'aria-label': 'Timeout in seconds' });
  tIn.addEventListener('input', () => ctx.set('timeout', tIn.value));
  const tBox = el('label', { class: 'ht-small', title: 'Timeout' }, '<span>timeout</span>');
  tBox.append(tIn, el('span', {}, 's'));
  const cookie = el('input', { type: 'checkbox', 'aria-label': 'Send cookies to other origins (credentials: include)' });
  cookie.addEventListener('change', () => ctx.set('cookies', cookie.checked));
  const cBox = el('label', { class: 'ht-small', title: 'credentials: include - send cookies to other origins' });
  cBox.append(cookie, el('span', {}, 'cookies'));
  const sendBtn = el('button', { class: 'ht-send', type: 'button' }, 'Send');
  sendBtn.addEventListener('click', () => doSend());
  bar.append(methodSel, urlIn, proto, tBox, cBox, sendBtn);

  // ---------------- wire diagram ----------------
  const wire = el('section', { class: 'ht-wire' });
  const wireBox = el('div', { class: 'ht-wire-box' });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'ht-svg');
  svg.setAttribute('role', 'img');
  wireBox.append(svg);
  const statusLine = el('div', { class: 'ht-status', role: 'status' });
  wire.append(bar, wireBox, statusLine);

  // ---------------- messages ----------------
  const reqPane = el('section', { class: 'ht-pane ht-req' });
  const resPane = el('section', { class: 'ht-pane ht-res' });
  const outPane = el('div', { class: 'ht-outs' });
  outPane.append(ctx.outputs);
  const notesEl = el('details', { class: 'ht-notes' });
  outPane.append(notesEl);
  const msgs = el('div', { class: 'ht-msgs' });
  msgs.append(reqPane, resPane, outPane);

  const grid = el('div', { class: 'ht' });
  grid.append(wire, msgs);
  root.append(grid);

  // request pane: header rows + body
  const reqHead = el('div', { class: 'ht-ph' }, '<b>Request</b><span class="ht-ph-sub"></span>');
  const hdrList = el('div', { class: 'ht-hdrs', role: 'list' });
  const addRow = el('div', { class: 'ht-add' });
  const addBtn = el('button', { class: 'ht-chip', type: 'button' }, '+ header');
  addBtn.addEventListener('click', () => { const r = rowsOf(ctx.raw.headers); r.push({ on: true, name: 'X-Custom', value: '' }); setRows(r, true); });
  addRow.append(addBtn);
  for (const [n, v] of [['Content-Type', 'application/json'], ['Authorization', 'Bearer <token>'], ['Accept', 'application/json'], ['X-Request-ID', '1']]) {
    const b = el('button', { class: 'ht-chip ghost', type: 'button', title: `Add ${n}: ${v}` }, esc(n));
    b.addEventListener('click', () => { const r = rowsOf(ctx.raw.headers).filter((x) => x.name.toLowerCase() !== n.toLowerCase()); r.push({ on: true, name: n, value: v }); setRows(r); });
    addRow.append(b);
  }
  const bodyHead = el('div', { class: 'ht-sub' });
  const bodyTa = el('textarea', { class: 'ht-body', rows: '5', spellcheck: 'false', 'aria-label': 'Request body', placeholder: '{"key": "value"}' });
  bodyTa.addEventListener('input', () => ctx.set('body', bodyTa.value));
  const bodyNote = el('div', { class: 'ht-bodynote' });
  reqPane.append(reqHead, hdrList, addRow, bodyHead, bodyTa, bodyNote);

  function setRows(rows, focusLast = false) {
    ctx.set('headers', textOf(rows));
    if (focusLast) requestAnimationFrame(() => { const n = hdrList.querySelector('.ht-hrow:last-child .ht-hn'); if (n) { n.focus(); n.select(); } });
  }

  // response pane
  const resHead = el('div', { class: 'ht-ph' });
  const resBody = el('div', { class: 'ht-resbody' });
  const pasteHelp = el('div', { class: 'ht-empty' }, esc(ctx.manifest.inputs.find((d) => d.key === 'response').help || ''));
  const pasteTa = el('textarea', { class: 'ht-paste', rows: '8', spellcheck: 'false', 'aria-label': 'Captured response',
    placeholder: '200 OK\ncontent-type: application/json\n\n{"ok":true}' });
  pasteTa.addEventListener('input', () => ctx.set('response', pasteTa.value));
  // The pasted-response editor stays in place (never re-inserted), so typing keeps focus while the view above it follows.
  const resView = el('div');
  const pasteBox = el('div');
  pasteBox.append(pasteTa, pasteHelp);
  resBody.append(resView, pasteBox);
  resPane.append(resHead, resBody);

  function doSend() {
    if (busy || !served) return;
    send(ctx.raw, ctx.input, (t) => ctx.set('response', t), (b, m) => { busy = b; busyMsg = m; render(ctx.result); });
  }

  // ---------------- drawing ----------------
  function drawWire(d, res) {
    const W = Math.max(320, wireBox.clientWidth), narrow = W < 620;
    const r = d.response;
    const hasT = r && !r.error && r.timing && r.timing.total != null;
    const H = Math.max(200, wireBox.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const xl = narrow ? 58 : Math.min(190, W * 0.17), xr = W - (narrow ? 58 : Math.min(190, W * 0.17));
    const top = narrow ? 64 : 50, bot = H - 18;
    const fit = (txt, px) => trunc(txt, Math.max(8, Math.floor(px / 6.6)));
    const s = [];
    s.push(`<defs><marker id="ht-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="context-stroke"/></marker></defs>`);
    // lifelines
    const origin = served ? location.host : 'this page';
    s.push(`<line class="ht-life" x1="${xl}" y1="${top - 6}" x2="${xl}" y2="${bot}"/><line class="ht-life" x1="${xr}" y1="${top - 6}" x2="${xr}" y2="${bot}"/>`);
    const boxW = narrow ? 104 : 170;
    s.push(`<rect class="ht-actor" x="${xl - boxW / 2}" y="6" width="${boxW}" height="34" rx="5"/><text class="ht-an" x="${xl}" y="21" text-anchor="middle">${narrow ? 'Browser' : 'Browser · this page'}</text><text class="ht-ao" x="${xl}" y="34" text-anchor="middle">${esc(trunc(origin, narrow ? 16 : 26))}</text>`);
    s.push(`<rect class="ht-actor srv" x="${xr - boxW / 2}" y="6" width="${boxW}" height="34" rx="5"/><text class="ht-an" x="${xr}" y="21" text-anchor="middle">Server</text><text class="ht-ao" x="${xr}" y="34" text-anchor="middle">${esc(trunc(d.host || '?', narrow ? 16 : 26))}</text>`);
    s.push(`<text class="ht-orig ${d.cross ? 'x' : ''}" x="${W / 2}" y="${narrow ? 54 : 18}" text-anchor="middle">${d.cross ? 'cross-origin: CORS rules apply' : 'same origin: no CORS'}</text>`);

    // time scale
    let y = top + 14;
    const mid = (xl + xr) / 2;
    // preflight
    if (d.preflight) {
      const y1 = y, y2 = y + 22;
      s.push(`<line class="ht-arr pre" x1="${xl}" y1="${y1}" x2="${xr}" y2="${y1}" marker-end="url(#ht-ah)"/><text class="ht-lab pre" x="${mid}" y="${y1 - 4}" text-anchor="middle">${esc(fit(`OPTIONS ${d.path || '/'} · preflight`, xr - xl))}</text>`);
      s.push(`<line class="ht-arr pre" x1="${xr}" y1="${y2}" x2="${xl}" y2="${y2}" marker-end="url(#ht-ah)"/><text class="ht-lab pre sm" x="${mid}" y="${y2 + 13}" text-anchor="middle">${esc(fit(`because of ${d.why.join(', ')}${narrow ? '' : ' · must allow it, or nothing below is sent'}`, xr - xl))}</text>`);
      y = y2 + 30;
    }
    // phases before the request on the page side
    const tm = hasT ? r.timing : {};
    const total = hasT ? tm.total : 0;
    const avail = bot - y - 30;
    const k = hasT && total > 0 ? avail / total : 0;
    const T = (t) => y + t * k;
    let tSend = 0;
    if (hasT) {
      const ph = [['dns', tm.dns], ['connect', tm.connect], ['tls', tm.tls]].filter(([, v]) => v > 0);
      let t = 0;
      for (const [n, v] of ph) {
        s.push(`<rect class="ht-ph-${n}" x="${xl - 7}" y="${T(t)}" width="14" height="${Math.max(2, v * k)}"/>`);
        if (v * k >= 10) s.push(`<text class="ht-tick" x="${xl - 12}" y="${T(t + v / 2) + 3}" text-anchor="end">${n} ${ms(v)}</text>`);
        t += v;
      }
      tSend = t;
    }
    // request arrow + headers riding on it
    const yReq = hasT ? T(tSend) : y + 6;
    const on = d.headers.filter((h) => !h.off && h.kind !== 'bad');
    s.push(`<line class="ht-arr req${busy ? ' busy' : ''}" x1="${xl}" y1="${yReq}" x2="${xr}" y2="${yReq}" marker-end="url(#ht-ah)"/>`);
    s.push(`<text class="ht-lab req" x="${xl + 10}" y="${yReq - 6}"><tspan class="ht-m">${esc(d.method)}</tspan> ${esc(fit(d.path || d.url, (xr - xl) * (narrow ? 1 : 0.7) - 60))}</text>`);
    if (!narrow) s.push(`<text class="ht-lab sm" x="${xr - 10}" y="${yReq - 6}" text-anchor="end">${on.length} header${on.length === 1 ? '' : 's'}${d.bodyBytes && !d.bodyIgnored && !['GET', 'HEAD'].includes(d.method) ? ` · ${bytes(d.bodyBytes)} body` : ''}</text>`);
    // header chips below the arrow (clickable: switch on/off)
    let cx = xl + 10;
    const chips = [];
    for (const h of d.headers) {
      if (h.kind === 'bad') continue;
      const label = h.name;
      const w = label.length * 6.4 + 14;
      if (cx + w > xr - 8) { chips.push(`<text class="ht-lab sm" x="${cx}" y="${yReq + 17}">…</text>`); break; }
      chips.push(`<g class="ht-hchip k-${h.kind}" data-line="${h.line}" tabindex="0" role="button" aria-pressed="${!h.off}" aria-label="${esc(`${h.name}: ${h.value} - ${KIND[h.kind][1]}. Enter switches it ${h.off ? 'on' : 'off'}.`)}"><title>${esc(`${h.name}: ${h.value}\n${h.note}\nclick: switch ${h.off ? 'on' : 'off'}`)}</title><rect x="${cx}" y="${yReq + 5}" width="${w}" height="17" rx="8.5"/><text x="${cx + w / 2}" y="${yReq + 17}" text-anchor="middle">${esc(label)}</text></g>`);
      cx += w + 4;
    }
    s.push(...chips);

    // server side + response
    if (busy) {
      s.push(`<text class="ht-lab" x="${mid}" y="${yReq + 50}" text-anchor="middle">waiting for the answer…</text>`);
    } else if (!r) {
      const yR = Math.min(bot - 10, yReq + 70);
      s.push(`<line class="ht-arr ghost" x1="${xr}" y1="${yR}" x2="${xl}" y2="${yR}" marker-end="url(#ht-ah)"/>`);
      s.push(`<text class="ht-lab ghost" x="${mid}" y="${yR - 6}" text-anchor="middle">${esc(fit(served ? (narrow ? 'no response yet' : 'no response yet: Send, or paste a capture below') : (narrow ? 'paste a response below' : 'paste a captured response below (Send works inside the app)'), xr - xl))}</text>`);
    } else if (r.error) {
      const xs = xl + (xr - xl) * 0.55;
      s.push(`<line class="ht-arr bad" x1="${xl}" y1="${yReq + 44}" x2="${xs}" y2="${yReq + 44}"/><path class="ht-x" d="M${xs - 7} ${yReq + 37}l14 14m0 -14l-14 14"/>`);
      s.push(`<text class="ht-lab bad" x="${xl + 10}" y="${yReq + 38}">no response reached the page</text><text class="ht-lab bad sm" x="${xs + 14}" y="${yReq + 48}">${esc(trunc(r.error, narrow ? 26 : 70))}</text>`);
    } else {
      const tt = hasT ? Math.max(tSend, tm.ttfb ?? total) : 0;
      const yT = hasT ? Math.max(yReq + 30, T(tt)) : yReq + 44;
      const yE = hasT ? Math.max(yT + 16, T(total)) : yT + 20;
      if (hasT) {
        s.push(`<rect class="ht-wait" x="${xr - 7}" y="${yReq}" width="14" height="${yT - yReq}"/>`);
        s.push(narrow ? `<text class="ht-tick" x="${xr - 12}" y="${(yReq + yT) / 2 + 3}" text-anchor="end">first byte ${ms(tm.ttfb ?? total)}</text>`
          : `<text class="ht-tick" x="${xr + 12}" y="${(yReq + yT) / 2 + 3}">waiting · first byte ${ms(tm.ttfb ?? total)}</text>`);
      }
      const tone = r.cls === 2 ? 'ok' : r.cls === 3 ? 'redir' : r.cls >= 4 ? 'bad' : '';
      s.push(`<line class="ht-arr res ${tone}" x1="${xr}" y1="${yT}" x2="${xl}" y2="${yE}" marker-end="url(#ht-ah)"/>`);
      const ang = Math.atan2(yE - yT, xl - xr) * 180 / Math.PI + 180;
      if (narrow) s.push(`<text class="ht-lab res ${tone}" x="${xr - 12}" y="${yT - 6}" text-anchor="end"><tspan class="ht-m">${r.status} ${esc(fit(r.statusText, 60))}</tspan> · ${bytes(r.size)}</text>`);
      else s.push(`<text class="ht-lab res ${tone}" transform="translate(${mid} ${(yT + yE) / 2 - 7}) rotate(${ang})" text-anchor="middle"><tspan class="ht-m">${r.status} ${esc(r.statusText)}</tspan> · ${bytes(r.size)}${r.contentType ? ` ${esc(r.contentType)}` : ''}</text>`);
      if (hasT) {
        const dl = tm.download != null ? tm.download : total - (tm.ttfb ?? total);
        s.push(`<rect class="ht-dl" x="${xl - 7}" y="${yT}" width="14" height="${Math.max(2, yE - yT)}"/>`);
        if (narrow) {
          s.push(`<text class="ht-total" x="${xl + 12}" y="${yE + 15}">${ms(total)} total <tspan class="ht-tick">· download ${ms(dl)}</tspan></text>`);
        } else {
          s.push(`<text class="ht-tick" x="${xl - 12}" y="${(yT + yE) / 2 + 3}" text-anchor="end">download ${ms(dl)}</text>`);
          s.push(`<line class="ht-tot" x1="${xl - 40}" y1="${yE}" x2="${xl}" y2="${yE}"/><text class="ht-total" x="${xl - 12}" y="${yE + 14}" text-anchor="end">${ms(total)} total</text>`);
        }
        s.push(`<line class="ht-tot" x1="${xl - 40}" y1="${y}" x2="${xl}" y2="${y}"/><text class="ht-tick" x="${xl - 12}" y="${y - 3}" text-anchor="end">0</text>`);
      } else {
        s.push(`<text class="ht-tick" x="${xl - 10}" y="${yE + 14}" text-anchor="end">no timing</text>`);
      }
    }
    svg.innerHTML = s.join('');
    svg.setAttribute('aria-label', `${d.method} ${d.url}: ${d.preflight ? 'preflighted, ' : ''}${r ? (r.error ? 'failed' : `${r.status}`) : 'not sent'}`);
  }

  function drawReq(d, res) {
    const inp = ctx.raw;
    const hasBody = !['GET', 'HEAD'].includes(String(inp.method || 'GET').toUpperCase());
    const rows = rowsOf(inp.headers);
    const active = hdrList.contains(document.activeElement) ? document.activeElement : null;
    const aIdx = active ? [...hdrList.querySelectorAll('.ht-hrow')].indexOf(active.closest('.ht-hrow')) : -1;
    const aCls = active ? active.className : '';
    const sig = rows.map((r) => `${r.on}`).join(',');
    const kinds = d.headers;
    // rebuild rows unless typing in one with the same row structure
    if (!(active && hdrList.dataset.sig === sig && hdrList.children.length === rows.length)) {
      hdrList.dataset.sig = sig;
      hdrList.replaceChildren();
      rows.forEach((r, i) => {
        const row = el('div', { class: 'ht-hrow', role: 'listitem' });
        const cb = el('input', { type: 'checkbox', class: 'ht-hon', 'aria-label': `Send ${r.name || 'this header'}` });
        cb.checked = r.on;
        cb.addEventListener('change', () => { const rs = rowsOf(ctx.raw.headers); rs[i].on = cb.checked; setRows(rs); });
        const n = el('input', { class: 'ht-hn', type: 'text', spellcheck: 'false', 'aria-label': 'Header name', placeholder: 'Name' });
        const v = el('input', { class: 'ht-hv', type: 'text', spellcheck: 'false', 'aria-label': 'Header value', placeholder: 'value' });
        n.value = r.name; v.value = r.value;
        n.addEventListener('input', () => { const rs = rowsOf(ctx.raw.headers); if (!rs[i]) return; rs[i].name = n.value; rs[i].raw = false; setRows(rs); });
        v.addEventListener('input', () => { const rs = rowsOf(ctx.raw.headers); if (!rs[i]) return; rs[i].value = v.value; rs[i].raw = false; setRows(rs); });
        const tag = el('span', { class: 'ht-tag' });
        const x = el('button', { class: 'ht-x-btn', type: 'button', 'aria-label': `Remove ${r.name || 'header'}`, title: 'Remove' }, '×');
        x.addEventListener('click', () => { const rs = rowsOf(ctx.raw.headers); rs.splice(i, 1); setRows(rs); });
        row.append(cb, n, el('span', { class: 'ht-colon' }, ':'), v, tag, x);
        hdrList.append(row);
      });
      if (aIdx >= 0) hdrList.querySelectorAll('.ht-hrow')[aIdx]?.querySelector(`.${aCls.split(' ')[0]}`)?.focus();
    }
    // tags from run()
    const rowEls = hdrList.querySelectorAll('.ht-hrow');
    kinds.forEach((h, i) => {
      const row = rowEls[i];
      if (!row) return;
      row.className = `ht-hrow k-${h.kind}`;
      const t = row.querySelector('.ht-tag');
      t.textContent = KIND[h.kind][0];
      t.title = h.note;
    });
    if (!rows.length) hdrList.innerHTML = '<div class="ht-empty">No headers. fetch() adds Accept: */* and the forbidden ones itself.</div>';
    const cnt = { forbidden: 0, preflight: 0 };
    for (const h of kinds) if (cnt[h.kind] != null) cnt[h.kind]++;
    const nOn = kinds.filter((h) => !h.off && h.kind !== 'bad').length;
    reqHead.querySelector('.ht-ph-sub').innerHTML = `${nOn} header${nOn === 1 ? '' : 's'}`
      + (cnt.preflight && d.cross ? ` · <span class="w">${cnt.preflight} cause a preflight</span>` : '')
      + (cnt.forbidden ? ` · <span class="b">${cnt.forbidden} dropped by the browser</span>` : '');
    // body
    bodyHead.innerHTML = `<b>Body</b> <span>${hasBody ? bytes(d.bodyBytes) : `${esc(inp.method)} has no body`}</span>`;
    bodyTa.hidden = !hasBody && !String(inp.body || '').trim();
    bodyTa.disabled = !hasBody;
    if (bodyTa.value !== String(inp.body ?? '') && document.activeElement !== bodyTa) bodyTa.value = inp.body ?? '';
    const jsonBad = (res.warnings || []).find((w) => /not valid JSON/.test(w));
    const bodyNotes = (res.notes || []).filter((n) => /body/i.test(n) && !/preflight/.test(n));
    bodyNote.innerHTML = jsonBad ? `<span class="b">${esc(jsonBad)}</span>` : bodyNotes.map((n) => `<span>${esc(n)}</span>`).join('')
      || (hasBody && String(inp.body || '').trim() && /^\s*[[{]/.test(inp.body) ? '<span class="ok">valid JSON</span>' : '');
    bodyTa.classList.toggle('bad', !!jsonBad);
  }

  function drawRes(d) {
    const r = d.response;
    const raw = String(ctx.raw.response || '');
    const tools = el('span', { class: 'ht-ph-tools' });
    const pBtn = el('button', { class: 'ht-chip', type: 'button', 'aria-expanded': String(pasteOpen) }, pasteOpen ? 'Hide raw' : (r ? 'Raw' : 'Paste'));
    pBtn.addEventListener('click', () => { pasteOpen = !pasteOpen; render(ctx.result); if (pasteOpen) requestAnimationFrame(() => pasteTa.focus()); });
    const cBtn = el('button', { class: 'ht-chip', type: 'button' }, 'Clear');
    cBtn.disabled = !raw.trim();
    cBtn.addEventListener('click', () => ctx.set('response', ''));
    tools.append(pBtn, cBtn);
    resHead.replaceChildren();
    const keepPaste = document.activeElement === pasteTa;
    if (!keepPaste && pasteTa.value !== raw) pasteTa.value = raw;
    pasteBox.hidden = !(pasteOpen || !r);
    if (!r) {
      resHead.append(el('b', {}, 'Response'), el('span', { class: 'ht-ph-sub' }, 'none yet'), tools);
      resView.replaceChildren(el('div', { class: 'ht-empty' }, served
        ? 'Send the request, or paste what curl -i printed (status line, headers, a blank line, the body).'
        : 'Opened from a file: paste a captured response (curl -i output works). Inside the app, Send makes the request.'));
      return;
    }
    if (r.error) {
      resHead.append(el('b', {}, 'Response'), el('span', { class: 'ht-ph-sub b' }, 'failed'), tools);
      resView.replaceChildren(el('div', { class: 'ht-err' }, `<b>No response</b><p>${esc(r.error)}</p><p class="s">${esc((ctx.result.warnings || []).find((w) => /failed before/.test(w)) || '')}</p>`));
      return;
    }
    const tone = r.cls === 2 ? 'ok' : r.cls === 3 ? 'redir' : r.cls >= 4 ? 'bad' : '';
    resHead.append(el('span', { class: `ht-code ${tone}` }, `${r.status}`), el('b', {}, esc(r.statusText || '')),
      el('span', { class: 'ht-ph-sub' }, esc(r.meaning && r.meaning !== r.statusText ? r.meaning : '')), tools);
    const parts = [];
    // header lines, each with what it tells
    const byCheck = Object.fromEntries(r.checks.map((c) => [c.check, c]));
    const lines = r.headers.map((h) => {
      const c = h.check ? byCheck[h.check] : null;
      return `<div class="ht-rh${c ? ' has' : ''}"><span class="n">${esc(h.name)}</span><span class="v">${esc(h.value)}</span>${c ? `<span class="ht-tag ok" title="${esc(c.finding)}">${esc(c.check)}</span>` : ''}</div>`;
    });
    const missing = r.checks.filter((c) => !c.present).map((c) => {
      const warn = ['HSTS', 'nosniff', 'CSP'].includes(c.check) || (c.check === 'CORS' && d.cross);
      return `<div class="ht-rh miss${warn ? ' w' : ''}"><span class="n">${esc(c.check)}</span><span class="v">${esc(c.finding)}</span></div>`;
    });
    parts.push(`<div class="ht-sub"><b>Headers</b> <span>${r.headers.length}</span></div><div class="ht-rhs">${lines.join('') || '<div class="ht-empty">none</div>'}</div>`);
    if (missing.length) parts.push(`<div class="ht-sub"><b>Not in the response</b> <span>what that means</span></div><div class="ht-rhs">${missing.join('')}</div>`);
    parts.push(`<div class="ht-sub"><b>Body</b> <span>${bytes(r.size)}${r.contentType ? ` · ${esc(r.contentType)}` : ''}${r.encoding ? ` · ${esc(r.encoding)}` : ''}</span></div>`
      + (r.body ? `<pre class="ht-pre" tabindex="0">${esc(r.body)}</pre>` : '<div class="ht-empty">empty</div>'));
    const wrap = el('div', { class: 'ht-resin' }, parts.join(''));
    resView.replaceChildren(wrap);
  }

  function render(res) {
    const d = res && res.drawing;
    const raw = ctx.raw;
    if (methodSel.value !== String(raw.method)) methodSel.value = raw.method;
    methodSel.dataset.m = raw.method;
    if (urlIn.value !== String(raw.url ?? '') && document.activeElement !== urlIn) urlIn.value = raw.url ?? '';
    if (tIn.value !== String(raw.timeout ?? '') && document.activeElement !== tIn) tIn.value = raw.timeout ?? '';
    cookie.checked = !!raw.cookies;
    sendBtn.disabled = busy || !served || !String(raw.url || '').trim();
    sendBtn.textContent = busy ? 'Sending…' : `Send ${raw.method}`;
    sendBtn.title = served ? 'Make the request from this page with fetch()' : 'Open the tool in the app to send; here, paste a captured response';
    const warns = (res?.warnings || []);
    statusLine.innerHTML = (busyMsg ? `<span class="${/^[23]\d\d/.test(busyMsg) ? 'ok' : busy ? '' : 'w'}">${esc(busyMsg)}</span>` : '')
      + warns.filter((w) => !/failed before any response|not valid JSON/.test(w)).map((w) => `<span class="w">${esc(w)}</span>`).join('');
    if (!d) { svg.innerHTML = ''; return; }
    // the wire is shorter until there is an answer to draw along the time axis
    const tall = d.response && !d.response.error && d.response.timing?.total != null;
    wireBox.style.height = tall ? '' : (d.preflight ? '232px' : '200px');
    drawWire(d, res);
    drawReq(d, res);
    drawRes(d);
    const notes = res.notes || [];
    notesEl.innerHTML = `<summary>Notes (${notes.length})</summary>${notes.map((n) => `<p>${esc(n)}</p>`).join('')}`;
  }

  // header chips on the arrow: click / Enter switches the header on or off
  const toggleLine = (line) => {
    const lines = String(ctx.raw.headers || '').split(/\r?\n/);
    const i = line - 1;
    if (lines[i] == null) return;
    const t = lines[i].trim();
    lines[i] = t.startsWith('#') ? t.replace(/^#\s*/, '') : `# ${t}`;
    ctx.set('headers', lines.join('\n'));
  };
  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.ht-hchip');
    if (g) toggleLine(Number(g.dataset.line));
  });
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest('.ht-hchip');
    if (!g || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const line = g.dataset.line;
    toggleLine(Number(line));
    requestAnimationFrame(() => svg.querySelector(`.ht-hchip[data-line="${line}"]`)?.focus());
  });

  ctx.onResult((res) => render(res));
  let lastW = 0, rz = 0;
  new ResizeObserver(() => {
    if (wireBox.clientWidth === lastW) return;
    lastW = wireBox.clientWidth;
    cancelAnimationFrame(rz); rz = requestAnimationFrame(() => ctx.result && render(ctx.result));
  }).observe(wireBox);
}
