import { ChangeDetectionStrategy, Component, Injectable, computed, inject, input, signal, untracked } from '@angular/core';
import { Chat, Questions, Translation } from '../api';
import { T, t } from '../i18n';
import { Langs, TgLangPicker } from '../telegram-langs';

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

/** The languages are the app's one list (telegram-langs.ts: every ISO
 *  639-1 code, by its own name, searchable) - the same one a person's
 *  Telegram question language is picked from. What is kept and sent is the
 *  code; the server tells the model the language's name (backend/reading.py).
 *  '' is the original (English). */

/** What this browser kept before the list was the full one: a name. */
const OLD_NAMES: Record<string, string> = {
  turkish: 'tr', german: 'de', spanish: 'es', french: 'fr', italian: 'it', russian: 'ru',
  'chinese (simplified)': 'zh', japanese: 'ja', arabic: 'ar', english: '',
};

const KEY = 'redline.question.lang';

function remembered(): string {
  try {
    const v = (localStorage.getItem(KEY) ?? '').trim().slice(0, 40);
    const old = OLD_NAMES[v.toLowerCase()];
    return old ?? (v === 'en' ? '' : v);
  } catch { return ''; }
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
    let l = (v || '').trim().slice(0, 40);
    if (l === 'en') l = '';                    // English is the original
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

/** The language picker: a chip that opens the app's searchable list of
 *  every language (telegram-langs.ts), English - the original - first.
 *  Accent only while it is translating. */
@Component({
  selector: 'rl-reading-pick',
  imports: [T, TgLangPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-tg-lang-picker [chip]="true" [accent]="!!r.lang()" [narrow]="compact()" [place]="place()"
                        [label]="name()" [current]="r.lang() || 'en'"
                        top="en" [topLabel]="'English (original)'" [exclude]="['en']"
                        [hint]="'Read the agent in another language' | t"
                        (picked)="r.setLang($event)" />
  `,
})
export class ReadingPick {
  r = inject(Reading);
  private langs = inject(Langs);
  /** Narrow, for the thread's header, where the Urgent switch has to fit too. */
  compact = input(false);
  /** Where the list opens (TgLangPicker.place). */
  place = input('right');
  /** The language in its own name; a name kept from before the full list as it is. */
  name = computed(() => {
    const c = this.r.lang();
    if (!c) return 'English (original)';
    return this.langs.list().find(l => l.code === c)?.native ?? c;
  });
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
