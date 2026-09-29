// Linux GPIO Number Converter, drawn as the thing itself: the SoC's GPIO banks
// as rows of pins (one row per bank, 32 or 16 lines, grouped by 8), or for a
// Raspberry Pi the 40-pin header as it sits on the board plus the full BCM
// line strip. Click a pin (or move with the arrow keys) and the pin's
// gpiochip, line offset, sysfs number and DT specifier appear beside it as a
// chain from name to number; the cells can be labelled by bank offset, chip
// line or sysfs number, so the numbering is read straight off the drawing.
// Typing a name, a sysfs number or chip:line in the lookup box highlights
// that pin. Everything shown comes from run()'s result (result.grid).

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

const SOC_GROUPS = [
  ['NXP i.MX', ['imx6q', 'imx6ul', 'imx7d', 'imx8mm']],
  ['TI', ['am335x']],
  ['Allwinner', ['h3', 'a64']],
  ['Rockchip', ['rk3399', 'rk3568', 'rk3588']],
  ['Raspberry Pi', ['bcm2835', 'bcm2711', 'bcm2712']],
  ['ST', ['stm32mp15']],
];
const RK = 'ABCD';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

export function page(root, ctx) {
  const KEY = `redline.tool.${ctx.manifest.id}.`;
  let mode = store.get(KEY + 'cells') || 'offset';   // offset | line | sysfs
  let res = null, focusId = null;

  const wrap = h('div', { class: 'lgn' });
  root.append(wrap);

  // ---------- toolbar ----------
  // A new SoC gets a pin that exists on it (a typical user LED / header line).
  const START = { imx6q: 'GPIO4_IO20', imx6ul: 'GPIO1_IO03', imx7d: 'GPIO1_IO08', imx8mm: 'GPIO1_IO13', am335x: 'gpio1_28',
    h3: 'PA10', a64: 'PH10', rk3399: 'GPIO3_B4', rk3568: 'GPIO0_C0', rk3588: 'GPIO1_A1',
    bcm2835: 'GPIO17', bcm2711: 'GPIO17', bcm2712: 'GPIO17', stm32mp15: 'PA14' };
  const socSel = h('select', { 'aria-label': 'SoC', onchange: (e) => ctx.setMany({ soc: e.target.value, pin: START[e.target.value] || '' }) });
  const socDef = ctx.manifest.inputs.find((d) => d.key === 'soc');
  const socLabel = Object.fromEntries(socDef.options.map(([v, t]) => [v, t]));
  for (const [g, ids] of SOC_GROUPS) socSel.append(h('optgroup', { label: g }, ids.map((id) => h('option', { value: id }, socLabel[id] || id))));
  const seg = (name, opts, get, set) => {
    const el = h('div', { class: 'lgn-seg', role: 'group', 'aria-label': name });
    const draw = () => {
      el.replaceChildren(...opts.map(([v, t, tip]) => h('button', { type: 'button', title: tip || null, 'aria-pressed': String(get() === v), onclick: () => { set(v); draw(); } }, t)));
    };
    draw();
    return { el, draw };
  };
  const kernelSeg = seg('Raspberry Pi kernel', [['old', '≤ 6.1'], ['new', '6.6+']], () => ctx.raw.kernel, (v) => ctx.set('kernel', v));
  const kernelBox = h('label', { class: 'lgn-f' }, 'Pi kernel', kernelSeg.el);
  const polSeg = seg('Polarity', [['high', 'Active high'], ['low', 'Active low']], () => ctx.raw.active, (v) => ctx.set('active', v));
  const modeSeg = seg('Cell labels', [['offset', 'Pin', 'Label each cell by its number in the bank'], ['line', 'Line', 'Label each cell by its line offset in the gpiochip'], ['sysfs', 'Sysfs', 'Label each cell by its legacy sysfs number']],
    () => mode, (v) => { mode = v; store.set(KEY + 'cells', v); draw(); });
  const base = h('input', { type: 'text', spellcheck: 'false', placeholder: 'default', class: 'narrow', oninput: (e) => ctx.set('base', e.target.value) });
  const look = h('input', { type: 'search', spellcheck: 'false', placeholder: 'GPIO1_IO05, 116, 3:20, pin 11', class: 'wide',
    'aria-label': 'Find a pin by name, sysfs number or chip:line', oninput: (e) => ctx.set('pin', e.target.value) });
  const bar = h('div', { class: 'lgn-bar' },
    h('label', { class: 'lgn-f' }, 'SoC', socSel),
    h('label', { class: 'lgn-f' }, 'Find pin', look),
    kernelBox,
    h('label', { class: 'lgn-f', title: 'From /sys/class/gpio/gpiochip*/base, when your kernel numbers the chip differently' }, 'Chip sysfs base', base),
    h('label', { class: 'lgn-f' }, 'Polarity', polSeg.el),
    h('label', { class: 'lgn-f lgn-right' }, 'Cells show', modeSeg.el));

  // ---------- the pins ----------
  const gridTitle = h('h2', {});
  const gridSub = h('span', { class: 'lgn-sub' });
  const board = h('div', { class: 'lgn-board' });
  const hover = h('div', { class: 'lgn-hover', 'aria-live': 'off' });
  const help = h('div', { class: 'lgn-help' }, 'Click a pin, or focus one and use ',
    h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ', ', h('kbd', {}, 'Home'), ' ', h('kbd', {}, 'End'),
    '. Hatched cells are lines the kernel counts but the package does not bond out.');
  const gridCard = h('section', { class: 'lgn-card lgn-gridcard' }, h('div', { class: 'lgn-head' }, gridTitle, gridSub), bar, board, hover, help);

  // ---------- the chosen pin ----------
  const pinCard = h('section', { class: 'lgn-card' });
  const warns = h('div', { class: 'lgn-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'lgn-notes' }, h('summary', {}, 'Notes'));
  pinCard.classList.add('lgn-pincard');
  gridCard.classList.add('lgn-gridarea');
  wrap.append(gridCard, pinCard, h('div', { class: 'lgn-col lgn-outarea' }, warns, ctx.outputs, notes));

  const pick = (name) => ctx.set('pin', name);
  const cellText = (g, bk, x) => {
    if (mode === 'line') return String(bk.offsets[x]);
    if (mode === 'sysfs') return String(bk.base + bk.offsets[x]);
    if (g.family === 'rockchip') return `${RK[x >> 3]}${x & 7}`;
    return String(x);
  };
  const describe = (g, bk, x) => `${bk.names[x]} · gpiochip${bk.dev} line ${bk.offsets[x]} · sysfs ${bk.base + bk.offsets[x]}${x >= bk.bonded ? ' · not bonded out' : ''}`;

  // arrow-key moves across the drawing
  const move = (g, b, x, key) => {
    const banks = g.banks;
    let nb = b, nx = x;
    if (key === 'ArrowRight') { nx++; if (nx >= banks[nb].lines) { if (nb < banks.length - 1) { nb++; nx = 0; } else nx--; } }
    else if (key === 'ArrowLeft') { nx--; if (nx < 0) { if (nb > 0) { nb--; nx = banks[nb].lines - 1; } else nx = 0; } }
    else if (key === 'ArrowDown') { if (nb < banks.length - 1) { nb++; nx = Math.min(nx, banks[nb].lines - 1); } }
    else if (key === 'ArrowUp') { if (nb > 0) { nb--; nx = Math.min(nx, banks[nb].lines - 1); } }
    else if (key === 'Home') nx = 0;
    else if (key === 'End') nx = banks[nb].lines - 1;
    else return null;
    return banks[nb].names[nx];
  };
  const cell = (g, b, x, extra = '', opts = {}) => {
    const bk = g.banks[b];
    const on = g.sel.b === b && g.sel.i === x;
    const id = opts.id || `c-${b}-${x}`;
    const el = h('button', { type: 'button', class: `lgn-cell${x >= bk.bonded ? ' nb' : ''}${on ? ' on' : ''}${extra}`,
      'data-id': id, tabindex: on && !opts.skipTab ? 0 : -1, 'aria-pressed': String(on), 'aria-label': describe(g, bk, x), title: describe(g, bk, x) },
    cellText(g, bk, x));
    el.addEventListener('click', () => { el.focus({ preventScroll: true }); focusId = id; pick(bk.names[x]); });
    el.addEventListener('mouseenter', () => { hover.textContent = describe(g, bk, x); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusId = id; pick(bk.names[x]); return; }
      if (opts.move) {
        const t = opts.move(e.key);
        if (!t) return;
        e.preventDefault(); focusId = t.id; pick(t.name); return;
      }
      const to = move(g, b, x, e.key);
      if (to == null) return;
      e.preventDefault();
      const nb = g.banks.findIndex((q) => q.names.includes(to));
      focusId = `c-${nb}-${g.banks[nb].names.indexOf(to)}`;
      pick(to);
    });
    return el;
  };

  function drawBanks(g) {
    const rows = g.banks.map((bk, b) => {
      const per = bk.lines > 16 ? 8 : bk.lines;           // group size
      const groups = [];
      for (let s = 0; s < bk.lines; s += per) {
        const cells = [];
        for (let x = s; x < Math.min(bk.lines, s + per); x++) cells.push(cell(g, b, x));
        const tag = g.family === 'rockchip' ? RK[s / 8] : g.family === 'stm32' || bk.lines <= 16 ? '' : `${s}`;
        groups.push(h('div', { class: 'lgn-grp' }, tag !== '' && b === 0 ? h('span', { class: 'lgn-gtag' }, g.family === 'rockchip' ? `${tag}` : `${tag}–${Math.min(bk.lines, s + per) - 1}`) : null, h('div', { class: 'lgn-cells' }, cells)));
      }
      const here = g.sel.b === b;
      return h('div', { class: `lgn-bank${here ? ' here' : ''}` },
        h('div', { class: 'lgn-bhead' },
          h('b', {}, bk.name),
          h('span', {}, `gpiochip${bk.dev}`),
          h('span', { class: 'soft' }, `base ${bk.base}${bk.bonded < bk.lines ? ` · ${bk.bonded}/${bk.lines} bonded` : ''}`),
          bk.addr ? h('span', { class: 'soft' }, bk.addr) : null),
        h('div', { class: 'lgn-groups' }, groups));
    });
    board.replaceChildren(h('div', { class: 'lgn-banks' }, rows));
  }

  // header navigation: left/right across the pair, up/down along the header; power pins skipped
  const hdrMove = (g, pin, key) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2, Home: -40, End: 40 }[key];
    if (!step) return null;
    let q = pin;
    for (;;) {
      const nq = q + step;
      if (nq < 1 || nq > 40) { if (Math.abs(step) === 40) break; return null; }
      q = nq;
      if (typeof g.header[q - 1].v === 'number') return { id: `h-${q}`, name: `GPIO${g.header[q - 1].v}` };
    }
    // Home/End: first / last GPIO pin
    const list = g.header.filter((p) => typeof p.v === 'number');
    const t = step < 0 ? list[0] : list[list.length - 1];
    return { id: `h-${t.pin}`, name: `GPIO${t.v}` };
  };

  function drawHeader(g) {
    // The 40-pin header, pin 1 top left as on the board (odd pins left column).
    const bk = g.banks[0];
    const hdr = h('div', { class: 'lgn-hdr', role: 'group', 'aria-label': '40-pin header' });
    for (let r = 0; r < 20; r++) {
      const L = g.header[2 * r], R = g.header[2 * r + 1];
      const side = (p, right) => {
        const lab = typeof p.v === 'number'
          ? h('span', { class: 'lgn-plab' }, h('b', {}, `GPIO${p.v}`), p.fn ? h('span', { class: 'soft' }, p.fn) : null)
          : h('span', { class: `lgn-plab pwr ${p.v === 'GND' ? 'gnd' : p.v === '5V' ? 'v5' : 'v3'}` }, h('b', {}, p.v));
        const pin = typeof p.v === 'number'
          ? cell(g, 0, p.v, ' hp', { id: `h-${p.pin}`, move: (key) => hdrMove(g, p.pin, key) })
          : h('span', { class: `lgn-cell hp pwr ${p.v === 'GND' ? 'gnd' : p.v === '5V' ? 'v5' : 'v3'}`, title: `pin ${p.pin}: ${p.v}` }, '');
        const num = h('span', { class: 'lgn-pnum' }, String(p.pin));
        return right ? [pin, num, lab] : [lab, num, pin];
      };
      hdr.append(h('div', { class: 'lgn-hrow' }, h('div', { class: 'lgn-hl' }, side(L, false)), h('div', { class: 'lgn-hr' }, side(R, true))));
    }
    // mode label in header cells
    for (const el of hdr.querySelectorAll('button.lgn-cell')) {
      const x = g.header[Number(el.dataset.id.slice(2)) - 1].v;
      el.textContent = mode === 'offset' ? String(x) : cellText(g, bk, x);
    }
    const strip = [];
    const onHdr = new Set(g.header.filter((p) => typeof p.v === 'number').map((p) => p.v));
    // the header holds the tab stop when the chosen line is on it
    for (let x = 0; x < bk.lines; x++) strip.push(cell(g, 0, x, onHdr.has(x) ? ' onhdr' : '', { skipTab: onHdr.has(x) }));
    board.replaceChildren(h('div', { class: 'lgn-pi' },
      h('div', { class: 'lgn-pihead' }, h('b', {}, '40-pin header'), h('span', { class: 'soft' }, 'pin 1 at the top left, as on the board')), hdr,
      h('div', { class: 'lgn-pihead' }, h('b', {}, `All ${bk.lines} lines of ${bk.label}`), h('span', { class: 'soft' }, `gpiochip${bk.dev}, base ${bk.base}; outlined = on the header`)),
      h('div', { class: 'lgn-cells lgn-strip' }, strip)));
  }

  function drawPin(r) {
    const g = r.grid, sl = g.sel;
    const bk = g.banks[sl.b];
    const v = Object.fromEntries(r.values.map((x) => [x.label, x]));
    const link = (k, big, small, hint, tone = '') => h('div', { class: `lgn-step ${tone}` },
      h('span', { class: 'k' }, k), h('b', {}, big), small ? h('span', { class: 'm' }, small) : null, hint ? h('span', { class: 'hint' }, hint) : null);
    const baseHint = v['Legacy sysfs number'].hint;
    pinCard.replaceChildren(
      h('div', { class: 'lgn-head' }, h('h2', {}, 'Selected pin'), h('span', { class: 'lgn-sub' }, g.soc)),
      h('div', { class: 'lgn-chain' },
        link('SoC pin', sl.found ? sl.name : '—', v.Pin.hint, sl.found ? '' : 'not found: see below', sl.found ? (sl.i >= bk.bonded ? 'warn' : '') : 'bad'),
        h('div', { class: 'lgn-arrow', 'aria-hidden': 'true' }, '↓'),
        link('Character device', `/dev/${sl.dev}`, `line ${sl.line}`, `${v['Line offset'].hint} · label ${bk.label}`),
        h('div', { class: 'lgn-arrow', 'aria-hidden': 'true' }, '↓'),
        link('Legacy sysfs', String(sl.sysfs), `/sys/class/gpio/gpio${sl.sysfs}`, baseHint),
        h('div', { class: 'lgn-arrow', 'aria-hidden': 'true' }, '↓'),
        link('Device tree', sl.spec, null, 'gpios = …;')));
  }

  function draw() {
    const r = res;
    if (!r || !r.grid) { board.replaceChildren(h('div', { class: 'soft' }, 'Nothing to draw: see the messages.')); return; }
    const g = r.grid;
    const had = wrap.contains(document.activeElement);
    const raw = ctx.raw;
    socSel.value = raw.soc;
    if (document.activeElement !== look) look.value = raw.pin ?? '';
    if (document.activeElement !== base) base.value = raw.base ?? '';
    kernelBox.hidden = g.family !== 'rpi';
    kernelSeg.draw(); polSeg.draw(); modeSeg.draw();
    gridTitle.textContent = g.family === 'rpi' ? 'GPIO header' : 'GPIO banks';
    gridSub.textContent = `${g.soc} · ${g.banks.length} chip${g.banks.length > 1 ? 's' : ''} · ${g.banks.reduce((a, b) => a + b.lines, 0)} lines`;
    if (g.family === 'rpi') drawHeader(g); else drawBanks(g);
    const sb = g.banks[g.sel.b];
    hover.textContent = describe(g, sb, g.sel.i);
    drawPin(r);
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Notes (${(r.notes || []).length})`), ...(r.notes || []).map((n) => h('div', {}, n)));
    if (had || focusId) {
      const want = focusId || `c-${g.sel.b}-${g.sel.i}`;
      const el = board.querySelector(`[data-id="${want}"]`) || board.querySelector('.lgn-cell.on');
      if (el && had) el.focus({ preventScroll: true });
    }
    focusId = null;
  }

  let first = true;
  ctx.onResult((r) => {
    res = r;
    draw();
    if (first) {
      first = false;
      const chosen = store.get(`redline.tool.${ctx.manifest.id}.input.tab`);
      if (!chosen) [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'Commands')?.click();
    }
  });
}
