// The contract as the project's record: loaded from /api/tools/data/interface-contract
// when the tool opens (into the form, with api.set), saved with "Save to project".
// Agents read and write the same record with MCP tool_data. If the record changed
// since it was loaded, the first Save press says so instead of overwriting.

const KEYS = ['board', 'mcu_rail', 'five_tolerant', 'rails', 'gpio', 'i2c'];
const S = { draw: () => {}, tried: false, busy: false, project: null, updated: null, saved: null, msg: '', tone: '', confirm: false };

const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};

const pick = (raw) => Object.fromEntries(KEYS.map((k) => [k, raw[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The API's times may come without a zone (stored as UTC): read them as UTC.
const ms = (iso) => (iso ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`) : NaN);
const when = (iso) => { if (!iso) return 'never'; const t = ms(iso); return Number.isFinite(t) ? new Date(t).toLocaleString() : String(iso); };
const sameTime = (a, b) => (!a && !b) || Math.abs(ms(a) - ms(b)) < 2;
const url = (project) => `/api/tools/data/interface-contract?project=${encodeURIComponent(project || 'default')}`;

async function load(api, redraw, quiet) {
  const project = String(api.raw.project || 'default').trim() || 'default';
  S.busy = true; S.msg = `Loading the ${project} record…`; S.tone = ''; redraw();
  try {
    const r = await fetch(url(project));
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const body = await r.json();
    S.project = project; S.updated = body.updated || null; S.confirm = false;
    const data = body.data || {};
    if (!Object.keys(data).length) {
      S.saved = null;
      S.msg = `No saved contract for project "${project}" yet: the tables below are local. Save to project to share them.`; S.tone = 'warn';
    } else {
      S.saved = pick({ ...pick(api.raw), ...data });
      S.msg = `Loaded the "${project}" record, saved ${when(S.updated)}.`; S.tone = 'ok';
      S.busy = false;
      for (const k of KEYS) if (k in data && !same(data[k], api.raw[k])) api.set(k, data[k]);
      return;
    }
  } catch (e) {
    S.msg = `Could not load the record: ${e.message || e}`; S.tone = 'bad';
    if (quiet) S.msg += ' (working locally).';
  } finally { S.busy = false; redraw(); }
}

async function save(api, redraw) {
  const project = String(api.raw.project || 'default').trim() || 'default';
  S.busy = true; S.msg = 'Saving…'; S.tone = ''; redraw();
  try {
    if (!S.confirm) {
      // Someone (another room, an agent) may have saved since we loaded.
      const cur = await (await fetch(url(project))).json();
      const theirs = cur.data || {};
      const changed = Object.keys(theirs).length && !sameTime(cur.updated, project === S.project ? S.updated : null) && !same(pick({ ...pick(api.raw), ...theirs }), pick(api.raw));
      if (changed) {
        S.confirm = true; S.busy = false;
        S.msg = `The "${project}" record was changed ${when(cur.updated)} by someone else. Press Save again to overwrite it, or Reload to take theirs.`; S.tone = 'warn';
        redraw(); return;
      }
    }
    const data = pick(api.raw);
    const r = await fetch(url(project), { method: 'PUT', headers: { 'Content-Type': 'application/json','X-Redline-CSRF':'1' }, body: JSON.stringify({ data }) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const body = await r.json();
    S.project = project; S.updated = body.updated || new Date().toISOString(); S.saved = structuredClone(data); S.confirm = false;
    S.msg = `Saved to project "${project}" at ${when(S.updated)}.`; S.tone = 'ok';
  } catch (e) {
    S.msg = `Could not save: ${e.message || e}`; S.tone = 'bad';
  } finally { S.busy = false; redraw(); }
}

export function view(el, result, input, api) {
  const served = /^https?:/.test(location.protocol);
  const draw = () => {
    const project = String(api.raw.project || 'default').trim() || 'default';
    const dirty = S.saved ? !same(pick(api.raw), S.saved) : true;
    const other = S.project && S.project !== project;
    el.replaceChildren($('div', { class: 'k-block' },
      $('div', { class: 'k-title' }, 'Project record'),
      !served
        ? $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app to load and save the contract as the project\'s record. Here the tables are only local to this browser.')
        : $('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
          $('button', { class: 'k-btn k-primary', disabled: S.busy, onclick: () => save(api, () => S.draw()) }, S.confirm ? 'Save anyway' : 'Save to project'),
          $('button', { class: 'k-btn', disabled: S.busy, onclick: () => load(api, () => S.draw()) }, other ? `Load "${project}"` : 'Reload'),
          $('span', { style: `font-size:12px;color:var(${S.tone === 'ok' ? '--ok' : S.tone === 'warn' ? '--warn' : S.tone === 'bad' ? '--danger' : '--ink-soft'})`, role: 'status' }, S.msg || ''),
          $('span', { style: 'font-size:11px;color:var(--ink-soft);flex-basis:100%' },
            `Project "${S.project || project}" · last saved ${when(S.updated)}${S.saved && dirty && !S.busy ? ' · unsaved changes' : ''}${other ? ` · the form now names "${project}"` : ''}`))));
  };
  S.draw = () => { if (el.isConnected) draw(); };
  if (served && !S.tried) { S.tried = true; load(api, () => S.draw(), true); return; }
  draw();
}

// ---------------------------------------------------------------------------
// The page ("layout": "custom"): the contract drawn as the board sees it.
//   Wiring    - the MCU as a block with its used pins down its edge; each
//               signal is a wire out to the voltage domain its far end lives
//               in (one band per rail, the MCU's own band marked). On the
//               wire: the direction glyph (click to change), the signal name,
//               the pull resistor (click: none, up, down). Drag the wire's end
//               into another band, or focus the row and press left/right, to
//               put that signal on another rail. Level problems turn the wire
//               red where it crosses into the other domain.
//   I2C map   - the 7-bit address space as i2cdetect prints it, 8 x 16, the
//               reserved ranges hatched; each device sits in its cell. Drag a
//               device to another cell (or arrow keys) to change its address;
//               two in one cell is a conflict. Under it the bus speed ruler:
//               every device's maximum and the bus speed they leave.
//   Inspector - the selected signal, device or rail as fields.
// Levels, 7-bit addresses, conflicts and bus speeds all come from run()'s
// result.contract; the page draws them.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const DIRS = ['in', 'out', 'io', 'od', 'analog', 'pwm'];
const PULLS = ['none', 'up', 'down'];
const DIR_WORD = { in: 'input', out: 'output', io: 'bidirectional', od: 'open-drain', analog: 'analog input', pwm: 'PWM output' };
const hx = (v) => '0x' + v.toString(16).toUpperCase().padStart(2, '0');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function page(root, k) {
  const st = { sel: null, bus: null, drag: null };
  const C = () => k.result?.contract || { rails: [], gpio: [], i2c: [], buses: [] };
  const rowsOf = (key) => structuredClone(k.raw[key] || []);
  const setCell = (key, row, field, value) => { const r = rowsOf(key); if (!r[row]) return; r[row][field] = value; k.set(key, r); };
  const isSel = (kind, row) => st.sel && st.sel.kind === kind && st.sel.row === row;
  const select = (kind, row) => { st.sel = kind == null ? null : { kind, row }; render(); };

  // ---------- skeleton ----------
  const boardIn = $('input', { type: 'text', class: 'ic-board', 'aria-label': 'Board name', spellcheck: 'false' });
  boardIn.addEventListener('change', () => k.set('board', boardIn.value));
  const railSel = $('select', { 'aria-label': 'MCU I/O rail' });
  railSel.addEventListener('change', () => k.set('mcu_rail', railSel.value));
  const tolIn = $('input', { type: 'checkbox' });
  tolIn.addEventListener('change', () => k.set('five_tolerant', tolIn.checked));
  const summary = $('div', { class: 'ic-summary', 'aria-live': 'polite' });

  const wire = sv('svg', { class: 'ic-wire', role: 'group', 'aria-label': 'GPIO wiring: MCU pins to voltage domains' });
  const wirePanel = $('section', { class: 'ic-panel ic-wirep' },
    $('div', { class: 'ic-head' }, $('h2', {}, 'Wiring'),
      $('label', { class: 'ic-f' }, $('span', {}, 'MCU I/O'), railSel),
      $('label', { class: 'ic-f ic-chk' }, tolIn, $('span', {}, '5 V tolerant inputs')),
      $('span', { class: 'ic-grow' }),
      $('button', { class: 'k-btn', type: 'button', onclick: () => addRow('gpio') }, '+ Signal'),
      $('button', { class: 'k-btn', type: 'button', onclick: () => addRow('rails') }, '+ Rail')),
    $('div', { class: 'ic-stage' }, wire),
    $('div', { class: 'ic-legend' }, 'Click a direction glyph or a resistor to change it · drag a wire end into another rail band (or focus a row: ← → rail, D direction, P pull) · click a band head to edit the rail'));

  const busTabs = $('div', { class: 'ic-seg', role: 'tablist', 'aria-label': 'I2C bus' });
  const map = sv('svg', { class: 'ic-map', role: 'group', 'aria-label': 'I2C 7-bit address map' });
  const ruler = sv('svg', { class: 'ic-ruler', 'aria-label': 'Bus speed' });
  const mapPanel = $('section', { class: 'ic-panel ic-mapp' },
    $('div', { class: 'ic-head' }, $('h2', {}, 'I2C addresses'), busTabs, $('span', { class: 'ic-grow' }),
      $('button', { class: 'k-btn', type: 'button', onclick: () => addRow('i2c') }, '+ Device')),
    $('div', { class: 'ic-mapwrap' }, map), ruler);

  const insp = $('section', { class: 'ic-panel ic-insp' });
  const issuesBox = $('section', { class: 'ic-panel ic-issues' });
  const record = $('div', { class: 'ic-record' });
  const all = $('details', { class: 'ic-panel ic-all' }, $('summary', {}, 'All tables (rails, GPIO, I2C) and the project name'), k.form);

  root.append($('div', { class: 'ic' },
    $('div', { class: 'ic-top' }, $('label', { class: 'ic-f' }, $('span', {}, 'Board'), boardIn), summary),
    $('div', { class: 'ic-work' }, wirePanel, $('div', { class: 'ic-side' }, mapPanel, insp, issuesBox)),
    $('div', { class: 'ic-bottom' }, $('div', { class: 'ic-col' }, record, all), k.outputs)));

  function addRow(key) {
    const r = rowsOf(key);
    if (key === 'gpio') r.push({ signal: `SIGNAL_${r.length + 1}`, pin: '', dir: 'in', rail: '', pull: 'none', notes: '' });
    if (key === 'i2c') {
      const used = new Set(C().i2c.map((d) => d.addr));
      let a = 0x20; while (used.has(a) && a < 0x77) a++;
      r.push({ bus: st.bus ?? (C().buses[0]?.bus || '0'), addr: hx(a), device: 'NEW', khz: '400', notes: '' });
    }
    if (key === 'rails') r.push({ name: `RAIL${r.length + 1}`, volts: '1.8', source: '', notes: '' });
    st.sel = { kind: key === 'rails' ? 'rail' : key, row: r.length - 1 };
    k.set(key, r);
  }

  // ---------- wiring ----------
  // Geometry: wide, or compact when the panel is narrow (a phone) so the text stays legible.
  const TOP = 78, RH = 44, ISS = 30;
  let W, BODY_X, PIN_X, BAND_X, BAND_R, PULL_X, DIR_DX, NAME_DX, WRAP, compact;
  const geom = () => {
    compact = (wire.parentElement?.clientWidth || 800) < 620;
    if (compact) { W = 460; BODY_X = 4; PIN_X = 70; BAND_X = 300; PULL_X = 274; DIR_DX = 24; NAME_DX = 46; WRAP = 34; }
    else { W = 800; BODY_X = 18; PIN_X = 178; BAND_X = 500; PULL_X = 440; DIR_DX = 34; NAME_DX = 58; WRAP = 68; }
    BAND_R = W - 4;
  };
  // An issue under its row, wrapped to two lines that end before the next rail band.
  const wrap2 = (t, n) => {
    if (t.length <= n) return [t];
    let i = t.lastIndexOf(' ', n); if (i < n * 0.6) i = n;
    return [t.slice(0, i), clip(t.slice(i).trim(), n)];
  };
  function bands(c) {
    const list = c.rails.slice().sort((a, b) => (a.v ?? 99) - (b.v ?? 99));
    const n = Math.max(1, list.length);
    const bw = (BAND_R - BAND_X) / n;
    return list.map((r, i) => ({ ...r, x0: BAND_X + i * bw, x1: BAND_X + (i + 1) * bw, cx: BAND_X + (i + 0.5) * bw }));
  }
  const bandOf = (c, bs, g) => {
    const name = (g.rail || c.mcuRail || '').toUpperCase();
    return bs.find((b) => b.name.toUpperCase() === name) || (g.rail ? null : bs.find((b) => b.mcu)) || null;
  };

  function dirGlyph(dir, x, y) {
    const g = sv('g', { class: 'ic-dirg' });
    g.append(sv('rect', { x: x - 17, y: y - 11, width: 34, height: 22, rx: 4, class: 'ic-dirbox' }));
    const a = (d) => g.append(sv('path', { d, class: 'ic-dirp' }));
    if (dir === 'out') a(`M${x - 9},${y} H${x + 7} M${x + 2},${y - 5} L${x + 8},${y} L${x + 2},${y + 5}`);
    else if (dir === 'in') a(`M${x + 9},${y} H${x - 7} M${x - 2},${y - 5} L${x - 8},${y} L${x - 2},${y + 5}`);
    else if (dir === 'io') a(`M${x - 8},${y} H${x + 8} M${x + 3},${y - 5} L${x + 9},${y} L${x + 3},${y + 5} M${x - 3},${y - 5} L${x - 9},${y} L${x - 3},${y + 5}`);
    else if (dir === 'analog') a(`M${x - 10},${y} C${x - 6},${y - 12} ${x - 2},${y - 12} ${x},${y} S${x + 6},${y + 12} ${x + 10},${y}`);
    else if (dir === 'pwm') a(`M${x - 11},${y + 5} H${x - 7} V${y - 5} H${x - 2} V${y + 5} H${x + 2} V${y - 5} H${x + 7} V${y + 5} H${x + 11}`);
    else if (dir === 'od') { a(`M${x - 9},${y - 6} H${x - 2} V${y + 6} M${x - 2},${y} H${x + 8}`); g.append(sv('text', { x: x + 4, y: y - 3, class: 'ic-odt' }, 'OD')); }
    else g.append(sv('text', { x, y: y + 4, class: 'ic-odt', 'text-anchor': 'middle' }, '?'));
    return g;
  }
  function resistor(pull, x, y, railLabel) {
    const g = sv('g', { class: `ic-pull ic-pull-${pull}` });
    g.append(sv('rect', { x: x - 14, y: y - 26, width: 28, height: 52, class: 'ic-hit' }));
    if (pull === 'none') {
      g.append(sv('circle', { cx: x, cy: y, r: 3, class: 'ic-node0' }), sv('path', { d: `M${x},${y - 5} v-8 M${x - 4},${y - 16} h8`, class: 'ic-ghostr' }));
      return g;
    }
    const s = pull === 'up' ? -1 : 1;
    const z = [];
    for (let i = 0; i < 6; i++) z.push(`L${x + (i % 2 ? -4 : 4)},${y + s * (5 + i * 2.6)}`);
    g.append(sv('circle', { cx: x, cy: y, r: 2.6, class: 'ic-node' }),
      sv('path', { d: `M${x},${y} V${y + s * 4} ${z.join(' ')} L${x},${y + s * 21}`, class: 'ic-res' }));
    if (pull === 'up') g.append(sv('path', { d: `M${x - 6},${y - 21} H${x + 6}`, class: 'ic-res' }), sv('text', { x: x + 8, y: y - 17, class: 'ic-tiny' }, railLabel));
    else g.append(sv('path', { d: `M${x - 6},${y + 21} H${x + 6} M${x - 4},${y + 24} H${x + 4} M${x - 2},${y + 27} H${x + 2}`, class: 'ic-res' }));
    return g;
  }

  function drawWire() {
    geom();
    const c = C();
    const bs = bands(c);
    const rows = c.gpio.slice().sort((a, b) => (a.pin ? 0 : 1) - (b.pin ? 0 : 1) || a.pin.localeCompare(b.pin, 'en', { numeric: true }));
    let y = TOP + 16;
    const ys = rows.map((g) => { const yy = y + RH / 2; y += RH + (g.issues.length ? ISS : 0); return yy; });
    const H = Math.max(y + 22, 250);
    wire.setAttribute('viewBox', `0 0 ${W} ${H}`);
    wire.replaceChildren();

    // Voltage domain bands.
    const gB = sv('g');
    for (const b of bs) {
      const sel = isSel('rail', b.row);
      gB.append(sv('rect', { x: b.x0 + 1, y: 6, width: b.x1 - b.x0 - 2, height: H - 12, rx: 5, class: `ic-band${b.mcu ? ' ic-mcuband' : ''}${sel ? ' ic-bandsel' : ''}` }));
      const head = sv('g', { class: 'ic-bandhead', tabindex: '0', role: 'button', 'aria-label': `Rail ${b.name}, ${b.v ?? '?'} V: edit` });
      head.append(sv('rect', { x: b.x0 + 1, y: 6, width: b.x1 - b.x0 - 2, height: 58, rx: 5, class: 'ic-hit' }),
        sv('text', { x: b.cx, y: 26, class: 'ic-railname', 'text-anchor': 'middle' }, b.name),
        sv('text', { x: b.cx, y: 43, class: `ic-railv${b.v == null ? ' ic-bad' : ''}`, 'text-anchor': 'middle' }, b.v != null ? `${b.v} V` : 'no voltage'),
        sv('text', { x: b.cx, y: 58, class: 'ic-tiny', 'text-anchor': 'middle' }, b.mcu ? 'MCU I/O' : clip(b.source || '', compact ? 7 : 18)));
      head.addEventListener('click', () => select('rail', b.row));
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select('rail', b.row); } });
      gB.append(head);
    }
    if (!bs.length) gB.append(sv('text', { x: (BAND_X + BAND_R) / 2, y: 40, class: 'ic-railv ic-bad', 'text-anchor': 'middle' }, 'No rails: + Rail'));
    wire.append(gB);

    // The MCU.
    const bodyTop = TOP - 4, bodyBot = Math.max(y + 4, bodyTop + 120);
    const mcuB = bs.find((b) => b.mcu);
    wire.append(sv('rect', { x: BODY_X, y: bodyTop, width: PIN_X - BODY_X, height: bodyBot - bodyTop, rx: 6, class: 'ic-body' }),
      sv('text', { x: BODY_X + 10, y: bodyTop - 26, class: 'ic-railname' }, clip(c.board || 'board', 26)),
      sv('text', { x: BODY_X + 10, y: bodyTop - 10, class: `ic-tiny${c.mcuV == null ? ' ic-bad' : ''}` },
        c.mcuV != null ? `MCU I/O ${c.mcuRail} = ${c.mcuV} V${c.fiveTolerant ? ', 5 V tolerant' : ''}` : `MCU rail "${c.mcuRail}" unknown`));
    const cy = (bodyTop + bodyBot) / 2;
    if (!compact) wire.append(sv('text', { x: BODY_X + 26, y: cy, class: 'ic-mcu', 'text-anchor': 'middle', transform: `rotate(-90 ${BODY_X + 26} ${cy})` }, 'MCU'));
    if (mcuB) wire.append(sv('path', { d: `M${PIN_X},${bodyTop + 8} H${mcuB.cx}`, class: 'ic-supply' }), sv('text', { x: PIN_X + 6, y: bodyTop + 4, class: 'ic-tiny' }, `VDD ${mcuB.name}`));

    rows.forEach((g, i) => {
      const yy = ys[i];
      const b = bandOf(c, bs, g);
      const bad = g.issues.length > 0;
      const sel = isSel('gpio', g.row);
      const endX = b ? b.cx : BAND_R - 6;
      const grp = sv('g', { class: `ic-row${sel ? ' ic-sel' : ''}${bad ? ' ic-rowbad' : ''}`, tabindex: '0', role: 'group', 'data-row': g.row,
        'aria-label': `${g.signal || 'unnamed'} on ${g.pin || 'no pin'}, ${DIR_WORD[g.dir] || g.dir}, pull ${g.pull}, ${b ? b.name : 'unknown rail'}${bad ? ', ' + g.issues.length + ' issue' : ''}` });
      grp.append(sv('rect', { x: PIN_X + 8, y: yy - RH / 2 + 2, width: W - PIN_X - 10, height: RH - 4 + (bad ? ISS : 0), rx: 4, class: 'ic-rowbg' }));
      // Pin inside the body.
      grp.append(sv('text', { x: PIN_X - 12, y: yy + 4, class: `ic-pin${g.pin ? '' : ' ic-bad'}`, 'text-anchor': 'end' }, g.pin || 'no pin'),
        sv('rect', { x: PIN_X - 5, y: yy - 5, width: 10, height: 10, class: 'ic-pad' }));
      // The wire: to the domain boundary in the MCU colour, beyond it red when there is a level issue.
      const mx = mcuB ? mcuB.x1 : BAND_X;
      const crosses = b && mcuB && b !== mcuB;
      if (crosses && bad) {
        const bx = endX > mx ? mx : mcuB.x0;
        grp.append(sv('path', { d: `M${PIN_X + 5},${yy} H${bx}`, class: 'ic-w' }), sv('path', { d: `M${bx},${yy} H${endX}`, class: 'ic-w ic-wbad' }),
          sv('path', { d: `M${bx - 6},${yy - 8} L${bx + 6},${yy + 8} M${bx + 6},${yy - 8} L${bx - 6},${yy + 8}`, class: 'ic-cross' }));
      } else grp.append(sv('path', { d: `M${PIN_X + 5},${yy} H${endX}`, class: `ic-w${bad ? ' ic-wbad' : ''}` }));
      // Direction glyph (click cycles).
      const dg = dirGlyph(g.dir, PIN_X + DIR_DX, yy);
      dg.append(sv('title', {}, `${DIR_WORD[g.dir] || g.dir}: click for the next direction`));
      dg.addEventListener('click', (e) => { e.stopPropagation(); setCell('gpio', g.row, 'dir', DIRS[(DIRS.indexOf(g.dir) + 1) % DIRS.length]); });
      grp.append(dg);
      // Name.
      grp.append(sv('rect', { x: PIN_X + NAME_DX, y: yy - 11, width: Math.max(40, (g.signal || '?').length * 8.2 + 10), height: 22, rx: 3, class: 'ic-namebg' }),
        sv('text', { x: PIN_X + NAME_DX + 5, y: yy + 4.5, class: 'ic-sig' }, g.signal || '(no name)'));
      // Pull resistor (click cycles).
      const pr = resistor(g.pull, PULL_X, yy, mcuB ? mcuB.name : '');
      pr.append(sv('title', {}, `pull: ${g.pull} - click to change`));
      pr.addEventListener('click', (e) => { e.stopPropagation(); setCell('gpio', g.row, 'pull', PULLS[(PULLS.indexOf(g.pull) + 1) % PULLS.length]); });
      grp.append(pr);
      // Landing dots in the other bands, then the end handle.
      for (const o of bs) if (o !== b) {
        const d = sv('circle', { cx: o.cx, cy: yy, r: 4, class: 'ic-land' });
        d.append(sv('title', {}, `put ${g.signal} on ${o.name}`));
        d.addEventListener('click', (e) => { e.stopPropagation(); moveRail(g, o); });
        grp.append(d);
      }
      const end = sv('g', { class: 'ic-end' });
      end.append(sv('circle', { cx: endX, cy: yy, r: 12, class: 'ic-hit' }), sv('circle', { cx: endX, cy: yy, r: 6.5, class: `ic-endc${bad ? ' ic-bad' : ''}` }));
      if (g.v != null) end.append(sv('text', { x: endX, y: yy - 11, class: 'ic-tiny', 'text-anchor': 'middle' }, `${g.v} V`));
      else end.append(sv('text', { x: endX, y: yy - 11, class: 'ic-tiny ic-bad', 'text-anchor': 'middle' }, `"${g.rail}"?`));
      end.addEventListener('pointerdown', (e) => startDrag(e, g, bs, end));
      grp.append(end);
      if (bad) {
        const lines = wrap2(`! ${g.issues[0]}${g.issues.length > 1 ? `  (+${g.issues.length - 1} more)` : ''}`, WRAP);
        const t = sv('text', { x: PIN_X + NAME_DX, y: yy + RH / 2 + 4, class: 'ic-iss' });
        lines.forEach((l, j) => t.append(sv('tspan', { x: PIN_X + NAME_DX, dy: j ? 13 : 0 }, l)));
        t.append(sv('title', {}, g.issues.join('\n')));
        grp.append(t);
      }
      grp.addEventListener('click', () => select('gpio', g.row));
      grp.addEventListener('keydown', (e) => {
        if (e.target !== grp) return;
        const bi = b ? bs.indexOf(b) : -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const o = bs[clampN(bi + (e.key === 'ArrowRight' ? 1 : -1), 0, bs.length - 1)]; if (o && o !== b) moveRail(g, o, true); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const all = [...wire.querySelectorAll('.ic-row')]; all[all.indexOf(grp) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
        else if (e.key === 'd' || e.key === 'D') { st.refocus = g.row; setCell('gpio', g.row, 'dir', DIRS[(DIRS.indexOf(g.dir) + 1) % DIRS.length]); }
        else if (e.key === 'p' || e.key === 'P') { st.refocus = g.row; setCell('gpio', g.row, 'pull', PULLS[(PULLS.indexOf(g.pull) + 1) % PULLS.length]); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.refocus = g.row; select('gpio', g.row); }
      });
      wire.append(grp);
    });
    if (!rows.length) wire.append(sv('text', { x: PIN_X + 20, y: TOP + 40, class: 'ic-tiny' }, 'No GPIO yet: + Signal'));
  }
  function moveRail(g, band, refocus) {
    const c = C();
    // Back on the MCU's own rail: leave Rail empty (= MCU rail), as the table's convention says.
    const v = band.mcu && (!g.rail || g.rail.toUpperCase() !== band.name.toUpperCase()) && band.name.toUpperCase() === String(c.mcuRail).toUpperCase() ? '' : band.name;
    if (refocus) st.refocus = g.row;
    st.sel = { kind: 'gpio', row: g.row };
    setCell('gpio', g.row, 'rail', v);
  }
  function startDrag(e, g, bs, end) {
    e.preventDefault(); e.stopPropagation();
    const pt = (ev) => { const p = wire.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; return p.matrixTransform(wire.getScreenCTM().inverse()); };
    try { end.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const circ = end.querySelectorAll('circle');
    const move = (ev) => {
      const x = clampN(pt(ev).x, BAND_X, BAND_R);
      for (const cc of circ) cc.setAttribute('cx', x);
      st.drag = bs.find((b) => x >= b.x0 && x < b.x1) || bs[bs.length - 1];
    };
    const up = () => {
      end.removeEventListener('pointermove', move); end.removeEventListener('pointerup', up); end.removeEventListener('pointercancel', up);
      const b = st.drag; st.drag = null;
      if (b) moveRail(g, b); else render();
    };
    end.addEventListener('pointermove', move); end.addEventListener('pointerup', up); end.addEventListener('pointercancel', up);
  }

  // ---------- I2C map ----------
  const CW = 42, CH = 40, LX = 30, LY = 20;
  let COLS = 16, ROWS = 8;   // i2cdetect's 8 x 16; on a phone 16 x 8 so the cells stay big enough to read
  function drawMap() {
    const c = C();
    const buses = [...new Set([...c.buses.map((b) => b.bus), ...c.i2c.map((d) => d.bus)])];
    if (!buses.length) buses.push('0');
    if (st.bus == null || !buses.includes(st.bus)) st.bus = buses[0];
    busTabs.replaceChildren(...buses.map((b) => {
      const n = c.i2c.filter((d) => d.bus === b).length;
      const bad = c.i2c.some((d) => d.bus === b && d.issues.length);
      return $('button', { type: 'button', role: 'tab', 'aria-selected': String(b === st.bus), class: bad ? 'ic-tabbad' : null, onclick: () => { st.bus = b; render(); } }, `bus ${b}`, $('small', {}, ` ${n}`));
    }));
    COLS = (map.parentElement?.clientWidth || 700) < 520 ? 8 : 16; ROWS = 128 / COLS;
    const W2 = LX + COLS * CW + 2, H2 = LY + ROWS * CH + 2;
    map.setAttribute('viewBox', `0 0 ${W2} ${H2}`);
    map.replaceChildren();
    const defs = sv('defs'); const pat = sv('pattern', { id: 'ic-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('rect', { width: 2, height: 6, class: 'ic-hatchline' })); defs.append(pat); map.append(defs);
    for (let col = 0; col < COLS; col++) map.append(sv('text', { x: LX + col * CW + CW / 2, y: 15, class: 'ic-axis', 'text-anchor': 'middle' }, col.toString(16).toUpperCase()));
    for (let row = 0; row < ROWS; row++) {
      map.append(sv('text', { x: LX - 6, y: LY + row * CH + CH / 2 + 4, class: 'ic-axis', 'text-anchor': 'end' }, (row * COLS).toString(16).toUpperCase().padStart(2, '0')));
      for (let col = 0; col < COLS; col++) {
        const a = row * COLS + col;
        const res = a <= 0x07 || a >= 0x78;
        const cell = sv('rect', { x: LX + col * CW + 1, y: LY + row * CH + 1, width: CW - 2, height: CH - 2, rx: 2, class: `ic-cell${res ? ' ic-res' : ''}`, 'data-a': a });
        cell.append(sv('title', {}, res ? `${hx(a)}: reserved (UM10204 table 4)` : `${hx(a)}: free`));
        map.append(cell);
      }
    }
    const devs = c.i2c.filter((d) => d.bus === st.bus && d.addr != null && d.addr <= 0x7F);
    const byA = new Map();
    for (const d of devs) { if (!byA.has(d.addr)) byA.set(d.addr, []); byA.get(d.addr).push(d); }
    for (const [a, list] of byA) {
      const x = LX + (a % COLS) * CW, y = LY + Math.floor(a / COLS) * CH;
      // A conflict stacks the chips like cards: the top one is labelled, the rest peek out below it.
      list.map((d, j) => [d, j]).reverse().forEach(([d, j]) => {
        const bad = d.issues.length > 0 || list.length > 1;
        const sel = isSel('i2c', d.row);
        const off = list.length > 1 ? j * 4 : 0;
        const g = sv('g', { class: `ic-dev${bad ? ' ic-devbad' : ''}${sel ? ' ic-sel' : ''}`, tabindex: '0', role: 'button', 'data-row': d.row,
          'aria-label': `${d.device} at ${hx(a)}${list.length > 1 ? ', conflict' : ''}. Arrow keys move it.` });
        g.append(sv('rect', { x: x + 3 + off, y: y + 3 + off, width: CW - 6, height: CH - 6, rx: 3, class: 'ic-devr' }));
        if (j === 0) g.append(sv('text', { x: x + CW / 2 + off, y: y + 18 + off, class: 'ic-devh', 'text-anchor': 'middle' }, hx(a).slice(2)),
          sv('text', { x: x + CW / 2 + off, y: y + 31 + off, class: 'ic-devn', 'text-anchor': 'middle' }, clip(d.device || '?', 7)));
        if (d.eight && j === 0) g.append(sv('text', { x: x + CW - 3, y: y + 10, class: 'ic-devn ic-eight', 'text-anchor': 'end' }, '8b'));
        g.append(sv('title', {}, `${d.device} ${hx(a)}${d.eight ? ` (given as the 8-bit ${d.raw})` : ''}${d.khz ? `, max ${d.khz} kHz` : ''}${d.issues.length ? '\n' + d.issues.join('\n') : ''}`));
        g.addEventListener('pointerdown', (e) => devDrag(e, d, g));
        g.addEventListener('keydown', (e) => {
          const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS }[e.key];
          if (step) { e.preventDefault(); st.refocusDev = d.row; st.sel = { kind: 'i2c', row: d.row }; setCell('i2c', d.row, 'addr', hx(clampN(a + step, 0, 0x7F))); }
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.refocusDev = d.row; select('i2c', d.row); }
        });
        map.append(g);
      });
      if (list.length > 1) map.append(sv('text', { x: x + CW - 2, y: y + CH - 2, class: 'ic-cnt', 'text-anchor': 'end' }, `×${list.length}`));
    }
    const lost = c.i2c.filter((d) => d.bus === st.bus && d.addr == null);
    if (lost.length) map.append(sv('text', { x: LX, y: H2 - 2, class: 'ic-iss' }, `Not on the map (no readable address): ${lost.map((d) => d.device || '?').join(', ')}`));
    drawRuler(c);
  }
  function devDrag(e, d, g) {
    e.preventDefault();
    const pt = (ev) => { const p = map.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; return p.matrixTransform(map.getScreenCTM().inverse()); };
    const p0 = pt(e);
    try { g.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    let moved = false, target = null;
    const move = (ev) => {
      const p = pt(ev); const dx = p.x - p0.x, dy = p.y - p0.y;
      if (Math.hypot(dx, dy) > 4) moved = true;
      if (!moved) return;
      g.setAttribute('transform', `translate(${dx},${dy})`);
      const col = clampN(Math.floor((p.x - LX) / CW), 0, COLS - 1), row = clampN(Math.floor((p.y - LY) / CH), 0, ROWS - 1);
      target = row * COLS + col;
      for (const c of map.querySelectorAll('.ic-cell')) c.classList.toggle('ic-drop', +c.dataset.a === target);
    };
    const up = () => {
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      st.sel = { kind: 'i2c', row: d.row };
      if (moved && target != null && target !== d.addr) setCell('i2c', d.row, 'addr', hx(target));
      else render();
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  }
  function drawRuler(c) {
    const W3 = LX + COLS * CW + 2, H3 = 112;
    ruler.setAttribute('viewBox', `0 0 ${W3} ${H3}`);
    ruler.replaceChildren();
    const lo = Math.log10(80), hi = Math.log10(4000);
    const X = (k) => LX + ((Math.log10(k) - lo) / (hi - lo)) * (W3 - LX - 12);
    const bus = c.buses.find((b) => b.bus === st.bus);
    const devs = c.i2c.filter((d) => d.bus === st.bus && d.khz > 0);
    const y0 = 88;
    if (bus?.khz) ruler.append(sv('rect', { x: X(bus.khz), y: y0 - 12, width: X(4000) - X(bus.khz), height: 24, class: 'ic-over' }));
    ruler.append(sv('path', { d: `M${X(80)},${y0} H${X(4000)}`, class: 'ic-axisline' }));
    for (const [kk, n] of [[100, 'Sm 100k'], [400, 'Fm 400k'], [1000, 'Fm+ 1M'], [3400, 'Hs 3.4M']]) {
      ruler.append(sv('path', { d: `M${X(kk)},${y0 - 4} V${y0 + 4}`, class: 'ic-axisline' }), sv('text', { x: X(kk), y: y0 + 16, class: 'ic-axis', 'text-anchor': 'middle' }, n));
    }
    // Labels stack upward on the first level where they do not overlap another.
    const levels = [];
    for (const d of devs.slice().sort((a, b) => a.khz - b.khz)) {
      const x = X(d.khz);
      const lim = bus?.limitedBy.includes(d.device);
      const label = `${d.device} ${d.khz >= 1000 ? d.khz / 1000 + 'M' : d.khz + 'k'}`;
      const w = label.length * 6.4 + 6;
      const end = x > W3 - w - 4;
      const span = end ? [x - w, x] : [x, x + w];
      let n = 0;
      while (n < 2 && (levels[n] || []).some(([a, b]) => span[0] < b && span[1] > a)) n++;
      (levels[n] ||= []).push(span);
      ruler.append(sv('path', { d: `M${x},${y0 - 3} V${y0 - 16 - n * 14}`, class: `ic-tick${lim ? ' ic-lim' : ''}` }),
        sv('text', { x: end ? x - 4 : x + 4, y: y0 - 16 - n * 14 + 4, class: `ic-tiny${lim ? ' ic-limt' : ''}`, 'text-anchor': end ? 'end' : 'start' }, label));
    }
    const cap = sv('text', { x: LX, y: 14, class: 'ic-cap' });
    if (bus?.khz) {
      cap.append(sv('tspan', { x: LX }, `Bus ${st.bus}: ${bus.khz} kHz${bus.limitedBy.length ? `, limited by ${bus.limitedBy.join(', ')}` : ''}`));
      cap.append(sv('tspan', { x: LX, dy: 14, class: 'ic-tiny' }, 'shaded: faster than the bus allows'));
    } else cap.textContent = 'No speeds given for this bus';
    ruler.append(cap);
  }

  // ---------- inspector ----------
  function fld(label, value, onCommit, opts = {}) {
    let c;
    if (opts.options) { c = $('select', {}, opts.options.map((o) => $('option', { value: o, selected: o === value }, o))); }
    else { c = $('input', { type: 'text', spellcheck: 'false' }); c.value = value ?? ''; }
    c.addEventListener('change', () => onCommit(c.value));
    if (!opts.options) c.addEventListener('keydown', (e) => { if (e.key === 'Enter') c.dispatchEvent(new Event('change')); });
    return $('label', { class: `ic-f2${opts.wide ? ' ic-wide' : ''}` }, $('span', {}, label), c);
  }
  function drawInsp() {
    const s = st.sel;
    const c = C();
    const del = (key) => $('button', { class: 'k-btn ic-del', type: 'button', onclick: () => { const r = rowsOf(key); r.splice(s.row, 1); st.sel = null; k.set(key, r); } }, 'Delete');
    const issues = (list) => list.map((t) => $('div', { class: 'ic-issline' }, t));
    if (!s) {
      insp.replaceChildren($('div', { class: 'ic-head' }, $('h2', {}, 'Inspector')),
        $('div', { class: 'ic-empty' }, 'Click a signal, an I2C device or a rail band to edit it here.'));
      return;
    }
    const raw = (rowsOf(s.kind === 'rail' ? 'rails' : s.kind))[s.row];
    if (!raw) { st.sel = null; drawInsp(); return; }
    let body;
    if (s.kind === 'gpio') {
      const g = c.gpio.find((x) => x.row === s.row);
      const set = (f) => (v) => setCell('gpio', s.row, f, v);
      body = [$('div', { class: 'ic-grid' },
        fld('Signal', raw.signal, set('signal')), fld('Pin', raw.pin, set('pin')),
        fld('Direction', raw.dir, set('dir'), { options: DIRS }), fld('Pull', raw.pull || 'none', set('pull'), { options: PULLS }),
        fld('Rail (empty = MCU)', raw.rail, set('rail')), fld('Notes', raw.notes, set('notes'), { wide: true })),
      ...issues(g?.issues || []), $('div', { class: 'ic-row2' }, $('span', { class: 'ic-soft' }, g?.v != null ? `Level ${g.v} V` : 'Level unknown'), $('span', { class: 'ic-grow' }), del('gpio'))];
    } else if (s.kind === 'i2c') {
      const d = c.i2c.find((x) => x.row === s.row);
      const set = (f) => (v) => setCell('i2c', s.row, f, v);
      body = [$('div', { class: 'ic-grid' },
        fld('Device', raw.device, set('device')), fld('Address', raw.addr, set('addr')), fld('Bus', raw.bus, set('bus')),
        fld('Max kHz', raw.khz, set('khz')), fld('Notes', raw.notes, set('notes'), { wide: true })),
      ...issues(d?.issues || []), $('div', { class: 'ic-row2' }, $('span', { class: 'ic-soft' }, d?.addr != null ? `7-bit ${hx(d.addr)} = ${d.addr} · write ${hx(d.addr << 1)} / read ${hx((d.addr << 1) | 1)}` : ''), $('span', { class: 'ic-grow' }), del('i2c'))];
    } else {
      const r = c.rails.find((x) => x.row === s.row);
      const set = (f) => (v) => setCell('rails', s.row, f, v);
      body = [$('div', { class: 'ic-grid' },
        fld('Rail', raw.name, set('name')), fld('Volts', raw.volts, set('volts')), fld('Source', raw.source, set('source')), fld('Notes', raw.notes, set('notes'))),
      ...issues(r?.issues || []), $('div', { class: 'ic-row2' },
        r?.mcu ? $('span', { class: 'ic-soft' }, 'This is the MCU I/O rail') : $('button', { class: 'k-btn', type: 'button', onclick: () => k.set('mcu_rail', raw.name) }, 'Use as MCU I/O rail'),
        $('span', { class: 'ic-grow' }), del('rails'))];
    }
    const title = { gpio: 'Signal', i2c: 'I2C device', rail: 'Rail' }[s.kind];
    insp.replaceChildren($('div', { class: 'ic-head' }, $('h2', {}, title), $('span', { class: 'ic-soft' }, `row ${s.row + 1}`), $('span', { class: 'ic-grow' }),
      $('button', { class: 'k-btn', type: 'button', onclick: () => select(null) }, 'Close')), $('div', { class: 'ic-ibody' }, ...body));
  }

  // ---------- issues, top ----------
  function drawIssues() {
    const c = C(); const r = k.result || {};
    const items = [
      ...c.rails.filter((x) => x.issues.length).map((x) => ['rail', x.row, `Rail ${x.name}`, x.issues]),
      ...c.gpio.filter((x) => x.issues.length).map((x) => ['gpio', x.row, x.signal || x.pin, x.issues]),
      ...c.i2c.filter((x) => x.issues.length).map((x) => ['i2c', x.row, `${x.device} (bus ${x.bus})`, x.issues]),
    ];
    const w = (r.warnings || []).filter((x) => !/issue\(s\) in the contract/.test(x));
    issuesBox.replaceChildren($('div', { class: 'ic-head' }, $('h2', {}, 'Issues'), $('span', { class: `ic-count${items.length ? ' ic-bad' : ' ic-ok'}` }, items.length ? `${items.reduce((n, x) => n + x[3].length, 0)} to fix` : 'none')),
      $('div', { class: 'ic-ilist' }, ...w.map((x) => $('div', { class: 'ic-issline' }, x)),
        ...items.map(([kind, row, name, list]) => $('button', { type: 'button', class: 'ic-iss-item', onclick: () => { if (kind === 'i2c') st.bus = c.i2c.find((d) => d.row === row)?.bus ?? st.bus; select(kind, row); } },
          $('b', {}, name), ...list.map((t) => $('div', {}, t)))),
        !items.length && !w.length ? $('div', { class: 'ic-empty' }, 'No pin, address or level problems found.') : null));
    const vals = Object.fromEntries((r.values || []).map((v) => [v.label, v]));
    summary.replaceChildren(...['GPIO signals', 'I2C devices', 'Rails', 'Issues'].filter((l) => vals[l]).map((l) =>
      $('span', { class: `ic-stat${l === 'Issues' ? (vals[l].value ? ' ic-bad' : ' ic-ok') : ''}` }, $('b', {}, String(vals[l].value)), ` ${l.toLowerCase()}`, vals[l].hint ? $('small', {}, ` · ${vals[l].hint}`) : null)));
  }

  function render() {
    const c = C();
    if (document.activeElement !== boardIn) boardIn.value = k.raw.board ?? '';
    const cur = String(k.raw.mcu_rail ?? '');
    const names = c.rails.map((r) => r.name);
    railSel.replaceChildren(...names.map((n) => $('option', { value: n, selected: n.toUpperCase() === cur.toUpperCase() }, n)),
      ...(names.some((n) => n.toUpperCase() === cur.toUpperCase()) ? [] : [$('option', { value: cur, selected: true }, cur || '(none)')]));
    tolIn.checked = !!k.raw.five_tolerant;
    drawWire(); drawMap(); drawInsp(); drawIssues();
    if (st.refocus != null) { wire.querySelector(`.ic-row[data-row="${st.refocus}"]`)?.focus(); st.refocus = null; }
    if (st.refocusDev != null) { map.querySelector(`.ic-dev[data-row="${st.refocusDev}"]`)?.focus(); st.refocusDev = null; }
    try { view(record, k.result, k.input, { set: k.set, raw: k.raw, fmtNum: k.fmtNum }); } catch (e) { console.error(e); }
  }
  k.onResult(() => render());
  let lastMode = '';
  new ResizeObserver(() => {
    const m = `${(wire.parentElement?.clientWidth || 0) < 620}|${(map.parentElement?.clientWidth || 0) < 520}`;
    if (m !== lastMode) { lastMode = m; if (k.result) render(); }
  }).observe(root);
}
