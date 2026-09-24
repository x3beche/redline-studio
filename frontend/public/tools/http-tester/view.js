// The live half: sends the request with fetch() from this page, measures it
// (performance.now around fetch, plus the Resource Timing entry where the
// browser exposes it) and writes status, timing, headers and body into the
// Response input, so run() reads it like a pasted capture.
import { parseHeaders } from './tool.js';

const S = { busy: false, msg: '' };
const MAX_BODY = 60000;

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

async function send(raw, input, api, redraw) {
  const method = String(raw.method || 'GET').toUpperCase();
  const url = String(raw.url || '').trim();
  if (!url) return;
  if (location.protocol === 'https:' && /^http:/i.test(url)) {
    api.set('response', 'ERROR mixed content: this page is https and the browser blocks http:// requests. Use https:// or open the app over http.');
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
  S.busy = true; S.msg = `${method} ${url}…`; redraw();
  const t0 = performance.now();
  let text;
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
    S.msg = `${res.status} in ${Math.round(t1 - t0)} ms${dropped.length ? ` (the browser refused headers: ${dropped.join(', ')})` : ''}.`;
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    text = aborted ? `ERROR timeout: no answer within ${secs} s` : `ERROR ${err && err.message ? err.message : err}`;
    S.msg = aborted ? `Timed out after ${secs} s.` : 'Failed: no response reached the page.';
  } finally { clearTimeout(timer); S.busy = false; }
  api.set('response', text);
}

export function view(el, result, input, api) {
  const served = /^https?:/.test(location.protocol);
  const draw = () => {
    el.replaceChildren($('div', { class: 'k-block' },
      $('div', { class: 'k-title' }, 'Live request'),
      !served
        ? $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app to send the request from the page. Here you can paste a captured response (status line, headers, blank line, body) and use the curl command.')
        : $('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
          $('button', { class: 'k-btn k-primary', disabled: S.busy || !String(api.raw.url || '').trim(), onclick: () => send(api.raw, input, api, draw) },
            S.busy ? 'Sending…' : `Send ${String(api.raw.method || 'GET').toUpperCase()}`),
          $('button', { class: 'k-btn', disabled: S.busy || !String(api.raw.response || '').trim(), onclick: () => { S.msg = ''; api.set('response', ''); } }, 'Clear response'),
          $('span', { style: `font-size:12px;color:var(${/^[23]\d\d/.test(S.msg) ? '--ok' : S.msg && !S.busy ? '--warn' : '--ink-soft'})`, role: 'status' }, S.msg || 'The response is written into the Response field.'),
          $('span', { style: 'font-size:11px;color:var(--ink-soft);flex-basis:100%' }, 'Sent from this page, so the browser\'s rules apply: CORS for other origins, no forbidden headers, http:// blocked from https pages.'))));
  };
  draw();
}
