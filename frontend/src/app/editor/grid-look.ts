import { t } from '../i18n';
import { GRID_AXES, GRID_EVENT, GridAxis, GridLook, applyGridVars, axisColour, currentGrid, keepShown } from './grid-pref';

/** The 3D viewer's grid, drawn in the app's language.
 *
 *  three-cad-viewer draws its grid as dashed grey lines with a "+20.0" at
 *  every line, on both axes of every plane, in both directions - the
 *  origin's labels stacked on each other. Its Grid class is not exported,
 *  so the one the viewer built is reached through `viewer.gridHelper` and
 *  its prototype takes our create(): solid hairlines in the theme's dim ink,
 *  a stronger line every major step (4 or 5 minors, so the steps stay round
 *  numbers), faded out towards the rim; each plane's two axes in the axis
 *  colours (grid-pref.ts); labels only at the major lines, in the mono face,
 *  each axis once (the first plane on that shows it), the unit once at the
 *  far end. Everything else stays the viewer's: which planes are on, the
 *  spacing as you zoom, centring, the labels' size on screen.
 *
 *  Three.js is bundled inside the viewer, and its code checks `instanceof`
 *  against its own classes, so ours are not used: the classes are taken
 *  from the objects of the grid it built first (capture()). */

type Ctor = new (...a: any[]) => any;
interface Kit {
  Group: Ctor; Plane: Ctor; Lines: Ctor; Geometry: Ctor; Attr: Ctor;
  LineMat: Ctor; Sprite: Ctor; SpriteMat: Ctor; Texture: Ctor; Color: Ctor;
}
let kit: Kit | null = null;

/** Each plane's local x and z run along these world axes, with these signs
 *  (the viewer turns plane 0 about X, 1 about Y, 2 about Z). */
const PLANES: { u: GridAxis; v: GridAxis; du: number; dv: number }[] = [
  { u: 'x', v: 'y', du: 1, dv: -1 },   // XY
  { u: 'z', v: 'x', du: -1, dv: 1 },   // XZ
  { u: 'y', v: 'z', du: 1, dv: 1 },    // YZ
];
/** The planes that can show an axis's labels, in the order they are asked. */
const OWNERS: Record<GridAxis, number[]> = { x: [0, 1], y: [0, 2], z: [1, 2] };
/** Pieces a line is cut into, so its fade has vertices to sit on. */
const PIECES = 24;
const MONO = `'IBM Plex Mono', ui-monospace, monospace`;

/** −20, 0.4, 100: no plus, no trailing zeros, a real minus. */
export function gridNumber(v: number): string {
  const r = Math.round(v * 1e4) / 1e4;
  return (r < 0 ? '−' : '') + String(Math.abs(r));
}

/** Minors in a major step: 4 when the step is 2, 4 or 8 (0.5, 1, 2), else 5. */
export function gridSubdivisions(major: number): number {
  if (!(major > 0)) return 5;
  const m = Math.round((major / 10 ** Math.floor(Math.log10(major))) * 100) / 100;
  return m === 2 || m === 4 || m === 8 ? 4 : 5;
}

/** 1 inside, 0 at the rim: the grid fades out as a disc, not a square. */
function fade(x: number, z: number, half: number): number {
  const r = Math.hypot(x, z) / half;
  if (r <= 0.45) return 1;
  if (r >= 1) return 0;
  const s = (r - 0.45) / 0.55;
  return 1 - s * s * (3 - 2 * s);
}

function capture(grid: any): Kit | null {
  const plane = grid?.children?.[0];
  const helper = plane?.children?.[0];
  const dashed = helper?.children?.[0], solid = helper?.children?.[1];
  const sprite = plane?.children?.find((c: any) => c?.isSprite);
  if (!dashed?.geometry || !solid?.material?.color || !sprite?.material?.map) return null;
  return {
    Group: Object.getPrototypeOf(Object.getPrototypeOf(grid)).constructor,
    Plane: plane.constructor, Lines: dashed.constructor, Geometry: dashed.geometry.constructor,
    Attr: dashed.geometry.getAttribute('position').constructor,
    LineMat: solid.material.constructor, Color: solid.material.color.constructor,
    Sprite: sprite.constructor, SpriteMat: sprite.material.constructor, Texture: sprite.material.map.constructor,
  };
}

function dispose(o: any) {
  o?.traverse?.((c: any) => { c.geometry?.dispose?.(); if (!c.isSprite) c.material?.dispose?.(); });
}

/** A line from a to b on a plane (y = 0), in pieces that carry the fade as alpha. */
function line(P: number[], A: number[], ax: number, az: number, bx: number, bz: number, half: number) {
  for (let s = 0; s < PIECES; s++) {
    const x0 = ax + (bx - ax) * s / PIECES, z0 = az + (bz - az) * s / PIECES;
    const x1 = ax + (bx - ax) * (s + 1) / PIECES, z1 = az + (bz - az) * (s + 1) / PIECES;
    const a0 = fade(x0, z0, half), a1 = fade(x1, z1, half);
    if (a0 <= 0 && a1 <= 0) continue;
    P.push(x0, 0, z0, x1, 0, z1);
    A.push(1, 1, 1, a0, 1, 1, 1, a1);
  }
}

function lines(into: any, P: number[], A: number[], colour: string, opacity: number) {
  if (!kit || !P.length || !colour) return;
  const geo = new kit.Geometry();
  geo.setAttribute('position', new kit.Attr(P, 3));
  geo.setAttribute('color', new kit.Attr(A, 4));
  const mat = new kit.LineMat({ color: colour, transparent: true, opacity, vertexColors: true, depthWrite: false });
  into.add(new kit.Lines(geo, mat));
}

/** One plane's lines (or dots) and its two axes, in the plane's own frame. */
function planeLines(i: number, half: number, minor: number, sub: number, look: GridLook, ink: string): any {
  const g = new kit!.Group();
  g.name = 'GridLines';
  const n = Math.floor(half / minor + 1e-6);
  const mi: number[] = [], miA: number[] = [], ma: number[] = [], maA: number[] = [];
  if (look.style === 'lines') {
    for (let k = -n; k <= n; k++) {
      if (k === 0) continue;   // the axis is drawn on its own
      const p = k * minor, major = k % sub === 0;
      line(major ? ma : mi, major ? maA : miA, p, -half, p, half, half);
      line(major ? ma : mi, major ? maA : miA, -half, p, half, p, half);
    }
  } else if (look.style === 'dots') {
    // A small cross where two lines would meet; a larger one on the majors.
    for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
      if (a === 0 || b === 0) continue;
      const x = a * minor, z = b * minor, f = fade(x, z, half);
      if (f <= 0) continue;
      const major = a % sub === 0 && b % sub === 0, r = minor * (major ? 0.2 : 0.09);
      (major ? ma : mi).push(x - r, 0, z, x + r, 0, z, x, 0, z - r, x, 0, z + r);
      (major ? maA : miA).push(1, 1, 1, f, 1, 1, 1, f, 1, 1, 1, f, 1, 1, 1, f);
    }
  }
  lines(g, mi, miA, ink, look.opacity * (look.style === 'dots' ? 0.7 : 0.26));
  lines(g, ma, maA, ink, look.opacity * (look.style === 'dots' ? 1 : 0.85));
  const pl = PLANES[i];
  const uP: number[] = [], uA: number[] = [], vP: number[] = [], vA: number[] = [];
  line(uP, uA, -half, 0, half, 0, half);
  line(vP, vA, 0, -half, 0, half, half);
  lines(g, uP, uA, axisColour(pl.u), 0.8);
  lines(g, vP, vA, axisColour(pl.v), 0.8);
  return g;
}

/** A label's picture: the number in the mono face, dim, with a soft edge of
 *  the backdrop so a line under it does not cut through. Kept per grid. */
function label(grid: any, text: string, ink: string, edge: string): { mat: any; aspect: number } {
  const cache: Map<string, { mat: any; aspect: number }> = grid.__wbLabels ??= new Map();
  const hit = cache.get(text);
  if (hit) return hit;
  const h = grid.canvasHeight || 128, size = Math.round(h * 0.72), pad = Math.round(h * 0.1);
  const font = `500 ${size}px ${MONO}`;
  const c = document.createElement('canvas');
  let ctx = c.getContext('2d')!;
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width + pad * 2);
  c.height = h;
  ctx = c.getContext('2d')!;
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (edge) {
    ctx.lineWidth = Math.round(size * 0.22);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = edge;
    ctx.globalAlpha = 0.85;
    ctx.strokeText(text, pad, h / 2);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = ink;
  ctx.fillText(text, pad, h / 2);
  const tex = new kit!.Texture(c);
  tex.colorSpace = 'srgb';
  tex.generateMipmaps = false;
  tex.anisotropy = grid.maxAnisotropy ?? 1;
  tex.needsUpdate = true;
  const mat = new kit!.SpriteMat({ map: tex, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: false });
  const out = { mat, aspect: c.width / h };
  cache.set(text, out);
  return out;
}

function dropLabels(grid: any) {
  const cache: Map<string, { mat: any }> | undefined = grid.__wbLabels;
  if (!cache) return;
  for (const { mat } of cache.values()) { mat.map?.dispose?.(); mat.dispose?.(); }
  cache.clear();
}

/** Labels at the major lines of a plane's two axes; the far positive one carries the unit. */
function planeLabels(grid: any, into: any, i: number, half: number, major: number, look: GridLook) {
  if (look.labels === 'none') return;
  const cs = getComputedStyle(document.documentElement);
  const ink = cs.getPropertyValue('--ink-dim').trim(), edge = cs.getPropertyValue('--view-mid').trim();
  const n = Math.floor(half / major + 1e-6);
  const pl = PLANES[i];
  for (const [axis, dir, onU] of [[pl.u, pl.du, true], [pl.v, pl.dv, false]] as [GridAxis, number, boolean][]) {
    for (let k = -n; k <= n; k++) {
      if (k === 0) continue;   // the origin is where the axes cross; it needs no number
      const v = k * major;
      const { mat, aspect } = label(grid, gridNumber(v) + (k === n ? ' mm' : ''), ink, edge);
      const s = new kit!.Sprite(mat);
      s.position.set(onU ? dir * v : 0, 0, onU ? 0 : dir * v);
      // The point is the picture's top-left corner: the number sits beside
      // and under its line rather than on it.
      s.center.set(0, 1);
      s.userData.aspectRatio = aspect;
      s.userData.axis = axis;
      into.add(s);
    }
  }
}

/** Our create(): the viewer's sizing, our drawing. */
function build(grid: any, nice: boolean) {
  if (nice) {
    const b = grid.bbox;
    const s2 = Math.max(Math.abs(b.max.x), Math.abs(b.max.y), Math.abs(b.max.z),
                        Math.abs(b.min.x), Math.abs(b.min.y), Math.abs(b.min.z));
    const [a0, a1, step] = grid.niceBounds(-s2 * 1.05, s2 * 1.05, grid.ticks);
    grid.size = a1 - a0;
    grid.ticks = grid.size / step;
    grid.ticks0 = grid.ticks;
    grid.delta = step;
  } else {
    grid.delta = grid.size / grid.ticks;
  }
  grid.setTickInfo();
  const look = currentGrid();
  grid.__wbOnce = look.labels === 'major';
  const half = grid.size / 2, major = grid.delta;
  if (!(half > 0) || !(major > 0)) return;
  const sub = gridSubdivisions(major), minor = major / sub;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink-dim').trim();
  for (let i = 0; i < 3; i++) {
    const plane = new kit!.Plane();
    plane.name = `GridHelper-${i}`;
    plane.add(planeLines(i, half, minor, sub, look, ink));
    planeLabels(grid, plane, i, half, major, look);
    grid.add(plane);
  }
  grid.children[0].rotateX(Math.PI / 2);
  grid.children[1].rotateY(Math.PI / 2);
  grid.children[2].rotateZ(Math.PI / 2);
  grid.setCenter(grid.getAxes0(), grid.flipY);
  grid.scaleLabels();
  grid.setVisible();
}

/** Which labels show: none when the viewer has them off (zoomed far out);
 *  with "major", an axis only on the first of its planes that is on. */
function showLabels(grid: any) {
  const on = grid.__wbShow ?? true;
  const owner: Partial<Record<GridAxis, number>> = {};
  if (grid.__wbOnce) for (const a of GRID_AXES) owner[a] = OWNERS[a].find(i => grid.grid?.[i]) ?? -1;
  (grid.children ?? []).forEach((plane: any, i: number) => {
    for (let j = 1; j < (plane.children?.length ?? 0); j++) {
      const c = plane.children[j], a = c.userData?.axis as GridAxis | undefined;
      c.visible = on && (!grid.__wbOnce || !a || owner[a] === i);
    }
  });
}

function patch(proto: any) {
  if (proto.__wbGrid) return;
  proto.__wbGrid = true;
  const own = { create: proto.create, setTickInfo: proto.setTickInfo, setVisible: proto.setVisible, dispose: proto.dispose };
  proto.create = function (this: any, nice = true) {
    if (!kit) return own.create.call(this, nice);
    build(this, nice);
    return Promise.resolve();
  };
  proto.showLabels = function (this: any, flag: boolean) {
    this.__wbShow = flag;
    showLabels(this);
  };
  proto.setVisible = function (this: any) {
    own.setVisible.call(this);
    showLabels(this);
  };
  // "Grid 4 mm" under the triad, for the ⊢⊣ and a bare "10.0".
  proto.setTickInfo = function (this: any) {
    if (!this.tickValue) return;
    const sub = gridSubdivisions(this.delta);
    this.tickValue.textContent = `${gridNumber(this.delta / sub)} mm`;
    const head = this.info?.firstChild;
    if (head?.nodeType === Node.TEXT_NODE) head.textContent = `${t('Grid')} `;
  };
  proto.dispose = function (this: any) {
    dropLabels(this);
    return own.dispose?.call(this);
  };
}

/** The axes the toolbar's axes button shows: the axis colours, thinner. */
function dressAxes(viewer: any) {
  const ax = viewer?.rendered?.axesHelper;
  if (!ax?.geometry?.setColors || !kit) return;
  const rgb: number[] = [];
  for (const a of GRID_AXES) {
    const c = new kit.Color(axisColour(a));
    rgb.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  ax.geometry.setColors(new Float32Array(rgb));
  if (ax.material) { ax.material.linewidth = 1.5; ax.material.opacity = 0.9; }
}

let shown: any = null;
let queued = 0;

/** Draw the grid again: after the look, the theme or the fonts changed. */
function redraw() {
  queued = 0;
  const viewer = shown;
  let grid: any;
  try { grid = viewer?.gridHelper; } catch { return; }
  if (!grid || !kit) return;
  dropLabels(grid);
  for (const c of [...grid.children]) { dispose(c); grid.remove(c); }
  grid.create(false);
  dressAxes(viewer);
  try { viewer.update?.(viewer.updateMarker); } catch { /* not rendered yet */ }
}
function later() { if (!queued) queued = requestAnimationFrame(redraw); }

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  applyGridVars();
  window.addEventListener(GRID_EVENT, later);
  // The theme is the root's data-theme (and a custom theme's tokens on its style).
  new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'lang'] });
  document.fonts?.load(`500 64px ${MONO}`).then(later, () => {});
}

const remembered = new WeakSet<object>();
/** The planes and the axes as they are switched, kept for the next load
 *  (grid-pref.ts keepShown); the viewer's state outlives its renders. */
function remember(viewer: any) {
  const st = viewer?.state;
  if (!st?.subscribe || remembered.has(st)) return;
  remembered.add(st);
  const keep = () => keepShown({ grid: [...(st.get('grid') ?? [false, false, false])].map(Boolean) as [boolean, boolean, boolean], axes: !!st.get('axes') });
  st.subscribe('grid', keep);
  st.subscribe('axes', keep);
}

/** After each render(): the viewer's new grid gets our drawing. The first
 *  grid of the page is built by the viewer's own code (it is what the
 *  classes are taken from) and drawn again at once. */
export function dressGrid(viewer: any) {
  let grid: any;
  try { grid = viewer?.gridHelper; } catch { return; }
  if (!grid) return;
  remember(viewer);
  kit ??= capture(grid);
  if (!kit) return;
  patch(Object.getPrototypeOf(grid));
  shown = viewer;
  listen();
  redraw();
}

/** The grid button's planes: the viewer hangs three bare checkboxes ("xy")
 *  off it on hover. They become a menu like the app's others - a title,
 *  rows with the app's checkbox and the plane's name, the whole row a
 *  target - that also opens from the keyboard: arrow down from the button,
 *  arrows between rows, Space or Enter to switch, Escape back. */
export function dressGridMenu(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>('.tcv_grid-dropdown');
  const menu = frame?.querySelector<HTMLElement>('.tcv_grid-content');
  const button = frame?.querySelector<HTMLInputElement>('input.tcv_btn');
  if (!frame || !menu || !button || menu.dataset['wb']) return;
  menu.dataset['wb'] = '1';
  menu.classList.add('wb-gridmenu');
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', t('Grid planes'));
  button.setAttribute('aria-haspopup', 'true');
  const head = document.createElement('div');
  head.className = 'wb-gridmenu-head';
  head.textContent = t('Grid planes');
  menu.prepend(head);
  const names: Record<string, string> = { xy: 'XY plane', xz: 'XZ plane', yz: 'YZ plane' };
  for (const row of menu.querySelectorAll<HTMLElement>(':scope > div.tcv_tooltip')) {
    const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const text = row.querySelector<HTMLLabelElement>('label');
    const plane = /tcv_grid-(\w+)/.exec(box?.className ?? '')?.[1] ?? '';
    if (!box || !text) continue;
    row.classList.remove('tcv_tooltip');
    row.removeAttribute('data-tooltip');
    row.className = 'wb-gridmenu-row';
    box.classList.add('tcv-check');
    text.textContent = t(names[plane] ?? plane.toUpperCase());
    const tag = document.createElement('span');
    tag.className = 'wb-gridmenu-tag';
    tag.textContent = plane.toUpperCase();
    tag.setAttribute('aria-hidden', 'true');
    row.appendChild(tag);
    // The row is the target, not just the box and its word.
    row.addEventListener('click', e => { if (e.target === row || e.target === tag) box.click(); });
  }
  const boxes = () => [...menu.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const close = () => { delete frame.dataset['open']; };
  frame.addEventListener('keydown', e => {
    const list = boxes(), at = list.indexOf(document.activeElement as HTMLInputElement);
    let done = true;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      frame.dataset['open'] = '1';
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const i = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
      list[i]?.focus();
    } else if (e.key === 'Home' && at >= 0) list[0]?.focus();
    else if (e.key === 'End' && at >= 0) list[list.length - 1]?.focus();
    else if (e.key === 'Enter' && at >= 0) list[at].click();
    else if (e.key === 'Escape' && frame.dataset['open']) { close(); button.focus(); }
    else if (e.key === ' ' && at >= 0) done = false;   // the checkbox's own
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
    else if (at >= 0) e.stopPropagation();   // the viewer's letter keys are not for the menu
  });
  frame.addEventListener('focusout', e => { if (!frame.contains(e.relatedTarget as Node | null)) close(); });
  frame.addEventListener('mouseleave', () => { if (!frame.contains(document.activeElement)) close(); });
}
