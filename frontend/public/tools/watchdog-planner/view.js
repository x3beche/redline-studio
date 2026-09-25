// Watchdog Planner: the page is the watchdog's countdown. The trace is the
// time left before a reset, refilled by every feed and draining between
// them: first the worst gap (loop + longest task + interrupts), then the long
// blocking operation fed in chunks, then a hang where feeding stops and the
// counter runs out somewhere between the fast-clock and slow-clock timeout.
// Drag the gap's parts, the needed-timeout line (margin), the end of the long
// operation, the slow-clock reset (tolerance) and the allowed-hang limit.
// Every drawn number comes from run()'s result (result.plan).

const NS = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...kids) {
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
}
function sv(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const fmt = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(3))));
const fms = (v) => (v == null || !Number.isFinite(v) ? '–' : v >= 1000 ? `${fmt(v / 1000)} s` : `${fmt(v)} ms`);
const niceStep = (span, n) => {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};
const snap = (v, st) => Number((Math.round(v / st) * st).toPrecision(6));

const TARGETS = [
  ['stm32-iwdg', 'STM32 IWDG', 'LSI 32 kHz, prescaler ÷4…÷256, 12-bit reload'],
  ['avr', 'AVR WDT', '128 kHz, fixed steps 16 ms … 8 s'],
  ['nrf52', 'nRF52 WDT', '32.768 kHz, 32-bit CRV'],
  ['custom', 'Custom', 'Your own counter: clock, width, prescalers'],
];

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let res = null, P = null;
  let drag = null;

  // ---------- target strip ----------
  const tgt = h('div', { class: 'wd-targets', role: 'radiogroup', 'aria-label': 'Watchdog' });
  const tBtns = TARGETS.map(([v, name, sub], i) => h('button', { type: 'button', role: 'radio', 'data-v': v,
    onclick: () => ctx.set('target', v),
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
      e.preventDefault(); const n = TARGETS[clamp(i + d, 0, TARGETS.length - 1)][0]; ctx.set('target', n);
      requestAnimationFrame(() => tgt.querySelector(`[data-v="${n}"]`)?.focus());
    } }, h('b', {}, name), h('small', {}, sub)));
  tgt.append(...tBtns);

  // ---------- the countdown ----------
  const chart = sv(null, 'svg', { class: 'wd-chart', role: 'group', 'aria-label': 'Watchdog countdown: time left before reset' });
  const stageWarn = h('div', { class: 'wd-warns', 'aria-live': 'polite' });
  const stage = h('section', { class: 'wd-stage' }, h('div', { class: 'wd-box' }, chart));

  // numbers strip (keyboard path to every handle)
  const num = (key, label, unit, cls, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label, oninput: (e) => ctx.set(key, e.target.value) });
    const el = h('label', { class: `wd-num ${cls || ''}`, title: title || null }, h('i'), h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    el.sync = () => { if (document.activeElement !== inp) inp.value = ctx.raw[key] ?? ''; };
    return el;
  };
  const nums = [
    num('feedInterval', 'Loop', 'ms', 'c-loop', 'Normal feed interval: the loop or tick period'),
    num('wcet', 'Longest task', 'ms', 'c-wcet', 'Worst-case execution time of the slowest task between two feeds'),
    num('isr', 'Interrupts', 'ms', 'c-isr', 'Interrupt load within one gap'),
    num('margin', 'Margin', '×', 'c-margin', 'Timeout ÷ worst gap (1.5–3 is usual)'),
    num('longOp', 'Long operation', 'ms', 'c-lop', 'A one-off block: flash erase, modem wait (0 = none)'),
    num('tol', 'Clock tolerance', '±%', 'c-tol', 'Watchdog oscillator tolerance'),
    num('maxRecovery', 'Allowed hang', 'ms', 'c-hang', 'The latest a hung system may be reset'),
  ];
  const strip = h('div', { class: 'wd-strip' }, nums);
  const hint = h('div', { class: 'wd-hint' }, 'Drag the handles on the drawing: the three parts of the worst gap, the needed-timeout line, the end of the long operation, the slow-clock reset and the allowed-hang limit. Focus a handle and use the arrow keys.');

  // ---------- side: register, window, feed points ----------
  const reg = h('div', { class: 'wd-reg' });
  const custom = h('div', { class: 'wd-custom' },
    num('clock', 'Counter clock', 'Hz', '', 'Counter clock in Hz'),
    num('bits', 'Width', 'bit', '', 'Counter width'),
    num('maxDivExp', 'Largest ÷2^n, n', '', '', 'Prescalers 1, 2, 4 … 2^n are tried'));
  const winToggle = h('button', { type: 'button', class: 'wd-toggle', 'aria-pressed': 'false', onclick: () => ctx.set('windowed', !ctx.raw.windowed) }, 'Window watchdog');
  const winFields = h('div', { class: 'wd-winf' },
    num('windowPct', 'Opens at', '% of timeout', 'c-win', 'The window opens at this share of the timeout'),
    num('minGap', 'Shortest feed gap', 'ms', 'c-win', 'The quickest two feeds can follow each other'));
  const feeds = h('ol', { class: 'wd-feeds' });
  const side = h('aside', { class: 'wd-side' },
    h('section', { class: 'wd-card' }, h('div', { class: 'wd-cap' }, 'Register setting'), reg, custom),
    h('section', { class: 'wd-card' }, h('div', { class: 'wd-caprow' }, winToggle, h('span', { class: 'wd-sub' }, 'feeding too early also resets')), winFields),
    h('section', { class: 'wd-card' }, h('div', { class: 'wd-cap' }, 'Where to feed'), feeds),
    ctx.outputs);

  root.append(h('div', { class: 'wd' }, h('div', { class: 'wd-top' }, tgt), h('div', { class: 'wd-main' }, h('div', { class: 'wd-left' }, stage, stageWarn, strip, hint), side)));

  // ---------- scenario geometry (ms) ----------
  function scenario() {
    const G = P.gap, fi = P.feedInterval;
    const feedsAt = [0, G];          // feed at start and after the worst gap
    const chunks = [];               // long operation work pieces [a, b] and irq pieces
    let E = G;
    if (P.longOp > 0) {
      if (P.chunk != null && P.extraFeeds != null && P.chunk > 0) {
        let left = P.longOp, t = G;
        while (left > 1e-9 && chunks.length < 400) {
          const w = Math.min(P.chunk, left);
          chunks.push({ a: t, b: t + w, kind: 'work' }); t += w;
          chunks.push({ a: t, b: t + P.isr, kind: 'isr' }); t += P.isr;
          left -= w;
          feedsAt.push(t);
        }
        E = t;
      } else {
        chunks.push({ a: G, b: G + P.longOp, kind: 'work' });
        chunks.push({ a: G + P.longOp, b: G + P.longOp + P.isr, kind: 'isr' });
        E = G + P.longOp + P.isr; feedsAt.push(E);
      }
    }
    return { G, fi, feedsAt, chunks, E, hang: E };
  }

  // ---------- drawing ----------
  function draw() {
    const svg = chart; const focusKey = svg.contains(document.activeElement) ? document.activeElement.dataset.h : null;
    svg.replaceChildren();
    if (!P) return;
    const W = Math.max(300, Math.round(svg.clientWidth) || 800), H = Math.max(300, Math.round(svg.clientHeight) || 460);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const S = scenario();
    const narrow = W < 560;
    const mL = narrow ? 44 : 60, mR = narrow ? 10 : 20, mT = 30, mB = 76;
    // Three panels, each its own time scale: the worst gap, the long
    // operation, the hang. They share the vertical scale (time left).
    const hangSpan = Math.max(P.tSlow, P.maxRecovery || 0, P.tFast) * 1.12;
    let panels = drag?.panels;
    const inner = W - mL - mR;
    if (!panels) {
      const fr = P.longOp > 0 ? [0.3, 0.3, 0.4] : [0.42, 0, 0.58];
      let x = mL;
      panels = [];
      const add = (a, b, f, cap) => { if (f > 0) { panels.push({ a, b, x0: x, x1: x + f * inner, cap }); x += f * inner; } };
      add(0, S.G, fr[0], 'ms since a feed');
      add(S.G, S.E, fr[1], 'ms into the long operation');
      add(S.hang, S.hang + hangSpan, fr[2], 'ms since the last feed');
    }
    let yMax = drag ? drag.yMax : Math.max(P.tSlow, P.tMin) * 1.18;
    const xMax = panels.at(-1).b;
    const X = (t) => {
      const pn = panels.find((q) => t <= q.b + 1e-9) || panels.at(-1);
      return pn.x0 + ((t - pn.a) / (pn.b - pn.a || 1)) * (pn.x1 - pn.x0);
    };
    const Tx = (x, only) => {
      const pn = only || panels.find((q) => x <= q.x1) || panels.at(-1);
      return pn.a + ((x - pn.x0) / (pn.x1 - pn.x0 || 1)) * (pn.b - pn.a);
    };
    const Y = (v) => mT + (1 - v / yMax) * (H - mT - mB);
    const y0 = Y(0);
    svg.__s = { X, Tx, Y, yMax, panels, mL, mR, mT, mB, W, H, xMax };

    const defs = sv(svg, 'defs');
    const pat = sv(defs, 'pattern', { id: 'wd-hatch', patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' });
    sv(pat, 'line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'wd-hatchln' });

    // grid + axes, per panel
    panels.forEach((pn, i) => {
      const span = pn.b - pn.a, px = pn.x1 - pn.x0;
      const st = niceStep(span, Math.max(2, Math.floor(px / 70)));
      for (let t = 0; t <= span + 1e-9; t += st) {
        const x = pn.x0 + (t / span) * px;
        if (i > 0 && t === 0) continue;
        sv(svg, 'line', { x1: x, x2: x, y1: mT, y2: y0, class: 'wd-grid' });
        if (pn.x1 - x > 14 || i === panels.length - 1) sv(svg, 'text', { x, y: y0 + 13, class: 'wd-axt', 'text-anchor': t === 0 ? 'start' : 'middle' }, fmt(t));
      }
      if (i > 0) {
        sv(svg, 'line', { x1: pn.x0, x2: pn.x0, y1: mT - 14, y2: y0 + 18, class: 'wd-break' });
        sv(svg, 'path', { d: `M${pn.x0 - 4},${y0 + 3} l8,-6 M${pn.x0 - 4},${y0 + 8} l8,-6`, class: 'wd-break' });
      }
      if (px > 110) sv(svg, 'text', { x: pn.x1 - 4, y: y0 + 26, class: 'wd-axcap', 'text-anchor': 'end' }, pn.cap);
    });
    const ys = niceStep(yMax, Math.max(2, Math.floor((H - mT - mB) / 60)));
    for (let v = 0; v <= yMax + 1e-9; v += ys) {
      sv(svg, 'line', { x1: mL, x2: W - mR, y1: Y(v), y2: Y(v), class: 'wd-grid' });
      sv(svg, 'text', { x: mL - 6, y: Y(v) + 3, class: 'wd-axt', 'text-anchor': 'end' }, fmt(v));
    }
    sv(svg, 'text', { x: 12, y: (mT + y0) / 2, class: 'wd-axcap', 'text-anchor': 'middle', transform: `rotate(-90 12 ${(mT + y0) / 2})` }, 'time left before reset, ms');
    sv(svg, 'line', { x1: mL, x2: W - mR, y1: y0, y2: y0, class: 'wd-zero' });

    // phases along the top
    const phase = (a, b, label) => {
      if (X(b) - X(a) < 30) return;
      sv(svg, 'line', { x1: X(a) + 1, x2: X(b) - 1, y1: mT - 6, y2: mT - 6, class: 'wd-phase' });
      sv(svg, 'text', { x: (X(a) + X(b)) / 2, y: mT - 10, class: 'wd-phaset', 'text-anchor': 'middle' }, label);
    };
    phase(0, S.G, narrow ? 'gap' : `worst feed gap ${fms(S.G)}`);
    if (P.longOp > 0) phase(S.G, S.E, narrow ? 'long op' : P.extraFeeds ? `long operation, fed ${P.extraFeeds}× inside` : 'long operation, fed before');
    phase(S.hang, xMax, narrow ? 'hung' : 'hung: nothing feeds any more');

    // window: too-early zones after each feed
    if (P.window) {
      for (const f of S.feedsAt) {
        const r = sv(svg, 'rect', { x: X(f), y: mT, width: Math.max(0, X(Math.min(xMax, f + P.window.open)) - X(f)), height: y0 - mT, class: 'wd-early' });
        sv(r, 'title', {}, `Window closed until ${fms(P.window.open)} after a feed (slow clock): a feed here resets`);
      }
      const g = P.window.minGap;
      const bad = g < P.window.open;
      sv(svg, 'line', { x1: X(g), x2: X(g), y1: mT, y2: y0, class: bad ? 'wd-mingap is-bad' : 'wd-mingap' });
      sv(svg, 'text', { x: X(g) + 3, y: mT + 12, class: `wd-lab ${bad ? 'is-bad' : ''}` }, `fastest feed ${fms(g)}${bad ? ' – too early' : ''}`);
    }

    // needed timeout: margin × gap (dragable), and the band of real timeouts
    const lvl = (v, cls, label, anchorRight) => {
      sv(svg, 'line', { x1: mL, x2: W - mR, y1: Y(v), y2: Y(v), class: cls });
      if (label) sv(svg, 'text', { x: anchorRight ? W - mR - 4 : mL + 4, y: Y(v) - 4, class: 'wd-lab', 'text-anchor': anchorRight ? 'end' : 'start' }, label);
    };
    // sawtooth: fast (solid) and slow (dashed) clocks, band between
    const traceFor = (L) => {
      const pts = [];
      const fs = S.feedsAt;
      let dead = null;
      for (let i = 0; i < fs.length; i++) {
        const a = fs[i], b = i + 1 < fs.length ? fs[i + 1] : Math.min(xMax, a + L);
        pts.push([a, L]);
        const end = L - (b - a);
        if (end < 0) { pts.push([a + L, 0]); dead = a + L; break; }
        pts.push([b, end]);
      }
      if (dead == null) { const last = fs[fs.length - 1]; dead = last + L; }
      return { pts, dead };
    };
    const fast = traceFor(P.tFast), slow = traceFor(P.tSlow);
    // band polygon
    const band = [...slow.pts.map(([t, v]) => [t, v]), ...[...fast.pts].reverse()];
    sv(svg, 'path', { d: band.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('') + 'Z', class: 'wd-band' });
    const pathOf = (pts) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    sv(svg, 'path', { d: pathOf(slow.pts), class: 'wd-trace wd-slow' });
    sv(svg, 'path', { d: pathOf(fast.pts), class: 'wd-trace wd-fast' });

    // feeds
    S.feedsAt.forEach((f, i) => {
      if (i === 0) return;
      sv(svg, 'line', { x1: X(f), x2: X(f), y1: Y(P.tSlow), y2: y0 + 4, class: 'wd-feed' });
      sv(svg, 'circle', { cx: X(f), cy: y0 + 4, r: 2.6, class: 'wd-feedd' });
    });
    sv(svg, 'text', { x: X(S.feedsAt[1]) + 4, y: y0 - 4, class: 'wd-lab' }, 'feed');

    // headroom at the end of the worst gap
    const low = P.tFast - S.G;
    if (low > 0) {
      const x = X(S.G) - 6;
      sv(svg, 'line', { x1: x, x2: x, y1: Y(low), y2: y0, class: 'wd-dim' });
      sv(svg, 'text', { x: x - 4, y: (Y(low) + y0) / 2 + 3, class: 'wd-lab wd-labb', 'text-anchor': 'end' }, `${fms(low)} left`);
    } else {
      sv(svg, 'text', { x: X(S.G), y: y0 - 18, class: 'wd-lab is-bad', 'text-anchor': 'middle' }, 'resets in normal running');
    }

    // timeout levels
    lvl(P.tNom, 'wd-nom', null);
    sv(svg, 'text', { x: X(0) + 4, y: Y(P.tSlow) - 4, class: 'wd-lab' }, `slow clock ${fms(P.tSlow)}`);
    sv(svg, 'text', { x: X(0) + 4, y: Y(P.tFast) + 12, class: 'wd-lab wd-labb' }, `fast clock ${fms(P.tFast)}`);

    // margin handle: the needed timeout line
    {
      const y = Y(P.tMin), ok = P.tFast >= P.tMin - 1e-9;
      const g = sv(svg, 'g', { class: 'wd-h wd-hmargin', tabindex: 0, role: 'slider', 'data-h': 'margin', 'aria-label': `Safety margin ${fmt(P.margin)} times the worst gap`, 'aria-valuenow': P.margin });
      sv(g, 'rect', { x: mL, y: y - 5, width: W - mL - mR, height: 10, class: 'wd-hit' });
      sv(g, 'line', { x1: mL, x2: W - mR, y1: y, y2: y, class: ok ? 'wd-need' : 'wd-need is-bad' });
      const lx = X(S.G) + 8;
      sv(g, 'rect', { x: W - mR - (narrow ? 150 : 204), y: y - 9, width: narrow ? 146 : 200, height: 18, rx: 3, class: 'wd-tag' });
      sv(g, 'text', { x: W - mR - 6, y: y + 4, class: 'wd-tagt', 'text-anchor': 'end' }, `needed ${fmt(P.margin)} × ${fms(S.G)} = ${fms(P.tMin)}`);
      sv(g, 'path', { d: `M${lx},${y} m-6,0 l6,-6 l6,6 l-6,6 z`, class: 'wd-knob' });
    }

    // gap anatomy: loop | longest task | interrupts under the axis
    const yb = y0 + 34, hb = 14;
    const parts = [['loop', 0, P.feedInterval, 'c-loop', 'feedInterval', 'Loop'], ['wcet', P.feedInterval, P.feedInterval + P.wcet, 'c-wcet', 'wcet', 'Longest task'], ['isr', P.feedInterval + P.wcet, S.G, 'c-isr', 'isr', 'Interrupts']];
    for (const [k, a, b, cls, key, name] of parts) {
      sv(svg, 'rect', { x: X(a), y: yb, width: Math.max(0, X(b) - X(a)), height: hb, class: `wd-part ${cls}` });
      if (X(b) - X(a) > 34) sv(svg, 'text', { x: (X(a) + X(b)) / 2, y: yb + hb + 12, class: 'wd-lab', 'text-anchor': 'middle' }, `${narrow ? '' : name + ' '}${fmt(b - a)}`);
      const g = sv(svg, 'g', { class: 'wd-h wd-hx', tabindex: 0, role: 'slider', 'data-h': key, 'aria-label': `${name} ${fmt(b - a)} ms`, 'aria-valuenow': b - a });
      sv(g, 'rect', { x: X(b) - 6, y: yb - 6, width: 12, height: hb + 12, class: 'wd-hit' });
      sv(g, 'rect', { x: X(b) - 2, y: yb - 3, width: 4, height: hb + 6, rx: 1.5, class: `wd-grip ${cls}` });
    }
    // long operation bar
    for (const c of S.chunks) {
      sv(svg, 'rect', { x: X(c.a), y: yb, width: Math.max(0.5, X(c.b) - X(c.a)), height: hb, class: `wd-part ${c.kind === 'work' ? 'c-lop' : 'c-isr'}` });
    }
    if (P.longOp > 0) {
      if (X(S.E) - X(S.G) > 90) sv(svg, 'text', { x: (X(S.G) + X(S.E)) / 2, y: yb + hb + 12, class: 'wd-lab', 'text-anchor': 'middle' },
        P.chunk ? `${fms(P.longOp)} in chunks ≤ ${fms(P.chunk)}` : `${fms(P.longOp)}, fits`);
    }
    {
      const g = sv(svg, 'g', { class: 'wd-h wd-hx', tabindex: 0, role: 'slider', 'data-h': 'longOp', 'aria-label': `Long operation ${fmt(P.longOp)} ms`, 'aria-valuenow': P.longOp });
      const x = X(S.E);
      sv(g, 'rect', { x: x - 6, y: yb - 6, width: 12, height: hb + 12, class: 'wd-hit' });
      sv(g, 'rect', { x: x - 2, y: yb - 3, width: 4, height: hb + 6, rx: 1.5, class: 'wd-grip c-lop' });
    }

    // the hang: reset between fast and slow, allowed limit
    const rF = S.hang + P.tFast, rS = S.hang + P.tSlow;
    sv(svg, 'rect', { x: X(rF), y: mT, width: Math.max(1, X(rS) - X(rF)), height: y0 - mT, class: 'wd-resetband' });
    sv(svg, 'line', { x1: X(rF), x2: X(rF), y1: mT, y2: y0, class: 'wd-reset' });
    sv(svg, 'text', { x: X(rF) - 4, y: y0 - 8, class: 'wd-lab wd-labr', 'text-anchor': 'end' }, `reset ${fms(P.tFast)}`);
    if (P.maxRecovery != null) {
      const x = X(S.hang + P.maxRecovery), over = P.tSlow > P.maxRecovery;
      if (over) sv(svg, 'rect', { x, y: mT, width: Math.max(0, X(rS) - x), height: y0 - mT, class: 'wd-over', fill: 'url(#wd-hatch)' });
      const g = sv(svg, 'g', { class: 'wd-h wd-hx', tabindex: 0, role: 'slider', 'data-h': 'maxRecovery', 'aria-label': `Allowed hang ${fmt(P.maxRecovery)} ms`, 'aria-valuenow': P.maxRecovery });
      sv(g, 'rect', { x: x - 6, y: mT, width: 12, height: y0 - mT + 10, class: 'wd-hit' });
      sv(g, 'line', { x1: x, x2: x, y1: mT, y2: y0 + 6, class: over ? 'wd-limit is-bad' : 'wd-limit' });
      sv(g, 'rect', { x: x - 5, y: mT + 20, width: 10, height: 16, rx: 2, class: 'wd-limknob' });
      const right = x > W - mR - 150;
      sv(svg, 'text', { x: right ? x - 8 : x + 8, y: mT + 32, class: `wd-lab ${over ? 'is-bad' : ''}`, 'text-anchor': right ? 'end' : 'start' }, `allowed hang ${fms(P.maxRecovery)}`);
    }
    {
      // tolerance handle at the slow-clock reset
      const x = X(rS);
      const g = sv(svg, 'g', { class: 'wd-h wd-hx', tabindex: 0, role: 'slider', 'data-h': 'tol', 'aria-label': `Clock tolerance ±${fmt(P.tol)} %`, 'aria-valuenow': P.tol });
      sv(g, 'rect', { x: x - 6, y: mT, width: 12, height: y0 - mT, class: 'wd-hit' });
      sv(g, 'line', { x1: x, x2: x, y1: mT, y2: y0, class: 'wd-reset wd-resets' });
      sv(g, 'circle', { cx: x, cy: y0, r: 5, class: 'wd-tolknob' });
      sv(svg, 'text', { x: x + 4, y: y0 - 8, class: 'wd-lab wd-labr' }, `${fms(P.tSlow)} slow`);
      const mid = (X(rF) + X(rS)) / 2;
      if (X(rS) - X(rF) > 34) sv(svg, 'text', { x: mid, y: y0 - 24, class: 'wd-lab', 'text-anchor': 'middle' }, `±${fmt(P.tol)} %`);
    }
    // hang dimension
    {
      const yy = y0 + 58;
      sv(svg, 'line', { x1: X(S.hang), x2: X(rS), y1: yy, y2: yy, class: 'wd-dim' });
      sv(svg, 'line', { x1: X(S.hang), x2: X(S.hang), y1: yy - 4, y2: yy + 4, class: 'wd-dim' });
      sv(svg, 'text', { x: X(S.hang) + 3, y: yy - 3, class: 'wd-lab' }, 'last feed → reset');
    }

    if (focusKey) svg.querySelector(`[data-h="${focusKey}"]`)?.focus();
  }

  // ---------- manipulation ----------
  const val = (k) => ({ margin: P.margin, feedInterval: P.feedInterval, wcet: P.wcet, isr: P.isr, longOp: P.longOp, maxRecovery: P.maxRecovery ?? 0, tol: P.tol }[k]);
  function applyAt(k, t, v, start) {
    // t: time (ms) under the pointer, v: level (ms) under the pointer
    const S = scenario();
    const pn = chart.__s.panels.find((q) => k === 'maxRecovery' || k === 'tol' ? q.a >= S.hang - 1e-9 : k === 'longOp' ? q.a >= S.G - 1e-9 : true) || chart.__s.panels[0];
    const st = niceStep(pn.b - pn.a, 200);
    let out = null;
    if (k === 'margin') out = String(Math.max(1, Number((v / S.G).toFixed(2))));
    else if (k === 'feedInterval') out = String(Math.max(st, snap(t, st)));
    else if (k === 'wcet') out = String(Math.max(0, snap(t - P.feedInterval, st)));
    else if (k === 'isr') out = String(Math.max(0, snap(t - P.feedInterval - P.wcet, st)));
    else if (k === 'longOp') out = String(Math.max(0, snap(start.v + (t - start.t) * (P.chunk ? P.chunk / (P.chunk + P.isr) : 1), st)));
    else if (k === 'maxRecovery') out = String(Math.max(st, snap(t - S.hang, st)));
    else if (k === 'tol') { const d = t - S.hang; if (d > P.tNom) out = String(clamp(Number(((1 - P.tNom / d) * 100).toFixed(1)), 0, 80)); else out = '0'; }
    if (out != null) ctx.set(k, out);
  }
  chart.addEventListener('pointerdown', (e) => {
    const g = e.target.closest?.('[data-h]'); if (!g || !P) return;
    e.preventDefault();
    const s = chart.__s, r = chart.getBoundingClientRect();
    const k = g.dataset.h === 'feedInterval' ? 'feedInterval' : g.dataset.h;
    const px = e.clientX - r.left;
    // a handle keeps the scale of the panel it started in, even past its edge
    const pn = k === 'longOp' ? s.panels.find((q) => q.x1 >= px - 8) : s.panels.find((q) => px <= q.x1 + 7) || s.panels.at(-1);
    const t = s.Tx(px, pn);
    drag = { k, pn, panels: s.panels, yMax: s.yMax, start: { t, v: val(k) } };
    capture(chart, e); chart.classList.add('is-drag'); g.focus();
  });
  chart.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const s = chart.__s, r = chart.getBoundingClientRect();
    const t = s.Tx(e.clientX - r.left, drag.pn);
    const v = (1 - ((e.clientY - r.top) - s.mT) / (s.H - s.mT - s.mB)) * s.yMax;
    applyAt(drag.k, t, v, drag.start);
  });
  const end = () => { if (!drag) return; drag = null; chart.classList.remove('is-drag'); draw(); };
  chart.addEventListener('pointerup', end); chart.addEventListener('pointercancel', end);
  chart.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-h]'); if (!g || !P) return;
    const k = g.dataset.h;
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (!d) return;
    e.preventDefault();
    const big = e.shiftKey ? 10 : 1;
    const step = k === 'margin' ? 0.1 : k === 'tol' ? 1 : Math.max(0.1, niceStep(Math.max(1, val(k) || 10), 20));
    const nv = Math.max(k === 'margin' ? 1 : 0, Number((val(k) + d * step * big).toPrecision(6)));
    ctx.set(k, String(nv));
  });

  // ---------- side ----------
  function drawReg() {
    const bits = (n, v, label, hi) => h('div', { class: 'wd-field' },
      h('div', { class: 'wd-bits', style: `--n:${n}` }, Array.from({ length: n }, (_, i) => {
        const b = n - 1 - i, on = (Math.floor(v / 2 ** b) % 2) === 1;
        return h('span', { class: on ? 'on' : '', title: `bit ${b}` }, on ? '1' : '0');
      })),
      h('div', { class: 'wd-fname' }, h('b', {}, label), hi ? h('span', {}, hi) : null));
    const numIn = (s) => { const m = /(\d+)/.exec(String(s || '')); return m ? Number(m[1]) : 0; };
    const kids = [];
    if (P.target === 'stm32-iwdg') {
      const pr = numIn(P.prescaler), rlr = numIn(P.reload);
      kids.push(h('div', { class: 'wd-regrow' }, bits(3, pr, 'IWDG_PR', P.prescaler), bits(12, rlr, 'IWDG_RLR', `${rlr} = 0x${rlr.toString(16).toUpperCase()}`)));
      kids.push(h('div', { class: 'wd-formula' }, `t = 4·2^PR·(RLR+1) / f = ${P.count} ticks / ${fmt(P.f / 1000)} kHz`));
    } else if (P.target === 'avr') {
      const wdp = numIn(P.prescaler);
      kids.push(h('div', { class: 'wd-regrow' }, bits(4, wdp, 'WDTCSR.WDP[3:0]', `${P.reload}`)));
      kids.push(h('div', { class: 'wd-formula' }, `t = 2048·2^WDP / f = ${P.count} cycles / ${fmt(P.f / 1000)} kHz`));
    } else if (P.target === 'nrf52') {
      const crv = numIn(P.reload);
      kids.push(h('div', { class: 'wd-regrow' }, h('div', { class: 'wd-field' }, h('div', { class: 'wd-hex' }, `0x${crv.toString(16).toUpperCase().padStart(8, '0')}`), h('div', { class: 'wd-fname' }, h('b', {}, 'NRF_WDT->CRV'), h('span', {}, String(crv))))));
      kids.push(h('div', { class: 'wd-formula' }, `t = (CRV+1) / 32768 Hz`));
    } else {
      kids.push(h('div', { class: 'wd-regrow' }, h('div', { class: 'wd-field' }, h('div', { class: 'wd-hex' }, P.prescaler), h('div', { class: 'wd-fname' }, h('b', {}, 'prescaler'))),
        h('div', { class: 'wd-field' }, h('div', { class: 'wd-hex' }, P.reload), h('div', { class: 'wd-fname' }, h('b', {}, 'reload')))));
      kids.push(h('div', { class: 'wd-formula' }, `t = ${P.count} counts / ${fmt(P.f)} Hz`));
    }
    const clk = (name, f, t, tone) => h('div', { class: `wd-clk ${tone || ''}` }, h('span', {}, name), h('small', {}, `${fmt(f / 1000)} kHz`), h('b', {}, fms(t)));
    kids.push(h('div', { class: 'wd-clks' },
      clk('fast', P.fFast, P.tFast, P.tFast >= P.tMin - 1e-9 ? 'is-ok' : 'is-bad'),
      clk('nominal', P.f, P.tNom),
      clk('slow', P.fSlow, P.tSlow, P.maxRecovery != null && P.tSlow > P.maxRecovery ? 'is-bad' : '')));
    if (P.atMax) kids.push(h('div', { class: 'wd-bad' }, 'At its largest setting: cannot reach the needed timeout.'));
    reg.replaceChildren(...kids);
  }

  function drawSide() {
    const raw = ctx.raw;
    for (const b of tBtns) { const on = b.dataset.v === raw.target; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    for (const n of [...nums, ...custom.children, ...winFields.children]) n.sync?.();
    custom.hidden = raw.target !== 'custom';
    winToggle.setAttribute('aria-pressed', String(!!raw.windowed));
    winFields.hidden = !raw.windowed;
    if (P) drawReg(); else reg.replaceChildren();
    const ft = res?.tables?.find((t) => /Feed points/.test(t.title));
    feeds.replaceChildren(...(ft?.rows || []).map(([where, how, why]) => h('li', { class: /^Never/.test(where) ? 'is-never' : '' },
      h('div', {}, h('b', {}, where), h('span', {}, how)), h('small', {}, why))));
    stageWarn.replaceChildren(...(res?.warnings || []).map((w) => h('div', { class: 'wd-warn' }, w)));
  }

  ctx.onResult((r) => { res = r; P = r.plan || null; drawSide(); draw(); });
  let rz = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(draw); }).observe(stage);
}
