// Agent Queue Inspector, custom page: the rooms' work as swimlanes in time.
//   Timeline - one lane per room on a clock axis that ends at the snapshot's
//              "now". In each lane: the runs from its log (start to finish,
//              green done / red otherwise), the run going on now growing to
//              the now line with its percent, every log line as a tick (error
//              lines tall and red), and the queued notes as bars from when
//              they were queued to now. The stuck window - the last N minutes
//              before now - is the shaded band; drag its edge (or arrow keys
//              on it) to set the threshold. A run whose last line falls
//              before the band is stuck: the quiet stretch is hatched red and
//              the step it stopped at is written on it.
//   Inspector- click a run, a tick or a note for its details; opens on the
//              stuck step, or the longest-waiting note.
//   Live     - Refresh takes a snapshot of the app (/api/queue, /api/run,
//              /api/activity, /api/revisions) into the Snapshot input, so
//              run(), the Prompt and the JSON describe the same moment.
// Every time, wait, run and state drawn comes from run()'s result.timeline.
import { dur } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const ROOMS = ['cad', 'pcb', 'web', 'embedded', 'mobile'];
const LOG_LINES = 100;
const EVERY = 30;
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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
const stamp = (t) => (t == null ? '–' : new Date(t).toISOString().slice(5, 16).replace('T', ' '));
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const WINDOWS = [['fit', 'All'], [60, '1 h'], [240, '4 h'], [720, '12 h'], [1440, '24 h']];
const STATE_WORD = { stuck: 'stuck', running: 'running', waiting: 'not picked up', queued: 'queued', idle: 'idle', 'last run failed': 'last run failed' };

export function page(root, ctx) {
  const state = { win: 'fit', pick: null, width: 900, drag: null, live: { loaded: false, busy: false, msg: '', tone: '', auto: false, timer: null } };
  const tl = () => ctx.result?.timeline || null;

  // ---------- skeleton ----------
  const live = h('div', { class: 'qi-live' });
  const stats = h('div', { class: 'qi-stats' });
  const winSeg = h('div', { class: 'qi-seg', role: 'group', 'aria-label': 'Time window' });
  const roomSeg = h('div', { class: 'qi-seg', role: 'group', 'aria-label': 'Room' });
  const stuckIn = h('input', { type: 'text', inputmode: 'decimal', class: 'qi-in', 'aria-label': 'Stuck after, minutes', spellcheck: 'false' });
  stuckIn.addEventListener('input', () => ctx.set('stuck', stuckIn.value));
  const svg = sv('svg', { class: 'qi-svg', role: 'group', 'aria-label': 'Rooms on a time axis: runs, log lines and queued notes' });
  const stage = h('div', { class: 'qi-stage' }, svg);
  const legend = h('div', { class: 'qi-legend' });
  const insp = h('div', { class: 'qi-insp', 'aria-live': 'polite' });
  const queueList = h('div', { class: 'qi-queue' });
  const snapTa = h('textarea', { class: 'qi-ta', spellcheck: 'false', rows: 8, 'aria-label': 'Snapshot JSON' });
  snapTa.addEventListener('input', () => ctx.set('snapshot', snapTa.value));
  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });

  root.append(h('div', { class: 'qi' },
    h('section', { class: 'qi-panel' },
      h('div', { class: 'qi-head' }, live, h('span', { class: 'qi-grow' }), stats),
      h('div', { class: 'qi-tools' },
        h('label', { class: 'qi-f' }, h('span', {}, 'Rooms'), roomSeg),
        h('label', { class: 'qi-f' }, h('span', {}, 'Window'), winSeg),
        h('label', { class: 'qi-f' }, h('span', {}, 'Stuck after'), stuckIn, h('span', {}, 'min'))),
      stage, legend),
    h('div', { class: 'qi-below' },
      h('section', { class: 'qi-panel' }, h('div', { class: 'qi-head' }, h('h2', {}, 'Inspector')), insp),
      h('section', { class: 'qi-panel' }, h('div', { class: 'qi-head' }, h('h2', {}, 'Queue'), h('span', { class: 'qi-sub' }, 'longest waiting first')), queueList),
      h('div', { class: 'qi-msgs' }, warns, notes,
        h('details', { class: 'qi-panel qi-snap' }, h('summary', {}, 'Snapshot JSON (paste one when not in the app)'), snapTa))),
    ctx.outputs));

  // ---------- geometry ----------
  function frame(t) {
    const W = Math.max(320, state.width);
    const narrow = W < 620;
    const G = narrow ? 0 : 168;                       // gutter for the room names
    const R = narrow ? 10 : 18;
    const laneH = narrow ? 100 : 78, top = 30;
    const now = t.now;
    let span;
    if (state.win === 'fit') {
      const times = t.lanes.flatMap((l) => [l.run?.start, ...l.runs.map((r) => r.start ?? r.end), ...l.log.map((x) => x.at), ...l.queue.map((q) => q.at)]).filter((x) => x != null);
      const first = times.length ? Math.min(...times) : now - 3600e3;
      span = Math.max(now - first, (t.limit + 10) * 60e3) * 1.06;
    } else span = state.win * 60e3;
    const t0 = now - span;
    const X = (ms) => G + ((ms - t0) / span) * (W - G - R);
    const T = (x) => t0 + ((x - G) / (W - G - R)) * span;
    return { W, G, R, laneH, top, now, span, t0, X, T, narrow, H: top + t.lanes.length * laneH + 8 };
  }

  // ---------- timeline ----------
  function draw() {
    const t = tl();
    svg.replaceChildren();
    if (!t) { svg.setAttribute('viewBox', '0 0 600 80'); return; }
    if (t.now == null || !t.lanes.length) {
      svg.setAttribute('viewBox', `0 0 ${state.width} 90`);
      svg.append(sv('text', { x: state.width / 2, y: 50, class: 'qi-t soft', 'text-anchor': 'middle' }, t.now == null ? 'The snapshot has no times: nothing to put on a clock.' : 'No room has queued, run or logged anything in this snapshot.'));
      return;
    }
    const f = frame(t);
    svg.setAttribute('viewBox', `0 0 ${f.W} ${f.H}`);
    svg.style.height = `${f.H}px`;
    const defs = sv('defs');
    const hatch = sv('pattern', { id: 'qi-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.append(sv('rect', { width: 2.5, height: 7, class: 'qi-hatchl' }));
    const run = sv('pattern', { id: 'qi-live', width: 10, height: 10, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' });
    run.append(sv('rect', { width: 10, height: 10, class: 'qi-livebg' }), sv('rect', { width: 4, height: 10, class: 'qi-livel' }));
    defs.append(hatch, run);
    svg.append(defs);

    // axis ticks
    const minutes = f.span / 60e3;
    const step = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440].find((m) => (f.W - f.G) / (minutes / m) >= (f.narrow ? 58 : 70)) || 1440;
    const first = Math.ceil(f.t0 / (step * 60e3)) * step * 60e3;
    const bx = f.X(f.now - t.limit * 60e3);
    const nowW = f.narrow ? 42 : 96;
    for (let tm = first; tm <= f.now; tm += step * 60e3) {
      const x = f.X(tm);
      svg.append(sv('line', { x1: x, x2: x, y1: f.top - 6, y2: f.H - 8, class: 'qi-grid' }));
      // tick labels give way to the now label and the threshold grip
      const labAt = f.X(f.now) - bx < nowW + 10 ? bx - 9 : f.X(f.now) - 4;
      if ((x < labAt - nowW - 24 || x > f.X(f.now)) && Math.abs(x - bx) > 24 && x > 18) svg.append(sv('text', { x, y: f.top - 11, class: 'qi-tick', 'text-anchor': 'middle' }, hhmm(tm)));
    }
    // stuck window
    svg.append(sv('rect', { x: bx, y: f.top - 4, width: f.X(f.now) - bx, height: f.H - f.top - 4, class: 'qi-window' }));
    svg.append(sv('line', { x1: f.X(f.now), x2: f.X(f.now), y1: f.top - 22, y2: f.H - 8, class: 'qi-now' }),
      sv('text', { x: f.X(f.now) - bx < nowW + 10 ? bx - 9 : f.X(f.now) - 4, y: f.top - 11, class: 'qi-tick b', 'text-anchor': 'end' }, f.narrow ? 'now' : `now ${hhmm(f.now)} UTC`));

    t.lanes.forEach((l, i) => drawLane(l, i, f, t));

    // the threshold handle, on the band's edge
    const hd = sv('g', { class: 'qi-h', tabindex: 0, role: 'slider', 'aria-label': `Stuck after ${t.limit} minutes: drag the band's edge, or arrow keys`,
      'aria-valuenow': t.limit, 'aria-valuemin': 1, transform: `translate(${bx} 0)` });
    hd.append(sv('rect', { x: -7, y: f.top - 24, width: 14, height: f.H - f.top + 16, class: 'qi-hhit' }),
      sv('line', { x1: 0, x2: 0, y1: f.top - 4, y2: f.H - 8, class: 'qi-hline' }),
      sv('rect', { x: -5, y: f.top - 24, width: 10, height: 20, rx: 3, class: 'qi-hgrip' }),
      sv('title', {}, 'Drag to set how long a quiet run may go before it counts as stuck'));
    const lab = sv('text', { x: -8, y: f.H - 12, class: 'qi-tick warn', 'text-anchor': 'end' }, `stuck after ${t.limit} min`);
    hd.append(lab);
    svg.append(hd);
    if (state.refocus === 'handle') { state.refocus = null; hd.focus({ preventScroll: true }); }
  }

  function drawLane(l, i, f, t) {
    const y0 = f.top + i * f.laneH;
    const lane = sv('g', { class: `qi-lane st-${l.state.replace(/\s+/g, '-')}` });
    lane.append(sv('rect', { x: 0, y: y0, width: f.W, height: f.laneH, class: `qi-lanebg${i % 2 ? ' odd' : ''}` }));
    // tracks: queue on top, runs in the middle, log at the bottom
    const off = f.narrow ? 26 : 0;
    const yq = y0 + off + 8, yr = y0 + off + 28, yl = y0 + off + 56;
    // gutter
    const lx = f.narrow ? 8 : 12, ly = f.narrow ? y0 + 15 : y0 + 22;
    const name = sv('g', { class: 'qi-room', tabindex: 0, role: 'button', 'data-room': l.room, 'aria-label': `${l.room}: ${STATE_WORD[l.state] || l.state}. Enter shows only this room.` });
    name.append(sv('text', { x: lx, y: ly, class: 'qi-rname' }, l.room), sv('text', { x: lx + (f.narrow ? l.room.length * 9 + 10 : 0), y: f.narrow ? ly : ly + 16, class: `qi-state st-${l.state.replace(/\s+/g, '-')}` }, STATE_WORD[l.state] || l.state));
    const s = l.stats;
    const facts = [`${s.queued} queued${s.oldest != null ? `, oldest ${dur(s.oldest)}` : ''}`,
      `runs ok ${s.finished ? `${s.ok}/${s.finished}` : '–'} · errors ${s.errors}${s.applied + s.rejected ? ` · applied ${Math.round((100 * s.applied) / (s.applied + s.rejected))} %` : ''}`];
    if (!f.narrow) facts.forEach((txt, k) => name.append(sv('text', { x: lx, y: ly + 32 + k * 13, class: 'qi-fact' }, txt)));
    else name.append(sv('text', { x: lx, y: ly + 16, class: 'qi-fact' }, `${s.queued} queued${s.oldest != null ? `, oldest ${dur(s.oldest)}` : ''} · runs ok ${s.finished ? `${s.ok}/${s.finished}` : '–'}`));
    name.append(sv('title', {}, 'Click to show only this room (again: all rooms)'));
    lane.append(name);
    const x = (ms) => clamp(f.X(ms), f.G, f.W - f.R);
    const visible = (a, b) => b >= f.t0 && a <= f.now;

    // finished runs
    for (const r of l.runs) {
      const a = r.start ?? r.end, b = r.end;
      if (!visible(a, b)) continue;
      const w = Math.max(3, x(b) - x(a));
      const g = sv('g', { class: `qi-run ${r.ok ? 'ok' : 'bad'}${state.pick?.kind === 'run' && state.pick.room === l.room && state.pick.end === r.end ? ' on' : ''}`, tabindex: 0, role: 'button',
        'aria-label': `${l.room} run ${r.title}: ${r.status}, ${r.took != null ? dur(r.took) : 'start not in the log'}` });
      g.append(sv('rect', { x: x(a), y: yr, width: w, height: 20, rx: 3 }));
      if (r.start == null) g.append(sv('rect', { x: x(a) - 8, y: yr, width: 8, height: 20, class: 'qi-fade' }));
      if (w > 60) g.append(sv('text', { x: x(a) + 5, y: yr + 14, class: 'qi-rt' }, short(r.title, Math.floor((w - 10) / 6.4))));
      g.addEventListener('click', () => pick({ kind: 'run', room: l.room, end: r.end }));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick({ kind: 'run', room: l.room, end: r.end }); } });
      lane.append(g);
    }
    // the run going on now
    if (l.run && /running/i.test(l.run.status) && l.run.start != null) {
      const a = l.run.start, lastAt = l.log.length ? l.log[l.log.length - 1].at : a;
      const g = sv('g', { class: `qi-run live${l.state === 'stuck' ? ' stuck' : ''}${state.pick?.kind === 'current' && state.pick.room === l.room ? ' on' : ''}`, tabindex: 0, role: 'button',
        'aria-label': `${l.room} running ${l.run.title}, ${l.run.percent != null ? `${l.run.percent} %` : ''} for ${dur(l.run.time)}` });
      g.append(sv('rect', { x: x(a), y: yr, width: Math.max(3, x(f.now) - x(a)), height: 20, rx: 3, class: 'body' }));
      if (l.state === 'stuck') g.append(sv('rect', { x: x(lastAt), y: yr - 3, width: Math.max(2, x(f.now) - x(lastAt)), height: 26, class: 'qi-quiet' }));
      const w = x(f.now) - x(a);
      const pct = l.run.percent != null ? `${Math.round(l.run.percent)} % · ` : '';
      if (w > 70) g.append(sv('text', { x: x(a) + 5, y: yr + 14, class: 'qi-rt' }, short(`${pct}${l.run.title}`, Math.floor(((l.state === 'stuck' ? x(lastAt) : x(f.now)) - x(a) - 10) / 6.4))));
      g.addEventListener('click', () => pick({ kind: 'current', room: l.room }));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick({ kind: 'current', room: l.room }); } });
      lane.append(g);
      if (l.state === 'stuck' && l.stuckStep) {
        const sx = x(l.stuckStep.at);
        const callout = sv('g', { class: 'qi-callout', tabindex: 0, role: 'button', 'aria-label': `Stuck for ${dur(l.quietFor)} at: ${l.stuckStep.text}` });
        const txt = `stuck ${dur(l.quietFor)} at "${l.stuckStep.text}"`;
        const maxChars = Math.floor((f.W - f.R - sx - 14) / 6.3);
        const leftChars = Math.floor((sx - f.G - 10) / 6.3);
        const anchorLeft = maxChars < txt.length && leftChars > maxChars;
        callout.append(sv('line', { x1: sx, x2: sx, y1: yr - 4, y2: yl + 8, class: 'qi-cl' }),
          sv('circle', { cx: sx, cy: yr - 4, r: 3.5, class: 'qi-cd' }),
          sv('text', { x: anchorLeft ? sx - 6 : sx + 6, y: yr - 7, class: 'qi-ct', 'text-anchor': anchorLeft ? 'end' : 'start' }, short(txt, anchorLeft ? Math.floor((sx - f.G - 10) / 6.3) : maxChars)));
        callout.addEventListener('click', () => pick({ kind: 'current', room: l.room }));
        callout.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick({ kind: 'current', room: l.room }); } });
        lane.append(callout);
      }
    }
    // log ticks
    const ticks = sv('g', { class: 'qi-ticks' });
    l.log.forEach((ln, k) => {
      if (ln.at < f.t0 || ln.at > f.now) return;
      const tx = x(ln.at), err = ln.level === 'error';
      const on = state.pick?.kind === 'log' && state.pick.room === l.room && state.pick.k === k;
      const g = sv('g', { class: `qi-tk lv-${ln.level || 'x'}${on ? ' on' : ''}` });
      g.append(sv('rect', { x: tx - 4, y: yl - 12, width: 8, height: 22, class: 'hit' }),
        sv('line', { x1: tx, x2: tx, y1: err ? yl - 10 : yl - 4, y2: yl + 6 }), sv('title', {}, `${hhmm(ln.at)} ${ln.text}`));
      g.addEventListener('click', () => pick({ kind: 'log', room: l.room, k }));
      ticks.append(g);
    });
    lane.append(sv('line', { x1: f.G, x2: f.W - f.R, y1: yl + 6, y2: yl + 6, class: 'qi-base' }), ticks);
    // queued notes: from queued to now, stacked in the queue track
    const qs = [...l.queue].filter((q) => q.at != null).sort((a, b) => a.at - b.at);
    qs.forEach((q, k) => {
      const yy = yq + (k % 3) * 5;
      const on = state.pick?.kind === 'queue' && state.pick.id === q.id;
      const late = q.wait != null && q.wait > t.limit * 60;
      const g = sv('g', { class: `qi-q${late ? ' late' : ''}${on ? ' on' : ''}`, tabindex: 0, role: 'button', 'aria-label': `Queued ${dur(q.wait)} ago: ${q.summary}` });
      g.append(sv('rect', { x: x(q.at), y: yy - 3, width: Math.max(4, x(f.now) - x(q.at)), height: 9, class: 'hit' }),
        sv('line', { x1: x(q.at), x2: x(f.now), y1: yy, y2: yy, class: 'bar' }), sv('circle', { cx: x(q.at), cy: yy, r: 3.2, class: 'dot' }), sv('title', {}, `queued ${stamp(q.at)}, waiting ${dur(q.wait)}: ${q.summary}`));
      g.addEventListener('click', () => pick({ kind: 'queue', room: l.room, id: q.id }));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick({ kind: 'queue', room: l.room, id: q.id }); } });
      lane.append(g);
    });
    if (qs.length) lane.append(sv('text', { x: f.X(f.now) + 3, y: yq + 4, class: 'qi-qn' }, qs.length));
    svg.append(lane);
  }

  // ---------- threshold drag ----------
  const toSvg = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const hd = e.target.closest('.qi-h');
    const room = e.target.closest('.qi-room');
    if (room) { toggleRoom(room.dataset.room); return; }
    if (!hd) return;
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const t = tl(); if (!t) return;
    state.drag = { f: frame(t) };      // the axis holds still while dragging
    hd.focus({ preventScroll: true });
  });
  svg.addEventListener('pointermove', (e) => {
    const d = state.drag; if (!d) return;
    const p = toSvg(e);
    const mins = clamp(Math.round((d.f.now - d.f.T(p.x)) / 60e3), 1, 7 * 1440);
    if (String(mins) !== String(ctx.raw.stuck)) { state.refocus = 'handle'; ctx.set('stuck', String(mins)); }
  });
  const endDrag = (e) => { if (!state.drag) return; state.drag = null; try { svg.releasePointerCapture(e.pointerId); } catch { /* gone */ } };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('keydown', (e) => {
    const room = e.target.closest('.qi-room');
    if (room && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRoom(room.dataset.room); return; }
    if (!e.target.closest('.qi-h')) return;
    const t = tl(); if (!t) return;
    const big = e.shiftKey ? 10 : 1;
    let v = t.limit;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') v += big;          // left = further back = longer
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') v -= big;
    else return;
    e.preventDefault();
    state.refocus = 'handle';
    ctx.set('stuck', String(clamp(v, 1, 7 * 1440)));
  });
  function toggleRoom(r) { ctx.set('room', (ctx.raw.room || 'all') === r ? 'all' : r); }

  // ---------- inspector ----------
  function pick(p) { state.pick = p; draw(); drawInspector(); }
  function defaultPick(t) {
    const stuck = t.lanes.find((l) => l.state === 'stuck');
    if (stuck) return { kind: 'current', room: stuck.room };
    const q = t.lanes.flatMap((l) => l.queue.map((x) => ({ l, x }))).sort((a, b) => (b.x.wait ?? -1) - (a.x.wait ?? -1))[0];
    if (q) return { kind: 'queue', room: q.l.room, id: q.x.id };
    const running = t.lanes.find((l) => l.state === 'running');
    return running ? { kind: 'current', room: running.room } : null;
  }
  const row = (k, v, cls = '') => h('div', { class: `qi-kv ${cls}` }, h('span', {}, k), h('b', {}, v));
  function drawInspector() {
    const t = tl();
    insp.replaceChildren();
    if (!t || !t.lanes.length) { insp.append(h('div', { class: 'qi-empty' }, 'Nothing to inspect in this snapshot.')); return; }
    let p = state.pick;
    const lane = p && t.lanes.find((l) => l.room === p.room);
    if (!p || !lane) { p = state.pick = defaultPick(t); }
    const l = p && t.lanes.find((x) => x.room === p.room);
    if (!p || !l) { insp.append(h('div', { class: 'qi-empty' }, 'All quiet: nothing running, nothing queued. Click a run or a log tick to see it.')); return; }
    if (p.kind === 'current' && l.run) {
      const r = l.run;
      insp.append(h('div', { class: `qi-ih ${l.state === 'stuck' ? 'bad' : 'live'}` }, `${l.room} · ${l.state === 'stuck' ? 'stuck run' : 'running now'}`),
        h('div', { class: 'qi-title' }, r.title || '(untitled)'),
        row('Started', stamp(r.start)), row('Running for', dur(r.time)), r.percent != null ? row('Progress', `${Math.round(r.percent)} %`) : null,
        row('Quiet for', l.quietFor != null ? dur(l.quietFor) : '–', l.state === 'stuck' ? 'bad' : ''),
        l.stuckStep ? h('div', { class: 'qi-step' }, h('span', {}, `Last step, ${stamp(l.stuckStep.at)}`), h('code', {}, l.stuckStep.text)) : null,
        l.state === 'stuck' ? h('div', { class: 'qi-advice' }, `Nothing logged for over ${t.limit} min. Look at the ${l.room} room's agent: it may be waiting on a prompt, a lock or a crashed tool.`) : null);
    } else if (p.kind === 'run') {
      const r = l.runs.find((x) => x.end === p.end);
      if (!r) { state.pick = null; drawInspector(); return; }
      insp.append(h('div', { class: `qi-ih ${r.ok ? 'ok' : 'bad'}` }, `${l.room} · run ${r.status}`), h('div', { class: 'qi-title' }, r.title),
        row('Started', stamp(r.start)), row('Finished', stamp(r.end)), row('Took', r.took != null ? dur(r.took) : 'start not in the log'));
      const lines = l.log.filter((x) => r.start != null && x.at >= r.start && x.at <= r.end);
      if (lines.length) insp.append(h('div', { class: 'qi-lines' }, lines.map((x) => h('div', { class: `lv-${x.level}` }, h('span', {}, hhmm(x.at)), ' ', x.text))));
    } else if (p.kind === 'log') {
      const x = l.log[p.k];
      if (!x) { state.pick = null; drawInspector(); return; }
      insp.append(h('div', { class: `qi-ih ${x.level === 'error' ? 'bad' : x.level === 'done' ? 'ok' : ''}` }, `${l.room} · log line · ${x.level || 'no level'}`),
        h('code', { class: 'qi-code' }, x.text), row('At', `${stamp(x.at)} UTC`), row('Before now', dur((t.now - x.at) / 1000)));
      const near = l.log.slice(Math.max(0, p.k - 3), p.k + 4);
      insp.append(h('div', { class: 'qi-lines' }, near.map((y) => h('div', { class: `lv-${y.level}${y === x ? ' on' : ''}` }, h('span', {}, hhmm(y.at)), ' ', y.text))));
    } else if (p.kind === 'queue') {
      const q = l.queue.find((x) => x.id === p.id);
      if (!q) { state.pick = null; drawInspector(); return; }
      const late = q.wait != null && q.wait > t.limit * 60;
      insp.append(h('div', { class: `qi-ih ${late ? 'warn' : ''}` }, `${l.room} · queued note`), h('div', { class: 'qi-title' }, q.summary || '(no summary)'),
        row('Queued', stamp(q.at)), row('Waiting', dur(q.wait), late ? 'warn' : ''), row('ID', q.id || '–'),
        late && !(l.state === 'running' || l.state === 'stuck') ? h('div', { class: 'qi-advice' }, `Waiting over ${t.limit} min with no run going: the ${l.room} room's agent is not picking up its queue.`) : null);
    }
  }

  function drawQueue() {
    const t = tl();
    queueList.replaceChildren();
    const all = t ? t.lanes.flatMap((l) => l.queue.map((q) => ({ l, q }))).sort((a, b) => (b.q.wait ?? -1) - (a.q.wait ?? -1)) : [];
    if (!all.length) { queueList.append(h('div', { class: 'qi-empty' }, 'Nothing is queued.')); return; }
    const most = Math.max(...all.map((x) => x.q.wait || 0), (t.limit || 1) * 60);
    for (const { l, q } of all) {
      const late = q.wait != null && q.wait > t.limit * 60;
      queueList.append(h('button', { type: 'button', class: `qi-qrow${late ? ' late' : ''}${state.pick?.kind === 'queue' && state.pick.id === q.id ? ' on' : ''}`, onclick: () => pick({ kind: 'queue', room: l.room, id: q.id }) },
        h('span', { class: 'r' }, l.room), h('span', { class: 's' }, q.summary || '–'), h('b', {}, dur(q.wait)),
        h('i', { class: 'bar' }, h('i', { style: `width:${(100 * (q.wait || 0)) / most}%` }), h('i', { class: 'lim', style: `left:${(100 * t.limit * 60) / most}%` }))));
    }
  }

  function drawControls(res) {
    const raw = ctx.raw;
    if (document.activeElement !== stuckIn) stuckIn.value = raw.stuck ?? '';
    stuckIn.classList.toggle('bad', !(ctx.input.stuck > 0));
    if (document.activeElement !== snapTa) snapTa.value = raw.snapshot ?? '';
    const room = raw.room || 'all';
    roomSeg.replaceChildren(...[['all', 'All'], ...ROOMS.map((r) => [r, r])].map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(room === v), onclick: () => ctx.set('room', v) }, t)));
    winSeg.replaceChildren(...WINDOWS.map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(state.win === v), onclick: () => { state.win = v; draw(); drawControls(ctx.result); } }, t)));
    stats.replaceChildren(...(res.values || []).map((v) => h('span', { class: `qi-stat${v.tone ? ` ${v.tone}` : ''}`, title: v.hint || null }, h('small', {}, v.label), h('b', {}, String(v.value)), v.hint ? h('em', {}, v.hint) : null)));
    legend.innerHTML = '<span><i class="lg run ok"></i>run done</span><span><i class="lg run bad"></i>run failed</span><span><i class="lg run live"></i>running now</span>'
      + '<span><i class="lg quiet"></i>quiet (stuck)</span><span><i class="lg tick"></i>log line</span><span><i class="lg tick err"></i>error line</span>'
      + '<span><i class="lg q"></i>queued note, to now</span><span><i class="lg win"></i>stuck window</span>'
      + '<span class="grow">Drag the band\'s edge (or arrows on it) to set the threshold · click a run, tick or note to inspect it · click a room to show only it</span>';
  }

  // ---------- live snapshot ----------
  const inApp = /^https?:/.test(location.protocol);
  async function get(u) { const r = await fetch(u); if (!r.ok) throw new Error(`${u.split('?')[0]} answered ${r.status}`); return r.json(); }
  async function refresh() {
    const L = state.live;
    if (L.busy) return;
    L.busy = true; L.msg = 'Taking a snapshot…'; L.tone = ''; drawLive();
    try {
      const [queue, open, archived, runs, logs] = await Promise.all([
        get('/api/queue'), get('/api/revisions'), get('/api/revisions?archived=true').catch(() => []),
        Promise.all(ROOMS.map((r) => get(`/api/run?room=${r}`).catch(() => null))),
        Promise.all(ROOMS.map((r) => get(`/api/activity?room=${r}&limit=${LOG_LINES}`).catch(() => []))),
      ]);
      const snap = {
        at: new Date().toISOString(),
        queue: (Array.isArray(queue) ? queue : []).map((x) => ({ id: x.id ?? x._id, kind: x.kind || 'cad', summary: x.summary || String(x.comment || '').slice(0, 120), queued_at: x.queued_at || null, created_at: x.created_at || null })),
        runs: Object.fromEntries(ROOMS.map((r, i) => [r, runs[i]]).filter(([, v]) => v && typeof v === 'object')
          .map(([r, v]) => [r, { status: v.status, percent: v.percent, title: v.title, started_at: v.started_at, finished_at: v.finished_at }])),
        activity: Object.fromEntries(ROOMS.map((r, i) => [r, (Array.isArray(logs[i]) ? logs[i] : []).map((l) => ({ at: l.at, text: String(l.text || '').slice(0, 160), level: l.level }))]).filter(([, v]) => v.length)),
        revisions: [...new Map([...(Array.isArray(archived) ? archived : []), ...(Array.isArray(open) ? open : [])].map((x) => [x.id ?? x._id, { kind: x.kind || 'cad', status: x.status }])).values()],
      };
      L.loaded = true; L.busy = false; L.tone = 'ok';
      L.msg = `Snapshot at ${new Date(snap.at).toLocaleTimeString()}: ${snap.queue.length} queued, ${Object.keys(snap.runs).length} rooms with a run.`;
      ctx.set('snapshot', JSON.stringify(snap));
    } catch (e) {
      L.loaded = true; L.busy = false; L.tone = 'bad';
      L.msg = `Could not reach the app (${e.message || e}). The example snapshot is shown; paste one below.`;
      drawLive();
    }
  }
  function setAuto(on) {
    const L = state.live;
    L.auto = on; clearInterval(L.timer); L.timer = null;
    if (on) L.timer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh(); }, EVERY * 1000);
    drawLive();
  }
  function drawLive() {
    const L = state.live;
    if (!inApp) { live.replaceChildren(h('h2', {}, 'Rooms'), h('span', { class: 'qi-msg' }, 'Opened as a file: showing the pasted snapshot. Open it in the app to read the live queue.')); return; }
    const tone = L.tone === 'bad' ? 'bad' : L.tone === 'ok' ? 'ok' : '';
    live.replaceChildren(h('h2', {}, 'Rooms'),
      h('button', { class: 'k-btn k-primary', disabled: L.busy, onclick: refresh }, L.busy ? 'Reading…' : 'Refresh'),
      h('label', { class: 'qi-f' }, h('input', { type: 'checkbox', checked: L.auto, onchange: (e) => setAuto(e.target.checked) }), h('span', {}, `every ${EVERY} s`)),
      L.msg ? h('span', { class: `qi-msg ${tone}`, role: 'status' }, L.msg) : null);
  }

  // ---------- render ----------
  function render(res) {
    if (!res) return;
    drawControls(res);
    draw();
    drawInspector();
    drawQueue();
    drawLive();
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
  }
  new ResizeObserver(() => {
    const w = Math.round(stage.clientWidth);
    if (w > 0 && Math.abs(w - state.width) > 2) { state.width = w; if (ctx.result) draw(); }
  }).observe(stage);
  ctx.onResult((res) => render(res));
  if (inApp) refresh(); else drawLive();
}
