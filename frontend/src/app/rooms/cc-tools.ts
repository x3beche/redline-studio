import { Component, computed, input, output } from '@angular/core';
import { T } from '../i18n';
import type { CcTool, ToolLevel } from './commandcode';

/** What a tool may do, in the order it is asked about: reads run on their
 *  own, changes always leave a step in the answer, deletes ask first. */
export const LEVELS: { id: ToolLevel; name: string; about: string }[] = [
  { id: 'read', name: 'Only reads', about: 'run freely' },
  { id: 'change', name: 'Changes', about: 'run, and always show a step' },
  { id: 'delete', name: 'Deletes', about: 'ask you first' },
];

const CHEVRON = 'M10 7l5 5-5 5';
const WRENCH = 'M14.5 4.5a4 4 0 0 0-5 5L4 15l2 2 2 2 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z';
const DRAWER = 'M4 5h16v6H4z M4 11h16v8H4z M10 8h4 M10 15h4';
const SEARCH = 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4.2-4.2';
const SHEET = 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 15.5h6 M9 9h2';

/** A tool's icon, here and on its steps in an answer: by what it touches. */
export const TOOL_ICON: Record<string, string> = {
  drawer_search: DRAWER, drawer_list: DRAWER, drawer_add: DRAWER, lcsc_search: SEARCH, datasheet_get: SHEET, datasheet_read: SHEET,
};
export function toolIcon(name: string) { return TOOL_ICON[name] ?? WRENCH; }

/** How each level behaves, said once on its card: the tone of its badge. */
const BEHAVES: Record<ToolLevel, { badge: string; tone: string; empty: string }> = {
  read: { badge: 'runs on its own', tone: 'ok', empty: 'No tool only reads yet.' },
  change: { badge: 'shows a step in the answer', tone: 'accent', empty: 'No tool changes anything yet.' },
  delete: { badge: 'asks you first', tone: 'warn',
            empty: 'No tool deletes anything yet. When one does, the answer stops and asks you before it runs.' },
};

/** The Chat tab's tools, where a conversation is shown (rooms/commandcode.ts),
 *  in Settings' own frame (settings.css): the slim head band, then one card
 *  per level with its tools as tiles - icon, name, the app's switch
 *  (.tcv-switch), what it does and its id. A tile is its own switch. */
@Component({
  selector: 'app-cc-tools',
  imports: [T],
  styleUrls: ['../settings.css', './cc-tools.css'],
  template: `
<header class="st-head ct-head">
  <button class="ct-ib ct-burger" type="button" (click)="menu.emit()" [title]="'Conversations' | t">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16 M4 12h16 M4 18h16" /></svg></button>
  <svg class="ct-head-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="wrench" /></svg>
  <span class="st-head-name">{{ 'Tools' | t }}</span>
  <span class="st-head-blurb">{{ 'what the model may use while it answers you' | t }}</span>
  <span class="st-head-meta">
    @if (!canEdit()) { <span class="st-badge" data-tone="warn">{{ 'read-only for you' | t }}</span> }
    <span class="mono">{{ on() }} / {{ tools().length }} {{ 'on' | t }}</span>
  </span>
  <button class="ct-ib" type="button" (click)="done.emit()" [title]="('Close' | t) + ' (Esc)'">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" /></svg></button>
</header>
<div class="st-stage">
  <div class="st-page ct-page">
    <p class="st-lead">{{ 'The model reaches for these by itself when a question needs them, and every use shows in its answer as a step you can open. Turn off what you do not want it to touch; this is your own choice and follows you to every device.' | t }}</p>
    @if (!ready()) {
      <section class="st-card"><div class="ct-empty">{{ 'Loading…' | t }}</div></section>
    } @else {
      @for (g of groups(); track g.id) {
        <section class="st-card" [attr.data-level]="g.id">
          <div class="st-card-head">
            <h3>{{ g.name | t }}</h3>
            <span class="st-badge" [attr.data-tone]="g.tone">{{ g.badge | t }}</span>
            @if (g.tools.length) {
              <span class="st-right">
                <span class="st-sub mono">{{ g.on }} / {{ g.tools.length }}</span>
                <span class="st-seg">
                  <button type="button" [class.on]="g.on === g.tools.length" [disabled]="!canEdit()"
                          (click)="setAll(g.tools, true)">{{ 'all on' | t }}</button>
                  <button type="button" [class.on]="g.on === 0" [disabled]="!canEdit()"
                          (click)="setAll(g.tools, false)">{{ 'all off' | t }}</button>
                </span>
              </span>
            }
          </div>
          @if (g.tools.length) {
            <div class="ct-tiles" [style.--cols]="g.tools.length" [attr.data-odd]="g.tools.length % 2 ? 1 : null">
              @for (tl of g.tools; track tl.name) {
                <button class="ct-tile" type="button" role="switch" [attr.aria-checked]="tl.on" [attr.data-on]="tl.on ? 1 : null"
                        [disabled]="!canEdit()" (click)="flip(tl)">
                  <span class="ct-top">
                    <svg class="ct-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(tl.name)" /></svg>
                    <span class="ct-name">{{ tl.label | t }}</span>
                    <span class="tcv-switch" [attr.data-on]="tl.on ? 1 : null" aria-hidden="true"></span>
                  </span>
                  <span class="ct-about">{{ tl.description | t }}</span>
                  <code class="ct-id">{{ tl.name }}</code>
                </button>
              }
            </div>
          } @else {
            <div class="ct-empty">{{ g.empty | t }}</div>
          }
        </section>
      }
    }
    <p class="st-hint">{{ 'A model that cannot use tools answers without them. Turning a tool off takes effect from your next message.' | t }}</p>
  </div>
</div>`,
})
export class CcToolsView {
  tools = input.required<CcTool[]>();
  ready = input(true);
  canEdit = input(true);
  /** Tools to turn on or off, by name. */
  set = output<Record<string, boolean>>();
  done = output<void>();
  menu = output<void>();

  readonly wrench = WRENCH;
  icon = toolIcon;
  on = computed(() => this.tools().filter(x => x.on).length);
  groups = computed(() => LEVELS.map(l => {
    const tools = this.tools().filter(x => x.level === l.id);
    return { ...l, ...BEHAVES[l.id], tools, on: tools.filter(x => x.on).length };
  }));
  flip(tl: CcTool) { this.set.emit({ [tl.name]: !tl.on }); }
  setAll(tools: CcTool[], on: boolean) {
    const change = tools.filter(x => x.on !== on);
    if (change.length) this.set.emit(Object.fromEntries(change.map(x => [x.name, on])));
  }
}

/** Under the usage card in the conversation list: opens the tools above in
 *  the conversation's place. Same width, border and type as the card. */
@Component({
  selector: 'app-cc-tools-line',
  imports: [T],
  styles: [`
    :host { display: block; flex: none; }
    .ctl { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 28px; padding: 5px 8px; text-align: left;
      font-size: 11px; color: var(--ink-dim); border: 1px solid var(--line); border-radius: 5px; background: var(--surface);
      cursor: pointer; }
    .ctl:hover, .ctl:focus-visible { background: var(--hover); outline: none; }
    .ctl[aria-pressed="true"] { background: var(--surface-2); border-color: var(--accent); }
    .ctl b { color: var(--ink); font-weight: 600; }
    .ctl em { margin-left: auto; font: normal 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    svg { flex: none; width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.7;
      stroke-linecap: round; stroke-linejoin: round; }
    .ctl[aria-pressed="true"] svg:first-child { color: var(--accent); }
    svg:last-child { width: 12px; height: 12px; }
    @media (max-width: 768px) { .ctl { min-height: 36px; } }
  `],
  template: `
<button class="ctl" type="button" (click)="toggle.emit()" [attr.aria-pressed]="open()"
        [title]="'Which tools the model may use with your lines' | t">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="wrench" /></svg>
  <b>{{ 'Tools' | t }}</b>
  <em>{{ on() }}/{{ total() }}</em>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="chevron" /></svg>
</button>`,
})
export class CcToolsLine {
  on = input(0);
  total = input(0);
  open = input(false);
  toggle = output<void>();
  readonly wrench = WRENCH;
  readonly chevron = CHEVRON;
}
