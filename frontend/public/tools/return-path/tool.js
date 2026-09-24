// Return-path problems: where a signal's return current cannot follow it, and
// how many stitching vias (or capacitors) it needs where it changes layers.
//
// Formulas:
//   Knee frequency           f_knee = 0.5 / t_r (10-90 %)       Johnson & Graham, High-Speed Digital Design, 1.1
//                            (0.35 / t_r is the -3 dB bandwidth; the knee is the conservative bound)
//   Wavelength in the board  λ = c / (f · √εr)
//   Stitching-via pitch      ≤ λ / 20 at f_knee                 common EMC rule (Ott, EMC Engineering, 16.x;
//                                                              Archambeault, PCB Design for Real-World EMI Control)
//   Signal/return via loop   L = (µ0 · l / π) · acosh(s / 2r)    two parallel round conductors, length l,
//                                                              centre spacing s, radius r (Grover / Paul,
//                                                              Inductance: Loop and Partial, ch. 5)
//   Reactance                X = 2π · f_knee · L; kept below 10 % of Z0 so the via looks like a small discontinuity
//                            (rule of thumb, Bogatin, Signal and Power Integrity - Simplified, ch. 10)
import { fmtEng, fmtNum } from '../kit/eng.js';

const MU0 = 4e-7 * Math.PI;
const C0 = 299792458;

// key, label, what happens to the return current, the fix, severity, needs: 'via' | 'cap' | 'none' | 'edge'
export const CASES = [
  ['same-plane', 'Layer change around one shared plane (e.g. L1 -> L3, both on L2 GND)',
    'The return current moves from one face of the plane to the other through the anti-pad around the signal via: the path stays short.',
    'Nothing extra needed. Keep the anti-pad small and do not let anti-pads merge into a slot.', 'low', 'none'],
  ['gnd-gnd', 'Layer change between two different ground planes',
    'The return current has to jump between the two ground planes. With no ground via nearby it spreads through the plane cavity and couples to every other via there.',
    'Put a ground stitching via next to each signal via (distance below). Differential pairs: one ground via beside the pair on each side.', 'medium', 'via'],
  ['gnd-pwr', 'Layer change from a GND-referenced layer to a PWR-referenced layer',
    'The return current must cross from ground to power: it can only do so through a capacitor (a decoupling cap or the plane pair capacitance).',
    'Place a 10-100 nF capacitor between the two planes right next to the via, or better: route fast nets only on layers referenced to ground.', 'high', 'cap'],
  ['pwr-pwr', 'Layer change between two different power planes (different rails)',
    'The return current has to pass from one rail to the other, through two capacitors to ground: a long, noisy path.',
    'Avoid it for anything fast. If it must happen, add a cap from each rail to ground at the via, or a cap between the two rails.', 'high', 'cap'],
  ['split', 'Trace crosses a split or gap in its reference plane',
    'The return current cannot cross the gap; it detours around the end of the split. The large loop radiates and picks up noise (a slot antenna).',
    'Re-route around the split, or move the trace to a layer with an unbroken reference. If unavoidable, a stitching capacitor (1-10 nF) across the gap right at the crossing.', 'high', 'cap'],
  ['slot', 'Trace runs over a slot or void (merged anti-pads, cut-out, connector pin field)',
    'Same as a split: the return current detours around the void, raising inductance and crosstalk to other traces that share the detour.',
    'Shrink anti-pads so plane copper remains between vias (web ≥ 0.15-0.2 mm), or route around the void.', 'medium', 'none'],
  ['edge', 'Trace near the edge of its reference plane or the board',
    'Part of the field has no plane under it: impedance rises and the trace radiates from the edge.',
    'Keep the trace at least 3 dielectric heights (better 5) inside the plane edge; stitch the plane edge with ground vias at the pitch below.', 'medium', 'edge'],
  ['connector', 'Signal passes through a connector or to another board',
    'The return current can only use the ground pins of the connector. Few or distant ground pins make a big loop and ground bounce.',
    'Give fast signals an adjacent ground pin (ratio 1:1 to 2:1 signal:ground), and stitch the connector ground pins to every ground plane.', 'high', 'via'],
  ['no-plane', 'No plane under the trace (2-layer board, unpoured area)',
    'The return current takes whatever path it finds: another trace, a pour far away. The loop area is uncontrolled.',
    'Pour ground under and beside the trace and stitch the pours; route a ground trace alongside critical nets; or move to 4 layers.', 'high', 'none'],
];

export function run({ scenario, filter, tr, er, z0, thick, drill, dist, nvias, h, clearance }) {
  const c = CASES.find((k) => k[0] === scenario) || CASES[1];
  const warnings = [];
  const notes = [];
  if (!(tr > 0)) return { warnings: ['Give the signal rise time in ns, e.g. 1.'] };
  if (!(er >= 1 && er <= 15)) return { warnings: ['Give the dielectric constant εr between 1 and 15 (FR-4 is about 4.2).'] };
  const t = tr * 1e-9;
  // Johnson & Graham: f_knee = 0.5 / tr
  const fk = 0.5 / t;
  const lam = C0 / (fk * Math.sqrt(er));
  const pitch = lam / 20;
  const values = [
    { label: 'Knee frequency', value: fmtEng(fk, 'Hz'), hint: '0.5 / rise time' },
    { label: 'Wavelength at knee', value: fmtNum(lam * 1e3, 3), unit: 'mm', hint: `in εr ${fmtNum(er, 3)}` },
    { label: 'Stitching-via pitch', value: fmtNum(pitch * 1e3, 3), unit: 'mm', hint: 'λ/20: plane edges, fences, pours' },
  ];

  const kind = c[5];
  if (kind === 'via' || kind === 'cap') {
    const ok = thick > 0 && drill > 0 && dist > 0 && z0 > 0;
    if (!ok) warnings.push('Give board thickness, via drill, via distance and trace impedance (all above zero) to size the return via.');
    else {
      const r = (drill / 2) * 1e-3, s = dist * 1e-3, l = thick * 1e-3;
      if (s <= 2 * r) warnings.push(`The return via at ${fmtNum(dist, 3)} mm overlaps a ${fmtNum(drill, 3)} mm drill: give the centre-to-centre distance.`);
      else {
        // Loop inductance of the signal via and its return via (two parallel wires).
        const L = (MU0 * l / Math.PI) * Math.acosh(s / (2 * r));
        const X = 2 * Math.PI * fk * L;
        const frac = X / z0;
        // Largest spacing that keeps X <= 10 % Z0: invert the acosh.
        const argMax = (0.1 * z0) / (2 * Math.PI * fk) / (MU0 * l / Math.PI);
        const sMax = 2 * r * Math.cosh(Math.min(argMax, 20));
        const perVia = Math.max(1, Math.floor(0.1 * z0 / X));
        const n = Number.isFinite(nvias) && nvias >= 1 ? Math.round(nvias) : 1;
        const need = Math.ceil(n / perVia);
        // Closest two vias can practically sit: 0.15 mm rings and a 0.15 mm gap.
        const sMin = (drill + 0.45) * 1e-3;
        const reach = sMax >= sMin;
        values.push(
          { label: kind === 'cap' ? 'Via-to-capacitor loop' : 'Signal/return via loop', value: fmtEng(L, 'H'), hint: `${fmtNum(dist, 3)} mm apart, ${fmtNum(thick, 3)} mm long` },
          { label: 'Its reactance at knee', value: fmtNum(X, 3), unit: 'Ω', tone: frac <= 0.1 ? 'ok' : frac <= 0.2 ? 'warn' : 'bad', hint: `${fmtNum(frac * 100, 2)} % of ${fmtNum(z0, 3)} Ω` },
          { label: kind === 'cap' ? 'Capacitor within' : 'Return via within', value: reach ? fmtNum(Math.min(sMax, pitch) * 1e3, 3) : 'not reachable', unit: reach ? 'mm' : '', tone: reach ? 'ok' : 'bad', hint: Math.min(sMax, pitch) > 3e-3 ? 'electrical limit; still place it within ~2 mm, it costs nothing' : 'keeps X ≤ 10 % Z0 (and ≤ λ/20)' },
          { label: kind === 'cap' ? 'Capacitors needed' : 'Return vias needed', value: need, hint: perVia > 1 ? `for ${n} signal via${n > 1 ? 's' : ''}; each can serve ${perVia} at this distance` : `one per signal via (${n})` },
        );
        if (!reach) warnings.push(`At ${fmtEng(fk, 'Hz')} even a return via ${fmtNum(sMin * 1e3, 2)} mm away (the closest that fits) exceeds 10 % of Z0: the ${fmtNum(thick, 3)} mm via itself is too long for this edge. Use blind or back-drilled vias, a thinner board, or keep the net on one layer.`);
        else if (frac > 0.1) warnings.push(`At ${fmtNum(dist, 3)} mm the return loop is ${fmtNum(frac * 100, 2)} % of Z0 at the knee frequency: move the ${kind === 'cap' ? 'capacitor' : 'return via'} within ${fmtNum(sMax * 1e3, 2)} mm of the signal via.`);
        if (kind === 'cap') notes.push('The capacitor adds its own mounting inductance (≈0.5-1 nH for an 0402 with short vias): use the smallest package and put its vias next to its pads.');
      }
    }
  }
  if (kind === 'edge') {
    if (!(h > 0)) warnings.push('Give the dielectric height from the trace to its plane in mm.');
    else {
      values.push({ label: 'Keep inside plane edge', value: fmtNum(3 * h, 3), unit: 'mm', hint: `3 h; 5 h = ${fmtNum(5 * h, 3)} mm is better` });
      if (clearance >= 0 && clearance < 3 * h) warnings.push(`The trace is ${fmtNum(clearance, 3)} mm from the plane edge, under 3 × ${fmtNum(h, 3)} mm: move it inward or extend the plane.`);
      else if (clearance >= 0) values.push({ label: 'Your clearance', value: fmtNum(clearance, 3), unit: 'mm', tone: clearance >= 5 * h ? 'ok' : 'warn' });
    }
  }
  if (c[4] === 'high') warnings.push(`${c[1]}: ${c[3]}`);

  const q = String(filter || '').trim().toLowerCase();
  const rows = CASES.filter((k) => !q || k.slice(1, 4).join(' ').toLowerCase().includes(q))
    .map((k) => [k[0] === c[0] ? `▶ ${k[1]}` : k[1], k[2], k[3], k[4]]);
  if (q && !rows.length) warnings.push(`Nothing in the table matches "${filter}": clear the filter to see every case.`);
  if (tr < 0.05) warnings.push('Rise times under 50 ps: via stubs and anti-pad shape matter as much as the return via; simulate the transition.');
  notes.push('Rise time is 10-90 %. For a slow part driving a long trace, use the driver\'s actual edge, not the clock period: the edge sets the frequency content.');
  notes.push('The via loop model is two parallel round conductors the length of the board; plane spreading inductance adds to it, so treat the result as a lower bound.');

  return {
    values: [{ label: 'Case', value: c[4] === 'high' ? 'serious' : c[4] === 'medium' ? 'needs care' : 'fine', tone: c[4] === 'high' ? 'bad' : c[4] === 'medium' ? 'warn' : 'ok', hint: c[1] }, ...values],
    warnings,
    tables: [
      { title: 'This case', columns: ['What happens', 'Fix'], rows: [[c[2], c[3]]] },
      { title: q ? `Return-path cases matching "${filter}"` : 'All return-path cases', columns: ['Situation', 'Return current', 'Fix', 'Severity'], rows },
    ],
    notes,
  };
}
