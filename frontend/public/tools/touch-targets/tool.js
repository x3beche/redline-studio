// Touch target checker: each target's size (and the gap to its nearest
// neighbour) against the platform minimums.
//   Material Design 3 (Accessibility, "Touch targets"): at least 48 × 48 dp,
//     targets 8 dp or more apart.
//   Apple Human Interface Guidelines (Accessibility, "Buttons and controls"): at least 44 × 44 pt.
//   WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA: at least 24 × 24 CSS px, or
//     spaced so a 24 px circle centred on each undersized target touches no other
//     target or circle. Checked here conservatively as: smaller side + gap >= 24.
//   WCAG 2.2 SC 2.5.5 Target Size (Enhanced), level AAA: at least 44 × 44 CSS px.
// dp, iOS pt and CSS px are treated as the same unit (1/160 in nominal).
import { fmtNum } from '../kit/eng.js';

const RULES = {
  material: { name: 'Material 48 dp', min: 48, gap: 8 },
  apple: { name: 'Apple HIG 44 pt', min: 44, gap: 0 },
  wcagAA: { name: 'WCAG 2.5.8 AA (24 px)', min: 24, gap: 0, spacing: true },
  wcagAAA: { name: 'WCAG 2.5.5 AAA (44 px)', min: 44, gap: 0 },
};
const n = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : null; };

function check(rule, w, h, gap) {
  const s = Math.min(w, h);
  if (s >= rule.min) {
    if (rule.gap && gap != null && gap < rule.gap) return { ok: false, why: `gap ${fmtNum(gap, 3)} < ${rule.gap}` };
    return { ok: true, why: 'size' };
  }
  if (rule.spacing && gap != null && s + gap >= 24) return { ok: true, why: 'spacing exception' };
  return { ok: false, why: `${fmtNum(s, 3)} < ${rule.min}` };
}

export function run({ guideline, unit, density, targets }) {
  const rule = RULES[guideline] || RULES.material;
  const scale = unit === 'px' ? (density > 0 ? density : null) : 1;
  if (scale == null) return { warnings: ['Give the screen scale (devicePixelRatio), e.g. 3 for xxhdpi or @3x.'] };
  const u = unit === 'pt' ? 'pt' : unit === 'css' ? 'px' : 'dp';
  const warnings = [], rows = [], skipped = [];
  const list = Array.isArray(targets) ? targets : [];
  if (!list.length) return { warnings: ['Add the targets to check: a name, width, height and the gap to the nearest other target.'] };
  const res = [];
  list.forEach((t, i) => {
    const name = String(t.name || '').trim() || `Target ${i + 1}`;
    let w = n(t.w), h = n(t.h), g = n(t.gap);
    if (w == null || h == null || w <= 0 || h <= 0) { skipped.push(name); return; }
    w /= scale; h /= scale; if (g != null) g = Math.max(0, g / scale);
    const main = check(rule, w, h, g);
    const all = Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, check(r, w, h, g)]));
    const padX = Math.max(0, (rule.min - w) / 2), padY = Math.max(0, (rule.min - h) / 2);
    let fix = '';
    if (!main.ok) {
      const side = padX && padY && Math.abs(padX - padY) < 0.01 ? `${fmtNum(padX, 3)} ${u} on every side`
        : [padX ? `${fmtNum(padX, 3)} ${u} left and right` : '', padY ? `${fmtNum(padY, 3)} ${u} top and bottom` : ''].filter(Boolean).join(', ');
      if (padX || padY) fix = `add ${side} of touch area`;
      else fix = `move it ${fmtNum(rule.gap - (g ?? 0), 3)} ${u} further from its neighbour`;
      // The padding eats into the gap (the neighbour assumed unchanged).
      const left = g == null ? null : g - Math.max(padX, padY);
      if ((padX || padY) && left != null && left < rule.gap) fix += left < 0
        ? `; that would overlap its neighbour by ${fmtNum(-left, 3)} ${u}: move them ${fmtNum(rule.gap - left, 3)} ${u} further apart`
        : `; that leaves ${fmtNum(left, 3)} ${u} to its neighbour, under ${rule.gap}: move them ${fmtNum(rule.gap - left, 3)} ${u} further apart`;
    }
    res.push({ name, w, h, g, main, all });
    rows.push([name, `${fmtNum(w, 4)} × ${fmtNum(h, 4)}`, g == null ? '–' : fmtNum(g, 4), main.ok ? (main.why === 'spacing exception' ? 'pass (spacing)' : 'pass') : 'FAIL',
      Object.values(all).map((c) => (c.ok ? '✓' : '✗')).join(' '), fix || '–']);
  });
  if (skipped.length) warnings.push(`Skipped (no valid width and height): ${skipped.join(', ')}.`);
  if (!res.length) return { warnings: [...warnings, 'No target has a valid size.'] };
  const fails = res.filter((r) => !r.main.ok);
  const smallest = res.reduce((a, b) => (Math.min(b.w, b.h) < Math.min(a.w, a.h) ? b : a));
  if (res.some((r) => r.g == null)) warnings.push('Some targets have no gap: spacing rules (Material 8 dp, WCAG spacing exception) were not applied to them.');
  if (fails.length) warnings.push(`${fails.length} of ${res.length} target(s) are under ${rule.name}: ${fails.map((f) => f.name).join(', ')}. Grow the touch area with padding - the icon can stay small.`);
  return {
    values: [
      { label: 'Pass', value: `${res.length - fails.length} / ${res.length}`, tone: fails.length ? 'bad' : 'ok', hint: rule.name },
      { label: 'Minimum', value: rule.min, unit: u, hint: rule.gap ? `and ${rule.gap} ${u} apart` : rule.spacing ? 'or spaced to 24 px circles' : '' },
      { label: 'Smallest target', value: `${smallest.name}`, hint: `${fmtNum(smallest.w, 4)} × ${fmtNum(smallest.h, 4)} ${u}`, tone: Math.min(smallest.w, smallest.h) >= rule.min ? 'ok' : 'warn' },
    ],
    warnings,
    charts: [{ title: `Smaller side of each target (${u}) against the ${rule.min} ${u} minimum`, type: 'bars', x: res.map((r) => r.name),
      series: [{ name: 'Smaller side', y: res.map((r) => Math.round(Math.min(r.w, r.h) * 100) / 100) }, { name: 'Minimum', y: res.map(() => rule.min) }] }],
    tables: [{ title: `Targets against ${rule.name}`, columns: ['Target', `Size (${u})`, `Gap (${u})`, 'Result', 'Material · Apple · AA · AAA', 'Fix'], rows }],
    notes: [
      'dp, iOS points and CSS px are treated as the same size. With device pixels, the sizes are divided by the scale (devicePixelRatio).',
      'The touch area counts, not the drawn icon: a 24 dp icon with 12 dp padding on each side is a 48 dp target.',
      'WCAG 2.5.8 spacing exception checked as smaller side + gap >= 24 px, which is safe when the neighbour is as small or smaller. Inline links in text, and controls whose size the browser sets, are exempt from 2.5.8.',
      'Material also asks for 8 dp between targets; Apple and WCAG AAA give no fixed gap.',
      'Gap is one number per target: the fix assumes the padding grows toward that nearest neighbour, which is the worst case.',
    ],
  };
}
