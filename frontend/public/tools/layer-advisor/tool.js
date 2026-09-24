// Layer assignment for a given copper layer count: which layer carries signals,
// which is ground, which is power, and what each signal layer is referenced to.
// The stack-ups are the widely taught ones from H. W. Ott, "Electromagnetic
// Compatibility Engineering" (Wiley 2009), ch. 16 (PCB layout and stack-up), with
// the rules behind them (every signal layer next to a plane, power next to ground
// with thin dielectric, symmetric copper), also in E. Bogatin, "Signal and Power
// Integrity - Simplified" ch. 10 and Altium/IPC-2221B 4.x on symmetric build-ups.

// Roles: S = signal, G = ground plane, P = power plane, SP = signal with power pours, M = mixed (mostly ground pour)
const STACKS = {
  2: {
    general: ['S', 'M'],
    emc: ['S', 'M'],
  },
  4: {
    general: ['S', 'G', 'P', 'S'],
    emc: ['SP', 'G', 'G', 'SP'],
  },
  6: {
    general: ['S', 'G', 'S', 'S', 'P', 'S'],
    emc: ['S', 'G', 'S', 'P', 'G', 'S'],
  },
  8: {
    general: ['S', 'G', 'S', 'S', 'P', 'S', 'G', 'S'],
    emc: ['S', 'G', 'S', 'G', 'P', 'S', 'G', 'S'],
  },
  10: {
    general: ['S', 'G', 'S', 'S', 'G', 'P', 'S', 'S', 'G', 'S'],
    emc: ['S', 'G', 'S', 'G', 'S', 'P', 'G', 'S', 'G', 'S'],
  },
  12: {
    general: ['S', 'G', 'S', 'S', 'G', 'S', 'S', 'P', 'S', 'S', 'G', 'S'],
    emc: ['S', 'G', 'S', 'G', 'S', 'G', 'P', 'S', 'G', 'S', 'G', 'S'],
  },
};

const ROLE = {
  S: 'Signal',
  SP: 'Signal + power pours',
  G: 'Ground plane',
  P: 'Power plane',
  M: 'Ground pour + short routes',
};

const isPlane = (r) => r === 'G' || r === 'P' || r === 'M';
const isSignal = (r) => r === 'S' || r === 'SP';

export function run({ layers, priority, rails, fast }) {
  const n = Number(layers) || 4;
  const pr = priority === 'emc' ? 'emc' : 'general';
  const stack = STACKS[n]?.[pr];
  if (!stack) return { warnings: ['Pick a layer count of 2, 4, 6, 8, 10 or 12.'] };
  const nRails = Number.isFinite(rails) && rails >= 1 ? Math.round(rails) : 1;
  const warnings = [];
  const notes = [];

  const rows = [];
  const drawn = [];
  let referenced = 0, striplines = 0, dualStrip = 0;
  stack.forEach((r, i) => {
    const up = stack[i - 1], dn = stack[i + 1];
    const outer = i === 0 || i === n - 1;
    let ref = '–', use = '';
    if (isSignal(r)) {
      const refs = [up, dn].filter((x) => x && isPlane(x)).map((x) => (x === 'P' ? 'PWR' : 'GND'));
      const sigNext = [up, dn].some((x) => x && isSignal(x));
      if (refs.length) referenced++;
      if (!outer && refs.length === 2) striplines++;
      if (!outer && sigNext) dualStrip++;
      ref = refs.length ? refs.join(' + ') : 'none';
      if (outer) use = r === 'SP' ? 'Parts, short routes, power as wide pours; fill spare area with ground' : 'Parts, fan-out, short and slow routes; microstrip';
      else if (refs.length === 2 && !sigNext) use = 'Fast and sensitive nets (stripline, shielded both sides)';
      else use = 'Bulk routing, orthogonal to its neighbouring signal layer (dual stripline)';
      if (refs.length === 1 && refs[0] === 'PWR') use += '; return current goes via PWR, so keep decoupling near via transitions';
    } else if (r === 'G') use = 'Solid, unbroken reference; no routing, no splits';
    else if (r === 'P') use = nRails > 1 ? `Power islands for ${nRails} rails; keep fast signals off split edges` : 'One rail as a plane; tightly coupled to the ground next to it';
    else if (r === 'M') use = 'Keep as unbroken ground as you can; route only short jumps here';
    rows.push([`L${i + 1}${i === 0 ? ' (top)' : i === n - 1 ? ' (bottom)' : ''}`, ROLE[r], ref, use]);
    drawn.push({ layer: i + 1, role: r, name: ROLE[r], ref });
  });

  const sig = stack.filter(isSignal).length;
  const planes = stack.filter((r) => r === 'G' || r === 'P').length;
  const gnds = stack.filter((r) => r === 'G').length;
  const pours = stack.filter((r) => r === 'M').length;
  const pwrGndPairs = stack.reduce((k, r, i) => k + ((r === 'P' && (stack[i - 1] === 'G' || stack[i + 1] === 'G')) ? 1 : 0), 0);

  // Symmetry: the role pattern mirrored about the centre (for copper balance / warp).
  const kind = (r) => (r === 'G' || r === 'P' ? 'p' : 's');
  const unbalanced = stack.map((r, i) => i).filter((i) => i < n - 1 - i && kind(stack[i]) !== kind(stack[n - 1 - i]));
  const sym = unbalanced.length === 0;

  if (n === 2) {
    notes.push('Two layers: route almost everything on top and keep the bottom as one ground pour; every bottom-side jump cuts the return path, so keep jumps short and cross them at right angles.');
    if (fast) warnings.push('Fast edges on a 2-layer board: without a solid plane the loops are large and it will radiate. Go to 4 layers if the budget allows, or keep fast nets short, on top, over unbroken bottom ground.');
  }
  if (n === 4 && pr === 'general') notes.push('S-G-P-S: the L2-L3 core may be thick, but keep the L1-L2 and L3-L4 prepreg thin (≈0.1-0.2 mm) so the outer signals couple to their planes. L4 is referenced to PWR: add a decoupling cap next to each via that changes from L1 to L4.');
  if (n === 4 && pr === 'emc') notes.push('S-G-G-S: both routing layers reference ground, so layer changes need only a ground stitching via. Power is carried as wide pours or traces on the outer layers, and plane-to-plane decoupling capacitance is lost: rely on discrete capacitors.');
  if (nRails > 1 && !stack.includes('P')) notes.push(`${nRails} rails and no power plane: route them as pours or wide traces on the signal layers; use the Trace Width tool for their widths.`);
  if (nRails > 3 && stack.includes('P')) warnings.push(`${nRails} rails on one power plane means many islands. Do not route fast signals on a layer referenced to that plane across an island edge; either add a plane layer or reference fast signals to ground only.`);
  if (fast && pr === 'general' && n >= 6) notes.push('Fast edges: prefer the EMC arrangement, or at least route the fast nets on the stripline layers that sit between two planes.');
  for (const i of unbalanced) {
    const [a, b] = kind(stack[i]) === 's' ? [i, n - 1 - i] : [n - 1 - i, i];
    notes.push(`L${a + 1} (signal) mirrors L${b + 1} (plane): fill L${a + 1}'s spare area with ground pour so the copper is balanced and the board does not bow in reflow.`);
  }
  if (dualStrip) notes.push('Adjacent signal layers (dual stripline): route them orthogonally and separate them with a thicker dielectric than their plane spacing, to limit broadside crosstalk.');
  notes.push('Set the actual dielectric thicknesses and impedances with the Stack-up Designer and Impedance Calculator tools.');

  const prompt = `Layer assignment for a ${n}-layer board (${pr === 'emc' ? 'EMC / signal-integrity first' : 'routing capacity first'}):\n`
    + stack.map((r, i) => `- L${i + 1}: ${ROLE[r]}${isSignal(r) ? ` (reference: ${drawn[i].ref})` : ''}`).join('\n') + '\n';

  return {
    values: [
      { label: 'Signal layers', value: sig },
      { label: 'Plane layers', value: planes, hint: pours ? 'bottom is a ground pour, not a full plane' : `${gnds} ground, ${stack.filter((r) => r === 'P').length} power` },
      { label: 'Signal layers next to a plane or pour', value: `${referenced} / ${sig}`, tone: referenced === sig ? 'ok' : 'warn' },
      { label: 'Stripline layers', value: striplines, hint: dualStrip ? `${dualStrip} of the inner signal layers share a side with another signal layer` : 'none share a side with a signal layer' },
      { label: 'Power next to ground', value: stack.includes('P') ? (pwrGndPairs ? 'yes' : 'no') : 'no power plane', tone: stack.includes('P') && !pwrGndPairs ? 'warn' : undefined },
      { label: 'Copper symmetric', value: sym ? 'yes' : 'balance with pour', tone: sym ? 'ok' : 'warn', hint: sym ? 'planes mirror planes' : unbalanced.map((i) => `L${i + 1} / L${n - i}`).join(', ') },
    ],
    warnings,
    tables: [{ title: `${n} layers, ${pr === 'emc' ? 'EMC / signal-integrity first' : 'routing capacity first'}`, columns: ['Layer', 'Role', 'Reference', 'Use it for'], rows }],
    texts: [{ title: 'Stack-up', body: prompt }],
    notes,
    stack: drawn,
  };
}
