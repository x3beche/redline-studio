import {
  Component, ElementRef, Injectable, TemplateRef, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Chat, ChatLine, Question, Questions } from '../api';
import { Auth } from '../auth';
import { Markdown, Segment, TaskBlock, splitTasks } from '../markdown';
import { T, t } from '../i18n';
import { Selection } from '../selection';
import { TopBar } from '../topbar';
import { WORKSPACES } from '../workspaces';
import { TaskBlockView } from './task-block';
import { Reading, ReadingNote, ReadingPick } from '../editor/reading';
import { AttachChips, ChatAttach, MentionPics, PAPERCLIP, isPicture } from './chat-attach';
import { FilesApi } from './files-model';
import { ComposerSuggest, SuggestChip } from './suggest';

/** The longest line a room thread takes (backend/main.py CHAT_MAX). */
const CHAT_MAX = 20_000;

/** The rooms' agent threads, in the Chat tab.
 *
 *  Each room with an agent (backend/chat.py ROOMS: the 3D room and the PCB
 *  room) has one thread with the note-applying agent: the person writes,
 *  the agent picks it up and answers over its CLI, and its questions wait
 *  for an answer. It used to be a box under the queue ("ask the agent");
 *  now it is a pinned entry at the top of the Chat tab's list, opened in
 *  the same place as an AI conversation. Nothing here calls a model: the
 *  other end is the agent, so there is no model picker and no speed.
 *
 *  The same storage as before - /api/chat and /api/questions - so Telegram's
 *  /ask and the agent's CLI land in the same thread.
 */

export interface ThreadRoom {
  room: string; count: number; waiting: number; urgent: number;
  last: { role: string; text: string; at: string; by?: string | null } | null;
  /** When the agent last wrote (the last 99 times): what is unread is counted from these. */
  agent_at: string[];
}

const SEEN_KEY = 'redline.thread.seen';

function readSeen(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** Which threads there are, what is unread in each, and the questions the
 *  agent is waiting on - polled for the whole app (the Chat tab's badge,
 *  the list's pinned rooms, the palette). Unread is per browser: the
 *  agent's lines since this browser last had the thread open, plus every
 *  open question of that room. */
@Injectable({ providedIn: 'root' })
export class AgentThreads {
  private http = inject(HttpClient);
  private asks = inject(Questions);
  private bar = inject(TopBar);
  private sel = inject(Selection);

  rooms = signal<ThreadRoom[]>([]);
  questions = signal<Question[]>([]);
  private seen = signal<Record<string, string>>(readSeen());
  private timer?: ReturnType<typeof setInterval>;

  /** In the top bar's order (Settings > Top bar), so the list reads like the tabs. */
  ordered = computed(() => {
    const order = this.bar.order();
    const at = (r: string) => { const i = order.indexOf(r); return i < 0 ? 99 : i; };
    return [...this.rooms()].sort((a, b) => at(a.room) - at(b.room));
  });

  /** Per room: the agent's lines not yet seen here, and its open questions. */
  unreadBy = computed(() => {
    const seen = this.seen(), qs = this.questions();
    const out: Record<string, number> = {};
    for (const r of this.rooms()) {
      const since = seen[r.room] ?? '';
      out[r.room] = r.agent_at.filter(a => a > since).length + qs.filter(q => (q.room ?? 'cad') === r.room).length;
    }
    return out;
  });
  unread(room: string) { return this.unreadBy()[room] ?? 0; }
  total = computed(() => Object.values(this.unreadBy()).reduce((a, b) => a + b, 0));

  label(room: string) { return WORKSPACES.find(w => w.id === room)?.label ?? room; }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 3000);
  }

  poll() {
    this.http.get<ThreadRoom[]>('/api/chat/rooms').subscribe({
      next: rows => {
        // A browser that never had a thread open starts with nothing unread,
        // rather than with every line the agent ever wrote.
        const seen = { ...this.seen() };
        let fresh = false;
        for (const r of rows) {
          if (seen[r.room] === undefined) { seen[r.room] = r.agent_at.at(-1) ?? ''; fresh = true; }
        }
        if (fresh) this.keepSeen(seen);
        this.rooms.set(rows);
        const open = this.sel.room() === 'commandcode' ? this.sel.thread() : null;
        if (open) this.markSeen(open);
      },
      error: () => {},
    });
    this.asks.open().subscribe({ next: q => this.questions.set(q), error: () => {} });
  }

  /** The thread is on screen: what the agent has written so far is read. */
  markSeen(room: string) {
    const last = this.rooms().find(r => r.room === room)?.agent_at.at(-1);
    if (!last || (this.seen()[room] ?? '') >= last) return;
    this.keepSeen({ ...this.seen(), [room]: last });
  }

  private keepSeen(v: Record<string, string>) {
    this.seen.set(v);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(v)); } catch { /* private window */ }
  }
}

/** One row of a thread's log: a line, an agent's question, or the answer
 *  given to an answered one (shown as the person's line). */
export interface ThreadItem { kind: 'line' | 'q' | 'answer'; key: string; m?: ChatLine; q?: Question }

/** Who an item is from, for the one-avatar-per-run rule. */
export function sender(it: ThreadItem): string {
  if (it.kind === 'q') return 'agent';
  if (it.kind === 'answer') return 'user:' + (it.q?.answered_by?.id ?? it.q?.answered_by?.name ?? '');
  const m = it.m!;
  return m.role === 'agent' ? 'agent' : 'user:' + (m.by?.id ?? m.by?.name ?? '');
}

/** One room's thread, in the Chat tab's conversation area. The avatars and
 *  icons are the Chat room's own templates, handed in. */
@Component({
  selector: 'app-room-thread',
  // Its header, lines and composer are the conversation column's own rows.
  host: { style: 'display: contents' },
  imports: [NgTemplateOutlet, T, Markdown, TaskBlockView, ReadingNote, ReadingPick, AttachChips, MentionPics, SuggestChip],
  template: `
<header class="tcv-cc-bar">
  <button class="tcv-cc-ib tcv-cc-burger" (click)="menu.emit()" [title]="'Conversations' | t">
    <ng-container *ngTemplateOutlet="ico(); context: { $implicit: MENU }" /></button>
  <div class="tcv-th-title">
    <b>{{ threads.label(room()) | t }}</b>
    <span class="tcv-cc-dim">{{ 'agent thread' | t }}</span>
  </div>
  @if (waiting(); as n) {
    <span class="tcv-th-waiting" [title]="'said, not picked up yet' | t">{{ n }} {{ 'waiting' | t }}</span>
  }
</header>

<div class="tcv-cc-log tcv-cc-scroll" #log (wheel)="touched = true" (touchmove)="touched = true" (keydown)="touched = true"
     [class.tcv-att-over]="att.over()" (dragover)="canAttach() && att.dragOver($event)"
     (dragleave)="att.dragLeave($event)" (drop)="canAttach() && att.drop($event)">
  <div class="tcv-cc-col">
    <!-- The thread in time order: its lines, and the agent's questions -
         answered ones resolved in place, each followed by its answer as
         the person's line - then what the agent is still waiting on. -->
    @for (it of items(); track it.key; let i = $index) {
      @switch (it.kind) {
      @case ('line') {
      @let m = it.m!;
      <article class="tcv-cc-row" [attr.data-role]="m.role === 'agent' ? 'assistant' : 'user'" [attr.data-mid]="m._id"
                 [attr.data-flash]="flash() === m._id ? 1 : null"
                 [attr.data-urgent]="m.urgent ? 1 : null">
          @if (m.role === 'agent') {
            <ng-container *ngTemplateOutlet="botAv(); context: { $implicit: '', hide: same(i) }" />
          } @else {
            <ng-container *ngTemplateOutlet="userAv(); context: { $implicit: m.by, hide: same(i) }" />
          }
          <div class="tcv-cc-rowmain">
            <div class="tcv-cc-rowhead">
              <b>{{ who(m) }}</b>
              @if (m.urgent) { <span class="tcv-th-urgent">{{ 'Urgent' | t }}</span> }
              @if (m.role === 'user' && !m.seen_at) {
                <span class="tcv-th-wait">{{ 'waiting' | t }}</span>
                @if (sent(m) && auth.can('draw')) {
                  <button class="tcv-cc-textbtn" (click)="unsay(m)" [title]="'take it back - only while it is unread' | t">{{ 'undo' | t }}</button>
                }
              }
              @if (m.edited; as ed) {
                <span class="tcv-cc-dim" [title]="(ed.why || '') + ' · ' + stamp(ed.at)">· {{ ed.why || ('edited' | t) }}</span>
              }
              <span class="tcv-cc-hovtime">{{ stamp(m.at) }}</span>
            </div>
            @if (m.role === 'agent') {
              <!-- A task written for the queue is a box with its own button
                   (rooms/task-block.ts); the rest is the answer as written. -->
              @for (seg of parts(m.text); track $index) {
                @if (taskOf(seg); as tk) {
                  <rl-task-block [block]="tk" [url]="'/api/chat/' + m._id + '/task/' + tk.index + '/queue'"
                                 [state]="m.tasks?.[tk.index]" [room]="room()" (queued)="load()" />
                } @else {
                  <div class="tcv-cc-answer md" [innerHTML]="mdOf(seg) | md"></div>
                }
              }
            } @else if (m.text) {
              <div class="tcv-cc-bubble">{{ m.text }}</div>
            }
            @if (m.mentions?.length) {
              <!-- What the line carries: pictures as pictures, other files as chips. -->
              <rl-mention-pics [mentions]="m.mentions" />
              @if (otherFiles(m); as fs) {
                @if (fs.length) {
                  <div class="tcv-cc-mentions">
                    @for (f of fs; track f.id) {
                      <a class="tcv-cc-mchip" data-kind="file" [href]="'/api/files/' + f.id + '?inline=1'" target="_blank" rel="noopener" [title]="f.label">
                        <ng-container *ngTemplateOutlet="ico(); context: { $implicit: CLIP }" /><span>{{ f.label }}</span></a>
                    }
                  </div>
                }
              }
            }
          </div>
        </article>
      }
      @case ('answer') {
      @let a = it.q!;
      <article class="tcv-cc-row" data-role="user" [attr.data-answer]="a._id">
        <ng-container *ngTemplateOutlet="userAv(); context: { $implicit: a.answered_by, hide: same(i) }" />
        <div class="tcv-cc-rowmain">
          <div class="tcv-cc-rowhead">
            <b>{{ a.answered_by?.name || ('you' | t) }}</b>
            <span class="tcv-cc-dim">· {{ 'answered' | t }}</span>
            <span class="tcv-cc-hovtime">{{ stamp(a.answered_at || a.at) }}</span>
          </div>
          <div class="tcv-cc-bubble">{{ a.answer }}</div>
        </div>
      </article>
      }
      @case ('q') {
      @let q = it.q!;
      @let open = q.status === 'open';
      <!-- Only the agent's questions are offered in another language: the
           reader's choice, on the card itself (editor/reading.ts). -->
      @let tq = reading.shown('question', q._id);
      <article class="tcv-cc-row" data-role="assistant" data-question="1" [attr.data-answered]="open ? null : 1">
        <ng-container *ngTemplateOutlet="botAv(); context: { $implicit: '', hide: same(i) }" />
        <div class="tcv-cc-rowmain tcv-th-q">
          <div class="tcv-cc-rowhead">
            @if (open) { <span class="tcv-th-qdot"></span><b class="tcv-th-qasking">{{ 'Agent is asking' | t }}</b> }
            @else {
              <button class="tcv-th-qfold" (click)="toggleQ(q._id)" [attr.aria-expanded]="isOpenQ(q._id)">
                {{ isOpenQ(q._id) ? '▾' : '▸' }} <b>{{ 'Agent asked' | t }}</b></button>
              <span class="tcv-th-qok">✓ {{ 'answered' | t }}</span>
              @if (!isOpenQ(q._id)) { <span class="tcv-th-qpeek">→ {{ q.answer }}</span> }
            }
            <span class="tcv-cc-hovtime">{{ stamp(q.at) }}</span>
            <span class="tcv-th-qlang"><rl-reading-pick [compact]="true" place="left" /></span>
          </div>
          @if (reading.lang()) { <div class="tcv-th-tr"><rl-reading-note kind="question" [id]="q._id" /></div> }
          <div class="tcv-cc-answer md" [class.tcv-th-qshut]="!open && !isOpenQ(q._id)" [attr.dir]="tq ? 'auto' : null"
               [innerHTML]="(tq?.text ?? q.text) | md"></div>
          @if (q.context && (open || isOpenQ(q._id))) {
            <div class="md tcv-th-ctx" [attr.dir]="tq ? 'auto' : null" [innerHTML]="(tq?.context ?? q.context) | md"></div>
          }
          @if (!open) {
            @if (isOpenQ(q._id)) {
              <!-- Answered: nothing to pick any more. The chosen option, or
                   the person's own words, is the marked row; the rest dim. -->
              @let own = !hasChoice(q);
              <div class="tcv-answers">
                @for (o of q.options; track o; let k = $index) {
                  <div class="tcv-answer tcv-answer-done" [attr.data-on]="chosen(q, o) ? 1 : null">
                    @if (chosen(q, o)) { <span class="tcv-answer-tick">✓</span> }
                    <span class="md min-w-0 flex-1" [attr.dir]="tq ? 'auto' : null"
                          [innerHTML]="optionMd(tq?.options?.[k] ?? o) | md"></span>
                    @if (chosen(q, o)) { <span class="tcv-answer-by">{{ 'chosen' | t }} · {{ whoAnswered(q) }} · {{ stamp(q.answered_at || q.at) }}</span> }
                  </div>
                }
                @if (own) {
                  <div class="tcv-answer tcv-answer-done" data-on="1">
                    <span class="tcv-answer-tick">✓</span>
                    <span class="min-w-0 flex-1">“{{ q.answer }}”</span>
                    <span class="tcv-answer-by">{{ 'answer by' | t }} {{ whoAnswered(q) }} · {{ stamp(q.answered_at || q.at) }}</span>
                  </div>
                }
              </div>
            }
          } @else if (auth.can('draw')) {
            @if (q.options.length) {
              <div class="tcv-answers">
                @for (o of q.options; track o; let k = $index) {
                  <button (click)="pickOption(q, o)" class="tcv-answer" [attr.data-on]="isPicked(q, o) ? 1 : null">
                    <span class="tcv-answer-mark" [class.tcv-answer-multi]="q.multi"></span>
                    <span class="md min-w-0 flex-1" [attr.dir]="tq ? 'auto' : null"
                          [innerHTML]="optionMd(tq?.options?.[k] ?? o) | md"></span>
                  </button>
                }
              </div>
            }
            <div class="tcv-th-own">
              <textarea rows="2" [value]="answerOf(q)" [placeholder]="'or answer in your own words' | t"
                        (input)="setAnswer(q, $any($event.target).value)"></textarea>
              <button class="tcv-btn tcv-btn-accent" (click)="sendAnswer(q)">{{ 'Send answer' | t }}</button>
            </div>
          }
        </div>
      </article>
      }
      }
    }
    @if (!items().length) {
      <div class="tcv-cc-hello">
        <div class="tcv-cc-hello-mark"><ng-container *ngTemplateOutlet="ico(); context: { $implicit: room() === 'pcb' ? PCB : room() === 'firmware' ? FW : CAD }" /></div>
        <h2>{{ threads.label(room()) | t }}</h2>
        <p>{{ 'A line to the agent of this room, for anything that is not a mark on a model: move these into a folder, rename that one, what is taking so long.' | t }}</p>
      </div>
    }
  </div>
</div>

@if (auth.can('draw')) {
  <div class="tcv-cc-composer" [class.focus]="focused()" [class.tcv-th-urgentbox]="urgent()"
       [class.tcv-att-over]="att.over()" (dragover)="att.dragOver($event)" (dragleave)="att.dragLeave($event)"
       (drop)="att.drop($event)">
    @if (att.items().length || att.error()) {
      <div class="tcv-cc-picked"><rl-attach-chips [att]="att" /></div>
    }
    <textarea #box rows="1" [value]="saying()" [placeholder]="sg.text() || ('message the agent…' | t)" [class.tcv-sg-ghost]="!!sg.text()"
              (input)="saying.set($any($event.target).value); grow()" (keydown)="key($event)" (paste)="att.paste($event)"
              (focus)="focused.set(true)" (blur)="focused.set(false)"></textarea>
    <div class="tcv-cc-compbar">
      <!-- The difference between "when you get a moment" and "now": an
           urgent line is reported by every command the agent runs. -->
      <label class="tcv-th-urgentsw" [title]="'have it read between steps rather than when the agent next looks up' | t">
        <button (click)="urgent.set(!urgent())" class="tcv-switch" [attr.data-on]="urgent() ? 1 : null"
                [attr.aria-pressed]="urgent()"></button>
        <span>{{ 'Urgent' | t }}</span>
      </label>
      <button class="tcv-cc-ib" data-act="attach" (click)="pickFile.click()"
              [title]="'Attach a picture or a file (or paste, or drop it here)' | t">
        <ng-container *ngTemplateOutlet="ico(); context: { $implicit: CLIP }" /></button>
      <input #pickFile type="file" multiple hidden (change)="att.pick($event)" />
      <span class="tcv-cc-hint"><kbd>↵</kbd> {{ 'send' | t }} · <kbd>⇧↵</kbd> {{ 'new line' | t }}</span>
      <rl-suggest-chip [sg]="sg" />
      <span class="grow"></span>
      <button class="tcv-cc-send" [disabled]="!canSend()" (click)="say()"
              [title]="(att.busy() ? ('Uploading…' | t) : ('Send' | t)) + ' (Enter)'">
        <ng-container *ngTemplateOutlet="ico(); context: { $implicit: SEND }" /></button>
    </div>
  </div>
}
@if (error(); as e) { <div class="tcv-cc-alert" role="alert"><span>{{ e }}</span></div> }
`,
})
export class RoomThread {
  private chat = inject(Chat);
  private qs = inject(Questions);
  auth = inject(Auth);
  threads = inject(AgentThreads);
  reading = inject(Reading);
  private sel = inject(Selection);
  flash = signal<string | null>(null);

  room = input.required<string>();
  userAv = input.required<TemplateRef<unknown>>();
  botAv = input.required<TemplateRef<unknown>>();
  ico = input.required<TemplateRef<unknown>>();
  menu = output<void>();

  readonly MENU = 'M4 6h16 M4 12h16 M4 18h16';
  readonly CLIP = PAPERCLIP;
  /** Pictures pasted, dropped or attached: uploaded to Files, sent as the line's files (rooms/chat-attach.ts). */
  att = new ChatAttach(inject(FilesApi), () => this.room());
  canAttach() { return this.auth.can('draw'); }
  /** The next question, suggested in the empty composer after the agent writes (rooms/suggest.ts). */
  sg = new ComposerSuggest(() => {
    const l = this.lines(), m = l.at(-1);
    return { kind: 'room', id: this.room(), busy: false, may: this.auth.can('draw'),
             last: !l.length ? undefined : m?.role === 'agent' ? m._id : null,
             empty: !this.saying().trim() && !this.att.items().length };
  }, s => { this.saying.set(s); const el = this.box()?.nativeElement;
            if (el) { el.value = s; el.focus(); el.setSelectionRange(s.length, s.length); this.grow(); } });
  canSend() { return !this.att.busy() && (!!this.saying().trim() || this.att.ready().length > 0); }
  /** A line's files that are not pictures (those are drawn as pictures). */
  otherFiles(m: ChatLine) { return (m.mentions ?? []).filter(x => !isPicture(x)); }
  readonly SEND = 'M12 19V5 M6 11l6-6 6 6';
  readonly CAD = 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9';
  readonly FW = 'M6 6h12v12H6z M3 9h3 M3 15h3 M18 9h3 M18 15h3 M10.5 9.5L8.5 12l2 2.5 M13.5 9.5l2 2.5-2 2.5';
  readonly PCB = 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4';

  lines = signal<ChatLine[]>([]);
  saying = signal('');
  focused = signal(false);
  error = signal<string | null>(null);
  /** Sticks, as it did under the queue: whoever wants one thing seen at once usually wants the next too. */
  urgent = signal(false);
  answerText = signal<Record<string, string>>({});
  private picked = signal<Record<string, string[]>>({});

  asks = computed(() => this.threads.questions().filter(q => (q.room ?? 'cad') === this.room()));
  /** This room's answered questions (/api/questions/answered), kept in the log. */
  answered = signal<Question[]>([]);
  /** Answered question cards opened up again (they start folded). */
  private unfolded = signal<Set<string>>(new Set());

  /** The log, in time order: the lines, each answered question where it
   *  was asked with its answer as the person's line where it was given,
   *  then the open questions - what the agent is waiting on - at the end. */
  items = computed<ThreadItem[]>(() => {
    const open = this.asks();
    const openIds = new Set(open.map(q => q._id));
    const timed: { at: string; it: ThreadItem }[] = this.lines().map(m => ({ at: m.at, it: { kind: 'line', key: 'l:' + m._id, m } }));
    for (const q of this.answered()) {
      if (openIds.has(q._id)) continue;
      timed.push({ at: q.at, it: { kind: 'q', key: 'q:' + q._id, q } });
      timed.push({ at: q.answered_at || q.at, it: { kind: 'answer', key: 'a:' + q._id, q } });
    }
    // Lines still on their way to the server stay last, as typed.
    timed.sort((a, b) => (a.it.m?._id.startsWith('local-') ? 1 : 0) - (b.it.m?._id.startsWith('local-') ? 1 : 0)
                         || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return [...timed.map(x => x.it), ...open.map(q => ({ kind: 'q' as const, key: 'q:' + q._id, q }))];
  });
  waiting = computed(() => this.lines().filter(m => m.role === 'user' && !m.seen_at).length || null);

  private log = viewChild<ElementRef<HTMLDivElement>>('log');
  private box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  private timer = setInterval(() => this.load(), 2000);

  /** The composer, ready to type in, once it is on the page. Asked for as
   *  a room or conversation opens (Ctrl+K, the list), when the composer may
   *  not be drawn yet: tried again for a moment rather than once and lost. */
  focusSoon(tries = 30) {
    if (matchMedia('(hover: none)').matches) return;
    const el = this.box()?.nativeElement;
    if (el && el.offsetParent) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); return; }
    if (tries > 0) setTimeout(() => this.focusSoon(tries - 1), 50);
  }

  constructor() {
    effect(() => {
      const room = this.room();
      untracked(() => { this.lines.set([]); this.answered.set([]); this.load(true); this.threads.markSeen(room); this.focusSoon(); });
    });
    // Asked for again while open (Ctrl+K on this room): the cursor goes in.
    let opened = this.sel.threadAsked();
    effect(() => {
      const n = this.sel.threadAsked();
      if (n !== opened) { opened = n; untracked(() => this.focusSoon()); }
    });
    // A line asked for from elsewhere (a queued note's "from chat" link):
    // scrolled to and lit up once it is here.
    effect(() => {
      const at = this.sel.threadAt();
      if (!at || !this.lines().some(m => m._id === at)) return;
      untracked(() => {
        this.sel.threadAt.set(null);
        // Again after the thread has settled: opening it scrolls to its end.
        this.touched = true;              // reading here: the thread's end does not pull it back
        const go = () => this.log()?.nativeElement.querySelector(`[data-mid="${CSS.escape(at)}"]`)
          ?.scrollIntoView({ block: 'center' });
        setTimeout(go, 400);
        setTimeout(go, 1700);
        this.flash.set(at);
        setTimeout(() => { if (this.flash() === at) this.flash.set(null); }, 3600);
      });
    });
    // The questions in the reader's language as soon as they are here.
    effect(() => {
      const lang = this.reading.lang();
      if (lang) for (const q of this.asks()) this.reading.ensure('question', q._id);
    });
    // A new question lands at the end of the thread: scrolled to, as a line is.
    let asked = 0;
    effect(() => {
      const n = this.asks().length;
      if (n > asked) untracked(() => this.scroll());
      asked = n;
    });
  }

  ngOnDestroy() { clearInterval(this.timer); }

  load(jump = false) {
    const room = this.room();
    this.loadAnswered(room);
    this.chat.history(room).subscribe({
      next: rows => {
        if (room !== this.room()) return;
        rows = rows.filter(r => (r.room ?? 'cad') === room);
        const grew = rows.length !== this.lines().length
          || rows.at(-1)?._id !== this.lines().at(-1)?._id;
        // Lines typed here and not back from the server yet stay on screen.
        const local = this.lines().filter(m => !this.sent(m));
        if (!grew && !local.length && !this.changed(rows)) return;
        this.lines.set([...rows, ...local.filter(l => !rows.some(r => r.text === l.text && r.role === 'user'))]);
        this.threads.markSeen(room);
        if (grew || jump) this.scroll(!jump);
      },
      error: () => {},
    });
  }

  /** This room's answered questions; set only when they changed, so the
   *  log is not rebuilt every two seconds for nothing. */
  private loadAnswered(room: string) {
    this.qs.answered(room).subscribe({
      next: rows => {
        if (room !== this.room()) return;
        const sig = (l: Question[]) => l.map(q => q._id + (q.answered_at ?? '')).join();
        if (sig(rows) !== sig(this.answered())) this.answered.set(rows);
      },
      error: () => {},
    });
  }

  /** A line read by the agent since, or taken back, or one whose task was
   *  queued (here or by someone else) or text edited: the same length, other rows. */
  private changed(rows: ChatLine[]) {
    const now = this.lines();
    const sig = (m?: ChatLine) => m ? JSON.stringify([m.tasks ?? null, m.edited?.at ?? null, m.text.length]) : '';
    return rows.some((r, i) => now[i]?._id !== r._id || now[i]?.seen_at !== r.seen_at || sig(now[i]) !== sig(r));
  }

  /** The agent's line as text and ```task blocks (markdown.ts splitTasks). */
  private split = new Map<string, Segment[]>();
  parts(text: string): Segment[] {
    let got = this.split.get(text);
    if (!got) {
      got = splitTasks(text);
      if (this.split.size > 400) this.split.clear();
      this.split.set(text, got);
    }
    return got;
  }
  taskOf(s: Segment): TaskBlock | null { return 'task' in s ? s.task : null; }
  mdOf(s: Segment): string { return 'md' in s ? s.md : ''; }

  private follow = true;
  /** The reader has scrolled the thread by hand since it was opened. */
  touched = false;
  private scroll(onlyIfAtEnd = false) {
    const el = this.log()?.nativeElement;
    if (el && onlyIfAtEnd) this.follow = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    if (onlyIfAtEnd && !this.follow) return;
    if (!onlyIfAtEnd) this.touched = false;
    const go = () => { const e = this.log()?.nativeElement; if (e) e.scrollTop = e.scrollHeight; };
    setTimeout(() => { go(); requestAnimationFrame(go); });
    // A thread just opened grows as its lines, task boxes and pictures
    // render: back to the end as it settles, unless the reader has
    // scrolled it by hand (or a line was asked for, threadAt) meanwhile.
    if (!onlyIfAtEnd) {
      for (const ms of [120, 350, 800, 1600]) setTimeout(() => { if (!this.touched) go(); }, ms);
    }
  }

  say() {
    if (!this.canSend()) return;
    const text = this.saying().trim();
    if (text.length > CHAT_MAX) {
      // Said before it is sent, not after a refusal (backend/main.py CHAT_MAX).
      this.error.set(`${t('too long to send')}: ${text.length.toLocaleString()} / ${CHAT_MAX.toLocaleString()} ${t('characters')}`);
      return;
    }
    const urgent = this.urgent(), room = this.room();
    const held = this.att.items(), ready = this.att.ready();
    const mentions = ready.map(p => ({ kind: 'file' as const, id: p.id!, label: p.name, image: p.image }));
    this.lines.update(l => [...l, { _id: 'local-' + Date.now(), at: new Date().toISOString(), role: 'user', text,
                                    urgent, seen_at: null, room, by: this.auth.state()?.user ?? undefined,
                                    ...(mentions.length ? { mentions } : {}) } as ChatLine]);
    this.saying.set('');
    this.att.clear();
    // Back to one line: the textarea still holds the sent text until the
    // next change detection, and measured with it the box stayed tall.
    const el = this.box()?.nativeElement;
    if (el) el.value = '';
    this.grow();
    this.scroll();
    this.chat.say(text, urgent, room, mentions.map(m => m.id)).subscribe({
      next: () => { this.load(); this.threads.poll(); },
      error: e => {
        this.error.set(e?.status === 422 ? t('the server refused it - too long or malformed') : t('could not send that'));
        this.lines.update(l => l.filter(m => this.sent(m)));
        if (!this.saying()) this.saying.set(text);
        this.att.restore(held);
      },
    });
  }

  key(e: KeyboardEvent) {
    if (this.sg.key(e)) return;                   // the suggested next question (rooms/suggest.ts)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.say(); }
  }

  grow() {
    const el = this.box()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }

  unsay(m: ChatLine) {
    if (m.seen_at || !this.sent(m)) return;
    this.lines.update(l => l.filter(x => x._id !== m._id));
    this.chat.retract(m._id).subscribe({
      next: () => { this.load(); this.threads.poll(); },
      error: () => { this.error.set(t('too late, the agent already has it')); this.load(); },
    });
  }

  sent(m: ChatLine) { return !m._id.startsWith('local-'); }

  who(m: ChatLine) {
    if (m.role === 'agent') {
      const n = m.by?.name;
      return n && n !== 'agent' ? n : t('agent');
    }
    return m.by?.name || t('you');
  }

  /** The same sender as the item before - a line, a question (the
   *  agent's) or an answer (the person's): no avatar again. */
  same(i: number) {
    const l = this.items();
    return i > 0 && sender(l[i]) === sender(l[i - 1]);
  }

  isOpenQ(id: string) { return this.unfolded().has(id); }
  toggleQ(id: string) {
    this.unfolded.update(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  /** Whether the answer was one (or several) of the options, rather than the person's own words. */
  hasChoice(q: Question) { return q.options.some(o => this.chosen(q, o)); }
  whoAnswered(q: Question) { return q.answered_by?.name || t('you'); }
  /** An option the answer chose: the answer itself, or one of several picked. */
  chosen(q: Question, o: string) {
    const a = (q.answer ?? '').trim();
    if (!a) return false;
    return a === o || (q.multi && a.split(', ').includes(o));
  }

  stamp(iso: string) {
    const d = new Date(iso);
    return isNaN(+d) ? '' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric',
                                                          hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ---- the agent's questions ----
  optionMd(o: string): string {
    const m = /^([^:*`\n]{1,40}):\s+/.exec(o);
    return m && !o.includes('**') ? `**${m[1]}**: ${o.slice(m[0].length)}` : o;
  }
  isPicked(q: Question, o: string) { return (this.picked()[q._id] ?? []).includes(o); }
  answerOf(q: Question) { return this.answerText()[q._id] ?? ''; }
  setAnswer(q: Question, v: string) { this.answerText.update(a => ({ ...a, [q._id]: v })); }

  pickOption(q: Question, o: string) {
    if (!q.multi) { this.sendAnswer(q, o); return; }
    const now = this.picked()[q._id] ?? [];
    this.picked.update(p => ({ ...p, [q._id]: now.includes(o) ? now.filter(x => x !== o) : [...now, o] }));
  }

  /** Whatever was typed wins over whatever was clicked, as in the card. */
  sendAnswer(q: Question, chosen?: string) {
    const answer = (this.answerText()[q._id] ?? '').trim() || chosen || (this.picked()[q._id] ?? []).join(', ');
    if (!answer) return;
    this.qs.answer(q._id, answer).subscribe({
      next: done => {
        // It stays where it was asked, answered: the card folds and the
        // answer follows it as the person's line.
        this.answered.update(l => [...l.filter(x => x._id !== q._id), { ...q, ...done, room: q.room }]);
        this.threads.questions.update(l => l.filter(x => x._id !== q._id));
        this.scroll(true);
        this.answerText.update(a => { const { [q._id]: _, ...rest } = a; return rest; });
      },
      error: () => this.error.set(t('could not send the answer')),
    });
  }
}
