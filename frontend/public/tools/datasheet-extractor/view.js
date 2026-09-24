// The live half of the Datasheet Snippet Extractor: choose a PDF, the app
// converts it with pdftotext -layout inside the offline tools image
// (POST /api/tools/check, kind "pdftext"), and the text of the pages that
// hold the tables is written into the Datasheet text input with api.set -
// so run(), the Prompt and the JSON all read the same text.
// Opened as a file there is no app to convert with: it says so, and pasted
// text still works.

const st = { busy: false, msg: '', tone: '', first: '1', last: '', only: true, file: null };
let ctx = null;

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

// Pages worth keeping: the ratings table, or a pin table's header.
const TABLE_PAGE = /absolute\s+maximum\s+ratings?|pin\s+(description|functions|assignments?|configuration)|\b(ball|pin|no\.?)\s{2,}.*\b(name|symbol|signal)\b|\b(name|symbol)\s{2,}.*\b(no\.?|pin|ball)\s{2,}/i;
const TOC = /(\.\s*){5,}|(·\s*){4,}/;

const b64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',', 2)[1] || '');
  r.onerror = () => reject(r.error || new Error('could not read the file'));
  r.readAsDataURL(file);
});

async function convert() {
  const f = st.file;
  if (!f || st.busy) return;
  if (f.size * 4 / 3 > 20e6) { st.msg = `${f.name} is ${(f.size / 1e6).toFixed(1)} MB; the converter takes about 15 MB. Split the PDF or print the table pages to a new PDF.`; st.tone = 'bad'; draw(); return; }
  const first = Math.max(1, parseInt(st.first, 10) || 1);
  const last = Math.max(0, parseInt(st.last, 10) || 0);
  st.busy = true; st.msg = `Converting ${f.name}…`; st.tone = ''; draw();
  try {
    const input = await b64(f);
    const r = await fetch('/api/tools/check', { method: 'POST', headers: { 'Content-Type': 'application/json','X-Redline-CSRF':'1' },
      body: JSON.stringify({ kind: 'pdftext', input, extra: { first, last } }) });
    if (!r.ok) {
      let why = String(r.status);
      try { why = (await r.json()).detail || why; } catch { /* not JSON */ }
      throw new Error(r.status === 503 ? `the tools image is not built on the server (${why})` : why);
    }
    const out = await r.json();
    if (out.ok === false && !(out.pages || []).length) throw new Error((out.errors || []).map((e) => e.message || e).join('; ') || 'the converter found no text');
    const pages = out.pages || [];
    const keep = st.only ? pages.map((p, i) => [p, i]).filter(([p]) => p.split('\n').some((l) => TABLE_PAGE.test(l) && !TOC.test(l))) : pages.map((p, i) => [p, i]);
    const chosen = keep.length ? keep : pages.map((p, i) => [p, i]);
    const text = chosen.map(([p]) => p).join('\f');
    if (!text.trim()) throw new Error('no text in these pages: the PDF may be scanned images (needs OCR)');
    const nums = chosen.map(([, i]) => i + first);
    st.msg = `${f.name}: ${pages.length} page(s) read${st.only && keep.length ? `, kept ${nums.length} with tables (p. ${nums.join(', ')})` : ''}.`;
    st.tone = 'ok'; st.busy = false;
    const part = String(ctx.api.raw.part || '').trim();
    if (!part || part === 'SAMPLE-LDO') ctx.api.set('part', f.name.replace(/\.pdf$/i, '').slice(0, 60));
    ctx.api.set('text', text);
  } catch (e) {
    st.busy = false; st.msg = `Not converted: ${e.message || e}.`; st.tone = 'bad'; draw();
  }
}

function draw() {
  if (!ctx) return;
  const tone = `var(${st.tone === 'bad' ? '--danger' : st.tone === 'warn' ? '--warn' : st.tone === 'ok' ? '--ok' : '--ink-soft'})`;
  const box = 'width:4.5em;padding:3px 6px;border:1px solid var(--line);border-radius:4px;background:var(--sunken);color:var(--ink);font:12px ui-monospace,monospace';
  const lab = 'font-size:12px;color:var(--ink-soft);display:flex;gap:5px;align-items:center';
  if (!/^https?:/.test(location.protocol)) {
    ctx.el.replaceChildren($('div', { class: 'k-block' }, $('div', { class: 'k-title' }, 'Read a PDF'),
      $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app to convert a PDF here. Opened as a file it cannot: run pdftotext -layout datasheet.pdf - and paste the pages with the tables.')));
    return;
  }
  const picker = $('input', { type: 'file', accept: 'application/pdf,.pdf', 'aria-label': 'Datasheet PDF', style: 'font-size:12px;max-width:100%',
    onchange: (e) => { st.file = e.target.files[0] || null; st.msg = st.file ? `${st.file.name}, ${(st.file.size / 1e6).toFixed(2)} MB` : ''; st.tone = ''; draw(); } });
  ctx.el.replaceChildren($('div', { class: 'k-block' },
    $('div', { class: 'k-title' }, 'Read a PDF'),
    $('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      picker,
      $('label', { style: lab }, 'Pages', $('input', { type: 'text', value: st.first, style: box, 'aria-label': 'First page', oninput: (e) => { st.first = e.target.value; } }),
        'to', $('input', { type: 'text', value: st.last, placeholder: 'end', style: box, 'aria-label': 'Last page', oninput: (e) => { st.last = e.target.value; } })),
      $('label', { style: lab }, $('input', { type: 'checkbox', checked: st.only, onchange: (e) => { st.only = e.target.checked; } }), 'Keep only pages with the tables'),
      $('button', { class: 'k-btn k-primary', disabled: st.busy || !st.file, onclick: convert }, st.busy ? 'Converting…' : 'Read PDF')),
    st.msg ? $('div', { role: 'status', style: `font-size:12px;margin-top:6px;color:${tone}` }, st.msg) : null,
    $('div', { style: 'font-size:11px;color:var(--ink-soft);margin-top:4px' }, 'Converted on the server with pdftotext -layout, offline; the PDF is not stored. Scanned PDFs have no text to read.')));
  // The file input cannot be given a file back after a redraw: keep the chosen one.
  if (st.file) { try { const dt = new DataTransfer(); dt.items.add(st.file); picker.files = dt.files; } catch { /* older browser */ } }
}

export function view(el, result, input, api) {
  ctx = { el, api };
  draw();
}
