import { Component, ElementRef, signal, viewChild } from '@angular/core';
import { T } from './i18n';

/** The application's one way to say "done", "could not" or "undo?" in
 *  passing. Any code can call it, from anywhere:
 *
 *    Toast.show(t('Saved.'));
 *    Toast.show(t('Could not save it.'), { tone: 'danger' });
 *    Toast.show(t('Archived.'), { action: { label: t('Undo'), run: () => unarchive() } });
 *    const id = Toast.show(text, { ms: 2000 });  Toast.dismiss(id);
 *
 *  The text is already translated. The stack is <app-toasts />, mounted
 *  once in the shell (app.ts): bottom right (bottom centre on a phone),
 *  three at most - the oldest goes when a fourth comes - and the newest at
 *  the bottom. Each slides in from the right in 160 ms and goes by itself
 *  after 4 s, or 8 s when it carries an action; the pointer over the stack
 *  holds every clock, and Esc (with the focus in a toast) or its × closes
 *  it. The toasts are polite status lines for a screen reader; a danger
 *  one is an alert. Errors that belong to a field stay beside the field. */
export type ToastTone = 'ok' | 'warn' | 'danger' | 'info';
/** Why a toast went: its time ran out, its action was pressed, or it was closed (×, Esc, pushed out, dismiss()). */
export type ToastEnd = 'timeout' | 'action' | 'closed';

export interface ToastOptions {
  tone?: ToastTone;
  /** One button: "Undo", "Show". Pressing it closes the toast, then runs. */
  action?: { label: string; run: () => void };
  /** How long it stays, in ms: 4000, or 8000 with an action. */
  ms?: number;
  /** Told once when the toast goes, and why - e.g. to send a delete that "Undo" could still have stopped. */
  onClose?: (why: ToastEnd) => void;
}

interface Item {
  id: number; text: string; tone: ToastTone; action?: ToastOptions['action']; onClose?: ToastOptions['onClose'];
  ms: number;
  /** Time left on its clock, and when that clock was last started (0 while held). */
  left: number; since: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const MAX = 3;
const items = signal<Item[]>([]);
let next = 1;
let held = false;

function start(it: Item) {
  if (held || it.timer) return;
  it.since = performance.now();
  it.timer = setTimeout(() => close(it.id, 'timeout'), it.left);
}

function hold(it: Item) {
  if (!it.timer) return;
  clearTimeout(it.timer);
  it.timer = null;
  it.left = Math.max(600, it.left - (performance.now() - it.since));
}

function close(id: number, why: ToastEnd) {
  const it = items().find(x => x.id === id);
  if (!it) return;
  if (it.timer) clearTimeout(it.timer);
  it.timer = null;
  items.update(l => l.filter(x => x !== it));
  if (!items().length) held = false;
  it.onClose?.(why);
}

export class Toast {
  /** Shows a toast; returns its id for dismiss(). */
  static show(text: string, o: ToastOptions = {}): number {
    const ms = o.ms ?? (o.action ? 8000 : 4000);
    const it: Item = { id: next++, text, tone: o.tone ?? 'info', action: o.action, onClose: o.onClose,
                       ms, left: ms, since: 0, timer: null };
    items.update(l => [...l, it]);
    while (items().length > MAX) close(items()[0].id, 'closed');
    start(it);
    return it.id;
  }
  /** Closes one toast, or every one. */
  static dismiss(id?: number) {
    for (const it of items()) if (id == null || it.id === id) close(it.id, 'closed');
  }
}

@Component({
  selector: 'app-toasts',
  imports: [T],
  template: `
<div #stack class="toast-stack" (mouseenter)="pause(true)" (mouseleave)="pause(false)" (focusin)="pause(true)" (focusout)="pause(false)">
  @for (it of list(); track it.id) {
    <div class="toast-item" [attr.data-tone]="it.tone" [attr.role]="it.tone === 'danger' ? 'alert' : 'status'"
         [attr.aria-live]="it.tone === 'danger' ? 'assertive' : 'polite'" aria-atomic="true"
         animate.leave="tcv-leave" (keydown.escape)="$event.stopPropagation(); dismiss(it.id)">
      <span class="toast-text">{{ it.text }}</span>
      @if (it.action; as a) {
        <button type="button" class="toast-act" (click)="act(it)">{{ a.label }}</button>
      }
      <button type="button" class="toast-x" (click)="dismiss(it.id)" [attr.aria-label]="'Close' | t" [title]="'Close' | t">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      @if (it.action) { <span class="toast-bar" [style.animation-duration.ms]="it.ms"></span> }
    </div>
  }
</div>`,
  styles: [`
.toast-stack { position: fixed; right: 16px; bottom: 16px; z-index: 10050; display: flex; flex-direction: column;
  align-items: flex-end; gap: 8px; width: min(380px, calc(100vw - 32px)); pointer-events: none; }
.toast-item { position: relative; display: flex; align-items: center; gap: 10px; max-width: 100%; box-sizing: border-box;
  min-height: 40px; padding: 8px 6px 8px 12px; overflow: hidden; pointer-events: auto;
  font-size: 12.5px; line-height: 1.4; color: var(--ink); background: var(--surface);
  border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 6px;
  box-shadow: 0 8px 24px var(--shadow-hard); }
.toast-item[data-tone="ok"] { border-left-color: var(--ok); }
.toast-item[data-tone="warn"] { border-left-color: var(--warn); }
.toast-item[data-tone="danger"] { border-left-color: var(--danger); }
.toast-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.toast-act { flex: none; height: 26px; padding: 0 10px; font: inherit; font-weight: 600; color: var(--accent);
  background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
.toast-act:hover { background: var(--hover); }
.toast-x { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0;
  color: var(--ink-dim); background: none; border: 0; border-radius: 4px; cursor: pointer; }
.toast-x:hover { color: var(--ink); background: var(--hover); }
.toast-x svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.toast-act:focus-visible, .toast-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* the time an action is left open, running out */
.toast-bar { position: absolute; left: 0; bottom: 0; width: 100%; height: 2px; background: var(--accent);
  transform-origin: left; animation: toast-shrink linear forwards; }
.toast-stack:hover .toast-bar, .toast-stack:focus-within .toast-bar { animation-play-state: paused; }
@keyframes toast-shrink { to { transform: scaleX(0); } }
@keyframes toast-in { from { opacity: 0; translate: 24px 0; } }
@keyframes toast-in-up { from { opacity: 0; translate: 0 16px; } }
@keyframes toast-out { to { opacity: 0; translate: 24px 0; } }
@media (prefers-reduced-motion: no-preference) {
  .toast-item { animation: toast-in var(--tcv-t-panel, 160ms) var(--tcv-ease, ease-out); }
  .toast-item.tcv-leave { animation: toast-out var(--tcv-t-out, 90ms) ease-in forwards !important; }
}
@media (prefers-reduced-motion: reduce) { .toast-bar { animation: none; } }
@media (max-width: 768px) {
  .toast-stack { left: 12px; right: 12px; bottom: 12px; align-items: stretch; width: auto; }
  @media (prefers-reduced-motion: no-preference) { .toast-item { animation-name: toast-in-up; } }
}
`],
})
export class Toasts {
  list = items.asReadonly();
  private stack = viewChild.required<ElementRef<HTMLElement>>('stack');
  dismiss(id: number) { close(id, 'closed'); this.settle(); }
  act(it: Item) {
    const run = it.action?.run;
    close(it.id, 'action');
    this.settle();
    run?.();
  }
  /** A toast closed under the focus takes the focus with it, and no focusout
   *  says so: the clocks start again unless the pointer is still on the stack. */
  private settle() {
    setTimeout(() => {
      const el = this.stack().nativeElement;
      if (!el.contains(document.activeElement) && !el.matches(':hover')) this.pause(false);
    });
  }
  /** The pointer or the focus on the stack holds every clock; leaving it starts them again. */
  pause(on: boolean) {
    if (held === on) return;
    held = on;
    for (const it of items()) on ? hold(it) : start(it);
  }
}
