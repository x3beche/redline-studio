// Units & Numbers: the page.
//   Rail     - every quantity, grouped, with a search that also finds units
//              ("psi" -> Pressure); the embedded modes (number bases, UART,
//              timer) sit at the top. "/" focuses the search.
//   Omnibox  - one line for anything: "25 psi to bar", "3.3 mil", "0x3F".
//              Enter swaps source and target; recent and pinned questions
//              sit under it as chips.
//   Ladder   - the value in every unit of its quantity, by system. Click a
//              row (or Enter) to start from it, "t" / → to make it the
//              target, "c" / ⧉ to copy its number. Arrow keys move.
//   Side     - a drawing where one helps (a ruler for lengths, the four
//              temperature scales, an angle dial, AWG wires to scale, the
//              unit sizes on a log line), the settings some units need
//              (battery volts, impedance, dpi), related figures, the exact
//              definitions used, and the output panel.
//   Bases / UART / Timer - the embedded helpers: a clickable bit grid with
//              bytes and the float reading; the baud error at every standard
//              rate; the prescaler / resolution trade-off.
// Every number shown comes from run()'s result; the page only writes inputs.
import { QUANTITIES, MODES, BY_ID } from './table.js';

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
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const K = 'redline.tool.units.';
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(K + k) || 'null'); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(K + k, JSON.stringify(v)); } catch { /* private window */ } },
};
const AT = /\s*(?:@|\bat\b)\s*[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s*[kmµu]?\s*(?:V|volts?|Ω|ohms?|dpi|ppi)\b/gi;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
    document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (btn) {
    btn.classList.add(ok ? 'u-copied' : 'u-copyfail');
    setTimeout(() => btn.classList.remove('u-copied', 'u-copyfail'), 1100);
  }
  return ok;
}

export function page(root, ctx) {
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = new URL('style.css', import.meta.url).href;
  document.head.append(css);

  let res = null;
  let recent = LS.get('recent', []), pinned = LS.get('pinned', []), lastQ = LS.get('lastq', {});
  let focusSym = null, bitFocus = null, commitTimer = null, filter = '';

  // ---------------- rail ----------------
  const search = h('input', { type: 'search', class: 'u-search', placeholder: 'Find a quantity or unit', 'aria-label': 'Find a quantity or unit',
    spellcheck: 'false', autocomplete: 'off',
    oninput: (e) => { filter = e.target.value; drawRail(); },
    onkeydown: (e) => {
      if (e.key === 'Enter') { const first = railList.querySelector('.u-ritem'); if (first) first.click(); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { railList.querySelector('.u-ritem')?.focus(); e.preventDefault(); }
      else if (e.key === 'Escape') { search.value = ''; filter = ''; drawRail(); }
    } });
  const railList = h('nav', { class: 'u-rlist', 'aria-label': 'Quantities', onkeydown: railKeys });
  const rail = h('aside', { class: 'u-rail' }, h('div', { class: 'u-sbox' }, search, h('kbd', { class: 'u-kbd', title: 'Press / to search' }, '/')), railList);

  function railMatches() {
    const f = filter.trim().toLowerCase();
    if (!f) return null;
    const out = [];
    for (const m of MODES) if (`${m.name} ${m.blurb}`.toLowerCase().includes(f)) out.push({ mode: m.id, name: m.name, hint: m.blurb });
    for (const q of QUANTITIES) {
      if (`${q.name} ${q.group}`.toLowerCase().includes(f)) { out.push({ q: q.id, name: q.name, hint: q.si }); continue; }
      const u = q.units.find((x) => [x.sym, x.name, ...x.aliases].some((a) => a.replace(/^~/, '').toLowerCase() === f))
        || q.units.find((x) => [x.sym, x.name, ...x.aliases].some((a) => a.replace(/^~/, '').toLowerCase().includes(f)));
      if (u) out.push({ q: q.id, name: q.name, hint: `${u.sym} · ${u.name}`, exact: [u.sym, ...u.aliases].some((a) => a.toLowerCase() === f) });
    }
    return out.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
  }
  function railItem(it) {
    return h('button', { type: 'button', class: 'u-ritem', 'data-q': it.q || null, 'data-mode': it.mode || null, title: it.hint || null,
      onclick: () => (it.mode ? openMode(it.mode) : openQuantity(it.q)) },
      h('span', { class: 'u-rname' }, it.name), it.hint ? h('span', { class: 'u-rhint' }, it.hint) : null);
  }
  function drawRail() {
    const found = railMatches();
    railList.replaceChildren();
    if (found) {
      railList.append(found.length ? h('div', { class: 'u-rgroup' }, found.map(railItem)) : h('div', { class: 'u-rnone' }, 'Nothing by that name. Type it in the box on the right: it reads most units.'));
    } else {
      railList.append(h('div', { class: 'u-rgroup' }, h('div', { class: 'u-rhead' }, 'Embedded'),
        MODES.map((m) => railItem({ mode: m.id, name: m.name }))));
      const groups = [...new Set(QUANTITIES.map((q) => q.group))];
      for (const g of groups) {
        railList.append(h('div', { class: 'u-rgroup' }, h('div', { class: 'u-rhead' }, g),
          QUANTITIES.filter((q) => q.group === g).map((q) => railItem({ q: q.id, name: q.name }))));
      }
    }
    markRail();
  }
  function markRail() {
    const raw = ctx.raw;
    const cur = raw.mode === 'bases' || raw.mode === 'uart' || raw.mode === 'timer' ? `m:${raw.mode}` : res?.view?.q ? `q:${res.view.q}` : '';
    for (const b of railList.querySelectorAll('.u-ritem')) {
      const key = b.dataset.mode ? `m:${b.dataset.mode}` : `q:${b.dataset.q}`;
      if (key === cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
  }
  function railKeys(e) {
    const items = [...railList.querySelectorAll('.u-ritem')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { items[Math.min(items.length - 1, i + 1)].focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { if (i === 0) search.focus(); else items[i - 1].focus(); e.preventDefault(); }
    else if (e.key === 'Home') { items[0].focus(); e.preventDefault(); }
    else if (e.key === 'End') { items[items.length - 1].focus(); e.preventDefault(); }
  }
  function openQuantity(id) {
    const Q = BY_ID.get(id);
    const q = lastQ[id] || Q.ex;
    omni.value = q;
    ctx.setMany({ mode: 'convert', q, unit: '', to: '' });
    omni.focus();
  }
  function openMode(id) { ctx.setMany({ mode: id }); }

  // ---------------- omnibox ----------------
  const omni = h('input', { type: 'text', class: 'u-omni', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Value and unit, e.g. 25 psi to bar',
    placeholder: '25 psi to bar · 3.3 mil · -40 °F · 0x3F',
    oninput: (e) => ctx.setMany({ mode: 'convert', q: e.target.value, to: '' }),
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (!swap()) commit(); }
      else if (e.key === 'ArrowDown') { const r = ladder.querySelector('.u-row[data-src] .u-rbtn') || ladder.querySelector('.u-rbtn') || bitsEl.querySelector('.u-bit'); if (r) { r.focus(); e.preventDefault(); } }
      else if (e.key === 'Escape') omni.select();
    } });
  const swapBtn = h('button', { type: 'button', class: 'u-ibtn', title: 'Swap source and target (Enter)', 'aria-label': 'Swap source and target', onclick: () => swap() }, '⇄');
  const pinBtn = h('button', { type: 'button', class: 'u-ibtn u-pin', title: 'Pin this conversion', 'aria-label': 'Pin this conversion', 'aria-pressed': 'false', onclick: togglePin }, '★');
  const digitsOut = h('output', { class: 'u-dig', 'aria-live': 'polite' });
  const digitsCtl = h('div', { class: 'u-step', role: 'group', 'aria-label': 'Significant figures' },
    h('button', { type: 'button', 'aria-label': 'Fewer significant figures', onclick: () => stepDigits(-1) }, '−'), digitsOut,
    h('button', { type: 'button', 'aria-label': 'More significant figures', onclick: () => stepDigits(1) }, '+'),
    h('span', { class: 'u-steplbl' }, 'sig. fig.'));
  const DIGITS = ['3', '4', '5', '6', '7', '8', '9', '10', '12'];
  function stepDigits(d) { const i = DIGITS.indexOf(String(ctx.raw.digits)); ctx.set('digits', DIGITS[clamp((i < 0 ? 3 : i) + d, 0, DIGITS.length - 1)]); }
  const notSeg = h('div', { class: 'u-seg', role: 'group', 'aria-label': 'Notation' },
    [['auto', 'Auto'], ['eng', 'Eng'], ['sci', 'Sci'], ['plain', 'Plain']].map(([v, t]) => h('button', { type: 'button', 'data-v': v, title: {
      auto: 'Plain from 0.0001 to 10⁹, else scientific', eng: 'Exponents in steps of three (10³, 10⁻⁶)', sci: 'Always ×10ⁿ', plain: 'Always written out' }[v],
    onclick: () => ctx.set('notation', v) }, t)));
  const chips = h('div', { class: 'u-chips', 'aria-label': 'Pinned and recent' });
  const omniBar = h('section', { class: 'u-omnibar' },
    h('div', { class: 'u-orow' }, h('div', { class: 'u-owrap' }, omni, swapBtn, pinBtn)),
    h('div', { class: 'u-orow2' }, chips, h('div', { class: 'u-opts' }, digitsCtl, notSeg)));

  function composeQ(value, sym, target) {
    const at = (ctx.raw.q || '').match(AT) || [];
    return `${value} ${sym}${target ? ` to ${target}` : ''}${at.length ? ` ${at.map((s) => s.trim()).join(' ')}` : ''}`;
  }
  function setQ(q) { omni.value = q; ctx.setMany({ mode: 'convert', q, to: '' }); commitSoon(0); }
  function swap() {
    const v = res?.view;
    if (!v || v.kind !== 'convert' || !v.dst) return false;
    setQ(composeQ(v.dst.c, v.dst.sym, v.src.sym));
    return true;
  }
  function commit() {
    const q = String(ctx.raw.q || '').trim();
    const v = res?.view;
    if (!q || ctx.raw.mode !== 'convert' || !(v?.kind === 'convert' && v.src || v?.route)) return;
    recent = [q, ...recent.filter((x) => x !== q)].slice(0, 8); LS.set('recent', recent);
    if (v.q) { lastQ[v.q] = q; LS.set('lastq', lastQ); }
    drawChips();
  }
  function commitSoon(ms = 1500) { clearTimeout(commitTimer); commitTimer = setTimeout(commit, ms); }
  function togglePin() {
    const q = String(ctx.raw.q || '').trim();
    if (!q) return;
    pinned = pinned.includes(q) ? pinned.filter((x) => x !== q) : [q, ...pinned].slice(0, 12);
    LS.set('pinned', pinned); drawChips();
  }
  function drawChips() {
    const q = String(ctx.raw.q || '').trim();
    pinBtn.setAttribute('aria-pressed', String(pinned.includes(q)));
    pinBtn.title = pinned.includes(q) ? 'Unpin this conversion' : 'Pin this conversion';
    const chip = (x, isPin) => h('span', { class: `u-chip${isPin ? ' u-chip-pin' : ''}` },
      h('button', { type: 'button', class: 'u-chipq', title: x, onclick: () => setQ(x) }, isPin ? '★ ' : '', x),
      h('button', { type: 'button', class: 'u-chipx', 'aria-label': `Remove ${x}`, title: 'Remove',
        onclick: () => { if (isPin) { pinned = pinned.filter((y) => y !== x); LS.set('pinned', pinned); } else { recent = recent.filter((y) => y !== x); LS.set('recent', recent); } drawChips(); } }, '×'));
    const rec = recent.filter((x) => !pinned.includes(x)).slice(0, 6);
    chips.replaceChildren(...pinned.map((x) => chip(x, true)), ...rec.map((x) => chip(x, false)),
      ...(!pinned.length && !rec.length ? [h('span', { class: 'u-chiphint' }, 'Enter swaps · ★ pins · recent ones appear here')] : []));
  }

  // ---------------- main: convert ----------------
  const head = h('section', { class: 'u-head', 'aria-live': 'polite' });
  const msgs = h('div', { class: 'u-msgs' });
  const ladder = h('section', { class: 'u-ladder', 'aria-label': 'Every unit', onkeydown: ladderKeys });
  const convertView = h('div', { class: 'u-convert' }, head, msgs, ladder);

  function rowAction(row, kind, btn) {
    const v = res.view;
    if (kind === 'copy') { copyText(row.c, btn); return; }
    if (kind === 'target') {
      if (row.sym === v.src.sym) return;
      focusSym = row.sym;
      setQ(composeQ(v.src.c, v.src.sym, v.dst?.sym === row.sym ? '' : row.sym));
      return;
    }
    // start from this row; the old source becomes the target if this was it
    focusSym = row.sym;
    if (row.c === '' || row.v == null) return;
    const target = v.dst ? (v.dst.sym === row.sym ? v.src.sym : v.dst.sym) : '';
    setQ(composeQ(row.c, row.sym, target));
  }

  function drawConvert(v) {
    const raw = ctx.raw;
    head.replaceChildren(); msgs.replaceChildren(); ladder.replaceChildren();
    const warn = res.warnings || [];
    if (warn.length) msgs.append(h('div', { class: 'u-warn', role: 'status' }, warn.map((w) => h('div', {}, w))));
    const readNotes = (res.notes || []).filter((n) => /^Read "/.test(n));
    if (readNotes.length) msgs.append(h('div', { class: 'u-read' }, readNotes.map((n) => h('div', {}, n))));
    if (!v || v.kind !== 'convert' || !v.rows) {
      head.append(h('div', { class: 'u-empty' },
        h('div', { class: 'u-emptyh' }, 'Type a value and a unit above'),
        h('div', { class: 'u-examples' }, ['25 psi to bar', '3.3 mil to mm', '-40 °F', 'Δ10 °C in °F', '2000 mAh @ 3.7 V to Wh', '24 AWG', '0 dBm', '4k7', '1 lbf·in to N·m', '64 KiB', '0x3F']
          .map((x) => h('button', { type: 'button', class: 'u-ex', onclick: () => setQ(x) }, x)))));
      return;
    }
    // headline
    const srcRow = v.rows.find((r) => r.sym === v.src.sym);
    const copyBtn = (text, label) => h('button', { type: 'button', class: 'u-ibtn u-cbtn', title: `Copy ${label}`, 'aria-label': `Copy ${label}`, onclick: (e) => copyText(text, e.currentTarget) }, '⧉');
    const big = v.dst
      ? h('div', { class: 'u-big' }, h('span', { class: 'u-bsrc' }, v.src.s, h('small', {}, ` ${v.src.label}`)), h('span', { class: 'u-eq' }, '='),
        h('span', { class: 'u-bdst' }, v.dst.s, h('small', {}, ` ${v.dst.label}`)), copyBtn(v.dst.c, `${v.dst.c} ${v.dst.label}`))
      : h('div', { class: 'u-big' }, h('span', { class: 'u-bsrc' }, v.src.s, h('small', {}, ` ${v.src.label}`)), copyBtn(v.src.c, v.src.c));
    const siRow = v.rows.find((r) => r.sym === v.si);
    head.append(big, h('div', { class: 'u-sub' },
      h('b', {}, v.name), siRow && siRow !== srcRow && siRow.sym !== v.dst?.sym ? h('span', {}, ` · ${siRow.s} ${siRow.label}`) : null,
      h('span', { class: 'u-subhint' }, v.dst ? ' · Enter swaps' : ' · → on a row sets a target')));
    if (v.q === 'temperature' || v.q === 'dtemp') {
      // A temperature or a difference of one: the same number, read two ways.
      const toDiff = (on) => {
        if (on === (v.q === 'dtemp')) return;
        const strip = (x) => x.replace(/^Δ/, '');
        if (on) setQ(composeQ(`Δ${v.src.c}`, v.src.sym, v.dst ? v.dst.sym : ''));
        else if (v.src.sym === 'mK') setQ(composeQ(v.rows.find((r) => r.sym === 'ΔK').c, 'K', v.dst ? strip(v.dst.sym) : ''));
        else setQ(composeQ(v.src.c, strip(v.src.sym), v.dst ? strip(v.dst.sym) : ''));
      };
      head.append(h('div', { class: 'u-seg u-tmode', role: 'group', 'aria-label': 'Temperature or difference' },
        h('button', { type: 'button', 'aria-pressed': String(v.q === 'temperature'), title: 'A point on the scale: 0 °C = 32 °F', onclick: () => toDiff(false) }, 'A temperature'),
        h('button', { type: 'button', 'aria-pressed': String(v.q === 'dtemp'), title: 'A rise or a tolerance: 1 °C = 1.8 °F', onclick: () => toDiff(true) }, 'A difference (Δ)')));
    }
    // ladder, one card per system
    const bySys = {};
    for (const r of v.rows) (bySys[r.sys] ||= []).push(r);
    for (const sys of ['M', 'U', 'O', 'L']) {
      if (!bySys[sys]) continue;
      const card = h('div', { class: 'u-card' }, h('div', { class: 'u-chead' }, v.systems[sys]));
      for (const r of bySys[sys]) {
        const isSrc = r.sym === v.src.sym, isDst = v.dst?.sym === r.sym;
        const tgt = h('button', { type: 'button', class: 'u-mini', tabindex: '-1', 'aria-label': isDst ? `Clear target ${r.label}` : `Make ${r.label} the target`,
          title: isDst ? 'Clear the target' : 'Make this the target (t)', disabled: isSrc || null, onclick: (e) => rowAction(r, 'target', e.currentTarget) }, isDst ? '◉' : '→');
        const cp = h('button', { type: 'button', class: 'u-mini', tabindex: '-1', 'aria-label': `Copy ${r.c} ${r.label}`, title: `Copy ${r.c} (c)`, onclick: (e) => rowAction(r, 'copy', e.currentTarget) }, '⧉');
        const btn = h('button', { type: 'button', class: 'u-rbtn', tabindex: '-1', 'data-sym': r.sym,
          'aria-label': `${r.s} ${r.label}, ${r.name}${isSrc ? ', given' : isDst ? ', target' : ''}`,
          title: isSrc ? 'The value as given' : 'Start from this value (Enter)', onclick: () => rowAction(r, 'source'), onfocus: () => { focusSym = r.sym; } },
          h('span', { class: 'u-rv' }, r.s), h('span', { class: 'u-ru' }, r.label), h('span', { class: 'u-rn' }, r.name));
        card.append(h('div', { class: 'u-row', 'data-src': isSrc || null, 'data-dst': isDst || null }, btn, cp, tgt));
      }
      ladder.append(card);
    }
    // roving focus: one row in the tab order
    const rows = [...ladder.querySelectorAll('.u-rbtn')];
    const keep = rows.find((b) => b.dataset.sym === focusSym) || rows.find((b) => b.closest('[data-src]')) || rows[0];
    if (keep) keep.tabIndex = 0;
    return keep;
  }

  function ladderKeys(e) {
    const rows = [...ladder.querySelectorAll('.u-rbtn')];
    const cur = document.activeElement?.closest?.('.u-row')?.querySelector('.u-rbtn');
    const i = rows.indexOf(cur);
    if (i < 0) return;
    const go = (j) => { const b = rows[clamp(j, 0, rows.length - 1)]; rows.forEach((x) => { x.tabIndex = -1; }); b.tabIndex = 0; b.focus(); };
    const row = res.view.rows.find((r) => r.sym === cur.dataset.sym);
    if (e.key === 'ArrowDown') { go(i + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { if (i === 0) omni.focus(); else go(i - 1); e.preventDefault(); }
    else if (e.key === 'Home') { go(0); e.preventDefault(); }
    else if (e.key === 'End') { go(rows.length - 1); e.preventDefault(); }
    else if (e.key === 'PageDown') { go(i + 8); e.preventDefault(); }
    else if (e.key === 'PageUp') { go(i - 8); e.preventDefault(); }
    else if (e.key === 'c' && !e.ctrlKey && !e.metaKey) { rowAction(row, 'copy', cur.parentElement.querySelector('.u-mini')); e.preventDefault(); }
    else if (e.key === 't' || e.key === 'ArrowRight') { rowAction(row, 'target'); e.preventDefault(); }
  }

  // ---------------- main: number bases ----------------
  const basesView = h('div', { class: 'u-bases' });
  const bitsEl = h('div', { class: 'u-bits', role: 'group', 'aria-label': 'Bits, most significant first', onkeydown: bitKeys });
  const numIn = h('input', { type: 'text', class: 'u-field u-numin', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Number',
    oninput: (e) => ctx.set('num_text', e.target.value) });

  function seg(label, key, opts, cur) {
    return h('div', { class: 'u-seg', role: 'group', 'aria-label': label },
      opts.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(String(cur) === v), onclick: () => ctx.set(key, v) }, t)));
  }
  function writeBits(big) {
    const v = res.view, raw = ctx.raw;
    const w = BigInt(v.width), mask = (1n << w) - 1n;
    big &= mask;
    let text;
    if (raw.num_base === 'dec') text = String(v.neg || String(raw.num_text).trim().startsWith('-') ? (big >= 1n << (w - 1n) ? big - (1n << w) : big) : big);
    else text = { hex: '0x', bin: '0b', oct: '0o' }[raw.num_base] + big.toString({ hex: 16, bin: 2, oct: 8 }[raw.num_base]).toUpperCase();
    ctx.set('num_text', text);
  }
  function bitKeys(e) {
    const bits = [...bitsEl.querySelectorAll('.u-bit')];
    const i = bits.indexOf(document.activeElement);
    if (i < 0) return;
    const go = (j) => { const b = bits[clamp(j, 0, bits.length - 1)]; bits.forEach((x) => { x.tabIndex = -1; }); b.tabIndex = 0; b.focus(); bitFocus = Number(b.dataset.bit); };
    const perRow = Number(bitsEl.dataset.per || 16);
    if (e.key === 'ArrowRight') { go(i + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { go(i - 1); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { go(i + perRow); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { if (i < perRow) numIn.focus(); else go(i - perRow); e.preventDefault(); }
  }

  function drawBases(v) {
    const raw = ctx.raw;
    basesView.replaceChildren();
    if (document.activeElement !== numIn) numIn.value = raw.num_text ?? '';
    const warn = res.warnings || [];
    const top = h('div', { class: 'u-panel u-binput' },
      h('label', { class: 'u-lbl' }, h('span', {}, 'Number'), numIn),
      h('div', { class: 'u-lbl' }, h('span', {}, 'Written in'), seg('Written in', 'num_base', [['dec', 'Dec'], ['hex', 'Hex'], ['bin', 'Bin'], ['oct', 'Oct']], raw.num_base)),
      h('div', { class: 'u-lbl' }, h('span', {}, 'Word'), seg('Word size', 'width', [['8', '8'], ['16', '16'], ['32', '32'], ['64', '64']], raw.width)));
    basesView.append(top);
    if (warn.length) basesView.append(h('div', { class: 'u-warn', role: 'status' }, warn.map((w) => h('div', {}, w))));
    if (!v || v.kind !== 'bases') return;
    // the readings, each with copy
    const tiles = h('div', { class: 'u-tiles' });
    const copyVal = { Decimal: v.c.dec, Hex: v.c.hex, Binary: v.c.bin };
    for (const x of res.values || []) {
      const val = String(x.value);
      const c = copyVal[x.label] ?? val;
      tiles.append(h('div', { class: `u-tile${x.tone === 'ok' ? ' u-tile-given' : ''}${x.label === 'Binary' ? ' u-tile-wide' : ''}` },
        h('span', {}, x.label, x.hint === 'as given' ? h('em', {}, ' · as given') : null),
        h('b', {}, val),
        h('button', { type: 'button', class: 'u-mini u-tcopy', 'aria-label': `Copy ${x.label} ${c}`, title: `Copy ${c}`, onclick: (e) => copyText(c, e.currentTarget) }, '⧉')));
    }
    if (v.float) tiles.append(h('div', { class: 'u-tile u-tile-wide' }, h('span', {}, `As ${v.float.name} (IEEE 754)`), h('b', {}, v.float.s)));
    basesView.append(tiles);
    // the bit grid
    const w = v.width, per = w > 16 ? 16 : w;
    bitsEl.dataset.per = per;
    bitsEl.replaceChildren();
    for (let r0 = 0; r0 < w; r0 += per) {
      const line = h('div', { class: 'u-bline' });
      for (let n = r0; n < r0 + per; n += 4) {
        const nib = h('div', { class: 'u-nib' }, h('div', { class: 'u-nhex' }, v.hex[n / 4]));
        const cells = h('div', { class: 'u-ncells' });
        for (let k = n; k < n + 4; k++) {
          const bit = w - 1 - k, on = v.bits[k] === '1';
          cells.append(h('button', { type: 'button', class: `u-bit${on ? ' u-on' : ''}${bit === w - 1 ? ' u-sign' : ''}`, tabindex: '-1', 'data-bit': bit,
            'aria-pressed': String(on), 'aria-label': `Bit ${bit}${bit === w - 1 ? ' (sign)' : ''}`, title: `Bit ${bit}: click to flip`,
            onclick: () => { bitFocus = bit; writeBits(BigInt(`0x${v.hex}`) ^ (1n << BigInt(bit))); } },
          h('span', { class: 'u-bv' }, on ? '1' : '0'), h('span', { class: 'u-bi' }, bit)));
        }
        nib.append(cells);
        line.append(nib);
      }
      bitsEl.append(line);
    }
    const bits = [...bitsEl.querySelectorAll('.u-bit')];
    const keep = bits.find((b) => Number(b.dataset.bit) === bitFocus) || bits[bits.length - 1];
    keep.tabIndex = 0;
    const cur = BigInt(`0x${v.hex}`), mask = (1n << BigInt(w)) - 1n;
    const ops = h('div', { class: 'u-ops' },
      [['NOT', 'Invert every bit', () => writeBits(~cur)], ['−x', 'Two\'s complement negate', () => writeBits(-cur)],
        ['<< 1', 'Shift left', () => writeBits(cur << 1n)], ['>> 1', 'Logical shift right', () => writeBits(cur >> 1n)],
        ['Clear', 'All bits 0', () => writeBits(0n)], ['All 1', 'All bits 1', () => writeBits(mask)]]
        .map(([t, title, fn]) => h('button', { type: 'button', class: 'u-btn', title, onclick: fn }, t)));
    const bytes = h('div', { class: 'u-bytes' },
      h('div', {}, h('span', { class: 'u-blbl' }, 'Memory, little-endian'), ...v.bytesLE.map((b, i) => h('code', { title: `address +${i}` }, b))),
      h('div', {}, h('span', { class: 'u-blbl' }, 'Memory, big-endian'), ...v.bytesBE.map((b, i) => h('code', { title: `address +${i}` }, b))));
    basesView.append(h('div', { class: 'u-panel' },
      h('div', { class: 'u-phead' }, h('span', { class: 'u-h' }, `${w}-bit register`), h('span', { class: 'u-dim' }, 'click a bit to flip it · arrows move · the sign bit is outlined'), ops),
      bitsEl, bytes));
    return bitFocus != null ? keep : null;
  }

  // ---------------- main: UART ----------------
  const uartView = h('div', { class: 'u-uart' });
  const clkIn = h('input', { type: 'text', class: 'u-field', spellcheck: 'false', 'aria-label': 'Peripheral clock in Hz', oninput: (e) => ctx.set('uart_clk', e.target.value) });
  const baudIn = h('input', { type: 'text', class: 'u-field', spellcheck: 'false', 'aria-label': 'Baud rate', oninput: (e) => ctx.set('baud', e.target.value) });
  const presets = (key, list) => h('div', { class: 'u-presets' }, list.map((x) => h('button', { type: 'button', class: 'u-pre', onclick: () => ctx.set(key, x) }, x)));

  function tilesOf(values) {
    return h('div', { class: 'u-tiles' }, (values || []).map((x) => h('div', { class: `u-tile${x.tone ? ` u-t-${x.tone}` : ''}` },
      h('span', {}, x.label), h('b', {}, typeof x.value === 'number' ? String(x.value) : x.value, x.unit ? h('small', {}, ` ${x.unit}`) : null),
      x.hint ? h('em', {}, x.hint) : null)));
  }

  function drawUart(v) {
    const raw = ctx.raw;
    if (document.activeElement !== clkIn) clkIn.value = raw.uart_clk ?? '';
    if (document.activeElement !== baudIn) baudIn.value = raw.baud ?? '';
    uartView.replaceChildren(
      h('div', { class: 'u-panel u-binput' },
        h('label', { class: 'u-lbl' }, h('span', {}, 'Peripheral clock (Hz)'), clkIn, presets('uart_clk', ['8M', '16M', '48M', '64M', '72M', '80M', '84M', '170M'])),
        h('label', { class: 'u-lbl' }, h('span', {}, 'Baud rate'), baudIn, presets('baud', ['9600', '19200', '57600', '115200', '460800', '921600', '1M']))),
      ...(res.warnings?.length ? [h('div', { class: 'u-warn', role: 'status' }, res.warnings.map((w) => h('div', {}, w)))] : []),
      tilesOf(res.values));
    if (!v || v.kind !== 'uart') return;
    // error at every standard baud rate
    const W = 640, rowH = 22, L = 78, R = 150, T = 22;
    const maxE = Math.max(4, ...v.list.filter((x) => x.err != null).map((x) => Math.min(x.err, 10)));
    const H = T + v.list.length * rowH + 8;
    const X = (e) => L + ((W - L - R) * Math.min(e, maxE)) / maxE;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'u-svg', role: 'img', 'aria-label': 'Baud error at each standard rate' });
    for (const e of [0, 1, 2, maxE > 5 ? 5 : null, maxE].filter((x) => x != null && x <= maxE)) {
      svg.append(sv('line', { x1: X(e), x2: X(e), y1: T - 6, y2: H - 6, class: e === 2 ? 'u-lim' : 'u-grid' }));
      svg.append(sv('text', { x: X(e), y: T - 10, class: 'u-axis', 'text-anchor': 'middle' }, `${e} %`));
    }
    v.list.forEach((x, i) => {
      const y = T + i * rowH;
      const g = sv('g', { class: `u-brow${x.mine ? ' u-mine' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${x.s} baud: ${x.reach ? `error ${x.e}` : 'out of reach'}` });
      g.addEventListener('click', () => ctx.set('baud', String(x.baud)));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { ctx.set('baud', String(x.baud)); e.preventDefault(); } });
      g.append(sv('rect', { x: 0, y: y + 1, width: W, height: rowH - 2, class: 'u-hit' }));
      g.append(sv('text', { x: L - 8, y: y + 15, class: 'u-blab', 'text-anchor': 'end' }, x.s));
      if (x.reach) {
        g.append(sv('rect', { x: L, y: y + 5, width: Math.max(1.5, X(x.err) - L), height: rowH - 10, rx: 2, class: x.err > 2 ? 'u-bad' : x.err > 1 ? 'u-meh' : 'u-good' }));
        g.append(sv('text', { x: W - R + 10, y: y + 15, class: 'u-bval' }, x.e));
        g.append(sv('text', { x: W - 4, y: y + 15, class: 'u-bval', 'text-anchor': 'end' }, `BRR ${x.brr}`));
      } else g.append(sv('text', { x: L + 4, y: y + 15, class: 'u-na' }, 'out of reach: BRR would be under 16'));
      svg.append(g);
    });
    uartView.append(h('div', { class: 'u-panel' },
      h('div', { class: 'u-phead' }, h('span', { class: 'u-h' }, `Every standard rate at ${v.clock}`), h('span', { class: 'u-dim' }, 'the line is the 2 % limit · click a rate to use it')), svg));
  }

  // ---------------- main: timer ----------------
  const timerView = h('div', { class: 'u-timer' });
  const tclkIn = h('input', { type: 'text', class: 'u-field', spellcheck: 'false', 'aria-label': 'Timer clock in Hz', oninput: (e) => ctx.set('tim_clk', e.target.value) });
  const tfIn = h('input', { type: 'text', class: 'u-field', spellcheck: 'false', 'aria-label': 'Target frequency in Hz', oninput: (e) => ctx.set('tim_f', e.target.value) });

  function drawTimer(v) {
    const raw = ctx.raw;
    if (document.activeElement !== tclkIn) tclkIn.value = raw.tim_clk ?? '';
    if (document.activeElement !== tfIn) tfIn.value = raw.tim_f ?? '';
    timerView.replaceChildren(
      h('div', { class: 'u-panel u-binput' },
        h('label', { class: 'u-lbl' }, h('span', {}, 'Timer clock (Hz)'), tclkIn, presets('tim_clk', ['16M', '48M', '72M', '84M', '168M', '170M', '240M'])),
        h('label', { class: 'u-lbl' }, h('span', {}, 'Target frequency (Hz)'), tfIn, presets('tim_f', ['50', '1k', '20k', '25k', '100k'])),
        h('div', { class: 'u-lbl' }, h('span', {}, 'Counter'), seg('Counter width', 'arr_bits', [['16', '16-bit ARR'], ['32', '32-bit ARR']], raw.arr_bits))),
      ...(res.warnings?.length ? [h('div', { class: 'u-warn', role: 'status' }, res.warnings.map((w) => h('div', {}, w)))] : []),
      tilesOf(res.values));
    if (!v || v.kind !== 'timer' || !v.curve.length) return;
    // steps per period against the prescaler, both on log scales
    const W = 640, H = 250, L = 54, R = 14, T = 14, B = 34;
    const lx = (p) => Math.log10(p + 1), maxS = Math.max(...v.curve.map((c) => c.steps)), minS = Math.min(...v.curve.map((c) => c.steps));
    const x0 = lx(v.lo), x1 = Math.max(lx(v.hi), x0 + 0.5), y0 = Math.log10(Math.max(1, minS)), y1 = Math.max(Math.log10(maxS), y0 + 0.5);
    const X = (p) => L + ((W - L - R) * (lx(p) - x0)) / (x1 - x0);
    const Y = (s) => T + (H - T - B) * (1 - (Math.log10(Math.max(1, s)) - y0) / (y1 - y0));
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'u-svg', role: 'img', 'aria-label': 'Steps per period against the prescaler' });
    for (let e = Math.ceil(x0); e <= x1; e++) { svg.append(sv('line', { x1: X(10 ** e - 1), x2: X(10 ** e - 1), y1: T, y2: H - B, class: 'u-grid' })); svg.append(sv('text', { x: X(10 ** e - 1), y: H - B + 14, class: 'u-axis', 'text-anchor': 'middle' }, `${10 ** e - 1}`)); }
    for (let e = Math.ceil(y0); e <= y1; e++) { svg.append(sv('line', { x1: L, x2: W - R, y1: Y(10 ** e), y2: Y(10 ** e), class: 'u-grid' })); svg.append(sv('text', { x: L - 6, y: Y(10 ** e) + 3, class: 'u-axis', 'text-anchor': 'end' }, 10 ** e >= 1e6 ? `1e${e}` : `${10 ** e}`)); }
    svg.append(sv('text', { x: (L + W - R) / 2, y: H - 4, class: 'u-axis', 'text-anchor': 'middle' }, 'PSC (prescaler), log scale'));
    svg.append(sv('text', { x: 12, y: (T + H - B) / 2, class: 'u-axis', 'text-anchor': 'middle', transform: `rotate(-90 12 ${(T + H - B) / 2})` }, 'steps per period'));
    svg.append(sv('path', { d: v.curve.map((c, i) => `${i ? 'L' : 'M'}${X(c.psc).toFixed(1)},${Y(c.steps).toFixed(1)}`).join(''), class: 'u-curve' }));
    for (const c of v.curve) {
      const dot = sv('circle', { cx: X(c.psc), cy: Y(c.steps), r: 2.6, class: c.err < 1e-9 ? 'u-dexact' : c.err > 1 ? 'u-dbad' : 'u-dmeh' });
      dot.append(sv('title', {}, `PSC ${c.psc}, ARR ${c.arr}: ${c.f}, error ${c.e}`)); svg.append(dot);
    }
    for (const c of v.exact) { const d = sv('circle', { cx: X(c.psc), cy: Y(c.steps), r: 3.4, class: 'u-dexact' }); d.append(sv('title', {}, `PSC ${c.psc}, ARR ${c.arr}: exact`)); svg.append(d); }
    const b = v.best;
    svg.append(sv('circle', { cx: X(b.psc), cy: Y(b.steps), r: 6.5, class: 'u-dbest' }));
    svg.append(sv('text', { x: clamp(X(b.psc) + 11, L, W - 150), y: Y(b.steps) < T + 20 ? Y(b.steps) + 18 : Y(b.steps) - 9, class: 'u-blab' }, `PSC ${b.psc} · ARR ${b.arr}`));
    const legend = h('div', { class: 'u-legend' }, h('span', {}, h('i', { class: 'u-lg-exact' }), 'exact'), h('span', {}, h('i', { class: 'u-lg-meh' }), 'under 1 % off'), h('span', {}, h('i', { class: 'u-lg-bad' }), 'over 1 % off'), h('span', {}, h('i', { class: 'u-lg-best' }), 'chosen: finest exact step'));
    const table = v.exact.length ? h('div', { class: 'u-tablewrap' }, h('table', { class: 'u-table' },
      h('thead', {}, h('tr', {}, ['PSC', 'ARR', 'Steps', 'Frequency'].map((c) => h('th', {}, c)))),
      h('tbody', {}, v.exact.map((c) => h('tr', { class: c.psc === b.psc ? 'u-trbest' : null }, h('td', {}, c.psc), h('td', {}, c.arr), h('td', {}, c.steps), h('td', {}, c.f)))))) : null;
    timerView.append(h('div', { class: 'u-panel' },
      h('div', { class: 'u-phead' }, h('span', { class: 'u-h' }, 'Prescaler against resolution'), h('span', { class: 'u-dim' }, 'a bigger PSC reaches slower rates but leaves fewer counter steps (a coarser PWM duty)')),
      svg, legend,
      table ? h('div', { class: 'u-phead u-mt' }, h('span', { class: 'u-h' }, `Exact pairs (${v.exactCount}${v.exactCount >= 400 ? '+' : ''})`), h('span', { class: 'u-dim' }, 'the finest first')) : null, table));
  }

  // ---------------- side ----------------
  const drawPanel = h('section', { class: 'u-panel u-draw' });
  const ctxPanel = h('section', { class: 'u-panel u-ctx' });
  const extrasPanel = h('section', { class: 'u-panel u-extras' });
  const notesPanel = h('section', { class: 'u-notes' });

  function drawSide(v) {
    drawPanel.replaceChildren(); ctxPanel.replaceChildren(); extrasPanel.replaceChildren(); notesPanel.replaceChildren();
    drawPanel.hidden = ctxPanel.hidden = extrasPanel.hidden = true;
    const notes = (res?.notes || []).filter((n) => !/^Read "/.test(n));
    if (notes.length) notesPanel.append(h('div', { class: 'u-h' }, 'Definitions & notes'), ...notes.map((n) => h('p', {}, n)));
    if (!v || v.kind !== 'convert' || !v.rows) return;
    const d = v.draw;
    if (d) {
      drawPanel.hidden = false;
      const svg = d.type === 'ruler' ? drawRuler(d, v) : d.type === 'thermo' ? drawThermo(d, v) : d.type === 'dial' ? drawDial(d, v)
        : d.type === 'log' ? drawLog(d, v) : d.type === 'awg' ? drawAwg(v) : null;
      const title = { ruler: 'To scale', thermo: 'On all four scales', dial: 'The angle', log: 'Where it sits among the units', awg: 'Round wire of this area, among AWG sizes' }[d.type];
      drawPanel.append(h('div', { class: 'u-phead' }, h('span', { class: 'u-h' }, title)), svg);
      if (d.type === 'log') drawPanel.append(h('div', { class: 'u-dim' }, `Each tick is the size of one of that unit, in ${v.si} on a log scale; the marker is ${v.src.s} ${v.src.label}.`));
    }
    const uses = v.ctx.uses || [];
    if (uses.length) {
      ctxPanel.hidden = false;
      const def = { volts: ['Battery voltage', 'V', 'mAh ↔ Wh'], ohms: ['Impedance', 'Ω', 'dBm ↔ volts'], dpi: ['Screen density', 'dpi', 'device px'] };
      ctxPanel.append(h('div', { class: 'u-phead' }, h('span', { class: 'u-h' }, 'Settings for this quantity')));
      for (const k of uses) {
        const [label, unit, why] = def[k];
        const inQ = v.ctx.set && v.ctx.set[k] != null;
        const inp = h('input', { type: 'text', class: 'u-field u-small', spellcheck: 'false', 'aria-label': `${label} in ${unit}`, disabled: inQ || null,
          oninput: (e) => ctx.set(k, e.target.value) });
        inp.value = inQ ? v.ctx[k] : ctx.raw[k] ?? '';
        ctxPanel.append(h('label', { class: 'u-crow' }, h('span', {}, label), inp, h('i', {}, unit), h('em', {}, inQ ? 'set in the question' : why)));
      }
    }
    if (v.extras?.length) {
      extrasPanel.hidden = false;
      extrasPanel.append(h('div', { class: 'u-phead' }, h('span', { class: 'u-h' }, 'Related')),
        h('div', { class: 'u-xlist' }, v.extras.map((x) => h('div', { class: 'u-x' }, h('span', {}, x.label), h('b', {}, x.s),
          h('button', { type: 'button', class: 'u-mini', 'aria-label': `Copy ${x.c}`, title: `Copy ${x.c}`, onclick: (e) => copyText(x.c.replace(/ .*$/, ''), e.currentTarget) }, '⧉')))));
    }
  }

  function svgFor(Hh) {
    const W = Math.max(280, Math.round(drawPanel.clientWidth - 22) || 380);
    return [W, sv('svg', { viewBox: `0 0 ${W} ${Hh}`, class: 'u-svg', width: '100%', role: 'img' })];
  }
  function drawRuler(d, v) {
    const [W, svg] = svgFor(128);
    const L = 14, R = 14, y = 64, X = (f) => L + (W - L - R) * f;
    svg.setAttribute('aria-label', `A ruler: ${v.src.s} ${v.src.label}`);
    svg.append(sv('rect', { x: L, y: y - 40, width: W - L - R, height: 80, rx: 4, class: 'u-rulerbg' }));
    svg.append(sv('rect', { x: L, y: y - 5, width: Math.max(1, X(d.at) - L), height: 10, class: 'u-rulerfill' }));
    const scale = (s, dir) => {
      for (const m of s.minor) svg.append(sv('line', { x1: X(m), x2: X(m), y1: y - dir * 8, y2: y - dir * 15, class: 'u-tick' }));
      let lastX = -99;
      for (const m of s.major) {
        svg.append(sv('line', { x1: X(m.x), x2: X(m.x), y1: y - dir * 8, y2: y - dir * 24, class: 'u-tickM' }));
        if (X(m.x) - lastX > 34) { svg.append(sv('text', { x: X(m.x), y: dir > 0 ? y - 28 : y + 37, class: 'u-axis', 'text-anchor': 'middle' }, m.l)); lastX = X(m.x); }
      }
      svg.append(sv('text', { x: L + 2, y: dir > 0 ? y - 44 + 2 : y + 52, class: 'u-runit' }, s.sym));
    };
    scale(d.top, 1); scale(d.bottom, -1);
    svg.append(sv('line', { x1: X(d.at), x2: X(d.at), y1: y - 44, y2: y + 44, class: 'u-mark' }));
    const lab = `${v.src.s} ${v.src.label}`;
    svg.append(sv('text', { x: clamp(X(d.at), L + 40, W - R - 40), y: 14, class: 'u-marklab', 'text-anchor': 'middle' }, lab));
    return svg;
  }
  function drawThermo(d, v) {
    const [W, svg] = svgFor(214);
    const L = 34, R = 12, X = (k) => L + ((W - L - R) * (k - d.lo)) / (d.hi - d.lo);
    svg.setAttribute('aria-label', 'Celsius, Fahrenheit, kelvin and Rankine scales');
    d.scales.forEach((s, i) => {
      const y = 22 + i * 30;
      svg.append(sv('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'u-tickM' }));
      svg.append(sv('text', { x: L - 6, y: y + 4, class: 'u-runit', 'text-anchor': 'end' }, s.sym));
      let lastX = -99;
      for (const t of s.ticks) {
        svg.append(sv('line', { x1: X(t.k), x2: X(t.k), y1: y - 4, y2: y + 4, class: 'u-tick' }));
        if (X(t.k) - lastX > 30 && X(t.k) > L + 8) { svg.append(sv('text', { x: X(t.k), y: y - 7, class: 'u-axis', 'text-anchor': 'middle' }, t.l)); lastX = X(t.k); }
      }
    });
    // landmarks under the scales, in three lanes, each label where it fits
    const lanes = [-1e9, -1e9, -1e9];
    for (const m of d.marks) {
      const x = X(m.k), wdt = m.l.length * 5.9 + 8;
      const lx = clamp(x - wdt / 2, 2, W - wdt - 2);
      const lane = lanes.findIndex((end) => end < lx);
      if (lane < 0) continue;
      lanes[lane] = lx + wdt;
      svg.append(sv('line', { x1: x, x2: x, y1: 132, y2: 140 + lane * 15, class: 'u-land' }));
      svg.append(sv('text', { x: lx + wdt / 2, y: 150 + lane * 15, class: 'u-landt', 'text-anchor': 'middle' }, m.l));
    }
    const x = X(d.K);
    svg.append(sv('line', { x1: x, x2: x, y1: 8, y2: 134, class: 'u-mark' }));
    const lab = v.rows.map((r) => `${r.s} ${r.label}`).join(' = ');
    svg.append(sv('text', { x: W / 2, y: 206, class: 'u-marklab', 'text-anchor': 'middle' }, lab));
    return svg;
  }
  function drawDial(d, v) {
    const [W, svg] = svgFor(200);
    const cx = W / 2, cy = 100, r = 78;
    svg.setAttribute('aria-label', 'The angle on a dial');
    svg.append(sv('circle', { cx, cy, r, class: 'u-dialbg' }));
    for (let a = 0; a < 360; a += 15) {
      const t = (a * Math.PI) / 180, big = a % 90 === 0;
      svg.append(sv('line', { x1: cx + Math.cos(t) * (r - (big ? 10 : 5)), y1: cy - Math.sin(t) * (r - (big ? 10 : 5)), x2: cx + Math.cos(t) * r, y2: cy - Math.sin(t) * r, class: big ? 'u-tickM' : 'u-tick' }));
    }
    for (const [a, l] of [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']]) {
      const t = (a * Math.PI) / 180;
      svg.append(sv('text', { x: cx + Math.cos(t) * (r + 14), y: cy - Math.sin(t) * (r + 14) + 4, class: 'u-axis', 'text-anchor': 'middle' }, l));
    }
    const turns = d.rad / (2 * Math.PI);
    const frac = turns - Math.trunc(turns);
    const ang = frac * 2 * Math.PI;
    const ex = cx + Math.cos(ang) * (r - 4), ey = cy - Math.sin(ang) * (r - 4);
    if (Math.abs(frac) > 1e-9) {
      const large = Math.abs(frac) > 0.5 ? 1 : 0, sweep = frac > 0 ? 0 : 1;
      svg.append(sv('path', { d: `M${cx},${cy} L${cx + r - 4},${cy} A${r - 4},${r - 4} 0 ${large} ${sweep} ${ex},${ey} Z`, class: 'u-wedge' }));
    }
    svg.append(sv('line', { x1: cx, y1: cy, x2: ex, y2: ey, class: 'u-mark' }));
    const deg = v.rows.find((x) => x.sym === '°');
    svg.append(sv('text', { x: 10, y: 20, class: 'u-marklab' }, `${deg ? deg.s : ''}°`));
    if (Math.abs(turns) >= 1) svg.append(sv('text', { x: 10, y: 36, class: 'u-axis' }, `${v.rows.find((x) => x.sym === 'turn')?.s} turns`));
    return svg;
  }
  function drawLog(d, v) {
    const lo = Math.floor(Math.min(d.at, ...d.units.map((u) => u.e))) - 0.3, hi = Math.ceil(Math.max(d.at, ...d.units.map((u) => u.e))) + 0.3;
    const [W, svg] = svgFor(150);
    const L = 12, R = 12, y = 74, X = (e) => L + ((W - L - R) * (e - lo)) / (hi - lo);
    svg.setAttribute('aria-label', `The size of each unit on a log scale, with ${v.src.s} ${v.src.label} marked`);
    svg.append(sv('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'u-tickM' }));
    const step = Math.max(1, Math.ceil((hi - lo) / Math.max(4, Math.floor((W - L - R) / 38))));
    for (let e = Math.ceil(lo); e <= hi; e++) {
      svg.append(sv('line', { x1: X(e), x2: X(e), y1: y - 3, y2: y + 3, class: 'u-tick' }));
      if (e % step === 0) svg.append(sv('text', { x: X(e), y: y + 3 + 12 * 0 + 13, class: 'u-axis u-exp', 'text-anchor': 'middle' }, `10${String(e).replace(/./g, (c) => ({ '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' })[c] ?? c)}`));
    }
    // unit labels: metric above, the rest below, stepped so they do not collide
    const place = (list, dir) => {
      const lanes = [];
      for (const u of [...list].sort((a, b) => a.e - b.e)) {
        const x = X(u.e), wdt = u.sym.length * 6.4 + 6;
        let lane = lanes.findIndex((end) => end < x - wdt / 2);
        if (lane < 0) { lane = lanes.length; lanes.push(0); }
        if (lane > 2) continue;
        lanes[lane] = x + wdt / 2;
        const ty = dir > 0 ? y - 12 - lane * 13 : y + 30 + lane * 13;
        svg.append(sv('line', { x1: x, x2: x, y1: y, y2: dir > 0 ? ty + 3 : ty - 10, class: `u-ul u-ul-${u.sys}` }));
        svg.append(sv('text', { x, y: ty, class: `u-ut u-ut-${u.sys}${u.sym === v.src.sym || u.sym === v.dst?.sym ? ' u-ut-on' : ''}`, 'text-anchor': 'middle' }, u.sym));
      }
    };
    place(d.units.filter((u) => u.sys === 'M'), 1);
    place(d.units.filter((u) => u.sys !== 'M'), -1);
    const x = X(d.at);
    svg.append(sv('path', { d: `M${x - 6},${y - 58} L${x + 6},${y - 58} L${x},${y - 50} Z`, class: 'u-markfill' }));
    svg.append(sv('line', { x1: x, x2: x, y1: y - 50, y2: y + 8, class: 'u-mark' }));
    svg.append(sv('text', { x: clamp(x, L + 50, W - R - 50), y: y - 62, class: 'u-marklab', 'text-anchor': 'middle' }, `${v.src.s} ${v.src.label}`));
    return svg;
  }
  function drawAwg(v) {
    const list = v.awg || [];
    const [W, svg] = svgFor(160);
    svg.setAttribute('aria-label', 'Wire cross-sections to scale');
    const mmRow = v.rows.find((r) => r.sym === 'mm²');
    const dMine = mmRow?.v > 0 ? Math.sqrt((4 * mmRow.v) / Math.PI) : 0;
    const maxD = Math.max(dMine, ...list.map((x) => x.dmm));
    const scale = Math.min(96 / maxD, (W - 20) / list.reduce((s, x) => s + x.dmm + 0.25 * maxD, 0));
    let x = 10, i = 0;
    for (const w of list) {
      const r = (w.dmm * scale) / 2;
      const cx = x + r;
      svg.append(sv('circle', { cx, cy: 64, r: Math.max(0.8, r), class: w.mine ? 'u-wire u-wire-on' : 'u-wire' }));
      svg.append(sv('text', { x: cx, y: 128, class: `u-axis${w.mine ? ' u-ut-on' : ''}`, 'text-anchor': 'middle' }, w.name));
      svg.append(sv('text', { x: cx, y: 141 + (i++ % 2) * 12, class: 'u-axis u-dim2', 'text-anchor': 'middle' }, w.d));
      x += w.dmm * scale + 0.25 * maxD * scale;
    }
    svg.append(sv('text', { x: 10, y: 12, class: 'u-axis' }, 'AWG · diameter in mm'));
    return svg;
  }

  // ---------------- layout ----------------
  const main = h('section', { class: 'u-main' }, omniBar, convertView, basesView, uartView, timerView);
  const side = h('aside', { class: 'u-side' }, drawPanel, ctxPanel, extrasPanel, notesPanel, ctx.outputs);
  root.classList.add('u-root');
  root.append(h('div', { class: 'u' }, rail, main, side));
  drawRail(); drawChips();

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault(); search.focus(); search.select();
  });
  let lastW = 0;
  new ResizeObserver(() => { const w = drawPanel.clientWidth; if (Math.abs(w - lastW) > 20 && res) { lastW = w; drawSide(res.view); } }).observe(drawPanel);

  // ---------------- each result ----------------
  function render() {
    const raw = ctx.raw;
    const mode = ['bases', 'uart', 'timer'].includes(raw.mode) ? raw.mode : 'convert';
    const v = res?.view;
    convertView.hidden = mode !== 'convert'; basesView.hidden = mode !== 'bases'; uartView.hidden = mode !== 'uart'; timerView.hidden = mode !== 'timer';
    root.dataset.mode = mode;
    if (document.activeElement !== omni && mode === 'convert') omni.value = raw.q ?? '';
    if (document.activeElement !== omni && mode === 'bases' && v?.kind === 'bases' && !/^\s*(0[xbo]|[-+]?\d)/i.test(omni.value)) omni.value = raw.num_text ?? '';
    swapBtn.disabled = !(mode === 'convert' && v?.dst);
    digitsOut.textContent = raw.digits || '6';
    for (const b of notSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === (raw.notation || 'auto')));
    const hadFocusIn = (el) => el.contains(document.activeElement) || document.activeElement === document.body;
    const ladderFocus = ladder.contains(document.activeElement), bitsFocus = bitsEl.contains(document.activeElement);
    let refocus = null;
    if (mode === 'convert') { const k = drawConvert(v); if (ladderFocus || (focusSym && hadFocusIn(ladder))) refocus = k; }
    if (mode === 'bases') { const k = drawBases(v); if (bitsFocus || (bitFocus != null && document.activeElement === document.body)) refocus = k; }
    if (mode === 'uart') drawUart(v);
    if (mode === 'timer') drawTimer(v);
    if (refocus && refocus.dataset.sym === focusSym || refocus?.dataset.bit != null) refocus.focus({ preventScroll: true });
    drawSide(mode === 'convert' ? v : null);
    if (mode !== 'convert') {
      // the embedded modes' notes still go on the side
      const notes = res?.notes || [];
      notesPanel.replaceChildren(...(notes.length ? [h('div', { class: 'u-h' }, 'Notes'), ...notes.map((n) => h('p', {}, n))] : []));
    }
    markRail(); drawChips();
  }

  ctx.onResult((r) => {
    res = r;
    const raw = ctx.raw, v = r?.view;
    // The first calculator's length mode opens as a conversion.
    if (raw.mode === 'length' || !raw.mode) {
      const u = { um: 'µm', mm: 'mm', mil: 'mil', in: 'in' }[raw.len_unit] || 'mm';
      const q = String(raw.q || '').trim() || `${raw.len_value ?? 1.6} ${u}`;
      omni.value = q;
      ctx.setMany({ mode: 'convert', q });
      return;
    }
    // "0x3F" typed in the box: the number-bases view.
    if (raw.mode === 'convert' && v?.route) {
      ctx.setMany({ mode: 'bases', num_text: v.route.num_text, num_base: v.route.num_base });
      commitSoon();
      return;
    }
    // Remember the unit, so a bare number means the same unit next time.
    if (raw.mode === 'convert' && v?.kind === 'convert' && v.src && v.src.text && raw.unit !== v.src.sym) {
      ctx.set('unit', v.src.sym);
      return;
    }
    if (raw.mode === 'convert' && v?.kind === 'convert' && v.src) commitSoon();
    render();
  });
}
