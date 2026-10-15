import { Component, ViewEncapsulation, computed, effect, inject, signal, untracked } from '@angular/core';
import { LANG, T, t } from '../i18n';
import { NC_GROUPS, NcRow, Notice, NotifyStore, ncDays } from '../notifications';
import { Prefs } from '../preferences';

/** /notifications: every notification kept (60 days), by day - the bell's
 *  panel (notifications.ts) at full size. One bar: the kinds to show as
 *  tiny toggles, unread only, mark all read, clear what was read, and the
 *  way to Settings > Notifications. Older ones load as the list is scrolled. */
@Component({
  selector: 'app-room-notifications',
  imports: [T, NcRow],
  // Not encapsulated, like the bell's: the page's bar and list use the same
  // global rules, and the bell may not be in the top bar to have loaded them.
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../notifications.css',
  template: `
<div class="tcv-room nc-page absolute inset-0">
  <header class="nc-page-bar">
    <span class="nc-page-title">{{ 'Notifications' | t }}</span>
    <span class="nc-page-figs" [title]="'kept 60 days' | t">{{ store.unread() }} {{ 'unread' | t }} · {{ total() }}</span>
    <div class="nc-filters" role="group" [attr.aria-label]="'Show' | t">
      @for (g of groups(); track g.id) {
        <button type="button" class="nc-filter" [attr.data-on]="shown().has(g.id) ? 1 : null" [attr.aria-pressed]="shown().has(g.id)"
                [title]="g.title" (click)="flip(g.id)">{{ g.label | t }}<small>{{ g.n }}</small></button>
      }
      <button type="button" class="nc-filter" [attr.data-on]="unreadOnly() ? 1 : null" [attr.aria-pressed]="unreadOnly()"
              (click)="unreadOnly.set(!unreadOnly()); reload()">{{ 'Unread only' | t }}</button>
    </div>
    <button type="button" class="nc-act" [disabled]="!store.unread()" (click)="readAll()">{{ 'Mark all read' | t }}</button>
    <button type="button" class="nc-act" [disabled]="!hasRead()" (click)="clearRead()">{{ 'Clear read' | t }}</button>
    <button type="button" class="nc-act" (click)="prefs.open.set('notifications')">{{ 'Settings' | t }}</button>
  </header>
  <div class="nc-page-list" (scroll)="scrolled($event)">
    @if (items(); as list) {
      @for (d of days(); track d.day) {
        <div class="nc-day">{{ d.day | t }}</div>
        @for (n of d.items; track n.id) {
          <div class="nc-line">
            <wb-nc-row [n]="n" (pick)="go(n)" />
            <button type="button" class="nc-x" [title]="'Remove' | t" [attr.aria-label]="'Remove' | t" (click)="drop(n)">×</button>
          </div>
        }
      } @empty {
        <div class="nc-empty">{{ (shown().size || unreadOnly() ? 'Nothing of these kinds.' : 'Nothing yet. Builds, drawings, questions and prices will show here.') | t }}</div>
      }
      @if (more()) { <button type="button" class="nc-act nc-more" [disabled]="busy()" (click)="loadMore()">{{ 'Older' | t }}</button> }
    } @else {
      <div class="nc-empty">{{ 'Loading…' | t }}</div>
    }
  </div>
</div>`,
})
export class RoomNotifications {
  store = inject(NotifyStore);
  prefs = inject(Prefs);
  items = signal<Notice[] | null>(null);
  more = signal(false);
  busy = signal(false);
  counts = signal<Record<string, number>>({});
  /** The groups of kinds ticked; none is all of them. */
  shown = signal<Set<string>>(new Set());
  unreadOnly = signal(false);
  total = computed(() => Object.values(this.counts()).reduce((a, b) => a + b, 0));
  hasRead = computed(() => (this.items() ?? []).some(n => n.read));
  days = computed(() => { LANG(); return ncDays(this.items() ?? []); });
  /** The groups there is something of (or that are ticked), each with how many, and its kinds in full as its tooltip. */
  groups = computed(() => {
    const c = this.counts(), on = this.shown();
    LANG();
    return NC_GROUPS.map(g => ({ ...g, n: g.kinds.reduce((a, k) => a + (c[k] ?? 0), 0),
                                 title: g.kinds.filter(k => c[k]).map(k => `${t(LONG[k] ?? k)}: ${c[k]}`).join('\n') }))
      .filter(g => g.n || on.has(g.id));
  });
  /** The kinds of the groups ticked. */
  private picked() { return NC_GROUPS.filter(g => this.shown().has(g.id)).flatMap(g => g.kinds); }
  private reread = effect(() => { this.store.fresh(); untracked(() => void this.reload()); });

  async reload() {
    this.busy.set(true);
    try {
      const p = await this.store.list({ kinds: this.picked(), unread: this.unreadOnly(), limit: 60, counts: true });
      this.items.set(p.items);
      this.more.set(p.more);
      if (p.counts) this.counts.set(p.counts);
    } catch { this.items.set([]); }
    this.busy.set(false);
  }

  async loadMore() {
    const last = this.items()?.at(-1);
    if (!last || this.busy()) return;
    this.busy.set(true);
    try {
      const p = await this.store.list({ kinds: this.picked(), unread: this.unreadOnly(), limit: 60, before: last.created_at });
      this.items.update(l => [...(l ?? []), ...p.items]);
      this.more.set(p.more);
    } catch { /* the button stays */ }
    this.busy.set(false);
  }

  scrolled(e: Event) {
    const el = e.target as HTMLElement;
    if (this.more() && !this.busy() && el.scrollTop + el.clientHeight > el.scrollHeight - 200) void this.loadMore();
  }

  flip(id: string) {
    const s = new Set(this.shown());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.shown.set(s);
    void this.reload();
  }

  go(n: Notice) {
    void this.store.open(n);
    this.items.update(l => (l ?? []).map(x => x.id === n.id ? { ...x, read: true } : x));
  }

  async readAll() {
    if (await this.store.markRead('all')) this.items.update(l => (l ?? []).map(n => ({ ...n, read: true })));
  }

  async clearRead() {
    if (await this.store.remove('read')) void this.reload();
  }

  async drop(n: Notice) {
    if (await this.store.remove([n.id])) {
      this.items.update(l => (l ?? []).filter(x => x.id !== n.id));
      this.counts.update(c => ({ ...c, [n.kind]: Math.max(0, (c[n.kind] ?? 1) - 1) }));
    }
  }
}

/** Each kind's name, for its group's tooltip. */
const LONG: Record<string, string> = {
  question: 'An agent asks a question', reply: 'An agent replies', note: 'A note is applied or fails', run: 'A run starts',
  build: 'A build fails', longbuild: 'A long build is done', route: 'A board is routed', firmware: 'A firmware build ends',
  drawing: 'A technical drawing is made', release: 'A release is ready', bodies: 'Part bodies', library: 'A part joins the drawer',
  price: 'A price drops', budget: 'Budget warnings', ccusage: 'Command Code usage', health: 'Server health',
};
