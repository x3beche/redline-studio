import { Component, ElementRef, OnDestroy, computed, effect, signal, viewChild } from '@angular/core';
import { T } from './i18n';

/** The application's own question box, in place of the browser's confirm(),
 *  alert() and prompt(): those freeze the page, ignore the theme and cannot
 *  be driven in a test. Any code can ask, from anywhere - a component, a
 *  plain function - and await the answer:
 *
 *    if (!await Confirm.ask({ title: t('Delete "{x}"?'), text: t('…'), ok: t('Delete'), danger: true })) return;
 *    await Confirm.say({ title: t('Saved.') });
 *    const name = await Confirm.input({ title: t('Folder name'), ok: t('Create') });   // null when cancelled
 *
 *  One box at a time: a second question waits for the first one's answer.
 *  The box itself is <app-confirm />, mounted once in the shell (app.ts). */
export interface AskOptions {
  /** The question, short: 'Delete "Buy list"?'. Already translated. */
  title: string;
  /** A line or two on what goes with it. Line breaks are kept. */
  text?: string;
  /** The button that goes ahead: 'Delete'. OK by default. */
  ok?: string;
  /** The button that does not: Cancel by default. */
  cancel?: string;
  /** Something is lost: the button is red and Cancel has the focus. */
  danger?: boolean;
}

export interface InputOptions extends AskOptions {
  /** What is in the field to begin with. */
  value?: string;
  placeholder?: string;
}

type Kind = 'ask' | 'say' | 'input';
interface Request { kind: Kind; o: InputOptions; done: (v: boolean | string | null) => void }

const queue = signal<Request[]>([]);

function push<R>(kind: Kind, o: InputOptions): Promise<R> {
  return new Promise<R>(done => queue.update(q => [...q, { kind, o, done: done as (v: unknown) => void }]));
}

export class Confirm {
  /** Yes or no: true for the OK button, false for Cancel, Esc or a click beside the box. */
  static ask(o: AskOptions): Promise<boolean> { return push<boolean>('ask', o); }
  /** A message with one button; resolves when it is closed. */
  static say(o: AskOptions | string): Promise<void> {
    return push<void>('say', typeof o === 'string' ? { title: o } : o);
  }
  /** A line of text: what was typed (trimmed), or null when cancelled or left empty. */
  static input(o: InputOptions): Promise<string | null> { return push<string | null>('input', o); }
}

@Component({
  selector: 'app-confirm',
  imports: [T],
  template: `
@if (cur(); as r) {
<div class="cf-scrim" (mousedown)="downOnScrim = $event.target === $event.currentTarget"
     (click)="$event.target === $event.currentTarget && downOnScrim && answer(false)">
  <div #card class="cf-card" role="alertdialog" aria-modal="true" aria-labelledby="cf-title"
       [attr.aria-describedby]="r.o.text ? 'cf-text' : null">
    <h2 id="cf-title" class="cf-title">{{ r.o.title }}</h2>
    @if (r.o.text) { <p id="cf-text" class="cf-text">{{ r.o.text }}</p> }
    @if (r.kind === 'input') {
      <input #field class="tcv-field cf-field" type="text" spellcheck="false" autocomplete="off"
             [value]="r.o.value ?? ''" [placeholder]="r.o.placeholder ?? ''" aria-labelledby="cf-title" />
    }
    <div class="cf-row">
      @if (r.kind !== 'say') {
        <button #cancel type="button" class="tcv-btn cf-btn" (click)="answer(false)">{{ r.o.cancel ?? ('Cancel' | t) }}</button>
      }
      <button #ok type="button" class="tcv-btn cf-btn cf-ok" [attr.data-danger]="r.o.danger ? 1 : null"
              (click)="answer(true)">{{ r.o.ok ?? ('OK' | t) }}</button>
    </div>
  </div>
</div>
}`,
  styles: [`
.cf-scrim { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(0, 0, 0, .5); }
.cf-card { display: flex; flex-direction: column; gap: 8px; width: min(400px, 100%); max-height: 86vh; overflow-y: auto;
  box-sizing: border-box; padding: 18px 18px 14px; color: var(--ink); background: var(--surface);
  border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 12px 36px var(--shadow-hard); }
.cf-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.cf-text { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink-dim); white-space: pre-line; overflow-wrap: anywhere; }
.cf-field { width: 100%; box-sizing: border-box; height: 30px; padding: 5px 8px; font-size: 12.5px; }
.cf-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.cf-btn { min-width: 76px; height: 28px; padding: 0 12px; font-size: 12.5px; }
.cf-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cf-ok { color: var(--ink-on-accent); background: var(--accent); border-color: var(--accent); }
.cf-ok:hover { background: var(--accent); filter: brightness(1.08); }
.cf-ok[data-danger] { color: #fff; background: var(--danger); border-color: var(--danger); }
.cf-ok[data-danger]:hover { background: var(--danger); }
`],
})
export class ConfirmHost implements OnDestroy {
  cur = computed(() => queue()[0] ?? null);
  private card = viewChild<ElementRef<HTMLElement>>('card');
  private field = viewChild<ElementRef<HTMLInputElement>>('field');
  private cancelBtn = viewChild<ElementRef<HTMLButtonElement>>('cancel');
  private okBtn = viewChild<ElementRef<HTMLButtonElement>>('ok');
  downOnScrim = false;
  /** Where the focus was before the first box of a run: it goes back there. */
  private back: HTMLElement | null = null;
  private shown: Request | null = null;

  constructor() {
    effect(() => {
      const r = this.cur();
      if (!r || r === this.shown) return;
      if (!this.shown) this.back = document.activeElement as HTMLElement | null;
      this.shown = r;
      // After the box is drawn: the field, otherwise the asked-for button.
      setTimeout(() => {
        if (this.cur() !== r) return;
        const f = this.field()?.nativeElement;
        if (r.kind === 'input' && f) { f.focus(); f.select(); return; }
        // The asked-for button holds the focus, a delete too: Enter does it, Esc or Tab to Cancel backs out.
        this.okBtn()?.nativeElement.focus();
      });
    });
    window.addEventListener('keydown', this.key, true);
    document.addEventListener('focusin', this.keepFocus, true);
  }

  ngOnDestroy() {
    window.removeEventListener('keydown', this.key, true);
    document.removeEventListener('focusin', this.keepFocus, true);
  }

  answer(yes: boolean) {
    const r = this.cur();
    if (!r) return;
    let v: boolean | string | null = yes;
    if (r.kind === 'input') v = yes ? (this.field()?.nativeElement.value.trim() || null) : null;
    queue.update(q => q.slice(1));
    if (!queue().length) {
      this.shown = null;
      const back = this.back;
      this.back = null;
      if (back?.isConnected) back.focus();
    }
    r.done(v);
  }

  /** While a box is open the keys are its own: nothing reaches the rooms'
   *  shortcuts. Esc cancels, Tab goes round inside the box, Enter in the
   *  field is OK; on a button Enter and Space press it as usual. */
  private key = (e: KeyboardEvent) => {
    const r = this.cur();
    if (!r) return;
    const card = this.card()?.nativeElement;
    const inside = !!card && card.contains(e.target as Node);
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); this.answer(false); return; }
    if (e.key === 'Enter' && r.kind === 'input' && e.target === this.field()?.nativeElement) {
      e.preventDefault(); this.answer(true); return;
    }
    if (e.key === 'Tab' && card) {
      e.preventDefault();
      const all = [...card.querySelectorAll<HTMLElement>('input, button')];
      if (!all.length) return;
      const i = all.indexOf(document.activeElement as HTMLElement);
      const n = i < 0 ? 0 : (i + (e.shiftKey ? all.length - 1 : 1)) % all.length;
      all[n].focus();
      return;
    }
    if (!inside) e.preventDefault();
  };

  /** Focus that wanders out of the box (a click, a script) is brought back. */
  private keepFocus = (e: FocusEvent) => {
    const card = this.card()?.nativeElement;
    if (!this.cur() || !card || card.contains(e.target as Node)) return;
    e.stopImmediatePropagation();
    (this.field() ?? this.okBtn() ?? this.cancelBtn())?.nativeElement.focus();
  };
}
