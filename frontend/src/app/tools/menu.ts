import { Component, signal } from '@angular/core';
import { ToolModal } from './modal';
import { TOOLS, ToolDef } from './registry';

/** "Tools" at the right end of the top bar: the list drops down on hover (or a
 *  click, on a touch screen), and the chosen tool opens in its modal. */
@Component({
  selector: 'app-tools-menu',
  imports: [ToolModal],
  host: { class: 'relative flex items-center' },
  template: `
<button class="tcv-tab tcv-tools-btn" [attr.data-open]="open() ? 1 : null"
        (mouseenter)="show(true)" (mouseleave)="show(false)"
        (click)="open.set(!open())" aria-haspopup="menu" [attr.aria-expanded]="open()">
  Tools <span class="tcv-tools-caret">▾</span>
</button>
@if (open()) {
  <div class="tcv-menu" role="menu" (mouseenter)="show(true)" (mouseleave)="show(false)">
    @for (t of pages; track t.id) {
      <button class="tcv-menu-item" role="menuitem" (click)="pick(t)">
        <span class="tcv-menu-name">{{ t.name }}</span>
        <span class="tcv-menu-blurb">{{ t.blurb }}</span>
      </button>
    }
  </div>
}
@if (page(); as t) {
  <app-tool-modal [tool]="t" (close)="page.set(null)" />
}`,
})
export class ToolsMenu {
  readonly pages = TOOLS;
  open = signal(false);
  page = signal<ToolDef | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Close a moment after the mouse leaves, so the way down from the
   *  button to the list does not shut it. */
  show(on: boolean) {
    clearTimeout(this.timer);
    if (on) this.open.set(true);
    else this.timer = setTimeout(() => this.open.set(false), 180);
  }

  pick(t: ToolDef) {
    this.open.set(false);
    this.page.set(t);
  }
}
