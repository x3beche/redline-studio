import { Component, ElementRef, HostListener, Injectable, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { T } from './i18n';

/** Every ISO 639-1 language, from the server's one list
 *  (backend/tgbot/languages.py, GET /api/telegram/languages): the bot
 *  profile's languages and a person's question language pick from it. */
export interface Lang { code: string; name: string; native: string }

@Injectable({ providedIn: 'root' })
export class Langs {
  private http = inject(HttpClient);
  list = signal<Lang[]>([]);
  private asked = false;
  load() {
    if (this.asked) return;
    this.asked = true;
    this.http.get<Lang[]>('/api/telegram/languages').subscribe({ next: l => this.list.set(l), error: () => { this.asked = false; } });
  }
  label(code: string | null | undefined): string {
    if (!code || code === 'default') return 'Default (all languages)';
    const l = this.list().find(x => x.code === code);
    return l ? `${l.native} · ${l.code}` : code;
  }
}

/** A search box over the languages: native name, English name or code.
 *  Picks one; `exclude` hides those already chosen. */
@Component({
  selector: 'app-tg-lang-picker',
  imports: [T],
  styleUrls: ['./settings.css', './telegram-settings.css'],
  template: `
<div class="tg-lp">
  <button [class]="chip() ? 'tcv-chip tg-lp-btn' : 'tcv-btn tcv-files-btn'" [class.tcv-chip-accent]="accent()"
          [style.max-width]="narrow() ? '6.5rem' : null" [disabled]="disabled()" (click)="toggle()"
          [attr.title]="hint() || null" [attr.aria-label]="hint() || null" aria-haspopup="listbox" [attr.aria-expanded]="open()"
          >{{ (label() || 'Add language') | t }} ▾</button>
  @if (open()) {
    <div class="tg-lp-pop" [class.tg-lp-fixed]="!!pos()" [style.top]="pos()?.top" [style.bottom]="pos()?.bottom"
         [style.left]="pos()?.left">
      <input class="st-in" #q [placeholder]="'Search: Deutsch, ja, Arabic…' | t" [value]="query()" (input)="query.set($any($event.target).value)"
             (keydown.enter)="first() && pick(first()!.code)" (keydown.escape)="open.set(false)">
      <div class="tg-lp-list">
        @if (top()) {
          <button class="tg-lp-row" (click)="pick(top()!)"><b>{{ topLabel() | t }}</b></button>
        }
        @for (l of shown(); track l.code) {
          <button class="tg-lp-row" [attr.data-on]="l.code === current() ? 1 : null" (click)="pick(l.code)">
            <b>{{ l.native }}</b><span>{{ l.name }}</span><code>{{ l.code }}</code></button>
        } @empty { <span class="st-sub tg-lp-none">{{ 'No language matches.' | t }}</span> }
      </div>
    </div>
  }
</div>`,
})
export class TgLangPicker {
  private langs = inject(Langs);
  private el = inject(ElementRef);
  label = input<string>('');
  current = input<string | null>(null);
  exclude = input<string[]>([]);
  /** A first row above the list - "default" or "en" - with its own label. */
  top = input<string | null>(null);
  topLabel = input<string>('');
  disabled = input(false);
  /** As a chip among chips (the editor's reading language), accented while on. */
  chip = input(false);
  accent = input(false);
  /** Narrow: the label is cut short (a header where other chips must fit). */
  narrow = input(false);
  /** Where the list opens: 'up' above the button (at the foot of a panel),
   *  'right' aligned to its right edge (at the right of a header). Placed
   *  on the page itself, kept inside the window: a narrow panel neither
   *  clips it nor scrolls sideways to make room. */
  place = input<string>('');
  pos = signal<{ top: string; bottom: string; left: string } | null>(null);
  hint = input<string>('');
  picked = output<string>();
  open = signal(false);
  query = signal('');

  constructor() { this.langs.load(); }

  shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    const ex = new Set(this.exclude());
    return this.langs.list().filter(l => !ex.has(l.code)
      && (!q || l.code === q || l.native.toLowerCase().includes(q) || l.name.toLowerCase().includes(q)))
      .sort((a, b) => (a.code === q ? -1 : 0) - (b.code === q ? -1 : 0));
  });
  first() { return this.shown()[0] ?? null; }
  toggle() {
    this.open.set(!this.open());
    this.query.set('');
    this.pos.set(this.open() && this.place() ? this.placed() : null);
    if (this.open()) setTimeout(() => (this.el.nativeElement as HTMLElement).querySelector('input')?.focus());
  }
  private placed() {
    const b = ((this.el.nativeElement as HTMLElement).querySelector('button') as HTMLElement).getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 16), up = this.place().includes('up');
    const left = this.place().includes('right') ? b.right - w : b.left;
    return {
      top: up ? 'auto' : `${b.bottom + 4}px`,
      bottom: up ? `${window.innerHeight - b.top + 4}px` : 'auto',
      left: `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`,
    };
  }
  pick(code: string) { this.open.set(false); this.picked.emit(code); }

  @HostListener('window:resize')
  resized() { if (this.open()) this.open.set(false); }

  @HostListener('document:click', ['$event'])
  away(e: MouseEvent) { if (this.open() && !(this.el.nativeElement as HTMLElement).contains(e.target as Node)) this.open.set(false); }
}
