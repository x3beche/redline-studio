// ERC rule explainer: what an electrical-rules-check message means, what
// usually causes it, the fix, and when (if ever) it is fine to waive.
// Rule codes and messages are KiCad's (KiCad 7/8 ERC, eeschema "erc_settings");
// the Altium Designer name of the same check is given where there is one
// (Project Options > Error Reporting / Connection Matrix). The causes and fixes
// are common practice, not quoted from either tool.

// code, KiCad message, Altium name, meaning, usual causes, fix, waive when, bug risk, search words
export const RULES = [
  ['pin_not_connected', 'Pin not connected', 'Unconnected pin / Floating input pins',
    'A symbol pin has no wire and no no-connect flag on it.',
    'A forgotten wire; a wire end that stops short of the pin end (off grid); a pin that is unused on purpose.',
    'Wire it. If it is meant to be unused, check the datasheet allows it to float (unused CMOS inputs must be tied high or low), then place a no-connect flag (X) on it.',
    'Never waive: an X flag documents the intent and clears it.', 'high', 'unconnected floating open'],
  ['pin_not_driven', 'Input pin not driven by any Output pins', 'Net with no driving source',
    'A net has input pins but nothing that drives it: no output, bidirectional, tri-state or power-output pin.',
    'The driver is off the board (connector pins typed passive or input); a pull-up / pull-down is missing; every pin on the net is an input.',
    'Connect the driver, or add the pull resistor the input needs. For a signal from a connector, type the connector pins passive or bidirectional.',
    'When the signal really comes from off-board and the connector pin type cannot be changed.', 'medium', 'undriven input no driver source; KiCad 5: pin connected to some others pins but no pin to drive it'],
  ['power_pin_not_driven', 'Input Power pin not driven by any Output Power pins', 'Power pin not driven / Net with no driving source',
    'A net with power-input pins (the chip supplies, and in KiCad the power symbols themselves) has no power-output pin.',
    'The rail comes from a connector, a battery or a jack; a regulator symbol has its output typed passive instead of power output.',
    'Place a PWR_FLAG on the net where the power enters the board (after the connector or battery), or fix the regulator\'s output pin type to Power output.',
    'Do not waive: the PWR_FLAG is the documented fix. But first check the rail really reaches a source: a missing wire gives the same error.', 'medium', 'power flag pwr_flag supply rail vcc gnd'],
  ['pin_to_pin', 'Pin conflict (e.g. Output pin connected to Output pin)', 'Connection matrix: Output to Output, Power to Power...',
    'Two pins whose types must not share a net are connected, per the pin-conflict matrix.',
    'Two push-pull outputs on one net; two regulators feeding one rail; an open-drain output typed as a plain output; a tri-state bus typed as outputs.',
    'Separate real conflicts (one driver per net, an ORing diode or ideal-diode controller for power). Where the design is right, fix the pin types: open collector, tri-state or bidirectional.',
    'Only after checking the drivers can never fight (e.g. enabled one at a time and typed wrong in a vendor symbol).', 'high', 'conflict output to output short contention driver'],
  ['no_connect_connected', 'A pin with a "no connection" flag is connected', 'No-ERC / No-connect on connected pin',
    'A pin carries a no-connect flag but a wire or another pin also connects to it.',
    'The pin was flagged unused, then wired later; the flag was dropped on a wire end.',
    'Decide: remove the flag if the pin is used, or remove the wire if it is not.', 'Never.', 'medium', 'no connect nc flag x'],
  ['no_connect_dangling', 'Unconnected "no connection" flag', '-',
    'A no-connect flag sits on nothing: not on a pin end.',
    'The symbol moved and left its flag behind; the flag was placed beside the pin, not on its end.',
    'Move the flag exactly onto the pin end, or delete it.', 'Never; it is a cleanup.', 'low', 'no connect flag dangling nc'],
  ['label_dangling', 'Label not connected to anything', 'Net label not connected',
    'A net label does not touch a wire or pin, so it names nothing.',
    'The label was placed next to the wire instead of on it; the wire was moved away.',
    'Put the label\'s connection point on the wire (or its end). Check the net it was meant to name is now connected.', 'Never.', 'high', 'label dangling net label floating'],
  ['isolated_pin_label', 'Label connected to only one pin', 'Nets with only one pin',
    'A label names a net that has just one pin on it: the label connects to nothing else.',
    'The matching label elsewhere has a different spelling or case; the other end was deleted.',
    'Find the other end and make the names identical (case included), or remove the label.', 'For a test point or a pin broken out only for probing.', 'high', 'single pin one pin net label only'],
  ['single_global_label', 'Global label only appears once in the schematic', 'Nets with only one pin / Global label unmatched',
    'A global label has no partner anywhere in the design.',
    'A typo in one of the names; the sheet with the other end is not in the hierarchy.',
    'Match the spelling on both ends, or add the missing sheet, or delete the label.', 'Rarely: a net kept for a later revision.', 'high', 'global label once unmatched typo'],
  ['similar_labels', 'Labels are similar (only differ in case)', '-',
    'Two labels differ only in upper/lower case, so they are two different nets that look like one.',
    'SDA and Sda typed on different sheets; copy-paste from a datasheet.',
    'Rename to one spelling. Pick a naming style for the project (Net Name Linter helps).', 'If you really have two nets with those names: rename one clearly instead.', 'high', 'case similar labels spelling'],
  ['multiple_net_names', 'More than one name given to this net', 'Nets with multiple names',
    'Two different labels (or power symbols) are on the same wire: the net gets only one of the names.',
    'Two sheets named the same signal differently; a power symbol dropped on a signal; an alias meant as a net tie.',
    'Keep one name. If two names must meet on purpose (e.g. AGND and GND), use a net-tie footprint or a 0 Ω resistor.', 'When the tool\'s choice of name is fine and the second label is only for readability.', 'medium', 'two names alias net name'],
  ['wire_dangling', 'Unconnected wire endpoint', 'Unconnected line',
    'A wire end connects to nothing.',
    'A stub left after editing; a wire that stops just short of a pin (off grid).',
    'Delete stubs; drag the end onto the pin or wire it was meant for.', 'Never; cleanup.', 'medium', 'wire dangling stub endpoint'],
  ['endpoint_off_grid', 'Symbol pin or wire end off connection grid', 'Off-grid object',
    'A pin or wire end is off the connection grid, so things that look connected may not be.',
    'Grid changed while editing; a library symbol with off-grid pins.',
    'Set the grid to 50 mil (1.27 mm), align the symbol, and fix the library symbol if its pins are off grid.', 'Never.', 'medium', 'grid off grid snap'],
  ['four_way_junction', 'Four items connected at one point', '-',
    'Four wires meet at one junction: on a print a missing dot is ambiguous (crossing or joined?).',
    'Drawing a net through a T.',
    'Stagger into two T-junctions a grid step apart.', 'It is a readability rule; waive if your style allows.', 'low', 'junction dot four way crossing'],
  ['bus_to_net_conflict', 'Invalid connection between bus and net items', 'Bus / net conflict',
    'A plain net wire touches a bus (or a bus touches a pin) without a bus entry.',
    'Drawing a signal straight into a bus line.',
    'Use a bus entry and a label whose name is a member of the bus (D[0..7] -> D3).', 'Never.', 'high', 'bus entry member'],
  ['net_not_bus_member', 'Net is graphically connected to a bus but not a bus member', 'Bus member not found',
    'A net joins a bus but its name is not one of the bus members, so it is not connected.',
    'Label D8 on a bus D[0..7]; different prefix or case.',
    'Rename the label to a member, or widen the bus definition.', 'Never.', 'high', 'bus member name'],
  ['hier_label_mismatch', 'Mismatch between hierarchical labels and sheet pins', 'Sheet entry / port mismatch',
    'A sheet symbol\'s pins do not match the hierarchical labels inside the sheet.',
    'A label renamed or added inside the sheet and not on the sheet symbol (or the reverse).',
    'Sync the sheet pins (KiCad: Import sheet pins / update sheet), same name and case.', 'Never: the unmatched signal is not connected.', 'high', 'hierarchical sheet pin port'],
  ['duplicate_reference', 'Duplicate reference designators', 'Duplicate part designators',
    'Two parts share a reference (two R5): the netlist and BOM merge or drop one.',
    'Copy-paste of annotated parts; sheets reused without unique annotation.',
    'Re-annotate the new parts only (keep existing references), then re-check the layout.', 'Never.', 'high', 'duplicate reference designator annotation'],
  ['unannotated', 'Symbol not annotated (R?)', 'Unannotated parts',
    'A part still has a "?" reference.',
    'Newly placed parts.',
    'Run annotation.', 'Never.', 'medium', 'annotate question mark reference'],
  ['missing_unit', 'Unit of a multi-unit symbol not placed', 'Missing units / Unused sub-parts',
    'A multi-unit part (a dual op-amp) has a unit that is not placed.',
    'Only the used half placed.',
    'Place the spare unit and tie it off as the datasheet says (op-amp: follower with + to a mid-rail or ground; logic: inputs to a rail).', 'Never: an unterminated spare op-amp can oscillate and draw current.', 'medium', 'multi unit spare gate op-amp'],
  ['missing_power_pin', 'Missing input power pin in unit', 'Hidden power pins not connected',
    'The unit that holds a part\'s power pins is not placed, so the part has no supply in the netlist.',
    'Power unit (or hidden power pins) left out of the sheet.',
    'Place the power unit and connect it; prefer visible power pins in new symbols.', 'Never.', 'high', 'power unit hidden pins supply'],
  ['different_unit_footprint', 'Different footprints assigned to units of one part', 'Component units differ',
    'Units of the same part (U3A, U3B) have different footprints.',
    'A footprint changed on one unit only.',
    'Assign the same footprint to every unit.', 'Never.', 'high', 'footprint unit mismatch'],
  ['lib_symbol_issues', 'Symbol library not found / symbol differs from library', 'Component not found / Library mismatch',
    'The placed symbol cannot be found in the libraries, or differs from the library version.',
    'Library renamed or not in the table; the library symbol was edited after placing.',
    'Add the library, or update the symbol from the library after checking what changed (pins may have moved).', 'When the local copy is intentionally different.', 'low', 'library missing mismatch'],
  ['footprint_link_issues', 'Footprint link issues (footprint not found)', 'Footprint not found',
    'A symbol\'s footprint field names a footprint that is not in the libraries.',
    'Typo in the field; library not added; footprint renamed.',
    'Fix the field or add the library; the board update will otherwise drop the part.', 'Never before layout.', 'high', 'footprint missing link'],
  ['unresolved_variable', 'Unresolved text variable', '-',
    'A text contains ${NAME} that is not defined.',
    'Title-block variables not set in the project; a typo.',
    'Define the variable in the project settings or fix its name.', 'Harmless for connectivity; fix before release prints.', 'low', 'variable text title block'],
];

const score = (r, q) => {
  const words = q.toLowerCase().replace(/[^a-z0-9_ ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return 0;
  const hay = [r[0].replace(/_/g, ' '), r[1], r[2], r[8]].join(' ').toLowerCase();
  if (hay.includes(q.toLowerCase().trim())) return 100;
  return words.filter((w) => hay.includes(w)).length / words.length;
};

export function run({ rule, message, filter }) {
  const warnings = [];
  let r = RULES.find((x) => x[0] === rule) || RULES[0];
  let from = 'picked';
  const msg = String(message || '').trim();
  if (msg) {
    const best = RULES.map((x) => [x, score(x, msg)]).sort((a, b) => b[1] - a[1])[0];
    if (best[1] >= 0.5) { r = best[0]; from = 'matched from the message'; } else warnings.push(`Could not match "${msg}" to a known ERC rule; showing the picked rule. Try the rule's key words (e.g. "power pin not driven").`);
  }
  const q = String(filter || '').trim().toLowerCase();
  const list = RULES.filter((x) => !q || x.join(' ').toLowerCase().includes(q));
  if (q && !list.length) warnings.push(`No rule mentions "${filter}": clear the filter to list them all.`);
  const risk = { high: ['usually a real wiring error', 'bad'], medium: ['often a real error', 'warn'], low: ['mostly bookkeeping', 'ok'] }[r[7]];
  return {
    values: [
      { label: 'KiCad rule', value: r[0], hint: from },
      { label: 'Bug risk', value: r[7], tone: risk[1], hint: risk[0] },
    ],
    warnings,
    tables: [
      { title: 'What it means and what to do', columns: ['', 'Explanation'], rows: [['Message', r[1]], ['Altium name', r[2]], ['Means', r[3]], ['Usual causes', r[4]], ['Fix', r[5]], ['OK to waive', r[6]]] },
      { title: q ? `Rules matching "${filter}"` : 'All rules', columns: ['KiCad code', 'Message', 'Means', 'Risk'], rows: list.map((x) => [x[0] === r[0] ? `▶ ${x[0]}` : x[0], x[1], x[3], x[7]]) },
    ],
    texts: [{ title: 'Explanation', body: `ERC: ${r[1]} (KiCad ${r[0]}${r[2] !== '-' ? `; Altium: ${r[2]}` : ''})\n\nMeans: ${r[3]}\nUsual causes: ${r[4]}\nFix: ${r[5]}\nOK to waive: ${r[6]}\n` }],
    notes: ['ERC checks what the symbols say, not the real parts: a wrong pin type in a symbol gives false errors or hides real ones. Fix the symbol when the error is wrong (Schematic Symbol Checklist).', 'Severity (error / warning / ignore) is set per project: KiCad Schematic Setup > Electrical Rules; Altium Project Options > Error Reporting.'],
  };
}
