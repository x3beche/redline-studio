// Cycle to Time Converter, custom page: a logic-analyzer capture of the span.
//
// The span runs from cursor A (0) to cursor B. Under it the lanes show what
// fits inside: the clock's edges, the instruction cycles they make, the
// delay-loop passes and the chosen timer counting up to its reload. Drag
// cursor B (or click anywhere in the lanes) to set the cycles or the time;
// the lens under the capture magnifies the first instruction cycles so the
// clock period and the clocks-per-cycle stay visible at any span. The clock
// rail on top tries the same span at other clocks, the side lists the timer
// settings that reproduce it (click one to draw it).
//
// Every number shown comes from run()'s result (result.timing, values,
// tables); the page only places them.
import { fmtEng, fmtNum } from '../kit/eng.js';

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
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const txt = (x, y, s, cls = '', anchor = 'start') => sv('text', { x, y, class: cls, 'text-anchor': anchor }, s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const E = (v, u, d = 4) => fmtEng(v, u, d);

// 1-2-5 step for about n ticks over [0, max]
function niceStep(max, n) {
  const raw = max / Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v * 0.9999) return m * p;
  return 10 * p;
}
const sig = (v, d = 3) => Number(Number(v).toPrecision(d));
// 1.25e-5 -> '12.5u' (a value the form parses back)
function engText(v, digits = 4) {
  if (!(v > 0)) return '0';
  const steps = [[1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']];
  const [s, p] = steps.find(([k]) => v >= k * 0.9995) || steps[steps.length - 1];
  return `${Number((v / s).toPrecision(digits))}${p}`;
}
function hzText(v) {
  if (v >= 1e6) return `${Number((v / 1e6).toPrecision(4))}M`;
  if (v >= 1e3) return `${Number((v / 1e3).toPrecision(4))}k`;
  return String(v);
}

const CPCS = [[1, 'AVR · Cortex-M · RISC-V'], [4, 'PIC (Fosc/4)'], [12, '8051']];
const TIMER_KEY = 'redline.tool.cycles-time.timer';
const store = {
  get() { try { const v = localStorage.getItem(TIMER_KEY); return v == null ? NaN : Number(v); } catch { return NaN; } },
  set(v) { try { localStorage.setItem(TIMER_KEY, String(v)); } catch { /* private window */ } },
};

const CSS = `
:root { --tool-clk: #1f4ed8; --tool-cyc: #0f8a78; --tool-loop: #c26a00; --tool-tmr: #9a3cb8; --tool-span: #1f4ed8; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-clk: #7d9bff; --tool-cyc: #3cc7b3; --tool-loop: #f0a33a; --tool-tmr: #c982e0; --tool-span: #7d9bff; } }
:root[data-theme="dark"] { --tool-clk: #7d9bff; --tool-cyc: #3cc7b3; --tool-loop: #f0a33a; --tool-tmr: #c982e0; --tool-span: #7d9bff; }

.ct { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 12px; align-items: start; }
.ct > * { min-width: 0; }
.ct-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ct-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
@media (max-width: 1000px) { .ct { grid-template-columns: minmax(0, 1fr); } }
.ct-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.ct-h { font-size: 11px; font-weight: 600; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .05em; }
.ct-soft { color: var(--ink-soft); }
.ct-mono { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.ct input[type="text"] { padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; min-width: 0; }
.ct input.bad { border-color: var(--danger); }

/* bench: what is given, the clock rail, cycles per instruction, loop */
.ct-bench { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 14px; padding: 9px 12px; align-items: center; }
.ct-bench > .ct-h { white-space: nowrap; }
.ct-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.ct-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); flex-wrap: wrap; }
.ct-seg button { border: 0; background: transparent; padding: 3px 10px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.ct-seg button + button { border-left: 1px solid var(--line); }
.ct-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.ct-seg button small { color: var(--ink-soft); font-weight: 400; margin-left: 4px; font-size: 10.5px; }
.ct-rail { flex: 1 1 280px; min-width: 0; display: flex; gap: 3px; overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; }
.ct-clk { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-start; gap: 0; min-width: 72px; padding: 3px 8px 4px;
  border: 1px solid var(--line-soft); border-radius: 4px; background: var(--sunken); cursor: pointer; text-align: left; position: relative; }
.ct-clk b { font: 600 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.ct-clk span { font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.ct-clk i { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--tool-span); opacity: .7; }
.ct-clk:hover { border-color: var(--ink-soft); }
.ct-clk[aria-pressed="true"] { background: var(--surface); border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.ct-fld { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); white-space: nowrap; }
.ct-fld input { width: 74px; text-align: right; }

/* capture */
.ct-cap { padding: 0; }
.ct-caphead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; padding: 8px 12px 6px; border-bottom: 1px solid var(--line-soft); }
.ct-big { font: 600 26px/1.1 "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.ct-eq { font: 13px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.ct-eq b { color: var(--ink); font-weight: 600; }
.ct-given { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 12px; color: var(--ink-soft); }
.ct-given input { width: 110px; text-align: right; font-size: 14px !important; padding: 4px 7px !important; border-color: var(--accent) !important; }
.ct-warns { margin: 8px 12px 0; border: 1px solid var(--warn); border-left-width: 3px; border-radius: 4px; padding: 5px 9px; font-size: 12px; }
.ct-warns:empty { display: none; }
.ct-warns div + div { margin-top: 3px; }
.ct-svgwrap { position: relative; min-width: 0; }
.ct-svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.ct-stale .ct-svg { opacity: .4; }
.ct-keys { padding: 4px 12px 9px; font-size: 11.5px; color: var(--ink-soft); }
.ct-keys kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; background: var(--sunken); }

.ct-svg .ax { fill: var(--ink-soft); font: 10.5px "IBM Plex Mono", ui-monospace, monospace; }
.ct-svg .axl { stroke: var(--line); stroke-width: 1; }
.ct-svg .grid { stroke: var(--line-soft); stroke-width: 1; }
.ct-svg .lane-bg { fill: var(--sunken); }
.ct-svg .lname { fill: var(--ink); font: 600 12px "IBM Plex Sans", sans-serif; }
.ct-svg .lsub { fill: var(--ink-soft); font: 10.5px "IBM Plex Mono", ui-monospace, monospace; }
.ct-svg .lsub.warn { fill: var(--warn); }
.ct-svg .lsub.bad { fill: var(--danger); }
.ct-svg .wave { fill: none; stroke-width: 1.6; stroke-linejoin: miter; }
.ct-svg .w-clk { stroke: var(--tool-clk); }
.ct-svg .band { stroke-width: 1; }
.ct-svg .b-clk { fill: url(#ct-dense); stroke: var(--tool-clk); }
.ct-svg .b-cyc { fill: var(--tool-cyc); fill-opacity: var(--fill-alpha); stroke: var(--tool-cyc); }
.ct-svg .b-loop { fill: var(--tool-loop); fill-opacity: var(--fill-alpha); stroke: var(--tool-loop); }
.ct-svg .blk { stroke-width: 1; }
.ct-svg .blk-cyc { fill: var(--tool-cyc); stroke: var(--tool-cyc); }
.ct-svg .blk-loop { fill: var(--tool-loop); stroke: var(--tool-loop); }
.ct-svg .blk.alt { fill-opacity: calc(var(--fill-alpha) * 0.55); }
.ct-svg .blk.odd { fill-opacity: calc(var(--fill-alpha) * 1.5); }
.ct-svg .blk.part { fill-opacity: 0.08; stroke-dasharray: 3 2; }
.ct-svg .bn { fill: var(--ink); font: 10.5px "IBM Plex Mono", ui-monospace, monospace; pointer-events: none; }
.ct-svg .bcount { fill: var(--ink); font: 600 12px "IBM Plex Mono", ui-monospace, monospace; paint-order: stroke; stroke: var(--surface); stroke-width: 4px; stroke-linejoin: round; }
.ct-svg .ramp { fill: var(--tool-tmr); fill-opacity: calc(var(--fill-alpha) * 0.8); stroke: var(--tool-tmr); stroke-width: 1.6; }
.ct-svg .tmr-top { stroke: var(--tool-tmr); stroke-dasharray: 3 3; stroke-width: 1; }
.ct-svg .tmr-lab { fill: var(--tool-tmr); font: 600 11px "IBM Plex Mono", ui-monospace, monospace; paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.ct-svg .uev { fill: var(--tool-tmr); }
.ct-svg .none { fill: var(--danger); font: 12px "IBM Plex Sans", sans-serif; }
.ct-svg .outside { fill: var(--paper); fill-opacity: .55; pointer-events: none; }
.ct-svg .span-bg { fill: var(--tool-span); fill-opacity: .06; pointer-events: none; }
.ct-svg .cur { stroke: var(--tool-span); stroke-width: 1.6; }
.ct-svg .cur-a { stroke: var(--ink-soft); stroke-width: 1.2; stroke-dasharray: 4 3; }
.ct-svg .flag { fill: var(--tool-span); }
.ct-svg .flag-t { fill: var(--accent-ink); font: 600 12px "IBM Plex Mono", ui-monospace, monospace; }
.ct-svg .flag-a { fill: var(--sunken); stroke: var(--line); }
.ct-svg .flag-at { fill: var(--ink-soft); font: 600 11px "IBM Plex Mono", ui-monospace, monospace; }
.ct-svg .handle { cursor: ew-resize; outline: none; }
.ct-svg .handle:focus-visible .flag { stroke: var(--ink); stroke-width: 2; }
.ct-svg .handle:focus-visible .grip { stroke: var(--ink); }
.ct-svg .grip { fill: var(--surface); stroke: var(--tool-span); stroke-width: 2; }
.ct-svg .hit { fill: transparent; cursor: crosshair; }
.ct-svg .gapmark { fill: var(--warn); font: 600 11px "IBM Plex Mono", ui-monospace, monospace; paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.ct-svg .zoomfan { fill: var(--ink-soft); fill-opacity: .06; stroke: var(--line); stroke-dasharray: 3 3; }
.ct-svg .lens-bg { fill: var(--sunken); stroke: var(--line); }
.ct-svg .lens-t { fill: var(--ink-soft); font: 600 10.5px "IBM Plex Sans", sans-serif; letter-spacing: .05em; }
.ct-svg .dim { stroke: var(--ink); stroke-width: 1; fill: none; }
.ct-svg .dimt { fill: var(--ink); font: 600 11px "IBM Plex Mono", ui-monospace, monospace; paint-order: stroke; stroke: var(--sunken); stroke-width: 4px; }
.ct-svg .q { fill: var(--ink-soft); font: 10px "IBM Plex Mono", ui-monospace, monospace; }
.ct-svg .edge { stroke: var(--tool-clk); stroke-width: 1; stroke-dasharray: 1 3; opacity: .7; }

/* side */
.ct-card { padding: 9px 12px; }
.ct-card > .ct-h { display: block; margin-bottom: 6px; }
.ct-loop { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ct-loop b { font: 600 20px "IBM Plex Mono", ui-monospace, monospace; }
.ct-tlist { display: flex; flex-direction: column; gap: 4px; }
.ct-tmr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px 8px; text-align: left; padding: 6px 8px 6px 9px; border: 1px solid var(--line-soft);
  border-left: 3px solid transparent; border-radius: 4px; background: var(--sunken); cursor: pointer; }
.ct-tmr:hover { border-color: var(--ink-soft); }
.ct-tmr[aria-checked="true"] { background: var(--surface); border-color: var(--line); border-left-color: var(--tool-tmr); }
.ct-tmr .n { font-size: 12px; font-weight: 600; }
.ct-tmr .e { font: 12px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.ct-tmr .e.ok { color: var(--ok); } .ct-tmr .e.warn { color: var(--warn); } .ct-tmr .e.bad { color: var(--danger); }
.ct-tmr .r { grid-column: 1 / -1; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.ct-tmr .r b { color: var(--ink); font-weight: 600; }
.ct-notes { color: var(--ink-soft); font-size: 11.5px; padding: 0 2px; }
.ct-notes div + div { margin-top: 4px; }
.ct-side .k-out { max-height: 260px; }

@media (max-width: 640px) {
  .ct-bench { grid-template-columns: minmax(0, 1fr); gap: 4px 10px; }
  .ct-bench > .ct-h { margin-top: 4px; }
  .ct-big { font-size: 21px; }
  .ct-given { margin-left: 0; }
  .ct-seg button small { display: none; }
}
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  const st = { dragging: false, span: null, W: 0, timer: store.get(), lastGood: null, focusHandle: false };

  // ------------------------------------------------------------ bench
  const dirBtns = [['c2t', 'Cycles'], ['t2c', 'Time']].map(([v, t]) => h('button', { 'data-v': v, 'aria-pressed': 'false',
    onclick: () => switchDir(v) }, t));
  const fclkIn = h('input', { type: 'text', id: 'ct-fclk', spellcheck: 'false', 'aria-label': 'Clock frequency, Hz', inputmode: 'decimal',
    oninput: (e) => ctx.set('fclk', e.target.value) });
  const rail = h('div', { class: 'ct-rail', role: 'group', 'aria-label': 'Common clocks: the same span at each' });
  const cpcBtns = CPCS.map(([v, t]) => h('button', { 'data-v': v, 'aria-pressed': 'false', title: `${v} clock${v > 1 ? 's' : ''} per instruction cycle: ${t}`,
    onclick: () => ctx.set('cpc', String(v)) }, `${v}`, h('small', {}, t)));
  const cpcIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Clocks per instruction cycle', inputmode: 'decimal', style: 'width:52px',
    oninput: (e) => ctx.set('cpc', e.target.value) });
  const loopIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Instruction cycles per delay-loop pass', inputmode: 'decimal', style: 'width:52px',
    oninput: (e) => ctx.set('loop', e.target.value) });
  const bench = h('section', { class: 'ct-panel ct-bench' },
    h('span', { class: 'ct-h' }, 'Given'), h('div', { class: 'ct-row' }, h('span', { class: 'ct-seg', role: 'group', 'aria-label': 'What you know' }, dirBtns),
      h('span', { class: 'ct-soft', style: 'font-size:12px' }, 'drag cursor B on the capture, or type it next to the result')),
    h('label', { class: 'ct-h', for: 'ct-fclk' }, 'Clock'), h('div', { class: 'ct-row' }, h('span', { class: 'ct-fld' }, fclkIn, 'Hz'), rail),
    h('span', { class: 'ct-h' }, 'Clocks / cycle'), h('div', { class: 'ct-row' },
      h('span', { class: 'ct-seg', role: 'group', 'aria-label': 'Clocks per instruction cycle' }, cpcBtns), h('span', { class: 'ct-fld' }, cpcIn, 'clocks'),
      h('span', { class: 'ct-fld', style: 'margin-left:auto' }, 'delay-loop pass', loopIn, 'cycles')));

  // ------------------------------------------------------------ capture
  const big = h('span', { class: 'ct-big', 'aria-live': 'polite' });
  const eq = h('span', { class: 'ct-eq' });
  const givenIn = h('input', { type: 'text', id: 'ct-given', spellcheck: 'false', inputmode: 'decimal',
    oninput: (e) => ctx.set(ctx.raw.dir === 't2c' ? 'time' : 'cycles', e.target.value) });
  const givenLab = h('label', { for: 'ct-given' });
  const givenUnit = h('span', {});
  const warns = h('div', { class: 'ct-warns', 'aria-live': 'polite' });
  const svgWrap = h('div', { class: 'ct-svgwrap' });
  const cap = h('section', { class: 'ct-panel ct-cap' },
    h('div', { class: 'ct-caphead' }, big, eq, h('span', { class: 'ct-given' }, givenLab, givenIn, givenUnit)),
    warns, svgWrap,
    h('div', { class: 'ct-keys' }, 'Drag cursor ', h('b', {}, 'B'), ' or click in the lanes. On the focused cursor: ',
      h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' one instruction cycle, ', h('kbd', {}, 'Shift'), ' ×10, ',
      h('kbd', {}, 'PgUp'), ' ', h('kbd', {}, 'PgDn'), ' double / halve.'));

  // ------------------------------------------------------------ side
  const loopBox = h('div', { class: 'ct-loop' });
  const tlist = h('div', { class: 'ct-tlist', role: 'radiogroup', 'aria-label': 'Timer settings; the chosen one is drawn in the timer lane' });
  const rate = h('div', { class: 'ct-soft', style: 'font-size:12px;margin-top:6px' });
  const notes = h('div', { class: 'ct-notes' });
  const side = h('aside', { class: 'ct-side' },
    h('section', { class: 'ct-panel ct-card' }, h('span', { class: 'ct-h' }, 'Busy-wait loop'), loopBox, rate),
    h('section', { class: 'ct-panel ct-card' }, h('span', { class: 'ct-h' }, 'Timer for this span'), tlist),
    ctx.outputs, notes);

  root.append(h('div', { class: 'ct' }, h('div', { class: 'ct-main' }, bench, cap), side));

  // ------------------------------------------------------------ input changes
  function switchDir(v) {
    const r = ctx.raw, tm = ctx.result?.timing;
    if (r.dir === v) return;
    if (!tm) { ctx.set('dir', v); return; }
    if (v === 't2c') ctx.setMany({ dir: 't2c', time: engText(tm.time, 9) });
    else ctx.setMany({ dir: 'c2t', cycles: String(tm.whole) });
  }
  // A time on the axis -> the given input (cycles in c2t, time in t2c)
  function setSpan(t, exact) {
    const tm = st.lastGood;
    if (!tm) return;
    t = Math.max(0, t);
    if (tm.dir === 'c2t') {
      let n = t / tm.tcyc;
      n = exact || n < 100 ? Math.round(n) : Math.round(sig(n, 3));
      ctx.set('cycles', String(Math.max(0, n)));
    } else {
      const tt = Math.max(t, tm.tcyc);
      ctx.set('time', engText(exact ? tt : sig(tt, 3)));
    }
  }
  function nudge(dir, mul) {
    const tm = st.lastGood;
    if (!tm) return;
    if (tm.dir === 'c2t') ctx.set('cycles', String(Math.max(0, Math.round(tm.cycles + dir * mul))));
    else ctx.set('time', engText(Math.max(tm.tcyc, tm.time + dir * mul * tm.tcyc)));
  }
  function scale(f) {
    const tm = st.lastGood;
    if (!tm) return;
    if (tm.dir === 'c2t') ctx.set('cycles', String(Math.max(1, Math.round(tm.cycles * f))));
    else ctx.set('time', engText(sig(Math.max(tm.tcyc, tm.time * f), 4)));
  }

  const syncVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };

  // ------------------------------------------------------------ result
  ctx.onResult((res) => {
    const raw = ctx.raw;
    const tm = res.timing;
    syncVal(fclkIn, String(raw.fclk ?? ''));
    syncVal(cpcIn, String(raw.cpc ?? ''));
    syncVal(loopIn, String(raw.loop ?? ''));
    for (const b of dirBtns) b.setAttribute('aria-pressed', String(b.dataset.v === (raw.dir === 't2c' ? 't2c' : 'c2t')));
    const t2c = raw.dir === 't2c';
    givenLab.textContent = t2c ? 'time' : 'cycles';
    givenUnit.textContent = t2c ? 's' : '';
    syncVal(givenIn, String((t2c ? raw.time : raw.cycles) ?? ''));
    const inp = ctx.input;
    fclkIn.classList.toggle('bad', inp.fclk == null || !(inp.fclk > 0));
    givenIn.classList.toggle('bad', (t2c ? inp.time : inp.cycles) == null);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((n) => h('div', {}, n)));
    if (!tm) { cap.classList.add('ct-stale'); return; }
    cap.classList.remove('ct-stale');
    st.lastGood = tm;
    for (const b of cpcBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === tm.cpc));

    // headline: the answer, then the identity it comes from
    const v = Object.fromEntries((res.values || []).map((x) => [x.label, x]));
    if (tm.dir === 'c2t') {
      big.textContent = v.Time?.value || '';
      eq.replaceChildren(h('b', {}, fmtNum(tm.cycles, 7)), ' cycles × ', h('b', {}, fmtNum(tm.cpc)), ` clock${tm.cpc === 1 ? '' : 's'} ÷ `, h('b', {}, E(tm.fclk, 'Hz')),
        ' = ', h('b', {}, v['Clock cycles']?.value || ''), ' clocks');
    } else {
      big.textContent = `${v['Instruction cycles']?.value || ''} cycles`;
      eq.replaceChildren(h('b', {}, E(tm.time, 's')), ' × ', h('b', {}, E(tm.fclk, 'Hz')), ' ÷ ', h('b', {}, fmtNum(tm.cpc)),
        ' = ', h('b', {}, v['Clock cycles']?.value || ''), ' clocks', tm.whole !== tm.cycles ? h('span', {}, ` · ${tm.whole} whole cycles`) : '');
    }

    // clock rail: the same span at common clocks
    const rows = res.tables?.[1]?.rows || [];
    const tmax = Math.max(...tm.clocks.map((c) => c.time));
    rail.replaceChildren(...tm.clocks.map((c, i) => {
      const on = Math.abs(c.fclk - tm.fclk) < 1e-6 * c.fclk;
      const show = tm.dir === 'c2t' ? rows[i]?.[1] : `${rows[i]?.[2] ?? ''} cyc`;
      return h('button', { class: 'ct-clk', 'aria-pressed': String(on), title: `${rows[i]?.[0]}: ${fmtNum(tm.cycles, 6)} cycles take ${rows[i]?.[1]}; ${E(tm.time, 's')} is ${rows[i]?.[2]} cycles`,
        onclick: () => ctx.set('fclk', hzText(c.fclk)) }, h('b', {}, rows[i]?.[0] || ''), h('span', {}, show),
      h('i', { style: `width:${tm.dir === 'c2t' ? clamp((c.time / tmax) * 100, 2, 100) : clamp((c.cycles / Math.max(...tm.clocks.map((x) => x.cycles))) * 100, 2, 100)}%` }));
    }));

    // side: loop and timers
    const lp = v['Delay-loop passes'];
    loopBox.replaceChildren(h('b', {}, lp?.value ?? '–'), h('span', { class: 'ct-soft' }, 'passes'), h('span', { class: 'ct-soft', style: 'font-size:11.5px' }, lp?.hint || ''));
    rate.textContent = `Instruction cycle ${v['Instruction cycle']?.value} (${v['Instruction cycle']?.hint}) · ${v['Instruction rate']?.value} ${v['Instruction rate']?.hint}`;
    const trows = res.tables?.[0]?.rows || [];
    if (!(st.timer >= 0 && st.timer < tm.timers.length)) st.timer = [2, 1, 3, 0].find((i) => tm.timers[i]?.fit) ?? 2;
    tlist.replaceChildren(...tm.timers.map((tr, i) => {
      const r = trows[i] || [];
      const errN = tr.fit ? Math.abs(parseFloat(tr.fit.error)) : null;
      const tone = !tr.fit ? 'bad' : errN === 0 ? 'ok' : errN < 1 ? 'ok' : 'warn';
      const b = h('button', { class: 'ct-tmr', role: 'radio', 'aria-checked': String(i === st.timer), tabindex: i === st.timer ? '0' : '-1',
        onclick: () => { st.timer = i; store.set(i); redraw(); },
        onkeydown: (e) => {
          if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
          e.preventDefault();
          st.timer = (i + (e.key === 'ArrowDown' ? 1 : tm.timers.length - 1)) % tm.timers.length; store.set(st.timer); redraw();
          tlist.children[st.timer]?.focus();
        } },
      h('span', { class: 'n' }, tr.name), h('span', { class: `e ${tone}` }, tr.fit ? `${tr.fit.error} error` : r[3]),
      h('span', { class: 'r' }, tr.fit ? ['prescaler ', h('b', {}, r[1]), ' · reload ', h('b', {}, r[2]), ' · ', r[3]] : `${tr.bits}-bit counter cannot count this span`));
      return b;
    }));
    draw();
  });

  function redraw() {
    const tm = st.lastGood;
    if (!tm) return;
    for (const [i, b] of [...tlist.children].entries()) { b.setAttribute('aria-checked', String(i === st.timer)); b.tabIndex = i === st.timer ? 0 : -1; }
    draw();
  }

  // ------------------------------------------------------------ drawing
  function draw() {
    const tm = st.lastGood;
    const res = ctx.result;
    if (!tm) return;
    const W = Math.max(300, Math.round(svgWrap.clientWidth || 900));
    st.W = W;
    const narrow = W < 560;
    const L = narrow ? 70 : 128, R = narrow ? 10 : 18;
    const plotW = W - L - R;
    const t = tm.time;
    if (!st.dragging || !st.span) st.span = t > 0 ? niceCeil(t * 1.14) : 10 * tm.tcyc;
    const T = st.span;
    const x = (s) => L + (s / T) * plotW;
    const xB = x(Math.min(t, T));
    const yAx = 44, laneH = narrow ? 48 : 52, gap = 7;
    const lanes = ['clk', 'cyc', 'loop', 'tmr'];
    const laneY = (i) => yAx + 14 + i * (laneH + gap);
    const lanesBot = laneY(lanes.length) - gap;
    const yCycAx = lanesBot + 6;
    const lensTop = yCycAx + 40, lensH = 124;
    const H = lensTop + lensH + 8;
    const svg = sv('svg', { class: 'ct-svg', viewBox: `0 0 ${W} ${H}`, height: H, role: 'group',
      'aria-label': `Capture from 0 to ${E(t, 's')}: ${fmtNum(tm.cycles, 7)} instruction cycles` });

    const defs = sv('defs');
    const pat = sv('pattern', { id: 'ct-dense', width: 3, height: 10, patternUnits: 'userSpaceOnUse' });
    pat.append(sv('rect', { x: 0, y: 0, width: 1.2, height: 10, style: 'fill:var(--tool-clk);fill-opacity:.55' }));
    defs.append(pat); svg.append(defs);
    // time axis (top) and cycle axis (bottom)
    const step = niceStep(T, narrow ? 3 : Math.max(4, Math.round(plotW / 120)));
    for (let s = 0; s <= T * 1.0001; s += step) {
      const xx = x(s);
      svg.append(sv('line', { x1: xx, x2: xx, y1: yAx, y2: lanesBot, class: 'grid' }));
      svg.append(sv('line', { x1: xx, x2: xx, y1: yAx - 4, y2: yAx, class: 'axl' }));
      svg.append(txt(xx, yAx - 8, s === 0 ? '0' : E(s, 's', 3), 'ax', s === 0 ? 'start' : 'middle'));
    }
    svg.append(sv('line', { x1: L, x2: L + plotW, y1: yAx, y2: yAx, class: 'axl' }));
    const cycT = T / tm.tcyc;
    const cstep = Math.max(1, niceStep(cycT, narrow ? 3 : Math.max(4, Math.round(plotW / 120))));
    svg.append(sv('line', { x1: L, x2: L + plotW, y1: yCycAx, y2: yCycAx, class: 'axl' }));
    for (let c = 0; c <= cycT * 1.0001; c += cstep) {
      const xx = x(c * tm.tcyc);
      svg.append(sv('line', { x1: xx, x2: xx, y1: yCycAx, y2: yCycAx + 4, class: 'axl' }));
      svg.append(txt(xx, yCycAx + 15, fmtNum(c, 6), 'ax', c === 0 ? 'start' : 'middle'));
    }
    svg.append(txt(L - 8, yAx - 8, 'time', 'ax', 'end'));
    svg.append(txt(L - 8, yCycAx + 15, 'cycles', 'ax', 'end'));

    // span shading
    svg.append(sv('rect', { x: L, y: yAx, width: Math.max(0, xB - L), height: lanesBot - yAx, class: 'span-bg' }));

    const v = Object.fromEntries((res?.values || []).map((q) => [q.label, q]));
    const lane = (i, name, sub, subCls = '') => {
      const y = laneY(i);
      svg.append(sv('rect', { x: L, y, width: plotW, height: laneH, class: 'lane-bg', rx: 2 }));
      svg.append(txt(8, y + laneH / 2 - 3, name, 'lname'));
      svg.append(txt(8, y + laneH / 2 + 12, sub, `lsub ${subCls}`));
      return y;
    };
    // periodic items: drawn one by one when wide enough, else as a band with a count
    const periodic = (y, hgt, period, count, cls, label, drawItem, labCls = 'bcount') => {
      const px = (period / T) * plotW;
      const endT = Math.min(count * period, T);
      if (px >= 5 && count <= 1500) {
        const n = Math.ceil(Math.min(count, T / period + 1));
        for (let k = 0; k < n; k++) drawItem(k, x(k * period), Math.min(px, x(Math.min((k + 1) * period, T)) - x(k * period)), Math.min(1, count - k));
        return true;
      }
      svg.append(sv('rect', { x: L, y, width: Math.max(1, x(endT) - L), height: hgt, class: `band ${cls}` }));
      if (label) svg.append(txt(L + Math.max(8, (x(endT) - L) / 2), y + hgt / 2 + 4, label, labCls, (x(endT) - L) > 160 + (labCls === 'bcount' ? 0 : 200) ? 'middle' : 'start'));
      return false;
    };

    // clock lane
    {
      const y = lane(0, narrow ? 'clock' : 'Clock', narrow ? E(tm.fclk, 'Hz') : `${E(tm.fclk, 'Hz')} · ${E(tm.tclk, 's')}`);
      const hi = y + 12, lo = y + laneH - 12;
      const clocks = tm.cycles * tm.cpc;
      const px = (tm.tclk / T) * plotW;
      if (px >= 5 && clocks <= 3000) {
        let d = `M${L} ${lo}`;
        const n = Math.ceil(Math.min(clocks, T / tm.tclk));
        for (let k = 0; k < n; k++) {
          const x0 = x(k * tm.tclk), xm = x((k + 0.5) * tm.tclk), x1 = x((k + 1) * tm.tclk);
          d += `V${hi}H${xm}V${lo}H${x1}`;
        }
        svg.append(sv('path', { d, class: 'wave w-clk' }));
      } else {
        periodic(hi, lo - hi, tm.tclk, clocks, 'b-clk', `${v['Clock cycles']?.value ?? fmtNum(clocks, 7)} clocks`, () => {});
      }
    }
    // instruction cycles
    {
      const y = lane(1, narrow ? 'cycle' : 'Instruction cycle', narrow ? `${fmtNum(tm.cpc)} clk` : `${fmtNum(tm.cpc)} clock${tm.cpc === 1 ? '' : 's'} · ${E(tm.tcyc, 's')}`);
      const count = tm.cycles;
      periodic(y + 10, laneH - 20, tm.tcyc, count, 'b-cyc', `${fmtNum(count, 7)} cycles`, (k, x0, w, frac) => {
        svg.append(sv('rect', { x: x0 + 0.5, y: y + 10, width: Math.max(0.5, w * frac - 1), height: laneH - 20, rx: 2,
          class: `blk blk-cyc ${frac < 1 ? 'part' : k % 2 ? 'odd' : 'alt'}` }));
        if (w > 22) svg.append(txt(x0 + (w * frac) / 2, y + laneH / 2 + 4, String(k + 1), 'bn', 'middle'));
      });
    }
    // delay loop
    {
      const lw = (res?.warnings || []).some((w) => /loop pass|NOPs/.test(w));
      const y = lane(2, narrow ? 'loop' : 'Delay loop', tm.loop ? `${fmtNum(tm.loop)} ${narrow ? 'cyc' : 'cycles / pass'}` : 'no pass length', lw ? 'warn' : !tm.loop ? 'bad' : '');
      if (tm.loop && tm.passes != null) {
        const period = tm.loop * tm.tcyc;
        const whole = Math.floor(tm.passes + 1e-9);
        const msg = lw ? (res.warnings || []).find((w) => /loop pass|NOPs/.test(w)).split(':')[0] : null;
        const over = msg && tm.passes >= 1;
        periodic(y + 10, laneH - 20, period, tm.passes, 'b-loop', over ? (narrow ? `${v['Delay-loop passes']?.value}: over 16 bits` : msg) : `${v['Delay-loop passes']?.value ?? fmtNum(tm.passes, 6)} passes`, (k, x0, w, frac) => {
          svg.append(sv('rect', { x: x0 + 0.5, y: y + 10, width: Math.max(0.5, w * frac - 1), height: laneH - 20, rx: 2,
            class: `blk blk-loop ${frac < 1 ? 'part' : k % 2 ? 'odd' : 'alt'}` }));
          if (w > 30 && frac === 1) svg.append(txt(x0 + w / 2, y + laneH / 2 + 4, String(k + 1), 'bn', 'middle'));
        }, over ? 'gapmark' : 'bcount');
        if (tm.passes > whole + 1e-9 && tm.passes >= 1) {
          svg.append(txt(Math.min(xB + 6, L + plotW - 4), y + 9, `+${fmtNum((tm.passes - whole) * tm.loop, 3)} cycles left over`, 'gapmark', xB + 150 > L + plotW ? 'end' : 'start'));
        }
        if (msg && !over) svg.append(txt(L + 8, y + laneH - 3, narrow ? 'shorter than one pass' : msg, 'gapmark'));
      } else svg.append(txt(L + 8, y + laneH / 2 + 4, 'Give the cycles per delay-loop pass above 0 to draw the loop.', 'none'));
    }
    // timer
    {
      const tr = tm.timers[st.timer] || tm.timers[0];
      const short = tr.name.replace(', AVR prescalers', ' AVR').replace(', any prescaler (STM32 PSC)', ' PSC').replace(', any prescaler', '');
      const y = lane(3, narrow ? 'timer' : 'Timer', short, tr.fit ? '' : 'bad');
      if (tr.fit) {
        const f = tr.fit;
        const top = y + 8, bot = y + laneH - 6;
        const x1 = x(Math.min(f.actual, T));
        const tickT = f.prescaler * tm.tclk;
        const stepPx = (tickT / T) * plotW;
        let d;
        if (stepPx >= 4 && f.count <= 600) {
          d = `M${L} ${bot}`;
          const n = Math.min(f.count, Math.ceil(T / tickT));
          for (let k = 0; k < n; k++) {
            const yy = bot - ((k + 1) / f.count) * (bot - top);
            const xa = x(k * tickT), xb = x(Math.min((k + 1) * tickT, T));
            d += `H${xa}V${Math.max(top, yy)}H${xb}`;
          }
          d += `V${bot}Z`;
        } else d = `M${L} ${bot}L${x1} ${f.actual <= T ? top : bot - (T / f.actual) * (bot - top)}V${bot}Z`;
        svg.append(sv('path', { d, class: 'ramp' }));
        svg.append(sv('line', { x1: L, x2: x1, y1: top, y2: top, class: 'tmr-top' }));
        if (f.actual <= T) svg.append(sv('path', { d: `M${x1} ${top - 5}l5 -5h-10z`, class: 'uev' }));
        const lab = `PSC ${f.prescaler} · reload ${f.reload}`;
        svg.append(txt(narrow ? L + 4 : L + 8, top + 13, lab, 'tmr-lab'));
        if (!narrow) svg.append(txt(Math.min(x1, L + plotW) - 6, top + 13, `update at ${E(f.actual, 's', 5)}`, 'tmr-lab', 'end'));
        if (f.error !== '0 %' && Math.abs(x1 - xB) > 1) {
          svg.append(txt(Math.max(x1, xB) + 5, bot - 4, `${f.error}`, 'gapmark', Math.max(x1, xB) + 60 > L + plotW ? 'end' : 'start'));
        }
      } else {
        svg.append(txt(L + 8, y + laneH / 2 + 4, narrow ? `${tr.bits}-bit: ${tr.why}` : `A ${tr.bits}-bit counter cannot count this span (${tr.why}). Pick another timer at the side.`, 'none'));
      }
    }

    // the part after B, dimmed
    if (xB < L + plotW) svg.append(sv('rect', { x: xB, y: yAx, width: L + plotW - xB, height: lanesBot - yAx, class: 'outside' }));

    // hit area: click or drag anywhere in the lanes to place B
    const hit = sv('rect', { x: L, y: yAx, width: plotW, height: lanesBot - yAx, class: 'hit' });
    svg.append(hit);

    // cursor A
    svg.append(sv('line', { x1: L, x2: L, y1: yAx - 2, y2: lanesBot + 2, class: 'cur-a' }));
    svg.append(sv('rect', { x: L - 9, y: 3, width: 18, height: 18, rx: 3, class: 'flag-a' }));
    svg.append(txt(L, 16, 'A', 'flag-at', 'middle'));
    svg.append(sv('line', { x1: L, x2: L, y1: 21, y2: yAx - 14, class: 'cur-a' }));

    // cursor B with its flag
    const g = sv('g', { class: 'handle', tabindex: '0', role: 'slider', 'aria-label': tm.dir === 'c2t' ? 'Cursor B: cycles' : 'Cursor B: time',
      'aria-valuetext': `${E(t, 's')}, ${fmtNum(tm.cycles, 7)} cycles`, 'aria-valuenow': String(tm.dir === 'c2t' ? tm.cycles : t) });
    const flagTxt = tm.dir === 'c2t' ? `B ${v.Time?.value || E(t, 's')}` : `B ${fmtNum(tm.cycles, 6)} cyc`;
    const fw = flagTxt.length * 7.3 + 14;
    const fx = clamp(xB - fw / 2, 2, W - fw - 2);
    g.append(sv('rect', { x: xB - 10, y: 0, width: 20, height: lanesBot + 4, fill: 'transparent' }));
    g.append(sv('rect', { x: fx, y: 2, width: fw, height: 20, rx: 4, class: 'flag' }));
    g.append(txt(fx + fw / 2, 16, flagTxt, 'flag-t', 'middle'));
    g.append(sv('line', { x1: xB, x2: xB, y1: 22, y2: lanesBot + 2, class: 'cur' }));
    g.append(sv('rect', { x: xB - 5, y: lanesBot - 10, width: 10, height: 20, rx: 3, class: 'grip' }));
    svg.append(g);
    if (tm.dir === 't2c' && tm.whole !== tm.cycles && (res?.warnings || []).some((w) => /whole number/.test(w))) {
      const right = fx + fw + 150 < W;
      svg.append(txt(right ? fx + fw + 6 : fx - 6, 16, `${fmtNum(tm.cycles, 6)} cycles: not a whole number`, 'gapmark', right ? 'start' : 'end'));
    }

    // lens: the first instruction cycles, magnified
    const zc = tm.cpc >= 4 ? Math.max(2, Math.ceil(12 / tm.cpc)) : 8; // cycles in the lens
    const Tz = zc * tm.tcyc;
    const lx = (s) => L + (s / Tz) * plotW;
    const fanTop = lanesBot + 36;
    svg.append(sv('path', { d: `M${L} ${yCycAx + 20}L${Math.max(L + 1, x(Math.min(Tz, T)))} ${yCycAx + 20}L${L + plotW} ${lensTop}L${L} ${lensTop}Z`, class: 'zoomfan' }));
    svg.append(sv('rect', { x: L, y: lensTop, width: plotW, height: lensH, rx: 3, class: 'lens-bg' }));
    svg.append(txt(8, lensTop + 14, narrow ? 'ZOOM' : 'ZOOM ×' + fmtNum(T / Tz, 3), 'lens-t'));
    svg.append(txt(8, lensTop + 30, `${zc} cycles`, 'lsub'));
    // clock wave in the lens
    const cHi = lensTop + 34, cLo = lensTop + 54;
    let d = `M${L} ${cLo}`;
    const nclk = zc * tm.cpc;
    for (let k = 0; k < nclk; k++) {
      d += `V${cHi}H${lx((k + 0.5) * tm.tclk)}V${cLo}H${lx((k + 1) * tm.tclk)}`;
      if (tm.cpc > 1 && (lx(tm.tclk) - L) > 16) svg.append(txt(lx((k + 0.25) * tm.tclk), cHi - 4, tm.cpc === 4 ? `Q${(k % 4) + 1}` : String((k % tm.cpc) + 1), 'q', 'middle'));
    }
    svg.append(sv('path', { d, class: 'wave w-clk' }));
    // cycle blocks in the lens
    const bY = lensTop + 76, bH = 22;
    for (let k = 0; k < zc; k++) {
      const x0 = lx(k * tm.tcyc), x1 = lx((k + 1) * tm.tcyc);
      svg.append(sv('line', { x1: x0, x2: x0, y1: cHi, y2: bY, class: 'edge' }));
      svg.append(sv('rect', { x: x0 + 1, y: bY, width: x1 - x0 - 2, height: bH, rx: 2, class: `blk blk-cyc ${k % 2 ? 'odd' : 'alt'}` }));
      if (x1 - x0 > 26) svg.append(txt((x0 + x1) / 2, bY + 15, narrow ? String(k + 1) : `cycle ${k + 1}`, 'bn', 'middle'));
    }
    // dimensions: one clock, one instruction cycle
    const dimY1 = bY + bH + 14;
    const dim = (x0, x1, y, label) => {
      svg.append(sv('path', { d: `M${x0} ${y - 4}V${y + 4}M${x1} ${y - 4}V${y + 4}M${x0} ${y}H${x1}`, class: 'dim' }));
      svg.append(sv('path', { d: `M${x0} ${y}l5 -3v6zM${x1} ${y}l-5 -3v6z`, fill: 'currentColor', class: 'dim', style: 'fill:var(--ink)' }));
      svg.append(txt(x1 + 6, y + 4, label, 'dimt'));
    };
    if (tm.cpc > 1) {
      dim(lx(0), lx(tm.tclk), cLo + 11, `1 clock ${E(tm.tclk, 's')}`);
    }
    dim(lx(0), lx(tm.tcyc), dimY1, `${tm.cpc > 1 ? '1 instruction cycle' : '1 cycle = 1 clock'} ${v['Instruction cycle']?.value || E(tm.tcyc, 's')}`);
    if (t <= Tz && t > 0) {
      const xb = lx(t);
      svg.append(sv('line', { x1: xb, x2: xb, y1: lensTop + 2, y2: lensTop + lensH - 2, class: 'cur' }));
      svg.append(txt(xb + 4, lensTop + lensH - 6, 'B', 'flag-at'));
    }

    // ---- interaction
    const toT = (clientX) => {
      const r = (svgWrap.querySelector('svg') || svg).getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      return clamp((px - L) / plotW, 0, 1) * T;
    };
    const start = (e) => {
      e.preventDefault();
      st.dragging = true;
      setSpan(toT(e.clientX), e.shiftKey);
      // the svg is redrawn on every change: follow the pointer on the window
      const move = (ev) => setSpan(toT(ev.clientX), ev.shiftKey);
      const up = () => {
        st.dragging = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        st.focusHandle = true;
        draw();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };
    hit.addEventListener('pointerdown', start);
    g.addEventListener('pointerdown', start);
    g.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'ArrowRight' || k === 'ArrowUp') { e.preventDefault(); nudge(1, e.shiftKey ? 10 : 1); st.focusHandle = true; }
      else if (k === 'ArrowLeft' || k === 'ArrowDown') { e.preventDefault(); nudge(-1, e.shiftKey ? 10 : 1); st.focusHandle = true; }
      else if (k === 'PageUp') { e.preventDefault(); scale(2); st.focusHandle = true; }
      else if (k === 'PageDown') { e.preventDefault(); scale(0.5); st.focusHandle = true; }
    });

    const hadFocus = svgWrap.contains(document.activeElement) || st.focusHandle;
    st.focusHandle = false;
    svgWrap.replaceChildren(svg);
    if (hadFocus && !st.dragging) g.focus({ preventScroll: true });
    else if (hadFocus) g.focus({ preventScroll: true });
  }

  let lastW = 0;
  new ResizeObserver(() => {
    const w = Math.round(svgWrap.clientWidth);
    if (w && Math.abs(w - lastW) > 2) { lastW = w; draw(); }
  }).observe(svgWrap);
}
