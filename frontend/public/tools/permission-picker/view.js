// Permission Picker: the page is the app's permission surface.
//   Phone     - what the app touches, drawn where it lives on a phone: the
//               camera hole, the mic, the status-bar radios, the notification,
//               the fingerprint, the buzz, and the data it reads as home-screen
//               apps. Click (or Enter on) a part to switch that feature.
//   API lanes - one lane per AndroidManifest line, a bar over the API levels
//               it applies to; the minSdk-targetSdk window is the shaded band,
//               drag its edges (or arrow keys on them). Lines that fall outside
//               the window are shown greyed with why they are not written.
//   Info.plist - the iOS keys with their draft purpose strings.
//   Hover a lane to light its features on the phone, and a feature to light
//   its lanes. Every line and count comes from run()'s result.

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const API_LO = 21, API_HI = 36;
const VERSION = { 21: '5.0', 22: '5.1', 23: '6', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16' };

// Glyphs on a 24 × 24 box: [path d, [circles cx, cy, r]].
const G = {
  camera: ['M3 8h4l2-3h6l2 3h4v11H3z', [[12, 13, 3.6]]],
  microphone: ['M9 4.5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z M5.5 11a6.5 6.5 0 0 0 13 0 M12 17.5V21', []],
  photosRead: ['M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6', [[8, 9, 1.6]]],
  photosSave: ['M12 3v11 M7 9.5l5 5 5-5 M4 20h16', []],
  location: ['M12 21s-6.5-6.4-6.5-11.5a6.5 6.5 0 0 1 13 0C18.5 14.6 12 21 12 21z', [[12, 9.5, 2.4]]],
  bgLocation: ['M5 19c3-1 3-6 7-7s4-6 7-7', [[5, 19, 2], [19, 5, 2]]],
  bluetooth: ['M7 7.5l10 9-5 4.5V3l5 4.5-10 9', []],
  notifications: ['M6 16.5V11a6 6 0 0 1 12 0v5.5l1.8 2H4.2z M10 21h4', []],
  contacts: ['M4 21c.8-4.6 4.4-6 8-6s7.2 1.4 8 6', [[12, 8, 4]]],
  calendar: ['M4 6h16v14H4z M4 10.5h16 M8.5 3.5v4.5 M15.5 3.5v4.5', []],
  internet: ['M4 20v-3 M9 20v-7 M14 20V9 M19 20V4.5', []],
  localNetwork: ['M2.5 9.5a14 14 0 0 1 19 0 M5.5 13a9.5 9.5 0 0 1 13 0 M8.7 16.4a4.8 4.8 0 0 1 6.6 0', [[12, 19.6, 1.2]]],
  biometrics: ['M7 13v-1a5 5 0 0 1 10 0v2 M9.6 17v-5a2.4 2.4 0 0 1 4.8 0v5 M12 12v8 M4.5 10a8 8 0 0 1 15 0 M17 17.5v1.5', []],
  nfc: ['M6.5 18V6l11 12V6 M3 4.5a11 11 0 0 0 0 15 M21 4.5a11 11 0 0 1 0 15', []],
  vibrate: ['M8.5 4h7v16h-7z M5 8v8 M19 8v8 M2 10v4 M22 10v4', []],
  boot: ['M12 3v8 M7.2 6.2a7.2 7.2 0 1 0 9.6 0', []],
  exactAlarm: ['M12 9v4.2l2.8 1.8 M4.5 5l3-2.5 M19.5 5l-3-2.5', [[12, 13, 7.5]]],
  fgs: ['M3 12h4l2.5-5.5 5 11L17 12h4', []],
  motion: ['M8.5 3.5c2 0 3 2.6 3 5.6S10.4 13 8.5 13 5.5 11.2 5.5 8.5s1-5 3-5z M15.5 10c2 0 3 2.2 3 5s-1 5.5-3 5.5-3-1.4-3-4.2 1-6.3 3-6.3z', []],
  speech: ['M4 5h16v11H9.5L4 20z M8.5 9.5v2 M11 8.5v4 M13.5 8v5 M16 9.5v2', []],
  tracking: ['M12 2.5v4 M12 17.5v4 M2.5 12h4 M17.5 12h4', [[12, 12, 7.5], [12, 12, 3]]],
  wakeLock: ['M12 2.5v2.5 M12 19v2.5 M2.5 12H5 M19 12h2.5 M5.3 5.3l1.8 1.8 M16.9 16.9l1.8 1.8 M5.3 18.7l1.8-1.8 M16.9 7.1l1.8-1.8', [[12, 12, 4]]],
};
// Home-screen apps: the data and system features.
const APPS = ['photosRead', 'photosSave', 'contacts', 'calendar', 'exactAlarm', 'motion', 'speech', 'tracking', 'bgLocation', 'fgs', 'boot', 'wakeLock'];
const APP_NAME = { photosRead: 'Photos', photosSave: 'Save img', contacts: 'Contacts', calendar: 'Calendar', exactAlarm: 'Alarms', motion: 'Steps', speech: 'Speech', tracking: 'Ad ID', bgLocation: 'Bg loc.', fgs: 'Service', boot: 'Boot', wakeLock: 'Awake' };
// Status bar radios, right to left of the camera hole.
const RADIOS = ['location', 'bluetooth', 'localNetwork', 'internet', 'nfc'];
const KIND = { normal: 'normal', runtime: 'runtime dialog', special: 'Settings screen' };

export function page(root, ctx) {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('style.css', import.meta.url).href;
  document.head.append(link);

  let res = null;
  let hot = null;   // {feats: Set of labels} lit by hover

  // ---------------- bar ----------------
  const platSeg = h('div', { class: 'pp-seg', role: 'group', 'aria-label': 'Platforms' },
    [['both', 'Android + iOS'], ['android', 'Android'], ['ios', 'iOS']].map(([v, t]) => h('button', { type: 'button', 'data-v': v, onclick: () => ctx.set('platform', v) }, t)));
  const fMin = h('input', { class: 'pp-num', inputmode: 'numeric', 'aria-label': 'minSdk', oninput: (e) => ctx.set('minSdk', e.target.value) });
  const fTgt = h('input', { class: 'pp-num', inputmode: 'numeric', 'aria-label': 'targetSdk', oninput: (e) => ctx.set('targetSdk', e.target.value) });
  const counts = h('div', { class: 'pp-counts' });
  const bar = h('div', { class: 'pp-bar' }, platSeg,
    h('label', { class: 'pp-ctl' }, h('span', {}, 'minSdk'), fMin), h('label', { class: 'pp-ctl' }, h('span', {}, 'targetSdk'), fTgt), counts);

  // ---------------- phone ----------------
  const phone = sv('svg', { class: 'pp-phone', viewBox: '0 0 300 604', role: 'group', 'aria-label': 'Features the app uses' });
  const fgsSel = h('select', { class: 'pp-sel', 'aria-label': 'Foreground service type', onchange: (e) => ctx.set('fgsType', e.target.value) },
    (ctx.manifest.inputs.find((d) => d.key === 'fgsType')?.options || []).map(([v, t]) => h('option', { value: v }, t)));
  const fgsRow = h('label', { class: 'pp-ctl pp-fgs' }, h('span', {}, 'Service type'), fgsSel);
  const phonePanel = h('section', { class: 'pp-panel pp-phone-panel' },
    h('div', { class: 'pp-phead' }, h('span', { class: 'pp-h' }, 'What the app uses'), h('span', { class: 'pp-sub' }, 'click a part')),
    phone, fgsRow);

  // ---------------- lanes ----------------
  const lanes = sv('svg', { class: 'pp-lanes', role: 'group', 'aria-label': 'Manifest lines over Android API levels' });
  const lanesPanel = h('section', { class: 'pp-panel' },
    h('div', { class: 'pp-phead' }, h('span', { class: 'pp-h' }, 'AndroidManifest over API levels'),
      h('span', { class: 'pp-sub' }, 'drag the edges of the shaded minSdk–targetSdk band'),
      h('span', { class: 'pp-key' }, ...Object.entries(KIND).map(([k, t]) => h('span', {}, h('i', { class: `pp-k-${k}` }), t)))),
    h('div', { class: 'pp-lanes-wrap' }, lanes));
  const iosList = h('div', { class: 'pp-ios' });
  const iosPanel = h('section', { class: 'pp-panel' }, h('div', { class: 'pp-phead' }, h('span', { class: 'pp-h' }, 'Info.plist'), h('span', { class: 'pp-sub' }, 'rewrite each string: say what the user gets')), iosList);
  const warns = h('div', { class: 'pp-warns' });
  const notes = h('details', { class: 'pp-notes' });

  root.classList.add('pp-root');
  root.append(h('div', { class: 'pp' },
    h('div', { class: 'pp-top' }, bar),
    phonePanel,
    h('div', { class: 'pp-main' }, lanesPanel, iosPanel,
      warns, ctx.outputs, notes)));

  // ---------------- phone drawing ----------------
  const glyph = (key, x, y, s) => {
    const [d, circles] = G[key] || ['', []];
    const g = sv('g', { transform: `translate(${x} ${y}) scale(${s / 24})`, class: 'pp-glyph' });
    g.append(sv('path', { d }));
    for (const [cx, cy, r] of circles) g.append(sv('circle', { cx, cy, r }));
    return g;
  };
  const toggle = (key) => ctx.set(key, !ctx.input[key]);
  const part = (key, label, build, labelAt) => {
    const f = res?.view?.features?.[key];
    const on = !!f?.on;
    const lit = hot && f && hot.has(f.label);
    const g = sv('g', { class: `pp-part${on ? ' pp-on' : ''}${lit ? ' pp-lit' : ''}`, tabindex: '0', role: 'switch', 'aria-checked': String(on), 'aria-label': f?.label || label, 'data-k': key });
    build(g, on);
    if (labelAt) g.append(sv('text', { x: labelAt[0], y: labelAt[1], 'text-anchor': labelAt[2] || 'middle', class: 'pp-plabel' }, label));
    const t = sv('title', {}, `${f?.label || label}: ${on ? 'used' : 'not used'} - click to switch`); g.append(t);
    g.addEventListener('click', () => toggle(key));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusKey = key; toggle(key); } });
    g.addEventListener('mouseenter', () => setHot(f ? new Set([f.label]) : null, 'phone'));
    g.addEventListener('mouseleave', () => setHot(null, 'phone'));
    g.addEventListener('focus', () => setHot(f ? new Set([f.label]) : null, 'phone'));
    g.addEventListener('blur', () => setHot(null, 'phone'));
    return g;
  };
  let focusKey = null;
  function phoneDraw() {
    phone.replaceChildren();
    phone.append(sv('rect', { x: 14, y: 4, width: 272, height: 596, rx: 38, class: 'pp-body' }),
      sv('rect', { x: 24, y: 14, width: 252, height: 576, rx: 29, class: 'pp-glass' }),
      sv('rect', { x: 286, y: 150, width: 4, height: 60, rx: 2, class: 'pp-btn' }), sv('rect', { x: 286, y: 226, width: 4, height: 36, rx: 2, class: 'pp-btn' }),
      sv('text', { x: 40, y: 38, class: 'pp-time' }, '12:30'));
    phone.append(sv('text', { x: 150, y: 128, 'text-anchor': 'middle', class: 'pp-plabel pp-sb' }, 'data and system: home-screen apps'));
    // camera hole
    phone.append(part('camera', 'Camera', (g) => {
      g.append(sv('rect', { x: 134, y: 18, width: 32, height: 30, class: 'pp-hit' }));
      g.append(sv('circle', { cx: 150, cy: 32, r: 8, class: 'pp-lens' }), sv('circle', { cx: 150, cy: 32, r: 3, class: 'pp-lens-in' }));
    }, [128, 36, 'end']));
    // status bar radios
    RADIOS.forEach((k, i) => {
      const x = 176 + i * 19;
      phone.append(part(k, '', (g) => {
        g.append(sv('rect', { x: x - 2, y: 20, width: 19, height: 24, class: 'pp-hit' }));
        g.append(glyph(k, x, 24, 15));
      }));
    });
    phone.append(sv('text', { x: 268, y: 58, 'text-anchor': 'end', class: 'pp-plabel pp-sb' }, 'loc · BT · Wi-Fi · net · NFC'));
    // notification shade card
    phone.append(part('notifications', 'Notifications', (g, on) => {
      g.append(sv('rect', { x: 36, y: 68, width: 228, height: 44, rx: 10, class: 'pp-card' }));
      g.append(glyph('notifications', 46, 78, 22));
      g.append(sv('rect', { x: 78, y: 80, width: 110, height: 6, rx: 3, class: 'pp-line' }), sv('rect', { x: 78, y: 93, width: 150, height: 5, rx: 2.5, class: 'pp-line pp-line2' }));
      g.append(sv('text', { x: 254, y: 86, 'text-anchor': 'end', class: 'pp-plabel' }, on ? 'on' : 'off'));
    }));
    // home screen apps, 4 × 3
    APPS.forEach((k, i) => {
      const c = i % 4, r = Math.floor(i / 4);
      const x = 42 + c * 58, y = 134 + r * 80;
      phone.append(part(k, APP_NAME[k], (g) => {
        g.append(sv('rect', { x: x - 4, y: y - 4, width: 52, height: 70, class: 'pp-hit' }));
        g.append(sv('rect', { x, y, width: 44, height: 44, rx: 12, class: 'pp-app' }));
        g.append(glyph(k, x + 10, y + 10, 24));
      }, [x + 22, y + 58]));
    });
    // fingerprint
    phone.append(part('biometrics', 'Biometrics', (g) => {
      g.append(sv('circle', { cx: 150, cy: 440, r: 26, class: 'pp-fp' }));
      g.append(glyph('biometrics', 136, 426, 28));
    }, [150, 482]));
    // vibration motor, drawn as buzz marks either side
    phone.append(part('vibrate', 'Vibration', (g) => {
      g.append(sv('rect', { x: 2, y: 380, width: 30, height: 90, class: 'pp-hit' }));
      g.append(sv('path', { d: 'M6 395 l6 6 -6 6 6 6 -6 6 6 6 -6 6 6 6 -6 6', class: 'pp-buzz' }));
    }, [30, 438, 'start']));
    // microphone hole
    phone.append(part('microphone', 'Microphone', (g) => {
      g.append(sv('rect', { x: 120, y: 540, width: 60, height: 50, class: 'pp-hit' }));
      g.append(glyph('microphone', 139, 540, 22), sv('circle', { cx: 150, cy: 580, r: 2.6, class: 'pp-hole' }));
    }, [150, 574 - 42]));
    // a line where the chosen service type would sit
    if (focusKey) { phone.querySelector(`[data-k="${focusKey}"]`)?.focus(); focusKey = null; }
  }

  // ---------------- lanes drawing ----------------
  let drag = null;
  function lanesDraw() {
    lanes.replaceChildren();
    const v = res?.view;
    const W = Math.max(300, lanes.clientWidth || 700);
    const narrow = W < 620;
    const LBL = narrow ? 0 : 250, R = 14, T = 40;
    const rows = v ? [...v.perms.map((p) => ({ p, st: 'in' })), ...v.above.map((p) => ({ p, st: 'above' })),
      ...[...new Map(v.below.map((p) => [p.name, p])).values()].filter((p) => !v.perms.some((q) => q.name === p.name)).map((p) => ({ p, st: 'below' }))] : [];
    const RH = narrow ? 44 : 30;
    const H = T + Math.max(1, rows.length) * RH + 12;
    lanes.setAttribute('viewBox', `0 0 ${W} ${H}`); lanes.setAttribute('height', H);
    const x0 = LBL + 6, cw = (W - x0 - R) / (API_HI - API_LO + 1);
    const X = (a) => x0 + (a - API_LO) * cw;
    // API header
    for (let a = API_LO; a <= API_HI; a++) {
      lanes.append(sv('line', { x1: X(a), x2: X(a), y1: T - 4, y2: H - 8, class: 'pp-col' }));
      if (!narrow || a % 2 === 1) {
        lanes.append(sv('text', { x: X(a) + cw / 2, y: 14, 'text-anchor': 'middle', class: 'pp-api' }, String(a)));
        lanes.append(sv('text', { x: X(a) + cw / 2, y: 27, 'text-anchor': 'middle', class: 'pp-ver' }, VERSION[a]));
      }
    }
    if (!v) return;
    const lo = clamp(v.lo, API_LO, API_HI), hi = clamp(v.hi, API_LO, API_HI);
    // the window
    lanes.append(sv('rect', { x: X(lo), y: T - 6, width: X(hi + 1) - X(lo), height: H - T - 2, class: 'pp-window' }));
    // rows
    rows.forEach(({ p, st }, i) => {
      const y = T + i * RH;
      const lit = hot && p.feats.some((f) => hot.has(f));
      const g = sv('g', { class: `pp-lane pp-${st}${lit ? ' pp-lit' : ''}`, tabindex: '0', 'aria-label': `${p.name}, ${p.type}, ${st === 'in' ? 'written' : st === 'above' ? 'only above targetSdk: left out' : 'only below minSdk: not written'}` });
      g.dataset.feats = JSON.stringify(p.feats);
      g.append(sv('rect', { x: 0, y, width: W, height: RH, class: 'pp-lanebg' }));
      const short = p.name.replace('android.permission.', '').replace('com.google.android.gms.permission.', 'gms.');
      const by = narrow ? y + 26 : y + 8, bh = 14;
      g.append(sv('text', { x: 6, y: narrow ? y + 16 : y + 19, class: 'pp-pname' }, short));
      const featTxt = p.feats.join(', ').slice(0, 30);
      if (!narrow && short.length * 7.4 + featTxt.length * 5.6 + 16 < LBL) g.append(sv('text', { x: LBL, y: y + 19, 'text-anchor': 'end', class: 'pp-feat' }, featTxt));
      const a1 = Math.max(p.min ?? API_LO, API_LO), a2 = Math.min(p.max ?? API_HI, API_HI);
      // full range faint, the part inside the window solid
      g.append(sv('rect', { x: X(a1) + 1, y: by, width: X(a2 + 1) - X(a1) - 2, height: bh, rx: 3, class: `pp-bar-all pp-k-${p.type}` }));
      const i1 = Math.max(a1, lo), i2 = Math.min(a2, hi);
      if (st === 'in' && i2 >= i1) g.append(sv('rect', { x: X(i1) + 1, y: by, width: X(i2 + 1) - X(i1) - 2, height: bh, rx: 3, class: `pp-bar-in pp-k-${p.type}` }));
      const tag = st === 'above' ? `API ${p.min}+ · above targetSdk, left out` : st === 'below' ? `≤ ${p.max} · below minSdk, not written`
        : p.max ? `maxSdkVersion="${p.max}"` : p.min ? `API ${p.min}+` : '';
      if (tag && narrow && short.length * 7.4 + tag.length * 6.3 + 12 > W - R) { /* no room: the lane's title and the bar say it */ }
      else if (tag && narrow) g.append(sv('text', { x: W - R, y: y + 16, 'text-anchor': 'end', class: 'pp-tag' }, tag.replace(' · above targetSdk, left out', ' · left out').replace(' · below minSdk, not written', ' · not written')));
      else if (tag) {
        const rightRoom = W - R - X(a2 + 1);
        const tx = rightRoom > 150 ? X(a2 + 1) + 5 : X(a1) - 5;
        const anchor = rightRoom > 150 ? 'start' : 'end';
        if (anchor === 'start' || X(a1) - x0 > 120) g.append(sv('text', { x: tx, y: by + 11, 'text-anchor': anchor, class: 'pp-tag' }, tag));
        else g.append(sv('text', { x: X(a1) + 6, y: by + 11, class: 'pp-tag pp-tag-in' }, tag));
      }
      if (p.note || p.attrs) g.append(sv('title', {}, [p.attrs, p.note].filter(Boolean).join(' - ')));
      const on = () => setHot(new Set(p.feats), 'lanes');
      g.addEventListener('mouseenter', on); g.addEventListener('focus', on);
      g.addEventListener('mouseleave', () => setHot(null, 'lanes')); g.addEventListener('blur', () => setHot(null, 'lanes'));
      lanes.append(g);
    });
    if (!rows.length) lanes.append(sv('text', { x: x0 + 8, y: T + 20, class: 'pp-empty' }, v.android ? 'No Android permission lines for these features.' : 'Android is off: only iOS keys below.'));
    // window edges
    const edge = (key, a, x) => {
      const g = sv('g', { class: 'pp-edge', tabindex: '0', role: 'slider', 'aria-label': key, 'aria-valuenow': String(a), 'aria-valuemin': String(API_LO), 'aria-valuemax': String(API_HI), 'data-key': key });
      g.append(sv('line', { x1: x, x2: x, y1: T - 8, y2: H - 6 }), sv('rect', { x: x - 7, y: T - 16, width: 14, height: 18, rx: 3, class: 'pp-grip' }),
        sv('text', { x, y: T - 3, 'text-anchor': 'middle', class: 'pp-grip-t' }, key === 'minSdk' ? 'min' : 'tgt'),
        sv('rect', { x: x - 10, y: T - 16, width: 20, height: H - T + 10, class: 'pp-hit' }));
      g.addEventListener('keydown', (e) => {
        const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
        if (!d) return;
        e.preventDefault(); focusEdge = key;
        ctx.set(key, String(clamp(a + d, API_LO, API_HI)));
      });
      return g;
    };
    lanes.append(edge('minSdk', v.lo, X(lo)), edge('targetSdk', v.hi, X(hi + 1)));
    lanes._X = { x0, cw };
    if (focusEdge) { lanes.querySelector(`[data-key="${focusEdge}"]`)?.focus(); focusEdge = null; }
  }
  let focusEdge = null;
  lanes.style.touchAction = 'none';
  lanes.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.pp-edge'); if (!g) return;
    e.preventDefault(); lanes.setPointerCapture(e.pointerId); drag = g.dataset.key; lanes.classList.add('pp-dragging');
  });
  lanes.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = lanes.getBoundingClientRect();
    const x = (e.clientX - r.left) * (lanes.viewBox.baseVal.width / r.width);
    const { x0, cw } = lanes._X;
    const raw = ctx.input;
    let a = drag === 'minSdk' ? Math.round((x - x0) / cw) + API_LO : Math.round((x - x0) / cw) + API_LO - 1;
    a = clamp(a, API_LO, API_HI);
    if (drag === 'minSdk') a = Math.min(a, raw.targetSdk ?? API_HI); else a = Math.max(a, raw.minSdk ?? API_LO);
    if (String(a) !== String(ctx.raw[drag])) ctx.set(drag, String(a));
  });
  const end = () => { drag = null; lanes.classList.remove('pp-dragging'); };
  lanes.addEventListener('pointerup', end); lanes.addEventListener('pointercancel', end);

  // ---------------- iOS ----------------
  function iosDraw() {
    const v = res?.view;
    iosPanel.hidden = !v || !v.ios;
    iosList.replaceChildren();
    if (!v) return;
    for (const k of v.iosKeys) {
      const lit = hot && k.feats.some((f) => hot.has(f));
      iosList.append(h('div', { class: `pp-irow${lit ? ' pp-lit' : ''}`, tabindex: '0',
        onmouseenter: () => setHot(new Set(k.feats), 'ios'), onmouseleave: () => setHot(null, 'ios'),
        onfocus: () => setHot(new Set(k.feats), 'ios'), onblur: () => setHot(null, 'ios') },
      h('code', { class: 'pp-ikey' }, k.key), h('span', { class: 'pp-iwhy' }, `“$(PRODUCT_NAME) uses this to ${k.why}.”`), h('span', { class: 'pp-feat' }, k.feats.join(', '))));
    }
    if (v.modes.length) iosList.append(h('div', { class: 'pp-irow' }, h('code', { class: 'pp-ikey' }, 'UIBackgroundModes'), h('span', { class: 'pp-iwhy' }, v.modes.join(', ')), h('span', { class: 'pp-feat' }, 'background')));
    if (!v.iosKeys.length && !v.modes.length) iosList.append(h('div', { class: 'pp-sub' }, 'No Info.plist keys needed for these features.'));
  }

  // ---------------- hover link ----------------
  function setHot(set, from) {
    hot = set;
    // redraw the other views cheaply by toggling classes
    for (const g of phone.querySelectorAll('.pp-part')) {
      const f = res?.view?.features?.[g.dataset.k];
      g.classList.toggle('pp-lit', !!(hot && f && hot.has(f.label)));
    }
    if (from !== 'lanes') lanesDraw();
    else for (const g of lanes.querySelectorAll('.pp-lane')) g.classList.toggle('pp-lit', !!(hot && JSON.parse(g.dataset.feats).some((f) => hot.has(f))));
    if (from !== 'ios') iosDraw();
  }

  // ---------------- sync ----------------
  const syncField = (el, key) => { if (document.activeElement !== el) el.value = ctx.raw[key] ?? ''; };
  function sync() {
    syncField(fMin, 'minSdk'); syncField(fTgt, 'targetSdk');
    if (document.activeElement !== fgsSel) fgsSel.value = ctx.raw.fgsType || 'dataSync';
    fgsRow.hidden = !ctx.input.fgs;
    for (const b of platSeg.children) b.setAttribute('aria-pressed', String(b.dataset.v === ctx.raw.platform));
    counts.replaceChildren(...(res?.values || []).map((x) => h('span', { class: `pp-count${x.tone ? ' pp-' + x.tone : ''}`, title: x.hint || '' }, h('b', {}, String(x.value)), ` ${x.label.replace(/^(\w)(\w*)/, (m, a, b) => (a + b === 'iOS' || a + b === 'Android' ? m : a.toLowerCase() + b))}`, x.hint && /special/.test(x.hint) ? h('small', {}, ` ${x.hint}`) : null)));
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Notes (${(res?.notes || []).length})`), ...(res?.notes || []).map((n) => h('p', {}, n)));
    lanesPanel.hidden = res?.view && !res.view.android;
  }
  ctx.onResult((r) => { res = r; sync(); phoneDraw(); lanesDraw(); iosDraw(); });
  let lw = 0;
  new ResizeObserver(() => { const w = lanes.clientWidth; if (w && w !== lw) { lw = w; lanesDraw(); } }).observe(root);
}
