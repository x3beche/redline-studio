import { provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { THEMES, ThemeId, applyFont, applyTheme } from '../../theme';
import { LANG } from '../i18n';
import { SharePage } from './share-page';

/** A shared link's page on its own (main.ts, for /s/<token>): no sign-in,
 *  no shell, no rooms - only share-page.ts and what it shows.
 *
 *  The look follows the visitor's system, light or Spartan Dark (?theme=
 *  still wears another, for pictures). The language is the one this browser
 *  chose in the app, else Turkish for a Turkish browser, else English. The
 *  page asks not to be indexed and sends no referrer with the token in it. */
export function boot() {
  const asked = new URLSearchParams(location.search).get('theme');
  const light = matchMedia('(prefers-color-scheme: light)');
  const wear = () => applyTheme(asked && (THEMES as readonly string[]).includes(asked) ? asked as ThemeId
                                : light.matches ? 'light' : 'spartan-dark');
  wear();
  if (!asked) light.addEventListener('change', wear);
  applyFont();

  try {
    if (!localStorage.getItem('redline.lang') && /^tr\b/i.test(navigator.language || '')) LANG.set('tr');
  } catch { /* private window: the browser's language decides */ }
  document.documentElement.lang = LANG();

  for (const [name, content] of [['robots', 'noindex, nofollow'], ['referrer', 'no-referrer']]) {
    const m = document.createElement('meta');
    m.name = name;
    m.content = content;
    document.head.appendChild(m);
  }
  document.querySelector('app-root')?.replaceWith(document.createElement('app-share'));
  return bootstrapApplication(SharePage, {
    providers: [provideBrowserGlobalErrorListeners(), provideZonelessChangeDetection()],
  });
}
