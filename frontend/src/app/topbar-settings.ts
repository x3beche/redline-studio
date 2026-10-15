import { Component, computed, inject, signal } from '@angular/core';
import { T } from './i18n';
import { Selection } from './selection';
import { CcTabUsage } from './cc-usage';
import { BELL, CC_TAB_STYLES, CC_TAB_WINDOWS, GAP, MORE, SETTINGS, TOPBAR_DISPLAYS, TopBar, TopbarDisplay } from './topbar';

/** Settings > Top bar: which tabs the bar shows and in what order, and how
 *  they are drawn (topbar.ts keeps it). Drag a row, or use its arrows -
 *  Alt+↑/↓ on a focused row does the same. More is a row too - where its
 *  button stands - but cannot be hidden. The notification bell and Settings
 *  are rows like the tabs: hidden, they stay in the menu under your name,
 *  under More and in Ctrl+K. */
@Component({
  selector: 'app-topbar-settings',
  imports: [T, CcTabUsage],
  styleUrl: './settings.css',
  styles: [`
    .tb-prev { display: flex; align-items: flex-end; gap: 4px; min-width: 0; overflow-x: auto; overflow-y: hidden;
      scrollbar-width: thin; scrollbar-color: var(--scroll-thumb) transparent;
      padding: 8px 8px 0; background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px 5px 0 0; }
    .tb-prev .tcv-tab { flex: none; cursor: default; }
    .tb-prev-floor { height: 10px; margin-top: -1px; background: var(--surface); border: 1px solid var(--line);
      border-top-color: var(--line); border-radius: 0 0 5px 5px; }
    .tb-prev-gap { flex: 1 1 24px; min-width: 24px; align-self: stretch; margin-bottom: 6px;
      border-bottom: 1px dashed var(--line); }
    .tb-prev-end { margin-left: auto; }
    .tb-prev-gap + .tb-prev-end { margin-left: 0; }
    .tb-prev-n { margin-left: 4px; font: 600 10.5px/1 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink); }
    .tb-rows { display: flex; flex-direction: column; }
    .tb-cc-opts { grid-column: 4 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding-bottom: 2px; }
    .tb-cc-hint { flex-basis: 100%; font-size: 10.5px; color: var(--ink-dim); }
    .tb-row { display: grid; grid-template-columns: 18px 30px 26px minmax(0, 1fr) auto auto; align-items: center; gap: 8px;
      padding: 6px 10px; border-top: 1px solid var(--line); outline: none; background: var(--surface); }
    .tb-row:first-child { border-top: 0; }
    .tb-row:focus-visible { box-shadow: inset 2px 0 0 var(--accent); background: var(--surface-2); }
    .tb-row[data-off] .tb-row-name { opacity: .5; }
    .tb-row[data-drag] { opacity: .45; }
    .tb-row[data-drop="before"] { box-shadow: inset 0 2px 0 var(--accent); }
    .tb-row[data-drop="after"] { box-shadow: inset 0 -2px 0 var(--accent); }
    .tb-handle { cursor: grab; color: var(--ink-dim); font-size: 13px; line-height: 1; text-align: center; user-select: none; }
    .tb-row-ico.tb-row-more { font-size: 15px; letter-spacing: 0; }
    .tb-more-n { justify-self: start; }
    .tb-row > .tcv-switch { justify-self: center; }
    .tb-sw-none { width: 30px; }
    .tb-more-n[data-tone="dim"] { opacity: .6; }
    .tb-row-ico { width: 26px; height: 26px; display: grid; place-items: center; border: 1px solid var(--line);
      border-radius: 5px; background: var(--surface-2); color: var(--ink-dim); }
    .tb-row-ico .tb-ico, .tb-arrow svg { display: block; width: 14px; height: 14px; margin: 0; fill: none; stroke: currentColor;
      stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .tb-row-name { min-width: 0; display: flex; flex-direction: column; }
    .tb-row-name b { font-size: 12.5px; font-weight: 500; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tb-row-name span { font-size: 11px; color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tb-arrows { display: flex; gap: 2px; }
    .tb-arrow { width: 26px; height: 24px; padding: 0; display: grid; place-items: center; color: var(--ink-dim);
      background: var(--surface-2); border: 1px solid var(--line); border-radius: 4px; cursor: pointer; }
    .tb-arrow:hover:not(:disabled) { color: var(--ink); background: var(--hover); }
    .tb-arrow:disabled { opacity: .35; cursor: default; }
    @media (max-width: 768px) {
      .tb-row { grid-template-columns: 30px 26px minmax(0, 1fr) auto; grid-template-areas: "sw ico name arrows" "sw ico more more"; row-gap: 6px; }
      .tb-row > .tcv-switch, .tb-sw-none { grid-area: sw; }
      .tb-handle { display: none; }
      .tb-row-ico { grid-area: ico; }
      .tb-row-name { grid-area: name; }
      .tb-row .tb-more-n { grid-area: more; justify-self: start; }
      .tb-arrows { grid-area: arrows; }
      .tb-arrow { width: 40px; height: 36px; }
      .tb-cc-opts { grid-column: 1 / -1; grid-row: 3; }
    }
  `],
  template: `
<div class="st-page">
  <p class="st-lead">{{ 'Arrange the tabs along the top: their order, which are shown, and how they are drawn - the notification bell and Settings too. A hidden tab - and any that do not fit - is under More, so every room is still a click away; a hidden bell or Settings is also in the menu under your name.' | t }}</p>

  <!-- What the bar will look like -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Preview' | t }}</h3>
      <span class="st-sub">{{ 'the bar at full width; a narrower window moves the last tabs under More' | t }}</span></div>
    <div class="st-card-body">
      <div>
        <div class="tb-prev" aria-hidden="true">
          @for (e of preview(); track e.id) {
            @if (e.id === gap) { <span class="tb-prev-gap"></span> }
            @else if (e.id === more) {
              @if (hiddenCount()) { <span class="tcv-tab" [class.tb-prev-end]="e.id === previewEnd()" [attr.data-on]="openIsHidden() ? 1 : null"><span class="tb-name" [attr.data-text]="'More' | t">{{ 'More' | t }}</span> ⋯</span> }
            }
            @else if (e.id === bell) {
              <span class="tcv-tab tb-iconic" [class.tb-prev-end]="e.id === previewEnd()" [attr.data-on]="room() === e.id ? 1 : null">
                <svg class="tb-ico" viewBox="0 0 24 24"><path [attr.d]="bar.icon(e.id)"/></svg>@if (bar.bellCount()) {<span class="tb-prev-n">3</span>}</span>
            }
            @else if (e.id === settings) {
              <span class="tcv-tab" [class.tb-prev-end]="e.id === previewEnd()" [attr.data-on]="room() === e.id ? 1 : null">⚙@if (bar.display() !== 'icon') {&ngsp;<span class="tb-name" [attr.data-text]="'Settings' | t">{{ 'Settings' | t }}</span> }</span>
            }
            @else if (e.ws) {
              <span class="tcv-tab" [class.tb-iconic]="bar.display() === 'icon'" [class.tb-prev-end]="e.id === previewEnd()" [attr.data-on]="room() === e.id ? 1 : null">
                @if (bar.showIcon()) { <svg class="tb-ico" viewBox="0 0 24 24"><path [attr.d]="bar.icon(e.id)"/></svg> }
                @if (bar.text(e.ws); as s) { <span class="tb-name" [attr.data-text]="s | t">{{ s | t }}</span> }
                @if (e.id === 'commandcode') { <app-cc-tab-usage /> }
              </span>
            }
          }
        </div>
        <div class="tb-prev-floor"></div>
      </div>
      <div class="st-tiles tight">
        <div class="st-tile"><span>{{ 'Shown' | t }}</span><b>{{ shownCount() }} / {{ tabCount() }}</b></div>
        <div class="st-tile" [attr.data-tone]="hiddenCount() ? null : 'dim'"><span>{{ 'Under More' | t }}</span><b>{{ hiddenCount() }}</b>
          <small>{{ 'hidden by you' | t }}</small></div>
        <div class="st-tile"><span>{{ 'Display' | t }}</span><b>{{ displayLabel() | t }}</b></div>
        <div class="st-tile"><span>{{ 'Kept' | t }}</span><b>{{ 'this browser' | t }}</b></div>
      </div>
    </div>
  </div>

  <!-- How the tabs are drawn -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Display' | t }}</h3>
      <span class="st-sub">{{ 'shorter tabs leave room for more of them' | t }}</span>
      <div class="st-right"><div class="st-seg" role="radiogroup" [attr.aria-label]="'Display' | t">
        @for (d of displays; track d.id) {
          <button type="button" role="radio" [attr.aria-checked]="bar.display() === d.id" [class.on]="bar.display() === d.id"
                  (click)="bar.setDisplay(d.id)">{{ d.label | t }}</button>
        }
      </div></div>
    </div>
    <div class="st-card-body">
      <p class="st-hint">{{ 'With icons only, a tab\\'s name is in its tooltip.' | t }}</p>
    </div>
  </div>

  <!-- The order, and what is shown -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Tabs' | t }}</h3>
      <span class="st-sub">{{ 'drag a row, or use its arrows (Alt+↑ / Alt+↓)' | t }}</span>
      <div class="st-right">
        <button type="button" class="tcv-btn tcv-files-btn" [disabled]="bar.isDefault()" (click)="bar.reset()">{{ 'Reset to default' | t }}</button>
      </div>
    </div>
    <div class="tb-rows" role="list" (dragover)="$event.preventDefault()">
      @for (e of bar.entries(); track e.id; let i = $index, first = $first, last = $last) {
        <div class="tb-row" role="listitem" tabindex="0" draggable="true"
             [attr.data-off]="e.hidden ? 1 : null" [attr.data-drag]="dragging() === e.id ? 1 : null"
             [attr.data-drop]="dropOn()?.id === e.id ? dropOn()!.where : null"
             [attr.aria-label]="name(e.id)"
             (dragstart)="dragStart($event, e.id)" (dragend)="dragEnd()"
             (dragover)="dragOver($event, e.id)" (drop)="drop($event)"
             (keydown)="key($event, e.id)">
          <span class="tb-handle" aria-hidden="true" [title]="'Drag to move' | t">⋮⋮</span>
          @if (e.id === more) { <span class="tb-sw-none"></span> } @else {
            <button class="tcv-switch" type="button" role="switch" [attr.aria-checked]="!e.hidden" [attr.data-on]="e.hidden ? null : 1"
                    [attr.aria-label]="('Show in the top bar' | t) + ': ' + (name(e.id) | t)" [title]="(e.hidden ? 'Hidden - under More' : 'Shown in the top bar') | t"
                    (click)="bar.setHidden(e.id, !e.hidden)"></button>
          }
          <span class="tb-row-ico" aria-hidden="true">
            @if (e.id === gap) { ↔ } @else if (e.id === more) { <span class="tb-row-more">⋯</span> } @else { <svg class="tb-ico" viewBox="0 0 24 24"><path [attr.d]="bar.icon(e.id)"/></svg> }
          </span>
          <span class="tb-row-name">
            <b>{{ name(e.id) | t }}</b>
            <span>{{ (e.id === gap ? 'the tabs after it stand at the right'
                     : e.id === more ? (hiddenCount() ? 'where the More button stands; it cannot be hidden while a tab is hidden'
                                                      : 'not drawn now - no tab is hidden; it appears here when one is, or when tabs do not fit')
                     : e.id === bell ? (e.hidden ? 'hidden: unread ones are in the menu under your name, More and Ctrl+K' : 'the bell and its unread count')
                     : e.id === settings ? (e.hidden ? 'hidden: still in the menu under your name, More and Ctrl+K' : 'the gear; also in the menu under your name when hidden')
                     : e.id === 'wiki' && e.hidden ? 'off by default - under More; the 3D, PCB and Firmware rooms link to it too'
                     : (e.hidden ? 'under More' : (e.ws ? bar.short(e.ws) : ''))) | t }}</span>
          </span>
          @if (e.id === more) {
            <span class="st-badge tb-more-n" [attr.data-tone]="hiddenCount() ? null : 'dim'"
                  [title]="'Hidden tabs under More' | t">{{ hiddenCount() }} {{ (hiddenCount() === 1 ? 'tab under it' : 'tabs under it') | t }}</span>
          } @else { <span></span> }
          <span class="tb-arrows">
            <button type="button" class="tb-arrow" [disabled]="first" (click)="bar.step(e.id, -1)"
                    [attr.aria-label]="('Move up' | t) + ': ' + (name(e.id) | t)" [title]="'Move up' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg></button>
            <button type="button" class="tb-arrow" [disabled]="last" (click)="bar.step(e.id, 1)"
                    [attr.aria-label]="('Move down' | t) + ': ' + (name(e.id) | t)" [title]="'Move down' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
          </span>
          @if (e.id === 'commandcode') {
            <!-- The Command Code account's usage, inside the Chat tab (cc-usage.ts) -->
            <div class="tb-cc-opts" (keydown)="$event.stopPropagation()" draggable="false" (dragstart)="$event.preventDefault(); $event.stopPropagation()">
              <span class="st-sub">{{ 'Usage' | t }}</span>
              <div class="st-seg" role="radiogroup" [attr.aria-label]="'Command Code usage on the Chat tab' | t">
                @for (o of ccStyles; track o.id) {
                  <button type="button" role="radio" [attr.aria-checked]="bar.ccStyle() === o.id" [class.on]="bar.ccStyle() === o.id"
                          (click)="bar.setCcStyle(o.id)">{{ o.label | t }}</button>
                }
              </div>
              <span class="st-sub">{{ 'Window' | t }}</span>
              <div class="st-seg" role="radiogroup" [attr.aria-label]="'Window' | t">
                @for (o of ccWindows; track o.id) {
                  <button type="button" role="radio" [attr.aria-checked]="bar.ccWindow() === o.id" [class.on]="bar.ccWindow() === o.id"
                          [disabled]="bar.ccStyle() === 'off'" (click)="bar.setCcWindow(o.id)">{{ o.label | t }}</button>
                }
              </div>
              <span class="tb-cc-hint">{{ 'Command Code usage in the tab - a click on it opens LLM settings. Warn from 75%, danger from 90%; Monthly is spent of spent + left, as Command Code reports.' | t }}</span>
            </div>
          }
          @if (e.id === bell) {
            <!-- How many are unread, beside the bell (notifications.ts) -->
            <div class="tb-cc-opts" (keydown)="$event.stopPropagation()" draggable="false" (dragstart)="$event.preventDefault(); $event.stopPropagation()">
              <span class="st-sub">{{ 'Count' | t }}</span>
              <div class="st-seg" role="radiogroup" [attr.aria-label]="'Unread count beside the bell' | t">
                <button type="button" role="radio" [attr.aria-checked]="bar.bellCount()" [class.on]="bar.bellCount()" (click)="bar.setBellCount(true)">{{ 'On' | t }}</button>
                <button type="button" role="radio" [attr.aria-checked]="!bar.bellCount()" [class.on]="!bar.bellCount()" (click)="bar.setBellCount(false)">{{ 'Off' | t }}</button>
              </div>
              <span class="tb-cc-hint">{{ 'Off: the bell alone, in full ink while something is unread. New ones still show a toast as Settings > Notifications says.' | t }}</span>
            </div>
          }
        </div>
      }
    </div>
  </div>
</div>`,
})
export class TopbarSettingsPanel {
  bar = inject(TopBar);
  room = inject(Selection).room;
  readonly gap = GAP;
  readonly more = MORE;
  readonly bell = BELL;
  readonly settings = SETTINGS;
  readonly ccStyles = CC_TAB_STYLES;
  readonly ccWindows = CC_TAB_WINDOWS;
  readonly displays = TOPBAR_DISPLAYS;

  tabCount = computed(() => this.bar.entries().filter(e => e.ws).length);
  shownCount = computed(() => this.bar.entries().filter(e => e.ws && !e.hidden).length);
  hiddenCount = computed(() => this.bar.hiddenTabs().length);
  openIsHidden = computed(() => this.bar.hiddenTabs().some(w => w.id === this.room()));
  displayLabel = computed(() => TOPBAR_DISPLAYS.find(d => d.id === this.bar.display())?.label ?? '');
  /** The bar as it will stand: the shown items, a gap only between tabs. */
  preview = computed(() => this.bar.entries().filter(e => !e.hidden));
  /** The last item the preview draws: it stands at the right end. */
  previewEnd = computed(() => [...this.preview()].reverse().find(e => e.id !== GAP && (e.id !== MORE || this.hiddenCount()))?.id ?? null);

  name(id: string): string {
    return id === GAP ? 'Gap' : id === MORE ? 'More' : this.bar.entries().find(e => e.id === id)?.ws?.label ?? id;
  }

  // ---- dragging ----------------------------------------------------
  dragging = signal<string | null>(null);
  dropOn = signal<{ id: string; where: 'before' | 'after' } | null>(null);

  dragStart(ev: DragEvent, id: string) {
    this.dragging.set(id);
    if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', id); }
  }
  dragOver(ev: DragEvent, id: string) {
    if (!this.dragging()) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const where = ev.clientY < r.top + r.height / 2 ? 'before' : 'after';
    const now = this.dropOn();
    if (now?.id !== id || now.where !== where) this.dropOn.set({ id, where });
  }
  drop(ev: DragEvent) {
    ev.preventDefault();
    const id = this.dragging(), on = this.dropOn();
    if (id && on && on.id !== id) {
      const list = this.bar.order().filter(x => x !== id);
      const at = list.indexOf(on.id) + (on.where === 'after' ? 1 : 0);
      this.bar.move(id, at);
    }
    this.dragEnd();
  }
  dragEnd() { this.dragging.set(null); this.dropOn.set(null); }

  /** Alt+↑/↓ moves the focused row and keeps the focus on it. */
  key(ev: KeyboardEvent, id: string) {
    if (ev.target !== ev.currentTarget || !ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    this.bar.step(id, ev.key === 'ArrowUp' ? -1 : 1);
    const list = (ev.currentTarget as HTMLElement).parentElement;
    requestAnimationFrame(() => {
      const i = this.bar.order().indexOf(id);
      (list?.children[i] as HTMLElement | undefined)?.focus();
    });
  }

  setDisplay(d: TopbarDisplay) { this.bar.setDisplay(d); }
}
