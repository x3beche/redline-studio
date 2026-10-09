import { Component, DestroyRef, Injectable, ViewEncapsulation, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { T } from '../i18n';

/** The next question, suggested in an empty composer (backend/suggest.py).
 *
 *  When an answer ends in the conversation (or room thread) that is open,
 *  and the composer stays empty and untouched for the wait chosen in
 *  Settings > LLM settings ("Next-question suggestion", 60 s unless
 *  changed), one suggestion is asked for and shown dimmed in the composer:
 *  Tab (or →, or the chip) takes it into the composer - it is never sent
 *  by itself - and typing anything, or Esc, puts it away. Switching the
 *  conversation forgets it. Off in the settings: nothing is asked.
 *
 *  A composer owns one `ComposerSuggest`, made with a function that says
 *  where it stands (`SuggestState`), and passes its keys through `key()`. */

/** On/off and the wait, as the server has them: read once, again before
 *  every wait starts, and set at once by the settings page on a change. */
@Injectable({ providedIn: 'root' })
export class SuggestConf {
  private http = inject(HttpClient);
  on = signal(false);
  /** Seconds of quiet after an answer before a suggestion is asked for. */
  delay = signal(60);
  private loaded = false;

  /** The settings now; `then` runs with them (or with the last known, if the server did not answer). */
  load(then?: () => void) {
    this.http.get<{ on: boolean; delay: number }>('/api/suggest').subscribe({
      next: r => { this.set(r); then?.(); },
      error: () => then?.(),
    });
  }
  ensure() { if (!this.loaded) { this.loaded = true; this.load(); } }
  set(r: { on?: boolean; delay?: number }) {
    if (r.on !== undefined) this.on.set(!!r.on);
    if (r.delay) this.delay.set(r.delay);
  }
}

export interface SuggestState {
  kind: 'cc' | 'room';
  /** The conversation (or room) open, as loaded; null while there is none. */
  id: string | null;
  /** The id of its last line when that is a finished answer, null when it
   *  is not, undefined while its lines are not here yet. */
  last: string | null | undefined;
  /** An answer is being written in it. */
  busy: boolean;
  /** The person may write here. */
  may: boolean;
  /** Nothing typed, attached or being edited in the composer. */
  empty: boolean;
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn', 'OS']);

export class ComposerSuggest {
  private http = inject(HttpClient);
  readonly conf = inject(SuggestConf);
  /** The suggestion shown, if any. */
  text = signal<string | null>(null);
  private id: string | null = null;
  /** The last answer seen in the open conversation: a new one starts the wait. */
  private base: string | null | undefined = undefined;
  /** The conversation a wait runs for, and the wait. */
  private armed: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private asking = 0;

  constructor(private state: () => SuggestState, private accept: (text: string) => void) {
    this.conf.ensure();
    inject(DestroyRef).onDestroy(() => this.cancel());
    effect(() => {
      const s = this.state();
      untracked(() => this.follow(s));
    });
  }

  private follow(s: SuggestState) {
    if (s.id !== this.id) {                       // another conversation: start over
      this.cancel();
      this.id = s.id;
      this.base = s.last;
      return;
    }
    if (!s.empty && this.text()) this.text.set(null);
    if (s.last === undefined) return;
    if (this.base === undefined) { this.base = s.last; return; }   // its lines just came
    if (s.last === this.base) return;
    this.base = s.last;
    // A new answer: the wait starts (whether another is being written by
    // then is looked at when it is over).
    if (s.last) this.arm();
    else this.stop();
  }

  /** An answer just ended: wait for quiet, then ask. The settings are read
   *  again first, so a change made meanwhile counts from this answer on. */
  private arm() {
    this.stop();
    this.text.set(null);
    const id = this.id;
    this.armed = id;
    this.conf.load(() => {
      if (this.armed !== id || !this.conf.on()) { if (this.armed === id) this.armed = null; return; }
      this.wait();
    });
  }

  private wait() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), Math.max(1, this.conf.delay()) * 1000);
  }

  private fire() {
    const s = this.state(), id = this.armed;
    this.armed = null;
    if (!id || s.id !== id || !s.last || s.busy || !s.may || !s.empty || !this.conf.on()) return;
    const n = ++this.asking;
    this.http.post<{ text: string } | null>('/api/suggest', { kind: s.kind, id }).subscribe({
      next: r => {
        const now = this.state();
        if (n !== this.asking || now.id !== id || !now.empty || now.busy || !r?.text) return;
        this.text.set(r.text);
      },
      error: () => {},
    });
  }

  private stop() { clearTimeout(this.timer); this.timer = undefined; this.armed = null; }

  /** Forget the suggestion and any wait (another conversation, the page closed). */
  cancel() { this.stop(); this.asking++; this.text.set(null); }

  /** Take the suggestion into the composer (not sent). */
  use() {
    const s = this.text();
    if (!s) return;
    this.text.set(null);
    this.accept(s);
  }

  /** The composer's keys, first: Tab or → takes the suggestion, Esc puts it
   *  away, anything typed puts it away too; while a wait runs, a key starts
   *  it again. True when the key was used here. */
  key(e: KeyboardEvent): boolean {
    if (MODIFIERS.has(e.key)) return false;
    if (this.text()) {
      if ((e.key === 'Tab' || e.key === 'ArrowRight') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
        e.preventDefault();
        this.use();
        return true;
      }
      this.text.set(null);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return true; }
      return false;
    }
    if (this.armed && this.timer) this.wait();
    return false;
  }
}

/** The small "Tab to use" chip shown with a suggestion; a click takes it.
 *  Also holds the ghost text's look (`tcv-sg-ghost` on the composer's
 *  textarea), so the composers need no stylesheet of their own for it. */
@Component({
  selector: 'rl-suggest-chip',
  imports: [T],
  encapsulation: ViewEncapsulation.None,
  host: { style: 'display: contents' },
  template: `
@if (sg().text()) {
  <button type="button" class="tcv-sg-chip" (mousedown)="$event.preventDefault()" (click)="sg().use()"
          [title]="'Suggested next question - Tab to use, Esc to dismiss' | t">
    <kbd>Tab</kbd><span>{{ 'Tab to use' | t }}</span>
  </button>
}`,
  styles: `
.tcv-cc-composer textarea.tcv-sg-ghost::placeholder { color: var(--ink-dim); opacity: .8; font-style: italic; }
.tcv-sg-chip { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px;
  font-size: 11px; color: var(--ink-dim); background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 4px; cursor: pointer; white-space: nowrap; }
.tcv-sg-chip:hover { color: var(--ink); background: var(--hover); }
.tcv-sg-chip kbd { font: 10px 'IBM Plex Mono', ui-monospace, monospace; padding: 0 3px; border: 1px solid var(--line); border-radius: 3px; }
`,
})
export class SuggestChip {
  sg = input.required<ComposerSuggest>();
}
