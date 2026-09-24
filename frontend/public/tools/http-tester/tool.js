// HTTP request tester. run() is pure: it checks the request (URL, headers,
// body), predicts whether a browser will send a CORS preflight, writes the
// same request as curl / fetch / raw HTTP, and reads a captured response
// (written by view.js after a live send in the app, or pasted).
// Rules from the WHATWG Fetch standard: forbidden request header names (2.2.2),
// CORS-safelisted methods and request headers (2.2.2, 3.2.2 "CORS-preflight
// request"), CORS-safelisted response headers. Status meanings from RFC 9110.
//
// Captured response format (what view.js writes):
//   line 1   "<status> <status text>"   or   "ERROR <message>"
//   "# timing total=<ms> ttfb=<ms> [dns=<ms> connect=<ms> tls=<ms> download=<ms>]"   (optional)
//   header lines "name: value", a blank line, then the body.

const FORBIDDEN = ['accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'set-cookie', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'via'];
const SAFE_CT = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const REASON = { 1: 'informational', 2: 'success', 3: 'redirect', 4: 'client error', 5: 'server error' };
const STATUS = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized: send credentials', 403: 'Forbidden: credentials do not allow this', 404: 'Not Found', 405: 'Method Not Allowed',
  408: 'Request Timeout', 409: 'Conflict', 413: 'Content Too Large', 415: 'Unsupported Media Type: check Content-Type', 422: 'Unprocessable Content: the body failed validation',
  429: 'Too Many Requests: back off (see Retry-After)', 500: 'Internal Server Error', 502: 'Bad Gateway: the upstream server failed', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

export function parseHeaders(text) {
  const ok = [], bad = [];
  for (const [i, raw] of String(text || '').split(/\r?\n/).entries()) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*:\s*(.*)$/.exec(l);
    if (m) ok.push([m[1], m[2]]); else bad.push([i + 1, l]);
  }
  return { ok, bad };
}

const hasBody = (m) => !['GET', 'HEAD'].includes(m);
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function run(input) {
  const warnings = [], notes = [];
  const method = String(input.method || 'GET').toUpperCase();
  const url = String(input.url || '').trim();
  let parsed = null;
  try { parsed = new URL(url, 'http://app.local'); } catch { /* reported below */ }
  const relative = /^\//.test(url);
  if (!url) return { warnings: ['Give a URL: https://… for another server, or /api/… for this app.'] };
  if (!parsed || (!relative && !/^https?:$/.test(parsed.protocol)) || (!relative && !/^https?:\/\//i.test(url))) {
    warnings.push('The URL must start with http://, https:// or / (a path on this app).');
  }
  const { ok: headers, bad } = parseHeaders(input.headers);
  if (bad.length) warnings.push(`Header line(s) ${bad.map((b) => b[0]).join(', ')} are not "Name: value" - left out.`);
  const forb = headers.filter(([k]) => FORBIDDEN.includes(k.toLowerCase()) || /^(proxy-|sec-)/i.test(k));
  if (forb.length) warnings.push(`A browser will not send ${forb.map((h) => h[0]).join(', ')} (forbidden header names, Fetch standard): the live send drops them; curl sends them.`);
  const body = String(input.body ?? '');
  const ct = (headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
  if (body.trim() && !hasBody(method)) notes.push(`The body is ignored: ${method} requests cannot carry one in a browser. Use POST/PUT/PATCH, or move the data to the query string.`);
  if (body.trim() && hasBody(method)) {
    if (/json/i.test(ct) || (!ct && /^\s*[[{]/.test(body))) {
      try { JSON.parse(body); } catch (e) { warnings.push(`The body is not valid JSON (${e.message}): the server will likely answer 400.`); }
      if (!ct) notes.push('The body looks like JSON but there is no Content-Type header: fetch sends it as text/plain. Add Content-Type: application/json.');
    }
  }
  // CORS preflight prediction (Fetch standard): only for cross-origin requests.
  const why = [];
  if (!['GET', 'HEAD', 'POST'].includes(method)) why.push(`method ${method}`);
  for (const [k, v] of headers) {
    const n = k.toLowerCase();
    if (FORBIDDEN.includes(n)) continue;
    if (n === 'content-type') { if (!SAFE_CT.includes(v.split(';')[0].trim().toLowerCase())) why.push(`Content-Type ${v.split(';')[0].trim()}`); }
    else if (!['accept', 'accept-language', 'content-language'].includes(n)) why.push(`header ${k}`);
  }
  const cross = !relative;

  // ---- captured response ----
  const resp = String(input.response || '');
  const values = [
    { label: 'Request', value: `${method} ${relative ? url.split('?')[0] : (parsed?.host || '?')}`, hint: relative ? 'same origin as the app' : 'cross-origin from the app' },
    { label: 'CORS preflight', value: !cross ? 'no (same origin)' : why.length ? 'yes' : 'no', hint: cross && why.length ? why.slice(0, 3).join(', ') : cross ? 'simple request' : '', tone: cross && why.length ? 'warn' : undefined },
  ];
  const tables = [];
  if (resp.trim()) {
    const lines = resp.split(/\r?\n/);
    const first = lines[0].trim();
    if (/^ERROR\b/i.test(first)) {
      values.push({ label: 'Result', value: 'no response', tone: 'bad', hint: first.slice(6, 80) });
      warnings.push(`The request failed before any response: ${first.slice(6)}. In a browser that is almost always CORS (the server does not answer Access-Control-Allow-Origin for this page's origin), mixed content (http:// from an https page), DNS or a refused connection (the browser does not say which; the DevTools console does). Try the curl command: if curl works, it is CORS - allow the app's origin on the server.`);
    } else {
      const sm = /^(?:HTTP\/[\d.]+\s+)?(\d{3})\s*(.*)$/.exec(first);
      if (!sm) warnings.push('The captured response does not start with a status line ("200 OK").');
      const status = sm ? Number(sm[1]) : 0;
      let i = 1;
      const timing = {};
      const rh = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) { i += 1; break; }
        const rd = /^#\s*redirected to\s+(\S+)/i.exec(l.trim());
        if (rd) { notes.push(`The request was redirected; the final URL was ${rd[1]}.`); continue; }
        const tm = /^#\s*timing\s+(.*)$/i.exec(l.trim());
        if (tm) { for (const [, k, v] of tm[1].matchAll(/(\w+)=([\d.]+)/g)) timing[k] = Number(v); continue; }
        const hm = /^([^:\s]+)\s*:\s*(.*)$/.exec(l);
        if (hm) rh.push([hm[1].toLowerCase(), hm[2]]);
      }
      const rbody = lines.slice(i).join('\n');
      const H = (n) => (rh.find(([k]) => k === n) || [])[1];
      const cls = Math.floor(status / 100);
      values.push({ label: 'Status', value: status ? `${status} ${sm[2] || ''}`.trim() : '–', tone: cls === 2 || cls === 3 ? 'ok' : cls >= 4 ? 'bad' : undefined, hint: (STATUS[status] && STATUS[status] !== sm[2] ? STATUS[status] : '') || REASON[cls] || '' });
      if (timing.total != null) values.push({ label: 'Total time', value: Math.round(timing.total), unit: 'ms', hint: timing.ttfb != null ? `first byte ${Math.round(timing.ttfb)} ms` : '' });
      const size = H('content-length') ? Number(H('content-length')) : new TextEncoder().encode(rbody).length;
      values.push({ label: 'Body', value: size >= 1024 ? `${(size / 1024).toFixed(1)} kB` : `${size} B`, hint: (H('content-type') || 'no content-type').split(';')[0] + (H('content-encoding') ? `, ${H('content-encoding')}` : '') });
      if (Object.keys(timing).length > 2) {
        tables.push({ title: 'Timing (Resource Timing API)', columns: ['Phase', 'ms'],
          rows: ['dns', 'connect', 'tls', 'ttfb', 'download', 'total'].filter((k) => timing[k] != null).map((k) => [k, Math.round(timing[k])]) });
      }
      // What the headers say.
      const checks = [];
      const aco = H('access-control-allow-origin');
      checks.push(['CORS', aco ? `allows ${aco}` : cross ? 'no Access-Control-Allow-Origin' : 'same origin, not needed']);
      checks.push(['Caching', H('cache-control') || (H('expires') ? `expires ${H('expires')}` : 'no Cache-Control: the browser guesses (heuristic caching)')]);
      checks.push(['Validator', H('etag') ? `ETag ${H('etag')}` : H('last-modified') ? `Last-Modified ${H('last-modified')}` : 'none: no cheap 304 revalidation']);
      checks.push(['Compression', H('content-encoding') || (size > 1400 ? 'none on a body over 1.4 kB' : 'none (small body)')]);
      if (parsed?.protocol === 'https:' || /^https/i.test(url)) checks.push(['HSTS', H('strict-transport-security') || 'missing']);
      checks.push(['nosniff', H('x-content-type-options') || 'missing']);
      if (/html/i.test(H('content-type') || '')) checks.push(['CSP', H('content-security-policy') ? 'set' : 'missing']);
      tables.push({ title: 'What the headers say', columns: ['Check', 'Finding'], rows: checks });
      tables.push({ title: `Response headers (${rh.length})`, columns: ['Header', 'Value'], rows: rh.map(([k, v]) => [k, v.length > 120 ? v.slice(0, 120) + '…' : v]) });
      if (cross && rh.length && rh.every(([k]) => ['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma'].includes(k))) {
        notes.push('Only the CORS-safelisted response headers are visible to the page for a cross-origin request unless the server lists others in Access-Control-Expose-Headers; curl shows them all.');
      }
      if (status === 401 && !headers.some(([k]) => /^authorization$/i.test(k))) notes.push('401 and no Authorization header was sent: add "Authorization: Bearer <token>" to the headers.');
      if (status === 415) notes.push('415: the server does not accept this Content-Type - for JSON send Content-Type: application/json.');
      if (status === 405) notes.push(`405: the server does not accept ${method} here${H('allow') ? `; it allows ${H('allow')}` : ''}.`);
      if (rbody.trim()) {
        let preview = rbody;
        if (/json/i.test(H('content-type') || '') || /^\s*[[{]/.test(rbody)) {
          try { preview = JSON.stringify(JSON.parse(rbody), null, 2); } catch { /* not JSON after all */ }
        }
        tables.push({ title: 'Body (first 30 lines)', columns: ['Line', 'Text'], rows: preview.split('\n').slice(0, 30).map((l, k) => [k + 1, l.length > 160 ? l.slice(0, 160) + '…' : l]) });
      }
    }
  }

  const hdrArgs = headers.map(([k, v]) => ` \\\n  -H ${sq(`${k}: ${v}`)}`).join('');
  const bodyOk = body.trim() && hasBody(method);
  const absUrl = relative ? `http://127.0.0.1:8001${url}` : url;
  const curl = `curl -sS -i -X ${method}${hdrArgs}${bodyOk ? ` \\\n  --data-raw ${sq(body)}` : ''} \\\n  -w '\\n# timing total=%{time_total}s ttfb=%{time_starttransfer}s dns=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s\\n' \\\n  ${sq(absUrl)}\n`;
  const fetchJs = `const t0 = performance.now();\nconst res = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)},\n${headers.length ? `  headers: ${JSON.stringify(Object.fromEntries(headers.filter(([k]) => !FORBIDDEN.includes(k.toLowerCase()))), null, 2).replace(/\n/g, '\n  ')},\n` : ''}${bodyOk ? `  body: ${JSON.stringify(body)},\n` : ''}});\nconsole.log(res.status, res.statusText, Math.round(performance.now() - t0) + ' ms');\nconsole.log(await res.text());\n`;
  const host = relative ? '127.0.0.1:8001' : parsed?.host || 'example.com';
  const pathq = relative ? url : (parsed ? parsed.pathname + parsed.search : '/');
  const rawReq = `${method} ${pathq} HTTP/1.1\r\nHost: ${host}\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join('')}${bodyOk ? `Content-Length: ${new TextEncoder().encode(body).length}\r\n` : ''}\r\n${bodyOk ? body : ''}`.replace(/\r/g, '');
  if (cross && why.length) notes.push(`From a browser this request is preflighted (${why.join(', ')}): the server must answer OPTIONS with Access-Control-Allow-Origin, -Methods and -Headers, or the real request is never sent.`);
  notes.push('Relative URLs (/api/…) go to this app; in curl they are written against the API at 127.0.0.1:8001.');
  return {
    values, warnings, notes, tables,
    texts: [{ title: 'curl', body: curl, lang: 'sh' }, { title: 'fetch', body: fetchJs, lang: 'js' }, { title: 'Raw request', body: rawReq + '\n', lang: 'http' }],
  };
}
