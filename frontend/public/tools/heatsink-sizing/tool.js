// Heat sink sizing from the series thermal path (TI SPRA953):
//   Tj = Ta + P·(θJC + θCS + θSA)   ->   θSA,max = (Tj,max − margin − Ta)/P − θJC − θCS
// Volume from volumetric thermal resistance Rv (Aavid/Boyd, "How to select a heat sink"):
//   V ≈ Rv / θSA   with Rv in cm³·°C/W for the air flow
import { fmtNum } from '../kit/eng.js';

const RV = { // cm³·°C/W, [best, typical-worst]
  natural: { name: 'natural convection', lo: 500, hi: 800 },
  1: { name: '1 m/s', lo: 150, hi: 250 },
  2.5: { name: '2.5 m/s', lo: 80, hi: 150 },
  5: { name: '5 m/s', lo: 50, hi: 80 },
};

// Rule-of-thumb classes (catalogue ranges, natural convection unless noted).
const CLASSES = [
  { name: 'Stamped / clip-on (TO-220)', lo: 15, hi: 30, size: '≈ 20 × 15 × 10 mm' },
  { name: 'Small board-mount extrusion (TO-220)', lo: 8, hi: 15, size: '≈ 25 × 25 × 15 mm' },
  { name: 'Medium board-mount extrusion', lo: 4, hi: 8, size: '≈ 40 × 40 × 25 mm' },
  { name: 'Large extrusion, 75–100 mm profile', lo: 1.5, hi: 4, size: '≈ 100 × 75 × 30 mm' },
  { name: 'Large extrusion 150 mm+, or chassis wall', lo: 0.6, hi: 1.5, size: '≈ 150 × 100 × 40 mm' },
  { name: 'Finned sink with fan', lo: 0.15, hi: 0.6, size: 'fan-cooled, CPU-cooler class' },
];

export function run({ p, ta, tjmax, margin, rjc, rcs, air, rja }) {
  const warnings = [];
  if (!(p > 0)) return { warnings: ['Give the power the part dissipates, in W (e.g. 10).'] };
  if (ta == null || !Number.isFinite(ta)) return { warnings: ['Give the ambient air temperature at the heat sink, in °C.'] };
  if (tjmax == null || !Number.isFinite(tjmax)) return { warnings: ['Give the maximum junction temperature from the datasheet, in °C (often 125, 150 or 175).'] };
  const mg = margin >= 0 ? margin : 0;
  const jc = rjc >= 0 ? rjc : 0, cs = rcs >= 0 ? rcs : 0;
  if (rjc == null) warnings.push('No θJC given; 0 °C/W used, which is optimistic.');
  const target = tjmax - mg;
  if (!(target > ta)) return { warnings: [`Max junction minus margin (${fmtNum(target, 3)} °C) is not above ambient (${fmtNum(ta, 3)} °C): no heat sink can work. Lower the ambient or the margin.`] };

  const budget = (target - ta) / p; // total junction-to-ambient allowed
  const sa = budget - jc - cs;
  const flow = RV[air] || RV.natural;
  const values = [
    { label: 'Total θJA allowed', value: fmtNum(budget, 3), unit: '°C/W', hint: `for Tj ${fmtNum(target, 3)} °C` },
  ];
  const tables = [];
  if (rja > 0) {
    const tjBare = ta + p * rja;
    values.push({ label: 'Tj without a sink', value: fmtNum(tjBare, 3), unit: '°C', tone: tjBare > target ? 'bad' : 'ok',
      hint: tjBare > target ? 'a heat sink is needed' : 'no heat sink needed' });
  }
  if (!(sa > 0)) {
    warnings.push(`θJC + θCS (${fmtNum(jc + cs, 3)} °C/W) already uses up the ${fmtNum(budget, 3)} °C/W budget: no heat sink is good enough. Use a better interface, a lower-θJC package, split the power over several parts, or lower the ambient.`);
    values.unshift({ label: 'Max sink θSA', value: 'impossible', tone: 'bad' });
    const tcX = target - p * jc;
    return { values, warnings, path: pathOf({ ok: false, p, ta, tjmax, mg, target, jc, cs, sa, budget, tc: tcX, ts: tcX - p * cs, rja, air: flow }) };
  }
  const vLo = flow.lo / sa, vHi = flow.hi / sa;
  const tc = target - p * jc, ts = tc - p * cs;
  values.unshift({ label: 'Max sink θSA', value: fmtNum(sa, 3), unit: '°C/W', tone: 'ok', hint: `sink-to-ambient, ${flow.name}` });
  values.push(
    { label: 'Heat sink volume', value: `${fmtNum(vLo, 2)}–${fmtNum(vHi, 2)}`, unit: 'cm³', hint: `envelope, ${flow.name}` },
    { label: 'As a cube', value: `${fmtNum(Math.cbrt(vLo) * 10, 2)}–${fmtNum(Math.cbrt(vHi) * 10, 2)}`, unit: 'mm side' },
    { label: 'Case temperature', value: fmtNum(tc, 3), unit: '°C', hint: 'with a sink exactly at θSA' },
    { label: 'Sink temperature', value: fmtNum(ts, 3), unit: '°C', tone: ts > 70 ? 'warn' : undefined, hint: ts > 70 ? 'hot to touch' : undefined },
  );
  if (ts > 70) warnings.push(`The heat sink runs at ${fmtNum(ts, 3)} °C: guard it against touch (IEC 62368-1 limits touchable metal to roughly 60–70 °C) or cool it better.`);
  if (sa < 0.5 && air === 'natural') warnings.push(`${fmtNum(sa, 3)} °C/W is hard to reach in natural convection: plan for a fan.`);
  if (cs > 0.4 * sa) warnings.push(`The interface (θCS ${fmtNum(cs, 3)} °C/W) is a large share of the budget: grease or phase-change material would allow a much smaller sink.`);

  tables.push({
    title: 'Thermal path with a sink exactly at θSA',
    columns: ['Node', 'Temperature °C', 'Step θ °C/W', 'Drop °C'],
    rows: [
      ['Junction', fmtNum(target, 3), '–', '–'],
      ['Case', fmtNum(tc, 3), fmtNum(jc, 3), fmtNum(p * jc, 3)],
      ['Heat sink', fmtNum(ts, 3), fmtNum(cs, 3), fmtNum(p * cs, 3)],
      ['Ambient', fmtNum(ta, 3), fmtNum(sa, 3), fmtNum(p * sa, 3)],
    ],
  });
  tables.push({
    title: 'Typical heat sink classes (rule of thumb, natural convection)',
    columns: ['Class', 'θSA °C/W', 'Size', 'Good enough?'],
    rows: CLASSES.map((c) => [c.name, `${c.lo}–${c.hi}`, c.size, c.hi <= sa ? 'yes' : c.lo <= sa ? 'the better ones' : 'no']),
  });
  const flows = ['natural', '1', '2.5', '5'].map((k) => RV[k]).map((f) => [f.name, `${f.lo}–${f.hi}`, `${fmtNum(f.lo / sa, 2)}–${fmtNum(f.hi / sa, 2)}`]);
  tables.push({ title: 'Volume at other air flows', columns: ['Air flow', 'Rv cm³·°C/W', 'Volume cm³'], rows: flows });

  return {
    values,
    warnings,
    tables,
    path: pathOf({ ok: true, p, ta, tjmax, mg, target, jc, cs, sa, budget, tc, ts, rja, air: flow, vLo, vHi }),
    notes: [
      'Heat sink θSA falls as power (and so temperature rise) grows; read the chosen part\'s curve at this power, not its single headline figure.',
      'The volume estimate is the envelope of the fins for a well-designed extrusion; poor orientation (fins horizontal) or blocked air can double it.',
      'Several parts on one sink: add their powers for the sink, but check each junction through its own θJC and θCS.',
    ],
  };
}

// The thermal path as numbers, for the page's drawing (every temperature and
// size it shows comes from here).
function pathOf({ ok, p, ta, tjmax, mg, target, jc, cs, sa, budget, tc, ts, rja, air, vLo, vHi }) {
  const flowKey = Object.keys(RV).find((k) => RV[k] === air);
  return {
    ok, p, ta, tjmax, margin: mg, tj: target, tc, ts, budget,
    theta: { jc, cs, sa },
    drop: { jc: p * jc, cs: p * cs, sa: p * sa },
    tjBare: rja > 0 ? ta + p * rja : null,
    // with a perfect sink (θSA = 0): the coolest this part can run on this interface
    perfect: { ts: ta, tc: ta + p * cs, tj: ta + p * (jc + cs), over: ta + p * (jc + cs) - target },
    air: flowKey,
    volume: ok ? [vLo, vHi] : null,
    cube: ok ? [Math.cbrt(vLo) * 10, Math.cbrt(vHi) * 10] : null,
    flows: ok ? ['natural', '1', '2.5', '5'].map((k) => [k, RV[k]]).map(([k, f]) => ({ key: k, name: f.name, rv: [f.lo, f.hi], volume: [f.lo / sa, f.hi / sa], cube: [Math.cbrt(f.lo / sa) * 10, Math.cbrt(f.hi / sa) * 10] })) : null,
    classes: CLASSES.map((c) => ({ name: c.name, lo: c.lo, hi: c.hi, size: c.size, fit: !(sa > 0) ? 'no' : c.hi <= sa ? 'yes' : c.lo <= sa ? 'some' : 'no' })),
  };
}
