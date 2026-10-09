import { Component, DestroyRef, ElementRef, computed, effect, inject, input, model, output, signal, untracked, viewChild } from '@angular/core';
import { T } from './i18n';
import type { LlmModel } from './rooms/commandcode';

/** The model chip and its list: the chat composer's model picker, and each
 *  job's model in Settings > LLM settings. One implementation, so the two
 *  look and behave the same: a chip with the model's name; a click opens a
 *  list with a search on top (every word typed must be in the name or the
 *  id), ↑↓ to move, ↵ to take the lit row (the first when none is),
 *  Esc or a click elsewhere to close. A row is the model's name, Claude when
 *  it is one, and its context size.
 *
 *  `providers` puts the provider switch at the top of the list (the chat,
 *  where the provider is the conversation's); the settings page has its own
 *  switch on the row and leaves it out. `fixed` places the list against the
 *  window, under the chip (or over it when there is no room below), moved
 *  to the page's body, for a chip inside a card that scrolls or clips; without it the list opens
 *  above the chip, as in the composer. The styles are the composer's own
 *  (styles.css, .tcv-cc-*). */
@Component({
  selector: 'app-model-picker',
  imports: [T],
  host: { class: 'tcv-cc-menuwrap tcv-mp' },
  template: `
<button type="button" class="tcv-cc-chip" #chip (click)="toggle(); $event.stopPropagation()" [class.on]="open()"
        [disabled]="disabled()" [title]="title()" [attr.aria-expanded]="open()" aria-haspopup="listbox"
        [attr.data-unset]="!selected() ? 1 : null">
  <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.bot" /></svg>
  <span>{{ label() }}</span>
  @if (tag()) { <em class="tcv-cc-tag tcv-mp-tag">{{ tag() }}</em> }
  <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.chevron" /></svg>
</button>
@if (open()) {
  <div class="tcv-cc-modelpop" #pop [class.tcv-mp-fixed]="fixed()" [style.left.px]="pos()?.left" [style.width.px]="pos()?.w" [style.top.px]="pos()?.top"
       [style.bottom.px]="pos()?.bottom" [style.max-height.px]="pos()?.maxH" (click)="$event.stopPropagation()">
    @if (providers().length) {
      <div class="tcv-cc-seg tcv-cc-seg-full">
        @for (p of providers(); track p.id) {
          <button [class.on]="p.id === provider()" (click)="providerPick.emit(p.id)">{{ p.name }}</button>
        }
      </div>
    }
    @if (heading()) { <div class="tcv-mp-head tcv-cc-dim">{{ heading() }}</div> }
    <label class="tcv-cc-search">
      <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.search" /></svg>
      <input #mq type="search" [placeholder]="'Find a model' | t" [value]="q()"
             (input)="q.set($any($event.target).value); act.set(-1)" (keydown)="key($event)">
    </label>
    <div class="tcv-cc-modellist" #list role="listbox">
      @if (dflt(); as f) {
        <button class="tcv-mp-default" [class.on]="f.on" [class.act]="act() === 0" [title]="f.title" role="option"
                [attr.aria-selected]="f.on" (click)="takeDefault()">
          <span class="tcv-cc-modelname">{{ 'Default' | t }} · {{ f.label }}</span>
          <span class="tcv-cc-tag">{{ f.provider }}</span>
        </button>
      }
      @for (x of shown(); track x.id; let i = $index) {
        <button [class.on]="x.id === selected()" [class.act]="i + off() === act()" [title]="x.id" role="option"
                [attr.aria-selected]="x.id === selected()" (click)="take(x.id)" (mousemove)="act() !== -1 && act.set(i + off())">
          <span class="tcv-cc-modelname">{{ x.name }}</span>
          @if (vision() && x.vision) { <span class="tcv-cc-dim" [title]="'read images' | t">🖼</span> }
          @if (x.anthropic) { <span class="tcv-cc-tag">Claude</span> }
          @if (x.context) { <span class="tcv-cc-dim">{{ ctx(x.context) }}</span> }
        </button>
      } @empty {
        <p class="tcv-cc-dim tcv-cc-pad">{{ models().length ? ('No model matches.' | t) : ('Loading…' | t) }}</p>
      }
    </div>
  </div>
}`,
})
export class ModelPicker {
  /** The provider's models, as /api/llm/models gives them. */
  models = input<LlmModel[]>([]);
  /** The model chosen now ('' for none). */
  selected = input('');
  disabled = input(false);
  /** The chip's tooltip. */
  title = input('');
  /** What the chip says while no model is chosen. */
  placeholder = input('');
  /** The provider switch inside the list, and which one is on. */
  providers = input<{ id: string; name: string }[]>([]);
  provider = input('');
  /** The list against the window (see above). */
  fixed = input(false);
  /** Mark the models that read images. */
  vision = input(false);
  /** A tag on the chip (the provider, where the chip stands apart from its switch). */
  tag = input('');
  /** A line over the search: whose list this is. */
  heading = input('');
  /** The job's default as the list's first row ("Default · Qwen 3.8 Flash"),
   *  marked when it is the choice now; picking it emits `pickDefault`. */
  fallback = input<{ label: string; provider: string; title: string; on: boolean } | null>(null);
  pickDefault = output<void>();
  /** Whether the list is open: two-way, so the owner can open or close it too. */
  open = model(false);
  /** A model was picked (the list closes by itself). */
  pick = output<string>();
  /** A provider was picked in the list's switch. */
  providerPick = output<string>();

  readonly I = I;
  q = signal('');
  /** The row lit by ↑↓ (-1: none; ↵ then takes the first). */
  act = signal(-1);
  pos = signal<{ left: number; w: number; top: number | null; bottom: number | null; maxH: number } | null>(null);
  private host = inject(ElementRef<HTMLElement>);
  private chip = viewChild<ElementRef<HTMLButtonElement>>('chip');
  private mq = viewChild<ElementRef<HTMLInputElement>>('mq');
  private list = viewChild<ElementRef<HTMLDivElement>>('list');
  private pop = viewChild<ElementRef<HTMLDivElement>>('pop');

  shown = computed(() => {
    const words = this.q().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.models();
    return words.length ? rows.filter(m => words.every(w => (m.name + ' ' + m.id).toLowerCase().includes(w))) : rows;
  });
  /** The default's row before the models, while the search matches it (the arrow keys count it). */
  dflt = computed(() => {
    const f = this.fallback(), words = this.q().toLowerCase().split(/\s+/).filter(Boolean);
    return f && words.every(w => (f.label + ' ' + f.title).toLowerCase().includes(w)) ? f : null;
  });
  off = computed(() => this.dflt() ? 1 : 0);
  label = computed(() => {
    const id = this.selected();
    if (!id && this.placeholder()) return this.placeholder();
    const m = this.models().find(x => x.id === id);
    return m?.name ?? short(id || '…');
  });

  constructor() {
    // Opened (by the chip or by the owner): an empty search, focused, and
    // for a fixed list its place.
    effect(() => {
      if (!this.open()) { this.pos.set(null); return; }
      untracked(() => {
        this.q.set('');
        this.act.set(-1);
        this.place();
        setTimeout(() => this.mq()?.nativeElement.focus());
      });
    });
    // A fixed list goes to the page's body: a card that contains its
    // layout or scrolls (Settings) would otherwise hold it and cut it off.
    // Angular still owns it, and takes it away from there when it closes.
    effect(() => {
      const el = this.pop()?.nativeElement;
      if (el && this.fixed() && el.parentElement !== document.body) document.body.appendChild(el);
    });
    // A click anywhere outside closes it. In the capture phase, so a
    // neighbour that stops its clicks (another picker's chip) still does.
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (this.open() && !this.host.nativeElement.contains(t) && !this.pop()?.nativeElement.contains(t)) this.open.set(false);
    };
    const follow = () => { if (this.open()) this.place(); };
    document.addEventListener('click', outside, true);
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('click', outside, true);
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, true);
    });
  }

  toggle() { this.open.update(v => !v); }

  takeDefault() {
    this.pickDefault.emit();
    this.open.set(false);
  }

  take(id: string) {
    this.pick.emit(id);
    this.open.set(false);
  }

  key(e: KeyboardEvent) {
    const off = this.off(), n = this.shown().length + off;
    if (e.key === 'Escape') { e.preventDefault(); this.open.set(false); this.chip()?.nativeElement.focus(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const i = this.act();
      if (off && i === 0) { this.takeDefault(); return; }
      const m = this.shown()[i < 0 ? 0 : i - off];
      if (m) this.take(m.id);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
      e.preventDefault();
      const i = this.act();
      this.act.set(e.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n - 1 : i - 1));
      setTimeout(() => this.list()?.nativeElement.children[this.act()]?.scrollIntoView({ block: 'nearest' }));
    }
  }

  /** A fixed list's place: under the chip, or over it when the window has
   *  more room there; kept inside the window. */
  private place() {
    const el = this.chip()?.nativeElement;
    if (!this.fixed() || !el) { this.pos.set(null); return; }
    const r = el.getBoundingClientRect();
    const w = Math.min(Math.max(340, r.width), innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const below = innerHeight - r.bottom - 14, above = r.top - 14;
    const down = below >= 360 || below >= above;
    this.pos.set(down ? { left, w, top: r.bottom + 6, bottom: null, maxH: Math.min(420, below) }
                      : { left, w, top: null, bottom: innerHeight - r.top + 6, maxH: Math.min(420, above) });
  }

  ctx(n: number) { return n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}k`; }
}

/** A model id without its vendor: "Qwen/Qwen3.8-Flash" -> "Qwen3.8-Flash". */
function short(m: string) { return m.includes('/') ? m.split('/').pop()! : m; }

const I = {
  bot: 'M5 8h14v10H5z M12 8V5 M9 12.5h.01 M15 12.5h.01 M9.5 15.5h5 M3 12v3 M21 12v3',
  chevron: 'M7 10l5 5 5-5',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4.2-4.2',
};
