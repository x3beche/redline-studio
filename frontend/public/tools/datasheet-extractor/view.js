// Datasheet Snippet Extractor, custom page: the datasheet page and the part
// read out of it, side by side and linked line by line.
//   Page    - the datasheet text as a sheet of paper with line numbers. The
//             ratings and pin tables found are tinted, every line that became
//             a row carries a mark in the margin, and lines inside a table that
//             could not be read are hatched amber. Click a row line to select
//             what was read from it. "Edit text" turns the sheet into the text
//             input; "Read a PDF" converts a PDF in the app (pdftotext -layout,
//             offline, POST /api/tools/check kind "pdftext") into that text.
//   Package - the pins drawn as a part: numbered pads around a body (dual row,
//             quad, or a ball grid for A1-style numbers), coloured by type,
//             named outside. Click or arrow through the pads.
//   Ratings - the absolute maximum rows as ranges on one axis per unit, text
//             limits ("VIN + 0.3", "Internally limited") shown as text.
// Selecting a pad or a rating shows its full row and lights and scrolls to its
// source line(s) on the page; everything drawn comes from run()'s result.sheet.

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
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const KIND = {
  pwr: ['Power', 'var(--tool-pwr)'], gnd: ['Ground', 'var(--tool-gnd)'], in: ['Input', 'var(--tool-in)'], out: ['Output', 'var(--tool-out)'],
  io: ['In/out', 'var(--tool-io)'], an: ['Analog', 'var(--tool-an)'], nc: ['No connect', 'var(--tool-nc)'], other: ['Other', 'var(--tool-oth)'],
};

// Pages worth keeping from a PDF: the ratings table, or a pin table's header.
const TABLE_PAGE = /absolute\s+maximum\s+ratings?|pin\s+(description|functions|assignments?|configuration)|\b(ball|pin|no\.?)\s{2,}.*\b(name|symbol|signal)\b|\b(name|symbol)\s{2,}.*\b(no\.?|pin|ball)\s{2,}/i;
const TOC = /(\.\s*){5,}|(·\s*){4,}/;
const b64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',', 2)[1] || '');
  r.onerror = () => reject(r.error || new Error('could not read the file'));
  r.readAsDataURL(file);
});

const fmtV = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toPrecision(4))).replace('-', '−') : String(v ?? '–'));

/** "1", "2,5", "1-4", "A1", "EP" -> list of pad ids. */
function padIds(pin) {
  const out = [];
  for (const part of String(pin || '').split(/[,/&]/)) {
    const t = part.trim();
    if (!t || t === '–') continue;
    const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(t);
    if (m && +m[2] > +m[1] && +m[2] - +m[1] < 200) { for (let i = +m[1]; i <= +m[2]; i++) out.push(String(i)); } else out.push(t.toUpperCase());
  }
  return out;
}

const CSS = `
:root {
  --tool-pwr: #c0392b; --tool-gnd: #3d4a56; --tool-in: #1f6fd0; --tool-out: #0f8a5f; --tool-io: #8a4fc2; --tool-an: #b7791f; --tool-nc: #a4b0bb; --tool-oth: #6b7c8c;
  --tool-paper: #fdfdfb; --tool-amr: rgba(31, 78, 216, .07); --tool-pins: rgba(15, 138, 95, .08); --tool-miss: rgba(183, 121, 31, .30); --tool-body: #28323c; --tool-body-ink: #e8edf2;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --tool-pwr: #ef7b6e; --tool-gnd: #a9b6c2; --tool-in: #6aa6ff; --tool-out: #4fcf97; --tool-io: #bf93f2; --tool-an: #e8b04d; --tool-nc: #52606c; --tool-oth: #8ea0b0;
  --tool-paper: #121a21; --tool-amr: rgba(109, 141, 255, .10); --tool-pins: rgba(79, 207, 151, .09); --tool-miss: rgba(232, 167, 53, .28); --tool-body: #0b1116; --tool-body-ink: #cfd9e2; } }
:root[data-theme="dark"] {
  --tool-pwr: #ef7b6e; --tool-gnd: #a9b6c2; --tool-in: #6aa6ff; --tool-out: #4fcf97; --tool-io: #bf93f2; --tool-an: #e8b04d; --tool-nc: #52606c; --tool-oth: #8ea0b0;
  --tool-paper: #121a21; --tool-amr: rgba(109, 141, 255, .10); --tool-pins: rgba(79, 207, 151, .09); --tool-miss: rgba(232, 167, 53, .28); --tool-body: #0b1116; --tool-body-ink: #cfd9e2; }
.k-page { padding: 12px; }
.ds-panel[hidden], .ds-pdf[hidden] { display: none; }
.ds { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); align-items: start; }
@media (max-width: 1000px) { .ds { grid-template-columns: minmax(0, 1fr); } }
.ds-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.ds-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); min-height: 40px; }
.ds-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.ds-sub { font-size: 11.5px; color: var(--ink-soft); }
.ds-grow { flex: 1; }
.ds-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.ds-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; color: var(--ink-soft); cursor: pointer; }
.ds-seg button + button { border-left: 1px solid var(--line); }
.ds-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.ds-f { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.ds-f input[type=text] { width: 11em; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.ds-f input.pg { width: 4em; }

/* the page */
.ds-pdf { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); background: var(--sunken); font-size: 12px; }
.ds-pdf input[type=file] { font-size: 12px; max-width: 100%; }
.ds-pdf .msg { flex-basis: 100%; font-size: 11.5px; color: var(--ink-soft); }
.ds-pdf .msg.ok { color: var(--ok); } .ds-pdf .msg.bad { color: var(--danger); }
.ds-sheetwrap { max-height: max(360px, min(900px, calc(100vh - 176px))); overflow: auto; background: var(--sunken); padding: 10px; border-radius: 0 0 6px 6px; }
.ds-sheet { background: var(--tool-paper); border: 1px solid var(--line); box-shadow: 0 1px 3px rgba(0,0,0,.12); min-width: max-content; padding: 8px 0; font: 11.5px/1.55 "IBM Plex Mono", ui-monospace, monospace; }
.ds-ln { display: flex; white-space: pre; position: relative; }
.ds-ln .n { width: 3.6em; flex: none; text-align: right; padding-right: 10px; color: var(--ink-soft); opacity: .55; user-select: none; }
.ds-ln .m { width: 18px; flex: none; display: flex; align-items: center; justify-content: center; }
.ds-ln .m i { width: 8px; height: 8px; border-radius: 2px; display: block; }
.ds-ln .t { padding-right: 16px; }
.ds-ln.amr { background: var(--tool-amr); }
.ds-ln.pins { background: var(--tool-pins); }
.ds-ln.head .t { font-weight: 600; }
.ds-ln.miss .t { background: repeating-linear-gradient(135deg, var(--tool-miss) 0 4px, transparent 4px 8px); }
.ds-ln.row { cursor: pointer; }
.ds-ln.row:hover .t { text-decoration: underline dotted var(--ink-soft); }
.ds-ln.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ds-ln.sel { box-shadow: inset 3px 0 0 var(--accent); }
.ds-ln.sel .t, .ds-ln.sel .n { background: color-mix(in srgb, var(--accent) 22%, transparent); opacity: 1; color: var(--ink); }
.ds-ln .tag { position: sticky; right: 4px; margin-left: auto; font: 10px "IBM Plex Sans", sans-serif; padding: 0 5px; border-radius: 3px; align-self: center; color: var(--ink-soft); background: var(--surface); border: 1px solid var(--line-soft); }
.ds-ln .tag.warn { color: var(--warn); border-color: var(--warn); }
.ds-edit { width: 100%; min-height: 100%; height: calc(100vh - 200px); max-height: 880px; border: 1px solid var(--line); border-radius: 4px; background: var(--tool-paper); color: var(--ink); font: 11.5px/1.55 "IBM Plex Mono", ui-monospace, monospace; padding: 8px 10px; resize: vertical; white-space: pre; }

/* right column */
.ds-right { display: grid; gap: 12px; min-width: 0; }
.ds-pkg { display: block; width: 100%; touch-action: manipulation; }
.ds-pad { cursor: pointer; outline: none; }
.ds-pad .p { stroke: var(--surface); stroke-width: 1; }
.ds-pad .o { fill: none; stroke: transparent; stroke-width: 2.5; }
.ds-pad.sel .o { stroke: var(--accent); }
.ds-pad:focus-visible .o { stroke: var(--accent); stroke-dasharray: 3 2; }
.ds-pad.empty .p { fill: var(--sunken); stroke: var(--line); stroke-dasharray: 2 2; }
.ds-pad text { pointer-events: none; }
.ds-pad .num { font: 600 10px "IBM Plex Mono", ui-monospace, monospace; fill: #fff; }
.ds-pad.empty .num, .ds-pad.nc .num { fill: var(--ink-soft); }
.ds-pad .nm { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.ds-pad.sel .nm { fill: var(--accent); }
.ds-pad .ty { font: 10px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); }
.ds-body { fill: var(--tool-body); stroke: var(--line); }
.ds-bodyt { font: 600 13px "IBM Plex Mono", ui-monospace, monospace; fill: var(--tool-body-ink); }
.ds-bodys { font: 10.5px "IBM Plex Sans", sans-serif; fill: var(--tool-body-ink); opacity: .7; }
.ds-dot { fill: var(--tool-body-ink); opacity: .8; }
.ds-legend { display: flex; flex-wrap: wrap; gap: 3px 12px; padding: 6px 10px 8px; font-size: 11px; color: var(--ink-soft); border-top: 1px solid var(--line-soft); }
.ds-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.ds-empty { padding: 18px 12px; color: var(--ink-soft); font-size: 12px; }
.ds-rat { display: block; width: 100%; }
.ds-rrow { cursor: pointer; outline: none; }
.ds-rrow .bg { fill: transparent; }
.ds-rrow:hover .bg { fill: var(--sunken); }
.ds-rrow.sel .bg { fill: color-mix(in srgb, var(--accent) 16%, transparent); }
.ds-rrow:focus-visible .bg { stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 3 2; }
.ds-rrow .bar { fill: var(--tool-in); opacity: .75; }
.ds-rrow .bar.t { fill: var(--tool-an); }
.ds-rrow .open { fill: none; stroke: var(--tool-an); stroke-width: 1.5; stroke-dasharray: 4 3; }
.ds-rrow .lbl { font: 12px "IBM Plex Sans", sans-serif; fill: var(--ink); }
.ds-rrow .cnd { font: 11px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); }
.ds-rrow .v { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.ds-rrow .v.soft { fill: var(--ink-soft); font-style: italic; }
.ds-uhead { font: 600 11px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); letter-spacing: .03em; }
.ds-ax { font: 10px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.ds-grid { stroke: var(--line-soft); }
.ds-zero { stroke: var(--ink-soft); stroke-dasharray: 2 2; }
.ds-detail { padding: 8px 12px 10px; display: grid; gap: 4px; font-size: 12px; border-top: 1px solid var(--line-soft); min-height: 58px; }
.ds-detail .t { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.ds-detail b { font: 600 14px "IBM Plex Mono", ui-monospace, monospace; }
.ds-detail .soft { color: var(--ink-soft); }
.ds-detail .ln { margin-left: auto; font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--accent); cursor: pointer; background: none; border: 0; padding: 0; }
.ds-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 0 6px; border-radius: 3px; border: 1px solid currentColor; }
.ds-foot { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; margin-top: 12px; }
@media (max-width: 1000px) { .ds-foot { grid-template-columns: minmax(0, 1fr); } .ds-sheetwrap { max-height: 60vh; } .ds-right { order: -1; } }
.ds-msgs { display: grid; gap: 8px; min-width: 0; }
.ds-msgs .k-warns:empty, .ds-msgs .k-notes:empty { display: none; }
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  const state = { sel: null, edit: false, pdf: { file: null, busy: false, msg: '', tone: '', first: '1', last: '', only: true } };
  const sheet = () => ctx.result?.sheet || null;

  // ---------- skeleton ----------
  const partIn = h('input', { type: 'text', 'aria-label': 'Part', spellcheck: 'false', placeholder: 'MPN' });
  partIn.addEventListener('input', () => ctx.set('part', partIn.value));
  const whatSeg = h('div', { class: 'ds-seg', role: 'group', 'aria-label': 'Extract' });
  const editBtn = h('button', { class: 'k-btn', type: 'button', onclick: () => { state.edit = !state.edit; render(); if (state.edit) sheetWrap.querySelector('textarea')?.focus(); } });
  const pdfBtn = h('button', { class: 'k-btn', type: 'button', onclick: () => { pdfBar.hidden = !pdfBar.hidden; drawPdf(); } }, 'Read a PDF…');
  const pageSub = h('span', { class: 'ds-sub' });
  const pdfBar = h('div', { class: 'ds-pdf', hidden: true });
  const sheetWrap = h('div', { class: 'ds-sheetwrap' });
  const left = h('section', { class: 'ds-panel' },
    h('div', { class: 'ds-head' }, h('h2', {}, 'Datasheet page'), pageSub, h('span', { class: 'ds-grow' }), pdfBtn, editBtn),
    pdfBar, sheetWrap);

  const pkgHead = h('div', { class: 'ds-head' });
  const pkgStage = h('div');
  const pkgLegend = h('div', { class: 'ds-legend' });
  const pkgPanel = h('section', { class: 'ds-panel' }, pkgHead, pkgStage, pkgLegend);
  const ratHead = h('div', { class: 'ds-head' });
  const ratStage = h('div');
  const ratPanel = h('section', { class: 'ds-panel' }, ratHead, ratStage);
  const detail = h('div', { class: 'ds-detail', 'aria-live': 'polite' });
  const top = h('div', { class: 'ds-head' }, h('label', { class: 'ds-f' }, 'Part', partIn), whatSeg);
  const selPanel = h('section', { class: 'ds-panel' }, top, detail);
  const right = h('div', { class: 'ds-right' }, selPanel, pkgPanel, ratPanel);
  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  root.append(h('div', { class: 'ds' }, left, right),
    h('div', { class: 'ds-foot' }, h('div', { class: 'ds-msgs' }, warns, notes), ctx.outputs));

  // ---------- selection ----------
  const selItem = () => {
    const s = sheet(); if (!s || !state.sel) return null;
    return state.sel.kind === 'pin' ? s.pins[state.sel.i] : s.absmax[state.sel.i];
  };
  const linesOf = (it) => (it ? [it.line, ...(it.more || [])] : []);
  function select(sel, { scroll = true, focus = null } = {}) {
    state.sel = sel; render();
    if (scroll) scrollToSel();
    if (focus === 'pad') pkgStage.querySelector('.ds-pad.sel')?.focus({ preventScroll: true });
    if (focus === 'rat') ratStage.querySelector('.ds-rrow.sel')?.focus({ preventScroll: true });
    if (focus === 'line') sheetWrap.querySelector('.ds-ln.sel')?.focus({ preventScroll: true });
  }
  function scrollToSel() {
    const el = sheetWrap.querySelector('.ds-ln.sel'); if (!el) return;
    const wr = sheetWrap.getBoundingClientRect(), er = el.getBoundingClientRect();
    if (er.top < wr.top + 20 || er.bottom > wr.bottom - 20) sheetWrap.scrollTop += er.top - wr.top - wr.height / 3;
  }

  // ---------- the page ----------
  function drawSheet(s) {
    const text = String(ctx.raw.text ?? '');
    editBtn.textContent = state.edit ? 'Done editing' : 'Edit text';
    editBtn.setAttribute('aria-pressed', String(state.edit));
    if (state.edit) {
      if (!sheetWrap.querySelector('textarea')) {
        const ta = h('textarea', { class: 'ds-edit', spellcheck: 'false', 'aria-label': 'Datasheet text (pdftotext -layout)' });
        ta.value = text;
        ta.addEventListener('input', () => ctx.set('text', ta.value));
        sheetWrap.replaceChildren(ta);
      }
      pageSub.textContent = 'columns must keep their spacing';
      return;
    }
    // Lines as run() numbers them: tabs as four spaces, form feeds as line breaks.
    const lines = text.replace(/\t/g, '    ').replace(/\f/g, '\n').split(/\r?\n/);
    const info = new Map();
    const put = (n, k, v) => { const o = info.get(n) || {}; o[k] = v; info.set(n, o); };
    if (s) {
      for (const r of s.regions) for (let n = r.from; n <= r.to; n++) put(n, 'region', r.kind);
      for (const r of s.regions) put(r.from, 'head', true);
      s.absmax.forEach((r, i) => put(r.line, 'row', { kind: 'amr', i }));
      s.pins.forEach((p, i) => { put(p.line, 'row', { kind: 'pin', i }); for (const m of p.more) put(m, 'cont', { kind: 'pin', i }); });
      for (const u of s.unparsed) put(u.line, 'miss', true);
    }
    const selLines = new Set(linesOf(selItem()));
    const scrollTop = sheetWrap.scrollTop;
    const doc = h('div', { class: 'ds-sheet', role: 'list', 'aria-label': 'Datasheet text' });
    lines.forEach((t, k) => {
      const n = k + 1, o = info.get(n) || {};
      const row = o.row || o.cont;
      const cls = ['ds-ln', o.region === 'absmax' ? 'amr' : o.region === 'pins' ? 'pins' : '', o.head ? 'head' : '', o.miss ? 'miss' : '', row ? 'row' : '', selLines.has(n) ? 'sel' : ''].filter(Boolean).join(' ');
      let mark = null;
      if (o.row) {
        const col = o.row.kind === 'pin' ? KIND[s.pins[o.row.i].kind][1] : 'var(--tool-in)';
        mark = h('i', { style: `background:${col}` });
      }
      const tag = o.head ? h('span', { class: 'tag' }, o.region === 'absmax' ? 'ratings table' : 'pin table')
        : o.miss ? h('span', { class: 'tag warn' }, 'not read') : null;
      doc.append(h('div', { class: cls, role: 'listitem', tabindex: row ? 0 : null, 'data-kind': row?.kind, 'data-i': row?.i, 'data-n': n,
        title: o.miss ? 'Inside a table but not read: check this line against the PDF' : row ? 'Click to select what was read from this line' : null },
      h('span', { class: 'n' }, n), h('span', { class: 'm' }, mark), h('span', { class: 't' }, t || ' '), tag));
    });
    sheetWrap.replaceChildren(doc);
    sheetWrap.scrollTop = scrollTop;
    const nRows = s ? s.absmax.length + s.pins.length : 0;
    pageSub.textContent = s ? `${lines.length} lines · ${nRows} rows read${s.unparsed.length ? ` · ${s.unparsed.length} not read` : ''}` : '';
  }
  sheetWrap.addEventListener('click', (e) => {
    const ln = e.target.closest('.ds-ln.row'); if (!ln) return;
    select({ kind: ln.dataset.kind, i: +ln.dataset.i }, { scroll: false, focus: 'line' });
  });
  sheetWrap.addEventListener('keydown', (e) => {
    const ln = e.target.closest('.ds-ln.row'); if (!ln) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ kind: ln.dataset.kind, i: +ln.dataset.i }, { scroll: false, focus: 'line' }); }
  });

  // ---------- PDF ----------
  async function convert() {
    const P = state.pdf, f = P.file;
    if (!f || P.busy) return;
    if (f.size * 4 / 3 > 20e6) { P.msg = `${f.name} is ${(f.size / 1e6).toFixed(1)} MB; the converter takes about 15 MB. Split the PDF or print the table pages to a new PDF.`; P.tone = 'bad'; drawPdf(); return; }
    const first = Math.max(1, parseInt(P.first, 10) || 1);
    const last = Math.max(0, parseInt(P.last, 10) || 0);
    P.busy = true; P.msg = `Converting ${f.name}…`; P.tone = ''; drawPdf();
    try {
      const input = await b64(f);
      const r = await fetch('/api/tools/check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' },
        body: JSON.stringify({ kind: 'pdftext', input, extra: { first, last } }) });
      if (!r.ok) {
        let why = String(r.status);
        try { why = (await r.json()).detail || why; } catch { /* not JSON */ }
        throw new Error(r.status === 503 ? `the tools image is not built on the server (${why})` : why);
      }
      const out = await r.json();
      if (out.ok === false && !(out.pages || []).length) throw new Error((out.errors || []).map((x) => x.message || x).join('; ') || 'the converter found no text');
      const pages = out.pages || [];
      const keep = P.only ? pages.map((p, i) => [p, i]).filter(([p]) => p.split('\n').some((l) => TABLE_PAGE.test(l) && !TOC.test(l))) : pages.map((p, i) => [p, i]);
      const chosen = keep.length ? keep : pages.map((p, i) => [p, i]);
      const text = chosen.map(([p]) => p).join('\f');
      if (!text.trim()) throw new Error('no text in these pages: the PDF may be scanned images (needs OCR)');
      const nums = chosen.map(([, i]) => i + first);
      P.msg = `${f.name}: ${pages.length} page(s) read${P.only && keep.length ? `, kept ${nums.length} with tables (p. ${nums.join(', ')})` : ''}.`;
      P.tone = 'ok'; P.busy = false;
      const part = String(ctx.raw.part || '').trim();
      const upd = { text };
      if (!part || part === 'SAMPLE-LDO') upd.part = f.name.replace(/\.pdf$/i, '').slice(0, 60);
      state.sel = null; state.edit = false;
      ctx.setMany(upd);
      drawPdf();
    } catch (e) {
      P.busy = false; P.msg = `Not converted: ${e.message || e}.`; P.tone = 'bad'; drawPdf();
    }
  }
  function drawPdf() {
    if (pdfBar.hidden) return;
    const P = state.pdf;
    if (!/^https?:/.test(location.protocol)) {
      pdfBar.replaceChildren(h('span', { class: 'msg' }, 'Open this tool in the app to convert a PDF here. As a file it cannot: run pdftotext -layout datasheet.pdf - and paste the table pages with Edit text.'));
      return;
    }
    const picker = h('input', { type: 'file', accept: 'application/pdf,.pdf', 'aria-label': 'Datasheet PDF',
      onchange: (e) => { P.file = e.target.files[0] || null; P.msg = P.file ? `${P.file.name}, ${(P.file.size / 1e6).toFixed(2)} MB` : ''; P.tone = ''; drawPdf(); } });
    pdfBar.replaceChildren(picker,
      h('label', { class: 'ds-f' }, 'Pages', h('input', { type: 'text', class: 'pg', value: P.first, 'aria-label': 'First page', oninput: (e) => { P.first = e.target.value; } }),
        'to', h('input', { type: 'text', class: 'pg', value: P.last, placeholder: 'end', 'aria-label': 'Last page', oninput: (e) => { P.last = e.target.value; } })),
      h('label', { class: 'ds-f' }, h('input', { type: 'checkbox', checked: P.only, onchange: (e) => { P.only = e.target.checked; } }), 'only pages with the tables'),
      h('button', { class: 'k-btn k-primary', type: 'button', disabled: P.busy || !P.file, onclick: convert }, P.busy ? 'Converting…' : 'Read PDF'),
      h('span', { class: `msg ${P.tone}`, role: 'status' }, P.msg || 'Converted on the server with pdftotext -layout, offline; the PDF is not stored. Scanned PDFs have no text.'));
    if (P.file) { try { const dt = new DataTransfer(); dt.items.add(P.file); picker.files = dt.files; } catch { /* older browser */ } }
  }

  // ---------- the package ----------
  function drawPackage(s) {
    const want = ctx.raw.what || 'both';
    pkgPanel.hidden = want === 'absmax';
    if (pkgPanel.hidden) return;
    const pins = s ? s.pins : [];
    const byPad = new Map();
    pins.forEach((p, i) => { for (const id of padIds(p.pin)) if (!byPad.has(id)) byPad.set(id, i); });
    const ids = [...byPad.keys()];
    const special = ids.filter((id) => /^(EP|PAD|TAB)$/.test(id));
    const nums = ids.filter((id) => /^\d+$/.test(id)).map(Number);
    const balls = ids.filter((id) => /^[A-Z]{1,2}\d{1,2}$/.test(id));
    pkgHead.replaceChildren(h('h2', {}, 'Pins'), h('span', { class: 'ds-sub' }, pins.length ? `${pins.length} rows · ${ids.length} pads` : ''),
      h('span', { class: 'ds-grow' }), h('span', { class: 'ds-sub' }, 'numbered order, not the package drawing'));
    if (!pins.length) { pkgStage.replaceChildren(h('div', { class: 'ds-empty' }, 'No pin table read. Its header needs a name column (NAME, SYMBOL) and an I/O, TYPE or DESCRIPTION column.')); pkgLegend.replaceChildren(); return; }
    const W = Math.max(300, pkgStage.clientWidth || 560);
    const svg = sv('svg', { class: 'ds-pkg', role: 'group', 'aria-label': 'Pins drawn around the part body' });
    const pads = [];   // {id, x, y, w, h, side}
    let H, body;
    const narrow = W < 460;
    if (balls.length > nums.length) {
      // Ball grid: rows A, B, C... columns 1, 2, 3...
      const rowsL = [...new Set(balls.map((b) => b.match(/^[A-Z]+/)[0]))].sort((a, b) => a.length - b.length || a.localeCompare(b));
      const cols = Math.max(...balls.map((b) => +b.match(/\d+$/)[0]));
      const p = Math.min(46, (W - 80) / cols);
      const gw = p * cols, gh = p * rowsL.length;
      const x0 = (W - gw) / 2, y0 = 40;
      H = y0 + gh + 30;
      body = { x: x0 - 10, y: y0 - 10, w: gw + 20, h: gh + 20 };
      rowsL.forEach((r, ri) => { svg.append(sv('text', { x: x0 - 16, y: y0 + ri * p + p / 2 + 4, class: 'ds-ax', 'text-anchor': 'end' }, r)); });
      for (let c = 1; c <= cols; c++) svg.append(sv('text', { x: x0 + (c - 0.5) * p, y: y0 - 16, class: 'ds-ax', 'text-anchor': 'middle' }, c));
      for (const r of rowsL) for (let c = 1; c <= cols; c++) pads.push({ id: `${r}${c}`, x: x0 + (c - 0.5) * p, y: y0 + rowsL.indexOf(r) * p + p / 2, ball: p * 0.36, side: 'g' });
    } else {
      const N = Math.max(nums.length ? Math.max(...nums) : 0, 1);
      const quad = N > 16;
      const per = quad ? Math.ceil(N / 4) : Math.ceil(N / 2);
      const pitch = quad ? clamp((W - (narrow ? 130 : 280)) / per, 16, 38) : 30;
      const nameW = narrow ? 70 : 110;
      if (!quad) {
        const bw = clamp(W - 2 * (nameW + 40), 90, 170), bh = per * pitch + 16;
        const bx = (W - bw) / 2, by = 22;
        body = { x: bx, y: by, w: bw, h: bh };
        H = by + bh + 22;
        for (let k = 1; k <= N; k++) {
          const left = k <= per;
          const idx = left ? k - 1 : N - k;
          const y = by + 8 + pitch * idx + pitch / 2;
          pads.push({ id: String(k), x: left ? bx - 22 : bx + bw, y: y - 8, w: 22, h: 16, side: left ? 'l' : 'r' });
        }
      } else {
        const side = per * pitch + 20;
        const bx = (W - side) / 2, by = 96;
        body = { x: bx, y: by, w: side, h: side };
        H = by + side + 96;
        for (let k = 1; k <= N; k++) {
          const s4 = Math.floor((k - 1) / per), j = (k - 1) % per;
          const off = 10 + pitch * j + pitch / 2;
          const pw = Math.min(pitch - 4, 14);
          if (s4 === 0) pads.push({ id: String(k), x: bx - 20, y: by + off - pw / 2, w: 20, h: pw, side: 'l' });
          else if (s4 === 1) pads.push({ id: String(k), x: bx + off - pw / 2, y: by + side, w: pw, h: 20, side: 'b' });
          else if (s4 === 2) pads.push({ id: String(k), x: bx + side, y: by + side - off - pw / 2, w: 20, h: pw, side: 'r' });
          else pads.push({ id: String(k), x: bx + side - off - pw / 2, y: by - 20, w: pw, h: 20, side: 't' });
        }
      }
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    svg.append(sv('rect', { class: 'ds-body', x: body.x, y: body.y, width: body.w, height: body.h, rx: 6 }));
    if (!pads[0]?.ball) svg.append(sv('circle', { class: 'ds-dot', cx: body.x + 12, cy: body.y + 12, r: 4 }));
    const cxB = body.x + body.w / 2, cyB = body.y + body.h / 2;
    if (special.length) {
      const i = byPad.get(special[0]);
      const g = sv('g', { class: `ds-pad${state.sel?.kind === 'pin' && state.sel.i === i ? ' sel' : ''}`, tabindex: 0, role: 'button', 'data-i': i, 'aria-label': `${special[0]}: ${pins[i].name}` });
      const ew = body.w * 0.45, eh = body.h * 0.4;
      g.append(sv('rect', { class: 'p', x: cxB - ew / 2, y: cyB - eh / 2 + 10, width: ew, height: eh, rx: 3, style: `fill:${KIND[pins[i].kind][1]};opacity:.55` }),
        sv('rect', { class: 'o', x: cxB - ew / 2 - 3, y: cyB - eh / 2 + 7, width: ew + 6, height: eh + 6, rx: 4 }),
        sv('text', { x: cxB, y: cyB + 14, class: 'nm', 'text-anchor': 'middle', style: 'fill:var(--tool-body-ink)' }, `${special[0]} ${pins[i].name}`));
      svg.append(g);
    }
    const title = String(s.part || '').slice(0, 18);
    svg.append(sv('text', { class: 'ds-bodyt', x: cxB, y: special.length ? body.y + 32 : cyB - 2, 'text-anchor': 'middle' }, title));
    if (!pads[0]?.ball && body.h > 60 && (!special.length || body.h > 150)) svg.append(sv('text', { class: 'ds-bodys', x: cxB, y: special.length ? body.y + 48 : cyB + 16, 'text-anchor': 'middle' }, `${pads.length}${special.length ? ' + EP' : ''} pins`));
    for (const p of pads) {
      const i = byPad.get(p.id);
      const pin = i != null ? pins[i] : null;
      const k = pin ? pin.kind : null;
      const g = sv('g', { class: `ds-pad${pin ? '' : ' empty'}${k === 'nc' ? ' nc' : ''}${pin && state.sel?.kind === 'pin' && state.sel.i === i ? ' sel' : ''}`,
        tabindex: pin ? 0 : null, role: pin ? 'button' : null, 'data-i': pin ? i : null, 'data-pad': p.id,
        'aria-label': pin ? `Pin ${p.id}: ${pin.name}, ${KIND[k][0].toLowerCase()}` : null });
      if (p.ball) {
        g.append(sv('circle', { class: 'p', cx: p.x, cy: p.y, r: p.ball, style: pin ? `fill:${KIND[k][1]}` : null }),
          sv('circle', { class: 'o', cx: p.x, cy: p.y, r: p.ball + 3 }));
        if (pin && p.ball > 12) g.append(sv('text', { x: p.x, y: p.y + 3.5, class: 'num', 'text-anchor': 'middle', style: 'font-size:9px' }, pin.name.slice(0, 4)));
      } else {
        g.append(sv('rect', { class: 'p', x: p.x, y: p.y, width: p.w, height: p.h, rx: 2, style: pin ? `fill:${KIND[k][1]}` : null }),
          sv('rect', { class: 'o', x: p.x - 3, y: p.y - 3, width: p.w + 6, height: p.h + 6, rx: 3 }));
        const vert = p.side === 't' || p.side === 'b';
        g.append(sv('text', { x: p.x + p.w / 2, y: p.y + p.h / 2 + 3.5, class: 'num', 'text-anchor': 'middle', style: vert && p.id.length > 2 ? 'font-size:8px' : null }, p.id));
        if (pin) {
          const name = pin.name.length > 14 ? pin.name.slice(0, 13) + '…' : pin.name;
          if (p.side === 'l') g.append(sv('text', { x: p.x - 7, y: p.y + p.h / 2 + 4, class: 'nm', 'text-anchor': 'end' }, name));
          else if (p.side === 'r') g.append(sv('text', { x: p.x + p.w + 7, y: p.y + p.h / 2 + 4, class: 'nm' }, name));
          else {
            const x = p.x + p.w / 2, y = p.side === 't' ? p.y - 6 : p.y + p.h + 6;
            g.append(sv('text', { x, y, class: 'nm', 'text-anchor': p.side === 't' ? 'start' : 'end', transform: `rotate(-90 ${x} ${y})`, style: 'font-size:10.5px' }, name));
          }
        }
      }
      g.append(sv('title', {}, pin ? `${p.id} ${pin.name}${pin.type ? ` (${pin.type})` : ''}: ${pin.description}` : `${p.id}: not in the pin table`));
      svg.append(g);
    }
    pkgStage.replaceChildren(svg);
    const used = [...new Set(pins.map((p) => p.kind))];
    const missing = pads.filter((p) => !byPad.has(p.id) && !p.ball).length;
    pkgLegend.replaceChildren(...[...Object.entries(KIND).filter(([k]) => used.includes(k)).map(([, [t, c]]) => h('span', {}, h('i', { style: `background:${c}` }), t)),
      missing ? h('span', {}, h('i', { style: 'background:var(--sunken);outline:1px dashed var(--line)' }), `${missing} pad${missing > 1 ? 's' : ''} not in the table`) : null,
      h('span', { style: 'flex-basis:100%' }, 'Click a pad or arrow through them (focused) to see its row and its line on the page.')].filter(Boolean));
  }
  pkgStage.addEventListener('click', (e) => { const g = e.target.closest('.ds-pad[data-i]'); if (g) select({ kind: 'pin', i: +g.dataset.i }, { focus: 'pad' }); });
  pkgStage.addEventListener('keydown', (e) => {
    const g = e.target.closest('.ds-pad[data-i]'); const s = sheet(); if (!g || !s) return;
    const n = s.pins.length, i = +g.dataset.i;
    let j = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = (i + 1) % n;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (e.key === 'Enter' || e.key === ' ') j = i;
    if (j == null) return;
    e.preventDefault(); select({ kind: 'pin', i: j }, { focus: 'pad' });
  });

  // ---------- ratings ----------
  function drawRatings(s) {
    const want = ctx.raw.what || 'both';
    ratPanel.hidden = want === 'pins';
    if (ratPanel.hidden) return;
    const rows = s ? s.absmax : [];
    ratHead.replaceChildren(h('h2', {}, 'Absolute maximum ratings'), h('span', { class: 'ds-sub' }, rows.length ? `${rows.length} rows · stress limits, not operating conditions` : ''));
    if (!rows.length) { ratStage.replaceChildren(h('div', { class: 'ds-empty' }, 'No ratings read. The page needs an "Absolute Maximum Ratings" heading with the table under it.')); return; }
    const groups = [];
    rows.forEach((r, i) => {
      const u = r.unit || '';
      let g = groups.find((x) => x.unit === u);
      if (!g) { g = { unit: u, rows: [] }; groups.push(g); }
      g.rows.push({ r, i });
    });
    const W = Math.max(300, ratStage.clientWidth || 560);
    const narrow = W < 460;
    const LW = narrow ? 128 : Math.min(250, W * 0.36), RW = 16;
    const x0 = LW + 10, x1 = W - RW;
    const RH = narrow ? 34 : 26;
    let y = 8;
    const svg = sv('svg', { class: 'ds-rat', role: 'group', 'aria-label': 'Absolute maximum ratings as ranges' });
    for (const g of groups) {
      const vals = g.rows.flatMap(({ r }) => [r.min, r.max]).filter((v) => typeof v === 'number');
      let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
      if (!vals.length) { lo = 0; hi = 1; }
      const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
      const X = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);
      svg.append(sv('text', { x: 4, y: y + 12, class: 'ds-uhead' }, g.unit ? `IN ${g.unit.toUpperCase()}` : 'NO UNIT'));
      // ticks
      const span = hi - lo, st = 10 ** Math.floor(Math.log10(span / 4));
      const step = [1, 2, 5, 10].map((m) => m * st).find((s2) => span / s2 <= 6) || st * 10;
      const top = y + 18, bot = y + 18 + g.rows.length * RH;
      for (let v = Math.ceil(lo / step) * step; vals.length && v <= hi; v += step) {
        const vv = +v.toPrecision(10);
        svg.append(sv('line', { x1: X(vv), x2: X(vv), y1: top, y2: bot, class: vv === 0 ? 'ds-zero' : 'ds-grid' }),
          sv('text', { x: X(vv), y: y + 12, class: 'ds-ax', 'text-anchor': 'middle' }, fmtV(vv)));
      }
      y = top;
      for (const { r, i } of g.rows) {
        const sel = state.sel?.kind === 'amr' && state.sel.i === i;
        const gr = sv('g', { class: `ds-rrow${sel ? ' sel' : ''}`, tabindex: 0, role: 'button', 'data-i': i,
          'aria-label': `${r.parameter}${r.condition ? `, ${r.condition}` : ''}: ${fmtV(r.min)} to ${fmtV(r.max)} ${r.unit}, line ${r.line}` });
        gr.append(sv('rect', { class: 'bg', x: 0, y, width: W, height: RH, rx: 3 }));
        const two = narrow && r.condition;
        gr.append(sv('text', { x: 6, y: y + (two ? 14 : RH / 2 + 4), class: 'lbl' }, (narrow ? (r.condition || r.parameter) : r.parameter).slice(0, narrow ? 18 : 30)));
        if (!narrow && r.condition) {
          const lblW = Math.min(r.parameter.length, 30) * 6.6 + 12;
          const room = Math.floor((LW - lblW) / 6);
          if (room > 3) gr.append(sv('text', { x: 6 + lblW, y: y + RH / 2 + 4, class: 'cnd' }, r.condition.length > room ? r.condition.slice(0, room - 1) + '…' : r.condition));
        }
        if (two) gr.append(sv('text', { x: 6, y: y + 28, class: 'cnd' }, r.parameter.slice(0, 20)));
        const cy = y + RH / 2;
        const nMin = typeof r.min === 'number', nMax = typeof r.max === 'number';
        if (nMin && nMax) {
          gr.append(sv('rect', { class: 'bar', x: X(r.min), y: cy - 5, width: Math.max(2, X(r.max) - X(r.min)), height: 10, rx: 2 }));
          const a = X(r.min), b = X(r.max);
          if (b - a > 70) {
            gr.append(sv('text', { x: a + 4, y: cy - 8, class: 'v' }, fmtV(r.min)), sv('text', { x: b - 4, y: cy - 8, class: 'v', 'text-anchor': 'end' }, fmtV(r.max)));
          } else gr.append(sv('text', { x: b + 5, y: cy + 4, class: 'v' }, `${fmtV(r.min)} … ${fmtV(r.max)}`));
        } else if (nMin || nMax) {
          const v = nMin ? r.min : r.max, other = nMin ? r.max : r.min;
          const a = X(v);
          gr.append(sv('rect', { class: 'bar', x: a - 1.5, y: cy - 6, width: 3, height: 12 }));
          const dir = nMin ? 1 : -1;
          const end = clamp(a + dir * 90, x0, x1);
          gr.append(sv('path', { class: 'open', d: `M${a},${cy} L${end},${cy}` }));
          const t = other == null ? '' : String(other);
          gr.append(sv('text', { x: a + dir * 4, y: cy - 8, class: 'v', 'text-anchor': nMin ? 'start' : 'end' }, fmtV(v)));
          if (t) gr.append(sv('text', { x: nMin ? Math.min(end + 4, x1 - 4) : Math.max(end - 4, x0), y: cy + 4, class: 'v soft', 'text-anchor': nMin ? (end + 4 > x1 - 60 ? 'end' : 'start') : 'end' }, t));
        } else {
          gr.append(sv('text', { x: x0, y: cy + 4, class: 'v soft' }, [r.min, r.max].filter((v) => v != null && v !== '').join(' … ') || '–'));
        }
        svg.append(gr);
        y += RH;
      }
      y += 12;
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${y}`);
    svg.setAttribute('height', y);
    ratStage.replaceChildren(svg);
  }
  ratStage.addEventListener('click', (e) => { const g = e.target.closest('.ds-rrow'); if (g) select({ kind: 'amr', i: +g.dataset.i }, { focus: 'rat' }); });
  ratStage.addEventListener('keydown', (e) => {
    const g = e.target.closest('.ds-rrow'); const s = sheet(); if (!g || !s) return;
    const n = s.absmax.length, i = +g.dataset.i;
    let j = null;
    if (e.key === 'ArrowDown') j = (i + 1) % n; else if (e.key === 'ArrowUp') j = (i - 1 + n) % n; else if (e.key === 'Enter' || e.key === ' ') j = i;
    if (j == null) return;
    e.preventDefault(); select({ kind: 'amr', i: j }, { focus: 'rat' });
  });

  // ---------- header and detail ----------
  function drawTop(s) {
    if (document.activeElement !== partIn) partIn.value = ctx.raw.part ?? '';
    const want = ctx.raw.what || 'both';
    whatSeg.replaceChildren(...[['both', 'Ratings and pins'], ['absmax', 'Ratings'], ['pins', 'Pins']].map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(want === v), onclick: () => { state.sel = null; ctx.set('what', v); } }, t)));
    const it = selItem();
    const goto = (n) => h('button', { class: 'ln', type: 'button', title: 'Show it on the page', onclick: () => { scrollToSel(); } }, `line ${n}`);
    if (!it) {
      detail.replaceChildren(h('div', { class: 'soft' }, s && (s.pins.length || s.absmax.length)
        ? 'Select a pad, a rating or a marked line on the page to see its row and where it came from.'
        : 'Nothing read yet: paste the table pages with Edit text, or read a PDF.'));
      return;
    }
    if (state.sel.kind === 'pin') {
      const [kn, kc] = KIND[it.kind];
      detail.replaceChildren(h('div', { class: 't' }, h('b', {}, `${it.pin}  ${it.name}`), h('span', { class: 'ds-chip', style: `color:${kc}` }, kn),
        it.type && it.type !== '–' ? h('span', { class: 'soft' }, `type ${it.type}`) : null, goto(it.line)),
      h('div', {}, it.description || h('span', { class: 'soft' }, 'no description')));
    } else {
      detail.replaceChildren(h('div', { class: 't' }, h('b', {}, it.parameter), it.condition ? h('span', {}, it.condition) : null, goto(it.line)),
        h('div', {}, h('span', { class: 'soft' }, 'min '), h('b', { style: 'font-size:13px' }, fmtV(it.min)), h('span', { class: 'soft' }, '   max '), h('b', { style: 'font-size:13px' }, fmtV(it.max)), ' ', it.unit || h('span', { class: 'soft' }, '(no unit)')));
    }
  }

  function render() {
    const res = ctx.result; if (!res) return;
    const s = res.sheet || null;
    if (state.sel) {
      const list = state.sel.kind === 'pin' ? s?.pins : s?.absmax;
      if (!list || !list[state.sel.i]) state.sel = null;
    }
    const act = document.activeElement;
    drawTop(s);
    drawSheet(s);
    drawPackage(s);
    drawRatings(s);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    if (act && !document.contains(act) && act.dataset?.kind) sheetWrap.querySelector(`.ds-ln[data-kind="${act.dataset.kind}"][data-i="${act.dataset.i}"]`)?.focus({ preventScroll: true });
  }
  let lastW = 0;
  new ResizeObserver(() => { const w = right.clientWidth; if (Math.abs(w - lastW) > 4) { lastW = w; render(); } }).observe(right);
  ctx.onResult(() => {
    // New text: keep the edit box as typed, redraw everything else.
    render();
  });
}
