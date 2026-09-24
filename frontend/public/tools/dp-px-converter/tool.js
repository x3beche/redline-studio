// DP / PX / DPI converter for Android, iOS and the web.
//   px = dp × dpi / 160            Android "Support different pixel densities":
//                                  1 dp is one pixel on a 160 dpi (mdpi) screen
//   sp = dp × font scale            Android: sp scale with the user's font size setting
//   iOS: px = pt × scale (@1x, @2x, @3x)   Apple HIG "Images", scale factors
//   web: device px = CSS px × devicePixelRatio; on Android devicePixelRatio = dpi/160
//   physical: 1 dp = 1/160 in nominally (the bucket's dpi, not the panel's real ppi)
import { fmtNum } from '../kit/eng.js';

const BUCKETS = [
  { key: 'ldpi', dpi: 120 }, { key: 'mdpi', dpi: 160 }, { key: 'tvdpi', dpi: 213 }, { key: 'hdpi', dpi: 240 },
  { key: 'xhdpi', dpi: 320 }, { key: 'xxhdpi', dpi: 480 }, { key: 'xxxhdpi', dpi: 640 },
];
// Logical densities Android devices actually report (DisplayMetrics.densityDpi constants).
const LOGICAL = [120, 140, 160, 180, 200, 213, 220, 240, 260, 280, 300, 320, 340, 360, 400, 420, 440, 450, 480, 520, 560, 600, 640];
const r2 = (v) => Math.round(v * 100) / 100;

export function run({ value, unit, density, customDpi, screenW, screenH, diagonal, fontScale }) {
  const warnings = [], notes = [];
  if (value == null || !Number.isFinite(value)) return { warnings: ['Give a size, e.g. 48.'] };
  if (value < 0) return { warnings: ['A size cannot be negative.'] };
  const fs = fontScale > 0 ? fontScale : 1;
  if (!(fontScale > 0)) warnings.push('Font scale must be above 0; using 1.0.');
  else if (fontScale < 0.85 || fontScale > 2) warnings.push(`Font scale ${fontScale} is outside Android's 0.85-2.0 range.`);

  let dpi, dpiNote = '', physPpi = null;
  if (density === 'custom') {
    dpi = customDpi;
    if (!(dpi > 0)) return { warnings: ['Give the custom density in dpi, e.g. 420.'] };
  } else if (density === 'device') {
    if (!(screenW > 0 && screenH > 0 && diagonal > 0)) return { warnings: ['Give the screen width and height in pixels and the diagonal in inches, e.g. 1080 × 2400, 6.3 in.'] };
    physPpi = Math.hypot(screenW, screenH) / diagonal; // ppi = diagonal pixels / diagonal inches
    dpi = LOGICAL.reduce((b, x) => (Math.abs(x - physPpi) < Math.abs(b - physPpi) ? x : b), LOGICAL[0]);
    dpiNote = `panel ${fmtNum(physPpi, 4)} ppi; nearest logical density ${dpi}`;
    if (physPpi < 90 || physPpi > 800) warnings.push(`${fmtNum(physPpi, 3)} ppi is not a phone or tablet: check the diagonal (inches) and the pixel size.`);
  } else {
    const b = BUCKETS.find((x) => x.key === density) || BUCKETS[5];
    dpi = b.dpi;
  }
  const scale = dpi / 160;

  // everything to dp first
  const toDp = {
    dp: value, sp: value * fs, px: value / scale, pt: value, css: value, in: value * 160, mm: (value / 25.4) * 160,
  };
  const dp = toDp[unit];
  if (dp == null) return { warnings: [`Unknown unit "${unit}".`] };
  const px = dp * scale;
  const inch = dp / 160;

  const values = [
    { label: 'Density-independent', value: r2(dp), unit: 'dp', hint: 'also iOS pt and CSS px' },
    { label: `Pixels at ${dpi} dpi`, value: r2(px), unit: 'px', hint: `scale ×${fmtNum(scale, 4)}${dpiNote ? ' · ' + dpiNote : ''}`, tone: Number.isInteger(r2(px)) ? undefined : 'warn' },
    { label: 'As text size', value: r2(dp / fs), unit: 'sp', hint: `font scale ${fs}` },
    { label: 'Physical size', value: `${fmtNum(inch * 25.4, 3)} mm`, hint: `${fmtNum(inch, 3)} in, nominal` },
  ];
  if (density === 'device') {
    const wDp = (Math.min(screenW, screenH) / scale), hDp = (Math.max(screenW, screenH) / scale);
    // Material 3 window size classes by width: compact < 600 dp, medium < 840 dp, expanded >= 840 dp
    const cls = (w) => (w < 600 ? 'compact' : w < 840 ? 'medium' : 'expanded');
    values.push({ label: 'Screen in dp', value: `${Math.round(wDp)} × ${Math.round(hDp)}`, unit: 'dp', hint: `width class: ${cls(wDp)} (portrait), ${cls(hDp)} (landscape)` });
    values.push({ label: 'Panel density', value: Math.round(physPpi), unit: 'ppi', hint: `devicePixelRatio ≈ ${fmtNum(scale, 4)}` });
  }
  if (unit === 'px' && !Number.isInteger(value)) warnings.push('A pixel size is normally whole; check the value.');

  const rows = BUCKETS.map((b) => {
    const p = dp * (b.dpi / 160);
    return [b.key, b.dpi, `×${fmtNum(b.dpi / 160, 4)}`, r2(p), Math.round(p), b.key === 'tvdpi' ? 'rarely used (TVs)' : `drawable-${b.key}`];
  });
  const ios = [1, 2, 3].map((s) => [`@${s}x`, r2(dp * s), Math.round(dp * s), s === 1 ? 'iPads before Retina (no longer needed)' : s === 2 ? 'iPhone SE, iPhone 11/XR, iPads' : 'iPhone X and later (most phones)']);
  // Asset export: Android ships mdpi..xxxhdpi (ldpi and tvdpi are scaled by the system);
  // iOS ships @2x and @3x; the web 1x/2x/3x for srcset.
  const exportRows = [
    ...['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'].map((k) => { const b = BUCKETS.find((x) => x.key === k); const p = dp * b.dpi / 160; return [`Android drawable-${k}`, `×${fmtNum(b.dpi / 160, 3)}`, `${Math.round(p)} × ${Math.round(p)} px`, Number.isInteger(r2(p)) ? '' : `exact ${r2(p)} px`]; }),
    ...[2, 3].map((s) => [`iOS @${s}x`, `×${s}`, `${Math.round(dp * s)} × ${Math.round(dp * s)} px`, Number.isInteger(r2(dp * s)) ? '' : `exact ${r2(dp * s)} px`]),
    ...[1, 2, 3].map((s) => [`Web ${s}x (srcset)`, `×${s}`, `${Math.round(dp * s)} × ${Math.round(dp * s)} px`, '']),
  ];
  const frac = BUCKETS.filter((b) => ['hdpi', 'xxhdpi'].includes(b.key)).filter((b) => !Number.isInteger(r2(dp * b.dpi / 160)));
  if (frac.length && ['dp', 'pt', 'css'].includes(unit)) warnings.push(`${fmtNum(dp, 4)} dp is not a whole number of pixels at ${frac.map((b) => b.key).join(' and ')} (×1.5, ×3 scales): exported assets will be blurred or rounded. Use a size divisible by 2 (${Math.round(dp / 2) * 2 || 2} dp), or better by 4 for the 4 dp grid.`);
  else if (dp > 0 && Number.isInteger(r2(dp)) && r2(dp) % 4 !== 0 && ['dp', 'pt', 'css'].includes(unit)) notes.push(`${r2(dp)} dp is off the 4 dp baseline grid Material and the HIG layouts use (nearest ${Math.round(dp / 4) * 4} dp).`);
  if (dp > 0 && dp < 48 && ['dp', 'pt', 'css'].includes(unit)) notes.push(`If this is a touch target: Material asks for at least 48 × 48 dp, Apple for 44 × 44 pt.`);
  notes.push('iOS points and CSS pixels are treated as equal to dp: design tools and mobile browsers use them that way (devicePixelRatio = dpi/160 on Android). Physically an iPhone point is about 1/153-1/163 in.');
  if (unit === 'sp') notes.push('sp follow the user\'s font size linearly here; Android 14 and later scale large text (over about 20 sp) less than linearly, up to 200 %.');
  notes.push('Physical size uses the density bucket (1 dp = 1/160 in); on a real panel it differs by the ratio of its ppi to the logical density.');
  return {
    values, warnings, notes,
    tables: [
      { title: `${fmtNum(dp, 4)} dp in every Android density`, columns: ['Bucket', 'dpi', 'Scale', 'px', 'Rounded', 'Resource folder'], rows },
      { title: `${fmtNum(dp, 4)} pt on iOS`, columns: ['Scale', 'px', 'Rounded', 'Devices'], rows: ios },
      { title: `Asset sizes to export for a ${fmtNum(dp, 4)} × ${fmtNum(dp, 4)} dp image`, columns: ['Target', 'Scale', 'Size', 'Note'], rows: exportRows },
    ],
  };
}
