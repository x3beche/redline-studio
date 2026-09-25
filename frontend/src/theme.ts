/** Which theme the window wears.
 *
 *  Applied before the application renders, so nothing is painted in the
 *  default palette and repainted a frame later. A theme is a complete set
 *  of tokens in styles.css; this only decides which set is in force, and
 *  an unknown name falls back to the default rather than leaving the page
 *  with half a palette.
 */
export const THEMES = ['default', 'light', 'oled', 'github-dark', 'atom-one-dark', 'one-dark-pro', 'vscode-dark',
  'dracula', 'tokyo-night', 'catppuccin-mocha', 'nord', 'monokai', 'gruvbox-dark', 'solarized-dark', 'material-palenight', 'night-owl', 'ayu-mirage', 'rose-pine', 'kanagawa', 'synthwave-84', 'github-light', 'vscode-light', 'solarized-light', 'catppuccin-latte', 'gruvbox-light', 'high-contrast'] as const;

/** The ones drawn on a light ground: a board's drawings get light inks. */
export const LIGHT_THEMES: ReadonlySet<string> = new Set(['light', 'github-light', 'vscode-light', 'solarized-light', 'catppuccin-latte', 'gruvbox-light']);

/** What each is called where one is chosen. */
export const THEME_NAMES: Record<Theme, string> = {
  default: 'Redline dark', light: 'Light', oled: 'OLED black', 'github-dark': 'GitHub Dark',
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

const KEY = 'x3.theme';

export function currentTheme(): Theme {
  // The URL wins, so a theme can be tried - or a screenshot taken - without
  // changing what the browser remembers.
  const asked = new URLSearchParams(location.search).get('theme');
  const saved = safeRead();
  const want = asked ?? saved;
  return (THEMES as readonly string[]).includes(want ?? '')
    ? (want as Theme) : 'default';
}

export function applyTheme(theme: Theme = currentTheme()): Theme {
  // The default is what :root already carries, so it wears no attribute.
  const root = document.documentElement;
  if (theme === 'default') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  return theme;
}

export function setTheme(theme: Theme): Theme {
  try {
    if (theme === 'default') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch { /* private window, or storage full */ }
  return applyTheme(theme);
}

function safeRead(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;                        // private window
  }
}
