// Terminal Block & Crimp Reference: the page is the wire. A cross-section
// ruler (mm² above, AWG below) carries a cursor you drag to the wire size;
// under it hangs the whole catalogue as the range each part takes, so what
// fits is simply what the cursor crosses. Beside it, the wire end drawn to
// scale with its ferrule (DIN colour, pin length), and the part you click,
// with the wire sitting in its openings. Every number comes from run()
// (result.crimp).

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
const sig = (v, n = 3) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(n))));
function drag(e, move, end) {
  e.preventDefault();
  const mv = (ev) => move(ev);
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); end?.(); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
const din = (name) => `var(--tool-din-${String(name).replace(/\s+/g, '-')})`;

const MM = [0.14, 0.25, 0.34, 0.5, 0.75, 1, 1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120];
const CATS = [['all', 'All'], ['ferrule', 'Ferrules'], ['insulated', 'Insulated'], ['tube', 'Tube lugs'], ['pcb', 'PCB blocks'], ['din-rail', 'DIN rail'], ['wire-to-board', 'Wire-to-board']];
const GROUPS = [
  ['Ferrule', 'Ferrules · DIN 46228-4', 'dots'],
  ['Insulated', 'Insulated crimp terminals', 'bands'],
  ['Tube', 'Tube lugs · DIN 46235', 'dots'],
  ['PCB', 'PCB terminal blocks', 'bars'],
  ['DIN', 'DIN-rail terminal blocks', 'bars'],
  ['Wire-to-board', 'Wire-to-board crimp housings', 'bars'],
];
const A0 = 0.025, A1 = 160;
const VKEY = 'redline.tool.crimp-reference.view';
const loadView = () => { try { return JSON.parse(localStorage.getItem(VKEY) || '{}') || {}; } catch { return {}; } };
const saveView = (v) => { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* private window */ } };

const shortName = (r) => {
  if (r.kind.startsWith('PCB')) return `${r.fit} ${/pluggable/i.test(r.part) ? (/screw/i.test(r.part) ? 'screw/plug' : 'pluggable') : 'screw'}`;
  if (r.kind.startsWith('DIN')) return `${r.part.replace(' class', '')} · ${r.fit.replace(' wide', '')}`;
  const t = r.part.replace(' / 2.54 mm header housing', ' 2.54 housing');
  return t.length > 24 ? `${t.slice(0, 23)}…` : t;
};
const pitchOf = (r) => { const m = String(r.fit).match(/(\d+(?:\.\d+)?)(?!.*\d)/); return m && /mm/.test(r.fit) ? Number(m[1]) : null; };

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  const view = loadView();
  let C = null, res = null, refocusSel = null;

  // ---------- top ----------
  const wireInp = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Wire size: mm² or AWG', placeholder: '1.5, 18 AWG',
    oninput: (e) => ctx.set('wire', e.target.value) });
  const filtInp = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Filter the parts', placeholder: 'filter: 5.08, JST…',
    oninput: (e) => ctx.set('filter', e.target.value) });
  const catSeg = h('div', { class: 'cr-seg', role: 'radiogroup', 'aria-label': 'Show' });
  const catBtns = CATS.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set('category', v),
    onkeydown: (e) => { const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault();
      const n = CATS[clamp(CATS.findIndex((c) => c[0] === v) + d, 0, CATS.length - 1)][0]; ctx.set('category', n); refocusSel = `.cr-seg [data-v="${n}"]`; } }, t));
  catSeg.append(...catBtns);
  const top = h('div', { class: 'cr-top' },
    h('label', { class: 'cr-num cr-wire' }, h('span', {}, 'Wire'), wireInp),
    catSeg, h('label', { class: 'cr-num cr-filter' }, filtInp));

  // ---------- the catalogue on the wire-size axis ----------
  const chartSvg = sv(null, 'svg', { class: 'cr-chart-svg', role: 'group', 'aria-label': 'Every part as the range of wire it takes, against wire cross-section' });
  const chartHead = h('div', { class: 'cr-head' });
  const chart = h('section', { class: 'cr-card cr-chart' }, chartHead, h('div', { class: 'cr-box' }, chartSvg));

  // ---------- wire end + chosen part ----------
  const endSvg = sv(null, 'svg', { class: 'cr-end-svg', role: 'img', 'aria-label': 'The wire end with its ferrule, to scale' });
  const endHead = h('div', { class: 'cr-head' });
  const end = h('section', { class: 'cr-card cr-end' }, endHead, endSvg);
  const partSvg = sv(null, 'svg', { class: 'cr-part-svg', role: 'img', 'aria-label': 'The chosen part with the wire in it, to scale' });
  const partInfo = h('div', { class: 'cr-info' });
  const part = h('section', { class: 'cr-card cr-part' }, h('div', { class: 'cr-head' }, h('span', { class: 'cr-cap' }, 'Chosen part'), h('span', { class: 'cr-sub' }, 'click a bar to choose')), partSvg, partInfo);
  const warnBox = h('div', { class: 'cr-warns', 'aria-live': 'polite' });
  const side = h('aside', { class: 'cr-side' }, end, part, warnBox, ctx.outputs);
  const layout = h('div', { class: 'cr' }, top, chart, side);
  root.append(layout);

  // sizes the cursor snaps to: metric series and gauges
  const stops = () => {
    const s = MM.map((a) => ({ area: a, text: String(a), label: `${a} mm²` }));
    for (const t of C.awgTicks) if (t.area >= 0.03 && t.area <= 130) s.push({ area: t.area, text: `${t.awg} AWG`, label: `${t.awg} AWG` });
    return s.sort((a, b) => a.area - b.area);
  };
  const nearestStop = (a) => stops().reduce((b, s) => (Math.abs(Math.log(s.area / a)) < Math.abs(Math.log(b.area / a)) ? s : b));

  // ---------- chart ----------
  function drawChart() {
    const svg = chartSvg;
    svg.replaceChildren();
    const box = svg.parentNode;
    const stacked = window.matchMedia('(max-width: 900px)').matches;
    const W = Math.max(300, box.clientWidth || 800), Hbox = stacked ? 0 : Math.max(300, (box.clientHeight || 600) - 2);
    const narrow = W < 560;
    const labW = narrow ? 0 : Math.min(210, W * 0.24);
    const ml = labW + 12, mr = 44, rulerH = 64;
    const X = (a) => ml + Math.log(a / A0) / Math.log(A1 / A0) * (W - ml - mr);
    const inv = (x) => A0 * Math.pow(A1 / A0, clamp((x - ml) / (W - ml - mr), 0, 1));
    const groups = GROUPS.map(([key, title, mode]) => ({ key, title, mode, rows: C.catalog.filter((r) => r.kind.startsWith(key)) }));
    const nRows = groups.reduce((n, g) => n + (g.mode === 'bars' ? g.rows.length : 1), 0);
    const headH = narrow ? 30 : 19;
    const rowH = clamp((Hbox - rulerH - 10 - groups.length * headH) / nRows, narrow ? 22 : 12, 24);
    const H = Math.max(Hbox, rulerH + 10 + groups.length * headH + nRows * rowH);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    const a = C.area, cx = X(clamp(a, A0, A1));

    // ruler: mm² ticks above, AWG below
    const ry = 30;
    sv(svg, 'path', { d: `M${ml},${ry}H${W - mr}`, class: 'cr-rule' });
    let lastX = -99;
    for (const m of MM) {
      const x = X(m);
      sv(svg, 'path', { d: `M${x},${ry - 6}V${ry}`, class: 'cr-tick' });
      const w = String(m).length * 6.4 + 8;
      if (x - w / 2 >= lastX) { sv(svg, 'text', { x, y: ry - 9, 'text-anchor': 'middle', class: 'cr-tick-t' }, m); lastX = x + w / 2; }
    }
    sv(svg, 'text', { x: W - mr + 4, y: ry - 9, class: 'cr-unit' }, 'mm²');
    C.awgTicks.forEach((t) => {
      if (t.area < A0 || t.area > A1) return;
      const x = X(t.area), n = parseInt(t.awg, 10);
      sv(svg, 'path', { d: `M${x},${ry}V${ry + 5}`, class: 'cr-tick' });
      const show = /\/0/.test(t.awg) ? t.awg === '4/0' || (!narrow && t.awg === '2/0') : narrow ? n % 6 === 4 : n % 2 === 0 && (n <= 30);
      if (show) sv(svg, 'text', { x, y: ry + 16, 'text-anchor': 'middle', class: 'cr-tick-t cr-awg' }, t.awg);
    });
    sv(svg, 'text', { x: W - mr + 4, y: ry + 16, class: 'cr-unit' }, 'AWG');

    // rows
    let y = rulerH;
    const rowsTop = y;
    const selId = view.sel;
    groups.forEach((g) => {
      const hit = g.mode === 'bars' ? null : g.rows.find((r) => r.fits && r.shown);
      const extra = !hit ? '' : g.key === 'Ferrule' ? ` — ${hit.part.replace(' ferrule', '')}${narrow ? '' : `, ${hit.fit}`}` : g.key === 'Tube' ? ` — ${hit.part}, ${hit.fit}` : ` — ${hit.part.split(' ')[0].toLowerCase()}`;
      const tt = sv(svg, 'text', { x: 8, y: y + headH - 6, class: 'cr-group' }, g.title);
      if (extra) sv(tt, 'tspan', { class: 'cr-group-hit' }, extra);
      sv(svg, 'path', { d: `M${narrow ? 8 : ml},${y + headH - 2}H${W - mr}`, class: 'cr-grule' });
      y += headH;
      const drawItem = (r, yy, hh) => {
        const on = r.fits && r.shown, dim = !r.shown;
        const cls = `cr-item${on ? ' cr-fit' : ''}${dim ? ' cr-dim' : ''}${r.id === selId ? ' cr-selected' : ''}`;
        const gi = sv(svg, 'g', { class: cls, tabindex: dim ? -1 : 0, role: 'button', 'data-id': r.id,
          'aria-label': `${r.part}: ${sig(r.lo)}${r.hi !== r.lo ? `-${sig(r.hi)}` : ''} mm²${on ? ', takes this wire' : ''}` });
        if (g.mode === 'dots') {
          const col = r.kind.startsWith('Ferrule') ? din(r.part.split(', ')[1]) : 'var(--tool-lug)';
          const x = X(r.lo);
          sv(gi, 'circle', { cx: x, cy: yy + hh / 2, r: on ? 7 : 5, style: `fill:${col}`, class: 'cr-dot' });
        } else if (g.mode === 'bands') {
          const colName = r.part.split(' ')[0].toLowerCase();
          sv(gi, 'rect', { x: X(r.lo), y: yy + 3, width: Math.max(4, X(r.hi) - X(r.lo)), height: hh - 6, rx: 3, style: `fill:${din(colName)}`, class: 'cr-band' });
          sv(gi, 'text', { x: (X(r.lo) + X(r.hi)) / 2, y: yy + hh / 2 + 4, 'text-anchor': 'middle', class: `cr-band-t cr-on-${colName}` }, colName);
        } else {
          const x0 = X(r.lo), x1 = X(r.hi);
          sv(gi, 'rect', { x: 0, y: yy, width: W, height: hh, class: 'cr-rowhit' });
          if (!narrow) sv(gi, 'text', { x: labW + 4, y: yy + hh / 2 + 4, 'text-anchor': 'end', class: 'cr-lbl' }, shortName(r));
          const bh = narrow ? hh * 0.4 : hh - 6;
          const by = narrow ? yy + hh - bh - 2 : yy + 3;
          sv(gi, 'rect', { x: x0, y: by, width: Math.max(3, x1 - x0), height: bh, rx: 2, class: 'cr-bar' });
          if (narrow) sv(gi, 'text', { x: clamp(x0, 8, W - 150), y: by - 3, class: 'cr-lbl cr-lbl-n' }, `${shortName(r)}${r.amps != null ? ` · ${r.amps} A` : ''}`);
          else if (r.amps != null) sv(gi, 'text', { x: x1 + 5, y: yy + hh / 2 + 4, class: 'cr-amps' }, `${r.amps} A`);
        }
        gi.addEventListener('click', () => choose(r.id));
        gi.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(r.id); } });
      };
      if (g.mode === 'bars') g.rows.forEach((r, i) => drawItem(r, y + i * rowH, rowH));
      else g.rows.forEach((r) => drawItem(r, y, rowH));
      y += (g.mode === 'bars' ? g.rows.length : 1) * rowH;
    });

    // the cursor: the wire
    const cur = sv(svg, 'g', { class: 'cr-cursor', tabindex: 0, role: 'slider', 'aria-label': 'Wire cross-section; drag along the ruler, or arrow keys',
      'aria-valuenow': sig(a), 'aria-valuetext': `${C.given}` });
    sv(cur, 'rect', { x: ml, y: 0, width: W - ml - mr, height: rulerH - 16, class: 'cr-hit' });
    sv(svg, 'path', { d: `M${cx},${ry}V${y}`, class: 'cr-cline' });
    sv(cur, 'path', { d: `M${cx},${ry - 4}l-7,-11h14z`, class: 'cr-cknob' });
    const lbl = `${C.given}${C.awg == null ? ` ≈ ${C.nearestAwg} AWG` : ` = ${sig(a)} mm²`}`;
    const lw = lbl.length * 7 + 14;
    const lx = clamp(cx - lw / 2, ml - 10, W - lw - 2);
    sv(cur, 'rect', { x: lx, y: ry + 22, width: lw, height: 18, rx: 3, class: 'cr-clbl-bg' });
    sv(cur, 'text', { x: lx + lw / 2, y: ry + 35, 'text-anchor': 'middle', class: 'cr-clbl' }, lbl);
    void rowsTop;
    const setStop = (s) => ctx.set('wire', s.text);
    cur.addEventListener('pointerdown', (e) => {
      const r = svg.getBoundingClientRect();
      const mv = (ev) => { const s = nearestStop(inv((ev.clientX - r.left) * (W / r.width))); if (s.text !== ctx.raw.wire) setStop(s); };
      drag(e, mv); mv(e);
    });
    cur.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return; e.preventDefault();
      const st = stops();
      let i = st.findIndex((s) => s.area > a * 1.001);
      if (d < 0) { i = -1; for (let j = 0; j < st.length; j++) if (st[j].area < a * 0.999) i = j; }
      const s = st[clamp(i < 0 ? (d > 0 ? st.length - 1 : 0) : i, 0, st.length - 1)];
      setStop(s); refocusSel = '.cr-cursor';
    });
    chartHead.replaceChildren(h('span', { class: 'cr-cap' }, `${C.matches} part${C.matches === 1 ? '' : 's'} take ${C.given}`),
      h('span', { class: 'cr-sub' }, 'drag the wire along the ruler · ranges are typical catalogue values'));
  }

  function choose(id) { view.sel = id; saveView(view); draw(); refocusSel = `.cr-item[data-id="${id}"]`; }

  // ---------- the wire end ----------
  function drawEnd() {
    const svg = endSvg;
    svg.replaceChildren();
    const W = Math.max(280, svg.clientWidth || 380), H = 150;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const d = C.diameter, ins = d * 1.45 + 0.8;          // insulation drawn around the conductor
    const f = C.ferrule;
    const pin = f ? f.pin : 8, collar = f ? Math.max(3, ins * 0.9) : 0;
    const secW = 96;                                       // cross-section on the right
    const len = 12 + collar + pin;                         // mm shown in side view
    const k = Math.min((W - secW - 40) / len, 60 / Math.max(ins * 1.25, 1));
    const cy = 64, x0 = 16;
    const Y = (mm) => cy + mm * k;
    const xi = x0 + 12 * k;                                // insulation ends
    sv(svg, 'rect', { x: x0, y: Y(-ins / 2), width: xi - x0, height: ins * k, rx: 2, class: 'cr-insul' });
    if (f) {
      const col = din(f.colour);
      // plastic collar over the insulation, then the metal sleeve
      sv(svg, 'path', { d: `M${xi - collar * 0.35 * k},${Y(-ins / 2 - 0.25)}H${xi + collar * 0.65 * k}L${xi + collar * k},${Y(-d / 2 - 0.2)}V${Y(d / 2 + 0.2)}L${xi + collar * 0.65 * k},${Y(ins / 2 + 0.25)}H${xi - collar * 0.35 * k}Z`, style: `fill:${col}`, class: 'cr-collar' });
      const xs = xi + collar * k;
      sv(svg, 'rect', { x: xs, y: Y(-d / 2 - 0.15), width: pin * k, height: (d + 0.3) * k, class: 'cr-sleeve' });
      for (let i = 1; i < 4; i++) sv(svg, 'path', { d: `M${xs + pin * k * i / 4},${Y(-d / 2 - 0.15)}v${(d + 0.3) * k}`, class: 'cr-crimp' });
      // dimension: pin length = strip length
      const dy = Y(ins / 2) + 20;
      sv(svg, 'path', { d: `M${xs},${dy - 5}v10M${xs + pin * k},${dy - 5}v10M${xs},${dy}H${xs + pin * k}`, class: 'cr-dim' });
      sv(svg, 'text', { x: xs + pin * k / 2, y: dy + 15, 'text-anchor': 'middle', class: 'cr-dim-t' }, `strip ${f.pin} mm`);
      sv(svg, 'text', { x: xi - collar * 0.35 * k, y: Y(-ins / 2) - 10, class: 'cr-dim-t' }, `${sig(f.mm2)} mm² · ${f.colour}`);
    } else {
      sv(svg, 'rect', { x: xi, y: Y(-d / 2), width: 8 * k, height: d * k, class: 'cr-bare' });
      sv(svg, 'text', { x: xi, y: Y(-ins / 2) - 10, class: 'cr-dim-t cr-soft' }, 'no DIN 46228 ferrule for this size');
    }
    // cross-section, drawn larger, strands to show a stranded conductor
    const sx = W - secW / 2 - 6, sr = 34;
    const core = sr * d / ins;
    sv(svg, 'circle', { cx: sx, cy, r: sr, class: 'cr-insul' });
    sv(svg, 'circle', { cx: sx, cy, r: core, class: 'cr-core' });
    const rings = clamp(Math.round(1 + Math.log2(Math.max(C.area, 0.1) / 0.2)), 1, 5);
    const sr1 = core / (2 * rings + 1);
    for (let ring = 0; ring <= rings; ring++) {
      const n = ring === 0 ? 1 : 6 * ring;
      for (let i = 0; i < n; i++) { const t = (i / n) * 2 * Math.PI; sv(svg, 'circle', { cx: sx + Math.cos(t) * ring * 2 * sr1, cy: cy + Math.sin(t) * ring * 2 * sr1, r: sr1 * 0.92, class: 'cr-strand' }); }
    }
    sv(svg, 'text', { x: sx, y: H - 12, 'text-anchor': 'middle', class: 'cr-dim-t' }, `Ø ${sig(d)} mm Cu`);
    endHead.replaceChildren(h('span', { class: 'cr-cap' }, `Wire end · ${C.given}`),
      h('span', { class: 'cr-sub' }, C.insulated ? `insulated terminals: ${C.insulated.colour}` : 'no insulated colour'));
  }

  // ---------- the chosen part ----------
  function drawPart() {
    const svg = partSvg;
    svg.replaceChildren();
    const W = Math.max(280, svg.clientWidth || 380), H = 120;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let r = C.catalog.find((x) => x.id === view.sel);
    if (!r) r = C.catalog.find((x) => x.fits && x.shown && /^(PCB|DIN|Wire)/.test(x.kind)) || C.catalog.find((x) => x.fits && x.shown && !x.kind.startsWith('Ferrule')) || C.catalog.find((x) => x.fits) || C.catalog[0];
    const fits = r.fits;
    const d = C.diameter;
    const p = pitchOf(r);
    if (p && !r.kind.startsWith('Ferrule') && !r.kind.startsWith('Tube') && !r.kind.startsWith('Insulated')) {
      // three positions at the pitch, each opening sized for the part's largest wire
      const open = Math.sqrt((4 * r.hi) / Math.PI) * 1.35 + 0.3;
      const bodyW = 3 * p, bodyH = Math.max(open * 2.4, p * 1.2);
      const k = Math.min((W - 60) / bodyW, (H - 40) / bodyH);
      const x0 = (W - bodyW * k) / 2, y0 = 12;
      sv(svg, 'rect', { x: x0, y: y0, width: bodyW * k, height: bodyH * k, rx: 3, class: 'cr-housing' });
      for (let i = 0; i < 3; i++) {
        const cx = x0 + (i + 0.5) * p * k, cy = y0 + bodyH * k * 0.55;
        sv(svg, 'rect', { x: cx - open * k / 2, y: cy - open * k / 2, width: open * k, height: open * k, rx: 1.5, class: 'cr-open' });
        if (i === 1) sv(svg, 'circle', { cx, cy, r: Math.max(1.5, d * k / 2), class: `cr-wirein ${fits ? 'cr-ok' : 'cr-bad'}` });
      }
      const dy = y0 + bodyH * k + 12;
      const xa = x0 + 0.5 * p * k, xb = x0 + 1.5 * p * k;
      sv(svg, 'path', { d: `M${xa},${dy - 5}v10M${xb},${dy - 5}v10M${xa},${dy}H${xb}`, class: 'cr-dim' });
      sv(svg, 'text', { x: (xa + xb) / 2, y: dy + 15, 'text-anchor': 'middle', class: 'cr-dim-t' }, `${r.fit}`);
    } else {
      // ferrule, lug or insulated terminal: the barrel end-on with the wire in it
      const inner = r.kind.startsWith('Insulated') ? Math.sqrt((4 * r.hi) / Math.PI) * 1.15 : Math.sqrt((4 * r.hi) / Math.PI) * 1.08;
      const outer = inner * 1.5 + 0.4;
      const k = Math.min((H - 30) / (outer * 1.6), 40);
      const cx = W / 2, cy = H / 2 - 6;
      const col = r.kind.startsWith('Insulated') ? din(r.part.split(' ')[0].toLowerCase()) : r.kind.startsWith('Ferrule') ? din(r.part.split(', ')[1]) : 'var(--tool-lug)';
      if (!r.kind.startsWith('Tube')) sv(svg, 'circle', { cx, cy, r: outer * 0.8 * k, style: `fill:${col}`, class: 'cr-collar' });
      sv(svg, 'circle', { cx, cy, r: outer / 2 * k, class: 'cr-sleeve' });
      sv(svg, 'circle', { cx, cy, r: inner / 2 * k, class: 'cr-open' });
      sv(svg, 'circle', { cx, cy, r: Math.max(1.5, d * k / 2), class: `cr-wirein ${fits ? 'cr-ok' : 'cr-bad'}` });
      sv(svg, 'text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'cr-dim-t' }, 'end-on, wire in the barrel');
    }
    const range = r.lo === r.hi ? `${sig(r.lo)} mm²` : `${sig(r.lo)}–${sig(r.hi)} mm²`;
    partInfo.replaceChildren(
      h('div', { class: 'cr-pname' }, r.part),
      h('div', { class: 'cr-kv' },
        h('span', {}, r.kind), h('span', {}, r.fit),
        h('span', {}, 'takes ', h('b', {}, range), ` · ${r.awgText} AWG`),
        r.amps != null ? h('span', {}, 'rated ', h('b', {}, `${r.amps} A`)) : null),
      h('div', { class: `cr-verdict ${fits ? 'cr-ok' : 'cr-bad'}` }, fits ? `takes ${C.given}` : `${C.given} is outside its range`),
      r.note ? h('div', { class: 'cr-note' }, r.note) : null);
  }

  function drawTop() {
    const raw = ctx.raw;
    if (document.activeElement !== wireInp) wireInp.value = raw.wire ?? '';
    if (document.activeElement !== filtInp) filtInp.value = raw.filter ?? '';
    for (const b of catBtns) { const on = b.dataset.v === (raw.category || 'all'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
  }

  function draw() {
    // a redraw replaces the drawing: keep keyboard focus on the same handle
    if (!refocusSel && root.contains(document.activeElement) && document.activeElement instanceof SVGElement) {
      const a = document.activeElement, c = (a.getAttribute('class') || '').split(' ')[0];
      const key = ['data-c', 'data-k', 'data-id'].find((k) => a.hasAttribute(k));
      if (c) refocusSel = `.${c}${key ? `[${key}="${a.getAttribute(key)}"]` : ''}`;
    }
    drawTop();
    const w = res?.warnings || [];
    warnBox.replaceChildren(...w.map((t) => h('div', {}, t)));
    warnBox.hidden = !w.length;
    if (!C) { chartSvg.replaceChildren(); endSvg.replaceChildren(); partSvg.replaceChildren(); partInfo.replaceChildren(); chartHead.replaceChildren(h('span', { class: 'cr-cap' }, 'Give a wire size: 1.5, 0.75 mm², 18 AWG or 2/0')); return; }
    drawChart(); drawEnd(); drawPart();
    if (refocusSel) { const el = root.querySelector(refocusSel); refocusSel = null; el?.focus(); }
  }

  ctx.onResult((r) => { res = r; C = r.crimp || null; draw(); });
  let rsz = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(rsz); rsz = requestAnimationFrame(() => { if (C) draw(); }); });
  for (const el of [layout, chartSvg.parentNode, side]) ro.observe(el);
}
