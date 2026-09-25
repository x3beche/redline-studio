// Struct Packing Visualizer page: the struct's bytes in memory.
//   Targets   - one card per ABI with this struct's sizeof and padding there
//               (run() on each), click one to lay the struct out for it.
//   Byte map  - one row per machine word, members in colour, padding hatched,
//               a callout per member at the side (offset, size, alignment and
//               the padding it forces). Drag a member (its bytes or its
//               callout) up or down to move its declaration: the source is
//               rewritten and the layout follows. Alt + arrow keys do the same.
//   Tapes     - the struct as written against the largest-alignment-first
//               order, to the same scale, with a button that applies it.
//   Source    - the C code itself, editable.
// Every offset, size and padding shown comes from run()'s result.layout.
import { run } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const ABIS = [['armeabi', 'Cortex-M', 'arm-none-eabi'], ['mcu32', 'ESP32 / RV32', 'int enums'], ['lp64', 'x86-64 / A64', 'Linux, macOS'],
  ['win64', 'Win x64', 'MSVC'], ['i386', 'x86 32-bit', 'i386 SysV'], ['avr', 'AVR', '8-bit']];
const PACKS = [['natural', 'natural'], ['1', 'pack 1'], ['2', '2'], ['4', '4'], ['8', '8']];

const CSS = `
:root { --tool-m0: #2458c6; --tool-m1: #b86200; --tool-m2: #0f8a78; --tool-m3: #9b3fbf; --tool-m4: #5a7d12; --tool-m5: #b8325e; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-m0: #7d9bff; --tool-m1: #f0a33a; --tool-m2: #3cc7b3; --tool-m3: #c982e0; --tool-m4: #a3c95a; --tool-m5: #f07aa0; } }
:root[data-theme="dark"] { --tool-m0: #7d9bff; --tool-m1: #f0a33a; --tool-m2: #3cc7b3; --tool-m3: #c982e0; --tool-m4: #a3c95a; --tool-m5: #f07aa0; }
.k-page { padding: 10px 12px 14px; }
.sp { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.sp svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.sp .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.sp-targets { display: flex; gap: 6px; align-items: stretch; flex-wrap: wrap; }
.sp-abis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; flex: 1 1 640px; min-width: 0; }
.sp-abi { text-align: left; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; padding: 5px 9px 6px; cursor: pointer; min-width: 0; position: relative; }
.sp-abi:hover { border-color: var(--ink-soft); }
.sp-abi[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.sp-abi .n { display: block; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-abi .s { display: block; font-size: 10.5px; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-abi .v { display: block; font: 500 15px "IBM Plex Mono", ui-monospace, monospace; margin-top: 2px; }
.sp-abi .v small { font-size: 11px; color: var(--ink-soft); }
.sp-abi .v em { font-style: normal; font-size: 11px; color: var(--danger); margin-left: 6px; }
.sp-abi .bar { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--ink-soft); opacity: .35; border-radius: 0 0 0 6px; }
.sp-side { display: flex; flex-direction: column; gap: 6px; justify-content: center; font-size: 12px; color: var(--ink-soft); }
.sp-side label { display: flex; align-items: center; gap: 6px; }
.sp-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.sp-seg button { border: 0; background: transparent; padding: 2px 8px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.sp-seg button + button { border-left: 1px solid var(--line); }
.sp-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.sp-side select { padding: 2px 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12px "IBM Plex Mono", ui-monospace, monospace; max-width: 200px; }
.sp-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.sp-card h2 { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--ink-soft); padding: 7px 10px 3px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.sp-card h2 b { font: 600 13px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.sp-card h2 .pad { color: var(--danger); } .sp-card h2 .hint { margin-left: auto; font-weight: 400; }
.sp-mapw { padding: 2px 6px 8px; }
.sp-mapw svg, .sp-tapew svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.sp .mem { cursor: grab; outline: none; }
.sp .mem.nodrag { cursor: default; }
.sp .mem:focus-visible .co { stroke: var(--accent); stroke-width: 2; }
.sp .mem.on .cell { stroke-width: 2.2; }
.sp .dragging, .sp .dragging * { cursor: grabbing !important; }
.sp-tapew { padding: 0 10px 8px; }
.sp-apply { display: flex; align-items: center; gap: 10px; padding: 0 10px 9px; font-size: 12px; color: var(--ink-soft); flex-wrap: wrap; }
.sp-btn { padding: 3px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 12px; }
.sp-btn:hover { border-color: var(--ink-soft); }
.sp-btn.pri { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.sp-btn:disabled { opacity: .5; cursor: default; }
.sp-bot { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; align-items: start; }
.sp-src textarea { display: block; width: 100%; min-height: 260px; border: 0; border-top: 1px solid var(--line-soft); background: var(--sunken); resize: vertical;
  font: 12.5px/1.45 "IBM Plex Mono", ui-monospace, monospace; padding: 8px 10px; border-radius: 0 0 6px 6px; tab-size: 4; }
.sp-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.sp-msgs:empty { display: none; }
.sp-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.sp-msgs div.note { border-left-color: var(--line); color: var(--ink-soft); }
.sp-right { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
@media (max-width: 1000px) { .sp-abis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) { .sp-bot { grid-template-columns: minmax(0, 1fr); } .sp-card h2 .hint { margin-left: 0; } }
@media (max-width: 420px) { .sp-abis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
const colOf = (i) => `var(--tool-m${i % 6})`;

// ---------- source editing: find the struct's body and its member statements ----------
function findBody(code, L) {
  const want = String(L.title || '').replace(/^(struct|union)\s+/, '');
  if (!want || /^anonymous/.test(want)) return null;
  const re = /\b(struct|union|__PACKED_STRUCT|__PACKED_UNION)\b/g;
  let m;
  const found = [];
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length;
    // tag and attributes up to '{'
    const head = /^(\s*(?:__attribute__\s*\(\([^)]*\)\)\s*|[A-Za-z_]\w*\s*)*)\{/.exec(code.slice(i));
    if (!head) continue;
    const tagM = /(?:^|\s)(?!__attribute__)([A-Za-z_]\w*)\s*$/.exec(head[1].replace(/__attribute__\s*\(\([^)]*\)\)/g, ' '));
    const open = i + head[0].length - 1;
    let d = 0, j = open;
    for (; j < code.length; j++) {
      const c = code[j];
      if (c === '/' && code[j + 1] === '/') { j = code.indexOf('\n', j); if (j < 0) j = code.length; continue; }
      if (c === '/' && code[j + 1] === '*') { j = code.indexOf('*/', j + 2); if (j < 0) j = code.length; else j++; continue; }
      if (c === '{') d++;
      else if (c === '}') { d--; if (!d) break; }
    }
    const after = /^\s*(?:__attribute__\s*\(\([^)]*\)\)\s*)*([A-Za-z_]\w*)?/.exec(code.slice(j + 1));
    found.push({ open, close: j, tag: tagM ? tagM[1] : null, tdName: after && after[1] ? after[1] : null });
  }
  return found.reverse().find((f) => f.tag === want || f.tdName === want) || null;
}

function statements(body) {
  const out = [];
  let d = 0, start = 0;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === '/' && body[j + 1] === '/') { const e = body.indexOf('\n', j); j = e < 0 ? body.length : e - 1; continue; }
    if (c === '/' && body[j + 1] === '*') { const e = body.indexOf('*/', j + 2); j = e < 0 ? body.length : e + 1; continue; }
    if ('{(['.includes(c)) d++;
    else if ('})]'.includes(c)) d--;
    else if (c === ';' && d === 0) {
      let end = j + 1;
      const nl = body.indexOf('\n', end);
      const rest = body.slice(end, nl < 0 ? body.length : nl);
      if (/^\s*(\/\/.*|\/\*.*\*\/\s*)?$/.test(rest)) end = nl < 0 ? body.length : nl;
      out.push(body.slice(start, end));
      start = end;
    }
  }
  const tail = body.slice(start);
  return { stmts: out, tail };
}

function declNames(stmt) {
  let s = stmt.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/^\s*#[^\n]*/gm, ' ');
  s = s.replace(/__attribute__\s*\(\([\s\S]*?\)\)/g, ' ').replace(/\{[\s\S]*\}/g, ' {} ');
  const names = [];
  const fp = /\(\s*\*+\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*\)/g;
  let m;
  while ((m = fp.exec(s))) names.push(m[1]);
  if (names.length) return names;
  const re = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?::\s*[^,;]+)?\s*(?=[,;])/g;
  while ((m = re.exec(s))) names.push(m[1]);
  return names;
}

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  let res = null, L = null, drag = null, focusName = null, hover = null;

  // ---------- targets ----------
  const abis = h('div', { class: 'sp-abis', role: 'group', 'aria-label': 'Target ABI' });
  const packSeg = h('div', { class: 'sp-seg', role: 'group', 'aria-label': 'Packing' });
  const whichSel = h('select', { 'aria-label': 'Struct to show', onchange: () => ctx.set('which', whichSel.value) });
  const targets = h('div', { class: 'sp-targets' }, abis, h('div', { class: 'sp-side' }, h('label', {}, 'Packing', packSeg), h('label', {}, 'Struct', whichSel)));

  // ---------- map ----------
  const msvg = document.createElementNS(NS, 'svg');
  msvg.setAttribute('role', 'group');
  const mapHead = h('h2');
  const mapW = h('div', { class: 'sp-mapw' }, msvg);
  const mapCard = h('section', { class: 'sp-card' }, mapHead, mapW);

  // ---------- tapes ----------
  const tsvg = document.createElementNS(NS, 'svg');
  tsvg.setAttribute('role', 'img');
  const applyBtn = h('button', { class: 'sp-btn pri', onclick: () => applyOrder() }, 'Apply this order');
  const applyTxt = h('span');
  const tapeCard = h('section', { class: 'sp-card' }, h('h2', {}, 'As written against largest alignment first, same scale'), h('div', { class: 'sp-tapew' }, tsvg), h('div', { class: 'sp-apply' }, applyBtn, applyTxt));

  // ---------- source ----------
  const src = h('textarea', { spellcheck: 'false', 'aria-label': 'C code', rows: 16 });
  src.addEventListener('input', () => ctx.set('code', src.value));
  const srcCard = h('section', { class: 'sp-card sp-src' }, h('h2', {}, 'C source', h('span', { class: 'hint' }, 'structs, typedefs, #define sizes, packed, #pragma pack')), src);
  const msgs = h('div', { class: 'sp-msgs', 'aria-live': 'polite' });
  root.append(h('div', { class: 'sp' }, targets, mapCard, tapeCard, h('div', { class: 'sp-bot' }, srcCard, h('div', { class: 'sp-right' }, msgs, ctx.outputs))));

  // ---------- helpers on the source ----------
  function moveMember(name, toIndexName, after) {
    const code = String(ctx.raw.code ?? '');
    const B = findBody(code, L);
    if (!B) return false;
    const body = code.slice(B.open + 1, B.close);
    const { stmts, tail } = statements(body);
    const idx = (n) => stmts.findIndex((s) => declNames(s).includes(n));
    const a = idx(name), b = idx(toIndexName);
    if (a < 0 || b < 0 || a === b) return false;
    const list = stmts.slice();
    const [st] = list.splice(a, 1);
    let at = list.indexOf(stmts[b]) + (after ? 1 : 0);
    list.splice(at, 0, st);
    return writeBody(code, B, list, stmts, tail);
  }
  function writeBody(code, B, list, orig, tail) {
    const first = orig.find((s) => s.trim()) || '';
    const indent = (/\n([ \t]*)\S/.exec(first) || /^([ \t]*)\S/.exec(first) || [, '    '])[1];
    const lines = list.map((s) => indent + s.replace(/^\s*\n/, '').replace(/^[ \t]*/, ''));
    const closeIndent = /\n([ \t]*)$/.exec(tail) ? /\n([ \t]*)$/.exec(tail)[1] : '';
    const nb = `\n${lines.join('\n')}\n${closeIndent}`;
    ctx.set('code', code.slice(0, B.open + 1) + nb + code.slice(B.close));
    return true;
  }
  function applyOrder() {
    if (!L?.reordered) return;
    const code = String(ctx.raw.code ?? '');
    const B = findBody(code, L);
    if (!B) return;
    const { stmts, tail } = statements(code.slice(B.open + 1, B.close));
    const rank = (s) => { const ns = declNames(s); const r = L.reordered.findIndex((m) => ns.includes(m.name)); return r < 0 ? 1e9 : r; };
    const list = stmts.slice().sort((x, y) => rank(x) - rank(y));
    writeBody(code, B, list, stmts, tail);
  }
  const canReorder = () => !!(L && !L.isUnion && findBody(String(ctx.raw.code ?? ''), L));

  // ---------- targets sync ----------
  function syncTargets() {
    const raw = ctx.raw, inp = ctx.input;
    const cur = raw.abi || 'armeabi';
    const sizes = ABIS.map(([k]) => { try { const r = run({ ...inp, abi: k }); return r.layout ? { size: r.layout.size, pad: r.layout.padding } : null; } catch { return null; } });
    const max = Math.max(1, ...sizes.map((s) => s?.size || 0));
    abis.replaceChildren(...ABIS.map(([k, n, s], i) => h('button', { class: 'sp-abi', 'aria-pressed': String(cur === k), onclick: () => ctx.set('abi', k),
      title: sizes[i] ? `${n}: sizeof ${sizes[i].size}, ${sizes[i].pad} bytes padding` : n },
    h('span', { class: 'n' }, n), h('span', { class: 's' }, s),
    h('span', { class: 'v' }, sizes[i] ? [String(sizes[i].size), h('small', {}, ' B'), sizes[i].pad ? h('em', {}, `${sizes[i].pad} pad`) : null] : '–'),
    h('span', { class: 'bar', style: `width:${sizes[i] ? (100 * sizes[i].size) / max : 0}%` }))));
    packSeg.replaceChildren(...PACKS.map(([v, t]) => h('button', { 'aria-pressed': String((raw.pack || 'natural') === v), onclick: () => ctx.set('pack', v) }, t)));
    const names = L?.structs || [];
    const w = String(raw.which ?? '').trim();
    whichSel.replaceChildren(h('option', { value: '', selected: !w }, `last (${names[names.length - 1] || '–'})`), ...names.map((n) => h('option', { value: n, selected: n === w }, n)));
    if (document.activeElement !== src) src.value = raw.code ?? '';
  }

  // ---------- byte map ----------
  function drawMap() {
    if (!L || !L.size) {
      msvg.setAttribute('viewBox', '0 0 600 60'); msvg.setAttribute('height', 60);
      msvg.innerHTML = `<text x="300" y="34" text-anchor="middle" font-size="12" fill="var(--danger)">${esc((res?.warnings || ['No struct'])[0])}</text>`;
      mapHead.replaceChildren('No layout');
      return;
    }
    const W = Math.max(300, mapW.clientWidth - 12);
    const narrow = W < 620;
    const R = L.rowBytes || 4;
    const nRows = Math.ceil(L.size / R);
    const rows = [];
    for (let r = 0; r < nRows; r++) {
      const a = r * R, b = Math.min(L.size, a + R);
      const pieces = [];
      for (const c of L.cells) {
        const s0 = Math.max(a, c.start), e0 = Math.min(b, c.start + c.len);
        if (e0 > s0) pieces.push({ c, s: s0 - a, e: e0 - a, first: s0 === c.start });
      }
      rows.push({ r, pieces });
    }
    const shown = [];
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      const whole = row.pieces.length === 1 && row.pieces[0].s === 0 && row.pieces[0].e === R ? row.pieces[0].c : null;
      let j = k;
      if (whole) while (j + 1 < rows.length && rows[j + 1].pieces.length === 1 && rows[j + 1].pieces[0].c === whole && rows[j + 1].pieces[0].e === R) j++;
      if (whole && j - k >= 3) { shown.push(row, { fold: true, bytes: (j - k - 1) * R, label: whole.label, c: whole }, rows[j]); k = j; } else shown.push(row);
    }
    const gut = 44, top = 20, rh = narrow ? 34 : 40;
    const mapWpx = narrow ? W - gut - 4 : Math.min(R * 96, Math.max(R * 48, W * 0.46));
    const cw = mapWpx / R;
    const mapH = top + shown.length * rh;
    // member index by name (cells carry idx for members)
    const members = L.members || [];
    const cellIdx = new Map(L.cells.filter((c) => c.kind === 'member').map((c) => [c.label.split(':')[0].split(', ')[0], c.idx]));
    const drag0 = drag?.moving;
    const o = [];
    o.push(`<defs><pattern id="sp-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--danger)" stroke-width="2" stroke-opacity="0.45"/></pattern></defs>`);
    for (let b = 0; b < R; b++) o.push(`<text x="${gut + b * cw + cw / 2}" y="12" text-anchor="middle" font-size="10" fill="var(--ink-soft)">+${b}</text>`);
    const rowY = new Map();
    shown.forEach((row, n) => {
      const y = top + n * rh;
      if (row.fold) {
        o.push(`<text x="${gut + mapWpx / 2}" y="${y + rh / 2 + 4}" text-anchor="middle" font-size="11" fill="var(--ink-soft)">⋮ ${esc(row.label)}: ${row.bytes} more bytes</text>`);
        return;
      }
      rowY.set(row.r, y);
      o.push(`<text x="${gut - 8}" y="${y + rh / 2 + 4}" text-anchor="end" font-size="10.5" fill="var(--ink-soft)">${row.r * R}</text>`);
      for (const p of row.pieces) {
        const x = gut + p.s * cw, w = (p.e - p.s) * cw;
        const pad = p.c.kind === 'pad';
        const col = pad ? 'var(--danger)' : colOf(p.c.idx ?? 0);
        const name = pad ? null : p.c.label.split(':')[0].split(', ')[0];
        const on = name && (name === hover || name === focusName || name === drag0);
        o.push(`<g ${name ? `class="mem${canReorder() ? '' : ' nodrag'}${on ? ' on' : ''}" data-m="${esc(name)}"` : ''}>`);
        o.push(`<rect class="cell" x="${x + 1}" y="${y + 1}" width="${Math.max(1, w - 2)}" height="${rh - 3}" rx="3" fill="${pad ? 'url(#sp-hatch)' : col}" fill-opacity="${pad ? 1 : on ? 0.4 : 0.22}" stroke="${col}" stroke-opacity="${pad ? 0.5 : 0.9}"/>`);
        for (let b = p.s + 1; b < p.e; b++) o.push(`<line x1="${gut + b * cw}" x2="${gut + b * cw}" y1="${y + 2}" y2="${y + 7}" stroke="${col}" stroke-opacity="0.5"/>`);
        const label = pad ? (w > 34 ? `pad ${p.e - p.s}` : '') : p.first ? p.c.label : '…';
        const max = Math.floor((w - 8) / 6.8);
        if (label && max >= 1) o.push(`<text x="${x + w / 2}" y="${y + rh / 2 + (pad || rh < 38 || !p.first ? 4 : 0)}" text-anchor="middle" font-size="12" fill="${pad ? 'var(--danger)' : 'var(--ink)'}" pointer-events="none">${esc(clip(label, max))}</text>`);
        if (!pad && p.first && rh >= 38) {
          const m = members.find((q) => q.name === name);
          const t = m ? `${m.bits ? m.bits[1] + ' bit' : m.size + ' B'}` : '';
          if (t && Math.floor((w - 8) / 6) >= t.length) o.push(`<text x="${x + w / 2}" y="${y + rh / 2 + 13}" text-anchor="middle" font-size="9.5" fill="var(--ink-soft)" pointer-events="none">${t}</text>`);
        }
        o.push('</g>');
      }
    });
    // callouts
    let H = mapH + 8;
    const call = [];
    if (!narrow) {
      const cx = gut + mapWpx + 36, gap = 34;
      let lastY = top - gap + 14;
      for (const m of members) {
        const r0 = Math.floor(m.offset / R);
        const ry = rowY.get(r0) ?? rowY.get([...rowY.keys()].filter((k) => k <= r0).pop()) ?? top;
        const same = members.filter((q) => Math.floor(q.offset / R) === r0);
        const k = same.indexOf(m);
        const sy = ry + (rh - 3) * ((k + 1) / (same.length + 1));
        const y = Math.max(sy, lastY + gap);
        lastY = y;
        call.push({ m, y, ry: sy });
      }
      H = Math.max(H, lastY + 24);
      const room = Math.floor((W - cx - 8) / 6.9);
      for (const c of call) {
        const m = c.m;
        const i = cellIdx.get(m.name) ?? 0;
        const col = colOf(i);
        const on = m.name === hover || m.name === focusName || m.name === drag0;
        const dy = drag && drag.moving === m.name && drag.dy != null ? drag.dy : 0;
        const y = c.y + dy;
        o.push(`<path d="M${gut + mapWpx + 1},${c.ry}H${gut + mapWpx + 8}L${cx - 8},${y}H${cx - 2}" fill="none" stroke="${col}" stroke-opacity="${on ? 0.9 : 0.4}" stroke-width="${on ? 1.5 : 1}" pointer-events="none"/>`);
        const line2 = `@${m.offset}${m.bits ? `.${m.bits[0]}` : ''} · ${m.bits ? m.bits[1] + ' bit' : m.size + ' B'} · align ${m.align}`;
        o.push(`<g class="mem${canReorder() ? '' : ' nodrag'}${on ? ' on' : ''}" data-m="${esc(m.name)}" tabindex="0" role="listitem" aria-label="${esc(`${m.name}, ${m.type}, offset ${m.offset}, ${m.size} bytes, align ${m.align}${m.pad ? `, ${m.pad} bytes of padding before it` : ''}. Alt and arrow keys move it`)}">`
          + `<rect class="co" x="${cx - 4}" y="${y - 15}" width="${W - cx}" height="30" rx="4" fill="${on ? 'var(--sunken)' : 'transparent'}" stroke="${on ? col : 'transparent'}"/>`
          + `<rect x="${cx}" y="${y - 11}" width="4" height="22" rx="1" fill="${col}"/>`
          + `<text x="${cx + 12}" y="${y - 2}" font-size="12.5" font-weight="600" fill="var(--ink)">${esc(clip(m.name, 22))}<tspan font-weight="400" fill="var(--ink-soft)">  ${esc(clip(m.type, Math.max(4, room - m.name.length - 4)))}</tspan></text>`
          + `<text x="${cx + 12}" y="${y + 11}" font-size="10.5" fill="var(--ink-soft)">${esc(line2)}${m.pad ? `<tspan fill="var(--danger)" font-weight="600">  ▲ ${m.pad} B padding before</tspan>` : ''}</text>`
          + `</g>`);
      }
      if (L.tail) {
        const y = Math.min(H - 10, lastY + gap);
        H = Math.max(H, y + 14);
        o.push(`<text x="${cx + 12}" y="${y + 4}" font-size="10.5" font-weight="600" fill="var(--danger)">${L.tail} B tail padding: sizeof rounds up to align ${L.align}</text>`);
      }
      if (drag && drag.target != null) {
        const t = call[drag.target];
        if (t) { const yy = t.y + (drag.after ? 17 : -17); o.push(`<line x1="${cx - 6}" y1="${yy}" x2="${W - 4}" y2="${yy}" stroke="var(--accent)" stroke-width="2.5"/>`); }
      }
    }
    msvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    msvg.setAttribute('height', H);
    msvg.innerHTML = o.join('');
    msvg.setAttribute('aria-label', `Byte map of ${L.title}, ${L.size} bytes, ${L.padding} bytes of padding`);
    msvg._call = call;
    const pct = L.size ? Math.round((100 * L.padding) / L.size) : 0;
    mapHead.replaceChildren(h('b', {}, `sizeof(${L.title}) = ${L.size}`), h('span', {}, `align ${L.align}`),
      h('span', { class: L.padding ? 'pad' : '' }, `${L.padding} B padding (${pct} %)`), h('span', {}, `${R} bytes per row`),
      h('span', { class: 'hint' }, canReorder() && !narrow ? 'Drag a member up or down to move its declaration · Alt + arrows on a callout' : canReorder() ? 'Drag a member onto another to move it' : L.isUnion ? 'a union: every member starts at 0' : ''));
    if (focusName) msvg.querySelector(`g.mem[tabindex][data-m="${window.CSS.escape(focusName)}"]`)?.focus({ preventScroll: true });
  }

  // ---------- tapes ----------
  function drawTapes() {
    const W = Math.max(280, tsvg.parentElement.clientWidth - 20);
    if (!L || !L.size) { tsvg.innerHTML = ''; tsvg.setAttribute('height', 0); return; }
    const x0 = W < 520 ? 4 : 150, x1 = W - 56;
    const max = Math.max(L.size, L.reorderedSize || 0);
    const sc = (x1 - x0) / max;
    const cellIdx = new Map(L.cells.filter((c) => c.kind === 'member').map((c) => [c.label.split(':')[0].split(', ')[0], c.idx]));
    const o = [`<defs><pattern id="sp-hatch2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--danger)" stroke-width="1.6" stroke-opacity="0.5"/></pattern></defs>`];
    const tape = (y, segs, size, label) => {
      if (W >= 520) o.push(`<text x="${x0 - 10}" y="${y + 14}" text-anchor="end" font-size="11" fill="var(--ink-soft)">${label}</text>`);
      else o.push(`<text x="${x0}" y="${y - 3}" font-size="10.5" fill="var(--ink-soft)">${label}</text>`);
      o.push(`<rect x="${x0}" y="${y}" width="${size * sc}" height="20" fill="url(#sp-hatch2)" stroke="var(--line)"/>`);
      for (const s of segs) {
        const col = colOf(cellIdx.get(s.name) ?? 0);
        o.push(`<rect x="${x0 + s.offset * sc + 0.5}" y="${y + 0.5}" width="${Math.max(1, s.size * sc - 1)}" height="19" fill="${col}" fill-opacity="0.35" stroke="${col}" stroke-opacity="0.8"><title>${esc(`${s.name}: offset ${s.offset}, ${s.size} B`)}</title></rect>`);
        if (s.size * sc > 30) o.push(`<text x="${x0 + (s.offset + s.size / 2) * sc}" y="${y + 14}" text-anchor="middle" font-size="10" fill="var(--ink)" pointer-events="none">${esc(clip(s.label || s.name, Math.floor((s.size * sc - 4) / 6)))}</text>`);
      }
      o.push(`<text x="${x0 + size * sc + 6}" y="${y + 14}" font-size="11.5" font-weight="600" fill="var(--ink)">${size} B</text>`);
    };
    const segs = L.isUnion ? [] : L.cells.filter((c) => c.kind === 'member').map((c) => ({ name: c.label.split(':')[0].split(', ')[0], label: c.label, offset: c.start, size: c.len }));
    const top = W < 520 ? 14 : 6;
    tape(top, segs, L.size, 'as written');
    let H = top + 28;
    if (L.reordered) { tape(H + (W < 520 ? 14 : 4), L.reordered, L.reorderedSize, 'largest align first'); H += (W < 520 ? 14 : 4) + 26; }
    for (let b = 0; b <= max; b += Math.max(1, (L.rowBytes || 4) * (max * sc > 400 ? 1 : 2))) o.push(`<line x1="${x0 + b * sc}" y1="${H}" x2="${x0 + b * sc}" y2="${H + 4}" stroke="var(--ink-soft)"/>`, b % ((L.rowBytes || 4) * 2) === 0 ? `<text x="${x0 + b * sc}" y="${H + 14}" font-size="9.5" text-anchor="middle" fill="var(--ink-soft)">${b}</text>` : '');
    H += 18;
    tsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    tsvg.setAttribute('height', H);
    tsvg.innerHTML = o.join('');
    const saves = L.reorderedSize != null && L.reorderedSize < L.size;
    applyBtn.disabled = !saves || !canReorder();
    applyTxt.textContent = L.isUnion ? 'A union: order does not change its size.' : L.reordered == null ? 'Bit-fields: reorder by hand (their packing depends on neighbours).'
      : saves ? `Saves ${L.size - L.reorderedSize} bytes, unless the order is fixed by a protocol or a register map.` : 'Already as small as this struct gets.';
  }

  function drawMsgs() { msgs.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)), ...(res?.notes || []).slice(0, 1).map((n) => h('div', { class: 'note' }, n))); }
  function renderAll() { syncTargets(); drawMap(); drawTapes(); drawMsgs(); }

  // ---------- interaction ----------
  const pt = (e) => { const r = msvg.getBoundingClientRect(), vb = msvg.viewBox.baseVal; return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)]; };
  msvg.addEventListener('pointerover', (e) => { const g = e.target.closest?.('.mem'); const n = g ? g.dataset.m : null; if (n !== hover && !drag) { hover = n; drawMap(); } });
  msvg.addEventListener('pointerleave', () => { if (hover && !drag) { hover = null; drawMap(); } });
  msvg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.mem');
    if (!g || !L || !canReorder()) return;
    e.preventDefault();
    const call = msvg._call;
    const i = call.findIndex((c) => c.m.name === g.dataset.m);
    drag = { moving: g.dataset.m, y0: pt(e)[1], x0: pt(e)[0], i, target: null, after: false, dy: 0 };
    focusName = g.dataset.m;
    msvg.classList.add('dragging');
    msvg.setPointerCapture(e.pointerId);
    drawMap();
  });
  msvg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pt(e);
    drag.dy = p[1] - drag.y0;
    const call = msvg._call;
    if (call.length) {
      // the member whose callout (or first byte row) is nearest the pointer
      let best = null, bd = Infinity;
      call.forEach((c, k) => { const d = Math.min(Math.abs(c.y - p[1]), Math.abs(c.ry - p[1])); if (d < bd) { bd = d; best = k; } });
      if (best != null && best !== drag.i) { drag.target = best; drag.after = best > drag.i; } else drag.target = null;
    } else {
      // narrow: drop onto a member's bytes
      const g = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.mem');
      const k = g ? (L.members || []).findIndex((m) => m.name === g.dataset.m) : -1;
      const i = (L.members || []).findIndex((m) => m.name === drag.moving);
      drag.target = k >= 0 && k !== i ? k : null; drag.after = k > i;
      drag.narrowName = g?.dataset.m;
    }
    drawMap();
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null; msvg.classList.remove('dragging');
    const mem = L.members || [];
    if (d.target != null && mem[d.target]) moveMember(d.moving, mem[d.target].name, d.after);
    else drawMap();
  };
  msvg.addEventListener('pointerup', endDrag);
  msvg.addEventListener('pointercancel', endDrag);
  msvg.addEventListener('focusin', (e) => { const g = e.target.closest?.('.mem'); if (g && g.dataset.m !== focusName) { focusName = g.dataset.m; drawMap(); } });
  msvg.addEventListener('focusout', () => requestAnimationFrame(() => { if (!msvg.contains(document.activeElement) && focusName && !drag) { focusName = null; drawMap(); } }));
  msvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('.mem');
    if (!g || !L) return;
    const mem = L.members || [];
    const i = mem.findIndex((m) => m.name === g.dataset.m);
    const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (e.altKey || e.shiftKey) {
      const j = i + dir;
      if (j >= 0 && j < mem.length && canReorder()) { focusName = mem[i].name; moveMember(mem[i].name, mem[j].name, dir > 0); }
    } else {
      const n = mem[i + dir];
      if (n) { focusName = n.name; msvg.querySelector(`g.mem[tabindex][data-m="${window.CSS.escape(n.name)}"]`)?.focus(); }
    }
  });

  ctx.onResult((r) => { res = r; L = r.layout || null; if (!drag) renderAll(); });
  new ResizeObserver(() => { if (!drag) { drawMap(); drawTapes(); } }).observe(root);
}
