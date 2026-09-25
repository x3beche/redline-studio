// Thermal Expansion: the page is the part in its housing. A thermometer to
// drag (T1 assembly, T2 operating) with the clearance plotted against it, the
// assembly drawn with its growth exaggerated so it can be seen, and a CTE
// ruler on which the two materials are picked by pointing.
// Every number drawn comes from run()'s result (result.draw).
import { MATS } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const SHORT = {
  al: 'Al 6061', steel: 'Steel', ss: 'SS 304', brass: 'Brass', cu: 'Copper', ti: 'Ti-6Al-4V', zamak: 'Zamak', invar: 'Invar 36',
  fr4: 'FR-4 xy', fr4z: 'FR-4 z', alumina: 'Alumina', si: 'Silicon', glass: 'Glass', abs: 'ABS', pc: 'PC', pa66: 'PA66',
  pa66gf: 'PA66-GF30', pom: 'POM', pmma: 'PMMA', pla: 'PLA', petg: 'PETG', peek: 'PEEK', ptfe: 'PTFE', hdpe: 'HDPE',
};
const ORDER = Object.keys(MATS).sort((x, y) => MATS[x][1] - MATS[y][1] || x.localeCompare(y));
const PRESETS = [-40, 0, 85, 105, 125];

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
const g3 = (v, d = 3) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(d))));
const sgn = (v, d = 3) => (v > 0 ? '+' : v < 0 ? '−' : '') + g3(Math.abs(v), d);
const um = (mm, d = 3) => `${sgn(mm * 1000, d)} µm`;
const niceStep = (span, n) => {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};
const gapTone = (g) => (g == null ? '' : g < 0 ? 'bad' : g < 0.02 ? 'warn' : 'ok');

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let D = null, res = null;
  let pickFor = 'part';        // which material a click on the ruler sets
  let lockE = null;            // the exaggeration held still while the part end is dragged

  // ---------- thermometer ----------
  const tSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'Thermometer: T1 and T2, with the clearance against temperature' });
  const numField = (key, label) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': label,
      oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'te-num' }, h('span', {}, label), inp);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const t1F = numField('t1', 'T1 assembly, °C'), t2F = numField('t2', 'T2 operating, °C');
  const chips = PRESETS.map((T) => h('button', { type: 'button', class: 'te-chip', 'aria-pressed': 'false', title: `T2 = ${T} °C`,
    onclick: () => ctx.set('t2', String(T)) }, String(T)));
  const thermoHead = h('div', { class: 'te-head' }, h('span', { class: 'te-cap' }, 'Temperature'));
  const thermo = h('section', { class: 'te-card te-thermo' }, thermoHead, tSvg,
    h('div', { class: 'te-tfields' }, t1F, t2F), h('div', { class: 'te-chips' }, h('span', {}, 'T2'), chips));

  // ---------- stage ----------
  const matOptions = (withNone) => [...(withNone ? [['none', 'None']] : []), ...ORDER.map((k) => [k, MATS[k][0]]), ...(withNone ? [] : [['custom', 'Custom']])];
  const mkSelect = (key, label, withNone) => {
    const s = h('select', { 'aria-label': label, onchange: (e) => ctx.set(key, e.target.value) },
      matOptions(withNone).map(([v, t]) => h('option', { value: v }, t)));
    return s;
  };
  const partSel = mkSelect('material', 'Part material', false), mateSel = mkSelect('mate', 'Mating part or housing', true);
  const cteF = numField('cte', 'CTE ppm/K'), emodF = numField('emod', 'E GPa');
  const custom = h('span', { class: 'te-custom', hidden: true }, cteF, emodF);
  const stageSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'The part in its housing at T2, growth exaggerated' });
  const lenIn = h('input', { class: 'te-onfig', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Length or diameter at T1, mm',
    title: 'Length at T1, mm', oninput: (e) => ctx.set('length', e.target.value) });
  const gapIn = h('input', { class: 'te-onfig', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Clearance at T1, mm',
    title: 'Clearance to the housing at T1, mm', oninput: (e) => ctx.set('gap', e.target.value) });
  const foot = h('div', { class: 'te-foot' });
  const empty = h('div', { class: 'te-empty', hidden: true });
  const box = h('div', { class: 'te-box' }, stageSvg, lenIn, gapIn, foot, empty);
  const stage = h('section', { class: 'te-card te-stage' },
    h('div', { class: 'te-head' },
      h('label', { class: 'te-pick part' }, h('i'), 'Part', partSel), custom,
      h('label', { class: 'te-pick mate' }, h('i'), 'in', mateSel)),
    box);

  // ---------- ruler ----------
  const rSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'CTE ruler: the materials by expansion coefficient' });
  const segBtns = [['part', 'Part'], ['mate', 'Housing']].map(([v, t]) => h('button', { type: 'button', 'aria-pressed': 'false',
    onclick: () => { pickFor = v; drawRuler(); } }, t));
  const ruler = h('section', { class: 'te-card te-ruler' },
    h('div', { class: 'te-head' }, h('span', { class: 'te-cap' }, 'CTE, ppm/K (log scale) · click a material or drag a pointer'),
      h('span', { class: 'te-cap', style: 'margin:0' }, 'Click sets'), h('span', { class: 'te-seg' }, segBtns)),
    rSvg);

  // ---------- side ----------
  const read = h('div', { class: 'te-card te-read' });
  const warns = h('div', { class: 'te-warns', 'aria-live': 'polite' });
  const side = h('aside', { class: 'te-side' }, read, warns, ctx.outputs);

  root.append(h('div', { class: 'te' }, thermo, stage, ruler, side));

  // ---------- thermometer drawing ----------
  let tGeo = null;
  function drawThermo() {
    const svg = tSvg; svg.replaceChildren();
    const W = Math.max(180, svg.clientWidth || 220), H = Math.max(240, svg.clientHeight || 420);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!D) return;
    const [lo, hi] = D.range;
    const top = 14, bot = H - 34;
    const Y = (T) => bot - ((T - lo) / (hi - lo)) * (bot - top);
    const tx = 30, tw = 12;
    const px0 = 62, px1 = W - 10;
    tGeo = { Y, lo, hi, top, bot };
    // plot: gap (or ΔL) against T
    const hasGap = D.gap != null;
    const pts = D.sweep.map((s) => [s.T, hasGap ? s.g * 1000 : s.d1 * 1000, s.d2 != null ? s.d2 * 1000 : null]);
    const xs = pts.flatMap((p) => [p[1], ...(hasGap || p[2] == null ? [] : [p[2]])]).concat([0]);
    let xlo = Math.min(...xs), xhi = Math.max(...xs);
    const pad = (xhi - xlo) * 0.08 || 1; xlo -= pad; xhi += pad;
    const X = (v) => px0 + ((v - xlo) / (xhi - xlo)) * (px1 - px0);
    // grid
    for (let T = Math.ceil(lo / 20) * 20; T <= hi; T += 20) {
      sv(svg, 'line', { x1: tx + tw + 3, x2: px1, y1: Y(T), y2: Y(T), class: 'te-grid' });
      sv(svg, 'text', { x: tx - 4, y: Y(T) + 3.5, 'text-anchor': 'end', class: 'te-axis' }, String(T));
    }
    const step = niceStep(xhi - xlo, 3);
    for (let v = Math.ceil(xlo / step) * step; v <= xhi; v += step) {
      sv(svg, 'line', { x1: X(v), x2: X(v), y1: top, y2: bot, class: 'te-grid' });
      sv(svg, 'text', { x: X(v), y: bot + 13, 'text-anchor': 'middle', class: 'te-axis' }, g3(v, 3));
    }
    sv(svg, 'text', { x: px1, y: bot + 26, 'text-anchor': 'end', class: 'te-axis' }, hasGap ? 'clearance, µm' : 'ΔL, µm');
    if (hasGap) {
      if (Math.min(...pts.map((p) => p[1])) < 0) sv(svg, 'rect', { x: px0, y: top, width: Math.max(0, X(0) - px0), height: bot - top, class: 'te-closed' });
      sv(svg, 'line', { x1: X(0), x2: X(0), y1: top, y2: bot, class: 'te-zero' });
      if (xlo < 0 && X(0) - px0 > 26) sv(svg, 'text', { x: (px0 + X(0)) / 2, y: top + 12, 'text-anchor': 'middle', class: 'te-bad-t te-axis' }, 'jams');
    }
    const line = (i, cls) => sv(svg, 'path', { class: cls, d: pts.filter((p) => p[i] != null).map((p, k) => `${k ? 'L' : 'M'}${X(p[i]).toFixed(1)},${Y(p[0]).toFixed(1)}`).join(' ') });
    if (hasGap) line(1, 'te-curve');
    else { line(1, 'te-curve part'); if (D.mate) line(2, 'te-curve'); }
    if (hasGap && D.closeAt != null && D.closeAt > lo && D.closeAt < hi) {
      sv(svg, 'line', { x1: tx - 2, x2: px1, y1: Y(D.closeAt), y2: Y(D.closeAt), class: 'te-zero' });
      const up = Y(D.closeAt) > top + 16;
      sv(svg, 'text', { x: px1 - 2, y: Y(D.closeAt) + (up ? -4 : 12), 'text-anchor': 'end', class: 'te-bad-t te-axis' }, `closes at ${g3(D.closeAt, 3)} °C`);
    }
    // tube + liquid
    sv(svg, 'rect', { x: tx, y: top - 4, width: tw, height: bot - top + 8, rx: tw / 2, class: 'te-tube' });
    sv(svg, 'circle', { cx: tx + tw / 2, cy: bot + 12, r: 10, class: 'te-tube' });
    const liq = D.t2 >= D.t1 ? 'te-liq-hot' : 'te-liq-cold';
    sv(svg, 'rect', { x: tx + 3, y: Y(D.t2), width: tw - 6, height: Math.max(0, bot + 8 - Y(D.t2)), rx: 2, class: liq });
    sv(svg, 'circle', { cx: tx + tw / 2, cy: bot + 12, r: 7, class: liq });
    // T lines with their values on the plot, and the handles on the tube
    const marks = [['t1', D.t1, 'T1'], ['t2', D.t2, 'T2']];
    for (const [key, T, name] of marks) {
      const y = Y(T);
      sv(svg, 'line', { x1: tx + tw, x2: px1, y1: y, y2: y, class: 'te-tline', opacity: key === 't1' ? 0.55 : 1 });
      const g = sv(svg, 'g', { class: `te-h ${key}`, tabindex: 0, role: 'slider', 'data-h': key, 'aria-label': `${name}, °C`,
        'aria-valuenow': T, 'aria-valuemin': lo, 'aria-valuemax': hi });
      sv(g, 'rect', { x: 0, y: y - 9, width: tx + tw + 14, height: 18, fill: 'transparent' });
      sv(g, 'path', { d: `M${tx + tw + 1},${y} l9,-6 v12 z`, class: 'te-hring' });
      sv(g, 'text', { x: tx + tw + 13, y: y - 4, class: 'te-lbl-s' }, `${name} ${g3(T, 4)}°`);
    }
    // the value at T2 on the curve
    const y2 = Y(D.t2);
    const v2 = hasGap ? D.gap2 * 1000 : D.part.dL * 1000;
    sv(svg, 'circle', { cx: X(v2), cy: y2, r: 4.5, class: hasGap ? (D.gap2 < 0 ? 'te-bad-t' : 'te-ok-t') : 'te-part-t' });
    const right = X(v2) < (px0 + px1) / 2;
    sv(svg, 'text', { x: X(v2) + (right ? 8 : -8), y: y2 + 14, 'text-anchor': right ? 'start' : 'end',
      class: `te-lbl ${hasGap ? (D.gap2 < 0 ? 'te-bad-t' : '') : 'te-part-t'}` }, `${sgn(v2, 3)} µm`);
  }
  tSvg.addEventListener('pointerdown', (e) => {
    if (!tGeo || !D) return;
    const r = tSvg.getBoundingClientRect();
    const y = e.clientY - r.top;
    const d1 = Math.abs(y - tGeo.Y(D.t1)), d2 = Math.abs(y - tGeo.Y(D.t2));
    const key = d1 < 12 && d1 < d2 ? 't1' : 't2';
    const move = (ev) => {
      const yy = ev.clientY - r.top;
      const T = Math.round(clamp(tGeo.lo + ((tGeo.bot - yy) / (tGeo.bot - tGeo.top)) * (tGeo.hi - tGeo.lo), tGeo.lo, tGeo.hi));
      if (String(T) !== String(ctx.raw[key])) ctx.set(key, String(T));
    };
    capture(tSvg, e); e.preventDefault();
    move(e);
    const up = () => { tSvg.removeEventListener('pointermove', move); tSvg.removeEventListener('pointerup', up); tSvg.removeEventListener('pointercancel', up); };
    tSvg.addEventListener('pointermove', move); tSvg.addEventListener('pointerup', up); tSvg.addEventListener('pointercancel', up);
  });
  tSvg.addEventListener('keydown', (e) => {
    const key = e.target.closest?.('[data-h]')?.dataset.h;
    if (!key || !D) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (!d) return;
    e.preventDefault();
    ctx.set(key, String(Math.round(D[key] + d * (e.shiftKey ? 10 : 1))));
  });

  // ---------- stage drawing ----------
  let sGeo = null;
  function drawStage() {
    const svg = stageSvg; svg.replaceChildren();
    const W = Math.max(300, box.clientWidth || 700), H = Math.max(240, box.clientHeight || 420);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!D) { lenIn.hidden = gapIn.hidden = true; foot.textContent = ''; return; }
    const narrow = W < 560;
    const hasMate = !!D.mate, hasGap = D.gap != null;
    const wallT = narrow ? 16 : 26;
    const mL = narrow ? 10 : 34, mR = narrow ? 92 : 150;
    const x0 = mL + wallT;
    const avail = W - x0 - mR - wallT;
    const Lpx = avail * 0.74;
    const dL = D.part.dL, dL2 = hasMate ? D.mate.dL : 0, gap = hasGap ? D.gap : 0, gap2 = hasGap ? D.gap2 : 0;
    const hiC = Math.max(dL, hasMate ? gap + dL2 : 0, gap, 0), loC = Math.min(dL, 0, hasMate ? gap + dL2 : 0);
    const E = lockE ?? (avail * 0.22) / Math.max(hiC - loC, 1e-6);
    const XL = (c) => x0 + Lpx + (c - loC * 0) * E; // position of the T1 end + a change c (mm)
    const pEnd = XL(dL), gEnd = XL(gap), wEnd = XL(gap + dL2);
    const ph = clamp(H * 0.3, 46, 140);
    const cy = H * 0.5 + (narrow ? 10 : 18);
    const pTop = cy - ph / 2, pBot = cy + ph / 2;
    const baseT = narrow ? 14 : 20;
    sGeo = { E, Lpx, x0 };
    const defs = sv(svg, 'defs');
    const hatch = (id, bg, ln, gap_) => {
      const pt = sv(defs, 'pattern', { id, patternUnits: 'userSpaceOnUse', width: gap_, height: gap_, patternTransform: 'rotate(45)' });
      sv(pt, 'rect', { width: gap_, height: gap_, class: bg }); sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: gap_, class: ln });
    };
    hatch('te-hatch', 'te-hatch-bg', 'te-hatch-ln', 7); hatch('te-bad', 'te-bad-bg', 'te-bad-ln', 5);
    const arrow = (id, cls) => {
      const m = sv(defs, 'marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      sv(m, 'path', { d: 'M0,0 L10,5 L0,10 z', class: cls });
    };
    arrow('te-a-d', 'te-dimhead'); arrow('te-a-p', 'te-arrow-p'); arrow('te-a-m', 'te-arrow-m');
    const dimH = (x1, x2, y, cls = 'te-dim', m = 'te-a-d') => {
      if (Math.abs(x2 - x1) < 2) return;
      sv(svg, 'line', { x1, x2, y1: y, y2: y, class: cls, 'marker-start': `url(#${m})`, 'marker-end': `url(#${m})` });
    };
    // housing (drawn at T2: the left wall is the fixed datum, the right wall moved by the housing's growth)
    if (hasMate) {
      const wTop = pTop - (narrow ? 18 : 28);
      const outerR = wEnd + wallT;
      sv(svg, 'path', { class: 'te-mate', d: `M${mL},${wTop} H${x0} V${pBot} H${wEnd} V${wTop} H${outerR} V${pBot + baseT} H${mL} Z` });
      // the wall at T1, dashed
      if (Math.abs(gEnd - wEnd) > 1) sv(svg, 'rect', { x: gEnd, y: wTop, width: wallT, height: pBot + baseT - wTop, class: 'te-ghost' });
      sv(svg, 'text', { x: mL, y: pBot + baseT + 16, class: 'te-lbl-s te-mate-t' }, `${D.mate.name} · ${g3(D.mate.a)} ppm/K`);
      // housing growth, on the right of the wall
      if (hasGap) {
        const yA = pBot + baseT / 2;
        if (Math.abs(wEnd - gEnd) > 3) sv(svg, 'line', { x1: gEnd + wallT, x2: wEnd + wallT, y1: yA, y2: yA, class: 'te-grow mate', 'marker-end': 'url(#te-a-m)' });
        sv(svg, 'text', { x: outerR + 6, y: yA + 4, class: 'te-lbl te-mate-t' }, um(D.mate.dL));
      }
    } else {
      // a datum face only
      sv(svg, 'path', { class: 'te-mate', d: `M${mL},${pTop - 16} H${x0} V${pBot + 16} H${mL} Z` });
      sv(svg, 'text', { x: mL, y: pBot + 32, class: 'te-lbl-s' }, 'fixed end (datum)');
    }
    // part at T2, its T1 outline dashed
    sv(svg, 'rect', { x: x0, y: pTop, width: Math.max(2, pEnd - x0), height: ph, class: 'te-part' });
    sv(svg, 'rect', { x: x0, y: pTop, width: Lpx, height: ph, class: 'te-ghost' });
    // interference
    if (hasGap && gap2 < 0) {
      sv(svg, 'rect', { x: wEnd, y: pTop, width: Math.max(2, pEnd - wEnd), height: ph, class: 'te-inter' });
    }
    // part name + restrained stress on the part
    sv(svg, 'text', { x: x0 + 10, y: cy - 4, class: 'te-lbl-b te-part-t' }, `${D.part.name}`);
    if (!narrow) sv(svg, 'text', { x: x0 + 10, y: cy + 13, class: 'te-lbl-s' }, `α ${g3(D.part.a)} ppm/K · strain ${sgn(D.part.strain, 3)} ppm`);
    if (D.stress != null && D.part.sy != null && D.stress > D.part.sy) {
      sv(svg, 'text', { x: x0 + 10, y: cy + 29, class: 'te-lbl-s te-bad-t' }, `held rigid: ${g3(D.stress)} MPa > yield ${g3(D.part.sy)}`);
    }
    // growth arrow of the part
    const yG = pTop + ph * 0.22;
    if (Math.abs(pEnd - (x0 + Lpx)) > 3) sv(svg, 'line', { x1: x0 + Lpx, x2: pEnd, y1: yG, y2: yG, class: 'te-grow', 'marker-end': 'url(#te-a-p)' });
    // lever: the part end, drag it to heat or cool
    const lv = sv(svg, 'g', { class: 'te-lever', tabindex: 0, role: 'slider', 'data-h': 'lever',
      'aria-label': 'Part end: drag to change T2', 'aria-valuenow': D.t2 });
    sv(lv, 'rect', { x: pEnd - 9, y: pTop - 4, width: 18, height: ph + 8 });
    sv(lv, 'line', { x1: pEnd, x2: pEnd, y1: pTop - 6, y2: pBot + 6, class: 'te-leverline' });
    // labels of the part change, above the part end
    const lblY = pTop - (hasMate ? 40 : 14);
    const yT1 = lblY - 34;
    sv(svg, 'text', { x: pEnd, y: lblY, 'text-anchor': 'middle', class: 'te-lbl-b te-part-t' }, `ΔL ${um(dL)}`);
    sv(svg, 'text', { x: pEnd, y: lblY + 14, 'text-anchor': 'middle', class: 'te-lbl-s' }, `at ${g3(D.t2, 4)} °C, ${g3(D.part.Lt2, 7)} mm`);
    // L dimension (T1) under the part
    const yL = (hasMate ? pBot + baseT : pBot) + (narrow ? 34 : 40);
    sv(svg, 'line', { x1: x0, x2: x0, y1: pBot + 2, y2: yL + 6, class: 'te-dim', opacity: 0.6 });
    sv(svg, 'line', { x1: x0 + Lpx, x2: x0 + Lpx, y1: pBot + 2, y2: yL + 6, class: 'te-dim', opacity: 0.6 });
    dimH(x0, x0 + Lpx, yL);
    lenIn.hidden = false;
    lenIn.style.left = `${x0 + Lpx / 2}px`; lenIn.style.top = `${yL}px`;
    if (!narrow) sv(svg, 'text', { x: x0 + Lpx / 2 + 44, y: yL + 4, class: 'te-lbl-s' }, 'mm at T1');
    // the gap: at T1 above (editable), at T2 in the part's height
    if (hasGap) {
      const tone = gapTone(gap2);
      const yg = pTop + ph * 0.72;
      if (gap2 >= 0) dimH(pEnd, wEnd, yg, `te-gapdim ${tone}`);
      const gx = Math.max(pEnd, wEnd) + (narrow ? 4 : 8) + (hasMate ? wallT : 0);
      sv(svg, 'text', { x: gx, y: yg - 2, class: `te-lbl-b te-${tone}-t` }, `${gap2 < 0 ? '−' : ''}${g3(Math.abs(gap2), 3)} mm`);
      sv(svg, 'text', { x: gx, y: yg + 12, class: 'te-lbl-s' }, gap2 < 0 ? 'interference' : `gap at ${g3(D.t2, 4)} °C`);
      gapIn.hidden = false;
      const gxIn = clamp((x0 + Lpx + gEnd) / 2, x0 + 80, W - 50);
      gapIn.style.left = `${gxIn}px`; gapIn.style.top = `${yT1}px`;
      sv(svg, 'text', { x: gxIn - 44, y: yT1 + 4, 'text-anchor': 'end', class: 'te-lbl-s' }, 'gap at T1');
      sv(svg, 'line', { x1: x0 + Lpx, x2: x0 + Lpx, y1: yT1 + 10, y2: pTop, class: 'te-dim', opacity: 0.5, 'stroke-dasharray': '2 3' });
      sv(svg, 'line', { x1: gEnd, x2: gEnd, y1: yT1 + 10, y2: pTop, class: 'te-dim', opacity: 0.5, 'stroke-dasharray': '2 3' });
    } else {
      gapIn.hidden = !hasMate;
      if (hasMate) {
        gapIn.style.left = `${clamp(x0 + Lpx, x0 + 80, W - 50)}px`; gapIn.style.top = `${yT1}px`;
        sv(svg, 'text', { x: clamp(x0 + Lpx, x0 + 80, W - 50) - 44, y: yT1 + 4, 'text-anchor': 'end', class: 'te-lbl-s' }, 'gap at T1');
      }
    }
    foot.textContent = `Length to scale · changes drawn ×${g3(E / (Lpx / D.L), 2)} · dashed: at T1 ${g3(D.t1, 4)} °C · drag the part end to change T2`;
  }
  stageSvg.addEventListener('pointerdown', (e) => {
    const lv = e.target.closest?.('.te-lever');
    if (!lv || !D || !sGeo) return;
    const r = stageSvg.getBoundingClientRect();
    const k = D.part.a * 1e-6 * D.L; // mm per K of the part end
    if (!(Math.abs(k) > 0)) return;
    lockE = sGeo.E;
    const base = sGeo.x0 + sGeo.Lpx, E = sGeo.E, t1 = D.t1;
    capture(stageSvg, e); e.preventDefault();
    const move = (ev) => {
      const x = ev.clientX - r.left;
      const T = Math.round(clamp(t1 + (x - base) / (k * E), -273, 1000));
      if (String(T) !== String(ctx.raw.t2)) ctx.set('t2', String(T));
    };
    const up = () => {
      lockE = null; drawStage();
      stageSvg.removeEventListener('pointermove', move); stageSvg.removeEventListener('pointerup', up); stageSvg.removeEventListener('pointercancel', up);
    };
    stageSvg.addEventListener('pointermove', move); stageSvg.addEventListener('pointerup', up); stageSvg.addEventListener('pointercancel', up);
  });
  stageSvg.addEventListener('keydown', (e) => {
    if (!e.target.closest?.('.te-lever') || !D) return;
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    ctx.set('t2', String(Math.round(D.t2 + d * (e.shiftKey ? 10 : 1))));
  });

  // ---------- ruler drawing ----------
  let rGeo = null;
  function drawRuler() {
    segBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === (pickFor === 'part'))));
    const svg = rSvg; svg.replaceChildren();
    const W = Math.max(300, svg.clientWidth || 700);
    const narrow = W < 560;
    const Hh = narrow ? 180 : 166;
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`); svg.style.height = `${Hh}px`;
    const mL = 18, mR = 18, aLo = 1, aHi = 200;
    const X = (a) => mL + (Math.log(clamp(a, aLo, aHi) / aLo) / Math.log(aHi / aLo)) * (W - mL - mR);
    const A = (x) => aLo * Math.exp(((x - mL) / (W - mL - mR)) * Math.log(aHi / aLo));
    const yS = narrow ? 96 : 82;
    rGeo = { X, A };
    sv(svg, 'line', { x1: mL, x2: W - mR, y1: yS, y2: yS, class: 'te-scale' });
    for (const v of [1, 2, 5, 10, 20, 50, 100, 200]) {
      sv(svg, 'line', { x1: X(v), x2: X(v), y1: yS, y2: yS + 5, class: 'te-scale' });
      sv(svg, 'text', { x: X(v), y: yS + 15, 'text-anchor': 'middle', class: 'te-axis' }, String(v));
    }
    // labels spread so they do not overlap, with leaders to their true place
    const gapPx = narrow ? 12 : 16;
    const lab = ORDER.map((k) => ({ k, x: X(MATS[k][1]), lx: X(MATS[k][1]) }));
    for (let it = 0; it < 200; it++) {
      for (let i = 1; i < lab.length; i++) {
        const d = lab[i].lx - lab[i - 1].lx;
        if (d < gapPx) { const s = (gapPx - d) / 2; lab[i].lx += s; lab[i - 1].lx -= s; }
      }
    }
    const xMin = mL + 2, xMax = W - mR - 10;
    lab[0].lx = Math.max(lab[0].lx, xMin);
    for (let i = 1; i < lab.length; i++) lab[i].lx = Math.max(lab[i].lx, lab[i - 1].lx + gapPx);
    lab[lab.length - 1].lx = Math.min(lab[lab.length - 1].lx, xMax);
    for (let i = lab.length - 2; i >= 0; i--) lab[i].lx = Math.min(lab[i].lx, lab[i + 1].lx - gapPx);
    const partKey = D?.part?.key, mateKey = D?.mate?.key;
    for (const l of lab) {
      const g = sv(svg, 'g', { class: `te-mat${l.k === partKey ? ' is-part' : ''}${l.k === mateKey ? ' is-mate' : ''}`, 'data-k': l.k });
      sv(g, 'title', {}, `${MATS[l.k][0]} · ${MATS[l.k][1]} ppm/K`);
      sv(g, 'line', { x1: l.x, x2: l.x, y1: yS, y2: yS - 6 });
      sv(g, 'line', { x1: l.x, x2: l.lx, y1: yS - 6, y2: yS - 14 });
      sv(g, 'text', { x: l.lx + 3, y: yS - 17, transform: `rotate(${narrow ? -72 : -55} ${l.lx + 3} ${yS - 17})` }, SHORT[l.k]);
      sv(g, 'rect', { x: l.lx - 5, y: yS - 80, width: 12, height: 74, fill: 'transparent' });
    }
    if (!D) return;
    // pointers below the scale
    const ptr = (cls, a, lane, name) => {
      const x = X(a), y = yS + 22 + lane * 22;
      const g = sv(svg, 'g', { class: `te-ptr ${cls}`, tabindex: 0, role: 'slider', 'data-h': cls, 'aria-label': `${name} material by CTE`,
        'aria-valuenow': a, 'aria-valuetext': `${name} ${a} ppm/K` });
      sv(g, 'line', { x1: x, x2: x, y1: yS, y2: y - 6, class: 'te-scale' });
      sv(g, 'path', { d: `M${x},${y - 7} l7,9 h-14 z`, 'stroke-width': 1 });
      const right = x < W * 0.7;
      sv(g, 'text', { x: x + (right ? 10 : -10), y: y + 2, 'text-anchor': right ? 'start' : 'end', class: `te-lbl ${cls === 'part' ? 'te-part-t' : 'te-mate-t'}` },
        `${name} ${g3(a)}`);
      return x;
    };
    const xp = ptr('part', D.part.a, 0, 'Part');
    if (D.mate) {
      const xm = ptr('mate', D.mate.a, 1, 'Housing');
      const yb = yS + 60;
      if (Math.abs(xm - xp) > 4) {
        sv(svg, 'path', { d: `M${xp},${yb - 4} v4 H${xm} v-4`, class: 'te-brk' });
      }
      sv(svg, 'text', { x: (xp + xm) / 2, y: yb + 13, 'text-anchor': 'middle', class: 'te-lbl-s' }, `Δα ${sgn(D.dAlpha, 3)} ppm/K`);
    }
  }
  const nearestMat = (a) => ORDER.reduce((b, k) => (Math.abs(Math.log(MATS[k][1] / a)) < Math.abs(Math.log(MATS[b][1] / a)) ? k : b), ORDER[0]);
  rSvg.addEventListener('pointerdown', (e) => {
    if (!rGeo) return;
    const p = e.target.closest?.('.te-ptr');
    const m = e.target.closest?.('.te-mat');
    if (m && !p) { ctx.set(pickFor === 'part' ? 'material' : 'mate', m.dataset.k); return; }
    if (!p) return;
    const key = p.classList.contains('part') ? 'material' : 'mate';
    pickFor = key === 'material' ? 'part' : 'mate';
    const r = rSvg.getBoundingClientRect();
    capture(rSvg, e); e.preventDefault();
    const move = (ev) => {
      const k = nearestMat(rGeo.A(ev.clientX - r.left));
      if (k !== ctx.raw[key]) ctx.set(key, k);
    };
    const up = () => { rSvg.removeEventListener('pointermove', move); rSvg.removeEventListener('pointerup', up); rSvg.removeEventListener('pointercancel', up); };
    rSvg.addEventListener('pointermove', move); rSvg.addEventListener('pointerup', up); rSvg.addEventListener('pointercancel', up);
  });
  rSvg.addEventListener('keydown', (e) => {
    const p = e.target.closest?.('.te-ptr');
    if (!p || !D) return;
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const key = p.classList.contains('part') ? 'material' : 'mate';
    const cur = ctx.raw[key];
    const i = ORDER.indexOf(cur);
    const a = key === 'material' ? D.part.a : D.mate.a;
    const n = i >= 0 ? ORDER[clamp(i + d, 0, ORDER.length - 1)] : nearestMat(a * (d > 0 ? 1.05 : 0.95));
    ctx.set(key, n);
  });

  // ---------- side ----------
  function drawSide() {
    read.replaceChildren();
    if (!D) return;
    const hasGap = D.gap != null;
    if (hasGap) {
      const tone = gapTone(D.gap2);
      read.append(h('div', { class: 'te-cap' }, `Clearance at T2 = ${g3(D.t2, 4)} °C`),
        h('div', { class: `te-big ${tone}` }, `${D.gap2 < 0 ? '−' : ''}${g3(Math.abs(D.gap2), 3)}`, h('small', {}, 'mm')),
        h('div', { class: 'te-sub' }, D.gap2 < 0 ? `${g3(-D.gap2 * 1000)} µm interference, from ${g3(D.gap)} mm at ${g3(D.t1, 4)} °C`
          : `from ${g3(D.gap)} mm at ${g3(D.t1, 4)} °C${D.closeAt != null ? ` · closes at ${g3(D.closeAt, 3)} °C` : ' · never closes'}`));
    } else {
      read.append(h('div', { class: 'te-cap' }, `Length change, ${g3(D.t1, 4)} → ${g3(D.t2, 4)} °C`),
        h('div', { class: 'te-big' }, sgn(D.part.dL * 1000, 4), h('small', {}, 'µm')),
        h('div', { class: 'te-sub' }, `${g3(D.L, 5)} mm becomes ${g3(D.part.Lt2, 7)} mm`));
    }
    const row = (k, v, u) => [h('dt', {}, k), h('dd', {}, v, u ? h('small', {}, ` ${u}`) : null)];
    const dl = h('dl', { class: 'te-dl' },
      row('ΔT', sgn(D.dT, 4), 'K'),
      row(`ΔL ${SHORT[D.part.key] || 'part'}`, sgn(D.part.dL * 1000, 4), 'µm'),
      row('Length at T2', g3(D.part.Lt2, 7), 'mm'),
      row('Strain', sgn(D.part.strain, 4), 'ppm'),
      row('Area / volume', `${sgn(D.area, 3)} / ${sgn(D.volume, 3)}`, '%'),
      ...(D.mate ? [h('div', { class: 'sep' }),
        row(`ΔL ${SHORT[D.mate.key] || 'housing'}`, sgn(D.mate.dL * 1000, 4), 'µm'),
        row('Relative movement', g3(Math.abs(D.rel) * 1000, 4), 'µm'),
        row('CTE mismatch Δα', sgn(D.dAlpha, 3), 'ppm/K')] : []));
    read.append(dl);
    if (D.stress != null) {
      const sy = D.part.sy, s = D.stress;
      const max = Math.max(s, sy || 0) * 1.15 || 1;
      const svg = sv(null, 'svg', { viewBox: '0 0 280 40', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      sv(svg, 'rect', { x: 0, y: 6, width: 280, height: 10, rx: 2, class: 'te-sbar' });
      sv(svg, 'rect', { x: 0, y: 6, width: (280 * s) / max, height: 10, rx: 2,
        class: `te-sval${sy != null && s > sy ? ' over' : sy != null && s > 0.5 * sy ? ' half' : ''}` });
      if (sy != null) sv(svg, 'line', { x1: (280 * sy) / max, x2: (280 * sy) / max, y1: 2, y2: 20, class: 'te-sy' });
      read.append(h('div', { class: 'te-stress' },
        h('div', { class: 'te-cap' }, `Stress if held rigid: ${g3(s)} MPa${sy != null ? ` · yield ${g3(sy)} MPa` : ' · brittle, no yield'}`), svg));
    }
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', { class: /interference|past its|yield/.test(w) ? 'bad' : '' }, w)));
  }

  // ---------- sync ----------
  function sync() {
    const raw = ctx.raw;
    t1F.sync(raw.t1); t2F.sync(raw.t2); cteF.sync(raw.cte); emodF.sync(raw.emod);
    if (document.activeElement !== lenIn) lenIn.value = raw.length ?? '';
    if (document.activeElement !== gapIn) gapIn.value = raw.gap ?? '';
    partSel.value = raw.material; mateSel.value = raw.mate;
    custom.hidden = raw.material !== 'custom';
    chips.forEach((c) => c.setAttribute('aria-pressed', String(String(raw.t2).trim() === c.textContent)));
  }
  function drawAll() {
    const fk = document.activeElement?.dataset?.h;
    drawThermo(); drawStage(); drawRuler(); drawSide();
    empty.hidden = !!D;
    if (!D) empty.textContent = (res?.warnings || []).join(' ') || 'Give the length and both temperatures.';
    if (fk) root.querySelector(`[data-h="${fk}"]`)?.focus();
  }
  ctx.onResult((r) => { res = r; D = r?.draw || null; sync(); drawAll(); });
  let rt = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rt); rt = requestAnimationFrame(drawAll); }).observe(root);
}
