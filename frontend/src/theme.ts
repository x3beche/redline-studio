/** Which theme the window wears.
 *
 *  Applied before the application renders, so nothing is painted in the
 *  default palette and repainted a frame later. A theme is a complete set
 *  of tokens in styles.css; this only decides which set is in force, and
 *  an unknown name falls back to the default rather than leaving the page
 *  with half a palette.
 */
export const THEMES = ['default', 'light', 'oled', 'github-dark'] as const;

/** What each is called where one is chosen. */
export const THEME_NAMES: Record<Theme, string> = {
  default: 'Redline dark', light: 'Light', oled: 'OLED black', 'github-dark': 'GitHub Dark',
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
