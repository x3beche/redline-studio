// printf Format Checker, custom page: the code and what printf does with it.
//   Targets  - the five machines as cards with the sizes that matter
//              (int, long, pointer, what uint32_t and size_t are); each card
//              counts the errors this code would have there. Click to switch.
//   Code     - the source itself, editable, every printf-style call marked in
//              the gutter by its worst verdict. Put the caret on a call's line
//              to inspect it.
//   Call     - the selected call: its format string with each conversion as
//              a chip in its verdict's colour, then the argument area as
//              printf sees it: what the caller passed (each argument after
//              promotion, as wide as its bytes) above what the format makes
//              printf read. Where the widths differ, every later read slides
//              off its argument - drawn, not described.
//   Detail   - the chosen conversion: argument, its type, the promotion,
//              what the conversion expects, why, and the fix, with a button
//              that writes the fix into the code.
// Every verdict, type and byte count comes from run()'s result.calls; the
// per-target counts are run() on the same code for each target.
import { run, TARGETS } from './tool.js';

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

const CSS = `
:root { --tool-note: #5b6b7a; --tool-unk: #7a45b0; --tool-code: #fbfcfd; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-note: #8ea0b0; --tool-unk: #c982e0; --tool-code: #0c1217; } }
:root[data-theme="dark"] { --tool-note: #8ea0b0; --tool-unk: #c982e0; --tool-code: #0c1217; }
.k-page { padding: 12px; }
.pf { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.08fr); grid-template-areas: "tg tg" "code call" "out call"; gap: 12px; align-items: start; }
@media (max-width: 980px) { .pf { grid-template-columns: minmax(0, 1fr); grid-template-areas: "tg" "code" "call" "out"; } }
.pf-tg { grid-area: tg; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
@media (max-width: 980px) { .pf-tg { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); } }
.pf-card { text-align: left; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px 7px; cursor: pointer; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.pf-card:hover { border-color: var(--ink-soft); }
.pf-card[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.pf-card .nm { font-weight: 600; font-size: 12.5px; display: flex; gap: 6px; align-items: baseline; }
.pf-card .nm span { margin-left: auto; font: 500 11px "IBM Plex Mono", ui-monospace, monospace; }
.pf-card .sz { display: flex; gap: 8px; align-items: flex-end; }
.pf-card .sz > span { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
.pf-card .sz i { display: block; height: 8px; border-radius: 1px; background: var(--sunken); border: 1px solid var(--line); position: relative; }
.pf-card .sz em { font: 9.5px "IBM Plex Mono", ui-monospace, monospace; font-style: normal; color: var(--ink-soft); display: block; white-space: nowrap; }
.pf-card .td { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.c-error { color: var(--danger); } .c-warning { color: var(--warn); } .c-note { color: var(--tool-note); } .c-ok { color: var(--ok); } .c-unknown { color: var(--tool-unk); }
.pf-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.pf-ph { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); flex-wrap: wrap; }
.pf-ph b { font-size: 13px; }
.pf-ph span { font-size: 11.5px; color: var(--ink-soft); }
.pf-code { grid-area: code; }
.pf-ed { position: relative; display: grid; grid-template-columns: 44px minmax(0, 1fr); background: var(--tool-code); border-bottom: 1px solid var(--line-soft); }
.pf-gut { font: 12.5px/20px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); padding: 8px 0; user-select: none; }
.pf-gut div { display: flex; align-items: center; justify-content: flex-end; gap: 5px; padding-right: 6px; height: 20px; cursor: default; }
.pf-gut div.call { cursor: pointer; }
.pf-gut i { width: 8px; height: 8px; border-radius: 50%; }
.pf-gut i.error { background: var(--danger); } .pf-gut i.warning { background: var(--warn); } .pf-gut i.note { background: var(--tool-note); } .pf-gut i.ok { background: var(--ok); } .pf-gut i.unknown { background: var(--tool-unk); }
.pf-gut div.sel { color: var(--ink); font-weight: 600; }
.pf-wrap { position: relative; min-width: 0; }
.pf-hl, .pf-ta { font: 12.5px/20px "IBM Plex Mono", ui-monospace, monospace; padding: 8px 10px; margin: 0; white-space: pre; tab-size: 4; }
.pf-hl { position: absolute; inset: 0; overflow: hidden; pointer-events: none; color: transparent; }
.pf-hl .ln { display: block; height: 20px; }
.pf-hl .ln.call { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.pf-hl .ln.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.pf-hl mark { color: transparent; border-radius: 2px; }
.pf-hl mark.error { background: color-mix(in srgb, var(--danger) 30%, transparent); box-shadow: 0 2px 0 var(--danger); }
.pf-hl mark.warning { background: color-mix(in srgb, var(--warn) 28%, transparent); box-shadow: 0 2px 0 var(--warn); }
.pf-hl mark.note { box-shadow: 0 2px 0 var(--tool-note); background: transparent; }
.pf-hl mark.unknown { box-shadow: 0 2px 0 var(--tool-unk); background: transparent; }
.pf-hl mark.ok { background: transparent; box-shadow: 0 2px 0 color-mix(in srgb, var(--ok) 60%, transparent); }
.pf-ta { position: relative; display: block; width: 100%; min-height: 260px; resize: vertical; border: 0; background: transparent; color: var(--ink); caret-color: var(--ink); overflow: auto; outline: none; }
.pf-ta:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.pf-more { padding: 8px 10px; display: grid; grid-template-columns: minmax(0, 1fr) 200px; gap: 8px 12px; }
@media (max-width: 560px) { .pf-more { grid-template-columns: minmax(0, 1fr); } }
.pf-more label { display: block; font-size: 11.5px; color: var(--ink-soft); margin-bottom: 3px; }
.pf-more textarea, .pf-more input { width: 100%; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; resize: vertical; }
.pf-more .k-help { margin-top: 3px; }
.pf-call { grid-area: call; display: flex; flex-direction: column; }
.pf-calls { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--line-soft); }
.pf-cchip { border: 1px solid var(--line); background: var(--surface); border-radius: 4px; padding: 1px 7px; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
.pf-cchip i { width: 7px; height: 7px; border-radius: 50%; }
.pf-cchip[aria-pressed="true"] { border-color: var(--accent); background: var(--sunken); font-weight: 600; }
.pf-fmt { padding: 14px 12px 8px; font: 17px/2 "IBM Plex Mono", ui-monospace, monospace; word-break: break-all; }
.pf-fmt .q { color: var(--ink-soft); }
.pf-fmt .lit { color: var(--ink); white-space: pre-wrap; }
.pf-fmt .esc { color: var(--ink-soft); }
.pf-spec { font: inherit; font-weight: 600; border: 1.5px solid; border-radius: 4px; padding: 0 5px; margin: 0 1px; cursor: pointer; background: var(--surface); }
.pf-spec.error { border-color: var(--danger); color: var(--danger); } .pf-spec.warning { border-color: var(--warn); color: var(--warn); }
.pf-spec.note { border-color: var(--tool-note); color: var(--tool-note); } .pf-spec.ok { border-color: var(--ok); color: var(--ok); } .pf-spec.unknown { border-color: var(--tool-unk); color: var(--tool-unk); }
.pf-spec[aria-pressed="true"] { background: var(--sunken); box-shadow: 0 0 0 2px var(--accent); }
.pf-src { padding: 0 12px 8px; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); word-break: break-all; }
.pf-lane { padding: 4px 8px 6px; }
.pf-lane svg { display: block; width: 100%; }
.pf-lane text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.pf-lane .soft { fill: var(--ink-soft); }
.pf-lane .lbl { fill: var(--ink-soft); font-size: 10.5px; }
.pf-lane .box { stroke-width: 1.5; cursor: pointer; }
.pf-lane .box.ok { fill: color-mix(in srgb, var(--ok) 18%, var(--surface)); stroke: var(--ok); }
.pf-lane .box.error { fill: color-mix(in srgb, var(--danger) 18%, var(--surface)); stroke: var(--danger); }
.pf-lane .box.warning { fill: color-mix(in srgb, var(--warn) 18%, var(--surface)); stroke: var(--warn); }
.pf-lane .box.note { fill: color-mix(in srgb, var(--tool-note) 16%, var(--surface)); stroke: var(--tool-note); }
.pf-lane .box.unknown { fill: var(--surface); stroke: var(--tool-unk); stroke-dasharray: 4 3; }
.pf-lane .box.arg { fill: var(--sunken); stroke: var(--ink-soft); }
.pf-lane .box.sel { stroke-width: 3; stroke: var(--accent); }
.pf-lane .slid { fill: url(#pf-hatch); }
.pf-lane .hatch { stroke: var(--danger); stroke-width: 1.5; opacity: .5; }
.pf-lane .tick { stroke: var(--line); }
.pf-lane .conn { stroke: var(--line); stroke-dasharray: 2 3; }
.pf-lane .conn.bad { stroke: var(--danger); stroke-dasharray: none; }
.pf-lnote { font-size: 11px; color: var(--ink-soft); padding: 0 12px 8px; }
.pf-det { margin: 0 10px 10px; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; font-size: 12.5px; }
.pf-det > span { color: var(--ink-soft); }
.pf-det > b { font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; word-break: break-word; }
.pf-det .why { grid-column: 1 / -1; margin-top: 4px; padding: 5px 8px; border-radius: 4px; background: var(--sunken); }
.pf-det .why.error { box-shadow: inset 3px 0 0 var(--danger); } .pf-det .why.warning { box-shadow: inset 3px 0 0 var(--warn); } .pf-det .why.note { box-shadow: inset 3px 0 0 var(--tool-note); } .pf-det .why.ok { box-shadow: inset 3px 0 0 var(--ok); } .pf-det .why.unknown { box-shadow: inset 3px 0 0 var(--tool-unk); }
.pf-det .fixrow { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 4px; }
.pf-det .fixrow code { font-size: 13px; font-weight: 600; }
.pf-det .fixrow .soft { color: var(--ink-soft); font-size: 11.5px; }
.pf-sum { display: flex; flex-wrap: wrap; gap: 3px 14px; font-size: 12px; color: var(--ink-soft); margin-left: auto; }
.pf-sum b { font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.pf-warns:empty { display: none; }
.pf-warns { margin: 0 10px 10px; border-left: 3px solid var(--warn); padding: 4px 8px; font-size: 12px; background: var(--sunken); border-radius: 0 4px 4px 0; }
.pf-warns div + div { margin-top: 2px; }
.pf-empty { padding: 14px 12px; color: var(--ink-soft); font-size: 12.5px; }
.pf-out { grid-area: out; min-width: 0; }
.pf-out .k-out { max-height: 280px; }
`;

const RANK = { error: 4, warning: 3, unknown: 2, note: 1, ok: 0 };
const worst = (items) => items.reduce((a, it) => (RANK[it.sev] > RANK[a] ? it.sev : a), 'ok');
const TNAME = { arm: '32-bit MCU', ilp32: '32-bit Linux', lp64: '64-bit Linux', llp64: 'Win64', avr: 'AVR 8-bit' };
const TSUB = { arm: 'arm-none-eabi, ESP-IDF', ilp32: 'glibc i686 / armhf', lp64: 'x86-64, arm64, macOS', llp64: 'MSVC, MinGW', avr: 'avr-gcc, avr-libc' };
const SPEC_RE = /^%([-+ #0']*)(\*|\d+)?(?:\.(\*|\d*))?(hh|h|ll|l|j|z|t|L|q|I64|I32)?(.)$/;

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const st = { call: 0, item: 0, sig: '' };

  // ------------------------------------------------------------ layout
  const tg = h('div', { class: 'pf-tg', role: 'group', 'aria-label': 'Target' });
  const gut = h('div', { class: 'pf-gut', 'aria-hidden': 'true' });
  const hl = h('pre', { class: 'pf-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'pf-ta', spellcheck: 'false', wrap: 'off', 'aria-label': 'Code with printf calls',
    oninput: (e) => { drawHl(); ctx.set('code', e.target.value); } });
  const decl = h('textarea', { rows: 3, spellcheck: 'false', id: 'pf-decl', oninput: (e) => ctx.set('decls', e.target.value) });
  const extra = h('input', { type: 'text', spellcheck: 'false', id: 'pf-extra', placeholder: 'my_log:1, trace:0', oninput: (e) => ctx.set('extra', e.target.value) });
  const sum = h('div', { class: 'pf-sum', 'aria-live': 'polite' });
  const code = h('section', { class: 'pf-panel pf-code' },
    h('div', { class: 'pf-ph' }, h('b', {}, 'Code'), h('span', {}, 'caret on a call inspects it'), sum),
    h('div', { class: 'pf-ed' }, gut, h('div', { class: 'pf-wrap' }, hl, ta)),
    h('div', { class: 'pf-more' },
      h('div', {}, h('label', { for: 'pf-decl' }, 'Declarations the code does not show'), decl),
      h('div', {}, h('label', { for: 'pf-extra' }, 'Your printf-like functions'), extra, h('div', { class: 'k-help' }, 'name:index of the format argument'))));

  const callsBar = h('div', { class: 'pf-calls', role: 'group', 'aria-label': 'Calls' });
  const callHead = h('div', { class: 'pf-ph' });
  const fmtEl = h('div', { class: 'pf-fmt' });
  const srcEl = h('div', { class: 'pf-src' });
  const lane = h('div', { class: 'pf-lane' });
  const lnote = h('div', { class: 'pf-lnote' });
  const det = h('div', { class: 'pf-det', 'aria-live': 'polite' });
  const warns = h('div', { class: 'pf-warns' });
  const call = h('section', { class: 'pf-panel pf-call' }, callHead, callsBar, fmtEl, srcEl, lane, lnote, det, warns);
  const out = h('div', { class: 'pf-out' }, ctx.outputs);
  root.append(h('div', { class: 'pf' }, tg, code, call, out));

  const syncVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
  const calls = () => ctx.result?.calls || [];

  // ------------------------------------------------------------ targets
  let tgSig = '';
  function drawTargets() {
    const inp = ctx.input;
    const sig = JSON.stringify([inp.code, inp.decls, inp.extra, inp.target]);
    if (sig === tgSig) return;
    tgSig = sig;
    const curT = TARGETS[inp.target] ? inp.target : 'arm';
    tg.replaceChildren(...Object.keys(TARGETS).map((id) => {
      const T = TARGETS[id];
      let e = 0, w = 0;
      try {
        const r = id === curT ? ctx.result : run({ ...inp, target: id });
        for (const v of r.values || []) { if (v.label === 'Errors') e = v.value; if (v.label === 'Warnings') w = v.value; }
      } catch { /* counts stay 0 */ }
      const cells = [['int', T.int], ['long', T.long], ['ptr', T.ptr]].map(([n, b]) => h('span', {}, h('i', { style: `width:${b * 7}px` }), h('em', {}, `${n} ${b}`)));
      return h('button', { class: 'pf-card', 'aria-pressed': String(id === curT), onclick: () => ctx.set('target', id),
        title: T.name },
      h('div', { class: 'nm', title: TSUB[id] }, TNAME[id], h('span', { class: e ? 'c-error' : w ? 'c-warning' : 'c-ok' }, e ? `${e} err` : w ? `${w} warn` : 'clean')),
      h('div', { class: 'sz' }, cells),
      h('div', { class: 'td' }, `uint32_t = ${T.td.uint32_t}`),
      h('div', { class: 'td' }, `size_t = ${T.td.size_t}`));
    }));
  }

  // ------------------------------------------------------------ code editor
  // where each conversion sits in the source, so it can be marked and fixed
  function locate(src, c) {
    const lines = src.split('\n');
    let off = 0;
    for (let i = 0; i < c.line - 1 && i < lines.length; i++) off += lines[i].length + 1;
    const start = src.indexOf(c.name, off);
    if (start < 0) return [];
    let pos = src.indexOf('(', start);
    // the format argument: skip fi top-level commas
    const body = src.slice(pos, pos + 2000);
    const fmtAt = body.indexOf(c.fmtSrc);
    if (fmtAt < 0) return [];
    pos += fmtAt;
    const end = pos + c.fmtSrc.length;
    const found = [];
    let at = pos;
    for (const it of c.items) {
      if (!it.spec || it.kind === 'extra' || it.kind === 'nonliteral') { found.push(null); continue; }
      if (it.kind === 'star') { found.push(null); continue; }
      const k = src.indexOf(it.spec, at);
      if (k < 0 || k + it.spec.length > end) { found.push(null); continue; }
      found.push([k, k + it.spec.length]);
      at = k + it.spec.length;
    }
    return found;
  }
  function drawHl() {
    const src = ta.value;
    const cs = calls();
    const lines = src.split('\n');
    const byLine = new Map();
    cs.forEach((c, i) => { const w = worst(c.items); const cur = byLine.get(c.line); if (!cur || RANK[w] > RANK[cur.sev]) byLine.set(c.line, { sev: w, i }); });
    gut.replaceChildren(...lines.map((_, i) => {
      const b = byLine.get(i + 1);
      return h('div', { class: `${b ? 'call' : ''}${b && b.i === st.call ? ' sel' : ''}`, onclick: b ? () => pick(b.i, 0) : null }, b ? h('i', { class: b.sev }) : null, String(i + 1));
    }));
    // marks: conversions coloured by verdict (only while the text is the one run() saw)
    const marks = [];
    if (src === String(ctx.raw.code ?? '')) cs.forEach((c) => locate(src, c).forEach((r, k) => { if (r) marks.push([...r, c.items[k].sev]); }));
    marks.sort((a, b) => a[0] - b[0]);
    const selLine = cs[st.call]?.line;
    hl.replaceChildren();
    let off = 0;
    lines.forEach((ln, i) => {
      const el = h('span', { class: `ln${byLine.has(i + 1) ? ' call' : ''}${selLine === i + 1 ? ' sel' : ''}` });
      let p = 0;
      for (const [a, b, sev] of marks) {
        if (a < off || b > off + ln.length) continue;
        el.append(ln.slice(p, a - off), h('mark', { class: sev }, ln.slice(a - off, b - off)));
        p = b - off;
      }
      el.append(ln.slice(p) || ' ');
      hl.append(el);
      off += ln.length + 1;
    });
    hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
    ta.rows = Math.max(12, Math.min(28, lines.length + 1));
  }
  ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gut.style.transform = `translateY(${-ta.scrollTop}px)`; });
  const caretPick = () => {
    const line = ta.value.slice(0, ta.selectionStart).split('\n').length;
    const i = calls().findIndex((c) => c.line === line);
    if (i >= 0 && i !== st.call) pick(i, 0, false);
  };
  ta.addEventListener('click', caretPick);
  ta.addEventListener('keyup', (e) => { if (/Arrow|Page|Home|End/.test(e.key)) caretPick(); });

  // ------------------------------------------------------------ fixes
  function applyFix(c, k) {
    const it = c.items[k];
    const src = String(ctx.raw.code ?? '');
    const r = locate(src, c)[k];
    const m = SPEC_RE.exec(it.spec || '');
    if (!r || !m || !it.fix) return;
    const head = `%${m[1] || ''}${m[2] || ''}${m[3] != null ? '.' + m[3] : ''}`;
    let rep = null;
    const simple = /^%(hh|h|ll|l|j|z|t|L)?([a-zA-Z])$/.exec(it.fix);
    const pri = /PRI([a-zA-Z])(\w+)/.exec(it.fix);
    if (simple) rep = head + (simple[1] || '') + simple[2];
    else if (pri) rep = `${head}" PRI${pri[1]}${pri[2]} "`;
    if (!rep) return;
    ctx.set('code', src.slice(0, r[0]) + rep + src.slice(r[1]));
  }
  const canFix = (c, k) => {
    const it = c.items[k];
    if (!it?.fix) return false;
    if (!/^%(hh|h|ll|l|j|z|t|L)?[a-zA-Z]$/.test(it.fix) && !/PRI[a-zA-Z]\w+/.test(it.fix)) return false;
    return !!locate(String(ctx.raw.code ?? ''), c)[k];
  };

  // ------------------------------------------------------------ call panel
  function pick(ci, ii, focusSpec = true) {
    st.call = ci; st.item = ii;
    drawCall();
    drawHl();
    if (focusSpec) fmtEl.querySelector('.pf-spec[aria-pressed="true"]')?.focus();
  }
  function drawCall() {
    const cs = calls();
    const c = cs[st.call];
    callsBar.replaceChildren(...cs.map((x, i) => h('button', { class: 'pf-cchip', 'aria-pressed': String(i === st.call), onclick: () => pick(i, 0) },
      h('i', { class: '', style: `background:var(${{ error: '--danger', warning: '--warn', note: '--tool-note', ok: '--ok', unknown: '--tool-unk' }[worst(x.items)]})` }), `${x.name} :${x.line}`)));
    if (!c) {
      callHead.replaceChildren(h('b', {}, 'Call'));
      fmtEl.replaceChildren(h('div', { class: 'pf-empty' }, 'No printf-style call found in the code.'));
      srcEl.replaceChildren(); lane.replaceChildren(); lnote.replaceChildren(); det.replaceChildren();
      return;
    }
    const w = worst(c.items);
    callHead.replaceChildren(h('b', {}, `${c.name}()`), h('span', {}, `line ${c.line} · format is argument ${c.fi + 1} · ${c.args.length} argument${c.args.length === 1 ? '' : 's'} after it`),
      h('span', { class: `c-${w}`, style: 'margin-left:auto;font-weight:600' }, w === 'ok' ? 'all conversions match' : w));
    // the format string, conversions as chips
    if (c.fmt == null) {
      fmtEl.replaceChildren(h('span', { class: 'lit' }, c.fmtSrc));
    } else {
      const parts = [h('span', { class: 'q' }, '"')];
      for (const sg of c.segs) {
        if (sg.text != null) {
          for (const bit of sg.text.split(/(\\.)/)) if (bit) parts.push(h('span', { class: /^\\./.test(bit) ? 'esc' : 'lit' }, bit));
          continue;
        }
        const idx = sg.items.at(-1);
        const it = c.items[idx];
        const sev = worst(sg.items.map((k) => c.items[k]));
        parts.push(h('button', { class: `pf-spec ${sev}`, 'aria-pressed': String(sg.items.includes(st.item)), title: `${it.spec}: ${it.sev}${it.why ? ' - ' + it.why : ''}`,
          'data-i': idx, onclick: () => pick(st.call, idx) }, sg.spec));
      }
      parts.push(h('span', { class: 'q' }, '"'));
      fmtEl.replaceChildren(...parts);
    }
    srcEl.textContent = c.fmt != null && c.fmtSrc.replace(/^"|"$/g, '') !== c.fmt ? `as written: ${c.fmtSrc}` : '';
    drawLane(c);
    drawDetail(c);
  }
  fmtEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const specs = [...fmtEl.querySelectorAll('.pf-spec')];
    const i = specs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = specs[Math.max(0, Math.min(specs.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
    pick(st.call, Number(n.dataset.i));
  });

  // the argument area: passed (top) against read (bottom), in bytes
  function drawLane(c) {
    const passed = [], reads = [];
    c.items.forEach((it, k) => {
      if (it.kind === 'nonliteral' || it.kind === 'positional' || it.kind === 'invalid') return;
      if (it.expr != null) passed.push({ k, label: it.expr, sub: it.promoted || it.type || '?', bytes: it.argBytes, sev: it.sev });
      if (it.kind !== 'extra') reads.push({ k, label: it.kind === 'star' ? `* ${it.star}` : it.spec, sub: it.expected, bytes: it.readBytes, sev: it.sev, missing: it.missing });
    });
    if (!passed.length && !reads.length) { lane.replaceChildren(); lnote.textContent = ''; return; }
    const unit = (b) => b ?? 4; // unknown size: drawn as 4 bytes, dashed
    const totalP = passed.reduce((a, p) => a + unit(p.bytes), 0), totalR = reads.reduce((a, r) => a + unit(r.bytes), 0);
    const total = Math.max(totalP, totalR, 4);
    const W = Math.max(300, Math.min(760, Math.round((lane.clientWidth || 640) - 16))), L = 66, R = 10, BH = 38;
    const px = (W - L - R) / total;
    const Yp = 22, Yr = Yp + BH + 26, H = Yr + BH + 22;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Bytes passed against bytes read' });
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'pf-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('line', { class: 'hatch', x1: 0, y1: 0, x2: 0, y2: 6 }));
    defs.append(pat); svg.append(defs);
    svg.append(sv('text', { x: 4, y: Yp + 16, class: 'lbl' }, 'passed'), sv('text', { x: 4, y: Yp + 29, class: 'lbl' }, 'by caller'));
    svg.append(sv('text', { x: 4, y: Yr + 16, class: 'lbl' }, 'read by'), sv('text', { x: 4, y: Yr + 29, class: 'lbl' }, 'format'));
    for (let b = 0; b <= total; b++) {
      const x = L + b * px;
      svg.append(sv('line', { class: 'tick', x1: x, x2: x, y1: Yp + BH + 4, y2: Yr - 4, opacity: b % 4 ? 0.35 : 1 }));
      if (b % 4 === 0) svg.append(sv('text', { x, y: 12, class: 'soft', 'text-anchor': 'middle' }, `${b}`));
    }
    svg.append(sv('text', { x: L - 8, y: 12, class: 'lbl', 'text-anchor': 'end' }, 'byte'));
    const fit = (txt, w) => (txt.length * 6.6 <= w - 8 ? txt : txt.slice(0, Math.max(1, Math.floor((w - 12) / 6.6))) + '…');
    const box = (o, x, y, cls) => {
      const w = unit(o.bytes) * px;
      const g = sv('g', { 'data-k': o.k });
      g.append(sv('rect', { class: `box ${cls}${o.k === st.item ? ' sel' : ''}`, x: x + 1, y, width: Math.max(2, w - 2), height: BH, rx: 3 }));
      g.append(sv('text', { x: x + w / 2, y: y + 16, 'text-anchor': 'middle' }, fit(o.label, w)));
      g.append(sv('text', { x: x + w / 2, y: y + 30, 'text-anchor': 'middle', class: 'soft' }, fit(`${o.sub} · ${o.bytes ?? '?'} B`, w)));
      g.addEventListener('click', () => pick(st.call, o.k));
      svg.append(g);
      return w;
    };
    let x = L;
    const pStart = new Map();
    for (const p of passed) { pStart.set(p.k, x); x += box(p, x, Yp, p.bytes == null ? 'unknown' : 'arg'); }
    // reads: a read that does not start where an argument starts is misaligned
    x = L;
    const starts = new Set([...pStart.values()].map((v) => Math.round(v * 10)));
    let slid = null;
    for (const r of reads) {
      const w = unit(r.bytes) * px;
      const aligned = starts.has(Math.round(x * 10));
      const beyond = x + w > L + totalP * px + 0.5;
      const cls = r.missing || beyond ? 'error' : r.bytes == null ? 'unknown' : r.sev;
      box(r, x, Yr, cls);
      if (!aligned || beyond) {
        svg.append(sv('rect', { class: 'slid', x: x + 1, y: Yr, width: Math.max(2, w - 2), height: 6, 'pointer-events': 'none' }));
        slid ??= { r, beyond };
      }
      const ps = pStart.get(r.k);
      if (ps != null) svg.append(sv('line', { class: `conn${Math.abs(ps - x) > 0.5 ? ' bad' : ''}`, x1: ps + 8, y1: Yp + BH, x2: x + 8, y2: Yr }));
      x += w;
    }
    if (totalR > totalP) svg.append(sv('text', { x: L + totalP * px + 4, y: Yp + 24, class: 'soft' }, 'nothing passed here'));
    lane.replaceChildren(svg);
    lnote.textContent = slid
      ? `From ${slid.r.label} on, the format reads bytes that belong to ${slid.beyond ? 'nothing the caller passed (the next register or stack slot)' : 'a different argument'}: those values print wrong even where their own types match. Simple stack model; real ABIs also align 8-byte values and pass some in registers.`
      : totalP === totalR ? 'Every read starts where an argument starts and has its width: nothing slides.' : '';
  }
  function drawDetail(c) {
    const it = c.items[st.item] || c.items[0];
    if (!it) { det.replaceChildren(); return; }
    const rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push(h('span', {}, k), h('b', {}, v)); };
    add('conversion', it.kind === 'star' ? `${it.spec} (* ${it.star})` : it.spec);
    add('argument', it.expr ?? (it.kind === 'extra' ? '' : '(none)'));
    add('its type', it.type ? `${it.type}${it.t && it.t !== '?' && !it.type.startsWith(it.t) ? ` = ${it.t.replace('*', ' *')}` : ''}` : it.expr != null ? 'unknown' : null);
    if (it.promoted && it.promoted !== it.t) add('promoted to', `${it.promoted.replace('*', ' *')} (default argument promotion)`);
    add('expects', it.expected ? `${it.expected.replace('*', ' *')}${it.readBytes ? ` · ${it.readBytes} bytes` : ''}` : null);
    if (it.argBytes != null) add('passes', `${it.argBytes} bytes`);
    const sevWord = { ok: 'ok', note: 'note', warning: 'warning', error: 'error', unknown: 'type unknown' }[it.sev];
    rows.push(h('div', { class: `why ${it.sev}` }, h('b', { class: `c-${it.sev}` }, sevWord), it.why ? `: ${it.why}` : it.sev === 'ok' ? ': the argument matches the conversion on this target.' : ''));
    if (it.fix) {
      const can = canFix(c, st.item);
      rows.push(h('div', { class: 'fixrow' }, h('span', {}, 'use'), h('code', {}, it.fix),
        can ? h('button', { class: 'k-btn k-primary', onclick: () => applyFix(c, st.item) }, 'Apply to the code') : h('span', { class: 'soft' }, 'change it by hand (the spec is not written literally there)')));
    }
    det.replaceChildren(...rows);
  }

  let laneW = 0;
  new ResizeObserver(() => {
    const w = lane.clientWidth;
    if (w && Math.abs(w - laneW) > 4) { laneW = w; requestAnimationFrame(() => { const c = calls()[st.call]; if (c) drawLane(c); }); }
  }).observe(lane);

  // ------------------------------------------------------------ result
  ctx.onResult((res) => {
    const raw = ctx.raw;
    syncVal(ta, String(raw.code ?? ''));
    syncVal(decl, String(raw.decls ?? ''));
    syncVal(extra, String(raw.extra ?? ''));
    const cs = res.calls || [];
    // keep the selection on the same line when the code changes
    const sig = cs.map((c) => c.line).join(',');
    if (sig !== st.sig) {
      const prevLine = st.lastLine;
      const i = cs.findIndex((c) => c.line === prevLine);
      if (i >= 0) st.call = i;
      else {
        const firstBad = cs.findIndex((c) => worst(c.items) === 'error');
        st.call = firstBad >= 0 ? firstBad : 0;
        st.item = 0;
      }
      st.sig = sig;
    }
    if (st.call >= cs.length) st.call = 0;
    const c = cs[st.call];
    if (c && !c.items[st.item]) st.item = 0;
    if (c && st.item === 0 && sig !== st.sigItem) {
      const k = c.items.findIndex((x) => x.sev === 'error');
      st.item = k >= 0 ? k : 0;
    }
    st.sigItem = sig;
    st.lastLine = c?.line;
    const v = Object.fromEntries((res.values || []).map((x) => [x.label, x.value]));
    sum.replaceChildren(
      h('span', {}, h('b', {}, String(v['Calls checked'] ?? 0)), ' calls'),
      h('span', {}, h('b', { class: v.Errors ? 'c-error' : '' }, String(v.Errors ?? 0)), ' errors'),
      h('span', {}, h('b', { class: v.Warnings ? 'c-warning' : '' }, String(v.Warnings ?? 0)), ' warnings'),
      ...(v['Unknown types'] ? [h('span', {}, h('b', { class: 'c-unknown' }, String(v['Unknown types'])), ' unknown')] : []));
    warns.replaceChildren(...[...(res.warnings || []), ...(res.notes || []).slice(0, 1)].map((w) => h('div', {}, w)));
    drawTargets();
    drawCall();
    drawHl();
  });
}
