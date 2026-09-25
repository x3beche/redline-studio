// Minimum electrical conductor spacing, IPC-2221B table 6-1.
// Voltage is DC or AC peak between the two conductors. Above 500 V the per-volt
// value of the column is added to its 301-500 V value for every volt over 500
// (the usual reading of the table's "> 500 V" row).
import { fmtNum } from '../kit/eng.js';

const COLS = [
  ['B1', 'Internal conductors'],
  ['B2', 'External conductors, uncoated, sea level to 3050 m'],
  ['B3', 'External conductors, uncoated, above 3050 m'],
  ['B4', 'External conductors, permanent polymer coating (solder mask), any elevation'],
  ['A5', 'External conductors, conformal coating over assembly, any elevation'],
  ['A6', 'External component lead / termination, uncoated, sea level to 3050 m'],
  ['A7', 'External component lead / termination, conformal coating, any elevation'],
];

// [upper voltage of band, B1, B2, B3, B4, A5, A6, A7] in mm
const TABLE = [
  [15, 0.05, 0.1, 0.1, 0.05, 0.13, 0.13, 0.13],
  [30, 0.05, 0.1, 0.1, 0.05, 0.13, 0.25, 0.13],
  [50, 0.1, 0.6, 0.6, 0.13, 0.13, 0.4, 0.13],
  [100, 0.1, 0.6, 1.5, 0.13, 0.13, 0.5, 0.13],
  [150, 0.2, 0.6, 3.2, 0.4, 0.4, 0.8, 0.4],
  [170, 0.2, 1.25, 3.2, 0.4, 0.4, 0.8, 0.4],
  [250, 0.2, 1.25, 6.4, 0.4, 0.4, 0.8, 0.4],
  [300, 0.2, 1.25, 12.5, 0.4, 0.4, 0.8, 0.8],
  [500, 0.25, 2.5, 12.5, 0.8, 0.8, 1.5, 0.8],
];
// mm per volt above 500 V
const PER_VOLT = [0.0025, 0.005, 0.025, 0.00305, 0.00305, 0.00305, 0.00305];
const BANDS = ['0-15', '16-30', '31-50', '51-100', '101-150', '151-170', '171-250', '251-300', '301-500'];

/** Spacing in mm for column index c at peak voltage v. */
export function spacing(v, c) {
  if (v <= 500) {
    // bands are whole volts: 15.4 V is in the 16-30 row
    const row = TABLE.find((r) => Math.ceil(v - 1e-9) <= r[0]);
    return row[c + 1];
  }
  return TABLE[TABLE.length - 1][c + 1] + PER_VOLT[c] * (v - 500);
}

const mil = (mm) => fmtNum(mm / 0.0254, 3);

/** The highest peak voltage a gap of g mm is enough for in column c (0 when none). */
export function maxVoltage(g, c) {
  const top = TABLE[TABLE.length - 1][c + 1];
  if (g >= top - 1e-9) return 500 + (g - top) / PER_VOLT[c];
  let v = 0;
  for (const r of TABLE) { if (r[c + 1] <= g + 1e-9) v = r[0]; else break; }
  return v;
}

export function run({ voltage, kind, category, actual }) {
  const warnings = [];
  if (!(voltage >= 0)) return { warnings: ['Give the working voltage between the two conductors in volts, e.g. 48.'] };
  const ci = Math.max(0, COLS.findIndex((c) => c[0] === category));
  const vpk = kind === 'rms' ? voltage * Math.SQRT2 : voltage;
  const need = spacing(vpk, ci);
  const band = vpk > 500 ? '> 500' : BANDS[TABLE.findIndex((r) => Math.ceil(vpk - 1e-9) <= r[0])];

  const values = [
    { label: 'Voltage used', value: `${fmtNum(vpk, 4)} V peak`, hint: kind === 'rms' ? `${fmtNum(voltage, 4)} V rms × √2` : 'DC or AC peak' },
    { label: `Minimum spacing, ${COLS[ci][0]}`, value: fmtNum(need, 3), unit: 'mm', tone: 'ok', hint: `${mil(need)} mil · band ${band} V` },
  ];
  if (actual > 0) {
    const ok = actual >= need - 1e-9;
    values.push({ label: 'Your spacing', value: fmtNum(actual, 3), unit: 'mm', tone: ok ? 'ok' : 'bad',
      hint: ok ? `margin ${fmtNum(actual - need, 3)} mm` : `short by ${fmtNum(need - actual, 3)} mm` });
    if (!ok) warnings.push(`${fmtNum(actual, 3)} mm is below the ${fmtNum(need, 3)} mm IPC-2221 needs for ${fmtNum(vpk, 4)} V (${COLS[ci][0]}): widen the gap, add a slot, or coat the board (compare B4/A5).`);
  }
  if (kind !== 'rms' && [100, 110, 115, 120, 127, 220, 230, 240, 277].includes(voltage)) {
    warnings.push(`${voltage} V looks like a mains RMS voltage: if it is AC, choose "AC RMS" so it is converted to ${fmtNum(voltage * Math.SQRT2, 4)} V peak.`);
  }
  if (kind === 'rms' ? vpk > 42.4 : vpk > 60) warnings.push('Above safety extra-low voltage (60 V DC, 42.4 V AC peak) this is functional spacing only. Mains or other hazardous circuits must meet the safety standard (IEC 62368-1 / IEC 60664-1 / UL): its creepage and clearance by pollution degree, material group and insulation class are usually larger than this table.');

  const row = COLS.map((c, i) => [c[0], c[1], fmtNum(spacing(vpk, i), 3), mil(spacing(vpk, i))]);
  const full = TABLE.map((r, i) => [BANDS[i], ...r.slice(1).map((x) => fmtNum(x, 3))]);
  full.push(['> 500 (+ mm/V)', ...PER_VOLT.map((x) => `+${x}`)]);
  const gap = actual > 0 ? actual : null;
  return {
    spacing: {
      voltage, kind: kind === 'rms' ? 'rms' : 'dc', vpk, band, col: COLS[ci][0], colName: COLS[ci][1], need,
      actual: gap, ok: gap == null ? null : gap >= need - 1e-9, diff: gap == null ? null : gap - need,
      maxV: gap == null ? null : maxVoltage(gap, ci),
      hazardous: kind === 'rms' ? vpk > 42.4 : vpk > 60,
      cols: COLS.map((c, i) => ({ code: c[0], name: c[1], mm: spacing(vpk, i), maxV: gap == null ? null : maxVoltage(gap, i) })),
      bands: TABLE.map((r) => r[0]), table: TABLE.map((r) => r.slice(1)), perVolt: PER_VOLT,
    },
    values,
    warnings,
    tables: [
      { title: `All locations at ${fmtNum(vpk, 4)} V peak`, columns: ['Col.', 'Location', 'mm', 'mil'], rows: row },
      { title: 'IPC-2221B table 6-1, minimum spacing in mm (volts DC or AC peak)', columns: ['Volts', ...COLS.map((c) => c[0])], rows: full },
    ],
    notes: [
      'IPC-2221 gives one spacing for both creepage (along the surface) and clearance (through air) on the board.',
      'B4 needs a permanent polymer coating such as solder mask over both conductors; mask openings at pads fall back to A6 or B2.',
      'Above 500 V: the 301-500 V value plus the per-volt figure for each volt over 500.',
      'Altitude above 3050 m (B3) needs far more room: air breaks down at lower voltage.',
    ],
  };
}
