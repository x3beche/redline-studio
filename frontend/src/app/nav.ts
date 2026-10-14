import { effect, signal, untracked } from '@angular/core';
import { ROOM_PATH, RoomId, build, enter, isStep, parse, roomOf } from './nav-url';

/** The browser's address and history, for the whole app (the mapping itself is nav-url.ts).
 *
 *  The rooms keep what they show as named values (?m=, ?q=, ?run=) the way they
 *  always did - they only read them with navParams() and write them with
 *  navUrl() / navGo() instead of location and history.replaceState. Here those
 *  values become a clean path (/parts/lcsc/C123), and a change of place (a
 *  room, a model, a conversation: PLACE_KEYS) is a new history entry, so Back
 *  and Forward (and Alt+Left / Alt+Right) walk through the app instead of out
 *  of it. A change of a filter is written over the entry on screen.
 *
 *  Back and Forward land in onPop: the shell (app.ts) is told what the address
 *  now holds (navPopped) and puts the room and what was open in it back.
 *
 *  Inside a frame (the app shown in an iframe shares the top page's history)
 *  nothing is pushed: every write replaces.
 */

const inFrame = (() => { try { return window !== window.top; } catch { return true; } })();

/** What is open, as named values: read from the address each time, so there is nothing to drift. */
export function navParams(): URLSearchParams {
  return parse(location.pathname, location.search);
}

/** The same values as a URL to change and hand to navGo (the old `new URL(location.href)`). */
export function navUrl(): URL {
  const q = navParams().toString();
  return new URL(location.origin + '/' + (q ? '?' + q : ''));
}

/** The address of a place, for a real link (<a href>): a middle click or Ctrl+click opens it in a tab. */
export function navHref(values: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v) q.set(k, v);
  return build(q);
}

/** Writes are held while a room is being put back after Back (a room leaving must not wipe the
 *  values the one coming reads), and pushes wait a moment after a page load or a Back: what a
 *  room opens by itself then is where it was, not a step. */
let holding = false;
let quietUntil = Date.now() + 1000;
/** Until when a box opening is one put back by Back or Forward (its entry is on screen already). */
let restoredUntil = 0;
/** The address last written, put back when a box's own history entry is stepped off. */
let written = location.pathname + location.search;
/** history.back() calls of our own (a box closed by hand), whose popstate is not a step. */
let expected = 0;
/** A box closed by hand whose entry is about to be stepped off (closed() waits a moment, in case
 *  what closed it was a step somewhere else). */
let leaving = false;
/** What the address held at the last write or step, for the next Back to compare against. */
let last = navParams();

export function navHold(on: boolean) { holding = on; }

/** Write `url`'s values (from navUrl()) as the address. A change of place is a new history
 *  entry; anything else is written over the one on screen. */
export function navGo(url: URL | URLSearchParams, opts: { push?: boolean; replace?: boolean } = {}) {
  if (holding) return;
  const next = url instanceof URL ? new URLSearchParams(url.search) : url;
  const now = navParams();
  const href = build(next);
  if (href === location.pathname + location.search) return;
  const step = opts.push || (!opts.replace && !inFrame && Date.now() > quietUntil && isStep(now, next));
  if (step && leaving) {
    // A box closed just now, on its way off its entry (closed()): the step takes that entry
    // instead, so Back from here is the page under the box.
    leaving = false;
    history.replaceState(null, '', href);
  } else if (step) {
    history.pushState(null, '', href);
    // A box open under this step is behind it now: Back to it is a place again, not a close.
    boxes.splice(0).forEach(b => b.on = false);
  } else {
    history.replaceState(history.state, '', href);
  }
  written = href;
  last = navParams();
  title();
}

/** Open `room` with these values (a tab, a link, a jump from another room): one step. With
 *  `fill`, only what the address does not already name is added (it was put there by Back). */
export function navSet(room: RoomId, values: Record<string, string | null | undefined> = {},
                       opts: { replace?: boolean; fill?: boolean } = {}) {
  const v = enter(navParams(), room);
  for (const [k, x] of Object.entries(values)) {
    if (opts.fill && v.has(k)) continue;
    if (x) v.set(k, x); else v.delete(k);
  }
  navGo(v, opts);
}

/** Back or Forward: what was open before, and what is now; `n` counts. */
export const navPopped = signal<{ prev: URLSearchParams; next: URLSearchParams; n: number } | null>(null);
let pops = 0;

function onPop() {
  const prev = last;
  last = navParams();
  if (expected > 0) {
    // A box closed by hand stepped back off its own entry: the address is what the page wrote last.
    expected--;
    if (written !== location.pathname + location.search) history.replaceState(history.state, '', written);
    last = navParams();
    return;
  }
  quietUntil = restoredUntil = Date.now() + 1200;
  const box = boxes.pop();
  if (box) {
    // Back with a box open: the box closes, and the page stays as it is under it.
    box.on = false;
    box.close();
    return;
  }
  written = location.pathname + location.search;
  navPopped.set({ prev, next: last, n: ++pops });
  title();
}
addEventListener('popstate', onPop);

/** Go to an address of the app's own (a link in a chat answer, a note, a tab): one step, and the
 *  shell puts it on screen as after Forward - without loading the page again. */
export function navOpen(href: string) {
  const u = new URL(href, location.href);
  const prev = navParams(), next = parse(u.pathname, u.search);
  const to = build(next);
  if (to !== location.pathname + location.search) {
    history.pushState(null, '', to);
    boxes.splice(0).forEach(b => b.on = false);
  }
  written = to;
  last = navParams();
  quietUntil = Date.now() + 1200;
  navPopped.set({ prev, next, n: ++pops });
  title();
}

/** Whether `u` is a place in the app (not /api, not a static page under /tools). One naming a
 *  revision (?rev=) is loaded as a page: the 3D room takes a revision's view only on a load. */
export function navIsApp(u: URL): boolean {
  if (u.origin !== location.origin || u.searchParams.has('rev')) return false;
  const head = u.pathname.split('/')[1] ?? '';
  if (!head) return ['ws', 'model', 'rev', 'board', 'fw', 'chat', 'thread', 'dm'].some(k => u.searchParams.has(k));
  return head === 'dm' || Object.values(ROOM_PATH).includes(head);
}

// A plain click on a link into the app (a chat answer's, a note's) goes there without a reload.
// Ctrl, Shift, a middle click, target=_blank and downloads are left to the browser.
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
  let u: URL;
  try { u = new URL(a.href, location.href); } catch { return; }
  if (!navIsApp(u)) return;
  e.preventDefault();
  navOpen(u.href);
});

/** A box over the page (a product, a file, something sent) that the browser's Back closes:
 *  while open it has a history entry of its own (the address stays as the page sets it);
 *  closed by hand, that entry is stepped off again.
 *
 *    private back = new BackCloses(() => this.close());
 *    open:  this.back.opened();   close: this.back.closed();
 */
const boxes: BackCloses[] = [];
export class BackCloses {
  on = false;
  constructor(public close: () => void) {}
  opened() {
    if (this.on) return;
    this.on = true;
    boxes.push(this);
    // Put back by Back or Forward (or in a frame): the entry on screen is the box's already.
    if (inFrame || Date.now() < restoredUntil) return;
    history.pushState({ box: 1 }, '', location.pathname + location.search);
  }
  closed() {
    if (!this.on) return;
    this.on = false;
    const i = boxes.indexOf(this);
    if (i >= 0) boxes.splice(i, 1);
    if (inFrame) return;
    leaving = true;
    setTimeout(() => {
      if (!leaving) return;
      leaving = false;
      expected++;
      history.back();
    });
  }
}

/** A box open while `open()` says so, that Back closes (`close`). In a constructor. */
export function navBoxFollows(open: () => unknown, close: () => void) {
  const back = new BackCloses(close);
  effect(() => { const on = !!open(); untracked(() => on ? back.opened() : back.closed()); });
}

/** The tab's title: the room, and what is open in it when the shell says (navTitle). */
const ROOM_TITLE: Record<RoomId, string> = {
  cad: '3D Drawing', pcb: 'PCB Design', firmware: 'Firmware', notes: 'Notes', taste: 'Taste', mfr: 'Parts',
  commandcode: 'Chat', files: 'Files', tools: 'Basic Tools', settings: 'Settings', analyze: 'Analytics', wiki: 'Wiki',
  notifications: 'Notifications',
  tasks: 'Tasks',
};
let named: { room: string | null; what: string | null } = { room: null, what: null };
export function navTitle(room: string | null, what: string | null) { named = { room, what }; title(); }
/** Something to say before it all (the 3D room's open questions: "● 2 questions"). */
let badge: string | null = null;
export function navBadge(b: string | null) { badge = b; title(); }
function title() {
  const room = roomOf(navParams().get('ws'));
  if (!room) return;
  const t = [badge, named.room === room ? named.what : null, ROOM_TITLE[room], 'Workbench'].filter(Boolean).join(' · ');
  if (document.title !== t) document.title = t;
}
