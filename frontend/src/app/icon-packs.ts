/** The icons of the 3D, PCB and Firmware toolbars, in packs.
 *
 *  Every glyph here is drawn on one 24 unit grid (live area 3..21, round
 *  caps and joins, 2 unit corner radius) and used as a mask: the button
 *  paints currentColor through it, so a glyph takes its colour from the
 *  theme and its state (rest, hover, on, disabled) from the stylesheet
 *  (icon-packs.css) - never from the drawing. "Classic" is the look the
 *  toolbars had before: the viewer's own pictures and ours drawn like
 *  them, left untouched.
 *
 *  A glyph is a few layers, and a pack decides what each one becomes:
 *    s     the outline, stroked
 *    k     details inside an area: stroked, or cut out of it in Solid
 *    a     areas: empty in Line, a quarter tone in Duotone, full in Solid
 *    soft  the body of a thing (a cube's silhouette): Duotone and Solid tint it
 *    hl    what the icon is about (the face looked at, the layer shown):
 *          filled in every pack
 *    hb    the same, for a face that looks away: a half tone the edges in
 *          front of it cross
 *    glass a see-through face: the same light tint in every pack
 *    bold  an outline drawn heavier (the silhouette under "black edges")
 *    hid   hidden edges, thin and faint
 *    dot   always filled; kd: filled, or cut out in Solid
 *
 *  Drawn for this application. Where a glyph follows a well-known shape
 *  (the pen, the package, the rotate arrow) it was redrawn on this grid
 *  after Lucide (ISC licence, https://lucide.dev), whose licence allows it.
 *
 *  Kept per browser like the theme (theme.ts): `redline.icons` and
 *  `redline.iconSize` (the glyph's size, 14-22 px), applied
 *  before the first paint (main.ts) so the bar is never seen in the
 *  wrong pack.
 */
export const ICON_PACKS = ['line', 'duotone', 'solid', 'classic'] as const;
export type IconPack = (typeof ICON_PACKS)[number];
export const ICON_PACK_DEFAULT: IconPack = 'line';
export const ICON_PACK_INFO: Record<IconPack, { name: string; about: string }> = {
  line: { name: 'Line', about: 'Even 1.5 px outlines; the face or layer shown is filled.' },
  duotone: { name: 'Duotone', about: 'The outlines, with the body of each thing in a light tone.' },
  solid: { name: 'Solid', about: 'Filled shapes with their details cut out; reads at a glance.' },
  classic: { name: 'Classic', about: 'The coloured pictures the viewer came with.' },
};

/** How large a glyph looks, in px: its live area (the 18 units of the
 *  24 grid that are drawn on), so a pack and Classic of the same size look
 *  the same size. The button is the glyph and 5 px round it. */
export const ICON_SIZES = [14, 16, 18, 20, 22, 24, 26, 28, 30] as const;
export type IconSize = (typeof ICON_SIZES)[number];
export const ICON_SIZE_DEFAULT: IconSize = 18;

interface Glyph {
  s?: string; k?: string; a?: string; soft?: string; hl?: string; hb?: string; glass?: string;
  bold?: string; hid?: string; dot?: string; kd?: string;
}

// ---- shapes ----
const rect = (x: number, y: number, w: number, h: number, r = 0) => r
  ? `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1-${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1-${r}-${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r}-${r}z`
  : `M${x} ${y}h${w}v${h}h-${w}z`;
const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0-${2 * r} 0z`;
const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0-${2 * rx} 0z`;

// ---- the view cube ----
// One cube for all six views, in an oblique projection so that every face
// has a place of its own: the front a square at lower left, the back the
// same square up and to the right, the four sides between them. The faces
// that look away are behind the others, so their edges are drawn hidden.
const CUBE_EDGES = 'M3 9h12v12H3z M3 9l6-6h12l-6 6 M21 3v12l-6 6';
const CUBE_HIDDEN = 'M9 3v12 M9 15h12 M9 15l-6 6';
const CUBE_BODY = 'M3 9l6-6h12v12l-6 6H3z';
const FACE: Record<string, string> = {
  front: 'M3 9h12v12H3z',
  rear: 'M9 3h12v12H9z',
  top: 'M3 9l6-6h12l-6 6z',
  bottom: 'M3 21l6-6h12l-6 6z',
  left: 'M3 9l6-6v12l-6 6z',
  right: 'M15 9l6-6v12l-6 6z',
};
const BEHIND = new Set(['rear', 'bottom', 'left']);
const cube = (face: string): Glyph => ({ s: CUBE_EDGES, hid: CUBE_HIDDEN, soft: CUBE_BODY,
  ...(BEHIND.has(face) ? { hb: FACE[face] } : { hl: FACE[face] }) });

// The isometric cube, for the iso view and the edges toggle.
const HEX = 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z';
const HEX_INNER = 'M4.2 7.5L12 12l7.8-4.5 M12 12v9';
const HEX_TOP = 'M12 3l7.8 4.5L12 12 4.2 7.5z';

// Two board layers, front above back, for the PCB room's sides.
const LAYER_TOP = 'M12 3l9 4.5-9 4.5-9-4.5z';
const LAYER_BOTTOM = 'M12 12.5l9 4.5-9 4.5-9-4.5z';

const MAG = circle(10.5, 10.5, 6.5) + ' M15.25 15.25L20.5 20.5';
const WINDOW = rect(3, 4, 18, 16, 2);
const BRACKETS = 'M4 8.5v-3A1.5 1.5 0 0 1 5.5 4h3 M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3 M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3 M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3';
const PEN = 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z';

/** Every glyph, by the name the stylesheet knows it by. */
export const GLYPHS: Record<string, Glyph> = {
  // The viewer's toolbar (three-cad-viewer), in its order.
  axes: { s: 'M9 14V3.5 M9 14h11.5 M9 14l-5.5 5.5 M6.5 6L9 3.5 11.5 6 M18 11.5l2.5 2.5-2.5 2.5 M3.5 16v3.5H7' },
  axes0: { s: 'M9 11.5v-8 M11.5 14h9 M7.2 15.8l-3.7 3.7 M6.5 6L9 3.5 11.5 6 M18 11.5l2.5 2.5-2.5 2.5 M3.5 16v3.5H7 ' + circle(9, 14, 2.5), a: circle(9, 14, 2.5) },
  grid: { s: 'M6 7h12l4 13H2z', k: 'M10 7l-1.33 13 M14 7l1.33 13 M4.9 10.6h14.2 M3.6 14.8h16.8', a: 'M6 7h12l4 13H2z' },
  perspective: { s: rect(3, 3, 18, 18, 2) + ' ' + rect(8.5, 8.5, 7, 7, 1) + ' M3.6 3.6l4.9 4.9 M20.4 3.6l-4.9 4.9 M3.6 20.4l4.9-4.9 M20.4 20.4l-4.9-4.9', soft: rect(3, 3, 18, 18, 2), a: rect(8.5, 8.5, 7, 7, 1) },
  transparent: { s: rect(3, 9, 12, 12, 1.5) + ' ' + rect(9, 3, 12, 12, 1.5), glass: rect(3, 9, 12, 12, 1.5) },
  blackedges: { bold: HEX, s: HEX_INNER, glass: HEX },
  iso: { s: HEX + ' ' + HEX_INNER, a: HEX_TOP, soft: HEX },
  front: cube('front'), rear: cube('rear'), top: cube('top'), bottom: cube('bottom'), left: cube('left'), right: cube('right'),
  explode: { s: rect(9, 9, 6, 6, 1.2) + ' M7.5 7.5L4 4 M16.5 7.5L20 4 M7.5 16.5L4 20 M16.5 16.5L20 20 M4 8V4h4 M16 4h4v4 M4 16v4h4 M20 16v4h-4', a: rect(9, 9, 6, 6, 1.2) },
  distance: { s: 'M4 5v14 M20 5v14 M7 12h10 M9.5 9.5L7 12l2.5 2.5 M14.5 9.5L17 12l-2.5 2.5' },
  angle: { s: 'M4 20h16 M4 20L15 5 M11 20A7 7 0 0 0 8.14 14.36' },
  properties: { s: circle(12, 12, 9), a: circle(12, 12, 9), k: 'M12 11v5.5', kd: circle(12, 7.75, 1.1) },
  select: { s: 'M5 4l14 6-6 2-2 6z', a: 'M5 4l14 6-6 2-2 6z' },
  reset: { s: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8 M3 3v5h5' },
  resize: { s: BRACKETS + ' ' + rect(8.5, 8.5, 7, 7, 1.2), a: rect(8.5, 8.5, 7, 7, 1.2) },
  help: { s: circle(12, 12, 9), a: circle(12, 12, 9), k: 'M9.4 9.2a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.4-2.6 4', kd: circle(12, 17.2, 1.1) },
  pin: { s: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z', a: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z', k: circle(12, 12.5, 3.25) },
  play: { s: 'M7 4.5v15l12-7.5z', a: 'M7 4.5v15l12-7.5z' },
  pause: { s: rect(6, 4.5, 4, 15, 1) + ' ' + rect(14, 4.5, 4, 15, 1), a: rect(6, 4.5, 4, 15, 1) + ' ' + rect(14, 4.5, 4, 15, 1) },
  stop: { s: rect(5, 5, 14, 14, 2), a: rect(5, 5, 14, 14, 2) },

  // Ours, in the rooms' toolbars (rooms/frame.ts ToolButton, editor.html).
  code: { s: 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M13.5 4.5l-3 15' },
  pen: { s: PEN + ' M12.5 20h8', a: PEN, k: 'M15 5l4 4' },
  layout: { s: WINDOW, a: WINDOW, k: 'M7 9h3.5l3 3H17 M7 15h10', kd: circle(7, 9, 1.4) + circle(17, 12, 1.4) + circle(7, 15, 1.4) + circle(17, 15, 1.4) },
  schematic: { s: rect(7, 4, 10, 16, 1.5) + ' M3 8h4 M3 12h4 M3 16h4 M17 8h4 M17 12h4 M17 16h4', a: rect(7, 4, 10, 16, 1.5), kd: circle(10, 7.25, 1) },
  model: { s: 'M2 11.5L12 6.5l10 5-10 5z M2 11.5V14l10 5 10-5v-2.5 M12 16.5V19', a: 'M2 11.5L12 6.5l10 5-10 5z', k: 'M8.5 11.5L12 9.75l3.5 1.75L12 13.25z' },
  split: { s: WINDOW + ' M12 4v16 M12 12h9', a: 'M5 4h7v16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' },
  focus: { s: WINDOW + ' ' + rect(10.5, 13, 4, 4.5, .8) + ' ' + rect(15.5, 13, 3.5, 4.5, .8), a: rect(10.5, 13, 4, 4.5, .8) + ' ' + rect(15.5, 13, 3.5, 4.5, .8) },
  'board-front': { s: LAYER_TOP + ' ' + LAYER_BOTTOM, hl: LAYER_TOP },
  tracks: { s: LAYER_TOP + ' ' + LAYER_BOTTOM, k: 'M7.5 7.5l4.5 2.25 3.5-1.75', dot: circle(7.5, 7.5, 1.5) + circle(15.5, 8, 1.5), soft: LAYER_TOP },
  'board-back': { s: LAYER_TOP + ' ' + LAYER_BOTTOM, hl: LAYER_BOTTOM },
  fit: { s: BRACKETS + ' ' + rect(8.5, 8.5, 7, 7, 1.2), a: rect(8.5, 8.5, 7, 7, 1.2) },
  in: { s: MAG, a: circle(10.5, 10.5, 6.5), k: 'M10.5 7.75v5.5 M7.75 10.5h5.5' },
  out: { s: MAG, a: circle(10.5, 10.5, 6.5), k: 'M7.75 10.5h5.5' },
  build: { s: circle(12, 12, 9), a: circle(12, 12, 9), kd: 'M10 8.25v7.5l6-3.75z' },
  open: { s: 'M12 3.5v10.5 M7.5 9.5L12 14l4.5-4.5 M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14' },
  release: { s: 'M12 2.75l8 4.5v9.5l-8 4.5-8-4.5v-9.5z', a: 'M12 2.75l8 4.5v9.5l-8 4.5-8-4.5v-9.5z', k: 'M4 7.25l8 4.5 8-4.5 M12 11.75v9.5 M8 5l8 4.5' },
  schfile: { s: 'M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z M14 3v5h5', a: 'M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z', k: 'M10 12.5l-2 2 2 2 M14 12.5l2 2-2 2' },
  flash: { s: rect(6, 11, 12, 10, 1.5) + ' M3 14h3 M3 18h3 M18 14h3 M18 18h3 M12 2.5v6 M9 5.5l3 3 3-3', a: rect(6, 11, 12, 10, 1.5), kd: circle(9, 14, 1) },
  monitor: { s: WINDOW, a: WINDOW, k: 'M7 9l3 3-3 3 M13 15h4' },

  // The pen's tools, docked in the toolbar while the view is held.
  'draw-pen': { s: 'M3.5 15.5c2-5.5 4.5-8 6-6s-.5 6.5 2.5 6.5 3.5-6 5.5-8 3 0 3 2' },
  'draw-line': { s: 'M6 18L18 6', dot: circle(5.5, 18.5, 1.75) + circle(18.5, 5.5, 1.75) },
  'draw-arrow': { s: 'M5 19L19 5 M10 5h9v9' },
  'draw-rect': { s: rect(4, 6, 16, 12, 1.5), a: rect(4, 6, 16, 12, 1.5) },
  'draw-ellipse': { s: ellipse(12, 12, 8.5, 6.5), a: ellipse(12, 12, 8.5, 6.5) },
  'draw-triangle': { s: 'M12 4.5l8.5 15h-17z', a: 'M12 4.5l8.5 15h-17z' },
  'draw-text': { s: 'M5 7V5h14v2 M12 5v14 M9.5 19h5' },
};

/** Which element wears which glyph: the viewer's buttons by their class,
 *  ours by theirs. */
const LIB = ['axes', 'axes0', 'grid', 'perspective', 'transparent', 'blackedges', 'iso', 'front', 'rear', 'top',
  'bottom', 'left', 'right', 'explode', 'distance', 'angle', 'properties', 'select', 'reset', 'resize', 'help',
  'pin', 'play', 'pause', 'stop'];
const OURS: Record<string, string> = {
  layout: 'layout', schematic: 'schematic', model: 'model', split: 'split', focus: 'focus', front: 'board-front',
  tracks: 'tracks', back: 'board-back', fit: 'fit', in: 'in', out: 'out', build: 'build', open: 'open',
  release: 'release', code: 'code', schfile: 'schfile', flash: 'flash', monitor: 'monitor',
};
const DRAW = ['pen', 'line', 'arrow', 'rect', 'ellipse', 'triangle', 'text'];

/** A sample of each toolbar for the picker's preview: the real buttons'
 *  classes, in the rooms' order (null: a group break). */
export const PREVIEW: { room: string; items: (string | null)[] }[] = [
  { room: '3D', items: ['tcv_button_axes', 'tcv_button_grid', null, 'tcv_button_perspective', 'tcv_button_transparent',
    null, 'tcv_button_iso', 'tcv_button_front', 'tcv_button_top', 'tcv_button_right', null,
    'tcv_button_explode', 'tcv_button_distance', null, 'tcv-ico tcv-ico-code', 'tcv-freeze'] },
  { room: 'PCB', items: ['tcv-ico tcv-ico-layout', 'tcv-ico tcv-ico-schematic', 'tcv-ico tcv-ico-model', null,
    'tcv-ico tcv-ico-front', 'tcv-ico tcv-ico-tracks', 'tcv-ico tcv-ico-back', null, 'tcv-ico tcv-ico-fit',
    'tcv-ico tcv-ico-in', null, 'tcv-ico tcv-ico-build'] },
  { room: 'Firmware', items: ['tcv-ico tcv-ico-build', 'tcv-ico tcv-ico-flash', 'tcv-ico tcv-ico-monitor'] },
];

// ---- drawing a glyph in a pack ----
/** The stroke, in grid units, for a glyph of `px`: thinner units as the
 *  glyph grows, so the line drawn is about 1.5 px small and 2 px large
 *  (14 px: 1.4, 18: 1.5, 22: 1.8, 26: 1.9, 30: 2.2). Solid a shade heavier. */
function strokeFor(pack: Exclude<IconPack, 'classic'>, px: number): number {
  const units = px <= 16 ? 1.8 : px <= 22 ? 1.5 : 1.3;
  return pack === 'solid' ? units + .2 : units;
}

function render(g: Glyph, pack: Exclude<IconPack, 'classic'>, id: string, sw: number): string {
  const out: string[] = [];
  const fill = (d: string | undefined, o: number) => d ? `<path d='${d}' fill='black' stroke='none'${o < 1 ? ` fill-opacity='${o}'` : ''}/>` : '';
  const stroke = (d: string | undefined, w = sw, o = 1) => d ? `<path d='${d}' stroke-width='${w}'${o < 1 ? ` stroke-opacity='${o}'` : ''}/>` : '';
  const defs: string[] = [];
  // A mask that takes `lines` (and `dots`) out of what it is put on.
  const cut = (name: string, lines: string, w: number, dots = '') => {
    defs.push(`<mask id='${name}' maskUnits='userSpaceOnUse' x='0' y='0' width='24' height='24'>`
      + `<rect width='24' height='24' fill='white'/>`
      + (lines ? `<path d='${lines}' fill='none' stroke='black' stroke-width='${w}'/>` : '')
      + (dots ? `<path d='${dots}' fill='black' stroke='none'/>` : '') + '</mask>');
    return `mask='url(#${name})'`;
  };
  // Hidden edges go under everything: a face filled in front of them hides them.
  out.push(stroke(g.hid, 1.2, .5));

  if (g.glass) out.push(fill(g.glass, .3));
  if (pack !== 'line' && g.soft) out.push(fill(g.soft, pack === 'solid' ? .32 : .14));
  if (pack === 'duotone' && g.a) out.push(fill(g.a, .26));
  if (pack === 'solid' && g.a) {
    // Filled; what is drawn inside it is cut out of the fill.
    const m = cut(`a${id}`, g.k ?? '', sw * .8, g.kd ?? '');
    out.push(`<g ${m}>${fill(g.a, 1)}</g>`);
  }
  // The face or layer shown: filled; one that looks away, in a half tone
  // that the edges in front of it still cross.
  if (g.hb) out.push(fill(g.hb, .45));
  if (g.hl) out.push(fill(g.hl, 1));

  out.push(stroke(g.s));
  out.push(stroke(g.bold, sw + 1));
  if (!(pack === 'solid' && g.a)) out.push(stroke(g.k), fill(g.kd, 1));
  out.push(fill(g.dot, 1));
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-linecap='round' stroke-linejoin='round'>`
    + (defs.length ? `<defs>${defs.join('')}</defs>` : '') + out.join('') + '</svg>';
}

const url = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
const varName = (id: string) => `--tcv-i-${id}`;

/** The stylesheet a pack needs at a size: its glyphs as variables on the
 *  root, and each button pointed at its own. Classic needs none. */
function sheet(pack: IconPack, px: number): string {
  const out: string[] = [];
  if (pack !== 'classic') {
    const sw = strokeFor(pack, px);
    const vars = Object.entries(GLYPHS).map(([id, g]) => `${varName(id)}:${url(render(g, pack, id.replace(/\W/g, ''), sw))};`);
    out.push(`:root{${vars.join('')}}`);
  }
  for (const id of LIB) out.push(`.tcv_button_${id}{--tcv-i:var(${varName(id)})}`);
  for (const [cls, id] of Object.entries(OURS)) out.push(`.tcv-ico-${cls}{--tcv-i:var(${varName(id)})}`);
  out.push(`.tcv-freeze{--tcv-i:var(${varName('pen')})}`);
  for (const id of DRAW) out.push(`.tcv-dt[data-i="${id}"]{--tcv-i:var(${varName('draw-' + id)})}`);
  return out.join('\n');
}

/** Write the glyphs for what is worn now; only when that changed. */
let written = '';
function wear(pack: IconPack, px: IconSize) {
  const root = document.documentElement;
  root.setAttribute('data-icons', pack);
  root.style.setProperty('--tcv-isz', px + 'px');
  const key = pack === 'classic' ? pack : `${pack}:${strokeFor(pack, px)}`;
  if (key === written) return;
  let el = document.getElementById('wb-icon-packs');
  if (!el) {
    el = document.createElement('style');
    el.id = 'wb-icon-packs';
    document.head.appendChild(el);
  }
  el.textContent = sheet(pack, px);
  written = key;
}

// ---- which pack ----
const KEY = 'redline.icons';
const SIZE_KEY = 'redline.iconSize';

export function currentIconSize(): IconSize {
  let n = NaN;
  try { n = Number(localStorage.getItem(SIZE_KEY)); } catch { /* private window */ }
  return (ICON_SIZES as readonly number[]).includes(n) ? n as IconSize : ICON_SIZE_DEFAULT;
}


export function setIconSize(px: IconSize): IconSize {
  try {
    if (px === ICON_SIZE_DEFAULT) localStorage.removeItem(SIZE_KEY);
    else localStorage.setItem(SIZE_KEY, String(px));
  } catch { /* private window: this page only */ }
  wear(currentIcons(), px);
  return px;
}

export function currentIcons(): IconPack {
  // The URL wins, as with the theme: a pack can be tried, or a screenshot
  // taken, without changing what the browser remembers.
  let want: string | null = null;
  try { want = new URLSearchParams(location.search).get('icons') ?? localStorage.getItem(KEY); }
  catch { /* private window */ }
  return (ICON_PACKS as readonly string[]).includes(want ?? '') ? want as IconPack : ICON_PACK_DEFAULT;
}

/** Wear a pack at the size picked: the pack is an attribute on the root,
 *  the size `--tcv-isz`, the glyphs a stylesheet written for both. */
export function applyIcons(pack: IconPack = currentIcons()): IconPack {
  wear(pack, currentIconSize());
  return pack;
}

/** Wear a pack and remember it. */
export function setIcons(pack: IconPack): IconPack {
  try {
    if (pack === ICON_PACK_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pack);
  } catch { /* private window: this page only */ }
  return applyIcons(pack);
}
