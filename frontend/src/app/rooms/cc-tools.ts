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

/** The Chat tab's tools, where a conversation is shown (rooms/commandcode.ts):
 *  Settings' cards (settings.css), one per level, each tool a tile that is
 *  its own switch, like Telegram's "Notify me when". Its look ships with it,
 *  so it never waits on the global stylesheet. */
@Component({
  selector: 'app-cc-tools',
  imports: [T],
  styleUrls: ['../settings.css', './cc-tools.css'],
  template: `
<header class="ct-bar">
  <button class="ct-ib ct-burger" type="button" (click)="menu.emit()" [title]="'Conversations' | t">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16 M4 12h16 M4 18h16" /></svg></button>
  <h2>{{ 'Tools' | t }}</h2>
  <span class="ct-count mono">{{ on() }} / {{ tools().length }}</span>
  @if (!canEdit()) { <span class="st-badge" data-tone="warn">{{ 'read-only for you' | t }}</span> }
  <button class="ct-ib ct-close" type="button" (click)="done.emit()" [title]="('Close' | t) + ' (Esc)'">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" /></svg></button>
</header>
<div class="ct-stage">
  <div class="st-page ct-page">
    <p class="st-lead">{{ 'What the model may use while it answers your messages. Tap a tile to turn it on or off.' | t }}</p>
    @if (!ready()) {
      <div class="st-card"><div class="st-empty">{{ 'Loading…' | t }}</div></div>
    } @else {
      @for (g of groups(); track g.id) {
        <section class="st-card" [attr.data-level]="g.id">
          <div class="st-card-head">
            <h3>{{ g.name | t }}</h3><span class="st-sub">{{ g.about | t }}</span>
            <span class="st-right">
              <span class="st-sub mono">{{ g.on }} / {{ g.tools.length }}</span>
              @if (g.tools.length && canEdit()) {
                <button class="ct-all" type="button" (click)="setAll(g.tools, g.on < g.tools.length)"
                  >{{ (g.on < g.tools.length ? 'all on' : 'all off') | t }}</button>
              }
            </span>
          </div>
          <div class="st-card-body">
            @if (g.tools.length) {
              <div class="ct-tiles">
                @for (tl of g.tools; track tl.name) {
                  <button class="ct-tile" type="button" [attr.data-on]="tl.on ? 1 : null" [attr.aria-pressed]="tl.on"
                          [disabled]="!canEdit()" (click)="flip(tl)">
                    <span class="ct-tile-top"><b>{{ tl.label | t }}</b><i class="ct-switch" aria-hidden="true"></i></span>
                    <span class="ct-about">{{ tl.description | t }}</span>
                    <code class="ct-id">{{ tl.name }}</code>
                  </button>
                }
              </div>
            } @else {
              <div class="ct-none">{{ 'none yet' | t }}</div>
            }
          </div>
        </section>
      }
    }
    <p class="st-hint ct-foot">{{ 'Your own choice, on every device. A model that cannot use tools answers without them.' | t }}</p>
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

  on = computed(() => this.tools().filter(x => x.on).length);
  groups = computed(() => LEVELS.map(l => {
    const tools = this.tools().filter(x => x.level === l.id);
    return { ...l, tools, on: tools.filter(x => x.on).length };
  }));
  flip(tl: CcTool) { this.set.emit({ [tl.name]: !tl.on }); }
  setAll(tools: CcTool[], on: boolean) { this.set.emit(Object.fromEntries(tools.map(x => [x.name, on]))); }
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
