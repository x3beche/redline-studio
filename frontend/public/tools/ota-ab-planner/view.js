// OTA A/B Update Planner, drawn as the things themselves: the storage as a
// strip of partitions with the two slots, the image inside them and the
// bootloader area, and the update as a sequence - who acts at each step
// (update client, bootloader, userspace, a reset) and what every boot-count
// variable holds after it.
//   Drag a partition's right edge to size it (A and B move together), drag
//   the image marker in slot A to the image size, click a partition to edit
//   it; pick the framework, the bootloader and the scenario at the top; walk
//   the steps with the arrows or by clicking a row - the strip shows which
//   slot runs and which is being written at that step.
// Every number drawn comes from run()'s result.draw.

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
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
const rc = (el, ...k) => el.replaceChildren(...k.flat().filter((x) => x != null && x !== false));
const fmt = (m) => (m >= 1024 ? `${Math.round(m / 1024 * 100) / 100} GiB` : m >= 1 ? `${Math.round(m * 10) / 10} MiB` : `${Math.round(m * 1024)} KiB`);
const sizeText = (m) => (m >= 1024 && Math.abs(m / 1024 - Math.round(m / 1024 * 4) / 4) < 1e-9 ? `${Math.round(m / 1024 * 4) / 4}G` : `${Math.round(m)}M`);
const clip = (t, n) => (t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t);

const LANES = [['client', 'Update client'], ['boot', 'Bootloader'], ['user', 'Userspace']];
const ROLE_CLS = { raw: 'r-raw', boot: 'r-boot', rootfs: 'r-root', data: 'r-data', other: 'r-other' };
const LS = 'redline.ota-ab-planner.view';

export function page(root, ctx) {
  const st = { step: 0, sel: null, lock: true };
  try { Object.assign(st, JSON.parse(localStorage.getItem(LS) || '{}')); } catch { /* ignore */ }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify({ lock: st.lock })); } catch { /* ignore */ } };
  let res = null, typing = null, dragging = false, focusId = null, lastScenario = null;
  const wrap = h('div', { class: 'ota' });
  root.append(wrap);

  // ---------- top ----------
  const seg = (key, opts, label) => h('span', { class: 'seg', role: 'group', 'aria-label': label, 'data-key': key },
    opts.map(([v, t]) => h('button', { type: 'button', 'data-v': v, onclick: () => ctx.set(key, v) }, t)));
  const fwSeg = seg('framework', [['rauc', 'RAUC'], ['swupdate', 'SWUpdate'], ['mender', 'Mender']], 'Update framework');
  const blSeg = seg('bootloader', [['uboot', 'U-Boot'], ['grub', 'GRUB'], ['barebox', 'barebox']], 'Bootloader');
  const fields = {};
  const txt = (key, label, cls) => {
    const el = h('input', { type: 'text', spellcheck: 'false', class: `mono ${cls || ''}`, 'aria-label': label,
      oninput: (e) => { clearTimeout(typing); const v = e.target.value; typing = setTimeout(() => ctx.set(key, v), 280); } });
    fields[key] = el;
    return h('label', { class: 'fl' }, h('span', {}, label), el);
  };
  const top = h('div', { class: 'ota-top' }, h('span', { class: 'grp' }, fwSeg, blSeg),
    txt('device', 'Device', 'dev'), txt('storageSize', 'Size', 'short'), txt('align', 'Align', 'short'), txt('compatible', 'Compatible', 'mid'), txt('version', 'Version', 'short'));

  // ---------- storage ----------
  const strip = s('svg', { class: 'ota-strip', role: 'group', 'aria-label': 'Storage layout' });
  const stripHead = h('div', { class: 'ota-head' });
  const insp = h('div', { class: 'ota-insp' });
  const lockBox = h('input', { type: 'checkbox', onchange: (e) => { st.lock = e.target.checked; save(); } });
  const envBox = h('input', { type: 'checkbox', onchange: (e) => ctx.set('envRedundant', e.target.checked) });
  const imgRow = h('div', { class: 'ota-imgrow' },
    txt('imageSize', 'Rootfs image', 'short'), txt('growth', 'Growth %', 'tiny'),
    h('label', { class: 'chk', title: 'Resize slot B with slot A (and boot B with boot A)' }, lockBox, 'A = B'),
    h('span', { class: 'u-env' }, h('label', { class: 'chk' }, envBox, 'redundant env'), txt('envOffset', 'env @', 'short'), txt('envSize', 'size', 'short')));
  const storeCard = h('section', { class: 'ota-card' }, stripHead, h('div', { class: 'ota-stripwrap' }, strip), imgRow, insp,
    h('div', { class: 'ota-help' }, 'Drag a partition\'s right edge to size it, or the ', h('b', {}, '▼'), ' image marker in slot A. Click a partition to edit it. Focused handles: ',
      h('kbd', {}, '←'), h('kbd', {}, '→'), ' one alignment step, ', h('kbd', {}, 'Shift'), ' ×8.'));

  // ---------- steps ----------
  const scSeg = seg('scenario', [['ok', 'Update succeeds'], ['panic', 'New slot panics'], ['health', 'Health check fails']], 'Scenario');
  const limitOut = h('b', { class: 'mono' });
  const limitCtl = h('span', { class: 'limit' }, h('span', { class: 'lab' }, 'boot attempts'),
    h('button', { type: 'button', class: 'k-btn', 'aria-label': 'Fewer attempts', onclick: () => ctx.set('bootlimit', Math.max(0, (Number(ctx.raw.bootlimit) || 0) - 1)) }, '−'),
    limitOut,
    h('button', { type: 'button', class: 'k-btn', 'aria-label': 'More attempts', onclick: () => ctx.set('bootlimit', (Number(ctx.raw.bootlimit) || 0) + 1) }, '+'));
  const stepPos = h('span', { class: 'pos mono' });
  const prev = h('button', { type: 'button', class: 'k-btn', 'aria-label': 'Previous step', onclick: () => goStep(st.step - 1) }, '◀');
  const next = h('button', { type: 'button', class: 'k-btn', 'aria-label': 'Next step', onclick: () => goStep(st.step + 1) }, '▶');
  const seqHead = h('div', { class: 'ota-head' });
  const seq = h('div', { class: 'ota-seq', role: 'grid', 'aria-label': 'Update steps' });
  const seqCard = h('section', { class: 'ota-card' }, seqHead,
    h('div', { class: 'ota-seqbar' }, scSeg, limitCtl, h('span', { class: 'nav' }, prev, stepPos, next)),
    h('div', { class: 'ota-seqwrap' }, seq),
    h('div', { class: 'ota-help' }, 'Click a step (or ', h('kbd', {}, '↑'), h('kbd', {}, '↓'), ') to see it on the storage strip. Highlighted cells are the variables that step writes.'));

  const findBox = h('section', { class: 'ota-card find' });
  wrap.append(top, h('div', { class: 'ota-grid' }, h('div', { class: 'ota-col main' }, storeCard, seqCard), h('div', { class: 'ota-col side' }, findBox, ctx.outputs)));

  // ---------- editing the partition table ----------
  const rows = () => (ctx.raw.parts || []).map((r) => ({ ...r }));
  const setRows = (r) => ctx.set('parts', r);
  const alignM = () => res?.draw?.align || 1;
  function resize(i, sizeM, commit = true) {
    const r = rows();
    if (!r[i]) return;
    const a = alignM();
    const v = Math.max(a, Math.round(sizeM / a) * a);
    r[i].size = sizeText(v);
    if (st.lock && (r[i].slot === 'A' || r[i].slot === 'B')) {
      const twin = r.findIndex((x, j) => j !== i && x.role === r[i].role && x.slot && x.slot !== r[i].slot);
      if (twin >= 0) r[twin].size = r[i].size;
    }
    if (commit) setRows(r);
    return r;
  }

  // ---------- the strip ----------
  function layoutX(d, W) {
    const parts = d.parts;
    const free = Math.max(0, d.total - d.used);
    const items = [...parts.map((p) => ({ p, m: p.size })), ...(free > 0.5 ? [{ free: true, m: free }] : [])];
    const minW = W < 520 ? 34 : 50;
    // small partitions get a minimum width; the rest share what is left in proportion
    let fixedIdx = new Set();
    for (let k = 0; k < 4; k++) {
      const fixedW = fixedIdx.size * minW;
      const restM = items.reduce((a, x, i) => a + (fixedIdx.has(i) ? 0 : x.m), 0) || 1;
      const scale = (W - fixedW) / restM;
      let changed = false;
      items.forEach((x, i) => { if (!fixedIdx.has(i) && x.m * scale < minW) { fixedIdx.add(i); changed = true; } });
      if (!changed) break;
    }
    const restM = items.reduce((a, x, i) => a + (fixedIdx.has(i) ? 0 : x.m), 0) || 1;
    const scale = (W - fixedIdx.size * minW) / restM;
    let x = 0;
    return items.map((it, i) => {
      const w = fixedIdx.has(i) ? minW : Math.max(1, it.m * scale);
      const o = { ...it, x, w, pxPerM: fixedIdx.has(i) ? minW / Math.max(it.m, 1) : scale, squeezed: fixedIdx.has(i) };
      x += w;
      return o;
    });
  }

  function drawStrip(d) {
    const act = strip.contains(document.activeElement) ? document.activeElement.getAttribute('data-id') : null;
    const had = act || (dragging && focusId);
    rc(strip);
    const W = Math.max(300, Math.floor(strip.parentNode.clientWidth || 800));
    const narrow = W < 560;
    const top = 30, bh = narrow ? 84 : 96, H = top + bh + 44;
    strip.setAttribute('viewBox', `0 0 ${W} ${H}`);
    strip.setAttribute('height', H);
    const L = layoutX(d, W - 2);
    const step = d.steps[Math.min(st.step, d.steps.length - 1)] || {};
    const defs = s('defs');
    const pat = s('pattern', { id: 'ota-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(s('rect', { width: 6, height: 6, class: 'hatch-bg' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hatch-ln' }));
    const pat2 = s('pattern', { id: 'ota-write', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' });
    pat2.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'write-ln' }));
    defs.append(pat, pat2);
    strip.append(defs);
    const X0 = 1;
    for (const it of L) {
      const x = X0 + it.x, w = it.w;
      if (it.free) {
        strip.append(s('rect', { x, y: top, width: w, height: bh, class: 'seg-free' }));
        if (w > 44) strip.append(s('text', { x: x + w / 2, y: top + bh / 2 + 4, 'text-anchor': 'middle', class: 'soft small' }, `free ${fmt(it.m)}`));
        continue;
      }
      const p = it.p;
      const g = s('g', { class: `part ${ROLE_CLS[p.role] || 'r-other'}${st.sel === p.i ? ' sel' : ''}`, tabindex: '0', role: 'button', 'data-id': `p${p.i}`,
        'aria-label': `${p.name}: ${p.role}${p.slot ? ' slot ' + p.slot : ''}, ${fmt(p.size)} at ${fmt(p.start)}` });
      g.append(s('rect', { x, y: top, width: w, height: bh, class: 'pb', fill: p.role === 'raw' ? 'url(#ota-hatch)' : null }));
      // the image inside a rootfs slot
      if (p.role === 'rootfs' && d.image && p.size > 0) {
        const fr = Math.min(1, d.image / p.size);
        const over = d.image > p.size;
        g.append(s('rect', { x, y: top + bh - 22, width: Math.max(1, w * fr), height: 22, class: over ? 'img over' : 'img' }));
        const gx = x + Math.min(1, (d.image * (1 + d.growth / 100)) / p.size) * w;
        g.append(s('line', { x1: gx, x2: gx, y1: top + bh - 26, y2: top + bh, class: 'growth' }));
        if (w > 70) g.append(s('text', { x: x + 5, y: top + bh - 7, class: 'small imgt' }, clip(`${over ? 'too big: ' : 'image '}${fmt(d.image)}`, Math.floor((w - 10) / 6.1))));
      }
      if (step.write && p.slot === step.write && (p.role === 'rootfs' || p.role === 'boot')) g.append(s('rect', { x, y: top, width: w, height: bh, class: 'writing', fill: 'url(#ota-write)' }));
      if (step.run && p.slot === step.run && p.role === 'rootfs') g.append(s('rect', { x: x + 1.5, y: top + 1.5, width: w - 3, height: bh - 3, class: 'running' }));
      const letters = Math.floor((w - 10) / 6.8);
      if (p.slot) g.append(s('text', { x: x + w - 6, y: top + 26, 'text-anchor': 'end', class: 'slot' }, p.slot));
      if (letters >= 3) {
        g.append(s('text', { x: x + 5, y: top + 15, class: 'pn' }, clip(p.name, letters)));
        g.append(s('text', { x: x + 5, y: top + 29, class: 'small soft' }, clip(fmt(p.size), letters)));
        if (bh > 70 && letters >= 6) g.append(s('text', { x: x + 5, y: top + 43, class: 'small soft' }, clip(p.num ? `p${p.num} · ${p.fs}` : 'raw', letters)));
      }
      g.append(s('rect', { x: x + 1, y: top + 1, width: Math.max(0, w - 2), height: bh - 2, class: 'ring' }));
      const tt = s('title'); tt.textContent = `${p.name} (${p.role}${p.slot ? ' ' + p.slot : ''})\n${p.path}\nstart ${fmt(p.start)}, size ${fmt(p.size)}, ${p.fs}${it.squeezed ? '\n(drawn wider than to scale)' : ''}`; g.append(tt);
      g.addEventListener('click', () => { st.sel = p.i; drawStrip(d); drawInspector(d); });
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = p.i; drawStrip(d); drawInspector(d); insp.querySelector('input')?.focus(); } });
      track(g, `p${p.i}`);
      strip.append(g);
      // labels under the strip: running / writing
      if (step.run && p.slot === step.run && p.role === 'rootfs') {
        strip.append(s('path', { d: `M${x + w / 2 - 6},${top - 12} L${x + w / 2 + 6},${top - 12} L${x + w / 2},${top - 4} z`, class: 'run-mk' }));
        strip.append(s('text', { x: x + w / 2, y: top - 16, 'text-anchor': 'middle', class: 'small run-t' }, `running ${p.slot}`));
      }
      if (step.write && p.slot === step.write && p.role === 'rootfs') strip.append(s('text', { x: x + w / 2, y: top - 8, 'text-anchor': 'middle', class: 'small write-t' }, `writing ${p.slot}`));
      // offsets
      if (w > 56 || p.i === 0) strip.append(s('text', { x, y: top + bh + 13, class: 'small soft' }, fmt(p.start).replace(' ', '')));
      // resize handle on the right edge
      if (!p.rest) {
        const hx = x + w;
        const hg = s('g', { class: 'hdl', tabindex: '0', role: 'slider', 'aria-label': `${p.name} size`, 'aria-valuetext': fmt(p.size), 'data-id': `h${p.i}` });
        hg.append(s('rect', { x: hx - 6, y: top + 8, width: 12, height: bh - 16, class: 'hit' }));
        hg.append(s('line', { x1: hx, x2: hx, y1: top + 14, y2: top + bh - 14, class: 'grip' }));
        hg.append(s('rect', { x: hx - 7, y: top + 4, width: 14, height: bh - 8, rx: 3, class: 'ring' }));
        hg.addEventListener('pointerdown', (e) => {
          e.preventDefault(); hg.setPointerCapture?.(e.pointerId);
          const x0 = e.clientX, s0 = p.size, k = it.pxPerM * (strip.getBoundingClientRect().width / W);
          let lastRows = null;
          const move = (ev) => { lastRows = resize(p.i, s0 + (ev.clientX - x0) / k, false); ctx.set('parts', lastRows); };
          drag(move);
        });
        hg.addEventListener('keydown', (e) => {
          const stepM = alignM() * (e.shiftKey ? 8 : 1);
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); resize(p.i, p.size + stepM); }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); resize(p.i, p.size - stepM); }
        });
        track(hg, `h${p.i}`);
        strip.append(hg);
      }
    }
    // end of storage / overflow
    const endX = X0 + L.reduce((a, it) => a + it.w, 0);
    strip.append(s('text', { x: endX, y: top + bh + 13, 'text-anchor': 'end', class: `small ${d.used > d.total ? 'bad' : 'soft'}` }, d.used > d.total ? `over by ${fmt(d.used - d.total)}` : fmt(d.total)));
    // the U-Boot environment inside the raw area
    if (d.env) {
      const raw = L.find((it) => it.p && it.p.role === 'raw' && d.env.off >= it.p.start && d.env.off < it.p.start + it.p.size + 1e-9);
      if (raw) {
        const ex = X0 + raw.x + raw.w * ((d.env.off - raw.p.start) / Math.max(raw.p.size, 1e-9));
        strip.append(s('line', { x1: ex, x2: ex, y1: top - 10, y2: top + bh, class: 'env-mk' }));
        strip.append(s('text', { x: ex, y: top - 13, 'text-anchor': 'middle', class: 'small env-t' }, `env${d.env.redundant ? ' ×2' : ''}`));
      }
    }
    // image marker on slot A
    const aIt = L.find((it) => it.p && it.p.role === 'rootfs' && it.p.slot === 'A');
    if (aIt && d.image) {
      const ix = X0 + aIt.x + Math.min(1.08, d.image / aIt.p.size) * aIt.w;
      const ig = s('g', { class: 'imk', tabindex: '0', role: 'slider', 'aria-label': 'Rootfs image size', 'aria-valuetext': fmt(d.image), 'data-id': 'img' });
      ig.append(s('path', { d: `M${ix - 7},${top + bh + 18} L${ix + 7},${top + bh + 18} L${ix},${top + bh + 4} z`, class: 'imk-p' }));
      ig.append(s('rect', { x: ix - 10, y: top + bh + 2, width: 20, height: 20, class: 'hit' }));
      ig.append(s('text', { x: ix, y: top + bh + 32, 'text-anchor': 'middle', class: 'small imk-t' }, fmt(d.image)));
      ig.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const x0 = e.clientX, m0 = d.image, k = aIt.pxPerM * (strip.getBoundingClientRect().width / W);
        drag((ev) => ctx.set('imageSize', `${Math.max(1, Math.round((m0 + (ev.clientX - x0) / k) / 10) * 10)}M`));
      });
      ig.addEventListener('keydown', (e) => {
        const d10 = e.shiftKey ? 100 : 10;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); ctx.set('imageSize', `${Math.round(d.image + d10)}M`); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); ctx.set('imageSize', `${Math.max(1, Math.round(d.image - d10))}M`); }
      });
      track(ig, 'img');
      strip.append(ig);
    }
    if (had) strip.querySelector(`[data-id="${had}"]`)?.focus({ preventScroll: true });
    const slot = d.slot;
    rc(stripHead, h('h2', {}, 'Storage'),
      h('span', { class: 'sub' }, h('b', { class: 'mono' }, ctx.raw.device || ''), ` · ${fmt(d.used)} of ${fmt(d.total)} · slots `, h('b', {}, slot ? fmt(slot) : '–'),
        d.image ? [' · image ', h('b', { class: d.image > slot ? 'c-bad' : d.image * (1 + d.growth / 100) > slot ? 'c-warn' : '' }, fmt(d.image)), slot ? ` (${Math.round(d.image / slot * 100)}% of a slot)` : ''] : null));
  }

  const track = (el, id) => {
    const mark = () => { focusId = id; };
    el.addEventListener('focus', mark);
    el.addEventListener('pointerdown', mark, true);
  };
  const drag = (move) => {
    dragging = true;
    const up = () => { dragging = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  function drawInspector(d) {
    const r = rows();
    const i = st.sel;
    const addBtn = h('button', { type: 'button', class: 'k-btn', onclick: () => {
      const rr = rows();
      const at = rr.findIndex((x) => x.role === 'data');
      rr.splice(at < 0 ? rr.length : at, 0, { name: `part${rr.length + 1}`, role: 'other', slot: '-', size: '64M', fs: 'ext4' });
      st.sel = at < 0 ? rr.length - 1 : at;
      setRows(rr);
    } }, '+ Partition');
    if (i == null || !r[i]) { rc(insp, h('span', { class: 'hint' }, 'Click a partition to edit its name, role, slot, size or file system.'), h('span', { class: 'push' }, addBtn)); return; }
    const p = r[i];
    const upd = (k, v) => { const rr = rows(); rr[i][k] = v; setRows(rr); };
    const sel = (k, opts, label) => h('label', {}, label, h('select', { onchange: (e) => upd(k, e.target.value) }, opts.map((o) => h('option', { value: o, selected: String(p[k]) === o }, o))));
    const inp = (k, label, cls) => {
      const el = h('input', { type: 'text', spellcheck: 'false', class: `mono ${cls || ''}`, oninput: (e) => { clearTimeout(typing); const v = e.target.value; typing = setTimeout(() => upd(k, v), 300); } });
      el.value = p[k] ?? '';
      return h('label', {}, label, el);
    };
    const dp = d.parts.find((x) => x.i === i);
    rc(insp,
      h('b', { class: 'mono' }, dp ? dp.path : ''),
      inp('name', 'Name'), sel('role', ['raw', 'boot', 'rootfs', 'data', 'other'], 'Role'), sel('slot', ['-', 'A', 'B'], 'Slot'), inp('size', 'Size', 'short'),
      sel('fs', ['raw', 'ext4', 'vfat', 'squashfs', 'erofs', 'f2fs', 'ubifs'], 'FS'),
      h('span', { class: 'push' },
        h('button', { type: 'button', class: 'k-btn', 'aria-label': 'Move earlier', disabled: i === 0, onclick: () => { const rr = rows(); [rr[i - 1], rr[i]] = [rr[i], rr[i - 1]]; st.sel = i - 1; setRows(rr); } }, '←'),
        h('button', { type: 'button', class: 'k-btn', 'aria-label': 'Move later', disabled: i === r.length - 1, onclick: () => { const rr = rows(); [rr[i + 1], rr[i]] = [rr[i], rr[i + 1]]; st.sel = i + 1; setRows(rr); } }, '→'),
        h('button', { type: 'button', class: 'k-btn', onclick: () => { const rr = rows(); rr.splice(i, 1); st.sel = null; setRows(rr); } }, 'Remove'),
        addBtn));
  }

  // ---------- the sequence ----------
  function goStep(k) {
    const n = res?.draw?.steps.length || 0;
    st.step = Math.max(0, Math.min(n - 1, k));
    drawStrip(res.draw); drawSeq(res.draw, true);
  }
  function drawSeq(d, keepFocus) {
    const had = keepFocus || seq.contains(document.activeElement);
    const vars = [...new Set(d.steps.flatMap((x) => Object.keys(x.env)))];
    rc(seq);
    seq.style.setProperty('--nvars', vars.length);
    seq.append(h('div', { class: 'row hd', role: 'row' }, h('span', { class: 'n' }, '#'),
      ...LANES.map(([k, t]) => h('span', { class: `lane-h l-${k}` }, t)), h('span', { class: 'lane-h all' }, 'Step (client · bootloader · userspace)'),
      ...vars.map((v) => h('span', { class: 'var mono', title: v }, v.replace(/^bootstate\./, '')))));
    d.steps.forEach((x, i) => {
      const cur = i === st.step;
      const cells = LANES.map(([k]) => h('span', { class: `lane l-${k}` }, x.lane === k ? h('span', { class: `card k-${x.kind}` }, h('b', {}, x.title), h('span', { class: 'dt' }, x.detail)) : null));
      const row = h('div', { class: `row${cur ? ' cur' : ''} k-${x.kind}${x.lane === 'power' ? ' power' : ''}`, role: 'row', tabindex: cur ? '0' : '-1', 'data-i': i, 'aria-selected': String(cur),
        onclick: () => goStep(i) },
      h('span', { class: 'n mono' }, String(i + 1)),
      x.lane === 'power' ? h('span', { class: 'pw' }, h('b', {}, x.title), h('span', { class: 'dt' }, x.detail)) : cells,
      ...vars.map((v) => h('span', { class: `val mono${x.changed.includes(v) ? ' chg' : ''}` }, x.env[v] == null ? '' : String(x.env[v]))));
      seq.append(row);
    });
    const cur = seq.querySelector('.row.cur');
    if (cur) {
      if (had) cur.focus({ preventScroll: true });
      const box = seq.parentNode;
      const top = cur.offsetTop - box.offsetTop, bot = top + cur.offsetHeight;
      if (top < box.scrollTop + 26 || bot > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - 60);
    }
    stepPos.textContent = `step ${st.step + 1} / ${d.steps.length}`;
    prev.disabled = st.step <= 0; next.disabled = st.step >= d.steps.length - 1;
    limitOut.textContent = String(ctx.raw.bootlimit ?? '');
    const last = d.steps[d.steps.length - 1];
    rc(seqHead, h('h2', {}, 'Update, step by step'),
      h('span', { class: 'sub' }, `${d.steps.length} steps · ends `, h('b', { class: last?.kind === 'rollback' ? 'c-warn' : 'c-ok' }, last?.run ? `running ${last.run}` : '–'),
        d.limit ? ` · rollback after ${d.limit} failed boot${d.limit === 1 ? '' : 's'}` : h('b', { class: 'c-bad' }, ' · no boot limit')));
  }
  seq.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); goStep(st.step + 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); goStep(st.step - 1); }
    if (e.key === 'Home') { e.preventDefault(); goStep(0); }
    if (e.key === 'End') { e.preventDefault(); goStep(1e9); }
  });

  function drawFindings(d) {
    const c = { error: 0, warn: 0, note: 0 };
    for (const f of d.findings) c[f.sev]++;
    rc(findBox, h('div', { class: 'ota-head' }, h('h2', {}, 'Checks'),
      h('span', { class: 'sub' }, h('b', { class: 'c-bad' }, `${c.error} error${c.error === 1 ? '' : 's'}`), ' · ', h('b', { class: 'c-warn' }, `${c.warn} warning${c.warn === 1 ? '' : 's'}`), ` · ${c.note} note${c.note === 1 ? '' : 's'}`)),
    d.findings.length ? h('ul', { class: 'flist' }, d.findings.map((f) => h('li', { class: f.sev },
      h('span', { class: 'sv' }, f.sev === 'warn' ? 'warning' : f.sev), h('span', {}, f.msg),
      /^p\d+$/.test(f.where) ? h('button', { type: 'button', class: 'k-btn go', onclick: () => { st.sel = Number(f.where.slice(1)); drawStrip(d); drawInspector(d); } }, 'show') : null)))
      : h('div', { class: 'ok' }, 'The plan holds: slots fit the image with room to grow, a data partition, a boot limit and a safe environment.'));
  }

  function sync() {
    const r = ctx.raw;
    for (const segEl of [fwSeg, blSeg, scSeg]) for (const b of segEl.children) b.setAttribute('aria-pressed', String(b.dataset.v === r[segEl.dataset.key]));
    for (const [k, el] of Object.entries(fields)) if (document.activeElement !== el) el.value = r[k] ?? '';
    lockBox.checked = !!st.lock;
    envBox.checked = !!r.envRedundant;
    wrap.classList.toggle('no-uboot', r.bootloader !== 'uboot');
  }

  let firstTab = false;
  try { firstTab = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`) == null; } catch { /* ignore */ }
  ctx.onResult((r) => {
    res = r;
    sync();
    const d = r.draw;
    if (!d) return;
    if (lastScenario !== `${d.scenario}|${d.fw}|${d.bl}|${d.limit}`) {
      // a new scenario starts at the step where it gets interesting: the first boot of B
      const k = d.steps.findIndex((x) => x.lane === 'boot');
      st.step = lastScenario == null ? Math.max(0, k) : Math.min(st.step, d.steps.length - 1);
      lastScenario = `${d.scenario}|${d.fw}|${d.bl}|${d.limit}`;
    }
    st.step = Math.min(st.step, d.steps.length - 1);
    if (st.sel != null && !d.parts.some((p) => p.i === st.sel)) st.sel = null;
    drawStrip(d); drawInspector(d); drawSeq(d, false); drawFindings(d);
    if (firstTab) { firstTab = false; ctx.outputs.querySelector('.k-tab')?.click(); }
  });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (res?.draw) drawStrip(res.draw); }, 120); });
}
