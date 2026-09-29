// SVD Register Browser, drawn as the thing itself: the device's peripherals
// on an address map, the selected peripheral's register map, and the
// selected register as bit lanes (MSB left, 16 to a row as reference manuals
// draw them) with every field's span, access and value on top.
//   Click or drag across bits to set them (a drag paints the value of the
//   first bit it touched); pick a field's enumerated value from its chips or
//   the table; type a value; click a register or a peripheral to go there.
//   Search finds any peripheral, register or field. Drop an .svd anywhere.
// Everything drawn comes from run()'s result.view.

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
// replaceChildren without the nulls a conditional child leaves.
const fill = (el, ...k) => el.replaceChildren(...k.flat().filter((x) => x != null && x !== false));
const hexA = (a) => '0x' + a.toString(16).toUpperCase().padStart(8, '0');
const hexN = (v, digits) => '0x' + v.toString(16).toUpperCase().padStart(digits, '0');
const fbits = (f) => (f.width === 1 ? `${f.lsb}` : `${f.lsb + f.width - 1}:${f.lsb}`);
// Access class for colour: read-only, write-only, write-1/0-to-clear style, plain rw.
const accClass = (tag) => (/\/w[01][cst]|\/w[cs]\b/.test(tag) ? 'acc-w1c' : tag.startsWith('ro') ? 'acc-ro' : tag.startsWith('wo') || tag.startsWith('w1') ? 'acc-wo' : 'acc-rw');
const ACC_WORDS = { ro: 'read-only', wo: 'write-only', rw: 'read-write', w1: 'write once', rw1: 'read, write once' };
const accText = (f) => [ACC_WORDS[f.tag.split('/')[0]] || f.tag, f.mwv, f.ra].filter(Boolean).join(', ');

export function page(root, ctx) {
  const wrap = h('div', { class: 'svd' });
  root.append(wrap);
  let res = null, V = null;
  let selField = null, lastReg = '', lastPer = '', perFilter = '', hitSel = -1, hitsOpen = false, focusBit = null, focusPer = null;
  let paint = null; // an in-progress drag: {to, bits}

  // ---------- top bar: source, device, search ----------
  const fileIn = h('input', { type: 'file', accept: '.svd,.xml,text/xml', hidden: true, onchange: async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadText(await f.text(), f.name);
    fileIn.value = '';
  } });
  const srcArea = h('textarea', { class: 'svd-src', spellcheck: 'false', rows: 10, placeholder: 'Paste the whole .svd XML here: <?xml ...?> <device ...> ... </device>' });
  const srcNote = h('span', { class: 'svd-soft' });
  const drawer = h('div', { class: 'svd-drawer', hidden: true },
    srcArea,
    h('div', { class: 'svd-row' },
      h('button', { class: 'k-btn k-primary', onclick: () => loadText(srcArea.value, 'pasted') }, 'Load pasted SVD'),
      h('button', { class: 'k-btn', onclick: () => { drawer.hidden = true; srcBtn.setAttribute('aria-expanded', 'false'); } }, 'Close'),
      srcNote));
  const srcBtn = h('button', { class: 'k-btn', 'aria-expanded': 'false', onclick: () => {
    drawer.hidden = !drawer.hidden;
    srcBtn.setAttribute('aria-expanded', String(!drawer.hidden));
    if (!drawer.hidden) { const raw = ctx.raw.svd || ''; if (srcArea.value !== raw) srcArea.value = raw; srcArea.focus(); }
  } }, 'Paste SVD');
  const devLabel = h('div', { class: 'svd-dev' });
  const searchIn = h('input', { type: 'search', class: 'svd-search', placeholder: 'Search peripherals, registers, fields', 'aria-label': 'Search', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'svd-hits', autocomplete: 'off' });
  const hitsBox = h('div', { class: 'svd-hits', id: 'svd-hits', role: 'listbox', hidden: true });
  let searchT = 0;
  searchIn.addEventListener('input', () => { clearTimeout(searchT); hitsOpen = true; hitSel = -1; searchT = setTimeout(() => ctx.set('search', searchIn.value), 180); });
  searchIn.addEventListener('focus', () => { if (searchIn.value.trim()) { hitsOpen = true; drawHits(); } });
  searchIn.addEventListener('keydown', (e) => {
    const n = (V && V.hits || []).length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); hitsOpen = true; hitSel = (hitSel + 1) % n; drawHits(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); hitSel = (hitSel - 1 + n) % n; drawHits(); }
    else if (e.key === 'Enter' && n) { e.preventDefault(); goHit(V.hits[Math.max(0, hitSel)]); }
    else if (e.key === 'Escape') { hitsOpen = false; drawHits(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!searchWrap.contains(e.target)) { hitsOpen = false; drawHits(); } });
  const searchWrap = h('div', { class: 'svd-searchwrap' }, searchIn, hitsBox);
  const top = h('div', { class: 'svd-top' },
    h('div', { class: 'svd-row' },
      h('button', { class: 'k-btn', onclick: () => fileIn.click() }, 'Open .svd'), srcBtn,
      h('button', { class: 'k-btn', title: 'The built-in synthetic example device', onclick: () => loadText('', 'example') }, 'Example device'),
      fileIn, devLabel),
    searchWrap);
  const dropHint = h('div', { class: 'svd-drop', hidden: true }, 'Drop the .svd file to load it');

  // ---------- peripherals (address map) ----------
  const perFilterIn = h('input', { type: 'search', class: 'svd-filter', placeholder: 'Filter', 'aria-label': 'Filter peripherals', spellcheck: 'false',
    oninput: (e) => { perFilter = e.target.value.trim().toLowerCase(); drawPeripherals(); } });
  const perSub = h('span', { class: 'svd-soft' });
  const perList = h('div', { class: 'svd-plist', role: 'listbox', 'aria-label': 'Peripherals by address' });
  const perCard = h('section', { class: 'svd-card svd-pcard' },
    h('div', { class: 'svd-head' }, h('h2', {}, 'Address map'), perSub), h('div', { class: 'svd-pad' }, perFilterIn), perList);

  // ---------- the register ----------
  const regTitle = h('h2', { class: 'svd-regname' });
  const regMeta = h('div', { class: 'svd-meta' });
  const valueIn = h('input', { type: 'text', class: 'svd-value', spellcheck: 'false', 'aria-label': 'Register value', inputmode: 'text' });
  let valT = 0;
  valueIn.addEventListener('input', () => { clearTimeout(valT); valT = setTimeout(() => ctx.set('value', valueIn.value.trim()), 250); });
  valueIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(valT); ctx.set('value', valueIn.value.trim()); } });
  const valueDec = h('span', { class: 'svd-soft svd-mono' });
  const diffChip = h('span', { class: 'svd-chip' });
  const valueRow = h('div', { class: 'svd-row svd-valrow' },
    h('label', { class: 'svd-vlabel' }, 'Value', valueIn), valueDec,
    h('button', { class: 'k-btn', title: 'Load the reset value', onclick: () => ctx.set('value', '') }, 'Reset value'),
    h('button', { class: 'k-btn', onclick: () => ctx.set('value', '0x0') }, 'All 0'),
    h('button', { class: 'k-btn', title: 'Invert every bit', onclick: () => { if (V && V.reg) setBits([...V.reg.bits].map((b) => (b === '1' ? '0' : '1')).join('')); } }, 'Invert'),
    diffChip);
  const lanes = h('div', { class: 'svd-lanes' });
  const legend = h('div', { class: 'svd-legend' },
    h('span', {}, h('i', { class: 'lg acc-rw' }), 'read-write'), h('span', {}, h('i', { class: 'lg acc-ro' }), 'read-only'),
    h('span', {}, h('i', { class: 'lg acc-wo' }), 'write-only'), h('span', {}, h('i', { class: 'lg acc-w1c' }), 'write 1/0 to clear or set'),
    h('span', {}, h('i', { class: 'lg rsv' }), 'no field (reserved)'), h('span', {}, h('i', { class: 'lg diff' }), 'differs from reset'));
  const detail = h('div', { class: 'svd-detail', 'aria-live': 'polite' });
  const ftable = h('table', { class: 'svd-ftable' });
  const regCard = h('section', { class: 'svd-card svd-rcard' },
    h('div', { class: 'svd-head' }, regTitle, regMeta), valueRow, lanes, legend, detail,
    h('div', { class: 'svd-tablewrap' }, ftable),
    h('div', { class: 'svd-help' }, 'Click a bit, or drag across bits to paint them. Bits: ', h('kbd', {}, '←'), h('kbd', {}, '→'), h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' move, ', h('kbd', {}, 'Space'), ' toggles. Click a field for its values.'));

  // ---------- the peripheral's register map ----------
  const mapTitle = h('h2', {});
  const mapSub = h('span', { class: 'svd-soft' });
  const mapList = h('div', { class: 'svd-rlist', role: 'listbox', 'aria-label': 'Registers' });
  const mapCard = h('section', { class: 'svd-card' }, h('div', { class: 'svd-head' }, mapTitle, mapSub), mapList);

  // ---------- outputs ----------
  const warns = h('div', { class: 'svd-warns', role: 'status' });
  const scopeBtns = [['register', 'Selected register'], ['peripheral', 'Whole peripheral']].map(([k, t]) =>
    h('button', { 'data-k': k, onclick: () => ctx.set('header', k) }, t));
  const scope = h('div', { class: 'svd-scope' }, h('span', { class: 'svd-soft' }, 'C header for'), h('div', { class: 'svd-seg', role: 'group', 'aria-label': 'C header scope' }, scopeBtns));
  const notes = h('details', { class: 'svd-notes' }, h('summary', {}, 'Notes'));

  wrap.append(top, drawer, dropHint,
    h('div', { class: 'svd-grid' },
      h('div', { class: 'svd-col svd-colp' }, perCard),
      h('div', { class: 'svd-col svd-colm' }, regCard, mapCard),
      h('div', { class: 'svd-col svd-colo' }, warns, scope, ctx.outputs, notes)));

  // ---------- loading ----------
  function loadText(text, from) {
    const t = String(text || '');
    if (t.trim() && !/<device[\s>]/.test(t)) { srcNote.textContent = `${from}: no <device> element - this does not look like an SVD file.`; drawer.hidden = false; return; }
    srcNote.textContent = '';
    drawer.hidden = true; srcBtn.setAttribute('aria-expanded', 'false');
    selField = null; searchIn.value = '';
    ctx.setMany({ svd: t, peripheral: '', register: '', value: '', search: '' });
  }
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; dropHint.hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropHint.hidden = true; });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    dragDepth = 0; dropHint.hidden = true;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    loadText(await f.text(), f.name);
  });

  // ---------- actions ----------
  const goReg = (per, reg, field) => {
    selField = field || null;
    ctx.setMany({ peripheral: per, register: reg, value: '' });
  };
  function goHit(hit) {
    if (!hit) return;
    hitsOpen = false; drawHits();
    goReg(hit.peripheral, hit.register || '', hit.field || null);
  }
  function setBits(bits) {
    // bits: MSB-first string of 0/1 as long as the register.
    const hx = BigInt('0b' + bits).toString(16).toUpperCase();
    ctx.set('value', '0x' + hx.padStart(Math.ceil(bits.length / 4), '0'));
  }
  function setField(f, val) {
    if (!V || !V.reg) return;
    const width = BigInt(f.width), lsb = BigInt(f.lsb);
    let v = BigInt('0b' + V.reg.bits);
    const mask = ((1n << width) - 1n) << lsb;
    v = (v & ~mask) | ((BigInt(val) << lsb) & mask);
    setBits(v.toString(2).padStart(V.reg.size, '0'));
  }

  // ---------- drawing ----------
  function drawTop() {
    const d = V.device || {};
    fill(devLabel, ...[
      h('b', {}, d.name || 'no device'),
      d.cpu ? h('span', {}, d.cpu) : null,
      h('span', {}, `${(V.peripherals || []).length} peripherals`),
      d.vendor ? h('span', {}, d.vendor) : null,
      V.sample ? h('span', { class: 'svd-tag' }, 'built-in example') : null].filter(Boolean));
    if (document.activeElement !== searchIn && searchIn.value !== (ctx.raw.search || '')) searchIn.value = ctx.raw.search || '';
    for (const b of scopeBtns) b.setAttribute('aria-pressed', String((ctx.raw.header || 'register') === b.dataset.k));
  }

  function drawHits() {
    const hits = (V && V.hits) || [];
    const q = searchIn.value.trim();
    const open = hitsOpen && q !== '' && q === (ctx.raw.search || '').trim();
    hitsBox.hidden = !open;
    searchIn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    fill(hitsBox, 
      h('div', { class: 'svd-hitshead' }, hits.length ? `${V.hitCount} match${V.hitCount === 1 ? '' : 'es'}${V.hitCount > hits.length ? `, first ${hits.length}` : ''}` : 'Nothing matches'),
      ...hits.map((x, i) => h('div', { class: `svd-hit${i === hitSel ? ' on' : ''}`, role: 'option', 'aria-selected': String(i === hitSel),
        onpointerdown: (e) => { e.preventDefault(); goHit(x); } },
        h('span', { class: `svd-kind k-${x.kind}` }, x.kind === 'peripheral' ? 'P' : x.kind === 'register' ? 'R' : 'F'),
        h('span', { class: 'svd-mono' }, [x.peripheral, x.register, x.field].filter(Boolean).join('.')),
        h('span', { class: 'svd-soft' }, x.desc || ''))));
    const on = hitsBox.querySelector('.svd-hit.on');
    if (on) { const top = on.offsetTop, bot = top + on.offsetHeight; if (top < hitsBox.scrollTop) hitsBox.scrollTop = top - 24; else if (bot > hitsBox.scrollTop + hitsBox.clientHeight) hitsBox.scrollTop = bot - hitsBox.clientHeight; }
  }

  function drawPeripherals() {
    const P = (V && V.peripherals) || [];
    const cur = V && V.per ? V.per.name : '';
    perSub.textContent = P.length ? `${P.length} peripherals, by address` : '';
    const shown = perFilter ? P.filter((p) => p.name.toLowerCase().includes(perFilter) || (p.group || '').toLowerCase().includes(perFilter) || (p.desc || '').toLowerCase().includes(perFilter)) : P;
    // Contiguous runs: a new window starts where the gap to the next block is 64 KiB or more.
    const groups = [];
    for (const p of shown) {
      const g = groups[groups.length - 1];
      if (g && p.base - g.end < 0x10000) { g.items.push(p); g.end = Math.max(g.end, p.base + p.span); }
      else groups.push({ start: p.base, end: p.base + p.span, items: [p] });
    }
    const kids = [];
    for (const g of groups) {
      const span = Math.max(1, g.end - g.start);
      kids.push(h('div', { class: 'svd-win' }, `${hexA(g.start)} – ${hexA(g.end - 1)}`, h('span', {}, `${g.items.length}`)));
      for (const p of g.items) {
        const x0 = ((p.base - g.start) / span) * 100, w = Math.max(1.5, (p.span / span) * 100);
        const row = h('div', { class: `svd-prow${p.name === cur ? ' on' : ''}`, role: 'option', tabindex: p.name === (focusPer || cur) ? '0' : '-1', 'aria-selected': String(p.name === cur), 'data-name': p.name,
          title: `${p.name}${p.desc ? ': ' + p.desc : ''}${p.from ? ` (derived from ${p.from})` : ''}${p.irqs.length ? `, IRQ ${p.irqs.join(', ')}` : ''}`,
          onclick: () => { focusPer = p.name; goReg(p.name, '', null); } },
        h('span', { class: 'svd-mono svd-addr' }, hexA(p.base)),
        h('span', { class: 'svd-pname' }, p.name, p.from ? h('small', {}, ` = ${p.from}`) : null),
        h('span', { class: 'svd-pbar' }, h('i', { style: `left:${Math.min(98.5, x0).toFixed(2)}%;width:${Math.min(100 - Math.min(98.5, x0), w).toFixed(2)}%` })));
        kids.push(row);
      }
    }
    if (!shown.length) kids.push(h('div', { class: 'svd-empty' }, P.length ? 'No peripheral matches the filter.' : 'No peripherals: the SVD could not be read.'));
    const hadFocus = perList.contains(document.activeElement);
    fill(perList, ...kids);
    const sel = perList.querySelector('.svd-prow.on');
    if (hadFocus) { const f = perList.querySelector(`[data-name="${CSS.escape(focusPer || cur)}"]`); if (f) f.focus({ preventScroll: true }); }
    if (sel && cur !== lastPer) {
      const t = sel.offsetTop - perList.offsetTop;
      if (t < perList.scrollTop || t > perList.scrollTop + perList.clientHeight - 30) perList.scrollTop = Math.max(0, t - perList.clientHeight / 3);
    }
  }
  perList.addEventListener('keydown', (e) => {
    const rows = [...perList.querySelectorAll('.svd-prow')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowDown') j = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = rows.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rows[i].click(); return; }
    else return;
    e.preventDefault();
    rows[i].tabIndex = -1; rows[j].tabIndex = 0; rows[j].focus(); focusPer = rows[j].dataset.name;
  });

  function drawRegister() {
    const R = V.reg;
    if (!R) {
      regTitle.textContent = V.per ? `${V.per.name}: no registers` : 'No register';
      fill(regMeta, ); fill(lanes, ); fill(detail, ); fill(ftable, ); diffChip.textContent = '';
      valueRow.hidden = true; legend.hidden = true;
      return;
    }
    valueRow.hidden = false; legend.hidden = false;
    fill(regTitle, h('span', { class: 'svd-soft' }, `${V.per.name}.`), R.path);
    fill(regMeta, 
      h('span', { class: 'svd-mono' }, hexA(R.addr)), h('span', { class: 'svd-mono svd-soft' }, `+${hexN(R.offset, 3)}`),
      h('span', {}, `${R.size}-bit`), h('span', { class: `svd-acc ${accClass(R.tag)}` }, R.tag),
      h('span', {}, 'reset ', h('b', { class: 'svd-mono' }, R.reset)),
      R.desc ? h('span', { class: 'svd-soft svd-desc' }, R.desc) : null);
    if (document.activeElement !== valueIn) valueIn.value = R.value;
    const v = BigInt('0b' + R.bits);
    valueDec.textContent = `= ${v.toString()}`;
    diffChip.className = `svd-chip ${R.diff.length ? 'warn' : 'ok'}`;
    diffChip.textContent = R.diff.length ? `${R.diff.length} bit${R.diff.length > 1 ? 's' : ''} differ from reset` : 'equals reset';
    if (selField && !R.fields.some((f) => f.name === selField)) selField = null;
    drawLanes(R);
    drawDetail(R);
    drawFields(R);
  }

  function drawLanes(R) {
    const cw = Math.max(300, lanes.clientWidth || 700);
    const size = R.size;
    const per = size <= 8 ? size : cw < 540 ? 8 : size <= 16 ? size : cw > 1150 && size === 32 ? 32 : 16;
    const rows = Math.ceil(size / per);
    const L = 2, cellW = (cw - 2 * L) / per;
    const numH = 14, bandH = 46, cellH = 28, resH = 15, gap = 12;
    const rowH = numH + bandH + 3 + cellH + resH + gap;
    const H = rows * rowH - gap + 4;
    const svg = s('svg', { class: 'svd-svg', viewBox: `0 0 ${cw} ${H}`, width: cw, height: H, role: 'group', 'aria-label': `${R.path} bits` });
    const defs = s('defs');
    const pat = s('pattern', { id: 'svd-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(s('rect', { width: 6, height: 6, class: 'hatch-bg' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hatch-ln' }));
    defs.append(pat); svg.append(defs);
    const pos = (b) => { const k = size - 1 - b; return { r: Math.floor(k / per), c: k % per }; };
    const X = (c) => L + c * cellW;
    const Y = (r) => r * rowH;
    const owner = new Array(size).fill(null);
    for (const f of R.fields) for (let b = f.lsb; b < Math.min(size, f.lsb + f.width); b++) owner[b] = f;
    const diff = new Set(R.diff);
    // bit numbers
    for (let b = 0; b < size; b++) {
      const { r, c } = pos(b);
      svg.append(s('text', { x: X(c) + cellW / 2, y: Y(r) + 10, class: 'num', 'text-anchor': 'middle' }, String(b)));
    }
    // field bands, one segment per row a field crosses; reserved runs too
    const segs = [];
    for (let r = 0; r < rows; r++) {
      const hi = size - 1 - r * per, lo = Math.max(0, hi - per + 1);
      let b = hi;
      while (b >= lo) {
        const f = owner[b];
        let e = b;
        while (e - 1 >= lo && owner[e - 1] === f) e--;
        segs.push({ f, r, hi: b, lo: e });
        b = e - 1;
      }
    }
    const bitsNow = paint ? paint.bits : R.bits;
    for (const sg of segs) {
      const { c: c0 } = pos(sg.hi);
      const n = sg.hi - sg.lo + 1;
      const x = X(c0) + 1, y = Y(sg.r) + numH, w = n * cellW - 2;
      const g = s('g', { class: sg.f ? `band ${accClass(sg.f.tag)}${sg.f.name === selField ? ' sel' : ''}${sg.f.bad ? ' bad' : ''}` : 'band rsv' });
      g.append(s('rect', { x, y, width: w, height: bandH, rx: 3, class: 'bandbg' }));
      if (sg.f) {
        const f = sg.f;
        const t = s('title', {}, `${f.name} [${fbits(f)}] ${accText(f)}${f.desc ? ' - ' + f.desc : ''}`);
        g.append(t);
        const maxCh = Math.max(1, Math.floor((w - 6) / 6.6));
        const cut = (str) => (str.length > maxCh ? str.slice(0, Math.max(1, maxCh - 1)) + '…' : str);
        const cont = sg.hi !== f.lsb + f.width - 1 ? '…' : '';
        g.append(s('text', { x: x + w / 2, y: y + 15, class: 'fname', 'text-anchor': 'middle' }, cut(cont + f.name)));
        if (f.width > 1) {
          const valText = f.enumName ? `${f.value} ${f.enumName}` : f.width > 8 ? f.hex : f.value;
          g.append(s('text', { x: x + w / 2, y: y + 29, class: `fval${f.bad ? ' bad' : ''}`, 'text-anchor': 'middle' }, cut(valText)));
        }
        const tagCh = Math.max(1, Math.floor((w - 2) / 5.8));
        g.append(s('text', { x: x + w / 2, y: y + 41, class: 'ftag', 'text-anchor': 'middle' }, f.tag.length > tagCh ? f.tag.slice(0, tagCh - 1) + '…' : f.tag));
        g.style.cursor = 'pointer';
        g.addEventListener('click', () => { selField = f.name === selField ? null : f.name; drawRegister(); });
      } else if (n * cellW > 50) {
        g.append(s('text', { x: x + w / 2, y: y + 27, class: 'ftag', 'text-anchor': 'middle' }, 'reserved'));
      }
      svg.append(g);
    }
    // bit cells
    for (let b = 0; b < size; b++) {
      const { r, c } = pos(b);
      const on = bitsNow[size - 1 - b] === '1';
      const x = X(c) + 1, y = Y(r) + numH + bandH + 3;
      const f = owner[b];
      const g = s('g', { class: `bit${on ? ' on' : ''}${f ? '' : ' rsv'}${R.loose.includes(b) ? ' loose' : ''}`, tabindex: b === (focusBit ?? size - 1) ? '0' : '-1',
        role: 'checkbox', 'aria-checked': String(on), 'aria-label': `bit ${b}${f ? ' ' + f.name : ' reserved'}`, 'data-bit': b });
      g.append(s('rect', { x, y, width: cellW - 2, height: cellH, rx: 3, class: 'cell' }), s('text', { x: x + (cellW - 2) / 2, y: y + 19, 'text-anchor': 'middle', class: 'bv' }, on ? '1' : '0'));
      svg.append(g);
      const rb = R.resetBits[size - 1 - b], known = R.known[size - 1 - b] === '1';
      svg.append(s('text', { x: x + (cellW - 2) / 2, y: y + cellH + 12, 'text-anchor': 'middle', class: `rst${diff.has(b) ? ' diff' : ''}` }, known ? rb : '?'));
      if (diff.has(b)) svg.append(s('rect', { x: x + 2, y: y + cellH - 3, width: cellW - 6, height: 3, rx: 1.5, class: 'diffbar' }));
    }
    // row captions for the reset line (first row only, if there is room)
    const hadFocus = lanes.contains(document.activeElement);
    fill(lanes, svg);
    if (hadFocus && focusBit != null) { const el = svg.querySelector(`[data-bit="${focusBit}"]`); if (el) el.focus({ preventScroll: true }); }

    // painting bits with a drag
    const bitAt = (e) => {
      const pt = (lanes.firstChild || svg).getBoundingClientRect();
      const x = ((e.clientX - pt.left) / pt.width) * cw, y = ((e.clientY - pt.top) / pt.height) * H;
      const r = Math.floor(y / rowH), inRow = y - r * rowH;
      if (r < 0 || r >= rows || inRow < numH + bandH || inRow > numH + bandH + 3 + cellH + 2) return null;
      const c = Math.floor((x - L) / cellW);
      const b = size - 1 - (r * per + c);
      return c >= 0 && c < per && b >= 0 && b < size ? b : null;
    };
    const flip = (bits, b, to) => { const i = size - 1 - b; return bits.slice(0, i) + to + bits.slice(i + 1); };
    svg.addEventListener('pointerdown', (e) => {
      const b = bitAt(e);
      if (b == null || e.button !== 0) return;
      e.preventDefault();
      focusBit = b;
      const to = R.bits[size - 1 - b] === '1' ? '0' : '1';
      paint = { to, bits: flip(R.bits, b, to), last: b };
      drawLanes(R);
      const svg2 = lanes.firstChild;
      const move = (ev) => {
        const bb = bitAt(ev);
        if (bb == null || bb === paint.last) return;
        paint.last = bb;
        const lo = Math.min(bb, focusBit), hi = Math.max(bb, focusBit);
        let bits = R.bits;
        for (let k = lo; k <= hi; k++) bits = flip(bits, k, paint.to);
        paint.bits = bits;
        // cheap update: only the cells
        for (const g of svg2.querySelectorAll('.bit')) {
          const k = +g.dataset.bit, on = bits[size - 1 - k] === '1';
          g.classList.toggle('on', on); g.lastChild.textContent = on ? '1' : '0';
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        const bits = paint.bits; paint = null;
        if (bits !== R.bits) setBits(bits); else drawLanes(R);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
    svg.addEventListener('keydown', (e) => {
      const b = +(e.target.dataset && e.target.dataset.bit);
      if (!Number.isFinite(b)) return;
      let nb = b;
      if (e.key === 'ArrowLeft') nb = Math.min(size - 1, b + 1);
      else if (e.key === 'ArrowRight') nb = Math.max(0, b - 1);
      else if (e.key === 'ArrowUp') nb = Math.min(size - 1, b + per);
      else if (e.key === 'ArrowDown') nb = Math.max(0, b - per);
      else if (e.key === 'Home') nb = size - 1;
      else if (e.key === 'End') nb = 0;
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); focusBit = b; setBits(flip(R.bits, b, R.bits[size - 1 - b] === '1' ? '0' : '1')); return; }
      else return;
      e.preventDefault();
      focusBit = nb;
      const el = svg.querySelector(`[data-bit="${nb}"]`);
      for (const g of svg.querySelectorAll('.bit')) g.setAttribute('tabindex', '-1');
      if (el) { el.setAttribute('tabindex', '0'); el.focus({ preventScroll: true }); }
      const f = owner[nb];
      if (f && f.name !== selField) { selField = f.name; drawDetail(R); markRows(); for (const g of svg.querySelectorAll('.band')) g.classList.remove('sel'); }
    });
  }

  function drawDetail(R) {
    const f = R.fields.find((x) => x.name === selField);
    if (!f) {
      const nz = R.fields.filter((x) => x.value !== '0').length;
      fill(detail, h('div', { class: 'svd-soft' },
        `${R.fields.length} field${R.fields.length === 1 ? '' : 's'}, ${nz} non-zero. `,
        R.mwv ? h('b', { class: 'svd-warnword' }, `Register: ${R.mwv}. `) : null,
        R.loose.length ? h('b', { class: 'svd-badword' }, `Bits ${R.loose.join(', ')} set with no field. `) : null,
        'Click a field above for its values.'));
      return;
    }
    const chips = f.choices.map((c) => {
      const on = f.enumName === c.name;
      return h('button', { class: `svd-enum${on ? ' on' : ''}`, 'aria-pressed': String(on), title: c.desc || c.name, disabled: c.pattern && !on ? null : null,
        onclick: () => setField(f, BigInt(c.value)) }, h('span', { class: 'svd-mono' }, c.pattern ? c.text : c.value), ' ', c.name);
    });
    fill(detail, 
      h('div', { class: 'svd-dhead' },
        h('b', {}, f.name), h('span', { class: 'svd-mono svd-soft' }, `[${fbits(f)}]`),
        h('span', { class: `svd-acc ${accClass(f.tag)}` }, f.tag), h('span', { class: 'svd-soft' }, accText(f)),
        h('span', { class: 'svd-mono' }, `= ${f.value}${f.width > 3 ? ` (${f.hex})` : ''}`),
        f.reset !== '' ? h('span', { class: `svd-soft${f.reset !== f.value ? ' svd-warnword' : ''}` }, `reset ${f.reset}`) : null,
        h('button', { class: 'k-btn svd-x', 'aria-label': 'Close field', onclick: () => { selField = null; drawRegister(); } }, '×')),
      f.desc ? h('div', { class: 'svd-ddesc' }, f.desc) : null,
      f.enumName ? h('div', { class: 'svd-ddesc' }, h('b', {}, f.enumName), f.enumDesc ? ` - ${f.enumDesc}` : '') : f.bad ? h('div', { class: 'svd-badword' }, `${f.value} is not one of the listed values.`) : null,
      chips.length ? h('div', { class: 'svd-enums' }, chips) : null);
  }

  function drawFields(R) {
    const rows = [...R.fields].reverse().map((f) => {
      const inp = h('input', { type: 'text', class: 'svd-fin', value: f.width > 8 ? f.hex : f.value, 'aria-label': `${f.name} value`, spellcheck: 'false' });
      const commit = () => {
        const t = inp.value.trim();
        let n = null;
        try { n = /^0x[0-9a-f]+$/i.test(t) ? BigInt(t) : /^0b[01]+$/i.test(t) ? BigInt(t) : /^\d+$/.test(t) ? BigInt(t) : null; } catch { n = null; }
        if (n == null || n >= (1n << BigInt(f.width))) { inp.classList.add('bad'); inp.title = `0 to ${(1n << BigInt(f.width)) - 1n}`; return; }
        setField(f, n);
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
      inp.addEventListener('change', commit);
      let meaning;
      if (f.choices.length) {
        const sel = h('select', { class: 'svd-fsel', 'aria-label': `${f.name} meaning`, onchange: (e) => { if (e.target.value !== '') setField(f, BigInt(e.target.value)); } },
          f.enumName ? null : h('option', { value: '', selected: true }, f.bad ? `${f.value}: not listed` : '-'),
          f.choices.filter((c) => !c.pattern || f.enumName === c.name).map((c) => h('option', { value: c.value, selected: f.enumName === c.name }, `${c.pattern ? c.text : c.value} ${c.name}`)));
        meaning = h('td', {}, sel, f.enumDesc ? h('span', { class: 'svd-soft' }, ` ${f.enumDesc}`) : null);
      } else meaning = h('td', { class: 'svd-soft' }, f.desc);
      return h('tr', { class: `${f.name === selField ? 'sel' : ''}${f.value !== '0' ? ' nz' : ''}`, 'data-f': f.name, onclick: (e) => { if (e.target.closest('input,select')) return; selField = f.name; drawRegister(); } },
        h('td', { class: 'svd-mono' }, f.name), h('td', { class: 'svd-mono svd-soft' }, fbits(f)),
        h('td', {}, h('span', { class: `svd-acc ${accClass(f.tag)}` }, f.tag)), h('td', {}, inp), meaning);
    });
    fill(ftable, h('thead', {}, h('tr', {}, ['Field', 'Bits', 'Access', 'Value', 'Meaning'].map((c) => h('th', {}, c)))), h('tbody', {}, rows));
    if (!R.fields.length) fill(ftable, h('tbody', {}, h('tr', {}, h('td', { class: 'svd-soft' }, 'This register has no fields in the SVD; the whole value is one number.'))));
  }
  const markRows = () => { for (const tr of ftable.querySelectorAll('tr[data-f]')) tr.classList.toggle('sel', tr.dataset.f === selField); };

  function drawMap() {
    const P = V.per;
    if (!P) { mapTitle.textContent = 'Registers'; mapSub.textContent = ''; fill(mapList, ); return; }
    mapTitle.textContent = `${P.name} registers`;
    fill(mapSub, 
      h('span', { class: 'svd-mono' }, hexA(P.base)),
      P.from ? ` derived from ${P.from},` : '', ` ${P.regs.length} registers`,
      P.irqs.length ? `, IRQ ${P.irqs.map((q) => `${q.value} ${q.name}`).join(', ')}` : '',
      P.desc ? h('span', { class: 'svd-desc' }, ` - ${P.desc}`) : '');
    const cur = V.reg ? V.reg.path : '';
    const rows = P.regs.map((r) => {
      const strip = h('span', { class: 'svd-strip', 'aria-hidden': 'true' });
      r.fields.forEach(([name, lsb, width, tag], i) => {
        const l = ((r.size - lsb - width) / r.size) * 100, w = (width / r.size) * 100;
        strip.append(h('i', { class: `${accClass(tag)} t${i % 2}`, style: `left:${l.toFixed(2)}%;width:${w.toFixed(2)}%`, title: name }));
      });
      return h('div', { class: `svd-rrow${r.path === cur ? ' on' : ''}`, role: 'option', tabindex: r.path === cur ? '0' : '-1', 'aria-selected': String(r.path === cur), 'data-path': r.path,
        title: r.desc || r.path, onclick: () => goReg(P.name, r.path, null) },
      h('span', { class: 'svd-mono svd-soft' }, `+${hexN(r.offset, 3)}`), h('span', { class: 'svd-mono svd-rname' }, r.path), strip,
      h('span', { class: 'svd-mono svd-soft svd-rreset' }, r.reset), h('span', { class: `svd-acc ${accClass(r.tag)}` }, r.tag));
    });
    const hadFocus = mapList.contains(document.activeElement);
    fill(mapList, ...rows);
    const sel = mapList.querySelector('.svd-rrow.on');
    if (hadFocus && sel) sel.focus({ preventScroll: true });
    if (sel && `${P.name}.${cur}` !== lastReg) {
      const t = sel.offsetTop - mapList.offsetTop;
      if (t < mapList.scrollTop || t > mapList.scrollTop + mapList.clientHeight - 26) mapList.scrollTop = Math.max(0, t - mapList.clientHeight / 3);
    }
  }
  mapList.addEventListener('keydown', (e) => {
    const rows = [...mapList.querySelectorAll('.svd-rrow')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowDown') j = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rows[i].click(); return; }
    else return;
    e.preventDefault();
    rows[i].tabIndex = -1; rows[j].tabIndex = 0; rows[j].focus();
    rows[j].click();
  });

  function drawWarnings() {
    const list = res.warnings || [];
    fill(warns, ...list.map((w) => h('div', {}, w)));
    fill(notes, h('summary', {}, `Notes (${(res.notes || []).length})`), ...(res.notes || []).map((n) => h('div', {}, n)));
  }

  function draw() {
    if (!V) return;
    drawTop();
    drawPeripherals();
    drawRegister();
    drawMap();
    drawWarnings();
    drawHits();
    lastPer = V.per ? V.per.name : '';
    lastReg = V.per && V.reg ? `${V.per.name}.${V.reg.path}` : '';
  }

  ctx.onResult((r) => { res = r; V = r.view || null; draw(); });
  let rw = 0;
  new ResizeObserver(() => { const w = lanes.clientWidth; if (V && V.reg && Math.abs(w - rw) > 4) { rw = w; drawLanes(V.reg); } }).observe(lanes);
}
