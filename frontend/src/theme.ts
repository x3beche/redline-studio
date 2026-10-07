/** Which theme the window wears.
 *
 *  Applied before the application renders, so nothing is painted in the
 *  default palette and repainted a frame later. A theme is a complete set
 *  of tokens in styles.css; this only decides which set is in force, and
 *  an unknown name falls back to the default rather than leaving the page
 *  with half a palette.
 */
export const THEMES = ['default', 'light', 'oled', 'vercel-dark', 'spartan-dark', 'github-dark', 'atom-one-dark', 'one-dark-pro', 'vscode-dark',
  'dracula', 'tokyo-night', 'catppuccin-mocha', 'nord', 'monokai', 'gruvbox-dark', 'solarized-dark', 'material-palenight', 'night-owl', 'ayu-mirage', 'rose-pine', 'kanagawa', 'synthwave-84', 'github-light', 'vscode-light', 'solarized-light', 'catppuccin-latte', 'gruvbox-light', 'high-contrast'] as const;

/** The ones drawn on a light ground: a board's drawings get light inks. */
export const LIGHT_THEMES: ReadonlySet<string> = new Set(['light', 'github-light', 'vscode-light', 'solarized-light', 'catppuccin-latte', 'gruvbox-light']);

/** What each is called where one is chosen. */
export const THEME_NAMES: Record<Theme, string> = {
  default: 'Redline dark', light: 'Light', oled: 'OLED black', 'vercel-dark': 'Vercel Dark', 'spartan-dark': 'Spartan Dark', 'github-dark': 'GitHub Dark',
  'atom-one-dark': 'Atom One Dark', 'one-dark-pro': 'One Dark Pro', 'vscode-dark': 'VS Code Dark',
  'dracula': 'Dracula',
  'tokyo-night': 'Tokyo Night',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'nord': 'Nord',
  'monokai': 'Monokai',
  'gruvbox-dark': 'Gruvbox Dark',
  'solarized-dark': 'Solarized Dark',
  'material-palenight': 'Material Palenight',
  'night-owl': 'Night Owl',
  'ayu-mirage': 'Ayu Mirage',
  'rose-pine': 'Rosé Pine',
  'kanagawa': 'Kanagawa',
  'synthwave-84': "Synthwave '84",
  'github-light': 'GitHub Light',
  'vscode-light': 'VS Code Light',
  'solarized-light': 'Solarized Light',
  'catppuccin-latte': 'Catppuccin Latte',
  'gruvbox-light': 'Gruvbox Light',
  'high-contrast': 'High Contrast',
};
export type Theme = (typeof THEMES)[number];

const KEY = 'redline.theme';
/** The custom theme being worn, kept whole so the first paint has it
 *  without asking the server (see custom-themes.ts for where they come from). */
const CUSTOM_KEY = 'redline.theme.custom';

/** A theme someone made: a built-in base with some of its tokens changed. */
export interface CustomTheme {
  id: string;
  name: string;
  base: Theme;
  light: boolean;
  /** Token -> colour, only the ones that differ from the base. */
  vars: Record<string, string>;
  by?: { id: string; name: string } | null;
  mine?: boolean;
  can_edit?: boolean;
}

/** What is worn: a built-in theme, or `custom:<id>`. */
export type ThemeId = Theme | `custom:${string}`;
export const CUSTOM_PREFIX = 'custom:';
export const isCustom = (t: string): t is `custom:${string}` => t.startsWith(CUSTOM_PREFIX);

/** The custom theme this browser wears, if it wears one. */
export function cachedCustom(): CustomTheme | null {
  try {
    const c = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? 'null') as CustomTheme | null;
    return c && typeof c.id === 'string' && c.vars && typeof c.vars === 'object' ? c : null;
  } catch {
    return null;
  }
}

export function currentTheme(): ThemeId {
  // The URL wins, so a theme can be tried - or a screenshot taken - without
  // changing what the browser remembers.
  const asked = new URLSearchParams(location.search).get('theme');
  const saved = safeRead();
  const want = asked ?? saved;
  // A custom theme only when this browser has it whole; else its base.
  if (want && isCustom(want)) {
    const c = cachedCustom();
    if (c && CUSTOM_PREFIX + c.id === want) return want;
    return c && (THEMES as readonly string[]).includes(c.base) ? c.base : 'default';
  }
  return (THEMES as readonly string[]).includes(want ?? '')
    ? (want as Theme) : 'default';
}

/** The tokens set on the root by the custom theme worn now, to take off. */
let worn: string[] = [];
let lightNow = false;

/** Whether what is worn now is drawn on a light ground. */
export function themeIsLight(): boolean { return lightNow; }

/** Whether a theme is drawn on a light ground. */
export function isLightTheme(t: ThemeId): boolean {
  if (!isCustom(t)) return LIGHT_THEMES.has(t);
  const c = cachedCustom();
  return c && CUSTOM_PREFIX + c.id === t ? c.light : lightNow;
}

function wearBase(theme: Theme) {
  // The default is what :root already carries, so it wears no attribute.
  const root = document.documentElement;
  for (const k of worn) root.style.removeProperty(k);
  worn = [];
  if (theme === 'default') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  lightNow = LIGHT_THEMES.has(theme);
}

/** Wear a custom theme without remembering it: its base, then its tokens,
 *  then what follows from them. What the editor previews with. */
export function wearCustom(c: Pick<CustomTheme, 'base' | 'light' | 'vars'>) {
  wearBase((THEMES as readonly string[]).includes(c.base) ? c.base : 'default');
  const all = { ...derived(c.vars, c.light, LIGHT_THEMES.has(c.base)), ...c.vars };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(all)) {
    if (!/^--[a-z0-9-]+$/.test(k)) continue;
    root.style.setProperty(k, v);
    worn.push(k);
  }
  lightNow = !!c.light;
}

export function applyTheme(theme: ThemeId = currentTheme()): ThemeId {
  if (isCustom(theme)) {
    const c = cachedCustom();
    if (c && CUSTOM_PREFIX + c.id === theme) { wearCustom(c); return theme; }
    theme = 'default';
  }
  wearBase(theme);
  return theme;
}

/** Wear a theme and remember it. A custom one comes whole, to be kept for
 *  the next first paint. */
export function setTheme(theme: ThemeId, custom?: CustomTheme): ThemeId {
  try {
    if (isCustom(theme) && custom) localStorage.setItem(CUSTOM_KEY, JSON.stringify(
      { id: custom.id, name: custom.name, base: custom.base, light: custom.light, vars: custom.vars }));
    else if (!isCustom(theme)) localStorage.removeItem(CUSTOM_KEY);
    if (theme === 'default') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch { /* private window, or storage full */ }
  return applyTheme(theme);
}

/** Parse #rgb, #rrggbb, #rrggbbaa or rgb()/rgba() into [r, g, b, a]. */
export function parseColour(v: string): [number, number, number, number] | null {
  v = (v ?? '').trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
            h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i.exec(v);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  return null;
}

/** How light a colour looks, 0..1 (WCAG relative luminance). */
export function luminance(v: string): number | null {
  const c = parseColour(v);
  if (!c) return null;
  const lin = (x: number) => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; };
  return .2126 * lin(c[0]) + .7152 * lin(c[1]) + .0722 * lin(c[2]);
}

/** Ink that reads on a colour: near-black on a light one, white on a dark one. */
function inkOn(v: string): string | null {
  const l = luminance(v);
  if (l === null) return null;
  return l > .4 ? 'rgba(0, 0, 0, .85)' : 'rgba(255, 255, 255, .95)'; // theme:pigment
}

/** The tokens that follow from the ones chosen, where the base's own would
 *  no longer fit: text on the accent, the pressed state, the pen's wash.
 *  Only for tokens the theme does not set itself. */
export function derived(vars: Record<string, string>, light: boolean, baseLight: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const has = (k: string) => k in vars;
  const on = (src: string, dst: string) => {
    if (has(src) && !has(dst)) { const ink = inkOn(vars[src]); if (ink) out[dst] = ink; }
  };
  on('--accent', '--ink-on-accent');
  on('--ok', '--ink-on-ok');
  on('--warn', '--ink-on-warn');
  if (has('--hover') || has('--surface')) out['--pressed'] = 'color-mix(in srgb, var(--hover) 70%, var(--surface))';
  if (has('--accent')) {
    out['--accent-deep'] = 'color-mix(in srgb, var(--accent) 55%, var(--surface))';
    out['--tooltip-bg'] = 'color-mix(in srgb, var(--accent) 45%, var(--surface))';
  }
  if (has('--pen')) out['--pen-wash'] = 'color-mix(in srgb, var(--pen) 6%, transparent)';
  if (has('--surface')) {
    out['--overlay'] = 'color-mix(in srgb, var(--surface) 70%, transparent)';
    out['--overlay-rest'] = 'color-mix(in srgb, var(--surface) 14%, transparent)';
  }
  if (has('--ink') || light !== baseLight)
    out['--ink-bright'] = `color-mix(in srgb, var(--ink) 40%, ${light ? 'black' : 'white'})`;
  if (light !== baseLight) {
    const s = light ? '0, 0, 0' : '255, 255, 255';
    out['--scroll-thumb'] = `rgba(${s}, .2)`;
    out['--scroll-hover'] = `rgba(${s}, .4)`;
    out['--scroll-active'] = `rgba(${s}, .6)`;
  }
  for (const k of Object.keys(out)) if (has(k)) delete out[k];
  return out;
}

/** What a built-in theme's tokens are, read from the stylesheet by wearing
 *  it for a moment (no frame is painted in between) and putting back what
 *  was worn. Colours come back as #rrggbb, or #rrggbbaa when see-through. */
export function themeTokens(base: Theme, tokens: readonly string[]): Record<string, string> {
  const root = document.documentElement;
  const attr = root.getAttribute('data-theme');
  const inline = worn.map(k => [k, root.style.getPropertyValue(k)] as const);
  for (const [k] of inline) root.style.removeProperty(k);
  if (base === 'default') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', base);
  const cs = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const t of tokens) out[t] = toHex(cs.getPropertyValue(t).trim());
  if (attr === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', attr);
  for (const [k, v] of inline) root.style.setProperty(k, v);
  return out;
}

let probe: CanvasRenderingContext2D | null = null;

/** Any CSS colour as #rrggbb or #rrggbbaa (what a colour picker and the
 *  server both take). */
export function toHex(css: string): string {
  if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(css)) return css.toLowerCase();
  const hex = (c: [number, number, number, number]) => '#' + c.slice(0, 3)
    .map(n => Math.round(n).toString(16).padStart(2, '0')).join('')
    + (c[3] < 1 ? Math.round(c[3] * 255).toString(16).padStart(2, '0') : '');
  const direct = parseColour(css);
  if (direct) return hex(direct);
  probe ??= document.createElement('canvas').getContext('2d');
  if (!probe) return css;
  probe.fillStyle = '#000'; // theme:pigment
  probe.fillStyle = css;
  const got = parseColour(String(probe.fillStyle));
  return got ? hex(got) : css;
}

function safeRead(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;                        // private window
  }
}
