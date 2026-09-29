// U-Boot Env & bootargs Builder, drawn as the boot itself.
//   Chain    - ROM → SPL → U-Boot → each load (file, media, address) → the
//              boot command → Linux. A load assumed absent (boot.scr) is
//              dashed; click it to follow the path where it exists.
//   Command  - the kernel command line as chips, one per argument, coloured
//   line       by what it controls. Click a chip to edit or remove it: the
//              change goes into the variable and word it came from (mmcargs,
//              or mmcroot behind root=${mmcroot}). Add from the palette.
//   Script   - bootcmd as U-Boot runs it: every run, setenv, test and load,
//              expanded; each if with its branches, the taken one pressed -
//              press another to follow that path.
//   Variable - the selected variable: its value (edit it), what it runs and
//              references, who uses it; all variables below, the printenv to
//              paste over.
//   Load map - RAM with the kernel, DT, initrd where the path loads them;
//              drag a block to move its address variable, drag its right
//              edge to size it; overlaps in red.
//   Env      - the environment image to scale: header, each variable's
//   image      bytes, the free 0xff; CRC32, size, redundancy, fw_env.config,
//              and a check against the real mkenvimage.
// Everything drawn comes from run()'s result (result.uboot).

import { parseEnv, setVar, replaceWord, appendWord } from './envtext.js';

const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const put = (el, ...k) => el.replaceChildren(...k.flat().filter((x) => x != null && x !== false));
const MiB = 1048576;
const hex = (v) => '0x' + Math.max(0, Math.round(v)).toString(16).toUpperCase();
const human = (b) => (b >= MiB ? `${Number((b / MiB).toFixed(b % MiB ? 2 : 0))} MiB` : b >= 1024 ? `${Number((b / 1024).toFixed(b % 1024 ? 1 : 0))} KiB` : `${b} B`);
const sizeText = (b) => (b % MiB === 0 ? `${b / MiB}M` : b % 1024 === 0 ? `${b / 1024}K` : String(b));
const TAG = { load: 'LOAD', boot: 'BOOT', args: 'ARGS', env: 'SET', test: 'TEST', run: 'RUN', fdt: 'FDT', dev: 'DEV', echo: 'ECHO', script: 'SCRIPT', other: 'CMD', skip: 'SKIP', bad: 'ERR' };
const PALETTE = ['rootwait', 'ro', 'rw', 'quiet', 'loglevel=4', 'earlycon', 'panic=5', 'rootfstype=ext4', 'init=/sbin/init', 'cma=256M', 'rauc.slot=A', 'systemd.unit=multi-user.target', 'clk_ignore_unused', 'initcall_debug', 'printk.time=1'];
const SIZES = [['8K', 0x2000], ['16K', 0x4000], ['32K', 0x8000], ['64K', 0x10000], ['128K', 0x20000], ['256K', 0x40000]];

export function page(root, ctx) {
  const wrap = h('div', { class: 'ue' });
  root.append(wrap);
  let res = null;
  let selVar = null;
  let selNode = null;
  let selChip = null;
  let chipMsg = '';
  let frozen = null;
  let dragging = false;
  let checkOut = null;

  // ---------- panels ----------
  const panel = (cls, title, ...extra) => {
    const sub = h('span', { class: 'ue-sub' });
    const right = h('span', { class: 'ue-right' });
    const head = h('div', { class: 'ue-head' }, h('h2', {}, title), sub, ...extra, right);
    const body = h('div', { class: 'ue-body' });
    const el = h('section', { class: `ue-card ${cls}` }, head, body);
    return { el, sub, right, body, head };
  };
  const chainP = panel('ue-chainp', 'Boot chain');
  const argsP = panel('ue-argsp', 'Kernel command line');
  const warnBox = h('div', { class: 'ue-warns', role: 'status', 'aria-live': 'polite' });
  const traceP = panel('ue-tracep', 'Script as U-Boot runs it');
  const varP = panel('ue-varp', 'Variable');
  const mapP = panel('ue-mapp', 'Load map');
  const imgP = panel('ue-imgp', 'Environment image');
  const notes = h('details', { class: 'ue-notes' }, h('summary', {}, 'Notes'));
  const outWrap = h('div', { class: 'ue-out' }, ctx.outputs);
  wrap.append(chainP.el, argsP.el, warnBox, traceP.el, varP.el, mapP.el, imgP.el, notes, outWrap);

  // ---------- helpers that change the input ----------
  const envVars = () => parseEnv(ctx.raw.env).vars;
  const putVar = (name, value) => ctx.set('env', setVar(ctx.raw.env, name, value));
  const pickMap = () => {
    const m = new Map();
    for (const x of String(ctx.raw.picks || '').matchAll(/([^\s,=]+#\d+)\s*=\s*(then|else|elif\d+)/g)) m.set(x[1], x[2]);
    return m;
  };
  const setPick = (id, label) => {
    const m = pickMap();
    if (label == null) m.delete(id); else m.set(id, label);
    ctx.set('picks', [...m].map(([k, v]) => `${k}=${v}`).join(', '));
  };
  const focusKey = () => document.activeElement?.getAttribute?.('data-k') || null;
  const refocus = (k) => { if (!k) return; const el = wrap.querySelector(`[data-k="${CSS.escape(k)}"]`); if (el && document.activeElement !== el) el.focus({ preventScroll: true }); };

  // ================= chain =================
  function drawChain() {
    const U = res.uboot;
    const row = h('div', { class: 'ue-chain', role: 'list' });
    const ifFor = findIfsForLoads(U.trace);
    U.chain.forEach((st, i) => {
      if (i) row.append(h('span', { class: 'ue-arrow', 'aria-hidden': 'true' }, '→'));
      const cls = ['ue-st', `ue-st-${st.k}`, st.kind ? `ue-kind-${st.kind}` : '', st.k === 'load' && !st.ok ? 'absent' : '', st.forced ? 'forced' : '', st.node && st.node === selNode ? 'sel' : ''].filter(Boolean).join(' ');
      const title = st.k === 'load'
        ? (st.ok ? `${st.sub} → ${st.addr != null ? hex(st.addr) : '?'}${st.forced ? ' (followed by your pick)' : ''}. Click to show it in the script.` : `${st.label}: assumed absent on this board. Click to follow the path where it exists.`)
        : st.sub;
      const el = h('button', { class: cls, role: 'listitem', 'data-k': `st:${i}`, title,
        onclick: () => {
          if (st.k === 'load' && (!st.ok || st.forced) && ifFor.has(st.node)) {
            const f = ifFor.get(st.node);
            setPick(f.id, st.forced ? null : f.label);
            return;
          }
          if (st.node) { selNode = st.node; if (st.var) selVar = st.var; render(); scrollToNode(); }
        } },
      h('b', {}, st.label),
      h('span', {}, st.k === 'load' ? `${st.where}${st.addr != null ? ' → ' + hex(st.addr) : ''}` : st.sub),
      st.k === 'load' && !st.ok ? h('em', {}, 'absent · click to use') : st.forced ? h('em', {}, 'present (picked)') : null);
      row.append(el);
    });
    put(chainP.body, row);
    const boot = U.chain.find((s) => s.k === 'boot');
    put(chainP.sub, boot ? `${U.entry} boots with ${boot.label} (${U.arch})` : `${U.entry} does not reach a boot command`);
  }
  // which if (and which of its clauses) holds a load in its condition
  function findIfsForLoads(tr) {
    const map = new Map();
    const walk = (nodes, outer) => {
      for (const n of nodes || []) {
        if (n.k === 'run') walk(n.kids, outer);
        else if (n.k === 'cmd') { if (n.cls === 'load' && outer) map.set(n.id, outer); if (n.kids) walk(n.kids, outer); }
        else if (n.k === 'if') {
          for (const c of n.clauses) {
            if (c.cond) walk(c.cond, { id: n.ifId, label: c.label });
            if (c.body) walk(c.body, outer);
          }
        }
      }
    };
    if (tr) walk([tr], null);
    return map;
  }

  // ================= command line =================
  const addInput = h('input', { type: 'text', class: 'ue-in', spellcheck: 'false', placeholder: 'add: rootwait, loglevel=4 …', 'aria-label': 'Add a kernel argument', list: 'ue-argsug',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addArg(addInput.value.trim()); } } });
  const sug = h('datalist', { id: 'ue-argsug' }, PALETTE.map((p) => h('option', { value: p })));
  function addArg(text) {
    if (!text) return;
    const U = res.uboot;
    const key = text.split('=')[0];
    const same = U.chips.filter((c) => c.key === key);
    addInput.value = '';
    if (same.length && key !== 'console' && same[same.length - 1].edit && !same[same.length - 1].edit.whole) { editChip(same[same.length - 1], text); return; }
    const owner = U.argsOwner || 'bootargs';
    const vars = envVars();
    if (!vars.has(owner)) { putVar(owner, text); return; }
    putVar(owner, appendWord(vars.get(owner), text));
    selChip = U.chips.length;
  }
  function editChip(c, text) {
    const vars = envVars();
    const e = c.edit;
    chipMsg = '';
    if (!e) return;
    if (text != null && text.trim() === '') text = null;
    if (e.whole) { chipMsg = `This argument is part of ${c.tpl} in ${c.owner}; edit that variable.`; selVar = c.owner; render(); return; }
    if (e.var === c.owner && !e.prefix && !e.suffix) {
      putVar(c.owner, replaceWord(vars.get(c.owner) ?? '', e.word, text));
      if (text == null) selChip = null;
      return;
    }
    // mapped: word e.word of variable e.var, behind prefix/suffix in the template
    if (text == null) {
      if (e.word === 0 && e.prefix) { putVar(c.owner, replaceWord(vars.get(c.owner) ?? '', c.at ?? 0, null)); selChip = null; return; }
      putVar(e.var, replaceWord(vars.get(e.var) ?? '', e.word, null)); selChip = null; return;
    }
    if (!text.startsWith(e.prefix) || !text.endsWith(e.suffix)) { chipMsg = `This comes from ${c.tpl}: keep "${e.prefix}" in front, or edit ${e.var} directly.`; render(); return; }
    putVar(e.var, replaceWord(vars.get(e.var) ?? '', e.word, text.slice(e.prefix.length, text.length - e.suffix.length || undefined)));
  }
  function drawArgs() {
    const U = res.uboot;
    const chips = U.chips;
    const line = h('div', { class: 'ue-chips', role: 'toolbar', 'aria-label': 'Kernel arguments (arrows move, Enter edits, Delete removes)' });
    chips.forEach((c, i) => {
      const tone = c.flags.some((f) => f.tone === 'bad') ? 'bad' : c.flags.some((f) => f.tone === 'warn') ? 'warn' : '';
      const eq = c.arg.indexOf('=');
      const b = h('button', { class: `ue-chip cat-${c.cat} ${tone} ${selChip === i ? 'sel' : ''} ${c.known ? '' : 'unknown'}`, 'data-k': `chip:${i}`, tabindex: (selChip ?? 0) === i ? '0' : '-1',
        title: `${c.what}\nfrom ${[...(c.via || []), c.owner].join(' → ')}: ${c.tpl}${c.flags.length ? '\n' + c.flags.map((f) => '• ' + f.text).join('\n') : ''}`,
        onclick: () => { selChip = selChip === i ? null : i; chipMsg = ''; render(); refocus(`chip:${i}`); },
        onkeydown: (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const j = Math.max(0, Math.min(chips.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1))); selChip = j; render(); refocus(`chip:${j}`); }
          else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editChip(c, null); refocus(`chip:${Math.max(0, i - 1)}`); }
        } },
      eq > 0 ? [h('span', { class: 'k' }, c.arg.slice(0, eq)), h('span', { class: 'eq' }, '='), h('span', { class: 'v' }, c.arg.slice(eq + 1))] : h('span', { class: 'k' }, c.arg),
      tone ? h('i', { class: 'mark', 'aria-hidden': 'true' }, '!') : null);
      line.append(b);
    });
    if (!chips.length) line.append(h('span', { class: 'ue-empty' }, 'No bootargs on this path. Add arguments below; they go into ', h('code', {}, U.argsOwner || 'bootargs'), '.'));
    const ed = h('div', { class: 'ue-chiped' });
    const c = selChip != null ? chips[selChip] : null;
    if (c) {
      const inp = h('input', { type: 'text', class: 'ue-in wide', spellcheck: 'false', value: c.arg, 'data-k': 'chipedit', 'aria-label': 'Edit argument',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); editChip(c, inp.value); } if (e.key === 'Escape') { selChip = null; render(); } } });
      inp.value = c.arg;
      const path = [...(c.via || []), c.owner].filter((x, i, a) => a.indexOf(x) === i);
      ed.append(
        h('div', { class: 'ue-chiprow' }, inp,
          h('button', { class: 'k-btn k-primary', onclick: () => editChip(c, inp.value) }, 'Apply'),
          h('button', { class: 'k-btn', onclick: () => editChip(c, null) }, 'Remove'),
          h('span', { class: 'ue-src' }, 'from ', path.map((p, k) => [k ? ' → ' : '', h('button', { class: 'ue-link', onclick: () => { selVar = p; render(); } }, p)]), ' as ', h('code', {}, c.tpl))),
        h('div', { class: 'ue-what' }, h('b', {}, c.key), ' ', c.what),
        c.flags.map((f) => h('div', { class: `ue-flag ${f.tone}` }, f.text)),
        chipMsg ? h('div', { class: 'ue-flag warn' }, chipMsg) : null);
    }
    const pal = h('div', { class: 'ue-pal' }, h('span', { class: 'ue-soft' }, 'Add'), addInput, sug,
      PALETTE.slice(0, 11).filter((p) => !chips.some((x) => x.arg === p || (p.includes('=') && x.key === p.split('=')[0]))).slice(0, 8)
        .map((p) => h('button', { class: 'ue-add', title: `add ${p}`, onclick: () => addArg(p) }, '+ ' + p)));
    put(argsP.body, line, ed, pal);
    const lim = U.arch === 'arm64' ? 2047 : 1023;
    put(argsP.sub, h('b', { class: U.cmdline.length > lim ? 'bad' : '' }, `${U.cmdline.length}`), ` / ${lim} chars · ${chips.length} arguments · set in `, h('button', { class: 'ue-link', onclick: () => { selVar = U.argsOwner; render(); } }, U.argsOwner || '(nothing)'));
  }

  // ================= script trace =================
  const entrySel = h('select', { class: 'ue-sel', 'aria-label': 'Script to run', onchange: (e) => { selNode = null; ctx.set('entry', e.target.value); } });
  const clearPicks = h('button', { class: 'k-btn', onclick: () => ctx.set('picks', '') }, 'Clear picks');
  traceP.right.append(h('label', { class: 'ue-lbl' }, 'run ', entrySel), clearPicks);
  function row(n, text, note, extra) {
    const cls = ['ue-row', `c-${n.cls || n.k}`, n.st ? `s-${n.st}` : '', n.id === selNode ? 'sel' : ''].filter(Boolean).join(' ');
    return h('div', { class: cls, 'data-node': n.id },
      h('span', { class: 'ue-tag' }, TAG[n.cls] || (n.k === 'if' ? 'IF' : '')),
      h('button', { class: 'ue-cmd', 'data-k': `n:${n.id}`, title: n.src && n.src !== text ? `as written: ${n.src}` : null,
        onclick: () => { selNode = n.id; if (n.var) selVar = n.var; render(); refocus(`n:${n.id}`); } }, text),
      extra || null,
      note ? h('span', { class: 'ue-note' }, note) : null);
  }
  function drawNodes(nodes, into) {
    for (const n of nodes || []) {
      if (n.k === 'run') { drawNodes(n.kids, into); continue; }
      if (n.k === 'rest') { into.append(h('div', { class: 'ue-row s-skipped c-rest' }, h('span', { class: 'ue-tag' }, ''), h('span', { class: 'ue-dim', title: n.src }, `not reached: ${n.src.length > 120 ? n.src.slice(0, 120) + '…' : n.src}`))); continue; }
      if (n.k === 'cmd') {
        let note = n.note;
        if (n.st === 'fail' && !note) note = 'failed';
        into.append(row(n, n.exp || n.src, note));
        if (n.kids && n.kids.length) {
          for (const f of n.kids) {
            const box = h('div', { class: `ue-nest s-${f.st}` }, h('div', { class: 'ue-fh' }, h('button', { class: 'ue-link ue-var', onclick: () => { selVar = f.var; render(); } }, f.var), h('span', { class: `ue-fs-${f.st}` }, f.st === 'boot' ? 'boots' : f.st === 'fail' ? 'fails' : f.st === 'stop' ? 'resets' : '')));
            drawNodes(f.kids, box);
            into.append(box);
          }
        }
        continue;
      }
      if (n.k === 'if') {
        const seg = h('span', { class: 'ue-seg', role: 'group', 'aria-label': `branch of ${n.ifId}` },
          n.clauses.map((c) => h('button', { class: c.label === n.taken ? 'on' : '', 'aria-pressed': String(c.label === n.taken), 'data-k': `if:${n.ifId}:${c.label}`,
            title: c.label === n.taken ? (n.pick ? 'picked by you; press "auto" to let the conditions decide' : 'taken by the conditions') : `follow the ${c.label} branch instead`,
            onclick: () => { setPick(n.ifId, c.label); } }, c.label)),
          n.pick ? h('button', { class: 'auto', 'data-k': `if:${n.ifId}:auto`, title: 'let the conditions decide', onclick: () => setPick(n.ifId, null) }, 'auto') : null);
        const r = row({ ...n, cls: 'if', st: n.taken ? 'ok' : 'fail' }, `if · ${n.ifId}`, n.pick ? 'picked' : n.taken ? '' : 'no branch taken', seg);
        into.append(r);
        const box = h('div', { class: 'ue-nest ue-ifbox' });
        for (const c of n.clauses) {
          if (c.label !== 'else') {
            const cond = h('div', { class: 'ue-cond' }, h('span', { class: 'ue-clab' }, c.label === 'then' ? 'if' : 'elif'));
            if (c.cond) drawNodes(c.cond, cond);
            else cond.append(h('span', { class: 'ue-dim', title: c.condSrc }, `${c.condSrc}${c.forced ? '  (skipped: branch picked)' : ''}`));
            box.append(cond);
          }
          const body = h('div', { class: `ue-branch ${c.label === n.taken ? 'on' : 'off'}` }, h('span', { class: 'ue-clab' }, c.label === 'else' ? 'else' : 'then'));
          if (c.body) drawNodes(c.body, body);
          else body.append(h('span', { class: 'ue-dim', title: c.bodySrc }, c.bodySrc.length > 140 ? c.bodySrc.slice(0, 140) + '…' : c.bodySrc || '(empty)'));
          box.append(body);
        }
        into.append(box);
      }
    }
  }
  function drawTrace() {
    const U = res.uboot;
    const opts = [...new Set([U.entry, ...U.scripts])];
    put(entrySel, ...opts.map((o) => h('option', { value: o, selected: o === U.entry }, o)));
    clearPicks.hidden = !Object.keys(U.picks).length;
    const box = h('div', { class: 'ue-trace' });
    if (U.trace) {
      box.append(h('div', { class: 'ue-fh top' }, h('button', { class: 'ue-link ue-var', onclick: () => { selVar = U.entry; render(); } }, U.entry)));
      drawNodes([U.trace], box);
    } else box.append(h('div', { class: 'ue-empty' }, `${U.entry} is not defined in this environment.`));
    put(traceP.body, box);
    const n = Object.keys(U.picks).length;
    put(traceP.sub, n ? `${n} branch${n > 1 ? 'es' : ''} picked by you` : 'branches as the conditions decide');
  }
  function scrollToNode() {
    const el = selNode && traceP.body.querySelector(`[data-node="${selNode}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // ================= variable inspector =================
  const valBox = h('textarea', { class: 'ue-val', spellcheck: 'false', rows: 4, 'aria-label': 'Value of the selected variable',
    onchange: () => { if (selVar) putVar(selVar, valBox.value.replace(/\n/g, ' ')); },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); valBox.blur(); } } });
  const varHead = h('div', { class: 'ue-vh' });
  const varRel = h('div', { class: 'ue-rel' });
  const filter = h('input', { type: 'search', class: 'ue-in', placeholder: 'filter variables', 'aria-label': 'Filter variables', oninput: () => drawVarList() });
  const listBox = h('div', { class: 'ue-vlist', role: 'listbox', 'aria-label': 'Variables' });
  const newVar = h('input', { type: 'text', class: 'ue-in', spellcheck: 'false', placeholder: 'name=value', 'aria-label': 'Add a variable',
    onkeydown: (e) => { if (e.key === 'Enter') { const m = /^([^=\s]+)=(.*)$/.exec(newVar.value.trim()); if (m) { selVar = m[1]; newVar.value = ''; putVar(m[1], m[2]); } } } });
  const envArea = h('textarea', { class: 'ue-env', spellcheck: 'false', rows: 12, 'aria-label': 'printenv text' });
  let envTimer = null;
  envArea.addEventListener('input', () => { clearTimeout(envTimer); envTimer = setTimeout(() => ctx.set('env', envArea.value), 350); });
  const envDetails = h('details', { class: 'ue-envd' }, h('summary', {}, 'printenv text (paste yours here)'), envArea);
  varP.body.append(varHead, valBox, varRel, h('div', { class: 'ue-vtools' }, filter, newVar), listBox, envDetails);
  function drawVar() {
    const U = res.uboot;
    const v = U.vars.find((x) => x.name === selVar);
    if (!v) {
      put(varHead, h('b', {}, selVar || '—'), h('span', { class: 'ue-soft' }, selVar ? ' not in the environment' : ' pick a variable'));
      if (document.activeElement !== valBox) valBox.value = '';
      valBox.disabled = !selVar;
      put(varRel, selVar ? h('button', { class: 'k-btn', onclick: () => putVar(selVar, '') }, `Define ${selVar}`) : '');
    } else {
      valBox.disabled = false;
      if (document.activeElement !== valBox) valBox.value = v.value;
      put(varHead, h('b', {}, v.name),
        v.script ? h('span', { class: 'ue-badge' }, 'script') : null,
        !v.reach ? h('span', { class: 'ue-badge dim' }, `not used from ${U.entry}`) : null,
        v.undef.length ? h('span', { class: 'ue-badge bad' }, `${v.undef.length} undefined`) : null,
        h('span', { class: 'ue-soft' }, ` ${v.value.length + v.name.length + 2} bytes`),
        h('span', { class: 'ue-right' },
          v.script && v.name !== U.entry ? h('button', { class: 'k-btn', onclick: () => { selNode = null; ctx.set('entry', v.name); } }, 'Run this') : null,
          h('button', { class: 'k-btn', title: 'delete this variable', onclick: () => { putVar(v.name, null); } }, 'Delete')));
      const link = (n, bad) => h('button', { class: `ue-vref ${bad ? 'bad' : ''}`, onclick: () => { selVar = n; render(); } }, n);
      put(varRel, 
        v.runs.length ? h('div', {}, h('span', { class: 'ue-soft' }, 'runs '), v.runs.map((n) => link(n, v.undef.includes(n)))) : null,
        v.refs.length ? h('div', {}, h('span', { class: 'ue-soft' }, 'uses '), v.refs.map((n) => link(n, v.undef.includes(n)))) : null,
        v.by.length ? h('div', {}, h('span', { class: 'ue-soft' }, 'used by '), [...new Map(v.by.map((b) => [b.name, b])).values()].map((b) => link(b.name))) : null,
        v.setBy.length ? h('div', {}, h('span', { class: 'ue-soft' }, 'set at run time by '), v.setBy.map((n) => link(n))) : null,
        v.undef.length ? h('div', { class: 'ue-flag bad' }, `Never defined: ${v.undef.join(', ')} - click to define.`) : null);
    }
    drawVarList();
    if (document.activeElement !== envArea) envArea.value = ctx.raw.env;
  }
  function drawVarList() {
    const U = res.uboot;
    const q = filter.value.trim().toLowerCase();
    const undefNames = U.undef.filter((u) => !u.setBy.length).map((u) => u.name);
    const items = [
      ...undefNames.filter((n) => !q || n.toLowerCase().includes(q)).map((n) => ({ name: n, value: 'not defined', undef: true })),
      ...U.vars.filter((v) => !q || v.name.toLowerCase().includes(q) || v.value.toLowerCase().includes(q)),
    ];
    put(listBox, ...items.map((v) => h('button', { class: `ue-vi ${v.name === selVar ? 'sel' : ''} ${v.undef === true ? 'undef' : ''} ${v.reach === false ? 'dim' : ''}`, role: 'option', 'aria-selected': String(v.name === selVar), 'data-k': `v:${v.name}`,
      onclick: () => { selVar = v.name; render(); refocus(`v:${v.name}`); } },
    h('b', {}, v.name), h('span', {}, v.value))));
    put(varP.sub, `${U.vars.length} variables${undefNames.length ? ` · ${undefNames.length} undefined` : ''}`);
  }

  // ================= load map =================
  const mapSvg = sv('svg', { class: 'ue-svg', role: 'group', 'aria-label': 'Load map of RAM' });
  const fld = (key, label, cls) => {
    const el = h('input', { type: 'text', class: `ue-in ${cls || ''}`, spellcheck: 'false', 'aria-label': label, 'data-k': `f:${key}`,
      onchange: (e) => ctx.set(key, e.target.value.trim()) });
    return [h('label', { class: 'ue-f' }, h('span', {}, label), el), el];
  };
  const [ramBaseL, ramBaseI] = fld('ram_base', 'RAM start');
  const [ramSizeL, ramSizeI] = fld('ram_size', 'RAM size', 'short');
  const [kSizeL, kSizeI] = fld('kernel_size', 'Kernel', 'short');
  const [fSizeL, fSizeI] = fld('fdt_size', 'DT', 'short');
  const [iSizeL, iSizeI] = fld('initrd_size', 'initrd', 'short');
  const archSel = h('select', { class: 'ue-sel', 'aria-label': 'Architecture', onchange: (e) => ctx.set('arch', e.target.value) },
    [['auto', 'auto'], ['arm64', 'arm64'], ['arm', 'arm'], ['riscv', 'riscv']].map(([v, t]) => h('option', { value: v }, t)));
  const mapBar = h('div', { class: 'ue-bar' }, h('label', { class: 'ue-f' }, h('span', {}, 'Arch'), archSel), ramBaseL, ramSizeL, kSizeL, fSizeL, iSizeL);
  const mapHelp = h('div', { class: 'ue-help' }, 'Drag a block to move its address variable, its right edge to size it. Focused block: ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' 1 MiB (', h('kbd', {}, 'Shift'), ' 16 MiB, ', h('kbd', {}, 'Alt'), ' 64 KiB), ', h('kbd', {}, '+'), h('kbd', {}, '−'), ' size.');
  mapP.body.append(mapBar, mapSvg, mapHelp);
  const COLORS = { kernel: 'var(--tool-kern)', fdt: 'var(--tool-fdt)', initrd: 'var(--tool-rd)', overlay: 'var(--tool-fdt)', script: 'var(--tool-scr)', other: 'var(--tool-scr)', reloc: 'var(--tool-kern)', decomp: 'var(--tool-kern)' };
  function drawMap() {
    const U = res.uboot;
    const M = U.map;
    for (const [el, k] of [[ramBaseI, 'ram_base'], [ramSizeI, 'ram_size'], [kSizeI, 'kernel_size'], [fSizeI, 'fdt_size'], [iSizeI, 'initrd_size']]) if (document.activeElement !== el) el.value = ctx.raw[k] ?? '';
    archSel.value = ctx.raw.arch || 'auto';
    const items = [...M.items, ...M.derived];
    const W = Math.max(320, Math.round(mapP.body.clientWidth || 640));
    const narrow = W < 560;
    const L = narrow ? 8 : 150, R = 14, T = 30, LH = narrow ? 56 : 38;
    const H = T + Math.max(1, items.length) * LH + 12;
    mapSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    mapSvg.setAttribute('height', H);
    put(mapSvg, );
    let lo, hi;
    if (frozen) ({ lo, hi } = frozen);
    else {
      const span = Math.max(M.view.hi - M.view.lo, 4 * MiB);
      lo = Math.max(M.ramBase, Math.floor((M.view.lo - span * 0.08) / MiB) * MiB);
      hi = Math.ceil((M.view.hi + span * 0.08) / MiB) * MiB;
      if (M.ramSize) hi = Math.min(hi, M.ramBase + M.ramSize);
      if (hi <= lo) hi = lo + 4 * MiB;
    }
    const X = (a) => L + ((a - lo) / (hi - lo)) * (W - L - R);
    const per = (hi - lo) / (W - L - R);
    // axis
    const steps = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].map((x) => x * MiB);
    const step = steps.find((s) => (hi - lo) / s <= (narrow ? 2.5 : 7)) || 1024 * MiB;
    mapSvg.append(sv('rect', { x: L, y: T - 6, width: W - L - R, height: H - T, class: 'ue-ram' }));
    for (let a = Math.ceil(lo / step) * step; a <= hi; a += step) {
      mapSvg.append(sv('line', { x1: X(a), x2: X(a), y1: T - 6, y2: H - 6, class: 'ue-grid' }));
      if (X(a) >= L + 30 && X(a) <= W - R - 30) mapSvg.append(sv('text', { x: X(a), y: 12, class: 'ue-ax', 'text-anchor': 'middle' }, hex(a)));
    }
    if (M.ramSize && hi >= M.ramBase + M.ramSize) mapSvg.append(sv('text', { x: X(M.ramBase + M.ramSize) - 3, y: 24, class: 'ue-ax', 'text-anchor': 'end' }, 'end of RAM'));
    else mapSvg.append(sv('text', { x: W - R, y: 24, class: 'ue-ax', 'text-anchor': 'end' }, `RAM ${hex(M.ramBase)} + ${human(M.ramSize)}`));
    // overlaps behind the blocks
    for (const o of M.overlaps) {
      const x1 = Math.max(L, X(o.lo)), x2 = Math.min(W - R, X(o.hi));
      if (x2 <= x1 - 0.5) continue;
      mapSvg.append(sv('rect', { x: x1, y: T - 6, width: Math.max(2, x2 - x1), height: H - T, class: `ue-ovl ${o.tone}` }));
    }
    items.forEach((it, i) => {
      const y = T + i * LH;
      const x1 = X(it.addr), x2 = X(it.addr + it.size);
      const bx = Math.max(L - 2, Math.min(W - R, x1)), bw = Math.max(3, Math.min(W - R, x2) - bx);
      const g = sv('g', { class: `ue-blk ${it.used ? '' : 'dim'} ${it.derived ? 'derived' : ''} ${it.var && !it.derived ? 'drag' : ''}`, 'data-k': `blk:${i}` });
      if (!narrow) {
        g.append(sv('text', { x: 8, y: y + 12, class: 'ue-lane' }, it.label.length > 20 ? it.label.slice(0, 19) + '…' : it.label));
        g.append(sv('text', { x: 8, y: y + 25, class: 'ue-lane soft' }, it.var ? `\${${it.var}}` : it.derived ? it.from : it.used ? 'literal address' : it.ok ? 'not used' : 'absent'));
      } else g.append(sv('text', { x: 8, y: y + 9, class: 'ue-lane' }, `${it.label}${it.var ? ` · \${${it.var}}` : ''}`));
      const by = narrow ? y + 13 : y + 2;
      const bar = sv('rect', { x: bx, y: by, width: bw, height: 16, rx: 2, class: 'ue-bk', fill: COLORS[it.what] || 'var(--tool-scr)' });
      g.append(bar);
      const info = `${hex(it.addr)} – ${hex(it.addr + it.size)} · ${human(it.size)}${it.estimate ? ' (estimate)' : ''}`;
      if (narrow) g.append(sv('text', { x: 8, y: by + 30, class: 'ue-bt' }, info));
      else {
        const tx = bw > 190 ? bx + 6 : bx + bw + 6;
        const anchorEnd = tx > W - 190 && bx - 6 > L + 180;
        g.append(sv('text', { x: anchorEnd ? bx - 6 : Math.min(tx, W - R - 180), y: by + 12, class: `ue-bt ${bw > 190 ? 'in' : ''}`, 'text-anchor': anchorEnd ? 'end' : 'start' }, info));
      }
      g.append(sv('title', {}, `${it.label}: ${info}\n${it.from}${it.var ? `\naddress from \${${it.var}} - drag to move` : ''}`));
      if (it.outside) g.append(sv('text', { x: bx, y: by + 30, class: 'ue-bt bad' }, 'outside RAM'));
      if (it.var && !it.derived && it.used !== false) {
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'slider');
        g.setAttribute('aria-label', `${it.label} at ${hex(it.addr)}, size ${human(it.size)}`);
        g.setAttribute('aria-valuenow', String(it.addr));
        g.append(sv('rect', { x: bx - 2, y: by - 2, width: bw + 4, height: 20, rx: 3, class: 'ring', fill: 'none' }));
        const move = (a) => putVar(it.var, hex(Math.max(0, a)));
        bar.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          const x0 = e.clientX, a0 = it.addr;
          const scale = per * (W / mapSvg.getBoundingClientRect().width);
          frozen = { lo, hi };
          startDrag((ev) => {
            const snap = ev.altKey ? 0x1000 : ev.shiftKey ? 2 * MiB : 0x10000;
            const a = Math.round((a0 + (ev.clientX - x0) * scale) / snap) * snap;
            if (a !== res.uboot.map.items.find((q) => q.var === it.var)?.addr) move(a);
          });
        });
        g.addEventListener('keydown', (e) => {
          const big = e.shiftKey ? 16 * MiB : e.altKey ? 0x10000 : MiB;
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); move(it.addr + (e.key === 'ArrowRight' ? big : -big)); refocus(`blk:${i}`); }
          if ((e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') && it.sizeKey && ['kernel_size', 'fdt_size', 'initrd_size'].includes(it.sizeKey)) {
            e.preventDefault();
            const d = e.altKey ? 0x10000 : it.size >= 4 * MiB ? MiB : 0x10000;
            ctx.set(it.sizeKey, sizeText(Math.max(0, it.size + (e.key === '+' || e.key === '=' ? d : -d))));
            refocus(`blk:${i}`);
          }
        });
      }
      if (it.sizeKey && ['kernel_size', 'fdt_size', 'initrd_size'].includes(it.sizeKey) && !it.derived && it.used) {
        const hdl = sv('rect', { x: bx + bw - 4, y: by - 3, width: 8, height: 22, class: 'ue-hdl' });
        hdl.append(sv('title', {}, 'drag to size'));
        hdl.addEventListener('pointerdown', (e) => {
          e.preventDefault(); e.stopPropagation();
          const x0 = e.clientX, s0 = it.size;
          const scale = per * (W / mapSvg.getBoundingClientRect().width);
          frozen = { lo, hi };
          startDrag((ev) => {
            const snap = s0 >= 4 * MiB ? MiB / 4 : 0x1000;
            const s = Math.max(snap, Math.round((s0 + (ev.clientX - x0) * scale) / snap) * snap);
            ctx.set(it.sizeKey, sizeText(s));
          });
        });
        g.append(hdl);
      }
      mapSvg.append(g);
    });
    if (!items.length) mapSvg.append(sv('text', { x: L, y: T + 20, class: 'ue-ax' }, 'Nothing is loaded on this path.'));
    put(mapP.sub, M.bad ? h('b', { class: 'bad' }, `${M.bad} problem${M.bad > 1 ? 's' : ''}`) : h('b', { class: 'ok' }, 'no overlaps'), ` · ${M.bootCmd || 'no boot'} · ${U.arch}`);
  }
  function startDrag(onMove) {
    dragging = true;
    const move = (e) => onMove(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragging = false; frozen = null; render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ================= environment image =================
  const imgSvg = sv('svg', { class: 'ue-svg', role: 'img', 'aria-label': 'Environment image layout' });
  const sizeSeg = h('span', { class: 'ue-seg sizes', role: 'group', 'aria-label': 'Env size' });
  const redBox = h('input', { type: 'checkbox', onchange: (e) => ctx.set('redundant', e.target.checked) });
  const [devL, devI] = fld('env_dev', 'Device');
  const [offL, offI] = fld('env_offset', 'Offset', 'short');
  const [off2L, off2I] = fld('env_offset2', 'Copy 2', 'short');
  const [secL, secI] = fld('env_sector', 'Sector', 'short');
  const [szL, szI] = fld('env_size', 'Size', 'short');
  const crcBox = h('div', { class: 'ue-crc' });
  const fwLine = h('pre', { class: 'ue-fw' });
  const checkBtn = h('button', { class: 'k-btn', onclick: () => check() }, 'Check with mkenvimage');
  const checkRes = h('div', { class: 'ue-check', role: 'status' });
  imgP.body.append(h('div', { class: 'ue-bar' }, sizeSeg, szL, h('label', { class: 'ue-f chk' }, redBox, h('span', {}, 'redundant')), devL, offL, off2L, secL),
    crcBox, imgSvg, fwLine, h('div', { class: 'ue-bar' }, checkBtn, checkRes));
  async function check() {
    const U = res.uboot;
    const text = parseEnv(ctx.raw.env).order.map((n) => `${n}=${envVars().get(n)}`).join('\n') + '\n';
    checkRes.textContent = 'running mkenvimage…';
    try {
      const r = await fetch('/api/tools/check', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' },
        body: JSON.stringify({ kind: 'ubootenv', input: text, size: ctx.raw.env_size, redundant: !!ctx.raw.redundant }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      checkOut = { crc: U.image.stored, j };
    } catch (e) {
      checkOut = { err: `The mkenvimage check runs only inside the app (${e.message || e}). The CRC above is computed here the same way.` };
    }
    drawCheck();
  }
  function drawCheck() {
    if (!checkOut) { put(checkRes, ); return; }
    if (checkOut.err) { put(checkRes, h('span', { class: 'ue-soft' }, checkOut.err)); return; }
    const j = checkOut.j;
    if (!j.ok) { put(checkRes, h('span', { class: 'bad' }, `mkenvimage: ${(j.errors || []).map((e) => e.message || e).join('; ') || 'failed'}`)); return; }
    const same = String(j.crc).toLowerCase() === String(checkOut.crc).toLowerCase();
    put(checkRes, h('span', { class: same ? 'ok' : 'bad' }, same ? `mkenvimage agrees: CRC bytes ${j.crc}, ${j.size} bytes` : `mkenvimage wrote CRC bytes ${j.crc}, here ${checkOut.crc}`));
  }
  function drawImage() {
    const U = res.uboot;
    const I = U.image;
    for (const [el, k] of [[devI, 'env_dev'], [offI, 'env_offset'], [off2I, 'env_offset2'], [secI, 'env_sector'], [szI, 'env_size']]) if (document.activeElement !== el) el.value = ctx.raw[k] ?? '';
    off2L.hidden = !ctx.raw.redundant;
    secL.hidden = !/\/dev\/mtd/.test(ctx.raw.env_dev || '');
    redBox.checked = !!ctx.raw.redundant;
    put(sizeSeg, ...SIZES.map(([t, v]) => h('button', { class: v === I.size ? 'on' : '', 'aria-pressed': String(v === I.size), 'data-k': `sz:${v}`, onclick: () => { ctx.set('env_size', hex(v)); refocus(`sz:${v}`); } }, t)));
    put(crcBox, 
      h('div', {}, h('span', { class: 'ue-soft' }, 'CRC32 '), h('b', { class: 'big' }, I.fits && I.size ? `0x${I.crc.toUpperCase()}` : '—'), I.fits && I.size ? h('span', { class: 'ue-soft' }, ` stored ${I.stored.match(/../g).join(' ')}${I.red ? ' 01' : ''}`) : null),
      h('div', {}, h('span', { class: 'ue-soft' }, 'used '), h('b', { class: I.fits ? (I.used > I.dataSize * 0.8 ? 'warn' : '') : 'bad' }, `${I.used}`), h('span', { class: 'ue-soft' }, ` of ${I.dataSize} bytes · ${I.dataSize ? Math.round((I.used / I.dataSize) * 100) : 0}%`)));
    // to scale: header | data used | free (0xff)
    const W = Math.max(300, Math.round(imgP.body.clientWidth || 420)) - 20;
    const copies = I.red ? 2 : 1;
    const H = 18 + copies * 28 + 18 + 48;
    imgSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    imgSvg.setAttribute('height', H);
    put(imgSvg, );
    const total = Math.max(I.size, I.used + I.header, 1);
    const X = (b) => 4 + (b / total) * (W - 8);
    for (let c = 0; c < copies; c++) {
      const y = 18 + c * 28;
      imgSvg.append(sv('text', { x: 4, y: y - 4, class: 'ue-ax' }, copies > 1 ? `copy ${c + 1} @ ${c ? ctx.raw.env_offset2 : ctx.raw.env_offset}` : `@ ${ctx.raw.env_offset} on ${ctx.raw.env_dev}`));
      imgSvg.append(sv('rect', { x: X(0), y, width: X(I.size) - X(0), height: 18, class: 'ue-free' }));
      imgSvg.append(sv('rect', { x: X(0), y, width: Math.max(2, X(I.header) - X(0)), height: 18, class: 'ue-hdr' }));
      imgSvg.append(sv('rect', { x: X(I.header), y, width: Math.max(1, X(I.header + I.used) - X(I.header)), height: 18, class: I.fits ? 'ue-used' : 'ue-over' }));
    }
    const yl = 18 + copies * 28 + 2;
    imgSvg.append(sv('text', { x: X(I.size), y: yl, class: 'ue-ax', 'text-anchor': 'end' }, `${hex(I.size)}`));
    imgSvg.append(sv('text', { x: 4, y: yl, class: 'ue-ax' }, `CRC${I.red ? '+flag' : ''} | data to ${hex(I.header + I.used)} | 0xff to the end`));
    // the used bytes, variable by variable
    const y2 = yl + 16;
    const segs = I.segs;
    const usedEnd = I.header + I.used;
    const X2 = (b) => 4 + ((b - I.header) / Math.max(1, usedEnd - I.header)) * (W - 8);
    imgSvg.append(sv('text', { x: 4, y: y2 - 2, class: 'ue-ax' }, 'data, one block per variable (click one)'));
    segs.forEach((s, i) => {
      const x = X2(s.at), w = Math.max(1, X2(s.at + s.len) - x);
      const r = sv('rect', { x, y: y2 + 4, width: Math.max(0.5, w - 0.6), height: 22, class: `ue-seg${i % 2} ${s.name === selVar ? 'sel' : ''}` });
      r.append(sv('title', {}, `${s.name}: ${s.len} bytes at offset ${hex(s.at)}`));
      r.addEventListener('click', () => { selVar = s.name; render(); });
      imgSvg.append(r);
      if (w > 46) imgSvg.append(sv('text', { x: x + 3, y: y2 + 19, class: 'ue-segt' }, s.name.length * 6.2 > w - 6 ? s.name.slice(0, Math.max(1, Math.floor((w - 6) / 6.2))) : s.name));
    });
    fwLine.textContent = (res.texts.find((t) => t.title === 'fw_env.config')?.body || '').split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('CONFIG')).join('\n');
    put(imgP.sub, `${hex(I.size)}${I.red ? ' × 2, redundant' : ''} · ${I.fits ? 'fits' : 'does not fit'}`);
    drawCheck();
  }

  // ================= all =================
  function drawWarns() {
    put(warnBox, ...(res.warnings || []).map((w) => h('div', {}, w)));
    put(notes, h('summary', {}, `Notes (${(res.notes || []).length})`), ...(res.notes || []).map((n) => h('div', {}, n)));
  }
  function render() {
    if (!res || !res.uboot) { put(warnBox, ...(res?.warnings || []).map((w) => h('div', {}, w))); return; }
    const k = focusKey();
    const U = res.uboot;
    if (selChip != null && selChip >= U.chips.length) selChip = U.chips.length ? U.chips.length - 1 : null;
    if (!selVar || (!U.vars.some((v) => v.name === selVar) && !U.undef.some((u) => u.name === selVar))) selVar = U.argsOwner && U.vars.some((v) => v.name === U.argsOwner) ? U.argsOwner : U.entry;
    drawChain();
    drawArgs();
    drawWarns();
    drawTrace();
    drawVar();
    drawMap();
    drawImage();
    refocus(k);
  }
  ctx.onResult((r) => {
    res = r;
    if (checkOut && !dragging) checkOut = null;
    render();
  });
  let lastW = 0;
  const ro = new ResizeObserver(() => { const w = wrap.clientWidth; if (Math.abs(w - lastW) > 8 && res && !dragging) { lastW = w; drawMap(); drawImage(); } });
  ro.observe(wrap);
}
