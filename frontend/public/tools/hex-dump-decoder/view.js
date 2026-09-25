// Hex Dump Decoder, custom page: the capture itself, cut into frames.
//   Protocols - one card per framing, each with what it makes of this very
//               capture (valid / bad / unframed), so the right one stands out;
//               click one to use it. Its own settings sit under it.
//   Tape      - the whole capture at a glance, one sliver per byte, coloured
//               by the frame it landed in; click to jump there.
//   Ledger    - one row per frame: the bytes, each tinted by its field
//               (address, function, length, data, checksum ...) with the
//               field's name and value under it, the check and the decoded
//               meaning beside it. Unframed bytes are hatched.
//   Byte      - click a byte to inspect it; type two hex digits to overwrite
//               it, Delete to drop it, Insert to add one: the capture is
//               re-split at once. From a byte you can also make it the
//               delimiter or the sync word.
// Frames, fields, checks and counts come from run()'s result.capture; the
// cards run the same run() for each protocol. Byte values are read with
// tool.js's parseBytes, the parser run() itself uses.
import { run, parseBytes } from './tool.js';

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
const sv = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
};
const h2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const off4 = (o) => '0x' + o.toString(16).toUpperCase().padStart(4, '0');
const chr = (b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : b === 10 ? '\\n' : b === 13 ? '\\r' : b === 9 ? '\\t' : b === 0 ? '\\0' : '·');
const MAX_ROWS = 300, MAX_ROW_BYTES = 512;

const PROTOS = [
  ['modbus', 'Modbus RTU', 'CRC-16'], ['ubx', 'u-blox UBX', 'B5 62 + Fletcher'], ['slip', 'SLIP', 'C0 framed'],
  ['cobs', 'COBS', '00 framed'], ['delim', 'Delimiter', 'split at a byte'], ['fixed', 'Fixed length', 'every N bytes'],
  ['len', 'Sync + length', 'length field'],
];
const ROLE = {
  addr: 'address / slave id', func: 'function, class or header', meta: 'length, count or register address',
  data: 'data / payload', check: 'checksum', sync: 'sync word', delim: 'delimiter', esc: 'escape sequence',
  code: 'COBS code byte (overhead)', junk: 'belongs to no frame', gap: 'between frames',
};

export function page(root, ctx) {
  const st = { sel: null, pend: null, focusSel: false, cardsKey: '', cards: new Map(), bytes: [], cap: null };

  // ------------------------------------------------------------ layout
  const cards = h('div', { class: 'hx-cards', role: 'radiogroup', 'aria-label': 'Protocol' });
  const params = h('div', { class: 'hx-params' });
  const tapeSvg = sv('svg', { class: 'hx-tape', role: 'img', 'aria-label': 'Capture overview' });
  const tapeInfo = h('div', { class: 'hx-tapeinfo' });
  const legend = h('div', { class: 'hx-legend' });
  const warns = h('div', { class: 'hx-warns', 'aria-live': 'polite' });
  const ledger = h('div', { class: 'hx-ledger', role: 'grid', 'aria-label': 'Frames, byte by byte. Arrows move, type hex to overwrite, Delete removes, Insert adds.' });
  const insp = h('section', { class: 'hx-panel hx-insp', 'aria-live': 'polite' });
  const ta = h('textarea', { id: 'hx-data', rows: 7, spellcheck: 'false', oninput: (e) => ctx.set('data', e.target.value) });
  const taPanel = h('section', { class: 'hx-panel hx-src' },
    h('label', { class: 'hx-h', for: 'hx-data' }, 'Capture text'),
    h('div', { class: 'hx-soft hx-small' }, 'Paste any hex: spaced, 0x…, run-together, hexdump -C or xxd. Editing a byte in the ledger rewrites this as 16 bytes a line.'),
    ta);
  const notes = h('div', { class: 'hx-notes' });

  root.append(h('div', { class: 'hx' },
    h('section', { class: 'hx-panel hx-top' }, cards, params),
    h('section', { class: 'hx-panel hx-tapep' }, h('div', { class: 'hx-head' }, h('span', { class: 'hx-h' }, 'Capture'), tapeInfo), tapeSvg, legend),
    h('div', { class: 'hx-cols' },
      h('div', { class: 'hx-main' }, warns, ledger, notes),
      h('aside', { class: 'hx-side' }, insp, taPanel, ctx.outputs))));

  // ------------------------------------------------------------ editing the bytes
  const writeBytes = (arr, sel) => {
    const lines = [];
    for (let i = 0; i < arr.length; i += 16) lines.push(arr.slice(i, i + 16).map(h2).join(' '));
    st.sel = arr.length ? Math.max(0, Math.min(arr.length - 1, sel)) : null;
    st.focusSel = true;
    ctx.set('data', lines.join('\n'));
  };
  const setByte = (o, v) => { const a = st.bytes.slice(); a[o] = v; writeBytes(a, o); };
  const delByte = (o) => { const a = st.bytes.slice(); a.splice(o, 1); writeBytes(a, o); };
  const insByte = (o, v = 0) => { const a = st.bytes.slice(); a.splice(o, 0, v); writeBytes(a, o); };
  const select = (o, focus = true) => {
    st.sel = o; st.pend = null;
    st.focusSel = focus;
    drawLedgerSel(); drawTapeSel(); drawInspector();
  };

  ledger.addEventListener('click', (e) => {
    const b = e.target.closest('.hx-b');
    if (b) select(Number(b.dataset.o));
  });
  ledger.addEventListener('keydown', (e) => {
    const b = e.target.closest('.hx-b');
    if (!b) return;
    const o = Number(b.dataset.o), n = st.bytes.length;
    const move = (to) => { e.preventDefault(); if (to >= 0 && to < n) select(to); };
    if (e.key === 'ArrowRight') move(o + 1);
    else if (e.key === 'ArrowLeft') move(o - 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const fr = st.cap?.frames || [];
      const i = fr.findIndex((f) => o >= f.off && o < f.off + f.len);
      const j = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (fr[j]) move(fr[j].off + Math.min(o - (fr[i]?.off ?? o), fr[j].len - 1)); else e.preventDefault();
    } else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(n - 1);
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); delByte(o); }
    else if (e.key === 'Insert') { e.preventDefault(); insByte(o); }
    else if (e.key === 'Escape') { st.pend = null; drawLedgerSel(); }
    else if (/^[0-9a-f]$/i.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (st.pend == null) { st.pend = e.key.toUpperCase(); drawLedgerSel(); }
      else { const v = parseInt(st.pend + e.key, 16); st.pend = null; setByte(o, v); }
    }
  });

  tapeSvg.addEventListener('click', (e) => {
    if (!st.bytes.length) return;
    const r = tapeSvg.getBoundingClientRect();
    const o = Math.floor(((e.clientX - r.left) / r.width) * st.bytes.length);
    select(Math.max(0, Math.min(st.bytes.length - 1, o)));
  });

  // ------------------------------------------------------------ protocol cards
  const keyOf = (raw) => JSON.stringify([raw.data, raw.delim, raw.fixedLen, raw.sync, raw.lenOff, raw.lenSize, raw.lenEndian, raw.lenAdjust]);
  function drawCards(raw) {
    const cur = raw.protocol || 'modbus';
    const key = keyOf(raw);
    if (key !== st.cardsKey) {
      st.cardsKey = key; st.cards.clear();
      const base = ctx.input;
      for (const [p] of PROTOS) {
        let c = null;
        try { c = run({ ...base, protocol: p }).capture; } catch { c = null; }
        st.cards.set(p, c);
      }
    }
    const best = Math.max(...PROTOS.map(([p]) => score(st.cards.get(p))));
    cards.replaceChildren(...PROTOS.map(([p, name, sub]) => {
      const c = st.cards.get(p);
      const cnt = count(c);
      const on = p === cur;
      const btn = h('button', { class: `hx-card${on ? ' is-on' : ''}${c && score(c) === best && best > 0 ? ' is-best' : ''}`, role: 'radio', 'aria-checked': String(on),
        onclick: () => ctx.set('protocol', p) },
      h('b', {}, name), h('span', { class: 'hx-sub' }, sub),
      h('span', { class: 'hx-cc' }, c ? [
        h('i', { class: 'hx-ok' }, `${cnt.ok} ok`),
        cnt.bad ? h('i', { class: 'hx-bad' }, `${cnt.bad} bad`) : null,
        cnt.junk ? h('i', { class: 'hx-junk' }, `${cnt.junk} B loose`) : null,
      ] : h('i', { class: 'hx-soft' }, 'needs settings')),
      h('span', { class: 'hx-bar' }, c ? barOf(c) : null));
      return btn;
    }));
  }
  cards.addEventListener('keydown', (e) => cardKeys(e));
  function cardKeys(e) {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const i = PROTOS.findIndex(([p]) => p === (ctx.raw.protocol || 'modbus'));
    const j = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : PROTOS.length - 1)) % PROTOS.length;
    e.preventDefault();
    ctx.set('protocol', PROTOS[j][0]);
    requestAnimationFrame(() => cards.querySelector('.hx-card.is-on')?.focus());
  }
  const count = (c) => {
    const r = { ok: 0, bad: 0, junk: 0 };
    for (const f of c?.frames || []) { if (f.kind === 'ok') r.ok++; else if (f.kind === 'bad') r.bad++; else r.junk += f.len; }
    return r;
  };
  const score = (c) => { if (!c) return -1; let s = 0; for (const f of c.frames) if (f.kind === 'ok') s += f.len; return s; };
  // a small bar: share of the capture in valid frames / bad frames / loose
  function barOf(c) {
    const n = c.bytes || 1;
    let ok = 0, bad = 0;
    for (const f of c.frames) { if (f.kind === 'ok') ok += f.len; else if (f.kind === 'bad') bad += f.len; }
    return [h('span', { class: 'hx-bok', style: `width:${(ok / n) * 100}%` }), h('span', { class: 'hx-bbad', style: `width:${(bad / n) * 100}%` })];
  }

  // settings of the chosen protocol, as the manifest defines them
  function drawParams(raw) {
    const defs = ctx.manifest.inputs.filter((d) => d.when?.key === 'protocol' && d.when.equals === (raw.protocol || 'modbus'));
    if (!defs.length) { params.replaceChildren(); params.hidden = true; return; }
    params.hidden = false;
    if (params.dataset.p === raw.protocol && params.childElementCount) {
      for (const el of params.querySelectorAll('[data-k]')) if (document.activeElement !== el && el.value !== String(raw[el.dataset.k] ?? '')) el.value = String(raw[el.dataset.k] ?? '');
      return;
    }
    params.dataset.p = raw.protocol;
    params.replaceChildren(...defs.map((d) => {
      let c;
      if (d.type === 'select') {
        c = h('select', { 'data-k': d.key, id: `hx-${d.key}`, onchange: (e) => ctx.set(d.key, e.target.value) },
          d.options.map(([v, t]) => h('option', { value: v, selected: String(raw[d.key]) === String(v) }, t)));
      } else {
        c = h('input', { type: 'text', 'data-k': d.key, id: `hx-${d.key}`, spellcheck: 'false', style: `width:${d.key === 'sync' ? 10 : 6}ch`,
          inputmode: d.type === 'number' ? 'numeric' : null, oninput: (e) => ctx.set(d.key, e.target.value),
          onkeydown: d.type === 'number' ? (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const v = Math.max(0, Math.round(Number(e.target.value) || 0) + (e.key === 'ArrowUp' ? 1 : -1));
            e.target.value = v; ctx.set(d.key, String(v));
          } : null });
        c.value = String(raw[d.key] ?? '');
      }
      return h('label', { class: 'hx-param', for: `hx-${d.key}`, title: d.help || '' }, h('span', {}, d.label), c, d.unit ? h('span', { class: 'hx-soft' }, d.unit) : null);
    }));
  }

  // ------------------------------------------------------------ result in
  ctx.onResult((res) => {
    const raw = ctx.raw;
    if (document.activeElement !== ta && ta.value !== String(raw.data ?? '')) ta.value = String(raw.data ?? '');
    st.bytes = parseBytes(raw.data).bytes;
    st.cap = res.capture || null;
    if (st.sel != null && st.sel >= st.bytes.length) st.sel = st.bytes.length ? st.bytes.length - 1 : null;
    if (st.sel == null && st.bytes.length) st.sel = 0;
    drawCards(raw);
    drawParams(raw);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    drawTape(); drawLegend(); drawLedger(); drawInspector();
  });
  new ResizeObserver(() => drawTape()).observe(tapeSvg);

  // ------------------------------------------------------------ tape
  function frameAt(o) {
    const fr = st.cap?.frames || [];
    for (const f of fr) if (o >= f.off && o < f.off + f.len) return f;
    return null;
  }
  function drawTape() {
    const n = st.bytes.length;
    const W = Math.max(200, Math.round(tapeSvg.clientWidth || 800)), H = 30;
    tapeSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    tapeSvg.setAttribute('height', H);
    const kids = [sv('rect', { x: 0, y: 4, width: W, height: 20, class: 'hx-t-gap' })];
    const c = st.cap;
    if (c && n) {
      const k = W / n;
      for (const f of c.frames) {
        const x = f.off * k, w = Math.max(1, f.len * k);
        kids.push(sv('rect', { x, y: 4, width: w, height: 20, class: `hx-t-${f.kind}` }));
        if (w > 3) kids.push(sv('line', { x1: x, x2: x, y1: 2, y2: 26, class: 'hx-t-cut' }));
      }
    }
    kids.push(sv('rect', { x: 0, y: 0, width: 0, height: H, class: 'hx-t-sel', id: 'hx-tsel' }));
    tapeSvg.replaceChildren(...kids);
    const cnt = count(c);
    tapeInfo.textContent = c ? `${n} bytes · ${cnt.ok} valid frame${cnt.ok === 1 ? '' : 's'} · ${cnt.bad} bad · ${cnt.junk} unframed byte${cnt.junk === 1 ? '' : 's'}` : `${n} bytes`;
    drawTapeSel();
  }
  function drawTapeSel() {
    const r = tapeSvg.querySelector('#hx-tsel');
    const n = st.bytes.length;
    if (!r || st.sel == null || !n) return;
    const W = tapeSvg.viewBox.baseVal.width, k = W / n;
    r.setAttribute('x', st.sel * k - (k < 3 ? 1.5 : 0));
    r.setAttribute('width', Math.max(3, k));
  }
  function drawLegend() {
    const roles = new Set();
    for (const f of st.cap?.frames || []) for (const x of f.fields) roles.add(x.role);
    legend.replaceChildren(...[...roles].map((r) => h('span', { class: `hx-lg hx-r-${r}` }, h('i', {}), ROLE[r] || r)));
  }

  // ------------------------------------------------------------ ledger
  function drawLedger() {
    const c = st.cap;
    if (!c) { ledger.classList.add('is-stale'); return; }
    ledger.classList.remove('is-stale');
    const rows = [];
    // bytes no frame claims (e.g. a leading SLIP END): shown between frames
    const items = [];
    let at = 0;
    for (const f of c.frames) {
      if (f.off > at) items.push({ gap: true, off: at, len: f.off - at });
      items.push(f); at = f.off + f.len;
    }
    if (at < st.bytes.length) items.push({ gap: true, off: at, len: st.bytes.length - at });
    for (const f of items.slice(0, MAX_ROWS)) rows.push(f.gap ? gapRow(f) : frameRow(f));
    if (items.length > MAX_ROWS) rows.push(h('div', { class: 'hx-more' }, `… ${items.length - MAX_ROWS} more rows; the Frames (hex) and JSON outputs have them all.`));
    ledger.replaceChildren(...rows);
    drawLedgerSel();
  }
  const cell = (o) => h('span', { class: 'hx-b', role: 'gridcell', 'data-o': o, tabindex: '-1', 'aria-label': `byte ${o}, ${h2(st.bytes[o])}` }, h2(st.bytes[o]));
  function frameRow(f) {
    const groups = [];
    let shown = 0;
    for (const x of f.fields) {
      if (shown >= MAX_ROW_BYTES) break;
      const take = Math.min(x.len, MAX_ROW_BYTES - shown);
      const cells = [];
      for (let i = 0; i < take; i++) cells.push(cell(f.off + x.from + i));
      shown += take;
      groups.push(h('span', { class: `hx-fld hx-r-${x.role}${take >= 3 ? ' is-wide' : ''}`, title: `${x.name}: ${ROLE[x.role] || x.role}` },
        h('span', { class: 'hx-cells' }, cells), h('span', { class: 'hx-fn' }, x.name)));
    }
    if (f.len > shown) groups.push(h('span', { class: 'hx-soft hx-cut' }, `… +${f.len - shown} bytes`));
    const tag = f.kind === 'ok' ? 'hx-st-ok' : f.kind === 'bad' ? 'hx-st-bad' : 'hx-st-junk';
    return h('div', { class: `hx-row hx-k-${f.kind}`, role: 'row', 'data-n': f.n },
      h('div', { class: 'hx-rh' },
        h('span', { class: 'hx-n' }, f.kind === 'junk' ? '?' : `#${f.n}`),
        h('span', { class: 'hx-off' }, off4(f.off)),
        h('span', { class: 'hx-len' }, `${f.len} B`),
        h('span', { class: `hx-st ${tag}` }, f.check),
        h('span', { class: 'hx-info' }, f.info)),
      h('div', { class: 'hx-flow' }, groups));
  }
  function gapRow(g) {
    const cells = [];
    for (let i = 0; i < Math.min(g.len, MAX_ROW_BYTES); i++) cells.push(cell(g.off + i));
    return h('div', { class: 'hx-row hx-k-gap', role: 'row' },
      h('div', { class: 'hx-flow' }, h('span', { class: 'hx-fld hx-r-gap' }, h('span', { class: 'hx-cells' }, cells), h('span', { class: 'hx-fn' }, 'no frame'))));
  }
  function drawLedgerSel() {
    for (const el of ledger.querySelectorAll('.hx-b.is-sel')) { el.classList.remove('is-sel', 'is-pend'); el.tabIndex = -1; el.textContent = h2(st.bytes[Number(el.dataset.o)] ?? 0); }
    for (const el of ledger.querySelectorAll('.hx-row.is-sel')) el.classList.remove('is-sel');
    let el = st.sel != null ? ledger.querySelector(`.hx-b[data-o="${st.sel}"]`) : null;
    if (!el) el = ledger.querySelector('.hx-b');
    if (!el) return;
    el.tabIndex = 0;
    if (st.sel == null) return;
    el.classList.add('is-sel');
    el.closest('.hx-row')?.classList.add('is-sel');
    if (st.pend != null) { el.classList.add('is-pend'); el.textContent = `${st.pend}_`; }
    if (st.focusSel) { st.focusSel = false; el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  // ------------------------------------------------------------ inspector
  function drawInspector() {
    const o = st.sel;
    if (o == null || o >= st.bytes.length) {
      insp.replaceChildren(h('div', { class: 'hx-h' }, 'Byte'), h('div', { class: 'hx-soft' }, 'No bytes yet: paste a capture below.'));
      return;
    }
    const v = st.bytes[o];
    const f = frameAt(o);
    const fld = f?.fields.find((x) => o - f.off >= x.from && o - f.off < x.from + x.len);
    const raw = ctx.raw;
    const act = (t, title, fn) => h('button', { class: 'k-btn', title, onclick: fn }, t);
    const valIn = h('input', { type: 'text', class: 'hx-val', value: h2(v), maxlength: 2, spellcheck: 'false', 'aria-label': 'Byte value, hex',
      onkeydown: (e) => { if (e.key === 'Enter') { const n = parseInt(e.target.value, 16); if (n >= 0 && n <= 255) setByte(o, n); } } });
    const bin = v.toString(2).padStart(8, '0');
    insp.replaceChildren(
      h('div', { class: 'hx-head' }, h('span', { class: 'hx-h' }, 'Byte'), h('span', { class: 'hx-mono' }, `${off4(o)} · #${o}`)),
      h('div', { class: 'hx-big' },
        h('span', { class: `hx-bigb hx-r-${fld?.role || 'gap'}` }, h2(v)),
        h('span', { class: 'hx-bigv' },
          h('span', {}, h('i', {}, 'dec'), String(v)), h('span', {}, h('i', {}, 'bin'), `${bin.slice(0, 4)} ${bin.slice(4)}`),
          h('span', {}, h('i', {}, 'char'), `'${chr(v)}'`), h('span', {}, h('i', {}, 'int8'), String(v > 127 ? v - 256 : v)))),
      h('div', { class: 'hx-where' },
        f ? h('div', {}, f.kind === 'junk' ? 'Unframed run at ' : `Frame #${f.n} at `, h('span', { class: 'hx-mono' }, off4(f.off)), `, byte ${o - f.off + 1} of ${f.len}`) : h('div', {}, 'Between frames'),
        fld ? h('div', {}, h('b', {}, fld.name), ` — ${ROLE[fld.role] || fld.role}`) : null,
        f && f.kind !== 'junk' ? h('div', { class: f.kind === 'bad' ? 'hx-badt' : 'hx-okt' }, f.check) : null),
      h('div', { class: 'hx-acts' },
        h('label', { class: 'hx-param' }, h('span', {}, 'Value'), valIn),
        act('Delete', 'Remove this byte (Delete key)', () => delByte(o)),
        act('Insert 00', 'Insert a 00 before this byte (Insert key)', () => insByte(o))),
      h('div', { class: 'hx-acts' },
        act(`Split at ${h2(v)}`, 'Use this byte value as the frame delimiter', () => ctx.setMany({ protocol: 'delim', delim: h2(v) })),
        o + 1 < st.bytes.length ? act(`Sync on ${h2(v)} ${h2(st.bytes[o + 1])}`, 'Use this byte and the next as the sync word of a sync + length frame', () => ctx.setMany({ protocol: 'len', sync: `${h2(v)} ${h2(st.bytes[o + 1])}` })) : null,
        (raw.protocol === 'fixed' && o > 0) ? act(`Length ${o}`, 'Frames of this many bytes: this byte starts the second frame', () => ctx.set('fixedLen', String(o))) : null),
      h('div', { class: 'hx-soft hx-small' }, 'In the ledger: arrows move, two hex digits overwrite, Delete removes, Insert adds a byte.'));
  }
}
