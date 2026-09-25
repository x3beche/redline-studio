// Assembly Order: the page is the product being built. Parts stand on the
// parts they go onto, level by level from the base up; scrub the steps and
// watch it go together, each new part arriving from its side with its tool.
// Under it, the sequence as a path through the approach directions (every
// jump is a turn-over) over a band of tools (every colour change is a tool
// change). Drag a step along the sequence to reorder the list; click a part
// to change where it comes from, its tool, time and what it sits on.
// Every drawn number and the order itself come from run()'s result.plan.

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
const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
const fmtTime = (sec) => {
  if (sec == null) return '';
  const s = Math.round(sec);
  if (s >= 3600) { const m = Math.round((s % 3600) / 60); return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ''}`; }
  if (s >= 60) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${s} s`;
};
const trunc = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);

// Directions: the rows of the sequence path, top to bottom.
const DIRS = ['top', 'front', 'back', 'left', 'right', 'side', 'inside', 'bottom'];
const SIDEWAYS = { front: 1, back: 1, left: 1, right: 1, side: 1, inside: 1 };
const NT = 8; // tool colours

const VKEY = 'redline.tool.assembly-order.view';
const loadView = () => { try { return { step: null, sel: null, ...(JSON.parse(localStorage.getItem(VKEY) || '{}')) }; } catch { return { step: null, sel: null }; } };
const saveView = (v) => { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* private window */ } };

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  const view = loadView();
  let res = null, plan = null;
  let toolIdx = new Map();
  let drag = null;

  // ---------- top ----------
  const stratSeg = h('div', { class: 'ao-seg', role: 'radiogroup', 'aria-label': 'Order by' });
  const STRATS = [['group', 'Fewest turn-overs and tool changes'], ['input', 'As listed where possible']];
  const sBtns = STRATS.map(([v, t], i) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set('strategy', v),
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
      e.preventDefault(); const n = STRATS[clamp(i + d, 0, 1)][0]; ctx.set('strategy', n);
      requestAnimationFrame(() => stratSeg.querySelector(`[data-v="${n}"]`)?.focus());
    } }, t));
  stratSeg.append(...sBtns);
  const stats = h('div', { class: 'ao-stats', 'aria-live': 'polite' });
  const top = h('div', { class: 'ao-top' }, h('span', { class: 'ao-cap' }, 'Order by'), stratSeg, stats);

  // ---------- stage: the build-up ----------
  const stageSvg = sv(null, 'svg', { class: 'ao-build', role: 'group', 'aria-label': 'The assembly, base at the bottom' });
  const stepCard = h('div', { class: 'ao-stepcard', 'aria-live': 'polite' });
  const prevB = h('button', { type: 'button', class: 'ao-btn', title: 'Previous step (←)', 'aria-label': 'Previous step', onclick: () => goStep(curStep() - 1) }, '◀');
  const nextB = h('button', { type: 'button', class: 'ao-btn', title: 'Next step (→)', 'aria-label': 'Next step', onclick: () => goStep(curStep() + 1) }, '▶');
  const range = h('input', { type: 'range', min: 1, max: 1, value: 1, class: 'ao-range', 'aria-label': 'Step', oninput: (e) => goStep(Number(e.target.value)) });
  const scrub = h('div', { class: 'ao-scrub' }, prevB, range, nextB, stepCard);
  const stage = h('section', { class: 'ao-stage' }, scrub, h('div', { class: 'ao-box' }, stageSvg));

  // ---------- sequence strip ----------
  const seqSvg = sv(null, 'svg', { class: 'ao-seq', role: 'listbox', tabindex: 0, 'aria-label': 'Build sequence: arrows move through the steps, Alt+arrows move a step earlier or later' });
  const seqWrap = h('div', { class: 'ao-seqwrap' }, seqSvg);
  const seq = h('section', { class: 'ao-seqbox' }, h('div', { class: 'ao-cardcap' }, 'Sequence',
    h('small', {}, 'the line jumps where the assembly is turned over; the band changes colour where the tool changes. Drag a step to move it (the list order then counts).')), seqWrap);

  // ---------- side: inspector ----------
  const insp = h('section', { class: 'ao-card ao-insp' });
  const warnBox = h('div', { class: 'ao-warns' });
  const details = h('details', { class: 'ao-src' }, h('summary', {}, 'Parts list as text'), ctx.form);
  const side = h('aside', { class: 'ao-side' }, insp, warnBox, ctx.outputs, details);

  root.append(h('div', { class: 'ao' }, top, h('div', { class: 'ao-main' }, h('div', { class: 'ao-left' }, stage, seq), side)));

  // ---------- state helpers ----------
  const N = () => plan?.steps.length || 0;
  const curStep = () => clamp(view.step == null ? N() : view.step, 1, Math.max(1, N()));
  function goStep(s) { view.step = clamp(s, 1, N()); view.sel = plan.steps[view.step - 1]?.key || view.sel; saveView(view); draw(); }
  const selPart = () => plan?.steps.find((p) => p.key === view.sel) || null;
  const toolCol = (tool) => (tool ? `var(--tool-k${toolIdx.get(norm(tool)) % NT})` : 'var(--line)');

  // ---------- text editing: the list stays the source ----------
  const lines = () => String(ctx.raw.text || '').split(/\r?\n/);
  function serialize(p) {
    const parts = [p.name + (p.onto.length ? ` -> ${p.onto.join(', ')}` : '')];
    if (p.tool) parts.push(`tool: ${p.tool}`);
    if (p.from) parts.push(`from: ${p.from}`);
    if (p.time != null) parts.push(`time: ${p.time % 60 === 0 && p.time >= 60 ? `${p.time / 60} min` : `${p.time}s`}`);
    if (p.blocks.length) parts.push(`blocks: ${p.blocks.join(', ')}`);
    for (const n of p.notes) parts.push(`note: ${n}`);
    return parts.join(' | ');
  }
  function editPart(key, patch) {
    const p = plan.steps.find((q) => q.key === key); if (!p) return;
    const np = { ...p, ...patch };
    const ls = lines();
    if (p.line && ls[p.line - 1] != null) ls[p.line - 1] = serialize(np);
    else ls.push(serialize(np));
    if (patch.name && norm(patch.name) !== key) {
      // keep the other parts pointing at it
      for (const q of plan.steps) {
        if (q.key === key || !q.ontoKeys.includes(key) || !q.line) continue;
        ls[q.line - 1] = serialize({ ...q, onto: q.onto.map((o) => (norm(o) === key ? patch.name : o)) });
      }
      view.sel = norm(patch.name); saveView(view);
    }
    ctx.set('text', ls.join('\n'));
  }
  function addPart(onto) {
    const ls = lines();
    let n = 1; while (plan.steps.some((p) => p.key === `new part ${n}`)) n++;
    ls.push(`new part ${n}${onto ? ` -> ${onto.name}` : ''}${onto?.from ? ` | from: ${onto.from}` : ''}`);
    view.sel = `new part ${n}`; view.step = null; saveView(view);
    ctx.set('text', ls.join('\n'));
  }
  function removePart(key) {
    const p = plan.steps.find((q) => q.key === key); if (!p) return;
    const ls = lines();
    for (const q of plan.steps) {
      if (q.key === key || !q.ontoKeys.includes(key) || !q.line) continue;
      ls[q.line - 1] = serialize({ ...q, onto: q.onto.filter((o) => norm(o) !== key) });
    }
    if (p.line) ls.splice(p.line - 1, 1);
    view.sel = null; saveView(view);
    ctx.set('text', ls.join('\n'));
  }
  // Write the part lines in a new order (other lines stay on top) and follow the list.
  function reorder(keys) {
    const ls = lines();
    const partLines = new Set(plan.steps.filter((p) => p.line).map((p) => p.line - 1));
    const head = ls.filter((l, i) => !partLines.has(i) && l.trim() !== '');
    const body = keys.map((k) => plan.steps.find((p) => p.key === k)).filter((p) => p?.line).map((p) => ls[p.line - 1]);
    ctx.setMany({ text: [...head, ...body].join('\n'), strategy: 'input' });
  }
  function moveStep(key, to) {
    const keys = plan.steps.map((p) => p.key);
    const i = keys.indexOf(key); if (i < 0) return;
    keys.splice(i, 1); keys.splice(clamp(to, 0, keys.length), 0, key);
    view.sel = key; view.step = null; saveView(view);
    reorder(keys);
  }

  // ---------- the build-up ----------
  function layoutBuild(W, H) {
    const steps = plan.steps, L = Math.max(1, plan.levels || 1);
    const narrow = W < 520;
    const mX = narrow ? 8 : 24, mT = 16, mB = 20;
    const rowH = Math.min(92, (H - mT - mB) / L);
    const bh = Math.max(20, Math.min(46, rowH - 22));
    const pos = new Map();
    const byLevel = Array.from({ length: L + 1 }, () => []);
    for (const p of steps) byLevel[clamp(p.level || 1, 1, L)].push(p);
    const maxRow = Math.max(...byLevel.map((r) => r.length));
    const bw = Math.min(narrow ? 110 : 170, (W - 2 * mX) / maxRow - (narrow ? 6 : 14));
    for (let l = 1; l <= L; l++) {
      const row = byLevel[l];
      const want = row.map((p) => {
        const xs = p.ontoKeys.map((k) => pos.get(k)?.cx).filter((x) => x != null);
        return { p, x: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null };
      });
      // evenly spread the free ones, then keep the order of wanted positions
      const n = row.length, gap = bw + (narrow ? 6 : 14);
      want.forEach((w, i) => { if (w.x == null) w.x = W / 2 + (i - (n - 1) / 2) * gap; });
      want.sort((a, b) => a.x - b.x || a.p.step - b.p.step);
      for (let i = 1; i < n; i++) want[i].x = Math.max(want[i].x, want[i - 1].x + gap);
      const over = Math.max(0, want[n - 1]?.x + bw / 2 - (W - mX));
      if (over) want.forEach((w) => { w.x -= over; });
      for (let i = n - 2; i >= 0; i--) want[i].x = Math.min(want[i].x, want[i + 1].x - gap);
      const under = Math.max(0, mX - (want[0]?.x - bw / 2));
      if (under) want.forEach((w) => { w.x += under; });
      const y = H - mB - (l - 1) * rowH - bh;
      for (const w of want) pos.set(w.p.key, { cx: w.x, x: w.x - bw / 2, y, w: bw, h: bh });
    }
    return { pos, bw, bh, rowH, narrow };
  }

  function arrowFor(g, b, dir, cls) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const len = 20;
    let d;
    if (dir === 'top') d = `M${cx},${b.y - len - 6} L${cx},${b.y - 4}`;
    else if (dir === 'bottom') d = `M${cx},${b.y + b.h + len + 6} L${cx},${b.y + b.h + 4}`;
    else if (dir === 'right' || dir === 'back') d = `M${b.x + b.w + len + 6},${cy} L${b.x + b.w + 4},${cy}`;
    else if (dir) d = `M${b.x - len - 6},${cy} L${b.x - 4},${cy}`;
    if (d) sv(g, 'path', { d, class: cls, 'marker-end': 'url(#ao-ar)' });
  }

  function drawBuild() {
    const svg = stageSvg; svg.replaceChildren();
    const W = Math.max(280, Math.round(svg.clientWidth) || 700), H = Math.max(240, Math.round(svg.clientHeight) || 420);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const defs = sv(svg, 'defs');
    const m = sv(defs, 'marker', { id: 'ao-ar', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(m, 'path', { d: 'M0,0 L10,5 L0,10 z', class: 'ao-arhead' });
    const { pos, rowH, narrow } = layoutBuild(W, H);
    const cur = curStep();
    const conflictOf = new Map(plan.conflicts.map((c) => [c.part, c]));
    // level guides
    for (let l = 1; l <= plan.levels; l++) {
      const y = H - 20 - (l - 1) * rowH;
      sv(svg, 'line', { x1: 0, x2: W, y1: y + 1, y2: y + 1, class: 'ao-levell' });
      sv(svg, 'text', { x: 4, y: y - 3, class: 'ao-levelt' }, `L${l}`);
    }
    // sits-on connections
    for (const p of plan.steps) {
      const a = pos.get(p.key); if (!a) continue;
      for (const k of p.ontoKeys) {
        const b = pos.get(k); if (!b) continue;
        const x1 = a.cx, y1 = a.y + a.h, x2 = b.cx, y2 = b.y;
        const my = (y1 + y2) / 2;
        sv(svg, 'path', { d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, class: `ao-link ${p.step > cur ? 'is-future' : ''} ${p.key === view.sel ? 'is-sel' : ''}` });
      }
    }
    // parts
    for (const p of plan.steps) {
      const b = pos.get(p.key); if (!b) continue;
      const state = p.step < cur ? 'done' : p.step === cur ? 'now' : 'future';
      const conf = conflictOf.get(p.key);
      const g = sv(svg, 'g', { class: `ao-part is-${state}${p.key === view.sel ? ' is-sel' : ''}${conf || p.cyclic ? ' is-bad' : ''}`, tabindex: 0, role: 'button', 'data-k': p.key,
        'aria-label': `Step ${p.step}: ${p.name}${p.from ? `, from the ${p.from}` : ''}${p.tool ? `, with ${p.tool}` : ''}` });
      sv(g, 'rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 4, class: 'ao-body' });
      if (p.blocks.length) {
        // a lid: thick edge on the side it closes
        const s = p.blocks[0];
        const e = s === 'bottom' ? `M${b.x + 2},${b.y + b.h} h${b.w - 4}` : SIDEWAYS[s] ? `M${b.x},${b.y + 2} v${b.h - 4}` : `M${b.x + 2},${b.y} h${b.w - 4}`;
        sv(g, 'path', { d: e, class: 'ao-lid' });
      }
      sv(g, 'rect', { x: b.x, y: b.y, width: 5, height: b.h, rx: 2, class: 'ao-toolbar', style: `fill: ${toolCol(p.tool)}` });
      sv(g, 'circle', { cx: b.x + 17, cy: b.y + 13, r: 9, class: 'ao-num' });
      sv(g, 'text', { x: b.x + 17, y: b.y + 16.5, class: 'ao-numt', 'text-anchor': 'middle' }, String(p.step));
      const maxc = Math.max(4, Math.floor((b.w - 34) / 6.6));
      sv(g, 'text', { x: b.x + 31, y: b.y + 17, class: 'ao-name' }, trunc(p.name, maxc));
      if (b.h >= 34) sv(g, 'text', { x: b.x + 10, y: b.y + b.h - 7, class: 'ao-sub' }, trunc([p.tool, p.time != null ? fmtTime(p.time) : ''].filter(Boolean).join(' · ') || (p.implicit ? 'not in the list' : 'by hand'), Math.floor((b.w - 14) / 5.8)));
      sv(g, 'title', {}, `${p.step}. ${p.name}${p.onto.length ? ` onto ${p.onto.join(', ')}` : ''}${p.from ? `, from the ${p.from}` : ''}${p.tool ? `, ${p.tool}` : ''}${p.blocks.length ? `; closes the ${p.blocks.join(', ')}` : ''}`);
      if (state === 'now') arrowFor(svg, b, p.from, 'ao-approach');
      if (conf) {
        const blk = plan.steps.find((q) => q.key === conf.blocker);
        sv(svg, 'text', { x: b.cx, y: b.y - 5, class: 'ao-badt', 'text-anchor': 'middle' }, narrow ? `${conf.side} closed` : `${conf.side} closed by ${blk?.name} (step ${blk?.step})`);
      }
    }
    // current step caption near the part
    const now = plan.steps[cur - 1];
    const b = now && pos.get(now.key);
    if (b && now.from) {
      const lab = `from the ${now.from}${now.tool ? ` · ${now.tool}` : ''}`;
      const vert = now.from === 'top' || now.from === 'bottom', leftHalf = b.cx < W / 2;
      const fromRight = now.from === 'right' || now.from === 'back';
      const tx = vert ? (leftHalf ? b.cx + 8 : b.cx - 8) : fromRight ? b.x + b.w + 4 : b.x - 4;
      const ty = now.from === 'top' ? b.y - 16 : now.from === 'bottom' ? b.y + b.h + 20 : b.y - 6;
      sv(svg, 'text', { x: tx, y: ty, class: 'ao-apt', 'text-anchor': vert ? (leftHalf ? 'start' : 'end') : fromRight ? 'start' : 'end' }, lab);
    }
  }

  // ---------- sequence strip ----------
  function drawSeq() {
    const svg = seqSvg; svg.replaceChildren();
    const steps = plan.steps, n = steps.length;
    const used = DIRS.filter((d) => steps.some((p) => p.from === d));
    const other = steps.some((p) => p.from && !DIRS.includes(p.from));
    const rows = [...used, ...(other ? ['other'] : []), ...(steps.some((p) => !p.from) ? ['any'] : [])];
    const rowOf = (p) => (p.from ? (DIRS.includes(p.from) ? p.from : 'other') : 'any');
    const avail = Math.max(280, seqWrap.clientWidth || 800);
    const LW = 58, colW = Math.max(avail < 520 ? 46 : 64, (avail - LW - 8) / Math.max(1, n));
    const W = LW + colW * n + 8;
    const rH = 18, T = 20, bandY = T + rows.length * rH + 8, bandH = 12, H = bandY + bandH + 30;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.__g = { LW, colW, n };
    const cx = (i) => LW + colW * i + colW / 2;
    const cur = curStep();
    rows.forEach((r, i) => {
      const y = T + i * rH + rH / 2;
      sv(svg, 'line', { x1: LW, x2: W - 8, y1: y, y2: y, class: 'ao-srow' });
      sv(svg, 'text', { x: LW - 6, y: y + 3.5, class: 'ao-srowt', 'text-anchor': 'end' }, r === 'any' ? 'any way' : r);
    });
    sv(svg, 'text', { x: LW - 6, y: bandY + 10, class: 'ao-srowt', 'text-anchor': 'end' }, 'tool');
    // columns
    steps.forEach((p, i) => {
      const x = LW + colW * i;
      const g = sv(svg, 'g', { class: `ao-col${p.step === cur ? ' is-cur' : ''}${p.key === view.sel ? ' is-sel' : ''}${drag?.key === p.key ? ' is-drag' : ''}`, 'data-k': p.key, 'data-i': i });
      sv(g, 'rect', { x: x + 1, y: 0, width: colW - 2, height: H, rx: 3, class: 'ao-colbg' });
      sv(g, 'text', { x: cx(i), y: 12, class: 'ao-colnum', 'text-anchor': 'middle' }, String(p.step));
      sv(g, 'text', { x: cx(i), y: H - 6, class: 'ao-colname', 'text-anchor': 'middle' }, trunc(p.name, Math.floor((colW - 4) / 5.6)));
      sv(g, 'rect', { x: x + 1, y: bandY, width: colW - 2, height: bandH, rx: 2, class: 'ao-tband', style: `fill: ${toolCol(p.tool)}${p.tool ? '' : '; opacity: .35'}` });
      if (p.tool) { const t = sv(g, 'title'); t.textContent = `${p.step}. ${p.name}: ${p.tool}`; }
    });
    // path through the directions
    let prev = null, lastTool = null;
    const pts = [];
    steps.forEach((p, i) => {
      const ri = rows.indexOf(rowOf(p));
      const y = T + ri * rH + rH / 2;
      pts.push([cx(i), y, p]);
    });
    sv(svg, 'path', { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(''), class: 'ao-spath' });
    pts.forEach(([x, y, p], i) => {
      sv(svg, 'circle', { cx: x, cy: y, r: p.step === cur ? 5.5 : 4, class: `ao-sdot${p.step <= cur ? ' is-done' : ''}` });
      if (p.from) {
        if (prev && prev !== p.from) {
          const [px, py] = pts[i - 1];
          sv(svg, 'text', { x: (px + x) / 2, y: Math.min(py, y) - 3 + (Math.abs(py - y) < 1 ? 0 : 0), class: 'ao-turn', 'text-anchor': 'middle' }, '⟲');
        }
        prev = p.from;
      }
      if (p.tool) {
        if (lastTool && norm(lastTool) !== norm(p.tool)) sv(svg, 'path', { d: `M${LW + colW * i},${bandY - 4} v${bandH + 8}`, class: 'ao-tchange' });
        lastTool = p.tool;
      }
    });
    if (drag?.to != null) {
      const x = LW + colW * drag.to;
      sv(svg, 'line', { x1: x, x2: x, y1: 0, y2: H, class: 'ao-insert' });
    }
  }

  // ---------- inspector ----------
  function drawInspector() {
    const p = selPart() || plan.steps[curStep() - 1];
    if (!p) { insp.replaceChildren(h('div', { class: 'ao-none' }, 'Click a part.')); return; }
    const focused = insp.contains(document.activeElement) ? document.activeElement.dataset.f : null;
    const field = (f, label, value, onch, attrs = {}) => h('label', { class: 'ao-f' }, h('span', {}, label),
      h('input', { type: 'text', spellcheck: 'false', value: value ?? '', 'data-f': f, ...attrs,
        onchange: (e) => onch(e.target.value.trim()), onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }));
    // approach picker: a cube in section, six faces
    const face = (d, label, cls) => h('button', { type: 'button', class: `ao-face ${cls}`, 'aria-pressed': String(p.from === d), 'data-f': `from-${d}`,
      title: d === 'side' ? 'from the side (any)' : `from the ${d}`, onclick: () => editPart(p.key, { from: p.from === d ? null : d }) }, label);
    const cube = h('div', { class: 'ao-cube', role: 'group', 'aria-label': 'Approach direction' },
      face('top', 'top', 'f-top'), face('back', 'back', 'f-back'), face('left', 'left', 'f-left'), h('div', { class: 'ao-cubec' }, p.from ? `from ${p.from}` : 'any way'),
      face('right', 'right', 'f-right'), face('front', 'front', 'f-front'), face('bottom', 'bottom', 'f-bottom'), face('side', 'side', 'f-side'));
    const others = plan.steps.filter((q) => q.key !== p.key);
    const onto = h('div', { class: 'ao-onto', role: 'group', 'aria-label': 'Goes onto' }, others.map((q) => {
      const on = p.ontoKeys.includes(q.key);
      return h('button', { type: 'button', class: 'ao-chip', 'aria-pressed': String(on), 'data-f': `onto-${q.key}`,
        onclick: () => editPart(p.key, { onto: on ? p.onto.filter((o) => norm(o) !== q.key) : [...p.onto, q.name] }) }, h('b', {}, String(q.step)), q.name);
    }));
    const blocksOn = p.blocks.length > 0;
    const conflicts = plan.conflicts.filter((c) => c.part === p.key || c.blocker === p.key);
    const tools = plan.tools || [];
    const dl = h('datalist', { id: 'ao-tools' }, tools.map((t) => h('option', { value: t })));
    insp.replaceChildren(...[
      h('div', { class: 'ao-ihead' }, h('span', { class: 'ao-inum' }, String(p.step)), h('b', {}, p.name), h('span', { class: 'ao-ilev' }, `level ${p.level}`),
        h('button', { type: 'button', class: 'ao-btn ao-del', title: 'Remove this part', 'data-f': 'del', onclick: () => removePart(p.key) }, 'Remove')),
      h('div', { class: 'ao-igrid' },
        h('div', { class: 'ao-icol' },
          field('name', 'Part', p.name, (v) => v && editPart(p.key, { name: v })),
          field('tool', 'Tool', p.tool, (v) => editPart(p.key, { tool: v || null }), { list: 'ao-tools', placeholder: 'by hand' }), dl,
          field('time', 'Time', p.time != null ? fmtTime(p.time) : '', (v) => {
            const m = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h)?/i.exec(v); editPart(p.key, { time: m ? Number(m[1]) * ((m[2] || 's')[0].toLowerCase() === 'h' ? 3600 : (m[2] || 's')[0].toLowerCase() === 'm' ? 60 : 1) : null });
          }, { placeholder: '30 s' }),
          h('button', { type: 'button', class: 'ao-toggle', 'aria-pressed': String(blocksOn), 'data-f': 'blocks',
            title: 'A lid or cover: it waits until the parts behind it are in',
            onclick: () => editPart(p.key, { blocks: blocksOn ? [] : [p.from || 'top'] }) }, blocksOn ? `Closes the ${p.blocks.join(', ')}` : 'Closes a side')),
        h('div', { class: 'ao-icol' }, h('span', { class: 'ao-flab' }, 'Comes in from'), cube)),
      h('div', { class: 'ao-flab' }, 'Goes onto'), onto,
      conflicts.length ? h('div', { class: 'ao-iwarn' }, conflicts.map((c) => {
        const a = plan.steps.find((q) => q.key === c.part), b = plan.steps.find((q) => q.key === c.blocker);
        return h('div', {}, `${a.name} needs the ${c.side}, closed by ${b.name} at step ${b.step}.`);
      })) : null,
      h('div', { class: 'ao-iact' }, h('button', { type: 'button', class: 'ao-btn', 'data-f': 'add', onclick: () => addPart(p) }, `+ Part onto ${trunc(p.name, 18)}`),
        h('button', { type: 'button', class: 'ao-btn', 'data-f': 'addbase', onclick: () => addPart(null) }, '+ Base part'))].filter(Boolean));
    if (focused) insp.querySelector(`[data-f="${CSS.escape(focused)}"]`)?.focus();
  }

  function drawTop() {
    for (const b of sBtns) { const on = b.dataset.v === ctx.raw.strategy; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    const v = (label) => res.values?.find((x) => x.label === label);
    const it = (label, value, tone, hint) => h('div', { class: `ao-si ${tone ? `is-${tone}` : ''}`, title: hint || null }, h('span', {}, label), h('b', {}, value));
    stats.replaceChildren(
      it('Steps', String(plan.steps.length)),
      it('Turn-overs', String(plan.reorientations), v('Reorientations')?.tone, 'approach direction changes'),
      it('Tool changes', `${plan.toolChanges}`, v('Tool changes')?.tone, `${plan.tools.length} tools`),
      it('Levels', String(plan.levels), null, 'longest chain of parts'),
      it('Time', plan.totalTime != null ? fmtTime(plan.totalTime) : '–', null, `${plan.timedSteps} of ${plan.steps.length} steps timed`),
      it('Access conflicts', String(plan.conflicts.length), plan.conflicts.length ? 'bad' : 'ok'));
  }

  function drawStepCard() {
    const cur = curStep(), p = plan.steps[cur - 1];
    range.max = String(Math.max(1, N())); range.value = String(cur);
    prevB.disabled = cur <= 1; nextB.disabled = cur >= N();
    if (!p) { stepCard.replaceChildren(); return; }
    const text = res.texts?.find((t) => t.title === 'Steps')?.body.split('\n')[cur - 1] || '';
    stepCard.replaceChildren(h('span', { class: 'ao-sc-n' }, `Step ${cur} of ${N()}`), h('span', { class: 'ao-sc-t' }, text.replace(/^\d+\.\s*/, '')));
  }

  function draw() {
    if (!res) return;
    if (!plan) {
      stats.replaceChildren(); stageSvg.replaceChildren(); seqSvg.replaceChildren(); insp.replaceChildren(); stepCard.replaceChildren();
      warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', { class: 'ao-warn' }, w)));
      return;
    }
    const tools = [...new Set(plan.steps.filter((p) => p.tool).map((p) => norm(p.tool)))];
    toolIdx = new Map(tools.map((t, i) => [t, i]));
    if (view.sel && !plan.steps.some((p) => p.key === view.sel)) view.sel = null;
    drawTop(); drawStepCard(); drawBuild(); drawSeq(); drawInspector();
    warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', { class: 'ao-warn' }, w)));
  }

  // ---------- interaction ----------
  stageSvg.addEventListener('click', (e) => {
    const g = e.target.closest?.('[data-k]'); if (!g) return;
    view.sel = g.dataset.k; saveView(view); draw();
  });
  stageSvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-k]'); if (!g) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); view.sel = g.dataset.k; const p = plan.steps.find((q) => q.key === view.sel);
      if (p) view.step = p.step; saveView(view); draw(); stageSvg.querySelector(`[data-k="${CSS.escape(view.sel)}"]`)?.focus();
    }
  });
  const colAt = (e) => {
    const r = seqSvg.getBoundingClientRect(), g = seqSvg.__g;
    return clamp(Math.floor((e.clientX - r.left - g.LW) / g.colW), 0, g.n - 1);
  };
  seqSvg.addEventListener('pointerdown', (e) => {
    const col = e.target.closest?.('[data-k]'); if (!col || !plan) return;
    e.preventDefault();
    drag = { key: col.dataset.k, from: Number(col.dataset.i), to: null, x0: e.clientX, moved: false };
    capture(seqSvg, e); seqSvg.focus();
  });
  seqSvg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) > 6) drag.moved = true;
    if (!drag.moved) return;
    const r = seqSvg.getBoundingClientRect(), g = seqSvg.__g;
    drag.to = clamp(Math.round((e.clientX - r.left - g.LW) / g.colW), 0, g.n);
    drawSeq();
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved && d.to != null) {
      const to = d.to > d.from ? d.to - 1 : d.to;
      if (to !== d.from) { moveStep(d.key, to); return; }
      drawSeq();
    } else {
      const i = colAt(e);
      view.step = i + 1; view.sel = plan.steps[i].key; saveView(view); draw();
    }
  };
  seqSvg.addEventListener('pointerup', endDrag);
  seqSvg.addEventListener('pointercancel', () => { drag = null; drawSeq(); });
  seqSvg.addEventListener('keydown', (e) => {
    if (!plan) return;
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) { if (e.key === 'Home') goStep(1); if (e.key === 'End') goStep(N()); return; }
    e.preventDefault();
    const cur = curStep();
    if (e.altKey) { const p = plan.steps[cur - 1]; if (p) moveStep(p.key, cur - 1 + d); }
    else goStep(cur + d);
  });
  stage.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input')) return;
    if (e.key === 'ArrowRight' && !e.target.closest?.('[data-k]')) { e.preventDefault(); goStep(curStep() + 1); }
    if (e.key === 'ArrowLeft' && !e.target.closest?.('[data-k]')) { e.preventDefault(); goStep(curStep() - 1); }
  });

  ctx.onResult((r) => {
    res = r; plan = r.plan || null;
    if (plan && view.step != null && view.step > plan.steps.length) view.step = null;
    for (const b of sBtns) { const on = b.dataset.v === ctx.raw.strategy; b.setAttribute('aria-checked', String(on)); }
    draw();
  });
  let rz = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (plan) { drawBuild(); drawSeq(); } }); }).observe(root);
}
