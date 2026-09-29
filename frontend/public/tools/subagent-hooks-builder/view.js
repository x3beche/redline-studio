// Subagent & Hooks Builder, drawn as the thing itself.
// Hooks: the Claude Code session lifecycle as a vertical timeline - session
// start, each prompt, the agentic loop that repeats for every tool call, the
// subagent lane, stop, compaction and session end - with every hook drawn as a
// card on the event where it fires. Click + on an event to add a hook there,
// click a card to edit it (matcher chips for the tools it hits), drag a card
// to another event (or Alt+Up/Down on a focused card), Delete removes it. The
// rail explains the selected event: what exit 0, exit 2 and JSON output do.
// Subagent: the .claude/agents/<name>.md as a document edited in place, and
// the line the main agent sees when it chooses whom to delegate to.
// Everything drawn comes from run()'s result.lifecycle.

import { EVENTS, TOOLS } from './tool.js';

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
const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
const CHIP_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'mcp__.*'];
const BLOCKS = { UserPromptSubmit: 'can block', PreToolUse: 'can block', PermissionRequest: 'can deny', Stop: 'can continue', SubagentStop: 'can continue', PostToolUse: 'feedback' };
const PHASES = [
  { id: 'start', title: 'Session', events: ['SessionStart'] },
  { id: 'turn', title: 'Each prompt', box: true, events: ['UserPromptSubmit'], inner: [
    { id: 'loop', title: 'Agentic loop: repeats for every tool call', events: ['PreToolUse', 'PermissionRequest', '@tool', 'PostToolUse', 'PostToolUseFailure'] },
    { id: 'sub', title: 'Subagent (Agent tool)', events: ['SubagentStart', '@sub', 'SubagentStop'] },
  ], after: ['Notification', 'Stop'] },
  { id: 'end', title: 'Session', events: ['PreCompact', 'SessionEnd'] },
];

export function page(root, ctx) {
  const st = { sel: -1, ev: null, drag: null, focusRow: null, focusEv: null };
  const LC = () => ctx.result?.lifecycle || null;
  const hooksRaw = () => (Array.isArray(ctx.raw.hooks) ? ctx.raw.hooks : []).map((r) => ({ event: r.event || '', matcher: r.matcher ?? '', command: r.command ?? '', timeout: r.timeout ?? '' }));
  const setHooks = (rows) => ctx.set('hooks', rows);

  const modeSeg = h('div', { class: 'sh-seg', role: 'group', 'aria-label': 'What to build' });
  const modeBar = h('div', { class: 'sh-modebar' }, modeSeg, h('span', { class: 'sh-sub sh-verify' }, 'Claude Code behaviour as documented 2026-09 - verify against docs.claude.com'));
  const main = h('div', { class: 'sh-main' });
  const rail = h('aside', { class: 'sh-rail' });
  const notes = h('details', { class: 'sh-notes' }, h('summary', {}, 'Notes and sources'));
  root.append(modeBar, h('div', { class: 'sh' }, main, rail));

  // ======================= hooks =======================
  const life = h('div', { class: 'sh-life' });
  const lifeSub = h('span', { class: 'sh-sub' });
  const lifeCard = h('section', { class: 'sh-card' }, h('div', { class: 'sh-head' }, h('h2', {}, 'Session lifecycle'), lifeSub), life,
    h('div', { class: 'sh-hint' }, '+ adds a hook to that event · click a card to edit · drag a card to another event, or Alt+Up/Down on it · Delete removes'));
  const evCard = h('section', { class: 'sh-card sh-ev' });
  const lintList = h('ul', { class: 'sh-lint' });
  const lintSub = h('span', { class: 'sh-sub' });
  const lintCard = h('section', { class: 'sh-card' }, h('div', { class: 'sh-head' }, h('h2', {}, 'Lint'), lintSub), lintList);
  const exTa = h('textarea', { class: 'sh-ta', rows: 10, spellcheck: 'false', 'aria-label': 'Existing settings.json', placeholder: '{ "permissions": { ... } }',
    oninput: () => ctx.set('existing', exTa.value) });
  const targetSel = h('select', { class: 'sh-sel', 'aria-label': 'Settings file', onchange: () => ctx.set('hooksTarget', targetSel.value) },
    h('option', { value: 'project' }, '.claude/settings.json'), h('option', { value: 'local' }, '.claude/settings.local.json'), h('option', { value: 'user' }, '~/.claude/settings.json'));
  const exSub = h('span', { class: 'sh-sub' });
  const exCard = h('details', { class: 'sh-card sh-det' }, h('summary', { class: 'sh-head' }, h('h2', {}, 'Merge into'), targetSel, exSub), exTa,
    h('div', { class: 'sh-hint' }, 'Paste the current file; the output keeps every other key and skips hooks whose command is already there.'));

  function eventOf(id) { return EVENTS.find((e) => e.id === id); }

  function hookCard(r, lc) {
    const row = lc.rows[r];
    const ev = eventOf(row.event);
    const worst = row.lint.reduce((b, x) => ({ bad: 3, warn: 2, info: 1 }[x.sev] > ({ bad: 3, warn: 2, info: 1 }[b] || 0) ? x.sev : b), '');
    const mt = ev?.matcher === null ? null : row.matcher || (ev?.matcher === 'tool' ? '* all tools' : 'all');
    const card = h('div', { class: `sh-hook${worst ? ' s-' + worst : ''}${st.sel === r ? ' sel' : ''}${row.hot ? ' hot' : ''}`, tabindex: '0', role: 'button', 'data-r': r,
      'aria-label': `Hook ${r + 1} on ${row.event}${mt ? `, matcher ${mt}` : ''}: ${row.command}`, title: row.lint.map((x) => `${x.sev}: ${x.msg}`).join('\n') || row.command },
    h('div', { class: 'sh-hk1' },
      mt != null ? h('span', { class: `sh-m${row.matcher ? '' : ' all'}` }, mt) : null,
      h('span', { class: `sh-to${row.to ? '' : row.hot ? ' warn' : ''}` }, row.to ? `${row.to} s` : `${lc.defaultTimeout} s default`),
      row.hot ? h('span', { class: 'sh-hot', title: 'Runs on every matching tool call' }, 'every call') : null,
      worst ? h('span', { class: 'sh-dot' }, `${row.lint.length}`) : null),
    h('code', { class: 'sh-cmd' }, row.command || '(empty command)'));
    card.addEventListener('click', () => { if (st.drag?.moved) return; st.sel = st.sel === r ? -1 : r; st.ev = row.event; st.focusRow = r; draw(); });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = st.sel === r ? -1 : r; st.ev = row.event; st.focusRow = r; draw(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeHook(r); }
      else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const order = EVENTS.map((x) => x.id);
        const k = order.indexOf(row.event);
        const to = order[Math.max(0, Math.min(order.length - 1, k + (e.key === 'ArrowUp' ? -1 : 1)))];
        if (to && to !== row.event) moveHook(r, to);
      }
    });
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      st.drag = { r, x: e.clientX, y: e.clientY, moved: false, over: null };
      card.setPointerCapture(e.pointerId);
    });
    card.addEventListener('pointermove', (e) => {
      const d = st.drag; if (!d || d.r !== r) return;
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.moved = true; card.classList.add('dragging');
      card.style.transform = `translate(${e.clientX - d.x}px, ${e.clientY - d.y}px)`;
      const under = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains('sh-evrow'));
      for (const x of life.querySelectorAll('.sh-evrow.drop')) x.classList.remove('drop');
      d.over = under?.dataset.ev || null;
      if (under && d.over !== row.event) under.classList.add('drop');
    });
    const end = () => {
      const d = st.drag; if (!d || d.r !== r) return;
      card.style.transform = ''; card.classList.remove('dragging');
      for (const x of life.querySelectorAll('.sh-evrow.drop')) x.classList.remove('drop');
      if (d.moved && d.over && d.over !== row.event) moveHook(r, d.over);
      setTimeout(() => { st.drag = null; }, 0);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    return card;
  }

  function editor(r, lc) {
    const row = lc.rows[r];
    const ev = eventOf(row.event);
    const rows = hooksRaw();
    const upd = (k, v) => { const rs = hooksRaw(); rs[r][k] = v; setHooks(rs); };
    const m = h('input', { class: 'sh-in', type: 'text', spellcheck: 'false', value: rows[r]?.matcher ?? '', placeholder: ev?.matcher === 'tool' ? 'Bash, Edit|Write, mcp__github__.*' : ev?.values ? ev.values.join('|') : '(none)',
      disabled: ev?.matcher === null, 'aria-label': 'Matcher', oninput: (e) => upd('matcher', e.target.value) });
    const alts = String(rows[r]?.matcher ?? '').split('|').map((x) => x.trim()).filter(Boolean);
    const toggle = (t) => { const a = alts.includes(t) ? alts.filter((x) => x !== t) : [...alts, t]; upd('matcher', a.join('|')); };
    const chips = ev?.matcher === 'tool' ? CHIP_TOOLS : ev?.values || [];
    const hits = new Set(row.hits || []);
    const cmd = h('textarea', { class: 'sh-in sh-cmdin', rows: 2, spellcheck: 'false', 'aria-label': 'Command', oninput: (e) => { grow(e.target); upd('command', e.target.value); } });
    cmd.value = rows[r]?.command ?? '';
    setTimeout(() => grow(cmd), 0);
    const to = h('input', { class: 'sh-in sh-toin', type: 'text', inputmode: 'numeric', value: rows[r]?.timeout ?? '', placeholder: String(lc.defaultTimeout), 'aria-label': 'Timeout in seconds', oninput: (e) => upd('timeout', e.target.value) });
    const evSel = h('select', { class: 'sh-sel', 'aria-label': 'Event', onchange: (e) => moveHook(r, e.target.value) }, EVENTS.map((x) => h('option', { value: x.id, selected: x.id === row.event }, x.id)));
    return h('div', { class: 'sh-edit', 'data-r': r },
      h('div', { class: 'sh-erow' },
        h('label', {}, 'Event', evSel),
        h('label', { class: 'grow' }, ev?.matcher === 'tool' ? 'Matcher (tool names, A|B or a regex; empty = all)' : ev?.matcher ? `Matcher (${ev.matcher})` : 'Matcher (this event takes none)', m),
        h('label', {}, 'Timeout s', to)),
      chips.length ? h('div', { class: 'sh-chips' }, h('span', { class: 'sh-sub' }, ev?.matcher === 'tool' ? 'toggle:' : 'values:'),
        chips.map((t) => h('button', { type: 'button', class: `sh-chip${alts.includes(t) ? ' on' : ''}${!alts.includes(t) && hits.has(t) ? ' hit' : ''}`, 'aria-pressed': String(alts.includes(t)), onclick: () => toggle(t),
          title: hits.has(t) ? 'matched by the current matcher' : '' }, t))) : null,
      ev?.matcher === 'tool' ? h('div', { class: 'sh-sub' }, 'Hits: ', row.all ? 'every tool, MCP included' : (row.hits || []).length ? row.hits.join(', ') : h('b', { class: 'bad' }, 'no known tool')) : null,
      h('label', { class: 'sh-full' }, 'Command (runs in a shell; the event JSON arrives on stdin)', cmd),
      row.lint.length ? h('div', { class: 'sh-elint' }, row.lint.map((x) => h('div', { class: `s-${x.sev}` }, h('b', {}, x.sev), ' ', x.msg))) : null,
      h('div', { class: 'sh-acts' },
        h('button', { class: 'k-btn', type: 'button', onclick: () => { st.sel = -1; draw(); } }, 'Done'),
        h('button', { class: 'k-btn', type: 'button', onclick: () => removeHook(r) }, 'Delete hook')));
  }

  function addHook(evId) {
    const rs = hooksRaw();
    const ev = eventOf(evId);
    rs.push({ event: evId, matcher: ev.matcher === 'tool' ? 'Bash' : '', command: '', timeout: '10' });
    st.sel = rs.length - 1; st.ev = evId;
    setHooks(rs);
    setTimeout(() => life.querySelector('.sh-cmdin')?.focus(), 30);
  }
  function removeHook(r) {
    const rs = hooksRaw(); rs.splice(r, 1);
    st.sel = -1; setHooks(rs);
  }
  function moveHook(r, evId) {
    const rs = hooksRaw(); if (!rs[r]) return;
    const from = eventOf(rs[r].event), to = eventOf(evId);
    rs[r].event = evId;
    if (to?.matcher === null) rs[r].matcher = '';
    else if (from?.matcher !== to?.matcher) rs[r].matcher = to?.matcher === 'tool' ? (from?.matcher === 'tool' ? rs[r].matcher : '') : '';
    st.ev = evId; st.focusRow = r;
    setHooks(rs);
  }

  function evRow(id, lc) {
    if (id === '@tool') return h('div', { class: 'sh-pseudo' }, h('i'), h('span', {}, 'the tool runs'));
    if (id === '@sub') return h('div', { class: 'sh-pseudo' }, h('i'), h('span', {}, 'the subagent works (its own tool calls fire Pre/PostToolUse too)'));
    const e = lc.events.find((x) => x.id === id);
    const has = e.hooks.length;
    const lab = h('button', { class: `sh-evname${st.ev === id ? ' on' : ''}`, type: 'button', title: e.when, onclick: () => { st.ev = id; drawRail(); for (const b of life.querySelectorAll('.sh-evname')) b.classList.toggle('on', b.textContent.startsWith(id)); } },
      h('b', {}, id), BLOCKS[id] ? h('span', { class: `sh-blk ${BLOCKS[id] === 'feedback' ? 'fb' : ''}` }, BLOCKS[id]) : null);
    const cards = e.hooks.map((r) => hookCard(r, lc));
    const row = h('div', { class: `sh-evrow${has ? ' has' : ''}`, 'data-ev': id },
      h('span', { class: 'sh-node' }),
      h('div', { class: 'sh-evl' }, lab, h('div', { class: 'sh-when' }, e.when)),
      h('div', { class: 'sh-cards' }, cards,
        h('button', { class: 'sh-plus', type: 'button', title: `Add a hook on ${id}`, 'aria-label': `Add a hook on ${id}`, onclick: () => addHook(id) }, '+')));
    const frag = [row];
    const selHere = e.hooks.includes(st.sel);
    if (selHere) frag.push(editor(st.sel, lc));
    return frag;
  }

  function drawLife(lc) {
    // Typing in the open editor rebuilds the timeline: put the caret back.
    const a = document.activeElement;
    const keep = a && life.contains(a) && a.closest('.sh-edit') ? { label: a.getAttribute('aria-label'), s: a.selectionStart, e: a.selectionEnd } : null;
    const parts = [];
    for (const P of PHASES) {
      const rows = [];
      for (const id of P.events) rows.push(...[evRow(id, lc)].flat());
      if (P.inner) {
        for (const I of P.inner) {
          const inner = [];
          for (const id of I.events) inner.push(...[evRow(id, lc)].flat());
          rows.push(h('div', { class: `sh-box ${I.id === 'loop' ? 'sh-lp' : 'sh-sa'}` }, h('div', { class: 'sh-boxt' }, I.id === 'loop' ? h('span', { class: 'sh-loop', 'aria-hidden': 'true' }, '↻ ') : null, I.title), inner));
        }
        for (const id of P.after) rows.push(...[evRow(id, lc)].flat());
      }
      parts.push(P.box ? h('div', { class: 'sh-box sh-turn' }, h('div', { class: 'sh-boxt' }, P.title), rows) : h('div', { class: 'sh-phase' }, h('div', { class: 'sh-boxt' }, P.title), rows));
    }
    if (lc.orphans.length) parts.push(h('div', { class: 'sh-box sh-orph' }, h('div', { class: 'sh-boxt' }, 'Unknown event (fix the event name)'),
      h('div', { class: 'sh-cards' }, lc.orphans.map((r) => hookCard(r, lc))), lc.orphans.includes(st.sel) ? editor(st.sel, lc) : null));
    life.replaceChildren(...parts);
    if (keep) {
      const el = [...life.querySelectorAll('.sh-edit [aria-label]')].find((x) => x.getAttribute('aria-label') === keep.label);
      if (el) { el.focus({ preventScroll: true }); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.e); } catch { /* select */ } }
    }
    const hot = lc.rows.filter((r) => r.hot).length;
    lifeSub.textContent = `${lc.rows.length} hooks on ${lc.events.filter((e) => e.hooks.length).length} events · ${hot} on every tool call`;
  }

  function drawRail() {
    const lc = LC(); if (!lc || lc.mode !== 'hooks') return;
    const id = st.ev || lc.rows[0]?.event || 'PreToolUse';
    const e = lc.events.find((x) => x.id === id) || lc.events[2];
    evCard.replaceChildren(
      h('div', { class: 'sh-head' }, h('h2', {}, e.id), h('span', { class: 'sh-sub' }, e.matcher === null ? 'no matcher' : e.matcher === 'tool' ? 'matcher: tool name' : `matcher: ${e.matcher}`), BLOCKS[e.id] ? h('span', { class: 'sh-blk' }, BLOCKS[e.id]) : null),
      h('div', { class: 'sh-evbody' },
        h('p', {}, e.when),
        h('dl', { class: 'sh-dl' },
          h('dt', {}, 'exit 0'), h('dd', {}, e.exit0),
          h('dt', { class: 'x2' }, 'exit 2'), h('dd', {}, e.exit2),
          h('dt', {}, 'other'), h('dd', {}, 'Non-blocking error: stderr in verbose mode, the session goes on.'),
          h('dt', {}, 'JSON out'), h('dd', {}, h('code', {}, e.json), e.json !== '-' ? ' - plus continue, stopReason, suppressOutput, systemMessage' : ''),
          h('dt', {}, 'stdin'), h('dd', {}, 'session_id, transcript_path, cwd, hook_event_name, ', h('code', {}, e.input)),
          e.values ? [h('dt', {}, 'matches'), h('dd', {}, e.values.flatMap((v, k) => (k ? [' | ', h('code', {}, v)] : [h('code', {}, v)])))] : null),
        h('div', { class: 'sh-hint' }, `Timeout per command: ${lc.defaultTimeout} s unless set (verify). $CLAUDE_PROJECT_DIR is the project root. All of this: Claude Code docs as read 2026-09, verify.`)));
  }

  function drawHooks(lc) {
    if (!main.contains(lifeCard)) { main.replaceChildren(lifeCard); rail.replaceChildren(evCard, lintCard, exCard, ctx.outputs, notes); }
    drawLife(lc);
    drawRail();
    const c = { bad: 0, warn: 0, info: 0 };
    const all = lc.rows.flatMap((r) => r.lint);
    for (const x of all) c[x.sev]++;
    lintSub.textContent = `${c.bad} bad · ${c.warn} warn · ${c.info} info`;
    lintList.replaceChildren(...all.map((x) => h('li', { class: `s-${x.sev}` },
      h('button', { type: 'button', onclick: () => { st.sel = x.row; st.ev = lc.rows[x.row].event; st.focusRow = x.row; draw(); } },
        h('b', {}, `#${x.row + 1} ${lc.rows[x.row].event}`), ' ', x.msg))));
    if (!all.length) lintList.append(h('li', { class: 'sh-sub' }, 'Nothing to flag.'));
    if (document.activeElement !== exTa) exTa.value = ctx.raw.existing ?? '';
    targetSel.value = ctx.raw.hooksTarget || 'project';
    const mv = ctx.result.values.find((v) => v.label === 'Merge');
    exSub.textContent = mv ? `${mv.value}${mv.hint ? ' · ' + mv.hint : ''}` : '';
    exSub.className = `sh-sub${mv?.tone === 'bad' ? ' bad' : ''}`;
    if (st.focusRow != null) {
      const el = life.querySelector(`.sh-hook[data-r="${st.focusRow}"]`); st.focusRow = null;
      if (el && !life.querySelector('.sh-edit')?.contains(document.activeElement)) el.focus({ preventScroll: false });
    }
  }

  // ======================= subagent =======================
  const nameIn = h('input', { class: 'sh-in sh-bold', type: 'text', spellcheck: 'false', 'aria-label': 'name', oninput: () => ctx.set('agentName', nameIn.value) });
  const descIn = h('textarea', { class: 'sh-in', rows: 2, spellcheck: 'false', 'aria-label': 'description', oninput: () => { grow(descIn); ctx.set('agentDescription', descIn.value); } });
  const toolsBox = h('div', { class: 'sh-chips' });
  const modelSeg = h('div', { class: 'sh-seg small', role: 'group', 'aria-label': 'model' });
  const colorRow = h('div', { class: 'sh-colors', role: 'group', 'aria-label': 'colour' });
  const scopeSeg = h('div', { class: 'sh-seg small', role: 'group', 'aria-label': 'where' });
  const promptIn = h('textarea', { class: 'sh-in sh-prompt', rows: 14, spellcheck: 'false', 'aria-label': 'System prompt', oninput: () => { grow(promptIn); ctx.set('agentPrompt', promptIn.value); } });
  const slots = {};
  for (const k of ['name', 'description', 'tools', 'prompt']) slots[k] = h('div', { class: 'sh-slot' });
  const pathSub = h('span', { class: 'sh-sub' });
  const agentDoc = h('section', { class: 'sh-card sh-doc' },
    h('div', { class: 'sh-head' }, h('h2', {}, 'Agent file'), pathSub, h('span', { class: 'sh-grow' }), scopeSeg),
    h('div', { class: 'sh-fm' },
      h('div', { class: 'sh-dash' }, '---'),
      h('div', { class: 'sh-kv' }, h('span', { class: 'sh-k' }, 'name:'), h('div', {}, nameIn, slots.name)),
      h('div', { class: 'sh-kv' }, h('span', { class: 'sh-k' }, 'description:'), h('div', {}, descIn, slots.description)),
      h('div', { class: 'sh-kv' }, h('span', { class: 'sh-k' }, 'tools:'), h('div', {}, toolsBox, slots.tools)),
      h('div', { class: 'sh-kv' }, h('span', { class: 'sh-k' }, 'model:'), h('div', {}, modelSeg)),
      h('div', { class: 'sh-kv' }, h('span', { class: 'sh-k' }, 'color:'), h('div', {}, colorRow)),
      h('div', { class: 'sh-dash' }, '---')),
    h('div', { class: 'sh-pbody' }, promptIn, slots.prompt));
  const seesCard = h('section', { class: 'sh-card' });
  const aLint = h('section', { class: 'sh-card' });

  function drawAgent(lc) {
    if (!main.contains(agentDoc)) { main.replaceChildren(agentDoc); rail.replaceChildren(seesCard, aLint, ctx.outputs, notes); }
    const sv = (el, v) => { if (document.activeElement !== el && el.value !== v) { el.value = v; if (el.tagName === 'TEXTAREA') grow(el); } };
    sv(nameIn, ctx.raw.agentName ?? ''); sv(descIn, ctx.raw.agentDescription ?? ''); sv(promptIn, ctx.raw.agentPrompt ?? '');
    requestAnimationFrame(() => { grow(descIn); grow(promptIn); });
    pathSub.textContent = lc.path;
    const cur = String(ctx.raw.agentTools ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const setT = (list) => ctx.set('agentTools', list.join(', '));
    const known = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite'];
    toolsBox.replaceChildren(
      ...known.map((t) => h('button', { type: 'button', class: `sh-chip${cur.includes(t) ? ' on' : ''}`, 'aria-pressed': String(cur.includes(t)), onclick: () => setT(cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]) }, t)),
      ...cur.filter((t) => !known.includes(t)).map((t) => h('button', { type: 'button', class: `sh-chip on${lc.tools.find((x) => x.text === t)?.known ? '' : ' badc'}`, title: 'click to remove', onclick: () => setT(cur.filter((x) => x !== t)) }, `${t} ×`)),
      h('input', { class: 'sh-in sh-addt', type: 'text', spellcheck: 'false', placeholder: '+ mcp__server__tool', 'aria-label': 'Add a tool (Enter)',
        onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); setT([...cur, e.target.value.trim()]); } } }),
      ...(!cur.length ? [h('span', { class: 'sh-sub warn' }, 'none listed = inherits all tools')] : []));
    modelSeg.replaceChildren(...lc.models.map((m) => h('button', { type: 'button', 'aria-pressed': String((ctx.raw.agentModel || 'inherit') === m), onclick: () => ctx.set('agentModel', m) }, m)));
    colorRow.replaceChildren(...lc.colors.map((c) => h('button', { type: 'button', class: `sh-sw${c ? ' c-' + c : ' none'}`, 'aria-pressed': String((ctx.raw.agentColor || '') === c), 'aria-label': c || 'no colour', title: c || 'none', onclick: () => ctx.set('agentColor', c) }, c ? '' : '-')));
    scopeSeg.replaceChildren(...[['project', 'project'], ['user', 'personal']].map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String((ctx.raw.agentScope || 'project') === v), onclick: () => ctx.set('agentScope', v) }, t)));
    for (const k of Object.keys(slots)) slots[k].replaceChildren(...lc.lint.filter((x) => x.field === k).map((x) => h('div', { class: `s-${x.sev}` }, h('b', {}, x.sev), ' ', x.msg)));
    const nm = (ctx.raw.agentName || 'my-agent').trim();
    seesCard.replaceChildren(h('div', { class: 'sh-head' }, h('h2', {}, 'How the main agent sees it'), h('span', { class: 'sh-sub' }, `~${lc.descTokens} tokens in every session`)),
      h('div', { class: 'sh-sees' },
        h('div', { class: 'sh-sub' }, 'In the list of agent types it can delegate to:'),
        h('pre', { class: 'sh-line' }, lc.listing),
        h('div', { class: 'sh-sub' }, 'When it delegates, it calls the Agent tool with:'),
        h('pre', { class: 'sh-line' }, `subagent_type: "${nm}"\nprompt: "<the whole task: the subagent does not see this conversation>"`),
        h('div', { class: 'sh-sub' }, `The subagent runs with ${lc.tools.length ? lc.tools.map((t) => t.text).join(', ') : 'every tool of the session'} on model ${ctx.raw.agentModel || 'inherit'}, and only its final message comes back. (verify)`)));
    const c = { bad: 0, warn: 0, info: 0 }; for (const x of lc.lint) c[x.sev]++;
    aLint.replaceChildren(h('div', { class: 'sh-head' }, h('h2', {}, 'Lint'), h('span', { class: 'sh-sub' }, `${c.bad} bad · ${c.warn} warn · ${c.info} info`)),
      h('ul', { class: 'sh-lint' }, lc.lint.length ? lc.lint.map((x) => h('li', { class: `s-${x.sev}` }, h('span', {}, h('b', {}, x.field), ' ', x.msg))) : h('li', { class: 'sh-sub' }, 'Nothing to flag.')));
  }

  // ======================= both =======================
  function draw() {
    const lc = LC(); if (!lc) return;
    const mode = lc.mode;
    modeSeg.replaceChildren(...[['hooks', 'Hooks (settings.json)'], ['subagent', 'Subagent (.claude/agents)']].map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(mode === v), onclick: () => { if (mode !== v) ctx.set('mode', v); } }, t)));
    if (mode === 'hooks') drawHooks(lc); else drawAgent(lc);
    notes.replaceChildren(h('summary', {}, 'Notes and sources'), ...(ctx.result.notes || []).map((n) => h('div', {}, n)), ...(ctx.manifest.sources || []).map((n) => h('div', {}, n)));
  }
  ctx.onResult(() => draw());
  window.addEventListener('resize', () => { for (const t of root.querySelectorAll('textarea.sh-in')) grow(t); });
  void TOOLS;
}
