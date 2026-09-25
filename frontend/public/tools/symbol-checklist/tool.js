// Schematic symbol checklist: what to check on a new symbol before it is used.
// Items follow the library conventions of IPC-2612-1 (schematic symbol
// generation), IEEE 315 / IEC 60617 (graphic symbols), the KiCad Library
// Conventions (KLC: pin grid, electrical types, hidden pins, fields) and the
// Altium component-rule checks. The "why" is the usual failure each one prevents.

// key, group, what, why, applies: 'all' | 'ic' | 'passive' | 'conn' | 'icconn' | 'multi' | 'ep'
export const ITEMS = [
  ['p_count', 'Pins', 'Pin count equals the package pin count, NC and exposed pad included', 'A pin missing from the symbol leaves its pad unconnected in the layout, and no check will tell you.', 'all'],
  ['p_numbers', 'Pins', 'Pin numbers match the datasheet for this exact package', 'The same chip has a different pinout in SOIC and QFN; a swapped number is a board respin.', 'all'],
  ['p_names', 'Pins', 'Pin names as in the datasheet, active-low marked (~{RESET} or RESET_N)', 'Renamed pins make the schematic impossible to check against the datasheet.', 'icconn'],
  ['p_types', 'Pins', 'Electrical type set on every pin (input, output, bidirectional, tri-state, passive...)', 'ERC finds undriven inputs and output conflicts only from these types; all-passive pins disable it.', 'ic'],
  ['p_power', 'Pins', 'Supply pins are Power input; regulator outputs are Power output', 'ERC then flags a rail with no source, and two sources shorted together.', 'ic'],
  ['p_od', 'Pins', 'Open-drain / open-collector outputs typed as such', 'Typed as plain outputs, shared lines (I2C, interrupts) give output-to-output ERC errors.', 'ic'],
  ['p_nc', 'Pins', 'Only truly unconnected pins typed No-connect ("reserved, tie to GND" is not NC)', 'Reserved pins that must be tied get left floating when marked NC.', 'icconn'],
  ['p_hidden', 'Pins', 'No hidden power pins (or deliberately, with the net name documented)', 'Hidden pins join a net by name: a part on another rail is silently tied to the wrong supply.', 'ic'],
  ['p_stacked', 'Pins', 'Repeated GND/VDD pins all present, stacked or shown on purpose', 'A GND pin left out of a stack is an unconnected pad: less current, worse thermal and EMC.', 'ic'],
  ['p_ep', 'Pins', 'Exposed / thermal pad is a pin with its own number and its net (usually GND)', 'Without a pin the pad has no net: the layout leaves it unsoldered or unconnected.', 'ep'],
  ['g_grid', 'Graphics', 'Pin ends on the 100 mil (2.54 mm) grid, pointing outward', 'Off-grid pin ends do not connect to wires; ERC reports them unconnected (or misses them).', 'all'],
  ['g_layout', 'Graphics', 'Inputs left, outputs right, supplies top, ground bottom; related pins grouped', 'Signal flow reads left to right; review is faster and errors show.', 'ic'],
  ['g_pin1', 'Graphics', 'Polarity / pin 1 visible (diode cathode, electrolytic +, pin 1 of connectors)', 'The schematic is what assembly and debug read to know the orientation.', 'all'],
  ['g_text', 'Graphics', 'Names and numbers readable at print size, not overlapping the body or each other', 'Unreadable pin numbers slow every review and bring-up.', 'all'],
  ['g_origin', 'Graphics', 'Symbol origin at the body centre, on grid', 'Rotated or mirrored symbols stay on grid and connect.', 'all'],
  ['f_ref', 'Fields', 'Reference prefix is standard (U, R, C, L, D, Q, J, Y, F...)', 'Annotation, BOM grouping and assembly drawings rely on it (IEEE 315 / ASME Y14.44).', 'all'],
  ['f_value', 'Fields', 'Value field holds the value or the part number', 'The BOM and the schematic print show it.', 'all'],
  ['f_fp', 'Fields', 'Footprint assigned, and its pad numbers match the pin numbers', 'The netlist connects by number: a mismatch routes signals to the wrong pads.', 'all'],
  ['f_mpn', 'Fields', 'Manufacturer and MPN fields (or a link to your parts database)', 'The BOM needs an orderable part; "10k" alone is not one.', 'all'],
  ['f_rating', 'Fields', 'Ratings where they matter: voltage for capacitors, power for resistors, current for inductors', 'A right value with a wrong rating fails in the field (cap derating, resistor burn-out).', 'passive'],
  ['f_ds', 'Fields', 'Datasheet link', 'Reviewers check the pinout against it.', 'all'],
  ['f_desc', 'Fields', 'Description and keywords filled in', 'The part can be found in the library search, and not duplicated.', 'all'],
  ['m_units', 'Multi-unit', 'Each unit has its own pins; no pin in two units', 'A pin in two units is connected twice or not at all.', 'multi'],
  ['m_swap', 'Multi-unit', 'Units / pins marked swappable only where they really are', 'Pin and gate swapping in layout must not swap non-equivalent pins.', 'multi'],
  ['m_power', 'Multi-unit', 'Power pins in their own unit or on every unit, as your tool expects', 'An unplaced power unit leaves the chip unpowered; ERC "missing unit" catches it only if set up.', 'multi'],
  ['c_mating', 'Connector', 'Numbering matches the physical connector and its mating half', 'Plug and receptacle often number mirror-image; pin 1 of the cable is not always pin 1 of the board.', 'conn'],
  ['c_shell', 'Connector', 'Shield / shell / mounting pins present as numbered pins', 'Otherwise the shield has no net and the footprint pads are orphaned.', 'conn'],
  ['v_lib', 'Verify', 'Library checker passes (KiCad symbol checker, Altium component rule check)', 'Catches duplicate pin numbers, off-grid pins and empty fields for free.', 'all'],
  ['v_erc', 'Verify', 'Placed in a test sheet with typical connections: ERC clean', 'Shows at once whether the pin types make sense.', 'all'],
  ['v_review', 'Verify', 'Pinout cross-checked against the datasheet by a second person', 'Pinout errors are the most common first-spin schematic bug; a second reader finds most.', 'all'],
];

export function run(input) {
  const kind = input.kind || 'ic';
  const applies = (a) => a === 'all' || a === kind || (a === 'icconn' && (kind === 'ic' || kind === 'conn')) || (a === 'multi' && input.multi) || (a === 'ep' && input.ep);
  const live = ITEMS.filter((it) => applies(it[4]));
  const done = live.filter((it) => input[it[0]]);
  const open = live.filter((it) => !input[it[0]]);
  const pct = live.length ? Math.round((100 * done.length) / live.length) : 100;
  const groups = [...new Set(ITEMS.map((it) => it[1]))];
  const byGroup = groups.map((g) => {
    const all = live.filter((it) => it[1] === g);
    return [g, `${all.filter((it) => input[it[0]]).length} / ${all.length}`, all.length ? (all.every((it) => input[it[0]]) ? 'done' : 'open') : 'n/a'];
  });
  const warnings = [];
  const blockers = ['p_count', 'p_numbers', 'f_fp', 'p_ep', 'p_hidden'].filter((k) => open.some((it) => it[0] === k));
  if (blockers.length) warnings.push(`Do not use the symbol yet - open: ${blockers.map((k) => ITEMS.find((it) => it[0] === k)[2]).join('; ')}. These put wrong or missing connections on the board.`);
  // Everything the page draws: each live check with its state, in list order.
  const symbol = {
    kind, multi: !!input.multi, ep: !!input.ep, pct, done: done.length, total: live.length, notApplicable: ITEMS.length - live.length,
    items: live.map((it) => ({ key: it[0], group: it[1], what: it[2], why: it[3], done: !!input[it[0]], blocker: blockers.includes(it[0]) })),
    groups: byGroup.filter((g) => g[2] !== 'n/a').map(([g, d, st]) => ({ group: g, count: d, done: st === 'done' })),
    blockers,
  };
  return {
    symbol,
    values: [
      { label: 'Progress', value: `${pct} %`, tone: pct === 100 ? 'ok' : pct >= 70 ? 'warn' : 'bad' },
      { label: 'Done', value: `${done.length} / ${live.length}` },
      { label: 'Still open', value: open.length, tone: open.length ? 'warn' : 'ok' },
      { label: 'Not applicable', value: ITEMS.length - live.length, hint: [kind !== 'ic' && 'not an IC', kind !== 'conn' && 'not a connector', kind !== 'passive' && 'not a passive', !input.multi && 'single unit', !input.ep && 'no exposed pad'].filter(Boolean).join(', ') || '–' },
    ],
    warnings,
    tables: [
      ...(open.length ? [{ title: 'Still open', columns: ['Group', 'Check', 'Why it matters'], rows: open.map((it) => [it[1], it[2], it[3]]) }] : []),
      { title: 'By group', columns: ['Group', 'Done', 'State'], rows: byGroup },
    ],
    texts: [{ title: 'Open items', body: open.length
      ? `Before using this schematic symbol, still open (${open.length}):\n${open.map((it) => `- [${it[1]}] ${it[2]}: ${it[3]}`).join('\n')}\n`
      : 'Every check on the list is done: the symbol is ready to use.\n' }],
    notes: ['Set the part kind and the two context boxes first: they switch the IC, passive, connector, multi-unit and exposed-pad checks on or off.'],
  };
}
