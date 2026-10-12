import {
  Component, ElementRef, NgZone, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import type { Editor } from '@tiptap/core';
import type { SlashState } from './note-editor';
import { T, t } from '../i18n';
import { SelectOption, UiSelect } from '../ui-select';

/** Toolbar icons, drawn as the rest of the app draws its own (24-unit, stroked). */
const ICONS: Record<string, string> = {
  undo: 'M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'm15 14 5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  ul: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
  ol: 'M10 6h10 M10 12h10 M10 18h10 M4 5l1.5-1v5 M3.5 14.2a1.4 1.4 0 0 1 2.6.6c0 1.2-2.6 2.2-2.6 3.2h2.8',
  todo: 'M4 5h5v5H4z M5.5 7.5l1.2 1.2L8.5 6.5 M4 14h5v5H4z M12 7.5h8 M12 16.5h8',
  quote: 'M5 7h5v5c0 2.5-1.5 4-4 4.5 M14 7h5v5c0 2.5-1.5 4-4 4.5',
  code: 'm8 8-4 4 4 4 m8-8 4 4-4 4 M13.5 6l-3 12',
  table: 'M3.5 5h17v14h-17z M3.5 10h17 M3.5 14.5h17 M9.5 5v14 M15 5v14',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4L11.5 6 M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5',
  hr: 'M3 12h18 M7 7h10 M7 17h10',
  rowAdd: 'M3.5 5h17v8h-17z M12 16v5 M9.5 18.5h5',
  colAdd: 'M5 3.5h8v17H5z M16 12h5 M18.5 9.5v5',
  rowDel: 'M3.5 5h17v8h-17z M9.5 18.5h5',
  colDel: 'M5 3.5h8v17H5z M16 12h5',
  head: 'M3.5 5h17v14h-17z M3.5 10h17',
  tableDel: 'M3.5 5h17v14h-17z M9 9.5l6 6 M15 9.5l-6 6',
};

/** A note, read or written: the same page either way, so starting to
 *  edit does not move a word. The editor itself (TipTap, ~100 kB) is
 *  loaded the first time a note is shown. */
@Component({
  selector: 'app-note-doc',
  imports: [T, UiSelect],
  host: { class: 'tcv-notedoc', '[attr.data-editing]': 'editable() ? 1 : null', '(dblclick)': 'dbl($event)', '(click)': 'click($event)', '(keydown)': 'key($event)' },
  template: `
<div class="tcv-doc-bar" [attr.role]="editable() ? 'toolbar' : null" [attr.aria-label]="'Formatting' | t" (mousedown)="keepFocus($event)">
  @if (editable() && ed()) {
    <wb-select class="tcv-doc-wtype" label="Block type" [tip]="'Block type' | t" [options]="blockOpts()" [value]="blockType()" (pick)="setBlock($event)" />
    <span class="tcv-doc-sep"></span>
    <button class="tcv-doc-b" [class.on]="is('bold')" (click)="run('bold')" [title]="('Bold' | t) + ' (Ctrl+B)'"><b>B</b></button>
    <button class="tcv-doc-b" [class.on]="is('italic')" (click)="run('italic')" [title]="('Italic' | t) + ' (Ctrl+I)'"><i>I</i></button>
    <button class="tcv-doc-b" [class.on]="is('strike')" (click)="run('strike')" [title]="('Strikethrough' | t) + ' (Ctrl+Shift+S)'"><s>S</s></button>
    <button class="tcv-doc-b tcv-doc-mono" [class.on]="is('code')" (click)="run('code')" [title]="('Inline code' | t) + ' (Ctrl+E)'">&lt;/&gt;</button>
    <button class="tcv-doc-b" [class.on]="is('link') || linking()" (click)="link()" [title]="('Link' | t) + ' (Ctrl+K)'"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['link']" /></svg></button>
    <span class="tcv-doc-sep"></span>
    <button class="tcv-doc-b" [class.on]="is('bulletList')" (click)="run('ul')" [title]="('Bulleted list' | t) + ' (Ctrl+Shift+8)'"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['ul']" /></svg></button>
    <button class="tcv-doc-b" [class.on]="is('orderedList')" (click)="run('ol')" [title]="('Numbered list' | t) + ' (Ctrl+Shift+7)'"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['ol']" /></svg></button>
    <button class="tcv-doc-b" [class.on]="is('taskList')" (click)="run('todo')" [title]="('To-do list' | t) + ' (Ctrl+Shift+9)'"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['todo']" /></svg></button>
    <button class="tcv-doc-b" [class.on]="is('blockquote')" (click)="run('quote')" [title]="('Quote' | t) + ' (Ctrl+Shift+B)'"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['quote']" /></svg></button>
    <button class="tcv-doc-b" [class.on]="is('codeBlock')" (click)="run('codeblock')" [title]="('Code block' | t) + ' (Ctrl+Alt+C)'"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['code']" /></svg></button>
    <button class="tcv-doc-b" (click)="run('hr')" [title]="'Divider' | t"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['hr']" /></svg></button>
    <button class="tcv-doc-b" [class.on]="is('table')" (click)="run('table')" [title]="'Insert a table' | t"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['table']" /></svg></button>
    @if (is('table')) {
      <span class="tcv-doc-sep"></span>
      <span class="tcv-doc-group" [title]="'Table' | t">
        <button class="tcv-doc-b" (click)="run('rowAdd')" [title]="'Add a row below' | t"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['rowAdd']" /></svg></button>
        <button class="tcv-doc-b" (click)="run('colAdd')" [title]="'Add a column to the right' | t"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['colAdd']" /></svg></button>
        <button class="tcv-doc-b" (click)="run('rowDel')" [title]="'Delete the row' | t"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['rowDel']" /></svg></button>
        <button class="tcv-doc-b" (click)="run('colDel')" [title]="'Delete the column' | t"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['colDel']" /></svg></button>
        <button class="tcv-doc-b" (click)="run('head')" [title]="'Header row on or off' | t"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['head']" /></svg></button>
        <button class="tcv-doc-b tcv-doc-danger" (click)="run('tableDel')" [title]="'Delete the table' | t"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['tableDel']" /></svg></button>
      </span>
    }
    <span class="tcv-doc-sep"></span>
    <button class="tcv-doc-b" [disabled]="!can('undo')" (click)="run('undo')" [title]="('Undo' | t) + ' (Ctrl+Z)'"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['undo']" /></svg></button>
    <button class="tcv-doc-b" [disabled]="!can('redo')" (click)="run('redo')" [title]="('Redo' | t) + ' (Ctrl+Shift+Z)'"><svg class="tcv-doc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I['redo']" /></svg></button>
  }
  <!-- The owner's: who wrote it and when, or Done. -->
  <ng-content />
</div>
@if (editable() && ed()) {
  @if (linking()) {
    <div class="tcv-doc-linkbar" (mousedown)="$event.stopPropagation()">
      <input #href class="tcv-doc-href" [value]="linkHref()" placeholder="https://…"
             (keydown.enter)="setLink($any($event.target).value); $event.preventDefault()"
             (keydown.escape)="linking.set(false); ed()?.commands?.focus(); $event.stopPropagation()">
      <button class="tcv-btn tcv-note-btn" (click)="setLink(href.value)">{{ 'Apply' | t }}</button>
      @if (is('link')) { <button class="tcv-btn tcv-note-btn" (click)="setLink('')">{{ 'Remove the link' | t }}</button> }
    </div>
  }
}
<div #host class="tcv-doc-host"></div>
@if (slash(); as s) {
  <div class="tcv-doc-slash" animate.leave="tcv-leave" role="listbox" [style.left.px]="s.x" [style.top.px]="s.y + 6" (mousedown)="$event.preventDefault()">
    @for (it of s.items; track it.id; let i = $index) {
      <button role="option" [attr.data-on]="i === s.index ? 1 : null" (click)="s.pick(i)">
        <span>{{ it.label | t }}</span><em>{{ it.hint | t }}</em></button>
    }
  </div>
}`,
})
export class NoteDoc implements OnDestroy {
  private zone = inject(NgZone);
  private host = viewChild.required<ElementRef<HTMLElement>>('host');
  hrefBox = viewChild<ElementRef<HTMLInputElement>>('href');

  /** The note's Markdown. Set again from outside (another note, a tick) it is read again. */
  text = input('');
  editable = input(false);
  placeholder = input('');
  /** The text as edited. */
  changed = output<string>();
  /** A to-do ticked while reading: its place among the note's to-dos. */
  ticked = output<number>();
  /** A #tag clicked while reading. */
  tag = output<string>();
  /** Double-clicked while reading: the owner decides whether to edit. */
  wantEdit = output<void>();
  /** Esc or Ctrl+Enter while writing. */
  done = output<void>();

  readonly I = ICONS;
  ed = signal<Editor | null>(null);
  slash = signal<SlashState | null>(null);
  linking = signal(false);
  linkHref = signal('');
  /** Bumped on every change, so the toolbar shows what the caret is in. */
  private rev = signal(0);
  private last = '';
  private api?: typeof import('./note-editor');
  private clickAt: { left: number; top: number } | null = null;
  private dead = false;

  constructor() {
    import('./note-editor').then(m => {
      if (this.dead) return;
      this.api = m;
      this.last = untracked(this.text);
      const editor = this.zone.runOutsideAngular(() => m.createNoteEditor({
        element: this.host().nativeElement,
        markdown: this.last,
        editable: untracked(this.editable),
        placeholder: t(untracked(this.placeholder) || 'First line is the title - #tags, @controller, - [ ] to-dos…'),
        slashHint: t('Type / for blocks'),
        onChange: md => this.zone.run(() => {
          // Written back as the library writes it, an untouched note can differ
          // from its text (a table's padding): that is no change.
          if (md === this.base) md = this.baseText;
          if (md === this.last) return;
          this.last = md;
          this.changed.emit(md);
        }),
        onTick: i => this.zone.run(() => this.ticked.emit(i)),
        onSlash: s => this.zone.run(() => this.slash.set(s)),
        onSelection: () => this.zone.run(() => this.rev.update(v => v + 1)),
      }));
      this.ed.set(editor);
      this.rebase(editor, this.last);
      if (untracked(this.editable)) this.focus();
    });
    // A new text from outside (another note, a tick, the list read again).
    effect(() => {
      const md = this.text(), e = this.ed();
      if (!e || md === this.last) return;
      this.last = md;
      untracked(() => { this.api!.setMarkdown(e, md); this.rebase(e, md); });
    });
    effect(() => {
      const on = this.editable(), e = this.ed();
      if (!e || e.isEditable === on) return;
      untracked(() => {
        e.setEditable(on, false);
        this.linking.set(false);
        if (on) this.focus(); else this.slash.set(null);
      });
    });
  }

  /** What the text reads as when the editor writes it back unchanged. */
  private base = '';
  private baseText = '';
  private rebase(e: Editor, text: string) { this.baseText = text; this.base = this.api!.markdownOf(e); }

  /** Into the text: where it was double-clicked, or at the end. */
  private focus() {
    const e = this.ed();
    if (!e) return;
    setTimeout(() => {
      const at = this.clickAt && e.view.posAtCoords(this.clickAt);
      this.clickAt = null;
      if (at) e.chain().focus().setTextSelection(at.pos).run();
      else e.commands.focus('end');
    });
  }

  dbl(ev: MouseEvent) {
    if (this.editable()) return;
    this.clickAt = { left: ev.clientX, top: ev.clientY };
    window.getSelection()?.removeAllRanges();
    this.wantEdit.emit();
  }

  click(ev: MouseEvent) {
    const el = ev.target as HTMLElement;
    if (!this.editable()) {
      const tag = el.closest('.tcv-note-tag') as HTMLElement | null;
      if (tag?.dataset['tag']) { this.tag.emit(tag.dataset['tag']); return; }
      const a = el.closest('a[href]') as HTMLAnchorElement | null;
      if (a && /^https?:/.test(a.href)) { ev.preventDefault(); window.open(a.href, '_blank', 'noreferrer'); }
    } else if ((ev.ctrlKey || ev.metaKey) && el.closest('a[href]')) {
      window.open((el.closest('a[href]') as HTMLAnchorElement).href, '_blank', 'noreferrer');
    }
  }

  key(ev: KeyboardEvent) {
    if (!this.editable()) return;
    if (ev.key === 'Escape' && !this.slash() && !this.linking()) { ev.preventDefault(); this.done.emit(); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); this.done.emit(); }
    else if (ev.key.toLowerCase() === 'k' && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); this.link(); }
  }

  /** The toolbar's buttons leave the caret where it was. */
  keepFocus(ev: MouseEvent) {
    if (this.editable() && !(ev.target as HTMLElement).closest('select')) ev.preventDefault();
  }

  is(name: string): boolean { this.rev(); return !!this.ed()?.isActive(name); }
  can(what: 'undo' | 'redo'): boolean { this.rev(); const e = this.ed(); return !!e && (what === 'undo' ? e.can().undo() : e.can().redo()); }

  blockOpts = computed<SelectOption[]>(() => [{ value: 'p', label: t('Text') }, { value: 'h1', label: t('Heading 1') },
    { value: 'h2', label: t('Heading 2') }, { value: 'h3', label: t('Heading 3') },
    ...(this.blockType() === 'other' ? [{ value: 'other', label: '…' }] : [])]);

  blockType(): string {
    this.rev();
    const e = this.ed();
    if (!e) return 'p';
    for (const l of [1, 2, 3]) if (e.isActive('heading', { level: l })) return `h${l}`;
    return e.isActive('paragraph') ? 'p' : 'other';
  }

  setBlock(v: string) {
    const e = this.ed();
    if (!e) return;
    const c = e.chain().focus();
    if (v === 'p') c.setParagraph().run();
    else if (/^h[123]$/.test(v)) c.setHeading({ level: +v[1] as 1 | 2 | 3 }).run();
  }

  run(what: string) {
    const e = this.ed();
    if (!e) return;
    const c = e.chain().focus();
    ({
      bold: () => c.toggleBold(), italic: () => c.toggleItalic(), strike: () => c.toggleStrike(), code: () => c.toggleCode(),
      ul: () => c.toggleBulletList(), ol: () => c.toggleOrderedList(), todo: () => c.toggleTaskList(),
      quote: () => c.toggleBlockquote(), codeblock: () => c.toggleCodeBlock(), hr: () => c.setHorizontalRule(),
      table: () => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
      rowAdd: () => c.addRowAfter(), colAdd: () => c.addColumnAfter(), rowDel: () => c.deleteRow(),
      colDel: () => c.deleteColumn(), head: () => c.toggleHeaderRow(), tableDel: () => c.deleteTable(),
      undo: () => c.undo(), redo: () => c.redo(),
    } as Record<string, () => typeof c>)[what]?.().run();
  }

  link() {
    const e = this.ed();
    if (!e) return;
    if (this.linking()) { this.linking.set(false); e.commands.focus(); return; }
    this.linkHref.set(e.getAttributes('link')['href'] ?? '');
    this.linking.set(true);
    setTimeout(() => { const i = this.hrefBox()?.nativeElement; i?.focus(); i?.select(); });
  }

  setLink(href: string) {
    const e = this.ed();
    if (!e) return;
    href = href.trim();
    if (href && !/^(https?:|mailto:|\/)/.test(href)) href = 'https://' + href;
    const c = e.chain().focus().extendMarkRange('link');
    if (!href) c.unsetLink().run();
    else if (e.state.selection.empty && !e.isActive('link')) c.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    else c.setLink({ href }).run();
    this.linking.set(false);
  }

  ngOnDestroy() { this.dead = true; this.ed()?.destroy(); }
}
