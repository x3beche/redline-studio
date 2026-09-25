// Current and heat through plated vias.
//
//   Barrel copper area   A = π/4 (D² - (D - 2 tp)²)   D drilled hole, tp wall plating
//   Current (IPC-2221B fig. 6-4 / eq. 6-1, the conductor chart fitted):
//                        I = k ΔT^0.44 A^0.725       A in mil², ΔT in °C, I in A
//                        k = 0.048 external, 0.024 internal conductor
//                        (the usual way the chart is applied to a via barrel, e.g.
//                        Saturn PCB Toolkit's IPC-2221 via mode)
//   Resistance           R = ρ L / A,  ρ(T) = 1.724e-8 (1 + 0.00393 (T - 20)) Ω·m
//   Thermal resistance   Rθ = L / (k A)  per via, copper k = 385 W/m·K (plated
//                        copper is often quoted lower, 300-360), fill in parallel
import { fmtNum, fmtEng } from '../kit/eng.js';

const MIL2_PER_MM2 = 1 / (0.0254 * 0.0254); // 1550.0
const RHO20 = 1.724e-8; // Ω·m, annealed copper at 20 °C (IACS)
const ALPHA = 0.00393; // 1/°C
const K_CU = 385; // W/m·K

const FILLS = {
  none: { name: 'Open (unfilled)', k: 0 },
  epoxy: { name: 'Non-conductive epoxy', k: 0.25 },
  conductive: { name: 'Conductive (silver) epoxy', k: 3.5 },
  solder: { name: 'Filled with solder (SAC)', k: 58 },
  copper: { name: 'Copper filled', k: 385 },
};

export function run({ drill, plating, length, count, current, dtmax, layer, fill, power, ambient }) {
  const warnings = [];
  if (!(drill > 0)) return { warnings: ['Give the drilled hole diameter in mm, e.g. 0.3.'] };
  if (!(plating > 0)) return { warnings: ['Give the barrel plating thickness in µm; IPC-6012 class 2 asks for 20 µm average, class 3 for 25 µm.'] };
  if (!(length > 0)) return { warnings: ['Give the via length (board thickness for a through via) in mm, e.g. 1.6.'] };
  const n = count >= 1 ? Math.floor(count) : 1;
  if (!(count >= 1)) warnings.push('Via count missing or below 1: computed for one via.');
  if (count >= 1 && count !== n) warnings.push(`Via count rounded down to ${n}.`);
  const tp = plating * 1e-3; // mm
  if (2 * tp >= drill) return { warnings: [`Plating of ${plating} µm closes a ${drill} mm hole: check the inputs (plating is per wall, in µm).`] };
  if (plating > 60) warnings.push(`${plating} µm plating is unusual (typical 18-35 µm); check you gave micrometres.`);
  if (drill > 3) warnings.push(`${drill} mm is a large hole; the IPC-2221 chart was fitted to traces, so treat the current as rough.`);
  const dT = dtmax > 0 ? dtmax : 10;
  if (!(dtmax > 0)) warnings.push('No temperature rise given: 10 °C used.');
  if (dT > 100) warnings.push('The IPC-2221 chart only goes to 100 °C rise; above that the fit is extrapolated.');
  const k = layer === 'internal' ? 0.024 : 0.048;
  const f = FILLS[fill] || FILLS.none;
  const ta = Number.isFinite(ambient) ? ambient : 25;

  const aMm2 = (Math.PI / 4) * (drill ** 2 - (drill - 2 * tp) ** 2); // barrel copper area
  const aMil2 = aMm2 * MIL2_PER_MM2;
  const iOne = k * Math.pow(dT, 0.44) * Math.pow(aMil2, 0.725); // A per via for dT
  const iArr = iOne * n;
  if (aMil2 > 1000) warnings.push('Barrel area is above the 1000 mil² the IPC-2221 fit covers: extrapolated.');

  // Temperature rise at the given current, shared evenly by n vias
  const I = current > 0 ? current : 0;
  const iPer = I / n;
  const rise = I > 0 ? Math.pow(iPer / (k * Math.pow(aMil2, 0.725)), 1 / 0.44) : 0;

  // Electrical resistance at the conductor's temperature
  const tC = ta + rise;
  const rho = RHO20 * (1 + ALPHA * (tC - 20));
  const L = length * 1e-3, A = aMm2 * 1e-6;
  const rOne = (rho * L) / A;
  const rArr = rOne / n;
  const drop = I * rArr;
  const pDiss = I * I * rArr;

  // Heat conduction through the board: copper barrel plus the fill in parallel
  const aFill = (Math.PI / 4) * (drill - 2 * tp) ** 2 * 1e-6; // m²
  const gOne = (K_CU * A) / L + (f.k * aFill) / L; // W/K
  const rthOne = 1 / gOne, rthArr = rthOne / n;
  const P = power > 0 ? power : 0;

  const values = [
    { label: 'Barrel copper area', value: `${fmtNum(aMm2 * 1e3, 3)} ×10⁻³ mm²`, hint: `${fmtNum(aMil2, 3)} mil²` },
    { label: `Current per via at ${fmtNum(dT, 3)} °C rise`, value: fmtNum(iOne, 3), unit: 'A', hint: `IPC-2221 ${layer === 'internal' ? 'internal' : 'external'} k = ${k}` },
    { label: `Array of ${n}, at ${fmtNum(dT, 3)} °C rise`, value: fmtNum(iArr, 3), unit: 'A', tone: I > 0 ? (iArr >= I ? 'ok' : 'bad') : undefined,
      hint: I > 0 ? `you need ${fmtNum(I, 3)} A` : undefined },
  ];
  if (I > 0) {
    values.push(
      { label: `Temperature rise at ${fmtNum(I, 3)} A`, value: fmtNum(rise, 3), unit: '°C', tone: rise <= dT ? 'ok' : rise <= 2 * dT ? 'warn' : 'bad', hint: `${fmtNum(iPer, 3)} A per via` },
      { label: 'Vias needed', value: String(Math.ceil(I / iOne - 1e-9)), hint: `for ≤ ${fmtNum(dT, 3)} °C rise` },
    );
    if (iArr < I) warnings.push(`${n} via${n > 1 ? 's' : ''} carry only ${fmtNum(iArr, 3)} A at ${fmtNum(dT, 3)} °C rise: use ${Math.ceil(I / iOne - 1e-9)} vias, a larger drill or thicker plating.`);
  }
  values.push(
    { label: 'Resistance, one via', value: fmtEng(rOne, 'Ω'), hint: `at ${fmtNum(tC, 3)} °C` },
    { label: `Resistance, array of ${n}`, value: fmtEng(rArr, 'Ω') },
  );
  if (I > 0) values.push({ label: 'Voltage drop', value: fmtEng(drop, 'V') }, { label: 'Power lost in the vias', value: fmtEng(pDiss, 'W') });
  values.push(
    { label: 'Thermal resistance, one via', value: fmtNum(rthOne, 3), unit: 'K/W', hint: f.name },
    { label: `Thermal resistance, array of ${n}`, value: fmtNum(rthArr, 3), unit: 'K/W' },
  );
  if (P > 0) values.push({ label: `Temperature drop across board at ${fmtNum(P, 3)} W`, value: fmtNum(P * rthArr, 3), unit: '°C',
    tone: P * rthArr < 10 ? 'ok' : P * rthArr < 30 ? 'warn' : 'bad', hint: 'barrel conduction only' });
  if (P > 0 && P * rthArr > 30) warnings.push(`${fmtNum(P * rthArr, 3)} °C across the board for ${fmtNum(P, 3)} W: add vias (under an exposed pad, a 1.0-1.2 mm grid of 0.3 mm vias is common) or fill them.`);

  // How the via count scales: current at dT and thermal resistance
  const ns = [1, 2, 4, 6, 9, 12, 16, 25];
  const rows = ns.map((m) => [m, fmtNum(iOne * m, 3), fmtEng(rOne / m, 'Ω'), fmtNum(rthOne / m, 3)]);
  // Drill size comparison at the same plating
  const drills = [0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0].filter((d) => d > 2 * tp + 0.02);
  const drows = drills.map((d) => {
    const a = (Math.PI / 4) * (d ** 2 - (d - 2 * tp) ** 2);
    return [`${d} mm`, fmtNum(a * MIL2_PER_MM2, 3), fmtNum(k * Math.pow(dT, 0.44) * Math.pow(a * MIL2_PER_MM2, 0.725), 3),
      fmtNum(1 / ((K_CU * a * 1e-6) / L + (f.k * (Math.PI / 4) * (d - 2 * tp) ** 2 * 1e-6) / L), 3)];
  });
  // Everything the page draws, as numbers (the calculation above, not a second one).
  const via = {
    drill, plating, tp, length, n, dT, k, layer: layer === 'internal' ? 'internal' : 'external', fill: FILLS[fill] ? fill : 'none', fillName: f.name,
    aMm2, aMil2, iOne, iArr, I, iPer, rise, needed: I > 0 ? Math.ceil(I / iOne - 1e-9) : null,
    tone: I > 0 ? (rise <= dT ? 'ok' : rise <= 2 * dT ? 'warn' : 'bad') : null,
    ta, tC, rOne, rArr, drop, pDiss, rthOne, rthArr, P, dTboard: P * rthArr,
    boardTone: P > 0 ? (P * rthArr < 10 ? 'ok' : P * rthArr < 30 ? 'warn' : 'bad') : null,
    drills: drills.map((d) => {
      const a = (Math.PI / 4) * (d ** 2 - (d - 2 * tp) ** 2);
      return { d, i: k * Math.pow(dT, 0.44) * Math.pow(a * MIL2_PER_MM2, 0.725),
        rth: 1 / ((K_CU * a * 1e-6) / L + (f.k * (Math.PI / 4) * (d - 2 * tp) ** 2 * 1e-6) / L) };
    }),
  };
  return {
    via,
    values,
    warnings,
    tables: [
      { title: `Via count: current at ${fmtNum(dT, 3)} °C rise, resistance, thermal resistance`, columns: ['Vias', 'Current (A)', 'Resistance', 'Rθ (K/W)'], rows },
      { title: `Drill size, with ${plating} micron plating, ${length} mm long`, columns: ['Drill', 'Area (mil²)', 'Current per via (A)', 'Rθ per via (K/W)'], rows: drows },
    ],
    charts: [{ title: 'Current per via against allowed temperature rise', type: 'line', x: [5, 10, 20, 30, 45, 60, 80, 100],
      series: [{ name: 'A per via', y: [5, 10, 20, 30, 45, 60, 80, 100].map((t) => Number(fmtNum(k * Math.pow(t, 0.44) * Math.pow(aMil2, 0.725), 3))) }], xLabel: 'rise (°C)', yLabel: 'A' }],
    notes: [
      'Area counts only the plated barrel wall, D = drilled hole; pads and fill are not counted for current.',
      'IPC-2221 was fitted to long traces; a short via sits between copper pads that sink heat, so real vias usually run cooler (conservative). IPC-2152 is the newer, less conservative basis.',
      'Current is assumed to split evenly: vias far from the entry point carry less; spread them along the current path.',
      'Thermal resistance is conduction along the barrel only (no spreading, no board). Copper k = 385 W/m·K; plated copper can be 10-20 % lower.',
    ],
  };
}
