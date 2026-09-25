// NMEA / Serial Log Parser, custom page: the log itself, read line by line.
//   Strip    - every line of the log as one tick, coloured by what it is
//              (sentence type, a failed checksum, a debug line); click or
//              drag along it to move through the log, arrows step.
//   Tape     - the lines as the UART delivered them, each field coloured by
//              what it carries (time, position, fix quality, satellites,
//              speed); junk before the '$' dimmed, the checksum green or red.
//              Click a line or a field; arrows / PgUp / PgDn move.
//   Fields   - the selected sentence taken apart: every raw field with its
//              name and the decoded meaning, the checksum worked out, and a
//              "Fix checksum" button for a bad one (it rewrites that line).
//   Sky      - the satellites the receiver reported (GSV) up to that line,
//              on a polar sky plot (zenith in the middle, north up), the
//              ones used for the fix (GSA) solid, with their C/N0 bars.
//   Track    - the positions so far, in metres around the first fix.
//   CSV and key=value logs show each numeric field as a strip chart with
//   the selected row as a cursor instead of the sky and the track.
// Everything shown comes from run()'s result.parsed (the lines, their
// fields and checksums) and result.values.

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
:root { --tool-c0: #1f4ed8; --tool-c1: #0f8a78; --tool-c2: #c26a00; --tool-c3: #7a45b0; --tool-c4: #b0306a; --tool-c5: #5b6b7a; --tool-addr: #16202a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-c0: #7d9bff; --tool-c1: #3cc7b3; --tool-c2: #f0a33a; --tool-c3: #c982e0; --tool-c4: #f07aa8; --tool-c5: #8ea0b0; --tool-addr: #e4ebf1; } }
:root[data-theme="dark"] { --tool-c0: #7d9bff; --tool-c1: #3cc7b3; --tool-c2: #f0a33a; --tool-c3: #c982e0; --tool-c4: #f07aa8; --tool-c5: #8ea0b0; --tool-addr: #e4ebf1; }
.k-page { padding: 12px; }
.sl { display: grid; grid-template-columns: minmax(0, 1fr) 330px 310px; grid-template-areas: "top top top" "strip strip strip" "warn warn warn" "tape fields inst" "out out out"; gap: 10px 12px; align-items: start; }
@media (max-width: 1320px) { .sl { grid-template-columns: minmax(0, 1fr) 340px; grid-template-areas: "top top" "strip strip" "warn warn" "tape fields" "tape inst" "out out"; } }
@media (max-width: 820px) { .sl { grid-template-columns: minmax(0, 1fr); grid-template-areas: "top" "strip" "warn" "tape" "fields" "inst" "out"; } }
.sl-top { grid-area: top; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.sl-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.sl-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.sl-seg button + button { border-left: 1px solid var(--line); }
.sl-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.sl-stats { display: flex; flex-wrap: wrap; gap: 3px 14px; font-size: 12px; color: var(--ink-soft); }
.sl-stats b { font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.sl-stats .ok { color: var(--ok); } .sl-stats .bad { color: var(--danger); } .sl-stats .warn { color: var(--warn); }
.sl-strip { grid-area: strip; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px 4px; min-width: 0; }
.sl-strip svg { display: block; width: 100%; height: 34px; touch-action: none; cursor: pointer; outline: none; }
.sl-strip svg:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sl-legend { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 11px; color: var(--ink-soft); margin-top: 3px; }
.sl-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.sl-warns:empty { display: none; }
.sl-warns { grid-area: warn; border-left: 3px solid var(--warn); padding: 4px 9px; font-size: 12px; background: var(--surface); border-radius: 0 5px 5px 0; }
.sl-warns div + div { margin-top: 2px; }
.sl-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.sl-ph { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); flex-wrap: wrap; }
.sl-ph b { font-size: 13px; }
.sl-ph span { font-size: 11.5px; color: var(--ink-soft); }
.sl-ph .k-btn { margin-left: auto; }
.sl-tapebox { grid-area: tape; display: flex; flex-direction: column; }
.sl-tape { overflow: auto; max-height: 600px; min-height: 220px; font: 12px/20px "IBM Plex Mono", ui-monospace, monospace; outline: none; padding: 4px 0; }
.sl-tape:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.sl-ln { display: grid; grid-template-columns: 38px 14px minmax(0, 1fr); align-items: start; cursor: pointer; border-left: 3px solid transparent; }
.sl-ln:hover { background: var(--sunken); }
.sl-ln.sel { background: var(--sunken); border-left-color: var(--accent); }
.sl-no { color: var(--ink-soft); text-align: right; padding-right: 6px; user-select: none; }
.sl-mark { width: 8px; height: 8px; margin-top: 6px; border-radius: 2px; background: var(--line); }
.sl-mark.ok { background: var(--ok); } .sl-mark.badcs { background: var(--danger); } .sl-mark.nocs { background: var(--warn); } .sl-mark.other { background: transparent; border: 1px solid var(--ink-soft); }
.sl-mark.row { background: var(--tool-c5); } .sl-mark.header { background: var(--ink); }
.sl-tx { white-space: pre-wrap; word-break: break-all; padding-right: 8px; }
.sl-tx .junk { color: var(--ink-soft); opacity: .75; }
.sl-tx .sep { color: var(--ink-soft); opacity: .6; }
.sl-tx .addr { color: var(--tool-addr); font-weight: 600; }
.sl-tx .tk { color: var(--ink-soft); }
.sl-tx .f { border-radius: 2px; }
.sl-tx .f.t { color: var(--tool-c3); } .sl-tx .f.p { color: var(--tool-c1); } .sl-tx .f.q { color: var(--tool-c2); } .sl-tx .f.s { color: var(--tool-c0); } .sl-tx .f.v { color: var(--tool-c4); } .sl-tx .f.x { color: var(--ink-soft); }
.sl-tx .f.on { background: var(--accent); color: var(--accent-ink); }
.sl-tx .cs.ok { color: var(--ok); font-weight: 600; }
.sl-tx .cs.bad { color: var(--danger); font-weight: 600; text-decoration: line-through; }
.sl-tx .cs.fix { color: var(--danger); font-weight: 600; margin-left: 4px; }
.sl-tx .twin { color: var(--danger); opacity: .75; }
.sl-tx .other { color: var(--ink-soft); font-style: italic; }
.sl-tx .c0 { color: var(--tool-c0); } .sl-tx .c1 { color: var(--tool-c1); } .sl-tx .c2 { color: var(--tool-c2); } .sl-tx .c3 { color: var(--tool-c3); } .sl-tx .c4 { color: var(--tool-c4); } .sl-tx .c5 { color: var(--tool-c5); }
.sl-edit { display: none; padding: 8px; flex-direction: column; gap: 6px; }
.sl-tapebox.editing .sl-edit { display: flex; }
.sl-tapebox.editing .sl-tape { display: none; }
.sl-edit textarea { width: 100%; min-height: 420px; resize: vertical; padding: 6px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12px/1.6 "IBM Plex Mono", ui-monospace, monospace; }
.sl-help { font-size: 11px; color: var(--ink-soft); padding: 4px 10px 6px; border-top: 1px solid var(--line-soft); }
.sl-help kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; background: var(--sunken); }
.sl-fields { grid-area: fields; }
.sl-inst { grid-area: inst; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.sl-ph .sl-ftitle { color: var(--ink); font: 600 17px "IBM Plex Mono", ui-monospace, monospace; }
.sl-ftab { width: 100%; border-collapse: collapse; font-size: 12px; }
.sl-ftab td { padding: 2px 8px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.sl-ftab td:first-child { color: var(--ink-soft); width: 42%; }
.sl-ftab td.raw { font-family: "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; }
.sl-ftab tr { cursor: pointer; }
.sl-ftab tr:hover td { background: var(--sunken); }
.sl-ftab tr.on td { background: var(--sunken); box-shadow: inset 0 -2px 0 var(--accent); }
.sl-ftab tr.empty td.raw { color: var(--ink-soft); }
.sl-ftab i { display: inline-block; width: 6px; height: 6px; border-radius: 1px; margin-right: 6px; vertical-align: 1px; }
.sl-ftab i.t { background: var(--tool-c3); } .sl-ftab i.p { background: var(--tool-c1); } .sl-ftab i.q { background: var(--tool-c2); } .sl-ftab i.s { background: var(--tool-c0); } .sl-ftab i.v { background: var(--tool-c4); } .sl-ftab i.x { background: var(--line); }
.sl-dec { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 12px; padding: 8px 10px; font-size: 12px; border-bottom: 1px solid var(--line-soft); }
.sl-dec span { color: var(--ink-soft); }
.sl-dec b { font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; word-break: break-word; }
.sl-cs { margin: 8px 10px; padding: 6px 8px; border-radius: 4px; background: var(--sunken); font: 12px/1.6 "IBM Plex Mono", ui-monospace, monospace; }
.sl-cs.bad { box-shadow: inset 3px 0 0 var(--danger); } .sl-cs.ok { box-shadow: inset 3px 0 0 var(--ok); } .sl-cs.warn { box-shadow: inset 3px 0 0 var(--warn); }
.sl-cs .k-btn { margin-top: 4px; font-family: inherit; }
.sl-fbody { max-height: 470px; overflow: auto; }
.sl-empty { padding: 12px 10px; color: var(--ink-soft); font-size: 12px; }
.sl-sky svg, .sl-trk svg, .sl-spark svg { display: block; width: 100%; }
.sl-sky text, .sl-trk text, .sl-spark text { font: 10px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.sl-sky .ring { fill: none; stroke: var(--line); }
.sl-sky .ax { stroke: var(--line-soft); }
.sl-sky .sat { cursor: default; }
.sl-sky .sat circle { stroke-width: 2; }
.sl-sky .sat.hi circle { fill: var(--ok); stroke: var(--ok); } .sl-sky .sat.mid circle { fill: var(--warn); stroke: var(--warn); } .sl-sky .sat.lo circle { fill: var(--danger); stroke: var(--danger); } .sl-sky .sat.none circle { fill: var(--surface); stroke: var(--ink-soft); }
.sl-sky .sat.unused circle { fill: var(--surface); }
.sl-sky .sat text { fill: var(--ink); font-weight: 600; }
.sl-sky .bar.hi { fill: var(--ok); } .sl-sky .bar.mid { fill: var(--warn); } .sl-sky .bar.lo { fill: var(--danger); } .sl-sky .bar.none { fill: var(--line); }
.sl-sky .bar.unused { fill-opacity: .35; }
.sl-sky .t-ink, .sl-trk .t-ink, .sl-spark .t-ink { fill: var(--ink); }
.sl-trk .grid { stroke: var(--line-soft); }
.sl-trk .path { fill: none; stroke: var(--tool-c1); stroke-width: 2; }
.sl-trk .pt { fill: var(--tool-c1); cursor: pointer; }
.sl-trk .pt.past { fill-opacity: .45; }
.sl-trk .pt.future { fill: none; stroke: var(--line); }
.sl-trk .cur { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.sl-trk .scale { stroke: var(--ink-soft); stroke-width: 1.5; }
.sl-spark .ln { fill: none; stroke: var(--tool-c0); stroke-width: 1.5; }
.sl-spark .mean { stroke: var(--line); stroke-dasharray: 3 3; }
.sl-spark .cursor { stroke: var(--accent); stroke-width: 1.5; }
.sl-spark .dot { fill: var(--accent); }
.sl-spark .bg { fill: transparent; cursor: pointer; }
.sl-spark .row + .row { border-top: 1px solid var(--line-soft); }
.sl-out { grid-area: out; min-width: 0; }
.sl-out .k-out { max-height: 300px; }
`;

const TYPE_NAME = { GGA: 'Fix data', RMC: 'Recommended minimum', GSA: 'DOP and active satellites', GSV: 'Satellites in view', VTG: 'Course and speed',
  GLL: 'Geographic position', ZDA: 'Time and date', TXT: 'Text message' };
const TYPE_COLOR = { GGA: 'var(--tool-c1)', RMC: 'var(--tool-c0)', GSA: 'var(--tool-c2)', GSV: 'var(--tool-c3)', VTG: 'var(--tool-c4)', GLL: 'var(--tool-c1)', ZDA: 'var(--tool-c5)', TXT: 'var(--ink-soft)' };
const TALKER = { GP: 'GPS', GL: 'GLONASS', GA: 'Galileo', GB: 'BeiDou', BD: 'BeiDou', GN: 'multi-GNSS', GQ: 'QZSS', GI: 'NavIC', P: 'proprietary' };
const CAT_NAME = [['t', 'time'], ['p', 'position'], ['q', 'fix quality'], ['s', 'satellites'], ['v', 'speed, course'], ['x', 'other']];
const MAX_TAPE = 2000;
const snrClass = (v) => (v == null ? 'none' : v >= 40 ? 'hi' : v >= 30 ? 'mid' : 'lo');

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const f = (v, d = 4) => ctx.fmtNum(v, d);
  const st = { sel: null, field: null, editing: false, sig: '' };

  // ------------------------------------------------------------ layout
  const modeSeg = h('span', { class: 'sl-seg', role: 'group', 'aria-label': 'Format' });
  const stats = h('div', { class: 'sl-stats', 'aria-live': 'polite' });
  const editBtn = h('button', { class: 'k-btn', onclick: () => setEditing(!st.editing) }, 'Edit log');
  const top = h('div', { class: 'sl-top' }, modeSeg, stats);

  const strip = sv('svg', { tabindex: '0', role: 'slider', 'aria-label': 'Position in the log', preserveAspectRatio: 'none' });
  const legend = h('div', { class: 'sl-legend' });
  const stripBox = h('section', { class: 'sl-strip' }, strip, legend);
  const warns = h('div', { class: 'sl-warns', 'aria-live': 'polite' });

  const tape = h('div', { class: 'sl-tape', tabindex: '0', role: 'listbox', 'aria-label': 'Log lines' });
  const ta = h('textarea', { spellcheck: 'false', 'aria-label': 'Log text', oninput: (e) => ctx.set('log', e.target.value) });
  const tapeHead = h('div', { class: 'sl-ph' }, h('b', {}, 'Log'), h('span', { class: 'sl-tcount' }), editBtn);
  const tapeBox = h('section', { class: 'sl-panel sl-tapebox' }, tapeHead, tape,
    h('div', { class: 'sl-edit' }, h('div', { class: 'sl-help', style: 'border:0;padding:0' }, 'Paste a serial capture: NMEA sentences, CSV or key=value lines. Timestamps before a $ are fine.'), ta),
    h('div', { class: 'sl-help' }, 'Click a line or a field. ', h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' line, ', h('kbd', {}, 'PgUp'), h('kbd', {}, 'PgDn'), ' ×10, ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' field.'));

  const fields = h('section', { class: 'sl-panel sl-fields' });
  const inst = h('div', { class: 'sl-inst' });
  const out = h('div', { class: 'sl-out' }, ctx.outputs);
  root.append(h('div', { class: 'sl' }, top, stripBox, warns, tapeBox, fields, inst, out));

  function setEditing(on) {
    st.editing = on;
    tapeBox.classList.toggle('editing', on);
    editBtn.textContent = on ? 'Show parsed' : 'Edit log';
    if (on) { ta.value = String(ctx.raw.log ?? ''); ta.focus(); } else tape.focus();
  }

  // ------------------------------------------------------------ helpers
  const P = () => ctx.result?.parsed;
  const lines = () => P()?.lines || [];
  const idxOf = (n) => lines().findIndex((l) => l.n === n);
  function select(n, field = null, scroll = true) {
    if (n == null) return;
    st.sel = n; st.field = field;
    drawSelection(scroll);
  }
  function step(d) {
    const ls = lines();
    if (!ls.length) return;
    const i = Math.max(0, Math.min(ls.length - 1, (idxOf(st.sel) < 0 ? 0 : idxOf(st.sel)) + d));
    select(ls[i].n);
  }

  // ------------------------------------------------------------ top
  function drawTop(res) {
    const modes = [['auto', 'Auto'], ['nmea', 'NMEA 0183'], ['csv', 'CSV'], ['kv', 'key=value']];
    const cur = ctx.raw.mode || 'auto';
    modeSeg.replaceChildren(...modes.map(([v, t]) => h('button', { 'aria-pressed': String(cur === v), onclick: () => ctx.set('mode', v) }, t)));
    const note = (res.notes || []).find((n) => /\(auto\)/.test(n));
    stats.replaceChildren(
      ...(note ? [h('span', {}, note.replace(/^Read as /, 'read as ').replace(/\.$/, ''))] : []),
      ...(res.values || []).map((v) => h('span', { title: v.hint || null }, `${v.label} `,
        h('b', { class: v.tone === 'bad' ? 'bad' : v.tone === 'warn' ? 'warn' : '' }, `${typeof v.value === 'number' ? f(v.value, 6) : v.value}${v.unit ? ' ' + v.unit : ''}`))));
  }

  // ------------------------------------------------------------ strip
  const lineColor = (l) => {
    if (l.kind === 'badcs') return 'var(--danger)';
    if (l.kind === 'other') return 'var(--line)';
    if (l.kind === 'nocs') return 'var(--warn)';
    if (l.kind === 'header') return 'var(--ink)';
    if (l.type) return TYPE_COLOR[l.type] || 'var(--ink-soft)';
    return 'var(--tool-c5)';
  };
  function drawStrip() {
    const ls = lines();
    const W = 1000, H = 34;
    strip.setAttribute('viewBox', `0 0 ${W} ${H}`);
    strip.replaceChildren();
    if (!ls.length) return;
    const total = Math.max(P().total, 1);
    const w = Math.max(1, W / total);
    for (const l of ls) {
      const bad = l.kind === 'badcs' || l.kind === 'other' || l.kind === 'nocs';
      strip.append(sv('rect', { x: ((l.n - 1) / total) * W, y: bad ? 2 : 8, width: Math.max(1, w - (w > 3 ? 1 : 0)), height: bad ? 30 : 24, fill: lineColor(l) }));
    }
    strip.append(sv('rect', { class: 'sl-cur', x: 0, y: 0, width: Math.max(2, w), height: H, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
    // legend: the kinds present
    const types = [...new Set(ls.map((l) => l.type).filter(Boolean))];
    const kinds = new Set(ls.map((l) => l.kind));
    legend.replaceChildren(
      ...types.map((t) => h('span', {}, h('i', { style: `background:${TYPE_COLOR[t] || 'var(--ink-soft)'}` }), t)),
      ...(P().mode !== 'nmea' ? [h('span', {}, h('i', { style: 'background:var(--tool-c5)' }), 'row')] : []),
      ...(kinds.has('badcs') ? [h('span', {}, h('i', { style: 'background:var(--danger)' }), 'checksum error')] : []),
      ...(kinds.has('nocs') ? [h('span', {}, h('i', { style: 'background:var(--warn)' }), 'no checksum')] : []),
      ...(kinds.has('other') ? [h('span', {}, h('i', { style: 'background:var(--line)' }), P().mode === 'nmea' ? 'not NMEA' : 'did not fit')] : []),
      h('span', { style: 'margin-left:auto' }, `${P().total} lines`));
  }
  const stripLine = (e) => {
    const r = strip.getBoundingClientRect();
    const n = Math.max(1, Math.ceil(((e.clientX - r.left) / r.width) * P().total));
    // the nearest line that has content
    const ls = lines();
    let best = ls[0];
    for (const l of ls) if (Math.abs(l.n - n) < Math.abs(best.n - n)) best = l;
    return best?.n;
  };
  let stripDrag = false;
  strip.addEventListener('pointerdown', (e) => { if (!lines().length) return; strip.setPointerCapture(e.pointerId); stripDrag = true; strip.focus(); select(stripLine(e)); e.preventDefault(); });
  strip.addEventListener('pointermove', (e) => { if (stripDrag) { const n = stripLine(e); if (n !== st.sel) select(n); } });
  strip.addEventListener('pointerup', () => { stripDrag = false; });
  strip.addEventListener('pointercancel', () => { stripDrag = false; });
  strip.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[e.key];
    if (d) { e.preventDefault(); step(d); }
    if (e.key === 'Home') { e.preventDefault(); select(lines()[0]?.n); }
    if (e.key === 'End') { e.preventDefault(); select(lines().at(-1)?.n); }
  });

  // ------------------------------------------------------------ tape
  function tokens(l, mode, cols) {
    const tx = h('span', { class: 'sl-tx' });
    if (mode === 'nmea') {
      if (l.kind === 'other') { tx.append(h('span', { class: 'other' }, l.text || ' ')); return tx; }
      if (l.at) tx.append(h('span', { class: 'junk' }, l.text.slice(0, l.at)));
      const sentence = l.text.slice(l.at, l.end);
      tx.append(h('span', { class: 'sep' }, sentence[0]));
      const addr = l.addr || '';
      const tk = addr.startsWith('P') ? 1 : 2;
      tx.append(h('span', { class: 'tk' }, addr.slice(0, tk)), h('span', { class: 'addr' }, addr.slice(tk)));
      (l.fields || []).forEach((fl, k) => {
        tx.append(h('span', { class: 'sep' }, ','));
        tx.append(h('span', { class: `f ${fl.cat}`, 'data-k': k, title: `${fl.name}${fl.raw === '' ? ' (empty)' : ''}` }, fl.raw));
      });
      if (l.star != null) {
        const ok = l.kind !== 'badcs';
        tx.append(h('span', { class: 'sep' }, '*'), h('span', { class: `cs ${ok ? 'ok' : 'bad'}`, title: ok ? 'checksum matches' : `computed ${l.got}` }, l.want || '??'));
        if (!ok) tx.append(h('span', { class: 'cs fix' }, `≠ ${l.got}`));
        const rest = sentence.slice(l.star - l.at + 3);
        if (rest) tx.append(h('span', {}, rest));
      }
      if (l.end < l.text.length) tx.append(h('span', { class: 'twin', title: 'a second sentence on the same line: the line ending was lost' }, l.text.slice(l.end)));
      return tx;
    }
    if (mode === 'csv') {
      if (l.kind === 'header' || l.kind === 'row' || l.kind === 'other') {
        const parts = l.text.split(P().delim);
        parts.forEach((p, k) => {
          if (k) tx.append(h('span', { class: 'sep' }, P().delim === '\t' ? '⇥' : P().delim));
          tx.append(h('span', { class: `f c${k % 6}${k >= cols.length ? ' twin' : ''}`, 'data-k': k, title: cols[k] || 'extra field' }, p));
        });
        if (l.kind === 'header') tx.style.fontWeight = '600';
        return tx;
      }
    }
    if (mode === 'kv') {
      const re = /([A-Za-z_][\w.\-]*)(\s*[=:]\s*)("[^"]*"|[^\s,;]+)/g;
      let m, last = 0;
      while ((m = re.exec(l.text))) {
        if (m.index > last) tx.append(h('span', { class: 'sep' }, l.text.slice(last, m.index)));
        const k = cols.indexOf(m[1]);
        tx.append(h('span', { class: `c${(k < 0 ? 5 : k) % 6}` }, m[1]), h('span', { class: 'sep' }, m[2]), h('span', { class: `f c${(k < 0 ? 5 : k) % 6}`, 'data-k': k, title: m[1] }, m[3]));
        last = m.index + m[0].length;
      }
      if (last < l.text.length) tx.append(h('span', { class: last ? 'sep' : 'other' }, l.text.slice(last)));
      return tx;
    }
    tx.append(l.text);
    return tx;
  }
  function drawTape() {
    const p = P();
    const ls = lines();
    const cols = p?.columns || [];
    const shown = ls.slice(0, MAX_TAPE);
    tape.replaceChildren(...shown.map((l) => h('div', { class: 'sl-ln', 'data-n': l.n, role: 'option', 'aria-selected': 'false' },
      h('span', { class: 'sl-no' }, String(l.n)), h('span', { class: `sl-mark ${l.kind}`, title: l.kind }), tokens(l, p.mode, cols))));
    if (ls.length > MAX_TAPE) tape.append(h('div', { class: 'sl-empty' }, `${ls.length - MAX_TAPE} more lines: the tables in the outputs have them all.`));
    const bad = ls.filter((l) => l.kind === 'badcs').length, oth = ls.filter((l) => l.kind === 'other').length;
    tapeHead.querySelector('.sl-tcount').textContent = `${ls.length} lines${bad ? ` · ${bad} bad checksum` : ''}${oth ? ` · ${oth} ${p.mode === 'nmea' ? 'not NMEA' : 'did not fit'}` : ''}`;
  }
  tape.addEventListener('click', (e) => {
    const ln = e.target.closest('.sl-ln');
    if (!ln) return;
    const fk = e.target.closest('.f');
    select(Number(ln.dataset.n), fk && fk.dataset.k != null ? Number(fk.dataset.k) : null, false);
  });
  tape.addEventListener('keydown', (e) => {
    const d = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[e.key];
    if (d) { e.preventDefault(); step(d); return; }
    if (e.key === 'Home') { e.preventDefault(); select(lines()[0]?.n); }
    if (e.key === 'End') { e.preventDefault(); select(lines().at(-1)?.n); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const l = lines()[idxOf(st.sel)];
      const nf = l?.fields?.length ?? P()?.columns?.length ?? 0;
      if (!nf) return;
      e.preventDefault();
      const k = st.field == null ? (e.key === 'ArrowRight' ? 0 : nf - 1) : Math.max(0, Math.min(nf - 1, st.field + (e.key === 'ArrowRight' ? 1 : -1)));
      select(st.sel, k, false);
    }
  });

  // ------------------------------------------------------------ fields panel
  function fixChecksum(l) {
    const all = String(ctx.raw.log ?? '').split('\n');
    const i = l.n - 1;
    const raw = all[i];
    if (raw == null || l.star == null) return;
    all[i] = raw.slice(0, l.star + 1) + l.got + raw.slice(l.star + 1 + String(l.want || '').length);
    ctx.set('log', all.join('\n'));
  }
  function drawFields() {
    const p = P();
    const l = lines()[idxOf(st.sel)];
    if (!p || !l) { fields.replaceChildren(h('div', { class: 'sl-ph' }, h('b', {}, 'Fields')), h('div', { class: 'sl-empty' }, 'Select a line.')); return; }
    if (p.mode === 'nmea') {
      if (l.kind === 'other') {
        fields.replaceChildren(h('div', { class: 'sl-ph' }, h('b', {}, `Line ${l.n}`), h('span', {}, 'not an NMEA sentence')),
          h('div', { class: 'sl-empty' }, 'Debug print, prompt or a sentence without its "$": skipped. A receiver at the wrong baud rate gives lines like this too.'));
        return;
      }
      const talker = l.addr?.startsWith('P') ? 'P' : l.addr?.slice(0, 2);
      const head = h('div', { class: 'sl-ph' }, h('span', { class: 'sl-ftitle' }, l.addr || '?'),
        h('span', {}, `${TYPE_NAME[l.type] || 'sentence'} · ${TALKER[talker] || talker} · line ${l.n}`));
      const dec = l.decoded ? h('div', { class: 'sl-dec' }, l.decoded.flatMap(([k, v]) => [h('span', {}, k), h('b', {}, v === '' || v == null ? '–' : String(v))])) : null;
      const rows = (l.fields || []).map((fl, k) => h('tr', { class: `${st.field === k ? 'on' : ''}${fl.raw === '' ? ' empty' : ''}`, 'data-k': k, onclick: () => select(l.n, k, false) },
        h('td', {}, h('i', { class: fl.cat }), fl.name), h('td', { class: 'raw' }, fl.raw === '' ? '(empty)' : fl.raw)));
      let cs;
      if (l.kind === 'badcs') {
        cs = h('div', { class: 'sl-cs bad' }, h('div', {}, `XOR of the bytes between $ and * = ${l.got}`), h('div', {}, `the sentence says ${l.want || '(none)'}: dropped`),
          h('button', { class: 'k-btn', onclick: () => fixChecksum(l) }, `Fix checksum to ${l.got}`));
      } else if (l.kind === 'nocs') cs = h('div', { class: 'sl-cs warn' }, 'No checksum: accepted, but nothing checks it.');
      else cs = h('div', { class: 'sl-cs ok' }, `checksum ${l.want} = XOR of the bytes between $ and *`);
      const twin = l.twin ? h('div', { class: 'sl-cs bad' }, 'A second sentence starts on this line: the line ending was lost (buffer overrun or two writers). Only the first is read.') : null;
      fields.replaceChildren(head, h('div', { class: 'sl-fbody' }, cs, twin, dec, h('table', { class: 'sl-ftab' }, h('tbody', {}, rows))));
      fields.querySelector('tr.on')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    // CSV / key=value: the row with each value placed in its field's range
    const row = p.rows.find((r) => r.n === l.n);
    const head = h('div', { class: 'sl-ph' }, h('b', {}, `Line ${l.n}`), h('span', {}, l.kind === 'header' ? 'header row' : l.kind === 'other' ? 'did not fit' : `row ${p.rows.indexOf(row) + 1} of ${p.rows.length}`));
    if (!row) {
      fields.replaceChildren(head, h('div', { class: 'sl-empty' }, l.kind === 'header' ? `Column names: ${p.columns.join(', ')}` : 'This line has no key=value pairs; it is listed under Problems.'));
      return;
    }
    const num = new Map((p.numeric || []).map((x) => [x.col, x]));
    const trs = p.columns.map((c, k) => {
      const v = row.cells[k];
      const nm = num.get(k);
      const x = Number(v);
      let bar = null;
      if (nm && v !== '' && Number.isFinite(x) && nm.max > nm.min) {
        const pos = ((x - nm.min) / (nm.max - nm.min)) * 100;
        bar = h('div', { style: 'position:relative;height:4px;background:var(--sunken);border-radius:2px;margin-top:3px' },
          h('div', { style: `position:absolute;left:calc(${pos}% - 3px);top:-2px;width:6px;height:8px;border-radius:1px;background:var(--tool-c${k % 6})` }));
      }
      return h('tr', { class: `${st.field === k ? 'on' : ''}${v === '' ? ' empty' : ''}`, onclick: () => select(l.n, k, false) },
        h('td', {}, h('i', { style: `background:var(--tool-c${k % 6})` }), c), h('td', { class: 'raw' }, v === '' ? '(empty)' : v, bar));
    });
    fields.replaceChildren(head, h('div', { class: 'sl-fbody' }, h('table', { class: 'sl-ftab' }, h('tbody', {}, trs))));
  }

  // ------------------------------------------------------------ instruments
  function skyUpTo(n) {
    // the latest GSV cycle of each talker at or before line n
    const byTalker = new Map();
    const ls = lines();
    for (const l of ls) {
      if (l.n > n) break;
      if (!l.gsv) continue;
      const t = l.talker;
      if (l.gsv.msg === 1 || !byTalker.has(t)) byTalker.set(t, { from: l.n, sats: [] });
      byTalker.get(t).sats.push(...l.gsv.sats.map((s) => ({ ...s, talker: t })));
      byTalker.get(t).to = l.n;
    }
    let used = null, usedAt = null;
    for (const l of ls) { if (l.n > n) break; if (l.used) { used = new Set(l.used); usedAt = l.n; } }
    return { groups: [...byTalker.values()], used, usedAt };
  }
  function drawSky(n) {
    const { groups, used, usedAt } = skyUpTo(n);
    const sats = groups.flatMap((g) => g.sats);
    const box = h('section', { class: 'sl-panel sl-sky' });
    const from = groups.length ? groups.map((g) => (g.from === g.to ? `line ${g.from}` : `lines ${g.from}–${g.to}`)).join(', ') : null;
    box.append(h('div', { class: 'sl-ph' }, h('b', {}, 'Sky'), h('span', {}, from ? `GSV ${from}${usedAt ? ` · used: GSA line ${usedAt}` : ''}` : 'no GSV sentence up to this line')));
    const W = 300, R = 112, cx = W / 2, cy = R + 16, H = cy + R + 14;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H + (sats.length ? 86 : 0)}`, role: 'img', 'aria-label': `Sky plot, ${sats.length} satellites` });
    for (const el of [0, 30, 60]) {
      const r = (R * (90 - el)) / 90;
      svg.append(sv('circle', { class: 'ring', cx, cy, r }));
      svg.append(sv('text', { x: cx + 3, y: cy - r + 11 }, `${el}°`));
    }
    svg.append(sv('line', { class: 'ax', x1: cx - R, x2: cx + R, y1: cy, y2: cy }), sv('line', { class: 'ax', x1: cx, x2: cx, y1: cy - R, y2: cy + R }));
    for (const [t, x, y, a] of [['N', cx, cy - R - 4, 'middle'], ['E', cx + R + 4, cy + 4, 'start'], ['S', cx, cy + R + 12, 'middle'], ['W', cx - R - 4, cy + 4, 'end']]) svg.append(sv('text', { x, y, 'text-anchor': a, class: 't-ink' }, t));
    for (const s of sats) {
      if (s.el == null || s.az == null) continue;
      const r = (R * (90 - s.el)) / 90, a = (s.az * Math.PI) / 180;
      const x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
      const isUsed = used ? used.has(s.prn) : true;
      const g = sv('g', { class: `sat ${snrClass(s.snr)}${isUsed ? '' : ' unused'}` });
      g.append(sv('title', {}, `${s.talker} PRN ${s.prn}: elevation ${s.el}°, azimuth ${s.az}°, C/N0 ${s.snr ?? '–'} dB-Hz${used ? (isUsed ? ', used in the fix' : ', not used') : ''}`));
      g.append(sv('circle', { cx: x, cy: y, r: 6 }));
      g.append(sv('text', { x: x + 8, y: y + 3.5 }, s.prn));
      svg.append(g);
    }
    if (sats.length) {
      // C/N0 bars, one per satellite
      const by = H + 64, bh = 56, bw = Math.min(26, (W - 20) / sats.length);
      svg.append(sv('line', { class: 'ax', x1: 8, x2: W - 8, y1: by, y2: by }));
      for (const lv of [20, 40]) svg.append(sv('line', { class: 'ax', x1: 8, x2: W - 8, y1: by - (lv / 55) * bh, y2: by - (lv / 55) * bh, 'stroke-dasharray': '2 3' }));
      svg.append(sv('text', { x: W - 8, y: by - (40 / 55) * bh - 2, 'text-anchor': 'end' }, '40 dB-Hz'));
      sats.forEach((s, i) => {
        const x = 10 + i * bw;
        const v = Math.min(55, s.snr ?? 0);
        const isUsed = used ? used.has(s.prn) : true;
        svg.append(sv('rect', { class: `bar ${snrClass(s.snr)}${isUsed ? '' : ' unused'}`, x, y: by - (v / 55) * bh, width: bw - 3, height: Math.max(1, (v / 55) * bh) }));
        svg.append(sv('text', { x: x + (bw - 3) / 2, y: by + 11, 'text-anchor': 'middle' }, s.prn));
        if (bw >= 18) svg.append(sv('text', { x: x + (bw - 3) / 2, y: by - (v / 55) * bh - 3, 'text-anchor': 'middle', class: 't-ink' }, s.snr ?? '–'));
      });
    }
    box.append(svg);
    if (sats.length) box.append(h('div', { class: 'sl-legend', style: 'padding:0 10px 8px' },
      h('span', {}, h('i', { style: 'background:var(--ok)' }), '≥ 40'), h('span', {}, h('i', { style: 'background:var(--warn)' }), '30–40'),
      h('span', {}, h('i', { style: 'background:var(--danger)' }), '< 30 dB-Hz'), used ? h('span', {}, 'hollow: not used in the fix') : null));
    return box;
  }
  function drawTrack(n) {
    const pts = lines().filter((l) => l.pos);
    const box = h('section', { class: 'sl-panel sl-trk' });
    const cur = [...pts].reverse().find((l) => l.n <= n);
    box.append(h('div', { class: 'sl-ph' }, h('b', {}, 'Track'),
      h('span', {}, cur ? `${cur.pos.lat.toFixed(6)}, ${cur.pos.lon.toFixed(6)} · line ${cur.n}${cur.utc ? ` · ${cur.utc}` : ''}` : pts.length ? 'no fix yet at this line' : 'no position in the log')));
    if (!pts.length) return box;
    // metres around the first fix: equirectangular, fine for a local track
    const lat0 = pts[0].pos.lat, lon0 = pts[0].pos.lon, k = Math.cos((lat0 * Math.PI) / 180);
    const xy = (p) => [(p.lon - lon0) * 111320 * k, (p.lat - lat0) * 110574];
    const m = pts.map((l) => xy(l.pos));
    let x0 = Math.min(...m.map((q) => q[0])), x1 = Math.max(...m.map((q) => q[0]));
    let y0 = Math.min(...m.map((q) => q[1])), y1 = Math.max(...m.map((q) => q[1]));
    const span = Math.max(x1 - x0, y1 - y0, 5) * 1.25;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    x0 = mx - span / 2; x1 = mx + span / 2; y0 = my - span / 2; y1 = my + span / 2;
    const W = 300, H = 200, pad = 14;
    const sc = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad - 14) / (y1 - y0));
    const X = (x) => W / 2 + (x - mx) * sc, Y = (y) => (H - 14) / 2 - (y - my) * sc;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Track in metres around the first fix' });
    // scale bar: a round number of metres about a quarter of the width
    const want = (W / 4) / sc;
    const p10 = 10 ** Math.floor(Math.log10(want));
    const bar = [1, 2, 5, 10].map((q) => q * p10).filter((q) => q <= want).pop() || p10;
    for (let gx = Math.ceil(x0 / bar) * bar; gx <= x1; gx += bar) svg.append(sv('line', { class: 'grid', x1: X(gx), x2: X(gx), y1: 0, y2: H - 14 }));
    for (let gy = Math.ceil(y0 / bar) * bar; gy <= y1; gy += bar) svg.append(sv('line', { class: 'grid', x1: 0, x2: W, y1: Y(gy), y2: Y(gy) }));
    const past = pts.filter((l) => l.n <= n);
    if (past.length > 1) svg.append(sv('path', { class: 'path', d: past.map((l, i) => { const q = xy(l.pos); return `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`; }).join('') }));
    pts.forEach((l) => {
      const q = xy(l.pos);
      const c = sv('circle', { class: `pt ${l.n <= n ? 'past' : 'future'}`, cx: X(q[0]), cy: Y(q[1]), r: 4 });
      c.append(sv('title', {}, `line ${l.n} ${l.type}: ${l.pos.lat.toFixed(6)}, ${l.pos.lon.toFixed(6)}`));
      c.addEventListener('click', () => select(l.n));
      svg.append(c);
    });
    if (cur) { const q = xy(cur.pos); svg.append(sv('circle', { class: 'cur', cx: X(q[0]), cy: Y(q[1]), r: 6 })); }
    const bx = 10, by = H - 6;
    svg.append(sv('line', { class: 'scale', x1: bx, x2: bx + bar * sc, y1: by, y2: by }), sv('line', { class: 'scale', x1: bx, x2: bx, y1: by - 4, y2: by }), sv('line', { class: 'scale', x1: bx + bar * sc, x2: bx + bar * sc, y1: by - 4, y2: by }));
    svg.append(sv('text', { x: bx + bar * sc + 5, y: by + 1 }, `${f(bar, 3)} m`));
    svg.append(sv('text', { x: W - 4, y: 10, 'text-anchor': 'end' }, 'N ↑'));
    box.append(svg);
    return box;
  }
  function drawSparks(n) {
    const p = P();
    const box = h('section', { class: 'sl-panel sl-spark' });
    const nums = p.numeric || [];
    box.append(h('div', { class: 'sl-ph' }, h('b', {}, 'Fields over the log'), h('span', {}, `${nums.length} numeric · click to jump`)));
    const rows = p.rows;
    const ri = rows.findIndex((r) => r.n === n);
    for (const nm of nums) {
      const W = 300, H = 58, L = 6, R = 6, T = 16, B = 6;
      const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${nm.name} over the rows` });
      const X = (i) => L + (rows.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (rows.length - 1));
      const span = nm.max - nm.min || Math.abs(nm.max) || 1;
      const Y = (v) => T + (H - T - B) * (1 - (v - (nm.max === nm.min ? nm.min - span / 2 : nm.min)) / span);
      svg.append(sv('rect', { class: 'bg', x: 0, y: 0, width: W, height: H }));
      svg.append(sv('line', { class: 'mean', x1: L, x2: W - R, y1: Y(nm.mean), y2: Y(nm.mean) }));
      let d = '', pen = false;
      rows.forEach((r, i) => {
        const v = Number(r.cells[nm.col]);
        if (r.cells[nm.col] === '' || !Number.isFinite(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true;
      });
      svg.append(sv('path', { class: 'ln', d, stroke: `var(--tool-c${nm.col % 6})`, style: `stroke:var(--tool-c${nm.col % 6})` }));
      if (rows.length <= 120) rows.forEach((r, i) => {
        const v = Number(r.cells[nm.col]);
        if (r.cells[nm.col] !== '' && Number.isFinite(v)) svg.append(sv('circle', { cx: X(i), cy: Y(v), r: 2, style: `fill:var(--tool-c${nm.col % 6})` }));
      });
      let valTxt = '–';
      if (ri >= 0) {
        svg.append(sv('line', { class: 'cursor', x1: X(ri), x2: X(ri), y1: T - 2, y2: H - 2 }));
        const v = Number(rows[ri].cells[nm.col]);
        if (rows[ri].cells[nm.col] !== '' && Number.isFinite(v)) { svg.append(sv('circle', { class: 'dot', cx: X(ri), cy: Y(v), r: 3.5 })); valTxt = rows[ri].cells[nm.col]; }
      }
      svg.append(sv('text', { x: L, y: 11, class: 't-ink' }, `${nm.name} = ${valTxt}`));
      svg.append(sv('text', { x: W - R, y: 11, 'text-anchor': 'end' }, `${f(nm.min, 5)} … ${f(nm.max, 5)} · mean ${f(nm.mean, 4)}`));
      svg.addEventListener('click', (e) => {
        const r = svg.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * W;
        const i = Math.max(0, Math.min(rows.length - 1, Math.round(((x - L) / (W - L - R)) * (rows.length - 1))));
        select(rows[i].n, nm.col, true);
      });
      box.append(h('div', { class: 'row' }, svg));
    }
    if (!nums.length) box.append(h('div', { class: 'sl-empty' }, 'No numeric field.'));
    return box;
  }
  function drawInst() {
    const p = P();
    if (!p || st.sel == null) { inst.replaceChildren(); return; }
    if (p.mode === 'nmea') inst.replaceChildren(drawSky(st.sel), drawTrack(st.sel));
    else inst.replaceChildren(drawSparks(st.sel));
  }

  // ------------------------------------------------------------ selection
  function drawSelection(scroll) {
    const ls = lines();
    for (const el of tape.querySelectorAll('.sl-ln.sel')) { el.classList.remove('sel'); el.setAttribute('aria-selected', 'false'); }
    for (const el of tape.querySelectorAll('.f.on')) el.classList.remove('on');
    const row = tape.querySelector(`.sl-ln[data-n="${st.sel}"]`);
    if (row) {
      row.classList.add('sel'); row.setAttribute('aria-selected', 'true');
      if (st.field != null) row.querySelector(`.f[data-k="${st.field}"]`)?.classList.add('on');
      if (scroll) {
        const tr = tape.getBoundingClientRect(), rr = row.getBoundingClientRect();
        if (rr.top < tr.top || rr.bottom > tr.bottom) tape.scrollTop += rr.top - tr.top - tape.clientHeight / 3;
      }
    }
    const cur = strip.querySelector('.sl-cur');
    if (cur && P()) {
      const total = Math.max(P().total, 1);
      cur.setAttribute('x', ((st.sel - 1) / total) * 1000);
      strip.setAttribute('aria-valuenow', st.sel);
      strip.setAttribute('aria-valuetext', `line ${st.sel} of ${total}`);
    }
    drawFields();
    drawInst();
    void ls;
  }

  ctx.onResult((res) => {
    drawTop(res);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    syncText();
    const p = res.parsed;
    if (!p) {
      tape.replaceChildren(h('div', { class: 'sl-empty' }, 'Nothing parsed yet: paste a log with "Edit log".'));
      strip.replaceChildren(); legend.replaceChildren(); fields.replaceChildren(); inst.replaceChildren();
      if (!st.editing) setEditing(true);
      return;
    }
    drawStrip();
    drawTape();
    const ls = p.lines;
    if (!ls.some((l) => l.n === st.sel)) {
      // start on the first line worth a look: a bad checksum, else the first sentence with a fix
      const first = ls.find((l) => l.kind === 'badcs') || ls.find((l) => l.pos) || ls.find((l) => l.kind === 'row') || ls[0];
      st.sel = first?.n ?? null; st.field = null;
    }
    drawSelection(true);
  });
  function syncText() { if (document.activeElement !== ta && ta.value !== String(ctx.raw.log ?? '')) ta.value = String(ctx.raw.log ?? ''); }
}
