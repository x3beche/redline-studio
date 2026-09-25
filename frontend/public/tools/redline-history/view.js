// Redline History: the page is the history of the marked spots.
//   Strata  - one lane per area (a model's part, or a camera spot), the most
//             marked on top, every note a mark at its time: a filled dot was
//             applied, a cross rejected, a ring is still open. An amber arc
//             jumps from an applied fix to the note that came back on the same
//             spot. Time is folded by day (only days with notes take room), so
//             a burst of notes in one afternoon and a note three days later
//             both stay readable. The dashed threshold line splits "marked
//             again" from "marked once": drag it (or arrow keys) to change it.
//             Click a lane to open its story.
//   Spot    - for an area found by camera target: the model's marked spots
//             seen from above, with the "nearby within" circle around the
//             area's first note; drag its handle to change the radius and
//             watch the spots join or split.
//   Story   - the focused area's notes, oldest first, with the time between
//             them, the outcome, "came back" and the drawing (in the app).
// "Load notes" reads the app's notes (/api/revisions, open and archived)
// into the Notes input, so run(), the Prompt and the JSON all use them.
// Every count, grouping and "came back" shown comes from run()'s
// result.history; the page only lays it out.

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const served = () => /^https?:/.test(location.protocol);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d) => `${MON[+d.slice(5, 7) - 1] || d.slice(5, 7)} ${+d.slice(8, 10)}`;
const hm = (iso) => (iso && iso.length >= 16 ? iso.slice(11, 16) : '');
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const OPEN = new Set(['queued', 'draft', 'working', 'running']);
const kindOf = (s) => (s === 'applied' ? 'ap' : s === 'rejected' ? 'rj' : OPEN.has(s) ? 'op' : 'ot');
const since = (a, b) => {
  const d = (b - a) / 60000;
  if (!Number.isFinite(d) || d < 0) return '';
  if (d < 1) return 'same minute';
  if (d < 60) return `${Math.round(d)} min later`;
  if (d < 60 * 36) return `${(d / 60).toFixed(d < 600 ? 1 : 0)} h later`;
  return `${Math.round(d / 1440)} days later`;
};
const trunc = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
const ROOMS = [['all', 'All'], ['cad', '3D'], ['pcb', 'PCB'], ['web', 'Web'], ['embedded', 'Embedded'], ['mobile', 'Mobile']];
const MODES = [['auto', 'Part, else spot'], ['part', 'Part'], ['place', 'Camera spot'], ['model', 'Model']];

// The notes loader (the live half), kept from the tool's first view.
const compact = (x) => {
  const o = { id: x.id ?? x._id, created_at: x.created_at, kind: x.kind || 'cad', model: x.model || null, part: x.part || null,
    status: x.status, summary: x.summary || String(x.comment || '').slice(0, 140) };
  const t = x.camera && Array.isArray(x.camera.target) ? x.camera.target : null;
  if (t && t.every((v) => Number.isFinite(Number(v)))) o.target = t.map((v) => Math.round(Number(v) * 10) / 10);
  if (typeof o.part === 'string' && o.part.length > 100) o.part = o.part.slice(0, 100);
  return o;
};

export function page(root, ctx) {
  const st = { loaded: false, busy: false, msg: '', tone: '', at: null, hover: null, pick: null, drag: null, w: 0, laneFocus: null };
  const H = () => ctx.result?.history || null;

  // ---------- skeleton ----------
  const loadBtn = h('button', { class: 'k-btn k-primary', type: 'button' }, 'Load notes');
  const loadMsg = h('span', { class: 'rh-msg', role: 'status' });
  const roomSeg = h('div', { class: 'rh-seg', role: 'group', 'aria-label': 'Room' });
  const modeSeg = h('div', { class: 'rh-seg', role: 'group', 'aria-label': 'Same area means' });
  const radIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Nearby within, mm' });
  const radBox = h('label', { class: 'rh-f' }, h('span', {}, 'within'), radIn, h('span', { class: 'u' }, 'mm'));
  const minIn = h('input', { type: 'text', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Marked again at, notes' });
  const minBox = h('label', { class: 'rh-f' }, h('span', {}, 'marked again at ≥'), minIn, h('span', { class: 'u' }, 'notes'));
  radIn.addEventListener('input', () => ctx.set('radius', radIn.value));
  minIn.addEventListener('input', () => ctx.set('min', minIn.value));
  const bar = h('div', { class: 'rh-bar' },
    h('div', { class: 'rh-grp' }, loadBtn, loadMsg),
    h('div', { class: 'rh-grp' }, h('span', { class: 'rh-k' }, 'Room'), roomSeg),
    h('div', { class: 'rh-grp' }, h('span', { class: 'rh-k' }, 'Same area'), modeSeg, radBox),
    h('div', { class: 'rh-grp' }, minBox));

  const summary = h('div', { class: 'rh-sum', 'aria-live': 'polite' });
  const svg = sv('svg', { class: 'rh-svg', role: 'group', 'aria-label': 'Notes per area over time' });
  const tip = h('div', { class: 'rh-tip', role: 'status' });
  const stage = h('div', { class: 'rh-stage' }, svg, tip);
  const legend = h('div', { class: 'rh-legend' });
  const strata = h('section', { class: 'rh-panel rh-strata' },
    h('div', { class: 'rh-head' }, h('h2', {}, 'Where the notes landed, and when'), summary), stage, legend);

  const fHead = h('div', { class: 'rh-head rh-fhead' });
  const spot = h('div', { class: 'rh-spot' });
  const story = h('ol', { class: 'rh-story' });
  const focusP = h('section', { class: 'rh-panel rh-focus' }, fHead, spot, story);

  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  const paste = h('details', { class: 'rh-panel rh-paste' }, h('summary', {}, 'Notes as JSON (paste your own) and all inputs'), ctx.form);
  root.append(h('div', { class: 'rh' }, bar,
    h('div', { class: 'rh-work' }, strata, focusP),
    h('div', { class: 'rh-bottom' }, h('div', { class: 'rh-msgs' }, warns, notes, paste), ctx.outputs)));

  // ---------- loading ----------
  async function load() {
    st.busy = true; st.msg = 'Reading the notes…'; st.tone = ''; drawBar();
    try {
      const got = await Promise.all(['/api/revisions', '/api/revisions?archived=true'].map(async (u) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error(`${u} answered ${r.status}`);
        return r.json();
      }));
      const byId = new Map();
      for (const list of got) for (const x of Array.isArray(list) ? list : []) byId.set(x.id ?? x._id, compact(x));
      const list = [...byId.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      st.loaded = true; st.busy = false; st.at = new Date();
      st.msg = list.length ? `${list.length} notes from the app` : 'The app has no notes yet'; st.tone = list.length ? 'ok' : 'warn';
      if (list.length) ctx.set('notes', '[' + list.map((n) => JSON.stringify(n)).join(',\n') + ']');
      else drawBar();
    } catch (e) {
      st.loaded = true; st.busy = false;
      st.msg = `Could not reach the notes (${String(e.message || e).replace(/^\/api\/revisions /, '')}): using the notes below`; st.tone = 'bad';
      drawBar();
    }
  }
  loadBtn.addEventListener('click', load);

  function drawBar() {
    const hs = H();
    loadBtn.disabled = st.busy || !served();
    loadBtn.textContent = st.busy ? 'Loading…' : st.loaded ? 'Reload notes' : 'Load notes';
    loadBtn.title = served() ? 'Read every note from the app (open and archived)' : 'Open the tool in the app to load its notes';
    loadMsg.textContent = served() ? (st.msg + (st.at ? ` · ${st.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''))
      : 'Opened as a file: the example notes, or paste yours below';
    loadMsg.className = `rh-msg ${st.tone}`;
    const room = ctx.raw.room || 'all', mode = ctx.raw.by || 'auto';
    const rc = hs?.rooms || {};
    const total = Object.values(rc).reduce((a, b) => a + b, 0);
    roomSeg.replaceChildren(...ROOMS.filter(([v]) => v === 'all' || v === room || rc[v]).map(([v, t]) => {
      const n = v === 'all' ? total : rc[v] || 0;
      return h('button', { type: 'button', 'aria-pressed': String(room === v), onclick: () => ctx.set('room', v) }, t, n ? h('small', {}, ` ${n}`) : null);
    }));
    modeSeg.replaceChildren(...MODES.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(mode === v), onclick: () => ctx.set('by', v) }, t)));
    radBox.hidden = !(mode === 'auto' || mode === 'place');
    if (document.activeElement !== radIn) radIn.value = ctx.raw.radius ?? '';
    if (document.activeElement !== minIn) minIn.value = ctx.raw.min ?? '';
    radIn.classList.toggle('bad', !(ctx.input.radius > 0));
  }

  // ---------- time axis: days with notes, each a band ----------
  function timeAxis(areas, x0, x1) {
    const ts = [];
    for (const a of areas) for (const n of a.notes) { const t = ms(n.created); if (t != null) ts.push([t, n.created.slice(0, 10)]); }
    if (!ts.length) return { x: () => (x0 + x1) / 2, bands: [] };
    const byDay = new Map();
    for (const [t, d] of ts) { const b = byDay.get(d) || [Infinity, -Infinity]; b[0] = Math.min(b[0], t); b[1] = Math.max(b[1], t); byDay.set(d, b); }
    const days = [...byDay.keys()].sort();
    const GAP = days.length > 1 ? 18 : 0;
    if (days.length > 24) {       // many days: plain linear time over the whole span
      const lo = Math.min(...ts.map((t) => t[0])), hi = Math.max(...ts.map((t) => t[0]));
      const span = Math.max(hi - lo, 1);
      const x = (t) => x0 + ((t - lo) / span) * (x1 - x0);
      return { x, linear: true, bands: [{ day: days[0], x0, x1, last: days.at(-1) }] };
    }
    const bw = (x1 - x0 - GAP * (days.length - 1)) / days.length;
    const bands = days.map((d, i) => {
      const [lo, hi] = byDay.get(d);
      const pad = Math.max((hi - lo) * 0.12, 10 * 60000);
      return { day: d, x0: x0 + i * (bw + GAP), x1: x0 + i * (bw + GAP) + bw, lo: lo - pad, hi: hi + pad };
    });
    const at = new Map(bands.map((b) => [b.day, b]));
    const x = (t, d) => { const b = at.get(d); if (!b) return x0; return b.x0 + ((t - b.lo) / (b.hi - b.lo)) * (b.x1 - b.x0); };
    return { x, bands };
  }

  // ---------- strata ----------
  const TOP = 44;
  let LANE = 34;
  function shown(hs) {
    const hot = hs.areas.filter((a) => a.hot);
    const cold = hs.areas.filter((a) => !a.hot);
    const coldShow = cold.slice(0, Math.max(4, 10 - hot.length));
    const list = [...hot, ...coldShow];
    const f = hs.areas.find((a) => a.key === hs.focus);
    if (f && !list.includes(f)) list.push(f);
    return { list, hidden: cold.length - coldShow.length - (f && !f.hot && !coldShow.includes(f) ? 1 : 0), hotN: hot.length };
  }

  function drawStrata(hs) {
    svg.replaceChildren();
    const W = Math.max(300, Math.round(stage.clientWidth || 800));
    const narrow = W < 560;
    if (!hs) {
      svg.setAttribute('viewBox', `0 0 ${W} 120`); svg.setAttribute('height', 120);
      svg.append(sv('text', { x: W / 2, y: 64, class: 'rh-lbl b', 'text-anchor': 'middle' }, 'No notes to show: load them from the app, or paste a JSON list below'));
      legend.replaceChildren(); return;
    }
    const { list, hidden, hotN } = shown(hs);
    // Wide: the area's name left of its lane. Narrow: the name on a line of
    // its own above the marks, so neither is squeezed.
    const LW = narrow ? 30 : Math.round(clamp(W * 0.27, 170, 270));
    const x0 = LW + (narrow ? 8 : 16), x1 = W - 14;
    const rows0 = list.length;
    LANE = narrow ? 46 : clamp(Math.floor(330 / Math.max(1, rows0)), 34, 52);
    const ax = timeAxis(list, x0, x1);
    const rows = list.length;
    const DG = rows > hotN ? 16 : 0;             // room for the threshold line
    const top = (i) => TOP + i * LANE + (i >= hotN ? DG : 0);
    const divY = TOP + hotN * LANE + DG / 2;
    const Hh = TOP + rows * LANE + DG + (hidden > 0 ? 22 : 8) + 8;
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`); svg.setAttribute('height', Hh);
    const defs = sv('defs');
    const mk = sv('marker', { id: 'rh-head', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    mk.append(sv('path', { d: 'M0,1 L9,5 L0,9 z', class: 'rh-arrowhead' }));
    defs.append(mk); svg.append(defs);

    // day bands + axis
    const gAx = sv('g');
    ax.bands.forEach((b, i) => {
      gAx.append(sv('rect', { x: b.x0, y: TOP - 6, width: b.x1 - b.x0, height: rows * LANE + DG + 10, class: `rh-band${i % 2 ? ' alt' : ''}` }));
      // Day names as wide as the band allows: "Sep 21", else the day alone (the month once).
      const bw = b.x1 - b.x0 + 18;
      const newMonth = i === 0 || ax.bands[i - 1].day.slice(5, 7) !== b.day.slice(5, 7);
      const lbl = ax.linear ? `${dayLabel(b.day)} → ${dayLabel(b.last)}`
        : bw >= 46 ? dayLabel(b.day) : bw >= 14 ? String(+b.day.slice(8, 10)) : '';
      if (lbl) gAx.append(sv('text', { x: b.x0 + 1, y: 16, class: 'rh-day' }, lbl));
      if (!ax.linear && bw < 46 && newMonth && bw >= 14) gAx.append(sv('text', { x: b.x0 + 1, y: 28, class: 'rh-tick' }, MON[+b.day.slice(5, 7) - 1]));
      if (!ax.linear && b.x1 - b.x0 > 70) {     // hour ticks inside a wide day (UTC, as the notes are)
        const step = 3600000 * (b.hi - b.lo > 8 * 3600000 ? 3 : 1);
        let n = 0;
        const tick = (t, x) => {
          gAx.append(sv('line', { x1: x, x2: x, y1: TOP - 10, y2: TOP - 6, class: 'rh-tickl' }),
            sv('text', { x, y: TOP - 13, class: 'rh-tick', 'text-anchor': 'middle' }, new Date(t).toISOString().slice(11, 16)));
          n++;
        };
        let lastX = -Infinity;
        for (let t = Math.ceil(b.lo / step) * step; t <= b.hi; t += step) {
          const x = ax.x(t, b.day);
          if (x >= b.x0 + 22 && x <= b.x1 - 22 && x - lastX > 40) { tick(t, x); lastX = x; }
        }
        if (!n) { const t = (b.lo + b.hi) / 2; tick(t, ax.x(t, b.day)); }   // a short burst: its time
      }
      if (i > 0) {
        const pb = ax.bands[i - 1];
        const gapD = Math.round((Date.parse(b.day) - Date.parse(pb.day)) / 86400000);
        const gx = (pb.x1 + b.x0) / 2;
        gAx.append(sv('path', { d: `M${gx - 3},${TOP - 4} l6,-8 M${gx - 3},${TOP + 4} l6,-8`, class: 'rh-break' }));
        if (gapD > 1 && b.x0 - pb.x1 >= 16) gAx.append(sv('text', { x: gx, y: 30, class: 'rh-gap', 'text-anchor': 'middle' }, `+${gapD - 1}d`));
      }
    });
    if (!narrow) gAx.append(sv('text', { x: 4, y: 16, class: 'rh-lbl b' }, 'Area'),
      sv('text', { x: LW - 2, y: 16, class: 'rh-tick', 'text-anchor': 'end' }, 'notes'));
    svg.append(gAx);

    // lanes
    const gL = sv('g');
    const gArcs = sv('g');
    const gMarks = sv('g');
    const room = hs.room === 'all';
    const chars = narrow ? Math.floor((W - 20) / 6.6) : Math.floor((LW - (room ? 50 : 32)) / 6.4);
    list.forEach((a, i) => {
      const yc = top(i) + LANE / 2;
      const y = narrow ? yc + 8 : yc;           // the marks' line
      const ty = narrow ? yc - 9 : yc + 4;      // the name's baseline
      const isF = a.key === hs.focus;
      const lane = sv('g', { class: `rh-lane${isF ? ' is-f' : ''}${a.hot ? '' : ' cold'}`, tabindex: 0, role: 'button', 'data-i': i,
        'aria-label': `${a.key}: ${a.count} notes, ${a.applied} applied, ${a.rejected} rejected, ${a.open} open, ${a.back} came back. Enter shows its story.` });
      lane.append(sv('rect', { x: 0, y: yc - LANE / 2 + 1, width: W, height: LANE - 2, class: 'rh-lanebg', rx: 3 }));
      const split = a.key.match(/^(.*?)( › | @ )(.*)$/);
      const t = sv('text', { x: 6, y: ty, class: 'rh-name' });
      const roomTag = room ? (a.notes[0]?.room || '').slice(0, 3).toUpperCase() : '';
      if (roomTag) { t.append(sv('tspan', { class: 'rh-room' }, roomTag + ' ')); }
      if (split) {
        const tail = split[2] === ' @ ' ? `@ ${split[3]}` : split[3];
        const head = trunc(split[1], Math.max(4, chars - tail.length - 2));
        t.append(sv('tspan', { class: 'rh-model' }, head + ' '), sv('tspan', { class: 'rh-part' }, trunc(tail, Math.max(6, chars - head.length - 1))));
      } else t.append(sv('tspan', { class: 'rh-part' }, trunc(a.key, chars)));
      t.append(sv('title', {}, a.key));
      lane.append(t);
      lane.append(sv('text', { x: LW - 2, y: y + 4, class: `rh-count${a.back ? ' back' : ''}`, 'text-anchor': 'end' }, a.count));
      gL.append(lane);

      // lifespan line
      const xs = a.notes.map((n) => { const tt = ms(n.created); return tt == null ? x1 - 4 : ax.x(tt, n.created.slice(0, 10)); });
      if (xs.length > 1) gL.append(sv('line', { x1: Math.min(...xs), x2: Math.max(...xs), y1: y, y2: y, class: 'rh-life' }));
      // came-back arcs: from the last applied note before each "back" note
      let lastAp = null;
      a.notes.forEach((n, j) => {
        if (n.back && lastAp != null) {
          const xa = xs[lastAp], xb = xs[j];
          const lift = narrow ? 5 : clamp(Math.abs(xb - xa) * 0.35, 9, LANE / 2 - 2);
          const d = Math.abs(xb - xa) < 3 ? `M${xa},${y - 7} q7,${-lift - 4} ${xb - xa + 0.1},${-7 + 7}` : `M${xa},${y - 6} Q${(xa + xb) / 2},${y - 6 - lift * 2} ${xb},${y - 7}`;
          gArcs.append(sv('path', { d, class: 'rh-arc', 'marker-end': 'url(#rh-head)' }));
        }
        if (n.status === 'applied') lastAp = j;
      });
      // marks (spread notes that land on the same pixel)
      const used = [];
      a.notes.forEach((n, j) => {
        let x = xs[j];
        while (used.some((u) => Math.abs(u - x) < 7)) x += 7;
        used.push(x);
        const k = kindOf(n.status);
        const g = sv('g', { class: `rh-mark ${k}${n.back ? ' back' : ''}${st.pick === n.id && isF ? ' pick' : ''}`, transform: `translate(${x} ${y})`, 'data-a': i, 'data-n': j });
        g.append(sv('circle', { r: 11, class: 'hit' }));
        if (n.back) g.append(sv('circle', { r: 8.5, class: 'halo' }));
        if (k === 'rj') g.append(sv('circle', { r: 5.5, class: 'bg' }), sv('path', { d: 'M-4,-4 L4,4 M4,-4 L-4,4', class: 'x' }));
        else g.append(sv('circle', { r: 5, class: 'dot' }));
        gMarks.append(g);
      });
    });
    svg.append(gL, gArcs, gMarks);

    // threshold divider (drag or arrows to change "marked again at")
    if (rows) {
      const gd = sv('g', { class: `rh-div${st.drag ? ' dragging' : ''}`, tabindex: 0, role: 'slider', 'aria-label': 'Marked again at, notes',
        'aria-valuenow': hs.min, 'aria-valuemin': 2, 'aria-valuetext': `${hs.min} or more notes`, transform: `translate(0 ${st.drag ? st.drag.y : divY})` });
      gd.append(sv('rect', { x: 0, y: -7, width: W, height: 14, class: 'hit' }),
        sv('line', { x1: 0, x2: W, y1: 0, y2: 0, class: 'ln' }));
      const lab = `≥ ${st.drag ? st.drag.min : hs.min} notes: marked again ${hotN ? '↑' : '(none)'}   ·   marked less ↓`;
      const tw = Math.min(W - 16, lab.length * 6.1 + 18);
      gd.append(sv('rect', { x: W - tw - 8, y: -9, width: tw, height: 18, rx: 9, class: 'pill' }),
        sv('text', { x: W - 8 - tw / 2, y: 4, class: 'txt', 'text-anchor': 'middle' }, narrow ? `≥ ${st.drag ? st.drag.min : hs.min} notes ↑` : lab));
      svg.append(gd);
    }
    if (hidden > 0) svg.append(sv('text', { x: 6, y: TOP + rows * LANE + DG + 16, class: 'rh-tick' }, `+ ${hidden} more area${hidden === 1 ? '' : 's'} marked once (in the JSON output)`));

    const sw = sv('svg', { width: 30, height: 14, viewBox: '0 0 30 14', 'aria-hidden': 'true' });
    sw.append(sv('path', { d: 'M4,12 Q15,-2 26,11', class: 'rh-arc' }));
    legend.replaceChildren(
      li('ap', 'applied'), li('rj', 'rejected'), li('op', 'open (queued, draft)'),
      h('span', {}, sw, 'came back after an applied fix'),
      h('span', { class: 'rh-hint' }, narrow ? 'Tap a lane for its story' : 'Click a lane for its story · hover a mark for the note · drag the dashed line to change the threshold'));
  }
  const li = (k, t) => {
    const s = sv('svg', { width: 14, height: 14, viewBox: '-7 -7 14 14', 'aria-hidden': 'true' });
    const g = sv('g', { class: `rh-mark ${k}` });
    if (k === 'rj') g.append(sv('circle', { r: 5.5, class: 'bg' }), sv('path', { d: 'M-4,-4 L4,4 M4,-4 L-4,4', class: 'x' }));
    else g.append(sv('circle', { r: 5, class: 'dot' }));
    s.append(g);
    return h('span', {}, s, t);
  };

  // ---------- strata interaction ----------
  const areaAt = (i) => { const hs = H(); return hs ? shown(hs).list[i] : null; };
  const focusArea = (a, noteId = null) => { if (!a) return; st.pick = noteId; if (a.key !== H()?.focus) ctx.set('area', a.key); else render(ctx.result); };
  svg.addEventListener('click', (e) => {
    if (st.dragMoved) { st.dragMoved = false; return; }
    const m = e.target.closest('.rh-mark');
    if (m) { const a = areaAt(+m.dataset.a); focusArea(a, a?.notes[+m.dataset.n]?.id); return; }
    const l = e.target.closest('.rh-lane'); if (l) focusArea(areaAt(+l.dataset.i));
  });
  svg.addEventListener('keydown', (e) => {
    const l = e.target.closest('.rh-lane');
    if (l) {
      const i = +l.dataset.i;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.laneFocus = i; focusArea(areaAt(i)); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        svg.querySelector(`.rh-lane[data-i="${i + (e.key === 'ArrowDown' ? 1 : -1)}"]`)?.focus();
      }
      return;
    }
    if (e.target.closest('.rh-div')) {
      const hs = H(); if (!hs) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); ctx.set('min', String(hs.min + 1)); refocusDiv(); }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowLeft') && hs.min > 2) { e.preventDefault(); ctx.set('min', String(hs.min - 1)); refocusDiv(); }
    }
  });
  const refocusDiv = () => requestAnimationFrame(() => svg.querySelector('.rh-div')?.focus());
  const svgY = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()).y; };
  svg.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.rh-div')) return;
    const hs = H(); if (!hs) return;
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    st.drag = { y: svgY(e), min: hs.min, id: e.pointerId };
    st.dragMoved = false;
  });
  svg.addEventListener('pointermove', (e) => {
    if (st.drag && e.pointerId === st.drag.id) {
      const hs = H(); const { list } = shown(hs);
      const y = clamp(svgY(e), TOP, TOP + list.length * LANE);
      // lanes above the line are "marked again": the threshold is the smallest count among them
      const k = Math.round((y - TOP) / LANE);
      const above = list.slice(0, k);
      const next = list[k];
      let min = above.length ? Math.min(...above.map((a) => a.count)) : (list[0] ? list[0].count + 1 : hs.min);
      if (!above.length && next) min = next.count + 1;
      st.drag.y = y; st.drag.min = Math.max(2, min); st.dragMoved = true;
      drawStrata(hs);
      return;
    }
    const m = e.target.closest?.('.rh-mark');
    if (m) showTip(m); else hideTip();
  });
  const endDrag = (e) => {
    if (!st.drag || e.pointerId !== st.drag.id) return;
    const min = st.drag.min; st.drag = null;
    if (st.dragMoved && String(min) !== String(ctx.raw.min)) ctx.set('min', String(min)); else drawStrata(H());
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', () => { if (!st.drag) hideTip(); });

  function showTip(m) {
    const a = areaAt(+m.dataset.a); const n = a?.notes[+m.dataset.n];
    if (!n) return hideTip();
    tip.replaceChildren(
      h('div', { class: 'rh-tt' }, h('span', { class: `rh-pill ${kindOf(n.status)}` }, n.status), n.back ? h('span', { class: 'rh-pill back' }, 'came back') : null,
        h('span', { class: 'm' }, `${n.created ? n.created.slice(0, 10) + ' ' + hm(n.created) : 'no date'}`)),
      h('div', {}, n.text || '(no text)'),
      h('div', { class: 'soft m' }, `${n.id || '–'} · ${a.key}`));
    tip.style.display = 'block';
    const sr = stage.getBoundingClientRect(), gr = m.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = gr.left - sr.left + gr.width / 2 - tw / 2, y = gr.top - sr.top - th - 6;
    if (y < 2) y = gr.bottom - sr.top + 6;
    x = clamp(x, 4, Math.max(4, sr.width - tw - 4));
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  function hideTip() { tip.style.display = 'none'; }

  // ---------- focus: spot map + story ----------
  function drawFocus(hs) {
    const a = hs && hs.areas.find((x) => x.key === hs.focus);
    if (!a) {
      fHead.replaceChildren(h('h2', {}, 'Story'), h('span', { class: 'rh-sub' }, hs ? 'Click a lane to read its notes in order.' : ''));
      spot.replaceChildren(); story.replaceChildren(); return;
    }
    const first = a.notes[0]?.created, last = a.notes.at(-1)?.created;
    fHead.replaceChildren(
      h('div', { class: 'rh-ftitle' }, h('h2', { title: a.key }, a.key)),
      h('div', { class: 'rh-fstats' },
        h('span', {}, h('b', {}, a.count), ' notes'),
        h('span', { class: 'ap' }, h('b', {}, a.applied), ' applied'),
        h('span', { class: 'rj' }, h('b', {}, a.rejected), ' rejected'),
        h('span', { class: 'op' }, h('b', {}, a.open), ' open'),
        h('span', { class: a.back ? 'bk' : '' }, h('b', {}, a.back), ' came back'),
        first ? h('span', { class: 'soft' }, `${dayLabel(first.slice(0, 10))} ${hm(first)} → ${last && last.slice(0, 10) !== first.slice(0, 10) ? dayLabel(last.slice(0, 10)) + ' ' : ''}${hm(last)}`) : null));
    drawSpot(hs, a);
    // story
    const imgs = served() && st.at;
    story.replaceChildren(...a.notes.map((n, j) => {
      const prev = j ? ms(a.notes[j - 1].created) : null, t = ms(n.created);
      const gap = j && prev != null && t != null ? since(prev, t) : '';
      const k = kindOf(n.status);
      const li2 = h('li', { class: `rh-note ${k}${n.back ? ' back' : ''}${st.pick === n.id ? ' pick' : ''}`, 'data-id': n.id || '' },
        gap ? h('div', { class: 'rh-gap2' }, gap) : null,
        h('div', { class: 'rh-nrow' },
          h('span', { class: 'rh-when m' }, n.created ? `${dayLabel(n.created.slice(0, 10))} ${hm(n.created)}` : 'no date'),
          h('span', { class: `rh-pill ${k}` }, n.status),
          n.back ? h('span', { class: 'rh-pill back', title: 'An earlier note on this area was already applied' }, 'came back') : null,
          h('span', { class: 'rh-id m' }, n.id || '–')),
        h('div', { class: 'rh-text' }, n.text || '(no text)'),
        imgs && n.id ? (() => {
          const img = h('img', { src: `/api/revisions/${encodeURIComponent(n.id)}/image`, alt: `Drawing of ${n.id}`, loading: 'lazy', class: 'rh-shot' });
          img.addEventListener('error', () => img.remove());
          return img;
        })() : null);
      return li2;
    }));
    if (st.pick) story.querySelector(`.rh-note.pick`)?.scrollIntoView({ block: 'nearest' });
  }

  // Top view (x, z) of the camera targets of the focused area's model.
  function drawSpot(hs, a) {
    spot.replaceChildren();
    if (!a.seed || !(hs.mode === 'auto' || hs.mode === 'place')) {
      if (hs.mode !== 'model' && a.part) spot.append(h('div', { class: 'rh-spotnote' }, `Grouped by the part name "${a.part}" - the camera spot is not needed.`));
      return;
    }
    const mates = hs.areas.filter((x) => x.model === a.model && x.seed);
    const pts = [];
    for (const x of mates) for (const n of x.notes) if (n.target) pts.push({ n, area: x });
    const all = [...pts.map((p) => p.n.target), ...mates.map((m) => m.seed)];
    const R = hs.radius;
    let lx = Math.min(...all.map((p) => p[0])) - R, hx = Math.max(...all.map((p) => p[0])) + R;
    let lz = Math.min(...all.map((p) => p[2])) - R, hz = Math.max(...all.map((p) => p[2])) + R;
    const W = 320, Hh = 210, P = 22;
    const s = Math.min((W - 2 * P) / (hx - lx || 1), (Hh - 2 * P) / (hz - lz || 1));
    const cx = (W - (hx - lx) * s) / 2, cz = (Hh - (hz - lz) * s) / 2;
    const X = (v) => cx + (v - lx) * s, Z = (v) => cz + (v - lz) * s;
    const svg2 = sv('svg', { class: 'rh-map', viewBox: `0 0 ${W} ${Hh}`, role: 'group', 'aria-label': `Camera spots of ${a.model}, seen from above` });
    // grid every 10/20/50 mm
    const step = [5, 10, 20, 50, 100, 200, 500].find((g) => g * s >= 26) || 1000;
    for (let v = Math.ceil(lx / step) * step; v <= hx; v += step) svg2.append(sv('line', { x1: X(v), x2: X(v), y1: 0, y2: Hh, class: 'rh-grid' }));
    for (let v = Math.ceil(lz / step) * step; v <= hz; v += step) svg2.append(sv('line', { x1: 0, x2: W, y1: Z(v), y2: Z(v), class: 'rh-grid' }));
    // scale bar
    svg2.append(sv('line', { x1: 8, x2: 8 + step * s, y1: Hh - 8, y2: Hh - 8, class: 'rh-scale' }),
      sv('text', { x: 10 + step * s, y: Hh - 5, class: 'rh-tick' }, `${step} mm`),
      sv('text', { x: W - 6, y: 12, class: 'rh-tick', 'text-anchor': 'end' }, 'top view · x →  z ↓'));
    for (const m of mates) {
      const isF = m.key === a.key;
      svg2.append(sv('circle', { cx: X(m.seed[0]), cy: Z(m.seed[2]), r: Math.max(2, R * s), class: `rh-zone${isF ? ' is-f' : ''}` }));
    }
    for (const p of pts) {
      const k = kindOf(p.n.status);
      const g = sv('g', { class: `rh-mark ${k}${p.n.back ? ' back' : ''}${p.area.key === a.key ? '' : ' other'}`, transform: `translate(${X(p.n.target[0])} ${Z(p.n.target[2])})` });
      if (p.n.back) g.append(sv('circle', { r: 7.5, class: 'halo' }));
      if (k === 'rj') g.append(sv('circle', { r: 4.5, class: 'bg' }), sv('path', { d: 'M-3,-3 L3,3 M3,-3 L-3,3', class: 'x' }));
      else g.append(sv('circle', { r: 4, class: 'dot' }));
      g.append(sv('title', {}, `${p.n.id}: ${p.n.text} (${p.n.status})`));
      g.addEventListener('click', () => focusArea(p.area, p.n.id));
      svg2.append(g);
    }
    // radius handle on the focused circle
    // The handle sits on the rim, up and to the right (off the axis, where spots tend to line up).
    const ANG = -Math.PI / 5, ca = Math.cos(ANG), sa = Math.sin(ANG);
    const ox0 = X(a.seed[0]), oy0 = Z(a.seed[2]);
    const hxp = ox0 + R * s * ca, hyp = oy0 + R * s * sa;
    const handle = sv('g', { class: 'rh-handle', tabindex: 0, role: 'slider', 'aria-label': 'Nearby within, mm', 'aria-valuenow': R, 'aria-valuetext': `${R} mm` });
    handle.append(sv('line', { x1: ox0, x2: hxp, y1: oy0, y2: hyp, class: 'rh-rline' }),
      sv('circle', { cx: hxp, cy: hyp, r: 12, class: 'hit' }), sv('rect', { x: hxp - 5, y: hyp - 5, width: 10, height: 10, rx: 2, class: 'knob' }),
      sv('text', { x: (ox0 + hxp) / 2 - 4, y: (oy0 + hyp) / 2 - 5, class: 'rh-rlab', 'text-anchor': 'end' }, `${R} mm`));
    svg2.append(handle);
    const setR = (v) => ctx.set('radius', String(Math.round(clamp(v, 1, 5000))));
    handle.addEventListener('keydown', (e) => {
      const d = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setR(R + d); requestAnimationFrame(() => spot.querySelector('.rh-handle')?.focus()); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setR(R - d); requestAnimationFrame(() => spot.querySelector('.rh-handle')?.focus()); }
    });
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const ox = ox0, oy = oy0;
      const rl = handle.querySelector('.rh-rline'), kb = handle.querySelector('.knob'), lab = handle.querySelector('.rh-rlab');
      const zone = svg2.querySelector('.rh-zone.is-f');
      let val = R;
      const mv = (ev) => {
        const p = svg2.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY;
        const q = p.matrixTransform(svg2.getScreenCTM().inverse());
        val = Math.max(1, Math.round(Math.hypot(q.x - ox, q.y - oy) / s));
        const px = ox + val * s * ca, py = oy + val * s * sa;
        zone.setAttribute('r', val * s); rl.setAttribute('x2', px); rl.setAttribute('y2', py);
        kb.setAttribute('x', px - 5); kb.setAttribute('y', py - 5);
        lab.setAttribute('x', (ox + px) / 2 - 4); lab.setAttribute('y', (oy + py) / 2 - 5); lab.textContent = `${val} mm`;
      };
      const up = () => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); setR(val); };
      handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });
    spot.append(h('div', { class: 'rh-spothead' }, h('b', {}, `Camera spots on ${a.model}`),
      h('span', { class: 'soft' }, `${mates.length} spot${mates.length === 1 ? '' : 's'} · drag the square to change "within"`)), svg2,
    h('div', { class: 'rh-spotnote' }, 'Distances are 3-D; the view is from above, so two spots can look closer than they are.'));
  }

  // ---------- render ----------
  function render(res) {
    const hs = res?.history || null;
    drawBar();
    const v = Object.fromEntries((res?.values || []).map((x) => [x.label, x]));
    summary.replaceChildren(...(hs ? [
      h('span', {}, h('b', {}, v.Notes?.value ?? 0), ' notes in ', h('b', {}, v.Areas?.value ?? 0), ' areas'),
      h('span', {}, h('b', {}, v['Marked again']?.value ?? 0), ' marked again (', v['Notes in them']?.value ?? '–', ' of notes)'),
      h('span', { class: v['Came back']?.value ? 'bk' : 'okc' }, h('b', {}, v['Came back']?.value ?? 0), ' came back after a fix'),
      h('span', { class: 'soft' }, `${v.Applied?.value ?? '–'} applied (${v.Applied?.hint || ''})`)] : []));
    drawStrata(hs);
    drawFocus(hs);
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res?.warnings || []).length;
    notes.replaceChildren(...(res?.notes || []).map((w) => h('div', {}, w)));
    if (!hs) paste.open = true;
    if (st.laneFocus != null) { const i = st.laneFocus; st.laneFocus = null; requestAnimationFrame(() => svg.querySelector(`.rh-lane[data-i="${i}"]`)?.focus()); }
  }

  let lastW = 0;
  new ResizeObserver(() => { const w = stage.clientWidth; if (Math.abs(w - lastW) > 2) { lastW = w; drawStrata(H()); } }).observe(stage);
  ctx.onResult((res) => render(res));
  if (served()) load();
}
