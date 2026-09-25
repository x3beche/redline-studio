// Length Matching Budget page: a slide rule between time and copper. The top
// scale is the bit rate (drag the cursor, click an interface). Below it one
// unit interval is drawn in time, two lanes with the allowed skew as a window
// you drag; right under it, at the same horizontal scale, is the copper a
// wavefront covers in that interval, with the allowed mismatch drawn as a
// length-tuning meander to scale. The layer card sets the propagation delay
// that links the two. Every number shown comes from tool.js run().

const NS = 'http://www.w3.org/2000/svg';
const R_MIN = 1e8, R_MAX = 64e9;
const MARKS = [
  [480e6, 'USB 2.0'], [1.25e9, '1000BASE-X'], [1.6e9, 'DDR3-1600'], [2.5e9, 'PCIe 1'], [3.2e9, 'DDR4-3200'],
  [5e9, 'USB 3 / PCIe 2'], [6e9, 'SATA 3'], [6.4e9, 'DDR5-6400'], [8e9, 'PCIe 3'], [10e9, 'USB 3.2 / 10G'],
  [16e9, 'PCIe 4'], [32e9, 'PCIe 5'],
];
const BASIS = [['intra', 'P to N', 5], ['lanes', 'lane to lane', 10], ['bus', 'bus to clock', 15]];
const ER = [['4.2', 'FR-4'], ['3.7', 'mid-loss'], ['3.0', 'Rogers']];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const PFX = { p: 1e-12, n: 1e-9, 'µ': 1e-6, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9 };
const num = (t) => { const m = /(-?[\d.]+(?:e[-+]?\d+)?)\s*([pnµumkMG]?)/.exec(String(t ?? '')); return m ? Number(m[1]) * (PFX[m[2]] ?? 1) : null; };
const plain = (t) => { const m = /(-?[\d.]+(?:e[-+]?\d+)?)/.exec(String(t ?? '')); return m ? Number(m[1]) : null; };
const r3 = (v) => String(Number(Number(v).toPrecision(3)));
const rateText = (v) => (v >= 1e9 ? `${r3(v / 1e9)}G` : `${r3(v / 1e6)}M`);
const rateShow = (v) => (v >= 1e9 ? `${r3(v / 1e9)} Gb/s` : `${r3(v / 1e6)} Mb/s`);
const niceStep = (span, n) => { const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
function s(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
function onDrag(el, svg, fn, done) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); capture(el, e);
    const pt = svg.createSVGPoint();
    const at = (ev) => { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
    fn(at(e), true);
    const move = (ev) => fn(at(ev), false);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); done?.(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
}

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let res = null, refocus = null, holdWin = null;

  // ---------- rate ruler ----------
  const rateIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', id: 'lm-rate', 'aria-label': 'Bit rate per lane in bit/s, e.g. 5G or 3200M',
    oninput: () => ctx.set('rate', rateIn.value) });
  const rateSvg = s(null, 'svg', { class: 'lm-rate', role: 'group', 'aria-label': 'Bit rate, logarithmic scale with common interfaces' });
  const rateCard = h('section', { class: 'lm-card lm-ratecard' },
    h('div', { class: 'lm-head' }, h('b', {}, 'Bit rate per lane'),
      h('label', { class: 'lm-f', for: 'lm-rate' }, rateIn, h('small', {}, 'b/s')),
      h('span', { class: 'lm-hint' }, 'drag the cursor or click an interface · DDR: the transfer rate (MT/s)')),
    h('div', { class: 'lm-ratebox' }, rateSvg));

  // ---------- the rule: time over copper ----------
  const basisBar = h('div', { class: 'lm-basis', role: 'radiogroup', 'aria-label': 'What is being matched' });
  const basisBtns = BASIS.map(([v, t, p]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set('basis', v) }, h('b', {}, `${p} %`), ` ${t}`));
  const shareIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', id: 'lm-share', 'aria-label': 'Custom share of the UI in percent',
    oninput: () => ctx.setMany({ basis: 'custom', share: shareIn.value }) });
  const customBtn = h('label', { class: 'lm-custom', for: 'lm-share', 'data-v': 'custom' }, 'custom', shareIn, h('small', {}, '%'));
  basisBar.append(...basisBtns, customBtn);
  basisBar.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d || e.target === shareIn) return;
    e.preventDefault();
    const i = clamp(BASIS.findIndex((b) => b[0] === ctx.input.basis) + d, 0, BASIS.length - 1);
    ctx.set('basis', BASIS[i][0]); refocus = `basis-${BASIS[i][0]}`;
  });
  const ruleSvg = s(null, 'svg', { class: 'lm-rule', role: 'group', 'aria-label': 'One unit interval in time, and the copper it covers' });
  const big = h('div', { class: 'lm-big', 'aria-live': 'polite' });
  const ruleCard = h('section', { class: 'lm-card lm-rulecard' },
    h('div', { class: 'lm-head' }, h('b', {}, 'Skew budget'), basisBar, big),
    h('div', { class: 'lm-rulebox' }, ruleSvg));

  // ---------- layer ----------
  const layerSvg = s(null, 'svg', { class: 'lm-xs', viewBox: '0 0 220 90', role: 'group', 'aria-label': 'Routing layer cross-section' });
  const layerSeg = h('div', { class: 'lm-seg', role: 'radiogroup', 'aria-label': 'Routing layer' },
    ...[['stripline', 'Stripline (inner)'], ['microstrip', 'Microstrip (outer)']].map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v,
      onclick: () => ctx.set('layer', v),
      onkeydown: (e) => { if (/Arrow/.test(e.key)) { e.preventDefault(); const n = v === 'stripline' ? 'microstrip' : 'stripline'; ctx.set('layer', n); refocus = `layer-${n}`; } } }, t)));
  const erIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', id: 'lm-er', oninput: () => ctx.set('er', erIn.value) });
  const whIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', id: 'lm-wh', oninput: () => ctx.set('wh', whIn.value) });
  const erChips = h('span', { class: 'lm-chips' }, ...ER.map(([v, t]) => h('button', { type: 'button', class: 'lm-chip', 'data-v': v, title: `εr ${v}`, onclick: () => ctx.set('er', v) }, t)));
  const whField = h('label', { class: 'lm-f', for: 'lm-wh' }, h('span', {}, 'w / h'), whIn);
  const delay = h('div', { class: 'lm-delay' });
  const layerCard = h('section', { class: 'lm-card lm-layer' },
    h('div', { class: 'lm-head' }, h('b', {}, 'Routing layer'), layerSeg),
    h('div', { class: 'lm-layerbody' }, h('div', { class: 'lm-xsbox' }, layerSvg),
      h('div', { class: 'lm-layerf' },
        h('label', { class: 'lm-f', for: 'lm-er' }, h('span', {}, 'εr'), erIn), erChips, whField, delay)));

  const warns = h('div', { class: 'lm-warns', role: 'status' });
  const notes = h('details', { class: 'lm-notes' });
  const shares = h('section', { class: 'lm-card lm-shares' });
  const bottom = h('div', { class: 'lm-bottom' }, layerCard, h('div', { class: 'lm-col' }, warns, shares, notes), ctx.outputs);

  root.append(h('div', { class: 'lm' }, rateCard, ruleCard, bottom));

  // ---------- result ----------
  function R() {
    const vals = res?.values || [];
    const by = (re) => vals.find((v) => re.test(v.label));
    const ui = by(/^Unit interval/), skew = by(/^Skew budget/), mm = by(/^Max length/), pd = by(/^Propagation/);
    const out = {
      ok: !!(ui && skew && mm && pd),
      uiPs: ui ? num(ui.value) * 1e12 : null, uiT: ui?.value,
      skewPs: skew ? plain(skew.value) : null, skewT: skew?.value, shareT: skew?.hint, tone: skew?.tone,
      mm: mm ? plain(mm.value) : null, mmT: mm?.value, milT: mm?.hint,
      psmm: pd ? plain(pd.value) : null, pdT: pd?.value, pdHint: pd?.hint,
      rates: (res?.tables?.[1]?.rows || []).map((r) => ({ rate: num(r[0].replace('b/s', '')), len: plain(r[3]), lenT: r[3] })),
      shares: res?.tables?.[0],
    };
    out.frac = out.uiPs && out.skewPs != null ? out.skewPs / out.uiPs : null;
    return out;
  }

  // ---------- rate ruler ----------
  function drawRate(r) {
    rateSvg.replaceChildren();
    const W = Math.max(300, rateSvg.parentNode.clientWidth), H = 96;
    rateSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 16, Rr = W - 16, base = 58;
    const X = (v) => L + (Math.log10(v / R_MIN) / Math.log10(R_MAX / R_MIN)) * (Rr - L);
    const V = (x) => R_MIN * 10 ** (((x - L) / (Rr - L)) * Math.log10(R_MAX / R_MIN));
    s(rateSvg, 'line', { x1: L, x2: Rr, y1: base, y2: base, class: 'lm-axis' });
    for (let d = 1e8; d <= R_MAX; d *= 10) for (const m of [1, 2, 5]) {
      const v = d * m; if (v > R_MAX) continue;
      s(rateSvg, 'line', { x1: X(v), x2: X(v), y1: base, y2: base + (m === 1 ? 8 : 5), class: 'lm-tickl' });
      if (m === 1 || W > 700) s(rateSvg, 'text', { x: X(v), y: base + 19, class: 'lm-tick', 'text-anchor': 'middle' }, v >= 1e9 ? `${v / 1e9}G` : `${v / 1e6}M`);
    }
    // budget at other rates, from run(): a bar per rate, height ~ log length
    const lens = r.rates.filter((q) => q.rate && q.len > 0);
    if (lens.length) {
      const lmax = Math.max(...lens.map((q) => q.len));
      for (const q of lens) {
        const hgt = 4 + 18 * (Math.log10(q.len * 10 + 1) / Math.log10(lmax * 10 + 1));
        s(rateSvg, 'rect', { x: X(q.rate) - 2, y: base - hgt, width: 4, height: hgt, class: 'lm-rbar' });
        if (W > 560 && Math.abs(X(q.rate) - X(clamp(ctx.input.rate || 1, R_MIN, R_MAX))) > 40) s(rateSvg, 'text', { x: X(q.rate), y: base - hgt - 3, class: 'lm-rbartxt', 'text-anchor': 'middle' }, q.lenT.replace(' mm', ''));
      }
      if (W > 560) s(rateSvg, 'text', { x: L, y: 12, class: 'lm-rbarcap' }, 'mm allowed at the same share ↓');
    }
    // interfaces: click to use
    const marks = s(rateSvg, 'g', {});
    const ends = [-1e9, -1e9, -1e9];                 // right end of the last label in each row
    let rowsUsed = 1;
    MARKS.forEach(([v, t]) => {
      const x = X(v), half = t.length * 2.9 + 4;
      const row = ends.findIndex((e) => x - half > e + 4);
      if (row < 0 || (W < 560 && row > 1)) return;
      ends[row] = x + half; rowsUsed = Math.max(rowsUsed, row + 1);
      const g = s(marks, 'g', { class: 'lm-mark', 'data-rate': v });
      s(g, 'line', { x1: x, x2: x, y1: base + 22, y2: base + 26 + row * 12, class: 'lm-markl' });
      s(g, 'rect', { x: x - half, y: base + 25 + row * 12, width: half * 2, height: 12, class: 'lm-hhit' });
      s(g, 'text', { x, y: base + 34 + row * 12, class: 'lm-marktxt', 'text-anchor': 'middle' }, t);
      g.addEventListener('click', () => ctx.set('rate', rateText(v)));
    });
    rateSvg.setAttribute('height', H + 12 * rowsUsed - 8);
    rateSvg.setAttribute('viewBox', `0 0 ${W} ${H + 12 * rowsUsed - 8}`);
    // cursor
    const rate = ctx.input.rate;
    if (rate > 0) {
      const x = X(clamp(rate, R_MIN, R_MAX));
      const g = s(rateSvg, 'g', { class: 'lm-cursor', tabindex: 0, role: 'slider', 'aria-label': `Bit rate ${rateShow(rate)}`, 'data-f': 'rate',
        'aria-valuetext': rateShow(rate) });
      s(g, 'rect', { x: x - 12, y: 14, width: 24, height: base - 6, class: 'lm-hhit' });
      s(g, 'line', { x1: x, x2: x, y1: 16, y2: base + 8, class: 'lm-curl' });
      s(g, 'path', { d: `M${x - 6},${base + 9} L${x + 6},${base + 9} L${x},${base + 1} z`, class: 'lm-curtri' });
      const lab = rateShow(rate), lw = lab.length * 7 + 12;
      const lx = clamp(x - lw / 2, 2, W - lw - 2);
      s(g, 'rect', { x: lx, y: 16, width: lw, height: 17, rx: 3, class: 'lm-curbox' });
      s(g, 'text', { x: lx + lw / 2, y: 28.5, class: 'lm-curtxt', 'text-anchor': 'middle' }, lab);
      g.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const f = e.shiftKey ? 1.25 : 1.025;
        refocus = 'rate';
        ctx.set('rate', rateText(clamp(Number((rate * f ** d).toPrecision(3)), R_MIN, R_MAX)));
      });
    }
    // drag anywhere on the scale
    const hit = s(rateSvg, 'rect', { x: L, y: 12, width: Rr - L, height: base, class: 'lm-hhit lm-ratehit' });
    rateSvg.insertBefore(hit, rateSvg.firstChild);
    onDrag(hit, rateSvg, (p) => {
      let v = V(clamp(p.x, L, Rr));
      const near = MARKS.find(([m]) => Math.abs(X(m) - p.x) < 5);
      if (near) v = near[0];
      ctx.set('rate', rateText(Number(v.toPrecision(2))));
    });
    const cur = rateSvg.querySelector('.lm-cursor');
    if (cur) onDrag(cur, rateSvg, (p) => {
      let v = V(clamp(p.x, L, Rr));
      const near = MARKS.find(([m]) => Math.abs(X(m) - p.x) < 5);
      if (near) v = near[0];
      ctx.set('rate', rateText(Number(v.toPrecision(2))));
    });
  }

  // ---------- time over copper ----------
  function drawRule(r) {
    ruleSvg.replaceChildren();
    const box = ruleSvg.parentNode;
    const W = Math.max(300, box.clientWidth), H = Math.max(300, box.clientHeight);
    ruleSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!r.ok) {
      s(ruleSvg, 'text', { x: W / 2, y: H / 2, class: 'lm-empty', 'text-anchor': 'middle' }, (res?.warnings || [])[0] || 'Give the bit rate.');
      return;
    }
    const narrow = W < 600;
    const L = narrow ? 14 : 70, Rr = W - (narrow ? 14 : 24);
    const t0 = -0.12, t1 = 1.12;                       // UI shown
    const X = (t) => L + ((t - t0) / (t1 - t0)) * (Rr - L);
    const T = (x) => t0 + ((x - L) / (Rr - L)) * (t1 - t0);
    const frac = holdWin ?? r.frac;
    const bad = frac > 0.5;
    // bands: time on top, copper below
    const amp = Math.min(22, H * 0.055), yA = Math.max(40 + amp, H * 0.15), yB = yA + (H * 0.17);
    const yT = H * 0.43;                               // time axis
    const yC = H * 0.585, yC2 = H * 0.77;               // copper traces
    const yM = H - 40;                               // mm ruler

    if (!narrow) {
      s(ruleSvg, 'text', { x: 8, y: yA + 4, class: 'lm-lane' }, 'lane A');
      s(ruleSvg, 'text', { x: 8, y: yB + 4, class: 'lm-lane' }, 'lane B');
      s(ruleSvg, 'text', { x: 8, y: yT + 4, class: 'lm-lane' }, 'time');
      s(ruleSvg, 'text', { x: 8, y: yC + 4, class: 'lm-lane' }, 'trace A');
      s(ruleSvg, 'text', { x: 8, y: yC2 + 4, class: 'lm-lane' }, 'trace B');
      s(ruleSvg, 'text', { x: 8, y: yM + 4, class: 'lm-lane' }, 'copper');
    }
    // unit interval frame and sample point
    s(ruleSvg, 'rect', { x: X(0), y: yA - amp - 12, width: X(1) - X(0), height: yB + amp + 12 - (yA - amp - 12), class: 'lm-uiframe' });
    s(ruleSvg, 'line', { x1: X(0.5), x2: X(0.5), y1: yA - amp - 8, y2: yB + amp + 6, class: 'lm-sample' });
    s(ruleSvg, 'text', { x: X(0.5) + 4, y: yA - amp - 2, class: 'lm-small' }, 'sample');
    // skew windows at both edges
    const win = (t) => s(ruleSvg, 'rect', { x: X(t), y: yA - amp - 12, width: X(Math.min(t1, t + frac)) - X(t), height: yT - (yA - amp - 12), class: `lm-win${bad ? ' bad' : ''}` });
    win(0); win(1);
    // waveforms: A switches on the UI edges, B late by the skew
    const wave = (y, d) => {
      const e = Math.min(0.06, 0.25);                  // edge time, UI
      const lv = [1, -1, 1];
      let p = `M${X(t0)},${y + amp * lv[0]}`;
      [0, 1].forEach((edge, k) => {
        p += ` L${X(edge + d - e / 2)},${y + amp * lv[k]} L${X(edge + d + e / 2)},${y + amp * lv[k + 1]}`;
      });
      p += ` L${X(t1)},${y + amp * lv[2]}`;
      return p;
    };
    // an eye-like second trace, inverted
    const wave2 = (y, d) => wave(y, d).replace(/,(-?[\d.]+)/g, (m0, v) => `,${2 * y - Number(v)}`);
    for (const [y, d, cls] of [[yA, 0, 'a'], [yB, frac, 'b']]) {
      s(ruleSvg, 'path', { d: wave(y, d), class: `lm-wave ${cls}` });
      s(ruleSvg, 'path', { d: wave2(y, d), class: `lm-wave ${cls} ghost` });
    }
    // time axis
    s(ruleSvg, 'line', { x1: X(t0), x2: X(t1), y1: yT, y2: yT, class: 'lm-axis' });
    const ui = r.uiPs;
    const pstep = niceStep(ui * (t1 - t0), narrow ? 4 : 10);
    for (let ps = Math.ceil((t0 * ui) / pstep) * pstep; ps <= t1 * ui; ps += pstep) {
      s(ruleSvg, 'line', { x1: X(ps / ui), x2: X(ps / ui), y1: yT, y2: yT + 5, class: 'lm-tickl' });
      s(ruleSvg, 'text', { x: X(ps / ui), y: yT + 16, class: 'lm-tick', 'text-anchor': 'middle' }, r3(ps));
    }
    s(ruleSvg, 'text', { x: X(t1), y: yT - 5, class: 'lm-small', 'text-anchor': 'end' }, 'ps');
    // UI dimension
    const yd = yA - amp - 20;
    s(ruleSvg, 'path', { d: `M${X(0)},${yd - 4} v8 M${X(0)},${yd} H${X(1)} M${X(1)},${yd - 4} v8`, class: 'lm-dim' });
    s(ruleSvg, 'text', { x: X(0.5), y: yd - 5, class: 'lm-dimtxt', 'text-anchor': 'middle' }, `1 UI = ${r.uiT}`);

    // the window edge: drag to set the share
    const g = s(ruleSvg, 'g', { class: 'lm-edge', tabindex: 0, role: 'slider', 'aria-label': `Skew budget ${r.skewT}, ${r.shareT}`, 'data-f': 'edge' });
    const ex = X(frac);
    s(g, 'rect', { x: ex - 10, y: yA - amp - 12, width: 20, height: yT - (yA - amp - 12), class: 'lm-hhit' });
    s(g, 'line', { x1: ex, x2: ex, y1: yA - amp - 12, y2: yT, class: `lm-edgel${bad ? ' bad' : ''}` });
    s(g, 'rect', { x: ex - 5, y: (yA + yB) / 2 - 14, width: 10, height: 28, rx: 3, class: `lm-grip${bad ? ' bad' : ''}` });
    const skl = `${r.skewT} · ${r.shareT}`;
    s(ruleSvg, 'text', { x: ex + 12, y: yB + amp + 16, class: `lm-skewtxt${bad ? ' bad' : ''}`, }, skl);
    const setFrac = (f) => {
      const pct = clamp(Math.round(f * 1000) / 10, 0.5, 60);
      const preset = BASIS.find((b) => Math.abs(b[2] - pct) < 0.6);
      ctx.setMany(preset ? { basis: preset[0] } : { basis: 'custom', share: String(pct) });
    };
    onDrag(g, ruleSvg, (p) => { holdWin = clamp(T(p.x), 0.005, 0.6); setFrac(holdWin); }, () => { holdWin = null; draw(); });
    g.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return; e.preventDefault();
      refocus = 'edge';
      setFrac(frac + d * (e.shiftKey ? 0.05 : 0.01));
    });

    // ---- copper: the same interval as length, at the same scale ----
    const uiMm = r.psmm ? ui / r.psmm : null;          // mm travelled in one UI
    const mm = r.mm;
    // projection of the window onto the copper
    s(ruleSvg, 'path', { d: `M${X(0)},${yT + 20} L${X(0)},${yM}  M${X(frac)},${yT + 20} L${X(frac)},${yM}`, class: 'lm-proj' });
    s(ruleSvg, 'rect', { x: X(0), y: yC - 18, width: X(frac) - X(0), height: yM - yC + 18, class: `lm-projwin${bad ? ' bad' : ''}` });
    // trace A: straight, pads at both ends
    const px0 = X(t0) + 6, px1 = X(t1) - 6;
    s(ruleSvg, 'line', { x1: px0, x2: px1, y1: yC, y2: yC, class: 'lm-trace' });
    // trace B: same run, with a meander that adds exactly the budget, to scale
    const pxPerMm = uiMm ? (X(1) - X(0)) / uiMm : 0;
    const extraPx = mm * pxPerMm;
    const mx0 = X(0.25), mw = X(0.75) - X(0.25);
    const maxAmp = (yM - yC2) * 0.55;
    let bumps = 3, bh = extraPx / (2 * bumps);
    while (bh > maxAmp && bumps < 14) { bumps++; bh = extraPx / (2 * bumps); }
    const scaled = bh <= maxAmp;
    bh = Math.min(bh, maxAmp);
    let d = `M${px0},${yC2} L${mx0},${yC2}`;
    const bw = mw / bumps;
    for (let k = 0; k < bumps; k++) {
      const x = mx0 + k * bw;
      d += ` L${x + bw * 0.2},${yC2} L${x + bw * 0.2},${yC2 - bh} L${x + bw * 0.8},${yC2 - bh} L${x + bw * 0.8},${yC2}`;
    }
    d += ` L${px1},${yC2}`;
    s(ruleSvg, 'path', { d, class: `lm-trace b${bad ? ' bad' : ''}` });
    for (const y of [yC, yC2]) for (const x of [px0, px1]) s(ruleSvg, 'rect', { x: x - 4, y: y - 4, width: 8, height: 8, rx: 1, class: 'lm-pad' });
    if (bh > 10) s(ruleSvg, 'text', { x: mx0 + mw / 2, y: yC2 - bh - 5, class: 'lm-small', 'text-anchor': 'middle' },
      `meander adds ${r.mmT}${scaled ? '' : ' (height capped)'}`);
    else s(ruleSvg, 'text', { x: mx0 + mw / 2, y: yC2 - Math.max(bh, 2) - 6, class: 'lm-small', 'text-anchor': 'middle' }, `meander adds ${r.mmT}`);
    // mm ruler under the copper, same scale as the time axis
    s(ruleSvg, 'line', { x1: X(t0), x2: X(t1), y1: yM, y2: yM, class: 'lm-axis' });
    if (uiMm) {
      const mstep = niceStep(uiMm * (t1 - t0), narrow ? 4 : 10);
      for (let v = Math.ceil((t0 * uiMm) / mstep) * mstep; v <= t1 * uiMm; v += mstep) {
        const x = X(v / uiMm);
        s(ruleSvg, 'line', { x1: x, x2: x, y1: yM - 5, y2: yM, class: 'lm-tickl' });
        s(ruleSvg, 'text', { x, y: yM - 8, class: 'lm-tick', 'text-anchor': 'middle' }, r3(v));
      }
      s(ruleSvg, 'text', { x: X(t1), y: yM + 13, class: 'lm-small', 'text-anchor': 'end' }, `mm · 1 UI of flight = ${r3(uiMm)} mm`);
      // guide limit for intra-pair
      if ((res?.warnings || []).some((w) => /0\.127 mm/.test(w))) {
        const x = X(0.127 / uiMm);
        s(ruleSvg, 'line', { x1: x, x2: x, y1: yC - 22, y2: yM, class: 'lm-guide' });
        s(ruleSvg, 'text', { x: x + 4, y: yC - 24, class: 'lm-guidetxt' }, 'guides: 0.127 mm');
      }
    }
    // the answer, dimensioned on the copper
    const ya = yM + 24;
    if (ya < H) {
      s(ruleSvg, 'path', { d: `M${X(0)},${ya - 4} v8 M${X(0)},${ya} H${X(frac)} M${X(frac)},${ya - 4} v8`, class: `lm-dim${bad ? ' bad' : ''}` });
      s(ruleSvg, 'text', { x: X(frac) + 6, y: ya + 4, class: `lm-anstxt${bad ? ' bad' : ''}` }, `${r.mmT} · ${r.milT}`);
    }
  }

  // ---------- layer cross-section ----------
  function drawLayer(r) {
    layerSvg.replaceChildren();
    const strip = ctx.input.layer === 'stripline';
    const wh = ctx.input.wh > 0 ? ctx.input.wh : 2;
    s(layerSvg, 'rect', { x: 10, y: strip ? 14 : 40, width: 200, height: strip ? 60 : 34, class: 'lm-diel' });
    if (strip) s(layerSvg, 'rect', { x: 10, y: 10, width: 200, height: 4, class: 'lm-plane' });
    s(layerSvg, 'rect', { x: 10, y: 74, width: 200, height: 4, class: 'lm-plane' });
    const hgt = strip ? 30 : 34, w = strip ? 34 : clamp(wh * hgt, 8, 180);
    const ty = strip ? 41 : 34;
    const tr = s(layerSvg, 'g', { class: strip ? '' : 'lm-trw', tabindex: strip ? null : 0, role: strip ? null : 'slider', 'aria-label': strip ? null : `Microstrip width over height ${r3(wh)}`, 'data-f': 'wh' });
    s(tr, 'rect', { x: 110 - w / 2, y: ty, width: w, height: 6, class: 'lm-cu' });
    if (!strip) {
      s(tr, 'rect', { x: 110 + w / 2 - 6, y: ty - 6, width: 12, height: 18, class: 'lm-hhit' });
      s(tr, 'path', { d: `M${110 + w / 2 + 3},${ty - 3} l4,6 l-4,6`, class: 'lm-wharrow' });
      s(layerSvg, 'text', { x: 110, y: ty - 6, class: 'lm-small', 'text-anchor': 'middle' }, `w/h ${r3(wh)}`);
      onDrag(tr, layerSvg, (p) => ctx.set('wh', r3(clamp((Math.abs(p.x - 110) * 2) / hgt, 0.2, 5))));
      tr.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (!d) return; e.preventDefault(); refocus = 'wh';
        ctx.set('wh', r3(clamp(wh + d * 0.1, 0.2, 5)));
      });
    }
    s(layerSvg, 'text', { x: 14, y: strip ? 26 : 52, class: 'lm-dieltxt' }, `εr ${r3(ctx.input.er || 0)}`);
    if (r.pdHint) s(layerSvg, 'text', { x: 206, y: strip ? 26 : 52, class: 'lm-dieltxt', 'text-anchor': 'end' }, r.pdHint.split(',')[0]);
  }

  function draw() {
    const r = R(), raw = ctx.raw, inp = ctx.input;
    if (document.activeElement !== rateIn) rateIn.value = raw.rate ?? '';
    if (document.activeElement !== shareIn) shareIn.value = raw.share ?? '';
    if (document.activeElement !== erIn) erIn.value = raw.er ?? '';
    if (document.activeElement !== whIn) whIn.value = raw.wh ?? '';
    const basis = BASIS.some((b) => b[0] === inp.basis) || inp.basis === 'custom' ? inp.basis : 'lanes';
    basisBtns.forEach((b) => { const on = b.dataset.v === basis; b.setAttribute('aria-checked', String(on)); b.tabIndex = on || (basis === 'custom' && b === basisBtns[0]) ? 0 : -1; });
    customBtn.classList.toggle('on', basis === 'custom');
    for (const b of layerSeg.children) { const on = b.dataset.v === inp.layer; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    for (const c of erChips.children) c.setAttribute('aria-pressed', String(Number(c.dataset.v) === inp.er));
    whField.classList.toggle('off', inp.layer === 'stripline');
    big.replaceChildren();
    if (r.ok) big.append(h('span', {}, 'max mismatch'), h('b', { class: r.frac > 0.5 ? 'bad' : '' }, r.mmT), h('small', {}, r.milT), h('span', { class: 'lm-bigsep' }, `= ${r.skewT} at ${r.pdT}`));
    delay.replaceChildren(...(r.ok ? [h('b', {}, r.pdT), h('span', {}, r.pdHint)] : []));
    drawRate(r); drawRule(r); drawLayer(r);
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res?.warnings || []).length;
    // shares table from run(), as a strip of what-ifs; click one to use it
    shares.replaceChildren();
    const t = r.shares;
    if (t) {
      shares.append(h('div', { class: 'lm-sharehead' }, t.title));
      const grid = h('div', { class: 'lm-sharegrid' });
      for (const row of t.rows) {
        const pct = plain(row[0]);
        const cur = r.frac != null && Math.abs(pct / 100 - r.frac) < 0.0005;
        grid.append(h('button', { type: 'button', class: `lm-sharecell${cur ? ' on' : ''}`, title: `Use ${row[0]} of the UI`,
          onclick: () => { const p = BASIS.find((b) => b[2] === pct); ctx.setMany(p ? { basis: p[0] } : { basis: 'custom', share: String(pct) }); } },
        h('b', {}, row[0]), h('span', {}, row[2]), h('small', {}, row[1])));
      }
      shares.append(grid);
    }
    const ns = res?.notes || [];
    notes.replaceChildren(h('summary', {}, `Notes (${ns.length})`), ...ns.map((x) => h('p', {}, x)));
    notes.hidden = !ns.length;
    if (refocus) {
      const f = refocus; refocus = null;
      const el = f.startsWith('basis-') ? basisBar.querySelector(`[data-v="${f.slice(6)}"]`)
        : f.startsWith('layer-') ? layerSeg.querySelector(`[data-v="${f.slice(6)}"]`)
          : root.querySelector(`[data-f="${f}"]`);
      el?.focus();
    }
  }

  ctx.onResult((r) => { res = r; draw(); });
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }).observe(ruleCard);
}
