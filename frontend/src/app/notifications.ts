import { Component, ElementRef, HostListener, Injectable, OnDestroy, ViewEncapsulation, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LANG, T, t } from './i18n';
import { Auth } from './auth';
import { Toast } from './toast';
import { navHref, navOpen } from './nav';
import { GLYPHS } from './icon-packs';

/** The notification centre (backend/notifications.py): what happened - an
 *  agent asked, a build failed, a drawing was made, a price dropped - kept
 *  for each person, beside Telegram.
 *
 *    NotifyStore          the unread count (polled every 20 s), a toast for a new one, reading and marking
 *    <app-notify-bell>    the bell in the top bar (app.ts) and its panel
 *    NcRow, nc helpers    one row, as the panel and the page (rooms/notifications.ts) draw it
 *
 *  A row is one line: the kind's icon, its title (translated), what it is
 *  about (names, never translated) and how long ago. Unread is bold full
 *  ink, read is dim; a click marks it read and goes to its place (nav.ts). */

export interface Notice {
  id: string; kind: string; title: string; ctx: string | null; body: string | null; link: string | null;
  /** The words between the names in Turkish, when they differ (backend/notifications.py). */
  ctx_tr?: string | null;
  tone: 'danger' | 'warn' | null; created_at: string; read: boolean;
}
export interface NoticePage { items: Notice[]; unread: number; more: boolean; counts?: Record<string, number> }

/** The kinds' groups, in order, with their short name for the filters. */
export const NC_GROUPS: { id: string; label: string; kinds: string[] }[] = [
  { id: 'agents', label: 'Agents', kinds: ['question', 'reply', 'note', 'run'] },
  { id: 'builds', label: 'Builds', kinds: ['build', 'longbuild', 'route', 'firmware'] },
  { id: 'made', label: 'Outputs', kinds: ['drawing', 'release', 'bodies', 'library'] },
  { id: 'money', label: 'Prices', kinds: ['price', 'budget'] },
  { id: 'server', label: 'Server', kinds: ['ccusage', 'health'] },
];

/** Each kind's icon: the toolbars' own glyphs where one fits (icon-packs.ts),
 *  else a line drawing on the same 24 grid. `s` is stroked, `f` filled. */
function glyph(name: string): { s: string; f: string } {
  const g = GLYPHS[name] ?? {};
  return { s: [g.s, g.k].filter(Boolean).join(' '), f: [g.dot, g.kd].filter(Boolean).join(' ') };
}
const ICONS: Record<string, { s: string; f: string }> = {
  question: { s: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7', f: 'M11 16.2h2v2h-2z' },
  reply: { s: 'M4 5h16v11h-9l-5 4v-4H4z M8 9.5h8 M8 12.5h5', f: '' },
  note: { s: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h5', f: '' },
  run: glyph('play'),
  build: { s: 'M14.5 4.5a4 4 0 0 0-4.6 5.4L4 15.8 8.2 20l5.9-5.9a4 4 0 0 0 5.4-4.6l-2.6 2.6-2.8-.7-.7-2.8z', f: '' },
  longbuild: { s: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 7v5l3.5 2', f: '' },
  route: glyph('tracks'),
  firmware: glyph('flash'),
  drawing: glyph('layout'),
  release: glyph('release'),
  bodies: glyph('model'),
  library: { s: 'M4 4h16v6H4z M4 10h16v10H4z M10 7h4 M10 14h4', f: '' },
  price: { s: 'M3 7l6 6 4-4 8 8 M21 11v6h-6', f: '' },
  budget: { s: 'M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 7l12-4v4 M16 13.5h2', f: '' },
  ccusage: { s: 'M4 16a8 8 0 1 1 16 0 M12 16l4-5 M8 20h8', f: '' },
  health: { s: 'M3 12h4l3-7 4 14 3-7h4', f: '' },
};
export function ncIcon(kind: string) { return ICONS[kind] ?? ICONS['note']; }

/** How long ago, short: now, 5m, 3h, 2d (şimdi, 5 dk, 3 sa, 2 g) - or the date. */
export function ncAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000), tr = LANG() === 'tr';
  if (s < 60) return tr ? 'şimdi' : 'now';
  if (s < 3600) return Math.floor(s / 60) + (tr ? ' dk' : 'm');
  if (s < 86400) return Math.floor(s / 3600) + (tr ? ' sa' : 'h');
  if (s < 7 * 86400) return Math.floor(s / 86400) + (tr ? ' g' : 'd');
  return new Date(iso).toLocaleDateString(tr ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short' });
}

/** What a notification is about, in the reader's language. */
export function ncCtx(n: Notice): string { return (LANG() === 'tr' && n.ctx_tr) || n.ctx || ''; }

/** Rows under Today, Yesterday and Earlier, in their order. */
export function ncDays(items: Notice[], now = new Date()): { day: string; items: Notice[] }[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const out: { day: string; items: Notice[] }[] = [];
  for (const n of items) {
    const at = Date.parse(n.created_at);
    const day = at >= start ? 'Today' : at >= start - 86400000 ? 'Yesterday' : 'Earlier';
    const last = out[out.length - 1];
    if (last?.day === day) last.items.push(n); else out.push({ day, items: [n] });
  }
  return out;
}

const POLL_MS = 20_000;
const TOAST_GAP_MS = 5_000;

@Injectable({ providedIn: 'root' })
export class NotifyStore {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  unread = signal(0);
  /** Bumped whenever the count shows something new, so an open list reads again. */
  fresh = signal(0);
  /** Whether a new notification shows a toast (Settings > Notifications). */
  toasts = signal(true);
  private latest: string | null | undefined = undefined;
  private lastToast = 0;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private onVisible = () => { if (document.visibilityState === 'visible') void this.poll(); };

  /** While someone is signed in: the count now, then every POLL_MS (and when the tab comes back). */
  private follow = effect(() => {
    const on = this.auth.signedIn();
    untracked(() => on ? this.start() : this.stop());
  });

  private start() {
    if (this.running) return;
    this.running = true;
    void this.poll();
    void firstValueFrom(this.http.get<{ toast: boolean }>('/api/notifications/settings'))
      .then(s => this.toasts.set(s.toast !== false)).catch(() => { /* the default */ });
    this.timer = setInterval(() => { if (document.visibilityState === 'visible') void this.poll(); }, POLL_MS);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private stop() {
    this.running = false;
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.latest = undefined;
    this.unread.set(0);
  }

  async poll() {
    let got: { unread: number; latest: Notice | null };
    try { got = await firstValueFrom(this.http.get<{ unread: number; latest: Notice | null }>('/api/notifications/count')); }
    catch { return; }
    const before = this.unread(), was = this.latest;
    this.unread.set(got.unread);
    this.latest = got.latest?.id ?? null;
    if (was === undefined || this.latest === was) return;
    this.fresh.update(n => n + 1);
    // Something new since the last look (not just the page's first look).
    const n = got.latest && !got.latest.read ? Math.max(1, got.unread - before) : 0;
    // Not about the place on screen (a Chat answer in the conversation open): that is seen already.
    const here = n === 1 && !!got.latest?.link && got.latest.link.split('?')[0] === location.pathname;
    if (n && !here && this.toasts() && Date.now() - this.lastToast > TOAST_GAP_MS) {
      this.lastToast = Date.now();
      const x = got.latest!;
      const text = n > 1 ? `${n} ${t('new notifications')}` : t(x.title) + (ncCtx(x) ? ` · ${ncCtx(x)}` : '');
      Toast.show(text, { tone: x.tone === 'danger' ? 'danger' : 'info',
                         action: x.link && n === 1 ? { label: t('Open'), run: () => void this.open(x) } : undefined });
    }
  }

  list(o: { kinds?: string[]; unread?: boolean; before?: string; limit?: number; counts?: boolean } = {}) {
    const q = new URLSearchParams();
    if (o.kinds?.length) q.set('kind', o.kinds.join(','));
    if (o.unread) q.set('unread', '1');
    if (o.before) q.set('before', o.before);
    if (o.limit) q.set('limit', String(o.limit));
    if (o.counts) q.set('counts', '1');
    return firstValueFrom(this.http.get<NoticePage>('/api/notifications?' + q)).then(p => {
      this.unread.set(p.unread);
      return p;
    });
  }

  async markRead(ids: string[] | 'all') {
    const body = ids === 'all' ? { all: true } : { ids };
    try {
      const r = await firstValueFrom(this.http.post<{ unread: number }>('/api/notifications/read', body));
      this.unread.set(r.unread);
      return true;
    } catch { return false; }
  }

  async remove(ids: string[] | 'all' | 'read') {
    const body = ids === 'all' ? { all: true } : ids === 'read' ? { all: true, read: true } : { ids };
    try {
      const r = await firstValueFrom(this.http.post<{ unread: number }>('/api/notifications/remove', body));
      this.unread.set(r.unread);
      return true;
    } catch {
      Toast.show(t('Could not remove them.'), { tone: 'danger' });
      return false;
    }
  }

  /** A row clicked: read now, and its place opened in the app. */
  async open(n: Notice) {
    if (!n.read) { n.read = true; void this.markRead([n.id]); }
    if (n.link) navOpen(n.link);
  }
}

/** One notification, one line. */
@Component({
  selector: 'wb-nc-row',
  imports: [T],
  template: `
<button type="button" class="nc-row" [attr.data-unread]="n().read ? null : 1" [attr.data-tone]="n().tone"
        [title]="tip()" (click)="pick.emit()">
  <svg class="nc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="ico().s"/>@if (ico().f) {<path class="f" [attr.d]="ico().f"/>}</svg>
  <span class="nc-title">{{ n().title | t }}</span>
  <span class="nc-ctx">{{ ctx() }}</span>
  <span class="nc-when">{{ ago() }}</span>
</button>`,
})
export class NcRow {
  n = input.required<Notice>();
  pick = output<void>();
  ico = computed(() => ncIcon(this.n().kind));
  ctx = computed(() => ncCtx(this.n()));
  ago = computed(() => { LANG(); return ncAgo(this.n().created_at); });
  tip = computed(() => {
    const n = this.n();
    return [t(n.title), ncCtx(n), n.body, new Date(n.created_at).toLocaleString()].filter(Boolean).join('\n');
  });
}

/** The bell beside Settings, and the panel it opens: the latest, by day,
 *  with the kinds to show as tiny toggles and "Mark all read" on one row. */
@Component({
  selector: 'app-notify-bell',
  imports: [T, NcRow],
  // Not encapsulated: the bell stands among the shell's tabs (app.ts), and the
  // rows it draws are drawn the same on the page and in Settings.
  encapsulation: ViewEncapsulation.None,
  styleUrl: './notifications.css',
  template: `
<button #btn type="button" class="tcv-tab tcv-bell" [class.tb-tight]="tight()" [attr.data-unread]="store.unread() ? 1 : null"
        [attr.aria-expanded]="open()" aria-haspopup="dialog"
        [attr.aria-label]="label()" [title]="label()" (click)="toggle()">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0"/></svg>
  @if (store.unread(); as n) { <span class="tcv-bell-n">{{ n > 99 ? '99+' : n }}</span> }
</button>
@if (open()) {
  <div class="nc-pop tcv-pop-in" animate.leave="tcv-leave" role="dialog" [attr.aria-label]="'Notifications' | t"
       [style.top.px]="at().top" [style.right.px]="at().right">
    <div class="nc-pop-head">
      <a class="nc-pop-title" [href]="pageHref" (click)="toPage($event)" [title]="'Open all notifications' | t">{{ 'Notifications' | t }}</a>
      <div class="nc-filters" role="group" [attr.aria-label]="'Show' | t">
        @for (g of groups(); track g.id) {
          <button type="button" class="nc-filter" [attr.data-on]="shown().has(g.id) ? 1 : null" [attr.aria-pressed]="shown().has(g.id)"
                  (click)="flip(g.id)">{{ g.label | t }}<small>{{ g.n }}</small></button>
        }
      </div>
      <button type="button" class="nc-act" [disabled]="!store.unread()" (click)="readAll()">{{ 'Mark all read' | t }}</button>
    </div>
    <div class="nc-pop-list">
      @if (items(); as list) {
        @for (d of days(); track d.day) {
          <div class="nc-day">{{ d.day | t }}</div>
          @for (n of d.items; track n.id) { <wb-nc-row [n]="n" (pick)="go(n)" /> }
        } @empty {
          <div class="nc-empty">{{ (shown().size ? 'Nothing of these kinds.' : 'Nothing yet. Builds, drawings, questions and prices will show here.') | t }}</div>
        }
      } @else {
        <div class="nc-empty">{{ 'Loading…' | t }}</div>
      }
    </div>
  </div>
}`,
})
export class NotifyBell implements OnDestroy {
  store = inject(NotifyStore);
  /** With a tab pushed right in the bar, the bell stands beside it (topbar.ts). */
  tight = input(false);
  private host = inject(ElementRef).nativeElement as HTMLElement;
  private btn = viewChild<ElementRef<HTMLButtonElement>>('btn');
  open = signal(false);
  at = signal({ top: 0, right: 0 });
  items = signal<Notice[] | null>(null);
  counts = signal<Record<string, number>>({});
  /** The groups ticked; none is all. */
  shown = signal<Set<string>>(new Set());
  pageHref = navHref({ ws: 'notifications' });
  label = computed(() => { LANG(); const n = this.store.unread(); return t('Notifications') + (n ? ` · ${n} ${t('unread')}` : ''); });
  groups = computed(() => {
    const c = this.counts();
    return NC_GROUPS.map(g => ({ ...g, n: g.kinds.reduce((a, k) => a + (c[k] ?? 0), 0) })).filter(g => g.n || this.shown().has(g.id));
  });
  days = computed(() => ncDays(this.items() ?? []));
  private reread = effect(() => { this.store.fresh(); if (untracked(this.open)) untracked(() => void this.load()); });

  ngOnDestroy() { this.open.set(false); }

  toggle() {
    if (this.open()) { this.open.set(false); return; }
    const r = this.btn()?.nativeElement.getBoundingClientRect();
    if (r) this.at.set({ top: Math.round(r.bottom + 4), right: Math.max(8, Math.round(innerWidth - r.right)) });
    this.open.set(true);
    void this.load();
  }

  async load() {
    const kinds = NC_GROUPS.filter(g => this.shown().has(g.id)).flatMap(g => g.kinds);
    try {
      const p = await this.store.list({ kinds, limit: 40, counts: true });
      this.items.set(p.items);
      if (p.counts && !kinds.length) this.counts.set(p.counts);
    } catch { this.items.set([]); }
  }

  flip(id: string) {
    const s = new Set(this.shown());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.shown.set(s);
    void this.load();
  }

  async readAll() {
    if (await this.store.markRead('all')) this.items.update(l => (l ?? []).map(n => ({ ...n, read: true })));
  }

  go(n: Notice) {
    this.open.set(false);
    void this.store.open(n);
    this.items.update(l => (l ?? []).map(x => x.id === n.id ? { ...x, read: true } : x));
  }

  toPage(e: MouseEvent) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    this.open.set(false);
    navOpen(this.pageHref);
  }

  @HostListener('document:keydown.escape') esc() { this.open.set(false); }
  @HostListener('document:pointerdown', ['$event']) outside(e: PointerEvent) {
    if (this.open() && !this.host.contains(e.target as Node) && !(e.target as Element)?.closest?.('.nc-pop')) this.open.set(false);
  }
  @HostListener('window:resize') resized() { this.open.set(false); }
}
