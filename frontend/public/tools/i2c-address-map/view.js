// I2C Address Map, custom page: the bus's 128 addresses as a board, the
// devices sitting on it as chips.
//   Board   - 0x00-0x7F in rows of 16 (8 on a phone), like i2cdetect but
//             large. Reserved addresses are hatched with what they are for;
//             two chips on one address turn the cell red.
//   Straps  - pick a chip and every address its strap pins allow lights up:
//             free ones as open sockets, taken ones amber. Drag the chip to a
//             socket (or press the arrow keys) to re-strap it: the device line
//             gets that address. A part the tool does not know can go anywhere.
//   Rack    - beside the board: the selected chip (7-bit, 8-bit write/read
//             bytes, how its pins set the address, remove), a field to add a
//             part, the devices in address order, and the list as text.
// Placement, status, alternatives and conflicts come from run()'s result.map;
// the page only writes addresses back into the list input.
import { PART_NAMES } from './tool.js';

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
const hx = (a) => '0x' + a.toString(16).toUpperCase().padStart(2, '0');
const RES_SHORT = (a) => (a === 0 ? 'general call' : a === 1 ? 'CBUS' : a === 2 ? 'other bus' : a === 3 ? 'future' : a <= 7 ? 'Hs master'
  : a <= 0x7B ? '10-bit' : 'device ID');

export function page(root, ctx) {
  const st = { sel: null, map: null, cols: 16, drag: null, msg: '' };
  try { const v = sessionStorage.getItem('redline.i2cmap.sel'); if (v) st.sel = Number(v); } catch { /* */ }

  // ------------------------------------------------------------ layout
  const board = h('div', { class: 'am-board', role: 'grid', 'aria-label': 'I2C address space' });
  const boardHead = h('div', { class: 'am-head' });
  const msg = h('div', { class: 'am-msg', 'aria-live': 'polite' });
  const warns = h('div', { class: 'am-warns', 'aria-live': 'polite' });
  const detail = h('section', { class: 'am-panel am-detail' });
  const addIn = h('input', { type: 'text', id: 'am-add', list: 'am-parts', spellcheck: 'false', placeholder: 'e.g. SHT31, TMP102 0x49, LM75 x2',
    onkeydown: (e) => { if (e.key === 'Enter') addDevice(); } });
  const addPanel = h('section', { class: 'am-panel am-add' },
    h('label', { class: 'am-h', for: 'am-add' }, 'Add a part'),
    h('div', { class: 'am-row' }, addIn, h('button', { class: 'k-btn k-primary', onclick: () => addDevice() }, 'Add')),
    h('datalist', { id: 'am-parts' }, PART_NAMES.map((n) => h('option', { value: n }))),
    h('div', { class: 'am-soft am-small' }, 'Known parts land on their first free strap address; unknown ones need an address.'));
  const rack = h('div', { class: 'am-rack', role: 'list', 'aria-label': 'Devices by address' });
  const rackPanel = h('section', { class: 'am-panel' }, h('div', { class: 'am-h' }, 'On the bus'), rack);
  const listTa = h('textarea', { id: 'am-list', rows: 8, spellcheck: 'false', wrap: 'off', oninput: (e) => ctx.set('list', e.target.value) });
  const fmtSel = h('select', { id: 'am-format', onchange: (e) => ctx.set('format', e.target.value) },
    h('option', { value: '7bit' }, '7-bit addresses'), h('option', { value: '8bit' }, '8-bit write addresses'));
  const busIn = h('input', { type: 'text', id: 'am-bus', spellcheck: 'false', style: 'width:9ch', oninput: (e) => ctx.set('bus', e.target.value) });
  const srcPanel = h('section', { class: 'am-panel' },
    h('div', { class: 'am-row am-between' }, h('label', { class: 'am-h', for: 'am-list' }, 'Device list'),
      h('label', { class: 'am-soft am-small am-inl' }, 'Bus ', busIn), fmtSel),
    h('div', { class: 'am-soft am-small' }, 'One part a line, optional address and count (INA219 x3), or paste i2cdetect -y output.'),
    listTa);
  const notes = h('div', { class: 'am-notes' });
  const boardPanel = h('section', { class: 'am-panel am-bp' }, boardHead, board, msg);
  root.append(h('div', { class: 'am' },
    h('div', { class: 'am-main' }, boardPanel, warns, notes),
    h('aside', { class: 'am-side' }, detail, addPanel, rackPanel, srcPanel, ctx.outputs)));

  // ------------------------------------------------------------ list editing
  const lines = () => String(ctx.raw.list ?? '').split(/\r?\n/);
  const fmtAddr = (a) => (st.map?.eight ? hx(a << 1) : hx(a));
  const splitComment = (l) => { const m = /(\s*(?:#|\/\/).*)$/.exec(l); return m ? [l.slice(0, m.index), m[1]] : [l, '']; };
  function setAddr(d, a) {
    if (!st.map || st.map.scan) return;
    const ls = lines();
    const idx = d.line - 1;
    if (idx < 0 || idx >= ls.length) return;
    const [, comment] = splitComment(ls[idx]);
    if (d.count > 1) {
      // "INA219 x3" becomes three lines, each with the address it has now, the moved one with its new one
      const sibs = st.map.devices.filter((x) => x.line === d.line).sort((p, q) => p.k - q.k);
      const out = sibs.map((x, j) => `${x.base} ${fmtAddr(x.i === d.i ? a : x.addr)}${j === 0 ? comment : ''}`);
      ls.splice(idx, 1, ...out);
    } else ls[idx] = `${d.base} ${fmtAddr(a)}${comment}`;
    ctx.set('list', ls.join('\n'));
  }
  function removeDev(d) {
    if (!st.map || st.map.scan) return;
    const ls = lines();
    const idx = d.line - 1;
    if (d.count > 1) {
      const [body, comment] = splitComment(ls[idx]);
      const n = d.count - 1;
      ls[idx] = body.replace(/(^|\s)(?:[x×*]\d{1,2}|\d{1,2}[x×])(?=\s|$)/i, n > 1 ? `$1x${n}` : '').replace(/\s+$/, '') + comment;
    } else ls.splice(idx, 1);
    st.sel = null;
    ctx.set('list', ls.join('\n'));
  }
  function addDevice() {
    const t = addIn.value.trim();
    if (!t) { addIn.focus(); return; }
    const cur = String(ctx.raw.list ?? '').replace(/\s+$/, '');
    st.pendingSel = (st.map?.devices.length ?? 0);
    ctx.set('list', cur ? `${cur}\n${t}` : t);
    addIn.value = '';
  }
  function scanToList() {
    const ds = st.map?.devices || [];
    ctx.setMany({ list: ds.map((d) => `dev_${d.addr.toString(16).toUpperCase().padStart(2, '0')} ${hx(d.addr)}`).join('\n'), format: '7bit' });
  }

  // ------------------------------------------------------------ result in
  ctx.onResult((res) => {
    const raw = ctx.raw;
    if (document.activeElement !== listTa && listTa.value !== String(raw.list ?? '')) listTa.value = String(raw.list ?? '');
    if (document.activeElement !== busIn && busIn.value !== String(raw.bus ?? '')) busIn.value = String(raw.bus ?? '');
    fmtSel.value = raw.format === '8bit' ? '8bit' : '7bit';
    st.map = res.map || null;
    st.msg = '';
    const n = st.map?.devices.length ?? 0;
    if (st.pendingSel != null) { st.sel = st.pendingSel < n ? st.pendingSel : st.sel; st.pendingSel = null; }
    if (st.sel != null && st.sel >= n) st.sel = null;
    if (st.sel == null && st.map) st.sel = st.map.devices.findIndex((d) => d.conflict);
    if (st.sel < 0) st.sel = null;
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    drawAll();
  });
  new ResizeObserver(() => {
    const w = boardPanel.clientWidth;
    const cols = w < 600 ? 8 : 16;
    if (cols !== st.cols) { st.cols = cols; drawBoard(); }
  }).observe(boardPanel);

  function drawAll() {
    try { sessionStorage.setItem('redline.i2cmap.sel', st.sel == null ? '' : String(st.sel)); } catch { /* */ }
    drawBoard(); drawDetail(); drawRack();
  }
  const selDev = () => (st.sel != null ? st.map?.devices[st.sel] : null);
  const select = (i, focus) => {
    st.sel = i; st.msg = '';
    drawAll();
    if (focus) requestAnimationFrame(() => board.querySelector(`.am-chip[data-i="${i}"]`)?.focus());
  };

  // ------------------------------------------------------------ board
  function drawBoard() {
    const m = st.map;
    board.classList.toggle('is-stale', !m);
    const byAddr = new Map();
    for (const d of m?.devices || []) { if (!byAddr.has(d.addr)) byAddr.set(d.addr, []); byAddr.get(d.addr).push(d); }
    const sel = selDev();
    const allowed = new Set(sel?.allowed || []);
    const cols = st.cols;
    board.style.setProperty('--am-cols', cols);
    const kids = [h('div', { class: 'am-corner' }, m?.eight ? '8-bit' : '')];
    for (let c = 0; c < cols; c++) kids.push(h('div', { class: 'am-colh' }, c.toString(16).toUpperCase()));
    for (let r = 0; r < 128 / cols; r++) {
      const base = r * cols;
      kids.push(h('div', { class: 'am-rowh' }, base.toString(16).toUpperCase().padStart(2, '0')));
      for (let c = 0; c < cols; c++) {
        const a = base + c;
        const ds = byAddr.get(a) || [];
        const res = a <= 7 || a >= 0x78;
        const isSlot = sel && sel.allowed && allowed.has(a) && a !== sel.addr;
        const cls = ['am-cell'];
        if (res) cls.push('is-res');
        if (ds.length > 1) cls.push('is-clash');
        if (isSlot) cls.push(ds.length ? 'is-slot-taken' : res ? 'is-slot-res' : 'is-slot');
        if (sel && !sel.allowed && !ds.length && !res && !m.scan) cls.push('is-any');
        const cell = h('div', { class: cls.join(' '), role: 'gridcell', 'data-a': a,
          title: `${hx(a)}${m?.eight ? ` (write ${hx(a << 1)}, read ${hx((a << 1) | 1)})` : ''}${res ? ` — reserved: ${RES_SHORT(a)}` : ''}${ds.length ? ' — ' + ds.map((d) => d.name).join(', ') : ''}`,
          onclick: () => { if (isSlot || (sel && !sel.allowed && !m.scan && !ds.length)) setAddr(sel, a); } },
        h('span', { class: 'am-a' }, m?.eight ? hx(a << 1).slice(2) : hx(a).slice(2)));
        if (res && !ds.length) cell.append(h('span', { class: 'am-rw' }, RES_SHORT(a)));
        if (isSlot && !ds.length) cell.append(h('span', { class: 'am-sock' }, 'strap'));
        for (const d of ds) cell.append(chip(d, ds.length));
        if (ds.length > 1) cell.append(h('span', { class: 'am-n' }, String(ds.length)));
        kids.push(cell);
      }
    }
    board.replaceChildren(...kids);
    const free = m ? 112 - [...byAddr.keys()].filter((a) => a >= 8 && a < 0x78).length : 0;
    const clashes = m ? [...byAddr.values()].filter((x) => x.length > 1).length : 0;
    boardHead.replaceChildren(
      h('span', { class: 'am-h' }, `Bus ${m?.bus || ''}`),
      h('span', { class: 'am-soft' }, m ? `${m.devices.length} device${m.devices.length === 1 ? '' : 's'} · ${free} of 112 addresses free` : ''),
      clashes ? h('span', { class: 'am-bad' }, `${clashes} address${clashes === 1 ? '' : 'es'} with two devices`) : m ? h('span', { class: 'am-ok' }, 'no conflicts') : null,
      m?.scan ? h('button', { class: 'k-btn am-right', onclick: scanToList }, 'Edit as a device list') : h('span', { class: 'am-soft am-right am-small' }, 'drag a chip to a strap socket; arrows move the selected one'));
    msg.textContent = st.msg;
  }

  function chip(d, n) {
    const on = d.i === st.sel;
    const label = st.map?.scan ? (/in use/.test(d.name) ? 'UU' : 'answers') : d.base;
    const short = label.length > 9 ? label.slice(0, 8) + '…' : label;
    const el = h('div', { class: `am-chip${on ? ' is-sel' : ''}${d.conflict ? ' is-bad' : d.reserved || /not an address/.test(d.status) ? ' is-warn' : ''}${d.from === 'given' ? ' is-given' : ''}${n > 1 ? ' is-half' : ''}`,
      'data-i': d.i, tabindex: on || (st.sel == null && d.i === 0) ? 0 : -1, role: 'button',
      'aria-label': `${d.name} at ${hx(d.addr)}, ${d.status}. Arrow keys move it to the next strap address.`,
      'aria-pressed': String(on) },
    h('b', {}, short), d.count > 1 ? h('i', {}, `#${d.k + 1}`) : null);
    el.addEventListener('pointerdown', (e) => startDrag(e, d, el));
    el.addEventListener('keydown', (e) => chipKey(e, d));
    return el;
  }

  // ------------------------------------------------------------ drag and keys
  function startDrag(e, d, el) {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    st.drag = { d, x0: e.clientX, y0: e.clientY, moved: false, ghost: null, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, over: null };
    if (st.sel !== d.i) { st.sel = d.i; st.msg = ''; drawAll(); }
    const move = (ev) => {
      const g = st.drag;
      if (!g) return;
      if (!g.moved && Math.hypot(ev.clientX - g.x0, ev.clientY - g.y0) < 4) return;
      if (!g.moved) {
        g.moved = true;
        g.ghost = h('div', { class: 'am-chip am-ghost', style: `width:${g.w}px` }, h('b', {}, d.base));
        document.body.append(g.ghost);
        board.classList.add('is-dragging');
      }
      g.ghost.style.transform = `translate(${ev.clientX - g.dx}px, ${ev.clientY - g.dy}px)`;
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.am-cell');
      if (g.over !== cell) { g.over?.classList.remove('is-over'); g.over = cell; cell?.classList.add('is-over'); }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const g = st.drag; st.drag = null;
      board.classList.remove('is-dragging');
      g?.ghost?.remove();
      g?.over?.classList.remove('is-over');
      if (!g || !g.moved) { board.querySelector(`.am-chip[data-i="${d.i}"]`)?.focus(); return; }
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.am-cell');
      if (cell) dropOn(d, Number(cell.dataset.a));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  function dropOn(d, a) {
    if (a === d.addr) return;
    if (st.map?.scan) { st.msg = 'A scan shows what answered; turn it into a device list to move things.'; drawBoard(); return; }
    if (d.allowed && !d.allowed.includes(a)) {
      st.msg = `${d.base} cannot take ${hx(a)}: its pins allow ${d.allowed.map(hx).join(' ')}.`;
      drawBoard(); return;
    }
    setAddr(d, a);
  }
  function chipKey(e, d) {
    const m = st.map;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(d.i, true); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (!m.scan) removeDev(d); return; }
    if (e.key === 'Tab' || !['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    if (e.altKey || m.scan) {
      // Alt+arrows (and a scan): walk the chips instead
      const order = [...m.devices].sort((p, q) => p.addr - q.addr || p.i - q.i);
      const j = order.findIndex((x) => x.i === d.i) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
      if (order[j]) select(order[j].i, true);
      return;
    }
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    // the next free address this part can take, in that direction (Up/Down jump a row for an unknown part)
    const cand = d.allowed ? [...d.allowed].sort((p, q) => p - q) : Array.from({ length: 112 }, (_, i) => i + 8);
    const taken = new Set(m.devices.filter((x) => x.i !== d.i).map((x) => x.addr));
    const step = !d.allowed && (e.key === 'ArrowUp' || e.key === 'ArrowDown') ? st.cols : 1;
    let j = cand.indexOf(d.addr);
    if (j < 0) j = dir > 0 ? -1 : cand.length;
    let a = null;
    for (let t = j + dir * step; t >= 0 && t < cand.length; t += dir * step) if (!taken.has(cand[t])) { a = cand[t]; break; }
    if (a == null) { st.msg = `${d.base}: no free address further ${dir > 0 ? 'up' : 'down'} that its pins allow.`; drawBoard(); return; }
    st.sel = d.i; st.refocus = true;
    setAddr(d, a);
  }
  ctx.onResult(() => { if (st.refocus) { st.refocus = false; requestAnimationFrame(() => board.querySelector(`.am-chip[data-i="${st.sel}"]`)?.focus()); } });

  // ------------------------------------------------------------ side
  function drawDetail() {
    const d = selDev();
    const m = st.map;
    if (!d) {
      detail.replaceChildren(h('div', { class: 'am-h' }, 'Device'),
        h('div', { class: 'am-soft' }, m ? 'Click a chip on the board to see its address bytes and strap options.' : 'No devices yet.'));
      return;
    }
    const sockets = (d.allowed || []).map((a) => {
      const taken = m.devices.some((x) => x.addr === a && x.i !== d.i);
      return h('button', { class: `am-pill${a === d.addr ? ' is-cur' : taken ? ' is-taken' : ''}`, disabled: a === d.addr || m.scan ? true : null,
        title: a === d.addr ? 'current address' : taken ? `taken by ${m.devices.filter((x) => x.addr === a).map((x) => x.name).join(', ')}` : 'free: move here',
        onclick: () => setAddr(d, a) }, hx(a));
    });
    detail.replaceChildren(...[
      h('div', { class: 'am-row am-between' }, h('span', { class: 'am-h' }, 'Device'),
        m.scan ? null : h('button', { class: 'k-btn', onclick: () => removeDev(d), title: 'Remove from the list (Delete key on the chip)' }, 'Remove')),
      h('div', { class: 'am-dname' }, h('b', {}, d.name), d.part && d.part !== d.base ? h('span', { class: 'am-soft' }, ` (${d.part} family)`) : null),
      h('div', { class: 'am-bytes' },
        byteBox('7-bit', hx(d.addr)), byteBox('write', hx(d.addr << 1)), byteBox('read', hx((d.addr << 1) | 1))),
      h('div', { class: d.conflict ? 'am-bad' : d.status === 'ok' ? 'am-ok' : 'am-warnt' }, d.status === 'ok' ? `ok · address ${d.from === 'given' ? 'given in the list' : d.from === 'auto' ? 'picked by the tool' : 'from the scan'}` : d.status),
      d.how ? h('div', { class: 'am-how' }, h('span', { class: 'am-soft' }, m.scan ? '' : 'Set by: '), d.how) : null,
      d.allowed ? h('div', { class: 'am-pills' }, h('span', { class: 'am-soft am-small' }, d.allowed.length > 1 ? 'Strap addresses' : 'Fixed address'), sockets)
        : m.scan ? null : h('div', { class: 'am-soft am-small' }, 'Unknown part: any free address can be given (drag it anywhere).')].filter(Boolean));
  }
  const byteBox = (k, v) => h('span', { class: 'am-byte' }, h('i', {}, k), h('b', {}, v));

  function drawRack() {
    const m = st.map;
    if (!m) { rack.replaceChildren(); return; }
    const order = [...m.devices].sort((p, q) => p.addr - q.addr || p.i - q.i);
    rack.replaceChildren(...order.map((d) => h('button', { role: 'listitem', class: `am-ri${d.i === st.sel ? ' is-sel' : ''}${d.conflict ? ' is-bad' : d.status !== 'ok' ? ' is-warn' : ''}`,
      onclick: () => select(d.i, true) },
    h('span', { class: 'am-ra' }, hx(d.addr)), h('span', { class: 'am-rn' }, d.name),
    h('span', { class: 'am-rs' }, d.conflict ? 'conflict' : d.status !== 'ok' ? d.status.split(' (')[0] : d.from))));
  }
}
