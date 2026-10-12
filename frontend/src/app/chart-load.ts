import { signal } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';
import { finalize } from 'rxjs';

/** When the person asks a chart for another period: rooms/charts.ts greys
 *  every chart out under a spinner while such a request is out. Apart from
 *  the charts so app.config.ts can install it without importing the rooms.
 *
 *  A request counts when it is a GET with days=, span=, period=, range=,
 *  from=, since= or hours= sent within 1.5 s of a click or a key - so a
 *  page refreshing itself in the background does not flicker. */
export const CHART_BUSY = signal(0);
/** How many such requests the person has made: a chart plays its entry again
 *  only for data one of them brought, not for a background refresh. */
export let chartAsks = 0;
let lastAsk = 0;
if (typeof document !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => { lastAsk = Date.now(); }, true);
}
const PERIOD = /[?&](days|span|period|range|from|since|hours)=/;
export const chartLoadInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== 'GET' || !PERIOD.test(req.urlWithParams) || Date.now() - lastAsk > 1500) return next(req);
  CHART_BUSY.update(n => n + 1);
  chartAsks++;
  return next(req).pipe(finalize(() => CHART_BUSY.update(n => Math.max(0, n - 1))));
};

