import { Component, computed, input, output, signal, effect } from '@angular/core';
import { T, t } from './i18n';

/** A list's selection bar: "N selected", the list's own buttons, Clear.
 *
 *    <wb-selbar [count]="picked().size" (clear)="clearPicked()">
 *      <button class="tcv-btn" (click)="exportItems()">{{ 'Export' | t }}</button>
 *      <button class="tcv-btn tst-del" (click)="removeSelected()">{{ 'Delete' | t }}</button>
 *    </wb-selbar>
 *
 *  It floats over the list instead of taking a line above it, so a
 *  selection never moves what is being selected: the element is put last in
 *  the list's scrolling pane and has no height there - it sticks to the
 *  pane's bottom and the bar hangs above that point, centred. It slides up
 *  when the count leaves 0 and back down when it returns to it, showing the
 *  last count on the way out. */
@Component({
  selector: 'wb-selbar',
  imports: [T],
  host: { class: 'wb-selbar', '[attr.data-on]': 'count() ? 1 : null', '(pointerdown)': '$event.stopPropagation()' },
  template: `
<div class="wb-selbar-bar" role="toolbar" [attr.aria-label]="'Selection' | t" [attr.aria-hidden]="count() ? null : true" [attr.inert]="count() ? null : ''">
  <b class="wb-selbar-n" aria-live="polite">{{ label() }}</b>
  <span class="wb-selbar-sep" aria-hidden="true"></span>
  <ng-content />
  <button type="button" class="tcv-btn wb-selbar-clear" (click)="clear.emit()" [title]="'Clear the selection' | t">{{ 'Clear' | t }}</button>
</div>`,
  styles: [`
:host { position: sticky; bottom: 0; z-index: 30; flex: none; display: block; height: 0; margin: auto 0 0; pointer-events: none; }
.wb-selbar-bar { position: absolute; left: 50%; bottom: 12px; display: flex; align-items: center; gap: 6px; max-width: calc(100% - 24px);
  padding: 6px 6px 6px 14px; font-size: 12px; color: var(--ink); white-space: nowrap;
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px var(--shadow-soft);
  transform: translate(-50%, calc(100% + 16px)); opacity: 0; visibility: hidden;
  transition: transform 140ms ease-in, opacity 140ms ease-in, visibility 0s linear 140ms; }
:host([data-on]) .wb-selbar-bar { pointer-events: auto; transform: translate(-50%, 0); opacity: 1; visibility: visible;
  transition: transform 140ms ease-out, opacity 140ms ease-out, visibility 0s; }
.wb-selbar-n { font-weight: 600; font-variant-numeric: tabular-nums; }
.wb-selbar-sep { width: 1px; height: 18px; margin: 0 4px; background: var(--line); }
.wb-selbar-bar ::ng-deep .tcv-btn { padding: 3px 10px; font-size: 12px; }
@media (prefers-reduced-motion: reduce) { .wb-selbar-bar, :host([data-on]) .wb-selbar-bar { transition: none; } }
`],
})
export class SelectionBar {
  /** How many are selected; 0 hides the bar. */
  count = input(0);
  /** The text for the count, '{n} selected' by default. */
  text = input('{n} selected');
  clear = output<void>();

  /** The last count above 0, shown while the bar slides away. */
  private last = signal(0);
  constructor() { effect(() => { const n = this.count(); if (n) this.last.set(n); }); }
  label = computed(() => t(this.text()).replace('{n}', String(this.count() || this.last())));
}
