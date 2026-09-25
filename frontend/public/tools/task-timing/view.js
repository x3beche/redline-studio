// Task Timing: the page is the CPU's schedule. One lane per task: above, the
// job each release asks for (a ghost of its duration at its release); below,
// what the scheduler actually ran. Drag the first ghost to move the offset,
// its right edge to change the duration, any later release tick to change the
// period. The CPU lane on top shows who has the processor; missed deadlines
// are red marks where they happen. Every drawn number comes from run()'s
// result (result.timeline and result.schedule).

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
const fmt = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(4))));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const niceStep = (span, n) => {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};
// Periods snap to preferred numbers so the hyperperiod stays short.
const PREF = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const prefValues = (() => { const out = []; for (let e = -2; e <= 4; e++) for (const m of PREF) out.push(Number((m * 10 ** e).toPrecision(4))); return out; })();
const snapPeriod = (v) => prefValues.reduce((a, b) => (Math.abs(Math.log(b / v)) < Math.abs(Math.log(a / v)) ? b : a));
const stepPeriod = (v, d) => {
  const i = prefValues.indexOf(snapPeriod(v));
  return prefValues[clamp(i + d, 0, prefValues.length - 1)];
};
const snapTo = (v, st) => Number((Math.round(v / st) * st).toPrecision(6));
const NCOL = 8;

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let res = null;
  let drag = null;         // active drag
  let hover = null;        // {victim, culprit} highlighted by the blame list
  let lanes = [];          // per input row: DOM and state

  // ---------- top: scheduler, summary, window ----------
  const modeSeg = h('div', { class: 'tt-seg', role: 'radiogroup', 'aria-label': 'Scheduler' });
  const MODES = [['coop', 'Cooperative', 'Run to completion: super loop or time-triggered'], ['preempt', 'Preemptive', 'Fixed-priority RTOS: a higher priority interrupts']];
  const modeBtns = MODES.map(([v, t, title], i) => h('button', { type: 'button', role: 'radio', 'data-v': v, title,
    onclick: () => ctx.set('mode', v),
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
      e.preventDefault(); const n = MODES[clamp(i + d, 0, 1)][0]; ctx.set('mode', n);
      requestAnimationFrame(() => modeSeg.querySelector(`[data-v="${n}"]`)?.focus());
    } }, t));
  modeSeg.append(...modeBtns);
  const summary = h('div', { class: 'tt-sum', 'aria-live': 'polite' });
  const winInput = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', placeholder: 'auto', 'aria-label': 'Drawing window in ms',
    oninput: (e) => ctx.set('window', e.target.value) });
  const zoom = (f) => {
    const cur = res?.timeline?.window; if (!cur) return;
    const H = res.schedule?.hyperperiod || res.schedule?.simulated || cur;
    ctx.set('window', String(Number(clamp(cur * f, 0.01, H).toPrecision(3))));
  };
  const winBox = h('div', { class: 'tt-win' },
    h('span', { class: 'tt-cap' }, 'Show'), winInput, h('small', {}, 'ms'),
    h('button', { type: 'button', class: 'tt-btn', title: 'Zoom in (half the window)', onclick: () => zoom(0.5) }, '−'),
    h('button', { type: 'button', class: 'tt-btn', title: 'Zoom out (double the window)', onclick: () => zoom(2) }, '+'),
    h('button', { type: 'button', class: 'tt-btn', title: 'The whole hyperperiod', onclick: () => {
      const H = res?.schedule?.hyperperiod || res?.schedule?.simulated; if (H) ctx.set('window', String(H));
    } }, 'Hyperperiod'),
    h('button', { type: 'button', class: 'tt-btn', title: 'Two periods of the slowest task', onclick: () => ctx.set('window', '') }, 'Auto'));
  const top = h('div', { class: 'tt-top' }, h('div', { class: 'tt-group' }, h('span', { class: 'tt-cap' }, 'Scheduler'), modeSeg), summary, winBox);

  // ---------- board ----------
  const axisSvg = sv(null, 'svg', { class: 'tt-svg', height: 26, 'aria-hidden': 'true' });
  const cpuSvg = sv(null, 'svg', { class: 'tt-svg', height: 34, role: 'img', 'aria-label': 'Which task has the CPU' });
  const cpuHead = h('div', { class: 'tt-head tt-cpuhead' });
  const cpuStats = h('div', { class: 'tt-stats' });
  const lanesBox = h('div', { class: 'tt-lanes' });
  const addBtn = h('button', { type: 'button', class: 'tt-btn', onclick: () => {
    const rows = ctx.raw.tasks.map((r) => ({ ...r }));
    rows.push({ name: `Task ${rows.length + 1}`, period: '20', dur: '1', offset: '0', prio: '', deadline: '' });
    ctx.set('tasks', rows);
  } }, '+ Add task');
  const rmBtn = h('button', { type: 'button', class: 'tt-btn', title: 'Clear every priority: shorter period runs first', onclick: () => {
    ctx.set('tasks', ctx.raw.tasks.map((r) => ({ ...r, prio: '' })));
  } }, 'Rate-monotonic priorities');
  const board = h('section', { class: 'tt-board', 'aria-label': 'Schedule' },
    h('div', { class: 'tt-row tt-axisrow' }, h('div', { class: 'tt-head tt-colcap' }, 'Task · T period, C duration, offset, D deadline (ms)', h('span', { class: 'tt-legend' }, h('i', { class: 'tt-lg-ghost' }), 'released', h('i', { class: 'tt-lg-run' }), 'ran', h('i', { class: 'tt-lg-miss' }), 'late')), axisSvg, h('div', { class: 'tt-stats tt-colcap' }, 'Worst response against deadline')),
    h('div', { class: 'tt-row' }, cpuHead, cpuSvg, cpuStats),
    lanesBox,
    h('div', { class: 'tt-foot' }, addBtn, rmBtn,
      h('span', { class: 'tt-hint' }, 'Drag the outlined job to move its offset, its edge for the duration, a release tick ', h('b', {}, '|'), ' for the period. Focus a job: ← → offset, Shift+← → duration, ↑ ↓ period.')));

  // ---------- bottom ----------
  const blameBox = h('div', { class: 'tt-blame' });
  const adviceBox = h('div', { class: 'tt-advice' });
  const details = h('details', { class: 'tt-all' }, h('summary', {}, 'All inputs as a table (priorities, deadlines)'), ctx.form);
  const bottom = h('div', { class: 'tt-bottom' },
    h('section', { class: 'tt-card' }, h('div', { class: 'tt-cardcap' }, 'Who holds whom up', h('small', {}, 'per hyperperiod · hover to see it in the lanes')), blameBox),
    h('section', { class: 'tt-card' }, h('div', { class: 'tt-cardcap' }, 'What to change'), adviceBox, details),
    h('div', { class: 'tt-outs' }, ctx.outputs));
  root.append(h('div', { class: 'tt' }, top, board, bottom));

  // ---------- helpers ----------
  const rowsNow = () => (ctx.raw.tasks || []).map((r) => ({ ...r }));
  const setRow = (i, patch, extra) => {
    const rows = rowsNow(); rows[i] = { ...rows[i], ...patch };
    if (extra) ctx.setMany({ tasks: rows, ...extra }); else ctx.set('tasks', rows);
  };
  const taskFor = (row) => res?.schedule?.tasks?.find((t) => t.row === row) || null;
  const laneIdx = (row) => res?.schedule?.tasks?.findIndex((t) => t.row === row) ?? -1;
  const winMs = () => res?.timeline?.window || 1;
  const stepFine = () => Math.max(0.001, niceStep(winMs(), 400));

  function movePrio(row, d) {
    const ts = res?.schedule?.tasks; if (!ts) return;
    const order = [...ts].sort((a, b) => a.order - b.order).map((t) => t.row);
    const i = order.indexOf(row), j = clamp(i + d, 0, order.length - 1);
    if (i < 0 || i === j) return;
    [order[i], order[j]] = [order[j], order[i]];
    const rows = rowsNow();
    order.forEach((r, k) => { rows[r].prio = String(k); });
    ctx.set('tasks', rows);
  }

  // ---------- lanes (DOM kept per row, so typing keeps focus) ----------
  function buildLanes() {
    const rows = ctx.raw.tasks || [];
    lanesBox.replaceChildren();
    lanes = rows.map((r, i) => {
      const field = (key, label, title) => {
        const inp = h('input', { type: 'text', inputmode: key === 'name' ? null : 'decimal', spellcheck: 'false', 'aria-label': `${title} of task ${i + 1}`,
          class: key === 'name' ? 'tt-name' : null,
          oninput: (e) => setRow(i, { [key]: e.target.value }) });
        return key === 'name' ? inp : h('label', { class: 'tt-f', title }, h('span', {}, label), inp);
      };
      const inputs = { name: field('name', '', 'Name'), period: field('period', 'T', 'Period, ms'), dur: field('dur', 'C', 'Duration (worst case), ms'),
        offset: field('offset', 'off', 'Offset, ms'), deadline: field('deadline', 'D', 'Deadline, ms (blank = period)') };
      const inp = (k) => (k === 'name' ? inputs.name : inputs[k].querySelector('input'));
      const badge = h('span', { class: 'tt-prio' });
      const up = h('button', { type: 'button', class: 'tt-mini', title: 'Raise priority', 'aria-label': `Raise priority of task ${i + 1}`, onclick: () => movePrio(i, -1) }, '▲');
      const dn = h('button', { type: 'button', class: 'tt-mini', title: 'Lower priority', 'aria-label': `Lower priority of task ${i + 1}`, onclick: () => movePrio(i, 1) }, '▼');
      const del = h('button', { type: 'button', class: 'tt-mini tt-del', title: 'Remove task', 'aria-label': `Remove task ${i + 1}`, onclick: () => {
        const rows2 = rowsNow(); rows2.splice(i, 1); ctx.set('tasks', rows2);
      } }, '×');
      const head = h('div', { class: 'tt-head' },
        h('div', { class: 'tt-line1' }, h('i', { class: 'tt-sw' }), inputs.name, badge, up, dn, del),
        h('div', { class: 'tt-line2' }, inputs.period, inputs.dur, inputs.offset, inputs.deadline));
      const svg = sv(null, 'svg', { class: 'tt-svg tt-lanesvg', height: 58, role: 'group', 'aria-label': `Timeline of task ${i + 1}` });
      const stats = h('div', { class: 'tt-stats' });
      const el = h('div', { class: 'tt-row tt-lane', style: `--c: var(--tool-t${i % NCOL})` }, head, svg, stats);
      lanesBox.append(el);
      const L = { i, el, inp, badge, svg, stats, head };
      attachDrag(L);
      return L;
    });
  }

  function syncLane(L) {
    const r = (ctx.raw.tasks || [])[L.i] || {};
    for (const k of ['name', 'period', 'dur', 'offset', 'deadline']) {
      const e = L.inp(k); if (document.activeElement !== e) e.value = r[k] ?? '';
    }
    const t = taskFor(L.i);
    L.el.classList.toggle('tt-bad', !t);
    L.el.classList.toggle('tt-miss', !!t?.missed);
    L.inp('deadline').placeholder = t ? fmt(t.period) : '';
    L.badge.textContent = t ? `P${t.order}${t.prio == null ? ' RM' : ''}` : '–';
    L.badge.title = t ? (t.prio == null ? `Priority by period (rate monotonic), rank ${t.order}; 0 runs first` : `Priority ${t.prio}; rank ${t.order}, 0 runs first`) : '';
  }

  // ---------- drawing ----------
  const layout = (svg) => {
    const W = Math.max(120, Math.round(svg.getBoundingClientRect().width) || 600);
    return { W, pad: 6, X: (t) => 6 + (t / winMs()) * (W - 12), T: (x) => ((x - 6) / (W - 12)) * winMs() };
  };

  function drawAxis() {
    const svg = axisSvg; svg.replaceChildren();
    const { W, X } = layout(svg); svg.setAttribute('viewBox', `0 0 ${W} 26`);
    const win = winMs(), st = niceStep(win, Math.max(3, Math.floor(W / 80)));
    for (let t = 0; t <= win + 1e-9; t += st) {
      const x = X(t);
      sv(svg, 'line', { x1: x, x2: x, y1: 18, y2: 26, class: 'tt-tick' });
      sv(svg, 'text', { x, y: 13, class: 'tt-axt', 'text-anchor': t === 0 ? 'start' : t + st > win + 1e-9 ? 'end' : 'middle' }, fmt(t));
    }
    const H = res.schedule?.hyperperiod;
    if (H && H < win) {
      sv(svg, 'line', { x1: X(H), x2: X(H), y1: 2, y2: 26, class: 'tt-hyper' });
      sv(svg, 'text', { x: X(H) + 3, y: 22, class: 'tt-axt tt-hypert' }, 'repeats');
    }
  }

  function gridLines(svg, X, H) {
    const win = winMs(), W = +svg.getAttribute('viewBox').split(' ')[2];
    const st = niceStep(win, Math.max(3, Math.floor(W / 80)));
    for (let t = 0; t <= win + 1e-9; t += st) sv(svg, 'line', { x1: X(t), x2: X(t), y1: 0, y2: H, class: 'tt-grid' });
  }

  function drawCpu() {
    const svg = cpuSvg; svg.replaceChildren();
    const { W, X } = layout(svg); svg.setAttribute('viewBox', `0 0 ${W} 34`);
    sv(svg, 'rect', { x: X(0), y: 6, width: X(winMs()) - X(0), height: 22, class: 'tt-idle' });
    gridLines(svg, X, 34);
    const tl = res.timeline, ts = res.schedule.tasks;
    tl.lanes.forEach((ln, j) => {
      const row = ts[j].row;
      for (const [a, b] of ln.segs) {
        const r = sv(svg, 'rect', { x: X(a), y: 6, width: Math.max(0.8, X(b) - X(a)), height: 22, class: 'tt-seg', style: `fill: var(--tool-t${row % NCOL})` });
        sv(r, 'title', {}, `${ln.name} runs ${fmt(a)}–${fmt(b)} ms`);
      }
    });
    const S = res.schedule, U = S.utilisation;
    cpuHead.replaceChildren(
      h('div', { class: 'tt-line1' }, h('b', { class: 'tt-cpuname' }, 'CPU'), h('span', { class: `tt-u ${U > 1 ? 'is-bad' : U > (S.mode === 'preempt' ? S.bound : 0.8) ? 'is-warn' : 'is-ok'}` }, `${fmt(U * 100)} % busy`)),
      ubar(S));
    const idle = Math.max(0, 1 - U);
    cpuStats.replaceChildren(h('div', { class: 'tt-st1' }, h('span', {}, 'idle'), h('b', {}, `${fmt(idle * 100)} %`)),
      h('div', { class: 'tt-st2' }, S.mode === 'preempt' ? `RM bound ${fmt(S.bound * 100)} %` : 'hatched = idle'));
  }

  // utilisation as stacked task shares, with the RM bound
  function ubar(S) {
    const svg = sv(null, 'svg', { class: 'tt-ubar', viewBox: '0 0 200 10', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'CPU share per task' });
    let x = 0;
    for (const t of S.tasks) {
      const w = Math.min(200 - x, t.load * 200);
      if (w > 0) { const r = sv(svg, 'rect', { x, y: 1, width: w, height: 8, style: `fill: var(--tool-t${t.row % NCOL})` }); sv(r, 'title', {}, `${t.name}: ${fmt(t.load * 100)} %`); }
      x += Math.max(0, w);
    }
    if (S.mode === 'preempt') sv(svg, 'line', { x1: S.bound * 200, x2: S.bound * 200, y1: 0, y2: 10, class: 'tt-bound' });
    return svg;
  }

  function drawLane(L) {
    const svg = L.svg; const focusKey = svg.contains(document.activeElement) ? document.activeElement.dataset.h : null;
    svg.replaceChildren();
    const { W, X } = layout(svg); const HH = 58; svg.setAttribute('viewBox', `0 0 ${W} ${HH}`);
    const j = laneIdx(L.i), t = taskFor(L.i);
    gridLines(svg, X, HH);
    if (!t) {
      sv(svg, 'text', { x: 10, y: 33, class: 'tt-empty' }, 'Needs a period > 0 and a duration.');
      L.stats.replaceChildren();
      return;
    }
    const ln = res.timeline.lanes[j];
    const win = winMs();
    const col = `var(--tool-t${L.i % NCOL})`;
    const hl = hover && (hover.victim === j || hover.culprit === j);
    L.el.classList.toggle('tt-hl', !!hl);
    // request band: a ghost for every release, deadline span as a thin line
    const yR = 8, hR = 14, yX = 28, hX = 18;
    for (const r of ln.releases) {
      sv(svg, 'line', { x1: X(r), x2: X(Math.min(win, r + t.deadline)), y1: yR + hR + 2.5, y2: yR + hR + 2.5, class: 'tt-dl' });
      sv(svg, 'rect', { x: X(r), y: yR, width: Math.max(1, X(Math.min(win, r + t.dur)) - X(r)), height: hR, class: 'tt-ghost', style: `stroke: ${col}` });
      sv(svg, 'line', { x1: X(r), x2: X(r), y1: 2, y2: yX + hX, class: 'tt-rel' });
    }
    // what ran
    for (const [a, b] of ln.segs) {
      const rr = sv(svg, 'rect', { x: X(a), y: yX, width: Math.max(0.8, X(b) - X(a)), height: hX, rx: 1.5, class: 'tt-run', style: `fill: ${col}` });
      sv(rr, 'title', {}, `${t.name} runs ${fmt(a)}–${fmt(b)} ms`);
    }
    for (const m of ln.misses) {
      const x = X(m);
      sv(svg, 'line', { x1: x, x2: x, y1: 2, y2: HH - 2, class: 'tt-missl' });
      const p = sv(svg, 'path', { d: `M${x - 5},${HH - 1} L${x + 5},${HH - 1} L${x},${HH - 8} Z`, class: 'tt-missm' });
      sv(p, 'title', {}, `${t.name}: deadline missed at ${fmt(m)} ms`);
    }
    // suggested offset, if the tool found better ones
    const sug = res.suggestion?.offsets?.[j];
    if (sug && Math.abs(sug.offset - t.offset) > 1e-9 && sug.offset < win) {
      const x = X(sug.offset);
      sv(svg, 'path', { d: `M${x},${yR - 1} l-4,-6 h8 z`, class: 'tt-sugm' });
      sv(svg, 'line', { x1: x, x2: x, y1: yR - 1, y2: yX + hX, class: 'tt-sugl' });
    }
    // handles on the first job: body = offset, edge = duration, a later release = period
    const x0 = X(t.offset), x1 = X(Math.min(win, t.offset + t.dur));
    if (t.offset <= win) {
      const g = sv(svg, 'g', { class: 'tt-h tt-hjob', tabindex: 0, role: 'slider', 'data-h': 'job',
        'aria-label': `${t.name}: offset ${fmt(t.offset)} ms, duration ${fmt(t.dur)} ms, period ${fmt(t.period)} ms`,
        'aria-valuenow': t.offset, 'aria-valuetext': `offset ${fmt(t.offset)} ms` });
      sv(g, 'rect', { x: x0 - 3, y: yR - 3, width: Math.max(8, x1 - x0) + 6, height: hR + 6, class: 'tt-hit' });
      sv(g, 'rect', { x: x0, y: yR, width: Math.max(3, x1 - x0), height: hR, class: 'tt-first', style: `stroke: ${col}; fill: ${col}` });
      const ge = sv(svg, 'g', { class: 'tt-h tt-hdur', 'data-h': 'dur' });
      sv(ge, 'rect', { x: Math.max(x0 + 3, x1) - 4, y: yR - 3, width: 9, height: hR + 6, class: 'tt-hit' });
      sv(ge, 'rect', { x: Math.max(x0 + 3, x1) - 1.5, y: yR - 1, width: 3, height: hR + 2, rx: 1, class: 'tt-grip' });
      sv(svg, 'text', { x: x0, y: HH - 1, class: 'tt-lab' }, t.offset > 0 ? `off ${fmt(t.offset)}` : '');
    }
    // period handles on the later releases (the first one past the window at the edge)
    const perX = t.offset + t.period;
    const k1 = Math.max(1, Math.ceil((0 - t.offset) / t.period));
    let drew = 0;
    for (let k = k1; k < k1 + 60 && t.offset + k * t.period <= win + 1e-9; k++) {
      const x = X(t.offset + k * t.period);
      const g = sv(svg, 'g', { class: 'tt-h tt-hper', 'data-h': 'per', 'data-k': k });
      sv(g, 'rect', { x: x - 5, y: 0, width: 10, height: yX + hX, class: 'tt-hit' });
      sv(g, 'path', { d: `M${x - 3.5},1 h7 l-3.5,5 z`, class: 'tt-perm', style: `fill: ${col}` });
      drew++;
    }
    if (!drew || perX > win) {
      sv(svg, 'text', { x: W - 8, y: yR + 11, class: 'tt-lab tt-labper', 'text-anchor': 'end' }, `next release ${fmt(perX)} →`);
    }
    if (t.period && drew) {
      const xa = X(t.offset), xb = X(Math.min(win, perX));
      if (xb - xa > 46) {
        sv(svg, 'line', { x1: xa, x2: xb, y1: 4, y2: 4, class: 'tt-dim' });
        sv(svg, 'text', { x: (xa + xb) / 2, y: 7, class: 'tt-lab tt-dimt', 'text-anchor': 'middle' }, `T ${fmt(t.period)}`);
      }
    }
    if (focusKey) svg.querySelector(`[data-h="${focusKey}"]`)?.focus();

    // stats: worst response against the deadline
    const ratio = t.maxResp != null ? t.maxResp / t.deadline : Infinity;
    const bar = sv(null, 'svg', { class: 'tt-rbar', viewBox: '0 0 120 12', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    sv(bar, 'rect', { x: 0, y: 2, width: 120, height: 8, class: 'tt-rbg' });
    sv(bar, 'rect', { x: 0, y: 2, width: Math.min(120, 60 * (t.dur / t.deadline)), height: 8, class: 'tt-rc', style: `fill: ${col}` });
    sv(bar, 'rect', { x: 60 * Math.min(2, t.dur / t.deadline), y: 2, width: Math.max(0, Math.min(120, 60 * Math.min(2, ratio)) - 60 * Math.min(2, t.dur / t.deadline)), height: 8, class: t.missed ? 'tt-rwait is-bad' : 'tt-rwait' });
    sv(bar, 'line', { x1: 60, x2: 60, y1: 0, y2: 12, class: 'tt-rdl' });
    L.stats.replaceChildren(
      h('div', { class: 'tt-st1' }, h('span', {}, 'R'), h('b', { class: t.missed ? 'is-bad' : '' }, fmt(t.maxResp)), h('span', {}, `/ D ${fmt(t.deadline)} ms`)),
      bar,
      h('div', { class: `tt-st2 ${t.missed ? 'is-bad' : ''}` }, t.missed ? `${t.missed} of ${t.jobs} late` : `on time · waits ≤ ${fmt(t.maxDelay)}`));
    L.stats.title = `Worst response ${fmt(t.maxResp)} ms (own ${fmt(t.dur)} ms + waiting), deadline ${fmt(t.deadline)} ms; worst start delay ${fmt(t.maxDelay)} ms`;
  }

  // ---------- direct manipulation ----------
  function attachDrag(L) {
    const svg = L.svg;
    svg.addEventListener('pointerdown', (e) => {
      const g = e.target.closest?.('[data-h]'); if (!g || !res) return;
      const t = taskFor(L.i); if (!t) return;
      e.preventDefault();
      const { T } = layout(svg);
      const kind = g.dataset.h === 'job' ? 'off' : g.dataset.h;
      // Keep the scale still while dragging: pin the window if it is automatic.
      const pinned = String(ctx.raw.window ?? '').trim() === '' ? String(winMs()) : null;
      drag = { L, kind, k: Number(g.dataset.k || 1), t0: T(e.clientX - svg.getBoundingClientRect().left), t, pinned, T };
      if (pinned) ctx.set('window', pinned);
      capture(svg, e);
      svg.classList.add('is-drag');
      if (kind === 'off') svg.querySelector('[data-h="job"]')?.focus();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag || drag.L !== L) return;
      const tt = drag.T(e.clientX - svg.getBoundingClientRect().left);
      const d = drag.t, st = stepFine();
      if (drag.kind === 'off') {
        const v = clamp(snapTo(d.offset + (tt - drag.t0), st), 0, Math.max(0, d.period - st));
        setRow(L.i, { offset: String(v) });
      } else if (drag.kind === 'dur') {
        const v = clamp(snapTo(tt - d.offset, st), st, d.period * 4);
        setRow(L.i, { dur: String(v) });
      } else if (drag.kind === 'per') {
        const raw = (tt - d.offset) / drag.k;
        if (raw > 0) setRow(L.i, { period: String(e.shiftKey ? snapTo(raw, st) : snapPeriod(raw)) });
      }
    });
    const end = () => {
      if (!drag || drag.L !== L) return;
      const pinned = drag.pinned; drag = null; svg.classList.remove('is-drag');
      if (pinned) ctx.set('window', '');
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('keydown', (e) => {
      const g = e.target.closest?.('[data-h="job"]'); if (!g) return;
      const t = taskFor(L.i); if (!t) return;
      const st = stepFine() * (e.altKey ? 10 : 1);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const s = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) setRow(L.i, { dur: String(Math.max(st, snapTo(t.dur + s * st, st))) });
        else setRow(L.i, { offset: String(clamp(snapTo(t.offset + s * st, st), 0, Math.max(0, t.period - st))) });
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setRow(L.i, { period: String(stepPeriod(t.period, e.key === 'ArrowUp' ? 1 : -1)) });
      }
    });
  }

  // ---------- summary, blame, advice ----------
  function drawSummary() {
    const S = res.schedule, v = (k) => res.values?.find((x) => x.label === k);
    const misses = S.tasks.filter((t) => t.missed).length;
    const worst = S.tasks.reduce((a, t) => ((t.maxDelay ?? 0) > (a?.maxDelay ?? -1) ? t : a), null);
    const item = (label, value, tone, title) => h('div', { class: `tt-si ${tone ? `is-${tone}` : ''}`, title: title || null }, h('span', {}, label), h('b', {}, value));
    summary.replaceChildren(...[
      item('CPU load', `${fmt(S.utilisation * 100)} %`, v('CPU utilisation')?.tone, 'Sum of duration ÷ period'),
      item('Hyperperiod', S.hyperperiod ? `${fmt(S.hyperperiod)} ms` : `> ${fmt(S.simulated)} ms`, null, 'The schedule repeats after this (least common multiple of the periods)'),
      item('Late tasks', `${misses} of ${S.tasks.length}`, misses ? 'bad' : 'ok'),
      item('Worst start delay', `${fmt(worst?.maxDelay)} ms`, null, worst ? `${worst.name}` : ''),
      res.suggestion ? item('With spread offsets', `${fmt(res.suggestion.worstDelay)} ms`, res.suggestion.misses ? 'warn' : 'ok', `worst start delay, ${res.suggestion.misses} missed deadlines`) : null].filter(Boolean));
  }

  function drawBlame() {
    const S = res.schedule;
    if (!S.blame.length) { blameBox.replaceChildren(h('div', { class: 'tt-none' }, 'No task waits for another.')); return; }
    const max = Math.max(...S.blame.map((b) => b.total));
    const chip = (j) => { const t = S.tasks[j]; return h('span', { class: 'tt-chip', style: `--c: var(--tool-t${t.row % NCOL})` }, t.name); };
    blameBox.replaceChildren(...S.blame.map((b) => {
      const victim = S.tasks[b.victim];
      const row = h('div', { class: `tt-brow ${victim.missed ? 'is-late' : ''}`, tabindex: 0,
        onpointerenter: () => { hover = b; redrawLanes(); }, onpointerleave: () => { hover = null; redrawLanes(); },
        onfocus: () => { hover = b; redrawLanes(); }, onblur: () => { hover = null; redrawLanes(); } },
      chip(b.culprit), h('span', { class: 'tt-arrow' }, 'holds up'), chip(b.victim),
      h('span', { class: 'tt-bnum' }, `${b.times}× · avg ${fmt(b.avg)} ms`),
      h('i', { class: 'tt-bbar', style: `width: ${(b.total / max) * 100}%` }));
      return row;
    }));
  }

  function drawAdvice() {
    const kids = [];
    const sug = res.suggestion;
    if (sug) {
      const S = res.schedule;
      kids.push(h('div', { class: 'tt-sug' },
        h('div', { class: 'tt-sughead' }, h('b', {}, 'Spread the releases'),
          h('button', { type: 'button', class: 'tt-btn tt-primary', onclick: () => {
            const rows = rowsNow();
            sug.offsets.forEach((o, j) => { const r = S.tasks[j]?.row; if (r != null) rows[r].offset = String(o.offset); });
            ctx.set('tasks', rows);
          } }, 'Apply offsets')),
        h('div', { class: 'tt-sugrows' }, sug.offsets.map((o, j) => {
          const t = S.tasks[j];
          const moved = Math.abs(o.offset - t.offset) > 1e-9;
          return h('span', { class: `tt-sugi ${moved ? 'is-moved' : ''}`, style: `--c: var(--tool-t${t.row % NCOL})` }, h('i'), `${t.name} `, h('b', {}, `${fmt(t.offset)} → ${fmt(o.offset)}`));
        })),
        h('div', { class: 'tt-sugnote' }, `Worst start delay then ${fmt(sug.worstDelay)} ms, ${sug.misses} missed deadlines. The dashed marks in the lanes show where.`)));
    }
    for (const w of res.warnings || []) kids.push(h('div', { class: 'tt-warn' }, w));
    if (!(res.warnings || []).length) kids.push(h('div', { class: 'tt-okmsg' }, 'Every task meets its deadline over the hyperperiod.'));
    for (const n of res.notes || []) kids.push(h('div', { class: 'tt-note' }, n));
    adviceBox.replaceChildren(...kids);
  }

  function redrawLanes() { if (res?.schedule) for (const L of lanes) drawLane(L); }

  function draw() {
    if (!res) return;
    const raw = ctx.raw;
    for (const b of modeBtns) { const on = b.dataset.v === raw.mode; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    if (document.activeElement !== winInput) winInput.value = raw.window ?? '';
    if (lanes.length !== (raw.tasks || []).length) buildLanes();
    for (const L of lanes) syncLane(L);
    if (!res.schedule) {
      summary.replaceChildren(...(res.warnings || []).map((w) => h('div', { class: 'tt-warn' }, w)));
      for (const L of lanes) { L.svg.replaceChildren(); L.stats.replaceChildren(); }
      axisSvg.replaceChildren(); cpuSvg.replaceChildren(); cpuHead.replaceChildren(); cpuStats.replaceChildren();
      blameBox.replaceChildren(); adviceBox.replaceChildren(...(res.warnings || []).map((w) => h('div', { class: 'tt-warn' }, w)));
      return;
    }
    drawSummary(); drawAxis(); drawCpu(); redrawLanes(); drawBlame(); drawAdvice();
  }

  ctx.onResult((r) => { res = r; draw(); });
  let rz = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (res?.schedule) { drawAxis(); drawCpu(); redrawLanes(); } }); }).observe(board);
}
