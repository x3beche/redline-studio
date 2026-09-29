// MPU Region Planner, drawn as the memory map: one lane per memory area of
// the part (each to its own scale), every MPU region that touches it as a
// band on its own row - highest region number on top, as it wins on
// Armv7-M - and under them the "effective" strip: which region's rules apply
// at each address, where the default map applies, and where accesses fault.
//   Drag a band to move the region (it snaps to its alignment); click one of
//   its 8 subregion cells to disable/enable it; click a band to edit it on
//   the right. Focused band: arrows move/resize, Del removes.
// Every address, size and winner comes from run()'s result (result.view).

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
const tip = (el, text) => { el.append(s('title', {}, text)); return el; };
const hex8 = (v) => '0x' + Math.round(v).toString(16).toUpperCase().padStart(8, '0');
const sizeName = (b) => (b >= 1073741824 && b % 1073741824 === 0 ? `${b / 1073741824} GB` : b >= 1048576 && b % 1048576 === 0 ? `${b / 1048576} MB` : b >= 1024 && b % 1024 === 0 ? `${b / 1024} KB` : `${b} B`);
const sizeText = (b) => (b >= 1073741824 && b % 1073741824 === 0 ? `${b / 1073741824}G` : b >= 1048576 && b % 1048576 === 0 ? `${b / 1048576}M` : b >= 1024 && b % 1024 === 0 ? `${b / 1024}K` : String(b));
const COL = (n) => `var(--tool-r${n % 8})`;
const AP_LIST = [['none', 'None'], ['priv-rw', 'P:RW'], ['priv-rw-user-ro', 'P:RW U:RO'], ['rw', 'RW'], ['priv-ro', 'P:RO'], ['ro', 'RO']];
const AP_SHORT = { none: 'no access', 'priv-rw': 'P:RW', 'priv-rw-user-ro': 'P:RW U:RO', rw: 'RW', 'priv-ro': 'P:RO', ro: 'RO' };
const TYPE_LIST = [['normal-wbwa', 'Normal WB-WA'], ['normal-wb', 'Normal WB'], ['normal-wt', 'Normal WT'], ['normal-nc', 'Normal non-cacheable'], ['device', 'Device'], ['strongly-ordered', 'Strongly-ordered']];
const TYPE_SHORT = Object.fromEntries(TYPE_LIST);
const DEVS = [['stm32f407', 'F407 · M4'], ['stm32h743', 'H743 · M7'], ['stm32l552', 'L552 · M33'], ['custom', 'Custom']];

export function page(root, ctx) {
  const wrap = h('div', { class: 'mp' });
  root.append(wrap);
  let V = null, res = null, sel = 0, focusId = null, wantFocus = false, dragging = false;

  const rowsRaw = () => (ctx.raw.regions || []).map((r) => ({ ...r }));
  const setRow = (i, patch) => { const rows = rowsRaw(); if (!rows[i]) return; Object.assign(rows[i], patch); ctx.set('regions', rows); };
  const regOf = (i) => V && V.regions.find((r) => r.n === i);

  // ---------- toolbar ----------
  const devSeg = h('div', { class: 'mp-seg', role: 'radiogroup', 'aria-label': 'Part' });
  const devBtns = DEVS.map(([id, label]) => { const b = h('button', { type: 'button', role: 'radio', 'data-dev': id, onclick: () => ctx.set('device', id) }, label); devSeg.append(b); return b; });
  const privBox = h('input', { type: 'checkbox', onchange: (e) => ctx.set('privdefena', e.target.checked) });
  const hfBox = h('input', { type: 'checkbox', onchange: (e) => ctx.set('hfnmiena', e.target.checked) });
  const loadBtn = h('button', { class: 'k-btn', type: 'button', title: 'Replace the regions with a typical set for this part', onclick: () => {
    const p = V && V.presets[V.device]; if (p) { sel = 0; ctx.set('regions', p.map((r) => ({ ...r }))); }
  } }, 'Typical regions');
  const addBtn = h('button', { class: 'k-btn', type: 'button', onclick: () => {
    const rows = rowsRaw();
    const ram = V && V.areas.find((a) => a.kind === 'ram');
    rows.push({ name: `Region ${rows.length}`, base: hex8(ram ? ram.base : 0x20000000), size: '1K', ap: 'rw', xn: 'yes', type: 'normal-wbwa', s: 'no', srd: V && V.v8 ? '' : '0x00', en: 'yes' });
    sel = rows.length - 1; ctx.set('regions', rows);
  } }, '+ Region');
  const archSub = h('span', { class: 'mp-sub' });
  const bar = h('div', { class: 'mp-bar' }, devSeg, archSub,
    h('label', { class: 'chk', title: 'MPU_CTRL.PRIVDEFENA: privileged code uses the default map where no region applies' }, privBox, 'PRIVDEFENA'),
    h('label', { class: 'chk', title: 'MPU_CTRL.HFNMIENA: keep the MPU on in HardFault and NMI' }, hfBox, 'HFNMIENA'),
    h('span', { class: 'mp-right' }, loadBtn, addBtn));

  const svg = s('svg', { class: 'mp-svg', role: 'group', 'aria-label': 'Memory map with MPU regions' });
  const legend = h('div', { class: 'mp-legend' },
    h('span', {}, h('i', { class: 'lg-def' }), 'default map (privileged only)'),
    h('span', {}, h('i', { class: 'lg-fault' }), 'faults'),
    h('span', {}, h('i', { class: 'lg-sub' }), 'subregion disabled'),
    h('span', {}, h('i', { class: 'lg-xn' }), 'XN (no execute)'));
  const mapCard = h('section', { class: 'mp-card' },
    h('div', { class: 'mp-head' }, h('h2', {}, 'Memory map'), h('span', { class: 'mp-sub', id: 'mp-mapsub' })),
    bar, svg, legend,
    h('div', { class: 'mp-help' }, 'Drag a region band to move it (snaps to its alignment); click a subregion cell to switch it off; click a band to edit it. Focused band: ',
      h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' move, ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' size, ', h('kbd', {}, 'Del'), ' remove.'));

  // ---------- region list ----------
  const list = h('div', { class: 'mp-list', role: 'listbox', 'aria-label': 'Regions' });
  const listCard = h('section', { class: 'mp-card' }, h('div', { class: 'mp-head' }, h('h2', {}, 'Regions'), h('span', { class: 'mp-sub', id: 'mp-listsub' })), list);

  // ---------- editor ----------
  const ed = h('div', { class: 'mp-ed' });
  const edTitle = h('h2', {});
  const edCard = h('section', { class: 'mp-card' }, h('div', { class: 'mp-head' }, edTitle), ed);
  const areasEd = h('div', { class: 'mp-areas' });
  const areasCard = h('section', { class: 'mp-card', hidden: true }, h('div', { class: 'mp-head' }, h('h2', {}, 'Custom part')), areasEd);

  const warns = h('div', { class: 'mp-warns', role: 'status' });
  const notes = h('details', { class: 'mp-notes' }, h('summary', {}, 'Notes'));
  wrap.append(h('div', { class: 'mp-main' }, warns, mapCard, listCard, notes), h('div', { class: 'mp-side' }, edCard, areasCard, ctx.outputs));

  // ================= the map =================
  function draw() {
    const had = svg.contains(document.activeElement);
    svg.replaceChildren();
    const W = Math.max(300, (mapCard.clientWidth || 900) - 2);
    const narrow = W < 620;
    const LW = narrow ? 92 : 150, R = 12, X0 = LW, X1 = W - R;
    const rowH = 22, effH = 22, headH = 22, gap = 12;
    const defs = s('defs');
    const hatch = (id, cls) => { const p = s('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }); p.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: cls })); defs.append(p); };
    hatch('mp-h-fault', 'hp-fault'); hatch('mp-h-sub', 'hp-sub'); hatch('mp-h-def', 'hp-def');
    svg.append(defs);
    let y = 6;
    const regs = V.regions.filter((r) => !r.bad && !r.over);
    for (const a of V.areas) {
      const aEnd = a.base + a.size;
      const X = (addr) => X0 + ((Math.min(Math.max(addr, a.base), aEnd) - a.base) / a.size) * (X1 - X0);
      const touching = regs.filter((r) => r.base < aEnd && r.end > a.base).sort((p, q) => q.n - p.n);
      // header
      svg.append(s('text', { x: 6, y: y + 14, class: 'mp-an' }, a.name));
      svg.append(s('text', { x: X0, y: y + 14, class: 'mp-ax' }, hex8(a.base)));
      svg.append(s('text', { x: X1, y: y + 14, class: 'mp-ax', 'text-anchor': 'end' }, `${hex8(aEnd - 1)} · ${sizeName(a.size)}`));
      if (!narrow) svg.append(s('text', { x: (X0 + X1) / 2, y: y + 14, class: 'mp-ax soft', 'text-anchor': 'middle' }, a.kind === 'periph' ? 'peripherals' : a.kind === 'ext' ? 'external memory' : a.kind));
      y += headH;
      const top = y;
      svg.append(s('rect', { x: X0, y: top, width: X1 - X0, height: touching.length * rowH + effH + 4, class: 'mp-lane' }));
      for (const r of touching) {
        const bx = X(r.base), bw = Math.max(5, X(r.end) - bx);
        const yy = y + 2, hh = rowH - 4;
        const id = `r-${r.n}`;
        svg.append(s('text', { x: 6, y: yy + hh / 2 + 4, class: `mp-rl ${r.enabled ? '' : 'soft'}` }, `R${r.n} ${narrow ? '' : r.name}`.slice(0, narrow ? 12 : 22)));
        const g = s('g', { class: `mp-band ${sel === r.n ? 'sel' : ''} ${r.enabled ? '' : 'off'} ${r.problems.length || r.issues.length ? 'warn' : ''}`, tabindex: 0, role: 'button',
          'aria-label': `R${r.n} ${r.name}, ${hex8(r.base)}, ${sizeName(r.size)}, ${AP_SHORT[r.ap]}${r.xn ? ', XN' : ''}` });
        g.setAttribute('data-id', `${id}-${a.name}`);
        g.style.setProperty('--c', COL(r.n));
        tip(g.appendChild(s('rect', { x: bx, y: yy, width: bw, height: hh, rx: 2, class: 'body ring' })),
          `R${r.n} ${r.name}\n${hex8(r.base)} - ${hex8(r.end - 1)} (${sizeName(r.size)})\n${AP_SHORT[r.ap]}${r.xn ? ', XN' : ', executable'}, ${TYPE_SHORT[r.type]}${r.s ? ', shareable' : ''}${r.srd ? `\nSRD ${'0x' + r.srd.toString(16).toUpperCase()}` : ''}${[...r.problems, ...r.issues].map((p) => '\n! ' + p).join('')}`);
        if (r.xn) g.append(s('rect', { x: bx, y: yy + hh - 3, width: bw, height: 3, class: 'xn' }));
        // subregions
        if (!V.v8 && r.size >= 256) {
          const sub = r.size / 8;
          for (let k = 0; k < 8; k++) {
            const c0 = r.base + k * sub, c1 = c0 + sub;
            if (c1 <= a.base || c0 >= aEnd) continue;
            const cx = X(c0), cw = X(c1) - cx;
            const off = (r.srd >> k) & 1;
            if (off) g.append(s('rect', { x: cx, y: yy, width: cw, height: hh, class: 'subx' }));
            if (cw >= 9) {
              if (k > 0 && c0 > a.base) g.append(s('line', { x1: cx, x2: cx, y1: yy + 2, y2: yy + hh - 2, class: 'subl' }));
              const cell = s('rect', { x: cx, y: yy, width: cw, height: hh, class: 'subc', 'data-k': k });
              tip(cell, `R${r.n} subregion ${k}: ${hex8(c0)}-${hex8(c1 - 1)} (${sizeName(sub)}) ${off ? 'disabled - lower regions or the default map apply' : 'enabled'} · click to ${off ? 'enable' : 'disable'}`);
              g.append(cell);
            }
          }
        }
        const label = `${AP_SHORT[r.ap]}${r.xn ? ' XN' : ''} · ${TYPE_SHORT[r.type]}`;
        if (bw > 60) g.append(s('text', { x: bx + 5, y: yy + hh / 2 + 4, class: 'mp-bt' }, label.length * 6.2 > bw - 10 ? label.slice(0, Math.max(3, Math.floor((bw - 10) / 6.2))) : label));
        if (r.base < a.base) g.append(s('text', { x: X0 + 2, y: yy + hh / 2 + 4, class: 'mp-arrow' }, '◂'));
        if (r.end > aEnd) g.append(s('text', { x: X1 - 9, y: yy + hh / 2 + 4, class: 'mp-arrow' }, '▸'));
        svg.append(g);
        wireBand(g, r, a, X0, X1);
        y += rowH;
      }
      // effective strip
      const ey = y + 2;
      svg.append(s('text', { x: 6, y: ey + effH / 2 + 3, class: 'mp-rl soft' }, 'effective'));
      for (const sg of V.segs.filter((q) => q.area === a.name)) {
        const sx = X(sg.start), sw = Math.max(sg.kind === 'default' ? 1 : 3, X(sg.end) - sx);
        let fill, cls = 'eff';
        const noAcc = sg.kind === 'region' && regOf(sg.region)?.ap === 'none';
        if (noAcc) { fill = 'url(#mp-h-fault)'; cls = 'eff noacc'; }
        else if (sg.kind === 'region') fill = COL(sg.region);
        else if (sg.kind === 'default') fill = 'url(#mp-h-def)';
        else fill = 'url(#mp-h-fault)';
        const rr = tip(s('rect', { x: sx, y: ey, width: sw, height: effH - 4, class: `${cls} ${sg.kind}`, fill }),
          `${hex8(sg.start)}-${hex8(sg.end - 1)} (${sizeName(sg.end - sg.start)}): ${sg.kind === 'region' ? `R${sg.region} ${regOf(sg.region)?.name || ''}` : sg.kind === 'default' ? 'no region - default map, privileged only' : sg.kind === 'overlap' ? `R${sg.hits.join(' + R')} overlap - faults on Armv8-M` : 'no region and PRIVDEFENA = 0 - faults'}`);
        svg.append(rr);
        const t = noAcc ? `R${sg.region} no access` : sg.kind === 'region' ? `R${sg.region}` : sg.kind === 'default' ? 'default' : sg.kind === 'overlap' ? 'overlap: fault' : 'fault';
        if (sw > t.length * 6.4 + 6) svg.append(s('text', { x: sx + sw / 2, y: ey + effH / 2 + 2, class: `mp-et ${noAcc ? 'fault' : sg.kind}`, 'text-anchor': 'middle' }, t));
      }
      y += effH + 4 + gap;
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${y}`); svg.setAttribute('height', y);
    if ((had || wantFocus) && focusId) {
      const el = svg.querySelector(`[data-id="${CSS.escape(focusId)}"]`) || svg.querySelector(`[data-id^="${CSS.escape(focusId.split('-').slice(0, 2).join('-'))}-"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  // Region moves: Armv7-M snaps the base to the region's own size; Armv8-M to
  // 32 bytes (Shift: 1/8 of the region).
  function step(r, big) { return V.v8 ? (big ? Math.max(32, r.size / 8) : 32 * Math.max(1, Math.round(r.size / 32 / 64))) : r.size; }
  function moveTo(r, base) {
    const st = V.v8 ? 32 : r.size;
    base = Math.round(base / st) * st;
    base = Math.max(0, Math.min(0x100000000 - r.size, base));
    setRow(r.n, { base: hex8(base) });
  }
  function resize(r, dir) {
    if (V.v8) { const st = Math.max(32, 2 ** Math.floor(Math.log2(r.size / 8))); setRow(r.n, { size: sizeText(Math.max(32, Math.round((r.size + dir * st) / 32) * 32)) }); }
    else { const ns = dir > 0 ? Math.min(0x100000000, r.size * 2) : Math.max(32, r.size / 2); setRow(r.n, { size: sizeText(ns), base: hex8(Math.floor(r.base / ns) * ns) }); }
  }
  function wireBand(g, r, a, X0, X1) {
    const bytesPerPx = a.size / (X1 - X0);
    g.addEventListener('focus', () => { focusId = g.getAttribute('data-id'); });
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      wantFocus = true; focusId = g.getAttribute('data-id'); g.focus({ preventScroll: true });
      const cell = e.target.classList.contains('subc') ? Number(e.target.getAttribute('data-k')) : null;
      const x0 = e.clientX; const rect = svg.getBoundingClientRect(); const scale = svg.viewBox.baseVal.width / rect.width;
      let moved = false;
      dragging = true;
      try { g.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      const mv = (m) => {
        const dx = (m.clientX - x0) * scale;
        if (Math.abs(dx) > 3) moved = true;
        if (moved) g.setAttribute('transform', `translate(${dx} 0)`);
      };
      const up = (u) => {
        g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
        dragging = false;
        g.removeAttribute('transform');
        if (moved) { moveTo(r, r.base + (u.clientX - x0) * scale * bytesPerPx); return; }
        if (cell != null) { setRow(r.n, { srd: '0x' + ((r.srd ^ (1 << cell)) & 0xFF).toString(16).toUpperCase().padStart(2, '0') }); sel = r.n; return; }
        if (sel !== r.n) { sel = r.n; redrawAll(); }
      };
      g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    });
    g.addEventListener('keydown', (e) => {
      wantFocus = true;
      if (e.key === 'ArrowLeft') { e.preventDefault(); moveTo(r, r.base - step(r, e.shiftKey)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); moveTo(r, r.base + step(r, e.shiftKey)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); resize(r, 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); resize(r, -1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = r.n; redrawAll(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); const rows = rowsRaw(); rows.splice(r.n, 1); sel = Math.max(0, r.n - 1); focusId = null; ctx.set('regions', rows); }
    });
  }

  // ================= list and editor =================
  function drawList() {
    list.replaceChildren();
    for (const r of V.regions) {
      const probs = r.problems.length + r.issues.length;
      const item = h('button', { type: 'button', role: 'option', class: `mp-item ${sel === r.n ? 'sel' : ''} ${r.enabled ? '' : 'off'} ${r.over ? 'over' : ''}`, 'aria-selected': String(sel === r.n),
        onclick: () => { sel = r.n; redrawAll(); } },
      h('i', { style: `background:${COL(r.n)}` }), h('b', {}, `R${r.n}`), h('span', { class: 'nm' }, r.name),
      h('span', { class: 'mono' }, r.bad ? '–' : hex8(r.base)), h('span', { class: 'mono' }, r.bad ? '–' : sizeName(r.size)),
      h('span', {}, `${AP_SHORT[r.ap]}${r.xn ? ' · XN' : ''}`),
      h('span', { class: 'mono soft' }, r.regs ? Object.entries(r.regs).filter(([k]) => k !== 'attr').map(([k, v]) => `${k} ${v}`).join('  ') : r.over ? 'beyond the MPU\'s regions' : ''),
      probs ? h('span', { class: 'mp-flag', title: [...r.problems, ...r.issues].join('\n') }, `${probs} !`) : h('span', {}));
      list.append(item);
    }
    document.getElementById('mp-listsub').textContent = `${Math.min(V.regions.length, V.count)} of ${V.count} · row order = region number${V.v8 ? '' : ' (higher wins)'}`;
  }

  function drawEd() {
    ed.replaceChildren();
    const rows = ctx.raw.regions || [];
    if (!rows[sel]) { edTitle.textContent = 'Region'; ed.append(h('div', { class: 'mp-sub' }, 'No region selected: add one or click a band.')); return; }
    const raw = rows[sel];
    const r = regOf(sel);
    edTitle.replaceChildren(h('span', { class: 'mp-sw', style: `background:${COL(sel)}` }), `R${sel} `, raw.name || '');
    const text = (k, label, w) => {
      const el = h('input', { type: 'text', spellcheck: 'false', 'data-k': k, style: w ? `width:${w}` : null, oninput: (e) => setRow(sel, { [k]: e.target.value }) });
      el.value = raw[k] ?? ''; return h('label', {}, label, el);
    };
    const seg = (k, opts, cur, label) => h('div', { class: 'mp-field' }, h('span', { class: 'mp-lab' }, label),
      h('div', { class: 'mp-seg sm', role: 'radiogroup', 'aria-label': label }, opts.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === v),
        disabled: V.v8 && (v === 'none' || v === 'priv-rw-user-ro') ? true : null, onclick: () => setRow(sel, { [k]: v }) }, t))));
    const tog = (k, label, tipText) => {
      const on = /^(y|yes|true|1)$/i.test(String(raw[k] ?? (k === 'en' ? 'yes' : '')));
      return h('button', { type: 'button', class: 'k-btn mp-tog', 'aria-pressed': String(on), title: tipText, onclick: () => setRow(sel, { [k]: on ? 'no' : 'yes' }) }, label);
    };
    const typeSel = h('select', { onchange: (e) => setRow(sel, { type: e.target.value }) }, TYPE_LIST.map(([v, t]) => h('option', { value: v, selected: raw.type === v }, t)));
    ed.append(
      h('div', { class: 'mp-row' }, text('name', 'Name', '100%')),
      h('div', { class: 'mp-row' }, text('base', 'Base', '120px'), text('size', V.v8 ? 'Size (32 B steps)' : 'Size (power of 2)', '90px'),
        r && !r.bad && (r.base !== r.reqBase || r.size !== r.reqSize) ? h('div', { class: 'mp-eff' }, 'programmed as', h('b', {}, `${hex8(r.base)} · ${sizeName(r.size)}`)) : null),
      seg('ap', AP_LIST, raw.ap, 'Access (privileged / unprivileged)'),
      h('div', { class: 'mp-row' }, h('label', {}, 'Memory type', typeSel), tog('xn', 'XN', 'Execute never'), tog('s', 'Shareable', 'S bit / SH field'), tog('en', 'Enabled')));
    if (!V.v8) {
      const srd = r ? r.srd : 0;
      const ok = r && r.size >= 256;
      const cells = h('div', { class: 'mp-srd', role: 'group', 'aria-label': 'Subregion disable bits' });
      for (let k = 7; k >= 0; k--) {
        const off = (srd >> k) & 1;
        cells.append(h('button', { type: 'button', class: off ? 'off' : '', disabled: !ok || null, 'aria-pressed': String(!!off), title: ok ? `Subregion ${k}: ${hex8(r.base + (r.size / 8) * k)} (${sizeName(r.size / 8)}) ${off ? 'disabled' : 'enabled'}` : 'Subregions need a region of 256 B or more',
          onclick: () => setRow(sel, { srd: '0x' + ((srd ^ (1 << k)) & 0xFF).toString(16).toUpperCase().padStart(2, '0') }) }, String(k)));
      }
      ed.append(h('div', { class: 'mp-field' }, h('span', { class: 'mp-lab' }, `SRD = 0x${srd.toString(16).toUpperCase().padStart(2, '0')} · subregion 7 … 0${ok ? ` · ${sizeName(r.size / 8)} each` : ' · needs ≥ 256 B'}`), cells));
    }
    if (r && r.regs) {
      ed.append(h('div', { class: 'mp-regs' }, Object.entries(r.regs).filter(([k]) => k !== 'attr').map(([k, v]) => h('div', {}, h('span', {}, k), h('b', {}, v))),
        V.v8 ? h('div', {}, h('span', {}, 'MAIR attr'), h('b', {}, `Attr${r.regs.attr} = 0x${(V.mair[r.regs.attr]?.value ?? 0).toString(16).toUpperCase().padStart(2, '0')}`)) : null));
    }
    const probs = r ? [...r.problems, ...r.issues] : [];
    if (probs.length) ed.append(h('ul', { class: 'mp-probs' }, probs.map((p) => h('li', {}, p))));
    const move = (d) => { const rows2 = rowsRaw(); const j = sel + d; if (j < 0 || j >= rows2.length) return; [rows2[sel], rows2[j]] = [rows2[j], rows2[sel]]; sel = j; ctx.set('regions', rows2); };
    ed.append(h('div', { class: 'mp-acts' },
      h('button', { class: 'k-btn', type: 'button', disabled: sel === 0 || null, onclick: () => move(-1), title: 'Lower region number' }, `→ R${sel - 1}`),
      h('button', { class: 'k-btn', type: 'button', disabled: sel >= rows.length - 1 || null, onclick: () => move(1), title: 'Higher region number (wins overlaps on Armv7-M)' }, `→ R${sel + 1}`),
      h('button', { class: 'k-btn mp-push', type: 'button', onclick: () => { const rows2 = rowsRaw(); rows2.splice(sel, 1); sel = Math.max(0, sel - 1); ctx.set('regions', rows2); } }, 'Remove')));
  }

  function drawAreas() {
    areasCard.hidden = V.device !== 'custom';
    if (areasCard.hidden) return;
    if (areasEd.contains(document.activeElement)) return;
    areasEd.replaceChildren();
    const raw = ctx.raw;
    const archSel = h('select', { onchange: (e) => ctx.set('arch', e.target.value) }, [['v7m', 'Armv7-M'], ['v8m', 'Armv8-M']].map(([v, t]) => h('option', { value: v, selected: raw.arch === v }, t)));
    const cnt = h('input', { type: 'text', style: 'width:50px', oninput: (e) => ctx.set('regionCount', e.target.value) }); cnt.value = raw.regionCount ?? '8';
    areasEd.append(h('div', { class: 'mp-row' }, h('label', {}, 'MPU', archSel), h('label', {}, 'Regions', cnt)));
    const rows = (raw.areas || []).map((a) => ({ ...a }));
    rows.forEach((a, i) => {
      const inp = (k, w) => { const el = h('input', { type: 'text', spellcheck: 'false', style: `width:${w}`, oninput: (e) => { rows[i][k] = e.target.value; ctx.set('areas', rows.map((x) => ({ ...x }))); } }); el.value = a[k] ?? ''; return el; };
      const kind = h('select', { onchange: (e) => { rows[i].kind = e.target.value; ctx.set('areas', rows.map((x) => ({ ...x }))); } }, ['flash', 'ram', 'periph', 'ext'].map((k) => h('option', { value: k, selected: a.kind === k }, k)));
      areasEd.append(h('div', { class: 'mp-arow' }, inp('name', '100%'), inp('base', '100%'), inp('size', '100%'), kind,
        h('button', { class: 'k-btn k-x', type: 'button', 'aria-label': 'Remove area', onclick: () => { rows.splice(i, 1); ctx.set('areas', rows); } }, '×')));
    });
    areasEd.append(h('button', { class: 'k-btn', type: 'button', onclick: () => { rows.push({ name: 'RAM2', base: '0x20010000', size: '32K', kind: 'ram' }); ctx.set('areas', rows); } }, '+ Area'));
  }

  function redrawAll() { draw(); drawList(); drawEd(); }

  let lastW = 0;
  new ResizeObserver(() => { const w = wrap.clientWidth; if (w !== lastW && V && !dragging) { lastW = w; draw(); } }).observe(wrap);

  ctx.onResult((result) => {
    res = result; V = res && res.view;
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    if (!V) return;
    if (sel >= V.regions.length) sel = Math.max(0, V.regions.length - 1);
    for (const b of devBtns) b.setAttribute('aria-checked', String(b.dataset.dev === V.device));
    privBox.checked = V.privdef; hfBox.checked = V.hfnmi;
    loadBtn.disabled = !V.presets[V.device];
    archSub.textContent = `${V.v8 ? 'Armv8-M PMSAv8' : 'Armv7-M PMSAv7'} · ${V.count} regions`;
    document.getElementById('mp-mapsub').textContent = `${V.deviceName} · highest region on top${V.v8 ? ' (overlaps fault on v8-M)' : ' (wins overlaps)'}`;
    const edFocus = ed.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null;
    draw(); drawList(); drawEd(); drawAreas();
    if (edFocus) { const el = ed.querySelector(`[data-k="${edFocus}"]`); if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); } }
    wantFocus = false;
    notes.replaceChildren(h('summary', {}, `Notes (${(res.notes || []).length})`), ...(res.notes || []).map((n) => h('div', {}, n)));
    notes.hidden = !(res.notes || []).length;
  });
}
