// Layered box-shadow and border-radius.
// Layering after Josh W. Comeau, "Designing Beautiful Shadows in CSS" (2021):
// several shadows whose offsets double from one to the next read as soft,
// natural light. Here layer i of n (i = 0 … n-1):
//   f_i      = 2^i / 2^(n-1)                    (the largest layer is f = 1)
//   offset_i = distance * f_i, split by the direction angle (CSS angle: 0deg up,
//              90deg right, 180deg down) -> x = sin(a) * offset, y = -cos(a) * offset
//   blur_i   = 2 * softness * offset_i
//   spread_i = spread * f_i
//   alpha_i  = 1 - (1 - opacity)^(1/n)          so where all n overlap the
//              darkness adds up to the chosen opacity.
// Nested corners: inner radius = outer radius - padding (concentric corners,
// the same rule Apple's HIG uses for nested rounded rectangles).
import { fmtNum } from '../kit/eng.js';

const r2 = (v) => Math.round(v * 100) / 100 || 0;
const pxs = (v) => (r2(v) === 0 ? '0' : `${r2(v)}px`);

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}

// '#123', '#112233', 'rgb(1,2,3)', 'rgb(1 2 3)', 'hsl(220 40% 10%)', '1,2,3' -> [r,g,b] or null
export function parseColor(text) {
  const t = String(text || '').trim().toLowerCase();
  let m = /^#?([0-9a-f]{3})$/.exec(t);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = /^#?([0-9a-f]{6})$/.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^(?:rgba?\()?\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/][^)]*)?\)?$/.exec(t);
  if (m) { const c = m.slice(1, 4).map(Number); return c.every((x) => x <= 255) ? c : null; }
  m = /^hsla?\(\s*(-?\d+(?:\.\d+)?)(?:deg)?[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%\s*(?:[,/][^)]*)?\)$/.exec(t);
  if (m) return hslToRgb(((Number(m[1]) % 360) + 360) % 360, Math.min(100, Number(m[2])), Math.min(100, Number(m[3])));
  return null;
}

function layers({ distance, n, angle, softness, spread, alpha, rgb, inset }) {
  const a = (angle * Math.PI) / 180;
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 1 : 2 ** i / 2 ** (n - 1);
    const off = distance * f;
    out.push({ x: r2(Math.sin(a) * off), y: r2(-Math.cos(a) * off), blur: r2(2 * softness * off), spread: r2(spread * f), alpha: Math.round(alpha * 1000) / 1000 });
  }
  const color = (l) => `rgb(${rgb.join(' ')} / ${l.alpha})`;
  const css = out.map((l) => `${inset ? 'inset ' : ''}${pxs(l.x)} ${pxs(l.y)} ${pxs(l.blur)}${l.spread ? ` ${pxs(l.spread)}` : ''} ${color(l)}`).join(', ');
  return { list: out, css };
}

export function run({ distance, layers: nIn, angle, softness, spread, opacity, color, radius, padding, inset }) {
  const warnings = [];
  const n = Math.round(Number.isFinite(nIn) ? nIn : 5);
  if (!(n >= 1 && n <= 8)) return { warnings: ['Use 1 to 8 layers (4-6 look natural).'] };
  if (!(distance >= 0)) return { warnings: ['Give the shadow distance in px (0 or more), e.g. 12.'] };
  if (!(opacity > 0 && opacity <= 1)) return { warnings: ['Opacity is the total darkness from 0 to 1, e.g. 0.2.'] };
  const soft = softness >= 0 ? softness : 1;
  const sp = Number.isFinite(spread) ? spread : 0;
  const ang = Number.isFinite(angle) ? angle : 180;
  let rgb = parseColor(color);
  if (!rgb) { warnings.push(`Colour "${color}" is not read; use #0b1a2e, rgb(11 26 46) or hsl(215 60% 11%). Black is used.`); rgb = [0, 0, 0]; }
  const rad = radius >= 0 ? radius : 0;
  const pad = padding >= 0 ? padding : 0;
  const alpha = 1 - (1 - opacity) ** (1 / n);
  const main = layers({ distance, n, angle: ang, softness: soft, spread: sp, alpha, rgb, inset });

  // How far the shadow reaches past the box on each side (for overflow and gaps).
  const reach = (sx, sy) => Math.max(0, ...main.list.map((l) => sx * l.x + sy * l.y + l.blur + l.spread));
  const ext = { top: reach(0, -1), right: reach(1, 0), bottom: reach(0, 1), left: reach(-1, 0) };
  const inner = Math.max(0, rad - pad);

  if (sp < 0 && -sp > distance) warnings.push(`A spread of ${sp} px pulls the shadow in further than it is offset (${distance} px): most of it hides under the box. Use a spread between -${distance} and 0.`);
  if (opacity > 0.5) warnings.push(`A total opacity of ${opacity} looks heavy on light backgrounds; 0.1-0.3 is usual. Dark themes need more, or a lighter surface instead of a shadow.`);
  if (rad > 0 && pad > 0 && rad < pad) warnings.push(`The outer radius (${rad} px) is smaller than the padding (${pad} px): an inner element can only be square (0 px) to stay concentric.`);
  if (/^(0|#0{3}|#0{6}|black)$/i.test(String(color).trim())) warnings.push('Pure black shadows look grey and dirty on coloured backgrounds; tint the shadow with the background hue (e.g. hsl(220 40% 10%)).');

  const scale = [0.25, 0.5, 1, 2, 4].map((k, i) => `  --shadow-${i + 1}: ${layers({ distance: distance * k, n: Math.max(1, Math.min(n, i + 2)), angle: ang, softness: soft, spread: sp * k, alpha: 1 - (1 - opacity) ** (1 / Math.max(1, Math.min(n, i + 2))), rgb, inset }).css};`);
  const line = `box-shadow: ${main.css}; border-radius: ${pxs(rad)};`;
  return {
    values: [
      { label: 'Layers', value: n, hint: `each ${fmtNum(alpha, 3)} opacity` },
      { label: 'Largest offset', value: fmtNum(distance, 4), unit: 'px', hint: `${fmtNum(ang, 4)}° (CSS angle)` },
      { label: 'Largest blur', value: fmtNum(main.list[n - 1].blur, 4), unit: 'px' },
      { label: 'Reaches below', value: fmtNum(ext.bottom, 4), unit: 'px', hint: `above ${fmtNum(ext.top, 3)}, sides ${fmtNum(Math.max(ext.left, ext.right), 3)}` },
      { label: 'Radius', value: fmtNum(rad, 4), unit: 'px' },
      { label: 'Inner radius', value: fmtNum(inner, 4), unit: 'px', hint: `at ${fmtNum(pad, 4)} px padding` },
    ],
    warnings,
    tables: [{ title: 'Layers', columns: ['#', 'x', 'y', 'blur', 'spread', 'alpha'], rows: main.list.map((l, i) => [i + 1, l.x, l.y, l.blur, l.spread, l.alpha]) }],
    texts: [
      { title: 'CSS', body: `${line}\n/* nested element inside ${pxs(pad)} of padding: */\nborder-radius: ${pxs(inner)};\n`, lang: 'css' },
      { title: 'Scale', body: `:root {\n${scale.join('\n')}\n}\n`, lang: 'css' },
    ],
    notes: [
      'Direction is a CSS angle: 180° drops the shadow straight down (light from above), 135° down-right.',
      `Keep at least ${fmtNum(Math.ceil(Math.max(ext.bottom, ext.left, ext.right, ext.top)), 4)} px free (or no overflow: hidden on a parent) so the shadow is not clipped.`,
      'The Scale output keeps these settings and steps the distance by 2x per level, for elevation tokens.',
    ],
    drawing: { shadow: main.css, radius: rad, inner, padding: pad, angle: ang, distance },
  };
}
