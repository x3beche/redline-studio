// Numbers the way an engineer writes them, for every kit tool.
// Pure: no DOM, so a tool's run() can use it in the browser and in Node.

const PREFIX = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** `4k7`, `4.7k`, `2M2`, `100n`, `3.3V`, `1e-3` -> number; null when it does not read. */
export function parseEng(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const t = String(text ?? '').trim().replace(/\s+/g, '').replace(',', '.')
    .replace(/(ohms?|Ω|V|A|W|Hz|F|H|s|m²|mm|°C)$/i, (u) => (/^m/.test(u) && u.length === 1 ? u : ''));
  if (!t) return null;
  const mid = /^(\d+)([pnuµmkKMG])(\d+)$/.exec(t);
  if (mid) return Number(`${mid[1]}.${mid[3]}`) * PREFIX[mid[2]];
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([pnuµmkKMG]?)$/i.exec(t);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] ? PREFIX[m[2]] : 1);
  return Number.isFinite(v) ? v : null;
}

const STEPS = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];

/** Significant figures, without a trailing `.000`. */
export function fmtNum(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  return String(Number(Number(v).toPrecision(digits)));
}

/** 4700, 'Ω' -> '4.7 kΩ'. */
export function fmtEng(v, unit = '', digits = 3) {
  if (v == null || !Number.isFinite(v)) return '–';
  if (v === 0) return `0 ${unit}`.trim();
  const a = Math.abs(v);
  const [scale, p] = STEPS.find(([s]) => a >= s * 0.9995) || STEPS[STEPS.length - 1];
  return `${fmtNum(v / scale, digits)} ${p}${unit}`.trim();
}

export const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
export const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
  3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
export const E96 = Array.from({ length: 96 }, (_, i) => Math.round(100 * Math.pow(10, i / 96)) / 100);
export const SERIES = { E12, E24, E96 };

/** The standard value nearest v, or the next one up/down. */
export function standard(v, series = E24, side = 'near') {
  if (!(v > 0)) return null;
  const all = [];
  for (let d = 1e-12; d < 1e10; d *= 10) for (const s of series) all.push(Number((s * d).toPrecision(3)));
  if (side === 'up') return all.find((x) => x >= v * 0.9999) ?? null;
  if (side === 'down') return [...all].reverse().find((x) => x <= v * 1.0001) ?? null;
  return all.reduce((b, x) => (Math.abs(Math.log(x / v)) < Math.abs(Math.log(b / v)) ? x : b), all[0]);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
