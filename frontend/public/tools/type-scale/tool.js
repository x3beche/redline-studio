// Modular type scale: size(n) = base x ratio^n (Tim Brown, "More Meaningful
// Typography", A List Apart 2011; the classic musical-interval ratios).
// Fluid mode interpolates each step between a small-screen and a large-screen
// scale with clamp(), the Utopia method (utopia.fyi):
//   slope = (maxSize - minSize) / (maxVw - minVw)
//   size  = clamp(minSize, minSize - slope * minVw + slope * 100vw, maxSize)
// Line heights: 1.5 for body text (WCAG 1.4.12 text spacing), tighter for
// headings, rounded to a 4 px baseline grid (rule of thumb).
import { fmtNum } from '../kit/eng.js';

const RATIOS = {
  '1.067': 'Minor second', '1.125': 'Major second', '1.2': 'Minor third', '1.25': 'Major third',
  '1.333': 'Perfect fourth', '1.414': 'Augmented fourth', '1.5': 'Perfect fifth', '1.618': 'Golden ratio',
};
const TSHIRT = ['3xs', '2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl'];

const r4 = (v) => Number(v.toFixed(4));
const px = (v) => `${fmtNum(v, 4)}px`;

export function run({ base, ratio, custom, up, down, unit, naming, prefix, fluid, baseMax, ratioMax, customMax, vwMin, vwMax, rounding }) {
  const warnings = [];
  const notes = [];
  const rq = ratio === 'custom' ? custom : Number(ratio);
  if (!(base > 0)) return { warnings: ['Give the body (base) size in px, e.g. 16.'] };
  if (!(rq > 1) || rq > 3) return { warnings: ['The ratio must be above 1 and at most 3 (1.2-1.333 suits most interfaces).'] };
  const nUp = Math.max(0, Math.min(10, Math.round(Number.isFinite(up) ? up : 5)));
  const nDown = Math.max(0, Math.min(3, Math.round(Number.isFinite(down) ? down : 2)));
  if (up > 10 || down > 3) warnings.push('At most 10 steps up and 3 down are made.');
  const rem = 16;                                           // 1rem at the browser default
  const pre = String(prefix || 'step').trim().replace(/^-+/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'step';

  let rMax = rq, bMax = base;
  if (fluid) {
    rMax = ratioMax === 'same' ? rq : ratioMax === 'custom' ? customMax : Number(ratioMax);
    bMax = baseMax;
    if (!(bMax > 0)) return { warnings: ['Give the base size at the large viewport in px.'] };
    if (!(rMax > 1) || rMax > 3) return { warnings: ['The large-screen ratio must be above 1 and at most 3.'] };
    if (!(vwMin > 0) || !(vwMax > vwMin)) return { warnings: ['The viewport range needs a minimum above 0 and a maximum above it (e.g. 360 and 1280 px).'] };
  }
  const round = (v) => (rounding ? Math.round(v) : v);

  const steps = [];
  for (let n = nUp; n >= -nDown; n--) {
    const min = round(base * rq ** n);
    const max = round(bMax * rMax ** n);
    let name;
    if (naming === 'tshirt') name = TSHIRT[4 + n] || `step-${n}`;
    else if (naming === 'headings') {
      const k = Math.min(nUp, 6) - n + 1;                 // h1 on the top step (at most step 6)
      name = n > 0 ? (k >= 1 && k <= 6 ? `h${k}` : `display-${1 - k}`) : n === 0 ? 'body' : n === -1 ? 'small' : `small-${-n}`;
    }
    else name = n < 0 ? `-${-n}` : String(n);
    // Headings: 1.2 x size rounded up to a 4 px grid (at the small size); body and smaller: 1.5.
    const lh = n > 0 ? Math.max(1.1, (Math.ceil((min * 1.2) / 4) * 4) / min) : 1.5;
    steps.push({ n, name, min, max, lh });
  }

  const cssVal = (s) => {
    if (!fluid || Math.abs(s.max - s.min) < 1e-9) return unit === 'px' ? px(s.min) : `${r4(s.min / rem)}rem`;
    const slope = (s.max - s.min) / (vwMax - vwMin);
    const icpt = s.min - slope * vwMin;
    const lo = Math.min(s.min, s.max), hi = Math.max(s.min, s.max);
    return unit === 'px'
      ? `clamp(${px(lo)}, ${px(icpt)} + ${r4(slope * 100)}vw, ${px(hi)})`
      : `clamp(${r4(lo / rem)}rem, ${r4(icpt / rem)}rem + ${r4(slope * 100)}vw, ${r4(hi / rem)}rem)`;
  };
  const varName = (s) => `--${pre}-${s.name}`;
  const css = [':root {', ...steps.map((s) => `  ${varName(s)}: ${cssVal(s)};`), '}', ''];
  // Map headings and body to the scale.
  const at = (n) => steps.find((s) => s.n === n);
  const rules = [];
  // h1 on the top step, one step down per level, never below the body size.
  for (let h = 1; h <= 6; h++) { const s = at(Math.max(0, Math.min(nUp, 6) - (h - 1))); if (s) rules.push(`h${h} { font-size: var(${varName(s)}); line-height: ${r4(s.lh)}; }`); }
  if (at(0)) rules.push(`body { font-size: var(${varName(at(0))}); line-height: ${r4(at(0).lh)}; }`);
  if (at(-1)) rules.push(`small { font-size: var(${varName(at(-1))}); }`);
  css.push(...rules, '');

  const minSize = Math.min(...steps.map((s) => Math.min(s.min, s.max)));
  if (base < 16 || (fluid && bMax < 16)) warnings.push('Body text below 16 px is hard to read on phones; most systems use 16 px (1rem) as the body size.');
  if (minSize < 12) warnings.push(`The smallest step is ${fmtNum(minSize, 3)} px: below 12 px is too small for text people must read. Use fewer steps down or a smaller ratio.`);
  if (rq > 1.5 && nUp > 5) warnings.push(`Ratio ${rq} with ${nUp} steps reaches ${fmtNum(base * rq ** nUp, 4)} px: large ratios suit few steps (display pages); interfaces want 1.125-1.333.`);
  if (fluid && Math.max(...steps.map((s) => s.max / s.min)) > 2.5) warnings.push('Some step grows more than 2.5x between the viewports: text zoom may not reach 200 % (WCAG 1.4.4). Keep the two scales closer.');

  const values = [
    { label: 'Ratio', value: fmtNum(rq, 4), hint: RATIOS[String(rq)] || 'custom' },
    { label: 'Largest step', value: fmtNum(steps[0].min, 4), unit: 'px', hint: fluid ? `→ ${fmtNum(steps[0].max, 4)} px at ${fmtNum(vwMax, 4)} px` : `${r4(steps[0].min / rem)} rem` },
    { label: 'Smallest step', value: fmtNum(steps[steps.length - 1].min, 4), unit: 'px' },
    { label: 'Steps', value: steps.length },
  ];
  notes.push(`rem values assume the browser default 1rem = ${rem} px; rem keeps the scale growing with the user's font setting.`,
    'Line heights: body and small text 1.5 (WCAG text spacing); headings about 1.2, rounded up to a 4 px grid.',
    'Android uses sp and iOS pt in the same numbers as px here (at 1x); the scale carries over as is.');
  if (rounding) notes.push('Sizes are rounded to whole pixels, so the ratio between steps is only approximate.');
  if (fluid) notes.push(`Fluid: each size moves linearly from the small scale at ${fmtNum(vwMin, 4)} px wide to the large one at ${fmtNum(vwMax, 4)} px, then stops.`);

  return {
    values,
    warnings,
    tables: [{
      title: 'Scale',
      columns: fluid ? ['Step', 'Name', `px at ${fmtNum(vwMin, 4)}`, `px at ${fmtNum(vwMax, 4)}`, 'Line height', 'CSS'] : ['Step', 'Name', 'px', 'rem', 'Line height'],
      rows: steps.map((s) => (fluid
        ? [s.n, varName(s), fmtNum(s.min, 4), fmtNum(s.max, 4), fmtNum(s.lh, 3), cssVal(s)]
        : [s.n, varName(s), fmtNum(s.min, 4), fmtNum(s.min / rem, 4), fmtNum(s.lh, 3)])),
    }],
    charts: [{ title: 'Sizes (px)', type: 'bars', x: steps.slice().reverse().map((s) => s.name),
      series: fluid ? [{ name: `${fmtNum(vwMin, 4)} px wide`, y: steps.slice().reverse().map((s) => s.min) }, { name: `${fmtNum(vwMax, 4)} px wide`, y: steps.slice().reverse().map((s) => s.max) }]
        : [{ name: 'size', y: steps.slice().reverse().map((s) => s.min) }] }],
    texts: [{ title: 'CSS', body: css.join('\n'), lang: 'css' }],
    notes,
  };
}
