// Flash & EEPROM Wear page: the sector map wearing out over time is the interface.
//   Map       one cell per erase unit of the area, coloured by the cycles it has
//             used at the timeline cursor. Dotted slots after the area: click one
//             (or drag the end handle, or arrows on it) to grow or shrink the area.
//   Timeline  0 to past the wear-out: drag the cursor (arrows, Home/End) to watch
//             the sectors wear; wear-out and target are marked.
//   Scheme    the five levelling schemes as a strip; the parameters beside.
// Numbers come from run()'s result (values, map, texts, tables); the cursor time is
// page state only.

const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sig = (v, d = 3) => String(Number(Number(v).toPrecision(d)));
const YEAR = 365.25 * 86400;
function dur(s) {
  if (!Number.isFinite(s)) return 'forever';
  if (s >= YEAR) return `${sig(s / YEAR)} y`;
  if (s >= 86400) return `${sig(s / 86400)} d`;
  if (s >= 3600) return `${sig(s / 3600)} h`;
  return `${sig(s)} s`;
}
const kib = (b) => (b >= 1048576 ? `${sig(b / 1048576, 4)} MiB` : b >= 1024 ? `${sig(b / 1024, 4)} KiB` : `${b} B`);
const SCHEMES = [
  ['none', 'In place', 'one sector takes every erase'],
  ['circular', 'Circular log', 'append, erase on wrap'],
  ['eeprom', 'EEPROM emulation', 'pages rotate, live vars copied'],
  ['littlefs', 'littlefs', 'dynamic: free blocks only'],
  ['ftl', 'Device FTL', 'static: every block'],
];
const TECH_DEF = { mcu: 2048, mcueeprom: 4, eeprom: 32, nor: 4096, slc: 131072, mlc: 1048576, emmc: 524288 };

export function page(root, ctx) {
  let res = null;
  const st = { frac: 0.6, drag: false }; // cursor as a fraction of the wear-out time

  const readout = h('div', { class: 'fw-read' });
  const warnBox = h('div', { class: 'fw-warns', 'aria-live': 'polite' });
  const strip = h('div', { class: 'fw-strip', role: 'radiogroup', 'aria-label': 'Wear levelling scheme' },
    SCHEMES.map(([v, t, d]) => h('button', { role: 'radio', 'data-v': v, onclick: () => ctx.set('scheme', v) }, h('b', {}, t), h('span', {}, d))));
  const mapBox = h('div', { class: 'fw-map', role: 'group', 'aria-label': 'Sectors of the area' });
  const legend = h('div', { class: 'fw-legend' });
  const mapSub = h('span', { class: 'fw-sub' });
  const tl = sv('svg', { class: 'fw-tl', viewBox: '0 0 900 150', role: 'img', 'aria-label': 'Timeline' });
  const tlCard = h('section', { class: 'fw-card' }, h('div', { class: 'fw-head' }, h('h2', {}, 'Timeline'), h('span', { class: 'fw-sub', id: 'fw-tlsub' })),
    h('div', { class: 'fw-tlwrap' }, tl));
  const formula = h('pre', { class: 'fw-formula' });
  const sens = h('div', { class: 'fw-sens' });
  const noteBox = h('div', { class: 'fw-notes' });

  const field = (key, label, unit, extra) => {
    const inp = h('input', { class: 'fw-in', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'data-key': key, 'aria-label': label,
      onchange: (e) => ctx.set(key, e.target.value) });
    return h('label', { class: 'fw-field', 'data-for': key }, h('span', {}, label), h('div', { class: 'fw-inrow' }, inp, unit ? h('small', {}, unit) : null, extra));
  };
  const scaleBtns = (key) => h('span', { class: 'fw-x2' },
    h('button', { class: 'k-btn', title: 'halve', onclick: (e) => { e.preventDefault(); ctx.set(key, String(sig((ctx.input[key] || 0) / 2, 6))); } }, '/2'),
    h('button', { class: 'k-btn', title: 'double', onclick: (e) => { e.preventDefault(); ctx.set(key, String(sig((ctx.input[key] || 0) * 2, 6))); } }, 'x2'));
  const techSel = h('select', { class: 'fw-in', 'aria-label': 'Technology',
    onchange: (e) => ctx.setMany({ tech: e.target.value, endurance: '', eraseSize: String(TECH_DEF[e.target.value] || 2048) }) },
    ctx.manifest.inputs[0].options.map(([v, t]) => h('option', { value: v }, t)));
  const intervalChips = h('div', { class: 'fw-chips' }, [['1 s', '1'], ['10 s', '10'], ['1 min', '60'], ['1 h', '3600'], ['1 day', '86400']]
    .map(([t, v]) => h('button', { class: 'fw-chip', 'data-v': v, onclick: () => ctx.set('interval', v) }, t)));
  const params = h('section', { class: 'fw-card' }, h('div', { class: 'fw-head' }, h('h2', {}, 'Storage and writes')),
    h('div', { class: 'fw-body' },
      h('label', { class: 'fw-field' }, h('span', {}, 'Technology'), techSel),
      h('div', { class: 'fw-g2' }, field('endurance', 'Erase cycles', ''), field('eraseSize', 'Erase unit', 'B')),
      h('div', { class: 'fw-g2' }, field('areaSize', 'Area', 'B', scaleBtns('areaSize')), field('recordSize', 'Bytes per write', 'B')),
      field('interval', 'Write interval', 's', scaleBtns('interval')), intervalChips,
      h('div', { class: 'fw-g2' }, field('variables', 'Live variables', ''), field('fill', 'Static data', '%')),
      h('div', { class: 'fw-g2' }, field('wa', 'Write amplification', 'x'), field('target', 'Target', 'years'))));

  root.append(h('div', { class: 'fw' },
    h('div', { class: 'fw-main' }, readout, warnBox, strip,
      h('section', { class: 'fw-card' }, h('div', { class: 'fw-head' }, h('h2', {}, 'Sectors'), mapSub), mapBox, legend),
      tlCard,
      h('div', { class: 'fw-row2' },
        h('section', { class: 'fw-card' }, h('div', { class: 'fw-head' }, h('h2', {}, 'Formula')), formula),
        h('section', { class: 'fw-card' }, h('div', { class: 'fw-head' }, h('h2', {}, 'What changes buy')), sens)),
      noteBox),
    h('div', { class: 'fw-side' }, params, ctx.outputs)));

  // ---------- sector map ----------
  const setSectors = (n) => { const m = res.map; ctx.set('areaSize', String(Math.max(1, n) * m.S)); };
  function drawMap() {
    const m = res.map;
    const tCur = st.frac * m.lifeSec;
    const used = clamp(st.frac, 0, 1); // fraction of endurance on a wearing sector
    const cycles = Math.round(used * m.E);
    const cells = m.cells;
    const slots = m.group === 1 ? Math.min(160, Math.max(16, Math.ceil(cells.length * 1.5), cells.length + 4)) : cells.length;
    mapBox.replaceChildren();
    mapBox.style.setProperty('--cell', cells.length > 96 ? '22px' : cells.length > 40 ? '30px' : '46px');
    for (let i = 0; i < slots; i++) {
      if (i < cells.length) {
        const kind = cells[i];
        const wear = kind === 'rot' || kind === 'hot' ? used : 0;
        const pct = Math.round(wear * 100);
        const c = h('button', { class: `fw-cell k-${kind} tier${wear < 0.6 ? 0 : wear < 0.9 ? 1 : 2}${wear >= 1 ? ' dead' : ''}`, 'data-i': String(i),
          style: `--w:${pct}%`, title: `${m.group > 1 ? `sectors ${i * m.group}-${(i + 1) * m.group - 1}` : `sector ${i}`} (${kib(m.S * m.group)}): ${kind === 'rot' || kind === 'hot' ? `${wear >= 1 ? m.E : cycles} of ${m.E} cycles` : kind === 'static' ? 'static data - not levelled' : 'never erased'}${m.group === 1 ? ' - click to end the area here' : ''}`,
          onclick: () => { if (m.group === 1) setSectors(i + 1); } },
          h('i', {}), h('span', {}, kind === 'static' ? 'S' : kind === 'idle' ? '0' : `${Math.min(100, pct)}`));
        mapBox.append(c);
        if (i === cells.length - 1 && m.group === 1) {
          const hd = h('div', { class: 'fw-end', tabindex: '0', role: 'slider', 'aria-label': 'Area size in sectors', 'aria-valuenow': String(cells.length),
            title: 'Drag to resize the area; arrows add or remove a sector',
            onkeydown: (e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); st.focusEnd = true; setSectors(cells.length + 1); }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); st.focusEnd = true; setSectors(cells.length - 1); }
            },
            onpointerdown: (e) => { e.preventDefault(); mapBox.setPointerCapture(e.pointerId); st.resize = true; } });
          mapBox.append(hd);
        }
      } else {
        mapBox.append(h('button', { class: 'fw-cell k-ghost', 'aria-label': `grow the area to ${i + 1} sectors`, title: `grow the area to ${i + 1} sectors (${kib((i + 1) * m.S)})`,
          onclick: () => setSectors(i + 1) }));
      }
    }
    mapSub.textContent = `${m.N} x ${kib(m.S)} = ${kib(m.N * m.S)}${m.group > 1 ? ` · one cell = ${m.group} sectors` : ''} · at ${dur(tCur)}: ${used >= 1 ? 'worn out' : `${cycles} of ${m.E} cycles on each wearing sector`}`;
    legend.replaceChildren(
      h('span', {}, h('i', { class: 'lg rot' }), 'wearing'), h('span', {}, h('i', { class: 'lg worn' }), 'past endurance'),
      h('span', {}, h('i', { class: 'lg idle' }), 'never erased'), h('span', {}, h('i', { class: 'lg static' }), 'static data'),
      m.group === 1 ? h('span', { class: 'fw-hint' }, 'click a dotted slot or drag the end bar to resize the area') : null);
    if (st.focusEnd) { st.focusEnd = false; mapBox.querySelector('.fw-end')?.focus(); }
  }
  mapBox.addEventListener('pointermove', (e) => {
    if (!st.resize) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.fw-cell');
    if (!el) return;
    const idx = [...mapBox.querySelectorAll('.fw-cell')].indexOf(el);
    if (idx >= 0 && idx + 1 !== res.map.N) setSectors(idx + 1);
  });
  const endResize = () => { st.resize = false; };
  mapBox.addEventListener('pointerup', endResize); mapBox.addEventListener('pointercancel', endResize);

  // ---------- timeline ----------
  const L = 50, R = 880, Y0 = 108, Y1 = 22;
  let tMax = 1;
  const X = (t) => L + (t / tMax) * (R - L);
  function drawTimeline() {
    const m = res.map;
    tl.replaceChildren();
    tMax = Math.max(m.lifeSec, m.targetSec || 0) * 1.15 || 1;
    const unit = tMax >= 2 * YEAR ? YEAR : tMax >= 2 * 86400 ? 86400 : 3600;
    const uName = unit === YEAR ? 'y' : unit === 86400 ? 'd' : 'h';
    const niceStep = (span) => { const raw = span / 8; const p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw); };
    const step = niceStep(tMax / unit);
    for (let v = 0; v * unit <= tMax; v += step) {
      tl.append(sv('line', { x1: X(v * unit), x2: X(v * unit), y1: Y1, y2: Y0, class: 'g' }));
      tl.append(sv('text', { x: X(v * unit), y: Y0 + 16, class: 'ax', 'text-anchor': 'middle' }, `${sig(v, 4)} ${uName}`));
    }
    // cycles used on the busiest sector
    tl.append(sv('line', { x1: L, x2: R, y1: Y1, y2: Y1, class: 'lim' }));
    tl.append(sv('text', { x: L - 6, y: Y1 + 4, class: 'ax', 'text-anchor': 'end' }, sig(m.E, 3)));
    tl.append(sv('text', { x: L - 6, y: Y0 + 4, class: 'ax', 'text-anchor': 'end' }, '0'));
    tl.append(sv('path', { d: `M${X(0)},${Y0} L${X(m.lifeSec)},${Y1} L${R},${Y1}`, class: 'curve' }));
    tl.append(sv('text', { x: L + 4, y: Y1 - 6, class: 'ax' }, 'erase cycles on the busiest sector'));
    const xl = X(m.lifeSec);
    tl.append(sv('line', { x1: xl, x2: xl, y1: Y1 - 8, y2: Y0, class: 'life' }));
    tl.append(sv('text', { x: xl, y: 142, class: 'lifet', 'text-anchor': 'middle' }, `wear-out ${dur(m.lifeSec)}`));
    if (m.targetSec > 0) {
      const xt = X(m.targetSec);
      tl.append(sv('line', { x1: xt, x2: xt, y1: Y1 - 8, y2: Y0, class: 'tgt' }));
      tl.append(sv('text', { x: xt, y: 142, class: 'tgtt', 'text-anchor': Math.abs(xt - xl) < 90 ? (xt < xl ? 'end' : 'start') : 'middle' }, `target ${dur(m.targetSec)}`));
    }
    // cursor
    const tc = clamp(st.frac * m.lifeSec, 0, tMax);
    const xc = X(tc);
    const cur = sv('g', { class: 'cur', tabindex: '0', role: 'slider', 'aria-label': 'Time cursor. Arrows move, Home and End jump',
      'aria-valuetext': dur(tc) });
    cur.append(sv('rect', { x: xc - 12, y: Y1 - 14, width: 24, height: Y0 - Y1 + 22, class: 'hit' }),
      sv('line', { x1: xc, x2: xc, y1: Y1 - 10, y2: Y0 + 2 }),
      sv('circle', { cx: xc, cy: Y0 - clamp(st.frac, 0, 1) * (Y0 - Y1), r: 6 }));
    tl.append(cur);
    cur.addEventListener('pointerdown', (e) => { e.preventDefault(); tl.setPointerCapture(e.pointerId); st.drag = true; cur.focus(); });
    cur.addEventListener('keydown', (e) => {
      const d = tMax / m.lifeSec / 50;
      let f = st.frac;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') f += d;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') f -= d;
      else if (e.key === 'Home') f = 0;
      else if (e.key === 'End') f = 1;
      else return;
      e.preventDefault();
      st.frac = clamp(f, 0, tMax / m.lifeSec); st.focusCur = true; redraw();
    });
    root.querySelector('#fw-tlsub').textContent = `cursor at ${dur(tc)} - drag it to watch the sectors wear`;
    if (st.focusCur) { st.focusCur = false; cur.focus(); }
  }
  tl.addEventListener('pointermove', (e) => {
    if (!st.drag) return;
    const p = tl.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const x = p.matrixTransform(tl.getScreenCTM().inverse()).x;
    st.frac = clamp(((x - L) / (R - L)) * tMax / res.map.lifeSec, 0, tMax / res.map.lifeSec);
    redraw();
  });
  const endDrag = () => { st.drag = false; };
  tl.addEventListener('pointerup', endDrag); tl.addEventListener('pointercancel', endDrag);

  function redraw() { if (res?.map) { drawMap(); drawTimeline(); } }

  function draw() {
    if (!res) return;
    const raw = ctx.raw;
    techSel.value = raw.tech;
    for (const inp of root.querySelectorAll('input.fw-in')) if (document.activeElement !== inp) inp.value = raw[inp.dataset.key] ?? '';
    for (const b of strip.children) b.setAttribute('aria-checked', String(raw.scheme === b.dataset.v));
    for (const c of intervalChips.children) c.setAttribute('aria-pressed', String(String(raw.interval) === c.dataset.v));
    root.querySelector('[data-for="variables"]').hidden = raw.scheme !== 'eeprom';
    root.querySelector('[data-for="fill"]').hidden = raw.scheme !== 'littlefs';
    readout.replaceChildren(...(res.values || []).map((v, i) => h('div', { class: `fw-v${i === 0 ? ' big' : ''}${v.tone ? ` t-${v.tone}` : ''}` },
      h('span', {}, v.label), h('b', {}, String(v.value)), v.hint ? h('em', {}, v.hint) : null)));
    warnBox.replaceChildren(...(res.warnings || []).map((x) => h('div', {}, x)));
    noteBox.replaceChildren(...(res.notes || []).map((x) => h('div', {}, x)));
    formula.textContent = res.texts?.[0]?.body || '';
    const t = res.tables?.[0];
    sens.replaceChildren(...(t ? t.rows.map((r) => {
      const k = parseFloat(String(r[2]));
      return h('div', { class: 'fw-srow' }, h('span', {}, r[0]), h('b', {}, r[1]),
        h('span', { class: `fw-bar${k >= 1 ? ' up' : ' down'}` }, h('i', { style: `width:${clamp(Math.log2(k || 1e-9) / 4 * 50, -50, 50) >= 0 ? clamp(Math.log2(k) / 4 * 50, 0, 50) : clamp(-Math.log2(k) / 4 * 50, 0, 50)}%` })),
        h('em', {}, r[2]));
    }) : []));
    if (!res.map) { mapBox.replaceChildren(); tl.replaceChildren(); return; }
    redraw();
  }
  ctx.onResult((r) => { res = r; draw(); });
}
