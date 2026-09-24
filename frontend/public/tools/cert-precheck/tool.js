// Certification pre-check: the usual gaps that fail or delay CE / FCC testing
// of a small electronic product, as a checklist.
// Sources for the items (which rule each one serves):
//   EU  EMC Directive 2014/30/EU - EN 55032 (emissions, CISPR 32), EN 55035 (immunity,
//       with IEC 61000-4-2 ESD, -4-4 EFT, -4-5 surge); LVD 2014/35/EU with IEC/EN 62368-1;
//       RED 2014/53/EU with EN 300 328, EN 301 489-1/-17, EN 62311 / EN 62479 (RF exposure);
//       CE marking per Regulation (EC) 765/2008 and Decision 768/2008 Annex II (5 mm minimum);
//       WEEE 2012/19/EU (crossed-out bin, EN 50419), RoHS 2011/65/EU.
//   US  47 CFR Part 15: 15.19 (label statement), 15.105 (user information), 15.107 / 15.109
//       (conducted / radiated limits, Subpart B), Subpart C (intentional radiators),
//       2.1093 / 1.1310 (RF exposure), KDB 996369 (modular transmitter integration),
//       2.1074 (Supplier's Declaration of Conformity identification).
// The design items (filters, ground, ESD) are the common causes of failed pre-scans:
// rule of thumb from EMC practice (Ott, "Electromagnetic Compatibility Engineering").

// key, group, item, why, markets ('ce'|'fcc'|'both'), applies ('all'|'mains'|'wired'|'battery'|'radio'|'module'|'discrete'|'lowv'), critical, short name
export const ITEMS = [
  ['f_input', 'EMC filtering', 'Power input filtered: ferrite or common-mode choke plus bulk and 100 nF caps at the connector',
    'Conducted emissions are measured on the power leads (EN 55032 / FCC 15.107, 150 kHz-30 MHz); switcher noise leaves the board there first.', 'both', 'wired', true, 'Power input filter'],
  ['f_cables', 'EMC filtering', 'Every cable leaving the enclosure is filtered or shielded at its connector',
    'Cables are the antennas for radiated emissions at 30-300 MHz; an unfiltered USB or sensor lead is the classic radiated fail.', 'both', 'all', true, 'Cables filtered/shielded'],
  ['f_decouple', 'EMC filtering', 'Each IC supply pin has its own 100 nF cap with a short loop to ground',
    'Supply-pin current spikes with a long loop radiate at clock harmonics and couple into everything on the rail.', 'both', 'all', false, 'Per-pin decoupling'],
  ['f_edges', 'EMC filtering', 'Fast clock and data edges slowed (22-33 Ω series resistors, lowest drive strength)',
    'Edge rate, not clock frequency, sets how far up the harmonics reach; slower edges cost nothing at low speeds.', 'both', 'all', false, 'Edges slowed'],
  ['f_switcher', 'EMC filtering', 'Switching regulator: hot loop tight, inductor shielded, frequency or spread-spectrum chosen',
    'A DC/DC hot loop is a small loop antenna at tens of MHz; its harmonics are often the highest peak in the scan.', 'both', 'all', false, 'DC/DC hot loop tight'],
  ['g_plane', 'Grounding & layout', 'Solid ground plane under all fast signals, no splits or slots crossed',
    'A signal crossing a split has no return path under it; the loop it makes radiates and picks up ESD.', 'both', 'all', true, 'Solid ground plane'],
  ['g_shield', 'Grounding & layout', 'Connector shields bonded to ground or chassis right at the connector (360° where possible)',
    'A shield bonded through a pigtail or far from the connector carries noise current onto the cable instead of stopping it.', 'both', 'all', false, 'Shields bonded at connector'],
  ['g_edge', 'Grounding & layout', 'Board edge stitched with ground vias; fast traces kept 3× their height from the edge',
    'Traces at the board edge fringe out and radiate; edge stitching closes the plane pair.', 'both', 'all', false, 'Edge via stitching'],
  ['g_crystal', 'Grounding & layout', 'Crystal next to its IC, guarded by ground, nothing routed under it',
    'The oscillator is a continuous narrowband source; long crystal traces show up as clean peaks at its harmonics.', 'both', 'all', false, 'Crystal guarded'],
  ['e_esd', 'ESD & immunity', 'TVS / ESD diodes on every connector, button and touchable metal',
    'EN 55035 applies IEC 61000-4-2 ESD: ±4 kV contact, ±8 kV air. A reset or latch-up during the test is a fail.', 'ce', 'all', true, 'ESD diodes'],
  ['e_reset', 'ESD & immunity', 'Reset and boot pins pulled and filtered, no long unfiltered traces to them',
    'A floating or long reset line picks up ESD and EFT pulses and restarts the device mid-test.', 'ce', 'all', false, 'Reset/boot filtered'],
  ['e_surge', 'ESD & immunity', 'Surge and burst protection on mains and long cable (> 3 m) ports',
    'IEC 61000-4-4 (EFT) and -4-5 (surge) apply to these ports under EN 55035; without an MOV/TVS the input stage fails.', 'ce', 'wired', false, 'Surge/EFT protection'],
  ['e_recover', 'ESD & immunity', 'Firmware recovers by itself: watchdog on, no state lost silently',
    'Immunity criteria A/B allow a glitch that self-recovers; a hang that needs a power cycle is criterion C and usually a fail.', 'ce', 'all', false, 'Self-recovery'],
  ['s_creepage', 'Safety', 'Creepage and clearance between mains and SELV meet IEC 62368-1 (reinforced insulation)',
    'The LVD applies from 50 V AC / 75 V DC; mains-to-user spacing is checked first and cannot be fixed without a respin.', 'both', 'mains', true, 'Mains creepage/clearance'],
  ['s_fuse', 'Safety', 'Mains input fused, fuse rating marked next to it',
    'IEC 62368-1 single-fault testing shorts parts; without a fuse the fault becomes a fire.', 'both', 'mains', true, 'Mains fuse'],
  ['s_adapter', 'Safety', 'External power adapter is itself certified (CE / FCC marked, with its DoC)',
    'Using a certified adapter keeps mains safety out of your test scope; an unmarked adapter brings it back in.', 'both', 'lowv', false, 'Certified adapter'],
  ['s_battery', 'Safety', 'Lithium cell has a protection circuit and IEC 62133-2 and UN 38.3 reports',
    'Test labs and carriers ask for these reports; shipping lithium without UN 38.3 is not allowed.', 'both', 'battery', true, 'Li cell PCM + reports'],
  ['r_grant', 'Radio', 'Radio module used within its grant: its certified antenna, its trace layout, no firmware power changes',
    'Staying within the module\'s FCC grant / RED certificate lets you reuse its radio tests (FCC KDB 996369).', 'both', 'module', true, 'Module within its grant'],
  ['r_keepout', 'Radio', 'Antenna keep-out respected: no copper, ground or metal enclosure in the zone from the datasheet',
    'Detuned antennas push power into harmonics and spurious bands, and lose range.', 'both', 'radio', false, 'Antenna keep-out'],
  ['r_red', 'Radio', 'RED test plan: EN 300 328 (2.4 GHz), EN 301 489-1/-17, EN 62368-1, EN 62311',
    'A radio product is under RED, not the EMC Directive: all four essential requirements need evidence.', 'ce', 'radio', true, 'RED test plan'],
  ['r_exposure', 'Radio', 'RF exposure assessed (MPE at 20 cm, or SAR for body-worn use)',
    'FCC 2.1093 / 1.1310 and EN 62311 / EN 62479: a module grant\'s 20 cm assumption fails for wearables.', 'both', 'radio', false, 'RF exposure assessed'],
  ['r_discrete', 'Radio', 'Own RF design: intentional radiator tests planned (FCC Part 15 Subpart C, full RED set)',
    'A discrete radio needs its own grant (FCC ID via a TCB) - weeks and several thousand dollars; budget it.', 'both', 'discrete', true, 'Intentional radiator tests'],
  ['r_testmode', 'Radio', 'Test firmware: continuous TX / RX on chosen channels, fixed power',
    'The lab measures at low, mid and high channels; without a test mode they cannot start.', 'both', 'radio', false, 'Radio test firmware'],
  ['l_ce', 'Labels & documents', 'CE mark (≥ 5 mm), manufacturer name and postal address, type or serial on the product',
    'Decision 768/2008 and each directive require them on the product (or packaging if the product is too small).', 'ce', 'all', true, 'CE mark + address'],
  ['l_weee', 'Labels & documents', 'WEEE crossed-out bin and RoHS evidence (supplier declarations for the BOM)',
    'Both apply to almost all electrical products sold in the EU; RoHS evidence is part of the technical file.', 'ce', 'all', false, 'WEEE / RoHS'],
  ['l_fcc', 'Labels & documents', 'FCC label: 15.19 statement, and "Contains FCC ID: ..." when a module is used',
    'The compliance statement (or e-label) is required on the device; a module\'s FCC ID must be visible on the host.', 'fcc', 'all', true, 'FCC label'],
  ['l_manual', 'Labels & documents', 'Manual: FCC 15.105 interference statement, safety and disposal info',
    'The 15.105 text for Class A/B devices and the EU safety information must reach the user.', 'both', 'all', false, 'Manual statements'],
  ['l_doc', 'Labels & documents', 'Declaration of Conformity (EU DoC / FCC SDoC) and technical file drafted',
    'The DoC lists the harmonised standards used; the technical file (schematics, test reports, risk assessment) backs it for 10 years.', 'both', 'all', true, 'DoC + technical file'],
  ['p_prescan', 'Pre-test', 'Pre-compliance scan (near-field probe or a pre-scan at a lab) done on a prototype',
    'A day of pre-scan finds the peak you would otherwise fail on at full lab rates.', 'both', 'all', false, 'Pre-scan done'],
  ['p_worst', 'Pre-test', 'Worst-case mode defined: all interfaces active, max clock, cables attached as sold',
    'The lab tests the configuration you give them; an untested mode found later needs a retest.', 'both', 'all', false, 'Worst-case mode defined'],
];

const APPLIES = {
  all: () => true,
  mains: (c) => c.power === 'mains',
  lowv: (c) => c.power === 'lowv',
  wired: (c) => c.power !== 'battery',
  battery: (c) => c.power === 'battery' || c.battery,
  radio: (c) => c.radio !== 'none',
  module: (c) => c.radio === 'module',
  discrete: (c) => c.radio === 'discrete',
};

export function run(input) {
  const pick = (v, ok, dflt) => (ok.includes(v) ? v : dflt);
  const ctx = { power: pick(input.power, ['battery', 'lowv', 'mains'], 'lowv'), radio: pick(input.radio, ['none', 'module', 'discrete'], 'none'), battery: !!input.battery };
  const market = pick(input.market, ['both', 'ce', 'fcc'], 'both');
  const inMarket = (m) => m === 'both' || market === 'both' || m === market;
  const live = ITEMS.filter((it) => inMarket(it[4]) && APPLIES[it[5]](ctx));
  const done = live.filter((it) => input[it[0]]);
  const open = live.filter((it) => !input[it[0]]);
  const critical = open.filter((it) => it[6]);
  const pct = live.length ? Math.round((100 * done.length) / live.length) : 100;
  const mk = (m) => (m === 'both' ? 'CE + FCC' : m.toUpperCase());
  const groups = [...new Set(ITEMS.map((it) => it[1]))];
  const byGroup = groups.map((g) => {
    const all = live.filter((it) => it[1] === g);
    const d = all.filter((it) => input[it[0]]).length;
    return [g, all.length ? `${d} / ${all.length}` : '–', !all.length ? 'n/a' : d === all.length ? 'done' : 'open'];
  });
  const warnings = [];
  if (critical.length) {
    warnings.push(`${critical.length} critical item${critical.length > 1 ? 's' : ''} open - each is a likely test fail or a respin: ${critical.map((it) => it[7]).join('; ')}. Close them before booking the lab.`);
  }
  if (ctx.radio === 'discrete') warnings.push('A discrete radio needs its own certification (FCC ID from a TCB, full RED test set). If schedule matters, a pre-certified module saves most of it.');
  const regs = [];
  if (market !== 'fcc') {
    regs.push(ctx.radio !== 'none' ? 'EU: RED 2014/53/EU (covers EMC and safety too)' : 'EU: EMC Directive 2014/30/EU (EN 55032 / EN 55035)');
    if (ctx.power === 'mains' && ctx.radio === 'none') regs.push('EU: Low Voltage Directive 2014/35/EU (IEC/EN 62368-1)');
    regs.push('EU: RoHS 2011/65/EU, WEEE 2012/19/EU');
  }
  if (market !== 'ce') {
    regs.push('US: FCC Part 15 Subpart B (unintentional radiator, SDoC)');
    if (ctx.radio === 'module') regs.push('US: host integration under the module\'s FCC ID (KDB 996369), Part 15B for the host');
    if (ctx.radio === 'discrete') regs.push('US: FCC Part 15 Subpart C certification (FCC ID via a TCB)');
  }
  const openText = open.length
    ? `Certification pre-check (${mk(market)}), still open (${open.length}, ${critical.length} critical):\n${open.map((it) => `- ${it[6] ? '[critical] ' : ''}[${it[1]}] ${it[2]}\n    why: ${it[3]}`).join('\n')}\n`
    : `Everything on the ${mk(market)} pre-check is done: book the pre-scan or the lab.\n`;
  return {
    values: [
      { label: 'Progress', value: `${pct} %`, tone: pct === 100 ? 'ok' : pct >= 70 ? 'warn' : 'bad' },
      { label: 'Done', value: `${done.length} / ${live.length}` },
      { label: 'Critical open', value: critical.length, tone: critical.length ? 'bad' : 'ok', hint: 'likely fail or respin' },
      { label: 'Not applicable', value: ITEMS.length - live.length, hint: `${mk(market)}, ${ctx.power}, radio ${ctx.radio}` },
    ],
    warnings,
    tables: [
      ...(open.length ? [{ title: 'Still open', columns: ['Group', 'Item', 'Why it matters', 'For', 'Critical'],
        rows: open.map((it) => [it[1], it[2], it[3], mk(it[4]), it[6] ? 'yes' : '']) }] : []),
      { title: 'By group', columns: ['Group', 'Done', 'State'], rows: byGroup },
      { title: 'Rules in scope', columns: ['Regulation'], rows: regs.map((r) => [r]) },
    ],
    texts: [{ title: 'Open items', body: openText }],
    notes: [
      'Set the market, power and radio first: they switch items on or off (items for the other market, mains or radio then do not count).',
      'This is a pre-check of the usual gaps, not a compliance assessment: the harmonised standards and a test lab decide.',
      'FCC has no immunity (ESD, surge) requirement for most products; CE does, through EN 55035 or EN 301 489.',
    ],
  };
}
