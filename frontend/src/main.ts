import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { applyTheme } from './theme';

// Before the first paint: a theme decided after render would show the page
// in the default palette for a frame and then swap it.
applyTheme();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
