// Retrieval Tester, custom page. The ranking is the interface:
//   Queries   - the list of test queries, each with where its expected chunk
//               landed; click (or arrow keys) to pick one, type to add one.
//   Ranking   - the chunks the picked query retrieves, a bar per chunk split
//               into what each query word contributed, the words marked in
//               the text, and how far each chunk moved since the last change.
//   Parameters- a k1 x b pad: drag the handle (or arrows) and watch the
//               ranking move; the curve under it is the term-frequency
//               saturation those values give for short, average, long chunks.
//   Matrix    - every query against every chunk, coloured by rank; expected
//               cells outlined. Click a cell to open that query and chunk.
// Everything drawn comes from run()'s result.bm25.

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
const TERM_COLOURS = 6;
const tc = (g) => `t${g % TERM_COLOURS}`;
const K1_MAX = 3;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

/** Text with the query words marked: spans [[s, e, g]] from run(). */
function marked(text, spans, from = 0, to = text.length) {
  const out = [];
  let at = from;
  for (const [s, e, g] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (e <= from || s >= to || s < at) continue;
    out.push(text.slice(at, s), h('mark', { class: tc(g) }, text.slice(s, e)));
    at = e;
  }
  out.push(text.slice(at, to));
  return out;
}

export function page(root, ctx) {
  const KEY = 'redline.tool.retrieval-tester.view';
  const saved = store.get(KEY) || {};
  let selQ = saved.q || 0;
  let selC = -1;                // chunk index picked in the ranking or matrix
  const open = new Set();       // chunks shown in full
  let prevAll = null;          // ranks by query text from the result before this one
  let last = null;

  const wrap = h('div', { class: 'rt' });
  root.append(wrap);

  // ---------- queries ----------
  const qList = h('div', { class: 'rt-qlist', role: 'listbox', tabindex: '0', 'aria-label': 'Queries: arrows to move, Delete to remove' });
  const qAdd = h('input', { type: 'text', class: 'rt-in', placeholder: 'Add a query, then Enter  (text => expected-id)', spellcheck: 'false',
    'aria-label': 'Add a query',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !qAdd.value.trim()) return;
      const cur = String(ctx.raw.queries || '').replace(/\s+$/, '');
      selQ = (last?.bm25?.queries.length || 0);
      ctx.set('queries', `${cur}${cur ? '\n' : ''}${qAdd.value.trim()}`);
      qAdd.value = '';
    } });
  const qEdit = h('textarea', { class: 'rt-ta', rows: 8, spellcheck: 'false', 'aria-label': 'All queries, one per line',
    oninput: () => ctx.set('queries', qEdit.value) });
  const qEditBox = h('details', { class: 'rt-edit' }, h('summary', {}, 'Edit all queries'), qEdit);
  const metrics = h('div', { class: 'rt-metrics' });
  const qCard = h('section', { class: 'rt-card rt-qcard' },
    h('div', { class: 'rt-head' }, h('h2', {}, 'Queries'), metrics), qList, h('div', { class: 'rt-pad' }, qAdd, qEditBox));

  // ---------- parameters ----------
  const PW = 260, PH = 150, PL = 30, PR = 10, PT = 8, PB = 24;
  const pad = sv('svg', { class: 'rt-kb', viewBox: `0 0 ${PW} ${PH}`, role: 'group', 'aria-label': 'k1 and b' });
  const handle = sv('g', { class: 'rt-handle', tabindex: '0', role: 'slider',
    'aria-label': 'BM25 parameters: left/right change b, up/down change k1; Shift for larger steps' });
  const curve = sv('svg', { class: 'rt-curve', viewBox: `0 0 ${PW} 120`, role: 'img', 'aria-label': 'term frequency saturation' });
  const stemSeg = h('div', { class: 'rt-seg', role: 'group', 'aria-label': 'Stemming' });
  const stopBtn = h('button', { class: 'rt-chip', 'aria-pressed': 'true', onclick: () => ctx.set('stopwords', !ctx.input.stopwords) }, 'Stopwords removed');
  const kSel = h('select', { class: 'rt-sel', 'aria-label': 'k for recall@k', onchange: (e) => ctx.set('topk', Number(e.target.value)) },
    [1, 2, 3, 5, 10, 20].map((k) => h('option', { value: k }, `recall@${k}`)));
  const kbRead = h('div', { class: 'rt-kbread' });
  const pCard = h('section', { class: 'rt-card rt-pcard' },
    h('div', { class: 'rt-head' }, h('h2', {}, 'BM25 parameters'), kbRead), pad,
    h('div', { class: 'rt-cap' }, 'One word\'s contribution (IDF = 1) against its count in a chunk, 0-10'), curve,
    h('div', { class: 'rt-opts' }, stemSeg, h('div', { class: 'rt-row' }, stopBtn, kSel)));

  const xb = (b) => PL + b * (PW - PL - PR);
  const yk = (k) => PT + (1 - k / K1_MAX) * (PH - PT - PB);
  const setKB = (k1, b) => {
    k1 = Math.round(clamp(k1, 0, K1_MAX) * 20) / 20; b = Math.round(clamp(b, 0, 1) * 100) / 100;
    if (k1 === last?.bm25?.params.k1 && b === last?.bm25?.params.b) return;
    ctx.setMany({ k1, b });
  };
  let dragging = false;
  const fromEvent = (e) => {
    const r = pad.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * PW, y = ((e.clientY - r.top) / r.height) * PH;
    setKB((1 - (y - PT) / (PH - PT - PB)) * K1_MAX, (x - PL) / (PW - PL - PR));
  };
  pad.addEventListener('pointerdown', (e) => { dragging = true; try { pad.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } handle.focus(); fromEvent(e); });
  pad.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  pad.addEventListener('pointerup', () => { dragging = false; });
  pad.addEventListener('pointercancel', () => { dragging = false; });
  handle.addEventListener('keydown', (e) => {
    const p = last?.bm25?.params; if (!p) return;
    const big = e.shiftKey ? 5 : 1;
    const moves = { ArrowLeft: [0, -0.05], ArrowRight: [0, 0.05], ArrowUp: [0.1, 0], ArrowDown: [-0.1, 0] };
    if (moves[e.key]) { e.preventDefault(); setKB(p.k1 + moves[e.key][0] * big, p.b + moves[e.key][1] * big); }
    if (e.key === 'Home') { e.preventDefault(); setKB(1.2, 0.75); }
  });

  // ---------- ranking ----------
  const rTitle = h('div', { class: 'rt-qtitle' });
  const terms = h('div', { class: 'rt-terms' });
  const rList = h('ol', { class: 'rt-rank', 'aria-label': 'Ranked chunks' });
  const rMissing = h('div', { class: 'rt-missing' });
  const rCard = h('section', { class: 'rt-card rt-rcard' },
    h('div', { class: 'rt-head' }, h('h2', {}, 'Ranking'), rTitle), terms, rList, rMissing);

  // ---------- matrix ----------
  const mBox = h('div', { class: 'rt-mbox' });
  const mLegend = h('div', { class: 'rt-mleg' });
  const mCard = h('section', { class: 'rt-card rt-mcard' },
    h('div', { class: 'rt-head' }, h('h2', {}, 'Queries x chunks'), mLegend), mBox);

  // ---------- documents ----------
  const dInfo = h('span', { class: 'rt-sub' });
  const dText = h('textarea', { class: 'rt-ta rt-docs', rows: 12, spellcheck: 'false', 'aria-label': 'Documents or chunks',
    oninput: () => ctx.set('docs', dText.value) });
  const dCard = h('section', { class: 'rt-card rt-dcard' },
    h('details', { class: 'rt-edit rt-dedit' }, h('summary', {}, h('b', {}, 'Documents'), ' ', dInfo), h('div', { class: 'rt-pad' },
      h('div', { class: 'rt-help' }, 'Markdown (each heading starts a chunk, {#id} sets its id), paragraphs, or JSONL / JSON with id and text.'), dText)));
  const warns = h('div', { class: 'rt-warns', 'aria-live': 'polite' });
  const notes = h('div', { class: 'rt-notes' });
  const out = h('div', { class: 'rt-out' }, ctx.outputs);

  const colA = h('div', { class: 'rt-col rt-a' }, qCard, pCard);
  const colB = h('div', { class: 'rt-col rt-b' }, warns, rCard, notes);
  const colC = h('div', { class: 'rt-col rt-c' }, mCard, dCard, out);
  wrap.append(colA, colB, colC);

  // ---------- drawing ----------
  function drawQueries(bm) {
    const qs = bm.queries;
    qList.replaceChildren(...qs.map((q, i) => {
      let chip, tone;
      if (q.expected.length) {
        tone = q.firstRank === 1 ? 'ok' : q.firstRank && q.firstRank <= bm.params.topk ? 'warn' : 'bad';
        chip = q.firstRank ? `#${q.firstRank}` : 'miss';
      } else { chip = `${q.retrieved}`; tone = q.retrieved ? 'n' : 'bad'; }
      return h('div', { class: `rt-q${i === selQ ? ' sel' : ''}`, role: 'option', 'aria-selected': String(i === selQ), 'data-i': i,
        title: q.expected.length ? `expected: ${q.expected.join(', ')}; first expected at rank ${q.firstRank || 'none'}` : `${q.retrieved} chunks match`,
        onclick: () => { selQ = i; selC = -1; store.set(KEY, { q: selQ }); draw(); } },
      h('span', { class: 'rt-qn' }, i + 1), h('span', { class: 'rt-qt' }, q.text), h('span', { class: `rt-qc ${tone}` }, chip));
    }));
    if (!qs.length) qList.append(h('div', { class: 'rt-empty' }, 'No queries yet: add one below.'));
    const p = bm.params;
    metrics.replaceChildren(...(bm.meanRecall != null ? [
      h('span', {}, `recall@${p.topk} `, h('b', { class: bm.meanRecall >= 0.9 ? 'ok' : bm.meanRecall >= 0.6 ? 'warn' : 'bad' }, bm.meanRecall.toFixed(2))),
      h('span', {}, 'MRR ', h('b', { class: bm.mrr >= 0.8 ? 'ok' : bm.mrr >= 0.5 ? 'warn' : 'bad' }, bm.mrr.toFixed(2)))] : [h('span', {}, 'add => ids for recall and MRR')]));
    if (document.activeElement !== qEdit) qEdit.value = ctx.raw.queries || '';
  }

  function drawPad(p) {
    pad.replaceChildren();
    for (let k = 0; k <= K1_MAX; k += 0.5) {
      pad.append(sv('line', { x1: PL, x2: PW - PR, y1: yk(k), y2: yk(k), class: 'g' }));
      if (Number.isInteger(k)) pad.append(sv('text', { x: PL - 5, y: yk(k) + 3, class: 'ax', 'text-anchor': 'end' }, k));
    }
    for (let b = 0; b <= 1.0001; b += 0.25) {
      pad.append(sv('line', { x1: xb(b), x2: xb(b), y1: PT, y2: PH - PB, class: 'g' }));
      pad.append(sv('text', { x: xb(b), y: PH - PB + 12, class: 'ax', 'text-anchor': 'middle' }, b));
    }
    pad.append(sv('text', { x: PW - PR, y: PH - 2, class: 'ax', 'text-anchor': 'end' }, 'b  length normalisation'));
    pad.append(sv('text', { x: 2, y: PT + 2, class: 'ax', transform: `rotate(90 2 ${PT + 2})` }, 'k1'));
    // Common settings, as references.
    for (const [k1, b, name] of [[1.2, 0.75, 'Lucene'], [2.0, 0.75, ''], [0.9, 0.4, 'Anserini']]) {
      pad.append(sv('circle', { cx: xb(b), cy: yk(k1), r: 2.5, class: 'ref' }));
      if (name) pad.append(sv('text', { x: xb(b) + 5, y: yk(k1) - 4, class: 'ax ref-t' }, name));
    }
    handle.replaceChildren(
      sv('line', { x1: PL, x2: xb(p.b), y1: yk(p.k1), y2: yk(p.k1), class: 'guide' }),
      sv('line', { x1: xb(p.b), x2: xb(p.b), y1: PH - PB, y2: yk(p.k1), class: 'guide' }),
      sv('circle', { cx: xb(p.b), cy: yk(p.k1), r: 7, class: 'knob' }));
    handle.setAttribute('aria-valuetext', `k1 ${p.k1}, b ${p.b}`);
    pad.append(handle);
    kbRead.replaceChildren(h('span', {}, 'k1 ', h('b', {}, p.k1.toFixed(2))), h('span', {}, 'b ', h('b', {}, p.b.toFixed(2))));

    // Saturation: tf (k1+1) / (tf + k1 (1 - b + b dl/avgdl)) for tf 0..10.
    curve.replaceChildren();
    const CL = 30, CR = 64, CT = 8, CB = 20, CH = 120, TF = 10;
    const top = p.k1 + 1;
    const X = (tf) => CL + (tf / TF) * (PW - CL - CR), Y = (v) => CT + (1 - v / Math.max(top, 1)) * (CH - CT - CB);
    for (let v = 0; v <= Math.max(top, 1) + 1e-9; v += top > 2.5 ? 1 : 0.5) {
      curve.append(sv('line', { x1: CL, x2: PW - CR, y1: Y(v), y2: Y(v), class: 'g' }));
      curve.append(sv('text', { x: CL - 5, y: Y(v) + 3, class: 'ax', 'text-anchor': 'end' }, v));
    }
    for (let tf = 0; tf <= TF; tf += 2) curve.append(sv('text', { x: X(tf), y: CH - 6, class: 'ax', 'text-anchor': 'middle' }, tf));
    let lastY = -99;
    [[0.5, 'short', 's2'], [1, 'average', 's0'], [2, 'long', 's1']].forEach(([rel, name, cls]) => {
      const norm = p.k1 * (1 - p.b + p.b * rel);
      let d = '';
      for (let i = 0; i <= 40; i++) { const tf = (i / 40) * TF; d += `${i ? 'L' : 'M'}${X(tf).toFixed(1)},${Y(tf ? (tf * (p.k1 + 1)) / (tf + norm) : 0).toFixed(1)}`; }
      curve.append(sv('path', { d, class: `ln ${cls}` }));
      const end = (TF * (p.k1 + 1)) / (TF + norm || 1);
      const ly = Math.max(Y(end) + 3, lastY + 10); lastY = ly;
      curve.append(sv('text', { x: PW - CR + 4, y: ly, class: `ax lt ${cls}` }, `${name} ${rel}x`));
    });
    curve.append(sv('line', { x1: CL, x2: PW - CR, y1: Y(top), y2: Y(top), class: 'cap' }));

    stemSeg.replaceChildren(h('span', { class: 'rt-lab' }, 'Stem'), ...[['none', 'none'], ['en', 'EN'], ['tr', 'TR'], ['en+tr', 'EN+TR']].map(([v, t]) =>
      h('button', { class: 'rt-chip', 'aria-pressed': String(p.stem === v), onclick: () => ctx.set('stem', v) }, t)));
    stopBtn.setAttribute('aria-pressed', String(!!p.stop));
    stopBtn.textContent = p.stop ? 'Stopwords removed' : 'Stopwords kept';
    kSel.value = String(p.topk);
    if (![...kSel.options].some((o) => o.value === String(p.topk))) kSel.append(h('option', { value: p.topk, selected: true }, `recall@${p.topk}`));
  }

  function drawRanking(bm) {
    const q = bm.queries[selQ];
    rList.replaceChildren(); rMissing.replaceChildren(); terms.replaceChildren();
    if (!q) { rTitle.textContent = ''; rList.append(h('li', { class: 'rt-empty' }, 'Pick or add a query.')); return; }
    rTitle.replaceChildren(h('span', { class: 'rt-qn' }, selQ + 1), h('span', {}, q.text));
    terms.append(...q.terms.map((t) => h('span', { class: `rt-term ${tc(t.g)}${t.df ? '' : ' none'}`,
      title: `${t.word} -> indexed as "${t.key}"; in ${t.df} of ${bm.params.N} chunks; IDF ${t.idf.toFixed(2)}` },
    h('i', {}), t.key, h('small', {}, t.df ? ` df ${t.df} · idf ${t.idf.toFixed(2)}` : ' in no chunk'))));
    if (!q.terms.length) terms.append(h('span', { class: 'rt-sub' }, 'no indexable words in this query'));
    const max = q.ranked[0]?.score || 1;
    const exp = new Set(q.expected);
    const mine = new Set(q.terms.map((t) => t.g));
    const before = prevAll ? prevAll[q.text] : null;
    q.ranked.forEach((x, i) => {
      const c = bm.chunks[x.c];
      const rank = i + 1;
      const inK = rank <= bm.params.topk;
      let move = null;
      if (before) {
        const was = before[c.id] || 0;
        if (!was) move = h('span', { class: 'rt-mv up', title: 'newly retrieved' }, 'new');
        else if (was !== rank) move = h('span', { class: `rt-mv ${was > rank ? 'up' : 'dn'}`, title: `was rank ${was}` }, `${was > rank ? '↑' : '↓'}${Math.abs(was - rank)}`);
      }
      const bar = h('div', { class: 'rt-bar', role: 'img', 'aria-label': `score ${x.score.toFixed(2)}` },
        ...x.parts.map((v, ti) => (v > 0 ? h('span', { class: tc(q.terms[ti].g), style: `width:${((v / max) * 100).toFixed(2)}%`,
          title: `${q.terms[ti].key}: ${v.toFixed(3)} (${((v / x.score) * 100).toFixed(0)} %)` }) : null)));
      const isOpen = open.has(c.id);
      const spans = c.spans.filter((sp) => mine.has(sp[2]));
      let text;
      if (isOpen) text = marked(c.text, spans);
      else {
        const first = spans.length ? Math.min(...spans.map((sp) => sp[0])) : 0;
        // Start the snippet at a word boundary about 60 characters before the first match.
        let from = Math.max(0, first - 60);
        if (from > 0) { const sp = c.text.indexOf(' ', from); from = sp >= 0 && sp < first ? sp + 1 : first; }
        let to = Math.min(c.text.length, from + 260);
        if (to < c.text.length) { const sp = c.text.lastIndexOf(' ', to); if (sp > from + 150) to = sp; }
        text = [from > 0 ? '… ' : '', ...marked(c.text, spans, from, to), to < c.text.length ? ' …' : ''];
      }
      const li = h('li', { class: `rt-item${inK ? ' ink' : ''}${exp.has(c.id) ? ' exp' : ''}${selC === x.c ? ' sel' : ''}`, tabindex: '0', 'data-c': x.c,
        'aria-expanded': String(isOpen),
        onclick: () => { if (open.has(c.id)) open.delete(c.id); else open.add(c.id); selC = x.c; draw(); },
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); focusItem(x.c); }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); (e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling)?.focus(); }
        } },
      h('div', { class: 'rt-line' },
        h('span', { class: 'rt-rk' }, rank), move || h('span', { class: 'rt-mv' }),
        h('span', { class: 'rt-id' }, c.id), exp.has(c.id) ? h('span', { class: `rt-tag ${inK ? 'ok' : 'warn'}` }, 'expected') : null,
        h('span', { class: 'rt-len' }, `${c.len} terms`),
        h('span', { class: 'rt-sc' }, x.score.toFixed(2))),
      bar,
      h('div', { class: 'rt-text' }, ...text));
      rList.append(li);
      if (rank === bm.params.topk && q.ranked.length > rank) rList.append(h('li', { class: 'rt-cut', 'aria-hidden': 'true' }, h('span', {}, `top ${bm.params.topk}`)));
    });
    if (!q.ranked.length) rList.append(h('li', { class: 'rt-empty' }, 'No chunk contains any word of this query. BM25 only matches words; a hybrid with embeddings would be needed for synonyms.'));
    const missing = q.expected.filter((id) => !q.ranked.some((x) => bm.chunks[x.c].id === id));
    if (missing.length) {
      rMissing.append(h('div', { class: 'rt-sub' }, 'Expected but not retrieved (no query word occurs in them):'),
        ...missing.map((id) => {
          const c = bm.chunks.find((cc) => cc.id === id);
          return h('div', { class: 'rt-miss' }, h('span', { class: 'rt-tag bad' }, id), c ? h('span', { class: 'rt-text' }, c.text.slice(0, 200), c.text.length > 200 ? ' …' : '') : h('span', { class: 'rt-sub' }, 'not a chunk id'));
        }));
    }
  }
  function focusItem(c) { rList.querySelector(`[data-c="${c}"]`)?.focus(); }

  function drawMatrix(bm) {
    mBox.replaceChildren();
    const Q = bm.queries.length, N = bm.chunks.length;
    if (!Q || !N) { mBox.append(h('div', { class: 'rt-empty' }, 'Needs queries and chunks.')); return; }
    const cell = clamp(Math.floor(330 / N), 12, 22);
    const LW = 30, TH = Math.min(110, 8 + 6.2 * Math.max(...bm.chunks.map((c) => Math.min(c.id.length, 18))));
    const W = LW + N * cell + 4, H = TH + Q * cell + 4;
    const svg = sv('svg', { class: 'rt-mx', width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'grid',
      'aria-label': 'Queries by chunks, coloured by rank: arrows move, Enter opens' });
    bm.chunks.forEach((c, j) => {
      const x = LW + j * cell + cell / 2;
      svg.append(sv('text', { x, y: TH - 4, class: `ax cl${j === selC ? ' on' : ''}`, transform: `rotate(-60 ${x} ${TH - 4})` }, c.id.length > 18 ? c.id.slice(0, 17) + '…' : c.id));
    });
    const k = bm.params.topk;
    bm.queries.forEach((q, i) => {
      const y = TH + i * cell;
      svg.append(sv('text', { x: LW - 5, y: y + cell / 2 + 3.5, class: `ax${i === selQ ? ' on' : ''}`, 'text-anchor': 'end' }, `Q${i + 1}`));
      const exp = new Set(q.expected);
      bm.chunks.forEach((c, j) => {
        const r = q.rank[j];
        const lvl = !r ? 'r0' : r === 1 ? 'r1' : r <= k ? 'r2' : r <= k * 2 ? 'r3' : 'r4';
        const rect = sv('rect', { x: LW + j * cell + 1, y: y + 1, width: cell - 2, height: cell - 2, rx: 2,
          class: `mc ${lvl}${exp.has(c.id) ? (r && r <= k ? ' ex ok' : ' ex bad') : ''}${i === selQ && j === selC ? ' cur' : ''}`, 'data-q': i, 'data-c': j });
        rect.append(sv('title', {}, `Q${i + 1} "${q.text}" -> ${c.id}: ${r ? `rank ${r}` : 'not retrieved'}${exp.has(c.id) ? ' (expected)' : ''}`));
        svg.append(rect);
        if (r && r <= 9 && cell >= 16) svg.append(sv('text', { x: LW + j * cell + cell / 2, y: y + cell / 2 + 3.5, class: `mn ${lvl}`, 'text-anchor': 'middle' }, r));
      });
      if (i === selQ) svg.append(sv('rect', { x: LW - 1, y: y, width: N * cell + 2, height: cell, class: 'rowsel' }));
    });
    svg.addEventListener('click', (e) => {
      const t = e.target.closest('[data-q]'); if (!t) return;
      selQ = Number(t.dataset.q); selC = Number(t.dataset.c); store.set(KEY, { q: selQ });
      open.add(bm.chunks[selC].id); draw(); focusItem(selC);
    });
    svg.addEventListener('keydown', (e) => {
      const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      if (mv) {
        e.preventDefault();
        selQ = clamp(selQ + mv[0], 0, Q - 1); selC = clamp((selC < 0 ? 0 : selC) + mv[1], 0, N - 1);
        store.set(KEY, { q: selQ }); draw(); mBox.querySelector('svg')?.focus();
      } else if (e.key === 'Enter' && selC >= 0) { open.add(bm.chunks[selC].id); draw(); focusItem(selC); }
    });
    mBox.append(svg);
    mLegend.replaceChildren(
      h('span', {}, h('i', { class: 'sw r1' }), '1'), h('span', {}, h('i', { class: 'sw r2' }), `2-${k}`),
      h('span', {}, h('i', { class: 'sw r3' }), `to ${k * 2}`), h('span', {}, h('i', { class: 'sw r4' }), 'lower'),
      h('span', {}, h('i', { class: 'sw ex' }), 'expected'));
  }

  function draw() {
    const bm = last?.bm25;
    if (!bm) return;
    selQ = clamp(selQ, 0, Math.max(0, bm.queries.length - 1));
    drawQueries(bm); drawPad(bm.params); drawRanking(bm); drawMatrix(bm);
    dInfo.textContent = `${bm.params.N} chunks · ${bm.params.format} · avg ${bm.params.avgdl.toFixed(1)} terms`;
    if (document.activeElement !== dText) dText.value = ctx.raw.docs || '';
    const w = last.warnings || [];
    warns.replaceChildren(...w.map((t) => h('div', {}, t)));
    warns.hidden = !w.length;
    notes.replaceChildren(...(last.notes || []).map((t) => h('div', {}, t)));
  }

  qList.addEventListener('keydown', (e) => {
    const n = last?.bm25?.queries.length || 0;
    if (!n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); selQ = clamp(selQ + (e.key === 'ArrowDown' ? 1 : -1), 0, n - 1); selC = -1; store.set(KEY, { q: selQ }); draw();
      qList.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Delete') {
      e.preventDefault();
      // Remove the picked query's line from the list as typed.
      let seen = -1;
      const lines = String(ctx.raw.queries || '').split('\n').filter((l) => {
        const t = l.trim(); if (!t || t.startsWith('#') || !t.split(/\s*=>\s*/)[0].trim()) return true;
        seen++; return seen !== selQ;
      });
      ctx.set('queries', lines.join('\n'));
    }
  });

  const ranksOf = (bm) => Object.fromEntries((bm?.queries || []).map((q) => [q.text, Object.fromEntries(q.ranked.map((x, i) => [bm.chunks[x.c].id, i + 1]))]));
  ctx.onResult((res) => {
    // Rank moves are shown against the previous result, so dragging k1/b or
    // switching stemming shows what changed until the next change.
    prevAll = last ? ranksOf(last.bm25) : null;
    last = res; draw();
  });
}
