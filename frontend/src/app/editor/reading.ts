import { ChangeDetectionStrategy, Component, Injectable, computed, inject, input, signal, untracked } from '@angular/core';
import { Chat, Questions, Translation } from '../api';
import { T, t } from '../i18n';

/** What the agent wrote, in the reader's language.
 *
 *  The agents write English. A reader who would rather read Turkish - or
 *  German - picks a language once (kept in this browser), and an agent's
 *  question is shown translated from then on, with the original a click
 *  away. The server translates with the "Reading translation" job of
 *  Settings > LLM settings and keeps each translation on the question, so
 *  a question is paid for once per language (backend/reading.py).
 *
 *  The answer still goes back as written: an option clicked is the
 *  agent's own English option, whatever language it was read in. */

export interface ReadLang { id: string; label: string }

/** '' is the original. The id is what the model is told, the label what
 *  the reader sees - each language in its own name. */
export const READ_LANGS: ReadLang[] = [
  { id: '', label: 'English (original)' },
  { id: 'Turkish', label: 'Türkçe' },
  { id: 'German', label: 'Deutsch' },
  { id: 'Spanish', label: 'Español' },
  { id: 'French', label: 'Français' },
  { id: 'Italian', label: 'Italiano' },
  { id: 'Russian', label: 'Русский' },
  { id: 'Chinese (Simplified)', label: '中文' },
  { id: 'Japanese', label: '日本語' },
  { id: 'Arabic', label: 'العربية' },
];

const KEY = 'redline.question.lang';

function remembered(): string {
  try { return (localStorage.getItem(KEY) ?? '').trim().slice(0, 40); } catch { return ''; }
}

export type ReadKind = 'question' | 'chat';

export interface ReadSlot {
  state: 'loading' | 'done' | 'error';
  data?: Translation;
  error?: string;
  /** The reader asked to see the original again. */
  original?: boolean;
}

@Injectable({ providedIn: 'root' })
export class Reading {
  private asks = inject(Questions);
  private chat = inject(Chat);

  /** The language to read in; '' for the original. */
  lang = signal<string>(remembered());
  private slots = signal<Record<string, ReadSlot>>({});

  setLang(v: string) {
    const l = (v || '').trim().slice(0, 40);
    this.lang.set(l);
    try { localStorage.setItem(KEY, l); } catch { /* private window */ }
  }

  private key(kind: ReadKind, id: string) { return `${kind}:${id}:${this.lang()}`; }

  /** Where the translation of this one stands, in the language chosen. */
  slot(kind: ReadKind, id: string): ReadSlot | null {
    return this.lang() ? this.slots()[this.key(kind, id)] ?? null : null;
  }

  /** What to show in place of the original, or null to show the original. */
  shown(kind: ReadKind, id: string): Translation | null {
    const s = this.slot(kind, id);
    return s?.state === 'done' && !s.original && s.data && !s.data.original ? s.data : null;
  }

  /** Ask for it, unless it is here or on its way. `again` after an error. */
  ensure(kind: ReadKind, id: string, again = false) {
    untracked(() => {
      const lang = this.lang();
      if (!lang) return;
      const k = this.key(kind, id);
      const had = this.slots()[k];
      if (had && !(again && had.state === 'error')) return;
      this.put(k, { state: 'loading' });
      const call = kind === 'question' ? this.asks.translate(id, lang) : this.chat.translate(id, lang);
      call.subscribe({
        next: data => this.put(k, { state: 'done', data }),
        error: err => this.put(k, {
          state: 'error',
          error: String(err?.error?.detail || err?.message || t('the server did not answer')).slice(0, 200),
        }),
      });
    });
  }

  toggleOriginal(kind: ReadKind, id: string) {
    const k = this.key(kind, id), s = this.slots()[k];
    if (s) this.put(k, { ...s, original: !s.original });
  }

  private put(k: string, s: ReadSlot) { this.slots.update(all => ({ ...all, [k]: s })); }
}

/** The language picker: a chip-sized select, and a field for a language
 *  that is not on the list. Accent only while it is translating. */
@Component({
  selector: 'rl-reading-pick',
  imports: [T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="inline-flex items-center gap-1">
      <select class="tcv-chip min-w-0" [class.tcv-chip-accent]="!!r.lang()"
              [style.max-width]="compact() ? '5.5rem' : null"
              [attr.aria-label]="'Read the agent in another language' | t"
              [title]="'Read the agent in another language' | t"
              (change)="pick($any($event.target))">
        @for (l of langs; track l.id) {
          <option [value]="l.id" [selected]="l.id === r.lang()">{{ l.label | t }}</option>
        }
        @if (custom(); as c) { <option [value]="c" selected>{{ c }}</option> }
        <option value="__other__">{{ 'Other…' | t }}</option>
      </select>
      @if (typing()) {
        <input #other class="tcv-field w-28 px-1.5 py-0.5" maxlength="40"
               [placeholder]="'Language' | t" [title]="'Type a language, Enter to use it' | t"
               (keydown.enter)="useOther(other.value)" (keydown.escape)="typing.set(false)">
        <button class="tcv-chip" (click)="useOther(other.value)">{{ 'use' | t }}</button>
      }
    </span>
  `,
})
export class ReadingPick {
  r = inject(Reading);
  /** Narrow, for the thread's header, where the Urgent switch has to fit too. */
  compact = input(false);
  langs = READ_LANGS;
  typing = signal(false);
  /** A language typed in, shown as an option of its own. */
  custom = computed(() => {
    const l = this.r.lang();
    return l && !READ_LANGS.some(x => x.id === l) ? l : null;
  });

  pick(sel: HTMLSelectElement) {
    if (sel.value === '__other__') {
      sel.value = this.r.lang();             // stays on the current one until a name is typed
      this.typing.set(true);
      setTimeout(() => (sel.parentElement?.querySelector('input') as HTMLInputElement | null)?.focus());
      return;
    }
    this.typing.set(false);
    this.r.setLang(sel.value);
  }

  useOther(v: string) {
    const l = v.trim();
    if (!l) return;
    // A known language typed by its own name is that language.
    const known = READ_LANGS.find(x => x.label.toLowerCase() === l.toLowerCase()
                                       || x.id.toLowerCase() === l.toLowerCase());
    this.r.setLang(known ? known.id : l);
    this.typing.set(false);
  }
}

/** One line under what was translated: on its way, failed, or by which
 *  model - with the original a click away. `offer` puts a "translate"
 *  chip where nothing has been asked yet (the thread's lines, which are
 *  translated on request rather than all at once). */
@Component({
  selector: 'rl-reading-note',
  imports: [T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (r.lang()) {
      @if (r.slot(kind(), id()); as s) {
        @switch (s.state) {
          @case ('loading') {
            <span class="animate-pulse" style="color: var(--ink-dim)">{{ 'translating…' | t }}</span>
          }
          @case ('error') {
            <span class="inline-flex max-w-full items-center gap-1" style="color: var(--danger)">
              <span class="min-w-0 truncate" [title]="s.error ?? ''">{{ 'could not translate' | t }}: {{ s.error }}</span>
              <button class="tcv-chip shrink-0 px-1 py-0" (click)="r.ensure(kind(), id(), true)">{{ 'retry' | t }}</button>
            </span>
          }
          @case ('done') {
            @if (!s.data?.original) {
              <span style="color: var(--ink-dim)">
                {{ 'translated by' | t }} <span class="mono">{{ short(s.data?.model) }}</span> ·
                <button class="underline decoration-dotted underline-offset-2 hover:opacity-80"
                        style="color: var(--ink-dim)" (click)="r.toggleOriginal(kind(), id())">
                  {{ (s.original ? 'show translation' : 'show original') | t }}
                </button>
              </span>
            }
          }
        }
      } @else if (offer()) {
        <button class="tcv-chip px-1 py-0" (click)="r.ensure(kind(), id())"
                [title]="r.lang()">{{ 'translate' | t }}</button>
      }
    }
  `,
})
export class ReadingNote {
  r = inject(Reading);
  kind = input.required<ReadKind>();
  id = input.required<string>();
  offer = input(false);

  short(model?: string) { return (model || '?').split('/').pop(); }
}
