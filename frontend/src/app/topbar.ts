import { Directive, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { WORKSPACES, Workspace } from './workspaces';
import { LANG } from './i18n';
import { BELL, GAP, MORE, OFF_BY_DEFAULT, SETTINGS, defaultOrder as orderOf, dropOrder, migrateHidden, migrateOrder } from './topbar-order';
export { BELL, GAP, MORE, SETTINGS } from './topbar-order';

/** The top bar, arranged by the person at this screen (Settings > Top bar).
 *
 *  What is kept is an order of tab ids and a set of hidden ones - never a
 *  copy of the tabs themselves - so a tab added to the app later turns up
 *  on its own: at its default place, shown. The notification bell and
 *  Settings are items too (BELL, SETTINGS), after More by default; hidden,
 *  they are under More and in the menu under your name. Analytics lives in
 *  that menu and is not a tab at all.
 *
 *  Kept in this browser (localStorage, `redline.topbar`): the server has no
 *  per-account store for preferences, so it does not follow you to another
 *  device. The theme and the language are kept the same way.
 *
 *  Whatever does not fit, and whatever is hidden, is under "More"
 *  (topbar-more.ts) - the open room included, marked there. More is one
 *  more item in the order (MORE), after the tabs by default, just before
 *  the bell; it is never hidden, and is drawn only when something is under it.
 *  When the bar is short of room, what stands before More goes under it
 *  first, the item nearest it first (topbar-order.ts, dropOrder).
 */
export type TopbarDisplay = 'full' | 'iconsfull' | 'short' | 'icons' | 'icon';
export const TOPBAR_DISPLAYS: { id: TopbarDisplay; label: string }[] = [
  { id: 'full', label: 'Full names' },
  { id: 'iconsfull', label: 'Icons + full names' },
  { id: 'short', label: 'Short names' },
  { id: 'icons', label: 'Icons + short' },
  { id: 'icon', label: 'Icons only' },
];

/** Never in the bar's lists: Analytics is in the menu under your name. */
const FIXED = new Set<string>(['analyze']);
const KEY = 'redline.topbar';

/** A tab's name when the bar is short of room. Any tab not here keeps its name. */
const SHORT: Record<string, string> = {
  cad: '3D', pcb: 'PCB', firmware: 'FW',
  notes: 'Notes', taste: 'Taste', mfr: 'Parts', commandcode: 'Chat', files: 'Files', tools: 'Tools', tasks: 'Tasks',
};

/** A line drawing for each tab, 24 units square, drawn with the text colour. */
const ICON: Record<string, string> = {
  cad: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  pcb: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  firmware: 'M6 6h12v12H6z M3 9h3 M3 15h3 M18 9h3 M18 15h3 M10.5 9.5L8.5 12l2 2.5 M13.5 9.5l2 2.5-2 2.5',
  notes: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h5',
  taste: 'M4 5h16v4H4z M4 11h16v4H4z M4 17h10v3H4z M7 7h.01 M7 13h.01',
  mfr: 'M3 20V10l5 3V10l5 3V6h3l1 4h1l1-6h2v16z M7 16h2 M12 16h2 M17 16h1',
  commandcode: 'M4 5h16v11h-9l-5 4v-4H4z M8 9l2.5 2L8 13 M13 13h3',
  files: 'M3 6h6l2 2h10v11H3z',
  tools: 'M14.5 4.5a4 4 0 0 0-4.6 5.4L4 15.8 8.2 20l5.9-5.9a4 4 0 0 0 5.4-4.6l-2.6 2.6-2.8-.7-.7-2.8z',
  tasks: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M12 7.5V12l3 2 M3 6.5L6 3.5 M21 6.5L18 3.5',
  wiki: 'M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4z M20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z',
  notifications: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0',
  settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M12 3v2.5 M12 18.5V21 M3 12h2.5 M18.5 12H21 M5.6 5.6l1.8 1.8 M16.6 16.6l1.8 1.8 M5.6 18.4l1.8-1.8 M16.6 7.4l1.8-1.8',
};
const ICON_ANY = 'M5 5h14v14H5z';

/** `end`: the last item drawn, which stands at the right end and keeps
 *  clear of the right-hand column (styles.css, .tcv-tab-end). */
export interface BarTab { id: string; ws: Workspace; push: boolean; end: boolean; more?: false }
/** The More button's place among the tabs in the bar. */
export interface BarMore { id: typeof MORE; ws: null; push: boolean; end: boolean; more: true }
export type BarItem = BarTab | BarMore;

/** The Command Code usage on the Chat tab (cc-usage.ts): how it is drawn,
 *  and which window it shows. */
export type CcTabStyle = 'off' | 'pct' | 'bar' | 'both';
export type CcTabWindow = 'weekly' | 'five' | 'monthly' | 'all';
export const CC_TAB_STYLES: { id: CcTabStyle; label: string }[] = [
  { id: 'off', label: 'Off' }, { id: 'pct', label: 'Percent' }, { id: 'bar', label: 'Bar' }, { id: 'both', label: 'Bar + percent' },
];
export const CC_TAB_WINDOWS: { id: CcTabWindow; label: string }[] = [
  { id: 'weekly', label: 'Weekly' }, { id: 'five', label: '5-hour' }, { id: 'monthly', label: 'Monthly' }, { id: 'all', label: 'All' },
];

/** The default: the rooms you work in, the gap, then Notes and the rest,
 *  More, the bell and Settings - the bar exactly as it was before it could
 *  be arranged (topbar-order.ts). */
export function defaultOrder(): string[] {
  return orderOf(WORKSPACES.filter(w => !FIXED.has(w.id)).map(w => w.id));
}

interface Kept { order?: unknown[]; hidden?: unknown[]; display?: unknown; ccStyle?: unknown; ccWindow?: unknown; bellCount?: unknown }

function readKept(): Kept {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v as Kept : {};
  } catch { return {}; }
}

function asDisplay(v: unknown): TopbarDisplay {
  return TOPBAR_DISPLAYS.some(d => d.id === v) ? v as TopbarDisplay : 'full';
}

@Injectable({ providedIn: 'root' })
export class TopBar {
  private readonly def = defaultOrder();
  private readonly byId = new Map<string, Workspace>(WORKSPACES.map(w => [w.id, w]));

  order = signal<string[]>([]);
  hidden = signal<ReadonlySet<string>>(new Set());
  display = signal<TopbarDisplay>('full');
  ccStyle = signal<CcTabStyle>('both');
  ccWindow = signal<CcTabWindow>('weekly');
  /** Whether the bell shows how many are unread beside it (Settings > Top bar,
   *  the bell's row); unread ones are told by the bell's ink either way. */
  bellCount = signal(true);
  /** The shown tabs there is no room for, under More; the rest are in the
   *  bar. Set by the bar itself (TopbarFit), which measures. */
  out = signal<ReadonlySet<string>>(new Set());
  /** The width of the Command Code usage on the Chat tab (cc-usage.ts):
   *  set by it, so the bar measures the tabs again when it changes. */
  extraW = signal(0);

  constructor() {
    this.load(readKept());
    // Another window of this browser changed it: follow.
    window.addEventListener('storage', e => { if (e.key === KEY) this.load(readKept()); });
  }

  private load(k: Kept) {
    // Kept before More, the bell or Settings could be moved: they stand
    // where they always stood, at the end (topbar-order.ts).
    this.order.set(migrateOrder(Array.isArray(k.order) ? k.order : null, this.def));
    // The wiki is off until switched on - for an order kept before it was a tab too.
    const known = new Set(this.def.filter(id => id !== MORE));
    this.hidden.set(new Set(migrateHidden(Array.isArray(k.order) ? k.order : null, Array.isArray(k.hidden) ? k.hidden : null)
      .filter(x => known.has(x))));
    this.display.set(asDisplay(k.display));
    this.ccStyle.set(CC_TAB_STYLES.some(x => x.id === k.ccStyle) ? k.ccStyle as CcTabStyle : 'both');
    this.ccWindow.set(CC_TAB_WINDOWS.some(x => x.id === k.ccWindow) ? k.ccWindow as CcTabWindow : 'weekly');
    this.bellCount.set(k.bellCount !== false);
  }

  private save() {
    try {
      if (this.isDefault()) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify({ v: 1, order: this.order(), hidden: [...this.hidden()],
                                                      display: this.display(), ccStyle: this.ccStyle(),
                                                      ccWindow: this.ccWindow(), bellCount: this.bellCount() }));
    } catch { /* private window: it lasts until the page is closed */ }
  }

  isDefault = computed(() => this.display() === 'full'
    && this.hidden().size === OFF_BY_DEFAULT.length && OFF_BY_DEFAULT.every(id => this.hidden().has(id))
    && this.ccStyle() === 'both' && this.ccWindow() === 'weekly' && this.bellCount()
    && this.order().join() === this.def.join());

  /** Every item in order, the gap and More included, with whether it is hidden. */
  entries = computed(() => this.order().map(id => ({
    id, ws: this.byId.get(id) ?? null, hidden: this.hidden().has(id),
  })));

  /** The shown tabs in order (no gap), and where the gap stands among them. */
  private shown = computed(() => {
    const tabs: { ws: Workspace; afterGap: boolean }[] = [];
    let gap = false;
    for (const e of this.entries()) {
      if (e.hidden) continue;
      if (e.id === GAP) { gap = true; continue; }
      if (e.id === MORE) continue;
      if (!e.ws) continue;
      tabs.push({ ws: e.ws, afterGap: gap });
      gap = false;
    }
    return tabs;
  });
  /** The ids of the tabs that are shown, in order - what the bar measures. */
  shownIds = computed(() => this.shown().map(s => s.ws.id as string));

  /** What the bar shows: the shown tabs that fit, the first one in the bar
   *  after the gap pushed to the right, and More at its place. A tab under
   *  More passes the gap's push on to the next one in the bar. The last item
   *  drawn is the end: it stands at the right end, beside the item pushed
   *  there when there is one. */
  inBar = computed<BarItem[]>(() => {
    const away = this.out(), more = this.moreNeeded();
    const out: BarItem[] = [];
    let gap = false;
    for (const e of this.entries()) {
      if (e.hidden) continue;
      if (e.id === GAP) { gap = true; continue; }
      if (e.id === MORE) {
        // Always in the list - it brings the bar's stylesheet (topbar-more.ts)
        // - but drawn, and taking the gap's push, only when it is needed.
        out.push({ id: MORE, ws: null, push: more && gap, end: false, more: true });
        if (more) gap = false;
        continue;
      }
      if (!e.ws || away.has(e.id)) continue;
      out.push({ id: e.id, ws: e.ws, push: gap, end: false });
      gap = false;
    }
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].more && !more) continue;
      out[i] = { ...out[i], end: true };
      break;
    }
    return out;
  });
  /** With an item pushed right, the end stands beside the last one instead
   *  of taking the free space itself. */
  tight = computed(() => this.inBar().some(t => t.push && !t.end));
  /** Shown, but no room for them. */
  overflow = computed(() => this.shown().filter(s => this.out().has(s.ws.id)).map(s => s.ws));
  /** The shown tabs in the order they go under More when there is no room. */
  dropOrder = computed(() => dropOrder(this.order(), this.shownIds()));
  /** Hidden by choice. */
  hiddenTabs = computed(() => this.entries().filter(e => e.hidden && e.ws).map(e => e.ws!));
  moreNeeded = computed(() => this.overflow().length + this.hiddenTabs().length > 0);

  /** What the widths depend on: when it changes, the bar measures again. */
  looks = computed(() => `${this.display()}|${LANG()}|${this.shownIds().join()}|${this.ccStyle()}|${this.ccWindow()}|${this.bellCount()}`);

  icon(id: string): string { return ICON[id] ?? ICON_ANY; }
  short(w: Workspace): string { return SHORT[w.id] ?? w.label; }
  showIcon = computed(() => ['icons', 'iconsfull', 'icon'].includes(this.display()));
  /** The words on a tab, or '' with icons only (the name is then its title). */
  text(w: Workspace): string {
    const d = this.display();
    return d === 'full' || d === 'iconsfull' ? w.label : d === 'icon' ? '' : this.short(w);
  }
  title(w: Workspace): string { return w.blurb + (w.id === 'notes' ? ' (Alt+N)' : ''); }
  /** Whether the bell, or Settings, is hidden by choice (the menu under your name then lists it). */
  isHidden(id: string): boolean { return this.hidden().has(id); }

  // ---- changing it ------------------------------------------------
  move(id: string, to: number) {
    const list = this.order().filter(x => x !== id);
    const at = Math.max(0, Math.min(list.length, to));
    list.splice(at, 0, id);
    this.order.set(list);
    this.save();
  }
  step(id: string, by: -1 | 1) {
    const i = this.order().indexOf(id);
    if (i < 0) return;
    this.move(id, i + by);
  }
  setHidden(id: string, hide: boolean) {
    if (id === MORE) return;
    const next = new Set(this.hidden());
    if (hide) next.add(id); else next.delete(id);
    this.hidden.set(next);
    this.save();
  }
  setDisplay(d: TopbarDisplay) { this.display.set(d); this.save(); }
  setCcStyle(v: CcTabStyle) { this.ccStyle.set(v); this.save(); }
  setCcWindow(v: CcTabWindow) { this.ccWindow.set(v); this.save(); }
  setBellCount(v: boolean) { this.bellCount.set(v); this.save(); }
  reset() {
    this.order.set([...this.def]);
    this.hidden.set(new Set(OFF_BY_DEFAULT));
    this.display.set('full');
    this.ccStyle.set('both');
    this.ccWindow.set('weekly');
    this.bellCount.set(true);
    this.save();
  }
}

/** On the bar: measures the items (the bell and Settings among them) and
 *  tells TopBar which go under More, so the rest fit in one row beside the
 *  end's margin and the user chip (when that is in the row rather than over
 *  it), leaving room for More when anything has to go there.
 *
 *  A tab's width is remembered from when it was last in the bar, so one
 *  under More can still be counted; when what the widths depend on changes
 *  (the language, the display, the tabs) they are forgotten, every tab is
 *  put back for a frame, and measured again. */
@Directive({ selector: '[topbarFit]' })
export class TopbarFit implements OnDestroy {
  private bar = inject(TopBar);
  private el = inject(ElementRef).nativeElement as HTMLElement;
  private widths = new Map<string, number>();
  private frame = 0;
  private tries = 0;
  private ro = new ResizeObserver(() => { this.tries = 0; this.schedule(); });
  private onEnd = () => { this.tries = 0; this.schedule(); };

  private relook = effect(() => {
    this.bar.looks();
    untracked(() => {
      this.widths.clear();
      this.tries = 0;
      this.bar.out.set(new Set());
      this.schedule();
    });
  });

  /** The usage on the Chat tab came, went or changed width: measure again. */
  private extra = effect(() => {
    this.bar.extraW();
    untracked(() => { this.tries = 0; this.schedule(); });
  });

  constructor() {
    this.ro.observe(this.el);
    // The end's right margin follows the queue folding, in a transition.
    this.el.addEventListener('transitionend', this.onEnd);
  }

  ngOnDestroy() {
    this.ro.disconnect();
    this.el.removeEventListener('transitionend', this.onEnd);
    cancelAnimationFrame(this.frame);
  }

  /** Two frames on: one for Angular to draw what was just set, one to measure it. */
  private schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => { this.frame = requestAnimationFrame(() => this.measure()); });
  }

  private measure() {
    const h = this.el;
    if (!h.isConnected || !h.clientWidth) return;
    const cs = getComputedStyle(h);
    const gap = parseFloat(cs.columnGap) || 0;
    h.querySelectorAll<HTMLElement>('[data-tb]').forEach(t => {
      this.widths.set(t.dataset['tb']!, t.getBoundingClientRect().width);
    });
    const more = h.querySelector<HTMLElement>('[data-tb-more]');
    if (more) this.widths.set('\0more', more.getBoundingClientRect().width);
    const ids = this.bar.shownIds();
    if (ids.some(id => !this.widths.has(id))) {
      // Not all drawn yet: draw them all, and look again.
      if (this.tries++ < 4) { this.bar.out.set(new Set()); this.schedule(); }
      return;
    }
    let reserve = 0;
    // The end keeps clear of the right-hand column (styles.css): its margin
    // is room the items cannot have, whichever item is the end.
    const end = h.querySelector<HTMLElement>('.tcv-tab-end');
    if (end) reserve += parseFloat(getComputedStyle(end).marginRight) || 0;
    const chip = h.querySelector<HTMLElement>('.tcv-user-end');
    if (chip && getComputedStyle(chip).position !== 'absolute') reserve += chip.getBoundingClientRect().width + gap;
    const room = h.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - reserve;
    const w = (id: string) => (this.widths.get(id) ?? 0) + gap;
    let used = ids.reduce((a, id) => a + w(id), 0);
    const moreW = (this.widths.get('\0more') ?? 64) + gap;
    const want = new Set<string>();
    if (used + (this.bar.hiddenTabs().length ? moreW : 0) > room) {
      const budget = room - moreW;
      for (const id of this.bar.dropOrder()) {
        if (used <= budget) break;
        used -= w(id);
        want.add(id);
      }
    }
    // Once more after a change: More may have come or gone, and its own
    // width was only a guess until it was drawn.
    const now = this.bar.out();
    if (now.size !== want.size || [...want].some(id => !now.has(id))) {
      this.bar.out.set(want);
      if (this.tries++ < 6) this.schedule();
    }
  }
}
