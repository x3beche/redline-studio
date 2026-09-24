// Gerber release checklist: what a fab (and an assembler) needs in the zip.
// Items follow the fab-side view of what holds an order: missing layers or
// outline, drills that do not line up, unstated build options. Sources:
// Ucamco "Gerber Layer Format Specification" (X2, .gbrjob), IPC-D-356 (netlist
// for electrical test), IPC-2581/IPC-6012 build classes, and common fab
// order-hold reasons (rule of thumb).

// key, group, what, why, applies: 'all' | 'asm' | 'panel' | 'multi'
export const ITEMS = [
  ['l_cu', 'Layers', 'Top and bottom copper', 'Without both, the fab builds the wrong board or puts the order on hold.', 'all'],
  ['l_inner', 'Layers', 'Inner copper layers, named in stack order', 'Inner layers in the wrong order short planes to signals.', 'multi'],
  ['l_mask', 'Layers', 'Solder mask, top and bottom', 'With no mask file the fab leaves bare copper or guesses the openings.', 'all'],
  ['l_silk', 'Layers', 'Silkscreen, top and bottom (or a note: none)', 'A missing silk file looks like a forgotten one and gets a question.', 'all'],
  ['l_outline', 'Layers', 'Board outline: one closed contour (Edge.Cuts / GKO)', 'An open or doubled outline is the most common reason an order is held.', 'all'],
  ['l_cutouts', 'Layers', 'Cut-outs and slots drawn on the outline layer', 'Cut-outs anywhere else are ignored or milled wrongly.', 'all'],
  ['l_paste', 'Layers', 'Paste (stencil) layers, top and bottom', 'The stencil is cut from them; without them there is no solder paste.', 'asm'],
  ['d_pth', 'Drills', 'Plated drill file (Excellon)', 'No drill file, no vias and no through-hole pads.', 'all'],
  ['d_npth', 'Drills', 'Non-plated holes in their own file or clearly marked', 'Otherwise mounting and tooling holes come back plated, and shorted to nothing or everything.', 'all'],
  ['d_slots', 'Drills', 'Slots as routed slots (G85 or rout paths), plated or not as meant', 'Slots drawn as overlapping holes come out as a row of holes, or not at all.', 'all'],
  ['d_units', 'Drills', 'Drill units and zero format match the Gerbers', 'An inch/mm or zero-suppression mix puts every hole off its pad.', 'all'],
  ['d_map', 'Drills', 'Drill table: sizes, counts, plated / non-plated', 'The fab checks the drill file against it; a mismatch is a question.', 'all'],
  ['f_x2', 'Format', 'RS-274X / X2 Gerbers with embedded apertures', 'RS-274D (separate aperture list) is obsolete and gets rejected.', 'all'],
  ['f_origin', 'Format', 'All files share one origin (checked overlaid)', 'Layers that do not line up make a scrap board, not a question.', 'all'],
  ['f_names', 'Format', 'Files named by layer, or a .gbrjob job file', 'The fab has to guess which file is which layer.', 'all'],
  ['f_netlist', 'Format', 'IPC-D-356 netlist for electrical test', 'Lets the fab\'s flying-probe test compare against your netlist, not the Gerbers.', 'all'],
  ['p_drawing', 'Panel', 'Panel drawing: array, spacing, rails', 'The assembler needs to know how many boards and where.', 'panel'],
  ['p_sep', 'Panel', 'Separation: V-score lines or tabs with mouse bites', 'Without it the panel cannot be broken apart, or breaks where it should not.', 'panel'],
  ['p_fid', 'Panel', 'Panel fiducials and tooling holes on the rails', 'Pick-and-place and stencil printers align on them.', 'panel'],
  ['n_material', 'Fab notes', 'Material and thickness (e.g. FR-4 Tg150, 1.6 mm)', 'Left out, you get the fab\'s default, which may not fit your connector or enclosure.', 'all'],
  ['n_copper', 'Fab notes', 'Copper weight, outer and inner', 'Power tracks were sized for a copper weight: 0.5 oz instead of 1 oz halves the current.', 'all'],
  ['n_finish', 'Fab notes', 'Surface finish (HASL lead-free, ENIG...)', 'Fine-pitch and BGA parts need a flat finish (ENIG); HASL is uneven.', 'all'],
  ['n_colour', 'Fab notes', 'Mask and silk colours', 'Otherwise green and white, which may not be what you wanted.', 'all'],
  ['n_stackup', 'Fab notes', 'Stack-up and impedance control, if needed', 'Controlled impedance only happens when it is asked for, with the target and layers.', 'multi'],
  ['n_vias', 'Fab notes', 'Via treatment: tented, plugged or filled', 'Open vias under pads wick solder away; via-in-pad needs filling and capping.', 'all'],
  ['n_class', 'Fab notes', 'IPC class (2 or 3) and quantity', 'Class 3 is inspected and priced differently; say which.', 'all'],
  ['a_bom', 'Assembly', 'BOM with manufacturer part numbers and designators', 'The assembler buys from it; a missing MPN is a hold.', 'asm'],
  ['a_cpl', 'Assembly', 'Pick-and-place file: designator, X, Y, rotation, side', 'Without it the machine has nothing to place; rotation errors are the classic fault.', 'asm'],
  ['a_draw', 'Assembly', 'Assembly drawing with polarity marks and DNP list', 'Resolves diode, LED and IC orientation questions without an email.', 'asm'],
  ['v_view', 'Final check', 'Opened the zip in a Gerber viewer (not the CAD) and looked at every layer', 'What the fab sees is the zip, not your CAD; this catches most of the above.', 'all'],
  ['v_drc', 'Final check', 'DRC clean against this fab\'s rules', 'Features under the fab\'s minimum are either held or quietly widened.', 'all'],
  ['v_rev', 'Final check', 'One zip, latest revision, revision on the silk and in the file name', 'Old files in the zip get built; a revision on the board tells boards apart later.', 'all'],
];

export function run(input) {
  const multi = input.layers !== '2';
  const applies = (a) => a === 'all' || (a === 'asm' && input.asm) || (a === 'panel' && input.panel) || (a === 'multi' && multi);
  const live = ITEMS.filter((it) => applies(it[4]));
  const done = live.filter((it) => input[it[0]]);
  const open = live.filter((it) => !input[it[0]]);
  const skipped = ITEMS.length - live.length;
  const pct = live.length ? Math.round((100 * done.length) / live.length) : 100;
  const groups = [...new Set(ITEMS.map((it) => it[1]))];
  const byGroup = groups.map((g) => {
    const all = live.filter((it) => it[1] === g);
    return [g, `${all.filter((it) => input[it[0]]).length} / ${all.length}`, all.length ? (all.every((it) => input[it[0]]) ? 'done' : 'open') : 'n/a'];
  });
  const warnings = [];
  const blockers = ['l_outline', 'd_pth', 'l_cu', 'f_origin', 'd_units'].filter((k) => open.some((it) => it[0] === k));
  if (blockers.length) warnings.push(`Not ready to send - open: ${blockers.map((k) => ITEMS.find((it) => it[0] === k)[2]).join('; ')} - these make a scrap board or a held order.`);
  return {
    values: [
      { label: 'Progress', value: `${pct} %`, tone: pct === 100 ? 'ok' : pct >= 70 ? 'warn' : 'bad' },
      { label: 'Done', value: `${done.length} / ${live.length}` },
      { label: 'Still open', value: open.length, tone: open.length ? 'warn' : 'ok' },
      { label: 'Not applicable', value: skipped, hint: [!input.asm && 'no assembly', !input.panel && 'no panel', !multi && '2 layers'].filter(Boolean).join(', ') || '–' },
    ],
    warnings,
    tables: [
      ...(open.length ? [{ title: 'Still open', columns: ['Group', 'Item', 'Why it matters'], rows: open.map((it) => [it[1], it[2], it[3]]) }] : []),
      { title: 'By group', columns: ['Group', 'Done', 'State'], rows: byGroup },
    ],
    texts: [{ title: 'Open items', body: open.length
      ? `Before sending the Gerbers to the fab, still open (${open.length}):\n${open.map((it) => `- [${it[1]}] ${it[2]}: ${it[3]}`).join('\n')}\n`
      : 'Everything on the checklist is done: the package is ready to send.\n' }],
    notes: ['Tick the three context boxes first: they switch the assembly, panel and multilayer items on or off.'],
  };
}
