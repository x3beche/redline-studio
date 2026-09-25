// IEEE754 Float Inspector, custom page: the word itself is the tool.
//
// The main area is the bit register of the chosen format, drawn large and
// split into sign, exponent and fraction. Click a bit (or focus it and press
// Space) to flip it; the value follows. Under it, the number line zoomed to
// the stored value: its two neighbours, the band of decimals that round to
// these bits, and where the value you typed sits inside that band - drag the
// stored marker (or press the arrow keys on it) to step one ULP. Below that,
// the exponent field as a scale from zero/subnormal to infinity: drag the
// handle to move the value by powers of two.
//
// Every number drawn comes from run(): result.bits carries the fields, the
// stored and exact values, the error, the ULP and the neighbours' patterns.
// Editing the drawing writes a bit pattern (0x...) into the "value" input.

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

const FORMATS = [
  { key: 'binary32', name: 'float', bits: 32, E: 8, M: 23 },
  { key: 'binary64', name: 'double', bits: 64, E: 11, M: 52 },
  { key: 'binary16', name: 'half', bits: 16, E: 5, M: 10 },
  { key: 'bfloat16', name: 'bfloat16', bits: 16, E: 8, M: 7 },
];
const FIELD = { s: 'sign', e: 'exponent', f: 'fraction' };
const sup = (n) => String(n).replace('-', '⁻').split('').map((c) => ('0123456789'.includes(c) ? '⁰¹²³⁴⁵⁶⁷⁸⁹'[c] : c)).join('');
const short = (v) => {
  if (v == null || !Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  return a >= 1e6 || a < 1e-3 ? v.toExponential(3).replace('e+', 'e') : String(Number(v.toPrecision(5)));
};

export function page(root, ctx) {
  const st = { per: 32, width: 0, undo: [], fromDrawing: false, drag: null, focusBit: 0, res: null };

  // ------------------------------------------------------------ top strip
  const valIn = h('input', { id: 'fi-value', class: 'fi-value', type: 'text', spellcheck: 'false', autocomplete: 'off',
    'aria-describedby': 'fi-value-help', oninput: (e) => { st.fromDrawing = false; ctx.set('value', e.target.value); } });
  const howSel = h('select', { id: 'fi-how', class: 'fi-how', 'aria-label': 'Read the value as', onchange: (e) => ctx.set('input', e.target.value) },
    h('option', { value: 'auto' }, 'Auto (0x… = bits)'), h('option', { value: 'decimal' }, 'Decimal'), h('option', { value: 'bits' }, 'Hex bits'));
  const undoBtn = h('button', { class: 'k-btn fi-undo', type: 'button', onclick: () => undo() }, 'Undo');
  const fmtBtns = FORMATS.map((f) => {
    const bar = h('span', { class: 'fi-fmtbar', 'aria-hidden': 'true' },
      h('i', { class: 'fi-s', style: `flex:1` }), h('i', { class: 'fi-e', style: `flex:${f.E}` }), h('i', { class: 'fi-f', style: `flex:${f.M}` }));
    return h('button', { class: 'fi-fmt', type: 'button', 'data-f': f.key, 'aria-pressed': 'false', style: `--w:${f.bits}`,
      onclick: () => setFormat(f.key) },
    h('span', { class: 'fi-fmtname' }, f.name, h('small', {}, ` ${f.bits}-bit`)), bar,
    h('span', { class: 'fi-fmtsplit' }, `1 · ${f.E} · ${f.M}`));
  });
  const top = h('section', { class: 'fi-top' },
    h('div', { class: 'fi-entry' },
      h('label', { for: 'fi-value', class: 'fi-h' }, 'Value or bits'),
      h('div', { class: 'fi-entryrow' }, valIn, howSel, undoBtn),
      h('div', { id: 'fi-value-help', class: 'fi-soft fi-small' }, 'A decimal (0.1, -1.5e-3), inf, nan, or a bit pattern like 0x3DCCCCCD.')),
    h('div', { class: 'fi-fmts', role: 'group', 'aria-label': 'Format' }, fmtBtns));

  // ------------------------------------------------------------ register
  const regTitle = h('span', { class: 'fi-regtitle' });
  const regSvgWrap = h('div', { class: 'fi-regwrap' });
  const eq = h('div', { class: 'fi-eq', 'aria-live': 'polite' });
  const reg = h('section', { class: 'fi-panel fi-reg' },
    h('div', { class: 'fi-head' }, h('span', { class: 'fi-h' }, 'Bits'), regTitle,
      h('span', { class: 'fi-soft fi-small fi-right' }, 'click a bit to flip it · arrows move, Space flips')),
    regSvgWrap, eq);

  // ------------------------------------------------------------ number line
  const lineWrap = h('div', { class: 'fi-linewrap' });
  const stepDown = h('button', { class: 'k-btn', type: 'button', onclick: () => step(-1) }, '− 1 ULP');
  const stepUp = h('button', { class: 'k-btn', type: 'button', onclick: () => step(1) }, '+ 1 ULP');
  const lineNote = h('span', { class: 'fi-soft fi-small' });
  const line = h('section', { class: 'fi-panel fi-line' },
    h('div', { class: 'fi-head' }, h('span', { class: 'fi-h' }, 'Where it lands'), lineNote,
      h('span', { class: 'fi-right fi-btns' }, stepDown, stepUp)),
    lineWrap);

  // ------------------------------------------------------------ exponent scale
  const rangeWrap = h('div', { class: 'fi-rangewrap' });
  const range = h('section', { class: 'fi-panel fi-range' },
    h('div', { class: 'fi-head' }, h('span', { class: 'fi-h' }, 'Exponent field'),
      h('span', { class: 'fi-soft fi-small' }, 'drag the handle to scale by powers of two · arrows ±1, PgUp/PgDn ±8')),
    rangeWrap);

  // ------------------------------------------------------------ side
  const warns = h('div', { class: 'fi-warns', 'aria-live': 'polite' });
  const readout = h('dl', { class: 'fi-readout' });
  const rangeTable = h('dl', { class: 'fi-readout fi-rangetab' });
  const notes = h('div', { class: 'fi-notes' });
  const side = h('aside', { class: 'fi-side' },
    warns,
    h('section', { class: 'fi-panel' }, h('div', { class: 'fi-head' }, h('span', { class: 'fi-h' }, 'Stored')), readout),
    h('section', { class: 'fi-panel' }, h('div', { class: 'fi-head' }, h('span', { class: 'fi-h fi-fmtlabel' }, 'Format')), rangeTable),
    ctx.outputs, notes);

  root.append(h('div', { class: 'fi-page' }, top, h('div', { class: 'fi-main' }, reg, line, range), side));

  // ------------------------------------------------------------ edits
  const pushUndo = () => {
    const r = ctx.raw;
    st.undo.push({ value: r.value, input: r.input, format: r.format });
    if (st.undo.length > 50) st.undo.shift();
  };
  function undo() {
    const u = st.undo.pop();
    if (!u) return;
    st.fromDrawing = /^0x/i.test(String(u.value));
    ctx.setMany(u);
  }
  function setBits(hex) {
    pushUndo();
    st.fromDrawing = true;
    ctx.setMany({ value: hex, input: 'auto' });
  }
  function setFormat(key) {
    if (key === ctx.raw.format) return;
    const b = st.res?.bits;
    pushUndo();
    // a pattern made by clicking belongs to the old width: carry the value over instead
    if (st.fromDrawing && b) {
      const v = b.cls === 'infinity' ? (b.sign === '1' ? '-inf' : 'inf') : b.cls.includes('NaN') ? 'nan' : String(b.exact || '').includes('…') ? b.stored : b.exact;
      st.fromDrawing = false;
      ctx.setMany({ format: key, value: v, input: 'auto' });
    } else ctx.set('format', key);
  }
  const bitsOf = (b) => b.sign + b.exp + b.frac;
  const hexOf = (str) => '0x' + BigInt('0b' + str).toString(16).toUpperCase().padStart(str.length / 4, '0');
  function flip(i) {
    const b = st.res?.bits;
    if (!b) return;
    const a = bitsOf(b).split('');
    a[i] = a[i] === '1' ? '0' : '1';
    st.focusBit = i;
    setBits(hexOf(a.join('')));
  }
  // one representable value up (+1) or down (-1) the number line
  function step(dir) {
    const b = st.res?.bits;
    if (!b || !b.away) return;
    const neg = b.sign === '1';
    const n = (dir > 0) !== neg ? b.away : b.toward;
    if (!n) {
      // +0 going down or -0 going up: cross zero to the smallest subnormal of the other sign
      if (b.e === 0 && /^0+$/.test(b.frac)) setBits(hexOf((neg ? '0' : '1') + '0'.repeat(b.W - 2) + '1'));
      return;
    }
    setBits(n.hex);
  }
  function setExp(e) {
    const b = st.res?.bits;
    if (!b) return;
    const max = 2 ** b.E - 1;
    e = Math.max(0, Math.min(max, Math.round(e)));
    if (e === b.e) return;
    setBits(hexOf(b.sign + e.toString(2).padStart(b.E, '0') + b.frac));
  }

  // ------------------------------------------------------------ register drawing
  function drawRegister(b) {
    const W = b.W;
    const avail = Math.max(300, regSvgWrap.clientWidth || 600);
    // as many bits a row as keep a cell at least 17 px wide (64 on a wide screen)
    let per = W;
    while (per > 8 && avail / per < (per === W && W === 64 ? 13 : 17)) per /= 2;
    st.per = per;
    const rows = W / per;
    const cw = avail / per, ch = Math.min(46, Math.max(28, cw * 1.25));
    const rowH = ch + 58;
    const H = rows * rowH + 4;
    const svg = sv('svg', { class: 'fi-regsvg', width: avail, height: H, viewBox: `0 0 ${avail} ${H}`, role: 'group',
      'aria-label': `${W} bits of ${b.hex}. Arrow keys move between bits, Space or Enter flips one.` });
    const all = bitsOf(b);
    const fieldOf = (i) => (i === 0 ? 's' : i <= b.E ? 'e' : 'f');
    const weight = (i) => {
      const f = fieldOf(i);
      if (f === 's') return 'sign: 1 = negative';
      if (f === 'e') return `exponent bit, weight ${2 ** (b.E - i)} in the field`;
      return `fraction bit, 2${sup(-(i - b.E))} of the significand`;
    };
    const cells = [];
    for (let r = 0; r < rows; r++) {
      const y0 = r * rowH + 16;
      // bit numbers above the cells
      for (let c = 0; c < per; c++) {
        const i = r * per + c, bitNo = W - 1 - i;
        if (cw >= 20 || bitNo % 4 === 3 || i === 0 || fieldOf(i) !== fieldOf(Math.max(0, i - 1)) || bitNo === 0) {
          svg.append(sv('text', { x: c * cw + cw / 2, y: y0 - 5, class: 'fi-bitno', 'text-anchor': 'middle' }, String(bitNo)));
        }
      }
      for (let c = 0; c < per; c++) {
        const i = r * per + c, f = fieldOf(i), on = all[i] === '1';
        const g = sv('g', { class: `fi-bit fi-${f}${on ? ' is-on' : ''}`, tabindex: i === st.focusBit ? '0' : '-1', role: 'button',
          'aria-label': `bit ${W - 1 - i}, ${FIELD[f]}, ${on ? 'one' : 'zero'}`, 'data-i': i });
        g.append(sv('rect', { x: c * cw + 1.5, y: y0, width: cw - 3, height: ch, rx: 3 }),
          sv('text', { x: c * cw + cw / 2, y: y0 + ch / 2 + 5, 'text-anchor': 'middle', class: 'fi-digit', style: `font-size:${Math.min(17, Math.max(11, cw * 0.5))}px` }, all[i]),
          sv('title', {}, `bit ${W - 1 - i}: ${weight(i)}. Click to flip.`));
        g.addEventListener('click', () => flip(i));
        cells.push(g);
        svg.append(g);
      }
      // field brackets under the part of each field in this row, with the field's meaning
      const segs = [['s', 0, 0], ['e', 1, b.E], ['f', b.E + 1, W - 1]];
      for (const [f, a, z] of segs) {
        const lo = Math.max(a, r * per), hi = Math.min(z, r * per + per - 1);
        if (lo > hi) continue;
        const x1 = (lo - r * per) * cw + 2, x2 = (hi - r * per + 1) * cw - 2, yb = y0 + ch + 7;
        svg.append(sv('path', { d: `M${x1},${yb - 4}V${yb}H${x2}V${yb - 4}`, class: `fi-brace fi-${f}` }));
        // the label goes on the row holding most of the field
        const mid = Math.floor((a + z) / 2);
        if (Math.floor(mid / per) !== r && !(f === 's')) continue;
        let [t1, t2] = fieldText(f, b);
        if (f === 's' && cw < 34) t1 = b.sign === '1' ? '−' : '+';
        const cx = f === 's' ? x1 : (x1 + x2) / 2, anchor = f === 's' ? 'start' : 'middle';
        svg.append(sv('text', { x: cx, y: yb + 15, class: `fi-flabel fi-${f}t`, 'text-anchor': anchor }, t1));
        if (t2) svg.append(sv('text', { x: cx, y: yb + 30, class: 'fi-fsub', 'text-anchor': anchor }, t2));
      }
    }
    svg.addEventListener('keydown', (e) => {
      const g = e.target.closest?.('.fi-bit');
      if (!g) return;
      const i = Number(g.dataset.i);
      let j = null;
      if (e.key === 'ArrowRight') j = Math.min(W - 1, i + 1);
      else if (e.key === 'ArrowLeft') j = Math.max(0, i - 1);
      else if (e.key === 'ArrowDown') j = Math.min(W - 1, i + per);
      else if (e.key === 'ArrowUp') j = Math.max(0, i - per);
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = W - 1;
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(i); return; }
      if (j == null) return;
      e.preventDefault();
      cells[i].setAttribute('tabindex', '-1');
      cells[j].setAttribute('tabindex', '0');
      cells[j].focus();
      st.focusBit = j;
    });
    const hadFocus = regSvgWrap.contains(document.activeElement);
    regSvgWrap.replaceChildren(svg);
    if (hadFocus && cells[st.focusBit]) cells[st.focusBit].focus();
  }

  function fieldText(f, b) {
    if (f === 's') return [b.sign === '1' ? '− sign' : '+ sign', ''];
    if (f === 'e') {
      if (b.cls === 'normal') return [`${b.e} − ${b.bias} = ${b.e - b.bias}`, `× 2${sup(b.e - b.bias)}`];
      if (b.cls === 'zero' || b.cls === 'subnormal') return [`${b.e}: ${b.cls}`, `× 2${sup(1 - b.bias)}, no hidden 1`];
      return [`all ones: ${b.cls.includes('NaN') ? 'NaN' : 'infinity'}`, ''];
    }
    const sig = ctx.result?.values?.find((v) => v.label === 'Significand');
    if (b.cls === 'normal' || b.cls === 'subnormal' || b.cls === 'zero') return [`${b.fracHex} / 2${sup(b.M)}`, sig ? `significand ${sig.value}` : ''];
    return [b.fracHex, b.cls];
  }

  function drawEquation(b, res) {
    const sig = res.values.find((v) => v.label === 'Significand');
    const span = (cls, t) => h('span', { class: cls }, t);
    if (b.cls === 'infinity' || b.cls.includes('NaN')) {
      eq.replaceChildren(span('fi-st', b.sign === '1' ? '−' : '+'), ' ', span('fi-et', 'exponent all ones'), ' ',
        span('fi-ft', b.cls === 'infinity' ? 'fraction 0' : `fraction ${b.fracHex}`), ' = ', h('b', {}, b.stored), span('fi-soft', `  ${b.cls}`));
      return;
    }
    const p = b.cls === 'normal' ? b.e - b.bias : 1 - b.bias;
    eq.replaceChildren(
      span('fi-st', `(−1)${sup(b.sign)}`), ' × ', span('fi-ft', sig ? sig.value : '?'), ' × ', span('fi-et', `2${sup(p)}`),
      ' = ', h('b', { class: 'fi-eqval' }, b.stored),
      ...(b.cls !== 'normal' ? [span('fi-soft', `  (${b.cls}: 0.fraction)`)] : []));
  }

  // ------------------------------------------------------------ number line drawing
  function drawLine(b) {
    const Wd = Math.max(300, lineWrap.clientWidth || 600), Ht = 186;
    const svg = sv('svg', { class: 'fi-linesvg', width: Wd, height: Ht, viewBox: `0 0 ${Wd} ${Ht}`, role: 'img' });
    lineWrap.replaceChildren(svg);
    const finite = typeof b.approx === 'number';
    stepDown.disabled = stepUp.disabled = !finite;
    if (!finite) {
      svg.setAttribute('aria-label', `${b.stored} is not on the number line`);
      svg.setAttribute('height', '60'); svg.setAttribute('viewBox', `0 0 ${Wd} 60`);
      svg.append(sv('text', { x: Wd / 2, y: 34, class: 'fi-empty', 'text-anchor': 'middle' },
        `${b.stored}: not a point on the number line. Flip an exponent bit or type a number.`));
      lineNote.textContent = '';
      return;
    }
    const S = b.approx, neg = b.sign === '1';
    const num = (n) => (!n ? null : n.text === 'Inf' ? null : Number(n.text));
    const tw = num(b.toward), aw = num(b.away);
    const L = neg ? aw : tw, R = neg ? tw : aw;
    const Lt = neg ? b.away : b.toward, Rt = neg ? b.toward : b.away;
    const dl = L == null ? null : S - L, dr = R == null ? null : R - S;
    const d = Math.max(dl || 0, dr || 0) || b.ulp || 1;
    const pad = 26, cx = Wd / 2, half = (Wd / 2 - pad);
    const X = (off) => cx + (off / (1.25 * d)) * half; // off = value - S
    const yA = 92;
    // band of decimals that round to these bits (half way to each neighbour)
    const bl = X(dl != null ? -dl / 2 : -d / 2), br = X(dr != null ? dr / 2 : d / 2);
    svg.append(sv('rect', { x: bl, y: yA - 34, width: br - bl, height: 52, class: 'fi-band' }));
    svg.append(sv('text', { x: (bl + br) / 2, y: yA - 40, 'text-anchor': 'middle', class: 'fi-bandt' }, 'every decimal in here is stored as these bits'));
    svg.append(sv('line', { x1: pad - 14, x2: Wd - pad + 14, y1: yA, y2: yA, class: 'fi-axis' }));
    svg.append(sv('text', { x: pad - 16, y: yA + 4, 'text-anchor': 'end', class: 'fi-soft' }, '…'));
    // neighbours
    const tick = (off, label, sub, cls) => {
      const x = X(off);
      svg.append(sv('line', { x1: x, x2: x, y1: yA - 12, y2: yA + 12, class: `fi-tick ${cls}` }));
      svg.append(sv('text', { x, y: yA + 30, 'text-anchor': 'middle', class: `fi-ticklab ${cls}` }, label));
      if (sub) svg.append(sv('text', { x, y: yA + 45, 'text-anchor': 'middle', class: 'fi-ticksub' }, sub));
    };
    if (L != null) tick(-dl, Lt.text, Lt.hex, 'fi-nb');
    else svg.append(sv('text', { x: X(-d), y: yA + 30, 'text-anchor': 'middle', class: 'fi-ticksub' }, neg ? '−Inf beyond' : 'below: the other sign'));
    if (R != null) tick(dr, Rt.text, Rt.hex, 'fi-nb');
    else svg.append(sv('text', { x: X(d), y: yA + 30, 'text-anchor': 'middle', class: 'fi-ticksub' }, neg ? 'above: the other sign' : 'next: +Inf'));
    // ULP dimension between the stored value and its right neighbour
    if (dr != null) {
      const x1 = X(0), x2 = X(dr), yd = yA + 72;
      svg.append(sv('path', { d: `M${x1},${yd - 5}V${yd + 5}M${x2},${yd - 5}V${yd + 5}M${x1},${yd}H${x2}`, class: 'fi-dim' }));
      const ulpV = ctx.result.values.find((v) => v.label === 'ULP here');
      svg.append(sv('text', { x: (x1 + x2) / 2, y: yd + 14, 'text-anchor': 'middle', class: 'fi-dimt' }, `1 ULP = ${ulpV ? ulpV.value : short(b.ulp)}`));
    }
    // what was typed, placed by the exact error (stored − input)
    if (b.err != null && b.input != null) {
      const xt = X(-b.err);
      const errV = ctx.result.values.find((v) => v.label === 'Rounding error');
      svg.append(sv('path', { d: `M${xt},${yA - 3}l-6,-11h12z`, class: 'fi-typed' }));
      const typed = b.input.length > 24 ? b.input.slice(0, 23) + '…' : b.input;
      const left = xt <= cx + 2; // label away from the stored marker's line
      svg.append(sv('text', { x: xt + (left ? -9 : 9), y: yA - 17, 'text-anchor': left ? 'end' : 'start', class: 'fi-typedt fi-dimtbg' }, `you typed ${typed}`));
      if (b.err !== 0) {
        const x1 = Math.min(xt, X(0)), x2 = Math.max(xt, X(0)), yd = yA + 8;
        svg.append(sv('line', { x1, x2, y1: yd, y2: yd, class: 'fi-errdim' }));
      }
      lineNote.textContent = b.err === 0 ? 'stored exactly' : `rounding error ${errV ? errV.value : short(b.err)} (stored − typed)`;
    } else lineNote.textContent = `neighbours of ${b.hex}`;
    // the stored value: the draggable marker
    const xs = X(0);
    const m = sv('g', { class: 'fi-stored', tabindex: '0', role: 'slider', 'aria-label': 'Stored value; Left and Right step one ULP',
      'aria-valuetext': b.stored });
    m.append(sv('line', { x1: xs, x2: xs, y1: yA - 30, y2: yA + 16, class: 'fi-smark' }),
      sv('circle', { cx: xs, cy: yA, r: 7, class: 'fi-sdot' }),
      sv('text', { x: xs, y: yA + 30, 'text-anchor': 'middle', class: 'fi-slab' }, b.stored),
      sv('text', { x: xs, y: yA + 45, 'text-anchor': 'middle', class: 'fi-ticksub' }, b.hex));
    // the exact stored value, when the short form hides digits
    if (b.exact && b.exact !== b.stored) {
      const ex = b.exact.length > 22 ? b.exact.slice(0, 21) + '…' : b.exact;
      m.append(sv('text', { x: xs, y: yA + 60, 'text-anchor': 'middle', class: 'fi-exact fi-dimtbg' }, `exactly ${ex}`));
    }
    svg.append(m);
    svg.setAttribute('aria-label', `Stored ${b.stored} between ${Lt ? Lt.text : 'none'} and ${Rt ? Rt.text : 'none'}`);
    m.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); st.refocus = 'line'; step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); st.refocus = 'line'; step(-1); }
    });
    m.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      m.focus();
      st.drag = { x: e.clientX, dl: dl != null ? X(0) - X(-dl) : null, dr: dr != null ? X(dr) - X(0) : null, id: e.pointerId };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      const g = st.drag;
      if (!g || g.id !== e.pointerId) return;
      const dx = e.clientX - g.x;
      if (g.dr && dx > g.dr / 2) { g.x += g.dr; st.refocus = 'line'; step(1); }
      else if (g.dl && dx < -g.dl / 2) { g.x -= g.dl; st.refocus = 'line'; step(-1); }
    });
    const end = () => { st.drag = null; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    if (st.refocus === 'line') { m.focus(); st.refocus = null; }
  }

  // ------------------------------------------------------------ exponent scale drawing
  function drawRange(b) {
    const Wd = Math.max(300, rangeWrap.clientWidth || 600), Ht = 118;
    const svg = sv('svg', { class: 'fi-rangesvg', width: Wd, height: Ht, viewBox: `0 0 ${Wd} ${Ht}` });
    rangeWrap.replaceChildren(svg);
    const max = 2 ** b.E - 1, pad = 16, yA = 52;
    const X = (e) => pad + (e / max) * (Wd - 2 * pad);
    const w0 = Math.max(10, X(1) - X(0));
    // bands: field 0 (zero, subnormal), normal, all ones (inf, NaN)
    svg.append(sv('rect', { x: pad - w0 / 2, y: yA - 12, width: w0, height: 24, class: 'fi-bsub' }));
    svg.append(sv('rect', { x: pad + w0 / 2, y: yA - 12, width: X(max) - pad - w0, height: 24, class: 'fi-bnorm' }));
    svg.append(sv('rect', { x: X(max) - w0 / 2, y: yA - 12, width: w0, height: 24, class: 'fi-binf' }));
    svg.append(sv('text', { x: pad - w0 / 2, y: yA - 18, class: 'fi-bandl' }, '0 · subnormal'));
    svg.append(sv('text', { x: X(max) + w0 / 2, y: yA - 18, 'text-anchor': 'end', class: 'fi-bandl fi-bandinf' }, 'inf · NaN'));
    // powers of two along the field, and decades under them
    const stepE = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512].find((s) => (Wd - 2 * pad) / (max / s) >= 46) || 512;
    for (let e = 1; e < max; e++) {
      const p = e - b.bias;
      if (p % stepE !== 0) continue;
      const x = X(e);
      svg.append(sv('line', { x1: x, x2: x, y1: yA + 12, y2: yA + 17, class: 'fi-axis' }));
      svg.append(sv('text', { x, y: yA + 29, 'text-anchor': 'middle', class: 'fi-ticksub' }, p === 0 ? '2⁰=1' : `2${sup(p)}`));
    }
    const r = b.range;
    svg.append(sv('text', { x: X(1), y: yA + 46, class: 'fi-ticksub' }, `smallest normal ${short(r.minNormal)}`));
    svg.append(sv('text', { x: X(max - 1), y: yA + 46, 'text-anchor': 'end', class: 'fi-ticksub' }, `largest ${short(r.max)}`));
    // the handle
    const x = X(b.e);
    const tone = b.cls === 'normal' ? '' : b.cls === 'zero' || b.cls === 'subnormal' ? ' is-sub' : ' is-inf';
    const hd = sv('g', { class: `fi-handle${tone}`, tabindex: '0', role: 'slider', 'aria-label': 'Exponent field',
      'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(b.e),
      'aria-valuetext': `${b.e}, ${b.cls === 'normal' ? `2 to the ${b.e - b.bias}` : b.cls}` });
    const lab = b.cls === 'normal' ? `e = ${b.e} → 2${sup(b.e - b.bias)}` : `e = ${b.e} → ${b.cls}`;
    const lx = Math.min(Wd - 6, Math.max(6, x));
    hd.append(sv('rect', { x: x - 6, y: yA - 17, width: 12, height: 34, rx: 3, class: 'fi-hbox' }),
      sv('text', { x: lx, y: 14, 'text-anchor': x < 90 ? 'start' : x > Wd - 90 ? 'end' : 'middle', class: 'fi-hlab' }, lab));
    svg.append(hd);
    const toE = (clientX) => {
      const rc = svg.getBoundingClientRect();
      return ((clientX - rc.left - pad) / (Wd - 2 * pad)) * max;
    };
    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      hd.focus();
      st.refocus = 'range';
      svg.setPointerCapture(e.pointerId);
      st.edrag = e.pointerId;
      setExp(toE(e.clientX));
    });
    svg.addEventListener('pointermove', (e) => { if (st.edrag === e.pointerId) { st.refocus = 'range'; setExp(toE(e.clientX)); } });
    const end = () => { st.edrag = null; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    hd.addEventListener('keydown', (e) => {
      const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 8, PageDown: -8 }[e.key];
      if (k != null) { e.preventDefault(); st.refocus = 'range'; setExp(b.e + k); }
      else if (e.key === 'Home') { e.preventDefault(); st.refocus = 'range'; setExp(0); }
      else if (e.key === 'End') { e.preventDefault(); st.refocus = 'range'; setExp(max); }
    });
    if (st.refocus === 'range') { hd.focus(); st.refocus = null; }
  }

  // ------------------------------------------------------------ side
  function drawSide(res) {
    const b = res.bits;
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res.warnings || []).length;
    const pick = ['Stored value', 'Exact stored value', 'Rounding error', 'Relative error', 'ULP here', 'Bit pattern'];
    readout.replaceChildren(...(res.values || []).filter((v) => pick.includes(v.label)).flatMap((v) => [
      h('dt', {}, v.label),
      h('dd', { class: `${v.label === 'Exact stored value' ? 'fi-long' : ''}${v.tone ? ` fi-tone-${v.tone}` : ''}` },
        String(v.value), v.hint ? h('small', {}, v.hint) : null)]));
    const t = (res.tables || [])[1];
    side.querySelector('.fi-fmtlabel').textContent = t ? t.title.replace(/: .*/, '') : 'Format';
    rangeTable.replaceChildren(...(t ? t.rows.filter((r) => !/^Next/.test(r[0])) : []).flatMap((r) => [h('dt', {}, r[0]), h('dd', {}, r[1])]));
    notes.replaceChildren(...(res.notes || []).map((n) => h('div', {}, n)));
    if (!b) readout.replaceChildren(h('dd', { class: 'fi-soft' }, 'Nothing to show: see the message above.'));
  }

  // ------------------------------------------------------------ result in
  function render() {
    const res = st.res;
    if (!res) return;
    const raw = ctx.raw;
    if (document.activeElement !== valIn && valIn.value !== String(raw.value ?? '')) valIn.value = String(raw.value ?? '');
    howSel.value = raw.input || 'auto';
    for (const btn of fmtBtns) btn.setAttribute('aria-pressed', String(btn.dataset.f === (raw.format || 'binary32')));
    undoBtn.disabled = !st.undo.length;
    undoBtn.textContent = st.undo.length ? `Undo (${st.undo[st.undo.length - 1].value})` : 'Undo';
    drawSide(res);
    const b = res.bits;
    root.classList.toggle('fi-stale', !b);
    if (!b) return;
    regTitle.replaceChildren(h('b', { class: 'fi-mono' }, b.hex), h('span', { class: `fi-cls fi-cls-${b.cls.replace(/\s/g, '')}` }, b.cls));
    drawRegister(b);
    drawEquation(b, res);
    drawLine(b);
    drawRange(b);
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
