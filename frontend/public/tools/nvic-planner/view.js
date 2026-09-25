// NVIC Priority Planner: the page is the priority ladder itself.
//   Byte    - the 8-bit priority register: the bits the chip implements, the
//             group | subpriority split (PRIGROUP) as a handle you drag along
//             the byte, the selected interrupt's byte filled in bit by bit.
//   Ladder  - one rung per group priority, most urgent on top. Every
//             interrupt is a card on its rung carrying its own worst-case
//             response bar (handler, blocked by its group, preempted) against
//             its deadline. Drag a card to another rung (or arrow keys) to
//             re-prioritise; the RTOS syscall limit is a barrier you drag
//             between rungs - above it the kernel never masks, so no RTOS calls.
//   Side    - the selected interrupt to edit, its response dimensioned, the
//             CPU load, what is wrong, and the outputs.
// Every number drawn comes from run()'s result (irqs, nvic, values).

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
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
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const hex = (v) => `0x${(v & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;

const CSS = `
.nv { --tool-c: #2f6fd6; --tool-b: #d97706; --tool-i: #0f9d8a; --tool-sub: #a23fbf; --tool-zone: var(--warn); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .nv { --tool-c: #7ea2ff; --tool-b: #f0a33a; --tool-i: #3cc7b3; --tool-sub: #c982e0; } }
:root[data-theme="dark"] .nv { --tool-c: #7ea2ff; --tool-b: #f0a33a; --tool-i: #3cc7b3; --tool-sub: #c982e0; }
.nv { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 12px; align-items: start; min-width: 0; }
@media (max-width: 1020px) { .nv { grid-template-columns: minmax(0, 1fr); } }
.nv-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.nv-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.nv-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.nv-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.nv-sub { font-size: 11.5px; color: var(--ink-soft); }
.nv-sub b, .nv-mono { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.nv-right { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.nv-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.nv-seg button { border: 0; background: var(--surface); padding: 2px 8px; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.nv-seg button + button { border-left: 1px solid var(--line); }
.nv-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.nv-byte { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; align-items: center; padding: 8px 10px 10px; }
@media (max-width: 620px) { .nv-byte { grid-template-columns: minmax(0, 1fr); } }
.nv-byte svg { display: block; width: 100%; max-width: 560px; user-select: none; -webkit-user-select: none; }
.nv-byte svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.nv-byte svg text.soft { fill: var(--ink-soft); }
.nv-byte svg .split { cursor: ew-resize; touch-action: none; }
.nv-byte svg .split:focus { outline: none; }
.nv-byte svg .split:focus-visible .ring { stroke: var(--accent); stroke-width: 2; stroke-dasharray: 3 2; }
.nv-facts { display: grid; grid-template-columns: auto auto; gap: 2px 12px; font-size: 11.5px; color: var(--ink-soft); }
.nv-facts b { font: 500 13px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); text-align: right; }

.nv-ladder { position: relative; padding: 4px 0 6px; }
.nv-row { display: grid; grid-template-columns: 58px minmax(0, 1fr); min-height: 19px; border-top: 1px solid var(--line-soft); }
.nv-row:first-child { border-top: 0; }
.nv-row.hot { background: color-mix(in srgb, var(--tool-zone) 4%, transparent); }
.nv-row.target { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.nv-lv { display: flex; flex-direction: column; justify-content: center; align-items: flex-end; padding: 0 8px 0 4px; border-right: 1px solid var(--line);
  font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); line-height: 1.15; }
.nv-lv small { font-size: 9.5px; opacity: .85; }
.nv-row.used .nv-lv { color: var(--ink); font-size: 14px; }
.nv-row:not(.used) .nv-lv small { display: none; }
.nv-cards { display: flex; flex-wrap: wrap; gap: 6px; padding: 5px 8px; align-items: stretch; min-width: 0; }
.nv-row.shared .nv-cards { box-shadow: inset 3px 0 0 var(--warn); }
.nv-shared { align-self: center; font-size: 10.5px; color: var(--warn); white-space: nowrap; }
.nv-chip { flex: 0 1 272px; min-width: 150px; text-align: left; border: 1px solid var(--line); border-radius: 5px; background: var(--surface);
  padding: 4px 7px 5px; cursor: grab; touch-action: none; display: flex; flex-direction: column; gap: 2px; user-select: none; -webkit-user-select: none; }
.nv-chip:hover { border-color: var(--ink-soft); }
.nv-chip.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.nv-chip.bad { border-color: var(--danger); }
.nv-chip.bad.sel { box-shadow: 0 0 0 1px var(--danger) inset, 0 0 0 2px var(--accent); }
.nv-chip.drag { cursor: grabbing; box-shadow: 0 2px 10px color-mix(in srgb, var(--ink) 25%, transparent); }
.nv-chip .t { display: flex; align-items: baseline; gap: 6px; font: 600 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.nv-chip .t .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.nv-chip .t .ps { margin-left: auto; font-weight: 400; font-size: 11px; color: var(--ink-soft); }
.nv-chip .m { display: flex; gap: 6px; font: 10.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); white-space: nowrap; }
.nv-chip .m .r { margin-left: auto; color: var(--ink); }
.nv-chip .m .r.late { color: var(--danger); font-weight: 600; }
.nv-chip svg { display: block; width: 100%; height: 9px; }
.nv-tag { font: 600 9.5px "IBM Plex Sans", sans-serif; letter-spacing: .02em; padding: 0 4px; border-radius: 3px; border: 1px solid var(--line); color: var(--ink-soft); }
.nv-tag.bad { border-color: var(--danger); color: var(--danger); }
.nv-tag.warn { border-color: var(--warn); color: var(--warn); }
.nv-barrier { position: relative; height: 26px; margin: 0; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 62px;
  cursor: ns-resize; touch-action: none; user-select: none; -webkit-user-select: none; }
.nv-barrier::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; border-top: 2px dashed var(--warn); }
.nv-barrier > * { position: relative; background: var(--surface); padding: 0 6px; border-radius: 3px; }
.nv-barrier .lab { font-size: 11px; color: var(--ink); border: 1px solid var(--warn); }
.nv-barrier .lab b { font: 600 11px "IBM Plex Mono", ui-monospace, monospace; }
.nv-barrier .grip { margin-left: auto; font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--warn); border: 1px solid var(--warn); }
.nv-barrier:focus { outline: none; }
.nv-barrier:focus-visible .lab { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (max-width: 560px) { .nv-barrier .long { display: none; } }
.nv-zone { position: absolute; left: 62px; font-size: 10.5px; color: var(--warn); pointer-events: none; }
.nv-help { padding: 5px 10px 8px; font-size: 11.5px; color: var(--ink-soft); border-top: 1px solid var(--line-soft); }
.nv-help kbd, .nv-side kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.nv-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--ink-soft); }
.nv-legend i { display: inline-block; width: 10px; height: 8px; border-radius: 1px; margin-right: 4px; vertical-align: 0; }

.nv-insp { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.nv-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px 8px; }
.nv-fields label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--ink-soft); min-width: 0; }
.nv-fields label.w2 { grid-column: span 2; }
.nv-fields input[type="text"] { width: 100%; min-width: 0; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.nv-step { display: flex; }
.nv-step input { text-align: center; border-radius: 0; }
.nv-step button { border: 1px solid var(--line); background: var(--surface); width: 22px; padding: 0; cursor: pointer; font: 12px "IBM Plex Mono", monospace; color: var(--ink); }
.nv-step button:first-child { border-radius: 4px 0 0 4px; border-right: 0; }
.nv-step button:last-child { border-radius: 0 4px 4px 0; border-left: 0; }
.nv-fields .chk { flex-direction: row; align-items: center; gap: 6px; color: var(--ink); font-size: 12px; align-self: end; padding-bottom: 3px; }
.nv-row-btns { display: flex; gap: 6px; }
.nv-resp svg { display: block; width: 100%; }
.nv-resp svg text { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.nv-resp svg text.soft { fill: var(--ink-soft); }
.nv-load { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
.nv-load svg { display: block; width: 100%; }
.nv-load svg text { font: 10px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.nv-figs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.nv-fig span { display: block; font-size: 10.5px; color: var(--ink-soft); }
.nv-fig b { font: 500 14px "IBM Plex Mono", ui-monospace, monospace; }
.nv-fig.bad b { color: var(--danger); } .nv-fig.warn b { color: var(--warn); } .nv-fig.ok b { color: var(--ok); }
.nv-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.nv-warns div + div { margin-top: 4px; }
.nv-warns:empty { display: none; }
.nv-notes { font-size: 11.5px; color: var(--ink-soft); padding: 0 2px; }
.nv-notes summary { cursor: pointer; }
.nv-notes div { margin-top: 4px; }
.nv .k-out { max-height: 220px; }
`;

export function page(root, ctx) {
  const f = (v, d = 3) => ctx.fmtNum(v, d);
  const us = (v) => (v == null ? '∞' : `${f(v)} µs`);
  root.append(h('style', {}, CSS));

  let res = null;
  let sel = null;            // selected table row index
  let dragIdx = null;        // card being dragged (row index)
  let refocus = null;        // what to focus after a redraw: {kind, idx}

  const rows = () => (ctx.raw.irqs || []).map((r) => ({ ...r }));
  const setRow = (idx, patch) => { const r = rows(); r[idx] = { ...r[idx], ...patch }; ctx.set('irqs', r); };

  // ---------- byte strip ----------
  const bitsSeg = h('div', { class: 'nv-seg', role: 'group', 'aria-label': 'Implemented priority bits' });
  const byteSvg = s('svg', { role: 'group', 'aria-label': 'Priority byte' });
  const facts = h('div', { class: 'nv-facts' });
  const byteSub = h('span', { class: 'nv-sub' });
  const byteCard = h('section', { class: 'nv-card' },
    h('div', { class: 'nv-head' }, h('h2', {}, 'Priority byte'), byteSub, h('span', { class: 'nv-right' }, h('span', { class: 'nv-sub' }, 'bits in silicon'), bitsSeg)),
    h('div', { class: 'nv-byte' }, byteSvg, facts));

  // ---------- ladder ----------
  const ladder = h('div', { class: 'nv-ladder', role: 'list', 'aria-label': 'Group priorities, most urgent first' });
  const ladderSub = h('span', { class: 'nv-sub' });
  const rtosBtn = h('button', { class: 'k-btn', onclick: () => {
    if (res?.rtosLimit != null) ctx.set('rtos', ''); else ctx.set('rtos', String(Math.min(5, res?.nvic?.maxPre ?? 5)));
  } });
  const addBtn = h('button', { class: 'k-btn', onclick: () => {
    const r = rows();
    const used = new Set(r.map((x) => x.name));
    let n = r.length + 1; while (used.has(`IRQ${n}`)) n++;
    const pre = res?.nvic ? Math.min(res.nvic.maxPre, Math.max(0, ...(res.irqs || []).map((q) => q.pre)) ) : 0;
    r.push({ name: `IRQ${n}`, pre: String(pre), sub: '0', time: '5', period: '1000', deadline: '', rtos: 'no' });
    sel = r.length - 1;
    ctx.set('irqs', r);
  } }, '+ Interrupt');
  const legend = h('div', { class: 'nv-legend' },
    [['--tool-c', 'handler'], ['--tool-b', 'blocked by own group'], ['--tool-i', 'preempted']].map(([v, t]) => h('span', {}, h('i', { style: `background:var(${v})` }), t)),
    h('span', {}, h('i', { style: 'background:var(--ink);width:2px;height:10px' }), 'deadline'));
  const ladderCard = h('section', { class: 'nv-card' },
    h('div', { class: 'nv-head' }, h('h2', {}, 'Priority ladder'), ladderSub, h('span', { class: 'nv-right' }, rtosBtn, addBtn)),
    h('div', { class: 'nv-head', style: 'padding:4px 10px' }, legend),
    ladder,
    h('div', { class: 'nv-help' }, 'Drag a card to another rung, or focus it and press ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'),
      ' (', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' subpriority). Drag the dashed RTOS limit between rungs. Each bar ends at the worst-case response; the tick is the deadline.'));

  // ---------- side ----------
  const inspHead = h('h2', {});
  const inspSub = h('span', { class: 'nv-sub' });
  const insp = h('div', { class: 'nv-insp' });
  const inspCard = h('section', { class: 'nv-card' }, h('div', { class: 'nv-head' }, inspHead, inspSub), insp);
  const loadBody = h('div', { class: 'nv-load' });
  const loadCard = h('section', { class: 'nv-card' }, h('div', { class: 'nv-head' }, h('h2', {}, 'Budget')), loadBody);
  const warns = h('div', { class: 'nv-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'nv-notes' });

  root.append(h('div', { class: 'nv' },
    h('div', { class: 'nv-col' }, byteCard, ladderCard),
    h('aside', { class: 'nv-col nv-side' }, inspCard, loadCard, warns, ctx.outputs, notes)));

  // ---------- drawing: byte ----------
  function drawByte() {
    const n = res?.nvic;
    bitsSeg.replaceChildren(...[['2', 'M0/M0+'], ['3', 'LPC'], ['4', 'STM32'], ['8', '8']].map(([b, t]) =>
      h('button', { 'aria-pressed': String(String(n?.bits ?? ctx.raw.bits) === b), title: `${b} implemented priority bits`, onclick: () => ctx.set('bits', b) }, b === '8' ? '8' : `${b} ${t}`)));
    byteSvg.replaceChildren();
    if (!n) { facts.replaceChildren(); byteSub.textContent = ''; return; }
    const q = (res.irqs || []).find((x) => x.idx === sel) || null;
    const W = Math.max(300, Math.min(560, Math.round(byteSvg.parentElement.clientWidth || 520))), x0 = W < 420 ? 4 : 44, cw = Math.min(52, (W - x0 - 4) / 8), y0 = 22, ch = 30, H = 86;
    byteSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); byteSvg.style.maxWidth = `${W}px`;
    const impl = (bit) => bit >= 8 - n.bits;
    const isPre = (bit) => bit >= 8 - n.p;
    const X = (bit) => x0 + (7 - bit) * cw;
    if (x0 > 20) byteSvg.append(s('text', { x: 0, y: y0 + 19, class: 'soft' }, 'bit'));
    for (let bit = 7; bit >= 0; bit--) {
      const x = X(bit);
      const col = !impl(bit) ? null : isPre(bit) ? 'var(--accent)' : 'var(--tool-sub)';
      byteSvg.append(s('rect', { x: x + 1, y: y0, width: cw - 2, height: ch, rx: 3,
        fill: col || 'var(--sunken)', 'fill-opacity': col ? 0.16 : 1, stroke: col || 'var(--line)', 'stroke-dasharray': col ? null : '3 2' }));
      byteSvg.append(s('text', { x: x + cw / 2, y: y0 - 6, 'text-anchor': 'middle', class: 'soft' }, String(bit)));
      const v = q ? (q.ipr >> bit) & 1 : null;
      byteSvg.append(s('text', { x: x + cw / 2, y: y0 + 20, 'text-anchor': 'middle', style: `font-size:14px;font-weight:${v ? 600 : 400};${impl(bit) ? '' : 'fill:var(--ink-soft)'}` },
        v == null ? (impl(bit) ? '·' : '0') : String(v)));
    }
    // Brackets: group, sub, unimplemented.
    const bracket = (hi, lo, label, col, short) => {
      if (hi < lo) return;
      const xa = X(hi) + 3, xb = X(lo) + cw - 3;
      byteSvg.append(s('path', { d: `M${xa},${y0 + ch + 5}v5H${xb}v-5`, fill: 'none', stroke: col, 'stroke-width': 1.4 }));
      const w = xb - xa;
      const txt = w > label.length * 6.6 ? label : short;
      byteSvg.append(s('text', { x: (xa + xb) / 2, y: y0 + ch + 23, 'text-anchor': 'middle', style: `fill:${col}` }, txt));
    };
    bracket(7, 8 - n.p, `group ${n.p} bit${n.p === 1 ? '' : 's'} · ${n.maxPre + 1} levels`, 'var(--accent)', `group ×${n.maxPre + 1}`);
    bracket(7 - n.p, 8 - n.bits, `sub ${n.sb} bit${n.sb === 1 ? '' : 's'}`, 'var(--tool-sub)', 'sub');
    bracket(7 - n.bits, 0, 'not implemented, reads 0', 'var(--ink-soft)', 'reads 0');

    // The PRIGROUP split: a handle on the boundary between group and sub bits.
    const xSplit = n.p === 0 ? X(7) : X(8 - n.p) + cw;
    const g = s('g', { class: n.v6m ? null : 'split', tabindex: n.v6m ? null : 0, role: 'slider', 'aria-label': 'Preemption bits (priority grouping)',
      'aria-valuemin': 0, 'aria-valuemax': n.bits, 'aria-valuenow': n.p, 'aria-valuetext': `${n.p} group bits, ${n.sb} subpriority bits, PRIGROUP ${n.prigroup}` });
    g.append(s('line', { x1: xSplit, x2: xSplit, y1: y0 - 14, y2: y0 + ch + 4, stroke: n.v6m ? 'var(--ink-soft)' : 'var(--ink)', 'stroke-width': 2.5 }));
    g.append(s('rect', { class: 'ring', x: xSplit - 7, y: y0 - 18, width: 14, height: 12, rx: 3, fill: n.v6m ? 'var(--sunken)' : 'var(--ink)', stroke: 'var(--ink)' }));
    g.append(s('rect', { x: xSplit - 12, y: y0 - 18, width: 24, height: ch + 24, fill: 'transparent' }));
    g.append(s('title', {}, n.v6m ? 'Armv6-M has no PRIGROUP: every bit preempts' : 'Drag to split the byte into group and subpriority bits'));
    byteSvg.append(g);
    if (!n.v6m) {
      const setP = (p) => { p = Math.max(0, Math.min(n.bits, p)); if (p !== n.p) ctx.set('pbits', p === n.bits ? 'all' : String(p)); };
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault(); g.focus({ preventScroll: true });
        const move = (ev) => {
          const r = byteSvg.getBoundingClientRect();
          const x = (ev.clientX - r.left) * (W / r.width);
          // boundary after bit k counted from the MSB
          const k = Math.round((x - x0) / cw);
          setP(Math.min(k, n.bits));
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); refocus = { kind: 'split' }; draw(); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      g.addEventListener('keydown', (e) => {
        const cur = res.nvic.p;
        const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (k == null && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault(); refocus = { kind: 'split' };
        setP(e.key === 'Home' ? 0 : e.key === 'End' ? res.nvic.bits : cur + k);
      });
    }
    byteSub.replaceChildren(...(q ? ['IPR byte of ', h('b', {}, q.name), ' = ', h('b', {}, hex(q.ipr))] : ['select an interrupt to see its byte']));
    facts.replaceChildren(
      h('span', {}, 'AIRCR.PRIGROUP'), h('b', {}, n.v6m ? '–' : String(n.prigroup)),
      h('span', {}, 'group × sub'), h('b', {}, `${n.maxPre + 1} × ${n.maxSub + 1}`),
      h('span', {}, 'RTOS limit byte'), h('b', {}, n.rtosByte != null ? hex(n.rtosByte) : '–'));
  }

  // ---------- drawing: ladder ----------
  function barSvg(q) {
    const svg = s('svg', { viewBox: '0 0 100 9', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const scale = 80 / q.D;
    svg.append(s('rect', { x: 0, y: 1, width: 100, height: 7, fill: 'var(--sunken)' }));
    let x = 0;
    for (const [k, col] of [['C', '--tool-c'], ['B', '--tool-b'], ['I', '--tool-i']]) {
      const v = q[k] == null ? q.D * 1.3 : q[k];
      const w = Math.min(100 - x, v * scale);
      if (w > 0.05) { svg.append(s('rect', { x, y: 1, width: w, height: 7, fill: `var(${col})` })); x += w; }
    }
    svg.append(s('rect', { x: 79.4, y: 0, width: 1.2, height: 9, fill: q.ok ? 'var(--ink)' : 'var(--danger)' }));
    return svg;
  }

  function drawLadder() {
    const n = res?.nvic;
    const list = res?.irqs || [];
    ladder.replaceChildren();
    if (!n) { ladderSub.textContent = ''; ladder.append(h('div', { class: 'nv-help', style: 'border:0' }, (res?.warnings || []).join(' '))); return; }
    const rt = res.rtosLimit;
    rtosBtn.textContent = rt != null ? 'Remove RTOS limit' : '+ RTOS limit';
    const maxUsed = Math.max(0, ...list.map((q) => q.pre));
    const top = Math.min(n.maxPre, Math.max(Math.min(15, n.maxPre), maxUsed + 1, rt != null ? rt : 0));
    const levels = new Map();
    for (const q of list) levels.set(q.pre, [...(levels.get(q.pre) || []), q]);
    ladderSub.replaceChildren(`${levels.size} of ${n.maxPre + 1} rungs used · `, h('b', {}, `${list.length}`), ' interrupts, most urgent on top');
    for (let lv = 0; lv <= top; lv++) {
      if (rt != null && lv === rt) ladder.append(barrier(rt, top));
      const qs = levels.get(lv) || [];
      const byte = (lv << n.sb) << (8 - n.bits);
      const row = h('div', { class: `nv-row${qs.length ? ' used' : ''}${qs.length > 1 ? ' shared' : ''}${rt != null && lv < rt ? ' hot' : ''}`, 'data-lv': lv, role: 'listitem' },
        h('div', { class: 'nv-lv' }, String(lv), h('small', {}, hex(byte))));
      const cards = h('div', { class: 'nv-cards' });
      for (const q of qs) cards.append(chip(q, n));
      if (qs.length > 1) cards.append(h('span', { class: 'nv-shared', title: 'Interrupts in one group cannot preempt each other' }, 'shared rung: no preemption between these'));
      row.append(cards);
      ladder.append(row);
    }
    if (rt != null && rt > top) ladder.append(barrier(rt, top));
    // refocus after a redraw
    if (refocus?.kind === 'chip') ladder.querySelector(`.nv-chip[data-idx="${refocus.idx}"]`)?.focus({ preventScroll: true });
    if (refocus?.kind === 'barrier') ladder.querySelector('.nv-barrier')?.focus({ preventScroll: true });
    if (refocus?.kind === 'split') byteSvg.querySelector('.split')?.focus({ preventScroll: true });
    if (dragIdx != null) ladder.querySelector(`.nv-chip[data-idx="${dragIdx}"]`)?.classList.add('drag');
  }

  function chip(q, n) {
    const bad = !q.ok || q.rtosBad;
    const el = h('button', { class: `nv-chip${q.idx === sel ? ' sel' : ''}${bad ? ' bad' : ''}`, 'data-idx': q.idx, type: 'button',
      'aria-label': `${q.name}, group ${q.pre}, sub ${q.sub}, response ${us(q.R)}, deadline ${us(q.D)}${q.ok ? '' : ', misses its deadline'}${q.rtosBad ? ', calls the RTOS above the limit' : ''}` });
    const tags = [];
    if (q.rtos) tags.push(h('span', { class: `nv-tag${q.rtosBad ? ' bad' : ''}`, title: q.rtosBad ? 'Calls the RTOS API above the syscall limit' : 'Calls the RTOS API' }, 'RTOS'));
    if (!q.ok && q.inverted.length) tags.push(h('span', { class: 'nv-tag warn', title: `Shorter deadline than ${q.inverted.join(', ')}, which sit above it` }, `D < ${q.inverted[0]}`));
    el.append(
      h('div', { class: 't' }, h('span', { class: 'nm' }, q.name), ...tags, h('span', { class: 'ps' }, n.sb ? `${q.pre}.${q.sub}` : String(q.pre))),
      barSvg(q),
      h('div', { class: 'm' }, h('span', {}, `C ${f(q.C)}`), h('span', {}, `T ${f(q.T)}`),
        h('span', { class: `r${q.ok ? '' : ' late'}` }, q.R == null ? 'unbounded' : q.ok ? `R ${f(q.R)} / ${f(q.D)} µs` : `R ${f(q.R)} > ${f(q.D)} µs`)));
    el.title = `${q.name}: handler ${us(q.C)}, blocked ${us(q.B)}, preempted ${us(q.I)} → response ${us(q.R)}; deadline ${us(q.D)}`;
    el.addEventListener('focus', () => { if (sel !== q.idx) { sel = q.idx; drawSelOnly(); } });
    el.addEventListener('keydown', (e) => {
      const cur = res.irqs.find((x) => x.idx === q.idx); if (!cur) return;
      let patch = null;
      if (e.key === 'ArrowUp' && cur.pre > 0) patch = { pre: String(cur.pre - 1) };
      if (e.key === 'ArrowDown' && cur.pre < n.maxPre) patch = { pre: String(cur.pre + 1) };
      if (e.key === 'ArrowLeft' && cur.sub > 0) patch = { sub: String(cur.sub - 1) };
      if (e.key === 'ArrowRight' && cur.sub < n.maxSub) patch = { sub: String(cur.sub + 1) };
      if (e.key.startsWith('Arrow')) e.preventDefault();
      if (!patch) return;
      refocus = { kind: 'chip', idx: q.idx };
      setRow(q.idx, patch);
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      sel = q.idx; el.focus({ preventScroll: true });
      const y0 = e.clientY; let moved = false;
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientY - y0) < 4) return;
        if (!moved) { moved = true; dragIdx = q.idx; ladder.querySelector(`.nv-chip[data-idx="${q.idx}"]`)?.classList.add('drag'); }
        const rowEls = [...ladder.querySelectorAll('.nv-row')];
        let lv = null;
        for (const r of rowEls) { const b = r.getBoundingClientRect(); if (ev.clientY >= b.top) lv = Number(r.dataset.lv); }
        if (lv == null) lv = 0;
        const last = rowEls.length ? Number(rowEls[rowEls.length - 1].dataset.lv) : 0;
        if (lv === last && ev.clientY > rowEls[rowEls.length - 1].getBoundingClientRect().bottom + 10) lv = Math.min(res.nvic.maxPre, last + 1);
        for (const r of rowEls) r.classList.toggle('target', Number(r.dataset.lv) === lv);
        const cur = res.irqs.find((x) => x.idx === q.idx);
        if (cur && cur.pre !== lv) { refocus = { kind: 'chip', idx: q.idx }; setRow(q.idx, { pre: String(lv) }); }
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        dragIdx = null; refocus = { kind: 'chip', idx: q.idx }; draw();
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      if (!moved) drawSelOnly();
    });
    return el;
  }

  function barrier(rt, top) {
    const n = res.nvic;
    const b = h('div', { class: 'nv-barrier', tabindex: 0, role: 'slider', 'aria-label': 'RTOS syscall limit (configMAX_SYSCALL_INTERRUPT_PRIORITY)',
      'aria-valuemin': 0, 'aria-valuemax': n.maxPre, 'aria-valuenow': rt },
    h('span', { class: 'lab' }, 'RTOS limit ', h('b', {}, String(rt)), ` · ${hex(n.rtosByte)} · `, h('span', { class: 'long', style: 'color:var(--warn)' }, 'above: kernel never masks, no RTOS calls')),
    h('span', { class: 'grip', 'aria-hidden': 'true' }, 'drag ↕'));
    const setRt = (v) => { v = Math.max(0, Math.min(n.maxPre, v)); if (v !== res.rtosLimit) { refocus = { kind: 'barrier' }; ctx.set('rtos', String(v)); } };
    b.addEventListener('keydown', (e) => {
      const k = { ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (k == null) return;
      e.preventDefault(); setRt(res.rtosLimit + k);
    });
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.focus({ preventScroll: true });
      const move = (ev) => {
        // the barrier sits above rung v: find the first rung whose middle is below the pointer
        const rowEls = [...ladder.querySelectorAll('.nv-row')];
        let v = rowEls.length ? Number(rowEls[rowEls.length - 1].dataset.lv) + 1 : 0;
        for (const r of rowEls) { const bb = r.getBoundingClientRect(); if (ev.clientY < bb.top + bb.height / 2) { v = Number(r.dataset.lv); break; } }
        setRt(Math.min(v, top + 1));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); refocus = { kind: 'barrier' }; draw(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    return b;
  }

  // ---------- drawing: side ----------
  const fieldEls = {};
  function drawInsp() {
    const list = res?.irqs || [];
    if (sel == null || !list.some((q) => q.idx === sel)) sel = list[0]?.idx ?? null;
    const q = list.find((x) => x.idx === sel);
    const raw = rows()[sel];
    const n = res?.nvic;
    if (!q || !raw || !n) { inspHead.textContent = 'No interrupt'; inspSub.textContent = ''; insp.replaceChildren(h('div', { class: 'nv-sub' }, 'Add one with + Interrupt.')); return; }
    inspHead.textContent = q.name;
    inspSub.replaceChildren('group ', h('b', {}, String(q.pre)), ...(n.sb ? [' · sub ', h('b', {}, String(q.sub))] : []), ' · IPR ', h('b', {}, hex(q.ipr)));
    // Keep the fields that are being typed in; rebuild when the selection changes.
    if (insp.dataset.idx !== String(sel) || !insp.firstChild) {
      insp.dataset.idx = String(sel);
      const txt = (key, label, cls, ph) => {
        const el = h('input', { type: 'text', spellcheck: 'false', inputmode: key === 'name' ? null : 'decimal', placeholder: ph || '',
          oninput: (e) => setRow(sel, { [key]: e.target.value }) });
        fieldEls[key] = el;
        return h('label', { class: cls }, label, el);
      };
      const stepper = (key, label) => {
        const el = h('input', { type: 'text', inputmode: 'numeric', spellcheck: 'false', oninput: (e) => setRow(sel, { [key]: e.target.value }) });
        fieldEls[key] = el;
        const bump = (d) => { const v = Number(rows()[sel][key]) || 0; const max = key === 'pre' ? res.nvic.maxPre : res.nvic.maxSub; setRow(sel, { [key]: String(Math.max(0, Math.min(max, v + d))) }); };
        return h('label', {}, label, h('span', { class: 'nv-step' },
          h('button', { type: 'button', 'aria-label': `${label} minus one`, onclick: () => bump(-1) }, '−'), el,
          h('button', { type: 'button', 'aria-label': `${label} plus one`, onclick: () => bump(1) }, '+')));
      };
      const rt = h('input', { type: 'checkbox', onchange: (e) => setRow(sel, { rtos: e.target.checked ? 'yes' : 'no' }) });
      fieldEls.rtos = rt;
      insp.replaceChildren(
        h('div', { class: 'nv-fields' },
          txt('name', 'Name (IRQn without _IRQn)', 'w2'), stepper('pre', 'Priority'),
          txt('time', 'Handler µs'), txt('period', 'Period µs'), txt('deadline', 'Deadline µs', null, 'period'),
          stepper('sub', 'Subpriority'), h('label', { class: 'chk w2' }, rt, 'Calls the RTOS API (FromISR)')),
        h('div', { class: 'nv-resp' }),
        h('div', { class: 'nv-row-btns' },
          h('button', { class: 'k-btn', type: 'button', onclick: () => { const r = rows(); r.splice(sel, 1); sel = null; ctx.set('irqs', r); } }, 'Remove this interrupt')));
    }
    for (const [k, el] of Object.entries(fieldEls)) {
      if (!el.isConnected || document.activeElement === el) continue;
      if (k === 'rtos') el.checked = String(raw.rtos).toLowerCase() === 'yes';
      else el.value = raw[k] ?? '';
    }
    fieldEls.sub.disabled = n.maxSub === 0;
    fieldEls.sub.closest('label').querySelectorAll('button').forEach((b) => { b.disabled = n.maxSub === 0; });
    drawResp(q, insp.querySelector('.nv-resp'));
  }

  // The selected interrupt's worst case, dimensioned.
  function drawResp(q, box) {
    const W = 340, H = 86, L = 4, R = 4, y = 26, bh = 16;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Worst-case response of ${q.name}` });
    const end = Math.max(q.D, q.R ?? q.D * 1.3) * 1.08;
    const X = (v) => L + (v / end) * (W - L - R);
    svg.append(s('rect', { x: L, y, width: W - L - R, height: bh, fill: 'var(--sunken)', rx: 2 }));
    let t = 0;
    const parts = [['C', 'handler', '--tool-c'], ['B', 'blocked', '--tool-b'], ['I', 'preempted', '--tool-i']];
    let labY = 0;
    for (const [k, name, col] of parts) {
      const v = q[k] == null ? end - t : q[k];
      if (v <= 0) continue;
      const xa = X(t), xb = X(Math.min(end, t + v));
      svg.append(s('rect', { x: xa, y, width: Math.max(0.5, xb - xa), height: bh, fill: `var(${col})` }));
      const lab = `${name} ${q[k] == null ? '∞' : f(v)}`;
      const up = labY++ % 2 === 0;
      const tx = Math.min(W - R - lab.length * 6.3, Math.max(L, (xa + xb) / 2 - (lab.length * 6.3) / 2));
      svg.append(s('text', { x: tx, y: up ? y - 6 : y + bh + 14, style: `fill:var(${col})` }, lab));
      t += v;
    }
    const xd = X(q.D);
    svg.append(s('line', { x1: xd, x2: xd, y1: y - 18, y2: y + bh + 30, stroke: q.ok ? 'var(--ink)' : 'var(--danger)', 'stroke-width': 1.6 }));
    const dl = `deadline ${f(q.D)} µs`;
    const right = xd + 4 + dl.length * 6.3 < W - R;
    svg.append(s('text', { x: right ? xd + 4 : xd - 4, y: y + bh + 28, 'text-anchor': right ? 'start' : 'end', class: 'soft' }, dl));
    const rTxt = q.R == null ? 'response unbounded' : `response ${f(q.R)} µs${q.ok ? '' : ` · late ${f(q.R - q.D)} µs`}`;
    svg.append(s('text', { x: L, y: H - 4, style: q.ok ? '' : 'fill:var(--danger);font-weight:600' }, rTxt));
    box.replaceChildren(svg);
  }

  function drawLoad() {
    const n = res?.nvic;
    if (!n) { loadBody.replaceChildren(); return; }
    const U = n.load;
    const W = 340, H = 34, L = 2, R = 2;
    const end = Math.max(1.1, U * 1.05);
    const X = (v) => L + (v / end) * (W - L - R);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Interrupt CPU load ${f(U * 100)} %` });
    svg.append(s('rect', { x: L, y: 4, width: W - L - R, height: 12, fill: 'var(--sunken)', rx: 2 }));
    svg.append(s('rect', { x: X(0.7), y: 4, width: X(1) - X(0.7), height: 12, fill: 'var(--warn)', 'fill-opacity': 0.18 }));
    svg.append(s('rect', { x: X(1), y: 4, width: Math.max(0, W - R - X(1)), height: 12, fill: 'var(--danger)', 'fill-opacity': 0.18 }));
    // one slice per interrupt, in NVIC order
    let t = 0;
    for (const q of res.irqs) {
      const u = q.C / q.T;
      const xa = X(t), xb = X(t + u);
      const r = s('rect', { x: xa, y: 5, width: Math.max(0.5, xb - xa - 0.6), height: 10, fill: U > 1 ? 'var(--danger)' : 'var(--tool-c)', 'fill-opacity': q.idx === sel ? 1 : 0.6 });
      r.append(s('title', {}, `${q.name}: ${f(u * 100)} %`));
      svg.append(r); t += u;
    }
    for (const [v, lab] of [[0, '0'], [0.7, '70 %'], [1, '100 %']]) {
      svg.append(s('line', { x1: X(v), x2: X(v), y1: 2, y2: 20, stroke: 'var(--ink-soft)' }));
      svg.append(s('text', { x: X(v), y: 31, 'text-anchor': v === 0 ? 'start' : 'middle' }, lab));
    }
    const vals = res.values || [];
    const fig = (label, short) => {
      const v = vals.find((x) => x.label === label);
      return v ? h('div', { class: `nv-fig ${v.tone || ''}` }, h('span', {}, short), h('b', {}, String(v.value))) : null;
    };
    loadBody.replaceChildren(
      h('div', { class: 'nv-figs' }, fig('Interrupt CPU load', 'CPU in interrupts'), fig('Deadlines met', 'Deadlines met'), fig('Conflicts', 'Conflicts')),
      svg);
  }

  function drawMsgs() {
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'How it is worked out'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }

  function drawSelOnly() {
    for (const c of ladder.querySelectorAll('.nv-chip')) c.classList.toggle('sel', Number(c.dataset.idx) === sel);
    drawInsp(); drawByte(); drawLoad();
  }

  function draw() {
    drawInsp();
    drawByte();
    drawLadder();
    drawLoad();
    drawMsgs();
    refocus = null;
  }

  ctx.onResult((r) => { res = r; draw(); });
  let lastW = 0;
  new ResizeObserver(() => { const w = byteCard.clientWidth; if (w !== lastW) { lastW = w; drawByte(); } }).observe(byteCard);
}
