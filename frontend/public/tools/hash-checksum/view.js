// Hash & Checksum Quick Tool, custom page: the bytes and their fingerprints.
//
// Left, the data as a hex dump: every byte a cell (hex over its character).
// Pick a byte and change it - flip one of its eight bits, nudge it, type a hex
// digit, delete it or insert one - and every digest on the right is
// recomputed; the digits that changed light up and each row shows how many of
// its bits flipped. A hash moves about half of them for a one-bit change, a
// byte sum moves one digit: that is the difference between them, seen.
// Paste a known value into Expected and each fingerprint is held against it
// digit by digit; the one that matches is marked.
//
// The digests are run()'s result (tables); the dump uses tool.js's own
// toBytes() to show the bytes run() hashed. Byte edits rewrite the "data"
// input (as text while the bytes are valid UTF-8, else as hex).
import { toBytes } from './tool.js';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const b2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
const ch = (b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : b === 10 ? '\\n' : b === 13 ? '\\r' : b === 9 ? '\\t' : b === 32 ? '␠' : '·');
const bare = (s) => String(s || '').toLowerCase().replace(/^0x/, '');
const normExpect = (s) => String(s ?? '').trim().toLowerCase().replace(/^0x/, '').replace(/[\s:-]/g, '');
const MAXCELLS = 1024;
const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function page(root, ctx) {
  const st = { sel: 0, prev: null, cur: null, prevKey: '', dataKey: '', bytes: [], focusGrid: false, lastEdit: '' };

  // ------------------------------------------------------------ data strip
  const dataTa = h('textarea', { id: 'hc-data', class: 'hc-data', rows: 2, spellcheck: 'false',
    oninput: (e) => { st.lastEdit = 'typed'; ctx.set('data', e.target.value); } });
  const fmtBtns = [['text', 'Text (UTF-8)'], ['hex', 'Hex bytes'], ['base64', 'Base64']].map(([v, t]) =>
    h('button', { type: 'button', 'data-v': v, 'aria-pressed': 'false', onclick: () => ctx.set('format', v) }, t));
  const count = h('span', { class: 'hc-soft hc-small' });
  const strip = h('section', { class: 'hc-panel hc-strip' },
    h('div', { class: 'hc-head' }, h('label', { class: 'hc-h', for: 'hc-data' }, 'Data'),
      h('div', { class: 'hc-seg', role: 'group', 'aria-label': 'Data is' }, fmtBtns), count),
    dataTa);

  // ------------------------------------------------------------ bytes
  const grid = h('div', { class: 'hc-grid', role: 'grid', 'aria-label': 'Bytes. Arrow keys move, hex digits type into the byte, Delete removes it.' });
  const more = h('div', { class: 'hc-soft hc-small' });
  const editor = h('div', { class: 'hc-editor' });
  const bytesPanel = h('section', { class: 'hc-panel hc-bytes' },
    h('div', { class: 'hc-head' }, h('span', { class: 'hc-h' }, 'Bytes'),
      h('span', { class: 'hc-soft hc-small hc-right' }, 'pick a byte, then flip a bit · arrows move, 0-F types, Del removes')),
    grid, more, editor);

  // ------------------------------------------------------------ fingerprints
  const expIn = h('input', { id: 'hc-expect', class: 'hc-expect', type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'paste a known hash or checksum, e.g. ba7816bf… or 0x352441C2', oninput: (e) => ctx.set('expect', e.target.value) });
  const expOut = h('div', { class: 'hc-expout', 'aria-live': 'polite' });
  const rowsBox = h('div', { class: 'hc-rows' });
  const lastNote = h('span', { class: 'hc-soft hc-small' });
  const prints = h('section', { class: 'hc-panel hc-prints' },
    h('div', { class: 'hc-head' }, h('label', { class: 'hc-h', for: 'hc-expect' }, 'Expected'), expOut),
    expIn,
    h('div', { class: 'hc-head hc-mt' }, h('span', { class: 'hc-h' }, 'Fingerprints'), lastNote),
    rowsBox);
  const warns = h('div', { class: 'hc-warns', 'aria-live': 'polite' });
  const notes = h('div', { class: 'hc-notes' });
  const outWrap = h('div', { class: 'hc-out' }, ctx.outputs, notes);

  root.append(h('div', { class: 'hc-page' }, strip, h('div', { class: 'hc-left' }, warns, bytesPanel, outWrap), prints));

  // ------------------------------------------------------------ writing bytes back
  function writeBytes(bytes, why) {
    const fmt = ctx.raw.format || 'text';
    st.lastEdit = why;
    if (fmt === 'hex') { ctx.set('data', bytes.map(b2).join(' ')); return; }
    if (fmt === 'base64') { ctx.set('data', toB64(bytes)); return; }
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
      ctx.set('data', text);
    } catch {
      // not valid UTF-8 any more: carry on as hex bytes
      ctx.setMany({ format: 'hex', data: bytes.map(b2).join(' ') });
    }
  }
  const setByte = (i, v, why) => { const b = st.bytes.slice(); b[i] = v & 255; writeBytes(b, why); };
  const del = (i) => { if (!st.bytes.length) return; const b = st.bytes.slice(); b.splice(i, 1); st.sel = Math.max(0, Math.min(i, b.length - 1)); writeBytes(b, `deleted byte ${i}`); };
  const ins = (i) => { const b = st.bytes.slice(); b.splice(i + 1, 0, 0x20); st.sel = i + 1; writeBytes(b, `inserted byte ${i + 1}`); };

  // ------------------------------------------------------------ drawing: bytes
  function drawGrid(hadFocus) {
    const bytes = st.bytes;
    const cols = (grid.clientWidth || 600) < 520 ? 8 : 16;
    grid.style.setProperty('--cols', cols);
    const n = Math.min(bytes.length, MAXCELLS);
    const cells = [];
    for (let r = 0; r * cols < Math.max(n, 1); r++) {
      const row = h('div', { class: 'hc-row', role: 'row' }, h('span', { class: 'hc-off', role: 'rowheader' }, (r * cols).toString(16).toUpperCase().padStart(4, '0')));
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= n) { row.append(h('span', { class: 'hc-cell hc-none' })); continue; }
        const b = bytes[i];
        const cell = h('button', { type: 'button', role: 'gridcell', class: `hc-cell${i === st.sel ? ' is-sel' : ''}${b >= 0x80 ? ' is-hi' : b < 0x20 || b === 0x7F ? ' is-ctl' : ''}`,
          tabindex: i === st.sel ? '0' : '-1', 'aria-label': `byte ${i}: 0x${b2(b)}${b >= 0x20 && b < 0x7F ? ` '${String.fromCharCode(b)}'` : ''}`, 'data-i': i,
          onclick: () => select(i, true) },
        h('b', {}, b2(b)), h('small', {}, ch(b)));
        cells.push(cell);
        row.append(cell);
      }
      grid.append(row);
    }
    st.cells = cells;
    if (hadFocus && cells[st.sel]) cells[st.sel].focus();
    more.textContent = bytes.length > MAXCELLS ? `${bytes.length - MAXCELLS} more bytes not shown (all ${bytes.length} are hashed).` : '';
  }
  function select(i, focus) {
    if (!st.bytes.length) return;
    st.sel = Math.max(0, Math.min(st.bytes.length - 1, Math.min(i, MAXCELLS - 1)));
    for (const c of st.cells || []) {
      const on = Number(c.dataset.i) === st.sel;
      c.classList.toggle('is-sel', on);
      c.setAttribute('tabindex', on ? '0' : '-1');
    }
    if (focus && st.cells[st.sel]) st.cells[st.sel].focus();
    drawEditor();
  }
  grid.addEventListener('keydown', (e) => {
    if (!e.target.closest('.hc-cell') || !st.bytes.length) return;
    const cols = Number(grid.style.getPropertyValue('--cols')) || 16, i = st.sel;
    const mv = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (mv != null) { e.preventDefault(); select(i + mv, true); return; }
    if (e.key === 'Home') { e.preventDefault(); select(0, true); return; }
    if (e.key === 'End') { e.preventDefault(); select(st.bytes.length - 1, true); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(i); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setByte(i, st.bytes[i] + 1, `byte ${i} + 1`); return; }
    if (e.key === '-') { e.preventDefault(); setByte(i, st.bytes[i] - 1, `byte ${i} − 1`); return; }
    if (/^[0-9a-f]$/i.test(e.key) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setByte(i, ((st.bytes[i] << 4) | parseInt(e.key, 16)) & 255, `typed into byte ${i}`);
    }
  });

  function drawEditor() {
    const bytes = st.bytes;
    if (!bytes.length) { put(editor, h('div', { class: 'hc-soft hc-small' }, 'No bytes. Type data above.')); return; }
    const i = st.sel, v = bytes[i];
    const bits = [];
    for (let k = 7; k >= 0; k--) {
      const on = (v >> k) & 1;
      bits.push(h('button', { type: 'button', class: `hc-bit${on ? ' is-on' : ''}`, 'aria-pressed': String(!!on), 'aria-label': `bit ${k} of byte ${i}`,
        title: `bit ${k} (value ${1 << k}): click to flip`, onclick: () => { st.refocusBit = k; setByte(i, v ^ (1 << k), `flipped bit ${k} of byte ${i}`); } },
      h('small', {}, String(k)), h('b', {}, String(on))));
    }
    put(editor,
      h('div', { class: 'hc-edhead' }, h('span', { class: 'hc-h' }, `Byte ${i}`),
        h('b', { class: 'hc-edval' }, `0x${b2(v)}`), h('span', { class: 'hc-soft' }, `${v} · ${ch(v)}`)),
      h('div', { class: 'hc-bits', role: 'group', 'aria-label': `Bits of byte ${i}` }, bits),
      h('div', { class: 'hc-edbtns' },
        h('button', { type: 'button', class: 'k-btn', onclick: () => setByte(i, v - 1, `byte ${i} − 1`) }, '− 1'),
        h('button', { type: 'button', class: 'k-btn', onclick: () => setByte(i, v + 1, `byte ${i} + 1`) }, '+ 1'),
        h('button', { type: 'button', class: 'k-btn', onclick: () => ins(i) }, 'Insert after'),
        h('button', { type: 'button', class: 'k-btn', onclick: () => del(i) }, 'Delete')));
    if (st.refocusBit != null) {
      const b = editor.querySelectorAll('.hc-bit')[7 - st.refocusBit];
      st.refocusBit = null;
      if (b) b.focus();
    }
  }

  // ------------------------------------------------------------ drawing: fingerprints
  function digitsOf(v) { return String(v || '').replace(/^0x/i, ''); }
  function drawRows(res) {
    const hashes = res.tables?.[0]?.rows || [], sums = res.tables?.[1]?.rows || [];
    const all = [...hashes.map((r) => ({ name: r[0], value: r[1], note: '', kind: 'hash' })),
      ...sums.map((r) => ({ name: r[0], value: r[1], note: r[2], kind: 'sum' }))];
    const exp = normExpect(ctx.raw.expect);
    const prev = st.prev;
    put(rowsBox, all.map((r, idx) => {
      const d = digitsOf(r.value);
      const dl = d.toLowerCase();
      const old = prev && prev[r.name] && prev[r.name].length === d.length ? prev[r.name] : null;
      let flipped = 0;
      const chars = [...d].map((c, k) => {
        const lc = dl[k];
        const changed = old && old[k] !== lc;
        if (old) flipped += POP[parseInt(lc, 16) ^ parseInt(old[k], 16)];
        const m = exp && exp.length === d.length ? (exp[k] === lc ? ' is-eq' : ' is-ne') : '';
        return h('span', { class: `hc-dig${changed ? ' is-chg' : ''}${m}` }, c);
      });
      const match = exp && dl === exp;
      const bitsN = d.length * 4;
      const meter = old ? h('div', { class: 'hc-meter', title: `${flipped} of ${bitsN} bits changed by the last edit` },
        h('span', { class: 'hc-mbar' }, h('i', { style: `width:${(100 * flipped) / bitsN}%` }), h('i', { class: 'hc-mhalf' })),
        h('small', {}, `${flipped}/${bitsN} bits`)) : null;
      const cls = `hc-fp hc-${r.kind}${match ? ' is-match' : ''}${idx === hashes.length ? ' hc-first-sum' : ''}`;
      if (r.kind === 'sum') {
        // a checksum is short: name, value, what it is and the meter on one line
        return h('div', { class: cls },
          h('b', { class: 'hc-sname' }, r.name),
          h('span', { class: 'hc-digs' }, h('span', { class: 'hc-0x' }, '0x'), chars),
          h('span', { class: 'hc-soft hc-small hc-snote' }, match ? h('span', { class: 'hc-matchtag' }, 'MATCHES EXPECTED') : null, match ? ' ' : null, r.note), meter);
      }
      return h('div', { class: cls },
        h('div', { class: 'hc-fphead' }, h('b', {}, r.name), match ? h('span', { class: 'hc-matchtag' }, 'MATCHES EXPECTED') : null,
          h('span', { class: 'hc-soft hc-small' }, `${bitsN}-bit`), meter),
        h('div', { class: 'hc-digs' }, chars));
    }));
    lastNote.textContent = prev && st.lastEdit ? `lit digits changed: ${st.lastEdit}` : 'change a byte to see which digits move';
    // expected summary, from the result's own verdict
    const verdict = res.values?.find((v) => v.label === 'Expected value');
    put(expOut, verdict ? h('span', { class: `hc-verdict hc-${verdict.tone}` }, verdict.value) : null,
      exp && !all.some((r) => digitsOf(r.value).length === exp.length) ? h('span', { class: 'hc-soft hc-small' }, `${exp.length} hex digits: no algorithm here gives that length`) : null);
  }

  // ------------------------------------------------------------ result in
  function render() {
    const res = st.res;
    if (!res) return;
    const raw = ctx.raw;
    if (document.activeElement !== dataTa && dataTa.value !== String(raw.data ?? '')) dataTa.value = String(raw.data ?? '');
    if (document.activeElement !== expIn && expIn.value !== String(raw.expect ?? '')) expIn.value = String(raw.expect ?? '');
    for (const b of fmtBtns) b.setAttribute('aria-pressed', String(b.dataset.v === (raw.format || 'text')));
    put(warns, (res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((n) => h('div', {}, n)));
    const got = toBytes(raw.data, raw.format);
    const ok = !got.error && res.tables;
    root.classList.toggle('hc-stale', !ok);
    if (ok) st.bytes = got.bytes;
    count.textContent = ok ? `${st.bytes.length} byte${st.bytes.length === 1 ? '' : 's'}` : '';
    if (st.sel >= st.bytes.length) st.sel = Math.max(0, st.bytes.length - 1);
    const hadFocus = grid.contains(document.activeElement);
    grid.replaceChildren();
    drawGrid(hadFocus);
    drawEditor();
    if (ok) {
      // the digits of the previous run, to light up what an edit changed
      const cur = Object.fromEntries([...(res.tables[0]?.rows || []), ...(res.tables[1]?.rows || [])].map((r) => [r[0], bare(r[1])]));
      const key = JSON.stringify(cur);
      if (key !== st.prevKey) { st.prev = st.cur; st.cur = cur; st.prevKey = key; }
      drawRows(res);
    }
  }
  ctx.onResult((res) => { st.res = res; render(); });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (Math.abs(w - lastW) < 2) return;
    lastW = w;
    render();
  }).observe(root);
}
