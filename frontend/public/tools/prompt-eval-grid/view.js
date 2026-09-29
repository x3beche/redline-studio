// Prompt Eval Grid, custom page. The grid is the interface:
//   rows = test cases, columns = prompt variants, each cell one answer
//   coloured by its checks (pass / fail / partial / not run), with the judge
//   score and latency in it. Column heads carry the variant's pass-rate bar.
//   Click a cell for the answer, its check marks, the judge's reason and the
//   exact messages sent; click a head to edit that variant or case in place.
//   Run sends the cells to POST /api/tools/llm two at a time (in the app
//   only), with progress and Stop; each answer goes back into the tool's
//   `answers` input, so everything shown is scored by run().

import { judgeMessages, parseAnswers, parseVariants, parseCases } from './tool.js';

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
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};
const CONCURRENCY = 2;
const fmtCost = (c) => (c == null ? '' : c < 0.001 ? `$${c.toFixed(5)}` : `$${c.toFixed(4)}`);
const STATUS_TEXT = { pass: 'pass', fail: 'fail', partial: 'partial', pending: 'not run', error: 'error' };

export function page(root, ctx) {
  const KEY = 'redline.tool.prompt-eval-grid.view';
  const saved = store.get(KEY) || {};
  let sel = saved.sel || { kind: 'cell', v: 0, c: 0 };
  let last = null;
  let editing = false;              // an editor in the detail panel has focus: do not redraw it
  const running = new Set();        // "v\0c" keys in flight
  let queue = [], controllers = [], total = 0, finished = 0, pausedUntil = 0, stopped = false;
  let server = { state: 'unknown', models: [], def: '', note: '' };

  const wrap = h('div', { class: 'pe' });
  root.append(wrap);

  // ---------- run bar ----------
  const modelSel = h('select', { class: 'pe-in', 'aria-label': 'Model', onchange: (e) => ctx.set('model', e.target.value) });
  const tempIn = h('input', { class: 'pe-in pe-num', type: 'text', inputmode: 'decimal', 'aria-label': 'Temperature', spellcheck: 'false',
    onchange: (e) => ctx.set('temperature', e.target.value) });
  const maxIn = h('input', { class: 'pe-in pe-num', type: 'text', inputmode: 'numeric', 'aria-label': 'Max answer tokens', spellcheck: 'false',
    onchange: (e) => ctx.set('maxTokens', e.target.value) });
  const runMissing = h('button', { class: 'k-btn k-primary', onclick: () => start('missing') }, 'Run missing');
  const runAll = h('button', { class: 'k-btn', onclick: () => start('all') }, 'Run all');
  const stopBtn = h('button', { class: 'k-btn pe-stop', disabled: true, onclick: () => stop('Stopped.') }, 'Stop');
  const progFill = h('span', { class: 'pe-progfill' });
  const prog = h('div', { class: 'pe-prog', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, progFill);
  const progText = h('span', { class: 'pe-progtext' });
  const status = h('div', { class: 'pe-status', 'aria-live': 'polite' });
  const bar = h('section', { class: 'pe-card pe-runbar' },
    h('div', { class: 'pe-runrow' },
      h('label', { class: 'pe-lab' }, 'Model', modelSel),
      h('label', { class: 'pe-lab' }, 'Temp', tempIn),
      h('label', { class: 'pe-lab' }, 'Max tokens', maxIn),
      h('div', { class: 'pe-btns' }, runMissing, runAll, stopBtn),
      h('div', { class: 'pe-progwrap' }, prog, progText)),
    status);

  // ---------- grid ----------
  const table = h('table', { class: 'pe-grid' });
  const gridBox = h('div', { class: 'pe-gridbox' }, table);
  const legend = h('div', { class: 'pe-legend' },
    ...['pass', 'partial', 'fail', 'error', 'pending'].map((s) => h('span', {}, h('i', { class: `sw st-${s}` }), STATUS_TEXT[s])),
    h('span', {}, h('i', { class: 'sw st-sample' }), 'sample answer'), h('span', {}, h('i', { class: 'sw st-stale' }), 'prompt changed since'));
  const gridCard = h('section', { class: 'pe-card pe-gridcard' },
    h('div', { class: 'pe-head' }, h('h2', {}, 'Cases x variants'), h('span', { class: 'pe-sub' }, 'click a cell for its answer, a heading to edit it; arrows move'), legend), gridBox);
  const warns = h('div', { class: 'pe-warns', 'aria-live': 'polite' });
  const notes = h('div', { class: 'pe-notes' });

  // ---------- detail ----------
  const detail = h('div', { class: 'pe-detail' });
  const detailCard = h('section', { class: 'pe-card pe-detailcard' }, detail);
  detail.addEventListener('focusin', (e) => { if (e.target.matches('input, textarea')) editing = true; });
  detail.addEventListener('focusout', () => { editing = false; });

  // ---------- setup ----------
  const TABS = [['variants', 'Variants'], ['cases', 'Cases'], ['checks', 'Checks'], ['judge', 'Judge'], ['answers', 'Answers']];
  let setupTab = saved.tab || 'checks';
  const setupTabs = h('div', { class: 'k-tabs', role: 'tablist' });
  const setupHelp = h('div', { class: 'pe-sub pe-help' });
  const setupText = h('textarea', { class: 'pe-ta', rows: 10, spellcheck: 'false', oninput: () => ctx.set(setupTab, setupText.value) });
  const judgeMark = h('input', { class: 'pe-in pe-num', type: 'text', inputmode: 'numeric', 'aria-label': 'Judge pass mark', onchange: (e) => ctx.set('judgePass', e.target.value) });
  const judgeRow = h('label', { class: 'pe-lab pe-judgerow' }, 'Pass mark (of 5)', judgeMark);
  const download = (name, body, type) => {
    const a = h('a', { href: URL.createObjectURL(new Blob([body], { type })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  const exportRow = h('div', { class: 'pe-btns' },
    h('button', { class: 'k-btn', onclick: () => last?.grid && download('prompt-eval.csv', last.grid.exports.csv, 'text/csv') }, 'Export CSV'),
    h('button', { class: 'k-btn', onclick: () => last?.grid && download('prompt-eval.jsonl', last.grid.exports.jsonl, 'application/jsonl') }, 'Export JSONL'),
    h('button', { class: 'k-btn', onclick: () => { if (!running.size) ctx.set('answers', ''); } }, 'Clear answers'));
  const setupCard = h('section', { class: 'pe-card pe-setup' },
    h('div', { class: 'pe-head' }, h('h2', {}, 'Set-up'), setupTabs), h('div', { class: 'pe-pad' }, setupHelp, setupText, judgeRow, exportRow));
  const HELP = {
    variants: 'Each variant starts with ### name. A line --- splits the system prompt (above) from the user message (below). {{input}} is the case input, {{expected}} its expected text.',
    cases: 'Each case starts with ### id and an optional title; the rest is the input, except lines starting expected: and check: (checks for that case only).',
    checks: 'Checks for every case, one per line: contains: x · not_contains: x · starts_with: x · regex: /p/i · not_regex: /p/ · json · schema: {JSON Schema} · max_chars: N · max_words: N · equals_expected · contains_expected · judge: N',
    judge: 'With a rubric, each answer is also sent to the judge (same model, temperature 0), which returns a 1-5 score and a reason. Empty = no judge.',
    answers: 'One JSON line per answered cell, written by Run. You can paste answers obtained elsewhere: {"variant", "case", "text", "ms", "cost", ...}.',
  };
  const drawSetup = () => {
    setupTabs.replaceChildren(...TABS.map(([k, t]) => h('button', { class: 'k-tab', role: 'tab', 'aria-selected': String(k === setupTab),
      onclick: () => { setupTab = k; save(); drawSetup(); } }, t)));
    setupHelp.textContent = HELP[setupTab];
    if (document.activeElement !== setupText) setupText.value = ctx.raw[setupTab] ?? '';
    setupText.setAttribute('aria-label', TABS.find((t) => t[0] === setupTab)[1]);
    setupText.rows = setupTab === 'judge' ? 4 : 12;
    judgeRow.hidden = setupTab !== 'judge';
    if (document.activeElement !== judgeMark) judgeMark.value = ctx.raw.judgePass ?? '4';
  };
  const save = () => store.set(KEY, { sel, tab: setupTab });

  const main = h('div', { class: 'pe-main' }, bar, warns, gridCard, notes);
  const side = h('div', { class: 'pe-side' }, detailCard, setupCard, h('div', { class: 'pe-out' }, ctx.outputs));
  wrap.append(main, side);

  // ---------- grid drawing ----------
  const key = (vid, cid) => `${vid}\u0000${cid}`;
  function drawGrid(g) {
    const V = g.variants.length, C = g.cases.length;
    const thead = h('thead', {}, h('tr', {},
      h('th', { class: 'pe-corner' }, h('span', {}, 'case'), h('span', {}, 'variant')),
      ...g.variants.map((v, vi) => {
        const p = g.perVar[vi];
        const rate = p.answered ? p.pass / p.answered : 0;
        const tone = !p.answered ? '' : rate === 1 ? 'ok' : rate >= 0.6 ? 'warn' : 'bad';
        return h('th', { class: 'pe-vh' }, h('button', { class: `pe-hbtn${sel.kind === 'variant' && sel.v === vi ? ' sel' : ''}`, 'data-v': vi,
          onclick: () => select({ kind: 'variant', v: vi }) },
        h('span', { class: 'pe-vname' }, v.name),
        h('span', { class: 'pe-rate' }, h('span', { class: `pe-ratefill ${tone}`, style: `width:${(rate * 100).toFixed(1)}%` })),
        h('span', { class: 'pe-vstat' }, p.answered ? `${p.pass}/${p.answered} pass` : 'not run',
          p.judgeMean != null ? ` · judge ${p.judgeMean.toFixed(1)}` : '', p.msMean != null ? ` · ${Math.round(p.msMean)} ms` : '',
          p.cost != null ? ` · ${fmtCost(p.cost)}` : '')));
      }),
      h('th', { class: 'pe-add' }, h('button', { class: 'k-btn', title: 'Add a prompt variant', onclick: addVariant }, '+ variant'))));
    const tbody = h('tbody', {}, g.cases.map((k, ci) => h('tr', {},
      h('th', { class: 'pe-ch' }, h('button', { class: `pe-hbtn${sel.kind === 'case' && sel.c === ci ? ' sel' : ''}`, 'data-c': ci,
        onclick: () => select({ kind: 'case', c: ci }) },
      h('span', { class: 'pe-cid' }, k.id), k.title ? h('span', { class: 'pe-ctitle' }, k.title) : null,
      h('span', { class: 'pe-cin' }, k.input.replace(/\s+/g, ' ').slice(0, 70)))),
      ...g.variants.map((v, vi) => {
        const x = g.cells[ci * V + vi];
        const busy = running.has(key(v.id, k.id));
        const queued = queue.some((q) => q.v === vi && q.c === ci);
        const isSel = sel.kind === 'cell' && sel.v === vi && sel.c === ci;
        const main = busy ? '…' : x.status === 'pending' ? (queued ? 'queued' : '–') : x.status === 'error' ? 'error' : `${x.passed}/${x.decided}`;
        const sub = [x.judge?.score != null ? `judge ${x.judge.score}` : '', x.answer?.ms != null ? `${x.answer.ms} ms` : ''].filter(Boolean).join(' · ');
        return h('td', { class: 'pe-td' }, h('button', {
          class: `pe-cell st-${x.status}${x.sample ? ' sample' : ''}${x.stale ? ' stale' : ''}${busy ? ' busy' : ''}${isSel ? ' sel' : ''}`,
          'data-v': vi, 'data-c': ci, tabindex: isSel ? '0' : '-1',
          'aria-label': `${k.id} with ${v.name}: ${STATUS_TEXT[x.status]}${x.decided ? `, ${x.passed} of ${x.decided} checks` : ''}`,
          onclick: () => select({ kind: 'cell', v: vi, c: ci }) },
        h('b', {}, main), h('small', {}, busy ? 'running' : sub || (x.status === 'pending' ? 'not run' : STATUS_TEXT[x.status]))));
      }), h('td', {}))),
    h('tr', {}, h('th', { class: 'pe-add' }, h('button', { class: 'k-btn', title: 'Add a test case', onclick: addCase }, '+ case')), h('td', { colspan: V + 1 })));
    table.replaceChildren(thead, tbody);
    if (!V || !C) gridBox.append();
  }
  table.addEventListener('keydown', (e) => {
    const t = e.target.closest('.pe-cell');
    if (!t || !last?.grid) return;
    const mv = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (!mv) { if (e.key === 'r' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); runCells([{ v: Number(t.dataset.v), c: Number(t.dataset.c) }]); } return; }
    e.preventDefault();
    const v = clamp(Number(t.dataset.v) + mv[0], 0, last.grid.variants.length - 1), c = clamp(Number(t.dataset.c) + mv[1], 0, last.grid.cases.length - 1);
    select({ kind: 'cell', v, c });
    table.querySelector(`.pe-cell[data-v="${v}"][data-c="${c}"]`)?.focus();
  });

  function select(s) { sel = s; save(); editing = false; draw(); }

  // ---------- detail drawing ----------
  function drawDetail(g) {
    const a = document.activeElement;
    if (editing || (a && detail.contains(a) && a.matches('input, textarea'))) return;
    detail.replaceChildren();
    if (sel.kind === 'variant' && g.variants[sel.v]) return drawVariantEditor(g, sel.v);
    if (sel.kind === 'case' && g.cases[sel.c]) return drawCaseEditor(g, sel.c);
    const V = g.variants.length;
    const x = g.cells[clamp(sel.c ?? 0, 0, g.cases.length - 1) * V + clamp(sel.v ?? 0, 0, V - 1)];
    if (!x) { detail.append(h('div', { class: 'pe-empty' }, 'Add a variant and a case to start.')); return; }
    const v = g.variants[x.v], k = g.cases[x.c];
    const busy = running.has(key(v.id, k.id));
    detail.append(
      h('div', { class: 'pe-head' }, h('h2', {}, `${k.id} × ${v.name}`), h('span', { class: `pe-pill st-${x.status}` }, STATUS_TEXT[x.status]),
        x.sample ? h('span', { class: 'pe-tag' }, 'sample answer') : null, x.stale ? h('span', { class: 'pe-tag warn' }, 'prompt changed') : null,
        h('button', { class: 'k-btn pe-right', disabled: busy, onclick: () => runCells([{ v: x.v, c: x.c }]) }, busy ? 'Running…' : x.answer ? 'Run again' : 'Run this cell')),
      h('ul', { class: 'pe-checks' }, x.checks.map((r) => h('li', { class: r.pass === true ? 'ok' : r.pass === false ? 'bad' : 'na' },
        h('span', { class: 'pe-mark', 'aria-label': r.pass === true ? 'passed' : r.pass === false ? 'failed' : 'undecided' }, r.pass === true ? '✓' : r.pass === false ? '✗' : '–'),
        h('span', { class: 'pe-ck' }, r.label), h('span', { class: 'pe-cd' }, r.detail)))),
    );
    if (!x.checks.length) detail.append(h('div', { class: 'pe-empty' }, 'No checks apply to this cell.'));
    if (x.answer) {
      const a = x.answer;
      detail.append(h('div', { class: 'pe-sec' }, 'Answer', h('span', { class: 'pe-sub' },
        [a.model && `model ${a.model}`, a.ms != null && `${a.ms} ms`, a.pt != null && `${a.pt} in / ${a.ct ?? '?'} out tokens`, a.cost != null && fmtCost(a.cost)].filter(Boolean).join(' · '))),
      a.error ? h('div', { class: 'pe-err' }, a.error) : h('pre', { class: 'pe-ans' }, a.text || '(empty answer)'));
      if (x.judge) detail.append(h('div', { class: 'pe-sec' }, 'Judge'), h('div', { class: 'pe-judge' },
        x.judge.score != null ? h('b', {}, `${x.judge.score}/5`) : h('b', { class: 'bad' }, 'no score'), ' ', x.judge.reason || x.judge.error || ''));
    } else if (!busy) detail.append(h('div', { class: 'pe-empty' }, 'Not run yet. Run this cell, or Run missing for the whole grid.'));
    const expected = k.expected != null ? h('div', { class: 'pe-exp' }, h('span', { class: 'pe-sub' }, 'expected '), h('code', {}, k.expected)) : null;
    detail.append(expected, h('details', { class: 'pe-msgs' }, h('summary', {}, `Messages sent (${x.messages.length})`),
      ...x.messages.map((m) => h('div', { class: 'pe-msg' }, h('span', { class: 'pe-role' }, m.role), h('pre', {}, m.content)))));
  }

  // Replace lines [start, end) of an input's text with a new block. With
  // `after`, the answers can follow a renamed variant or case (their ids are
  // the names), so a rename does not orphan them.
  function splice(field, start, end, block, after) {
    const lines = String(ctx.raw[field] ?? '').replace(/\r\n?/g, '\n').split('\n');
    const next = end < lines.length;
    lines.splice(start, end - start, ...block.split('\n'), ...(next ? [''] : []));
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
    const answers = after ? after(field === 'variants' ? { variants: parseVariants(text), cases: [] } : { variants: [], cases: parseCases(text) }) : null;
    ctx.setMany(answers != null ? { [field]: text, answers } : { [field]: text });
  }
  function renameAnswers(field, from, to) {
    if (!to || from === to) return null;
    const { map } = parseAnswers(ctx.raw.answers || '');
    const taken = [...map.values()].some((o) => String(o[field]) === to);
    if (taken) return null;
    let moved = false;
    const out = [...map.values()].map((o) => { if (String(o[field]) === from) { moved = true; return { ...o, [field]: to }; } return o; });
    return moved ? out.map((o) => JSON.stringify(o)).join('\n') : null;
  }
  function drawVariantEditor(g, vi) {
    const v = g.variants[vi];
    const name = h('input', { class: 'pe-in', value: v.name, 'aria-label': 'Variant name', spellcheck: 'false' });
    const sys = h('textarea', { class: 'pe-ta', rows: 5, spellcheck: 'false', 'aria-label': 'System prompt' }); sys.value = v.system;
    const usr = h('textarea', { class: 'pe-ta', rows: 7, spellcheck: 'false', 'aria-label': 'User message template' }); usr.value = v.user;
    const push = () => {
      const cur = last.grid.variants[vi];
      splice('variants', cur.start, cur.end, `### ${name.value.trim() || `v${vi + 1}`}\n${sys.value.trim() ? `${sys.value.trim()}\n---\n` : ''}${usr.value.trim()}\n`,
        (next) => renameAnswers('variant', cur.id, next.variants[vi]?.id));
    };
    for (const el of [name, sys, usr]) el.addEventListener('input', push);
    const p = g.perVar[vi];
    detail.append(h('div', { class: 'pe-head' }, h('h2', {}, `Variant: ${v.name}`),
      h('span', { class: 'pe-sub' }, p.answered ? `${p.pass}/${p.answered} cases pass, ${p.checksPassed}/${p.checksDecided} checks` : 'not run'),
      h('button', { class: 'k-btn pe-right', onclick: () => runCells(g.cases.map((_, c) => ({ v: vi, c }))) }, 'Run column')),
    h('div', { class: 'pe-pad' },
      h('label', { class: 'pe-flab' }, 'Name', name),
      h('label', { class: 'pe-flab' }, 'System prompt (optional)', sys),
      h('label', { class: 'pe-flab' }, 'User message - {{input}} is replaced by the case', usr),
      /\{\{\s*input\s*\}\}/.test(v.system + v.user) ? null : h('div', { class: 'pe-err' }, 'No {{input}}: every case would send the same prompt.'),
      h('div', { class: 'pe-btns' },
        h('button', { class: 'k-btn', onclick: () => { const t = `### ${v.name}-copy\n${v.system ? `${v.system}\n---\n` : ''}${v.user}\n`; ctx.set('variants', `${String(ctx.raw.variants || '').replace(/\s+$/, '')}\n\n${t}`); } }, 'Duplicate'),
        h('button', { class: 'k-btn', onclick: () => { splice('variants', v.start, v.end, ''); select({ kind: 'cell', v: 0, c: 0 }); } }, 'Delete variant'))));
  }
  function drawCaseEditor(g, ci) {
    const k = g.cases[ci];
    const id = h('input', { class: 'pe-in', value: `${k.id}${k.title ? ` ${k.title}` : ''}`, 'aria-label': 'Case id and title', spellcheck: 'false' });
    const inp = h('textarea', { class: 'pe-ta', rows: 6, spellcheck: 'false', 'aria-label': 'Case input' }); inp.value = k.input;
    const exp = h('input', { class: 'pe-in', value: k.expected ?? '', 'aria-label': 'Expected answer', spellcheck: 'false' });
    const chk = h('textarea', { class: 'pe-ta', rows: 3, spellcheck: 'false', 'aria-label': 'Checks for this case' }); chk.value = k.checks.join('\n');
    const push = () => {
      const cur = last.grid.cases[ci];
      const checks = chk.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `check: ${l}`);
      splice('cases', cur.start, cur.end, [`### ${id.value.trim() || `c${ci + 1}`}`, inp.value.trim(), ...(exp.value.trim() ? [`expected: ${exp.value.trim()}`] : []), ...checks].join('\n') + '\n',
        (next) => renameAnswers('case', cur.id, next.cases[ci]?.id));
    };
    for (const el of [id, inp, exp, chk]) el.addEventListener('input', push);
    detail.append(h('div', { class: 'pe-head' }, h('h2', {}, `Case: ${k.id}`),
      h('button', { class: 'k-btn pe-right', onclick: () => runCells(g.variants.map((_, v) => ({ v, c: ci }))) }, 'Run row')),
    h('div', { class: 'pe-pad' },
      h('label', { class: 'pe-flab' }, 'Id and title', id),
      h('label', { class: 'pe-flab' }, 'Input ({{input}})', inp),
      h('label', { class: 'pe-flab' }, 'Expected (for equals_expected, contains_expected, {{expected}})', exp),
      h('label', { class: 'pe-flab' }, 'Checks for this case only, one per line', chk),
      h('div', { class: 'pe-btns' }, h('button', { class: 'k-btn', onclick: () => { splice('cases', k.start, k.end, ''); select({ kind: 'cell', v: 0, c: 0 }); } }, 'Delete case'))));
  }
  function addVariant() {
    const n = (last?.grid.variants.length || 0) + 1;
    ctx.set('variants', `${String(ctx.raw.variants || '').replace(/\s+$/, '')}\n\n### variant-${n}\n{{input}}\n`);
    select({ kind: 'variant', v: n - 1 });
  }
  function addCase() {
    const n = (last?.grid.cases.length || 0) + 1;
    ctx.set('cases', `${String(ctx.raw.cases || '').replace(/\s+$/, '')}\n\n### case-${n}\nThe input for this case\n`);
    select({ kind: 'case', c: n - 1 });
  }

  // ---------- running ----------
  const setStatus = (text, tone = '') => { status.className = `pe-status ${tone}`; status.textContent = text; };
  async function probe() {
    try {
      const r = await fetch('/api/tools/llm', { credentials: 'same-origin' });
      if (r.status === 404) throw new Error('404');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      server = { state: j.available ? 'ok' : 'nokey', models: j.models || [], def: j.default || '', maxTokens: j.max_tokens || 2000, perMinute: j.per_minute };
      setStatus(j.available ? `Model calls go through the app's server (${j.per_minute} a minute at most, answers up to ${j.max_tokens} tokens).`
        : 'The server has no model key configured, so Run is off. Scoring pasted answers still works.', j.available ? '' : 'warn');
    } catch (e) {
      server = { state: 'offline', models: [], def: '' };
      setStatus('Running prompts needs the Redline app (this page is served without its /api). Editing, checks and scoring of pasted answers work here.', 'warn');
    }
    drawBar();
  }
  function drawBar() {
    const cur = String(ctx.raw.model ?? '');
    const opts = [['', server.def ? `server default (${server.def})` : 'server default'], ...server.models.map((m) => [m, m])];
    if (cur && !server.models.includes(cur)) opts.push([cur, `${cur} (not offered)`]);
    modelSel.replaceChildren(...opts.map(([v, t]) => h('option', { value: v, selected: v === cur }, t)));
    if (document.activeElement !== tempIn) tempIn.value = ctx.raw.temperature ?? '0.2';
    if (document.activeElement !== maxIn) maxIn.value = ctx.raw.maxTokens ?? '300';
    const can = server.state === 'ok';
    const g = last?.grid;
    const missing = g ? g.cells.filter((x) => x.status === 'pending' || x.status === 'error' || x.stale || x.sample).length : 0;
    runMissing.textContent = `Run missing (${missing})`;
    runAll.textContent = `Run all (${g ? g.cells.length : 0})`;
    runMissing.disabled = !can || !missing || busyNow();
    runAll.disabled = !can || !g?.cells.length || busyNow();
    stopBtn.disabled = !busyNow();
    const pct = total ? (finished / total) * 100 : 0;
    progFill.style.width = `${pct.toFixed(1)}%`;
    prog.setAttribute('aria-valuenow', String(Math.round(pct)));
    progText.textContent = total ? `${finished}/${total}${running.size ? ` · ${running.size} running` : ''}${busyNow() ? '' : stopped ? ' stopped' : ' done'}` : '';
  }
  const busyNow = () => running.size > 0 || queue.length > 0;

  function start(which) {
    const g = last?.grid; if (!g) return;
    const cells = g.cells.filter((x) => which === 'all' || x.status === 'pending' || x.status === 'error' || x.stale || x.sample).map((x) => ({ v: x.v, c: x.c }));
    runCells(cells);
  }
  function runCells(cells) {
    if (server.state !== 'ok') { setStatus(server.state === 'nokey' ? 'The server has no model key configured.' : 'Running prompts needs the Redline app.', 'warn'); return; }
    const fresh = cells.filter((q) => !queue.some((x) => x.v === q.v && x.c === q.c) && !running.has(cellKey(q)));
    if (!busyNow()) { total = 0; finished = 0; }
    stopped = false;
    queue.push(...fresh); total += fresh.length;
    setStatus(`Running ${total} cell(s), ${CONCURRENCY} at a time…`);
    for (let i = running.size; i < CONCURRENCY; i++) worker();
    draw();
  }
  const cellKey = (q) => { const g = last.grid; return key(g.variants[q.v]?.id, g.cases[q.c]?.id); };
  function stop(msg) {
    stopped = true;
    queue = [];
    for (const c of controllers) c.abort();
    controllers = [];
    setStatus(msg, 'warn');
    draw();
  }

  async function call(messages, opts, signal) {
    const body = { messages, max_tokens: opts.max, temperature: opts.temp, tool: 'prompt-eval-grid' };
    if (opts.model) body.model = opts.model;
    const r = await fetch('/api/tools/llm', { method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' }, body: JSON.stringify(body) });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j); } catch { detail = r.statusText; }
      const err = new Error(detail || `HTTP ${r.status}`); err.status = r.status; throw err;
    }
    return r.json();
  }

  async function worker() {
    while (queue.length) {
      if (Date.now() < pausedUntil) { await new Promise((res) => setTimeout(res, pausedUntil - Date.now())); continue; }
      const q = queue.shift();
      const g = last.grid;
      const x = g.cells[q.c * g.variants.length + q.v];
      if (!x) { finished++; continue; }
      const v = g.variants[q.v], k = g.cases[q.c];
      const kk = key(v.id, k.id);
      running.add(kk); draw();
      const ctl = new AbortController(); controllers.push(ctl);
      const input = ctx.input;
      const opts = { model: input.model || '', temp: Number.isFinite(input.temperature) ? clamp(input.temperature, 0, 1.5) : 0.2,
        max: Number.isFinite(input.maxTokens) ? clamp(Math.round(input.maxTokens), 1, server.maxTokens || 2000) : 300 };
      let rec = null;
      try {
        const res = await call(x.messages, opts, ctl.signal);
        rec = { variant: v.id, case: k.id, text: res.text, ms: res.ms, prompt_tokens: res.usage?.prompt_tokens ?? null,
          completion_tokens: res.usage?.completion_tokens ?? null, cost: res.usage?.cost ?? null, model: res.model, hash: x.hash };
        const rubric = last.grid.rubric;
        if (rubric) {
          try {
            const jr = await call(judgeMessages(rubric, k, res.text), { ...opts, temp: 0, max: 200 }, ctl.signal);
            rec.judge_text = jr.text;
            if (jr.usage?.cost != null) rec.cost = (rec.cost ?? 0) + jr.usage.cost;
          } catch (e) { if (e.name === 'AbortError') throw e; rec.judge_error = `judge call failed: ${e.message}`; }
        }
      } catch (e) {
        if (e.name === 'AbortError') { running.delete(kk); finished++; continue; }
        if (e.status === 429) {
          queue.unshift(q); running.delete(kk);
          pausedUntil = Date.now() + 20000;
          setStatus('The server is at its model-call limit for this minute; waiting 20 s, then continuing.', 'warn');
          draw(); continue;
        }
        if (e.status === 404 || e.status === 503) {
          running.delete(kk); finished++;
          server.state = e.status === 404 ? 'offline' : 'nokey';
          stop(e.status === 404 ? 'Running prompts needs the Redline app.' : `The server cannot call a model: ${e.message}`);
          return;
        }
        rec = { variant: v.id, case: k.id, error: `${e.status ? `HTTP ${e.status}: ` : ''}${e.message}`.slice(0, 300), hash: x.hash };
      } finally {
        controllers = controllers.filter((c) => c !== ctl);
      }
      running.delete(kk); finished++;
      commit(rec);
    }
    if (!running.size && total) {
      if (stopped) setStatus(`Stopped after ${finished} of ${total} cell(s); answers so far are kept.`, 'warn');
      else setStatus(`Done: ${finished} of ${total} cell(s).`, 'ok');
    }
    draw();
  }
  function commit(rec) {
    const { map } = parseAnswers(ctx.raw.answers || '');
    map.set(key(rec.variant, rec.case), rec);
    ctx.set('answers', [...map.values()].map((o) => JSON.stringify(o)).join('\n'));
  }

  // ---------- page ----------
  function draw() {
    const g = last?.grid; if (!g) return;
    drawGrid(g); drawDetail(g); drawBar(); drawSetup();
    const w = last.warnings || [];
    warns.replaceChildren(...w.map((t) => h('div', {}, t)));
    warns.hidden = !w.length;
    notes.replaceChildren(...(last.notes || []).map((t) => h('div', {}, t)));
  }
  ctx.onResult((res) => { last = res; draw(); });
  probe();
}
