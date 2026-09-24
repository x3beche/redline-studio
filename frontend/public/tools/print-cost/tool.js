// FDM print time and cost estimate from the part volume.
// Model (a first-order estimate, the way slicers split a part; rule of thumb, not a slicer):
//   shell   = min(V, A · walls · line width)        solid perimeters and skins over the surface A
//   printed = shell + (V - shell) · infill + V · support
//   mass    = printed · density                      densities from filament data sheets
//   flow    = speed · line width · layer height      nominal volumetric rate, mm³/s
//   time    = printed / (flow · efficiency)          efficiency covers acceleration, travel, slower
//                                                    perimeters and layer changes (typ. 40-70 %)
//   cost    = mass · price/kg + time · (machine rate + power · energy price), then + failure margin
//   Surface A, when not given: that of a cube of the same volume, 6 · V^(2/3).
//   Filament length for Ø1.75 mm: printed / (π · 0.875²).
import { fmtNum } from '../kit/eng.js';

const DENSITY = { pla: ['PLA', 1.24], petg: ['PETG', 1.27], abs: ['ABS', 1.04], asa: ['ASA', 1.07], tpu: ['TPU', 1.21], pa: ['Nylon (PA)', 1.14], pc: ['PC', 1.20], cf: ['PLA-CF / PETG-CF', 1.30] };

const hm = (s) => { const m = Math.round(s / 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const money = (v, c) => `${v.toFixed(2)} ${c}`.trim();

export function run(i) {
  const warnings = [];
  const need = [['volume', 'part volume in cm³'], ['infill', 'infill in %'], ['walls', 'number of walls'], ['line', 'line width in mm'], ['layer', 'layer height in mm'], ['speed', 'print speed in mm/s'], ['efficiency', 'efficiency in %'], ['price', 'filament price per kg']];
  const missing = need.filter(([k]) => i[k] == null || i[k] < 0);
  if (missing.length) return { warnings: missing.map(([, w]) => `Give the ${w} (a number, not negative).`) };
  if (!(i.volume > 0) || !(i.line > 0) || !(i.layer > 0) || !(i.speed > 0) || !(i.efficiency > 0)) return { warnings: ['Volume, line width, layer height, speed and efficiency must be above zero.'] };
  const cur = String(i.currency || '').trim();
  const [mname, rho] = DENSITY[i.material] || DENSITY.pla;
  const V = i.volume * 1000; // mm³
  const estArea = !(i.area > 0);
  const A = estArea ? 6 * Math.pow(V, 2 / 3) : i.area * 100; // mm²
  const infill = Math.min(100, i.infill) / 100;
  const support = Math.max(0, i.support || 0) / 100;
  const eff = Math.min(100, i.efficiency) / 100;
  if (i.infill > 100) warnings.push('Infill over 100 % is taken as 100 %.');
  if (i.efficiency > 100) warnings.push('Efficiency over 100 % is taken as 100 %.');
  if (i.layer > 0.8 * i.line) warnings.push(`A ${fmtNum(i.layer)} mm layer is over 80 % of the ${fmtNum(i.line)} mm line width: layers will not bond well. Use a layer at most 75 % of the nozzle.`);

  const model = (inf) => {
    const shell = Math.min(V, A * i.walls * i.line);
    const printed = shell + (V - shell) * inf + V * support;
    const mass = (printed / 1000) * rho;
    const flow = i.speed * i.line * i.layer;
    const time = printed / (flow * eff);
    const hours = time / 3600;
    const material = (mass / 1000) * i.price;
    const machine = hours * (i.rate || 0);
    const energy = hours * ((i.power || 0) / 1000) * (i.kwh || 0);
    const total = (material + machine + energy) * (1 + Math.max(0, i.failure || 0) / 100);
    return { shell, printed, mass, flow, time, material, machine, energy, total };
  };
  const m = model(infill);
  if (m.flow > 15) warnings.push(`${fmtNum(m.flow, 3)} mm³/s nominal flow is above what a standard hot end melts (about 10-15 mm³/s): the printer will not reach ${fmtNum(i.speed)} mm/s, so the time is optimistic. Lower the speed or use a high-flow hot end.`);
  if (m.shell >= V - 1e-6) warnings.push('The walls fill the whole part: it prints solid, infill has no effect.');

  const values = [
    { label: 'Print time', value: hm(m.time), tone: 'ok', hint: `${fmtNum(m.time / 3600, 3)} h` },
    { label: 'Material', value: `${fmtNum(m.mass, 3)} g`, hint: `${mname}, ${fmtNum(m.printed / 1000, 3)} cm³, ${fmtNum(m.printed / (Math.PI * 0.875 * 0.875) / 1000, 3)} m of Ø1.75` },
    { label: 'Total cost', value: money(m.total, cur), tone: 'ok', hint: `incl. ${fmtNum(i.failure || 0)} % failure margin` },
    { label: 'Material cost', value: money(m.material, cur) },
    { label: 'Machine + energy', value: money(m.machine + m.energy, cur), hint: `${money(m.machine, cur)} + ${money(m.energy, cur)}` },
    { label: 'Shell share', value: `${fmtNum((100 * Math.min(V, m.shell)) / V, 3)} %`, hint: estArea ? `surface estimated ${fmtNum(A / 100, 3)} cm²` : `surface ${fmtNum(A / 100, 3)} cm²` },
    { label: 'Nominal flow', value: `${fmtNum(m.flow, 3)} mm³/s`, hint: `effective ${fmtNum(m.flow * eff, 3)}` },
  ];
  const rows = [10, 15, 20, 30, 50, 100].map((p) => { const q = model(p / 100); return [`${p} %`, hm(q.time), `${fmtNum(q.mass, 3)} g`, money(q.total, cur)]; });
  return {
    values,
    tables: [{ title: 'Other infill settings', columns: ['Infill', 'Time', 'Material', 'Total cost'], rows }],
    warnings,
    notes: [
      estArea ? 'Surface area was not given, so it is taken as that of a cube of the same volume; give the real area from CAD for thin or detailed parts (they have more shell).' : 'Shell = surface area x walls x line width; top and bottom skins are counted in the same way.',
      'A first-order estimate: slicers usually land within about ±25 %. Tune the efficiency so one real print matches, then reuse it.',
      'Heat-up, bed levelling and post-processing time are not included.',
    ],
  };
}
