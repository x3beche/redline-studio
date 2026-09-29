// HardFault Decoder, drawn as the registers themselves: CFSR as its 32 bits
// in the UFSR | BFSR | MMFSR groups, HFSR below it, the fault address
// registers beside the group that validates them, and on the right the
// exception frame as it sits on the stack (high addresses on top, SP at the
// bottom) with EXC_RETURN's bits above it.
//   Click a bit (or focus it and press Space/Enter) to flip it; the arrows
//   move along a lane. Type or paste a register value into its box. Paste a
//   handler printout or a memory dump into the frame box.
// Everything shown comes from run()'s result (result.view).

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
const hex8 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

const CORES = [['m0', 'M0'], ['m0plus', 'M0+'], ['m3', 'M3'], ['m4', 'M4'], ['m7', 'M7'], ['m23', 'M23'], ['m33', 'M33'], ['m55', 'M55']];
const TRUST = {
  yes: ['ok', 'faulting instruction'], late: ['warn', 'late: imprecise'], target: ['warn', 'bad branch target'],
  no: ['bad', 'not trustworthy'], likely: ['warn', 'probably the faulting instruction'], unknown: ['soft', ''],
};

export function page(root, ctx) {
  const wrap = h('div', { class: 'hf' });
  root.append(wrap);

  // A text box bound to an input: it follows the result unless it has focus.
  const boxes = {};
  const box = (key, attrs = {}) => {
    const el = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', class: 'hf-hex', 'aria-label': attrs.label || key, placeholder: attrs.placeholder || '',
      oninput: (e) => ctx.set(key, e.target.value) });
    boxes[key] = el;
    return el;
  };

  // ---------- verdict ----------
  const vTitle = h('div', { class: 'hf-vtitle' });
  const vWhy = h('div', { class: 'hf-vwhy' });
  const vNext = h('div', { class: 'hf-vnext' });
  const vFacts = h('div', { class: 'hf-facts' });
  const vAlso = h('div', { class: 'hf-also' });
  const verdict = h('section', { class: 'hf-card hf-verdict', 'aria-live': 'polite' },
    h('div', { class: 'hf-vlabel' }, 'Likely cause'), vTitle, vWhy, vNext, vFacts, vAlso);

  // ---------- registers ----------
  const coreSeg = h('div', { class: 'hf-seg', role: 'radiogroup', 'aria-label': 'Core' });
  const coreBtns = CORES.map(([id, label]) => {
    const b = h('button', { type: 'button', role: 'radio', 'data-core': id, onclick: () => ctx.set('core', id) }, label);
    coreSeg.append(b);
    return b;
  });
  const regBody = h('div', { class: 'hf-regbody' });
  const regCard = h('section', { class: 'hf-card' },
    h('div', { class: 'hf-head' }, h('h2', {}, 'Fault status registers'), h('span', { class: 'hf-sub', id: 'hf-arch' }), h('span', { class: 'hf-right' }, coreSeg)),
    regBody,
    h('div', { class: 'hf-help' }, 'Click a bit to flip it, or focus it and press ', h('kbd', {}, 'Space'), '; ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' move along the register. Values are hex.'));

  // ---------- stack ----------
  const excLane = h('div', { class: 'hf-exc' });
  const stackCol = h('div', { class: 'hf-stack', role: 'list', 'aria-label': 'Stacked exception frame' });
  const frameBox = h('textarea', { class: 'hf-paste', rows: 6, spellcheck: 'false', 'aria-label': 'Stacked frame, dump or fault printout',
    placeholder: 'Paste the 8 words at SP, a gdb/OpenOCD dump, or a HardFault handler printout (CFSR = 0x..., R0 = 0x...)',
    oninput: (e) => ctx.set('frame', e.target.value) });
  const stackSub = h('span', { class: 'hf-sub' });
  const stackCard = h('section', { class: 'hf-card' },
    h('div', { class: 'hf-head' }, h('h2', {}, 'Exception frame'), stackSub),
    h('div', { class: 'hf-excrow' }, h('label', { class: 'hf-lab' }, 'EXC_RETURN', box('excReturn', { label: 'EXC_RETURN', placeholder: '0xFFFFFFFD' })), excLane),
    stackCol,
    h('div', { class: 'hf-pastewrap' },
      h('div', { class: 'hf-pastehead' }, h('b', {}, 'Paste'), h('span', { class: 'hf-sub' }, 'frame words, memory dump or handler printout')),
      frameBox,
      h('div', { class: 'hf-pastefields' },
        h('label', { class: 'hf-lab' }, 'Frame at (SP)', box('sp', { label: 'Frame address', placeholder: 'from the dump' })),
        h('label', { class: 'hf-lab hf-grow' }, 'ELF', box('elf', { label: 'ELF file' })))));

  const warns = h('div', { class: 'hf-warns', role: 'status' });
  const notes = h('details', { class: 'hf-notes' }, h('summary', {}, 'Notes'));
  wrap.append(
    h('div', { class: 'hf-main' }, warns, verdict, regCard, notes),
    h('div', { class: 'hf-side' }, stackCard, ctx.outputs));

  let res = null;
  let focusKey = null;
  // excReturn, sp and elf sit in the stack card, built once; the register boxes are rebuilt.
  const STATIC = new Set(['excReturn', 'sp', 'elf']);

  const flip = (key, bit) => {
    const cur = (res && res.view.regs[key]) ?? 0;
    ctx.set(key, hex8((cur ^ (1 << bit)) >>> 0));
  };

  // One register as a lane of bit cells, high bit on the left.
  function lane(key, label, width, bits, groups, extra) {
    const v = res.view.regs[key];
    const byBit = new Map(bits.map((b) => [b.bit, b]));
    const cols = h('div', { class: `hf-lane w${width}`, role: 'group', 'aria-label': label });
    if (groups) {
      for (const [name, hi, lo] of groups) cols.append(h('div', { class: `hf-grp ${lo >= 16 ? 'hi' : 'lo'}`, style: `grid-column: span ${hi - lo + 1}` }, h('span', {}, name), h('i', {}, `[${hi}:${lo}]`)));
    }
    for (let bit = width - 1; bit >= 0; bit--) {
      const d = byBit.get(bit);
      const on = v != null && ((v >>> bit) & 1) === 1;
      const cls = ['hf-bit'];
      if (d) cls.push('def');
      if (on) cls.push(d ? (d.kind === 'valid' ? 'valid' : d.kind === 'info' ? 'info' : 'set') : 'stray');
      if (d && d.available === false) cls.push('na');
      if (width === 32) cls.push(bit >= 16 ? 'hi' : 'lo');
      const id = `${key}-${bit}`;
      const b = h('button', { type: 'button', class: cls.join(' '), 'data-id': id, 'aria-pressed': String(on),
        title: d ? `${d.name} (bit ${bit})${d.available === false ? ' - not on this core' : ''}\n${d.desc}` : `bit ${bit}${on ? ' - set, but reserved' : ' (reserved)'}`,
        'aria-label': d ? `${d.name}, bit ${bit}, ${on ? 'set' : 'clear'}` : `bit ${bit}, reserved, ${on ? 'set' : 'clear'}`,
        tabindex: d || on ? '0' : '-1',
        onclick: () => { focusKey = id; flip(key, bit); },
        onkeydown: (e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const all = [...cols.querySelectorAll('.hf-bit')];
            const i = all.indexOf(e.currentTarget);
            const n = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1)))];
            n.tabIndex = 0; n.focus();
          }
        } },
      h('span', { class: 'nm' }, d ? d.name : ''), h('span', { class: 'v' }, on ? '1' : '0'), h('span', { class: 'n' }, String(bit)));
      cols.append(b);
    }
    const head = h('div', { class: 'hf-lanehead' },
      h('label', { class: 'hf-lname' }, label, box(key, { label, placeholder: '0x00000000' })),
      v == null ? h('span', { class: 'hf-sub' }, 'not given') : res.view.src[key] === 'paste' ? h('span', { class: 'hf-src' }, 'from the paste') : null,
      extra || null);
    return h('div', { class: 'hf-reg' }, head, h('div', { class: 'hf-lanewrap' }, cols));
  }

  function addrBox(key, label, valid, where, validName) {
    const v = res.view.regs[key];
    return h('div', { class: `hf-addr ${valid ? 'ok' : 'off'}` },
      h('label', { class: 'hf-lname' }, label, box(key, { label, placeholder: '0x00000000' })),
      h('span', { class: `hf-badge ${valid ? 'ok' : ''}` }, valid ? `${validName} = 1: valid` : `${validName} = 0: not valid`),
      v != null && valid ? h('div', { class: 'hf-where' }, where) : v != null ? h('div', { class: 'hf-where soft' }, 'The address in this register means nothing unless its VALID bit is set.') : null);
  }

  function setList(bits, reg) {
    const on = bits.filter((b) => b.set);
    if (!on.length) return null;
    return h('ul', { class: 'hf-setlist' }, on.map((b) => h('li', { class: b.kind === 'valid' ? 'valid' : b.kind === 'info' ? 'info' : 'set' },
      h('b', {}, b.name), h('span', { class: 'soft' }, ` ${reg}[${b.bit}] `), b.available === false ? h('em', {}, 'not on this core - ') : null, b.desc)));
  }

  function drawRegs() {
    const V = res.view;
    for (const b of coreBtns) b.setAttribute('aria-checked', String(b.dataset.core === V.core.id));
    document.getElementById('hf-arch').textContent = `${V.core.name} · ${{ v6m: 'Armv6-M', v7m: 'Armv7-M', v8mb: 'Armv8-M Baseline', v8mm: 'Armv8-M Mainline' }[V.core.arch]}${V.core.fp ? ' · FPU' : ''}`;
    regBody.replaceChildren();
    if (!V.core.hasCfsr) {
      regBody.append(h('div', { class: 'hf-none' },
        h('b', {}, `${V.core.name} has no CFSR, HFSR, MMFAR or BFAR.`),
        ' Every fault is a plain HardFault; the only evidence is the stacked frame on the right (PC, LR, xPSR) and the instruction at the PC.'));
      if (V.sfsrBits.length) regBody.append(lane('sfsr', 'SFSR', 8, V.sfsrBits));
      else if (V.core.sfsr) regBody.append(h('div', { class: 'hf-mini' }, lane('sfsr', 'SFSR', 8, [])));
      regBody.append(lane('dfsr', 'DFSR', 8, V.dfsrBits.length ? V.dfsrBits : []));
      return;
    }
    const parts = [
      lane('cfsr', 'CFSR', 32, V.cfsrBits, [['UFSR · UsageFault', 31, 16], ['BFSR · BusFault', 15, 8], ['MMFSR · MemManage', 7, 0]]),
      h('div', { class: 'hf-addrs' },
        addrBox('mmfar', 'MMFAR', V.mmfarValid, V.mmfarWhere, 'MMARVALID'),
        addrBox('bfar', 'BFAR', V.bfarValid, V.bfarWhere, 'BFARVALID')),
      setList(V.cfsrBits, 'CFSR'),
      lane('hfsr', 'HFSR', 32, V.hfsrBits),
      setList(V.hfsrBits, 'HFSR')];
    regBody.append(...parts.filter(Boolean));
    const small = h('div', { class: 'hf-smallregs' },
      lane('dfsr', 'DFSR', 8, V.dfsrBits.length ? V.dfsrBits : [{ bit: 0, name: 'HALTED' }, { bit: 1, name: 'BKPT' }, { bit: 2, name: 'DWTTRAP' }, { bit: 3, name: 'VCATCH' }, { bit: 4, name: 'EXTERNAL' }].map((b) => ({ ...b, kind: 'info', desc: '' }))),
      V.core.sfsr ? lane('sfsr', 'SFSR', 8, V.sfsrBits.length ? V.sfsrBits : ['INVEP', 'INVIS', 'INVER', 'AUVIOL', 'INVTRAN', 'LSPERR', 'SFARVALID', 'LSERR'].map((n, i) => ({ bit: i, name: n, kind: i === 6 ? 'valid' : 'fault', desc: '' }))) : null,
      h('div', { class: 'hf-reg' }, h('div', { class: 'hf-lanehead' }, h('label', { class: 'hf-lname' }, 'AFSR', box('afsr', { label: 'AFSR', placeholder: 'impl. defined' })))),
      V.core.sfsr ? h('div', { class: 'hf-reg' }, h('div', { class: 'hf-lanehead' }, h('label', { class: 'hf-lname' }, 'SFAR', box('sfar', { label: 'SFAR', placeholder: '0x00000000' })))) : null);
    regBody.append(...[small, setList(V.dfsrBits, 'DFSR'), setList(V.sfsrBits, 'SFSR')].filter(Boolean));
  }

  function drawExc() {
    const V = res.view;
    excLane.replaceChildren();
    const e = V.exc;
    if (!e) { excLane.append(h('span', { class: 'hf-sub' }, 'LR on entry to the handler: tells which stack holds the frame.')); return; }
    const cells = e.bits.map((b) => {
      const id = `exc-${b.bit}`;
      return h('button', { type: 'button', class: `hf-ebit ${b.set ? 'on' : ''}`, 'data-id': id, 'aria-pressed': String(b.set),
        title: `${b.name} (bit ${b.bit}) = ${b.set ? 1 : 0}\n${b.desc}`, 'aria-label': `${b.name} bit ${b.bit} ${b.set ? 1 : 0}`,
        onclick: () => { focusKey = id; flip('excReturn', b.bit); } },
      h('span', { class: 'nm' }, b.name), h('span', { class: 'v' }, b.set ? '1' : '0'));
    });
    excLane.append(h('div', { class: 'hf-ebits' }, cells),
      h('div', { class: `hf-edesc ${e.valid ? '' : 'bad'}` }, e.valid ? `${e.from} · ${e.stack} · ${e.fpFrame ? 'extended FP frame (26 words)' : 'basic frame (8 words)'}` : e.problems.join('; ')));
  }

  function drawStack() {
    const V = res.view;
    stackCol.replaceChildren();
    const f = V.frame;
    const have = f.some((w) => w.value != null);
    stackSub.textContent = V.frameAddr != null ? `at ${hex8(V.frameAddr)}${V.exc ? ` on ${V.exc.stack}` : ''}` : V.exc ? `on ${V.exc.stack}` : '';
    const at = (off) => (V.frameAddr != null ? hex8(V.frameAddr + off) : `SP+0x${off.toString(16).toUpperCase().padStart(2, '0')}`);
    const rows = [];
    if (V.origSp != null) rows.push(h('div', { class: 'hf-sprow top', role: 'listitem' }, h('span', { class: 'a' }, hex8(V.origSp)), h('span', {}, '← SP before the exception', V.xpsr && V.xpsr.align ? ' (4-byte alignment pad below)' : '')));
    const fp = f.filter((w) => w.fp);
    if (V.exc && V.exc.fpFrame) {
      rows.push(h('div', { class: 'hf-word fp', role: 'listitem' }, h('span', { class: 'a' }, `${at(0x20)} …`), h('span', { class: 'r' }, 'FP'),
        h('span', { class: 'val' }, fp.length ? `${fp.length} words` : '18 words'), h('span', { class: 'note' }, fp.length ? `S0-S15, FPSCR ${fp[16] ? hex8(fp[16].value) : '–'}` : 'S0-S15, FPSCR: not pasted')));
    }
    const trust = TRUST[V.pcTrust] || TRUST.unknown;
    for (const w of f.filter((x) => !x.fp).slice().reverse()) {
      let note = '', cls = '';
      if (w.name === 'PC') { note = h('span', { class: `hf-badge ${trust[0]}` }, trust[1] || '–'); cls = 'pc'; }
      else if (w.name === 'LR' && w.value != null) note = w.value >= 0xFFFFFF00 ? 'EXC_RETURN: fault in a handler before it saved LR' : 'return address (caller)';
      else if (w.name === 'xPSR' && V.xpsr) note = `T=${V.xpsr.t} · ${V.xpsr.where}${V.xpsr.align ? ' · pad' : ''}`;
      else if (w.value != null && V.regs.bfar != null && V.bfarValid && V.regs.bfar >= w.value && V.regs.bfar - w.value < 0x1000 && /^R/.test(w.name)) { note = `BFAR = ${w.name} + 0x${(V.regs.bfar - w.value).toString(16).toUpperCase()}`; cls = 'hit'; }
      else if (w.value != null && V.regs.mmfar != null && V.mmfarValid && V.regs.mmfar >= w.value && V.regs.mmfar - w.value < 0x1000 && /^R/.test(w.name)) { note = `MMFAR = ${w.name} + 0x${(V.regs.mmfar - w.value).toString(16).toUpperCase()}`; cls = 'hit'; }
      rows.push(h('div', { class: `hf-word ${cls} ${w.value == null ? 'missing' : ''}`, role: 'listitem' },
        h('span', { class: 'a' }, at(w.off)), h('span', { class: 'r' }, w.name),
        h('span', { class: 'val' }, w.value != null ? hex8(w.value) : '–'), h('span', { class: 'note' }, note)));
    }
    rows.push(h('div', { class: 'hf-sprow', role: 'listitem' }, h('span', { class: 'a' }, V.frameAddr != null ? hex8(V.frameAddr) : 'SP'), h('span', {}, `← ${V.exc ? V.exc.stack : 'SP'} in the handler (frame base)`)));
    if (V.extra) rows.push(h('div', { class: 'hf-word fp', role: 'listitem' }, h('span', { class: 'a' }, '−0x28 …'), h('span', { class: 'r' }, 'R4-R11'), h('span', { class: 'val' }, hex8(V.extra[0])), h('span', { class: 'note' }, 'callee context + integrity signature')));
    stackCol.append(...rows);
    if (!have) stackCol.append(h('div', { class: 'hf-empty' }, 'No frame yet: paste the words at SP below.'));
    if (V.pcWhy && have) stackCol.append(h('div', { class: 'hf-pcwhy' }, h('b', {}, 'PC: '), V.pcWhy, V.pcWhere ? ` It is in the ${V.pcWhere}.` : ''));
  }

  function drawVerdict() {
    const V = res.view;
    const top = V.causes[0];
    vTitle.textContent = top.title;
    vWhy.textContent = top.why;
    vNext.replaceChildren(h('b', {}, 'Next: '), top.next);
    const val = (label) => (res.values || []).find((x) => x.label === label);
    const fact = (label, value, tone) => h('div', { class: `hf-fact ${tone || ''}` }, h('span', {}, label), h('b', {}, value));
    const pc = val('Stacked PC');
    const trust = TRUST[V.pcTrust] || TRUST.unknown;
    vFacts.replaceChildren(
      fact('Where', val('Where') ? val('Where').value : '–'),
      fact('Stacked PC', pc ? pc.value : '–', trust[0]),
      V.core.hasCfsr ? fact('Fault address', V.bfarValid ? `BFAR ${hex8(V.regs.bfar)}` : V.mmfarValid ? `MMFAR ${hex8(V.regs.mmfar)}` : 'none valid', V.bfarValid || V.mmfarValid ? 'ok' : '') : null,
      val('SP before the fault') ? fact('SP before', val('SP before the fault').value) : null);
    vAlso.replaceChildren();
    if (V.causes.length > 1) vAlso.append(h('span', { class: 'hf-sub' }, 'Also set: '), ...V.causes.slice(1).map((c) => h('span', { class: 'hf-chip', title: `${c.why}\nNext: ${c.next}` }, c.title)));
  }

  function syncBoxes() {
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(boxes)) {
      if (document.activeElement === el) continue;
      el.value = raw[k] ?? '';
      // An empty field whose value came from the paste shows that value, dimmed.
      const fromPaste = !el.value && res.view.src[k] && res.view.src[k] !== 'field' && res.view.regs[k] != null;
      if (el.dataset.ph == null) el.dataset.ph = el.placeholder;
      el.placeholder = fromPaste ? `${hex8(res.view.regs[k])} (paste)` : el.dataset.ph;
      el.classList.toggle('paste', !!fromPaste);
      el.classList.toggle('bad', (res.warnings || []).some((w) => w.startsWith('Not a 32-bit hex') && w.includes(k)));
    }
    if (document.activeElement !== frameBox) frameBox.value = raw.frame ?? '';
  }

  ctx.onResult((result) => {
    res = result;
    if (!res || !res.view) { warns.replaceChildren(...(res && res.warnings || []).map((w) => h('div', {}, w))); return; }
    const hadFocus = document.activeElement;
    const focusBox = Object.entries(boxes).find(([, el]) => el === hadFocus);
    for (const k of Object.keys(boxes)) if (!STATIC.has(k)) delete boxes[k];
    // Boxes inside redrawn parts are rebuilt; keep typing focus on the same field.
    drawRegs(); drawExc(); drawStack(); drawVerdict();
    if (focusBox && boxes[focusBox[0]] && boxes[focusBox[0]] !== hadFocus) {
      const el = boxes[focusBox[0]];
      el.value = ctx.raw[focusBox[0]] ?? '';
      el.focus();
      const n = el.value.length; el.setSelectionRange(n, n);
    }
    syncBoxes();
    if (focusKey) {
      const el = wrap.querySelector(`[data-id="${focusKey}"]`);
      if (el) el.focus({ preventScroll: true });
      focusKey = null;
    }
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Notes (${(res.notes || []).length})`), ...(res.notes || []).map((n) => h('div', {}, n)));
    notes.hidden = !(res.notes || []).length;
  });
}
