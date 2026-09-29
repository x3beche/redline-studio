// Fine-tune Dataset Validator, custom page. The strip is the interface:
//   one square per example in file order, coloured by its worst problem
//   (rejected, duplicate, over-length, near duplicate, warning, fine), hatched
//   when cleaning will drop it. Click or arrow to one and it opens beside the
//   strip as the conversation, with each issue under the message it is
//   about. The issue list filters the strip; the length histogram has the
//   token limit as a line you drag; the drop switches write the cleaned
//   JSONL into the output panel. Drop a .jsonl file anywhere to load it.

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
const s = (tag, attrs = {}, text) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text != null) el.textContent = text; return el; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window or quota */ } },
};
const STATUS = { error: 'rejected', dup: 'duplicate', long: 'too long', near: 'near duplicate', warn: 'warning', ok: 'fine' };
const ORDER = ['error', 'dup', 'long', 'near', 'warn', 'ok'];

export function page(root, ctx) {
  const VKEY = 'redline.tool.finetune-validator.view';
  const vs = { set: 'train', line: 0, filter: '', ...(store.get(VKEY) || {}) };
  const save = () => store.set(VKEY, { set: vs.set, line: vs.line, filter: vs.filter });
  let res = null, dragMax = false, raf = 0, pendingMax = null, refocus = null;

  // ---------- skeleton ----------
  const summary = h('div', { class: 'fv-summary' });
  const warnBox = h('div', { class: 'fv-warns', 'aria-live': 'polite' });
  const legend = h('div', { class: 'fv-legend' }, ORDER.map((st) => h('span', {}, h('i', { class: `fv-sw st-${st}` }), STATUS[st])), h('span', {}, h('i', { class: 'fv-sw dropped' }), 'dropped by cleaning'));
  const stripT = h('div', { class: 'fv-strip', role: 'listbox', 'aria-label': 'Training examples' });
  const stripV = h('div', { class: 'fv-strip', role: 'listbox', 'aria-label': 'Validation examples' });
  const filterNote = h('span', { class: 'fv-sub' });
  const stripCard = h('section', { class: 'fv-card fv-stripcard' },
    h('div', { class: 'fv-head' }, h('h2', {}, 'Examples, in file order'), filterNote, legend),
    h('div', { class: 'fv-pad' }, h('div', { class: 'fv-setlab' }, 'train'), stripT, h('div', { class: 'fv-setlab fv-vlab' }, 'validation'), stripV));
  const histSvg = s('svg', { class: 'fv-hist', role: 'img', 'aria-label': 'Token length histogram' });
  const histBox = h('div', { class: 'fv-histbox' }, histSvg);
  const histCard = h('section', { class: 'fv-card' }, h('div', { class: 'fv-head' }, h('h2', {}, 'Length, estimated tokens'), h('span', { class: 'fv-sub' }, 'drag the limit line; arrows step')), histBox);
  const labelBox = h('div', { class: 'fv-labels' });
  const labelIn = h('input', { class: 'fv-in', type: 'text', spellcheck: 'false', 'aria-label': 'Label field', oninput: (e) => ctx.set('labelField', e.target.value) });
  const labelCard = h('section', { class: 'fv-card' }, h('div', { class: 'fv-head' }, h('h2', {}, 'Label balance'), h('label', { class: 'fv-lab' }, 'label at', labelIn)), labelBox);
  const cleanBox = h('div', { class: 'fv-clean' });
  const cleanCard = h('section', { class: 'fv-card' }, h('div', { class: 'fv-head' }, h('h2', {}, 'Cleaning'), h('span', { class: 'fv-sub' }, 'the cleaned JSONL is in the output panel')), cleanBox);
  const detail = h('section', { class: 'fv-card fv-detail', 'aria-live': 'polite' });
  const issueList = h('div', { class: 'fv-issues' });
  const issueCard = h('section', { class: 'fv-card' }, h('div', { class: 'fv-head' }, h('h2', {}, 'Top issues'), h('span', { class: 'fv-sub' }, 'click to mark them on the strip')), issueList);

  // data editors
  const fileIn = h('input', { type: 'file', accept: '.jsonl,.json,.txt,application/json', class: 'fv-file', onchange: (e) => loadFile(e.target.files[0], fileTarget) });
  let fileTarget = 'train';
  const trainTa = h('textarea', { class: 'fv-ta', rows: 7, spellcheck: 'false', 'aria-label': 'Training JSONL', oninput: (e) => ctx.set('train', e.target.value) });
  const validTa = h('textarea', { class: 'fv-ta', rows: 4, spellcheck: 'false', 'aria-label': 'Validation JSONL', oninput: (e) => ctx.set('valid', e.target.value) });
  const fmtSel = h('select', { class: 'fv-in', 'aria-label': 'Format', onchange: (e) => ctx.set('format', e.target.value) },
    [['auto', 'Detect'], ['openai-chat', 'OpenAI chat'], ['anthropic', 'Anthropic-style'], ['prompt-completion', 'prompt / completion']].map(([v, t]) => h('option', { value: v }, t)));
  const thIn = h('input', { class: 'fv-in fv-num', type: 'text', inputmode: 'decimal', 'aria-label': 'Near-duplicate similarity', oninput: (e) => ctx.set('nearThreshold', e.target.value) });
  const dataCard = h('section', { class: 'fv-card' },
    h('div', { class: 'fv-head' }, h('h2', {}, 'Data'), h('span', { class: 'fv-sub' }, 'paste, or drop a .jsonl file anywhere on the page')),
    h('div', { class: 'fv-pad' },
      h('div', { class: 'fv-row' }, h('label', { class: 'fv-lab' }, 'Format', fmtSel), h('label', { class: 'fv-lab' }, 'Near-duplicate at', thIn)),
      h('div', { class: 'fv-row' }, h('b', { class: 'fv-small' }, 'Training'), h('button', { class: 'k-btn', onclick: () => { fileTarget = 'train'; fileIn.click(); } }, 'Load file…')), trainTa,
      h('div', { class: 'fv-row' }, h('b', { class: 'fv-small' }, 'Validation'), h('button', { class: 'k-btn', onclick: () => { fileTarget = 'valid'; fileIn.click(); } }, 'Load file…')), validTa, fileIn));
  const notesBox = h('div', { class: 'fv-notes' });
  const dropHint = h('div', { class: 'fv-drop', 'aria-hidden': 'true' }, 'Drop the .jsonl file to load it as training data');

  root.append(h('div', { class: 'fv' },
    h('div', { class: 'fv-main' }, summary, warnBox, stripCard, h('div', { class: 'fv-two' }, histCard, labelCard), cleanCard, notesBox, h('div', { class: 'fv-out' }, ctx.outputs)),
    h('div', { class: 'fv-side' }, detail, issueCard, dataCard)), dropHint);

  // ---------- file loading ----------
  function loadFile(file, key) {
    if (!file) return;
    if (file.size > 20e6) { warnBox.replaceChildren(h('div', {}, `${file.name} is ${(file.size / 1e6).toFixed(1)} MB; this page checks files up to 20 MB. Split it or sample it.`)); return; }
    const rd = new FileReader();
    rd.onload = () => { ctx.set(key, String(rd.result)); vs.line = 0; save(); };
    rd.readAsText(file);
  }
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; dropHint.classList.add('on'); } });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropHint.classList.remove('on'); });
  document.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); dragDepth = 0; dropHint.classList.remove('on');
    loadFile(e.dataTransfer.files[0], e.target.closest?.('.fv-ta') === validTa ? 'valid' : 'train');
  });

  // ---------- the strip ----------
  const list = (set) => (set === 'valid' ? res.draw.val : res.draw.ex);
  const current = () => list(vs.set).find((e) => e.line === vs.line) || null;
  function drawStrip(el, set) {
    const items = list(set);
    const big = items.length <= 160;
    el.classList.toggle('big', big);
    el.replaceChildren(...(items.length ? items.map((e) => {
      const on = vs.set === set && vs.line === e.line;
      const hit = !vs.filter || e.issues.some((i) => vs.filter === `${set}:${i.code}`);
      return h('button', { class: `fv-dot st-${e.status}${e.dropped ? ' dropped' : ''}${on ? ' sel' : ''}${hit ? '' : ' dim'}`, role: 'option', 'aria-selected': String(on),
        tabindex: on || (!items.some((x) => vs.set === set && x.line === vs.line) && e === items[0]) ? '0' : '-1', 'data-line': e.line, 'data-set': set,
        title: `line ${e.line}: ${STATUS[e.status]}${e.dropped ? ', dropped' : ''} · ~${e.tokens} tokens${e.label != null ? ` · ${e.label}` : ''}${e.issues.length ? `\n${e.issues.map((i) => i.msg).join('\n')}` : ''}`,
        onclick: () => pick(set, e.line), onkeydown: (ev) => keyStrip(ev, set) }, big ? String(e.line) : '');
    }) : [h('span', { class: 'fv-sub' }, set === 'valid' ? 'no validation set' : 'no training lines')]));
  }
  function pick(set, line, focus = false) {
    vs.set = set; vs.line = line; save();
    refocus = focus ? `[data-set="${set}"][data-line="${line}"]` : null;
    drawStrip(stripT, 'train'); drawStrip(stripV, 'valid'); drawDetail();
    if (refocus) { root.querySelector(refocus)?.focus({ preventScroll: false }); refocus = null; }
  }
  function keyStrip(ev, set) {
    const items = list(set);
    const i = items.findIndex((e) => e.line === Number(ev.currentTarget.dataset.line));
    const el = ev.currentTarget;
    const perRow = Math.max(1, Math.round(el.parentElement.clientWidth / (el.offsetWidth + 3)));
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow, Home: -1e9, End: 1e9 }[ev.key];
    if (step == null) return;
    ev.preventDefault();
    const j = clamp(i + step, 0, items.length - 1);
    pick(set, items[j].line, true);
  }

  // ---------- the detail ----------
  function drawDetail() {
    const e = current();
    if (!e) {
      detail.replaceChildren(h('div', { class: 'fv-head' }, h('h2', {}, 'Example')), h('div', { class: 'fv-empty' }, 'Pick a square on the strip.'));
      return;
    }
    const items = list(vs.set);
    const idx = items.indexOf(e);
    const ref = (line) => h('button', { class: 'fv-ref', onclick: () => pick('train', line) }, `line ${line}`);
    const issueLine = (i) => h('div', { class: `fv-iss sev-${i.sev}` }, h('b', {}, i.code), ' ', i.msg.replace(/(?:training )?line \d+/, ''), i.ref ? ref(i.ref) : null);
    const general = e.issues.filter((i) => i.mi == null);
    const bubbles = e.msgs.map((m, mi) => h('div', { class: `fv-msg r-${m.role.replace(/[^a-z]/g, '') || 'x'}${e.issues.some((i) => i.mi === mi) ? ' bad' : ''}` },
      h('div', { class: 'fv-role' }, m.role, m.weight === 0 ? ' · weight 0' : '', m.id ? ` · ${m.id}` : ''),
      m.content ? h('div', { class: 'fv-text' }, m.content) : h('div', { class: 'fv-text fv-none' }, m.calls ? '' : '(no content)'),
      m.calls ? h('pre', { class: 'fv-calls' }, m.calls) : null,
      e.issues.filter((i) => i.mi === mi).map(issueLine)));
    detail.replaceChildren(...[
      h('div', { class: 'fv-head' }, h('h2', {}, `${vs.set === 'valid' ? 'Validation' : 'Training'} line ${e.line}`),
        h('span', { class: `fv-pill st-${e.status}` }, STATUS[e.status]), e.dropped ? h('span', { class: 'fv-pill dropped' }, 'dropped') : null,
        h('span', { class: 'fv-right' },
          h('button', { class: 'k-btn', 'aria-label': 'Previous example', disabled: idx <= 0, onclick: () => pick(vs.set, items[idx - 1].line) }, '‹'),
          h('button', { class: 'k-btn', 'aria-label': 'Next example', disabled: idx >= items.length - 1, onclick: () => pick(vs.set, items[idx + 1].line) }, '›'))),
      h('div', { class: 'fv-meta' }, `~${e.tokens} tokens`, e.label != null ? ` · label ${e.label}` : '', ` · ${e.msgs.length} message${e.msgs.length === 1 ? '' : 's'}`),
      general.length ? h('div', { class: 'fv-gen' }, general.map(issueLine)) : null,
      e.system && !e.msgs.some((m) => m.role === 'system') ? h('div', { class: 'fv-msg r-system' }, h('div', { class: 'fv-role' }, 'system (top-level)'), h('div', { class: 'fv-text' }, e.system)) : null,
      e.raw ? h('pre', { class: 'fv-calls' }, e.raw) : null,
      h('div', { class: 'fv-convo' }, bubbles)].filter(Boolean));
  }

  // ---------- issues ----------
  function drawIssues() {
    const is = res.draw.issues;
    issueList.replaceChildren(...(is.length ? is.map((i) => {
      const k = `${i.set}:${i.code}`;
      const on = vs.filter === k;
      return h('button', { class: `fv-irow sev-${i.sev}${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: () => {
        vs.filter = on ? '' : k; save();
        const first = list(i.set === 'valid' ? 'valid' : 'train').find((e) => e.line === i.lines[0]);
        if (!on && first) { vs.set = i.set === 'valid' ? 'valid' : 'train'; vs.line = first.line; }
        drawAll();
      } }, h('span', { class: `fv-sw st-${i.sev === 'warn' ? 'warn' : i.sev}` }), h('b', {}, i.code), h('span', { class: 'fv-iset' }, i.set), h('span', { class: 'fv-icount' }, `×${i.lines.length}`),
      h('small', {}, i.sample));
    }) : [h('div', { class: 'fv-empty' }, 'No issues found.')]));
    filterNote.textContent = vs.filter ? `showing ${vs.filter.replace(':', ' · ')}` : '';
  }

  // ---------- histogram ----------
  function drawHist() {
    const d = res.draw;
    const W = Math.max(280, histBox.clientWidth - 4), H = 190, L = 34, R = 12, T = 18, B = 30;
    histSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); histSvg.setAttribute('width', W); histSvg.setAttribute('height', H);
    histSvg.replaceChildren();
    const bins = d.hist;
    if (!bins.length) return;
    const top = bins[bins.length - 1].to || 1;
    const maxN = Math.max(1, ...bins.map((b) => b.n));
    const X = (t) => L + (W - L - R) * clamp(t / top, 0, 1);
    const Y = (n) => T + (H - T - B) * (1 - n / maxN);
    for (const n of [0, Math.ceil(maxN / 2), maxN]) {
      histSvg.append(s('line', { x1: L, x2: W - R, y1: Y(n), y2: Y(n), class: 'fv-grid' }), s('text', { x: L - 5, y: Y(n) + 3, class: 'fv-ax', 'text-anchor': 'end' }, String(n)));
    }
    for (const b of bins) {
      if (!b.n) continue;
      const over = b.from >= d.maxTok;
      const r = s('rect', { x: X(b.from) + 1, y: Y(b.n), width: Math.max(1, X(b.to) - X(b.from) - 2), height: Y(0) - Y(b.n), class: `fv-bar${over ? ' over' : ''}` });
      r.append(s('title', {}, `${b.from}-${b.to} tokens: ${b.n} example${b.n > 1 ? 's' : ''}`));
      histSvg.append(r);
    }
    const ticks = 5;
    for (let k = 0; k <= ticks; k++) { const t = Math.round((top * k) / ticks); histSvg.append(s('text', { x: X(t), y: H - 12, class: 'fv-ax', 'text-anchor': k === ticks ? 'end' : 'middle' }, k === ticks && d.hist.some((b) => b.rest) ? `${t}+` : String(t))); }
    for (const [v, lab] of [[d.p50, 'median'], [d.p95, 'p95']]) {
      histSvg.append(s('line', { x1: X(v), x2: X(v), y1: T, y2: Y(0), class: 'fv-mark' }), s('text', { x: X(v) + 3, y: T + (lab === 'p95' ? 40 : 9), class: 'fv-ax' }, lab));
    }
    const g = s('g', { class: 'fv-limit', tabindex: '0', role: 'slider', 'aria-label': 'Max tokens per example', 'aria-valuenow': String(d.maxTok), 'aria-valuemin': '16', 'aria-valuemax': String(Math.round(top)) });
    const xm = X(d.maxTok);
    const over = d.ex.filter((e) => e.tokens > d.maxTok).length;
    g.append(s('rect', { x: xm - 8, y: T - 14, width: 16, height: H - B - T + 14, class: 'fv-hit' }),
      s('line', { x1: xm, x2: xm, y1: T - 6, y2: Y(0), class: 'fv-limline' }),
      s('rect', { x: xm - 30, y: T - 17, width: 60, height: 15, rx: 3, class: 'fv-knob' }),
      s('text', { x: xm, y: T - 6, 'text-anchor': 'middle', class: 'fv-knobt' }, `max ${d.maxTok}`),
      s('text', { x: Math.min(xm + 6, W - R - 70), y: T + 22, class: 'fv-overt' }, over ? `${over} over` : ''));
    g.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const unit = d.maxTok >= 2000 ? 128 : d.maxTok >= 500 ? 32 : 8;
      setMax(d.maxTok + step * unit * (e.shiftKey ? 8 : 1), true);
    });
    histSvg.append(g);
    histSvg.__X = { L, R, W, top };
  }
  function setMax(v, focus) {
    pendingMax = Math.max(16, Math.round(v));
    if (focus) refocus = '.fv-limit';
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pendingMax != null) { const m = pendingMax; pendingMax = null; ctx.set('maxTokens', String(m)); } });
  }
  histSvg.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.fv-limit') && e.target !== histSvg) return;
    e.preventDefault(); dragMax = true; histSvg.setPointerCapture(e.pointerId); moveMax(e);
    histSvg.querySelector('.fv-limit')?.focus({ preventScroll: true }); refocus = '.fv-limit';
  });
  histSvg.addEventListener('pointermove', (e) => { if (dragMax) moveMax(e); });
  const endMax = (e) => { if (!dragMax) return; dragMax = false; try { histSvg.releasePointerCapture(e.pointerId); } catch { /* gone */ } };
  histSvg.addEventListener('pointerup', endMax); histSvg.addEventListener('pointercancel', endMax);
  function moveMax(e) {
    const X = histSvg.__X; if (!X) return;
    const r = histSvg.getBoundingClientRect();
    const x = (e.clientX - r.left) * (X.W / r.width);
    const t = ((x - X.L) / (X.W - X.L - X.R)) * X.top;
    const unit = t > 2000 ? 64 : t > 400 ? 16 : 4;
    setMax(Math.round(clamp(t, 16, X.top) / unit) * unit, true);
  }

  // ---------- labels and cleaning ----------
  function drawLabels() {
    const L = res.draw.labels;
    if (document.activeElement !== labelIn) labelIn.value = ctx.raw.labelField ?? '';
    if (!L.length) { labelBox.replaceChildren(h('div', { class: 'fv-empty' }, String(ctx.raw.labelField || '').trim() ? 'No labels found at that field.' : 'No label field: set one to check class balance (e.g. assistant:json.category).')); return; }
    const tot = L.reduce((a, b) => a + b.n, 0), max = L[0].n;
    labelBox.replaceChildren(...L.map((l) => h('div', { class: `fv-lrow${l.n / tot < 0.05 ? ' rare' : ''}` }, h('span', { class: 'fv-lname' }, l.label),
      h('span', { class: 'fv-lbar' }, h('i', { style: `width:${(l.n / max) * 100}%` })), h('b', {}, String(l.n)), h('small', {}, `${((l.n / tot) * 100).toFixed(1)} %`))));
  }
  function drawClean() {
    const d = res.draw, raw = ctx.raw;
    const count = (pred) => d.ex.filter(pred).length;
    const sw = (key, label, n, def) => {
      const id = `fv-${key}`;
      const val = raw[key] == null ? def : !!raw[key];
      return h('label', { class: 'fv-sw2', for: id }, h('input', { type: 'checkbox', id, checked: val, onchange: (e) => ctx.set(key, e.target.checked) }), h('span', {}, label), h('b', {}, String(n)));
    };
    cleanBox.replaceChildren(
      h('div', { class: 'fv-switches' },
        sw('dropInvalid', 'Drop lines the provider would reject', count((e) => e.status === 'error'), true),
        sw('dropDuplicates', 'Drop exact duplicates', count((e) => e.issues.some((i) => i.code === 'duplicate')), true),
        sw('dropNear', 'Drop near duplicates', count((e) => e.issues.some((i) => i.code === 'near-duplicate')), false),
        sw('dropOverLength', `Drop examples over ${d.maxTok} tokens`, count((e) => e.tokens > d.maxTok), true),
        sw('dropValidOverlap', 'Drop validation lines found in training', d.val.filter((v) => v.issues.some((i) => i.code === 'train-overlap')).length, true)),
      h('div', { class: 'fv-kept' }, h('b', {}, `${d.kept}`), ` of ${d.ex.length} training examples kept`, d.val.length ? `, ${d.vkept} of ${d.val.length} validation` : '',
        h('button', { class: 'k-btn k-primary', onclick: () => download('train.cleaned.jsonl', (res.texts || []).find((t) => t.title === 'Cleaned train JSONL')?.body || '') }, 'Download cleaned train'),
        d.val.length ? h('button', { class: 'k-btn', onclick: () => download('valid.cleaned.jsonl', (res.texts || []).find((t) => t.title === 'Cleaned validation JSONL')?.body || '') }, 'Download validation') : null));
  }
  function download(name, text) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text.endsWith('\n') || !text ? text : `${text}\n`], { type: 'application/jsonl' })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function drawSummary() {
    summary.replaceChildren(...res.values.map((v) => h('div', { class: `fv-stat${v.tone ? ` tone-${v.tone}` : ''}`, title: v.hint || null },
      h('span', {}, v.label), h('b', {}, String(v.value)), v.hint ? h('small', {}, v.hint) : null)));
  }
  function syncData() {
    const raw = ctx.raw;
    if (document.activeElement !== trainTa) trainTa.value = raw.train ?? '';
    if (document.activeElement !== validTa) validTa.value = raw.valid ?? '';
    fmtSel.value = raw.format || 'auto';
    if (document.activeElement !== thIn) thIn.value = raw.nearThreshold ?? '';
  }

  function drawAll() {
    drawSummary(); drawStrip(stripT, 'train'); drawStrip(stripV, 'valid'); drawDetail(); drawIssues(); drawHist(); drawLabels(); drawClean(); syncData();
    warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notesBox.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    if (refocus) { root.querySelector(refocus)?.focus({ preventScroll: true }); refocus = null; }
  }

  ctx.onResult((r) => {
    res = r;
    if (!r?.draw) { warnBox.replaceChildren(...(r?.warnings || []).map((w) => h('div', {}, w))); return; }
    // Keep the selection on a line that exists; start on the first problem.
    const items = list(vs.set);
    if (!items.some((e) => e.line === vs.line)) {
      vs.set = 'train';
      vs.line = (r.draw.ex.find((e) => e.status !== 'ok') || r.draw.ex[0] || { line: 0 }).line;
    }
    if (vs.filter && !r.draw.issues.some((i) => `${i.set}:${i.code}` === vs.filter)) vs.filter = '';
    drawAll();
  });
  let lastW = 0;
  new ResizeObserver(() => { const w = histBox.clientWidth; if (res && Math.abs(w - lastW) > 4) { lastW = w; drawHist(); } }).observe(histBox);
}
