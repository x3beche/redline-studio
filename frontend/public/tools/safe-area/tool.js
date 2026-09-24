// Safe Area Overlay: the status bar, notch / Dynamic Island / punch-hole,
// home indicator and navigation bar areas of a phone screen, as insets in
// points (dp) and pixels, and the safe rectangle left for content.
// iOS insets are UIKit's safeAreaInsets per device and orientation (Apple HIG
// "Layout" and device specifications; values as reported by the Simulator).
// Android values are typical: the real ones come from WindowInsets at run time
// (status bar 24 dp without a cutout, taller with one; gesture navigation
// about 24 dp, three-button navigation 48 dp - Android "Display content
// edge-to-edge" and the AOSP defaults).
import { fmtNum } from '../kit/eng.js';

// w, h: portrait size in pt/dp (Android: panel pixels / scale); s: scale; top/bottom: portrait insets; land: [left/right, bottom] in landscape;
// cut: cutout kind and size (pt/dp); r: display corner radius (pt/dp, approximate).
const DEVICES = {
  'iphone-se': { name: 'iPhone SE (2nd/3rd gen)', os: 'ios', w: 375, h: 667, s: 2, top: 20, bottom: 0, land: [0, 0], landTop: 0, cut: null, r: 0 },
  'iphone-8plus': { name: 'iPhone 8 Plus', os: 'ios', w: 414, h: 736, s: 3, top: 20, bottom: 0, land: [0, 0], landTop: 0, cut: null, r: 0 },
  'iphone-11pro': { name: 'iPhone X / XS / 11 Pro', os: 'ios', w: 375, h: 812, s: 3, top: 44, bottom: 34, land: [44, 21], cut: { kind: 'notch', w: 209, h: 30 }, r: 39 },
  'iphone-11': { name: 'iPhone XR / 11', os: 'ios', w: 414, h: 896, s: 2, top: 48, bottom: 34, land: [48, 21], cut: { kind: 'notch', w: 230, h: 33 }, r: 41 },
  'iphone-13mini': { name: 'iPhone 12 mini / 13 mini', os: 'ios', w: 375, h: 812, s: 3, top: 50, bottom: 34, land: [50, 21], cut: { kind: 'notch', w: 180, h: 34 }, r: 44 },
  'iphone-14': { name: 'iPhone 12 / 13 / 14', os: 'ios', w: 390, h: 844, s: 3, top: 47, bottom: 34, land: [47, 21], cut: { kind: 'notch', w: 162, h: 33 }, r: 47 },
  'iphone-14plus': { name: 'iPhone 12/13 Pro Max, 14 Plus', os: 'ios', w: 428, h: 926, s: 3, top: 47, bottom: 34, land: [47, 21], cut: { kind: 'notch', w: 162, h: 33 }, r: 53 },
  'iphone-15': { name: 'iPhone 14 Pro / 15 / 15 Pro / 16', os: 'ios', w: 393, h: 852, s: 3, top: 59, bottom: 34, land: [59, 21], cut: { kind: 'island', w: 125, h: 37, y: 11 }, r: 55 },
  'iphone-15max': { name: 'iPhone 14/15 Pro Max, 15/16 Plus', os: 'ios', w: 430, h: 932, s: 3, top: 59, bottom: 34, land: [59, 21], cut: { kind: 'island', w: 125, h: 37, y: 11 }, r: 55 },
  'iphone-16pro': { name: 'iPhone 16 Pro', os: 'ios', w: 402, h: 874, s: 3, top: 62, bottom: 34, land: [62, 21], cut: { kind: 'island', w: 125, h: 37, y: 14 }, r: 62 },
  'iphone-16promax': { name: 'iPhone 16 Pro Max', os: 'ios', w: 440, h: 956, s: 3, top: 62, bottom: 34, land: [62, 21], cut: { kind: 'island', w: 125, h: 37, y: 14 }, r: 62 },
  'ipad-11': { name: 'iPad Pro 11" / iPad Air', os: 'ios', w: 834, h: 1194, s: 2, top: 24, bottom: 20, land: [0, 20], landTop: 24, cut: null, r: 18 },
  'pixel-7': { name: 'Pixel 7 / 8', os: 'android', w: 1080 / 2.625, h: 2400 / 2.625, s: 2.625, top: 45, cut: { kind: 'punch', w: 24, h: 24, y: 10 }, r: 32 },
  'pixel-8pro': { name: 'Pixel 8 Pro', os: 'android', w: 1344 / 3, h: 2992 / 3, s: 3, top: 45, cut: { kind: 'punch', w: 24, h: 24, y: 10 }, r: 36 },
  'galaxy-s23': { name: 'Galaxy S23 / S24', os: 'android', w: 1080 / 3, h: 2340 / 3, s: 3, top: 38, cut: { kind: 'punch', w: 20, h: 20, y: 9 }, r: 30 },
  'galaxy-s24u': { name: 'Galaxy S24 Ultra', os: 'android', w: 1440 / 3.75, h: 3120 / 3.75, s: 3.75, top: 38, cut: { kind: 'punch', w: 20, h: 20, y: 9 }, r: 12 },
  'android-plain': { name: 'Android, no cutout', os: 'android', w: 1080 / 3, h: 2400 / 3, s: 3, top: 24, cut: null, r: 0 },
};

export function run({ device, orientation, androidNav, cw, ch, cs, ctop, cbottom, cleft, cright, ccut }) {
  const warnings = [], notes = [];
  let d;
  if (device === 'custom') {
    if (!(cw > 0 && ch > 0 && cs > 0)) return { warnings: ['Give the custom screen width and height in pt/dp and its scale (e.g. 390, 844, 3).'] };
    const ins = [ctop, cbottom, cleft, cright].map((v) => (Number.isFinite(v) && v >= 0 ? v : 0));
    if ([ctop, cbottom, cleft, cright].some((v) => v != null && v < 0)) warnings.push('Negative insets were set to 0.');
    d = { name: 'Custom', os: 'custom', w: cw, h: ch, s: cs, top: ins[0], bottom: ins[1], left: ins[2], right: ins[3], r: 0,
      cut: ccut === 'none' ? null : ccut === 'island' ? { kind: 'island', w: 125, h: 37, y: 11 } : ccut === 'notch' ? { kind: 'notch', w: 162, h: 33 } : { kind: 'punch', w: 24, h: 24, y: 10 } };
  } else d = DEVICES[device] || DEVICES['iphone-15'];
  const land = orientation === 'landscape';
  const unit = d.os === 'android' ? 'dp' : 'pt';
  let W = d.w, H = d.h, top, bottom, left, right, status, nav = null, homeInd = null, cut = null;

  if (d.os === 'ios') {
    if (!land) { top = d.top; bottom = d.bottom; left = right = 0; }
    else { W = d.h; H = d.w; top = d.landTop ?? 0; left = right = d.land[0]; bottom = d.land[1]; }
    status = land ? (d.landTop ?? 0) : (d.cut ? d.top : 20);
    if (d.bottom > 0 || d.land[1] > 0) homeInd = { w: land ? 220 : 134, h: 5, gap: 8 };
  } else if (d.os === 'android') {
    const navH = androidNav === 'buttons' ? 48 : 24;
    if (!land) { top = d.top; bottom = navH; left = right = 0; nav = { side: 'bottom', size: navH, kind: androidNav }; }
    else {
      W = d.h; H = d.w; top = 24; // the status bar stays in landscape; the cutout moves to a side
      left = d.cut ? d.top : 0; right = 0; bottom = 0;
      if (androidNav === 'buttons') { right = 48; nav = { side: 'right', size: 48, kind: androidNav }; } else { bottom = navH; nav = { side: 'bottom', size: navH, kind: androidNav }; }
    }
    status = land ? 24 : d.top;
    notes.push('Android insets vary by maker, Android version and settings: read WindowInsets (Compose: WindowInsets.safeDrawing) rather than hard-coding these.');
  } else {
    top = d.top; bottom = d.bottom; left = d.left; right = d.right; status = d.top;
    if (land) { W = d.h; H = d.w; }
  }
  if (d.cut) {
    const c = d.cut;
    // cutout drawn at the top centre (portrait) or the left centre (landscape, rotated left)
    cut = land ? { kind: c.kind, x: c.y ?? 0, y: (H - c.w) / 2, w: c.h, h: c.w } : { kind: c.kind, x: (W - c.w) / 2, y: c.y ?? 0, w: c.w, h: c.h };
  }
  const safeW = W - left - right, safeH = H - top - bottom;
  if (!(safeW > 0 && safeH > 0)) return { warnings: ['The insets are larger than the screen: check the custom values.'] };
  const lost = 100 * (1 - (safeW * safeH) / (W * H));
  const px = (v) => Math.round(v * d.s * 100) / 100;
  const f = (v) => fmtNum(v, 4);

  const css = [
    '<!-- let the page draw under the bars, then pad it back -->',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '',
    '.app {',
    '  padding-top: env(safe-area-inset-top);        /* ' + f(top) + ' px here */',
    '  padding-right: env(safe-area-inset-right);    /* ' + f(right) + ' px */',
    '  padding-bottom: env(safe-area-inset-bottom);  /* ' + f(bottom) + ' px */',
    '  padding-left: env(safe-area-inset-left);      /* ' + f(left) + ' px */',
    '}',
  ].join('\n');
  const nativeCode = d.os === 'android' ? [
    '// Jetpack Compose (edge-to-edge is on by default when targeting API 35)',
    'Scaffold(contentWindowInsets = WindowInsets.safeDrawing) { padding ->',
    '    Content(Modifier.padding(padding))',
    '}',
    '',
    '// Views',
    'ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->',
    '    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())',
    '    v.updatePadding(bars.left, bars.top, bars.right, bars.bottom)',
    '    insets',
    '}',
  ].join('\n') : [
    '// SwiftUI: views stay inside the safe area by default; backgrounds may extend',
    'Color.blue.ignoresSafeArea()',
    'content.safeAreaPadding(.horizontal, 16)   // iOS 17+',
    '',
    '// UIKit: pin to view.safeAreaLayoutGuide, or read view.safeAreaInsets',
    `// here: top ${f(top)}, left ${f(left)}, bottom ${f(bottom)}, right ${f(right)} pt`,
  ].join('\n');

  if (lost > 12) notes.push(`${fmtNum(lost, 3)} % of the screen is outside the safe area: keep text and controls in the safe rectangle; let backgrounds and images run to the edges.`);
  if (homeInd) notes.push('The bottom inset on iPhones with no Home button is the home indicator: nothing tappable there; a swipe up from it leaves the app.');
  notes.push('Rounded display corners are drawn approximately; the safe area already keeps content clear of them.');
  return {
    values: [
      { label: 'Screen', value: `${f(W)} × ${f(H)}`, unit, hint: `${f(px(W))} × ${f(px(H))} px at ×${f(d.s)}` },
      { label: 'Safe area', value: `${f(safeW)} × ${f(safeH)}`, unit, hint: `origin (${f(left)}, ${f(top)})` },
      { label: 'Top inset', value: top, unit, hint: `${f(px(top))} px${cut && !land ? ` · ${cut.kind === 'island' ? 'Dynamic Island' : cut.kind === 'notch' ? 'notch' : 'camera hole'}` : ''}` },
      { label: 'Bottom inset', value: bottom, unit, hint: `${f(px(bottom))} px${homeInd && bottom ? ' · home indicator' : nav && nav.side === 'bottom' ? ` · ${nav.kind === 'buttons' ? '3-button' : 'gesture'} nav` : ''}` },
      { label: 'Left / right', value: `${f(left)} / ${f(right)}`, unit, hint: `${f(px(left))} / ${f(px(right))} px` },
      { label: 'Outside safe area', value: `${fmtNum(lost, 3)} %` },
    ],
    warnings, notes,
    tables: [{ title: `${d.name}, ${land ? 'landscape' : 'portrait'}`, columns: ['Edge', `Inset (${unit})`, 'Inset (px)', 'What is there'], rows: [
      ['Top', f(top), f(px(top)), top ? (cut && !land ? `status bar + ${cut.kind === 'island' ? 'Dynamic Island' : cut.kind === 'notch' ? 'notch' : 'camera hole'}` : 'status bar') : '–'],
      ['Bottom', f(bottom), f(px(bottom)), bottom ? (homeInd ? 'home indicator' : nav ? `${nav.kind === 'buttons' ? 'three-button' : 'gesture'} navigation bar` : 'system bar') : '–'],
      ['Left', f(left), f(px(left)), left ? (cut ? 'sensor housing / cutout side' : 'system bar') : '–'],
      ['Right', f(right), f(px(right)), right ? (nav && nav.side === 'right' ? 'navigation buttons' : 'mirrors the left for symmetry') : '–'],
    ] }],
    texts: [{ title: 'CSS', body: css + '\n', lang: 'css' }, { title: d.os === 'android' ? 'Android' : 'iOS', body: nativeCode + '\n' }],
    drawing: { W, H, scale: d.s, unit, top, bottom, left, right, status, cut, homeInd, nav, r: d.r || 0, land, name: d.name },
  };
}
