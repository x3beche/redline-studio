import {
  Component, Directive, ElementRef, OnDestroy, OnInit, computed, effect, inject, input, output, signal, untracked,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { T, t } from '../i18n';

/** Says once that an element has come into view - a bin fetches its pins,
 *  a thumbnail its drawing, when somebody can see it, not all sixty at once. */
@Directive({ selector: '[appInView]' })
export class InView implements OnInit, OnDestroy {
  appInView = output<void>();
  private el = inject(ElementRef<HTMLElement>);
  private io?: IntersectionObserver;
  ngOnInit() {
    if (typeof IntersectionObserver === 'undefined') { this.appInView.emit(); return; }
    this.io = new IntersectionObserver(seen => {
      if (seen.some(e => e.isIntersecting)) { this.appInView.emit(); this.io?.disconnect(); }
    }, { rootMargin: '80px' });
    this.io.observe(this.el.nativeElement);
  }
  ngOnDestroy() { this.io?.disconnect(); }
}

/** An LCSC part's picture: its footprint, the one drawing every kept part
 *  has, in the theme's colours - the copper and the silkscreen are two
 *  masks (GET /api/parts/{C}/footprint.svg?layer=pads|silk) painted with
 *  the page's tokens, so every part looks the same way, dark or light. */
@Component({
  selector: 'wb-fp',
  imports: [InView],
  host: { class: 'wb-fp' },
  styles: [`
    :host { position: relative; display: block; width: 100%; height: 100%; background: var(--surface-2); }
    i { position: absolute; inset: 12%; mask-repeat: no-repeat; mask-position: center; mask-size: contain;
        -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; -webkit-mask-size: contain; }
    .silk { background: var(--ink-dim); }
    .pads { background: var(--accent); }
  `],
  template: `
    <span (appInView)="shown.set(true)"></span>
    @if (shown()) {
      <i class="silk" [style.mask-image]="url('silk')" [style.-webkit-mask-image]="url('silk')"></i>
      <i class="pads" [style.mask-image]="url('pads')" [style.-webkit-mask-image]="url('pads')"></i>
    }
  `,
})
export class FootprintThumb {
  lcsc = input.required<string>();
  shown = signal(false);
  url(layer: 'pads' | 'silk') { return `url("/api/parts/${encodeURIComponent(this.lcsc())}/footprint.svg?layer=${layer}")`; }
}

/** One thing in the cabinet: an LCSC part, or a catalog product. */
export interface CabinetItem {
  key: string;
  /** Its drawer, and the label inside it (a part's group and branch; a category and its child). */
  group: string; sub?: string | null;
  /** Ordered by this first (a value: 100n before 10u), then by its title. */
  rank?: number;
  title: string; line?: string | null; line2?: string | null;
  /** A mono line: the package, and a number that copies on a click (the LCSC number). */
  meta?: string | null; copy?: string | null;
  badge?: { text: string; on: boolean; tip: string } | null;
  /** Its price, and whether the seller has it. */
  note?: string | null; stock?: 'in' | 'out' | null;
  /** Its picture: an LCSC part's footprint, or a product's photos, best first. */
  thumb?: { lcsc?: string; srcs?: string[] } | null;
  /** An LCSC number whose pins can be listed in the bin. */
  pins?: string | null;
  removable?: boolean;
  tip?: string | null;
}

interface Pin { number: string; name: string }

/** THE CABINET: the parts drawer's look for any list of things - groups as
 *  plain rows (chevron, name, count) that open to trays of bins, a label
 *  per branch inside, each bin its picture, name, a line or two, its price
 *  and stock. Flat, in the app's own tones. The Product Catalog shows every
 *  seller's products this way (rooms/manufacturers.ts): the LCSC seller's
 *  parts by the drawer's groups with their footprints and pins, a site's
 *  products by their categories with their photos.
 *
 *  Several drawers may be out at once, all of them at first; which are out
 *  is kept in this browser per page (`storeKey`). Selection is the page's:
 *  a bin carries its key as data-key (marquee.ts), Ctrl/Shift-click picks,
 *  a right-click asks for its menu. */
@Component({
  selector: 'wb-cabinet',
  imports: [InView, FootprintThumb, T],
  template: `
<div class="pdw pdw-big">
  <div class="pdw-head">
    <span class="tcv-label">{{ label() | t }}</span>
    <span class="mono pdw-total">{{ items().length }}</span>
    <button class="tcv-drawer-all ml-auto" (click)="setAll(!anyOpen())"
            [title]="(anyOpen() ? 'close every drawer' : 'open every drawer') | t">
      {{ (anyOpen() ? 'close all' : 'open all') | t }}</button>
  </div>

  <div class="pdw-cabinet">
    @for (g of tree(); track g.name) {
      <section class="pdw-drawer" [class.pdw-open]="isOpen(g.name)">
        <button class="pdw-front" (click)="flip(g.name)" [attr.aria-expanded]="isOpen(g.name)" [title]="g.inside">
          <svg class="pdw-chev" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="pdw-name">{{ g.name }}</span>
          <span class="mono pdw-count">{{ g.count }}</span>
        </button>
        <div class="pdw-slide">
          <div class="pdw-clip">
            @if (visited().has(g.name)) {
              <div class="pdw-tray">
                @for (b of g.branches; track b.name) {
                  @if (g.branches.length > 1 || b.name !== g.name) {
                    <div class="pdw-divider"><span>{{ b.name }}</span><span class="mono">{{ b.items.length }}</span></div>
                  }
                  <div class="pdw-bins">
                    @for (it of b.items; track it.key) {
                      <div class="pdw-bin pdw-thumbed" role="button" tabindex="0" [attr.data-key]="it.key"
                           [class.pdw-seen]="seen() === it.key" [class.pdw-pulse]="pulse() === it.key"
                           [class.pdw-sel]="selected().has(it.key)" [title]="it.tip ?? it.title"
                           (click)="binClick($event, it.key)" (keydown.enter)="open.emit(it.key)"
                           (contextmenu)="menu.emit({ event: $event, key: it.key })"
                           (appInView)="it.pins && loadPins(it.pins)">
                        <span class="pdw-thumb">
                          @if (it.thumb?.lcsc; as c) { <wb-fp [lcsc]="c" /> }
                          @else if (src(it); as s) { <img [src]="s" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" (error)="broke(s)"> }
                        </span>
                        <div class="pdw-text">
                          <div class="pdw-top">
                            <span class="pdw-value">{{ it.title }}</span>
                            @if (it.removable) {
                              <button class="pdw-forget" (click)="$event.stopPropagation(); remove.emit(it.key)"
                                      [title]="'forget it' | t" [attr.aria-label]="'forget it' | t">&times;</button>
                            }
                          </div>
                          @if (it.line) { <div class="pdw-sub">{{ it.line }}</div> }
                          @if (it.line2) { <div class="pdw-sub">{{ it.line2 }}</div> }
                          @if (it.meta || it.copy || it.badge) {
                            <div class="mono pdw-meta">
                              @if (it.meta) { <span class="pdw-pkg">{{ it.meta }}</span> }
                              @if (it.copy; as c) {
                                <button class="pdw-lcsc" (click)="copy(c, $event)" [title]="copied() === c ? ('copied' | t) : ('copy' | t) + ' ' + c">
                                  {{ copied() === c ? ('copied' | t) : c }}</button>
                              }
                              @if (it.badge; as bd) { <span class="pdw-badge" [class.pdw-badge-3d]="bd.on" [title]="bd.tip | t">{{ bd.text }}</span> }
                            </div>
                          }
                          @if (it.note || it.stock) {
                            <div class="pdw-extra">
                              @if (it.stock) { <i class="pdw-dot" [attr.data-s]="it.stock"></i> }{{ it.note }}</div>
                          }
                          @if (it.pins; as c) {
                            <button class="pdw-pins" (click)="togglePinout(c, $event)" [attr.aria-expanded]="expanded() === c">
                              {{ pinCount(c) }} {{ expanded() === c ? '▴' : '▾' }}</button>
                          }
                        </div>
                      </div>
                      @if (it.pins && expanded() === it.pins) {
                        <!-- The pins by number, as a list. -->
                        <div class="pdw-pinout">
                          <div class="pdw-pinout-bar">
                            <span>{{ it.title }} · {{ 'pins' | t }}</span>
                            <button (click)="open.emit(it.key)">{{ 'full view' | t }} &rarr;</button>
                          </div>
                          @switch (pinState(it.pins)) {
                            @case ('loading') { <p class="pdw-note">{{ 'reading the pins…' | t }}</p> }
                            @case ('none') { <p class="pdw-note">{{ 'its symbol names no pins' | t }}</p> }
                            @case ('error') { <p class="pdw-note">{{ 'the pins could not be read' | t }}</p> }
                            @default {
                              <ol class="pdw-pinlist">
                                @for (n of pinList(it.pins); track n.number) {
                                  <li [class.pdw-nc]="nc(n)"><span class="mono pdw-pnum">{{ n.number }}</span>
                                    <span class="pdw-pname" [title]="n.name">{{ n.name === n.number ? '–' : n.name }}</span></li>
                                }
                              </ol>
                            }
                          }
                        </div>
                      }
                    }
                  </div>
                }
              </div>
            }
          </div>
        </div>
      </section>
    }
  </div>
</div>
  `,
})
export class Cabinet {
  items = input.required<CabinetItem[]>();
  /** The groups in this order first, the rest by name. */
  order = input<string[]>([]);
  label = input('in the drawer');
  /** Which drawers are out is kept under this name, per page. */
  storeKey = input('cabinet');
  selected = input<Set<string>>(new Set());
  seen = input<string | null>(null);
  pulse = input<string | null>(null);
  open = output<string>();
  pick = output<string>();
  menu = output<{ event: MouseEvent; key: string }>();
  remove = output<string>();

  private http = inject(HttpClient);
  private el = inject(ElementRef<HTMLElement>);

  tree = computed(() => {
    const order = this.order(), groups = new Map<string, Map<string, CabinetItem[]>>();
    for (const it of this.items()) {
      const g = it.group || t('Other'), b = it.sub || g;
      if (!groups.has(g)) groups.set(g, new Map());
      const m = groups.get(g)!;
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(it);
    }
    const rank = (g: string) => { const i = order.indexOf(g); return i < 0 ? order.length : i; };
    return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([name, m]) => {
        const branches = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          .map(([bn, items]) => ({ name: bn, items: [...items].sort((x, y) => ((x.rank ?? 0) - (y.rank ?? 0))
            || x.title.localeCompare(y.title, undefined, { numeric: true })) }));
        return { name, branches, count: branches.reduce((n, b) => n + b.items.length, 0),
                 inside: branches.map(b => `${b.name} ${b.items.length}`).join(' · ') };
      });
  });

  // ---- which drawers are out, per page; all of them the first time ----

  private openSet = signal<Set<string>>(new Set());
  visited = signal<Set<string>>(new Set());
  private loadedFor: string | null = null;
  private recall = effect(() => {
    const key = 'redline.catalog.cabinet.' + this.storeKey(), names = this.tree().map(g => g.name);
    if (!names.length || this.loadedFor === key) return;
    this.loadedFor = key;
    let saved: string[] | null = null;
    try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); saved = Array.isArray(v) ? v.map(String) : null; } catch { /* private window */ }
    untracked(() => this.set(new Set(saved ?? names), false));
  });
  isOpen(g: string) { return this.openSet().has(g); }
  anyOpen = computed(() => this.tree().some(g => this.openSet().has(g.name)));
  flip(g: string) {
    const s = new Set(this.openSet());
    if (s.has(g)) s.delete(g); else s.add(g);
    this.set(s);
  }
  setAll(open: boolean) { this.set(new Set(open ? this.tree().map(g => g.name) : [])); }
  private set(s: Set<string>, keep = true) {
    this.openSet.set(s);
    if ([...s].some(g => !this.visited().has(g))) this.visited.set(new Set([...this.visited(), ...s]));
    if (keep) try { localStorage.setItem('redline.catalog.cabinet.' + this.storeKey(), JSON.stringify([...s])); } catch { /* private window */ }
  }
  /** A thing just added: its drawer opens, its bin is scrolled to and blinks. */
  private pulsing = effect(() => {
    const k = this.pulse(), g = k ? this.items().find(i => i.key === k)?.group : null;
    if (!k || !g) return;
    untracked(() => { if (!this.isOpen(g)) this.flip(g); });
    setTimeout(() => this.el.nativeElement.querySelector(`[data-key="${CSS.escape(k)}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 200);
  });

  binClick(e: MouseEvent, key: string) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) this.pick.emit(key); else this.open.emit(key);
  }

  // ---- pictures that did not load: the next one ----

  private broken = signal<Set<string>>(new Set());
  src(it: CabinetItem): string | null { return (it.thumb?.srcs ?? []).find(u => !this.broken().has(u)) ?? null; }
  broke(s: string) { this.broken.update(b => new Set(b).add(s)); }

  /** A number to the clipboard, without opening the bin. */
  copied = signal<string | null>(null);
  copy(text: string, ev: Event) {
    ev.stopPropagation();
    const done = () => { this.copied.set(text); setTimeout(() => this.copied() === text && this.copied.set(null), 1200); };
    try { navigator.clipboard.writeText(text).then(done, done); } catch { done(); }
  }

  // ---- an LCSC part's pins (GET /api/parts/{C}/pins) ----

  private pins = signal<Record<string, Pin[] | 'loading' | 'error'>>({});
  expanded = signal<string | null>(null);
  loadPins(c: string) {
    if (this.pins()[c]) return;
    this.pins.update(m => ({ ...m, [c]: 'loading' }));
    this.http.get<Pin[]>(`/api/parts/${encodeURIComponent(c)}/pins`).subscribe({
      next: rows => this.pins.update(m => ({ ...m, [c]: rows })),
      error: () => this.pins.update(m => ({ ...m, [c]: 'error' })),
    });
  }
  pinCount(c: string): string {
    const v = this.pins()[c];
    return Array.isArray(v) ? t(v.length === 1 ? '{n} pin' : '{n} pins').replace('{n}', String(v.length)) : t('Pins');
  }
  pinState(c: string): 'loading' | 'error' | 'none' | 'ok' {
    const v = this.pins()[c];
    return !v || v === 'loading' ? 'loading' : v === 'error' ? 'error' : v.length ? 'ok' : 'none';
  }
  togglePinout(c: string, ev: Event) {
    ev.stopPropagation();
    this.loadPins(c);
    this.expanded.set(this.expanded() === c ? null : c);
  }
  pinList(c: string): Pin[] { const v = this.pins()[c]; return Array.isArray(v) ? v : []; }
  nc(n: Pin) { return /^(NC|DNC|NONE)$/.test(n.name.toUpperCase().replace(/[^A-Z]/g, '')); }
}
