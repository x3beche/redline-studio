/** Folding a side column, without the middle of the page redrawing itself
 *  sixty times on the way.
 *
 *  A fold animates the column's width, so everything in the centre changes
 *  size on every frame of it. Left alone, each frame the 3D viewer resized
 *  its WebGL canvas, a board drawing fitted and re-rasterised its SVG, and
 *  the column's own content re-wrapped - and the fold stuttered. While a
 *  fold is running those resizes wait; when it ends, each runs once.
 */
export const FOLD_MS = 200;

let until = 0;
const waiting = new Set<() => void>();

/** Whether a side column is mid-fold. */
export function folding(): boolean {
  return performance.now() < until;
}

/** A column is about to fold: hold resizes until it has. */
export function startFold(ms = FOLD_MS) {
  until = performance.now() + ms;
  setTimeout(settle, ms + 30);
}

function settle() {
  if (folding()) return;
  const now = [...waiting];
  waiting.clear();
  for (const fn of now) fn();
}

/** Run `fn` now, or once the fold under way is over. The same function
 *  asked for twice runs once. */
export function whenSettled(fn: () => void) {
  if (folding()) waiting.add(fn);
  else fn();
}
