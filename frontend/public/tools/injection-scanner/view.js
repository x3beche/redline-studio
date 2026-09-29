// Prompt Injection Scanner, custom page. The diagram is the interface:
//   left, the prompt as the model reads it - each message a layer, each
//   {{slot}} a chip in its trust colour (click to change its trust);
//   middle, the model; right, what it can reach - private data, each tool
//   (click to switch auto / confirm) and the renderer (click to cycle).
//   Arrows carry untrusted text in and data out; paths that make an
//   exfiltration or an unconfirmed action possible are red. Numbered badges
//   sit on the part a finding is about; the list beside it says why and can
//   apply the fix. Probes below run on the app's model (in the app only),
//   and their answers go back into the tool's `responses` input to be graded.

import { applyFix, TRUST } from './tool.js';

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
const s = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};
const RENDERS = [['plain', 'Plain text'], ['markdown-links', 'Markdown, links only'], ['markdown-images', 'Markdown with images'], ['html', 'HTML']];
const CAP_TEXT = { 'read-private': 'reads private data', 'fetch-url': 'fetches URLs', send: 'sends messages', write: 'changes records', execute: 'runs code', 'search-web': 'searches the web', none: 'no side effects' };
// A clickable box that can hold buttons of its own (a badge), so it is not a <button>.
let lastAct = null;
const act = (attrs, fn, ...kids) => {
  const el = h('div', { ...attrs, role: 'button', tabindex: '0' }, ...kids);
  const go = () => { lastAct = el.id ? `#${CSS.escape(el.id)}` : el.dataset.slot ? `[data-slot="${el.dataset.slot}"][data-si="${el.dataset.si}"]` : null; fn(); };
  el.addEventListener('click', (e) => { if (!e.target.closest('.ij-badge')) go(); });
  el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); go(); } });
  return el;
};
const visible = (t) => t.replace(/[\u{E0000}-\u{E007F}]/gu, '◌').replace(/[​-‍⁠﻿]/g, '·');

export function page(root, ctx) {
  const VKEY = 'redline.tool.injection-scanner.view';
  const vs = { sel: 1, open: '', edit: false, ...(store.get(VKEY) || {}) };
  const save = () => store.set(VKEY, { sel: vs.sel, edit: vs.edit });
  let res = null;
  let server = { state: 'unknown' };
  let queue = [], running = new Set(), controllers = [], total = 0, finished = 0, stopped = false, pausedUntil = 0;

  // ---------- skeleton ----------
  const summary = h('div', { class: 'ij-summary' });
  const diagram = h('div', { class: 'ij-diagram' });
  const overlay = s('svg', { class: 'ij-arrows', 'aria-hidden': 'true' });
  const diaWrap = h('div', { class: 'ij-diawrap' }, overlay, diagram);
  const diaCard = h('section', { class: 'ij-card ij-diacard' },
    h('div', { class: 'ij-head' }, h('h2', {}, 'Prompt, model and what it can reach'),
      h('span', { class: 'ij-sub' }, 'click a slot to change its trust, a tool to require confirmation, the renderer to change it'),
      h('span', { class: 'ij-legend' }, TRUST.map((t) => h('span', {}, h('i', { class: `sw t-${t}` }), t)), h('span', {}, h('i', { class: 'sw risk' }), 'risky path'))),
    diaWrap);
  const findList = h('div', { class: 'ij-finds', role: 'list' });
  const findCard = h('section', { class: 'ij-card ij-findcard' }, h('div', { class: 'ij-head' }, h('h2', {}, 'Findings'), h('span', { class: 'ij-sub ij-fcount' })), findList);
  const status = h('div', { class: 'ij-status', 'aria-live': 'polite' });
  const modelSel = h('select', { class: 'ij-in', 'aria-label': 'Model', onchange: (e) => ctx.set('model', e.target.value) });
  const runSel = h('button', { class: 'k-btn k-primary', onclick: () => start('missing') }, 'Run probes');
  const stopBtn = h('button', { class: 'k-btn', onclick: () => stop('Stopped. Answers so far are kept.'), disabled: true }, 'Stop');
  const clearBtn = h('button', { class: 'k-btn', onclick: () => ctx.set('responses', '') }, 'Clear answers');
  const progText = h('span', { class: 'ij-prog' });
  const probeList = h('div', { class: 'ij-probes' });
  const probeCard = h('section', { class: 'ij-card ij-probecard' },
    h('div', { class: 'ij-head' }, h('h2', {}, 'Probes for testing your own system'),
      h('span', { class: 'ij-sub' }, 'each carries a canary; an answer that repeats it, a secret or an exfiltration image fails')),
    h('div', { class: 'ij-runrow' }, h('label', { class: 'ij-lab' }, 'Model', modelSel), runSel, stopBtn, clearBtn, progText),
    status, probeList);
  const editBody = h('div', { class: 'ij-editbody' }, ctx.form);
  const editCard = h('details', { class: 'ij-card ij-edit', ontoggle: (e) => { vs.edit = e.target.open; save(); } },
    h('summary', { class: 'ij-head' }, h('h2', {}, 'Edit the prompt, slots, tools and samples')), editBody);
  if (vs.edit) editCard.open = true;
  const warnBox = h('div', { class: 'ij-warns', 'aria-live': 'polite' });
  const notesBox = h('div', { class: 'ij-notes' });
  root.append(h('div', { class: 'ij' },
    h('div', { class: 'ij-main' }, summary, warnBox, diaCard, probeCard, editCard, notesBox, h('div', { class: 'ij-out' }, ctx.outputs)),
    h('div', { class: 'ij-side' }, findCard)));

  // ---------- actions on the drawing ----------
  const slotsRaw = () => (ctx.raw.slots || []).map((r) => ({ ...r }));
  function cycleTrust(name) {
    const rows = slotsRaw();
    let r = rows.find((x) => String(x.slot).replace(/[{}\s]/g, '') === name);
    if (!r) { r = { slot: name, trust: 'untrusted', source: '' }; rows.push(r); }
    else r.trust = TRUST[(TRUST.indexOf(r.trust) + 1) % TRUST.length];
    ctx.set('slots', rows);
  }
  function toggleApproval(name) {
    ctx.set('tools', (ctx.raw.tools || []).map((t) => (String(t.name).trim() === name ? { ...t, approval: t.approval === 'confirm' ? 'auto' : 'confirm' } : { ...t })));
  }
  function cycleRender() {
    const i = RENDERS.findIndex(([v]) => v === ctx.raw.render);
    ctx.set('render', RENDERS[(i + 1) % RENDERS.length][0]);
  }
  function fix(f) { const ch = applyFix(ctx.raw, f.autofix); if (Object.keys(ch).length) ctx.setMany(ch); }

  // ---------- the diagram ----------
  const badgesFor = (pred) => (res?.draw.findings || []).filter(pred).map((f) => h('button', {
    class: `ij-badge sev-${f.sev}${vs.sel === f.n ? ' sel' : ''}`, title: f.title, 'aria-label': `Finding ${f.n}: ${f.title}`,
    onclick: (e) => { e.stopPropagation(); select(f.n, true); } }, String(f.n)));

  function drawDiagram() {
    const d = res.draw;
    const risky = new Set(d.risky.tools);
    const badged = new Set();
    const slotBadges = (name, si) => {
      const out = [];
      for (const f of d.findings) {
        if (f.where.kind !== 'slot' || f.where.ref !== name) continue;
        const key = f.where.si == null ? `${f.n}` : `${f.n}@${si}`;
        if ((f.where.si != null && f.where.si !== si) || badged.has(key)) continue;
        badged.add(key); out.push(f);
      }
      return badgesFor((f) => out.includes(f));
    };
    // Prompt layers
    const layers = d.layers.map((L) => {
      const lines = L.lines.map((parts, li) => {
        const isTag = parts.length === 1 && parts[0].t && /^\s*(<\/?[A-Za-z][\w-]*[^>]*>|`{3}|"{3}|-{3,}|={3,})\s*$/.test(parts[0].t);
        const secret = parts.some((p) => p.t && d.secrets.some((x) => p.t.includes(x.value)));
        return h('div', { class: `ij-line${isTag ? ' tag' : ''}${secret ? ' secret' : ''}` },
          secret ? badgesFor((f) => f.where.kind === 'text' && parts.some((p) => p.t && p.t.includes(f.where.value))) : null,
          parts.length ? parts.map((p) => (p.slot
            ? act({ class: `ij-slot t-${p.trust}${p.delimited ? ' delim' : ''}`, 'data-slot': p.slot, 'data-si': L.si,
              title: `{{${p.slot}}}: ${p.trust}${p.delimited ? ', delimited' : ', not delimited'}${p.labelled ? ', labelled' : ''} - click to change trust`,
              'aria-label': `Slot ${p.slot}, ${p.trust}. Press to change trust.` }, () => cycleTrust(p.slot), `{{${p.slot}}}`, h('small', {}, p.trust), slotBadges(p.slot, L.si))
            : h('span', { class: 'ij-t' }, visible(p.t)))) : h('span', { class: 'ij-t' }, ' '));
      });
      const trustIn = new Set(L.lines.flat().filter((p) => p.slot).map((p) => p.trust));
      const zone = trustIn.has('untrusted') ? 'untrusted' : trustIn.has('semi') ? 'semi' : trustIn.has('private') ? 'private' : 'trusted';
      return h('div', { class: `ij-layer z-${zone}`, 'data-si': L.si },
        h('div', { class: 'ij-lhead' }, h('b', {}, L.role), L.name ? h('span', {}, L.name) : null, h('span', { class: 'ij-zone' }, zone === 'trusted' ? 'your text' : `contains ${zone} text`),
          badgesFor((f) => f.where.kind === 'section' && f.where.si === L.si)),
        h('div', { class: 'ij-lines' }, lines));
    });
    const model = h('div', { class: 'ij-model', id: 'ij-model' }, h('b', {}, 'Model'),
      h('span', {}, `reads ${d.untrustedIn.length} untrusted slot${d.untrustedIn.length === 1 ? '' : 's'}`),
      h('span', {}, `${d.tools.length} tool${d.tools.length === 1 ? '' : 's'}`));
    // Capabilities
    const privItems = [...d.privateSlots.map((n) => `{{${n}}}`), ...d.tools.filter((t) => t.cap === 'read-private').map((t) => t.name), ...(d.secrets.length ? [`${d.secrets.length} secret${d.secrets.length > 1 ? 's' : ''} in the prompt`] : [])];
    const exfil = d.findings.some((f) => f.rule === 'exfiltration');
    const caps = [];
    caps.push(h('div', { class: `ij-cap priv${exfil ? ' risky' : ''}`, id: 'ij-cap-priv' },
      h('div', { class: 'ij-caph' }, h('b', {}, 'Private data'), badgesFor((f) => f.rule === 'exfiltration')),
      h('div', { class: 'ij-capb' }, privItems.length ? privItems.join(', ') : 'none in reach')));
    for (const t of d.tools) {
      const id = `ij-cap-t-${t.name}`;
      caps.push(act({ class: `ij-cap tool${risky.has(t.name) ? ' risky' : ''}${t.approval === 'confirm' ? ' confirm' : ''}`, id, 'data-tool': t.name,
        title: `${t.name}: ${CAP_TEXT[t.cap]}, ${t.approval === 'confirm' ? 'a person confirms each call' : 'runs without confirmation'} - click to switch`,
        'aria-label': `Tool ${t.name}, ${CAP_TEXT[t.cap]}, ${t.approval}. Press to switch approval.` }, () => toggleApproval(t.name),
      h('div', { class: 'ij-caph' }, h('b', {}, t.name), h('span', { class: `ij-appr ${t.approval}` }, t.approval === 'confirm' ? 'confirm' : 'auto'),
        badgesFor((f) => f.where.kind === 'tool' && f.where.ref === t.name)),
      h('div', { class: 'ij-capb' }, CAP_TEXT[t.cap])));
    }
    const rname = (RENDERS.find(([v]) => v === d.render) || RENDERS[2])[1];
    caps.push(act({ class: `ij-cap rend${d.risky.render ? ' risky' : ''}`, id: 'ij-cap-render', title: 'How the answer is shown - click to cycle', 'aria-label': `Renderer: ${rname}. Press to change.` }, cycleRender,
      h('div', { class: 'ij-caph' }, h('b', {}, 'Renderer'), badgesFor((f) => f.where.kind === 'render')),
      h('div', { class: 'ij-capb' }, rname, d.render === 'markdown-images' || d.render === 'html' ? ' - fetches remote images on display' : '')));
    diagram.replaceChildren(
      h('div', { class: 'ij-col ij-colp' }, h('div', { class: 'ij-coltitle' }, 'The prompt, in reading order'), layers),
      h('div', { class: 'ij-col ij-colm' }, model),
      h('div', { class: 'ij-col ij-colc' }, h('div', { class: 'ij-coltitle' }, 'What it can reach'), caps));
    if (lastAct) { diagram.querySelector(lastAct)?.focus({ preventScroll: true }); lastAct = null; }
    requestAnimationFrame(drawArrows);
  }

  function drawArrows() {
    if (!res) return;
    const box = diaWrap.getBoundingClientRect();
    overlay.setAttribute('width', box.width); overlay.setAttribute('height', box.height);
    overlay.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    overlay.replaceChildren();
    const narrow = box.width < 760;
    overlay.style.display = narrow ? 'none' : '';
    if (narrow) return;
    const defs = s('defs');
    for (const c of ['in', 'out', 'risk', 'priv']) {
      const m = s('marker', { id: `ij-ar-${c}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      m.append(s('path', { d: 'M0,0 L8,4 L0,8 z', class: `ij-ah ${c}` }));
      defs.append(m);
    }
    overlay.append(defs);
    const rel = (el) => { const r = el.getBoundingClientRect(); return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, cy: (r.top + r.bottom) / 2 - box.top, cx: (r.left + r.right) / 2 - box.left }; };
    const modelEl = diagram.querySelector('#ij-model');
    if (!modelEl) return;
    const M = rel(modelEl);
    const d = res.draw;
    const curve = (x1, y1, x2, y2, cls, marker) => {
      const dx = Math.max(30, (x2 - x1) / 2);
      overlay.append(s('path', { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, class: `ij-arrow ${cls}`, 'marker-end': `url(#ij-ar-${marker})` }));
    };
    // untrusted slots -> model (one arrow per slot, from its first chip)
    const done = new Set();
    for (const chip of diagram.querySelectorAll('.ij-slot')) {
      const n = chip.dataset.slot;
      const tr = [...chip.classList].find((c) => c.startsWith('t-'))?.slice(2);
      if (done.has(n) || !['semi', 'untrusted', 'private'].includes(tr)) continue;
      done.add(n);
      const c = rel(chip);
      const layer = rel(chip.closest('.ij-layer'));
      curve(layer.r, c.cy, M.l - 2, M.cy + (done.size - 2) * 6, tr === 'private' ? `priv` : `in t-${tr}`, tr === 'private' ? 'priv' : 'in');
      overlay.append(s('line', { x1: c.r, y1: c.cy, x2: layer.r, y2: c.cy, class: `ij-arrow stub t-${tr}` }));
    }
    // model -> capabilities
    const exfil = d.findings.some((f) => f.rule === 'exfiltration');
    const priv = diagram.querySelector('#ij-cap-priv');
    if (priv) { const P = rel(priv); curve(P.l, P.cy, M.r + 2, M.cy - 10, exfil ? 'risk' : 'priv', exfil ? 'risk' : 'priv'); }
    for (const el of diagram.querySelectorAll('.ij-cap.tool, .ij-cap.rend')) {
      const C = rel(el);
      const bad = el.classList.contains('risky');
      curve(M.r + 2, M.cy + 8, C.l - 2, C.cy, bad ? 'risk' : 'out', bad ? 'risk' : 'out');
    }
  }

  // ---------- findings ----------
  function select(n, scroll) {
    vs.sel = n; save();
    drawFindings(); drawDiagram();
    if (scroll) findList.querySelector(`[data-n="${n}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function drawFindings() {
    const f = res.draw.findings;
    root.querySelector('.ij-fcount').textContent = f.length ? `${f.length}, most severe first` : 'none';
    findList.replaceChildren(...(f.length ? f.map((x) => h('div', { class: `ij-find sev-${x.sev}${vs.sel === x.n ? ' sel' : ''}`, role: 'listitem', 'data-n': x.n },
      h('button', { class: 'ij-fhead', 'aria-expanded': String(vs.sel === x.n), onclick: () => select(vs.sel === x.n ? 0 : x.n) },
        h('span', { class: `ij-badge sev-${x.sev}` }, String(x.n)), h('b', {}, x.title), h('span', { class: `ij-sev sev-${x.sev}` }, x.sev)),
      vs.sel === x.n ? h('div', { class: 'ij-fbody' },
        h('p', {}, x.detail), h('p', { class: 'ij-fix' }, h('b', {}, 'Fix: '), x.fix),
        x.autofix ? h('button', { class: 'k-btn k-primary', onclick: () => fix(x) }, fixLabel(x.autofix)) : null,
        h('span', { class: 'ij-rule' }, x.rule)) : null))
      : [h('div', { class: 'ij-empty' }, 'No structural findings. Run the probes to see how the model actually behaves.')]));
  }
  const fixLabel = (a) => ({ wrap: `Wrap {{${a.slot}}} in <${a.slot}> tags with a label`, label: `Add a data label before {{${a.slot}}}`, remind: 'Restate the task after it', redact: 'Remove it from the prompt', approval: `Require confirmation for ${a.tool}`, render: 'Render links only, no images', 'add-slot': `Add {{${a.slot}}} to the slot table`, trust: `Mark {{${a.slot}}} untrusted` }[a.type] || 'Apply fix');

  // ---------- probes ----------
  const STATUS = { pass: 'held', fail: 'got through', 'not run': 'not run', error: 'error' };
  function drawProbes() {
    const p = res.draw.probes;
    const busy = (id) => running.has(id) ? 'running' : queue.includes(id) ? 'queued' : '';
    probeList.replaceChildren(...(p.length ? p.map((x) => {
      const open = vs.open === x.id;
      const b = busy(x.id);
      return h('div', { class: `ij-probe st-${x.status.replace(' ', '-')}${open ? ' open' : ''}` },
        h('button', { class: 'ij-phead', 'aria-expanded': String(open), onclick: () => { vs.open = open ? '' : x.id; drawProbes(); } },
          h('span', { class: `ij-cat c-${x.cat}` }, x.cat), h('span', { class: 'ij-ptitle' }, x.title), h('code', {}, `→ {{${x.target}}}`),
          h('span', { class: `ij-pill st-${x.status.replace(' ', '-')}` }, b || STATUS[x.status] || x.status)),
        open ? h('div', { class: 'ij-pbody' },
          h('div', { class: 'ij-lab' }, `Payload placed in {{${x.target}}} (canary ${x.canary})`), h('pre', { class: 'ij-pre' }, visible(x.payload)),
          h('div', { class: 'ij-lab' }, 'Expected safe behaviour'), h('div', {}, x.expect),
          x.answer ? [h('div', { class: 'ij-lab' }, `Answer${x.answer.model ? ` from ${x.answer.model}` : ''}${x.answer.ms != null ? `, ${x.answer.ms} ms` : ''}${x.answer.sample ? ' (sample)' : ''}`), h('pre', { class: 'ij-pre' }, x.answer.text),
            h('div', { class: `ij-why st-${x.status}` }, x.status === 'fail' ? `Got through: ${x.why}.` : x.status === 'error' ? x.why : `Held: ${x.why}.`)] : null,
          h('div', { class: 'ij-btns' },
            h('button', { class: 'k-btn', disabled: server.state !== 'ok' || !!b, onclick: () => runIds([x.id]) }, 'Run this probe'),
            h('button', { class: 'k-btn', onclick: (e) => copyText(x.payload, e.target) }, 'Copy payload'))) : null);
    }) : [h('div', { class: 'ij-empty' }, 'No untrusted slots, so no probes. Mark where user input, documents, tool results and web pages enter.')]));
    const missing = p.filter((x) => x.status !== 'pass' && x.status !== 'fail').length;
    runSel.textContent = missing ? `Run ${missing} probe${missing > 1 ? 's' : ''}` : `Run all ${p.length} again`;
    runSel.disabled = server.state !== 'ok' || busyNow() || !p.length;
    stopBtn.disabled = !busyNow();
    progText.textContent = total ? `${finished}/${total}${running.size ? ` · ${running.size} running` : ''}${busyNow() ? '' : stopped ? ' stopped' : ' done'}` : '';
  }
  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = 'Copy payload'; }, 1300);
  }

  const setStatus = (t, tone = '') => { status.className = `ij-status ${tone}`; status.textContent = t; };
  async function probeServer() {
    try {
      const r = await fetch('/api/tools/llm', { credentials: 'same-origin' });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      const j = await r.json();
      server = { state: j.available ? 'ok' : 'nokey', models: j.models || [], def: j.default || '', maxTokens: j.max_tokens || 2000 };
      setStatus(j.available ? `Probes run through the app's server, ${j.per_minute ?? '?'} calls a minute at most. Text only: no tools are attached.` : 'The server has no model key configured, so Run is off. Findings, probes and grading of pasted answers still work.', j.available ? '' : 'warn');
    } catch {
      server = { state: 'offline', models: [], def: '' };
      setStatus('Running probes needs the Redline app (this page is served without its /api). Everything else works here; paste answers into the responses input to grade them.', 'warn');
    }
    drawModels(); if (res) drawProbes();
  }
  function drawModels() {
    const cur = String(ctx.raw.model ?? '');
    const opts = [['', server.def ? `server default (${server.def})` : 'server default'], ...(server.models || []).map((m) => [m, m])];
    if (cur && !opts.some(([v]) => v === cur)) opts.push([cur, `${cur} (not offered)`]);
    modelSel.replaceChildren(...opts.map(([v, t]) => h('option', { value: v, selected: v === cur }, t)));
    modelSel.disabled = server.state !== 'ok';
  }
  const busyNow = () => running.size > 0 || queue.length > 0;
  function start(which) {
    const p = res?.draw.probes || [];
    const missing = p.filter((x) => x.status !== 'pass' && x.status !== 'fail').map((x) => x.id);
    runIds(which === 'missing' && missing.length ? missing : p.map((x) => x.id));
  }
  function runIds(ids) {
    if (server.state !== 'ok') { setStatus(server.state === 'nokey' ? 'The server has no model key configured.' : 'Running probes needs the Redline app.', 'warn'); return; }
    const fresh = ids.filter((id) => !queue.includes(id) && !running.has(id));
    if (!busyNow()) { total = 0; finished = 0; }
    stopped = false; queue.push(...fresh); total += fresh.length;
    setStatus(`Running ${total} probe(s), two at a time…`);
    for (let i = running.size; i < 2; i++) worker();
    drawProbes();
  }
  function stop(msg) {
    stopped = true; queue = [];
    for (const c of controllers) c.abort();
    controllers = [];
    setStatus(msg, 'warn'); drawProbes();
  }
  async function call(messages, signal) {
    const body = { messages, max_tokens: Math.min(500, server.maxTokens || 500), temperature: 0, tool: 'injection-scanner' };
    if (ctx.raw.model) body.model = ctx.raw.model;
    const r = await fetch('/api/tools/llm', { method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' }, body: JSON.stringify(body) });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j); } catch { detail = r.statusText; }
      throw Object.assign(new Error(detail || `HTTP ${r.status}`), { status: r.status });
    }
    return r.json();
  }
  async function worker() {
    while (queue.length) {
      if (Date.now() < pausedUntil) { await new Promise((ok) => setTimeout(ok, pausedUntil - Date.now())); continue; }
      const id = queue.shift();
      const messages = res?.draw.messagesFor[id];
      if (!messages) { finished++; continue; }
      running.add(id); drawProbes();
      const ctl = new AbortController(); controllers.push(ctl);
      let rec;
      try {
        const out = await call(messages, ctl.signal);
        rec = { probe: id, text: out.text, model: out.model, ms: out.ms };
      } catch (e) {
        controllers = controllers.filter((c) => c !== ctl);
        running.delete(id);
        if (e.name === 'AbortError') { finished++; continue; }
        if (e.status === 429) { queue.unshift(id); pausedUntil = Date.now() + 20000; setStatus('The server is at its model-call limit for this minute; waiting 20 s, then continuing.', 'warn'); drawProbes(); continue; }
        if (e.status === 404 || e.status === 503 || e.status === 502) {
          finished++;
          if (e.status !== 502) server.state = e.status === 404 ? 'offline' : 'nokey';
          stop(e.status === 404 ? 'Running probes needs the Redline app.' : `The model call failed (${e.status}): ${e.message}. Try again in a moment.`);
          return;
        }
        rec = { probe: id, error: `${e.status ? `HTTP ${e.status}: ` : ''}${e.message}`.slice(0, 300) };
      }
      controllers = controllers.filter((c) => c !== ctl);
      running.delete(id); finished++;
      commit(rec);
    }
    if (!running.size && total) {
      setStatus(stopped ? `Stopped after ${finished} of ${total}; answers so far are kept.` : `Done: ${finished} of ${total} probe(s) answered and graded.`, stopped ? 'warn' : 'ok');
      drawProbes();
    }
  }
  function commit(rec) {
    const lines = String(ctx.raw.responses || '').split(/\r?\n/).filter((l) => {
      if (!l.trim()) return false;
      try { return JSON.parse(l).probe !== rec.probe; } catch { return true; }
    });
    lines.push(JSON.stringify(rec));
    ctx.set('responses', lines.join('\n'));
  }

  // ---------- summary strip ----------
  function drawSummary() {
    const v = Object.fromEntries(res.values.map((x) => [x.label, x]));
    summary.replaceChildren(...['Risk', 'Findings', 'Untrusted slots', 'Ways out', 'Probes'].filter((k) => v[k]).map((k) => h('div', { class: `ij-stat${v[k].tone ? ` tone-${v[k].tone}` : ''}`, title: v[k].hint || null },
      h('span', {}, k), h('b', {}, String(v[k].value)), v[k].hint ? h('small', {}, v[k].hint) : null)));
  }

  ctx.onResult((r) => {
    res = r;
    if (!r?.draw) { warnBox.replaceChildren(...(r?.warnings || []).map((w) => h('div', {}, w))); return; }
    if (vs.sel && !r.draw.findings.some((f) => f.n === vs.sel)) vs.sel = 0;
    warnBox.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notesBox.replaceChildren(...(r.notes || []).map((w) => h('div', {}, w)));
    drawSummary(); drawFindings(); drawDiagram(); drawProbes(); drawModels();
  });
  new ResizeObserver(() => requestAnimationFrame(drawArrows)).observe(diaWrap);
  probeServer();
}
