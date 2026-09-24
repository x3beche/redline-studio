/** Numbers the way an engineer writes them, shared by the calculators.
 *
 *  `4k7`, `4.7k`, `2M2`, `100n`, `3.3` and `1e-3` all read; a trailing
 *  unit (`Ω`, `V`, `A`, `ohm`) is let through, so a value copied out of a
 *  schematic reads as it is.
 */

const PREFIX: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9,
};

export function parseEng(text: string): number | null {
  const t = text.trim().replace(/\s+/g, '').replace(/(ohms?|Ω|V|A|W|Hz)$/i, '');
  if (!t) return null;
  // 4k7: the prefix stands where the decimal point would.
  const mid = /^(\d+)([pnuµmkKMG])(\d+)$/.exec(t);
  if (mid) return Number(`${mid[1]}.${mid[3]}`) * PREFIX[mid[2]];
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([pnuµmkKMG]?)$/i.exec(t);
  if (!m) return null;
  // `m` is milli and `M` mega, so the prefix is case-sensitive; only the
  // exponent's `e` was matched regardless of case.
  const v = Number(m[1]) * (m[2] ? PREFIX[m[2]] : 1);
  return Number.isFinite(v) ? v : null;
}

const STEPS: [number, string][] = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
];

/** `4700, 'Ω'` → `4.7 kΩ`: three significant figures, the prefix that
 *  keeps the number between 1 and 1000. */
export function fmtEng(v: number | null | undefined, unit = '', digits = 3): string {
  if (v == null || !Number.isFinite(v)) return '–';
  if (v === 0) return `0 ${unit}`.trim();
  const a = Math.abs(v);
  const [scale, p] = STEPS.find(([s]) => a >= s * 0.9995) ?? STEPS[STEPS.length - 1];
  return `${fmtNum(v / scale, digits)} ${p}${unit}`.trim();
}

/** Significant figures, without a trailing `.000`. */
export function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  return String(Number(v.toPrecision(digits)));
}

// The standard values a resistor is made in, one decade each.
export const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
export const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
                    3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
export const E96 = Array.from({ length: 96 }, (_, i) =>
  Math.round(100 * Math.pow(10, i / 96)) / 100);
export const SERIES: Record<string, number[]> = { E12, E24, E96 };

/** Every value of a series from 1 Ω to 10 MΩ, smallest first. */
export function valuesOf(series: number[], lo = 1, hi = 1e7): number[] {
  const out: number[] = [];
  for (let d = lo; d < hi; d *= 10) {
    for (const s of series) out.push(Math.round(s * d * 1000) / 1000);
  }
  out.push(hi);
  return out;
}

/** The standard value nearest `v` - or the next one up or down, when only
 *  one side is safe (a larger LED resistor passes less current). */
export function standard(v: number, series: number[],
                         side: 'near' | 'up' | 'down' = 'near'): number | null {
  if (!(v > 0)) return null;
  const all = valuesOf(series, 0.1, 1e8);
  if (side === 'up') return all.find(x => x >= v * 0.9999) ?? null;
  if (side === 'down') return [...all].reverse().find(x => x <= v * 1.0001) ?? null;
  return all.reduce((best, x) =>
    Math.abs(Math.log(x / v)) < Math.abs(Math.log(best / v)) ? x : best, all[0]);
}
