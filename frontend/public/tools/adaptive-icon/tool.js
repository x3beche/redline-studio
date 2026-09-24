// Adaptive Icon Composer: an Android adaptive launcher icon from a background
// and a foreground layer, checked against the geometry in Android Developers
// "Adaptive icons": both layers 108 × 108 dp; the launcher masks the central
// 72 × 72 dp (circle, squircle, rounded square, teardrop...); keep the logo inside
// the 66 dp safe-zone circle; the outer 18 dp per side is for parallax and pulse.
// Mask outlines are the AOSP config_icon_mask paths (100 × 100 units over the 72 dp view).
// Contrast: the WCAG 2.2 ratio between the two layer colours (a legibility guide).
import { fmtNum } from '../kit/eng.js';

const BUCKETS = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];
const parseHex = (t) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(t || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return { hex: '#' + h.toLowerCase(), r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
};
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function run({ bg, bgStyle, bg2, fgKind, glyph, fg, size, shape }) {
  const warnings = [], notes = [];
  const B = parseHex(bg), F = parseHex(fg), B2 = parseHex(bg2);
  if (!B) return { warnings: [`Background "${bg}" is not a hex colour: write it like #1f4ed8.`] };
  if (fgKind !== 'image' && !F) return { warnings: [`Foreground "${fg}" is not a hex colour: write it like #ffffff.`] };
  if (bgStyle === 'gradient' && !B2) warnings.push(`Second background colour "${bg2}" is not a hex colour; using a solid background.`);
  const grad = bgStyle === 'gradient' && B2;
  let sz = size;
  if (!(sz > 0)) return { warnings: ['Give the logo size in dp, e.g. 48 (the canvas is 108 dp).'] };
  if (sz > 108) { warnings.push('The logo is larger than the whole 108 dp layer; drawn at 108 dp.'); sz = 108; }
  const text = String(glyph ?? '').trim().slice(0, 3);
  if (fgKind === 'text' && !text) warnings.push('Type one to three characters for the logo, e.g. R.');
  // How far the logo reaches from the centre: a square (text box, image) reaches
  // its corners at size/2 × √2; a round logo reaches size/2.
  const round = shape === 'round';
  const reach = round ? sz / 2 : (sz / 2) * Math.SQRT2;
  const safeR = 33, viewHalf = 36;
  const fits = reach <= safeR + 1e-9;
  const maxSize = round ? 2 * safeR : (2 * safeR) / Math.SQRT2;
  if (!fits) warnings.push(`The logo reaches ${fmtNum(reach, 3)} dp from the centre, past the 33 dp safe zone: a circle mask will cut its ${round ? 'edge' : 'corners'}. Keep a ${round ? 'round' : 'square'} logo at ${fmtNum(maxSize, 3)} dp or less.`);
  if (reach > viewHalf * Math.SQRT2) warnings.push('Part of the logo is outside the 72 dp visible area on every mask shape.');
  if (sz < 30) notes.push(`At ${fmtNum(sz, 3)} dp the logo fills only ${fmtNum((sz / 72) * 100, 2)} % of the visible icon; most launcher icons use 44-60 dp.`);
  const cr = fgKind !== 'image' && F ? ratio(F, B) : null;
  const crWorst = cr != null && grad ? Math.min(cr, ratio(F, B2)) : cr;
  if (crWorst != null && crWorst < 3) warnings.push(`Logo and background contrast is ${fmtNum(crWorst, 3)}:1: under 3:1 the logo is hard to see on small icons. Darken or lighten one of them.`);

  // SVG sources (108 × 108 viewBox = dp), for export or a VectorDrawable import
  const bgFill = grad ? 'url(#g)' : B.hex;
  const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="432" height="432">\n${grad ? `  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${B.hex}"/><stop offset="1" stop-color="${B2.hex}"/></linearGradient></defs>\n` : ''}  <rect width="108" height="108" fill="${bgFill}"/>\n</svg>\n`;
  const fgSvg = fgKind === 'image' ? '' : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="432" height="432">\n${fgKind === 'text'
    ? `  <text x="54" y="54" font-family="Roboto, Arial, sans-serif" font-weight="700" font-size="${fmtNum(sz * 1.05, 4)}" fill="${F.hex}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>`
    : fgKind === 'circle' ? `  <circle cx="54" cy="54" r="${fmtNum(sz / 2, 4)}" fill="${F.hex}"/>`
      : `  <rect x="${fmtNum(54 - sz / 2, 4)}" y="${fmtNum(54 - sz / 2, 4)}" width="${fmtNum(sz, 4)}" height="${fmtNum(sz, 4)}" rx="${fmtNum(sz * 0.18, 3)}" fill="${F.hex}"/>`}\n</svg>\n`;
  const xml = [
    '<!-- res/mipmap-anydpi-v26/ic_launcher.xml (and ic_launcher_round.xml, the same) -->',
    '<?xml version="1.0" encoding="utf-8"?>',
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
    `    <background android:drawable="${grad ? '@drawable/ic_launcher_background' : '@color/ic_launcher_background'}" />`,
    '    <foreground android:drawable="@drawable/ic_launcher_foreground" />',
    '    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />  <!-- themed icons, Android 13+ -->',
    '</adaptive-icon>',
    '',
    ...(grad ? [] : ['<!-- res/values/ic_launcher_background.xml -->', '<resources>', `    <color name="ic_launcher_background">${B.hex.toUpperCase()}</color>`, '</resources>']),
  ].join('\n') + '\n';

  const rows = BUCKETS.map(([k, sc]) => [`mipmap-${k}`, `${108 * sc} × ${108 * sc}`, `${fmtNum(66 * sc, 4)}`, `${72 * sc} × ${72 * sc}`, `${48 * sc} × ${48 * sc}`]);
  notes.push('Put the foreground and background as vector drawables (from the SVGs, via Android Studio > Vector Asset) or as PNGs at the sizes in the table; the monochrome layer is the foreground in one colour, for Android 13 themed icons.');
  if (fgKind === 'text') notes.push('VectorDrawable has no text: convert the letters to outlines (paths) in a design tool before importing the foreground SVG, or export PNGs.');
  notes.push('Legacy launchers (API < 26) use a flat ic_launcher.png at 48 dp; Google Play needs a 512 × 512 px icon without a mask.');
  return {
    values: [
      { label: 'Logo reach from centre', value: fmtNum(reach, 3), unit: 'dp', hint: 'safe zone 33 dp', tone: fits ? 'ok' : 'bad' },
      { label: `Largest ${round ? 'round' : 'square'} logo`, value: fmtNum(maxSize, 3), unit: 'dp', hint: 'that fits the 66 dp circle' },
      { label: 'Logo in the visible icon', value: `${fmtNum(Math.min(100, (sz / 72) * 100), 3)} %`, hint: 'of the 72 dp view' },
      { label: 'Contrast', value: crWorst == null ? '–' : `${fmtNum(crWorst, 3)}:1`, tone: crWorst == null ? undefined : crWorst >= 3 ? 'ok' : 'warn', hint: 'logo against background' },
    ],
    warnings, notes,
    tables: [{ title: 'Layer sizes to export', columns: ['Folder', 'Each layer (px)', 'Safe circle Ø (px)', 'Visible (px)', 'Legacy icon (px)'], rows: [...rows, ['Google Play', '–', '–', '–', '512 × 512']] }],
    texts: [
      { title: 'ic_launcher.xml', body: xml, lang: 'xml' },
      { title: 'Background SVG', body: bgSvg, lang: 'svg' },
      ...(fgSvg ? [{ title: 'Foreground SVG', body: fgSvg, lang: 'svg' }] : []),
    ],
    drawing: { bg: B.hex, bg2: grad ? B2.hex : null, fg: F ? F.hex : null, kind: fgKind, text, size: sz, safeR, view: 72, canvas: 108, fits },
  };
}
