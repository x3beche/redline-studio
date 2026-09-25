// Telemetry Mock page: the recorded trace is the interface.
//   Model line  - the signal model written out as an equation whose numbers
//                 you scrub (drag sideways, arrow keys, or type).
//   Trace       - the generated series over real time. On it, handles for the
//                 model: base level (left tab), the first crest (amplitude up
//                 and down, period sideways), the drift line's end and the
//                 random-walk funnel's end. Faults sit where they happen: the
//                 stuck run as a band you slide and stretch, the offset step
//                 as a line you slide with an arrow you pull, spikes as red
//                 dots, dropouts as ticks on the fault rail. Click the trace to
//                 put the lens there.
//   Lens        - about sixty samples around that point, one dot each, with
//                 the sensor's resolution steps as rules, the true value, the
//                 sample's time and value and its line in the output.
// Every value shown comes from run()'s result (result.drawing / values).

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
const MODEL_KEYS = ['base', 'amp', 'drift', 'wander', 'noise', 'quant'];
const SENSOR_SHORT = { temperature: 'Temp', humidity: 'Humidity', pressure: 'Pressure', battery: 'Battery', current: 'Current', co2: 'CO2', accel: 'Accel z', custom: 'Custom' };

// Time ticks: the step that gives about one label per ~100 px.
const TSTEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000].map((s) => s * 1000);
const pad2 = (v) => String(v).padStart(2, '0');

function niceStep(span, target) {
  const raw = span / Math.max(1, target), p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
// A scrub step about 1 % of the value's size (or of a reference when it is 0).
const scrubStep = (v, ref) => {
  const m = Math.abs(v) || Math.abs(ref) || 1;
  return 10 ** (Math.floor(Math.log10(m)) - 2);
};
const roundTo = (v, st) => {
  const d = Math.max(0, -Math.floor(Math.log10(st) + 1e-9));
  return Number((Math.round(v / st) * st).toFixed(Math.min(10, d)));
};

export function page(root, ctx) {
  const f = ctx.fmtNum;
  const byKey = Object.fromEntries(ctx.manifest.inputs.map((d) => [d.key, d]));
  let res = null, D = null;
  let lensK = null;          // sample the lens is centred on
  let pickK = null;          // sample picked in the lens
  let frozenY = null;        // y range held while dragging
  let dragging = false;

  // ---------------- scrubbable numbers ----------------
  // An input that is also a drag handle: drag sideways to change it, arrows to
  // step, or click and type. Blank = the preset (shown as placeholder).
  const scrubs = [];
  const scrub = (key, opts = {}) => {
    const inp = h('input', { class: `tm-scrub${opts.cls ? ' ' + opts.cls : ''}`, type: 'text', inputmode: 'decimal', spellcheck: 'false',
      'aria-label': opts.aria || byKey[key].label + (byKey[key].unit ? ` (${byKey[key].unit})` : ''), title: `${byKey[key].label}${byKey[key].help ? ' - ' + byKey[key].help : ''}. Drag sideways or use ↑ ↓ (Shift ×10); empty = ${opts.blank || 'preset'}.`,
      'data-key': key });
    const current = () => {
      const raw = String(ctx.raw[key] ?? '').trim();
      const v = raw === '' ? null : ctx.parseEng(raw);
      return v != null ? v : opts.eff ? opts.eff() : 0;
    };
    const stepOf = () => (opts.step ? opts.step(current()) : scrubStep(current(), opts.ref ? opts.ref() : 1));
    const put = (v) => {
      let x = opts.min != null ? Math.max(opts.min, v) : v;
      if (opts.max != null) x = Math.min(opts.max, x);
      ctx.set(key, String(roundTo(x, opts.int ? 1 : stepOf())));
    };
    inp.addEventListener('input', () => ctx.set(key, inp.value));
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      put(current() + (e.key === 'ArrowUp' ? 1 : -1) * stepOf() * (e.shiftKey ? 10 : 1));
    });
    inp.addEventListener('pointerdown', (e) => {
      if (document.activeElement === inp || e.button !== 0) return;
      const x0 = e.clientX, v0 = current(), st = stepOf();
      let moved = false, raf = 0, last = null;
      const move = (ev) => {
        const dx = ev.clientX - x0;
        if (!moved && Math.abs(dx) < 4) return;
        if (!moved) { moved = true; dragging = true; inp.classList.add('on'); }
        ev.preventDefault();
        last = v0 + Math.round(dx / 3) * st * (ev.shiftKey ? 10 : 1);
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (last != null) put(last); });
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        inp.classList.remove('on'); dragging = false;
        if (!moved) inp.focus(); else { frozenY = null; drawTrace(); }
      };
      e.preventDefault();
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    scrubs.push({ key, inp, opts });
    return inp;
  };
  const eff = (k) => () => (D ? D[k] : 0);
  const span = () => (D ? Math.max(Math.abs(D.amp) * 2, (D.hi ?? 0) - (D.lo ?? 0), Math.abs(D.base) * 0.02, 1e-3) : 1);

  // ---------------- sensor + recorder row ----------------
  const sensors = h('div', { class: 'tm-sensors', role: 'radiogroup', 'aria-label': 'Sensor preset' },
    byKey.sensor.options.map(([v, t]) => h('button', { role: 'radio', 'data-v': v, title: t,
      onclick: () => chooseSensor(v) }, SENSOR_SHORT[v] || t, h('small', {}, (/\(([^)]+)\)/.exec(t) || [])[1] || ''))));
  sensors.addEventListener('keydown', (e) => {
    const opts = byKey.sensor.options.map((o) => o[0]);
    const i = opts.indexOf(ctx.raw.sensor);
    const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (j == null) return;
    e.preventDefault();
    const v = opts[(j + opts.length) % opts.length];
    chooseSensor(v);
    requestAnimationFrame(() => sensors.querySelector(`[data-v="${v}"]`)?.focus());
  });
  const chooseSensor = (v) => {
    // A preset is its numbers: switching clears what was typed for the last one.
    const blank = Object.fromEntries(MODEL_KEYS.map((k) => [k, '']));
    ctx.setMany({ sensor: v, ...blank, field: '' });
  };
  const startInp = h('input', { class: 'tm-text', type: 'text', spellcheck: 'false', 'aria-label': 'Start time (UTC)', 'data-key': 'start',
    oninput: (e) => ctx.set('start', e.target.value) });
  const dur = h('span', { class: 'tm-dur' });
  const seedBtn = h('button', { class: 'k-btn', title: 'Next seed: a new series from the same model', onclick: () => ctx.set('seed', String((Math.round(ctx.input.seed || 0) + 1) >>> 0)) }, 'Reroll');
  const recorder = h('div', { class: 'tm-row' },
    h('span', { class: 'tm-cap' }, 'Record'),
    h('label', { class: 'tm-l' }, 'from', startInp),
    h('label', { class: 'tm-l' }, 'every', scrub('interval', { min: 0.001, step: (v) => (v >= 600 ? 60 : v >= 60 ? 10 : v >= 10 ? 1 : 0.1) }), 's'),
    h('label', { class: 'tm-l' }, '×', scrub('count', { int: true, min: 2, max: 20000, step: (v) => (v >= 2000 ? 100 : v >= 200 ? 10 : 1) }), 'samples'),
    dur,
    h('label', { class: 'tm-l' }, 'seed', scrub('seed', { int: true, min: 0, step: () => 1 })), seedBtn);

  // ---------------- model line ----------------
  const unitSpans = [];
  const U = () => { const s = h('span', { class: 'tm-u' }); unitSpans.push(s); return s; };
  const model = h('div', { class: 'tm-row tm-eq', 'aria-label': 'Signal model' },
    h('span', { class: 'tm-cap' }, 'Model'),
    h('span', { class: 'tm-t c-base' }, h('i', {}, 'x ='), scrub('base', { eff: eff('base'), ref: span, cls: 'c-base', aria: 'Base value' }), U()),
    h('span', { class: 'tm-t c-cyc' }, h('i', {}, '+'), scrub('amp', { eff: eff('amp'), ref: span, cls: 'c-cyc', aria: 'Cycle amplitude' }), h('i', {}, '· sin(2πt /'),
      scrub('period', { min: 0, step: (v) => (v >= 48 ? 1 : v >= 4 ? 0.25 : 0.05), cls: 'c-cyc', aria: 'Cycle period (h)' }), h('i', {}, 'h)')),
    h('span', { class: 'tm-t c-drift' }, h('i', {}, '+'), scrub('drift', { eff: eff('drift'), ref: () => span() / 100, cls: 'c-drift', aria: 'Drift per hour' }), U(), h('i', {}, '/h · t')),
    h('span', { class: 'tm-t c-walk' }, h('i', {}, '+ walk σ'), scrub('wander', { eff: eff('wander'), ref: () => span() / 50, min: 0, cls: 'c-walk', aria: 'Random walk, sigma per root hour' }), h('i', {}, '/√h')),
    h('span', { class: 'tm-t c-noise' }, h('i', {}, '+ noise σ'), scrub('noise', { eff: eff('noise'), ref: () => span() / 100, min: 0, cls: 'c-noise', aria: 'White noise sigma' })),
    h('span', { class: 'tm-t c-q' }, h('i', {}, '→ steps of'), scrub('quant', { eff: eff('quant'), ref: () => span() / 1000, min: 0, cls: 'c-q', aria: 'Resolution (LSB)' }), U()));

  // ---------------- fault line ----------------
  const faultsRow = h('div', { class: 'tm-row tm-faults', 'aria-label': 'Faults' },
    h('span', { class: 'tm-cap' }, 'Faults'),
    h('span', { class: 'tm-t c-spike' }, h('i', { class: 'sw' }), 'spikes', scrub('spikes', { min: 0, max: 50, step: () => 0.1, cls: 'c-spike' }), '%'),
    h('span', { class: 'tm-t c-drop' }, h('i', { class: 'sw' }), 'dropouts', scrub('dropouts', { min: 0, max: 50, step: () => 0.1, cls: 'c-drop' }), '%'),
    h('span', { class: 'tm-t c-stuck' }, h('i', { class: 'sw' }), 'stuck', scrub('stuck', { int: true, min: 0, step: (v) => (v >= 100 ? 10 : 1), cls: 'c-stuck' }), 'samples at',
      scrub('stuckAt', { min: 0, max: 99.9, step: () => 1, cls: 'c-stuck', blank: 'seeded', eff: () => (D && D.stuckAt >= 0 ? (D.stuckAt / D.n) * 100 : 50) }), '%'),
    h('span', { class: 'tm-t c-step' }, h('i', { class: 'sw' }), 'step', scrub('step', { ref: span, cls: 'c-step', step: () => scrubStep(0, span()) }), U(), 'at',
      scrub('stepAt', { min: 0, max: 99.9, step: () => 1, cls: 'c-step', blank: 'mid-series', eff: () => 50 }), '%'));

  // ---------------- trace ----------------
  const traceSvg = sv('svg', { class: 'tm-svg', role: 'group', 'aria-label': 'Generated series with model handles and faults' });
  const traceBox = h('div', { class: 'tm-tracebox' }, traceSvg);
  const traceHead = h('div', { class: 'tm-head' });
  const legend = h('div', { class: 'tm-legend' },
    h('span', {}, h('i', { class: 'lg-data' }), 'reported'), h('span', {}, h('i', { class: 'lg-truth' }), 'true value'),
    h('span', {}, h('i', { class: 'lg-model' }), 'model'), h('span', {}, h('i', { class: 'lg-walk' }), 'walk ±2σ'),
    h('span', {}, h('i', { class: 'lg-spike' }), 'spike'), h('span', {}, h('i', { class: 'lg-drop' }), 'dropout'), h('span', {}, h('i', { class: 'lg-stuck' }), 'stuck'));
  const warns = h('div', { class: 'tm-warns', role: 'status', 'aria-live': 'polite' });
  const traceCard = h('section', { class: 'tm-card tm-trace' }, traceHead, traceBox,
    h('div', { class: 'tm-help' }, 'Drag the handles: ', h('b', { class: 'c-base' }, 'base'), ' up and down, the ', h('b', { class: 'c-cyc' }, 'crest'),
      ' up (amplitude) and sideways (period), the ', h('b', { class: 'c-drift' }, 'drift'), ' and ', h('b', { class: 'c-walk' }, 'walk'), ' ends, the ',
      h('b', { class: 'c-stuck' }, 'stuck band'), ' (body and right edge) and the ', h('b', { class: 'c-step' }, 'step'),
      '. Click the trace to move the lens. Focused handle: arrow keys, ', h('kbd', {}, 'Shift'), ' for bigger steps.', legend));

  // ---------------- lens ----------------
  const lensSvg = sv('svg', { class: 'tm-svg tm-lenssvg', tabindex: 0, role: 'slider', 'aria-label': 'Lens: samples around the chosen point; arrow keys pick a sample' });
  const lensBox = h('div', { class: 'tm-lensbox' }, lensSvg);
  const lensHead = h('div', { class: 'tm-head' });
  const readout = h('div', { class: 'tm-read' });
  const lensCard = h('section', { class: 'tm-card tm-lens' }, lensHead, lensBox, readout);
  const notes = h('details', { class: 'tm-notes' });
  const fmtRow = h('div', { class: 'tm-fmt' },
    h('label', { class: 'tm-l' }, 'Format', h('select', { 'data-key': 'format', onchange: (e) => ctx.set('format', e.target.value) },
      byKey.format.options.map(([v, t]) => h('option', { value: v }, t)))),
    h('label', { class: 'tm-l' }, 'field', h('input', { class: 'tm-text short', type: 'text', spellcheck: 'false', 'data-key': 'field', oninput: (e) => ctx.set('field', e.target.value) })),
    h('label', { class: 'tm-l' }, 'device', h('input', { class: 'tm-text short', type: 'text', spellcheck: 'false', 'data-key': 'device', oninput: (e) => ctx.set('device', e.target.value) })));
  const outCol = h('div', { class: 'tm-outcol' }, h('section', { class: 'tm-card' }, fmtRow), ctx.outputs, notes);

  root.append(h('div', { class: 'tm' },
    h('section', { class: 'tm-card tm-controls' }, h('div', { class: 'tm-row tm-top' }, sensors, recorder), model, faultsRow),
    warns, traceCard,
    h('div', { class: 'tm-foot' }, lensCard, outCol)));

  // ---------------- trace drawing ----------------
  let geo = null; // the current mapping, for pointer handlers
  const timeLabel = (ms, step, first) => {
    const d = new Date(ms);
    const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    const date = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    if (step >= 86400000) return date;
    if (step < 60000) return `${hm}:${pad2(d.getUTCSeconds())}`;
    return first || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) ? `${date} ${hm}` : hm;
  };

  function yRange() {
    if (frozenY) return frozenY;
    const vals = [D.lo, D.hi, D.base, D.base + D.amp, D.base + D.drift * D.durH].filter((v) => v != null && Number.isFinite(v));
    for (let k = 0; k < D.n; k += Math.max(1, Math.floor(D.n / 400))) if (D.truth[k] != null) vals.push(D.truth[k]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const w = D.base + D.drift * D.durH;
    const fun = 2 * D.wander * Math.sqrt(Math.max(0, D.durH));
    lo = Math.min(lo, w - fun); hi = Math.max(hi, w + fun);
    if (!(hi > lo)) { const p = Math.abs(hi) * 0.05 || 1; lo -= p; hi += p; }
    const p = (hi - lo) * 0.1;
    return [lo - p, hi + p];
  }

  function drawTrace() {
    const had = traceSvg.contains(document.activeElement) ? document.activeElement.dataset.h : null;
    traceSvg.replaceChildren();
    const W = Math.max(300, traceBox.clientWidth || 900), H = Math.max(220, traceBox.clientHeight || 380);
    traceSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!D) { traceSvg.append(sv('text', { x: 16, y: 30 }, 'No series: see the message above.')); traceHead.replaceChildren(h('h2', {}, 'Trace')); geo = null; return; }
    const narrow = W < 560;
    const L = narrow ? 44 : 58, R = narrow ? 14 : 92, T = 16, B = 50;
    const pw = W - L - R, ph = H - T - B;
    const [ylo, yhi] = yRange();
    const X = (k) => L + (D.n <= 1 ? 0 : (k / (D.n - 1)) * pw);
    const Y = (v) => T + ph * (1 - (v - ylo) / (yhi - ylo));
    const Kof = (x) => clamp(Math.round(((x - L) / pw) * (D.n - 1)), 0, D.n - 1);
    const Vof = (y) => ylo + (1 - (y - T) / ph) * (yhi - ylo);
    const hours = (k) => (k * D.dt) / 3600;
    geo = { X, Y, Kof, Vof, L, R, T, B, W, H, pw, ph };

    // Grid and axes.
    const g = sv('g', { class: 'tm-grid' });
    const ys = niceStep(yhi - ylo, Math.max(3, Math.floor(ph / 46)));
    for (let v = Math.ceil(ylo / ys) * ys; v <= yhi; v += ys) {
      g.append(sv('line', { x1: L, x2: L + pw, y1: Y(v), y2: Y(v) }));
      g.append(sv('text', { x: L - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'ax' }, f(v, 6)));
    }
    const spanMs = (D.n - 1) * D.dt * 1000;
    const want = spanMs / Math.max(2, pw / (narrow ? 80 : 105));
    const tstep = TSTEPS.find((s) => s >= want) || TSTEPS[TSTEPS.length - 1];
    const t0 = D.t0, tEnd = D.t0 + spanMs;
    let first = true;
    for (let t = Math.ceil(t0 / tstep) * tstep; t <= tEnd; t += tstep) {
      const x = L + ((t - t0) / (spanMs || 1)) * pw;
      g.append(sv('line', { x1: x, x2: x, y1: T, y2: T + ph, class: 'v' }));
      g.append(sv('text', { x, y: T + ph + 14, 'text-anchor': 'middle', class: 'ax' }, timeLabel(t, tstep, first)));
      first = false;
    }
    g.append(sv('rect', { x: L, y: T, width: pw, height: ph, class: 'frame' }));
    traceSvg.append(g);
    if (D.unit) traceSvg.append(sv('text', { x: L - 6, y: T - 4, 'text-anchor': 'end', class: 'ax unit' }, D.unit));
    traceSvg.append(sv('text', { x: L + pw, y: H - 4, 'text-anchor': 'end', class: 'ax' }, 'UTC'));

    // Sensor range, where it is in view: beyond it values are clipped.
    if (D.range) for (const [lim, above] of [[D.range[1], true], [D.range[0], false]]) {
      if (lim < ylo || lim > yhi) continue;
      const y = Y(lim);
      traceSvg.append(sv('rect', { x: L, y: above ? T : y, width: pw, height: above ? y - T : T + ph - y, class: 'tm-clip' }));
      traceSvg.append(sv('text', { x: L + 4, y: above ? y + 12 : y - 4, class: 'ax warn' }, `sensor ${above ? 'max' : 'min'} ${f(lim, 6)} ${D.unit}${D.clipped ? ` · ${D.clipped} clipped` : ''}`));
    }

    // Lens window.
    const LW = 30;
    if (lensK != null) {
      const a = X(Math.max(0, lensK - LW)), b = X(Math.min(D.n - 1, lensK + LW));
      traceSvg.append(sv('rect', { x: a, y: T, width: Math.max(2, b - a), height: ph, class: 'tm-lenswin' }));
    }

    // Stuck band (under the data).
    const stuckG = sv('g');
    traceSvg.append(stuckG);

    // Data: a line when there is room, otherwise the min-max of each column.
    const cols = Math.max(1, Math.floor(pw));
    const rep = D.reported, tru = D.truth;
    if (D.n <= cols * 1.2) {
      let d = '', pen = false;
      for (let k = 0; k < D.n; k++) {
        const v = rep[k];
        if (v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${X(k).toFixed(1)},${Y(v).toFixed(1)}`; pen = true;
      }
      traceSvg.append(sv('path', { d, class: 'tm-data' }));
    } else {
      let top = '', bot = [];
      let dm = '';
      for (let c = 0; c < cols; c++) {
        const k0 = Math.floor((c / cols) * D.n), k1 = Math.max(k0 + 1, Math.floor(((c + 1) / cols) * D.n));
        let lo = Infinity, hi = -Infinity;
        for (let k = k0; k < k1; k++) { const v = rep[k]; if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (lo > hi) continue;
        const x = L + c + 0.5;
        top += `${top ? 'L' : 'M'}${x},${Y(hi).toFixed(1)}`;
        bot.push(`L${x},${Y(lo).toFixed(1)}`);
        dm += `M${x},${Y(hi).toFixed(1)}V${(Y(lo) + 0.8).toFixed(1)}`;
      }
      traceSvg.append(sv('path', { d: dm, class: 'tm-data cols' }));
    }
    // True value.
    {
      let d = '';
      const stepK = Math.max(1, Math.floor(D.n / cols));
      for (let k = 0; k < D.n; k += stepK) if (tru[k] != null) d += `${d ? 'L' : 'M'}${X(k).toFixed(1)},${Y(tru[k]).toFixed(1)}`;
      traceSvg.append(sv('path', { d, class: 'tm-truth' }));
    }

    // Model guides: base, drift line, walk funnel.
    const T_h = D.durH;
    const endV = D.base + D.drift * T_h;
    const fun = (k) => 2 * D.wander * Math.sqrt(hours(k));
    traceSvg.append(sv('line', { x1: L, x2: L + pw, y1: Y(D.base), y2: Y(D.base), class: 'tm-baseline' }));
    traceSvg.append(sv('line', { x1: L, x2: L + pw, y1: Y(D.base), y2: Y(endV), class: 'tm-driftline' }));
    if (D.wander > 0) {
      let up = '', dn = '';
      for (let i = 0; i <= 60; i++) {
        const k = (i / 60) * (D.n - 1), m = D.base + D.drift * hours(k);
        up += `${i ? 'L' : 'M'}${X(k).toFixed(1)},${Y(m + fun(k)).toFixed(1)}`;
        dn += `${i ? 'L' : 'M'}${X(k).toFixed(1)},${Y(m - fun(k)).toFixed(1)}`;
      }
      traceSvg.append(sv('path', { d: up + dn, class: 'tm-funnel' }));
    }

    // Faults: spikes as dots, the rail below the axis with every fault.
    const railY = T + ph + 24;
    traceSvg.append(sv('line', { x1: L, x2: L + pw, y1: railY, y2: railY, class: 'tm-rail' }));
    traceSvg.append(sv('text', { x: L - 6, y: railY + 4, 'text-anchor': 'end', class: 'ax' }, 'faults'));
    const railG = sv('g'), spikeG = sv('g');
    let sp = 0, dr = 0;
    for (const [k, kind] of D.faults) {
      const x = X(k);
      if (kind === 'spike') {
        sp++;
        spikeG.append(sv('circle', { cx: x, cy: Y(rep[k]), r: 3, class: 'tm-spike' }));
        railG.append(sv('line', { x1: x, x2: x, y1: railY - 6, y2: railY + 6, class: 'tm-spike-t' }));
      } else if (kind === 'dropout') {
        dr++;
        railG.append(sv('line', { x1: x, x2: x, y1: railY - 4, y2: railY + 4, class: 'tm-drop-t' }));
      }
    }
    traceSvg.append(railG, spikeG);

    // Stuck run: a band to slide, its right edge to stretch.
    if (D.stuckN > 0 && D.stuckAt >= 0) {
      const a = X(D.stuckAt), b = X(Math.min(D.n - 1, D.stuckAt + D.stuckN));
      const band = sv('g', { class: 'tm-h tm-stuck', tabindex: 0, role: 'slider', 'data-h': 'stuck', 'aria-label': `Stuck run: ${D.stuckN} samples from sample ${D.stuckAt}; arrows move it, + and − change its length`,
        'aria-valuenow': D.stuckAt });
      band.append(sv('rect', { x: a, y: T, width: Math.max(3, b - a), height: ph, class: 'body' }));
      band.append(sv('rect', { x: a, y: railY - 5, width: Math.max(3, b - a), height: 10, class: 'railbar' }));
      band.append(sv('rect', { x: a - 1, y: T, width: Math.max(5, b - a + 2), height: ph, class: 'ring' }));
      const lbl = `stuck ${D.stuckN}${D.stuckPlaced ? '' : ' · seeded'}`;
      band.append(sv('text', { x: a + 3, y: T + 12, class: 'lbl' }, lbl));
      const edge = sv('g', { class: 'tm-h tm-edge', tabindex: 0, role: 'slider', 'data-h': 'stuckEnd', 'aria-label': `Stuck run length ${D.stuckN} samples`, 'aria-valuenow': D.stuckN });
      edge.append(sv('rect', { x: b - 4, y: T + ph / 2 - 16, width: 8, height: 32, rx: 2, class: 'grip' }));
      edge.append(sv('rect', { x: b - 8, y: T, width: 16, height: ph, class: 'hit' }));
      stuckG.append(band);
      traceSvg.append(edge);
      band.addEventListener('pointerdown', (e) => dragX(e, (k0, k) => ({ stuckAt: String(roundTo((clamp(k - k0, 0, D.n - 1) / D.n) * 100, 0.1)) }), X(D.stuckAt)));
      edge.addEventListener('pointerdown', (e) => dragX(e, (k0, k) => ({ stuck: String(Math.max(1, Math.round(k - D.stuckAt))), ...(D.stuckPlaced ? {} : { stuckAt: String(roundTo((D.stuckAt / D.n) * 100, 0.1)) }) }), b));
      band.addEventListener('keydown', (e) => {
        const p = (D.stuckAt / D.n) * 100;
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { e.preventDefault(); ctx.set('stuckAt', String(roundTo(clamp(p + d * (e.shiftKey ? 10 : 1), 0, 99.9), 0.1))); return; }
        if (e.key === '+' || e.key === '=' || e.key === '-') { e.preventDefault(); ctx.set('stuck', String(Math.max(0, D.stuckN + (e.key === '-' ? -1 : 1) * (e.shiftKey ? 10 : 1)))); }
      });
      edge.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!d) return;
        e.preventDefault(); ctx.set('stuck', String(Math.max(1, D.stuckN + d * (e.shiftKey ? 10 : 1))));
      });
    }

    // Offset step: a line to slide, an arrow to pull.
    if (D.step && D.stepAt >= 0) {
      const x = X(D.stepAt);
      const before = tru[Math.max(0, D.stepAt - 1)], after = before + D.step;
      const line = sv('g', { class: 'tm-h tm-stepl', tabindex: 0, role: 'slider', 'data-h': 'stepAt', 'aria-label': `Offset step at sample ${D.stepAt}; arrows move it`, 'aria-valuenow': D.stepAt });
      line.append(sv('line', { x1: x, x2: x, y1: T, y2: railY + 6, class: 'ln' }), sv('rect', { x: x - 6, y: T, width: 12, height: ph, class: 'hit' }));
      line.append(sv('path', { d: `M${x - 5},${railY - 6}h10l-5,7z`, class: 'tip' }));
      const arrow = sv('g', { class: 'tm-h tm-stepa', tabindex: 0, role: 'slider', 'data-h': 'step', 'aria-label': `Offset step ${f(D.step, 4)} ${D.unit}; up and down arrows change it`, 'aria-valuenow': D.step });
      const ya = Y(before), yb = Y(after), dir = Math.sign(yb - ya) || 1;
      arrow.append(sv('line', { x1: x + 10, x2: x + 10, y1: ya, y2: yb - dir * 6, class: 'shaft' }));
      arrow.append(sv('path', { d: `M${x + 10},${yb}l-5,${-dir * 8}h10z`, class: 'head' }));
      arrow.append(sv('circle', { cx: x + 10, cy: yb, r: 10, class: 'hit' }), sv('circle', { cx: x + 10, cy: yb, r: 9, class: 'ring' }));
      const lbl = `${D.step > 0 ? '+' : ''}${f(D.step, 4)} ${D.unit}`;
      arrow.append(sv('text', { x: x + 18, y: (ya + yb) / 2 + 4, class: 'lbl halo' }, lbl));
      traceSvg.append(line, arrow);
      line.addEventListener('pointerdown', (e) => dragX(e, (k0, k) => ({ stepAt: String(roundTo((clamp(k - k0, 0, D.n - 1) / D.n) * 100, 0.1)) }), x));
      arrow.addEventListener('pointerdown', (e) => dragY(e, (v) => ({ step: String(roundTo(v - before, scrubStep(0, span()))) })));
      line.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault(); ctx.set('stepAt', String(roundTo(clamp((D.stepAt / D.n) * 100 + d * (e.shiftKey ? 10 : 1), 0, 99.9), 0.1)));
      });
      arrow.addEventListener('keydown', (e) => keyY(e, 'step', D.step, scrubStep(0, span())));
    }

    // Model handles.
    const handle = (id, x, y, cls, label, aria, anchor = 'start') => {
      const gg = sv('g', { class: `tm-h tm-knob ${cls}`, tabindex: 0, role: 'slider', 'data-h': id, 'aria-label': aria });
      gg.append(sv('circle', { cx: x, cy: y, r: 12, class: 'hit' }), sv('circle', { cx: x, cy: y, r: 5.5, class: 'dot' }), sv('circle', { cx: x, cy: y, r: 9.5, class: 'ring' }));
      if (label) gg.append(sv('text', { x: anchor === 'end' ? x - 12 : x + 12, y: y + 4, 'text-anchor': anchor, class: 'lbl halo' }, label));
      traceSvg.append(gg);
      return gg;
    };
    // Base: a tab on the y axis.
    const baseTab = sv('g', { class: 'tm-h tm-tab c-base', tabindex: 0, role: 'slider', 'data-h': 'base', 'aria-label': `Base value ${f(D.base, 6)} ${D.unit}`, 'aria-valuenow': D.base });
    const by = Y(D.base);
    baseTab.append(sv('path', { d: `M${L},${by}l-8,-8h-${narrow ? 30 : 44}v16h${narrow ? 30 : 44}z`, class: 'tab' }));
    baseTab.append(sv('text', { x: L - 10, y: by + 3.5, 'text-anchor': 'end', class: 'tabt' }, narrow ? 'base' : `${f(D.base, 5)}`));
    baseTab.append(sv('path', { d: `M${L},${by}l-8,-8h-${narrow ? 30 : 44}v16h${narrow ? 30 : 44}z`, class: 'ring' }));
    traceSvg.append(baseTab);
    baseTab.addEventListener('pointerdown', (e) => dragY(e, (v) => ({ base: String(roundTo(v, scrubStep(D.base, span()))) })));
    baseTab.addEventListener('keydown', (e) => keyY(e, 'base', D.base, scrubStep(D.base, span())));

    // Crest: amplitude and period.
    const kc = D.period > 0 ? ((D.period / 4) * 3600) / D.dt : -1;
    if (kc >= 0 && kc <= D.n - 1) {
      const xc = X(kc), mc = D.base + D.drift * (D.period / 4), yc = Y(mc + D.amp);
      traceSvg.append(sv('path', { d: `M${xc},${Y(mc)}V${yc}`, class: 'tm-ampline' }));
      // Period bracket along the top: one full cycle when it fits.
      const x4 = X(Math.min(D.n - 1, kc * 4));
      traceSvg.append(sv('path', { d: `M${L},${T + ph - 8}v4H${x4}v-4`, class: 'tm-per' }));
      if (x4 - L > 70) traceSvg.append(sv('text', { x: (L + x4) / 2, y: T + ph - 10, 'text-anchor': 'middle', class: 'ax c-cyc-t' }, `period ${f(D.period, 4)} h`));
      const ch = handle('crest', xc, yc, 'c-cyc', narrow ? '' : `A ${f(D.amp, 4)}`, `Cycle crest: amplitude ${f(D.amp, 4)} ${D.unit}, period ${f(D.period, 4)} h. Up and down: amplitude; left and right: period`);
      ch.addEventListener('pointerdown', (e) => drag2(e, (k, v) => {
        const tc = Math.max(D.dt / 3600, (k * D.dt) / 3600);
        const P = roundTo(tc * 4, tc * 4 >= 48 ? 1 : tc * 4 >= 4 ? 0.25 : 0.05);
        return { amp: String(roundTo(v - (D.base + D.drift * (P / 4)), scrubStep(D.amp, span()))), period: String(P) };
      }));
      ch.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const st = D.period >= 48 ? 1 : D.period >= 4 ? 0.25 : 0.05;
          ctx.set('period', String(roundTo(Math.max(st, D.period + (e.key === 'ArrowRight' ? 1 : -1) * st * (e.shiftKey ? 10 : 1)), st)));
        } else keyY(e, 'amp', D.amp, scrubStep(D.amp, span()));
      });
    }

    // Drift end and walk funnel end, at the right edge.
    const xe = L + pw;
    const dh = handle('drift', xe, Y(endV), 'c-drift', narrow ? '' : `${D.drift >= 0 ? '+' : ''}${f(D.drift, 3)}/h`, `Drift ${f(D.drift, 4)} ${D.unit} per hour: up and down`);
    dh.addEventListener('pointerdown', (e) => dragY(e, (v) => ({ drift: String(roundTo((v - D.base) / (T_h || 1), scrubStep(0, span() / 100 / Math.max(1, T_h / 24)))) })));
    dh.addEventListener('keydown', (e) => keyY(e, 'drift', D.drift, scrubStep(D.drift, span() / 100)));
    const fw = fun(D.n - 1);
    const wh = handle('walk', xe, Y(endV + fw), 'c-walk', narrow ? '' : `walk ${f(D.wander, 3)}`, `Random walk sigma ${f(D.wander, 4)} per root hour: up and down`);
    wh.addEventListener('pointerdown', (e) => dragY(e, (v) => ({ wander: String(Math.max(0, roundTo((v - endV) / (2 * Math.sqrt(T_h || 1)), scrubStep(D.wander, span() / 50)))) })));
    wh.addEventListener('keydown', (e) => keyY(e, 'wander', D.wander, scrubStep(D.wander, span() / 50), 0));

    // Click the trace (not a handle) to move the lens.
    const surf = sv('rect', { x: L, y: T, width: pw, height: ph, class: 'tm-surf' });
    traceSvg.insertBefore(surf, stuckG);
    surf.addEventListener('pointerdown', (e) => {
      const pick = (ev) => { const p = pt(ev); lensK = Kof(p.x); pickK = lensK; drawTrace(); drawLens(); };
      pick(e);
      const up = () => { window.removeEventListener('pointermove', pick); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', pick); window.addEventListener('pointerup', up);
    });

    // Header numbers from result.values.
    const vals = Object.fromEntries((res.values || []).map((v) => [v.label, v]));
    const stat = (label, v, cls) => (v ? h('span', { class: `tm-stat ${cls || ''}` }, h('small', {}, label), h('b', {}, String(v.value)), v.hint ? h('em', {}, v.hint) : null) : null);
    traceHead.replaceChildren(h('h2', {}, `${D.label}${D.unit ? ` (${D.unit})` : ''}`),
      stat('samples', vals.Samples), stat('mean', vals.Mean), stat('min / max', vals['Min / max']), stat('σ', vals['Std deviation']),
      stat('faults', vals.Faults, vals.Faults && vals.Faults.value ? 'warn' : ''));
    if (had) traceSvg.querySelector(`[data-h="${had}"]`)?.focus({ preventScroll: true });
  }

  const pt = (ev) => {
    const r = traceSvg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (geo.W / r.width), y: (ev.clientY - r.top) * (geo.H / r.height) };
  };
  // Drags hold the y range still, listen on the window (the drawing is
  // redrawn under the pointer on every change) and set inputs at frame rate.
  const runDrag = (e, fn) => {
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.focus?.({ preventScroll: true });
    frozenY = yRange(); dragging = true;
    let raf = 0, last = null;
    const move = (ev) => {
      last = fn(ev);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (last) { const o = last; last = null; ctx.setMany(o); } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      dragging = false; frozenY = null; drawTrace();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  const dragY = (e, fn) => { const g0 = geo; runDrag(e, (ev) => fn(g0.Vof(pt(ev).y))); };
  const dragX = (e, fn, x0) => {
    const g0 = geo; const k0 = g0.Kof(pt(e).x) - g0.Kof(x0);
    runDrag(e, (ev) => fn(k0, g0.Kof(pt(ev).x)));
  };
  const drag2 = (e, fn) => { const g0 = geo; runDrag(e, (ev) => { const p = pt(ev); return fn(g0.Kof(p.x), g0.Vof(p.y)); }); };
  const keyY = (e, key, v, st, min) => {
    const d = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    let x = roundTo(v + d * st * (e.shiftKey ? 10 : 1), st);
    if (min != null) x = Math.max(min, x);
    ctx.set(key, String(x));
  };

  // ---------------- lens ----------------
  function drawLens() {
    lensSvg.replaceChildren();
    const W = Math.max(280, lensBox.clientWidth || 600), H = Math.max(170, lensBox.clientHeight || 220);
    lensSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!D) { lensHead.replaceChildren(h('h2', {}, 'Lens')); readout.replaceChildren(); return; }
    if (lensK == null || lensK >= D.n) lensK = D.stuckAt >= 0 ? Math.min(D.n - 1, D.stuckAt + Math.floor(D.stuckN / 2)) : Math.floor(D.n / 2);
    if (pickK == null || Math.abs(pickK - lensK) > 30 || pickK >= D.n) pickK = lensK;
    const LW = 30;
    const k0 = Math.max(0, lensK - LW), k1 = Math.min(D.n - 1, lensK + LW);
    const L = 54, R = 12, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const vs = [];
    for (let k = k0; k <= k1; k++) { if (D.reported[k] != null) vs.push(D.reported[k]); if (D.truth[k] != null) vs.push(D.truth[k]); }
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (!(hi > lo)) { const p = D.quant || Math.abs(hi) * 0.01 || 1; lo -= p * 2; hi += p * 2; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const X = (k) => L + ((k - k0 + 0.5) / (k1 - k0 + 1)) * pw;
    const Y = (v) => T + ph * (1 - (v - lo) / (hi - lo));
    // Resolution steps as rules when they are far enough apart to see.
    const q = D.quant;
    const qpx = q > 0 ? (q / (hi - lo)) * ph : 0;
    if (qpx >= 5) {
      for (let v = Math.ceil(lo / q) * q; v <= hi; v += q) lensSvg.append(sv('line', { x1: L, x2: L + pw, y1: Y(v), y2: Y(v), class: 'tm-lsb' }));
    }
    const ys = niceStep(hi - lo, 4);
    for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
      lensSvg.append(sv('line', { x1: L, x2: L + pw, y1: Y(v), y2: Y(v), class: 'tm-lgrid' }));
      lensSvg.append(sv('text', { x: L - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'ax' }, f(v, 7)));
    }
    lensSvg.append(sv('rect', { x: L, y: T, width: pw, height: ph, class: 'tm-lframe' }));
    const fk = new Map(D.faults.map(([k, kind]) => [k, kind]));
    // Stuck span and step inside the window.
    if (D.stuckN > 0 && D.stuckAt >= 0 && D.stuckAt <= k1 && D.stuckAt + D.stuckN > k0) {
      const a = X(Math.max(k0, D.stuckAt) - 0.5), b = X(Math.min(k1, D.stuckAt + D.stuckN - 1) + 0.5);
      lensSvg.append(sv('rect', { x: a, y: T, width: b - a, height: ph, class: 'tm-lstuck' }));
    }
    // Truth as a line, samples as dots joined by steps (a sample holds till the next).
    let td = '';
    for (let k = k0; k <= k1; k++) if (D.truth[k] != null) td += `${td ? 'L' : 'M'}${X(k).toFixed(1)},${Y(D.truth[k]).toFixed(1)}`;
    lensSvg.append(sv('path', { d: td, class: 'tm-truth' }));
    let sd = '', pen = false;
    for (let k = k0; k <= k1; k++) {
      const v = D.reported[k];
      if (v == null) { pen = false; continue; }
      sd += pen ? `H${X(k).toFixed(1)}V${Y(v).toFixed(1)}` : `M${X(k).toFixed(1)},${Y(v).toFixed(1)}`; pen = true;
    }
    lensSvg.append(sv('path', { d: sd, class: 'tm-hold' }));
    const cw = pw / (k1 - k0 + 1);
    for (let k = k0; k <= k1; k++) {
      const v = D.reported[k], kind = fk.get(k);
      const x = X(k);
      if (k === pickK) lensSvg.append(sv('rect', { x: x - cw / 2, y: T, width: cw, height: ph, class: 'tm-pick' }));
      if (v == null) {
        lensSvg.append(sv('path', { d: `M${x - 3.5},${T + ph - 9.5}l7,7m0,-7l-7,7`, class: 'tm-ldrop' }));
      } else {
        lensSvg.append(sv('circle', { cx: x, cy: Y(v), r: cw > 9 ? 3.2 : 2.2, class: `tm-ldot${kind === 'spike' ? ' spike' : ''}` }));
      }
    }
    // Time labels at the ends and the middle.
    const iso = (k) => new Date(D.t0 + k * D.dt * 1000).toISOString();
    const short = (k) => iso(k).slice(11, D.dt < 1 ? 23 : 19);
    lensSvg.append(sv('text', { x: X(k0), y: H - 8, class: 'ax' }, short(k0)));
    lensSvg.append(sv('text', { x: X(k1), y: H - 8, 'text-anchor': 'end', class: 'ax' }, short(k1)));
    // Picking a sample.
    const hit = sv('rect', { x: L, y: T, width: pw, height: ph, class: 'tm-surf' });
    lensSvg.append(hit);
    hit.addEventListener('pointerdown', (e) => {
      const r = lensSvg.getBoundingClientRect();
      const x = (e.clientX - r.left) * (W / r.width);
      pickK = clamp(Math.round(k0 + (x - L) / cw - 0.5), k0, k1);
      drawLens();
    });

    lensHead.replaceChildren(h('h2', {}, 'Lens'), h('span', { class: 'tm-sub' }, `samples ${k0}–${k1}`),
      h('span', { class: 'tm-sub' }, q > 0 ? `rules = resolution ${f(q, 4)} ${D.unit}${qpx < 5 ? ' (too fine to draw here)' : ''}` : 'no quantisation'));
    // Readout for the picked sample, and its line in the output.
    const k = pickK, v = D.reported[k], kind = fk.get(k);
    const out = (res.texts || [])[0];
    let line = '';
    if (out) {
      const lines = out.body.split('\n');
      if (ctx.input.format === 'csv') line = lines[k + 1] || '';
      else if (ctx.input.format === 'ndjson') line = lines[k] || '';
      else line = lines.find((l) => l.includes(ctx.input.format === 'influx' ? ` ${D.t0 + k * D.dt * 1000}000000` : `"${iso(k)}"`)) || (ctx.input.format === 'influx' && v == null ? '(no line: a dropout is left out)' : '');
    }
    readout.replaceChildren(
      h('div', { class: 'tm-rgrid' },
        h('span', {}, h('small', {}, 'sample'), h('b', {}, String(k))),
        h('span', {}, h('small', {}, 'time (UTC)'), h('b', {}, iso(k))),
        h('span', {}, h('small', {}, 'reported'), h('b', { class: v == null ? 'drop' : kind === 'spike' ? 'spike' : '' }, v == null ? 'missing' : `${v} ${D.unit}`)),
        h('span', {}, h('small', {}, 'true'), h('b', {}, `${f(D.truth[k], 6)} ${D.unit}`)),
        h('span', {}, h('small', {}, 'fault'), h('b', {}, kind || (D.stuckAt >= 0 && k >= D.stuckAt && k < D.stuckAt + D.stuckN ? 'stuck' : '–')))),
      line ? h('code', { class: 'tm-line', title: 'This sample in the output' }, line) : null);
  }
  lensSvg.addEventListener('keydown', (e) => {
    if (!D) return;
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    pickK = clamp((pickK ?? 0) + d * (e.shiftKey ? 10 : 1), 0, D.n - 1);
    if (Math.abs(pickK - lensK) > 24) lensK = pickK;
    drawLens(); drawTrace();
  });

  // ---------------- sync ----------------
  function sync() {
    const raw = ctx.raw;
    for (const b of sensors.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === raw.sensor));
    for (const s of scrubs) {
      const el = s.inp;
      if (document.activeElement !== el || dragging) el.value = raw[s.key] ?? '';
      const t = String(raw[s.key] ?? '').trim();
      el.classList.toggle('bad', t !== '' && ctx.parseEng(t) == null);
      el.classList.toggle('set', t !== '' && MODEL_KEYS.includes(s.key));
      if (D && s.opts.eff && s.opts.blank !== 'mid-series') el.placeholder = s.opts.blank === 'seeded' ? (D.stuckAt >= 0 ? f((D.stuckAt / D.n) * 100, 3) : 'seeded') : f(s.opts.eff(), 5);
      else if (s.opts.blank === 'mid-series') el.placeholder = '50';
      el.style.width = `${Math.max(3, String(el.value || el.placeholder || '').length + 1)}ch`;
    }
    for (const el of root.querySelectorAll('[data-key]')) {
      if (el.classList.contains('tm-scrub')) continue;
      if (document.activeElement !== el) el.value = raw[el.dataset.key] ?? '';
    }
    root.querySelector('[data-key="field"]').placeholder = D ? D.field : '';
    for (const s of unitSpans) s.textContent = D ? D.unit : '';
    const v = (res && res.values || []).find((x) => x.label === 'Samples');
    dur.textContent = v ? `= ${v.hint.split(', ')[1] || ''}` : '';
  }

  ctx.onResult((r) => {
    res = r; D = r.drawing || null;
    sync();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'The model, and how faults are written'), ...(r.notes || []).map((t) => h('div', {}, t)));
    drawTrace(); drawLens();
  });
  let lw = 0, lh = 0;
  new ResizeObserver(() => {
    const w = traceBox.clientWidth, hh = traceBox.clientHeight;
    if (w !== lw || hh !== lh) { lw = w; lh = hh; drawTrace(); drawLens(); }
  }).observe(traceBox);
}
