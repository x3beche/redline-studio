// PII & Secret Redactor, drawn as the thing itself: the text with every
// finding highlighted by type, beside what the model will see. Click a
// highlight to keep that value (click again to redact it), click a type
// chip to switch the whole type off, select any text to redact it too.
// Restore mode takes the model's answer and shows it with the values put
// back. Every hit, placeholder and count comes from run()'s result.

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
const FAMILY = { NAME: 'id', EMAIL: 'id', PHONE: 'id', TCKN: 'id', IBAN: 'fin', CARD: 'fin', IPV4: 'net', IPV6: 'net', MAC: 'net',
  PRIVATE_KEY: 'sec', API_KEY: 'sec', JWT: 'sec', URL_CRED: 'sec', PASSWORD: 'sec', SECRET: 'sec', CUSTOM: 'own' };
const STYLES = [['tag', '<EMAIL_1>'], ['bracket', '[EMAIL_1]'], ['redacted', '[REDACTED]'], ['hash', '<EMAIL_9f2c…>']];
const lines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

export function page(root, ctx) {
  const wrap = h('div', { class: 'pr' });
  root.append(wrap);
  let res = null, editing = false, hover = -1, focusId = null;

  // ---------- toolbar ----------
  const seg = (items, key, label) => {
    const box = h('div', { class: 'pr-seg', role: 'radiogroup', 'aria-label': label });
    box._draw = () => box.replaceChildren(...items.map(([v, t]) => h('button', { role: 'radio', 'aria-checked': String(String(ctx.raw[key]) === v),
      onclick: () => ctx.set(key, v) }, t)));
    return box;
  };
  const modeSeg = seg([['redact', 'Redact'], ['restore', 'Restore an answer']], 'mode', 'Mode');
  const styleSeg = seg(STYLES, 'style', 'Placeholder style');
  const entIn = h('input', { type: 'text', class: 'pr-num', inputmode: 'decimal', 'aria-label': 'Entropy threshold, bits per character',
    onchange: (e) => { const v = ctx.parseEng(e.target.value); if (v != null) ctx.set('entropy', v); } });
  const bar = h('div', { class: 'pr-bar' },
    modeSeg, h('span', { class: 'pr-lab' }, 'Placeholder'), styleSeg,
    h('label', { class: 'pr-lab', title: 'Unlabelled tokens of 20+ characters with letters and digits are flagged at or above this Shannon entropy' }, 'Entropy ≥', entIn, 'bits/char'),
    h('span', { class: 'pr-local', title: 'No network call is made with your text; the kit keeps the last input in this browser\'s localStorage.' }, h('i', {}), 'Runs locally: nothing is sent'));

  // ---------- chips ----------
  const chips = h('div', { class: 'pr-chips', role: 'group', 'aria-label': 'Types (click to switch a type off or on)' });

  // ---------- panes ----------
  const origTitle = h('h2', {}, 'Your text');
  const origSub = h('span', { class: 'pr-sub' });
  const editBtn = h('button', { class: 'k-btn', onclick: () => { editing = !editing; drawOrig(); if (editing) ta.focus(); } });
  const clearBtn = h('button', { class: 'k-btn', title: 'Empty the text (and what this browser remembers of it)', onclick: () => { editing = true; ctx.setMany({ text: '', keep: '', extra: '' }); drawOrig(); ta.focus(); } }, 'Clear');
  const selBtn = h('button', { class: 'k-btn k-primary pr-selbtn', hidden: true, onmousedown: (e) => e.preventDefault(), onclick: () => addSelection() }, 'Redact selection');
  const doc = h('div', { class: 'pr-doc', tabindex: '-1' });
  const ta = h('textarea', { class: 'pr-ta', spellcheck: 'false', 'aria-label': 'Text to check', placeholder: 'Paste text, a log, a config or code' });
  let taTimer = 0;
  ta.addEventListener('input', () => { clearTimeout(taTimer); taTimer = setTimeout(() => ctx.set('text', ta.value), 300); });
  const origCard = h('section', { class: 'pr-card' },
    h('div', { class: 'pr-head' }, origTitle, origSub, h('span', { class: 'pr-right' }, selBtn, editBtn, clearBtn)), doc, ta,
    h('div', { class: 'pr-help' }, 'Click a highlight (or focus it and press ', h('kbd', {}, 'Enter'), ') to keep that value; ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' move between findings. Select any text to redact it as well.'));

  const outTitle = h('h2', {});
  const outSub = h('span', { class: 'pr-sub' });
  const outDoc = h('div', { class: 'pr-doc pr-outdoc' });
  const ansTa = h('textarea', { class: 'pr-ta pr-ans', spellcheck: 'false', 'aria-label': 'Model answer', placeholder: 'Paste the model\'s answer written against the redacted text' });
  let ansTimer = 0;
  ansTa.addEventListener('input', () => { clearTimeout(ansTimer); ansTimer = setTimeout(() => ctx.set('answer', ansTa.value), 300); });
  const outCard = h('section', { class: 'pr-card' }, h('div', { class: 'pr-head' }, outTitle, outSub), ansTa, outDoc);

  // ---------- lists ----------
  const namesTa = h('textarea', { class: 'pr-ta pr-small', rows: 3, spellcheck: 'false', 'aria-label': 'Names to find, one per line' });
  let nmTimer = 0;
  namesTa.addEventListener('input', () => { clearTimeout(nmTimer); nmTimer = setTimeout(() => ctx.set('names', namesTa.value), 300); });
  const keptBox = h('div', { class: 'pr-list' });
  const extraBox = h('div', { class: 'pr-list' });
  const side = h('section', { class: 'pr-card pr-side' },
    h('div', { class: 'pr-head' }, h('h2', {}, 'Names to find'), h('span', { class: 'pr-sub' }, 'one per line; names are found only from this list')),
    h('div', { class: 'pr-pad' }, namesTa),
    h('div', { class: 'pr-head pr-top' }, h('h2', {}, 'Kept as is')), keptBox,
    h('div', { class: 'pr-head pr-top' }, h('h2', {}, 'Redacted because you marked it')), extraBox);

  const warns = h('div', { class: 'pr-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'pr-notes' }, h('summary', {}, 'How it finds things, and what it cannot'));

  wrap.append(bar, chips, warns,
    h('div', { class: 'pr-panes' }, origCard, outCard),
    h('div', { class: 'pr-lower' }, side, ctx.outputs), notes);

  // ---------- actions ----------
  const toggleKeep = (value) => {
    const k = lines(ctx.raw.keep);
    const i = k.indexOf(value.trim());
    if (i >= 0) k.splice(i, 1); else k.push(value.trim());
    ctx.set('keep', k.join('\n'));
  };
  const toggleType = (t) => {
    const off = String(ctx.raw.off || '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    const i = off.indexOf(t);
    if (i >= 0) off.splice(i, 1); else off.push(t);
    ctx.set('off', off.join(', '));
  };
  const selectionText = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !doc.contains(sel.anchorNode) || !doc.contains(sel.focusNode)) return '';
    return sel.toString().replace(/^\s+|\s+$/g, '');
  };
  const addSelection = () => {
    const t = selectionText();
    if (!t || t.includes('\n') && t.length > 400) return;
    const ex = lines(ctx.raw.extra);
    if (!ex.includes(t)) ex.push(t);
    window.getSelection().removeAllRanges();
    selBtn.hidden = true;
    ctx.set('extra', ex.join('\n'));
  };
  document.addEventListener('selectionchange', () => { const t = selectionText(); selBtn.hidden = !t || editing; });

  // ---------- drawing ----------
  const text = () => String(ctx.raw.text ?? '');
  const markFor = (sp, label) => {
    const fam = FAMILY[sp.type] || 'own';
    const b = h('button', { class: `pr-mark pr-${fam}${sp.on ? '' : ' pr-kept'}${hover === sp.id ? ' pr-hot' : ''}`, 'data-id': sp.id,
      title: `${sp.type}${sp.note ? ` · ${sp.note}` : ''} → ${sp.on ? sp.ph : 'kept as is (click to redact)'}`,
      'aria-label': `${sp.type} ${sp.on ? `redacted as ${sp.ph}` : 'kept'}; press Enter to ${sp.on ? 'keep' : 'redact'} it`,
      'aria-pressed': String(sp.on) }, label);
    return b;
  };
  const drawOrig = () => {
    editBtn.textContent = editing ? 'Done' : 'Edit text';
    doc.hidden = editing; ta.hidden = !editing;
    if (editing) { if (document.activeElement !== ta) ta.value = text(); return; }
    if (!res) return;
    const t = text(), spans = res.draw.spans;
    const had = doc.contains(document.activeElement) || document.activeElement === document.body;
    const frag = [];
    let at = 0;
    for (const sp of spans) {
      if (sp.start < at) continue;
      frag.push(t.slice(at, sp.start));
      frag.push(markFor(sp, t.slice(sp.start, sp.end)));
      at = sp.end;
    }
    frag.push(t.slice(at));
    if (!t.trim()) frag.push(h('span', { class: 'pr-empty' }, 'No text yet. Press Edit text and paste a log, ticket, config or code.'));
    doc.replaceChildren(...frag);
    if (focusId != null && had) { const el = doc.querySelector(`[data-id="${focusId}"]`); if (el) el.focus({ preventScroll: true }); }
  };
  const drawOut = () => {
    const d = res.draw;
    const restore = d.restore;
    ansTa.hidden = !restore;
    if (restore) {
      outTitle.textContent = 'Model answer, values put back';
      outSub.textContent = `${d.rstats.replaced} put back${d.rstats.unknown.length ? ` · ${d.rstats.unknown.length} unknown` : ''}`;
      if (document.activeElement !== ansTa) ansTa.value = String(ctx.raw.answer ?? '');
      const mapTxt = res.texts.find((x) => x.title === 'Map (sensitive)')?.body || '{}';
      let map = {};
      try { map = JSON.parse(mapTxt).placeholders || {}; } catch { map = {}; }
      const ans = String(ctx.raw.answer ?? '');
      const keys = Object.keys(map).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const look = /<[A-Z][A-Z_]*?_(?:[0-9]+|[0-9a-f]{8})>|\[[A-Z][A-Z_]*?_(?:[0-9]+|[0-9a-f]{8})\]/g;
      const re = new RegExp([...keys, look.source].join('|'), 'g');
      const out = [];
      let at = 0;
      for (const m of ans.matchAll(re)) {
        out.push(ans.slice(at, m.index));
        const known = m[0] in map;
        const type = (/[<[]([A-Z_]+?)_(?:\d+|[0-9a-f]{8})[>\]]/.exec(m[0]) || [])[1] || 'CUSTOM';
        out.push(h('span', { class: `pr-put pr-${FAMILY[type] || 'own'}${known ? '' : ' pr-unknown'}`, title: known ? `${m[0]} put back` : `${m[0]} is not in the map: left as is` }, known ? map[m[0]] : m[0]));
        at = m.index + m[0].length;
      }
      out.push(ans.slice(at));
      if (!ans.trim()) out.push(h('span', { class: 'pr-empty' }, 'Paste the model\'s answer above; placeholders in it are replaced with the real values here.'));
      outDoc.replaceChildren(...out);
      return;
    }
    outTitle.textContent = 'What the model sees';
    const n = d.spans.filter((s) => s.on).length;
    outSub.textContent = `${n} placeholder${n === 1 ? '' : 's'} · ${d.style === 'redacted' ? 'not reversible' : 'reversible with the map'}`;
    const t = text(), out = [];
    let at = 0;
    for (const sp of d.spans) {
      if (!sp.on || sp.start < at) continue;
      out.push(t.slice(at, sp.start));
      const el = h('span', { class: `pr-ph pr-${FAMILY[sp.type] || 'own'}${hover === sp.id ? ' pr-hot' : ''}`, 'data-id': sp.id, title: `${sp.type}: ${sp.note || ''}` }, sp.ph);
      out.push(el);
      at = sp.end;
    }
    out.push(t.slice(at));
    outDoc.replaceChildren(...out);
  };
  const drawChips = () => {
    const d = res.draw;
    const all = Object.keys(d.types).filter((t) => d.byType.some((b) => b.type === t) || String(ctx.raw.off || '').toUpperCase().includes(t));
    chips.replaceChildren(h('span', { class: 'pr-lab' }, 'Found'), ...all.map((t) => {
      const b = d.byType.find((x) => x.type === t) || { n: 0, on: 0, off: true };
      return h('button', { class: `pr-chip pr-${FAMILY[t] || 'own'}${b.off ? ' pr-off' : ''}`, 'aria-pressed': String(!b.off), title: b.off ? `${d.types[t].label}: left as is (click to redact)` : `${d.types[t].label}: redacted (click to leave all as is)`,
        onclick: () => toggleType(t) }, h('i', {}), d.types[t].label, h('b', {}, b.off ? `0/${b.n}` : b.on === b.n ? String(b.n) : `${b.on}/${b.n}`));
    }), ...(all.length ? [] : [h('span', { class: 'pr-sub' }, 'nothing found')]));
  };
  const drawLists = () => {
    const item = (v, onRemove, what) => h('div', { class: 'pr-item' }, h('code', {}, v.length > 60 ? v.slice(0, 57) + '…' : v),
      h('button', { class: 'k-btn pr-x', 'aria-label': `${what} ${v}`, title: what, onclick: onRemove }, '×'));
    const kept = lines(ctx.raw.keep), extra = lines(ctx.raw.extra);
    keptBox.replaceChildren(...(kept.length ? kept.map((v) => item(v, () => toggleKeep(v), 'Redact again')) : [h('div', { class: 'pr-sub pr-pad' }, 'Click a highlight to keep a value that the model needs.')]));
    extraBox.replaceChildren(...(extra.length ? extra.map((v) => item(v, () => ctx.set('extra', extra.filter((x) => x !== v).join('\n')), 'Stop redacting')) : [h('div', { class: 'pr-sub pr-pad' }, 'Select text on the left to redact something the patterns miss.')]));
    if (document.activeElement !== namesTa) namesTa.value = String(ctx.raw.names ?? '');
  };

  // events on the documents (delegated: they are redrawn)
  doc.addEventListener('click', (e) => {
    const m = e.target.closest('.pr-mark');
    if (!m || !res) return;
    const sp = res.draw.spans[Number(m.dataset.id)];
    focusId = sp.id;
    toggleKeep(text().slice(sp.start, sp.end));
  });
  doc.addEventListener('keydown', (e) => {
    const m = e.target.closest('.pr-mark');
    if (!m) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const all = [...doc.querySelectorAll('.pr-mark')];
      const i = all.indexOf(m) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
      if (all[i]) { e.preventDefault(); all[i].focus(); focusId = Number(all[i].dataset.id); }
    }
  });
  const hot = (e) => {
    const m = e.target.closest('[data-id]');
    const id = m ? Number(m.dataset.id) : -1;
    if (id === hover) return;
    hover = id;
    for (const el of wrap.querySelectorAll('.pr-hot')) el.classList.remove('pr-hot');
    if (id >= 0) for (const el of wrap.querySelectorAll(`[data-id="${id}"]`)) el.classList.add('pr-hot');
  };
  for (const d of [doc, outDoc]) { d.addEventListener('pointerover', hot); d.addEventListener('focusin', hot); d.addEventListener('pointerleave', () => hot({ target: d })); }

  // The output panel opens on the redacted text the first time.
  let firstTab = true;
  try { firstTab = !localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
  ctx.onResult((r) => {
    res = r;
    if (firstTab) { firstTab = false; setTimeout(() => [...ctx.outputs.querySelectorAll('.k-tab')].find((b) => b.textContent === (r.draw?.restore ? 'Restored answer' : 'Redacted text'))?.click(), 0); }
    if (!r.draw) return;
    modeSeg._draw(); styleSeg._draw();
    if (document.activeElement !== entIn) entIn.value = String(ctx.raw.entropy ?? '4');
    const n = r.draw.spans.length, on = r.draw.spans.filter((s) => s.on).length;
    origSub.textContent = `${text().length.toLocaleString('en-US')} characters · ${on} of ${n} findings redacted`;
    drawChips(); drawOrig(); drawOut(); drawLists();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'How it finds things, and what it cannot'), ...(r.notes || []).map((x) => h('div', {}, x)),
      h('div', {}, 'Checks: card numbers by Luhn and a known issuer range, IBAN by the country length and mod-97, TC Kimlik No by both check digits, phones by E.164 length or Turkish national formats, IPv6 by RFC 4291 form, keys by vendor prefix, other tokens by Shannon entropy.'));
  });
  if (!text().trim()) editing = true;
}
