// Icon & favicon set from one source image: which files, at what size, with
// how much padding, plus the HTML <link> tags, the web-manifest icon entries,
// the Android/iOS resource lists and an ImageMagick 7 script that makes them.
//
// Sources for the sizes and safe zones:
//   Web: Evil Martians, "How to Favicon in 2024" (favicon.ico 32 px, icon.svg,
//        apple-touch-icon 180 px, manifest 192 + 512 + a 512 maskable).
//   Maskable: W3C Web App Manifest, "purpose: maskable" - the safe zone is a
//        centred circle of radius 40 % of the icon (diameter 80 %).
//   Android: developer.android.com "Adaptive icons" - 108 dp layers, the
//        inner 72 dp is visible, keep the logo in the centred 66 dp circle;
//        legacy launcher 48 dp at mdpi..xxxhdpi (1x, 1.5x, 2x, 3x, 4x);
//        Play Store listing icon 512 px.
//   iOS: Apple HIG "App icons" - Xcode 14+ takes one 1024 px image and makes
//        the rest; older projects list every size. No transparency on iOS.
import { fmtNum } from '../kit/eng.js';

// The largest logo that fits a centred circle of diameter `d` (fraction of the icon).
// A w:h box fits when its half-diagonal <= d/2: side_w = d * w / sqrt(w^2 + h^2).
function fitInCircle(d, shape) {
  if (shape === 'circle') return { w: d, h: d };
  const [w, h] = shape === 'wide' ? [2, 1] : shape === 'tall' ? [1, 2] : [1, 1];
  const k = d / Math.hypot(w, h);
  return { w: k * w, h: k * h };
}
function fitInSquare(frac, shape) {
  if (shape === 'wide') return { w: frac, h: frac / 2 };
  if (shape === 'tall') return { w: frac / 2, h: frac };
  return { w: frac, h: frac };
}

const DENS = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];
const IOS_FULL = [
  // [points, scales, idiom, role]
  [20, [2, 3], 'iphone', 'Notification'], [29, [2, 3], 'iphone', 'Settings'], [40, [2, 3], 'iphone', 'Spotlight'], [60, [2, 3], 'iphone', 'App'],
  [20, [1, 2], 'ipad', 'Notification'], [29, [1, 2], 'ipad', 'Settings'], [40, [1, 2], 'ipad', 'Spotlight'], [76, [1, 2], 'ipad', 'App'], [83.5, [2], 'ipad', 'App (iPad Pro)'],
  [1024, [1], 'ios-marketing', 'App Store'],
];

const hexOk = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(c || '').trim());
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

export function run(input) {
  const { source, sourceSize, name, shortName, theme, background, shape, web, android, ios, iosSet, prefix } = input;
  const warnings = [];
  const src = String(source || '').trim() || 'logo.svg';
  const isSvg = /\.svg$/i.test(src);
  const bg = hexOk(background) ? background.trim() : '#ffffff';
  const th = hexOk(theme) ? theme.trim() : bg;
  if (background && !hexOk(background)) warnings.push(`Background "${background}" is not a #rgb or #rrggbb colour; using ${bg}.`);
  if (theme && !hexOk(theme)) warnings.push(`Theme colour "${theme}" is not a #rgb or #rrggbb colour; using ${th}.`);
  let pre = String(prefix ?? '/').trim() || '/';
  if (!pre.endsWith('/')) pre += '/';
  const sh = ['square', 'circle', 'wide', 'tall'].includes(shape) ? shape : 'square';
  if (!web && !android && !ios) return { warnings: ['Pick at least one platform: web, Android or iOS.'] };

  // files: {file, px, fit: {w,h} logo fraction, bg: 'none'|colour, platform, purpose, dir}
  const files = [];
  const full = fitInSquare(1, sh);
  const add = (f) => files.push(f);
  if (web) {
    add({ file: 'favicon.ico', px: 32, multi: [16, 32, 48], fit: full, bg: 'none', platform: 'Web', purpose: 'Legacy browsers, /favicon.ico requests (16, 32, 48 inside)' });
    if (isSvg) add({ file: 'icon.svg', px: null, fit: full, bg: 'none', platform: 'Web', purpose: 'Modern browsers, scales to any size (copy of the source)' });
    add({ file: 'apple-touch-icon.png', px: 180, fit: fitInSquare(140 / 180, sh), bg, platform: 'Web', purpose: 'iOS/iPadOS home screen; opaque, 20 px margin' });
    add({ file: 'icon-192.png', px: 192, fit: full, bg: 'none', platform: 'Web', purpose: 'Manifest, "any" (Android home screen, install prompt)' });
    add({ file: 'icon-512.png', px: 512, fit: full, bg: 'none', platform: 'Web', purpose: 'Manifest, "any" (splash screen, install)' });
    add({ file: 'icon-mask.png', px: 512, fit: fitInCircle(0.8, sh), bg, platform: 'Web', purpose: 'Manifest, "maskable": logo inside the 80 % safe circle' });
  }
  if (android) {
    for (const [d, k] of DENS) add({ file: `mipmap-${d}/ic_launcher.png`, px: 48 * k, fit: fitInSquare(0.8, sh), bg: 'none', platform: 'Android', purpose: `Legacy launcher icon, 48 dp at ${k}x` });
    for (const [d, k] of DENS) add({ file: `mipmap-${d}/ic_launcher_foreground.png`, px: 108 * k, fit: fitInCircle(66 / 108, sh), bg: 'none', platform: 'Android', purpose: `Adaptive foreground, 108 dp at ${k}x; logo in the 66 dp circle` });
    add({ file: 'play-store-512.png', px: 512, fit: fitInSquare(0.8, sh), bg, platform: 'Android', purpose: 'Google Play listing, 32-bit PNG, no rounding (Play masks it)' });
  }
  if (ios) {
    if (iosSet === 'full') {
      for (const [pt, scales, idiom, role] of IOS_FULL) for (const k of scales) {
        const px = Math.round(pt * k);
        add({ file: `AppIcon.appiconset/icon-${pt}@${k}x.png`, px, fit: full, bg, platform: 'iOS', purpose: `${role}, ${idiom}, ${pt} pt @${k}x`, ios: { pt, k, idiom } });
      }
    } else {
      add({ file: 'AppIcon.appiconset/icon-1024.png', px: 1024, fit: full, bg, platform: 'iOS', purpose: 'Single-size app icon (Xcode 14+ derives the rest); opaque', ios: { pt: 1024, k: 1, idiom: 'universal' } });
    }
  }

  const biggest = Math.max(...files.map((f) => f.px || 0));
  const sz = sourceSize > 0 ? sourceSize : null;
  if (!isSvg) {
    if (!sz) warnings.push('Give the source image size in pixels (its width), e.g. 1024.');
    else if (sz < biggest) warnings.push(`The source is ${sz} px but the largest icon is ${biggest} px: it would be upscaled and blurry. Use an SVG or a ${biggest} px (better 1024 px) PNG.`);
    if (web) warnings.push('A raster source means no icon.svg: modern browsers would use the ICO. Export the logo as SVG if you can.');
  }
  if (ios) warnings.push('iOS rejects app icons with transparency: the iOS files are flattened onto the background colour.');

  // ImageMagick 7 commands. An SVG is rasterised at a density that gives the
  // target size directly (72 dpi * target / intrinsic width), so it stays sharp.
  const dens = (px) => (isSvg && sz ? ` -density ${Math.max(72, Math.ceil((72 * px * 1.0) / sz))}` : isSvg ? ' -density 600' : '');
  const lines = ['#!/bin/sh', '# ImageMagick 7 (magick). Run next to ' + src + '.', 'set -e', ''];
  const dirs = [...new Set(files.map((f) => f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/')) : null).filter(Boolean))];
  if (dirs.length) lines.push(`mkdir -p ${dirs.join(' ')}`, '');
  for (const f of files) {
    if (f.file === 'icon.svg') { lines.push(`cp ${q(src)} icon.svg`); continue; }
    if (f.file === 'favicon.ico') {
      lines.push(`magick -background none${dens(48)} ${q(src)} -resize 48x48 -gravity center -extent 48x48 -define icon:auto-resize=48,32,16 favicon.ico`);
      continue;
    }
    const lw = Math.round(f.px * f.fit.w), lh = Math.round(f.px * f.fit.h);
    const flat = f.bg !== 'none' ? ` -background ${q(f.bg)} -alpha remove -alpha off` : ''; // opaque: no alpha channel at all
    lines.push(`magick -background none${dens(Math.max(lw, lh))} ${q(src)} -resize ${lw}x${lh} -gravity center -background ${f.bg === 'none' ? 'none' : q(f.bg)} -extent ${f.px}x${f.px}${flat} ${q(f.file)}`);
  }

  const texts = [];
  if (web) {
    const head = [
      `<link rel="icon" href="${pre}favicon.ico" sizes="32x32">`,
      isSvg ? `<link rel="icon" href="${pre}icon.svg" type="image/svg+xml">` : null,
      `<link rel="apple-touch-icon" href="${pre}apple-touch-icon.png">`,
      `<link rel="manifest" href="${pre}manifest.webmanifest">`,
      `<meta name="theme-color" content="${th}">`,
    ].filter(Boolean).join('\n');
    texts.push({ title: 'HTML head', body: head, lang: 'html' });
    const manifest = {
      name: String(name || 'My App'),
      short_name: String(shortName || name || 'App').slice(0, 30),
      icons: [
        { src: `${pre}icon-192.png`, type: 'image/png', sizes: '192x192' },
        { src: `${pre}icon-512.png`, type: 'image/png', sizes: '512x512' },
        { src: `${pre}icon-mask.png`, type: 'image/png', sizes: '512x512', purpose: 'maskable' },
      ],
      theme_color: th,
      background_color: bg,
      display: 'standalone',
      start_url: '/',
    };
    texts.push({ title: 'manifest.webmanifest', body: JSON.stringify(manifest, null, 2), lang: 'json' });
    if (String(shortName || '').length > 12) warnings.push(`Short name "${shortName}" is ${String(shortName).length} characters; launchers cut it after about 12.`);
  }
  if (android) {
    texts.push({ title: 'Android adaptive XML', lang: 'xml', body: [
      '<!-- res/mipmap-anydpi-v26/ic_launcher.xml -->',
      '<?xml version="1.0" encoding="utf-8"?>',
      '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <background android:drawable="@color/ic_launcher_background"/>',
      '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>',
      '    <monochrome android:drawable="@mipmap/ic_launcher_foreground"/>',
      '</adaptive-icon>',
      '',
      '<!-- res/values/ic_launcher_background.xml -->',
      `<resources><color name="ic_launcher_background">${bg}</color></resources>`,
    ].join('\n') });
  }
  if (ios) {
    const images = files.filter((f) => f.ios).map((f) => (iosSet === 'full'
      ? { filename: f.file.split('/').pop(), idiom: f.ios.idiom, scale: `${f.ios.k}x`, size: `${f.ios.pt}x${f.ios.pt}` }
      : { filename: f.file.split('/').pop(), idiom: 'universal', platform: 'ios', size: '1024x1024' }));
    texts.push({ title: 'iOS Contents.json', lang: 'json', body: JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2) });
  }
  texts.push({ title: 'ImageMagick script', body: lines.join('\n') + '\n', lang: 'sh' });

  const pct = (v) => `${fmtNum(v * 100, 3)} %`;
  const rows = files.map((f) => [f.file, f.px ? `${f.px}×${f.px}` : 'vector', f.platform, f.px ? `${Math.round(f.px * f.fit.w)}×${Math.round(f.px * f.fit.h)} (${pct(f.fit.w)})` : '100 %', f.bg === 'none' ? 'transparent' : f.bg, f.purpose]);
  const mask = fitInCircle(0.8, sh), adapt = fitInCircle(66 / 108, sh);
  return {
    values: [
      { label: 'Files', value: files.length, hint: [web && 'web', android && 'Android', ios && 'iOS'].filter(Boolean).join(', ') },
      { label: 'Largest icon', value: `${biggest} px`, tone: !isSvg && sz && sz < biggest ? 'bad' : 'ok', hint: isSvg ? 'vector source' : `source ${sz ? sz + ' px' : '?'}` },
      { label: 'Maskable logo', value: pct(mask.w), hint: `of 512 px = ${Math.round(512 * mask.w)} px wide` },
      { label: 'Android adaptive logo', value: pct(adapt.w), hint: `of 108 dp = ${fmtNum(108 * adapt.w, 3)} dp wide` },
    ],
    tables: [{ title: 'Every file', columns: ['File', 'Size', 'Platform', 'Logo inside', 'Background', 'Purpose'], rows }],
    texts,
    warnings,
    notes: [
      'Logo sizes are the largest box of your logo\'s shape that fits the platform\'s safe zone: a centred circle of 80 % (maskable) or 66/108 (Android adaptive).',
      'Windows tiles (browserconfig.xml, mstile) are left out: only legacy Edge/IE used them.',
      'Check a maskable icon at maskable.app; check the favicon at 16 px, where thin strokes vanish.',
    ],
    // For the drawing and for agents.
    safe: { maskable: mask, adaptive: adapt, apple: fitInSquare(140 / 180, sh), shape: sh, background: bg, theme: th },
    files: files.map((f) => ({ file: f.file, px: f.px, logoW: f.px ? Math.round(f.px * f.fit.w) : null, logoH: f.px ? Math.round(f.px * f.fit.h) : null, background: f.bg, platform: f.platform })),
  };
}
