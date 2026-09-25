import { Component, HostListener, Type, computed, effect, signal, viewChild, ElementRef } from '@angular/core';
import { NgComponentOutlet, NgTemplateOutlet } from '@angular/common';
import { COMPONENTS, GROUPS, NARROW, ROOMS, ToolInfo } from './registry';
import { ToolFrame } from './frame';

const KEY = 'x3.tool';
const FAVS = 'x3.tools.favs';
const RECENT = 'x3.tools.recent';

function load<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}
function save(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ }
}

/** Usage for the Analytics tab; never in the way of opening a tool. */
function ping(id: string, event: string): void {
  fetch('/api/tools/usage', {
    method: 'POST', headers: { 'Content-Type': 'application/json','X-Redline-CSRF':'1' },
    body: JSON.stringify({ id, event, surface: 'ui' }), keepalive: true,
  }).catch(() => undefined);
}

/** How well a tool answers a search: every word must be found somewhere;
 *  a hit in the name counts most, then keywords, then the blurb. */
function score(t: ToolInfo, words: string[]): number {
  const name = t.name.toLowerCase(), id = t.id, blurb = t.blurb.toLowerCase();
  const kw = t.keywords.join(' ').toLowerCase(), rooms = t.rooms.join(' ');
  let s = 0;
  for (const w of words) {
    if (name.startsWith(w)) s += 8;
    else if (name.includes(w) || id.includes(w)) s += 5;
    else if (kw.includes(w)) s += 3;
    else if (blurb.includes(w)) s += 2;
    else if (rooms.includes(w)) s += 1;
    else return 0;
  }
  return s + Math.min(t.uses, 20) / 20;
}

/** The Tools tab: every tool, searchable, with favourites and the ones used
 *  lately first; the chosen one fills the room. */
@Component({
  selector: 'app-room-tools',
  imports: [NgComponentOutlet, NgTemplateOutlet, ToolFrame],
  styleUrl: './room.css',
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0">
  <nav class="tcv-tools-list" aria-label="Tools">
    <div class="tcv-tools-find">
      <input #search type="search" class="tcv-tools-search" placeholder="Search {{ all().length }} tools   /"
             [value]="query()" (input)="query.set($any($event.target).value)"
             (keydown)="keys($event)" aria-label="Search tools" spellcheck="false" />
      <div class="tcv-tools-chips" role="group" aria-label="Filter">
        <button class="tcv-tools-chip" [attr.data-on]="onlyFavs() ? 1 : null"
                (click)="onlyFavs.set(!onlyFavs())" title="Only favourites">★</button>
        @for (r of rooms; track r.id) {
          <button class="tcv-tools-chip" [attr.data-on]="room() === r.id ? 1 : null"
                  (click)="room.set(room() === r.id ? null : r.id)">{{ r.label }}</button>
        }
      </div>
    </div>
    <div class="tcv-tools-scroll">
      @if (error()) {
        <div class="tcv-tools-empty">{{ error() }}</div>
      }
      @if (filtering()) {
        <div class="tcv-tools-group">{{ results().length }} {{ results().length === 1 ? 'tool' : 'tools' }}</div>
        @for (t of results(); track t.id; let i = $index) {
          <ng-container *ngTemplateOutlet="item; context: { $implicit: t, hot: i === cursor() }" />
        } @empty {
          <div class="tcv-tools-empty">Nothing matches. Try fewer words, or another room.</div>
        }
      } @else {
        @if (favList().length) {
          <div class="tcv-tools-group">Favourites</div>
          @for (t of favList(); track t.id) { <ng-container *ngTemplateOutlet="item; context: { $implicit: t }" /> }
        }
        @if (recentList().length) {
          <div class="tcv-tools-group">Recently used</div>
          @for (t of recentList(); track t.id) { <ng-container *ngTemplateOutlet="item; context: { $implicit: t }" /> }
        }
        @for (g of groups; track g.id) {
          @if (inGroup(g.id).length) {
            <button class="tcv-tools-group tcv-tools-grouphead" (click)="toggle(g.id)"
                    [attr.aria-expanded]="!closed().includes(g.id)">
              <span>{{ closed().includes(g.id) ? '▸' : '▾' }} {{ g.label }}</span><span>{{ inGroup(g.id).length }}</span>
            </button>
            @if (!closed().includes(g.id)) {
              @for (t of inGroup(g.id); track t.id) { <ng-container *ngTemplateOutlet="item; context: { $implicit: t }" /> }
            }
          }
        }
      }
    </div>
  </nav>

  <ng-template #item let-t let-hot="hot">
    <div class="tcv-tools-item" [attr.data-on]="t.id === here()?.id ? 1 : null" [attr.data-hot]="hot ? 1 : null">
      <!-- Name, then its version, then MCP, then the star - always in that order. -->
      <div class="tcv-tools-top">
        <button class="tcv-tools-open" (click)="pick(t)" [title]="t.blurb">
          <span class="tcv-menu-name">{{ t.name }}</span>
        </button>
        @if (t.version) { <span class="tcv-tools-ver" [title]="'version ' + t.version + ' - when its files last changed'">v{{ t.version.slice(5) }}</span> }
        @if (t.runnable) {
          <span class="tcv-tools-mcp" title="Agents can run this tool through the MCP server (run_tool)">MCP</span>
        }
        <button class="tcv-tools-star" [attr.data-on]="favs().includes(t.id) ? 1 : null"
                (click)="fav(t)" [attr.aria-label]="(favs().includes(t.id) ? 'Unstar ' : 'Star ') + t.name"
                [title]="favs().includes(t.id) ? 'Remove from favourites' : 'Add to favourites'">★</button>
      </div>
      <span class="tcv-menu-blurb tcv-tools-blurb" (click)="pick(t)">{{ t.blurb }}</span>
    </div>
  </ng-template>

  <section class="tcv-tools-body">
    @if (here(); as t) {
      <header class="tcv-tools-head">
        <span class="tcv-label" style="color: var(--ink)">{{ t.name }}</span>
        @if (t.version) { <span class="tcv-tools-ver" title="when this tool's files last changed">v{{ t.version }}</span> }
        @if (t.runnable) { <span class="tcv-tools-mcp" title="Agents can run this tool through the MCP server (run_tool)">MCP</span> }
        <button class="tcv-tools-star" [attr.data-on]="favs().includes(t.id) ? 1 : null" (click)="fav(t)"
                [attr.aria-label]="favs().includes(t.id) ? 'Unstar' : 'Star'"
                [title]="favs().includes(t.id) ? 'Remove from favourites' : 'Add to favourites'">★</button>
        <span class="truncate text-[11px]" style="color: var(--ink-dim)">{{ t.blurb }}</span>
        <span class="tcv-tools-meta">
          @if (t.uses) { <span>{{ t.uses }} uses · 30 days</span> }
        </span>
      </header>
      <div class="tcv-tools-stage" [attr.data-size]="narrow(t) ? 'narrow' : 'wide'">
        @if (component(); as c) {
          <ng-container *ngComponentOutlet="c" />
        } @else if (t.src) {
          <app-tool-frame [src]="t.src" hide=".brand" />
        } @else {
          <div class="p-4 text-[12px]" style="color: var(--ink-dim)">opening…</div>
        }
      </div>
    } @else {
      <div class="tcv-tools-empty" style="margin: 24px">{{ error() || 'Loading the tools…' }}</div>
    }
  </section>
</div>`,
})
export class RoomTools {
  readonly groups = GROUPS;
  readonly rooms = ROOMS;
  private searchBox = viewChild<ElementRef<HTMLInputElement>>('search');

  all = signal<ToolInfo[]>([]);
  error = signal('');
  query = signal('');
  room = signal<string | null>(null);
  onlyFavs = signal(false);
  favs = signal<string[]>(load(FAVS, []));
  recent = signal<string[]>(load(RECENT, []));
  closed = signal<string[]>(load('x3.tools.closed', []));
  cursor = signal(0);
  private id = signal<string>(load(KEY, 'i2c-pullup'));

  private byId = computed(() => new Map(this.all().map(t => [t.id, t])));
  here = computed(() => this.byId().get(this.id()) ?? this.all()[0] ?? null);
  component = signal<Type<unknown> | null>(null);

  filtering = computed(() => !!this.query().trim() || !!this.room() || this.onlyFavs());
  results = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    const room = this.room(), favs = this.favs();
    return this.all()
      .filter(t => (!room || t.rooms.includes(room) || t.rooms.includes('all')) && (!this.onlyFavs() || favs.includes(t.id)))
      .map(t => ({ t, s: words.length ? score(t, words) : 1 + Math.min(t.uses, 20) / 20 }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
      .map(x => x.t);
  });
  favList = computed(() => this.favs().map(id => this.byId().get(id)).filter((t): t is ToolInfo => !!t));
  recentList = computed(() => this.recent().filter(id => !this.favs().includes(id))
    .map(id => this.byId().get(id)).filter((t): t is ToolInfo => !!t).slice(0, 5));

  constructor() {
    fetch('/api/tools/catalog')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((c: { tools: ToolInfo[] }) => this.all.set(c.tools))
      .catch(e => this.error.set(`The tool list did not load (${e.message}). Is the API running?`));
    effect(() => {
      const t = this.here();
      this.component.set(null);
      const loader = t && COMPONENTS[t.id];
      if (loader) loader().then(c => { if (this.here() === t) this.component.set(c); });
    });
    effect(() => { this.query(); this.room(); this.cursor.set(0); });
  }

  inGroup(g: string): ToolInfo[] { return this.all().filter(t => t.group === g); }
  narrow(t: ToolInfo): boolean { return NARROW.has(t.id); }

  pick(t: ToolInfo) {
    this.id.set(t.id);
    save(KEY, t.id);
    this.recent.update(r => [t.id, ...r.filter(x => x !== t.id)].slice(0, 12));
    save(RECENT, this.recent());
    ping(t.id, 'open');
  }

  fav(t: ToolInfo) {
    const on = this.favs().includes(t.id);
    this.favs.update(f => (on ? f.filter(x => x !== t.id) : [...f, t.id]));
    save(FAVS, this.favs());
    ping(t.id, on ? 'unfavourite' : 'favourite');
  }

  toggle(g: string) {
    this.closed.update(c => (c.includes(g) ? c.filter(x => x !== g) : [...c, g]));
    save('x3.tools.closed', this.closed());
  }

  /** In the search box: arrows move through the results, Enter opens. */
  keys(e: KeyboardEvent) {
    const list = this.results();
    if (e.key === 'ArrowDown') { this.cursor.set(Math.min(list.length - 1, this.cursor() + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this.cursor.set(Math.max(0, this.cursor() - 1)); e.preventDefault(); }
    else if (e.key === 'Enter' && list[this.cursor()]) { this.pick(list[this.cursor()]); }
    else if (e.key === 'Escape') { this.query.set(''); this.room.set(null); this.onlyFavs.set(false); }
  }

  /** "/" anywhere in the tab jumps to the search. */
  @HostListener('document:keydown', ['$event'])
  slash(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) {
      e.preventDefault();
      this.searchBox()?.nativeElement.focus();
    }
  }
}
