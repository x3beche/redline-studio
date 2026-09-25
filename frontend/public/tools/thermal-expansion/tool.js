// Linear thermal expansion of a part, and the gap change against a mating part.
//   ΔL = α · L · ΔT                        linear expansion (α mean over the range)
//   ΔA/A ≈ 2αΔT, ΔV/V ≈ 3αΔT               area and volume, small strains
//   Δgap = (α_housing − α_part) · L · ΔT   a part in a housing, clearance along L
//   σ = E · α · ΔT                         stress when fully restrained (1-D, elastic)
// α, E and Sy are typical room-temperature values (MatWeb / ASM Handbook).
import { fmtNum } from '../kit/eng.js';

// CTE ppm/K, E GPa, yield MPa (null: brittle / none)
export const MATS = {
  al: ['Aluminium 6061', 23.6, 68.9, 276],
  steel: ['Steel (carbon)', 12.0, 200, 235],
  ss: ['Stainless 304', 17.3, 193, 215],
  brass: ['Brass', 20.5, 97, 310],
  cu: ['Copper', 17.0, 115, 250],
  ti: ['Titanium Ti-6Al-4V', 8.6, 114, 880],
  zamak: ['Zinc die cast', 27.4, 96, 221],
  invar: ['Invar 36', 1.3, 141, 276],
  fr4: ['FR-4 (in plane)', 15, 22, null],
  fr4z: ['FR-4 (z axis, below Tg)', 60, 22, null],
  alumina: ['Alumina 96 %', 7.1, 300, null],
  si: ['Silicon', 2.6, 169, null],
  glass: ['Soda-lime glass', 9.0, 72, null],
  abs: ['ABS', 90, 2.3, 40],
  pc: ['Polycarbonate', 68, 2.35, 62],
  pa66: ['Nylon PA66', 80, 3.0, 82],
  pa66gf: ['PA66-GF30 (flow dir.)', 25, 9.5, null],
  pom: ['Acetal POM', 110, 3.1, 71],
  pmma: ['Acrylic PMMA', 70, 3.2, null],
  pla: ['PLA', 68, 3.5, null],
  petg: ['PETG', 68, 2.0, 48],
  peek: ['PEEK', 47, 3.6, 97],
  ptfe: ['PTFE', 125, 0.5, 10],
  hdpe: ['HDPE', 150, 1.0, 26],
};
const f = (v, d = 4) => fmtNum(v, d);

function mat(key, cte, E) {
  if (key === 'custom') return cte > 0 || cte === 0 ? ['Custom', cte, E > 0 ? E : null, null] : null;
  return MATS[key] || null;
}

export function run({ length, material, cte, emod, t1, t2, mate, gap }) {
  const warnings = [];
  if (!(length > 0)) return { warnings: ['Give the length (or diameter) in mm, e.g. 100.'] };
  if (t1 == null || t2 == null) return { warnings: ['Give both temperatures in °C.'] };
  const m = mat(material, cte, emod);
  if (!m) return { warnings: ['Give the custom CTE in ppm/K (µm per m per K), e.g. 23.'] };
  const [name, a, E, sy] = m;
  const dT = t2 - t1;
  const dL = a * 1e-6 * length * dT;
  const values = [
    { label: 'Length change ΔL', value: f(dL * 1000, 4), unit: 'µm', tone: 'ok', hint: `${f(dL, 4)} mm` },
    { label: 'Length at T2', value: f(length + dL, 7), unit: 'mm' },
    { label: 'Strain', value: f(a * dT, 4), unit: 'ppm', hint: `α ${f(a, 3)} ppm/K × ΔT ${f(dT, 4)} K` },
    { label: 'Area change', value: f(2 * a * dT * 1e-4, 3), unit: '%' },
    { label: 'Volume change', value: f(3 * a * dT * 1e-4, 3), unit: '%' },
  ];
  if (E) {
    const s = E * 1e3 * a * 1e-6 * Math.abs(dT); // MPa
    const over = sy != null && s > sy;
    values.push({ label: 'Stress if fully restrained', value: f(s, 3), unit: 'MPa', tone: over ? 'bad' : sy != null && s > 0.5 * sy ? 'warn' : undefined,
      hint: sy != null ? `yield ${f(sy, 3)} MPa` : 'brittle: no yield' });
    if (over) warnings.push(`Held rigidly at both ends, ${name} would reach ${f(s, 3)} MPa, past its ${f(sy, 3)} MPa yield: let it slide (slotted hole, floating mount) or shorten the fixed span.`);
  }
  const tables = [];
  const mm = mate && mate !== 'none' ? MATS[mate] : null;
  if (mm) {
    const [n2, a2] = mm;
    const dL2 = a2 * 1e-6 * length * dT;
    const dGap = dL2 - dL; // housing grows more than the part: the gap opens
    values.push(
      { label: `ΔL of ${n2}`, value: f(dL2 * 1000, 4), unit: 'µm' },
      { label: 'Relative movement', value: f(Math.abs(dGap) * 1000, 4), unit: 'µm', hint: `${f(Math.abs(a2 - a), 3)} ppm/K mismatch` },
    );
    if (gap != null && gap >= 0) {
      const g2 = gap + dGap;
      values.push({ label: 'Clearance at T2', value: f(g2, 4), unit: 'mm', tone: g2 < 0 ? 'bad' : g2 < 0.02 ? 'warn' : 'ok', hint: `${f(gap, 4)} mm at T1` });
      if (g2 < 0) warnings.push(`The ${f(gap, 3)} mm clearance closes and becomes ${f(-g2 * 1000, 3)} µm of interference at ${f(t2, 4)} °C: open the clearance to at least ${f(gap - g2 + 0.02, 3)} mm or choose materials with closer CTEs.`);
    }
    if (Math.abs(a2 - a) > 10 && Math.abs(dGap) > 0.05) warnings.push(`${name} and ${n2} move ${f(Math.abs(dGap), 3)} mm against each other: fix them at one point only and let the rest slide (slots), or solder joints and press fits will be strained every cycle.`);
  }
  // A sweep over the usual range for electronics/industrial parts, plus the given temperatures.
  const temps = [...new Set([-40, -20, 0, 20, 40, 60, 85, 105, 125, Math.round(t1), Math.round(t2)])].sort((x, y) => x - y);
  tables.push({
    title: `ΔL from ${f(t1, 4)} °C over temperature, ${f(length, 5)} mm`,
    columns: ['Temperature (°C)', `${name} ΔL (µm)`, ...(mm ? [`${mm[0]} ΔL (µm)`, 'Difference (µm)'] : [])],
    rows: temps.map((T) => {
      const d1 = a * length * (T - t1) * 1e-3;
      const row = [T, f(d1, 4)];
      if (mm) { const d2 = mm[1] * length * (T - t1) * 1e-3; row.push(f(d2, 4), f(d2 - d1, 4)); }
      return row;
    }),
  });
  if (Math.min(t1, t2) < -60 || Math.max(t1, t2) > 150) warnings.push('Outside about −60 to 150 °C the CTE is no longer constant (it falls toward cryogenic temperatures and plastics soften above their glass transition): use the material\'s α(T) curve.');
  if (/FR-4|PA66|ABS|PC|PETG|PLA|PMMA/.test(name) && Math.max(t1, t2) > 100 && !/z axis/.test(name)) warnings.push(`${name} may be near or above its glass transition / softening point at ${f(Math.max(t1, t2), 4)} °C, where its CTE jumps: check the datasheet.`);
  // The chart's x axis is by index: evenly spaced temperatures keep the lines straight.
  const lo = Math.min(-40, t1, t2), hi = Math.max(125, t1, t2);
  const cT = Array.from({ length: 12 }, (_, i) => Number(fmtNum(lo + ((hi - lo) * i) / 11, 3)));
  // For the page's drawing only (manifest agentOmit): the part, the housing and
  // the gap over a temperature sweep, so every drawn number comes from here.
  const dA = mm ? mm[1] - a : 0;
  const hasGap = !!mm && gap != null && gap >= 0;
  const rLo = Math.floor(Math.min(-60, t1 - 10, t2 - 10) / 10) * 10, rHi = Math.ceil(Math.max(160, t1 + 10, t2 + 10) / 10) * 10;
  const sweep = Array.from({ length: 61 }, (_, i) => {
    const T = rLo + ((rHi - rLo) * i) / 60;
    const d1 = a * 1e-6 * length * (T - t1), d2 = mm ? mm[1] * 1e-6 * length * (T - t1) : null;
    return { T, d1, d2, g: hasGap ? gap + d2 - d1 : null };
  });
  const closeAt = hasGap && dA !== 0 ? t1 - gap / (dA * 1e-6 * length) : null;
  const draw = {
    L: length, t1, t2, dT, range: [rLo, rHi],
    part: { key: material, name, a, E, sy, dL, Lt2: length + dL, strain: a * dT },
    mate: mm ? { key: mate, name: mm[0], a: mm[1], dL: mm[1] * 1e-6 * length * dT } : null,
    dAlpha: dA, rel: mm ? mm[1] * 1e-6 * length * dT - dL : null,
    gap: hasGap ? gap : null, gap2: hasGap ? gap + (mm[1] - a) * 1e-6 * length * dT : null, closeAt,
    stress: E ? E * 1e3 * a * 1e-6 * Math.abs(dT) : null,
    area: 2 * a * dT * 1e-4, volume: 3 * a * dT * 1e-4, sweep,
  };
  return {
    values, tables, warnings, draw,
    charts: [{ title: 'ΔL against temperature (µm)', type: 'line', x: cT, series: [
      { name, y: cT.map((T) => a * length * (T - t1) * 1e-3) },
      ...(mm ? [{ name: mm[0], y: cT.map((T) => mm[1] * length * (T - t1) * 1e-3) }] : [])], xLabel: '°C', yLabel: 'µm' }],
    notes: [
      'A hole grows like the material around it: a hole in aluminium gets bigger when hot.',
      'α is the mean coefficient over roughly 20-100 °C; the restrained stress is 1-D and elastic.',
      'For a round part, give the diameter as the length to get its diameter change.',
    ],
  };
}
