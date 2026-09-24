// CRC Calculator, custom page: the CRC's shift register drawn as the tool.
//
// The register is a row of bit cells (MSB left). Data bits enter at the left,
// XORed with the bit leaving the top; that feedback runs back along a bus
// under the register and is XORed in at every tap - where the polynomial has
// a one. Click a tap slot to add or remove it (that edits the polynomial),
// click a cell at the start to flip an Init bit. Step / Play walk the
// computation bit by bit or byte by byte; the output stages (reflect out, XOR
// out) and the final CRC follow at the end. A searchable preset list with
// check values, and an Identify field, sit at the side.
//
// Every register state comes from tool.js (registerTrace / byteSteps /
// finish, the functions crc() itself runs on); the CRC, wire bytes and check
// value shown are run()'s result.crc.
import { toBytes, registerTrace, byteSteps, finish, feedOrder, PRESETS } from './tool.js';

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
const hx = (v, w) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0');
const hxBare = (v, w) => (v >>> 0).toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0');
const b2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
const bit = (v, i) => Math.floor(v / 2 ** i) & 1;
const printable = (b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : b === 10 ? '\\n' : b === 13 ? '\\r' : b === 9 ? '\\t' : '·');
const MAX_STRIP = 2048;
const sup = (n) => String(n).split('').map((ch) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[ch]).join('');

export function page(root, ctx) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const st = {
    pos: 0, total: 0, mode: 'bit', timer: null, bytes: [], p: null, starts: [0],
    dataKey: '', paramKey: '', cache: new Map(), prevPos: -1, search: '',
  };

  // ------------------------------------------------------------ layout
  const fmtSel = h('select', { id: 'crc-format', 'aria-label': 'Data is', onchange: (e) => ctx.set('format', e.target.value) },
    h('option', { value: 'text' }, 'Text (UTF-8)'), h('option', { value: 'escaped' }, 'Text with C escapes'), h('option', { value: 'hex' }, 'Hex bytes'));
  const dataTa = h('textarea', { id: 'crc-data', rows: 2, spellcheck: 'false', 'aria-label': 'Data',
    oninput: (e) => ctx.set('data', e.target.value) });
  const dataCount = h('span', { class: 'crc-soft' });
  const strip = h('div', { class: 'crc-strip', role: 'list', 'aria-label': 'Input bytes, click one to step to it' });
  const dataPanel = h('section', { class: 'crc-panel crc-data' },
    h('div', { class: 'crc-head' }, h('label', { for: 'crc-data', class: 'crc-h' }, 'Data'), fmtSel, dataCount),
    dataTa, strip);

  // parameter strip: editing any of these while a preset is chosen makes it Custom
  const widthSel = h('select', { 'aria-label': 'Width', onchange: (e) => setParam('width', e.target.value) },
    h('option', { value: '8' }, '8 bit'), h('option', { value: '16' }, '16 bit'), h('option', { value: '32' }, '32 bit'));
  const hexIn = (key, label) => h('input', { type: 'text', spellcheck: 'false', class: 'crc-hexin', 'aria-label': label, 'data-key': key,
    oninput: (e) => setParam(key, e.target.value) });
  const polyIn = hexIn('poly', 'Polynomial, hex, normal form'), initIn = hexIn('init', 'Init, hex'), xorIn = hexIn('xorout', 'XOR out, hex');
  const refinCb = h('input', { type: 'checkbox', onchange: (e) => setParam('refin', e.target.checked) });
  const refoutCb = h('input', { type: 'checkbox', onchange: (e) => setParam('refout', e.target.checked) });
  const nameTag = h('span', { class: 'crc-name' });
  const polyExpr = h('span', { class: 'crc-expr' });
  const params = h('div', { class: 'crc-params' },
    h('label', {}, 'Width ', widthSel),
    h('label', {}, 'Poly 0x', polyIn), h('label', {}, 'Init 0x', initIn), h('label', {}, 'XOR out 0x', xorIn),
    h('label', { class: 'crc-cb' }, refinCb, ' Reflect in'), h('label', { class: 'crc-cb' }, refoutCb, ' Reflect out'));

  const warns = h('div', { class: 'crc-warns', 'aria-live': 'polite' });
  const regWrap = h('div', { class: 'crc-regwrap' });
  const btn = (label, title, fn) => h('button', { class: 'k-btn crc-sbtn', title, 'aria-label': title, onclick: fn }, label);
  const bFirst = btn('|<', 'Reset to the start (register = Init)', () => { stop(); go(0); });
  const bBack = btn('<', 'Step back', () => { stop(); go(stepTarget(-1)); });
  const bStep = btn('>', 'Step', () => { stop(); go(stepTarget(1)); });
  const bPlay = h('button', { class: 'k-btn k-primary crc-play', onclick: () => (st.timer ? stop() : play()) }, 'Play');
  const bEnd = btn('>|', 'Jump to the end', () => { stop(); go(st.total); });
  const modeBtns = ['bit', 'byte'].map((m) => h('button', { class: 'crc-seg', 'data-mode': m, 'aria-pressed': 'false',
    onclick: () => { st.mode = m; drawStepper(); } }, m === 'bit' ? 'Bit' : 'Byte'));
  const status = h('div', { class: 'crc-status', 'aria-live': 'polite' });
  const stepper = h('div', { class: 'crc-stepper' }, h('div', { class: 'crc-sbtns' }, bFirst, bBack, bStep, bPlay, bEnd,
    h('span', { class: 'crc-segs', role: 'group', 'aria-label': 'Step size' }, modeBtns)), status);

  const stages = h('div', { class: 'crc-stages' });
  const regPanel = h('section', { class: 'crc-panel crc-reg', tabindex: '-1' },
    h('div', { class: 'crc-head' }, h('span', { class: 'crc-h' }, 'Shift register'), nameTag, polyExpr),
    params, warns, regWrap, stepper, stages);

  const idIn = h('input', { type: 'text', id: 'crc-expect', spellcheck: 'false', placeholder: 'e.g. 0x29B1',
    oninput: (e) => ctx.set('expect', e.target.value) });
  const idOut = h('div', { class: 'crc-idout', 'aria-live': 'polite' });
  const searchIn = h('input', { type: 'search', placeholder: 'Search presets, aliases, check values', 'aria-label': 'Search presets',
    oninput: (e) => { st.search = e.target.value; drawPresets(); } });
  const list = h('div', { class: 'crc-list', role: 'listbox', 'aria-label': 'CRC presets' });
  const side = h('aside', { class: 'crc-panel crc-side' },
    h('label', { for: 'crc-expect', class: 'crc-h' }, 'Identify a known CRC'),
    h('div', { class: 'crc-soft crc-small' }, 'Type the CRC your device sends for this data: presets that give it light up.'),
    idIn, idOut, h('div', { class: 'crc-h crc-mt' }, 'Presets'), searchIn,
    h('div', { class: 'crc-listhead' }, h('span', {}, 'name'), h('span', {}, 'check'), h('span', {}, 'your data')), list);

  const notes = h('div', { class: 'crc-notes' });
  // one grid: on wide screens the side list is a column of its own; on narrow
  // ones it follows the register, before the output panel
  root.append(h('div', { class: 'crc-page' }, dataPanel, regPanel, side, ctx.outputs, notes));

  regPanel.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowRight' && !e.target.closest('.crc-tap, .crc-cell')) { e.preventDefault(); stop(); go(stepTarget(1)); }
    else if (e.key === 'ArrowLeft' && !e.target.closest('.crc-tap, .crc-cell')) { e.preventDefault(); stop(); go(stepTarget(-1)); }
  });

  // ------------------------------------------------------------ inputs
  function toCustom(over) {
    const c = ctx.result?.crc;
    if (!c) return;
    const w = Number(over.width ?? c.width);
    const m = w === 32 ? 0xFFFFFFFF : 2 ** w - 1;
    ctx.setMany({ preset: 'custom', width: String(w), poly: hxBare(c.poly & m, w), init: hxBare(c.init & m, w),
      xorout: hxBare(c.xorout & m, w), refin: c.refin, refout: c.refout, ...over });
  }
  function setParam(key, value) {
    if (ctx.raw.preset === 'custom') {
      if (key === 'width') toCustom({ width: value }); // masks poly/init/xorout to the new width
      else ctx.set(key, value);
    } else toCustom({ [key]: value });
  }
  const toggleTap = (i) => {
    const c = ctx.result.crc;
    toCustom({ poly: hxBare((c.poly ^ 2 ** i) >>> 0, c.width) });
  };
  const toggleInit = (i) => {
    const c = ctx.result.crc;
    toCustom({ init: hxBare((c.init ^ 2 ** i) >>> 0, c.width) });
  };
  const syncVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };

  // ------------------------------------------------------------ stepping
  function stepsFor(bi) {
    let s = st.cache.get(bi);
    if (!s) { s = byteSteps(st.starts[bi], st.bytes[bi], st.p); st.cache.set(bi, s); }
    return s;
  }
  function stateAt(pos) {
    if (pos <= 0 || !st.bytes.length) return { reg: st.starts[0], last: null };
    const bi = Math.floor((pos - 1) / 8), k = (pos - 1) % 8;
    const s = stepsFor(bi);
    return { reg: s[k + 1].reg, last: { bi, k, prev: s[k].reg, ...s[k + 1] } };
  }
  function stepTarget(dir) {
    if (st.mode === 'bit') return st.pos + dir;
    return dir > 0 ? Math.floor(st.pos / 8) * 8 + 8 : Math.ceil(st.pos / 8) * 8 - 8;
  }
  function go(pos) {
    st.prevPos = st.pos;
    st.pos = Math.max(0, Math.min(st.total, pos));
    drawDynamic();
  }
  function play() {
    if (!st.total) return;
    if (st.pos >= st.total) go(0);
    const tick = () => {
      if (st.pos >= st.total) { stop(); return; }
      go(stepTarget(1));
      if (st.pos >= st.total) stop();
    };
    st.timer = setInterval(tick, st.mode === 'bit' ? 170 : 380);
    drawStepper();
  }
  function stop() {
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
    drawStepper();
  }

  // ------------------------------------------------------------ result in
  ctx.onResult((res) => {
    const raw = ctx.raw;
    fmtSel.value = raw.format || 'text';
    syncVal(dataTa, String(raw.data ?? ''));
    syncVal(idIn, String(raw.expect ?? ''));
    const c = res.crc;
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    if (!c) {
      // unreadable input: keep the last drawing, dimmed, with the reason on top
      regPanel.classList.add('crc-stale');
      drawPresets();
      return;
    }
    regPanel.classList.remove('crc-stale');
    widthSel.value = String(c.width);
    syncVal(polyIn, hxBare(c.poly, c.width));
    syncVal(initIn, hxBare(c.init, c.width));
    syncVal(xorIn, hxBare(c.xorout, c.width));
    refinCb.checked = c.refin; refoutCb.checked = c.refout;
    for (const el of [polyIn, initIn, xorIn]) el.style.width = `${Math.ceil(c.width / 4) + 3}ch`;
    const got = toBytes(raw.data, raw.format);
    const bytes = got.bytes || [];
    const p = { w: c.width, poly: c.poly, init: c.init, refin: c.refin, refout: c.refout, xorout: c.xorout };
    const dataKey = `${raw.format}|${bytes.length}|${bytes.join(',')}`;
    const paramKey = JSON.stringify(p);
    const dataChanged = dataKey !== st.dataKey;
    if (dataChanged || paramKey !== st.paramKey) {
      st.bytes = bytes; st.p = p; st.cache = new Map();
      st.starts = registerTrace(bytes, p);
      st.total = bytes.length * 8;
      // new data: show the finished computation; new parameters: stay where the stepper is
      if (dataChanged || st.pos > st.total) { st.pos = st.total; stop(); }
      st.prevPos = -1;
      st.dataKey = dataKey; st.paramKey = paramKey;
    }
    dataCount.textContent = `${bytes.length} byte${bytes.length === 1 ? '' : 's'}`;
    nameTag.textContent = c.name + (c.same && c.same !== c.name ? ` = ${c.same} parameters` : '');
    polyExpr.textContent = polyText(c.poly, c.width);
    drawStrip(true);
    drawDynamic();
    drawPresets();
    notes.replaceChildren(...(res.notes || []).map((n) => h('div', {}, n)));
  });

  function polyText(poly, w) {
    const t = [`x^${w}`];
    for (let i = w - 1; i >= 0; i--) if (bit(poly, i)) t.push(i === 0 ? '1' : i === 1 ? 'x' : `x^${i}`);
    return t.join(' + ').replace(/\^(\d+)/g, (_, d) => sup(d));
  }

  // ------------------------------------------------------------ drawing
  let stripCells = [];
  let stripFrom = 0;
  function drawStrip(force) {
    const n = st.bytes.length;
    const cur = st.pos >= st.total ? n - 1 : Math.floor(st.pos / 8);
    // very long data: draw a window around the current byte
    let from = 0;
    if (n > MAX_STRIP) from = Math.max(0, Math.min(n - MAX_STRIP, cur - MAX_STRIP / 2));
    if (force || from !== stripFrom || stripCells.length !== Math.min(n, MAX_STRIP)) {
      stripFrom = from;
      stripCells = [];
      const kids = [];
      if (!n) kids.push(h('div', { class: 'crc-soft crc-empty' }, 'No data: the register holds Init and the CRC is Init after the output stages.'));
      if (from > 0) kids.push(h('span', { class: 'crc-soft crc-more' }, `… ${from} bytes`));
      for (let i = from; i < Math.min(n, from + MAX_STRIP); i++) {
        const b = st.bytes[i];
        const cell = h('button', { class: 'crc-byte', role: 'listitem', title: `Byte ${i} = 0x${b2(b)} (${b}). Click to step to its start.`,
          onclick: () => { stop(); go(i * 8); } },
        h('b', {}, b2(b)), h('i', {}, printable(b)), h('span', { class: 'crc-bar' }));
        stripCells.push(cell); kids.push(cell);
      }
      if (from + MAX_STRIP < n) kids.push(h('span', { class: 'crc-soft crc-more' }, `… ${n - from - MAX_STRIP} more`));
      strip.replaceChildren(...kids);
    }
    const done = Math.floor(st.pos / 8);
    const partial = st.pos % 8;
    stripCells.forEach((el, j) => {
      const i = j + from;
      el.classList.toggle('is-done', i < done);
      el.classList.toggle('is-cur', i === done && partial > 0);
      el.querySelector('.crc-bar').style.width = i < done ? '100%' : i === done ? `${(partial / 8) * 100}%` : '0';
    });
    const curEl = stripCells[Math.min(Math.max(0, (partial ? done : done - 1) - from), stripCells.length - 1)];
    if (curEl && strip.scrollWidth > strip.clientWidth) {
      const l = curEl.offsetLeft - strip.offsetLeft, r = l + curEl.offsetWidth;
      if (l < strip.scrollLeft || r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = l - strip.clientWidth / 2;
    }
  }

  function drawStepper() {
    const n = st.bytes.length;
    bFirst.disabled = bBack.disabled = st.pos <= 0;
    bStep.disabled = bEnd.disabled = st.pos >= st.total;
    bPlay.disabled = !st.total;
    bPlay.textContent = st.timer ? 'Pause' : st.pos >= st.total && st.total ? 'Replay' : 'Play';
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode));
    const { last } = stateAt(st.pos);
    let s;
    if (!n) s = 'No data to step through.';
    else if (!last) s = `Start: register = Init ${hx(st.starts[0], st.p.w)}. Click a cell to flip an Init bit.`;
    else {
      const b = st.bytes[last.bi];
      s = `Bit ${st.pos} of ${st.total} · byte ${last.bi} (0x${b2(b)} '${printable(b)}'), bit ${last.k + 1} of 8: `
        + `in ${last.bit} ⊕ top ${last.top} = feedback ${last.fb}`
        + (last.fb ? ' → shift, XOR the polynomial in' : ' → shift only');
    }
    status.textContent = s;
  }

  function drawDynamic() {
    drawStrip(false);
    drawRegister();
    drawStepper();
    drawStages();
  }

  // The register, its taps and the feedback loop.
  //   cells: bit w-1 (left) .. bit 0 (right); data moves right to left.
  //   taps:  under the gap to the right of cell i, an XOR feeding cell i when
  //          poly bit i is 1; the feedback bus runs under all of them.
  function drawRegister() {
    const p = st.p;
    if (!p) return;
    const w = p.w;
    const avail = Math.max(300, regWrap.clientWidth || 900);
    const L = 78, R = 14, XX = 34;
    const pitch = Math.max(24, Math.min(60, (avail - L - R) / w));
    const W = Math.max(avail, L + R + pitch * w);
    const gap = Math.max(6, Math.round(pitch * 0.2)), cw = pitch - gap;
    const yIn = 20, yNib = 82, yIdx = 97, yCell = 104, ch = 40, mid = yCell + ch / 2;
    const tapY = yCell + ch + 22, bus = tapY + 28, H = bus + 26;
    const cellX = (i) => L + (w - 1 - i) * pitch;
    const tapX = (i) => cellX(i) + cw + gap / 2;
    const { reg, last } = stateAt(st.pos);
    const atEnd = st.pos >= st.total;
    const fired = !!(last && last.fb);
    const animate = !reduce.matches && st.prevPos === st.pos - 1 && last;

    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'crc-svg', role: 'group',
      'aria-label': `CRC-${w} shift register, ${hx(reg, w)}` });

    // data path (behind the cells) and the feedback bus
    const lowTap = [...Array(w).keys()].find((i) => bit(p.poly, i)) ?? 0;
    svg.append(sv('line', { x1: XX + 11, y1: mid, x2: tapX(0), y2: mid, class: 'crc-wire' }));
    svg.append(sv('path', { d: `M${XX} ${mid + 11} V${bus} H${tapX(lowTap)}`, class: `crc-wire crc-fb${fired ? ' is-on' : ''}` }));
    svg.append(sv('text', { x: XX + 8, y: bus + 17, class: `crc-lab${fired ? ' crc-fblab' : ''}` }, `feedback${last ? ` = ${last.fb}` : ''}`));

    // cells
    const editable = st.pos === 0;
    for (let i = w - 1; i >= 0; i--) {
      const x = cellX(i), v = bit(reg, i);
      const xored = fired && bit(p.poly, i);
      const g = sv('g', { class: `crc-cell${v ? ' is-one' : ''}${xored ? ' is-xored' : ''}${editable ? ' is-edit' : ''}`,
        'data-i': i, tabindex: editable ? 0 : null, role: editable ? 'switch' : null,
        'aria-checked': editable ? String(!!v) : null, 'aria-label': editable ? `Init bit ${i}: ${v}. Enter flips it.` : null });
      if (w <= 16 || i % 4 === 3 || i === 0) g.append(sv('text', { x: x + cw / 2, y: yIdx, class: 'crc-idx', 'text-anchor': 'middle' }, i));
      g.append(sv('rect', { x, y: yCell, width: cw, height: ch, rx: 3, class: 'crc-box' }));
      const t = sv('text', { x: x + cw / 2, y: mid + 5.5, class: 'crc-v', 'text-anchor': 'middle' }, v);
      g.append(t);
      if (animate && i > 0) {
        t.style.transform = `translateX(${pitch}px)`;
        t.style.opacity = '0.15';
        requestAnimationFrame(() => requestAnimationFrame(() => { t.style.transform = ''; t.style.opacity = ''; }));
      }
      g.append(sv('title', {}, `bit ${i} = ${v}${editable ? ' (Init). Click to flip.' : ''}`));
      if (editable) {
        g.addEventListener('click', () => toggleInit(i));
        g.addEventListener('keydown', (e) => keyNav(e, '.crc-cell', i, w, () => toggleInit(i)));
      }
      svg.append(g);
    }
    // the register in hex, one digit over each nibble
    for (let n = 0; n < w / 4; n++) {
      const hiBit = w - 1 - n * 4;
      const x0 = cellX(hiBit), x1 = cellX(hiBit - 3) + cw;
      const nib = Math.floor(reg / 2 ** (hiBit - 3)) & 15;
      svg.append(sv('path', { d: `M${x0} ${yNib + 4}V${yNib + 7}H${x1}V${yNib + 4}`, class: 'crc-brace' }));
      svg.append(sv('text', { x: (x0 + x1) / 2, y: yNib, class: 'crc-nib', 'text-anchor': 'middle' }, nib.toString(16).toUpperCase()));
    }
    svg.append(sv('text', { x: Math.min(cellX(0) + cw, avail - 8), y: yNib - 22, class: 'crc-regval', 'text-anchor': 'end' },
      `${!last ? 'Init' : atEnd ? 'final register' : 'register'} ${hx(reg, w)}`));

    // taps: one slot per bit; an XOR where the polynomial has a one
    for (let i = 0; i < w; i++) {
      const on = bit(p.poly, i), x = tapX(i);
      const g = sv('g', { class: `crc-tap${on ? ' is-tap' : ''}${on && fired ? ' is-fired' : ''}${i === 0 && !on ? ' is-bad' : ''}`,
        tabindex: 0, role: 'switch', 'aria-checked': String(!!on), 'data-i': i,
        'aria-label': `Tap x^${i}: ${on ? 'on' : 'off'}. Enter toggles, arrows move.` });
      g.append(sv('rect', { x: x - pitch / 2, y: yCell + ch + 3, width: pitch, height: bus - yCell - ch + 4, rx: 3, class: 'crc-hit' }));
      if (on) {
        const cls = `crc-wire crc-fb${fired ? ' is-on' : ''}`;
        g.append(sv('line', { x1: x, y1: bus, x2: x, y2: tapY + 7, class: cls }));
        g.append(sv('line', { x1: x, y1: tapY - 7, x2: x, y2: mid, class: cls }));
        g.append(sv('circle', { cx: x, cy: tapY, r: 7, class: 'crc-xor' }));
        g.append(sv('path', { d: `M${x - 7} ${tapY}H${x + 7}M${x} ${tapY - 7}V${tapY + 7}`, class: 'crc-xorx' }));
        g.append(sv('circle', { cx: x, cy: mid, r: 2.2, class: `crc-dot${fired ? ' is-on' : ''}` }));
      } else {
        g.append(sv('circle', { cx: x, cy: tapY, r: 2.5, class: 'crc-off' }));
        g.append(sv('path', { d: `M${x} ${tapY + 5}V${bus}M${x} ${tapY - 5}V${mid + 2}`, class: 'crc-ghost' }));
      }
      g.append(sv('title', {}, `x^${i}: ${on ? 'tap on' : 'no tap'} (poly bit ${i}). Click to ${on ? 'remove' : 'add'} it.`));
      g.addEventListener('click', () => toggleTap(i));
      g.addEventListener('keydown', (e) => keyNav(e, '.crc-tap', i, w, () => toggleTap(i)));
      svg.append(g);
    }
    if (!bit(p.poly, 0)) {
      svg.append(sv('text', { x: tapX(0) + 4, y: bus + 17, class: 'crc-lab crc-badlab', 'text-anchor': 'end' }, 'x⁰ tap missing: even polynomial'));
    }

    // the top bit out, the input bit in, their XOR = feedback
    svg.append(sv('text', { x: L - 5, y: mid - 9, class: 'crc-lab', 'text-anchor': 'end' }, `x${sup(w)}`));
    if (last) svg.append(sv('text', { x: L - 5, y: mid + 19, class: 'crc-lab', 'text-anchor': 'end' }, `top ${last.top}`));
    svg.append(sv('circle', { cx: XX, cy: mid, r: 11, class: `crc-xor crc-inxor${fired ? ' is-on' : ''}` }));
    svg.append(sv('path', { d: `M${XX - 11} ${mid}H${XX + 11}M${XX} ${mid - 11}V${mid + 11}`, class: 'crc-xorx' }));

    // the current byte's bits in feed order, the one just fed highlighted
    if (st.bytes.length) {
      const bi = last ? last.bi : 0, b = st.bytes[bi];
      const order = feedOrder(b, p.refin);
      const bx = XX + 22, bw = 21;
      svg.append(sv('text', { x: bx + 8 * bw + 8, y: yIn + 15.5, class: 'crc-lab' },
        `byte ${bi} · 0x${b2(b)} '${printable(b)}' · ${p.refin ? 'reflect in: fed LSB first' : 'fed MSB first'}`));
      order.forEach((v, k) => {
        const cls = !last ? 'is-next' : k < last.k ? 'is-used' : k === last.k ? 'is-cur' : '';
        svg.append(sv('rect', { x: bx + k * bw, y: yIn, width: bw - 3, height: 22, rx: 3, class: `crc-inbit ${cls}` }));
        svg.append(sv('text', { x: bx + k * bw + (bw - 3) / 2, y: yIn + 15.5, class: `crc-inbv ${cls}`, 'text-anchor': 'middle' }, v));
      });
      const srcX = bx + (last ? last.k : 0) * bw + (bw - 3) / 2;
      svg.append(sv('path', { d: `M${srcX} ${yIn + 22} V${yIn + 36} H${XX} V${mid - 11}`, class: `crc-wire crc-in${last ? ' is-on' : ''}` }));
      svg.append(sv('text', { x: XX - 4, y: mid - 17, class: 'crc-lab crc-inlab', 'text-anchor': 'end' }, last ? `in ${last.bit}` : 'in'));
    }

    regWrap.replaceChildren(svg);
  }

  function keyNav(e, sel, i, w, act) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); refocus(sel, i); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      const j = Math.max(0, Math.min(w - 1, i + (e.key === 'ArrowLeft' ? 1 : -1)));
      regWrap.querySelector(`${sel}[data-i="${j}"]`)?.focus();
    }
  }

  function refocus(sel, i) {
    requestAnimationFrame(() => regWrap.querySelector(`${sel}[data-i="${i}"]`)?.focus());
  }

  // Output stages: final register -> reflect out -> XOR out -> the CRC.
  function drawStages() {
    const c = ctx.result?.crc, p = st.p;
    if (!c || !p) return;
    const w = p.w;
    const f = finish(st.starts[st.starts.length - 1], p);
    const atEnd = st.pos >= st.total;
    const stage = (title, val, sub, extra) => h('div', { class: `crc-stage${atEnd ? '' : ' is-pending'}` },
      h('span', { class: 'crc-h' }, title, extra), h('b', {}, hx(val, w)), sub ? h('em', {}, sub) : null);
    const arrow = () => h('span', { class: 'crc-arrow', 'aria-hidden': 'true' }, '→');
    const outToggle = h('button', { class: `crc-chip${p.refout ? ' is-on' : ''}`, 'aria-pressed': String(p.refout),
      onclick: () => setParam('refout', !p.refout), title: 'Toggle Reflect out' }, p.refout ? 'on' : 'off');
    const bin = [];
    for (let i = w / 8 - 1; i >= 0; i--) bin.push((Math.floor(c.value / 2 ** (8 * i)) & 255).toString(2).padStart(8, '0'));
    const checkOk = c.catalogueCheck == null ? null : c.check === c.catalogueCheck;
    const final = h('div', { class: 'crc-final' },
      h('div', { class: 'crc-finhead' }, h('span', { class: 'crc-h' }, c.name), h('span', { class: 'crc-soft' }, `over ${c.bytes} byte${c.bytes === 1 ? '' : 's'}`)),
      h('div', { class: 'crc-big', title: `${c.value} decimal` }, c.hex),
      h('div', { class: 'crc-bin' }, bin.join(' '), h('span', { class: 'crc-soft' }, `  = ${c.value}`)),
      w > 8 ? h('div', { class: 'crc-wire2' },
        h('div', {}, h('span', { class: 'crc-soft' }, 'on the wire, high byte first '), h('b', {}, c.be)),
        h('div', {}, h('span', { class: 'crc-soft' }, 'low byte first (Modbus, a uint on ARM/x86) '), h('b', {}, c.le)))
        : h('div', { class: 'crc-wire2' }, h('div', {}, h('span', { class: 'crc-soft' }, 'on the wire '), h('b', {}, c.be))),
      h('div', { class: `crc-check${checkOk === false ? ' is-bad' : ''}` }, 'check "123456789" = ', h('b', {}, hx(c.check, w)),
        checkOk == null ? ' (custom: compare with your datasheet)' : checkOk ? ' matches the catalogue' : ' DOES NOT match the catalogue'));
    stages.replaceChildren(
      stage(`Register after ${st.bytes.length} byte${st.bytes.length === 1 ? '' : 's'}`, f.reg, atEnd ? null : 'at the end'), arrow(),
      stage('Reflect out ', f.reflected, p.refout ? 'bits reversed' : 'passed through', outToggle), arrow(),
      stage(`XOR out ${hx(p.xorout, w)}`, f.out, p.xorout ? 'bits flipped' : 'nothing flipped'), arrow(),
      final);
  }

  // Preset list with check values and this data's CRC under each.
  function drawPresets() {
    const res = ctx.result;
    const c = res?.crc;
    const table = res?.tables?.[0]?.rows || [];
    const crcOf = new Map(table.map((r) => [r[0], r[7]]));
    const idf = c?.identify;
    const match = new Set(idf?.matches || []), swapped = new Set(idf?.swapped || []);
    const q = st.search.trim().toLowerCase().replace(/^0x/, '');
    const cur = ctx.raw.preset;
    const rows = [];
    if (cur === 'custom' && c) {
      rows.push(h('div', { class: 'crc-item is-sel', role: 'option', 'aria-selected': 'true' },
        h('div', { class: 'crc-iname' }, h('b', {}, c.name), h('small', {}, c.same ? `same parameters as ${c.same}` : 'your parameters')),
        h('code', {}, hx(c.check, c.width)), h('code', {}, c.hex)));
    }
    for (const [name, pr] of Object.entries(PRESETS)) {
      const hay = `${name} ${pr.alias || ''} ${hxBare(pr.check, pr.w)} ${hxBare(pr.poly, pr.w)}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const sel = cur === name;
      const m = match.has(name), sw = swapped.has(name);
      const item = h('button', { class: `crc-item${sel ? ' is-sel' : ''}${m ? ' is-match' : ''}${sw ? ' is-swap' : ''}`,
        role: 'option', 'aria-selected': String(sel), onclick: () => ctx.setMany({ preset: name }) },
      h('div', { class: 'crc-iname' }, h('b', {}, name),
        h('small', {}, [m ? 'matches your CRC' : sw ? 'matches, bytes swapped' : '', pr.alias || ''].filter(Boolean).join(' · '))),
      h('code', { title: 'Check value: CRC of "123456789"' }, hx(pr.check, pr.w)),
      h('code', { title: 'CRC of your data' }, crcOf.get(name) || ''));
      rows.push(item);
    }
    if (!rows.length) rows.push(h('div', { class: 'crc-soft crc-empty' }, 'No preset matches the search.'));
    list.replaceChildren(...rows);
    if (!idf) idOut.replaceChildren();
    else {
      const n = idf.matches.length + idf.swapped.length;
      idOut.replaceChildren(h('div', { class: n ? 'crc-idok' : 'crc-idno' },
        n ? `${n} preset${n === 1 ? ' gives' : 's give'} ${hx(idf.value, idf.value > 0xFFFF ? 32 : idf.value > 0xFF ? 16 : 8)} over this data${idf.swapped.length ? ' (some byte-swapped)' : ''}.`
          : 'No catalogue preset gives this CRC over this data. Check the data bytes (headers, length fields) or try custom parameters.'));
    }
  }

  new ResizeObserver(() => { if (st.p) drawRegister(); }).observe(regWrap);
  reduce.addEventListener?.('change', () => drawRegister());

}
