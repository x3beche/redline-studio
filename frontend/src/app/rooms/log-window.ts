import { signal } from '@angular/core';

/** How many lines a conversation shows when it is opened, and how many more
 *  each time the reader scrolls up to the top of what is shown. */
export const LOG_STEP = 20;
/** Within this far of the top (px), the next lines are put on the page. */
const NEAR_TOP = 300;

/** The last lines of a long conversation, not all of them: an AI
 *  conversation (rooms/commandcode.ts) and a room's agent thread
 *  (rooms/agent-thread.ts) alike.
 *
 *  A thread of a few hundred answers - each with its maths, code, task
 *  boxes and pictures - made the page heavy and its scrolling slow. Only
 *  the last LOG_STEP are drawn when it is opened; scrolling up near the
 *  top of them brings LOG_STEP more, and the line the reader was looking
 *  at stays where it was on the screen. Everything is still fetched (a
 *  conversation's lines are small; drawing them was the cost), so a line
 *  asked for further up (a search hit, a queued note's link) only widens
 *  what is shown to take it in. New lines come in at the end as before:
 *  the window counts from the end, so they are always in it. */
export class LogWindow {
  /** How many of the last lines are shown. */
  size = signal(LOG_STEP);

  /** Rows being added and the view held still: one batch at a time. */
  private busy = false;

  /** `log`: the scrolling box, whose rows carry `data-mid`. */
  constructor(private log: () => HTMLElement | undefined) {}

  /** The index of the first line shown, out of `total`. */
  from(total: number) { return Math.max(0, total - this.size()); }

  /** Another conversation: its last LOG_STEP again. */
  reset() { this.size.set(LOG_STEP); }

  /** Line `i` of `total` is asked for: shown, with what follows it. */
  include(i: number, total: number) {
    if (i >= 0 && i < this.from(total)) this.size.set(Math.ceil((total - i) / LOG_STEP) * LOG_STEP);
  }

  /** The reader scrolled: near the top of what is shown, with more above,
   *  LOG_STEP more lines go on the page above it - and the row on screen
   *  is kept where it was, measured again as the new rows render. */
  scrolled(total: number) {
    const el = this.log();
    if (!el || this.busy || el.scrollTop > NEAR_TOP || !this.from(total) || el.scrollHeight <= el.clientHeight) return;
    const box = el.getBoundingClientRect();
    const rows = el.querySelectorAll<HTMLElement>('[data-mid]');
    let anchor: HTMLElement | null = null;
    for (const r of Array.from(rows)) if (r.getBoundingClientRect().bottom > box.top) { anchor = r; break; }
    const top0 = anchor?.getBoundingClientRect().top ?? 0;
    this.busy = true;
    this.size.update(n => n + LOG_STEP);
    const keep = () => {
      if (!anchor?.isConnected) return;
      const d = anchor.getBoundingClientRect().top - top0;
      if (Math.abs(d) > 0.5) el.scrollTop += d;
    };
    // The rows are drawn on the next change detection; the browser's own
    // scroll anchoring may have kept the row already - measured, not assumed.
    setTimeout(() => { keep(); requestAnimationFrame(() => { keep(); requestAnimationFrame(() => { keep(); this.busy = false; }); }); });
  }
}
