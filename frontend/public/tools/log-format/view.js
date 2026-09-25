// Log Format Designer, drawn as the thing itself: the record on the wire.
//   Record    - the picked message byte by byte as it leaves the UART, each
//               byte with its example value, the fields bracketed above and
//               the header byte exploded into its level and id bits. Click a
//               field to change it (framing, level bits, timestamp, CRC; the
//               dashed "+" cells add one), click an argument to pick its
//               type, drag its right edge to widen it (u8 -> u16 -> u32 ...).
//   Messages  - every message as a ribbon of its bytes, with the same text
//               printed by printf as a line underneath to the same scale;
//               drag the rate chip sideways to change how often it is logged.
//   Link      - the UART as a pipe: binary records stacked against its
//               capacity, the printf text beside them; pick the baud rate.
// All sizes, bytes, rates and loads come from run()'s result.layout.

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const TYPES = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64', 'bool'];
const FAMILY = { u: ['u8', 'u16', 'u32', 'u64'], i: ['i8', 'i16', 'i32', 'i64'], f: ['f32', 'f64'], b: ['bool'] };
const SIZE = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, f32: 4, f64: 8, bool: 1 };
const famOf = (t) => (t === 'bool' ? 'b' : t[0]);
const typeColor = (t) => (t === 'bool' ? 'var(--tool-bool)' : t[0] === 'f' ? 'var(--tool-float)' : 'var(--tool-int)');
const KIND_COLOR = { cobs: 'var(--tool-frame)', sync: 'var(--tool-frame)', len: 'var(--tool-frame)', delim: 'var(--tool-frame)', hdr: 'var(--tool-hdr)', ts: 'var(--tool-ts)', crc: 'var(--tool-crc)' };
const fieldColor = (fl) => (fl.kind === 'arg' ? typeColor(fl.type) : KIND_COLOR[fl.kind]);
const mcol = (i) => `var(--tool-m${i % 8})`;
const hx = (b) => b.toString(16).toUpperCase().padStart(2, '0');

const CYCLE = {
  framing: ['cobs', 'sync', 'none'],
  levels: ['l4', 'l8', 'none'],
  ts: ['u32ms', 'u32us', 'u16ms', 'none'],
  check: ['crc8', 'crc16', 'none'],
};
const NAMES = {
  framing: { cobs: 'COBS, 0x00 delimited', sync: 'sync byte + length', none: 'no framing' },
  levels: { l4: '4 levels (2 bits)', l8: '8 levels (3 bits)', none: 'no level' },
  ts: { u32ms: '32-bit ms', u32us: '32-bit µs', u16ms: '16-bit ms', none: 'no timestamp' },
  check: { crc8: 'CRC-8', crc16: 'CRC-16', none: 'no checksum' },
};
const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000];

export function page(root, ctx) {
  const f = ctx.fmtNum;
  const wrap = h('div', { class: 'lfd' });
  root.append(wrap);

  // ---------- record (hero) ----------
  const recTitle = h('h2', {});
  const recSub = h('span', { class: 'lfd-sub' });
  const recSvg = s('svg', { class: 'lfd-svg', role: 'group', 'aria-label': 'Record bytes' });
  const nameIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Message name', oninput: (e) => setMsg({ name: e.target.value }) });
  const textIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Message text', oninput: (e) => setMsg({ text: e.target.value }) });
  const rateIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Rate per second', oninput: (e) => setMsg({ rate: e.target.value }) });
  const edit = h('div', { class: 'lfd-edit' },
    h('label', {}, 'Name', nameIn), h('label', { class: 'txt' }, 'Text, {} per argument', textIn), h('label', {}, 'Rate /s', rateIn));
  const types = h('div', { class: 'lfd-types' });
  const decoded = h('div', { class: 'lfd-decoded' });
  const delBtn = h('button', { class: 'k-btn', style: 'color:var(--danger)', onclick: () => {
    const rows = (ctx.raw.messages || []).map((r) => ({ ...r }));
    if (rows.length <= 1 || !rows[sel]) return;
    rows.splice(sel, 1); sel = Math.max(0, sel - 1); argSel = null; ctx.set('messages', rows);
  } }, 'Remove message');
  const hero = h('section', { class: 'lfd-card' },
    h('div', { class: 'lfd-head' }, recTitle, recSub, h('span', { class: 'lfd-right' }, delBtn)),
    recSvg, types, edit, decoded,
    h('div', { class: 'lfd-help' }, 'Click a field to change it (framing, header level bits, timestamp, CRC); dashed ', h('b', {}, '+'), ' cells add one. Click an argument to pick its type, drag its right edge to widen it; focused: ',
      h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' width, ', h('kbd', {}, 'Del'), ' remove.'));

  // ---------- messages + link ----------
  const listSvg = s('svg', { class: 'lfd-svg', role: 'group', 'aria-label': 'All messages' });
  const listSub = h('span', { class: 'lfd-sub' });
  const addBtn = h('button', { class: 'k-btn', onclick: () => {
    const rows = (ctx.raw.messages || []).map((r) => ({ ...r }));
    rows.push({ name: `msg${rows.length}`, text: 'value {}', args: 'u16', rate: '1' });
    sel = rows.length - 1; argSel = null;
    ctx.set('messages', rows);
  } }, '+ Message');
  const list = h('section', { class: 'lfd-card' }, h('div', { class: 'lfd-head' }, h('h2', {}, 'Messages'), listSub, h('span', { class: 'lfd-right' }, addBtn)), listSvg,
    h('div', { class: 'lfd-help' }, 'Coloured cells: the binary record. Grey line: the same message as printf text, to the same scale. Drag a rate chip sideways (', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' when focused).'));
  const linkSvg = s('svg', { class: 'lfd-svg', role: 'img', 'aria-label': 'UART load' });
  const baudIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', oninput: (e) => ctx.set('baud', e.target.value) });
  const bauds = h('div', { class: 'lfd-bauds' });
  const link = h('section', { class: 'lfd-card lfd-link' }, h('div', { class: 'lfd-head' }, h('h2', {}, 'UART link')), linkSvg, bauds);

  const warns = h('div', { class: 'lfd-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'lfd-notes', open: true }, h('summary', {}, 'Record layout notes'));
  wrap.append(hero, h('div', { class: 'lfd-mid' }, list, link), h('div', { class: 'lfd-low' }, h('div', { class: 'lfd-col' }, warns, notes), ctx.outputs));

  let res = null, sel = 0, argSel = null, dragging = false, focusId = null, frozen = null;
  const LY = () => res && res.layout;
  let firstPick = true;
  const cur = () => {
    const l = LY();
    if (!l) return null;
    if (firstPick && l.messages.length) {
      // start on the message that loads the link most
      firstPick = false;
      sel = [...l.messages].sort((a, b) => b.binBps - a.binBps)[0].row;
    }
    return l.messages.find((m) => m.row === sel) || l.messages[0];
  };

  const setMsg = (patch, row = sel) => {
    const rows = (ctx.raw.messages || []).map((r) => ({ ...r }));
    if (!rows[row]) return;
    Object.assign(rows[row], patch);
    ctx.set('messages', rows);
  };
  const argsOf = (row = sel) => String(ctx.raw.messages?.[row]?.args || '').split(/[\s,;]+/).filter(Boolean);
  const setArg = (i, t) => { const a = argsOf(); a[i] = t; setMsg({ args: a.join(' ') }); };
  const addArg = () => {
    const a = argsOf(); a.push('u8');
    const txt = String(ctx.raw.messages[sel].text || '');
    argSel = a.length - 1;
    setMsg({ args: a.join(' '), text: `${txt}${txt.endsWith(' ') || !txt ? '' : ' '}{}` });
  };
  const removeArg = (i) => {
    const a = argsOf(); a.splice(i, 1);
    let k = -1;
    const txt = String(ctx.raw.messages[sel].text || '').replace(/ ?\{[^}]*\}/g, (m) => (++k === i ? '' : m));
    argSel = null;
    setMsg({ args: a.join(' '), text: txt });
  };
  const cycle = (key) => { const o = CYCLE[key]; const v = ctx.raw[key]; ctx.set(key, o[(o.indexOf(v) + 1) % o.length]); };

  const drag = (move, done) => {
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragging = false;
      done && done(ev);
    };
    dragging = true;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const track = (el, id) => {
    el.setAttribute('data-id', id);
    const mark = () => { focusId = id; };
    el.addEventListener('focus', mark);
    el.addEventListener('keydown', mark, true);
    el.addEventListener('pointerdown', mark, true);
  };
  const refocus = (svg, had) => { if ((had || dragging) && focusId) svg.querySelector(`[data-id="${focusId}"]`)?.focus({ preventScroll: true }); };
  const button = (g, label, act) => {
    g.setAttribute('class', `${g.getAttribute('class') || ''} btn`.trim());
    g.setAttribute('tabindex', 0);
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', label);
    g.addEventListener('click', act);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    g.append(s('title', {}, label));
  };

  // ---------- the record ----------
  function drawRecord() {
    const had = recSvg.contains(document.activeElement);
    recSvg.replaceChildren();
    try { drawRecordInner(); } finally { refocus(recSvg, had); }
  }
  function drawRecordInner() {
    const L = LY();
    const W = Math.max(300, recSvg.clientWidth || hero.clientWidth || 800);
    const m = cur();
    if (!L || !m) {
      recSvg.setAttribute('viewBox', `0 0 ${W} 50`); recSvg.setAttribute('height', 50);
      recSvg.append(s('text', { x: 12, y: 30, class: 'soft' }, 'Add a message to see its record.'));
      recTitle.textContent = 'Record'; recSub.textContent = '';
      return;
    }
    const narrow = W < 600;
    // cells: the real bytes plus dashed "+" cells for what is switched off
    const cells = [];
    const ghost = (key, label, at) => cells.push({ ghost: true, key, label, at });
    let bi = 0;
    const put = (fl) => { for (let k = 0; k < fl.bytes; k++) cells.push({ fl, k, b: m.bytes[bi], orig: rawByte(m, L, bi), idx: bi++ }); };
    const F = (kind) => m.fields.filter((q) => q.kind === kind);
    if (L.framing === 'none') ghost('framing', '+ frame');
    for (const fl of [...F('cobs'), ...F('sync'), ...F('len'), ...F('hdr')]) put(fl);
    if (!L.tsSize) ghost('ts', '+ time'); else F('ts').forEach(put);
    F('arg').forEach(put);
    ghost('arg', '+ arg');
    if (!L.crcBytes) ghost('check', '+ CRC'); else F('crc').forEach(put);
    F('delim').forEach(put);
    const gw = 0.9;
    const units = cells.reduce((a, c) => a + (c.ghost ? gw : 1), 0);
    const pad = 12;
    const cw = Math.max(narrow ? 17 : 26, Math.min(74, (W - 2 * pad) / units));
    const total = units * cw;
    const x0 = Math.max(pad, (W - total) / 2);
    const yT = 32, yC = 46, ch = narrow ? 36 : 54;
    const hexCls = cw >= 30 ? 'hex' : cw >= 22 ? '' : 'small';

    // positions
    let x = x0;
    for (const c of cells) { c.x = x; c.w = (c.ghost ? gw : 1) * cw; x += c.w; }
    const fx = new Map();   // field -> [x0, x1]
    for (const c of cells) if (!c.ghost) { const r = fx.get(c.fl) || [c.x, c.x + c.w]; r[1] = c.x + c.w; fx.set(c.fl, r); }

    const hdr = m.fields.find((q) => q.kind === 'hdr');
    const bitsH = 78;
    const H = yC + ch + 22 + bitsH + 10;
    recSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    recSvg.setAttribute('height', H);

    // field brackets and names above
    for (const [fl, [a, b]] of fx) {
      const c = fieldColor(fl);
      recSvg.append(s('path', { d: `M${a + 2},${yT + 8}v-5h${b - a - 4}v5`, fill: 'none', stroke: c, 'stroke-width': 1.4 }));
      let lab = fl.kind === 'arg' ? `${fl.type}` : fl.label;
      if (fl.kind === 'ts' && b - a > 90) lab = `${L.tsType} ${L.tsUnit}`;
      if (fl.kind === 'cobs' && b - a < 44) lab = 'code';
      if (fl.kind === 'delim') lab = cw > 30 ? 'end' : '';
      if (lab.length * 6.4 > b - a + 6) lab = cw > 20 ? lab.slice(0, Math.max(1, Math.floor((b - a) / 6.6))) : '';
      recSvg.append(s('text', { x: (a + b) / 2, y: yT - 1, 'text-anchor': 'middle', class: 'small', style: `fill:${c}` }, lab));
    }

    // byte cells
    const groups = new Map();
    for (const c of cells) {
      if (c.ghost) {
        const g = s('g', { 'data-ghost': c.key });
        track(g, `ghost-${c.key}`);
        g.append(s('rect', { class: 'ring', x: c.x + 2, y: yC + 4, width: c.w - 4, height: ch - 8, rx: 4, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-dasharray': '3 3' }));
        g.append(s('text', { x: c.x + c.w / 2, y: yC + ch / 2 + 4, 'text-anchor': 'middle', class: 'small soft' }, cw >= 34 ? c.label : '+'));
        const act = c.key === 'arg' ? addArg : c.key === 'framing' ? () => ctx.set('framing', 'cobs') : c.key === 'ts' ? () => ctx.set('ts', 'u32ms') : () => ctx.set('check', 'crc8');
        button(g, c.key === 'arg' ? 'Add an argument (u8)' : c.key === 'framing' ? 'Add COBS framing' : c.key === 'ts' ? 'Add a 32-bit ms timestamp' : 'Add a CRC-8', act);
        recSvg.append(g);
        continue;
      }
      const fl = c.fl, col = fieldColor(fl);
      const key = fl.kind === 'arg' ? `arg-${fl.i}` : fl.kind === 'delim' || fl.kind === 'cobs' || fl.kind === 'sync' || fl.kind === 'len' ? 'frame' : fl.kind;
      let g = groups.get(key);
      if (!g) {
        g = s('g', {});
        groups.set(key, g);
        const [a, b] = fx.get(fl);
        const isSel = fl.kind === 'arg' && fl.i === argSel;
        const cfgKey = { frame: 'framing', hdr: 'levels', ts: 'ts', crc: 'check' }[key];
        track(g, `f-${key}`);
        if (fl.kind === 'arg') {
          button(g, `Argument ${fl.i + 1}: ${fl.type}. Click to pick the type`, () => { argSel = argSel === fl.i ? null : fl.i; drawRecord(); drawTypes(); });
          g.addEventListener('keydown', (e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); focusId = null; removeArg(fl.i); }
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); stepWidth(fl.i, fl.type, e.key === 'ArrowRight' ? 1 : -1); }
          });
        } else if (cfgKey) {
          const next = CYCLE[cfgKey][(CYCLE[cfgKey].indexOf(ctx.raw[cfgKey]) + 1) % CYCLE[cfgKey].length];
          button(g, `${cfgKey === 'levels' ? 'Header' : fl.label}: ${NAMES[cfgKey][ctx.raw[cfgKey]]}. Click for ${NAMES[cfgKey][next]}`, () => cycle(cfgKey));
        }
        g.append(s('rect', { class: 'ring', x: a + 1, y: yC, width: b - a - 2, height: ch, rx: 4, fill: 'none', stroke: isSel ? 'var(--accent)' : col, 'stroke-width': isSel ? 2.4 : 1.2 }));
        recSvg.append(g);
      }
      g.append(s('rect', { x: c.x + 2, y: yC + 3, width: c.w - 4, height: ch - 6, rx: 3, fill: col, 'fill-opacity': 0.2 }));
      const replaced = L.framing === 'cobs' && c.orig === 0 && fl.kind !== 'cobs' && fl.kind !== 'delim';
      g.append(s('text', { x: c.x + c.w / 2, y: yC + ch / 2 + (hexCls === 'hex' ? 5 : 4), 'text-anchor': 'middle', class: hexCls || null, style: replaced ? 'fill:var(--ink-soft)' : null }, hx(c.b)));
      if (replaced && cw >= 26) g.append(s('text', { x: c.x + c.w / 2, y: yC + ch - 5, 'text-anchor': 'middle', class: 'small soft' }, 'was 00'));
      if (cw >= 24 && (c.idx % 4 === 0 || cw >= 40)) recSvg.append(s('text', { x: c.x + c.w / 2, y: yC + ch + 12, 'text-anchor': 'middle', class: 'small soft' }, String(c.idx)));
    }

    // width handles on the arguments
    for (const fl of m.fields.filter((q) => q.kind === 'arg')) {
      const [a, b] = fx.get(fl);
      const fam = FAMILY[famOf(fl.type)];
      if (fam.length < 2) continue;
      const hg = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': `Width of argument ${fl.i + 1}`, 'aria-valuenow': fl.bytes, 'aria-valuetext': `${fl.type}, ${fl.bytes} bytes` });
      track(hg, `w-${fl.i}`);
      hg.append(s('rect', { class: 'ring', x: b - 4, y: yC + ch / 2 - 9, width: 7, height: 18, rx: 2, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 1.2 }));
      hg.append(s('rect', { x: b - 9, y: yC, width: 16, height: ch, fill: 'transparent' }));
      hg.append(s('title', {}, `Drag: ${fam.join(' / ')}`));
      hg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        hg.focus({ preventScroll: true });
        const r = recSvg.getBoundingClientRect(), k = W / r.width;
        drag((ev) => {
          const px = (ev.clientX - r.left) * k;
          const want = Math.max(1, (px - a) / cw);
          const t = fam.reduce((best, q) => (Math.abs(Math.log2(SIZE[q] / want)) < Math.abs(Math.log2(SIZE[best] / want)) ? q : best), fam[0]);
          if (t !== argsOf()[fl.i]) setArg(fl.i, t);
        });
      });
      hg.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); stepWidth(fl.i, fl.type, 1); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); stepWidth(fl.i, fl.type, -1); }
      });
      recSvg.append(hg);
    }

    // the header exploded into bits
    if (hdr) {
      const [a, b] = fx.get(hdr);
      const nb = L.hdrBytes * 8;
      const bw = Math.max(narrow ? 13 : 18, Math.min(28, (W - 2 * pad) / (nb + 2)));
      const bx0 = Math.max(pad, Math.min(W - pad - nb * bw, (a + b) / 2 - (nb * bw) / 2));
      const by = yC + ch + 30;
      recSvg.append(s('path', { d: `M${a + 2},${yC + ch}L${bx0},${by - 4}M${b - 2},${yC + ch}L${bx0 + nb * bw},${by - 4}`, stroke: 'var(--tool-hdr)', 'stroke-opacity': 0.5, fill: 'none' }));
      const g = s('g', {});
      track(g, 'bits');
      button(g, `Level bits: ${NAMES.levels[ctx.raw.levels]}. Click to change`, () => cycle('levels'));
      const used = L.idBits + L.levelBits;
      for (let i = 0; i < nb; i++) {
        const bit = nb - 1 - i;                 // MSB on the left
        const isId = bit < L.idBits, isLvl = !isId && bit < used;
        const v = (m.header >> bit) & 1;
        const c = isId ? 'var(--tool-hdr)' : isLvl ? 'var(--tool-ts)' : 'var(--line)';
        g.append(s('rect', { x: bx0 + i * bw + 1, y: by, width: bw - 2, height: 20, rx: 2, fill: c, 'fill-opacity': isId || isLvl ? 0.22 : 0.4, stroke: c }));
        g.append(s('text', { x: bx0 + i * bw + bw / 2, y: by + 14, 'text-anchor': 'middle', class: isId || isLvl ? null : 'soft' }, isId || isLvl ? String(v) : '·'));
      }
      g.append(s('rect', { class: 'ring', x: bx0 - 2, y: by - 2, width: nb * bw + 4, height: 24, rx: 3, fill: 'none', stroke: 'transparent' }));
      recSvg.append(g);
      const cap = (bits0, bits1, text, c, row = 0) => {
        if (bits1 <= bits0) return;
        const xa = bx0 + (nb - bits1) * bw, xb = bx0 + (nb - bits0) * bw;
        recSvg.append(s('path', { d: `M${xa + 1},${by + 24}v4h${xb - xa - 2}v-4`, fill: 'none', stroke: c }));
        const room = xb - xa;
        const t = text.length * 6 < room + 40 || narrow ? text : text;
        recSvg.append(s('text', { x: (xa + xb) / 2, y: by + 40 + row * 13, 'text-anchor': 'middle', class: 'small', style: `fill:${c}` }, t));
      };
      cap(0, L.idBits, narrow ? `id ${m.id}` : `id ${m.id} (${L.idBits} bit${L.idBits > 1 ? 's' : ''})`, 'var(--tool-hdr)');
      if (L.levelBits) cap(L.idBits, used, narrow ? L.exampleLevel : `level ${L.exampleLevel} (${L.levelBits} bits)`, 'var(--tool-ts)', 1);
      else recSvg.append(s('text', { x: bx0 + nb * bw + 8, y: by + 14, class: 'small soft' }, narrow ? '' : 'no level bits'));
    }

    // the sum, under the bytes on the right
    const parts = [];
    const add = (label, n) => { if (n) parts.push(`${n} ${label}`); };
    const sum = (kind) => m.fields.filter((q) => q.kind === kind).reduce((a, q) => a + q.bytes, 0);
    add('frame', sum('cobs') + sum('sync') + sum('len')); add('header', sum('hdr')); add('time', sum('ts'));
    add(m.args.length === 1 ? 'arg' : 'args', sum('arg')); add('CRC', sum('crc')); add('end', sum('delim'));
    const eq = `${m.wire} B = ${parts.join(' + ')}`;
    if (!narrow) recSvg.append(s('text', { x: x0 + total, y: yC + ch + 44, 'text-anchor': 'end', class: 'soft' }, eq));
    if (!narrow) recSvg.append(s('text', { x: x0 + total, y: yC + ch + 60, 'text-anchor': 'end', class: 'small soft' }, `printf: ${m.txt} B of text for the same line`));
    const saving = m.txt / m.wire;
    recTitle.replaceChildren(h('span', { style: `display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:${mcol(m.id)}` }), `log_${m.name}()`);
    recSub.replaceChildren(h('b', {}, `${m.wire} B`), ' on the wire (', h('b', {}, `${m.payload} B`), ' of arguments) against ', h('b', {}, `${m.txt} B`), ' as printf text: ',
      h('b', { class: 'ok' }, `${f(saving, 3)}× smaller`), ' · id ', h('b', {}, String(m.id)));
  }
  // The byte before COBS stuffing at wire position i (to mark stuffed zeros).
  function rawByte(m, L, i) {
    if (L.framing !== 'cobs') return m.bytes[i];
    const j = i - 1;
    return j >= 0 && j < m.record.length ? m.record[j] : null;
  }
  function stepWidth(i, t, dir) {
    const fam = FAMILY[famOf(t)];
    const k = fam.indexOf(t) + dir;
    if (k >= 0 && k < fam.length) setArg(i, fam[k]);
  }

  function drawTypes() {
    const m = cur();
    types.replaceChildren();
    if (!m || argSel == null || argSel >= m.args.length) { argSel = null; return; }
    const t = m.args[argSel];
    types.append(h('span', {}, `Argument ${argSel + 1}:`),
      ...TYPES.map((q) => h('button', { class: 'k-btn', 'aria-pressed': String(q === t), style: `box-shadow: inset 0 -2px 0 ${typeColor(q)}`, onclick: () => setArg(argSel, q) }, q)),
      h('button', { class: 'k-btn', style: 'color:var(--danger);margin-left:6px', onclick: () => removeArg(argSel) }, 'Remove'));
  }

  function drawEdit() {
    const m = cur();
    const row = ctx.raw.messages?.[m ? m.row : sel] || {};
    for (const [el, k] of [[nameIn, 'name'], [textIn, 'text'], [rateIn, 'rate']]) if (document.activeElement !== el) el.value = row[k] ?? '';
    rateIn.classList.toggle('bad', String(row.rate ?? '').trim() !== '' && !Number.isFinite(Number(row.rate)));
    textIn.classList.toggle('bad', !!m && m.holes !== m.args.length);
    delBtn.disabled = (ctx.raw.messages || []).length <= 1;
    decoded.replaceChildren();
    const L = LY();
    if (!m || !L) return;
    // the host's line for the example record, placeholders in their argument colours
    const parts = [];
    let k = 0, last = 0;
    const re = /\{[^}]*\}/g;
    let mm;
    while ((mm = re.exec(m.text))) {
      parts.push(m.text.slice(last, mm.index));
      const t = m.args[k];
      parts.push(h('span', { class: 'ph', style: t ? `border-color:${typeColor(t)};color:${typeColor(t)}` : 'border-color:var(--danger);color:var(--danger)' }, t ? String(m.exArgs[k]) : '{}'));
      k++; last = mm.index + mm[0].length;
    }
    parts.push(m.text.slice(last));
    const bad = m.holes !== m.args.length;
    decoded.append(...[h('span', { class: 'lab' }, 'Host prints'),
      h('code', {}, L.tsSize ? '[      1000] ' : '', L.levelBits ? `${L.exampleLevel} ` : '', ...parts),
      bad ? h('span', { class: 'lab', style: 'color:var(--danger)' }, `${m.holes} {} for ${m.args.length} argument${m.args.length === 1 ? '' : 's'}`) : null].filter(Boolean));
  }

  // ---------- all messages ----------
  function drawList() {
    const had = listSvg.contains(document.activeElement);
    listSvg.replaceChildren();
    try { drawListInner(); } finally { refocus(listSvg, had); }
  }
  function drawListInner() {
    const L = LY();
    const W = Math.max(300, listSvg.clientWidth || list.clientWidth || 700);
    if (!L) { listSvg.setAttribute('viewBox', `0 0 ${W} 40`); listSvg.setAttribute('height', 40); listSub.textContent = ''; return; }
    const narrow = W < 560;
    const lw = narrow ? 18 : 150, rw = narrow ? 0 : 150, rh = narrow ? 56 : 40, top = 8;
    const oy = narrow ? 20 : 0;   // narrow: the ribbon goes under the name
    const H = top + L.messages.length * rh + 6;
    listSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    listSvg.setAttribute('height', H);
    const x0 = lw, x1 = W - (narrow ? 0 : rw) - 10;
    const maxTxt = Math.max(...L.messages.map((m) => Math.max(m.txt, m.wire)));
    const bw = Math.min(16, (x1 - x0 - 72) / maxTxt);
    L.messages.forEach((m, i) => {
      const y = top + i * rh;
      const isSel = m.row === (cur() || {}).row;
      const g = s('g', {});
      track(g, `row-${m.row}`);
      button(g, `${m.name}: ${m.wire} bytes, ${m.rate} per second`, () => { sel = m.row; argSel = null; drawAll(); });
      g.append(s('rect', { class: 'ring', x: 1, y: y + 1, width: W - 2, height: rh - 2, rx: 4, fill: isSel ? 'var(--accent)' : 'transparent', 'fill-opacity': isSel ? 0.08 : 0, stroke: isSel ? 'var(--accent)' : 'transparent', 'stroke-opacity': 0.5 }));
      g.append(s('rect', { x: 8, y: y + 10, width: 4, height: narrow ? 38 : 20, rx: 1, fill: mcol(m.id) }));
      const nm = m.name.length > (narrow ? 20 : 16) ? m.name.slice(0, narrow ? 19 : 15) + '…' : m.name;
      g.append(s('text', { x: 18, y: y + 17 }, nm));
      if (!narrow) g.append(s('text', { x: 18, y: y + 31, class: 'small soft' }, `id ${m.id} · ${m.args.join(' ') || 'no args'}`.slice(0, 24)));
      // ribbon
      let bx = x0;
      for (const fl of m.fields) {
        const c = fieldColor(fl);
        for (let k = 0; k < fl.bytes; k++) {
          g.append(s('rect', { x: bx + 0.5, y: y + 8 + oy, width: Math.max(0.6, bw - 1), height: 14, rx: bw > 6 ? 1.5 : 0, fill: c, 'fill-opacity': 0.75 }));
          bx += bw;
        }
      }
      g.append(s('text', { x: bx + 5, y: y + 19 + oy, class: 'small' }, `${m.wire} B`));
      // printf text, same scale
      const tx = x0 + m.txt * bw;
      g.append(s('line', { x1: x0, x2: tx, y1: y + 29 + oy, y2: y + 29 + oy, stroke: 'var(--ink-soft)', 'stroke-width': 3, 'stroke-opacity': 0.45 }));
      g.append(s('text', { x: tx + 5, y: y + 32 + oy, class: 'small soft' }, `${m.txt} B text`));
      listSvg.append(g);

      // rate chip (log scrub)
      const rx = narrow ? W - 76 : x1 + 12;
      const chip = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': `Rate of ${m.name}`, 'aria-valuenow': m.rate, 'aria-valuetext': `${m.rate} per second` });
      track(chip, `rate-${m.row}`);
      const rt = `${f(m.rate, 3)}/s`;
      const cw2 = 64;
      chip.append(s('rect', { class: 'ring', x: rx, y: y + (narrow ? 3 : 8), width: cw2, height: 20, rx: 10, fill: 'var(--sunken)', stroke: 'var(--line)' }));
      chip.append(s('text', { x: rx + cw2 / 2, y: y + (narrow ? 17 : 22), 'text-anchor': 'middle' }, rt));
      chip.append(s('title', {}, 'Drag sideways: slower / faster (×10 per 100 px)'));
      const setRate = (v) => {
        const q = v >= 10 ? Math.round(v) : Number(v.toPrecision(2));
        if (String(q) !== String(ctx.raw.messages[m.row]?.rate)) setMsg({ rate: String(q) }, m.row);
      };
      chip.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        chip.focus({ preventScroll: true });
        const x00 = e.clientX, r0 = Math.max(m.rate, 0.001);
        drag((ev) => setRate(Math.min(1e5, Math.max(0.001, r0 * 10 ** ((ev.clientX - x00) / 100)))));
      });
      chip.addEventListener('keydown', (e) => {
        const r0 = Math.max(m.rate, 0.001);
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setRate(r0 * (e.shiftKey ? 10 : 1.25)); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setRate(r0 / (e.shiftKey ? 10 : 1.25)); }
      });
      listSvg.append(chip);
      if (!narrow) listSvg.append(s('text', { x: W - 10, y: y + 22, 'text-anchor': 'end', class: 'small soft' }, `${f(m.binBps, 3)} B/s`));
    });
    listSub.replaceChildren(h('b', {}, `${L.hdrBytes} B`), ' header (', `${L.idBits}-bit id${L.levelBits ? ` + ${L.levelBits}-bit level` : ''}`, ')',
      ...(L.tsSize ? [' · timestamp wraps after ', h('b', {}, wrapText(L.tsWrap))] : []));
  }
  const wrapText = (w) => (w < 120 ? `${f(w, 4)} s` : w < 7200 ? `${f(w / 60, 4)} min` : `${f(w / 86400, 4)} days`);

  // ---------- the link ----------
  function drawLink() {
    const L = LY();
    linkSvg.replaceChildren();
    const W = Math.max(200, linkSvg.clientWidth || 240);
    const H = 250;
    linkSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    linkSvg.setAttribute('height', H);
    if (!L) return;
    const yb = H - 40, yt = 30, hh = yb - yt;
    const bw = Math.min(52, (W - 90) / 2);
    const xa = 44, xb = xa + bw + 18;
    const Y = (u) => yb - Math.min(u, 1.08) * hh / 1.08;
    // scale
    for (const [u, c, t] of [[0.5, 'var(--ink-soft)', '50 %'], [0.7, 'var(--warn)', '70 %'], [1, 'var(--danger)', '100 %']]) {
      linkSvg.append(s('line', { x1: xa - 6, x2: xb + bw + 4, y1: Y(u), y2: Y(u), stroke: c, 'stroke-dasharray': u < 1 ? '3 2' : null }));
      linkSvg.append(s('text', { x: xa - 9, y: Y(u) + 3.5, 'text-anchor': 'end', class: 'small', style: `fill:${c}` }, t));
    }
    linkSvg.append(s('rect', { x: xa, y: Y(1), width: bw, height: yb - Y(1), fill: 'var(--sunken)', stroke: 'var(--line)' }));
    linkSvg.append(s('rect', { x: xb, y: Y(1), width: bw, height: yb - Y(1), fill: 'var(--sunken)', stroke: 'var(--line)' }));
    if (!L.capacity) {
      linkSvg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'soft' }, 'Give a baud rate'));
    } else {
      let u = 0;
      for (const m of L.messages) {
        const du = (m.binBps * 10) / L.baud;
        const ya = Y(u + du), yb2 = Y(u);
        if (yb2 - ya > 0.3) {
          const r = s('rect', { x: xa + 1, y: ya, width: bw - 2, height: yb2 - ya, fill: mcol(m.id), 'fill-opacity': m.row === (cur() || {}).row ? 1 : 0.75 });
          r.append(s('title', {}, `${m.name}: ${f(m.binBps, 4)} B/s`));
          linkSvg.append(r);
        }
        u += du;
      }
      const ut = L.loadTxt;
      linkSvg.append(s('rect', { x: xb + 1, y: Y(ut), width: bw - 2, height: yb - Y(ut), fill: 'var(--ink-soft)', 'fill-opacity': 0.35 }));
      if (ut > 1.08) {
        linkSvg.append(s('path', { d: `M${xb + bw / 2 - 6},${Y(1.08) + 6}l6,-8l6,8z`, fill: 'var(--danger)' }));
      }
      const lb = L.loadBin;
      const tone = lb > 0.7 ? 'bad' : lb > 0.5 ? 'warn' : 'ok';
      linkSvg.append(s('text', { x: xa + bw / 2, y: Math.max(yt - 12, Y(lb) - 6), 'text-anchor': 'middle', class: `${tone}` }, `${f(lb * 100, 3)} %`));
      linkSvg.append(s('text', { x: xb + bw / 2, y: Math.max(yt - 12, Y(ut) - 6), 'text-anchor': 'middle', class: ut > 0.7 ? 'bad' : ut > 0.5 ? 'warn' : '' }, `${f(ut * 100, 3)} %`));
    }
    linkSvg.append(s('text', { x: xa + bw / 2, y: yb + 14, 'text-anchor': 'middle', class: 'small' }, 'binary'));
    linkSvg.append(s('text', { x: xb + bw / 2, y: yb + 14, 'text-anchor': 'middle', class: 'small soft' }, 'printf'));
    linkSvg.append(s('text', { x: W / 2, y: H - 1, 'text-anchor': 'middle', class: 'small soft' }, L.capacity ? `${f(L.binBps, 4)} vs ${f(L.txtBps, 4)} B/s of ${f(L.capacity, 4)}` : ''));

    // baud picker
    if (!bauds.childElementCount) {
      bauds.append(h('label', {}, 'Baud', baudIn), ...BAUDS.map((b) => h('button', { class: 'k-btn', 'data-b': b, onclick: () => ctx.set('baud', String(b)) }, b >= 1e6 ? `${b / 1e6}M` : b >= 1000 ? `${b / 1000}k` : String(b))));
    }
    for (const b of bauds.querySelectorAll('[data-b]')) b.setAttribute('aria-pressed', String(Number(b.dataset.b) === L.baud));
    if (document.activeElement !== baudIn) baudIn.value = ctx.raw.baud ?? '';
    baudIn.classList.toggle('bad', String(ctx.raw.baud ?? '').trim() !== '' && ctx.parseEng(String(ctx.raw.baud)) == null);
  }

  function drawSide() {
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Record layout notes'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }
  function drawAll() { drawRecord(); drawTypes(); drawEdit(); drawList(); drawLink(); drawSide(); }

  let firstTab = true;
  ctx.onResult((r) => {
    res = r; drawAll();
    if (firstTab) {
      firstTab = false;
      let chosen = null;
      try { chosen = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { chosen = null; }
      if (!chosen) [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'log_fmt.h')?.click();
    }
  });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = wrap.clientWidth;
    if (w !== lastW) { lastW = w; drawRecord(); drawList(); drawLink(); }
  }).observe(wrap);
  void frozen;
}
