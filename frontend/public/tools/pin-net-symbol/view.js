// Pin-to-Net-to-Symbol Mapper, custom page: the MCU itself is the tool.
//   Part   - the MCU drawn as a quad package from its pin numbers (pin 1 top
//            left, counter-clockwise). Every pin's stub is coloured by its
//            status; outside it sit the PCB net and, further out, the firmware
//            symbol. Pins the netlist does not list are short grey stubs.
//            Click a pin (or arrow along them, Enter) to trace it: the trace
//            query is set to the most specific text that picks that one pin,
//            so the Prompt, the table and the CSV follow the drawing.
//            Typing a query lights the matching pins; the legend's statuses
//            light every pin in that state.
//   Trace  - the selected pin as a chain: firmware symbol (file line) -> pin
//            -> net -> every other part pin on that net, with its status.
//   Sources- the netlist and the firmware text, pasted in place.
// Every pin, net, symbol and status drawn comes from run()'s result.chip.
import { rowMatches } from './tool.js';

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
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const netShort = (n) => (/^unconnected-/i.test(n) ? 'unconnected' : n);

// Status -> css class and words (the statuses run() gives).
const ST = {
  ok: { c: 'ok', t: 'traced', say: 'The firmware names this pin and its net shares a word with the symbol.' },
  'names differ': { c: 'diff', t: 'names differ', say: 'The firmware names this pin, but the symbol and the net share no word: fine if intended, a classic swap if not.' },
  'firmware uses an unconnected pin': { c: 'dead', t: 'firmware on dead pin', say: 'The firmware drives this pin, but nothing else is on its net: wrong pin in the firmware, or a missing connection on the board.' },
  'not in firmware': { c: 'nofw', t: 'not in firmware', say: 'Connected on the board, but the firmware you pasted never names it (it may be set up by a peripheral\'s alternate function).' },
  'unnamed net, not in firmware': { c: 'nofw', t: 'not in firmware', say: 'Connected to an unnamed net, and the firmware never names it.' },
  power: { c: 'pwr', t: 'power', say: 'A supply or ground pin (recognised by the net name).' },
  unconnected: { c: 'nc', t: 'unconnected', say: 'Not connected on the board and not used by the firmware.' },
  'not a GPIO name': { c: 'other', t: 'other pin', say: 'Connected, but its pin name is not a GPIO name (a reset, boot or oscillator pin).' },
};
const LEGEND = [['ok', 'traced'], ['diff', 'names differ'], ['dead', 'firmware on dead pin'], ['nofw', 'not in firmware'], ['pwr', 'power'], ['other', 'other pin'], ['nc', 'unconnected']];
const st = (s) => ST[s] || { c: 'other', t: s, say: '' };

export function page(root, ctx) {
  const state = { focus: null, lit: null, compact: false, tab: 'netlist' };
  const chip = () => ctx.result?.chip || null;

  // ---------- skeleton ----------
  const refIn = h('input', { type: 'text', class: 'pn-in', 'aria-label': 'MCU reference', spellcheck: 'false', placeholder: 'auto' });
  refIn.addEventListener('input', () => ctx.set('mcu', refIn.value));
  const numSeg = h('div', { class: 'pn-seg', role: 'group', 'aria-label': 'Bare numbers mean' });
  const qIn = h('input', { type: 'search', class: 'pn-in pn-q', 'aria-label': 'Trace a pin, net or symbol', spellcheck: 'false', placeholder: 'PA5, 21, LED_STATUS, LED' });
  qIn.addEventListener('input', () => ctx.set('query', qIn.value));
  const legend = h('div', { class: 'pn-legend', role: 'group', 'aria-label': 'Light the pins in one state' });

  const svg = sv('svg', { class: 'pn-svg', role: 'group', 'aria-label': 'The MCU package: each pin with its net and firmware symbol' });
  const stage = h('div', { class: 'pn-stage' }, svg);
  const hint = h('div', { class: 'pn-hint' });
  const pinList = h('div', { class: 'pn-plist' });
  const partPanel = h('section', { class: 'pn-panel pn-part' },
    h('div', { class: 'pn-head' }, h('h2', {}, 'Part'),
      h('label', { class: 'pn-f' }, h('span', {}, 'MCU'), refIn),
      h('label', { class: 'pn-f' }, h('span', {}, 'Bare numbers'), numSeg),
      h('label', { class: 'pn-f pn-grow' }, h('span', {}, 'Trace'), qIn)),
    legend, stage, pinList, hint);

  const trace = h('div', { class: 'pn-trace', 'aria-live': 'polite' });
  const orphans = h('div', { class: 'pn-orph' });
  const tracePanel = h('section', { class: 'pn-panel pn-tracep' }, h('div', { class: 'pn-head' }, h('h2', {}, 'Trace')), trace, orphans);

  const srcTabs = h('div', { class: 'pn-seg', role: 'tablist' });
  const srcHelp = h('div', { class: 'pn-srchelp' });
  const netTa = h('textarea', { class: 'pn-ta', spellcheck: 'false', 'aria-label': 'Netlist (KiCad .net or CSV ref,pin,name,net)' });
  const fwTa = h('textarea', { class: 'pn-ta', spellcheck: 'false', 'aria-label': 'Firmware pin definitions' });
  netTa.addEventListener('input', () => ctx.set('netlist', netTa.value));
  fwTa.addEventListener('input', () => ctx.set('firmware', fwTa.value));
  const srcPanel = h('section', { class: 'pn-panel pn-src' }, h('div', { class: 'pn-head' }, h('h2', {}, 'Sources'), srcTabs), srcHelp, netTa, fwTa);

  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  root.append(h('div', { class: 'pn' },
    h('div', { class: 'pn-work' }, partPanel, h('div', { class: 'pn-side' }, tracePanel, srcPanel)),
    h('div', { class: 'pn-bottom' }, h('div', { class: 'pn-msgs' }, warns, notes), ctx.outputs)));

  // ---------- selection = the trace query ----------
  const asRow = (p) => [p.pin, p.name || '–', p.net, p.symbols.map((s) => s.sym).join(', ') || '–'];
  const selected = () => {
    const c = chip(); if (!c || !c.query) return null;
    const m = c.pins.filter((p) => p.match);
    return m.length === 1 ? m[0] : null;
  };
  /** The shortest text the tool's own query rule narrows to this one pin. */
  function queryFor(p) {
    const c = chip(); if (!c) return p.pin;
    const rows = c.pins.map(asRow);
    const cands = [p.name, p.net.replace(/^\//, ''), p.symbols[0]?.sym, p.pin].filter(Boolean);
    for (const q of cands) if (rows.filter((r) => rowMatches(r, q.toLowerCase())).length === 1) return q;
    return p.pin;
  }
  const pick = (p) => {
    const sel = selected();
    state.focus = p ? p.pin : state.focus;
    ctx.set('query', p && (!sel || sel.pin !== p.pin) ? queryFor(p) : '');
  };

  // ---------- the package ----------
  function geometry(c) {
    const nums = c.pins.map((p) => +p.pin);
    const numeric = nums.every((n) => Number.isInteger(n) && n > 0);
    let N = numeric ? Math.max(...nums, 8) : c.pins.length;
    N = Math.max(8, Math.ceil(N / 4) * 4);
    const n = N / 4;
    const P = n > 40 ? 12 : n > 25 ? 15 : 20;               // pin pitch
    const stub = 16, lab = state.compact ? 22 : 200;
    const M = stub + lab;
    const c0 = 3 * P;                                        // corner room, so corner pins' names never meet
    const B = 2 * c0 + (n - 1) * P;
    // pin number -> slot (index 0..N-1), for non-numeric pins their order
    const slot = new Map();
    c.pins.forEach((p, i) => slot.set(p.pin, numeric ? +p.pin - 1 : i));
    const at = (k) => {
      const side = Math.floor(k / n), i = k % n;
      if (side === 0) return { side: 'L', x: M, y: M + c0 + P * i };
      if (side === 1) return { side: 'B', x: M + c0 + P * i, y: M + B };
      if (side === 2) return { side: 'R', x: M + B, y: M + B - c0 - P * i };
      return { side: 'T', x: M + B - c0 - P * i, y: M };
    };
    return { N, n, P, stub, lab, M, B, W: 2 * M + B, slot, at, numeric };
  }

  function drawPart(c) {
    svg.replaceChildren();
    if (!c || !c.pins.length) {
      svg.setAttribute('viewBox', '0 0 600 200');
      svg.append(sv('text', { x: 300, y: 100, class: 'pn-t soft', 'text-anchor': 'middle' }, 'No MCU pins yet: paste the netlist under Sources.'));
      return;
    }
    const g = geometry(c);
    svg.setAttribute('viewBox', `0 0 ${g.W} ${g.W}`);
    svg.classList.toggle('compact', state.compact);
    const has = new Map(c.pins.map((p) => [g.slot.get(p.pin), p]));
    const sel = selected();
    const anyMatch = !!c.query;
    // body
    svg.append(sv('rect', { x: g.M, y: g.M, width: g.B, height: g.B, rx: 6, class: 'pn-body' }),
      sv('circle', { cx: g.M + g.P * 1.2, cy: g.M + g.P * 1.2, r: Math.max(3, g.P * 0.25), class: 'pn-dot1' }));
    const cx = g.M + g.B / 2, cy = g.M + g.B / 2;
    svg.append(sv('text', { x: cx, y: cy - 8, class: 'pn-ref', 'text-anchor': 'middle' }, c.ref || '?'),
      sv('text', { x: cx, y: cy + 14, class: 'pn-t soft', 'text-anchor': 'middle' }, `${g.N}-pin outline · ${c.pinCount} in the netlist`),
      sv('text', { x: cx, y: cy + 30, class: 'pn-t soft', 'text-anchor': 'middle' }, c.format || ''));
    // unused slots
    for (let k = 0; k < g.N; k++) {
      if (has.has(k)) continue;
      const a = g.at(k);
      const [dx, dy] = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] }[a.side];
      svg.append(sv('line', { x1: a.x, y1: a.y, x2: a.x + dx * g.stub * 0.55, y2: a.y + dy * g.stub * 0.55, class: 'pn-stub none' }));
    }
    // pins
    const order = [...c.pins].sort((p, q) => g.slot.get(p.pin) - g.slot.get(q.pin));
    const tabPin = sel?.pin ?? state.focus ?? order.find((p) => p.status !== 'power')?.pin ?? order[0].pin;
    for (const p of order) {
      const k = g.slot.get(p.pin); if (k == null || k >= g.N) continue;
      const a = g.at(k), s = st(p.status);
      const [dx, dy] = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] }[a.side];
      const vert = a.side === 'T' || a.side === 'B';
      const out = (d) => ({ x: a.x + dx * d, y: a.y + dy * d });
      const dim = (anyMatch && !p.match) || (state.lit && s.c !== state.lit);
      const on = sel?.pin === p.pin;
      const grp = sv('g', { class: `pn-pin s-${s.c}${dim ? ' dim' : ''}${on ? ' on' : ''}${p.match ? ' hit' : ''}`, 'data-pin': p.pin,
        tabindex: p.pin === tabPin ? 0 : -1, role: 'button',
        'aria-label': `Pin ${p.pin} ${p.name}: net ${netShort(p.net)}${p.symbols.length ? `, firmware ${p.symbols.map((x) => x.sym).join(', ')}` : ''}, ${s.t}. Arrows move along the pins, Enter traces.` });
      grp.append(sv('title', {}, `Pin ${p.pin} ${p.name} · ${netShort(p.net)} · ${p.symbols.map((x) => x.sym).join(', ') || 'no firmware symbol'} · ${s.t}`));
      const tip = out(g.stub);
      // hit area covering stub and label
      const netLen = cut(netShort(p.net).replace(/^\//, ''), 20).length;
      const symLen = p.symbols.length ? cut(p.symbols.map((x) => x.sym).join(', '), 18).length + 2 : st(p.status).c === 'nofw' ? 11 : 0;
      const reach = g.stub + (state.compact ? 4 : Math.min(g.lab - 4, 14 + (netLen + symLen) * 6.8));
      const hw = g.P / 2;
      const hr = vert
        ? { x: a.x - hw, y: Math.min(a.y, a.y + dy * reach), width: g.P, height: reach }
        : { x: Math.min(a.x, a.x + dx * reach), y: a.y - hw, width: reach, height: g.P };
      grp.append(sv('rect', { ...hr, class: 'pn-hit' }));
      grp.append(sv('rect', { ...(vert ? { x: a.x - hw + 1, y: Math.min(a.y, a.y + dy * reach), width: g.P - 2, height: reach } : { x: Math.min(a.x, a.x + dx * reach), y: a.y - hw + 1, width: reach, height: g.P - 2 }), rx: 3, class: 'pn-hl' }));
      grp.append(sv('line', { x1: a.x, y1: a.y, x2: tip.x, y2: tip.y, class: 'pn-stub' }));
      grp.append(sv('circle', { cx: tip.x, cy: tip.y, r: g.P > 14 ? 3.2 : 2.4, class: 'pn-end' }));
      // inside: number and pin name
      const inn = (d) => ({ x: a.x - dx * d, y: a.y - dy * d });
      const ip = inn(5);
      const rot = (x, y) => (vert ? `rotate(-90 ${x} ${y})` : null);
      const inAnchor = a.side === 'L' || a.side === 'B' ? 'start' : 'end';
      const it = sv('text', { x: ip.x, y: ip.y + (vert ? 0 : 3.5), class: 'pn-in-t', 'text-anchor': inAnchor, transform: rot(ip.x, ip.y), dy: vert ? 3.5 : null });
      it.append(sv('tspan', { class: 'num' }, p.pin), sv('tspan', { dx: 4 }, cut(p.name || '', g.P > 14 ? 12 : 9)));
      grp.append(it);
      // outside: net, then the firmware symbol
      if (!state.compact) {
        const lp = out(g.stub + 7);
        const anchor = a.side === 'L' || a.side === 'B' ? 'end' : 'start';
        const t = sv('text', { x: lp.x, y: lp.y + (vert ? 0 : 3.8), class: 'pn-lab', 'text-anchor': anchor, transform: rot(lp.x, lp.y), dy: vert ? 3.8 : null });
        const netT = sv('tspan', { class: `net${p.status === 'power' ? ' pwr' : ''}${p.unconnected ? ' nc' : ''}` }, cut(netShort(p.net).replace(/^\//, ''), 20));
        const symTxt = p.symbols.length ? cut(p.symbols.map((x) => x.sym).join(', '), 18)
          : s.c === 'nofw' ? 'no symbol' : '';
        const symT = symTxt ? sv('tspan', { class: `sym${p.symbols.length ? '' : ' missing'}` }, symTxt) : null;
        // read outwards from the pin: net first, then symbol
        if (anchor === 'start') { t.append(netT); if (symT) { symT.setAttribute('dx', 9); t.append(symT); } }
        else { if (symT) { t.append(symT); netT.setAttribute('dx', 9); } t.append(netT); }
        grp.append(t);
      }
      svg.append(grp);
    }
    // restore focus on the pin the keyboard is on
    if (state.refocus) {
      const el = svg.querySelector(`.pn-pin[data-pin="${CSS.escape(state.refocus)}"]`);
      state.refocus = null;
      el?.focus({ preventScroll: true });
    }
  }

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.pn-pin');
    const c = chip(); if (!c) return;
    if (!g) { if (c.query) ctx.set('query', ''); return; }
    const p = c.pins.find((x) => x.pin === g.dataset.pin);
    if (p) { state.refocus = p.pin; pick(p); }
  });
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest('.pn-pin'); const c = chip();
    if (!g || !c) return;
    const geo = geometry(c);
    const order = [...c.pins].sort((p, q) => geo.slot.get(p.pin) - geo.slot.get(q.pin));
    const i = order.findIndex((p) => p.pin === g.dataset.pin);
    let j = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = (i + 1) % order.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = (i - 1 + order.length) % order.length;
    else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = order.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.refocus = order[i].pin; pick(order[i]); return; }
    else if (e.key === 'Escape') { e.preventDefault(); state.refocus = order[i].pin; ctx.set('query', ''); return; }
    if (j == null) return;
    e.preventDefault();
    const p = order[j];
    state.focus = p.pin; state.refocus = p.pin;
    // with a trace showing, the trace follows the keyboard
    if (selected()) ctx.set('query', queryFor(p)); else drawPart(c);
  });

  // ---------- trace ----------
  function drawTrace(c) {
    const p = selected();
    trace.replaceChildren();
    if (!c) return;
    if (!p) {
      const m = c.query ? c.pins.filter((x) => x.match) : [];
      trace.append(h('div', { class: 'pn-empty' }, c.query
        ? (m.length ? `"${c.query}" matches ${m.length} pins (lit on the part). Click one to trace it.` : `Nothing on ${c.ref} matches "${c.query}".`)
        : 'Click a pin on the part to trace it from the firmware symbol to every part pin on its net.'));
      if (!c.query) {
        // the pins worth a look first, worst first
        const rank = { dead: 0, diff: 1, nofw: 2 };
        const look = c.pins.filter((x) => st(x.status).c in rank).sort((a, b) => rank[st(a.status).c] - rank[st(b.status).c]);
        if (look.length) trace.append(h('div', { class: 'pn-sec soft' }, 'Worth a look'), h('div', { class: 'pn-look' }, look.map((x) => h('button', { type: 'button', class: `pn-lrow s-${st(x.status).c}`, onclick: () => pick(x) },
          h('i'), h('b', {}, `${x.pin} ${x.name}`), h('span', {}, netShort(x.net).replace(/^\//, '')), h('span', { class: 'sy' }, x.symbols.map((y) => y.sym).join(', ') || '–'), h('small', {}, st(x.status).t)))));
        else trace.append(h('div', { class: 'pn-verdict s-ok' }, h('b', {}, 'All traced.'), ' Every connected GPIO has a firmware symbol whose name fits its net.'));
      }
      if (m.length > 1) trace.append(h('div', { class: 'pn-chips' }, m.map((x) => h('button', { class: `pn-chip s-${st(x.status).c}`, onclick: () => pick(x) }, `${x.pin} ${x.name}`))));
      return;
    }
    const s = st(p.status);
    const step = (k, main, sub, cls = '') => h('div', { class: `pn-step ${cls}` }, h('span', { class: 'k' }, k), h('div', { class: 'v' }, h('b', {}, main), sub ? h('small', {}, sub) : null));
    const fw = p.symbols.length
      ? p.symbols.map((x) => step('Firmware', x.sym, `line ${x.line} · ${x.how}`, `fw s-${s.c}`))
      : [step('Firmware', 'no symbol', p.status === 'power' ? 'supply pin' : 'the firmware does not name this pin', 'fw none')];
    const others = p.others;
    trace.append(h('div', { class: 'pn-chain' },
      ...fw,
      step('Pin', `${c.ref}.${p.pin}  ${p.name || ''}`, [p.key && p.key !== p.name ? `port key ${p.key}` : null, p.type || null].filter(Boolean).join(' · '), 'pin'),
      step('Net', netShort(p.net), p.unconnected ? 'nothing else on this net' : `${others.length} other pin${others.length === 1 ? '' : 's'}`, `net${p.unconnected ? ' dead' : ''}`),
      others.length ? h('div', { class: 'pn-fan' }, others.slice(0, 14).map((o) => h('div', { class: 'pn-node' }, h('b', {}, `${o.ref}.${o.pin}`), o.name ? ` ${o.name}` : '', o.type ? h('small', {}, ` ${o.type}`) : null)),
        others.length > 14 ? h('div', { class: 'pn-node soft' }, `+${others.length - 14} more`) : null) : null),
    h('div', { class: `pn-verdict s-${s.c}` }, h('b', {}, s.t), ' ', s.say));
  }

  function drawOrphans(c) {
    orphans.replaceChildren();
    if (!c || !c.orphans.length) return;
    orphans.append(h('div', { class: 'pn-sec' }, `Firmware symbols with no pin on ${c.ref}`),
      ...c.orphans.map((o) => h('div', { class: 'pn-orow' }, h('b', {}, o.sym), h('span', { class: 'arrow' }, '→'), h('code', {}, o.key), h('small', {}, `line ${o.line}`))),
      h('div', { class: 'pn-srchelp' }, 'Check the port letter, or the package\'s pin list.'));
  }

  function drawLegend(c) {
    const count = (cls) => (c ? c.pins.filter((p) => st(p.status).c === cls).length : 0);
    legend.replaceChildren(...LEGEND.map(([cls, label]) => {
      const n = count(cls);
      return h('button', { type: 'button', class: `pn-lg s-${cls}`, 'aria-pressed': String(state.lit === cls), disabled: !n && state.lit !== cls,
        title: `Light the ${label} pins`, onclick: () => { state.lit = state.lit === cls ? null : cls; render(); } },
      h('i'), label, h('b', {}, n));
    }), ...(c && c.orphans.length ? [h('span', { class: 'pn-lg s-dead static' }, h('i', { class: 'x' }), 'symbols with no pin', h('b', {}, c.orphans.length))] : []));
  }

  function drawPinList(c) {
    pinList.replaceChildren();
    if (!state.compact || !c) return;
    const sel = selected();
    for (const p of c.pins) {
      if (p.status === 'unconnected') continue;
      const s = st(p.status);
      pinList.append(h('button', { type: 'button', class: `pn-prow s-${s.c}${sel?.pin === p.pin ? ' on' : ''}${(c.query && !p.match) || (state.lit && state.lit !== s.c) ? ' dim' : ''}`, onclick: () => pick(p) },
        h('i'), h('b', {}, p.pin), h('span', { class: 'nm' }, p.name), h('span', { class: 'nt' }, netShort(p.net).replace(/^\//, '')), h('span', { class: 'sy' }, p.symbols.map((x) => x.sym).join(', '))));
    }
  }

  function drawControls() {
    const raw = ctx.raw;
    if (document.activeElement !== refIn) refIn.value = raw.mcu ?? '';
    if (document.activeElement !== qIn) qIn.value = raw.query ?? '';
    if (document.activeElement !== netTa) netTa.value = raw.netlist ?? '';
    if (document.activeElement !== fwTa) fwTa.value = raw.firmware ?? '';
    const nm = raw.numbers || 'none';
    numSeg.replaceChildren(...[['none', 'pin nos.'], ['gpio', 'GPIO nos.']].map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(nm === v), title: v === 'gpio' ? 'LED_PIN = 2 means GPIO2 (ESP32, RP2040)' : 'Bare numbers are not pins (STM32, AVR)', onclick: () => ctx.set('numbers', v) }, t)));
    srcTabs.replaceChildren(...[['netlist', 'Netlist'], ['firmware', 'Firmware']].map(([v, t]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(state.tab === v), 'aria-pressed': String(state.tab === v), onclick: () => { state.tab = v; drawControls(); } }, t)));
    netTa.hidden = state.tab !== 'netlist'; fwTa.hidden = state.tab !== 'firmware';
    srcHelp.textContent = state.tab === 'netlist'
      ? 'KiCad: File > Export > Netlist (KiCad format), paste the file. Or CSV lines ref,pin,name,net.'
      : 'main.h / board.h / pins.h defines and consts, or a devicetree overlay (gpios = <&gpioa 5 …>).';
  }

  function render() {
    const res = ctx.result; if (!res) return;
    const c = res.chip || null;
    drawControls();
    drawLegend(c);
    drawPart(c);
    drawPinList(c);
    drawTrace(c);
    drawOrphans(c);
    hint.textContent = state.compact
      ? 'Tap a pin or a row to trace it.'
      : 'Click a pin to trace it (again to clear) · focused pin: arrows move along the pins, Enter traces, Esc clears · labels read outwards: net, then firmware symbol.';
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
  }
  new ResizeObserver(() => {
    const c = stage.clientWidth < 560;
    if (c !== state.compact) { state.compact = c; render(); }
  }).observe(stage);
  ctx.onResult(() => render());
}
