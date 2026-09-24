// Copper area as a PCB heat sink.
// Model: the pour is a round fin (same area, radius R) fed at a central
// disc the size of the package thermal pad (radius r0). Heat spreads through
// the copper (k = 385 W/m·K, thickness = layers × oz × 35 µm) and leaves the
// top and bottom faces by convection and radiation.
//   m   = sqrt(h_sum / (k·t))                         fin parameter, both faces
//   phi = (R/r0 - 1)(1 + 0.35 ln(R/r0))               Schmidt annular-fin approximation
//   eta = tanh(m·r0·phi) / (m·r0·phi)                 (Incropera, ch. 3)
//   θca = 1 / (eta · h_sum · A)
//   h_conv natural = 1.42 (ΔT/L)^0.25, forced = 3.93 sqrt(V/L)  (Ellison, simplified air)
//   h_rad = ε σ (Ts² + Ta²)(Ts + Ta), ε = 0.9 (solder mask)
//   One-layer boards: the bottom face is reached through 1.6 mm FR4 (k = 0.3).
import { fmtNum } from '../kit/eng.js';

const K_CU = 385, T_OZ = 35e-6, SIGMA = 5.670e-8, EPS = 0.9, T_FR4 = 1.6e-3, K_FR4 = 0.3;

/** θ copper-to-ambient (°C/W) and the film coefficients, for area/pad in m². */
function theta(p, ta, area, pad, oz, layers, air) {
  const t = layers * oz * T_OZ;
  const L = Math.sqrt(area); // characteristic length of the pour
  const R = Math.sqrt(area / Math.PI), r0 = Math.sqrt(Math.min(pad, area) / Math.PI);
  let dTs = 30, th = 0, eta = 1, hTop = 0, hSum = 0, hc = 0, hr = 0;
  for (let i = 0; i < 60; i++) {
    const ts = ta + 273.15 + dTs, tk = ta + 273.15;
    const hn = 1.42 * Math.pow(Math.max(dTs, 0.1) / L, 0.25);
    const hf = air > 0 ? 3.93 * Math.sqrt(air / L) : 0;
    hc = Math.max(hn, hf);
    hr = EPS * SIGMA * (ts * ts + tk * tk) * (ts + tk);
    hTop = hc + hr;
    const hBot = layers >= 2 ? hTop : 1 / (1 / hTop + T_FR4 / K_FR4);
    hSum = hTop + hBot;
    const m = Math.sqrt(hSum / (K_CU * t));
    if (R > r0 * 1.0001) {
      const ratio = R / r0;
      const phi = (ratio - 1) * (1 + 0.35 * Math.log(ratio));
      const x = m * r0 * phi;
      eta = x > 1e-9 ? Math.tanh(x) / x : 1;
    } else eta = 1;
    th = 1 / (eta * hSum * area);
    const next = eta * p * th; // mean surface rise ≈ η × rise at the pad
    if (Math.abs(next - dTs) < 0.01) { dTs = next; break; }
    dTs = 0.5 * dTs + 0.5 * next;
  }
  return { th, eta, hc, hr, hSum, dTs };
}

export function run({ p, ta, area, pad, oz, layers, tjc, tjmax, air }) {
  const warnings = [];
  if (!(p > 0)) return { warnings: ['Give the power dissipated in the part, in W (e.g. 1.5).'] };
  if (!(area > 0)) return { warnings: ['Give the copper area in mm² (645 mm² = 1 in²).'] };
  if (ta == null || !Number.isFinite(ta)) ta = 25;
  if (!(pad > 0)) { pad = 10; warnings.push('No thermal pad area given; 10 mm² assumed.'); }
  const ozN = Number(oz) || 1, nL = Number(layers) || 1;
  const vAir = air > 0 ? air : 0;
  const rjc = tjc >= 0 ? tjc : 0;
  const tmax = tjmax > ta ? tjmax : null;
  if (tjmax != null && !(tjmax > ta)) warnings.push('Max junction must be above ambient; the margin checks are skipped.');
  if (pad > area) warnings.push(`The pad (${fmtNum(pad)} mm²) is bigger than the copper area: the copper is taken as just the pad.`);
  if (vAir > 10) warnings.push('Over 10 m/s the laminar forced-air formula is outside its range; treat the result as optimistic.');
  if (area > 20000) warnings.push('Beyond about 20 000 mm² the pour stops helping (low fin efficiency) and the board itself dominates; model the whole board instead.');

  const mm2 = 1e-6;
  const at = (P, A) => theta(P, ta, A * mm2, pad * mm2, ozN, nL, vAir);
  const r = at(p, area);
  const tBoard = ta + p * r.th;
  const tj = tBoard + p * rjc;

  // Power allowed at this area, and area needed at this power (bisection; θ falls slowly as P rises).
  let pMax = null, aNeed = null;
  if (tmax) {
    let lo = 0, hi = 1000;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; const t = ta + m * (at(m, area).th + rjc); if (t > tmax) hi = m; else lo = m; }
    pMax = lo;
    if (ta + p * (at(p, 1e6).th + rjc) > tmax) aNeed = Infinity;
    else {
      let a = Math.max(pad, 1), b = 1e6;
      for (let i = 0; i < 80; i++) { const m = Math.sqrt(a * b); const t = ta + p * (at(p, m).th + rjc); if (t > tmax) a = m; else b = m; }
      aNeed = b;
    }
  }

  const margin = tmax ? tmax - tj : null;
  const tone = margin == null ? undefined : margin < 0 ? 'bad' : margin < 15 ? 'warn' : 'ok';
  if (margin != null && margin < 0) {
    warnings.push(`Junction reaches ${fmtNum(tj, 3)} °C, over the ${fmtNum(tmax)} °C limit. ${Number.isFinite(aNeed) ? `Use about ${fmtNum(aNeed, 2)} mm² of copper, ` : 'No copper area alone is enough: add a heat sink, '}add stitched layers or air flow, or cut the power.`);
  } else if (margin != null && margin < 15) {
    warnings.push(`Only ${fmtNum(margin, 2)} °C of margin: datasheet θJB and real ambient vary; aim for 15–20 °C.`);
  }
  if (r.eta < 0.4) warnings.push(`Fin efficiency is only ${Math.round(r.eta * 100)} %: the far copper barely helps. Thicker copper or more stitched layers help more than more area.`);

  const sweep = [50, 100, 200, 400, 645, 1000, 1500, 2500, 5000, 10000].filter((a) => a >= pad);
  const pts = sweep.map((a) => { const q = at(p, a); return { a, th: q.th, tj: ta + p * (q.th + rjc), eta: q.eta }; });

  return {
    values: [
      { label: 'Copper to ambient θ', value: fmtNum(r.th, 3), unit: '°C/W' },
      { label: 'Junction to ambient θ', value: fmtNum(r.th + rjc, 3), unit: '°C/W' },
      { label: 'Board under the part', value: fmtNum(tBoard, 3), unit: '°C' },
      { label: 'Junction', value: fmtNum(tj, 3), unit: '°C', tone, hint: tmax ? `limit ${fmtNum(tmax)} °C` : undefined },
      { label: 'Margin', value: margin == null ? '–' : fmtNum(margin, 3), unit: '°C', tone },
      { label: 'Power allowed here', value: pMax == null ? '–' : fmtNum(pMax, 3), unit: 'W', hint: 'junction at the limit' },
      { label: 'Area needed', value: aNeed == null ? '–' : Number.isFinite(aNeed) ? fmtNum(aNeed, 3) : 'not reachable', unit: Number.isFinite(aNeed) ? 'mm²' : undefined, hint: `for ${fmtNum(p, 3)} W` },
      { label: 'Fin efficiency', value: `${Math.round(r.eta * 100)} %`, hint: `h ${fmtNum(r.hc, 2)} conv + ${fmtNum(r.hr, 2)} rad W/m²K per face` },
    ],
    warnings,
    charts: pts.length > 1 ? [{ title: `Junction temperature against copper area at ${fmtNum(p, 3)} W`, type: 'line',
      x: pts.map((q) => `${q.a}`), series: [{ name: 'Tj °C', y: pts.map((q) => Number(q.tj.toFixed(1))) }],
      xLabel: 'copper area, mm²', yLabel: 'junction, °C' }] : [],
    tables: [{
      title: 'Area sweep',
      columns: ['Area mm²', 'Side (square) mm', 'θ copper-amb °C/W', 'Junction °C', 'Fin eff.'],
      rows: pts.map((q) => [q.a, fmtNum(Math.sqrt(q.a), 3), fmtNum(q.th, 3), fmtNum(q.tj, 3), `${Math.round(q.eta * 100)} %`]),
    }],
    notes: [
      'Assumes the copper is a solid pour centred on the part, the board is vertical in free air, solder-mask emissivity 0.9, and no other hot parts nearby.',
      'The bare FR4 around the pour and the traces leaving it also shed heat, so real boards usually run somewhat cooler, most for small pours.',
      'Stitched layers assume enough thermal vias under the pad (roughly 9+ vias of 0.3 mm) that the layers sit at one temperature.',
    ],
  };
}
