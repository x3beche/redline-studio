// GPIO Restriction Warner, custom page: the chip is the tool.
//
// The chip is drawn as a package with every GPIO around its edge (in number
// order, pin 1 at the top left, counter-clockwise, like a datasheet drawing).
// Each pad is coloured by the worst restriction active on it: boot strap,
// flash, debug, input-only... Click a pad (or focus it and press Space) to
// claim it for your design; the claimed pins get a net tag, and a claimed pin
// with a boot or flash risk is flagged where it sits. The pin you point at is
// explained inside the chip body: every restriction, why, and what to do.
// Switches for the conditional limits (Wi-Fi, PSRAM, Pico board) recolour
// the ring live. The side list follows the drawing.
//
// Everything drawn comes from run()'s result.pinmap (the chip's pins, their
// rows and severities) and result.values; clicks edit the "pins" input.
import { norm } from './tool.js';

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

const CHIPS = [
  ['esp32', 'ESP32', 'WROOM / WROVER'], ['esp32s3', 'ESP32-S3', 'WROOM-1'], ['esp32c3', 'ESP32-C3', ''],
  ['esp8266', 'ESP8266', 'ESP-12'], ['stm32f103', 'STM32F103', 'Blue Pill'], ['rp2040', 'RP2040', 'Pico'], ['atmega328p', 'ATmega328P', 'Uno'],
];
const CONDS = {
  wifi: ['Wi-Fi in use', 'ADC2 is taken by the Wi-Fi driver'],
  psram: ['PSRAM / octal flash', 'module wires extra pins to memory'],
  board: ['On a Pico board', 'GPIO23-25, 29 are used by the board'],
};
const SEVN = ['free', 'low', 'medium', 'high'];
const key = (p) => String(p);
// replaceChildren without the nulls a conditional part leaves
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

export function page(root, ctx) {
  const st = { sel: null, focus: null, res: null };

  // ------------------------------------------------------------ top: the chip and its conditions
  const chipBtns = CHIPS.map(([k, n, sub]) => h('button', { class: 'gw-chip', type: 'button', 'data-k': k, 'aria-pressed': 'false',
    onclick: () => { if (ctx.raw.chip !== k) { st.sel = null; ctx.set('chip', k); } } },
  h('b', {}, n), sub ? h('small', {}, sub) : null));
  const condWrap = h('div', { class: 'gw-conds', role: 'group', 'aria-label': 'Conditions' });
  const top = h('section', { class: 'gw-top' },
    h('div', { class: 'gw-chips', role: 'group', 'aria-label': 'Chip' }, chipBtns), condWrap);

  // ------------------------------------------------------------ the package
  const pkgTitle = h('span', { class: 'gw-soft gw-small' });
  const svgWrap = h('div', { class: 'gw-svgwrap' });
  const insp = h('div', { class: 'gw-insp', 'aria-live': 'polite' });
  const stage = h('div', { class: 'gw-stage' }, svgWrap, insp);
  const legend = h('div', { class: 'gw-legend' },
    ...[3, 2, 1, 0].map((s) => h('span', {}, h('i', { class: `gw-sw gw-sev${s}` }), s === 3 ? 'high: can stop boot or flashing' : s === 2 ? 'medium: a limit to design for' : s === 1 ? 'low: worth knowing' : 'no restriction')),
    h('span', {}, h('i', { class: 'gw-sw gw-used' }), 'in your design'),
    h('span', { class: 'gw-soft' }, 'GPIOs in number order around the body, not the package pinout.'));
  const pkg = h('section', { class: 'gw-panel gw-pkg' },
    h('div', { class: 'gw-head' }, h('span', { class: 'gw-h' }, 'Pins'), pkgTitle,
      h('span', { class: 'gw-soft gw-small gw-right' }, 'click a pin to use it · arrows walk the ring, Space toggles')),
    stage, legend);

  // ------------------------------------------------------------ side: your pins
  const pinsIn = h('input', { id: 'gw-pins', class: 'gw-pinsin', type: 'text', spellcheck: 'false', autocomplete: 'off',
    oninput: (e) => ctx.set('pins', e.target.value) });
  const counts = h('div', { class: 'gw-counts' });
  const list = h('div', { class: 'gw-list', role: 'list' });
  const unknownBox = h('div', { class: 'gw-unknown' });
  const showSel = h('div', { class: 'gw-seg', role: 'group', 'aria-label': 'Prompt lists' },
    ...[['all', 'All special pins'], ['mine', 'Only my pins']].map(([v, t]) => h('button', { type: 'button', 'data-v': v, 'aria-pressed': 'false',
      onclick: () => ctx.set('show', v) }, t)));
  const notes = h('div', { class: 'gw-notes' });
  const side = h('aside', { class: 'gw-side' },
    h('section', { class: 'gw-panel' },
      h('div', { class: 'gw-head' }, h('label', { class: 'gw-h', for: 'gw-pins' }, 'Your pins')),
      pinsIn, h('div', { class: 'gw-soft gw-small gw-mt4' }, 'GPIO numbers (12, IO12) or names (PA13), comma or space separated.'),
      counts, unknownBox, list),
    h('section', { class: 'gw-panel gw-showrow' }, h('span', { class: 'gw-soft gw-small' }, 'Table in the prompt:'), showSel),
    ctx.outputs, notes);

  root.append(h('div', { class: 'gw-page' }, top, pkg, side));

  // ------------------------------------------------------------ edits
  function toggle(p) {
    const pm = st.res?.pinmap;
    if (!pm) return;
    const chip = pm.chip;
    const toks = String(ctx.raw.pins ?? '').split(/[,;\s]+/).filter(Boolean);
    const is = (t) => { const n = norm({ num: pm.prefix }, t); return n != null && key(n) === key(p); };
    const kept = toks.filter((t) => !is(t));
    if (kept.length === toks.length) kept.push(String(p));
    st.sel = key(p);
    ctx.set('pins', kept.join(', '));
    void chip;
  }

  // ------------------------------------------------------------ drawing
  function geometry(n, Wa) {
    const narrow = Wa < 560;
    const Ha = narrow ? Math.max(330, Wa * 1.02) : Math.min(540, Math.max(440, Wa * 0.56));
    const lab = narrow ? 44 : 66, pad = narrow ? 11 : 15;
    const m = lab + pad + 4;
    let bw = Wa - 2 * m, bh = Ha - 2 * m;
    bw = Math.min(bw, bh * 1.7);
    // pins per side in proportion to the side's length
    const nv = Math.max(1, Math.round((n * bh) / (2 * (bw + bh))));
    const nh = Math.ceil((n - 2 * nv) / 2);
    const x0 = (Wa - bw) / 2, y0 = (Ha - bh) / 2;
    return { Wa, Ha, bw, bh, x0, y0, nv, nh, lab, pad, narrow };
  }

  function draw() {
    const res = st.res, pm = res?.pinmap;
    if (!pm) return;
    const pins = pm.pins, n = pins.length;
    const Wa = Math.max(300, svgWrap.clientWidth || 700);
    const g = geometry(n, Wa);
    const { Ha, bw, bh, x0, y0, nv, nh, pad } = g;
    const svg = sv('svg', { class: 'gw-svg', width: Wa, height: Ha, viewBox: `0 0 ${Wa} ${Ha}`, role: 'group',
      'aria-label': `${pm.name}: ${n} pins. Arrow keys walk the ring, Space or Enter adds or removes a pin.` });
    svg.append(sv('rect', { x: x0, y: y0, width: bw, height: bh, rx: 10, class: 'gw-body' }));
    svg.append(sv('circle', { cx: x0 + 14, cy: y0 + 14, r: 4.5, class: 'gw-dot' }));
    // sides: left (down), bottom (right), right (up), top (left)
    const sides = [
      { cnt: nv, at: (i, c) => ({ x: x0, y: y0 + (bh * (i + 1)) / (c + 1), dx: -1, dy: 0 }) },
      { cnt: nh, at: (i, c) => ({ x: x0 + (bw * (i + 1)) / (c + 1), y: y0 + bh, dx: 0, dy: 1 }) },
      { cnt: nv, at: (i, c) => ({ x: x0 + bw, y: y0 + bh - (bh * (i + 1)) / (c + 1), dx: 1, dy: 0 }) },
      { cnt: n - 2 * nv - nh, at: (i, c) => ({ x: x0 + bw - (bw * (i + 1)) / (c + 1), y: y0, dx: 0, dy: -1 }) },
    ];
    const pos = [];
    for (const s of sides) for (let i = 0; i < s.cnt; i++) pos.push(s.at(i, s.cnt));
    const pitchV = bh / (nv + 1), pitchH = bw / (nh + 1);
    const nodes = [];
    const short = (p) => (pm.prefix && typeof p.pin === 'number' ? String(p.pin) : p.label);
    const fontPx = g.narrow ? 10 : 12;
    pins.forEach((p, i) => {
      const q = pos[i];
      const horiz = q.dx !== 0; // pad sticks out left/right
      const pw = Math.min(horiz ? pitchV : pitchH, 22) * 0.62;
      const gx = sv('g', { class: `gw-pin gw-sev${p.sev}${p.used ? ' is-used' : ''}${key(p.pin) === st.sel ? ' is-sel' : ''}`,
        tabindex: key(p.pin) === (st.focus ?? st.sel ?? key(pins[0].pin)) ? '0' : '-1', role: 'button', 'aria-pressed': String(p.used),
        'aria-label': `${p.label}, ${SEVN[p.sev]}${p.rows.length ? ': ' + p.rows.map((r) => pm.rows[r].kind).join(', ') : ''}${p.used ? ', in your design' : ''}`,
        'data-i': i });
      const px = horiz ? (q.dx < 0 ? q.x - pad : q.x) : q.x - pw / 2;
      const py = horiz ? q.y - pw / 2 : (q.dy < 0 ? q.y - pad : q.y);
      gx.append(sv('rect', { x: px, y: py, width: horiz ? pad : pw, height: horiz ? pw : pad, rx: 1.5, class: 'gw-pad' }));
      // label outside the pad; a claimed pin's label is a net tag
      const lx = q.x + q.dx * (pad + 5), ly = q.y + q.dy * (pad + 5);
      const t = short(p);
      const tw = t.length * fontPx * 0.62 + 10;
      const tag = sv('g', { class: 'gw-tag' });
      if (horiz) {
        const rx = q.dx < 0 ? lx - tw : lx;
        tag.append(sv('rect', { x: rx, y: q.y - fontPx * 0.85, width: tw, height: fontPx * 1.7, rx: 3, class: 'gw-tagbg' }));
        tag.append(sv('text', { x: rx + tw / 2, y: q.y + fontPx * 0.36, 'text-anchor': 'middle', class: 'gw-lab', style: `font-size:${fontPx}px` }, t));
      } else {
        const ry = q.dy < 0 ? ly - tw : ly;
        tag.append(sv('rect', { x: q.x - fontPx * 0.85, y: ry, width: fontPx * 1.7, height: tw, rx: 3, class: 'gw-tagbg' }));
        tag.append(sv('text', { x: q.x + fontPx * 0.36, y: ry + tw / 2, 'text-anchor': 'middle', class: 'gw-lab', style: `font-size:${fontPx}px`,
          transform: `rotate(-90 ${q.x + fontPx * 0.36} ${ry + tw / 2})` }, t));
      }
      gx.append(tag);
      // a claimed pin with a real risk: a warning mark on the body side of the pad
      if (p.used && p.sev >= 2) {
        const mx = q.x - q.dx * 11, my = q.y - q.dy * 11;
        gx.append(sv('path', { d: `M${mx},${my - 6}l6,10.5h-12z`, class: `gw-warnmark gw-wm${p.sev}` }));
        gx.append(sv('text', { x: mx, y: my + 3.5, 'text-anchor': 'middle', class: 'gw-wmt' }, '!'));
      }
      gx.append(sv('title', {}, `${p.label}${p.rows.length ? ' - ' + p.rows.map((r) => `${pm.rows[r].kind} (${pm.rows[r].severity})`).join(', ') : ' - no restriction'}. Click to ${p.used ? 'remove from' : 'add to'} your pins.`));
      gx.addEventListener('click', () => { st.focus = key(p.pin); toggle(p.pin); });
      gx.addEventListener('pointerenter', () => showInsp(p));
      gx.addEventListener('pointerleave', () => showInsp(null));
      gx.addEventListener('focus', () => { st.focus = key(p.pin); st.sel = key(p.pin); markSel(); showInsp(null); });
      nodes.push(gx);
      svg.append(gx);
    });
    // chip name on the body
    if (bw >= 250) svg.append(sv('text', { x: x0 + 26, y: y0 + 19, class: 'gw-chipname' }, pm.name));
    svg.addEventListener('keydown', (e) => {
      const gx = e.target.closest?.('.gw-pin');
      if (!gx) return;
      const i = Number(gx.dataset.i);
      let j = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = (i + 1) % n;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = (i - 1 + n) % n;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = n - 1;
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); st.focus = key(pins[i].pin); toggle(pins[i].pin); return; }
      if (j == null) return;
      e.preventDefault();
      nodes[i].setAttribute('tabindex', '-1');
      nodes[j].setAttribute('tabindex', '0');
      st.focus = key(pins[j].pin);
      nodes[j].focus();
    });
    const had = svgWrap.contains(document.activeElement);
    svgWrap.replaceChildren(svg);
    st.nodes = nodes;
    // the inspector sits inside the chip body when there is room, else under it
    const inside = bw >= 250 && bh >= 200;
    stage.classList.toggle('gw-inside', inside);
    if (inside) Object.assign(insp.style, { left: `${x0 + 16}px`, top: `${y0 + 30}px`, width: `${bw - 32}px`, height: `${bh - 46}px` });
    else Object.assign(insp.style, { left: '', top: '', width: '', height: '' });
    if (had && st.focus != null) {
      const k = pins.findIndex((p) => key(p.pin) === st.focus);
      if (k >= 0) nodes[k].focus();
    }
  }

  function markSel() {
    const pm = st.res?.pinmap;
    if (!pm || !st.nodes) return;
    pm.pins.forEach((p, i) => st.nodes[i].classList.toggle('is-sel', key(p.pin) === st.sel));
  }

  // which pin the inspector explains: the hovered one, else the selected one,
  // else the worst pin in your design
  function showInsp(hover) {
    const pm = st.res?.pinmap;
    if (!pm) return;
    let p = hover || pm.pins.find((x) => key(x.pin) === st.sel);
    if (!p) p = pm.pins.filter((x) => x.used).sort((a, b) => b.sev - a.sev)[0] || pm.pins.slice().sort((a, b) => b.sev - a.sev)[0];
    if (!p) { put(insp); return; }
    const rows = p.rows.map((r) => pm.rows[r]).sort((a, b) => b.sev - a.sev);
    const off = p.off.map((r) => pm.rows[r]);
    put(insp, 
      h('div', { class: 'gw-ihead' },
        h('b', { class: 'gw-iname' }, p.label),
        h('span', { class: `gw-badge gw-sev${p.sev}` }, SEVN[p.sev]),
        h('button', { class: `k-btn gw-ibtn${p.used ? '' : ' k-primary'}`, type: 'button', onclick: () => toggle(p.pin) },
          p.used ? 'Remove from my pins' : 'Use this pin')),
      rows.length ? null : h('div', { class: 'gw-ifree' }, `No restriction listed for ${p.label} on the ${pm.name}: a plain GPIO.`),
      ...rows.map((r) => h('div', { class: `gw-irow gw-b${r.sev}` },
        h('div', { class: 'gw-ikind' }, h('span', { class: `gw-badge gw-sev${r.sev}` }, r.severity), ' ', r.kind),
        h('div', { class: 'gw-irisk' }, r.risk),
        h('div', { class: 'gw-ifix' }, h('b', {}, 'Do: '), r.fix))),
      ...off.map((r) => h('div', { class: 'gw-irow gw-ioff' },
        h('div', { class: 'gw-ikind' }, `${r.kind}: only with “${CONDS[r.cond]?.[0] || r.cond}” on`),
        h('div', { class: 'gw-irisk' }, r.risk))));
  }

  function drawSide(res) {
    const pm = res.pinmap, raw = ctx.raw;
    if (document.activeElement !== pinsIn && pinsIn.value !== String(raw.pins ?? '')) pinsIn.value = String(raw.pins ?? '');
    for (const b of showSel.children) b.setAttribute('aria-pressed', String(b.dataset.v === (raw.show || 'all')));
    const v = (label) => res.values?.find((x) => x.label === label);
    const c = (label, cls, sub) => {
      const x = v(label);
      return h('div', { class: `gw-count ${cls}${x && Number(x.value) === 0 ? ' is-zero' : ''}` }, h('b', {}, x ? String(x.value) : '–'), h('span', {}, sub));
    };
    put(counts, c('Boot/flash risks', 'gw-c3', 'boot / flash risks'), c('Limits to design for', 'gw-c2', 'limits to design for'),
      c('Unrestricted', 'gw-c0', 'unrestricted'));
    put(unknownBox, ...(pm && pm.unknown.length ? [h('div', { class: 'gw-warnline' }, `Not a pin on the ${pm.name}: ${pm.unknown.join(', ')}`)] : []));
    if (!pm) { put(list); return; }
    const used = pm.pins.filter((p) => p.used).sort((a, b) => b.sev - a.sev);
    const risky = used.filter((p) => p.sev > 0), clean = used.filter((p) => p.sev === 0);
    put(list, 
      ...risky.map((p) => {
        const top = pm.rows[p.rows.slice().sort((a, b) => pm.rows[b].sev - pm.rows[a].sev)[0]];
        return h('button', { class: `gw-item gw-b${p.sev}${key(p.pin) === st.sel ? ' is-sel' : ''}`, type: 'button', role: 'listitem',
          onclick: () => { st.sel = key(p.pin); st.focus = key(p.pin); markSel(); showInsp(null); drawSide(st.res); } },
        h('span', { class: 'gw-itemhead' }, h('b', {}, p.label), h('span', { class: `gw-badge gw-sev${p.sev}` }, SEVN[p.sev]),
          h('span', { class: 'gw-soft' }, p.rows.map((r) => pm.rows[r].kind).join(', '))),
        h('span', { class: 'gw-itemfix' }, top.fix));
      }),
      clean.length ? h('div', { class: 'gw-clean' }, h('span', { class: 'gw-badge gw-sev0' }, 'free'), ' ', clean.map((p) => p.label).join(', ')) : null,
      used.length ? null : h('div', { class: 'gw-soft gw-small' }, 'No pins yet: click pins on the chip, or type them above.'));
  }

  function drawTop(res) {
    const raw = ctx.raw, pm = res.pinmap;
    for (const b of chipBtns) b.setAttribute('aria-pressed', String(b.dataset.k === (pm?.chip || raw.chip)));
    const conds = pm ? pm.conds : [];
    put(condWrap, ...(conds.length ? conds : []).map((k) => h('label', { class: `gw-cond${raw[k] ? ' is-on' : ''}` },
      h('input', { type: 'checkbox', checked: !!raw[k], onchange: (e) => ctx.set(k, e.target.checked) }),
      h('span', {}, h('b', {}, CONDS[k][0]), h('small', {}, CONDS[k][1])))),
    conds.length ? null : h('span', { class: 'gw-soft gw-small' }, 'No conditional limits on this chip.'));
  }

  function render() {
    const res = st.res;
    if (!res) return;
    drawTop(res);
    drawSide(res);
    notes.replaceChildren(...(res.notes || []).map((n) => h('div', {}, n)));
    const pm = res.pinmap;
    if (!pm) return;
    pkgTitle.textContent = `${pm.name} · ${pm.pins.length} pins`;
    if (st.sel != null && !pm.pins.some((p) => key(p.pin) === st.sel)) st.sel = null;
    draw();
    showInsp(null);
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
