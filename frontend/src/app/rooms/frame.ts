import {
  AfterViewInit, Component, ElementRef, OnDestroy, effect, inject, input, output, signal,
  viewChild,
} from '@angular/core';
import { LogLine } from '../api';
import { Selection } from '../selection';

/** The one layout every room shares.
 *
 *  The 3D room is the viewer's: a toolbar of icon buttons across the top
 *  with the pen at its far end, a panel of tabs down the left, the view
 *  beside it, and the log as a band under the view. A room built on this
 *  looks the same because it is the same markup - the viewer's own
 *  classes, not a copy of how they look - so a change to the 3D room's
 *  chrome reaches every room at once.
 *
 *  What goes in each place is projected:
 *    [bar]    the toolbar's buttons, left to right (app-tool, separators)
 *    [barEnd] the far end of the toolbar - the pen, the drawing tools
 *    [side]   the open tab's content
 *    [view]   the thing being looked at
 *    [corner] a selector in the view's top right, like the 3D room's "All"
 *    [logSide] a narrow column inside the log card, folded with it
 */
@Component({
  selector: 'app-room-frame',
  imports: [],
  host: { class: 'tcv-frame' },
  template: `
<div class="tcv_cad_toolbar tcv_round tcv-frame-bar">
  <ng-content select="[bar]"></ng-content>
  <span class="tcv-frame-end"><ng-content select="[barEnd]"></ng-content></span>
</div>
<div class="tcv-frame-body">
  <div class="tcv_round tcv-frame-side">
    <div class="tcv_tabnav">
      @for (t of tabs(); track t; let first = $first) {
        <input type="button" [value]="labels()[t] || t" (click)="tabChange.emit(t)"
               class="tcv_tab"
               [class.tcv_tab-left]="first" [class.tcv_tab-right]="!first"
               [class.tcv_tab-selected]="t === tab()"
               [class.tcv_tab-unselected]="t !== tab()">
      }
    </div>
    <div class="tcv-frame-pane"><ng-content select="[side]"></ng-content></div>
    <!-- The note being worked on docks here, under the tabs, as it docks
         under the tree in the 3D room: the page moves the same card in. -->
    <div #taskSlot class="tcv-frame-task"></div>
  </div>
  <div class="tcv-frame-view">
    <ng-content select="[view]"></ng-content>
    <div class="tcv-frame-corner"><ng-content select="[corner]"></ng-content></div>
  </div>
  <div class="tcv-log tcv-panel rounded" style="border: 1px solid var(--line)">
    <div class="flex items-center gap-2 px-2.5 py-1">
      <button (click)="toggleLog()" class="tcv-chip">
        {{ logOpen() ? '▾' : '▸' }} log
      </button>
      <span class="mono text-[10px]" style="color: var(--ink-dim)">
        {{ log().length }} lines
      </span>
      <ng-content select="[logHead]"></ng-content>
    </div>
    <!-- Open, the lines take the width; whatever the room keeps beside
         its log (what the runs cost) is a narrow column on the right, and
         folds away with it. -->
    <div class="tcv-log-body" [class.hidden]="!logOpen()">
      <div #logBox class="tcv-scroll mono min-w-0 flex-1 overflow-y-auto px-2.5 pb-2 text-[11px]">
        @for (l of log(); track l._id) {
          <div class="flex gap-2 leading-snug">
            <span class="shrink-0" style="color: var(--line)">{{ l.at.slice(11, 19) }}</span>
            <span [style.color]="levelColor(l.level)">{{ l.text }}</span>
          </div>
        } @empty {
          <div style="color: var(--ink-dim)">no activity yet</div>
        }
      </div>
      <div class="tcv-log-side tcv-scroll"><ng-content select="[logSide]"></ng-content></div>
    </div>
  </div>
</div>`,
})
export class RoomFrame implements AfterViewInit, OnDestroy {
  private picked = inject(Selection);
  private taskSlot = viewChild.required<ElementRef<HTMLElement>>('taskSlot');

  ngAfterViewInit() { this.picked.taskSlot.set(this.taskSlot().nativeElement); }

  ngOnDestroy() {
    if (this.picked.taskSlot() === this.taskSlot().nativeElement) this.picked.taskSlot.set(null);
  }

  /** Which room this is: the log's fold is remembered per room. */
  room = input.required<string>();
  tabs = input.required<readonly string[]>();
  tab = input.required<string>();
  /** What a tab says, where that is not its key. */
  labels = input<Record<string, string>>({});
  tabChange = output<string>();
  /** The room's own lines - never another room's. */
  log = input<LogLine[]>([]);

  logOpen = signal(true);
  private logBox = viewChild<ElementRef<HTMLDivElement>>('logBox');
  private lastLine: string | undefined;

  constructor() {
    effect(() => {
      try { this.logOpen.set(localStorage.getItem(`x3.${this.room()}.log`) !== ''); }
      catch { /* private window */ }
    });
    // A new last line scrolls the band down to it; reading back up is not
    // interrupted by a poll that brought nothing new.
    effect(() => {
      const rows = this.log();
      const last = rows[rows.length - 1]?._id;
      if (last !== this.lastLine) {
        this.lastLine = last;
        setTimeout(() => this.scrollLog(), 30);
      }
    });
  }

  toggleLog() {
    this.logOpen.update(v => !v);
    try { localStorage.setItem(`x3.${this.room()}.log`, this.logOpen() ? '1' : ''); }
    catch { /* private window */ }
    if (this.logOpen()) setTimeout(() => this.scrollLog(), 30);
  }

  private scrollLog() {
    const box = this.logBox()?.nativeElement;
    if (box) box.scrollTop = box.scrollHeight;
  }

  levelColor(l: LogLine['level']): string {
    return l === 'error' ? 'var(--danger)'
      : l === 'warn' ? 'var(--warn)'
      : l === 'done' ? 'var(--ok)'
      : l === 'work' ? 'var(--accent)' : 'var(--ink-dim)';
  }
}

/** One of the toolbar's icon buttons, in the viewer's own markup: a 30 px
 *  square with the glyph as a background image, its name on hover, and
 *  the viewer's pressed frame while it is the one that is on. With an
 *  `href` it is a download rather than a toggle. */
@Component({
  selector: 'app-tool',
  host: { class: 'contents' },
  template: `
<span class="tcv_tooltip" [attr.data-tooltip]="tip()">
  <span class="tcv_button_frame" [class.tcv_btn_click2]="on()">
    @if (href(); as h) {
      <a class="tcv_reset tcv_btn tcv-ico" [class]="icon()" [href]="h" download
         [attr.aria-label]="tip()"></a>
    } @else {
      <input type="button" class="tcv_reset tcv_btn tcv-ico" [class]="icon()"
             [disabled]="disabled()" (click)="press.emit()" [attr.aria-label]="tip()">
    }
  </span>
</span>`,
})
export class ToolButton {
  icon = input.required<string>();
  tip = input.required<string>();
  on = input(false);
  disabled = input(false);
  href = input<string | null>(null);
  press = output<void>();
}
