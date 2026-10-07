import { Component, ElementRef, OnDestroy, ViewEncapsulation, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { T } from './i18n';
import { Selection } from './selection';
import { Prefs } from './preferences';
import { TopBar } from './topbar';
import { Workspace } from './workspaces';
import { AgentThreads } from './rooms/agent-thread';

/** "More" at the end of the top bar: the tabs that did not fit, then the
 *  ones hidden in Settings > Top bar, so none is ever out of reach. Lit
 *  like an open tab when the room on screen is one of them.
 *
 *  Its stylesheet (topbar.css) is not encapsulated: it also styles the
 *  tabs the shell draws (app.ts), and this is always in the bar to bring it. */
@Component({
  selector: 'app-topbar-more',
  imports: [NgTemplateOutlet, T],
  encapsulation: ViewEncapsulation.None,
  styleUrl: './topbar.css',
  template: `
@if (bar.moreNeeded()) {
  <button #btn type="button" class="tcv-tab tb-more" data-tb-more
          [attr.data-on]="inMore() ? 1 : null" [attr.aria-current]="inMore() ? 'page' : null"
          aria-haspopup="menu" [attr.aria-expanded]="open()"
          [title]="inMore() ? ('More tabs' | t) + ' · ' + (here()?.label ?? '' | t) : ('More tabs' | t)"
          (click)="toggle()">{{ 'More' | t }} <span class="tb-more-dots" aria-hidden="true">⋯</span>@if (chatUnread(); as n) {<span class="tcv-tab-unread">{{ n }}</span>}</button>
}
@if (open()) {
  <div class="tb-menu" role="menu" [style.top.px]="at().top" [style.left.px]="at().left" [style.right.px]="at().right" (keydown)="key($event)">
    @for (w of bar.overflow(); track w.id) { <ng-container *ngTemplateOutlet="row; context: { $implicit: w }" /> }
    @if (bar.hiddenTabs().length) {
      <div class="tb-menu-head">{{ 'Hidden' | t }}</div>
      @for (w of bar.hiddenTabs(); track w.id) { <ng-container *ngTemplateOutlet="row; context: { $implicit: w }" /> }
    }
    <button type="button" role="menuitem" class="tb-menu-item tb-menu-edit" (click)="customize()">
      <span class="tb-menu-ico" aria-hidden="true">⚙</span><span>{{ 'Customize the top bar…' | t }}</span>
    </button>
  </div>
}
<ng-template #row let-w>
  <button type="button" role="menuitem" class="tb-menu-item" [attr.data-on]="picked.room() === w.id ? 1 : null"
          [attr.aria-current]="picked.room() === w.id ? 'page' : null" [title]="bar.title(w)" (click)="go(w)">
    <svg class="tb-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="bar.icon(w.id)"/></svg>
    <span>{{ w.label | t }}</span>
    @if (w.id === 'commandcode' && threads.total()) { <span class="tcv-tab-unread">{{ threads.total() }}</span> }
    @if (picked.room() === w.id) { <em>● {{ 'open' | t }}</em> }
  </button>
</ng-template>`,
})
export class TopbarMore implements OnDestroy {
  bar = inject(TopBar);
  picked = inject(Selection);
  /** Chat's unread count, on More while Chat is in it (a phone's bar). */
  threads = inject(AgentThreads);
  chatUnread = computed(() => [...this.bar.overflow(), ...this.bar.hiddenTabs()].some(w => w.id === 'commandcode')
    ? this.threads.total() : 0);
  private prefs = inject(Prefs);
  private host = inject(ElementRef).nativeElement as HTMLElement;
  private btn = viewChild<ElementRef<HTMLElement>>('btn');

  open = signal(false);
  at = signal<{ top: number; left: number | null; right: number | null }>({ top: 0, left: null, right: 0 });
  here = computed(() => [...this.bar.overflow(), ...this.bar.hiddenTabs()].find(w => w.id === this.picked.room()) ?? null);
  inMore = computed(() => !!this.here());

  /** Shut when the room changes, or when More goes away. */
  private shut = effect(() => {
    this.picked.room();
    this.bar.moreNeeded();
    untracked(() => this.open.set(false));
  });

  private outside = (e: Event) => {
    if (!this.open()) return;
    const t = e.target as Node;
    if (!this.host.contains(t)) this.open.set(false);
  };
  private esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.open()) { this.open.set(false); this.btn()?.nativeElement.focus(); }
  };
  private away = () => this.open.set(false);

  constructor() {
    document.addEventListener('pointerdown', this.outside, true);
    window.addEventListener('keydown', this.esc);
    window.addEventListener('resize', this.away);
  }
  ngOnDestroy() {
    document.removeEventListener('pointerdown', this.outside, true);
    window.removeEventListener('keydown', this.esc);
    window.removeEventListener('resize', this.away);
  }

  toggle() {
    if (this.open()) { this.open.set(false); return; }
    // Fixed to the screen, under the button: the bar scrolls on a phone and
    // would clip a menu hung inside it.
    const r = this.btn()?.nativeElement.getBoundingClientRect();
    // Hung from its right edge on the right half of the screen, from its
    // left edge on the left half (a phone's narrow bar), so it stays on screen.
    if (r) {
      const top = Math.round(r.bottom + 4);
      this.at.set(r.left + r.width / 2 > window.innerWidth / 2
        ? { top, left: null, right: Math.max(8, Math.round(window.innerWidth - r.right)) }
        : { top, left: Math.max(8, Math.round(r.left)), right: null });
    }
    this.open.set(true);
    requestAnimationFrame(() => this.host.querySelector<HTMLElement>('.tb-menu .tb-menu-item')?.focus());
  }
  go(w: Workspace) { this.picked.room.set(w.id); this.open.set(false); }
  customize() { this.prefs.open.set('topbar'); this.open.set(false); }

  /** Up and down through the menu. */
  key(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...this.host.querySelectorAll<HTMLElement>('.tb-menu .tb-menu-item')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
}
