import { ChangeDetectionStrategy, Component, ViewEncapsulation, input } from '@angular/core';
import { T } from './i18n';
import { Icon } from './rooms/files-model';

/** The app's one "nothing here" message: a small line icon, a heading and a
 *  line under it, and what can be done about it, centred where the list or
 *  page would be. No picture, no colour - it reads as the room's own text.
 *
 *    @empty { <wb-empty icon="doc" heading="No notes yet" text="Press New note, or Alt+N anywhere." compact /> }
 *    <wb-empty icon="upload" heading="No files yet" text="Drop files anywhere here…">
 *      <button class="tcv-btn" (click)="upload()">{{ 'Upload' | t }}</button>
 *    </wb-empty>
 *
 *  icon     a Files icon name (files-model.ts ICONS); none for none
 *  heading  the bold line (English, translated here); none for a text alone
 *  text     the dimmer line under it (English, translated here)
 *  compact  for a side list (Notes, the Chat's conversations, the catalog's
 *           makers): smaller and close to the top; without it, a room's
 *           whole content area (Files) with room around it.
 *  Whatever is put inside (a button, a link) comes under the text. */
@Component({
  selector: 'wb-empty',
  imports: [T, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: { class: 'wb-empty wb-in', role: 'status', '[attr.data-compact]': 'compact() ? 1 : null' },
  template: `
@if (icon()) { <i class="wb-empty-ico" [fmIcon]="icon()!"></i> }
@if (heading()) { <b class="wb-empty-head">{{ heading()! | t }}</b> }
@if (text()) { <p class="wb-empty-text">{{ text()! | t }}</p> }
<div class="wb-empty-act"><ng-content /></div>
`,
  styles: `
.wb-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 440px; margin: 56px auto;  /* as much room under it as over it */
  padding: 0 16px; text-align: center; color: var(--ink-dim); grid-column: 1 / -1; }   /* a whole row in a grid of cards */
.wb-empty-ico { color: var(--ink-dim); margin-bottom: 4px; }
.wb-empty-ico svg { width: 36px; height: 36px; stroke-width: 1.2; }
.wb-empty-head { font-size: 14px; font-weight: 600; color: var(--ink); }
.wb-empty-text { margin: 0; font-size: 12.5px; line-height: 1.55; }
.wb-empty-act { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 6px; }
.wb-empty-act:empty { display: none; }
.wb-empty[data-compact] { gap: 4px; max-width: none; margin: 24px auto 12px; padding: 0 12px; }
.wb-empty[data-compact] .wb-empty-ico { margin-bottom: 2px; }
.wb-empty[data-compact] .wb-empty-ico svg { width: 22px; height: 22px; stroke-width: 1.4; }
.wb-empty[data-compact] .wb-empty-head { font-size: 12.5px; }
.wb-empty[data-compact] .wb-empty-text { font-size: 12px; line-height: 1.5; }
.wb-empty[data-compact] .wb-empty-act { margin-top: 4px; }
`,
})
export class EmptyState {
  readonly icon = input<string>();
  readonly heading = input<string>();
  readonly text = input<string>();
  readonly compact = input(false, { transform: (v: boolean | string) => v !== false && v !== 'false' });
}
