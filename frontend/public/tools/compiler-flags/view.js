// Compiler Flag Explainer: the page is the build log, read.
//   Log    - every command line of the log as it was pasted, the compiler
//            name first, each flag a chip coloured by what kind of flag it is
//            (files, includes and defines stay plain text). The gutter says
//            whether the line compiles or links and which -O it runs at; a
//            line off the build's usual -O is marked there. Click a chip to
//            read it; Delete (or the button) takes it out of that line, or
//            out of every line. "Edit text" opens the log as plain text.
//   Plane  - every code-changing flag of the build placed by what it does:
//            smaller / no change / larger across, faster / no change / slower
//            down; the goal's side is shaded. The flags the goal still wants
//            sit in their cell as dashed chips: click one to add it to the
//            right lines of the log.
//   Status - the -O level, size tendency and counts as the editor's status
//            bar; the warnings, the suggested Flags text and the outputs.
// Every classification shown comes from run()'s result (result.drawing / values).

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

const CSS = `
.cfx { --tool-opt: #1f4ed8; --tool-link: #0f8a7a; --tool-libc: #b45309; --tool-tgt: #8b3fb0; --tool-dbg: #5b6b7a; --tool-lang: #7a6a2f; --tool-good: #2f855a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .cfx {
  --tool-opt: #7b98ff; --tool-link: #3cc7b3; --tool-libc: #f0a33a; --tool-tgt: #c982e0; --tool-dbg: #93a5b5; --tool-lang: #cdbb6e; --tool-good: #68b36b; } }
:root[data-theme="dark"] .cfx { --tool-opt: #7b98ff; --tool-link: #3cc7b3; --tool-libc: #f0a33a; --tool-tgt: #c982e0; --tool-dbg: #93a5b5; --tool-lang: #cdbb6e; --tool-good: #68b36b; }
.cfx { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 540px); gap: 12px; align-items: start; min-width: 0; }
@media (max-width: 1000px) { .cfx { grid-template-columns: minmax(0, 1fr); } }
.cfx-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.cfx-pane { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.cfx-head { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.cfx-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.cfx-head .sub { font-size: 11.5px; color: var(--ink-soft); }
.cfx-head .r { margin-left: auto; display: flex; gap: 6px; }
.cfx-log { font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; background: var(--sunken); max-height: 520px; overflow: auto; }
.cfx-line { display: grid; grid-template-columns: 64px minmax(0, 1fr); border-bottom: 1px solid var(--line-soft); }
.cfx-line:last-child { border-bottom: 0; }
.cfx-gut { padding: 5px 6px; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; border-right: 1px solid var(--line); background: var(--surface); color: var(--ink-soft); font-size: 10.5px; }
.cfx-gut .n { font-size: 10px; opacity: .8; }
.cfx-gut .kind { font-weight: 600; letter-spacing: .03em; }
.cfx-gut .o { padding: 0 4px; border-radius: 3px; border: 1px solid var(--line); color: var(--ink); }
.cfx-gut .o.off { border-color: var(--warn); color: var(--warn); font-weight: 600; }
.cfx-gut .o.none { border-style: dashed; }
.cfx-toks { padding: 5px 8px; display: flex; flex-wrap: wrap; gap: 3px 4px; align-items: center; min-width: 0; }
.cfx-toks .cc { font-weight: 600; color: var(--ink); margin-right: 4px; }
.cfx-toks .arg { color: var(--ink-soft); opacity: .75; word-break: break-all; }
.cfx-toks .oth { color: var(--ink-soft); word-break: break-all; }
.cfx-chip { --kc: var(--tool-dbg); font: 12px "IBM Plex Mono", ui-monospace, monospace; padding: 0 5px; border-radius: 3px; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--kc) 55%, transparent); background: color-mix(in srgb, var(--kc) 13%, var(--surface)); color: var(--ink);
  word-break: break-all; text-align: left; line-height: 1.5; }
.cfx-chip:hover, .cfx-chip.hl { border-color: var(--kc); background: color-mix(in srgb, var(--kc) 26%, var(--surface)); }
.cfx-chip.sel { box-shadow: 0 0 0 2px var(--kc); border-color: var(--kc); }
.cfx-chip.unk { --kc: var(--warn); border-style: dashed; background: transparent; }
.cfx-chip.quiet { opacity: .7; }
.cfx-chip.much { border-width: 2px; padding: 0 4px; }
.cfx-chip.add { border-style: dashed; background: transparent; color: var(--ink-soft); }
.cfx-chip.add:hover { color: var(--ink); }
.cfx-chip.add b { color: var(--tool-good); font-weight: 600; }
.cfx-chip[disabled] { cursor: default; opacity: .6; }
.cfx-text { width: 100%; min-height: 180px; box-sizing: border-box; border: 0; border-top: 1px solid var(--line); background: var(--sunken); color: var(--ink);
  font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; padding: 8px 10px; resize: vertical; display: block; }
.cfx-status { display: flex; flex-wrap: wrap; gap: 0; border-top: 1px solid var(--line); background: var(--surface); font-size: 11px; color: var(--ink-soft); }
.cfx-status span { padding: 4px 10px; border-right: 1px solid var(--line-soft); white-space: nowrap; }
.cfx-status b { font: 500 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.cfx-status .warn b { color: var(--warn); } .cfx-status .bad b { color: var(--danger); } .cfx-status .ok b { color: var(--ok); }
.cfx-goals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 8px 10px 0; }
.cfx-goal { border: 1px solid var(--line); border-radius: 5px; background: var(--surface); padding: 5px 8px; text-align: left; cursor: pointer; color: var(--ink-soft); font-size: 11px; }
.cfx-goal b { display: block; color: var(--ink); font-size: 12.5px; font-weight: 600; }
.cfx-goal code { font-size: 11px; }
.cfx-goal[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.cfx-goal:hover { border-color: var(--ink-soft); }
.cfx-plane { display: grid; grid-template-columns: 22px repeat(3, minmax(0, 1fr)); grid-template-rows: auto repeat(3, minmax(82px, auto)); gap: 3px; padding: 8px 10px 10px; }
.cfx-plane .ax { font-size: 10.5px; color: var(--ink-soft); display: flex; align-items: center; justify-content: center; text-align: center; }
.cfx-plane .ay { writing-mode: vertical-rl; transform: rotate(180deg); }
.cfx-cell { border: 1px solid var(--line-soft); border-radius: 4px; padding: 5px; display: flex; flex-wrap: wrap; gap: 3px; align-content: flex-start; background: var(--surface); min-width: 0; }
.cfx-cell.goal { background: color-mix(in srgb, var(--tool-good) 9%, var(--surface)); border-color: color-mix(in srgb, var(--tool-good) 40%, var(--line-soft)); }
.cfx-cell.center { background: var(--sunken); }
.cfx-cell .cfx-chip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; font-size: 11.5px; }
.cfx-chip small { color: var(--ink-soft); font-size: 10.5px; }
.cfx-cell .cf { font-size: 10px; color: var(--ink-soft); width: 100%; }
.cfx-key { display: flex; flex-wrap: wrap; gap: 3px 10px; padding: 0 10px 8px; font-size: 10.5px; color: var(--ink-soft); }
.cfx-key i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 3px; vertical-align: -1px; border: 1px solid; }
.cfx-detail { padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.cfx-detail .fl { font: 600 14px "IBM Plex Mono", ui-monospace, monospace; word-break: break-all; }
.cfx-detail .eff { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11.5px; color: var(--ink-soft); }
.cfx-detail .eff b { font-weight: 600; }
.cfx-detail .eff b.g { color: var(--ok); } .cfx-detail .eff b.w { color: var(--warn); }
.cfx-detail .acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.cfx-detail .hint { color: var(--ink-soft); font-size: 11.5px; }
.cfx-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.cfx-warns div + div { margin-top: 4px; }
.cfx-warns:empty { display: none; }
.cfx-notes { font-size: 11.5px; color: var(--ink-soft); }
.cfx-notes summary { cursor: pointer; }
.cfx-notes div { margin-top: 4px; }
.cfx .k-out { max-height: 240px; }
@media (max-width: 560px) {
  .cfx-line { grid-template-columns: 48px minmax(0, 1fr); }
  .cfx-plane { grid-template-rows: auto repeat(3, minmax(64px, auto)); padding: 6px; }
  .cfx-goals { padding: 6px 6px 0; }
  .cfx-goal { padding: 4px 6px; }
  .cfx-cell { padding: 3px; }
  .cfx-cell .cfx-chip { white-space: normal; word-break: break-all; font-size: 11px; }
}
`;

const KIND = {
  optimise: ['opt', 'optimisation level / pass'], link: ['link', 'linker'], size: ['link', 'size (sections)'], speed: ['opt', 'speed'],
  libc: ['libc', 'C library'], target: ['tgt', 'target / ABI'], float: ['tgt', 'floating point'], abi: ['tgt', 'ABI'],
  debug: ['dbg', 'debug / instrumentation'], safety: ['dbg', 'safety'], report: ['dbg', 'report'], warning: ['dbg', 'warning'],
  c: ['lang', 'C semantics'], 'c++': ['lang', 'C++'], language: ['lang', 'language'],
};
const kc = (cat) => `var(--tool-${(KIND[cat] || ['dbg'])[0]})`;
const SIZE = { '--': 'much smaller', '-': 'smaller', '0': 'no change', '+': 'larger', '++': 'much larger', '?': 'depends' };
const SPEED = { '--': 'much slower', '-': 'slower', '0': 'no change', '+': 'faster', '++': 'much faster', '?': 'depends' };
const col3 = (v) => (v === '--' || v === '-' ? 0 : v === '+' || v === '++' ? 2 : 1);
const GOALS = [['size', 'Smallest flash', '-Os'], ['speed', 'Fastest code', '-O2'], ['debug', 'Debuggable', '-Og']];

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'cfx' });
  root.append(wrap);

  // ---------- log pane ----------
  const logSub = h('span', { class: 'sub' });
  const editBtn = h('button', { class: 'k-btn', 'aria-pressed': 'false', onclick: () => toggleEdit() }, 'Edit text');
  const logView = h('div', { class: 'cfx-log', role: 'list', 'aria-label': 'Build log, one command per row' });
  const textArea = h('textarea', { class: 'cfx-text', spellcheck: 'false', 'aria-label': 'Build log text', rows: 10, oninput: (e) => ctx.set('log', e.target.value) });
  textArea.style.display = 'none';
  const status = h('div', { class: 'cfx-status', role: 'status' });
  const logPane = h('section', { class: 'cfx-pane' },
    h('div', { class: 'cfx-head' }, h('h2', {}, 'Build log'), logSub, h('span', { class: 'r' }, editBtn)), logView, textArea, status);
  const warns = h('div', { class: 'cfx-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'cfx-notes' }, h('summary', {}, 'Notes and flags not in the table'));

  // ---------- plane pane ----------
  const goals = h('div', { class: 'cfx-goals', role: 'group', 'aria-label': 'Build goal' });
  const plane = h('div', { class: 'cfx-plane' });
  const key = h('div', { class: 'cfx-key' });
  const planePane = h('section', { class: 'cfx-pane' },
    h('div', { class: 'cfx-head' }, h('h2', {}, 'What the flags do'), h('span', { class: 'sub' }, 'size across, speed down; dashed = worth adding')),
    goals, plane, key);
  const detail = h('div', { class: 'cfx-detail', 'aria-live': 'polite' });
  const detailPane = h('section', { class: 'cfx-pane' }, detail);

  wrap.append(h('div', { class: 'cfx-col' }, logPane, warns, ctx.outputs, notes), h('div', { class: 'cfx-col' }, planePane, detailPane));

  let res = null;
  let sel = null; // { flag, line?, item?, missing? }
  let editing = false;

  function toggleEdit() {
    editing = !editing;
    editBtn.setAttribute('aria-pressed', String(editing));
    editBtn.textContent = editing ? 'Done' : 'Edit text';
    textArea.style.display = editing ? '' : 'none';
    logView.style.display = editing ? 'none' : '';
    if (editing) { textArea.value = ctx.raw.log ?? ''; textArea.focus(); }
  }

  // ---------- editing the log ----------
  // Rebuild a line with some tokens replaced ('' drops the token and the space before it).
  const rebuild = (L, repl) => {
    let raw = L.raw;
    for (let ti = L.toks.length - 1; ti >= 0; ti--) {
      if (!repl.has(ti)) continue;
      const [a, b] = L.toks[ti];
      const r = repl.get(ti);
      if (r === '') {
        let a2 = a;
        while (a2 > 0 && /[ \t]/.test(raw[a2 - 1])) a2--;
        const b2 = a2 === 0 ? b + raw.slice(b).match(/^[ \t]*/)[0].length : b;
        raw = raw.slice(0, a2) + raw.slice(b2);
      } else raw = raw.slice(0, a) + r + raw.slice(b);
    }
    return raw;
  };
  const lineWithout = (L, refs) => {
    const repl = new Map(), pieces = new Map();
    for (const [ti, k] of refs) {
      if (k == null) repl.set(ti, '');
      else { if (!pieces.has(ti)) pieces.set(ti, new Set()); pieces.get(ti).add(k); }
    }
    for (const [ti, drop] of pieces) {
      if (repl.has(ti)) continue;
      const parts = L.toks[ti][2].slice(4).split(',').filter(Boolean).filter((_, k) => !drop.has(k));
      repl.set(ti, parts.length ? '-Wl,' + parts.join(',') : '');
    }
    return rebuild(L, repl);
  };
  const setLines = (lines) => { sel = sel && sel.missing ? null : sel; ctx.set('log', lines.join('\n')); };
  function removeAt(li, ii) {
    const d = res.drawing;
    const lines = d.lines.map((L) => L.raw);
    lines[li] = lineWithout(d.lines[li], d.lines[li].items[ii].refs);
    setLines(lines);
  }
  function removeEverywhere(flag) {
    const d = res.drawing;
    setLines(d.lines.map((L) => {
      const refs = L.items.filter((it) => it.t === flag).flatMap((it) => it.refs);
      return refs.length ? lineWithout(L, refs) : L.raw;
    }));
    sel = null;
  }
  function addFlag(flag) {
    const d = res.drawing;
    const lines = d.lines.map((L) => L.raw);
    const idx = d.lines.map((L, i) => (L.toks.length ? i : -1)).filter((i) => i >= 0);
    const compile = idx.filter((i) => !d.lines[i].link), link = idx.filter((i) => d.lines[i].link);
    const insert = (i, f) => {
      const L = d.lines[i];
      const first = L.toks[0];
      if (!first || first[2].startsWith('-')) lines[i] = `${f} ${lines[i]}`.trimEnd();
      else lines[i] = lines[i].slice(0, first[1]) + ' ' + f + lines[i].slice(first[1]);
    };
    if (/^-O/.test(flag)) {
      let any = false;
      d.lines.forEach((L, i) => {
        const its = L.items.filter((it) => /^-O/.test(it.t));
        if (!its.length) return;
        any = true;
        const repl = new Map(its.map((it) => [it.refs[0][0], '']));
        repl.set(its.at(-1).refs[0][0], flag);
        lines[i] = rebuild(L, repl);
      });
      if (!any) for (const i of (compile.length ? compile : idx)) insert(i, flag);
    } else {
      const isLink = /^-Wl,|^--specs|^-u /.test(flag);
      const both = flag === '-flto';
      const targets = both ? idx : isLink ? (link.length ? link : idx) : (compile.length ? compile : idx);
      for (const i of targets) insert(i, flag);
    }
    sel = { flag };
    ctx.set('log', lines.join('\n'));
  }

  // ---------- the log ----------
  function drawLog(d) {
    const focusKey = document.activeElement?.dataset?.k || null;
    logView.replaceChildren();
    if (!d) { logSub.textContent = ''; return; }
    let shown = 0;
    d.lines.forEach((L, li) => {
      if (!L.toks.length) return;
      shown++;
      const toks = h('div', { class: 'cfx-toks' });
      L.items.forEach((it, ii) => {
        const k = `${li}:${ii}`;
        if (ii === 0 && it.kind === 'arg') { toks.append(h('span', { class: 'cc' }, it.t)); return; }
        if (it.kind === 'arg') { toks.append(h('span', { class: 'arg' }, it.t)); return; }
        if (it.kind === 'other') { toks.append(h('span', { class: 'oth', title: 'Include, define, file or output switch: no effect on the code the compiler makes' }, it.t)); return; }
        const f = d.flags[it.t];
        const unk = it.kind === 'unknown';
        const much = f && (f.size === '--' || f.size === '++' || f.speed === '--' || f.speed === '++');
        const cls = ['cfx-chip', unk ? 'unk' : '', f && ['warning', 'report'].includes(f.cat) ? 'quiet' : '', much ? 'much' : '',
          sel && sel.flag === it.t ? 'hl' : '', sel && sel.line === li && sel.item === ii ? 'sel' : ''].filter(Boolean).join(' ');
        const chip = h('button', { class: cls, style: f ? `--kc:${kc(f.cat)}` : null, 'data-k': k, 'data-flag': it.t,
          title: f ? `${it.t}: size ${SIZE[f.size]}, speed ${SPEED[f.speed]}. ${f.what}` : `${it.t}: not in the table - look it up in the GCC manual`,
          onclick: () => { sel = { flag: it.t, line: li, item: ii }; drawAllSel(); },
          onkeydown: (e) => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeAt(li, ii); } },
          onmouseenter: () => hover(it.t, true), onmouseleave: () => hover(it.t, false) }, it.t);
        toks.append(chip);
      });
      const off = L.o && d.mainO !== L.o && Object.keys(d.oCount).length > 1;
      const gut = h('div', { class: 'cfx-gut' }, h('span', { class: 'n' }, String(li + 1)), h('span', { class: 'kind' }, L.link ? 'link' : 'cc'),
        L.o ? h('span', { class: `o${off ? ' off' : ''}`, title: off ? `This line uses ${L.o}; most of the build uses ${d.mainO}` : `Optimisation level of this command` }, L.o)
          : !L.link ? h('span', { class: 'o none', title: 'No -O on this compile line: -O0' }, 'no -O') : null);
      logView.append(h('div', { class: 'cfx-line', role: 'listitem' }, gut, toks));
    });
    logSub.textContent = `${shown} command${shown === 1 ? '' : 's'} · click a flag to read it, Delete removes it`;
    if (focusKey) logView.querySelector(`[data-k="${focusKey}"]`)?.focus({ preventScroll: true });
  }
  function hover(flag, on) {
    for (const el of wrap.querySelectorAll('.cfx-chip[data-flag]')) if (el.dataset.flag === flag) el.classList.toggle('hl', on || (sel && sel.flag === flag));
  }

  // ---------- the plane ----------
  function drawPlane(d) {
    const g = ctx.raw.goal || 'size';
    goals.replaceChildren(...GOALS.map(([v, t, o]) => h('button', { class: 'cfx-goal', 'aria-pressed': String(g === v), onclick: () => ctx.set('goal', v) },
      h('b', {}, t), 'starts at ', h('code', {}, o))));
    plane.replaceChildren();
    if (!d) return;
    const cells = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => []));
    const entries = Object.entries(d.flags).filter(([, f]) => !['warning', 'report'].includes(f.cat));
    for (const [k, f] of entries) cells[2 - col3(f.speed)][col3(f.size)].push({ k, f });
    const missing = d.missing.filter((m) => m.size);
    for (const m of d.missing) {
      const f = m.size ? m : { size: '0', speed: '0' };
      cells[2 - col3(f.speed)][col3(f.size)].push({ k: m.flag, f: m, add: true });
    }
    void missing;
    const mag = (f) => (f.size?.length === 2 && f.size !== '?' ? 2 : 0) + (f.speed?.length === 2 && f.speed !== '?' ? 2 : 0);
    plane.append(h('div', {}), ...['smaller', 'no size change', 'larger'].map((t) => h('div', { class: 'ax' }, t)));
    ['faster', 'same speed', 'slower'].forEach((rowName, r) => {
      plane.append(h('div', { class: 'ax ay' }, rowName));
      for (let c = 0; c < 3; c++) {
        const goalCell = (g === 'size' && c === 0) || (g === 'speed' && r === 0) || (g === 'debug' && c === 1 && r === 1);
        const cell = h('div', { class: `cfx-cell${goalCell ? ' goal' : ''}${r === 1 && c === 1 ? ' center' : ''}` });
        const list = cells[r][c].sort((a, b) => (a.add - b.add) || (mag(b.f) - mag(a.f)) || a.k.localeCompare(b.k));
        if (!list.length) cell.append(h('span', { class: 'cf' }, '–'));
        for (const { k, f, add } of list) {
          if (add) {
            cell.append(h('button', { class: 'cfx-chip add', 'data-flag': k, disabled: f.placeholder || null,
              title: f.placeholder ? `${k}: set it for your part by hand` : `Add ${k} to the build: ${f.what || ''}`,
              onclick: () => { if (!f.placeholder) addFlag(k); },
              onfocus: () => { sel = { flag: k, missing: true }; drawDetail(res.drawing); } }, f.placeholder ? k : [h('b', {}, '+ '), k]));
          } else {
            const much = mag(f) > 0;
            cell.append(h('button', { class: `cfx-chip${much ? ' much' : ''}${sel && sel.flag === k ? ' sel' : ''}`, style: `--kc:${kc(f.cat)}`, 'data-flag': k,
              title: `size ${SIZE[f.size]}, speed ${SPEED[f.speed]}`,
              onclick: () => { sel = { flag: k }; drawAllSel(); },
              onmouseenter: () => hover(k, true), onmouseleave: () => hover(k, false) }, k, f.count > 1 ? h('small', {}, ` ×${f.count}`) : null));
          }
        }
        plane.append(cell);
      }
    });
    const used = [...new Set(Object.values(d.flags).map((f) => (KIND[f.cat] || ['dbg'])[0]))];
    const names = { opt: 'optimisation', link: 'linker / sections', libc: 'C library', tgt: 'target / float', dbg: 'debug / report', lang: 'language' };
    key.replaceChildren(...used.map((u) => h('span', {}, h('i', { style: `background:color-mix(in srgb,var(--tool-${u}) 20%,transparent);border-color:var(--tool-${u})` }), names[u])),
      h('span', {}, h('i', { style: 'border-width:2px;border-color:var(--ink-soft)' }), 'much'),
      h('span', {}, h('i', { style: 'border-style:dashed;border-color:var(--tool-good)' }), `worth adding for ${g}`));
  }

  // ---------- the detail ----------
  function drawDetail(d) {
    detail.replaceChildren();
    if (!d) return;
    if (!sel) {
      detail.append(h('div', { class: 'hint' }, 'Click a flag in the log or in the plane to see what it does and where it is; click a dashed one to add it.'));
      const top = Object.entries(d.flags).filter(([, f]) => f.cat === 'optimise')[0];
      if (top) detail.append(h('div', {}, h('span', { class: 'hint' }, 'This build: '), h('b', {}, d.mainO), h('span', { class: 'hint' }, ` - ${d.flags[d.mainO]?.what || ''}`)));
      return;
    }
    const f = d.flags[sel.flag] || d.missing.find((m) => m.flag === sel.flag);
    if (!f) { sel = null; drawDetail(d); return; }
    const isMissing = !d.flags[sel.flag];
    const good = (axis, v) => (d.goal === 'size' && axis === 'size' ? v.startsWith('-') : d.goal === 'speed' && axis === 'speed' ? v.startsWith('+') : false);
    const bad = (axis, v) => (d.goal === 'size' && axis === 'size' ? v.startsWith('+') : d.goal === 'speed' && axis === 'speed' ? v.startsWith('-') : false);
    const effB = (axis, v, words) => h('b', { class: good(axis, v) ? 'g' : bad(axis, v) ? 'w' : null }, words[v] || '–');
    detail.append(
      h('div', { class: 'fl', style: `color:${kc(f.cat)}` }, sel.flag),
      h('div', { class: 'eff' },
        h('span', {}, 'code size ', effB('size', f.size || '0', SIZE)),
        h('span', {}, 'speed ', effB('speed', f.speed || '0', SPEED)),
        h('span', {}, (KIND[f.cat] || [0, f.cat || '–'])[1])),
      h('div', {}, f.what || ''));
    if (isMissing) {
      detail.append(h('div', { class: 'hint' }, f.placeholder ? 'Not in the build. Set it for your part by hand.' : `Not in the build; the ${d.goal} build wants it.`));
      if (!f.placeholder) detail.append(h('div', { class: 'acts' }, h('button', { class: 'k-btn k-primary', onclick: () => addFlag(sel.flag) }, 'Add to the build')));
      return;
    }
    detail.append(h('div', { class: 'hint' }, `On line${f.lines.length === 1 ? '' : 's'} ${f.lines.map((i) => i + 1).join(', ')}${f.count > f.lines.length ? ` (${f.count} times)` : ''}.`));
    const acts = h('div', { class: 'acts' });
    if (sel.line != null) acts.append(h('button', { class: 'k-btn', onclick: () => removeAt(sel.line, sel.item) }, `Remove from line ${sel.line + 1}`));
    acts.append(h('button', { class: 'k-btn', onclick: () => removeEverywhere(sel.flag) }, f.lines.length > 1 || sel.line == null ? 'Remove from every line' : 'Remove'));
    detail.append(acts);
  }

  function drawAllSel() {
    const d = res && res.drawing;
    drawLog(d); drawPlane(d); drawDetail(d);
  }

  function drawStatus() {
    const vals = (res && res.values) || [];
    status.replaceChildren(...vals.map((v) => h('span', { class: v.tone || null, title: v.hint || null }, `${v.label} `, h('b', {}, String(v.value)))));
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes and flags not in the table'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }

  ctx.onResult((r) => {
    res = r;
    if (editing && document.activeElement !== textArea) textArea.value = ctx.raw.log ?? '';
    const d = r && r.drawing;
    if (sel && d && !d.flags[sel.flag] && !d.missing.some((m) => m.flag === sel.flag)) sel = null;
    if (sel && d && sel.line != null) {
      const it = d.lines[sel.line]?.items[sel.item];
      if (!it || it.t !== sel.flag) { sel = { flag: sel.flag }; }
    }
    drawAllSel();
    drawStatus();
  });
}
