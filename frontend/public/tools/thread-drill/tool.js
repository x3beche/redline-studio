// Tap drill and clearance holes for ISO metric and Unified inch threads.
// Data and formulas:
//   ISO 261 / ISO 262   metric coarse and fine pitches.
//   Tap drill (metric)  the workshop rule d = D - P, which DIN 336 lists and which gives
//                       about 77 % thread; values are the ones on every metric tap chart.
//   % of thread         Machinery's Handbook: % = 76.98 x (D - drill) / P   (mm)
//                                           % = 76.98 x TPI x (D - drill)  (inch)
//                       76.98 = 100 / 1.299 (1.299 P = twice the 0.6495 P basic thread depth).
//   Minor diameter      ISO 68-1 / ASME B1.1 basic: D1 = D - 1.082532 P.
//   Clearance holes     ISO 273 fine / medium / coarse series (metric);
//                       close / free fit drills of the common inch charts (Machinery's Handbook).
//   Unified sizes       ASME B1.1 major diameters; 75 % tap drills from the standard inch chart.
import { fmtNum } from '../kit/eng.js';

// name, D (mm), P (mm), fine?
const METRIC = [
  ['M1', 1, 0.25], ['M1.2', 1.2, 0.25], ['M1.4', 1.4, 0.3], ['M1.6', 1.6, 0.35], ['M2', 2, 0.4], ['M2.5', 2.5, 0.45],
  ['M3', 3, 0.5], ['M4', 4, 0.7], ['M5', 5, 0.8], ['M6', 6, 1], ['M8', 8, 1.25], ['M10', 10, 1.5], ['M12', 12, 1.75],
  ['M14', 14, 2], ['M16', 16, 2], ['M20', 20, 2.5], ['M24', 24, 3], ['M30', 30, 3.5],
  ['M3x0.35', 3, 0.35, 1], ['M4x0.5', 4, 0.5, 1], ['M5x0.5', 5, 0.5, 1], ['M6x0.75', 6, 0.75, 1], ['M8x1', 8, 1, 1],
  ['M10x1.25', 10, 1.25, 1], ['M10x1', 10, 1, 1], ['M12x1.5', 12, 1.5, 1], ['M12x1.25', 12, 1.25, 1],
  ['M14x1.5', 14, 1.5, 1], ['M16x1.5', 16, 1.5, 1], ['M20x1.5', 20, 1.5, 1], ['M24x2', 24, 2, 1], ['M30x2', 30, 2, 1],
];
// ISO 273 clearance holes, by nominal diameter: fine, medium, coarse (mm)
const ISO273 = {
  1: [1.1, 1.2, 1.3], 1.2: [1.3, 1.4, 1.5], 1.4: [1.5, 1.6, 1.8], 1.6: [1.7, 1.8, 2], 2: [2.2, 2.4, 2.6], 2.5: [2.7, 2.9, 3.1],
  3: [3.2, 3.4, 3.6], 4: [4.3, 4.5, 4.8], 5: [5.3, 5.5, 5.8], 6: [6.4, 6.6, 7], 8: [8.4, 9, 10], 10: [10.5, 11, 12],
  12: [13, 13.5, 14.5], 14: [15, 15.5, 16.5], 16: [17, 17.5, 18.5], 20: [21, 22, 24], 24: [25, 26, 28], 30: [31, 33, 35],
};
// name, D (in), TPI, tap drill [label, in], close drill, free drill
const UNIFIED = [
  ['#0-80 UNF', 0.060, 80, ['3/64', 0.0469], ['#52', 0.0635], ['#48', 0.0760]],
  ['#2-56 UNC', 0.086, 56, ['#50', 0.0700], ['#43', 0.0890], ['#38', 0.1015]],
  ['#4-40 UNC', 0.112, 40, ['#43', 0.0890], ['#33', 0.1130], ['#29', 0.1360]],
  ['#6-32 UNC', 0.138, 32, ['#36', 0.1065], ['#28', 0.1405], ['#25', 0.1495]],
  ['#8-32 UNC', 0.164, 32, ['#29', 0.1360], ['#19', 0.1660], ['#16', 0.1770]],
  ['#10-24 UNC', 0.190, 24, ['#25', 0.1495], ['#11', 0.1910], ['#7', 0.2010]],
  ['#10-32 UNF', 0.190, 32, ['#21', 0.1590], ['#11', 0.1910], ['#7', 0.2010]],
  ['1/4-20 UNC', 0.250, 20, ['#7', 0.2010], ['F', 0.2570], ['H', 0.2660]],
  ['1/4-28 UNF', 0.250, 28, ['#3', 0.2130], ['F', 0.2570], ['H', 0.2660]],
  ['5/16-18 UNC', 0.3125, 18, ['F', 0.2570], ['P', 0.3230], ['Q', 0.3320]],
  ['5/16-24 UNF', 0.3125, 24, ['I', 0.2720], ['P', 0.3230], ['Q', 0.3320]],
  ['3/8-16 UNC', 0.375, 16, ['5/16', 0.3125], ['W', 0.3860], ['X', 0.3970]],
  ['3/8-24 UNF', 0.375, 24, ['Q', 0.3320], ['W', 0.3860], ['X', 0.3970]],
  ['1/2-13 UNC', 0.500, 13, ['27/64', 0.4219], ['33/64', 0.5156], ['17/32', 0.5312]],
  ['1/2-20 UNF', 0.500, 20, ['29/64', 0.4531], ['33/64', 0.5156], ['17/32', 0.5312]],
];
const TAP_CHART = { M8: 6.8, M12: 10.2 };
export const THREADS = [...METRIC.map((r) => r[0]), ...UNIFIED.map((r) => r[0])];

const IN = 25.4;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const pct = (D, drill, P) => (76.98 * (D - drill)) / P; // Machinery's Handbook, any consistent unit

function metricInfo([name, D, P, fine]) {
  // D - P, except where the charts (DIN 336) round to a stocked drill: M8 6.8, M12 10.2.
  const tap = TAP_CHART[name] ?? Math.round((D - P) * 100) / 100;
  const cl = ISO273[D];
  return { name, family: fine ? 'Metric fine' : 'Metric coarse', D, P, tpi: null, tap, tapLabel: `${fmtNum(tap)} mm`,
    minor: D - 1.082532 * P, clear: cl, clearLabels: ['fine', 'medium', 'coarse'] };
}
function unifiedInfo([name, Din, tpi, tap, close, free]) {
  const P = IN / tpi;
  return { name, family: /UNF/.test(name) ? 'Unified fine (UNF)' : 'Unified coarse (UNC)', D: Din * IN, P, tpi,
    tap: tap[1] * IN, tapLabel: `${tap[0]} (${tap[1].toFixed(4)}")`, minor: (Din - 1.082532 / tpi) * IN,
    clear: [close[1] * IN, free[1] * IN], clearNames: [close[0], free[0]], clearLabels: ['close', 'free'] };
}

const lookup = (name) => {
  const m = METRIC.find((r) => r[0].toLowerCase() === name);
  if (m) return metricInfo(m);
  const u = UNIFIED.find((r) => r[0].toLowerCase() === name);
  return u ? unifiedInfo(u) : null;
};

export function run({ thread, engagement, filter }) {
  const warnings = [];
  const t = lookup(String(thread || 'M3').toLowerCase()) || lookup('m3');
  let e = engagement;
  if (e == null) { e = 75; warnings.push('Give the thread engagement in %, e.g. 75; 75 % is used.'); }
  if (e < 50 || e > 100) warnings.push(`${fmtNum(e)} % thread is outside 50-100 %: below ~55 % the thread strips, above ~85 % taps break for little extra strength. 65-77 % is normal.`);
  const eUse = Math.min(100, Math.max(1, e));
  const drillForE = t.D - (eUse / 76.98) * t.P;
  const inch = t.tpi != null;
  const u = (mm) => (inch ? `${r3(mm)} mm (${(mm / IN).toFixed(4)}")` : `${r2(mm)} mm`);

  const values = [
    { label: 'Thread', value: t.name, hint: `${t.family}, D ${u(t.D)}` },
    { label: 'Pitch', value: inch ? `${t.tpi} TPI` : `${fmtNum(t.P)} mm`, hint: inch ? `${r3(t.P)} mm` : null },
    { label: 'Tap drill (chart)', value: t.tapLabel, tone: 'ok', hint: `${fmtNum(pct(t.D, t.tap, t.P), 3)} % thread` },
    { label: `Drill for ${fmtNum(eUse)} % thread`, value: u(drillForE), hint: 'round to the drill you have' },
    { label: 'Minor diameter (basic)', value: u(t.minor), hint: 'basic D1 of the nut thread (ISO 68-1)' },
  ];
  t.clear.forEach((c, i) => values.push({ label: `Clearance, ${t.clearLabels[i]}`, value: inch ? `${t.clearNames[i]} (${(c / IN).toFixed(4)}")` : `${fmtNum(c)} mm`,
    hint: inch ? `${r2(c)} mm` : (i === 1 ? 'ISO 273, the usual choice' : 'ISO 273'), tone: i === (inch ? 0 : 1) ? 'ok' : undefined }));

  // The whole family of the chosen thread, filtered by the text.
  const f = String(filter || '').trim().toLowerCase();
  const rows = inch
    ? UNIFIED.map(unifiedInfo).filter((r) => !f || r.name.toLowerCase().includes(f))
      .map((r) => [r.name, `${r3(r.D)}`, `${r.tpi} TPI`, r.tapLabel, `${r2(r.tap)} mm`, `${fmtNum(pct(r.D, r.tap, r.P), 3)} %`, `${r.clearNames[0]} / ${r.clearNames[1]}`, `${r2(r.clear[0])} / ${r2(r.clear[1])} mm`])
    : METRIC.map(metricInfo).filter((r) => !f || r.name.toLowerCase().includes(f) || r.family.toLowerCase().includes(f))
      .map((r) => [r.name, `${fmtNum(r.D)}`, `${fmtNum(r.P)}`, `${fmtNum(r.tap)}`, `${r2(r.minor)}`, r.clear.map((c) => fmtNum(c)).join(' / '), r.family]);
  if (f && !rows.length) warnings.push(`No ${inch ? 'Unified' : 'metric'} thread matches "${filter}".`);
  const table = inch
    ? { title: 'Unified threads (inch)', columns: ['Thread', 'D (in)', 'Pitch', 'Tap drill', 'Tap drill (mm)', 'Thread', 'Clearance close / free', 'Close / free (mm)'], rows }
    : { title: 'Metric threads (mm)', columns: ['Thread', 'D', 'Pitch', 'Tap drill', 'Minor Ø', 'Clearance fine / medium / coarse', 'Series'], rows };

  const med = inch ? t.clear[0] : t.clear[1];
  const key = t.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/, '').toLowerCase();
  const cad = [
    `// ${t.name} (${t.family}), mm`,
    `${key}_d = ${r3(t.D)};`,
    `${key}_pitch = ${r3(t.P)};`,
    `${key}_tap_drill = ${r3(t.tap)};`,
    `${key}_minor_d = ${r3(t.minor)};`,
    `${key}_clearance = ${r3(med)};  // ${inch ? 'close fit' : 'ISO 273 medium'}`,
  ].join('\n');

  return {
    values,
    tables: [table],
    texts: [{ title: 'CAD variables', body: cad + '\n', lang: 'scad' }],
    warnings,
    notes: [
      'Chart tap drills give about 75 % thread: that is 95 % of the strength of a full thread and much easier to tap.',
      'Soft or plastic material: 60-70 % thread (a slightly larger drill) is usual; a thread-forming tap needs a larger drill of its own (about D - 0.45 P, e.g. 2.8 mm for M3).',
      'For a 3D-printed hole to be tapped, model it at the tap drill size and expect FDM holes to print 0.1-0.3 mm undersize.',
    ],
  };
}
