import { Component, computed, inject, signal } from '@angular/core';
import { T } from './i18n';
import { Selection } from './selection';
import { GAP, TOPBAR_DISPLAYS, TopBar, TopbarDisplay } from './topbar';

/** Settings > Top bar: which tabs the bar shows and in what order, and how
 *  they are drawn (topbar.ts keeps it). Drag a row, or use its arrows -
 *  Alt+↑/↓ on a focused row does the same. Settings is not in the list to
 *  move: it is always shown, always last. */
@Component({
  selector: 'app-topbar-settings',
  imports: [T],
  styleUrl: './settings.css',
  styles: [`
    .tb-prev { display: flex; align-items: flex-end; gap: 4px; min-width: 0; overflow-x: auto; overflow-y: hidden;
      scrollbar-width: thin; scrollbar-color: var(--scroll-thumb) transparent;
      padding: 8px 8px 0; background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px 5px 0 0; }
    .tb-prev .tcv-tab { flex: none; cursor: default; }
    .tb-prev .tcv-tab[data-on="1"] { z-index: auto; }
    .tb-prev-floor { height: 10px; margin-top: -1px; background: var(--surface); border: 1px solid var(--line);
      border-top-color: var(--line); border-radius: 0 0 5px 5px; }
    .tb-prev-gap { flex: 1 1 24px; min-width: 24px; align-self: stretch; margin-bottom: 6px;
      border-bottom: 1px dashed var(--line); }
    .tb-prev-end { margin-left: auto; }
    .tb-prev-gap + .tb-prev-end { margin-left: 0; }
    .tb-rows { display: flex; flex-direction: column; }
    .tb-row { display: grid; grid-template-columns: 18px 26px minmax(0, 1fr) auto auto; align-items: center; gap: 8px;
      padding: 6px 10px; border-top: 1px solid var(--line); outline: none; background: var(--surface); }
    .tb-row:first-child { border-top: 0; }
    .tb-row:focus-visible { box-shadow: inset 2px 0 0 var(--accent); background: var(--surface-2); }
    .tb-row[data-off] .tb-row-name { opacity: .5; }
    .tb-row[data-drag] { opacity: .45; }
    .tb-row[data-drop="before"] { box-shadow: inset 0 2px 0 var(--accent); }
    .tb-row[data-drop="after"] { box-shadow: inset 0 -2px 0 var(--accent); }
    .tb-row[data-fixed] { background: var(--surface-2); }
    .tb-handle { cursor: grab; color: var(--ink-dim); font-size: 13px; line-height: 1; text-align: center; user-select: none; }
    .tb-row[data-fixed] .tb-handle { cursor: default; opacity: .4; }
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
      .tb-row { grid-template-columns: 26px minmax(0, 1fr) auto; grid-template-areas: "ico name arrows" "ico show show"; row-gap: 6px; }
      .tb-handle { display: none; }
      .tb-row-ico { grid-area: ico; }
      .tb-row-name { grid-area: name; }
      .tb-row .st-seg { grid-area: show; justify-self: start; }
      .tb-arrows { grid-area: arrows; }
      .tb-arrow { width: 40px; height: 36px; }
      .tb-row .st-seg button { padding: 7px 14px; }
    }
  `],
  template: `
<div class="st-page">
  <p class="st-lead">{{ 'Arrange the tabs along the top: their order, which are shown, and how they are drawn. Settings always stays at the far right. A hidden tab - and any that do not fit - is under More, so every room is still a click away.' | t }}</p>

  <!-- What the bar will look like -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Preview' | t }}</h3>
      <span class="st-sub">{{ 'the bar at full width; a narrower window moves the last tabs under More' | t }}</span></div>
    <div class="st-card-body">
      <div>
        <div class="tb-prev" aria-hidden="true">
          @for (e of preview(); track e.id) {
            @if (e.id === gap) { <span class="tb-prev-gap"></span> }
            @else if (e.ws) {
              <span class="tcv-tab" [class.tb-iconic]="bar.display() === 'icon'" [attr.data-on]="room() === e.id ? 1 : null">
                @if (bar.showIcon()) { <svg class="tb-ico" viewBox="0 0 24 24"><path [attr.d]="bar.icon(e.id)"/></svg> }
                {{ bar.text(e.ws) | t }}
              </span>
            }
          }
          @if (hiddenCount()) {
            <span class="tcv-tab" [attr.data-on]="openIsHidden() ? 1 : null">{{ 'More' | t }} ⋯</span>
          }
          <span class="tcv-tab tb-prev-end" [attr.data-on]="room() === 'settings' ? 1 : null">⚙@if (bar.display() !== 'icon') { {{ 'Settings' | t }} }</span>
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
          <span class="tb-row-ico" aria-hidden="true">
            @if (e.id === gap) { ↔ } @else { <svg class="tb-ico" viewBox="0 0 24 24"><path [attr.d]="bar.icon(e.id)"/></svg> }
          </span>
          <span class="tb-row-name">
            <b>{{ name(e.id) | t }}</b>
            <span>{{ (e.id === gap ? 'the tabs after it stand at the right' : (e.hidden ? 'under More' : (e.ws ? bar.short(e.ws) : ''))) | t }}</span>
          </span>
          <div class="st-seg">
            <button type="button" [class.on]="!e.hidden" [attr.aria-pressed]="!e.hidden" (click)="bar.setHidden(e.id, false)">{{ 'Show' | t }}</button>
            <button type="button" [class.on]="e.hidden" [attr.aria-pressed]="e.hidden" (click)="bar.setHidden(e.id, true)">{{ 'Hide' | t }}</button>
          </div>
          <span class="tb-arrows">
            <button type="button" class="tb-arrow" [disabled]="first" (click)="bar.step(e.id, -1)"
                    [attr.aria-label]="('Move up' | t) + ': ' + (name(e.id) | t)" [title]="'Move up' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg></button>
            <button type="button" class="tb-arrow" [disabled]="last" (click)="bar.step(e.id, 1)"
                    [attr.aria-label]="('Move down' | t) + ': ' + (name(e.id) | t)" [title]="'Move down' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
          </span>
        </div>
      }
      <div class="tb-row" role="listitem" data-fixed>
        <span class="tb-handle" aria-hidden="true">⋮⋮</span>
        <span class="tb-row-ico" aria-hidden="true">⚙</span>
        <span class="tb-row-name"><b>{{ 'Settings' | t }}</b><span>{{ 'always shown, always at the far right' | t }}</span></span>
        <span class="st-badge">{{ 'fixed' | t }}</span>
        <span></span>
      </div>
    </div>
  </div>
</div>`,
})
export class TopbarSettingsPanel {
  bar = inject(TopBar);
  room = inject(Selection).room;
  readonly gap = GAP;
  readonly displays = TOPBAR_DISPLAYS;

  tabCount = computed(() => this.bar.entries().filter(e => e.id !== GAP).length);
  shownCount = computed(() => this.bar.entries().filter(e => e.id !== GAP && !e.hidden).length);
  hiddenCount = computed(() => this.bar.hiddenTabs().length);
  openIsHidden = computed(() => this.bar.hiddenTabs().some(w => w.id === this.room()));
  displayLabel = computed(() => TOPBAR_DISPLAYS.find(d => d.id === this.bar.display())?.label ?? '');
  /** The bar as it will stand: the shown items, a gap only between tabs. */
  preview = computed(() => this.bar.entries().filter(e => !e.hidden));

  name(id: string): string {
    return id === GAP ? 'Gap' : this.bar.entries().find(e => e.id === id)?.ws?.label ?? id;
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
