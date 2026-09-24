import { Component, computed, input } from '@angular/core';

/** Small charts for a tab 300 px wide: bars and columns.
 *
 *  Each is one measure in the room's one accent colour - a magnitude or a
 *  change over time, never identity - so nothing here asks the eye to
 *  tell two hues apart; what a mark is, its label says. Labels and values
 *  wear the text colours, never the mark's. Every mark carries its exact
 *  figure on hover, and the hover target is the whole row or column, not
 *  the few pixels of the mark.
 */

export interface MiniRow { label: string; value: number; tip?: string }

/** Horizontal bars, largest first: how much of each. */
@Component({
  selector: 'app-mini-bars',
  template: `
@for (r of rows(); track r.label) {
  <div class="tcv-mbar" [title]="r.tip ?? (r.label + ': ' + fmt()(r.value))">
    <span class="tcv-mbar-label">{{ r.label }}</span>
    <span class="tcv-mbar-track">
      <span class="tcv-mbar-fill" [style.width.%]="pct(r.value)"></span>
    </span>
    <span class="tcv-mbar-value mono">{{ fmt()(r.value) }}</span>
  </div>
} @empty {
  <div class="tcv-mchart-empty">{{ empty() }}</div>
}`,
})
export class MiniBars {
  rows = input.required<MiniRow[]>();
  fmt = input<(v: number) => string>(v => String(v));
  empty = input('nothing yet');
  private max = computed(() => Math.max(1, ...this.rows().map(r => r.value)));
  /** Never a zero-width sliver for a real value: a bar that exists shows. */
  pct(v: number): number { return v > 0 ? Math.max(2, 100 * v / this.max()) : 0; }
}

/** Columns over ordered bins: how the values spread. */
@Component({
  selector: 'app-mini-columns',
  template: `
<div class="tcv-mcols">
  @for (r of rows(); track r.label) {
    <div class="tcv-mcol" [title]="r.tip ?? (r.label + ': ' + r.value)">
      <span class="tcv-mcol-value mono">{{ r.value }}</span>
      <span class="tcv-mcol-well">
        <span class="tcv-mcol-fill" [style.height.%]="pct(r.value)"></span>
      </span>
      <span class="tcv-mcol-label mono">{{ r.label }}</span>
    </div>
  }
</div>`,
})
export class MiniColumns {
  rows = input.required<MiniRow[]>();
  private max = computed(() => Math.max(1, ...this.rows().map(r => r.value)));
  pct(v: number): number { return v > 0 ? Math.max(3, 100 * v / this.max()) : 0; }
}
