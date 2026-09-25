// Fixed-Point Converter, custom page: the stored word and the number line.
//
//   The word    - the bits as cells: sign, integer and fraction bits, with the
//                 binary point as a handle you drag between cells (fraction
//                 bits), a grip at the left end that adds or removes bits
//                 (word length), and every bit clickable.
//   The range   - the whole span the format can hold, the value on it (drag
//                 it), and the saturation zones past each end.
//   The lens    - a zoom onto the Q grid around the value: the representable
//                 neighbours, the one stored, the true value, the rounding
//                 window and the error in LSB. Drag in it to scrub the value
//                 below one LSB and watch the rounding flip.
//   Beside it, the same value in the common Q formats: click one to use it.
// Every number shown comes from run()'s result.fixed.

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
const sup = (n) => String(n).split('').map((c) => ({ '-': '⁻' })[c] || '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]).join('');
// display only: up to ten significant digits, exponent for the very small or large
const g = (v, d = 10) => {
  if (v == null || !Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e7 || a < 1e-4) return v.toExponential(Math.min(d, 6) - 1).replace(/\.?0+e/, 'e').replace('e+', 'e');
  return String(Number(v.toPrecision(d)));
};
const MODES = [['nearest', 'Nearest', 'half away from zero, lround()'], ['even', 'Even', 'nearest, ties to even'], ['floor', 'Floor', 'arithmetic shift right'], ['trunc', 'Trunc', 'toward zero, C cast']];

export function page(root, ctx) {
  const st = { w: 800 };

  // ------------------------------------------------------------ header: what you have
  const dirBtns = [['toq', 'I have a decimal value'], ['fromq', 'I have a stored integer']].map(([v, t]) =>
    h('button', { class: 'fxp-seg', 'data-v': v, 'aria-pressed': 'false', onclick: () => ctx.set('direction', v) }, t));
  const valIn = h('input', { class: 'fxp-big', type: 'text', spellcheck: 'false', inputmode: 'decimal', 'aria-label': 'Decimal value',
    oninput: (e) => ctx.set('value', e.target.value) });
  const rawIn = h('input', { class: 'fxp-big', type: 'text', spellcheck: 'false', 'aria-label': 'Stored integer, decimal or 0x hex',
    oninput: (e) => ctx.set('raw', e.target.value) });
  const valLbl = h('label', { class: 'fxp-inl' }, h('span', {}, 'x ='), valIn);
  const rawLbl = h('label', { class: 'fxp-inl' }, h('span', {}, 'stored ='), rawIn);
  const fmtName = h('div', { class: 'fxp-fmt' });
  const headWarn = h('div', { class: 'fxp-warns', 'aria-live': 'polite' });
  const header = h('section', { class: 'fxp-panel fxp-header' },
    h('div', { class: 'fxp-row' }, h('div', { class: 'fxp-segs', role: 'group', 'aria-label': 'Direction' }, dirBtns), valLbl, rawLbl, fmtName),
    headWarn);

  // ------------------------------------------------------------ the word
  const num = (key, label, unit) => {
    const inp = h('input', { type: 'text', inputmode: 'numeric', class: 'fxp-num', 'aria-label': label, oninput: (e) => ctx.set(key, e.target.value) });
    return [inp, h('label', { class: 'fxp-inl fxp-small' }, h('span', {}, label), inp, unit ? h('span', { class: 'fxp-soft' }, unit) : null)];
  };
  const [bitsIn, bitsLbl] = num('bits', 'word', 'bits');
  const [fracIn, fracLbl] = num('frac', 'fraction', 'bits');
  const sgnBtns = [['signed', 'signed'], ['unsigned', 'unsigned']].map(([v, t]) =>
    h('button', { class: 'fxp-seg', 'data-v': v, 'aria-pressed': 'false', onclick: () => ctx.set('signed', v) }, t));
  const quick = [8, 16, 24, 32].map((w) => h('button', { class: 'fxp-chip', 'data-w': w, onclick: () => {
    const f = ctx.result?.fixed;
    // keep the integer bits when the word changes size: Q15 in 32 bits is Q31
    const intB = f ? f.W - f.n : 1;
    ctx.setMany({ bits: String(w), frac: String(Math.max(0, w - intB)) });
  } }, String(w)));
  const wordWrap = h('div', { class: 'fxp-svgwrap' });
  const wordNums = h('div', { class: 'fxp-wordnums' });
  const word = h('section', { class: 'fxp-panel fxp-word' },
    h('div', { class: 'fxp-head' }, h('span', { class: 'fxp-h' }, 'The stored word'),
      h('div', { class: 'fxp-segs', role: 'group', 'aria-label': 'Sign' }, sgnBtns), bitsLbl,
      h('span', { class: 'fxp-quick' }, quick), fracLbl),
    wordWrap, wordNums,
    h('div', { class: 'fxp-hint' }, 'Drag the binary point between bits (or focus it and use ← →), drag the grip at the left end to change the word length, click a bit to flip it.'));

  // ------------------------------------------------------------ range + lens
  const ovBtns = [['saturate', 'Saturate'], ['wrap', 'Wrap']].map(([v, t]) =>
    h('button', { class: 'fxp-seg', 'data-v': v, 'aria-pressed': 'false', onclick: () => ctx.set('overflow', v) }, t));
  const ovGroup = h('div', { class: 'fxp-segs', role: 'group', 'aria-label': 'On overflow' }, ovBtns);
  const rangeWrap = h('div', { class: 'fxp-svgwrap' });
  const range = h('section', { class: 'fxp-panel fxp-range' },
    h('div', { class: 'fxp-head' }, h('span', { class: 'fxp-h' }, 'Range'), h('span', { class: 'fxp-soft fxp-grow', 'data-k': 'rangetxt' }),
      h('span', { class: 'fxp-soft fxp-small' }, 'on overflow'), ovGroup),
    rangeWrap);
  const rndBtns = MODES.map(([v, t, tip]) => h('button', { class: 'fxp-seg', 'data-v': v, title: tip, 'aria-pressed': 'false', onclick: () => ctx.set('rounding', v) }, t));
  const rndGroup = h('div', { class: 'fxp-segs', role: 'group', 'aria-label': 'Rounding' }, rndBtns);
  const lensWrap = h('div', { class: 'fxp-svgwrap' });
  const lensNums = h('div', { class: 'fxp-lensnums' });
  const lens = h('section', { class: 'fxp-panel fxp-lens' },
    h('div', { class: 'fxp-head' }, h('span', { class: 'fxp-h' }, 'The Q grid around the value'), h('span', { class: 'fxp-grow' }),
      h('span', { class: 'fxp-soft fxp-small' }, 'rounding'), rndGroup),
    lensWrap, lensNums);

  // ------------------------------------------------------------ side: other formats
  const ladder = h('div', { class: 'fxp-ladder', role: 'list' });
  const side = h('aside', { class: 'fxp-panel fxp-side' },
    h('div', { class: 'fxp-head' }, h('span', { class: 'fxp-h' }, 'The same value in common formats')),
    h('div', { class: 'fxp-soft fxp-small' }, 'Error in LSB of each format; the bar spans ±½ LSB. Click one to use it.'),
    ladder);
  const notes = h('div', { class: 'fxp-notes' });
  root.append(h('div', { class: 'fxp-page' }, header, word, range, lens, side, h('div', { class: 'fxp-out' }, ctx.outputs), notes));

  // ------------------------------------------------------------ result in
  let F = null, R = null;
  const sync = (el, v) => { if (document.activeElement !== el && el.value !== String(v ?? '')) el.value = String(v ?? ''); };
  ctx.onResult((res) => {
    R = res; F = res.fixed || null;
    const raw = ctx.raw;
    const dir = raw.direction === 'fromq' ? 'fromq' : 'toq';
    for (const b of dirBtns) b.setAttribute('aria-pressed', String(b.dataset.v === dir));
    for (const b of sgnBtns) b.setAttribute('aria-pressed', String(b.dataset.v === (raw.signed === 'unsigned' ? 'unsigned' : 'signed')));
    for (const b of rndBtns) b.setAttribute('aria-pressed', String(b.dataset.v === raw.rounding));
    for (const b of ovBtns) b.setAttribute('aria-pressed', String(b.dataset.v === raw.overflow));
    for (const b of quick) b.setAttribute('aria-pressed', String(Number(b.dataset.w) === Number(raw.bits)));
    valLbl.hidden = dir !== 'toq'; rawLbl.hidden = dir !== 'fromq';
    rndGroup.parentElement.querySelectorAll('.fxp-small, .fxp-segs').forEach((e) => { e.hidden = dir !== 'toq'; });
    ovGroup.hidden = dir !== 'toq'; ovGroup.previousElementSibling.hidden = dir !== 'toq';
    sync(valIn, raw.value); sync(rawIn, raw.raw); sync(bitsIn, raw.bits); sync(fracIn, raw.frac);
    headWarn.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    if (F) fmtName.replaceChildren(h('b', {}, F.ti), h('span', { class: 'fxp-soft' }, ' TI  = '), h('b', {}, F.arm), h('span', { class: 'fxp-soft' }, ` ARM · ${F.W}-bit ${F.ctype}`));
    else fmtName.replaceChildren();
    for (const p of [word, range, lens, side]) p.classList.toggle('fxp-stale', !F);
    if (!F) return;
    draw();
  });
  new ResizeObserver(() => {
    const w = Math.floor(wordWrap.clientWidth);
    if (F && w && Math.abs(w - st.w) > 1) { st.w = w; draw(); }
  }).observe(wordWrap);

  function draw() {
    st.w = Math.max(280, Math.floor(wordWrap.clientWidth || 800));
    drawWord(); drawRange(); drawLens(); drawLadder();
  }

  // ------------------------------------------------------------ the word
  function bitsOf() {
    const b = BigInt(F.hex);
    return Array.from({ length: F.W }, (_, i) => Number((b >> BigInt(i)) & 1n)); // index = bit number
  }
  function setPattern(u) {
    // a new bit pattern: as the stored integer (fromq) or as the value it stands for (toq)
    const W = BigInt(F.W);
    const r = F.signed ? BigInt.asIntN(F.W, u) : BigInt.asUintN(F.W, u);
    if (ctx.raw.direction === 'fromq') {
      const wasHex = /^\s*[-+]?0x/i.test(String(ctx.raw.raw || ''));
      ctx.set('raw', wasHex ? '0x' + BigInt.asUintN(Number(W), u).toString(16).toUpperCase().padStart(Math.ceil(F.W / 4), '0') : r.toString());
    } else {
      ctx.set('value', String(Number(r) / 2 ** F.n));
    }
  }

  function drawWord() {
    const Wd = st.w, W = F.W, n = F.n;
    const grip = 26, padR = 8;
    const cw = Math.max(7, Math.min(54, (Wd - grip - padR) / W));
    const x0 = grip + Math.max(0, (Wd - grip - padR - cw * W) / 2);
    const y0 = 36, ch = Math.min(52, Math.max(26, cw * 1.15));
    const H = y0 + ch + 44;
    const svg = sv('svg', { width: Wd, height: H, viewBox: `0 0 ${Wd} ${H}`, class: 'fxp-svg', role: 'group', 'aria-label': `${F.ti} word, ${W} bits` });
    const bits = bitsOf();
    const X = (bit) => x0 + (W - 1 - bit) * cw; // bit number -> left edge
    const kind = (bit) => (F.signed && bit === W - 1 ? 'sign' : bit >= n ? 'int' : 'frac');

    // group brackets above
    const groups = [];
    if (F.signed) groups.push(['sign', W - 1, W - 1, 'sign']);
    const intHi = W - 1 - (F.signed ? 1 : 0);
    if (intHi >= n) groups.push(['int', intHi, n, `integer · ${intHi - n + 1}`]);
    if (n > 0) groups.push(['frac', Math.min(n - 1, W - 1), 0, `fraction · ${n} bits ≈ ${F.digits.toFixed(1)} decimal digits`]);
    for (const [k, hiB, loB, label] of groups) {
      const xa = X(hiB) + 2, xb = X(loB) + cw - 2;
      svg.append(sv('path', { d: `M${xa},${y0 - 6}V${y0 - 12}H${xb}V${y0 - 6}`, class: `fxp-grp fxp-k-${k}` }));
      const full = xb - xa > label.length * 6.4;
      const short = k === 'frac' ? `${n}` : k === 'int' ? `${intHi - n + 1}` : 's';
      if (xb - xa > 10 || k !== 'sign') svg.append(sv('text', { x: (xa + xb) / 2, y: y0 - 17, 'text-anchor': 'middle', class: `fxp-grpt fxp-k-${k}` }, full ? label : short));
    }

    // cells
    const every = cw >= 30 ? 1 : cw >= 17 ? 2 : cw >= 11 ? 4 : 8;
    for (let bit = W - 1; bit >= 0; bit--) {
      const k = kind(bit), v = bits[bit];
      const gEl = sv('g', { class: `fxp-cell fxp-k-${k}${v ? ' fxp-one' : ''}`, tabindex: '0', role: 'button',
        'aria-label': `bit ${bit}, ${k === 'sign' ? 'sign' : `weight 2^${bit - n}`}, is ${v}`, 'data-bit': bit });
      gEl.append(sv('rect', { x: X(bit) + 1, y: y0, width: cw - 2, height: ch, rx: 3 }));
      if (cw >= 10) gEl.append(sv('text', { x: X(bit) + cw / 2, y: y0 + ch / 2 + Math.min(8, cw * 0.3), 'text-anchor': 'middle', class: 'fxp-bitv', 'font-size': Math.min(22, cw * 0.62) }, String(v)));
      gEl.append(sv('title', {}, `bit ${bit}: ${k === 'sign' ? `sign, weight −2^${bit - n}` : `weight 2^${bit - n}`}. Click to flip.`));
      svg.append(gEl);
      // weight below
      if ((W - 1 - bit) % every === 0 || (cw >= 26 && (bit === n || bit === n - 1))) {
        const e = bit - n;
        svg.append(sv('text', { x: X(bit) + cw / 2, y: y0 + ch + 14, 'text-anchor': 'middle', class: 'fxp-wt' }, `${k === 'sign' ? '−' : ''}2${sup(e)}`));
      }
      // nibble separators
      if (bit % 4 === 0 && bit > 0) svg.append(sv('line', { x1: X(bit) - 0.5, x2: X(bit) - 0.5, y1: y0 + ch + 2, y2: y0 + ch + 6, class: 'fxp-nib' }));
    }
    // hex nibbles under the word
    if (cw * 4 >= 18) {
      const hex = F.hex.slice(2);
      for (let i = 0; i < hex.length; i++) {
        const loBit = (hex.length - 1 - i) * 4, hiBit = Math.min(W - 1, loBit + 3);
        const xm = (X(hiBit) + X(loBit) + cw) / 2;
        svg.append(sv('text', { x: xm, y: y0 + ch + 32, 'text-anchor': 'middle', class: 'fxp-hexn' }, hex[i]));
      }
    }

    // binary point handle: between bit n and bit n-1
    const px = x0 + (W - n) * cw;
    const pt = sv('g', { class: 'fxp-point', tabindex: '0', role: 'slider', 'aria-label': 'Binary point (fraction bits)', 'aria-valuemin': '0',
      'aria-valuemax': String(W), 'aria-valuenow': String(n), 'aria-valuetext': `${n} fraction bits` });
    pt.append(sv('line', { x1: px, x2: px, y1: y0 - 4, y2: y0 + ch + 4 }),
      sv('circle', { cx: px, cy: y0 + ch + 5, r: 6 }),
      sv('rect', { x: px - 9, y: y0 - 8, width: 18, height: ch + 22, class: 'fxp-hit' }));
    pt.append(sv('title', {}, 'Binary point: drag to change the fraction bits'));
    svg.append(pt);
    drag(pt, (dx, start) => {
      const nn = Math.max(0, Math.min(W, start - Math.round(dx / cw)));
      if (nn !== F.n) ctx.set('frac', String(nn));
    }, () => F.n);
    pt.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: 1, ArrowRight: -1 }[e.key];
      if (d == null) return;
      e.preventDefault();
      ctx.set('frac', String(Math.max(0, Math.min(W, F.n + d))));
      refocus('.fxp-point');
    });

    // word-length grip at the left end
    const gx = X(W - 1) - 4;
    const gr = sv('g', { class: 'fxp-grip', tabindex: '0', role: 'slider', 'aria-label': 'Word length in bits', 'aria-valuemin': '2', 'aria-valuemax': '64',
      'aria-valuenow': String(W) });
    gr.append(sv('rect', { x: gx - 16, y: y0, width: 14, height: ch, rx: 3 }),
      sv('path', { d: `M${gx - 13},${y0 + ch / 2}h8M${gx - 10},${y0 + ch / 2 - 3}l-3,3l3,3M${gx - 8},${y0 + ch / 2 - 3}l3,3l-3,3`, class: 'fxp-gripl' }));
    gr.append(sv('title', {}, 'Drag left to add bits, right to remove them (keeps the fraction bits)'));
    svg.append(gr);
    drag(gr, (dx, start) => {
      const ww = Math.max(Math.max(2, F.n ? 2 : 2), Math.min(64, start - Math.round(dx / cw)));
      if (ww !== F.W) ctx.set('bits', String(ww));
    }, () => F.W);
    gr.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: 1, ArrowRight: -1, ArrowUp: 1, ArrowDown: -1 }[e.key];
      if (d == null) return;
      e.preventDefault();
      ctx.set('bits', String(Math.max(2, Math.min(64, F.W + d))));
      refocus('.fxp-grip');
    });

    svg.addEventListener('click', (e) => {
      const c = e.target.closest('.fxp-cell');
      if (c) flip(Number(c.dataset.bit));
    });
    svg.addEventListener('keydown', (e) => {
      const c = e.target.closest('.fxp-cell');
      if (!c) return;
      const bit = Number(c.dataset.bit);
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(bit); refocus(`.fxp-cell[data-bit="${bit}"]`); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        svg.querySelector(`.fxp-cell[data-bit="${bit + (e.key === 'ArrowLeft' ? 1 : -1)}"]`)?.focus();
      }
    });
    wordWrap.replaceChildren(svg);

    wordNums.replaceChildren(
      h('div', { class: 'fxp-kv' }, h('span', {}, 'stored integer'), h('b', { class: F.over ? 'fxp-bad' : '' }, String(F.raw)), h('em', {}, F.hex)),
      h('div', { class: 'fxp-kv' }, h('span', {}, 'value it represents'), h('b', {}, g(F.rep, 15))),
      h('div', { class: 'fxp-kv' }, h('span', {}, 'scale'), h('b', {}, `2${sup(F.n)}`), h('em', {}, F.n <= 30 ? String(2 ** F.n) : '')),
      h('div', { class: 'fxp-kv' }, h('span', {}, 'C type'), h('b', {}, F.ctype)));
  }
  function flip(bit) {
    const u = BigInt.asUintN(F.W, BigInt(F.hex)) ^ (1n << BigInt(bit));
    setPattern(u);
  }

  // ------------------------------------------------------------ the range
  function drawRange() {
    const Wd = st.w, pad = 14, H = 78, y = 34, bh = 14;
    const svg = sv('svg', { width: Wd, height: H, viewBox: `0 0 ${Wd} ${H}`, class: 'fxp-svg', role: 'group', 'aria-label': `Range ${g(F.min)} to ${g(F.max)}` });
    const zone = Math.min(46, Wd * 0.08);
    const xa = pad + zone, xb = Wd - pad - zone;
    const X = (v) => xa + ((v - F.min) / (F.max - F.min || 1)) * (xb - xa);
    svg.append(sv('rect', { x: pad, y, width: zone - 2, height: bh, class: 'fxp-satz' }),
      sv('rect', { x: xb + 2, y, width: zone - 2, height: bh, class: 'fxp-satz' }),
      sv('rect', { x: xa, y, width: xb - xa, height: bh, rx: 2, class: 'fxp-span' }));
    if (F.min < 0 && F.max > 0) svg.append(sv('line', { x1: X(0), x2: X(0), y1: y - 3, y2: y + bh + 3, class: 'fxp-zero' }),
      sv('text', { x: X(0), y: y + bh + 16, 'text-anchor': 'middle', class: 'fxp-tick' }, '0'));
    svg.append(sv('text', { x: xa, y: y + bh + 16, 'text-anchor': 'start', class: 'fxp-tick' }, g(F.min)),
      sv('text', { x: xb, y: y + bh + 16, 'text-anchor': 'end', class: 'fxp-tick' }, g(F.max)),
      sv('text', { x: pad, y: y - 6, class: 'fxp-satt' }, F.min < 0 ? 'overflow' : 'below 0'),
      sv('text', { x: Wd - pad, y: y - 6, 'text-anchor': 'end', class: 'fxp-satt' }, 'overflow'));
    // the value: the true one (where it lies, or in a zone) and the stored one
    const inside = F.x >= F.min && F.x <= F.max;
    const tx = inside ? X(F.x) : F.x > F.max ? xb + zone / 2 + 1 : pad + zone / 2 - 1;
    const sx = X(F.rep);
    if (!inside) svg.append(sv('path', { d: `M${tx},${y + bh / 2}L${sx},${y + bh / 2}`, class: 'fxp-jump' }));
    svg.append(sv('circle', { cx: sx, cy: y + bh / 2, r: 4, class: 'fxp-stored' }));
    const th = sv('g', { class: `fxp-thumb${inside ? '' : ' fxp-out'}`, tabindex: F.direction === 'toq' ? '0' : null, role: 'slider', 'aria-label': 'Value',
      'aria-valuemin': String(F.min), 'aria-valuemax': String(F.max), 'aria-valuenow': String(F.x) });
    th.append(sv('path', { d: `M${tx - 7},${y - 12}h14l-7,9z` }), sv('line', { x1: tx, x2: tx, y1: y - 3, y2: y + bh + 2 }),
      sv('rect', { x: tx - 10, y: y - 16, width: 20, height: bh + 20, class: 'fxp-hit' }));
    const lbl = `${inside ? '' : 'saturated ← '}x = ${g(F.x, 8)}`;
    const lx = Math.max(pad + 40, Math.min(Wd - pad - 40, tx));
    const anc = inside ? 'middle' : F.x > F.max ? 'end' : 'start';
    svg.append(sv('text', { x: inside ? lx : F.x > F.max ? Wd - pad : pad, y: y - 20, 'text-anchor': anc, class: `fxp-vlab${inside ? '' : ' fxp-bad'}` }, inside ? lbl : `x = ${g(F.x, 8)} is out of range`));
    svg.append(th);
    if (F.direction === 'toq') {
      const toVal = (clientX) => {
        const b = rangeWrap.getBoundingClientRect();
        const px = clientX - b.left;
        let v = F.min + ((px - xa) / (xb - xa)) * (F.max - F.min);
        if (px > xb) v = F.max + ((px - xb) / zone) * (F.max - F.min) * 0.25;
        if (px < xa) v = F.min - ((xa - px) / zone) * (F.max - F.min) * 0.25;
        return Number(v.toPrecision(6));
      };
      drag(th, (dx, s0, ev) => ctx.set('value', String(toVal(ev.clientX))), () => 0);
      th.addEventListener('keydown', (e) => {
        const step = (F.max - F.min) / 100;
        const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[e.key];
        if (d == null) return;
        e.preventDefault();
        ctx.set('value', String(Number((F.x + d * step).toPrecision(6))));
        refocus('.fxp-thumb');
      });
    }
    rangeWrap.replaceChildren(svg);
    range.querySelector('[data-k="rangetxt"]').textContent = `${g(F.min)} … ${g(F.max)}  ·  ${F.lo} … ${F.hi} stored`;
  }

  // ------------------------------------------------------------ the lens
  function drawLens() {
    const Wd = st.w, pad = 16, H = 150, axisY = 78;
    const span = Wd < 520 ? 3.5 : 6; // LSB either side of the centre
    const ppl = (Wd - 2 * pad) / (2 * span); // pixels per LSB
    const c = F.rep; // centre on the stored value
    const X = (v) => Wd / 2 + ((v - c) / F.lsb) * ppl;
    const svg = sv('svg', { width: Wd, height: H, viewBox: `0 0 ${Wd} ${H}`, class: 'fxp-svg fxp-lenssvg', tabindex: '0', role: 'slider',
      'aria-label': 'Value, fine: arrow keys move 0.1 LSB, with Shift 1 LSB', 'aria-valuenow': String(F.x) });
    // rounding window: which true values land on the stored point
    const mode = F.rounding;
    if (mode) {
      let a = c - F.lsb / 2, b = c + F.lsb / 2;
      if (mode === 'floor') { a = c; b = c + F.lsb; }
      if (mode === 'trunc') { if (F.x >= 0) { a = c; b = c + F.lsb; } else { a = c - F.lsb; b = c; } }
      if (!F.over) {
        svg.append(sv('rect', { x: X(a), y: axisY - 26, width: X(b) - X(a), height: 40, class: 'fxp-win' }));
        svg.append(sv('text', { x: (X(a) + X(b)) / 2, y: axisY + 28, 'text-anchor': 'middle', class: 'fxp-wint' }, 'rounds to here'));
      }
    }
    svg.append(sv('line', { x1: pad - 6, x2: Wd - pad + 6, y1: axisY, y2: axisY, class: 'fxp-axis' }));
    // the representable neighbours
    const vw = Math.max(...F.near.map((p) => g(p.value, 9).length)) * 6.8 + 10;
    const every = Math.max(1, Math.ceil(vw / ppl));
    const rawEvery = Math.max(1, Math.ceil((String(F.raw).length * 6.4 + 10) / ppl));
    for (const p of F.near) {
      const x = X(p.value);
      if (x < pad - 8 || x > Wd - pad + 8) continue;
      const j = p.raw - F.raw;
      const me = j === 0;
      svg.append(sv('line', { x1: x, x2: x, y1: axisY - (me ? 14 : 9), y2: axisY + (me ? 14 : 9), class: me ? 'fxp-tick-me' : 'fxp-gtick' }));
      const edge = x < pad + 36 || x > Wd - pad - 36;
      if (me || (j % every === 0 && Math.abs(j) >= every && !edge)) {
        svg.append(sv('text', { x, y: axisY + 44, 'text-anchor': 'middle', class: me ? 'fxp-gval fxp-me' : 'fxp-gval' }, g(p.value, 9)));
      }
      if (me || (j % rawEvery === 0 && Math.abs(j) >= rawEvery)) {
        svg.append(sv('text', { x, y: axisY - 32, 'text-anchor': 'middle', class: me ? 'fxp-graw fxp-me' : 'fxp-graw' }, String(p.raw)));
      }
    }
    // ends of the range inside the lens
    for (const [v, t] of [[F.min, 'min'], [F.max, 'max']]) {
      const x = X(v);
      if (x > pad - 8 && x < Wd - pad + 8) svg.append(sv('text', { x: x + (t === 'max' ? 6 : -6), y: axisY + 4, 'text-anchor': t === 'max' ? 'start' : 'end', class: 'fxp-bad fxp-endt' }, t === 'max' ? '| max' : 'min |'));
    }
    // 1 LSB dimension
    const d0 = X(c) + (F.near.some((p) => p.raw === F.raw + 1) ? 0 : -ppl);
    svg.append(sv('path', { d: `M${d0},${H - 18}v-6M${d0 + ppl},${H - 18}v-6M${d0},${H - 21}H${d0 + ppl}`, class: 'fxp-dim' }),
      sv('text', { x: d0 + ppl / 2, y: H - 5, 'text-anchor': 'middle', class: 'fxp-dimt' }, `1 LSB = 2${sup(-F.n)} = ${g(F.lsb, 6)}`));
    svg.append(sv('circle', { cx: X(c), cy: axisY, r: 6, class: 'fxp-stored' }));
    // the true value and the error arrow
    const tx = Math.max(pad - 4, Math.min(Wd - pad + 4, X(F.x)));
    const offLens = Math.abs(X(F.x) - X(c)) > Wd / 2;
    svg.append(sv('line', { x1: tx, x2: tx, y1: axisY - 20, y2: axisY + 20, class: 'fxp-true' }));
    if (F.err !== 0 && !offLens) {
      const yA = axisY - 16;
      svg.append(sv('path', { d: `M${tx},${yA}H${X(c)}`, class: 'fxp-err', 'marker-end': 'url(#fxp-ah)' }));
    }
    const defs = sv('defs');
    const mk = sv('marker', { id: 'fxp-ah', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    mk.append(sv('path', { d: 'M0,0L8,4L0,8z', class: 'fxp-ahp' }));
    defs.append(mk); svg.prepend(defs);
    const tl = F.direction === 'fromq' ? `stored ${F.raw} = ${g(F.rep, 12)}` : `x = ${g(F.x, 12)}${offLens ? (F.x > c ? '  →' : '  ←') : ''}`;
    svg.append(sv('text', { x: Math.max(pad + 60, Math.min(Wd - pad - 60, tx)), y: 14, 'text-anchor': 'middle', class: 'fxp-truet' }, tl));
    lensWrap.replaceChildren(svg);

    // scrub: 1 px = 1/ppl LSB; toq moves x, fromq moves the stored integer
    drag(svg, (dx, s0) => {
      if (F.direction === 'fromq') {
        const r = s0.raw + Math.round(dx / ppl);
        if (r !== F.raw) setRaw(r);
      } else {
        const q = F.lsb / 1000;
        const v = Math.round((s0.x + (dx / ppl) * F.lsb) / q) * q;
        ctx.set('value', String(Number(v.toPrecision(Math.max(6, Math.ceil(F.digits) + 3)))));
      }
    }, () => ({ x: F.x, raw: F.raw }), true);
    svg.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (d == null) return;
      e.preventDefault();
      if (F.direction === 'fromq') setRaw(F.raw + d * (e.shiftKey ? 16 : 1));
      else {
        const q = F.lsb / 1000;
        const v = Math.round((F.x + d * (e.shiftKey ? 1 : 0.1) * F.lsb) / q) * q;
        ctx.set('value', String(Number(v.toPrecision(Math.max(6, Math.ceil(F.digits) + 3)))));
      }
      refocus('.fxp-lenssvg');
    });

    const eL = F.errLsb;
    lensNums.replaceChildren(
      h('div', { class: 'fxp-kv' }, h('span', {}, 'error'), h('b', { class: F.err === 0 ? 'fxp-ok' : Math.abs(eL) > 0.5001 ? 'fxp-bad' : '' }, F.err === 0 ? '0 (exact)' : g(F.err, 6)),
        h('em', {}, `${eL > 0 ? '+' : ''}${g(eL, 4)} LSB`)),
      h('div', { class: 'fxp-kv' }, h('span', {}, 'relative error'), h('b', {}, F.x === 0 || F.direction === 'fromq' ? '–' : g(Math.abs(F.err / F.x), 4))),
      h('div', { class: 'fxp-kv' }, h('span', {}, 'resolution'), h('b', {}, g(F.lsb, 8)), h('em', {}, `2${sup(-F.n)}`)),
      h('div', { class: 'fxp-kv fxp-meter' }, h('span', {}, 'error within ±½ LSB'), errMeter(eL, F.over)));
  }
  function setRaw(r) {
    const lo = F.lo, hi = F.hi;
    r = Math.max(lo, Math.min(hi, r));
    const wasHex = /^\s*[-+]?0x/i.test(String(ctx.raw.raw || ''));
    ctx.set('raw', wasHex ? '0x' + BigInt.asUintN(F.W, BigInt(r)).toString(16).toUpperCase().padStart(Math.ceil(F.W / 4), '0') : String(r));
  }

  // ------------------------------------------------------------ other formats
  function drawLadder() {
    ladder.replaceChildren(...F.common.map((c) => {
      const cur = c.W === F.W && c.n === F.n && c.signed === F.signed;
      return h('button', { class: `fxp-rung${cur ? ' fxp-cur' : ''}${c.over ? ' fxp-sat' : ''}`, role: 'listitem', 'aria-current': cur ? 'true' : null,
        title: `Use ${c.name}`, onclick: () => ctx.setMany({ bits: String(c.W), frac: String(c.n), signed: c.signed ? 'signed' : 'unsigned' }) },
      h('span', { class: 'fxp-rname' }, c.name),
      h('span', { class: 'fxp-rhex' }, c.hex),
      h('span', { class: 'fxp-rrep' }, c.over ? 'saturated' : g(c.rep, 9)),
      errMeter(c.errLsb, c.over),
      h('span', { class: 'fxp-rerr' }, c.over ? '' : c.err === 0 ? 'exact' : g(c.err, 3)));
    }));
  }

  // ------------------------------------------------------------ helpers
  function errMeter(eL, over) {
    const m = h('span', { class: 'fxp-em', 'aria-hidden': 'true' });
    if (over) { m.classList.add('fxp-em-sat'); return m; }
    const f = Math.max(-1, Math.min(1, eL / 0.5));
    m.append(h('i', { class: 'fxp-emz' }), h('i', { class: `fxp-emb${Math.abs(eL) > 0.5001 ? ' fxp-embad' : ''}`, style: f >= 0 ? `left:50%;width:${f * 50}%` : `right:50%;width:${-f * 50}%` }));
    return m;
  }
  function refocus(sel) { requestAnimationFrame(() => root.querySelector(sel)?.focus()); }
  // pointer drag with a start value; fn(dx, start, event)
  function drag(el, fn, startOf, fine) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (!fine && e.target.closest('.fxp-cell')) return;
      e.preventDefault();
      const x0 = e.clientX, s0 = startOf();
      let moved = false;
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      el.classList.add('fxp-dragging');
      const move = (ev) => { if (Math.abs(ev.clientX - x0) > 1) moved = true; if (moved) fn(ev.clientX - x0, s0, ev); };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        el.classList.remove('fxp-dragging');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}
