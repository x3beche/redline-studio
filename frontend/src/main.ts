import { bootstrapApplication } from '@angular/platform-browser';
import { applyFont, applyTheme } from './theme';
import { applyIcons } from './app/icon-packs';
import { applyTree } from './app/editor/tree-prefs';
import { shareToken } from './app/nav-url';

// This browser's settings were once kept under another prefix: move them
// to redline.* once, before anything reads them, so nobody loses a theme,
// a language or a layout.
try {
  for (const old of Object.keys(localStorage).filter(k => k.startsWith('x3.'))) {
    const key = 'redline.' + old.slice(3);
    if (localStorage.getItem(key) === null) localStorage.setItem(key, localStorage.getItem(old) ?? '');
    localStorage.removeItem(old);
  }
} catch { /* private window: nothing kept to move */ }

// The viewer's look (its icons, the model tree) before the first paint,
// for the app and a shared link's page alike.
applyIcons();
applyTree();

if (shareToken(location.pathname)) {
  // A shared link (/s/<token>) is a page of its own, for someone without an
  // account: none of the app is loaded for it (share/boot.ts).
  import('./app/share/boot').then(m => m.boot()).catch(err => console.error(err));
} else {
  // Before the first paint: a theme decided after render would show the page
  // in the default palette for a frame and then swap it.
  applyTheme();
  applyFont();
  // The app is a chunk of its own, so the shared link's page above does not
  // download it.
  Promise.all([import('./app/app'), import('./app/app.config')])
    .then(([{ App }, { appConfig }]) => bootstrapApplication(App, appConfig))
    .catch((err) => console.error(err));
}
