/** How the 3D viewer's grid looks (grid-look.ts), picked in Settings >
 *  Appearance and kept in this browser like the theme. The planes that are
 *  on and the spacing stay the viewer's own; this is only the drawing. */
export const GRID_STYLES = ['lines', 'dots', 'off'] as const;
export type GridStyle = (typeof GRID_STYLES)[number];
export const GRID_LABELS = ['none', 'major', 'all'] as const;
export type GridLabels = (typeof GRID_LABELS)[number];
export const GRID_AXES = ['x', 'y', 'z'] as const;
export type GridAxis = (typeof GRID_AXES)[number];

export interface GridLook {
  style: GridStyle;
  /** How strong the grid's lines are, .1 to 1. */
  opacity: number;
  labels: GridLabels;
  /** An axis's own colour, or null for the theme's. */
  axes: Record<GridAxis, string | null>;
}

export const GRID_DEFAULT: GridLook = { style: 'lines', opacity: 0.5, labels: 'major', axes: { x: null, y: null, z: null } };
/** The theme token an axis takes when it has no colour of its own: red,
 *  green and blue in every theme, as a CAD program draws X, Y and Z. */
export const AXIS_TOKEN: Record<GridAxis, string> = { x: '--danger', y: '--ok', z: '--series-1' };
/** Where an axis's own colour is put on the root, for anything to read. */
export const AXIS_VAR: Record<GridAxis, string> = { x: '--tcv-axis-x', y: '--tcv-axis-y', z: '--tcv-axis-z' };
/** Sent on the window when the look changes, so the viewer redraws. */
export const GRID_EVENT = 'redline-grid-look';

const KEY = 'redline.grid';
const HEX = /^#[0-9a-f]{6}$/i;

export function currentGrid(): GridLook {
  let raw: Partial<GridLook> | null = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { /* private window, or not JSON */ }
  const g = raw && typeof raw === 'object' ? raw : {};
  const axes = { ...GRID_DEFAULT.axes };
  for (const a of GRID_AXES) {
    const c = (g.axes as Record<string, unknown> | undefined)?.[a];
    if (typeof c === 'string' && HEX.test(c)) axes[a] = c;
  }
  const op = Number(g.opacity);
  return {
    style: (GRID_STYLES as readonly string[]).includes(g.style ?? '') ? g.style as GridStyle : GRID_DEFAULT.style,
    opacity: Number.isFinite(op) ? Math.min(1, Math.max(0.1, op)) : GRID_DEFAULT.opacity,
    labels: (GRID_LABELS as readonly string[]).includes(g.labels ?? '') ? g.labels as GridLabels : GRID_DEFAULT.labels,
    axes,
  };
}

/** Keep a look (the default is kept as nothing), put its axis colours on
 *  the root and tell the viewer. */
export function setGrid(g: GridLook): GridLook {
  try {
    if (JSON.stringify(g) === JSON.stringify(GRID_DEFAULT)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(g));
  } catch { /* private window: this page only */ }
  applyGridVars(g);
  window.dispatchEvent(new CustomEvent(GRID_EVENT));
  return g;
}

/** The axes' own colours as --tcv-axis-* on the root; an axis on the
 *  theme's colour has none. */
export function applyGridVars(g: GridLook = currentGrid()) {
  const root = document.documentElement.style;
  for (const a of GRID_AXES) {
    if (g.axes[a]) root.setProperty(AXIS_VAR[a], g.axes[a]);
    else root.removeProperty(AXIS_VAR[a]);
  }
}

/** An axis's colour now: its own, else the theme's. */
export function axisColour(a: GridAxis): string {
  const cs = getComputedStyle(document.documentElement);
  return cs.getPropertyValue(AXIS_VAR[a]).trim() || cs.getPropertyValue(AXIS_TOKEN[a]).trim();
}

/** Which planes and whether the axes show, as last left in the 3D room:
 *  kept per browser so a reload or the next model keeps them. Off on a
 *  first visit. */
export interface GridShown { grid: [boolean, boolean, boolean]; axes: boolean }
const SHOWN_KEY = 'redline.gridShown';

export function currentShown(): GridShown {
  let raw: Partial<GridShown> | null = null;
  try { raw = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? 'null'); } catch { /* private window, or not JSON */ }
  const g = Array.isArray(raw?.grid) && raw.grid.length === 3 ? raw.grid.map(v => v === true) : [false, false, false];
  return { grid: g as [boolean, boolean, boolean], axes: raw?.axes === true };
}

export function keepShown(s: GridShown) {
  try {
    if (!s.axes && !s.grid.some(Boolean)) localStorage.removeItem(SHOWN_KEY);
    else localStorage.setItem(SHOWN_KEY, JSON.stringify(s));
  } catch { /* private window: this page only */ }
}

/** The render options for them; a picture for tools/render.py (?shot) shows neither. */
export function shownOptions(shot: boolean): { axes: boolean; grid: [boolean, boolean, boolean] } {
  const s = shot ? { grid: [false, false, false] as [boolean, boolean, boolean], axes: false } : currentShown();
  return { axes: s.axes, grid: [...s.grid] as [boolean, boolean, boolean] };
}
