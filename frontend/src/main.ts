import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { applyFont, applyTheme } from './theme';

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

// Before the first paint: a theme decided after render would show the page
// in the default palette for a frame and then swap it.
applyTheme();
applyFont();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
