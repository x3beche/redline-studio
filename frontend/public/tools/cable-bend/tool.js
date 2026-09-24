// Minimum bend radius of a cable, and the room a bend needs.
//   R_min (inside of the bend) = multiplier × OD   (or × thickness for flat cable)
//   centre-line radius = R_min + OD/2;   outside radius = R_min + OD
//   arc length of cable in the bend = θ · (R_min + OD/2)
//   depth behind a panel for a 90° turn = straight lead-out + R_min + OD
//   width of a 180° loop (U-turn) = 2·R_min + 2·OD
// Multipliers are the usual values of the named standards / cable makers;
// the cable's own datasheet always wins.
import { fmtNum } from '../kit/eng.js';

// [label, fixed multiplier, flexing multiplier, basis, based on]
// basis 'od' = outside diameter, 'thk' = thickness (flat cables)
export const TYPES = {
  pvcPower: ['PVC power cable, non-armoured', (d) => (d <= 10 ? 3 : d <= 25 ? 4 : 6), (d) => 15, 'od', 'BS 7671 On-Site Guide table (3/4/6 × OD by size); flexing: maker datasheets'],
  armoured: ['Armoured power cable (SWA)', () => 6, null, 'od', 'BS 7671 On-Site Guide; SWA is not for flexing'],
  control: ['Flexible control cable, unscreened (PVC)', () => 4, () => 15, 'od', 'Lapp ÖLFLEX CLASSIC 110 datasheet: 4 × fixed, 15 × occasional flexing'],
  controlScr: ['Flexible control cable, screened (braid)', () => 6, () => 20, 'od', 'Lapp ÖLFLEX CLASSIC 110 CY datasheet: 6 × fixed, 20 × flexing'],
  chain: ['Drag-chain (continuous flex) cable', () => 4, () => 10, 'od', 'igus chainflex / Lapp ÖLFLEX CHAIN: about 4 × fixed, 7.5-10 × in the chain'],
  hookup: ['Single stranded hook-up wire (UL1007/1015)', () => 5, () => 10, 'od', 'Rule of thumb'],
  silicone: ['Silicone test-lead / high-flex wire', () => 3, () => 6, 'od', 'Rule of thumb for fine-strand silicone wire'],
  utp: ['Ethernet UTP (Cat5e/6), 4-pair', () => 4, () => 8, 'od', 'ANSI/TIA-568.2-D: 4 × OD for UTP; flexing: patch cords rule of thumb'],
  stp: ['Ethernet screened (F/UTP, S/FTP), 4-pair', () => 8, () => 10, 'od', 'ANSI/TIA-568.2-D: 8 × OD for screened cable'],
  multipair: ['Multi-pair backbone (> 4 pairs)', () => 10, null, 'od', 'ANSI/TIA-568.2-D: 10 × OD'],
  coax: ['Coax (RG58, RG174, RG316)', () => 5, () => 10, 'od', 'Typical coax datasheets: 5 × OD installed, 10 × repeated'],
  semirigid: ['Semi-rigid coax (.086, .141)', () => 2.5, null, 'od', 'Typical datasheet: bent once, on a mandrel'],
  usb: ['USB / HDMI round cable', () => 5, () => 10, 'od', 'Rule of thumb from cable-assembly datasheets'],
  fibre: ['Fibre optic cable', () => 10, () => 20, 'od', 'ANSI/TIA-568.3-D: 10 × OD unloaded, 20 × under pulling tension'],
  ffc: ['FFC / flat flex cable', () => 3, () => 30, 'thk', 'Rule of thumb from FFC maker datasheets (static fold vs. repeated flex)'],
  fpc1: ['Flex PCB, 1 copper layer', () => 6, () => 100, 'thk', 'IPC-2223: 3-6 × thickness static, 100 × dynamic'],
  fpc2: ['Flex PCB, 2 copper layers', () => 10, () => 150, 'thk', 'IPC-2223: 7-10 × static, 150 × dynamic'],
  fpcN: ['Flex PCB, multilayer', () => 20, null, 'thk', 'IPC-2223: 10-15 × static (20 × used here); dynamic not recommended'],
  custom: ['Custom multiplier', null, null, 'od', 'Typed in'],
};
const CHAIN_R = [18, 28, 38, 48, 55, 63, 75, 100, 125, 150, 175, 200, 250, 300]; // igus E-chain bend radii, mm
const f = (v, d = 4) => fmtNum(v, d);

export function run({ type, od, use, mult, angle, straight, temp }) {
  const warnings = [];
  const T = TYPES[type] || TYPES.control;
  if (!(od > 0)) return { warnings: [`Give the cable ${T[3] === 'thk' ? 'thickness' : 'outside diameter'} in mm.`] };
  let k;
  const basis = T[4];
  const flexing = use === 'flex';
  if (type === 'custom') {
    if (!(mult > 0)) return { warnings: ['Give the multiplier from the cable datasheet, e.g. 7.5 (× OD).'] };
    k = mult;
  } else if (flexing && !T[2]) {
    k = T[1](od);
    warnings.push(`${T[0]} is not made for repeated flexing: use a flexible or drag-chain type where it moves. The fixed-installation radius is shown.`);
  } else {
    k = (flexing ? T[2] : T[1])(od);
  }
  const th = Math.min(Math.max(angle > 0 ? angle : 90, 1), 180) * Math.PI / 180;
  if (angle == null) warnings.push('No bend angle given: 90° is used.');
  else if (!(angle >= 1 && angle <= 180)) warnings.push(`A ${f(angle)}° bend is outside 1-180°: ${f((th * 180) / Math.PI)}° is used. Split a longer turn into bends of 180° or less.`);
  const L0 = straight >= 0 ? straight : 0;
  const R = k * od;
  const Rc = R + od / 2, Ro = R + od;
  const arc = th * Rc;
  const depth = L0 + Ro; // 90° turn away from a panel: straight + inside radius + the cable itself
  const loop = 2 * R + 2 * od;
  const flat = T[3] === 'thk';
  const values = [
    { label: 'Minimum bend radius (inside)', value: f(R), unit: 'mm', tone: 'ok', hint: `${f(k, 3)} × ${flat ? 'thickness' : 'OD'}` },
    { label: 'Centre-line radius', value: f(Rc), unit: 'mm' },
    { label: 'Outside radius', value: f(Ro), unit: 'mm' },
    { label: `Cable length in a ${f((th * 180) / Math.PI, 3)}° bend`, value: f(arc), unit: 'mm', hint: 'along the centre line' },
    { label: 'Depth behind a panel, 90° turn', value: f(depth), unit: 'mm', hint: `${f(L0)} mm straight + R + ${flat ? 'thickness' : 'OD'}` },
    { label: 'Width of a 180° loop', value: f(loop), unit: 'mm', hint: 'outside to outside' },
  ];
  if (flexing && !flat && T[2]) {
    const kr = CHAIN_R.find((r) => r >= R);
    values.push({ label: 'Drag-chain radius (next size up)', value: kr ? f(kr) : `> ${CHAIN_R[CHAIN_R.length - 1]}`, unit: kr ? 'mm' : 'mm', hint: 'igus E-chain KR series' });
  }
  if (L0 < od && !flat) warnings.push(`Only ${f(L0)} mm straight after the connector or gland: keep at least about 1-2 × OD (${f(od)}-${f(2 * od)} mm) straight so the bend does not load the strain relief or the contacts.`);
  if (temp != null && temp < -5 && !flat && /PVC|control|power|hook-up|USB/.test(T[0])) warnings.push(`At ${f(temp, 3)} °C PVC jackets stiffen and can crack: most PVC cables may only be bent above about −5 °C (fixed laying can go colder). Warm the cable before installing, or choose PUR/TPE.`);
  if (flat && flexing && !/Flex PCB, 1|FFC/.test(T[0])) warnings.push('For a dynamic flex, put the bend area in a single copper layer with the copper on the neutral axis, no vias and no plated features: IPC-2223.');
  const rows = Object.entries(TYPES).filter(([key]) => key !== 'custom' && TYPES[key][3] === T[3]).map(([key, t]) => {
    const kf = t[1](od), kd = t[2] ? t[2](od) : null;
    return [t[0], `${f(kf, 3)} ×`, f(kf * od), kd ? `${f(kd, 3)} ×` : '–', kd ? f(kd * od) : '–'];
  });
  return {
    values, warnings,
    tables: [{ title: `The same ${f(od)} mm ${flat ? 'thick' : 'OD'} as other cable types (inside radius, mm)`, columns: ['Cable type', 'Fixed', 'Fixed R', 'Flexing', 'Flexing R'], rows }],
    notes: [
      `Basis: ${basis}.`,
      'The minimum bend radius is to the inside of the bend in most datasheets; a few quote the centre line - check which.',
      flexing ? 'Flexing radii are for many cycles at moderate speed; in a drag chain also leave 10-20 % free space around each cable.' : 'Fixed means bent once and clamped; while pulling a cable in, use about twice the radius.',
    ],
  };
}
