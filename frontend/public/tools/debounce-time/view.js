// Debounce Time Calculator, custom page: one press on a scope.
//
// The trace is the switch contact closing with an illustrative bounce that
// lasts exactly the switch's worst-case bounce. The firmware's sample ticks
// read it; the counter under it climbs on every read that differs from the
// accepted state and falls back to 0 on an equal one, and the debounced
// output changes when it reaches N. Drag the Ts knob on a sample tick to
// change the sampling period, drag the end of the stable window to change the
// margin, click a switch in the catalogue to change the bounce. The shift
// register under the scope shows the last samples at the moment of
// acceptance against the C code's mask; the RC + Schmitt option is drawn at
// the side.
//
// Every number shown comes from run()'s result.debounce and values; the
// illustrative bounce and the counter replay only place marks.
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
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
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
const E = (v, u = 's', d = 3) => fmtEng(v, u, d);

// Nice sampling periods, 10 µs .. 100 ms
const LADDER = [];
for (let d = 1e-5; d < 0.2; d *= 10) for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) LADDER.push(Number((m * d).toPrecision(3)));
function engText(v) {
  const steps = [[1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n']];
  const [s, p] = steps.find(([k]) => v >= k * 0.9995) || steps[steps.length - 1];
  return `${Number((v / s).toPrecision(3))}${p}`;
}
function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v * 0.9999) return m * p;
  return 10 * p;
}
function niceStep(max, n) {
  const raw = max / Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Open glitches [start, end] inside (0, B]; the contact closes for good at B.
function bounceOf(B, seed) {
  const r = rng(seed);
  const n = 5 + Math.floor(r() * 5);
  const out = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const end = i === n - 1 ? B : prev + (B - prev) * (0.18 + r() * 0.3);
    const room = end - prev;
    const len = room * (0.25 + r() * 0.5) * (1 - 0.5 * (end / B));
    out.push([end - Math.max(len, room * 0.12), end]);
    prev = end;
  }
  return out;
}
const levelAt = (t, glitches) => (t < 0 ? 0 : glitches.some(([a, b]) => t >= a && t < b) ? 0 : 1);

const CSS = `
:root { --tool-pin: #1f4ed8; --tool-read1: #0f8a78; --tool-cnt: #9a3cb8; --tool-out: #2f855a; --tool-bnc: #c26a00; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-pin: #7d9bff; --tool-read1: #3cc7b3; --tool-cnt: #c982e0; --tool-out: #68b36b; --tool-bnc: #f0a33a; } }
:root[data-theme="dark"] { --tool-pin: #7d9bff; --tool-read1: #3cc7b3; --tool-cnt: #c982e0; --tool-out: #68b36b; --tool-bnc: #f0a33a; }

.db { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 12px; align-items: start; }
.db > * { min-width: 0; }
@media (max-width: 1000px) {
  .db { display: flex; flex-direction: column; }
  .db-col { display: contents; }
  .db-o1 { order: 1; } .db-o2 { order: 2; } .db-o3 { order: 3; } .db-o4 { order: 4; } .db-o5 { order: 5; } .db-o6 { order: 6; }
}
.db-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.db-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.db-h { font-size: 11px; font-weight: 600; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .05em; }
.db-soft { color: var(--ink-soft); }
.db input[type="text"] { padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; min-width: 0; }
.db input.bad { border-color: var(--danger); }

.db-scopehead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); }
.db-n { display: flex; align-items: baseline; gap: 8px; }
.db-n b { font: 600 26px/1 "IBM Plex Mono", ui-monospace, monospace; }
.db-n span { font-size: 12px; color: var(--ink-soft); }
.db-kv { display: flex; flex-direction: column; gap: 0; font-size: 11px; color: var(--ink-soft); }
.db-kv b { font: 600 14px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.db-kv.ok b { color: var(--ok); } .db-kv.warn b { color: var(--warn); }
.db-fields { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-left: auto; align-items: center; }
.db-fld { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); white-space: nowrap; }
.db-fld input { width: 62px; }
.db-btn { padding: 3px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 12px; }
.db-btn:hover { border-color: var(--ink-soft); }
.db-warns { margin: 8px 12px 0; border: 1px solid var(--warn); border-left-width: 3px; border-radius: 4px; padding: 5px 9px; font-size: 12px; }
.db-warns:empty { display: none; }
.db-warns div + div { margin-top: 3px; }
.db-scope { position: relative; min-width: 0; }
.db-svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.db-stale .db-svg { opacity: .4; }
.db-foot { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 4px 12px 9px; font-size: 11.5px; color: var(--ink-soft); }
.db-foot kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; background: var(--sunken); }
.db-leg { display: inline-flex; align-items: center; gap: 5px; }
.db-leg i { display: inline-block; width: 14px; height: 3px; border-radius: 1px; }

.db-svg .ax { fill: var(--ink-soft); font: 10.5px "IBM Plex Mono", ui-monospace, monospace; }
.db-svg .axl { stroke: var(--line); }
.db-svg .grid { stroke: var(--line-soft); }
.db-svg .lane { fill: var(--sunken); }
.db-svg .lname { fill: var(--ink); font: 600 12px "IBM Plex Sans", sans-serif; }
.db-svg .lsub { fill: var(--ink-soft); font: 10.5px "IBM Plex Mono", ui-monospace, monospace; }
.db-svg .bz { fill: var(--tool-bnc); fill-opacity: calc(var(--fill-alpha) * .7); }
.db-svg .lag { fill: url(#db-lag); }
.db-svg .lagt { fill: var(--danger); font: 600 11px "IBM Plex Sans", sans-serif; }
.db-svg .pin { fill: none; stroke: var(--tool-pin); stroke-width: 2; stroke-linejoin: miter; }
.db-svg .tick { stroke: var(--ink-soft); stroke-width: 1; stroke-dasharray: 1 3; opacity: .55; }
.db-svg .s1 { fill: var(--tool-read1); stroke: var(--tool-read1); }
.db-svg .s0 { fill: var(--surface); stroke: var(--ink-soft); stroke-width: 1.3; }
.db-svg .s0.diff, .db-svg .s1.diff { stroke: var(--tool-cnt); stroke-width: 2; }
.db-svg .cnt { fill: var(--tool-cnt); fill-opacity: calc(var(--fill-alpha) * .9); stroke: var(--tool-cnt); stroke-width: 1.6; }
.db-svg .nline { stroke: var(--tool-cnt); stroke-dasharray: 4 3; }
.db-svg .nlab { fill: var(--tool-cnt); font: 600 11px "IBM Plex Mono", ui-monospace, monospace; }
.db-svg .reset { fill: var(--tool-cnt); }
.db-svg .out { fill: none; stroke: var(--tool-out); stroke-width: 2.4; }
.db-svg .acc { stroke: var(--tool-out); stroke-width: 1.2; stroke-dasharray: 3 2; }
.db-svg .acct { fill: var(--tool-out); font: 600 11px "IBM Plex Sans", sans-serif; paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.db-svg .dim { stroke: var(--ink); stroke-width: 1; fill: none; }
.db-svg .dimh { fill: var(--ink); }
.db-svg .dimt { fill: var(--ink); font: 600 11.5px "IBM Plex Mono", ui-monospace, monospace; paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.db-svg .dimt.b { fill: var(--tool-bnc); }
.db-svg .dimt.w { fill: var(--ink-soft); font-weight: 500; }
.db-svg .dimt.r.ok { fill: var(--ok); } .db-svg .dimt.r.warn { fill: var(--warn); }
.db-svg .win { fill: var(--ink); fill-opacity: .05; stroke: var(--ink-soft); stroke-dasharray: 4 3; }
.db-svg .knob { cursor: ew-resize; outline: none; }
.db-svg .knob .kb { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.db-svg .knob .kt { fill: var(--accent); font: 600 11px "IBM Plex Mono", ui-monospace, monospace; }
.db-svg .knob:hover .kb, .db-svg .knob:focus-visible .kb { fill: var(--accent); }
.db-svg .knob:hover .kt, .db-svg .knob:focus-visible .kt { fill: var(--accent-ink); }
.db-svg .knob:focus-visible .kb { stroke: var(--ink); }
.db-svg .kline { stroke: var(--accent); stroke-width: 1.2; opacity: .8; }
.db-svg .note { fill: var(--ink-soft); font: italic 11px "IBM Plex Sans", sans-serif; }

/* shift register */
.db-reg { padding: 9px 12px 10px; display: flex; flex-direction: column; gap: 6px; }
.db-regrow { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.db-bits { display: grid; gap: 2px; flex: 1 1 360px; min-width: 0; }
.db-bit { display: flex; flex-direction: column; align-items: center; gap: 1px; min-width: 0; }
.db-bit small { font: 9.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.db-bit b { width: 100%; text-align: center; font: 600 13px/22px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px;
  background: var(--sunken); color: var(--ink-soft); }
.db-bit.m b { border-color: var(--tool-cnt); border-width: 1.5px; }
.db-bit.one b { background: var(--tool-read1); border-color: var(--tool-read1); color: var(--surface); }
.db-bit.m.one b { box-shadow: inset 0 0 0 1.5px var(--tool-cnt); }
.db-regcode { font: 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.db-regcode .ok { color: var(--ok); font-weight: 600; }

/* catalogue */
.db-cat { padding: 9px 10px 8px; }
.db-cat .db-h { display: block; margin-bottom: 4px; }
.db-sw { display: grid; grid-template-columns: 116px minmax(0, 1fr) 44px; align-items: center; gap: 6px; width: 100%; padding: 3px 4px; border: 0;
  border-left: 3px solid transparent; background: transparent; cursor: pointer; text-align: left; border-radius: 3px; }
.db-sw:hover { background: var(--sunken); }
.db-sw[aria-checked="true"] { background: var(--sunken); border-left-color: var(--accent); }
.db-sw .nm { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.db-sw[aria-checked="true"] .nm { font-weight: 600; }
.db-sw svg { width: 100%; height: 14px; display: block; }
.db-sw .n { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; color: var(--ink-soft); }
.db-sw[aria-checked="true"] .n { color: var(--ink); font-weight: 600; }
.db-sw .typ { fill: var(--tool-bnc); }
.db-sw .max { fill: var(--tool-bnc); fill-opacity: .35; }
.db-sw .ax { stroke: var(--line); }
.db-cathead { display: grid; grid-template-columns: 116px minmax(0, 1fr) 44px; gap: 6px; font-size: 10.5px; color: var(--ink-soft); padding: 0 4px 3px 7px; }
.db-cathead span:last-child { text-align: right; }
.db-custom { display: flex; align-items: center; gap: 6px; padding: 5px 4px 0 7px; font-size: 12px; color: var(--ink-soft); }
.db-custom input { width: 64px; }
.db-src { font-size: 11px; color: var(--ink-soft); padding: 4px 4px 0 7px; }

/* RC option */
.db-rc { padding: 9px 12px; }
.db-rc svg { display: block; width: 100%; height: auto; }
.db-rc .w { stroke: var(--ink-soft); stroke-width: 1.4; fill: none; }
.db-rc .p { fill: var(--surface); stroke: var(--ink); stroke-width: 1.4; }
.db-rc .t { fill: var(--ink); font: 600 11.5px "IBM Plex Mono", ui-monospace, monospace; }
.db-rc .s { fill: var(--ink-soft); font: 10.5px "IBM Plex Sans", sans-serif; }
.db-rc .dot { fill: var(--ink-soft); }
.db-notes { color: var(--ink-soft); font-size: 11.5px; padding: 0 2px; }
.db-notes div + div { margin-top: 4px; }
.db .k-out { max-height: 190px; }

@media (max-width: 640px) {
  .db-fields { margin-left: 0; }
  .db-n b { font-size: 22px; }
  .db-sw, .db-cathead { grid-template-columns: 96px minmax(0, 1fr) 40px; }
}
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  const st = { seed: 7, drag: null, span: null, last: null, focus: null };

  // ------------------------------------------------------------ scope panel
  const nBox = h('div', { class: 'db-n' });
  const kvDeb = h('div', { class: 'db-kv' });
  const kvResp = h('div', { class: 'db-kv' });
  const kvGl = h('div', { class: 'db-kv' });
  const tsIn = h('input', { type: 'text', id: 'db-ts', spellcheck: 'false', inputmode: 'decimal', oninput: (e) => ctx.set('ts', e.target.value) });
  const mIn = h('input', { type: 'text', id: 'db-m', spellcheck: 'false', inputmode: 'decimal', style: 'width:48px', oninput: (e) => ctx.set('margin', e.target.value) });
  const reroll = h('button', { class: 'db-btn', title: 'Draw another illustrative bounce of the same length',
    onclick: () => { st.seed = (st.seed * 7919 + 13) % 100003; draw(); } }, 'Another bounce');
  const warns = h('div', { class: 'db-warns', 'aria-live': 'polite' });
  const scope = h('div', { class: 'db-scope' });
  const scopePanel = h('section', { class: 'db-panel db-o1' },
    h('div', { class: 'db-scopehead' }, nBox, kvDeb, kvResp, kvGl,
      h('div', { class: 'db-fields' },
        h('label', { class: 'db-fld', for: 'db-ts' }, 'sample every', tsIn, 's'),
        h('label', { class: 'db-fld', for: 'db-m' }, 'margin', mIn, '×'), reroll)),
    warns, scope,
    h('div', { class: 'db-foot' },
      h('span', {}, 'Drag the ', h('b', {}, 'Ts'), ' knob or the ', h('b', {}, 'window'), ' end; focused: ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), '.'),
      h('span', { class: 'db-leg' }, h('i', { style: 'background:var(--tool-pin)' }), 'pin'),
      h('span', { class: 'db-leg' }, h('i', { style: 'background:var(--tool-read1)' }), 'read 1'),
      h('span', { class: 'db-leg' }, h('i', { style: 'background:var(--tool-cnt)' }), 'counter'),
      h('span', { class: 'db-leg' }, h('i', { style: 'background:var(--tool-out)' }), 'debounced'),
      h('span', { class: 'db-leg' }, h('i', { style: 'background:var(--tool-bnc);opacity:.6' }), 'bounce (illustrative)')));

  // ------------------------------------------------------------ shift register
  const bits = h('div', { class: 'db-bits' });
  const regCode = h('div', { class: 'db-regcode' });
  const regTitle = h('span', { class: 'db-h' });
  const regPanel = h('section', { class: 'db-panel db-reg db-o3' }, regTitle, h('div', { class: 'db-regrow' }, bits), regCode);

  // ------------------------------------------------------------ side
  const catList = h('div', { role: 'radiogroup', 'aria-label': 'Switch type' });
  const bIn = h('input', { type: 'text', spellcheck: 'false', inputmode: 'decimal', 'aria-label': 'Worst-case bounce of your switch, s',
    oninput: (e) => ctx.setMany({ type: 'custom', bounce: e.target.value }) });
  const src = h('div', { class: 'db-src' });
  const catHead = h('div', { class: 'db-cathead' }, h('span', {}, 'switch'), h('span', {}), h('span', {}, 'N'));
  const cat = h('section', { class: 'db-panel db-cat db-o2' }, h('span', { class: 'db-h' }, 'Switch · bounce typical / worst'), catHead, catList,
    h('label', { class: 'db-custom' }, 'Custom, worst bounce', bIn, 's'), src);
  const rcBox = h('div', {});
  const vddIn = h('input', { type: 'text', spellcheck: 'false', inputmode: 'decimal', 'aria-label': 'Supply, V', style: 'width:52px', oninput: (e) => ctx.set('vdd', e.target.value) });
  const rc = h('section', { class: 'db-panel db-rc db-o4' }, h('div', { style: 'display:flex;align-items:center;gap:8px;justify-content:space-between' },
    h('span', { class: 'db-h' }, 'Or in hardware: RC + Schmitt'), h('label', { class: 'db-fld' }, 'Vdd', vddIn, 'V')), rcBox);
  const notes = h('div', { class: 'db-notes db-o6' });
  ctx.outputs.classList.add('db-o5');

  root.append(h('div', { class: 'db' }, h('div', { class: 'db-col' }, scopePanel, regPanel, notes), h('div', { class: 'db-col' }, cat, rc, ctx.outputs)));

  const syncVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };

  // ------------------------------------------------------------ result
  ctx.onResult((res) => {
    const raw = ctx.raw, inp = ctx.input;
    syncVal(tsIn, String(raw.ts ?? ''));
    syncVal(mIn, String(raw.margin ?? ''));
    syncVal(vddIn, String(raw.vdd ?? ''));
    syncVal(bIn, String(raw.bounce ?? ''));
    tsIn.classList.toggle('bad', !(inp.ts > 0));
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((n) => h('div', {}, n)));
    const d = res.debounce;
    if (!d) { scopePanel.classList.add('db-stale'); return; }
    scopePanel.classList.remove('db-stale');
    st.last = d;
    const v = Object.fromEntries((res.values || []).map((x) => [x.label, x]));
    nBox.replaceChildren(h('b', {}, `N = ${v['Samples in a row N']?.value}`), h('span', {}, `equal reads at ${E(d.ts)}`));
    kvDeb.replaceChildren('debounce time', h('b', {}, v['Debounce time']?.value));
    kvResp.className = `db-kv ${v['Worst-case response']?.tone || ''}`;
    kvResp.replaceChildren('worst response', h('b', {}, v['Worst-case response']?.value));
    kvGl.replaceChildren('glitch rejected below', h('b', {}, v['Glitch always rejected below']?.value));

    // catalogue: bounce bars on a shared axis, N at this Ts and margin
    const tmax = Math.max(...d.switches.map((s) => s.bounce), d.bounce) * 1.05;
    const rows = d.switches.map((s) => {
      const on = raw.type === s.key;
      const bar = sv('svg', { viewBox: '0 0 100 14', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      bar.append(sv('line', { x1: 0, x2: 100, y1: 13, y2: 13, class: 'ax' }));
      bar.append(sv('rect', { x: 0, y: 3, width: (s.bounce / tmax) * 100, height: 8, class: 'max' }));
      bar.append(sv('rect', { x: 0, y: 3, width: (s.typ / tmax) * 100, height: 8, class: 'typ' }));
      return h('button', { class: 'db-sw', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', 'data-k': s.key,
        title: `${s.name}: typical ${E(s.typ)}, worst ${E(s.bounce)} (${s.src}). N = ${s.N}, response ${E(s.response)}`,
        onclick: () => ctx.set('type', s.key), onkeydown: (e) => catKey(e, s.key) },
      h('span', { class: 'nm' }, s.name), bar, h('span', { class: 'n' }, String(s.N)));
    });
    if (raw.type === 'custom') {
      const bar = sv('svg', { viewBox: '0 0 100 14', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      bar.append(sv('line', { x1: 0, x2: 100, y1: 13, y2: 13, class: 'ax' }));
      bar.append(sv('rect', { x: 0, y: 3, width: Math.min(100, (d.bounce / tmax) * 100), height: 8, class: 'max' }));
      rows.push(h('button', { class: 'db-sw', role: 'radio', 'aria-checked': 'true', tabindex: '0', onkeydown: (e) => catKey(e, 'custom') },
        h('span', { class: 'nm' }, 'Custom'), bar, h('span', { class: 'n' }, String(d.N))));
    }
    catList.replaceChildren(...rows);
    catHead.children[1].textContent = `0 … ${E(tmax)}`;
    src.textContent = `${d.name}: worst ${E(d.bounce)}, typical ${E(d.typ)} · ${d.src}`;
    if (st.focus === 'cat') { catList.querySelector('[aria-checked="true"]')?.focus(); st.focus = null; }

    drawRC(v, d);
    draw();
  });

  function catKey(e, key) {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const keys = st.last.switches.map((s) => s.key);
    const i = keys.indexOf(key);
    const j = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : keys.length - 1)) % keys.length;
    st.focus = 'cat';
    ctx.set('type', keys[j]);
  }

  // ------------------------------------------------------------ RC option drawing
  function drawRC(v, d) {
    const rcv = v['RC + Schmitt option'];
    const svg = sv('svg', { viewBox: '0 0 300 116', role: 'img', 'aria-label': `RC debounce: ${rcv?.value}` });
    const w = (dd) => svg.append(sv('path', { d: dd, class: 'w' }));
    svg.append(txt(8, 22, 'Vdd', 's'));
    w('M34 18H66');
    svg.append(sv('rect', { x: 66, y: 12, width: 44, height: 12, rx: 2, class: 'p' }));
    svg.append(txt(88, 8, d.rc ? fmtEng(d.rc.r, 'Ω') : '–', 't', 'middle'));
    w('M110 18H150V56');
    svg.append(sv('circle', { cx: 150, cy: 56, r: 2.6, class: 'dot' }));
    // the switch from the node to ground
    w('M150 56H112'); w('M112 56L90 45'); w('M86 56H60V96');
    svg.append(sv('circle', { cx: 88, cy: 56, r: 2, class: 'dot' }));
    svg.append(txt(100, 70, 'switch', 's', 'middle'));
    // the capacitor from the node to ground
    w('M150 56V76'); w('M138 76H162'); w('M138 82H162'); w('M150 82V96');
    svg.append(txt(134, 84, '100 nF', 't', 'end'));
    w('M60 96H150'); w('M93 100H117'); w('M98 104H112'); w('M102 108H108'); w('M105 96V100');
    // the Schmitt-trigger input
    w('M150 56H196');
    svg.append(sv('path', { d: 'M196 40V72L232 56Z', class: 'p' }));
    svg.append(sv('path', { d: 'M205 60h8v-8h6M209 60v-8h8', class: 'w', style: 'stroke-width:1' }));
    w('M232 56H262'); svg.append(txt(266, 60, 'pin', 's'));
    svg.append(txt(214, 90, 'Schmitt input', 's', 'middle'));
    const vth = /Vth- ≈ [^,]+/.exec(rcv?.hint || '');
    if (vth) svg.append(txt(214, 104, vth[0], 's', 'middle'));
    rcBox.replaceChildren(svg, h('div', { class: 'db-soft', style: 'font-size:11.5px' }, `${rcv?.value}: ${rcv?.hint}. The cap holds the pin through the bounce; no firmware counter needed.`));
  }

  // ------------------------------------------------------------ scope
  function setTs(t) {
    const q = Math.max(1e-5, Number(t.toPrecision(2)));
    ctx.set('ts', engText(q));
  }
  function setMargin(m) {
    ctx.set('margin', String(Math.max(1, Math.round(m * 10) / 10)));
  }
  function ladderStep(dir) {
    const cur = st.last.ts;
    const i = dir > 0 ? LADDER.findIndex((x) => x > cur * 1.0001) : LADDER.length - 1 - [...LADDER].reverse().findIndex((x) => x < cur * 0.9999);
    if (i >= 0 && i < LADDER.length) ctx.set('ts', engText(LADDER[i]));
  }

  function draw() {
    const d = st.last;
    if (!d) return;
    const res = ctx.result;
    const v = Object.fromEntries((res?.values || []).map((x) => [x.label, x]));
    const W = Math.max(300, Math.round(scope.clientWidth || 900));
    const narrow = W < 560;
    const L = narrow ? 58 : 104, R = narrow ? 10 : 16;
    const plotW = W - L - R;
    const B = d.bounce, Ts = d.ts, N = d.N;
    // span: from a little before the first contact to past the worst response
    if (!st.drag || !st.span) {
      const end = niceCeil(Math.max(d.response, B + d.window) * 1.18);
      st.span = { t0: -Math.min(end * 0.08, Math.max(Ts * 1.5, end * 0.04)), t1: end };
    }
    const { t0, t1 } = st.span;
    const x = (t) => L + ((t - t0) / (t1 - t0)) * plotW;
    const yTop = 22;
    const dimY = [34, 56, 78];
    const pinY = 100, pinH = 86;
    const cntY = pinY + pinH + 10, cntH = 92;
    const outY = cntY + cntH + 10, outH = 46;
    const axY = outY + outH + 4;
    const H = axY + 22;
    const svg = sv('svg', { class: 'db-svg', viewBox: `0 0 ${W} ${H}`, height: H, role: 'group',
      'aria-label': `One press: bounce ${E(B)}, ${N} samples at ${E(Ts)}, accepted by ${E(d.response)}` });
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'db-lag', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('rect', { width: 2, height: 7, style: 'fill:var(--danger);fill-opacity:.35' }));
    defs.append(pat); svg.append(defs);

    // lanes and axis
    const lanes = [[pinY, pinH, 'Contact', 'pressed = 1'], [cntY, cntH, 'Counter', `to N = ${N}`], [outY, outH, 'Debounced', 'state']];
    for (const [y, hh, n, s] of lanes) {
      svg.append(sv('rect', { x: L, y, width: plotW, height: hh, class: 'lane', rx: 2 }));
      svg.append(txt(8, y + hh / 2 - 2, narrow ? { Contact: 'Pin', Counter: 'Count', Debounced: 'Out' }[n] : n, 'lname'));
      if (!narrow) svg.append(txt(8, y + hh / 2 + 12, s, 'lsub'));
    }
    const step = niceStep(t1 - t0, narrow ? 3 : Math.max(4, Math.round(plotW / 110)));
    for (let t = 0; t <= t1 * 1.0001; t += step) {
      const xx = x(t);
      svg.append(sv('line', { x1: xx, x2: xx, y1: pinY, y2: outY + outH, class: 'grid' }));
      svg.append(txt(xx, axY + 12, t === 0 ? '0' : E(t, 's', 3), 'ax', 'middle'));
    }
    if (!narrow) svg.append(txt(8, axY + 12, 'from contact', 'ax'));

    // worst-case bounce zone and the 50 ms lag limit
    svg.append(sv('rect', { x: x(0), y: pinY, width: x(B) - x(0), height: pinH, class: 'bz' }));
    if (t1 > 50e-3) {
      const xl = x(Math.max(50e-3, t0));
      svg.append(sv('rect', { x: xl, y: pinY, width: L + plotW - xl, height: outY + outH - pinY, class: 'lag' }));
      svg.append(txt(xl + 5, outY + outH - 6, 'over 50 ms: users feel the lag', 'lagt'));
    }

    // the pin
    const glitches = bounceOf(B, st.seed);
    const hi = pinY + 16, lo = pinY + pinH - 14;
    let p = `M${L} ${lo}H${x(0)}V${hi}`;
    for (const [a, b] of glitches) p += `H${x(a)}V${lo}H${x(b)}V${hi}`;
    p += `H${L + plotW}`;
    svg.append(sv('path', { d: p, class: 'pin' }));

    // samples: ticks at (k + phase)·Ts; replay the counter over them
    const phase = rng(st.seed * 31 + 5)();
    const kMin = Math.ceil(t0 / Ts - phase), kMax = Math.floor(t1 / Ts - phase);
    const many = kMax - kMin > 260;
    let state = 0, count = 0, acc = null;
    const cntPts = [];
    const hist = [];
    for (let k = kMin; k <= kMax; k++) {
      const t = (k + phase) * Ts;
      const r = levelAt(t, glitches);
      const differ = r !== state;
      if (!differ) count = 0;
      else if (++count >= N) { state = r; count = 0; if (acc == null) acc = { t, k }; }
      if (acc == null || t <= acc.t) hist.push(r);
      cntPts.push([t, acc && acc.t === t ? N : count, differ && acc?.t !== t && count === 0]);
      const xx = x(t);
      if (!many) svg.append(sv('line', { x1: xx, x2: xx, y1: pinY + 2, y2: cntY + cntH, class: 'tick' }));
      svg.append(sv('circle', { cx: xx, cy: r ? hi : lo, r: many ? 1.6 : 3.4, class: `${r ? 's1' : 's0'}${differ && !many ? ' diff' : ''}` }));
    }
    // counter staircase
    const cTop = cntY + 16, cBot = cntY + cntH - 6;
    const cy = (c) => cBot - (c / N) * (cBot - cTop);
    let cp = `M${L} ${cBot}`;
    let prevX = L;
    for (const [t, c] of cntPts) {
      const xx = x(t);
      cp += `H${xx}V${cy(c)}`;
      prevX = xx;
    }
    cp += `H${L + plotW}V${cBot}Z`;
    svg.append(sv('path', { d: cp, class: 'cnt' }));
    svg.append(sv('line', { x1: L, x2: L + plotW, y1: cTop, y2: cTop, class: 'nline' }));
    svg.append(txt(L + plotW - 4, cTop - 4, `N = ${N}`, 'nlab', 'end'));
    // resets: a differing streak broken by an equal read
    for (let i = 1; i < cntPts.length; i++) {
      if (cntPts[i][1] === 0 && cntPts[i - 1][1] > 0 && !(acc && cntPts[i - 1][0] === acc.t)) {
        svg.append(sv('path', { d: `M${x(cntPts[i][0])} ${cBot + 1}l-4 5h8z`, class: 'reset' }));
      }
    }
    // output
    const oHi = outY + 10, oLo = outY + outH - 10;
    const xa = acc ? x(acc.t) : L + plotW;
    svg.append(sv('path', { d: `M${L} ${oLo}H${xa}V${oHi}H${L + plotW}`, class: 'out' }));
    if (acc) {
      svg.append(sv('line', { x1: xa, x2: xa, y1: pinY, y2: outY + outH, class: 'acc' }));
      const al = narrow ? 'accepted' : `accepted: ${N} reads in a row at the new level`;
      const right = xa + 5 + al.length * 6.4 < L + plotW;
      svg.append(txt(right ? xa + 5 : xa - 5, oHi + 11, al, 'acct', right ? 'start' : 'end'));
    }

    // dimensions on top: bounce, window wanted and N·Ts, worst response
    const dim = (a, b, y, label, cls = '', anchor = 'mid') => {
      const x0 = x(a), x1 = x(b);
      svg.append(sv('path', { d: `M${x0} ${y - 5}V${y + 5}M${x1} ${y - 5}V${y + 5}M${x0} ${y}H${x1}`, class: 'dim' }));
      if (x1 - x0 > 12) svg.append(sv('path', { d: `M${x0} ${y}l6 -3v6zM${x1} ${y}l-6 -3v6z`, class: 'dimh' }));
      const tw = label.length * 7;
      let tx, an, ty = y + 4;
      if (x1 - x0 > tw + 16) { tx = (x0 + x1) / 2; an = 'middle'; ty = y - 4; }
      else if (x1 + 6 + tw < W - 2) { tx = x1 + 6; an = 'start'; }
      else if (x0 - 6 - tw > 2) { tx = x0 - 6; an = 'end'; }
      else { tx = clamp((x0 + x1) / 2, tw / 2 + 2, W - tw / 2 - 2); an = 'middle'; ty = y - 4; }
      svg.append(txt(tx, ty, label, `dimt ${cls}`, an));
    };
    dim(0, B, dimY[0], `bounce ≤ ${v['Worst-case bounce']?.value || E(B)}`, 'b');
    dim(B, B + d.time, dimY[1], narrow ? `N·Ts ${v['Debounce time']?.value}` : `N·Ts = ${N} × ${E(Ts)} = ${v['Debounce time']?.value}`);
    dim(0, d.response, dimY[2], `${narrow ? 'response' : 'worst response'} ${v['Worst-case response']?.value}`, `r ${v['Worst-case response']?.tone || ''}`);
    // the stable window wanted, as a dashed box after the last bounce; its end is the margin knob
    const xw0 = x(B), xw1 = x(B + d.window);
    const wy = pinY + pinH - 26;
    svg.append(sv('rect', { x: xw0, y: wy, width: Math.max(1, xw1 - xw0), height: 18, class: 'win' }));
    const wl = narrow ? `window ${v['Stable window wanted']?.value}` : `stable window wanted: bounce × ${fmtNum(d.margin, 3)} = ${v['Stable window wanted']?.value}`;
    if (xw1 - xw0 > wl.length * 6.6 + 40) svg.append(txt((xw0 + xw1 - 24) / 2, wy + 13, wl, 'dimt w', 'middle'));
    // the margin knob
    const mk = sv('g', { class: 'knob', tabindex: '0', role: 'slider', 'data-k': 'margin', 'aria-label': 'Safety margin: end of the stable window',
      'aria-valuenow': String(d.margin), 'aria-valuetext': `${fmtNum(d.margin, 3)} times the bounce, window ${v['Stable window wanted']?.value}` });
    mk.append(sv('rect', { x: xw1 - 24, y: wy - 4, width: 48, height: 26, fill: 'transparent' }));
    mk.append(sv('rect', { x: xw1 - 22, y: wy + 1, width: 44, height: 16, rx: 8, class: 'kb' }));
    mk.append(txt(xw1, wy + 12.5, `×${fmtNum(d.margin, 3)}`, 'kt', 'middle'));
    svg.append(mk);

    // the Ts knob on one sample tick in the settled part
    const kH = Math.max(1, Math.round((B + d.window * 0.35) / Ts - phase));
    const tH = (kH + phase) * Ts;
    const inView = tH < t1 && tH > 0;
    let tk = null;
    if (inView) {
      const xh = x(tH), xp = x(tH - Ts);
      const yk = cntY + cntH + 2;
      tk = sv('g', { class: 'knob', tabindex: '0', role: 'slider', 'data-k': 'ts', 'aria-label': 'Sampling period Ts',
        'aria-valuenow': String(Ts), 'aria-valuetext': E(Ts) });
      if (xh - xp > 8) {
        tk.append(sv('path', { d: `M${xp} ${cntY + cntH - 2}V${cntY + cntH + 4}H${xh}V${cntY + cntH - 2}`, class: 'kline', fill: 'none' }));
      }
      tk.append(sv('line', { x1: xh, x2: xh, y1: pinY + 14, y2: yk, class: 'kline' }));
      const lab = `Ts ${E(Ts)}`;
      const kw = lab.length * 7 + 12;
      tk.append(sv('rect', { x: xh - kw / 2, y: yk - 1, width: kw, height: 16, rx: 8, class: 'kb' }));
      tk.append(txt(xh, yk + 10.5, lab, 'kt', 'middle'));
      svg.append(tk);
    }

    // ---- interaction
    const toT = (clientX) => {
      const r = (scope.querySelector('svg') || svg).getBoundingClientRect();
      return t0 + (((clientX - r.left) / r.width) * W - L) / plotW * (t1 - t0);
    };
    const drag = (el, onMove) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        st.drag = el.dataset.k;
        st.focus = el.dataset.k;
        // the svg is redrawn on every change: follow the pointer on the window
        const move = (ev) => onMove(toT(ev.clientX));
        const up = () => {
          st.drag = null;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          draw();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
    };
    drag(mk, (t) => setMargin((t - B) / B));
    mk.addEventListener('keydown', (e) => {
      const s = e.shiftKey ? 0.5 : 0.1;
      if (['ArrowRight', 'ArrowUp'].includes(e.key)) { e.preventDefault(); st.focus = 'margin'; setMargin(d.margin + s); }
      else if (['ArrowLeft', 'ArrowDown'].includes(e.key)) { e.preventDefault(); st.focus = 'margin'; setMargin(d.margin - s); }
    });
    if (tk) {
      drag(tk, (t) => setTs(Math.max(1e-5, t / (kH + phase))));
      tk.addEventListener('keydown', (e) => {
        if (['ArrowRight', 'ArrowUp'].includes(e.key)) { e.preventDefault(); st.focus = 'ts'; ladderStep(1); }
        else if (['ArrowLeft', 'ArrowDown'].includes(e.key)) { e.preventDefault(); st.focus = 'ts'; ladderStep(-1); }
      });
    }
    scope.replaceChildren(svg);
    if (st.focus === 'margin' || st.focus === 'ts') svg.querySelector(`.knob[data-k="${st.focus}"]`)?.focus({ preventScroll: true });
    if (!st.drag && st.focus !== 'cat') st.focus = null;

    drawRegister(d, v, hist);
  }

  // the shift-register form at the moment of acceptance
  function drawRegister(d, v, hist) {
    const n = d.regBits;
    if (!n) {
      regTitle.textContent = 'Shift register';
      bits.replaceChildren(h('div', { class: 'db-soft' }, `${d.N} samples do not fit a 32-bit register: use the counter form (C code tab).`));
      regCode.replaceChildren();
      return;
    }
    regTitle.textContent = `Shift-register form: uint${n}_t deb_hist at the moment of acceptance`;
    const last = hist.slice(-n);
    while (last.length < n) last.unshift(0);
    bits.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    bits.replaceChildren(...last.map((b, i) => {
      const bit = n - 1 - i;
      const inMask = bit < d.N;
      return h('div', { class: `db-bit${inMask ? ' m' : ''}${b ? ' one' : ''}`, title: `bit ${bit}: sample ${bit === 0 ? 'newest' : `${bit} before the newest`}${inMask ? ', in the mask' : ''}` },
        h('small', {}, n > 16 && bit % 4 && bit !== n - 1 ? '\u00a0' : String(bit)), h('b', {}, String(b)));
    }));
    const allOnes = last.slice(n - d.N).every((b) => b === 1);
    regCode.replaceChildren(h('span', { class: 'db-soft' }, 'deb_hist & DEB_MASK '), h('b', {}, d.mask),
      h('span', { class: 'db-soft' }, ` (${d.N} of ${n} bits) `), allOnes ? h('span', { class: 'ok' }, '== DEB_MASK → pressed') : h('span', {}, '≠ DEB_MASK → still bouncing'));
  }

  let lastW = 0;
  new ResizeObserver(() => {
    const w = Math.round(scope.clientWidth);
    if (w && Math.abs(w - lastW) > 2) { lastW = w; draw(); }
  }).observe(scope);
}
