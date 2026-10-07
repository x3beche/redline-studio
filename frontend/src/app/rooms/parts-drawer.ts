import {
  Component, Directive, ElementRef, OnDestroy, OnInit, computed, effect, inject, input, output, signal,
  untracked,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { PartHeld } from '../api';

/** One pin as the symbol has it (backend/lcsc.py pins). */
interface Pin { number: string; name: string; electric?: string }

/** Says once that an element has come into view - the bins fetch their
 *  pin count when somebody can see them, not all sixty at once. */
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

/** The parts drawer: the parts kept from LCSC, as a cabinet.
 *
 *  Each group is a plain row - chevron, name, count - that opens to a
 *  tray of bins, one per part: its value, part number, package, LCSC
 *  number, and for chips and connectors the pins as a list. The tray
 *  scrolls inside itself so the cabinet stays where it is. The branches
 *  (Capacitors, Resistors) are small labels in the tray. Flat on purpose,
 *  in the app's own tones: no drawings, no depth.
 *
 *  Several drawers may be out at once: "open all" has to mean something,
 *  and comparing the caps against the resistors is a real thing to do.
 *  Each tray is capped in height, so even all six out is a short scroll. */
@Component({
  selector: 'app-parts-drawer',
  imports: [InView],
  template: `
<div class="pdw">
  <div class="pdw-head">
    <span class="tcv-label">in the drawer</span>
    <span class="mono pdw-total">{{ held().length }}</span>
    <button class="tcv-drawer-all ml-auto" (click)="setAll(!anyOpen())"
            [title]="anyOpen() ? 'close every drawer' : 'open every drawer'">
      {{ anyOpen() ? 'close all' : 'open all' }}</button>
  </div>

  <div class="pdw-cabinet">
    @for (g of tree(); track g.name) {
      <section class="pdw-drawer" [class.pdw-open]="isOpen(g.name)">
        <button class="pdw-front" (click)="flip(g.name)"
                [attr.aria-expanded]="isOpen(g.name)" [attr.aria-controls]="'pdw-' + g.slug"
                [title]="g.inside">
          <svg class="pdw-chev" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"
                  stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="pdw-name">{{ g.name }}</span>
          <span class="mono pdw-count">{{ g.count }}</span>
        </button>

        <div class="pdw-slide" [id]="'pdw-' + g.slug">
          <div class="pdw-clip">
            <!-- Filled the first time it is opened, then kept, so it can
                 close as smoothly as it opened. -->
            @if (visited().has(g.name)) {
              <div class="pdw-tray">
                @for (b of g.branches; track b.name) {
                  @if (g.branches.length > 1 || b.name !== g.name) {
                    <div class="pdw-divider">
                      <span>{{ b.name }}</span><span class="mono">{{ b.parts.length }}</span>
                    </div>
                  }
                  <div class="pdw-bins">
                    @for (p of b.parts; track p.lcsc) {
                      <div class="pdw-bin" role="button" tabindex="0" [attr.data-lcsc]="p.lcsc"
                           [class.pdw-seen]="seenLcsc() === p.lcsc"
                           [class.pdw-pulse]="pulse() === p.lcsc"
                           (click)="inspect.emit(p.lcsc)" (keydown.enter)="inspect.emit(p.lcsc)"
                           [title]="(p.category ?? '') + (p.maker ? ' · ' + p.maker : '')"
                           (appInView)="wired(p) && loadPins(p.lcsc)">
                        <div class="pdw-top">
                          <span class="pdw-value" [title]="p.mpn || p.name || ''">{{ headline(p) }}</span>
                          <button class="pdw-forget" (click)="forgetIt(p, $event)"
                                  title="forget it" aria-label="forget it">&times;</button>
                        </div>
                        <div class="pdw-sub">{{ subline(p) }}</div>
                        <div class="mono pdw-meta">
                          <span class="pdw-pkg" [title]="p.name ?? ''">{{ packageOf(p.name) }}</span>
                          <button class="pdw-lcsc" (click)="copy(p.lcsc, $event)"
                                  [title]="copied() === p.lcsc ? 'copied' : 'copy ' + p.lcsc">
                            {{ copied() === p.lcsc ? 'copied' : p.lcsc }}</button>
                          <span class="pdw-badge" [class.pdw-badge-3d]="p.has_3d"
                                [title]="p.has_3d ? 'came with a 3D model'
                                                  : 'footprint only - it will not stand on the board'">
                            {{ p.has_3d ? '3D' : '2D' }}</span>
                        </div>
                        @if (wired(p)) {
                          <button class="pdw-pins" (click)="togglePinout(p.lcsc, $event)"
                                  [attr.aria-expanded]="expanded() === p.lcsc">
                            {{ pinCount(p.lcsc) }} {{ expanded() === p.lcsc ? '▴' : '▾' }}
                          </button>
                        }
                      </div>

                      @if (expanded() === p.lcsc) {
                        <!-- The pins by number, as a list. -->
                        <div class="pdw-pinout">
                          <div class="pdw-pinout-bar">
                            <span>{{ p.mpn || p.name }} · pins</span>
                            <button (click)="inspect.emit(p.lcsc)">full view &rarr;</button>
                          </div>
                          @switch (pinState(p.lcsc)) {
                            @case ('loading') { <p class="pdw-note">reading the pins…</p> }
                            @case ('none') { <p class="pdw-note">its symbol names no pins</p> }
                            @case ('error') { <p class="pdw-note">the pins could not be read</p> }
                            @default {
                              <ol class="pdw-pinlist">
                                @for (n of pinList(p.lcsc); track n.number) {
                                  <li [class.pdw-nc]="kind(n) === 'nc'">
                                    <span class="mono pdw-pnum">{{ n.number }}</span>
                                    <span class="pdw-pname" [title]="n.name">{{ label(n) || '–' }}</span>
                                  </li>
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
export class PartsDrawer {
  held = input.required<PartHeld[]>();
  /** The part open in the column, to mark its bin. */
  seenLcsc = input<string | null>(null);
  /** A part just added or asked for again: its drawer opens, the bin is
   *  scrolled to and blinks. */
  pulse = input<string | null>(null);
  inspect = output<string>();
  forget = output<PartHeld>();

  private http = inject(HttpClient);

  /** Groups in a fixed order, branches by name, parts by value where they
   *  have one (100n before 10u), else by part number. */
  tree = computed(() => {
    const ORDER = ['ICs', 'Passives', 'Discretes', 'Electromechanical', 'Frequency', 'Displays', 'Other'];
    const groups = new Map<string, Map<string, PartHeld[]>>();
    for (const p of this.held()) {
      const g = p.group || 'Other', b = p.branch || 'Other';
      if (!groups.has(g)) groups.set(g, new Map());
      const m = groups.get(g)!;
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(p);
    }
    const rank = (g: string) => { const i = ORDER.indexOf(g); return i < 0 ? ORDER.length : i; };
    return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([name, m]) => {
        const branches = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          .map(([bn, parts]) => ({ name: bn, parts: [...parts].sort((x, y) =>
            (PartsDrawer.magnitude(x.value) - PartsDrawer.magnitude(y.value)) ||
            (x.mpn || x.name || x.lcsc).localeCompare(y.mpn || y.name || y.lcsc)) }));
        return {
          name, branches, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          count: branches.reduce((n, b) => n + b.parts.length, 0),
          inside: branches.map(b => `${b.name} ${b.parts.length}`).join(' · '),
        };
      });
  });

  /** A value as a number to sort by: 4.7kΩ, 100nF, 2.2uH, 11.0592MHz. */
  private static magnitude(v: string | null | undefined): number {
    const m = /([\d.]+)\s*([pnuµμmkKMG]?)/.exec(v || '');
    if (!m) return Number.MAX_VALUE;
    const scale: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
    return parseFloat(m[1]) * (scale[m[2]] ?? 1);
  }

  /** The package out of EasyEDA's footprint name: 0603, SOT-23-6, LQFN-56. */
  packageOf(name: string | null): string {
    const pkg = (name || '').split('_')[0];
    return /^[RCL]\d{4}$/.test(pkg) ? pkg.slice(1) : pkg;
  }

  /** What the bin is labelled with: the value if it has one, else the
   *  part number - nobody asks for "an IC", they ask for a CH340C. */
  headline(p: PartHeld): string {
    return (p.value || p.mpn || p.name || p.lcsc).replace(/(\d)u(?=[FHΩ])/g, '$1µ');
  }
  subline(p: PartHeld): string {
    return p.value ? (p.mpn || p.name || '') : (p.maker || p.category || p.branch || '');
  }

  // ---- which drawers are out ----

  private static KEY = 'redline.pcb.';
  private openSet = signal<Set<string>>(PartsDrawer.recallOpen());
  /** Drawers that have been out, so their trays are built. */
  visited = signal<Set<string>>(new Set(this.openSet()));

  /** Open drawers, kept in this browser. The tree used to keep the folded
   *  ones (`drawer-closed`, open by default); that becomes the open ones,
   *  unless it says nothing was ever folded - a cabinet with every drawer
   *  hanging out is not where to start. */
  private static recallOpen(): Set<string> {
    const read = (k: string): string[] | null => {
      try {
        const v = JSON.parse(localStorage.getItem(PartsDrawer.KEY + k) ?? 'null');
        return Array.isArray(v) ? v.map(String) : null;
      } catch { return null; }
    };
    const now = read('drawer-open');
    if (now) return new Set(now);
    const old = read('drawer-closed');
    if (!old) return new Set();
    try { localStorage.removeItem(PartsDrawer.KEY + 'drawer-closed'); } catch { /* private window */ }
    const ALL = ['ICs', 'Passives', 'Discretes', 'Electromechanical', 'Frequency', 'Displays', 'Other'];
    const closed = new Set(old.filter(k => !k.includes('/')));
    const open = ALL.filter(g => !closed.has(g));
    const out = closed.size ? new Set(open) : new Set<string>();
    PartsDrawer.keep(out);
    return out;
  }
  private static keep(s: Set<string>) {
    try { localStorage.setItem(PartsDrawer.KEY + 'drawer-open', JSON.stringify([...s])); }
    catch { /* private window */ }
  }

  isOpen(g: string) { return this.openSet().has(g); }
  anyOpen = computed(() => this.tree().some(g => this.openSet().has(g.name)));

  flip(g: string) {
    const s = new Set(this.openSet());
    if (s.has(g)) s.delete(g); else s.add(g);
    this.set(s);
  }
  setAll(open: boolean) {
    this.set(new Set(open ? this.tree().map(g => g.name) : []));
  }
  private set(s: Set<string>) {
    this.openSet.set(s);
    if ([...s].some(g => !this.visited().has(g))) this.visited.set(new Set([...this.visited(), ...s]));
    if (this.expanded() && ![...s].some(g => this.tree().find(t => t.name === g)
        ?.branches.some(b => b.parts.some(p => p.lcsc === this.expanded())))) this.expanded.set(null);
    PartsDrawer.keep(s);
  }

  private el = inject(ElementRef<HTMLElement>);
  private pulsing = effect(() => {
    const lcsc = this.pulse();
    const g = lcsc ? this.held().find(p => p.lcsc === lcsc)?.group || (lcsc ? 'Other' : null) : null;
    if (!lcsc || !g) return;
    untracked(() => { if (!this.isOpen(g)) this.flip(g); });
    setTimeout(() => this.el.nativeElement.querySelector(`[data-lcsc="${lcsc}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 200);
  });

  /** The LCSC number to the clipboard, without opening the part. */
  copied = signal<string | null>(null);
  copy(lcsc: string, ev: Event) {
    ev.stopPropagation();
    const done = () => { this.copied.set(lcsc); setTimeout(() => this.copied() === lcsc && this.copied.set(null), 1200); };
    try { navigator.clipboard.writeText(lcsc).then(done, done); } catch { done(); }
  }

  forgetIt(p: PartHeld, ev: Event) {
    ev.stopPropagation();
    this.forget.emit(p);
  }

  // ---- pins ----

  /** Parts whose pins are worth a diagram: chips, connectors, displays. */
  wired(p: PartHeld): boolean {
    return p.group === 'ICs' || p.group === 'Displays' || p.branch === 'Connectors';
  }

  private pins = signal<Record<string, Pin[] | 'loading' | 'error'>>({});
  expanded = signal<string | null>(null);

  loadPins(lcsc: string) {
    if (this.pins()[lcsc]) return;
    this.pins.update(m => ({ ...m, [lcsc]: 'loading' }));
    this.http.get<Pin[]>(`/api/parts/${encodeURIComponent(lcsc)}/pins`).subscribe({
      next: rows => this.pins.update(m => ({ ...m, [lcsc]: rows })),
      error: () => this.pins.update(m => ({ ...m, [lcsc]: 'error' })),
    });
  }
  pinCount(lcsc: string): string {
    const v = this.pins()[lcsc];
    return Array.isArray(v) ? `${v.length} pin${v.length === 1 ? '' : 's'}` : 'pins';
  }
  pinState(lcsc: string): 'loading' | 'error' | 'none' | 'ok' {
    const v = this.pins()[lcsc];
    if (!v || v === 'loading') return 'loading';
    if (v === 'error') return 'error';
    return v.length ? 'ok' : 'none';
  }
  togglePinout(lcsc: string, ev: Event) {
    ev.stopPropagation();
    this.loadPins(lcsc);
    this.expanded.set(this.expanded() === lcsc ? null : lcsc);
  }

  pinList(lcsc: string): Pin[] {
    const v = this.pins()[lcsc];
    return Array.isArray(v) ? v : [];
  }
  /** A header's pins are named by their numbers; that says nothing twice. */
  label(n: Pin): string { return n.name === n.number ? '' : n.name; }
  kind(n: Pin): 'nc' | 'pin' {
    return /^(NC|DNC|NONE)$/.test(n.name.toUpperCase().replace(/[^A-Z]/g, '')) ? 'nc' : 'pin';
  }

}
