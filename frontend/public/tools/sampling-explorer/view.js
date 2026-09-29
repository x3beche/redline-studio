// Sampling Parameters Explorer, custom page. The chart is the interface:
//   one bar per candidate token, most likely first; the outline is the
//   distribution the filters see, the filled bar what can actually be drawn.
//   Drag the temperature knob on the track above the bars, the top-k line
//   sideways, the top-p line up and down the cumulative curve, and the min-p
//   line on the probability axis. Every handle takes focus and arrow keys.
//   Tokens a filter removed are hatched in that filter's colour; the pipeline
//   strip above says how many survive each stage and, clicked, marks what it cut.

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
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};
const pct = (p) => (p >= 0.1 ? `${(p * 100).toFixed(1)}%` : p >= 0.001 ? `${(p * 100).toFixed(2)}%` : p > 0 ? `${(p * 100).toExponential(0)}%` : '0');
const tokLabel = (t) => t.replace(/^ /, '␣').replace(/\n/g, '⏎');
const STAGE_TEXT = { input: 'Logits', penalties: 'Penalties', temperature: 'Temperature', 'top-k': 'top-k', 'top-p': 'top-p', 'min-p': 'min-p', sample: 'Sample' };
const CUT_CLASS = { 'top-k': 'ck', 'top-p': 'cp', 'min-p': 'cm', greedy: 'cg' };
const T_MAX = 2;

export function page(root, ctx) {
  const VKEY = 'redline.tool.sampling-explorer.view';
  const vs = { log: false, focus: '', ...(store.get(VKEY) || {}) };
  const saveVs = () => store.set(VKEY, { log: vs.log });
  let res = null, draw = null, drag = null, raf = 0, pendingSet = null, focusH = null;

  // ---------- skeleton ----------
  const presetBar = h('div', { class: 'se-presets', role: 'group', 'aria-label': 'Distribution' });
  const logBtn = h('button', { class: 'k-btn', 'aria-pressed': String(vs.log), onclick: () => { vs.log = !vs.log; saveVs(); logBtn.setAttribute('aria-pressed', String(vs.log)); render(); } }, 'Log scale');
  const promptLine = h('div', { class: 'se-prompt' });
  const pipe = h('div', { class: 'se-pipe', role: 'list', 'aria-label': 'Order of operations' });
  const svg = s('svg', { class: 'se-svg', role: 'img', 'aria-label': 'Next-token distribution' });
  const chartBox = h('div', { class: 'se-chartbox' }, svg);
  const legend = h('div', { class: 'se-legend' },
    h('span', {}, h('i', { class: 'sw ghost' }), 'what the filters see'),
    h('span', {}, h('i', { class: 'sw fin' }), 'can be drawn'),
    h('span', {}, h('i', { class: 'sw tick' }), 'model alone'),
    h('span', {}, h('i', { class: 'sw dot' }), 'share of draws'),
    h('span', {}, h('i', { class: 'sw ck' }), 'cut by top-k'),
    h('span', {}, h('i', { class: 'sw cp' }), 'cut by top-p'),
    h('span', {}, h('i', { class: 'sw cm' }), 'cut by min-p'));
  const chartWarn = h('div', { class: 'se-cwarn', 'aria-live': 'polite' });
  const chartCard = h('section', { class: 'se-card se-chartcard' },
    h('div', { class: 'se-head' }, h('h2', {}, 'Next token'), presetBar, h('span', { class: 'se-right' }, logBtn)),
    promptLine, pipe, chartBox, legend, chartWarn);

  const stats = h('div', { class: 'se-stats' });
  const num = (key, label, step, help) => {
    const inp = h('input', { class: 'se-in', type: 'text', inputmode: 'decimal', id: `se-${key}`, 'data-key': key, spellcheck: 'false',
      oninput: (e) => ctx.set(key, e.target.value),
      onkeydown: (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const v = Number(ctx.raw[key]) || 0;
        const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
        const nv = Math.round((v + d) / step) * step;
        e.target.value = String(Number(nv.toFixed(4))); ctx.set(key, e.target.value);
      } });
    return h('label', { class: 'se-num', for: `se-${key}`, title: help || null }, h('span', {}, label), inp);
  };
  const orderSel = h('select', { class: 'se-in se-sel', id: 'se-order', onchange: (e) => ctx.set('order', e.target.value) },
    h('option', { value: 'temp-first' }, 'Temperature first (HF, vLLM)'),
    h('option', { value: 'temp-last' }, 'Temperature last (llama.cpp)'));
  const controls = h('section', { class: 'se-card' },
    h('div', { class: 'se-head' }, h('h2', {}, 'Settings'), h('span', { class: 'se-sub' }, 'drag on the chart, or type; arrows step')),
    h('div', { class: 'se-grid' },
      num('temperature', 'Temperature', 0.05, '0 = greedy'), num('topK', 'top-k', 1, '0 = off'), num('topP', 'top-p', 0.01, '1 = off'), num('minP', 'min-p', 0.01, '0 = off'),
      num('presence', 'Presence pen.', 0.1, 'OpenAI style: subtract once if the token appeared'), num('frequency', 'Frequency pen.', 0.1, 'OpenAI style: subtract per appearance'),
      num('repetition', 'Repetition pen.', 0.05, 'CTRL / HF / llama.cpp style: divide positive logits; 1 = off'),
      h('label', { class: 'se-num se-wide', for: 'se-order' }, h('span', {}, 'Order'), orderSel)));

  const seqBox = h('div', { class: 'se-seq', 'aria-live': 'polite' });
  const sampler = h('section', { class: 'se-card' },
    h('div', { class: 'se-head' }, h('h2', {}, 'Sampler'), h('span', { class: 'se-sub' }, 'seeded, so a draw repeats exactly')),
    h('div', { class: 'se-grid' }, num('samples', 'Draws', 50), num('seed', 'Seed', 1),
      h('div', { class: 'se-btns' }, h('button', { class: 'k-btn', onclick: () => ctx.set('seed', String((Number(ctx.raw.seed) || 0) + 1)) }, 'Next seed'))),
    seqBox);

  const provBox = h('div', { class: 'se-provs' });
  const providers = h('section', { class: 'se-card' },
    h('div', { class: 'se-head' }, h('h2', {}, 'Provider defaults'), h('span', { class: 'se-sub se-asof' })),
    provBox);

  const histTa = h('textarea', { class: 'se-ta', rows: 3, spellcheck: 'false', 'aria-label': 'Context so far', oninput: (e) => ctx.set('history', e.target.value) });
  const logitTa = h('textarea', { class: 'se-ta', rows: 7, spellcheck: 'false', 'aria-label': 'Logits', oninput: (e) => ctx.set('logits', e.target.value) });
  const logitWrap = h('div', { class: 'se-pad' });
  const dataCard = h('section', { class: 'se-card' },
    h('div', { class: 'se-head' }, h('h2', {}, 'Logits and context')),
    h('div', { class: 'se-pad' },
      h('div', { class: 'se-lab' }, 'Context so far - candidates found here are penalised by their count (empty = the example\'s prompt)'), histTa),
    logitWrap);

  const findings = h('section', { class: 'se-card se-find' });
  const main = h('div', { class: 'se-main' }, chartCard, findings, h('div', { class: 'se-out' }, ctx.outputs));
  const side = h('div', { class: 'se-side' }, stats, controls, sampler, providers, dataCard);
  root.append(h('div', { class: 'se' }, main, side));

  // ---------- presets ----------
  const PRESET_NAMES = [['factual', 'Factual'], ['creative', 'Creative'], ['code', 'Code'], ['custom', 'My logits']];
  function drawPresets() {
    const cur = ctx.raw.preset;
    presetBar.replaceChildren(...PRESET_NAMES.map(([v, t]) => h('button', { class: 'se-chip', 'aria-pressed': String(cur === v), onclick: () => ctx.set('preset', v) }, t)));
  }
  function editThese() {
    if (!res) return;
    const lines = res.draw.rows.slice().sort((a, b) => b.logit - a.logit).map((r) => `${JSON.stringify(r.token)}: ${r.logit}`);
    const hist = String(ctx.raw.history || '').trim() ? ctx.raw.history : res.draw.prompt;
    ctx.setMany({ preset: 'custom', logits: lines.join('\n'), history: hist });
  }

  // ---------- the chart ----------
  function render() {
    if (!res?.draw) return;
    const d = res.draw, rows = d.rows, n = rows.length, st = d.settings;
    const boxW = Math.max(300, (chartBox.clientWidth || 800) - 8);
    const L = 46, R = 46, TOP = 58, BOT = 118;
    const colW = clamp((boxW - L - R - 2) / n, 24, 64);
    const W = Math.max(boxW - 2, Math.round(L + R + colW * n)), H = 456;
    const plotH = H - TOP - BOT, plotW = colW * n;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.replaceChildren();
    const defs = s('defs');
    for (const [id, cls] of [['hk', 'ck'], ['hp', 'cp'], ['hm', 'cm'], ['hg', 'cg']]) {
      const p = s('pattern', { id: `se-${id}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      p.append(s('rect', { width: 6, height: 6, class: `se-hbg ${cls}` }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: `se-hl ${cls}` }));
      defs.append(p);
    }
    svg.append(defs);
    const pmax = Math.max(d.pmaxSeen, ...rows.map((r) => r.pFinal), ...rows.map((r) => r.pModel), 1e-9);
    const top = vs.log ? 1 : Math.min(1, pmax * 1.15);
    const LOGMIN = 1e-5;
    const Y = (p) => {
      if (vs.log) { const v = Math.log10(clamp(p, LOGMIN, 1)); return TOP + plotH * (1 - (v - Math.log10(LOGMIN)) / (0 - Math.log10(LOGMIN))); }
      return TOP + plotH * (1 - clamp(p, 0, top) / top);
    };
    const Yinv = (y) => {
      const f = clamp(1 - (y - TOP) / plotH, 0, 1);
      if (vs.log) return 10 ** (Math.log10(LOGMIN) + f * (0 - Math.log10(LOGMIN)));
      return f * top;
    };
    const Yc = (c) => TOP + plotH * (1 - clamp(c, 0, 1));
    const Ycinv = (y) => clamp(1 - (y - TOP) / plotH, 0, 1);
    const X = (i) => L + i * colW;
    draw = { L, R, TOP, BOT, W, H, plotH, plotW, colW, n, Yinv, Ycinv, X };

    // grid + axes
    const ticks = vs.log ? [1, 0.1, 0.01, 1e-3, 1e-4, 1e-5] : [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
    for (const t of ticks) {
      svg.append(s('line', { x1: L, x2: L + plotW, y1: Y(t), y2: Y(t), class: 'se-grid' }));
      svg.append(s('text', { x: L - 6, y: Y(t) + 3, class: 'se-ax', 'text-anchor': 'end' }, vs.log ? (t >= 0.01 ? `${t * 100}%` : `${(t * 100).toExponential(0)}%`) : `${(t * 100).toFixed(t * 100 < 10 && t > 0 ? 1 : 0)}%`));
    }
    svg.append(s('text', { x: 2, y: TOP - 14, class: 'se-ax' }, 'probability'));
    for (const c of [0, 0.5, 1]) svg.append(s('text', { x: L + plotW + 6, y: Yc(c) + 3, class: 'se-ax se-axp' }, c.toFixed(1)));
    svg.append(s('text', { x: L + plotW + 4, y: TOP - 30, class: 'se-ax se-axp' }, 'cum.'));

    // stage highlight
    const focusStage = vs.focus;

    // top-p nucleus shade (the kept prefix up to the cut)
    const firstP = rows.findIndex((r) => r.cut === 'top-p');
    if (st.topP < 1) {
      const end = firstP < 0 ? rows.filter((r) => r.cut !== 'top-k').length : firstP;
      svg.append(s('rect', { x: L, y: TOP, width: end * colW, height: plotH, class: 'se-nucleus' }));
    }

    // bars
    rows.forEach((r, i) => {
      const x = X(i) + colW * 0.14, bw = colW * 0.72;
      const g = s('g', { class: `se-bar${r.cut ? ` cut ${CUT_CLASS[r.cut]}` : ''}${focusStage && r.cut === focusStage ? ' focus' : ''}${focusStage && r.cut && r.cut !== focusStage ? ' dim' : ''}` });
      const yS = Y(r.pSeen), base = Y(vs.log ? LOGMIN : 0);
      g.append(s('rect', { x, y: Math.min(yS, base - 1), width: bw, height: Math.max(1, base - yS), class: r.cut ? `se-cutbar` : 'se-ghost', fill: r.cut ? `url(#se-h${{ 'top-k': 'k', 'top-p': 'p', 'min-p': 'm', greedy: 'g' }[r.cut]})` : null }));
      if (r.pFinal > 0) { const yF = Y(r.pFinal); g.append(s('rect', { x: x + bw * 0.18, y: yF, width: bw * 0.64, height: Math.max(1, base - yF), class: 'se-fin' })); }
      const yM = Y(r.pModel);
      g.append(s('line', { x1: x - 2, x2: x + bw + 2, y1: yM, y2: yM, class: 'se-tick' }));
      if (d.N > 0 && r.drawn > 0) g.append(s('circle', { cx: x + bw / 2, cy: Y(r.drawn / d.N), r: 3, class: 'se-dot' }));
      if (r.pFinal >= 0.02 || (r.pFinal > 0 && colW >= 40)) g.append(s('text', { x: x + bw / 2, y: Math.min(Y(Math.max(r.pFinal, r.pSeen, r.pModel, d.N ? r.drawn / d.N : 0)), base) - 7, class: 'se-val', 'text-anchor': 'middle' }, pct(r.pFinal)));
      // token label, rotated
      const lx = x + bw / 2, ly = TOP + plotH + 10;
      const t = s('text', { x: lx, y: ly, class: `se-tok${r.cut ? ' cut' : ''}`, transform: `rotate(-55 ${lx} ${ly})`, 'text-anchor': 'end' });
      const lab = tokLabel(r.token);
      if (lab.startsWith('␣')) { t.append(s('tspan', { class: 'se-sp' }, '␣')); t.append(document.createTextNode(lab.slice(1))); } else t.textContent = lab;
      g.append(t);
      if (r.count > 0) {
        const pen = s('g', { class: 'se-pen' });
        pen.append(s('text', { x: lx, y: TOP + plotH + BOT - 20, 'text-anchor': 'middle', class: 'se-penx' }, `×${r.count}`));
        if (Math.abs(r.pen - r.logit) > 1e-9) pen.append(s('text', { x: lx, y: TOP + plotH + BOT - 8, 'text-anchor': 'middle', class: 'se-pend' }, `${(r.pen - r.logit).toFixed(1)}`));
        g.append(pen);
      }
      const tt = s('title', {}, `${JSON.stringify(r.token)}  logit ${r.logit}${r.count ? ` -> ${r.pen} after penalties (x${r.count} in context)` : ''}\nmodel alone ${pct(r.pModel)}, filters see ${pct(r.pSeen)}, can be drawn ${pct(r.pFinal)}${r.cut ? `\ncut by ${r.cut}` : ''}\ndrawn ${r.drawn} of ${d.N}`);
      g.append(tt);
      svg.append(g);
    });
    svg.append(s('text', { x: 2, y: TOP + plotH + BOT - 20, class: 'se-ax se-penx' }, 'in ctx'));
    svg.append(s('text', { x: 2, y: TOP + plotH + BOT - 8, class: 'se-ax se-pend' }, 'Δlogit'));

    // cumulative curve (what top-p sees: the top-k survivors, renormalised)
    const alive = rows.filter((r) => r.cut !== 'top-k');
    if (alive.length) {
      let dd = `M${X(0)},${Yc(0)}`;
      alive.forEach((r, i) => { dd += `L${X(i + 1)},${Yc(r.cum)}`; });
      svg.append(s('path', { d: dd, class: 'se-cum' }));
    }

    // ---- handles ----
    // top-p: horizontal line on the right axis
    const hp = handle('topP', `top-p ${st.topP >= 1 ? 'off' : st.topP.toFixed(2)}`, st.topP, 0.01, 1);
    const yP = Yc(st.topP);
    hp.append(s('line', { x1: L, x2: L + plotW, y1: yP, y2: yP, class: 'se-hline p' }),
      s('rect', { x: L + plotW - 2, y: yP - 9, width: R, height: 18, rx: 3, class: 'se-knob p' }),
      s('text', { x: L + plotW + R / 2 - 2, y: yP + 4, 'text-anchor': 'middle', class: 'se-knobt' }, st.topP >= 1 ? 'p off' : `p ${st.topP.toFixed(2)}`),
      s('rect', { x: L, y: yP - 6, width: plotW + R, height: 12, class: 'se-hit' }));
    svg.append(hp);
    // min-p: horizontal line on the probability axis
    const yM = st.minP > 0 ? Y(d.minPAbs) : Y(vs.log ? LOGMIN : 0) - 1;
    const hm = handle('minP', `min-p ${st.minP}`, st.minP, 0, 0.99);
    hm.append(s('line', { x1: L, x2: L + plotW, y1: yM, y2: yM, class: 'se-hline m' }),
      s('rect', { x: 2, y: yM - 9, width: L - 4, height: 18, rx: 3, class: 'se-knob m' }),
      s('text', { x: L / 2, y: yM + 4, 'text-anchor': 'middle', class: 'se-knobt' }, st.minP > 0 ? `m ${st.minP.toFixed(2)}` : 'm off'),
      s('rect', { x: 0, y: yM - 6, width: L + plotW, height: 12, class: 'se-hit' }));
    svg.append(hm);
    // top-k: vertical line between bars
    const kOn = st.topK > 0 && st.topK < n;
    const xK = X(kOn ? st.topK : n);
    const hk = handle('topK', `top-k ${kOn ? st.topK : 'off'}`, st.topK, 0, n);
    hk.append(s('line', { x1: xK, x2: xK, y1: TOP - 4, y2: TOP + plotH, class: 'se-vline k' }),
      s('rect', { x: xK - 22, y: TOP - 22, width: 44, height: 18, rx: 3, class: 'se-knob k' }),
      s('text', { x: xK, y: TOP - 9, 'text-anchor': 'middle', class: 'se-knobt' }, kOn ? `k ${st.topK}` : 'k off'),
      s('rect', { x: xK - 7, y: TOP - 22, width: 14, height: plotH + 22, class: 'se-hit' }));
    svg.append(hk);
    // temperature: a track above the plot
    const tx0 = L, tx1 = L + Math.min(plotW, boxW - L - R);
    const TX = (t) => tx0 + (tx1 - tx0) * clamp(t / T_MAX, 0, 1);
    draw.TX = TX; draw.TXinv = (x) => clamp((x - tx0) / (tx1 - tx0), 0, 1) * T_MAX;
    const ty = 18;
    const tr = s('g', { class: 'se-ttrack' });
    tr.append(s('line', { x1: tx0, x2: tx1, y1: ty, y2: ty, class: 'se-track' }));
    for (const t of [0, 0.5, 1, 1.5, 2]) {
      tr.append(s('line', { x1: TX(t), x2: TX(t), y1: ty - 4, y2: ty + 4, class: 'se-track' }));
      tr.append(s('text', { x: TX(t), y: ty + 15, class: 'se-ax', 'text-anchor': 'middle' }, String(t)));
    }
    tr.append(s('text', { x: tx0 - 6, y: ty + 4, class: 'se-ax', 'text-anchor': 'end' }, 'T'));
    svg.append(tr);
    const ht = handle('temperature', `temperature ${st.temperature}`, st.temperature, 0, T_MAX);
    const xT = TX(st.temperature);
    ht.append(s('rect', { x: tx0 - 4, y: ty - 10, width: tx1 - tx0 + 8, height: 20, class: 'se-hit' }),
      s('circle', { cx: xT, cy: ty, r: 8, class: 'se-knob t' }),
      s('text', { x: xT + 12, y: ty - 6, class: 'se-knobt2' }, `T ${Number(st.temperature.toFixed(2))}${d.greedy ? ' (greedy)' : ''}`));
    svg.append(ht);

    // warnings pinned where they apply: the model's first choice when demoted
    const firstModel = rows.reduce((b, r) => (r.logit > b.logit ? r : b), rows[0]);
    const iFM = rows.indexOf(firstModel);
    if (iFM > 0 && !d.greedy || (d.greedy && iFM !== 0)) {
      const x = X(iFM) + colW / 2, y = Y(Math.max(firstModel.pModel, firstModel.pSeen, firstModel.pFinal, d.N ? firstModel.drawn / d.N : 0)) - 20;
      svg.append(s('text', { x, y: Math.max(TOP + 10, y), class: 'se-flag', 'text-anchor': 'middle' }, '▼ demoted'));
    }
    if (focusH) {
      const refocus = () => { const el = focusH && svg.querySelector(`[data-h="${focusH}"]`); if (el && document.activeElement !== el) el.focus({ preventScroll: true }); };
      refocus(); requestAnimationFrame(refocus);
    }
  }

  function handle(key, label, value, min, max) {
    const g = s('g', { class: `se-handle h-${key}`, tabindex: 0, role: 'slider', 'data-h': key, 'aria-label': label,
      'aria-valuenow': String(value), 'aria-valuemin': String(min), 'aria-valuemax': String(max) });
    g.addEventListener('focus', () => { focusH = key; });
    g.addEventListener('keydown', (e) => { focusH = key; keyHandle(key, e); });
    return g;
  }

  const STEP = { temperature: 0.05, topP: 0.01, minP: 0.01, topK: 1 };
  function keyHandle(key, e) {
    const st = res.draw.settings, n = res.draw.rows.length;
    let v = key === 'topK' ? (st.topK > 0 && st.topK < n ? st.topK : n) : st[key];
    const up = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const off = { temperature: 1, topP: 1, minP: 0, topK: 0 }[key];
      setVal(key, e.key === 'Home' ? ({ temperature: 0, topP: 0.01, minP: 0, topK: 1 }[key]) : off);
      return;
    }
    if (!up) return;
    e.preventDefault();
    v += up * STEP[key] * (e.shiftKey ? 5 : 1);
    if (key === 'topK' && v >= n) v = 0;
    setVal(key, v);
  }
  function setVal(key, v) {
    const n = res.draw.rows.length;
    if (key === 'temperature') v = Number(clamp(v, 0, T_MAX).toFixed(2));
    if (key === 'topP') v = Number(clamp(v, 0.01, 1).toFixed(2));
    if (key === 'minP') v = Number(clamp(v, 0, 0.99).toFixed(3));
    if (key === 'topK') { v = Math.round(v); if (v >= n || v <= 0) v = 0; }
    pendingSet = [key, String(v)];
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pendingSet) { const [k, val] = pendingSet; pendingSet = null; ctx.set(k, val); } });
  }

  // Drag: the svg keeps the pointer capture, so the redraw under the
  // pointer does not end the drag.
  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.se-handle');
    if (!g || !draw) return;
    e.preventDefault();
    drag = g.getAttribute('data-h');
    focusH = drag;
    g.focus({ preventScroll: true });
    svg.setPointerCapture(e.pointerId);
    move(e);
  });
  // Focus leaving the chart for anything else ends the keyboard session.
  document.addEventListener('focusin', (e) => { if (!svg.contains(e.target)) focusH = null; });
  document.addEventListener('pointerdown', (e) => { if (!svg.contains(e.target)) focusH = null; });
  svg.addEventListener('pointermove', (e) => { if (drag) move(e); });
  const end = (e) => { if (!drag) return; drag = null; try { svg.releasePointerCapture(e.pointerId); } catch { /* gone */ } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  function move(e) {
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * (draw.W / r.width), y = (e.clientY - r.top) * (draw.H / r.height);
    if (drag === 'temperature') setVal('temperature', draw.TXinv(x));
    else if (drag === 'topP') setVal('topP', draw.Ycinv(y));
    else if (drag === 'topK') setVal('topK', Math.round((x - draw.L) / draw.colW));
    else if (drag === 'minP') {
      const p = draw.Yinv(y), pm = res.draw.pmaxSeen || 1;
      setVal('minP', p / pm < 0.004 ? 0 : p / pm);
    }
  }

  // ---------- the rest of the page ----------
  function drawPipe() {
    const d = res.draw;
    const items = [];
    d.stages.forEach((st, i) => {
      if (i) items.push(h('span', { class: 'se-arrow', 'aria-hidden': 'true' }, '→'));
      const cuts = ['top-k', 'top-p', 'min-p'].includes(st.stage);
      const prev = i ? d.stages[i - 1].kept : st.kept;
      const cut = cuts ? prev - st.kept : 0;
      let sub;
      if (st.stage === 'input') sub = `${st.kept} tokens`;
      else if (st.stage === 'penalties') sub = st.changed ? `${st.changed} penalised` : 'none in context';
      else if (st.stage === 'temperature') sub = st.greedy ? 'T 0: greedy' : `T ${d.settings.temperature}`;
      else if (st.stage === 'sample') sub = `${st.kept} left`;
      else sub = st.off ? (st.stage === 'top-k' && d.settings.topK > 0 ? `k ${d.settings.topK}: cuts none` : 'off') : `${st.kept} kept${cut ? `, −${cut}` : ''}`;
      const on = vs.focus === st.stage;
      items.push(h(cuts ? 'button' : 'span', { role: 'listitem', class: `se-stage s-${st.stage}${st.off ? ' off' : ''}${on ? ' on' : ''}`,
        'aria-pressed': cuts ? String(on) : null, title: cuts ? 'Mark the tokens this stage removed' : null,
        onclick: cuts ? () => { vs.focus = on ? '' : st.stage; drawPipe(); render(); } : null },
      h('b', {}, STAGE_TEXT[st.stage]), h('small', {}, sub)));
    });
    pipe.replaceChildren(...items);
  }

  function drawStats() {
    const d = res.draw, v = res.values;
    const Hm = d.H.model, Hf = d.H.final;
    const maxH = Math.max(Hm, Hf, 1);
    const bar = (lab, H, cls) => h('div', { class: 'se-hrow' }, h('span', { class: 'se-hl2' }, lab),
      h('span', { class: 'se-hbar' }, h('i', { class: cls, style: `width:${(H / maxH) * 100}%` })),
      h('b', {}, `${H.toFixed(2)} bits`), h('small', {}, `${(2 ** H).toFixed(1)} choices`));
    stats.replaceChildren(h('section', { class: 'se-card' },
      h('div', { class: 'se-head' }, h('h2', {}, 'Spread')),
      h('div', { class: 'se-pad' },
        bar('model alone', Hm, 'm'), bar('with settings', Hf, 'f'),
        h('div', { class: 'se-kv' },
          ...v.filter((x) => /Tokens that|Most likely|mass cut/.test(x.label)).map((x) => h('div', { class: x.tone ? `t-${x.tone}` : null }, h('span', {}, x.label), h('b', {}, `${x.value}${x.unit ? ` ${x.unit}` : ''}`), x.hint ? h('small', {}, x.hint) : null))))));
  }

  function drawSeq() {
    const d = res.draw;
    const counts = d.rows.filter((r) => r.drawn > 0).sort((a, b) => b.drawn - a.drawn);
    seqBox.replaceChildren(
      h('div', { class: 'se-lab' }, `First ${d.seq.length} of ${d.N} draws (seed ${d.seed})`),
      h('div', { class: 'se-chips' }, d.seq.map((t) => h('span', { class: 'se-tchip' }, tokLabel(t)))),
      h('div', { class: 'se-lab' }, `${counts.length} distinct: ${counts.slice(0, 8).map((r) => `${tokLabel(r.token)} ${r.drawn}`).join(', ')}${counts.length > 8 ? ', ...' : ''}`));
  }

  function drawProviders() {
    const d = res.draw;
    providers.querySelector('.se-asof').textContent = `as of ${d.asof} - verify on each provider's page`;
    provBox.replaceChildren(...d.providers.map((p) => {
      const set = Object.entries(p.set).filter(([, v]) => v != null).map(([k, v]) => `${{ temperature: 'T', topK: 'k', topP: 'p', minP: 'min-p', presence: 'pres', frequency: 'freq', repetition: 'rep' }[k]} ${v}`).join(' · ');
      return h('div', { class: 'se-prov' },
        h('div', { class: 'se-provh' }, h('b', {}, p.name),
          h('button', { class: 'k-btn', title: 'Set these values (unsupported ones go to off) and this provider\'s order', onclick: () => apply(p) }, 'Apply')),
        h('div', { class: 'se-provset' }, set, ` · ${p.order === 'temp-last' ? 'temperature last' : 'temperature first'}`),
        h('div', { class: 'se-provn' }, `${p.ranges}. ${p.note}`));
    }));
  }
  function apply(p) {
    const off = { temperature: 1, topK: 0, topP: 1, minP: 0, presence: 0, frequency: 0, repetition: 1 };
    const obj = { order: p.order };
    for (const [k, v] of Object.entries(p.set)) obj[k] = String(v == null ? off[k] : v);
    ctx.setMany(obj);
  }

  function drawData() {
    const raw = ctx.raw;
    if (document.activeElement !== histTa) histTa.value = raw.history ?? '';
    histTa.placeholder = res.draw.prompt || 'Text already in the context';
    if (raw.preset === 'custom') {
      if (document.activeElement !== logitTa) logitTa.value = raw.logits ?? '';
      logitWrap.replaceChildren(h('div', { class: 'se-lab' }, 'Logits or logprobs: "token": value per line, or JSON / an OpenAI logprobs block. ␣ = a leading space.'), logitTa);
    } else {
      logitWrap.replaceChildren(h('div', { class: 'se-lab' }, `The ${raw.preset} example uses built-in illustrative logits (hand-written, not from a model).`),
        h('button', { class: 'k-btn', onclick: editThese }, 'Edit these logits'));
    }
  }

  function drawFindings() {
    const w = res.warnings || [], n = res.notes || [];
    chartWarn.replaceChildren(...w.map((t) => h('div', {}, t)));
    findings.replaceChildren(h('div', { class: 'se-head' }, h('h2', {}, 'How this was computed')),
      h('div', { class: 'se-pad se-notes' }, n.map((t) => h('div', {}, t))));
  }

  function syncInputs() {
    const raw = ctx.raw;
    for (const el of root.querySelectorAll('input.se-in[data-key]')) if (document.activeElement !== el) el.value = raw[el.dataset.key] ?? '';
    orderSel.value = raw.order || 'temp-first';
  }

  ctx.onResult((r) => {
    res = r;
    if (!r?.draw) { chartWarn.replaceChildren(...(r?.warnings || []).map((t) => h('div', {}, t))); return; }
    const d = r.draw;
    promptLine.replaceChildren(d.prompt ? h('span', {}, h('span', { class: 'se-ptext' }, d.prompt.split('\n').slice(-1)[0]), h('span', { class: 'se-caret' }, ' ▮ ?')) : h('span', { class: 'se-sub' }, 'Your own logits'));
    drawPresets(); drawPipe(); render(); drawStats(); drawSeq(); drawProviders(); drawData(); drawFindings(); syncInputs();
  });
  let lastW = 0;
  new ResizeObserver(() => { const w = chartBox.clientWidth; if (Math.abs(w - lastW) > 4) { lastW = w; render(); } }).observe(chartBox);
}
