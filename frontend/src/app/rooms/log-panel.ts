import {
  Component, ElementRef, computed, effect, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { LogLine } from '../api';
import { T, t } from '../i18n';
import { Toast } from '../toast';

/** What the level filter keeps: everything, the work and what it came to,
 *  or only what went wrong. */
type Kind = 'all' | 'work' | 'warn' | 'error';

/** "iot-fan/parts/lid: rebuilt against ..." - the file a line is about,
 *  said first. Shown apart from what happened to it, so the eye can run
 *  down either. */
const PATH = /^([\w.-]+(?:\/[\w.-]+)+):\s+/;

interface Row {
  id: string; level: LogLine['level']; time: string; when: string;
  path: string | null; text: string; day: string | null; start: boolean;
}

/** The log band under a room's view: a slim head (fold, title, how many
 *  lines, then filters and actions), the lines under it in a column of
 *  times, a dot for what kind of line it is, and the line itself.
 *
 *  The card around it is the room's (the 3D room moves it into the
 *  viewer's grid); this is what is inside. Folding is the room's too - it
 *  remembers it - so the open state comes in and the toggle goes out.
 *  Filtering, searching and clearing are this view's only: nothing is
 *  deleted, a reload shows every line again. */
@Component({
  selector: 'app-log-panel',
  imports: [T],
  host: { class: 'tcv-logp', '[class.tcv-logp-open]': 'open()' },
  template: `
<!-- No arrow: the head itself opens and folds the log, by click or Enter. -->
<div class="tcv-logp-head" (click)="headClick($event)" tabindex="0" role="button" [attr.aria-expanded]="open()"
     [title]="(open() ? 'Fold the log' : 'Open the log') | t" (keydown.enter)="headClick($any($event))" (keydown.space)="$event.preventDefault(); headClick($any($event))">
  <span class="tcv-logp-title">{{ 'Log' | t }}</span>
  <span class="tcv-logp-count">{{ lines().length }} {{ 'lines' | t }}</span>
  <ng-content select="[logHead]"></ng-content>
  <!-- Folded, the bar still tells what the log holds, at its right end: a kind
       there opens the log on it. -->
  @if (!open()) {
    <span class="tcv-logp-gap"></span>
    <div class="tcv-logp-seg" role="group" [attr.aria-label]="'Show' | t">
      @for (k of kinds; track k.id) {
        @if (k.id !== 'all') {
          <button (click)="kind.set(k.id); toggle.emit()" [title]="('Open the log' | t) + ': ' + (k.label | t)">
            <i class="tcv-logp-dot" [attr.data-level]="k.id === 'work' ? 'done' : k.id"></i>
            <span class="tcv-logp-segl">{{ k.label | t }}</span><em>{{ counts()[k.id] }}</em>
          </button>
        }
      }
    </div>
  }
  @if (open()) {
    <span class="tcv-logp-gap"></span>
    <div class="tcv-logp-seg" role="group" [attr.aria-label]="'Show' | t">
      @for (k of kinds; track k.id) {
        <button [attr.data-on]="kind() === k.id ? 1 : null" (click)="kind.set(k.id)">
          @if (k.id !== 'all') { <i class="tcv-logp-dot" [attr.data-level]="k.id === 'work' ? 'done' : k.id"></i> }
          <span class="tcv-logp-segl">{{ k.label | t }}</span><em>{{ counts()[k.id] }}</em>
        </button>
      }
    </div>
    <label class="tcv-logp-search">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L13.5 13.5"/></svg>
      <input [value]="query()" (input)="query.set($any($event.target).value)"
             (keydown.escape)="query.set('')" [placeholder]="'Filter lines' | t"
             spellcheck="false" autocomplete="off">
    </label>
    <button class="tcv-logp-ibtn" [attr.data-on]="follow() ? 1 : null" (click)="setFollow(!follow())"
            [title]="(follow() ? 'Following the newest line' : 'Follow the newest line') | t">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3.5 13.5h9"/></svg>
    </button>
    <button class="tcv-logp-ibtn" (click)="copy()" [disabled]="!rows().length" [title]="'Copy the lines shown' | t">
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>
    </button>
    <button class="tcv-logp-ibtn" (click)="clearView()" [disabled]="!rows().length"
            [title]="'Clear the view - the lines are kept' | t">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/></svg>
    </button>
  }
</div>
<div class="tcv-log-body" [class.hidden]="!open()">
  <div class="tcv-logp-wrap">
    <div #box class="tcv-logp-lines tcv-scroll" (scroll)="onScroll()">
      @for (r of rows(); track r.id) {
        @if (r.day) { <div class="tcv-logp-day">{{ r.day }}</div> }
        <div class="tcv-logp-row" [attr.data-level]="r.level" [class.tcv-logp-start]="r.start">
          <span class="tcv-logp-ts" [title]="r.when">{{ r.time }}</span>
          <i class="tcv-logp-dot" [attr.data-level]="r.level" [title]="r.level"></i>
          <span class="tcv-logp-msg">@if (r.path) {<span class="tcv-logp-path">{{ r.path }}</span>}{{ r.text }}</span>
        </div>
      } @empty {
        <p class="tcv-logp-empty">
          @if (clearedAt() && !query() && kind() === 'all') {
            {{ 'Cleared - new lines show here.' | t }}
            <button class="tcv-logp-link" (click)="clearedAt.set(null)">{{ 'Show earlier lines' | t }}</button>
          } @else if (lines().length) {
            {{ 'No line matches.' | t }}
            <button class="tcv-logp-link" (click)="reset()">{{ 'Show all' | t }}</button>
          } @else {
            {{ 'No activity yet.' | t }}
          }
        </p>
      }
    </div>
    @if (!follow() && unseen()) {
      <button class="tcv-logp-jump" (click)="setFollow(true)">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9M4.5 8.5L8 12l3.5-3.5"/></svg>
        {{ unseen() }} {{ 'new' | t }}
      </button>
    } @else if (!follow()) {
      <button class="tcv-logp-jump" (click)="setFollow(true)">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9M4.5 8.5L8 12l3.5-3.5"/></svg>
        {{ 'Jump to latest' | t }}
      </button>
    }
  </div>
  <div class="tcv-log-side tcv-scroll"><ng-content select="[logSide]"></ng-content></div>
</div>`,
})
export class LogPanel {
  lines = input<LogLine[]>([]);
  open = input(true);
  toggle = output<void>();

  readonly kinds: { id: Kind; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'work', label: 'Progress' },
    { id: 'warn', label: 'Warnings' }, { id: 'error', label: 'Errors' },
  ];
  kind = signal<Kind>('all');
  query = signal('');
  /** Lines at or before this moment are out of the view (cleared). */
  clearedAt = signal<string | null>(null);
  /** Keep the newest line in view, the way a terminal does. Reading back
   *  up turns it off; the pill or the button turns it on again. */
  follow = signal(true);
  /** Lines that came in while reading back up. */
  unseen = signal(0);

  private box = viewChild<ElementRef<HTMLDivElement>>('box');
  private lastId: string | undefined;

  /** What each filter would keep, before searching. */
  counts = computed(() => {
    const c = { all: 0, work: 0, warn: 0, error: 0 };
    for (const l of this.visible()) {
      c.all++;
      if (l.level === 'warn') c.warn++;
      else if (l.level === 'error') c.error++;
      else if (l.level === 'work' || l.level === 'done') c.work++;
    }
    return c;
  });

  private visible = computed(() => {
    const cut = this.clearedAt();
    return cut ? this.lines().filter(l => l.at > cut) : this.lines();
  });

  rows = computed<Row[]>(() => {
    const k = this.kind(), q = this.query().trim().toLowerCase();
    const out: Row[] = [];
    let day = '';
    for (const l of this.visible()) {
      if (k === 'work' ? l.level !== 'work' && l.level !== 'done' : k !== 'all' && l.level !== k) continue;
      if (q && !l.text.toLowerCase().includes(q)) continue;
      const d = new Date(l.at);
      const ok = !isNaN(d.getTime());
      const m = PATH.exec(l.text);
      const dayKey = ok ? d.toDateString() : '';
      out.push({
        id: l._id, level: l.level,
        time: ok ? d.toLocaleTimeString('en-GB', { hour12: false }) : l.at.slice(11, 19),
        when: ok ? d.toLocaleString() : l.at,
        path: m ? m[1] : null, text: m ? l.text.slice(m[0].length) : l.text,
        // A line from another day than the one above it says so once.
        day: out.length && dayKey !== day
          ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : null,
        start: l.text.startsWith('started:'),
      });
      day = dayKey;
    }
    return out;
  });

  constructor() {
    // A new last line scrolls down to it while following; otherwise it is
    // counted for the pill, and reading back up is not interrupted.
    effect(() => {
      const rows = this.lines();
      const last = rows[rows.length - 1]?._id;
      if (last === this.lastId) return;
      const was = this.lastId;
      this.lastId = last;
      untracked(() => {
        if (this.follow()) this.toBottom();
        else if (was) {
          const at = rows.findIndex(r => r._id === was);
          this.unseen.update(n => n + (at < 0 ? rows.length : rows.length - 1 - at));
        }
      });
    });
    // Opened, or filtered: land on the newest line again while following.
    effect(() => {
      this.open(); this.rows();
      untracked(() => { if (this.follow()) this.toBottom(); });
    });
  }

  /** The whole head folds the band, not just its button - except where it
   *  holds a control of its own. */
  headClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('button, input, label, a, .tcv-logp-seg')) return;
    this.toggle.emit();
  }

  setFollow(on: boolean) {
    this.follow.set(on);
    if (on) { this.unseen.set(0); this.toBottom(); }
  }

  onScroll() {
    const el = this.box()?.nativeElement;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== this.follow()) this.follow.set(atBottom);
    if (atBottom) this.unseen.set(0);
  }

  reset() { this.kind.set('all'); this.query.set(''); this.clearedAt.set(null); }

  clearView() {
    const all = this.lines();
    this.clearedAt.set(all[all.length - 1]?.at ?? null);
    this.unseen.set(0);
    this.follow.set(true);
  }

  copy() {
    const text = this.rows().map(r => `${r.time}  ${r.path ? r.path + ': ' : ''}${r.text}`).join('\n');
    navigator.clipboard?.writeText(text).then(
      () => Toast.show(t('Copied') + ` · ${this.rows().length} ${t('lines')}`, { tone: 'ok', ms: 2000 }),
      () => Toast.show(t('Could not copy.'), { tone: 'danger' }));
  }

  private toBottom() {
    // Twice: once now, once after the rows are laid out.
    const go = () => { const el = this.box()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; };
    setTimeout(go); setTimeout(go, 120);
  }
}
