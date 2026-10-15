import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, input } from '@angular/core';
import { t } from './i18n';

/** The app's one loading placeholder: grey blocks shaped like what is on its
 *  way, with one soft sheen going over them, instead of a "Loading…" line.
 *
 *    @if (data(); as d) { <div class="wb-in">…the real thing…</div> }
 *    @else if (err()) { <p class="st-err">{{ err() }}</p> }
 *    @else { <wb-skel kind="tiles" [count]="6" /> }
 *
 *  kind   tiles  - a row of figure tiles (.st-tiles / .st-tile), [min] their least width
 *         rows   - list or table rows, [h] each row's height
 *         cards  - a grid of cards with a picture over two lines, [min] their least width
 *         chart  - a chart's plot area with faint grid lines, [h] its height
 *         text   - a few lines of text
 *         mini   - a sidebar card's figures: a line of three, a small chart, a line
 *         page   - a whole Settings page: its lead and [count] cards of tiles over a chart
 *         custom - the blocks inside it, for a shape of its own (a profile's
 *                  round picture): <i class="wb-sk"> each, sized by the page
 *  count  how many tiles, rows, cards or lines.
 *
 *  It shows nothing for the first 150 ms (a page that answers that fast
 *  does not flash), then fades in; it takes its room from the start, so
 *  nothing jumps when it comes in. Put .wb-in on what replaces it, so the
 *  real content fades in over 120 ms. */
@Component({
  selector: 'wb-skel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: { class: 'wb-skel', role: 'status', 'aria-busy': 'true', '[attr.aria-label]': 'label()',
          '[attr.data-kind]': 'kind()', '[style.--tcv-sk-min.px]': 'min()' },
  template: `
@switch (kind()) {
  @case ('tiles') {
    @for (i of n(); track i) { <div class="wb-sk-tile" [style.height.px]="h() || null"><i class="wb-sk" [style.width.%]="44 + (i * 17) % 30"></i><i class="wb-sk wb-sk-big" [style.width.%]="30 + (i * 23) % 35"></i><i class="wb-sk" [style.width.%]="50 + (i * 13) % 30"></i></div> }
  }
  @case ('rows') {
    @for (i of n(); track i) {
      <div class="wb-sk-row" [style.height.px]="h() || 30"><i class="wb-sk" [style.width.%]="26 + (i * 13) % 22"></i><i class="wb-sk" [style.width.%]="10 + (i * 7) % 8"></i>
        <i class="wb-sk" [style.width.%]="12 + (i * 11) % 12"></i><i class="wb-sk wb-sk-end" [style.width.%]="7 + (i * 5) % 6"></i></div>
    }
  }
  @case ('cards') {
    @for (i of n(); track i) { <div class="wb-sk-card"><i class="wb-sk wb-sk-pic"></i><i class="wb-sk" [style.width.%]="62 + (i * 19) % 30"></i><i class="wb-sk" [style.width.%]="30 + (i * 13) % 25"></i></div> }
  }
  @case ('chart') {
    <div class="wb-sk-chart" [style.height.px]="h() || 160">
      @for (i of [0, 1, 2, 3]; track i) { <span class="wb-sk-grid" [style.top]="'calc((100% - 20px) * ' + i + ' / 3 + 2px)'"><i class="wb-sk"></i></span> }
      <span class="wb-sk-axis"><i class="wb-sk"></i><i class="wb-sk"></i><i class="wb-sk"></i><i class="wb-sk"></i></span>
    </div>
  }
  @case ('mini') {
    <div class="wb-sk-mrow"><i class="wb-sk" style="width: 22%"></i><i class="wb-sk" style="width: 26%"></i><i class="wb-sk" style="width: 18%"></i></div>
    <i class="wb-sk wb-sk-mchart"></i>
    <div class="wb-sk-mrow"><i class="wb-sk" style="width: 58%"></i></div>
  }
  @case ('page') {
    <div class="wb-sk-lead"><i class="wb-sk" style="width: 92%"></i><i class="wb-sk" style="width: 61%"></i></div>
    @for (i of n(); track i) {
      <div class="wb-sk-pcard"><div class="wb-sk-phead"><i class="wb-sk" [style.width.%]="14 + (i * 7) % 9"></i><i class="wb-sk" [style.width.%]="24 + (i * 11) % 14"></i></div>
        <div class="wb-sk-pbody"><div class="wb-sk-ptiles">@for (j of [0, 1, 2, 3, 4]; track j) { <div class="wb-sk-tile"><i class="wb-sk" [style.width.%]="44 + (j * 17) % 30"></i><i class="wb-sk wb-sk-big" [style.width.%]="30 + (j * 23) % 35"></i><i class="wb-sk" [style.width.%]="50 + (j * 13) % 30"></i></div> }</div>
          <div class="wb-sk-chart" style="height: 150px">@for (k of [0, 1, 2, 3]; track k) { <span class="wb-sk-grid" [style.top]="'calc((100% - 20px) * ' + k + ' / 3 + 2px)'"><i class="wb-sk"></i></span> }</div></div></div>
    }
  }
  @case ('custom') { <ng-content /> }
  @default {
    @for (i of n(); track i) { <i class="wb-sk wb-sk-line" [style.width.%]="$last && count() > 1 ? 55 : 80 + (i * 11) % 20"></i> }
  }
}`,
  styles: `
.wb-skel { display: block; pointer-events: none; animation: tcv-sk-show .12s ease-out .15s both; }
.wb-sk { position: relative; display: block; height: 10px; border-radius: 4px; overflow: hidden;
  background: var(--hover); opacity: .55; }
.wb-sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ink) 16%, transparent), transparent);
  animation: tcv-sk-sheen 1.4s ease-in-out .15s infinite; }
.wb-skel[data-kind="tiles"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(var(--tcv-sk-min, 150px), 1fr)); gap: 0;
  margin-left: -10px; overflow: hidden; }
/* As the figures it stands for (settings.css .st-tile): plain, hairlines between. */
.wb-sk-tile { display: flex; flex-direction: column; justify-content: center; gap: 7px; height: 56px; padding: 0 10px;
  margin: -1px 0 0 -1px; border-left: 1px solid var(--line); border-top: 1px solid var(--line); }
.wb-sk-tile .wb-sk { height: 8px; }
.wb-sk-tile .wb-sk:last-child:not(.wb-sk-big) { height: 7px; opacity: .35; }
.wb-sk-tile .wb-sk-big { height: 13px; }
.wb-sk-row { display: flex; align-items: center; gap: 16px; padding: 0 10px; border-bottom: 1px solid var(--line); }
.wb-sk-row:last-child { border-bottom: 0; }
.wb-sk-row .wb-sk-end { margin-left: auto; }
.wb-skel[data-kind="cards"] { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--tcv-sk-min, 170px), 1fr)); gap: 10px; }
.wb-sk-card { display: flex; flex-direction: column; gap: 7px; padding: 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
.wb-sk-card .wb-sk-pic { width: 100%; height: auto; aspect-ratio: 4 / 3; margin-bottom: 3px; border-radius: 4px; }
.wb-sk-chart { position: relative; margin-left: 34px; }
.wb-sk-grid { position: absolute; left: 0; right: 0; height: 1px; background: var(--line); opacity: .6; }
.wb-sk-grid .wb-sk { position: absolute; right: calc(100% + 6px); top: -4px; width: 22px; height: 8px; }
.wb-sk-axis { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-between; }
.wb-sk-axis .wb-sk { width: 30px; height: 8px; }
.wb-skel[data-kind="text"] { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
.wb-skel[data-kind="page"] { display: flex; flex-direction: column; gap: 14px; }
.wb-sk-lead { display: flex; flex-direction: column; gap: 7px; max-width: 860px; }
.wb-sk-pcard { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
.wb-sk-phead { display: flex; align-items: center; gap: 12px; height: 32px; padding: 0 10px; border-bottom: 1px solid var(--line); }
.wb-sk-pbody { display: flex; flex-direction: column; gap: 14px; padding: 10px; }
.wb-sk-ptiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0; margin-left: -10px; overflow: hidden; }
.wb-skel[data-kind="mini"] { display: flex; flex-direction: column; gap: 5px; width: 100%; }
.wb-sk-mrow { display: flex; align-items: center; justify-content: space-between; height: 14px; }
.wb-sk-mrow .wb-sk { height: 8px; }
.wb-sk-mchart { height: 30px; border-radius: 3px; opacity: .3; }
/* Several skeletons standing for one section, one under the other. */
.wb-sk-stack { display: flex; flex-direction: column; gap: 12px; }
@keyframes tcv-sk-show { from { opacity: 0; } to { opacity: 1; } }
@keyframes tcv-sk-sheen { to { transform: translateX(100%); } }
.wb-in { animation: tcv-sk-in .12s ease-out both; }
@keyframes tcv-sk-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .wb-sk::after { animation: none; } .wb-in { animation: none; } }
`,
})
export class Skeleton {
  kind = input<'tiles' | 'rows' | 'cards' | 'chart' | 'text' | 'mini' | 'page' | 'custom'>('text');
  count = input(3);
  /** chart: its height; rows: each row's height; tiles: each tile's (px). */
  h = input(0);
  /** tiles and cards: their least width (px), as the grid they stand for. */
  min = input<number | null>(null);
  label = computed(() => t('Loading'));
  n = computed(() => Array.from({ length: Math.max(1, this.count()) }, (_, i) => i));
}
