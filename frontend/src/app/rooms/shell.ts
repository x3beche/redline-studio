import { Component, input, output } from '@angular/core';

/** The frame a room lives in.
 *
 *  A room covers the two right-hand columns and wears the same panel the
 *  3D room does, so the open tab reads as its top edge rather than as a
 *  button floating over it. Everything above the viewer's own chrome,
 *  which paints as high as z-index 200 of its own accord.
 *
 *  While a room is empty this carries what it is for and what has to
 *  exist before it can open. When one is built, its component keeps the
 *  frame and puts its own thing inside.
 */
@Component({
  selector: 'app-room-shell',
  template: `
<div class="tcv-room absolute inset-0 overflow-y-auto">
  <div class="tcv-card mx-auto mt-10 max-w-xl p-5">
    <h1 class="brand-name mb-2">{{ title() }}</h1>
    <p class="mb-4 text-[13px]" style="color: var(--ink)">{{ blurb() }}</p>
    @if (needs().length) {
      <p class="tcv-label mb-1.5">Not here yet. What it needs first</p>
      <ul class="mb-4 text-[12px] leading-relaxed" style="color: var(--ink-dim)">
        @for (n of needs(); track n) {
          <li class="mb-1">— {{ n }}</li>
        }
      </ul>
    }
    <button (click)="leave.emit()" class="tcv-btn tcv-btn-accent px-3 py-1">
      back to 3D Drawing
    </button>
  </div>
</div>`,
})
export class RoomShell {
  title = input.required<string>();
  blurb = input.required<string>();
  needs = input<string[]>([]);
  leave = output<void>();
}
