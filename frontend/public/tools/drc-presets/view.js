// DRC Rule Preset Builder, drawn as a copper test coupon under a microscope:
// the board edge and its GND pour, the two Default tracks with their gap, the
// Power track, a pair of Default vias at the hole-to-hole distance and a
// Power via, all to one scale. Solid copper is what the rules will draw; the
// dashed ghosts are the fab's limits. Drag a track's lower edge to set its
// width; drag a ghost (the limit) and the fab becomes Custom with that limit.
// Hover a rule in the ladder to find it on the coupon. The files the rules
// make sit beside the ladder. Every number comes from run().

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (t) => { const m = String(t ?? '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const r3 = (v) => String(Math.round(v * 1000) / 1000);

const FABS = [['jlc2', 'JLCPCB', '2-layer'], ['jlc4', 'JLCPCB', '4/6-layer'], ['pcbway', 'PCBWay', 'standard'],
  ['osh2', 'OSH Park', '2-layer'], ['osh4', 'OSH Park', '4-layer'], ['generic', 'Generic', '6/6 mil'], ['custom', 'Custom', 'your limits']];
const MARGINS = [['limit', 'At the limit', '× 1'], ['plus20', '+20 %', '× 1.2'], ['safe', '+50 %', '× 1.5, 0.05 mm']];
// Which coupon feature a rule (table row) is about.
const RULE_FEAT = { 'Track width': 'track', Clearance: 'gap', 'Via drill': 'drill', 'Via pad': 'pad', 'Annular ring': 'ring',
  'Copper to board edge': 'edge', 'Hole to hole': 'h2h' };
// Which feature a warning points at.
const warnFeat = (w) => (/signal track|2 oz|min_track|\.track/.test(w) ? 'track' : /annular/.test(w) ? 'ring'
  : /microvia|drill/.test(w) ? 'drill' : /clearance/.test(w) ? 'gap' : /via/.test(w) ? 'pad' : null);

const CSS = `
.drc { --tool-cu: #b87333; --tool-cu-lit: #d99a5b; --tool-fr4: #cfd8c4; --tool-void: #eef1f4; --tool-hole: #f7f9fb; --tool-ghost: #16202a; --tool-cu-ink: #2a1605;
  display: flex; flex-direction: column; gap: 10px; min-width: 0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .drc {
  --tool-cu: #c88442; --tool-cu-lit: #f0b36e; --tool-fr4: #1d2a1f; --tool-void: #0f151b; --tool-hole: #06090c; --tool-ghost: #e4ebf1; --tool-cu-ink: #1a0e04; } }
:root[data-theme="dark"] .drc { --tool-cu: #c88442; --tool-cu-lit: #f0b36e; --tool-fr4: #1d2a1f; --tool-void: #0f151b; --tool-hole: #06090c; --tool-ghost: #e4ebf1; --tool-cu-ink: #1a0e04; }
.drc-bar { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: stretch; background: var(--surface); border: 1px solid var(--line);
  border-radius: 6px; padding: 8px 10px; }
.drc-grp[hidden] { display: none; }
.drc-grp { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.drc-grp > span { font-size: 10.5px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .04em; }
.drc-fabs { display: flex; flex-wrap: wrap; gap: 4px; }
.drc-fab { display: flex; flex-direction: column; align-items: flex-start; gap: 0; padding: 3px 9px 4px; border: 1px solid var(--line);
  border-radius: 4px; background: var(--surface); cursor: pointer; color: var(--ink); min-width: 78px; text-align: left; }
.drc-fab b { font-size: 12px; font-weight: 600; } .drc-fab small { font-size: 10.5px; color: var(--ink-soft); }
.drc-fab:hover { border-color: var(--ink-soft); }
.drc-fab[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--surface)); }
.drc-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; height: 34px; }
.drc-seg button { border: 0; background: var(--surface); padding: 2px 10px; cursor: pointer; color: var(--ink-soft); display: flex; flex-direction: column;
  justify-content: center; line-height: 1.15; font-size: 12px; }
.drc-seg button small { font-size: 10px; }
.drc-seg button + button { border-left: 1px solid var(--line); }
.drc-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.drc-nums { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; }
.drc-num { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--ink-soft); }
.drc-num input { width: 70px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.drc-num input.bad { border-color: var(--danger); }
.drc-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.drc-head { display: flex; align-items: center; gap: 6px 14px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.drc-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.drc-head .sub { font-size: 11.5px; color: var(--ink-soft); }
.drc-head .right { margin-left: auto; display: flex; gap: 12px; align-items: center; font-size: 11px; color: var(--ink-soft); flex-wrap: wrap; }
.drc-key { display: inline-flex; align-items: center; gap: 4px; }
.drc-key i { display: inline-block; width: 16px; height: 9px; border-radius: 1px; }
.drc-svg { display: block; width: 100%; user-select: none; -webkit-user-select: none; }
.drc-svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.drc-svg text.soft { fill: var(--ink-soft); } .drc-svg text.small { font-size: 10px; } .drc-svg text.big { font-size: 12.5px; font-weight: 600; }
.drc-svg text.warn { fill: var(--warn); } .drc-svg text.oncu { fill: var(--tool-cu-ink); } .drc-svg text.onwarn { fill: var(--surface); font-weight: 700; } .drc-svg text.bad { fill: var(--danger); }
.drc-svg .hdl { touch-action: none; }
.drc-svg .hdl.ns { cursor: ns-resize; } .drc-svg .hdl.ew { cursor: ew-resize; } .drc-svg .hdl.rad { cursor: nesw-resize; }
.drc-svg .hdl:focus { outline: none; }
.drc-svg .hdl:focus-visible .ring { stroke: var(--accent); stroke-width: 2.5; stroke-dasharray: 3 2; }
.drc-svg .hdl:hover .ring { stroke-width: 2.5; }
.drc-svg .feat { transition: opacity .12s; }
.drc-svg.focus .feat { opacity: .28; } .drc-svg.focus .feat.on { opacity: 1; }
.drc-help { padding: 5px 10px 8px; font-size: 11.5px; color: var(--ink-soft); border-top: 1px solid var(--line-soft); }
.drc-help kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.drc-low { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; align-items: start; }
@media (max-width: 900px) { .drc-low { grid-template-columns: minmax(0, 1fr); } }
.drc-rules { list-style: none; margin: 0; padding: 4px 0; }
.drc-rules li { display: grid; grid-template-columns: 150px minmax(0, 1fr) 128px; gap: 10px; align-items: center; padding: 4px 10px; cursor: default; }
.drc-rules li:hover, .drc-rules li:focus-visible { background: var(--sunken); }
.drc-rules li:focus { outline: none; }
.drc-rules .nm { font-size: 12px; } .drc-rules .nm small { display: block; font-size: 10.5px; color: var(--ink-soft); }
.drc-rules .fig { font: 12px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.drc-rules .fig small { display: block; color: var(--ink-soft); font-size: 10.5px; }
.drc-rules svg { width: 100%; height: 22px; display: block; }
@media (max-width: 520px) { .drc-rules li { grid-template-columns: minmax(0, 1fr) 110px; } .drc-rules li svg { grid-column: 1 / -1; grid-row: 2; } }
.drc-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.drc-warns div { display: flex; gap: 6px; } .drc-warns div + div { margin-top: 4px; }
.drc-warns b { color: var(--warn); font-family: "IBM Plex Mono", ui-monospace, monospace; }
.drc-warns:empty { display: none; }
.drc-notes { font-size: 11.5px; color: var(--ink-soft); padding: 0 2px; }
.drc-notes summary { cursor: pointer; } .drc-notes div { margin-top: 4px; }
.drc .k-out { max-height: 300px; }
.drc-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
`;

export function page(root, ctx) {
  const f = (v) => ctx.fmtNum(v, 4);
  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'drc' });
  root.append(wrap);

  // ---------- the bar: board house, copper, margin, track widths ----------
  const fabBtns = {}, cuBtns = {}, mBtns = {}, fields = {};
  const fabs = h('div', { class: 'drc-fabs', role: 'group', 'aria-label': 'Board house' },
    FABS.map(([id, a, b]) => (fabBtns[id] = h('button', { type: 'button', class: 'drc-fab', 'aria-pressed': 'false', onclick: () => ctx.set('fab', id) },
      h('b', {}, a), h('small', {}, b)))));
  const cu = h('div', { class: 'drc-seg', role: 'group', 'aria-label': 'Outer copper' },
    [['1oz', '1 oz', '35 µm'], ['2oz', '2 oz', '70 µm']].map(([v, a, b]) => (cuBtns[v] = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => ctx.set('copper', v) }, a, h('small', {}, b)))));
  const mg = h('div', { class: 'drc-seg', role: 'group', 'aria-label': 'Margin over the limit' },
    MARGINS.map(([v, a, b]) => (mBtns[v] = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => ctx.set('margin', v) }, a, h('small', {}, b)))));
  const numField = (key, label) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label} (mm)`, oninput: (e) => ctx.set(key, e.target.value) });
    fields[key] = inp;
    return h('label', { class: 'drc-num' }, `${label}, mm`, inp);
  };
  const customRow = h('div', { class: 'drc-nums' }, numField('ct', 'Min track'), numField('cc', 'Min gap'), numField('cd', 'Min drill'),
    numField('cv', 'Min via pad'), numField('ce', 'To edge'));
  const customGrp = h('div', { class: 'drc-grp' }, h('span', {}, 'Custom limits'), customRow);
  wrap.append(h('section', { class: 'drc-bar', 'aria-label': 'Board house and margins' },
    h('div', { class: 'drc-grp' }, h('span', {}, 'Board house'), fabs),
    h('div', { class: 'drc-grp' }, h('span', {}, 'Outer copper'), cu),
    h('div', { class: 'drc-grp' }, h('span', {}, 'Margin over the limit'), mg),
    h('div', { class: 'drc-grp' }, h('span', {}, 'Tracks'), h('div', { class: 'drc-nums' }, numField('sig', 'Signal'), numField('pwr', 'Power'))),
    customGrp));

  // ---------- the coupon ----------
  const couponHost = h('div', {});
  const couponSub = h('span', { class: 'sub' });
  const key = h('div', { class: 'right' },
    h('span', { class: 'drc-key' }, h('i', { style: 'background:var(--tool-cu)' }), 'copper at the working rule'),
    h('span', { class: 'drc-key' }, h('i', { style: 'border:1.5px dashed var(--tool-ghost)' }), 'fab limit'));
  const help = h('div', { class: 'drc-help' });
  wrap.append(h('section', { class: 'drc-card', 'aria-label': 'Test coupon' },
    h('div', { class: 'drc-head' }, h('h2', {}, 'Coupon'), couponSub, key), couponHost, help));
  const warns = h('div', { class: 'drc-warns', role: 'status' });
  wrap.append(warns);

  // ---------- the rules ladder and the files ----------
  const rulesList = h('ul', { class: 'drc-rules' });
  const rulesSub = h('span', { class: 'sub' });
  const notes = h('details', { class: 'drc-notes' });
  wrap.append(h('div', { class: 'drc-low' },
    h('div', { class: 'drc-col' }, h('section', { class: 'drc-card' },
      h('div', { class: 'drc-head' }, h('h2', {}, 'Rules'), rulesSub), rulesList), notes),
    h('div', { class: 'drc-col' }, ctx.outputs)));

  let R = null, I = null, drag = null, focusKey = null, hot = null;

  const model = () => {
    const rows = Object.fromEntries((R?.tables?.[0]?.rows || []).map((r) => [r[0], r]));
    if (!rows['Track width']) return null;
    let rules = null;
    try { rules = JSON.parse(R.texts.find((t) => /Rules tab/.test(t.title)).body); } catch { return null; }
    const lim = (k) => num(rows[k][1]), work = (k) => num(rows[k][3]);
    const def = rules.classes.find((c) => c.name === 'Default'), pw = rules.classes.find((c) => c.name === 'Power');
    return {
      rows, rules, def, pw, pour: rules.pours[0],
      lim: { t: lim('Track width'), c: lim('Clearance'), d: lim('Via drill'), v: lim('Via pad'), ring: lim('Annular ring'), e: lim('Copper to board edge'), h: lim('Hole to hole') },
      work: { t: work('Track width'), c: work('Clearance'), d: work('Via drill'), v: work('Via pad'), ring: work('Annular ring'), e: work('Copper to board edge'), h: work('Hole to hole') },
    };
  };

  // ---------- drags: window listeners outlive the redraws ----------
  const startDrag = (e, move) => {
    e.preventDefault();
    drag = { move };
    const mv = (ev) => drag && drag.move(ev);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); drag = null; draw(); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  // Setting a limit on a named fab turns it into Custom with that fab's limits.
  const setLimit = (M, k, v) => {
    const val = r3(clamp(v, 0.02, 3));
    if (I.fab === 'custom') ctx.set(k, val);
    else ctx.setMany({ fab: 'custom', ct: r3(M.lim.t), cc: r3(M.lim.c), cd: r3(M.lim.d), cv: r3(M.lim.v), ce: r3(M.lim.e), [k]: val });
  };

  const drawCoupon = (M) => {
    const W = Math.max(300, couponHost.clientWidth || 900);
    const stack = W < 760; // narrow: vias under the tracks instead of beside them
    if (!M) {
      const svg = s('svg', { class: 'drc-svg', viewBox: `0 0 ${W} 140`, width: W, height: 140 });
      svg.append(s('rect', { x: 0, y: 0, width: W, height: 140, fill: 'var(--tool-void)' }));
      svg.append(s('text', { x: W / 2, y: 64, 'text-anchor': 'middle', class: 'warn' }, (R?.warnings || ['No rules yet'])[0]));
      svg.append(s('text', { x: W / 2, y: 84, 'text-anchor': 'middle', class: 'soft' }, 'Fill in the custom limits above to see the coupon.'));
      couponHost.replaceChildren(svg); couponSub.textContent = ''; return;
    }
    const ta = M.def.track, tp = M.pw.track, c = M.def.clearance, D = M.def.via, d = M.def.drill, Dp = M.pw.via, dp = M.pw.drill;
    const eW = M.pour.edge, pc = M.pour.clearance, h2h = M.work.h;
    // ---- layout in mm ----
    const outside = 0.25, pourW = 0.45;
    const row1 = 2 * ta + tp + 2 * c;
    const xs = eW + pourW + pc;                                   // tracks start
    const cluster = D / 2 + d + h2h + D / 2 + 0.45 + Dp;           // via A left edge .. power via right edge
    const minTrack = 1.1;
    let S, Lt, vy, viaAx, Hmm;
    const leftPx = 10, topPx = 30, botPx = stack ? 42 : 58;
    if (!stack) {
      Hmm = row1;
      const fixed = outside + xs + 0.45 + cluster + 0.15;
      S = Math.min((400 - topPx - botPx) / Hmm, (W - leftPx - 16) / (fixed + minTrack), 0.6 * (W - leftPx - 16) / fixed);
      Lt = (W - leftPx - 16) / S - (outside + xs + 0.45 + cluster + 0.15);
      viaAx = xs + Lt + 0.45 + D / 2; vy = Math.max(D, Dp) / 2 + 0.02;
    } else {
      // narrow: Default vias in a second row, the Power via in a third
      const gap = 0.32;
      Hmm = row1 + gap + D + 0.62 + Dp;
      S = Math.min((470 - topPx - botPx) / Hmm, (W - leftPx - 12) / (outside + xs + Math.max(minTrack, D + d + h2h + 0.1)));
      Lt = (W - leftPx - 12) / S - (outside + xs);
      viaAx = xs + D / 2 + 0.05; vy = row1 + gap + D / 2;
    }
    const viaBx = viaAx + d + h2h;
    const viaPx = stack ? viaAx - D / 2 + Dp / 2 : viaBx + D / 2 + 0.45 + Dp / 2;
    const vyP = stack ? vy + D / 2 + 0.62 + Dp / 2 : vy;
    const H = Math.round(topPx + Hmm * S + botPx);
    const X = (mm) => leftPx + (mm + outside) * S, Y = (mm) => topPx + mm * S;
    const xEnd = X(xs + Lt);
    const svg = s('svg', { class: `drc-svg${hot ? ' focus' : ''}`, viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'group',
      'aria-label': 'Test coupon: tracks, gap, vias and board edge at the working rules, fab limits dashed' });
    svg.append(s('rect', { x: 0, y: 0, width: W, height: H, fill: 'var(--tool-fr4)' }));
    const pat = s('pattern', { id: 'drc-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: 'var(--line)', 'stroke-width': 2 }));
    const defs = s('defs'); defs.append(pat); svg.append(defs);
    svg.append(s('rect', { x: 0, y: 0, width: X(0), height: H, fill: 'var(--tool-void)' }));
    svg.append(s('rect', { x: 0, y: 0, width: X(0), height: H, fill: 'url(#drc-hatch)' }));
    svg.append(s('line', { x1: X(0), x2: X(0), y1: 0, y2: H, stroke: 'var(--ink-soft)', 'stroke-width': 1.5 }));
    const G = (feat) => s('g', { class: `feat${hot === feat ? ' on' : ''}`, 'data-feat': feat });
    const T = (parent, x, y, t, cls = '', anchor = 'start') => parent.append(s('text', { x, y, 'text-anchor': anchor, class: cls }, t));
    const dimH = (x1, x2, y, g) => g.append(s('path', { d: `M${x1},${y - 4}v8M${x1},${y}H${x2}M${x2},${y - 4}v8`, stroke: 'var(--ink)', fill: 'none' }));
    const dimV = (x, y1, y2, g) => g.append(s('path', { d: `M${x - 4},${y1}h8M${x},${y1}V${y2}M${x - 4},${y2}h8`, stroke: 'var(--ink)', fill: 'none' }));
    const ghost = { fill: 'none', stroke: 'var(--tool-ghost)', 'stroke-dasharray': '4 3', 'stroke-width': 1.2, opacity: 0.9 };

    // the GND pour, and copper to board edge
    const gE = G('edge');
    gE.append(s('rect', { x: X(eW), y: 0, width: pourW * S, height: H, fill: 'var(--tool-cu)', opacity: 0.8 }));
    T(gE, X(eW + pourW / 2), 16, 'GND', 'small oncu', 'middle');
    const ey = Y(Hmm) + (stack ? 20 : 26);
    dimH(X(0), X(eW), ey, gE);
    T(gE, X(0) + 2, ey - 7, `${f(eW)}`, 'small');
    gE.append(s('line', { x1: X(M.lim.e), x2: X(M.lim.e), y1: 0, y2: H, ...ghost }));
    svg.append(s('text', { x: 0, y: 0, transform: `translate(${X(0) - 6},${H / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'soft small' }, 'board edge'));
    svg.append(gE);

    // three tracks, Default A and B with their gap, then Power
    const gT = G('track'), gG = G('gap');
    const tracks = [['Default', 0, ta], ['Default', ta + c, ta], ['Power', 2 * ta + 2 * c, tp]];
    tracks.forEach(([nm, y0, w], i) => {
      gT.append(s('rect', { x: X(xs), y: Y(y0), width: xEnd - X(xs), height: w * S, fill: 'var(--tool-cu)', rx: Math.min(w * S / 2, 6) }));
      gT.append(s('circle', { cx: X(xs) + (w * S) / 2, cy: Y(y0 + w / 2), r: (w / 2) * S, fill: 'var(--tool-cu)' }));
      gT.append(s('rect', { x: X(xs) + (w * S) / 2, y: Y(y0), width: xEnd - X(xs) - w * S / 2, height: Math.min(2, w * S / 4), fill: 'var(--tool-cu-lit)', opacity: 0.7 }));
      if (i === 1) return;
      const lab = stack ? (i ? `Power ${f(w)}` : f(w)) : `${nm} ${f(w)} mm`;
      if (w * S >= 15) T(gT, xEnd - 10, Y(y0 + w / 2) + 4, lab, 'big oncu', 'end');
      else T(gT, xEnd - 10, Y(y0) - 5, lab, 'big', 'end');
    });
    // track-limit ghost inside track A and the gap-limit ghost below it
    const gx0 = X(xs) + ta * S + (stack ? 8 : 16);
    const gx1 = stack ? gx0 + Math.max(40, (xEnd - gx0) * 0.3) : Math.min(xEnd - 150, gx0 + Math.max(120, (xEnd - gx0) * 0.35));
    gT.append(s('rect', { x: gx0, y: Y(0), width: gx1 - gx0, height: M.lim.t * S, ...ghost }));
    gG.append(s('line', { x1: gx0, x2: gx1, y1: Y(ta + M.lim.c), y2: Y(ta + M.lim.c), ...ghost }));
    // the gap, dimensioned near the right end
    const gdx = xEnd - 26;
    dimV(gdx, Y(ta), Y(ta + c), gG);
    if (stack) { /* the Rules list names it */ } else if (c * S >= 14) T(gG, gdx - 10, Y(ta + c / 2) + 4, `gap ${f(c)}`, 'big', 'end');
    else T(gG, gdx - 10, Y(ta + c) + 13, `gap ${f(c)}`, 'big', 'end');
    // pour to track clearance
    const gPc = G('gap');
    dimH(X(eW + pourW), X(xs), Y(ta / 2), gPc);
    T(gPc, (X(eW + pourW) + X(xs)) / 2, Y(ta / 2) - 7, f(pc), 'small', 'middle');
    svg.append(gT, gG, gPc);

    // vias: two Default vias at the hole-to-hole distance, one Power via
    const via = (cx, P, dr) => {
      const g = G('pad');
      g.append(s('circle', { cx: X(cx), cy: Y(vy), r: (P / 2) * S, fill: 'var(--tool-cu)' }));
      g.append(s('circle', { cx: X(cx), cy: Y(vy), r: (dr / 2) * S, fill: 'var(--tool-hole)', stroke: 'var(--tool-cu-lit)' }));
      svg.append(g);
    };
    const via2 = (cx, cy, P, dr) => {
      const g = G('pad');
      g.append(s('circle', { cx: X(cx), cy: Y(cy), r: (P / 2) * S, fill: 'var(--tool-cu)' }));
      g.append(s('circle', { cx: X(cx), cy: Y(cy), r: (dr / 2) * S, fill: 'var(--tool-hole)', stroke: 'var(--tool-cu-lit)' }));
      svg.append(g);
    };
    via(viaAx, D, d); via(viaBx, D, d); via2(viaPx, vyP, Dp, dp);
    const gPad = G('pad'), gDr = G('drill'), gRing = G('ring'), gH = G('h2h');
    gPad.append(s('circle', { cx: X(viaAx), cy: Y(vy), r: (M.lim.v / 2) * S, ...ghost }));
    gDr.append(s('circle', { cx: X(viaAx), cy: Y(vy), r: (M.lim.d / 2) * S, ...ghost }));
    gRing.append(s('path', { d: `M${X(viaAx - d / 2)},${Y(vy)}H${X(viaAx - D / 2)}`, stroke: 'var(--ink)', 'stroke-width': 2 }));
    const hy = Y(vy + (stack ? D : Math.max(D, Dp)) / 2) + 14;
    dimH(X(viaAx + d / 2), X(viaBx - d / 2), hy, gH);
    T(gH, (X(viaAx + d / 2) + X(viaBx - d / 2)) / 2, hy + 15, stack ? f(h2h) : `${f(h2h)} hole to hole`, 'small', 'middle');
    T(gPad, X(viaAx), Y(vy - D / 2) - 8, `via ${f(D)} / ${f(d)}`, 'big', 'middle');
    if (!stack) T(gRing, X(viaAx - D / 2) - 6, Y(vy) + 4, `ring ${f(M.work.ring)}`, 'small', 'end');
    if (stack) T(gPad, X(viaPx - Dp / 2), Y(vyP - Dp / 2) - 8, `Power via ${f(Dp)} / ${f(dp)}`, 'big');
    else T(gPad, X(viaPx), Y(vy - Dp / 2) - 8, `Power ${f(Dp)} / ${f(dp)}`, 'big', 'middle');
    svg.append(gPad, gDr, gRing, gH);

    // ---- handles ----
    const handle = (id, cls, x, y, label, value, onDrag, onKey, shape = 'bar') => {
      const g = s('g', { class: `hdl ${cls}`, tabindex: 0, role: 'slider', 'data-h': id, 'aria-label': label, 'aria-valuenow': value, 'aria-valuetext': `${value} mm` });
      g.append(s('rect', { x: x - 14, y: y - 12, width: 28, height: 24, fill: 'transparent' }));
      if (shape === 'bar') g.append(s('rect', { class: 'ring', x: x - 11, y: y - 4, width: 22, height: 8, rx: 4, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 1.5 }));
      else g.append(s('rect', { class: 'ring', x: x - 5, y: y - 5, width: 10, height: 10, transform: `rotate(45 ${x} ${y})`, fill: 'var(--surface)', stroke: 'var(--tool-ghost)', 'stroke-width': 1.5 }));
      const tt = s('title'); tt.textContent = label; g.append(tt);
      g.addEventListener('pointerdown', (e) => startDrag(e, onDrag(e)));
      g.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 0.05 : 0.01;
        const dir = ['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 0;
        if (dir) { e.preventDefault(); focusKey = id; onKey(dir * st); }
      });
      svg.append(g);
    };
    const k = () => (W / svg.getBoundingClientRect().width) / S; // mm per screen px
    const hx = stack ? gx1 + 24 : Math.min(xEnd - 190, gx1 + 60);
    const dragY = (v0, set) => (e) => { const y0 = e.clientY, kk = k(); return (ev) => set(v0 + (ev.clientY - y0) * kk); };
    handle('sig', 'ns', hx, Y(ta), 'Default signal track width (drag its lower edge)', f(ta),
      dragY(ta, (v) => ctx.set('sig', r3(clamp(v, 0.05, 5)))), (dv) => ctx.set('sig', r3(clamp(ta + dv, 0.05, 5))));
    handle('pwr', 'ns', hx, Y(2 * ta + 2 * c + tp), 'Power track width (drag its lower edge)', f(tp),
      dragY(tp, (v) => ctx.set('pwr', r3(clamp(v, 0.05, 5)))), (dv) => ctx.set('pwr', r3(clamp(tp + dv, 0.05, 5))));
    const gxm = (gx0 + gx1) / 2;
    handle('ct', 'ns', gxm - 24, Y(M.lim.t), 'Fab limit: minimum track (makes the fab Custom)', f(M.lim.t),
      dragY(M.lim.t, (v) => setLimit(M, 'ct', v)), (dv) => setLimit(M, 'ct', M.lim.t + dv), 'ghost');
    handle('cc', 'ns', gxm + 24, Y(ta + M.lim.c), 'Fab limit: minimum gap (makes the fab Custom)', f(M.lim.c),
      dragY(M.lim.c, (v) => setLimit(M, 'cc', v)), (dv) => setLimit(M, 'cc', M.lim.c + dv), 'ghost');
    T(svg, gx0 + 2, Y(0) - 5, stack ? `limit ${f(M.lim.t)} / ${f(M.lim.c)}` : `limit ${f(M.lim.t)} track · ${f(M.lim.c)} gap`, 'soft small');
    const a = Math.SQRT1_2;
    handle('cv', 'rad', X(viaAx) - (M.lim.v / 2) * S * a, Y(vy) + (M.lim.v / 2) * S * a, 'Fab limit: minimum via pad (makes the fab Custom)', f(M.lim.v),
      (e) => { const x0 = e.clientX, y0 = e.clientY, v0 = M.lim.v, kk = k(); return (ev) => setLimit(M, 'cv', v0 + ((x0 - ev.clientX) + (ev.clientY - y0)) * a * 2 * kk); },
      (dv) => setLimit(M, 'cv', M.lim.v + dv), 'ghost');
    handle('cd', 'rad', X(viaAx) + (M.lim.d / 2) * S * a, Y(vy) + (M.lim.d / 2) * S * a, 'Fab limit: minimum via drill (makes the fab Custom)', f(M.lim.d),
      (e) => { const x0 = e.clientX, y0 = e.clientY, v0 = M.lim.d, kk = k(); return (ev) => setLimit(M, 'cd', v0 + ((ev.clientX - x0) + (ev.clientY - y0)) * a * 2 * kk); },
      (dv) => setLimit(M, 'cd', M.lim.d + dv), 'ghost');
    const ceY = stack ? Y(row1 + 0.16) : Y(row1 * 0.8);
    handle('ce', 'ew', X(M.lim.e), ceY, 'Fab limit: copper to board edge (makes the fab Custom)', f(M.lim.e),
      (e) => { const x0 = e.clientX, v0 = M.lim.e, kk = k(); return (ev) => setLimit(M, 'ce', v0 + (ev.clientX - x0) * kk); },
      (dv) => setLimit(M, 'ce', M.lim.e + dv), 'ghost');
    T(svg, X(0) + 3, ey + 16, `${stack ? 'lim' : 'limit'} ${f(M.lim.e)}`, 'soft small');

    // warnings, numbered, where the problem is
    const anchors = { track: [hx + 26, Y(ta / 2)], gap: [gdx - 70, Y(ta + c / 2)], drill: [X(viaAx), Y(vy)], ring: [X(viaAx), Y(vy - D / 2) - 30], pad: [X(viaAx), Y(vy - D / 2) - 30] };
    const seen = {};
    (R.warnings || []).forEach((w, i) => {
      const ft = warnFeat(w), an = anchors[ft];
      if (!an) return;
      const n = (seen[ft] = (seen[ft] || 0) + 1) - 1;
      const x = an[0] + n * 20, y = an[1];
      const g = s('g', { role: 'img', 'aria-label': `Warning ${i + 1}: ${w}` });
      g.append(s('path', { d: `M${x},${y - 10}l10,17h-20z`, fill: 'var(--warn)', stroke: 'var(--surface)', 'stroke-width': 1.5 }));
      g.append(s('text', { x, y: y + 5, 'text-anchor': 'middle', class: 'small onwarn' }, String(i + 1)));
      const tt = s('title'); tt.textContent = w; g.append(tt);
      svg.append(g);
    });
    // scale bar
    const sb = 0.1 * S, sbx = W - sb - 110, sby = H - 12;
    svg.append(s('path', { d: `M${sbx},${sby - 5}v5H${sbx + sb}v-5`, stroke: 'var(--ink)', fill: 'none' }));
    T(svg, sbx + sb + 6, sby, `0.1 mm (${f(S * 0.2645)}×)`, 'soft small');
    couponHost.replaceChildren(svg);
    couponSub.textContent = `to scale · ${M.rules.classes.length} net classes · board minimums ${f(M.rules.board.min_track)} / ${f(M.rules.board.min_clearance)} mm`;
  };

  const drawRules = (M) => {
    rulesList.replaceChildren();
    if (!M) { rulesSub.textContent = ''; return; }
    const rows = R.tables[0].rows;
    const max = Math.max(...rows.map((r) => Math.max(num(r[1]), num(r[3])))) * 1.08;
    rulesSub.textContent = 'fab limit (dashed) → working value (copper); hover to find it';
    for (const r of rows) {
      const feat = RULE_FEAT[r[0]];
      const lim = num(r[1]), wk = num(r[3]);
      const bar = s('svg', { viewBox: '0 0 200 22', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      bar.append(s('rect', { x: 0, y: 7, width: (wk / max) * 200, height: 8, fill: 'var(--tool-cu)', rx: 1 }));
      bar.append(s('rect', { x: 0, y: 4, width: (lim / max) * 200, height: 14, fill: 'none', stroke: 'var(--tool-ghost)', 'stroke-dasharray': '3 2', 'vector-effect': 'non-scaling-stroke' }));
      const li = h('li', { tabindex: 0, 'data-feat': feat,
        onmouseenter: () => { hot = feat; paintHot(); }, onmouseleave: () => { hot = null; paintHot(); },
        onfocus: () => { hot = feat; paintHot(); }, onblur: () => { hot = null; paintHot(); } },
      h('div', { class: 'nm' }, r[0], h('small', {}, r[4])),
      bar,
      h('div', { class: 'fig' }, `${r[1]} → ${r[3]}`, h('small', {}, `limit ${r[2]} mil`)));
      rulesList.append(li);
    }
  };
  const paintHot = () => {
    const svg = couponHost.querySelector('svg');
    if (!svg) return;
    svg.classList.toggle('focus', !!hot);
    for (const g of svg.querySelectorAll('.feat')) g.classList.toggle('on', g.dataset.feat === hot);
  };

  const sync = () => {
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(fields)) {
      if (document.activeElement !== el) el.value = raw[k] ?? '';
      const t = String(raw[k] ?? '').trim();
      el.classList.toggle('bad', t !== '' && ctx.parseEng(t) == null);
    }
    for (const [k, b] of Object.entries(fabBtns)) b.setAttribute('aria-pressed', String(raw.fab === k));
    for (const [k, b] of Object.entries(cuBtns)) b.setAttribute('aria-pressed', String(raw.copper === k));
    for (const [k, b] of Object.entries(mBtns)) b.setAttribute('aria-pressed', String(raw.margin === k));
    customGrp.hidden = raw.fab !== 'custom';
  };

  const draw = () => {
    if (!R) return;
    sync();
    const M = model();
    drawCoupon(M);
    drawRules(M);
    warns.replaceChildren(...(R.warnings || []).map((w, i) => h('div', {}, h('b', {}, String(i + 1)), h('span', {}, w))));
    notes.replaceChildren(h('summary', {}, `Notes (${(R.notes || []).length})`), ...(R.notes || []).map((n) => h('div', {}, n)));
    help.innerHTML = 'Drag the round-ended handles on a track\'s lower edge to set the signal or power width. The dashed diamonds are the fab\'s limits: drag one (or focus it and press <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Shift</kbd> for 0.05 mm) and the fab becomes Custom with that limit.';
    if (focusKey) { root.querySelector(`[data-h="${focusKey}"]`)?.focus(); focusKey = null; }
  };

  ctx.onResult((res, input) => { R = res; I = input; draw(); });
  let lastW = 0;
  new ResizeObserver(() => { const w = couponHost.clientWidth; if (w !== lastW && !drag) { lastW = w; draw(); } }).observe(couponHost);
}
