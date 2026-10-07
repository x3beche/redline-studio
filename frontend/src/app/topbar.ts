import { Directive, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { WORKSPACES, Workspace } from './workspaces';
import { LANG } from './i18n';

/** The top bar, arranged by the person at this screen (Settings > Top bar).
 *
 *  What is kept is an order of tab ids and a set of hidden ones - never a
 *  copy of the tabs themselves - so a tab added to the app later turns up
 *  on its own: at its default place, shown. Settings is not in either list:
 *  it is always there, always last. Analytics lives in the menu under your
 *  name and is not a tab at all.
 *
 *  Kept in this browser (localStorage, `redline.topbar`): the server has no
 *  per-account store for preferences, so it does not follow you to another
 *  device. The theme and the language are kept the same way.
 *
 *  Whatever does not fit, and whatever is hidden, is under "More" at the
 *  end of the bar (topbar-more.ts) - the open room included, marked there.
 */
export type TopbarDisplay = 'full' | 'short' | 'icons' | 'icon';
export const TOPBAR_DISPLAYS: { id: TopbarDisplay; label: string }[] = [
  { id: 'full', label: 'Full names' },
  { id: 'short', label: 'Short names' },
  { id: 'icons', label: 'Icons + short' },
  { id: 'icon', label: 'Icons only' },
];

/** The movable gap: the tabs after it stand at the right, as Notes, Chat,
 *  Files and Basic Tools always have. One more item in the order. */
export const GAP = 'gap';
/** Never in the bar's lists: always shown, never moved. */
const FIXED = new Set<string>(['settings', 'analyze']);
const KEY = 'redline.topbar';

/** A tab's name when the bar is short of room. Any tab not here keeps its name. */
const SHORT: Record<string, string> = {
  cad: '3D', pcb: 'PCB',
  notes: 'Notes', commandcode: 'Chat', files: 'Files', tools: 'Tools',
};

/** A line drawing for each tab, 24 units square, drawn with the text colour. */
const ICON: Record<string, string> = {
  cad: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  pcb: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  notes: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h5',
  commandcode: 'M4 5h16v11h-9l-5 4v-4H4z M8 9l2.5 2L8 13 M13 13h3',
  files: 'M3 6h6l2 2h10v11H3z',
  tools: 'M14.5 4.5a4 4 0 0 0-4.6 5.4L4 15.8 8.2 20l5.9-5.9a4 4 0 0 0 5.4-4.6l-2.6 2.6-2.8-.7-.7-2.8z',
};
const ICON_ANY = 'M5 5h14v14H5z';

export interface BarTab { id: string; ws: Workspace; push: boolean }

/** The default: the rooms you work in, the gap, then Notes and the rest -
 *  the bar exactly as it was before it could be arranged. */
export function defaultOrder(): string[] {
  const ids: string[] = WORKSPACES.filter(w => !FIXED.has(w.id)).map(w => w.id);
  const at = ids.indexOf('notes');
  ids.splice(at < 0 ? ids.length : at, 0, GAP);
  return ids;
}

/** A kept order made whole: ids the app no longer has are dropped, and
 *  every id it has that the order lacks goes in after its nearest default
 *  predecessor (or first, when it has none). */
export function resolveOrder(saved: readonly unknown[] | null | undefined, def = defaultOrder()): string[] {
  const known = new Set(def);
  const out: string[] = [];
  for (const id of saved ?? []) if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
  def.forEach((id, i) => {
    if (out.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(def[j]);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, id);
  });
  return out;
}

interface Kept { order?: unknown[]; hidden?: unknown[]; display?: unknown }

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
  /** How many of the shown tabs fit in the bar; the rest go under More.
   *  Set by the bar itself (TopbarFit), which measures. */
  fit = signal(Infinity);

  constructor() {
    this.load(readKept());
    // Another window of this browser changed it: follow.
    window.addEventListener('storage', e => { if (e.key === KEY) this.load(readKept()); });
  }

  private load(k: Kept) {
    this.order.set(resolveOrder(Array.isArray(k.order) ? k.order : null, this.def));
    const known = new Set(this.def);
    this.hidden.set(new Set((Array.isArray(k.hidden) ? k.hidden : [])
      .filter((x): x is string => typeof x === 'string' && known.has(x))));
    this.display.set(asDisplay(k.display));
  }

  private save() {
    try {
      if (this.isDefault()) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify({ v: 1, order: this.order(), hidden: [...this.hidden()],
                                                      display: this.display() }));
    } catch { /* private window: it lasts until the page is closed */ }
  }

  isDefault = computed(() => this.display() === 'full' && this.hidden().size === 0
    && this.order().join() === this.def.join());

  /** Every item in order, the gap included, with whether it is hidden. */
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
      if (!e.ws) continue;
      tabs.push({ ws: e.ws, afterGap: gap });
      gap = false;
    }
    return tabs;
  });
  /** The ids of the tabs that are shown, in order - what the bar measures. */
  shownIds = computed(() => this.shown().map(s => s.ws.id as string));

  /** What the bar shows: the shown tabs that fit, the first one after the
   *  gap pushed to the right. */
  inBar = computed<BarTab[]>(() => this.shown().slice(0, this.fit())
    .map(s => ({ id: s.ws.id, ws: s.ws, push: s.afterGap })));
  /** With a tab pushed right, Settings stands beside the last one instead
   *  of taking the free space itself. */
  tight = computed(() => this.inBar().some(t => t.push));
  /** Shown, but no room for them. */
  overflow = computed(() => this.shown().slice(this.fit()).map(s => s.ws));
  /** Hidden by choice. */
  hiddenTabs = computed(() => this.entries().filter(e => e.hidden && e.ws).map(e => e.ws!));
  moreNeeded = computed(() => this.overflow().length + this.hiddenTabs().length > 0);

  /** What the widths depend on: when it changes, the bar measures again. */
  looks = computed(() => `${this.display()}|${LANG()}|${this.shownIds().join()}`);

  icon(id: string): string { return ICON[id] ?? ICON_ANY; }
  short(w: Workspace): string { return SHORT[w.id] ?? w.label; }
  showIcon = computed(() => this.display() === 'icons' || this.display() === 'icon');
  /** The words on a tab, or '' with icons only (the name is then its title). */
  text(w: Workspace): string {
    const d = this.display();
    return d === 'full' ? w.label : d === 'icon' ? '' : this.short(w);
  }
  title(w: Workspace): string { return w.blurb + (w.id === 'notes' ? ' (Alt+N)' : ''); }

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
    const next = new Set(this.hidden());
    if (hide) next.add(id); else next.delete(id);
    this.hidden.set(next);
    this.save();
  }
  setDisplay(d: TopbarDisplay) { this.display.set(d); this.save(); }
  reset() {
    this.order.set([...this.def]);
    this.hidden.set(new Set());
    this.display.set('full');
    this.save();
  }
}

/** On the bar: measures the tabs and tells TopBar how many fit beside
 *  Settings (and the user chip, when that is in the row rather than over
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
      this.bar.fit.set(Infinity);
      this.schedule();
    });
  });

  constructor() {
    this.ro.observe(this.el);
    // Settings' right margin follows the queue folding, in a transition.
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
      if (this.tries++ < 4) { this.bar.fit.set(Infinity); this.schedule(); }
      return;
    }
    let reserve = 0;
    const settings = h.querySelector<HTMLElement>('.tcv-tab-end');
    if (settings) reserve += settings.getBoundingClientRect().width + (parseFloat(getComputedStyle(settings).marginRight) || 0) + gap;
    const chip = h.querySelector<HTMLElement>('.tcv-user-end');
    if (chip && getComputedStyle(chip).position !== 'absolute') reserve += chip.getBoundingClientRect().width + gap;
    const room = h.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - reserve;
    const w = ids.map(id => (this.widths.get(id) ?? 0) + gap);
    const total = w.reduce((a, b) => a + b, 0);
    const moreW = (this.widths.get('\0more') ?? 64) + gap;
    let n = ids.length;
    if (total + (this.bar.hiddenTabs().length ? moreW : 0) > room) {
      const budget = room - moreW;
      let used = 0;
      n = 0;
      while (n < ids.length && used + w[n] <= budget) used += w[n++];
    }
    const want = n >= ids.length ? Infinity : n;
    // Once more after a change: More may have come or gone, and its own
    // width was only a guess until it was drawn.
    if (this.bar.fit() !== want) { this.bar.fit.set(want); if (this.tries++ < 6) this.schedule(); }
  }
}
