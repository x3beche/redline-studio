// Modbus Frame Builder, custom page: the frame itself, byte by byte.
//
// The request is laid out as a tape of bytes grouped into its fields (slave,
// function, address, quantity, values, CRC). Fields are edited on the tape:
// drag sideways on a field (or focus it and use the arrow keys) to step it,
// Enter to type a value, click a coil bit to flip it, + to add a register.
// The check bytes and the length fields are computed and follow every edit.
// Under the tape the frame is drawn on the line: the t3.5 silences, each
// character at the baud rate, the expected response; pick a character to
// see its bits as the UART sends them. The device's address table below
// shows which registers or coils the request covers; drag the range.
//
// Every byte, length and time drawn is from run()'s result.frame and
// result.values.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const h2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const ms = (s) => (s >= 1 ? `${(s).toFixed(2)} s` : s >= 1e-3 ? `${(s * 1e3).toPrecision(3)} ms` : `${(s * 1e6).toPrecision(3)} µs`);

const FUNCS = [
  ['1', '01', 'Coils', 'read'], ['2', '02', 'Discrete inputs', 'read'], ['3', '03', 'Holding registers', 'read'], ['4', '04', 'Input registers', 'read'],
  ['5', '05', 'Single coil', 'write'], ['6', '06', 'Single register', 'write'], ['15', '15', 'Multiple coils', 'write'], ['16', '16', 'Multiple registers', 'write'],
];
const MODES = [['rtu', 'RTU', 'serial · CRC-16'], ['ascii', 'ASCII', 'serial · LRC'], ['tcp', 'TCP', 'MBAP header']];
const BAUDS = [9600, 19200, 38400, 57600, 115200];

const ROLE = {
  'Slave address': 'env', 'Unit id': 'env', Address: 'env', 'Transaction id': 'env', 'Protocol id': 'env', Length: 'env', Start: 'env', End: 'env',
  'Function code': 'fc', 'Start address': 'addr', 'Register address': 'addr', 'Coil address': 'addr',
  Quantity: 'qty', 'Byte count': 'qty', Value: 'data', 'Register values': 'data', 'Coil states': 'data', CRC: 'check', LRC: 'check',
};
const SHORT = { 'Slave address': 'slave', 'Unit id': 'unit', Address: 'slave', 'Transaction id': 'transaction', 'Protocol id': 'protocol',
  Length: 'length', Start: 'start', End: 'end', 'Function code': 'function', 'Start address': 'start address', 'Register address': 'register',
  'Coil address': 'coil', Quantity: 'quantity', 'Byte count': 'byte count', Value: 'value', 'Register values': 'register values',
  'Coil states': 'coil states', CRC: 'CRC-16', LRC: 'LRC' };

const splitVals = (t) => String(t ?? '').split(/[\s,;]+/).filter(Boolean);
function numOf(t) {
  const s = String(t ?? '').trim();
  if (/^[-+]?0x[0-9a-f]+$/i.test(s)) return (s.startsWith('-') ? -1 : 1) * parseInt(s.replace(/^[-+]/, ''), 16);
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^(on|true|high)$/i.test(s)) return 1;
  if (/^(off|false|low)$/i.test(s)) return 0;
  return null;
}

export function page(root, ctx) {
  const st = { sel: null, focus: null, prev: null, editing: null, hoverField: null };

  // ------------------------------------------------------------ the band: transport, function, numbering, line
  const modeSeg = h('div', { class: 'mb-seg', role: 'radiogroup', 'aria-label': 'Transport' });
  const fnKeys = h('div', { class: 'mb-keys', role: 'radiogroup', 'aria-label': 'Function code' });
  const numSeg = h('div', { class: 'mb-seg mb-small', role: 'radiogroup', 'aria-label': 'Address numbering' });
  const lineBox = h('div', { class: 'mb-line' });
  const band = h('div', { class: 'mb-band' },
    h('div', { class: 'mb-group' }, h('span', { class: 'mb-cap' }, 'Transport'), modeSeg),
    h('div', { class: 'mb-group mb-fn' }, h('span', { class: 'mb-cap' }, 'Function'), fnKeys),
    h('div', { class: 'mb-group' }, h('span', { class: 'mb-cap' }, 'Addresses as'), numSeg),
    lineBox);

  // ------------------------------------------------------------ the tape
  const tapeHead = h('div', { class: 'mb-tapehead' });
  const tape = h('div', { class: 'mb-tape', role: 'group', 'aria-label': 'Request frame, field by field' });
  const tapeHelp = h('div', { class: 'mb-help' },
    'Drag sideways on a field, or focus it and press ↑ ↓ (Shift ×10), to step it. Enter types a value. Grey fields are computed.');
  const warns = h('div', { class: 'mb-warns', 'aria-live': 'polite' });
  const tapePanel = h('section', { class: 'mb-panel mb-tapepanel' }, tapeHead, warns, tape, tapeHelp);

  // ------------------------------------------------------------ the line and the character
  const wireHead = h('div', { class: 'mb-phead' });
  const wire = h('div', { class: 'mb-wire', tabindex: '0', 'aria-label': 'The frame on the line. Left and right arrows pick a character.' });
  const uart = h('div', { class: 'mb-uart' });
  const wirePanel = h('section', { class: 'mb-panel mb-wirepanel' }, wireHead, wire, uart);

  // ------------------------------------------------------------ the address table
  const tblHead = h('div', { class: 'mb-phead' });
  const ruler = h('div', { class: 'mb-ruler' });
  const tblPanel = h('section', { class: 'mb-panel mb-tblpanel' }, tblHead, ruler);

  const notes = h('div', { class: 'mb-notes' });
  const side = h('aside', { class: 'mb-side' }, ctx.outputs, notes);
  root.append(h('div', { class: 'mb-page' }, band, tapePanel, h('div', { class: 'mb-lower' }, wirePanel, tblPanel), side));

  // ------------------------------------------------------------ input helpers
  const raw = () => ctx.raw;
  const F = () => ctx.result?.frame;
  function setAddress(pdu) {
    const fr = F(); if (!fr) return;
    pdu = Math.max(0, Math.min(65535, pdu));
    ctx.set('address', String(raw().addrStyle === 'plc' ? pdu + fr.ref : pdu));
  }
  function setCount(n) {
    const fr = F(); if (!fr) return;
    n = Math.max(1, Math.min(fr.maxQ, n));
    if (fr.fc <= 4) ctx.set('quantity', String(n));
    else if (fr.fc === 15 || fr.fc === 16) {
      const v = splitVals(raw().values);
      while (v.length < n) v.push(fr.fc === 15 ? '0' : '0');
      v.length = n;
      ctx.set('values', v.join(fr.fc === 15 ? ' ' : ', '));
    }
  }
  function setValueAt(i, text) {
    const v = splitVals(raw().values);
    while (v.length <= i) v.push('0');
    v[i] = text;
    ctx.set('values', v.join(F()?.fc === 15 ? ' ' : ', '));
  }
  function removeValueAt(i) {
    const v = splitVals(raw().values);
    if (v.length <= 1) return;
    v.splice(i, 1);
    ctx.set('values', v.join(F()?.fc === 15 ? ' ' : ', '));
  }

  // what a field does when stepped or typed
  function editorFor(field, fr) {
    const L = field.label;
    if (L === 'Slave address' || L === 'Unit id' || L === 'Address') {
      return { key: 'slave', get: () => fr.unit, step: (d) => ctx.set('slave', String(Math.max(0, Math.min(fr.mode === 'tcp' ? 255 : 247, fr.unit + d)))),
        type: (t) => ctx.set('slave', t), text: () => String(raw().slave ?? '') };
    }
    if (L === 'Transaction id') {
      const cur = numOf(raw().tid) ?? 1;
      return { key: 'tid', step: (d) => ctx.set('tid', String((cur + d + 65536) % 65536)), type: (t) => ctx.set('tid', t), text: () => String(raw().tid ?? '') };
    }
    if (L === 'Function code') {
      const i = FUNCS.findIndex((x) => Number(x[0]) === fr.fc);
      return { key: 'fc', step: (d) => pickFc(FUNCS[(i + (d > 0 ? 1 : -1) + FUNCS.length) % FUNCS.length][0]),
        type: (t) => { const n = numOf(t); if (FUNCS.some((x) => Number(x[0]) === n)) pickFc(String(n)); }, text: () => String(fr.fc) };
    }
    if (ROLE[L] === 'addr') {
      return { key: 'address', step: (d) => setAddress(fr.address + d), type: (t) => ctx.set('address', t), text: () => String(raw().address ?? '') };
    }
    if (L === 'Quantity') {
      return { key: 'quantity', step: (d) => setCount(fr.count + d),
        type: (t) => { const n = numOf(t); if (n != null) setCount(n); }, text: () => String(fr.count) };
    }
    if (L === 'Value' && fr.fc === 5) {
      const on = splitVals(raw().values).length ? numOf(splitVals(raw().values)[0]) : 1;
      return { key: 'values', toggle: () => ctx.set('values', on ? '0' : '1'), step: () => ctx.set('values', on ? '0' : '1'),
        type: (t) => ctx.set('values', t), text: () => String(raw().values ?? '') };
    }
    if (L === 'Value' && fr.fc === 6) {
      const cur = numOf(splitVals(raw().values)[0]) ?? 0;
      return { key: 'values', step: (d) => ctx.set('values', String(cur + d)), type: (t) => ctx.set('values', t), text: () => String(splitVals(raw().values)[0] ?? '') };
    }
    return null;
  }

  // ------------------------------------------------------------ band
  function drawBand(fr) {
    const r = raw();
    const radio = (group, cur, value, label, sub, onPick) => h('button', { class: `mb-opt${String(cur) === String(value) ? ' is-on' : ''}`, role: 'radio',
      'aria-checked': String(String(cur) === String(value)), onclick: onPick }, h('b', {}, label), sub ? h('small', {}, sub) : null);
    modeSeg.replaceChildren(...MODES.map(([v, l, s]) => radio(modeSeg, r.mode, v, l, s, () => ctx.set('mode', v))));
    const key = ([v, code, name, kind]) => h('button', { class: `mb-key mb-${kind}${String(r.fc) === v ? ' is-on' : ''}`, role: 'radio',
      'aria-checked': String(String(r.fc) === v), title: `${code} ${name}`, onclick: () => pickFc(v) },
    h('b', {}, code), h('small', {}, name));
    fnKeys.replaceChildren(h('span', { class: 'mb-kgrp' }, h('i', {}, 'read'), ...FUNCS.filter((f) => f[3] === 'read').map(key)),
      h('span', { class: 'mb-kgrp' }, h('i', {}, 'write'), ...FUNCS.filter((f) => f[3] === 'write').map(key)));
    const plcName = fr ? { coil: '00001', 'discrete input': '10001', 'holding register': '40001', 'input register': '30001' }[fr.table] : '40001';
    numSeg.replaceChildren(radio(numSeg, r.addrStyle, 'pdu', 'PDU', '0-based, as sent', () => convertStyle('pdu')),
      radio(numSeg, r.addrStyle, 'plc', 'PLC', `${plcName} = first`, () => convertStyle('plc')));
    if (r.mode === 'tcp') lineBox.replaceChildren(h('span', { class: 'mb-cap' }, 'Line'), h('span', { class: 'mb-soft' }, 'TCP port 502: no baud, no silences'));
    else {
      const baudIn = h('input', { type: 'text', class: 'mb-baudin', 'aria-label': 'Baud rate', spellcheck: 'false',
        onchange: (e) => ctx.set('baud', e.target.value) });
      baudIn.value = String(r.baud ?? '');
      lineBox.replaceChildren(h('span', { class: 'mb-cap' }, 'Baud'),
        h('div', { class: 'mb-seg mb-small', role: 'radiogroup', 'aria-label': 'Baud rate' },
          BAUDS.map((b) => radio(null, Number(ctx.input.baud), b, b >= 1000 ? `${b / 1000}k`.replace('.2k', '.2k') : b, null, () => ctx.set('baud', String(b))))),
        baudIn);
    }
  }
  // a write needs something to write: start it with a value rather than an empty frame
  function pickFc(v) {
    const vals = splitVals(raw().values);
    if ((v === '15' || v === '16') && !vals.length) ctx.setMany({ fc: v, values: v === '15' ? '1 0 1 1' : '0, 0' });
    else if (v === '6' && !vals.length) ctx.setMany({ fc: v, values: '0' });
    else if (v === '15' && vals.some((x) => !/^(0|1|on|off|true|false|high|low)$/i.test(x))) ctx.setMany({ fc: v, values: vals.map((x) => (numOf(x) ? '1' : '0')).join(' ') });
    else ctx.set('fc', v);
  }
  // switching the numbering keeps the same register
  function convertStyle(style) {
    const fr = F();
    if (!fr || raw().addrStyle === style) { ctx.set('addrStyle', style); return; }
    ctx.setMany({ addrStyle: style, address: String(style === 'plc' ? fr.address + fr.ref : fr.address) });
  }

  // ------------------------------------------------------------ tape
  function drawTape(res) {
    const fr = res.frame;
    const vals = Object.fromEntries((res.values || []).map((v) => [v.label, v]));
    if (!fr) {
      tape.classList.add('is-stale');
      return;
    }
    tape.classList.remove('is-stale');
    const len = vals.Length?.value, resp = vals['Expected response'];
    const crc = vals['CRC-16/MODBUS'];
    const lrcF = fr.fields.find((f) => f.label === 'LRC');
    tapeHead.replaceChildren(...[h('span', { class: 'mb-h' }, `${fr.mode.toUpperCase()} request`),
      h('span', { class: 'mb-stat' }, h('b', {}, String(len)), ' bytes'),
      h('span', { class: 'mb-stat' }, fr.func),
      crc ? h('span', { class: 'mb-stat' }, 'CRC ', h('b', {}, crc.value), h('small', {}, ` ${crc.hint}`)) : null,
      lrcF ? h('span', { class: 'mb-stat' }, 'LRC ', h('b', {}, `0x${lrcF.hex}`)) : null,
      resp ? h('span', { class: 'mb-stat mb-right' }, 'reply ', h('b', {}, String(resp.value)), ` bytes · ${resp.hint}`) : null].filter(Boolean));

    // binary bytes per field (ASCII: before hex encoding)
    const bin = fr.mode === 'ascii' ? asciiBinary(fr) : fr.bytes;
    const prev = st.prev;
    let pos = 0, idx = 0;
    const kids = [];
    fr.fields.forEach((f, fi) => {
      const role = ROLE[f.label] || 'env';
      const bytes = bin.slice(pos, pos + f.n);
      const start = pos;
      pos += f.n;
      const ed = editorFor(f, fr);
      const fKey = `${f.label}`;
      const cells = h('div', { class: 'mb-cells' });
      if (f.label === 'Register values') {
        for (let r = 0; r < bytes.length / 2; r++) {
          const v = (bytes[2 * r] << 8) | bytes[2 * r + 1];
          cells.append(regCell(fr, r, v, [start + 2 * r, start + 2 * r + 1], bytes.slice(2 * r, 2 * r + 2), prev));
        }
        cells.append(h('button', { class: 'mb-add', title: 'Add a register', 'aria-label': 'Add a register', disabled: fr.count >= fr.maxQ ? true : null,
          onclick: () => setCount(fr.count + 1) }, '+'));
      } else if (f.label === 'Coil states') {
        bytes.forEach((b, j) => cells.append(coilByte(fr, b, j, start + j, prev)));
        cells.append(h('button', { class: 'mb-add', title: 'Add a coil', 'aria-label': 'Add a coil', onclick: () => setCount(fr.count + 1) }, '+'));
      } else {
        bytes.forEach((b, j) => cells.append(byteCell(fr, b, start + j, f, j, prev)));
      }
      const meaning = h('div', { class: 'mb-mean' }, f.meaning);
      const editable = !!ed && f.label !== 'Register values' && f.label !== 'Coil states';
      const el = h('div', { class: `mb-field mb-r-${role}${editable ? ' is-edit' : ''}${f.label === 'Register values' || f.label === 'Coil states' ? ' is-data' : ''}${ROLE[f.label] === 'check' || ['Byte count', 'Length', 'Protocol id', 'Start', 'End'].includes(f.label) ? ' is-auto' : ''}`,
        'data-field': fKey, 'data-from': start, 'data-to': pos,
        tabindex: editable ? 0 : null, role: editable ? 'spinbutton' : null,
        'aria-label': editable ? `${f.label}: ${f.meaning}. Up and down arrows step it, Enter types it.` : null },
      h('div', { class: 'mb-fhead' },
        h('div', { class: 'mb-flabel' }, SHORT[f.label] || f.label, ROLE[f.label] === 'check' || ['Byte count', 'Length', 'Protocol id'].includes(f.label) ? h('span', { class: 'mb-auto' }, 'auto') : null),
        h('div', { class: 'mb-brace' }), cells), meaning);
      if (editable) wireFieldEditing(el, ed, f, meaning);
      if (f.label === 'CRC' || f.label === 'LRC' || f.label === 'Length') {
        el.addEventListener('mouseenter', () => cover(f.label, fr, true));
        el.addEventListener('mouseleave', () => cover(f.label, fr, false));
      }
      kids.push(el);
      idx++;
    });
    if (fr.mode === 'ascii') kids.push(h('div', { class: 'mb-asciiline' }, h('span', { class: 'mb-cap' }, 'as sent'),
      h('code', {}, [...fr.bytes].map((c) => (c === 13 ? '\\r' : c === 10 ? '\\n' : String.fromCharCode(c))).join(''))));
    tape.replaceChildren(...kids);
    // keep the focused field focused across the redraw
    if (st.focus) {
      const t = tape.querySelector(st.focus);
      if (t) t.focus({ preventScroll: true });
      st.focus = null;
    }
    if (st.editing) openEditor(st.editing);
    markSelected();
  }

  // ASCII frames: rebuild the binary bytes from the hex characters sent
  function asciiBinary(fr) {
    const t = String.fromCharCode(...fr.bytes);
    const body = t.slice(1, t.length - 2);
    const out = [0x3A];
    for (let i = 0; i < body.length; i += 2) out.push(parseInt(body.slice(i, i + 2), 16));
    out.push(0x0D, 0x0A);
    return out;
  }

  function byteCell(fr, b, i, f, j, prev) {
    const changed = prev && prev.bin && prev.bin[i] !== b && prev.mode === fr.mode;
    const sub = fr.mode === 'ascii' && f.label !== 'Start' && f.label !== 'End'
      ? h2(b).split('').map((c) => `'${c}'`).join(' ')
      : f.label === 'Start' ? "':'" : f.label === 'End' ? (j ? 'LF' : 'CR') : String(b);
    const note = f.label === 'CRC' ? (j ? 'hi' : 'lo') : f.n === 2 && ROLE[f.label] !== 'check' && fr.mode !== 'ascii' ? (j ? 'lo' : 'hi') : null;
    return h('div', { class: `mb-cell${changed ? ' is-changed' : ''}`, 'data-i': i, onclick: () => pick(i) },
      h('b', {}, h2(b)), h('small', {}, sub), note ? h('i', {}, note) : null);
  }

  function regCell(fr, r, v, [i0, i1], two, prev) {
    const changed = prev && prev.bin && (prev.bin[i0] !== two[0] || prev.bin[i1] !== two[1]);
    const token = splitVals(raw().values)[r];
    const cell = h('div', { class: `mb-reg${changed ? ' is-changed' : ''}`, tabindex: 0, role: 'spinbutton', 'data-reg': r,
      'aria-label': `Register ${fr.address + r}: ${v}. Arrows step it, Enter types it, Delete removes it.`, 'aria-valuenow': v },
    h('div', { class: 'mb-regbytes' },
      h('div', { class: 'mb-cell', 'data-i': i0, onclick: () => pick(i0) }, h('b', {}, h2(two[0])), h('i', {}, 'hi')),
      h('div', { class: 'mb-cell', 'data-i': i1, onclick: () => pick(i1) }, h('b', {}, h2(two[1])), h('i', {}, 'lo'))),
    h('div', { class: 'mb-regval' }, h('b', {}, String(v)), v > 32767 ? h('small', {}, ` (${v - 65536})`) : null),
    h('div', { class: 'mb-regaddr' }, `@${raw().addrStyle === 'plc' ? fr.address + r + fr.ref : fr.address + r}`),
    h('button', { class: 'mb-del', tabindex: -1, title: 'Remove this register', 'aria-label': 'Remove this register', onclick: (e) => { e.stopPropagation(); removeValueAt(r); } }, '×'));
    const cur = () => numOf(token) ?? v;
    cell.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowDown: -1, PageUp: 100, PageDown: -100 }[e.key];
      if (d) { e.preventDefault(); st.focus = `[data-reg="${r}"]`; setValueAt(r, String(cur() + d * (e.shiftKey ? 10 : 1))); }
      else if (e.key === 'Enter') { e.preventDefault(); st.editing = { reg: r }; openEditor(st.editing); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); st.focus = `[data-reg="${Math.max(0, r - 1)}"]`; removeValueAt(r); }
    });
    cell.addEventListener('dblclick', () => { st.editing = { reg: r }; openEditor(st.editing); });
    scrub(cell, (d) => setValueAt(r, String(cur() + d)), `[data-reg="${r}"]`);
    return cell;
  }

  function coilByte(fr, b, j, i, prev) {
    const changed = prev && prev.bin && prev.bin[i] !== b;
    const bits = [];
    for (let k = 7; k >= 0; k--) {
      const coil = j * 8 + k;
      const used = coil < fr.count;
      const on = (b >> k) & 1;
      bits.push(h('button', { class: `mb-bit${on ? ' is-on' : ''}${used ? '' : ' is-pad'}`, disabled: used ? null : true, 'data-coil': coil,
        role: 'switch', 'aria-checked': String(!!on), 'aria-label': `Coil ${fr.address + coil + (raw().addrStyle === 'plc' ? fr.ref : 0)}: ${on ? 'on' : 'off'}`,
        title: used ? `coil ${fr.address + coil} → bit ${k} of byte ${j}` : 'padding bit (sent as 0)',
        onclick: () => { st.focus = `[data-coil="${coil}"]`; setValueAt(coil, on ? '0' : '1'); } }, on ? '1' : '0'));
    }
    return h('div', { class: `mb-coilbyte${changed ? ' is-changed' : ''}` },
      h('div', { class: 'mb-cell', 'data-i': i, onclick: () => pick(i) }, h('b', {}, h2(b))),
      h('div', { class: 'mb-bits' }, bits), h('div', { class: 'mb-bitidx' }, `coils ${j * 8}–${Math.min(fr.count, j * 8 + 8) - 1} · bit 7…0`));
  }

  function wireFieldEditing(el, ed, f, meaning) {
    const sel = `[data-field="${CSS.escape(f.label)}"]`;
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      const d = { ArrowUp: 1, ArrowDown: -1, ArrowRight: 1, ArrowLeft: -1, PageUp: 100, PageDown: -100 }[e.key];
      if (d) { e.preventDefault(); st.focus = sel; ed.step(d * (e.shiftKey ? 10 : 1)); }
      else if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); if (ed.toggle) { st.focus = sel; ed.toggle(); } else { st.editing = { field: f.label }; openEditor(st.editing); } }
      else if (e.key === ' ' && ed.toggle) { e.preventDefault(); st.focus = sel; ed.toggle(); }
    });
    if (ed.toggle) el.addEventListener('click', () => { st.focus = sel; ed.toggle(); });
    else {
      el.addEventListener('dblclick', () => { st.editing = { field: f.label }; openEditor(st.editing); });
      scrub(el, (d) => ed.step(d), sel);
    }
    el._ed = ed; el._meaning = meaning;
  }

  // drag sideways on a field: one step per 10 px
  function scrub(el, apply, sel) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input')) return;
      const x0 = e.clientX;
      let applied = 0, moved = false;
      document.body.classList.add('mb-scrubbing');
      const move = (ev) => {
        const steps = Math.round((ev.clientX - x0) / 10);
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        if (steps !== applied) { const d = steps - applied; applied = steps; st.focus = sel; apply(d); }
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        document.body.classList.remove('mb-scrubbing');
        if (!moved) tape.querySelector(sel)?.focus({ preventScroll: true });
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
  }

  function openEditor(ed) {
    let host, text, commit;
    if (ed.reg != null) {
      host = tape.querySelector(`[data-reg="${ed.reg}"] .mb-regval`);
      text = splitVals(raw().values)[ed.reg] ?? '';
      commit = (t) => { st.focus = `[data-reg="${ed.reg}"]`; setValueAt(ed.reg, t.trim() || '0'); };
    } else {
      const el = tape.querySelector(`[data-field="${CSS.escape(ed.field)}"]`);
      if (!el?._ed) { st.editing = null; return; }
      host = el._meaning; text = el._ed.text();
      commit = (t) => { st.focus = `[data-field="${CSS.escape(ed.field)}"]`; el._ed.type(t.trim()); };
    }
    if (!host) { st.editing = null; return; }
    const inp = h('input', { class: 'mb-edit', type: 'text', spellcheck: 'false', 'aria-label': 'Type a value, Enter to set, Escape to cancel' });
    inp.value = text;
    let done = false;
    const finish = (ok) => { if (done) return; done = true; st.editing = null; if (ok && inp.value !== text) commit(inp.value); else drawTape(ctx.result); };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    inp.addEventListener('blur', () => finish(true));
    host.replaceChildren(inp);
    inp.focus(); inp.select();
  }

  // hovering a check or length field lights the bytes it covers
  function cover(label, fr, on) {
    const bin = tape.querySelectorAll('.mb-cell[data-i]');
    const n = fr.mode === 'ascii' ? asciiBinary(fr).length : fr.bytes.length;
    let from = 0, to = n;
    if (label === 'CRC') to = n - 2;
    else if (label === 'LRC') { from = 1; to = n - 3; }
    else if (label === 'Length') from = 6;
    for (const c of bin) { const i = Number(c.dataset.i); c.classList.toggle('is-covered', on && i >= from && i < to); }
  }

  // ------------------------------------------------------------ the line
  function pick(i) { st.sel = st.sel === i ? null : i; drawWire(ctx.result); markSelected(); }
  function markSelected() {
    for (const c of tape.querySelectorAll('.mb-cell[data-i]')) c.classList.toggle('is-sel', Number(c.dataset.i) === st.sel && ctx.result?.frame?.mode !== 'ascii');
  }
  wire.addEventListener('keydown', (e) => {
    const fr = F(); if (!fr) return;
    const n = fr.bytes.length;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const cur = st.sel ?? -1;
      st.sel = Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      drawWire(ctx.result); markSelected();
    } else if (e.key === 'Escape') { st.sel = null; drawWire(ctx.result); markSelected(); }
  });

  function drawWire(res) {
    const fr = res?.frame;
    if (!fr) return;
    const vals = Object.fromEntries((res.values || []).map((v) => [v.label, v]));
    const W = Math.max(280, (wire.clientWidth || 724) - 24);
    const serial = fr.charTime != null;
    const n = fr.bytes.length, m = fr.respBytes;
    // field of each wire byte, for colour
    const roleOf = [];
    if (fr.mode === 'ascii') {
      let k = 0;
      for (const f of fr.fields) { const w = f.label === 'Start' ? 1 : f.label === 'End' ? 2 : f.n * 2; for (let j = 0; j < w; j++) roleOf[k++] = ROLE[f.label]; }
    } else for (const f of fr.fields) for (let j = 0; j < f.n; j++) roleOf.push(ROLE[f.label]);

    const H = 118, y0 = 34, bh = 30;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'mb-wsvg', role: 'img',
      'aria-label': serial ? `Request ${vals['Request on the wire']?.value} on the line, reply ${vals['Response on the wire']?.value}` : 'Request and reply sizes over TCP' });
    const L = 8, R = 8, gapPx = Math.min(90, W * 0.1);
    if (serial) {
      const gaps = fr.t35 != null;
      const total = (gaps ? fr.t35 * 2 : 0) + fr.reqTime + fr.respTime;
      const k = (W - L - R - gapPx) / total;
      let x = L;
      const silence = (label) => {
        const w = fr.t35 * k;
        svg.append(sv('rect', { x, y: y0, width: w, height: bh, class: 'mb-silence' }));
        if (w > 36) svg.append(sv('text', { x: x + w / 2, y: y0 + bh / 2 + 4, class: 'mb-wlab', 'text-anchor': 'middle' }, 't3.5'));
        svg.append(sv('text', { x: x + w / 2, y: y0 + bh + 14, class: 'mb-wsub', 'text-anchor': 'middle' }, label));
        x += w;
      };
      if (gaps) silence(vals['t3.5 frame gap']?.value || ms(fr.t35));
      const reqX = x;
      for (let i = 0; i < n; i++) {
        const w = fr.charTime * k;
        const g = sv('g', { class: `mb-ch mb-r-${roleOf[i] || 'env'}${st.sel === i ? ' is-sel' : ''}`, 'data-i': i });
        g.append(sv('rect', { x: x + 0.5, y: y0, width: Math.max(1, w - 1), height: bh, rx: 2, class: 'mb-chr' }));
        if (w > 17) g.append(sv('text', { x: x + w / 2, y: y0 + bh / 2 + 4, class: 'mb-chx', 'text-anchor': 'middle' }, h2(fr.bytes[i])));
        g.append(sv('title', {}, `byte ${i}: 0x${h2(fr.bytes[i])}`));
        g.addEventListener('click', () => { st.sel = st.sel === i ? null : i; drawWire(ctx.result); markSelected(); });
        svg.append(g);
        x += w;
      }
      svg.append(sv('path', { d: `M${reqX} ${y0 - 6} V${y0 - 12} H${x} V${y0 - 6}`, class: 'mb-span' }));
      svg.append(sv('text', { x: (reqX + x) / 2, y: y0 - 16, class: 'mb-wlab', 'text-anchor': 'middle' }, `request ${n} chars · ${vals['Request on the wire']?.value}`));
      // turnaround: not to scale
      const gx = x;
      svg.append(sv('path', { d: `M${gx + 6} ${y0 + bh / 2} H${gx + gapPx - 6}`, class: 'mb-turn' }));
      svg.append(sv('path', { d: `M${gx + gapPx / 2 - 5} ${y0 + 4} l6 ${bh / 2 - 4} -6 ${bh / 2 - 4} M${gx + gapPx / 2 + 1} ${y0 + 4} l6 ${bh / 2 - 4} -6 ${bh / 2 - 4}`, class: 'mb-break' }));
      svg.append(sv('text', { x: gx + gapPx / 2, y: y0 + bh + 14, class: 'mb-wsub', 'text-anchor': 'middle' }, 'device answers'));
      x += gapPx;
      const rx0 = x;
      for (let i = 0; i < m; i++) { const w = fr.charTime * k; svg.append(sv('rect', { x: x + 0.5, y: y0, width: Math.max(1, w - 1), height: bh, rx: 2, class: 'mb-reply' })); x += w; }
      svg.append(sv('path', { d: `M${rx0} ${y0 - 6} V${y0 - 12} H${x} V${y0 - 6}`, class: 'mb-span' }));
      svg.append(sv('text', { x: (rx0 + x) / 2, y: y0 - 16, class: 'mb-wlab', 'text-anchor': 'middle' }, `reply ${m} · ${vals['Response on the wire']?.value}`));
      if (gaps) silence(vals['t3.5 frame gap']?.value || ms(fr.t35));
      // time axis under the request
      const axY = y0 + bh + 28;
      svg.append(sv('line', { x1: L, x2: W - R, y1: axY, y2: axY, class: 'mb-axis' }));
      const tMax = (reqX - L) / k + fr.reqTime;
      const stepT = [1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1].find((s) => (s * k) > 60) || 0.1;
      for (let t = 0; t <= tMax + 1e-12; t += stepT) {
        const xx = L + t * k;
        svg.append(sv('line', { x1: xx, x2: xx, y1: axY, y2: axY + 4, class: 'mb-axis' }));
        svg.append(sv('text', { x: xx, y: axY + 15, class: 'mb-tick', 'text-anchor': t === 0 ? 'start' : 'middle' }, t === 0 ? '0' : ms(t).replace('.00', '')));
      }
      wireHead.replaceChildren(h('span', { class: 'mb-h' }, 'On the line'),
        h('span', { class: 'mb-soft' }, `${fr.baud} baud · ${fr.bitsPerChar} bits a character = ${ms(fr.charTime)} · ${gaps ? `longest gap inside a frame t1.5 = ${vals['t1.5 char gap']?.value ?? ms(fr.t15)}` : "frame starts at ':' and ends at CR LF, no t3.5 silences"}`));
    } else {
      // TCP: bytes to scale, no timing
      const k = (W - L - R - gapPx) / (n + m);
      let x = L;
      for (let i = 0; i < n; i++) {
        const g = sv('g', { class: `mb-ch mb-r-${roleOf[i] || 'env'}${st.sel === i ? ' is-sel' : ''}` });
        g.append(sv('rect', { x: x + 0.5, y: y0, width: Math.max(1, k - 1), height: bh, rx: 2, class: 'mb-chr' }));
        if (k > 17) g.append(sv('text', { x: x + k / 2, y: y0 + bh / 2 + 4, class: 'mb-chx', 'text-anchor': 'middle' }, h2(fr.bytes[i])));
        g.addEventListener('click', () => { st.sel = st.sel === i ? null : i; drawWire(ctx.result); markSelected(); });
        svg.append(g);
        x += k;
      }
      svg.append(sv('path', { d: `M${L} ${y0 - 6} V${y0 - 12} H${L + 7 * k} V${y0 - 6}`, class: 'mb-span' }));
      svg.append(sv('text', { x: L + 3.5 * k, y: y0 - 16, class: 'mb-wlab', 'text-anchor': 'middle' }, 'MBAP 7'));
      svg.append(sv('path', { d: `M${L + 7 * k} ${y0 - 6} V${y0 - 12} H${x} V${y0 - 6}`, class: 'mb-span' }));
      svg.append(sv('text', { x: (L + 7 * k + x) / 2, y: y0 - 16, class: 'mb-wlab', 'text-anchor': 'middle' }, `PDU ${n - 7}`));
      svg.append(sv('text', { x: x + gapPx / 2, y: y0 + bh / 2 + 4, class: 'mb-wsub', 'text-anchor': 'middle' }, '→ ←'));
      const rx0 = x + gapPx;
      for (let i = 0; i < m; i++) svg.append(sv('rect', { x: rx0 + i * k + 0.5, y: y0, width: Math.max(1, k - 1), height: bh, rx: 2, class: 'mb-reply' }));
      svg.append(sv('text', { x: rx0 + (m * k) / 2, y: y0 - 16, class: 'mb-wlab', 'text-anchor': 'middle' }, `reply ${m} bytes`));
      svg.append(sv('text', { x: L, y: y0 + bh + 20, class: 'mb-wsub' }, 'Bytes to scale. TCP carries no silences: the MBAP length field tells the receiver where the frame ends.'));
      wireHead.replaceChildren(h('span', { class: 'mb-h' }, 'In the TCP segment'), h('span', { class: 'mb-soft' }, `${n} bytes out, ${m} back · ${vals['Expected response']?.hint ?? ''}`));
    }
    wire.replaceChildren(svg);
    drawUart(fr);
  }

  // one character as the UART sends it: start, 8 data bits LSB first, even parity, stop
  function drawUart(fr) {
    if (fr.charTime == null) { uart.replaceChildren(); return; }
    const i = st.sel ?? 1;
    if (i >= fr.bytes.length) { uart.replaceChildren(); return; }
    const b = fr.bytes[i];
    const nd = fr.dataBits || 8;          // RTU 8E1, ASCII 7E1 (Serial Line V1.02 §2.5.1.1, §2.5.2.1)
    const bits = [0];
    for (let k = 0; k < nd; k++) bits.push((b >> k) & 1);
    const par = bits.slice(1).reduce((a, x) => a ^ x, 0);
    bits.push(par, 1);
    const nb = bits.length;
    const W = Math.max(280, (uart.clientWidth || 724) - 24), H = 96;
    const L = W < 520 ? 26 : 46, R = L, bw = (W - L - R) / nb, yHi = 26, yLo = 58;
    const dn = [...Array(nd).keys()];
    const names = bw < 44 ? ['S', ...dn.map(String), 'P', 'E'] : ['start', ...dn.map((k) => `b${k}`), 'parity', 'stop'];
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'mb-usvg', role: 'img',
      'aria-label': `Character ${i}, 0x${h2(b)}, as bits on the line` });
    let d = `M0 ${yHi} H${L}`;
    let lvl = 1;
    bits.forEach((v, k) => {
      const x = L + k * bw;
      if (v !== lvl) d += ` V${v ? yHi : yLo}`;
      d += ` H${x + bw}`;
      lvl = v;
      const cls = k === 0 ? 'mb-ub-start' : k === nb - 2 ? 'mb-ub-par' : k === nb - 1 ? 'mb-ub-stop' : 'mb-ub-data';
      svg.append(sv('rect', { x, y: yHi - 6, width: bw, height: yLo - yHi + 12, class: `mb-ubox ${cls}` }));
      svg.append(sv('text', { x: x + bw / 2, y: 14, class: 'mb-ulab', 'text-anchor': 'middle' }, names[k]));
      svg.append(sv('text', { x: x + bw / 2, y: yLo + 22, class: 'mb-ubit', 'text-anchor': 'middle' }, v));
    });
    d += ` V${yHi} H${W}`;
    svg.append(sv('path', { d, class: 'mb-uwave' }));
    svg.append(sv('text', { x: 4, y: yHi - 4, class: 'mb-ulab' }, 'idle'));
    svg.append(sv('text', { x: W - 4, y: yHi - 4, class: 'mb-ulab', 'text-anchor': 'end' }, 'idle'));
    uart.replaceChildren(h('div', { class: 'mb-uhead' },
      h('span', { class: 'mb-h' }, `Character ${i}: 0x${h2(b)}`),
      h('span', { class: 'mb-soft' }, `${b.toString(2).padStart(nd, '0')} sent LSB first · ${nd === 7 ? `7E1: ASCII mode sends 7 data bits, '${String.fromCharCode(b).replace('\r', 'CR').replace('\n', 'LF')}'` : '8E1, the RTU default'} (no parity: a second stop bit) · bit time ${ms(fr.charTime / fr.bitsPerChar)}`),
      st.sel == null ? h('span', { class: 'mb-soft' }, '· click a character on the line or a byte on the tape') : null), svg);
  }

  // ------------------------------------------------------------ the device's address table
  function drawRuler(res) {
    const fr = res?.frame;
    if (!fr) return;
    const W = Math.max(280, (ruler.clientWidth || 724) - 24);
    const plc = raw().addrStyle === 'plc';
    const cellW = W < 520 ? 22 : 30;
    const nCells = Math.max(8, Math.floor((W - 20) / cellW));
    const a = fr.address, q = fr.count;
    let from = Math.max(0, Math.min(65536 - nCells, a - Math.max(2, Math.floor((nCells - Math.min(q, nCells - 4)) / 2))));
    if (a + q > from + nCells) from = Math.max(0, a - 2);
    const L = (W - nCells * cellW) / 2, y = 22, ch = 34, H = 86;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'mb-rsvg' });
    const X = (addr) => L + (addr - from) * cellW;
    const every = cellW < 26 ? 4 : 2;
    for (let k = 0; k < nCells; k++) {
      const addr = from + k;
      const inR = addr >= a && addr < a + q;
      svg.append(sv('rect', { x: X(addr) + 1, y, width: cellW - 2, height: ch, rx: 2, class: `mb-rc${inR ? ' is-in' : ''}` }));
      if (k % every === 0 || addr === a) {
        svg.append(sv('text', { x: X(addr) + cellW / 2, y: y + ch + 13, class: 'mb-tick', 'text-anchor': 'middle' }, String(addr)));
        if (plc) svg.append(sv('text', { x: X(addr) + cellW / 2, y: y + ch + 25, class: 'mb-tick mb-plc', 'text-anchor': 'middle' }, String(addr + fr.ref)));
      }
    }
    // the requested range, draggable; its right edge sets the count
    const x1 = X(Math.max(from, a)), x2 = X(Math.min(from + nCells, a + q));
    const g = sv('g', { class: 'mb-range', tabindex: 0, role: 'slider', 'aria-label': `Requested ${fr.table}s ${a} to ${a + q - 1}. Left and right move it; Shift with them changes how many.`,
      'aria-valuenow': a });
    g.append(sv('rect', { x: x1, y: y - 5, width: Math.max(4, x2 - x1), height: ch + 10, rx: 4, class: 'mb-rbox' }));
    g.append(sv('text', { x: x1 + 4, y: y - 9, class: 'mb-rlab' }, `${q} ${fr.table}${q > 1 ? 's' : ''} from ${plc ? a + fr.ref : a}`));
    const grip = sv('rect', { x: x2 - 5, y: y + 4, width: 8, height: ch - 8, rx: 2, class: 'mb-rgrip' });
    const canSize = fr.fc <= 4 || fr.fc === 15 || fr.fc === 16;
    if (canSize) g.append(grip);
    svg.append(g);
    if (a + q > from + nCells) svg.append(sv('text', { x: W - 4, y: y + ch / 2 + 4, class: 'mb-rlab', 'text-anchor': 'end' }, `… to ${a + q - 1}`));

    const toAddr = (clientX) => { const r = svg.getBoundingClientRect(); return from + Math.round(((clientX - r.left) * (W / r.width) - L) / cellW); };
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const sizing = canSize && e.target === grip;
      const startAddr = toAddr(e.clientX), a0 = a, q0 = q;
      let last = null;
      const move = (ev) => {
        const d = toAddr(ev.clientX) - startAddr;
        const key = sizing ? Math.max(1, q0 + d) : Math.max(0, a0 + d);
        if (key === last) return; last = key;
        st.focus = null;
        if (sizing) setCount(key); else setAddress(key);
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); ruler.querySelector('.mb-range')?.focus({ preventScroll: true }); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    g.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      st.rulerFocus = true;
      if (e.shiftKey && canSize) setCount(q + d); else setAddress(a + d);
    });
    ruler.replaceChildren(svg);
    if (st.rulerFocus) { st.rulerFocus = false; ruler.querySelector('.mb-range')?.focus({ preventScroll: true }); }
    tblHead.replaceChildren(h('span', { class: 'mb-h' }, `The device's ${fr.table}s`),
      h('span', { class: 'mb-soft' }, `${plc ? 'PDU address above, PLC reference below' : 'PDU addresses, as sent'} · drag the range to move it${canSize ? ', its right edge to size it' : ''}`));
  }

  // ------------------------------------------------------------ result in
  ctx.onResult((res) => {
    drawBand(res.frame);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    if (res.frame && st.sel != null && st.sel >= res.frame.bytes.length) st.sel = null;
    drawTape(res);
    drawWire(res);
    drawRuler(res);
    if (res.frame) st.prev = { bin: res.frame.mode === 'ascii' ? asciiBinary(res.frame) : res.frame.bytes, mode: res.frame.mode };
    wirePanel.classList.toggle('is-stale', !res.frame);
    tblPanel.classList.toggle('is-stale', !res.frame);
  });

  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (ctx.result?.frame) { drawWire(ctx.result); drawRuler(ctx.result); } }); }).observe(wirePanel);
}
