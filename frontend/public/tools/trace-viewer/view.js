// Conversation & Agent Trace Viewer, custom page. The run itself is the interface:
//   Context  - a stacked area of what the context holds after each turn
//              (system, user, assistant text, tool calls, tool results;
//              estimated), the measured context of every model call as a
//              line where the trace has usage, and the spikes marked. Click or
//              drag on it (or arrow keys) to move to a turn.
//   Timeline - every turn in order: user, assistant, tool. An assistant turn
//              shows its tool calls as cards (name, input, result size, error,
//              no result, loop). Click a turn to read it whole; arrows move.
//   Filter   - chips per tool name: show only the turns that call or answer
//              those tools.
//   Detail   - the selected turn's blocks in full, with its usage.
// Everything drawn comes from run()'s result.trace.

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
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtK = (n) => (n == null ? '–' : n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US'));
const LAYERS = [['system', 'System'], ['user', 'User'], ['assistant', 'Assistant text'], ['toolCalls', 'Tool calls'], ['toolResults', 'Tool results']];
const ROLE = { user: 'User', assistant: 'Assistant', tool: 'Tool result', system: 'System' };
const MAX_ROWS = 500;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

function preview(e) {
  const b = e.blocks.find((x) => x.type === 'text' && x.text.trim()) || e.blocks.find((x) => x.type === 'thinking') || e.blocks[0];
  if (!b) return '(empty)';
  return String(b.text ?? '').replace(/\s+/g, ' ').slice(0, 220);
}

export function page(root, ctx) {
  const KEY = 'redline.tool.trace-viewer.view';
  const saved = store.get(KEY) || {};
  let sel = saved.sel ?? 0;
  let filter = new Set(saved.filter || []);
  let showAll = false;
  let last = null;

  const wrap = h('div', { class: 'tv' });
  root.append(wrap);

  // ---------- stats + filter ----------
  const stats = h('div', { class: 'tv-stats', 'aria-live': 'polite' });
  const chips = h('div', { class: 'tv-chips', role: 'group', 'aria-label': 'Filter by tool' });
  const statCard = h('section', { class: 'tv-card tv-statcard' }, stats, chips);

  // ---------- chart ----------
  const chartBox = h('div', { class: 'tv-chartbox' });
  const chartLegend = h('div', { class: 'tv-legend' });
  const chartCard = h('section', { class: 'tv-card tv-chartcard' },
    h('div', { class: 'tv-head' }, h('h2', {}, 'Context by turn'), h('span', { class: 'tv-sub' }, 'area = estimated contents (characters / 4) · line = measured input of each model call'), chartLegend),
    chartBox);

  // ---------- timeline ----------
  const tl = h('ol', { class: 'tv-tl', tabindex: '0', role: 'listbox', 'aria-label': 'Turns: up and down arrows move, Home and End jump' });
  const tlInfo = h('span', { class: 'tv-sub' });
  const tlCard = h('section', { class: 'tv-card tv-tlcard' }, h('div', { class: 'tv-head' }, h('h2', {}, 'Timeline'), tlInfo), tl);

  // ---------- detail ----------
  const detail = h('div', { class: 'tv-detail' });
  const detailCard = h('section', { class: 'tv-card tv-detailcard' }, detail);

  // ---------- input ----------
  const traceIn = h('textarea', { class: 'tv-ta', rows: 9, spellcheck: 'false', 'aria-label': 'Transcript', placeholder: 'Paste a transcript: JSON or JSONL',
    oninput: () => ctx.set('trace', traceIn.value) });
  const fmtSel = h('select', { class: 'tv-in', 'aria-label': 'Format', onchange: (e) => ctx.set('format', e.target.value) },
    [['auto', 'Detect'], ['anthropic', 'Anthropic Messages'], ['openai', 'OpenAI chat'], ['claude-code', 'Claude Code JSONL']].map(([v, t]) => h('option', { value: v }, t)));
  const num = (key, label, unit) => {
    const el = h('input', { class: 'tv-in tv-num', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': label, onchange: (e) => ctx.set(key, e.target.value) });
    return [el, h('label', { class: 'tv-lab' }, label, el, unit ? h('span', { class: 'tv-sub' }, unit) : null)];
  };
  const [bigIn, bigLab] = num('bigResult', 'Large from', 'tokens');
  const [loopIn, loopLab] = num('loopRepeat', 'Loop after', 'same calls');
  const priceIns = [['priceIn', 'Input'], ['priceOut', 'Output'], ['priceCacheRead', 'Cache read'], ['priceCacheWrite', 'Cache write']].map(([k, l]) => [k, ...num(k, l, '')]);
  const fileIn = h('input', { type: 'file', accept: '.json,.jsonl,.txt,application/json', class: 'tv-file', 'aria-label': 'Open a transcript file',
    onchange: async (e) => { const f = e.target.files?.[0]; if (f) ctx.set('trace', await f.text()); e.target.value = ''; } });
  const inCard = h('section', { class: 'tv-card tv-incard' },
    h('div', { class: 'tv-head' }, h('h2', {}, 'Transcript'), h('label', { class: 'k-btn tv-filebtn' }, 'Open file…', fileIn)),
    h('div', { class: 'tv-pad' }, traceIn,
      h('div', { class: 'tv-row' }, h('label', { class: 'tv-lab' }, 'Format', fmtSel), bigLab, loopLab),
      h('details', { class: 'tv-prices' }, h('summary', {}, 'Prices (USD per million tokens) - only when the trace has no cost'),
        h('div', { class: 'tv-row' }, ...priceIns.map((p) => p[2])),
        h('div', { class: 'tv-sub' }, 'Enter current prices from the provider\'s pricing page; nothing here is preset.'))));
  const warns = h('div', { class: 'tv-warns', 'aria-live': 'polite' });
  const notes = h('div', { class: 'tv-notes' });
  const out = h('div', { class: 'tv-out' }, ctx.outputs);

  const main = h('div', { class: 'tv-main' }, statCard, warns, chartCard, tlCard, notes);
  const side = h('div', { class: 'tv-side' }, detailCard, inCard, out);
  wrap.append(main, side);

  const save = () => store.set(KEY, { sel, filter: [...filter] });
  const matches = (tr, e) => {
    if (!filter.size) return true;
    return e.blocks.some((b) => (b.type === 'tool_use' || b.type === 'tool_result') && filter.has(b.name));
  };
  function select(i, scroll = true) {
    const n = last?.trace?.events.length || 0;
    if (!n) return;
    sel = clamp(i, 0, n - 1); save();
    drawTimelineSel(); drawDetail(); drawChart();
    if (scroll) tl.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- stats ----------
  function drawStats() {
    const r = last;
    stats.replaceChildren(...(r.values || []).map((v) => h('span', { class: `tv-stat${v.tone ? ` ${v.tone}` : ''}`, title: v.hint || '' },
      h('small', {}, v.label), h('b', {}, typeof v.value === 'number' ? fmtK(v.value) : String(v.value)), v.unit ? h('small', {}, ` ${v.unit}`) : null)));
    const tools = [...(r.trace?.tools || [])].sort((a, b) => b.calls - a.calls);
    chips.replaceChildren(h('span', { class: 'tv-sub' }, 'Tools'),
      h('button', { class: 'tv-chip', 'aria-pressed': String(!filter.size), onclick: () => { filter.clear(); save(); drawAll(); } }, 'all'),
      ...tools.map((t) => h('button', { class: `tv-chip${t.errors ? ' haserr' : ''}`, 'aria-pressed': String(filter.has(t.name)),
        title: `${t.calls} call(s)${t.errors ? `, ${t.errors} error(s)` : ''}; click to show only turns with this tool`,
        onclick: () => { if (filter.has(t.name)) filter.delete(t.name); else filter.add(t.name); save(); drawAll(); } },
      t.name, h('small', {}, ` ${t.calls}`), t.errors ? h('small', { class: 'bad' }, ` ${t.errors}✗`) : null)));
    if (!tools.length) chips.append(h('span', { class: 'tv-sub' }, 'no tool calls'));
  }

  // ---------- chart ----------
  let chartW = 700;
  function drawChart() {
    const tr = last?.trace;
    chartBox.replaceChildren();
    if (!tr || !tr.events.length) { chartBox.append(h('div', { class: 'tv-empty' }, 'No turns.')); return; }
    const n = tr.events.length;
    const W = Math.max(300, chartW), H = 190, L = 48, R = 12, T = 14, B = 24;
    const meas = tr.measured;
    const hid = tr.hidden || 0;
    const top = Math.max(1, ...tr.series.map((s) => s.total + hid), ...meas.filter((v) => v != null));
    const step = [1, 2, 5].flatMap((m) => [1, 10, 100, 1000, 10000, 100000, 1000000].map((p) => m * p)).sort((a, b) => a - b).find((s) => top / s <= 5) || 1e6;
    const ymax = Math.ceil(top / step) * step;
    const X = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
    const Y = (v) => T + (1 - v / ymax) * (H - T - B);
    const svg = sv('svg', { class: 'tv-chart', viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'slider',
      'aria-label': 'Context by turn: left and right arrows move the selected turn', 'aria-valuemin': 1, 'aria-valuemax': n, 'aria-valuenow': sel + 1 });
    for (let v = 0; v <= ymax + 1e-9; v += step) {
      svg.append(sv('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'g' }));
      svg.append(sv('text', { x: L - 6, y: Y(v) + 3, class: 'ax', 'text-anchor': 'end' }, fmtK(v)));
    }
    const every = Math.max(1, Math.ceil(n / ((W - L - R) / 42)));
    for (let i = 0; i < n; i += every) svg.append(sv('text', { x: X(i), y: H - 8, class: 'ax', 'text-anchor': 'middle' }, i + 1));
    // Stacked areas (step shape: a turn's content is there from that turn on).
    // What the calls measured but the trace does not contain (system prompt,
    // tool definitions): a band under the estimated contents.
    if (hid) svg.append(sv('rect', { x: X(0), y: Y(hid), width: X(n - 1) - X(0) || 1, height: Y(0) - Y(hid), class: 'ar hid' }));
    let base = tr.series.map(() => hid);
    for (const [k] of LAYERS) {
      const topv = tr.series.map((s, i) => base[i] + s[k]);
      if (topv.some((v, i) => v > base[i])) {
        let d = `M${X(0)},${Y(base[0])}`;
        topv.forEach((v, i) => { d += `L${X(i)},${Y(v)}`; });
        for (let i = n - 1; i >= 0; i--) d += `L${X(i)},${Y(base[i])}`;
        svg.append(sv('path', { d: `${d}Z`, class: `ar c-${k}` }));
      }
      base = topv;
    }
    // Filtered turns: ticks along the bottom.
    if (filter.size) tr.events.forEach((e, i) => { if (matches(tr, e)) svg.append(sv('rect', { x: X(i) - 1.5, y: H - B, width: 3, height: 4, class: 'ft' })); });
    // Measured line.
    const pts = meas.map((v, i) => (v != null ? [X(i), Y(v)] : null)).filter(Boolean);
    if (pts.length) {
      svg.append(sv('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(''), class: 'ml' }));
      for (const p of pts) svg.append(sv('circle', { cx: p[0], cy: p[1], r: 2.4, class: 'md' }));
    }
    // Spikes.
    const rows = [];                       // label rows: right edge of the last label in each
    for (const s of tr.spikes) {
      const x = X(s.turn), y = Y(tr.series[s.turn].total + hid);
      svg.append(sv('path', { d: `M${x - 5},${T - 2}L${x + 5},${T - 2}L${x},${T + 6}Z`, class: 'sp' }));
      svg.append(sv('line', { x1: x, x2: x, y1: T + 6, y2: y, class: 'spl' }));
      const text = `+${fmtK(s.added)} ${s.what}`;
      const tw = text.length * 6.2;
      const right = x > W - tw - 20;
      const x0 = right ? x - 7 - tw : x + 7;
      // Labels that would overlap go one row down.
      let row = rows.findIndex((endX) => x0 > endX + 6);
      if (row < 0) { row = rows.length; rows.push(0); }
      rows[row] = x0 + tw;
      svg.append(sv('text', { x: right ? x - 7 : x + 7, y: T + 5 + row * 12, class: 'spt', 'text-anchor': right ? 'end' : 'start' }, text));
    }
    // Selected turn.
    const sx = X(sel);
    svg.append(sv('line', { x1: sx, x2: sx, y1: T, y2: H - B, class: 'cur' }));
    const se = tr.series[sel], sm = meas[sel];
    const lab = `turn ${sel + 1}: ~${fmtK(se.total + hid)} est.${sm != null ? ` · ${fmtK(sm)} measured` : ''}`;
    const tx = sx > W - 190 ? sx - 6 : sx + 6;
    svg.append(sv('text', { x: tx, y: H - B - 6, class: 'curt', 'text-anchor': sx > W - 190 ? 'end' : 'start' }, lab));
    const hit = sv('rect', { x: L, y: 0, width: W - L - R, height: H, class: 'hit' });
    svg.append(hit);
    const pick = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * W;
      select(Math.round(((x - L) / (W - L - R)) * (n - 1)));
    };
    let drag = false;
    svg.addEventListener('pointerdown', (ev) => { drag = true; try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic */ } pick(ev); });
    svg.addEventListener('pointermove', (ev) => { if (drag) pick(ev); });
    svg.addEventListener('pointerup', () => { drag = false; });
    svg.addEventListener('keydown', (ev) => {
      const d = { ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10 }[ev.key];
      if (d) { ev.preventDefault(); select(sel + d); chartBox.querySelector('svg')?.focus(); }
      if (ev.key === 'Home') { ev.preventDefault(); select(0); chartBox.querySelector('svg')?.focus(); }
      if (ev.key === 'End') { ev.preventDefault(); select(n - 1); chartBox.querySelector('svg')?.focus(); }
    });
    chartBox.append(svg);
    chartLegend.replaceChildren(hid ? h('span', { title: 'measured input of the first call minus what the trace shows: system prompt and tool definitions' }, h('i', { class: 'sw hid' }), 'not in trace') : null, ...LAYERS.filter(([k]) => tr.series.some((s) => s[k] > 0)).map(([k, t]) => h('span', {}, h('i', { class: `sw c-${k}` }), t)),
      pts.length ? h('span', {}, h('i', { class: 'sw ml' }), 'measured') : null);
  }
  new ResizeObserver(() => {
    // The drawing is laid out for the box's inner width (clientWidth less the
    // 6 px padding each side) and scales with it, so it never widens the page.
    const w = Math.floor(chartBox.clientWidth - 12);
    if (w && Math.abs(w - chartW) > 4) { chartW = w; if (last) drawChart(); }
  }).observe(chartBox);

  // ---------- timeline ----------
  function toolCard(tr, b, e) {
    const call = tr.calls[b.call];
    const loop = call && tr.loops.find((l) => l.name === call.name && l.turns.includes(call.turn));
    const res = call?.result;
    const maxTok = Math.max(1, ...tr.calls.map((c) => c.result?.tok || 0));
    const w = res ? Math.max(2, (Math.log10(1 + res.tok) / Math.log10(1 + maxTok)) * 100) : 0;
    return h('div', { class: `tv-tool${res?.isError ? ' err' : ''}${!res ? ' nores' : ''}${res && res.tok >= tr.big ? ' big' : ''}` },
      h('span', { class: 'tv-tname' }, b.name),
      h('span', { class: 'tv-tin' }, call?.short ?? ''),
      h('span', { class: 'tv-tres' },
        res ? h('span', { class: 'tv-rbar', title: `result ~${res.tok} tokens (est.) in turn ${res.turn + 1}` }, h('i', { style: `width:${w.toFixed(1)}%` })) : null,
        res ? h('span', { class: 'tv-rtok' }, `${fmtK(res.tok)}`) : h('span', { class: 'tv-badge warn' }, 'no result'),
        res?.isError ? h('span', { class: 'tv-badge bad' }, 'error') : null,
        loop ? h('span', { class: 'tv-badge warn', title: `same input in turns ${loop.turns.map((t) => t + 1).join(', ')}` }, `repeat ×${loop.turns.length}`) : null));
  }
  function drawTimeline() {
    const tr = last?.trace;
    tl.replaceChildren();
    if (!tr || !tr.events.length) { tl.append(h('li', { class: 'tv-empty' }, 'Paste a transcript on the right.')); tlInfo.textContent = ''; return; }
    const spikeAt = new Map(tr.spikes.map((s) => [s.turn, s]));
    const rows = tr.events.filter((e) => matches(tr, e));
    const shown = showAll ? rows : rows.slice(0, MAX_ROWS);
    tlInfo.textContent = filter.size ? `${rows.length} of ${tr.events.length} turns use ${[...filter].join(', ')}` : `${tr.events.length} turns`;
    for (const e of shown) {
      const added = Object.values(e.cat).reduce((a, b) => a + b, 0);
      const sp = spikeAt.get(e.i);
      const u = e.usage;
      const meas = tr.measured[e.i];
      const tools = e.blocks.filter((b) => b.type === 'tool_use');
      const results = e.blocks.filter((b) => b.type === 'tool_result');
      const body = [];
      if (e.role === 'tool') {
        for (const b of results) body.push(h('div', { class: `tv-resline${b.isError ? ' err' : ''}` }, h('span', { class: 'tv-tname' }, b.name),
          h('span', { class: 'tv-prev' }, b.text.replace(/\s+/g, ' ').slice(0, 160)), b.isError ? h('span', { class: 'tv-badge bad' }, 'error') : null));
      } else {
        const p = preview(e);
        if (p && !(tools.length && !e.blocks.some((b) => b.type === 'text'))) body.push(h('div', { class: 'tv-prev' }, p));
        if (e.thinking) body.push(h('div', { class: 'tv-think' }, `thinking ~${fmtK(e.thinking)} tokens`));
        for (const b of tools) body.push(toolCard(tr, b, e));
      }
      tl.append(h('li', { class: `tv-turn r-${e.role}${e.i === sel ? ' sel' : ''}${sp ? ' spike' : ''}${e.side ? ' side' : ''}`, role: 'option', 'data-i': e.i,
        'aria-selected': String(e.i === sel), onclick: () => select(e.i, false) },
      h('div', { class: 'tv-gut' }, h('span', { class: 'tv-n' }, e.i + 1)),
      h('div', { class: 'tv-body' },
        h('div', { class: 'tv-line' }, h('span', { class: `tv-role r-${e.role}` }, ROLE[e.role] || e.role),
          e.compact ? h('span', { class: 'tv-badge' }, 'compacted') : null, e.side ? h('span', { class: 'tv-badge' }, 'sidechain') : null,
          sp ? h('span', { class: 'tv-badge warn', title: 'context spike' }, `spike +${fmtK(sp.added)}`) : null,
          h('span', { class: 'tv-tok', title: 'tokens this turn adds (estimated)' }, `+${fmtK(added)}`),
          meas != null ? h('span', { class: 'tv-meas', title: 'measured input of this model call (input + cache read + cache write)' }, `ctx ${fmtK(meas)}`) : null,
          u?.output != null && e.role === 'assistant' ? h('span', { class: 'tv-out-t', title: 'output tokens (measured)' }, `out ${fmtK(u.output)}`) : null),
        ...body)));
    }
    if (rows.length > shown.length) tl.append(h('li', { class: 'tv-more' }, h('button', { class: 'k-btn', onclick: () => { showAll = true; drawTimeline(); } }, `Show all ${rows.length} turns`)));
    if (!rows.length) tl.append(h('li', { class: 'tv-empty' }, 'No turn uses the selected tools.'));
  }
  function drawTimelineSel() {
    for (const li of tl.querySelectorAll('.tv-turn')) {
      const on = Number(li.dataset.i) === sel;
      li.classList.toggle('sel', on); li.setAttribute('aria-selected', String(on));
    }
  }
  tl.addEventListener('keydown', (ev) => {
    const tr = last?.trace; if (!tr) return;
    const vis = tr.events.filter((e) => matches(tr, e)).map((e) => e.i);
    if (!vis.length) return;
    const at = Math.max(0, vis.indexOf(sel));
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: vis.length - 1, PageDown: at + 10, PageUp: at - 10 }[ev.key];
    if (go == null) return;
    ev.preventDefault();
    select(vis[clamp(go, 0, vis.length - 1)]);
  });

  // ---------- detail ----------
  function drawDetail() {
    const tr = last?.trace;
    detail.replaceChildren();
    const e = tr?.events[sel];
    if (!e) { detail.append(h('div', { class: 'tv-empty' }, 'Select a turn.')); return; }
    const u = e.usage;
    detail.append(h('div', { class: 'tv-head' },
      h('h2', {}, `Turn ${e.i + 1} · ${ROLE[e.role] || e.role}`),
      e.ts ? h('span', { class: 'tv-sub' }, String(e.ts).replace('T', ' ').replace(/\.\d+Z$/, 'Z')) : null,
      h('span', { class: 'tv-nav' },
        h('button', { class: 'k-btn', 'aria-label': 'Previous turn', onclick: () => select(sel - 1) }, '‹'),
        h('button', { class: 'k-btn', 'aria-label': 'Next turn', onclick: () => select(sel + 1) }, '›'))));
    const facts = [];
    if (e.model) facts.push(['model', e.model]);
    if (u) {
      if (u.input != null) facts.push(['input', fmtK(u.input)]);
      if (u.cacheRead != null) facts.push(['cache read', fmtK(u.cacheRead)]);
      if (u.cacheWrite != null) facts.push(['cache write', fmtK(u.cacheWrite)]);
      if (u.output != null) facts.push(['output', fmtK(u.output)]);
      if (u.cost != null) facts.push(['cost', `$${u.cost.toFixed(4)}`]);
    }
    facts.push(['adds (est.)', fmtK(Object.values(e.cat).reduce((a, b) => a + b, 0))]);
    facts.push(['context after (est.)', fmtK(tr.series[e.i].total + (tr.hidden || 0))]);
    if (e.line) facts.push(['source line', e.line]);
    detail.append(h('dl', { class: 'tv-facts' }, facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    for (const b of e.blocks) {
      const head = b.type === 'tool_use' ? `tool call · ${b.name}` : b.type === 'tool_result' ? `result of ${b.name}${b.isError ? ' · error' : ''}` : b.type;
      detail.append(h('div', { class: `tv-block t-${b.type}${b.isError ? ' err' : ''}` },
        h('div', { class: 'tv-bhead' }, h('span', {}, head), h('span', { class: 'tv-sub' }, `${b.chars.toLocaleString('en-US')} chars · ~${fmtK(b.tok)} tokens`),
          b.type === 'tool_result' && b.call >= 0 ? h('button', { class: 'k-btn tv-jump', onclick: () => select(tr.calls[b.call].turn) }, 'to the call') : null,
          b.type === 'tool_use' && tr.calls[b.call]?.result ? h('button', { class: 'k-btn tv-jump', onclick: () => select(tr.calls[b.call].result.turn) }, 'to the result') : null),
        h('pre', { class: 'tv-pre' }, b.text || '(empty)')));
    }
    if (!e.blocks.length) detail.append(h('div', { class: 'tv-empty' }, 'No content.'));
  }

  // ---------- all ----------
  function drawAll() {
    if (!last) return;
    const tr = last.trace;
    if (tr && sel >= tr.events.length) sel = Math.max(0, tr.events.length - 1);
    drawStats(); drawChart(); drawTimeline(); drawDetail();
    const w = last.warnings || [];
    warns.replaceChildren(...w.map((t) => h('div', {}, t)));
    warns.hidden = !w.length;
    notes.replaceChildren(...(last.notes || []).map((t) => h('div', {}, t)));
    const raw = ctx.raw;
    if (document.activeElement !== traceIn) traceIn.value = raw.trace ?? '';
    fmtSel.value = raw.format || 'auto';
    if (document.activeElement !== bigIn) bigIn.value = raw.bigResult ?? '';
    if (document.activeElement !== loopIn) loopIn.value = raw.loopRepeat ?? '';
    for (const [k, el] of priceIns) if (document.activeElement !== el) el.value = raw[k] ?? '';
  }
  ctx.onResult((res) => { last = res; showAll = false; drawAll(); });
}
