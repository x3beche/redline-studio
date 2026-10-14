/** How the 3D viewer's model tree looks (editor/viewer-panel.css), chosen
 *  in Settings > Appearance under Model tree: how tall a row is, the type
 *  size, the glyphs' size (the toolbars' by default, icon-packs.ts), and
 *  whether the indent guides, the "×6" counts and the colour dots show.
 *
 *  Kept per browser like the theme and the icon pack (`redline.tree`) and
 *  applied before the first paint (main.ts): variables and attributes on
 *  the root, which the panel's stylesheet reads. */

export const TREE_DENSITIES = ['compact', 'normal', 'comfortable'] as const;
export type TreeDensity = (typeof TREE_DENSITIES)[number];
/** A row's height, in px, for each density. */
const ROW: Record<TreeDensity, number> = { compact: 20, normal: 24, comfortable: 28 };
export const TREE_FONTS = [11, 12, 13, 14] as const;
/** The glyphs' size: 0 is "as the toolbars", scaled to the row. */
export const TREE_ICONS = [0, 12, 14, 16, 18] as const;

export interface TreeLook {
  density: TreeDensity;
  font: number;
  icon: number;
  guides: boolean;
  counts: boolean;
  dots: boolean;
}

export const TREE_DEFAULT: TreeLook = { density: 'normal', font: 12, icon: 0, guides: true, counts: true, dots: true };

const KEY = 'redline.tree';

export function currentTree(): TreeLook {
  let kept: Partial<TreeLook> = {};
  try { kept = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* private window, or not JSON */ }
  const d = TREE_DEFAULT;
  return {
    density: (TREE_DENSITIES as readonly string[]).includes(kept.density as string) ? kept.density! : d.density,
    font: (TREE_FONTS as readonly number[]).includes(kept.font as number) ? kept.font! : d.font,
    icon: (TREE_ICONS as readonly number[]).includes(kept.icon as number) ? kept.icon! : d.icon,
    guides: typeof kept.guides === 'boolean' ? kept.guides : d.guides,
    counts: typeof kept.counts === 'boolean' ? kept.counts : d.counts,
    dots: typeof kept.dots === 'boolean' ? kept.dots : d.dots,
  };
}

/** Wear a look: the root's variables and attributes. */
export function applyTree(look: TreeLook = currentTree()): TreeLook {
  const root = document.documentElement;
  root.style.setProperty('--tcv-tv-row', ROW[look.density] + 'px');
  root.style.setProperty('--tcv-tv-fs', look.font + 'px');
  if (look.icon) root.style.setProperty('--tcv-tv-isz', look.icon + 'px');
  else root.style.removeProperty('--tcv-tv-isz');
  const flag = (name: string, on: boolean) => on ? root.removeAttribute(name) : root.setAttribute(name, 'off');
  flag('data-tv-guides', look.guides);
  flag('data-tv-counts', look.counts);
  flag('data-tv-dots', look.dots);
  return look;
}

/** Wear a look and remember it. */
export function setTree(look: TreeLook): TreeLook {
  try {
    if (isDefaultTree(look)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(look));
  } catch { /* private window: this page only */ }
  return applyTree(look);
}

export function isDefaultTree(look: TreeLook): boolean {
  return (Object.keys(TREE_DEFAULT) as (keyof TreeLook)[]).every(k => look[k] === TREE_DEFAULT[k]);
}
