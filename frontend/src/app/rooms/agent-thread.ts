import {
  Component, ElementRef, Injectable, TemplateRef, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Chat, ChatLine, Question, Questions } from '../api';
import { Auth } from '../auth';
import { Markdown } from '../markdown';
import { T, t } from '../i18n';
import { Selection } from '../selection';
import { TopBar } from '../topbar';
import { WORKSPACES } from '../workspaces';
import { Reading, ReadingNote, ReadingPick } from '../editor/reading';

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

/** One room's thread, in the Chat tab's conversation area. The avatars and
 *  icons are the Chat room's own templates, handed in. */
@Component({
  selector: 'app-room-thread',
  // Its header, lines and composer are the conversation column's own rows.
  host: { style: 'display: contents' },
  imports: [NgTemplateOutlet, T, Markdown, ReadingNote, ReadingPick],
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
  <div class="tcv-cc-baracts">
    <rl-reading-pick [compact]="true" place="left" />
  </div>
</header>

<div class="tcv-cc-log tcv-cc-scroll" #log>
  <div class="tcv-cc-col">
    @for (m of lines(); track m._id; let i = $index) {
      <article class="tcv-cc-row" [attr.data-role]="m.role === 'agent' ? 'assistant' : 'user'" [attr.data-mid]="m._id"
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
            <span class="tcv-cc-hovtime">{{ stamp(m.at) }}</span>
          </div>
          @let tm = m.role === 'agent' ? reading.shown('chat', m._id) : null;
          @if (m.role === 'agent') {
            <div class="tcv-cc-answer md" [attr.dir]="tm ? 'auto' : null" [innerHTML]="(tm?.text ?? m.text) | md"></div>
            @if (reading.lang()) {
              <div class="tcv-th-tr"><rl-reading-note kind="chat" [id]="m._id" [offer]="true" /></div>
            }
          } @else {
            <div class="tcv-cc-bubble">{{ m.text }}</div>
          }
        </div>
      </article>
    }
    <!-- What the agent is waiting on, in this room: answered here as in the
         card that pops up over every room. -->
    @for (q of asks(); track q._id) {
      @let tq = reading.shown('question', q._id);
      <article class="tcv-cc-row" data-role="assistant" data-question="1">
        <ng-container *ngTemplateOutlet="botAv(); context: { $implicit: '', hide: false }" />
        <div class="tcv-cc-rowmain tcv-th-q">
          <div class="tcv-cc-rowhead"><b>{{ 'Agent is asking' | t }}</b>
            <span class="tcv-cc-hovtime">{{ stamp(q.at) }}</span></div>
          @if (reading.lang()) { <div class="tcv-th-tr"><rl-reading-note kind="question" [id]="q._id" /></div> }
          <div class="tcv-cc-answer md" [attr.dir]="tq ? 'auto' : null" [innerHTML]="(tq?.text ?? q.text) | md"></div>
          @if (q.context) {
            <div class="md tcv-th-ctx" [attr.dir]="tq ? 'auto' : null" [innerHTML]="(tq?.context ?? q.context) | md"></div>
          }
          @if (auth.can('draw')) {
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
    @if (!lines().length && !asks().length) {
      <div class="tcv-cc-hello">
        <div class="tcv-cc-hello-mark"><ng-container *ngTemplateOutlet="ico(); context: { $implicit: room() === 'pcb' ? PCB : CAD }" /></div>
        <h2>{{ threads.label(room()) | t }}</h2>
        <p>{{ 'A line to the agent of this room, for anything that is not a mark on a model: move these into a folder, rename that one, what is taking so long.' | t }}</p>
      </div>
    }
  </div>
</div>

@if (auth.can('draw')) {
  <div class="tcv-cc-composer" [class.focus]="focused()" [class.tcv-th-urgentbox]="urgent()">
    <textarea #box rows="1" [value]="saying()" [placeholder]="'message the agent…' | t"
              (input)="saying.set($any($event.target).value); grow()" (keydown)="key($event)"
              (focus)="focused.set(true)" (blur)="focused.set(false)"></textarea>
    <div class="tcv-cc-compbar">
      <!-- The difference between "when you get a moment" and "now": an
           urgent line is reported by every command the agent runs. -->
      <label class="tcv-th-urgentsw" [title]="'have it read between steps rather than when the agent next looks up' | t">
        <button (click)="urgent.set(!urgent())" class="tcv-switch" [attr.data-on]="urgent() ? 1 : null"
                [attr.aria-pressed]="urgent()"></button>
        <span>{{ 'Urgent' | t }}</span>
      </label>
      <span class="tcv-cc-hint"><kbd>↵</kbd> {{ 'send' | t }} · <kbd>⇧↵</kbd> {{ 'new line' | t }}</span>
      <span class="grow"></span>
      <button class="tcv-cc-send" [disabled]="!saying().trim()" (click)="say()" [title]="('Send' | t) + ' (Enter)'">
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
  reading = inject(Reading);
  threads = inject(AgentThreads);

  room = input.required<string>();
  userAv = input.required<TemplateRef<unknown>>();
  botAv = input.required<TemplateRef<unknown>>();
  ico = input.required<TemplateRef<unknown>>();
  menu = output<void>();

  readonly MENU = 'M4 6h16 M4 12h16 M4 18h16';
  readonly SEND = 'M12 19V5 M6 11l6-6 6 6';
  readonly CAD = 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9';
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
  waiting = computed(() => this.lines().filter(m => m.role === 'user' && !m.seen_at).length || null);

  private log = viewChild<ElementRef<HTMLDivElement>>('log');
  private box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  private timer = setInterval(() => this.load(), 2000);

  constructor() {
    effect(() => {
      const room = this.room();
      untracked(() => { this.lines.set([]); this.load(true); this.threads.markSeen(room); });
    });
    // A new question lands at the end of the thread: scrolled to, as a line is.
    let asked = 0;
    effect(() => {
      const n = this.asks().length;
      if (n > asked) untracked(() => this.scroll());
      asked = n;
    });
    // The questions in the reader's language as soon as they are here.
    effect(() => {
      const lang = this.reading.lang();
      if (lang) for (const q of this.asks()) this.reading.ensure('question', q._id);
    });
  }

  ngOnDestroy() { clearInterval(this.timer); }

  private load(jump = false) {
    const room = this.room();
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

  /** A line read by the agent since, or taken back: the same length, other rows. */
  private changed(rows: ChatLine[]) {
    const now = this.lines();
    return rows.some((r, i) => now[i]?._id !== r._id || now[i]?.seen_at !== r.seen_at);
  }

  private follow = true;
  private scroll(onlyIfAtEnd = false) {
    const el = this.log()?.nativeElement;
    if (el && onlyIfAtEnd) this.follow = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    if (onlyIfAtEnd && !this.follow) return;
    setTimeout(() => { const e = this.log()?.nativeElement; if (e) e.scrollTop = e.scrollHeight; });
  }

  say() {
    const text = this.saying().trim();
    if (!text) return;
    const urgent = this.urgent(), room = this.room();
    this.lines.update(l => [...l, { _id: 'local-' + Date.now(), at: new Date().toISOString(), role: 'user', text,
                                    urgent, seen_at: null, room, by: this.auth.state()?.user ?? undefined } as ChatLine]);
    this.saying.set('');
    this.grow();
    this.scroll();
    this.chat.say(text, urgent, room).subscribe({
      next: () => { this.load(); this.threads.poll(); },
      error: () => { this.error.set(t('could not send that')); this.lines.update(l => l.filter(m => this.sent(m))); },
    });
  }

  key(e: KeyboardEvent) {
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

  /** The same sender as the line before: no avatar again. */
  same(i: number) {
    const l = this.lines();
    if (i <= 0) return false;
    const a = l[i], b = l[i - 1];
    return a.role === b.role && (a.role === 'agent' || (a.by?.id ?? a.by?.name) === (b.by?.id ?? b.by?.name));
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
      next: () => {
        this.threads.questions.update(l => l.filter(x => x._id !== q._id));
        this.answerText.update(a => { const { [q._id]: _, ...rest } = a; return rest; });
      },
      error: () => this.error.set(t('could not send the answer')),
    });
  }
}
