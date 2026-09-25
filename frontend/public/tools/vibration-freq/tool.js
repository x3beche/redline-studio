// First natural frequencies of beams and plates, for a quick "will it ring?"
// check.
//   Euler-Bernoulli beam (Blevins, Formulas for Natural Frequency and Mode
//   Shape, table 8-1):  f_i = lambda_i^2 / (2 pi L^2) * sqrt(E I / (rho A))
//   Beam with a point mass M (Rayleigh's method, Blevins table 8-8 / Thomson):
//     f = 1/(2 pi) sqrt(k / (M + c m_beam)), k and c per support case below.
//   Simply supported rectangular plate (Leissa, NASA SP-160, eq. 4.19):
//     f_mn = (pi/2) ((m/a)^2 + (n/b)^2) sqrt(D / (rho h)),  D = E h^3 / (12 (1 - nu^2))
//   Added component mass on a plate is smeared over its area (Steinberg,
//   Vibration Analysis for Electronic Equipment, ch. 6).
import { fmtNum } from '../kit/eng.js';

const MATERIALS = {
  steel: { name: 'Steel (carbon)', E: 200, rho: 7850, nu: 0.29 },
  stainless: { name: 'Stainless 304', E: 193, rho: 8000, nu: 0.29 },
  alu: { name: 'Aluminium 6061-T6', E: 68.9, rho: 2700, nu: 0.33 },
  ti: { name: 'Titanium Ti-6Al-4V', E: 113.8, rho: 4430, nu: 0.34 },
  brass: { name: 'Brass C360', E: 97, rho: 8500, nu: 0.31 },
  copper: { name: 'Copper C110', E: 117, rho: 8940, nu: 0.34 },
  fr4: { name: 'FR-4 (PCB)', E: 20, rho: 1850, nu: 0.14 },
  cfrp: { name: 'CFRP quasi-isotropic', E: 60, rho: 1550, nu: 0.3 },
  pla: { name: 'PLA (printed)', E: 3.5, rho: 1240, nu: 0.36 },
  abs: { name: 'ABS', E: 2.3, rho: 1050, nu: 0.35 },
  petg: { name: 'PETG', E: 2.1, rho: 1270, nu: 0.38 },
  pa12: { name: 'PA12 (SLS/MJF)', E: 1.7, rho: 1010, nu: 0.4 },
  pc: { name: 'Polycarbonate', E: 2.4, rho: 1200, nu: 0.37 },
};

// lambda_i for the first three bending modes (Blevins table 8-1).
const BEAMS = {
  cantilever: { name: 'Cantilever (fixed-free)', lam: [1.87510, 4.69409, 7.85476], k: 3, c: 0.2357, at: 'tip' },
  ss: { name: 'Simply supported beam', lam: [Math.PI, 2 * Math.PI, 3 * Math.PI], k: 48, c: 0.4857, at: 'centre' },
  fixed: { name: 'Fixed-fixed beam', lam: [4.73004, 7.85321, 10.99561], k: 192, c: 0.3714, at: 'centre' },
  free: { name: 'Free-free beam', lam: [4.73004, 7.85321, 10.99561], k: null, c: null, at: '' },
};

const f4 = (v) => fmtNum(v, 4);

// The length (mm) at which f(L) falls to fTarget; f falls as L grows.
function spanFor(fOfL, fTarget) {
  let lo = 1e-5, hi = 1e3;
  if (!(fOfL(lo) > fTarget)) return 0;
  if (fOfL(hi) > fTarget) return null;
  for (let i = 0; i < 80; i++) { const mid = Math.sqrt(lo * hi); if (fOfL(mid) > fTarget) lo = mid; else hi = mid; }
  return lo * 1000;
}

export function run(inp, nested = false) {
  const { shape, section, material, len, width, thick, dia, inner, E: Ec, rho: rhoc, nu: nuc, mass, target } = inp;
  const warnings = [];
  const notes = [];
  const m = material === 'custom' ? { name: 'Custom', E: Ec, rho: rhoc, nu: nuc ?? 0.3 } : MATERIALS[material] || MATERIALS.steel;
  if (!(m.E > 0) || !(m.rho > 0)) return { warnings: ['Give the custom material\'s Young\'s modulus (GPa) and density (kg/m³).'] };
  if (!(m.nu >= 0 && m.nu < 0.5)) return { warnings: ['Poisson\'s ratio must be between 0 and 0.5.'] };
  if (!(len > 0)) return { warnings: ['Give the length (span) in mm.'] };
  const E = m.E * 1e9, rho = m.rho, L = len / 1000;
  const M = mass > 0 ? mass / 1000 : 0;
  const isPlate = shape === 'plate';

  let f1, modes = [], massBody, extra = [], fOfL;
  let modeF = [], plateModes = null, massUsed = false;   // for the page's drawing (view)
  if (isPlate) {
    if (!(width > 0) || !(thick > 0)) return { warnings: ['Give the plate width and thickness in mm.'] };
    const a = L, b = width / 1000, h = thick / 1000;
    const D = (E * h ** 3) / (12 * (1 - m.nu ** 2));
    massBody = rho * a * b * h;
    const mu = (massBody + M) / (a * b);                 // mass per area, components smeared
    const fmn = (mm, nn, aa = a) => (Math.PI / 2) * ((mm / aa) ** 2 + (nn / b) ** 2) * Math.sqrt(D / mu);
    const list = [];
    for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) list.push({ i, j, f: fmn(i, j) });
    list.sort((x, y) => x.f - y.f);
    modes = list.slice(0, 5).map((x) => [`(${x.i},${x.j})`, `${x.i} × ${x.j} half-waves`, f4(x.f)]);
    plateModes = list.slice(0, 5);
    modeF = plateModes.map((x) => x.f);
    f1 = list[0].f;
    fOfL = (Lx) => fmn(1, 1, Lx);
    extra.push({ label: 'Flexural rigidity D', value: f4(D), unit: 'N·m' });
    if (Math.min(a, b) / h < 20) warnings.push(`The plate is thick (short side / thickness = ${f4(Math.min(a, b) / h)} < 20): thin-plate theory overestimates the frequency; treat it as an upper bound.`);
    notes.push('Plate: all four edges simply supported (a PCB in card guides or screwed along the edges). Clamped edges raise f1 by up to about 1.8x for a square; four corner screws only lower it well below this value.');
  } else {
    const bm = BEAMS[shape] || BEAMS.cantilever;
    let I, A, depthDim;
    if (section === 'round') {
      if (!(dia > 0)) return { warnings: ['Give the rod diameter in mm.'] };
      const Dm = dia / 1000; I = (Math.PI * Dm ** 4) / 64; A = (Math.PI * Dm ** 2) / 4; depthDim = dia;
    } else if (section === 'tube') {
      if (!(dia > 0) || !(inner >= 0)) return { warnings: ['Give the tube outer and inner diameters in mm.'] };
      if (inner >= dia) return { warnings: ['The inner diameter must be smaller than the outer diameter.'] };
      const Do = dia / 1000, Di = inner / 1000;
      I = (Math.PI * (Do ** 4 - Di ** 4)) / 64; A = (Math.PI * (Do ** 2 - Di ** 2)) / 4; depthDim = dia;
    } else {
      if (!(width > 0) || !(thick > 0)) return { warnings: ['Give the section width and thickness in mm.'] };
      const bb = width / 1000, hh = thick / 1000;
      I = (bb * hh ** 3) / 12; A = bb * hh; depthDim = thick;       // bending across the thickness
    }
    massBody = rho * A * L;
    const beamF = (lam, Lx) => ((lam ** 2) / (2 * Math.PI * Lx ** 2)) * Math.sqrt((E * I) / (rho * A));
    modes = bm.lam.map((lam, i) => [`${i + 1}`, `λ = ${f4(lam)}`, f4(beamF(lam, L))]);
    modeF = bm.lam.map((lam) => beamF(lam, L));
    f1 = beamF(bm.lam[0], L);
    fOfL = (Lx) => beamF(bm.lam[0], Lx);
    if (M > 0) {
      if (!bm.k) warnings.push('A point mass has no single place on a free-free beam; it is ignored. Add it to the density instead.');
      else {
        // Rayleigh: spring rate at the mass point and the beam's effective mass there.
        const k = (b) => (bm.k * E * I) / b ** 3;
        const fm = (Lx) => (1 / (2 * Math.PI)) * Math.sqrt(k(Lx) / (M + bm.c * rho * A * Lx));
        f1 = fm(L);
        fOfL = fm;
        modes[0][2] = `${f4(f1)} (with mass)`;
        modeF[0] = f1; massUsed = true;
        notes.push(`With the ${f4(mass)} g mass at the ${bm.at}: Rayleigh estimate, k = ${bm.k}EI/L³, effective beam mass ${bm.c} m. Higher modes are for the bare beam.`);
      }
    }
    extra.push({ label: 'Bending stiffness EI', value: f4(E * I), unit: 'N·m²' });
    if (len / depthDim < 10) warnings.push(`Short, deep beam (length / depth = ${f4(len / depthDim)} < 10): shear and rotary inertia lower the real frequency; take the result as an upper bound.`);
    notes.push(`${bm.name}; rectangular sections bend across the thickness (the thin direction).`);
  }
  if (!Number.isFinite(f1) || f1 <= 0) return { warnings: ['These dimensions do not give a frequency; check the inputs.'] };

  // Static sag of a single-DOF system with the same frequency: delta = g / w^2.
  const sag = 9.81 / (2 * Math.PI * f1) ** 2 * 1000;
  const values = [
    { label: 'First natural frequency', value: f4(f1), unit: 'Hz', tone: target > 0 ? (f1 >= 2 * target ? 'ok' : f1 >= target * Math.SQRT2 ? 'warn' : 'bad') : undefined,
      hint: target > 0 ? `${f4(f1 / target)}x the ${f4(target)} Hz excitation` : undefined },
    { label: 'Mass of the part', value: f4(massBody * 1000), unit: 'g', hint: m.name },
    { label: 'Equivalent static sag', value: f4(sag), unit: 'mm', hint: 'g / (2πf)²' },
    ...extra,
  ];
  if (target > 0) {
    if (f1 < target * Math.SQRT2) warnings.push(`f1 (${f4(f1)} Hz) is within √2 of the ${f4(target)} Hz excitation: resonance will amplify it. Stiffen (thicker, shorter span, more supports) or add mass to move f1 well away.`);
    else if (f1 < 2 * target) warnings.push(`f1 is under 2x (one octave above) the excitation: the usual design margin is f1 >= 2 x the highest forcing frequency.`);
  }
  // f1 against the span, 50 % to 200 % of the entered one.
  const xs = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((k) => k * len);
  const ys = xs.map((x) => fOfL(x / 1000));
  notes.push('Undamped, linear-elastic estimate for a first check; a real mount is less stiff than an ideal clamp, so measured frequencies are usually lower. Confirm critical parts with FEA or a tap test.');
  return {
    values,
    warnings,
    tables: [{ title: 'Modes', columns: ['Mode', isPlate ? 'Shape' : 'Eigenvalue', 'Frequency (Hz)'], rows: modes }],
    charts: [{ title: `First frequency against ${isPlate ? 'plate length' : 'span'}`, type: 'line', x: xs.map((x) => fmtNum(x, 3)), series: [{ name: 'f1', y: ys }], xLabel: 'length (mm)', yLabel: 'f1 (Hz)' }],
    notes,
    // Only for the page's drawing (manifest agentOmit): the same numbers as above, unformatted.
    view: {
      f1, target: target > 0 ? target : 0, modes: modeF, plate: plateModes, massG: massBody * 1000, sag,
      sweep: { x: xs, y: ys }, spanFor: target > 0 ? { twice: spanFor(fOfL, 2 * target), root2: spanFor(fOfL, Math.SQRT2 * target) } : null, withMass: massUsed, at: isPlate ? 'smeared' : (BEAMS[shape] || BEAMS.cantilever).at,
      material: m.name, E: m.E, rho: m.rho, nu: m.nu,
      // f1 of the same part in every listed material, for the material ladder.
      byMaterial: nested ? null : Object.entries(MATERIALS).map(([key, mm]) => ({ key, name: mm.name, E: mm.E, rho: mm.rho,
        f1: key === material ? f1 : run({ ...inp, material: key }, true).view?.f1 ?? null })),
    },
  };
}
