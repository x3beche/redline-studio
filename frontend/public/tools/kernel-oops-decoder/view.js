// Kernel Oops Decoder, custom page: the crash itself, taken apart and linked.
//   Head      - what happened in one line (kind, faulting function, address,
//               access) and why, with CPU/PID/comm/kernel/board and the
//               twenty taint letters, lit where set.
//   Stack     - the call stack drawn as a stack: the faulting frame on top,
//               each frame with its offset inside the function to scale,
//               module frames striped per module, "?" and fault-handling
//               frames dimmed (or hidden), IRQ/TASK contexts as dividers.
//   Registers - every register from the dump; the ones equal to or just below
//               the fault address, holding NULL or slab/list poison, and the
//               faulting instruction's base register are marked. The Code:
//               line sits below them, decoded where the tool can (arm64, ARM,
//               RISC-V loads/stores, x86 MOV), with the address it computes.
//   Syndrome  - ESR / #PF error code / FSR / scause as bit lanes: click a bit
//               to flip it (the decode follows; "Log value" restores).
//   Text      - the oops as pasted, every recognised piece a link: click it
//               and its drawing lights up; click the drawing and the text
//               scrolls to its line. Paste straight onto it, or Edit.
// Everything shown comes from run()'s result (result.draw and the texts).

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};
const TAG = {
  fault: ['fault addr', 'bad'], base: ['base', 'bad'], insn: ['insn base', 'acc'], null: ['NULL', 'warn'],
  poison: ['poison', 'poi'], near: ['near', 'soft'], dst: ['dest', 'soft'],
};

export function page(root, ctx) {
  const KEY = 'redline.tool.kernel-oops-decoder.view';
  const pref = store.get(KEY) || {};
  let hideNoise = pref.hideNoise !== false;
  let showTs = !!pref.showTs;
  let sel = 'pc', editing = false, selField = null, lastRes = null;

  const wrap = h('div', { class: 'ko' });
  root.append(wrap);

  // ---------- shells ----------
  const headCard = h('section', { class: 'ko-card ko-head', 'aria-label': 'What happened' });
  const warnBox = h('div', { class: 'ko-warns', role: 'status', 'aria-live': 'polite' });
  const stackCard = h('section', { class: 'ko-card ko-stackcard', 'aria-label': 'Call stack' });
  const regCard = h('section', { class: 'ko-card ko-regcard', 'aria-label': 'Registers' });
  const laneCard = h('section', { class: 'ko-card ko-lanecard', 'aria-label': 'Fault syndrome' });
  const textCard = h('section', { class: 'ko-card ko-textcard', 'aria-label': 'Oops text' });
  const notes = h('div', { class: 'ko-notes' });
  const outWrap = h('div', { class: 'ko-out' }, ctx.outputs);
  wrap.append(headCard, warnBox,
    h('div', { class: 'ko-colA' }, stackCard),
    h('div', { class: 'ko-colB' }, regCard, laneCard),
    h('div', { class: 'ko-colC' }, textCard),
    h('div', { class: 'ko-bottom' }, notes, outWrap));

  const savePref = () => store.set(KEY, { hideNoise, showTs });

  // ---------- linking ----------
  // Every drawn element carries data-link="id id ..."; text marks carry data-id.
  function select(id, from) {
    sel = sel === id && from === 'toggle' ? null : id;
    paintSel(from);
  }
  function linkedIds(id) {
    const d = lastRes?.draw;
    const out = new Set([id]);
    if (!d || !id) return out;
    for (const f of d.stack) {
      if (f.sep) continue;
      const ids = frameIds(f);
      if (ids.includes(id)) ids.forEach((x) => out.add(x));
    }
    if (id === 'code' || id === 'esr') { out.add('code'); out.add('esr'); }
    if (id === 'head' || id === 'addr' || id === 'oops') { out.add('head'); out.add('addr'); out.add('oops'); }
    return out;
  }
  function paintSel(from) {
    const ids = linkedIds(sel);
    for (const el of wrap.querySelectorAll('[data-link]')) {
      const on = sel != null && el.dataset.link.split(' ').some((x) => ids.has(x));
      el.classList.toggle('on', on);
    }
    let first = null;
    for (const el of textCard.querySelectorAll('mark[data-id]')) {
      const on = sel != null && ids.has(el.dataset.id);
      el.classList.toggle('on', on);
      if (on && !first) first = el;
    }
    for (const ln of textCard.querySelectorAll('.ko-ln')) ln.classList.toggle('on', !!ln.querySelector('mark.on'));
    if (from !== 'text' && first) {
      const box = textCard.querySelector('.ko-text');
      if (box) {
        const top = first.parentElement.offsetTop - box.clientHeight / 2 + 10;
        box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
    if (from === 'text' && sel) {
      const el = [...wrap.querySelectorAll('[data-link]')].find((e) => e.classList.contains('on') && !textCard.contains(e));
      if (el) {
        const box = el.closest('.ko-scroll');
        if (box) {
          const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
          if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - b.height / 3;
        }
      }
    }
    drawDetail();
  }
  const frameIds = (f) => [f.idx >= 0 ? `frame:${f.idx}` : null, f.isPc || f.from === 'pc' ? 'pc' : null, f.isLr ? 'lr' : null].filter(Boolean);

  // keep keyboard focus across redraws
  const focusKey = () => document.activeElement?.closest?.('[data-key]')?.dataset.key || null;
  const refocus = (k) => { if (k) wrap.querySelector(`[data-key="${CSS.escape(k)}"]`)?.focus({ preventScroll: true }); };

  // ---------- head ----------
  function drawHead(d, res) {
    const v = (label) => res.values.find((x) => x.label === label)?.value;
    const access = v('Access');
    headCard.replaceChildren(
      h('div', { class: 'ko-h1' },
        h('span', { class: `ko-kind ${d.tone}`, 'data-link': 'head oops panic', title: d.headline }, d.kindLabel),
        d.where ? h('button', { class: 'ko-where', 'data-link': 'pc', 'data-key': 'where', onclick: () => select('pc') }, d.where) : null,
        d.faultAddr ? h('span', { class: 'ko-chip', 'data-link': 'addr' }, 'address ', h('b', {}, d.faultAddr)) : null,
        access && access !== '–' ? h('span', { class: 'ko-chip' }, h('b', {}, access)) : null,
        d.oopsNo ? h('span', { class: `ko-chip${d.oopsNo > 1 ? ' warn' : ''}`, title: 'oops count on this boot' }, `#${d.oopsNo}`) : null,
        h('span', { class: 'ko-grow' }),
        archSelect()),
      h('p', { class: 'ko-cause' }, d.cause),
      h('div', { class: 'ko-meta' },
        d.who ? [
          h('span', { 'data-link': 'cpu' }, 'CPU ', h('b', {}, d.who.cpu)),
          h('span', { 'data-link': 'cpu' }, 'PID ', h('b', {}, d.who.pid)),
          h('span', { 'data-link': 'cpu' }, h('b', {}, d.who.comm)),
          h('span', { 'data-link': 'cpu' }, 'kernel ', h('b', {}, d.who.version)),
        ] : null,
        d.hw ? h('span', { 'data-link': 'hw' }, h('b', {}, d.hw)) : null,
        d.workqueue ? h('span', { 'data-link': 'wq' }, 'workqueue ', h('b', {}, `${d.workqueue.wq} ${d.workqueue.fn}`)) : null,
        d.modules.length ? h('span', { 'data-link': 'mods', title: d.modules.join(' ') }, h('b', {}, d.modules.length), ` module${d.modules.length > 1 ? 's' : ''} loaded`) : null,
        d.panic ? h('span', { class: 'bad', 'data-link': 'panic' }, 'panic: ', h('b', {}, d.panic.reason)) : null),
      taintStrip(d));
  }
  function archSelect() {
    const cur = ctx.raw.arch || 'auto';
    const s = h('select', { 'aria-label': 'Architecture', class: 'ko-sel', onchange: (e) => ctx.set('arch', e.target.value) },
      ctx.manifest.inputs.find((i) => i.key === 'arch').options.map(([v, t]) => h('option', { value: v, selected: v === cur }, v === 'auto' ? `Auto (${lastRes?.draw?.arch || '?'})` : t)));
    return s;
  }
  let selTaint = null;
  function taintStrip(d) {
    const cells = d.taint.map((t) => h('button', {
      class: `ko-tb${t.set ? ' set' : ''}${selTaint === t.letter ? ' cur' : ''}`, 'data-link': t.set ? 'taint' : null, 'data-key': `taint-${t.letter}`,
      title: `${t.letter} (bit ${t.bit}, ${t.name}): ${t.meaning}${t.set ? ' - SET' : ''}`, 'aria-pressed': String(t.set),
      'aria-label': `Taint ${t.letter}, bit ${t.bit}, ${t.set ? 'set' : 'not set'}: ${t.meaning}`,
      onclick: () => { selTaint = selTaint === t.letter ? null : t.letter; select('taint'); drawHead(d, lastRes); refocus(`taint-${t.letter}`); },
      onkeydown: (e) => {
        const i = d.taint.indexOf(t);
        const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
        if (n != null && d.taint[n]) { e.preventDefault(); selTaint = d.taint[n].letter; drawHead(d, lastRes); refocus(`taint-${d.taint[n].letter}`); }
      },
    }, h('b', {}, t.letter), h('small', {}, t.bit)));
    const cur = d.taint.find((t) => t.letter === selTaint);
    const set = d.taint.filter((t) => t.set);
    return h('div', { class: 'ko-taint' },
      h('span', { class: 'ko-tl' }, 'Tainted', h('b', {}, set.length ? ` 0x${d.taintMask.toString(16)}` : d.who ? ' no' : ' ?')),
      h('div', { class: 'ko-tcells', role: 'group', 'aria-label': 'Taint flags' }, cells),
      h('span', { class: 'ko-tdesc' }, cur ? `${cur.letter} = bit ${cur.bit} ${cur.name}: ${cur.meaning}${cur.set ? '' : ' (not set)'}`
        : set.length ? set.map((t) => `${t.letter}: ${t.meaning}`).join(' · ') : 'Click a letter for its meaning.'));
  }

  // ---------- stack ----------
  const modColor = new Map();
  const modClass = (m) => { if (!m) return ''; if (!modColor.has(m)) modColor.set(m, modColor.size % 4); return ` m${modColor.get(m)}`; };
  let selFrame = null;
  function drawStack(d) {
    const frames = d.stack;
    const noisy = frames.filter((f) => !f.sep && (!f.reliable || f.faultPath) && !f.isTop).length;
    const real = frames.filter((f) => !f.sep);
    const mods = [...new Set(real.map((f) => f.mod).filter(Boolean))];
    const list = h('div', { class: 'ko-stack ko-scroll', role: 'list' });
    let depth = 0;
    const shown = frames.filter((f) => f.sep || !hideNoise || f.isTop || (f.reliable && !f.faultPath));
    shown.forEach((f, i) => {
      if (f.sep) { if (shown[i + 1] && !shown[i + 1].sep) list.append(h('div', { class: 'ko-sep', role: 'separator' }, `<${f.sep}>`)); return; }
      const ids = frameIds(f);
      const key = `fr-${f.idx}-${f.fn}`;
      const pct = f.sizeN ? Math.max(1.5, Math.min(100, (f.offN / f.sizeN) * 100)) : 0;
      const cls = ['ko-fr', f.isTop ? 'top' : '', !f.reliable ? 'unrel' : '', f.faultPath ? 'fp' : '', modClass(f.mod).trim(), selFrame === key ? 'cur' : ''].filter(Boolean).join(' ');
      const el = h('button', {
        class: cls, role: 'listitem', 'data-link': ids.join(' '), 'data-key': key,
        'aria-label': `Frame ${depth}: ${f.fn}${f.off ? '+' + f.off : ''}${f.mod ? ' in module ' + f.mod : ''}${f.isTop ? ', faulting frame' : ''}${!f.reliable ? ', unreliable' : ''}`,
        onclick: () => { selFrame = key; select(ids[0] || null); drawStack(d); refocus(key); },
        onkeydown: (e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const all = [...list.querySelectorAll('.ko-fr')];
          const n = all[all.indexOf(el) + (e.key === 'ArrowDown' ? 1 : -1)];
          if (n) n.click();
        },
      },
      h('span', { class: 'ko-no' }, depth),
      h('span', { class: 'ko-fn' },
        h('span', { class: 'ko-name' }, f.fn),
        f.mod ? h('span', { class: `ko-mod${modClass(f.mod)}` }, f.mod) : null,
        f.isTop ? h('span', { class: 'ko-flag bad' }, d.kind === 'warning' ? 'warned here' : 'faults here') : null,
        f.isLr ? h('span', { class: 'ko-flag' }, 'lr') : null,
        f.from === 'pc' ? h('span', { class: 'ko-flag', title: 'not in the call trace; taken from pc / RIP / epc' }, 'from pc') : null,
        f.dupPc ? h('span', { class: 'ko-flag soft' }, '= pc') : null,
        !f.reliable ? h('span', { class: 'ko-flag soft', title: 'x86 "?" frame: an address found on the stack, not a proven caller' }, '?') : null,
        f.faultPath && !f.isTop ? h('span', { class: 'ko-flag soft', title: 'exception or report handling, not your code path' }, 'handler') : null,
        f.ctx && f.ctx !== 'TASK' ? h('span', { class: 'ko-flag soft' }, f.ctx) : null),
      f.sizeN ? h('span', { class: 'ko-off', title: `offset ${f.off} of ${f.size} bytes` },
        h('span', { class: 'ko-track' }, h('i', { style: `left:${pct}%` })), h('small', {}, `+${f.off}/${f.size}`)) : h('span', { class: 'ko-off' }),
      f.isTop && d.insn ? h('span', { class: 'ko-insn' }, d.insn.text) : null);
      list.append(el);
      depth++;
    });
    if (!real.length) list.append(h('div', { class: 'ko-empty' }, 'No call trace in the text.'));
    const cur = frames.find((f) => !f.sep && `fr-${f.idx}-${f.fn}` === selFrame) || frames.find((f) => f.isTop);
    stackCard.replaceChildren(
      h('div', { class: 'ko-ch' }, h('h2', {}, 'Call stack'),
        h('span', { class: 'ko-sub' }, `${real.length} frame${real.length === 1 ? '' : 's'}${mods.length ? ` · ${mods.map((m) => m).join(', ')}` : ''}`),
        noisy ? h('button', { class: 'k-btn ko-right', 'aria-pressed': String(!hideNoise), 'data-key': 'noise',
          title: '"?" frames (x86 stack scan leftovers) and exception/report handling frames',
          onclick: () => { hideNoise = !hideNoise; savePref(); drawStack(d); refocus('noise'); } }, hideNoise ? `Show ${noisy} handler/? frames` : 'Hide handler/? frames') : null),
      h('div', { class: 'ko-legend' }, h('span', {}, h('i', { class: 'lg-top' }), 'where it stopped'), h('span', {}, 'each frame was called by the one below'),
        mods.length ? h('span', {}, h('i', { class: 'lg-mod' }), 'module code') : null),
      list,
      cur ? frameDetail(cur, d) : null);
    paintSel();
  }
  function frameDetail(f, d) {
    const obj = f.mod ? `${(ctx.raw.moddir || '').replace(/\/$/, '')}${ctx.raw.moddir ? '/' : ''}${f.mod}.ko` : (ctx.raw.vmlinux || 'vmlinux');
    const cc = (lastRes?.texts?.[0]?.body.match(/CROSS_COMPILE=(\S+)/) || [])[1];
    const cmd = f.off ? `${cc ? `CROSS_COMPILE=${cc} ` : ''}./scripts/faddr2line --list ${obj} ${f.fn}+${f.off}${f.size ? '/' + f.size : ''}` : '';
    const b = h('button', { class: 'k-btn', onclick: async () => {
      try { await navigator.clipboard.writeText(cmd); b.textContent = 'Copied'; } catch { b.textContent = 'Select it'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1300);
    } }, 'Copy');
    return h('div', { class: 'ko-fdet' },
      h('div', {}, h('b', {}, f.fn), f.off ? ` +${f.off} of ${f.size}` : '', f.mod ? ` in ${f.mod}.ko` : ' in vmlinux', f.line >= 0 ? h('span', { class: 'ko-sub' }, ` · text line ${f.line + 1}`) : null),
      cmd ? h('div', { class: 'ko-cmd' }, h('code', {}, cmd), b) : h('div', { class: 'ko-sub' }, 'No offset printed for this frame.'));
  }

  // ---------- registers + code ----------
  function drawRegs(d) {
    const regs = d.regs;
    const grid = h('div', { class: 'ko-regs ko-scroll', role: 'group', 'aria-label': 'Register values' });
    regs.forEach((r, i) => {
      const tone = r.tags.includes('fault') || r.tags.includes('base') ? 'bad' : r.tags.includes('insn') ? 'acc' : r.tags.includes('poison') ? 'poi' : r.tags.includes('null') ? 'warn' : '';
      const hx = r.hex, lead = (hx.match(/^0+(?=.)/) || [''])[0];
      const key = `reg-${r.name}`;
      const el = h('button', {
        class: `ko-reg ${tone}`, 'data-link': `reg:${r.name}`, 'data-key': key,
        title: r.notes.length ? r.notes.join('\n') : `${r.name} = 0x${hx}`,
        'aria-label': `${r.name} = 0x${hx}${r.notes.length ? '. ' + r.notes.join('. ') : ''}`,
        onclick: () => { select(`reg:${r.name}`, 'toggle'); },
        onkeydown: (e) => {
          const all = [...grid.querySelectorAll('.ko-reg')];
          const cols = Math.max(1, all.filter((x) => x.offsetTop === all[0].offsetTop).length);
          const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
          if (!step) return;
          e.preventDefault();
          const n = all[i + step];
          if (n) { n.focus(); n.click(); }
        },
      },
      h('span', { class: 'ko-rn' }, r.name, r.seg ? h('small', {}, ` ${r.seg}:`) : null),
      h('span', { class: 'ko-rv' }, h('span', { class: 'lead' }, lead), hx.slice(lead.length)),
      r.tags.some((t) => t !== 'null' && t !== 'dst') ? h('span', { class: 'ko-rt' }, r.tags.filter((t) => TAG[t] && !(t === 'null' && r.tags.length > 1 && (r.tags.includes('base') || r.tags.includes('insn')))).map((t) => h('em', { class: TAG[t][1] }, t === 'base' ? `base ${noteOff(r)}` : TAG[t][0]))) : null);
      grid.append(el);
    });
    if (!regs.length) grid.append(h('div', { class: 'ko-empty' }, 'No register dump in the text.'));
    const counts = ['fault', 'base', 'insn', 'null', 'poison'].map((t) => [t, regs.filter((r) => r.tags.includes(t)).length]).filter(([, n]) => n);
    regCard.replaceChildren(
      h('div', { class: 'ko-ch' }, h('h2', {}, 'Registers'), h('span', { class: 'ko-sub' }, `${regs.length} from the dump`),
        h('span', { class: 'ko-legend ko-right' }, counts.map(([t, n]) => h('span', {}, h('em', { class: TAG[t][1] }, TAG[t][0]), ` ${n}`)))),
      grid,
      codeStrip(d));
  }
  const noteOff = (r) => { const m = r.notes.join(' ').match(/\+ (0x[0-9a-f]+)/); return m ? '+' + m[1] : ''; };
  function codeStrip(d) {
    if (!d.code) return h('div', { class: 'ko-code ko-sub' }, 'No Code: line in the text.');
    const c = d.code;
    const rows = c.words.map((w, i) => h('div', { class: `ko-cw${i === c.fault ? ' f' : ''}`, 'data-link': i === c.fault ? 'insn' : null },
      h('code', {}, w), c.asm ? h('span', {}, c.asm[i]) : null));
    const ea = d.eaCheck;
    return h('div', { class: 'ko-code', 'data-link': 'insn' },
      h('div', { class: 'ko-ch2' }, 'Code: line', c.kind === 'bytes' ? h('span', { class: 'ko-sub' }, ' · bytes, the faulting one in <>') : null),
      c.kind === 'words' && c.asm ? h('div', { class: 'ko-cws' }, rows)
        : h('div', { class: 'ko-bytes' }, c.words.map((w, i) => h('code', { class: i === c.fault ? 'f' : '' }, w))),
      d.insn ? h('div', { class: 'ko-ea' }, h('b', {}, d.insn.text),
        ea ? [' → ', h('button', { class: 'ko-lnk', 'data-link': `reg:${ea.reg}`, onclick: () => select(`reg:${ea.reg}`) }, ea.reg), ` (0x${ea.value.replace(/^0+(?=.)/, '')}) + offset = `,
          h('b', { class: ea.matches ? 'bad' : 'warn' }, ea.ea), ea.matches ? ' = the fault address' : ' ≠ the fault address'] : null,
        d.origin ? h('div', { class: 'ko-sub' }, `${d.insn.base} was set ${d.origin.back} instruction${d.origin.back > 1 ? 's' : ''} earlier by ${d.origin.text}${d.origin.from ? `, read from ${d.origin.from}` : ''}.`) : null)
        : c.fault >= 0 ? h('div', { class: 'ko-sub' }, 'The faulting instruction is not one this tool decodes; use scripts/decodecode (Commands).') : null);
  }

  // ---------- syndrome lanes ----------
  function drawLanes(d) {
    const L = d.lanes;
    if (!L) {
      laneCard.replaceChildren(h('div', { class: 'ko-ch' }, h('h2', {}, 'Fault syndrome'),
        h('span', { class: 'ko-sub' }, d.kind === 'warning' || d.kind === 'hung' || d.kind === 'rcu' || d.kind === 'softlockup' ? 'none: this report is not a CPU exception' : d.kind === 'gpf' ? 'none: a #GP error code is a segment selector, not a fault code' : 'not in the text (ESR, #PF error code, FSR or cause)')),
        overrideBox(d));
      return;
    }
    const V = BigInt(L.value);
    const setVal = (nv) => { const w = L.reg === 'ESR' ? 16 : L.reg === 'scause' ? 16 : 4; ctx.set('code', '0x' + BigInt.asUintN(64, nv).toString(16).padStart(w, '0')); };
    const groups = L.fields.map((f) => {
      const bits = f.hi - f.lo + 1;
      const key = `fld-${f.name}-${f.hi}`;
      const cur = selField === key;
      const res = /^RES/.test(f.name);
      let body;
      if (bits <= 8) {
        body = h('div', { class: 'ko-bits' }, Array.from({ length: bits }, (_, k) => {
          const bit = f.hi - k, on = (V >> BigInt(bit)) & 1n;
          return h('button', { class: `ko-bit${on ? ' one' : ''}`, 'data-key': `bit-${bit}`,
            'aria-label': `${L.reg} bit ${bit} (${f.name}) = ${on}. Press to flip.`, title: `bit ${bit}: flip`,
            onclick: () => { selField = key; setVal(V ^ (1n << BigInt(bit))); },
            onfocus: () => { if (selField !== key) { selField = key; drawDetail(); } } },
          h('small', {}, bit), h('b', {}, String(on)));
        }));
      } else {
        const mask = (1n << BigInt(bits)) - 1n;
        const fv = (V >> BigInt(f.lo)) & mask;
        const bump = (dv) => setVal((V & ~(mask << BigInt(f.lo))) | ((((fv + dv) % (mask + 1n)) + mask + 1n) % (mask + 1n)) << BigInt(f.lo));
        body = h('button', { class: 'ko-wide', 'data-key': key, title: 'Up/Down change the field value',
          'aria-label': `${f.name}, bits ${f.hi} to ${f.lo}, value 0x${fv.toString(16)}. Up and Down change it.`,
          onclick: () => { selField = key; drawDetail(); drawLanes(d); refocus(key); },
          onkeydown: (e) => { if (e.key === 'ArrowUp') { e.preventDefault(); selField = key; bump(1n); } if (e.key === 'ArrowDown') { e.preventDefault(); selField = key; bump(-1n); } } },
        h('small', {}, `${f.hi}:${f.lo}`), h('b', {}, '0x' + fv.toString(16)));
      }
      return h('div', { class: `ko-fld${cur ? ' cur' : ''}${res ? ' res' : ''}${f.name === 'EC' || /FSC|FS\[3|code|W|U\/S|P$/.test(f.name) ? ' key' : ''}`, style: `flex-grow:${bits <= 8 ? bits : 4}; min-width:${bits <= 8 ? bits * 20 + 6 : 70}px`,
        onclick: (e) => { if (e.target === e.currentTarget || e.target.classList.contains('ko-fn2')) { selField = key; drawDetail(); drawLanes(d); } } },
      body, h('span', { class: 'ko-fn2' }, f.name));
    });
    laneCard.replaceChildren(
      h('div', { class: 'ko-ch' }, h('h2', { 'data-link': 'esr code' }, L.reg, ' ', h('code', {}, L.value)),
        h('span', { class: 'ko-sub' }, `from the ${L.source}${L.shown ? ` · ${L.shown}` : ''}`),
        d.codeOverride ? h('button', { class: 'k-btn ko-right', 'data-key': 'logval', onclick: () => ctx.set('code', '') }, 'Log value') : null),
      h('p', { class: 'ko-lsum' }, L.summary),
      h('div', { class: 'ko-lanes', role: 'group', 'aria-label': `${L.reg} bit fields` }, groups),
      h('div', { class: 'ko-fdesc', id: 'ko-fdesc', 'aria-live': 'polite' }),
      overrideBox(d));
    drawDetail();
  }
  function overrideBox(d) {
    const inp = h('input', { type: 'text', spellcheck: 'false', placeholder: d.arch === 'x86_64' ? '0x0002' : d.arch === 'arm' ? '0x805' : '0x96000045', 'aria-label': 'Decode another value' });
    inp.value = ctx.raw.code || '';
    const go = () => ctx.set('code', inp.value.trim());
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    inp.addEventListener('change', go);
    return h('label', { class: 'ko-ovr' }, 'Decode another value', inp);
  }
  function drawDetail() {
    const box = laneCard.querySelector('#ko-fdesc');
    const L = lastRes?.draw?.lanes;
    if (!box || !L) return;
    const f = L.fields.find((x) => `fld-${x.name}-${x.hi}` === selField) || L.fields[0];
    box.replaceChildren(h('b', {}, `${f.name} [${f.hi === f.lo ? f.hi : `${f.hi}:${f.lo}`}] = 0x${f.value.toString(16)}`), ` ${f.meaning}`);
  }

  // ---------- text ----------
  function drawText(d) {
    const head = h('div', { class: 'ko-ch' }, h('h2', {}, 'Oops text'),
      h('span', { class: 'ko-sub' }, editing ? 'edit, then Apply' : `${d.lines.length} lines · click a highlighted piece; paste here to replace`),
      h('span', { class: 'ko-right' },
        editing ? null : h('button', { class: 'k-btn', 'data-key': 'ts', 'aria-pressed': String(showTs), title: 'Show the dmesg timestamps and log prefixes',
          onclick: () => { showTs = !showTs; savePref(); drawText(d); refocus('ts'); } }, 'Times'),
        editing ? null : h('button', { class: 'k-btn', 'data-key': 'edit', onclick: () => { editing = true; drawText(d); textCard.querySelector('textarea')?.focus(); } }, 'Edit'),
        editing ? h('button', { class: 'k-btn k-primary', 'data-key': 'apply', onclick: () => { editing = false; ctx.set('oops', textCard.querySelector('textarea').value); } }, 'Apply') : null,
        editing ? h('button', { class: 'k-btn', onclick: () => { editing = false; drawText(d); } }, 'Cancel') : null));
    if (editing) {
      const ta = h('textarea', { class: 'ko-ta', spellcheck: 'false', 'aria-label': 'Oops text' });
      ta.value = ctx.raw.oops || '';
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { editing = false; ctx.set('oops', ta.value); } });
      textCard.replaceChildren(head, ta, h('div', { class: 'ko-hint' }, 'Ctrl+Enter applies.'));
      return;
    }
    const box = h('div', { class: `ko-text${showTs ? '' : ' nots'}`, tabindex: 0, 'aria-label': 'Oops text; paste to replace it' });
    d.lines.forEach((l, i) => {
      const row = h('div', { class: `ko-ln${i === d.headLine ? ' head' : ''}` }, h('span', { class: 'ko-lno' }, i + 1));
      const t = h('span', { class: 'ko-lt' });
      if (l.off) t.append(h('span', { class: 'ts' }, l.t.slice(0, l.off)));
      let at = l.off;
      for (const sp of l.spans) {
        if (sp.a < at) continue;
        if (sp.a > at) t.append(l.t.slice(at, sp.a));
        const k = sp.id.split(':')[0];
        t.append(h('mark', { class: `k-${k}`, 'data-id': sp.id, title: sp.id.replace(':', ' ') }, l.t.slice(sp.a, sp.b)));
        at = sp.b;
      }
      if (at < l.t.length) t.append(l.t.slice(at));
      row.append(t);
      box.append(row);
    });
    box.addEventListener('click', (e) => {
      const m = e.target.closest('mark[data-id]');
      if (m) select(m.dataset.id, 'text');
    });
    box.addEventListener('paste', (e) => {
      const txt = e.clipboardData?.getData('text');
      if (txt && txt.trim()) { e.preventDefault(); ctx.set('oops', txt); }
    });
    textCard.replaceChildren(head, box);
    paintSel('text');
  }

  // ---------- warnings / notes ----------
  function drawMsgs(res) {
    warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes?.length ? [h('div', { class: 'ko-ch2' }, 'Next steps and notes'), ...res.notes.map((n) => h('div', {}, n))] : []));
  }

  ctx.onResult((res) => {
    const k = focusKey();
    lastRes = res;
    const d = res.draw;
    if (!d) { warnBox.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w))); return; }
    modColor.clear();
    if (sel && !d.lines.some((l) => l.spans.some((s) => s.id === sel)) && !/^(pc|lr)$/.test(sel)) sel = null;
    drawHead(d, res);
    drawMsgs(res);
    drawStack(d);
    drawRegs(d);
    drawLanes(d);
    drawText(d);
    paintSel('text');
    refocus(k);
  });
}
