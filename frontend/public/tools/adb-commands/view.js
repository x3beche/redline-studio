// ADB Command Palette, custom page: the bench the commands act on.
//
// The main area is the setup itself: the host computer running the adb
// server and logcat, the USB cable (with the device serial on its tag), the
// Wi-Fi link (the phone's IP), the phone with its app window (application
// id, activity, deep link), its display, storage, CPU and keys, and an
// emulator beside it (the AVD name). Each part carries the number of commands
// for it; click a part to list only those, click it again for all. The
// values written on the drawing are the ones filled into the commands: click
// one (or focus it and press Enter) to edit it in place. The commands appear
// as a terminal listing with a Copy button per line; the filled-in values are
// marked in each command, and pointing at a command lights its part.
//
// The commands, the per-topic counts and the warnings are run()'s result.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};

const TOPICS = {
  device: 'Device', apps: 'Apps', files: 'Files', logs: 'Logs', screen: 'Screen and display',
  input: 'Input (tap, keys)', network: 'Network and Wi-Fi', emulator: 'Emulator', debug: 'Debug and performance',
};
// The values the tool fills in, what they are called, and run()'s fallback when blank.
const PARAMS = {
  pkg: ['Application id', 'com.example.app'], activity: ['Activity', '.MainActivity'], serial: ['Device serial', ''],
  apk: ['APK file', 'app-debug.apk'], url: ['Deep link', 'myapp://home'], ip: ['Phone IP / proxy host', '192.168.1.50'],
  avd: ['AVD name', 'Pixel_8_API_35'],
};
const WARN_KEY = [[/application id/i, 'pkg'], [/activity name/i, 'activity'], [/serial/i, 'serial'], [/IP address|host name/i, 'ip']];

const CSS = `
.adb { --tool-body: var(--sunken); --tool-glass: #0d1419; --tool-glass-ink: #9fe0b8; --tool-glass-dim: #5f7d6b;
  display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(360px, 1fr); gap: 12px; align-items: start; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .adb { --tool-glass: #070b0e; } }
:root[data-theme="dark"] .adb { --tool-glass: #070b0e; }
.adb [hidden] { display: none !important; }
.adb-out { grid-column: 1 / -1; }
@media (max-width: 920px) { .adb { grid-template-columns: minmax(0, 1fr); } }
.adb-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.adb-head { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.adb-h { font-weight: 600; font-size: 13px; }
.adb-sub { color: var(--ink-soft); font-size: 12px; }
.adb-topic { margin-left: auto; display: inline-flex; gap: 6px; align-items: center; }
.adb-pill { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: var(--accent); color: var(--accent-ink); }
.adb-scenewrap { position: relative; padding: 6px 8px 2px; }
.adb-scene { display: block; width: 100%; height: auto; max-height: calc(100vh - 175px); min-height: 260px; user-select: none; -webkit-user-select: none; }
.adb-scene text { font-family: "IBM Plex Sans", system-ui, sans-serif; }
.adb-scene .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.adb-scene .part { cursor: pointer; outline: none; transition: opacity .15s; }
.adb-scene .part .hl { fill: none; stroke: transparent; stroke-width: 2.2; }
.adb-scene .part:hover .hl { stroke: var(--ink-soft); stroke-dasharray: 4 3; }
.adb-scene .part:focus-visible .hl { stroke: var(--accent); stroke-dasharray: 4 3; }
.adb-scene .part.on .hl, .adb-scene .part.lit .hl { stroke: var(--accent); stroke-dasharray: none; }
.adb-scene.sel .part:not(.on):not(.lit) { opacity: .42; }
.adb-scene .part.none { opacity: .3; }
.adb-scene .body { fill: var(--tool-body); stroke: var(--line); stroke-width: 1.2; }
.adb-scene .ink { fill: var(--ink); } .adb-scene .soft { fill: var(--ink-soft); }
.adb-scene .stroke { fill: none; stroke: var(--ink-soft); stroke-width: 1.3; }
.adb-scene .card { fill: var(--surface); stroke: var(--line); }
.adb-scene .glass { fill: var(--tool-glass); }
.adb-scene .log { fill: var(--tool-glass-ink); font: 7.4px "IBM Plex Mono", ui-monospace, monospace; }
.adb-scene .log.dim { fill: var(--tool-glass-dim); }
.adb-scene .log.e { fill: var(--danger); }
.adb-scene .cap { fill: var(--ink-soft); font-size: 10.5px; }
.adb-scene .capb { fill: var(--ink); font-size: 11px; font-weight: 600; }
.adb-scene .badge circle { fill: var(--surface); stroke: var(--line); }
.adb-scene .badge text { fill: var(--ink); font: 600 10px "IBM Plex Mono", ui-monospace, monospace; }
.adb-scene .badge { cursor: pointer; }
.adb-scene .badge.on circle, .adb-scene .badge.lit circle { fill: var(--accent); stroke: var(--accent); }
.adb-scene .badge.on text, .adb-scene .badge.lit text { fill: var(--accent-ink); }
.adb-scene .badge.none { opacity: .45; }
.adb-scene .cable { fill: none; stroke: var(--ink-soft); stroke-width: 4; stroke-linecap: round; }
.adb-scene .wifi { fill: none; stroke: var(--ink-soft); stroke-width: 1.6; stroke-dasharray: 5 4; }
.adb-scene .val { cursor: text; outline: none; }
.adb-scene .val rect { fill: var(--surface); stroke: var(--line); stroke-dasharray: 3 2; }
.adb-scene .val text { fill: var(--ink); font: 10.5px "IBM Plex Mono", ui-monospace, monospace; }
.adb-scene .val .k { fill: var(--ink-soft); font: 9px "IBM Plex Sans", system-ui, sans-serif; }
.adb-scene .val:hover rect, .adb-scene .val:focus-visible rect { stroke: var(--accent); stroke-dasharray: none; }
.adb-scene .val:focus-visible rect { stroke-width: 2; }
.adb-scene .val.bad rect { stroke: var(--danger); stroke-dasharray: none; }
.adb-scene .val.bad text { fill: var(--danger); }
.adb-scene .val.empty text:not(.k) { fill: var(--ink-soft); font-style: italic; }
.adb-edit { position: absolute; z-index: 2; padding: 3px 6px; border: 2px solid var(--accent); border-radius: 4px; background: var(--surface);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); box-shadow: 0 2px 8px rgba(0,0,0,.25); }
.adb-help { padding: 2px 10px 9px; font-size: 11.5px; color: var(--ink-soft); }

/* terminal */
.adb-term { display: flex; flex-direction: column; max-height: calc(100vh - 88px); min-height: 360px; }
.adb-prompt { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.adb-prompt b { font: 600 13px "IBM Plex Mono", ui-monospace, monospace; color: var(--accent); }
.adb-prompt input { flex: 1; min-width: 0; padding: 4px 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.adb-count { font-size: 11.5px; color: var(--ink-soft); white-space: nowrap; }
.adb-warns:empty { display: none; }
.adb-warns { margin: 8px 10px 0; border: 1px solid var(--warn); border-left-width: 3px; border-radius: 4px; padding: 5px 9px; font-size: 12px; }
.adb-warns div + div { margin-top: 3px; }
.adb-list { overflow: auto; padding: 4px 0 8px; flex: 1; min-height: 0; }
.adb-grp { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 5px 10px 4px; background: var(--surface);
  font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-soft); border-bottom: 1px solid var(--line-soft); }
.adb-grp button { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400; }
.adb-cmd { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); }
.adb-cmd:hover, .adb-cmd:focus-within { background: var(--sunken); }
.adb-task { font-size: 12.5px; color: var(--ink); }
.adb-note { grid-column: 1; font-size: 11.5px; color: var(--ink-soft); }
.adb-line { grid-column: 1; font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; word-break: break-word; }
.adb-line::before { content: "$ "; color: var(--ink-soft); }
.adb-line .tok { color: var(--accent); border-bottom: 1px dashed var(--accent); cursor: pointer; }
.adb-line .tok:hover { background: var(--sunken); }
.adb-line .amp { color: var(--warn); }
.adb-copy { grid-column: 2; grid-row: 1 / span 3; align-self: center; }
.adb-empty { padding: 18px 12px; color: var(--ink-soft); font-size: 12.5px; }
.adb-notes { padding: 6px 10px 8px; border-top: 1px solid var(--line-soft); font-size: 11.5px; color: var(--ink-soft); }
.adb-notes div + div { margin-top: 2px; }
@media (max-width: 920px) { .adb-term { max-height: 70vh; } .adb-scene { max-height: none; } }
`;

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const was = btn.textContent; btn.textContent = ok ? 'Copied' : 'Select it';
  setTimeout(() => { btn.textContent = was; }, 1200);
}

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const st = { editing: null, lit: null };

  // ------------------------------------------------------------ scene
  const scene = sv('svg', { class: 'adb-scene', viewBox: '0 0 660 420', role: 'group', 'aria-label': 'Host computer, phone and emulator. Choose a part to list its commands.' });
  const wrap = h('div', { class: 'adb-scenewrap' }, scene);
  const topicPill = h('span', { class: 'adb-pill' });
  const allBtn = h('button', { class: 'k-btn', onclick: () => ctx.set('category', 'all') }, 'Show all topics');
  const scenePanel = h('section', { class: 'adb-panel' },
    h('div', { class: 'adb-head' }, h('span', { class: 'adb-h' }, 'Bench'), h('span', { class: 'adb-sub' }, 'click a part for its commands'),
      h('span', { class: 'adb-topic' }, topicPill, allBtn)),
    wrap,
    h('div', { class: 'adb-help' }, 'Values in dashed boxes go into every command: click one, or Tab to it and press Enter, to change it. Tab to a part and press Enter to pick it.'));

  // ------------------------------------------------------------ terminal
  const filterIn = h('input', { type: 'search', spellcheck: 'false', placeholder: 'filter: log, install, proxy, tap…', 'aria-label': 'Filter words, all must match',
    oninput: (e) => ctx.set('filter', e.target.value) });
  const count = h('span', { class: 'adb-count', 'aria-live': 'polite' });
  const warns = h('div', { class: 'adb-warns', 'aria-live': 'polite' });
  const list = h('div', { class: 'adb-list' });
  const notes = h('div', { class: 'adb-notes' });
  const term = h('section', { class: 'adb-panel adb-term' },
    h('div', { class: 'adb-prompt' }, h('b', {}, '$'), filterIn, count), warns, list, notes);
  root.append(h('div', { class: 'adb' }, scenePanel, term, h('div', { class: 'adb-out' }, ctx.outputs)));

  // ------------------------------------------------------------ helpers
  const eff = (key) => { const v = String(ctx.raw[key] ?? '').trim(); return v || PARAMS[key][1]; };
  const pick = (cat) => ctx.set('category', ctx.raw.category === cat ? 'all' : cat);
  const short = (t, n) => (t.length > n ? '…' + t.slice(t.length - n + 1) : t);

  function part(cat, g, badgeAt) {
    g.setAttribute('class', 'part');
    g.dataset.cat = cat;
    g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button');
    g.addEventListener('click', (e) => { if (e.target.closest('.val')) return; pick(cat); });
    g.addEventListener('keydown', (e) => { if (e.target !== g) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(cat); } });
    // the count goes on a layer above every part, so no part covers it
    const b = sv('g', { class: 'badge', transform: `translate(${badgeAt[0]},${badgeAt[1]})`, 'aria-hidden': 'true' });
    b.dataset.cat = cat;
    b.append(sv('circle', { r: 10 }), sv('text', { 'text-anchor': 'middle', y: 3.5 }, ''));
    b.addEventListener('click', () => pick(cat));
    g._badgeG = b;
    g._badge = b.lastChild;
    scene.append(g);
    return g;
  }
  // an editable value written on the drawing
  function val(key, x, y, anchor = 'start', maxChars = 26, parent = scene) {
    const g = sv('g', { class: 'val', tabindex: '0', role: 'button' });
    g.dataset.key = key;
    const raw = String(ctx.raw[key] ?? '').trim();
    const shown = raw ? short(raw, maxChars) : key === 'serial' ? 'none: one device' : short(PARAMS[key][1], maxChars);
    const kText = sv('text', { class: 'k', x: 0, y: -12 }, PARAMS[key][0].toLowerCase());
    const t = sv('text', { x: 0, y: 0 }, shown);
    g.append(sv('rect'), kText, t);
    if (!raw) g.classList.add('empty');
    g.setAttribute('aria-label', `${PARAMS[key][0]}: ${raw || 'not set'}. Press Enter to edit.`);
    parent.append(g);
    const w = Math.max(t.getComputedTextLength ? t.getComputedTextLength() : shown.length * 6.3, 20) + 10;
    const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    g.setAttribute('transform', `translate(${x0},${y})`);
    t.setAttribute('x', 5);
    kText.setAttribute('x', 1);
    g.firstChild.setAttribute('x', 0); g.firstChild.setAttribute('y', -10); g.firstChild.setAttribute('width', w); g.firstChild.setAttribute('height', 14.5); g.firstChild.setAttribute('rx', 2.5);
    g.addEventListener('click', (e) => { e.stopPropagation(); edit(key, g); });
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') { e.preventDefault(); e.stopPropagation(); edit(key, g); } });
    return g;
  }

  function edit(key, anchor) {
    closeEdit(false);
    const wr = wrap.getBoundingClientRect();
    const r = (anchor.querySelector('rect') || anchor).getBoundingClientRect();
    const inp = h('input', { class: 'adb-edit', type: 'text', spellcheck: 'false', 'aria-label': PARAMS[key][0], placeholder: PARAMS[key][1] || 'emulator-5554' });
    const width = Math.min(Math.max(r.width + 40, 170), wr.width - 8);
    const left = Math.max(4, Math.min(r.left - wr.left - 4, wr.width - width - 4));
    inp.style.left = `${left}px`; inp.style.top = `${r.top - wr.top - 5}px`; inp.style.width = `${width}px`;
    inp.value = ctx.raw[key] ?? '';
    const before = inp.value;
    st.editing = { key, inp, before };
    inp.addEventListener('input', () => ctx.set(key, inp.value));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); closeEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); ctx.set(key, before); closeEdit(true); }
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (st.editing && st.editing.inp === inp) closeEdit(false); }, 0));
    wrap.append(inp);
    inp.focus(); inp.select();
  }
  function closeEdit(refocus) {
    const e = st.editing; if (!e) return;
    st.editing = null; e.inp.remove();
    if (refocus) { const g = scene.querySelector(`.val[data-key="${e.key}"]`); if (g) g.focus(); }
  }

  // ------------------------------------------------------------ drawing
  // Two arrangements of the same bench: side by side on a wide page; on a
  // phone the host moves under the phone so the drawing keeps a legible scale.
  const LAYOUT = {
    wide: { vb: '0 0 660 420', host: [0, 0], wifiIcon: [262, 40], ip: [300, 70, 'middle'], serial: [300, 398, 'end'],
      cable: 'M240 232 C300 232 290 404 360 404 L424 404 C436 404 440 398 440 392', wifi: 'M214 70 Q300 -6 372 48', netBadge: [300, 36] },
    narrow: { vb: '340 0 320 800', host: [350, 440], wifiIcon: [604, 392], ip: [604, 432, 'middle'], serial: [452, 456, 'start'],
      cable: 'M440 392 C440 440 471 462 471 506', wifi: null, netBadge: [636, 380] },
  };
  const layoutName = () => (wrap.clientWidth && wrap.clientWidth < 560 ? 'narrow' : 'wide');
  let shownLayout = null;
  new ResizeObserver(() => { if (layoutName() !== shownLayout && ctx.result) draw(ctx.result); }).observe(wrap);

  function drawScene(res) {
    scene.replaceChildren();
    const L = LAYOUT[shownLayout = layoutName()];
    scene.setAttribute('viewBox', L.vb);
    const T = `translate(${L.host[0]},${L.host[1]})`;
    const cat = ctx.raw.category || 'all';
    const topics = res.topics || {};
    scene.classList.toggle('sel', cat !== 'all');
    const P = {};
    const hb = (x, y) => [x + L.host[0], y + L.host[1]];

    // Wi-Fi link: host to phone (network)
    P.network = part('network', sv('g'), L.netBadge);
    if (L.wifi) {
      P.network.append(sv('path', { class: 'hl', d: L.wifi, 'stroke-width': 14, 'stroke-linecap': 'round', opacity: 0.6 }));
      P.network.append(sv('path', { class: 'wifi', d: L.wifi }));
    }
    const wf = sv('g', { transform: `translate(${L.wifiIcon[0]},${L.wifiIcon[1]})` });
    for (const r of [5, 10, 15]) wf.append(sv('path', { class: 'stroke', d: `M${-r * 0.8} ${-r * 0.6 + 8} A${r} ${r} 0 0 1 ${r * 0.8} ${-r * 0.6 + 8}` }));
    wf.append(sv('circle', { cx: 0, cy: 9, r: 2, class: 'soft' }));
    if (!L.wifi) wf.append(sv('rect', { class: 'hl', x: -40, y: -14, width: 80, height: 60, rx: 6 }));
    P.network.append(wf);

    // host computer: its screen shows logcat (logs)
    const host = sv('g', { transform: T });
    host.append(sv('rect', { class: 'body', x: 14, y: 70, width: 214, height: 150, rx: 7 }));
    host.append(sv('path', { class: 'body', d: 'M16 222 H226 L240 240 H2 Z' }));
    host.append(sv('text', { class: 'capb', x: 121, y: 258, 'text-anchor': 'middle' }, 'host'));
    host.append(sv('text', { class: 'cap', x: 121, y: 271, 'text-anchor': 'middle' }, 'adb server, logcat'));
    scene.append(host);
    P.logs = part('logs', sv('g'), hb(214, 84));
    const lg = sv('g', { transform: T });
    lg.append(sv('rect', { class: 'glass', x: 22, y: 78, width: 198, height: 132, rx: 3 }));
    const pkg = eff('pkg');
    const lines = [
      ['dim', '$ adb logcat -v threadtime'],
      ['', 'I ActivityManager: Start proc'],
      ['', `  ${short(pkg, 24)}`],
      ['dim', 'D OpenGLRenderer: Davey! 712ms'],
      ['', `I ${short(eff('activity').replace(/^\./, ''), 14)}: onResume`],
      ['e', 'E AndroidRuntime: FATAL EXCEPTION'],
      ['e', '  java.lang.NullPointerException'],
      ['dim', 'W System.err: at …Main.kt:42'],
      ['', 'I chatty: uid=10123 expire 3'],
    ];
    lines.forEach(([c, t], i) => lg.append(sv('text', { class: `log ${c}`, x: 28, y: 92 + i * 13 }, t)));
    lg.append(sv('rect', { class: 'hl', x: 20, y: 76, width: 202, height: 136, rx: 4 }));
    P.logs.append(lg);

    // USB cable: host to phone (device)
    P.device = part('device', sv('g'), [540, 96]);
    P.device.append(sv('path', { class: 'hl', d: L.cable, 'stroke-width': 12, opacity: 0.6, 'stroke-linecap': 'round' }));
    P.device.append(sv('path', { class: 'cable', d: L.cable }));
    if (L.wifi) P.device.append(sv('rect', { class: 'card', x: 231, y: 226, width: 12, height: 12, rx: 2 }));

    // phone
    const ph = sv('g');
    ph.append(sv('rect', { class: 'body', x: 356, y: 18, width: 168, height: 374, rx: 24 }));
    ph.append(sv('rect', { class: 'glass', x: 366, y: 42, width: 148, height: 330, rx: 8, opacity: 0.18 }));
    ph.style.cursor = 'pointer';
    ph.addEventListener('click', () => pick('device'));
    scene.append(ph);
    // power button and the frame (device)
    P.device.append(sv('rect', { class: 'body', x: 524, y: 96, width: 5, height: 36, rx: 1.5 }));
    P.device.append(sv('rect', { class: 'hl', x: 352, y: 14, width: 180, height: 382, rx: 27 }));
    P.device.append(sv('text', { class: 'cap', x: 440, y: 33, 'text-anchor': 'middle' }, 'device'));
    scene.append(P.device); // above the phone body so the frame outline shows

    // display (screen)
    P.screen = part('screen', sv('g'), [505, 218]);
    P.screen.append(sv('rect', { class: 'card', x: 372, y: 212, width: 136, height: 86, rx: 5 }));
    for (const [x, y, w, hh] of [[380, 222, 60, 10], [380, 238, 120, 22], [380, 266, 52, 24], [440, 266, 60, 24]]) P.screen.append(sv('rect', { x, y, width: w, height: hh, fill: 'none', stroke: 'var(--danger)', 'stroke-width': 0.8, 'stroke-dasharray': '2 2', opacity: 0.7 }));
    P.screen.append(sv('text', { class: 'cap', x: 382, y: 231 }, 'display'));
    P.screen.append(sv('rect', { class: 'hl', x: 369, y: 209, width: 142, height: 92, rx: 7 }));

    // app window (apps), and the APK file on the host
    P.apps = part('apps', sv('g'), [505, 60]);
    P.apps.append(sv('rect', { class: 'card', x: 372, y: 52, width: 136, height: 152, rx: 6 }));
    P.apps.append(sv('circle', { cx: 390, cy: 72, r: 10, fill: 'var(--accent)' }));
    P.apps.append(sv('text', { class: 'capb', x: 406, y: 76, style: 'font-size:10px' }, 'app'));
    P.apps.append(sv('rect', { class: 'hl', x: 369, y: 49, width: 142, height: 158, rx: 8 }));
    const apkG = sv('g', { transform: T });
    apkG.append(sv('path', { class: 'card', d: 'M22 296 h26 l10 10 v36 h-36 Z' }));
    apkG.append(sv('path', { class: 'stroke', d: 'M48 296 v10 h10' }));
    apkG.append(sv('text', { class: 'capb mono', x: 40, y: 330, 'text-anchor': 'middle', style: 'font-size:9px' }, 'APK'));
    apkG.append(sv('rect', { class: 'hl', x: 18, y: 292, width: 44, height: 54, rx: 4 }));
    P.apps.append(apkG);

    // storage (files) and CPU / memory (debug)
    P.files = part('files', sv('g'), [432, 310]);
    P.files.append(sv('rect', { class: 'card', x: 372, y: 306, width: 64, height: 40, rx: 5 }));
    P.files.append(sv('path', { class: 'stroke', d: 'M382 318 h12 l4 4 h18 v16 h-34 Z' }));
    P.files.append(sv('text', { class: 'cap mono', x: 404, y: 334, 'text-anchor': 'middle', style: 'font-size:8px' }, '/sdcard'));
    P.files.append(sv('rect', { class: 'hl', x: 369, y: 303, width: 70, height: 46, rx: 7 }));
    P.debug = part('debug', sv('g'), [506, 310]);
    P.debug.append(sv('rect', { class: 'card', x: 444, y: 306, width: 64, height: 40, rx: 5 }));
    P.debug.append(sv('rect', { x: 454, y: 314, width: 22, height: 22, rx: 2, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 1.3 }));
    for (let i = 0; i < 4; i++) { P.debug.append(sv('line', { x1: 458 + i * 5, y1: 310, x2: 458 + i * 5, y2: 314, stroke: 'var(--ink-soft)' })); P.debug.append(sv('line', { x1: 458 + i * 5, y1: 336, x2: 458 + i * 5, y2: 340, stroke: 'var(--ink-soft)' })); }
    [8, 14, 6, 18, 11].forEach((v, i) => P.debug.append(sv('rect', { x: 482 + i * 4.5, y: 336 - v, width: 3, height: v, fill: 'var(--tool-s1)' })));
    P.debug.append(sv('rect', { class: 'hl', x: 441, y: 303, width: 70, height: 46, rx: 7 }));

    // navigation keys (input)
    P.input = part('input', sv('g'), [506, 362]);
    P.input.append(sv('rect', { x: 382, y: 350, width: 112, height: 22, fill: 'transparent' }));
    P.input.append(sv('path', { class: 'stroke', d: 'M404 356 l-7 5 l7 5 Z' }));
    P.input.append(sv('circle', { class: 'stroke', cx: 440, cy: 361, r: 5.5 }));
    P.input.append(sv('rect', { class: 'stroke', x: 471, y: 356, width: 10, height: 10, rx: 1 }));
    P.input.append(sv('rect', { class: 'hl', x: 382, y: 350, width: 112, height: 22, rx: 6 }));

    // emulator (runs on the host)
    P.emulator = part('emulator', sv('g'), [640, 132]);
    P.emulator.append(sv('rect', { x: 566, y: 140, width: 76, height: 150, rx: 12, fill: 'transparent', stroke: 'var(--ink-soft)', 'stroke-width': 1.4, 'stroke-dasharray': '5 3' }));
    P.emulator.append(sv('rect', { class: 'glass', x: 572, y: 154, width: 64, height: 118, rx: 4, opacity: 0.18 }));
    P.emulator.append(sv('text', { class: 'cap mono', x: 604, y: 214, 'text-anchor': 'middle', style: 'font-size:9px' }, 'emu'));
    P.emulator.append(sv('text', { class: 'capb', x: 604, y: 306, 'text-anchor': 'middle' }, 'emulator'));
    P.emulator.append(sv('text', { class: 'cap', x: 604, y: 319, 'text-anchor': 'middle' }, 'runs on the host'));
    P.emulator.append(sv('rect', { class: 'hl', x: 560, y: 134, width: 88, height: 190, rx: 14 }));

    // counts and state
    for (const [k, g] of Object.entries(P)) {
      const n = topics[k] ?? 0;
      g._badge.textContent = String(n);
      g.classList.toggle('on', cat === k);
      g.classList.toggle('none', n === 0 && cat !== k);
      g.setAttribute('aria-label', `${TOPICS[k]}: ${n} command${n === 1 ? '' : 's'}${cat === k ? ', shown' : ''}`);
      g.setAttribute('aria-pressed', String(cat === k));
    }
    const badges = sv('g');
    for (const [k, g] of Object.entries(P)) {
      const b = g._badgeG;
      b.classList.toggle('on', cat === k); b.classList.toggle('none', (topics[k] ?? 0) === 0 && cat !== k);
      badges.append(b);
    }
    if (st.lit && P[st.lit]) { P[st.lit].classList.add('lit'); P[st.lit]._badgeG.classList.add('lit'); }

    // the values, written where they belong
    const bad = new Set();
    for (const w of res.warnings || []) for (const [re, key] of WARN_KEY) if (re.test(w)) bad.add(key);
    const vals = [
      val('ip', L.ip[0], L.ip[1], L.ip[2], 18, P.network),
      val('pkg', 380, 104, 'start', 17, P.apps),
      val('activity', 380, 140, 'start', 17, P.apps),
      val('url', 380, 176, 'start', 17, P.apps),
      val('apk', 66, 330, 'start', 22, apkG),
      val('serial', L.serial[0], L.serial[1], L.serial[2], 16, P.device),
      val('avd', 604, 356, 'middle', 16, P.emulator),
    ];
    for (const g of vals) if (bad.has(g.dataset.key)) g.classList.add('bad');
    scene.append(badges);
  }

  // ------------------------------------------------------------ terminal
  function tokens(cmd) {
    const pairs = Object.keys(PARAMS).map((k) => [eff(k), k]).filter(([v]) => v && v.length > 1);
    const serial = String(ctx.raw.serial ?? '').trim();
    if (!serial) { const i = pairs.findIndex(([, k]) => k === 'serial'); if (i >= 0) pairs.splice(i, 1); }
    pairs.sort((a, b) => b[0].length - a[0].length);
    const out = [];
    let rest = cmd;
    while (rest) {
      let best = null;
      for (const [v, k] of pairs) { const i = rest.indexOf(v); if (i >= 0 && (!best || i < best.i || (i === best.i && v.length > best.v.length))) best = { i, v, k }; }
      const amp = rest.indexOf(' && ');
      if (amp >= 0 && (!best || amp < best.i)) { out.push(rest.slice(0, amp)); out.push(h('span', { class: 'amp' }, ' && ')); rest = rest.slice(amp + 4); continue; }
      if (!best) { out.push(rest); break; }
      out.push(rest.slice(0, best.i));
      out.push(h('span', { class: 'tok', 'data-key': best.k, title: `${PARAMS[best.k][0]}: click to change it on the bench` }, best.v));
      rest = rest.slice(best.i + best.v.length);
    }
    return out;
  }
  function light(cat) {
    st.lit = cat;
    for (const g of scene.querySelectorAll('.part, .badge')) g.classList.toggle('lit', g.dataset.cat === cat);
  }
  function drawList(res) {
    const t = (res.tables || [])[0];
    const rows = t ? t.rows : [];
    list.replaceChildren();
    const cat = ctx.raw.category || 'all';
    const total = Object.values(res.topics || {}).reduce((a, b) => a + b, 0);
    count.textContent = cat === 'all' ? `${rows.length} command${rows.length === 1 ? '' : 's'}` : `${rows.length} of ${total}`;
    if (!rows.length) {
      list.append(h('div', { class: 'adb-empty' }, 'No command matches. Try one word (log, install, tap, proxy), or show all topics.'));
      return;
    }
    let group = null;
    for (const [c, task, cmd, note] of rows) {
      if (c !== group) {
        group = c;
        list.append(h('div', { class: 'adb-grp' }, TOPICS[c] || c,
          cat === 'all' ? h('button', { class: 'k-btn', onclick: () => ctx.set('category', c) }, 'Only these') : null));
      }
      const btn = h('button', { class: 'k-btn adb-copy', 'aria-label': `Copy: ${task}`, onclick: (e) => copyText(cmd, e.currentTarget) }, 'Copy');
      const row = h('div', { class: 'adb-cmd', 'data-cat': c,
        onmouseenter: () => light(c), onmouseleave: () => light(null) },
      h('div', { class: 'adb-task' }, task), h('div', { class: 'adb-line' }, tokens(cmd)), note ? h('div', { class: 'adb-note' }, note) : null, btn);
      row.addEventListener('focusin', () => light(c));
      row.addEventListener('focusout', () => light(null));
      list.append(row);
    }
  }
  list.addEventListener('click', (e) => {
    const tk = e.target.closest('.tok'); if (!tk) return;
    const g = scene.querySelector(`.val[data-key="${tk.dataset.key}"]`);
    if (g) { scenePanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); edit(tk.dataset.key, g); }
  });

  // ------------------------------------------------------------ sync
  function draw(res) {
    const cat = ctx.raw.category || 'all';
    topicPill.textContent = cat === 'all' ? 'All topics' : TOPICS[cat];
    allBtn.hidden = cat === 'all';
    if (document.activeElement !== filterIn && filterIn.value !== (ctx.raw.filter ?? '')) filterIn.value = ctx.raw.filter ?? '';
    const focusedPart = document.activeElement && document.activeElement.closest && document.activeElement.closest('.part');
    const focusedVal = document.activeElement && document.activeElement.closest && document.activeElement.closest('.val');
    const fp = focusedPart && !focusedVal ? focusedPart.dataset.cat : null;
    const fv = focusedVal ? focusedVal.dataset.key : null;
    drawScene(res);
    if (fp) scene.querySelector(`.part[data-cat="${fp}"]`)?.focus({ preventScroll: true });
    if (fv) scene.querySelector(`.val[data-key="${fv}"]`)?.focus({ preventScroll: true });
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    drawList(res);
    notes.replaceChildren(...(res.notes || []).slice(1).map((n) => h('div', {}, n)));
  }
  ctx.onResult((res) => draw(res || {}));
}
