// Wire size from current, length and allowed voltage drop, checked against the
// current the wire can carry.
//
// Voltage drop (resistive; reactance ignored, fine below ~50 mm² / at DC):
//   DC or single phase:  ΔV = 2 · L · I · R'        (out and back)
//   Three phase:         ΔV = √3 · L · I · R'       (line-to-line, balanced load)   IEC 60364-5-52 annex G
//   R' = ρ(T) / A · k,   ρ(T) = ρ20 · (1 + α (T - 20))
//     copper    ρ20 = 1.7241e-8 Ω·m, α = 0.00393 /K  (IEC 60028, annealed copper standard)
//     aluminium ρ20 = 2.8264e-8 Ω·m, α = 0.00403 /K  (IEC 60889)
//     k = 1.06 solid/stranded (class 1-2), 1.15 flexible (class 5-6): the ratio of the IEC 60228 maximum
//     conductor resistance to the ideal ρ/A for the nominal area.
// AWG diameter: d = 0.127 mm · 92^((36 - n) / 39)       ASTM B258
// Ampacity: IEC 60364-5-52 table B.52.4 (PVC, 70 °C) / B.52.5 (XLPE, 90 °C), method C (clipped
// direct), two loaded copper conductors, 30 °C ambient; interpolated log-log on area. Below 1.5 mm²
// (outside the table) scaled as A^0.75 (heat balance I²R = h·π·d·ΔT gives I ∝ d^1.5): an estimate.
// Other methods by the table ratios (E free air ≈ 1.12, B1 conduit ≈ 0.90, A1 in insulation ≈ 0.74),
// grouping factors table B.52.17, ambient factor √((Tmax - Ta) / (Tmax - 30)).
import { fmtNum } from '../kit/eng.js';

const CU_C_PVC = [[1.5, 19.5], [2.5, 27], [4, 36], [6, 46], [10, 63], [16, 85], [25, 112], [35, 138], [50, 168], [70, 213], [95, 258], [120, 299]];
const CU_C_XLPE = [[1.5, 24], [2.5, 33], [4, 45], [6, 58], [10, 80], [16, 107], [25, 138], [35, 171], [50, 209], [70, 269], [95, 328], [120, 382]];
const METHOD = { E: [1.12, 'free air (method E)'], C: [1.0, 'clipped to a surface (method C)'], B1: [0.9, 'in conduit or trunking (method B1)'], A1: [0.74, 'in thermal insulation (method A1)'] };
const GROUP = [[1, 1], [2, 0.8], [3, 0.7], [4, 0.65], [5, 0.6], [6, 0.57], [7, 0.54], [8, 0.52], [9, 0.5], [12, 0.45], [16, 0.41], [20, 0.38]];
const METRIC = [0.14, 0.25, 0.34, 0.5, 0.75, 1, 1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120];
const AWG = [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 3, 2, 1, 0, -1, -2, -3];
const awgName = (n) => (n > 0 ? `${n} AWG` : `${1 - n}/0 AWG`);
const awgArea = (n) => { const d = 0.127 * Math.pow(92, (36 - n) / 39); return (Math.PI * d * d) / 4; };

function baseAmp(area, ins) {
  const t = ins === 'xlpe' ? CU_C_XLPE : CU_C_PVC;
  if (area <= t[0][0]) return t[0][1] * Math.pow(area / t[0][0], 0.75);
  for (let i = 1; i < t.length; i++) {
    if (area <= t[i][0]) {
      const [a0, i0] = t[i - 1], [a1, i1] = t[i];
      const f = Math.log(area / a0) / Math.log(a1 / a0);
      return Math.exp(Math.log(i0) + f * Math.log(i1 / i0));
    }
  }
  return null; // beyond the table
}

export function run({ current, length, voltage, drop, circuit, metal, strand, temp, ins, method, ambient, group, sizes }) {
  const warnings = [];
  if (!(current > 0)) return { warnings: ['Give the load current in A, above zero.'] };
  if (!(length > 0)) return { warnings: ['Give the one-way cable length in metres, above zero.'] };
  if (!(voltage > 0)) return { warnings: ['Give the supply voltage in V, above zero.'] };
  if (!(drop > 0 && drop < 100)) return { warnings: ['Give the allowed voltage drop as a percentage between 0 and 100 (3 % is common for power, 5 % at most).'] };
  const al = metal === 'al';
  const rho20 = al ? 2.8264e-8 : 1.7241e-8, alpha = al ? 0.00403 : 0.00393;
  const T = Number.isFinite(temp) ? temp : 20;
  const rho = rho20 * (1 + alpha * (T - 20));
  const kStr = strand === 'flex' ? 1.15 : 1.06;
  const three = circuit === 'ac3';
  const kLen = three ? Math.sqrt(3) : 2;
  const dvMax = voltage * drop / 100;
  // Minimum area from the drop: A = k · ρ · kLen · L · I / ΔV
  const aDrop = (kStr * rho * kLen * length * current / dvMax) * 1e6; // mm²

  const tmax = ins === 'xlpe' ? 90 : 70;
  const Ta = Number.isFinite(ambient) ? ambient : 30;
  if (Ta >= tmax) return { warnings: [`Ambient ${fmtNum(Ta, 3)} °C is at or above the ${tmax} °C insulation limit: no current is allowed. Use higher-rated insulation.`] };
  const kAmb = Math.sqrt((tmax - Ta) / (tmax - 30));
  const nG = Math.max(1, Math.round(Number(group) || 1));
  const kGrp = (GROUP.find((g) => nG <= g[0]) || GROUP[GROUP.length - 1])[1];
  const [kMeth, methName] = METHOD[method] || METHOD.C;
  const kAl = al ? 0.78 : 1; // same heat balance, √(σAl/σCu)
  const derate = kAmb * kGrp * kMeth * kAl;
  const amp = (a) => { const b = baseAmp(a, ins); return b == null ? null : b * derate; };

  const list = sizes === 'awg'
    ? AWG.map((n) => ({ name: awgName(n), area: awgArea(n) }))
    : METRIC.map((a) => ({ name: `${a} mm²`, area: a }));
  const calc = (s) => {
    const R = kStr * rho / (s.area * 1e-6); // Ω/m
    const dv = kLen * length * current * R;
    const I = amp(s.area);
    return { ...s, R, dv, pct: (100 * dv) / voltage, loss: (three ? 3 : 2) * current * current * R * length, I, ok: dv <= dvMax && I != null && I >= current };
  };
  const all = list.map(calc);
  const best = all.find((s) => s.ok);
  const byDrop = all.find((s) => s.dv <= dvMax);
  const byAmp = all.find((s) => s.I != null && s.I >= current);

  if (!best) warnings.push(`No ${sizes === 'awg' ? 'AWG size up to 4/0' : 'size up to 120 mm²'} meets both limits: use parallel conductors, a shorter run, a higher voltage or a larger drop allowance.`);
  if (al && best && best.area < 16) warnings.push('Aluminium below 16 mm² is not allowed in fixed wiring in most codes (IEC 60364-5-52 524.1): use copper.');
  if (T < Ta) warnings.push(`Conductor temperature ${fmtNum(T, 3)} °C is below the ambient: a loaded wire is at least as warm as the air around it, so the drop is underestimated.`);
  if (best && best.area > 50 && circuit !== 'dc') warnings.push('Above 50 mm² on AC the cable reactance adds noticeably to the drop: check with the manufacturer\'s mV/A/m values.');
  if (best && best.area < 1.5) warnings.push('Below 1.5 mm² the ampacity is extrapolated beyond IEC 60364 table B.52: check the wire maker\'s rating (e.g. UL 1007/1015 or the harness standard) before relying on it.');

  const pickIdx = best ? all.indexOf(best) : all.length - 1;
  const rows = all.slice(Math.max(0, pickIdx - 3), pickIdx + 4).map((s) => [
    s === best ? `▶ ${s.name}` : s.name, fmtNum(s.area, 3), fmtNum(s.R * 1000, 4), fmtNum(s.dv, 3), `${fmtNum(s.pct, 3)} %`, fmtNum(s.loss, 3), s.I == null ? '–' : fmtNum(s.I, 3), s.ok ? 'yes' : s.dv > dvMax ? 'drop too big' : 'too hot']);

  const values = [
    { label: 'Min. area for the drop', value: fmtNum(aDrop, 3), unit: 'mm²', hint: `ΔV ≤ ${fmtNum(dvMax, 3)} V (${fmtNum(drop, 3)} %)` },
    { label: 'Min. size for the current', value: byAmp ? byAmp.name : '–', hint: `derating × ${fmtNum(derate, 3)}` },
    { label: 'Use', value: best ? best.name : 'none fits', tone: best ? 'ok' : 'bad', hint: best ? `${fmtNum(best.area, 3)} mm²; ${byDrop === best ? 'set by voltage drop' : 'set by current'}` : '' },
  ];
  if (best) values.push(
    { label: 'Voltage drop', value: fmtNum(best.dv, 3), unit: 'V', hint: `${fmtNum(best.pct, 3)} % of ${fmtNum(voltage, 4)} V`, tone: 'ok' },
    { label: 'Load sees', value: fmtNum(voltage - best.dv, 4), unit: 'V' },
    { label: 'Power lost in cable', value: fmtNum(best.loss, 3), unit: 'W' },
    { label: 'Its current rating', value: fmtNum(best.I, 3), unit: 'A', hint: methName },
    { label: 'Current density', value: fmtNum(current / best.area, 3), unit: 'A/mm²' },
  );
  // Everything the page draws, as numbers (the sizes as calculated above).
  const wire = {
    current, length, voltage, drop, dvMax, aDrop, circuit: three ? 'ac3' : circuit === 'ac1' ? 'ac1' : 'dc', sizes: sizes === 'metric' ? 'metric' : 'awg',
    metal: al ? 'al' : 'cu', strand: strand === 'flex' ? 'flex' : 'stranded', ins: ins === 'xlpe' ? 'xlpe' : 'pvc', method: METHOD[method] ? method : 'C', methName,
    T, Ta, tmax, nG, kAmb, kGrp, kMeth, kAl, derate,
    best: best ? all.indexOf(best) : -1, byDrop: byDrop ? all.indexOf(byDrop) : -1, byAmp: byAmp ? all.indexOf(byAmp) : -1,
    list: all.map((s) => ({ name: s.name, area: s.area, d: Math.sqrt((4 * s.area) / Math.PI), R: s.R, dv: s.dv, pct: s.pct, loss: s.loss, I: s.I, ok: s.ok,
      why: s.ok ? 'fits' : s.dv > dvMax ? 'drop' : 'hot' })),
  };
  return {
    wire,
    values,
    warnings,
    tables: [{ title: `${sizes === 'awg' ? 'AWG' : 'Metric'} sizes around the pick, ${al ? 'aluminium' : 'copper'} at ${fmtNum(T, 3)} °C`, columns: ['Size', 'mm²', 'mΩ/m', 'Drop V', 'Drop %', 'Loss W', 'Rating A', 'Fits?'], rows }],
    notes: [
      `Drop uses ${three ? '√3 × length (three-phase, line-to-line voltage)' : '2 × length (out and back)'}; give the one-way length.`,
      `Resistance at ${fmtNum(T, 3)} °C conductor temperature with a ${kStr} factor for ${strand === 'flex' ? 'flexible (class 5/6)' : 'solid or stranded (class 1/2)'} conductors (IEC 60228 maximums). A fully loaded PVC wire runs up to 70 °C, 20 % more resistance than at 20 °C.`,
      `Rating: IEC 60364-5-52 method C for ${ins === 'xlpe' ? 'XLPE/90 °C' : 'PVC/70 °C'} insulation, × ${fmtNum(kMeth, 3)} for ${methName}, × ${fmtNum(kAmb, 3)} for ${fmtNum(Ta, 3)} °C ambient, × ${fmtNum(kGrp, 3)} for ${nG} circuit${nG > 1 ? 's' : ''} bundled${al ? ', × 0.78 for aluminium' : ''}.`,
      'Protect the wire with a fuse or breaker rated at or below its current rating.',
    ],
  };
}
